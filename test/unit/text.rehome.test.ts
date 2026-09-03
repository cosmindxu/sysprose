/**
 * Post-fault re-homing (src/text/langium/rehome.ts), tested in isolation from
 * the parser: a hand-built model with hand-built ranges, so the brace scan and
 * the ownership decision are pinned independently of how Chevrotain recovers.
 */
import { describe, it, expect } from 'vitest';
import { Model } from '@core/index';
import type { ElementId } from '@core/index';
import type { TextRange } from '@validation/types';
import { bracePairs, rehomeAfterFault } from '../../src/text/langium/rehome';
import { findUnterminatedDelimiter } from '../../src/text/langium/lexical-scan';
import { parseModel } from '@text/index';

const range = (offset: number): TextRange => ({
  start: { line: 1, column: offset + 1, offset },
  end: { line: 1, column: offset + 2, offset: offset + 1 },
});

describe('bracePairs', () => {
  it('pairs balanced braces and skips strings and comments', () => {
    const text = 'a { b "}" /* } */ // }\n c { d } }';
    const pairs = bracePairs(text)!;
    expect(pairs.map((p) => text[p.open] + text[p.close])).toEqual(['{}', '{}']);
    expect(pairs[0].open).toBe(text.indexOf('c {') + 2);
    expect(pairs[1].open).toBe(2);
  });

  it('declines an unbalanced file rather than guessing', () => {
    expect(bracePairs('a { b')).toBeUndefined();
    expect(bracePairs('a } b')).toBeUndefined();
    expect(bracePairs('a { /* never closed')).toBeUndefined();
  });

  /**
   * The grammar's hidden note terminal opens with a slash-slash-star and closes
   * with a star-slash, and it spans LINES (`sysml.langium` ML_NOTE). Treating
   * the opener as a plain line comment swallowed only its FIRST line and then
   * counted the braces on the rest as real, so two notes contributing one `{`
   * and one `}` made a file balanced by coincidence and produced a phantom
   * body. The scan must agree with the lexer.
   */
  it('hides braces inside a multi-line //* note, as the lexer does', () => {
    const text = 'a {\n  //* note\n     {\n     */\n  b;\n  //* note2\n     }\n     */\n}';
    const pairs = bracePairs(text)!;
    expect(pairs.map((p) => p.open)).toEqual([2]);
    expect(text[pairs[0].close]).toBe('}');
    expect(pairs[0].close).toBe(text.length - 1);
  });

  /**
   * `//*` with no closer is what the LEXER calls a single-line comment (the
   * ML_NOTE regex fails, SL_COMMENT wins), and such a file is perfectly valid.
   * Declining on it would lose recovery for every file containing a `//*`
   * pointer; reporting it would be a false error on valid text.
   */
  it('treats an unterminated //* as a line comment, neither declining nor reporting', () => {
    const pairs = bracePairs('a { //* note {\n  b;\n}')!;
    expect(pairs).toHaveLength(1);
    expect(pairs[0].open).toBe(2);
  });
});

describe('rehomeAfterFault', () => {
  /**
   * Source:   package P { part def A; blok def B; part def C; }
   * Offsets:  P@0  A@12  fault@24  C@36   — C was parsed as a ROOT.
   */
  function faultedPackage(): { model: Model; ids: Record<string, ElementId>; text: string; ranges: Map<ElementId, TextRange> } {
    const text = 'package P { part def A; blok def B; part def C; }';
    const model = new Model();
    const P = model.create('Package', { declaredName: 'P' });
    const A = model.create('PartDefinition', { declaredName: 'A', ownerId: P.id });
    const C = model.create('PartDefinition', { declaredName: 'C' }); // escaped to root
    const ranges = new Map<ElementId, TextRange>([
      [P.id, range(0)],
      [A.id, range(text.indexOf('part def A'))],
      [C.id, range(text.indexOf('part def C'))],
    ]);
    return { model, ids: { P: P.id, A: A.id, C: C.id }, text, ranges };
  }

  it('moves a declaration back inside the body its offset falls in', () => {
    const { model, ids, text, ranges } = faultedPackage();
    const moved = rehomeAfterFault(model, text, ranges, text.indexOf('blok'));
    expect(moved).toBe(1);
    expect(model.get(ids.C)?.ownerId).toBe(ids.P);
    expect(model.get(ids.A)?.ownerId, 'declarations before the fault are untouched').toBe(ids.P);
  });

  it('handles a fault two levels deep: inner escapes go back to the inner body', () => {
    // package P { part def A { blok q; part r; } part def B; }
    const text = 'package P { part def A { blok q; part r; } part def B; }';
    const model = new Model();
    const P = model.create('Package', { declaredName: 'P' });
    const A = model.create('PartDefinition', { declaredName: 'A', ownerId: P.id });
    const r = model.create('PartUsage', { declaredName: 'r', ownerId: P.id }); // escaped A → P
    const B = model.create('PartDefinition', { declaredName: 'B' }); // escaped P → root
    const ranges = new Map<ElementId, TextRange>([
      [P.id, range(0)],
      [A.id, range(text.indexOf('part def A'))],
      [r.id, range(text.indexOf('part r'))],
      [B.id, range(text.indexOf('part def B'))],
    ]);
    expect(rehomeAfterFault(model, text, ranges, text.indexOf('blok'))).toBe(2);
    expect(model.get(r.id)?.ownerId).toBe(A.id);
    expect(model.get(B.id)?.ownerId).toBe(P.id);
  });

  it('does nothing on an unbalanced file', () => {
    const { model, ids, ranges } = faultedPackage();
    const text = 'package P { part def A; blok def B; part def C;'; // no closing brace
    expect(rehomeAfterFault(model, text, ranges, text.indexOf('blok'))).toBe(0);
    expect(model.get(ids.C)?.ownerId).toBeNull();
  });

  it('never moves an element that has no range', () => {
    const { model, ids, text, ranges } = faultedPackage();
    ranges.delete(ids.C);
    expect(rehomeAfterFault(model, text, ranges, text.indexOf('blok'))).toBe(0);
    expect(model.get(ids.C)?.ownerId).toBeNull();
  });

  /**
   * A relationship-valued member (`import`, `alias`, `dependency`, a
   * forward-source `subset x subsets y;`) that recovery escaped to the root was
   * NEVER brought home, because the candidate filter dropped every
   * relationship. An escaped `import` silently leaves the package it scopes.
   */
  it('brings an escaped relationship home', () => {
    const text = 'package P { part def A; blok def B; import Q::*; }';
    const model = new Model();
    const P = model.create('Package', { declaredName: 'P' });
    const A = model.create('PartDefinition', { declaredName: 'A', ownerId: P.id });
    const imp = model.create('NamespaceImport', { attrs: { importedName: 'Q::*' } }); // escaped
    const ranges = new Map<ElementId, TextRange>([
      [P.id, range(0)],
      [A.id, range(text.indexOf('part def A'))],
      [imp.id, range(text.indexOf('import'))],
    ]);
    expect(rehomeAfterFault(model, text, ranges, text.indexOf('blok'))).toBe(1);
    expect(model.get(imp.id)?.ownerId).toBe(P.id);
  });

  /**
   * A body owned by a RELATIONSHIP (`alias b for a { attribute w; }` is mapped
   * under a Membership) had no eligible opener, so its members were re-homed
   * onto the previous SIBLING instead.
   */
  it('lets a relationship open a body', () => {
    const text = 'package P { blok bad; part a; alias b for a { attribute w; } }';
    const model = new Model();
    const P = model.create('Package', { declaredName: 'P' });
    const a = model.create('PartUsage', { declaredName: 'a', ownerId: P.id });
    const b = model.create('Membership', { declaredName: 'b', ownerId: P.id, target: [] });
    const w = model.create('AttributeUsage', { declaredName: 'w', ownerId: P.id }); // escaped
    const ranges = new Map<ElementId, TextRange>([
      [P.id, range(0)],
      [a.id, range(text.indexOf('part a'))],
      [b.id, range(text.indexOf('alias b'))],
      [w.id, range(text.indexOf('attribute w'))],
    ]);
    rehomeAfterFault(model, text, ranges, text.indexOf('blok'));
    expect(model.get(w.id)?.ownerId, 'w belongs to the alias, not to its neighbour a').toBe(b.id);
  });

  /**
   * An INLINE specialization (`part def X :> Y { … }`) is owned by its own
   * source and shares the declaration's start offset with it. Ranges are
   * insertion-ordered and the sort is stable, so such a relationship would win
   * the opener tie-break and steal its owner's body; the source-owned exclusion
   * is what keeps X the opener.
   */
  it('keeps the declaration, not its own inline specialization, as the opener', () => {
    const text = 'package P { part def X :> Y { blok bad; part inner; } }';
    const model = new Model();
    const P = model.create('Package', { declaredName: 'P' });
    const X = model.create('PartDefinition', { declaredName: 'X', ownerId: P.id });
    const spec = model.create('Subclassification', { ownerId: X.id, source: [X.id], target: [] });
    const inner = model.create('PartUsage', { declaredName: 'inner', ownerId: P.id }); // escaped
    const ranges = new Map<ElementId, TextRange>([
      [P.id, range(0)],
      [X.id, range(text.indexOf('part def X'))],
      [spec.id, range(text.indexOf('part def X'))], // same start, inserted after X
      [inner.id, range(text.indexOf('part inner'))],
    ]);
    rehomeAfterFault(model, text, ranges, text.indexOf('blok'));
    expect(model.get(inner.id)?.ownerId).toBe(X.id);
  });

  it('refuses to create an ownership cycle', () => {
    // A brace structure that would make P's owner one of P's own descendants.
    const text = '{ package P { part def A; } }';
    const model = new Model();
    const P = model.create('Package', { declaredName: 'P' });
    const A = model.create('PartDefinition', { declaredName: 'A', ownerId: P.id });
    const ranges = new Map<ElementId, TextRange>([
      [A.id, range(text.indexOf('part def A'))],
      [P.id, range(text.indexOf('package P'))],
    ]);
    // Pretend the fault was at offset 0, so P itself is a candidate; the only
    // opener before P's enclosing brace is nothing (offset 0) — P stays a root.
    rehomeAfterFault(model, text, ranges, 0);
    expect(model.ancestors(P.id).some((a) => a.id === A.id)).toBe(false);
    expect(model.get(A.id)?.ownerId).toBe(P.id);
  });
});

/**
 * The OTHER scanner that has to agree with the lexer about hidden text. It runs
 * BEFORE the parser and, when it fires, its finding REPLACES the whole parse —
 * so a false positive here does not merely add a wrong row, it suppresses every
 * real diagnostic in the file and the mapper runs with no fault at all.
 */
describe('findUnterminatedDelimiter — hidden text follows the lexer', () => {
  it('still reports a genuinely unterminated comment and string', () => {
    expect(findUnterminatedDelimiter('part a;\n/* never closed\n')).toMatchObject({
      kind: 'comment',
      line: 2,
    });
    expect(findUnterminatedDelimiter('part a = "never closed;\n')).toMatchObject({
      kind: 'string',
      line: 1,
    });
  });

  it('does not report prose inside a multi-line //* note', () => {
    // An apostrophe in the author's own prose used to be read as the start of
    // an unrestricted name, and the note's later lines as live source.
    const src = "package P {\n    //* the model's note\n       don't do this\n       */\n    part def A;\n}\n";
    expect(findUnterminatedDelimiter(src)).toBeUndefined();
  });

  it('does not report a block-comment opener inside a note', () => {
    const src = 'package P {\n    //* a note mentioning /* on purpose\n       */\n    part def A;\n}\n';
    expect(findUnterminatedDelimiter(src)).toBeUndefined();
  });

  it('treats an UNTERMINATED //* as a line comment, never as a fault', () => {
    // The lexer tries the note terminal first; with no closer its regex fails
    // and the single-line comment rule wins. Declining to report is what the
    // lexer does, so the scan must decline too.
    const src = "package P {\n    //* don't close this note\n    part def A;\n}\n";
    expect(findUnterminatedDelimiter(src)).toBeUndefined();
  });
});

describe('re-homing through the real parser', () => {
  /**
   * The unit test above builds the tie-break state by hand. This one goes
   * through the mapper, so the shape it describes is pinned as SHIPPED
   * behaviour and not only as a property of a synthetic model.
   */
  it('keeps a body written on an inline specialization with its declaration', () => {
    const { model } = parseModel(
      'package P {\n    part def Y;\n    part def X :> Y {\n        blok bad;\n        part inner;\n    }\n}\n',
    );
    const owner = (name: string) => {
      const el = model.all().find((e) => e.declaredName === name);
      return el?.ownerId === null || el?.ownerId === undefined
        ? null
        : (model.get(el.ownerId)?.declaredName ?? null);
    };
    expect(owner('inner')).toBe('X');
    expect(model.roots().map((r) => r.declaredName)).toEqual(['P']);
  });
});

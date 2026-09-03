/**
 * RECOVERY HONESTY — what a faulted parse is allowed to claim.
 *
 * Two guarantees are pinned here, both of them about SILENT loss rather than
 * about diagnostics:
 *
 *  1. OWNERSHIP. Error recovery parses every declaration after a fault one
 *     scope out. `rehome.ts` puts them back, but it used to skip relationships
 *     entirely (so an escaped `import`/`alias` stayed a permanent root, and the
 *     members of an `alias b for a { … }` body were re-homed onto the previous
 *     SIBLING) and it counted braces that live inside a hidden multi-line
 *     `//*` note as real (so a file faulted AND brace-balanced by coincidence got
 *     a phantom body). All three shapes are compared against the CLEAN variant
 *     of the same file: recovery may lose the faulty declaration, never move a
 *     healthy one somewhere else.
 *
 *  2. A FAULTED SAVE STAYS HONEST. `blok def Vehicle;` used to round-trip to
 *     `Vehicle;` plus a dangling `blok` at the end of the body — which
 *     re-parses CLEAN. The corruption was undetectable afterwards, which is
 *     worse than the missing element. The mapper now keeps the unparsed source
 *     of the faulty declaration on the residue element and the serializer
 *     re-emits it verbatim, so a save reproduces its own fault on re-parse.
 */
import { describe, it, expect } from 'vitest';
import { parseModel, serializeModel, checkText } from '@text/index';
import type { Model } from '@core/index';

const named = (model: Model, name: string) =>
  model.all().find((e) => e.declaredName === name);

/** Owner name of the element called `name` (`null` for a root). */
const ownerNameOf = (model: Model, name: string): string | null | undefined => {
  const el = named(model, name);
  if (el === undefined) return undefined;
  if (el.ownerId === null) return null;
  return model.get(el.ownerId)?.declaredName ?? `«${model.get(el.ownerId)?.eClass}»`;
};

const rootNames = (model: Model): string[] =>
  model.roots().map((r) => r.declaredName ?? `«${r.eClass}»`);

describe('recovery honesty — ownership after a fault', () => {
  it('re-homes an alias BODY under the alias, not onto the previous sibling', () => {
    const faulted = parseModel(
      'package P {\n    blok bad;\n    part a;\n    alias b for a {\n        attribute w;\n    }\n    part c;\n}\n',
    ).model;
    const clean = parseModel(
      'package P {\n    part bad;\n    part a;\n    alias b for a {\n        attribute w;\n    }\n    part c;\n}\n',
    ).model;

    expect(ownerNameOf(clean, 'w'), 'the clean variant owns w through the alias').toBe('b');
    expect(ownerNameOf(faulted, 'w')).toBe('b');
    expect(rootNames(faulted)).toEqual(['P']);
    expect(ownerNameOf(faulted, 'a')).toBe('P');
    expect(ownerNameOf(faulted, 'c')).toBe('P');
  });

  it('brings an escaped relationship home: an import stays inside its package', () => {
    const src =
      'package Q { part def W; }\npackage P {\n    blok bad;\n    import Q::*;\n    part a;\n    subset a subsets a;\n    part b : W;\n}\n';
    const { model } = parseModel(src);

    // The only way to WITNESS an escaped relationship: it becomes a root.
    expect(rootNames(model)).toEqual(['Q', 'P']);
    const imp = model.all().find((e) => e.eClass === 'NamespaceImport');
    expect(imp).toBeDefined();
    expect(model.get(imp?.ownerId as string)?.declaredName).toBe('P');
    expect(serializeModel(model)).toContain('import Q::*;');
  });

  it('does not count braces inside a hidden //* note as body braces', () => {
    const src =
      'package P {\n    blok bad;\n    //* note\n       {\n       */\n    part def A;\n    //* note2\n       }\n       */\n    part def C;\n}\n';
    const { model } = parseModel(src);
    expect(ownerNameOf(model, 'A'), 'A belongs to P, not to the residue of the bad line').toBe('P');
    expect(ownerNameOf(model, 'C')).toBe('P');
    expect(rootNames(model)).toEqual(['P']);
  });
});

describe('recovery honesty — a faulted save reproduces its fault', () => {
  const UNKNOWN = 'package P {\n    blok def Vehicle;\n}\n';

  it('keeps the unparsed declaration instead of welding it onto the parent', () => {
    const { model } = parseModel(UNKNOWN);
    expect(named(model, 'P')?.attrs.expression, 'the swallowed keyword is not a parent expression').toBeUndefined();
    expect(named(model, 'Vehicle')?.attrs.unparsedText).toBe('blok def Vehicle;');
  });

  it('re-emits the residue verbatim, so the save is not laundered clean', async () => {
    const { model } = parseModel(UNKNOWN);
    const out = serializeModel(model);
    expect(out).toContain('blok def Vehicle;');
    expect(out, 'the dangling keyword is gone').not.toMatch(/blok\s*\n?\s*}/);
    const again = await checkText(out, { library: 'none' });
    expect(again.diagnostics.map((d) => d.code)).toContain('parse/unknown-keyword');
  });

  it('keeps a BODIED residue brace-balanced and re-parseable to the same fault', async () => {
    const { model } = parseModel('package P {\n    blok def V { part x; }\n}\n');
    expect(named(model, 'V')?.attrs.unparsedText).toBe('blok def V { part x; }');
    const out = serializeModel(model);
    expect(out).toContain('blok def V { part x; }');
    const again = await checkText(out, { library: 'none' });
    expect(again.diagnostics.map((d) => d.code)).toContain('parse/unknown-keyword');
    expect(again.elements.roots).toEqual(['P']);
  });

  it('names the unknown word even without a `def` after it', async () => {
    const report = await checkText('package P {\n    blok q : T;\n}\n', { library: 'none' });
    const d = report.diagnostics.find((x) => x.code === 'parse/unknown-keyword');
    expect(d?.found).toBe('blok');
    expect(d?.hint).toContain('re-emitted verbatim');
  });

  it('does not invent an unknown keyword for shapes that are not one', async () => {
    for (const src of [
      'package P {\n    A::B c;\n}\n', // a qualified reference, not a keyword
      'package P {\n    Mass::M m;\n}\n', // …whose tail happens to spell the head's prefix
      'package P {\n    Length::Len l;\n}\n',
      'package P {\n    part a\n    part b;\n}\n', // a missing semicolon
      'package P {\n    constraint c { a + + 2 }\n}\n', // a double operator
    ]) {
      const report = await checkText(src, { library: 'none' });
      expect(
        report.diagnostics.filter((d) => d.code === 'parse/unknown-keyword'),
        `false unknown-keyword on ${JSON.stringify(src)}`,
      ).toEqual([]);
    }
  });

  it('reads `x y;` as an unknown keyword — the honest reading of two bare words', async () => {
    // The tool cannot tell a misspelled keyword from a stray identifier: both
    // are "a word that leads a declaration and means nothing". Naming the first
    // word is the useful half of that ignorance; the alternative reading
    // ("expecting `}`, insert a brace") is the advice this refinement exists to
    // stop giving.
    const report = await checkText('package P {\n    x y;\n}\n', { library: 'none' });
    const d = report.diagnostics.find((x) => x.code === 'parse/unknown-keyword');
    expect(d?.found).toBe('x');
  });

  it('keeps a nested residue in its own body — the faulted file round-trips byte for byte', () => {
    const src =
      'package P {\n    part def A {\n        attribute x;\n        blok bad;\n    }\n    part def B;\n}\n';
    const { model } = parseModel(src);
    expect(named(model, 'bad')?.attrs.unparsedText).toBe('blok bad;');
    expect(ownerNameOf(model, 'bad'), 'the residue belongs to the body it was written in').toBe('A');
    expect(ownerNameOf(model, 'B')).toBe('P');
    expect(`${serializeModel(model)}\n`).toBe(src);
  });

  it('marks nothing when the span would not be a self-contained declaration', () => {
    // `blok 5;` leaves no element of its own (a number cannot be a name), so
    // the first element after the fault lives in ANOTHER body. Marking it
    // would write a span crossing a closing brace into the file, and that
    // saves to something that re-parses as a different fault — worse than the
    // laundering this pass exists to stop. Both guards (same brace body, and
    // a brace-balanced slice) have to fail open for that to happen.
    const src =
      'package P {\n    part def A {\n        attribute x;\n        blok 5;\n    }\n    part def B;\n}\n';
    const { model } = parseModel(src);
    expect(
      model.all().filter((e) => e.attrs.unparsedText !== undefined).map((e) => e.declaredName),
    ).toEqual([]);
  });

  it('leaves a REAL trailing expression beside a fault alone', () => {
    const { model } = parseModel('package P {\n    blok bad;\n    constraint c { a > 2 }\n}\n');
    expect(named(model, 'c')?.attrs.expression, 'a constraint body is not residue').toBe('a > 2');
    expect(named(model, 'c')?.attrs.unparsedText).toBeUndefined();
  });
});

describe('recovery honesty — a grammar-legal keyword this tool does not model', () => {
  const NS = 'package P {\n    namespace N { part x; }\n}\n';

  it('keeps the declaration as an unparsed element rather than dropping it', async () => {
    const report = await checkText(NS, { library: 'none' });
    const d = report.diagnostics.find((x) => x.code === 'mapper/unsupported-keyword');
    expect(d?.severity).toBe('error');
    expect(d?.source).toBe('mapper');
    expect(d?.found).toBe('namespace');
    expect(d?.hint).toContain('preserved verbatim');

    const { model } = parseModel(NS);
    const kept = named(model, 'N');
    expect(kept, 'the declaration is kept, not dropped').toBeDefined();
    expect(kept?.attrs.unparsedText).toBe('namespace N { part x; }');
    expect(serializeModel(model)).toContain('namespace N { part x; }');
  });
});

describe('recovery honesty — the mark never costs more than it saves', () => {
  /**
   * THE invariant behind `unparsedText`: text kept on an element is text the
   * save writes out. Marking an element the serializer renders some other way
   * — a specialization inlined on its source's declaration line, an implicit
   * membership, a feature value — dropped the residue silently and the file
   * re-parsed CLEAN, which is the laundering the attribute exists to stop.
   */
  const FAULTED = [
    'package P {\n    blok def Vehicle;\n}\n',
    'package P {\n    blok def V { part x; }\n}\n',
    'package P {\n    part a;\n    part b;\n    part def A {\n        blok 5;\n        subset a subsets b;\n    }\n}\n',
    'package P {\n    blok bad;\n    alias k for a { attribute w; }\n    part a;\n}\n',
    'package P {\n    blok bad;\n    part v = 3;\n}\n',
    'package P {\n    part a;\n    part b;\n    blok subset a subsets b;\n}\n',
    'package P {\n    blok 5;\n    part def B { part y; }\n}\n',
    'package P {\n    namespace N { part x; }\n}\n',
    'package P {\n    blok q : T;\n}\n',
  ];

  it('writes out every scrap of text it claims to be keeping', () => {
    for (const src of FAULTED) {
      const { model } = parseModel(src);
      const out = serializeModel(model);
      for (const el of model.all()) {
        const kept = el.attrs.unparsedText;
        if (typeof kept !== 'string') continue;
        expect(out, `kept text dropped by the save for ${JSON.stringify(src)}`).toContain(kept);
      }
    }
  });

  it('never marks a relationship the serializer renders on someone else\'s line', async () => {
    // `subset a subsets b;` is re-homed onto its SOURCE and then written INLINE
    // as `part a :> b;`. It is the first ranged element after the fault, so it
    // used to be picked as the residue carrier — and because it is never
    // emitted as a statement of its own, the whole line vanished from the save
    // and the file re-parsed CLEAN.
    const src = 'package P {\n    part a;\n    part b;\n    blok subset a subsets b;\n}\n';
    const { model } = parseModel(src);
    expect(model.all().filter((e) => typeof e.attrs.unparsedText === 'string')).toEqual([]);
    const out = serializeModel(model);
    expect(out, 'the relationship itself survives the save').toContain(':> b');
    const again = await checkText(out, { library: 'none' });
    expect(again.elements.roots).toEqual(['P']);
  });

  it('never marks a specialization written inside a body either', () => {
    const { model } = parseModel(
      'package P {\n    part a;\n    part b;\n    part def A {\n        blok subset a subsets b;\n    }\n}\n',
    );
    expect(model.all().filter((e) => typeof e.attrs.unparsedText === 'string')).toEqual([]);
  });

  it('leaves a healthy declaration and its body unfrozen', async () => {
    // `blok 5;` has no element of its own; the next statement is a COMPLETE,
    // healthy declaration. Marking it swallowed `part def B { part y; }` into a
    // verbatim string, which also froze the element: later model edits (a
    // rename, a new child) were silently dropped by the serializer.
    const src = 'package P {\n    blok 5;\n    part def B { part y; }\n}\n';
    const { model } = parseModel(src);
    expect(named(model, 'B')?.attrs.unparsedText).toBeUndefined();
    expect(named(model, 'y'), 'the healthy body survives as elements').toBeDefined();

    const b = named(model, 'B');
    model.update(b?.id as string, { declaredName: 'Renamed' });
    expect(serializeModel(model)).toContain('part def Renamed');
  });

  it('declines on an unbalanced file, exactly as re-homing does', () => {
    // With no brace pairs every offset is "file level", so the same-body guard
    // fails OPEN and the span could cross any number of scopes.
    const { model } = parseModel('package P {\n    part def A {\n        blok 5;\n    part def B;\n');
    expect(model.all().filter((e) => e.attrs.unparsedText !== undefined)).toEqual([]);
  });

  it('keeps a one-reference constraint body whose fault is the very next token', () => {
    // `constraint c { a x }` parses IDENTICALLY to `blok def Vehicle;`: a bare
    // RefExpr ending at the token before the mismatch. Judging that on offsets
    // alone deleted the constraint's expression from the model — and, with no
    // element to hang the text on, deleted it from the file too.
    const { model } = parseModel('package P {\n    constraint c { a x }\n}\n');
    expect(named(model, 'c')?.attrs.expression).toBe('a');
    expect(serializeModel(model)).toContain('a');
  });

  it('keeps a calculation body in the same shape', () => {
    const { model } = parseModel('package P {\n    calc def F { a x }\n}\n');
    expect(named(model, 'F')?.attrs.expression).toBe('a');
  });

  it('keeps a constraint body when the closing brace is missing', () => {
    const { model } = parseModel('package P {\n    constraint c { x\n    part y;\n}\n');
    expect(named(model, 'c')?.attrs.expression).toBe('x');
  });

  it('reports an ANONYMOUS unsupported declaration exactly once', async () => {
    // The kept element has no name and no children of its own, which is the
    // shape `validation/split-declaration` is looking for — a second finding
    // whose repair points somewhere else entirely.
    const report = await checkText('package P {\n    namespace {\n        part x;\n    }\n}\n', {
      library: 'none',
    });
    expect(report.diagnostics.map((d) => d.code)).toEqual(['mapper/unsupported-keyword']);
  });

  it('preserves the FIRST fault in a body — the rest is a recorded residual', async () => {
    // After the first fault, recovery escapes to the namespace level, where
    // there is no trailing-expression site to catch the next one. The second
    // `blok two;` is still REPORTED, but the save does not reproduce it. The
    // campaign ledger records this; the test exists so the scope of the
    // honesty claim cannot widen by accident.
    const src = 'package P {\n    blok one;\n    part a;\n    blok two;\n    part b;\n}\n';
    const before = await checkText(src, { library: 'none' });
    expect(before.diagnostics.filter((d) => d.code === 'parse/unknown-keyword')).toHaveLength(2);

    const { model } = parseModel(src);
    expect(named(model, 'one')?.attrs.unparsedText).toBe('blok one;');
    const again = await checkText(serializeModel(model), { library: 'none' });
    expect(
      again.diagnostics.filter((d) => d.code === 'parse/unknown-keyword'),
      'the residual: one fault of the two survives the round trip',
    ).toHaveLength(1);
  });
});

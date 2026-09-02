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

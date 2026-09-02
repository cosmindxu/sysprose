import { describe, it, expect } from 'vitest';
import { resolveReparentTarget, subtreeRoots, type ReparentTargetModel } from '@diagram/index';

/**
 * A tiny in-memory model implementing the ReparentTargetModel slice: a flat map
 * of id → ownerId. `ancestors` walks the ownerId chain (cycle-safe).
 */
function makeModel(owners: Record<string, string | null>): ReparentTargetModel {
  return {
    has: (id) => id in owners,
    get: (id) => (id in owners ? { ownerId: owners[id] } : undefined),
    ancestors: (id) => {
      const out: { id: string }[] = [];
      const seen = new Set<string>([id]);
      let cur = owners[id] ?? null;
      while (cur !== null && !seen.has(cur)) {
        seen.add(cur);
        out.push({ id: cur });
        cur = owners[cur] ?? null;
      }
      return out;
    },
  };
}

describe('resolveReparentTarget (canvas drag-to-reparent)', () => {
  it('returns the first candidate that is a valid new owner', () => {
    const model = makeModel({ root: null, a: null, target: null });
    expect(resolveReparentTarget(model, ['a'], ['target'])).toBe('target');
  });

  it('prefers the most-specific (first) candidate', () => {
    const model = makeModel({ parent: null, inner: 'parent', a: null });
    // Caller passes innermost first → inner wins over parent.
    expect(resolveReparentTarget(model, ['a'], ['inner', 'parent'])).toBe('inner');
  });

  it('skips the dragged element itself', () => {
    const model = makeModel({ a: null, b: null });
    expect(resolveReparentTarget(model, ['a'], ['a', 'b'])).toBe('b');
  });

  it('skips a candidate that is one of the other dragged elements', () => {
    const model = makeModel({ a: null, b: null, c: null });
    // Dragging a+b; overlapping b then c → b skipped (dragged), c chosen.
    expect(resolveReparentTarget(model, ['a', 'b'], ['b', 'c'])).toBe('c');
  });

  it('skips a candidate inside a dragged element subtree (cycle guard)', () => {
    // desc is a grandchild of `a`; dropping `a` onto desc would create a cycle.
    const model = makeModel({ a: null, mid: 'a', desc: 'mid', ok: null });
    expect(resolveReparentTarget(model, ['a'], ['desc'])).toBeNull();
    expect(resolveReparentTarget(model, ['a'], ['desc', 'ok'])).toBe('ok');
  });

  it('skips a no-op drop back onto the current owner', () => {
    const model = makeModel({ owner: null, a: 'owner' });
    expect(resolveReparentTarget(model, ['a'], ['owner'])).toBeNull();
  });

  it('drops onto an ANCESTOR of a dragged element resolve to null (ancestor-skip wins)', () => {
    // Dragging [a, b] where `a` already lives under `owner`: `owner` is an
    // ancestor of a dragged element, so the drop is treated as a move WITHIN
    // owner (no reparent) rather than silently re-owning b — erring safe.
    const model = makeModel({ owner: null, a: 'owner', b: null });
    expect(resolveReparentTarget(model, ['a', 'b'], ['owner'])).toBeNull();
    // But an unrelated container still accepts the whole group.
    const m2 = makeModel({ owner: null, a: 'owner', b: null, t: null });
    expect(resolveReparentTarget(m2, ['a', 'b'], ['t'])).toBe('t');
  });

  it('skips a stale candidate not present in the model', () => {
    const model = makeModel({ a: null, real: null });
    expect(resolveReparentTarget(model, ['a'], ['ghost', 'real'])).toBe('real');
  });

  it('returns null for an empty drag or no candidates', () => {
    const model = makeModel({ a: null, t: null });
    expect(resolveReparentTarget(model, [], ['t'])).toBeNull();
    expect(resolveReparentTarget(model, ['a'], [])).toBeNull();
  });

  it('skips a candidate that is an ANCESTOR of a dragged element (nested drag)', () => {
    // pkg ⊃ part ⊃ port. Dragging port over its parent/grandparent (which its rect
    // always overlaps under extent:parent) must NOT reparent it up a level.
    const model = makeModel({ pkg: null, part: 'pkg', port: 'part' });
    expect(resolveReparentTarget(model, ['port'], ['part', 'pkg'])).toBeNull();
    // A non-ancestor sibling container is still a valid reparent target.
    const m2 = makeModel({ pkg: null, part: 'pkg', port: 'part', other: 'pkg' });
    expect(resolveReparentTarget(m2, ['port'], ['part', 'pkg', 'other'])).toBe('other');
  });

  it('cycle guard checks EVERY dragged element, not just the first (multi-drag)', () => {
    // desc is inside b's subtree; dragging [a, b] onto desc would cycle via b.
    const model = makeModel({ a: null, b: null, mid: 'b', desc: 'mid' });
    expect(resolveReparentTarget(model, ['a', 'b'], ['desc'])).toBeNull();
  });

  it('returns null when the only dragged id is stale (not in the model)', () => {
    const model = makeModel({ t: null });
    expect(resolveReparentTarget(model, ['ghost'], ['t'])).toBeNull();
  });
});

describe('subtreeRoots', () => {
  it('drops descendants whose ancestor is also in the set', () => {
    const model = makeModel({ parent: null, child: 'parent', grandchild: 'child', other: null });
    expect(subtreeRoots(model, ['parent', 'child', 'grandchild']).sort()).toEqual(['parent']);
    expect(subtreeRoots(model, ['parent', 'other']).sort()).toEqual(['other', 'parent']);
    expect(subtreeRoots(model, ['child', 'grandchild']).sort()).toEqual(['child']);
  });

  it('keeps unrelated ids and preserves the survivors', () => {
    const model = makeModel({ a: null, b: null, c: null });
    expect(subtreeRoots(model, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

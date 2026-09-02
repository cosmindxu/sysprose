import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Model } from '@core/index';

// The store kicks off an async standard-library merge at module load; stub it so
// the singleton model stays deterministic for these reducer tests (finding C12).
vi.mock('../../src/library/full-library', () => ({
  loadFullStandardLibrary: () => {},
  preloadFullLibrary: async () => {},
}));
vi.mock('../../src/library/standard-library', () => ({
  loadCuratedLibrary: () => {},
}));

import { useAppStore } from '../../src/ui/store';

/** Reset the singleton store to a fresh, empty model before each test. */
function reset(): void {
  useAppStore.setState({
    model: new Model(),
    undoStack: [],
    redoStack: [],
    selectionId: null,
    selectionIds: [],
  });
}

const st = () => useAppStore.getState();

describe('useAppStore — reducers / undo-redo (C12)', () => {
  beforeEach(reset);

  it('createElement adds an element, bumps rev, and pushes an undo snapshot', () => {
    const before = st().rev;
    const id = st().createElement('PartDefinition', null, 'Widget');
    expect(st().model.get(id)?.declaredName).toBe('Widget');
    expect(st().model.get(id)?.eClass).toBe('PartDefinition');
    expect(st().undoStack.length).toBe(1);
    expect(st().rev).toBeGreaterThan(before);
  });

  it('setAttr and updateElement mutate the element', () => {
    const id = st().createElement('AttributeUsage', null, 'mass');
    st().setAttr(id, 'value', 1500);
    expect(st().model.get(id)?.attrs.value).toBe(1500);
    st().updateElement(id, { declaredName: 'weight' });
    expect(st().model.get(id)?.declaredName).toBe('weight');
  });

  it('deleteElement removes the element from the model', () => {
    const id = st().createElement('PartUsage', null, 'gone');
    expect(st().model.get(id)).toBeDefined();
    st().deleteElement(id);
    expect(st().model.get(id)).toBeUndefined();
  });

  it('undo restores the prior model state; redo re-applies it', () => {
    const id = st().createElement('PartDefinition', null, 'Temp');
    expect(st().model.get(id)).toBeDefined();
    const sizeAfterCreate = st().model.size;

    st().undo();
    expect(st().model.all().some((e) => e.declaredName === 'Temp')).toBe(false);

    st().redo();
    expect(st().model.all().some((e) => e.declaredName === 'Temp')).toBe(true);
    expect(st().model.size).toBe(sizeAfterCreate);
  });

  it('reparent moves an element under a new owner', () => {
    const pkg = st().createElement('Package', null, 'Pkg');
    const part = st().createElement('PartDefinition', null, 'P');
    st().reparent(part, pkg);
    expect(st().model.get(part)?.ownerId).toBe(pkg);
  });

  it('reparentMany moves several elements under one owner in a single undo step', () => {
    const pkg = st().createElement('Package', null, 'Pkg');
    const a = st().createElement('PartDefinition', null, 'A');
    const b = st().createElement('PartDefinition', null, 'B');
    const undoBefore = st().undoStack.length;
    st().reparentMany([a, b], pkg);
    expect(st().model.get(a)?.ownerId).toBe(pkg);
    expect(st().model.get(b)?.ownerId).toBe(pkg);
    expect(st().undoStack.length).toBe(undoBefore + 1); // ONE snapshot for both
    st().undo();
    expect(st().model.get(a)?.ownerId).toBe(null);
    expect(st().model.get(b)?.ownerId).toBe(null);
  });

  it('reparentMany skips illegal (cycle) members but applies the legal ones', () => {
    const parent = st().createElement('Package', null, 'Parent');
    const child = st().createElement('Package', parent, 'Child');
    const other = st().createElement('PartDefinition', null, 'Other');
    // Reparenting `parent` under its own `child` is a cycle → skipped; `other`
    // moves under `child` fine. Net: one legal move, one undo snapshot.
    st().reparentMany([parent, other], child);
    expect(st().model.get(parent)?.ownerId).toBe(null); // unchanged (cycle)
    expect(st().model.get(other)?.ownerId).toBe(child); // moved
  });

  it('reparentMany with only no-op moves neither mutates nor pushes an undo', () => {
    const pkg = st().createElement('Package', null, 'Pkg');
    const a = st().createElement('PartDefinition', pkg, 'A'); // already under pkg
    const undoBefore = st().undoStack.length;
    const revBefore = st().rev;
    st().reparentMany([a], pkg);
    expect(st().undoStack.length).toBe(undoBefore); // no snapshot
    expect(st().rev).toBe(revBefore); // no mutation
  });

  it('reparentMany reduces to subtree roots — a parent+child set moves the subtree whole', () => {
    const parent = st().createElement('Package', null, 'Parent');
    const child = st().createElement('PartDefinition', parent, 'Child'); // under parent
    const dest = st().createElement('Package', null, 'Dest');
    // Dragging both parent AND its child onto dest must move only the subtree
    // root; child stays under parent (not flattened into a sibling of parent).
    st().reparentMany([parent, child], dest);
    expect(st().model.get(parent)?.ownerId).toBe(dest);
    expect(st().model.get(child)?.ownerId).toBe(parent); // NOT dest
  });

  it('reparentMany with an all-illegal set preserves undo AND redo history', () => {
    const parent = st().createElement('Package', null, 'Parent');
    const mid = st().createElement('Package', parent, 'Mid');
    const grandchild = st().createElement('Package', mid, 'Grand');
    // Seed a redo entry: make an edit, then undo it.
    const temp = st().createElement('PartDefinition', null, 'Temp');
    st().deleteElement(temp);
    st().undo(); // Temp restored; redoStack now has one entry
    expect(st().redoStack.length).toBe(1);
    const undoBefore = st().undoStack.length;
    const revBefore = st().rev;
    // Reparent parent under its own grandchild → cycle → every move fails.
    st().reparentMany([parent], grandchild);
    expect(st().model.get(parent)?.ownerId).toBe(null); // unchanged
    expect(st().undoStack.length).toBe(undoBefore); // snapshot rolled back
    expect(st().rev).toBe(revBefore); // no mutation
    expect(st().redoStack.length).toBe(1); // redo history NOT destroyed
  });

  it('connect creates a relationship edge between two elements', () => {
    const a = st().createElement('PartUsage', null, 'a');
    const b = st().createElement('PartUsage', null, 'b');
    const before = st().model.size;
    st().connect(a, b, 'ConnectionUsage');
    expect(st().model.size).toBeGreaterThan(before);
    const edge = st().model.all().find((e) => e.eClass === 'ConnectionUsage');
    expect(edge).toBeDefined();
    expect(edge?.source?.[0]).toBe(a);
    expect(edge?.target?.[0]).toBe(b);
  });

  it('saveScenario / loadScenario / deleteScenario snapshot the regroup config', () => {
    st().setRegroupConfig({ membership: { p: 'b1' }, bundles: [{ id: 'b1', label: 'B1', isNew: true }] });
    st().saveScenario('one');
    expect(Object.keys(st().scenarios)).toContain('one');

    st().setRegroupConfig({ membership: { p: 'b2' } }); // change live config
    expect(st().regroupConfig.membership.p).toBe('b2');

    st().loadScenario('one'); // restores the snapshot
    expect(st().regroupConfig.membership.p).toBe('b1');

    // Snapshot is a deep copy — mutating the live config doesn't touch it.
    st().setRegroupConfig({ membership: { p: 'b3' } });
    expect(st().scenarios.one.membership.p).toBe('b1');

    st().deleteScenario('one');
    expect(st().scenarios.one).toBeUndefined();
  });

  it('select updates the selection id', () => {
    const id = st().createElement('PartDefinition', null, 'Sel');
    st().select(id);
    expect(st().selectionId).toBe(id);
  });

  it('duplicateElement deep-clones a subtree in exactly one undo step', () => {
    const car = st().createElement('PartDefinition', null, 'Car');
    st().createElement('PartUsage', car, 'engine');
    st().createElement('PartUsage', car, 'wheel');
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;

    const clone = st().duplicateElement(car);
    expect(clone).toBeTruthy();
    expect(st().model.size).toBe(sizeBefore + 3); // Car + engine + wheel
    expect(st().selectionId).toBe(clone); // selection follows the clone
    expect(st().model.get(clone!)?.declaredName).toBe('Car copy');
    expect(st().undoStack.length).toBe(undoBefore + 1); // single undo entry

    st().undo(); // one step restores the pre-duplicate model
    expect(st().model.size).toBe(sizeBefore);
    expect(st().model.all().some((e) => e.declaredName === 'Car copy')).toBe(false);
  });

  it('select additive toggles the multi-selection set; primary follows', () => {
    const a = st().createElement('PartUsage', null, 'a');
    const b = st().createElement('PartUsage', null, 'b');
    const c = st().createElement('PartUsage', null, 'c');

    st().select(a); // plain click → single
    expect(st().selectionIds).toEqual([a]);
    expect(st().selectionId).toBe(a);

    st().select(b, { additive: true }); // extend
    st().select(c, { additive: true });
    expect(new Set(st().selectionIds)).toEqual(new Set([a, b, c]));
    expect(st().selectionId).toBe(c); // primary = last toggled

    st().select(b, { additive: true }); // toggle b OFF
    expect(new Set(st().selectionIds)).toEqual(new Set([a, c]));

    st().select(a); // plain click → collapses to single
    expect(st().selectionIds).toEqual([a]);
  });

  it('setSelection replaces the selection with a deduped, live set (primary = last)', () => {
    const a = st().createElement('PartUsage', null, 'a');
    const b = st().createElement('PartUsage', null, 'b');
    const c = st().createElement('PartUsage', null, 'c');

    st().setSelection([a, b, b, c]); // dup b
    expect(st().selectionIds).toEqual([a, b, c]);
    expect(st().selectionId).toBe(c); // primary = last

    st().deleteElement(b);
    st().setSelection([a, b, c]); // b is gone → dropped
    expect(st().selectionIds).toEqual([a, c]);
    expect(st().selectionId).toBe(c);
  });

  it('deleteSelection removes every selected element in one undo step', () => {
    const a = st().createElement('PartUsage', null, 'a');
    const b = st().createElement('PartUsage', null, 'b');
    const c = st().createElement('PartUsage', null, 'c');
    st().select(a);
    st().select(b, { additive: true });
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;

    st().deleteSelection(); // removes a + b, keeps c
    expect(st().model.size).toBe(sizeBefore - 2);
    expect(st().model.get(c)).toBeDefined();
    expect(st().selectionIds).toEqual([]);
    expect(st().undoStack.length).toBe(undoBefore + 1); // one undo entry

    st().undo();
    expect(st().model.size).toBe(sizeBefore); // both restored in one step
  });

  it('duplicateSelection clones each top-level selection; skips a nested descendant', () => {
    const car = st().createElement('PartDefinition', null, 'Car');
    const engine = st().createElement('PartUsage', car, 'engine'); // descendant of Car
    const wheel = st().createElement('PartUsage', null, 'wheel');
    st().select(car);
    st().select(engine, { additive: true }); // engine is under Car → should be dropped
    st().select(wheel, { additive: true });
    const sizeBefore = st().model.size;

    st().duplicateSelection();
    // Car (+ engine child) = 2 new, wheel = 1 new; engine NOT cloned standalone.
    expect(st().model.size).toBe(sizeBefore + 3);
    // Two new roots selected (Car copy, wheel copy).
    expect(st().selectionIds.length).toBe(2);
    expect(st().model.all().filter((e) => e.declaredName === 'engine').length).toBe(2); // original + the clone under Car copy
  });

  it('copySelection + pasteClipboard clones under the target in one undo step', () => {
    const src = st().createElement('PartDefinition', null, 'Src');
    st().createElement('PartUsage', src, 'child');
    const dst = st().createElement('PartDefinition', null, 'Dst');

    st().select(src);
    st().copySelection();
    expect(st().clipboard).not.toBeNull();

    st().select(dst);
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;
    const roots = st().pasteClipboard(); // paste under the primary selection (dst)
    expect(roots.length).toBe(1);
    expect(st().model.size).toBe(sizeBefore + 2); // Src + child
    expect(st().model.get(roots[0])?.ownerId).toBe(dst);
    expect(st().selectionIds).toEqual(roots);
    expect(st().undoStack.length).toBe(undoBefore + 1);

    st().undo();
    expect(st().model.size).toBe(sizeBefore); // one-step undo
  });

  it('duplicateElement refuses a relationship (keyboard matches the node-only menu)', () => {
    const a = st().createElement('PartUsage', null, 'a');
    const b = st().createElement('PartUsage', null, 'b');
    const rel = st().connect(a, b, 'Dependency'); // a relationship metaclass
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;

    expect(st().duplicateElement(rel)).toBeNull();
    expect(st().model.size).toBe(sizeBefore); // no clone created
    expect(st().undoStack.length).toBe(undoBefore); // no undo entry pushed
  });
});

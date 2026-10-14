import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, buildSampleModel } from '@core/index';

describe('Model core', () => {
  it('creates and indexes containment', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const def = f.partDef('Vehicle', pkg.id);
    expect(m.roots().map((e) => e.id)).toEqual([pkg.id]);
    expect(m.children(pkg.id).map((e) => e.id)).toEqual([def.id]);
    expect(m.owner(def.id)?.id).toBe(pkg.id);
    expect(m.qualifiedName(def.id)).toBe('P::Vehicle');
  });

  it('emits change events (batched in a transaction)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const batches: number[] = [];
    m.subscribe((evts) => batches.push(evts.length));
    m.transaction(() => {
      const p = f.pkg('P');
      f.partDef('A', p.id);
      f.partDef('B', p.id);
    });
    expect(batches).toEqual([3]);
  });

  it('cascades deletes and prunes dangling relationships', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const a = f.part('a', pkg.id);
    const b = f.part('b', pkg.id);
    const rel = f.connect(a.id, b.id, { ownerId: pkg.id });
    expect(m.has(rel.id)).toBe(true);
    m.remove(a.id);
    expect(m.has(a.id)).toBe(false);
    expect(m.has(rel.id)).toBe(false); // connector pruned
    expect(m.has(b.id)).toBe(true);
  });

  it('prevents containment cycles on reparent', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const a = f.pkg('A');
    const b = f.partDef('B', a.id);
    expect(() => m.reparent(a.id, b.id)).toThrow(/cycle/i);
  });

  it('resolves qualified names and types', () => {
    const m = buildSampleModel();
    const vehicleDef = m.resolveQualifiedName('VehicleModel::Vehicle');
    expect(vehicleDef?.eClass).toBe('PartDefinition');
    const vehicle = m.resolveQualifiedName('VehicleModel::vehicle');
    expect(vehicle).toBeDefined();
    expect(m.typesOf(vehicle!.id).map((t) => t.declaredName)).toContain('Vehicle');
  });

  it('round-trips through JSON without loss', () => {
    const m = buildSampleModel();
    const json = m.toJSON();
    const restored = Model.fromJSON(json);
    expect(restored.size).toBe(m.size);
    expect(restored.rootIds()).toEqual(m.rootIds());
    expect(JSON.stringify(restored.toJSON())).toBe(JSON.stringify(json));
  });

  it('toJSONWhere / resetPreserving snapshots the user scope and keeps the library (C6)', () => {
    const m = new Model();
    // A "library" root (tagged like the standard library) merged AFTER the user
    // root, mirroring the live boot order (user sample first, library second).
    const userPkg = m.create('Package', { declaredName: 'User' });
    const userPart = m.create('PartUsage', { declaredName: 'p', ownerId: userPkg.id });
    const libPkg = m.create('Package', { declaredName: 'Lib', attrs: { isLibrary: true } });
    m.create('DataType', { declaredName: 'Real', ownerId: libPkg.id, attrs: { isLibrary: true } });

    const isLib = (el: { attrs: Record<string, unknown> }) => el.attrs.isLibrary === true;
    const isUser = (el: { attrs: Record<string, unknown> }) => el.attrs.isLibrary !== true;

    // Snapshot excludes the library entirely.
    const snap = m.toJSONWhere(isUser);
    expect(snap.elements).toHaveLength(2);
    expect(snap.elements.every((e) => e.attrs.isLibrary !== true)).toBe(true);
    expect(snap.rootIds).toEqual([userPkg.id]);

    // Delete the user model, then restore the snapshot preserving the library.
    m.remove(userPkg.id, { cascade: true });
    expect(m.get(userPart.id)).toBeUndefined();
    m.resetPreserving(snap, isLib);

    // User model restored WITH the same ids; library still present.
    expect(m.get(userPart.id)?.declaredName).toBe('p');
    expect(m.filter(isLib)).toHaveLength(2);
    // Root order is user-first (not flipped to library-first).
    expect(m.rootIds()[0]).toBe(userPkg.id);
    expect(m.rootIds()).toContain(libPkg.id);

    // Preserved library records keep object identity (reused, not deep-cloned).
    expect(m.get(libPkg.id)).toBe(libPkg);
  });

  /**
   * A serialised model carries no child order of its own: a load rebuilds each
   * owner's children from the order the elements are listed in. `reparent`
   * appends the element it moves to its new owner's children, so a model listed
   * in the order its elements were added came back from Save, Undo and the checks
   * worker with that owner's children reordered — and a composite with no
   * `initial` entering another state (review 2026-10-14 D-1, D-2).
   */
  describe('serialised after a reparent, each owner keeps its children in order (D-1, D-2)', () => {
    /** Every owner's children, and the roots, as ids. */
    const containment = (m: Model): Record<string, string[]> => {
      const out: Record<string, string[]> = { '(roots)': m.rootIds() };
      for (const el of m.all()) if (m.childIds(el.id).length > 0) out[el.id] = m.childIds(el.id);
      return out;
    };
    const isLib = (el: { attrs: Record<string, unknown> }) => el.attrs.isLibrary === true;
    const names = (m: Model, owner: string) => m.children(owner).map((e) => e.declaredName).join(',');

    /** A machine `M` of three states, an older `Spare` and a newer composite `Work`, and a library beside them. */
    function machine() {
      const m = new Model();
      const pkg = m.create('Package', { declaredName: 'P' });
      const M = m.create('StateDefinition', { declaredName: 'M', ownerId: pkg.id });
      const A = m.create('StateUsage', { declaredName: 'A', ownerId: M.id });
      m.create('StateUsage', { declaredName: 'B', ownerId: M.id });
      m.create('StateUsage', { declaredName: 'C', ownerId: M.id });
      const spare = m.create('StateUsage', { declaredName: 'Spare', ownerId: M.id });
      m.create('StateUsage', { declaredName: 'Inner', ownerId: spare.id });
      const work = m.create('StateUsage', { declaredName: 'Work', ownerId: M.id });
      m.create('StateUsage', { declaredName: 'Prep', ownerId: work.id });
      m.create('StateUsage', { declaredName: 'Run', ownerId: work.id });
      const lib = m.create('Package', { declaredName: 'Lib', attrs: { isLibrary: true } });
      m.create('DataType', { declaredName: 'Real', ownerId: lib.id, attrs: { isLibrary: true } });
      return { m, M, A, spare, work };
    }

    it('a reparented element comes back where it was put: through toJSON, clone, an Undo snapshot and the user part alone', () => {
      const { m, M, A, spare, work } = machine();
      // Out and back in, as a drag in the Explorer does: A is now M's last child.
      m.reparent(A.id, M.ownerId);
      m.reparent(A.id, M.id);
      // An older state, with a child of its own, dragged into a newer composite.
      m.reparent(spare.id, work.id);
      expect(names(m, M.id)).toBe('B,C,Work,A');
      expect(names(m, work.id)).toBe('Prep,Run,Spare');
      const live = containment(m);

      expect(containment(Model.fromJSON(m.toJSON())), 'Save, then open').toEqual(live);
      expect(containment(Model.fromJSON(JSON.parse(JSON.stringify(m.toJSON())))), 'through the JSON text').toEqual(live);
      expect(containment(m.clone()), 'clone').toEqual(live);

      // An Undo snapshot of the user's part, restored over the library.
      const restored = m.clone();
      restored.resetPreserving(m.toJSONWhere((el) => !isLib(el)), isLib);
      expect(containment(restored), 'Undo').toEqual(live);
      expect(names(restored, M.id)).toBe('B,C,Work,A');
      expect(names(restored, work.id)).toBe('Prep,Run,Spare');
    });

    it('lists a model nothing was reparented in exactly as before: in the order its elements were added', () => {
      const { m, M, work } = machine();
      // Edits that are not a reparent keep each owner's children in the order they were added.
      m.create('StateUsage', { declaredName: 'Late', ownerId: M.id });
      m.create('StateUsage', { declaredName: 'Later', ownerId: work.id });
      m.remove(m.children(M.id)[1].id);
      m.rename(work.id, 'Busy');
      expect(m.inSerialOrder()).toEqual(m.all());
      expect(JSON.stringify(m.toJSON().elements)).toBe(JSON.stringify(m.all()));
      expect(JSON.stringify(m.toJSONWhere((el) => !isLib(el)).elements)).toBe(JSON.stringify(m.all().filter((el) => !isLib(el))));
      // The records themselves, not copies: the checks worker's request is copied once, by the send.
      expect(m.inSerialOrder()[0]).toBe(m.all()[0]);
    });

    it('moves only the reparented owner\'s children, and only among the places they held', () => {
      const { m, M, A } = machine();
      expect(m.all().map((e) => e.declaredName)).toEqual(['P', 'M', 'A', 'B', 'C', 'Spare', 'Inner', 'Work', 'Prep', 'Run', 'Lib', 'Real']);
      m.reparent(A.id, M.ownerId);
      m.reparent(A.id, M.id);
      // M's five children take the five places they held, in M's order now; Inner, Prep, Run and the library stay put.
      expect(m.inSerialOrder().map((e) => e.declaredName)).toEqual(['P', 'M', 'B', 'C', 'Spare', 'Work', 'Inner', 'A', 'Prep', 'Run', 'Lib', 'Real']);
    });

    /**
     * The copies are not enough: the page decided by its own order. Of two
     * transitions out of an `initial`, the walk takes the first the endpoint
     * index lists, and the index lists them as `all()` does — the order they
     * were added in, where every copy lists them as their owner holds them. A
     * move in the app therefore lists the model as its copies are rebuilt
     * (review 2026-10-14 D-1, the S2 review).
     */
    it('adoptSerialOrder lists the model as every copy of it is rebuilt: the same records, and the endpoint index with them', () => {
      const m = new Model();
      const pkg = m.create('Package', { declaredName: 'P' });
      const M = m.create('StateDefinition', { declaredName: 'M', ownerId: pkg.id });
      const start = m.create('InitialNode', { declaredName: 'start', ownerId: M.id });
      const A = m.create('StateUsage', { declaredName: 'A', ownerId: M.id });
      const B = m.create('StateUsage', { declaredName: 'B', ownerId: M.id });
      const toA = m.create('TransitionUsage', { declaredName: 'toA', ownerId: M.id, source: [start.id], target: [A.id] });
      m.create('TransitionUsage', { declaredName: 'toB', ownerId: M.id, source: [start.id], target: [B.id] });
      const fresh = (): Model => Model.fromJSON(m.toJSON());
      const outOfStart = (x: Model) => x.edgesFrom(start.id).map((e) => e.declaredName);
      expect(m.adoptSerialOrder(), 'nothing moved: nothing to do').toBe(false);

      // toA dragged out of the machine and back in: now M's last child, in the text after toB.
      m.reparent(toA.id, pkg.id);
      m.reparent(toA.id, M.id);
      expect(outOfStart(m), 'the page, as added').toEqual(['toA', 'toB']);
      expect(outOfStart(fresh()), 'every copy, as M holds them').toEqual(['toB', 'toA']);

      const saved = JSON.stringify(m.toJSON());
      const records = new Set(m.all());
      const rev = m.rev;
      expect(m.adoptSerialOrder()).toBe(true);
      // The index was built at the move's revision above: it is built again.
      expect(m.rev).toBeGreaterThan(rev);
      expect(outOfStart(m), 'the page, as every copy').toEqual(['toB', 'toA']);
      const listed = m.inSerialOrder();
      expect(m.all().every((el, i) => el === listed[i] && records.has(el)), 'the same records, listed as copies are').toBe(true);
      expect(JSON.stringify(m.toJSON()), 'the copies are as they were').toBe(saved);

      expect(m.adoptSerialOrder(), 'once is enough').toBe(false);
      expect(m.rev).toBe(rev + 1);
    });

    it('an Undo restored over the library keeps the order a library owner holds its children in', () => {
      const m = new Model();
      m.create('Package', { declaredName: 'U' });
      const L = m.create('Package', { declaredName: 'L', attrs: { isLibrary: true } });
      const A = m.create('PartDefinition', { declaredName: 'A', ownerId: L.id, attrs: { isLibrary: true } });
      m.create('PartDefinition', { declaredName: 'B', ownerId: L.id, attrs: { isLibrary: true } });
      m.create('PartDefinition', { declaredName: 'C', ownerId: L.id, attrs: { isLibrary: true } });
      // A library element moves within the library (store.reparent): A is now L's last.
      m.reparent(A.id, L.id);
      expect(names(m, L.id)).toBe('B,C,A');
      const records = m.all().filter(isLib);
      m.resetPreserving(m.toJSONWhere((el) => !isLib(el)), isLib);
      expect(names(m, L.id)).toBe('B,C,A');
      // The library's own records, not copies (C6).
      expect(m.all().filter(isLib).every((el) => records.includes(el))).toBe(true);
    });
  });
});

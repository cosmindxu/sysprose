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
});

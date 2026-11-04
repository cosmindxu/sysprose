import { describe, it, expect, vi } from 'vitest';
import { Model, ModelFactory, buildSampleModel, type ChangeEvent, type ElementRecord } from '@core/index';
import { loadModelText } from '@text/load';
import { serializeUserModelSignals } from '@text/index';
import { RULES_BY_ID } from '@validation/index';

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

  // `remove(id, { cascade: false })` kept the children under an owner no element has (reachable through the SDK's
  // `delete(id, { cascade: false })`); a snapshot of the model (toJSON, Undo, Open) carried that owner too. They go to the
  // top level in the removal's own transaction, where a collaboration room reads them on every peer.
  it('moves the children a non-cascading removal keeps to the top level, in the removal\'s own transaction', () => {
    const m = new Model();
    m.create('Package', { id: 'F' });
    m.create('PartUsage', { id: 'E', ownerId: 'F' });
    m.create('PartUsage', { id: 'G', ownerId: 'E' });
    const batches: string[][] = [];
    m.subscribe((evts) => batches.push(evts.map((ev) => `${ev.type}:${ev.id}`)));
    expect(m.remove('F', { cascade: false })).toEqual(['F']);
    expect(m.get('E')!.ownerId).toBeNull();
    expect(m.get('G')!.ownerId).toBe('E'); // only the removed owner's own children move
    expect(m.rootIds()).toEqual(['E']);
    expect(batches, 'one notification: the move, then the removal').toEqual([['reparent:E', 'remove:F']]);
    // No owner is missing in a snapshot of it.
    const copy = Model.fromJSON(m.toJSON());
    expect(copy.all().every((e) => e.ownerId === null || copy.has(e.ownerId))).toBe(true);
    // The default still cascades.
    m.create('Package', { id: 'H' });
    m.create('PartUsage', { id: 'K', ownerId: 'H' });
    expect(m.remove('H').sort()).toEqual(['H', 'K']);
  });

  // The children of an edge that goes with a removed element (default cascade) used to stay under an owner nobody has,
  // invisible in the tree and in the saved text; they go to the top level, as a room reads them on every peer.
  it('moves what a relationship removed with its element owned to the top level', () => {
    const m = new Model();
    m.create('Package', { id: 'P' });
    m.create('PartUsage', { id: 'A', ownerId: 'P' });
    m.create('PartUsage', { id: 'B', ownerId: 'P' });
    m.create('ConnectionUsage', { id: 'C', ownerId: 'P', source: ['A'], target: ['B'] });
    m.create('AttributeUsage', { id: 'K', ownerId: 'C' });
    expect(m.remove('A').sort()).toEqual(['A', 'C']);
    expect(m.get('K')!.ownerId).toBeNull();
    expect(m.rootIds().sort()).toEqual(['K', 'P']);
  });

  it('does not hand the kept children back to an owner made again with the same id in one transaction', () => {
    const m = new Model();
    m.create('Package', { id: 'F' });
    m.create('PartUsage', { id: 'E', ownerId: 'F' });
    m.transaction(() => {
      m.remove('F', { cascade: false });
      m.create('Package', { id: 'F' });
    });
    // Before: a plain model kept E under the new F (a room moved it out, on every peer). Now both read E at the top level.
    expect(m.get('E')!.ownerId).toBeNull();
    expect(m.childIds('F')).toEqual([]);
    expect(m.rootIds().sort()).toEqual(['E', 'F']);
  });

  // A Redefinition whose target goes but whose feature stays is not a dangling edge to drop: the feature redefines the
  // nearest feature the removed one redefined, which is where the redefinition rule lands it on the next parse.
  it('moves a redefinition off a removed target to the nearest feature that stays', () => {
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    const attr = (name: string | undefined, ownerId: string) => m.create('AttributeUsage', { declaredName: name, ownerId });
    const redefine = (from: string, to: string) =>
      m.create('Redefinition', { ownerId: from, source: [from], target: [to] });
    const q = m.create('PartDefinition', { declaredName: 'Q', ownerId: pkg.id });
    const q2 = m.create('PartDefinition', { declaredName: 'Q2', ownerId: pkg.id });
    const q3 = m.create('PartDefinition', { declaredName: 'Q3', ownerId: pkg.id });
    const base = attr('M', q.id);
    const mid = attr(undefined, q2.id);
    const top = attr(undefined, q3.id);
    redefine(mid.id, base.id);
    redefine(top.id, mid.id);
    const s = m.create('PartUsage', { declaredName: 's', ownerId: pkg.id });
    const own = attr(undefined, s.id);
    const edge = redefine(own.id, top.id);
    const targetOf = (id: string) => m.get(id)?.target;
    // Q3's and Q2's features go in turn: s's redefinition follows the chain down to Q's M.
    m.remove(top.id);
    expect(targetOf(edge.id)).toEqual([mid.id]);
    m.remove(mid.id);
    expect(targetOf(edge.id)).toEqual([base.id]);
    // Both go at once, with their definitions: the nearest that stays.
    const m2 = new Model();
    const p2 = m2.create('Package', { declaredName: 'P' });
    const a = m2.create('AttributeUsage', { declaredName: 'M', ownerId: p2.id });
    const d1 = m2.create('PartDefinition', { declaredName: 'D1', ownerId: p2.id });
    const d2 = m2.create('PartDefinition', { declaredName: 'D2', ownerId: p2.id });
    const f1 = m2.create('AttributeUsage', { ownerId: d1.id });
    const f2 = m2.create('AttributeUsage', { ownerId: d2.id });
    m2.create('Redefinition', { ownerId: f1.id, source: [f1.id], target: [a.id] });
    m2.create('Redefinition', { ownerId: f2.id, source: [f2.id], target: [f1.id] });
    const u = m2.create('AttributeUsage', { ownerId: p2.id });
    const e2 = m2.create('Redefinition', { ownerId: u.id, source: [u.id], target: [f2.id] });
    m2.remove(d1.id);
    expect(m2.get(e2.id)?.target).toEqual([f2.id]);
    m2.remove(d2.id);
    expect(m2.get(e2.id)?.target).toEqual([a.id]);
    // A target that redefined nothing takes the redefinition with it, as before.
    const d3 = m2.create('PartDefinition', { declaredName: 'D3', ownerId: p2.id });
    const f3 = m2.create('AttributeUsage', { ownerId: d3.id });
    const e3 = m2.create('Redefinition', { ownerId: u.id, source: [u.id], target: [f3.id] });
    m2.remove(d3.id);
    expect(m2.has(e3.id)).toBe(false);
    expect(m2.has(u.id)).toBe(true);
  });

  // A cycle a -> b -> a is an invalid model, but deleting a must not leave `b :>> b`: the walk up from a lands on b
  // itself, which is no survivor, so b's redefinition goes with a.
  it('drops the redefinition of a cycle member whose only way up leads back to itself', () => {
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    const d = m.create('PartDefinition', { declaredName: 'D', ownerId: pkg.id });
    const a = m.create('AttributeUsage', { declaredName: 'a', ownerId: d.id });
    const b = m.create('AttributeUsage', { declaredName: 'b', ownerId: d.id });
    const ab = m.create('Redefinition', { ownerId: a.id, source: [a.id], target: [b.id] });
    const ba = m.create('Redefinition', { ownerId: b.id, source: [b.id], target: [a.id] });
    m.remove(a.id);
    expect(m.has(ab.id)).toBe(false);
    expect(m.has(ba.id)).toBe(false);
    expect(m.has(b.id)).toBe(true);
    expect(m.all().filter((e) => e.eClass === 'Redefinition' && (e.target ?? []).includes(b.id) && (e.source ?? []).includes(b.id))).toEqual([]);
  });

  // A listener that follows what an element inherits (the editor, which settles redefinitions after an edit) passes
  // over a change of `attrs` alone, and asks the ends a relationship had when one moved.
  it('names what an update changed, and the ends a relationship had', () => {
    const m = new Model();
    const a = m.create('PartDefinition', { declaredName: 'A' });
    const b = m.create('PartDefinition', { declaredName: 'B' });
    const rel = m.create('Specialization', { ownerId: a.id, source: [a.id], target: [b.id] });
    const events: ChangeEvent[] = [];
    m.subscribe((evs) => events.push(...evs));
    m.update(a.id, { declaredName: 'A2' });
    m.update(a.id, { attrs: { note: 'x' } });
    m.setAttrs(a.id, { note: 'y' });
    m.setShortName(a.id, 'a');
    m.update(rel.id, { source: [b.id], target: [a.id] });
    expect(events.map((e) => e.fields)).toEqual([['declaredName'], ['attrs'], ['attrs'], ['declaredShortName'], ['source', 'target']]);
    expect(events.map((e) => e.previousSource)).toEqual([undefined, undefined, undefined, undefined, [a.id]]);
    // ...and the names it had (a rename's old name is no longer in the model), and the target a relationship had.
    expect(events.map((e) => e.previousNames)).toEqual([['A'], undefined, undefined, [], undefined]);
    expect(events.map((e) => e.previousTarget)).toEqual([undefined, undefined, undefined, undefined, [b.id]]);
    m.update(a.id, { declaredName: 'A3' });
    expect(events[events.length - 1]!.previousNames).toEqual(['A2', 'a']);
  });

  // `Model.remove` leaves to its planners what it cannot decide itself: each sees what is about to go, before any is
  // gone, and what it returns runs once they are, in the removal's own notification. It is asked of a removal that
  // leaves a Redefinition standing whose target goes, and of no other.
  it('lets a removal planner see what goes and follow it, in the removal\'s own notification', () => {
    const m = new Model();
    const a = m.create('PartDefinition', { declaredName: 'A' });
    const h = m.create('AttributeUsage', { ownerId: a.id, declaredName: 'h' });
    const f = m.create('AttributeUsage', { ownerId: a.id, declaredName: 'f' });
    m.create('Redefinition', { ownerId: f.id, source: [f.id], target: [h.id] });
    const g = m.create('AttributeUsage', { ownerId: a.id, declaredName: 'g' });
    const redefinition = m.create('Redefinition', { ownerId: g.id, source: [g.id], target: [f.id] });
    const k = m.create('AttributeUsage', { ownerId: a.id, declaredName: 'k' });
    const seen: string[] = [];
    const off = m.addRemovalPlanner((going) => {
      seen.push(`going ${[...going].map((x) => m.get(x)?.declaredName).filter((n) => n !== undefined).sort().join(',')}`);
      return () => {
        seen.push(`gone ${m.has(f.id)}`);
        m.update(g.id, { declaredName: 'g2' });
      };
    });
    const batches: ChangeEvent[][] = [];
    m.subscribe((evs) => batches.push(evs));
    // g's redefinition of f stays: f goes, and Model.remove moves it up the chain to h.
    expect(m.remove(f.id)).toContain(f.id);
    expect(seen).toEqual(['going f', 'gone false']);
    expect(m.get(g.id)!.declaredName).toBe('g2');
    expect(m.get(redefinition.id)!.target).toEqual([h.id]);
    // The removal and what the planner did are one notification.
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.type)).toContain('remove');
    expect(batches[0]!.filter((e) => e.type === 'update').map((e) => e.element?.declaredName)).toEqual([undefined, 'g2']);
    // A removal no Redefinition stands over (k is nobody's target) is not asked about.
    expect(m.remove(k.id)).toEqual([k.id]);
    expect(seen).toHaveLength(2);
    off();
    m.remove(g.id);
    expect(seen).toHaveLength(2);
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

  // The walk of a type's generals asks this once per type it meets; it reads the edge index without copying it.
  it('typesOf gives the targets of the typing and specialization relationships, in order, and no other', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const [a, b, c, x] = ['A', 'B', 'C', 'X'].map((n) => f.partDef(n));
    f.subclassification(c!.id, a!.id);
    const typing = m.create('FeatureTyping', { ownerId: c!.id, source: [c!.id], target: ['gone', b!.id] });
    f.allocate(c!.id, x!.id);
    expect(m.typesOf(c!.id).map((t) => t.declaredName)).toEqual(['A', 'B']);
    expect(m.typesOf(a!.id)).toEqual([]);
    // It follows an edit of the edges, and a removal.
    m.update(typing.id, { target: [x!.id, b!.id] });
    expect(m.typesOf(c!.id).map((t) => t.declaredName)).toEqual(['A', 'X', 'B']);
    m.remove(typing.id);
    expect(m.typesOf(c!.id).map((t) => t.declaredName)).toEqual(['A']);
  });

  // The page lists a relationship an edit adds after the ones the element had. The lists the page shows read a fixed
  // order (the `:>` family, typings, redefinitions), so they do not change on a save and reopen.
  it('typesInBindOrder and specializationsFrom list one element\'s relationships in a fixed order, the same after a save and reopen', async () => {
    const base = 'package W { part def D; part def D2; part v; part s; part y; }';
    const kinds = { T: ['FeatureTyping', 'D'], T2: ['FeatureTyping', 'D2'], S: ['Subsetting', 's'], R: ['Redefinition', 'v'] } as const;
    const named = (m: Model, n: string) => m.all().find((e) => e.declaredName === n)!;
    const orders = ['T S', 'S T', 'T R', 'R T', 'T S R', 'S T R', 'R T S', 'T T2 S', 'T2 S T R'];
    const read = (m: Model) => {
      const y = named(m, 'y').id;
      return { types: m.typesInBindOrder(y).map((t) => t.declaredName), specs: m.specializationsFrom(y).map((r) => r.eClass[0] + '>' + (r.target ?? []).map((t) => m.get(t)?.declaredName)) };
    };
    for (const order of orders) {
      const page = (await loadModelText(base, { fileName: 'm.sysml', library: 'none' })).model!;
      const y = named(page, 'y');
      for (const k of order.split(' ') as Array<keyof typeof kinds>) {
        page.create(kinds[k][0], { ownerId: y.id, source: [y.id], target: [named(page, kinds[k][1]).id] });
      }
      page.adoptSerialOrder();
      const saved = serializeUserModelSignals(page).text;
      const terminal = (await loadModelText(saved, { fileName: 'm.sysml', library: 'none' })).model!;
      expect(read(page), `${order}: ${saved}`).toEqual(read(terminal));
    }
    // The order itself: the `:>` family first, then typings, then redefinitions, each as the model lists them.
    const m = (await loadModelText(base, { fileName: 'm.sysml', library: 'none' })).model!;
    const y = named(m, 'y');
    for (const k of ['R', 'T', 'T2', 'S'] as const) m.create(kinds[k][0], { ownerId: y.id, source: [y.id], target: [named(m, kinds[k][1]).id] });
    expect(read(m)).toEqual({ types: ['s', 'D', 'D2', 'v'], specs: ['S>s', 'F>D', 'F>D2', 'R>v'] });
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

  /**
   * Between owners too. A terminal reads the text Save writes from top to
   * bottom, but a package dragged out of its owner and back in stayed where it
   * was in `all()`, and a machine made in a package above another machine's was
   * listed after it: the page and the checks worker walked the machines in the
   * order they were added, a terminal in the text's (review 2026-10-14 D-1, its
   * S2 review). `adoptSerialOrder` lists the user's declarations in containment
   * pre-order, and what a load lists after them where a load lists it.
   */
  describe('listed in the order the text gives it after an edit (D-1, its S2 review)', () => {
    const names = (m: Model): string[] => m.all().map((e) => e.declaredName ?? `«${e.eClass}»`);
    const machines = (m: Model): string[] => m.all().filter((e) => e.eClass === 'StateDefinition').map((e) => e.declaredName!);
    /** Every copy — Save then open, the checks worker's, an Undo snapshot — is rebuilt in the order the page lists the model. */
    const listedAsCopies = (m: Model): boolean => {
      const listed = m.inSerialOrder();
      const copy = Model.fromJSON(m.toJSON());
      return m.all().every((el, i) => el === listed[i] && copy.all()[i].id === el.id) && copy.size === m.size;
    };

    /** `P { package Q1 { state def M1 {…} } package Q2 { state def M2 {…} } }` as a load lists it, and a library after it. */
    function owners() {
      const m = new Model();
      const P = m.create('Package', { declaredName: 'P' });
      const machine = (pkg: string, def: string, [s, t]: [string, string]) => {
        const Q = m.create('Package', { declaredName: pkg, ownerId: P.id });
        const M = m.create('StateDefinition', { declaredName: def, ownerId: Q.id });
        const a = m.create('StateUsage', { declaredName: s, ownerId: M.id });
        const b = m.create('StateUsage', { declaredName: t, ownerId: M.id });
        m.create('TransitionUsage', { declaredName: `${s}${t}`, ownerId: M.id, source: [a.id], target: [b.id] });
        return Q;
      };
      const Q1 = machine('Q1', 'M1', ['a', 'b']);
      const Q2 = machine('Q2', 'M2', ['x', 'y']);
      const lib = m.create('Package', { declaredName: 'Lib', attrs: { isLibrary: true } });
      m.create('DataType', { declaredName: 'Real', ownerId: lib.id, attrs: { isLibrary: true } });
      expect(m.adoptSerialOrder(), 'listed as a load lists it: nothing to move').toBe(false);
      return { m, P, Q1, Q2 };
    }

    it('a package dragged out and back in, and a machine made above another, are listed where the text puts them, as every copy lists them', () => {
      const dragged = owners();
      dragged.m.reparent(dragged.Q1.id, null);
      dragged.m.reparent(dragged.Q1.id, dragged.P.id);
      expect(machines(dragged.m), 'as added').toEqual(['M1', 'M2']);
      const rev = dragged.m.rev;
      expect(dragged.m.adoptSerialOrder()).toBe(true);
      expect(dragged.m.rev, 'an index built at the move is built again').toBeGreaterThan(rev);
      // Q1 is P's last child now: the text writes Q2 and its machine first.
      expect(names(dragged.m)).toEqual(['P', 'Q2', 'M2', 'x', 'y', 'xy', 'Q1', 'M1', 'a', 'b', 'ab', 'Lib', 'Real']);
      expect(listedAsCopies(dragged.m)).toBe(true);
      expect(dragged.m.adoptSerialOrder(), 'once is enough').toBe(false);

      const made = owners();
      const M0 = made.m.create('StateDefinition', { declaredName: 'M0', ownerId: made.Q1.id });
      made.m.create('StateUsage', { declaredName: 'u', ownerId: M0.id });
      expect(machines(made.m), 'as added: after the library, too').toEqual(['M1', 'M2', 'M0']);
      expect(made.m.adoptSerialOrder()).toBe(true);
      // M0 is Q1's last child, above Q2: where Save writes it, and where a terminal reads it.
      expect(names(made.m)).toEqual(['P', 'Q1', 'M1', 'a', 'b', 'ab', 'M0', 'u', 'Q2', 'M2', 'x', 'y', 'xy', 'Lib', 'Real']);
      expect(listedAsCopies(made.m)).toBe(true);
    });

    it('a declaration an edit adds below a typing is seated before it, and what a load lists after the declarations stays where the load listed it', () => {
      const m = new Model();
      const P = m.create('Package', { declaredName: 'P' });
      const T = m.create('PartDefinition', { declaredName: 'T', ownerId: P.id });
      const x = m.create('PartUsage', { declaredName: 'x', ownerId: P.id });
      const y = m.create('PartUsage', { declaredName: 'y', ownerId: P.id });
      // As a load makes them, once every name is known: `x : T`, `y : T`, and a port made for a connector end chained through y's type.
      const tx = m.create('FeatureTyping', { ownerId: x.id, source: [x.id], target: [T.id] });
      const ty = m.create('FeatureTyping', { ownerId: y.id, source: [y.id], target: [T.id] });
      const q = m.create('PortUsage', { declaredName: 'q', ownerId: y.id, attrs: { implicit: true } });
      expect(m.adoptSerialOrder(), 'as a load lists it').toBe(false);
      const typedByT = (): Array<string | undefined> => m.edgesTo(T.id).map((e) => m.get(e.source![0])!.declaredName);

      // A part made in P goes where the text puts it, among the declarations; the typings and the port stay after them.
      m.create('PartUsage', { declaredName: 'w', ownerId: P.id });
      expect(m.adoptSerialOrder()).toBe(true);
      expect(names(m)).toEqual(['P', 'T', 'x', 'y', 'w', '«FeatureTyping»', '«FeatureTyping»', 'q']);

      // A part made in y and a doc in x, each below its owner's typing: each is seated before it, where a terminal over
      // the saved text holds it, and the typings stay in the order the load listed them, as a terminal lists them.
      const n = m.create('PartUsage', { declaredName: 'n', ownerId: y.id });
      const d = m.create('Documentation', { ownerId: x.id, attrs: { body: 'note' } });
      expect(m.adoptSerialOrder()).toBe(true);
      expect(names(m)).toEqual(['P', 'T', 'x', '«Documentation»', 'y', 'n', 'w', '«FeatureTyping»', '«FeatureTyping»', 'q']);
      expect(m.childIds(x.id)).toEqual([d.id, tx.id]);
      expect(m.childIds(y.id)).toEqual([n.id, ty.id, q.id]);
      expect(typedByT(), 'where-used over T').toEqual(['x', 'y']);
      expect(listedAsCopies(m), 'each owner\'s children still in the order it holds them').toBe(true);
      expect(Model.fromJSON(m.toJSON()).childIds(y.id)).toEqual(m.childIds(y.id));

      // A part dragged into x, below its typing: seated the same way.
      const w = m.all().find((e) => e.declaredName === 'w')!;
      m.reparent(w.id, x.id);
      expect(m.adoptSerialOrder()).toBe(true);
      expect(m.childIds(x.id)).toEqual([d.id, w.id, tx.id]);
      expect(names(m)).toEqual(['P', 'T', 'x', '«Documentation»', 'w', 'y', 'n', '«FeatureTyping»', '«FeatureTyping»', 'q']);
      expect(typedByT()).toEqual(['x', 'y']);
      expect(listedAsCopies(m)).toBe(true);
    });

    it('re-lists whole a model reset from data that lists it in the order its elements were added', () => {
      // An earlier build's: `n` made in y after the load, below y's typing, and listed last.
      const built = new Model();
      const P = built.create('Package', { declaredName: 'P' });
      const T = built.create('PartDefinition', { declaredName: 'T', ownerId: P.id });
      const x = built.create('PartUsage', { declaredName: 'x', ownerId: P.id });
      const y = built.create('PartUsage', { declaredName: 'y', ownerId: P.id });
      built.create('FeatureTyping', { ownerId: x.id, source: [x.id], target: [T.id] });
      const ty = built.create('FeatureTyping', { ownerId: y.id, source: [y.id], target: [T.id] });
      const n = built.create('PartUsage', { declaredName: 'n', ownerId: y.id });
      const data = built.toJSON();

      const m = new Model();
      m.reset(data);
      expect(m.childIds(y.id), 'as the data holds it').toEqual([ty.id, n.id]);
      expect(m.adoptSerialOrder({ whole: true })).toBe(true);
      expect(m.childIds(y.id), 'as a terminal over the saved text holds it').toEqual([n.id, ty.id]);
      expect(names(m)).toEqual(['P', 'T', 'x', 'y', 'n', '«FeatureTyping»', '«FeatureTyping»']);
      expect(m.edgesTo(T.id).map((e) => m.get(e.source![0])!.declaredName)).toEqual(['x', 'y']);
      expect(listedAsCopies(m)).toBe(true);
      // Listed so, it is listed already: a snapshot of it, or a load, moves nothing.
      expect(m.adoptSerialOrder({ whole: true })).toBe(false);
      const again = new Model();
      again.reset(m.toJSON());
      expect(again.adoptSerialOrder({ whole: true })).toBe(false);
    });

    it('costs nothing after an edit that adds no declaration and moves nothing, and keeps the order a reset gives until one does', () => {
      const { m, Q1, Q2 } = owners();
      const all = vi.spyOn(m, 'all');
      const serial = vi.spyOn(m, 'inSerialOrder');
      m.rename(Q1.id, 'R1');
      m.setAttrs(Q2.id, { note: 'kept' });
      m.create('Subsetting', { ownerId: Q2.id, source: [Q2.id], target: [Q1.id] });
      m.remove(m.all().find((e) => e.declaredName === 'xy')!.id);
      all.mockClear();
      expect(m.adoptSerialOrder()).toBe(false);
      expect(all).not.toHaveBeenCalled();
      expect(serial).not.toHaveBeenCalled();
      all.mockRestore();
      serial.mockRestore();

      // A reset lists the model as it is given — a load's order, or a snapshot's; here the library first — and an
      // edit that adds nothing keeps it. (Each owner's children come back in the order they are listed in.)
      const data = m.toJSON();
      const given = [...data.elements.filter((e) => e.attrs.isLibrary === true), ...data.elements.filter((e) => e.attrs.isLibrary !== true)];
      m.reset({ ...data, elements: given });
      m.rename(Q2.id, 'R2');
      expect(m.adoptSerialOrder()).toBe(false);
      expect(m.all().map((e) => e.id)).toEqual(given.map((e) => e.id));
      m.create('StateUsage', { declaredName: 'z', ownerId: m.all().find((e) => e.declaredName === 'M2')!.id });
      expect(m.adoptSerialOrder()).toBe(true);
      expect(names(m).slice(0, 3), 'the text order once an edit adds a declaration: the user\'s part first').toEqual(['P', 'R1', 'M1']);
      // The rest — the library, and the subsetting a load lists after every declaration — in the order it was given.
      expect(names(m).slice(-3)).toEqual(['Lib', 'Real', '«Subsetting»']);
    });

    /**
     * A collaboration room holds each owner's children in the order the peer
     * who made an edit holds them (`src/collab/model-doc.ts`): `orderChildren`
     * takes that order, seated as the edit's `adoptSerialOrder` seated it, and
     * every change to how an owner's children are held — that, a seat, a kind
     * changed — is announced, so the room is told (collab-order S2).
     */
    it('holds an owner\'s children in a given order, seated as an edit seats them, and announces every change to that order', () => {
      const m = new Model();
      const P = m.create('Package', { declaredName: 'P' });
      const Q = m.create('Package', { declaredName: 'Q' });
      const T = m.create('PartDefinition', { declaredName: 'T', ownerId: P.id });
      const a = m.create('PartUsage', { declaredName: 'a', ownerId: P.id });
      const b = m.create('PartUsage', { declaredName: 'b', ownerId: P.id });
      const c = m.create('PartUsage', { declaredName: 'c', ownerId: P.id });
      const tc = m.create('FeatureTyping', { ownerId: c.id, source: [c.id], target: [T.id] });
      const lib = m.create('Package', { declaredName: 'Lib', attrs: { isLibrary: true } });
      const real = m.create('DataType', { declaredName: 'Real', ownerId: lib.id, attrs: { isLibrary: true } });
      const libTyping = m.create('FeatureTyping', { ownerId: lib.id, source: [lib.id], target: [real.id], attrs: { isLibrary: true } });
      m.adoptSerialOrder({ whole: true });
      const orders: Array<string | null | undefined> = [];
      m.subscribe((evts) => {
        for (const e of evts) if (e.type === 'order') orders.push(e.ownerId);
      });

      // Those named, in that order, then the rest as they were held; an id that is not a child is passed over.
      expect(m.orderChildren(P.id, [c.id, 'nope', a.id])).toBe(true);
      expect(m.childIds(P.id)).toEqual([c.id, a.id, T.id, b.id]);
      expect(orders).toEqual([P.id]);
      expect(m.orderChildren(P.id, [c.id, a.id, T.id, b.id]), 'as held already').toBe(false);
      expect(orders, 'nothing to announce').toEqual([P.id]);
      expect(m.adoptSerialOrder(), 're-listed in the order it now holds them').toBe(true);
      expect(names(m).slice(0, 6)).toEqual(['P', 'c', 'a', 'T', 'b', 'Q']);
      expect(m.all().every((el, i) => el === m.inSerialOrder()[i])).toBe(true);

      // An owner of the user's is seated as an edit seats it: a doc given after c's typing goes before it.
      const d = m.create('Documentation', { ownerId: c.id, attrs: { body: 'note' } });
      m.adoptSerialOrder();
      expect(m.childIds(c.id)).toEqual([d.id, tc.id]);
      orders.length = 0;
      expect(m.orderChildren(c.id, [tc.id, d.id]), 'the order a peer wrote before it seated it: held seated').toBe(false);
      expect(m.childIds(c.id)).toEqual([d.id, tc.id]);
      expect(orders).toEqual([]);
      // The top level and the library's owners are not seated.
      expect(m.orderChildren(null, [Q.id, lib.id, P.id])).toBe(true);
      expect(m.rootIds()).toEqual([Q.id, lib.id, P.id]);
      expect(m.orderChildren(lib.id, [libTyping.id, real.id])).toBe(true);
      expect(m.childIds(lib.id)).toEqual([libTyping.id, real.id]);
      expect(orders).toEqual([null, lib.id]);

      // A seat that moves an owner's children is announced.
      orders.length = 0;
      const e = m.create('PartUsage', { declaredName: 'e', ownerId: c.id });
      expect(m.childIds(c.id)).toEqual([d.id, tc.id, e.id]);
      m.adoptSerialOrder();
      expect(m.childIds(c.id)).toEqual([d.id, e.id, tc.id]);
      expect(orders).toEqual([c.id]);

      // So is a kind changed between a declaration and one a load lists later — and the owner is seated either way.
      orders.length = 0;
      m.setAttrs(a.id, { implicit: true });
      expect(orders).toEqual([P.id]);
      m.adoptSerialOrder();
      expect(m.childIds(P.id), 'listed later now: after the declarations, as a load holds it').toEqual([c.id, T.id, b.id, a.id]);
      m.setAttrs(a.id, { implicit: undefined });
      m.adoptSerialOrder();
      expect(m.childIds(P.id)).toEqual([c.id, T.id, b.id, a.id]);
      expect(orders).toEqual([P.id, P.id, P.id]);
      expect(m.all().every((el, i) => el === m.inSerialOrder()[i])).toBe(true);

      // An element of the library's under an owner of the user's — the SDK puts one where it is asked — is held with
      // what a load lists later, after the declarations: an edit adds it without a seat, a declaration added after it
      // is seated before it, and a declaration given the library flag is seated after the others; `orderChildren`
      // seats each as the edit did, so a peer holds them so.
      orders.length = 0;
      const libU = m.create('DataType', { declaredName: 'libU', ownerId: c.id, attrs: { isLibrary: true } });
      m.adoptSerialOrder();
      expect(m.childIds(c.id), 'added last, behind the typing').toEqual([d.id, e.id, tc.id, libU.id]);
      expect(m.orderChildren(c.id, m.childIds(c.id)), 'held seated as the edit left it').toBe(false);
      const f = m.create('PartUsage', { declaredName: 'f', ownerId: c.id });
      m.adoptSerialOrder();
      expect(m.childIds(c.id), 'a declaration after it: seated before it').toEqual([d.id, e.id, f.id, tc.id, libU.id]);
      expect(orders).toEqual([c.id]);
      m.setAttrs(e.id, { isLibrary: true });
      m.adoptSerialOrder();
      expect(m.childIds(c.id), 'the library flag set: after the declarations').toEqual([d.id, f.id, e.id, tc.id, libU.id]);
      expect(orders).toEqual([c.id, c.id, c.id]);
      expect(m.orderChildren(c.id, [d.id, e.id, f.id, tc.id, libU.id]), 'a peer that held it among them: seated so').toBe(false);
      expect(m.all().every((el, i) => el === m.inSerialOrder()[i])).toBe(true);
    });
  });

  // `remove` finds the edges that name a removed element through an index kept by every edit (a loop of removals
  // does not scan the model each time). The scan it replaced: every element in the order of the map, an edge that
  // names a member of the set so far joining it, repeated while the set grows — so an edge the map lists BEFORE an
  // edge that goes with the removal and names it goes too, and none keeps an endpoint naming a removed element.
  describe('remove finds the dangling edges as a scan of every element does (275)', () => {
    const scanned = (m: Model, id: string, cascade: boolean): string[] => {
      const gone = new Set<string>([id]);
      if (cascade) for (const d of m.descendants(id)) gone.add(d.id);
      let grew = true;
      while (grew) {
        grew = false;
        for (const r of m.all()) {
          if (gone.has(r.id)) continue;
          if ([...(r.source ?? []), ...(r.target ?? [])].some((ref) => gone.has(ref))) {
            gone.add(r.id);
            grew = true;
          }
        }
      }
      return [...gone];
    };

    it('an edge listed before the edge it names goes with it (no endpoint names a removed element)', () => {
      const m = new Model();
      const a = m.create('PartUsage', { declaredName: 'a' });
      const b = m.create('PartUsage', { declaredName: 'b' });
      m.create('Succession', { id: 'c2', source: ['c1'], target: [b.id] });
      m.create('Succession', { id: 'c1', source: [a.id], target: [b.id] });
      expect(m.remove(a.id).sort()).toEqual([a.id, 'c1', 'c2'].sort());
      for (const el of m.all()) for (const ref of [...(el.source ?? []), ...(el.target ?? [])]) expect(m.has(ref), el.id).toBe(true);
    });

    it('a patch that cannot be copied leaves the index as it was', () => {
      const m = new Model();
      const a = m.create('PartUsage', { declaredName: 'a' });
      const z = m.create('PartUsage', { declaredName: 'z' });
      const e = m.create('Dependency', { source: [a.id], target: [z.id] });
      m.remove(m.create('PartUsage', { declaredName: 'tmp' }).id); // builds the index
      expect(() => m.update(e.id, { source: 5 as unknown as string[] })).toThrow();
      expect(m.get(e.id)!.source).toEqual([a.id]);
      expect(m.remove(a.id).sort()).toEqual([a.id, e.id].sort());
    });

    it('removes the same elements in the same order over random edits, whichever edit kept the index', () => {
      let state = 0x9e3779b9;
      const rnd = (n: number): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return Math.floor((state / 2 ** 32) * n);
      };
      let removals = 0;
      let edgesToEdges = 0;
      for (let seq = 0; seq < 150; seq++) {
        const m = new Model();
        const ids: string[] = [];
        const live = (): string[] => ids.filter((i) => m.has(i));
        for (let step = 0; step < 60; step++) {
          const alive = live();
          const op = rnd(10);
          if (alive.length < 3 || op < 3) {
            ids.push(m.create('PartUsage', { declaredName: `p${step}`, ownerId: alive.length > 0 && rnd(2) ? alive[rnd(alive.length)]! : null }).id);
          } else if (op < 6) {
            // An edge between any two elements, an edge among them, owned or not.
            const [a, b] = [alive[rnd(alive.length)]!, alive[rnd(alive.length)]!];
            const e = m.create('Dependency', { source: [a], target: rnd(3) === 0 ? [b, alive[rnd(alive.length)]!] : [b] });
            if (m.get(a)!.source || m.get(b)!.target) edgesToEdges++;
            ids.push(e.id);
          } else if (op < 7) {
            const e = alive.find((i) => m.get(i)!.source !== undefined);
            if (e !== undefined) m.update(e, rnd(2) ? { target: [alive[rnd(alive.length)]!] } : { source: [alive[rnd(alive.length)]!] });
          } else if (op < 8 && removals % 3 === 0) {
            m.reset(m.toJSON());
          } else {
            const id = alive[rnd(alive.length)]!;
            const cascade = rnd(4) !== 0;
            const want = scanned(m, id, cascade);
            expect(m.remove(id, { cascade }), `seq ${seq} step ${step}`).toEqual(want);
            removals++;
          }
        }
      }
      expect(removals).toBeGreaterThan(500);
      expect(edgesToEdges).toBeGreaterThan(50);
    });

    it('a loop of removals does not scan the model each time', () => {
      const m = new Model();
      const pkg = m.create('Package', { declaredName: 'P' });
      for (let i = 0; i < 20000; i++) m.create('PartUsage', { declaredName: `p${i}`, ownerId: pkg.id });
      const reds: string[] = [];
      for (let i = 0; i < 2000; i++) reds.push(m.create('Dependency', { source: [pkg.id], target: [pkg.id] }).id);
      const t0 = Date.now();
      for (const r of reds) expect(m.remove(r)).toEqual([r]);
      // 2000 scans of 22000 elements took about 1.5 s; the index does it in a few ms (the bound leaves a loaded machine room).
      expect(Date.now() - t0).toBeLessThan(500);
    });
  });
});

// The specialization-cycle rule reads the components of the graph, not every simple path from each element.
describe('specialization-cycle — the same findings as a walk of every simple path, at the cost of the edges', () => {
  /** The rule as it was written: every simple path from each element, first closing edge reported. */
  function everyPath(adj: number[][]): Array<'itself' | 'cycle' | null> {
    return adj.map((_, start) => {
      const path = new Set<number>([start]);
      const stack = [{ id: start, idx: 0 }];
      while (stack.length) {
        const frame = stack[stack.length - 1]!;
        const next = adj[frame.id]!;
        if (frame.idx >= next.length) {
          stack.pop();
          path.delete(frame.id);
          continue;
        }
        const t = next[frame.idx++]!;
        if (t === start) return frame.id === start ? 'itself' : 'cycle';
        if (path.has(t)) continue;
        path.add(t);
        stack.push({ id: t, idx: 0 });
      }
      return null;
    });
  }

  it('reads what a walk of every simple path read, on 300 random graphs (self-loops, back edges, duplicates)', () => {
    let seed = 12345;
    const rnd = (n: number): number => Math.floor(((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * n);
    let flagged = 0;
    for (let g = 0; g < 300; g++) {
      const n = 2 + rnd(6);
      const adj: number[][] = Array.from({ length: n }, () => []);
      const edges = rnd(n * 2 + 1);
      for (let e = 0; e < edges; e++) adj[rnd(n)]!.push(rnd(n));
      const m = new Model();
      const f = new ModelFactory(m);
      const p = f.pkg('P');
      const els = adj.map((_, i) => f.partDef(`A${i}`, p.id));
      // Edges are created per source in the order its list gives them.
      for (let i = 0; i < n; i++) for (const t of adj[i]!) m.create('Subsetting', { ownerId: els[i]!.id, source: [els[i]!.id], target: [els[t]!.id] });
      const got = new Map(RULES_BY_ID.get('specialization-cycle')!.run(m).map((d) => [d.elementId, d.message.includes('itself') ? 'itself' : 'cycle']));
      const want = everyPath(adj);
      for (let i = 0; i < n; i++) expect(got.get(els[i]!.id) ?? null, `graph ${g} element ${i}: ${JSON.stringify(adj)}`).toBe(want[i]);
      flagged += want.filter((w) => w !== null).length;
    }
    expect(flagged).toBeGreaterThan(300);
  });

  it('is linear in the edges: a layered diamond of 12 layers of 12 and a full DAG of 40 finish at once', () => {
    const t0 = Date.now();
    for (const [layers, width] of [[12, 12], [40, 1]] as const) {
      const m = new Model();
      const f = new ModelFactory(m);
      const p = f.pkg('P');
      const layer = (l: number): ElementRecord[] => Array.from({ length: l === 0 && width === 1 ? 1 : width }, (_, k) => f.partDef(`N${l}_${k}`, p.id));
      const all = Array.from({ length: layers }, (_, l) => layer(l));
      // width 12: each element subsets the whole layer above; width 1: each subsets every element above it.
      for (let l = 1; l < layers; l++) {
        for (const el of all[l]!) {
          for (const up of width === 1 ? all.slice(0, l).flat() : all[l - 1]!) m.create('Subsetting', { ownerId: el.id, source: [el.id], target: [up.id] });
        }
      }
      expect(RULES_BY_ID.get('specialization-cycle')!.run(m)).toHaveLength(0);
    }
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

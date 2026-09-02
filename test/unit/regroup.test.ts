/**
 * planRegroup — the Regroup Workbench engine (Phase 1: pure/read-only preview).
 * Pins the boundary-detection algorithm: which connections become EXTERNAL
 * interfaces under a proposed re-bundling, which stay internal, and which
 * delegation ports would be synthesized — plus the Louvain cluster seeding.
 */
import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, buildSampleModel } from '@core/index';
import {
  planRegroup,
  defaultRegroupConfig,
  endpointToPart,
  seedRegroupFromClusters,
  seedRegroupFromNodeIds,
  proposedPortKey,
} from '@diagram/index';
import type { RegroupConfig } from '@diagram/index';

/**
 * Chain a—b—c—d: four PartUsages each carrying a PortUsage, connected
 * aP–bP, bP–cP, cP–dP. b's port is `out`, c's port is `in` (direction pins).
 */
function chain() {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('Sys');
  const mk = (name: string, direction?: 'in' | 'out') => {
    const part = f.part(name, pkg.id);
    const port = f.port(`${name}P`, part.id, direction ? { direction } : {});
    return { part, port };
  };
  const a = mk('a');
  const b = mk('b', 'out');
  const c = mk('c', 'in');
  const d = mk('d');
  const ab = f.connect(a.port.id, b.port.id, { name: 'ab', ownerId: pkg.id });
  const bc = f.connect(b.port.id, c.port.id, { name: 'bc', ownerId: pkg.id });
  const cd = f.connect(c.port.id, d.port.id, { name: 'cd', ownerId: pkg.id });
  return { m, f, pkg, a, b, c, d, ab, bc, cd };
}

const cfg = (over: Partial<RegroupConfig> = {}): RegroupConfig => ({
  ...defaultRegroupConfig(),
  ...over,
});

const B1 = { id: 'new:0', label: 'Bundle 1', isNew: true };
const B2 = { id: 'new:1', label: 'Bundle 2', isNew: true };

/** {a,b} → B1 and {c,d} → B2, so exactly the b–c connection crosses. */
function splitConfig(s: ReturnType<typeof chain>): RegroupConfig {
  return cfg({
    bundles: [B1, B2],
    membership: {
      [s.a.part.id]: B1.id,
      [s.b.part.id]: B1.id,
      [s.c.part.id]: B2.id,
      [s.d.part.id]: B2.id,
    },
  });
}

describe('endpointToPart', () => {
  it('resolves a port endpoint to its owning part, and a part to itself', () => {
    const s = chain();
    expect(endpointToPart(s.m, s.a.port.id)?.id).toBe(s.a.part.id);
    expect(endpointToPart(s.m, s.b.part.id)?.id).toBe(s.b.part.id);
    // No part-kind ancestor (a Package) / unknown id → undefined.
    expect(endpointToPart(s.m, s.pkg.id)).toBeUndefined();
    expect(endpointToPart(s.m, 'no-such-id')).toBeUndefined();
  });
});

describe('planRegroup — boundary detection', () => {
  it('a connection crossing two bundles yields one boundary entry per bundle', () => {
    const s = chain();
    const plan = planRegroup(s.m, splitConfig(s));
    expect(plan.boundary).toHaveLength(2);
    expect(plan.stats.boundaryCount).toBe(plan.boundary.length);
    const forB1 = plan.boundary.find((e) => e.bundleId === B1.id)!;
    const forB2 = plan.boundary.find((e) => e.bundleId === B2.id)!;
    // Both entries describe the SAME crossing connection b–c.
    expect(forB1.connectionId).toBe(s.bc.id);
    expect(forB2.connectionId).toBe(s.bc.id);
    expect(forB1.connectionKind).toBe('ConnectionUsage');
    // B1's inside is b via endpoint bP; the outside is c via cP.
    expect(forB1.insidePartId).toBe(s.b.part.id);
    expect(forB1.insideEndpointId).toBe(s.b.port.id);
    expect(forB1.insidePartLabel).toBe('b');
    expect(forB1.insideEndpointLabel).toBe('bP');
    expect(forB1.outsidePartId).toBe(s.c.part.id);
    expect(forB1.outsidePartLabel).toBe('c');
    expect(forB1.outsideEndpointLabel).toBe('cP');
    // The proposed delegation port reuses the inside PortUsage name + direction.
    expect(forB1.proposedPortLabel).toBe('bP');
    expect(forB1.proposedPortDirection).toBe('out');
    // Mirrored for B2 (inside c, outside b).
    expect(forB2.insidePartId).toBe(s.c.part.id);
    expect(forB2.insideEndpointId).toBe(s.c.port.id);
    expect(forB2.outsidePartId).toBe(s.b.part.id);
    expect(forB2.proposedPortLabel).toBe('cP');
    expect(forB2.proposedPortDirection).toBe('in');
  });

  it('same-bundle connections are INTERNAL, not boundary', () => {
    const s = chain();
    const plan = planRegroup(s.m, splitConfig(s));
    expect(plan.stats.internalCount).toBe(2); // a–b inside B1, c–d inside B2
    const ids = plan.boundary.map((e) => e.connectionId);
    expect(ids).not.toContain(s.ab.id);
    expect(ids).not.toContain(s.cd.id);
  });

  it('a bundle↔unassigned connection yields a single boundary entry (for the bundle side)', () => {
    const s = chain();
    const plan = planRegroup(
      s.m,
      cfg({ bundles: [B1], membership: { [s.b.part.id]: B1.id } }),
    );
    // b is bundled; a and c are outside → both a–b and b–c cross B1's boundary.
    expect(plan.boundary.map((e) => [e.connectionId, e.bundleId])).toEqual([
      [s.ab.id, B1.id],
      [s.bc.id, B1.id],
    ]);
    expect(plan.stats.internalCount).toBe(0);
    expect(plan.unassigned.map((u) => u.label)).toEqual(['a', 'c', 'd']);
  });

  it('a part-to-part connection proposes a synthetic part_connection port name', () => {
    const s = chain();
    const ad = s.f.connect(s.a.part.id, s.d.part.id, { name: 'ad', ownerId: s.pkg.id });
    const plan = planRegroup(s.m, splitConfig(s));
    const entry = plan.boundary.find(
      (e) => e.connectionId === ad.id && e.bundleId === B1.id,
    )!;
    expect(entry.insideEndpointId).toBe(s.a.part.id); // endpoint IS the part
    expect(entry.proposedPortLabel).toBe('a_ad');
    expect(entry.proposedPortDirection).toBeNull();
  });
});

describe('planRegroup — nested-part membership closure (effective bundles)', () => {
  it('sample model: a nested child part rides along with its assigned ancestor (no bogus boundary)', () => {
    // engine is a CHILD PartUsage of vehicle; fuelLine connects engine.fuelOut
    // → vehicle.fuelIn. Assigning ONLY vehicle→B1 must carry engine along, so
    // the connection stays INTERNAL (regression: a bogus boundary row + a
    // proposed "fuelIn" port used to appear on B1).
    const m = buildSampleModel();
    const vehicle = m
      .all()
      .find((e) => e.eClass === 'PartUsage' && e.declaredName === 'vehicle')!;
    const plan = planRegroup(m, cfg({ bundles: [B1], membership: { [vehicle.id]: B1.id } }));
    expect(plan.boundary).toEqual([]);
    expect(plan.stats.boundaryCount).toBe(0);
    expect(plan.stats.internalCount).toBe(1); // fuelLine is inside B1
  });

  it('a connection from a NESTED part crosses its ancestor bundle → rows for BOTH bundles', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const sys = f.part('sys', pkg.id);
    const sub = f.part('sub', sys.id); // nested, NOT explicitly assigned
    const subP = f.port('subP', sub.id);
    const x = f.part('x', pkg.id);
    const xP = f.port('xP', x.id);
    f.connect(subP.id, xP.id, { name: 'link', ownerId: pkg.id });
    const plan = planRegroup(
      m,
      cfg({ bundles: [B1, B2], membership: { [sys.id]: B1.id, [x.id]: B2.id } }),
    );
    // Regression: B1's row (and its delegation port) was silently missing.
    expect(plan.boundary).toHaveLength(2);
    const b1 = plan.boundary.find((e) => e.bundleId === B1.id)!;
    expect(b1.insidePartId).toBe(sub.id); // the nested part IS the inside side
    expect(b1.proposedPortLabel).toBe('subP');
    expect(plan.bundles[0].proposedPorts.map((p) => p.label)).toEqual(['subP']);
    const b2 = plan.boundary.find((e) => e.bundleId === B2.id)!;
    expect(b2.proposedPortLabel).toBe('xP');
    // Ride-along parts are not member chips and not "moved" — only sys and x.
    expect(plan.bundles[0].members.map((mm) => mm.label)).toEqual(['sys']);
    expect(plan.unassigned.map((mm) => mm.label)).toContain('sub');
    expect(plan.stats.movedCount).toBe(2);
  });

  it('nested new bundles: inner bundle delegates, the OUTER gets no spurious port (nearest wins + hierarchy)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const sys = f.part('sys', pkg.id);
    const sysP = f.port('sysP', sys.id);
    const sub = f.part('sub', sys.id);
    const subP = f.port('subP', sub.id);
    f.connect(sysP.id, subP.id, { name: 'inner', ownerId: pkg.id });
    const plan = planRegroup(
      m,
      cfg({ bundles: [B1, B2], membership: { [sys.id]: B1.id, [sub.id]: B2.id } }),
    );
    // sys→B1, sub→B2 with sub a CHILD of sys: B2's composite lands under sys, so
    // after Apply B2 nests INSIDE B1. The sys–sub connection is thus internal to
    // B1 and only crosses B2 → exactly ONE delegation port (on B2, for subP);
    // the outer B1 gets NONE (regression: it used to get a spurious sysP port).
    expect(plan.boundary).toHaveLength(1);
    expect(plan.boundary[0]).toMatchObject({
      bundleId: B2.id,
      insidePartId: sub.id,
      proposedPortLabel: 'subP',
    });
    expect(plan.stats.internalCount).toBe(0);
    // sub is still classified in B2 (nearest wins) and is a member of it.
    expect(plan.bundles.find((b) => b.id === B2.id)!.members.map((mm) => mm.label)).toEqual([
      'sub',
    ]);
  });

  it('regression (Fable): parent→B1 + child→B2 with a deep connection back to the parent — no outer spurious port', () => {
    // The exact reported input: A at root (port aP), B child of A, C child of B
    // (port cP), connection C.cP – A.aP. A→B1, B→B2. After Apply both C and A sit
    // inside B1's composite, so C.cP–A.aP is INTERNAL to B1 and only crosses B2.
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const A = f.part('A', pkg.id);
    const aP = f.port('aP', A.id);
    const B = f.part('B', A.id);
    const C = f.part('C', B.id);
    const cP = f.port('cP', C.id);
    f.connect(cP.id, aP.id, { name: 'deep', ownerId: pkg.id });
    const plan = planRegroup(
      m,
      cfg({ bundles: [B1, B2], membership: { [A.id]: B1.id, [B.id]: B2.id } }),
    );
    expect(plan.boundary).toHaveLength(1);
    expect(plan.boundary[0]).toMatchObject({ bundleId: B2.id, insidePartId: C.id });
    // Crucially: the OUTER bundle B1 gets no boundary row / port.
    expect(plan.boundary.some((e) => e.bundleId === B1.id)).toBe(false);
    expect(plan.bundles.find((b) => b.id === B1.id)!.proposedPorts).toEqual([]);
  });

  it('multi-level: a deeply-nested part connecting FULLY outside gets a chained port at EACH crossed level', () => {
    // A→B1 (comp1), B (child of A)→B2 (comp2, nested in comp1). C rides into comp2
    // with B; C.cP connects to O, fully outside both bundles → the connection
    // crosses B2 AND B1, so a delegation port is synthesized on EACH, chained.
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const A = f.part('A', pkg.id);
    const B = f.part('B', A.id);
    const C = f.part('C', B.id);
    const cP = f.port('cP', C.id);
    const O = f.part('O', pkg.id);
    const oP = f.port('oP', O.id);
    f.connect(cP.id, oP.id, { name: 'deepOut', ownerId: pkg.id });
    const plan = planRegroup(
      m,
      cfg({ bundles: [B1, B2], membership: { [A.id]: B1.id, [B.id]: B2.id } }),
    );
    // Two boundary rows (both for the C side): the inner level B2, the outer B1.
    expect(plan.boundary).toHaveLength(2);
    const inner = plan.bundles.find((b) => b.id === B2.id)!;
    const outer = plan.bundles.find((b) => b.id === B1.id)!;
    // Inner port binds to the endpoint; outer port chains from the inner one.
    expect(inner.proposedPorts).toHaveLength(1);
    expect(inner.proposedPorts[0]).toMatchObject({ insideEndpointId: cP.id, innerBundleId: null });
    expect(outer.proposedPorts[0]).toMatchObject({ insideEndpointId: cP.id, innerBundleId: B2.id });
    // The connection attaches at the OUTERMOST crossed level (B1).
    const outermost = plan.boundary.filter((e) => e.crossingOutermost);
    expect(outermost).toHaveLength(1);
    expect(outermost[0].bundleId).toBe(B1.id);
  });

  it('membership from another part kind is inert after switching partKind', () => {
    const s = chain();
    // The PartUsage assignments produce a boundary under partKind 'PartUsage'…
    expect(planRegroup(s.m, splitConfig(s)).boundary).toHaveLength(2);
    // …but after switching the facet to ItemUsage they are STALE: the parts are
    // no longer candidates, so no boundary/internal survives (regression: rows
    // used to outlive the switch while the bins showed 0 parts).
    const plan = planRegroup(s.m, { ...splitConfig(s), partKind: 'ItemUsage' });
    expect(plan.stats).toEqual({
      partCount: 0,
      bundleCount: 2,
      movedCount: 0,
      boundaryCount: 0,
      internalCount: 0,
    });
    expect(plan.boundary).toEqual([]);
    expect(plan.bundles.map((b) => b.members)).toEqual([[], []]);
  });

  it('implicit (compiler-materialized) parts are excluded from candidates, facet, and seeding', () => {
    const s = chain();
    const ghost = s.m.create('PartUsage', {
      declaredName: 'ghost',
      ownerId: s.pkg.id,
      attrs: { implicit: true },
    });
    const plan = planRegroup(s.m, cfg());
    expect(plan.unassigned.map((u) => u.label)).not.toContain('ghost');
    expect(plan.partKindsPresent).toEqual([{ eClass: 'PartUsage', count: 4 }]);
    const seeded = seedRegroupFromClusters(s.m, 'PartUsage');
    expect(seeded.membership[ghost.id]).toBeUndefined();
  });
});

describe('planRegroup — bundles / stats', () => {
  it('bundles list their members and deduplicated proposed ports', () => {
    const s = chain();
    const plan = planRegroup(s.m, splitConfig(s));
    expect(plan.bundles.map((b) => b.members.map((mm) => mm.label))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(plan.bundles[0].proposedPorts).toEqual([
      {
        label: 'bP',
        direction: 'out',
        connectionId: s.bc.id,
        insideEndpointId: s.b.port.id,
        innerBundleId: null,
      },
    ]);
    expect(plan.unassigned).toEqual([]);
  });

  // F2: proposedPorts are keyed by inside ENDPOINT (not the old (label,
  // direction) display dedup) — the SAME grouping Apply executes, so the
  // preview's port list is the single source of truth.
  it('groups proposed ports by inside endpoint, keeping the first connection', () => {
    const s = chain();
    // A second crossing from the SAME inside port bP: b–d.
    s.f.connect(s.b.port.id, s.d.port.id, { name: 'bd', ownerId: s.pkg.id });
    const plan = planRegroup(s.m, splitConfig(s));
    expect(plan.boundary).toHaveLength(4); // b–c and b–d, two sides each
    // B1 needs only ONE delegation port — one distinct inside endpoint (bP).
    expect(plan.bundles[0].proposedPorts).toEqual([
      {
        label: 'bP',
        direction: 'out',
        connectionId: s.bc.id,
        insideEndpointId: s.b.port.id,
        innerBundleId: null,
      },
    ]);
    // B2 needs two ports — two distinct inside endpoints (cP and dP).
    expect(plan.bundles[1].proposedPorts.map((p) => p.label)).toEqual(['cP', 'dP']);
  });

  // F2 regression (preview ≡ apply, direction 1): a shared PART endpoint bound
  // by two connections used to promise two ports (a_c1, a_c2) while apply
  // created one — now BOTH preview rows advertise the single per-endpoint port.
  it('a shared part endpoint over two connections proposes exactly ONE port', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const a = f.part('a', pkg.id);
    const z1 = f.part('z1', pkg.id);
    const z2 = f.part('z2', pkg.id);
    f.connect(a.id, z1.id, { name: 'c1', ownerId: pkg.id });
    f.connect(a.id, z2.id, { name: 'c2', ownerId: pkg.id });
    const plan = planRegroup(m, cfg({ bundles: [B1], membership: { [a.id]: B1.id } }));
    expect(plan.boundary).toHaveLength(2);
    expect(plan.bundles[0].proposedPorts).toHaveLength(1);
    expect(plan.bundles[0].proposedPorts[0]).toMatchObject({
      label: 'a_c1',
      insideEndpointId: a.id,
    });
    // The second row is synced to the FINAL port name (no phantom "a_c2").
    expect(plan.boundary.map((e) => e.proposedPortLabel)).toEqual(['a_c1', 'a_c1']);
  });

  // F2 regression (preview ≡ apply, direction 2): two same-named ports on
  // DIFFERENT members are two endpoints → two outer ports, collision-suffixed
  // in the preview exactly as apply will create them.
  it('same-named ports on different members propose two suffixed ports (p, p_2)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const mk = (name: string) => {
      const part = f.part(name, pkg.id);
      const port = f.port('p', part.id);
      return { part, port };
    };
    const m1 = mk('m1');
    const m2 = mk('m2');
    const z = f.part('z', pkg.id);
    f.connect(m1.port.id, f.port('z1', z.id).id, { name: 'k1', ownerId: pkg.id });
    f.connect(m2.port.id, f.port('z2', z.id).id, { name: 'k2', ownerId: pkg.id });
    const plan = planRegroup(
      m,
      cfg({ bundles: [B1], membership: { [m1.part.id]: B1.id, [m2.part.id]: B1.id } }),
    );
    expect(plan.bundles[0].proposedPorts.map((p) => p.label)).toEqual(['p', 'p_2']);
    // The boundary rows show the final (suffixed) names too.
    expect(plan.boundary.map((e) => e.proposedPortLabel)).toEqual(['p', 'p_2']);
  });

  it('counts moved parts: new bundles always move; existing-part bundles only on owner change', () => {
    const s = chain();
    const e = s.f.part('e', s.c.part.id); // already owned by part c
    const x = s.f.part('x', s.pkg.id); // owned by the package
    const plan = planRegroup(
      s.m,
      cfg({
        bundles: [{ id: s.c.part.id, label: 'c', isNew: false }],
        membership: { [e.id]: s.c.part.id, [x.id]: s.c.part.id },
      }),
    );
    expect(plan.stats.movedCount).toBe(1); // x would move under c; e already lives there
    // A NEW bundle is always a new owner: all four chain parts count as moved.
    expect(planRegroup(s.m, splitConfig(s)).stats.movedCount).toBe(4);
  });

  it('an empty config leaves everything unassigned with no bundles/boundary', () => {
    const s = chain();
    const plan = planRegroup(s.m, cfg());
    expect(plan.stats).toEqual({
      partCount: 4,
      bundleCount: 0,
      movedCount: 0,
      boundaryCount: 0,
      internalCount: 0,
    });
    expect(plan.bundles).toEqual([]);
    expect(plan.boundary).toEqual([]);
    expect(plan.unassigned.map((u) => u.label)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores membership entries whose bundle no longer exists', () => {
    const s = chain();
    const plan = planRegroup(
      s.m,
      cfg({ bundles: [B1], membership: { [s.a.part.id]: 'gone:bundle' } }),
    );
    expect(plan.unassigned.map((u) => u.label)).toContain('a');
    expect(plan.boundary).toEqual([]);
    expect(plan.stats.movedCount).toBe(0);
  });

  it('facets the part kinds present and excludes library elements', () => {
    const s = chain();
    s.m.create('PartUsage', {
      declaredName: 'libPart',
      ownerId: s.pkg.id,
      attrs: { isLibrary: true },
    });
    const plan = planRegroup(s.m, cfg());
    expect(plan.partKindsPresent).toEqual([{ eClass: 'PartUsage', count: 4 }]);
    expect(plan.unassigned.map((u) => u.label)).not.toContain('libPart');
  });
});

describe('seedRegroupFromClusters', () => {
  it('seeds one bundle per Louvain community, all parts assigned, deterministically', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('Sys');
    const mk = (name: string) => f.part(name, pkg.id);
    const p = [mk('p1'), mk('p2'), mk('p3')];
    const q = [mk('q1'), mk('q2'), mk('q3')];
    // Two triangles (direct part-to-part connections), no cross edges.
    const tri = (xs: typeof p) => {
      f.connect(xs[0].id, xs[1].id, { ownerId: pkg.id });
      f.connect(xs[1].id, xs[2].id, { ownerId: pkg.id });
      f.connect(xs[2].id, xs[0].id, { ownerId: pkg.id });
    };
    tri(p);
    tri(q);
    const seeded = seedRegroupFromClusters(m, 'PartUsage');
    expect(seeded.partKind).toBe('PartUsage');
    expect(seeded.bundles).toEqual([
      { id: 'new:0', label: 'Bundle 1', isNew: true },
      { id: 'new:1', label: 'Bundle 2', isNew: true },
    ]);
    // Every part here is CONNECTED (each triangle edge gives it degree ≥ 1),
    // so all six are assigned; each triangle lands whole in one bundle.
    // (Degree-0 parts would stay unassigned — see the dedicated test below.)
    expect(Object.keys(seeded.membership)).toHaveLength(6);
    const bp = new Set(p.map((el) => seeded.membership[el.id]));
    const bq = new Set(q.map((el) => seeded.membership[el.id]));
    expect(bp.size).toBe(1);
    expect(bq.size).toBe(1);
    expect([...bp][0]).not.toBe([...bq][0]);
    // Deterministic: seeding twice produces an identical config.
    expect(seedRegroupFromClusters(m, 'PartUsage')).toEqual(seeded);
  });

  it('leaves connection-less (degree-0) parts UNASSIGNED — no singleton bundles', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const a = f.part('a', pkg.id);
    const b = f.part('b', pkg.id);
    f.connect(a.id, b.id, { ownerId: pkg.id });
    const lone1 = f.part('lone1', pkg.id);
    const lone2 = f.part('lone2', pkg.id);
    const seeded = seedRegroupFromClusters(m, 'PartUsage');
    // Only the connected pair is clustered; NOT one bundle per isolated part.
    expect(seeded.bundles).toHaveLength(1);
    expect(seeded.membership[a.id]).toBe('new:0');
    expect(seeded.membership[b.id]).toBe('new:0');
    expect(seeded.membership[lone1.id]).toBeUndefined();
    expect(seeded.membership[lone2.id]).toBeUndefined();
  });

  it('rolls a nested non-candidate endpoint up to the nearest CANDIDATE part', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const a = f.part('a', pkg.id);
    // The endpoint's owning part is an ItemUsage — NOT a 'PartUsage' candidate.
    const item = m.create('ItemUsage', { declaredName: 'item', ownerId: a.id });
    const itemP = f.port('itemP', item.id);
    const b = f.part('b', pkg.id);
    const bP = f.port('bP', b.id);
    f.connect(itemP.id, bP.id, { ownerId: pkg.id });
    const seeded = seedRegroupFromClusters(m, 'PartUsage');
    // Regression: the edge used to be dropped → a and b were left unclustered.
    expect(seeded.bundles).toHaveLength(1);
    expect(seeded.membership[a.id]).toBe('new:0');
    expect(seeded.membership[b.id]).toBe('new:0');
    expect(seeded.membership[item.id]).toBeUndefined(); // not a candidate
  });
});

describe('purity + determinism', () => {
  it('planRegroup is deterministic (two runs are identical)', () => {
    const s = chain();
    const config = splitConfig(s);
    expect(planRegroup(s.m, config)).toEqual(planRegroup(s.m, config));
  });

  it('never mutates the model (Phase 1 is preview-only)', () => {
    const s = chain();
    const before = JSON.stringify(s.m.toJSON());
    planRegroup(s.m, splitConfig(s));
    seedRegroupFromClusters(s.m, 'PartUsage');
    seedRegroupFromNodeIds(s.m, 'PartUsage', [s.a.port.id, s.b.part.id]);
    expect(JSON.stringify(s.m.toJSON())).toBe(before);
  });
});

describe('candidateParts', () => {
  it('lists EVERY candidate part of the kind (declaration order), assigned or not', () => {
    const s = chain();
    const preview = planRegroup(s.m, splitConfig(s));
    expect(preview.candidateParts.map((p) => p.label)).toEqual(['a', 'b', 'c', 'd']);
  });
});

/**
 * The load-bearing correctness case for "bundle into an EXISTING part": a moved
 * member's connection to the target's PRE-EXISTING interior must read as
 * INTERNAL (no spurious delegation port), while the target's OWN external
 * interface is left untouched and only the member's external connection is
 * delegated.
 */
describe('existing-part bundle interior', () => {
  function fixture() {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const X = f.part('X', pkg.id); // existing bundle TARGET
    const N = f.part('N', X.id); // pre-existing child of X
    const n1 = f.port('n1', N.id);
    const n2 = f.port('n2', N.id);
    const M = f.part('M', pkg.id); // moved INTO X
    const m1 = f.port('m1', M.id);
    const m2 = f.port('m2', M.id);
    const O = f.part('O', pkg.id); // stays outside
    const o1 = f.port('o1', O.id);
    const o2 = f.port('o2', O.id);
    const cMN = f.connect(m1.id, n1.id, { name: 'mn', ownerId: pkg.id }); // internal after move
    const cMO = f.connect(m2.id, o1.id, { name: 'mo', ownerId: pkg.id }); // member ↔ outside → delegate
    const cNO = f.connect(n2.id, o2.id, { name: 'no', ownerId: pkg.id }); // X's own interface → untouched
    const config = cfg({
      bundles: [{ id: X.id, label: 'X', isNew: false }],
      membership: { [M.id]: X.id },
    });
    return {
      m,
      X: X.id,
      N: N.id,
      M: M.id,
      O: O.id,
      m2: m2.id,
      cMN: cMN.id,
      cMO: cMO.id,
      cNO: cNO.id,
      config,
    };
  }

  it('treats member ↔ target-interior as INTERNAL, delegates only the member’s external', () => {
    const s = fixture();
    const preview = planRegroup(s.m, s.config);
    // Exactly one boundary row: the member's external connection.
    expect(preview.boundary).toHaveLength(1);
    expect(preview.boundary[0]).toMatchObject({
      connectionId: s.cMO,
      bundleId: s.X,
      insidePartId: s.M,
      insideEndpointId: s.m2,
    });
    // No row references the now-internal member↔child or X's own interface.
    const ids = preview.boundary.map((e) => e.connectionId);
    expect(ids).not.toContain(s.cMN);
    expect(ids).not.toContain(s.cNO);
    // One delegation port on X (for the member), and the member↔child counted internal.
    const bx = preview.bundles.find((b) => b.id === s.X)!;
    expect(bx.proposedPorts).toHaveLength(1);
    expect(bx.proposedPorts[0].label).toBe('m2');
    expect(preview.stats.internalCount).toBe(1);
  });

  it('does NOT count a member-less target’s pre-existing internal wiring as internal', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const X = f.part('X', pkg.id);
    const N = f.part('N', X.id);
    const nP = f.port('nP', N.id);
    const N2 = f.part('N2', X.id);
    const n2P = f.port('n2P', N2.id);
    f.connect(nP.id, n2P.id, { name: 'nn', ownerId: pkg.id }); // pre-existing, inside X
    // X is a target but has NO members — nothing changes, so nothing is "made
    // internal by this regroup".
    const preview = planRegroup(m, cfg({ bundles: [{ id: X.id, label: 'X', isNew: false }] }));
    expect(preview.stats.internalCount).toBe(0);
    expect(preview.boundary).toEqual([]);
  });
});

describe('portLabels overrides', () => {
  it('renames a proposed port and syncs the boundary rows', () => {
    const s = chain();
    const config = splitConfig(s);
    const key = proposedPortKey(B1.id, s.b.port.id);
    const preview = planRegroup(s.m, { ...config, portLabels: { [key]: 'ctrlPort' } });
    const b1 = preview.bundles.find((b) => b.id === B1.id)!;
    expect(b1.proposedPorts[0].label).toBe('ctrlPort');
    const row = preview.boundary.find((e) => e.bundleId === B1.id)!;
    expect(row.proposedPortLabel).toBe('ctrlPort');
  });

  it('still collision-suffixes an override that clashes with a member name', () => {
    const s = chain();
    const config = splitConfig(s); // B1 = {a, b}
    const key = proposedPortKey(B1.id, s.b.port.id);
    // Rename the port to 'a' — collides with member part 'a' → suffixed.
    const preview = planRegroup(s.m, { ...config, portLabels: { [key]: 'a' } });
    const b1 = preview.bundles.find((b) => b.id === B1.id)!;
    expect(b1.proposedPorts[0].label).toBe('a_2');
  });

  it('a blank/whitespace override falls back to the auto name', () => {
    const s = chain();
    const config = splitConfig(s);
    const key = proposedPortKey(B1.id, s.b.port.id);
    const preview = planRegroup(s.m, { ...config, portLabels: { [key]: '   ' } });
    const b1 = preview.bundles.find((b) => b.id === B1.id)!;
    expect(b1.proposedPorts[0].label).toBe('bP'); // b's port name
  });
});

describe('seedRegroupFromNodeIds', () => {
  it('rolls each node up to its nearest candidate part into ONE new bundle', () => {
    const s = chain();
    const config = seedRegroupFromNodeIds(
      s.m,
      'PartUsage',
      [s.a.port.id, s.b.part.id, 'no-such-id', s.c.port.id],
      'Cluster 1',
    );
    expect(config.bundles).toEqual([{ id: 'new:0', label: 'Cluster 1', isNew: true }]);
    expect(config.membership).toEqual({
      [s.a.part.id]: 'new:0',
      [s.b.part.id]: 'new:0',
      [s.c.part.id]: 'new:0',
    });
    expect(config.partKind).toBe('PartUsage');
  });

  it('de-duplicates when several nodes roll up to the same part', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const a = f.part('a', pkg.id);
    const p1 = f.port('p1', a.id);
    const p2 = f.port('p2', a.id); // both ports roll up to `a`
    const config = seedRegroupFromNodeIds(m, 'PartUsage', [p1.id, p2.id]);
    expect(Object.keys(config.membership)).toEqual([a.id]);
  });

  it('returns NO bundle when nothing resolves to a candidate part', () => {
    const s = chain();
    const config = seedRegroupFromNodeIds(s.m, 'PartUsage', [s.pkg.id, 'nope']);
    expect(config.bundles).toEqual([]);
    expect(config.membership).toEqual({});
    expect(config.partKind).toBe('PartUsage');
  });
});

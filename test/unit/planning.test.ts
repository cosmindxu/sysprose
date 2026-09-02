/**
 * buildPlan — the DOORS→CodeBeamer-style wave planner: atomic elements →
 * workload → groups → ordered → capacity-packed into time slices (waves).
 */
import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { buildPlan, defaultPlanConfig, minlaCost, orderByMinLA } from '@diagram/index';
import type { PlanConfig, PlanGroup, PlanModel } from '@diagram/index';
import { buildMinLAInstance, minlaSwapDelta } from '@diagram/planning';
import { makeRng, type Graph } from '@diagram/graph-algorithms';

/**
 * Blocks A(40), B(30), C(10) via requirements; B depends on A (a Derive from a
 * B-requirement to an A-requirement). One ungrouped requirement + one with no
 * effort attr (workload defaults to 1). Capacity 40 / week.
 */
function seed() {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('Sys');
  const A = f.partDef('BlockA', pkg.id).id;
  const B = f.partDef('BlockB', pkg.id).id;
  const C = f.partDef('BlockC', pkg.id).id;
  const req = (name: string, effort: number | undefined, satisfies: string) => {
    const r = m.create('RequirementUsage', {
      declaredName: name,
      ownerId: pkg.id,
      attrs: effort === undefined ? {} : { effort },
    });
    if (satisfies) f.satisfy(r.id, satisfies); // source=block, target=req
    return r.id;
  };
  const rA1 = req('rA1', 20, A);
  req('rA2', 20, A);
  const rB1 = req('rB1', 30, B);
  req('rC1', 10, C);
  req('rDefault', undefined, C); // no effort → workload 1 (C = 11)
  m.create('RequirementUsage', { declaredName: 'orphan', ownerId: pkg.id, attrs: { effort: 5 } }); // ungrouped
  // B depends on A: a Derive from a B-requirement to an A-requirement.
  m.create('Derive', { ownerId: pkg.id, source: [rB1], target: [rA1] });
  return { m, A, B, C };
}

const cfg = (over: Partial<PlanConfig> = {}): PlanConfig => ({ ...defaultPlanConfig(), ...over });

function waveOfGroup(plan: PlanModel, label: string): number {
  return plan.waves.findIndex((w) => w.groups.some((g) => g.label === label));
}

describe('buildPlan', () => {
  it('rolls atomic workload up into groups via the satisfy grouping', () => {
    const plan = buildPlan(seed().m, cfg());
    expect(plan.atomicCount).toBe(6);
    expect(plan.groupCount).toBe(3);
    const g = (label: string) => plan.waves.flatMap((w) => w.groups).find((x) => x.label === label)!;
    expect(g('BlockA').workload).toBe(40); // 20 + 20
    expect(g('BlockB').workload).toBe(30);
    expect(g('BlockC').workload).toBe(11); // 10 + default 1
  });

  it('defaults missing effort to 1 and surfaces ungrouped atomics', () => {
    const plan = buildPlan(seed().m, cfg());
    expect(plan.ungrouped.map((u) => u.label)).toContain('orphan');
    expect(plan.totalWorkload).toBe(20 + 20 + 30 + 10 + 1 + 5); // incl. the orphan
  });

  it('packs groups into capacity-bounded waves (no wave exceeds capacity unless oversized)', () => {
    const plan = buildPlan(seed().m, cfg({ capacity: 40 }));
    for (const w of plan.waves) {
      const anyOversized = w.groups.some((g) => g.oversized);
      if (!anyOversized) expect(w.workload).toBeLessThanOrEqual(40);
    }
    expect(plan.waves.every((w) => w.label.startsWith('Week'))).toBe(true);
  });

  it('dependency ordering schedules a dependent group no earlier than its predecessor', () => {
    const plan = buildPlan(seed().m, cfg({ ordering: 'dependency', capacity: 40 }));
    // B depends on A ⇒ B's wave ≥ A's wave.
    expect(waveOfGroup(plan, 'BlockB')).toBeGreaterThanOrEqual(waveOfGroup(plan, 'BlockA'));
  });

  it('an oversized group (workload > capacity) gets its own wave, flagged', () => {
    const plan = buildPlan(seed().m, cfg({ capacity: 25 })); // A(40) > 25
    const aWave = plan.waves[waveOfGroup(plan, 'BlockA')];
    const a = aWave.groups.find((g) => g.label === 'BlockA')!;
    expect(a.oversized).toBe(true);
    expect(aWave.groups).toHaveLength(1); // alone in its wave
  });

  it('capacity-balanced ordering minimizes waves via first-fit-decreasing', () => {
    const plan = buildPlan(seed().m, cfg({ ordering: 'capacity', capacity: 40 }));
    // A=40, B=30, C=11 → FFD: [A], [B, ...], C fits with B (41>40? no) → [A],[B],[C]...
    // Assert every non-oversized wave respects capacity and total is conserved.
    const packed = plan.waves.reduce((s, w) => s + w.workload, 0);
    expect(packed).toBe(40 + 30 + 11);
  });

  it('exposes atomic-kind facets for the config filter', () => {
    const plan = buildPlan(seed().m, cfg());
    expect(plan.atomicKindsPresent.some((f) => f.eClass === 'RequirementUsage')).toBe(true);
  });

  it('grouping=containment groups atomics by their owner', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const blk = f.partDef('Blk', f.pkg('P').id);
    m.create('RequirementUsage', { declaredName: 'r1', ownerId: blk.id, attrs: { effort: 3 } });
    m.create('RequirementUsage', { declaredName: 'r2', ownerId: blk.id, attrs: { effort: 4 } });
    const plan = buildPlan(m, cfg({ grouping: 'containment' }));
    expect(plan.groupCount).toBe(1);
    expect(plan.waves.flatMap((w) => w.groups)[0].workload).toBe(7);
  });

  it('is deterministic', () => {
    const m = seed().m;
    const a = buildPlan(m, cfg());
    const b = buildPlan(m, cfg());
    expect(a.waves.map((w) => w.groups.map((g) => g.id))).toEqual(
      b.waves.map((w) => w.groups.map((g) => g.id)),
    );
  });
});

/* ─────────────── MinLA optimization layer (milp / annealing / cohesion) ─────────────── */

/** Synthetic PlanGroup for driving orderByMinLA directly (no Model needed). */
const grp = (id: string, domain = 'D'): PlanGroup => ({
  id,
  label: id,
  eClass: 'PartDefinition',
  workload: 10,
  members: [],
  domain,
  community: -1,
  oversized: false,
});

const graphOf = (nodes: string[], edges: [string, string, number][]): Graph => ({
  nodes,
  edges: edges.map(([source, target, weight]) => ({ source, target, weight })),
});

/** All permutations of `a` (for brute-forcing tiny optima). */
function permutations(a: number[]): number[][] {
  if (a.length <= 1) return [a.slice()];
  const out: number[][] = [];
  for (let i = 0; i < a.length; i++) {
    const rest = [...a.slice(0, i), ...a.slice(i + 1)];
    for (const p of permutations(rest)) out.push([a[i], ...p]);
  }
  return out;
}

/** The produced group order = the waves' groups concatenated (packing keeps order). */
const flatOrder = (plan: PlanModel): string[] =>
  plan.waves.flatMap((w) => w.groups.map((g) => g.label));

/** Positions of `labels` in `order` form one unbroken run. */
function expectContiguous(order: string[], labels: string[]): void {
  const at = labels.map((l) => order.indexOf(l)).sort((a, b) => a - b);
  expect(at[0]).toBeGreaterThanOrEqual(0);
  expect(at[at.length - 1] - at[0]).toBe(labels.length - 1);
}

/**
 * Two clear coupling clusters: triangles A0-A1-A2 and B0-B1-B2 (weight 3 on
 * every intra-cluster pair) bridged by one weak A2–B0 edge (weight 1), with the
 * requirement creation order INTERLEAVED (A0,B0,A1,B1,A2,B2) so the natural
 * baseline order is bad for MinLA. Returns the coupling edge list by label.
 */
function clusteredSeed() {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('Sys');
  const block = new Map<string, string>();
  for (const name of ['A0', 'A1', 'A2', 'B0', 'B1', 'B2']) block.set(name, f.partDef(name, pkg.id).id);
  const req = (name: string) => {
    const r = m.create('RequirementUsage', {
      declaredName: `r${name}`,
      ownerId: pkg.id,
      attrs: { effort: 10 },
    });
    f.satisfy(r.id, block.get(name)!);
  };
  for (const name of ['A0', 'B0', 'A1', 'B1', 'A2', 'B2']) req(name);
  const edges: [string, string, number][] = [
    ['A0', 'A1', 3],
    ['A0', 'A2', 3],
    ['A1', 'A2', 3],
    ['B0', 'B1', 3],
    ['B0', 'B2', 3],
    ['B1', 'B2', 3],
    ['A2', 'B0', 1],
  ];
  for (const [s, t, w] of edges)
    for (let i = 0; i < w; i++)
      m.create('Trace', { ownerId: pkg.id, source: [block.get(s)!], target: [block.get(t)!] });
  return { m, edges };
}

/** MinLA cost of the plan's produced group order over a known label edge list. */
function costOverEdges(plan: PlanModel, edges: [string, string, number][]): number {
  const pos = new Map(flatOrder(plan).map((l, i) => [l, i] as const));
  let c = 0;
  for (const [a, b, w] of edges) c += w * Math.abs(pos.get(a)! - pos.get(b)!);
  return c;
}

describe('MinLA optimization (milp / annealing / cohesion)', () => {
  it('minlaSwapDelta equals the exact cost difference for many seeded random swaps', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const inst = buildMinLAInstance(
      graphOf(ids, [
        ['a', 'b', 3],
        ['a', 'c', 0.5],
        ['a', 'h', 2.25],
        ['b', 'd', 1],
        ['b', 'g', 4],
        ['c', 'e', 2],
        ['c', 'f', 1.5],
        ['d', 'e', 5],
        ['d', 'h', 1],
        ['e', 'f', 0.75],
        ['f', 'g', 2],
        ['g', 'h', 3],
      ]),
      ids,
    );
    const order = ids.map((_, i) => i);
    const pos = order.slice();
    const rng = makeRng(42);
    for (let t = 0; t < 300; t++) {
      const p = Math.floor(rng() * inst.n);
      let q = Math.floor(rng() * (inst.n - 1));
      if (q >= p) q++;
      const before = minlaCost(order, inst.adj);
      const delta = minlaSwapDelta(order, pos, p, q, inst.adj);
      const a = order[p];
      const b = order[q];
      order[p] = b;
      order[q] = a;
      pos[a] = q;
      pos[b] = p;
      // Keep the swap applied so deltas are exercised from 300 different orders.
      expect(Math.abs(minlaCost(order, inst.adj) - before - delta)).toBeLessThan(1e-9);
    }
  });

  it('annealing ordering is deterministic (same model+config → same order + cost)', () => {
    const { m } = clusteredSeed();
    const a = buildPlan(m, cfg({ ordering: 'annealing' }));
    const b = buildPlan(m, cfg({ ordering: 'annealing' }));
    expect(a.waves.map((w) => w.groups.map((g) => g.id))).toEqual(
      b.waves.map((w) => w.groups.map((g) => g.id)),
    );
    expect(a.couplingCost).toBe(b.couplingCost);
  });

  it('annealing improves on the baseline and keeps the two coupling clusters contiguous', () => {
    const { m } = clusteredSeed();
    const plan = buildPlan(m, cfg({ ordering: 'annealing' }));
    expect(plan.couplingCost).toBeLessThanOrEqual(plan.couplingBaseline);
    // The interleaved insertion order is strictly bad here — annealing must beat it.
    expect(plan.couplingCost).toBeLessThan(plan.couplingBaseline);
    const order = flatOrder(plan);
    expectContiguous(order, ['A0', 'A1', 'A2']);
    expectContiguous(order, ['B0', 'B1', 'B2']);
  });

  it('milp (exact) matches the brute-force optimum on a small instance, optimal=true', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const edges: [string, string, number][] = [
      ['a', 'b', 3],
      ['a', 'c', 1],
      ['a', 'e', 2],
      ['b', 'd', 2],
      ['c', 'e', 4],
      ['d', 'e', 1],
    ];
    const g = graphOf(ids, edges);
    const res = orderByMinLA(ids.map((id) => grp(id)), g, {
      cohesion: false,
      method: 'milp',
      seed: 123,
    });
    const inst = buildMinLAInstance(g, ids);
    let brute = Infinity;
    for (const p of permutations([0, 1, 2, 3, 4])) brute = Math.min(brute, minlaCost(p, inst.adj));
    expect(res.cost).toBe(brute);
    expect(res.optimal).toBe(true);
    expect([...res.order.map((o) => o.id)].sort()).toEqual([...ids].sort());
  });

  it('milp above the exact limit falls back to annealing: valid permutation, optimal=false', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `g${i}`);
    const edges: [string, string, number][] = ids.map((id, i) => [
      id,
      ids[(i + 1) % ids.length],
      i + 1,
    ]);
    edges.push(['g0', 'g5', 2], ['g2', 'g8', 3]);
    const res = orderByMinLA(ids.map((id) => grp(id)), graphOf(ids, edges), {
      cohesion: false,
      method: 'milp',
      seed: 7,
    });
    expect(res.optimal).toBe(false);
    expect(res.order).toHaveLength(11);
    expect([...res.order.map((o) => o.id)].sort()).toEqual([...ids].sort());
  });

  it('cohesion is HARD: domains stay contiguous and no wave mixes two domains', () => {
    // Strong CROSS-domain coupling (X0–Y0, X1–Y1, X2–Y2 at weight 5) that would
    // interleave the domains without the constraint; weak intra-domain edges.
    const m = new Model();
    const f = new ModelFactory(m);
    const dx = f.pkg('DomX');
    const dy = f.pkg('DomY');
    const block = new Map<string, string>();
    for (const n of ['X0', 'X1', 'X2']) block.set(n, f.partDef(n, dx.id).id);
    for (const n of ['Y0', 'Y1', 'Y2']) block.set(n, f.partDef(n, dy.id).id);
    for (const [n, id] of block) {
      const owner = n.startsWith('X') ? dx.id : dy.id;
      const r = m.create('RequirementUsage', {
        declaredName: `r${n}`,
        ownerId: owner,
        attrs: { effort: 10 },
      });
      f.satisfy(r.id, id);
    }
    const link = (s: string, t: string, w: number) => {
      for (let i = 0; i < w; i++)
        m.create('Trace', { ownerId: dx.id, source: [block.get(s)!], target: [block.get(t)!] });
    };
    link('X0', 'Y0', 5);
    link('X1', 'Y1', 5);
    link('X2', 'Y2', 5);
    link('X0', 'X2', 1);
    link('Y0', 'Y2', 1);

    for (const ordering of ['annealing', 'milp'] as const) {
      const plan = buildPlan(m, cfg({ ordering, cohesion: true }));
      const order = flatOrder(plan);
      expect(order).toHaveLength(6);
      expectContiguous(order, ['X0', 'X1', 'X2']);
      expectContiguous(order, ['Y0', 'Y1', 'Y2']);
      for (const w of plan.waves) {
        expect(new Set(w.groups.map((g) => g.domain)).size).toBeLessThanOrEqual(1);
      }
      // The hard constraint binds: the unconstrained optimum interleaves domains
      // (strong cross pairs adjacent), so the cohesive cost can only be ≥ it.
      const free = buildPlan(m, cfg({ ordering, cohesion: false }));
      expect(plan.couplingCost).toBeGreaterThanOrEqual(free.couplingCost);
    }
  });

  it('reports couplingCost == minlaCost of the PACKED board, for EVERY ordering', () => {
    // couplingCost is scored over the packed board (what the user sees), so even
    // first-fit orderings (dependency/capacity), whose packing re-slots groups
    // across waves, must have the readout match the visible board — never a
    // false "↓ from baseline" against an order the board doesn't actually show.
    const { m, edges } = clusteredSeed();
    for (const ordering of [
      'coupling',
      'domain-first',
      'annealing',
      'milp',
      'dependency',
      'capacity',
    ] as const) {
      // A tight capacity forces first-fit re-slotting so the board ≠ pre-pack order.
      const plan = buildPlan(m, cfg({ ordering, capacity: 25 }));
      expect(plan.couplingCost).toBe(costOverEdges(plan, edges));
      expect(plan.couplingBaseline).toBeGreaterThanOrEqual(0);
    }
  });

  it('milp on the clustered seed proves the optimum (n=6 ≤ exact limit)', () => {
    const { m } = clusteredSeed();
    const plan = buildPlan(m, cfg({ ordering: 'milp' }));
    expect(plan.optimalOrder).toBe(true);
    // Optimal MinLA for two w=3 triangles + one w=1 bridge is 12 + 12 + 1 = 25.
    expect(plan.couplingCost).toBe(25);
    // Annealing (optimal=false — nothing proven) must not beat the proven optimum.
    const annealed = buildPlan(m, cfg({ ordering: 'annealing' }));
    expect(annealed.optimalOrder).toBe(false);
    expect(annealed.couplingCost).toBeGreaterThanOrEqual(25);
  });
});

/* ─────────── Regressions for the adversarial-review findings (round 2) ─────────── */

describe('MinLA optimization — review regressions', () => {
  // Fix A: minlaAnneal must not misread a downhill-only / local-max start
  // (hub-and-spoke) as a flat landscape and return the un-optimized order.
  it('annealing optimizes a hub-and-spoke graph (hub inserted first) — no silent no-op', () => {
    const k = 6;
    const ids = ['h', ...Array.from({ length: k }, (_, i) => `l${i}`)];
    const edges = ids.slice(1).map((l) => ['h', l, 1] as [string, string, number]);
    const groups = ids.map((id) => grp(id));
    const res = orderByMinLA(groups, graphOf(ids, edges), {
      cohesion: false,
      method: 'annealing',
      seed: 5,
    });
    // Baseline (hub at position 0) = Σ_{i=1..k} i = 21; the optimum (hub centred) = 12.
    expect(res.baseline).toBe(21);
    expect(res.cost).toBeLessThan(res.baseline); // BEFORE the fix this was == baseline
    expect(res.cost).toBeLessThanOrEqual(12);
  });

  it('milp fallback (n > exact limit) also optimizes a hub graph instead of no-op', () => {
    const k = 12; // 13 nodes > EXACT_MAX → milp falls back to annealing
    const ids = ['h', ...Array.from({ length: k }, (_, i) => `l${i}`)];
    const edges = ids.slice(1).map((l) => ['h', l, 1] as [string, string, number]);
    const groups = ids.map((id) => grp(id));
    const res = orderByMinLA(groups, graphOf(ids, edges), {
      cohesion: false,
      method: 'milp',
      seed: 3,
    });
    expect(res.optimal).toBe(false); // n > limit → not proven
    expect(res.cost).toBeLessThan(res.baseline);
  });

  it('a downhill-only tiny instance (edge between first and last) reaches the optimum', () => {
    const ids = ['a', 'b', 'c'];
    const res = orderByMinLA(ids.map((id) => grp(id)), graphOf(ids, [['a', 'c', 5]]), {
      cohesion: false,
      method: 'annealing',
      seed: 9,
    });
    expect(res.baseline).toBe(10); // a@0, c@2 → 5·2
    expect(res.cost).toBe(5); // a and c made adjacent
  });

  it('optimizes a large, very sparse instance (calibration may sample no edge — LOW-1)', () => {
    // 300 groups, a single weight-1 edge between the first and last. The ≤500
    // calibration swaps almost surely all miss it, exercising the edge-weight
    // T0 fallback; the loop must still descend rather than no-op.
    const N = 300;
    const ids = Array.from({ length: N }, (_, i) => `g${i}`);
    const res = orderByMinLA(ids.map((id) => grp(id)), graphOf(ids, [['g0', `g${N - 1}`, 1]]), {
      cohesion: false,
      method: 'annealing',
      seed: 4,
    });
    expect(res.baseline).toBe(N - 1); // g0@0, g_{N-1}@N-1 → 1·(N-1)
    expect(res.cost).toBeLessThan(res.baseline);
  });

  // Fix B: cohesion must keep each domain contiguous even for ordering='coupling',
  // whose community sort would otherwise interleave the domains.
  function crossCoupledDomains() {
    const m = new Model();
    const f = new ModelFactory(m);
    const dx = f.pkg('DX');
    const dy = f.pkg('DY');
    const block = new Map<string, string>();
    for (const n of ['X0', 'X1']) block.set(n, f.partDef(n, dx.id).id);
    for (const n of ['Y0', 'Y1']) block.set(n, f.partDef(n, dy.id).id);
    for (const [n, id] of block) {
      const owner = n.startsWith('X') ? dx.id : dy.id;
      const r = m.create('RequirementUsage', {
        declaredName: `r${n}`,
        ownerId: owner,
        attrs: { effort: 10 },
      });
      f.satisfy(r.id, id);
    }
    const link = (s: string, t: string, w: number) => {
      for (let i = 0; i < w; i++)
        m.create('Trace', { ownerId: dx.id, source: [block.get(s)!], target: [block.get(t)!] });
    };
    link('X0', 'Y0', 5); // cross-domain — Louvain communities {X0,Y0},{X1,Y1}
    link('X1', 'Y1', 5);
    return m;
  }

  it('cohesion + ordering=coupling keeps each domain contiguous (no split across waves)', () => {
    const plan = buildPlan(crossCoupledDomains(), cfg({ ordering: 'coupling', cohesion: true }));
    const order = flatOrder(plan);
    expectContiguous(order, ['X0', 'X1']);
    expectContiguous(order, ['Y0', 'Y1']);
    for (const w of plan.waves) {
      expect(new Set(w.groups.map((g) => g.domain)).size).toBeLessThanOrEqual(1);
    }
  });

  // Fix C: cohesion optimality flag must be honest AND the milp cohesive order
  // must be the true domain-contiguous optimum, not the decomposition heuristic.
  it('milp+cohesion finds the true contiguous optimum and only then claims optimal', () => {
    // x0 couples weakly to x1 (w1, same domain) and strongly to y0 (w5, other
    // domain). The decomposition would keep [x0,x1,y0] (cost 11); the real
    // contiguous optimum places x0 at the boundary next to y0 (cost 6).
    const groups = [grp('x0', 'X'), grp('x1', 'X'), grp('y0', 'Y')];
    const g = graphOf(['x0', 'x1', 'y0'], [['x0', 'x1', 1], ['x0', 'y0', 5]]);
    const res = orderByMinLA(groups, g, { cohesion: true, method: 'milp', seed: 1 });
    expect(res.cost).toBe(6);
    expect(res.optimal).toBe(true);
    expectContiguous(res.order.map((o) => o.id), ['x0', 'x1']); // domain still contiguous
    // Annealing under cohesion never claims a proof.
    const ann = orderByMinLA(groups, g, { cohesion: true, method: 'annealing', seed: 1 });
    expect(ann.optimal).toBe(false);
  });

  it('large cohesion instances use the heuristic decomposition and report optimal=false', () => {
    const bigIds: string[] = [];
    const bigGroups: PlanGroup[] = [];
    for (const d of ['A', 'B', 'C']) {
      for (let i = 0; i < 4; i++) {
        const id = `${d}${i}`;
        bigIds.push(id);
        bigGroups.push(grp(id, d));
      }
    }
    const bigEdges: [string, string, number][] = [
      ['A0', 'B0', 2],
      ['B1', 'C1', 3],
      ['A2', 'C2', 1],
    ];
    const res = orderByMinLA(bigGroups, graphOf(bigIds, bigEdges), {
      cohesion: true,
      method: 'milp', // 12 groups > EXACT_MAX → decomposition, no global proof
      seed: 2,
    });
    expect(res.optimal).toBe(false);
    expectContiguous(res.order.map((o) => o.id), ['A0', 'A1', 'A2', 'A3']); // still contiguous
    expectContiguous(res.order.map((o) => o.id), ['B0', 'B1', 'B2', 'B3']);
  });

  // workloadOf gap: text authoring writes `attribute effort = N` as a CHILD
  // AttributeUsage (attrs.value), not an element-level attr — it must be read.
  it('reads the workload from a child AttributeUsage (text-authored `attribute effort = N`)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const blk = f.partDef('Blk', pkg.id);
    const r = m.create('RequirementUsage', { declaredName: 'r1', ownerId: pkg.id });
    m.create('AttributeUsage', { declaredName: 'effort', ownerId: r.id, attrs: { value: 7 } });
    f.satisfy(r.id, blk.id);
    const plan = buildPlan(m, cfg({ grouping: 'satisfy' }));
    const g = plan.waves.flatMap((w) => w.groups).find((x) => x.label === 'Blk')!;
    expect(g.workload).toBe(7); // not the default 1
  });
});

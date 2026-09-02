/**
 * planning — build a migration/effort PLAN from a SysML v2 {@link Model}, in the
 * spirit of the DOORS→CodeBeamer wave slicing: ATOMIC elements (each carrying a
 * workload) roll up into GROUPS by a chosen association, the groups are ORDERED
 * by a chosen algorithm, then bin-packed into capacity-bounded time SLICES
 * (waves). Pure + deterministic (no React/DOM, reuses the graph-algorithms).
 */

import type { ElementId, ElementRecord } from '@core/index';
import { Model } from '@core/index';
import type { PlanConfig, PlanGroup, PlanMember, PlanModel, PlanWave } from './types';
import { type Graph, hashSeed, louvain, makeRng } from './graph-algorithms';

/* ──────────────────────────── grouping + workload ────────────────────────── */

const SATISFY_KINDS = new Set(['Satisfy', 'SatisfyRequirementUsage']);
/** Relationship metaclass(es) each `grouping` mode resolves the group through. */
const GROUPING_KINDS: Record<string, Set<string>> = {
  satisfy: SATISFY_KINDS,
  refine: new Set(['Refine']),
  derive: new Set(['Derive']),
  trace: new Set(['Trace']),
};

/** Kinds whose cross-group occurrence implies a precedence (source AFTER target). */
const DEPENDENCY_KINDS = new Set(['Dependency', 'Derive', 'Trace', 'Refine']);

const labelOf = (el: ElementRecord): string =>
  el.declaredName ?? (el.attrs.reqId as string | undefined) ?? el.declaredShortName ?? el.eClass;

/**
 * Each atomic element's workload: a positive numeric value, else 1. Reads the
 * element-level `attrs[attr]` (programmatic models), then falls back to a child
 * `attribute <attr> = N` feature — how TEXT authoring stores it: a child
 * AttributeUsage/AttributeDefinition named `attr` carrying `attrs.value`.
 */
function workloadOf(model: Model, el: ElementRecord, attr: string): number {
  let raw: unknown = el.attrs[attr];
  if (raw === undefined) {
    const child = model
      .children(el.id)
      .find(
        (c) =>
          c.declaredName === attr &&
          (c.eClass === 'AttributeUsage' || c.eClass === 'AttributeDefinition'),
      );
    raw = child?.attrs.value;
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The GROUP element id an atomic rolls up to, per the grouping mode (or undefined). */
function groupIdOf(model: Model, atomic: ElementRecord, config: PlanConfig): ElementId | undefined {
  const g = config.grouping;
  if (g === 'containment') {
    const owner = atomic.ownerId ? model.get(atomic.ownerId) : undefined;
    return owner && owner.attrs.isLibrary !== true ? owner.id : undefined;
  }
  if (g === 'subject') {
    // The requirement's `subject` feature; group = the type it is typed by.
    const subject = model.children(atomic.id).find((c) => c.attrs.requirementRole === 'subject');
    if (!subject) return undefined;
    const type = model.typesOf(subject.id)[0];
    return type?.id;
  }
  // Relationship-based (satisfy / refine / derive / trace): group = the OTHER
  // endpoint of a relationship whose target is this atomic (source = the block).
  const kinds = GROUPING_KINDS[g];
  for (const rel of model.edgesTo(atomic.id)) {
    if (!kinds.has(rel.eClass)) continue;
    const src = (rel.source ?? []).find((s) => s !== atomic.id);
    if (src && model.get(src)) return src;
  }
  return undefined;
}

/* ──────────────────────────── group graphs ───────────────────────────────── */

/** Precedence: `map[g]` = groups `g` must come AFTER (from cross-group dependency links). */
function precedenceOf(
  model: Model,
  atomicToGroup: Map<ElementId, ElementId>,
  groupIds: Set<ElementId>,
): Map<ElementId, Set<ElementId>> {
  const resolve = (id: ElementId): ElementId | undefined =>
    groupIds.has(id) ? id : atomicToGroup.get(id);
  const prec = new Map<ElementId, Set<ElementId>>();
  for (const g of groupIds) prec.set(g, new Set());
  for (const rel of model.all()) {
    if (!DEPENDENCY_KINDS.has(rel.eClass)) continue;
    const s = (rel.source ?? [])[0];
    const t = (rel.target ?? [])[0];
    if (!s || !t) continue;
    const gs = resolve(s);
    const gt = resolve(t);
    if (!gs || !gt || gs === gt) continue;
    // source depends on target ⇒ source's group AFTER target's group.
    prec.get(gs)!.add(gt);
  }
  return prec;
}

/** Undirected group graph (weight = #relationships between the two groups' elements). */
function couplingGraph(
  model: Model,
  atomicToGroup: Map<ElementId, ElementId>,
  groupIds: Set<ElementId>,
): Graph {
  const resolve = (id: ElementId): ElementId | undefined =>
    groupIds.has(id) ? id : atomicToGroup.get(id);
  const w = new Map<string, number>();
  for (const rel of model.all()) {
    const s = (rel.source ?? [])[0];
    const t = (rel.target ?? [])[0];
    if (!s || !t) continue;
    const gs = resolve(s);
    const gt = resolve(t);
    if (!gs || !gt || gs === gt) continue;
    const key = gs < gt ? `${gs} ${gt}` : `${gt} ${gs}`;
    w.set(key, (w.get(key) ?? 0) + 1);
  }
  return {
    nodes: [...groupIds],
    edges: [...w.entries()].map(([key, weight]) => {
      const [source, target] = key.split(' ');
      return { source, target, weight };
    }),
  };
}

/* ────────────────── MinLA optimization (DOORS planner port) ──────────────── */
/*
 * The DOORS→CodeBeamer planner's optimization layer minimizes the weighted
 * Minimum Linear Arrangement (MinLA) objective over the groups ("systems"):
 *     C(order) = Σ_{unordered pairs {i,j}} w_ij · |pos_i − pos_j|
 * where w_ij is the symmetric coupling weight (# cross-group relationships,
 * from {@link couplingGraph}) and pos_i the 0-indexed schedule position.
 * Lower = better: coupled groups sit close together in the schedule.
 *
 * Two solvers are ported:
 *  - 'milp'      — DOORS solves an exact CBC assignment model; no LP solver
 *                  ships in-browser, so the SAME objective is solved EXACTLY by
 *                  branch-and-bound over permutations for n ≤ EXACT_MAX
 *                  (proven optimal), falling back to annealing above that.
 *  - 'annealing' — Metropolis simulated annealing with transposition moves and
 *                  an incremental O(deg) cost delta, geometric cooling
 *                  auto-calibrated to ~80% initial worsening-move acceptance.
 *
 * Domain cohesion ("teams migrate together by functional block") makes every
 * domain one contiguous run of positions. Small 'milp' instances solve it to a
 * PROVEN optimum with a constrained branch-and-bound over domain-contiguous
 * permutations ({@link minlaExactContiguous}); larger / annealing instances use
 * the DOORS `domain_enum` decomposition (order the domains on the supergraph,
 * then each domain's members on its induced subgraph, then concatenate) — a
 * heuristic that stays contiguous but is not a global optimality proof.
 *
 * Everything is pure + deterministic: seeds derive from the group ids via
 * {@link hashSeed} → {@link makeRng}; no Date/Math.random anywhere.
 */

/** Above this size the exact branch-and-bound is skipped (annealing fallback). */
const EXACT_MAX = 9;

/** A MinLA instance: `n` nodes (0…n−1) + symmetric weighted adjacency maps. */
export interface MinLAInstance {
  n: number;
  /** `adj[a].get(b)` = w_ab (present in BOTH directions; no self-loops). */
  adj: Array<Map<number, number>>;
}

/** Build a {@link MinLAInstance} from a graph, indexing nodes by `ids` order. */
export function buildMinLAInstance(graph: Graph, ids: string[]): MinLAInstance {
  const index = new Map(ids.map((id, i) => [id, i] as const));
  const adj: Array<Map<number, number>> = ids.map(() => new Map());
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b || !(e.weight > 0)) continue;
    adj[a].set(b, (adj[a].get(b) ?? 0) + e.weight);
    adj[b].set(a, (adj[b].get(a) ?? 0) + e.weight);
  }
  return { n: ids.length, adj };
}

/**
 * MinLA cost of `order` (order[k] = node at position k): Σ w_ij·|pos_i − pos_j|,
 * each undirected pair counted once. O(E).
 */
export function minlaCost(order: number[], adj: Array<Map<number, number>>): number {
  const pos = new Array<number>(order.length);
  for (let k = 0; k < order.length; k++) pos[order[k]] = k;
  let c = 0;
  for (let a = 0; a < adj.length; a++) {
    for (const [b, w] of adj[a]) if (b > a) c += w * Math.abs(pos[a] - pos[b]);
  }
  return c;
}

/**
 * Exact incremental cost delta of transposing the nodes at positions `p` and
 * `q` (a = order[p], b = order[q]) — O(deg(a)+deg(b)):
 *     Δ = Σ_{c ∈ nbr(a), c≠b} w(a,c)·(|q − pos[c]| − |p − pos[c]|)
 *       + Σ_{c ∈ nbr(b), c≠a} w(b,c)·(|p − pos[c]| − |q − pos[c]|)
 * (the a–b term is invariant under the swap, hence excluded). Satisfies
 * `minlaCost(after) − minlaCost(before) === delta` exactly.
 */
export function minlaSwapDelta(
  order: number[],
  pos: number[],
  p: number,
  q: number,
  adj: Array<Map<number, number>>,
): number {
  const a = order[p];
  const b = order[q];
  let d = 0;
  for (const [c, w] of adj[a]) {
    if (c === b) continue;
    d += w * (Math.abs(q - pos[c]) - Math.abs(p - pos[c]));
  }
  for (const [c, w] of adj[b]) {
    if (c === a) continue;
    d += w * (Math.abs(p - pos[c]) - Math.abs(q - pos[c]));
  }
  return d;
}

/**
 * Metropolis simulated annealing for MinLA (DOORS port). Moves = transposing
 * two positions, scored by the incremental {@link minlaSwapDelta}; accept when
 * `Δ ≤ 0 || rng() < exp(−Δ/T)`. Geometric cooling `T = T0·(Tend/T0)^(it/iters)`
 * with `Tend = T0·1e-3`, auto-calibrated so ~80% of a same-magnitude worsening
 * move is accepted initially: `T0 = mean(|Δ| sampled) / −ln(0.8)` — using the
 * MAGNITUDE (not only positive Δ) so a downhill-only / local-maximum start
 * (e.g. a hub-and-spoke graph) still gets a temperature and the loop descends.
 * Runs `iters = max(20000, 800n)` iterations, keeps the best order ever seen.
 * Only a truly edgeless instance (total weight 0) is left as-is.
 */
export function minlaAnneal(inst: MinLAInstance, seed: number): number[] {
  const { n, adj } = inst;
  const order = Array.from({ length: n }, (_, i) => i);
  if (n <= 2) return order; // 0/1 node: trivial; 2 nodes: |Δpos| = 1 either way.
  // Total edge weight + count — the flat test and the calibration fallback.
  let totalW = 0;
  let nEdges = 0;
  for (let a = 0; a < n; a++)
    for (const [b, w] of adj[a])
      if (b > a) {
        totalW += w;
        nEdges++;
      }
  if (totalW === 0) return order; // no coupling — nothing to optimize.
  const pos = order.slice();
  const rng = makeRng(seed);
  // Pick a uniformly random pair of DISTINCT positions.
  const pick = (): [number, number] => {
    const p = Math.floor(rng() * n);
    let q = Math.floor(rng() * (n - 1));
    if (q >= p) q++;
    return [p, q];
  };
  // Calibrate T0 from the mean magnitude of sampled non-zero deltas on the
  // initial order. If the (≤500) sampled swaps all happen to land on zero-delta
  // pairs (only possible on a very large, very sparse graph), fall back to the
  // mean edge weight — edges exist, so the loop must still run and descend.
  const mags: number[] = [];
  const samples = Math.min(500, n * (n - 1));
  for (let s = 0; s < samples; s++) {
    const [p, q] = pick();
    const d = minlaSwapDelta(order, pos, p, q, adj);
    if (d !== 0) mags.push(Math.abs(d));
  }
  const meanMag = mags.length ? mags.reduce((s, x) => s + x, 0) / mags.length : totalW / nEdges;
  const T0 = meanMag / -Math.log(0.8);
  const tRatio = 1e-3; // Tend / T0
  const iters = Math.max(20000, 800 * n);
  let cost = minlaCost(order, adj);
  let best = order.slice();
  let bestCost = cost;
  let T = T0;
  for (let it = 0; it < iters; it++) {
    if (it % 256 === 0) T = T0 * Math.pow(tRatio, it / iters);
    const [p, q] = pick();
    const d = minlaSwapDelta(order, pos, p, q, adj);
    if (d <= 0 || rng() < Math.exp(-d / T)) {
      const a = order[p];
      const b = order[q];
      order[p] = b;
      order[q] = a;
      pos[a] = q;
      pos[b] = p;
      cost += d;
      if (cost < bestCost) {
        bestCost = cost;
        best = order.slice();
      }
    }
  }
  return best;
}

/**
 * Exact MinLA solver — branch-and-bound over permutations, filling positions
 * left→right (the faithful in-browser stand-in for the DOORS CBC assignment
 * MILP: same objective, same constraints, PROVEN optimum). Prunes a branch
 * when `partial + remaining ≥ incumbent`, where `partial` is the exact cost of
 * all already-placed pairs and `remaining` = Σ w over edges with an unplaced
 * endpoint (each contributes ≥ w·1 — an admissible lower bound). Returns the
 * optimal order for `n ≤ limit`, else null (caller falls back to annealing).
 */
export function minlaExact(inst: MinLAInstance, limit = EXACT_MAX): number[] | null {
  const { n, adj } = inst;
  if (n > limit) return null;
  const identity = Array.from({ length: n }, (_, i) => i);
  if (n <= 2) return identity;
  let best = identity.slice();
  let bestCost = minlaCost(identity, adj); // incumbent: a feasible solution.
  let totalW = 0;
  for (let a = 0; a < n; a++) for (const [b, w] of adj[a]) if (b > a) totalW += w;
  const pos = new Array<number>(n).fill(-1); // node → placed position (or −1).
  const slot = new Array<number>(n).fill(-1); // position → node.
  const dfs = (depth: number, partial: number, remW: number): void => {
    if (depth === n) {
      // remW === 0 here, so partial is the full cost; the strict prune below
      // means we only ever arrive with partial < bestCost.
      bestCost = partial;
      best = slot.slice();
      return;
    }
    for (let v = 0; v < n; v++) {
      if (pos[v] >= 0) continue;
      let add = 0; // exact cost of v's edges to already-placed nodes.
      let closed = 0; // weight of v's edges that become fully placed.
      for (const [u, w] of adj[v]) {
        if (pos[u] >= 0) {
          add += w * (depth - pos[u]);
          closed += w;
        }
      }
      const nPartial = partial + add;
      if (nPartial + (remW - closed) >= bestCost) continue; // bound ≥ incumbent → prune.
      pos[v] = depth;
      slot[depth] = v;
      dfs(depth + 1, nPartial, remW - closed);
      pos[v] = -1;
    }
  };
  dfs(0, 0, totalW);
  return best;
}

/**
 * Exact MinLA over DOMAIN-CONTIGUOUS permutations only — the hard cohesion
 * constraint solved to a PROVEN optimum. Same branch-and-bound as
 * {@link minlaExact}, but a node may only be placed if it continues the
 * currently-open domain block or opens a domain not yet started, so every
 * domain lands as one unbroken run. Because cross-domain edge costs depend on
 * placements the decomposition heuristic never sees, this joint search — not
 * the two-level decomposition — is what makes the cohesive order provably
 * optimal. Returns the optimal cohesive order for `n ≤ limit`, else null.
 */
export function minlaExactContiguous(
  inst: MinLAInstance,
  domOf: number[],
  limit = EXACT_MAX,
): number[] | null {
  const { n, adj } = inst;
  if (n > limit) return null;
  const domSize: number[] = [];
  for (const d of domOf) domSize[d] = (domSize[d] ?? 0) + 1;
  // Incumbent: a trivially-feasible contiguous order (domains by first
  // appearance, members by index) so a valid order is always returned.
  const seenDom = new Set<number>();
  const domOrder: number[] = [];
  domOf.forEach((d) => {
    if (!seenDom.has(d)) {
      seenDom.add(d);
      domOrder.push(d);
    }
  });
  const feasible: number[] = [];
  for (const d of domOrder) for (let i = 0; i < n; i++) if (domOf[i] === d) feasible.push(i);
  let best = feasible.slice();
  let bestCost = minlaCost(feasible, adj);
  let totalW = 0;
  for (let a = 0; a < n; a++) for (const [b, w] of adj[a]) if (b > a) totalW += w;
  const pos = new Array<number>(n).fill(-1);
  const slot = new Array<number>(n).fill(-1);
  const placed = new Array<number>(domSize.length).fill(0); // per-domain placed count
  const dfs = (depth: number, partial: number, remW: number): void => {
    if (depth === n) {
      bestCost = partial;
      best = slot.slice();
      return;
    }
    // The open block (if any): the previous node's domain, while incomplete.
    let active = -1;
    if (depth > 0) {
      const prevDom = domOf[slot[depth - 1]];
      if (placed[prevDom] < domSize[prevDom]) active = prevDom;
    }
    for (let v = 0; v < n; v++) {
      if (pos[v] >= 0) continue;
      const dv = domOf[v];
      if (active >= 0) {
        if (dv !== active) continue; // finish the open block before switching
      } else if (placed[dv] > 0) {
        continue; // dv already completed — a block can't be reopened
      }
      let add = 0;
      let closed = 0;
      for (const [u, w] of adj[v]) {
        if (pos[u] >= 0) {
          add += w * (depth - pos[u]);
          closed += w;
        }
      }
      const nPartial = partial + add;
      if (nPartial + (remW - closed) >= bestCost) continue;
      pos[v] = depth;
      slot[depth] = v;
      placed[dv]++;
      dfs(depth + 1, nPartial, remW - closed);
      placed[dv]--;
      pos[v] = -1;
    }
  };
  dfs(0, 0, totalW);
  return best;
}

/** Solve one sub-instance: exact when small enough (per method), else anneal. */
function minlaSolve(
  inst: MinLAInstance,
  seed: number,
  exactAllowed: boolean,
): { perm: number[]; exact: boolean } {
  if (exactAllowed) {
    const exact = minlaExact(inst);
    if (exact) return { perm: exact, exact: true };
  }
  return { perm: minlaAnneal(inst, seed), exact: false };
}

/**
 * Order groups by the MinLA coupling objective (the DOORS optimization layer).
 *
 * - `cohesion: false` — solve over ALL groups: method 'milp' → exact
 *   branch-and-bound when n ≤ {@link EXACT_MAX} (optimal=true), else annealing;
 *   method 'annealing' → annealing (optimal=false).
 * - `cohesion: true` — hard "teams migrate together" constraint: every domain
 *   must be one contiguous block. For small instances with method 'milp'
 *   (n ≤ EXACT_MAX) this is solved to a PROVEN optimum by the constrained
 *   branch-and-bound {@link minlaExactContiguous} (optimal=true). Otherwise the
 *   DOORS `domain_enum` decomposition (order the domains on the supergraph,
 *   then each domain's members on its induced subgraph, concatenate) — a
 *   heuristic that cannot prove global optimality (the supergraph ignores block
 *   widths; each sub-solve drops cross-domain edges), so optimal=false.
 *
 * `baseline` is the MinLA cost of the groups in their given order; `cost` the
 * cost of the produced order (same objective, same coupling graph).
 */
export function orderByMinLA(
  groups: PlanGroup[],
  cgraph: Graph,
  opts: { cohesion: boolean; method: 'milp' | 'annealing'; seed: number },
): { order: PlanGroup[]; cost: number; baseline: number; optimal: boolean } {
  const ids = groups.map((g) => g.id);
  const inst = buildMinLAInstance(cgraph, ids);
  const identity = Array.from({ length: inst.n }, (_, i) => i);
  const baseline = minlaCost(identity, inst.adj);

  let perm: number[];
  let optimal: boolean;
  if (!opts.cohesion) {
    const solved = minlaSolve(inst, opts.seed, opts.method === 'milp');
    perm = solved.perm;
    optimal = solved.exact;
  } else {
    // Hard cohesion: every domain must be one contiguous block.
    // Partition by domain (first-appearance order — deterministic).
    const domains: string[] = [];
    const memberIdx = new Map<string, number[]>();
    groups.forEach((g, i) => {
      let m = memberIdx.get(g.domain);
      if (!m) {
        domains.push(g.domain);
        m = [];
        memberIdx.set(g.domain, m);
      }
      m.push(i);
    });
    const domIndex = new Map(domains.map((d, i) => [d, i] as const));
    const domOf = groups.map((g) => domIndex.get(g.domain)!);
    const exact = opts.method === 'milp' ? minlaExactContiguous(inst, domOf) : null;
    if (exact) {
      // Small + milp → the PROVEN-optimal cohesive arrangement.
      perm = exact;
      optimal = true;
    } else {
      // Larger / annealing → the two-level `domain_enum` decomposition. Even
      // when its sub-solves are exact they don't compose into a global proof
      // (the supergraph ignores block widths; sub-solves drop cross-domain
      // edges), so optimal is always false here.
      const dAdj: Array<Map<number, number>> = domains.map(() => new Map());
      for (let a = 0; a < inst.n; a++) {
        for (const [b, w] of inst.adj[a]) {
          if (b <= a) continue;
          const da = domOf[a];
          const db = domOf[b];
          if (da === db) continue;
          dAdj[da].set(db, (dAdj[da].get(db) ?? 0) + w);
          dAdj[db].set(da, (dAdj[db].get(da) ?? 0) + w);
        }
      }
      const exactSub = opts.method === 'milp';
      const domSolved = minlaSolve({ n: domains.length, adj: dAdj }, opts.seed, exactSub);
      perm = [];
      for (const di of domSolved.perm) {
        const members = memberIdx.get(domains[di])!;
        const local = new Map(members.map((gi, i) => [gi, i] as const));
        const sAdj: Array<Map<number, number>> = members.map(() => new Map());
        members.forEach((gi, i) => {
          for (const [b, w] of inst.adj[gi]) {
            const j = local.get(b);
            if (j !== undefined) sAdj[i].set(j, w);
          }
        });
        const seed = (opts.seed ^ hashSeed(domains[di])) >>> 0;
        const sub = minlaSolve({ n: members.length, adj: sAdj }, seed, exactSub);
        for (const i of sub.perm) perm.push(members[i]);
      }
      optimal = false;
    }
  }
  return {
    order: perm.map((i) => groups[i]),
    cost: minlaCost(perm, inst.adj),
    baseline,
    optimal,
  };
}

/** Kahn topological order; ties by descending weight; cycles broken deterministically. */
function topoOrder(
  ids: ElementId[],
  precedence: Map<ElementId, Set<ElementId>>,
  weight: Map<ElementId, number>,
): ElementId[] {
  const idSet = new Set(ids);
  const indeg = new Map<ElementId, number>();
  const succ = new Map<ElementId, ElementId[]>();
  for (const g of ids) {
    indeg.set(g, 0);
    succ.set(g, []);
  }
  for (const g of ids) {
    for (const p of precedence.get(g) ?? []) {
      if (!idSet.has(p)) continue; // p precedes g
      indeg.set(g, indeg.get(g)! + 1);
      succ.get(p)!.push(g);
    }
  }
  const cmp = (a: ElementId, b: ElementId) =>
    (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || (a < b ? -1 : 1);
  const ready = ids.filter((g) => indeg.get(g) === 0).sort(cmp);
  const out: ElementId[] = [];
  const done = new Set<ElementId>();
  while (ready.length) {
    const g = ready.shift()!;
    if (done.has(g)) continue;
    out.push(g);
    done.add(g);
    for (const s of succ.get(g)!) {
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) {
        // insert keeping the ready list sorted
        ready.push(s);
        ready.sort(cmp);
      }
    }
  }
  // Any remaining (cycle members) → append by weight, breaking the cycle.
  for (const g of ids.filter((x) => !done.has(x)).sort(cmp)) out.push(g);
  return out;
}

/* ──────────────────────────────── packing ────────────────────────────────── */

interface PackOpts {
  precedence?: Map<ElementId, Set<ElementId>>;
  /** When set, a change of key vs. the previous group starts a fresh wave. */
  boundaryKey?: (g: PlanGroup) => string;
  /** First-fit (fill earliest wave with room) vs next-fit (only the last wave). */
  firstFit: boolean;
}

/** Bin-pack ordered groups into capacity-bounded waves (respecting precedence). */
function pack(ordered: PlanGroup[], capacity: number, opts: PackOpts): PlanGroup[][] {
  const cap = capacity > 0 ? capacity : 1;
  const waves: PlanGroup[][] = [];
  const load: number[] = [];
  const waveOf = new Map<ElementId, number>();
  let prevKey: string | undefined;
  for (const g of ordered) {
    let minWave = 0;
    if (opts.precedence) {
      for (const p of opts.precedence.get(g.id) ?? []) {
        const pw = waveOf.get(p);
        if (pw !== undefined) minWave = Math.max(minWave, pw);
      }
    }
    const key = opts.boundaryKey?.(g);
    const boundary = key !== undefined && prevKey !== undefined && key !== prevKey;
    let target: number;
    if (g.oversized || boundary) {
      target = Math.max(waves.length, minWave);
    } else if (opts.firstFit) {
      target = -1;
      for (let w = minWave; w < waves.length; w++) {
        if (load[w] + g.workload <= cap) {
          target = w;
          break;
        }
      }
      if (target < 0) target = Math.max(waves.length, minWave);
    } else {
      const last = waves.length - 1;
      target =
        last >= minWave && last >= 0 && load[last] + g.workload <= cap
          ? last
          : Math.max(waves.length, minWave);
    }
    while (waves.length <= target) {
      waves.push([]);
      load.push(0);
    }
    waves[target].push(g);
    load[target] += g.workload;
    waveOf.set(g.id, target);
    prevKey = key;
  }
  return waves;
}

/**
 * Reorder a sequence into contiguous domain blocks — domains ordered by first
 * appearance, the original order preserved within each domain. Turns any
 * ordering into a cohesion-respecting one (each functional block unbroken).
 */
function domainContiguous(seq: PlanGroup[]): PlanGroup[] {
  const blocks = new Map<string, PlanGroup[]>();
  const order: string[] = [];
  for (const g of seq) {
    let b = blocks.get(g.domain);
    if (!b) {
      b = [];
      blocks.set(g.domain, b);
      order.push(g.domain);
    }
    b.push(g);
  }
  return order.flatMap((d) => blocks.get(d)!);
}

/* ──────────────────────────────── buildPlan ──────────────────────────────── */

export function buildPlan(model: Model, config: PlanConfig): PlanModel {
  const capacity = config.capacity > 0 ? config.capacity : 1;

  // Atomic facets (over all non-library candidates carrying no relationship role).
  const facet = new Map<string, number>();
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || (el.source?.length ?? 0) > 0) continue;
    facet.set(el.eClass, (facet.get(el.eClass) ?? 0) + 1);
  }
  const atomics = model
    .all()
    .filter((el) => el.eClass === config.atomicKind && el.attrs.isLibrary !== true);

  // Group each atomic.
  const atomicToGroup = new Map<ElementId, ElementId>();
  const groups = new Map<ElementId, PlanGroup>();
  const ungrouped: PlanMember[] = [];
  let totalWorkload = 0;
  for (const a of atomics) {
    const w = workloadOf(model, a, config.workloadAttr);
    totalWorkload += w;
    const gid = groupIdOf(model, a, config);
    const member: PlanMember = { id: a.id, label: labelOf(a), workload: w };
    if (!gid) {
      ungrouped.push(member);
      continue;
    }
    atomicToGroup.set(a.id, gid);
    let grp = groups.get(gid);
    if (!grp) {
      const gel = model.get(gid)!;
      const owner = gel.ownerId ? model.get(gel.ownerId) : undefined;
      grp = {
        id: gid,
        label: labelOf(gel),
        eClass: gel.eClass,
        workload: 0,
        members: [],
        domain: owner ? labelOf(owner) : '(root)',
        community: -1,
        oversized: false,
      };
      groups.set(gid, grp);
    }
    grp.members.push(member);
    grp.workload += w;
  }
  for (const g of groups.values()) g.oversized = g.workload > capacity;

  const groupIds = new Set(groups.keys());
  const weight = new Map([...groups.values()].map((g) => [g.id, g.workload]));

  // Coupling graph (w_ij = #cross-group relationships) → Louvain communities
  // (used by 'coupling' ordering + shown on groups) + the MinLA objective.
  const cgraph = couplingGraph(model, atomicToGroup, groupIds);
  const commMap = groupIds.size ? louvain(cgraph) : new Map<string, number>();
  for (const g of groups.values()) g.community = commMap.get(g.id) ?? 0;

  // Ordering → an ordered group sequence + the packer options.
  const all = [...groups.values()];
  let ordered: PlanGroup[];
  let opts: PackOpts;
  let optimalOrder = false;
  if (config.ordering === 'milp' || config.ordering === 'annealing') {
    // MinLA optimization layer (DOORS MILP / simulated-annealing port).
    const seed = hashSeed(all.map((g) => g.id).join('|'));
    const res = orderByMinLA(all, cgraph, {
      cohesion: config.cohesion,
      method: config.ordering,
      seed,
    });
    ordered = res.order;
    optimalOrder = res.optimal;
    // Next-fit preserves the linear MinLA adjacency across waves; with cohesion
    // on, a domain change also starts a fresh wave (hard same-window rule).
    opts = config.cohesion
      ? { firstFit: false, boundaryKey: (g) => g.domain }
      : { firstFit: false };
  } else if (config.ordering === 'dependency') {
    const prec = precedenceOf(model, atomicToGroup, groupIds);
    ordered = topoOrder(all.map((g) => g.id), prec, weight).map((id) => groups.get(id)!);
    opts = { firstFit: true, precedence: prec };
  } else if (config.ordering === 'domain-first') {
    // Order domains by total workload desc; within a domain by workload desc.
    const domTot = new Map<string, number>();
    for (const g of all) domTot.set(g.domain, (domTot.get(g.domain) ?? 0) + g.workload);
    ordered = [...all].sort(
      (a, b) =>
        (domTot.get(b.domain) ?? 0) - (domTot.get(a.domain) ?? 0) ||
        (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0) ||
        b.workload - a.workload ||
        (a.id < b.id ? -1 : 1),
    );
    opts = { firstFit: false, boundaryKey: (g) => g.domain };
  } else if (config.ordering === 'coupling') {
    const commTot = new Map<number, number>();
    for (const g of all) commTot.set(g.community, (commTot.get(g.community) ?? 0) + g.workload);
    const seq = [...all].sort(
      (a, b) =>
        (commTot.get(b.community) ?? 0) - (commTot.get(a.community) ?? 0) ||
        a.community - b.community ||
        b.workload - a.workload ||
        (a.id < b.id ? -1 : 1),
    );
    // Cohesion is a HARD modifier: reorder the community sequence into
    // contiguous domain blocks (so a functional block never splits across
    // non-adjacent waves), and break waves on the domain boundary.
    ordered = config.cohesion ? domainContiguous(seq) : seq;
    opts = {
      firstFit: false,
      boundaryKey: config.cohesion ? (g) => g.domain : (g) => String(g.community),
    };
  } else {
    // capacity-balanced: first-fit-decreasing.
    ordered = [...all].sort((a, b) => b.workload - a.workload || (a.id < b.id ? -1 : 1));
    opts = { firstFit: true };
  }

  const packed = pack(ordered, capacity, opts);

  // Coupling-cost telemetry (the MinLA objective) — scored over the PACKED
  // board (the order the user actually sees), so first-fit re-slotting can't
  // make the readout claim an improvement the visible board doesn't show. For
  // the next-fit orderings the board equals `ordered`, so this is unchanged
  // there; `couplingBaseline` = the natural group-insertion order.
  const inst = buildMinLAInstance(cgraph, all.map((g) => g.id));
  const posOf = new Map(all.map((g, i) => [g.id, i] as const));
  const couplingBaseline = minlaCost(all.map((_, i) => i), inst.adj);
  const couplingCost = minlaCost(
    packed.flat().map((g) => posOf.get(g.id)!),
    inst.adj,
  );
  const waves: PlanWave[] = packed.map((gs, i) => {
    const workload = gs.reduce((s, g) => s + g.workload, 0);
    return {
      index: i,
      label: `${titleCase(config.timeUnit)} ${i + 1}`,
      groups: gs,
      workload,
      capacity,
      utilization: workload / capacity,
    };
  });

  return {
    waves,
    ungrouped,
    totalWorkload,
    groupCount: groups.size,
    atomicCount: atomics.length,
    span: waves.length,
    timeUnit: config.timeUnit,
    capacity,
    atomicKindsPresent: [...facet.entries()]
      .map(([eClass, count]) => ({ eClass, count }))
      .sort((a, b) => b.count - a.count || (a.eClass < b.eClass ? -1 : 1)),
    couplingCost,
    couplingBaseline,
    optimalOrder,
  };
}

function titleCase(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** A sensible default plan config (requirements → satisfy → weekly waves, dependency order). */
export function defaultPlanConfig(): PlanConfig {
  return {
    atomicKind: 'RequirementUsage',
    workloadAttr: 'effort',
    grouping: 'satisfy',
    timeUnit: 'week',
    capacity: 40,
    ordering: 'dependency',
    cohesion: false,
  };
}

/**
 * graph-algorithms — pure, deterministic network-analysis primitives powering
 * the Graph Analysis view (a Gephi-style workbench) and the DSM matrix.
 *
 * Everything here operates on a plain {@link Graph} (string node ids + weighted
 * edges) — no SysML/`Model` coupling, no React, no DOM — so it is exhaustively
 * unit-testable. All randomness goes through a SEEDED PRNG so results are
 * REPRODUCIBLE across runs, machines, and collab clients (the codebase forbids
 * `Math.random`/`Date.now` for exactly this reason).
 *
 * Contents:
 *  - community detection: {@link louvain} (modularity), {@link labelPropagation},
 *    {@link connectedComponents};
 *  - centrality: {@link degreeCentrality}, {@link pageRank};
 *  - layout: {@link forceLayout} (Fruchterman–Reingold), {@link circularLayout},
 *    {@link gridLayout};
 *  - DSM module identification: {@link dsmOrderByCommunity} (Louvain modules),
 *    {@link cuthillMcKee} (bandwidth minimisation).
 */

/** A weighted (optionally directed) graph over string node ids. */
export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}
export interface Graph {
  nodes: string[];
  edges: GraphEdge[];
}

export interface Point {
  x: number;
  y: number;
}

/* ─────────────────────────── seeded PRNG (mulberry32) ─────────────────────── */

/** Deterministic PRNG in [0,1). Seed derived from a string for stability. */
export function makeRng(seed = 0x9e3779b9): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (for seeding a layout deterministically). */
export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ──────────────────────────── adjacency helpers ──────────────────────────── */

interface Adjacency {
  /** node id → list of [neighbor id, summed undirected weight]. */
  nbrs: Map<string, Map<string, number>>;
  /** node id → weighted degree (sum of incident weights; self-loops doubled). */
  degree: Map<string, number>;
  /** total edge weight m (each undirected edge counted once). */
  m: number;
}

/** Build a symmetric weighted adjacency (self-loops kept; parallel edges summed). */
function buildAdjacency(graph: Graph): Adjacency {
  const nbrs = new Map<string, Map<string, number>>();
  const degree = new Map<string, number>();
  for (const n of graph.nodes) {
    nbrs.set(n, new Map());
    degree.set(n, 0);
  }
  let m = 0;
  const add = (a: string, b: string, w: number) => {
    if (!nbrs.has(a) || !nbrs.has(b)) return;
    nbrs.get(a)!.set(b, (nbrs.get(a)!.get(b) ?? 0) + w);
  };
  for (const e of graph.edges) {
    const w = e.weight > 0 ? e.weight : 1;
    if (!nbrs.has(e.source) || !nbrs.has(e.target)) continue;
    m += w;
    if (e.source === e.target) {
      add(e.source, e.source, w);
      degree.set(e.source, (degree.get(e.source) ?? 0) + 2 * w);
    } else {
      add(e.source, e.target, w);
      add(e.target, e.source, w);
      degree.set(e.source, (degree.get(e.source) ?? 0) + w);
      degree.set(e.target, (degree.get(e.target) ?? 0) + w);
    }
  }
  return { nbrs, degree, m };
}

/* ─────────────────────────── connected components ────────────────────────── */

/** Weakly-connected components → community index per node (0-based, stable). */
export function connectedComponents(graph: Graph): Map<string, number> {
  const { nbrs } = buildAdjacency(graph);
  const comm = new Map<string, number>();
  let next = 0;
  for (const start of graph.nodes) {
    if (comm.has(start)) continue;
    const c = next++;
    const stack = [start];
    comm.set(start, c);
    while (stack.length) {
      const u = stack.pop()!;
      for (const v of nbrs.get(u)!.keys()) {
        if (!comm.has(v)) {
          comm.set(v, c);
          stack.push(v);
        }
      }
    }
  }
  return comm;
}

/* ───────────────────────── Louvain community detection ───────────────────── */

/**
 * Louvain modularity-maximising community detection (Blondel et al. 2008): local
 * moving of nodes to the neighbouring community that most increases modularity,
 * then aggregation into a coarser graph, repeated to a fixpoint. Returns a stable
 * 0-based community index per node. Deterministic: nodes are visited in the
 * given order and ties resolved toward the lowest community index.
 */
export function louvain(graph: Graph, resolution = 1): Map<string, number> {
  if (graph.nodes.length === 0) return new Map();
  // Work on integer-indexed nodes for speed; map back at the end.
  const index = new Map<string, number>();
  graph.nodes.forEach((n, i) => index.set(n, i));

  // Level graph: adjacency as arrays; selfLoop weight per node.
  let n = graph.nodes.length;
  let adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  let selfLoop = new Array<number>(n).fill(0);
  let m = 0;
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined) continue;
    const w = e.weight > 0 ? e.weight : 1;
    m += w;
    if (a === b) selfLoop[a] += w;
    else {
      adj[a].set(b, (adj[a].get(b) ?? 0) + w);
      adj[b].set(a, (adj[b].get(a) ?? 0) + w);
    }
  }
  if (m === 0) return new Map(graph.nodes.map((nd, i) => [nd, i]));

  // `membership[i]` maps an ORIGINAL node to its current top-level community.
  const membership = new Array<number>(graph.nodes.length);
  for (let i = 0; i < graph.nodes.length; i++) membership[i] = i;

  for (let level = 0; level < 20; level++) {
    const deg = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let d = 2 * selfLoop[i];
      for (const w of adj[i].values()) d += w;
      deg[i] = d;
    }
    const twoM = 2 * m;
    // community of each level-node; sigmaTot = sum of degrees in community.
    const comm = new Array<number>(n);
    for (let i = 0; i < n; i++) comm[i] = i;
    const sigmaTot = deg.slice();

    let improvedAny = false;
    let moved = true;
    let guard = 0;
    while (moved && guard++ < 100) {
      moved = false;
      for (let i = 0; i < n; i++) {
        const ci = comm[i];
        // weight from i to each neighbouring community.
        const wToComm = new Map<number, number>();
        for (const [j, w] of adj[i]) {
          const cj = comm[j];
          wToComm.set(cj, (wToComm.get(cj) ?? 0) + w);
        }
        // remove i from its community.
        sigmaTot[ci] -= deg[i];
        const wiIn = wToComm.get(ci) ?? 0;
        // pick best community (start with staying).
        let bestC = ci;
        let bestGain = (wToComm.get(ci) ?? 0) - (resolution * sigmaTot[ci] * deg[i]) / twoM;
        for (const [c, wic] of wToComm) {
          if (c === ci) continue;
          const gain = wic - (resolution * sigmaTot[c] * deg[i]) / twoM;
          if (gain > bestGain + 1e-12 || (gain > bestGain - 1e-12 && c < bestC)) {
            bestGain = gain;
            bestC = c;
          }
        }
        sigmaTot[bestC] += deg[i];
        if (bestC !== ci) {
          comm[i] = bestC;
          moved = true;
          improvedAny = true;
        }
        void wiIn;
      }
    }

    // Relabel communities to 0..k-1 (stable by first appearance).
    const relabel = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (!relabel.has(comm[i])) relabel.set(comm[i], relabel.size);
      comm[i] = relabel.get(comm[i])!;
    }
    const k = relabel.size;

    // Propagate to original nodes.
    for (let i = 0; i < membership.length; i++) membership[i] = comm[membership[i]];

    if (!improvedAny || k === n) break;

    // Aggregate: build the community graph for the next level.
    const nAdj: Array<Map<number, number>> = Array.from({ length: k }, () => new Map());
    const nSelf = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const ci = comm[i];
      nSelf[ci] += selfLoop[i];
      for (const [j, w] of adj[i]) {
        const cj = comm[j];
        if (ci === cj) {
          // each intra edge counted from both endpoints → halve into self-loop.
          nSelf[ci] += w / 2;
        } else {
          nAdj[ci].set(cj, (nAdj[ci].get(cj) ?? 0) + w);
        }
      }
    }
    adj = nAdj;
    selfLoop = nSelf;
    n = k;
  }

  // Final relabel of the original-node memberships to 0..K-1 by first appearance.
  const finalLabel = new Map<number, number>();
  const out = new Map<string, number>();
  graph.nodes.forEach((nd, i) => {
    const c = membership[i];
    if (!finalLabel.has(c)) finalLabel.set(c, finalLabel.size);
    out.set(nd, finalLabel.get(c)!);
  });
  return out;
}

/**
 * Modularity Q of a partition (for tests / algorithm comparison):
 * `Q = Σ_c [ Σ_in(c)/2m − (Σ_tot(c)/2m)² ]`, where `Σ_in` sums the weights of
 * edges internal to community `c` (each undirected edge counted twice) and
 * `Σ_tot` sums the degrees of `c`'s nodes. Computed by per-community aggregation
 * so the expected-weight term covers NON-adjacent same-community pairs too.
 */
export function modularity(graph: Graph, comm: Map<string, number>): number {
  const { nbrs, degree, m } = buildAdjacency(graph);
  if (m === 0) return 0;
  const twoM = 2 * m;
  const sumIn = new Map<number, number>();
  const sumTot = new Map<number, number>();
  for (const i of graph.nodes) {
    const c = comm.get(i) ?? 0;
    sumTot.set(c, (sumTot.get(c) ?? 0) + (degree.get(i) ?? 0));
    for (const [j, w] of nbrs.get(i)!) {
      // A normal internal edge is seen from both endpoints (2w total); a
      // self-loop appears once in `nbrs` but is fully internal, so it counts
      // twice — matching `degree`, which doubles self-loops.
      if ((comm.get(j) ?? 0) === c) sumIn.set(c, (sumIn.get(c) ?? 0) + (j === i ? 2 * w : w));
    }
  }
  let q = 0;
  for (const c of sumTot.keys()) {
    const sin = sumIn.get(c) ?? 0;
    const stot = sumTot.get(c) ?? 0;
    q += sin / twoM - (stot / twoM) ** 2;
  }
  return q;
}

/* ─────────────────────────── label propagation ──────────────────────────── */

/**
 * Label propagation community detection (Raghavan et al. 2007): each node adopts
 * the label carried by the greatest total edge weight among its neighbours;
 * repeated until stable. Deterministic (fixed visit order, lowest-label tie-break)
 * and near-linear — a fast alternative to Louvain.
 */
export function labelPropagation(graph: Graph, maxIter = 50): Map<string, number> {
  const { nbrs } = buildAdjacency(graph);
  const label = new Map<string, number>();
  graph.nodes.forEach((n, i) => label.set(n, i));
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (const u of graph.nodes) {
      const tally = new Map<number, number>();
      for (const [v, w] of nbrs.get(u)!) tally.set(label.get(v)!, (tally.get(label.get(v)!) ?? 0) + w);
      if (tally.size === 0) continue;
      let best = label.get(u)!;
      let bestW = -1;
      for (const [lab, w] of tally) {
        if (w > bestW + 1e-12 || (Math.abs(w - bestW) < 1e-12 && lab < best)) {
          bestW = w;
          best = lab;
        }
      }
      if (best !== label.get(u)) {
        label.set(u, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Relabel to 0..k-1 by first appearance.
  const relabel = new Map<number, number>();
  const out = new Map<string, number>();
  for (const n of graph.nodes) {
    const l = label.get(n)!;
    if (!relabel.has(l)) relabel.set(l, relabel.size);
    out.set(n, relabel.get(l)!);
  }
  return out;
}

/* ──────────────────────────────── centrality ─────────────────────────────── */

/** Weighted degree centrality per node. */
export function degreeCentrality(graph: Graph): Map<string, number> {
  const { degree } = buildAdjacency(graph);
  return degree;
}

/**
 * Directed weighted in-/out-degree per node (edges honour source→target).
 * `in[v]` = Σ weight of edges INTO v, `out[v]` = Σ weight of edges OUT of v, and
 * `total[v]` = `in[v] + out[v]`; a self-loop counts toward BOTH in and out (so
 * `total` includes it too — unlike {@link degreeCentrality}, which is only
 * self-loop-equivalent on a graph with no self-loops). Powers the Gephi-style
 * "size by degree / in-degree / out-degree".
 */
export function directedDegree(graph: Graph): {
  in: Map<string, number>;
  out: Map<string, number>;
  total: Map<string, number>;
} {
  const inD = new Map<string, number>();
  const outD = new Map<string, number>();
  const total = new Map<string, number>();
  for (const n of graph.nodes) {
    inD.set(n, 0);
    outD.set(n, 0);
    total.set(n, 0);
  }
  for (const e of graph.edges) {
    if (!inD.has(e.source) || !inD.has(e.target)) continue;
    const w = e.weight > 0 ? e.weight : 1;
    outD.set(e.source, (outD.get(e.source) ?? 0) + w);
    inD.set(e.target, (inD.get(e.target) ?? 0) + w);
    total.set(e.source, (total.get(e.source) ?? 0) + w);
    total.set(e.target, (total.get(e.target) ?? 0) + w);
  }
  return { in: inD, out: outD, total };
}

/**
 * PageRank (Brin & Page) via power iteration with damping `d`. Directed: uses
 * out-edges; dangling nodes redistribute uniformly. Converges to a stationary
 * distribution summing to 1.
 */
export function pageRank(graph: Graph, d = 0.85, iters = 60): Map<string, number> {
  const n = graph.nodes.length;
  const pr = new Map<string, number>();
  if (n === 0) return pr;
  for (const nd of graph.nodes) pr.set(nd, 1 / n);
  const outW = new Map<string, number>();
  const outEdges = new Map<string, GraphEdge[]>();
  for (const nd of graph.nodes) outEdges.set(nd, []);
  for (const e of graph.edges) {
    if (!outEdges.has(e.source) || !pr.has(e.target)) continue;
    const w = e.weight > 0 ? e.weight : 1;
    outEdges.get(e.source)!.push({ ...e, weight: w });
    outW.set(e.source, (outW.get(e.source) ?? 0) + w);
  }
  for (let it = 0; it < iters; it++) {
    const next = new Map<string, number>();
    for (const nd of graph.nodes) next.set(nd, (1 - d) / n);
    let dangling = 0;
    for (const nd of graph.nodes) {
      const tot = outW.get(nd) ?? 0;
      if (tot === 0) dangling += pr.get(nd)!;
      else {
        for (const e of outEdges.get(nd)!) {
          next.set(e.target, next.get(e.target)! + (d * pr.get(nd)! * e.weight) / tot);
        }
      }
    }
    if (dangling > 0) {
      const share = (d * dangling) / n;
      for (const nd of graph.nodes) next.set(nd, next.get(nd)! + share);
    }
    for (const nd of graph.nodes) pr.set(nd, next.get(nd)!);
  }
  return pr;
}

/* ──────────────────────────────── layouts ────────────────────────────────── */

/** Circular layout, optionally grouped so a `group` key clusters contiguously. */
export function circularLayout(
  nodes: string[],
  group?: Map<string, number>,
  radius = 400,
): Map<string, Point> {
  const ordered = group
    ? [...nodes].sort((a, b) => (group.get(a) ?? 0) - (group.get(b) ?? 0) || (a < b ? -1 : 1))
    : nodes;
  const pos = new Map<string, Point>();
  const k = Math.max(1, ordered.length);
  ordered.forEach((n, i) => {
    const a = (2 * Math.PI * i) / k;
    pos.set(n, { x: radius * Math.cos(a), y: radius * Math.sin(a) });
  });
  return pos;
}

/** Deterministic grid layout (row-major, ceil(sqrt(n)) columns). */
export function gridLayout(nodes: string[], spacing = 120): Map<string, Point> {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const pos = new Map<string, Point>();
  nodes.forEach((n, i) => {
    pos.set(n, { x: (i % cols) * spacing, y: Math.floor(i / cols) * spacing });
  });
  return pos;
}

/**
 * Fruchterman–Reingold force-directed layout — the Gephi/ForceAtlas2 analog.
 * Repulsion between all node pairs (∝ k²/d), attraction along edges (∝ d²/k),
 * with a cooling schedule. Strongly-connected groups collapse together and loose
 * parts drift apart, so community structure is visible spatially. Deterministic
 * (positions seeded from node-id hashes; no `Math.random`).
 */
export function forceLayout(
  graph: Graph,
  opts: { iterations?: number; width?: number; height?: number; gravity?: number } = {},
): Map<string, Point> {
  const nodes = graph.nodes;
  const n = nodes.length;
  const pos = new Map<string, Point>();
  if (n === 0) return pos;
  const W = opts.width ?? 1000;
  const H = opts.height ?? 1000;
  const iterations = opts.iterations ?? 300;
  const gravity = opts.gravity ?? 0.05;
  const area = W * H;
  const k = 0.9 * Math.sqrt(area / n); // ideal edge length
  // Seed positions deterministically from a hash of the id (spread on a disc).
  for (const id of nodes) {
    const r = makeRng(hashSeed(id));
    const ang = r() * 2 * Math.PI;
    const rad = Math.sqrt(r()) * Math.min(W, H) * 0.5;
    pos.set(id, { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad });
  }
  if (n === 1) {
    pos.set(nodes[0], { x: 0, y: 0 });
    return pos;
  }
  // Aggregate edge weights per undirected pair for attraction.
  const edges: Array<[string, string, number]> = [];
  for (const e of graph.edges) {
    if (e.source === e.target) continue;
    if (!pos.has(e.source) || !pos.has(e.target)) continue;
    edges.push([e.source, e.target, e.weight > 0 ? e.weight : 1]);
  }
  let temp = Math.min(W, H) * 0.1;
  const cool = temp / (iterations + 1);
  const disp = new Map<string, Point>();
  for (let it = 0; it < iterations; it++) {
    for (const id of nodes) disp.set(id, { x: 0, y: 0 });
    // Repulsion (O(n²) — fine for analysis-scale graphs; capped by node count).
    for (let i = 0; i < n; i++) {
      const a = pos.get(nodes[i])!;
      const da = disp.get(nodes[i])!;
      for (let j = i + 1; j < n; j++) {
        const b = pos.get(nodes[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = (hashSeed(nodes[i] + nodes[j]) % 100) / 100 - 0.5 + 0.01;
          dy = (hashSeed(nodes[j] + nodes[i]) % 100) / 100 - 0.5 + 0.01;
          dist = Math.hypot(dx, dy);
          if (dist < 1e-6) {
            // Both jitter components hashed to ~0 — nudge deterministically so
            // the repulsion below never divides by zero (→ NaN positions).
            dx = 0.01;
            dy = 0;
            dist = 0.01;
          }
        }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        da.x += fx;
        da.y += fy;
        const db = disp.get(nodes[j])!;
        db.x -= fx;
        db.y -= fy;
      }
    }
    // Attraction along edges.
    for (const [s, t, w] of edges) {
      const a = pos.get(s)!;
      const b = pos.get(t)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.max(0.01, Math.hypot(dx, dy));
      const force = ((dist * dist) / k) * w;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp.get(s)!.x -= fx;
      disp.get(s)!.y -= fy;
      disp.get(t)!.x += fx;
      disp.get(t)!.y += fy;
    }
    // Gravity toward the centre (keeps disconnected parts on-screen).
    for (const id of nodes) {
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      d.x -= p.x * gravity;
      d.y -= p.y * gravity;
    }
    // Apply displacement, capped by the current temperature.
    for (const id of nodes) {
      const d = disp.get(id)!;
      const len = Math.max(0.01, Math.hypot(d.x, d.y));
      const p = pos.get(id)!;
      p.x += (d.x / len) * Math.min(len, temp);
      p.y += (d.y / len) * Math.min(len, temp);
    }
    temp = Math.max(0, temp - cool);
  }
  return pos;
}

/* ─────────────────────────── DSM module ordering ─────────────────────────── */

/**
 * Order nodes so community (module) members are contiguous — modules then form
 * dense blocks on the DSM diagonal. Within a module, orders by descending
 * degree (hubs first). Returns the node id sequence + each node's module index.
 */
export function dsmOrderByCommunity(
  graph: Graph,
  comm: Map<string, number>,
): { order: string[]; module: Map<string, number> } {
  const { degree } = buildAdjacency(graph);
  // Order modules by size (largest first) for a readable top-left block.
  const byComm = new Map<number, string[]>();
  for (const nd of graph.nodes) {
    const c = comm.get(nd) ?? 0;
    if (!byComm.has(c)) byComm.set(c, []);
    byComm.get(c)!.push(nd);
  }
  const modsSorted = [...byComm.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0] - b[0],
  );
  const order: string[] = [];
  const module = new Map<string, number>();
  modsSorted.forEach(([, members], idx) => {
    members
      .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : 1))
      .forEach((nd) => {
        order.push(nd);
        module.set(nd, idx);
      });
  });
  return { order, module };
}

/**
 * Cuthill–McKee reordering — minimises the DSM bandwidth (pulls interacting
 * elements toward the diagonal) via a BFS from a low-degree start, visiting
 * neighbours in increasing-degree order. A classic alternative to modular
 * clustering that emphasises sequencing/flow rather than blocks.
 */
export function cuthillMcKee(graph: Graph): string[] {
  const { nbrs, degree } = buildAdjacency(graph);
  const visited = new Set<string>();
  const order: string[] = [];
  const remaining = [...graph.nodes].sort(
    (a, b) => (degree.get(a) ?? 0) - (degree.get(b) ?? 0) || (a < b ? -1 : 1),
  );
  for (const start of remaining) {
    if (visited.has(start)) continue;
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const u = queue.shift()!;
      order.push(u);
      const next = [...nbrs.get(u)!.keys()]
        .filter((v) => !visited.has(v))
        .sort((a, b) => (degree.get(a) ?? 0) - (degree.get(b) ?? 0) || (a < b ? -1 : 1));
      for (const v of next) {
        visited.add(v);
        queue.push(v);
      }
    }
  }
  return order;
}

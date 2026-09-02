/**
 * graph-analysis — build the Graph Analysis view model + DSM from a SysML v2
 * {@link Model}, applying the view FILTER and the selected analysis algorithms
 * ({@link ./graph-algorithms}). Pure + deterministic (no React, no DOM).
 *
 * A NODE is any non-library, non-annotation element that carries NO endpoints
 * (a true vertex: part, use case, action, requirement, …). An EDGE is any
 * element that carries BOTH a source and a target (relationship metaclasses AND
 * endpoint-bearing usages such as ConnectionUsage/Flow/Succession) — plus, when
 * `'containment'` is in the edge filter, synthesized owner→child edges.
 */

import type { ElementId, ElementRecord } from '@core/index';
import { Model, isAnnotation } from '@core/index';
import type {
  AnalysisConfig,
  AnalysisLegendEntry,
  DSMModel,
  GraphAnalysisEdge,
  GraphAnalysisModel,
  GraphAnalysisNode,
} from './types';
import {
  type Graph,
  circularLayout,
  connectedComponents,
  cuthillMcKee,
  directedDegree,
  dsmOrderByCommunity,
  forceLayout,
  gridLayout,
  labelPropagation,
  louvain,
  modularity,
  pageRank,
} from './graph-algorithms';

/* ─────────────────────────── categories + palette ────────────────────────── */

/** Coarse category of a metaclass — drives default color + the filter presets. */
export function categoryOf(eClass: string): string {
  if (eClass.startsWith('Part')) return 'block';
  if (eClass.startsWith('UseCase')) return 'usecase';
  if (eClass.startsWith('Action') || eClass.endsWith('ActionUsage')) return 'action';
  if (eClass.startsWith('State')) return 'state';
  if (eClass.startsWith('Requirement') || eClass.startsWith('Constraint')) return 'requirement';
  if (eClass.startsWith('Port')) return 'port';
  if (eClass.startsWith('Interface')) return 'interface';
  if (eClass.startsWith('Attribute') || eClass.startsWith('Item') || eClass.startsWith('Value'))
    return 'item';
  if (eClass.startsWith('Analysis') || eClass.startsWith('Case') || eClass.startsWith('Calculation'))
    return 'analysis';
  if (eClass === 'Package' || eClass === 'Namespace' || eClass.startsWith('Enumeration'))
    return 'container';
  return 'other';
}

/** Default per-category colors, chosen to be clearly distinguishable. */
export const CATEGORY_COLORS: Record<string, string> = {
  block: '#2b6cb0', // blue      — functional blocks (parts)
  usecase: '#c05621', // orange  — use cases
  action: '#2f855a', // green    — behavior / actions
  state: '#6b46c1', // purple    — states
  requirement: '#c53030', // red — requirements / constraints
  port: '#2c7a7b', // teal       — ports
  interface: '#805ad5', // violet
  item: '#b7791f', // amber      — items / attributes / values
  analysis: '#d53f8c', // pink   — analysis / case / calc
  container: '#4a5568', // slate — packages
  other: '#718096', // gray
};

export const CATEGORY_LABELS: Record<string, string> = {
  block: 'Functional block',
  usecase: 'Use case',
  action: 'Action / behavior',
  state: 'State',
  requirement: 'Requirement',
  port: 'Port',
  interface: 'Interface',
  item: 'Item / value',
  analysis: 'Analysis / case',
  container: 'Package',
  other: 'Other',
};

/** Categorical palette for communities / DSM modules (12 distinct hues). */
export const COMMUNITY_PALETTE: string[] = [
  '#3182ce', '#dd6b20', '#38a169', '#805ad5', '#d53f8c', '#319795',
  '#d69e2e', '#e53e3e', '#00a3c4', '#718096', '#9f7aea', '#2c5282',
];

/** Single-glyph badge for a relation metaclass (shown in DSM cells). */
export function relationSymbol(kind: string): string {
  const map: Record<string, string> = {
    Satisfy: 'S',
    SatisfyRequirementUsage: 'S',
    Verify: 'V',
    Refine: 'R',
    Trace: 'T',
    Derive: 'D',
    Allocation: 'A',
    Dependency: 'd',
    ConnectionUsage: 'C',
    Connector: 'C',
    Flow: 'F',
    FlowUsage: 'F',
    Succession: '→',
    SuccessionFlow: '→',
    TransitionUsage: 't',
    Subclassification: '▲',
    Subsetting: '⊂',
    Redefinition: '≔',
    FeatureTyping: ':',
    ReferenceSubsetting: '⊂',
  };
  if (map[kind]) return map[kind];
  if (kind.includes('Specialization')) return '▲';
  return '•';
}

/** A sensible default analysis config (force layout, Louvain clusters, degree size). */
export function defaultAnalysisConfig(): AnalysisConfig {
  return {
    nodeKinds: [],
    edgeKinds: [],
    layout: 'force',
    clustering: 'louvain',
    sizeBy: 'degree',
    sizeScale: 1,
    sizeContrast: 1,
    colorBy: 'type',
    colorOverrides: {},
    mode: 'graph',
    dsmOrder: 'louvain',
  };
}

/* ───────────────────────── model → graph extraction ──────────────────────── */

const isNodeCandidate = (el: ElementRecord): boolean =>
  el.attrs.isLibrary !== true &&
  el.attrs.implicit !== true &&
  !isAnnotation(el.eClass) &&
  (el.source?.length ?? 0) === 0 &&
  (el.target?.length ?? 0) === 0;

const isEdgeElement = (el: ElementRecord): boolean =>
  el.attrs.isLibrary !== true && (el.source?.length ?? 0) > 0 && (el.target?.length ?? 0) > 0;

interface Extracted {
  nodes: ElementRecord[];
  /** Directed edges between in-scope nodes. */
  edges: { id: string; source: ElementId; target: ElementId; kind: string; containment?: boolean }[];
  nodeKindsPresent: { eClass: string; category: string; count: number }[];
  edgeKindsPresent: { kind: string; count: number }[];
}

/** Apply the filter and pull the directed node/edge sets out of the model. */
function extract(model: Model, config: AnalysisConfig): Extracted {
  const nodeKindSet = new Set(config.nodeKinds);
  const edgeKindSet = new Set(config.edgeKinds);
  const wantContainment = edgeKindSet.has('containment');

  // Node facets (over ALL candidates, so the filter UI can show what exists).
  const nodeFacet = new Map<string, number>();
  const allNodeCandidates = model.all().filter(isNodeCandidate);
  for (const el of allNodeCandidates) nodeFacet.set(el.eClass, (nodeFacet.get(el.eClass) ?? 0) + 1);

  const nodes = allNodeCandidates.filter((el) => nodeKindSet.size === 0 || nodeKindSet.has(el.eClass));
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Edge facets + edges (both endpoints must be in-scope nodes).
  const edgeFacet = new Map<string, number>();
  const edges: Extracted['edges'] = [];
  for (const el of model.all()) {
    if (!isEdgeElement(el)) continue;
    const src = el.source![0];
    const tgt = el.target![0];
    if (!nodeIds.has(src) || !nodeIds.has(tgt)) continue;
    edgeFacet.set(el.eClass, (edgeFacet.get(el.eClass) ?? 0) + 1);
    if (edgeKindSet.size === 0 || edgeKindSet.has(el.eClass)) {
      edges.push({ id: el.id, source: src, target: tgt, kind: el.eClass });
    }
  }
  // Synthesized containment edges (owner → child) between in-scope nodes.
  if (wantContainment) {
    let cCount = 0;
    for (const n of nodes) {
      if (n.ownerId && nodeIds.has(n.ownerId)) {
        edges.push({ id: `own:${n.ownerId}:${n.id}`, source: n.ownerId, target: n.id, kind: 'containment', containment: true });
        cCount++;
      }
    }
    if (cCount) edgeFacet.set('containment', cCount);
  } else {
    // Surface containment as an available facet — counted over the IN-SCOPE
    // nodes (matching the enabled branch), so the facet count equals the number
    // of edges that would appear when the user enables it.
    let cCount = 0;
    for (const n of nodes) if (n.ownerId && nodeIds.has(n.ownerId)) cCount++;
    if (cCount) edgeFacet.set('containment', cCount);
  }

  return {
    nodes,
    edges,
    nodeKindsPresent: [...nodeFacet.entries()]
      .map(([eClass, count]) => ({ eClass, category: categoryOf(eClass), count }))
      .sort((a, b) => b.count - a.count || (a.eClass < b.eClass ? -1 : 1)),
    edgeKindsPresent: [...edgeFacet.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1)),
  };
}

/** The undirected simple graph over the extracted nodes/edges (weights summed). */
function toGraph(nodes: ElementRecord[], edges: Extracted['edges']): Graph {
  const ids = nodes.map((n) => n.id);
  const w = new Map<string, number>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    const key = e.source < e.target ? `${e.source} ${e.target}` : `${e.target} ${e.source}`;
    w.set(key, (w.get(key) ?? 0) + 1);
  }
  const gEdges = [...w.entries()].map(([key, weight]) => {
    const [source, target] = key.split(' ');
    return { source, target, weight };
  });
  return { nodes: ids, edges: gEdges };
}

/* ───────────────────────────── buildGraphAnalysis ────────────────────────── */

/**
 * Map a node's normalized size driver (∈[0,1], or null for uniform) to a
 * rendered radius, applying the `sizeScale` (common multiplier) and
 * `sizeContrast` (spread exponent) controls. `contrast`=1 reproduces the √
 * mapping; >1 amplifies the small↔large spread (the max, metric=1, is
 * invariant); non-positive scale/contrast fall back to 1.
 */
export function sizeFromMetric(metric: number | null, scale: number, contrast: number): number {
  const s = scale > 0 ? scale : 1;
  const c = contrast > 0 ? contrast : 1;
  return metric === null ? 8 * s : (5 + 18 * Math.pow(metric, 0.5 * c)) * s;
}

/**
 * Remap every node's `size` for a new scale/contrast — O(n), reusing each
 * node's stored `sizeMetric`, so the store can respond to the size sliders
 * without recomputing communities + layout (which depend only on topology).
 */
export function restyleNodeSizes(
  model: GraphAnalysisModel,
  scale: number,
  contrast: number,
): GraphAnalysisModel {
  return {
    ...model,
    nodes: model.nodes.map((n) => ({ ...n, size: sizeFromMetric(n.sizeMetric, scale, contrast) })),
  };
}

export function buildGraphAnalysis(model: Model, config: AnalysisConfig): GraphAnalysisModel {
  const ex = extract(model, config);
  const graph = toGraph(ex.nodes, ex.edges);

  // Community detection.
  const comm =
    config.clustering === 'louvain'
      ? louvain(graph)
      : config.clustering === 'labelprop'
        ? labelPropagation(graph)
        : config.clustering === 'components'
          ? connectedComponents(graph)
          : new Map<string, number>();
  const communityCount = comm.size ? new Set(comm.values()).size : 0;
  const q = config.clustering !== 'none' && comm.size ? modularity(graph, comm) : 0;

  // Centrality → node size. PageRank is DIRECTED, so it must run on the true
  // relationship directions (`ex.edges`), NOT the undirected `graph` whose
  // `toGraph` canonicalises each edge to `source < target` by id — that would
  // replace the model's direction with lexicographic UUID order (i.e. noise).
  const directed: Graph = {
    nodes: graph.nodes,
    edges: ex.edges.map((e) => ({ source: e.source, target: e.target, weight: 1 })),
  };
  // Degree metrics run on the direction-preserving `directed` graph (one
  // weight-1 edge per relationship), NOT the undirected `graph` — which sorts
  // endpoints (source<target), making its "direction" node-id order (noise) and
  // dropping self-loops. Sourcing all three from `directed` keeps them mutually
  // consistent (degree = in + out) and matches the edges actually drawn.
  const dd =
    config.sizeBy === 'degree' ||
    config.sizeBy === 'in-degree' ||
    config.sizeBy === 'out-degree'
      ? directedDegree(directed)
      : null;
  const cent =
    config.sizeBy === 'pagerank'
      ? pageRank(directed)
      : config.sizeBy === 'degree'
        ? dd!.total
        : config.sizeBy === 'in-degree'
          ? dd!.in
          : config.sizeBy === 'out-degree'
            ? dd!.out
            : new Map<string, number>();
  let maxC = 0;
  for (const v of cent.values()) if (v > maxC) maxC = v;
  // Two Gephi-style size controls (applied by `sizeFromMetric`): `sizeScale` is
  // a common multiplier; `sizeContrast` is an exponent widening the small↔large
  // spread. The per-node normalized driver `metricOf` is stored on the node
  // (`sizeMetric`) so a scale/contrast change remaps size in O(n) — see
  // `restyleNodeSizes` — instead of recomputing the topology.
  const metricOf = (id: string): number | null =>
    config.sizeBy === 'uniform' || maxC <= 0 ? null : (cent.get(id) ?? 0) / maxC;

  // Layout.
  const pos =
    config.layout === 'circular'
      ? circularLayout(graph.nodes, comm.size ? comm : undefined)
      : config.layout === 'grid'
        ? gridLayout(graph.nodes)
        : forceLayout(graph);

  // Colors.
  const colorOf = (el: ElementRecord): string => {
    if (config.colorBy === 'community' && comm.size) {
      return COMMUNITY_PALETTE[(comm.get(el.id) ?? 0) % COMMUNITY_PALETTE.length];
    }
    const cat = categoryOf(el.eClass);
    return config.colorOverrides[cat] ?? CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.other;
  };

  const nodes: GraphAnalysisNode[] = ex.nodes.map((el) => {
    const p = pos.get(el.id) ?? { x: 0, y: 0 };
    return {
      id: el.id,
      label: el.declaredName ?? (el.attrs.reqId as string | undefined) ?? el.eClass,
      eClass: el.eClass,
      category: categoryOf(el.eClass),
      x: p.x,
      y: p.y,
      size: sizeFromMetric(metricOf(el.id), config.sizeScale, config.sizeContrast),
      sizeMetric: metricOf(el.id),
      community: comm.get(el.id) ?? -1,
      color: colorOf(el),
    };
  });

  const edges: GraphAnalysisEdge[] = ex.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    kind: e.kind,
    color: e.containment ? '#cbd5e0' : '#a0aec0',
    containment: e.containment,
  }));

  // Legend.
  let legend: AnalysisLegendEntry[];
  if (config.colorBy === 'community' && comm.size) {
    const counts = new Map<number, number>();
    for (const n of nodes) counts.set(n.community, (counts.get(n.community) ?? 0) + 1);
    legend = [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([c, count]) => ({
        key: `c${c}`,
        label: `Cluster ${c + 1}`,
        color: COMMUNITY_PALETTE[c % COMMUNITY_PALETTE.length],
        count,
      }));
  } else {
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
    legend = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => ({
        key: cat,
        label: CATEGORY_LABELS[cat] ?? cat,
        color: config.colorOverrides[cat] ?? CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.other,
        count,
      }));
  }

  // Bounds via a loop (avoid Math.min(...xs) spread, which stack-overflows at
  // very large node counts).
  const bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  if (nodes.length) {
    bounds.minX = bounds.maxX = nodes[0].x;
    bounds.minY = bounds.maxY = nodes[0].y;
    for (const n of nodes) {
      if (n.x < bounds.minX) bounds.minX = n.x;
      if (n.x > bounds.maxX) bounds.maxX = n.x;
      if (n.y < bounds.minY) bounds.minY = n.y;
      if (n.y > bounds.maxY) bounds.maxY = n.y;
    }
  }

  return {
    nodes,
    edges,
    communityCount,
    modularity: q,
    legend,
    nodeKindsPresent: ex.nodeKindsPresent,
    edgeKindsPresent: ex.edgeKindsPresent,
    bounds,
  };
}

/* ──────────────────────────────── buildDSM ───────────────────────────────── */

export function buildDSM(model: Model, config: AnalysisConfig): DSMModel {
  const ex = extract(model, config);
  const graph = toGraph(ex.nodes, ex.edges);
  const byId = new Map(ex.nodes.map((n) => [n.id, n]));

  // Order + modules.
  let order: string[];
  let moduleOf = new Map<string, number>();
  const moduleColors = new Map<number, string>();
  if (config.dsmOrder === 'cuthill-mckee') {
    order = cuthillMcKee(graph);
    // Fall back to declaration order for any node CM missed (shouldn't happen).
    for (const n of ex.nodes) if (!order.includes(n.id)) order.push(n.id);
  } else if (config.dsmOrder === 'declaration') {
    order = ex.nodes.map((n) => n.id);
  } else {
    const res = dsmOrderByCommunity(graph, louvain(graph));
    order = res.order;
    moduleOf = res.module;
    for (const m of moduleOf.values()) moduleColors.set(m, COMMUNITY_PALETTE[m % COMMUNITY_PALETTE.length]);
  }

  const indexOf = new Map<string, number>();
  order.forEach((id, i) => indexOf.set(id, i));

  const elements = order.map((id) => {
    const el = byId.get(id)!;
    return {
      id,
      label: el.declaredName ?? (el.attrs.reqId as string | undefined) ?? el.eClass,
      eClass: el.eClass,
      module: moduleOf.get(id) ?? 0,
    };
  });

  // Cells: aggregate directed interactions row(source) → col(target).
  const cellMap = new Map<string, { weight: number; kinds: Set<string> }>();
  for (const e of ex.edges) {
    const r = indexOf.get(e.source);
    const c = indexOf.get(e.target);
    if (r === undefined || c === undefined || r === c) continue;
    const key = `${r} ${c}`;
    if (!cellMap.has(key)) cellMap.set(key, { weight: 0, kinds: new Set() });
    const cell = cellMap.get(key)!;
    cell.weight += 1;
    cell.kinds.add(e.kind);
  }
  let maxWeight = 0;
  const cells = [...cellMap.entries()].map(([key, v]) => {
    const [row, col] = key.split(' ').map(Number);
    if (v.weight > maxWeight) maxWeight = v.weight;
    const kinds = [...v.kinds];
    return { row, col, weight: v.weight, kinds, symbol: relationSymbol(kinds[0] ?? '') };
  });

  // Module blocks (contiguous runs of the same module in `order`).
  const modules: DSMModel['modules'] = [];
  if (moduleOf.size) {
    let start = 0;
    for (let i = 0; i <= order.length; i++) {
      const cur = i < order.length ? moduleOf.get(order[i]) : undefined;
      const prev = moduleOf.get(order[start]);
      if (i === order.length || cur !== prev) {
        modules.push({
          index: prev ?? 0,
          start,
          size: i - start,
          color: moduleColors.get(prev ?? 0) ?? COMMUNITY_PALETTE[0],
          label: `Module ${(prev ?? 0) + 1}`,
        });
        start = i;
      }
    }
  }

  return { elements, cells, modules, maxWeight };
}

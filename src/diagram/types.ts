/**
 * Diagram model contract (plan §4).
 *
 * The diagram layer maps the abstract {@link Model} graph into a *view-specific*
 * projection — a {@link DiagramGraph} of {@link DiagramNode}s and
 * {@link DiagramEdge}s — that an auto-layout pass and the React Flow renderers
 * consume. Diagrams are pure projections: they never own truth, they reference
 * model elements by `elementId` and are rebuilt from the model on demand.
 *
 * The shapes here MUST match the cross-module contract in
 * docs/03-architecture-and-plan.md §4 exactly so the UI integrates without glue.
 */

import type { RmAttrKey } from '@semantics/requirements';

/** The diagram/view kinds the modeler renders. */
export type ViewKind =
  | 'general'
  | 'interconnection'
  | 'action'
  | 'state'
  | 'requirement'
  | 'tree'
  | 'parametric'
  | 'sequence'
  | 'allocation'
  | 'geometry'
  | 'case'
  | 'grid'
  | 'requirements'
  | 'analysis'
  | 'planning'
  | 'regroup';

/** A port anchored on a node boundary (interconnection views). */
export interface DiagramPort {
  /** Stable port id (we reuse the underlying PortUsage element id). */
  id: string;
  /** Boundary side: 'left' | 'right' | 'top' | 'bottom' (React Flow `Position`). */
  side: string;
  /** Human-readable port label. */
  label: string;
}

/** A renderable box/shape projected from a model element. */
export interface DiagramNode {
  /** Diagram-local node id (defaults to the element id). */
  id: string;
  /** The model element this node renders. */
  elementId: string;
  /** Metaclass / node category (drives the renderer & icon), e.g. 'PartUsage'. */
  kind: string;
  /** Primary label (declared name, short name, or metaclass). */
  label: string;
  /** Presentational payload: keyword, compartments, attrs, flags. */
  data: Record<string, unknown>;
  /** Assigned by {@link layoutDiagram}; parent-relative for nested nodes. */
  position?: { x: number; y: number };
  /** Assigned by {@link layoutDiagram}. */
  size?: { w: number; h: number };
  /** Owning node id for nested (interconnection / tree) layouts. */
  parentId?: string;
  /** Boundary ports for interconnection views. */
  ports?: DiagramPort[];
}

/** A renderable connector projected from a model relationship/usage/containment. */
export interface DiagramEdge {
  /** Diagram-local edge id. */
  id: string;
  /** The model element backing this edge (absent for synthetic containment). */
  elementId?: string;
  /** Source endpoint — a node id, or a port id for interconnection edges. */
  source: string;
  /** Target endpoint — a node id, or a port id for interconnection edges. */
  target: string;
  /** Edge category: 'composite'|'reference'|'typed-by'|'specialize'|… */
  kind: string;
  /** Optional edge label (e.g. transition 'trigger [guard] / effect'). */
  label?: string;
  /**
   * Whether this edge's endpoints may be reconnected in the UI. Defaults to
   * reconnectable (undefined ⇒ allowed) for edges backed by a relationship whose
   * displayed `source`/`target` ARE the element's real `source[0]`/`target[0]`.
   * Set `false` for edges whose rendered endpoints are display-only (e.g. an
   * `include` rendered from `ownerId`) — reconnecting them would write a
   * spurious endpoint the projection ignores.
   */
  reconnectable?: boolean;
}

/** A complete diagram projection for one view kind. */
export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  viewKind: ViewKind;
}

/* ─────────────────── non-graph view result contracts ───────────────────── */

/**
 * An allocation matrix (allocation view). Rows and columns are model elements
 * (e.g. logical vs. physical parts, or requirements vs. satisfiers) and each
 * populated cell records the backing relationship (`relId`) and its `kind`
 * (e.g. 'allocate', 'satisfy'). Declared here for the dedicated builder/renderer
 * added in the next phase — the React Flow graph builder returns an empty graph
 * for `viewKind: 'allocation'`.
 */
export interface AllocationMatrix {
  rowElements: { id: string; label: string }[];
  colElements: { id: string; label: string }[];
  cells: { rowId: string; colId: string; relId: string; kind: string }[];
  relKind: string;
}

/**
 * A sequence diagram (sequence view): lifelines (each backed by an occurrence /
 * part `elementId`) and time-ordered messages between them. Declared here for
 * the dedicated builder/renderer added in the next phase — the React Flow graph
 * builder returns an empty graph for `viewKind: 'sequence'`.
 */
export interface SequenceDiagram {
  lifelines: { id: string; label: string; elementId: string }[];
  messages: {
    id: string;
    fromLifeline: string;
    toLifeline: string;
    label?: string;
    order: number;
    elementId?: string;
  }[];
}

/**
 * A tabular *grid* projection of the model (grid view). Each row is a model
 * element (in-scope, non-relationship, non-library — optionally filtered by
 * metaclass) and each column a computed property (name, metaclass, type, …).
 * `cells` maps a column `key` to the rendered string value for that row.
 * Declared here for the dedicated builder ({@link buildGrid} in `./grid.ts`) and
 * renderer ({@link GridView}); the React Flow graph builder returns an empty
 * graph for `viewKind: 'grid'`.
 */
export interface GridModel {
  columns: { key: string; label: string }[];
  rows: { id: string; label: string; cells: Record<string, string> }[];
}

/* ──────────────── Graph Analysis view (Gephi-style + DSM) ─────────────────── */

export type GraphLayoutKind = 'force' | 'circular' | 'grid';
export type GraphClusterKind = 'louvain' | 'labelprop' | 'components' | 'none';
export type GraphSizeKind =
  | 'degree'
  | 'in-degree'
  | 'out-degree'
  | 'pagerank'
  | 'uniform';
export type GraphColorKind = 'type' | 'community';
export type DsmOrderKind = 'louvain' | 'cuthill-mckee' | 'declaration';

/**
 * Configuration for the Graph Analysis view, chosen when the view is created and
 * editable live from its config strip. `nodeKinds`/`edgeKinds` are the FILTER
 * (empty ⇒ include all present); the rest select the analysis + rendering
 * algorithms and per-category color overrides.
 */
export interface AnalysisConfig {
  /** Included node metaclasses (empty ⇒ every non-library, non-relationship node). */
  nodeKinds: string[];
  /** Included edge kinds (relationship metaclasses + `'containment'` for owner→child). */
  edgeKinds: string[];
  layout: GraphLayoutKind;
  clustering: GraphClusterKind;
  sizeBy: GraphSizeKind;
  /** Global node-size multiplier (a common factor on every node). 1 = default. */
  sizeScale: number;
  /**
   * Node-size contrast: exponent widening the small↔large spread. 1 reproduces
   * the default (√ of the normalized metric); >1 amplifies the difference
   * between the smallest and largest nodes, <1 compresses it. The largest node
   * is invariant; only the smaller ones move.
   */
  sizeContrast: number;
  colorBy: GraphColorKind;
  /** Per-category (or per-community) color overrides, key → hex. */
  colorOverrides: Record<string, string>;
  mode: 'graph' | 'dsm';
  dsmOrder: DsmOrderKind;
}

export interface GraphAnalysisNode {
  id: string;
  label: string;
  eClass: string;
  /** Coarse category ('block'/'usecase'/'action'/'requirement'/…) for default color + filter. */
  category: string;
  x: number;
  y: number;
  /** Rendered radius (scaled from the chosen centrality). */
  size: number;
  /**
   * The normalized size driver ∈ [0,1] (chosen centrality ÷ max), or null for
   * uniform sizing. Kept so `sizeScale`/`sizeContrast` changes can remap `size`
   * in O(n) without recomputing the topology (see `restyleNodeSizes`).
   */
  sizeMetric: number | null;
  /** Community index from the chosen clustering (−1 when clustering is off). */
  community: number;
  color: string;
}

export interface GraphAnalysisEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  color: string;
  /** True for a synthesized containment (owner→child) edge. */
  containment?: boolean;
}

export interface AnalysisLegendEntry {
  key: string;
  label: string;
  color: string;
  count: number;
}

export interface GraphAnalysisModel {
  nodes: GraphAnalysisNode[];
  edges: GraphAnalysisEdge[];
  communityCount: number;
  /** Modularity of the partition (quality of the clustering; 0 when clustering off). */
  modularity: number;
  /** Legend: categories (colorBy 'type') or communities (colorBy 'community'). */
  legend: AnalysisLegendEntry[];
  /** Facets present in the model, for the filter UI (with live counts). */
  nodeKindsPresent: { eClass: string; category: string; count: number }[];
  edgeKindsPresent: { kind: string; count: number }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** One off-diagonal DSM interaction (row element → col element). */
export interface DSMCell {
  row: number;
  col: number;
  /** Interaction strength → heatmap intensity (number of relationships / weight). */
  weight: number;
  /** Distinct relation metaclasses aggregated into this cell. */
  kinds: string[];
  /** Single-glyph badge for the dominant relation kind (`S` satisfy, `D` dependency, …). */
  symbol: string;
}

export interface DSMModule {
  index: number;
  /** First row/col index of this module's contiguous block. */
  start: number;
  size: number;
  color: string;
  label: string;
}

export interface DSMModel {
  /** Elements in DSM order (rows == cols); `module` is the block they belong to. */
  elements: { id: string; label: string; eClass: string; module: number }[];
  cells: DSMCell[];
  modules: DSMModule[];
  /** Largest cell weight, for normalising the heatmap color scale. */
  maxWeight: number;
}

/* ─────────────── Migration/Effort Planning view (wave slicing) ────────────── */

/** How an atomic planning element is associated to its group (functional block). */
export type PlanGrouping = 'satisfy' | 'subject' | 'containment' | 'refine' | 'derive' | 'trace';
/**
 * How groups are ordered/sequenced across the capacity waves (slices).
 * 'milp' / 'annealing' minimize the weighted Minimum Linear Arrangement (MinLA)
 * coupling cost Σ w_ij·|pos_i − pos_j| — 'milp' proves the optimum exactly for
 * small instances (branch-and-bound stand-in for the CBC assignment model),
 * 'annealing' uses Metropolis simulated annealing.
 */
export type PlanOrdering = 'dependency' | 'coupling' | 'capacity' | 'domain-first' | 'milp' | 'annealing';

/**
 * Configuration for the Planning view (DOORS→CodeBeamer-style wave slicing):
 * ATOMIC elements (each carrying a workload) roll up into GROUPS by `grouping`,
 * which are then sequenced by `ordering` and bin-packed into time SLICES (waves)
 * each holding up to `capacity` workload units.
 */
export interface PlanConfig {
  /** Metaclass of the atomic (workload-bearing) elements, e.g. `RequirementUsage`. */
  atomicKind: string;
  /** Attribute key read for each atomic element's workload/effort (default 1 when absent). */
  workloadAttr: string;
  grouping: PlanGrouping;
  /** Slice time unit label ('day'/'week'/'hour'/'sprint'…). */
  timeUnit: string;
  /** Workload capacity per slice (wave). */
  capacity: number;
  ordering: PlanOrdering;
  /**
   * HARD domain-cohesion constraint ("teams migrate together by functional
   * block"): every domain's groups occupy one unbroken run of positions in the
   * order, and the packer never mixes two domains in a wave. Applies to the
   * coupling-aware orderings (milp / annealing / coupling); Domain-first is
   * already contiguous by construction. The Dependency and Capacity-balanced
   * orderings do NOT honor it (the UI disables the toggle for them).
   */
  cohesion: boolean;
}

export interface PlanMember {
  id: string;
  label: string;
  workload: number;
}

export interface PlanGroup {
  id: string;
  label: string;
  eClass: string;
  workload: number;
  members: PlanMember[];
  /** Domain key (owner) — used by the domain-first ordering. */
  domain: string;
  /** Coupling community index — used by the coupling ordering (−1 otherwise). */
  community: number;
  /** True when the group alone exceeds a wave's capacity (gets its own over-full wave). */
  oversized: boolean;
}

export interface PlanWave {
  index: number;
  /** Human label, e.g. "Week 1". */
  label: string;
  groups: PlanGroup[];
  workload: number;
  capacity: number;
  /** workload / capacity (may exceed 1 for an oversized group's wave). */
  utilization: number;
}

export interface PlanModel {
  waves: PlanWave[];
  /** Atomic elements that matched no group under the chosen `grouping`. */
  ungrouped: PlanMember[];
  totalWorkload: number;
  groupCount: number;
  atomicCount: number;
  /** Number of waves (the plan span). */
  span: number;
  timeUnit: string;
  capacity: number;
  /** Atomic metaclasses present in the model, for the config filter (with counts). */
  atomicKindsPresent: { eClass: string; count: number }[];
  /**
   * Weighted MinLA coupling cost of the PACKED board order (what the user sees):
   * Σ over coupled pairs of w_ij·|pos_i − pos_j| (lower = coupled groups
   * scheduled closer together). Populated for every ordering.
   */
  couplingCost: number;
  /** MinLA cost of the natural (group-insertion) order, for contrast. */
  couplingBaseline: number;
  /**
   * True iff an exact solver PROVED this order optimal for the MinLA objective.
   * Only the 'milp' ordering sets it: over all groups when cohesion is off, or
   * over domain-contiguous orders when cohesion is on — and only for small
   * instances (n ≤ the exact-solver limit). Annealing and the heuristic
   * (larger-instance) cohesion decomposition never claim it.
   */
  optimalOrder: boolean;
}

/* ─────────────── Regroup Workbench view (re-bundling preview) ─────────────── */

/**
 * One target BUNDLE the user re-groups parts into: either a NEW composite to be
 * created on Apply (`isNew: true`, synthetic id `'new:0'`, `'new:1'`, …) or an
 * EXISTING part element (id = that element's id). Phase 1 is preview-only —
 * bundles never touch the model.
 */
export interface RegroupBundle {
  id: string;
  label: string;
  isNew: boolean;
}

/**
 * Configuration for the Regroup Workbench: the proposed bundles, the proposed
 * part → bundle assignment (`membership`, keyed by part element id), and the
 * part metaclass being re-grouped. Pure UI state — {@link planRegroup} reads it
 * without mutating the model.
 */
export interface RegroupConfig {
  bundles: RegroupBundle[];
  /** partId → bundle id (absent ⇒ the part stays where it is / unassigned). */
  membership: Record<string, string>;
  /** Metaclass of the candidate parts ('PartUsage' | 'PartDefinition' | 'ItemUsage'). */
  partKind: string;
  /**
   * Optional user renames for synthesized delegation ports, keyed by
   * `${bundleId}::${insideEndpointId}` — the stable identity of one proposed
   * port. Used as the BASE label in {@link planRegroup}, which still applies
   * collision-suffixing on top, so the preview's port list stays the single
   * source of truth for Apply. Absent ⇒ the auto-generated name is used.
   */
  portLabels?: Record<string, string>;
}

/** A candidate part as shown in the bins (a draggable chip). */
export interface RegroupMember {
  id: string;
  label: string;
}

/**
 * A delegation port {@link planRegroup} proposes on a bundle: exactly ONE per
 * distinct inside ENDPOINT (the same grouping Apply executes), with the label
 * already collision-suffixed (`_2`, `_3`, …) against what the bundle will
 * contain — so the preview's port list is the single source of truth.
 */
export interface RegroupProposedPort {
  /** Final (collision-resolved) outer-port name — exactly what Apply creates. */
  label: string;
  direction: string | null;
  /** One connection that motivates this port (the first, in boundary order). */
  connectionId: string;
  /** The inside endpoint (PortUsage or part) this outer port delegates for. */
  insideEndpointId: string;
  /**
   * For a MULTI-LEVEL delegation (a part nested inside several bundles at once):
   * the next-INNER bundle that also delegates this endpoint. Apply binds this
   * port to that inner bundle's port instead of to the deep endpoint, forming a
   * chain `endpoint ← inner port ← … ← outer port`. `null` for the innermost
   * (single-level) port, which binds directly to the endpoint.
   */
  innerBundleId: string | null;
}

/**
 * One connection that would CROSS a bundle boundary under the proposed
 * membership: the `inside` side is in `bundleId`, the `outside` side is not.
 * A connection between two DIFFERENT bundles yields one entry per bundle.
 */
export interface RegroupBoundary {
  connectionId: string;
  connectionLabel: string;
  connectionKind: string;
  bundleId: string;
  insidePartId: string;
  insidePartLabel: string;
  insideEndpointId: string;
  insideEndpointLabel: string;
  outsidePartId: string;
  outsidePartLabel: string;
  outsideEndpointLabel: string;
  /** Name of the delegation port that Apply would synthesize on the bundle. */
  proposedPortLabel: string;
  proposedPortDirection: string | null;
  /**
   * True when this bundle is the OUTERMOST level this connection crosses — i.e.
   * the level whose port the connection is rewired onto. Inner-level rows exist
   * only to place the chained delegation ports (and their bindings); the
   * connection itself attaches at the outermost port.
   */
  crossingOutermost: boolean;
}

/** A configured bundle with its resolved members + deduplicated proposed ports. */
export interface RegroupPlannedBundle {
  id: string;
  label: string;
  isNew: boolean;
  members: RegroupMember[];
  proposedPorts: RegroupProposedPort[];
}

/** The full read-only regroup PREVIEW computed by {@link planRegroup}. */
export interface RegroupModel {
  bundles: RegroupPlannedBundle[];
  /** Candidate parts with no membership entry. */
  unassigned: RegroupMember[];
  /**
   * EVERY candidate part of the configured kind (declaration order) — feeds the
   * "bundle into an existing part" picker, which needs the full roster, not just
   * the currently-unassigned ones.
   */
  candidateParts: RegroupMember[];
  /** Every bundle-crossing connection (one entry per crossed bundle side). */
  boundary: RegroupBoundary[];
  /** Part metaclasses present in the model, for the config facet (with counts). */
  partKindsPresent: { eClass: string; count: number }[];
  stats: {
    partCount: number;
    bundleCount: number;
    /** Parts whose bundle's target owner differs from their current owner. */
    movedCount: number;
    boundaryCount: number;
    /** Connections fully INSIDE one bundle (both endpoints in the same bundle). */
    internalCount: number;
  };
}

/**
 * A requirements-engineering *table* projection (requirements view) — a
 * DOORS-NG / CodeBeamer-style editable grid of requirements, natively bound to
 * the SysML v2 model. Each row is a `RequirementUsage`/`RequirementDefinition`,
 * hierarchical by containment (outline `number` + `depth`), with editable scalar
 * columns (id/name/text) and REFERENCE columns that resolve requirement
 * relationships (satisfy/verify/refine/trace/derive) to the related model
 * elements. Built by {@link buildRequirementsTable}; rendered + edited live by
 * the model-backed `RequirementsTable` panel (it re-derives on every `rev`).
 */
export interface ReqReference {
  /** The related element's id (chip navigates to it on click). */
  targetId: string;
  /** Display label for the related element. */
  label: string;
  /** Metaclass of the related element (for a subtle type hint). */
  eClass: string;
  /** The backing relationship element's id (chip ✕ removes THIS relationship). */
  relId: string;
}

/**
 * One requirement-FACET column — the statement kind, or one of the nine
 * management attributes (`src/semantics/requirements.ts`).
 *
 * `values` is the closed list the key accepts, carried WITH the column so an
 * editor offers exactly what `setRequirementAttr` would take: a second list
 * kept in the panel is a list that drifts from the one doing the validating.
 * A key with no closed list takes free text and has no `values`.
 */
export interface ReqAttrColumn {
  key: RmAttrKey;
  label: string;
  values?: readonly string[];
}

/** One requirement-relationship reference column. `kind` is the relationship metaclass. */
export interface ReqRefColumn {
  key: string;
  label: string;
  /** Relationship metaclass(es) resolved for this column (source=element, target=requirement). */
  kinds: string[];
}

export interface ReqRow {
  /** Requirement element id. */
  id: string;
  /** Outline number, e.g. "1.2.1", derived from containment nesting order. */
  number: string;
  /** Nesting depth (0 = top-level) for indentation. */
  depth: number;
  /** The requirement's own id (`requirementShortId`: the native short name, else the legacy `attrs.reqId`). */
  reqId: string;
  /** Display name (`declaredName`). */
  name: string;
  /** Requirement statement text (`attrs.text`). */
  text: string;
  /** Metaclass — RequirementUsage vs RequirementDefinition. */
  eClass: string;
  /** Related elements per reference column key. */
  refs: Record<string, ReqReference[]>;
  /**
   * The facets this requirement carries, by key — only the ones that have a
   * value, except `statementKind`, which every row has because a statement is
   * always one kind of thing or another (an untagged requirement reads as
   * `requirement`).
   */
  attrs: Partial<Record<RmAttrKey, string>>;
}

export interface RequirementsTableModel {
  /** Editable scalar columns (id/name/text) shown left of the reference columns. */
  scalarColumns: { key: string; label: string }[];
  /** Reference columns (Satisfied By / Verified By / …). */
  refColumns: ReqRefColumn[];
  /** Facet columns (Kind, Status, Verdict, …), shown right of the references. */
  attrColumns: ReqAttrColumn[];
  rows: ReqRow[];
}

/**
 * layoutDiagram — assign positions, sizes and edge routes to a
 * {@link DiagramGraph} using elkjs.
 *
 * The layout is tuned for READING, after the layout criteria of Sun & Wong
 * ("On Evaluating the Layout of UML Class Diagrams for Program Comprehension",
 * IWPC 2005, building on Purchase's graph-drawing aesthetics):
 *
 * - every view flows LEFT → RIGHT (C11, C14: horizontal relationships) — except
 *   a hub that many dependency lines end on, which may lead its piece;
 * - edges are routed ORTHOGONALLY around the boxes by ELK and drawn along that
 *   route, so no connector crosses a box it does not touch (C9, C12), with
 *   crossings and bends minimised by the layered algorithm (C5);
 * - the graph is split into its connected pieces, each laid out on its own and
 *   then packed row by row to roughly the screen's proportions, largest piece
 *   first (top-left, where a reader starts), then single boxes grouped by kind
 *   (C6/C7 proximity, similarity) — instead of one strip hundreds of screens
 *   long;
 * - boxes are sized from their measured text, so no label is clipped.
 *
 * We import the **bundled** ELK build so the exact same code runs headlessly in
 * Node (Vitest) and in the browser — no web-worker or WASM wiring required.
 *
 * Returns a NEW graph; the input is not mutated. Every node receives a numeric
 * `position` (parent-relative for nested nodes, matching React Flow semantics)
 * and a non-zero `size`; every routed edge receives a `route` in absolute
 * diagram coordinates plus the positions its end boxes had when it was routed
 * (`routeFrom`), so the renderer can tell a route that still fits from one a
 * manual move has made stale.
 */

// The bundled build is self-contained and runs in Node and the browser alike.
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ELK as ElkInstance, ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import { isControlNode } from '@core/index';
import { edgeKeywordFor, edgeLabelText, keywordLabelsAreRepetition } from './edge-labels';
import { COLUMN_HEADER_GAP, columnHeaderHeight, columnLabelSize, columnSpans } from './column-headers';
import { textWidth } from './text-measure';

export { textWidth } from './text-measure';
import type { DiagramColumn, DiagramEdge, DiagramGraph, DiagramNode, Point, ViewKind } from './types';

/** No edge — the default of an orientation that reverses nothing. */
const NO_EDGES: ReadonlySet<string> = new Set();

/** Fallback box size when a node has no measurable content. */
const DEFAULT_NODE_W = 180;
const DEFAULT_NODE_H = 80;
const PORT_SIZE = 10;
/** Side of a control-node symbol (initial/final/fork/decision…). */
const CONTROL_NODE_SIZE = 44;
/** Gap between packed pieces of a diagram. */
const COMPONENT_GAP = 48;
/** Target width:height of a packed diagram — about a landscape canvas. */
export const TARGET_ASPECT = 1.6;

/**
 * Port-constraint mode used for boundary ports: their assigned side is fixed
 * (in→WEST, out→EAST) but ELK may still order/distribute them along that side.
 */
export const PORT_CONSTRAINTS = 'FIXED_SIDE';

/**
 * Map a diagram port side — or a raw feature direction (`in`/`out`) — to an ELK
 * port-side constant. Inbound features anchor WEST, outbound EAST, matching the
 * SysML flow convention (and the left/right boundary sides {@link buildDiagram}
 * assigns). Exposed so the port-side policy is unit-testable without ELK.
 */
export function elkPortSide(side: string): string {
  switch (side) {
    case 'left':
    case 'in':
      return 'WEST';
    case 'right':
    case 'out':
      return 'EAST';
    case 'top':
      return 'NORTH';
    case 'bottom':
      return 'SOUTH';
    default:
      return 'EAST';
  }
}

/**
 * Primary layout direction per view. Every view reads left → right, the way
 * its reader reads text (Sun & Wong C11): structure from owner to part, flows
 * from first step to last, state machines from initial state onward, trees from
 * root to leaf, requirements from the satisfier to the requirement — except a
 * hub that many dependency lines end on, which leads its piece when that
 * clearly cuts crossings (see {@link dependencyHubs}). Exposed for unit tests.
 */
export function layoutDirectionFor(_viewKind: ViewKind): 'RIGHT' {
  return 'RIGHT';
}

/**
 * Root ELK layout options for one piece of a view: the `layered` algorithm,
 * left-to-right, orthogonal routing, spacing for legibility. `nested` switches
 * on cross-hierarchy layout — only for pieces that actually contain nested
 * boxes, because ELK's compound mode does not pack disconnected pieces. Pure +
 * exported so the layout policy is verifiable without invoking ELK.
 */
export function layoutOptionsFor(viewKind: ViewKind, nested = false): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': layoutDirectionFor(viewKind),
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.hierarchyHandling': nested ? 'INCLUDE_CHILDREN' : 'SEPARATE_CHILDREN',
    // Each call lays out ONE connected piece; packing the pieces is ours.
    'elk.separateConnectedComponents': 'false',
    'elk.layered.spacing.nodeNodeBetweenLayers': '64',
    'elk.layered.spacing.edgeNodeBetweenLayers': '24',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
    'elk.spacing.nodeNode': '32',
    'elk.spacing.edgeNode': '20',
    'elk.spacing.edgeEdge': '12',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    // Balanced alignment straightens chains of boxes (fewer bends, C5).
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.thoroughness': '10',
    // Each edge keeps its own attachment point: merged trunks made it
    // impossible to tell which label belonged to which line.
    'elk.layered.mergeEdges': 'false',
    // Labels are laid out WITH the graph, so ELK reserves room for them and no
    // label lands on a box, a line or another label.
    'elk.edgeLabels.placement': 'CENTER',
    'elk.spacing.edgeLabel': '4',
    'elk.layered.edgeLabels.sideSelection': 'SMART_UP',
  };
}

/* ─────────────────────────────── node sizing ─────────────────────────────── */


/** Kinds drawn as an ellipse (use cases), which need room around the text. */
const ELLIPSE_KINDS = new Set(['CaseUsage', 'CaseDefinition', 'UseCaseUsage', 'UseCaseDefinition']);

const FONT_FAMILY = 'system-ui, sans-serif';
const LABEL_FONT = `10px ${FONT_FAMILY}`;
const NAME_FONT = `600 12px ${FONT_FAMILY}`;
const KEYWORD_FONT = `italic 10px ${FONT_FAMILY}`;
const ROW_FONT = `11px ${FONT_FAMILY}`;
const MONO_FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** Widest a constraint box grows for its expression before the text wraps. */
const EXPRESSION_MAX_W = 420;

/** Text of a compartment row as the node renders it (`compartmentLabel`, nodes.tsx). */
function rowText(row: unknown): string {
  if (row && typeof row === 'object') {
    const c = row as Record<string, unknown>;
    let s = String(c.name ?? '');
    if (c.direction) s = `${String(c.direction)} ${s}`;
    if (c.type) s += ` : ${String(c.type)}`;
    if (c.multiplicity) s += ` [${String(c.multiplicity)}]`;
    if (c.value !== undefined && c.value !== null) s += ` = ${String(c.value)}`;
    return s.trim();
  }
  return String(row ?? '');
}

/**
 * Size of a node's box from what it shows: the «keyword» line, the bold name,
 * modifier badges, and one line per attribute / port compartment row, with the
 * paddings and borders the node component draws. Wide enough that nothing is
 * clipped, never narrower than the component's 140 px minimum.
 */
export function intrinsicSize(node: DiagramNode): { w: number; h: number } {
  if (isControlNode(node.kind)) return { w: CONTROL_NODE_SIZE, h: CONTROL_NODE_SIZE };
  const data = (node.data ?? {}) as Record<string, unknown>;
  const attrs = Array.isArray(data.attributes) ? (data.attributes as unknown[]) : [];
  const ports = Array.isArray(data.ports) ? (data.ports as unknown[]) : [];
  const name = String(data.name ?? node.label ?? '');
  const keyword = typeof data.keyword === 'string' ? `«${data.keyword}»` : `«${node.kind}»`;
  // Header: 8 px side padding each way plus a 2 px definition border each side.
  const headerW = Math.max(
    textWidth(name, NAME_FONT, 7.4) + 1, // +1: sub-pixel rounding of bold text
    textWidth(keyword, KEYWORD_FONT, 5.6),
  ) + 2 * 8 + 2 * 2;
  // Compartment rows: 8 px padding each side, 13 px for a port's symbol.
  const rowsW = Math.max(
    0,
    ...attrs.map((a) => textWidth(rowText(a), ROW_FONT, 6.2)),
    ...ports.map((p) => textWidth(rowText(p), ROW_FONT, 6.2) + 13),
  ) + 2 * 8 + 2 * 2;
  let w = Math.ceil(Math.max(140, headerW, rowsW) + 8);
  // A constraint shows its expression as `{ … }`, wrapped past EXPRESSION_MAX_W.
  const attrsBag = (data.attrs ?? {}) as Record<string, unknown>;
  const expression = typeof attrsBag.expression === 'string' && attrsBag.expression.trim() ? `{ ${attrsBag.expression.trim()} }` : '';
  let expressionLines = 0;
  if (expression) {
    const textW = textWidth(expression, MONO_FONT, 6.7);
    w = Math.max(w, Math.ceil(Math.min(EXPRESSION_MAX_W, textW + 2 * 8 + 2 * 2 + 8)));
    expressionLines = Math.max(1, Math.ceil(textW / (w - 2 * 8 - 2 * 2 - 8)));
  }
  // The tree's expand/collapse control sits inside the right edge; the header is
  // centred, so room is kept on both sides.
  if (typeof data.treeHidden === 'number' || data.treeExpanded === true) w += 2 * 30;
  // Header: 4 px padding top and bottom, 13 px keyword line, 15 px name line.
  const header = 4 + 13 + 15 + 4 + 1;
  const compartments =
    (attrs.length ? 7 + attrs.length * 14 : 0) +
    (ports.length ? 7 + ports.length * 14 : 0) +
    (expressionLines ? 7 + expressionLines * 15 : 0);
  // Breathing room above and below the centred content, and the borders.
  let h = Math.ceil(Math.max(56, header + compartments + 16 + 4));
  if (ELLIPSE_KINDS.has(node.kind)) {
    // 22 px side padding, and the text's corners must clear the curve: a box
    // inscribed in an ellipse fills about 1/√2 of its axes.
    w = Math.ceil((w + 2 * 22) * 1.2);
    h = Math.max(h, 72);
  }
  return { w, h };
}

/** Box of an edge label as the renderer draws it (10 px text, 1×4 px padding). */
export function edgeLabelSize(text: string): { width: number; height: number } {
  return { width: Math.ceil(textWidth(text, LABEL_FONT, 6) + 2 * 4 + 2), height: 15 };
}

/* ───────────────────────────── connected pieces ──────────────────────────── */

interface Piece {
  /** Top-level node ids of this piece, in model order. */
  tops: string[];
  /** Every node id in the piece (tops and their descendants). */
  nodeIds: Set<string>;
  edges: DiagramEdge[];
  /** Index of the first top in the graph's node order (model order). */
  order: number;
}

/**
 * Split a graph into its connected pieces: top-level boxes joined by an edge
 * between any of their contents belong to the same piece.
 */
export function connectedPieces(graph: DiagramGraph): Piece[] {
  const parent = new Map<string, string | undefined>();
  const portOwner = new Map<string, string>();
  for (const n of graph.nodes) {
    parent.set(n.id, n.parentId);
    for (const p of n.ports ?? []) portOwner.set(p.id, n.id);
  }
  const topOf = (id: string): string => {
    let cur = portOwner.get(id) ?? id;
    for (let guard = 0; guard < 10_000; guard++) {
      const p = parent.get(cur);
      if (!p || !parent.has(p)) return cur;
      cur = p;
    }
    return cur;
  };
  const tops = graph.nodes.filter((n) => !n.parentId || !parent.has(n.parentId)).map((n) => n.id);
  const uf = new Map<string, string>(tops.map((t) => [t, t]));
  const find = (x: string): string => {
    let r = x;
    while (uf.get(r) !== r) r = uf.get(r)!;
    let c = x;
    while (uf.get(c) !== r) {
      const next = uf.get(c)!;
      uf.set(c, r);
      c = next;
    }
    return r;
  };
  for (const e of graph.edges) {
    const a = topOf(e.source);
    const b = topOf(e.target);
    if (uf.has(a) && uf.has(b)) uf.set(find(a), find(b));
  }
  const byRoot = new Map<string, Piece>();
  const topIndex = new Map(graph.nodes.map((n, i) => [n.id, i]));
  for (const t of tops) {
    const r = find(t);
    const piece = byRoot.get(r) ?? { tops: [], nodeIds: new Set<string>(), edges: [], order: topIndex.get(t)! };
    piece.tops.push(t);
    byRoot.set(r, piece);
  }
  const pieceOfTop = new Map<string, Piece>();
  for (const piece of byRoot.values()) for (const t of piece.tops) pieceOfTop.set(t, piece);
  for (const n of graph.nodes) pieceOfTop.get(topOf(n.id))?.nodeIds.add(n.id);
  for (const e of graph.edges) {
    const piece = pieceOfTop.get(topOf(e.source));
    // An edge to a node outside the graph cannot be laid out; drop it from layout.
    if (piece && piece.nodeIds.has(portOwner.get(e.target) ?? e.target)) piece.edges.push(e);
  }
  return [...byRoot.values()];
}

/**
 * Reading order for the packed pieces: connected pieces first, largest first
 * (the main structure sits top-left, where a reader starts); then single boxes,
 * grouped by kind so like sits with like, each group in model order.
 */
function readingOrder(pieces: Piece[], graph: DiagramGraph): Piece[] {
  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const firstKindIndex = new Map<string, number>();
  for (const p of pieces) {
    if (p.nodeIds.size !== 1) continue;
    const k = kindOf.get(p.tops[0]!) ?? '';
    if (!firstKindIndex.has(k)) firstKindIndex.set(k, p.order);
  }
  return [...pieces].sort((a, b) => {
    const sa = a.nodeIds.size > 1 ? 0 : 1;
    const sb = b.nodeIds.size > 1 ? 0 : 1;
    if (sa !== sb) return sa - sb;
    if (sa === 0) return b.nodeIds.size - a.nodeIds.size || a.order - b.order;
    const ka = firstKindIndex.get(kindOf.get(a.tops[0]!) ?? '') ?? 0;
    const kb = firstKindIndex.get(kindOf.get(b.tops[0]!) ?? '') ?? 0;
    return ka - kb || a.order - b.order;
  });
}

/**
 * Pack boxes row by row, left to right then top to bottom (reading order), into
 * a band about `aspect` times as wide as it is tall. Returns each box's offset
 * and the size of the whole.
 */
export function packRows(
  boxes: { w: number; h: number }[],
  aspect = TARGET_ASPECT,
  gap = COMPONENT_GAP,
): { offsets: Point[]; width: number; height: number } {
  if (boxes.length === 0) return { offsets: [], width: 0, height: 0 };
  const area = boxes.reduce((s, b) => s + (b.w + gap) * (b.h + gap), 0);
  const widest = Math.max(...boxes.map((b) => b.w));
  const limit = Math.max(widest, Math.sqrt(area * aspect));
  const offsets: Point[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w > limit) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    offsets.push({ x, y });
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
    width = Math.max(width, x - gap);
  }
  return { offsets, width, height: y + rowH };
}

/* ───────────────────────────────── ELK run ───────────────────────────────── */

/** Does the piece belong to a layered model's columns — some box carries a numeric `layoutPartition`? */
function isPartitioned(graph: DiagramGraph, piece: Piece): boolean {
  return graph.nodes.some((n) => {
    const lane = (n.data as Record<string, unknown> | undefined)?.layoutPartition;
    return piece.nodeIds.has(n.id) && typeof lane === 'number';
  });
}

/**
 * Build the ELK tree of one piece from the diagram's parent/child relationships.
 * An edge named in `reversed` is handed to ELK from its target to its source —
 * a hub then leads its layer order instead of closing it — and
 * {@link readGeometry} turns its route back.
 */
function toElkTree(
  graph: DiagramGraph,
  piece: Piece,
  overrides: Record<string, string> = {},
  reversed: ReadonlySet<string> = NO_EDGES,
): ElkNode {
  const childrenOf = new Map<string | undefined, DiagramNode[]>();
  for (const n of graph.nodes) {
    if (!piece.nodeIds.has(n.id)) continue;
    const key = n.parentId && piece.nodeIds.has(n.parentId) ? n.parentId : undefined;
    const list = childrenOf.get(key) ?? [];
    list.push(n);
    childrenOf.set(key, list);
  }

  const makeElk = (n: DiagramNode): ElkNode => {
    const { w, h } = intrinsicSize(n);
    const ports: ElkPort[] = (n.ports ?? []).map((p) => ({
      id: p.id,
      width: PORT_SIZE,
      height: PORT_SIZE,
      layoutOptions: { 'elk.port.side': elkPortSide(p.side) },
    }));
    const elk: ElkNode = {
      id: n.id,
      width: w,
      height: h,
      ...(ports.length ? { ports } : {}),
    };
    const partition = (n.data as Record<string, unknown> | undefined)?.layoutPartition;
    if (typeof partition === 'number') elk.layoutOptions = { 'elk.partitioning.partition': String(partition) };
    if (ports.length) {
      elk.layoutOptions = {
        ...(elk.layoutOptions ?? {}),
        'elk.portConstraints': PORT_CONSTRAINTS,
        'elk.portAlignment.default': 'DISTRIBUTED',
      };
    }
    const kids = childrenOf.get(n.id) ?? [];
    if (kids.length) {
      elk.children = kids.map(makeElk);
      // Give nested containers room for their title and padding around children.
      elk.layoutOptions = {
        ...(elk.layoutOptions ?? {}),
        'elk.padding': '[top=40,left=20,bottom=20,right=20]',
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${w}, ${h})`,
      };
    }
    return elk;
  };

  const nested = [...childrenOf.keys()].some((k) => k !== undefined);
  // Unlabelled edges from one box may share a trunk that branches (Sun & Wong
  // C1, "join arcs"): far fewer lines to cross. Labelled ones keep their own
  // line, so each label stays with its edge.
  const unlabelled = piece.edges.every((e) => !edgeLabelText(e));
  const partitioned = isPartitioned(graph, piece);
  const edges: ElkExtendedEdge[] = piece.edges.map((e) => {
    const text = edgeLabelText(e);
    const back = reversed.has(e.id);
    return {
      id: e.id,
      sources: [back ? e.target : e.source],
      targets: [back ? e.source : e.target],
      ...(text ? { labels: [{ id: `${e.id}#label`, text, ...edgeLabelSize(text) }] } : {}),
    };
  });
  return {
    id: 'root',
    layoutOptions: {
      ...layoutOptionsFor(graph.viewKind, nested),
      'elk.layered.thoroughness': thoroughnessFor(piece.nodeIds.size),
      ...(unlabelled ? { 'elk.layered.mergeEdges': 'true' } : {}),
      ...(partitioned ? { 'elk.partitioning.activate': 'true' } : {}),
      ...overrides,
    },
    children: (childrenOf.get(undefined) ?? []).map(makeElk),
    edges,
  };
}

interface PieceGeometry {
  /** Per node: position relative to its parent (or the piece origin) and size. */
  nodes: Map<string, { x: number; y: number; w: number; h: number; absX: number; absY: number }>;
  /** Per edge: the routed polyline, in piece coordinates. */
  routes: Map<string, Point[]>;
  /** Per edge: the centre of its label, where ELK made room for it. */
  labels: Map<string, Point>;
  width: number;
  height: number;
}

/** Read positions and edge routes out of a laid-out ELK tree; a `reversed` edge's route runs source to target again. */
function readGeometry(laidOut: ElkNode, reversed: ReadonlySet<string> = NO_EDGES): PieceGeometry {
  const nodes: PieceGeometry['nodes'] = new Map();
  const abs = new Map<string, Point>([['root', { x: 0, y: 0 }]]);
  const routes = new Map<string, Point[]>();
  const labels = new Map<string, Point>();
  const edgesAt: { edge: ElkExtendedEdge; holder: string }[] = [];

  const walk = (n: ElkNode, originX: number, originY: number): void => {
    for (const e of n.edges ?? []) edgesAt.push({ edge: e, holder: n.id });
    for (const c of n.children ?? []) {
      const x = c.x ?? 0;
      const y = c.y ?? 0;
      const absX = originX + x;
      const absY = originY + y;
      abs.set(c.id, { x: absX, y: absY });
      nodes.set(c.id, {
        x,
        y,
        w: c.width && c.width > 0 ? c.width : DEFAULT_NODE_W,
        h: c.height && c.height > 0 ? c.height : DEFAULT_NODE_H,
        absX,
        absY,
      });
      walk(c, absX, absY);
    }
  };
  walk(laidOut, 0, 0);

  for (const { edge, holder } of edgesAt) {
    // ELK reports each edge's points relative to the node that contains it
    // (`container`, its ends' lowest common ancestor), not where it was declared.
    const container = (edge as ElkExtendedEdge & { container?: string }).container ?? holder;
    const o = abs.get(container) ?? { x: 0, y: 0 };
    const pts: Point[] = [];
    for (const s of edge.sections ?? []) {
      const seq = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      for (const p of seq) {
        const q = { x: o.x + p.x, y: o.y + p.y };
        const last = pts[pts.length - 1];
        if (!last || Math.abs(last.x - q.x) > 0.01 || Math.abs(last.y - q.y) > 0.01) pts.push(q);
      }
    }
    if (reversed.has(edge.id)) pts.reverse();
    if (pts.length >= 2) routes.set(edge.id, pts);
    const l = edge.labels?.[0];
    if (l && l.x !== undefined && l.y !== undefined) {
      labels.set(edge.id, { x: o.x + l.x + (l.width ?? 0) / 2, y: o.y + l.y + (l.height ?? 0) / 2 });
    }
  }
  return { nodes, routes, labels, width: laidOut.width ?? 0, height: laidOut.height ?? 0 };
}

/* ─────────────────────────── choosing among layouts ──────────────────────── */

/**
 * Layering strategies tried on a piece of moderate size. No one strategy reads
 * best on every graph — measured on the drone-swarm model's layer diagrams, the
 * default (network simplex) is best for most, while MIN_WIDTH cut one hub-heavy
 * layer from 254 crossings to 88 — so each such piece is laid out every way and
 * the most readable kept.
 */
const LAYERING_CANDIDATES: { layering: string; maxNodes: number }[] = [
  { layering: 'NETWORK_SIMPLEX', maxNodes: Infinity },
  { layering: 'MIN_WIDTH', maxNodes: 300 },
  // Superlinear: 265 s on a 492-box piece, so only where it stays well under a second.
  { layering: 'COFFMAN_GRAHAM', maxNodes: 120 },
];
/** Pieces in this size range get the candidates; smaller ones gain nothing, larger ones cost seconds. */
const CANDIDATE_MIN_NODES = 20;
const CANDIDATE_MAX_NODES = 300;

/** Pairs of routed edges that cross (edges sharing an end box do not count). */
export function countCrossings(routes: Map<string, Point[]>, ends: Map<string, [string, string]>): number {
  interface Seg { e: string; a: Point; b: Point }
  const segs: Seg[] = [];
  for (const [e, pts] of routes) for (let k = 1; k < pts.length; k++) segs.push({ e, a: pts[k - 1]!, b: pts[k]! });
  const cell = 80;
  const grid = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (let gx = Math.floor(Math.min(s.a.x, s.b.x) / cell); gx <= Math.floor(Math.max(s.a.x, s.b.x) / cell); gx++) {
      for (let gy = Math.floor(Math.min(s.a.y, s.b.y) / cell); gy <= Math.floor(Math.max(s.a.y, s.b.y) / cell); gy++) {
        const k = `${gx},${gy}`;
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  });
  const side = (p: Point, q: Point, r: Point): number => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const pairs = new Set<string>();
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = segs[list[i]!]!;
        const t = segs[list[j]!]!;
        if (s.e === t.e) continue;
        const [s1, s2] = ends.get(s.e)!;
        const [t1, t2] = ends.get(t.e)!;
        if (s1 === t1 || s1 === t2 || s2 === t1 || s2 === t2) continue;
        if (side(s.a, s.b, t.a) * side(s.a, s.b, t.b) < 0 && side(t.a, t.b, s.a) * side(t.a, t.b, s.b) < 0) {
          pairs.add(s.e < t.e ? `${s.e}|${t.e}` : `${t.e}|${s.e}`);
        }
      }
    }
  }
  return pairs.size;
}

/**
 * How hard a laid-out piece is to read — lower is better. Crossings weigh most
 * (the aesthetic Purchase found mattered most), then bends, then total edge
 * length (C5, C7).
 */
export function readabilityCost(g: PieceGeometry, ends: Map<string, [string, string]>): number {
  let bends = 0;
  let length = 0;
  for (const pts of g.routes.values()) {
    bends += Math.max(0, pts.length - 2);
    for (let k = 1; k < pts.length; k++) length += Math.hypot(pts[k]!.x - pts[k - 1]!.x, pts[k]!.y - pts[k - 1]!.y);
  }
  return countCrossings(g.routes, ends) + 0.1 * bends + length / 2000;
}

/**
 * A box that this many dependency lines (`«allocate»`, `«satisfy»`, `«trace»`…)
 * point at is a hub: `memberA`, which fourteen activities are allocated to.
 */
export const HUB_MIN_EDGES = 3;
/**
 * A layout that draws a hub's lines from the hub outwards is kept only if it
 * has this many crossings fewer than the usual one (and costs less): a clear
 * gain, never a tie, so a diagram that already reads well keeps its direction.
 */
export const HUB_MIN_CROSSINGS_SAVED = 3;
/**
 * Drawing from the hubs is one more full layout run, which on a big piece with
 * a hub of a hundred lines costs as much as all the layering candidates
 * together. Pieces of more boxes than this keep the usual direction; every
 * layer of the drone-swarm models is well under it.
 */
export const HUB_MAX_NODES = 200;

/**
 * The boxes `min` or more dependency-family lines end on, mapped to those
 * lines. Pure; exported for tests.
 */
export function dependencyHubs(
  edges: readonly Pick<DiagramEdge, 'id' | 'kind' | 'target'>[],
  min = HUB_MIN_EDGES,
): Map<string, string[]> {
  const into = new Map<string, string[]>();
  for (const e of edges) {
    if (edgeKeywordFor(e.kind) === undefined) continue;
    const list = into.get(e.target);
    if (list) list.push(e.id);
    else into.set(e.target, [e.id]);
  }
  for (const [box, ids] of into) if (ids.length < min) into.delete(box);
  return into;
}

/**
 * The dependency lines a piece of a General view could be laid out from their
 * hub instead of towards it. Laid out source → target, a hub closes its piece
 * in the last layer and the lines into it run across the width of the diagram,
 * over everything else on the way (the drone-swarm model's `memberA`, which
 * fourteen activities are allocated to). Laid out from the hub they fan out of
 * it. Only a piece that is not split into layer columns qualifies — the columns
 * fix which box comes first — and only up to {@link HUB_MAX_NODES} boxes. Empty
 * when the piece has no hub. Exported for tests.
 */
export function hubEdges(graph: DiagramGraph, piece: Piece): ReadonlySet<string> {
  if (graph.viewKind !== 'general' || piece.nodeIds.size > HUB_MAX_NODES || isPartitioned(graph, piece)) return NO_EDGES;
  const ids = new Set<string>();
  for (const list of dependencyHubs(piece.edges).values()) for (const id of list) ids.add(id);
  return ids;
}

/**
 * Lay out one piece — every candidate layering where it pays, keeping the most
 * readable. A piece with a hub is also laid out with the hub's dependency lines
 * drawn from the hub, and that layout wins only when it is clearly more readable.
 */
async function layoutPiece(
  graph: DiagramGraph,
  piece: Piece,
  overrides: Record<string, string> = {},
): Promise<PieceGeometry> {
  const n = piece.nodeIds.size;
  const forced = overrides['elk.layered.layering.strategy'] !== undefined;
  const tryCandidates = n >= CANDIDATE_MIN_NODES && n <= CANDIDATE_MAX_NODES && piece.edges.length >= 10 && !forced;
  const fromHubs = forced ? NO_EDGES : hubEdges(graph, piece);
  if (!tryCandidates && fromHubs.size === 0) return readGeometry(await runElk(toElkTree(graph, piece, overrides)));
  const portOwner = new Map<string, string>();
  for (const node of graph.nodes) for (const p of node.ports ?? []) portOwner.set(p.id, node.id);
  const ends = new Map<string, [string, string]>(
    piece.edges.map((e) => [e.id, [portOwner.get(e.source) ?? e.source, portOwner.get(e.target) ?? e.target]]),
  );
  type Laid = { g: PieceGeometry; cost: number };
  const run = async (reversed: ReadonlySet<string>, layering: string | undefined): Promise<Laid> => {
    const options = layering ? { 'elk.layered.layering.strategy': layering, ...overrides } : overrides;
    const g = readGeometry(await runElk(toElkTree(graph, piece, options, reversed)), reversed);
    return { g, cost: readabilityCost(g, ends) };
  };
  let usual: (Laid & { layering: string | undefined }) | null = null;
  const layerings = tryCandidates
    ? LAYERING_CANDIDATES.filter((c) => n <= c.maxNodes).map((c) => c.layering)
    : [undefined];
  for (const layering of layerings) {
    const r = await run(NO_EDGES, layering);
    if (!usual || r.cost < usual.cost) usual = { ...r, layering };
  }
  if (fromHubs.size === 0) return usual!.g;
  // The layering that read best source → target also read best from the hubs on
  // every layer of the drone-swarm model, so the hub-led layout costs one more run.
  const hubLed = await run(fromHubs, usual!.layering);
  const saved = countCrossings(usual!.g.routes, ends) - countCrossings(hubLed.g.routes, ends);
  return saved >= HUB_MIN_CROSSINGS_SAVED && hubLed.cost < usual!.cost ? hubLed.g : usual!.g;
}

let elkInstance: ElkInstance | null = null;
let elkFactory: (() => ElkInstance) | null = null;

/**
 * Run ELK somewhere else — in the browser, a Web Worker (see
 * `src/ui/elk-worker.ts`), so a large diagram's layout never freezes the page.
 * Without a factory, and wherever the factory's engine fails, ELK runs
 * in-process (the bundled build), as it does in Node and the tests.
 */
export function setElkFactory(factory: (() => ElkInstance) | null): void {
  elkFactory = factory;
  elkInstance = null;
}

function getElk(): ElkInstance {
  if (!elkInstance) {
    try {
      elkInstance = elkFactory ? elkFactory() : new ELK();
    } catch {
      elkFactory = null;
      elkInstance = new ELK();
    }
  }
  return elkInstance;
}

/** Lay out one ELK graph, falling back to in-process ELK if a custom engine fails. */
async function runElk(graph: ElkNode): Promise<ElkNode> {
  try {
    return await getElk().layout(graph);
  } catch (err) {
    if (!elkFactory) throw err;
    console.warn('ELK engine failed; laying out in-process from now on', err);
    setElkFactory(null);
    return getElk().layout(graph);
  }
}

/**
 * Crossing-minimisation effort for a piece of `nodes` boxes: full effort where
 * it is cheap; on very large pieces the extra passes cost seconds and change
 * almost nothing (measured on a 492-box piece: 3,579 vs 3,586 crossings).
 */
export function thoroughnessFor(nodes: number): string {
  if (nodes <= 150) return '10';
  if (nodes <= 400) return '5';
  return '2';
}

/**
 * The header columns of a laid-out piece, in the piece's own coordinates: one per
 * package it spans, over that package's boxes, `band` px tall (see
 * `column-headers.ts`). Undefined unless the graph names its packages
 * (`partitions`) and the piece spans two or more of them.
 */
function columnHeads(
  partitions: DiagramGraph['partitions'],
  partitionOf: ReadonlyMap<string, unknown>,
  piece: Piece,
  g: PieceGeometry,
): { band: number; columns: Omit<DiagramColumn, 'bottom'>[] } | undefined {
  if (!partitions) return undefined;
  const boxes: { partition: number; x: number; w: number }[] = [];
  for (const id of piece.tops) {
    const partition = partitionOf.get(id);
    const n = g.nodes.get(id);
    if (typeof partition === 'number' && n) boxes.push({ partition, x: n.absX, w: n.w });
  }
  const spans = columnSpans(boxes);
  if (spans.length === 0) return undefined;
  const band = columnHeaderHeight(g.width);
  return {
    band,
    columns: spans.map((s) => {
      const lane = partitions[s.partition]!;
      return {
        id: `col:${lane.elementId}:${piece.tops[0]}`,
        elementId: lane.elementId,
        label: lane.label,
        x: s.x0,
        y: 0,
        w: s.x1 - s.x0,
        h: band,
        fontSize: columnLabelSize(band),
      };
    }),
  };
}

/**
 * Lay out `graph` and return a new graph with `position` and `size` set on every
 * node and a `route` on every edge ELK routed. Positions of nested nodes are
 * relative to their parent (React Flow semantics); top-level nodes and routes
 * are relative to the diagram origin.
 */
export async function layoutDiagram(
  graph: DiagramGraph,
  opts: { aspect?: number; elkOptions?: Record<string, string> } = {},
): Promise<DiagramGraph> {
  if (graph.nodes.length === 0) {
    return { nodes: [], edges: graph.edges.map((e) => ({ ...e })), viewKind: graph.viewKind };
  }

  // Drop «keyword» labels that would all say the same thing, before layout, so
  // no room is reserved for them and their lines can be joined.
  if (keywordLabelsAreRepetition(graph.edges)) {
    graph = { ...graph, edges: graph.edges.map((e) => (e.label ? e : { ...e, hideKeyword: true })) };
  }
  const pieces = readingOrder(connectedPieces(graph), graph);
  const geoms: PieceGeometry[] = [];
  for (const piece of pieces) {
    geoms.push(await layoutPiece(graph, piece, opts.elkOptions));
  }
  // A piece that spans several packages is headed by a band naming each column;
  // its room is reserved here, above the piece, so no box is ever under one.
  const partitionOf = new Map(graph.nodes.map((n) => [n.id, (n.data as Record<string, unknown> | undefined)?.layoutPartition]));
  const heads = pieces.map((piece, i) => columnHeads(graph.partitions, partitionOf, piece, geoms[i]!));
  const packed = packRows(
    geoms.map((g, i) => ({ w: g.width, h: g.height + (heads[i] ? heads[i]!.band + COLUMN_HEADER_GAP : 0) })),
    opts.aspect ?? TARGET_ASPECT,
  );

  const place = new Map<string, { x: number; y: number; w: number; h: number; absX: number; absY: number }>();
  const routes = new Map<string, Point[]>();
  const labels = new Map<string, Point>();
  const columns: DiagramColumn[] = [];
  geoms.forEach((g, i) => {
    const off = packed.offsets[i]!;
    const head = heads[i];
    // Everything of the piece sits under its header band, when it has one.
    const dy = off.y + (head ? head.band + COLUMN_HEADER_GAP : 0);
    const tops = new Set(pieces[i]!.tops);
    for (const [id, n] of g.nodes) {
      place.set(id, {
        ...n,
        // Top-level boxes move with their piece; nested ones stay parent-relative.
        x: tops.has(id) ? n.x + off.x : n.x,
        y: tops.has(id) ? n.y + dy : n.y,
        absX: n.absX + off.x,
        absY: n.absY + dy,
      });
    }
    for (const [id, pts] of g.routes) routes.set(id, pts.map((p) => ({ x: p.x + off.x, y: p.y + dy })));
    for (const [id, p] of g.labels) labels.set(id, { x: p.x + off.x, y: p.y + dy });
    for (const c of head?.columns ?? []) columns.push({ ...c, x: c.x + off.x, y: off.y, bottom: dy + g.height });
  });

  const nodes: DiagramNode[] = graph.nodes.map((n) => {
    const g = place.get(n.id);
    return {
      ...n,
      position: { x: g?.x ?? 0, y: g?.y ?? 0 },
      size: { w: g?.w ?? DEFAULT_NODE_W, h: g?.h ?? DEFAULT_NODE_H },
    };
  });

  const portOwner = new Map<string, string>();
  for (const n of graph.nodes) for (const p of n.ports ?? []) portOwner.set(p.id, n.id);
  const edges: DiagramEdge[] = graph.edges.map((e) => {
    const route = routes.get(e.id);
    const s = place.get(portOwner.get(e.source) ?? e.source);
    const t = place.get(portOwner.get(e.target) ?? e.target);
    if (!route || !s || !t) return { ...e };
    return {
      ...e,
      route,
      routeFrom: { source: { x: s.absX, y: s.absY }, target: { x: t.absX, y: t.absY } },
      ...(labels.has(e.id) ? { labelAt: labels.get(e.id) } : {}),
    };
  });

  return { nodes, edges, viewKind: graph.viewKind, ...(columns.length ? { columns } : {}) };
}

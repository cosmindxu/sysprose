/**
 * React Flow custom edge components for SysML v2 diagrams.
 *
 * A single data-driven {@link SysmlEdge} renders every relationship kind, choosing
 * the SysML marker (filled ◆ composite, open ◇ reference, △ specialization,
 * arrowheads for succession/transition/satisfy) from the edge's `data.kind`.
 * Markers are declared as SVG `<marker>` defs (see {@link EdgeMarkers}). The
 * {@link edgeTypes} map is what React Flow consumes.
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useInternalNode,
  type EdgeProps,
  type InternalNode,
} from '@xyflow/react';
import type { CSSProperties } from 'react';
import { getEdgeEndpoints, shapeForKind, type ShapedNode } from './geometry';
import type { Point } from './types';

/** Marker ids for each SysML edge kind (referenced via `markerStart`/`markerEnd`). */
export const MARKER = {
  composite: 'sysml-composite', // filled diamond ◆ at the whole/owner end
  aggregate: 'sysml-aggregate', // open diamond ◇ at the whole/owner end (shared aggregation)
  reference: 'sysml-reference', // open diamond (reference/subsetting membership)
  specialize: 'sysml-specialize', // hollow triangle ▷ at the general end
  typedBy: 'sysml-typed-by',
  arrow: 'sysml-arrow', // filled arrowhead (succession/flow/transition)
  open: 'sysml-open-arrow', // open/stick arrowhead (dependency family, subsetting)
  crosshair: 'sysml-crosshair', // circled-plus ⊕ containment (membership) at the owner end
} as const;

/** Per-kind visual config: which marker sits at source/target and line style. */
export interface EdgeStyleSpec {
  markerStart?: string;
  markerEnd?: string;
  dashed?: boolean;
  stroke?: string;
  /** SysML «keyword» surfaced as a default label for the dependency family. */
  keyword?: string;
}

/** Dashed, open-arrow «keyword» dependencies (satisfy/allocate/derive/…). */
const DEPENDENCY_PURPLE = 'var(--dgm-violet)';

export function edgeStyleFor(kind: string): EdgeStyleSpec {
  switch (kind) {
    // Structural composition — FILLED diamond ◆ at the whole (source) end.
    case 'composite':
    case 'composition':
      return { markerStart: MARKER.composite };
    // Shared aggregation — OPEN diamond ◇ at the whole (source) end.
    case 'aggregate':
    case 'aggregation':
      return { markerStart: MARKER.aggregate };
    // Reference (non-composite) membership — open diamond at the owner end.
    case 'reference':
      return { markerStart: MARKER.reference };

    // Specialization family — hollow triangle ▷ at the general (target) end.
    // Feature typing keeps a dashed line per SysML notation; the rest are solid.
    case 'typed-by':
    case 'typing':
    case 'feature-typing':
      return { markerEnd: MARKER.specialize, dashed: true };
    case 'specialize':
    case 'specialization':
    case 'subclassification':
    case 'subsetting':
    case 'redefinition':
      return { markerEnd: MARKER.specialize };

    // Behavioural / value flow — solid line, filled arrowhead (directional).
    case 'succession':
    case 'transition':
    case 'flow':
    case 'succession-flow':
      return { markerEnd: MARKER.arrow };
    case 'bind':
    case 'binding':
      return { markerEnd: MARKER.arrow };
    // Containment (ownership) — circled-plus ⊕ at the owner (source) end, plus a
    // filled arrowhead at the owned (target) end so the direction reads clearly.
    case 'containment':
      return { markerStart: MARKER.crosshair, markerEnd: MARKER.arrow, stroke: 'var(--node-muted)' };
    // Interconnection connector — plain solid line (endpoints carry the meaning).
    case 'connection':
    case 'interface':
      return { stroke: 'var(--dgm-blue)' };

    // Case-view association roles — solid, arrow to the associated feature.
    case 'actor':
    case 'subject':
    case 'objective':
    case 'stakeholder':
      return { markerEnd: MARKER.arrow, stroke: 'var(--dgm-blue)' };
    // Include (use-case) — dashed, open arrow, «include» label.
    case 'include':
      return { markerEnd: MARKER.open, dashed: true, stroke: DEPENDENCY_PURPLE, keyword: 'include' };

    // Dependency family — dashed line, open arrowhead, «keyword» label.
    case 'satisfy':
      return { markerEnd: MARKER.open, dashed: true, stroke: DEPENDENCY_PURPLE, keyword: 'satisfy' };
    case 'verify':
      return { markerEnd: MARKER.open, dashed: true, stroke: DEPENDENCY_PURPLE, keyword: 'verify' };
    case 'refine':
      return { markerEnd: MARKER.open, dashed: true, stroke: DEPENDENCY_PURPLE, keyword: 'refine' };
    case 'derive':
      return { markerEnd: MARKER.open, dashed: true, stroke: DEPENDENCY_PURPLE, keyword: 'derive' };
    case 'trace':
      return { markerEnd: MARKER.open, dashed: true, stroke: DEPENDENCY_PURPLE, keyword: 'trace' };
    case 'allocate':
      return { markerEnd: MARKER.open, dashed: true, stroke: DEPENDENCY_PURPLE, keyword: 'allocate' };
    case 'dependency':
      return { markerEnd: MARKER.open, dashed: true, stroke: DEPENDENCY_PURPLE, keyword: 'dependency' };

    default:
      return { markerEnd: MARKER.arrow };
  }
}

const labelStyle: CSSProperties = {
  position: 'absolute',
  background: 'var(--node-bg)',
  padding: '1px 4px',
  borderRadius: 3,
  fontSize: 10,
  fontFamily: 'system-ui, sans-serif',
  color: 'var(--node-fg)',
  pointerEvents: 'all',
};

/**
 * Shared body for both the handle-anchored and the floating edge: paints the
 * `<BaseEdge>` with the kind's SysML markers + line style and, when present, the
 * «keyword»/model label. Only the *path* differs between the two variants.
 */
function EdgeBody(props: {
  id: string;
  kind: string;
  path: string;
  labelX: number;
  labelY: number;
  label?: unknown;
  hideKeyword?: boolean;
}): JSX.Element {
  const spec = edgeStyleFor(props.kind);
  // Fall back to the SysML «keyword» for the dependency family (satisfy/allocate/…)
  // so those dashed connectors are self-describing even without a model label —
  // unless the layout found every such label in the diagram would be the same.
  const text = props.label ?? (spec.keyword && !props.hideKeyword ? `«${spec.keyword}»` : undefined);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={props.path}
        markerStart={spec.markerStart ? `url(#${spec.markerStart})` : undefined}
        markerEnd={spec.markerEnd ? `url(#${spec.markerEnd})` : undefined}
        style={{
          stroke: spec.stroke ?? 'var(--node-line)',
          strokeDasharray: spec.dashed ? '6 4' : undefined,
        }}
      />
      {text ? (
        <EdgeLabelRenderer>
          <div
            data-testid="edge-label"
            style={{
              ...labelStyle,
              transform: `translate(-50%,-50%) translate(${props.labelX}px,${props.labelY}px)`,
            }}
          >
            {String(text)}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

/* ───────────────────────── routed (laid-out) edges ─────────────────────── */

/** Corner radius of a drawn route: soft enough to follow, small enough to stay orthogonal. */
const CORNER_RADIUS = 6;

/**
 * SVG path along an orthogonal polyline, each corner rounded by up to `radius`
 * (less where a segment is too short for it). Pure; exported for tests.
 */
export function roundedPath(points: Point[], radius = CORNER_RADIUS): string {
  if (points.length === 0) return '';
  const p0 = points[0]!;
  let d = `M ${p0.x} ${p0.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const lin = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const lout = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, lin / 2, lout / 2);
    if (r < 0.5) {
      d += ` L ${cur.x} ${cur.y}`;
      continue;
    }
    const ax = cur.x - ((cur.x - prev.x) / lin) * r;
    const ay = cur.y - ((cur.y - prev.y) / lin) * r;
    const bx = cur.x + ((next.x - cur.x) / lout) * r;
    const by = cur.y + ((next.y - cur.y) / lout) * r;
    d += ` L ${ax} ${ay} Q ${cur.x} ${cur.y} ${bx} ${by}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

/**
 * Where a route's label goes: the middle of its longest segment, so the label
 * sits on the line it names and reads horizontally. Pure; exported for tests.
 */
export function routeLabelPoint(points: Point[]): Point {
  let best = { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0 };
  let bestLen = -1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return best;
}

const aligned = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;

/**
 * Move a route's first and last points onto `start` and `end` (where the
 * renderer actually anchors the edge — a port handle, say) while keeping every
 * segment horizontal or vertical: the neighbouring bend point slides with the
 * end it belongs to. Pure; exported for tests.
 */
export function fitRouteToEnds(route: Point[], start: Point, end: Point): Point[] {
  const pts = route.map((p) => ({ ...p }));
  if (pts.length < 2) return [start, end];
  if (pts.length === 2) {
    if (aligned(start.y, end.y) || aligned(start.x, end.x)) return [start, end];
    const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
    if (horizontal) {
      const mx = (start.x + end.x) / 2;
      return [start, { x: mx, y: start.y }, { x: mx, y: end.y }, end];
    }
    const my = (start.y + end.y) / 2;
    return [start, { x: start.x, y: my }, { x: end.x, y: my }, end];
  }
  const slide = (endIdx: number, nextIdx: number, to: Point): void => {
    const e = pts[endIdx]!;
    const n = pts[nextIdx]!;
    if (aligned(e.y, n.y)) n.y = to.y; // horizontal first segment: keep it horizontal
    else n.x = to.x; // vertical first segment: keep it vertical
    pts[endIdx] = { ...to };
  };
  slide(0, 1, start);
  slide(pts.length - 1, pts.length - 2, end);
  return pts;
}

/** Whether a laid-out route still fits: neither end box has moved since layout. */
export function routeIsCurrent(
  routeFrom: { source: Point; target: Point } | undefined,
  source: Point | undefined,
  target: Point | undefined,
): boolean {
  if (!routeFrom || !source || !target) return false;
  const near = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
  return near(routeFrom.source, source) && near(routeFrom.target, target);
}

/** The laid-out route carried in an edge's data, when it is still current. */
function currentRoute(
  data: Record<string, unknown> | undefined,
  sourceNode: InternalNode | undefined,
  targetNode: InternalNode | undefined,
): Point[] | null {
  const route = data?.route as Point[] | undefined;
  if (!route || route.length < 2) return null;
  const current = routeIsCurrent(
    data?.routeFrom as { source: Point; target: Point } | undefined,
    sourceNode?.internals.positionAbsolute,
    targetNode?.internals.positionAbsolute,
  );
  return current ? route : null;
}

/**
 * Port edges (interconnection / IBD ConnectionUsages), anchored on the port
 * handles React Flow resolved. They follow the laid-out route, fitted onto the
 * handles; once an end box has been moved by hand they step orthogonally
 * between the two handles instead.
 */
function HandleEdge(props: EdgeProps): JSX.Element {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label } = props;
  const d = data as Record<string, unknown> | undefined;
  const kind = String(d?.kind ?? 'default');
  const explicit = label ?? d?.label;
  const route = currentRoute(d, useInternalNode(source), useInternalNode(target));
  if (route) {
    const pts = fitRouteToEnds(route, { x: sourceX, y: sourceY }, { x: targetX, y: targetY });
    const at = (d?.labelAt as Point | undefined) ?? routeLabelPoint(pts);
    return <EdgeBody id={id} kind={kind} path={roundedPath(pts)} labelX={at.x} labelY={at.y} label={explicit} hideKeyword={d?.hideKeyword === true} />;
  }
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: CORNER_RADIUS,
  });
  return <EdgeBody id={id} kind={kind} path={path} labelX={labelX} labelY={labelY} label={explicit} hideKeyword={d?.hideKeyword === true} />;
}

/** Reduce a React Flow internal node to the geometry the router needs. */
function shapedFromInternal(node: InternalNode): ShapedNode {
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  const pos = node.internals.positionAbsolute;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const kind = String(d.kind ?? d.eClass ?? '');
  return { x: pos.x + w / 2, y: pos.y + h / 2, w, h, shape: shapeForKind(kind) };
}

/**
 * Node-to-node edges. While both end boxes sit where the layout put them, the
 * edge is drawn along its laid-out route, which runs around every other box.
 * Once a box has been moved by hand, the edge FLOATS: it lands on each box's
 * outline facing the other (shape-aware, so edges leaving one box fan out to
 * the right borders) and steps orthogonally between the two.
 */
export function FloatingEdge(props: EdgeProps): JSX.Element {
  const { id, source, target, data, label } = props;
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const d = data as Record<string, unknown> | undefined;
  const kind = String(d?.kind ?? 'default');
  const explicit = label ?? d?.label;
  if (!sourceNode || !targetNode) return <></>;
  const route = currentRoute(d, sourceNode, targetNode);
  if (route) {
    const at = (d?.labelAt as Point | undefined) ?? routeLabelPoint(route);
    return <EdgeBody id={id} kind={kind} path={roundedPath(route)} labelX={at.x} labelY={at.y} label={explicit} hideKeyword={d?.hideKeyword === true} />;
  }
  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeEndpoints(
    shapedFromInternal(sourceNode),
    shapedFromInternal(targetNode),
  );
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
    borderRadius: CORNER_RADIUS,
  });
  return <EdgeBody id={id} kind={kind} path={path} labelX={labelX} labelY={labelY} label={explicit} hideKeyword={d?.hideKeyword === true} />;
}

/**
 * The data-driven SysML edge (registered as the default `sysml` edge type). It
 * dispatches per-edge: an edge carrying an explicit port handle
 * (`sourceHandleId`/`targetHandleId`, set by {@link toReactFlowEdge} for
 * interconnection/IBD port-to-port connectors) stays anchored on its handles;
 * every other edge is drawn by {@link FloatingEdge}. Both follow the laid-out
 * orthogonal route while it is current.
 */
export function SysmlEdge(props: EdgeProps): JSX.Element {
  const isPortEdge = props.sourceHandleId != null || props.targetHandleId != null;
  return isPortEdge ? <HandleEdge {...props} /> : <FloatingEdge {...props} />;
}

/**
 * SVG marker definitions for the SysML edge ends. Render once inside the React
 * Flow canvas (e.g. as a child of `<ReactFlow>`), so `url(#…)` references resolve.
 */
export function EdgeMarkers(): JSX.Element {
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
      <defs>
        <marker id={MARKER.composite} markerWidth="16" markerHeight="12" refX="1" refY="6" orient="auto">
          <path d="M1,6 L8,2 L15,6 L8,10 Z" fill="var(--node-line)" />
        </marker>
        <marker id={MARKER.aggregate} markerWidth="16" markerHeight="12" refX="1" refY="6" orient="auto">
          <path d="M1,6 L8,2 L15,6 L8,10 Z" fill="var(--node-bg)" stroke="var(--node-line)" />
        </marker>
        <marker id={MARKER.reference} markerWidth="16" markerHeight="12" refX="1" refY="6" orient="auto">
          <path d="M1,6 L8,2 L15,6 L8,10 Z" fill="var(--node-bg)" stroke="var(--node-line)" />
        </marker>
        <marker id={MARKER.specialize} markerWidth="14" markerHeight="14" refX="12" refY="6" orient="auto">
          <path d="M1,1 L12,6 L1,11 Z" fill="var(--node-bg)" stroke="var(--node-line)" />
        </marker>
        <marker id={MARKER.arrow} markerWidth="12" markerHeight="12" refX="9" refY="4" orient="auto">
          <path d="M0,0 L9,4 L0,8 Z" fill="var(--node-line)" />
        </marker>
        <marker id={MARKER.open} markerWidth="14" markerHeight="12" refX="10" refY="5" orient="auto">
          <path d="M1,1 L10,5 L1,9" fill="none" stroke="var(--dgm-violet)" />
        </marker>
        <marker id={MARKER.typedBy} markerWidth="14" markerHeight="12" refX="10" refY="5" orient="auto">
          <path d="M1,1 L10,5 L1,9" fill="none" stroke="var(--node-line)" />
        </marker>
        <marker id={MARKER.crosshair} markerWidth="14" markerHeight="14" refX="7" refY="7" orient="auto">
          <circle cx="7" cy="7" r="6" fill="var(--node-bg)" stroke="var(--node-muted)" />
          <path d="M7,2 L7,12 M2,7 L12,7" stroke="var(--node-muted)" />
        </marker>
      </defs>
    </svg>
  );
}

/**
 * React Flow `edgeTypes` map. `sysml` is the smart default: it FLOATS onto node
 * outlines unless the edge carries a port handle, in which case it stays
 * handle-anchored. `floating` is exposed for callers that want the floating
 * renderer unconditionally.
 */
export const edgeTypes = {
  sysml: SysmlEdge,
  floating: FloatingEdge,
} as const;

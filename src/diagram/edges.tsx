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
  getBezierPath,
  useInternalNode,
  type EdgeProps,
  type InternalNode,
} from '@xyflow/react';
import type { CSSProperties } from 'react';
import { getEdgeEndpoints, shapeForKind, type ShapedNode } from './geometry';

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
}): JSX.Element {
  const spec = edgeStyleFor(props.kind);
  // Fall back to the SysML «keyword» for the dependency family (satisfy/allocate/…)
  // so those dashed connectors are self-describing even without a model label.
  const text = props.label ?? (spec.keyword ? `«${spec.keyword}»` : undefined);
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

/**
 * Handle-anchored bezier — the original behaviour. Used for PORT edges
 * (interconnection / IBD ConnectionUsages) whose endpoints React Flow has
 * already resolved to a specific boundary-port handle, so their routing must NOT
 * be recomputed. The `sourceX/Y`…`targetPosition` props already sit on the ports.
 */
function HandleEdge(props: EdgeProps): JSX.Element {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label } = props;
  const kind = String((data as Record<string, unknown> | undefined)?.kind ?? 'default');
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const explicit = label ?? (data as Record<string, unknown> | undefined)?.label;
  return <EdgeBody id={id} kind={kind} path={path} labelX={labelX} labelY={labelY} label={explicit} />;
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
 * Shape-aware FLOATING edge (the fix): reads both endpoints' measured
 * position+size and rendered shape, then lands the connector exactly on each
 * node's outline facing the other node — so multiple edges leaving one box fan
 * out to the correct borders instead of stacking on the bottom-centre handle.
 */
export function FloatingEdge(props: EdgeProps): JSX.Element {
  const { id, source, target, data, label } = props;
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const kind = String((data as Record<string, unknown> | undefined)?.kind ?? 'default');
  const explicit = label ?? (data as Record<string, unknown> | undefined)?.label;
  if (!sourceNode || !targetNode) return <></>;
  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeEndpoints(
    shapedFromInternal(sourceNode),
    shapedFromInternal(targetNode),
  );
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
  });
  return <EdgeBody id={id} kind={kind} path={path} labelX={labelX} labelY={labelY} label={explicit} />;
}

/**
 * The data-driven SysML edge (registered as the default `sysml` edge type). It
 * dispatches per-edge: an edge carrying an explicit port handle
 * (`sourceHandleId`/`targetHandleId`, set by {@link toReactFlowEdge} for
 * interconnection/IBD port-to-port connectors) keeps the handle-anchored bezier;
 * every other edge floats onto the node outlines via {@link FloatingEdge}.
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

/**
 * Pure edge-routing geometry for shape-aware FLOATING edges.
 *
 * React Flow anchors edges to fixed Handles, so several edges leaving one node
 * all emanate from the single bottom-centre handle and never meet the border
 * facing their neighbour. To fix that we recompute each endpoint as the point on
 * the node's *outline* (for its rendered shape) that lies along the ray from the
 * node centre toward the other node. This module is that math: framework-light
 * (only the `Position` string enum is borrowed from React Flow for bezier
 * tangents), Three.js-free, deterministic and unit-testable in isolation.
 *
 * Coordinate convention: a {@link ShapedNode} is described by its CENTRE
 * (`x`,`y`) plus width/height (`w`,`h`) — not its top-left corner. Callers that
 * hold a top-left position (React Flow's `positionAbsolute`) add `w/2`,`h/2`.
 */

import { Position } from '@xyflow/react';

/** The outline families a node can render as (see {@link shapeForKind}). */
export type NodeShape = 'rect' | 'roundrect' | 'ellipse' | 'diamond' | 'stadium' | 'bar';

/** A 2-D point. */
export interface Point {
  x: number;
  y: number;
}

/** A node reduced to the geometry the router needs: centre, size and shape. */
export interface ShapedNode {
  /** Centre X (absolute canvas coordinates). */
  x: number;
  /** Centre Y (absolute canvas coordinates). */
  y: number;
  /** Measured width; `0`/`NaN` means "unmeasured" and triggers a centre fallback. */
  w: number;
  /** Measured height; `0`/`NaN` means "unmeasured". */
  h: number;
  /** The rendered outline family. */
  shape: NodeShape;
}

/** The endpoints of one floating edge plus the nearest side at each end. */
export interface EdgeEndpoints {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  sourcePos: Position;
  targetPos: Position;
}

const EPS = 1e-9;

/**
 * Map a node metaclass/kind to the outline it is drawn with. This MUST track
 * the shapes rendered in `nodes.tsx`:
 *
 *  - Use-case / case boxes (`UseCaseUsage`/`UseCaseDefinition`/`CaseUsage`/
 *    `CaseDefinition`) get the `'case'` variant and are drawn as ELLIPSES.
 *  - `InitialNode`/`DoneNode` control markers are drawn as circles → `'ellipse'`.
 *  - `DecisionNode`/`MergeNode` control nodes render as a `'diamond'`.
 *  - `ForkNode`/`JoinNode` render as a thin `'bar'`.
 *  - `StateUsage`/`StateDefinition`/`ExhibitStateUsage` render as a `'stadium'`
 *    (rounded-end pill).
 *  - Everything else is a rounded rectangle (`boxStyle.borderRadius` / the
 *    constraint & requirement variants) → `'roundrect'`.
 *
 * `'rect'` is available for callers/tests that want a hard-cornered box; the
 * intersection math treats `'rect'`, `'roundrect'` and `'bar'` identically (a
 * ray–rectangle clip), so the roundrect corner radius does not change routing.
 */
export function shapeForKind(kindOrEClass: string): NodeShape {
  switch (kindOrEClass) {
    case 'UseCaseUsage':
    case 'UseCaseDefinition':
    case 'CaseUsage':
    case 'CaseDefinition':
    case 'InitialNode':
    case 'DoneNode':
      return 'ellipse';
    case 'DecisionNode':
    case 'MergeNode':
      return 'diamond';
    case 'ForkNode':
    case 'JoinNode':
      return 'bar';
    case 'StateUsage':
    case 'StateDefinition':
    case 'ExhibitStateUsage':
      return 'stadium';
    default:
      return 'roundrect';
  }
}

/* ─────────────────────────── per-shape intersections ───────────────────────── */

/** Ray–rectangle clip: the boundary point of a `2rx × 2ry` box. */
function rectIntersection(cx: number, cy: number, rx: number, ry: number, dx: number, dy: number): Point {
  const s = 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** Ray–ellipse: scale to the unit circle, intersect, scale back. */
function ellipseIntersection(cx: number, cy: number, rx: number, ry: number, dx: number, dy: number): Point {
  const s = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
  return { x: cx + dx * s, y: cy + dy * s };
}

/** Ray–rhombus `|x|/rx + |y|/ry = 1`. */
function diamondIntersection(cx: number, cy: number, rx: number, ry: number, dx: number, dy: number): Point {
  const s = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** Outward (far) intersection of a ray from `(cx,cy)` with a circle. */
function circleIntersection(
  cx: number,
  cy: number,
  ccx: number,
  ccy: number,
  r: number,
  dx: number,
  dy: number,
): Point {
  const ex = cx - ccx;
  const ey = cy - ccy;
  const a = dx * dx + dy * dy;
  const b = 2 * (ex * dx + ey * dy);
  const c = ex * ex + ey * ey - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return { x: cx + dx, y: cy + dy };
  const s = (-b + Math.sqrt(disc)) / (2 * a); // far (outward) root
  return { x: cx + dx * s, y: cy + dy * s };
}

/**
 * Ray–stadium (pill): a rectangle body capped by two semicircles on its long
 * axis. Clip against the bounding rectangle first; if that point lands in the
 * flat straight section, keep it, otherwise re-solve against the near cap circle.
 */
function stadiumIntersection(cx: number, cy: number, rx: number, ry: number, dx: number, dy: number): Point {
  const horizontal = rx >= ry;
  const r = Math.min(rx, ry); // cap radius
  const half = horizontal ? rx : ry; // half-length along the long axis
  const a = half - r; // half-length of the flat (straight) section
  const rect = rectIntersection(cx, cy, rx, ry, dx, dy);
  if (horizontal) {
    if (Math.abs(rect.x - cx) <= a + EPS) return rect; // flat top/bottom edge
    return circleIntersection(cx, cy, cx + Math.sign(dx) * a, cy, r, dx, dy);
  }
  if (Math.abs(rect.y - cy) <= a + EPS) return rect; // flat left/right edge
  return circleIntersection(cx, cy, cx, cy + Math.sign(dy) * a, r, dx, dy);
}

/**
 * The point on `node`'s boundary (for its {@link NodeShape}) along the ray from
 * the node centre toward `toward`.
 *
 * Defensive: falls back to the node centre when the node is unmeasured
 * (`w`/`h` ≤ 0), and to the bottom-centre when the ray is zero-length
 * (coincident centres).
 */
export function getNodeIntersection(node: ShapedNode, toward: Point): Point {
  const { x: cx, y: cy, w, h } = node;
  if (!(w > 0) || !(h > 0)) return { x: cx, y: cy };
  const rx = w / 2;
  const ry = h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return { x: cx, y: cy + ry };
  switch (node.shape) {
    case 'ellipse':
      return ellipseIntersection(cx, cy, rx, ry, dx, dy);
    case 'diamond':
      return diamondIntersection(cx, cy, rx, ry, dx, dy);
    case 'stadium':
      return stadiumIntersection(cx, cy, rx, ry, dx, dy);
    case 'rect':
    case 'roundrect':
    case 'bar':
    default:
      return rectIntersection(cx, cy, rx, ry, dx, dy);
  }
}

/** The React Flow `Position` (side) nearest a boundary point on `node`. */
function nearestPosition(node: ShapedNode, p: Point): Position {
  const rx = node.w > 0 ? node.w / 2 : 1;
  const ry = node.h > 0 ? node.h / 2 : 1;
  const nx = (p.x - node.x) / rx;
  const ny = (p.y - node.y) / ry;
  if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? Position.Right : Position.Left;
  return ny >= 0 ? Position.Bottom : Position.Top;
}

/**
 * Compute both endpoints of a floating edge: the boundary intersections on the
 * source and target nodes along their centre-to-centre line, plus the React Flow
 * `Position` nearest each intersection (used for bezier tangents).
 */
export function getEdgeEndpoints(source: ShapedNode, target: ShapedNode): EdgeEndpoints {
  const s = getNodeIntersection(source, { x: target.x, y: target.y });
  const t = getNodeIntersection(target, { x: source.x, y: source.y });
  return {
    sx: s.x,
    sy: s.y,
    tx: t.x,
    ty: t.y,
    sourcePos: nearestPosition(source, s),
    targetPos: nearestPosition(target, t),
  };
}

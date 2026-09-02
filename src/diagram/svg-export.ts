/**
 * svgFromDiagram — render a laid-out {@link DiagramGraph} into a standalone,
 * self-contained `<svg>` string.
 *
 * This is a PURE function (no DOM, no React, no React Flow): it walks the same
 * node positions/sizes the on-screen renderer uses and reproduces, in flat SVG,
 * each node's canonical SysML shape (rect/roundrect, use-case ellipse, control
 * diamond/bar, state stadium) with its «keyword» + name, and each edge as a
 * straight connector clipped to the two shape borders (reusing
 * {@link getEdgeEndpoints}) with the per-kind SysML markers + line style
 * (reusing {@link edgeStyleFor}).
 *
 * The result is a de-facto graphical interchange format: SysML v2 has no
 * standardized diagram-interchange file, but a standalone SVG round-trips into
 * every vector tool and rasterises cleanly to PNG (see the UI's Export PNG,
 * which draws this SVG onto a `<canvas>`). Output is deterministic (nodes/edges
 * emitted in array order; no timestamps/random ids) and XML-escaped.
 */

import { TEXTUAL_KEYWORD } from '@core/index';
import { edgeStyleFor, MARKER } from './edges';
import { getEdgeEndpoints, shapeForKind, type NodeShape, type ShapedNode } from './geometry';
import type { DiagramGraph, DiagramNode } from './types';

/* ─────────────────────────────── options ───────────────────────────────── */

/** Options for {@link svgFromDiagram}. */
export interface SvgExportOptions {
  /** Padding (px) around the node bounding box added to the viewBox. Default 24. */
  padding?: number;
  /** Font family for all text. Default a system sans-serif stack. */
  fontFamily?: string;
  /** Fallback node width when a node has no measured size. Default 180. */
  defaultNodeWidth?: number;
  /** Fallback node height when a node has no measured size. Default 80. */
  defaultNodeHeight?: number;
  /** Emit «keyword»/name text inside nodes and labels on edges. Default true. */
  labels?: boolean;
}

const DEFAULT_PADDING = 24;
const DEFAULT_FONT = 'system-ui, -apple-system, Segoe UI, sans-serif';
const DEFAULT_W = 180;
const DEFAULT_H = 80;

/* Palette mirrors nodes.tsx / edges.tsx so the export reads like the canvas. */
const NODE_FILL = '#ffffff';
const NODE_STROKE = '#4a5568';
const KEYWORD_INK = '#718096';
const NAME_INK = '#2d3748';
const CONTROL_INK = '#2d3748';
const EDGE_INK = '#4a5568';

/* ──────────────────────────────── helpers ──────────────────────────────── */

/** Escape the five XML metacharacters for safe text/attribute content. */
export function escapeXml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Round to a stable, compact numeric string (no `-0`, no long float tails). */
function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

/** The «keyword» guillemet string for a node (from `data.keyword` or the metaclass). */
function keywordOf(node: DiagramNode): string {
  const fromData = (node.data as Record<string, unknown> | undefined)?.keyword;
  const kw = typeof fromData === 'string' && fromData ? fromData : TEXTUAL_KEYWORD[node.kind] ?? node.kind;
  return `«${kw}»`;
}

/** The primary name text for a node. */
function nameOf(node: DiagramNode): string {
  const fromData = (node.data as Record<string, unknown> | undefined)?.name;
  if (typeof fromData === 'string' && fromData) return fromData;
  return node.label ?? '';
}

/** A node's size, falling back to the configured defaults when unmeasured. */
function sizeOf(node: DiagramNode, dw: number, dh: number): { w: number; h: number } {
  const w = node.size?.w;
  const h = node.size?.h;
  return { w: w && w > 0 ? w : dw, h: h && h > 0 ? h : dh };
}

/**
 * Absolute top-left of a node. Layout assigns nested nodes a *parent-relative*
 * position (matching React Flow), so we sum the position up the `parentId`
 * chain. Guards against cycles/missing parents.
 */
function absolutePosition(
  node: DiagramNode,
  byId: Map<string, DiagramNode>,
): { x: number; y: number } {
  let x = node.position?.x ?? 0;
  let y = node.position?.y ?? 0;
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position?.x ?? 0;
    y += parent.position?.y ?? 0;
    parentId = parent.parentId;
  }
  return { x, y };
}

/** Resolve an edge endpoint (a node id or a boundary-port id) to its owning node id. */
function ownerNodeId(endpoint: string, nodes: DiagramNode[]): string {
  for (const n of nodes) {
    if (n.id === endpoint) return endpoint;
    if (n.ports?.some((p) => p.id === endpoint)) return n.id;
  }
  return endpoint;
}

/* ─────────────────────────────── shapes ────────────────────────────────── */

/** Draw a node's outline `<…>` element (no text) for its {@link NodeShape}. */
function shapeElement(
  shape: NodeShape,
  x: number,
  y: number,
  w: number,
  h: number,
  isControl: boolean,
): string {
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (shape) {
    case 'ellipse':
      return (
        `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(w / 2)}" ry="${num(h / 2)}" ` +
        `fill="${NODE_FILL}" stroke="${NODE_STROKE}" />`
      );
    case 'diamond': {
      const pts = [
        `${num(cx)},${num(y)}`,
        `${num(x + w)},${num(cy)}`,
        `${num(cx)},${num(y + h)}`,
        `${num(x)},${num(cy)}`,
      ].join(' ');
      return `<polygon points="${pts}" fill="${NODE_FILL}" stroke="${NODE_STROKE}" />`;
    }
    case 'bar':
      // Fork/join synchronization bar — a solid filled rectangle.
      return (
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ` +
        `rx="2" fill="${CONTROL_INK}" stroke="${CONTROL_INK}" />`
      );
    case 'stadium': {
      // Rounded-end pill: a rect whose corner radius is half its short side.
      const r = Math.min(w, h) / 2;
      return (
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ` +
        `rx="${num(r)}" ry="${num(r)}" fill="${NODE_FILL}" stroke="${NODE_STROKE}" />`
      );
    }
    case 'rect':
      return (
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ` +
        `fill="${isControl ? CONTROL_INK : NODE_FILL}" stroke="${NODE_STROKE}" />`
      );
    case 'roundrect':
    default:
      return (
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ` +
        `rx="4" ry="4" fill="${NODE_FILL}" stroke="${NODE_STROKE}" />`
      );
  }
}

/** Node metaclasses drawn as small control glyphs with no header/label text. */
function isControlKind(shape: NodeShape): boolean {
  return shape === 'bar';
}

/** Emit the `<text>` block (keyword + name) centred in a node, or '' when disabled. */
function nodeText(
  node: DiagramNode,
  shape: NodeShape,
  cx: number,
  cy: number,
  fontFamily: string,
): string {
  if (shape === 'bar') return ''; // fork/join bars carry no text
  const keyword = keywordOf(node);
  const name = nameOf(node);
  const parts: string[] = [];
  // Two stacked, centred lines: italic grey «keyword» above the bold name.
  parts.push(
    `<text x="${num(cx)}" y="${num(cy - 3)}" text-anchor="middle" ` +
      `font-family="${escapeXml(fontFamily)}" font-size="10" font-style="italic" ` +
      `fill="${KEYWORD_INK}">${escapeXml(keyword)}</text>`,
  );
  if (name) {
    parts.push(
      `<text x="${num(cx)}" y="${num(cy + 12)}" text-anchor="middle" ` +
        `font-family="${escapeXml(fontFamily)}" font-size="12" font-weight="600" ` +
        `fill="${NAME_INK}">${escapeXml(name)}</text>`,
    );
  }
  return parts.join('');
}

/* ──────────────────────────────── markers ──────────────────────────────── */

/**
 * The `<defs>` block of SVG `<marker>`s for the SysML edge ends, mirroring the
 * shapes in {@link EdgeMarkers} (edges.tsx) so the exported connectors carry the
 * same filled-diamond/open-diamond/triangle/arrow adornments.
 */
function markerDefs(): string {
  return (
    '<defs>' +
    `<marker id="${MARKER.composite}" markerWidth="16" markerHeight="12" refX="1" refY="6" orient="auto">` +
    `<path d="M1,6 L8,2 L15,6 L8,10 Z" fill="${EDGE_INK}" /></marker>` +
    `<marker id="${MARKER.aggregate}" markerWidth="16" markerHeight="12" refX="1" refY="6" orient="auto">` +
    `<path d="M1,6 L8,2 L15,6 L8,10 Z" fill="#fff" stroke="${EDGE_INK}" /></marker>` +
    `<marker id="${MARKER.reference}" markerWidth="16" markerHeight="12" refX="1" refY="6" orient="auto">` +
    `<path d="M1,6 L8,2 L15,6 L8,10 Z" fill="#fff" stroke="${EDGE_INK}" /></marker>` +
    `<marker id="${MARKER.specialize}" markerWidth="14" markerHeight="14" refX="12" refY="6" orient="auto">` +
    `<path d="M1,1 L12,6 L1,11 Z" fill="#fff" stroke="${EDGE_INK}" /></marker>` +
    `<marker id="${MARKER.arrow}" markerWidth="12" markerHeight="12" refX="9" refY="4" orient="auto">` +
    `<path d="M0,0 L9,4 L0,8 Z" fill="${EDGE_INK}" /></marker>` +
    `<marker id="${MARKER.open}" markerWidth="14" markerHeight="12" refX="10" refY="5" orient="auto">` +
    '<path d="M1,1 L10,5 L1,9" fill="none" stroke="#805ad5" /></marker>' +
    `<marker id="${MARKER.typedBy}" markerWidth="14" markerHeight="12" refX="10" refY="5" orient="auto">` +
    `<path d="M1,1 L10,5 L1,9" fill="none" stroke="${EDGE_INK}" /></marker>` +
    `<marker id="${MARKER.crosshair}" markerWidth="14" markerHeight="14" refX="7" refY="7" orient="auto">` +
    '<circle cx="7" cy="7" r="6" fill="#fff" stroke="#a0aec0" />' +
    '<path d="M7,2 L7,12 M2,7 L12,7" stroke="#a0aec0" /></marker>' +
    '</defs>'
  );
}

/* ─────────────────────────────── main ──────────────────────────────────── */

/**
 * Render `graph` (already laid out — its nodes carry `position`/`size`) into a
 * standalone `<svg>` string. Nodes are drawn in their SysML shapes at their
 * positions; edges are straight connectors clipped to the shape borders via
 * {@link getEdgeEndpoints}, styled per kind via {@link edgeStyleFor}. The
 * `viewBox` encloses every node (plus `opts.padding`). Deterministic.
 */
export function svgFromDiagram(graph: DiagramGraph, opts: SvgExportOptions = {}): string {
  const padding = opts.padding ?? DEFAULT_PADDING;
  const fontFamily = opts.fontFamily ?? DEFAULT_FONT;
  const dw = opts.defaultNodeWidth ?? DEFAULT_W;
  const dh = opts.defaultNodeHeight ?? DEFAULT_H;
  const withLabels = opts.labels ?? true;

  const nodes = graph.nodes;
  const edges = graph.edges;
  const byId = new Map<string, DiagramNode>(nodes.map((n) => [n.id, n]));

  // Resolve absolute geometry for every node once (top-left + size + centre + shape).
  interface Placed {
    node: DiagramNode;
    x: number;
    y: number;
    w: number;
    h: number;
    shape: NodeShape;
  }
  const placed = new Map<string, Placed>();
  for (const node of nodes) {
    const { x, y } = absolutePosition(node, byId);
    const { w, h } = sizeOf(node, dw, dh);
    placed.set(node.id, { node, x, y, w, h, shape: shapeForKind(node.kind) });
  }

  // viewBox: bounding box of all node rectangles, padded. Empty graph → unit box.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }
  const vbX = minX - padding;
  const vbY = minY - padding;
  const vbW = maxX - minX + padding * 2;
  const vbH = maxY - minY + padding * 2;

  /* ── edges first (so they sit under the node boxes) ── */
  const edgeSvg: string[] = [];
  for (const edge of edges) {
    const sId = ownerNodeId(edge.source, nodes);
    const tId = ownerNodeId(edge.target, nodes);
    const s = placed.get(sId);
    const t = placed.get(tId);
    if (!s || !t) continue; // dangling endpoint — skip

    const spec = edgeStyleFor(edge.kind);
    const stroke = spec.stroke ?? EDGE_INK;
    const dash = spec.dashed ? ' stroke-dasharray="6 4"' : '';
    const markerStart = spec.markerStart ? ` marker-start="url(#${spec.markerStart})"` : '';
    const markerEnd = spec.markerEnd ? ` marker-end="url(#${spec.markerEnd})"` : '';

    const sShaped: ShapedNode = { x: s.x + s.w / 2, y: s.y + s.h / 2, w: s.w, h: s.h, shape: s.shape };
    const tShaped: ShapedNode = { x: t.x + t.w / 2, y: t.y + t.h / 2, w: t.w, h: t.h, shape: t.shape };
    const { sx, sy, tx, ty } = getEdgeEndpoints(sShaped, tShaped);

    edgeSvg.push(
      `<path data-edge-id="${escapeXml(edge.id)}" data-kind="${escapeXml(edge.kind)}" ` +
        `d="M ${num(sx)} ${num(sy)} L ${num(tx)} ${num(ty)}" fill="none" ` +
        `stroke="${stroke}" stroke-width="1.5"${dash}${markerStart}${markerEnd} />`,
    );

    // Edge label: the explicit model label, else the «keyword» for the dependency family.
    const labelText = edge.label ?? (spec.keyword ? `«${spec.keyword}»` : undefined);
    if (withLabels && labelText) {
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      edgeSvg.push(
        `<text x="${num(mx)}" y="${num(my - 3)}" text-anchor="middle" ` +
          `font-family="${escapeXml(fontFamily)}" font-size="10" fill="${NAME_INK}">` +
          `${escapeXml(labelText)}</text>`,
      );
    }
  }

  /* ── nodes on top ── */
  const nodeSvg: string[] = [];
  for (const node of nodes) {
    const p = placed.get(node.id);
    if (!p) continue;
    const control = isControlKind(p.shape);
    nodeSvg.push(
      `<g data-node-id="${escapeXml(node.id)}" data-kind="${escapeXml(node.kind)}" ` +
        `data-shape="${p.shape}">`,
    );
    nodeSvg.push(shapeElement(p.shape, p.x, p.y, p.w, p.h, control));
    if (withLabels) {
      nodeSvg.push(nodeText(node, p.shape, p.x + p.w / 2, p.y + p.h / 2, fontFamily));
    }
    nodeSvg.push('</g>');
  }

  const width = num(vbW);
  const height = num(vbH);
  const viewBox = `${num(vbX)} ${num(vbY)} ${num(vbW)} ${num(vbH)}`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${viewBox}" data-view="${escapeXml(graph.viewKind)}" ` +
    `data-node-count="${nodes.length}" data-edge-count="${edges.length}">` +
    markerDefs() +
    `<rect x="${num(vbX)}" y="${num(vbY)}" width="${width}" height="${height}" fill="#ffffff" />` +
    `<g data-layer="edges">${edgeSvg.join('')}</g>` +
    `<g data-layer="nodes">${nodeSvg.join('')}</g>` +
    '</svg>'
  );
}

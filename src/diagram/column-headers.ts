/**
 * Headers over the layer columns of a layered General view.
 *
 * `assignPackagePartitions` (build.ts) tags every box with its top-level
 * package, and the layout keeps the packages of one connected piece as columns,
 * left to right. This file names those columns: which x-range each package
 * holds in a piece, how tall the header band above them is, and how large its
 * label may be. Pure: the layout reserves the band (layout.ts), so no box
 * overlaps it, and the canvas and the SVG export draw it.
 */

import type { DiagramColumn } from './types';
import { textWidth } from './text-measure';

/** Shortest header band (px): one line of text with room around it. */
export const COLUMN_HEADER_MIN_H = 32;
/**
 * Tallest band. A whole model's piece is tens of thousands of px wide, and its
 * header is the one label read when zoomed far out, so the band grows with the
 * piece (`COLUMN_HEADER_SHARE`) — up to a few screens, no further.
 */
export const COLUMN_HEADER_MAX_H = 640;
/** The band is this share of the piece's width, between the two limits above. */
const COLUMN_HEADER_SHARE = 0.04;
/** Empty space between the band and the first box under it. */
export const COLUMN_HEADER_GAP = 8;
/** The label's largest size is this share of the band's height. */
const COLUMN_LABEL_SHARE = 0.55;
/** Size (screen px) the canvas draws a label at, while the band leaves room for it. */
export const COLUMN_LABEL_SCREEN_PX = 14;
/** Room left on each side of a label, in ems of the label's size (`.column-header` in layout.css). */
export const COLUMN_LABEL_PAD_EM = 0.4;
/** A label too wide for its column is shrunk to no less than this share of its size, then cut. */
const COLUMN_LABEL_FLOOR = 0.6;

/** Height (screen px) of the frozen strip along the canvas top, which repeats the headers a pan or a far zoom leaves unreadable. */
export const COLUMN_STRIP_H = 22;
/** Size (screen px) of a strip label, whatever the zoom (`.column-strip-cell` in layout.css); at least 9 so it reads at the drone swarm's Fit. */
export const COLUMN_STRIP_LABEL_PX = 12;
/** A column narrower than this on screen (px) gets no strip label: it would be only an ellipsis. */
export const COLUMN_STRIP_MIN_W = 28;

/** One package's x-range within a piece. */
export interface ColumnSpan {
  /** Index into `DiagramGraph.partitions`. */
  partition: number;
  x0: number;
  x1: number;
}

/**
 * The columns of one piece, left to right: each package's x-range over the
 * boxes it holds. Empty unless the piece spans two packages or more — a piece
 * inside one package is not a column of anything, and says nothing by a header.
 */
export function columnSpans(boxes: readonly { partition: number; x: number; w: number }[]): ColumnSpan[] {
  const spans = new Map<number, ColumnSpan>();
  for (const b of boxes) {
    const s = spans.get(b.partition);
    if (s) {
      s.x0 = Math.min(s.x0, b.x);
      s.x1 = Math.max(s.x1, b.x + b.w);
    } else {
      spans.set(b.partition, { partition: b.partition, x0: b.x, x1: b.x + b.w });
    }
  }
  return spans.size < 2 ? [] : [...spans.values()].sort((a, b) => a.partition - b.partition);
}

/** Height of the header band over a piece `width` px wide. */
export function columnHeaderHeight(width: number): number {
  return Math.min(COLUMN_HEADER_MAX_H, Math.max(COLUMN_HEADER_MIN_H, Math.round(width * COLUMN_HEADER_SHARE)));
}

/** The largest size (px) a label may take in a band `height` px tall. */
export function columnLabelSize(height: number): number {
  return Math.round(height * COLUMN_LABEL_SHARE);
}

/**
 * Size (diagram px) to draw a column's label at `zoom`: the size that reads as
 * {@link COLUMN_LABEL_SCREEN_PX} on screen — so a header stays legible from far
 * out — but never larger than the band holds, and never smaller than at 100%.
 */
export function columnLabelSizeAt(column: Pick<DiagramColumn, 'fontSize'>, zoom: number): number {
  const wanted = COLUMN_LABEL_SCREEN_PX / (zoom > 0 ? zoom : 1);
  return Math.min(column.fontSize, Math.max(COLUMN_LABEL_SCREEN_PX, wanted));
}

/**
 * The size (px) to draw `text` at in a column `columnWidth` px wide: `size`, or
 * smaller when the name would not fit — down to {@link COLUMN_LABEL_FLOOR} of
 * `size`, so a long package name keeps as much of itself as the column allows
 * before {@link fitColumnLabel} cuts what is left.
 */
export function columnLabelSizeFor(text: string, columnWidth: number, size: number): number {
  const perPx = textWidth(text, `600 ${size}px system-ui, sans-serif`, size * 0.6) / size;
  const fits = columnWidth / (perPx + 2 * COLUMN_LABEL_PAD_EM);
  return Math.max(size * COLUMN_LABEL_FLOOR, Math.min(size, fits));
}

/** `text` cut with an ellipsis to fit `maxWidth` px at `fontSize` (the export, which cannot clip by CSS). */
export function fitColumnLabel(text: string, maxWidth: number, fontSize: number): string {
  const font = `600 ${fontSize}px system-ui, sans-serif`;
  const width = (t: string): number => textWidth(t, font, fontSize * 0.6);
  if (width(text) <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && width(`${text.slice(0, cut)}…`) > maxWidth) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** One header of the frozen strip, in screen px: `left` and `width` from the canvas's left edge, `top` from the strip's top. */
export interface ColumnStripCell {
  id: string;
  elementId: string;
  label: string;
  left: number;
  width: number;
  top: number;
}

/**
 * The headers the frozen strip shows for a viewport (`x`, `y`, `zoom` as React
 * Flow keeps them) on a canvas `canvasWidth` px wide, the strip starting
 * `stripTop` px below the canvas's top. A header is in the strip while its piece
 * reaches the strip's rows, clamped to that piece: it stays at the strip's top
 * as the piece runs beneath it and leaves upward with the piece's bottom edge.
 * Its x-range is the column's, clipped to the canvas. A header whose own band
 * is on screen below the strip and tall enough to read ({@link COLUMN_STRIP_H})
 * is left to the band; so is a column too narrow on screen for a label.
 */
export function columnStripCells(
  columns: readonly DiagramColumn[],
  view: { x: number; y: number; zoom: number },
  canvasWidth: number,
  stripTop: number,
): ColumnStripCell[] {
  const cells: ColumnStripCell[] = [];
  for (const c of columns) {
    const pieceTop = c.y * view.zoom + view.y;
    const pieceBottom = c.bottom * view.zoom + view.y;
    if (pieceTop >= stripTop + COLUMN_STRIP_H || pieceBottom <= stripTop) continue;
    if (pieceTop >= stripTop && c.h * view.zoom >= COLUMN_STRIP_H) continue;
    const left = Math.max(0, c.x * view.zoom + view.x);
    const right = Math.min(canvasWidth, (c.x + c.w) * view.zoom + view.x);
    if (right - left < COLUMN_STRIP_MIN_W) continue;
    const top = Math.min(Math.max(pieceTop, stripTop), pieceBottom - COLUMN_STRIP_H) - stripTop;
    cells.push({ id: c.id, elementId: c.elementId, label: c.label, left, width: right - left, top });
  }
  return cells;
}

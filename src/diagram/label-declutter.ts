/**
 * Which node labels to draw in a dense scatter of nodes (the graph-analysis
 * view), so that no two labels overlap and every drawn label is legible.
 *
 * Greedy placement in priority order — the selected node first, then the
 * largest (the most central), then by name — each label taking a box to the
 * right of its dot; a label whose box would cover a label already placed, or
 * the dot of a node at least as large, is left out — so the labels of the
 * hubs, which sit where the dots are densest, are the ones that get drawn. Labels keep a fixed size ON SCREEN, so
 * zooming in makes room and more of them appear ("overview first, zoom and
 * filter, then details on demand" — Shneiderman 1996). Pure; exported for tests.
 */

import { textWidth } from './text-measure';

export interface LabelledDot {
  id: string;
  label: string;
  x: number;
  y: number;
  /** Radius in diagram units. */
  size: number;
}

export interface LabelBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * @param dots       the nodes, in diagram units
 * @param view       the visible region, in diagram units
 * @param unitsPerPx diagram units per screen pixel at the current zoom
 * @param fontPx     label size on screen
 * @param first      a node whose label is placed first (the selection)
 */
export function declutterLabels(
  dots: LabelledDot[],
  view: { x: number; y: number; w: number; h: number },
  unitsPerPx: number,
  fontPx = 11,
  first: string | null = null,
): LabelBox[] {
  // Measured as drawn (canvas), so wide glyphs cannot push a label into its neighbour.
  const labelFont = `${fontPx}px system-ui, sans-serif`;
  const lineH = fontPx * 1.25 * unitsPerPx;
  const gap = 2 * unitsPerPx;
  const cell = Math.max(lineH * 4, 1e-9);
  type Rect = { x: number; y: number; w: number; h: number; size?: number };
  const grid = new Map<string, Rect[]>();
  const keysFor = (b: { x: number; y: number; w: number; h: number }): string[] => {
    const out: string[] = [];
    for (let gx = Math.floor(b.x / cell); gx <= Math.floor((b.x + b.w) / cell); gx++) {
      for (let gy = Math.floor(b.y / cell); gy <= Math.floor((b.y + b.h) / cell); gy++) out.push(`${gx},${gy}`);
    }
    return out;
  };
  const occupy = (b: Rect): void => {
    for (const k of keysFor(b)) {
      const list = grid.get(k);
      if (list) list.push(b);
      else grid.set(k, [b]);
    }
  };

  const inView = (d: LabelledDot): boolean =>
    d.x >= view.x && d.x <= view.x + view.w && d.y >= view.y && d.y <= view.y + view.h;
  const visible = dots.filter(inView);
  // Every visible dot is an obstacle: a label must not hide a node.
  const dotBox = new Map<string, Rect>();
  for (const d of visible) {
    const r = Math.max(d.size, 2 * unitsPerPx);
    const b: Rect = { x: d.x - r, y: d.y - r, w: 2 * r, h: 2 * r, size: d.size };
    dotBox.set(d.id, b);
    occupy(b);
  }

  const order = [...visible].sort(
    (a, b) =>
      Number(b.id === first) - Number(a.id === first) || b.size - a.size || a.label.localeCompare(b.label),
  );
  const placed: LabelBox[] = [];
  for (const d of order) {
    if (!d.label) continue;
    const box = {
      x: d.x + d.size + gap,
      y: d.y - lineH / 2,
      w: (textWidth(d.label, labelFont, fontPx * 0.62) + 2) * unitsPerPx,
      h: lineH,
    };
    // The own dot is not in the way of its own label.
    const own = dotBox.get(d.id);
    const blocked = keysFor(box).some((k) =>
      (grid.get(k) ?? []).some(
        (o) =>
          o !== own &&
          // A smaller node's dot does not keep a larger node's label off.
          (o.size === undefined || o.size >= d.size) &&
          box.x < o.x + o.w &&
          o.x < box.x + box.w &&
          box.y < o.y + o.h &&
          o.y < box.y + box.h,
      ),
    );
    if (blocked && d.id !== first) continue;
    occupy(box);
    placed.push({ id: d.id, ...box });
  }
  return placed;
}

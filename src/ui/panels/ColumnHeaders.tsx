/**
 * ColumnHeaders — the package name over each column of a layered General view
 * (`DiagramGraph.columns`). Drawn in the canvas's own space, so a header sits
 * above its column's x-range at any pan and zoom, in the room the layout kept
 * for it: it never lies over a box. The label is sized for the zoom — readable
 * from far out, where a whole model's columns are tens of thousands of px wide
 * — and never outgrows its band; a name wider than its column is shrunk to fit,
 * then cut with an ellipsis (the text stays whole in the page). A click goes
 * through to the canvas.
 *
 * A frozen strip along the canvas's top, just under its toolbar, repeats the
 * headers whose band a pan has left above the screen, or a far zoom has made
 * too small to read: in screen space, at a fixed size, over the column's
 * x-range clipped to the canvas. The boxes scroll beneath it, and a header
 * leaves with the bottom of its piece (`columnStripCells`).
 */

import { ViewportPortal, useStore } from '@xyflow/react';
import { columnLabelSizeAt, columnLabelSizeFor, columnStripCells, type DiagramColumn } from '@diagram/index';

/** Screen y (px) of the strip's top edge: the canvas's floating toolbar's bottom edge and a gap. */
export function columnStripTop(domNode: HTMLElement | null | undefined): number {
  const bar = domNode?.querySelector('.react-flow__panel.top.right');
  const barBottom = domNode && bar ? bar.getBoundingClientRect().bottom - domNode.getBoundingClientRect().top : 0;
  return Math.ceil(barBottom) + 6;
}

export function ColumnHeaders({ columns }: { columns: DiagramColumn[] }): JSX.Element | null {
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const domNode = useStore((s) => s.domNode);
  if (columns.length === 0) return null;
  const zoom = transform[2];
  const stripTop = columnStripTop(domNode);
  const cells = columnStripCells(columns, { x: transform[0], y: transform[1], zoom }, width, stripTop);
  return (
    <>
      <div className="column-strip" data-testid="column-strip" aria-hidden="true" style={{ top: stripTop }}>
        {cells.map((c) => (
          <div
            key={c.id}
            className="column-strip-cell"
            data-testid="column-strip-cell"
            data-elementid={c.elementId}
            style={{ left: c.left, width: c.width, top: c.top }}
          >
            <span>{c.label}</span>
          </div>
        ))}
      </div>
      <ViewportPortal>
        <div className="column-headers" data-testid="column-headers">
          {columns.map((c) => (
            <div
              key={c.id}
              className="column-header"
              data-testid="column-header"
              data-elementid={c.elementId}
              style={{
                left: c.x,
                top: c.y,
                width: c.w,
                height: c.h,
                fontSize: columnLabelSizeFor(c.label, c.w, columnLabelSizeAt(c, zoom)),
              }}
            >
              <span>{c.label}</span>
            </div>
          ))}
        </div>
      </ViewportPortal>
    </>
  );
}

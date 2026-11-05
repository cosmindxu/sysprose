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
 *
 * A column no header names at the zoom (a whole model's smaller pieces at Fit:
 * bands about a pixel tall, columns a few px wide) is named by the pointer: a
 * small label follows it over the column (`columnHoverLabel`).
 */

import { useEffect, useState } from 'react';
import { ViewportPortal, useStore } from '@xyflow/react';
import { columnHoverLabel, columnLabelSizeAt, columnLabelSizeFor, columnStripCells, type DiagramColumn } from '@diagram/index';

/** Screen y (px) of the strip's top edge: the canvas's floating toolbar's bottom edge and a gap. */
export function columnStripTop(domNode: HTMLElement | null | undefined): number {
  const bar = domNode?.querySelector('.react-flow__panel.top.right');
  const barBottom = domNode && bar ? bar.getBoundingClientRect().bottom - domNode.getBoundingClientRect().top : 0;
  return Math.ceil(barBottom) + 6;
}

/**
 * The pointer's label for a column no header names ({@link columnHoverLabel}). A component of its own, so that a
 * pointer move re-renders this label and not the headers.
 */
function ColumnHover({ columns, stripTop }: { columns: DiagramColumn[]; stripTop: number }): JSX.Element | null {
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const domNode = useStore((s) => s.domNode);
  // The pointer over the canvas (screen px from its top left), null while a button is down or it is outside.
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!domNode) return undefined;
    const move = (e: PointerEvent): void => {
      const box = domNode.getBoundingClientRect();
      setPointer(e.buttons === 0 ? { x: e.clientX - box.left, y: e.clientY - box.top } : null);
    };
    const leave = (): void => setPointer(null);
    domNode.addEventListener('pointermove', move);
    domNode.addEventListener('pointerleave', leave);
    return () => {
      domNode.removeEventListener('pointermove', move);
      domNode.removeEventListener('pointerleave', leave);
    };
  }, [domNode]);
  const hover =
    pointer === null ? null : columnHoverLabel(columns, { x: transform[0], y: transform[1], zoom: transform[2] }, { width, height }, stripTop, pointer);
  if (!hover) return null;
  return (
    <div className="column-hover" data-testid="column-hover" data-columnid={hover.id} aria-hidden="true" style={{ left: hover.left, top: hover.top }}>
      {hover.label}
    </div>
  );
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
      <ColumnHover columns={columns} stripTop={stripTop} />
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

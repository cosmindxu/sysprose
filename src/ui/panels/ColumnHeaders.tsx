/**
 * ColumnHeaders — the package name over each column of a layered General view
 * (`DiagramGraph.columns`). Drawn in the canvas's own space, so a header sits
 * above its column's x-range at any pan and zoom, in the room the layout kept
 * for it: it never lies over a box. The label is sized for the zoom — readable
 * from far out, where a whole model's columns are tens of thousands of px wide
 * — and never outgrows its band; a name wider than its column is shrunk to fit,
 * then cut with an ellipsis (the text stays whole in the page). A click goes
 * through to the canvas.
 */

import { ViewportPortal, useStore } from '@xyflow/react';
import { columnLabelSizeAt, columnLabelSizeFor, type DiagramColumn } from '@diagram/index';

export function ColumnHeaders({ columns }: { columns: DiagramColumn[] }): JSX.Element | null {
  const zoom = useStore((s) => s.transform[2]);
  if (columns.length === 0) return null;
  return (
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
  );
}

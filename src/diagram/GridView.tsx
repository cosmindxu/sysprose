/**
 * GridView — render a {@link GridModel} as an HTML table (grid view).
 *
 * Each row is a model element and each column a computed property
 * ({@link GridModel.columns}). Purely presentational and prop-driven; clicking a
 * row reports its element id via `onSelect`. This is the canonical SysML v2
 * table/grid rendering for bulk inspection of element properties. Cell editing
 * is intentionally out of scope here (selection only).
 */

import type { CSSProperties } from 'react';
import type { GridModel } from './types';

export interface GridViewProps {
  grid: GridModel;
  /** Called with the row's element id when a row is clicked. */
  onSelect?: (elementId: string) => void;
}

const tableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 12,
  width: '100%',
};
const cellStyle: CSSProperties = {
  border: '1px solid var(--border)',
  padding: '4px 8px',
  textAlign: 'left',
};
const headStyle: CSSProperties = {
  ...cellStyle,
  background: 'var(--bg-muted)',
  fontWeight: 600,
};
const rowStyle: CSSProperties = { cursor: 'pointer' };

export function GridView({ grid, onSelect }: GridViewProps): JSX.Element {
  const { columns, rows } = grid;

  const select = (id: string): void => {
    if (onSelect) onSelect(id);
  };

  return (
    <table data-testid="grid-view" style={tableStyle}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} style={headStyle} data-testid="grid-col-header" data-col-key={col.key}>
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            style={rowStyle}
            data-testid="grid-row"
            data-element-id={row.id}
            onClick={() => select(row.id)}
          >
            {columns.map((col) => (
              <td key={col.key} style={cellStyle} data-testid="grid-cell" data-col-key={col.key}>
                {row.cells[col.key] ?? ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default GridView;

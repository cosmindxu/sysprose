/**
 * Unit tests for the allocation / traceability matrix builder & renderer.
 *
 * Covers the generic {@link buildTraceabilityMatrix} engine (rows/cols/cells,
 * array selectors, library exclusion), the {@link buildAllocationMatrix}
 * convenience (Allocation → Satisfy fallback → empty), and the {@link MatrixView}
 * React component (data-testid, marks, header/cell selection).
 */

import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import { Model, ModelFactory } from '@core/index';
import { buildTraceabilityMatrix, buildAllocationMatrix, MatrixView } from '@diagram/index';

/** A model: two actions allocated to two parts, plus a library part. */
function allocModel(): {
  m: Model;
  ids: Record<string, string>;
} {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('Sys');
  const drive = f.action('drive', pkg.id);
  const brake = f.action('brake', pkg.id);
  const engine = f.part('engine', pkg.id);
  const wheel = f.part('wheel', pkg.id);
  f.allocate(drive.id, engine.id, pkg.id);
  f.allocate(brake.id, wheel.id, pkg.id);
  // A library element (and an allocation to it) must be excluded.
  const libPart = m.create('PartUsage', { declaredName: 'libPart', ownerId: pkg.id, attrs: { isLibrary: true } });
  f.allocate(drive.id, libPart.id, pkg.id);
  return {
    m,
    ids: { drive: drive.id, brake: brake.id, engine: engine.id, wheel: wheel.id, libPart: libPart.id },
  };
}

describe('buildTraceabilityMatrix — actions × parts over Allocation', () => {
  const { m, ids } = allocModel();
  const mat = buildTraceabilityMatrix(m, 'ActionUsage', 'PartUsage', 'Allocation');

  it('rows are the from-kind elements in declaration order', () => {
    expect(mat.rowElements.map((r) => r.label)).toEqual(['drive', 'brake']);
    expect(mat.rowElements[0].id).toBe(ids.drive);
  });

  it('columns are the to-kind elements, excluding library elements', () => {
    expect(mat.colElements.map((c) => c.label)).toEqual(['engine', 'wheel']);
    expect(mat.colElements.find((c) => c.id === ids.libPart)).toBeUndefined();
  });

  it('populates a cell per in-scope allocation (library allocation excluded)', () => {
    expect(mat.cells).toHaveLength(2);
    const de = mat.cells.find((c) => c.rowId === ids.drive && c.colId === ids.engine);
    expect(de).toBeDefined();
    expect(de!.kind).toBe('allocate');
    expect(de!.relId).toBeTruthy();
    // No allocation from drive to wheel.
    expect(mat.cells.find((c) => c.rowId === ids.drive && c.colId === ids.wheel)).toBeUndefined();
    // No cell into the library element.
    expect(mat.cells.find((c) => c.colId === ids.libPart)).toBeUndefined();
  });

  it('records the requested relKind', () => {
    expect(mat.relKind).toBe('Allocation');
  });

  it('accepts array selectors equivalently', () => {
    const arr = buildTraceabilityMatrix(m, ['ActionUsage'], ['PartUsage'], ['Allocation']);
    expect(arr.rowElements).toHaveLength(2);
    expect(arr.colElements).toHaveLength(2);
    expect(arr.cells).toHaveLength(2);
  });
});

describe('buildAllocationMatrix — convenience', () => {
  it('uses actual Allocation endpoints as rows × cols', () => {
    const { m, ids } = allocModel();
    const mat = buildAllocationMatrix(m);
    expect(mat.relKind).toBe('allocate');
    expect(mat.rowElements.map((r) => r.id).sort()).toEqual([ids.brake, ids.drive].sort());
    expect(mat.colElements.map((c) => c.id).sort()).toEqual([ids.engine, ids.wheel].sort());
    expect(mat.cells).toHaveLength(2);
    // Library part never appears as a column.
    expect(mat.colElements.find((c) => c.id === ids.libPart)).toBeUndefined();
  });

  it('falls back to Satisfy when the model has no allocations', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('Sys');
    const req = f.requirement('R1', pkg.id);
    const part = f.part('vehicle', pkg.id);
    f.satisfy(req.id, part.id, pkg.id); // source = satisfier (part), target = requirement
    const mat = buildAllocationMatrix(m);
    expect(mat.relKind).toBe('satisfy');
    expect(mat.rowElements.map((r) => r.id)).toEqual([part.id]);
    expect(mat.colElements.map((c) => c.id)).toEqual([req.id]);
    expect(mat.cells).toHaveLength(1);
    expect(mat.cells[0].kind).toBe('satisfy');
  });

  it('returns a well-formed empty matrix when nothing maps', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    f.part('lonely', f.pkg('Sys').id);
    const mat = buildAllocationMatrix(m);
    expect(mat.rowElements).toEqual([]);
    expect(mat.colElements).toEqual([]);
    expect(mat.cells).toEqual([]);
    expect(mat.relKind).toBe('allocate');
  });
});

describe('MatrixView — HTML table rendering', () => {
  const { m, ids } = allocModel();
  const mat = buildTraceabilityMatrix(m, 'ActionUsage', 'PartUsage', 'Allocation');

  it('renders a rooted table with a mark per populated cell', () => {
    const { getByTestId, getAllByTestId } = render(React.createElement(MatrixView, { matrix: mat }));
    expect(getByTestId('matrix-view')).toBeInTheDocument();
    expect(getAllByTestId('matrix-col-header')).toHaveLength(2);
    expect(getAllByTestId('matrix-row-header')).toHaveLength(2);
    const marked = getAllByTestId('matrix-cell-marked');
    expect(marked).toHaveLength(2);
    expect(marked[0].textContent).toContain('✓');
  });

  it('calls onSelect with the element id for headers and the rel id for cells', () => {
    const onSelect = vi.fn();
    const { getAllByTestId } = render(React.createElement(MatrixView, { matrix: mat, onSelect }));
    fireEvent.click(getAllByTestId('matrix-col-header')[0]);
    expect(onSelect).toHaveBeenLastCalledWith(ids.engine);
    fireEvent.click(getAllByTestId('matrix-row-header')[0]);
    expect(onSelect).toHaveBeenLastCalledWith(ids.drive);
    const marked = getAllByTestId('matrix-cell-marked')[0];
    fireEvent.click(marked);
    expect(onSelect).toHaveBeenLastCalledWith(marked.getAttribute('data-rel-id'));
  });
});

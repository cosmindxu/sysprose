/**
 * Unit tests for the grid-view builder & renderer.
 *
 * Covers {@link buildGrid} column set, one-row-per-element projection with cells
 * derived from name/metaclass/type/multiplicity/value/redefines/doc, metaclass
 * filtering, library exclusion, rootId scoping, and the {@link GridView} HTML
 * table (data-testid, headers, rows, selection).
 */

import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import { Model, ModelFactory } from '@core/index';
import { buildGrid, GridView } from '@diagram/index';

/** A small model: a part def, a typed part with mass attribute + doc, and a redefinition. */
function gridModel() {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('Vehicle');
  const vehicleDef = f.partDef('Vehicle', pkg.id);
  const vehicle = f.part('vehicle', pkg.id, vehicleDef.id); // FeatureTyping → Vehicle
  const mass = f.attribute('mass', vehicle.id, { type: 'Real', value: 1500, multiplicity: '0..1' });
  f.doc(vehicle.id, 'The whole vehicle.');
  // A part that redefines the base mass attribute.
  const heavyMass = m.create('AttributeUsage', { declaredName: 'heavyMass', ownerId: vehicle.id });
  f.redefinition(heavyMass.id, mass.id);
  return { m, ids: { pkg: pkg.id, vehicleDef: vehicleDef.id, vehicle: vehicle.id, mass: mass.id, heavyMass: heavyMass.id } };
}

describe('buildGrid — columns and rows', () => {
  const { m, ids } = gridModel();
  const grid = buildGrid(m);

  it('emits the fixed column set in order', () => {
    expect(grid.columns.map((c) => c.key)).toEqual([
      'name',
      'metaclass',
      'type',
      'multiplicity',
      'value',
      'redefines',
      'doc',
    ]);
    expect(grid.columns[0].label).toBe('Name');
  });

  it('emits one row per in-scope node element (relationships excluded)', () => {
    const rowIds = grid.rows.map((r) => r.id);
    // 5 nodes: package, part def, part, mass attr, heavyMass attr.
    expect(grid.rows).toHaveLength(5);
    expect(rowIds).toContain(ids.vehicle);
    expect(rowIds).toContain(ids.mass);
    // Neither the FeatureTyping nor the Redefinition relationship is a row.
    for (const r of grid.rows) {
      expect(r.cells.metaclass).not.toBe('FeatureTyping');
      expect(r.cells.metaclass).not.toBe('Redefinition');
    }
  });

  it('computes name/metaclass cells', () => {
    const row = grid.rows.find((r) => r.id === ids.vehicle)!;
    expect(row.label).toBe('vehicle');
    expect(row.cells.name).toBe('vehicle');
    expect(row.cells.metaclass).toBe('PartUsage');
  });

  it('resolves the type cell from feature typing', () => {
    const row = grid.rows.find((r) => r.id === ids.vehicle)!;
    expect(row.cells.type).toBe('Vehicle');
  });

  it('reads multiplicity and value cells from attrs', () => {
    const row = grid.rows.find((r) => r.id === ids.mass)!;
    expect(row.cells.multiplicity).toBe('0..1');
    expect(row.cells.value).toBe('1500');
    expect(row.cells.type).toBe('Real');
  });

  it('computes the redefines cell from Redefinition relationships', () => {
    const row = grid.rows.find((r) => r.id === ids.heavyMass)!;
    expect(row.cells.redefines).toBe('mass');
  });

  it('reads the doc cell from a Documentation child', () => {
    const row = grid.rows.find((r) => r.id === ids.vehicle)!;
    expect(row.cells.doc).toBe('The whole vehicle.');
  });

  it('filters rows by metaclass when kinds is given', () => {
    const only = buildGrid(m, { kinds: ['AttributeUsage'] });
    expect(only.rows.map((r) => r.cells.metaclass)).toEqual(['AttributeUsage', 'AttributeUsage']);
  });

  it('scopes to the rootId subtree', () => {
    const scoped = buildGrid(m, { rootId: ids.vehicle });
    const rowIds = scoped.rows.map((r) => r.id);
    expect(rowIds).toContain(ids.vehicle);
    expect(rowIds).toContain(ids.mass);
    expect(rowIds).not.toContain(ids.pkg);
    expect(rowIds).not.toContain(ids.vehicleDef);
  });

  it('excludes library elements by default', () => {
    const lm = new Model();
    const lf = new ModelFactory(lm);
    const p = lf.partDef('User', null);
    lm.create('PartDefinition', { declaredName: 'LibType', attrs: { isLibrary: true } });
    const g = buildGrid(lm);
    expect(g.rows.map((r) => r.id)).toEqual([p.id]);
  });
});

describe('GridView — HTML table rendering', () => {
  const { m } = gridModel();
  const grid = buildGrid(m);

  it('renders a table with a header per column and a row per element', () => {
    const { getByTestId, getAllByTestId } = render(React.createElement(GridView, { grid }));
    expect(getByTestId('grid-view')).toBeInTheDocument();
    expect(getAllByTestId('grid-col-header')).toHaveLength(7);
    expect(getAllByTestId('grid-row')).toHaveLength(5);
  });

  it('reports the row element id when a row is clicked', () => {
    const onSelect = vi.fn();
    const { getAllByTestId } = render(React.createElement(GridView, { grid, onSelect }));
    const row = getAllByTestId('grid-row')[0];
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(row.getAttribute('data-element-id'));
  });
});

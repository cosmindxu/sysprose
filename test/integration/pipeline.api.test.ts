/**
 * Pipeline integration — Parse → API query & analytics.
 *
 * Builds the model from examples/vehicle.sysml, then drives the @api surface:
 * the OMG-shaped constraint-tree query engine (by metaclass, by name, numeric
 * attribute path, composite and/or, substring) and the pure analytics functions
 * (countByMetaclass, requirementSatisfaction, whereUsed, modelMetrics).
 */

import { describe, it, expect } from 'vitest';
import { parseModel } from '@text/index';
import {
  ModelApi,
  evaluateQuery,
  countByMetaclass,
  modelMetrics,
  requirementSatisfaction,
  whereUsed,
} from '@api/index';
import { readVehicleSource } from './_shared';

const { model } = parseModel(readVehicleSource());

describe('pipeline: Parse → API query engine', () => {
  it('queries by metaclass (@type)', () => {
    const r = evaluateQuery(model, { constraint: { property: '@type', operator: '=', value: 'PortUsage' } });
    // 4 declared ports + 4 implicit usage-scoped ports materialized for the
    // `connect engine.fuelOut to fuelIn` / driveline feature-chain endpoints.
    expect(r.total).toBe(8);
    expect(r.elements.every((e) => e.eClass === 'PortUsage')).toBe(true);
    expect(r.commitId).toMatch(/^commit-/);
  });

  it('queries by name', () => {
    const r = evaluateQuery(model, { constraint: { property: 'declaredName', operator: '=', value: 'Vehicle' } });
    expect(r.total).toBe(1);
    expect(r.elements[0].eClass).toBe('PartDefinition');
  });

  it('counts the three part definitions', () => {
    const r = evaluateQuery(model, { constraint: { property: '@type', operator: '=', value: 'PartDefinition' } });
    expect(r.total).toBe(3);
  });

  it('queries by numeric attribute path (attrs.value > 1000)', () => {
    const r = evaluateQuery(model, { constraint: { property: 'attrs.value', operator: '>', value: 1000 } });
    expect(r.total).toBe(1);
    expect(r.elements[0].declaredName).toBe('mass');
  });

  it('queries with a composite AND constraint', () => {
    const r = evaluateQuery(model, {
      constraint: {
        kind: 'and',
        operands: [
          { property: '@type', operator: '=', value: 'AttributeUsage' },
          { property: 'attrs.value', operator: '>', value: 100 },
        ],
      },
    });
    expect(r.total).toBe(3);
    expect(r.elements.map((e) => e.declaredName).sort()).toEqual(['mass', 'maxSpeed', 'power']);
  });

  it('queries with a composite OR constraint', () => {
    const r = evaluateQuery(model, {
      constraint: {
        kind: 'or',
        operands: [
          { property: 'declaredName', operator: '=', value: 'Engine' },
          { property: 'declaredName', operator: '=', value: 'Transmission' },
        ],
      },
    });
    expect(r.total).toBe(2);
  });

  it('queries by substring (contains)', () => {
    const r = evaluateQuery(model, { constraint: { property: 'declaredName', operator: 'contains', value: 'Port' } });
    expect(r.elements.map((e) => e.declaredName).sort()).toEqual(['FuelPort', 'TorquePort']);
  });
});

describe('pipeline: Parse → API analytics', () => {
  it('countByMetaclass tallies the parsed elements (implicit internals excluded)', () => {
    const counts = countByMetaclass(model);
    expect(counts.PartDefinition).toBe(3);
    // Only the 4 DECLARED ports; the 4 implicit connector-endpoint ports (and
    // their Redefinitions) are re-derived internals, excluded from the census.
    expect(counts.PortUsage).toBe(4);
    expect(counts.ConnectionUsage).toBe(2);
    expect(counts.Satisfy).toBe(1);
  });

  it('requirementSatisfaction reports full coverage of the single requirement', () => {
    const rs = requirementSatisfaction(model);
    expect(rs.total).toBe(1);
    expect(rs.satisfied).toBe(1);
    expect(rs.coverage).toBe(1);
    expect(rs.requirements[0].satisfiers.length).toBeGreaterThanOrEqual(1);
  });

  it('whereUsed traces typing usages of the Vehicle definition', () => {
    const api = new ModelApi(model);
    const vehicleDef = api.byName('VehicleModel::Vehicle')!;
    const wu = whereUsed(model, vehicleDef.id);
    expect(wu.references.some((r) => r.via === 'FeatureTyping')).toBe(true);
    expect(wu.usedBy.some((e) => model.qualifiedName(e.id) === 'VehicleModel::vehicle')).toBe(true);
  });

  it('modelMetrics reports totals, relationships, roots and depth', () => {
    const metrics = modelMetrics(model);
    // Metrics exclude implicit connector-endpoint features + what they own, so
    // totalElements is below the raw model.size (which still counts internals).
    expect(metrics.totalElements).toBeLessThan(model.size);
    expect(metrics.totalElements).toBe(42);
    expect(metrics.rootCount).toBe(1);
    // FeatureTyping x2 + Satisfy x1 + Succession x1 (the implicit Redefinitions
    // are owned by implicit features, so they are excluded from the census).
    expect(metrics.relationshipCount).toBe(4);
    expect(metrics.nodeCount).toBe(metrics.totalElements - metrics.relationshipCount);
    // Deepest COUNTABLE element: VehicleModel > vehicle > engine > fuelOut = 4
    // (the implicit endpoints/Redefinitions that reached depth 5 are excluded).
    expect(metrics.maxDepth).toBe(4);
  });
});

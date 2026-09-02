import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, buildSampleModel } from '@core/index';
import {
  ModelApi,
  countByMetaclass,
  modelMetrics,
  requirementSatisfaction,
  traceabilityMatrix,
  whereUsed,
  connectivityReport,
} from '@api/index';

function sample() {
  const model = buildSampleModel();
  const api = new ModelApi(model);
  return {
    model,
    ids: {
      vehicleDef: api.byName('VehicleModel::Vehicle')!.id,
      vehicle: api.byName('VehicleModel::vehicle')!.id,
      engine: api.byName('VehicleModel::vehicle::engine')!.id,
      req: api.byName('VehicleModel::maxMass')!.id,
    },
  };
}

describe('analytics — counts & metrics', () => {
  it('counts elements by metaclass', () => {
    const { model } = sample();
    const counts = countByMetaclass(model);
    expect(counts.PartUsage).toBe(2);
    expect(counts.PartDefinition).toBe(2);
    expect(counts.Package).toBe(1);
    expect(counts.Satisfy).toBe(1);
  });

  it('excludes implicit (connector-endpoint) features from counts and metrics', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('x', p.id, { type: 'Real' });
    // A synthetic implicit feature (as the feature-chain resolver materializes).
    m.create('PortUsage', { declaredName: 'p', ownerId: p.id, attrs: { implicit: true } });
    expect(modelMetrics(m).totalElements).toBe(m.size - 1);
    // The implicit PortUsage is not counted.
    expect(countByMetaclass(m).PortUsage ?? 0).toBe(0);
  });

  it('computes model metrics including containment depth', () => {
    const { model } = sample();
    const m = modelMetrics(model);
    expect(m.totalElements).toBe(model.size);
    // FeatureTyping x2 + Satisfy x1 are relationships; ConnectionUsage is not.
    expect(m.relationshipCount).toBe(3);
    expect(m.nodeCount).toBe(model.size - 3);
    expect(m.diagramableCount).toBe(m.nodeCount);
    expect(m.rootCount).toBe(1);
    // VehicleModel > vehicle > engine > fuelOut = depth 4.
    expect(m.maxDepth).toBe(4);
  });
});

describe('analytics — requirement satisfaction', () => {
  it('reports full coverage when every requirement is satisfied', () => {
    const { model, ids } = sample();
    const r = requirementSatisfaction(model);
    expect(r.total).toBe(1);
    expect(r.satisfied).toBe(1);
    expect(r.coverage).toBe(1);
    expect(r.requirements[0].requirement.id).toBe(ids.req);
    expect(r.requirements[0].satisfiers.some((s) => s.id === ids.vehicle)).toBe(true);
  });

  it('computes partial coverage with an unsatisfied requirement', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const part = f.part('p', pkg.id);
    const r1 = f.requirement('r1', pkg.id);
    f.requirement('r2', pkg.id); // unsatisfied
    f.satisfy(r1.id, part.id, pkg.id);
    const rep = requirementSatisfaction(model);
    expect(rep.total).toBe(2);
    expect(rep.satisfied).toBe(1);
    expect(rep.coverage).toBe(0.5);
  });
});

describe('analytics — traceability & where-used', () => {
  it('builds a from×to traceability matrix', () => {
    const { model, ids } = sample();
    const tm = traceabilityMatrix(model, 'PartUsage', 'RequirementUsage', 'Satisfy');
    expect(tm.rows).toHaveLength(2);
    expect(tm.columns).toHaveLength(1);
    expect(tm.links).toHaveLength(1);
    const vehicleRow = tm.rows.findIndex((r) => r.id === ids.vehicle);
    const engineRow = tm.rows.findIndex((r) => r.id === ids.engine);
    expect(tm.cells[vehicleRow][0]).toBe(true);
    expect(tm.cells[engineRow][0]).toBe(false);
  });

  it('finds where a definition is used (typing)', () => {
    const { model, ids } = sample();
    const wu = whereUsed(model, ids.vehicleDef);
    expect(wu.references.some((r) => r.via === 'FeatureTyping' && r.isTyping)).toBe(true);
    expect(wu.usedBy.some((e) => e.id === ids.vehicle)).toBe(true);
  });

  it('finds where a requirement is referenced (satisfy target)', () => {
    const { model, ids } = sample();
    const wu = whereUsed(model, ids.req);
    const satisfy = wu.references.find((r) => r.via === 'Satisfy');
    expect(satisfy?.role).toBe('target');
    expect(satisfy?.relatedElements.some((e) => e.id === ids.vehicle)).toBe(true);
  });
});

describe('analytics — connectivity', () => {
  it('reports fully-connected ports for the sample model', () => {
    const { model } = sample();
    const c = connectivityReport(model);
    expect(c.portCount).toBe(2);
    expect(c.connectionCount).toBe(1);
    expect(c.connectedPortCount).toBe(2);
    expect(c.unconnectedPorts).toHaveLength(0);
  });

  it('flags unconnected ports', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const part = f.part('p', pkg.id);
    f.port('lonely', part.id, { direction: 'in' });
    const a = f.port('a', part.id, { direction: 'out' });
    const b = f.port('b', part.id, { direction: 'in' });
    f.connect(a.id, b.id, { ownerId: part.id });
    const c = connectivityReport(model);
    expect(c.portCount).toBe(3);
    expect(c.connectionCount).toBe(1);
    expect(c.unconnectedPorts).toHaveLength(1);
    expect(c.unconnectedPorts[0].declaredName).toBe('lonely');
  });
});

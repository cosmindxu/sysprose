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

/* ────────── The model, not the bundled library (nor its own internals) ─────── */

/**
 * A model with the bundled standard library merged in alongside it, and with the
 * usage-scoped port copies the feature-chain resolver materialises for
 * `connect a.p to b.p`.
 *
 * Both are re-derived context rather than the user's content, and both were
 * being counted: on the shipped UAV example that turned 2 requirements into 26
 * and 15 ports into 37. These fixtures are the small, readable version of that.
 */
function withLibraryAndImplicit() {
  const model = new Model();
  const f = new ModelFactory(model);
  const pkg = f.pkg('P');

  const aDef = f.partDef('A');
  const pa = f.port('p', aDef.id, { direction: 'out' });
  const lonely = f.port('lonely', aDef.id, { direction: 'in' });
  const bDef = f.partDef('B');
  const pb = f.port('p', bDef.id, { direction: 'in' });

  const a = f.part('a', pkg.id, aDef.id);
  const b = f.part('b', pkg.id, bDef.id);
  const req = f.requirement('r', pkg.id);
  f.satisfy(req.id, a.id, pkg.id);

  // The usage-scoped copies: implicit, owned by the PART, each redefining the
  // declared port on the part's TYPE. The connection references the copies.
  const copy = (declared: string, ownerId: string, direction: string) => {
    const c = model.create('PortUsage', {
      declaredName: model.get(declared)!.declaredName,
      ownerId,
      attrs: { implicit: true, direction },
    });
    model.create('Redefinition', { ownerId: c.id, source: [c.id], target: [declared] });
    return c;
  };
  const ia = copy(pa.id, a.id, 'out');
  const ib = copy(pb.id, b.id, 'in');
  f.connect(ia.id, ib.id, { ownerId: pkg.id });

  // An implicit REQUIREMENT copy as well as implicit ports: `implicitExcluded`
  // is a separate number on every report, and a fixture whose only implicit
  // elements are ports lets the requirement and matrix ones be hardcoded to 0.
  const implicitReq = model.create('RequirementUsage', {
    declaredName: 'r',
    ownerId: a.id,
    attrs: { implicit: true },
  });
  model.create('Redefinition', {
    ownerId: implicitReq.id,
    source: [implicitReq.id],
    target: [req.id],
  });

  // The bundled library: two requirements, a part, two ports and a connection
  // between them — none of them the user's. The library CONNECTION is what
  // keeps `connectionCount` honest: without it, dropping the connection filter
  // changes nothing observable.
  const lib = model.create('Package', { declaredName: 'Lib', attrs: { isLibrary: true } });
  for (const n of ['libReqA', 'libReqB']) {
    model.create('RequirementUsage', { declaredName: n, ownerId: lib.id, attrs: { isLibrary: true } });
  }
  model.create('PartUsage', { declaredName: 'libPart', ownerId: lib.id, attrs: { isLibrary: true } });
  const libPortA = model.create('PortUsage', {
    declaredName: 'libPortA',
    ownerId: lib.id,
    attrs: { isLibrary: true },
  });
  const libPortB = model.create('PortUsage', {
    declaredName: 'libPortB',
    ownerId: lib.id,
    attrs: { isLibrary: true },
  });
  model.create('ConnectionUsage', {
    declaredName: 'libWiring',
    ownerId: lib.id,
    source: [libPortA.id],
    target: [libPortB.id],
    attrs: { isLibrary: true },
  });

  return {
    model,
    ids: {
      a: a.id,
      b: b.id,
      req: req.id,
      pa: pa.id,
      pb: pb.id,
      lonely: lonely.id,
      ia: ia.id,
      ib: ib.id,
    },
  };
}

describe('analytics — reporting counts the model, not the bundled library', () => {
  it('requirement coverage skips library requirements and says how many it skipped', () => {
    const { model, ids } = withLibraryAndImplicit();
    const r = requirementSatisfaction(model);
    expect(r.total).toBe(1);
    expect(r.satisfied).toBe(1);
    expect(r.coverage).toBe(1);
    expect(r.libraryExcluded).toBe(2);
    // The tool's own re-derived copy is excluded too, and under its own name:
    // one number spanning both kinds of exclusion would be a count nobody can
    // check against the model in front of them.
    expect(r.implicitExcluded).toBe(1);
    expect(r.requirements.map((x) => x.requirement.id)).toEqual([ids.req]);
  });

  it('the traceability matrix has no library rows or columns', () => {
    const { model, ids } = withLibraryAndImplicit();
    const tm = traceabilityMatrix(model, 'PartUsage', 'RequirementUsage', 'Satisfy');
    expect(tm.rows.map((r) => r.id)).toEqual([ids.a, ids.b]);
    expect(tm.columns.map((c) => c.id)).toEqual([ids.req]);
    expect(tm.cells).toEqual([[true], [false]]);
    expect(tm.libraryExcluded).toBe(3);
    expect(tm.implicitExcluded).toBe(1);
  });

  it('the matrix counts each excluded element once, not once per axis', () => {
    const { model, ids } = withLibraryAndImplicit();
    // Same kind on both axes — a parts × parts dependency view. The three
    // PartUsage candidates (a, b, libPart) are candidates TWICE, so a
    // concatenated exclusion count reports 2 library parts in a model with 1.
    const parts = traceabilityMatrix(model, 'PartUsage', 'PartUsage', 'Satisfy');
    expect(parts.rows.map((r) => r.id)).toEqual([ids.a, ids.b]);
    expect(parts.columns.map((c) => c.id)).toEqual([ids.a, ids.b]);
    expect(parts.libraryExcluded).toBe(1);
    expect(parts.implicitExcluded).toBe(0);

    // The same on the implicit half: 5 port candidates, 2 of them library and
    // 2 of them the usage-scoped copies.
    const ports = traceabilityMatrix(model, 'PortUsage', 'PortUsage', 'Satisfy');
    expect(ports.rows.map((r) => r.id)).toEqual([ids.pa, ids.lonely, ids.pb]);
    expect(ports.libraryExcluded).toBe(2);
    expect(ports.implicitExcluded).toBe(2);
  });

  it('connectivity lifts an implicit endpoint onto the port it redefines', () => {
    const { model, ids } = withLibraryAndImplicit();
    const c = connectivityReport(model);
    // The copies are not extra ports, and their connection still connects.
    expect(c.portCount).toBe(3);
    // The library's own wiring is not the user's: 1, not 2.
    expect(c.connectionCount).toBe(1);
    expect(c.connectedPortCount).toBe(2);
    expect(c.implicitExcluded).toBe(2);
    expect(c.implicitResolved).toBe(2);
    // 2 library ports + 1 library connection.
    expect(c.libraryExcluded).toBe(3);
    expect(c.unconnectedPorts.map((p) => p.id)).toEqual([ids.lonely]);
    // Both ends of the lift: the endpoints as the model records them, and the
    // ports of `portCount` they stand for.
    expect(c.connections[0].source).toEqual([ids.ia]);
    expect(c.connections[0].target).toEqual([ids.ib]);
    expect(c.connections[0].sourcePorts).toEqual([ids.pa]);
    expect(c.connections[0].targetPorts).toEqual([ids.pb]);
    // The dangling end, named by the part it dangles in.
    expect(c.unconnectedPortUsages.map((o) => [o.part.id, o.port.id])).toEqual([
      [ids.a, ids.lonely],
    ]);
  });
});

/**
 * Two usages of ONE part definition — the shape that separates a port from the
 * ends it has.
 *
 * `part n1 : Node; part n2 : Node; connect n1.b to n2.a;` wires one end of each
 * usage and leaves `n1.a` and `n2.b` dangling. Both declared ports are
 * connected SOMEWHERE, so nothing is missing from the declaration-level answer
 * and a report that stops there says the model is fully wired. And because both
 * endpoints of a `connect n1.p to n2.p` lift onto the same declared port,
 * substituting the lifted id for the recorded one turns the connection into a
 * self-edge — the definition-level collapse the usage-scoped endpoints exist to
 * prevent. The shipped UAV example cannot catch either: every one of its part
 * definitions is used exactly once.
 */
function reusedDefinition() {
  const model = new Model();
  const f = new ModelFactory(model);
  const pkg = f.pkg('P');
  const nodeDef = f.partDef('Node');
  const pa = f.port('a', nodeDef.id, { direction: 'in' });
  const pb = f.port('b', nodeDef.id, { direction: 'out' });
  const n1 = f.part('n1', pkg.id, nodeDef.id);
  const n2 = f.part('n2', pkg.id, nodeDef.id);

  const copy = (declared: string, ownerId: string, direction: string) => {
    const c = model.create('PortUsage', {
      declaredName: model.get(declared)!.declaredName,
      ownerId,
      attrs: { implicit: true, direction },
    });
    model.create('Redefinition', { ownerId: c.id, source: [c.id], target: [declared] });
    return c;
  };
  // Only the ends the connection names are materialised: `n1.a` and `n2.b`
  // exist in the model as ports of `Node`, and nowhere as ends of their own.
  const n1b = copy(pb.id, n1.id, 'out');
  const n2a = copy(pa.id, n2.id, 'in');
  f.connect(n1b.id, n2a.id, { ownerId: pkg.id });

  return { model, ids: { pa: pa.id, pb: pb.id, n1: n1.id, n2: n2.id, n1b: n1b.id, n2a: n2a.id } };
}

describe('analytics — connectivity when one definition is used twice', () => {
  it('keeps the two endpoints distinct instead of collapsing them onto the definition', () => {
    const { model, ids } = reusedDefinition();
    const c = connectivityReport(model);
    expect(c.connections).toHaveLength(1);
    const [conn] = c.connections;
    expect(conn.source).toEqual([ids.n1b]);
    expect(conn.target).toEqual([ids.n2a]);
    expect(conn.source).not.toEqual(conn.target);
    // Lifted, both ends ARE the same declaration — which is why the lift is a
    // second pair of fields rather than a rewrite of the first.
    expect(conn.sourcePorts).toEqual([ids.pb]);
    expect(conn.targetPorts).toEqual([ids.pa]);
  });

  it('names the dangling ends that the declaration-level answer cannot show', () => {
    const { model, ids } = reusedDefinition();
    const c = connectivityReport(model);
    expect(c.portCount).toBe(2);
    expect(c.connectedPortCount).toBe(2);
    // Every DECLARED port is connected in some usage, so this list is empty and
    // says nothing is wrong …
    expect(c.unconnectedPorts).toEqual([]);
    // … while `n1.a` and `n2.b` are genuinely wired to nothing.
    expect(c.unconnectedPortUsages.map((o) => [o.part.id, o.port.id])).toEqual([
      [ids.n1, ids.pa],
      [ids.n2, ids.pb],
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, buildSampleModel } from '@core/index';
import {
  ModelApi,
  countByMetaclass,
  impactClosure,
  isUserElement,
  modelMetrics,
  orphanReport,
  requirementSatisfaction,
  traceabilityMatrix,
  whereUsed,
  connectivityReport,
  constraintReport,
  promptsFor,
} from '@api/index';
import { setStatementKind } from '@semantics/index';

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

/* ───────────────── Orphan inventory & transitive impact ─────────────────── */

/**
 * A chain of references three hops long, with a library user and one of the
 * tool's own implicit copies hanging off the far end.
 *
 * `Base` is specialised by `Mid`, `Mid` types the part `leaf`, and `client`
 * depends on `leaf` — so "what does a change to `Base` reach" has a different
 * answer at every depth, which is the whole point of a closure over a report
 * that only ever looked one hop out.
 */
function referenceChain() {
  const model = new Model();
  const f = new ModelFactory(model);
  const pkg = f.pkg('P');
  const base = f.partDef('Base', pkg.id);
  const mid = f.partDef('Mid', pkg.id);
  f.subclassification(mid.id, base.id);
  const leaf = f.part('leaf', pkg.id, mid.id);
  const client = f.part('client', pkg.id);
  f.dependency(client.id, leaf.id, pkg.id);

  // A library part typed by `Base`, and one of the tool's own implicit copies:
  // both reference `Base` and neither is the reader's own model.
  const libPart = model.create('PartUsage', {
    declaredName: 'libPart',
    ownerId: pkg.id,
    attrs: { isLibrary: true },
  });
  model.create('FeatureTyping', {
    ownerId: libPart.id,
    source: [libPart.id],
    target: [base.id],
    attrs: { isLibrary: true },
  });
  const shadow = model.create('PartUsage', {
    declaredName: 'shadow',
    ownerId: pkg.id,
    attrs: { implicit: true },
  });
  model.create('FeatureTyping', { ownerId: shadow.id, source: [shadow.id], target: [base.id] });

  return {
    model,
    ids: { base: base.id, mid: mid.id, leaf: leaf.id, client: client.id },
  };
}

describe('analytics — orphan inventory', () => {
  it('names the definitions nothing uses, and leaves the used ones alone', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const used = f.partDef('Used', pkg.id);
    f.part('u', pkg.id, used.id);
    f.partDef('Unused', pkg.id);
    f.actionDef('Dead', pkg.id);
    const r = orphanReport(model);
    expect(r.orphans.map((o) => o.declaredName)).toEqual(['Unused', 'Dead']);
    expect(r.definitionsExamined).toBe(3);
  });

  it('is an inventory of definitions, not of every element without an edge', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const def = f.partDef('D', pkg.id);
    const part = f.part('p', pkg.id, def.id);
    // Attributes, documentation and untyped parts carry no edges at all — the
    // naive reading flags 67 of the 113 elements of the shipped UAV example and
    // buries the two findings that mean something.
    f.attribute('mass', part.id, { value: 1 });
    f.doc(part.id, 'a note');
    f.part('untyped', pkg.id);
    expect(orphanReport(model).orphans).toEqual([]);
  });

  it('does not call a namespace package an orphan', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    f.pkg('Nested', pkg.id);
    const r = orphanReport(model);
    expect(r.orphans).toEqual([]);
    expect(r.packagesSkipped).toBe(2);
    expect(r.definitionsExamined).toBe(0);
  });

  it('leaves the bundled library and the tool’s own copies out, and says so', () => {
    const { model } = withLibraryAndImplicit();
    const r = orphanReport(model);
    // `A` and `B` are both typed by a part usage, so nothing is orphaned …
    expect(r.orphans).toEqual([]);
    expect(r.definitionsExamined).toBe(2);
    // … and the library's own package is not the reader's dead code.
    expect(r.libraryExcluded).toBe(1);
    expect(r.packagesSkipped).toBe(1);
  });

  it('counts a definition as used only when the far end is the reader’s own', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');

    // Used by one of the tool's own implicit copies and by nothing else …
    const byImplicit = f.partDef('OnlyUsedByImplicit', pkg.id);
    const shadow = model.create('PartUsage', {
      declaredName: 'shadow',
      ownerId: pkg.id,
      attrs: { implicit: true },
    });
    model.create('FeatureTyping', { ownerId: shadow.id, source: [shadow.id], target: [byImplicit.id] });

    // … and used by the bundled library and by nothing else.
    const byLibrary = f.partDef('OnlyUsedByLibrary', pkg.id);
    const libPart = model.create('PartUsage', {
      declaredName: 'libPart',
      ownerId: pkg.id,
      attrs: { isLibrary: true },
    });
    model.create('FeatureTyping', {
      ownerId: libPart.id,
      source: [libPart.id],
      target: [byLibrary.id],
      attrs: { isLibrary: true },
    });

    // An implicit DEFINITION, so `implicitExcluded` is exercised by the report
    // that publishes it rather than only by its neighbours.
    model.create('PartDefinition', {
      declaredName: 'ImplicitDef',
      ownerId: pkg.id,
      attrs: { implicit: true },
    });

    const r = orphanReport(model);
    // Counting an edge the reader did not write would keep both of these off
    // the list — kept alive by content the reader cannot see — and would make
    // this report disagree with the impact closure about whose model it is.
    expect(r.orphans.map((o) => o.declaredName)).toEqual([
      'OnlyUsedByImplicit',
      'OnlyUsedByLibrary',
    ]);
    expect(r.definitionsExamined).toBe(2);
    expect(r.implicitExcluded).toBe(1);
    expect(impactClosure(model, byImplicit.id, 9).impacted).toEqual([]);
  });

  it('does not call a definition that specialises something an orphan', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const base = f.partDef('Base', pkg.id);
    f.part('b', pkg.id, base.id);
    // `DeadSubclass` has an OUTGOING edge and no incoming one: nothing
    // instantiates it, and the rule still counts it as used, by whatever reads
    // the specialisation. It is the only shape that exercises that half of the
    // rule — every definition in both shipped examples has no outgoing edge at
    // all — and the doc comment records it as a recall limit rather than a bug.
    const dead = f.partDef('DeadSubclass', pkg.id);
    f.subclassification(dead.id, base.id);
    expect(model.edgesTo(dead.id)).toHaveLength(0);
    expect(model.edgesFrom(dead.id)).toHaveLength(1);
    expect(orphanReport(model).orphans).toEqual([]);
    expect(orphanReport(model).definitionsExamined).toBe(2);
  });
});

describe('analytics — transitive impact closure', () => {
  it('at depth 1 reports exactly what whereUsed reports', () => {
    const { model, ids } = referenceChain();
    const closure = impactClosure(model, ids.base);
    const direct = whereUsed(model, ids.base).usedBy.filter((u) =>
      isUserElement(model, model.get(u.id)!),
    );
    expect(closure.impacted.map((i) => i.element.id)).toEqual(direct.map((u) => u.id));
    expect(closure.impacted.map((i) => i.element.id)).toEqual([ids.mid]);
    expect(closure.impacted[0].depth).toBe(1);
    expect(closure.impacted[0].via).toBe('Subclassification');
    expect(closure.impacted[0].from.id).toBe(ids.base);
  });

  it('reaches one further hop per depth, and says when it stopped short', () => {
    const { model, ids } = referenceChain();
    expect(impactClosure(model, ids.base, 2).impacted.map((i) => i.element.id)).toEqual([
      ids.mid,
      ids.leaf,
    ]);
    // Two hops short of the end, `truncated` says so …
    expect(impactClosure(model, ids.base, 2).truncated).toBe(true);
    const three = impactClosure(model, ids.base, 3);
    expect(three.impacted.map((i) => i.element.id)).toEqual([ids.mid, ids.leaf, ids.client]);
    expect(three.impacted.map((i) => i.depth)).toEqual([1, 2, 3]);
    // … and at the hop that finishes the chain it does NOT, even though the
    // limit was reached with a non-empty frontier. `truncated` is a lookahead
    // for something still to report, not "the frontier is non-empty": the
    // depth-3 and depth-99 answers are the same three elements, so exactly one
    // of them may call itself a prefix.
    expect(three.truncated).toBe(false);
    // Asking for more than there is closes the walk instead of inventing hops.
    const all = impactClosure(model, ids.base, 99);
    expect(all.impacted).toHaveLength(3);
    expect(all.truncated).toBe(false);
    // The depth reported is the deepest element reported — never the barren
    // pass that found nothing, which would claim a fourth hop for a set whose
    // furthest element is three hops out.
    expect(all.depth).toBe(3);
    expect(all.depth).toBe(Math.max(...all.impacted.map((i) => i.depth)));
  });

  it('reads a depth that is not a usable number as 1 rather than as none', () => {
    const { model, ids } = referenceChain();
    const one = impactClosure(model, ids.base, 1);
    // `--depth abc` parses to NaN, and `Math.max(1, NaN)` is NaN: the walk that
    // clamp produced ran zero hops and reported "nothing uses this", which is
    // the one answer a bad flag must never be allowed to fabricate.
    for (const bad of [Number.NaN, 0, -3, 1.9]) {
      const r = impactClosure(model, ids.base, bad);
      expect(r.impacted.map((i) => i.element.id)).toEqual(one.impacted.map((i) => i.element.id));
      expect(r.depth).toBe(1);
    }
    // `Infinity` is not a mistake, though: it is how you ask for the closure.
    const unlimited = impactClosure(model, ids.base, Number.POSITIVE_INFINITY);
    expect(unlimited.impacted).toHaveLength(3);
    expect(unlimited.truncated).toBe(false);
  });

  it('crosses a connection whose two ends are ports of different definitions', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const outDef = f.portDef('PowerOut', pkg.id);
    const inDef = f.portDef('PowerIn', pkg.id);
    const src = f.partDef('Src', pkg.id);
    const dst = f.partDef('Dst', pkg.id);
    const o = f.port('o', src.id, { direction: 'out', typeId: outDef.id });
    const i = f.port('i', dst.id, { direction: 'in', typeId: inDef.id });
    const sys = f.partDef('Sys', pkg.id);
    const s = f.part('s', sys.id, src.id);
    const d = f.part('d', sys.id, dst.id);
    // `connect s.o to d.i` wires the CONNECTION to usage-scoped copies of the
    // two ports, not to the declarations: a walk that treats an implicit copy
    // as a wall cannot cross a wire at all, and answered "what breaks if I
    // change this port" with the port's own type and nothing on the far end.
    const copy = (declared: string, ownerId: string) => {
      const c = model.create('PortUsage', {
        declaredName: model.get(declared)!.declaredName,
        ownerId,
        attrs: { implicit: true },
      });
      model.create('Redefinition', { ownerId: c.id, source: [c.id], target: [declared] });
      return c;
    };
    f.connect(copy(o.id, s.id).id, copy(i.id, d.id).id, { ownerId: sys.id });

    const closure = impactClosure(model, o.id, Number.POSITIVE_INFINITY);
    expect(closure.impacted.map((x) => x.element.id)).toContain(i.id);
    // And the report says the WIRE got it there. The last edge of the path is
    // the far copy's `Redefinition` to the port it stands for — bookkeeping the
    // reader never wrote — so naming that labelled a wire crossing with the one
    // edge on the path that is not in the file, and "what breaks if I change
    // this port" read as a redefinition of something.
    const far = closure.impacted.find((x) => x.element.id === i.id)!;
    expect(far.via).toBe('ConnectionUsage');
    expect(far.from.id).toBe(o.id);
    // Three hops: out to the copy, across the wire, back down to the far
    // declaration. The label is lifted, the hop count is not.
    expect(far.depth).toBe(3);
    // The copies are crossed, not reported: nothing in the answer is an id the
    // reader cannot find in their own file …
    expect(closure.impacted.every((x) => model.get(x.element.id)!.attrs.implicit !== true)).toBe(
      true,
    );
    expect(closure.implicitExcluded).toBe(2);
    // … and each hop costs one, so depth 1 is still exactly what `whereUsed`
    // reports of the reader's own model.
    expect(impactClosure(model, o.id).impacted.map((x) => x.element.id)).toEqual([outDef.id]);
    // The relationship itself is how the walk got there, never a destination.
    expect(closure.impacted.some((x) => model.get(x.element.id)!.eClass === 'ConnectionUsage')).toBe(
      false,
    );
  });

  it('loses the wire to the typing detour when the ends are copies of one port definition', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    // ONE definition for both ends — `port def PowerPort` used by an out port
    // and an in port, which is how both shipped examples and most real models
    // are written.
    const portDef = f.portDef('PowerPort', pkg.id);
    const src = f.partDef('Src', pkg.id);
    const dst = f.partDef('Dst', pkg.id);
    const o = f.port('o', src.id, { direction: 'out', typeId: portDef.id });
    const i = f.port('i', dst.id, { direction: 'in', typeId: portDef.id });
    const sys = f.partDef('Sys', pkg.id);
    const s = f.part('s', sys.id, src.id);
    const d = f.part('d', sys.id, dst.id);
    const copy = (declared: string, ownerId: string) => {
      const c = model.create('PortUsage', {
        declaredName: model.get(declared)!.declaredName,
        ownerId,
        attrs: { implicit: true },
      });
      model.create('Redefinition', { ownerId: c.id, source: [c.id], target: [declared] });
      return c;
    };
    f.connect(copy(o.id, s.id).id, copy(i.id, d.id).id, { ownerId: sys.id });

    const closure = impactClosure(model, o.id, Number.POSITIVE_INFINITY);
    const far = closure.impacted.find((x) => x.element.id === i.id)!;
    // The far port IS in the answer — but the walk got there up and down the
    // shared definition in two hops, not across the wire in three, so the
    // visited set closed it before the cable arrived. The label says so.
    expect(far.depth).toBe(2);
    expect(far.via).toBe('FeatureTyping');
    expect(far.from.id).toBe(portDef.id);
    // Which is the limit, stated as a measurement rather than as prose: on a
    // model written this way NOTHING in the report is reached across a wire,
    // however deep the walk goes. `connectivityReport` is the wiring question.
    expect(closure.impacted.some((x) => x.via === 'ConnectionUsage')).toBe(false);
    // The copies are still crossed and still counted — the conduit works, it is
    // simply never the shortest way to anything here.
    expect(closure.implicitExcluded).toBe(2);
  });

  it('refuses to name a cable when the crossing went through a hub on two of them', () => {
    // A copy wired by TWO connections is a through-route: the crossing that
    // enters it on one cable can leave on the other and land on a port that
    // shares no wire with the query. Carrying the first cable's label to that
    // landing reported "N1::p1 —ConnectionUsage→ N2::p2" about two ports with
    // no edge between them — a meaningless label replaced by a false one.
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const hub = f.partDef('Hub', pkg.id);
    const n1 = f.partDef('N1', pkg.id);
    const n2 = f.partDef('N2', pkg.id);
    const h = f.port('h', hub.id, { typeId: f.portDef('PA', pkg.id).id });
    const p1 = f.port('p1', n1.id, { typeId: f.portDef('PB', pkg.id).id });
    const p2 = f.port('p2', n2.id, { typeId: f.portDef('PC', pkg.id).id });
    const top = f.partDef('Top', pkg.id);
    const hubUsage = f.part('hub', top.id, hub.id);
    const copy = (declared: string, ownerId: string) => {
      const c = model.create('PortUsage', {
        declaredName: model.get(declared)!.declaredName,
        ownerId,
        attrs: { implicit: true },
      });
      model.create('Redefinition', { ownerId: c.id, source: [c.id], target: [declared] });
      return c;
    };
    // ONE copy of `h` under the hub usage, carrying both cables — which is what
    // the mapper materialises for two connections naming the same feature
    // chain, and what makes the through-route possible at all.
    const hCopy = copy(h.id, hubUsage.id);
    f.connect(hCopy.id, copy(p1.id, f.part('n1', top.id, n1.id).id).id, { ownerId: top.id });
    f.connect(hCopy.id, copy(p2.id, f.part('n2', top.id, n2.id).id).id, { ownerId: top.id });
    expect(
      model.edgesOf(p1.id).filter((e) => [...(e.source ?? []), ...(e.target ?? [])].includes(p2.id)),
    ).toEqual([]);

    const closure = impactClosure(model, p1.id, Number.POSITIVE_INFINITY);
    // One cable is still named: `h` really is wired to `p1`.
    const near = closure.impacted.find((x) => x.element.id === h.id)!;
    expect(near.via).toBe('ConnectionUsage');
    expect(near.from.id).toBe(p1.id);
    // Two cables are not. The far port is still REACHED — a change to `p1` can
    // reach it through the hub — but the report falls back to the literal last
    // edge rather than claiming a wire that does not exist.
    const far = closure.impacted.find((x) => x.element.id === p2.id)!;
    expect(far.via).not.toBe('ConnectionUsage');
    expect(far.via).toBe('Redefinition');
  });

  it('leaves a reader’s own edge onto an implicit element labelled with that edge', () => {
    // The carry is a whitelist of connection kinds, not "anything that is not
    // the copy tie". An implicit element carries the tool's `FeatureTyping` as
    // well as its `Redefinition`, so a blacklist let that typing edge capture
    // the label and suppress the `Dependency` the reader actually wrote — the
    // same defect as labelling a wire by the copy tie, one edge family over.
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const base = f.partDef('Base', pkg.id);
    const client = f.part('client', pkg.id);
    const shadow = model.create('PartUsage', {
      declaredName: 'shadow',
      ownerId: pkg.id,
      attrs: { implicit: true },
    });
    model.create('FeatureTyping', { ownerId: shadow.id, source: [shadow.id], target: [base.id] });
    f.dependency(client.id, shadow.id, pkg.id);

    const closure = impactClosure(model, base.id, Number.POSITIVE_INFINITY);
    expect(
      closure.impacted.map((x) => `${x.depth} ${x.via} ${x.element.declaredName}`),
    ).toEqual(['2 Dependency client']);
    expect(closure.implicitExcluded).toBe(1);
  });

  it('filters the frontier to the reader’s own elements at every depth', () => {
    const { model, ids } = referenceChain();
    // whereUsed hands back all three users of `Base`; the closure keeps one.
    expect(whereUsed(model, ids.base).usedBy).toHaveLength(3);
    const closure = impactClosure(model, ids.base, 99);
    expect(closure.libraryExcluded).toBe(1);
    expect(closure.implicitExcluded).toBe(1);
    expect(closure.impacted.some((i) => i.element.declaredName === 'libPart')).toBe(false);
    expect(closure.impacted.some((i) => i.element.declaredName === 'shadow')).toBe(false);
  });

  it('terminates on a reference cycle instead of walking it forever', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const a = f.part('a', pkg.id);
    const b = f.part('b', pkg.id);
    const c = f.part('c', pkg.id);
    f.dependency(a.id, b.id, pkg.id);
    f.dependency(b.id, c.id, pkg.id);
    f.dependency(c.id, a.id, pkg.id);
    // Bounded FIRST, and deliberately: the walk is a synchronous loop, so
    // without the visited set vitest's per-test timer cannot interrupt it and
    // removing the guard wedges the worker instead of failing. At depth 5 a
    // ring of three either reports two elements or never returns.
    const bounded = impactClosure(model, a.id, 5);
    expect(bounded.impacted.map((i) => i.element.id).sort()).toEqual([b.id, c.id].sort());
    const closure = impactClosure(model, a.id, 99);
    expect(closure.impacted.map((i) => i.element.id).sort()).toEqual([b.id, c.id].sort());
    expect(closure.truncated).toBe(false);
  });

  it('answers for an id that is not in the model instead of throwing', () => {
    const { model } = referenceChain();
    const closure = impactClosure(model, 'no-such-id', 3);
    expect(closure.impacted).toEqual([]);
    expect(closure.depth).toBe(0);
    expect(closure.truncated).toBe(false);
  });
});

/**
 * Coverage counts NORMATIVE statements only, and says what it left out.
 *
 * A `prose` or `prompt` statement written in requirement shape has no
 * contractual value, so nothing is supposed to satisfy it. Left in the divisor
 * it drags coverage down for a model that is fully covered — the same failure
 * the bundled library caused — and dropping it in silence would leave a ratio
 * nobody can reconcile with the rows in front of them. So it is excluded and
 * COUNTED, beside `libraryExcluded` and `implicitExcluded`.
 */
describe('analytics — coverage counts requirements, not explanations', () => {
  /** One satisfied requirement, one `#prose` note, one `#prompt` instruction. */
  function withNonNormative() {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const part = f.part('p', pkg.id);
    const req = f.requirement('r1', pkg.id);
    f.satisfy(req.id, part.id, pkg.id);
    const note = f.requirement('note', pkg.id);
    setStatementKind(model, note.id, 'prose');
    const guidance = f.requirement('guidance', pkg.id);
    setStatementKind(model, guidance.id, 'prompt');
    return { model, ids: { req: req.id, note: note.id, guidance: guidance.id } };
  }

  it('leaves prose and prompt out of the ratio and reports how many', () => {
    const { model, ids } = withNonNormative();
    const r = requirementSatisfaction(model);
    expect(r.requirements.map((x) => x.requirement.id)).toEqual([ids.req]);
    expect(r.total).toBe(1);
    expect(r.satisfied).toBe(1);
    expect(r.coverage).toBe(1);
    expect(r.nonNormativeExcluded).toBe(2);
    expect(r.libraryExcluded).toBe(0);
    expect(r.implicitExcluded).toBe(0);
  });

  it('counts an untagged requirement, which is normative by default', () => {
    const { model } = withNonNormative();
    const f = new ModelFactory(model);
    f.requirement('r2', model.roots()[0].id);
    const r = requirementSatisfaction(model);
    expect(r.total).toBe(2);
    expect(r.satisfied).toBe(1);
    expect(r.nonNormativeExcluded).toBe(2);
  });
});

/**
 * The Problems panel's "check constraints" command drops the validator's own
 * `constraint-violation` rows and lists this report in their place
 * (`store.runConstraintCheck`). Without the same exemption the rule takes, a
 * `#prose` statement that the checker is silent about walks back into the same
 * panel through the other door.
 */
describe('analytics — constraintReport and statements that bind nothing', () => {
  function withProse() {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const con = model.create('ConstraintUsage', {
      declaredName: 'limit',
      ownerId: pkg.id,
      attrs: { expression: '30 <= 25' },
    });
    const note = f.requirement('aNote', pkg.id);
    model.setAttrs(note.id, { expression: '30 <= 25' });
    setStatementKind(model, note.id, 'prose');
    return { model, con: con.id, note: note.id };
  }

  it('leaves out a prose statement, and keeps the plain constraint', () => {
    const { model, con, note } = withProse();
    const r = constraintReport(model);
    expect(r.constraints.map((c) => c.id)).toEqual([con]);
    expect(r.constraints.find((c) => c.id === note)).toBeUndefined();
    expect(r.violated).toBe(1);
  });

  it('still reports an untagged requirement, which is normative by default', () => {
    const { model } = withProse();
    const f = new ModelFactory(model);
    const req = f.requirement('maxMass', model.roots()[0].id);
    model.setAttrs(req.id, { expression: '30 <= 25' });
    expect(constraintReport(model).constraints.map((c) => c.id)).toContain(req.id);
  });
});

/* ────────────── a type the walk cannot follow is a counted omission ────────── */

describe('analytics — a declared type the walk cannot follow is COUNTED', () => {
  /**
   * A model whose one attribute declares a type as TEXT and carries no
   * FeatureTyping for it — the shape the library binder leaves behind for every
   * attribute typed by something outside `ScalarValues` (`ISQ::MassValue`, `SI`
   * units): `attrs.type` holds the name, the graph holds no edge, and the
   * mapper's unresolved-attribute-type path is silent by design.
   */
  function unfollowedTyping(): { model: Model; mtowId: string; defId: string } {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const vehicle = f.partDef('Vehicle', pkg.id);
    const mtow = model.create('AttributeUsage', {
      declaredName: 'mtow',
      ownerId: vehicle.id,
      attrs: { value: 18.5, unit: 'kg', type: 'ISQ::MassValue' },
    });
    // A second AttributeDefinition so the matrix has a column axis at all.
    const def = model.create('AttributeDefinition', { declaredName: 'MassValue', ownerId: pkg.id });
    return { model, mtowId: mtow.id, defId: def.id };
  }

  it('every walk-based report says how many typings it could not see', () => {
    // Before this counter the reports were BLIND and said nothing: an untyped
    // feature and a feature whose type the walk cannot reach produced the same
    // empty answer with `libraryExcluded: 0` beside it — nothing was dropped
    // from the walk, so the zero was true and useless. The reader could not
    // tell "this attribute has no type" from "this report cannot see its type".
    const { model, mtowId } = unfollowedTyping();

    expect(model.typesOf(mtowId), 'the premise: no edge carries the type').toHaveLength(0);

    const closure = impactClosure(model, mtowId, 4);
    expect(closure.impacted).toEqual([]);
    expect(closure.libraryExcluded).toBe(0);
    expect(closure.unresolvedTypings).toBe(1);

    const used = whereUsed(model, mtowId);
    expect(used.usedBy).toEqual([]);
    expect(used.unresolvedTypings).toBe(1);

    const prompts = promptsFor(model, mtowId);
    expect(prompts.prompts).toEqual([]);
    expect(prompts.unresolvedTypings).toBe(1);

    const tm = traceabilityMatrix(model, 'AttributeUsage', 'AttributeDefinition', 'FeatureTyping');
    expect(tm.links).toEqual([]);
    expect(tm.unresolvedTypings).toBe(1);
  });

  it('counts an element ONCE when it sits on both matrix axes', () => {
    // `traceabilityMatrix(m, K, K, rel)` puts every user element of kind `K` on
    // BOTH axes, so a counter that filtered `[...rows, ...columns]` without
    // de-duplicating reported twice what the reader can see once — and the
    // figure then exceeded the row count, which is the one thing a reader
    // checks it against.
    const { model } = unfollowedTyping();
    const vehicle = model.all().find((e) => e.declaredName === 'Vehicle')!;
    model.create('AttributeUsage', {
      declaredName: 'range',
      ownerId: vehicle.id,
      attrs: { type: 'ISQ::LengthValue' },
    });

    const same = traceabilityMatrix(model, 'AttributeUsage', 'AttributeUsage', 'FeatureTyping');
    expect(same.rows).toHaveLength(2);
    expect(same.columns).toHaveLength(2);
    expect(same.unresolvedTypings, 'two elements, seen twice, counted once').toBe(2);
    expect(same.unresolvedTypings).toBeLessThanOrEqual(same.rows.length);
  });

  it('counts the elements that NAME the queried type in text', () => {
    // The other direction, and the one that matters for the query a reader
    // actually makes. `whereUsed`/`impactClosure` answer "what depends on this
    // element"; asked about a TYPE, they walk edges, find none, and used to
    // print 0 unresolved typings beside "nothing references it" — while the
    // attributes that name that very type sat in the same file. The counter now
    // covers the answer being given, not only the element being asked about.
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('P');
    const massValue = model.create('AttributeDefinition', {
      declaredName: 'MassValue',
      ownerId: pkg.id,
    });
    const vehicle = f.partDef('Vehicle', pkg.id);
    for (const name of ['mtow', 'payloadMass']) {
      model.create('AttributeUsage', {
        declaredName: name,
        ownerId: vehicle.id,
        attrs: { type: 'MassValue' },
      });
    }

    expect(
      whereUsed(model, massValue.id).usedBy,
      'the premise: no edge carries any of the typings',
    ).toEqual([]);
    expect(whereUsed(model, massValue.id).unresolvedTypings).toBe(2);
    expect(impactClosure(model, massValue.id, 4).impacted).toEqual([]);
    expect(impactClosure(model, massValue.id, 4).unresolvedTypings).toBe(2);

    // A name that resolves ELSEWHERE is not counted against this element — the
    // figure is about this query, not about the model's unfollowed typings in
    // general.
    const other = model.create('AttributeDefinition', {
      declaredName: 'LengthValue',
      ownerId: pkg.id,
    });
    expect(whereUsed(model, other.id).unresolvedTypings).toBe(0);
  });

  it('counts nothing once the typing is an edge the walk can follow', () => {
    // The counter is about the EDGE, not about the name: give the same
    // attribute a real FeatureTyping and every report goes back to zero.
    const { model, mtowId, defId } = unfollowedTyping();
    model.create('FeatureTyping', { ownerId: mtowId, source: [mtowId], target: [defId] });

    expect(impactClosure(model, mtowId, 4).unresolvedTypings).toBe(0);
    expect(whereUsed(model, mtowId).unresolvedTypings).toBe(0);
    expect(promptsFor(model, mtowId).unresolvedTypings).toBe(0);
    expect(
      traceabilityMatrix(model, 'AttributeUsage', 'AttributeDefinition', 'FeatureTyping')
        .unresolvedTypings,
    ).toBe(0);
  });
});

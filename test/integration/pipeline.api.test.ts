/**
 * Pipeline integration — Parse → API query & analytics.
 *
 * Builds the model from examples/vehicle.sysml, then drives the @api surface:
 * the OMG-shaped constraint-tree query engine (by metaclass, by name, numeric
 * attribute path, composite and/or, substring) and the pure analytics functions
 * (countByMetaclass, requirementSatisfaction, whereUsed, modelMetrics,
 * orphanReport, impactClosure).
 */

import { describe, it, expect } from 'vitest';
import { parseModel } from '@text/index';
import {
  ModelApi,
  evaluateQuery,
  countByMetaclass,
  impactClosure,
  isUserElement,
  modelMetrics,
  orphanReport,
  requirementSatisfaction,
  whereUsed,
  CONNECTION_KINDS,
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
    // 50, not the historical 44: the example's six FORWARD typings (`in port
    // fuelIn : FuelPort;` written before `port def FuelPort;`) used to stay
    // textual `attrs.typeRef` strings until the library binder ran, so a
    // library-free parse produced no relationship for them at all. `parseModel`
    // resolves them itself now — declaration order stopped deciding what a
    // model contains. (44 was itself 42 plus the two bare `then` successions
    // the mapper used to drop silently, fixed 2026-09-02.)
    expect(metrics.totalElements).toBe(50);
    expect(metrics.rootCount).toBe(1);
    // FeatureTyping x8 + Satisfy x1 + Succession x3 (the implicit Redefinitions
    // are owned by implicit features, so they are excluded from the census).
    expect(metrics.relationshipCount).toBe(12);
    expect(metrics.nodeCount).toBe(metrics.totalElements - metrics.relationshipCount);
    // Deepest COUNTABLE element: VehicleModel > vehicle > engine > fuelOut = 4
    // (the implicit endpoints/Redefinitions that reached depth 5 are excluded).
    expect(metrics.maxDepth).toBe(4);
  });

  it('recovers the whole succession chain the example writes', () => {
    // A bare `then X;` continues from the previous succession's target, so
    // `first start then accelerate; then cruise; then stop;` is three links.
    // They used to be one: the mapper required both endpoints and dropped the
    // rest without a diagnostic.
    const successions = model.all().filter((el) => el.eClass === 'Succession');
    const chain = successions.map(
      (s) =>
        `${model.get((s.source ?? [])[0])?.declaredName}->${model.get((s.target ?? [])[0])?.declaredName}`,
    );
    expect(chain).toEqual(['start->accelerate', 'accelerate->cruise', 'cruise->stop']);
  });
});

describe('pipeline: Parse → orphan inventory', () => {
  it('names the two definitions the example declares and never uses', () => {
    // `Drive` and `VehicleStates` are written out in full and then never
    // instantiated — no `perform`, no `exhibit`, nothing typed by them. The
    // same reading on the UAV example finds its two, which is what says the
    // threshold is a rule rather than a fit to one file.
    const r = orphanReport(model);
    expect(r.orphans.map((o) => o.declaredName)).toEqual(['Drive', 'VehicleStates']);
    expect(r.definitionsExamined).toBe(8);
    expect(r.packagesSkipped).toBe(1);
  });
});

describe('pipeline: Parse → impact closure across a wire', () => {
  it('never reports an element of this example as reached across a wire', () => {
    // The other half of the limit `impactClosure` documents. Its doc comment
    // names BOTH shipped examples, and the UAV half is pinned in
    // `uav-example.test.ts`; this is the `vehicle.sysml` half, which was prose.
    // Both of its connections are written under the `vehicle` part usage, so
    // both ends are usage-scoped copies and the wire costs three hops, while
    // the ports it joins share `FuelPort` / `TorquePort` and are two apart.
    const own = model.all().filter((e) => isUserElement(model, e));
    const reached = own.flatMap(
      (e) => impactClosure(model, e.id, Number.POSITIVE_INFINITY).impacted,
    );
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.filter((i) => CONNECTION_KINDS.has(i.via))).toEqual([]);
  });

  it('names the cable when the copies’ ports have different definitions', () => {
    // The positive behaviour, on text the MAPPER produced rather than on
    // hand-built copies: if `ensureImplicitFeature` ever stopped tying a copy
    // to its declaration with a `Redefinition`, a hand-built pin would keep
    // passing while every real model lost its crossing.
    const { model: m } = parseModel(`package P {
    port def PowerPort;
    port def DataPort;
    part def A { out port pwr : PowerPort; }
    part def B { in port data : DataPort; }
    part def Sys {
        part a : A;
        part b : B;
        connection c connect a.pwr to b.data;
    }
}`);
    const byName = (n: string) =>
      m.all().find((e) => e.declaredName === n && e.attrs.implicit !== true)!;
    const pwr = byName('pwr');
    const closure = impactClosure(m, pwr.id, Number.POSITIVE_INFINITY);
    const far = closure.impacted.find((i) => i.element.id === byName('data').id)!;
    // Three hops — out to the near copy, across, back down to the far
    // declaration — labelled by the CABLE, and provenanced to the reader's own
    // near-side port rather than to a copy id they cannot find in their file.
    expect(far.depth).toBe(3);
    expect(far.via).toBe('ConnectionUsage');
    expect(far.from.id).toBe(pwr.id);
    expect(closure.implicitExcluded).toBe(2);
    expect(closure.impacted.every((i) => m.get(i.element.id)!.attrs.implicit !== true)).toBe(true);
  });

  it('names the cable at ONE hop when the connection binds the declarations', () => {
    // The shape the limit does NOT apply to, and the reason the limit is about
    // endpoint shape rather than about port definitions: a connection written
    // inside the `part def` that owns both ports binds to the DECLARATIONS —
    // no copies, no three-hop crossing — so the wire is a single hop and beats
    // the typing detour even though both ends share one port definition.
    const { model: m } = parseModel(
      `package Q { port def PP; part def T { in port a : PP; out port b : PP; connection c connect a to b; } }`,
    );
    const byName = (n: string) =>
      m.all().find((e) => e.declaredName === n && e.attrs.implicit !== true)!;
    const closure = impactClosure(m, byName('a').id, Number.POSITIVE_INFINITY);
    expect(closure.impacted.map((i) => `${i.depth} ${i.via} ${i.element.declaredName}`)).toEqual([
      '1 ConnectionUsage b',
      '1 FeatureTyping PP',
    ]);
    expect(closure.implicitExcluded).toBe(0);
  });
});

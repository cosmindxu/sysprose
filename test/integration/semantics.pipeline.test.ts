/**
 * Pipeline integration — Parse → Semantics → API/Validation.
 *
 * Parses a model with a typed attribute, an inheritance edge, and a requirement
 * carrying a `require { … }` constraint over that attribute, then exercises the
 * end-to-end semantics surface:
 *  - conformance queries (numeric tower + user subclassification) via ModelApi;
 *  - effective-feature inheritance (a subtype inherits its supertype's feature);
 *  - constraint classification (satisfied vs. violated) via checkConstraints and
 *    the analytics `constraintReport` (+ the REST `/analytics/constraints` route);
 *  - the `constraint-violation` validation diagnostic that surfaces a broken
 *    requirement in the Problems list.
 */

import { describe, it, expect } from 'vitest';
import { parseModel } from '@text/index';
import { ModelApi, SysmlApiServer, constraintReport } from '@api/index';
import { validate } from '@validation/index';
import { effectiveFeatures, effectiveFeaturesWithLibrary } from '../../src/semantics/index';
import { resolveModel, findLibraryType } from '../../src/library/index';

/** Parse `src`, then author + bind the standard library (numeric tower etc.). */
function build(src: string) {
  const { model } = parseModel(src);
  resolveModel(model);
  return model;
}

const SATISFIED_SRC = `
package P {
  part def Base {
    attribute m : Real;
  }
  part def Vehicle :> Base {
    attribute mass : Real = 1500;
    attribute count : Integer = 3;
  }
  requirement <R1> maxMass {
    subject v : Vehicle;
    require { mass <= 2000 }
  }
}`;

const VIOLATED_SRC = SATISFIED_SRC.replace('attribute mass : Real = 1500;', 'attribute mass : Real = 2500;');

describe('semantics pipeline — conformance queries', () => {
  const model = build(SATISFIED_SRC);
  const api = new ModelApi(model);
  const vehicle = model.all().find((e) => e.declaredName === 'Vehicle')!;
  const base = model.all().find((e) => e.declaredName === 'Base')!;

  it('a subtype conforms to its supertype (user subclassification)', () => {
    expect(api.conforms(vehicle.id, base.id)).toBe(true);
    expect(api.conforms(base.id, vehicle.id)).toBe(false);
    expect(api.conforms(vehicle.id, vehicle.id)).toBe(true);
  });

  it('conforms follows the standard-library numeric tower (Integer ⊑ Real)', () => {
    const integer = findLibraryType(model, 'Integer')!;
    const real = findLibraryType(model, 'Real')!;
    expect(integer).toBeDefined();
    expect(real).toBeDefined();
    expect(api.conforms(integer.id, real.id)).toBe(true);
    expect(api.conforms(real.id, integer.id)).toBe(false);
  });
});

describe('semantics pipeline — effective feature inheritance', () => {
  const model = build(SATISFIED_SRC);
  const api = new ModelApi(model);
  const vehicle = model.all().find((e) => e.declaredName === 'Vehicle')!;

  it('a subtype inherits its supertype feature and keeps its own', () => {
    const names = effectiveFeatures(model, vehicle.id).map((f) => f.declaredName);
    expect(names).toContain('mass'); // own
    expect(names).toContain('count'); // own
    expect(names).toContain('m'); // inherited from Base
  });

  it('ModelApi.effectiveFeatures mirrors the library-aware semantics query', () => {
    // ModelApi.effectiveFeatures now surfaces library-inherited features via
    // effectiveFeaturesWithLibrary; it must match that query exactly.
    const viaApi = api.effectiveFeatures(vehicle.id).map((f) => f.declaredName).sort();
    const viaSem = effectiveFeaturesWithLibrary(model, vehicle.id).map((f) => f.declaredName).sort();
    expect(viaApi).toEqual(viaSem);
    // The library-aware set is a superset of the explicit-generals-only set.
    const explicit = effectiveFeatures(model, vehicle.id).map((f) => f.declaredName);
    for (const n of explicit) expect(viaApi).toContain(n);
  });
});

describe('semantics pipeline — constraint classification', () => {
  it('classifies a satisfied requirement constraint', () => {
    const model = build(SATISFIED_SRC);
    const api = new ModelApi(model);
    const checks = api.checkConstraints();
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('satisfied');
    expect(checks[0].expression).toBe('mass <= 2000');

    const report = constraintReport(model);
    expect(report.total).toBe(1);
    expect(report.satisfied).toBe(1);
    expect(report.violated).toBe(0);
    // Navigable: each entry carries a resolvable element reference.
    expect(report.constraints[0].element.qualifiedName).toContain('maxMass');
  });

  it('classifies a violated requirement constraint', () => {
    const model = build(VIOLATED_SRC);
    const checks = new ModelApi(model).checkConstraints();
    expect(checks).toHaveLength(1);
    expect(checks[0].result).toBe('violated');

    const report = constraintReport(model);
    expect(report.violated).toBe(1);
    expect(report.satisfied).toBe(0);
  });

  it('exposes the constraint report over the REST facade', () => {
    const model = build(VIOLATED_SRC);
    const server = new SysmlApiServer(model);
    const res = server.apiFetch('GET', '/analytics/constraints');
    expect(res.status).toBe(200);
    const body = res.body as ReturnType<typeof constraintReport>;
    expect(body.total).toBe(1);
    expect(body.violated).toBe(1);
  });
});

describe('semantics pipeline — validation surfaces a constraint violation', () => {
  it('a violated constraint yields a constraint-violation warning carrying its element id', () => {
    const model = build(VIOLATED_SRC);
    const constraint = model.ofKind('ConstraintUsage')[0];

    const diags = validate(model);
    const violation = diags.find((d) => d.ruleId === 'constraint-violation');
    expect(violation).toBeDefined();
    expect(violation!.severity).toBe('warning');
    expect(violation!.elementId).toBe(constraint.id);
    expect(violation!.message).toContain('mass <= 2000'); // includes the expression
  });

  it('a satisfied constraint yields no constraint-violation diagnostic', () => {
    const model = build(SATISFIED_SRC);
    const diags = validate(model);
    expect(diags.some((d) => d.ruleId === 'constraint-violation')).toBe(false);
  });
});

/**
 * Unit-aware evaluation + dimensional validation + units API.
 *
 * Exercises the units feature end-to-end over a small hand-built model:
 *  - {@link ModelApi.convertUnit} / {@link ModelApi.evaluateQuantity};
 *  - unit-aware constraint evaluation (`require { mass <= 2000 [kg] }`);
 *  - the `dimensional-consistency` validation rule (mass typed, valued in m);
 *  - the analytics `unitReport` / REST `GET /analytics/units` shape.
 */

import { describe, it, expect } from 'vitest';
import { Model } from '@core/index';
import { ModelApi, SysmlApiServer, unitReport, type UnitReport } from '@api/index';
import { validate } from '@validation/index';
import { parseModel, serializeModel } from '@text/index';
import { checkConstraints } from '../../src/semantics/index';
import { dimToString } from '../../src/semantics/units';

/**
 * A car with `mass : MassValue` (magnitude + unit) and a
 * `require { mass <= 2000 [kg] }` constraint. `massValue` / `massUnit`
 * parameterise the mass so tests can drive satisfied/violated/bad-dimension.
 */
function buildModel(opts: { massValue?: number | string; massUnit?: string } = {}): {
  model: Model;
  carId: string;
  massId: string;
  constraintId: string;
} {
  const { massValue = 1500, massUnit = 'kg' } = opts;
  const model = new Model();
  const pkg = model.create('Package', { declaredName: 'P' });
  const car = model.create('PartUsage', { declaredName: 'car', ownerId: pkg.id });
  const attrs: Record<string, string | number> = { type: 'MassValue', value: massValue };
  if (massUnit) attrs.unit = massUnit;
  const mass = model.create('AttributeUsage', {
    declaredName: 'mass',
    ownerId: car.id,
    attrs,
  });
  const constraint = model.create('ConstraintUsage', {
    declaredName: 'massLimit',
    ownerId: car.id,
    attrs: { requirementRole: 'require', expression: 'mass <= 2000 [kg]' },
  });
  return { model, carId: car.id, massId: mass.id, constraintId: constraint.id };
}

describe('units — conversion & quantity evaluation', () => {
  it('converts 1500 kg → 1.5 t via ModelApi.convertUnit', () => {
    const { model } = buildModel();
    const api = new ModelApi(model);
    expect(api.convertUnit(1500, 'kg', 't')).toBeCloseTo(1.5, 9);
    expect(api.convertUnit(1500, 'kg', 'tonne')).toBeCloseTo(1.5, 9);
  });

  it('rejects an incompatible conversion', () => {
    const api = new ModelApi(buildModel().model);
    expect(() => api.convertUnit(1, 'kg', 'm')).toThrow(/[Ii]ncompatible/);
  });

  it('evaluateQuantity reads magnitude + dimension + unit (attrs.value + attrs.unit)', () => {
    const { model, massId } = buildModel();
    const q = new ModelApi(model).evaluateQuantity(massId);
    expect(q).toBeDefined();
    expect(q!.magnitude).toBe(1500);
    expect(dimToString(q!.dimension)).toBe('M');
    expect(q!.unit).toBe('kg');
  });

  it('evaluateQuantity parses an inline `1500 [kg]` string value', () => {
    const { model, massId } = buildModel({ massValue: '1500 [kg]', massUnit: '' });
    const q = new ModelApi(model).evaluateQuantity(massId);
    expect(q).toBeDefined();
    expect(q!.magnitude).toBe(1500);
    expect(q!.unit).toBe('kg');
    expect(dimToString(q!.dimension)).toBe('M');
  });

  it('lists dimensionally-compatible units', () => {
    const api = new ModelApi(buildModel().model);
    const compat = api.compatibleUnits('kg');
    expect(compat).toContain('t');
    expect(compat).toContain('g');
    expect(compat).not.toContain('m');
  });
});

describe('units — unit-aware constraint evaluation', () => {
  it('`require { mass <= 2000 [kg] }` is satisfied for a 1500 kg mass', () => {
    const { model, constraintId } = buildModel({ massValue: 1500 });
    const check = checkConstraints(model).find((c) => c.id === constraintId);
    expect(check?.result).toBe('satisfied');
  });

  it('`require { mass <= 2000 [kg] }` is violated for a 2500 kg mass', () => {
    const { model, constraintId } = buildModel({ massValue: 2500 });
    const check = checkConstraints(model).find((c) => c.id === constraintId);
    expect(check?.result).toBe('violated');
  });

  it('the programmatic model round-trips through the notation and keeps its verdict', () => {
    // The serializer always emitted `mass <= 2000 [kg]` verbatim; the parser
    // used to reject it (the grammar had no unit literal inside a constraint
    // body), so a saved model could not be read back. Closure is asserted
    // rather than just a clean parse: the reparsed model judges the same way.
    const { model } = buildModel({ massValue: 2500 });
    const text = serializeModel(model);
    expect(text).toContain('mass <= 2000 [kg]');
    const back = parseModel(text);
    expect(back.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(serializeModel(back.model)).toBe(text);
    const reparsed = back.model.all().find((e) => e.eClass === 'ConstraintUsage')!;
    expect(checkConstraints(back.model).find((c) => c.id === reparsed.id)?.result).toBe('violated');
  });

  it('auto-converts units in the comparison (1.8 t < 2000 kg → satisfied)', () => {
    const { model, constraintId } = buildModel({ massValue: 1.8, massUnit: 't' });
    const check = checkConstraints(model).find((c) => c.id === constraintId);
    expect(check?.result).toBe('satisfied');
  });
});

describe('units — dimensional-consistency validation', () => {
  it('does not flag a mass valued in kg', () => {
    const { model } = buildModel({ massValue: 1500, massUnit: 'kg' });
    const diags = validate(model, { ruleIds: ['dimensional-consistency'] });
    expect(diags).toHaveLength(0);
  });

  it('flags a mass-typed feature whose value is in metres', () => {
    const { model, massId } = buildModel({ massValue: 5, massUnit: 'm' });
    const diags = validate(model, { ruleIds: ['dimensional-consistency'] });
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe('dimensional-consistency');
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].elementId).toBe(massId);
  });
});

describe('units — analytics report & REST route', () => {
  it('unitReport summarises quantity-valued features', () => {
    const { model, massId } = buildModel();
    const report = unitReport(model);
    expect(report.total).toBe(1);
    expect(report.consistent).toBe(1);
    expect(report.inconsistent).toBe(0);
    const entry = report.features.find((f) => f.element.id === massId);
    expect(entry).toBeDefined();
    expect(entry!.value).toBe(1500);
    expect(entry!.unit).toBe('kg');
    expect(entry!.dimension).toBe('M');
    expect(entry!.quantityKind).toBe('MassValue');
    expect(entry!.consistent).toBe(true);
  });

  it('unitReport counts an inconsistent (mass-in-metres) feature', () => {
    const { model } = buildModel({ massValue: 5, massUnit: 'm' });
    const report = new ModelApi(model).dimensionalAnalysis();
    expect(report.inconsistent).toBe(1);
    expect(report.features[0].consistent).toBe(false);
  });

  it('GET /analytics/units returns the report shape', () => {
    const { model, massId } = buildModel();
    const server = new SysmlApiServer(model);
    const res = server.apiFetch('GET', '/analytics/units');
    expect(res.status).toBe(200);
    const body = res.body as UnitReport;
    expect(body).toHaveProperty('features');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('consistent');
    expect(body).toHaveProperty('inconsistent');
    const entry = body.features.find((f) => f.element.id === massId);
    expect(entry?.unit).toBe('kg');
    expect(entry?.dimension).toBe('M');
    expect(entry?.consistent).toBe(true);
  });
});

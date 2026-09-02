import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  gatherInequalities,
  solveFeasible,
  checkConstraintsNumeric,
  optimize,
} from '../../src/semantics/index';
import { ModelApi, analysisReport } from '@api/index';

/* ───────────────────────── gatherInequalities ────────────────────────── */

describe('gatherInequalities', () => {
  it('collects comparison bodies and normalises to g <= 0', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('x', p.id, { type: 'Real' });
    f.attribute('p', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 6' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'p > 3' } });
    // An equality body is NOT an inequality.
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x = 5' } });

    const ineqs = gatherInequalities(m);
    expect(ineqs.length).toBe(2);
    const le = ineqs.find((i) => i.raw === 'x <= 6');
    const gt = ineqs.find((i) => i.raw === 'p > 3');
    expect(le).toBeDefined();
    expect(gt).toBeDefined();
    expect(le!.op).toBe('<=');
    // A '>' is stored negated (residual rhs − lhs).
    expect(gt!.op).toBe('>');
    expect(le!.vars.length).toBe(1);
  });
});

/* ───────────── inequality driven by an equality: feasible/violated ────── */

describe('checkConstraintsNumeric — inequality driven by an equality', () => {
  it('reports satisfied when the equality-driven value respects the bound', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('x', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x = 5' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 10' } });

    const checks = checkConstraintsNumeric(m);
    const bound = checks.find((c) => c.raw === 'x <= 10');
    expect(bound).toBeDefined();
    expect(bound!.kind).toBe('inequality');
    expect(bound!.result).toBe('satisfied');
    expect(bound!.amount).toBe(0);
    // Slack is the margin to spare (10 − 5 = 5).
    expect(bound!.slack).toBeCloseTo(5, 6);
  });

  it('reports violated with the exact amount when the bound is exceeded', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('x', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x = 20' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 10' } });

    const checks = checkConstraintsNumeric(m);
    const bound = checks.find((c) => c.raw === 'x <= 10')!;
    expect(bound.result).toBe('violated');
    expect(bound.amount).toBeCloseTo(10, 6);
    // The equality itself is satisfied.
    const eq = checks.find((c) => c.raw === 'x = 20')!;
    expect(eq.kind).toBe('equality');
    expect(eq.result).toBe('satisfied');
  });
});

/* ──────────────────────────── solveFeasible ───────────────────────────── */

describe('solveFeasible', () => {
  it('finds a point satisfying an equality + an inequality (x+y=10, x<=6)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const x = f.attribute('x', p.id, { type: 'Real' });
    const y = f.attribute('y', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x + y = 10' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 6' } });

    const res = solveFeasible(m);
    expect(res.feasible).toBe(true);
    expect(res.violations.length).toBe(0);
    const xv = res.values.get(x.id)!;
    const yv = res.values.get(y.id)!;
    expect(xv).toBeLessThanOrEqual(6 + 1e-6);
    // The equality still holds at the feasible point.
    expect(xv + yv).toBeCloseTo(10, 4);
  });

  it('drives a variable to respect a tight bound the raw solve would break', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const x = f.attribute('x', p.id, { type: 'Real' });
    const y = f.attribute('y', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x + y = 10' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 3' } });

    const res = solveFeasible(m);
    expect(res.feasible).toBe(true);
    expect(res.values.get(x.id)!).toBeLessThanOrEqual(3 + 1e-4);
    expect(res.values.get(x.id)! + res.values.get(y.id)!).toBeCloseTo(10, 3);
  });

  it('reports infeasible with the violation amount for x=20, x<=10', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('x', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x = 20' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 10' } });

    const res = solveFeasible(m);
    expect(res.feasible).toBe(false);
    expect(res.violations.length).toBe(1);
    expect(res.violations[0].amount).toBeCloseTo(10, 6);
  });
});

/* ─────────────────────── constrained optimize ─────────────────────────── */

describe('optimize with inequality constraints', () => {
  it('maximises subject to x <= 6 and returns a feasible boundary optimum', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const x = f.attribute('x', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 6' } });

    const res = optimize(m, x.id, [x.id], {
      sense: 'max',
      bounds: { [x.id]: [0, 10] },
      constraints: true,
    });
    expect(res.sense).toBe('max');
    // The optimum sits at the constraint boundary, not the unconstrained bound (10).
    expect(res.value).toBeCloseTo(6, 3);
    expect(res.feasible).toBe(true);
    expect(res.best.get(x.id)!).toBeLessThanOrEqual(6 + 1e-3);
  });

  it('without constraints the unconstrained maximum reaches the upper bound', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const x = f.attribute('x', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 6' } });

    const res = optimize(m, x.id, [x.id], { sense: 'max', bounds: { [x.id]: [0, 10] } });
    expect(res.value).toBeCloseTo(10, 3);
    expect(res.feasible).toBeUndefined();
  });
});

/* ─────────────────────────── API + analytics ──────────────────────────── */

describe('ModelApi.solveFeasible + analysisReport feasibility', () => {
  it('exposes solveFeasible on the SDK', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('x', p.id, { type: 'Real' });
    f.attribute('y', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x + y = 10' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 6' } });

    const api = new ModelApi(m);
    const res = api.solveFeasible();
    expect(res.feasible).toBe(true);
    expect(res.violations.length).toBe(0);
  });

  it('analysisReport surfaces feasibility + violated constraints', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('x', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x = 20' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 10' } });

    const report = analysisReport(m);
    expect(report.feasible).toBe(false);
    expect(report.violations.length).toBeGreaterThanOrEqual(1);
    const viol = report.violations.find((v) => v.expression === 'x <= 10')!;
    expect(viol.kind).toBe('inequality');
    expect(viol.amount).toBeCloseTo(10, 6);
  });

  it('reports a feasible analysis when all inequalities hold', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('x', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x = 5' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 10' } });

    const report = analysisReport(m);
    expect(report.feasible).toBe(true);
    expect(report.violations.length).toBe(0);
  });
});

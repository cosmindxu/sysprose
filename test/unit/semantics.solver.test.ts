import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  gatherConstraints,
  solve,
  evaluateMoEs,
  optimize,
} from '../../src/semantics/index';

/* ─────────────────────────── constraint chain ────────────────────────── */

describe('solve — parametric chains', () => {
  it('solves force = mass·acceleration and power = force·velocity', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Dynamics');
    const mass = f.attribute('mass', p.id, { type: 'Real', value: 1500 });
    const accel = f.attribute('acceleration', p.id, { type: 'Real', value: 2 });
    const velocity = f.attribute('velocity', p.id, { type: 'Real', value: 10 });
    const force = f.attribute('force', p.id, { type: 'Real', value: 'mass * acceleration' });
    const power = f.attribute('power', p.id, { type: 'Real', value: 'force * velocity' });

    const res = solve(m);
    expect(res.converged).toBe(true);
    expect(res.values.get(force.id)).toBeCloseTo(3000, 6);
    expect(res.values.get(power.id)).toBeCloseTo(30000, 6);
    // Seeds are preserved.
    expect(res.values.get(mass.id)).toBe(1500);
    expect(res.values.get(accel.id)).toBe(2);
    expect(res.values.get(velocity.id)).toBe(10);
    expect(res.residual).toBeLessThan(1e-6);
  });

  it('gathers an equation per feature-value assignment', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Dynamics');
    f.attribute('mass', p.id, { type: 'Real', value: 1500 });
    f.attribute('acceleration', p.id, { type: 'Real', value: 2 });
    f.attribute('force', p.id, { type: 'Real', value: 'mass * acceleration' });

    const eqs = gatherConstraints(m);
    // Only `force` carries an expression — mass/acceleration are plain seeds.
    expect(eqs.length).toBe(1);
    expect(eqs[0].vars.length).toBe(3); // force, mass, acceleration
    expect(eqs[0].raw).toContain('mass * acceleration');
  });
});

/* ─────────────────────────── binding equality ────────────────────────── */

describe('solve — binding equalities', () => {
  it('propagates a bound value across a BindingConnector', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real', value: 42 });
    const b = f.attribute('b', p.id, { type: 'Real' });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [a.id], target: [b.id] });

    const res = solve(m);
    expect(res.values.get(a.id)).toBe(42);
    expect(res.values.get(b.id)).toBe(42);
    expect(res.converged).toBe(true);

    // A binding contributes an equality equation.
    const eqs = gatherConstraints(m);
    expect(eqs.some((e) => e.vars.includes(a.id) && e.vars.includes(b.id))).toBe(true);
  });
});

/* ──────────────────────── coupled linear system ──────────────────────── */

describe('solve — coupled systems', () => {
  it('converges a coupled 2-equation system (x+y=10, x−y=2)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Coupled');
    const x = f.attribute('x', p.id, { type: 'Real' });
    const y = f.attribute('y', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x + y = 10' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x - y = 2' } });

    const res = solve(m);
    expect(res.converged).toBe(true);
    expect(res.values.get(x.id)).toBeCloseTo(6, 6);
    expect(res.values.get(y.id)).toBeCloseTo(4, 6);
    expect(res.residual).toBeLessThan(1e-6);
    expect(res.iterations).toBeGreaterThan(0);
  });

  it('solves an implicit single equation numerically (x·x = 9)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Implicit');
    const x = f.attribute('x', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x * x = 9' } });

    const res = solve(m);
    expect(res.converged).toBe(true);
    expect(Math.abs(res.values.get(x.id)!)).toBeCloseTo(3, 4);
  });

  it('solves a large-magnitude implicit equation (x·x = 1_000_000)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Big');
    const x = f.attribute('x', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x * x = 1000000' } });
    const res = solve(m);
    expect(res.converged).toBe(true);
    expect(Math.abs(res.values.get(x.id)!)).toBeCloseTo(1000, 3);
  });

  it('solves a VERY large-magnitude implicit equation to relative accuracy (M6)', () => {
    // Regression guard for finding M6: with an absolute residual tolerance the
    // solver could never accept on residual at this scale (|f| ≈ 2·x·δ ≫ tol);
    // the per-equation residual scale in solveScalar restores residual-based
    // convergence, so the root is accurate to a tight RELATIVE error.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Huge');
    const x = f.attribute('x', p.id, { type: 'Real' });
    // root = 1e8; a naive absolute-tol solver stalls on the step test far off.
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x * x = 1e16' } });
    const res = solve(m);
    expect(res.converged).toBe(true);
    const xv = Math.abs(res.values.get(x.id)!);
    expect(Math.abs(xv - 1e8) / 1e8).toBeLessThan(1e-6); // <1 ppm relative error
  });

  it('converges the same large equation written in moved-to-one-side form (M6 form-invariance)', () => {
    // `x*x - 1e16 = 0` is algebraically identical to `x*x = 1e16`; a max-of-sides
    // scale would collapse to ~0 at the root and spuriously report non-converged.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Moved');
    const x = f.attribute('x', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x * x - 1e16 = 0' } });
    const res = solve(m);
    expect(res.converged).toBe(true);
    const xv = Math.abs(res.values.get(x.id)!);
    expect(Math.abs(xv - 1e8) / 1e8).toBeLessThan(1e-6);
  });

  it('does NOT report convergence for a violated constraint hidden behind a huge offset (M6)', () => {
    // Guard against an over-loose scale-relative gate (a `1e-6·scale` gate would
    // rubber-stamp this): x is pinned to 5 by the first constraint, but the
    // second demands x = 0. The residual (5) is real, not rounding noise, even
    // though the equation's sides are ~1e12 — so `converged` must be false.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Conflict');
    const x = f.attribute('x', p.id, { type: 'Real', value: 5 });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x + 1e12 = 1e12' } });
    const res = solve(m);
    expect(res.converged).toBe(false);
    expect(res.values.get(x.id)).toBe(5);
  });

  it('does NOT report convergence when large CANCELLING subterms mask a real error (M6)', () => {
    // `x + 1e9 - 1e9 = 5` reduces to `x = 5`; x is pinned at 5.0001, a real
    // 1e-4 violation. A subexpression-max scale sees the 1e9 literal, but the
    // noise floor (RESIDUAL_FLOOR) must be tight enough that the 1e-4 error is
    // still flagged rather than swallowed by an inflated gate.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Cancel');
    m.create('AttributeUsage', { declaredName: 'x', ownerId: p.id, attrs: { type: 'Real', value: 5.0001 } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x + 1e9 - 1e9 = 5' } });
    const res = solve(m);
    expect(res.converged).toBe(false);
  });

  it('solves a small-scale coupled system beside an unrelated large sibling', () => {
    // Regression guard: a subsystem-wide scale seed (the reverted M6 attempt)
    // mis-seeded these unknowns at the large sibling's magnitude and stalled.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Mixed');
    const x = f.attribute('x', p.id, { type: 'Real' });
    const y = f.attribute('y', p.id, { type: 'Real' });
    f.attribute('big', p.id, { type: 'Real', value: 1000000 }); // unrelated large sibling
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x + y = 0.03' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x * y = 0.0002' } });

    const res = solve(m);
    expect(res.converged).toBe(true);
    const xv = res.values.get(x.id)!;
    const yv = res.values.get(y.id)!;
    expect(xv + yv).toBeCloseTo(0.03, 5);
    expect(xv * yv).toBeCloseTo(0.0002, 6);
  });

  it('large-magnitude linear coupled system converges with per-equation scale (M6)', () => {
    // x + y = 500000   and   x - y = 100000  →  x=300000, y=200000.
    // The old maxF <= tol gate would never clear at this magnitude.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('BigLin');
    const x = f.attribute('x', p.id, { type: 'Real' });
    const y = f.attribute('y', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x + y = 500000' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x - y = 100000' } });

    const res = solve(m);
    expect(res.converged).toBe(true);
    const xv = res.values.get(x.id)!;
    const yv = res.values.get(y.id)!;
    expect(xv + yv).toBeCloseTo(500000, 5);
    expect(xv - yv).toBeCloseTo(100000, 5);
  });
});

/* ──────────────────────────── MoE evaluation ─────────────────────────── */

describe('evaluateMoEs', () => {
  it('returns a named measure with its solved value', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Vehicle');
    f.attribute('mass', p.id, { type: 'Real', value: 1500 });
    f.attribute('acceleration', p.id, { type: 'Real', value: 2 });
    // A measure of effectiveness (name contains 'MoE'), computed from the chain.
    const force = f.attribute('forceMoE', p.id, { type: 'Real', value: 'mass * acceleration' });

    const measures = evaluateMoEs(m);
    const moe = measures.find((x) => x.id === force.id);
    expect(moe).toBeDefined();
    expect(moe!.name).toBe('forceMoE');
    expect(moe!.value).toBeCloseTo(3000, 6);
  });

  it('identifies a value feature owned by an AnalysisCase as a measure', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('Study');
    const analysis = m.create('AnalysisCaseUsage', { declaredName: 'RangeStudy', ownerId: pkg.id });
    const score = f.attribute('score', analysis.id, { type: 'Real', value: 87 });

    const measures = evaluateMoEs(m);
    const moe = measures.find((x) => x.id === score.id);
    expect(moe).toBeDefined();
    expect(moe!.value).toBe(87);
  });

  it('honours an explicit attrs.isMoe flag', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const eff = m.create('AttributeUsage', {
      declaredName: 'efficiency',
      ownerId: p.id,
      attrs: { value: 0.9, isMoe: true },
    });
    const measures = evaluateMoEs(m);
    expect(measures.some((x) => x.id === eff.id && x.value === 0.9)).toBe(true);
  });
});

/* ───────────────────────────── optimization ──────────────────────────── */

describe('optimize', () => {
  it('minimises a bounded quadratic objective', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Design');
    const x = f.attribute('x', p.id, { type: 'Real' });
    const y = f.attribute('y', p.id, { type: 'Real', value: '(x - 3) ^ 2 + 1' });

    const res = optimize(m, y.id, [x.id], { sense: 'min', bounds: { [x.id]: [0, 10] } });
    expect(res.sense).toBe('min');
    expect(res.best.get(x.id)).toBeCloseTo(3, 2);
    expect(res.value).toBeCloseTo(1, 3);
  });

  it('maximises a bounded concave objective', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Design');
    const x = f.attribute('x', p.id, { type: 'Real' });
    const y = f.attribute('y', p.id, { type: 'Real', value: '10 - (x - 5) ^ 2' });

    const res = optimize(m, y.id, [x.id], { sense: 'max', bounds: { [x.id]: [0, 10] } });
    expect(res.sense).toBe('max');
    expect(res.best.get(x.id)).toBeCloseTo(5, 2);
    expect(res.value).toBeCloseTo(10, 3);
  });
});

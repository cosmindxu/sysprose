import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  gatherConstraints,
  solve,
  evaluateMoEs,
  optimize,
  checkConstraints,
  checkConstraintsNumeric,
  obligationsOf,
} from '../../src/semantics/index';
import { loadModelText } from '@text/load';

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

/*
 * A relation written in a USAGE is a feature of every instance the usage stands
 * for: R17c's `part p : P { constraint c2 { load <= 10.0 } }` in Q holds of Q's
 * own p AND of q's p, which Q's `bind p.load = L` gives q's L of 50. Read at Q's
 * L of 1, c2 was PROVED on the numeric surface and by the SMT engine. Every
 * surface now reads it as no verdict, in one sentence, while a binding above
 * the usage reads what it reads otherwise; an asserted one keeps its axiom.
 */
describe('solve — a relation a usage owns, read otherwise in an instance a binding above it reaches', () => {
  const R17C = (role: 'constraint' | 'assert constraint') => `package R17c {
    part def P { attribute load : ScalarValues::Real default = 1.0; }
    part def Q {
      attribute L : ScalarValues::Real default = 1.0;
      part p : P { ${role} c2 { load <= 10.0 } }
      bind p.load = L;
    }
    part q : Q { attribute :>> L = 50.0; }
  }`;
  const SENTENCE =
    'the relation is read in R17c::Q::p, and a binding above it joins what it reads to another value in R17c::q: ' +
    'each instance reads it otherwise, and this tool reads it for one alone, so it is not carried';

  it('is undecided on the check and the numeric surface, and refused as a goal, in one sentence', async () => {
    const { model: m } = await loadModelText(R17C('constraint'));
    const own = (id: string) => m!.qualifiedName(id) === 'R17c::Q::p::c2';
    const check = checkConstraints(m!).find((c) => own(c.id))!;
    expect([check.result, check.message]).toEqual(['unknown', `Could not evaluate: ${SENTENCE}`]);
    const row = checkConstraintsNumeric(m!).find((r) => own(r.id))!;
    expect([row.result, row.reason]).toEqual(['unknown', SENTENCE]);
    const goal = obligationsOf(m!).find((o) => o.element.qualifiedName === 'R17c::Q::p::c2')!;
    expect([goal.role, goal.encodable]).toEqual(['obligation', { reason: 'unread-definition', detail: SENTENCE }]);
  });

  it('keeps an asserted one as an axiom, read for the usage generic instance, with no verdict of its own', async () => {
    const { model: m } = await loadModelText(R17C('assert constraint'));
    const check = checkConstraints(m!).find((c) => m!.qualifiedName(c.id) === 'R17c::Q::p::c2')!;
    expect(check.result).toBe('unknown');
    const axiom = obligationsOf(m!).find((o) => o.element.qualifiedName === 'R17c::Q::p::c2')!;
    expect([axiom.role, axiom.encodable]).toEqual(['axiom', true]);
  });

  it('reads it as before where no binding reaches the usage', async () => {
    const { model: m } = await loadModelText(R17C('constraint').replace('bind p.load = L;', ''));
    const own = (id: string) => m!.qualifiedName(id) === 'R17c::Q::p::c2';
    expect(checkConstraints(m!).find((c) => own(c.id))!.result).toBe('satisfied');
    expect(checkConstraintsNumeric(m!).find((r) => own(r.id))!.result).toBe('satisfied');
    expect(obligationsOf(m!).find((o) => o.element.qualifiedName === 'R17c::Q::p::c2')!.encodable).toBe(true);
  });
  it('refuses the goal a context is listed for by a member’s own value alone, beside the axioms it had', async () => {
    // Q2's K makes Q's asserted L Q2's own 50 (FanS): QB's cq is read in Q2 by no surface yet. The axioms
    // read in Q2 are the ones filed before (Q2's defL and binding rows, and the assert those reach).
    const { model: m } = await loadModelText(`package FanS {
      part def P { attribute load : ScalarValues::Real default = 1.0; }
      part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real; assert constraint defL { L == 2.0 * K } part p : P; }
      part def QB :> Q { bind p.load = L; constraint cq { p.load <= 5.0 } assert constraint ca { p.load <= 100.0 } }
      part def Q2 :> QB { attribute :>> K = 25.0; }
      part q0 : Q2;
    }`);
    const sentence =
      'the relation is read in FanS::Q2, and a binding joins what it reads to a value FanS::Q2 reads as its own: ' +
      'this tool reads a bound value for one instance only where every instance reads it alike, so it is not carried';
    const rows = obligationsOf(m!);
    const inQ2 = rows.filter((o) => o.instance?.contextId === m!.all().find((e) => m!.qualifiedName(e.id) === 'FanS::Q2')!.id);
    expect(inQ2.map((o) => [o.element.qualifiedName, o.role, o.encodable])).toEqual([
      ['FanS::Q::defL in FanS::Q2', 'axiom', true],
      ['FanS::QB::cq in FanS::Q2', 'obligation', { reason: 'unread-definition', detail: sentence }],
      ['FanS::QB::«BindingConnectorAsUsage» in FanS::Q2', 'axiom', true],
      ['FanS::QB::ca in FanS::Q2', 'axiom', true],
    ]);
    // Nothing is read in q0, which reads every name as Q2 does.
    expect(rows.filter((o) => o.element.qualifiedName.endsWith('in FanS::q0'))).toEqual([]);
    const numeric = checkConstraintsNumeric(m!).find((r) => r.id.endsWith(`@${inQ2[0]!.instance!.contextId}`) && r.id.startsWith(
      m!.all().find((e) => m!.qualifiedName(e.id) === 'FanS::QB::cq')!.id,
    ))!;
    expect([numeric.result, numeric.reason]).toEqual(['unknown', sentence]);
  });

  it('keeps the unit gates on a bound partner whose value it reads in no instance (G271)', async () => {
    // r's q binds p's load to L = 2.0 * K, K bound to J = 0.5 * N, N 50 kg in Q2: no surface reads K's value
    // for r's q through Q's generic reading — but its kilograms are every instance's. Withheld with the
    // value, they made the gates refuse `L == 2.0 * K` as a bare number, and r0's refutation inconclusive.
    const { model: m } = await loadModelText(`package G271 {
      part def P { attribute load : ISQ::MassValue default = 3.0 [SI::kg]; attribute m2 : ISQ::MassValue = 10.0 [SI::kg] - load; }
      part def Q { attribute N : ISQ::MassValue default = 1.0 [SI::kg]; attribute J : ISQ::MassValue default = 0.5 * N; attribute K : ISQ::MassValue; bind K = J; attribute L : ISQ::MassValue = 2.0 * K; part p : P; }
      part def Q2 :> Q { attribute :>> N = 50.0 [SI::kg]; }
      part def R { part q : Q2; }
      part r : R { part :>> q { bind p.load = L; } }
      part def R0 { part q : Q; }
      part r0 : R0;
      constraint ctlA { r0.q.p.m2 >= 8.5 [SI::kg] }
    }`);
    expect(obligationsOf(m!).filter((o) => o.encodable !== true).map((o) => o.element.qualifiedName)).toEqual([]);
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

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
  solveFeasible,
} from '../../src/semantics/index';
import { loadModelText } from '@text/load';
import { parseModel } from '@text/index';
import { defaultStandsIn } from '../../src/semantics/defining-equation';

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
 * L of 1, c2 was PROVED on the numeric surface and by the SMT engine. F1 refused
 * it on every surface; F7 reads it per instance — the usage's own generic row
 * holds, and q's p violates it — while an asserted one keeps its axiom.
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

  it('reads it per instance: the generic row holds and the named instance violates (F7)', async () => {
    const { model: m } = await loadModelText(R17C('constraint'));
    const own = (id: string) => m!.qualifiedName(id) === 'R17c::Q::p::c2';
    const check = checkConstraints(m!).find((c) => own(c.id))!;
    expect(check.result).toBe('satisfied');
    expect(check.instances!.map((i) => [i.instance, i.result])).toEqual([['R17c::q::p', 'violated']]);
    const row = checkConstraintsNumeric(m!).find((r) => own(r.id))!;
    expect(row.result).toBe('satisfied');
    const goal = obligationsOf(m!).find((o) => o.element.qualifiedName === 'R17c::Q::p::c2')!;
    expect([goal.role, goal.encodable]).toEqual(['obligation', true]);
    const inst = obligationsOf(m!).find((o) => o.element.qualifiedName === 'R17c::Q::p::c2 in R17c::q::p')!;
    expect(inst.role).toBe('obligation');
  });

  it('keeps an asserted one as an axiom, read for the usage generic instance (F7)', async () => {
    const { model: m } = await loadModelText(R17C('assert constraint'));
    const check = checkConstraints(m!).find((c) => m!.qualifiedName(c.id) === 'R17c::Q::p::c2')!;
    expect(check.result).toBe('satisfied');
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
  it('reads the goal a context is listed for by a member’s own value alone at its instance, beside the axioms it had', async () => {
    // Q2's K makes Q's asserted L Q2's own 50 (FanS): QB's cq is read in Q2 at Q2's own instance (E7), on
    // every surface. The axioms read in Q2 are the ones filed before (Q2's defL and binding rows, and the
    // assert those reach). The binding joins that 50 to P's `load default = 1.0`, which no assertion replaces
    // (decision 14 amended 2026-10-22): two values, so cq's goal there is not encoded, and not read.
    const { model: m } = await loadModelText(`package FanS {
      part def P { attribute load : ScalarValues::Real default = 1.0; }
      part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real; assert constraint defL { L == 2.0 * K } part p : P; }
      part def QB :> Q { bind p.load = L; constraint cq { p.load <= 5.0 } assert constraint ca { p.load <= 100.0 } }
      part def Q2 :> QB { attribute :>> K = 25.0; }
      part q0 : Q2;
    }`);
    const rows = obligationsOf(m!);
    const inQ2 = rows.filter((o) => o.instance?.contextId === m!.all().find((e) => m!.qualifiedName(e.id) === 'FanS::Q2')!.id);
    expect(inQ2.map((o) => [o.element.qualifiedName, o.role, o.encodable])).toEqual([
      ['FanS::Q::defL in FanS::Q2', 'axiom', true],
      [
        'FanS::QB::cq in FanS::Q2',
        'obligation',
        {
          reason: 'unread-definition',
          detail:
            'the relation is read in FanS::Q2, and a binding joins what it reads to a value FanS::Q2 reads as its own and to ' +
            'another value the model states there: this tool reads neither of two values, so it is not carried',
        },
      ],
      ['FanS::QB::«BindingConnectorAsUsage» in FanS::Q2', 'axiom', true],
      ['FanS::QB::ca in FanS::Q2', 'axiom', true],
    ]);
    // Nothing is read in q0, which reads every name as Q2 does.
    expect(rows.filter((o) => o.element.qualifiedName.endsWith('in FanS::q0'))).toEqual([]);
    const numeric = checkConstraintsNumeric(m!).find((r) => r.id.endsWith(`@${inQ2[0]!.instance!.contextId}`) && r.id.startsWith(
      m!.all().find((e) => m!.qualifiedName(e.id) === 'FanS::QB::cq')!.id,
    ))!;
    expect(numeric.result).toBe('unknown');
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

/* ══════════════ the verify goal budget (F7, A.7; P18) ══════════════════════ */

/**
 * A relation read per instance costs the verify lane one goal row per
 * instance, and a run caps them (`MAX_INSTANCE_GOALS`, lowered here). A group
 * is taken all-or-nothing: the usage's own (generic) row and the instance rows
 * together, or — over the budget — the generic row alone as the refusal, never
 * part of a group with the instances dropped.
 */
describe('solve — the verify goal budget files a group all-or-nothing', () => {
  /** big-bind-N: N definitions Qk binding their p's load to their L, qk setting L to k. */
  const bigBind = (n: number): string =>
    [
      'package Big {',
      '  part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; constraint c { m2 <= 100.0 } }',
      ...Array.from({ length: n }, (_, k) => [
        `  part def Q${k} { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }`,
        `  part q${k} : Q${k} { attribute :>> L = ${k}.0; }`,
      ]).flat(),
      '}',
    ].join('\n');

  it('files every group whole or refuses it whole, never part of one (P18)', async () => {
    const { model: m } = await loadModelText(bigBind(5));
    const rows = obligationsOf(m!, { maxInstanceGoals: 3 }).filter((o) =>
      o.element.qualifiedName.startsWith('Big::P::c '),
    );
    const byGroup = new Map<string, Array<{ path: string | undefined; encodable: unknown }>>();
    for (const o of rows) {
      const key = o.instance?.contextId ?? o.element.id;
      const list = byGroup.get(key) ?? [];
      list.push({ path: o.instance?.path, encodable: o.encodable });
      byGroup.set(key, list);
    }
    expect(byGroup.size, 'one group per Qk usage').toBe(5);
    const filed: string[] = [];
    const refused: string[] = [];
    for (const [key, list] of byGroup) {
      const instances = list.filter((r) => r.path !== undefined);
      if (instances.length > 0) {
        // Filed per instance: the generic row AND every instance row, all encodable.
        expect(list).toHaveLength(2);
        expect(list.filter((r) => r.path === undefined)).toHaveLength(1);
        expect(list.every((r) => r.encodable === true)).toBe(true);
        filed.push(key);
      } else {
        // Refused whole: ONE generic row carrying the budget sentence.
        expect(list).toHaveLength(1);
        expect(list[0].encodable).toMatchObject({ reason: 'unread-definition' });
        expect((list[0].encodable as { detail: string }).detail).toMatch(/exceed this run's 3/);
        refused.push(key);
      }
    }
    // Two rows per group and a budget of 3 carries exactly the first group.
    expect([filed.length, refused.length]).toEqual([1, 4]);
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

/* ═══════════════ F8 — a default standing in one instance (H2) ═══════════════ */

/**
 * A `default` a binding holds per FEATURE gives way where the bindings joined
 * to it reach a value of its own. In an instance whose own component states
 * none, and whose every default is a literal agreeing exactly, it STANDS
 * (plan A.4 Part 2, F8): `w2`'s `q2 : Q` leaves `L` unset, so `q2.p.load` is
 * P's 5.0 and `q2.p.m2` is 5.0, while `q1` sets `L` to 50.
 */
describe('solve — a default a binding holds per feature stands in the instance that leaves it unset (F8)', () => {
  const W2 = `package W2 {
    part def P { attribute load : ScalarValues::Real default = 5.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part def Q { attribute L : ScalarValues::Real; part p : P; bind p.load = L; }
    part q1 : Q { attribute :>> L = 50.0; }
    part q2 : Q;
    constraint c1 { q1.p.m2 <= 0.0 }
    constraint c2 { q2.p.m2 >= 0.0 }
    constraint c3 { q2.p.m2 <= 2.0 }
  }`;

  it('names P’s default as standing in q2 and no value in q1', async () => {
    const { model: m } = await loadModelText(W2);
    expect(defaultStandsIn(m!, 'W2::q2::p::load')?.declaredName).toBe('load');
    expect(defaultStandsIn(m!, 'W2::q2::p::load')?.attrs.value).toBe(5);
    expect(defaultStandsIn(m!, 'W2::q1::p::load')).toBeUndefined();
  });

  it('decides the relation at 5.0 in q2 and −40 in q1, on the check and the numeric surface', async () => {
    const { model: m } = await loadModelText(W2);
    const check = (n: string) => checkConstraints(m!).find((c) => m!.qualifiedName(c.id) === `W2::${n}`)!;
    expect([check('c1').result, check('c2').result, check('c3').result]).toEqual(['satisfied', 'satisfied', 'violated']);
    expect(check('c2').reads?.map((r) => [r.path, r.value])).toEqual([['q2.p.m2', 5]]);
    const numeric = (n: string) => checkConstraintsNumeric(m!).find((r) => m!.qualifiedName(r.id) === `W2::${n}`)!;
    expect([numeric('c1').result, numeric('c2').result, numeric('c3').result]).toEqual(['satisfied', 'satisfied', 'violated']);
  });

  it('files the instance literal equation the solver and the SMT lane read (F8)', async () => {
    const { model: m } = await loadModelText(W2);
    const load = obligationsOf(m!).find((o) => o.element.qualifiedName === 'W2::Q::p::load in W2::q2::p');
    expect(load?.expression).toBe('load == 5');
    expect(load?.role).toBe('axiom');
    // q1's L is 50: no standing-default row, the binding carries the value.
    expect(obligationsOf(m!).find((o) => o.element.qualifiedName === 'W2::Q::p::load in W2::q1::p')).toBeUndefined();
  });
});

/**
 * A binding read in fewer contexts than it holds in — 32 usages deep, or with
 * an end that has no instance where it holds — holds its ends' defaults
 * wherever they are read, and the check reads no value for them. The numeric
 * lane read such a value as a design freedom: a plain check fixed it, and the
 * others were judged at that invented point (the review of O2 S3: CAPU4, and
 * R's nested Q used outside any R). It is a value the model has and this tool
 * does not read, unless the bindings carry it from a stated one (Y, from X's
 * 50 through T1's binding at the chain's end).
 */
describe('solve — a value a binding past a cap holds is no design freedom', () => {
  const as = (n: number) => Array.from({ length: n }, () => 'a').join('.');
  const CAPU4 = [
    'package CAPU4 {',
    '  part def T0 { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }',
    '  part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; bind a.load = L; }',
    ...Array.from({ length: 32 }, (_, i) => `  part def T${i + 2} { part a : T${i + 1}; }`),
    '  part top : T33;',
    '  attribute X : ScalarValues::Real = 50.0;',
    `  bind top.${as(32)}.L = X;`,
    '  attribute Y : ScalarValues::Real default = 1.0;',
    `  bind Y = top.${as(33)}.load;`,
    '  part s : T1;',
    '  constraint c1 { s.a.load == 9.0 }',
    '  constraint c2 { s.a.load <= 5.0 }',
    '  constraint c3 { s.L <= 5.0 }',
    '  constraint yT { Y >= 40.0 }',
    `  constraint negT { top.${as(33)}.m2 <= 0.0 }`,
    '}',
  ].join('\n');

  it('leaves a shallow instance of the capped binding unjudged, and solves what X carries', async () => {
    const { model: m } = await loadModelText(CAPU4);
    const numeric = checkConstraintsNumeric(m!);
    const row = (n: string) => numeric.find((r) => m!.qualifiedName(r.id) === `CAPU4::${n}`)!;
    expect(['c1', 'c2', 'c3', 'yT', 'negT'].map((n) => row(n).result)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'satisfied',
      'satisfied',
    ]);
    expect(row('c1').imposed).toBeUndefined();
    expect(row('c1').reason).toBe('load is not read in CAPU4::s::a: a binding of this model is read deeper than 32 usages');
    // T1's own L is held past the cap, not left free.
    const free = solve(m!).free.map((id) => m!.qualifiedName(id.split('@')[0]!));
    expect(free).not.toContain('CAPU4::T1::L');
  });

  it('reports a model with a capped binding as not converged, and its rows name the cap', async () => {
    // Fail closed: the values held past the cap are not read, so the solve counts them undetermined and says
    // `did not converge`; the rows over them say why. The user guide says so beside the cap.
    const { model: m } = await loadModelText(CAPU4);
    const report = solve(m!);
    expect(report.converged).toBe(false);
    const numeric = checkConstraintsNumeric(m!);
    const row = numeric.find((r) => m!.qualifiedName(r.id) === 'CAPU4::c1')!;
    expect(row.reason).toContain('deeper than 32 usages');
  });

  it('leaves an instance whose binding has an end outside it unjudged (R’s nested Q)', async () => {
    const { model: m } = await loadModelText(`package XO2 {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
      part def R {
        attribute L : ScalarValues::Real default = 1.0;
        part def Q { part p : P; bind p.load = L; }
        part q : Q;
      }
      part def S { part z : R::Q; }
      part s : S;
      part r2 : R;
      constraint c3 { r2.q.p.load == 9.0 }
      constraint c5 { r2.q.p.m2 >= 5.0 }
      constraint c6 { r2.L >= 5.0 }
    }`);
    const numeric = checkConstraintsNumeric(m!);
    const row = (n: string) => numeric.find((r) => m!.qualifiedName(r.id) === `XO2::${n}`)!;
    // r2's load is R's default of 1, so c3 and c6 are false and c5 true: read as free, c3 was imposed and c5
    // refuted, and the feasibility search met c6 by moving r2's L, which only c6 reads.
    expect([row('c3').result, row('c5').result, row('c6').result]).toEqual(['unknown', 'unknown', 'unknown']);
    expect(row('c3').imposed).toBeUndefined();
    // Each says what is not read, and why — on the check and here alike. R's L states `default = 1.0`: it was
    // "declared without one" on both (the branch review of O2).
    const outside =
      'is held by a binding that joins a feature outside where it is written, which this tool finds no instance of in a ' +
      'context the binding holds in, so no value the binding gives it is read for any one instance';
    expect(row('c6').reason).toBe(`r2.L has no value: R::L ${outside}`);
    expect(row('c3').reason).toBe(`r2.q.p.load has no value: p::load ${outside}`);
    const check = checkConstraints(m!).find((c) => m!.qualifiedName(c.id) === 'XO2::c6')!;
    expect(check.message).toBe(`Could not evaluate: ${row('c6').reason}`);
    const feasibility = solveFeasible(m!);
    expect([feasibility.decided, feasibility.free]).toEqual([false, []]);
  });
});

/* ───────── the order of the text decides no design equation (text-order S1) ───────── */

/**
 * The numeric solve took the first plain equality over a valueless feature, in TEXT order, as its design equation
 * and judged every other at the point it fixed — beside an assert it reads no equation from (`L == 50.0 and L >=
 * 0.0`), a false F one way round and a false T on a check beside it. Each model here is read in both orders.
 */
describe('solve — the order of the text decides no design equation', () => {
  /** The numeric rows of `text`, by declared name: result, imposed, reason. */
  async function rows(text: string): Promise<Map<string, { result: string; imposed?: true; reason?: string }>> {
    const { model: m } = await loadModelText(text);
    return new Map(checkConstraintsNumeric(m!).map((r) => [r.name, { result: r.result, imposed: r.imposed, reason: r.reason }]));
  }

  it('takes no plain constraint as a design equation over a feature an assert holds in a form it does not read', async () => {
    const P = 'part def P { attribute L : ScalarValues::Real; assert constraint ca { L == 50.0 and L >= 0.0 } }';
    for (const text of [
      `package X3K { ${P} part p : P; constraint t1 { p.L == 1.0 } constraint k { p.L <= 10.0 } }`,
      `package X3K { constraint k { p.L <= 10.0 } constraint t1 { p.L == 1.0 } part p : P; ${P} }`,
    ]) {
      const r = await rows(text);
      // t1 fixed p's L at 1, and k read satisfied where the assert makes L 50.
      expect([r.get('t1')!.result, r.get('k')!.result, r.get('t1')!.imposed]).toEqual(['unknown', 'unknown', undefined]);
      expect(r.get('k')!.reason).toBe(
        'X3K::p::L has no value, and an assert constrains it in a form the numeric solve does not read (ca, a ' +
          'conjunction), so it is no design freedom: no plain constraint is solved for it, and this relation is not judged',
      );
      const { model: m } = await loadModelText(text);
      expect([...solve(m!).values.keys()].map((id) => id.split('@')[1])).not.toContain('X3K::p::L');
    }
  });

  it('reads the freedom off the model’s own equations alone, never off a check it may not take', async () => {
    // P's asserted `M == L * 2.0` carries what `L >= 0.0 and L <= 1.0` holds to M: `tM` may not fix M at 100 (and L
    // at 50), and the freedom L and M keep is no point to judge `k { p.L <= 0.5 }` at.
    const r = await rows(`package LK {
      part def P { attribute L : ScalarValues::Real; attribute M : ScalarValues::Real;
        assert constraint ca { L >= 0.0 and L <= 1.0 } assert constraint d { M == L * 2.0 } }
      part p : P;
      constraint tM { p.M == 100.0 }
      constraint k { p.L <= 0.5 }
    }`);
    expect([r.get('tM')!.result, r.get('tM')!.imposed, r.get('k')!.result]).toEqual(['unknown', undefined, 'unknown']);
    expect(r.get('k')!.reason).toContain('LK::p::L is left free by the equations');
  });

  it('leaves a value plain constraints that disagree give unread, whichever is written first', async () => {
    for (const text of [
      'package PL2 { attribute x : ScalarValues::Real; attribute y : ScalarValues::Real; constraint a { x == 3.0 } constraint b { x == y } constraint c { y == 5.0 } }',
      'package PL2 { constraint c { y == 5.0 } constraint b { x == y } constraint a { x == 3.0 } attribute y : ScalarValues::Real; attribute x : ScalarValues::Real; }',
    ]) {
      const r = await rows(text);
      // Written in this order, a was imposed and c refuted; the other way round c imposed and a refuted.
      expect(['a', 'b', 'c'].map((n) => [r.get(n)!.result, r.get(n)!.imposed])).toEqual([
        ['unknown', undefined],
        ['unknown', undefined],
        ['unknown', undefined],
      ]);
      expect(r.get('a')!.reason).toBe(
        'no value the model states fixes x, only plain constraints that disagree (a, b and c): which of them holds ' +
          'would turn on the one the solve took first as its design equation, so none does, and this relation is not judged',
      );
      const { model: m } = await loadModelText(text);
      expect(solve(m!).values.size).toBe(0);
      expect(solveFeasible(m!).decided).toBe(false);
    }
  });

  it('reads two plain equations that agree as design equations both, whichever is written first', async () => {
    for (const text of [
      'package DUP { attribute x : ScalarValues::Real; constraint a { x == 3.0 } constraint b { x == 3.0 } constraint k { x <= 5.0 } }',
      'package DUP { constraint k { x <= 5.0 } constraint b { x == 3.0 } constraint a { x == 3.0 } attribute x : ScalarValues::Real; }',
    ]) {
      const r = await rows(text);
      expect(['a', 'b', 'k'].map((n) => [r.get(n)!.result, r.get(n)!.imposed])).toEqual([
        ['satisfied', true],
        ['satisfied', true],
        ['satisfied', undefined],
      ]);
    }
  });

  it('orients the model’s own equations before a check: a requirement written above a value expression is judged', async () => {
    const P =
      'part def P { attribute a : ScalarValues::Real = 0.3; attribute b : ScalarValues::Real = 10000000000000000.0; attribute d : ScalarValues::Real = a * b; }';
    const R = 'requirement def R { subject s : P; require constraint { s.d == 3000000000000000.0 } }';
    for (const text of [`package Z125 { ${P} part p : P; ${R} satisfy R by p; }`, `package Z125 { satisfy R by p; ${R} part p : P; ${P} }`]) {
      const { model: m } = await loadModelText(text);
      const row = checkConstraintsNumeric(m!).find((x) => x.raw.includes('s.d'))!;
      // Written above `d = a * b`, the requirement fixed d itself: imposed by the solve.
      expect([row.result, row.imposed]).toEqual(['satisfied', undefined]);
    }
  });

  it('judges a plain constraint over a value an asserted equation fixes, whichever is written first, beside one the solve takes', async () => {
    // `s { x + y == 10.0 }` is asserted and does not `define` x, but y is stated: x is 6 whatever the checks do. `d` is
    // violated at it, and `b { w == x + 1.0 }` is the design equation for w. The checks that disagree are not b and d.
    const S = 'assert constraint s { x + y == 10.0 }';
    const D = 'attribute y : ScalarValues::Real = 4.0; attribute x : ScalarValues::Real; attribute w : ScalarValues::Real;';
    for (const text of [
      `package K1 { ${D} ${S} constraint b { w == x + 1.0 } constraint d { x == 9.0 } constraint c { x == 6.0 } }`,
      `package K1 { constraint c { x == 6.0 } constraint d { x == 9.0 } constraint b { w == x + 1.0 } ${S} ${D} }`,
    ]) {
      const r = await rows(text);
      expect(['s', 'b', 'd', 'c'].map((n) => [r.get(n)!.result, r.get(n)!.imposed])).toEqual([
        ['satisfied', undefined],
        ['satisfied', true],
        ['violated', undefined],
        ['satisfied', undefined],
      ]);
      const { model: m } = await loadModelText(text);
      const x = [...solve(m!).values].find(([id]) => m!.qualifiedName(id) === 'K1::x');
      expect(x?.[1]).toBeCloseTo(6, 6);
    }
  });

  it('keeps a value an asserted equation derives from a design value in the design component, in either order', async () => {
    // y comes only from the plain `a` and `b`, which disagree; x = 10 − y is the asserted equation's, moves with it, and
    // is no value to publish or judge `e { x == 3.0 }` at.
    for (const text of [
      'package K3 { attribute x : ScalarValues::Real; attribute y : ScalarValues::Real; assert constraint s { x + y == 10.0 } constraint a { y == 7.0 } constraint b { y == 8.0 } constraint e { x == 3.0 } }',
      'package K3 { constraint b { y == 8.0 } constraint a { y == 7.0 } constraint e { x == 3.0 } assert constraint s { x + y == 10.0 } attribute y : ScalarValues::Real; attribute x : ScalarValues::Real; }',
    ]) {
      const r = await rows(text);
      expect(['s', 'a', 'b', 'e'].map((n) => [r.get(n)!.result, r.get(n)!.imposed])).toEqual(Array(4).fill(['unknown', undefined]));
      expect(r.get('a')!.reason).toContain('only plain constraints that disagree (a, b and e)');
      const { model: m } = await loadModelText(text);
      expect(solve(m!).values.size).toBe(0);
    }
  });

  it('gives the same reason in either order: the facts are read after each check, before the next', async () => {
    // The asserted `f { y == x * 2.0 }` reads y once c1 fixed it: in text order c1, c2 the check c2 took x first, and the
    // solve stopped off f ("did not converge"); c2, c1 it stopped on the checks that disagree.
    const F = 'attribute x : ScalarValues::Real; attribute y : ScalarValues::Real; assert constraint f { y == x * 2.0 }';
    const reasons = new Set<string>();
    for (const text of [
      `package B1 { ${F} constraint c1 { y == 7.0 } constraint c2 { x + y == 10.0 } }`,
      `package B1 { ${F} constraint c2 { x + y == 10.0 } constraint c1 { y == 7.0 } }`,
      `package B1 { constraint c2 { x + y == 10.0 } constraint c1 { y == 7.0 } ${F} }`,
    ]) {
      const r = await rows(text);
      for (const n of ['c1', 'c2']) {
        expect(r.get(n)!.result).toBe('unknown');
        reasons.add(`${n}: ${r.get(n)!.reason}`);
      }
    }
    expect([...reasons].sort()).toEqual([
      expect.stringContaining('c1: no value the model states fixes y, only plain constraints that disagree (c1 and c2)'),
      expect.stringContaining('c2: no value the model states fixes x and y, only plain constraints that disagree (c1 and c2)'),
    ]);
  });

  it('names an assert with no name of its own by what it is, never by the usage’s qualified name', async () => {
    const r = await rows(`package G2 {
      part def P { attribute L : ScalarValues::Real; assert constraint { L >= 0.0 } assert constraint { L <= 9.0 } }
      part p : P;
      constraint t2 { p.L == 20.0 }
    }`);
    const reason = r.get('t2')!.reason!;
    expect(reason).toContain('asserts constrain it in a form the numeric solve does not read (2 unnamed asserts, an inequality)');
    expect(reason).not.toContain('«');
  });

  it('still imposes a lone plain equation, and leaves a feature only asserted inequalities touch a design freedom', async () => {
    const r = await rows('package ONE { attribute x : ScalarValues::Real; constraint a { x == 3.0 } constraint k { x <= 5.0 } }');
    expect([r.get('a')!.imposed, r.get('k')!.result]).toEqual([true, 'satisfied']);
    // The model's own equations (`e = x * 2.0`) still solve x as a freedom: no value, free, every relation over it unjudged.
    const text = 'package Q3 { part def P { attribute x : ScalarValues::Real; attribute e = x * 2.0; assert constraint lo { x >= 0.0 } } }';
    const { model: m } = await loadModelText(text);
    const s = solve(m!);
    expect([s.converged, s.free.map((id) => m!.qualifiedName(id)).sort()]).toEqual([true, ['Q3::P::e', 'Q3::P::x']]);
    expect((await rows(text)).get('lo')!.reason).toContain('is left free by the equations');
  });
});

/* ───────── a probe sets the keys it moves and puts them back (UI-ROADMAP P2) ───────── */

describe('solve — a finite-difference probe leaves the working map as it found it (P2)', () => {
  /** Run `fn`, counting the `new Map(<Map>)` copies it makes. */
  function copies<T>(fn: () => T): { out: T; copies: number } {
    const Native = Map;
    let n = 0;
    class Counting<K, V> extends Native<K, V> {
      constructor(init?: Iterable<readonly [K, V]> | null) {
        super(init);
        if (init instanceof Native) n++;
      }
      static [Symbol.hasInstance](x: unknown): boolean {
        return x instanceof Native;
      }
    }
    (globalThis as { Map: unknown }).Map = Counting;
    try {
      return { out: fn(), copies: n };
    } finally {
      (globalThis as { Map: unknown }).Map = Native;
    }
  }
  const implicit = (...exprs: string[]) => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Implicit');
    const vars = ['a', 'b'].slice(0, exprs.length > 1 ? 2 : 1).map((n) => f.attribute(n, p.id, { type: 'Real' }));
    for (const expression of exprs) m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression } });
    return { m, vars };
  };
  /** A depth-3 tree of instances over free leaves; `top` is held to `rhs`. */
  const tree = (rhs: string) =>
    parseModel(
      [
        'package PT {',
        '  part def N0 { attribute x : Real; attribute s : Real = x; }',
        ...[1, 2, 3].map((i) => `  part def N${i} { part a : N${i - 1}; part b : N${i - 1}; attribute s : Real = a.s + b.s; }`),
        '  part top : N3;',
        `  constraint sum { top.s == ${rhs} }`,
        '}',
      ].join('\n'),
    ).model;

  it('solves a scalar root and a coupled system with a few copies, not one per probe', () => {
    const scalar = implicit('a * a = 9');
    const sol = copies(() => solve(scalar.m));
    expect(Math.abs(sol.out.values.get(scalar.vars[0]!.id)!)).toBeCloseTo(3, 4);

    const coupled = implicit('a * b = 12', 'a + b = 7');
    const co = copies(() => solve(coupled.m));
    const [a, b] = coupled.vars.map((v) => co.out.values.get(v.id)!);
    expect(co.out.converged).toBe(true);
    expect([a! + b!, a! * b!]).toEqual([expect.closeTo(7, 6), expect.closeTo(12, 6)]);

    // Before the fix: 17 and 39 (a copy at every probe of the root-find and of the Jacobian).
    expect([sol.copies, co.copies].map((n) => n <= 6)).toEqual([true, true]);
  });

  it('solves an instance tree with the copies a satisfied one takes, however many probes it needs', () => {
    // `top.s == a.s + b.s` already holds, so the Newton step probes twice;
    // `top.s == 12.0` moves the leaves, so it probes the Jacobian as well.
    const held = copies(() => solve(tree('top.a.s + top.b.s')));
    const moved = copies(() => solve(tree('12.0')));
    expect([held.out.converged, moved.out.converged]).toEqual([true, true]);
    expect(moved.copies).toBeLessThanOrEqual(held.copies);
  });

  it('leaves no unknown behind at the value of its last probe', () => {
    // The asserted loop is probed at many points. `z` is read by the check
    // `mass + z == 130.0` alone, so nothing drives it: a probe that kept its
    // guess left z = 1 in the map, and the check, which fixes z at 5, read
    // violated by 4 (p16).
    const m = parseModel(
      [
        'package PL {',
        '  attribute dry = 100.0;',
        '  attribute mass;',
        '  attribute fuel;',
        '  attribute z;',
        '  assert constraint dm { mass == dry + fuel }',
        '  assert constraint df { fuel == mass * 0.2 }',
        '  constraint fixz { mass + z == 130.0 }',
        '}',
      ].join('\n'),
    ).model;
    const zId = [...m.all()].find((e) => e.declaredName === 'z')!.id;
    const res = solve(m);
    expect(res.converged).toBe(true);
    expect(res.values.get(zId)).toBeCloseTo(5, 9);
    expect(checkConstraintsNumeric(m).find((r) => r.name === 'fixz')!.result).toBe('satisfied');
  });

  it('leaves the unknown of a root-find that found no root unset', () => {
    // `z·z + 1 = 0` has no real root: the scalar root-find fails after probing
    // z at many points, and z must not stay at the last of them.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('NoRoot');
    const z = f.attribute('z', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'z * z + 1 = 0' } });
    const res = solve(m);
    expect(res.converged).toBe(false);
    expect(res.values.has(z.id)).toBe(false);
  });

  it('gives the same values on a second solve', () => {
    const { m, vars } = implicit('a * b = 12', 'a + b = 7');
    const fixed = new Map([[vars[0]!.id, 3]]);
    const first = solve(m, { fixed });
    const again = solve(m, { fixed, tol: 1e-10 });
    expect(first.values.get(vars[1]!.id)).toBeCloseTo(4, 6);
    expect([...again.values].map(([k, v]) => [k, Math.round(v * 1e6)])).toEqual(
      [...first.values].map(([k, v]) => [k, Math.round(v * 1e6)]),
    );
    expect(first.free).toEqual(again.free);
  });
});

import { describe, it, expect, vi } from 'vitest';
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
import { defaultStandsIn, instanceIndexSeam } from '../../src/semantics/defining-equation';

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
    // Asserted: the model's own equations. Plain, the pair has two roots (a product beside a sum) and no value is read.
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x + y = 0.03', requirementRole: 'assert' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x * y = 0.0002', requirementRole: 'assert' } });

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

/*
 * text-order S2: a measure two asserted equations give two values has none. `evaluateFeatureValue` returns the
 * first equation written, so `totalMeasure` read 100 where the text wrote `lengthMeasure == 50.0` first and 120
 * where it wrote `== 60.0` first (the soft/hard analysis' `reconcile/n-ab.sysml`, `n-ba.sysml`).
 */
describe('evaluateMoEs — a measure two asserted equations give two values', () => {
  const AB = 'assert constraint c50 { lengthMeasure == 50.0 } assert constraint c60 { lengthMeasure == 60.0 }';
  const BA = 'assert constraint c60 { lengthMeasure == 60.0 } assert constraint c50 { lengthMeasure == 50.0 }';
  const measures = (eqs: string) => {
    const { model: m, diagnostics } = parseModel(`package MC {
      part def P {
        attribute lengthMeasure : ScalarValues::Real;
        attribute totalMeasure : ScalarValues::Real;
        attribute rateMeasure : ScalarValues::Real = 3.0;
        attribute otherMeasure : ScalarValues::Real;
        ${eqs}
        assert constraint ct { totalMeasure == 2.0 * lengthMeasure }
        assert constraint co { otherMeasure == 5.0 }
      }
    }`);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    return Object.fromEntries(evaluateMoEs(m).map((x) => [x.name, x.value]));
  };

  it('has no value, nor has one tied to it, in either order', () => {
    for (const eqs of [AB, BA]) {
      expect(measures(eqs)).toEqual({ lengthMeasure: null, totalMeasure: null, rateMeasure: 3, otherMeasure: 5 });
    }
  });

  it('reads a written measure and no derived one where the listing of the equations threw', () => {
    vi.spyOn(instanceIndexSeam, 'contradictedDefinitions').mockImplementation(() => {
      throw new RangeError('contradictedDefinitions, planted to throw');
    });
    try {
      // Which measures the pair reaches is unknown: each an equation gives its value is read as one with none.
      expect(measures(AB)).toEqual({ lengthMeasure: null, totalMeasure: null, rateMeasure: 3, otherMeasure: null });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('still reads a measure from one equation, or from equations that agree', () => {
    expect(measures('assert constraint c50 { lengthMeasure == 50.0 }')).toMatchObject({ lengthMeasure: 50, totalMeasure: 100 });
    expect(
      measures('assert constraint c50 { lengthMeasure == 50.0 } assert constraint c25 { lengthMeasure == 25.0 * 2.0 }'),
    ).toMatchObject({ lengthMeasure: 50, totalMeasure: 100 });
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

  it('leaves the root of a curved plain equation unread beside another plain equation, whichever is written first', async () => {
    // `x * x == 4.0` has two roots: written above `x == -2.0` the solve took 2 and left both unjudged, below it took −2 and
    // imposed both (neither refuted, but the text order showed). The pair is contested in both orders, with one sentence.
    const SAME =
      'no value the model states fixes x, only plain constraints, one of them that may have more than one root (a and b): which root ' +
      'the solve took, and so whether the others hold, would turn on which constraint it took first as its design equation, ' +
      'so none does, and this relation is not judged';
    for (const [a, b] of [['x * x == 4.0', 'x == -2.0'], ['x * x == 4.0', 'x == 2.0'], ['x * x == 4.0', 'x == 5.0']] as const) {
      for (const text of [
        `package ROOT { attribute x : ScalarValues::Real; constraint a { ${a} } constraint b { ${b} } }`,
        `package ROOT { constraint b { ${b} } constraint a { ${a} } attribute x : ScalarValues::Real; }`,
      ]) {
        const r = await rows(text);
        expect(['a', 'b'].map((n) => [r.get(n)!.result, r.get(n)!.imposed, r.get(n)!.reason]), text).toEqual([
          ['unknown', undefined, SAME],
          ['unknown', undefined, SAME],
        ]);
        const { model: m } = await loadModelText(text);
        expect(solve(m!).values.size).toBe(0);
      }
    }
  });

  it('still imposes a curved plain equation alone, and a product of two unknowns once the others are fixed', async () => {
    const lone = await rows('package SG { attribute x : ScalarValues::Real; constraint a { x * x == 4.0 } }');
    expect([lone.get('a')!.result, lone.get('a')!.imposed]).toEqual(['satisfied', true]);
    // `mass == density * volume` is affine in the one it is solved for once the others are fixed: c4 is judged beside it.
    const D = 'attribute mass : ScalarValues::Real; attribute volume : ScalarValues::Real; attribute density : ScalarValues::Real;';
    const C = ['constraint c1 { mass == density * volume }', 'constraint c2 { volume == 2.0 }', 'constraint c3 { density == 5.0 }', 'constraint c4 { mass == 10.0 }'];
    for (const text of [`package MVD { ${C.join(' ')} ${D} }`, `package MVD { ${[...C].reverse().join(' ')} ${D} }`]) {
      const r = await rows(text);
      expect(['c1', 'c2', 'c3', 'c4'].map((n) => [r.get(n)!.result, r.get(n)!.imposed])).toEqual(Array(4).fill(['satisfied', true]));
    }
  });

  /** Every order of `members`, as the text of a package over `decl` (declarations of its features). */
  const inEveryOrder = (decl: string, members: readonly string[]): string[] => {
    const out: string[] = [];
    const go = (rest: readonly string[], acc: readonly string[]): void => {
      if (rest.length === 0) out.push(`package K { ${decl} ${acc.join(' ')} }`);
      for (let i = 0; i < rest.length; i++) go([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]!]);
    };
    go(members, []);
    return out;
  };
  const X = 'attribute x : ScalarValues::Real; attribute y : ScalarValues::Real; attribute z : ScalarValues::Real;';

  it('withholds a curved system that leaves no plain constraint unused, and the inequality over it, in every order', async () => {
    // `c0 { x * x == 4.0 }`, `c1 { y == x + 1.0 }` and `c2 { y <= 0.0 }` are all met by (−2, −1), and the root the solve found, (2, 3),
    // broke c2: F on a model that is consistent. A product system (`x * y == 4.0` beside `x == y`) has the two roots (2, 2) and (−2, −2).
    const roots = 'only plain constraints, one of them that may have more than one root (c0 and c1)';
    for (const members of [
      ['constraint c0 { x * x == 4.0 }', 'constraint c1 { y == x + 1.0 }', 'constraint c2 { y <= 0.0 }'],
      ['constraint c0 { x * y == 4.0 }', 'constraint c1 { x == y }', 'constraint c2 { x <= 0.0 }'],
    ]) {
      for (const text of inEveryOrder(X, members)) {
        const r = await rows(text);
        expect(['c0', 'c1', 'c2'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual(Array(3).fill(['unknown', undefined]));
        expect(r.get('c2')!.reason, text).toContain(roots);
        const { model: m } = await loadModelText(text);
        expect(solve(m!).values.size, text).toBe(0);
      }
    }
  });

  it('takes the second root a model equation gives into the rule, in every order', async () => {
    // A stated `s = x * x`, or an asserted `s == x * x`, beside `c0 { s == 4.0 }` and `c1 { x == -2.0 }`: these agree at x = −2, yet written
    // c0 first the solve took the root 2 and said they disagree, and c1 first it imposed both.
    const WS = 'attribute x : ScalarValues::Real; attribute s : ScalarValues::Real = x * x;';
    const YS = 'attribute x : ScalarValues::Real; attribute s : ScalarValues::Real; assert constraint d { s == x * x }';
    for (const [decl, text] of [
      [WS, '`s = x * x`'],
      [YS, 'd'],
    ] as const) {
      for (const t of inEveryOrder(decl, ['constraint c0 { s == 4.0 }', 'constraint c1 { x == -2.0 }'])) {
        const r = await rows(t);
        expect(['c0', 'c1'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), t).toEqual(Array(2).fill(['unknown', undefined]));
        expect(r.get('c0')!.reason, t).toContain(`and the equations over it may leave more than one root (${text})`);
        expect(r.get('c0')!.reason, t).not.toContain('disagree');
      }
    }
    // And an asserted curved equation fixes no value a plain constraint beside it is judged at: `b { x == -2.0 }` was violated at the 2.
    for (const t of inEveryOrder('attribute x : ScalarValues::Real; assert constraint a { x * x == 4.0 }', ['constraint b { x == -2.0 }', 'constraint k { x <= 0.0 }'])) {
      const r = await rows(t);
      expect(['b', 'k'].map((n) => r.get(n)!.result), t).toEqual(['unknown', 'unknown']);
    }
  });

  it('reaches a curved plain equation through the equations that link it, a product and a feature left free included', async () => {
    // `z * z == y` beside `z == x * y`: the root the solve found makes z and y free, and the pair of plain constraints on x
    // that disagree was read apart from it — c2 imposed one way round, withheld the other.
    const members = ['constraint c0 { x == -2.0 }', 'constraint c1 { z == x * y }', 'constraint c2 { z * z == y }', 'constraint c3 { x == 5.0 }'];
    for (const text of inEveryOrder(X, members)) {
      const r = await rows(text);
      expect(['c0', 'c1', 'c2', 'c3'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual(Array(4).fill(['unknown', undefined]));
    }
  });

  it('frees the same features in every order: the elimination takes its rows by their features, not the text’s order', async () => {
    // `x * y == z` above `x == 1.0` and `x == 3.0` freed x (c0 and c1 imposed); below them it did not.
    const members = ['constraint c0 { x * y == z }', 'constraint c1 { x == 1.0 }', 'constraint c2 { x == 3.0 }', 'constraint c3 { x >= 1.5 }'];
    for (const text of inEveryOrder(X, members)) {
      const r = await rows(text);
      expect(['c0', 'c1', 'c2', 'c3'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual(Array(4).fill(['unknown', undefined]));
    }
  });

  it('does not judge an inequality over the lone root of a curved plain equation, in either order', async () => {
    // `x * x == 4.0` is imposed at 2, and `k { x <= 0.0 }` read violated there, where −2 meets both.
    for (const members of [
      ['constraint a { x * x == 4.0 }', 'constraint k { x <= 0.0 }'],
      ['constraint k { x <= 0.0 }', 'constraint a { x * x == 4.0 }'],
      ['constraint a { x * x == 4.0 }', 'constraint k { x >= 0.0 }'],
    ]) {
      const text = `package SG { ${X} ${members.join(' ')} }`;
      const r = await rows(text);
      expect([r.get('a')!.result, r.get('a')!.imposed, r.get('k')!.result]).toEqual(['satisfied', true, 'unknown']);
      // Nor is the model infeasible: held at 2, `x <= 0.0` broke, where −2 meets both. The root is a freedom to the search.
      if (members.some((n) => n.includes('x <= 0.0'))) {
        const { model: m } = await loadModelText(text);
        expect(solveFeasible(m!).decided).toBe(false);
      }
      expect(r.get('k')!.reason).toBe(
        'no value the model states fixes x, and the equations over it may leave more than one root (a): which root the solve took is ' +
          'no value the model states, and whether this relation holds turns on it, so none is read, and this relation is not judged',
      );
    }
  });

  it('finds the witness beside a curved plain equation in either order, from where the other equations put the value', async () => {
    // `c0 { x * x == 4.0 }` above `c1 { x == -2.0 }`: the root the solve took, 2, stalled the descent beside c1 (decided: false), and
    // written the other way round the solve took −2 and the descent met both (decided: true). The descent now begins a second time
    // from where the equations that are not curved put the value, the same point in either order.
    const witness = async (text: string) => {
      const { model: m } = await loadModelText(text);
      const f = solveFeasible(m!);
      const at = (n: string) => f.values.get(m!.all().find((el) => el.declaredName === n)!.id);
      return { decided: f.decided, feasible: f.feasible, x: at('x'), y: at('y') };
    };
    for (const text of inEveryOrder(X, ['constraint c0 { x * x == 4.0 }', 'constraint c1 { x == -2.0 }'])) {
      const w = await witness(text);
      expect([w.decided, w.feasible], text).toEqual([true, true]);
      expect(w.x, text).toBeCloseTo(-2, 6);
    }
    // Through a second equation that links them: (−2, −1) meets all four.
    const linked = ['constraint c0 { x * x == 4.0 }', 'constraint c1 { x == -2.0 }', 'constraint c2 { y == x + 1.0 }', 'constraint c3 { y <= 0.0 }'];
    for (const text of inEveryOrder(X, linked)) {
      const w = await witness(text);
      expect([w.decided, w.feasible], text).toEqual([true, true]);
      expect([w.x, w.y].map((v) => Math.round(v! * 1e6) / 1e6), text).toEqual([-2, -1]);
    }
    // A model that has no such point stays undecided in both orders, never feasible: the second start claims nothing the gates do not.
    for (const members of [
      ['constraint c0 { x * x == 4.0 }', 'constraint c1 { x == 3.0 }'],
      ['constraint c0 { x * x == 4.0 }', 'constraint c1 { x == -2.0 }', 'constraint c2 { x >= 0.0 }'],
    ]) {
      for (const text of inEveryOrder(X, members)) {
        const w = await witness(text);
        expect([w.decided, w.feasible], text).toEqual([false, false]);
      }
    }
  });

  it('reads a curve of solutions as a freedom, not as two roots', async () => {
    // `z == x * y` beside `z == 9.0` leaves x and y free along the hyperbola: nothing to take a root of, and z is imposed.
    for (const text of inEveryOrder(X, ['constraint c0 { z == x * y }', 'constraint c1 { z == 9.0 }'])) {
      const r = await rows(text);
      expect(['c0', 'c1'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual(Array(2).fill(['satisfied', true]));
    }
  });

  it('still decides what the other equations fix one at a time, beside a curved one', async () => {
    // `z == x * x` over `x == 3.0` is affine in the z it fixes: one root, whatever the order.
    for (const text of inEveryOrder(X, ['constraint e { z == x * x }', 'constraint c { x == 3.0 }', 'constraint k { z <= 5.0 }'])) {
      const r = await rows(text);
      expect(['e', 'c', 'k'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual([
        ['satisfied', true],
        ['satisfied', true],
        ['violated', undefined],
      ]);
    }
  });

  it('withholds what a loop of definitions has more than one root of, in every order', async () => {
    // `x == y * y + 1.0` beside `y == 3.0 - x` has the two roots (2, 1) and (5, −2): the definitions close it, the solve found one, and
    // `e { x == 5.0 }` read violated at the 2 where (5, −2) meets every equation. `x == y * y` beside `y == x * x` has (0, 0) and (1, 1).
    const asserted = ['assert constraint a { x == y * y + 1.0 }', 'assert constraint b { y == 3.0 - x }'];
    const cycle = ['assert constraint a { x == y * y }', 'assert constraint b { y == x * x }'];
    const stated = 'attribute x : ScalarValues::Real = y * y + 1.0; attribute y : ScalarValues::Real = 3.0 - x; attribute z : ScalarValues::Real;';
    for (const [decl, defs, plain] of [
      [X, asserted, ['constraint e { x == 5.0 }', 'constraint k { x <= 2.5 }']],
      [X, cycle, ['constraint j { x <= 0.9 }', 'constraint k { x >= 0.5 }']],
      [stated, [], ['constraint e { x == 5.0 }', 'constraint k { x <= 2.5 }', 'constraint j { x >= 4.0 }']],
    ] as const) {
      for (const text of inEveryOrder(decl, [...defs, ...plain])) {
        const r = await rows(text);
        const names = plain.map((c) => /constraint (\w+)/.exec(c)![1]!);
        expect(names.map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual(names.map(() => ['unknown', undefined]));
        expect(r.get(names[0]!)!.reason, text).toContain('the equations over it may leave more than one root');
        // Beside a plain equation (`e`) the value is no one the model states; beside inequalities only, as for an asserted curved equation, it is still published.
        if (plain.some((c) => c.includes('=='))) {
          const { model: m } = await loadModelText(text);
          expect(solve(m!).values.has(m!.all().find((el) => el.declaredName === 'x')!.id), text).toBe(false);
        }
      }
    }
  });

  it('withholds what another equation reads from such a loop, and what a plain constraint takes from it', async () => {
    // `z - x == 1.0` is no definition: z is z = 3 at the root 2 and 6 at 5, and `n { z == 3.0 }` was taken as the design equation for it.
    const loop = ['assert constraint a { x == y * y + 1.0 }', 'assert constraint b { y == 3.0 - x }'];
    for (const members of [
      [...loop, 'assert constraint c { z - x == 1.0 }', 'constraint n { z == 3.0 }', 'constraint m { z <= 3.5 }'],
      [...loop, 'assert constraint c { z == x + 1.0 }', 'constraint m { z <= 3.5 }'],
      [...loop, 'constraint d { z == x + 1.0 }', 'constraint m { z <= 3.5 }'],
    ]) {
      for (const text of [`package K { ${X} ${members.join(' ')} }`, `package K { ${X} ${[...members].reverse().join(' ')} }`]) {
        const r = await rows(text);
        for (const n of ['n', 'd', 'm']) if (r.has(n)) expect([r.get(n)!.result, r.get(n)!.imposed], `${n} in ${text}`).toEqual(['unknown', undefined]);
      }
    }
  });

  it('still reads a loop of definitions with the one root, and a chain off a value the model states', async () => {
    // `x == 2.0 * y + 1.0` beside `y == 3.0 - x` is x = 7/3 and nothing else; `z == x * x` over an asserted `x == 3.0` is 9.
    const one = ['assert constraint a { x == 2.0 * y + 1.0 }', 'assert constraint b { y == 3.0 - x }', 'constraint e { x == 5.0 }', 'constraint k { x <= 2.5 }'];
    for (const text of inEveryOrder(X, one)) {
      const r = await rows(text);
      expect([r.get('e')!.result, r.get('k')!.result], text).toEqual(['violated', 'satisfied']);
    }
    const chain = ['assert constraint a { z == x * x }', 'assert constraint b { x == 3.0 }', 'constraint k { z <= 5.0 }', 'constraint e { z == 9.0 }'];
    for (const text of inEveryOrder(X, chain)) {
      const r = await rows(text);
      expect([r.get('k')!.result, r.get('e')!.result], text).toEqual(['violated', 'satisfied']);
    }
  });

  it('still decides a quotient or an exponential design equation, which has the one root', async () => {
    // `v == d / t` over `d == 100.0` and `v == 20.0` is t = 5; one to one in t, it is no second root, whichever way it is written.
    const members = [
      'constraint e0 { v == d / t }',
      'constraint e1 { d == 100.0 }',
      'constraint e2 { v == 20.0 }',
      'constraint lim { t <= 6.0 }',
      'constraint lim2 { t >= 6.0 }',
    ];
    const Q = 'attribute d : ScalarValues::Real; attribute t : ScalarValues::Real; attribute v : ScalarValues::Real;';
    for (const list of [members, [...members].reverse()]) {
      const r = await rows(`package K { ${Q} ${list.join(' ')} }`);
      expect(['e0', 'e1', 'e2'].map((n) => [r.get(n)!.result, r.get(n)!.imposed])).toEqual(Array(3).fill(['satisfied', true]));
      expect([r.get('lim')!.result, r.get('lim2')!.result]).toEqual(['satisfied', 'violated']);
    }
  });

  it('reads a one-to-one side set equal to a side that varies with the same feature as an equation of more than one root', async () => {
    // A quotient or an exponential has the one root set equal to something that does not vary with the feature (`v == d / t`,
    // `2.0 ^ y == 8.0`). Set equal to a side that does, it crosses it twice: `x == 6.0 / (x + 1.0)` at 2 and −3, `x + 1.0 == 8.0 / (x - 1.0)`
    // at ±3, `x / 2.0 == 3.0 / x` at ±√6, `2.0 ^ x == x + 3.0` at −2.86 and 2.44, `6.0 / y == 5.0 - y` at 2 and 3. Read as the one root,
    // `k { x <= 0.0 }` read F at 2 where −3 meets it, `m { x >= 0.0 }` read T where −3 breaks it, and `c1 { x == -3.0 }` beside the
    // equation read t above it and ? below it. The lone equation is imposed at the root found where the solve finds one (as `x * x == 4.0` is); nothing beside it is read.
    const alone = (e: string, v = 'x') => [`constraint c0 { ${e} }`, `constraint k { ${v} <= 0.0 }`, `constraint m { ${v} >= 0.0 }`];
    for (const e of ['x == 6.0 / (x + 1.0)', 'x + 1.0 == 8.0 / (x - 1.0)', 'x / 2.0 == 3.0 / x', '2.0 ^ x == x + 3.0', '2.0 * x == 5.0 / x']) {
      for (const text of inEveryOrder(X, alone(e))) {
        const r = await rows(text);
        // (The solve does not converge on `x + 1.0 == 8.0 / (x - 1.0)` from where it starts: c0 is then unknown, and never violated.)
        expect(r.get('c0')!.result, text).not.toBe('violated');
        expect(['k', 'm'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual(Array(2).fill(['unknown', undefined]));
        if (r.get('c0')!.imposed) expect(r.get('k')!.reason, text).toContain('the equations over it may leave more than one root');
      }
    }
  });

  it('withholds a one-to-one side that crosses another side beside an equation that fixes the feature, in every order', async () => {
    // Another equation beside it that fixes the feature (to a root or not): the value is no one the model states, in every order.
    for (const members of [
      ['constraint c0 { x == 6.0 / (x + 1.0) }', 'constraint c1 { x == -3.0 }', 'constraint k { x <= -1.0 }'],
      ['constraint c0 { 6.0 / x == 5.0 - x }', 'constraint c1 { x == 3.0 }'],
      ['constraint c0 { 2.0 ^ x == x + 1.0 }', 'constraint c1 { x == 1.0 }'],
      ['constraint c0 { 2.0 ^ x == x + 1.0 }', 'constraint c1 { x == 0.0 }'],
      ['assert constraint a { 6.0 / x == 5.0 - x }', 'constraint k { x >= 2.5 }', 'constraint j { x <= 2.5 }'],
    ]) {
      const names = members.map((c) => /constraint (\w+)/.exec(c)![1]!).filter((n) => n !== 'a');
      for (const text of inEveryOrder(X, members)) {
        const r = await rows(text);
        expect(names.map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual(names.map(() => ['unknown', undefined]));
      }
    }
  });

  it('does not decide the witness search over the root of a side that crosses another side', async () => {
    // The witness search does not decide the model infeasible over the root it took (x = 2): −3 meets `x <= 0.0`, and the exponential's −2.86.
    const f6 = solveFeasible((await loadModelText(`package F6 { ${X} constraint c0 { x == 6.0 / (x + 1.0) } constraint c1 { x <= 0.0 } }`)).model!);
    expect([f6.feasible && f6.decided, f6.feasible === false && f6.decided]).toEqual([false, false]);
    const f9m = (await loadModelText(`package F9 { ${X} constraint c0 { 2.0 ^ x == x + 3.0 } constraint c1 { x <= 0.0 } }`)).model!;
    const f9 = solveFeasible(f9m);
    expect([f9.feasible, f9.decided]).toEqual([true, true]);
    expect(f9.values.get(f9m.all().find((el) => el.declaredName === 'x')!.id)!).toBeLessThan(0);
    // A side that does not vary with the feature keeps the one root: `x == d / t` over a `d` another equation fixes, whichever way round.
    for (const text of inEveryOrder(X, ['constraint e0 { x == 6.0 / y }', 'constraint e1 { y == 2.0 }', 'constraint k { x <= 0.0 }'])) {
      const r = await rows(text);
      expect(['e0', 'e1', 'k'].map((n) => r.get(n)!.result), text).toEqual(['satisfied', 'satisfied', 'violated']);
    }
  });

  it('reads a component of more than 64 equations as it reads a short one, in either order', async () => {
    // `z == x0 * x0` over `x0 == 3.0` has the one root however long the chain `x{i+1} == x{i} + 1.0` beside it is: the roots of a long
    // component are told apart as those of a short one (they were all read as more than one root past 64 equations, and every value withheld).
    const chain = (n: number, second: string): string[] => [
      'constraint s { x0 == 3.0 }',
      ...Array.from({ length: n }, (_, i) => `constraint c${i} { x${i + 1} == x${i} + 1.0 }`),
      second,
      'constraint k1 { z >= 8.0 }',
      `constraint k2 { x${n} >= ${n + 3}.0 }`,
    ];
    const decl = (n: number): string => `${Array.from({ length: n + 1 }, (_, i) => `attribute x${i} : ScalarValues::Real;`).join(' ')} attribute z : ScalarValues::Real;`;
    for (const n of [10, 70]) {
      for (const members of [chain(n, 'constraint cz { z == x0 * x0 }'), chain(n, 'constraint cz { z == x0 * x0 }').reverse()]) {
        const text = `package K { ${decl(n)} ${members.join(' ')} }`;
        const { model: m } = await loadModelText(text);
        const values = solve(m!).values;
        const named = (name: string): number | undefined => values.get(m!.all().find((el) => el.declaredName === name)!.id);
        expect([named('x0'), named('z'), named(`x${n}`)], `${n} ${members[0]}`).toEqual([3, 9, 3 + n]);
        const r = new Map(checkConstraintsNumeric(m!).map((row) => [row.name, row]));
        expect([r.get('k1')!.result, r.get('k2')!.result, r.get('cz')!.imposed], `${n} ${members[0]}`).toEqual(['satisfied', 'satisfied', true]);
      }
    }
    // Two roots in a long component are withheld as in a short one: x0 * x0 == 4.0 beside the chain, and `x0 == -2.0` at its head.
    for (const members of [chain(70, 'constraint cz { x0 * x0 == 4.0 }').slice(1), chain(70, 'constraint cz { x0 * x0 == 4.0 }').slice(1).reverse()]) {
      const text = `package K { ${decl(70)} ${['constraint s { x0 == -2.0 }', ...members].join(' ')} }`;
      const r = await rows(text);
      expect([r.get('k2')!.result, r.get('cz')!.result, r.get('s')!.imposed], text).toEqual(['unknown', 'unknown', undefined]);
      expect(r.get('k2')!.reason, text).toContain('more than one root');
    }
  });

  // A lone one-to-one equation `e` with its root: read alike with the pin written first or last, beside an inequality the root breaks
  // (and solveFeasible with it), and alone with the inequalities either side of the root.
  const lit = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`);
  const readsItsRoot = async (e: string, root: number): Promise<void> => {
    const pinned = [`constraint e0 { ${e} }`, `constraint q1 { x == ${lit(root)} }`, `constraint k { x <= ${lit(root - 0.5)} }`];
    for (const text of inEveryOrder(X, pinned)) {
      const r = await rows(text);
      expect(['e0', 'k', 'q1'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual([['satisfied', true], ['violated', undefined], ['satisfied', true]]);
    }
    for (const text of [pinned, [...pinned].reverse()].map((list) => `package K { ${X} ${list.join(' ')} }`)) {
      const f = solveFeasible((await loadModelText(text)).model!);
      expect([f.feasible, f.decided], text).toEqual([false, true]);
    }
    // Alone: the one root is the value, and an inequality over it is judged there.
    const alone = [pinned[0]!, `constraint k { x >= ${lit(root + 0.5)} }`, `constraint j { x <= ${lit(root + 0.5)} }`];
    for (const text of [alone, [...alone].reverse()].map((list) => `package K { ${X} ${list.join(' ')} }`)) {
      const r = await rows(text);
      expect(['e0', 'k', 'j'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual([['satisfied', true], ['violated', undefined], ['satisfied', undefined]]);
    }
  };

  it('finds the root of a lone one-to-one equation across its pole, with or without a pin and in every order', async () => {
    // `6.0 - 3.0 / (x + 1.0) == 3.0` has its root at 0 and its pole at −1. Newton from the seed 1 steps beside the pole (1 -> −1.000002)
    // and stops there, and the ends of every bracket around 0 have the sign of the asymptote, so the root-find found nothing: the equation
    // read ? written before `x == 0.0` and t after it (an abstention in one order, a value in the other), and solveFeasible answered
    // differently. It looks for a sign change between samples either side of the pole, so a root with a sample between it and its pole is found
    // wherever the solve starts (and one in the same gap as its pole is not: the abstention test below).
    for (const [e, root] of [
      ['6.0 - 3.0 / (x + 1.0) == 3.0', 0],
      ['5.0 - 3.0 / (x + 1.0) == 2.0', 0],
      ['3.0 / (x - 2.0) == 1.0', 5],
      ['24.0 / (x - 4.0) == 3.0', 12],
      ['0.5 ^ x == 4.0', -2],
      // The root on the far side of a pole SAMPLE (−1): the sign change is between the sample before it and the pole's own left flank.
      ['3.0 / (x + 1.0) == -6.0', -1.5],
    ] as const) {
      await readsItsRoot(e, root);
    }
  });

  it('finds the root of a lone one-to-one equation close to its pole, across it with a coefficient, or from a huge value at the seed', async () => {
    // Near its pole a quotient's root is steep: the sign change between two samples was closed on to a width of 1e-9, where the residual
    // is still 7e-6 (`1.0 / x == 100.0`), and the gate the caller judges the root by (1e-6) rejected it: read ? written before `x == 0.01`
    // and t after it, where the root of the same equation is found at fa187fa in both. It is closed on to the last digit now.
    // Across a pole with a coefficient (`1.0 / (x + 1.0) + 10.0 == 11.0`, pole −1, root 0) Newton's finite-difference slope straddles the
    // pole (2e16) and steps 9e-12, the residual falling one part in 1e10: that is no progress, and the root was never searched for.
    // An exponential is huge at the seed (`10.0 ^ (2.0 * x + 8.0)` is 1e10 at x = 1): the residual floor taken there is 1e-4, and Newton
    // stopped at 6.6e-6, a point the gate (1e-6, taken at the root) calls unconverged.
    for (const [e, root] of [
      ['1.0 / x == 100.0', 0.01],
      ['1.0 / x == 4000.0', 0.00025],
      ['3.0 / (x - 2.0) == 100.0', 2.03],
      ['1.0 / (x + 1.0) + 10.0 == 11.0', 0],
      ['4.0 / (-10.0 * x - 10.0) == -0.4', 0],
      ['10.0 ^ (2.0 * x + 8.0) == 1.0', -4],
      ['5.0 ^ (-x + 16.0) == 1.0', 16],
      ['(3.0 ^ (7.0 * x + 10.0)) * 8.0 == 216.0', -1],
    ] as const) {
      await readsItsRoot(e, root);
    }
  });

  it('abstains, never a value, where a one-to-one equation has no sign change to close on, and reads the pin in both orders', async () => {
    // The search samples 0 and ±2^k and closes on a sign change between neighbours. `1.0 / (x - 5.0) == 2.0` has its root (5.5) and its
    // pole (5) in the same gap between two samples (4 and 8): no sample between them, no sign change, no root found, whichever way the
    // equation is written. `2.0 ^ x == -4.0` has no root at all. Both are an abstention alone, and the pin supplies the value.
    for (const [e, root] of [['1.0 / (x - 5.0) == 2.0', 5.5], ['3.0 / (x + 1.5) == 10.0', -1.2]] as const) {
      for (const list of [[`constraint e0 { ${e} }`, 'constraint k { x <= 0.0 }'], [`constraint k { x <= 0.0 }`, `constraint e0 { ${e} }`]]) {
        const r = await rows(`package K { ${X} ${list.join(' ')} }`);
        expect(['e0', 'k'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), list.join(' ')).toEqual(Array(2).fill(['unknown', undefined]));
      }
      for (const text of inEveryOrder(X, [`constraint e0 { ${e} }`, `constraint q1 { x == ${root} }`])) {
        const r = await rows(text);
        expect(['e0', 'q1'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual(Array(2).fill(['satisfied', true]));
      }
    }
    for (const list of [['constraint e0 { 2.0 ^ x == -4.0 }', 'constraint k { x <= 0.0 }'], ['constraint k { x <= 0.0 }', 'constraint e0 { 2.0 ^ x == -4.0 }']]) {
      const r = await rows(`package K { ${X} ${list.join(' ')} }`);
      expect(['e0', 'k'].map((n) => r.get(n)!.result), list.join(' ')).toEqual(['unknown', 'unknown']);
    }
  });

  it('reads no root where a quotient or an exponential tends to its asymptote, and the root of a flat one, in every order (fence-numeric2)', async () => {
    // An equation set to a value its one-to-one function never reaches (`2.0 ^ x == 0.0`, `6.0 / (x + 1.0) == 0.0`) is under the gate a long
    // way out, where it tends to its asymptote: the numeric surface read it imposed at x = −31 (and `x >= 0.0` beside it satisfied), and
    // solveFeasible answered feasible, decided, at x = 3e21. A flat one with a root (`1.0 / x == 0.000001`, slope 1e-12) is under the gate
    // 227 from it: it was imposed at 999773 and `x >= 999999.0` read violated, where the root 1e6 meets it. A residual is a root's only
    // where the equation is steep enough there: the first reads nothing, the second its root, whichever way the text is ordered.
    for (const [e, k] of [
      ['6.0 / (x + 1.0) == 0.0', 'x >= 0.0'],
      ['6.0 / x == 0.0', 'x <= -1.0'],
      ['2.0 ^ x == 0.0', 'x <= 0.0'],
      ['5.0 == 1.5 ^ (5.0 * x - 10.0) + 3.0 + 2.0', 'x <= 0.0'],
    ] as const) {
      for (const text of inEveryOrder(X, [`constraint a { ${e} }`, `constraint b { ${k} }`])) {
        const r = await rows(text);
        expect(['a', 'b'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual(Array(2).fill(['unknown', undefined]));
        const f = solveFeasible((await loadModelText(text)).model!);
        expect([f.feasible && f.decided, f.feasible === false && f.decided], text).toEqual([false, false]);
      }
    }
    // Alone, the equation has no root and no witness: with no value to hold the feature at, the model is not read feasible either.
    for (const e of ['2.0 ^ x == 0.0', '6.0 / (x + 1.0) == 0.0']) {
      const text = `package K { ${X} constraint a { ${e} } }`;
      expect((await rows(text)).get('a')!.result, text).toBe('unknown');
      const f = solveFeasible((await loadModelText(text)).model!);
      expect([f.feasible && f.decided, f.feasible === false && f.decided], text).toEqual([false, false]);
    }
    // The same through a second equation that fixes the other side (`y == 0.0`): met by the coupled step at x = −23 (residual 1e-7, under the
    // gate) and imposed there, a row T on the asserted pair.
    for (const [kind, members] of [
      ['plain', ['constraint a { y == 2.0 ^ x }', 'constraint b { y == 0.0 }', 'constraint c { x <= 0.0 }']],
      ['asserted', ['assert constraint a { y == 2.0 ^ x }', 'assert constraint b { y == 0.0 }', 'constraint c { x <= 0.0 }']],
    ] as const) {
      for (const list of [members, [...members].reverse()]) {
        const text = `package K { ${X} ${list.join(' ')} }`;
        const r = await rows(text);
        expect(['a', 'c'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), `${kind} ${text}`).toEqual(Array(2).fill(['unknown', undefined]));
        const f = solveFeasible((await loadModelText(text)).model!);
        expect(f.feasible && f.decided, text).toBe(false);
      }
    }
    for (const [c, root] of [['0.000001', 1e6], ['0.00001', 1e5]] as const) {
      const window = [`constraint e0 { 1.0 / x == ${c} }`, `constraint k { x >= ${root - 1}.0 }`, `constraint j { x <= ${root + 1}.0 }`];
      for (const text of inEveryOrder(X, window)) {
        const r = await rows(text);
        expect(['e0', 'k', 'j'].map((n) => [r.get(n)!.result, r.get(n)!.imposed]), text).toEqual([['satisfied', true], ['satisfied', undefined], ['satisfied', undefined]]);
        expect(solveFeasible((await loadModelText(text)).model!).feasible, text).toBe(true);
      }
      // The pin that is the root violates nothing; one 2e-4 off, which the gate (1e-6) lets through, is not read as agreeing with it.
      for (const pin of [root, root * 1.0002]) {
        for (const text of inEveryOrder(X, [`constraint e0 { 1.0 / x == ${c} }`, `constraint p { x == ${pin}.0 }`])) {
          const r = await rows(text);
          const read = ['e0', 'p'].map((n) => r.get(n)!.result);
          // The root violates nothing; the pin off it is never read as agreeing with the equation (both satisfied).
          if (pin === root) expect(read, text).not.toContain('violated');
          else expect(read.every((v) => v === 'satisfied'), text).toBe(false);
        }
      }
    }
  });

  it('gives solveFeasible no witness where a divisor the search moved is within tolerance of zero (fence-numeric2)', async () => {
    // `x / y == 3.0` beside `y == 0.0` and `x == 0.0` was met at 1e-16 and 3e-16 (a quotient of rounding; 0/0 satisfies nothing). With a
    // divisor that is nowhere near 0 the witness stands.
    for (const members of [
      ['constraint c0 { x / y == 3.0 }', 'constraint c1 { y == 0.0 }', 'constraint c2 { x == 0.0 }'],
      ['constraint c0 { x / y == 3.0 }', 'constraint c1 { y <= 0.0 }', 'constraint c2 { y >= 0.0 }'],
    ]) {
      for (const text of inEveryOrder(X, members)) {
        const f = solveFeasible((await loadModelText(text)).model!);
        expect([f.feasible && f.decided, f.feasible === false && f.decided], text).toEqual([false, false]);
      }
    }
    for (const text of inEveryOrder(X, ['constraint c0 { x / y == 3.0 }', 'constraint c1 { y == 2.0 }'])) {
      const f = solveFeasible((await loadModelText(text)).model!);
      expect([f.feasible, f.decided], text).toEqual([true, true]);
    }
  });

  it('reads a two-root equation in the middle or at the tail of a long component as in a short one', async () => {
    // A chain anchored at its tail (`x{n} == n + 3.0`) with `x{m+1} == x{m} * x{m}` among its members has two roots for x{m} and so for x0
    // (−2 and −8 at n = 10, −28.76 and −41.25 at n = 70): every value is withheld and the sentence is the short one's, however long the chain.
    const decl = (n: number): string => `${Array.from({ length: n + 1 }, (_, i) => `attribute x${i} : ScalarValues::Real;`).join(' ')}`;
    for (const n of [10, 70]) {
      const m = n / 2;
      const t = Math.floor((Math.sqrt(m + 4) - m - 0.5) * 10) / 10;
      const members = [
        `constraint s { x${n} == ${n + 3}.0 }`,
        ...Array.from({ length: n }, (_, i) => (i === m ? `constraint q { x${m + 1} == x${m} * x${m} }` : `constraint c${i} { x${i + 1} == x${i} + 1.0 }`)),
        `constraint k1 { x0 >= ${t} }`,
        'constraint k2 { x0 <= 1000.0 }',
      ];
      for (const list of [members, [...members].reverse()]) {
        const text = `package K { ${decl(n)} ${list.join(' ')} }`;
        const r = await rows(text);
        expect(['k1', 'k2', 'q'].map((nm) => [r.get(nm)!.result, r.get(nm)!.imposed]), `${n} ${list[0]}`).toEqual(Array(3).fill(['unknown', undefined]));
        expect(r.get('k1')!.reason, `${n} ${list[0]}`).toMatch(/one of them that may have more than one root/);
        const f = solveFeasible((await loadModelText(text)).model!);
        expect([f.feasible, f.decided], `${n} ${list[0]}`).toEqual([true, true]);
      }
    }
  });

  it('reads a loop of seventy definitions with a curved member as a short loop of the kind, in every order', async () => {
    // `x{i+1} == 0.5 * x{i} + 1.0` closed by `x0 == 0.5 * x69 + 0.1 * x69 * x69 - 1.0` has two roots for x0, asserted or stated: the
    // plain constraints over it are unjudged. The same ring with every member affine has the one (x = 2) and is read.
    const n = 70;
    const feats = Array.from({ length: n }, (_, i) => `x${i}`);
    const checks = ['constraint k { x0 >= 0.0 }', 'constraint j { x0 <= 5.0 }'];
    const asserted = [
      ...Array.from({ length: n - 1 }, (_, i) => `assert constraint a${i} { x${i + 1} == 0.5 * x${i} + 1.0 }`),
      `assert constraint z { x0 == 0.5 * x${n - 1} + 0.1 * x${n - 1} * x${n - 1} - 1.0 }`,
      ...checks,
    ];
    const affine = [...asserted.slice(0, n - 1), `assert constraint z { x0 == 0.5 * x${n - 1} + 1.0 }`, 'constraint k { x0 >= 0.0 }', 'constraint j { x0 <= 1.0 }'];
    const plain = feats.map((f) => `attribute ${f} : ScalarValues::Real;`).join(' ');
    const stated = feats
      .map((f, i) => `attribute ${f} : ScalarValues::Real = ${i === 0 ? `0.5 * x${n - 1} + 0.1 * x${n - 1} * x${n - 1} - 1.0` : `0.5 * x${i - 1} + 1.0`};`)
      .join(' ');
    for (const [decl, list] of [[plain, asserted], [stated, checks]] as const) {
      for (const members of [list, [...list].reverse()]) {
        const r = await rows(`package K { ${decl} ${members.join(' ')} }`);
        expect(['k', 'j'].map((nm) => [r.get(nm)!.result, r.get(nm)!.imposed]), members[0]).toEqual(Array(2).fill(['unknown', undefined]));
        expect(r.get('k')!.reason, members[0]).toContain('may leave more than one root');
      }
    }
    for (const members of [affine, [...affine].reverse()]) {
      const r = await rows(`package K { ${plain} ${members.join(' ')} }`);
      expect(['k', 'j'].map((nm) => r.get(nm)!.result), members[0]).toEqual(['satisfied', 'violated']);
    }
  });

  it('abstains, soundly, on a coupled affine pair that fixes its features beside a square of one of them', async () => {
    // `a + b == 4.0` and `a - b == 0.0` fix a = b = 2 together, so `z == a * a` has the one root (z = 4) and `z >= 5.0` is violated. The
    // root test takes the equations fixing a feature one at a time, not an affine pair solved together: it reads `q` as of more than one
    // root and says so, and the F a coupled pair used to give is an abstention (a sound one, with a wrong reason: a known gap, in TODO.md).
    const decl = 'attribute a : ScalarValues::Real; attribute b : ScalarValues::Real; attribute z : ScalarValues::Real;';
    const own = ['c0 { a + b == 4.0 }', 'c1 { a - b == 0.0 }', 'q { z == a * a }'];
    const plain = await rows(`package K { ${decl} ${[...own, 'k { z >= 5.0 }'].map((c) => `constraint ${c}`).join(' ')} }`);
    expect(['c0', 'c1', 'q', 'k'].map((nm) => plain.get(nm)!.result)).toEqual(Array(4).fill('unknown'));
    const asserted = await rows(`package K { ${decl} ${own.map((c) => `assert constraint ${c}`).join(' ')} constraint k { z >= 5.0 } }`);
    expect(['c0', 'c1', 'q', 'k'].map((nm) => asserted.get(nm)!.result)).toEqual(['satisfied', 'satisfied', 'satisfied', 'unknown']);
  });

  it('reads a quotient by a value other plain equations fix as the one root it has, in every order', async () => {
    // `x / y == 3.0` beside `y == 2.0` and `x == 6.0`: a constant over an affine function of y has one root, so whichever equation the
    // solve leaves unused agrees and is imposed like the others, where it was withheld for being "curved". The density form is the same.
    const imposed = (r: Awaited<ReturnType<typeof rows>>, names: readonly string[]) => names.map((n) => [r.get(n)!.result, r.get(n)!.imposed]);
    for (const text of inEveryOrder(X, ['constraint c0 { x / y == 3.0 }', 'constraint c1 { y == 2.0 }', 'constraint c2 { x == 6.0 }'])) {
      expect(imposed(await rows(text), ['c0', 'c1', 'c2']), text).toEqual(Array(3).fill(['satisfied', true]));
    }
    // The values it gives are read: x = 6 breaks `k`, y = 2 meets `j`; and a second equation linking them does not change the root.
    const judged = ['constraint c0 { x / y == 3.0 }', 'constraint c1 { y == x - 4.0 }', 'constraint c2 { x == 6.0 }', 'constraint k { x <= 5.0 }', 'constraint j { y >= 1.0 }'];
    for (const list of [judged, [...judged].reverse()]) {
      const r = await rows(`package K { ${X} ${list.join(' ')} }`);
      expect(imposed(r, ['c0', 'c1', 'c2']), list.join(' ')).toEqual(Array(3).fill(['satisfied', true]));
      expect([r.get('k')!.result, r.get('j')!.result], list.join(' ')).toEqual(['violated', 'satisfied']);
    }
    const D = 'attribute m : ScalarValues::Real; attribute v : ScalarValues::Real; attribute d : ScalarValues::Real;';
    for (const text of inEveryOrder(D, ['constraint c0 { m / v == d }', 'constraint c1 { m == 100.0 }', 'constraint c2 { v == 20.0 }', 'constraint c3 { d == 5.0 }'])) {
      expect(imposed(await rows(text), ['c0', 'c1', 'c2', 'c3']), text).toEqual(Array(4).fill(['satisfied', true]));
    }
    // One that disagrees with the quotient (x = 7 beside 7 / 2 != 3) is still withheld, in every order: the plain constraints disagree.
    for (const text of inEveryOrder(X, ['constraint c0 { x / y == 3.0 }', 'constraint c1 { y == 2.0 }', 'constraint c2 { x == 7.0 }'])) {
      const r = await rows(text);
      expect(imposed(r, ['c0', 'c1', 'c2']), text).toEqual(Array(3).fill(['unknown', undefined]));
      expect(r.get('c0')!.reason, text).toContain('only plain constraints that disagree');
    }
  });

  it('does not take a pole for the root of a quotient, so no order of the text leaves it unsolved', async () => {
    // `24.0 / (x - y) == 3.0` once `y` is 4 has its pole at x = 4, the middle of the bracket the root-find opens: closing on it gave 4 as
    // the root of the equation, where `x == 3.0 * y` (x = 12) was written after it. Six orders, one answer: the pole is no root.
    const members = ['constraint c0 { 12.0 / (y + 1.0) == 2.4 }', 'constraint c1 { x == 3.0 * y }', 'constraint c2 { 24.0 / (x - y) == 3.0 }', 'constraint k { y <= 3.0 }'];
    const orders = new Set<string>();
    for (const text of inEveryOrder(X, members)) {
      const r = await rows(text);
      orders.add(['c0', 'c1', 'c2', 'k'].map((n) => `${r.get(n)!.result}/${r.get(n)!.imposed}`).join(' '));
    }
    expect([...orders]).toEqual(['satisfied/true satisfied/true satisfied/true violated/undefined']);
  });

  it('does not read the symbol of a unit, or a string, in an asserted body that does not parse as a feature', async () => {
    // `M ** 2.0 == 4.0 [m]` constrains M, and the `m` is a metre: read as the feature `m` it held p's m as one the assert constrains,
    // and `t1 { p.m == 3.0 }` was not solved for. A name written outside the brackets is still read.
    const P = (e: string) => `package US { part def P { attribute L : ScalarValues::Real; attribute m : ScalarValues::Real; attribute M : ScalarValues::Real;
      assert constraint e { ${e} } } part p : P; constraint t1 { p.m == 3.0 } constraint t2 { p.M == 1.0 } }`;
    for (const e of ['M ** 2.0 == 4.0 [m]', 'M == max(L, 4.0 [m])', 'M ** 2.0 == 4.0 and "m" != "n"', "M ** 2.0 == 4.0 and 'm' != 'n'", 'M ** 2.0 == 4.0 [m] + 2.0 [m]']) {
      const r = await rows(P(e));
      expect([r.get('t1')!.result, r.get('t1')!.imposed], e).toEqual(['satisfied', true]);
      expect([r.get('t2')!.result, r.get('t2')!.imposed], e).toEqual(['unknown', undefined]);
      expect(r.get('t2')!.reason, e).toContain('an assert constrains it in a form the numeric solve does not read');
    }
    for (const e of ['m ** 2.0 == 4.0 [m]', 'M ** 2.0 == m']) {
      const r = await rows(P(e));
      expect([r.get('t1')!.result, r.get('t1')!.imposed], e).toEqual(['unknown', undefined]);
    }
  });

  it('holds the names an asserted relation that does not parse writes, as one it reads no equation from', async () => {
    // `e` is a parse error, and still constrains M and L (M = max(L, 20.0) >= 20): `t1 { p.M == 3.0 }` was imposed by the solve.
    for (const e of ['M == max(L, 20.0)', 'M == L ** 2.0']) {
      const r = await rows(`package UP {
        part def P { attribute M : ScalarValues::Real; attribute L : ScalarValues::Real;
          assert constraint e { ${e} } assert constraint g { L >= 5.0 and L <= 100.0 } }
        part p : P;
        constraint t1 { p.M == 3.0 }
      }`);
      expect([r.get('t1')!.result, r.get('t1')!.imposed], e).toEqual(['unknown', undefined]);
      expect(r.get('t1')!.reason, e).toBe(
        'UP::p::M has no value, and an assert constrains it in a form the numeric solve does not read (e, an equation it ' +
          'cannot read), so it is no design freedom: no plain constraint is solved for it, and this relation is not judged',
      );
    }
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
    // Asserted: the model's own equations. A plain pair with a product in it has two roots, and none is read.
    for (const expression of exprs) m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression, requirementRole: 'assert' } });
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

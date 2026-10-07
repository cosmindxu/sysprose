import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { parseModel } from '@text/index';
import {
  gatherInequalities,
  solve,
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
    // A verified point is an answer, and the search moved the one freedom.
    expect(res.decided).toBe(true);
    expect([...res.free].sort()).toEqual([x.id, y.id].sort());
    expect(res.unresolved).toEqual([]);
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

  it('holds a coupled pair the equalities determine, never bending it to meet a bound (D5, p14b)', () => {
    // a + b = 10 and a − b = 2 force a = 6: the bound fails whatever the
    // search does. Held only as a penalty, the pair was bent to a = 8, b = 4
    // and the model reported FEASIBLE — the penalty of 1e9·a outweighed both.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'a + b == 10.0' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'a - b == 2.0' } });
    const lim = m.create('ConstraintUsage', {
      ownerId: p.id,
      declaredName: 'lim',
      attrs: { expression: '1000000000.0 * a >= 8000000000.0' },
    });

    const res = solveFeasible(m);
    expect(res.feasible).toBe(false);
    expect(res.decided).toBe(true);
    expect(res.violations.map((v) => v.id)).toEqual([lim.id]);
    expect(res.violations[0]!.amount).toBeCloseTo(2e9, -3);
    expect(res.values.get(a.id)).toBeCloseTo(6, 9);
    expect(res.values.get(b.id)).toBeCloseTo(4, 9);
    expect(res.free).toEqual([]);
  });

  it('a search over a freedom that stalls decides nothing: unresolved, never violated (D5, p09)', () => {
    // p = v·i with p = 100 leaves one freedom; v = 20, i = 5 meets the bound,
    // but coordinate descent on the penalty stalls short of it. That is a
    // search that stopped, not a design that cannot exist.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('v', p.id, { type: 'Real' });
    f.attribute('i', p.id, { type: 'Real' });
    f.attribute('p', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'p == v * i' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'p == 100.0' } });
    const vlim = m.create('ConstraintUsage', { ownerId: p.id, declaredName: 'vlim', attrs: { expression: 'v >= 20.0' } });

    const res = solveFeasible(m);
    expect(res.feasible).toBe(false);
    expect(res.decided).toBe(false);
    expect(res.violations).toEqual([]);
    expect(res.unresolved.map((v) => v.id)).toEqual([vlim.id]);
  });

  it('holds nothing where the plain solve stopped off its equations (r10b)', () => {
    // Newton diverged to x = −106760, missing both equations by 0.2. Held
    // there, `x >= 0.0` was DECIDED infeasible, although x = 2, y = 0 (or
    // x = 0.5) meets every relation.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const x = f.attribute('x', p.id, { type: 'Real' });
    f.attribute('y', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x / (1.0 + x * x) == 0.4 + y' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'y == 0.001 * x - 0.001 * x' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x >= 0.0' } });

    const res = solveFeasible(m);
    expect([res.feasible, res.decided, res.violations]).toEqual([true, true, []]);
    const xv = res.values.get(x.id)!;
    expect(Math.min(Math.abs(xv - 2), Math.abs(xv - 0.5))).toBeLessThan(1e-6);
  });

  it('judges nothing at a point the solve stopped at without converging, and reads no rank there (r10b)', () => {
    // The same divergence: the numeric surface and the analysis report read
    // c1, c2 and `x >= 0.0` violated at x = −106760, and published that x as
    // a solved — determined — value.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const x = f.attribute('x', p.id, { type: 'Real' });
    const y = f.attribute('y', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x / (1.0 + x * x) == 0.4 + y' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'y == 0.001 * x - 0.001 * x' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x >= 0.0' } });

    const solved = solve(m);
    expect(solved.converged).toBe(false);
    expect([solved.values.has(x.id), solved.values.has(y.id), solved.free]).toEqual([false, false, []]);
    const rows = checkConstraintsNumeric(m);
    expect(rows.map((r) => r.result)).toEqual(['unknown', 'unknown', 'unknown']);
    for (const r of rows) expect(r.reason, r.raw).toMatch(/^the solve did not converge/);
    const report = analysisReport(m);
    expect([report.feasible, report.violations, report.unknowns.length, report.values]).toEqual([true, [], 3, []]);

    // Nor does feasibility hold what the solve did not settle, where every
    // other equation it met lies within tolerance: q's p's `load = L`, which
    // the solve reads no L for, left q's p's m2 at 9, and held there `q.p.m2
    // <= 0.0` was DECIDED violated, where q's L of 50 gives −40 (t6).
    const { model: t6 } = parseModel(`package T6 {
    part def P { attribute load : Real default = 1.0; attribute m2 : Real = 10.0 - load; }
    part def Q { attribute L : Real default = 1.0; part p : P { attribute :>> load = L; } }
    part q : Q { attribute :>> L = 50.0; }
    constraint m2NegT { q.p.m2 <= 0.0 }
}
`);
    expect(solve(t6).converged).toBe(false);
    expect(checkConstraintsNumeric(t6).map((r) => r.result)).toEqual(['unknown']);
    const feasible = solveFeasible(t6);
    expect([feasible.violations, feasible.decided]).toEqual([[], false]);
  });

  it('a point off the model’s own equations is no witness (n2, n3, x1, x3)', () => {
    const model = (exprs: Array<[string, boolean]>): Model => {
      const m = new Model();
      const f = new ModelFactory(m);
      const p = f.partDef('P');
      for (const name of ['a', 'x', 'y']) f.attribute(name, p.id, { type: 'Real' });
      for (const [expression, asserted] of exprs) {
        const attrs: Record<string, string> = { expression };
        if (asserted) attrs.requirementRole = 'assert';
        m.create('ConstraintUsage', { ownerId: p.id, attrs });
      }
      return m;
    };
    // Two asserted values of one feature, and an asserted equation with no
    // real root: the plain solve stopped off them, and that point was
    // reported a verified feasible one.
    for (const m of [
      model([['a == 3.0', true], ['a == 5.0', true], ['a <= 10.0', false]]),
      model([['x * x == -4.0', true], ['x <= 10.0', false]]),
      // No point meets both (x / (1 + x²) is at most 0.5): the search drifts
      // along the plateau to x = −1e22, where a gate scaled by x * x took a
      // miss of 0.3 for rounding.
      model([['x / (1.0 + x * x) == 0.6 + y', false], ['y == 0.001 * x - 0.001 * x', false], ['x <= 10.0', false]]),
      // The same, each equation pinning its one unknown: nothing moves, and a
      // plain equation the solve took as a design equation, missed by 0.6
      // where Newton stopped, was left unread.
      model([['y == 0.0', false], ['x / (1.0 + x * x) == 0.6 + y', false], ['x <= 10.0', false]]),
    ]) {
      const res = solveFeasible(m);
      expect([res.feasible, res.decided, res.violations]).toEqual([false, false, []]);
    }
  });

  it('judges at the point a relation neither gatherer reads, and leaves the answer open where it cannot (c2, c1, u1)', () => {
    const model = (x: number | undefined, body: string): { m: Model; rel: string } => {
      const m = new Model();
      const f = new ModelFactory(m);
      const p = f.partDef('P');
      f.attribute('x', p.id, x === undefined ? { type: 'Real' } : { type: 'Real', value: x });
      f.attribute('y', p.id, { type: 'Real' });
      f.attribute('flag', p.id, { type: 'Boolean', value: 'true' });
      m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'y == x * 2.0', requirementRole: 'assert' } });
      const rel = m.create('ConstraintUsage', { ownerId: p.id, declaredName: 'both', attrs: { expression: body } });
      return { m, rel: rel.id };
    };
    // Violated over a stated x: the numeric and validation surfaces say so,
    // and it was reported feasible.
    const stated = model(7, 'x >= 10.0 and x <= 5.0');
    const c2 = solveFeasible(stated.m);
    expect([c2.feasible, c2.decided]).toEqual([false, true]);
    expect(c2.violations.map((v) => v.id)).toEqual([stated.rel]);
    expect(Number.isNaN(c2.violations[0]!.amount)).toBe(true);
    // Over a freedom the search moved: unresolved, nothing decided.
    const free = model(undefined, 'x >= 10.0 and x <= 5.0');
    const c1 = solveFeasible(free.m);
    expect([c1.feasible, c1.decided, c1.violations]).toEqual([false, false, []]);
    expect(c1.unresolved.map((v) => v.id)).toEqual([free.rel]);
    // A Boolean the numeric surface cannot read: every relation judged holds,
    // but the model's answer is open.
    const u1 = solveFeasible(model(3, 'flag == true and x <= 5.0').m);
    expect([u1.feasible, u1.decided, u1.violations, u1.unresolved]).toEqual([true, false, [], []]);
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

  it('a bound over a feature the optimum leaves free is unjudged, never satisfied (D5)', () => {
    // `y * a == 0` fixes y = 0 for every a but a = 0, where any y solves it.
    // The search runs (y is determined where it starts) and stops at a = 0:
    // `y <= 1.0` was then read at y = 1, the solve's guess, and the optimum
    // called feasible.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const y = f.attribute('y', p.id, { type: 'Real' });
    const obj = f.attribute('obj', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'obj == a', requirementRole: 'assert' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'y * a == 0.0' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'y <= 1.0' } });

    const res = optimize(m, obj.id, [a.id], { sense: 'min', bounds: { [a.id]: [0, 10] }, constraints: true });
    expect(res.best.get(a.id)).toBe(0);
    expect(res.value).toBe(0);
    expect(res.feasible).toBeUndefined();
    expect(res.free).toEqual([y.id]);
  });

  it('a bound nothing gives a value is unjudged, never satisfied (o2)', () => {
    // No equation reads `z`: the two bounds over it contradict each other, and
    // the optimum was called feasible.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    f.attribute('z', p.id, { type: 'Real' });
    const obj = f.attribute('obj', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'obj == a * 2.0', requirementRole: 'assert' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'z >= 10.0' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'z <= 5.0' } });

    const res = optimize(m, obj.id, [a.id], { sense: 'max', bounds: { [a.id]: [0, 10] }, constraints: true });
    expect(res.value).toBeCloseTo(20, 6);
    expect(res.feasible).toBeUndefined();
    expect(res.free).toBeUndefined();
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

  it('reports a bound over a design freedom as unjudged, with the freedom, and no value for it (D5)', () => {
    // x + y = 10 fixes neither: the solve stops at x = y = 5, and `x <= 3`
    // was reported VIOLATED there although x = 3, y = 7 meets it.
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('x', p.id, { type: 'Real' });
    f.attribute('y', p.id, { type: 'Real' });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x + y = 10' } });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'x <= 3' } });

    const report = analysisReport(m);
    expect(report.feasible).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.unknowns.map((u) => u.expression)).toEqual(['x <= 3']);
    expect(report.unknowns[0]!.reason).toMatch(/^x is left free by the equations/);
    expect(report.free.map((r) => r.declaredName).sort()).toEqual(['x', 'y']);
    expect(report.values).toEqual([]);
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

/**
 * The relation layer's contract, asserted from OUTSIDE the module.
 *
 * `src/semantics/relations.ts` exists so a second engine can stand behind the
 * same unit gates the numeric solver stands behind — "encodability is the same
 * gate the numeric surface applies, because it calls the same functions". That
 * claim is only true while the gates are callable, and callable means more than
 * `export`-annotated: a caller must also be able to NAME the types it passes in
 * and the type it gets back. The last test in this file is that seam, written
 * with every type spelled out, so a lift that leaves an argument type private
 * fails to compile rather than fails to be noticed.
 *
 * The gate behaviours pinned here are the ones a second engine must not
 * re-derive: SI lowering of a `[unit]` literal, the dimension-clash refusal,
 * the offset-arithmetic refusal (and the ordering it deliberately allows), the
 * storage factor of a prefixed unit, and the declared-unit contract that keeps
 * a bare literal unscaled.
 *
 * And one that is not a gate but decides what the gates are asked: the `vars`
 * argument. It is built by `relationVarsOf` from the body's own references, so
 * a caller who reached for the whole scope instead would see a gate refuse a
 * relation the numeric surface encodes. That is pinned here too, in both
 * directions, because the seam is only as shared as its arguments are.
 */

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, type ElementId, type ElementRecord } from '@core/index';
import {
  DIMENSIONLESS,
  INDETERMINATE,
  NO_MARKERS,
  dim,
  dimEqual,
  gatherConstraints,
  gatherInequalities,
  isBindingEdge,
  lowerUnitLiterals,
  nodeDimension,
  parseRelationBody,
  propagateBindings,
  relationRefused,
  relationScope,
  relationVarsOf,
  scaleOfRelation,
  storageScaleOf,
  substituteLiterals,
  type Dimension,
  type MarkerDimensions,
  type OperandDimension,
  type ScaleMap,
} from '../../src/semantics/index';
import type { DerivationMemo } from '../../src/semantics/units-eval';

/** A constraint body over named attributes, with no library bound. */
function constraintModel(
  expression: string,
  attrs: Array<[string, Record<string, string | number>]> = [],
): { m: Model; c: ElementRecord } {
  const m = new Model();
  const p = m.create('Package', { declaredName: 'P' });
  const owner = m.create('PartUsage', { declaredName: 'ctx', ownerId: p.id });
  for (const [name, a] of attrs) {
    m.create('AttributeUsage', { declaredName: name, ownerId: owner.id, attrs: a });
  }
  const c = m.create('ConstraintUsage', { declaredName: 'c', ownerId: owner.id, attrs: { expression } });
  return { m, c };
}

/**
 * Everything a gate needs for one relation body, gathered the way the numeric
 * surface gathers it — `relationVarsOf` over the parsed node, NOT the whole
 * scope. The difference is load-bearing and has its own test below.
 */
function gatesFor(m: Model, c: ElementRecord) {
  const raw = String(c.attrs.expression);
  const body = parseRelationBody(raw);
  if (!body) throw new Error(`unparseable body: ${raw}`);
  const nameToId = relationScope(m, c);
  const vars = relationVarsOf(body.node, nameToId);
  return { body, nameToId, vars, memo: new Map() as DerivationMemo };
}

/* ────────────────────── `[unit]` literals lower to SI ─────────────────── */

describe('relations — lowering a `[unit]` literal', () => {
  it('`2000 [kg]` becomes a marker standing for an SI magnitude of dimension M', () => {
    const lowered = lowerUnitLiterals('mass <= 2000 [kg]');
    expect(lowered.hadUnit).toBe(true);
    expect(lowered.resolved).toBe(true);
    expect(lowered.literals.size).toBe(1);
    const [marker, literal] = [...lowered.literals][0];
    // The literal is replaced by a marker, so gate (c) can still tell a
    // dimensioned literal from a bare one.
    expect(lowered.text).toBe(`mass <= ${marker}`);
    expect(literal.si).toBe(2000);
    expect(literal.dimension).toEqual(dim({ M: 1 }));
  });

  it('a prefixed literal is folded to its SI magnitude, not left in its own unit', () => {
    const lowered = lowerUnitLiterals('range >= 5 [km]');
    const [, literal] = [...lowered.literals][0];
    expect(literal.si).toBe(5000);
    expect(literal.dimension).toEqual(dim({ L: 1 }));
  });

  it('substituteLiterals folds the marker back into the parsed body', () => {
    const body = parseRelationBody('mass <= 2000 [kg]');
    expect(body).toBeDefined();
    const node = substituteLiterals(body!.node, body!.literals);
    expect(node).toMatchObject({
      kind: 'binary',
      op: '<=',
      left: { kind: 'ref', path: ['mass'] },
      right: { kind: 'num', value: 2000 },
    });
  });

  it('an offset or unresolvable unit is not folded — the body cannot be judged', () => {
    expect(lowerUnitLiterals('t2 >= 30 [°C]').resolved).toBe(false);
    expect(lowerUnitLiterals('x >= 30 [furlong]').resolved).toBe(false);
  });
});

/* ─────────────────────────── the refusal gates ────────────────────────── */

describe('relations — relationRefused', () => {
  it('refuses `d >= t`, a length against a duration', () => {
    const { m, c } = constraintModel('d >= t', [
      ['d', { value: 5, unit: 'm' }],
      ['t', { value: 3, unit: 's' }],
    ]);
    const g = gatesFor(m, c);
    expect(relationRefused(m, g.body.node, g.vars, g.nameToId, NO_MARKERS, g.memo)).toBe(true);
  });

  it('does not refuse a dimensioned feature against a bare literal', () => {
    const { m, c } = constraintModel('d >= 4.0', [['d', { value: 5, unit: 'm' }]]);
    const g = gatesFor(m, c);
    expect(relationRefused(m, g.body.node, g.vars, g.nameToId, NO_MARKERS, g.memo)).toBe(false);
  });

  it('refuses `dT == t2 - t1` on °C — arithmetic on an offset scale', () => {
    const T = (v: number, unit: string) => ({ type: 'ISQ::TemperatureValue', value: v, unit });
    const { m, c } = constraintModel('dT == t2 - t1', [
      ['t1', T(20, '°C')],
      ['t2', T(30, '°C')],
      ['dT', T(10, '°C')],
    ]);
    const g = gatesFor(m, c);
    expect(relationRefused(m, g.body.node, g.vars, g.nameToId, g.body.literals, g.memo)).toBe(true);
  });

  it('does not refuse `t2 >= 300 [K]` on the same °C value — an ordering is monotone', () => {
    const { m, c } = constraintModel('t2 >= 300 [K]', [
      ['t2', { type: 'ISQ::TemperatureValue', value: 30, unit: '°C' }],
    ]);
    const g = gatesFor(m, c);
    expect(relationRefused(m, g.body.node, g.vars, g.nameToId, g.body.literals, g.memo)).toBe(false);
  });

  it('the same offset relation is exempt when it STATES an identity', () => {
    const T = (v: number, unit: string) => ({ type: 'ISQ::TemperatureValue', value: v, unit });
    const { m, c } = constraintModel('t3 == t1', [
      ['t1', T(20, '°C')],
      ['t3', T(20, '°C')],
    ]);
    const g = gatesFor(m, c);
    expect(relationRefused(m, g.body.node, g.vars, g.nameToId, NO_MARKERS, g.memo, true)).toBe(false);
    expect(relationRefused(m, g.body.node, g.vars, g.nameToId, NO_MARKERS, g.memo)).toBe(true);
  });
});

/* ─────────────────────── storage scale and scaling ────────────────────── */

describe('relations — storageScaleOf and scaleOfRelation', () => {
  it('a `[km]` feature carries factor 1000 on the length dimension', () => {
    const { m, c } = constraintModel('range >= dist', [
      ['range', { value: 5, unit: 'km' }],
      ['dist', { value: 4000, unit: 'm' }],
    ]);
    const g = gatesFor(m, c);
    const rangeId = g.nameToId.get('range') as ElementId;
    expect(storageScaleOf(m, rangeId, g.memo)).toEqual({
      factor: 1000,
      offset: 0,
      dimension: dim({ L: 1 }),
    });

    // …and the relation over it is scaled, because both sides are lengths.
    const scale = scaleOfRelation(
      m,
      g.vars,
      [g.body.node],
      g.nameToId,
      g.body.hadUnit,
      NO_MARKERS,
      g.memo,
    );
    expect(scale).toBeDefined();
    expect(scale!.get(rangeId)?.factor).toBe(1000);
    expect(scale!.get(g.nameToId.get('dist') as ElementId)?.factor).toBe(1);
  });

  it('a `Real` compared with a bare literal stays unscaled — nothing to convert', () => {
    const { m, c } = constraintModel('x <= 10.0', [['x', { type: 'Real', value: 5 }]]);
    const g = gatesFor(m, c);
    expect(
      scaleOfRelation(m, g.vars, [g.body.node], g.nameToId, g.body.hadUnit, NO_MARKERS, g.memo),
    ).toBeUndefined();
  });

  it('a `[km]` feature compared with a bare literal ALSO stays unscaled', () => {
    // The declared-unit contract: `range = 5 [km]` against `<= 10.0` reads the
    // literal in kilometres, so SI-scaling it would turn a satisfied relation
    // into `5000 <= 10`.
    const { m, c } = constraintModel('range <= 10.0', [['range', { value: 5, unit: 'km' }]]);
    const g = gatesFor(m, c);
    expect(
      scaleOfRelation(m, g.vars, [g.body.node], g.nameToId, g.body.hadUnit, NO_MARKERS, g.memo),
    ).toBeUndefined();
  });
});

/* ───────────────── the vars a gate is asked about ─────────────────────── */

describe('relations — relationVarsOf builds the argument the gates are asked about', () => {
  it('collects only the ids the body REFERENCES, not the whole scope', () => {
    const { m, c } = constraintModel('mass <= 2000 [kg]', [
      ['mass', { value: 1500, unit: 'kg' }],
      ['secs', { type: 'ISQ::DurationValue', value: 60, unit: 's' }],
    ]);
    const nameToId = relationScope(m, c);
    const body = parseRelationBody(String(c.attrs.expression))!;
    expect(relationVarsOf(body.node, nameToId)).toEqual([nameToId.get('mass')]);
    // The scope knows more names than the relation uses — that is the trap.
    expect(new Set(nameToId.values()).size).toBeGreaterThan(1);
  });

  it('a sibling the relation never names cannot refuse its scale', () => {
    // Gates (a) and (d) of `scaleOfRelation` iterate the vars, so a caller who
    // passed the scope instead would let `weird`, whose unit resolves to
    // nothing, refuse a scale the numeric surface grants — and
    // `relationInequality`'s `body.hadUnit && !scale` would then drop the
    // relation, so a second engine would call not-encodable what the numeric
    // surface encodes. That is the divergence the shared construction removes.
    const { m, c } = constraintModel('mass <= 2000 [kg]', [
      ['mass', { value: 1500, unit: 'kg' }],
      ['weird', { value: 3, unit: 'furlong' }],
    ]);
    const nameToId = relationScope(m, c);
    const body = parseRelationBody(String(c.attrs.expression))!;
    const memo: DerivationMemo = new Map();

    const scale = scaleOfRelation(
      m,
      relationVarsOf(body.node, nameToId),
      [body.node],
      nameToId,
      body.hadUnit,
      body.literals,
      memo,
    );
    expect(scale).toBeDefined();
    expect(scale!.size).toBe(1);

    // The scope-wide argument is refused — this is what the seam must not do.
    expect(
      scaleOfRelation(
        m,
        [...new Set(nameToId.values())],
        [body.node],
        nameToId,
        body.hadUnit,
        body.literals,
        new Map(),
      ),
    ).toBeUndefined();

    // …and the numeric surface itself keeps the relation, scaled.
    const ineqs = gatherInequalities(m).filter((i) => i.id === c.id);
    expect(ineqs).toHaveLength(1);
    expect(ineqs[0].scale?.size).toBe(1);
  });
});

/* ───────────────────── one binding predicate, three uses ──────────────── */

describe('relations — the binding predicate is shared, not copied', () => {
  it('an `equals` connector is a binding for the solver and the executor alike', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real', value: 42 });
    const b = f.attribute('b', p.id, { type: 'Real' });
    const edge = m.create('ConnectionUsage', {
      ownerId: p.id,
      source: [a.id],
      target: [b.id],
      attrs: { kind: 'equals' },
    });

    expect(isBindingEdge(edge)).toBe(true);
    expect(
      gatherConstraints(m).some((e) => e.vars.includes(a.id) && e.vars.includes(b.id)),
    ).toBe(true);
    // `execute.propagateBindings` used to carry a NARROWER private copy of this
    // predicate that read only `bind`, so the two surfaces disagreed about the
    // same edge. One predicate now answers for both.
    expect(propagateBindings(m).get(b.id)).toBe(42);
  });
});

/* ──────────────────────────────── the seam ────────────────────────────── */

describe('relations — the seam a second engine uses', () => {
  it('the gates are callable from outside with every type named', () => {
    const { m, c } = constraintModel('mass <= 2000.0', [['mass', { type: 'Real', value: 1500 }]]);

    // Every argument a caller must construct, declared with the type the
    // module publishes for it. If any of these names were still private, this
    // test would not compile — which is the assertion.
    const nameToId: Map<string, ElementId> = relationScope(m, c);
    const body = parseRelationBody('mass <= 2000.0');
    expect(body).toBeDefined();
    const vars: ElementId[] = relationVarsOf(body!.node, nameToId);
    const markers: MarkerDimensions = NO_MARKERS;
    const memo: DerivationMemo = new Map();

    const refused: boolean = relationRefused(m, body!.node, vars, nameToId, NO_MARKERS, new Map());
    expect(refused).toBe(false);

    const scale: ScaleMap | undefined = scaleOfRelation(
      m,
      vars,
      [body!.node],
      nameToId,
      body!.hadUnit,
      markers,
      memo,
    );
    expect(scale).toBeUndefined(); // a plain `Real` — nothing to convert

    const d: OperandDimension = nodeDimension(body!.node, new Map(), nameToId, markers);
    expect(d).not.toBe(INDETERMINATE);
    const truth: Dimension = d as Dimension;
    expect(dimEqual(truth, DIMENSIONLESS)).toBe(true); // a comparison is a truth value
  });
});

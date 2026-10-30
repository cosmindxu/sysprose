/**
 * The SMT encoder, with no solver anywhere in the file.
 *
 * That is the first property this suite asserts by existing: `z3-solver` is an
 * OPTIONAL dependency, and everything about what a relation BECOMES — the term,
 * the fragment, the `≠ 0` guard, the refusals, the bytes of the script — has to
 * be checkable on a machine that never installed it. `src/semantics/smt/encode.ts`
 * imports nothing from `z3-solver`, and this file exercises it end to end.
 *
 * What it is really guarding, case by case:
 *
 *  - **Exactness.** `18.5` is `(/ 37.0 2.0)` and `0.1` is the tenth the author
 *    wrote, in every relation and every proof context — not the binary64 the
 *    file parsed to. Two readings of one numeral decided ties by which reading
 *    a relation fell under, and `0.1 + 0.2 > 0.3` was PROVED.
 *  - **SI, once.** The declaration is the STORED magnitude and the read is
 *    `factor·x + offset`, so `45.0 [min]` meets `2700` and a witness stays a
 *    number a reader can find in the file.
 *  - **No scaling where the gates granted none.** `range = 5.0 [km]` against a
 *    bare `10.0` is the declared-unit contract; scaling it would report
 *    `5000 <= 10` for a constraint that holds.
 *  - **The fragment rule.** Freeing a divisor promotes QF_LRA to QF_NRA, and
 *    the encoding NAMES the variable that did it — the plan's own wording.
 *  - **Agreement with the inventory.** The `nonlinear` answer here and the one
 *    `readRelation` computes are asserted equal over a corpus of bodies, so the
 *    second engine's fragment claim cannot drift from the first's.
 *  - **Byte-stability.** Element ids are fresh UUIDs on every load, so two
 *    encodes of one file must be the same bytes and no id may appear in them.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Model, ElementRecord } from '@core/index';
import { readRelation, type RelationReading } from '@semantics/index';
import { parseExpr } from '@semantics/expr';
import { cacheReadings } from '@semantics/contracts';
import * as unitLiterals from '@semantics/unit-literals';
import {
  decimalRational,
  encodeRelation,
  encodeScript,
  encodeVariables,
  encodeVariablesOf,
  exactNumeral,
  exactRationalOfDouble,
  notTerm,
  numeralRational,
  scaleRational,
  symbolOf,
  valueTextNumeral,
  type EncodeVariable,
} from '@semantics/smt/encode';
import { logicFromShape, shapeOfTerm, SHAPE_BITS, type ShapeFacts } from '@semantics/smt/shape';
import {
  addRationals,
  compareRationals,
  decideComparison,
  divideRationals,
  evaluateDecided,
  multiplyRationals,
  powerRational,
  remainderRational,
  rereadRelation,
  siRational,
  statedRational,
  termRational,
} from '@semantics/exact';
import { obligationsOf } from '@semantics/obligations';
import { BINARY_PREFIXES, SI_PREFIXES, UNIT_REGISTRY, resolveUnit } from '@semantics/units';
import { loadModelText } from '@text/load';
import { collect, corpusItems } from '../../scripts/census-constraint-classes';
import {
  SHAPE_LOGIC,
  astShape,
  extractProbes,
  invariantsHold,
  mergeCensus,
  readingOf,
  shapeOfBytes,
  termFacts,
  type ShapeId,
} from '../../scripts/lib/class-census';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

async function load(text: string, name = 'probe.sysml'): Promise<Model> {
  const { model } = await loadModelText(text, { fileName: name });
  if (!model) throw new Error(`${name} produced no model`);
  return model;
}

/** Every constraint body in the model, as the gates read it. */
function relations(model: Model): Array<{ el: ElementRecord; reading: RelationReading }> {
  const out: Array<{ el: ElementRecord; reading: RelationReading }> = [];
  for (const el of model.all()) {
    if (el.eClass !== 'ConstraintUsage') continue;
    const raw = el.attrs.expression;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    out.push({ el, reading: readRelation(model, el, raw, new Map()) });
  }
  return out;
}

/** The one relation whose body contains `needle`. */
function relationWith(model: Model, needle: string): RelationReading {
  const hit = relations(model).find((r) => r.reading.expression.includes(needle));
  if (!hit) throw new Error(`no relation body contains \`${needle}\``);
  return hit.reading;
}

/** A hand-built variable, for the cases that are about the encoder and not the model. */
function v(
  path: string,
  over: Partial<EncodeVariable> = {},
): EncodeVariable {
  return {
    path,
    qualifiedName: `P::${path}`,
    sort: 'Real',
    factor: 1,
    offset: 0,
    free: false,
    ...over,
  };
}

/** Encode a body written as text, against hand-built variables. */
function encode(body: string, vars: EncodeVariable[]) {
  return encodeRelation(parseExpr(body), vars);
}

/* ────────────────────────────── numerals ────────────────────────────────── */

describe('numerals are exact rationals: the decimal written, or a double’s own', () => {
  it('writes a double as the rational it exactly is', () => {
    expect(exactNumeral(2700)).toBe('2700.0');
    expect(exactNumeral(18.5)).toBe('(/ 37.0 2.0)');
    expect(exactNumeral(0.5)).toBe('(/ 1.0 2.0)');
    expect(exactNumeral(-25)).toBe('(- 25.0)');
    expect(exactNumeral(0)).toBe('0.0');
  });

  it('writes a double as its own rational, not as the decimal it prints as', () => {
    // 0.1 is 3602879701896397 · 2⁻⁵⁵. `exactNumeral` is for a number the tool
    // sets itself (the free-domain bound); a numeral the AUTHOR wrote is read
    // as its decimal (below), and the difference is exactly where a boundary
    // verdict flips.
    expect(exactNumeral(0.1)).toBe('(/ 3602879701896397.0 36028797018963968.0)');
    expect(exactNumeral(0.1 + 0.2)).not.toBe(exactNumeral(0.3));
  });

  it('prefers the author’s own text, where the tool has it', () => {
    expect(valueTextNumeral('18.5')).toEqual({ ok: true, text: '(/ 37.0 2.0)' });
    expect(valueTextNumeral('0.1')).toEqual({ ok: true, text: '(/ 1.0 10.0)' });
    expect(valueTextNumeral('1.5e3')).toEqual({ ok: true, text: '1500.0' });
    expect(valueTextNumeral('-2.50')).toEqual({ ok: true, text: '(- (/ 5.0 2.0))' });
    // The whole point of the pair: one tenth is not the double, and the text
    // route says one tenth.
    expect(valueTextNumeral('0.1')).not.toEqual({ ok: true, text: exactNumeral(0.1) });
  });

  it('refuses a value it cannot read as an exact rational, rather than coercing it', () => {
    const r = valueTextNumeral('about 3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.reason).toBe('non-numeric-operand');
  });

  it('encodes a BODY literal as the author’s decimal, not as the double', () => {
    // One reading for every numeral: a goal, a premise and a feature's value
    // axiom are all the decimals the author wrote, so no boundary case is
    // decided by which side of the proof a number arrived on.
    const r = encode('x >= 0.1', [v('x')]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.term).toBe('(>= |P::x| (/ 1.0 10.0))');
    expect(r.term).not.toContain(exactNumeral(0.1));
    // Arithmetic over plain numbers is the author's: three tenths, exactly.
    const sum = encode('x + 0.2 == 0.3', [v('x')]);
    expect(sum.ok && sum.term).toBe('(= (+ |P::x| (/ 1.0 5.0)) (/ 3.0 10.0))');
  });

  it('reads a numeral of up to 15 significant digits as the decimal written', () => {
    // The double determines such a decimal: it is the shortest that round-trips.
    expect(encode('x == 0.9999999999', [v('x')])).toMatchObject({
      ok: true,
      term: '(= |P::x| (/ 9999999999.0 10000000000.0))',
    });
    expect(encode('x == 1e-17', [v('x')])).toMatchObject({
      ok: true,
      term: '(= |P::x| (/ 1.0 100000000000000000.0))',
    });
    // Zeros are not digits the double has to carry.
    expect(encode('x == 0.30000000000000000000', [v('x')])).toMatchObject({
      ok: true,
      term: '(= |P::x| (/ 3.0 10.0))',
    });
    expect(encode('x == 0.00000000000000001', [v('x')])).toMatchObject({
      ok: true,
      term: '(= |P::x| (/ 1.0 100000000000000000.0))',
    });
  });

  it('reads a numeral written past 15 significant digits as the double it parses to', () => {
    // `0.29999999999999999` and `0.3` are one double, which prints as `0.3`.
    // Read as that print, the numeral was three tenths beside decimals, and
    // `0.1 + 0.2 <= 0.29999999999999999` was PROVED. It is the double: the
    // number every binary64 surface holds, never a third number.
    expect(parseExpr('0.29999999999999999')).toEqual({ kind: 'num', value: 0.3, text: '0.29999999999999999' });
    expect(parseExpr('0.3')).toEqual({ kind: 'num', value: 0.3 });
    expect(encode('x <= 0.29999999999999999', [v('x')])).toMatchObject({
      ok: true,
      term: `(<= |P::x| ${exactNumeral(0.3)})`,
    });
    expect(encode('x <= 0.3', [v('x')])).toMatchObject({ ok: true, term: '(<= |P::x| (/ 3.0 10.0))' });
    const long = encode('x == 0.12345678901234567891', [v('x')]);
    expect(long.ok && long.term).toBe(`(= |P::x| ${exactNumeral(0.12345678901234568)})`);
    // A `[unit]` literal's magnitude and an author's value text, by the same rule.
    const lowered = {
      kind: 'binary' as const,
      op: '<=' as const,
      left: parseExpr('x'),
      right: { kind: 'num' as const, value: 0.3, literal: { magnitude: '0.29999999999999999', factor: 1 } },
    };
    expect(encodeRelation(lowered, [v('x')])).toMatchObject({ ok: true, term: `(<= |P::x| ${exactNumeral(0.3)})` });
    expect(valueTextNumeral('0.29999999999999999')).toEqual({ ok: true, text: exactNumeral(0.3) });
  });
});

/* ───────────────────────────── the term shapes ──────────────────────────── */

describe('an expression becomes a term', () => {
  it('encodes comparisons, connectives and `if` in the SMT-LIB spellings', () => {
    const vars = [v('x'), v('y'), v('p', { sort: 'Bool' })];
    expect(encode('x >= y', vars)).toMatchObject({ term: '(>= |P::x| |P::y|)' });
    expect(encode('x != y', vars)).toMatchObject({ term: '(distinct |P::x| |P::y|)' });
    expect(encode('x == y', vars)).toMatchObject({ term: '(= |P::x| |P::y|)' });
    expect(encode('p implies x > 0.0', vars)).toMatchObject({
      term: '(=> |P::p| (> |P::x| 0.0))',
    });
    expect(encode('not p', vars)).toMatchObject({ term: '(not |P::p|)' });
    expect(encode('(if p then x else y) >= 1.0', vars)).toMatchObject({
      term: '(>= (ite |P::p| |P::x| |P::y|) 1.0)',
    });
    expect(encode('x ^ 3 <= y', vars)).toMatchObject({
      term: '(<= (* |P::x| |P::x| |P::x|) |P::y|)',
    });
  });

  it('reads a NEGATIVE literal exponent, which the parser writes as a unary minus', () => {
    // `parseExpr('x ^ -2')` is `binary(^, ref x, unary(-, num 2))`: the sign is
    // its own node. A `node.right.kind === 'num'` test would call a written
    // literal "not a literal" and make the reciprocal arm — and the `≠ 0` guard
    // it owes — unreachable from any body a person can type.
    const r = encode('x ^ -2 <= y', [v('x'), v('y')]);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.refusal)).toBe(true);
    if (!r.ok) return;
    expect(r.term).toBe('(<= (/ 1.0 (* |P::x| |P::x|)) |P::y|)');
    expect(r.sideConditions).toHaveLength(1);
    expect(r.sideConditions[0].term).toBe('(distinct |P::x| 0.0)');
    expect(r.syntacticNonlinear, 'a reciprocal is nonlinear bytes').toBe(true);
  });

  it('reads an Int-sorted feature through `to_real`, so no comparison is ill-sorted', () => {
    const vars = [v('n', { sort: 'Int' }), v('x')];
    expect(encode('n <= x', vars)).toMatchObject({ term: '(<= (to_real |P::n|) |P::x|)' });
    const script = encodeScript({
      variables: vars,
      assertions: [{ kind: 'goal', name: 'R', term: '(<= (to_real |P::n|) |P::x|)' }],
      nonlinear: false,
    });
    // The declaration keeps the integrality; the logic says so.
    expect(script.text).toContain('(declare-fun |P::n| () Int)');
    expect(script.logic).toBe('QF_LIRA');
    expect(script.fragment).toBe('qf-lra');
  });

  it('negates a goal without re-encoding it', () => {
    expect(notTerm('(>= |P::x| 1.0)')).toBe('(not (>= |P::x| 1.0))');
  });
});

describe('what the encoder refuses, and with which reason', () => {
  const vars = [v('x'), v('y'), v('p', { sort: 'Bool' })];
  const cases: Array<[string, string, string]> = [
    ['x % 2.0 == 0.0', 'unsupported-operator', 'the remainder operator'],
    ['x ^ y >= 1.0', 'unsupported-operator', 'the exponent is not a literal'],
    ['x ^ 0.5 >= 1.0', 'unsupported-operator', 'is not an integer'],
    ['x / 0.0 >= 1.0', 'unsupported-operator', 'divides by the literal zero'],
    ['x == "abc"', 'non-numeric-operand', 'string literal'],
    ['x == null', 'non-numeric-operand', '`null`'],
    ['p + x >= 1.0', 'non-numeric-operand', 'two numbers'],
    ['x and p', 'non-numeric-operand', 'two booleans'],
    ['x == p', 'non-numeric-operand', 'compares a real with a bool'],
    ['nowhere >= 1.0', 'unresolved-name', 'names nothing the encoder'],
    ['x + y', 'non-numeric-operand', 'not a proposition'],
  ];
  for (const [body, reason, needle] of cases) {
    it(`refuses \`${body}\` as ${reason}`, () => {
      const r = encode(body, vars);
      expect(r.ok, `\`${body}\` was encoded`).toBe(false);
      if (r.ok) return;
      expect(r.refusal.reason).toBe(reason);
      expect(r.refusal.detail).toContain(needle);
    });
  }

  it('refuses a scale a factor of zero or a non-finite number would make', () => {
    // `exactNumeral` THROWS on a non-finite number, and this module's charter is
    // that everything it cannot encode comes back as a refusal. A zero factor is
    // worse than a throw: `(* 0.0 |x|)` deletes the variable from the relation.
    for (const over of [{ factor: NaN }, { factor: Number.POSITIVE_INFINITY }, { factor: 0 }, { offset: NaN }]) {
      const r = encode('x >= 1.0', [v('x', over)]);
      expect(r.ok, `${JSON.stringify(over)} was encoded`).toBe(false);
      if (r.ok) continue;
      expect(r.refusal.reason).toBe('unscalable');
      expect(r.refusal.detail).toContain('finite non-zero');
    }
  });

  it('refuses a qualified name no SMT symbol can carry, rather than mangling it', () => {
    const r = encode('x >= 1.0', [v('x', { qualifiedName: 'P::a|b' })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.reason).toBe('unparseable');
    expect(symbolOf('P::a|b')).toBeUndefined();
    expect(symbolOf('P::uav::mtow')).toBe('|P::uav::mtow|');
  });
});

/* ─────────────────────── division, and saying so ────────────────────────── */

describe('a variable divisor is guarded, and the guard is reported', () => {
  it('adds `≠ 0` and names the divisor', () => {
    const r = encode('x / d >= 1.0', [v('x'), v('d', { free: true })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sideConditions).toHaveLength(1);
    expect(r.sideConditions[0].term).toBe('(distinct |P::d| 0.0)');
    expect(r.sideConditions[0].variables).toEqual(['P::d']);
    expect(r.sideConditions[0].detail).toContain('non-zero');
    expect(r.sideConditions[0].detail).toContain('P::d');
  });

  it('adds nothing when the divisor is a literal', () => {
    const r = encode('x / 2.0 >= 1.0', [v('x')]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sideConditions).toEqual([]);
  });
});

/* ─────────────────────────── the fragment rule ──────────────────────────── */

describe('the fragment rule — freeing a divisor promotes QF_LRA to QF_NRA', () => {
  const body = 'endurance == capacity * fraction / cruisePower';

  it('stays linear in the REPORT while the divisor is pinned, and says QF_NRA in the script', () => {
    const vars = [v('endurance', { free: true }), v('capacity'), v('fraction'), v('cruisePower')];
    const r = encode(body, vars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nonlinear).toBe(false);
    expect(r.nonlinearIn).toEqual([]);
    // The bytes are `(/ (* |capacity| |fraction|) |cruisePower|)` whatever pins
    // those three. z3 checks the `set-logic` line against the SYNTAX, so a
    // QF_LRA header here is a script z3 refuses outright — reported as `error`,
    // i.e. as a defect in our own output, not as a verdict about the model.
    expect(r.syntacticNonlinear).toBe(true);
    const script = encodeScript({
      variables: vars,
      assertions: [{ kind: 'goal', name: 'R', term: r.term }],
      nonlinear: r.nonlinear,
      syntacticNonlinear: r.syntacticNonlinear,
    });
    expect(script.logic).toBe('QF_NRA');
    // …and the REPORT keeps the plan's free-relative word.
    expect(script.fragment).toBe('qf-lra');
  });

  it('computes the logic line from the terms, even when the caller says nothing', () => {
    // The flag is an accelerator, never the authority: a caller that forgets it
    // — or one holding a hand-built term — still gets a logic the script fits.
    const nonlinear = encodeScript({
      variables: [v('a'), v('b')],
      assertions: [{ kind: 'goal', name: 'R', term: '(>= (* |P::a| |P::b|) 1.0)' }],
      nonlinear: false,
    });
    expect(nonlinear.logic).toBe('QF_NRA');
    expect(nonlinear.fragment).toBe('qf-lra');
    // A literal coefficient is still linear, and `(- 3.0)` / `(/ 37.0 2.0)` are
    // numerals rather than variables — a scan that missed that would promote
    // every script with a negative constant in it.
    const linear = encodeScript({
      variables: [v('a')],
      assertions: [
        { kind: 'goal', name: 'R', term: '(>= (* 60.0 |P::a|) (- (/ 37.0 2.0)))' },
        { kind: 'axiom', name: 'A', term: '(= |P::a| (/ |P::a| 2.0))' },
      ],
      nonlinear: false,
    });
    expect(linear.logic).toBe('QF_LRA');
  });

  it('is nonlinear once the divisor is freed, and NAMES it', () => {
    const vars = [
      v('endurance', { free: true }),
      v('capacity'),
      v('fraction'),
      v('cruisePower', { free: true }),
    ];
    const r = encode(body, vars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nonlinear).toBe(true);
    expect(r.nonlinearIn).toEqual(['P::cruisePower']);
    const script = encodeScript({
      variables: vars,
      assertions: [{ kind: 'goal', name: 'R', term: r.term }],
      nonlinear: r.nonlinear,
      syntacticNonlinear: r.syntacticNonlinear,
    });
    expect(script.logic).toBe('QF_NRA');
    expect(script.fragment).toBe('qf-nra');
  });

  it('is nonlinear for a product of two freed variables', () => {
    const r = encode('a * b >= 1.0', [v('a', { free: true }), v('b', { free: true })]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nonlinear).toBe(true);
      expect(r.nonlinearIn).toEqual(['P::a', 'P::b']);
    }
    const pinned = encode('a * b >= 1.0', [v('a', { free: true }), v('b')]);
    // Split, because `pinned.ok && pinned.nonlinear` is also `false` when the
    // encode was REFUSED — the conjunction short-circuits and the case passes
    // while asserting nothing about the fragment at all.
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.nonlinear).toBe(false);
    expect(pinned.syntacticNonlinear, 'the bytes are still a product of two symbols').toBe(true);
  });
});

/* ──────────────────── SI scaling, through the real gates ────────────────── */

const SCALED = `package P {
    part def Air {
        attribute duration : ISQ::DurationValue = 50.0 [min];
        attribute mass : ISQ::MassValue = 1.2 [kg];
    }
    part air : Air;
    requirement def Endurance {
        subject air : Air;
        require constraint { air.duration >= 45.0 [min] }
    }
}`;

const UNSCALED = `package P {
    part def Sensor {
        attribute range : ISQ::LengthValue = 5.0 [km];
    }
    part eo : Sensor;
    requirement def Reach {
        subject eo : Sensor;
        require constraint { eo.range <= 10.0 }
    }
}`;

/** °C stored, kelvin compared: the one scale in this lane with an OFFSET. */
const CELSIUS = `package P {
    part def Oven {
        attribute temp : ISQ::ThermodynamicTemperatureValue = 20.0 ['°C'];
    }
    part o : Oven;
    requirement def Limit {
        subject o : Oven;
        require constraint { o.temp <= 300.0 [K] }
    }
}`;

/** The same requirement over a feature already stored in kelvin. */
const KELVIN = CELSIUS.replace("20.0 ['°C']", '293.15 [K]');

describe('SI scaling is the gates’ decision, and the encoder follows it', () => {
  it('lifts an ORDERING on °C into kelvin, offset and all', async () => {
    // §6's trap table: ordering on °C is encoded in kelvin, a monotone affine
    // map. This is the only branch of `factor·x + offset` where the offset is
    // not zero, and a dropped or sign-flipped offset flips every temperature
    // verdict by 273.15 without moving a single other case.
    const model = await load(CELSIUS);
    const reading = relationWith(model, 'temp');
    expect(reading.encodable, JSON.stringify(reading.encodable)).toBe(true);

    const vars = encodeVariablesOf(reading);
    const temp = vars.find((x) => x.path === 'o.temp');
    expect(temp?.factor, '°C and K are the same size of degree').toBe(1);
    expect(temp?.offset, '0 °C is 273.15 K').toBe(273.15);

    const r = encodeRelation(reading.node!, vars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Exact, and the number the registry WROTE: 273.15 is 5463/20 — not the
    // double, a little less — so a stored `20.0 [°C]` read through it is the
    // `293.15 [K]` a `[K]` literal is read as (`scaleRational` in the encoder).
    expect(r.term).toBe('(<= (+ |P::Oven::temp| (/ 5463.0 20.0)) 300.0)');
    expect(r.term).not.toContain(exactNumeral(273.15));
  });

  it('adds no offset where the feature is already stored in kelvin', async () => {
    const model = await load(KELVIN);
    const reading = relationWith(model, 'temp');
    const vars = encodeVariablesOf(reading);
    expect(vars.find((x) => x.path === 'o.temp')?.offset).toBe(0);
    const r = encodeRelation(reading.node!, vars);
    expect(r.ok && r.term).toBe('(<= |P::Oven::temp| 300.0)');
  });

  it('declares the stored magnitude and reads `factor·x`, with the literal in SI', async () => {
    const model = await load(SCALED);
    const reading = relationWith(model, 'duration');
    expect(reading.encodable, JSON.stringify(reading.encodable)).toBe(true);
    expect(reading.scale, 'the gates granted a scale for a body with a `[unit]` literal').toBeDefined();

    const vars = encodeVariablesOf(reading);
    const duration = vars.find((x) => x.path === 'air.duration');
    expect(duration?.factor, 'minutes are 60 seconds').toBe(60);

    const r = encodeRelation(reading.node!, vars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `45.0 [min]` is 2700 s, and the variable is lifted into the same seconds.
    expect(r.term).toContain('2700.0');
    expect(r.term).toContain('(* 60.0 |P::Air::duration|)');

    const script = encodeScript({
      variables: vars,
      assertions: [{ kind: 'goal', name: 'R-1', term: r.term }],
      nonlinear: r.nonlinear,
    });
    expect(script.text).toContain('(declare-fun |P::Air::duration| () Real)');
    // Only the variables the term reads are declared: `mass` is in scope and
    // unread, and a declaration for it would be an unconstrained variable in
    // every model z3 returned.
    expect(script.text).not.toContain('P::Air::mass');
  });

  it('leaves a relation the gates did not scale in its own magnitudes', async () => {
    const model = await load(UNSCALED);
    const reading = relationWith(model, 'range');
    expect(reading.encodable).toBe(true);
    // The declared-unit contract: a bare `10.0` beside a kilometre feature is
    // ten kilometres, and the gates decline to scale precisely so that both
    // surfaces read it that way.
    expect(reading.scale).toBeUndefined();

    const r = encodeRelation(reading.node!, encodeVariablesOf(reading));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.term).toBe('(<= |P::Sensor::range| 10.0)');
    expect(r.term, 'scaling here would report 5000 <= 10 for a constraint that holds').not.toContain(
      '1000.0',
    );
  });

  it('an explicit `scaled: false` is the same reading as no ScaleMap', async () => {
    const model = await load(SCALED);
    const reading = relationWith(model, 'duration');
    const vars = encodeVariables(reading.variables, reading.sortPerVar, { scaled: false });
    const r = encodeRelation(reading.node!, vars);
    expect(r.ok && r.term).toContain('|P::Air::duration|');
    expect(r.ok && r.term).not.toContain('(* 60.0');
  });
});

/* ───────────────── agreement with the inventory’s own gates ─────────────── */

const CORPUS = `package P {
    part def Sys {
        attribute a : Real = 2.0;
        attribute b : Real = 3.0;
        attribute open : Real;
        attribute other : Real;
        attribute seats : Integer = 4;
        attribute many : Real[0..*];
    }
    part s : Sys;
    requirement def Linear   { subject s : Sys; require constraint { s.a * s.open >= 1.0 } }
    requirement def Product  { subject s : Sys; require constraint { s.open * s.other >= 1.0 } }
    requirement def Quotient { subject s : Sys; require constraint { s.a / s.open >= 1.0 } }
    requirement def Divisor  { subject s : Sys; require constraint { s.open / s.a >= 1.0 } }
    requirement def Power    { subject s : Sys; require constraint { s.open ^ 2 >= 1.0 } }
    requirement def Remainder{ subject s : Sys; require constraint { s.seats % 2 == 0 } }
    requirement def Collect  { subject s : Sys; require constraint { s.many >= 1.0 } }
}`;

describe('the encoder’s fragment and the inventory’s agree, body by body', () => {
  it('answers `nonlinear` exactly as `readRelation` does over the same free set', async () => {
    const model = await load(CORPUS);
    // The inventory's own free set: a feature with no literal value. Written
    // out here rather than imported, because the point of the case is that two
    // implementations agree, and sharing the predicate would prove nothing.
    const free = new Set(['s.open', 's.other', 's.many']);
    let compared = 0;
    for (const { reading } of relations(model)) {
      if (reading.encodable !== true || reading.node === null) continue;
      const r = encodeRelation(reading.node, encodeVariablesOf(reading, free));
      if (!r.ok) continue;
      expect(r.nonlinear, `${reading.expression}: fragment disagreement`).toBe(reading.nonlinear);
      compared += 1;
    }
    expect(compared, 'the corpus produced nothing to compare').toBeGreaterThanOrEqual(4);
  });

  it('never sees a collection or a remainder — the gates refuse them first', async () => {
    const model = await load(CORPUS);
    const many = relationWith(model, 's.many');
    expect(many.encodable).not.toBe(true);
    if (many.encodable !== true) expect(many.encodable.reason).toBe('collection-valued');
    const rem = relationWith(model, '%');
    expect(rem.encodable).not.toBe(true);
    if (rem.encodable !== true) expect(rem.encodable.reason).toBe('unsupported-operator');
  });
});

/* ──────────────────────────── the script bytes ──────────────────────────── */

describe('the script is byte-stable, and carries no element id', () => {
  it('encodes the shipped example identically from two independent loads', async () => {
    const text = read('examples/uav-isr.sysml');
    const first = await load(text, 'examples/uav-isr.sysml');
    const second = await load(text, 'examples/uav-isr.sysml');

    const scriptOf = (model: Model): string => {
      const assertions: Array<{ kind: 'goal'; name: string; term: string }> = [];
      const variables: EncodeVariable[] = [];
      for (const { el, reading } of relations(model)) {
        if (reading.encodable !== true || reading.node === null) continue;
        const vars = encodeVariablesOf(reading);
        const r = encodeRelation(reading.node, vars);
        if (!r.ok) continue;
        variables.push(...vars);
        assertions.push({ kind: 'goal', name: model.qualifiedName(el.id), term: r.term });
      }
      assertions.sort((a, b) => (a.name < b.name ? -1 : 1));
      return encodeScript({ variables, assertions, nonlinear: false }).text;
    };

    const a = scriptOf(first);
    const b = scriptOf(second);
    expect(a.length, 'the example encoded nothing at all').toBeGreaterThan(200);
    expect(a).toBe(b);
    // Two loads of one file share no user element id, so an id in the bytes
    // would have made the two scripts differ — this asserts the reason as well
    // as the symptom.
    expect(a).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(a).toContain('|UAVSurveillanceSystem::AirVehicle::');
  });

  it('makes a label unique AFTER the mangling a quoted symbol forces', () => {
    // `|` and `\` cannot appear inside a quoted SMT symbol, so both names below
    // are written `axiom:P::a_b`. Deduplicating on the RAW name emits that label
    // twice, which z3 refuses outright ("named expression already defined") and
    // which would otherwise attribute an unsat core to the wrong requirement.
    const script = encodeScript({
      variables: [v('x')],
      assertions: [
        { kind: 'axiom', name: 'P::a|b', term: '(= |P::x| 1.0)' },
        { kind: 'axiom', name: 'P::a_b', term: '(= |P::x| 2.0)' },
      ],
      nonlinear: false,
    });
    expect(script.labels).toEqual(['axiom:P::a_b', 'axiom:P::a_b#2']);
    // The reported labels are the ones in the bytes, because `coreOf` reads
    // these strings back out of z3 and a caller matches them by string.
    for (const label of script.labels) expect(script.text).toContain(`:named |${label}|`);
    expect(new Set(script.labels).size).toBe(script.labels.length);
  });

  it('declares in symbol order, labels every assertion once, and asserts no check', () => {
    const vars = [v('z'), v('a'), v('a')];
    const script = encodeScript({
      variables: vars,
      assertions: [
        { kind: 'axiom', name: 'P::a', term: '(= |P::a| 1.0)' },
        { kind: 'axiom', name: 'P::a', term: '(= |P::a| 2.0)' },
        { kind: 'goal', name: 'R-1', term: '(>= |P::z| |P::a|)' },
      ],
      nonlinear: false,
    });
    expect(script.symbols).toEqual(['P::a', 'P::z']);
    expect(script.labels).toEqual(['axiom:P::a', 'axiom:P::a#2', 'goal:R-1']);
    // The bridge calls `check()` itself and an export appends its own; emitting
    // one here would make z3 run a check while merely parsing the script.
    expect(script.text).not.toContain('(check-sat)');
    expect(script.text).toContain('(set-option :produce-unsat-cores true)');
    expect(script.text.startsWith('; sysprose')).toBe(true);
    expect(script.text.endsWith('\n')).toBe(true);
  });
});

/*
 * A stored magnitude read into SI and a `[unit]` literal go through ONE
 * reading of the unit's factor. The variable side read `1.0 [g]` through the
 * decimal thousandth and the literal side was the double 0.001 rounded from
 * the product, so `m != 1.0 [g]` over `m = 1.0 [g]` was PROVED — a false
 * requirement passed — and `m == 1.0 [g]` could not be.
 */
describe('a `[unit]` literal and a stored magnitude are one number', () => {
  it('reads both through the same factor, as the decimal the registry writes', async () => {
    const model = await load(`package G {
  attribute m : ISQ::MassValue = 1.0 [g];
  attribute v : ISQ::SpeedValue = 36.0 [km/h];
  constraint c { m != 1.0 [g] }
  constraint k { v == 10.0 [m/s] }
}`);
    const gram = relationWith(model, 'm != 1.0 [g]');
    const r = encodeRelation(gram.node!, encodeVariablesOf(gram));
    expect(r.ok && r.term).toBe('(distinct (* (/ 1.0 1000.0) |G::m|) (/ 1.0 1000.0))');
    // A ratio's factor is the fraction that rounds to its double: km/h is 5/18.
    const speed = relationWith(model, 'v == 10.0 [m/s]');
    const s = encodeRelation(speed.node!, encodeVariablesOf(speed));
    expect(s.ok && s.term).toBe('(= (* (/ 5.0 18.0) |G::v|) 10.0)');
  });

  it('reads a composed unit as the product of its parts, on a stored magnitude and a literal alike', async () => {
    const model = await load(`package C {
  attribute v : ISQ::VolumeValue = 1.0 [ft^3];
  attribute rho : ISQ::MassDensityValue = 1.0 [g/cm^3];
  attribute w : ISQ::VolumeValue = 0.028316846592 [m^3];
  constraint a { v > 0.028316846592 [m^3] }
  constraint b { rho < 1000.0 [kg/m^3] }
  constraint c { w < 1.0 [ft^3] }
}`);
    const termOf = (needle: string): string => {
      const reading = relationWith(model, needle);
      const r = encodeRelation(reading.node!, encodeVariablesOf(reading));
      return r.ok ? r.term : `refused: ${r.refusal.reason}`;
    };
    // 0.3048³ = 0.028316846592 exactly, where the double is 0.028316846592000004:
    // read as that double, `1 [ft^3] > 0.028316846592 [m^3]` was PROVED.
    const ft3 = '(/ 55306341.0 1953125000.0)';
    expect(termOf('v > 0.028316846592 [m^3]')).toBe(`(> (* ${ft3} |C::v|) ${ft3})`);
    // 10⁻³ / (10⁻²)³ = 1000, where the double is 999.9999999999999.
    expect(termOf('rho < 1000.0 [kg/m^3]')).toBe('(< (* 1000.0 |C::rho|) 1000.0)');
    expect(termOf('w < 1.0 [ft^3]')).toBe(`(< |C::w| ${ft3})`);
  });

  it('reads the numerals of a plain relation and a scaled one alike, as the decimals written', () => {
    const node = parseExpr('x == 0.1');
    const plain = encodeRelation(node, [v('x')]);
    expect(plain.ok && plain.term).toBe('(= |P::x| (/ 1.0 10.0))');
    const scaled = encodeRelation(node, [v('x', { factor: 0.001 })]);
    expect(scaled.ok && scaled.term).toBe('(= (* (/ 1.0 1000.0) |P::x|) (/ 1.0 10.0))');
  });
});

/*
 * The registry's factors and origins are the numbers they DEFINE, read back
 * exactly. A factor computed in doubles (`231 * 0.0254 ** 3` for the gallon,
 * `273.15 - 32 * (5 / 9)` for the °F origin) rounds twice and lands an ulp
 * off; the encoder then reads the double's own rational, and every exact tie
 * across units broke one way — `32 °F < 273.15 K` was PROVED.
 */
describe('every unit of the registry is read as the number it defines', () => {
  /** Units defined by a ratio, or written as a computation, with their defining rational. */
  const DEFINED: Record<string, { factor?: [bigint, bigint]; offset?: [bigint, bigint] }> = {
    '°C': { offset: [27315n, 100n] },
    '°F': { factor: [5n, 9n], offset: [45967n, 180n] },
    // 1 oz ≡ 1/16 lb.
    oz: { factor: [45359237n, 1600000000n] },
    // 231 in³.
    gal: { factor: [3785411784n, 1000000000000n] },
  };
  /** Irrational by definition (log₂10, 1/ln 2): no rational to read back. */
  const IRRATIONAL = new Set(['Hart', 'nat']);
  const lowest = ([n, d]: [bigint, bigint]): string => {
    let [a, b] = [n < 0n ? -n : n, d];
    while (b !== 0n) [a, b] = [b, a % b];
    return `${n / a}/${d / a}`;
  };
  const read = (x: number): string => {
    const r = scaleRational(x);
    return lowest([r.num, r.den]);
  };
  /** The decimal the registry writes, as a rational — and that it IS a short decimal, not a computed double. */
  const written = (x: number): string => {
    const text = String(x);
    const digits = text.replace(/^-/, '').split(/e/i)[0]!.replace('.', '').replace(/^0+/, '').length;
    expect(digits, `${text} is a computed double, not a decimal the registry writes`).toBeLessThanOrEqual(15);
    const [whole, frac = ''] = text.split('.');
    return lowest([BigInt(whole! + frac), 10n ** BigInt(frac.length)]);
  };

  it('reads each factor and origin back to its defining rational', () => {
    for (const u of UNIT_REGISTRY) {
      if (IRRATIONAL.has(u.symbol)) continue;
      const defined = DEFINED[u.symbol];
      expect(read(u.factorToSI), `${u.symbol} factor`).toBe(
        defined?.factor ? lowest(defined.factor) : written(u.factorToSI),
      );
      if (u.offsetSI !== undefined && u.offsetSI !== 0) {
        expect(defined?.offset, `${u.symbol} has an origin with no defining rational here`).toBeDefined();
        expect(read(u.offsetSI), `${u.symbol} origin`).toBe(lowest(defined!.offset!));
      }
    }
  });

  /** Composed units with the rational their parts define. */
  const COMPOSED: Record<string, [bigint, bigint]> = {
    // 0.3048³ m³.
    'ft^3': [28316846592n, 10n ** 12n],
    // 10⁻³ kg / (10⁻² m)³.
    'g/cm^3': [1000n, 1n],
    // 10³ m / 3600 s.
    'km/h': [1000n, 3600n],
    // 10³ · 3600 J.
    kWh: [3600000n, 1n],
    // 10⁻³ A · 3600 s.
    'mA*h': [3600n, 1000n],
    'N*m': [1n, 1n],
    // 10⁻³ m³ / 60 s.
    'L/min': [1n, 60000n],
    // 231 in³ / 60 s.
    'gal/min': [3785411784n, 60n * 10n ** 12n],
    'm/s^2': [1n, 1n],
    'kg*m^2/s^2': [1n, 1n],
    // 3600 J / 10³ m.
    'W*h/km': [3600n, 1000n],
  };
  /** A unit's factor as the encoder reads it: from its parts when it is composed. */
  const readUnit = (ref: string): string => {
    const u = resolveUnit(ref);
    expect(u, `${ref} resolves`).toBeDefined();
    const r = scaleRational(u!.factorToSI, u!.factorTerms);
    return lowest([r.num, r.den]);
  };

  it('reads each composed unit back to the rational its parts define', () => {
    for (const [ref, defined] of Object.entries(COMPOSED)) {
      expect(readUnit(ref), ref).toBe(lowest(defined));
    }
    // The doubles stay what every numeric surface reads; only the exact reader
    // goes through the parts.
    expect(resolveUnit('ft^3')!.factorToSI).toBe(0.028316846592000004);
    expect(resolveUnit('g/cm^3')!.factorToSI).toBe(999.9999999999999);
  });

  it('reads every prefixed symbol as its row’s rational times its prefix’s', () => {
    let checked = 0;
    for (const u of UNIT_REGISTRY) {
      const prefixes = [...(u.prefixable ? SI_PREFIXES : []), ...(u.binaryPrefixable ? BINARY_PREFIXES : [])];
      for (const p of prefixes) {
        if (resolveUnit(`${p.symbol}${u.symbol}`)?.name !== `${p.name}${u.name}`) continue;
        const [row, prefix] = [scaleRational(u.factorToSI), scaleRational(p.factor)];
        expect(readUnit(`${p.symbol}${u.symbol}`), `${p.symbol}${u.symbol}`).toBe(
          lowest([row.num * prefix.num, row.den * prefix.den]),
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
    // A nanogram's double is 1.0000000000000002e-12 kg; it is read as 10⁻¹².
    expect(readUnit('ng')).toBe('1/1000000000000');
  });

  it('holds the °F origin and the gallon at their correctly rounded doubles (guard)', () => {
    const f = UNIT_REGISTRY.find((u) => u.symbol === '°F')!;
    expect(f.offsetSI).toBe(255.37222222222223);
    expect(UNIT_REGISTRY.find((u) => u.symbol === 'gal')!.factorToSI).toBe(0.003785411784);
  });

  /** Every unit a value can be written in: each row, each prefix it allows, and the dimension-one ratios. */
  const everyUnit = (): string[] => {
    const out: string[] = [];
    for (const u of UNIT_REGISTRY) {
      out.push(u.symbol);
      const prefixes = [...(u.prefixable ? SI_PREFIXES : []), ...(u.binaryPrefixable ? BINARY_PREFIXES : [])];
      for (const p of prefixes) {
        if (resolveUnit(`${p.symbol}${u.symbol}`)?.name === `${p.name}${u.name}`) out.push(`${p.symbol}${u.symbol}`);
      }
    }
    return [...out, 'km/m', 'mm/m', 'g/kg', 'min/s', 'L/m^3', 'B/bit', 'kWh/J', 'mi/km', 'lb/kg'];
  };

  it('states every literal value as the magnitude it stores, in every unit: the axiom takes no scale', async () => {
    // The gates scale a relation with anything to convert, and a unit of
    // DIMENSION ONE with a factor is no dimension against a bare literal — so
    // the axiom of `cap = 2.0 [GiB]` was scaled, `(= (* 8589934592.0 |cap|)
    // 2.0)`, and pinned 2 GiB to 2 bits. It states the stored magnitude.
    const units = everyUnit();
    expect(units.length).toBeGreaterThan(600);
    const model = await load(`package U {\n${units.map((u, i) => `  attribute x${i} = 1.5 ['${u}'];`).join('\n')}\n}`);
    const rows = obligationsOf(model).filter((r) => r.source === 'feature-value');
    expect(rows).toHaveLength(units.length);
    for (const row of rows) {
      const i = Number(row.element.qualifiedName.slice('U::x'.length));
      const r = encodeRelation(row.node!, encodeVariables(row.vars, row.sortPerVar, { scaled: row.scaled }));
      expect([row.scaled, r.ok && r.term], units[i]).toEqual([false, `(= |U::x${i}| (/ 3.0 2.0))`]);
    }
  });

  it('reads a value written `(expr) [unit]` as `expr` in that unit, and refuses one that relabels bits', async () => {
    const model = await load(`package L {
  attribute k : ScalarValues::Real = 0.5;
  attribute cap : ISQ::StorageCapacityValue = 1.5 [GiB];
  attribute t : ISQ::StorageCapacityValue = (k * 3.0) [GiB];
  attribute len : ISQ::LengthValue = (k * 3.0) [km];
  attribute dbl : ISQ::StorageCapacityValue = (cap * 2.0) [GiB];
}`);
    const rowOf = (needle: string) => obligationsOf(model).find((r) => r.element.qualifiedName === needle)!;
    const termOf = (needle: string) => {
      const row = rowOf(needle);
      const r = encodeRelation(row.node!, encodeVariables(row.vars, row.sortPerVar, { scaled: row.scaled }));
      return r.ok ? r.term : `refused: ${r.refusal.reason}`;
    };
    // The stored GiB on the left, `k * 3.0` GiB in bits on the right: t is 1.5.
    expect(rowOf('L::t').expression).toBe('t == (k * 3.0) [GiB]');
    expect(termOf('L::t')).toBe('(= (* 8589934592.0 |L::t|) (* (* |L::k| 3.0) 8589934592.0))');
    expect(termOf('L::len')).toBe('(= (* 1000.0 |L::len|) (* (* |L::k| 3.0) 1000.0))');
    expect(rowOf('L::dbl').encodable).toEqual({
      reason: 'refused-derivation',
      detail:
        '"dbl" cannot be derived: a unit literal [GiB] was applied to an operand computed from a value in "GiB" — dimension one is not unitless',
    });
  });
});

/*
 * ONE reading of a numeral, whatever the proof context holds: a plain
 * feature's value axiom and a goal that compares it with a quantity are read
 * the same way, or the tie is decided by which side of the proof each number
 * arrived on — and a context of plain numbers only is read as the author
 * wrote it too, where it once kept binary64 and PROVED `0.1 + 0.2 > 0.3`.
 */
describe('every numeral is its decimal, in every proof context', () => {
  it('reads every value axiom in decimals, whether or not a quantity or a `[unit]` literal meets it', async () => {
    const model = await load(`package D {
  attribute f : ScalarValues::Real = 0.1;
  attribute mass : ISQ::MassValue = 1.0 [kg];
  attribute load : ScalarValues::Real = 0.1;
  attribute a : ScalarValues::Real = 0.1;
  attribute b : ScalarValues::Real = 0.2;
  constraint m { f * mass != 0.1 [kg] }
  constraint u { load != 0.1 [E] }
  constraint p { a + b == 0.3 }
}`);
    const rows = obligationsOf(model);
    const termOf = (needle: string): string => {
      const row = rows.find((r) => r.element.qualifiedName === needle || r.expression.includes(needle))!;
      const vars = encodeVariables(row.vars, row.sortPerVar, { scaled: row.scaled });
      const r = encodeRelation(row.node!, vars);
      return r.ok ? r.term : `refused: ${r.refusal.reason}`;
    };
    // The value axiom of the plain `f` is one tenth, as the goal beside it reads 0.1 kg.
    expect(termOf('D::f')).toBe('(= |D::f| (/ 1.0 10.0))');
    expect(termOf('D::load')).toBe('(= |D::load| (/ 1.0 10.0))');
    // Nothing dimensioned meets `a`, `b` or `p`: still the decimals written,
    // and encoded one row at a time, with no context to consult.
    expect(termOf('D::a')).toBe('(= |D::a| (/ 1.0 10.0))');
    expect(termOf('D::b')).toBe('(= |D::b| (/ 1.0 5.0))');
    expect(termOf('a + b == 0.3')).toBe('(= (+ |D::a| |D::b|) (/ 3.0 10.0))');
  });

  it('reads a relation that carries a `[unit]` literal as the one that does not', () => {
    const node = parseExpr('x == 0.1');
    const lowered = { ...node, right: { kind: 'num' as const, value: 0.1, literal: { magnitude: '0.1', factor: 1 } } };
    const r = encodeRelation({ kind: 'binary', op: 'and', left: lowered, right: parseExpr('x <= 0.2') }, [v('x')]);
    expect(r.ok && r.term).toBe('(and (= |P::x| (/ 1.0 10.0)) (<= |P::x| (/ 1.0 5.0)))');
    expect(encode('x <= 0.2', [v('x')])).toMatchObject({ ok: true, term: '(<= |P::x| (/ 1.0 5.0))' });
  });

  it('reads a value written past 15 digits as the double, in its axiom as in a body', async () => {
    // The axiom once read the double's print (`m == 0.3`) and the `[unit]`
    // literal its text, so `m == 0.30000000000000001 [kg]` beside the value
    // that states it was called INCONSISTENT.
    const model = await load(`package L {
  attribute m : ISQ::MassValue = 0.30000000000000001 [kg];
  attribute f : ScalarValues::Real = 0.10000000000000001;
  constraint e { m == 0.30000000000000001 [kg] }
}`);
    const rows = obligationsOf(model);
    const rowOf = (needle: string) => rows.find((r) => r.element.qualifiedName === needle)!;
    const termOf = (needle: string): string => {
      const row = rowOf(needle);
      const r = encodeRelation(row.node!, encodeVariables(row.vars, row.sortPerVar, { scaled: row.scaled }));
      return r.ok ? r.term : `refused: ${r.refusal.reason}`;
    };
    expect(termOf('L::m')).toBe(`(= |L::m| ${exactNumeral(0.3)})`);
    expect(termOf('L::e')).toBe(`(= |L::m| ${exactNumeral(0.3)})`);
    expect(termOf('L::f')).toBe(`(= |L::f| ${exactNumeral(0.1)})`);
    // And the axiom is labelled with what the file says, not with the print.
    expect([rowOf('L::m').expression, rowOf('L::f').expression]).toEqual([
      'm == 0.30000000000000001',
      'f == 0.10000000000000001',
    ]);
  });
});

/* ─────────────── the point evaluators read numbers as the encoder does ─────────────── */

/*
 * THE TIE RULE (`src/semantics/exact.ts`): a point evaluator decides a
 * comparison by the exact rationals of the decimals written, wherever both
 * sides have one. Those rationals are only worth anything if they are the
 * encoder's own — a numeral, a unit factor and a witness value each read ONE
 * way — so they are pinned here, beside the encoder's reading of the same.
 */
describe('the point evaluators read a numeral, a unit and a witness as the encoder does', () => {
  const r = (num: bigint, den: bigint) => ({ num, den });

  it('reads a numeral as the rational `numeral` writes', () => {
    expect(numeralRational(parseExpr('0.1') as never)).toEqual(r(1n, 10n));
    expect(numeralRational(parseExpr('18.5') as never)).toEqual(r(185n, 10n));
    // Past 15 significant digits, the double itself — the encoder's reading.
    expect(numeralRational(parseExpr('0.29999999999999999') as never)).toEqual(exactRationalOfDouble(0.3));
    // A lowered `[unit]` literal is its magnitude times the unit's factor.
    expect(numeralRational({ kind: 'num', value: 0.001, literal: { magnitude: '1.0', factor: 0.001 } })).toEqual(
      r(10n, 10000n),
    );
    expect(numeralRational({ kind: 'num', value: Number.NaN })).toBeUndefined();
    // A stated value reads its lexeme by the same rule.
    expect(statedRational(0.1, '0.10000000000000001')).toEqual(exactRationalOfDouble(0.1));
    expect(statedRational(0.1, '0.1')).toEqual(r(1n, 10n));
    expect(statedRational(0.1, undefined)).toEqual(r(1n, 10n));
  });

  it('reads a unit into SI through the factor and origin the encoder writes', () => {
    const one = r(1n, 1n);
    // A composed unit is the exact product of its parts, not its double.
    expect(compareRationals(siRational(one, 'ft^3')!, decimalRational('0.028316846592')!)).toBe(0);
    expect(compareRationals(siRational(one, 'g/cm^3')!, decimalRational('1000')!)).toBe(0);
    expect(compareRationals(siRational(r(32n, 1n), 'fahrenheit')!, decimalRational('273.15')!)).toBe(0);
    expect(siRational(one, 'no such unit')).toBeUndefined();
    expect(siRational(r(7n, 2n), undefined)).toEqual(r(7n, 2n));
  });

  it('reads z3’s rendering of a real as the rational it is, and nothing else', () => {
    expect(termRational('(/ 3.0 25.0)')).toEqual(r(3n, 25n));
    expect(termRational('(- (/ 1.0 2.0))')).toEqual(r(-1n, 2n));
    expect(termRational('12.0')).toEqual(r(12n, 1n));
    expect(termRational('(- 7)')).toEqual(r(-7n, 1n));
    expect(termRational('true')).toBeUndefined();
    expect(termRational('(root-obj (+ (^ x 2) (- 2)) 1)')).toBeUndefined();
  });

  it('follows the operators exact arithmetic follows, and no others', () => {
    expect(powerRational(r(1n, 10n), r(3n, 1n))).toEqual(r(1n, 1000n));
    expect(powerRational(r(2n, 1n), r(-2n, 1n))).toEqual(r(1n, 4n));
    expect(powerRational(r(2n, 1n), r(1n, 2n))).toBeUndefined();
    expect(powerRational(r(0n, 1n), r(-1n, 1n))).toBeUndefined();
    // A remainder as binary64 computes it: the sign of the dividend.
    expect(remainderRational(r(7n, 1n), r(4n, 1n))).toEqual(r(3n, 1n));
    expect(remainderRational(r(-7n, 1n), r(4n, 1n))).toEqual(r(-3n, 1n));
    expect(divideRationals(r(1n, 1n), r(0n, 1n))).toBeUndefined();
  });

  it('keeps every result in lowest terms, and abandons one past 2^1024 rather than round it', () => {
    expect(addRationals(r(1n, 6n), r(1n, 3n))).toEqual(r(1n, 2n));
    expect(addRationals(r(1n, 10n), r(-1n, 10n))).toEqual(r(0n, 1n));
    expect(multiplyRationals(r(2n, 3n), r(9n, 4n))).toEqual(r(3n, 2n));
    expect(multiplyRationals(r(0n, 1n), r(9n, 4n))).toEqual(r(0n, 1n));
    expect(divideRationals(r(3n, 4n), r(-9n, 8n))).toEqual(r(-2n, 3n));
    // A reading the encoder supplies unreduced (`0.10` is 10/100) is reduced
    // where it enters.
    expect(termRational('(/ 30.0 250.0)')).toEqual(r(3n, 25n));
    // The limit: 2^1023 is carried, 2^1024 is not — and a power past it is
    // known to be before it is computed.
    expect(powerRational(r(2n, 1n), r(1023n, 1n))).toEqual(r(1n << 1023n, 1n));
    expect(powerRational(r(2n, 1n), r(1024n, 1n))).toBeUndefined();
    expect(powerRational(r(1000001n, 1000000n), r(1000n, 1n))).toBeUndefined();
    expect(powerRational(r(1n, 1n), r(4096n, 1n))).toEqual(r(1n, 1n));
    // A chain of decimal arithmetic is carried exactly until it passes the
    // limit, then abandoned — never rounded to a value that would decide a tie.
    let x: ReturnType<typeof addRationals> = r(1n, 1n);
    let steps = 0;
    for (; x !== undefined && steps < 400; steps++) {
      x = multiplyRationals(x, r(10001n, 10000n));
      x = x && addRationals(x, r(3n, 10000n));
    }
    expect(x).toBeUndefined();
    expect(steps).toBeGreaterThan(70);
    expect(steps).toBeLessThan(80);
  });

  it('decides a comparison by the rationals, else by the doubles outside the band, else not at all', () => {
    const tenth3 = r(3n, 10n);
    // The doubles say `>`; the decimals say equal.
    expect(decideComparison('>', 0.30000000000000004, 0.3, tenth3, tenth3)).toBe(false);
    expect(decideComparison('==', 0.30000000000000004, 0.3, tenth3, tenth3)).toBe(true);
    // The doubles say equal; the decimals say `>` (binary64 absorbed the 1e-17).
    expect(decideComparison('>', 1, 1, r(100000000000000001n, 100000000000000000n), r(1n, 1n))).toBe(true);
    // No exact reading: outside the band the doubles decide …
    expect(decideComparison('<', 1, 2, undefined, undefined)).toBe(true);
    // … inside it nothing does, unless the values are a solve's own: then the
    // solve's claim, `==`, `<=` and `>=`, holds, and a strict ordering or a
    // `!=`, which turns on the difference its tolerance hides, is undecided.
    expect(decideComparison('<', 2.0000000000000004, 2, undefined, r(2n, 1n))).toBeUndefined();
    expect(decideComparison('<=', 2.0000000000000004, 2, undefined, undefined)).toBeUndefined();
    const solved = { searched: true };
    expect(decideComparison('<=', 2.0000000000000004, 2, undefined, undefined, solved)).toBe(true);
    expect(decideComparison('>=', 2, 2.0000000000000004, undefined, undefined, solved)).toBe(true);
    expect(decideComparison('==', 2.0000000000000004, 2, undefined, undefined, solved)).toBe(true);
    expect(decideComparison('<', 2.0000000000000004, 2, undefined, undefined, solved)).toBeUndefined();
    expect(decideComparison('>', 2, 2.0000000000000004, undefined, undefined, solved)).toBeUndefined();
    expect(decideComparison('!=', 2.0000000000000004, 2, undefined, undefined, solved)).toBeUndefined();
    expect(decideComparison('<=', 1.0000004, 1, undefined, undefined, { searched: true, absTol: 1e-6 })).toBe(true);
    expect(decideComparison('<', 1e-7, 5e-7, undefined, undefined, { searched: true, absTol: 1e-6 })).toBeUndefined();
    // Outside it the doubles decide a solve's values as any others.
    expect(decideComparison('<', 0.0999999966, 0.1, undefined, undefined, solved)).toBe(true);
    // A side that is no number is read as the doubles read it.
    expect(decideComparison('<', Number.NaN, 1, undefined, undefined)).toBe(false);
    expect(decideComparison('!=', Number.NaN, 1, undefined, undefined)).toBe(true);
  });

  it('evaluates a relation decided, short-circuits and strings as `evaluate` reads them', () => {
    const at = (text: string) => evaluateDecided(parseExpr(text), () => undefined);
    expect(at('0.1 + 0.2 > 0.3')).toEqual({ value: false });
    expect(at('0.1 + 0.2 == 0.3')).toEqual({ value: true });
    expect(at('1.0 + 0.00000000000000001 > 1.0')).toEqual({ value: true });
    expect(at('0.1 * 3.0')).toEqual({ value: 0.30000000000000004, exact: r(3n, 10n) });
    // A fractional power has no exact reading: a tie over it is undecided …
    expect(at('2.0 ^ 0.5 * 2.0 ^ 0.5 == 2.0')).toMatchObject({ unknown: true, tie: { op: '==' } });
    // … unless a short-circuit decides without it.
    expect(at('false and 2.0 ^ 0.5 * 2.0 ^ 0.5 == 2.0')).toEqual({ value: false });
    expect(at('"a" < "b"')).toEqual({ value: true });
    expect(at('1.0 / 0.0 > 1.0')).toEqual({ unknown: true });
  });

  it('re-reads a witness over z3’s rationals, through the factor the encoder read it by', () => {
    const vars = [{ path: 'x', qualifiedName: 'P::x', factor: 0.3048, offset: 0 }];
    const node = parseExpr('x == 0.9144');
    // 3 ft is exactly 0.9144 m, and 0.9144000000000001 in binary64.
    const exact = Object.assign(new Map<string, number | boolean>([['P::x', 3]]), {
      exact: new Map([['P::x', r(3n, 1n)]]),
    });
    expect(rereadRelation(node, vars, exact)).toMatchObject({ value: true });
    // With only the doubles, the tie is nobody's to decide.
    expect(rereadRelation(node, vars, new Map([['P::x', 3]]))).toMatchObject({ unknown: true });
    expect(rereadRelation(parseExpr('x > 0.9'), vars, new Map([['P::x', 3]]))).toMatchObject({ value: true });
  });
});

describe('the readings cache of one pass keeps a reading from its second read on', () => {
  const SRC = `package P { part def A { attribute x : Real = 1.0; constraint c { x > 0.5 } } part a : A; }`;

  it('reads a key once for a pass that reads it once, twice for one that repeats it, and never again', async () => {
    const model = await load(SRC);
    const el = model.all().find((e) => e.eClass === 'ConstraintUsage')!;
    const raw = String(el.attrs.expression).trim();
    const parse = vi.spyOn(unitLiterals, 'parseRelationBody');
    try {
      const kept = new Map();
      cacheReadings(kept);
      const first = readRelation(model, el, raw, kept);
      expect(parse).toHaveBeenCalledTimes(1);
      const second = readRelation(model, el, raw, kept);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(second).toEqual(first);
      // The kept reading is a copy taken before the caller writes into the one it was handed.
      second.variables[0]!.qualifiedName = 'leaked';
      second.variables.length = 0;
      // From the second read on the reading is kept: a recompute here is the regression.
      const third = readRelation(model, el, raw, kept);
      const fourth = readRelation(model, el, raw, kept);
      expect(parse).toHaveBeenCalledTimes(2);
      // The same reading each time, and a copy of its own for every caller.
      expect(third).toEqual(first);
      expect(fourth).toEqual(first);
      expect(third).not.toBe(fourth);
      expect(third.variables).not.toBe(fourth.variables);
      third.variables.length = 0;
      expect(readRelation(model, el, raw, kept)).toEqual(first);
      // A pass that does not cache reads every time.
      parse.mockClear();
      readRelation(model, el, raw, new Map());
      readRelation(model, el, raw, new Map());
      expect(parse).toHaveBeenCalledTimes(2);
    } finally {
      parse.mockRestore();
    }
  });
});

/* ──────────────── the constraint-class census (scripts/census-constraint-classes) ──────────────── */

describe('the constraint-class census sorts a relation by the bytes the encoder emitted', () => {
  const vars = (sorts: Record<string, EncodeVariable['sort']>): EncodeVariable[] =>
    Object.entries(sorts).map(([path, sort]) => ({ path, qualifiedName: `P::${path}`, sort, factor: 1, offset: 0, free: false }));
  const V = vars({ a: 'Real', b: 'Real', n: 'Int', p: 'Bool', q: 'Bool' });
  /** body, the shape the plan's C.1 gives it. The `^ 0` rows are the ones an AST-only reading gets wrong. */
  const TABLE: Array<[string, ShapeId]> = [
    ['a + 1.0 > b', 'lra'],
    ['n > 3.0', 'lira'],
    ['p and q', 'bool'],
    ['1.0 < 2.0', 'ground'],
    ['a * b > 1.0', 'nra-poly'],
    ['0.0 * a * b > 1.0', 'nra-poly'],
    ['a * (b ^ 0) > 1.0', 'nra-poly'],
    ['a / b > 1.0', 'nra-div'],
    ['a / (b ^ 0) > 1.0', 'nra-div'],
    ['n * a >= 12.0', 'nira'],
    ['(n ^ 0) < b', 'lra'],
    ['a / (2.0 * 3.0) > 1.0', 'lra'],
    ['a ^ 1 > 1.0', 'lra'],
    ['a ^ 3 > 1.0', 'nra-poly'],
  ];

  it.each(TABLE)('%s is %s, in the bytes, in the AST, and in the encoder\u2019s own logic line', (body, shape) => {
    const node = parseExpr(body);
    const e = encodeRelation(node, V);
    expect(e.ok, body).toBe(true);
    if (!e.ok) return;
    const sorts = new Map(V.map((v) => [symbolOf(v.qualifiedName)!, v.sort]));
    const bytes = shapeOfBytes(termFacts([e.term]), sorts, { syntacticNonlinear: e.syntacticNonlinear, sides: e.sideConditions.length });
    expect(bytes.shape, `${body}: ${e.term}`).toBe(shape);
    expect(astShape(node, V), body).toBe(shape);
    const script = encodeScript({ variables: V, assertions: [{ kind: 'goal', name: 'g', term: e.term }, ...e.sideConditions.map((s) => ({ kind: 'side' as const, name: 'g', term: s.term }))], nonlinear: e.nonlinear, syntacticNonlinear: e.syntacticNonlinear });
    expect(script.logic, body).toBe(SHAPE_LOGIC[shape]);
  });

  it('is told apart from the bytes: a body whose read is dropped has linear bytes and a nonlinear walk', () => {
    const e = encodeRelation(parseExpr('a * (b ^ 0) > 1.0'), V);
    if (!e.ok) throw new Error('refused');
    expect(termFacts([e.term]).nonlinear, e.term).toBe(false);
    expect(e.syntacticNonlinear).toBe(true);
  });

  it('reads the published examples to the counts the plan expects, with its own invariants intact', async () => {
    const files = ['uav-isr', 'uav-isr-verification', 'vehicle'].map((n) => `examples/${n}.sysml`);
    const { census } = await collect(corpusItems(undefined, files), { verdicts: false, probes: false });
    expect(invariantsHold(census), JSON.stringify(census.checks)).toBe(true);
    expect(census.perModel['examples/uav-isr.sysml']).toMatchObject({ rows: 14, encoded: 14, units: 3, shapes: { lra: 13, 'nra-div': 1 } });
    expect(census.perModel['examples/uav-isr-verification.sysml']).toMatchObject({ rows: 10, units: 4, shapes: { lra: 9, 'nra-div': 1 } });
    expect(census.perModel['examples/vehicle.sysml']).toMatchObject({ rows: 5, units: 0, shapes: { lra: 4, lira: 1 } });
    // Two censuses add: the sum is a census of both, so a shard is a sound way to split a run.
    const doubled = mergeCensus(structuredClone(census), structuredClone(census));
    expect(Object.values(doubled.rows).reduce((a, b) => a + b, 0)).toBe(2 * Object.values(census.rows).reduce((a, b) => a + b, 0));
  });

  it('gives a row with no formal clause no reading, and every other row one', async () => {
    const { model } = await loadModelText(read('examples/views-tour.sysml'), { fileName: 'views-tour.sysml' });
    const rows = obligationsOf(model!);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(readingOf(r) === '(none)', r.expression).toBe(r.source === 'none');
  });

  it('extracts the probes of a table without running it, and lists the ones whose text is computed', () => {
    const src = [
      'const PROBES: Record<string, { text: string }> = {',
      '  a1: probe(`package A { }`, {',
      "    'A::x': ['T/T/T/T', 'T'],",
      '  }),',
      '  // a comment, with a ` backtick',
      '  b2: probe(make(2), {',
      "    'B::y': ['F/F/F/F', 'F'],",
      '  }),',
      '  c3: probe(`package $' + '{C} { }`, {}),',
      "  ...reversed('d4', `package D { }`, { 'D::z': ['T/T/T/T', 'T'] }),",
      '};',
    ].join('\n');
    const got = extractProbes(src);
    expect(got.total).toBe(3);
    expect(got.entries.map((e) => e.name)).toEqual(['a1']);
    expect(got.entries[0]!.rows).toEqual([{ key: 'A::x', letters: 'T/T/T/T', ref: 'T' }]);
    expect(got.interpolated).toEqual(['b2', 'c3']);
    expect(got.spreads).toHaveLength(1);
  });
});

/* ──────────────── the script shape is the logic line (smt/shape.ts) ──────────────── */

describe('the script shape is the logic line', () => {
  const V = (['a', 'b', 'c'] as const)
    .map((p) => v(p))
    .concat([v('n', { sort: 'Int' }), v('m', { sort: 'Int' }), v('p', { sort: 'Bool' })]);
  const name = (path: string) => `P::${path}`;

  /** The shape of an encoded body, through the walk's own flags, and the logic the public script gives it. */
  function both(node: ReturnType<typeof parseExpr>, variables: EncodeVariable[], opts: { hint?: boolean } = {}) {
    const e = encodeRelation(node, variables);
    if (!e.ok) return undefined;
    const terms = [e.term, ...e.sideConditions.map((s) => s.term)];
    const hint = opts.hint !== false;
    const shape = shapeOfTerm(terms, variables, {
      syntacticNonlinear: hint && e.syntacticNonlinear,
      hasSideConditions: e.sideConditions.length > 0,
      reads: e.reads,
    });
    const script = encodeScript({
      variables,
      assertions: terms.map((term, i) => ({ kind: i === 0 ? ('goal' as const) : ('side' as const), name: 'g', term })),
      nonlinear: e.nonlinear,
      ...(hint ? { syntacticNonlinear: e.syntacticNonlinear } : {}),
    });
    return { e, shape, logic: script.logic };
  }

  /**
   * An oracle that reads the AST and not the bytes. It models the two places the two differ:
   * `x ^ 0` writes `1.0` (the walk saw the read, the bytes do not carry it) and `x ^ 1` writes `x`
   * (no product), and a negative power is a division by a symbol. A `≠ 0` guard is part of the
   * script and keeps the symbols of its divisor even when a `^ 0` erased the term that held them.
   */
  function oracleLogic(root: ReturnType<typeof parseExpr>, ignore: { div?: boolean; pow?: boolean } = {}): string {
    const sort = new Map(V.map((x) => [x.path, x.sort]));
    interface F { walk: Set<string>; bytes: Set<string>; guard: Set<string>; nl: boolean }
    const go = (n: ReturnType<typeof parseExpr>): F => {
      const empty = (): F => ({ walk: new Set(), bytes: new Set(), guard: new Set(), nl: false });
      const merge = (...xs: F[]): F => ({
        walk: new Set(xs.flatMap((x) => [...x.walk])),
        bytes: new Set(xs.flatMap((x) => [...x.bytes])),
        guard: new Set(xs.flatMap((x) => [...x.guard])),
        nl: xs.some((x) => x.nl),
      });
      switch (n.kind) {
        case 'ref':
          return { ...empty(), walk: new Set([n.path.join('.')]), bytes: new Set([n.path.join('.')]) };
        case 'unary':
          return go(n.operand);
        case 'if':
          return merge(go(n.cond), go(n.then), go(n.else));
        case 'binary': {
          const l = go(n.left);
          const r = go(n.right);
          const f = merge(l, r);
          if (n.op === '*') return { ...f, nl: f.nl || (l.walk.size > 0 && r.walk.size > 0) };
          if (n.op === '/') {
            const guard = r.walk.size > 0 ? new Set([...f.guard, ...r.bytes]) : f.guard;
            return { ...f, guard, nl: f.nl || (!ignore.div && r.walk.size > 0) };
          }
          if (n.op === '^') {
            const e = n.right.kind === 'num' ? n.right.value : n.right.kind === 'unary' && n.right.operand.kind === 'num' ? -n.right.operand.value : NaN;
            if (e === 0) return { ...l, bytes: new Set() };
            if (e === 1 || ignore.pow) return l;
            const guard = e < 0 && l.walk.size > 0 ? new Set([...l.guard, ...l.bytes]) : l.guard;
            return { ...l, guard, nl: l.nl || l.walk.size > 0 };
          }
          return f;
        }
        default:
          return empty();
      }
    };
    const f = go(root);
    const int = [...f.bytes, ...f.guard].some((p) => sort.get(p) === 'Int');
    return int ? (f.nl ? 'QF_NIRA' : 'QF_LIRA') : f.nl ? 'QF_NRA' : 'QF_LRA';
  }

  /** A seeded body: arithmetic over reals and ints, `^` with literal exponents -2..3, guards, `ite`. */
  function bodies(count: number, seed: number): ReturnType<typeof parseExpr>[] {
    let s = seed >>> 0;
    const rnd = (k: number) => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * k);
    };
    const leaf = () => ['a', 'b', 'c', 'n', 'm', '1.0', '2.0', '0.5', '3.0'][rnd(9)]!;
    const arith = (d: number): string => {
      if (d === 0 || rnd(5) === 0) return leaf();
      switch (rnd(7)) {
        case 0: return `(${arith(d - 1)} + ${arith(d - 1)})`;
        case 1: return `(${arith(d - 1)} - ${arith(d - 1)})`;
        case 2:
        case 3: return `(${arith(d - 1)} * ${arith(d - 1)})`;
        case 4: return `(${arith(d - 1)} / ${arith(d - 1)})`;
        case 5: return `(${arith(d - 1)} ^ ${['-2', '-1', '0', '1', '2', '3'][rnd(6)]})`;
        default: return `(if a > b then ${arith(d - 1)} else ${arith(d - 1)})`;
      }
    };
    const out: ReturnType<typeof parseExpr>[] = [];
    for (let i = 0; i < count; i += 1) {
      const cmp = `${arith(1 + rnd(3))} ${['<', '>=', '=='][rnd(3)]} ${arith(1 + rnd(2))}`;
      out.push(parseExpr(rnd(6) === 0 ? `${cmp} and p` : cmp));
    }
    return out;
  }

  it('CC-01: the shape gives the encoder’s own logic line over 20,000 seeded bodies, and the AST oracle agrees', () => {
    const miss: string[] = [];
    const seen = { encoded: 0, nonlinear: 0, int: 0, guarded: 0 };
    for (const node of bodies(20000, 20261030)) {
      const r = both(node, V);
      if (r === undefined) continue;
      seen.encoded += 1;
      if (r.shape.nonlinear) seen.nonlinear += 1;
      if (r.shape.int) seen.int += 1;
      if (r.shape.guarded) seen.guarded += 1;
      const bytes = both(node, V, { hint: false })!;
      const want = r.logic;
      // the shape with the walk's flag, the shape from the bytes alone, and the oracle each give the script's line
      if (logicFromShape(r.shape) !== want) miss.push(`shape ${r.e.term}: ${logicFromShape(r.shape)} vs ${want}`);
      if (logicFromShape(bytes.shape) !== bytes.logic) miss.push(`bytes ${r.e.term}: ${logicFromShape(bytes.shape)} vs ${bytes.logic}`);
      if (oracleLogic(node) !== want) miss.push(`oracle ${r.e.term}: ${oracleLogic(node)} vs ${want}`);
    }
    expect(miss.slice(0, 5)).toEqual([]);
    expect(seen.encoded).toBeGreaterThan(8000);
    expect(seen.nonlinear).toBeGreaterThanOrEqual(600);
    expect(seen.int).toBeGreaterThanOrEqual(1000);
    expect(seen.guarded).toBeGreaterThanOrEqual(300);
  });

  const EDGES: Array<[string, string, { int?: boolean; guarded?: boolean; nl?: string[]; syms?: string[] }]> = [
    ['a + 1.0 > b', 'QF_LRA', { syms: ['a', 'b'] }],
    ['n > 3.0', 'QF_LIRA', { int: true, syms: ['n'] }],
    ['p and p', 'QF_LRA', { syms: ['p'] }],
    ['1.0 < 2.0', 'QF_LRA', { syms: [] }],
    ['false', 'QF_LRA', { syms: [] }],
    ['a * b > 1.0', 'QF_NRA', { nl: ['a', 'b'], syms: ['a', 'b'] }],
    ['0.0 * a * b > 1.0', 'QF_NRA', { nl: ['a', 'b'], syms: ['a', 'b'] }],
    ['a * (b ^ 0) > 1.0', 'QF_NRA', { nl: ['a', 'b'], syms: ['a'] }],
    ['a / b > 1.0', 'QF_NRA', { guarded: true, nl: ['a', 'b'], syms: ['a', 'b'] }],
    ['a / (b ^ 0) > 1.0', 'QF_NRA', { guarded: true, nl: ['a', 'b'], syms: ['a'] }],
    ['n * a >= 12.0', 'QF_NIRA', { int: true, nl: ['a', 'n'], syms: ['a', 'n'] }],
    ['(n ^ 0) < b', 'QF_LRA', { syms: ['b'] }],
    ['a / (2.0 * 3.0) > 1.0', 'QF_LRA', { syms: ['a'] }],
    ['a ^ 1 > 1.0', 'QF_LRA', { syms: ['a'] }],
    ['a ^ 3 > 1.0', 'QF_NRA', { nl: ['a'], syms: ['a'] }],
    ['a ^ -1 > 1.0', 'QF_NRA', { guarded: true, nl: ['a'], syms: ['a'] }],
  ];

  it.each(EDGES)('CC-02: %s is %s', (body, logic, want) => {
    const r = both(parseExpr(body), V);
    expect(r, body).toBeDefined();
    expect(r!.logic, body).toBe(logic);
    expect(logicFromShape(r!.shape), `${body}: ${r!.e.term}`).toBe(logic);
    expect(r!.shape.int).toBe(want.int ?? false);
    expect(r!.shape.guarded).toBe(want.guarded ?? false);
    expect(r!.shape.nlSymbols).toEqual((want.nl ?? []).map(name));
    expect(r!.shape.symbols).toEqual((want.syms ?? []).map(name));
  });

  it('CC-02: a hand-built term and the operator mask', () => {
    const f = (term: string): ShapeFacts => shapeOfTerm(term, V, { syntacticNonlinear: false, hasSideConditions: false, reads: [] });
    expect(logicFromShape(f('(< (* |P::a| |P::b|) 1.0)'))).toBe('QF_NRA');
    expect(logicFromShape(f('(< (* 60.0 |P::a|) 1.0)'))).toBe('QF_LRA');
    expect(logicFromShape(f('(< (/ 1.0 |P::a|) 1.0)'))).toBe('QF_NRA');
    expect(logicFromShape(f('(< (to_real |P::n|) 1.0)'))).toBe('QF_LIRA');
    expect(logicFromShape(f('(< (to_real |P::n|) 1.0)'), false)).toBe('QF_LRA');
    expect(f('(< (to_real |P::n|) 1.0)').mask).toBe(SHAPE_BITS.TO_REAL);
    expect(f('(ite (< |P::a| 1.0) (* 2.0 |P::a|) (/ |P::b| 2.0))').mask).toBe(SHAPE_BITS.ITE | SHAPE_BITS.ARITH | SHAPE_BITS.MUL_SYM);
    expect(f('(< (/ 1.0 |P::a|) 1.0)').mask).toBe(SHAPE_BITS.ARITH | SHAPE_BITS.DIV_SYM);
    expect(f('(< (^ |P::a| 2.0) 1.0)').mask).toBe(SHAPE_BITS.ARITH | SHAPE_BITS.POW);
    // a symbol the environment does not declare is not carried
    expect(f('(< |Q::z| 1.0)').symbols).toEqual([]);
  });

  it('CC-04: the relation and the script carry the shape of their bytes, and the script’s logic line is read from it', () => {
    let guarded = 0;
    for (const node of bodies(2000, 20261031)) {
      const e = encodeRelation(node, V);
      if (!e.ok) continue;
      const terms = [e.term, ...e.sideConditions.map((s) => s.term)];
      // the relation reads its own variables, not the whole environment, and loses none of them
      const whole = shapeOfTerm(terms, V, {
        syntacticNonlinear: e.syntacticNonlinear,
        hasSideConditions: e.sideConditions.length > 0,
        reads: e.reads,
      });
      expect(e.shape, e.term).toEqual(whole);
      const script = encodeScript({
        variables: V,
        assertions: terms.map((term, i) => ({ kind: i === 0 ? ('goal' as const) : ('side' as const), name: 'g', term })),
        nonlinear: e.nonlinear,
        syntacticNonlinear: e.syntacticNonlinear,
      });
      // the script’s shape is over its bytes: the logic line is that shape’s, whatever the relation’s own flag said
      expect(logicFromShape(script.shape), e.term).toBe(script.logic);
      expect(script.text).toContain(`(set-logic ${script.logic})\n`);
      expect(script.shape.symbols).toEqual(script.symbols);
      expect(script.shape.guarded).toBe(e.sideConditions.length > 0);
      if (e.sideConditions.length > 0) guarded += 1;
    }
    expect(guarded).toBeGreaterThan(30);
    // a hand-built script with no walk flag still gets the line its bytes are in
    const hand = encodeScript({
      variables: V,
      assertions: [{ kind: 'goal', name: 'g', term: '(< (* |P::a| |P::b|) 1.0)' }],
      nonlinear: false,
    });
    expect(hand.logic).toBe('QF_NRA');
    expect(hand.shape.nlSymbols).toEqual(['P::a', 'P::b']);
  });

  it('CC-04: a script’s bytes are what they were — header, logic, declarations, labelled assertions', () => {
    const e = encodeRelation(parseExpr('n * a / b >= 12.0'), V);
    if (!e.ok) throw new Error('did not encode');
    const script = encodeScript({
      variables: V,
      assertions: [
        { kind: 'goal', name: 'R', term: e.term },
        ...e.sideConditions.map((c) => ({ kind: 'side' as const, name: 'R', term: c.term })),
      ],
      nonlinear: e.nonlinear,
      syntacticNonlinear: e.syntacticNonlinear,
    });
    expect(script.logic).toBe('QF_NIRA');
    expect(script.text).toBe(
      [
        '; sysprose — SMT-LIB2 encoding of one obligation.',
        '; Variables are declared in their storage unit; every read is lifted to coherent SI.',
        '; Symbols and assertion labels are qualified names — never element ids, which are fresh per load.',
        '(set-logic QF_NIRA)',
        '(set-option :produce-unsat-cores true)',
        '(declare-fun |P::a| () Real)',
        '(declare-fun |P::b| () Real)',
        '(declare-fun |P::n| () Int)',
        `(assert (! ${e.term} :named |goal:R|))`,
        `(assert (! ${e.sideConditions[0]!.term} :named |side:R|))`,
        '',
      ].join('\n'),
    );
  });

  it('CC-04: a name two variables share is typed by the first one, as the script declares it', () => {
    const twin = [v('x'), v('x', { sort: 'Int' })];
    const term = '(< |P::x| 1.0)';
    const script = encodeScript({ variables: twin, assertions: [{ kind: 'goal', name: 'g', term }], nonlinear: false });
    expect(script.text).toContain('(declare-fun |P::x| () Real)');
    expect(script.logic).toBe('QF_LRA');
    expect(shapeOfTerm(term, twin, { syntacticNonlinear: false, hasSideConditions: false, reads: [] }).int).toBe(false);
  });

  it('CC-03: an oracle that ignores `/` or `^` is caught by the same fuzz', () => {
    const count = (ignore: { div?: boolean; pow?: boolean }) => {
      let wrong = 0;
      for (const node of bodies(2000, 20261030)) {
        const r = both(node, V);
        if (r !== undefined && oracleLogic(node, ignore) !== r.logic) wrong += 1;
      }
      return wrong;
    };
    expect(count({})).toBe(0);
    expect(count({ div: true })).toBeGreaterThan(0);
    expect(count({ pow: true })).toBeGreaterThan(0);
  });
});

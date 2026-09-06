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
 *  - **Exactness.** `18.5` is `(/ 37.0 2.0)` and `0.1` is the binary64 the tool
 *    actually holds, not the tenth an author wrote. A re-parsed decimal in a
 *    solver's mouth is a wrong verdict about a number nobody typed.
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
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Model, ElementRecord } from '@core/index';
import { readRelation, type RelationReading } from '@semantics/index';
import { parseExpr } from '@semantics/expr';
import {
  encodeRelation,
  encodeScript,
  encodeVariables,
  encodeVariablesOf,
  exactNumeral,
  notTerm,
  symbolOf,
  valueTextNumeral,
  type EncodeVariable,
} from '@semantics/smt/encode';
import { loadModelText } from '@text/load';

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

describe('numerals are exact rationals, never a re-parsed decimal', () => {
  it('writes a double as the rational it exactly is', () => {
    expect(exactNumeral(2700)).toBe('2700.0');
    expect(exactNumeral(18.5)).toBe('(/ 37.0 2.0)');
    expect(exactNumeral(0.5)).toBe('(/ 1.0 2.0)');
    expect(exactNumeral(-25)).toBe('(- 25.0)');
    expect(exactNumeral(0)).toBe('0.0');
  });

  it('does not pretend a binary64 is the decimal that was typed', () => {
    // 0.1 is 3602879701896397 · 2⁻⁵⁵. Writing `0.1` into a script would hand the
    // solver a number this tool does not hold, and the difference is exactly
    // where a boundary verdict flips.
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

  it('encodes a BODY literal as the double, not as the author’s text', () => {
    // The two routes disagree, and which one a body takes is a decision, not an
    // accident: `checkConstraints` evaluates the double, so a goal encoded from
    // the author's text would decide a boundary case by which side of the proof
    // the number arrived on. `valueTextNumeral` is for the feature-VALUE axioms
    // a later commit builds, where the author's tenth is the right reading.
    const r = encode('x >= 0.1', [v('x')]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.term).toBe(`(>= |P::x| ${exactNumeral(0.1)})`);
    expect(r.term).not.toContain('(/ 1.0 10.0)');
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
    expect(r.term).toBe(`(<= (+ |P::Oven::temp| ${exactNumeral(273.15)}) 300.0)`);
    // Exact, not `273.15`: the offset is a double like any other number here.
    expect(r.term).toContain('(/ 2402652809016115.0 8796093022208.0)');
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

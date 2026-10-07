/**
 * Dedicated unit tests for {@link evaluateQuantity} and
 * {@link dimensionalFacets} (finding L13 — units-eval.ts previously untested).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { loadStandardLibrary } from '../../src/library/index';
import { evaluateQuantity, dimensionalFacets } from '../../src/semantics/units-eval';

function libModel(): Model {
  const m = new Model();
  loadStandardLibrary(m);
  return m;
}

describe('semantics — evaluateQuantity', () => {
  it('reads magnitude + dimension + unit from a feature with value + unit', () => {
    const m = libModel();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const mass = f.attribute('mass', p.id);
    m.setAttrs(mass.id, { value: '1500', unit: 'kg' });
    const q = evaluateQuantity(m, mass.id);
    expect(q).toBeDefined();
    expect(q!.magnitude).toBe(1500);
    expect(q!.unit).toBe('kg');
    expect(typeof q!.dimension).toBe('object');
    expect(q!.dimension.M).toBe(1);
  });

  it('returns undefined when the feature has no value', () => {
    const m = libModel();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const attr = f.attribute('unset', p.id);
    expect(evaluateQuantity(m, attr.id)).toBeUndefined();
  });

  it('returns undefined for a nonexistent feature id', () => {
    const m = libModel();
    expect(evaluateQuantity(m, 'nonexistent')).toBeUndefined();
  });

  it('returns magnitude without unit when only value is set', () => {
    const m = libModel();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const attr = f.attribute('count', p.id);
    m.setAttrs(attr.id, { value: '42' });
    const q = evaluateQuantity(m, attr.id);
    expect(q).toBeDefined();
    expect(q!.magnitude).toBe(42);
    expect(q!.unit).toBeUndefined();
  });
});

describe('semantics — dimensionalFacets', () => {
  it('returns unit and kind dimensions for a typed feature with a value unit', () => {
    const m = libModel();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const mass = f.attribute('mass', p.id);
    m.setAttrs(mass.id, { value: '1000', unit: 'kg' });
    const massValueType = m.resolveQualifiedName('ISQ::MassValue');
    if (massValueType) {
      m.create('FeatureTyping', { ownerId: mass.id, source: [mass.id], target: [massValueType.id] });
    }
    const facets = dimensionalFacets(m, mass.id);
    expect(facets).toBeDefined();
  });

  it('returns an empty object for a nonexistent feature', () => {
    const m = libModel();
    const facets = dimensionalFacets(m, 'nonexistent');
    expect(facets).toEqual({});
  });
});

/* ───────────── I1 semantics: derived features, tolerance, offset units ───────────── */

import { parseModel } from '@text/index';
import { checkConstraints } from '@semantics/index';
import { checkConstraintsNumeric } from '@semantics/solver';
import { validate } from '@validation/index';
import { preloadFullLibrary, loadFullStandardLibrary } from '../../src/library/full-library';
import { resolveTypeReferences } from '../../src/library/resolve';
import {
  dimensionClaim,
  dimensionClaimDetail,
  evaluateConstraintQuantity,
  evaluateConstraintQuantityDetailed,
  isRefusalReason,
  resolveUnitRef,
  siValue,
  UNIT_AWARE_OPERATORS,
  unitRefsIn,
  valueUnitRefusal,
} from '../../src/semantics/units-eval';
import { dim, dimensionOneKindsOf } from '../../src/semantics/units';
import { evaluate, parseExpr } from '../../src/semantics/expr';

async function bound(src: string): Promise<Model> {
  const { model, diagnostics } = parseModel(src);
  expect(diagnostics.filter((d) => d.severity === 'error'), src).toEqual([]);
  await preloadFullLibrary();
  loadFullStandardLibrary(model);
  resolveTypeReferences(model);
  return model;
}
const byName = (m: Model, name: string) => {
  const el = m.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true);
  if (!el) throw new Error(`no element ${name}`);
  return el;
};
const verdicts = (m: Model) => checkConstraints(m).map((c) => c.result);
/** The one constraint a `uav(…)` / single-requirement model carries. */
const constraintOf = (m: Model) => {
  const el = m.ofKind('RequirementUsage', 'ConstraintUsage').find((e) => typeof e.attrs.expression === 'string');
  if (!el) throw new Error('no constraint with an expression');
  return el;
};

/** The UAV shape: a derived attribute and one requirement reading it. */
const uav = (attr: string, body: string) => `package P {
    part def BatteryPack { attribute capacity : ISQ::EnergyValue = 640.0 [Wh]; }
    part def AirVehicle {
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        attribute usableEnergyFraction : Real = 0.8;
        attribute mtow : ISQ::MassValue = 18.5 [kg];
        ${attr}
        part battery : BatteryPack;
    }
    part uav : AirVehicle;
    requirement def R { subject uav : AirVehicle; require constraint { ${body} } }
}
`;
const DERIVED = 'attribute endurance : ISQ::DurationValue = battery.capacity * usableEnergyFraction / cruisePower;';
const HAND_MINUTES =
  'attribute enduranceMin : Real = battery.capacity * usableEnergyFraction / cruisePower * 60.0;';

describe('derived features are quantities behind a dimension guard', () => {
  beforeAll(async () => {
    await preloadFullLibrary();
  });

  it('derives 640 Wh × 0.8 / 650 W to 2835.7 s with dimension T', async () => {
    const m = await bound(uav(DERIVED, 'uav.endurance >= 45.0 [min]'));
    const d = dimensionClaimDetail(m, byName(m, 'endurance').id);
    expect(d.claim).toBe('consistent');
    expect(d.derived).toEqual(dim({ T: 1 }));
    expect(d.q?.magnitude).toBeCloseTo(2835.69, 1);
    expect(d.q?.dimension).toEqual(dim({ T: 1 }));
    expect(verdicts(m)).toEqual(['satisfied']);
  });

  it('derives a value in the usage that changes its input, as that usage’s quantity (D1 Stage 2)', async () => {
    // AirVehicle's endurance read for `big`, whose battery holds 1300 Wh: 1300
    // × 0.8 / 650 W = 1.6 h — big's own, never AirVehicle's 2835.7 s.
    const m = await bound(`package P {
    part def BatteryPack { attribute capacity : ISQ::EnergyValue default = 640.0 [Wh]; }
    part def AirVehicle {
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        attribute usableEnergyFraction : Real = 0.8;
        ${DERIVED}
        part battery : BatteryPack;
    }
    part big : AirVehicle { part :>> battery { attribute :>> capacity = 1300.0 [Wh]; } }
    constraint hi { big.endurance >= 95.0 [min] }
    constraint lo { big.endurance <= 97.0 [min] }
}
`);
    expect(verdicts(m)).toEqual(['satisfied', 'satisfied']);
    const q = evaluateConstraintQuantityDetailed(m, m.all().find((e) => e.declaredName === 'hi')!);
    expect(q.lhsSI).toBeCloseTo(5760, 6);
    // AirVehicle's own reading stands, over its own battery.
    expect(dimensionClaimDetail(m, byName(m, 'endurance').id).q?.magnitude).toBeCloseTo(2835.69, 1);
  });

  it('FACTOR-60 TRAP: a Real hand-converted to minutes derives to 170 141 s and is EXCLUDED', async () => {
    // Un-gated, the engine reads `… / cruisePower * 60.0` as 170 141 s and
    // answers SATISFIED against 100 min (6000 s) — the author's 47.3 min is
    // violated. The guard makes it unknown; the mismatch rule names the cause.
    const m = await bound(uav(HAND_MINUTES, 'uav.enduranceMin >= 100.0 [min]'));
    expect(dimensionClaim(m, byName(m, 'enduranceMin').id)).toBe('mismatch');
    const d = dimensionClaimDetail(m, byName(m, 'enduranceMin').id);
    expect(d.derived).toEqual(dim({ T: 1 }));
    expect(d.q).toBeUndefined();
    expect(verdicts(m)).toEqual(['unknown']);
    const r = evaluateConstraintQuantityDetailed(m, constraintOf(m));
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('mismatch');
  });

  it('answers unknown, not a hang, on a derivation cycle', async () => {
    const m = await bound(uav('attribute a : Real = b + 1.0; attribute b : Real = a + 1.0;', 'uav.a > 0.0 [s]'));
    const d = dimensionClaimDetail(m, byName(m, 'a').id);
    expect(d.claim).toBe('unknown');
    expect(d.reason).toBe('cycle');
    expect(verdicts(m)).toEqual(['unknown']);
  });

  it('resolves a qualified unit reference by its last segment (`SI::kg`)', async () => {
    expect(resolveUnitRef('SI::kg')?.symbol).toBe('kg');
    expect(resolveUnitRef('SI::kilogram')?.symbol).toBe('kg');
    expect(resolveUnitRef('USCustomaryUnits::lb')?.symbol).toBe('lb');
    expect(resolveUnitRef('SI::furlong')).toBeUndefined();
    const m = await bound(uav('', 'uav.mtow <= 25.0 [SI::kg]'));
    expect(verdicts(m)).toEqual(['satisfied']);
  });

  it('`(1 + 2) [m]` attaches the unit to a dimensionless derivation and warns nothing', async () => {
    const m = await bound(uav('attribute span : ISQ::LengthValue = (1 + 2) [m];', 'uav.span <= 4.0 [m]'));
    const d = dimensionClaimDetail(m, byName(m, 'span').id);
    expect(d.claim).toBe('consistent');
    expect(d.q).toMatchObject({ magnitude: 3, unit: 'm' });
    expect(d.q?.dimension).toEqual(dim({ L: 1 }));
    expect(verdicts(m)).toEqual(['satisfied']);
    expect(validate(m, { ruleIds: ['unknown-unit', 'derived-dimension-mismatch'] })).toEqual([]);
  });

  it('`expr [unit]` on an already-dimensioned operand is a fault, not a conversion', async () => {
    const m = await bound(uav('attribute twice : ISQ::MassValue = (mtow * 2.0) [kg];', 'uav.twice <= 40.0 [kg]'));
    const d = dimensionClaimDetail(m, byName(m, 'twice').id);
    expect(d.claim).toBe('unknown');
    // A REFUSAL, not the fillable `dimension`: the operand already carries a
    // dimension, so there is no dimensionless side and no reading of the raw
    // magnitudes the author could have meant. Tagged `dimension` it left the
    // bare-literal form `uav.twice <= 40.0` answered `satisfied` from 37 on
    // both surfaces, and `<= 40.0 [kg]` answered `satisfied` by the numeric
    // surface while this one said unknown.
    expect(d.reason).toBe('dimension-fault');
    const [check] = checkConstraints(m);
    expect(check.result).toBe('unknown');
    // The message names the feature AND the fault inside its derivation.
    expect(check.message).toContain('"uav.twice" cannot be derived');
    expect(check.message).toContain('a unit literal [kg] was applied to an operand that already has dimension M');
    // The bare-literal spelling is refused too, and both surfaces agree.
    const bare = await bound(uav('attribute twice : ISQ::MassValue = (mtow * 2.0) [kg];', 'uav.twice <= 40.0'));
    expect(verdicts(bare)).toEqual(['unknown']);
    expect(checkConstraintsNumeric(bare).map((r) => r.result)).toEqual(['unknown']);
  });

  it('`expr [unit]` on an operand that already carries a UNIT is a fault too', async () => {
    // Dimension one is not "unitless": a byte is 8 bit. Guarding on the
    // operand's DIMENSION let `cap [bit]` reread 2 bytes as 2 bits and answer
    // `cap [bit] <= 8.0 [bit]` a confident SATISFIED, where the truth is
    // 16 bit > 8 bit. The guard is the operand's UNIT.
    const m = await bound(`package P {
    attribute cap : ISQ::StorageCapacityValue = 2.0 [B];
    constraint bad1 { cap [bit] <= 8.0 [bit] }
}
`);
    const r = evaluateConstraintQuantityDetailed(m, constraintOf(m));
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('dimension-fault');
    expect(r.detail).toContain('a unit literal [bit] was applied to an operand that already has unit "B"');
    expect(verdicts(m)).toEqual(['unknown']);
    // And the numeric surface refuses it as well — never a confident row.
    expect(checkConstraintsNumeric(m).map((x) => x.result)).toEqual(['unknown']);
  });

  it('and so is `[unit]` on an operand COMPUTED from one: dimension one is not unitless', async () => {
    // `cap * 2.0` is 2^35 — in bits, with no unit left on it — and read as a
    // plain number `[GiB]` relabelled it: `dbl` was 2^35 GiB, `dbl == 4.0
    // [GiB]` violated and `dbl > 1000.0 [GiB]` SATISFIED on every surface.
    const mem = (attrs: string, body: string) => `package P {
    part def Mem { attribute cap : ISQ::StorageCapacityValue = 2.0 [GiB]; ${attrs} }
    part m : Mem;
    requirement def R { subject m : Mem; require constraint { ${body} } }
}
`;
    const m = await bound(mem('attribute dbl : ISQ::StorageCapacityValue = (cap * 2.0) [GiB];', 'm.dbl == 4.0 [GiB]'));
    const d = dimensionClaimDetail(m, byName(m, 'dbl').id);
    expect([d.claim, d.reason]).toEqual(['unknown', 'dimension-fault']);
    expect(d.detail).toBe(
      'a unit literal [GiB] was applied to an operand computed from a value in "GiB" — dimension one is not unitless',
    );
    expect(verdicts(m)).toEqual(['unknown']);
    expect(checkConstraintsNumeric(m).map((x) => x.result)).toEqual(['unknown']);
    for (const body of ['m.dbl > 1000.0 [GiB]', '(m.cap * 2.0) [GiB] > 1000.0 [GiB]']) {
      const r = await bound(mem('attribute dbl : ISQ::StorageCapacityValue = (cap * 2.0) [GiB];', body));
      expect(verdicts(r), body).toEqual(['unknown']);
      expect(checkConstraintsNumeric(r).map((x) => x.result), body).toEqual(['unknown']);
    }
    // Through a metre and back, or a square over one GiB, it is still bits.
    for (const value of ['((cap * 1.0 [m]) / 1.0 [m]) [GiB]', '((cap * cap) / 1.0 [GiB]) [GiB]', '(cap - 1.0) [GiB]']) {
      const r = await bound(mem(`attribute x : ISQ::StorageCapacityValue = ${value};`, 'm.x > 1000.0 [GiB]'));
      expect(dimensionClaimDetail(r, byName(r, 'x').id).reason, value).toBe('dimension-fault');
      expect(verdicts(r), value).toEqual(['unknown']);
    }
  });

  it('a ratio of two GiB is a number again, and a value already a number takes the unit', async () => {
    const quantity = async (attrs: string, name: string) => {
      const m = await bound(`package P { part def V { ${attrs} } part v : V; }`);
      return dimensionClaimDetail(m, byName(m, name).id).q;
    };
    const cap = 'attribute cap : ISQ::StorageCapacityValue = 2.0 [GiB];';
    expect(
      await quantity(`${cap} attribute r : ISQ::StorageCapacityValue = (cap / 1.0 [GiB]) [GiB];`, 'r'),
    ).toMatchObject({ magnitude: 2, unit: 'GiB' });
    expect(
      await quantity(`${cap} attribute r : ISQ::StorageCapacityValue = ((cap / 1.0 [GiB]) * 3.0) [GiB];`, 'r'),
    ).toMatchObject({ magnitude: 6, unit: 'GiB' });
    expect(
      await quantity('attribute k : Real = 3.0; attribute t : ISQ::StorageCapacityValue = (k * 2.0) [GiB];', 't'),
    ).toMatchObject({ magnitude: 6, unit: 'GiB' });
    // The dimensioned ratio is the number 2000, in km: not `d1` in its stored km.
    expect(
      await quantity(
        `attribute d1 : ISQ::LengthValue = 2.0 [km]; attribute d2 : ISQ::LengthValue = 1.0 [m];
         attribute len : ISQ::LengthValue = (d1 / d2) [km];`,
        'len',
      ),
    ).toMatchObject({ magnitude: 2000, unit: 'km' });
  });

  /*
   * The SMT axiom and the solver equation join `x == expr * 1.0 [unit]`, and
   * that is read for EVERY value of the inputs the model leaves free. At the
   * model's point, `(cap * k) [GiB]` with `k` valueless is merely unresolved —
   * no refusal — and joined it read `2^34·k` GiB, so `dbl >= 1000.0 [GiB]` was
   * PROVED from `k >= 1.0`. The join is decided on every path: each free input
   * a stand-in of its kind, both branches of every `if`.
   */
  it('a `[unit]` beside a value is joined only where it lands on a number on every path', async () => {
    const mem = (attrs: string) => `package P {
    part def Mem { attribute cap : ISQ::StorageCapacityValue = 2.0 [GiB]; ${attrs} }
    part m : Mem;
}
`;
    const refusal = async (attrs: string) => {
      const m = await bound(mem(attrs));
      return valueUnitRefusal(m, byName(m, 'x').id);
    };
    const relabel = 'a unit literal [GiB] was applied to an operand computed from a value in';
    const x = 'attribute x : ISQ::StorageCapacityValue';
    for (const attrs of [
      `attribute k : ScalarValues::Real; ${x} = (cap * k) [GiB];`,
      `attribute k : ScalarValues::Real; ${x} = (cap + k) [GiB];`,
      `attribute k : ScalarValues::Real; attribute y = cap * k; ${x} = (y) [GiB];`,
      `attribute big : ScalarValues::Boolean; ${x} = (if big then cap * 1.0 else cap * 2.0) [GiB];`,
      // A valueless amount of information is stored in bits, and one bound to
      // a literal is that literal's kind: neither is a number to relabel.
      `attribute y : ISQ::StorageCapacityValue; ${x} = (y) [GiB];`,
      `attribute y; bind y = cap; ${x} = (y * 2.0) [GiB];`,
    ]) {
      expect(await refusal(attrs), attrs).toContain(relabel);
    }
    // A number on one branch and an amount on the other is no one reading.
    expect(
      await refusal(`attribute big : ScalarValues::Boolean; ${x} = (if big then cap / 1.0 [GiB] else cap) [GiB];`),
    ).toContain('the branches of a conditional are different kinds of quantity');
    // A number on every path is joined, whatever the free inputs are.
    for (const attrs of [
      `attribute k : ScalarValues::Real; ${x} = (k * 2.0) [GiB];`,
      `attribute y : ISQ::StorageCapacityValue; ${x} = (y / 1.0 [GiB]) [GiB];`,
      `attribute y; bind y = cap; ${x} = (y / 1.0 [MiB]) [MiB];`,
      `attribute big : ScalarValues::Boolean; attribute k : ScalarValues::Real; ${x} = (if big then cap / 1.0 [GiB] else k) [GiB];`,
      `${x} = (6.0 [GiB] / 2.0 [GiB]) [GiB];`,
      'attribute d : ISQ::LengthValue; attribute x : ISQ::LengthValue = (d / 1.0 [m]) [km];',
    ]) {
      expect(await refusal(attrs), attrs).toBeUndefined();
    }
  });

  it('dimension one counts kinds apart: information, traffic, and each ratio by what it is a ratio of', () => {
    expect(dimensionOneKindsOf('GiB')).toEqual({ information: 1 });
    expect(dimensionOneKindsOf('kHart')).toEqual({ information: 1 });
    expect(dimensionOneKindsOf('E')).toEqual({ traffic: 1 });
    expect(dimensionOneKindsOf('mm/m')).toEqual({ 'L ratio': 1 });
    expect(dimensionOneKindsOf('km/m')).toEqual(dimensionOneKindsOf('mm/m'));
    expect(dimensionOneKindsOf('kWh/J')).toEqual({ 'L²·M·T⁻² ratio': 1 });
    expect(dimensionOneKindsOf('B/bit')).toEqual({ 'information ratio': 1 });
    expect(dimensionOneKindsOf('bit/E')).toEqual({ information: 1, traffic: -1 });
    for (const u of ['m', 'kg', '°C', 'bit/s', 'furlong']) expect(dimensionOneKindsOf(u), u).toBeUndefined();
  });

  it('walks a user attribute def that specializes an ISQ kind before declaring a mismatch', async () => {
    const m = await bound(
      `package P {
    attribute def HalfMass :> ISQ::MassValue;
    part def V { attribute mtow : ISQ::MassValue = 18.5 [kg]; attribute half : HalfMass = mtow / 2.0; }
    part v : V;
    requirement def R { subject v : V; require constraint { v.half <= 10.0 [kg] } }
}
`,
    );
    const d = dimensionClaimDetail(m, byName(m, 'half').id);
    expect(d.claim).toBe('consistent');
    expect(d.declared).toEqual(dim({ M: 1 }));
    expect(verdicts(m)).toEqual(['satisfied']);
    expect(validate(m, { ruleIds: ['derived-dimension-mismatch'] })).toEqual([]);
  });

  it('a dimensionless derivation on a kinded feature takes the kind by convention, like a literal', async () => {
    const m = await bound(uav('attribute limit : ISQ::MassValue = 2.0 * 12.5;', 'uav.mtow <= uav.limit'));
    const d = dimensionClaimDetail(m, byName(m, 'limit').id);
    expect(d.claim).toBe('consistent');
    expect(d.q).toMatchObject({ magnitude: 25, dimension: dim({ M: 1 }) });
    expect(verdicts(m)).toEqual(['satisfied']);
  });
});

/*
 * THE PROPERTY, OVER EVERY OPERATOR THIS GRAMMAR READS: `[unit]` is applied
 * only to a NUMBER — a magnitude that does not depend on what any amount of
 * dimension one in it is measured in. Each case is a value `x = (e) [B]` over
 * `cap = 2.0 [B]` and `one = 1.0 [B]` (information, with a unit), `s = 2.0
 * [mm/m]` (a ratio of lengths: dimension one too, and ANOTHER kind of it), the
 * plain `k = 3.0` and `h = 0.5`, and a length `len = 1.0 [m]`. Its reference
 * is `e` evaluated by the scalar evaluator of ./expr — which knows nothing of
 * units — with information read in bits, in bytes and in a base of three bits,
 * and the ratio in SI, in mm/m and in sevens, each independently of the other.
 * Where the readings disagree, `e` is an amount and the `[B]` must be refused
 * (`cap / s` is: one power of each summed to zero, and it was read as a
 * number); where the evaluator answers, `e` must be that one number and `x`
 * that many bytes. The operators are the grammar's own table, so one added
 * there is generated here.
 */
describe('`[unit]` takes a number: no operator makes a dimension-one quantity into one', () => {
  type Kind = 'information' | 'ratio';
  const LEAVES: Record<string, { attrs: Record<string, string | number>; amount?: [Kind, number]; value?: number }> = {
    cap: { attrs: { value: 2, unit: 'B' }, amount: ['information', 16] },
    one: { attrs: { value: 1, unit: 'B' }, amount: ['information', 8] },
    s: { attrs: { value: 2, unit: 'mm/m' }, amount: ['ratio', 0.002] },
    k: { attrs: { value: 3 }, value: 3 },
    h: { attrs: { value: 0.5 }, value: 0.5 },
    len: { attrs: { value: 1, unit: 'm' }, value: 1 },
  };
  const NAMES = Object.keys(LEAVES);
  /** The operators that compute a magnitude; every other one answers a truth value. */
  const ARITHMETIC = ['+', '-', '*', '/', '%', '^'];
  /** Each kind's unit, in SI: information in bits, bytes and threes of bits; the ratio in SI, mm/m and sevens. */
  const BASES: Array<Record<Kind, number>> = [
    { information: 1, ratio: 1 },
    { information: 8, ratio: 1 },
    { information: 3, ratio: 1 },
    { information: 1, ratio: 1e-3 },
    { information: 1, ratio: 7 },
  ];

  const shapes = (): string[] => {
    const out = new Set<string>();
    const { binary, prefix } = UNIT_AWARE_OPERATORS;
    const depth1: string[] = [];
    for (const op of binary) for (const a of NAMES) for (const b of NAMES) depth1.push(`(${a}) ${op} (${b})`);
    for (const s of depth1) {
      out.add(s);
      for (const p of prefix) out.add(`${p} (${s})`);
      // Each branch of a conditional, taken.
      out.add(`if k > h then (${s}) else (k)`);
      out.add(`if k < h then (k) else (${s})`);
    }
    const arithmetic = binary.filter((op) => ARITHMETIC.includes(op));
    for (const p of arithmetic) {
      for (const q of arithmetic) {
        for (const a of NAMES) {
          for (const b of NAMES) {
            for (const c of NAMES) {
              out.add(`((${a}) ${p} (${b})) ${q} (${c})`);
              out.add(`(${a}) ${p} ((${b}) ${q} (${c}))`);
            }
          }
        }
      }
    }
    return [...out];
  };

  /** `e` with each amount measured in its kind's `base`; `undefined` for no number. */
  const reference = (e: string, base: Record<Kind, number>): number | undefined => {
    const r = evaluate(parseExpr(e), (name) => {
      const leaf = LEAVES[name];
      if (leaf === undefined) return undefined;
      return leaf.amount === undefined ? leaf.value : leaf.amount[1] / base[leaf.amount[0]];
    });
    return 'value' in r && typeof r.value === 'number' ? r.value : undefined;
  };
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

  it('the grammar’s operators are the ones generated', () => {
    // The six that compute a magnitude are in the table; a new one there would
    // be generated at depth one, and fail below if it unwraps a quantity.
    expect(ARITHMETIC.every((op) => UNIT_AWARE_OPERATORS.binary.includes(op))).toBe(true);
    expect(UNIT_AWARE_OPERATORS.prefix).toEqual(['-', '+', 'not']);
  });

  it('is refused wherever the number depends on the unit, and right wherever it is answered', () => {
    const m = new Model();
    const p = m.create('Package', { declaredName: 'P' });
    const owner = m.create('PartUsage', { declaredName: 'ctx', ownerId: p.id });
    for (const [name, leaf] of Object.entries(LEAVES)) {
      m.create('AttributeUsage', { declaredName: name, ownerId: owner.id, attrs: leaf.attrs });
    }
    const cases = shapes().map((e, i) => ({
      e,
      id: m.create('AttributeUsage', {
        declaredName: `x${i}`,
        ownerId: owner.id,
        attrs: { value: `(${e})`, unit: 'B' },
      }).id,
    }));
    const memo = new Map();
    let answered = 0;
    let refusedQuantity = 0;
    let refusedAcrossKinds = 0;
    let answeredAcrossKinds = 0;
    const refusedThrough = new Set<string>();
    const across = (e: string) => /\bs\b/.test(e) && /\b(cap|one)\b/.test(e);
    for (const { e, id } of cases) {
      const q = dimensionClaimDetail(m, id, memo).q;
      const n = BASES.map((base) => reference(e, base));
      // A truth value has no unit to take, and an overflow or a root of a
      // negative number is no number to compare (`(h - k) ^ h`).
      if (!n.every((v) => v !== undefined && Number.isFinite(v))) continue;
      const number = n.every((v) => close(v!, n[0]!));
      if (q !== undefined) {
        answered++;
        if (across(e)) answeredAcrossKinds++;
        expect(number, `\`(${e}) [B]\` was given a unit, and its value is ${n.join(' / ')} across the units`).toBe(
          true,
        );
        expect(q.unit, e).toBe('B');
        expect(close(q.magnitude, n[0]!), `\`(${e}) [B]\` is ${q.magnitude} B, not ${n[0]}`).toBe(true);
      } else if (!number) {
        refusedQuantity++;
        if (across(e)) refusedAcrossKinds++;
        for (const op of ARITHMETIC) if (e.includes(` ${op} `)) refusedThrough.add(op);
      }
    }
    // Not vacuous (19 224 cases: 1 011 answered, 12 222 amounts refused, 3 770
    // of them over both kinds and none of those answered), and an amount
    // carried through every operator.
    expect(answered).toBeGreaterThan(1000);
    expect(refusedQuantity).toBeGreaterThan(12000);
    expect(refusedAcrossKinds).toBeGreaterThan(3500);
    expect(answeredAcrossKinds).toBe(0);
    expect([...refusedThrough].sort()).toEqual([...ARITHMETIC].sort());
  });

  it('carries the amount through each operator from either side, and lets a ratio of two go', () => {
    const quantityOf = (e: string) => {
      const m = new Model();
      const p = m.create('Package', { declaredName: 'P' });
      const owner = m.create('PartUsage', { declaredName: 'ctx', ownerId: p.id });
      for (const [name, leaf] of Object.entries(LEAVES)) {
        m.create('AttributeUsage', { declaredName: name, ownerId: owner.id, attrs: leaf.attrs });
      }
      const x = m.create('AttributeUsage', {
        declaredName: 'x',
        ownerId: owner.id,
        attrs: { value: `(${e})`, unit: 'B' },
      });
      return dimensionClaimDetail(m, x.id);
    };
    for (const op of ARITHMETIC) {
      for (const e of [`cap ${op} k`, `k ${op} cap`, `-(cap ${op} k)`, `if k > h then (cap ${op} k) else (k)`]) {
        expect([quantityOf(e).reason, quantityOf(e).detail], e).toEqual([
          'dimension-fault',
          'a unit literal [B] was applied to an operand computed from a value in "B" — dimension one is not unitless',
        ]);
      }
    }
    expect(quantityOf('cap / one').q).toMatchObject({ magnitude: 2, unit: 'B' });
    expect(quantityOf('(cap / one) ^ 2.0 + k').q).toMatchObject({ magnitude: 7, unit: 'B' });
    expect(quantityOf('cap ^ 0.0').q).toMatchObject({ magnitude: 1, unit: 'B' });
    // Powers cancel within a kind only: bytes over a ratio of lengths is still bytes.
    for (const e of ['cap / s', 's / cap', '(cap * s) / (one * s) * cap', 'cap / one * s']) {
      expect(quantityOf(e).reason, e).toBe('dimension-fault');
    }
    expect(quantityOf('s / s').q).toMatchObject({ magnitude: 1, unit: 'B' });
    expect(quantityOf('(cap * s) / (one * s)').q).toMatchObject({ magnitude: 2, unit: 'B' });
    // The operand's own unit is refused by the earlier rule, with its own sentence.
    expect(quantityOf('-cap').detail).toBe('a unit literal [B] was applied to an operand that already has unit "B"');
  });
});

describe('comparison tolerance and offset units', () => {
  function constraintModel(expression: string, attrs: Array<[string, Record<string, string | number>]> = []) {
    const m = new Model();
    const p = m.create('Package', { declaredName: 'P' });
    const owner = m.create('PartUsage', { declaredName: 'ctx', ownerId: p.id });
    for (const [name, a] of attrs) m.create('AttributeUsage', { declaredName: name, ownerId: owner.id, attrs: a });
    const c = m.create('ConstraintUsage', { declaredName: 'c', ownerId: owner.id, attrs: { expression } });
    return { m, c };
  }

  it('`1 [ft] == 12 [in]` is satisfied despite float noise in the conversion factors', () => {
    const { m, c } = constraintModel('1 [ft] == 12 [in]');
    expect(siValue({ magnitude: 1, dimension: dim({ L: 1 }), unit: 'ft' })).toBeCloseTo(0.3048, 12);
    expect(evaluateConstraintQuantity(m, c)).toBe('satisfied');
    expect(evaluateConstraintQuantity(constraintModel('1 [yd] == 3 [ft]').m, constraintModel('1 [yd] == 3 [ft]').c)).toBe(
      'satisfied',
    );
    expect(evaluateConstraintQuantity(constraintModel('1 [ft] != 12 [in]').m, constraintModel('1 [ft] != 12 [in]').c)).toBe(
      'violated',
    );
    expect(evaluateConstraintQuantity(constraintModel('1 [ft] == 13 [in]').m, constraintModel('1 [ft] == 13 [in]').c)).toBe(
      'violated',
    );
  });

  it('a Newton-solved `x * x == 2` at 1.414213562376508 is satisfied at the solve’s tolerance (relative 1e-9)', () => {
    // A value a solve produced has no exact reading: within the tolerance the
    // two sides are equal, which is all the solve claims of them.
    const solved = constraintModel('x * x == k', [
      ['x', { type: 'Real' }],
      ['k', { type: 'Real', value: 2.0 }],
    ]);
    const root = (n: string) => (n === 'x' ? { magnitude: 1.414213562376508, dimension: dim({}) } : undefined);
    expect(evaluateConstraintQuantityDetailed(solved.m, solved.c, { fallback: root, searched: true }).verdict).toBe(
      'satisfied',
    );
    // The same number STATED is the decimal the author wrote, decided
    // exactly: 1.414213562376508² is not 2 — and no reading of it is a tie.
    const stated = constraintModel('x * x == k', [
      ['x', { type: 'Real', value: 1.414213562376508 }],
      ['k', { type: 'Real', value: 2.0 }],
    ]);
    expect(evaluateConstraintQuantity(stated.m, stated.c)).toBe('violated');
    // But a real difference still shows.
    const bad = constraintModel('x * x == k', [
      ['x', { type: 'Real', value: 1.4143 }],
      ['k', { type: 'Real', value: 2.0 }],
    ]);
    expect(evaluateConstraintQuantity(bad.m, bad.c)).toBe('violated');
  });

  it('the caller absTol is honoured on values a solve produced, never on stated ones', () => {
    const solved = constraintModel('x <= 1.0', [['x', { type: 'Real' }]]);
    const at = (n: string) => (n === 'x' ? { magnitude: 1.0000004, dimension: dim({}) } : undefined);
    expect(evaluateConstraintQuantityDetailed(solved.m, solved.c, { fallback: at, searched: true }).verdict).toBe(
      'violated',
    );
    expect(
      evaluateConstraintQuantityDetailed(solved.m, solved.c, { fallback: at, searched: true, absTol: 1e-6 }).verdict,
    ).toBe('satisfied');
    // A strict ordering inside it turns on the very difference the solve does
    // not know: undecided, never read as a tie either way.
    const strict = constraintModel('x < 1.0', [['x', { type: 'Real' }]]);
    const r = evaluateConstraintQuantityDetailed(strict.m, strict.c, { fallback: at, searched: true, absTol: 1e-6 });
    expect([r.verdict, r.reason]).toEqual(['unknown', 'tie']);
    expect(r.detail).toMatch(/known only to that tolerance/);
    // A value the model states is the decimal written: 1.0000004 is more than
    // 1.0, whatever tolerance the caller brings.
    const { m, c } = constraintModel('x <= 1.0', [['x', { type: 'Real', value: 1.0000004 }]]);
    expect(evaluateConstraintQuantityDetailed(m, c).verdict).toBe('violated');
    expect(evaluateConstraintQuantityDetailed(m, c, { absTol: 1e-6 }).verdict).toBe('violated');
  });

  it('`dT == t2 - t1` in °C answers unknown with the offset reason', () => {
    const T = (v: number, unit: string) => ({ type: 'ISQ::TemperatureValue', value: v, unit });
    const { m, c } = constraintModel('dT == t2 - t1', [
      ['t1', T(20, '°C')],
      ['t2', T(30, '°C')],
      ['dT', T(10, '°C')],
    ]);
    const r = evaluateConstraintQuantityDetailed(m, c);
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('offset');
    expect(r.detail).toMatch(/offset temperature scale/);
    // In kelvin the same difference is an ordinary amount.
    const k = constraintModel('dT == t2 - t1', [
      ['t1', T(293.15, 'K')],
      ['t2', T(303.15, 'K')],
      ['dT', T(10, 'K')],
    ]);
    expect(evaluateConstraintQuantity(k.m, k.c)).toBe('satisfied');
  });

  it('`==` and `!=` leave a dimensionless side to the caller, exactly as an ordering does', () => {
    // The bare-literal contract: `limit == 25.0` on a 25 kg mass is the same
    // question as `limit >= 25.0`, which the caller's scalar path reads in the
    // declared kilograms. Equality used to answer it here — `false`, the
    // dimensions differ — so the value was violated against the number it states.
    const limit: [string, Record<string, string | number>] = ['limit', { type: 'ISQ::MassValue', value: 25 }];
    for (const body of ['limit == 25.0', 'limit != 25.0', 'limit >= 25.0']) {
      const { m, c } = constraintModel(body, [limit]);
      const r = evaluateConstraintQuantityDetailed(m, c);
      expect([body, r.verdict, r.reason, isRefusalReason(r.reason)]).toEqual([body, 'unknown', 'dimension', false]);
    }
    // Two real dimensions stay refused, for equality as for an ordering.
    for (const body of ['limit == 25.0 [m]', 'limit >= 25.0 [m]']) {
      const { m, c } = constraintModel(body, [limit]);
      expect([body, evaluateConstraintQuantityDetailed(m, c).reason]).toEqual([body, 'dimension-clash']);
    }
  });

  it('two absolute temperatures may still be ordered: `t2 >= 300 [K]` on a °C value', () => {
    const { m, c } = constraintModel('t2 >= 300 [K]', [['t2', { type: 'ISQ::TemperatureValue', value: 30, unit: '°C' }]]);
    const r = evaluateConstraintQuantityDetailed(m, c);
    expect(r.verdict).toBe('satisfied');
    expect(r.lhsSI).toBeCloseTo(303.15, 9);
    expect(r.rhsSI).toBe(300);
    expect(r.dimension).toEqual(dim({ Th: 1 }));
  });

  it('the fallback scope answers a name the model does not, never a reasoned unknown', () => {
    const { m, c } = constraintModel('y <= 2.0 [kg]');
    expect(evaluateConstraintQuantityDetailed(m, c).reason).toBe('unresolved');
    const r = evaluateConstraintQuantityDetailed(m, c, {
      fallback: (name) => (name === 'y' ? { magnitude: 1, dimension: dim({ M: 1 }), unit: 'kg' } : undefined),
    });
    expect(r.verdict).toBe('satisfied');
  });

  it('unitRefsIn collects the bracket units of an expression text', () => {
    expect(unitRefsIn('uav.mtow <= 25.0 [furlong]')).toEqual(['furlong']);
    expect(unitRefsIn('a [kg] + b [SI::kg] > 1 [g]')).toEqual(['kg', 'SI::kg', 'g']);
    expect(unitRefsIn('x#(1) [m]')).toEqual(['m']);
    expect(unitRefsIn('a + b')).toEqual([]);
  });
});

describe('review findings on the I1 semantics (strings, messages, strict tolerance, memo)', () => {
  beforeAll(async () => {
    await preloadFullLibrary();
  });

  it('brackets inside string literals are text, not unit references', () => {
    expect(unitRefsIn('"see table [3]"')).toEqual([]);
    expect(unitRefsIn("'row [x]'")).toEqual([]);
    expect(unitRefsIn('label == "x [zz]" and m <= 2 [kg]')).toEqual(['kg']);
    // The regex fallback (unlexable text) skips quoted spans too.
    expect(unitRefsIn('f("a [b]") #(1) [m]')).toEqual(['m']);
  });

  it('a string attribute with brackets is clean on the validation surface', async () => {
    const m = await bound(
      uav('attribute id = "R-UAV-001 [rev A]"; attribute note : String = \'see table [3]\';', 'uav.mtow <= 25.0 [kg]'),
    );
    expect(validate(m, { ruleIds: ['unknown-unit'] })).toEqual([]);
    expect(verdicts(m)).toEqual(['satisfied']);
  });

  it('a string literal inside a body names the real limitation, not the bracket', async () => {
    const m = await bound(uav('attribute label = "x";', 'uav.mtow <= 25.0 [kg] and uav.label == "x [zz]"'));
    expect(validate(m, { ruleIds: ['unknown-unit'] })).toEqual([]);
    const [check] = checkConstraints(m);
    expect(check.result).toBe('unknown');
    expect(check.message).toMatch(/string literal/);
    expect(check.message).toMatch(/the `\[unit\]` itself is legal/);
    expect(check.message).not.toMatch(/Unexpected character/);
  });

  it('a fault INSIDE a derivation names both the feature and the fault', async () => {
    const sum = await bound(
      uav('attribute payload : Real = 2.0; attribute total : ISQ::MassValue = mtow + payload;', 'uav.total <= 50.0 [kg]'),
    );
    const [c1] = checkConstraints(sum);
    expect(c1.result).toBe('unknown');
    expect(c1.message).toContain('"uav.total" cannot be derived');
    expect(c1.message).toContain('M and 1 are different physical dimensions');

    const unresolved = await bound(
      uav('attribute endurance : ISQ::DurationValue = battery.capacity / powerX;', 'uav.endurance >= 45.0 [min]'),
    );
    const [c2] = checkConstraints(unresolved);
    expect(c2.result).toBe('unknown');
    expect(c2.message).toContain('"uav.endurance" cannot be derived: "powerX" has no value in scope');

    const zero = await bound(
      uav('attribute zero : Real = 0.0; attribute bad : ISQ::DurationValue = battery.capacity / zero;', 'uav.bad >= 45.0 [min]'),
    );
    const [c3] = checkConstraints(zero);
    expect(c3.message).toContain('"uav.bad" cannot be derived: division by zero');
  });

  it('a boolean-valued feature is a boolean in a unit-bearing body, not a missing value', async () => {
    const m = await bound(uav('attribute armed : Boolean = true;', 'uav.armed and uav.mtow <= 25.0 [kg]'));
    expect(verdicts(m)).toEqual(['satisfied']);
    const off = await bound(uav('attribute armed : Boolean = false;', 'uav.armed and uav.mtow <= 25.0 [kg]'));
    expect(verdicts(off)).toEqual(['violated']);
  });

  it('a plain reference to an offset-scale value keeps the scale: it orders, and still refuses arithmetic', async () => {
    const S = (body: string) => `package P {
    part def S {
        attribute t1 : ISQ::TemperatureValue = 20.0 ['°C'];
        attribute t3 : ISQ::TemperatureValue = t1;
        attribute d : ISQ::TemperatureValue = t3 - t1;
    }
    part s : S;
    requirement def R { subject s : S; require constraint { ${body} } }
}
`;
    const ordered = await bound(S('s.t3 >= 250.0 [K]'));
    const d = dimensionClaimDetail(ordered, byName(ordered, 't3').id);
    expect(d.q).toMatchObject({ magnitude: 20, unit: '°C', absolute: true });
    expect(verdicts(ordered)).toEqual(['satisfied']);
    const diff = await bound(S('s.d <= 5.0 [K]'));
    const r = evaluateConstraintQuantityDetailed(diff, constraintOf(diff));
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('offset');
  });

  it('a tie within the tolerance is decided by the decimals written, on both surfaces (the tie rule)', async () => {
    // Reading every near tie as equal for every operator made `x < 25.0` at 25
    // and `0.1 + 0.2 > 0.3` hold where the solver refutes both; reading the
    // band strictly refuted `1.0 + 0.00000000000000001 > 1.0`, which binary64
    // rounds to a tie. Every comparison is now that of the exact decimals.
    const V = (body: string) => `package P {
    part def V {
        attribute a : Real = 6.0; attribute a2 : Real = 6.0000000001; attribute z : Real = 0.9999999999;
        attribute b : Real = 0.1; attribute big : Real = 10000000000000000.0; attribute bigger : Real = big + 1.0;
        attribute tiny : Real = 1.0 + 0.00000000000000001;
    }
    part v : V;
    requirement def R { subject v : V; require constraint { ${body} } }
}
`;
    const cases: Array<[string, 'satisfied' | 'violated']> = [
      // A near miss is no tie to the decimals: each side reads as written …
      ['v.a < v.a2', 'satisfied'],
      ['v.a2 > v.a', 'satisfied'],
      ['v.z < 1.0', 'satisfied'],
      ['v.a <= v.a2', 'satisfied'],
      ['v.a2 >= v.a', 'satisfied'],
      ['v.a == v.a2', 'violated'],
      ['v.a != v.a2', 'satisfied'],
      // … an exact tie is equal for every operator, the strict ones violated …
      ['v.a < 6.0', 'violated'],
      ['v.a > 6.0', 'violated'],
      ['v.a <= 6.0', 'satisfied'],
      ['v.a != 6.0', 'violated'],
      // … the noise of binary64 arithmetic decides nothing …
      ['v.b + 0.2 > 0.3', 'violated'],
      ['v.b + 0.2 < 0.3', 'violated'],
      ['v.b + 0.2 == 0.3', 'satisfied'],
      // … nor does what it absorbs …
      ['v.tiny > 1.0', 'satisfied'],
      ['v.tiny <= 1.0', 'violated'],
      ['v.bigger > v.big', 'satisfied'],
      ['v.bigger == v.big', 'violated'],
      // … and a real difference still orders strictly.
      ['v.a2 < v.z', 'violated'],
      ['v.z < 0.9', 'violated'],
    ];
    for (const [body, expected] of cases) {
      const m = await bound(V(body));
      expect(verdicts(m), body).toEqual([expected]);
      expect(checkConstraintsNumeric(m).map((c) => c.result), body).toEqual([expected]);
    }
  });

  it('a tie no exact reading decides is undecided on both surfaces, never read either way', async () => {
    // `2.0 ^ 0.5` has no exact reading, and its square is 2.0000000000000004 in
    // binary64: within the tolerance of 2, so neither surface can say which.
    const m = await bound(`package P {
    part def V { attribute r : Real = 2.0 ^ 0.5; }
    part v : V;
    requirement def R1 { subject v : V; require constraint { v.r * v.r == 2.0 } }
    requirement def R2 { subject v : V; require constraint { v.r * v.r > 2.0 } }
    requirement def R3 { subject v : V; require constraint { v.r * v.r >= 1.9 } }
}
`);
    const checks = checkConstraints(m);
    expect(checks.map((c) => c.result)).toEqual(['unknown', 'unknown', 'satisfied']);
    expect(checks.map((c) => c.tie)).toEqual([true, true, undefined]);
    expect(checks[0].message).toMatch(
      /equal within the evaluators' relative tolerance .* no exact reading decides them/,
    );
    const numeric = checkConstraintsNumeric(m);
    expect(numeric.map((r) => r.result)).toEqual(['unknown', 'unknown', 'satisfied']);
    expect(numeric[0].reason).toMatch(/no exact reading decides them/);
    const el = constraintOf(m);
    const r = evaluateConstraintQuantityDetailed(m, el);
    expect([r.verdict, r.reason, isRefusalReason(r.reason)]).toEqual(['unknown', 'tie', true]);
  });

  it('a chain of shared derivations validates in linear time (memo)', async () => {
    // f_i = f_{i-1} + f_{i-2}: without a memo each lookup re-derives its
    // operands through their own scopes — 2^N paths — and N=24 already took
    // a second in validate(); N=40 would not finish.
    const N = 40;
    let attrs = 'attribute f1 : Real = 1.0; attribute f2 : Real = 1.0;';
    for (let i = 3; i <= N; i++) attrs += ` attribute f${i} : Real = f${i - 1} + f${i - 2};`;
    const m = await bound(`package P {
    part def V { ${attrs} }
    part v : V;
    requirement def R { subject v : V; require constraint { v.f${N} > 0.0 } }
}
`);
    const t0 = performance.now();
    expect(validate(m, { ruleIds: ['derived-dimension-mismatch'] })).toEqual([]);
    expect(verdicts(m)).toEqual(['satisfied']);
    expect(dimensionClaimDetail(m, byName(m, `f${N}`).id).q?.magnitude).toBe(102334155);
    expect(performance.now() - t0).toBeLessThan(5000);
  }, 10_000);
});

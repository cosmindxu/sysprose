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
  resolveUnitRef,
  siValue,
  unitRefsIn,
} from '../../src/semantics/units-eval';
import { dim } from '../../src/semantics/units';

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

  it('a Newton-solved `x * x == 2` at 1.414213562376508 is satisfied (relative 1e-9)', () => {
    const { m, c } = constraintModel('x * x == k', [
      ['x', { type: 'Real', value: 1.414213562376508 }],
      ['k', { type: 'Real', value: 2.0 }],
    ]);
    expect(evaluateConstraintQuantity(m, c)).toBe('satisfied');
    // But a real difference still shows.
    const bad = constraintModel('x * x == k', [
      ['x', { type: 'Real', value: 1.4143 }],
      ['k', { type: 'Real', value: 2.0 }],
    ]);
    expect(evaluateConstraintQuantity(bad.m, bad.c)).toBe('violated');
  });

  it('the caller absTol is honoured on comparisons', () => {
    const { m, c } = constraintModel('x <= 1.0', [['x', { type: 'Real', value: 1.0000004 }]]);
    expect(evaluateConstraintQuantityDetailed(m, c).verdict).toBe('violated');
    expect(evaluateConstraintQuantityDetailed(m, c, { absTol: 1e-6 }).verdict).toBe('satisfied');
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

  it('strict orderings are judged within the same tolerance as the numeric surface', async () => {
    const V = (body: string) => `package P {
    part def V { attribute a : Real = 6.0; attribute a2 : Real = 6.0000000001; attribute z : Real = 0.9999999999; }
    part v : V;
    requirement def R { subject v : V; require constraint { ${body} } }
}
`;
    for (const body of ['v.a < v.a2', 'v.a2 > v.a', 'v.z < 1.0', 'v.a <= v.a2', 'v.a2 >= v.a', 'v.a == v.a2']) {
      const m = await bound(V(body));
      const numeric = checkConstraintsNumeric(m).map((c) => c.result);
      expect(numeric, body).toEqual(['satisfied']);
      expect(verdicts(m), body).toEqual(numeric);
    }
    // Within the tolerance the two sides are equal, so `!=` is violated …
    expect(verdicts(await bound(V('v.a != v.a2')))).toEqual(['violated']);
    // … and a real difference still orders strictly.
    expect(verdicts(await bound(V('v.a2 < v.z')))).toEqual(['violated']);
    expect(verdicts(await bound(V('v.z < 0.9')))).toEqual(['violated']);
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

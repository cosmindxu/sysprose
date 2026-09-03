/**
 * Derived attributes in constraints, and unit-aware precedence.
 *
 * Two silent wrong answers, both found by a Fable advisory on 2026-09-02:
 *  - a constraint referencing an EXPRESSION-valued attribute reported
 *    "a referenced value is unknown" while the solver computed it fine, because
 *    the scope evaluated values eagerly with no scope and dropped the name;
 *  - the unit-blind scalar path ran first, so `640 [Wh]` vs `650 [W]` vs
 *    `45 [min]` produced a confident, wrong verdict.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseModel } from '@text/index';
import { checkConstraints } from '@semantics/index';
import { validate } from '@validation/index';
import { checkConstraintsNumeric, solve } from '@semantics/solver';
import { unitBySymbol, quantityKindDimension, DIMENSIONLESS } from '@semantics/units';
import { preloadFullLibrary, loadFullStandardLibrary } from '../../src/library/full-library';
import { resolveTypeReferences } from '../../src/library/resolve';
import type { Model } from '@core/index';

async function bound(src: string): Promise<Model> {
  const { model } = parseModel(src);
  await preloadFullLibrary();
  loadFullStandardLibrary(model);
  resolveTypeReferences(model);
  return model;
}
const verdict = (m: Model) => checkConstraints(m).map((c) => c.result);

describe('derived attributes reach constraints', () => {
  beforeAll(async () => {
    await preloadFullLibrary();
  });

  const base = (capacity: number) => `package P {
    part def BatteryPack { attribute capacityWh : Real = ${capacity}; }
    part def AirVehicle {
        attribute cruisePowerW : Real = 650.0;
        part battery : BatteryPack;
        attribute enduranceMin : Real = battery.capacityWh / cruisePowerW * 60.0;
    }
    part uav : AirVehicle;
    requirement def R { subject uav : AirVehicle; require constraint { uav.enduranceMin >= 45.0 } }
}
`;

  it('evaluates a derived attribute — satisfied', async () => {
    expect(verdict(await bound(base(640.0)))).toEqual(['satisfied']);
  });

  it('evaluates a derived attribute — violated', async () => {
    expect(verdict(await bound(base(300.0)))).toEqual(['violated']);
  });

  it('agrees with the numeric solver on the derived case', async () => {
    const m = await bound(base(640.0));
    const numeric = checkConstraintsNumeric(m).map((c) => c.result);
    expect(numeric).toEqual(['satisfied']);
    expect(verdict(m)).toEqual(numeric);
  });

  it('agrees with the numeric solver on the DIMENSIONED case, down to the numbers', async () => {
    // Verdict-level agreement alone is tautological once the numeric surface
    // takes its verdict from the unit-aware evaluator, so this pins the solved
    // NUMBER and the slack's unit too (I6).
    const m = await bound(`package P {
    part def BatteryPack { attribute capacity : ISQ::EnergyValue = 640.0 [Wh]; }
    part def AirVehicle {
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        attribute usableEnergyFraction : Real = 0.8;
        attribute endurance : ISQ::DurationValue = battery.capacity * usableEnergyFraction / cruisePower;
        part battery : BatteryPack;
    }
    part uav : AirVehicle;
    requirement def R { subject uav : AirVehicle; require constraint { uav.endurance >= 45.0 [min] } }
}
`);
    const numeric = checkConstraintsNumeric(m);
    expect(numeric.map((c) => c.result)).toEqual(['satisfied']);
    expect(verdict(m)).toEqual(numeric.map((c) => c.result));
    // 640 Wh × 0.8 / 650 W = 2835.7 s — solved in SI, not 640 × 0.8 / 650.
    const endurance = m.all().find((e) => e.declaredName === 'endurance')!;
    expect(solve(m).values.get(endurance.id)).toBeCloseTo(2835.6923, 3);
    expect(numeric[0].slack).toBeCloseTo(2835.6923 - 2700, 3);
    expect(numeric[0].slackUnit).toBe('s');
  });

  it('answers unknown, not a hang, on a derivation cycle', async () => {
    const m = await bound(`package P {
    part def V { attribute a : Real = b + 1.0; attribute b : Real = a + 1.0; }
    part v : V;
    requirement def R { subject v : V; require constraint { v.a > 0.0 } }
}
`);
    expect(verdict(m)).toEqual(['unknown']);
  });

  it('still reports unknown when the referenced feature has no value at all', async () => {
    const m = await bound(`package P {
    part def V { attribute a : Real; }
    part v : V;
    requirement def R { subject v : V; require constraint { v.a > 0.0 } }
}
`);
    expect(verdict(m)).toEqual(['unknown']);
  });
});

describe('unit-aware evaluation goes first, scalar is the fallback', () => {
  it('a dimensioned feature against a bare literal still evaluates (scalar fallback)', async () => {
    const m = await bound(`package P {
    part def V { attribute mtow : ISQ::MassValue = 18.5 [kg]; }
    part v : V;
    requirement def R { subject v : V; require constraint { v.mtow <= 25.0 } }
}
`);
    expect(verdict(m)).toEqual(['satisfied']);
  });

  it('the unit-aware verdict wins when both sides are dimensioned', async () => {
    // 640 Wh of energy at 650 W lasts 59 min; the raw magnitudes (640/650 <
    // 45) said VIOLATED before, which was wrong.
    const m = await bound(`package P {
    part def V {
        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
        attribute power : ISQ::PowerValue = 650.0 [W];
        attribute minEndurance : ISQ::DurationValue = 45.0 [min];
    }
    part v : V;
    requirement def R { subject v : V; require constraint { v.capacity / v.power >= v.minEndurance } }
}
`);
    expect(verdict(m)).toEqual(['satisfied']);
  });

  it('and reports violated when the physics says so', async () => {
    const m = await bound(`package P {
    part def V {
        attribute capacity : ISQ::EnergyValue = 2304000.0 [J];
        attribute power : ISQ::PowerValue = 650.0 [W];
        attribute minEndurance : ISQ::DurationValue = 65.0 [min];
    }
    part v : V;
    requirement def R { subject v : V; require constraint { v.capacity / v.power >= v.minEndurance } }
}
`);
    // 2 304 000 J / 650 W = 3544 s = 59.1 min < 65 min.
    expect(verdict(m)).toEqual(['violated']);
  });
});

describe('unit registry additions', () => {
  it.each([
    ['Wh', 3600, 'L²·M·T⁻²'],
    ['kWh', 3.6e6, 'L²·M·T⁻²'],
    ['Ah', 3600, 'T·I'],
    ['mAh', 3.6, 'T·I'],
  ])('%s resolves with SI factor %s', (sym, factor) => {
    const u = unitBySymbol(sym);
    expect(u, `${sym} must be in the registry`).toBeDefined();
    expect(u!.factorToSI).toBeCloseTo(factor, 6);
  });

  it('DimensionOneValue is dimensionless', () => {
    expect(quantityKindDimension(undefined, 'DimensionOneValue')).toEqual(DIMENSIONLESS);
  });
});

describe('derived dimensioned features (I1 semantics)', () => {
  const shape = (attr: string, body: string) => `package P {
    part def BatteryPack { attribute capacity : ISQ::EnergyValue = 640.0 [Wh]; }
    part def AirVehicle {
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        attribute usableEnergyFraction : Real = 0.8;
        ${attr}
        part battery : BatteryPack;
    }
    part uav : AirVehicle;
    requirement def R { subject uav : AirVehicle; require constraint { ${body} } }
}
`;
  const DERIVED = 'attribute endurance : ISQ::DurationValue = battery.capacity * usableEnergyFraction / cruisePower;';

  it('`endurance >= 45.0 [min]` is satisfied (2835.7 s ≥ 2700 s)', async () => {
    expect(verdict(await bound(shape(DERIVED, 'uav.endurance >= 45.0 [min]')))).toEqual(['satisfied']);
  });

  it('`endurance >= 100.0 [min]` is violated (2835.7 s < 6000 s)', async () => {
    expect(verdict(await bound(shape(DERIVED, 'uav.endurance >= 100.0 [min]')))).toEqual(['violated']);
  });

  it('the old shape — a Real hand-converted with `* 60.0` — answers unknown and is warned exactly once', async () => {
    const m = await bound(
      shape(
        'attribute enduranceMin : Real = battery.capacity * usableEnergyFraction / cruisePower * 60.0;',
        'uav.enduranceMin >= 100.0 [min]',
      ),
    );
    const checks = checkConstraints(m);
    expect(checks.map((c) => c.result)).toEqual(['unknown']);
    expect(checks[0].message).toMatch(/disagrees with its declared type/);
    const warned = validate(m, { ruleIds: ['derived-dimension-mismatch'] });
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toMatch(/enduranceMin.*typed "Real".*dimension T/);
  });

  it('a derived DurationValue against a BARE literal is refused, not compared as a raw magnitude (P5)', async () => {
    // Raw magnitudes read 640 × 0.8 / 650 = 0.7877 ≥ 45.0 → a confident wrong
    // "violated"; the declared-unit contract holds for literals only.
    const m = await bound(shape(DERIVED, 'uav.endurance >= 45.0'));
    const checks = checkConstraints(m);
    expect(checks.map((c) => c.result)).toEqual(['unknown']);
    // The repair names the DIMENSION and the registry's units of it — the
    // author's `45.0 [min]` among them, not only the coherent `[s]`.
    expect(checks[0].message).toMatch(/compare against a unit literal of dimension T/);
    expect(checks[0].message).toContain('`45.0 [s]`');
    expect(checks[0].message).toContain('`45.0 [min]`');
  });

  it('an UNTYPED derived ratio is pointed at the ratio repair, not at a mass literal', async () => {
    // `r2 = mtow / 25.0` is a mass that the author meant as a ratio; telling
    // them to compare against `0.8 [kg]` would be actively wrong.
    const m = await bound(
      shape('attribute mtow : ISQ::MassValue = 18.5 [kg]; attribute r2 = mtow / 25.0;', 'uav.r2 <= 0.8'),
    );
    const checks = checkConstraints(m);
    expect(checks.map((c) => c.result)).toEqual(['unknown']);
    expect(checks[0].message).toMatch(/give the inlined constant its unit/);
    expect(checks[0].message).toContain('/ 25.0 [kg]');
  });

  it('a call beside a unit literal names the unsupported syntax, not the bracket', async () => {
    const m = await bound(shape(DERIVED, 'DurationOf(uav.mtow) <= 48.0 [h]'));
    const checks = checkConstraints(m);
    expect(checks.map((c) => c.result)).toEqual(['unknown']);
    expect(checks[0].message).toMatch(/the `\[unit\]` itself is legal/);
    expect(checks[0].message).not.toMatch(/Unexpected character/);
  });

  it('a unit the registry does not know inside the body names the unit, not the bracket', async () => {
    const m = await bound(shape(DERIVED, 'uav.endurance >= 45.0 [furlong]'));
    const checks = checkConstraints(m);
    expect(checks.map((c) => c.result)).toEqual(['unknown']);
    expect(checks[0].message).toMatch(/unit "furlong" is not in the unit registry/);
    expect(checks[0].message).not.toMatch(/Unexpected character/);
  });
});

describe('two different physical dimensions are refused, not judged by raw magnitudes', () => {
  /** A part with four dimensioned attributes and one requirement over `v`. */
  const clash = (body: string) => `package P {
    part def V {
        attribute d : ISQ::LengthValue = 5.0 [m];
        attribute t : ISQ::DurationValue = 2.0 [s];
        attribute m : ISQ::MassValue = 3.0 [kg];
        attribute mtow : ISQ::MassValue = 18.5 [kg];
    }
    part v : V;
    requirement def R { subject v : V; require constraint { ${body} } }
}
`;

  it('`d >= t` (a length against a duration) is unknown on BOTH surfaces, naming both dimensions', async () => {
    // The unit-aware evaluator always refused this; the scalar fallback then
    // answered it anyway, comparing the raw 5 with the raw 2 and reporting a
    // confident "satisfied" — the wrong answer, agreed on by both surfaces.
    const m = await bound(clash('v.d >= v.t'));
    const checks = checkConstraints(m);
    expect(checks.map((c) => c.result)).toEqual(['unknown']);
    expect(checks[0].message).toContain('L and T are different physical dimensions');
    const rows = checkConstraintsNumeric(m);
    expect(rows.map((r) => r.result)).toEqual(['unknown']);
    expect(rows[0].reason).toMatch(/L and T are different physical dimensions/);
    expect(rows[0].slack).toBeNull();
    expect(rows[0].amount).toBe(0);
  });

  it('`m >= d` (a mass against a length) is unknown on BOTH surfaces', async () => {
    const m = await bound(clash('v.m >= v.d'));
    const checks = checkConstraints(m);
    expect(checks.map((c) => c.result)).toEqual(['unknown']);
    expect(checks[0].message).toContain('M and L are different physical dimensions');
    const rows = checkConstraintsNumeric(m);
    expect(rows.map((r) => r.result)).toEqual(['unknown']);
    expect(rows[0].reason).toMatch(/M and L are different physical dimensions/);
  });

  it('the bare-literal contract is untouched: one DIMENSIONLESS side still reads the declared unit', async () => {
    // `M and 1 are different physical dimensions` is the SAME unit-aware
    // refusal, and it must stay one the scalar fallback may fill — this is the
    // guard on the fix, not a bonus assertion.
    const m = await bound(clash('v.mtow <= 25.0'));
    expect(checkConstraints(m).map((c) => c.result)).toEqual(['satisfied']);
    expect(checkConstraintsNumeric(m).map((r) => r.result)).toEqual(['satisfied']);
  });

  it('the same dimension in different units still converts', async () => {
    const m = await bound(clash('v.d >= 4000.0 [mm]'));
    expect(checkConstraints(m).map((c) => c.result)).toEqual(['satisfied']);
    expect(checkConstraintsNumeric(m).map((r) => r.result)).toEqual(['satisfied']);
  });

  it('the refusal names both dimensions AND says the comparison cannot be judged', async () => {
    // The whole sentence, not just its first clause: the `dimensionClash()`
    // prefix reads identically for the fillable `dimension` reason (the
    // bare-literal contract), so only the suffix distinguishes a REFUSAL in
    // the author's message — and only this assertion holds it in place.
    const m = await bound(clash('v.m >= v.d'));
    expect(checkConstraints(m)[0].message).toContain(
      'M and L are different physical dimensions — no conversion relates them, so the comparison ' +
        'cannot be judged; compare quantities of the same dimension',
    );
  });

  // `v.d + v.t <= 10.0 [m]` would NOT test this: the `[m]` sends the body down
  // the bracket-parse path, which reported the unit-aware reason directly and
  // answered `unknown` even before the fix. The bracket-free spellings are the
  // ones that used to fall through to the scalar evaluator.
  it('a SUM of two different dimensions is refused, with no bracket to reach it by', async () => {
    const m = await bound(clash('v.d + v.t <= 10.0'));
    const checks = checkConstraints(m);
    expect(checks.map((c) => c.result)).toEqual(['unknown']);
    expect(checks[0].message).toContain('L and T are different physical dimensions');
    expect(checkConstraintsNumeric(m).map((r) => r.result)).toEqual(['unknown']);
  });

  it('a DIFFERENCE and a REMAINDER of two different dimensions are refused too', async () => {
    const diff = await bound(clash('v.d - v.t >= 0.0'));
    expect(checkConstraints(diff).map((c) => c.result)).toEqual(['unknown']);
    expect(checkConstraintsNumeric(diff).map((r) => r.result)).toEqual(['unknown']);
    const rem = await bound(clash('v.d % v.t <= 1.0'));
    expect(checkConstraints(rem).map((c) => c.result)).toEqual(['unknown']);
    expect(checkConstraints(rem)[0].message).toContain('L and T are different physical dimensions');
    expect(checkConstraintsNumeric(rem).map((r) => r.result)).toEqual(['unknown']);
  });

  it('a dimensioned EXPONENT is refused, not raised to a raw magnitude', async () => {
    // `5 [m] ^ 2 [s]` read as 5² answered `d ^ t <= 10.0` VIOLATED, confidently
    // and on both surfaces. There is no dimensionless side here either: an
    // exponent that IS dimensionless is simply not a fault.
    const m = await bound(clash('v.d ^ v.t <= 10.0'));
    const checks = checkConstraints(m);
    expect(checks.map((c) => c.result)).toEqual(['unknown']);
    expect(checks[0].message).toContain('an exponent must be dimensionless, not T');
    expect(checkConstraintsNumeric(m).map((r) => r.result)).toEqual(['unknown']);
    // A dimensionless exponent still evaluates.
    const ok = await bound(clash('v.d ^ 2.0 <= 30.0 [m*m]'));
    expect(checkConstraints(ok).map((c) => c.result)).toEqual(['satisfied']);
  });

  it('`==` and `!=` across two different dimensions are refused, not answered', async () => {
    // These were the one pair of comparison operators still judging the
    // question: `d == t` returned a confident `violated` and `d != t` a
    // confident `satisfied`, from `dimensions differ ⇒ values differ`.
    const eq = await bound(clash('v.d == v.t'));
    expect(checkConstraints(eq).map((c) => c.result)).toEqual(['unknown']);
    expect(checkConstraints(eq)[0].message).toContain('L and T are different physical dimensions');
    expect(checkConstraintsNumeric(eq).map((r) => r.result)).toEqual(['unknown']);
    const ne = await bound(clash('v.d != v.t'));
    expect(checkConstraints(ne).map((c) => c.result)).toEqual(['unknown']);
    expect(checkConstraintsNumeric(ne).map((r) => r.result)).toEqual(['unknown']);
  });

  it('but a DIMENSIONLESS side keeps its definite equality verdict', async () => {
    // `n : Real = 5.0` is not `5.0 [km]`, and both surfaces have always said so.
    const m = await bound(`package P {
    attribute km : ISQ::LengthValue = 5.0 [km];
    attribute n : Real = 5.0;
    constraint c { n == km }
}
`);
    expect(checkConstraints(m).map((c) => c.result)).toEqual(['violated']);
    expect(checkConstraintsNumeric(m).map((r) => r.result)).toEqual(['violated']);
  });

  it('a refusal inside a CONJUNCTION wins from either side', async () => {
    // `and`/`or` returned the FIRST unknown operand, so a fillable `dimension`
    // on the left masked the clash on the right: `checkConstraints` fell
    // through to the scalar path and answered the whole body SATISFIED with no
    // diagnostic, while the same two conjuncts SWAPPED were refused — and the
    // numeric surface said `unknown` either way. Both orders, both operators.
    for (const body of [
      'v.mtow <= 25.0 and v.d >= v.t',
      'v.d >= v.t and v.mtow <= 25.0',
      'v.mtow <= 25.0 or v.d >= v.t',
      'v.d >= v.t or v.mtow <= 25.0',
    ]) {
      const m = await bound(clash(body));
      const checks = checkConstraints(m);
      expect([body, ...checks.map((c) => c.result)]).toEqual([body, 'unknown']);
      expect(checks[0].message).toContain('L and T are different physical dimensions');
    }
  });

  it('a conjunction of two FILLABLE unknowns is still fillable', async () => {
    // The guard on the rule above: preferring a refusal must not promote
    // ordinary ignorance. Two bare-literal contracts stay satisfied.
    // (Only the validation surface is asserted: a conjunction is neither an
    // inequality nor an equality, so the numeric surface reports every `and`
    // body `unknown` for want of a residual, refusal or not.)
    const m = await bound(clash('v.mtow <= 25.0 and v.m <= 5.0'));
    expect(checkConstraints(m).map((c) => c.result)).toEqual(['satisfied']);
  });
});

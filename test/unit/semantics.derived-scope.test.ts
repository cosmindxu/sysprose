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
import { checkConstraintsNumeric } from '@semantics/solver';
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

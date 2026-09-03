import { describe, it, expect } from 'vitest';
import { Model } from '@core/index';
import { loadStandardLibrary } from '../../src/library/index';
import {
  DIMENSIONLESS,
  dim,
  multiplyDim,
  divideDim,
  powDim,
  dimEqual,
  dimToString,
  SI_PREFIXES,
  prefixFactor,
  UNIT_REGISTRY,
  unitByName,
  unitBySymbol,
  resolveUnit,
  normalizeUnitRef,
  BINARY_PREFIXES,
  dimensionOf,
  areCompatible,
  convert,
  libraryUnitName,
  quantityKindDimension,
  resolveQualifiedNameFull,
} from '../../src/semantics/index';

function libModel(): Model {
  const m = new Model();
  loadStandardLibrary(m);
  return m;
}

describe('semantics — units: conversion', () => {
  it('1 km → 1000 m', () => {
    expect(convert(1, 'km', 'm')).toBeCloseTo(1000, 9);
  });

  it('1 hour → 3600 s', () => {
    expect(convert(1, 'hour', 'second')).toBeCloseTo(3600, 9);
    expect(convert(1, 'h', 's')).toBeCloseTo(3600, 9);
  });

  it('1 mile → 1609.344 m', () => {
    expect(convert(1, 'mile', 'metre')).toBeCloseTo(1609.344, 9);
  });

  it('1 inch → 0.0254 m', () => {
    expect(convert(1, 'inch', 'metre')).toBeCloseTo(0.0254, 12);
  });

  it('0 °C → 273.15 K', () => {
    expect(convert(0, 'degreeCelsius', 'kelvin')).toBeCloseTo(273.15, 9);
    expect(convert(0, '°C', 'K')).toBeCloseTo(273.15, 9);
  });

  it('32 °F → 273.15 K', () => {
    expect(convert(32, 'fahrenheit', 'kelvin')).toBeCloseTo(273.15, 9);
    expect(convert(32, '°F', 'K')).toBeCloseTo(273.15, 9);
  });

  it('100 °C → 373.15 K and 212 °F round-trip', () => {
    expect(convert(100, '°C', 'K')).toBeCloseTo(373.15, 9);
    expect(convert(212, '°F', '°C')).toBeCloseTo(100, 9);
  });

  it('incompatible convert (metre → second) is rejected', () => {
    expect(() => convert(1, 'metre', 'second')).toThrow(/[Ii]ncompatible/);
  });

  it('unknown unit is rejected', () => {
    expect(() => convert(1, 'furlong', 'metre')).toThrow();
  });
});

describe('semantics — units: dimensions', () => {
  it('dimension of newton = L·M·T⁻²', () => {
    expect(dimToString(dimensionOf('newton')!)).toBe('L·M·T⁻²');
  });

  it('speed = length / time = L·T⁻¹', () => {
    const speed = divideDim(dim({ L: 1 }), dim({ T: 1 }));
    expect(dimToString(speed)).toBe('L·T⁻¹');
    expect(dimEqual(speed, dim({ L: 1, T: -1 }))).toBe(true);
  });

  it('multiplyDim adds exponents (force · length = energy)', () => {
    const energy = multiplyDim(dim({ L: 1, M: 1, T: -2 }), dim({ L: 1 }));
    expect(dimToString(energy)).toBe('L²·M·T⁻²');
  });

  it('powDim scales exponents (length² = area)', () => {
    expect(dimToString(powDim(dim({ L: 1 }), 2))).toBe('L²');
  });

  it('DIMENSIONLESS renders as 1', () => {
    expect(dimToString(DIMENSIONLESS)).toBe('1');
  });

  it('temperature dimension prints Θ', () => {
    expect(dimToString(dimensionOf('kelvin')!)).toBe('Θ');
  });
});

describe('semantics — units: prefixes', () => {
  it('kilo = 1e3, milli = 1e-3', () => {
    expect(prefixFactor('kilo')).toBe(1e3);
    expect(prefixFactor('milli')).toBe(1e-3);
  });

  it('registry defines the full yotta..yocto span', () => {
    expect(SI_PREFIXES).toHaveLength(20);
    expect(prefixFactor('yotta')).toBe(1e24);
    expect(prefixFactor('yocto')).toBe(1e-24);
  });

  it('prefixed symbols resolve (km, mm, ms)', () => {
    expect(unitBySymbol('km')!.factorToSI).toBeCloseTo(1000, 9);
    expect(unitBySymbol('mm')!.factorToSI).toBeCloseTo(1e-3, 12);
    expect(unitBySymbol('ms')!.factorToSI).toBeCloseTo(1e-3, 12);
  });

  it('exact symbols win over prefix decomposition (min = minute)', () => {
    expect(unitBySymbol('min')!.name).toBe('minute');
  });

  it('milligram resolves via gram (1e-6 kg)', () => {
    expect(unitByName('milligram')!.factorToSI).toBeCloseTo(1e-6, 15);
  });
});

describe('semantics — units: registry & compatibility', () => {
  it('unitByName / unitBySymbol resolve base units', () => {
    expect(unitByName('metre')!.symbol).toBe('m');
    expect(unitBySymbol('m')!.name).toBe('metre');
    expect(UNIT_REGISTRY.length).toBeGreaterThan(20);
  });

  it('areCompatible tracks dimension identity', () => {
    expect(areCompatible('metre', 'mile')).toBe(true);
    expect(areCompatible('metre', 'second')).toBe(false);
    expect(areCompatible('joule', 'newton')).toBe(false);
  });
});

describe('semantics — units: library bridges', () => {
  it("libraryUnitName('metre') = 'SI::metre'", () => {
    expect(libraryUnitName('metre')).toBe('SI::metre');
    expect(libraryUnitName('inch')).toBe('USCustomaryUnits::inch');
  });

  it('mapped library unit names resolve in the loaded library', () => {
    const m = libModel();
    expect(m.resolveQualifiedName(libraryUnitName('metre')!)).toBeTruthy();
    expect(m.resolveQualifiedName(libraryUnitName('newton')!)).toBeTruthy();
  });

  it("quantityKindDimension('SpeedValue') = L·T⁻¹", () => {
    expect(dimToString(quantityKindDimension(undefined, 'SpeedValue')!)).toBe('L·T⁻¹');
  });

  it('quantityKindDimension covers force, energy, power, pressure', () => {
    expect(dimToString(quantityKindDimension(undefined, 'ForceValue')!)).toBe('L·M·T⁻²');
    expect(dimToString(quantityKindDimension(undefined, 'EnergyValue')!)).toBe('L²·M·T⁻²');
    expect(dimToString(quantityKindDimension(undefined, 'PowerValue')!)).toBe('L²·M·T⁻³');
    expect(dimToString(quantityKindDimension(undefined, 'PressureValue')!)).toBe('L⁻¹·M·T⁻²');
  });

  it('quantityKindDimension resolves against the loaded library (by qualified name and id)', () => {
    const m = libModel();
    expect(dimToString(quantityKindDimension(m, 'ISQ::SpeedValue')!)).toBe('L·T⁻¹');
    const el = resolveQualifiedNameFull(m, 'ISQ::SpeedValue');
    expect(el).toBeTruthy();
    if (el) expect(dimToString(quantityKindDimension(m, el.id)!)).toBe('L·T⁻¹');
  });

  it('unknown quantity kind → undefined', () => {
    expect(quantityKindDimension(undefined, 'NotAQuantity')).toBeUndefined();
  });
});

describe('semantics — units: the reference funnel', () => {
  /** Dimension + SI factor of a spelling, or null when it does not resolve. */
  function facts(ref: string): { dim: string; factor: number } | null {
    const u = resolveUnit(ref);
    return u ? { dim: dimToString(u.dimension), factor: u.factorToSI } : null;
  }

  it.each([
    // Compound units, in every separator the corpus uses.
    ['m/s', 'L·T⁻¹', 1],
    ['W⋅h', 'L²·M·T⁻²', 3600],
    ['W*h', 'L²·M·T⁻²', 3600],
    ['W·h', 'L²·M·T⁻²', 3600],
    ['Wh', 'L²·M·T⁻²', 3600],
    ['kW⋅h', 'L²·M·T⁻²', 3.6e6],
    ['m²', 'L²', 1],
    ['m^2', 'L²', 1],
    ['m/s^2', 'L·T⁻²', 1],
    ['kg*m/s^2', 'L·M·T⁻²', 1],
    ['J/(kg⋅K)', 'L²·T⁻²·Θ⁻¹', 1],
    ['kg⋅m²⋅s⁻³⋅A⁻¹', 'L²·M·T⁻³·I⁻¹', 1],
    // Information units: dimension one, exactly as the bundled library types
    // them — so a bit rate is T⁻¹, indistinguishable from a frequency.
    ['bit', '1', 1],
    ['B', '1', 8],
    ['MiB', '1', 8 * 1024 * 1024],
    ['Mbit/s', 'T⁻¹', 1e6],
    ['Bd', 'T⁻¹', 1],
    ['nat', '1', 1 / Math.LN2],
    ['Hart', '1', Math.log2(10)],
    // Quoted, qualified and worded spellings.
    ["'m/s'", 'L·T⁻¹', 1],
    ['SI::kg', 'M', 1],
    ["SI::'watt hour'", 'L²·M·T⁻²', 3600],
    ["SI::'metre per second'", 'L·T⁻¹', 1],
    ['USCustomaryUnits::pound', 'M', 0.45359237],
    ['metre per second', 'L·T⁻¹', 1],
    ['metre squared', 'L²', 1],
    // A qualifier belongs to ITS ATOM, not to the whole expression: cutting the
    // whole string at its last `::` used to read these as plain `s` / `h`.
    ['SI::m/SI::s', 'L·T⁻¹', 1],
    ['m/SI::s', 'L·T⁻¹', 1],
    ['km/SI::h', 'L·T⁻¹', 1000 / 3600],
    // `1/s` is the ASCII spelling of `s⁻¹`, and the one agents reach for.
    ['1/s', 'T⁻¹', 1],
    ['1/min', 'T⁻¹', 1 / 60],
  ])('resolves %s as %s', (ref, dimension, factor) => {
    const f = facts(ref);
    expect(f, `${ref} should resolve`).not.toBeNull();
    expect(f!.dim).toBe(dimension);
    expect(f!.factor).toBeCloseTo(factor, 9);
  });

  it.each([
    // An affine scale has no meaning as a factor of a product.
    ['°C*m'],
    ['°C⋅K'],
    // One unknown atom fails the whole expression.
    ['furlong/s'],
    // A bare number is never a unit, the identity included — only `1/s`-style
    // reciprocals may name it, and only beside a real unit.
    ['2'],
    ['1'],
    ['1..2'],
    ['2/s'],
    ['*'],
    // The decibel is a LOGARITHMIC ratio, not a registry unit; the information
    // units take the magnifying prefixes only, so `d` + `B` never applies.
    ['dB'],
    ['mB'],
    ['cB'],
    ['do'],
    ['cbit'],
    ['dSh'],
    // The long library names beyond per/squared/cubed are the recorded gap.
    ['kilogram metre squared second to the power minus 3 ampere to the power minus 1'],
  ])('refuses %s', (ref) => {
    expect(resolveUnit(ref)).toBeUndefined();
  });

  it('exact symbols still beat any decomposition (min, Wh, EJ vs EB)', () => {
    expect(resolveUnit('min')!.name).toBe('minute');
    expect(resolveUnit('Wh')!.name).toBe('wattHour');
    // `E` is the erlang, but `EJ` / `EB` still decompose as exa + J / B.
    expect(resolveUnit('E')!.name).toBe('erlang');
    expect(resolveUnit('EJ')!.factorToSI).toBeCloseTo(1e18, 3);
    expect(resolveUnit('EB')!.factorToSI).toBeCloseTo(8e18, 3);
  });

  it('normalizeUnitRef unquotes each qualified segment', () => {
    expect(normalizeUnitRef("SI::'watt hour'")).toBe('SI::watt hour');
    expect(normalizeUnitRef("  'm/s' ")).toBe('m/s');
    expect(normalizeUnitRef('kg')).toBe('kg');
  });

  it('every registry libraryName round-trips through the inverted map', () => {
    const failures: string[] = [];
    for (const u of UNIT_REGISTRY) {
      if (!u.libraryName) continue;
      const back = resolveUnit(u.libraryName);
      if (back?.symbol !== u.symbol) failures.push(`${u.libraryName} → ${back?.symbol ?? 'undefined'}`);
    }
    expect(failures).toEqual([]);
  });

  it('binary prefixes attach to information units only', () => {
    expect(BINARY_PREFIXES).toHaveLength(8);
    // `SI_PREFIXES` stays the 20 decimal ones — the families are separate.
    expect(SI_PREFIXES).toHaveLength(20);
    expect(resolveUnit('KiB')!.factorToSI).toBe(8 * 1024);
    expect(resolveUnit('Kibit')!.factorToSI).toBe(1024);
    expect(resolveUnit('Kim')).toBeUndefined();
    expect(resolveUnit('Kis')).toBeUndefined();
    // Only bit, B and o are binaryPrefixable — the other information rows are
    // not, so the hint must not promise Ki..Yi on them.
    expect(resolveUnit('KiSh')).toBeUndefined();
    expect(resolveUnit('KiBd')).toBeUndefined();
  });

  it('information units take the magnifying decimal prefixes only', () => {
    // Magnifying: the spellings that exist keep working.
    expect(resolveUnit('kB')!.factorToSI).toBe(8e3);
    expect(resolveUnit('Gbit')!.factorToSI).toBe(1e9);
    expect(resolveUnit('kilobyte')!.factorToSI).toBe(8e3);
    // Sub-multiples: refused, so `dB` stays an honest unknown-unit rather than
    // resolving as a deci-byte of factor 0.8 and rescaling a decibel value.
    for (const sub of ['dB', 'mB', 'cB', 'do', 'mo', 'no', 'cbit', 'mbit', 'dbit', 'dnat', 'dBd', 'dHart']) {
      expect(resolveUnit(sub), `${sub} must not resolve`).toBeUndefined();
    }
    // The policy is per-row: sub-multiples of a physical unit are untouched.
    expect(resolveUnit('dm')!.factorToSI).toBeCloseTo(0.1, 12);
    expect(resolveUnit('mg')!.factorToSI).toBeCloseTo(1e-6, 18);
  });
});

describe('semantics — units: ISQ information quantity kinds', () => {
  it('rates are T⁻¹ and contents are dimension one, as the bundle types them', () => {
    expect(dimToString(quantityKindDimension(undefined, 'BinaryDigitRateValue')!)).toBe('T⁻¹');
    expect(dimToString(quantityKindDimension(undefined, 'TransferRateValue')!)).toBe('T⁻¹');
    expect(dimToString(quantityKindDimension(undefined, 'ModulationRateValue')!)).toBe('T⁻¹');
    expect(dimToString(quantityKindDimension(undefined, 'StorageCapacityValue')!)).toBe('1');
    expect(dimToString(quantityKindDimension(undefined, 'InformationContentValue')!)).toBe('1');
    // No unit definition in the bundle — dimensionless by documented choice.
    expect(dimToString(quantityKindDimension(undefined, 'DecisionContentValue')!)).toBe('1');
  });

  it('the ISQInformation alias names resolve with and without the library', () => {
    // `library: 'none'` / curated: the alias is a key in its own right.
    expect(dimToString(quantityKindDimension(undefined, 'ISQ::BitRateValue')!)).toBe('T⁻¹');
    expect(dimToString(quantityKindDimension(undefined, 'StorageSizeValue')!)).toBe('1');
    expect(dimToString(quantityKindDimension(undefined, 'LineDigitRateValue')!)).toBe('T⁻¹');
    // Full bundle: the alias membership is dereferenced first, same answer.
    const m = libModel();
    expect(dimToString(quantityKindDimension(m, 'ISQ::BitRateValue')!)).toBe('T⁻¹');
    expect(dimToString(quantityKindDimension(m, 'ISQ::BinaryDigitRateValue')!)).toBe('T⁻¹');
    expect(dimToString(quantityKindDimension(m, 'ISQ::StorageCapacityValue')!)).toBe('1');
  });
});

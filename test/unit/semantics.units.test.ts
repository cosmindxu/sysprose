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

/**
 * Dimensional analysis + unit-conversion engine.
 *
 * Two independent-but-linked concerns live here:
 *
 *  1. A **dimension model** — a rational vector over the seven SI base
 *     dimensions (length L, mass M, time T, electric current I, thermodynamic
 *     temperature Θ, amount of substance N, luminous intensity J). Every
 *     physical quantity has such a signature; two magnitudes may only be added
 *     or converted between when their dimensions are equal.
 *
 *  2. A **unit registry** — SI base + derived units, the decimal SI prefixes,
 *     and a handful of US-customary units — each carrying its dimension and the
 *     affine map to the coherent SI unit of the same dimension
 *     (`value_SI = magnitude · factorToSI + offsetSI`). Conversion between two
 *     units of equal dimension is the composition of one map with the inverse
 *     of the other.
 *
 * CLEAN-ROOM NOTE: every conversion factor, prefix power and offset below is
 * authored directly from the SI Brochure's *definitions* (exact rational
 * values where the definition is exact — e.g. 1 in ≡ 0.0254 m, 1 lb ≡
 * 0.45359237 kg, 0 °C ≡ 273.15 K). No prose, table or data file from a
 * third-party source was copied; see docs/LICENSES.md.
 *
 * The engine is pure and library-agnostic, but two bridges tie it to the
 * bundled model library: {@link libraryUnitName} maps a registry unit to its
 * `SI::…` / `USCustomaryUnits::…` qualified name, and
 * {@link quantityKindDimension} derives the dimension of an ISQ quantity kind
 * (resolvable against the loaded library).
 */

import type { ElementRecord, Model } from '@core/index';
import { resolveQualifiedNameFull } from './resolve-names';

/* ─────────────────────────────── Dimensions ─────────────────────────────── */

/** A signature over the seven SI base dimensions (rational exponents). */
export interface Dimension {
  /** length */ L: number;
  /** mass */ M: number;
  /** time */ T: number;
  /** electric current */ I: number;
  /** thermodynamic temperature */ Th: number;
  /** amount of substance */ N: number;
  /** luminous intensity */ J: number;
}

/** The dimension of a pure number (all exponents zero). */
export const DIMENSIONLESS: Dimension = { L: 0, M: 0, T: 0, I: 0, Th: 0, N: 0, J: 0 };

/** Build a Dimension from a partial spec, defaulting unspecified axes to 0. */
export function dim(spec: Partial<Dimension>): Dimension {
  return { ...DIMENSIONLESS, ...spec };
}

/** Product of two dimensions (exponents add). */
export function multiplyDim(a: Dimension, b: Dimension): Dimension {
  return {
    L: a.L + b.L,
    M: a.M + b.M,
    T: a.T + b.T,
    I: a.I + b.I,
    Th: a.Th + b.Th,
    N: a.N + b.N,
    J: a.J + b.J,
  };
}

/** Quotient of two dimensions (exponents subtract). */
export function divideDim(a: Dimension, b: Dimension): Dimension {
  return {
    L: a.L - b.L,
    M: a.M - b.M,
    T: a.T - b.T,
    I: a.I - b.I,
    Th: a.Th - b.Th,
    N: a.N - b.N,
    J: a.J - b.J,
  };
}

/** A dimension raised to a (rational) power (exponents scale). */
export function powDim(a: Dimension, exp: number): Dimension {
  return {
    L: a.L * exp,
    M: a.M * exp,
    T: a.T * exp,
    I: a.I * exp,
    Th: a.Th * exp,
    N: a.N * exp,
    J: a.J * exp,
  };
}

/** Structural equality of two dimensions. */
export function dimEqual(a: Dimension, b: Dimension): boolean {
  return (
    a.L === b.L &&
    a.M === b.M &&
    a.T === b.T &&
    a.I === b.I &&
    a.Th === b.Th &&
    a.N === b.N &&
    a.J === b.J
  );
}

/** Display symbol for each base-dimension axis, in canonical print order. */
const DIM_AXES: ReadonlyArray<readonly [keyof Dimension, string]> = [
  ['L', 'L'],
  ['M', 'M'],
  ['T', 'T'],
  ['I', 'I'],
  ['Th', 'Θ'],
  ['N', 'N'],
  ['J', 'J'],
];

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '-': '⁻',
  '.': '·',
};

/** Render an exponent as Unicode superscript (e.g. -2 → '⁻²'). */
function superscript(exp: number): string {
  return String(exp)
    .split('')
    .map((c) => SUPERSCRIPT[c] ?? c)
    .join('');
}

/**
 * Human-readable dimension string, e.g. `L·T⁻¹` for speed, `L·M·T⁻²` for force,
 * or `1` for a dimensionless quantity. Axes are printed in the canonical order
 * L, M, T, I, Θ, N, J; the exponent `1` is elided.
 */
export function dimToString(d: Dimension): string {
  const parts: string[] = [];
  for (const [axis, sym] of DIM_AXES) {
    const e = d[axis];
    if (e === 0) continue;
    parts.push(e === 1 ? sym : `${sym}${superscript(e)}`);
  }
  return parts.length === 0 ? '1' : parts.join('·');
}

/* ─────────────────────────────── Unit model ─────────────────────────────── */

/**
 * A unit of measure: its dimension plus the affine map to the coherent SI unit
 * of that dimension — `value_SI = magnitude · factorToSI + (offsetSI ?? 0)`.
 * `offsetSI` is only non-zero for non-absolute temperature scales (°C, °F).
 */
export interface Unit {
  name: string;
  symbol: string;
  dimension: Dimension;
  /** Multiplier taking a magnitude in this unit to the coherent SI unit. */
  factorToSI: number;
  /** Additive offset (SI units) for affine scales; omitted ⇒ 0. */
  offsetSI?: number;
  /** Qualified name of the corresponding bundled-library unit, if any. */
  libraryName?: string;
  /** Whether an SI prefix may be attached (false for US units, °C, °F, …). */
  prefixable?: boolean;
}

/** An SI decimal prefix: a name, symbol and power-of-ten multiplier. */
export interface Prefix {
  name: string;
  symbol: string;
  factor: number;
}

/* Base dimensions as reusable constants. */
const D_LENGTH = dim({ L: 1 });
const D_MASS = dim({ M: 1 });
const D_TIME = dim({ T: 1 });
const D_CURRENT = dim({ I: 1 });
const D_TEMP = dim({ Th: 1 });
const D_AMOUNT = dim({ N: 1 });
const D_LUMINOUS = dim({ J: 1 });

/**
 * The decimal SI prefixes, yotta (10²⁴) down to yocto (10⁻²⁴).
 * Powers of ten are authored directly from the SI prefix definitions.
 */
export const SI_PREFIXES: Prefix[] = [
  { name: 'yotta', symbol: 'Y', factor: 1e24 },
  { name: 'zetta', symbol: 'Z', factor: 1e21 },
  { name: 'exa', symbol: 'E', factor: 1e18 },
  { name: 'peta', symbol: 'P', factor: 1e15 },
  { name: 'tera', symbol: 'T', factor: 1e12 },
  { name: 'giga', symbol: 'G', factor: 1e9 },
  { name: 'mega', symbol: 'M', factor: 1e6 },
  { name: 'kilo', symbol: 'k', factor: 1e3 },
  { name: 'hecto', symbol: 'h', factor: 1e2 },
  { name: 'deca', symbol: 'da', factor: 1e1 },
  { name: 'deci', symbol: 'd', factor: 1e-1 },
  { name: 'centi', symbol: 'c', factor: 1e-2 },
  { name: 'milli', symbol: 'm', factor: 1e-3 },
  { name: 'micro', symbol: 'µ', factor: 1e-6 },
  { name: 'nano', symbol: 'n', factor: 1e-9 },
  { name: 'pico', symbol: 'p', factor: 1e-12 },
  { name: 'femto', symbol: 'f', factor: 1e-15 },
  { name: 'atto', symbol: 'a', factor: 1e-18 },
  { name: 'zepto', symbol: 'z', factor: 1e-21 },
  { name: 'yocto', symbol: 'y', factor: 1e-24 },
];

/** Prefix factor by name (e.g. `prefixFactor('kilo') === 1e3`), or undefined. */
export function prefixFactor(name: string): number | undefined {
  return SI_PREFIXES.find((p) => p.name === name)?.factor;
}

/*
 * The unit registry. Factors/offsets are exact SI definitions:
 *   - base units are coherent (factor 1);
 *   - derived units are products of base units (factor 1) except the litre
 *     (10⁻³ m³) and the mass units gram/tonne;
 *   - °C shares kelvin's scale with a +273.15 offset;
 *   - US-customary lengths/masses use their exact defined equivalents, and °F
 *     is the affine map K = °F·(5/9) + (273.15 − 32·5/9).
 */
const REGISTRY: Unit[] = [
  // ── SI base units ──────────────────────────────────────────────────────
  { name: 'metre', symbol: 'm', dimension: D_LENGTH, factorToSI: 1, libraryName: 'SI::metre', prefixable: true },
  { name: 'kilogram', symbol: 'kg', dimension: D_MASS, factorToSI: 1, libraryName: 'SI::kilogram' },
  { name: 'second', symbol: 's', dimension: D_TIME, factorToSI: 1, libraryName: 'SI::second', prefixable: true },
  { name: 'ampere', symbol: 'A', dimension: D_CURRENT, factorToSI: 1, libraryName: 'SI::ampere', prefixable: true },
  { name: 'kelvin', symbol: 'K', dimension: D_TEMP, factorToSI: 1, libraryName: 'SI::kelvin', prefixable: true },
  { name: 'mole', symbol: 'mol', dimension: D_AMOUNT, factorToSI: 1, libraryName: 'SI::mole', prefixable: true },
  { name: 'candela', symbol: 'cd', dimension: D_LUMINOUS, factorToSI: 1, libraryName: 'SI::candela', prefixable: true },

  // ── SI coherent derived units ──────────────────────────────────────────
  { name: 'hertz', symbol: 'Hz', dimension: dim({ T: -1 }), factorToSI: 1, libraryName: 'SI::hertz', prefixable: true },
  { name: 'newton', symbol: 'N', dimension: dim({ L: 1, M: 1, T: -2 }), factorToSI: 1, libraryName: 'SI::newton', prefixable: true },
  { name: 'pascal', symbol: 'Pa', dimension: dim({ L: -1, M: 1, T: -2 }), factorToSI: 1, libraryName: 'SI::pascal', prefixable: true },
  { name: 'joule', symbol: 'J', dimension: dim({ L: 2, M: 1, T: -2 }), factorToSI: 1, libraryName: 'SI::joule', prefixable: true },
  { name: 'watt', symbol: 'W', dimension: dim({ L: 2, M: 1, T: -3 }), factorToSI: 1, libraryName: 'SI::watt', prefixable: true },
  { name: 'coulomb', symbol: 'C', dimension: dim({ T: 1, I: 1 }), factorToSI: 1, libraryName: 'SI::coulomb', prefixable: true },
  { name: 'volt', symbol: 'V', dimension: dim({ L: 2, M: 1, T: -3, I: -1 }), factorToSI: 1, libraryName: 'SI::volt', prefixable: true },
  { name: 'ohm', symbol: 'Ω', dimension: dim({ L: 2, M: 1, T: -3, I: -2 }), factorToSI: 1, libraryName: 'SI::ohm', prefixable: true },
  { name: 'farad', symbol: 'F', dimension: dim({ L: -2, M: -1, T: 4, I: 2 }), factorToSI: 1, libraryName: 'SI::farad', prefixable: true },
  { name: 'siemens', symbol: 'S', dimension: dim({ L: -2, M: -1, T: 3, I: 2 }), factorToSI: 1, libraryName: 'SI::siemens', prefixable: true },
  { name: 'weber', symbol: 'Wb', dimension: dim({ L: 2, M: 1, T: -2, I: -1 }), factorToSI: 1, libraryName: 'SI::weber', prefixable: true },
  { name: 'tesla', symbol: 'T', dimension: dim({ M: 1, T: -2, I: -1 }), factorToSI: 1, libraryName: 'SI::tesla', prefixable: true },
  { name: 'henry', symbol: 'H', dimension: dim({ L: 2, M: 1, T: -2, I: -2 }), factorToSI: 1, libraryName: 'SI::henry', prefixable: true },
  // Non-coherent but ubiquitous engineering units. Prefixable, so kWh / MWh and
  // mAh come for free from the generic single-prefix decomposition.
  { name: 'wattHour', symbol: 'Wh', dimension: dim({ L: 2, M: 1, T: -2 }), factorToSI: 3600, libraryName: 'SI::watt hour', prefixable: true },
  { name: 'ampereHour', symbol: 'Ah', dimension: dim({ T: 1, I: 1 }), factorToSI: 3600, prefixable: true },
  {
    name: 'degreeCelsius',
    symbol: '°C',
    dimension: D_TEMP,
    factorToSI: 1,
    offsetSI: 273.15,
    libraryName: 'SI::degree celsius (absolute temperature scale)',
  },

  // ── Other accepted metric units ────────────────────────────────────────
  { name: 'gram', symbol: 'g', dimension: D_MASS, factorToSI: 1e-3, libraryName: 'SI::gram', prefixable: true },
  { name: 'tonne', symbol: 't', dimension: D_MASS, factorToSI: 1e3, libraryName: 'SI::tonne' },
  // 1 litre ≡ 1 dm³ = 10⁻³ m³.
  { name: 'litre', symbol: 'L', dimension: dim({ L: 3 }), factorToSI: 1e-3, libraryName: 'SI::litre', prefixable: true },
  { name: 'minute', symbol: 'min', dimension: D_TIME, factorToSI: 60, libraryName: 'SI::minute' },
  { name: 'hour', symbol: 'h', dimension: D_TIME, factorToSI: 3600, libraryName: 'SI::hour' },
  { name: 'day', symbol: 'd', dimension: D_TIME, factorToSI: 86400, libraryName: 'SI::day' },

  // ── US-customary units (exact defined equivalents) ─────────────────────
  { name: 'inch', symbol: 'in', dimension: D_LENGTH, factorToSI: 0.0254, libraryName: 'USCustomaryUnits::inch' },
  { name: 'foot', symbol: 'ft', dimension: D_LENGTH, factorToSI: 0.3048, libraryName: 'USCustomaryUnits::foot' },
  { name: 'yard', symbol: 'yd', dimension: D_LENGTH, factorToSI: 0.9144, libraryName: 'USCustomaryUnits::yard' },
  { name: 'mile', symbol: 'mi', dimension: D_LENGTH, factorToSI: 1609.344, libraryName: 'USCustomaryUnits::mile' },
  { name: 'poundMass', symbol: 'lb', dimension: D_MASS, factorToSI: 0.45359237, libraryName: 'USCustomaryUnits::pound' },
  // 1 oz ≡ 1/16 lb.
  { name: 'ounce', symbol: 'oz', dimension: D_MASS, factorToSI: 0.45359237 / 16, libraryName: 'USCustomaryUnits::ounce' },
  // US liquid gallon ≡ 231 in³ = 231 · 0.0254³ m³.
  { name: 'gallon', symbol: 'gal', dimension: dim({ L: 3 }), factorToSI: 231 * 0.0254 ** 3, libraryName: 'USCustomaryUnits::gallon' },
  {
    name: 'fahrenheit',
    symbol: '°F',
    dimension: D_TEMP,
    factorToSI: 5 / 9,
    offsetSI: 273.15 - 32 * (5 / 9),
    libraryName: 'USCustomaryUnits::degree fahrenheit (absolute temperature scale)',
  },
];

/** The immutable unit registry (SI base + derived, metric, US-customary). */
export const UNIT_REGISTRY: ReadonlyArray<Unit> = REGISTRY;

const BY_NAME = new Map<string, Unit>(REGISTRY.map((u) => [u.name, u]));
const BY_SYMBOL = new Map<string, Unit>(REGISTRY.map((u) => [u.symbol, u]));
// Longest prefix symbols first so 'da' beats 'd' when both could apply.
const PREFIXES_BY_SYMBOL_LEN = [...SI_PREFIXES].sort((a, b) => b.symbol.length - a.symbol.length);

/** Synthesise a prefixed unit (e.g. kilo + metre → kilometre / km). */
function applyPrefix(prefix: Prefix, base: Unit): Unit {
  return {
    name: `${prefix.name}${base.name}`,
    symbol: `${prefix.symbol}${base.symbol}`,
    dimension: base.dimension,
    factorToSI: base.factorToSI * prefix.factor,
    // A prefixed unit never carries an offset (prefixing °C is meaningless).
    prefixable: false,
  };
}

/**
 * Look up a unit by its (long) name, transparently resolving a prefixed name
 * such as `kilometre` = kilo + metre. Returns `undefined` when unknown.
 */
export function unitByName(name: string): Unit | undefined {
  const key = name.trim();
  const exact = BY_NAME.get(key);
  if (exact) return exact;
  for (const p of SI_PREFIXES) {
    if (!key.startsWith(p.name)) continue;
    const base = BY_NAME.get(key.slice(p.name.length));
    if (base?.prefixable) return applyPrefix(p, base);
  }
  return undefined;
}

/**
 * Look up a unit by its symbol, transparently resolving a prefixed symbol such
 * as `km` = k + m or `ms` = m + s. Exact symbols (`min`, `mol`, `°C`) win over
 * any prefix decomposition. Returns `undefined` when unknown.
 */
export function unitBySymbol(sym: string): Unit | undefined {
  const key = sym.trim();
  const exact = BY_SYMBOL.get(key);
  if (exact) return exact;
  for (const p of PREFIXES_BY_SYMBOL_LEN) {
    if (!key.startsWith(p.symbol)) continue;
    const base = BY_SYMBOL.get(key.slice(p.symbol.length));
    if (base?.prefixable) return applyPrefix(p, base);
  }
  return undefined;
}

/** Resolve a unit reference — a {@link Unit}, a long name, or a symbol. */
function resolveUnit(u: Unit | string): Unit | undefined {
  if (typeof u !== 'string') return u;
  return unitByName(u) ?? unitBySymbol(u);
}

/** The dimension of a unit named `name` (long name or symbol), or undefined. */
export function dimensionOf(name: string): Dimension | undefined {
  return resolveUnit(name)?.dimension;
}

/** True when two unit references share the same dimension. */
export function areCompatible(a: Unit | string, b: Unit | string): boolean {
  const ua = resolveUnit(a);
  const ub = resolveUnit(b);
  return !!ua && !!ub && dimEqual(ua.dimension, ub.dimension);
}

/**
 * Convert `magnitude` from `fromUnit` to `toUnit` (each a {@link Unit}, long
 * name or symbol). Applies the affine SI maps, so temperature scales with an
 * offset (°C, °F) round-trip correctly. Throws when either unit is unknown or
 * their dimensions differ.
 */
export function convert(magnitude: number, fromUnit: Unit | string, toUnit: Unit | string): number {
  const from = resolveUnit(fromUnit);
  const to = resolveUnit(toUnit);
  if (!from) throw new Error(`Unknown source unit: ${String(fromUnit)}`);
  if (!to) throw new Error(`Unknown target unit: ${String(toUnit)}`);
  if (!dimEqual(from.dimension, to.dimension)) {
    throw new Error(
      `Incompatible dimensions: ${from.name} (${dimToString(from.dimension)}) → ` +
        `${to.name} (${dimToString(to.dimension)})`,
    );
  }
  const valueSI = magnitude * from.factorToSI + (from.offsetSI ?? 0);
  return (valueSI - (to.offsetSI ?? 0)) / to.factorToSI;
}

/**
 * Qualified name of the bundled-library unit corresponding to a registry unit
 * (e.g. `metre` → `SI::metre`). Accepts a {@link Unit} or a unit name/symbol.
 * Returns `undefined` when the unit has no mapped library counterpart.
 */
export function libraryUnitName(unit: Unit | string): string | undefined {
  return resolveUnit(unit)?.libraryName;
}

/* ───────────────────────── Quantity-kind dimensions ─────────────────────── */

/**
 * Documented dimension table for the ISQ quantity kinds — each derived from
 * first principles (e.g. speed = length/time ⇒ L·T⁻¹; force = mass·acceleration
 * ⇒ L·M·T⁻²; pressure = force/area ⇒ L⁻¹·M·T⁻²). Keyed by the ISQ `…Value`
 * attribute-definition names used in the bundled library, so a name resolved
 * against the library maps straight through.
 */
const QUANTITY_DIMENSIONS: Record<string, Dimension> = {
  // A pure number (fractions, ratios, counts).
  DimensionOneValue: DIMENSIONLESS,

  // Base quantities.
  LengthValue: D_LENGTH,
  MassValue: D_MASS,
  TimeValue: D_TIME,
  DurationValue: D_TIME,
  ElectricCurrentValue: D_CURRENT,
  ThermodynamicTemperatureValue: D_TEMP,
  TemperatureValue: D_TEMP,
  AmountOfSubstanceValue: D_AMOUNT,
  LuminousIntensityValue: D_LUMINOUS,

  // Geometric / kinematic.
  AreaValue: dim({ L: 2 }),
  VolumeValue: dim({ L: 3 }),
  SpeedValue: dim({ L: 1, T: -1 }),
  VelocityValue: dim({ L: 1, T: -1 }),
  AccelerationValue: dim({ L: 1, T: -2 }),
  FrequencyValue: dim({ T: -1 }),
  AngularVelocityValue: dim({ T: -1 }),

  // Mechanical / thermodynamic.
  ForceValue: dim({ L: 1, M: 1, T: -2 }),
  MomentumValue: dim({ L: 1, M: 1, T: -1 }),
  EnergyValue: dim({ L: 2, M: 1, T: -2 }),
  WorkValue: dim({ L: 2, M: 1, T: -2 }),
  TorqueValue: dim({ L: 2, M: 1, T: -2 }),
  MomentOfForceValue: dim({ L: 2, M: 1, T: -2 }),
  PowerValue: dim({ L: 2, M: 1, T: -3 }),
  PressureValue: dim({ L: -1, M: 1, T: -2 }),
  StressValue: dim({ L: -1, M: 1, T: -2 }),
  MassDensityValue: dim({ L: -3, M: 1 }),

  // Electromagnetic.
  ElectricChargeValue: dim({ T: 1, I: 1 }),
  ElectricPotentialValue: dim({ L: 2, M: 1, T: -3, I: -1 }),
  VoltageValue: dim({ L: 2, M: 1, T: -3, I: -1 }),
  ElectricResistanceValue: dim({ L: 2, M: 1, T: -3, I: -2 }),
  CapacitanceValue: dim({ L: -2, M: -1, T: 4, I: 2 }),
};

/**
 * Derive the {@link Dimension} of an ISQ quantity kind.
 *
 * Accepts either the quantity name directly (e.g. `'SpeedValue'`, or an ISQ
 * qualified name such as `'ISQ::SpeedValue'`) or the element id of a quantity
 * definition in `model`; when an id resolves, its declared name drives the
 * lookup. When `model` is provided, an unqualified name is confirmed against
 * the loaded library (its resolved declared name is used), but the dimension
 * always comes from the documented table above. Returns `undefined` for an
 * unknown quantity.
 */
export function quantityKindDimension(
  model: Model | undefined,
  quantityElementIdOrName: string,
): Dimension | undefined {
  let key = quantityElementIdOrName.trim();

  if (model) {
    // An element id present in the model → use its declared name.
    const byId = model.get(key);
    let el: ElementRecord | undefined = byId;
    // Otherwise try to resolve the (possibly qualified) name in the library.
    if (!el) el = resolveQualifiedNameFull(model, key);
    if (el?.declaredName) key = el.declaredName;
  }

  // Reduce a qualified name to its last segment for the table lookup.
  const last = key.split('::').pop()?.trim() ?? key;
  return QUANTITY_DIMENSIONS[last] ?? QUANTITY_DIMENSIONS[key];
}

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
 *     the ISO 80000-13 information units with the binary prefixes, and a
 *     handful of US-customary units — each carrying its dimension and the
 *     affine map to the coherent SI unit of the same dimension
 *     (`value_SI = magnitude · factorToSI + offsetSI`). Conversion between two
 *     units of equal dimension is the composition of one map with the inverse
 *     of the other.
 *
 *  3. A **reference funnel** — {@link resolveUnit}, the single model-free entry
 *     point every unit string in the tool goes through, which accepts a symbol,
 *     a long name, a qualified or quoted library reference, a worded compound
 *     and a unit expression alike.
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
  /**
   * Whether a BINARY prefix (Ki, Mi, …) may be attached. Only the information
   * units bit, byte and octet take one — `KiB` is 1024 B, but there is no
   * `Kim` — so the two prefix families are kept apart rather than merged.
   */
  binaryPrefixable?: boolean;
  /**
   * Whether only the MAGNIFYING decimal prefixes (factor > 1) may attach.
   * ISO 80000-13 pairs the information units with the magnifying prefixes
   * only, and the sub-multiples are worse than useless here: a "millibit" is
   * meaningless, and `d` + `B` would swallow `dB` — the decibel, a
   * LOGARITHMIC ratio that is not a registry unit at all — reporting 20 dB as
   * 16 byte-equivalents instead of the honest `unknown-unit`.
   */
  magnifyingPrefixesOnly?: boolean;
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

/**
 * The binary (IEC 80000-13) prefixes, kibi (2¹⁰) up to yobi (2⁸⁰). They are a
 * SEPARATE family from {@link SI_PREFIXES} — decimal `k` on a byte means 1000,
 * binary `Ki` means 1024 — and attach only to a {@link Unit.binaryPrefixable}
 * row, so `MiB` is a mebibyte while `Mim` is nothing.
 */
export const BINARY_PREFIXES: Prefix[] = [
  { name: 'kibi', symbol: 'Ki', factor: 2 ** 10 },
  { name: 'mebi', symbol: 'Mi', factor: 2 ** 20 },
  { name: 'gibi', symbol: 'Gi', factor: 2 ** 30 },
  { name: 'tebi', symbol: 'Ti', factor: 2 ** 40 },
  { name: 'pebi', symbol: 'Pi', factor: 2 ** 50 },
  { name: 'exbi', symbol: 'Ei', factor: 2 ** 60 },
  { name: 'zebi', symbol: 'Zi', factor: 2 ** 70 },
  { name: 'yobi', symbol: 'Yi', factor: 2 ** 80 },
];

/** Prefix factor by name (e.g. `prefixFactor('kilo') === 1e3`), or undefined. */
export function prefixFactor(name: string): number | undefined {
  return (
    SI_PREFIXES.find((p) => p.name === name)?.factor ??
    BINARY_PREFIXES.find((p) => p.name === name)?.factor
  );
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

  // ── Information units (ISO 80000-13) ───────────────────────────────────
  // The bundled OMG library types StorageCapacityUnit and InformationContentUnit
  // as subclasses of MeasurementReferences::DimensionOneUnit, and the rate units
  // (BinaryDigitRateUnit, TransferRateUnit, …) as DerivedUnit with a duration
  // power factor. Information is therefore DIMENSION ONE here, exactly as the
  // standard has it — `bit/s` and `Hz` are the same dimension (T⁻¹), which is
  // the visible cost of being faithful rather than inventing an eighth axis.
  // Factors are authored from the ISO 80000-13 definitions with the shannon
  // (= one binary digit) as the reference: 1 B ≡ 8 bit, 1 Hart ≡ log₂10 Sh,
  // 1 nat ≡ 1/ln2 Sh.
  // Only the MAGNIFYING prefixes attach (magnifyingPrefixesOnly): kbit/MB/Gbit
  // are the spellings that exist, while `d` + `B` would capture the DECIBEL —
  // a logarithmic ratio, not a linear registry unit — and silently rescale it.
  { name: 'bit', symbol: 'bit', dimension: DIMENSIONLESS, factorToSI: 1, libraryName: 'SI::bit', prefixable: true, magnifyingPrefixesOnly: true, binaryPrefixable: true },
  { name: 'byte', symbol: 'B', dimension: DIMENSIONLESS, factorToSI: 8, libraryName: 'SI::byte', prefixable: true, magnifyingPrefixesOnly: true, binaryPrefixable: true },
  { name: 'octet', symbol: 'o', dimension: DIMENSIONLESS, factorToSI: 8, libraryName: 'SI::octet', prefixable: true, magnifyingPrefixesOnly: true, binaryPrefixable: true },
  { name: 'shannon', symbol: 'Sh', dimension: DIMENSIONLESS, factorToSI: 1, libraryName: 'SI::shannon', prefixable: true, magnifyingPrefixesOnly: true },
  { name: 'hartley', symbol: 'Hart', dimension: DIMENSIONLESS, factorToSI: Math.log2(10), libraryName: 'SI::hartley', prefixable: true, magnifyingPrefixesOnly: true },
  { name: 'nat', symbol: 'nat', dimension: DIMENSIONLESS, factorToSI: 1 / Math.LN2, libraryName: 'SI::natural unit of information', prefixable: true, magnifyingPrefixesOnly: true },
  // A signalling rate: one symbol (line digit) per second.
  { name: 'baud', symbol: 'Bd', dimension: dim({ T: -1 }), factorToSI: 1, libraryName: 'SI::baud', prefixable: true, magnifyingPrefixesOnly: true },
  // Traffic intensity — a dimensionless occupancy, one call-hour per hour.
  { name: 'erlang', symbol: 'E', dimension: DIMENSIONLESS, factorToSI: 1, libraryName: 'SI::erlang' },

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

/**
 * Whether one DECIMAL prefix may attach to one base unit. Everything takes the
 * magnifying prefixes; a {@link Unit.magnifyingPrefixesOnly} row refuses the
 * sub-multiples, which is what keeps `dB` (the decibel — logarithmic, and not a
 * registry unit) from resolving as a deci-byte of factor 0.8.
 */
function prefixAllowed(prefix: Prefix, base: Unit): boolean {
  return !base.magnifyingPrefixesOnly || prefix.factor > 1;
}

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
  for (const p of BINARY_PREFIXES) {
    if (!key.startsWith(p.name)) continue;
    const base = BY_NAME.get(key.slice(p.name.length));
    if (base?.binaryPrefixable) return applyPrefix(p, base);
  }
  for (const p of SI_PREFIXES) {
    if (!key.startsWith(p.name)) continue;
    const base = BY_NAME.get(key.slice(p.name.length));
    if (base?.prefixable && prefixAllowed(p, base)) return applyPrefix(p, base);
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
  // Binary prefixes first: `Mi` would otherwise be eaten as `M` + `i…`.
  for (const p of BINARY_PREFIXES) {
    if (!key.startsWith(p.symbol)) continue;
    const base = BY_SYMBOL.get(key.slice(p.symbol.length));
    if (base?.binaryPrefixable) return applyPrefix(p, base);
  }
  for (const p of PREFIXES_BY_SYMBOL_LEN) {
    if (!key.startsWith(p.symbol)) continue;
    const base = BY_SYMBOL.get(key.slice(p.symbol.length));
    if (base?.prefixable && prefixAllowed(p, base)) return applyPrefix(p, base);
  }
  return undefined;
}

/* ──────────────────── The unit-reference funnel ─────────────────────────── */

/*
 * Every unit string in the tool — a value's `attrs.unit`, a `[unit]` literal in
 * a constraint body, an FMI `unit=` attribute, an SDK call — arrives here, and
 * it arrives in whatever spelling its author used: a symbol (`kg`), a long name
 * (`kilogram`), a qualified library reference (`SI::kg`), a quoted one
 * (`SI::'watt hour'`, the only spelling the SysML grammar accepts for a name
 * with a space), a worded compound (`metre per second`) or a unit expression
 * (`kg*m/s^2`, `kg⋅m²⋅s⁻³⋅A⁻¹`).
 *
 * The funnel is deliberately MODEL-FREE. A library-backed fallback was
 * considered and rejected: the library's short-name index is first-writer-wins
 * across every element, so `h` resolves to a `height` feature and `J`/`N`/`T`/`L`
 * to ISQ quantity letters — a post-hoc filter can only turn a wrong hit into
 * `undefined`, never recover the masked unit. Resolving from the registry alone
 * gives the SAME answer under the full bundle, the curated fallback and
 * `library: 'none'`. The cost is honest and recorded: a long library name beyond
 * per/squared/cubed (`kilogram metre squared second to the power minus 3 ampere
 * to the power minus 1`) does not resolve, and the hint teaches the symbol form.
 */

/** Registry units keyed by their bundled-library qualified name. */
const BY_LIBRARY_NAME = new Map<string, Unit>(
  REGISTRY.filter((u) => u.libraryName !== undefined).map((u) => [u.libraryName as string, u]),
);

/** Strip one layer of single quotes from one qualified-name segment. */
function unquoteSegment(seg: string): string {
  const s = seg.trim();
  return s.length >= 2 && s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).trim() : s;
}

/**
 * Canonical spelling of a unit reference: trimmed, with each `::` segment
 * unquoted. `SI::'watt hour'` → `SI::watt hour`, `'m/s'` → `m/s`.
 */
export function normalizeUnitRef(ref: string): string {
  return ref.trim().split('::').map(unquoteSegment).join('::');
}

/**
 * Resolve ONE unit NAME: the whole of it through the inverted library-name map
 * (`SI::watt hour` → Wh), else its last `::` segment through the registry with
 * one prefix (`SI::kg` → kg), which is how the training corpus writes units.
 *
 * This is deliberately per-NAME rather than per-string, because it is also the
 * atom lookup inside a unit expression. A qualifier belongs to the atom it
 * prefixes: cutting the whole string at its LAST `::` would read `m/SI::s` and
 * `km/SI::h` as plain `s` and `h` — a silent wrong dimension for a spelling the
 * tool's own hints invite by showing `[SI::kg]` beside `[m/s]`.
 */
function atomUnit(atom: string): Unit | undefined {
  const key = atom.trim();
  if (key === '') return undefined;
  const byLibrary = BY_LIBRARY_NAME.get(key);
  if (byLibrary) return byLibrary;
  const cut = key.lastIndexOf('::');
  const local = cut < 0 ? key : key.slice(cut + 2).trim();
  if (local === '') return undefined;
  return unitByName(local) ?? unitBySymbol(local);
}

/** Words the library uses where a unit expression would use an operator. */
const WORD_OPERATORS: Record<string, string> = {
  per: '/',
  squared: '^2',
  cubed: '^3',
};

/**
 * Rewrite a spelled-out unit name as a unit expression: `metre per second` →
 * `metre/second`, `watt hour` → `watt*hour`, `metre squared` → `metre^2`.
 * Adjacent words are a product, as they are in the library's own long names.
 */
function wordFormExpr(src: string): string {
  const words = src.split(/\s+/).filter((w) => w !== '');
  if (words.length < 2) return src;
  const out: string[] = [];
  let afterAtom = false;
  for (const w of words) {
    const op = WORD_OPERATORS[w];
    if (op !== undefined) {
      out.push(op);
      // `squared`/`cubed` bind to the atom before them, so a following word is
      // still a product (`metre squared second` → `metre^2*second`).
      afterAtom = op.startsWith('^');
      continue;
    }
    if (afterAtom) out.push('*');
    out.push(w);
    afterAtom = true;
  }
  return out.join('');
}

/* ── The unit-expression parser (`kg*m/s^2`, `J/(kg⋅K)`, `m²`) ── */

type UTok =
  | { t: 'atom'; v: string }
  | { t: 'op'; v: '*' | '/' }
  | { t: 'caret' }
  | { t: 'int'; v: number }
  | { t: 'sup'; v: number }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'eof' };

/** Unicode superscript digits (and the superscript minus) → their ASCII value. */
const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁻': '-',
};

/** Characters that end an atom: the operators, grouping, digits and space. */
function isUnitAtomChar(c: string): boolean {
  if (c === undefined) return false;
  if (c === '*' || c === '⋅' || c === '·' || c === '/' || c === '^') return false;
  if (c === '(' || c === ')' || c === '-' || c === '+') return false;
  if (c >= '0' && c <= '9') return false;
  if (SUPERSCRIPT_DIGITS[c] !== undefined) return false;
  return c.trim() !== '';
}

function lexUnit(src: string): UTok[] {
  const toks: UTok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c.trim() === '') {
      i++;
      continue;
    }
    // U+22C5 DOT OPERATOR is the library's product separator; U+00B7 MIDDLE DOT
    // and ASCII `*` are the spellings agents reach for.
    if (c === '*' || c === '⋅' || c === '·') {
      toks.push({ t: 'op', v: '*' });
      i++;
      continue;
    }
    if (c === '/') {
      toks.push({ t: 'op', v: '/' });
      i++;
      continue;
    }
    if (c === '^') {
      toks.push({ t: 'caret' });
      i++;
      continue;
    }
    if (c === '(') {
      toks.push({ t: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ t: 'rparen' });
      i++;
      continue;
    }
    if (SUPERSCRIPT_DIGITS[c] !== undefined) {
      let j = i;
      let digits = '';
      while (j < src.length && SUPERSCRIPT_DIGITS[src[j]] !== undefined) {
        digits += SUPERSCRIPT_DIGITS[src[j]];
        j++;
      }
      const n = Number(digits);
      if (!Number.isInteger(n)) throw new SyntaxError(`Bad superscript exponent '${digits}'`);
      toks.push({ t: 'sup', v: n });
      i = j;
      continue;
    }
    if ((c >= '0' && c <= '9') || ((c === '-' || c === '+') && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = c === '-' || c === '+' ? i + 1 : i;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
      toks.push({ t: 'int', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (isUnitAtomChar(c)) {
      let j = i;
      while (j < src.length && isUnitAtomChar(src[j])) j++;
      toks.push({ t: 'atom', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new SyntaxError(`Unexpected character '${c}' in a unit`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

/** A parsed unit expression: its dimension and its multiplier to coherent SI. */
interface UnitValue {
  dimension: Dimension;
  factorToSI: number;
}

/** Precedence-climbing parser, in the shape of the constraint parser next door. */
class UnitParser {
  private pos = 0;
  /** Whether any atom resolved — an expression of pure numbers is not a unit. */
  private sawUnit = false;
  constructor(private readonly toks: UTok[]) {}

  private peek(): UTok {
    return this.toks[this.pos];
  }

  parse(): UnitValue {
    const v = this.parseProduct();
    if (this.peek().t !== 'eof') throw new SyntaxError('Trailing tokens in a unit');
    if (!this.sawUnit) throw new SyntaxError('A bare number is not a unit');
    return v;
  }

  private parseProduct(): UnitValue {
    let left = this.parsePower();
    for (;;) {
      const tk = this.peek();
      if (tk.t !== 'op') break;
      this.pos++;
      const right = this.parsePower();
      left =
        tk.v === '*'
          ? {
              dimension: multiplyDim(left.dimension, right.dimension),
              factorToSI: left.factorToSI * right.factorToSI,
            }
          : {
              dimension: divideDim(left.dimension, right.dimension),
              factorToSI: left.factorToSI / right.factorToSI,
            };
    }
    return left;
  }

  private parsePower(): UnitValue {
    let base = this.parsePrimary();
    for (;;) {
      const tk = this.peek();
      if (tk.t === 'sup') {
        this.pos++;
        base = { dimension: powDim(base.dimension, tk.v), factorToSI: base.factorToSI ** tk.v };
        continue;
      }
      if (tk.t === 'caret') {
        this.pos++;
        const e = this.peek();
        if (e.t !== 'int') throw new SyntaxError('A unit exponent must be an integer');
        this.pos++;
        base = { dimension: powDim(base.dimension, e.v), factorToSI: base.factorToSI ** e.v };
        continue;
      }
      break;
    }
    return base;
  }

  private parsePrimary(): UnitValue {
    const tk = this.peek();
    if (tk.t === 'lparen') {
      this.pos++;
      const inner = this.parseProduct();
      if (this.peek().t !== 'rparen') throw new SyntaxError('Expected ) in a unit');
      this.pos++;
      return inner;
    }
    if (tk.t === 'int') {
      // `1/s` is the ASCII spelling of `s⁻¹` and the commonest one agents
      // write, so the IDENTITY is the one number a unit expression may hold.
      // Any other number is refused, and `parse` refuses an expression that
      // named no unit at all, so `[2]` and `[1]` stay unknown units.
      if (tk.v !== 1) throw new SyntaxError('A bare number is not a unit');
      this.pos++;
      return { dimension: DIMENSIONLESS, factorToSI: 1 };
    }
    if (tk.t !== 'atom') {
      throw new SyntaxError('Expected a unit symbol');
    }
    this.pos++;
    const u = atomUnit(tk.v);
    if (!u) throw new SyntaxError(`Unknown unit '${tk.v}'`);
    this.sawUnit = true;
    // An affine scale has no meaning as a factor of a product: `°C⋅m` would
    // need an origin, so the whole expression is refused rather than silently
    // read as if °C were kelvin.
    if (u.offsetSI) throw new SyntaxError(`Unit '${tk.v}' is an offset scale`);
    return { dimension: u.dimension, factorToSI: u.factorToSI };
  }
}

/** Parse a unit EXPRESSION (`kg*m/s^2`, `J/(kg⋅K)`, `m²`), or undefined. */
function parseUnitExpr(src: string): UnitValue | undefined {
  try {
    return new UnitParser(lexUnit(src)).parse();
  } catch {
    return undefined;
  }
}

/**
 * Characters that make a reference a unit EXPRESSION rather than one name —
 * the product and quotient operators, grouping, and the superscript digits.
 */
const UNIT_EXPR_SYNTAX = /[*\u22c5\u00b7/^()\u2070\u00b9\u00b2\u00b3\u2074-\u2079\u207b]/;

/** Memo for the string funnel — a compound unit is re-parsed on every lookup. */
const RESOLVED = new Map<string, Unit | undefined>();

/** The funnel proper: every spelling, in order, for one already-trimmed string. */
function resolveUnitString(ref: string): Unit | undefined {
  const normalized = normalizeUnitRef(ref);
  if (normalized === '') return undefined;

  // (1) The bundled library's own qualified spelling, via the inverted
  //     libraryName map: `SI::'watt hour'` → Wh. Whole-string, because a
  //     library name may itself contain the parentheses and spaces the
  //     expression lexer would otherwise take apart.
  const byLibrary = BY_LIBRARY_NAME.get(normalized);
  if (byLibrary) return byLibrary;

  // (2) The whole reference as ONE name — a registry name or symbol with one
  //     prefix, its qualifier stripped (exact symbols win). Skipped when the
  //     reference carries expression syntax: there the qualifier belongs to
  //     its own atom, and a whole-string cut would turn `m/SI::s` into `s`.
  if (!UNIT_EXPR_SYNTAX.test(normalized)) {
    const direct = atomUnit(normalized);
    if (direct) return direct;
  }

  // (3) + (4) The long-name word forms, then the unit expression they become.
  //     The whole string is handed over UNCUT: each atom resolves its own
  //     qualifier inside {@link atomUnit}.
  const parsed = parseUnitExpr(wordFormExpr(normalized));
  if (!parsed) return undefined;
  return {
    name: normalized,
    symbol: normalized,
    dimension: parsed.dimension,
    factorToSI: parsed.factorToSI,
    prefixable: false,
  };
}

/**
 * Resolve a unit reference — a {@link Unit}, a long name, a symbol, a qualified
 * or quoted library name, a worded compound, or a unit expression. Returns
 * `undefined` when no spelling resolves.
 */
export function resolveUnit(u: Unit | string): Unit | undefined {
  if (typeof u !== 'string') return u;
  const key = u.trim();
  if (RESOLVED.has(key)) return RESOLVED.get(key);
  const resolved = resolveUnitString(key);
  RESOLVED.set(key, resolved);
  return resolved;
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

/** Base-unit symbol per dimension axis, for composing a coherent SI label. */
const SI_BASE_SYMBOLS: ReadonlyArray<readonly [keyof Dimension, string]> = [
  ['L', 'm'],
  ['M', 'kg'],
  ['T', 's'],
  ['I', 'A'],
  ['Th', 'K'],
  ['N', 'mol'],
  ['J', 'cd'],
];

/**
 * The symbol of the COHERENT SI unit of a dimension — `m`, `kg`, `J`, `W` —
 * or a composed base-unit product (`m·s⁻¹`) when the registry names no single
 * coherent unit for it. `undefined` for a dimensionless quantity, which has no
 * unit to name (and whose registry rows — `bit`, `Sh`, `E` — are counts of
 * different things, so picking one would be a lie).
 *
 * WHY it exists: the solver stores a value in its feature's DECLARED unit, and
 * falls back to coherent SI for a feature that declares a quantity kind but no
 * unit. Reporting such a value (a measure of effectiveness, an inequality's
 * slack) without a label leaves the reader to guess the scale; this is the
 * label that cannot contradict the number.
 *
 * The SAME reasoning applies one level up, where a dimension has SEVERAL
 * coherent units: T⁻¹ is `Hz` and `Bd`, and (because ISO 80000-13 makes
 * information content dimension one) it is also what every bit-rate kind
 * reduces to. Picking the first would label a `BinaryDigitRateValue` of 1e8 as
 * "100 MHz". Where the registry does not single one out, the composed
 * base-unit form (`s⁻¹`) is used instead: less idiomatic, but true of every
 * quantity that shares the dimension.
 */
export function siSymbolOf(d: Dimension): string | undefined {
  if (dimEqual(d, DIMENSIONLESS)) return undefined;
  // A registry unit whose SI map is the identity IS the coherent unit — but
  // only when it is the ONLY one, so the label cannot belong to a sibling kind.
  const coherent = REGISTRY.filter(
    (u) => u.factorToSI === 1 && !u.offsetSI && dimEqual(u.dimension, d),
  );
  if (coherent.length === 1) return coherent[0].symbol;
  const parts: string[] = [];
  for (const [axis, sym] of SI_BASE_SYMBOLS) {
    const e = d[axis];
    if (e === 0) continue;
    parts.push(e === 1 ? sym : `${sym}${superscript(e)}`);
  }
  return parts.length === 0 ? undefined : parts.join('·');
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

  /*
   * Information (ISQInformation), typed AS THE BUNDLE TYPES IT — read off the
   * library's own unit definitions rather than invented here:
   *
   *  - nine RATE kinds whose unit definition is a `DerivedUnit` with a duration
   *    power factor ⇒ T⁻¹ (so `bit/s` and `Hz` share a dimension: the standard
   *    says information content is dimension one, and that is the price);
   *  - nineteen CONTENT / ENTROPY / TRAFFIC kinds whose unit definition
   *    subclasses `MeasurementReferences::DimensionOneUnit` ⇒ dimensionless;
   *  - seven kinds the bundle gives NO unit definition at all (probabilities,
   *    a mean queue length, relative entropy/redundancy, decision content).
   *    Dimensionless is an authoring CHOICE for those, not a reading of the
   *    library — each is a pure number or a ratio in ISO 80000-13.
   *
   * Kind resolution reaches this table by NAME, not through a relationship:
   * `resolveTypeReferences` binds no FeatureTyping for a parsed
   * `attribute r : ISQ::BinaryDigitRateValue` (a qualified attribute typing
   * stays in `attrs.type`), so `quantityKindOf` hands the qualified name
   * straight to {@link quantityKindDimension}. That is also why the alias
   * names below are keys of their own.
   */

  // Rates — DerivedUnit with a duration power factor.
  BinaryDigitRateValue: dim({ T: -1 }),
  TransferRateValue: dim({ T: -1 }),
  EquivalentBinaryDigitRateValue: dim({ T: -1 }),
  ModulationRateValue: dim({ T: -1 }),
  AverageInformationRateValue: dim({ T: -1 }),
  AverageTransinformationRateValue: dim({ T: -1 }),
  ChannelTimeCapacityValue: dim({ T: -1 }),
  CallIntensityValue: dim({ T: -1 }),
  CompletedCallIntensityValue: dim({ T: -1 }),

  // Content, entropy and traffic — DimensionOneUnit.
  StorageCapacityValue: DIMENSIONLESS,
  EquivalentBinaryStorageCapacityValue: DIMENSIONLESS,
  InformationContentValue: DIMENSIONLESS,
  ConditionalInformationContentValue: DIMENSIONLESS,
  JointInformationContentValue: DIMENSIONLESS,
  TransinformationContentValue: DIMENSIONLESS,
  MeanTransinformationContentValue: DIMENSIONLESS,
  CharacterMeanTransinformationContentValue: DIMENSIONLESS,
  EntropyForInformationScienceValue: DIMENSIONLESS,
  ConditionalEntropyValue: DIMENSIONLESS,
  CharacterMeanEntropyValue: DIMENSIONLESS,
  MaximumEntropyValue: DIMENSIONLESS,
  EquivocationValue: DIMENSIONLESS,
  IrrelevanceValue: DIMENSIONLESS,
  RedundancyValue: DIMENSIONLESS,
  ChannelCapacityPerCharacterValue: DIMENSIONLESS,
  TrafficIntensityValue: DIMENSIONLESS,
  TrafficCarriedIntensityValue: DIMENSIONLESS,
  TrafficOfferedIntensityValue: DIMENSIONLESS,

  // No unit definition in the bundle — dimensionless by choice, documented.
  DecisionContentValue: DIMENSIONLESS,
  ErrorProbabilityValue: DIMENSIONLESS,
  LossProbabilityValue: DIMENSIONLESS,
  MeanQueueLengthValue: DIMENSIONLESS,
  RelativeEntropyValue: DIMENSIONLESS,
  RelativeRedundancyValue: DIMENSIONLESS,
  WaitingProbabilityValue: DIMENSIONLESS,

  /*
   * The ISQInformation ALIAS memberships. Under the full bundle
   * `resolveQualifiedNameFull` dereferences `ISQ::BitRateValue` to
   * `BinaryDigitRateValue` before the table is consulted, but under
   * `library: 'none'` or the curated fallback there is nothing to dereference —
   * so the alias names are keys in their own right. (The bundle declares 29
   * aliases; the other 20 name a *Unit definition or a feature, neither of
   * which this *Value-keyed table has a slot for.)
   */
  BitRateValue: dim({ T: -1 }),
  EquivalentBitRateValue: dim({ T: -1 }),
  LineDigitRateValue: dim({ T: -1 }),
  CallingRateValue: dim({ T: -1 }),
  StorageSizeValue: DIMENSIONLESS,
  ChannelCapacityValue: DIMENSIONLESS,
  TrafficLoadValue: DIMENSIONLESS,
  MeanConditionalInformationContentValue: DIMENSIONLESS,
  AverageConditionalInformationContentValue: DIMENSIONLESS,
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

/**
 * KerML conformance (subtype/specialization) checks over a {@link Model}.
 *
 *  - {@link conforms} — structural specialization test: does `specificId`
 *    specialize (directly or transitively) `generalId`? Works across the
 *    standard library, e.g. `ScalarValues::Integer` conforms to
 *    `ScalarValues::Real` and to `Number`.
 *  - {@link valueConformsToType} — a lightweight literal-vs-type-family check
 *    for an attribute's stored value against its declared numeric/Boolean/String
 *    family (via `attrs.type` or a FeatureTyping relationship).
 */

import { type ElementId, type Model } from '@core/index';
import { generalizationsOf } from './inheritance';

/**
 * True iff `specificId` conforms to `generalId` — i.e. they are the same
 * element, or `generalId` is among the transitive general types of
 * `specificId`.
 */
export function conforms(model: Model, specificId: ElementId, generalId: ElementId): boolean {
  if (specificId === generalId) return true;
  return generalizationsOf(model, specificId).some((g) => g.id === generalId);
}

/** Recognised scalar type families for literal checking. */
type NumericFamily = 'Real' | 'Rational' | 'Integer' | 'Natural' | 'Positive' | 'Number' | 'Complex';
const NUMERIC_FAMILIES = new Set<string>([
  'Real', 'Rational', 'Integer', 'Natural', 'Positive', 'Number', 'Complex', 'NumericalValue',
]);

/**
 * Check an attribute's stored literal `value` against its declared type family.
 *
 * The type name is taken from `attrs.type` (the plain-string form the parser
 * stores for attribute typing) or, failing that, from the first FeatureTyping /
 * specialization target's `declaredName`.
 *
 * @returns
 *  - `'ok'` when the value is present and matches the type family;
 *  - `'mismatch'` when the value is present but clearly the wrong family;
 *  - `'unknown'` when there is no value, no recognised type, or the value is a
 *    non-literal expression that cannot be judged statically.
 */
export function valueConformsToType(model: Model, featureId: ElementId): 'ok' | 'mismatch' | 'unknown' {
  const el = model.get(featureId);
  if (!el) return 'unknown';

  const typeName = declaredTypeName(model, featureId);
  if (!typeName) return 'unknown';

  const raw = el.attrs.value;
  if (raw === undefined || raw === null) return 'unknown';

  const lit = interpretLiteral(raw);
  if (lit.kind === 'unknown') return 'unknown';

  if (NUMERIC_FAMILIES.has(typeName)) {
    if (lit.kind !== 'number') return 'mismatch';
    return numericFamilyOk(typeName as NumericFamily, lit.value) ? 'ok' : 'mismatch';
  }
  if (typeName === 'Boolean') {
    return lit.kind === 'boolean' ? 'ok' : 'mismatch';
  }
  if (typeName === 'String') {
    return lit.kind === 'string' ? 'ok' : 'mismatch';
  }
  return 'unknown';
}

/** Resolve the declared type name of a feature: `attrs.type` or a typing target. */
function declaredTypeName(model: Model, featureId: ElementId): string | undefined {
  const el = model.get(featureId);
  if (!el) return undefined;
  if (typeof el.attrs.type === 'string' && el.attrs.type) return lastSegment(el.attrs.type);
  if (typeof el.attrs.typeRef === 'string' && el.attrs.typeRef) return lastSegment(el.attrs.typeRef);
  const typed = model.typesOf(featureId)[0];
  return typed?.declaredName;
}

const lastSegment = (ref: string): string => ref.split('::').pop()!.trim();

/** Whether a numeric literal satisfies the constraints of a numeric family. */
function numericFamilyOk(family: NumericFamily, v: number): boolean {
  const isInt = Number.isInteger(v);
  switch (family) {
    case 'Integer':
      return isInt;
    case 'Natural':
      return isInt && v >= 0;
    case 'Positive':
      return isInt && v > 0;
    default:
      // Real, Rational, Complex, Number — any finite number.
      return Number.isFinite(v);
  }
}

type Literal =
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'unknown' };

/**
 * Interpret a stored `attrs.value` (which may be a native number/boolean or a
 * source string such as a quoted string literal) as a literal.
 */
function interpretLiteral(raw: unknown): Literal {
  if (typeof raw === 'number') return { kind: 'number', value: raw };
  if (typeof raw === 'boolean') return { kind: 'boolean', value: raw };
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (
      s.length >= 2 &&
      ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    ) {
      return { kind: 'string', value: s.slice(1, -1) };
    }
    if (s === 'true' || s === 'false') return { kind: 'boolean', value: s === 'true' };
    if (s !== '' && !Number.isNaN(Number(s))) return { kind: 'number', value: Number(s) };
    // A non-literal expression string — not judged here.
    return { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

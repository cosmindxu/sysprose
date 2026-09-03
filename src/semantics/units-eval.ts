/**
 * Unit-aware model evaluation.
 *
 * Where {@link ./evaluate-model} folds feature values to bare scalars, this
 * module folds them to *quantities* — a magnitude paired with a physical
 * {@link Dimension} (and, when known, the unit the magnitude is expressed in).
 * It layers three capabilities on top of the {@link ./units} engine:
 *
 *  1. {@link evaluateQuantity} — read a single feature's LITERAL value as a
 *     quantity, deriving its dimension from the value's unit (`[kg]` in a
 *     string value, `attrs.unit`, or a unit-valued `attrs.multiplicity`)
 *     and/or from an ISQ quantity-kind typing.
 *
 *  2. A small, self-contained unit-aware expression evaluator (clean-room, in
 *     the spirit of {@link ./expr} but value-typed over quantities): arithmetic
 *     propagates dimensions (`a*b` multiplies, `a/b` divides), and additions /
 *     comparisons require compatible dimensions, auto-converting both operands
 *     to SI before combining. Unit literals are written `2000 [kg]`.
 *
 *  3. {@link evaluateConstraintQuantity} — evaluate a ConstraintUsage /
 *     RequirementUsage boolean expression with the unit-aware evaluator, so a
 *     clause such as `require { mass <= 2000 [kg] }` is judged with proper unit
 *     conversion. {@link ./evaluate-model}.checkConstraints consults it FIRST
 *     and falls back to the scalar evaluator only for a dimensioned feature
 *     compared with a bare literal.
 *
 * DERIVED FEATURES ARE QUANTITIES, BEHIND A DIMENSION GUARD. The quantity scope
 * is lazy: a feature whose value is an expression (`endurance = capacity *
 * fraction / power`) is evaluated on demand in its OWNER's quantity scope, so
 * the derivation carries its dimension (640 Wh × 0.8 / 650 W = 2835.7 s, T).
 * That is exactly what makes a hand-rolled conversion dangerous: `enduranceMin
 * : Real = … / cruisePower * 60.0` derives to 170 141 s — the author's minutes
 * read as seconds — and against `100.0 [min]` (6000 s) it would answer
 * SATISFIED where the intent is violated. So a derived feature whose derived
 * dimension disagrees with its declared type ({@link dimensionClaim} ===
 * `'mismatch'`) is EXCLUDED from the scope: the constraint answers unknown and
 * the `derived-dimension-mismatch` rule names the feature. Unknown beats a
 * confident wrong verdict.
 */

import { isSpecialization, type AttrValue, type ElementId, type ElementRecord, type Model } from '@core/index';
import { effectiveFeatures } from './inheritance';
import { resolveQualifiedNameFull } from './resolve-names';
import {
  DIMENSIONLESS,
  dimEqual,
  dimToString,
  divideDim,
  multiplyDim,
  powDim,
  quantityKindDimension,
  unitByName,
  unitBySymbol,
  type Dimension,
  type Unit,
} from './units';

/* ───────────────────────────── Quantity model ───────────────────────────── */

/** A magnitude with a physical dimension and (optionally) the unit it is in. */
export interface Quantity {
  /** The numeric magnitude, expressed in {@link unit} when one is set. */
  magnitude: number;
  /** The physical dimension of the quantity. */
  dimension: Dimension;
  /** The unit name/symbol the magnitude is expressed in, when known. */
  unit?: string;
  /**
   * True when {@link unit} is an offset (affine) scale — °C, °F. Such a value
   * is a point on a scale, not an amount: two of them may be ordered, but their
   * difference is a different kind of quantity (a temperature interval) that
   * the engine does not model yet, so arithmetic on them answers unknown.
   */
  absolute?: boolean;
}

/** Read an attribute as a string, or undefined when absent/non-string. */
function asString(v: AttrValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve a unit reference (long name or symbol) to a registry {@link Unit}.
 * A qualified reference — `SI::kg`, the spelling the training corpus uses —
 * resolves by its last segment; the full normalisation funnel (quoted names,
 * compound units) is a separate item.
 */
export function resolveUnitRef(name: string): Unit | undefined {
  const key = name.trim();
  const direct = unitByName(key) ?? unitBySymbol(key);
  if (direct) return direct;
  const idx = key.lastIndexOf('::');
  if (idx < 0) return undefined;
  const last = key.slice(idx + 2).trim();
  if (last === '') return undefined;
  return unitByName(last) ?? unitBySymbol(last);
}

/** The dimension of a unit reference, or undefined when the registry does not know it. */
function dimensionOfRef(name: string): Dimension | undefined {
  return resolveUnitRef(name)?.dimension;
}

/** True when `name` is a unit known to the registry (so a unit, not e.g. `1..*`). */
function isKnownUnit(name: string): boolean {
  return resolveUnitRef(name) !== undefined;
}

/**
 * The SI value of a quantity: `magnitude · factorToSI + offsetSI` when a unit is
 * set, else the magnitude verbatim (already assumed SI-coherent). Returns
 * `undefined` for an unresolvable unit.
 */
export function siValue(q: Quantity): number | undefined {
  if (q.unit === undefined) return q.magnitude;
  const u = resolveUnitRef(q.unit);
  if (!u) return undefined;
  return q.magnitude * u.factorToSI + (u.offsetSI ?? 0);
}

/* ─────────────────────── Feature → Quantity extraction ───────────────────── */

/** Parse a magnitude + optional bracketed unit from a value literal. */
const MAGNITUDE_UNIT_RE =
  /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(?:\[\s*([^\]]+?)\s*\])?$/;

/**
 * The unit reference a feature's value is expressed in, independent of whether
 * the magnitude is a literal: an inline `[unit]` in a string value, then an
 * explicit `attrs.unit` (where the parser folds a trailing `= 1500 [kg]`, and
 * where `= (1 + 2) [m]` leaves the unit beside an EXPRESSION value), then an
 * `attrs.multiplicity` that names a known unit.
 */
function unitOfFeature(el: ElementRecord): string | undefined {
  const raw = el.attrs.value;
  if (typeof raw === 'string') {
    const m = raw.trim().match(MAGNITUDE_UNIT_RE);
    if (m?.[2]) return m[2].trim();
  }
  const attrUnit = asString(el.attrs.unit);
  if (attrUnit && attrUnit.trim() !== '') return attrUnit.trim();
  const mult = asString(el.attrs.multiplicity);
  if (mult && isKnownUnit(mult.trim())) return mult.trim();
  return undefined;
}

/** Extract `{ magnitude, unit? }` from a feature's LITERAL value/unit attributes. */
function magnitudeAndUnit(el: ElementRecord): { magnitude: number; unit?: string } | undefined {
  const raw = el.attrs.value;
  let magnitude: number | undefined;

  if (typeof raw === 'number') {
    magnitude = raw;
  } else if (typeof raw === 'string') {
    const m = raw.trim().match(MAGNITUDE_UNIT_RE);
    if (m) magnitude = Number(m[1]);
  }
  if (magnitude === undefined || !Number.isFinite(magnitude)) return undefined;
  const unit = unitOfFeature(el);
  return unit ? { magnitude, unit } : { magnitude };
}

/**
 * The ISQ quantity kind reachable from a type element: the element itself when
 * its declared name is a kind in the table, else the first kind reached through
 * its explicit specializations (`attribute def MyMass :> ISQ::MassValue`). The
 * walk is what keeps a user subtype of a kind from being mistaken for a bare
 * scalar and warned as a mismatch.
 */
function kindOfType(
  model: Model,
  typeId: ElementId,
  visited: Set<ElementId>,
): { dimension?: Dimension; name?: string } {
  if (visited.has(typeId)) return {};
  visited.add(typeId);
  const tel = model.get(typeId);
  if (!tel) return {};
  const d = quantityKindDimension(model, tel.id);
  if (d) return { dimension: d, name: tel.declaredName };

  for (const r of model.relationshipsFrom(typeId)) {
    if (!isSpecialization(r.eClass)) continue;
    const t = r.target?.[0];
    if (!t) continue;
    const via = kindOfType(model, t, visited);
    if (via.dimension) return via;
  }
  const names = tel.attrs.specializes;
  if (Array.isArray(names)) {
    for (const n of names) {
      if (typeof n !== 'string') continue;
      const via = kindOfName(model, n, visited);
      if (via.dimension) return via;
    }
  }
  return {};
}

/** {@link kindOfType} for a (possibly qualified) type NAME. */
function kindOfName(
  model: Model,
  name: string,
  visited: Set<ElementId>,
): { dimension?: Dimension; name?: string } {
  const d = quantityKindDimension(model, name);
  if (d) return { dimension: d, name };
  const el = resolveQualifiedNameFull(model, name);
  return el ? kindOfType(model, el.id, visited) : {};
}

/**
 * The ISQ quantity-kind of a feature (via its FeatureTyping target or its
 * `attrs.type` / `attrs.typeRef` name): its {@link Dimension} and declared name.
 */
function quantityKindOf(
  model: Model,
  featureId: ElementId,
): { dimension?: Dimension; name?: string } {
  const el = model.get(featureId);
  if (!el) return {};

  for (const r of model.relationshipsFrom(featureId)) {
    if (r.eClass !== 'FeatureTyping') continue;
    const t = r.target?.[0];
    if (!t) continue;
    const via = kindOfType(model, t, new Set());
    if (via.dimension) return via;
  }

  const name = asString(el.attrs.type) ?? asString(el.attrs.typeRef);
  if (name && name.trim() !== '') {
    const via = kindOfName(model, name.trim(), new Set());
    if (via.dimension) return via;
  }
  return {};
}

/** The declared type NAME of a feature, for messages and the scalar-type test. */
function declaredTypeName(model: Model, featureId: ElementId): string | undefined {
  const el = model.get(featureId);
  if (!el) return undefined;
  for (const r of model.relationshipsFrom(featureId)) {
    if (r.eClass !== 'FeatureTyping') continue;
    const t = r.target?.[0];
    const tel = t ? model.get(t) : undefined;
    if (tel?.declaredName) return tel.declaredName;
  }
  const name = asString(el.attrs.type) ?? asString(el.attrs.typeRef);
  return name && name.trim() !== '' ? name.trim() : undefined;
}

/**
 * The bundled `ScalarValues` numeric types. A feature typed by one of these and
 * VALUED by a dimensioned derivation claims to be a pure number while carrying
 * a physical dimension — the hand-conversion smell.
 */
const NON_ISQ_SCALARS = new Set([
  'ScalarValue',
  'NumericalValue',
  'Number',
  'Complex',
  'Real',
  'Rational',
  'Integer',
  'Natural',
  'Positive',
  'NonNegative',
]);

function isNonIsqScalar(typeName: string): boolean {
  const last = typeName.split('::').pop()?.trim() ?? typeName;
  return NON_ISQ_SCALARS.has(last);
}

/**
 * Evaluate a feature's LITERAL value as a {@link Quantity}: its magnitude, its
 * physical dimension, and (when known) the unit the magnitude is expressed in.
 *
 * The dimension is taken from the value's unit when one is present and
 * recognised; otherwise from the feature's ISQ quantity-kind typing; otherwise
 * the value is treated as dimensionless. Returns `undefined` when the feature
 * carries no numeric literal (an expression-valued feature is read through the
 * quantity scope instead — see {@link dimensionClaim}).
 */
export function evaluateQuantity(model: Model, featureId: ElementId): Quantity | undefined {
  const el = model.get(featureId);
  if (!el) return undefined;
  const mu = magnitudeAndUnit(el);
  if (!mu) return undefined;

  const qk = quantityKindOf(model, featureId);
  let dimension: Dimension;
  if (mu.unit) {
    dimension = dimensionOfRef(mu.unit) ?? qk.dimension ?? DIMENSIONLESS;
  } else {
    dimension = qk.dimension ?? DIMENSIONLESS;
  }

  const q: Quantity = { magnitude: mu.magnitude, dimension };
  if (mu.unit) {
    q.unit = mu.unit;
    if (resolveUnitRef(mu.unit)?.offsetSI) q.absolute = true;
  }
  return q;
}

/**
 * The unit and quantity-kind dimensions of a feature, for consistency checks:
 * `unitDimension` is derived from the value's unit (when any), `kindDimension`
 * from the feature's ISQ quantity-kind typing (when any), plus the kind name.
 * The unit is reported for an expression-valued feature too (`= (1 + 2) [m]`
 * keeps `attrs.unit`), so an unknown-unit check does not misfire on it.
 */
export function dimensionalFacets(
  model: Model,
  featureId: ElementId,
): { unit?: string; unitDimension?: Dimension; kindDimension?: Dimension; kindName?: string } {
  const el = model.get(featureId);
  if (!el) return {};
  const unit = unitOfFeature(el);
  const qk = quantityKindOf(model, featureId);
  const out: {
    unit?: string;
    unitDimension?: Dimension;
    kindDimension?: Dimension;
    kindName?: string;
  } = {};
  if (unit) {
    out.unit = unit;
    out.unitDimension = dimensionOfRef(unit);
  }
  if (qk.dimension) out.kindDimension = qk.dimension;
  if (qk.name) out.kindName = qk.name;
  return out;
}

/* ────────────────────── Unit-aware expression evaluator ──────────────────── */

type QNode =
  | { kind: 'num'; value: number }
  | { kind: 'unit'; operand: QNode; unit: string }
  | { kind: 'ref'; path: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'unary'; op: '-' | '+' | 'not'; operand: QNode }
  | { kind: 'binary'; op: QBinOp; left: QNode; right: QNode };

type QBinOp =
  | '+' | '-' | '*' | '/' | '%' | '^'
  | '<' | '<=' | '>' | '>=' | '==' | '!=' | '='
  | 'and' | 'or';

type QTok =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'unit'; v: string }
  | { t: 'str'; v: string }
  | { t: 'op'; v: string }
  | { t: 'kw'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'eof' };

const Q_KEYWORDS = new Set(['true', 'false', 'and', 'or', 'not']);
const Q_MULTI_OPS = ['<=', '>=', '==', '!='];
const Q_SINGLE_OPS = new Set(['+', '-', '*', '/', '%', '^', '<', '>']);

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c) || c === '.';
}

/** Tokenise a unit-aware expression (numbers, `[unit]` literals, refs, ops). */
function lexQ(src: string): QTok[] {
  const toks: QTok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
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
    // A string literal is opaque to this evaluator (it has no string value
    // kind), but it must be lexed as ONE token: `"see table [3]"` carries a
    // bracket that is text, not a unit reference, and `unknown-unit` reads
    // the token stream to find the units a body names.
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) j++;
      if (j >= n) throw new SyntaxError('Unterminated string literal');
      toks.push({ t: 'str', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    // Bracketed unit literal, e.g. `[kg]`.
    if (c === '[') {
      let j = i + 1;
      while (j < n && src[j] !== ']') j++;
      if (j >= n) throw new SyntaxError('Unterminated unit literal');
      toks.push({ t: 'unit', v: src.slice(i + 1, j).trim() });
      i = j + 1;
      continue;
    }
    // Number literal.
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i;
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.') {
        j++;
        while (j < n && isDigit(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && isDigit(src[j])) j++;
      }
      toks.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    // Identifier / dotted feature chain / keyword.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      toks.push(Q_KEYWORDS.has(word) ? { t: 'kw', v: word } : { t: 'name', v: word });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (Q_MULTI_OPS.includes(two)) {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (Q_SINGLE_OPS.has(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '=') {
      // Distinct `=` token — not silently folded to `==` (finding L3); treated
      // as equality by the evaluator, but kept distinct in the token stream.
      toks.push({ t: 'op', v: '=' });
      i++;
      continue;
    }
    throw new SyntaxError(`Unexpected character '${c}'`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

/**
 * The `[unit]` references written inside an expression text (a constraint
 * body, a transition guard, an expression value) — what the `unknown-unit`
 * rule scans. Best effort: when the text is not lexable as a unit-aware
 * expression (a `#(i)` index, a call), the brackets are still collected —
 * outside string literals, whose brackets are text (`"see table [3]"`).
 */
export function unitRefsIn(text: string): string[] {
  try {
    return lexQ(text)
      .filter((t): t is { t: 'unit'; v: string } => t.t === 'unit')
      .map((t) => t.v)
      .filter((v) => v !== '');
  } catch {
    const out: string[] = [];
    const re = /\[([^[\]]*)\]/g;
    let m: RegExpExecArray | null;
    const unquoted = text.replace(/"[^"]*"|'[^']*'/g, ' ');
    while ((m = re.exec(unquoted)) !== null) {
      const v = m[1].trim();
      if (v !== '') out.push(v);
    }
    return out;
  }
}

const Q_PRECEDENCE: Record<string, number> = {
  or: 2,
  and: 3,
  '==': 4,
  '=': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
  '^': 8,
};
const Q_RIGHT_ASSOC = new Set(['^']);

class QParser {
  private pos = 0;
  constructor(private readonly toks: QTok[]) {}

  private peek(): QTok {
    return this.toks[this.pos];
  }
  private next(): QTok {
    return this.toks[this.pos++];
  }

  parse(): QNode {
    const node = this.parseBinary(0);
    if (this.peek().t !== 'eof') throw new SyntaxError('Trailing tokens');
    return node;
  }

  private binaryOpHere(): string | undefined {
    const tk = this.peek();
    if (tk.t === 'op') return tk.v;
    if (tk.t === 'kw' && (tk.v === 'and' || tk.v === 'or')) return tk.v;
    return undefined;
  }

  private parseBinary(minPrec: number): QNode {
    let left = this.parseUnary();
    for (;;) {
      const op = this.binaryOpHere();
      if (op === undefined) break;
      const prec = Q_PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const nextMin = Q_RIGHT_ASSOC.has(op) ? prec : prec + 1;
      const right = this.parseBinary(nextMin);
      left = { kind: 'binary', op: op as QBinOp, left, right };
    }
    return left;
  }

  private parseUnary(): QNode {
    const tk = this.peek();
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
      this.next();
      return { kind: 'unary', op: tk.v, operand: this.parseUnary() };
    }
    if (tk.t === 'kw' && tk.v === 'not') {
      this.next();
      return { kind: 'unary', op: 'not', operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  /** A primary optionally followed by a `[unit]` annotation. */
  private parsePostfix(): QNode {
    let node = this.parsePrimary();
    while (this.peek().t === 'unit') {
      const u = this.next() as { t: 'unit'; v: string };
      node = { kind: 'unit', operand: node, unit: u.v };
    }
    return node;
  }

  private parsePrimary(): QNode {
    const tk = this.next();
    switch (tk.t) {
      case 'num':
        return { kind: 'num', value: tk.v };
      case 'name':
        return { kind: 'ref', path: tk.v };
      case 'kw':
        if (tk.v === 'true') return { kind: 'bool', value: true };
        if (tk.v === 'false') return { kind: 'bool', value: false };
        throw new SyntaxError(`Unexpected keyword '${tk.v}'`);
      case 'lparen': {
        const inner = this.parseBinary(0);
        if (this.next().t !== 'rparen') throw new SyntaxError('Expected )');
        return inner;
      }
      case 'str':
        throw new SyntaxError('String literals are not unit-aware expressions');
      default:
        throw new SyntaxError('Unexpected token');
    }
  }
}

/**
 * Why the unit-aware evaluator could not answer. Each is a distinct repair for
 * the author, which is why they are tags and not one string:
 *  - `unresolved` — a referenced name has no value in scope;
 *  - `unit` — a `[unit]` the registry does not know;
 *  - `dimension` — operands of different dimensions added/compared, or a
 *    `[unit]` applied to an already-dimensioned operand;
 *  - `offset` — arithmetic on an offset scale (°C, °F);
 *  - `mismatch` — a referenced derived feature's dimension disagrees with its
 *    declared type (see {@link dimensionClaim});
 *  - `cycle` — a derivation cycle;
 *  - `parse` — the expression is not a unit-aware expression;
 *  - `not-boolean` / `not-quantity` — the wrong value kind where the other
 *    was needed;
 *  - `division-by-zero`.
 */
export type QReason =
  | 'unresolved'
  | 'unit'
  | 'dimension'
  | 'offset'
  | 'mismatch'
  | 'cycle'
  | 'parse'
  | 'not-boolean'
  | 'not-quantity'
  | 'division-by-zero'
  | 'empty';

/** A one-line, author-facing rendering of a {@link QReason}. */
export function describeReason(reason: QReason, detail?: string): string {
  switch (reason) {
    case 'unresolved':
      return detail ? `"${detail}" has no value in scope` : 'a referenced value is unknown';
    case 'unit':
      return `unit "${detail ?? '?'}" is not in the unit registry`;
    case 'dimension':
      return detail ?? 'the operands have different physical dimensions';
    case 'offset':
      return `"${detail ?? '?'}" is on an offset temperature scale (°C/°F); differences and sums on it are not supported — use K (or °C values may only be ordered)`;
    case 'mismatch':
      return `"${detail ?? '?'}" derives to a dimension that disagrees with its declared type, so it is excluded from unit-aware evaluation`;
    case 'cycle':
      return `"${detail ?? '?'}" is defined through itself`;
    case 'parse':
      return 'the expression is not a unit-aware expression';
    case 'not-boolean':
      return 'the expression did not evaluate to a boolean';
    case 'not-quantity':
      return 'a boolean was used where a quantity was needed';
    case 'division-by-zero':
      return 'division by zero';
    case 'empty':
      return 'the expression is empty';
  }
}

type QScope = (name: string) => QEval | undefined;
/**
 * An unknown carries the machine `reason`, the `detail` that reason's
 * {@link describeReason} sentence is built from, and — when the sentence has
 * already been composed on the way up (a derived feature naming the operand
 * that failed inside it) — the finished `message`.
 */
type QUnknown = { unknown: true; reason: QReason; detail?: string; message?: string };
type QEval = { q: Quantity } | { b: boolean } | QUnknown;
const isQUnknown = (r: QEval): r is QUnknown => 'unknown' in r;
const unknownQ = (reason: QReason, detail?: string, message?: string): QEval => ({
  unknown: true,
  reason,
  ...(detail !== undefined ? { detail } : {}),
  ...(message !== undefined ? { message } : {}),
});
const messageOf = (r: QUnknown): string => r.message ?? describeReason(r.reason, r.detail);

/**
 * Comparison tolerance: `|a − b| ≤ max(absTol, 1e-9·max(|a|, |b|))`.
 *
 * Exact `===` on SI values called `1 [ft] == 12 [in]` violated (0.3048 vs
 * 0.30479999999999996) and flipped every Newton-solved equality the numeric
 * engine accepts at 1e-6. The relative part absorbs float noise from the
 * registry's conversion factors; the absolute part is the caller's own
 * tolerance (a solver's), 0 by default.
 */
const REL_TOL = 1e-9;
function tolFor(a: number, b: number, absTol: number): number {
  return Math.max(absTol, REL_TOL * Math.max(Math.abs(a), Math.abs(b)));
}

function evalQ(node: QNode, scope: QScope, absTol: number): QEval {
  switch (node.kind) {
    case 'num':
      return { q: { magnitude: node.value, dimension: DIMENSIONLESS } };
    case 'bool':
      return { b: node.value };
    case 'ref': {
      const r = scope(node.path);
      return r === undefined ? unknownQ('unresolved', node.path) : r;
    }
    case 'unit':
      return applyUnit(evalQ(node.operand, scope, absTol), node.unit);
    case 'unary': {
      const r = evalQ(node.operand, scope, absTol);
      if (isQUnknown(r)) return r;
      if (node.op === 'not') return 'b' in r ? { b: !r.b } : unknownQ('not-boolean');
      if ('q' in r) {
        if (node.op === '+') return r;
        if (r.q.absolute) return unknownQ('offset', r.q.unit);
        return { q: { ...r.q, magnitude: -r.q.magnitude } };
      }
      return unknownQ('not-quantity');
    }
    case 'binary':
      return evalQBinary(node, scope, absTol);
  }
}

/**
 * `expr [unit]` — the spec's `'['` takes `in num: Number`: a bare number takes
 * the unit's dimension; an operand that already carries a dimension cannot be
 * re-dimensioned (`(2 [kg]) [m]` is a fault, not a conversion).
 */
function applyUnit(inner: QEval, unit: string): QEval {
  if (isQUnknown(inner)) return inner;
  if ('b' in inner) return unknownQ('not-quantity');
  const u = resolveUnitRef(unit);
  if (!u) return unknownQ('unit', unit);
  if (!dimEqual(inner.q.dimension, DIMENSIONLESS)) {
    return unknownQ(
      'dimension',
      `a unit literal [${unit}] was applied to an operand that already has dimension ${dimToString(inner.q.dimension)}`,
    );
  }
  const q: Quantity = { magnitude: inner.q.magnitude, dimension: u.dimension, unit };
  if (u.offsetSI) q.absolute = true;
  return { q };
}

function evalQBinary(node: Extract<QNode, { kind: 'binary' }>, scope: QScope, absTol: number): QEval {
  const op = node.op;

  if (op === 'and' || op === 'or') {
    const l = evalQ(node.left, scope, absTol);
    if (!isQUnknown(l) && 'b' in l) {
      if (op === 'and' && l.b === false) return { b: false };
      if (op === 'or' && l.b === true) return { b: true };
    }
    const r = evalQ(node.right, scope, absTol);
    if (isQUnknown(l)) return l;
    if (isQUnknown(r)) return r;
    if (!('b' in l) || !('b' in r)) return unknownQ('not-boolean');
    return { b: op === 'and' ? l.b && r.b : l.b || r.b };
  }

  const l = evalQ(node.left, scope, absTol);
  const r = evalQ(node.right, scope, absTol);
  return combineQ(op, l, r, absTol);
}

/** Apply an arithmetic/comparison operator to two evaluated operands. */
function combineQ(op: QBinOp, l: QEval, r: QEval, absTol: number): QEval {
  if (isQUnknown(l)) return l;
  if (isQUnknown(r)) return r;
  if (!('q' in l) || !('q' in r)) return unknownQ('not-quantity');
  const a = l.q;
  const b = r.q;

  switch (op) {
    case '*':
      return combineProduct(a, b, false);
    case '/':
      return combineProduct(a, b, true);
    case '+':
    case '-':
      return combineAddition(op, a, b);
    case '%': {
      if (a.absolute || b.absolute) return unknownQ('offset', a.absolute ? a.unit : b.unit);
      const sa = siValue(a);
      const sb = siValue(b);
      if (sa === undefined) return unknownQ('unit', a.unit);
      if (sb === undefined) return unknownQ('unit', b.unit);
      if (!dimEqual(a.dimension, b.dimension)) return unknownQ('dimension', dimensionClash(a, b));
      return { q: { magnitude: sa % sb, dimension: a.dimension } };
    }
    case '^': {
      if (a.absolute || b.absolute) return unknownQ('offset', a.absolute ? a.unit : b.unit);
      const sa = siValue(a);
      const exp = siValue(b);
      if (sa === undefined) return unknownQ('unit', a.unit);
      if (exp === undefined) return unknownQ('unit', b.unit);
      if (!dimEqual(b.dimension, DIMENSIONLESS)) {
        return unknownQ('dimension', `an exponent must be dimensionless, not ${dimToString(b.dimension)}`);
      }
      return { q: { magnitude: sa ** exp, dimension: powDim(a.dimension, exp) } };
    }
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compareQ(op, a, b, absTol);
    case '=':
    case '==':
    case '!=': {
      const eq = op === '==' || op === '=';
      // Equality on an offset scale is an arithmetic question (a difference of
      // zero), and the scale's zero is not the dimension's zero: answer unknown.
      if (a.absolute || b.absolute) return unknownQ('offset', a.absolute ? a.unit : b.unit);
      if (!dimEqual(a.dimension, b.dimension)) return { b: !eq };
      const sa = siValue(a);
      const sb = siValue(b);
      if (sa === undefined) return unknownQ('unit', a.unit);
      if (sb === undefined) return unknownQ('unit', b.unit);
      const same = Math.abs(sa - sb) <= tolFor(sa, sb, absTol);
      return { b: eq ? same : !same };
    }
    default:
      return unknownQ('parse');
  }
}

function dimensionClash(a: Quantity, b: Quantity): string {
  return `${dimToString(a.dimension)} and ${dimToString(b.dimension)} are different physical dimensions`;
}

/** Multiply (or divide) two quantities, propagating dimensions; result in SI. */
function combineProduct(a: Quantity, b: Quantity, divide: boolean): QEval {
  if (a.absolute || b.absolute) return unknownQ('offset', a.absolute ? a.unit : b.unit);
  const sa = siValue(a);
  const sb = siValue(b);
  if (sa === undefined) return unknownQ('unit', a.unit);
  if (sb === undefined) return unknownQ('unit', b.unit);
  if (divide && sb === 0) return unknownQ('division-by-zero');
  return {
    q: {
      magnitude: divide ? sa / sb : sa * sb,
      dimension: divide ? divideDim(a.dimension, b.dimension) : multiplyDim(a.dimension, b.dimension),
    },
  };
}

/** Add/subtract two quantities; requires equal dimensions, combined in SI. */
function combineAddition(op: '+' | '-', a: Quantity, b: Quantity): QEval {
  if (a.absolute || b.absolute) return unknownQ('offset', a.absolute ? a.unit : b.unit);
  if (!dimEqual(a.dimension, b.dimension)) return unknownQ('dimension', dimensionClash(a, b));
  const sa = siValue(a);
  const sb = siValue(b);
  if (sa === undefined) return unknownQ('unit', a.unit);
  if (sb === undefined) return unknownQ('unit', b.unit);
  return { q: { magnitude: op === '+' ? sa + sb : sa - sb, dimension: a.dimension } };
}

/**
 * Ordered comparison; requires equal dimensions, compared in SI within the
 * tolerance. Two absolute temperatures may be ordered (the affine map is
 * monotone), which is why `t2 >= 300 [K]` on a °C value still answers.
 *
 * Values within the tolerance count as EQUAL for every operator, the strict
 * ones included: `x < y` holds when `x − y ≤ tol`, exactly as the numeric
 * surface judges an inequality residual (`violated = g > tol`). Applying the
 * tolerance in the strict direction instead made `0.9999999999 < 1.0` a
 * confident VIOLATED here and satisfied there — a cross-surface disagreement
 * on float noise.
 */
function compareQ(op: '<' | '<=' | '>' | '>=', a: Quantity, b: Quantity, absTol: number): QEval {
  if (!dimEqual(a.dimension, b.dimension)) return unknownQ('dimension', dimensionClash(a, b));
  const x = siValue(a);
  const y = siValue(b);
  if (x === undefined) return unknownQ('unit', a.unit);
  if (y === undefined) return unknownQ('unit', b.unit);
  const tol = tolFor(x, y, absTol);
  switch (op) {
    case '<':
    case '<=':
      return { b: x - y <= tol };
    case '>':
    case '>=':
      return { b: y - x <= tol };
  }
}

/* ─────────────────────────── Quantity scopes ────────────────────────────── */

/**
 * Build a LAZY name → quantity resolver rooted at `contextId`: names map to
 * feature ids, and a feature's quantity is computed on lookup — an expression
 * through its OWN owner scope, with `inFlight` guarding a derivation cycle.
 * Mirrors `scopeWith` in {@link ./evaluate-model}.
 */
function quantityScopeFor(
  model: Model,
  contextId: ElementId,
  inFlight: Set<ElementId>,
  memo: DerivationMemo,
): QScope {
  const ids = new Map<string, ElementId>();
  collectQuantityIds(model, contextId, '', ids, new Set());
  return (name: string) => {
    const id = ids.get(name);
    if (id === undefined) return undefined;
    return derivationEval(deriveFeature(model, id, inFlight, memo), name);
  };
}

/**
 * The scope's answer for one feature: its quantity (or boolean), or the reason
 * it has none. The unit and the offset scale are about the unit and the
 * mismatch is about the feature itself; every other reason arose INSIDE the
 * derivation, so the message names both — `"uav.total" cannot be derived: M
 * and 1 are different physical dimensions` — rather than collapsing to the
 * bare feature name.
 */
function derivationEval(d: FeatureDerivation, name: string): QEval {
  if (d.q) return { q: d.q };
  if (d.b !== undefined) return { b: d.b };
  const reason = d.reason ?? 'unresolved';
  if (reason === 'unit' || reason === 'offset') return unknownQ(reason, d.detail ?? name);
  if (reason === 'mismatch') return unknownQ(reason, name);
  if (d.detail === undefined && reason === 'unresolved') return unknownQ(reason, name);
  return unknownQ(reason, name, `"${name}" cannot be derived: ${describeReason(reason, d.detail)}`);
}

/**
 * A per-call cache of {@link FeatureDerivation}s. A derivation re-evaluates
 * its operands through their own owner scopes, so without one the cost grows
 * with the number of reference PATHS — exponential on a chain of shared
 * derivations (`f_i = f_{i-1} + f_{i-2}`), and the UI validates on every
 * edit. Entries are model facts, safe to share across one run; a `cycle`
 * answer depends on the evaluation stack and is never stored.
 */
export type DerivationMemo = Map<ElementId, FeatureDerivation>;

function collectQuantityIds(
  model: Model,
  ownerId: ElementId,
  prefix: string,
  ids: Map<string, ElementId>,
  visited: Set<string>,
): void {
  const guardKey = `${prefix} ${ownerId}`;
  if (visited.has(guardKey)) return;
  visited.add(guardKey);

  for (const feat of effectiveFeatures(model, ownerId)) {
    const name = feat.declaredName;
    if (!name) continue;
    const full = prefix ? `${prefix}.${name}` : name;
    if (feat.attrs.value !== undefined && feat.attrs.value !== null) {
      if (!ids.has(full)) ids.set(full, feat.id);
      if (!ids.has(name)) ids.set(name, feat.id); // bare-name convenience
    }
    for (const type of model.typesOf(feat.id)) {
      collectQuantityIds(model, type.id, full, ids, visited);
    }
  }
}

/**
 * What a feature's value claims about its dimension:
 *  - `literal` — a numeric literal; the declared kind (or unit) IS the dimension;
 *  - `consistent` — an expression whose derived dimension agrees with the
 *    declared type (or the type makes no claim);
 *  - `mismatch` — an expression whose derived dimension disagrees with the
 *    declared ISQ kind, or is dimensioned while the type is a bare scalar
 *    (`Real`, `Integer`, …). The feature is excluded from quantity scopes;
 *  - `unknown` — not a numeric value, or the derivation could not be evaluated.
 */
export type DimensionClaim = 'literal' | 'consistent' | 'mismatch' | 'unknown';

/** The full derivation record behind {@link dimensionClaim}. */
export interface FeatureDerivation {
  claim: DimensionClaim;
  /** The quantity the feature contributes to a scope (absent for `mismatch`/`unknown`). */
  q?: Quantity;
  /** A boolean-valued feature (`armed : Boolean = true`) contributes this instead. */
  b?: boolean;
  /** The dimension the value expression derives to (expression-valued features). */
  derived?: Dimension;
  /** The dimension of the declared ISQ kind, when the type names one. */
  declared?: Dimension;
  /** The declared type name, for messages. */
  typeName?: string;
  /** Why the derivation has no quantity, when it has none. */
  reason?: QReason;
  detail?: string;
}

const claimOnly = (claim: DimensionClaim, reason?: QReason, detail?: string): FeatureDerivation => ({
  claim,
  ...(reason ? { reason } : {}),
  ...(detail !== undefined ? { detail } : {}),
});

/**
 * Evaluate one feature as a quantity — a literal directly, an expression in the
 * feature's owner scope — and judge its dimension claim. This is the single
 * place the guard lives: the scope, the `derived-dimension-mismatch` rule and
 * the scalar-fallback refusal all read the same record.
 */
function deriveFeature(
  model: Model,
  id: ElementId,
  inFlight: Set<ElementId>,
  memo: DerivationMemo,
): FeatureDerivation {
  const hit = memo.get(id);
  if (hit) return hit;
  const d = deriveFeatureUncached(model, id, inFlight, memo);
  if (d.reason !== 'cycle') memo.set(id, d);
  return d;
}

function deriveFeatureUncached(
  model: Model,
  id: ElementId,
  inFlight: Set<ElementId>,
  memo: DerivationMemo,
): FeatureDerivation {
  const feat = model.get(id);
  if (!feat) return claimOnly('unknown', 'unresolved');

  const literal = evaluateQuantity(model, id);
  if (literal) return { claim: 'literal', q: literal };

  const raw = feat.attrs.value;
  // A boolean feature is a legitimate operand of `and`/`or`/`not` in a body
  // (`armed and mtow <= 25.0 [kg]`); it is not a quantity, but it is a value.
  if (typeof raw === 'boolean') return { claim: 'unknown', b: raw };
  if (typeof raw !== 'string' || raw.trim() === '') return claimOnly('unknown', 'unresolved');
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return claimOnly('unknown', 'not-quantity');
  }
  if (inFlight.has(id)) return claimOnly('unknown', 'cycle');

  let node: QNode;
  try {
    node = new QParser(lexQ(s)).parse();
  } catch {
    return claimOnly('unknown', 'parse');
  }

  inFlight.add(id);
  let r: QEval;
  try {
    const owner: QScope =
      feat.ownerId != null ? quantityScopeFor(model, feat.ownerId, inFlight, memo) : () => undefined;
    r = evalQ(node, owner, 0);
  } finally {
    inFlight.delete(id);
  }
  if (isQUnknown(r)) return claimOnly('unknown', r.reason, r.detail);
  if (!('q' in r)) return { claim: 'unknown', b: r.b };

  // A unit beside an expression value (`= (1 + 2) [m]`) is the spec's `'['`
  // applied to the whole derivation: legal on a dimensionless result only.
  let q = r.q;
  const unit = unitOfFeature(feat);
  if (unit) {
    const withUnit = applyUnit({ q }, unit);
    if (isQUnknown(withUnit)) return claimOnly('unknown', withUnit.reason, withUnit.detail);
    q = (withUnit as { q: Quantity }).q;
  }
  // An offset-scale value can only reach here through a plain reference
  // (`t3 : TemperatureValue = t1`, arithmetic on one already answered
  // `offset`), and a reference IS the same point on the scale: it keeps its
  // `absolute` flag, so it may still be ordered and still refuses arithmetic.

  const derived = q.dimension;
  const qk = quantityKindOf(model, id);
  const typeName = declaredTypeName(model, id);
  const base: FeatureDerivation = {
    claim: 'consistent',
    derived,
    ...(qk.dimension ? { declared: qk.dimension } : {}),
    ...(typeName ? { typeName } : {}),
  };

  if (qk.dimension) {
    if (dimEqual(derived, qk.dimension)) return { ...base, q };
    // A dimensionless derivation on a kinded feature takes the kind's dimension
    // by convention, exactly as a bare literal does (`limit : MassValue = 25.0`).
    if (dimEqual(derived, DIMENSIONLESS)) return { ...base, q: { ...q, dimension: qk.dimension } };
    return { ...base, claim: 'mismatch', reason: 'mismatch' };
  }
  if (typeName && isNonIsqScalar(typeName) && !dimEqual(derived, DIMENSIONLESS)) {
    return { ...base, claim: 'mismatch', reason: 'mismatch' };
  }
  return { ...base, q };
}

/** The {@link DimensionClaim} of a feature's value. */
export function dimensionClaim(model: Model, featureId: ElementId, memo: DerivationMemo = new Map()): DimensionClaim {
  return deriveFeature(model, featureId, new Set(), memo).claim;
}

/**
 * The full {@link FeatureDerivation} of a feature's value (for messages). A
 * caller judging many features in one pass (a validation rule, a constraint
 * sweep) shares one {@link DerivationMemo} across the calls.
 */
export function dimensionClaimDetail(
  model: Model,
  featureId: ElementId,
  memo: DerivationMemo = new Map(),
): FeatureDerivation {
  return deriveFeature(model, featureId, new Set(), memo);
}

/**
 * The dimension an expression-valued feature derives to, whatever its claim
 * (`undefined` for a literal or an unevaluable derivation). A constraint that
 * would compare such a feature as a raw magnitude must not.
 */
export function derivedDimensionOf(
  model: Model,
  featureId: ElementId,
  memo: DerivationMemo = new Map(),
): Dimension | undefined {
  return deriveFeature(model, featureId, new Set(), memo).derived;
}

/* ────────────────────────── Constraint evaluation ───────────────────────── */

/** Options for {@link evaluateConstraintQuantityDetailed}. */
export interface ConstraintQuantityOptions {
  /**
   * A last-resort name resolver (e.g. solved values) consulted only for a name
   * the model scopes do not answer at all. It never overrides a reasoned
   * unknown — a `mismatch` or `offset` refusal stays a refusal.
   */
  fallback?: (name: string) => Quantity | undefined;
  /** Absolute tolerance for `==`/`!=`/comparisons (a solver's, typically). */
  absTol?: number;
  /** A derivation cache shared across the constraints of one sweep. */
  memo?: DerivationMemo;
}

/** The detailed outcome of a unit-aware constraint evaluation. */
export interface ConstraintQuantityResult {
  verdict: 'satisfied' | 'violated' | 'unknown';
  /** Set for `unknown`: the machine tag. */
  reason?: QReason;
  /** Set for `unknown`: the author-facing sentence. */
  detail?: string;
  /** SI values of the two sides when the root is a comparison and both evaluated. */
  lhsSI?: number;
  rhsSI?: number;
  /** The dimension the comparison was made in. */
  dimension?: Dimension;
}

const COMPARISONS = new Set<QBinOp>(['<', '<=', '>', '>=', '==', '!=', '=']);

/**
 * Evaluate a constraint/requirement boolean expression with the unit-aware
 * evaluator, classifying it as `satisfied` / `violated` / `unknown` and, for
 * `unknown`, saying why. Scope is built from the constraint's owner (subject
 * context) merged with itself, then the caller's `fallback`.
 */
export function evaluateConstraintQuantityDetailed(
  model: Model,
  el: ElementRecord,
  opts: ConstraintQuantityOptions = {},
): ConstraintQuantityResult {
  const expr = el.attrs.expression;
  if (typeof expr !== 'string' || expr.trim() === '') {
    return { verdict: 'unknown', reason: 'empty', detail: describeReason('empty') };
  }

  let node: QNode;
  try {
    node = new QParser(lexQ(expr)).parse();
  } catch (e) {
    return { verdict: 'unknown', reason: 'parse', detail: (e as Error).message };
  }

  const inFlight = new Set<ElementId>();
  const memo = opts.memo ?? new Map();
  const ownerScope = el.ownerId != null ? quantityScopeFor(model, el.ownerId, inFlight, memo) : undefined;
  const selfScope = quantityScopeFor(model, el.id, inFlight, memo);
  const scope: QScope = (name) => {
    const fromOwner = ownerScope?.(name);
    if (fromOwner !== undefined) return fromOwner;
    const fromSelf = selfScope(name);
    if (fromSelf !== undefined) return fromSelf;
    const fb = opts.fallback?.(name);
    return fb === undefined ? undefined : { q: fb };
  };
  const absTol = opts.absTol ?? 0;

  let r: QEval;
  const sides: Pick<ConstraintQuantityResult, 'lhsSI' | 'rhsSI' | 'dimension'> = {};
  if (node.kind === 'binary' && COMPARISONS.has(node.op)) {
    const l = evalQ(node.left, scope, absTol);
    const rr = evalQ(node.right, scope, absTol);
    if (!isQUnknown(l) && 'q' in l && !isQUnknown(rr) && 'q' in rr) {
      const ls = siValue(l.q);
      const rs = siValue(rr.q);
      if (ls !== undefined) sides.lhsSI = ls;
      if (rs !== undefined) sides.rhsSI = rs;
      sides.dimension = l.q.dimension;
    }
    r = combineQ(node.op, l, rr, absTol);
  } else {
    r = evalQ(node, scope, absTol);
  }

  if (isQUnknown(r)) {
    return { verdict: 'unknown', reason: r.reason, detail: messageOf(r), ...sides };
  }
  if (!('b' in r)) {
    return { verdict: 'unknown', reason: 'not-boolean', detail: describeReason('not-boolean'), ...sides };
  }
  return { verdict: r.b ? 'satisfied' : 'violated', ...sides };
}

/**
 * Evaluate a constraint/requirement boolean expression with the unit-aware
 * evaluator, classifying it as `satisfied` / `violated` / `unknown`. See
 * {@link evaluateConstraintQuantityDetailed} for the reason behind an unknown.
 */
export function evaluateConstraintQuantity(
  model: Model,
  el: ElementRecord,
): 'satisfied' | 'violated' | 'unknown' {
  return evaluateConstraintQuantityDetailed(model, el).verdict;
}

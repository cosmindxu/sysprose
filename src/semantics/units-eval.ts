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
import {
  type DefiningEquations,
  GUARD_CONTACT,
  MAX_DERIVATION_DEPTH,
  baseIdOf,
  boundPartnerSafe,
  chooseDefinition,
  definitionKey,
  definitionsInFlight,
  hasUserBindings,
  instanceKey,
  isAsserted,
  hasStatedValue,
  mergeContact,
  contradictionSentence,
  defaultGivesWay,
  namesDefinedBy,
  returnTo,
  shadowedEquation,
  shadowedNamesOf,
  shadowedSentence,
  sharedDefinitions,
  statedValueOf,
  type Contact,
  type DefiningEquation,
  type InFlight,
} from './defining-equation';
import { isBindingEdge } from './connectors';
import { DOUBLE_DIGITS, significantDigitsOf } from './expr';
import {
  addRationals,
  compareRationals,
  decideComparison,
  divideRationals,
  multiplyRationals,
  negateRational,
  powerRational,
  remainderRational,
  siRational,
  statedRational,
  subtractRationals,
  tieSentence,
  writtenRational,
  type ComparisonOperator,
  type DecideOptions,
  type Rational,
} from './exact';
import { resolveQualifiedNameFull } from './resolve-names';
import {
  AMOUNT_UNIT,
  DIMENSIONLESS,
  amountOfKind,
  dimEqual,
  dimensionOf,
  dimensionOneKindsOf,
  dimToString,
  divideDim,
  multiplyDim,
  powDim,
  quantityKindDimension,
  resolveUnit,
  type Dimension,
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
  /**
   * A magnitude computed from a DIMENSION-ONE value that had a unit, which the
   * arithmetic converted to SI and dropped: `cap * 2.0` with `cap = 2.0 [GiB]`
   * is 2^35 — bits — with dimension one and no unit. It is a quantity still,
   * not a Number, so `[unit]` may not be applied to it ({@link applyUnit}):
   * read as a plain number, `(cap * 2.0) [GiB]` relabelled 2^35 bit as 2^35
   * GiB, and `dbl > 1000.0 [GiB]` held at a value of 4 GiB.
   *
   * `unit` is the first such unit, for the sentence. `kinds` says, for each
   * KIND of dimension one the number is still an amount of — information,
   * traffic, a ratio of lengths ({@link dimensionOneKindsOf}) — how many times
   * its conversion is in it: the exponent of the unit it would take to state
   * it. Only a power of zero is a plain number again, and powers cancel only
   * within a kind: `cap / 1.0 [GiB]` is 2 whatever bits are, but `cap * cap /
   * 1.0 [GiB]`, `cap * 1.0 [m] / 1.0 [m]` and `cap / strain` (GiB over mm/m)
   * are still bits. A sum of two different powers (`cap + 1.0`) has none, and
   * is `NaN`: no unit states it. Absent where every kind's power is zero.
   */
  convertedFrom?: Conversion;
  /**
   * {@link magnitude} as the exact rational the author's decimals give it —
   * in {@link unit} when one is set, like the magnitude — carried through
   * exact arithmetic (`exactQ`). A comparison decides by it wherever both
   * sides have one (`decideComparison` of ./exact), so `0.1 + 0.2 > 0.3` is
   * false here as it is to the SMT engine, and `1.0 + 0.00000000000000001 >
   * 1.0` true although binary64 absorbs the difference. Absent where no exact
   * reading exists: a fractional power, a value a solver produced.
   */
  exact?: Rational;
}

/** {@link Quantity.convertedFrom}: the first unit converted out of, and the power left of each kind. */
export interface Conversion {
  unit: string;
  kinds: Readonly<Record<string, number>>;
}

/** Read an attribute as a string, or undefined when absent/non-string. */
function asString(v: AttrValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve a unit reference to a registry {@link Unit}.
 *
 * The funnel itself lives in {@link ./units} (model-free, memoised, and the one
 * place that knows about quoted, qualified, worded and compound spellings);
 * this alias is the name the evaluation layer and its tests have always used.
 */
export const resolveUnitRef = resolveUnit;

/** True when `name` is a unit known to the registry (so a unit, not e.g. `1..*`). */
function isKnownUnit(name: string): boolean {
  return resolveUnit(name) !== undefined;
}

/**
 * The SI value of a quantity: `magnitude · factorToSI + offsetSI` when a unit is
 * set, else the magnitude verbatim (already assumed SI-coherent). Returns
 * `undefined` for an unresolvable unit.
 */
export function siValue(q: Quantity): number | undefined {
  if (q.unit === undefined) return q.magnitude;
  const u = resolveUnit(q.unit);
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

/**
 * The unit a feature's value is written in when that value is an EXPRESSION —
 * `total = (k * 2.0) [GiB]`, which the parser stores as the expression `(k *
 * 2.0)` beside `attrs.unit` — and so the `[unit]` the unit-aware evaluator
 * applies to the whole derivation ({@link deriveFeatureUncached}). `undefined`
 * for a literal value (`2.0 [GiB]` IS the stored magnitude) and for none.
 *
 * Exported for the readers that join a value to its feature as an equation —
 * the solver lane and the obligation worklist — so that they read `x ==
 * expr * 1.0 [unit]` as this evaluator does, never the bare `x == expr`.
 */
export function expressionValueUnitOf(el: ElementRecord): string | undefined {
  const raw = el.attrs.value;
  if (typeof raw !== 'string' || MAGNITUDE_UNIT_RE.test(raw.trim())) return undefined;
  return unitOfFeature(el);
}

/**
 * Extract `{ magnitude, unit? }` from a feature's LITERAL value/unit
 * attributes, with the magnitude's exact reading: the decimal written, as the
 * SMT encoder reads the feature's value axiom (`statedRational` of ./exact).
 */
function magnitudeAndUnit(el: ElementRecord): { magnitude: number; unit?: string; exact?: Rational } | undefined {
  const raw = el.attrs.value;
  let magnitude: number | undefined;
  let lexeme: unknown;

  if (typeof raw === 'number') {
    magnitude = raw;
    lexeme = el.attrs.valueText;
  } else if (typeof raw === 'string') {
    const m = raw.trim().match(MAGNITUDE_UNIT_RE);
    if (m) {
      magnitude = Number(m[1]);
      lexeme = m[1];
    }
  }
  if (magnitude === undefined || !Number.isFinite(magnitude)) return undefined;
  const unit = unitOfFeature(el);
  const exact = statedRational(magnitude, lexeme);
  return { magnitude, ...(unit ? { unit } : {}), ...(exact ? { exact } : {}) };
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

/** {@link quantityKindOf}, once per feature and model revision. */
const QUANTITY_KINDS = new WeakMap<Model, { rev: number; kinds: Map<ElementId, { dimension?: Dimension; name?: string }> }>();

/**
 * The ISQ quantity-kind of a feature (via its FeatureTyping target or its
 * `attrs.type` / `attrs.typeRef` name): its {@link Dimension} and declared name.
 * Read once per feature and model revision: every gate asks it of every
 * variable of every relation, and a model with thousands of instance rows
 * asked it hundreds of thousands of times.
 */
export function quantityKindOf(
  model: Model,
  featureId: ElementId,
): { dimension?: Dimension; name?: string } {
  let memo = QUANTITY_KINDS.get(model);
  if (!memo || memo.rev !== model.rev) {
    memo = { rev: model.rev, kinds: new Map() };
    QUANTITY_KINDS.set(model, memo);
  }
  let hit = memo.kinds.get(featureId);
  if (!hit) {
    hit = quantityKindUncached(model, featureId);
    memo.kinds.set(featureId, hit);
  }
  return { ...hit };
}

function quantityKindUncached(model: Model, featureId: ElementId): { dimension?: Dimension; name?: string } {
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
    dimension = dimensionOf(mu.unit) ?? qk.dimension ?? DIMENSIONLESS;
  } else {
    dimension = qk.dimension ?? DIMENSIONLESS;
  }

  const q: Quantity = exactQ({ magnitude: mu.magnitude, dimension }, mu.exact);
  if (mu.unit) {
    q.unit = mu.unit;
    if (resolveUnit(mu.unit)?.offsetSI) q.absolute = true;
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
    out.unitDimension = dimensionOf(unit);
  }
  if (qk.dimension) out.kindDimension = qk.dimension;
  if (qk.name) out.kindName = qk.name;
  return out;
}

/* ────────────────────── Unit-aware expression evaluator ──────────────────── */

type QNode =
  | { kind: 'num'; value: number; text?: string }
  | { kind: 'unit'; operand: QNode; unit: string }
  | { kind: 'ref'; path: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'unary'; op: '-' | '+' | 'not'; operand: QNode }
  | { kind: 'binary'; op: QBinOp; left: QNode; right: QNode }
  | { kind: 'if'; cond: QNode; then: QNode; else: QNode };

type QBinOp =
  | '+' | '-' | '*' | '/' | '%' | '^'
  | '<' | '<=' | '>' | '>=' | '==' | '!=' | '='
  | 'and' | 'or' | 'xor' | 'implies';

type QTok =
  | { t: 'num'; v: number; text?: string }
  | { t: 'name'; v: string }
  | { t: 'unit'; v: string }
  | { t: 'str'; v: string }
  | { t: 'op'; v: string }
  | { t: 'kw'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'eof' };

/**
 * The scalar grammar's keywords ({@link ./expr}): a body with `implies`, `xor`
 * or `if … then … else` is read here as it is read there. Without them this
 * parser stopped at the keyword ("Trailing tokens", "Expected )"), so a
 * derived value against a unit literal inside one was unknown to the
 * validation surface and proved by the SMT engine, which reads all three.
 */
const Q_KEYWORDS = new Set(['true', 'false', 'and', 'or', 'not', 'xor', 'implies', 'if', 'then', 'else']);
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
      // The text rides along only where the double does not determine it
      // (`text` on a `num` node of ./expr): the numeral's exact reading.
      const text = src.slice(i, j);
      toks.push({ t: 'num', v: Number(text), ...(significantDigitsOf(text) > DOUBLE_DIGITS ? { text } : {}) });
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

/**
 * The (possibly dotted) names a unit-aware expression reads, in source order,
 * or `undefined` when the text is not one. The scalar grammar rejects a unit
 * literal (`m <= 60 [min]`), so a caller that must know WHICH features such a
 * body reads asks here rather than through `parseExpr`.
 */
export function quantityRefsIn(text: string): string[] | undefined {
  let node: QNode;
  try {
    node = new QParser(lexQ(text)).parse();
  } catch {
    return undefined;
  }
  const out: string[] = [];
  const walk = (n: QNode): void => {
    if (n.kind === 'ref') out.push(n.path);
    else if (n.kind === 'unit' || n.kind === 'unary') walk(n.operand);
    else if (n.kind === 'binary') {
      walk(n.left);
      walk(n.right);
    } else if (n.kind === 'if') {
      walk(n.cond);
      walk(n.then);
      walk(n.else);
    }
  };
  walk(node);
  return out;
}

const Q_PRECEDENCE: Record<string, number> = {
  implies: 1,
  or: 2,
  xor: 2,
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
const Q_RIGHT_ASSOC = new Set(['^', 'implies']);

/**
 * Every operator this grammar reads: the binary ones, which are the precedence
 * table's, and the prefix ones {@link QParser} takes. Exported for the property
 * test that no operator turns a dimension-one quantity into a plain number
 * ({@link Quantity.convertedFrom}): a binary operator added to the table is in
 * that test without anyone remembering to add it.
 */
export const UNIT_AWARE_OPERATORS: { readonly binary: readonly string[]; readonly prefix: readonly string[] } = {
  binary: Object.keys(Q_PRECEDENCE),
  prefix: ['-', '+', 'not'],
};

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
    if (tk.t === 'kw' && (tk.v === 'and' || tk.v === 'or' || tk.v === 'xor' || tk.v === 'implies')) return tk.v;
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
        return { kind: 'num', value: tk.v, ...(tk.text !== undefined ? { text: tk.text } : {}) };
      case 'name':
        return { kind: 'ref', path: tk.v };
      case 'kw':
        if (tk.v === 'true') return { kind: 'bool', value: true };
        if (tk.v === 'false') return { kind: 'bool', value: false };
        if (tk.v === 'if') {
          const cond = this.parseBinary(0);
          this.expectKw('then');
          const then = this.parseBinary(0);
          this.expectKw('else');
          return { kind: 'if', cond, then, else: this.parseBinary(0) };
        }
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

  private expectKw(kw: string): void {
    const tk = this.next();
    if (tk.t !== 'kw' || tk.v !== kw) throw new SyntaxError(`Expected '${kw}'`);
  }
}

/**
 * Why the unit-aware evaluator could not answer. Each is a distinct repair for
 * the author, which is why they are tags and not one string:
 *  - `unresolved` — a referenced name has no value in scope;
 *  - `unit` — a `[unit]` the registry does not know;
 *  - `dimension` — operands of different dimensions met where they had to
 *    match and ONE OF THEM IS DIMENSIONLESS (`mtow [kg] <= 25.0`). That is the
 *    bare-literal contract: the scalar evaluator may still read the literal in
 *    the other side's declared unit, so this is ignorance the caller is
 *    allowed to fill, not a refusal — and it is the ONLY dimensional reason
 *    that is;
 *  - `dimension-clash` — two operands of DIFFERENT, both non-dimensionless
 *    dimensions met where they had to match (`d [m] >= t [s]`). Nothing can
 *    make that comparison true or false, so it is a REFUSAL: a caller that
 *    answered it from the raw magnitudes would publish a confident wrong
 *    verdict (5 ≥ 2 — "a metre is longer than a second");
 *  - `dimension-fault` — the other dimensional faults with no dimensionless
 *    side to fall back on: a dimensioned exponent (`d ^ t`), or a `[unit]`
 *    applied to an operand that already carries one (`(mtow * 2.0) [kg]`).
 *    Also a REFUSAL — the expression is malformed, and raw magnitudes answer
 *    it as confidently as they answer a clash;
 *  - `offset` — arithmetic on an offset scale (°C, °F);
 *  - `mismatch` — a referenced derived feature's dimension disagrees with its
 *    declared type (see {@link dimensionClaim});
 *  - `cycle` — a derivation cycle;
 *  - `depth` — defining equations nested deeper than {@link MAX_DERIVATION_DEPTH}.
 *    A REFUSAL: past the cap neither the scalar path nor this one has a
 *    value, and the raw number a scalar scope would read on to is exactly the
 *    unit-blind answer the cap must not let through;
 *  - `parse` — the expression is not a unit-aware expression;
 *  - `not-boolean` / `not-quantity` — the wrong value kind where the other
 *    was needed;
 *  - `division-by-zero`;
 *  - `contradiction` — a REFUSAL: the feature's value contradicts a binding
 *    it redefines (`contradictedBindingOf` of ./defining-equation), so the
 *    model states two values for it and neither is read; `detail` is the
 *    sentence;
 *  - `shadowed` — a REFUSAL: the value reads a name the feature declares
 *    itself, which its owner's scope answers with another feature
 *    (`shadowedNamesOf` of ./defining-equation); `detail` is the sentence;
 *  - `tie` — a REFUSAL: the two sides of a comparison are equal within the
 *    tolerance and no exact reading decides them (`decideComparison` of
 *    ./exact); `detail` is the pair. The scalar path could only read the
 *    same tie unit-blind, so nothing fills it.
 */
export type QReason =
  | 'unresolved'
  | 'unit'
  | 'dimension'
  | 'dimension-clash'
  | 'dimension-fault'
  | 'offset'
  | 'mismatch'
  | 'cycle'
  | 'depth'
  | 'parse'
  | 'not-boolean'
  | 'not-quantity'
  | 'division-by-zero'
  | 'empty'
  | 'contradiction'
  | 'shadowed'
  | 'tie';

/** A one-line, author-facing rendering of a {@link QReason}. */
export function describeReason(reason: QReason, detail?: string): string {
  switch (reason) {
    case 'unresolved':
      return detail ? `"${detail}" has no value in scope` : 'a referenced value is unknown';
    case 'unit':
      return `unit "${detail ?? '?'}" is not in the unit registry`;
    case 'dimension':
      return detail ?? 'the operands have different physical dimensions';
    case 'dimension-clash':
      return `${detail ?? 'the operands have different physical dimensions'} — no conversion relates them, so the comparison cannot be judged; compare quantities of the same dimension`;
    case 'dimension-fault':
      // Its `detail` is already a whole sentence about ONE operand, so there
      // is no second dimension to name and nothing to append.
      return detail ?? 'the expression combines dimensions in a way no conversion can repair';
    case 'offset':
      return `"${detail ?? '?'}" is on an offset temperature scale (°C/°F); differences and sums on it are not supported — use K (or °C values may only be ordered)`;
    case 'mismatch':
      return `"${detail ?? '?'}" derives to a dimension that disagrees with its declared type, so it is excluded from unit-aware evaluation`;
    case 'cycle':
      return `"${detail ?? '?'}" is defined through itself`;
    case 'depth':
      return `its defining equations nest more than ${MAX_DERIVATION_DEPTH} deep`;
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
    case 'contradiction':
      return detail ?? 'its value contradicts a binding it redefines';
    case 'shadowed':
      return detail ?? 'the value reads a name its own element declares, which this tool does not read';
    case 'tie': {
      const [x, y] = (detail ?? '? vs ?').split(' vs ');
      return tieSentence({ x: Number(x), y: Number(y) });
    }
  }
}

/**
 * Is this unknown a REFUSAL — a reasoned "that question has no answer" — as
 * opposed to ignorance a unit-blind evaluator may still fill in?
 *
 * The distinction is load-bearing on every surface that keeps a scalar
 * fallback (`checkConstraints`, `checkConstraintsNumeric`, the simulator, the
 * solver's relation set), so it lives HERE, beside the reasons themselves,
 * rather than being restated as a literal set per caller — three copies of a
 * set is three chances to forget one when a reason is added.
 *
 * `dimension` is deliberately absent: it is the bare-literal contract
 * (`mtow [kg] <= 25.0`), where reading the literal in the feature's declared
 * unit is exactly what the author meant. `depth` is present: past the cap a
 * dimensioned chain was compared as a raw number wherever its end was a value
 * expression or untyped (`u == x70 * 1.0` then `u >= 1.0`, satisfied).
 */
export function isRefusalReason(reason: QReason | undefined): boolean {
  return (
    reason === 'offset' ||
    reason === 'mismatch' ||
    reason === 'dimension-clash' ||
    reason === 'dimension-fault' ||
    reason === 'depth' ||
    reason === 'contradiction' ||
    reason === 'shadowed' ||
    reason === 'tie'
  );
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
 * How a comparison is read: the tie rule of ./exact. Both sides with an exact
 * reading ({@link Quantity.exact}) are compared exactly — `1 [ft] == 12 [in]`
 * holds although the registry's doubles make 0.3048 and 0.30479999999999996
 * of it, and `x < 25.0` at 25 is false. Otherwise the SI doubles decide
 * outside `|a − b| ≤ max(absTol, 1e-9·max(|a|, |b|))`; inside it, over
 * values a solver produced (`searched`), `==`, `<=` and `>=` hold — a
 * Newton-solved equality holds at the solve's own tolerance — and everything
 * else is undecided (`tie`): a strict ordering or a `!=` over a solved value
 * turns on the difference that tolerance hides. The absolute part is the
 * caller's own tolerance (a solver's), 0 by default.
 */
const EXACT: DecideOptions = { absTol: 0, searched: false };

/**
 * Evaluate `node` in `scope`. `every` reads EVERY branch of an `if`, not the
 * one the condition takes — the reading {@link valueUnitRefusal} decides a
 * `[unit]` by, which must hold whatever the condition is.
 */
function evalQ(node: QNode, scope: QScope, tol: DecideOptions, every = false): QEval {
  switch (node.kind) {
    case 'num':
      return { q: exactQ({ magnitude: node.value, dimension: DIMENSIONLESS }, writtenRational(node.value, node.text)) };
    case 'bool':
      return { b: node.value };
    case 'ref': {
      const r = scope(node.path);
      return r === undefined ? unknownQ('unresolved', node.path) : r;
    }
    case 'unit':
      return applyUnit(evalQ(node.operand, scope, tol, every), node.unit);
    case 'unary': {
      const r = evalQ(node.operand, scope, tol, every);
      if (isQUnknown(r)) return r;
      if (node.op === 'not') return 'b' in r ? { b: !r.b } : unknownQ('not-boolean');
      if ('q' in r) {
        if (node.op === '+') return r;
        if (r.q.absolute) return unknownQ('offset', r.q.unit);
        return { q: exactQ({ ...r.q, magnitude: -r.q.magnitude }, r.q.exact && negateRational(r.q.exact)) };
      }
      return unknownQ('not-quantity');
    }
    case 'binary':
      return evalQBinary(node, scope, tol, every);
    case 'if': {
      const c = evalQ(node.cond, scope, tol, every);
      if (every) {
        // Both branches, whatever the condition says — a refusal in it aside,
        // which is one on every path.
        if (isQUnknown(c) && isRefusalReason(c.reason)) return c;
        return everyBranch(evalQ(node.then, scope, tol, every), evalQ(node.else, scope, tol, every));
      }
      // Only the branch the condition takes is read, as the scalar evaluator
      // reads it.
      if (isQUnknown(c)) return c;
      if (!('b' in c)) return unknownQ('not-boolean');
      return evalQ(c.b ? node.then : node.else, scope, tol);
    }
  }
}

/**
 * The two branches of an `if` read together ({@link evalQ}'s `every`): one
 * quantity when they are the same KIND of quantity — one dimension, one
 * conversion ({@link conversionOf}), one scale — which every operation after
 * them then treats alike, and a refusal when they are not, since what follows
 * may then be a number on one path and an amount on the other (`if big then
 * cap else 3.0`, over `cap = 2.0 [GiB]`). A magnitude the two do not share is
 * not known (`NaN`), so an exponent read from it puts no power right.
 */
function everyBranch(t: QEval, e: QEval): QEval {
  if (isQUnknown(t) || isQUnknown(e)) return worseUnknown(t, e);
  if ('b' in t && 'b' in e) return t;
  if (!('q' in t) || !('q' in e)) return unknownQ('not-quantity');
  const a = t.q;
  const b = e.q;
  const ca = conversionOf(a);
  const cb = conversionOf(b);
  const same =
    dimEqual(a.dimension, b.dimension) &&
    a.absolute === b.absolute &&
    (ca === undefined) === (cb === undefined) &&
    (ca === undefined || sameKinds(ca.kinds, cb!.kinds));
  if (!same) {
    return unknownQ(
      'dimension-fault',
      'the branches of a conditional are different kinds of quantity, so no one reading of it holds on both',
    );
  }
  if (a.unit === b.unit) {
    const same = a.magnitude === b.magnitude;
    // One exact reading only where the two branches have the same one: two
    // decimals can round to one double.
    const exact = same && a.exact && b.exact && compareRationals(a.exact, b.exact) === 0 ? a.exact : undefined;
    return { q: exactQ({ ...a, magnitude: same ? a.magnitude : Number.NaN }, exact) };
  }
  // Two units of one kind: the result in SI, whose magnitude is not known.
  const q: Quantity = { magnitude: Number.NaN, dimension: a.dimension };
  if (ca !== undefined) q.convertedFrom = ca;
  if (a.absolute) q.absolute = true;
  return { q };
}

/** Do two {@link Conversion.kinds} hold the same power of every kind? (`NaN` is no power, and never the same.) */
function sameKinds(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * `expr [unit]` — the spec's `'['` takes `in num: Number`: a bare number takes
 * the unit's dimension; an operand that already carries a UNIT (or a dimension)
 * cannot be re-dimensioned (`(2 [kg]) [m]` is a fault, not a conversion).
 *
 * The guard is on the operand's unit FIRST, not only its dimension, because
 * dimension one is not unitless: `2 [B]` carries a factor of 8 with an all-zero
 * dimension, so a dimension-only guard let `cap [bit]` pass, rebuild the
 * quantity from the raw magnitude 2, and answer `cap [bit] <= 8.0 [bit]` a
 * confident SATISFIED where the truth is 16 bit > 8 bit.
 */
function applyUnit(inner: QEval, unit: string): QEval {
  if (isQUnknown(inner)) return inner;
  if ('b' in inner) return unknownQ('not-quantity');
  const u = resolveUnit(unit);
  if (!u) return unknownQ('unit', unit);
  if (inner.q.unit !== undefined && dimEqual(inner.q.dimension, DIMENSIONLESS)) {
    // Same refusal, its own sentence: there is no dimension to name here, and
    // the fault is that the operand's own unit — whose factor this would
    // silently discard — is already fixed.
    return unknownQ(
      'dimension-fault',
      `a unit literal [${unit}] was applied to an operand that already has unit "${inner.q.unit}"`,
    );
  }
  if (inner.q.convertedFrom !== undefined && dimEqual(inner.q.dimension, DIMENSIONLESS)) {
    // The same fault one operation later: the operand HAD such a unit, and the
    // arithmetic converted its magnitude to SI and dropped it (`cap * 2.0` is
    // 2^35 bit for a `cap` of 2 GiB). That is a quantity, not the Number `'['`
    // takes, and read as one it relabelled 2^35 bit as 2^35 GiB.
    return unknownQ(
      'dimension-fault',
      `a unit literal [${unit}] was applied to an operand computed from a value in "${inner.q.convertedFrom.unit}" — dimension one is not unitless`,
    );
  }
  if (!dimEqual(inner.q.dimension, DIMENSIONLESS)) {
    // A REFUSAL, not ignorance: there is no dimensionless side here (the
    // branch is only reached when the operand already has a dimension), so no
    // reading of the raw magnitudes is the one the author meant. Left fillable
    // it made `twice = (mtow * 2.0) [kg]` answer `twice <= 40.0` from 37 — a
    // confident verdict on an expression the author has to repair.
    return unknownQ(
      'dimension-fault',
      `a unit literal [${unit}] was applied to an operand that already has dimension ${dimToString(inner.q.dimension)}`,
    );
  }
  // A plain number takes the unit as it is: its exact reading is the
  // magnitude's, now in that unit.
  const q: Quantity = exactQ({ magnitude: inner.q.magnitude, dimension: u.dimension, unit }, inner.q.exact);
  if (u.offsetSI) q.absolute = true;
  return { q };
}

function evalQBinary(
  node: Extract<QNode, { kind: 'binary' }>,
  scope: QScope,
  tol: DecideOptions,
  every = false,
): QEval {
  const op = node.op;

  if (op === 'and' || op === 'or' || op === 'xor' || op === 'implies') {
    // The scalar evaluator's short-circuits ({@link ./expr}): `false and x`,
    // `true or x`, `false implies x` and `x implies true` decide without x.
    const l = evalQ(node.left, scope, tol, every);
    if (!isQUnknown(l) && 'b' in l) {
      if (op === 'and' && l.b === false) return { b: false };
      if (op === 'or' && l.b === true) return { b: true };
      if (op === 'implies' && l.b === false) return { b: true };
    }
    const r = evalQ(node.right, scope, tol, every);
    if (op === 'implies' && !isQUnknown(r) && 'b' in r && r.b === true) return { b: true };
    if (isQUnknown(l) || isQUnknown(r)) return worseUnknown(l, r);
    if (!('b' in l) || !('b' in r)) return unknownQ('not-boolean');
    switch (op) {
      case 'and':
        return { b: l.b && r.b };
      case 'or':
        return { b: l.b || r.b };
      case 'xor':
        return { b: l.b !== r.b };
      case 'implies':
        return { b: !l.b || r.b };
    }
  }

  const l = evalQ(node.left, scope, tol, every);
  const r = evalQ(node.right, scope, tol, every);
  return combineQ(op, l, r, tol);
}

/**
 * Of two operands at least one of which is unknown, the one the caller must
 * hear about: a REFUSAL outranks a fillable unknown.
 *
 * Returning the leftmost unknown unconditionally made the whole verdict turn
 * on operand ORDER. `mass <= 25.0 and mass <= massLimit` (a mass against a
 * limit mistyped as a length) reported the fillable `dimension` of the FIRST
 * conjunct, so `checkConstraints` fell through to the scalar path and answered
 * the whole body SATISFIED with no diagnostic — while the same two conjuncts
 * swapped were correctly refused, and the numeric surface answered `unknown`
 * either way. A conjunction is no more answerable than its least answerable
 * operand, so the refusal has to win from either side.
 */
function worseUnknown(l: QEval, r: QEval): QEval {
  const lu = isQUnknown(l) ? l : undefined;
  const ru = isQUnknown(r) ? r : undefined;
  if (!lu) return ru ?? l;
  if (!ru) return lu;
  return isRefusalReason(ru.reason) && !isRefusalReason(lu.reason) ? ru : lu;
}

/** Apply an arithmetic/comparison operator to two evaluated operands. */
function combineQ(op: QBinOp, l: QEval, r: QEval, tol: DecideOptions): QEval {
  // A refusal on either side wins, for the same reason it does in `and`/`or`:
  // which operand happened to be written first must not decide whether the
  // caller may fall back to raw magnitudes.
  if (isQUnknown(l) || isQUnknown(r)) return worseUnknown(l, r);
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
      if (!dimEqual(a.dimension, b.dimension)) return dimensionRefusal(a, b);
      return {
        q: exactQ(
          { magnitude: sa % sb, dimension: a.dimension, ...convertedOf(sumPower, a, b) },
          both(a, b, remainderRational),
        ),
      };
    }
    case '^': {
      if (a.absolute || b.absolute) return unknownQ('offset', a.absolute ? a.unit : b.unit);
      const sa = siValue(a);
      const exp = siValue(b);
      if (sa === undefined) return unknownQ('unit', a.unit);
      if (exp === undefined) return unknownQ('unit', b.unit);
      if (!dimEqual(b.dimension, DIMENSIONLESS)) {
        // Also a refusal: the exponent is dimensioned, so there is no
        // dimensionless side, and `d ^ t` (5 m ^ 2 s) read as 5² answered
        // `d ^ t <= 10.0` VIOLATED on both surfaces.
        return unknownQ('dimension-fault', `an exponent must be dimensionless, not ${dimToString(b.dimension)}`);
      }
      // A power of the base's conversion, by the exponent's NUMBER — which has
      // to be a number: `2.0 ^ cap` is 2^(2^34) in bits and 2^(2^31) in bytes.
      const power = (pa: number, pb: number): number => (pb !== 0 ? Number.NaN : pa * exp);
      // A dimensionless base stays dimensionless whatever the exponent — one
      // the every-path reading does not know (NaN) included.
      const dimension = dimEqual(a.dimension, DIMENSIONLESS) ? DIMENSIONLESS : powDim(a.dimension, exp);
      return { q: exactQ({ magnitude: sa ** exp, dimension, ...convertedOf(power, a, b) }, both(a, b, powerRational)) };
    }
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compareQ(op, a, b, tol);
    case '=':
    case '==':
    case '!=': {
      const eq = op === '==' || op === '=';
      // Equality on an offset scale is an arithmetic question (a difference of
      // zero), and the scale's zero is not the dimension's zero: answer unknown
      // — whatever the other side is, as the solver lane's gate reads it.
      if (a.absolute || b.absolute) return unknownQ('offset', a.absolute ? a.unit : b.unit);
      // Two different dimensions are decided exactly as an ordered comparison
      // decides them ({@link compareQ}): a clash of two real dimensions is
      // refused, and a DIMENSIONLESS side is the bare-literal contract, which
      // the caller's scalar path fills. Equality used to answer that side
      // itself — `dimensions differ ⇒ values differ` — so `limit : MassValue =
      // 25.0` was VIOLATED against `limit == 25.0` (and `n : Real = 5.0`
      // against `n == km` at 5 km) on every surface but SMT, while `>=` and `<=`
      // on the same pair were both satisfied.
      if (!dimEqual(a.dimension, b.dimension)) return dimensionRefusal(a, b);
      const sa = siValue(a);
      const sb = siValue(b);
      if (sa === undefined) return unknownQ('unit', a.unit);
      if (sb === undefined) return unknownQ('unit', b.unit);
      return decidedQ(eq ? '==' : '!=', sa, sb, a, b, tol);
    }
    default:
      return unknownQ('parse');
  }
}

function dimensionClash(a: Quantity, b: Quantity): string {
  return `${dimToString(a.dimension)} and ${dimToString(b.dimension)} are different physical dimensions`;
}

/**
 * The unknown for two operands whose dimensions had to match and do not — and
 * the ONE place that decides which of the two dimensional reasons it is.
 *
 * A DIMENSIONLESS side is `dimension`: `mtow [kg] <= 25.0` is the bare-literal
 * contract, where the author means the literal in the declared unit and the
 * scalar evaluator is entitled to read it that way, so callers may fall back.
 * Two genuinely different dimensions are `dimension-clash`: comparing a length
 * with a duration is not a question raw magnitudes may answer, and a caller
 * that fell back answered it wrongly (`5.0 [m] >= 2.0 [s]` read as 5 ≥ 2 and
 * reported SATISFIED on both surfaces).
 */
function dimensionRefusal(a: Quantity, b: Quantity): QEval {
  const bare = dimEqual(a.dimension, DIMENSIONLESS) || dimEqual(b.dimension, DIMENSIONLESS);
  return unknownQ(bare ? 'dimension' : 'dimension-clash', dimensionClash(a, b));
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
    q: exactQ(
      {
        magnitude: divide ? sa / sb : sa * sb,
        dimension: divide ? divideDim(a.dimension, b.dimension) : multiplyDim(a.dimension, b.dimension),
        // A quotient of two conversions of one power is a plain ratio again:
        // the factors cancel, so `cap / 1.0 [GiB]` is 2 whatever bits are.
        ...convertedOf(divide ? (pa, pb) => pa - pb : (pa, pb) => pa + pb, a, b),
      },
      both(a, b, divide ? divideRationals : multiplyRationals),
    ),
  };
}

/**
 * The dimension-one conversion an operand carries ({@link Quantity.convertedFrom}):
 * its own, or — for a value in a dimension-one UNIT (`2.0 [GiB]`, `3.0 [mm/m]`,
 * `1.0 [E]`) — that unit's kinds, each to the power the unit has it
 * ({@link dimensionOneKindsOf}), since every operation reads it in SI. A
 * dimensioned unit is not one: its dimension already says what it is.
 */
function conversionOf(q: Quantity): Conversion | undefined {
  if (q.convertedFrom !== undefined) return q.convertedFrom;
  if (q.unit === undefined || !dimEqual(q.dimension, DIMENSIONLESS)) return undefined;
  const kinds = dimensionOneKindsOf(q.unit);
  return kinds === undefined || Object.keys(kinds).length === 0 ? undefined : { unit: q.unit, kinds };
}

/** A sum, a difference or a remainder keeps the power both operands have; of two different ones, none (`NaN`). */
const sumPower = (pa: number, pb: number): number => (pa === pb ? pa : Number.NaN);

/**
 * The conversion the result of `a ∘ b` carries, whatever its dimension (a
 * metre in between does not make `cap * 1.0 [m] / 1.0 [m]` a plain number),
 * from the two operands' powers by the operator's rule, KIND BY KIND — and
 * none where every kind's power is zero. Powers cancel only within one kind:
 * `cap / strain` (GiB over mm/m) is information¹ and an `L ratio`⁻¹, not a
 * number.
 */
function convertedOf(power: (pa: number, pb: number) => number, a: Quantity, b: Quantity): { convertedFrom?: Conversion } {
  const ca = conversionOf(a);
  const cb = conversionOf(b);
  if (ca === undefined && cb === undefined) return {};
  const kinds: Record<string, number> = {};
  for (const kind of new Set([...Object.keys(ca?.kinds ?? {}), ...Object.keys(cb?.kinds ?? {})])) {
    const p = power(ca?.kinds[kind] ?? 0, cb?.kinds[kind] ?? 0);
    if (p !== 0) kinds[kind] = p;
  }
  return Object.keys(kinds).length === 0 ? {} : { convertedFrom: { unit: (ca ?? cb)!.unit, kinds } };
}

/** Add/subtract two quantities; requires equal dimensions, combined in SI. */
function combineAddition(op: '+' | '-', a: Quantity, b: Quantity): QEval {
  if (a.absolute || b.absolute) return unknownQ('offset', a.absolute ? a.unit : b.unit);
  if (!dimEqual(a.dimension, b.dimension)) return dimensionRefusal(a, b);
  const sa = siValue(a);
  const sb = siValue(b);
  if (sa === undefined) return unknownQ('unit', a.unit);
  if (sb === undefined) return unknownQ('unit', b.unit);
  return {
    q: exactQ(
      { magnitude: op === '+' ? sa + sb : sa - sb, dimension: a.dimension, ...convertedOf(sumPower, a, b) },
      both(a, b, op === '+' ? addRationals : subtractRationals),
    ),
  };
}

/**
 * Ordered comparison; requires equal dimensions, compared in SI by the tie
 * rule ({@link decidedQ}). Two absolute temperatures may be ordered (the
 * affine map is monotone), which is why `t2 >= 300 [K]` on a °C value still
 * answers.
 *
 * A tie is decided exactly wherever both sides have an exact reading, the
 * strict operators included: `mass < 25.0 [kg]` at 25 kg is violated, as the
 * scalar path and the SMT engine read it, and `0.9999999999 < 1.0` holds
 * because it is true of the decimals, not because a tolerance counts the two
 * as equal. Reading every near tie as equal for every operator made `x < y`
 * hold whenever `x − y ≤ tol` — `x < 25.0` at 25 satisfied here and refuted
 * by the solver — and reading the band strictly instead would refute
 * `1.0 + 0.00000000000000001 > 1.0`, which binary64 rounds to a tie.
 */
function compareQ(op: '<' | '<=' | '>' | '>=', a: Quantity, b: Quantity, tol: DecideOptions): QEval {
  if (!dimEqual(a.dimension, b.dimension)) return dimensionRefusal(a, b);
  const x = siValue(a);
  const y = siValue(b);
  if (x === undefined) return unknownQ('unit', a.unit);
  if (y === undefined) return unknownQ('unit', b.unit);
  return decidedQ(op, x, y, a, b, tol);
}

/**
 * `x op y` over the SI values of `a` and `b`, by the tie rule
 * (`decideComparison` of ./exact): their exact readings where both have one,
 * else the doubles outside the tolerance — and inside it, for values no exact
 * reading decides, `tie`: a refusal, since the unit-blind scalar path could
 * only answer it worse. Over a solve's values the sentence says so: the
 * tolerance is the solve's, not the evaluators'.
 */
function decidedQ(op: ComparisonOperator, x: number, y: number, a: Quantity, b: Quantity, tol: DecideOptions): QEval {
  const decided = decideComparison(op, x, y, siExact(a), siExact(b), tol);
  if (decided !== undefined) return { b: decided };
  return unknownQ('tie', `${x} vs ${y}`, tol.searched === true ? tieSentence({ x, y, solved: true }) : undefined);
}

/**
 * A quantity's exact value in coherent SI ({@link siValue}, exactly), or
 * `undefined` where it has no exact reading ({@link Quantity.exact}).
 */
export function siExact(q: Quantity): Rational | undefined {
  return q.exact === undefined ? undefined : siRational(q.exact, q.unit);
}

/** `q` with its exact reading, when there is one — and none carried over from a quantity it was copied from. */
function exactQ(q: Quantity, exact: Rational | undefined): Quantity {
  if (exact === undefined) {
    if (q.exact !== undefined) delete q.exact;
    return q;
  }
  q.exact = exact;
  return q;
}

/** `f` of the two SI values exactly, when both have an exact reading and `f` follows them. */
function both(a: Quantity, b: Quantity, f: (x: Rational, y: Rational) => Rational | undefined): Rational | undefined {
  const x = siExact(a);
  const y = siExact(b);
  return x !== undefined && y !== undefined ? f(x, y) : undefined;
}

/* ─────────────────────────── Quantity scopes ────────────────────────────── */

/**
 * Build a LAZY name → quantity resolver rooted at `contextId`: names map to
 * feature ids, and a feature's quantity is computed on lookup — an expression
 * through its OWN owner scope, with `inFlight` guarding a derivation cycle.
 * Mirrors `scopeWith` in {@link ./evaluate-model}. Given `reads` it is a
 * derivation's scope, and mirrors that one further: a bare name no stated
 * value answers is read through the asserted equation that fixes it
 * ({@link definedQuantity}), and `reads` records how deep the defining
 * equations under each answer nest.
 *
 * A DERIVATION's scope follows definitions; a constraint body's own scope
 * does not ({@link evaluateConstraintQuantityDetailed}): the names a body
 * reads that an equation fixes are its caller's to bind — the validation
 * surface binds them with the quantity the equation derives, the numeric
 * surface with the value the solver found.
 */
function quantityScopeFor(
  model: Model,
  contextId: ElementId,
  inFlight: InFlight,
  memo: DerivationMemo,
  reads?: Reads,
): QScope {
  const ids = quantityIdsOf(model, contextId, memo);
  const { definitions } = passOf(model, memo);
  return (name: string) => {
    const id = ids.get(name);
    if (id === undefined) {
      if (!reads) return undefined;
      const defined = definedQuantity(model, contextId, name, inFlight, memo, reads);
      return defined ?? (memo.everyPath === true ? standIn(model, contextId, name, memo) : undefined);
    }
    const d = deriveFeature(model, id, inFlight, memo, definitions.readAt(contextId, name));
    if (reads) note(reads, d);
    return derivationEval(d, name);
  };
}

/**
 * The name → feature-id map of `contextId`'s quantity scope: the one walk the
 * scalar scope reads too ({@link DefiningEquations.scope}), once per pass.
 */
function quantityIdsOf(model: Model, contextId: ElementId, memo: DerivationMemo): ReadonlyMap<string, ElementId> {
  return passOf(model, memo).definitions.scope(contextId, 'value');
}

/**
 * What a derivation's scope met: the deepest nest of defining equations under
 * an operand it read, how the operands met the derivation stack, and how
 * those with no value did (the `cause` {@link chooseDefinition} reads).
 */
interface Reads {
  depth: number;
  contact?: Contact;
  cause?: Contact;
}

function note(reads: Reads, d: FeatureDerivation): void {
  reads.depth = Math.max(reads.depth, d.depth ?? 0);
  reads.contact = mergeContact(reads.contact, d.contact);
  if (!answered(d)) reads.cause = mergeContact(reads.cause, d.cause);
}

/** The depth and contact a derivation over `reads` carries. */
function measured(reads: Reads): Pick<FeatureDerivation, 'depth' | 'contact'> {
  return { ...(reads.depth > 0 ? { depth: reads.depth } : {}), ...(reads.contact ? { contact: reads.contact } : {}) };
}

/** The cause a derivation over `reads` that has no value carries. */
function causedBy(reads: Reads): Pick<FeatureDerivation, 'cause'> {
  return reads.cause ? { cause: reads.cause } : {};
}

/** Does the derivation give the feature a value — a quantity or a boolean? */
function answered(d: FeatureDerivation): boolean {
  return d.q !== undefined || d.b !== undefined;
}

/**
 * The scope's answer for one feature: its quantity (or boolean), or the reason
 * it has none. The unit is about the unit and the feature's OWN mismatch is
 * about the feature itself; every other reason arose INSIDE the derivation,
 * so the message names both — `"uav.total" cannot be derived: M and 1 are
 * different physical dimensions` — rather than collapsing to the bare feature
 * name. Through a chain each link names itself, keeping the sentence the link
 * below composed (`"e" cannot be derived: "c2" derives to a dimension that
 * disagrees …`): with only the tag and its detail, the mismatch of an input
 * read as one of `e`'s own. A loop is already a whole sentence about the
 * whole chain, and passes through as written; the depth cap names the link
 * whose definitions nest past it (a definition past the cap carries no
 * sentence of its own, so each one the chain passes through does not stack
 * another "cannot be derived" on it).
 *
 * Offset arithmetic is one of those inner reasons: a derivation that answers
 * `offset` did it in its own expression or read it from a link below. It
 * keeps the unit as its detail, and the sentence names the feature too (so
 * does a body that reads it: `"d" cannot be derived: "°C" is on …`). With
 * the unit alone, the feature a chain fixes read the fault as its own:
 * `e == x / power`, over `x == t0 * 2.0` with `t0` in °C, said `"e" is on an
 * offset temperature scale`, of a duration.
 */
function derivationEval(d: FeatureDerivation, name: string): QEval {
  if (d.q) return { q: d.q };
  if (d.b !== undefined) return { b: d.b };
  const reason = d.reason ?? 'unresolved';
  if (reason === 'unit') return unknownQ(reason, d.detail ?? name);
  if (reason === 'offset') {
    const unit = d.detail ?? name;
    return unknownQ(reason, unit, `"${name}" cannot be derived: ${d.message ?? describeReason(reason, unit)}`);
  }
  if (reason === 'mismatch' && d.claim === 'mismatch') return unknownQ(reason, name);
  if (d.detail === undefined && reason === 'unresolved') return unknownQ(reason, name);
  if (reason === 'cycle' && d.message) return unknownQ(reason, d.detail, d.message);
  return unknownQ(reason, name, `"${name}" cannot be derived: ${d.message ?? describeReason(reason, d.detail)}`);
}

/**
 * A per-call cache of {@link FeatureDerivation}s. A derivation re-evaluates
 * its operands through their own owner scopes, so without one the cost grows
 * with the number of reference PATHS — exponential on a chain of shared
 * derivations (`f_i = f_{i-1} + f_{i-2}`), and the UI validates on every
 * edit. Entries are model facts, safe to share across one run; an answer
 * that met the derivation stack — a loop, an equation read back, the depth
 * guard: its {@link FeatureDerivation.contact} — depends on what else was
 * being derived at the time and is never stored. A feature's value is keyed
 * by its id; the derivation the equations in a context give it, by
 * {@link definitionKey}.
 *
 * A caller makes one as a plain `new Map()`; what the pass reads of the model
 * once rather than at every link (its {@link DerivationPass}) is attached on
 * first use, and lives as long as the memo does.
 */
export type DerivationMemo = Map<ElementId, FeatureDerivation> & {
  pass?: DerivationPass;
  /** This memo's derivations read every path ({@link everyPathMemo}). */
  everyPath?: true;
  /** The every-path memo of this pass, made on first use. */
  everyPathMemo?: DerivationMemo;
  /** This memo's derivations are read for a dimension, never a value ({@link dimensionsMemo}). */
  dimensions?: true;
  /** The dimension memo of this pass, made on first use. */
  dimensionsMemo?: DerivationMemo;
};

/** What one pass reads of the model once: the defining equations of each context, and its scope's names. */
export interface DerivationPass {
  definitions: DefiningEquations;
  /** Feature id → the other features a binding connector holds to its value, built on first use. */
  bound?: Map<ElementId, ElementId[]>;
}

function passOf(model: Model, memo: DerivationMemo): DerivationPass {
  if (memo.pass?.definitions.model !== model) memo.pass = { definitions: sharedDefinitions(model) };
  return memo.pass;
}

/**
 * The memo of the EVERY-PATH reading of this pass: derivations that read both
 * branches of every `if` ({@link evalQ}'s `every`) and a stand-in for every
 * input the model gives no value ({@link standIn}) — so what they answer holds
 * whatever the free inputs and the conditions are. It shares the pass's
 * reading of the model, and never its derivations, which answer only at the
 * model's point.
 */
function everyPathMemo(model: Model, memo: DerivationMemo): DerivationMemo {
  if (memo.everyPath === true) return memo;
  const pass = passOf(model, memo);
  if (memo.everyPathMemo?.pass !== pass) {
    const every: DerivationMemo = new Map();
    every.pass = pass;
    every.everyPath = true;
    memo.everyPathMemo = every;
  }
  return memo.everyPathMemo;
}

/**
 * The memo of the DIMENSION reading of this pass: derivations read for the
 * kind of quantity a value is — its dimension, unit and claim, which are one
 * in every instance — and never for a verdict ({@link derivationOf}, {@link
 * operandDerivation}, {@link dimensionClaim}). So a bound partner is read
 * where it is written there, though a context that stands for instances which
 * read it otherwise reads no value through it ({@link definedQuantity}): the
 * unit gates of the solver lane and the verification engines kept refusing
 * `L == 2.0 * K` (K bound to a mass) as a bare number against a derived
 * dimension, where only K's value — not its kilograms — was another in each
 * instance. It shares the pass's reading of the model, never its derivations;
 * it is the model's own memo where no binding the user wrote can make a
 * partner's value differ ({@link hasUserBindings}).
 */
function dimensionsMemo(model: Model, memo: DerivationMemo): DerivationMemo {
  if (memo.dimensions === true || memo.everyPath === true || !hasUserBindings(model)) return memo;
  const pass = passOf(model, memo);
  if (memo.dimensionsMemo?.pass !== pass) {
    const dims: DerivationMemo = new Map();
    dims.pass = pass;
    dims.dimensions = true;
    memo.dimensionsMemo = dims;
  }
  return memo.dimensionsMemo;
}

/**
 * What the every-path reading ({@link everyPathMemo}) reads for a name the
 * model gives no value: a STAND-IN for the feature it names, of the kind of
 * quantity that feature is, with no magnitude (`NaN`):
 *  - held by a binding to a stated literal, that literal (`bind mirror = cap`
 *    makes `mirror` an amount of GiB, as the solver lane reads it);
 *  - else, in its unit when it has one, of its kind's dimension when it has
 *    one — and an AMOUNT when that kind's unit is not the number one
 *    ({@link amountOfKind}): a valueless `StorageCapacityValue` is stored in
 *    bits, not a number to put `[GiB]` on;
 *  - a `Boolean` is a truth value, whichever (both branches are read).
 * `undefined` for a name that is no feature.
 */
function standIn(model: Model, contextId: ElementId, name: string, memo: DerivationMemo): QEval | undefined {
  const { definitions } = passOf(model, memo);
  const feature = name.includes('.')
    ? definitions.chain([contextId], name)?.feature
    : definitions.byName(contextId).get(name);
  if (!feature) return undefined;
  for (const partner of boundTo(model, feature.id, memo)) {
    const literal = evaluateQuantity(model, partner);
    if (literal) return { q: exactQ({ ...literal, magnitude: Number.NaN }, undefined) };
  }
  const typeName = declaredTypeName(model, feature.id);
  if (typeName !== undefined && typeName.split('::').pop() === 'Boolean') return { b: false };
  const facets = dimensionalFacets(model, feature.id);
  const q: Quantity = {
    magnitude: Number.NaN,
    dimension: facets.unitDimension ?? facets.kindDimension ?? DIMENSIONLESS,
  };
  if (facets.unit) {
    q.unit = facets.unit;
    if (resolveUnit(facets.unit)?.offsetSI) q.absolute = true;
  } else if (facets.kindName !== undefined && dimEqual(q.dimension, DIMENSIONLESS)) {
    const amount = amountOfKind(facets.kindName);
    if (amount !== undefined) q.convertedFrom = { unit: AMOUNT_UNIT[amount], kinds: { [amount]: 1 } };
  }
  return { q };
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
  /**
   * The finished sentence for `reason`, when it was composed inside the
   * derivation — an input that could not be derived names itself.
   */
  message?: string;
  /**
   * How many defining equations the derivation reads through, nested — itself
   * included when it is one. Absent where it read through none.
   */
  depth?: number;
  /**
   * How the derivation met the derivation stack, when it did: a loop, an
   * equation read back, the depth guard ({@link Contact}). It then depends on
   * what else was being derived, and is never memoised.
   */
  contact?: Contact;
  /** With no value: how its lack of one met the stack (the `cause` {@link chooseDefinition} reads). */
  cause?: Contact;
  /**
   * The asserted equation the derivation of a feature that states no value
   * was read through: the one {@link chooseDefinition} picked. The solver lane
   * orients the feature from this equation and no other, so it solves the
   * value the validation surface says the equation defines.
   */
  definedBy?: ElementId;
}

const claimOnly =(claim: DimensionClaim, reason?: QReason, detail?: string, message?: string): FeatureDerivation => ({
  claim,
  ...(reason ? { reason } : {}),
  ...(detail !== undefined ? { detail } : {}),
  ...(message !== undefined ? { message } : {}),
});

/**
 * Evaluate one feature as a quantity — a literal directly, an expression in the
 * feature's owner scope, or, given `at`, in the scope of the context that
 * changes what it reads, as that context's own value
 * ({@link DefiningEquations.readAt}) — and judge its dimension claim. This is
 * the single place the guard lives: the scope, the
 * `derived-dimension-mismatch` rule and the scalar-fallback refusal all read
 * the same record.
 */
function deriveFeature(
  model: Model,
  id: ElementId,
  inFlight: InFlight,
  memo: DerivationMemo,
  at?: ElementId,
): FeatureDerivation {
  const key = at !== undefined ? instanceKey(id, at) : id;
  const hit = memo.get(key);
  if (hit) return hit;
  const d = deriveFeatureUncached(model, id, inFlight, memo, at);
  if (!d.contact) memo.set(key, d);
  return d;
}

function deriveFeatureUncached(
  model: Model,
  id: ElementId,
  inFlight: InFlight,
  memo: DerivationMemo,
  at?: ElementId,
): FeatureDerivation {
  const feat = model.get(id);
  if (!feat) return claimOnly('unknown', 'unresolved');

  // A value that contradicts a BINDING it redefines is no value of the
  // feature's: the model states both, and no surface reads either.
  const binding = passOf(model, memo).definitions.contradiction(feat);
  if (binding) return claimOnly('unknown', 'contradiction', contradictionSentence(model, feat, binding));

  // A `default` a binding overrides is no value of the feature's: the binding
  // gives it one (statedValueOf), and the literal written is not read.
  const literal = defaultGivesWay(model, feat) ? undefined : evaluateQuantity(model, id);
  if (literal) return { claim: 'literal', q: literal };

  // A redefinition that states nothing, in a context that changes what the
  // value it redefines reads: that value, read there.
  if (at === undefined) {
    const inherited = passOf(model, memo).definitions.redefinedValueOf(feat);
    if (inherited) return deriveFeature(model, inherited.target.id, inFlight, memo, inherited.at);
  }

  const raw = statedValueOf(model, feat);
  // A boolean feature is a legitimate operand of `and`/`or`/`not` in a body
  // (`armed and mtow <= 25.0 [kg]`); it is not a quantity, but it is a value.
  if (typeof raw === 'boolean') return { claim: 'unknown', b: raw };
  if (typeof raw !== 'string' || raw.trim() === '') return claimOnly('unknown', 'unresolved');
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return claimOnly('unknown', 'not-quantity');
  }
  const flight = at !== undefined ? instanceKey(id, at) : id;
  if (inFlight.has(flight)) return backTo(model, flight, inFlight);

  let node: QNode;
  try {
    node = new QParser(lexQ(s)).parse();
  } catch {
    return claimOnly('unknown', 'parse');
  }
  // A value that reads a name the feature declares itself, which its owner's
  // scope — or the scope it is read in — answers with another feature, is
  // read by no surface.
  const reading = at !== undefined ? { ...feat, ownerId: at } : feat;
  const shadowed = shadowedNamesOf(model, reading, quantityRefsIn(s) ?? []);
  if (shadowed.length > 0) return claimOnly('unknown', 'shadowed', shadowedSentence(model, reading, shadowed));

  inFlight.set(flight, undefined);
  const reads: Reads = { depth: 0 };
  let r: QEval;
  try {
    const where = at ?? feat.ownerId;
    const owner: QScope = where != null ? quantityScopeFor(model, where, inFlight, memo, reads) : () => undefined;
    r = evalQ(node, owner, EXACT, memo.everyPath === true);
  } finally {
    inFlight.delete(flight);
  }
  const nested = measured(reads);
  if (isQUnknown(r)) return { ...claimOnly('unknown', r.reason, r.detail, r.message), ...nested, ...causedBy(reads) };
  if (!('q' in r)) return { claim: 'unknown', b: r.b, ...nested };

  // A unit beside an expression value (`= (1 + 2) [m]`) is the spec's `'['`
  // applied to the whole derivation: legal on a dimensionless result only.
  let q = r.q;
  const unit = unitOfFeature(feat);
  if (unit) {
    const withUnit = applyUnit({ q }, unit);
    if (isQUnknown(withUnit)) return { ...claimOnly('unknown', withUnit.reason, withUnit.detail), ...nested };
    q = (withUnit as { q: Quantity }).q;
  }
  // An offset-scale value can only reach here through a plain reference
  // (`t3 : TemperatureValue = t1`, arithmetic on one already answered
  // `offset`), and a reference IS the same point on the scale: it keeps its
  // `absolute` flag, so it may still be ordered and still refuses arithmetic.
  return { ...judgeDerivation(model, id, q), ...nested };
}

/**
 * Judge a derived quantity against the feature's declared kind: the one claim
 * check both a value expression and a defining equation go through.
 */
function judgeDerivation(model: Model, id: ElementId, q: Quantity): FeatureDerivation {
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

/**
 * The derivation of a feature that STATES no value but is fixed by an
 * equation beside it — the CV-17 shape, `attribute e : DurationValue;
 * assert constraint { e == c / p }` — as a quantity: the defining side
 * evaluated in the feature's owner scope, then judged against the declared
 * kind exactly as a value expression is. The scalar scope reads that side
 * unit-blind (`640 [Wh] / 650 [W]` is 0.9846, hours to no one), so a caller
 * that needs the feature as a QUANTITY asks here, never labels the scalar
 * with the kind's dimension. `equation` is the defining constraint's body;
 * a body that is not `name == <expr>` (either way round) answers `unresolved`.
 * `contextId` is where the equation is written, when that is not the
 * feature's owner: a feature a definition inherits, fixed by an equation in
 * the definition that inherits it, is derived from the names THERE.
 *
 * An input the defining side reads that is itself fixed by an asserted
 * equation is derived the same way, transitively ({@link definedQuantity}):
 * `e == capacity2 / power` beside `capacity2 == capacity * 2.0` is 7089.23 s.
 * The scalar scope always read such a chain, and the quantity scope did not,
 * so the dimensioned feature had no quantity at all and was refused — on the
 * same-package path and the per-layer one alike — while a unitless chain was
 * read by its scalar. A link that is refused refuses the whole chain, with its
 * own reason; a loop is refused naming every link of it.
 */
export function equationDerivation(
  model: Model,
  featureId: ElementId,
  equation: string,
  memo: DerivationMemo = new Map(),
  contextId?: ElementId,
): FeatureDerivation {
  const feat = model.get(featureId);
  const name = feat ? passOf(model, memo).definitions.nameOf(feat) : undefined;
  const context = contextId ?? feat?.ownerId;
  if (!feat || !name || context == null) return claimOnly('unknown', 'unresolved');
  // Through the asserted equation of that body, when it is one: reading it
  // back from an input is then an echo of it, as on any other path.
  const via = passOf(model, memo)
    .definitions.of(context, name)
    .find((c) => c.constraint.attrs.expression === equation)?.constraint.id;
  return deriveByEquation(model, featureId, name, equation, memo, context, new Map([[featureId, via]]));
}

/**
 * The derivation the asserted equations in `contextId` — the feature's owner
 * unless given — give a feature that states no value: through the one the
 * rule both evaluators share picks ({@link chooseDefinition}), so the scalar
 * scope and this one read the same equation as the definition. `site` is
 * where the equations are written, when they are read in `contextId` over its
 * names ({@link DefiningEquations.definitionReadIn}). `undefined` when no
 * asserted equation there may define it.
 */
export function definitionDerivation(
  model: Model,
  featureId: ElementId,
  memo: DerivationMemo = new Map(),
  contextId?: ElementId,
  site?: ElementId,
): FeatureDerivation | undefined {
  const feat = model.get(featureId);
  const name = feat ? passOf(model, memo).definitions.nameOf(feat) : undefined;
  const context = contextId ?? feat?.ownerId;
  if (!feat || !name || context == null) return undefined;
  const candidates = passOf(model, memo).definitions.of(site ?? context, name);
  if (candidates.length === 0) return undefined;
  return definitionOf(model, featureId, name, candidates, memo, context, new Map());
}

/**
 * The features `constraint` DEFINES: of the valueless features of its owner
 * that it may define (an asserted `name == <expr>`, either way round), those
 * whose derivation the shared rule ({@link chooseDefinition}) reads through
 * this equation rather than another beside it. Empty for any other
 * constraint.
 *
 * The solver lane orients such a feature from this equation only. It used to
 * orient a feature from whichever equality reached it first in model order,
 * so a check written above the definition — `constraint { e == 1.0 [h] }`
 * before `assert constraint { e == capacity / power }` — fixed `e` at 3600 s:
 * the check was then satisfied and the definition violated on the numeric
 * surface, while the validation surface said the definition defines
 * `e = 3544.62 [s]` and the check is violated.
 */
export function definitionsOf(model: Model, constraint: ElementRecord, memo: DerivationMemo = new Map()): ElementId[] {
  // Every definition but one whose input is a DESIGN FREEDOM: one with an
  // input nothing fixes (`x == 2.0 ^ y`, `y` declared with no value, no
  // equation and no binding) defines no value yet, and the solver lane solves
  // such a system as a whole — a check beside it (`x == 1024.0`) fixes `x`,
  // and the equation then `y`. Recording it froze `x` for every other
  // equality, and the system did not solve at all.
  //
  // A definition that stopped for ANY OTHER reason is still the definition:
  // a loop (`mass == dry + fuel` beside `fuel == mass * 0.2`), a nest past the
  // cap, a refused input, a name this context reads no value for. Left
  // unrecorded, a plain check fixed the feature instead — `mass == 130.0`
  // made `mass` 130, so the asserted loop read VIOLATED and the check
  // SATISFIED, and `fuel <= 25.5` was violated on the numeric surface while
  // the SMT engine, solving the loop, proved it.
  return featuresDefinedBy(model, constraint, memo).filter(
    ({ derivation }) => answered(derivation) || !stoppedOnFreeInput(model, derivation, constraint.ownerId!, memo),
  ).map(({ id }) => id);
}

/**
 * The valueless features of its owner that `constraint` (an asserted
 * equation) is THE definition of — the one {@link chooseDefinition} reads them
 * through — each with its derivation, whatever that derivation answered.
 * Empty for any other constraint.
 */
export function featuresDefinedBy(
  model: Model,
  constraint: ElementRecord,
  memo: DerivationMemo = new Map(),
): Array<{ id: ElementId; derivation: FeatureDerivation }> {
  if (constraint.ownerId == null || !isAsserted(constraint)) return [];
  const { definitions } = passOf(model, memo);
  const out: Array<{ id: ElementId; derivation: FeatureDerivation }> = [];
  for (const name of namesDefinedBy(constraint)) {
    const feature = definitions.feature(constraint.ownerId, name);
    const candidates = definitions.of(constraint.ownerId, name);
    if (!feature || candidates.length === 0 || out.some((f) => f.id === feature.id)) continue;
    const d = definitionOf(model, feature.id, name, candidates, memo, constraint.ownerId, new Map());
    if (d.definedBy === constraint.id) out.push({ id: feature.id, derivation: d });
  }
  return out;
}

/**
 * Did a definition's derivation stop for want of a FREE INPUT — a valueless
 * feature of `context` with no value, no defining equation and no binding of
 * its own — directly, or through definitions each stopped by one (`w == v *
 * 2.0` over `v == d / t`, `t` free)? That is the one input a check may stand
 * in for ({@link definitionsOf}). An input defined where it is declared and
 * not read here, held by a binding, or not a valueless feature at all, is no
 * design freedom.
 */
function stoppedOnFreeInput(
  model: Model,
  d: FeatureDerivation,
  context: ElementId,
  memo: DerivationMemo,
  seen: Set<ElementId> = new Set(),
): boolean {
  if (d.reason !== 'unresolved' || d.detail === undefined || d.detail.includes('.')) return false;
  const { definitions } = passOf(model, memo);
  const name = d.detail;
  const feature = definitions.feature(context, name);
  if (!feature || seen.has(feature.id)) return false;
  seen.add(feature.id);
  const here = definitions.of(context, name);
  if (here.length > 0) {
    const inner = definitionOf(model, feature.id, name, here, memo, context, new Map());
    return !answered(inner) && stoppedOnFreeInput(model, inner, context, memo, seen);
  }
  if (feature.ownerId != null && feature.ownerId !== context && definitions.of(feature.ownerId, name).length > 0) {
    return false;
  }
  return boundTo(model, feature.id, memo).length === 0;
}

/**
 * {@link definitionDerivation} inside a derivation already in progress
 * (`inFlight` is its stack), memoised when the answer is a fact about the
 * model.
 */
function definitionOf(
  model: Model,
  featureId: ElementId,
  name: string,
  candidates: readonly DefiningEquation[],
  memo: DerivationMemo,
  context: ElementId,
  inFlight: InFlight,
  instance = false,
): FeatureDerivation {
  // A definition written elsewhere and read here, for this context's own
  // value, is in flight under a key of its own (`instanceKey`).
  const flight = instance ? instanceKey(featureId, context) : featureId;
  if (inFlight.has(flight)) return backTo(model, flight, inFlight);
  const key = definitionKey(featureId, context);
  const hit = memo.get(key);
  if (hit) return hit;
  const d = defineUncached(model, featureId, name, candidates, memo, context, inFlight, flight);
  if (!d.contact) memo.set(key, d);
  return d;
}

function defineUncached(
  model: Model,
  featureId: ElementId,
  name: string,
  candidates: readonly DefiningEquation[],
  memo: DerivationMemo,
  context: ElementId,
  inFlight: InFlight,
  flight: ElementId = featureId,
): FeatureDerivation {
  // The guard that keeps a long chain off the end of the stack. It answers
  // past the cap at once, before the nest below is measured — every
  // definition above it is then past the cap too, and answers as a measured
  // one would — and its contact keeps all of them out of the memo.
  if (definitionsInFlight(inFlight) >= MAX_DERIVATION_DEPTH) {
    return { ...claimOnly('unknown', 'depth'), depth: MAX_DERIVATION_DEPTH + 1, contact: GUARD_CONTACT };
  }
  const { chosen, contact, cause } = chooseDefinition(
    inFlight,
    flight,
    candidates,
    (c): FeatureDerivation => {
      // An equation that reads a name its constraint declares itself, which
      // the owner's scope answers with another feature, is a REFUSED
      // definition: the feature reads no value, and is no freedom either.
      const shadowed = shadowedEquation(model, c);
      return {
        ...(shadowed.length > 0
          ? claimOnly('unknown', 'shadowed', shadowedSentence(model, c.constraint, shadowed))
          : deriveByEquation(model, featureId, name, c.constraint.attrs.expression as string, memo, context, inFlight)),
        definedBy: c.constraint.id,
      };
    },
    (d) => ({ answered: answered(d), deep: d.reason === 'depth', contact: d.contact, cause: d.cause }),
  );
  // What every candidate tried met, the chosen one's included.
  const met = { ...(contact ? { contact } : {}), ...(cause ? { cause } : {}) };
  // Every candidate only read an equation back: no definition here.
  if (!chosen) return { ...claimOnly('unknown', 'unresolved'), ...met };
  return { ...chosen, ...met };
}

/** The derivation one equation gives `featureId`, which is in flight through it. */
function deriveByEquation(
  model: Model,
  featureId: ElementId,
  name: string,
  equation: string,
  memo: DerivationMemo,
  context: ElementId,
  inFlight: InFlight,
): FeatureDerivation {
  let node: QNode;
  try {
    node = new QParser(lexQ(equation)).parse();
  } catch {
    return claimOnly('unknown', 'parse');
  }
  if (node.kind !== 'binary' || (node.op !== '==' && node.op !== '=')) return claimOnly('unknown', 'unresolved');
  const isName = (n: QNode): boolean => n.kind === 'ref' && n.path === name;
  const side = isName(node.left) ? node.right : isName(node.right) ? node.left : undefined;
  if (!side) return claimOnly('unknown', 'unresolved');
  const reads: Reads = { depth: 0 };
  const r = evalQ(side, quantityScopeFor(model, context, inFlight, memo, reads), EXACT, memo.everyPath === true);
  const depth = reads.depth + 1;
  const met = reads.contact ? { contact: reads.contact } : {};
  if (depth > MAX_DERIVATION_DEPTH) return { ...claimOnly('unknown', 'depth'), depth, ...met };
  if (isQUnknown(r)) return { ...claimOnly('unknown', r.reason, r.detail, r.message), depth, ...met, ...causedBy(reads) };
  if (!('q' in r)) return { claim: 'unknown', b: r.b, depth, ...met };
  // An EQUATION whose defining side is a point on an offset scale (`t2 == t1`,
  // `t1` in °C) is an equality on that scale, which every surface refuses:
  // the validation surface's scalar reading of the same definition answers
  // `offset` (the equation judged as quantities), and the solver lane refuses
  // to solve it. Read as a definition here, `t2` was a °C point to the gates —
  // refused as derived from a dimension — and valueless to the validation
  // surface. A VALUE that is such a reference is an identity, and keeps the
  // point ({@link deriveFeatureUncached}).
  if (r.q.absolute) return { ...claimOnly('unknown', 'offset', r.q.unit), depth, ...met };
  return { ...judgeDerivation(model, featureId, r.q), depth, ...met };
}

/**
 * The quantity of a name a derivation reads that no stated value answers in
 * `contextId`'s scope, when an asserted equation fixes it — the unit-aware
 * twin of `valueDefinedByEquation` and `valueThroughChain` in {@link
 * ./evaluate-model}, under the one rule both read ({@link chooseDefinition})
 * and for the same names: a valueless feature of the context, defined there
 * or where it inherits the definition from — read there where the context
 * changes nothing it reads, and here, over the context's names, where it does
 * ({@link DefiningEquations.definitionReadIn}) — and a dotted chain to one
 * ({@link DefiningEquations.chainDefinition}). So the
 * two scopes chain through the same equations, and a unitless chain reads the
 * same numbers on both; this one carries the units.
 */
function definedQuantity(
  model: Model,
  contextId: ElementId,
  name: string,
  inFlight: InFlight,
  memo: DerivationMemo,
  reads: Reads,
): QEval | undefined {
  const { definitions } = passOf(model, memo);
  // The definitions written in `site`, read in `at` — over the names there,
  // where that context changes what they read.
  const read = (featureId: ElementId, own: string, site: ElementId, at: ElementId = site): QEval => {
    const d = definitionOf(model, featureId, own, definitions.of(site, own), memo, at, inFlight, at !== site);
    note(reads, d);
    return derivationEval(d, name);
  };
  if (name.includes('.')) {
    const end = definitions.chainDefinition([contextId], name);
    return end ? read(end.feature.id, definitions.nameOf(end.feature)!, end.site, end.at) : undefined;
  }
  const feature = definitions.feature(contextId, name);
  if (!feature) return undefined;
  const candidates = definitions.of(contextId, name);
  if (candidates.length === 0) {
    const inherited = definitions.definitionReadIn(contextId, name);
    if (inherited !== undefined) return read(feature.id, name, inherited.site, inherited.at);
    // No equation: a binding may hold it to a derived value ({@link
    // boundDerivation}) — read where the partner is written, so only where
    // that is every instance's value the context stands for (the guard the
    // scalar twin `boundOf` of ./evaluate-model reads too). Its dimension is
    // every instance's ({@link dimensionsMemo}).
    if (memo.dimensions !== true && !boundPartnerSafe(model, contextId, name, feature.id)) return undefined;
    const bound = boundDerivation(model, feature.id, memo);
    if (!bound) return undefined;
    note(reads, bound);
    return derivationEval(bound, name);
  }
  const d = definitionOf(model, feature.id, name, candidates, memo, contextId, inFlight);
  note(reads, d);
  return derivationEval(d, name);
}

/**
 * The unknown for a derivation that reached `id` again while deriving it. On
 * a LOOP, the features in flight from `id` on, in the order they were
 * entered, ARE the loop — `a → b → a` names every link the author has to
 * break, where the reason alone named one of them. An ECHO — one equation
 * read back ({@link returnTo}) — is no loop the author wrote, and reads as
 * the value it does not have.
 */
function backTo(model: Model, id: ElementId, inFlight: InFlight): FeatureDerivation {
  const contact = returnTo(inFlight, id);
  if (contact.loops.size === 0) return { ...claimOnly('unknown', 'unresolved'), contact, cause: contact };
  const stack = [...inFlight.keys()];
  const loop = [...stack.slice(stack.indexOf(id)), id].map((x) => model.get(baseIdOf(x))?.declaredName ?? '?');
  const message = `${describeReason('cycle', loop[0])}: ${loop.join(' → ')}`;
  return { ...claimOnly('unknown', 'cycle', loop[0], message), contact, cause: contact };
}

/** The {@link DimensionClaim} of a feature's value. */
export function dimensionClaim(model: Model, featureId: ElementId, memo: DerivationMemo = new Map()): DimensionClaim {
  return deriveFeature(model, featureId, new Map(), dimensionsMemo(model, memo)).claim;
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
  return deriveFeature(model, featureId, new Map(), memo);
}

/**
 * The dimension an expression-valued feature derives to, whatever its claim
 * (`undefined` for a literal or an unevaluable derivation) — or, for a feature
 * that states no value, the one the asserted equation defining it derives to
 * ({@link derivationOf}). A constraint that would compare such a feature as a
 * raw magnitude must not.
 */
export function derivedDimensionOf(
  model: Model,
  featureId: ElementId,
  memo: DerivationMemo = new Map(),
): Dimension | undefined {
  return derivationOf(model, featureId, memo)?.derived;
}

/**
 * The derivation a feature's magnitude comes from: its value expression's
 * (a calculation's value body is one), whatever its claim, or — for a feature
 * that states no value — the one the asserted equation defining it in its
 * owner gives it ({@link definitionDerivation}), else the one a binding holds
 * it to ({@link boundDerivation}), when that agrees with its type. `undefined`
 * for a literal, an unevaluable derivation, or a feature with none.
 *
 * The equation half is what lets the solver lane see the dimension the
 * validation surface derives: `attribute e; assert constraint { e == capacity
 * / power }` is 3544.62 s there, and was a plain number to the gates, so its
 * defining equation was solved in raw magnitudes (0.98 — hours to no one) and
 * a bare `e >= 45.0` was judged against that. A chain of such equations is
 * followed exactly as the validation surface follows it. A definition that
 * disagrees with the feature's type is left out: it has no quantity on any
 * surface, and the feature stays the plain number it always was here.
 */
export function derivationOf(
  model: Model,
  featureId: ElementId,
  given: DerivationMemo = new Map(),
): FeatureDerivation | undefined {
  const memo = dimensionsMemo(model, given);
  const own = deriveFeature(model, featureId, new Map(), memo);
  if (own.derived) return own;
  const feat = model.get(featureId);
  if (!feat || hasStatedValue(model, feat)) return undefined;
  const byEquation = definitionDerivation(model, featureId, memo);
  if (byEquation) return byEquation.derived && byEquation.claim !== 'mismatch' ? byEquation : undefined;
  // The dimension alone, which a binding gives every instance alike: no value
  // is read here ({@link dimensionsMemo}).
  const bound = boundDerivation(model, featureId, memo);
  return bound?.derived && bound.claim !== 'mismatch' ? bound : undefined;
}

/**
 * How the validation surface reads one operand's magnitude: through its value
 * expression when it states a value, else through the asserted equation that
 * defines it in its owner (`byDefinition`) — whatever the derivation's claim,
 * a refusal included. `undefined` for a feature that states no value and has
 * no defining equation.
 *
 * {@link derivationOf} answers a narrower question (the dimension a storage
 * scale may use, which a refused definition must not supply); this is the
 * record a gate refuses an operand by.
 */
export function operandDerivation(
  model: Model,
  featureId: ElementId,
  given: DerivationMemo = new Map(),
): { derivation: FeatureDerivation; byDefinition: boolean } | undefined {
  const feat = model.get(featureId);
  if (!feat) return undefined;
  const memo = dimensionsMemo(model, given);
  if (hasStatedValue(model, feat)) {
    return { derivation: deriveFeature(model, featureId, new Map(), memo), byDefinition: false };
  }
  const byEquation = definitionDerivation(model, featureId, memo);
  if (byEquation) return { derivation: byEquation, byDefinition: true };
  // The record a gate refuses the operand by — its dimension and unit, the
  // same in every instance ({@link dimensionsMemo}).
  const bound = boundDerivation(model, featureId, memo);
  return bound ? { derivation: bound, byDefinition: false } : undefined;
}

/**
 * The derivation a feature that states no value and has no defining equation
 * takes from what a BINDING holds it to (`attribute x; bind x = e;`): the first
 * feature of its binding class whose value is a DERIVATION — a value
 * expression or a defining equation — judged against this feature's own type,
 * as a value expression would be. `undefined` when no member's is.
 *
 * The solver lane always solved such an `x`: the binding is the equation `x ==
 * e`. But `x` was a plain number there, so `e`'s 3544.6 s (640 Wh / 650 W)
 * reached it raw, and `x >= 45.0` was judged — and PROVED — against a bare
 * number gate (e) refuses for `e` itself, while the validation surface said
 * `x` has no value at all. With the derivation it carries, `x` is stored in SI
 * on the solver lane, refused against a bare literal on every surface, and
 * judged against a unit literal on every surface (the validation surface binds
 * it the same way).
 *
 * A member whose value is a LITERAL gives none: a binding to `m : MassValue =
 * 5.0 [kg]` copies a stated value, and a plain `x` keeps reading it by the
 * declared-unit contract, as it always has.
 */
export function boundDerivation(
  model: Model,
  featureId: ElementId,
  memo: DerivationMemo = new Map(),
): FeatureDerivation | undefined {
  const feat = model.get(featureId);
  if (!feat || hasStatedValue(model, feat)) return undefined;
  for (const partner of boundTo(model, featureId, memo)) {
    const p = model.get(partner);
    if (!p) continue;
    const d =
      hasStatedValue(model, p) || passOf(model, memo).definitions.redefinedValueOf(p)
        ? deriveFeature(model, partner, new Map(), memo)
        : definitionDerivation(model, partner, memo);
    if (!d || d.claim === 'literal') continue;
    if (d.q && d.derived) return { ...judgeDerivation(model, featureId, d.q), ...(d.depth ? { depth: d.depth } : {}) };
    if (d.q || d.b !== undefined) continue;
    // A partner whose own derivation is refused: so is this reading of it.
    if (isRefusalReason(d.reason)) return { ...claimOnly('unknown', d.reason, d.detail, d.message) };
  }
  return undefined;
}

/** The other members of `featureId`'s binding class, in the order the model states them. */
function boundTo(model: Model, featureId: ElementId, memo: DerivationMemo): ElementId[] {
  const pass = passOf(model, memo);
  if (!pass.bound) {
    const bound = new Map<ElementId, ElementId[]>();
    const join = (a: ElementId, b: ElementId) => {
      const list = bound.get(a);
      if (list) {
        if (!list.includes(b)) list.push(b);
      } else bound.set(a, [b]);
    };
    for (const el of model.all()) {
      if (!isBindingEdge(el)) continue;
      const s = el.source?.[0];
      const t = el.target?.[0];
      if (s === undefined || t === undefined || s === t) continue;
      join(s, t);
      join(t, s);
    }
    // The class, not only the direct partners: `x = y`, `y = e` holds `x` to `e`.
    for (const [id, direct] of bound) {
      const seen = new Set<ElementId>([id]);
      const queue = [...direct];
      const all: ElementId[] = [];
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        all.push(next);
        queue.push(...(bound.get(next) ?? []));
      }
      bound.set(id, all);
    }
    pass.bound = bound;
  }
  return pass.bound.get(featureId) ?? [];
}

/**
 * The sentence an operand whose derivation is REFUSED makes a relation that
 * reads it unknown with, naming the operand as the relation writes it — or
 * `undefined` when the derivation is no refusal.
 *
 * Two readings, one place. A value expression is read by the quantity scope,
 * whose answer {@link derivationEval} words; a feature an asserted equation
 * defines is bound by the validation surface (`readSpecialiser` in
 * {@link ./evaluate-model}), which also refuses a loop, and names the feature
 * itself when the fault is its own. The solver lane and the verification
 * engines refuse the same operands with the same sentence, rather than reading
 * the raw magnitude the validation surface declines to read: `e : Real =
 * capacity / power` against `<= 60.0` was refused there and PROVED by the SMT
 * engine from 0.98.
 */
export function refusalSentence(d: FeatureDerivation, name: string, byDefinition: boolean): string | undefined {
  if (byDefinition) {
    if (!isRefusalReason(d.reason) && d.reason !== 'cycle') return undefined;
    const own =
      (d.reason === 'offset' && d.message === undefined) || (d.reason === 'mismatch' && d.claim === 'mismatch');
    return own
      ? describeReason(d.reason!, name)
      : `"${name}" cannot be derived: ${d.message ?? describeReason(d.reason!, d.detail)}`;
  }
  if (!isRefusalReason(d.reason)) return undefined;
  const r = derivationEval(d, name);
  return isQUnknown(r) ? messageOf(r) : undefined;
}

/**
 * Why the `[unit]` beside the value `(expr) [unit]` of `featureId` may NOT be
 * joined to it as `x == expr * 1.0 [unit]` (`withValueUnit` of
 * ./unit-literals) — the sentence a reader that joins it refuses the value
 * with — or `undefined` when it may: when `expr` is a NUMBER on every path,
 * whatever the inputs the model gives no value and whichever branch a
 * condition takes. `undefined` too for a feature with no such unit.
 *
 * At the model's point first: a value the validation surface refuses is
 * refused in its words (`(cap * 2.0) [GiB]` puts a unit on bits). But a joined
 * equation is read for EVERY value of its free inputs — the SMT engine proves
 * over all of them, the solver solves for them — and the model's point says
 * nothing about those. With `k` valueless, `(cap * k) [GiB]` is merely
 * unresolved there, and joined it read `2^34·k` GiB, which no value of `k`
 * makes the evaluator say: `dbl >= 1000.0 [GiB]` was PROVED from `k >= 1.0`.
 * So the value is also read on every path ({@link everyPathMemo}), and joined
 * only where that reading puts the unit on a number. A refusal there is the
 * sentence; an every-path reading with no quantity at all (a loop, a name that
 * is no feature, a grammar this evaluator does not read) shows no number, and
 * is refused too. `name` is how the caller writes the feature.
 *
 * `at` is the context the value is READ in, where that is not where it is
 * written — a copy of P's `total = (k * 2.0) [GiB]` read for a `p` whose `:>>
 * k = 1.0 [GiB]` overrides a `default` (`DefiningEquations.valueRef`). The
 * join is decided for that reading, never for P's: there `k` is a number,
 * and decided at P the copy was joined as `k * 2.0 * 1 [GiB]` over p's bits
 * — `p.total >= 1000.0 [GiB]` PROVED, and bounded at 2^35 GiB "exactly",
 * where the validation surface says p's total cannot be derived.
 */
export function valueUnitRefusal(
  model: Model,
  featureId: ElementId,
  memo: DerivationMemo = new Map(),
  name?: string,
  at?: ElementId,
): string | undefined {
  const feat = model.get(featureId);
  if (!feat) return undefined;
  const unit = expressionValueUnitOf(feat);
  if (unit === undefined) return undefined;
  const shown = name ?? feat.declaredName ?? '';
  const own =
    at !== undefined && at !== feat.ownerId
      ? deriveFeature(model, featureId, new Map(), memo, at)
      : operandDerivation(model, featureId, memo)?.derivation;
  const atPoint = own !== undefined && isRefusalReason(own.reason) ? refusalSentence(own, shown, false) : undefined;
  if (atPoint !== undefined) return atPoint;
  // Only a unit with a factor is joined: an offset or unknown one leaves the
  // value as it is read bare, and as gated as it always was.
  const u = resolveUnit(unit);
  if (!u || u.offsetSI) return undefined;
  const every = deriveFeature(
    model,
    featureId,
    new Map(),
    everyPathMemo(model, memo),
    at !== undefined && at !== feat.ownerId ? at : undefined,
  );
  if (every.q !== undefined) return undefined;
  const refused = isRefusalReason(every.reason) ? refusalSentence(every, shown, false) : undefined;
  if (refused !== undefined) return refused;
  const r = derivationEval(every, shown);
  return `the [${unit}] beside "${shown}" is not shown to apply to a number on every path: ${
    isQUnknown(r) ? messageOf(r) : 'its value is not a quantity'
  }`;
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
  /**
   * A resolver consulted BEFORE the model scopes: the name denotes this
   * quantity, whatever the constraint's own context says. A target judged
   * through a feature that specialises the measure it names reads that
   * feature's value — including where the context it is written in states a
   * default the specialiser overrides, which `fallback` cannot reach.
   */
  bind?: (name: string) => Quantity | undefined;
  /** Absolute tolerance for `==`/`!=`/comparisons (a solver's, typically). */
  absTol?: number;
  /**
   * The relation reads values a numeric solve produced (`fallback`): within
   * the solve's own tolerance `==`, `<=` and `>=` hold, rather than being
   * left undecided, and a strict ordering or a `!=` stays undecided
   * (`DecideOptions.searched` of ./exact). A caller judging values the model
   * states leaves it unset, and reads them as the validation surface does.
   */
  searched?: boolean;
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

  const inFlight: InFlight = new Map();
  const memo = opts.memo ?? new Map();
  const ownerScope = el.ownerId != null ? quantityScopeFor(model, el.ownerId, inFlight, memo) : undefined;
  const selfScope = quantityScopeFor(model, el.id, inFlight, memo);
  const scope: QScope = (name) => {
    const bound = opts.bind?.(name);
    if (bound !== undefined) return { q: bound };
    const fromOwner = ownerScope?.(name);
    if (fromOwner !== undefined) return fromOwner;
    const fromSelf = selfScope(name);
    if (fromSelf !== undefined) return fromSelf;
    const fb = opts.fallback?.(name);
    return fb === undefined ? undefined : { q: fb };
  };
  const tol: DecideOptions = { absTol: opts.absTol ?? 0, searched: opts.searched === true };

  let r: QEval;
  const sides: Pick<ConstraintQuantityResult, 'lhsSI' | 'rhsSI' | 'dimension'> = {};
  if (node.kind === 'binary' && COMPARISONS.has(node.op)) {
    const l = evalQ(node.left, scope, tol);
    const rr = evalQ(node.right, scope, tol);
    if (!isQUnknown(l) && 'q' in l && !isQUnknown(rr) && 'q' in rr) {
      const ls = siValue(l.q);
      const rs = siValue(rr.q);
      if (ls !== undefined) sides.lhsSI = ls;
      if (rs !== undefined) sides.rhsSI = rs;
      sides.dimension = l.q.dimension;
    }
    r = combineQ(node.op, l, rr, tol);
  } else {
    r = evalQ(node, scope, tol);
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

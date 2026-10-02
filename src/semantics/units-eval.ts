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
  DefiningEquations,
  GUARD_CONTACT,
  MAX_DERIVATION_DEPTH,
  chooseDefinition,
  definitionKey,
  definitionsInFlight,
  isAsserted,
  hasStatedValue,
  mergeContact,
  readsStatedValueIn,
  namesDefinedBy,
  returnTo,
  statedValueOf,
  type Contact,
  type DefiningEquation,
  type InFlight,
} from './defining-equation';
import { isBindingEdge } from './connectors';
import { effectiveFeatures } from './inheritance';
import { resolveQualifiedNameFull } from './resolve-names';
import {
  DIMENSIONLESS,
  dimEqual,
  dimensionOf,
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
export function quantityKindOf(
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
    dimension = dimensionOf(mu.unit) ?? qk.dimension ?? DIMENSIONLESS;
  } else {
    dimension = qk.dimension ?? DIMENSIONLESS;
  }

  const q: Quantity = { magnitude: mu.magnitude, dimension };
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
  | { kind: 'num'; value: number }
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
  | { t: 'num'; v: number }
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
        return { kind: 'num', value: tk.v };
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
 *  - `division-by-zero`.
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
    reason === 'depth'
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
    case 'if': {
      // Only the branch the condition takes is read, as the scalar evaluator
      // reads it.
      const c = evalQ(node.cond, scope, absTol);
      if (isQUnknown(c)) return c;
      if (!('b' in c)) return unknownQ('not-boolean');
      return evalQ(c.b ? node.then : node.else, scope, absTol);
    }
  }
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
  const q: Quantity = { magnitude: inner.q.magnitude, dimension: u.dimension, unit };
  if (u.offsetSI) q.absolute = true;
  return { q };
}

function evalQBinary(node: Extract<QNode, { kind: 'binary' }>, scope: QScope, absTol: number): QEval {
  const op = node.op;

  if (op === 'and' || op === 'or' || op === 'xor' || op === 'implies') {
    // The scalar evaluator's short-circuits ({@link ./expr}): `false and x`,
    // `true or x`, `false implies x` and `x implies true` decide without x.
    const l = evalQ(node.left, scope, absTol);
    if (!isQUnknown(l) && 'b' in l) {
      if (op === 'and' && l.b === false) return { b: false };
      if (op === 'or' && l.b === true) return { b: true };
      if (op === 'implies' && l.b === false) return { b: true };
    }
    const r = evalQ(node.right, scope, absTol);
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

  const l = evalQ(node.left, scope, absTol);
  const r = evalQ(node.right, scope, absTol);
  return combineQ(op, l, r, absTol);
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
function combineQ(op: QBinOp, l: QEval, r: QEval, absTol: number): QEval {
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
      return { q: { magnitude: sa % sb, dimension: a.dimension } };
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
    q: {
      magnitude: divide ? sa / sb : sa * sb,
      dimension: divide ? divideDim(a.dimension, b.dimension) : multiplyDim(a.dimension, b.dimension),
    },
  };
}

/** Add/subtract two quantities; requires equal dimensions, combined in SI. */
function combineAddition(op: '+' | '-', a: Quantity, b: Quantity): QEval {
  if (a.absolute || b.absolute) return unknownQ('offset', a.absolute ? a.unit : b.unit);
  if (!dimEqual(a.dimension, b.dimension)) return dimensionRefusal(a, b);
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
 * ones included: `x < y` holds when `x − y ≤ tol`. Applying the tolerance in
 * the strict direction instead made `0.9999999999 < 1.0` a confident VIOLATED
 * here and satisfied on the numeric surface — a cross-surface disagreement on
 * float noise.
 *
 * That tolerant reading is shared with the numeric surface for `<=` and `>=`
 * (`violated = g > tol`) but NOT for `<` and `>`: where this evaluator declines
 * and both surfaces fall back to raw magnitudes, a strict ordering is read
 * EXACTLY, because the scalar `evaluate` the validation surface falls back to
 * reads it exactly (`mass < 25.0` at 25 kg is violated there). So a tie under a
 * strict ordering is satisfied wherever this function answers and violated
 * where it does not — a known asymmetry between the two PATHS, recorded in
 * docs/AGENT-AUTHORING-CAMPAIGN.md; the two SURFACES agree on each path, which
 * is the property the seam exists to hold.
 */
function compareQ(op: '<' | '<=' | '>' | '>=', a: Quantity, b: Quantity, absTol: number): QEval {
  if (!dimEqual(a.dimension, b.dimension)) return dimensionRefusal(a, b);
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
  return (name: string) => {
    const id = ids.get(name);
    if (id === undefined) return reads ? definedQuantity(model, contextId, name, inFlight, memo, reads) : undefined;
    const d = deriveFeature(model, id, inFlight, memo);
    if (reads) note(reads, d);
    return derivationEval(d, name);
  };
}

/** The name → feature-id map of `contextId`'s quantity scope, built once per pass. */
function quantityIdsOf(model: Model, contextId: ElementId, memo: DerivationMemo): Map<string, ElementId> {
  const pass = passOf(model, memo);
  let ids = pass.ids.get(contextId);
  if (!ids) {
    ids = new Map();
    collectQuantityIds(model, contextId, '', ids, new Set(), new Set(), pass.definitions);
    pass.ids.set(contextId, ids);
  }
  return ids;
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
export type DerivationMemo = Map<ElementId, FeatureDerivation> & { pass?: DerivationPass };

/** What one pass reads of the model once: the defining equations of each context, and its scope's names. */
export interface DerivationPass {
  definitions: DefiningEquations;
  ids: Map<ElementId, Map<string, ElementId>>;
  /** Feature id → the other features a binding connector holds to its value, built on first use. */
  bound?: Map<ElementId, ElementId[]>;
}

function passOf(model: Model, memo: DerivationMemo): DerivationPass {
  if (memo.pass?.definitions.model !== model) memo.pass = { definitions: new DefiningEquations(model), ids: new Map() };
  return memo.pass;
}

function collectQuantityIds(
  model: Model,
  ownerId: ElementId,
  prefix: string,
  ids: Map<string, ElementId>,
  visited: Set<string>,
  onPath: Set<ElementId>,
  definitions: DefiningEquations,
  link?: { usage: ElementRecord; clean: boolean },
): void {
  // TWO guards, because they answer different questions. `onPath` is the CYCLE
  // guard and must be keyed on the owner ALONE: a feature whose type is one of
  // its own owners (`item def Person { timeslice asPresident : Person; }`)
  // generates an unbounded name tower `asPresident.asPresident…`, and a key that
  // carries the prefix never repeats, so it can never see the cycle — it
  // recursed until the stack died. `visited` is only a work bound for a diamond
  // reached twice at the SAME prefix, so it keeps the prefix in its key: two
  // sibling features of one type (`part a : T; part b : T;`) are different
  // scopes and both must be walked.
  if (onPath.has(ownerId)) return;
  const guardKey = `${prefix} ${ownerId}`;
  if (visited.has(guardKey)) return;
  visited.add(guardKey);
  onPath.add(ownerId);

  for (const feat of effectiveFeatures(model, ownerId)) {
    const name = feat.declaredName;
    if (!name) continue;
    const full = prefix ? `${prefix}.${name}` : name;
    if (readsStatedValueIn(model, feat, ownerId, prefix, definitions, link)) {
      if (!ids.has(full)) ids.set(full, feat.id);
      if (!ids.has(name)) ids.set(name, feat.id); // bare-name convenience
    }
    // Through `feat`, as the scalar scope walks it (`collectIds` of ./evaluate-model).
    const clean = link === undefined || (link.clean && definitions.linkReads(link.usage, feat));
    for (const type of model.typesOf(feat.id)) {
      collectQuantityIds(model, type.id, full, ids, visited, onPath, definitions, { usage: feat, clean });
    }
  }

  onPath.delete(ownerId);
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
 * feature's owner scope — and judge its dimension claim. This is the single
 * place the guard lives: the scope, the `derived-dimension-mismatch` rule and
 * the scalar-fallback refusal all read the same record.
 */
function deriveFeature(
  model: Model,
  id: ElementId,
  inFlight: InFlight,
  memo: DerivationMemo,
): FeatureDerivation {
  const hit = memo.get(id);
  if (hit) return hit;
  const d = deriveFeatureUncached(model, id, inFlight, memo);
  if (!d.contact) memo.set(id, d);
  return d;
}

function deriveFeatureUncached(
  model: Model,
  id: ElementId,
  inFlight: InFlight,
  memo: DerivationMemo,
): FeatureDerivation {
  const feat = model.get(id);
  if (!feat) return claimOnly('unknown', 'unresolved');

  const literal = evaluateQuantity(model, id);
  if (literal) return { claim: 'literal', q: literal };

  const raw = statedValueOf(model, feat);
  // A boolean feature is a legitimate operand of `and`/`or`/`not` in a body
  // (`armed and mtow <= 25.0 [kg]`); it is not a quantity, but it is a value.
  if (typeof raw === 'boolean') return { claim: 'unknown', b: raw };
  if (typeof raw !== 'string' || raw.trim() === '') return claimOnly('unknown', 'unresolved');
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return claimOnly('unknown', 'not-quantity');
  }
  if (inFlight.has(id)) return backTo(model, id, inFlight);

  let node: QNode;
  try {
    node = new QParser(lexQ(s)).parse();
  } catch {
    return claimOnly('unknown', 'parse');
  }

  inFlight.set(id, undefined);
  const reads: Reads = { depth: 0 };
  let r: QEval;
  try {
    const owner: QScope =
      feat.ownerId != null ? quantityScopeFor(model, feat.ownerId, inFlight, memo, reads) : () => undefined;
    r = evalQ(node, owner, 0);
  } finally {
    inFlight.delete(id);
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
  const name = feat?.declaredName;
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
 * scope and this one read the same equation as the definition. `undefined`
 * when no asserted equation there may define it.
 */
export function definitionDerivation(
  model: Model,
  featureId: ElementId,
  memo: DerivationMemo = new Map(),
  contextId?: ElementId,
): FeatureDerivation | undefined {
  const feat = model.get(featureId);
  const name = feat?.declaredName;
  const context = contextId ?? feat?.ownerId;
  if (!feat || !name || context == null) return undefined;
  const candidates = passOf(model, memo).definitions.of(context, name);
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
): FeatureDerivation {
  if (inFlight.has(featureId)) return backTo(model, featureId, inFlight);
  const key = definitionKey(featureId, context);
  const hit = memo.get(key);
  if (hit) return hit;
  const d = defineUncached(model, featureId, name, candidates, memo, context, inFlight);
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
    featureId,
    candidates,
    (c): FeatureDerivation => ({
      ...deriveByEquation(model, featureId, name, c.constraint.attrs.expression as string, memo, context, inFlight),
      definedBy: c.constraint.id,
    }),
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
  const r = evalQ(side, quantityScopeFor(model, context, inFlight, memo, reads), 0);
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
 * or — where the context changes nothing it reads — where it inherits the
 * definition from ({@link DefiningEquations.inheritedSite}), and a dotted
 * chain to one the chain reads ({@link DefiningEquations.chainSite}). So the
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
  const read = (featureId: ElementId, own: string, site: ElementId): QEval => {
    const d = definitionOf(model, featureId, own, definitions.of(site, own), memo, site, inFlight);
    note(reads, d);
    return derivationEval(d, name);
  };
  if (name.includes('.')) {
    const end = definitions.chainSite([contextId], name);
    return end ? read(end.feature.id, end.feature.declaredName!, end.site) : undefined;
  }
  const feature = definitions.feature(contextId, name);
  if (!feature) return undefined;
  const candidates = definitions.of(contextId, name);
  if (candidates.length === 0) {
    const site = definitions.inheritedSite(contextId, name);
    if (site !== undefined) return read(feature.id, name, site);
    // No equation: a binding may hold it to a derived value ({@link boundDerivation}).
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
  const loop = [...stack.slice(stack.indexOf(id)), id].map((x) => model.get(x)?.declaredName ?? '?');
  const message = `${describeReason('cycle', loop[0])}: ${loop.join(' → ')}`;
  return { ...claimOnly('unknown', 'cycle', loop[0], message), contact, cause: contact };
}

/** The {@link DimensionClaim} of a feature's value. */
export function dimensionClaim(model: Model, featureId: ElementId, memo: DerivationMemo = new Map()): DimensionClaim {
  return deriveFeature(model, featureId, new Map(), memo).claim;
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
  memo: DerivationMemo = new Map(),
): FeatureDerivation | undefined {
  const own = deriveFeature(model, featureId, new Map(), memo);
  if (own.derived) return own;
  const feat = model.get(featureId);
  if (!feat || hasStatedValue(model, feat)) return undefined;
  const byEquation = definitionDerivation(model, featureId, memo);
  if (byEquation) return byEquation.derived && byEquation.claim !== 'mismatch' ? byEquation : undefined;
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
  memo: DerivationMemo = new Map(),
): { derivation: FeatureDerivation; byDefinition: boolean } | undefined {
  const feat = model.get(featureId);
  if (!feat) return undefined;
  if (hasStatedValue(model, feat)) {
    return { derivation: deriveFeature(model, featureId, new Map(), memo), byDefinition: false };
  }
  const byEquation = definitionDerivation(model, featureId, memo);
  if (byEquation) return { derivation: byEquation, byDefinition: true };
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
    const d = hasStatedValue(model, p) ? deriveFeature(model, partner, new Map(), memo) : definitionDerivation(model, partner, memo);
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

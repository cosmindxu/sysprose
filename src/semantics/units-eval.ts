/**
 * Unit-aware model evaluation.
 *
 * Where {@link ./evaluate-model} folds feature values to bare scalars, this
 * module folds them to *quantities* — a magnitude paired with a physical
 * {@link Dimension} (and, when known, the unit the magnitude is expressed in).
 * It layers three capabilities on top of the {@link ./units} engine:
 *
 *  1. {@link evaluateQuantity} — read a single feature's value as a quantity,
 *     deriving its dimension from the value's unit (`[kg]` in a string value,
 *     `attrs.unit`, or a unit-valued `attrs.multiplicity` as the parser stores a
 *     trailing `[kg]`) and/or from an ISQ quantity-kind typing.
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
 *     conversion. Used by {@link ./evaluate-model}.checkConstraints as a
 *     fallback for expressions the scalar evaluator cannot handle (i.e. those
 *     carrying unit literals), leaving the backward-compatible scalar path
 *     otherwise untouched.
 */

import type { AttrValue, ElementId, ElementRecord, Model } from '@core/index';
import { effectiveFeatures } from './inheritance';
import {
  DIMENSIONLESS,
  dimEqual,
  dimensionOf,
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
}

/** Read an attribute as a string, or undefined when absent/non-string. */
function asString(v: AttrValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Resolve a unit reference (long name or symbol) to a registry {@link Unit}. */
function resolveUnit(name: string): Unit | undefined {
  return unitByName(name) ?? unitBySymbol(name);
}

/** True when `name` is a unit known to the registry (so a unit, not e.g. `1..*`). */
function isKnownUnit(name: string): boolean {
  return resolveUnit(name) !== undefined;
}

/**
 * The SI value of a quantity: `magnitude · factorToSI + offsetSI` when a unit is
 * set, else the magnitude verbatim (already assumed SI-coherent). Returns
 * `undefined` for an unresolvable unit.
 */
function siValue(q: Quantity): number | undefined {
  if (q.unit === undefined) return q.magnitude;
  const u = resolveUnit(q.unit);
  if (!u) return undefined;
  return q.magnitude * u.factorToSI + (u.offsetSI ?? 0);
}

/* ─────────────────────── Feature → Quantity extraction ───────────────────── */

/** Parse a magnitude + optional bracketed unit from a value literal. */
const MAGNITUDE_UNIT_RE =
  /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(?:\[\s*([^\]]+?)\s*\])?$/;

/** Extract `{ magnitude, unit? }` from a feature's value/unit attributes. */
function magnitudeAndUnit(el: ElementRecord): { magnitude: number; unit?: string } | undefined {
  const raw = el.attrs.value;
  let magnitude: number | undefined;
  let unit: string | undefined;

  if (typeof raw === 'number') {
    magnitude = raw;
  } else if (typeof raw === 'string') {
    const m = raw.trim().match(MAGNITUDE_UNIT_RE);
    if (m) {
      magnitude = Number(m[1]);
      if (m[2]) unit = m[2].trim();
    }
  }
  if (magnitude === undefined || !Number.isFinite(magnitude)) return undefined;

  // Unit sources in priority order: an inline `[unit]`, then an explicit
  // `attrs.unit`, then a `attrs.multiplicity` that names a known unit (the
  // textual parser stores a trailing `= 1500 [kg]` unit as the multiplicity).
  if (!unit) {
    const attrUnit = asString(el.attrs.unit);
    if (attrUnit && attrUnit.trim() !== '') unit = attrUnit.trim();
  }
  if (!unit) {
    const mult = asString(el.attrs.multiplicity);
    if (mult && isKnownUnit(mult.trim())) unit = mult.trim();
  }
  return unit ? { magnitude, unit } : { magnitude };
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
    const tel = t ? model.get(t) : undefined;
    if (!tel) continue;
    const d = quantityKindDimension(model, tel.id);
    if (d) return { dimension: d, name: tel.declaredName };
  }

  const name = asString(el.attrs.type) ?? asString(el.attrs.typeRef);
  if (name && name.trim() !== '') {
    const d = quantityKindDimension(model, name);
    if (d) return { dimension: d, name };
  }
  return {};
}

/**
 * Evaluate a feature's value as a {@link Quantity}: its magnitude, its physical
 * dimension, and (when known) the unit the magnitude is expressed in.
 *
 * The dimension is taken from the value's unit when one is present and
 * recognised; otherwise from the feature's ISQ quantity-kind typing; otherwise
 * the value is treated as dimensionless. Returns `undefined` when the feature
 * carries no numeric value at all.
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
  if (mu.unit) q.unit = mu.unit;
  return q;
}

/**
 * The unit and quantity-kind dimensions of a feature, for consistency checks:
 * `unitDimension` is derived from the value's unit (when any), `kindDimension`
 * from the feature's ISQ quantity-kind typing (when any), plus the kind name.
 */
export function dimensionalFacets(
  model: Model,
  featureId: ElementId,
): { unit?: string; unitDimension?: Dimension; kindDimension?: Dimension; kindName?: string } {
  const el = model.get(featureId);
  if (!el) return {};
  const mu = magnitudeAndUnit(el);
  const qk = quantityKindOf(model, featureId);
  const out: {
    unit?: string;
    unitDimension?: Dimension;
    kindDimension?: Dimension;
    kindName?: string;
  } = {};
  if (mu?.unit) {
    out.unit = mu.unit;
    out.unitDimension = dimensionOf(mu.unit);
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
      default:
        throw new SyntaxError('Unexpected token');
    }
  }
}

type QScope = (name: string) => Quantity | undefined;
type QEval = { q: Quantity } | { b: boolean } | { unknown: true };
const Q_UNKNOWN: QEval = { unknown: true };
const isQUnknown = (r: QEval): r is { unknown: true } => 'unknown' in r;

function evalQ(node: QNode, scope: QScope): QEval {
  switch (node.kind) {
    case 'num':
      return { q: { magnitude: node.value, dimension: DIMENSIONLESS } };
    case 'bool':
      return { b: node.value };
    case 'ref': {
      const q = scope(node.path);
      return q === undefined ? Q_UNKNOWN : { q };
    }
    case 'unit': {
      const inner = evalQ(node.operand, scope);
      if (isQUnknown(inner) || 'b' in inner) return Q_UNKNOWN;
      const d = dimensionOf(node.unit);
      // Attach the unit; a bare number takes the unit's dimension.
      return {
        q: {
          magnitude: inner.q.magnitude,
          dimension: d ?? inner.q.dimension,
          unit: node.unit,
        },
      };
    }
    case 'unary': {
      const r = evalQ(node.operand, scope);
      if (isQUnknown(r)) return Q_UNKNOWN;
      if (node.op === 'not') return 'b' in r ? { b: !r.b } : Q_UNKNOWN;
      if ('q' in r) {
        return { q: { ...r.q, magnitude: node.op === '-' ? -r.q.magnitude : +r.q.magnitude } };
      }
      return Q_UNKNOWN;
    }
    case 'binary':
      return evalQBinary(node, scope);
  }
}

function evalQBinary(node: Extract<QNode, { kind: 'binary' }>, scope: QScope): QEval {
  const op = node.op;

  if (op === 'and' || op === 'or') {
    const l = evalQ(node.left, scope);
    if (!isQUnknown(l) && 'b' in l) {
      if (op === 'and' && l.b === false) return { b: false };
      if (op === 'or' && l.b === true) return { b: true };
    }
    const r = evalQ(node.right, scope);
    if (isQUnknown(l) || isQUnknown(r) || !('b' in l) || !('b' in r)) return Q_UNKNOWN;
    return { b: op === 'and' ? l.b && r.b : l.b || r.b };
  }

  const l = evalQ(node.left, scope);
  const r = evalQ(node.right, scope);
  if (isQUnknown(l) || isQUnknown(r) || !('q' in l) || !('q' in r)) return Q_UNKNOWN;
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
      const sa = siValue(a);
      const sb = siValue(b);
      if (sa === undefined || sb === undefined || !dimEqual(a.dimension, b.dimension)) return Q_UNKNOWN;
      return { q: { magnitude: sa % sb, dimension: a.dimension } };
    }
    case '^': {
      const sa = siValue(a);
      const exp = siValue(b);
      if (sa === undefined || exp === undefined || !dimEqual(b.dimension, DIMENSIONLESS)) return Q_UNKNOWN;
      return { q: { magnitude: sa ** exp, dimension: powDim(a.dimension, exp) } };
    }
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compareQ(op, a, b);
    case '=':
    case '==':
    case '!=': {
      const eq = op === '==' || op === '=';
      if (!dimEqual(a.dimension, b.dimension)) return { b: !eq };
      const sa = siValue(a);
      const sb = siValue(b);
      if (sa === undefined || sb === undefined) return Q_UNKNOWN;
      return { b: eq ? sa === sb : sa !== sb };
    }
  }
  return Q_UNKNOWN;
}

/** Multiply (or divide) two quantities, propagating dimensions; result in SI. */
function combineProduct(a: Quantity, b: Quantity, divide: boolean): QEval {
  const sa = siValue(a);
  const sb = siValue(b);
  if (sa === undefined || sb === undefined) return Q_UNKNOWN;
  if (divide && sb === 0) return Q_UNKNOWN;
  return {
    q: {
      magnitude: divide ? sa / sb : sa * sb,
      dimension: divide ? divideDim(a.dimension, b.dimension) : multiplyDim(a.dimension, b.dimension),
    },
  };
}

/** Add/subtract two quantities; requires equal dimensions, combined in SI. */
function combineAddition(op: '+' | '-', a: Quantity, b: Quantity): QEval {
  if (!dimEqual(a.dimension, b.dimension)) return Q_UNKNOWN;
  const sa = siValue(a);
  const sb = siValue(b);
  if (sa === undefined || sb === undefined) return Q_UNKNOWN;
  return { q: { magnitude: op === '+' ? sa + sb : sa - sb, dimension: a.dimension } };
}

/** Ordered comparison; requires equal dimensions, compared in SI. */
function compareQ(op: '<' | '<=' | '>' | '>=', a: Quantity, b: Quantity): QEval {
  if (!dimEqual(a.dimension, b.dimension)) return Q_UNKNOWN;
  const x = siValue(a);
  const y = siValue(b);
  if (x === undefined || y === undefined) return Q_UNKNOWN;
  switch (op) {
    case '<':
      return { b: x < y };
    case '<=':
      return { b: x <= y };
    case '>':
      return { b: x > y };
    case '>=':
      return { b: x >= y };
  }
  return Q_UNKNOWN;
}

/* ─────────────────────────── Quantity scopes ────────────────────────────── */

/** Build a name → {@link Quantity} resolver rooted at `contextId`. */
function quantityScopeFor(model: Model, contextId: ElementId): QScope {
  const map = new Map<string, Quantity>();
  collectQuantities(model, contextId, '', map, new Set());
  return (name: string) => map.get(name);
}

function collectQuantities(
  model: Model,
  ownerId: ElementId,
  prefix: string,
  map: Map<string, Quantity>,
  visited: Set<string>,
): void {
  const guardKey = `${prefix} ${ownerId}`;
  if (visited.has(guardKey)) return;
  visited.add(guardKey);

  for (const feat of effectiveFeatures(model, ownerId)) {
    const name = feat.declaredName;
    if (!name) continue;
    const full = prefix ? `${prefix}.${name}` : name;
    const q = evaluateQuantity(model, feat.id);
    if (q) {
      if (!map.has(full)) map.set(full, q);
      if (!map.has(name)) map.set(name, q);
    }
    for (const type of model.typesOf(feat.id)) {
      collectQuantities(model, type.id, full, map, visited);
    }
  }
}

/**
 * Evaluate a constraint/requirement boolean expression with the unit-aware
 * evaluator, classifying it as `satisfied` / `violated` / `unknown`. Scope is
 * built from the constraint's owner (subject context) merged with itself.
 * Returns `unknown` when the expression is absent, unparseable, or does not
 * fold to a boolean (e.g. a needed value or unit is missing/incompatible).
 */
export function evaluateConstraintQuantity(
  model: Model,
  el: ElementRecord,
): 'satisfied' | 'violated' | 'unknown' {
  const expr = el.attrs.expression;
  if (typeof expr !== 'string' || expr.trim() === '') return 'unknown';

  let node: QNode;
  try {
    node = new QParser(lexQ(expr)).parse();
  } catch {
    return 'unknown';
  }

  const ownerScope = el.ownerId != null ? quantityScopeFor(model, el.ownerId) : undefined;
  const selfScope = quantityScopeFor(model, el.id);
  const scope: QScope = (name) => ownerScope?.(name) ?? selfScope(name);

  const r = evalQ(node, scope);
  if (isQUnknown(r) || !('b' in r)) return 'unknown';
  return r.b ? 'satisfied' : 'violated';
}

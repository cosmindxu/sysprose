/**
 * Exact decimal arithmetic for the comparisons the point evaluators publish:
 * THE TIE RULE.
 *
 * Every point evaluator — the validation surface (`checkConstraints` of
 * ./evaluate-model), the literal engine that wraps it, the numeric surface of
 * ./solver, and the gates that re-read a solver's witness — computes a
 * relation's two sides in binary64. The SMT engine reads the same relation
 * over the decimals the author wrote, exactly (`numeral` of ./smt/encode). In
 * the last bits the two disagree, and a tolerance that read every near tie as a
 * tie only moved the disagreement: `0.1 + 0.2 > 0.3` was satisfied on the
 * point surfaces beside a solver that refutes it, `x < 25.0` at 25 held, and a
 * strict reading of the band would REFUTE `1.0 + 0.00000000000000001 > 1.0` —
 * true of the numbers written, a tie only to binary64, which absorbs the
 * difference.
 *
 * So a comparison is decided by the numbers written wherever they can be
 * computed. Each operand carries, beside its double, the exact rational of the
 * decimals that produced it: a numeral is the decimal it is written as (the
 * encoder's own reading, {@link numeralRational}), a unit's factor and origin
 * the numbers the registry defines (`scaleRational` of ./smt/encode), and
 * `+ − × ÷`, a remainder and an integer power are computed exactly. Where both
 * sides have one, the comparison is that of the rationals
 * ({@link decideComparison}): `0.1 + 0.2 > 0.3` is false, `x < 25.0` at 25 is
 * false, `1.0e16 + 1.0 > 1.0e16` is true, and `0.9999999999 < 1.0` is true.
 *
 * Where one side has none — a fractional power, a value a numeric solve or
 * search produced — the doubles decide, outside the relative tolerance
 * {@link REL_TOL}. Inside it they cannot. A caller reading a solver's values
 * (`searched`) takes the solve's own tolerance, within which the two sides are
 * EQUAL as far as the solve knows: `==`, `<=` and `>=` hold, as the solve
 * claims of its own equations. A strict ordering and a `!=` turn on the very
 * difference that tolerance hides, so they, and every in-band comparison no
 * exact reading decides, are UNDECIDED — `undefined` here, `unknown` on the
 * surfaces, which abstain in both directions rather than publish what the
 * band cannot tell.
 *
 * Two readings are binary64 by definition, as they are in the encoder: a
 * numeral written with more than fifteen significant digits (`DOUBLE_DIGITS`
 * of ./expr) is the double it parses to, and a unit factor that is no decimal
 * the registry wrote and no small ratio (the hartley and the nat, whose
 * factors are logarithms) is that double's own rational.
 */

import { type ExprNode } from './expr';
import { decimalRational, numeralRational, scaleRational, type Rational } from './smt/encode';
import { resolveUnit, type FactorTerm } from './units';

export type { Rational };

/**
 * The relative tolerance within which two doubles are a TIE, the band the
 * doubles alone cannot decide: `|x − y| ≤ max(absTol, 1e-9 · max(|x|, |y|))`.
 * Far below anything a model states, far above the noise binary64 adds to a
 * registry factor or a chain of arithmetic.
 */
export const REL_TOL = 1e-9;

/** The comparison operators a relation body writes. */
export type ComparisonOperator = '<' | '<=' | '>' | '>=' | '==' | '=' | '!=';

/** How a comparison reads two sides no exact reading decides ({@link decideComparison}). */
export interface DecideOptions {
  /** An absolute tolerance beside the relative one — a solver's, for its own values. */
  absTol?: number;
  /**
   * The sides read values a numeric solve or search produced, known only to
   * its tolerance: within it `==`, `<=` and `>=` hold, which is all the solve
   * claims of them, and a strict ordering or a `!=` is undecided — it turns
   * on the difference the tolerance hides (`x < 0.1` at a solved
   * 0.0999999966…, true, was read as a tie and violated). Absent, every tie
   * no exact reading decides is undecided.
   */
  searched?: boolean;
}

/** One comparison no exact reading decided, for the sentence that says so. */
export interface Tie {
  op: ComparisonOperator;
  x: number;
  y: number;
  /** An operand is a value a solve produced (`DecideOptions.searched`), known only to its tolerance. */
  solved?: boolean;
}

/* ───────────────────────────── rationals ──────────────────────────────── */

/**
 * Past this magnitude a numerator or denominator is not carried: the reading
 * is abandoned (`undefined`), never rounded — a rounded "exact" value would
 * decide a tie it does not know, while an abandoned one leaves the doubles to
 * decide outside the band and nothing to decide inside it. 2^1024 is past the
 * largest double and some three hundred decimal digits of denominator:
 * beyond any comparison a model writes, reached only by a long chain of
 * arithmetic or a large integer power. The cost of an operation grows with
 * the square of the size, so a larger limit bought nothing but time: at 2^4096
 * a 400-step chain of `x * 1.0001 + 0.0003` took 129 ms to validate where 6 ms
 * had done.
 */
const LIMIT_BITS = 1024;
const LIMIT = 1n << BigInt(LIMIT_BITS);

/** The largest integer exponent read exactly. */
const MAX_POWER = 4096;

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/** The hexadecimal digits of the larger part of `r`. */
function hexDigits(r: Rational): number {
  const num = abs(r.num);
  return (num > r.den ? num : r.den).toString(16).length;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** `num / den` in lowest terms with `den > 0`, or `undefined` for a zero denominator or past {@link LIMIT}. */
function rational(num: bigint, den: bigint): Rational | undefined {
  if (den === 0n) return undefined;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(abs(num), den);
  if (g > 1n) {
    num /= g;
    den /= g;
  }
  if (abs(num) >= LIMIT || den >= LIMIT) return undefined;
  return { num, den };
}

/**
 * A reading the encoder supplies — a decimal, a unit's factor — in lowest
 * terms, which the operations below keep their results in. Never abandoned:
 * the number is the one written, however long.
 */
function lowest(r: Rational): Rational {
  const g = gcd(abs(r.num), r.den);
  return g > 1n ? { num: r.num / g, den: r.den / g } : r;
}

/** `num / den`, `den > 0`, already in lowest terms — or `undefined` past {@link LIMIT}. */
function bounded(num: bigint, den: bigint): Rational | undefined {
  if (num === 0n) return { num: 0n, den: 1n };
  if (abs(num) >= LIMIT || den >= LIMIT) return undefined;
  return { num, den };
}

/*
 * The four operations reduce as they go, by Knuth's method (TAOCP §4.5.1):
 * the gcds are taken of a denominator and a factor of one, never of the whole
 * products. Over decimals one side of each is a power of ten or a small
 * number, so Euclid ends in a step or two, where reducing the product cost a
 * gcd of two numbers the size of the result at every operation. From operands
 * in lowest terms the result is in lowest terms; from any others it is still
 * the exact value.
 */

export function addRationals(a: Rational, b: Rational): Rational | undefined {
  const d1 = gcd(a.den, b.den);
  if (d1 === 1n) return bounded(a.num * b.den + b.num * a.den, a.den * b.den);
  const t = a.num * (b.den / d1) + b.num * (a.den / d1);
  const d2 = gcd(abs(t), d1);
  return bounded(t / d2, (a.den / d1) * (b.den / d2));
}

export function subtractRationals(a: Rational, b: Rational): Rational | undefined {
  return addRationals(a, negateRational(b));
}

export function multiplyRationals(a: Rational, b: Rational): Rational | undefined {
  if (a.num === 0n || b.num === 0n) return { num: 0n, den: 1n };
  const d1 = gcd(abs(a.num), b.den);
  const d2 = gcd(abs(b.num), a.den);
  return bounded((a.num / d1) * (b.num / d2), (a.den / d2) * (b.den / d1));
}

/** `a / b`, or `undefined` for a zero divisor. */
export function divideRationals(a: Rational, b: Rational): Rational | undefined {
  if (b.num === 0n) return undefined;
  return multiplyRationals(a, b.num < 0n ? { num: -b.den, den: -b.num } : { num: b.den, den: b.num });
}

export function negateRational(a: Rational): Rational {
  return { num: -a.num, den: a.den };
}

/** `a % b` as binary64 computes it — the sign of the dividend, the quotient truncated — or `undefined` for a zero divisor. */
export function remainderRational(a: Rational, b: Rational): Rational | undefined {
  if (b.num === 0n) return undefined;
  // BigInt division truncates toward zero, as `%` on doubles does.
  const quotient = (a.num * b.den) / (a.den * b.num);
  const taken = multiplyRationals(b, { num: quotient, den: 1n });
  return taken && subtractRationals(a, taken);
}

/**
 * `base ^ exponent` for an INTEGER exponent of at most {@link MAX_POWER} in
 * size, else `undefined`: a fractional power is no rational in general, and
 * exact arithmetic does not follow it.
 */
export function powerRational(base: Rational, exponent: Rational): Rational | undefined {
  if (exponent.den !== 1n) return undefined;
  const n = exponent.num;
  if (n > BigInt(MAX_POWER) || n < -BigInt(MAX_POWER)) return undefined;
  if (n < 0n && base.num === 0n) return undefined;
  if (n === 0n) return { num: 1n, den: 1n };
  const lowest = rational(base.num, base.den);
  if (lowest === undefined) return undefined;
  // A power past the limit is known before it is computed: a part of `h`
  // hexadecimal digits is at least 16^(h−1), and the parts of a fraction in
  // lowest terms stay coprime under a power, so no gcd brings it back.
  // `1.000001 ^ 1000` was squared up to the limit, a gcd at every step, to
  // learn as much.
  const k = n < 0n ? -n : n;
  if (Number(k) * 4 * (hexDigits(lowest) - 1) >= LIMIT_BITS) return undefined;
  let result: Rational | undefined = { num: 1n, den: 1n };
  let square: Rational | undefined = n < 0n ? rational(lowest.den, lowest.num) : lowest;
  for (let e = k; e > 0n && result && square; e >>= 1n) {
    if (e & 1n) result = multiplyRationals(result, square);
    if (e > 1n) square = multiplyRationals(square, square);
  }
  return result && square ? result : undefined;
}

/** The sign of `a − b`. */
export function compareRationals(a: Rational, b: Rational): -1 | 0 | 1 {
  const d = a.num * b.den - b.num * a.den;
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/* ─────────────────────────────── readings ─────────────────────────────── */

/**
 * The exact number a numeral denotes — the encoder's own reading of it
 * ({@link numeralRational}): the decimal it prints as, or, written past
 * fifteen significant digits (`text`), the double it parsed to.
 * `undefined` for a value that is no number.
 */
export function writtenRational(value: number, text?: string): Rational | undefined {
  const r = numeralRational({ kind: 'num', value, ...(text !== undefined ? { text } : {}) });
  return r && lowest(r);
}

/**
 * A literal number a model states, as the SMT encoder reads its value axiom:
 * through the parser's lexeme (`valueText`) where the double does not
 * determine it, else as the decimal the double prints as.
 */
export function statedRational(value: number, lexeme: unknown): Rational | undefined {
  return writtenRational(value, typeof lexeme === 'string' && Number(lexeme) === value ? lexeme : undefined);
}

/** A unit's factor and origin as exact rationals, once per spelling (the registry is model-free). */
const UNIT_READINGS = new Map<string, { factor: Rational; offset: Rational } | null>();

/**
 * A magnitude stated in `unit`, read into coherent SI exactly —
 * `magnitude · factor + origin`, the affine map the encoder writes for a
 * stored magnitude and a `[unit]` literal alike. The magnitude itself for no
 * unit; `undefined` for a unit the registry does not know.
 */
export function siRational(magnitude: Rational, unit: string | undefined): Rational | undefined {
  if (unit === undefined) return magnitude;
  let reading = UNIT_READINGS.get(unit);
  if (reading === undefined) {
    const u = resolveUnit(unit);
    reading = u
      ? { factor: lowest(scaleRational(u.factorToSI, u.factorTerms)), offset: lowest(scaleRational(u.offsetSI ?? 0)) }
      : null;
    UNIT_READINGS.set(unit, reading);
  }
  if (reading === null) return undefined;
  const scaled = multiplyRationals(magnitude, reading.factor);
  return scaled && (reading.offset.num === 0n ? scaled : addRationals(scaled, reading.offset));
}

/**
 * z3's rendering of a real as the exact rational it is — `(/ 3.0 25.0)`,
 * `(- 7.0)`, `12.0` — or `undefined` for anything else: a truth value, or an
 * algebraic root (`(root-obj …)`) no rational is.
 */
export function termRational(term: string): Rational | undefined {
  const t = term.trim();
  const neg = /^\(-\s+([\s\S]+)\)$/.exec(t);
  if (neg) {
    const inner = termRational(neg[1]);
    return inner && negateRational(inner);
  }
  const div = /^\(\/\s+([^\s()]+)\s+([^\s()]+)\)$/.exec(t);
  if (div) {
    const a = decimalRational(div[1]);
    const b = decimalRational(div[2]);
    return a && b ? divideRationals(lowest(a), lowest(b)) : undefined;
  }
  if (t.startsWith('(')) return undefined;
  const d = decimalRational(t);
  return d && rational(d.num, d.den);
}

/* ─────────────────────────────── deciding ─────────────────────────────── */

/** Are two doubles within the tolerance of one another — a tie the doubles cannot decide? */
export function withinTolerance(x: number, y: number, absTol = 0): boolean {
  return Math.abs(x - y) <= Math.max(absTol, REL_TOL * Math.max(Math.abs(x), Math.abs(y)));
}

/** `op` applied to the sign of `x − y`. */
function byOrder(op: ComparisonOperator, sign: number): boolean {
  switch (op) {
    case '<':
      return sign < 0;
    case '<=':
      return sign <= 0;
    case '>':
      return sign > 0;
    case '>=':
      return sign >= 0;
    case '==':
    case '=':
      return sign === 0;
    case '!=':
      return sign !== 0;
  }
}

/** `x op y` on the doubles as they are — for a side that is no finite number, which no band reads. */
function raw(op: ComparisonOperator, x: number, y: number): boolean {
  switch (op) {
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    case '>=':
      return x >= y;
    case '==':
    case '=':
      return x === y;
    case '!=':
      return x !== y;
  }
}

/**
 * `x op y`, DECIDED — the tie rule every point evaluator compares by:
 *  - both sides with an exact reading (`ex`, `ey`): the rationals decide, in
 *    or out of any band — `0.1 + 0.2 > 0.3` is false and `1.0e16 + 1.0 >
 *    1.0e16` true, whatever the doubles round them to;
 *  - else, outside the tolerance ({@link withinTolerance}), the doubles;
 *  - inside it, over values a solve produced (`searched`), `==`, `<=` and
 *    `>=` hold — the solve's own claim — and everything else is UNDECIDED:
 *    `undefined`, which a surface publishes as unknown, never as either
 *    verdict.
 */
export function decideComparison(
  op: ComparisonOperator,
  x: number,
  y: number,
  ex: Rational | undefined,
  ey: Rational | undefined,
  opts: DecideOptions = {},
): boolean | undefined {
  if (ex !== undefined && ey !== undefined) return byOrder(op, compareRationals(ex, ey));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return raw(op, x, y);
  if (!withinTolerance(x, y, opts.absTol ?? 0)) return byOrder(op, x < y ? -1 : 1);
  if (opts.searched !== true) return undefined;
  return op === '<' || op === '>' || op === '!=' ? undefined : true;
}

/** The sentence for a {@link Tie}: what the two sides were, and why nothing decided them. */
export function tieSentence(tie: Pick<Tie, 'x' | 'y' | 'solved'>): string {
  if (tie.solved === true) {
    return (
      `its two sides, ${tie.x} and ${tie.y}, are within the solve's tolerance of one another and an ` +
      'operand is a value the solve produced, known only to that tolerance — the comparison turns on a ' +
      'difference the solve does not know, so it is undecided rather than read either way'
    );
  }
  return (
    `its two sides, ${tie.x} and ${tie.y}, are equal within the evaluators' relative tolerance ` +
    `(${REL_TOL}) and no exact reading decides them — an operand is computed by an operation exact ` +
    'arithmetic does not follow (a fractional power), so the comparison is undecided rather than read ' +
    'either way'
  );
}

/* ───────────────────────── the decided evaluator ──────────────────────── */

/** The exact reading of a name a scope answers with a number, when it has one. */
export type ExactScope = (name: string) => Rational | undefined;

/**
 * What {@link evaluateDecided} answers: a value — with the exact rational of
 * a number, when it has one — or unknown, carrying the tie it could not
 * decide when that was why.
 */
export type DecidedResult = { value: unknown; exact?: Rational } | { unknown: true; tie?: Tie };

type Folded = DecidedResult;

const UNKNOWN: Folded = { unknown: true };
const known = (r: Folded): r is { value: unknown; exact?: Rational } => !('unknown' in r);

/**
 * `evaluate` of ./expr with every comparison of two numbers DECIDED
 * ({@link decideComparison}): each number is folded beside the exact rational
 * of the decimals that produced it — a numeral's own ({@link numeralRational}),
 * a name's from `exact` — so a comparison is that of the rationals wherever
 * both sides have one, and a number's own exact reading comes back with it.
 * Everything else — the short-circuits, strings, booleans, a division by
 * zero — reads exactly as `evaluate` reads it.
 *
 * This is how a scalar path (the validation surface's bare-literal fallback,
 * a value expression it derives) and a witness re-read compare: an `unknown`
 * with a {@link Tie} is a tie the doubles cannot decide and no exact reading
 * did.
 */
export function evaluateDecided(
  node: ExprNode,
  scope: (name: string) => unknown,
  exact: ExactScope = () => undefined,
  opts: DecideOptions = {},
): DecidedResult {
  return fold(node, scope, exact, opts);
}

function fold(node: ExprNode, scope: (name: string) => unknown, exact: ExactScope, opts: DecideOptions): Folded {
  switch (node.kind) {
    case 'num': {
      const r = numeralRational(node);
      const e = r && lowest(r);
      return e ? { value: node.value, exact: e } : { value: node.value };
    }
    case 'str':
    case 'bool':
      return { value: node.value };
    case 'null':
      return { value: null };
    case 'ref': {
      const name = node.path.join('.');
      const v = scope(name);
      if (v === undefined) return UNKNOWN;
      const e = typeof v === 'number' ? exact(name) : undefined;
      return e ? { value: v, exact: e } : { value: v };
    }
    case 'unary': {
      const r = fold(node.operand, scope, exact, opts);
      if (!known(r)) return r;
      if (node.op === 'not') return typeof r.value === 'boolean' ? { value: !r.value } : UNKNOWN;
      if (typeof r.value !== 'number') return UNKNOWN;
      if (node.op === '+') return r;
      return r.exact ? { value: -r.value, exact: negateRational(r.exact) } : { value: -r.value };
    }
    case 'binary':
      return foldBinary(node, scope, exact, opts);
    case 'if': {
      const c = fold(node.cond, scope, exact, opts);
      if (!known(c)) return c;
      if (typeof c.value !== 'boolean') return UNKNOWN;
      return fold(c.value ? node.then : node.else, scope, exact, opts);
    }
  }
}

function foldBinary(
  node: Extract<ExprNode, { kind: 'binary' }>,
  scope: (name: string) => unknown,
  exact: ExactScope,
  opts: DecideOptions,
): Folded {
  const op = node.op;
  // The short-circuits of `evaluate`, exactly: `false and x`, `true or x`,
  // `false implies x` and `x implies true` decide without x.
  if (op === 'and' || op === 'or' || op === 'implies' || op === 'xor') {
    const l = fold(node.left, scope, exact, opts);
    if (op === 'and' && known(l) && l.value === false) return { value: false };
    if (op === 'or' && known(l) && l.value === true) return { value: true };
    const r = fold(node.right, scope, exact, opts);
    if (op === 'implies') {
      if (known(l) && l.value === false) return { value: true };
      if (known(r) && r.value === true) return { value: true };
    }
    if (!known(l)) return l;
    if (!known(r)) return r;
    const a = l.value;
    const b = r.value;
    if (typeof a !== 'boolean' || typeof b !== 'boolean') return UNKNOWN;
    switch (op) {
      case 'and':
        return { value: a && b };
      case 'or':
        return { value: a || b };
      case 'xor':
        return { value: a !== b };
      case 'implies':
        return { value: !a || b };
    }
  }

  const l = fold(node.left, scope, exact, opts);
  const r = fold(node.right, scope, exact, opts);
  if (!known(l)) return l;
  if (!known(r)) return r;
  const a = l.value;
  const b = r.value;
  switch (op) {
    case '=':
    case '==':
    case '!=':
      if (typeof a === 'number' && typeof b === 'number') return decided(op, a, b, l.exact, r.exact, opts);
      return { value: op === '!=' ? a !== b : a === b };
    case '<':
    case '<=':
    case '>':
    case '>=':
      if (typeof a === 'number' && typeof b === 'number') return decided(op, a, b, l.exact, r.exact, opts);
      if (typeof a === 'string' && typeof b === 'string') {
        return { value: op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b };
      }
      return UNKNOWN;
    case '+':
      // String concatenation when either side is a string, as `evaluate` reads it.
      if (typeof a === 'string' || typeof b === 'string') return { value: String(a) + String(b) };
      return arithmetic(a, b, l.exact, r.exact, (x, y) => x + y, addRationals);
    case '-':
      return arithmetic(a, b, l.exact, r.exact, (x, y) => x - y, subtractRationals);
    case '*':
      return arithmetic(a, b, l.exact, r.exact, (x, y) => x * y, multiplyRationals);
    case '/':
      return arithmetic(a, b, l.exact, r.exact, (x, y) => x / y, divideRationals);
    case '%':
      return arithmetic(a, b, l.exact, r.exact, (x, y) => x % y, remainderRational);
    case '^':
      return arithmetic(a, b, l.exact, r.exact, (x, y) => x ** y, powerRational);
  }
  return UNKNOWN;
}

/** A comparison of two numbers, decided — or unknown with the {@link Tie}. */
function decided(
  op: ComparisonOperator,
  x: number,
  y: number,
  ex: Rational | undefined,
  ey: Rational | undefined,
  opts: DecideOptions,
): Folded {
  const b = decideComparison(op, x, y, ex, ey, opts);
  if (b !== undefined) return { value: b };
  return { unknown: true, tie: { op, x, y, ...(opts.searched === true ? { solved: true } : {}) } };
}

/**
 * Binary arithmetic: the double as `evaluate` computes it (a non-finite
 * operand or result is unknown), and the exact result beside it when both
 * operands have one and exact arithmetic follows the operator.
 */
function arithmetic(
  a: unknown,
  b: unknown,
  ea: Rational | undefined,
  eb: Rational | undefined,
  f: (x: number, y: number) => number,
  g: (x: Rational, y: Rational) => Rational | undefined,
): Folded {
  if (typeof a !== 'number' || typeof b !== 'number') return UNKNOWN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return UNKNOWN;
  const value = f(a, b);
  if (!Number.isFinite(value)) return UNKNOWN;
  const e = ea !== undefined && eb !== undefined ? g(ea, eb) : undefined;
  return e ? { value, exact: e } : { value };
}

/* ───────────────────────── a witness, re-read ─────────────────────────── */

/**
 * The point a witness re-read reads (`rereadPoint` of ./smt/z3-bridge): each
 * symbol's value as a double, and — `exact` — the rational z3 answered with,
 * where it is one. Without `exact` every number is read as its double.
 */
export type PointValues = ReadonlyMap<string, number | boolean> & {
  readonly exact?: ReadonlyMap<string, Rational>;
};

/** The part of an encoder variable (`EncodeVariable` of ./smt/encode) a re-read reads a symbol through. */
export interface ReadVariable {
  path: string;
  qualifiedName: string;
  factor: number;
  offset: number;
  factorTerms?: ReadonlyArray<FactorTerm>;
}

/**
 * A relation re-read at a solver's point, each variable read as the encoder
 * reads it — `factor·x + offset` — and DECIDED ({@link evaluateDecided}) over
 * the rationals z3 answered with: the solver's point is exact, and so is the
 * re-read. Read in binary64 within a tolerance, the gates confirmed what only
 * the doubles said and declined what only the doubles denied: a requirement
 * `p.f + 0.2 == 0.3` at the point `f = 1/10` was "false at the point the
 * solver chose", and a refutation of `0.1 + 0.2 <= 0.3` was "confirmed".
 */
export function rereadRelation(node: ExprNode, vars: readonly ReadVariable[], point: PointValues): DecidedResult {
  const find = (name: string): ReadVariable | undefined =>
    vars.find((x) => x.path === name || x.qualifiedName === name);
  const scope = (name: string): unknown => {
    const v = find(name);
    if (!v) return undefined;
    const raw = point.get(v.qualifiedName);
    if (raw === undefined) return undefined;
    return typeof raw === 'boolean' ? raw : raw * v.factor + v.offset;
  };
  const exact = (name: string): Rational | undefined => {
    const v = find(name);
    const r = v ? point.exact?.get(v.qualifiedName) : undefined;
    return r && affineRational(r, v!);
  };
  return evaluateDecided(node, scope, exact);
}

/**
 * A stored magnitude read into SI exactly as the encoder writes the read
 * (`affine` of ./smt/encode): times the factor's exact reading, plus the
 * origin's. `undefined` for a scale the encoder refuses (not a finite
 * non-zero factor).
 */
export function affineRational(r: Rational, v: Pick<ReadVariable, 'factor' | 'offset' | 'factorTerms'>): Rational | undefined {
  if (!Number.isFinite(v.factor) || !Number.isFinite(v.offset) || v.factor === 0) return undefined;
  const scaled = multiplyRationals(r, lowest(scaleRational(v.factor, v.factorTerms)));
  return scaled && (v.offset === 0 ? scaled : addRationals(scaled, lowest(scaleRational(v.offset))));
}

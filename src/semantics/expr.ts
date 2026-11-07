/**
 * A small, self-contained expression parser + evaluator for the KerML/SysML v2
 * expression sublanguage used in feature values, constraints and transition
 * guards.
 *
 * This is an ORIGINAL, clean-room implementation (no third-party grammar or
 * evaluator was copied). It implements the operator set and precedence of the
 * OMG KerML expression notation faithfully enough for the semantics engine:
 *
 *  - literals: numbers, double-quoted strings, `true` / `false`, `null`;
 *  - dotted feature-chain references `a.b.c`, whose segments may be single-quoted
 *    unrestricted names (`'max load'.x`): a single quote never opens a string;
 *  - unary `-` `+` `not`;
 *  - binary `+ - * / % ^`, comparisons `< <= > >= == !=`,
 *    logical `and or xor implies`;
 *  - parentheses and conditional `if C then T else E`.
 *
 * {@link parseExpr} produces an {@link ExprNode} tree; {@link evaluate} folds it
 * against a `scope` resolver, returning `{ unknown: true }` whenever a referenced
 * name has no known value (so partially-specified models degrade gracefully
 * rather than throwing).
 */

import { unquoteName } from '@core/index';
import type { FactorTerm } from './units';

/* ─────────────────────────────── AST ─────────────────────────────────── */

export type ExprNode =
  | {
      kind: 'num';
      value: number;
      /**
       * Set on a lowered `[unit]` literal only (`substituteLiterals` of
       * ./unit-literals): the magnitude as the author wrote it and the unit's
       * factor to SI, of which `value` is the rounded product — with the terms
       * a composed unit's factor is the product of (`Unit.factorTerms`). Every
       * evaluator reads `value`; the SMT encoder reads this, so `1.0 [g]` is
       * exactly the thousandth a stored `1.0` in grams is read as.
       */
      literal?: { magnitude: string; factor: number; factorTerms?: ReadonlyArray<FactorTerm> };
      /**
       * The numeral as the author wrote it, kept only when it writes more
       * significant digits than a double carries ({@link DOUBLE_DIGITS}) — the
       * one case where `value` does not determine the decimal that was
       * written: `0.29999999999999999` parses to the double `0.3` prints as.
       * Every evaluator reads `value`; the SMT encoder reads such a numeral
       * as that double's own rational, never as the shorter decimal it
       * prints as. Absent, the numeral is the decimal `String(value)` prints.
       */
      text?: string;
    }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'ref'; path: string[] }
  | { kind: 'unary'; op: '-' | '+' | 'not'; operand: ExprNode }
  | { kind: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { kind: 'if'; cond: ExprNode; then: ExprNode; else: ExprNode };

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%' | '^'
  | '<' | '<=' | '>' | '>=' | '==' | '!=' | '='
  | 'and' | 'or' | 'xor' | 'implies';

/** Result of evaluating a node: either a concrete value or "not known". */
export type EvalResult = { value: unknown } | { unknown: true; absorbable?: true };

/**
 * One operand of a connective ({@link connective}): a Boolean, or unknown. An unknown is `absorbable` only when it is
 * a value the scope does not read (a name with no value), which every completion of the model gives a Boolean where
 * the body is well typed. A refusal, an ill-typed operand (a known non-Boolean, `not` of a number) or any other
 * unknown is never absorbable.
 */
export type Tri = boolean | { unknown: true; absorbable: boolean };

/**
 * The connective table every evaluator reads (KerML 7.4.9.2): `false and _`, `true or _` and `false implies _` decide
 * without the right operand, which is read only when needed; an absorbable unknown left operand is absorbed by
 * `x and false`, `x or true` and `x implies true`; a non-absorbable one never is, and `xor` never absorbs. An unknown
 * result is absorbable only when every unknown operand it was read from is.
 */
export function connective(op: 'and' | 'or' | 'xor' | 'implies', left: Tri, right: () => Tri): Tri {
  if (op === 'and' && left === false) return false;
  if (op === 'or' && left === true) return true;
  if (op === 'implies' && left === false) return true;
  const r = right();
  if (typeof left === 'boolean' && typeof r === 'boolean') {
    if (op === 'and') return left && r;
    if (op === 'or') return left || r;
    if (op === 'xor') return left !== r;
    return !left || r;
  }
  // `true and x`, `false or x` and `true implies x` are x.
  if (typeof left === 'boolean' && op !== 'xor') return r;
  if (typeof left !== 'boolean' && left.absorbable && op !== 'xor') {
    const absorbing = op === 'and' ? false : true;
    if (r === absorbing) return absorbing;
  }
  const absorbable = (typeof left === 'boolean' || left.absorbable) && (typeof r === 'boolean' || r.absorbable);
  return { unknown: true, absorbable };
}

/* ─────────────────────────────── numerals ────────────────────────────── */

/**
 * The significant digits a binary64 carries (`DBL_DIG`): every decimal with at
 * most this many is, in value, the decimal its double prints as, so the double
 * determines it. A numeral written with more is not determined by its double —
 * `0.29999999999999999` and `0.3` are one double — and is read as that double.
 */
export const DOUBLE_DIGITS = 15;

/**
 * How many significant digits a numeral's text writes, sign, exponent and
 * leading and trailing zeros aside: `0.30000000000000001` writes 17, `1500.0`
 * writes 2 and `0.00000000000000001` writes 1.
 */
export function significantDigitsOf(text: string): number {
  const mantissa = text.trim().replace(/^[-+]/, '').split(/[eE]/)[0] ?? '';
  return mantissa.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length;
}

/* ─────────────────────────────── lexer ───────────────────────────────── */

type Tok =
  | { t: 'num'; v: number; text?: string }
  | { t: 'str'; v: string }
  | { t: 'name'; v: string }
  | { t: 'kw'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'eof' };

const KEYWORDS = new Set([
  'true', 'false', 'null', 'not', 'and', 'or', 'xor', 'implies', 'if', 'then', 'else',
]);

// Multi-character operators must be tried before their single-char prefixes.
const MULTI_OPS = ['<=', '>=', '==', '!='];
const SINGLE_OPS = new Set(['+', '-', '*', '/', '%', '^', '<', '>']);

/**
 * Read the single-quoted unrestricted name that opens at `src[i]` (`'max load'`,
 * `'ref'`): the notation's spelling of a name with spaces, symbols or a
 * keyword-like word, and in an expression a NAME REFERENCE — never a string
 * (a string is double-quoted). Returns the name unquoted and unescaped, the
 * form `declaredName` holds, and the index after the closing quote.
 *
 * A name holding `.`, `:` or nothing at all is refused (a SyntaxError, so the
 * expression is not read): the evaluators carry a reference as its segments
 * joined by `.`, in which `'a.b'` and `a.b` would be one text.
 */
export function readQuotedName(src: string, i: number): { name: string; end: number } {
  let j = i + 1;
  while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
  if (j >= src.length) throw new SyntaxError(`Unterminated quoted name at ${i}`);
  const name = unquoteName(src.slice(i, j + 1)) ?? '';
  if (name === '' || /[.:]/.test(name)) {
    throw new SyntaxError(`A quoted name holding '.', ':' or nothing is not read in an expression: ${src.slice(i, j + 1)}`);
  }
  return { name, end: j + 1 };
}

/**
 * A name (or dotted path of names) in the form an expression text spells it:
 * each segment bare where it is a plain identifier the lexer does not take for a
 * keyword, single-quoted otherwise (`max load` → `'max load'`, `in` → `'in'`).
 * For the readers that BUILD an expression from names the model holds unquoted
 * (`<end> == <end>` of a binding) and parse it again; a name that is already
 * plain comes back unchanged.
 */
export function exprRef(path: string): string {
  return path
    .split('.')
    .map((seg) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg) && !KEYWORDS.has(seg) ? seg : `'${seg.replace(/[\\']/g, '\\$&')}'`,
    )
    .join('.');
}

const WRITTEN_CHAIN_RE = /(?<![\w.])(?:[A-Za-z_]\w*|'(?:\\.|[^'\\])*')(?:\.(?:[A-Za-z_]\w*|'(?:\\.|[^'\\])*'))*/g;

/**
 * The dotted chains a text writes, as written (`a.'b c'`): for the readers that
 * scan a body they could not parse, where a segment is a plain identifier or a
 * single-quoted unrestricted name. Cut one into its unquoted segments with
 * `refSegments`.
 */
export function writtenChains(text: string): string[] {
  return text.match(WRITTEN_CHAIN_RE) ?? [];
}

/**
 * Lex an expression string into tokens. A '.' between names is emitted as an
 * `op` token so the parser's dotted feature-chain loop can consume it; a '.'
 * that begins a number (e.g. `.5`) is folded into the number literal.
 */
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
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
    // A single quote opens an unrestricted NAME (a reference), not a string.
    if (c === "'") {
      const q = readQuotedName(src, i);
      toks.push({ t: 'name', v: q.name });
      i = q.end;
      continue;
    }
    // String literal (double quoted).
    if (c === '"') {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < n) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= n) throw new SyntaxError(`Unterminated string literal at ${i}`);
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    // Number literal (integer or decimal, optional exponent).
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
      // The text rides along only where the double does not determine it.
      const text = src.slice(i, j);
      toks.push({ t: 'num', v: Number(text), ...(significantDigitsOf(text) > DOUBLE_DIGITS ? { text } : {}) });
      i = j;
      continue;
    }
    // Identifier / keyword.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      toks.push(KEYWORDS.has(word) ? { t: 'kw', v: word } : { t: 'name', v: word });
      i = j;
      continue;
    }
    // Feature-chain separator.
    if (c === '.') {
      toks.push({ t: 'op', v: '.' });
      i++;
      continue;
    }
    // Operators.
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (SINGLE_OPS.has(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '=') {
      // A lone '=' is a DISTINCT operator token — no longer silently folded to
      // '==' at the lexer (finding L3). The solver accepts it as an equation
      // separator and evaluate() treats it as equality; keeping it distinct
      // preserves the user's `=` vs `==` intent in the parsed AST.
      toks.push({ t: 'op', v: '=' });
      i++;
      continue;
    }
    throw new SyntaxError(`Unexpected character '${c}' at ${i}`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

/* ─────────────────────────────── parser ──────────────────────────────── */

/** Left-binding power for each binary operator (higher = binds tighter). */
const PRECEDENCE: Record<string, number> = {
  implies: 1,
  or: 2,
  xor: 3,
  and: 4,
  '==': 5,
  '=': 5,
  '!=': 5,
  '<': 6,
  '<=': 6,
  '>': 6,
  '>=': 6,
  '+': 7,
  '-': 7,
  '*': 8,
  '/': 8,
  '%': 8,
  '^': 9,
};
/**
 * KerML 8.2.5.8.1, Table 6: `and` > `xor` > `or` > `implies`, and every binary
 * operator but exponentiation groups to the left (`a implies b implies c` is
 * `(a implies b) implies c`; `a or b xor c` is `a or (b xor c)`).
 */
const RIGHT_ASSOC = new Set(['^']);

class Parser {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.pos];
  }
  private next(): Tok {
    return this.toks[this.pos++];
  }

  parse(): ExprNode {
    const node = this.parseBinary(0);
    if (this.peek().t !== 'eof') {
      throw new SyntaxError('Unexpected trailing tokens in expression');
    }
    return node;
  }

  /** Operator token value if the current token is a usable binary operator. */
  private binaryOpHere(): string | undefined {
    const tk = this.peek();
    if (tk.t === 'op') return tk.v;
    if (tk.t === 'kw' && (tk.v === 'and' || tk.v === 'or' || tk.v === 'xor' || tk.v === 'implies')) {
      return tk.v;
    }
    return undefined;
  }

  private parseBinary(minPrec: number): ExprNode {
    let left = this.parseUnary();
    for (;;) {
      const op = this.binaryOpHere();
      if (op === undefined) break;
      const prec = PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) break;
      this.next(); // consume operator
      const nextMin = RIGHT_ASSOC.has(op) ? prec : prec + 1;
      const right = this.parseBinary(nextMin);
      left = { kind: 'binary', op: op as BinaryOp, left, right };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    const tk = this.peek();
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
      this.next();
      return { kind: 'unary', op: tk.v, operand: this.parseUnary() };
    }
    if (tk.t === 'kw' && tk.v === 'not') {
      this.next();
      return { kind: 'unary', op: 'not', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const tk = this.next();
    switch (tk.t) {
      case 'num':
        return { kind: 'num', value: tk.v, ...(tk.text !== undefined ? { text: tk.text } : {}) };
      case 'str':
        return { kind: 'str', value: tk.v };
      case 'lparen': {
        const inner = this.parseBinary(0);
        if (this.next().t !== 'rparen') throw new SyntaxError('Expected closing parenthesis');
        return inner;
      }
      case 'name': {
        const path = [tk.v];
        while (this.peek().t === 'op' && (this.peek() as { v: string }).v === '.') {
          // '.' is not emitted as an op by the lexer; kept for completeness.
          this.next();
          const seg = this.next();
          if (seg.t !== 'name') throw new SyntaxError('Expected name after "."');
          path.push(seg.v);
        }
        return { kind: 'ref', path };
      }
      case 'kw':
        if (tk.v === 'true') return { kind: 'bool', value: true };
        if (tk.v === 'false') return { kind: 'bool', value: false };
        if (tk.v === 'null') return { kind: 'null' };
        if (tk.v === 'if') {
          const cond = this.parseBinary(0);
          this.expectKw('then');
          const thenN = this.parseBinary(0);
          this.expectKw('else');
          const elseN = this.parseBinary(0);
          return { kind: 'if', cond, then: thenN, else: elseN };
        }
        throw new SyntaxError(`Unexpected keyword '${tk.v}'`);
      default:
        throw new SyntaxError('Unexpected end of expression');
    }
  }

  private expectKw(kw: string): void {
    const tk = this.next();
    if (tk.t !== 'kw' || tk.v !== kw) throw new SyntaxError(`Expected '${kw}'`);
  }
}

/**
 * Parse an expression string into an {@link ExprNode} tree.
 * @throws SyntaxError on malformed input.
 */
export function parseExpr(text: string): ExprNode {
  return new Parser(tokenize(text)).parse();
}

/**
 * Two trees the same expression, node for node: the same operators, the same
 * names, and every number the same numeral — its value, the digits written
 * past a double's ({@link DOUBLE_DIGITS}) and, for a lowered `[unit]` literal,
 * the magnitude and factor written. Structural only: `a + b` and `b + a` are
 * not the same here, and `2.0 [m]` and `2000.0 [mm]` are not either.
 */
export function exprEqual(a: ExprNode, b: ExprNode): boolean {
  switch (a.kind) {
    case 'num':
      return (
        b.kind === 'num' &&
        a.value === b.value &&
        a.text === b.text &&
        JSON.stringify(a.literal ?? null) === JSON.stringify(b.literal ?? null)
      );
    case 'str':
      return b.kind === 'str' && a.value === b.value;
    case 'bool':
      return b.kind === 'bool' && a.value === b.value;
    case 'null':
      return b.kind === 'null';
    case 'ref':
      return b.kind === 'ref' && a.path.join('.') === b.path.join('.');
    case 'unary':
      return b.kind === 'unary' && a.op === b.op && exprEqual(a.operand, b.operand);
    case 'binary':
      return b.kind === 'binary' && a.op === b.op && exprEqual(a.left, b.left) && exprEqual(a.right, b.right);
    case 'if':
      return b.kind === 'if' && exprEqual(a.cond, b.cond) && exprEqual(a.then, b.then) && exprEqual(a.else, b.else);
  }
}

/* ────────────────────────────── evaluator ────────────────────────────── */

const UNKNOWN: EvalResult = { unknown: true };
/** A scope miss: the one unknown {@link connective} may absorb. */
const MISSING: EvalResult = { unknown: true, absorbable: true };
const isUnknown = (r: EvalResult): r is { unknown: true; absorbable?: true } => 'unknown' in r;

/**
 * Of two operand results of `op` (not a connective) at least one unknown, the unknown to pass on: a non-absorbable one
 * wins, and a scope miss beside a Boolean where a number is needed is no longer absorbable (no value makes it one).
 */
function unknownOf(op: BinaryOp, l: EvalResult, r: EvalResult): EvalResult {
  if (isUnknown(l) && l.absorbable !== true) return l;
  if (isUnknown(r) && r.absorbable !== true) return r;
  const known = isUnknown(l) ? r : l;
  if (!isUnknown(known) && typeof known.value === 'boolean' && op !== '==' && op !== '=' && op !== '!=') return UNKNOWN;
  return isUnknown(l) ? l : r;
}

/** An operand of a connective as {@link connective} reads it. */
function triOf(r: EvalResult): Tri {
  if (isUnknown(r)) return { unknown: true, absorbable: r.absorbable === true };
  return typeof r.value === 'boolean' ? r.value : { unknown: true, absorbable: false };
}

/**
 * Evaluate an expression tree against a `scope` resolver.
 *
 * @param node  the parsed expression.
 * @param scope maps a (possibly dotted) name to its known value, or returns
 *              `undefined` when the name has no known value.
 * @returns `{ value }` on success or `{ unknown: true }` when any needed name is
 *          unresolved (with logical short-circuits so `false and x` is still
 *          `false`, etc.).
 */
export function evaluate(node: ExprNode, scope: (name: string) => unknown): EvalResult {
  switch (node.kind) {
    case 'num':
      return { value: node.value };
    case 'str':
      return { value: node.value };
    case 'bool':
      return { value: node.value };
    case 'null':
      return { value: null };
    case 'ref': {
      const v = scope(node.path.join('.'));
      return v === undefined ? MISSING : { value: v };
    }
    case 'unary':
      return evalUnary(node, scope);
    case 'binary':
      return evalBinary(node, scope);
    case 'if': {
      const c = evaluate(node.cond, scope);
      if (isUnknown(c)) return c;
      if (typeof c.value !== 'boolean') return UNKNOWN;
      return c.value ? evaluate(node.then, scope) : evaluate(node.else, scope);
    }
  }
}

function evalUnary(
  node: Extract<ExprNode, { kind: 'unary' }>,
  scope: (name: string) => unknown,
): EvalResult {
  const r = evaluate(node.operand, scope);
  if (isUnknown(r)) return r;
  const v = r.value;
  if (node.op === 'not') return typeof v === 'boolean' ? { value: !v } : UNKNOWN;
  if (typeof v !== 'number') return UNKNOWN;
  return { value: node.op === '-' ? -v : +v };
}

function evalBinary(
  node: Extract<ExprNode, { kind: 'binary' }>,
  scope: (name: string) => unknown,
): EvalResult {
  const op = node.op;

  // Logical operators: the one connective table, which reads the right operand only when it needs it.
  if (op === 'and' || op === 'or' || op === 'implies' || op === 'xor') {
    const l = evaluate(node.left, scope);
    const t = connective(op, triOf(l), () => triOf(evaluate(node.right, scope)));
    if (typeof t === 'boolean') return { value: t };
    return t.absorbable ? MISSING : UNKNOWN;
  }

  const l = evaluate(node.left, scope);
  const r = evaluate(node.right, scope);
  if (isUnknown(l) || isUnknown(r)) return unknownOf(op, l, r);
  const a = l.value;
  const b = r.value;

  switch (op) {
    case '=':
    case '==':
      return { value: a === b };
    case '!=':
      return { value: a !== b };
    case '+':
      // String concatenation when either side is a string.
      if (typeof a === 'string' || typeof b === 'string') {
        return { value: String(a) + String(b) };
      }
      return numeric(a, b, (x, y) => x + y);
    case '-':
      return numeric(a, b, (x, y) => x - y);
    case '*':
      return numeric(a, b, (x, y) => x * y);
    case '/':
      return numeric(a, b, (x, y) => x / y);
    case '%':
      return numeric(a, b, (x, y) => x % y);
    case '^':
      return numeric(a, b, (x, y) => x ** y);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compare(op, a, b);
  }
  return UNKNOWN;
}

function numeric(a: unknown, b: unknown, f: (x: number, y: number) => number): EvalResult {
  if (typeof a !== 'number' || typeof b !== 'number') return UNKNOWN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return UNKNOWN;
  const r = f(a, b);
  // Division/modulo/power by zero yield ±Infinity or NaN; treat as UNKNOWN so
  // the value never poisons downstream arithmetic or stalls the solver.
  if (!Number.isFinite(r)) return UNKNOWN;
  return { value: r };
}

function compare(op: string, a: unknown, b: unknown): EvalResult {
  const bothNum = typeof a === 'number' && typeof b === 'number';
  const bothStr = typeof a === 'string' && typeof b === 'string';
  if (!bothNum && !bothStr) return UNKNOWN;
  const x = a as number | string;
  const y = b as number | string;
  switch (op) {
    case '<':
      return { value: x < y };
    case '<=':
      return { value: x <= y };
    case '>':
      return { value: x > y };
    case '>=':
      return { value: x >= y };
  }
  return UNKNOWN;
}

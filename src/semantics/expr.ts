/**
 * A small, self-contained expression parser + evaluator for the KerML/SysML v2
 * expression sublanguage used in feature values, constraints and transition
 * guards.
 *
 * This is an ORIGINAL, clean-room implementation (no third-party grammar or
 * evaluator was copied). It implements the operator set and precedence of the
 * OMG KerML expression notation faithfully enough for the semantics engine:
 *
 *  - literals: numbers, double/single-quoted strings, `true` / `false`, `null`;
 *  - dotted feature-chain references `a.b.c`;
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

/* ─────────────────────────────── AST ─────────────────────────────────── */

export type ExprNode =
  | { kind: 'num'; value: number }
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
export type EvalResult = { value: unknown } | { unknown: true };

/* ─────────────────────────────── lexer ───────────────────────────────── */

type Tok =
  | { t: 'num'; v: number }
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
    // String literal (double or single quoted).
    if (c === '"' || c === "'") {
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
      toks.push({ t: 'num', v: Number(src.slice(i, j)) });
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
const RIGHT_ASSOC = new Set(['^', 'implies']);

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
        return { kind: 'num', value: tk.v };
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

/* ────────────────────────────── evaluator ────────────────────────────── */

const UNKNOWN: EvalResult = { unknown: true };
const isUnknown = (r: EvalResult): r is { unknown: true } => 'unknown' in r;

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
      return v === undefined ? UNKNOWN : { value: v };
    }
    case 'unary':
      return evalUnary(node, scope);
    case 'binary':
      return evalBinary(node, scope);
    case 'if': {
      const c = evaluate(node.cond, scope);
      if (isUnknown(c)) return UNKNOWN;
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
  if (isUnknown(r)) return UNKNOWN;
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

  // Logical operators with short-circuit semantics.
  if (op === 'and' || op === 'or' || op === 'implies' || op === 'xor') {
    const l = evaluate(node.left, scope);
    if (op === 'and') {
      if (!isUnknown(l) && l.value === false) return { value: false };
    } else if (op === 'or') {
      if (!isUnknown(l) && l.value === true) return { value: true };
    }
    const r = evaluate(node.right, scope);
    if (op === 'implies') {
      if (!isUnknown(l) && l.value === false) return { value: true };
      if (!isUnknown(r) && r.value === true) return { value: true };
    }
    if (isUnknown(l) || isUnknown(r)) return UNKNOWN;
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

  const l = evaluate(node.left, scope);
  const r = evaluate(node.right, scope);
  if (isUnknown(l) || isUnknown(r)) return UNKNOWN;
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

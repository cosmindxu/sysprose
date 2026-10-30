/**
 * The shape of an encoded term, read from its bytes.
 *
 * z3 checks the `set-logic` line against the SYNTAX of the assertions, not
 * against anybody's reasoning about which variables are pinned, so the one fact
 * a script must get right is read from the text the encoder emitted. This file
 * is that reading, and nothing else: pure, no import from anywhere in the
 * semantics, because {@link ./encode} is imported by half of the lane and a
 * dependency on the lane's contracts from here would be a cycle.
 *
 * It is a COPY for now. `encode.ts` still carries its own `parseSexps`,
 * `carriesSymbol` and `nonlinearSexp`; the parity fuzz in
 * `test/unit/semantics.smt-encode.test.ts` holds the two to one answer on the
 * `set-logic` line, and the step that follows swaps `encode.ts` onto this file
 * and deletes the originals. Until then a change to one is a change to both.
 *
 * Two inputs decide the answer and only one of them is in the bytes. A term
 * `a * (b ^ 0)` encodes to `(* a 1.0)`, which no scan calls nonlinear, and the
 * encoder's walk still flags it, because the walk saw two variables under a
 * product before the exponent erased one. The script's logic follows the walk's
 * flag as well as the bytes, so {@link ShapeHint.syntacticNonlinear} is an
 * input and not an optimisation.
 */

/** An S-expression: a quoted-or-bare atom, or an application. */
export type Sexp = string | Sexp[];

/** Tokenise and nest. `|a::b|` is one atom, pipes included. */
export function parseSexps(text: string): Sexp[] {
  const stack: Sexp[][] = [[]];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '(') {
      const child: Sexp[] = [];
      stack[stack.length - 1].push(child);
      stack.push(child);
      i += 1;
    } else if (c === ')') {
      if (stack.length > 1) stack.pop();
      i += 1;
    } else if (c === '|') {
      const end = text.indexOf('|', i + 1);
      if (end === -1) return stack[0];
      stack[stack.length - 1].push(text.slice(i, end + 1));
      i = end + 1;
    } else if (/\s/.test(c)) {
      i += 1;
    } else {
      let j = i;
      while (j < text.length && !/[\s()|]/.test(text[j])) j += 1;
      stack[stack.length - 1].push(text.slice(i, j));
      i = j;
    }
  }
  return stack[0];
}

/** Does this sub-term carry a variable, as opposed to only literals? */
export function carriesSymbol(s: Sexp): boolean {
  // The head of an application is an operator (`-`, `to_real`, `ite`), never a
  // variable, so `(- 3.0)` and `(/ 37.0 2.0)` are literals and are skipped.
  if (Array.isArray(s)) return s.slice(1).some(carriesSymbol);
  return !/^[+-]?\d/.test(s) && s !== 'true' && s !== 'false';
}

/** Is this sub-term, or anything under it, nonlinear in its syntax? */
export function nonlinearSexp(s: Sexp): boolean {
  if (!Array.isArray(s) || s.length === 0) return false;
  const head = s[0];
  const args = s.slice(1);
  if (head === '*' && args.filter(carriesSymbol).length >= 2) return true;
  if (head === '/' && args.slice(1).some(carriesSymbol)) return true;
  if (head === '^') return true;
  return s.some(nonlinearSexp);
}

/** The bits of {@link ShapeFacts.mask}: which operators the bytes use. */
export const SHAPE_BITS = {
  /** An arithmetic head: `+ - * / ^`. */
  ARITH: 1,
  /** A product with at least one symbol-carrying operand. */
  MUL_SYM: 2,
  /** A division whose divisor carries a symbol. */
  DIV_SYM: 4,
  /** A `^` head. */
  POW: 8,
  /** An `ite` head. */
  ITE: 16,
  /** A `to_real` head: an `Int` symbol was read. */
  TO_REAL: 32,
} as const;

/** The variable a term may mention: the two fields the shape reads. */
export interface ShapeVariable {
  qualifiedName: string;
  sort: string;
}

/** What the bytes cannot say, from the encoder that wrote them. */
export interface ShapeHint {
  /** `EncodedRelation.syntacticNonlinear`: the walk's flag, which can outlive the bytes. */
  syntacticNonlinear: boolean;
  /** Did the encoding add a `≠ 0` guard? Implies a variable divisor, hence nonlinear. */
  hasSideConditions: boolean;
  /** `EncodedRelation.reads`: the variables the body read, dropped reads included. */
  reads: readonly string[];
}

/** What {@link shapeOfTerm} reads out of one script's worth of terms. */
export interface ShapeFacts {
  /** Which operators the bytes use: the {@link SHAPE_BITS}. */
  mask: number;
  /** Does any declared `Int` symbol occur in the bytes? */
  int: boolean;
  /** Did the encoding add a `≠ 0` guard? */
  guarded: boolean;
  /** The walk's flag or the bytes' scan: exactly when the logic line says N. */
  nonlinear: boolean;
  /** The qualified names of the symbols the bytes carry, sorted. */
  symbols: string[];
  /**
   * The qualified names under the nonlinear sites, sorted.
   *
   * When the walk flags the term nonlinear and no nonlinear site survives in
   * the bytes (the `^ 0` cases) this is every symbol of the term, the dropped
   * reads included: the weaker of the two readings.
   */
  nlSymbols: string[];
}

/** A qualified name as the quoted symbol the encoder writes, or `undefined` when it cannot be one. */
function quotedSymbol(qualifiedName: string): string | undefined {
  if (qualifiedName.includes('|') || qualifiedName.includes('\\')) return undefined;
  return `|${qualifiedName}|`;
}

/**
 * Read the shape of one term, or of the terms of one script.
 *
 * `vars` is the environment the script is built from; only the variables the
 * bytes mention count, found the way the script declares them, so a variable
 * the body read and the bytes dropped is not part of the answer.
 *
 * `text` is every assertion of the script, the `≠ 0` guards included: a
 * guard keeps the symbols of its divisor when a `^ 0` has erased the term that
 * held them, and the script declares (and so types) them. Passing the goal
 * term alone answers a question about the goal and not about the script.
 */
export function shapeOfTerm(
  text: string | readonly string[],
  vars: readonly ShapeVariable[],
  hint: ShapeHint,
): ShapeFacts {
  const terms = typeof text === 'string' ? [text] : text;
  const quoted = new Set<string>();
  const literal: string[] = [];
  for (const t of terms) {
    if (t.includes('"')) literal.push(t);
    else for (const m of t.matchAll(/\|[^|]*\|/g)) quoted.add(m[0]);
  }
  const carried = new Map<string, ShapeVariable>();
  for (const v of vars) {
    const symbol = quotedSymbol(v.qualifiedName);
    if (symbol === undefined) continue;
    if (quoted.has(symbol) || literal.some((t) => t.includes(symbol))) carried.set(symbol, v);
  }

  let mask = 0;
  let scanNonlinear = false;
  const nl = new Set<string>();
  const symbolsUnder = (s: Sexp): void => {
    if (Array.isArray(s)) for (const c of s) symbolsUnder(c);
    else if (carried.has(s)) nl.add(carried.get(s)!.qualifiedName);
  };
  const walk = (s: Sexp): void => {
    if (!Array.isArray(s) || s.length === 0) return;
    const head = s[0];
    const args = s.slice(1);
    if (head === '+' || head === '-' || head === '*' || head === '/' || head === '^') mask |= SHAPE_BITS.ARITH;
    if (head === 'ite') mask |= SHAPE_BITS.ITE;
    if (head === 'to_real') mask |= SHAPE_BITS.TO_REAL;
    let site = false;
    if (head === '*') {
      if (args.some(carriesSymbol)) mask |= SHAPE_BITS.MUL_SYM;
      if (args.filter(carriesSymbol).length >= 2) site = true;
    }
    if (head === '/' && args.slice(1).some(carriesSymbol)) {
      mask |= SHAPE_BITS.DIV_SYM;
      site = true;
    }
    if (head === '^') {
      mask |= SHAPE_BITS.POW;
      site = true;
    }
    if (site) {
      scanNonlinear = true;
      symbolsUnder(s);
    }
    for (const c of s) walk(c);
  };
  for (const t of terms) for (const s of parseSexps(t)) walk(s);

  const nonlinear = hint.syntacticNonlinear || scanNonlinear;
  const symbols = [...carried.values()].map((v) => v.qualifiedName).sort();
  // A walk flag with no site left in the bytes: name every symbol the body read.
  const nlSymbols = !nonlinear
    ? []
    : scanNonlinear
      ? [...nl].sort()
      : [...new Set([...symbols, ...hint.reads])].sort();
  return {
    mask,
    int: [...carried.values()].some((v) => v.sort === 'Int'),
    guarded: hint.hasSideConditions,
    nonlinear,
    symbols,
    nlSymbols,
  };
}

/**
 * The `set-logic` line a shape stands for.
 *
 * An `Int` declaration puts a script in the mixed integer/real fragment, and a
 * nonlinear site puts it in the nonlinear one; the four names are the four
 * cells. `int` defaults to the shape's own and is a parameter so a caller that
 * declares more than the bytes carry can say so.
 */
export function logicFromShape(shape: ShapeFacts, int: boolean = shape.int): string {
  if (int) return shape.nonlinear ? 'QF_NIRA' : 'QF_LIRA';
  return shape.nonlinear ? 'QF_NRA' : 'QF_LRA';
}

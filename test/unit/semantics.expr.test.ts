import { describe, it, expect } from 'vitest';
import { parseExpr, evaluate } from '../../src/semantics/index';
import { exprEqual, exprRef, writtenChains } from '../../src/semantics/expr';

/** Evaluate a source string against an optional variable map. */
function evalStr(src: string, vars: Record<string, unknown> = {}): unknown {
  const r = evaluate(parseExpr(src), (name) => (name in vars ? vars[name] : undefined));
  return 'value' in r ? r.value : Symbol.for('unknown');
}

const UNKNOWN = Symbol.for('unknown');

describe('semantics — expression parser + evaluator', () => {
  it('respects arithmetic precedence: 2 + 3 * 4 === 14', () => {
    expect(evalStr('2 + 3 * 4')).toBe(14);
  });

  it('handles parentheses and scope: (a + b)', () => {
    expect(evalStr('(a + b)', { a: 3, b: 4 })).toBe(7);
    expect(evalStr('(a + b) * 2', { a: 3, b: 4 })).toBe(14);
  });

  it('right-associative exponentiation', () => {
    expect(evalStr('2 ^ 3 ^ 2')).toBe(512); // 2^(3^2)
  });

  it('evaluates boolean logic: true and (1 < 2)', () => {
    expect(evalStr('true and (1 < 2)')).toBe(true);
    expect(evalStr('false or (2 < 1)')).toBe(false);
    expect(evalStr('not (1 == 1)')).toBe(false);
    expect(evalStr('true xor false')).toBe(true);
    expect(evalStr('false implies true')).toBe(true);
    expect(evalStr('true implies false')).toBe(false);
  });

  it('evaluates comparisons', () => {
    expect(evalStr('3 <= 3')).toBe(true);
    expect(evalStr('3 < 3')).toBe(false);
    expect(evalStr('5 >= 2')).toBe(true);
    expect(evalStr('5 != 2')).toBe(true);
  });

  it('lexes a lone `=` as a distinct operator, not silently folded to `==` (finding L3)', () => {
    const node = parseExpr('a = b');
    expect(node.kind).toBe('binary');
    expect((node as { op: string }).op).toBe('='); // was silently rewritten to '=='
    // `==` remains its own distinct operator.
    expect((parseExpr('a == b') as { op: string }).op).toBe('==');
    // Evaluator keeps lenient equality for `=`, so evaluation behaviour is unchanged.
    expect(evalStr('a = b', { a: 1, b: 1 })).toBe(true);
    expect(evalStr('a = b', { a: 1, b: 2 })).toBe(false);
  });

  it('conditional: if 1 < 2 then 10 else 0 === 10', () => {
    expect(evalStr('if 1 < 2 then 10 else 0')).toBe(10);
    expect(evalStr('if 1 > 2 then 10 else 0')).toBe(0);
  });

  it('unary minus and mixed expressions', () => {
    expect(evalStr('-5 + 3')).toBe(-2);
    expect(evalStr('10 % 3')).toBe(1);
  });

  it('string literals and concatenation', () => {
    expect(evalStr('"foo" + "bar"')).toBe('foobar');
    expect(evalStr('"n=" + 5')).toBe('n=5');
    expect(evalStr('"a" == "a"')).toBe(true);
  });

  it('a single-quoted unrestricted name is a reference, never a string (a string is double-quoted)', () => {
    // 'max load' and 'ref' are names; the scope answers them unquoted, as `declaredName` holds them.
    expect(evalStr("'max load' <= 10.0", { 'max load': 25 })).toBe(false);
    expect(evalStr("'ref' == a * b", { ref: 6, a: 2, b: 3 })).toBe(true);
    expect(evalStr("'ref' == 5")).toBe(UNKNOWN); // no value in scope: unknown, never the string 'ref' compared with 5
    expect(evalStr('"max load" == "max load"')).toBe(true);
    expect(evalStr('"max load" == 5', { 'max load': 5 })).toBe(false); // a double-quoted string stays a string
    // a keyword-like word is a name once quoted, and a path may mix plain and quoted segments
    expect(evalStr("'true' and 'not'", { true: true, not: true })).toBe(true);
    expect(evalStr("'a b'.'c d' + x.'in'", { 'a b.c d': 40, 'x.in': 2 })).toBe(42);
    expect(parseExpr("'a b'.'c d'")).toEqual({ kind: 'ref', path: ['a b', 'c d'] });
    expect(parseExpr("'it\\'s'")).toEqual({ kind: 'ref', path: ["it's"] });
  });

  it('a quoted name holding `.` or `:`, or nothing, is not read (it would join like a path)', () => {
    expect(() => parseExpr("'a.b' + 1")).toThrow(/quoted name/);
    expect(() => parseExpr("'A::b' + 1")).toThrow(/quoted name/);
    expect(() => parseExpr("'' + 1")).toThrow(/quoted name/);
    expect(() => parseExpr("'open + 1")).toThrow(/Unterminated/);
  });

  it('exprRef spells a name the way an expression reads it back', () => {
    expect(exprRef('x')).toBe('x');
    expect(exprRef('a.b')).toBe('a.b');
    expect(exprRef('max load.in')).toBe("'max load'.in"); // `in` is no keyword of the expression lexers
    expect(exprRef('x.if')).toBe("x.'if'");
    expect(exprRef('true')).toBe("'true'");
    expect(parseExpr(exprRef('max load.c d'))).toEqual({ kind: 'ref', path: ['max load', 'c d'] });
    expect(writtenChains("f('a b'.c, d.e) + 'g h'")).toEqual(['f', "'a b'.c", 'd.e', "'g h'"]);
  });

  it('dotted feature-chain references resolve via scope', () => {
    expect(evalStr('a.b.c + 1', { 'a.b.c': 41 })).toBe(42);
  });

  it('returns unknown when a referenced name has no value', () => {
    expect(evalStr('x + 1')).toBe(UNKNOWN);
    expect(evalStr('missing < 10')).toBe(UNKNOWN);
  });

  it('short-circuits logical operators around unknowns', () => {
    // false and <unknown> === false; true or <unknown> === true
    expect(evalStr('false and x')).toBe(false);
    expect(evalStr('true or x')).toBe(true);
    // but unknown genuinely propagates when it matters
    expect(evalStr('true and x')).toBe(UNKNOWN);
  });

  it('produces a well-formed AST for a compound expression', () => {
    const ast = parseExpr('a + b * 2');
    expect(ast.kind).toBe('binary');
    // top node is '+', right child is '*'
    if (ast.kind === 'binary') {
      expect(ast.op).toBe('+');
      expect(ast.right.kind).toBe('binary');
    }
  });

  it('throws on malformed input', () => {
    expect(() => parseExpr('1 +')).toThrow();
    expect(() => parseExpr('(1 + 2')).toThrow();
  });

  it('exprEqual compares two trees node for node, every numeral as written', () => {
    const same = (a: string, b: string) => exprEqual(parseExpr(a), parseExpr(b));
    expect(same('(x + y) * 2.0', '(x+y)*2.0')).toBe(true);
    expect(same('if a > 1 then p.q else -r', 'if a > 1 then p.q else -r')).toBe(true);
    expect(same('x + y', 'y + x')).toBe(false);
    expect(same('x * 2.0', 'x * 2.5')).toBe(false);
    expect(same('x - y', 'x + y')).toBe(false);
    expect(same('p.q', 'p.r')).toBe(false);
    // Two numerals one double: past fifteen digits the numeral written decides.
    expect(same('0.3', '0.29999999999999999')).toBe(false);
  });
});

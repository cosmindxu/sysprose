import { describe, it, expect } from 'vitest';
import { parseExpr, evaluate } from '../../src/semantics/index';

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
});

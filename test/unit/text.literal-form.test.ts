/**
 * Numeric literal form survives the round-trip.
 *
 * `terminal NUMBER returns number` erases the written form before the mapper
 * runs, so `1500.0` used to re-serialize as `1500` and `1e3` as `1000`. The
 * number stays a number in `attrs.value` (the solver, units, conformance and
 * queries read it); the lexeme rides beside it in `attrs.valueText` and is
 * honoured only while it still denotes the same number.
 */
import { describe, it, expect } from 'vitest';
import { parseModel, serializeModel } from '@text/index';

function attrOf(src: string, name: string) {
  const m = parseModel(src).model;
  return m.all().find((e) => e.declaredName === name)!;
}

describe('numeric literal form', () => {
  it.each([
    ['1500.0', 1500],
    ['1e3', 1000],
    ['007', 7],
    ['2.50', 2.5],
  ])('keeps %s as written while storing the number %s', (lexeme, num) => {
    const src = `package P { attribute a : Real = ${lexeme}; }\n`;
    const a = attrOf(src, 'a');
    expect(a.attrs.value).toBe(num);
    expect(a.attrs.valueText).toBe(lexeme);
    expect(serializeModel(parseModel(src).model)).toContain(`= ${lexeme};`);
  });

  it('writes no valueText when String(value) already reproduces the source', () => {
    const a = attrOf('package P { attribute a : Real = 42; }\n', 'a');
    expect(a.attrs.value).toBe(42);
    expect(a.attrs.valueText).toBeUndefined();
  });

  // The NUMBER terminal is unsigned and the sign is a unary operator, so a
  // signed literal reaches the mapper as a UnaryExpr over a NumberLiteral. It
  // still denotes a number: fold it, and keep the lexeme beside it exactly as
  // for the unsigned rows above.
  it.each([
    ['-2.50', -2.5],
    ['+3', 3],
    ['-1e3', -1000],
    ['-0', -0],
  ])('folds the signed literal %s to the number %s and keeps the lexeme', (lexeme, num) => {
    const src = `package P { attribute a : Real = ${lexeme}; }\n`;
    const a = attrOf(src, 'a');
    expect(a.attrs.value).toBe(num);
    expect(a.attrs.valueText).toBe(lexeme);
    expect(serializeModel(parseModel(src).model)).toContain(`= ${lexeme};`);
  });

  it('writes no valueText for a signed literal String(value) already reproduces', () => {
    const a = attrOf('package P { attribute a : Integer = -3; }\n', 'a');
    expect(a.attrs.value).toBe(-3);
    expect(a.attrs.valueText).toBeUndefined();
  });

  it('folds `- 2` (interior space) to -2 and re-emits it without the space', () => {
    // Number('- 2') is NaN, so the lexeme cannot be kept: the serializer would
    // reject it anyway, and storing it would break parse → serialize → parse.
    const src = 'package P { attribute a : Real = - 2; }\n';
    const a = attrOf(src, 'a');
    expect(a.attrs.value).toBe(-2);
    expect(a.attrs.valueText).toBeUndefined();
    expect(serializeModel(parseModel(src).model)).toContain('= -2;');
  });

  // Only a sign directly on a bare number is a literal. Everything else a
  // UnaryExpr can wrap stays the author's expression, verbatim — including
  // `-(2)`, whose operand IS a NumberLiteral in the AST because parentheses
  // are transparent; the digit-start test on the operand's text keeps it out.
  it.each([['-x'], ['--2'], ['-(2)'], ['not true'], ['~x'], ['5 - 2'], ['~2'], ['not 2']])(
    'keeps %s as an expression string',
    (expr) => {
      const a = attrOf(`package P { attribute x = 1; attribute a = ${expr}; }\n`, 'a');
      expect(a.attrs.value).toBe(expr);
      expect(a.attrs.valueText).toBeUndefined();
    },
  );

  it('folds `(-2)` because the parentheses wrap the whole signed literal', () => {
    // The asymmetry with `-(2)` is deliberate: here the operand's own text is
    // `2`, so the sign sits directly on a bare number. The stale lexeme
    // `(-2)` is not a number, so it is dropped and `-2` is re-emitted —
    // exactly what `(2.50)` does today.
    const src = 'package P { attribute a : Real = (-2); }\n';
    const a = attrOf(src, 'a');
    expect(a.attrs.value).toBe(-2);
    expect(a.attrs.valueText).toBeUndefined();
    expect(serializeModel(parseModel(src).model)).toContain('= -2;');
  });

  it('recovers a dangling sign as a parse error instead of throwing', () => {
    // Error recovery hands the mapper a UnaryExpr with no operand; the fold
    // must not dereference it. The value stays the verbatim text, the parse
    // diagnostic keeps its position, and the siblings survive.
    const src = 'package P {\n  attribute a = -;\n  attribute b = 1;\n}\n';
    const { model, diagnostics } = parseModel(src);
    const parseErrors = diagnostics.filter((d) => d.code?.startsWith('parse/'));
    expect(parseErrors.length).toBeGreaterThan(0);
    expect(parseErrors[0].line).toBe(2);
    expect(parseErrors[0].range).toBeDefined();
    expect(diagnostics.some((d) => d.code === 'import/internal-error')).toBe(false);
    const names = model.all().map((e) => e.declaredName);
    expect(names).toEqual(expect.arrayContaining(['P', 'a', 'b']));
    expect(attrOf(src, 'a').attrs.value).toBe('-');
    expect(attrOf(src, 'b').attrs.value).toBe(1);
  });

  it('ignores a lexeme that no longer denotes the value', () => {
    const { model } = parseModel('package P { attribute a : Real = 1500.0; }\n');
    const a = model.all().find((e) => e.declaredName === 'a')!;
    // Programmatic edit through the model, the way the SDK or a collaborator would.
    model.setAttrs(a.id, { value: 99 });
    expect(serializeModel(model)).toContain('= 99;');
    expect(serializeModel(model)).not.toContain('1500.0');
  });

  it('survives parse → serialize → parse unchanged', () => {
    const src = 'package P { attribute a : Real = 1500.0; attribute b = 1e3; }\n';
    const once = serializeModel(parseModel(src).model);
    const twice = serializeModel(parseModel(once).model);
    expect(twice).toBe(once);
    expect(once).toContain('= 1500.0;');
    expect(once).toContain('= 1e3;');
  });

  it('keeps the shipped example\'s literals as the author wrote them', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('examples/vehicle.sysml', 'utf8');
    const out = serializeModel(parseModel(src).model);
    for (const lit of ['= 1500.0;', '= 220.0;', '= 150.0;']) expect(out).toContain(lit);
  });
});

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

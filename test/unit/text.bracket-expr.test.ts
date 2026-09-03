/**
 * The spec BracketExpression (`<magnitude> [ <unit> ]`) through the mapper and
 * the serializer.
 *
 * `[` is an ordinary postfix operator in SysML v2 (KerML BNF 1099-1102,
 * `BaseFunctions::'['`), so a unit literal may sit anywhere an expression may.
 * The model contract is unchanged: a top-level bracket on a feature value folds
 * to a numeric `attrs.value` + `attrs.unit` (finding D1/H11 keeps the unit out
 * of `attrs.multiplicity`), a nested bracket stays verbatim expression text, and
 * the serializer re-emits a unit as a lexeme the grammar reads back.
 */
import { describe, it, expect } from 'vitest';
import { Model } from '@core/index';
import { parseModel, serializeModel } from '@text/index';
import { importFmiXml } from '../../src/interop/fmi/import';

function attrOf(src: string, name: string) {
  const r = parseModel(src);
  const el = r.model.all().find((e) => e.declaredName === name);
  if (!el) throw new Error(`no element ${name}; diagnostics: ${JSON.stringify(r.diagnostics)}`);
  return { el, r };
}

function roundTrip(src: string): string {
  const first = parseModel(src);
  expect(first.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const text = serializeModel(first.model);
  const second = parseModel(text);
  expect(second.diagnostics.filter((d) => d.severity === 'error'), text).toEqual([]);
  expect(serializeModel(second.model)).toBe(text);
  return text;
}

describe('bracket expression — feature value fold', () => {
  it('folds `18.5 [kg]` to a number and a unit', () => {
    const { el } = attrOf('package P { attribute m : ISQ::MassValue = 18.5 [kg]; }', 'm');
    expect(el.attrs.value).toBe(18.5);
    expect(el.attrs.unit).toBe('kg');
    expect(el.attrs.valueText).toBeUndefined();
    expect(el.attrs.multiplicity).toBeUndefined();
  });

  it('keeps the numeric lexeme beside the folded value', () => {
    const { el } = attrOf('package P { attribute m : Real = 1500.0 [kg]; }', 'm');
    expect(el.attrs.value).toBe(1500);
    expect(el.attrs.valueText).toBe('1500.0');
    expect(serializeModel(parseModel('package P { attribute m : Real = 1500.0 [kg]; }').model)).toContain(
      '= 1500.0 [kg]',
    );
  });

  it.each([
    ['-5 [m]', -5, undefined],
    ['-2.50 [m]', -2.5, '-2.50'],
    ['+3 [m]', 3, '+3'],
  ])('folds the signed literal %s under the bracket', (lexeme, num, valueText) => {
    const src = `package P { attribute d : Real = ${lexeme}; }\n`;
    const { el } = attrOf(src, 'd');
    expect(el.attrs.value).toBe(num);
    expect(el.attrs.unit).toBe('m');
    expect(el.attrs.valueText).toBe(valueText);
    expect(serializeModel(parseModel(src).model)).toContain(`= ${lexeme};`);
  });

  it('keeps a non-literal magnitude as expression text with the unit split off', () => {
    const { el } = attrOf('package P { attribute d : Real = (1 + 2) [m]; }', 'd');
    expect(el.attrs.value).toBe('(1 + 2)');
    expect(el.attrs.unit).toBe('m');
  });

  it.each([
    ["18 ['in']", 'in'],
    ['5 [SI::kg]', 'SI::kg'],
    ["1 [SI::'watt hour']", 'SI::watt hour'],
    ['3 [m/s]', 'm/s'],
    ['3 [m / s]', 'm/s'],
    ['2 [W*h]', 'W*h'],
    ['9.81 [m/s^2]', 'm/s^2'],
    ['4 [mRef.mRefs#(1)]', 'mRef.mRefs#(1)'],
    // A reference keeps its separators as written: `.` is not rewritten to
    // `::`, only quotes and whitespace go.
    ['5 [a.b]', 'a.b'],
    ['5 [SI :: kg]', 'SI::kg'],
  ])('stores the unit of `%s` as %s', (value, unit) => {
    const { el } = attrOf(`package P { attribute d : Real = ${value}; }`, 'd');
    expect(el.attrs.unit).toBe(unit);
  });

  it('keeps a declaration multiplicity apart from the value unit', () => {
    const { el } = attrOf('package P { attribute d : Real [3] = 1500 [kg]; }', 'd');
    expect(el.attrs.multiplicity).toBe('3');
    expect(el.attrs.unit).toBe('kg');
    expect(el.attrs.value).toBe(1500);
  });

  it('keeps a nested bracket verbatim in the expression text', () => {
    const a = attrOf('package P { attribute d : Real = 229835/900 [K]; }', 'd').el;
    expect(a.attrs.value).toBe('229835/900 [K]');
    expect(a.attrs.unit).toBeUndefined();
    const b = attrOf('package P { attribute d : Real = 2 * 3 [kg]; }', 'd').el;
    expect(b.attrs.value).toBe('2 * 3 [kg]');
    expect(b.attrs.unit).toBeUndefined();
  });

  it('stores the unit of an assign / return / entry value', () => {
    const src = `package P {
      action def A { assign x := 5 [kg]; }
      calc def C { return r = 6 [kg]; }
      state def S { entry e = 7 [kg]; }
    }`;
    const { r } = attrOf(src, 'x');
    const byName = (n: string) => r.model.all().find((e) => e.declaredName === n)!;
    expect(byName('x').attrs.value).toBe(5);
    expect(byName('x').attrs.unit).toBe('kg');
    expect(byName('r').attrs.value).toBe(6);
    expect(byName('r').attrs.unit).toBe('kg');
    expect(byName('e').attrs.value).toBe(7);
    expect(byName('e').attrs.unit).toBe('kg');
    const text = roundTrip(src);
    expect(text).toContain('assign x := 5 [kg]');
    expect(text).toContain('return r = 6 [kg]');
    expect(text).toContain('entry e = 7 [kg]');
  });

  it('keeps the source unit when the lexer skipped a character inside the bracket', () => {
    // `²` is not a token; the lexer reports it and drops it, so the parser sees
    // `[m]`. Persisting `m` would silently change the dimension — the unit is
    // sliced from the source instead, and the lexer error is still reported.
    const { el, r } = attrOf('package P { attribute a : Real = 4.0 [m²]; }', 'a');
    expect(el.attrs.value).toBe(4);
    expect(el.attrs.unit).toBe('m²');
    expect(r.diagnostics.map((d) => d.code)).toContain('lexer/illegal-char');
  });
});

describe('bracket expression — recovery never throws', () => {
  // An unfinished unit bracket is a routine mid-edit state. The parser
  // recovers with the bracket's operand unset; the mapper must turn that into
  // the positioned parse error and nothing else — a throw here surfaced as
  // `import/internal-error` and cost the agent the whole file.
  it.each([
    ['an empty bracket', 'attribute a = 5 [];'],
    ['an unclosed bracket', 'attribute a = 5 [;'],
    ['a bracket holding a control-node keyword', 'attribute a = 5 [initial];'],
    ['a bracket holding `fork`', 'attribute a = 5 [fork];'],
    ['an empty bracket after a signed literal', 'attribute a = -5 [];'],
    ['an empty bracket on an assign value', 'action def A { assign a := 5 []; }'],
    ['an empty bracket on a return value', 'calc def C { return a = 5 []; }'],
    ['an empty bracket on an entry value', 'state def S { entry a = 5 []; }'],
  ])('reports %s as a parse error and keeps the value', (_what, member) => {
    const src = `package P { ${member} attribute b = 1; }`;
    expect(() => parseModel(src)).not.toThrow();
    const r = parseModel(src);
    expect(r.diagnostics.filter((d) => d.severity === 'error').length).toBeGreaterThan(0);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('import/internal-error');
    const a = r.model.all().find((e) => e.declaredName === 'a')!;
    expect(Math.abs(a.attrs.value as number)).toBe(5);
    expect(a.attrs.unit).toBeUndefined();
    // The sibling after the fault survives (L5: one bad declaration must not
    // cost the others).
    expect(r.model.all().find((e) => e.declaredName === 'b')?.attrs.value).toBe(1);
  });

  it('an unclosed bracket at the end of the body is a parse error, not a crash', () => {
    expect(() => parseModel('package P { attribute a = 5 [ }')).not.toThrow();
    const r = parseModel('package P { attribute a = 5 [ }');
    expect(r.diagnostics.filter((d) => d.severity === 'error').length).toBeGreaterThan(0);
    expect(r.model.all().find((e) => e.declaredName === 'a')?.attrs.value).toBe(5);
  });

  it('a numeric range after a value is a bracket operand stored verbatim', () => {
    // Only `*` is not an expression, so `[0..*]` / `[*]` are parse errors
    // (pinned in langium.grammar.test.ts); `[1..2]` parses, lands in
    // `attrs.unit` as written and re-emits quoted so it reads back.
    const src = 'package P { attribute a : Real = 1500 [1..2]; }';
    const { el, r } = attrOf(src, 'a');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(el.attrs.value).toBe(1500);
    expect(el.attrs.unit).toBe('1..2');
    expect(roundTrip(src)).toContain("= 1500 ['1..2']");
  });
});

describe('bracket expression — constraint bodies', () => {
  it('a unit literal inside a constraint body is kept verbatim', () => {
    const src = `package P {
      part def UAV { attribute mtow : ISQ::MassValue = 18.5 [kg]; }
      requirement def R { subject uav : UAV; require constraint { uav.mtow <= 25.0 [kg] } }
    }`;
    const { r } = attrOf(src, 'R');
    const c = r.model.all().find((e) => e.eClass === 'ConstraintUsage')!;
    expect(c.attrs.expression).toBe('uav.mtow <= 25.0 [kg]');
    expect(roundTrip(src)).toContain('uav.mtow <= 25.0 [kg]');
  });
});

describe('bracket expression — serializer unit lexeme', () => {
  it.each([
    ['kg', '[kg]'],
    ['SI::kg', '[SI::kg]'],
    ['m/s', '[m/s]'],
    ['W*h', '[W*h]'],
    ['m^2', '[m^2]'],
    ['Mbit/s', '[Mbit/s]'],
    ['mRef.mRefs#(1)', '[mRef.mRefs#(1)]'],
    ['in', "['in']"],
    ['W⋅h', "['W⋅h']"],
    ['m²', "['m²']"],
    ['SI::watt hour', "[SI::'watt hour']"],
    // `initial` leads a control node; bare `[initial]` is a parse error.
    ['initial', "['initial']"],
  ])('emits the unit %s as %s and reads it back', (unit, lexeme) => {
    const m = new Model();
    const pkg = m.create('Package', { declaredName: 'P' });
    m.create('AttributeUsage', { declaredName: 'a', ownerId: pkg.id, attrs: { type: 'Real', value: 1, unit } });
    const text = serializeModel(m);
    expect(text).toContain(`= 1 ${lexeme};`);
    const back = parseModel(text);
    expect(back.diagnostics.filter((d) => d.severity === 'error'), text).toEqual([]);
    expect(back.model.all().find((e) => e.declaredName === 'a')!.attrs.unit).toBe(unit);
  });

  it('round-trips an FMI `m/s` unit through the notation', () => {
    const xml = `<?xml version="1.0"?>
<fmiModelDescription fmiVersion="3.0" modelName="Car">
  <ModelVariables>
    <Float64 name="v" valueReference="0" causality="input" variability="continuous" start="3" unit="m/s"/>
  </ModelVariables>
</fmiModelDescription>`;
    const m = new Model();
    importFmiXml(m, xml);
    const text = serializeModel(m);
    expect(text).toContain('[m/s]');
    const back = parseModel(text);
    expect(back.diagnostics.filter((d) => d.severity === 'error'), text).toEqual([]);
    expect(back.model.all().find((e) => e.declaredName === 'v')!.attrs.unit).toBe('m/s');
  });

  it('round-trips an FMI unit the grammar cannot read bare', () => {
    // `m/s` is bare-legal ASCII, so it round-trips whether or not the
    // serializer quotes. A `⋅`/`²` unit is the case that needs the quoting:
    // an FMI file may carry one, and the notation must read it back.
    const xml = `<?xml version="1.0"?>
<fmiModelDescription fmiVersion="3.0" modelName="Plant">
  <ModelVariables>
    <Float64 name="e" valueReference="0" causality="parameter" variability="fixed" start="640" unit="W⋅h"/>
    <Float64 name="area" valueReference="1" causality="parameter" variability="fixed" start="2" unit="m²"/>
  </ModelVariables>
</fmiModelDescription>`;
    const m = new Model();
    importFmiXml(m, xml);
    const text = serializeModel(m);
    expect(text).toContain("['W⋅h']");
    expect(text).toContain("['m²']");
    const back = parseModel(text);
    expect(back.diagnostics.filter((d) => d.severity === 'error'), text).toEqual([]);
    const byName = (n: string) => back.model.all().find((e) => e.declaredName === n)!;
    expect(byName('e').attrs.unit).toBe('W⋅h');
    expect(byName('area').attrs.unit).toBe('m²');
  });
});

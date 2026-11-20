/**
 * SysML v2 §7.18 state forms beyond `entry; then X;` and the time trigger: each parses to what the notation says or is
 * refused with `mapper/state-form-unread`, never read as a different statement.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { serializeElement } from '@text/serializer';
import { edgeCensus } from '../../src/semantics/mc/explore';

const load = async (text: string): Promise<any> => loadModelText(text, { fileName: 'sf.sysml' });
const find = (model: any, n: string) => model.all().find((e: any) => model.qualifiedName(e.id) === n);
const codes = (r: any) => r.diagnostics.map((d: any) => d.code);
const errors = (r: any) => r.diagnostics.filter((d: any) => d.severity === 'error');
const wrap = (body: string, pre = '') => `package P {\n${pre}  state def M {\n${body}\n  }\n}\n`;

describe('guarded entry succession `entry; if c then off;`', () => {
  const text = wrap('    entry;\n    if 1 > 0 then off;\n    state off;\n    state on;');
  it('is read as a guarded succession from the entry action', async () => {
    const { model, report } = await load(text);
    expect(errors(report)).toEqual([]);
    const edge = model.all().find((e: any) => e.eClass === 'Succession' && e.attrs.entryTransition);
    expect(edge.attrs.guard).toBe('1 > 0');
  });
  it('round-trips with its guard', async () => {
    const { model } = await load(text);
    const out = serializeElement(model!, find(model, 'P').id);
    expect(out).toContain('if 1 > 0 then off;');
    const again = await load(out);
    expect(again.model.all().find((e: any) => e.attrs.entryTransition).attrs.guard).toBe('1 > 0');
  });
  it('the walk refuses the machine over the guarded start', async () => {
    const { model } = await load(text);
    const census: any = edgeCensus(model!, find(model, 'P::M').id);
    expect(JSON.stringify(census)).toContain('unaccounted');
  });
  it('an `if c then X` with no state before it and outside an entry succession is refused', async () => {
    const { report } = await load(wrap('    if 1 > 0 then on;\n    state on;'));
    expect(codes(report)).toContain('mapper/state-form-unread');
  });
});

describe('target-transition shorthand (OnOff5/6)', () => {
  it('is read as a transition out of the state before it (see text.target-transition.test.ts)', async () => {
    const { model, report } = await load(
      wrap('    entry; then off;\n    state off;\n    accept TurnOn via commPort then on;\n    state on;', '  item def TurnOn;\n  port commPort;\n'),
    );
    expect(codes(report).filter((c: string) => c.startsWith('mapper/'))).toEqual([]);
    expect(model.all().filter((e: any) => e.eClass === 'AcceptActionUsage' && !e.attrs.isLibrary)).toEqual([]);
    expect(model.all().filter((e: any) => e.eClass === 'TransitionUsage' && !e.attrs.isLibrary)).toHaveLength(1);
  });
  it('is refused, and the completing `then` with it, when no state comes before it', async () => {
    const { model, report } = await load(
      wrap('    entry; then off;\n    accept TurnOn via commPort then on;\n    state off;\n    state on;', '  item def TurnOn;\n  port commPort;\n'),
    );
    expect(codes(report).filter((c: string) => c.startsWith('mapper/'))).toEqual(['mapper/state-form-unread']);
    expect(model.all().filter((e: any) => e.eClass === 'AcceptActionUsage' && !e.attrs.isLibrary)).toEqual([]);
  });
  it('leaves `accept` inside a transition untouched', async () => {
    const { report } = await load(wrap('    entry; then s;\n    state s;\n    state t;\n    transition first s accept E if 1 < 0 then t;', '  item def E;\n'));
    expect(errors(report)).toEqual([]);
  });
});

describe('`entry action initial`', () => {
  it('names the entry action initial, with no control node', async () => {
    const { model, report } = await load(wrap('    entry action initial;\n    then off;\n    state off;'));
    expect(errors(report)).toEqual([]);
    expect(find(model, 'P::M::initial').attrs.stateSubaction).toBe('entry');
    expect(model.all().filter((e: any) => e.eClass === 'InitialNode')).toEqual([]);
    const edge = model.all().find((e: any) => e.attrs.entryTransition);
    expect(edge).toBeTruthy();
  });
});

describe('`entry assign x := 1;` and `do send X to Y;`', () => {
  const pre = '  attribute x : Integer;\n';
  it('reads `entry assign` as the long form reads it: a nameless entry action owning the assignment', async () => {
    const a = await load(wrap('    entry assign x := 1;\n    state off;', pre));
    const b = await load(wrap('    entry action { assign x := 1; }\n    state off;', pre));
    expect(errors(a.report)).toEqual([]);
    const shape = (m: any): any =>
      m.model.all().filter((e: any) => !e.attrs.isLibrary && (e.attrs.stateSubaction !== undefined || e.eClass === 'AssignmentActionUsage')).map((e: any) => [e.eClass, e.declaredName, e.attrs]);
    expect(shape(a)).toEqual(shape(b));
    expect(shape(a)).toHaveLength(2);
  });
  it('refuses `do send X to Y;`, not split into a nameless behaviour and a loose action', async () => {
    const { model, report } = await load(wrap('    do send X to Y;\n    state off;', pre));
    expect(codes(report)).toEqual(['mapper/state-form-unread']);
    expect(model.all().filter((e: any) => (e.attrs.actionKind === 'assign' || e.attrs.actionKind === 'send') && !e.attrs.isLibrary)).toEqual([]);
  });
  it('still reads the long form with a body', async () => {
    const { report } = await load(wrap('    entry action a { assign x := 1; }\n    state off;', pre));
    expect(errors(report)).toEqual([]);
  });
});

describe('exhibit forms', () => {
  it('refuses `exhibit A::B :> C;`', async () => {
    const { report } = await load('package P { part def A; part def C; part q { exhibit A::B :> C; } }');
    expect(codes(report)).toContain('mapper/state-form-unread');
  });
  it('keeps `exhibit state s :> C;` and `exhibit x;`', async () => {
    const { model, report } = await load('package P { part def C; part q { exhibit state s :> C; exhibit y; } }');
    expect(errors(report)).toEqual([]);
    expect(find(model, 'P::q::s').attrs.actionKind).toBe('exhibit');
    expect(find(model, 'P::q::y').attrs.actionKind).toBe('exhibit');
  });
  it('reads `abstract exhibit state x;` as one abstract exhibit, with no stray reference usage', async () => {
    const { model, report } = await load('package P { part def A { abstract exhibit state x; } }');
    expect(report.diagnostics).toEqual([]);
    const x = find(model, 'P::A::x');
    expect(x.attrs.actionKind).toBe('exhibit');
    expect(x.attrs.isAbstract).toBe(true);
    expect(model.all().filter((e: any) => e.eClass === 'ReferenceUsage' && e.ownerId === find(model, 'P::A').id)).toEqual([]);
    const again = await load(serializeElement(model!, find(model, 'P').id));
    expect(find(again.model, 'P::A::x').attrs.isAbstract).toBe(true);
  });
});

describe('guards and delays are not swallowed', () => {
  it('keeps `accept E if n < 0 then s`, `accept E [g] then s`, `accept after 5[min]`', async () => {
    for (const acc of ['accept E if 1 < 0', 'accept E [1 > 0]', 'accept after 5[min]']) {
      const { model, report } = await load(wrap(`    entry; then s;\n    state s;\n    state t;\n    transition first s ${acc} then t;`, '  item def E;\n'));
      expect(errors(report)).toEqual([]);
      const t = model.all().find((e: any) => e.eClass === 'TransitionUsage');
      expect(t.attrs.guard || t.attrs.timeTrigger).toBeTruthy();
    }
  });
});

/**
 * SysML v2 §7.18.3 target transitions (OnOff5/OnOff6): `state off; accept TurnOn via commPort then on;` is a transition
 * out of the state written just before. It reads as the long `transition first off accept … then on;`, round-trips,
 * and the walk and interpreter treat it as they treat that long form. Without a state to leave it is refused.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { serializeElement } from '@text/serializer';
import { runStateMachine } from '../../src/semantics/execute';
import { edgeCensus } from '../../src/semantics/mc/explore';

const load = async (text: string): Promise<any> => loadModelText(text, { fileName: 'tt.sysml' });
const find = (model: any, n: string) => model.all().find((e: any) => model.qualifiedName(e.id) === n);
const codes = (r: any) => r.diagnostics.map((d: any) => d.code);
const errors = (r: any) => r.diagnostics.filter((d: any) => d.severity === 'error');
const transitions = (model: any) => model.all().filter((e: any) => e.eClass === 'TransitionUsage' && !e.attrs.isLibrary);
const wrap = (body: string, pre = '') => `package P {\n  item def TurnOn;\n  item def E;\n  attribute n : Integer;\n  action eff;\n${pre}  state def M {\n${body}\n  }\n}\n`;
const nameOf = (model: any, id: any) => model.get(id)?.declaredName;

describe('target transition shorthand', () => {
  it('reads OnOff5-style `state off; accept TurnOn via commPort then on;` as a transition off -> on', async () => {
    const { model, report } = await load(wrap('    entry; then off;\n    state off;\n    accept TurnOn via commPort then on;\n    state on;\n    accept TurnOn then off;'));
    expect(errors(report)).toEqual([]);
    const ts = transitions(model);
    expect(ts).toHaveLength(2);
    expect(ts.map((t: any) => [nameOf(model, t.source[0]), t.attrs.trigger, nameOf(model, t.target[0])])).toEqual([
      ['off', 'TurnOn', 'on'],
      ['on', 'TurnOn', 'off'],
    ]);
    expect(model.all().filter((e: any) => e.attrs.actionKind === 'accept')).toEqual([]);
  });

  it('reads the guard, the effect and the time trigger forms', async () => {
    const { model, report } = await load(
      wrap('    entry; then off;\n    state off;\n    accept E if n < 0 then on;\n    accept after 5[min] then on;\n    accept E do action eff then on;\n    if n > 3 then on;\n    state on;'),
    );
    expect(errors(report)).toEqual([]);
    const ts = transitions(model);
    expect(ts).toHaveLength(4);
    expect(ts.every((t: any) => nameOf(model, t.source[0]) === 'off' && nameOf(model, t.target[0]) === 'on')).toBe(true);
    expect(ts[0].attrs).toMatchObject({ trigger: 'E', guard: 'n < 0' });
    expect(ts[1].attrs.timeTrigger).toBe('5[min]');
    expect(ts[1].attrs.trigger).toBeUndefined();
    expect(ts[2].attrs).toMatchObject({ trigger: 'E', effect: 'eff' });
    expect(ts[3].attrs).toMatchObject({ guard: 'n > 3' });
  });

  it('round-trips as the long form, with the model equal', async () => {
    const text = wrap('    entry; then off;\n    state off;\n    accept E if n < 0 do action eff then on;\n    state on;\n    accept after 2[s] then off;');
    const { model } = await load(text);
    const out = serializeElement(model!, find(model, 'P').id);
    expect(out).toContain('transition first off accept E');
    const again = await load(out);
    expect(errors(again.report)).toEqual([]);
    const key = (m: any) => transitions(m).map((t: any) => [nameOf(m, t.source[0]), nameOf(m, t.target[0]), t.attrs.trigger, t.attrs.timeTrigger, t.attrs.guard, t.attrs.effect]);
    expect(key(again.model)).toEqual(key(model));
    expect(key(model)).toHaveLength(2);
  });

  it('runs: the interpreter takes the event transition from the shorthand', async () => {
    const { model } = await load(wrap('    entry; then off;\n    state off;\n    accept TurnOn then on;\n    state on;'));
    const res = runStateMachine(model!, find(model, 'P::M').id, ['TurnOn']);
    expect(res.fired.map((f: any) => f.trigger)).toEqual(['TurnOn']);
    expect(res.finalState).toBe(find(model, 'P::M::on').id);
    const long = await load(wrap('    entry; then off;\n    state off;\n    transition first off accept TurnOn then on;\n    state on;'));
    const lres = runStateMachine(long.model!, find(long.model, 'P::M').id, ['TurnOn']);
    expect(lres.fired.map((f: any) => f.trigger)).toEqual(['TurnOn']);
  });

  it('a time-triggered shorthand is refused by the interpreter, and offered by the walk as a named event (S6), never a guessed clock', async () => {
    const { model } = await load(wrap('    entry; then off;\n    state off;\n    accept after 5[min] then on;\n    state on;'));
    const res = runStateMachine(model!, find(model, 'P::M').id, []);
    expect(res.complete).toBe(false);
    expect(res.unopened).toContain('time trigger');
    const rows = edgeCensus(model!, find(model, 'P::M').id).rows;
    expect(rows.some((r) => r.account === 'unaccounted')).toBe(false);
    expect(rows.some((r) => r.account === 'walked')).toBe(true);
  });

  it('the walk accounts for an event shorthand edge', async () => {
    const { model } = await load(wrap('    entry; then off;\n    state off;\n    accept TurnOn then on;\n    state on;'));
    const census: any = edgeCensus(model!, find(model, 'P::M').id);
    expect(JSON.stringify(census)).toContain('off');
  });
});

describe('target transition refusals', () => {
  it('no preceding state: refused with its `then`', async () => {
    const { model, report } = await load(wrap('    entry; then off;\n    accept TurnOn then on;\n    state off;\n    state on;'));
    expect(codes(report).filter((c: string) => c.startsWith('mapper/'))).toEqual(['mapper/state-form-unread']);
    expect(transitions(model)).toEqual([]);
  });

  it('no `then` target: refused', async () => {
    const { model, report } = await load(wrap('    state off;\n    accept TurnOn;\n    state on;'));
    expect(codes(report)).toContain('mapper/state-form-unread');
    expect(transitions(model)).toEqual([]);
  });

  it('`if c then X;` after the entry action stays the guarded entry succession; with nothing to leave it is refused', async () => {
    const a = await load(wrap('    entry;\n    if 1 > 0 then off;\n    state off;'));
    expect(errors(a.report)).toEqual([]);
    expect(a.model.all().find((e: any) => e.attrs.entryTransition).attrs.guard).toBe('1 > 0');
    const b = await load(wrap('    if 1 > 0 then off;\n    state off;'));
    expect(codes(b.report)).toContain('mapper/state-form-unread');
  });

  it('a delay after a payload name, or a guard/delay outside a state, is refused', async () => {
    const a = await load(wrap('    state off;\n    accept TurnOn 5[min] then on;\n    state on;'));
    expect(codes(a.report)).toContain('mapper/state-form-unread');
    const b = await load('package P { action def A { accept E if 1 > 0; } }\n');
    expect(codes(b.report)).toContain('mapper/state-form-unread');
  });

  it('a conditional expression body is not read as a statement', async () => {
    const { report } = await load('package P { calc def C { in a : Boolean; in b : Integer; in c : Integer; if a then b else c } }\n');
    expect(codes(report).filter((c: string) => c === 'mapper/state-form-unread')).toEqual([]);
  });
});

/**
 * SysML v2 §7.17.8 `accept sig : Signal` (the trigger is a transfer whose payload is a Signal; `sig` names the payload)
 * and §7.18.3 `then done` (the source state is the final state of the containing state). Both read, round-trip, and are
 * run/walked consistently, never dropped.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { serializeElement } from '@text/serializer';
import { runStateMachine } from '../../src/semantics/execute';
import { isFinalState } from '../../src/semantics/mc/config';
import { exploreMachine } from '../../src/semantics/mc/explore';

const load = async (text: string): Promise<any> => loadModelText(text, { fileName: 'pd.sysml' });
const find = (model: any, n: string) => model.all().find((e: any) => model.qualifiedName(e.id) === n);
const errors = (r: any) => r.diagnostics.filter((d: any) => d.severity === 'error');
const trs = (m: any) => m.all().filter((e: any) => e.eClass === 'TransitionUsage' && !e.attrs.isLibrary);
const wrap = (body: string) => `package P {\n  item def Sig;\n  state def M {\n${body}\n  }\n}\n`;

describe('accept p : T', () => {
  it('long form: trigger is the type, payloadName the name; run on [T] fires', async () => {
    const { model, report } = await load(wrap('    entry; then off;\n    state off;\n    state on;\n    transition first off accept s : Sig via port then on;'));
    expect(errors(report)).toEqual([]);
    const [t] = trs(model);
    expect([t.attrs.trigger, t.attrs.payloadName, t.attrs.via]).toEqual(['Sig', 's', 'port']);
    const id = find(model, 'P::M').id;
    expect(runStateMachine(model, id, ['Sig']).finalState).toBe(find(model, 'P::M::on').id);
    expect(runStateMachine(model, id, ['s']).fired).toEqual([]);
  });
  it('target-transition shorthand reads the same', async () => {
    const { model, report } = await load(wrap('    entry; then off;\n    state off;\n    accept s : Sig then on;\n    state on;'));
    expect(errors(report)).toEqual([]);
    const [t] = trs(model);
    expect([t.attrs.trigger, t.attrs.payloadName]).toEqual(['Sig', 's']);
  });
  it('round-trips with the model equal', async () => {
    const { model } = await load(wrap('    entry; then off;\n    state off;\n    accept s : Sig then on;\n    state on;'));
    const out = serializeElement(model!, find(model, 'P').id);
    expect(out).toContain('accept s : Sig');
    const again = await load(out);
    expect(errors(again.report)).toEqual([]);
    const key = (m: any) => trs(m).map((t: any) => [t.attrs.trigger, t.attrs.payloadName]);
    expect(key(again.model)).toEqual(key(model));
  });
  it('a shorthand typing with a part not read is still refused', async () => {
    const { report } = await load(wrap('    state off;\n    accept s : Sig, Sig then on;\n    state on;'));
    expect(report.diagnostics.map((d: any) => d.code)).toContain('mapper/state-form-unread');
  });
});

describe('then done', () => {
  const M = 'state def M { entry; then a; state a; transition first a accept e then done; }';
  it('binds to the containing state final node; run on [e] completes; walk exhaustive reaches it', async () => {
    const { model, report } = await load(`package P { ${M} }`);
    expect(report.diagnostics.filter((d: any) => d.code === 'ref/unresolved-transition-end')).toEqual([]);
    const id = find(model, 'P::M').id;
    const res = runStateMachine(model, id, ['e']);
    expect(isFinalState(model, res.finalState!)).toBe(true); // the flat run leaves `complete` untracked; its leaf is final
    const hier = await load('package P { state def H { entry; then a; state a { entry; then x; state x; } transition first a accept e then done; } }');
    expect(runStateMachine(hier.model, find(hier.model, 'P::H').id, ['e']).complete).toBe(true);
    const w: any = exploreMachine(model, id);
    expect(w.unsupported).toEqual([]);
    expect(w.truncated ?? false).toBe(false);
    expect(w.configLeaves.some((l: any) => l !== null && model.get(l)?.eClass === 'DoneNode')).toBe(true);
  });
  it('run without the event is not complete; the shorthand reads too; round-trips', async () => {
    const { model } = await load(`package P { ${M} }`);
    expect(isFinalState(model, runStateMachine(model, find(model, 'P::M').id, []).finalState!)).toBe(false);
    const sh = await load('package P { state def N { entry; then a; state a; accept e then done; } }');
    expect(isFinalState(sh.model, runStateMachine(sh.model, find(sh.model, 'P::N').id, ['e']).finalState!)).toBe(true);
    const out = serializeElement(model!, find(model, 'P').id);
    expect(out).toContain('then done');
    const again = await load(out);
    expect(isFinalState(again.model, runStateMachine(again.model, find(again.model, 'P::M').id, ['e']).finalState!)).toBe(true);
    expect(trs(again.model)).toHaveLength(1);
  });
});

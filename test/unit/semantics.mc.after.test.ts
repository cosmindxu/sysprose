/**
 * `accept after 5` (SysML v2 §7.18.3), walked as the profile's `time` field says: the walk has no clock, so it
 * offers the time trigger as a named event at any time — a clock-free over-approximation. A safety pass under it
 * is sound; a result that needs the dwell to elapse (a cover, an escape, a witness through the dwell) is not made.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { checkProperty, type PropertyText } from '../../src/semantics/mc/patterns';
import { exploreMachine, reachReport, stateMachinesIn } from '../../src/semantics/mc/explore';
import { SEMANTIC_PROFILE } from '../../src/semantics/mc/profile';
import { reachMachineLines, textOf } from '../../src/semantics/mc/report-lines';

const prop = (f: Partial<PropertyText> & { pattern: string; scope: string }): PropertyText => ({ source: 'flag', carrier: null, ...f });

const TIMED = [
  'package P {',
  '  state def M {',
  '    entry; then a;',
  '    state a; state b; state c;',
  '    transition t1 first a accept after 5 then b;',
  '  }',
  '}',
  '',
].join('\n');

async function load(text: string) {
  const r = await loadModelText(text, { fileName: 'after.sysml', library: 'none' });
  expect(r.report.diagnostics).toEqual([]);
  const model = r.model!;
  return { model, id: stateMachinesIn(model)[0].id };
}

describe('`accept after N` is offered as a named event', () => {
  it('the machine is walked to exhaustion, the dwell edge fires, and the timing is stated', async () => {
    const { model, id } = await load(TIMED);
    const walk = exploreMachine(model, id);
    expect(walk.exhaustive).toBe(true);
    expect(walk.timedTransitions.size).toBe(1);
    expect([...walk.timedLabels]).toEqual(['after 5']);
    const report = reachReport(model);
    const text = textOf(reachMachineLines(report.machines[0], 0));
    expect(text).toContain('timing       over-approximated: `after 5` is offered as an event at any time');
    expect(text).toContain('1 of 1 transition(s) fired');
  });

  it('a safety pass under the over-approximation is sound: c is unreachable under any timing', async () => {
    const { model, id } = await load(TIMED);
    expect(checkProperty(model, id, prop({ pattern: 'absence', scope: 'globally', p: 'state c' })).claim).toBe('pass');
  });

  it('a cover through the dwell is published only because it replays on the abstract clock', async () => {
    const { model, id } = await load(TIMED);
    const cover = checkProperty(model, id, prop({ pattern: 'cover', scope: 'globally', p: 'state b' }));
    expect(cover.claim).toBe('covered');
    expect(cover.witness.some((w) => w.event === 'after 5')).toBe(true);
    // safety results keep the untimed over-approximation: b is reachable, so absence of b is a real refutation
    const abs = checkProperty(model, id, prop({ pattern: 'absence', scope: 'globally', p: 'state b' }));
    expect(abs.claim).toBe('fail');
    expect(checkProperty(model, id, prop({ pattern: 'absence', scope: 'globally', p: 'state c' })).claim).toBe('pass');
    // "eventually b": the dwell is taken once its ticks have passed, so nothing keeps the run in a
    const ex = checkProperty(model, id, prop({ pattern: 'existence', scope: 'globally', p: 'state b' }));
    expect(ex.claim).toBe('pass');
  });

  it('a response across a dwell passes; a competing shorter dwell makes the witness through the longer one not replay', async () => {
    const one = await load(TIMED);
    const resp = checkProperty(one.model, one.id, prop({ pattern: 'response', scope: 'globally', p: 'state a', s: 'state b' }));
    expect(resp.claim).toBe('pass');
    const two = TIMED.replace('state c;', 'state c;\n    transition t2 first a accept after 2 then c;');
    const { model, id } = await load(two);
    // b is reachable in the untimed walk only by waiting out 5 ticks, but the 2-tick dwell fires first: no replay
    const cover = checkProperty(model, id, prop({ pattern: 'cover', scope: 'globally', p: 'state b' }));
    expect(cover.claim).toBe('inconclusive');
    expect(cover.code).toBe('verification/witness-not-replayed');
    // and the shorter one replays
    expect(checkProperty(model, id, prop({ pattern: 'cover', scope: 'globally', p: 'state c' })).claim).toBe('covered');
  });

  it('a duration that is not a positive whole number keeps the old reading: no liveness verdict, interpreter refuses', async () => {
    const expr = TIMED.replace('after 5', 'after 0');
    const { model, id } = await load(expr);
    const ex = checkProperty(model, id, prop({ pattern: 'existence', scope: 'globally', p: 'state b' }));
    expect(ex.claim).toBe('inconclusive');
    expect(ex.detail).toContain('Timing is over-approximated');
  });

  it('two delays or units are two events', async () => {
    const two = TIMED.replace('state c;', 'state c;\n    transition t2 first a accept after 7 [s] then c;');
    const { model, id } = await load(two);
    expect([...exploreMachine(model, id).timedLabels].sort()).toEqual(['after 5', 'after 7 [s]']);
  });

  it('a machine with no time trigger prints no timing line, and the profile names the spelling', async () => {
    const { model } = await load(TIMED.replace(' after 5', ' go'));
    expect(textOf(reachMachineLines(reachReport(model).machines[0], 0))).not.toContain('timing       over-approximated');
    expect(SEMANTIC_PROFILE.find((f) => f.field === 'time')!.reading).toContain('accept after 5');
  });
});

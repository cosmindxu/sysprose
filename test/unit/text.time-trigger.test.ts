/**
 * SysML v2 §7.18.3 time trigger `accept after 5[min]`: read as a time trigger (not an event named `after`),
 * refused when a payload name is followed by a delay, never swallowing a following guard, and never simulated
 * or walked with a guessed clock.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { serializeElement } from '@text/serializer';
import { runStateMachine } from '../../src/semantics/execute';
import { edgeCensus } from '../../src/semantics/mc/explore';

const machine = (accepter: string): string =>
  [
    'package P {',
    '  item def TurnOn;',
    '  state def M {',
    '    entry; then off;',
    '    state off;',
    '    state on;',
    '    transition off_on first off accept TurnOn then on;',
    `    transition on_off first on ${accepter} then off;`,
    '  }',
    '}',
    '',
  ].join('\n');

const load = async (text: string) => loadModelText(text, { fileName: 'tt.sysml' });
const find = (model: any, n: string) => model.all().find((e: any) => model.qualifiedName(e.id) === n);

describe('accept after <delay> (SysML v2 §7.18.3)', () => {
  it('reads `accept after 5[min]` as a time trigger, with no event trigger', async () => {
    const { model, report } = await load(machine('accept after 5[min]'));
    expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const t = find(model, 'P::M::on_off');
    expect(t.attrs.timeTrigger).toBe('5[min]');
    expect(t.attrs.trigger).toBeUndefined();
  });

  it('keeps a guard that follows a trigger a guard, for an event and for a time trigger', async () => {
    for (const [acc, key] of [['accept TurnOn if 1 > 0', 'trigger'], ['accept after 5[min] if 1 > 0', 'timeTrigger']] as const) {
      const { model, report } = await load(machine(acc));
      expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const t = find(model, 'P::M::on_off');
      expect(t.attrs[key]).toBeTruthy();
      expect(t.attrs.guard).toBeTruthy();
    }
    const { model, report } = await load(machine('accept TurnOn if 1 > 0'));
    expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(find(model, 'P::M::on_off').attrs.guard).toBeTruthy();
  });

  it('refuses a payload name followed by a delay: the expression would be dropped', async () => {
    const { report } = await load(machine('accept TurnOn 5[min]'));
    expect(report.diagnostics.map((d) => d.code)).toContain('mapper/accept-delay-unread');
  });

  it('round-trips the time trigger through the serializer', async () => {
    const { model } = await load(machine('accept after 5[min]'));
    const again = await load(serializeElement(model!, find(model, 'P').id));
    expect(find(again.model, 'P::M::on_off').attrs.timeTrigger).toBe('5[min]');
  });

  it('runs a machine with a literal time trigger on an abstract tick: fires once n ticks have passed in its state', async () => {
    const { model } = await load(machine('accept after 3[min]'));
    const id = find(model, 'P::M').id;
    const tick = { advance: 1 };
    const after = (steps: any[]) => runStateMachine(model!, id, steps).finalState;
    const on = find(model, 'P::M::on').id;
    const off = find(model, 'P::M::off').id;
    expect(after(['TurnOn'])).toBe(on);
    expect(after(['TurnOn', tick, tick])).toBe(on);
    expect(after(['TurnOn', tick, tick, tick])).toBe(off);
    // the counter counts from entry: the ticks spent in `off` do not count towards `on`'s dwell
    expect(after([tick, tick, tick, 'TurnOn', tick, tick])).toBe(on);
  });

  it('a self-transition re-enters its state and resets the counter', async () => {
    const text = machine('accept after 3').replace('transition on_off', 'transition on_on first on accept Again then on;\n    transition on_off');
    const { model } = await load(text.replace('item def TurnOn;', 'item def TurnOn; item def Again;'));
    const id = find(model, 'P::M').id;
    const tick = { advance: 1 };
    const on = find(model, 'P::M::on').id;
    const off = find(model, 'P::M::off').id;
    const fin = (steps: any[]) => runStateMachine(model!, id, steps).finalState;
    expect(fin(['TurnOn', tick, tick, tick])).toBe(off);
    expect(fin(['TurnOn', tick, tick, 'Again', tick, tick])).toBe(on);
    expect(fin(['TurnOn', tick, tick, 'Again', tick, tick, tick])).toBe(off);
  });

  it('refuses a duration that is not a literal positive integer, saying so', async () => {
    for (const d of ['0', '1.5']) {
      const { model } = await load(machine(`accept after ${d}`));
      const res = runStateMachine(model!, find(model, 'P::M').id, ['TurnOn']);
      expect(res.complete).toBe(false);
      expect(res.unopened).toContain('literal positive');
    }
  });

  it('walks the time-triggered edge as a named event, never a guessed clock (S6: the profile text and the walk now agree)', async () => {
    const { model } = await load(machine('accept after 5[min]'));
    const row = edgeCensus(model!, find(model, 'P::M').id).rows.find((r) => r.qualifiedName === 'P::M::on_off');
    // It was `unaccounted` (the whole machine refused) while the profile said an `after` trigger is offered as an event.
    expect(row?.account).toBe('walked');
  });
});

/**
 * `accept after 5` (SysML v2 §7.18.3), walked as the profile's `time` field says: the walk has no clock, so it
 * offers the time trigger as a named event at any time — a clock-free over-approximation. A safety pass under it
 * is sound; a result that needs the dwell to elapse (a cover, an escape, a witness through the dwell) is not made.
 */
import { describe, it, expect } from 'vitest';
import { loadModelText } from '@text/load';
import { checkProperty, type PropertyText } from '../../src/semantics/mc/patterns';
import { runStateMachine } from '../../src/semantics/execute';
import { dwellTicks } from '../../src/semantics/mc/config';
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

describe('a dwell inside the regions of a parallel state (sm-par-dwell)', () => {
  const par = (r1: string, r2: string, tail = ''): string =>
    `package P { item def e; state def M { entry; then p; state p parallel { ${r1} ${r2} } state q; transition go first p accept e then q; ${tail} } }`;
  const R1 = 'state r1 { entry; then a1; state a1; state b1; transition t1 first a1 accept after 2 then b1; }';
  const R2 = 'state r2 { entry; then a2; state a2; state b2; transition t2 first a2 accept after 3 then b2; }';
  const leaves = (m: Awaited<ReturnType<typeof load>>, steps: Parameters<typeof runStateMachine>[2]): string[] =>
    runStateMachine(m.model, m.id, steps).activeStates.map((s: string) => m.model.qualifiedName(s)).sort();

  it('a tick advances every region at once: each region fires its own dwell when its count is met', async () => {
    const m = await load(par(R1, R2));
    expect(leaves(m, [{ advance: 1 }])).toEqual(['P::M::p::r1::a1', 'P::M::p::r2::a2']);
    expect(leaves(m, [{ advance: 2 }])).toEqual(['P::M::p::r1::b1', 'P::M::p::r2::a2']);
    expect(leaves(m, [{ advance: 3 }])).toEqual(['P::M::p::r1::b1', 'P::M::p::r2::b2']);
    // two ticks one at a time: same
    expect(leaves(m, [{ advance: 1 }, { advance: 1 }, { advance: 1 }])).toEqual(['P::M::p::r1::b1', 'P::M::p::r2::b2']);
    expect(runStateMachine(m.model, m.id, [{ advance: 3 }]).unopened).toBeUndefined();
  });

  it('a cover through a region dwell is published because it replays; safety and unreachability keep the untimed walk', async () => {
    const m = await load(par(R1, R2));
    expect(exploreMachine(m.model, m.id).unsupported).toEqual([]);
    const cover = checkProperty(m.model, m.id, prop({ pattern: 'cover', scope: 'globally', p: 'state b1' }));
    expect(cover.claim).toBe('covered');
    expect(checkProperty(m.model, m.id, prop({ pattern: 'cover', scope: 'globally', p: 'state b1 and state b2' })).claim).toBe('covered');
    expect(checkProperty(m.model, m.id, prop({ pattern: 'absence', scope: 'globally', p: 'state b1' })).claim).toBe('fail');
    // nothing writes a state outside the machine: an unknown-free state stays unreachable
    const dead = par(R1, R2, 'state z;');
    const d = await load(dead);
    expect(checkProperty(d.model, d.id, prop({ pattern: 'absence', scope: 'globally', p: 'state z' })).claim).toBe('pass');
  });

  it('a shorter dwell in the same region pre-empts: a cover into the state the longer one reaches is withheld', async () => {
    const r1 = 'state r1 { entry; then a1; state a1; state b1; state c1; transition t1 first a1 accept after 5 then b1; transition t3 first a1 accept after 2 then c1; }';
    const m = await load(par(r1, R2));
    const cover = checkProperty(m.model, m.id, prop({ pattern: 'cover', scope: 'globally', p: 'state b1' }));
    expect(cover.claim).toBe('inconclusive');
    expect(cover.code).toBe('verification/witness-not-replayed');
    expect(checkProperty(m.model, m.id, prop({ pattern: 'cover', scope: 'globally', p: 'state c1' })).claim).toBe('covered');
  });

  it('the same dwell in two regions stays refused, by the walk and the interpreter, with the reason', async () => {
    const r2 = 'state r2 { entry; then a2; state a2; state b2; transition t2 first a2 accept after 2 then b2; }';
    const m = await load(par(R1, r2));
    const u = exploreMachine(m.model, m.id).unsupported;
    expect(u.map((x) => x.construct)).toEqual(['parallel-regions']);
    expect(u[0].detail).toContain('the same dwell');
    const run = runStateMachine(m.model, m.id, [{ advance: 2 }]);
    expect(run.unopened ?? '').toContain('the same dwell');
  });

  it('a region dwell that is no literal whole number is refused as before', async () => {
    const m = await load(par(R1.replace('after 2', 'after 0'), R2).replace('after 0', 'after 0'));
    expect(runStateMachine(m.model, m.id, []).unopened ?? '').toMatch(/dwell|time trigger|literal/);
  });

  it('a dwell and an event that leave the parallel state at the same time are not chosen between', async () => {
    const m = await load(par(R1, R2, 'transition leave first p accept after 2 then q;'));
    const run = runStateMachine(m.model, m.id, [{ advance: 2 }]);
    expect(run.refused ?? run.unopened).toBeDefined();
  });
});

// sm-dwell-units: the unit of a dwell is read (a 1 [s] against a 500 [ms] race is no 1 tick against 500).
const race = (a: string, b: string, pre = ''): string =>
  [
    'package P {', pre, '  state def M {', '    entry; then s;', '    state s; state fast; state slow;',
    `    transition tf first s accept after ${b} then fast;`,
    `    transition ts first s accept after ${a} then slow;`,
    '  }', '}', '',
  ].join('\n');
const ticksOf = (model: any, name: string): number | undefined => {
  const t = model.all().find((e: any) => model.qualifiedName(e.id) === name);
  return dwellTicks(t, model);
};

describe('dwell units (SysML v2 §7.18.3)', () => {
  it('1 [s] against 500 [ms]: 2 ticks against 1, so the millisecond dwell is the one that wins the race', async () => {
    const { model, id } = await load(race('1[s]', '500[ms]'));
    expect(ticksOf(model, 'P::M::ts')).toBe(2);
    expect(ticksOf(model, 'P::M::tf')).toBe(1);
    const tick = { advance: 1 } as const;
    const fast = model.all().find((e: any) => model.qualifiedName(e.id) === 'P::M::fast')!.id;
    const r = runStateMachine(model, id, [tick]);
    expect(r.finalState).toBe(fast);
  });
  it('a same-unit machine keeps its counts', async () => {
    const { model } = await load(race('5[s]', '3[s]'));
    expect(ticksOf(model, 'P::M::ts')).toBe(5);
    expect(ticksOf(model, 'P::M::tf')).toBe(3);
  });
  it('a unitless machine keeps its counts', async () => {
    const { model } = await load(race('5', '3'));
    expect(ticksOf(model, 'P::M::ts')).toBe(5);
  });
  it('a mix of unitless and united dwells, a non-time unit and an unknown unit are refused, with the reason', async () => {
    for (const [a, b, re] of [['5', '3[s]', /mix unitless/], ['5[kg]', '3[s]', /not a unit of time/], ['5[zz]', '3[s]', /unknown/]] as const) {
      const { model, id } = await load(race(a, b));
      expect(ticksOf(model, 'P::M::ts')).toBeUndefined();
      expect(runStateMachine(model, id, []).unopened ?? '').toMatch(re);
    }
  });
});

describe('named dwell durations (`accept after timeout` parses; a name is read by `=` binding)', () => {
  const named = async (decl: string) => {
    const l = await load(['package P {', '  state def M {', `    ${decl}`, '    entry; then s;', '    state s; state d;', '    transition t first s accept after 4 then d;', '  }', '}', ''].join('\n'));
    const t = l.model.all().find((e: any) => l.model.qualifiedName(e.id) === 'P::M::t')!;
    l.model.setAttrs(t.id, { timeTrigger: 'timeout' });
    return l;
  };
  it('a name bound by = to a literal is that literal', async () => {
    const { model } = await named('attribute timeout : Integer = 4;');
    expect(ticksOf(model, 'P::M::t')).toBe(4);
  });
  it('a default, a := value, an expression and an unresolved name stay refused', async () => {
    for (const decl of ['attribute timeout : Integer default = 4;', 'attribute timeout : Integer := 4;', 'attribute timeout : Integer = 2 + 2;', 'attribute other : Integer = 4;']) {
      const { model, id } = await named(decl);
      expect(ticksOf(model, 'P::M::t')).toBeUndefined();
      expect(runStateMachine(model, id, []).unopened ?? '').not.toBe('');
    }
  });
});

describe('named dwell written in text', () => {
  const text = (decl: string, dur: string) =>
    ['package P {', '  state def M {', `    ${decl}`, '    entry; then s;', '    state s; state d;', `    transition t first s accept after ${dur} then d;`, '  }', '}', ''].join('\n');
  it('`accept after timeout` is the literal the name is bound to by =', async () => {
    const { model } = await load(text('attribute timeout : Integer = 4;', 'timeout'));
    expect(ticksOf(model, 'P::M::t')).toBe(4);
  });
  it('a default, := or unresolved name written in text stays refused', async () => {
    for (const decl of ['attribute timeout : Integer default = 4;', 'attribute timeout : Integer := 4;', 'attribute other : Integer = 4;']) {
      const { model } = await load(text(decl, 'timeout'));
      expect(ticksOf(model, 'P::M::t')).toBeUndefined();
    }
  });
});

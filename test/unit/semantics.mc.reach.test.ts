/**
 * `reach` — what the walk may claim, and what a bound takes away from it
 * (plan §3.8).
 *
 * Two halves. The first is the demonstration on the shipped example, and it is
 * deliberately NOT a reachability count: `FlightModes` has four states and five
 * trigger-less transitions, every one of them a completion transition, and the
 * finding that matters is that `autonomous` has two of them enabled at once so
 * the simulator's declaration-order tie-break means `failsafe` is never entered
 * in simulation. A report on this machine that showed trigger labels would be
 * fabricating them, so that is asserted too.
 *
 * The second half is the bound rules, which are the reason this command can be
 * trusted at all: a configuration bound and a completion-chase bound must both
 * produce `exhaustive: false` and EMPTY absence lists, in exactly the same way,
 * because a bound hit that could masquerade as a finding is the failure this
 * whole lane is written against.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Model, ModelFactory, type ElementId } from '@core/index';
import { runStateMachine } from '@semantics/index';
import { loadModelText } from '@text/load';
import {
  BEHAVIOUR_CODES,
  BOUND_EXHAUSTED_CODE,
  BEHAVIOUR_UNSUPPORTED_CODE,
  DEAD_TRANSITION_CODE,
  DEADLOCK_CODE,
  NONDETERMINISTIC_CHOICE_CODE,
  UNREACHABLE_STATE_CODE,
  exploreMachine,
  reachReport,
  stateMachinesIn,
  walkableTransitions,
} from '../../src/semantics/mc/explore';
import { SEMANTIC_PROFILE } from '../../src/semantics/mc/profile';
import { MAX_COMPLETION, hashConfig, initialConfig } from '../../src/semantics/mc/config';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** A chain of `n` states joined by completion transitions: s0 → s1 → … → sn. */
function completionChain(n: number): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Chain');
  const states = Array.from({ length: n + 1 }, (_, i) => f.state(`s${i}`, sm.id));
  for (let i = 0; i < n; i++) f.transition(states[i].id, states[i + 1].id, { ownerId: sm.id });
  return { model: m, machineId: sm.id };
}

describe('reach on FlightModes — the finding is the hidden choice', () => {
  let model: Model;
  beforeAll(async () => {
    const loaded = await loadModelText(read('examples/uav-isr.sysml'), {
      fileName: 'examples/uav-isr.sysml',
    });
    model = loaded.model!;
  }, 90_000);

  it('walks the machine to exhaustion: 4 of 4 states reachable, 0 dead transitions', () => {
    const r = reachReport(model);
    const fm = r.machines.find((m) => m.machine.name === 'FlightModes');
    expect(fm, 'examples/uav-isr.sysml no longer declares FlightModes').toBeDefined();
    expect(fm!.exhaustive).toBe(true);
    expect(fm!.boundHit).toBe('none');
    expect(fm!.states.total).toBe(4);
    expect(fm!.states.reachable.map((s) => s.name).sort()).toEqual([
      'autonomous',
      'failsafe',
      'manual',
      'standby',
    ]);
    expect(fm!.states.unreachable).toEqual([]);
    expect(fm!.transitions.total).toBe(5);
    expect(fm!.transitions.fired).toBe(5);
    expect(fm!.transitions.dead).toEqual([]);
    expect(fm!.qualification).toContain('exhaustive under {maxConfigs 10000');
  });

  it('reports the nondeterministic choice at `autonomous`, with no invented trigger label', () => {
    const r = reachReport(model);
    const fm = r.machines.find((m) => m.machine.name === 'FlightModes')!;
    expect(fm.nondeterminism).toHaveLength(1);
    const nd = fm.nondeterminism[0];
    expect(nd.state.name).toBe('autonomous');
    expect(nd.enabled).toHaveLength(2);
    // Trigger-less: the event is empty and so is every label on the row. The
    // machine names no trigger at all, and a report that printed one would be
    // making it up.
    expect(nd.event).toBe('');
    expect(nd.enabled.map((t) => t.label)).toEqual(['', '']);
    expect(fm.bounds.alphabet).toEqual([]);
    expect(nd.taken.to!.name).toBe('manual');
    expect(nd.notTaken.map((t) => t.to!.name)).toEqual(['failsafe']);

    const finding = r.diagnostics.find((d) => d.code === NONDETERMINISTIC_CHOICE_CODE);
    expect(finding, 'the choice is not reported as a finding').toBeDefined();
    expect(finding!.severity).toBe('warning');
    expect(finding!.message).toContain('the simulator takes');
    expect(finding!.message).toContain('completion transitions (no trigger)');
  });

  it('finds no deadlock and no unsupported construct on it', () => {
    const r = reachReport(model);
    const fm = r.machines.find((m) => m.machine.name === 'FlightModes')!;
    expect(fm.deadlocks).toEqual([]);
    expect(fm.unsupported).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === BOUND_EXHAUSTED_CODE)).toEqual([]);
  });

  it('carries the semantic profile on the report', () => {
    const r = reachReport(model);
    expect(r.profile.map((f) => f.field)).toEqual([
      'run-to-completion',
      'priority',
      'history',
      'regions',
      'deferred events',
      'time',
    ]);
  });
});

describe('a bound hit can never masquerade as a finding', () => {
  it('a configuration bound empties the unreachable list and says so', async () => {
    const loaded = await loadModelText(read('examples/uav-isr.sysml'), {
      fileName: 'examples/uav-isr.sysml',
    });
    const model = loaded.model!;
    const r = reachReport(model, { maxConfigs: 2 });
    const fm = r.machines.find((m) => m.machine.name === 'FlightModes')!;
    expect(fm.boundHit).toBe('configs');
    expect(fm.exhaustive).toBe(false);
    expect(fm.suppressed).toBe(true);
    expect(fm.states.unreachable).toEqual([]);
    expect(fm.transitions.dead).toEqual([]);
    expect(fm.qualification).toContain('lower bounds');
    const bound = r.diagnostics.find((d) => d.code === BOUND_EXHAUSTED_CODE);
    expect(bound, 'a partial walk did not say it was partial').toBeDefined();
    expect(bound!.message).toContain('NOT reported as findings');
    expect(r.diagnostics.filter((d) => d.code === UNREACHABLE_STATE_CODE)).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === DEAD_TRANSITION_CODE)).toEqual([]);
  }, 90_000);

  it('a 70-step completion chain hits the 64-step budget in exactly the same way', () => {
    const { model, machineId } = completionChain(70);
    const walk = exploreMachine(model, machineId);
    expect(walk.boundHit).toBe('completion');
    expect(walk.exhaustive).toBe(false);

    const r = reachReport(model);
    const chain = r.machines[0];
    expect(chain.boundHit).toBe('completion');
    expect(chain.exhaustive).toBe(false);
    // The whole point: `s65` … `s70` were never reached and the chain's last
    // transitions never fired, and NEITHER is reported. Same two empty lists a
    // configuration bound produces.
    expect(chain.states.total).toBe(71);
    expect(chain.states.reachable.length).toBeLessThan(71);
    expect(chain.states.unreachable).toEqual([]);
    expect(chain.transitions.dead).toEqual([]);
    const bound = r.diagnostics.find((d) => d.code === BOUND_EXHAUSTED_CODE);
    expect(bound!.message).toContain('chase budget');
  });

  it('the interpreter now says when its own chase ran out of budget', () => {
    const long = completionChain(70);
    const cut = runStateMachine(long.model, long.machineId, []);
    expect(cut.completionBudgetHit, 'a chase cut off at 64 steps reported as quiescence').toBe(true);
    expect(cut.fired).toHaveLength(MAX_COMPLETION);

    const short = completionChain(3);
    const settled = runStateMachine(short.model, short.machineId, []);
    expect(settled.completionBudgetHit).toBe(false);
    expect(settled.fired).toHaveLength(3);
  });

  it('a shorter chain than the budget is walked to exhaustion', () => {
    const { model, machineId } = completionChain(10);
    const walk = exploreMachine(model, machineId);
    expect(walk.boundHit).toBe('none');
    expect(walk.exhaustive).toBe(true);
    expect(walk.reachable.size).toBe(11);
  });
});

describe('what the walk refuses to explore', () => {
  it('a parallel machine is unsupported, never exhaustively explored', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const par = m.create('StateDefinition', { declaredName: 'Par', attrs: { parallel: true } });
    const r1 = f.state('r1', par.id);
    const a1 = f.state('a1', r1.id);
    const a2 = f.state('a2', r1.id);
    f.transition(a1.id, a2.id, { ownerId: r1.id, trigger: 't' });
    const r2 = f.state('r2', par.id);
    const b1 = f.state('b1', r2.id);
    const b2 = f.state('b2', r2.id);
    f.transition(b1.id, b2.id, { ownerId: r2.id, trigger: 't' });

    const r = reachReport(m, { scopeId: par.id });
    expect(r.machines).toHaveLength(1);
    const only = r.machines[0];
    expect(only.exhaustive).toBe(false);
    expect(only.states.unreachable).toEqual([]);
    expect(only.transitions.dead).toEqual([]);
    expect(only.unsupported.map((u) => u.construct)).toContain('parallel-regions');
    const finding = r.diagnostics.find((d) => d.code === BEHAVIOUR_UNSUPPORTED_CODE);
    expect(finding!.severity).toBe('info');
    expect(finding!.message).toContain('is not explored');
  });

  it('a history state is unsupported for the same reason', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('H');
    const active = m.create('StateUsage', {
      declaredName: 'Active',
      ownerId: sm.id,
      attrs: { history: true },
    });
    const s1 = f.state('s1', active.id);
    const s2 = f.state('s2', active.id);
    f.transition(s1.id, s2.id, { ownerId: active.id, trigger: 'go' });
    const idle = f.state('Idle', sm.id);
    f.transition(active.id, idle.id, { ownerId: sm.id, trigger: 'out' });
    f.transition(idle.id, active.id, { ownerId: sm.id, trigger: 'back' });

    const walk = exploreMachine(m, sm.id);
    expect(walk.unsupported.map((u) => u.construct)).toEqual(['history-state']);
    expect(walk.exhaustive).toBe(false);
    expect(walk.configs).toBe(0);
  });
});

describe('what an exhaustive walk may say', () => {
  it('names an unreachable state and the transition that never fires', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Reachability');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    const island = f.state('island', sm.id);
    const beyond = f.state('beyond', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'go' });
    f.transition(b.id, a.id, { ownerId: sm.id, trigger: 'back' });
    const dead = f.transition(island.id, beyond.id, { ownerId: sm.id, trigger: 'never' });

    const r = reachReport(m);
    const only = r.machines[0];
    expect(only.exhaustive).toBe(true);
    expect(only.states.unreachable.map((s) => s.name).sort()).toEqual(['beyond', 'island']);
    expect(only.transitions.dead.map((t) => t.id)).toEqual([dead.id]);
    const unreachable = r.diagnostics.filter((d) => d.code === UNREACHABLE_STATE_CODE);
    expect(unreachable).toHaveLength(2);
    expect(unreachable[0].severity).toBe('warning');
    expect(unreachable[0].message).toContain('exhaustive under');
    const deadRow = r.diagnostics.find((d) => d.code === DEAD_TRANSITION_CODE);
    expect(deadRow!.message).toContain('never enabled');
  });

  it('names a state nothing leaves, and not one marked final', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Stuck');
    const a = f.state('a', sm.id);
    const trap = f.state('trap', sm.id);
    f.transition(a.id, trap.id, { ownerId: sm.id, trigger: 'go' });
    const r = reachReport(m);
    expect(r.machines[0].deadlocks.map((d) => d.leaf.name)).toEqual(['trap']);
    const finding = r.diagnostics.find((d) => d.code === DEADLOCK_CODE);
    expect(finding!.message).toContain('not marked final');
    expect(finding!.message).toContain('reached in 1 step(s)');

    const m2 = new Model();
    const f2 = new ModelFactory(m2);
    const sm2 = f2.stateDef('Ends');
    const a2 = f2.state('a', sm2.id);
    const done = m2.create('StateUsage', {
      declaredName: 'done',
      ownerId: sm2.id,
      attrs: { kind: 'final' },
    });
    f2.transition(a2.id, done.id, { ownerId: sm2.id, trigger: 'go' });
    expect(reachReport(m2).machines[0].deadlocks).toEqual([]);
  });

  it('reads a guard, so a state behind a false guard is unreachable', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Guarded');
    f.attribute('ready', sm.id, { type: 'Boolean', value: false });
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'go', guard: 'ready' });
    const only = reachReport(m).machines[0];
    expect(only.exhaustive).toBe(true);
    expect(only.states.unreachable.map((s) => s.name)).toEqual(['s1']);
    expect(only.transitions.dead).toHaveLength(1);
  });
});

describe('which elements are machines at all', () => {
  it('reports the machine, not each composite region inside it', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('M');
    const active = f.state('Active', sm.id);
    const s1 = f.state('s1', active.id);
    const s2 = f.state('s2', active.id);
    f.transition(s1.id, s2.id, { ownerId: active.id, trigger: 'go' });
    const done = f.state('Done', sm.id);
    f.transition(active.id, done.id, { ownerId: sm.id, trigger: 'finish' });

    expect(stateMachinesIn(m).map((e) => e.declaredName)).toEqual(['M']);
    const only = reachReport(m).machines[0];
    expect(only.exhaustive).toBe(true);
    // `Active` and both its substates are entered by the cascade; `Done` by the
    // outer transition. Nothing is unreachable and nothing is dead.
    expect(only.states.unreachable).toEqual([]);
    expect(only.transitions.dead).toEqual([]);
  });
});

describe('the semantic profile is data, and its provenance is real', () => {
  it('every field names a symbol that exists in the file it cites', () => {
    for (const field of SEMANTIC_PROFILE) {
      expect(field.reading.length, `${field.field} has no reading`).toBeGreaterThan(20);
      for (const cite of field.provenance.split(';')) {
        const [path, symbols] = cite.split('—').map((s) => s.trim());
        expect(path, `${field.field} cites no file`).toMatch(/^src\/.*\.ts$/);
        const src = read(path);
        for (const symbol of symbols.split(',').map((s) => s.trim())) {
          const bare = symbol.replace(/^[A-Za-z]+\./, '');
          expect(
            src.includes(bare),
            `${field.field} cites \`${symbol}\`, which ${path} no longer declares`,
          ).toBe(true);
        }
      }
    }
  });

  it('names the six codes this engine can raise', () => {
    expect([...BEHAVIOUR_CODES].sort()).toEqual([
      'verification/behaviour-unsupported-construct',
      'verification/bound-exhausted',
      'verification/dead-transition',
      'verification/deadlock',
      'verification/nondeterministic-choice',
      'verification/unreachable-state',
    ]);
  });
});

/* ─────────────────── what the walk must not invent ──────────────────────── */

/**
 * `Outer` contains `inner`, whose self-loop on `go` always wins the priority
 * rule, so `Outer -> Sink` is enabled at every configuration and fires in no
 * run. Everything past `Sink` is therefore unreachable in this semantics.
 */
function buildBeatenByPriority(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('M');
  const outer = f.state('Outer', sm.id);
  const inner = f.state('inner', outer.id);
  const sink = f.state('Sink', sm.id);
  const p = f.state('P', sm.id);
  const q = f.state('Q', sm.id);
  f.transition(inner.id, inner.id, { ownerId: outer.id, trigger: 'go' });
  f.transition(outer.id, sink.id, { ownerId: sm.id, trigger: 'go' });
  f.transition(sink.id, p.id, { ownerId: sm.id });
  f.transition(sink.id, q.id, { ownerId: sm.id });
  return { model: m, machineId: sm.id };
}

/** One trigger offered at two levels of the stack: the profile's priority rule. */
function buildTwoLevelTrigger(): { model: Model; machineId: ElementId } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('Priority');
  const outer = f.state('Outer', sm.id);
  const inner = f.state('inner', outer.id);
  f.state('innerTarget', outer.id);
  f.state('OuterTarget', sm.id);
  const it = m.all().find((e) => e.declaredName === 'innerTarget')!;
  const ot = m.all().find((e) => e.declaredName === 'OuterTarget')!;
  f.transition(inner.id, it.id, { ownerId: outer.id, trigger: 'go' });
  f.transition(outer.id, ot.id, { ownerId: sm.id, trigger: 'go' });
  return { model: m, machineId: sm.id };
}

describe('the walk branches on the tie-break, and on nothing else', () => {
  it('never enters a configuration the priority rule forbids, and invents no finding there', () => {
    const { model, machineId } = buildBeatenByPriority();

    // GROUND TRUTH from the interpreter itself: drive every `go` sequence up to
    // length 8 and collect what it visits. Nothing but `Outer` and `inner`.
    const simulated = new Set<string>();
    for (let n = 0; n <= 8; n++) {
      const run = runStateMachine(model, machineId, Array.from({ length: n }, () => 'go'));
      for (const v of run.visited) simulated.add(model.get(v)?.declaredName ?? v);
    }
    expect([...simulated].sort()).toEqual(['Outer', 'inner']);

    const r = reachReport(model);
    const only = r.machines[0];
    expect(only.exhaustive).toBe(true);
    expect(only.states.reachable.map((st) => st.name).sort()).toEqual(['Outer', 'inner']);
    // The three states behind the beaten transition, reported as what they are.
    expect(only.states.unreachable.map((st) => st.name).sort()).toEqual(['P', 'Q', 'Sink']);
    // And NOT reported: a state nothing leaves, or a choice the simulator hides,
    // in a configuration no run of this semantics ever enters. An
    // over-approximation may only shrink an absence claim; these two are claims
    // that a configuration WAS reached, so exploring extra ones invents them.
    expect(only.deadlocks).toEqual([]);
    expect(only.nondeterminism).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === DEADLOCK_CODE)).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === NONDETERMINISTIC_CHOICE_CODE)).toEqual([]);
  });

  it('counts a transition the priority rule always beats as enabled, not dead', () => {
    const { model, machineId } = buildBeatenByPriority();
    const only = reachReport(model).machines[0];
    // `Outer -> Sink` is ENABLED at every configuration and fires in none: the
    // hint on `verification/dead-transition` says dead means never enabled
    // anywhere reachable, and this is the case that distinguishes the two
    // readings. Only the two transitions out of the unreachable `Sink` are dead.
    expect(only.transitions.dead.map((t) => t.from?.name).sort()).toEqual(['Sink', 'Sink']);
    expect(only.transitions.total).toBe(walkableTransitions(model, machineId).length);
  });

  it('does not report the priority rule itself as a hidden choice', () => {
    // One trigger, two transitions, two levels. The profile STATES that the
    // innermost wins, so this is not an ambiguity — and a report that filed it
    // as one would bury the real finding (two transitions leaving ONE state)
    // under a row for every nested machine in the corpus.
    const { model } = buildTwoLevelTrigger();
    const r = reachReport(model);
    expect(r.machines[0].nondeterminism).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === NONDETERMINISTIC_CHOICE_CODE)).toEqual([]);

    // The positive control, same shape but ONE state: that IS a hidden choice.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Ambiguous');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    const c = f.state('c', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'go' });
    f.transition(a.id, c.id, { ownerId: sm.id, trigger: 'go' });
    const only = reachReport(m).machines[0];
    expect(only.nondeterminism).toHaveLength(1);
    expect(only.nondeterminism[0].state.name).toBe('a');
    expect(only.nondeterminism[0].event).toBe('go');
    expect(only.nondeterminism[0].taken.to!.name).toBe('b');
  });

  it('does not report a choice in a state the priority rule never lets decide', () => {
    // TWO transitions leaving `Outer` on `go` — a choice by declaration order,
    // in the abstract. But `inner`'s self-loop is enabled on `go` at every
    // configuration `Outer` is active in, so the inner level always wins and
    // neither of the two ever decides anything. Grouping by state alone would
    // still file the row; the level the priority rule leaves standing is what
    // decides whether there is a choice to report.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('NeverDecides');
    const outer = f.state('Outer', sm.id);
    const inner = f.state('inner', outer.id);
    const one = f.state('One', sm.id);
    const two = f.state('Two', sm.id);
    f.transition(inner.id, inner.id, { ownerId: outer.id, trigger: 'go' });
    f.transition(outer.id, one.id, { ownerId: sm.id, trigger: 'go' });
    f.transition(outer.id, two.id, { ownerId: sm.id, trigger: 'go' });

    const r = reachReport(m);
    expect(r.machines[0].nondeterminism).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === NONDETERMINISTIC_CHOICE_CODE)).toEqual([]);
    // And what IS reported about them: neither target is ever entered.
    expect(r.machines[0].states.unreachable.map((st) => st.name).sort()).toEqual(['One', 'Two']);
  });
});

describe('the census is what the walk could offer, not every edge in the file', () => {
  it('does not call the `initial` node’s edge dead — it is consumed, not fired', async () => {
    // Built from SOURCE TEXT, deliberately: `initial` is a keyword the mapper
    // turns into an `InitialNode`, and every machine the rest of this file
    // builds with `ModelFactory` has no control node at all, so nothing here
    // exercised the shape every hand-written machine actually has.
    const loaded = await loadModelText(
      'package P {\n' +
        '    state def Modes {\n' +
        '        initial start;\n' +
        '        state idle;\n' +
        '        state busy;\n' +
        '        transition start -> idle;\n' +
        '        transition idle -> busy accept go;\n' +
        '        transition busy -> idle accept stop;\n' +
        '    }\n' +
        '}\n',
      { fileName: 'initial.sysml' },
    );
    const model = loaded.model!;
    const r = reachReport(model);
    const only = r.machines[0];
    expect(only.exhaustive).toBe(true);
    expect(only.states.reachable.map((s) => s.name).sort()).toEqual(['busy', 'idle']);
    expect(only.states.unreachable).toEqual([]);
    // `initialState` READS the `start -> idle` edge to decide where the machine
    // opens; no run fires it, and `enabledTransitions` can never offer it
    // because its source is not a state the stack can hold. Counting it would
    // put a dead row on every hand-written machine in the world.
    expect(only.transitions.total).toBe(2);
    expect(only.transitions.dead).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === DEAD_TRANSITION_CODE)).toEqual([]);
  }, 90_000);

  it('ends at a `done` node without calling it a deadlock', async () => {
    const loaded = await loadModelText(
      'package P {\n' +
        '    state def Job {\n' +
        '        state working;\n' +
        '        done finished;\n' +
        '        transition working -> finished accept complete;\n' +
        '    }\n' +
        '}\n',
      { fileName: 'done.sysml' },
    );
    const model = loaded.model!;
    const r = reachReport(model);
    expect(r.machines[0].deadlocks).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === DEADLOCK_CODE)).toEqual([]);

    // The control it is a control for: the same machine ending at an ordinary
    // state IS a deadlock, so the exemption is the `done` node and not a hole.
    const loose = await loadModelText(
      'package P {\n' +
        '    state def Job {\n' +
        '        state working;\n' +
        '        state finished;\n' +
        '        transition working -> finished accept complete;\n' +
        '    }\n' +
        '}\n',
      { fileName: 'loose.sysml' },
    );
    expect(reachReport(loose.model!).machines[0].deadlocks.map((d) => d.leaf.name)).toEqual([
      'finished',
    ]);
  }, 90_000);
});

describe('the configuration key is what the next step depends on', () => {
  it('separates two configurations that differ only in the store', () => {
    // A latch: `c` is reachable only after `arm`’s effect has written `ready`.
    // Drop the store from `hashConfig` and `a`-before-arm merges with
    // `a`-after-arm, `fire` is never explored, and the report invents an
    // unreachable state and a dead transition on an ordinary machine.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Latch');
    f.attribute('ready', sm.id, { type: 'Boolean', value: false });
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    const c = f.state('c', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'arm', effect: 'ready = true' });
    f.transition(b.id, a.id, { ownerId: sm.id, trigger: 'back' });
    f.transition(a.id, c.id, { ownerId: sm.id, trigger: 'fire', guard: 'ready' });

    const only = reachReport(m).machines[0];
    expect(only.exhaustive).toBe(true);
    expect(only.states.reachable.map((s) => s.name).sort()).toEqual(['a', 'b', 'c']);
    expect(only.states.unreachable).toEqual([]);
    expect(only.transitions.dead).toEqual([]);

    // Stated directly as well, so the reason survives a refactor of the walk.
    const open = initialConfig(m, sm.id, { store: new Map([['ready', false]]) }).config;
    const armed = { ...open, store: new Map([['ready', true]]) };
    expect(hashConfig(open)).not.toBe(hashConfig(armed));
  });

  it('merges two configurations that differ only in when the run started', () => {
    // Dwell is what an `after(n)` transition reads; the absolute clock is
    // readable by nothing. Keeping it in the key would make the visited set
    // over-fine — and the walk non-terminating on a timed cycle — for the first
    // caller that advances it.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Timed');
    f.state('a', sm.id);
    const at0 = initialConfig(m, sm.id, { clock: 0 }).config;
    const at9 = initialConfig(m, sm.id, { clock: 9 }).config;
    expect(at0.clock).not.toBe(at9.clock);
    expect(hashConfig(at0)).toBe(hashConfig(at9));
  });
});

describe('a completion CYCLE is not a completion bound', () => {
  /** `a` ⇄ `b` on completion transitions, plus an island nothing reaches. */
  function cycleWithIsland(): { model: Model; machineId: ElementId } {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Cyc');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    const island = f.state('island', sm.id);
    const beyond = f.state('beyond', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id });
    f.transition(b.id, a.id, { ownerId: sm.id });
    f.transition(island.id, beyond.id, { ownerId: sm.id, trigger: 'never' });
    return { model: m, machineId: sm.id };
  }

  it('is exhaustive, and still publishes the absence lists', () => {
    // The two surfaces answer DIFFERENT questions and the answers only look
    // contradictory. `runStateMachine` says whether THAT RUN was cut off
    // mid-chase — on a cycle every run is — while the walk says whether it saw
    // the whole configuration GRAPH, and a cycle re-enters configurations it
    // has already hashed, so nothing downstream of it is unexplored. Pinned
    // side by side because `FlightModes` in `examples/uav-isr.sysml` is exactly
    // this shape, and §3.8 names it as the exhaustive demonstration.
    const { model, machineId } = cycleWithIsland();
    const run = runStateMachine(model, machineId, []);
    expect(run.completionBudgetHit, 'the interpreter no longer says its chase was cut off').toBe(
      true,
    );

    const walk = exploreMachine(model, machineId);
    expect(walk.boundHit).toBe('none');
    expect(walk.exhaustive).toBe(true);
    const only = reachReport(model).machines[0];
    expect(only.states.unreachable.map((s) => s.name).sort()).toEqual(['beyond', 'island']);
    expect(only.transitions.dead).toHaveLength(1);
  });

  it('the boundary of the chase budget, on both sides and on both surfaces', () => {
    // The interpreter fires `maxCompletion` transitions and only THEN asks
    // whether anything is still enabled, so a chain of exactly 64 is one it
    // completes cleanly. The walk has to agree, or it prints "a completion
    // chain longer than the 64-step chase budget was found" about a chain that
    // is not longer than it.
    const at = completionChain(MAX_COMPLETION);
    expect(runStateMachine(at.model, at.machineId, []).completionBudgetHit).toBe(false);
    expect(exploreMachine(at.model, at.machineId).boundHit).toBe('none');
    expect(exploreMachine(at.model, at.machineId).exhaustive).toBe(true);

    const over = completionChain(MAX_COMPLETION + 1);
    expect(runStateMachine(over.model, over.machineId, []).completionBudgetHit).toBe(true);
    expect(exploreMachine(over.model, over.machineId).boundHit).toBe('completion');
    expect(exploreMachine(over.model, over.machineId).exhaustive).toBe(false);
  });
});

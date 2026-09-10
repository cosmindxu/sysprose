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
 *
 * The third half was added by a defect the first two did not catch, and it is
 * the same failure through a door the bounds do not cover: a walk that finished
 * inside every bound, over a guard nothing in the model decides. Its half of
 * this file is the last two describes.
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
  GUARD_UNDETERMINED_CODE,
  NONDETERMINISTIC_CHOICE_CODE,
  UNREACHABLE_STATE_CODE,
  edgeCensus,
  exploreMachine,
  reachReport,
  stateMachinesIn,
  walkableTransitions,
} from '../../src/semantics/mc/explore';
import { ALL_METACLASSES } from '../../src/core/metamodel';
import { SEMANTIC_PROFILE } from '../../src/semantics/mc/profile';
import {
  CONTROL_EDGE_KINDS,
  MAX_COMPLETION,
  STEP_EDGE_KINDS,
  SUCCESSION_KINDS,
  hashConfig,
  initialConfig,
  stepCandidates,
} from '../../src/semantics/mc/config';

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

  it('names the seven codes this engine can raise', () => {
    expect([...BEHAVIOUR_CODES].sort()).toEqual([
      'verification/behaviour-unsupported-construct',
      'verification/bound-exhausted',
      'verification/dead-transition',
      'verification/deadlock',
      'verification/guard-undetermined',
      'verification/nondeterministic-choice',
      'verification/unreachable-state',
    ]);
  });
});

/* ────────────── a guard nothing decided is not a guard that is false ─────── */

/**
 * The defect this gate closes, and the two controls that stop it over-firing.
 *
 * `GuardProbe::Ctrl` gives `mode` no value at all, so `if mode == 3` evaluates
 * to NOTHING. The step relation reads that as "does not fire" because it has to
 * pick something — and before the gate, the report read the same silence as
 * "the transition is never enabled" and published three absence findings under
 * the word `exhaustive`, on a ten-line model with no diagnostics of its own.
 *
 * The two controls are the same machine with a value. `= 4` makes the guard
 * genuinely FALSE: the absence findings are correct there and must still be
 * printed, or the fix has traded a false claim for a missing one. `= 3` makes it
 * hold, and nothing about that machine may change at all.
 */
describe('a guard the walk could not evaluate is not a guard that is false', () => {
  const PROBE = 'test/fixtures/verification/models/guard-undetermined.sysml';
  let report: ReturnType<typeof reachReport>;
  beforeAll(async () => {
    const loaded = await loadModelText(read(PROBE), { fileName: PROBE });
    report = reachReport(loaded.model!);
  }, 90_000);

  const machine = (owner: string) =>
    report.machines.find((m) => m.machine.qualifiedName === `GuardProbe::${owner}::Modes`)!;

  it('carries the guard, and the name nothing gave a value to, to the surface', () => {
    const ctrl = machine('Ctrl');
    expect(ctrl, `${PROBE} no longer declares GuardProbe::Ctrl::Modes`).toBeDefined();
    expect(ctrl.undeterminedGuards).toHaveLength(1);
    const row = ctrl.undeterminedGuards[0];
    expect(row.guard).toBe('mode == 3');
    expect(row.unresolved).toEqual(['mode']);
    expect(row.transition.from!.name).toBe('idle');
    expect(row.transition.to!.name).toBe('hazard');
  });

  it('withholds all three absence lists and never says `exhaustive`', () => {
    const ctrl = machine('Ctrl');
    // The walk FINISHED — no bound was hit — which is exactly why the four
    // older conditions all held and the report published anyway.
    expect(ctrl.boundHit).toBe('none');
    expect(ctrl.exhaustive).toBe(false);
    expect(ctrl.suppressed).toBe(true);
    expect(ctrl.states.unreachable).toEqual([]);
    expect(ctrl.transitions.dead).toEqual([]);
    // The deadlock row is an absence claim too — "this configuration has no way
    // out" — over the very edge the walk could not decide.
    expect(ctrl.deadlocks).toEqual([]);
    expect(ctrl.qualification).toContain('undetermined under');
    expect(ctrl.qualification).toContain('WITHHELD');
    expect(ctrl.qualification, 'the report called an undecided walk exhaustive').not.toContain(
      'exhaustive',
    );
  });

  it('warns, and the warning is the reason the lists are short', () => {
    const forCtrl = report.diagnostics.filter((d) =>
      d.elementName?.startsWith('GuardProbe::Ctrl::'),
    );
    const warned = forCtrl.filter((d) => d.code === GUARD_UNDETERMINED_CODE);
    expect(warned).toHaveLength(1);
    expect(warned[0].severity).toBe('warning');
    expect(warned[0].message).toContain('mode == 3');
    expect(warned[0].message).toContain('could not be evaluated');
    expect(warned[0].message).toContain('withheld');
    // Never the two sentences that would say the tool decided it.
    expect(warned[0].message).not.toContain('never enabled');
    expect(warned[0].hint).toContain('attribute mode : Integer = 3;');
    // And NOTHING else is filed about that machine: the three findings the
    // defect published are gone, and the reason is in their place.
    expect(forCtrl.map((d) => d.code)).toEqual([GUARD_UNDETERMINED_CODE]);
  });

  it('a guard that is genuinely false keeps every finding it had', () => {
    // The over-firing control. `mode = 4` makes `mode == 3` FALSE, decided, and
    // a fix that withheld here would have replaced a wrong claim with silence.
    const decided = machine('Decided');
    expect(decided.undeterminedGuards).toEqual([]);
    expect(decided.exhaustive).toBe(true);
    expect(decided.suppressed).toBe(false);
    expect(decided.qualification).toContain('exhaustive under');
    expect(decided.states.unreachable.map((s) => s.name)).toEqual(['hazard']);
    expect(decided.transitions.dead).toHaveLength(1);
    expect(decided.deadlocks.map((d) => d.leaf.name)).toEqual(['idle']);
    const codes = report.diagnostics
      .filter((d) => d.elementName?.startsWith('GuardProbe::Decided::'))
      .map((d) => d.code)
      .sort();
    expect(codes).toEqual([
      DEAD_TRANSITION_CODE,
      DEADLOCK_CODE,
      UNREACHABLE_STATE_CODE,
    ].sort());
  });

  it('a guard that holds fires, and is untouched', () => {
    const fires = machine('Fires');
    expect(fires.undeterminedGuards).toEqual([]);
    expect(fires.exhaustive).toBe(true);
    expect(fires.states.reachable.map((s) => s.name).sort()).toEqual(['hazard', 'idle']);
    expect(fires.states.unreachable).toEqual([]);
    expect(fires.transitions).toMatchObject({ total: 1, fired: 1 });
    expect(fires.transitions.dead).toEqual([]);
    expect(
      report.diagnostics.some(
        (d) => d.elementName?.startsWith('GuardProbe::Fires::') && d.code === GUARD_UNDETERMINED_CODE,
      ),
    ).toBe(false);
  });

  it('counts the undecided machine out of the exhaustive total', () => {
    expect(report.totals.machines).toBe(3);
    expect(report.totals.exhaustive).toBe(2);
  });

  it('a hidden choice survives an undetermined guard beside it', () => {
    // The asymmetry, stated as a test. `a -> b` and `a -> c` are enabled at once
    // on `go`; `a -> d` carries a guard nothing decides. The absence lists go,
    // because a withheld edge could have been enabled — but the CHOICE is an
    // existential claim about a configuration the walk reached, and withholding
    // an edge can only ever remove a candidate from it, never invent one.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Both');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    const c = f.state('c', sm.id);
    const d = f.state('d', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'go' });
    f.transition(a.id, c.id, { ownerId: sm.id, trigger: 'go' });
    f.transition(a.id, d.id, { ownerId: sm.id, trigger: 'go', guard: 'armed' });

    const only = reachReport(m).machines[0];
    expect(only.undeterminedGuards.map((g) => g.guard)).toEqual(['armed']);
    expect(only.undeterminedGuards[0].unresolved).toEqual(['armed']);
    expect(only.states.unreachable).toEqual([]);
    expect(only.transitions.dead).toEqual([]);
    expect(only.nondeterminism, 'a hidden choice was withheld by an unrelated guard').toHaveLength(
      1,
    );
    expect(only.nondeterminism[0].state.name).toBe('a');
    expect(only.nondeterminism[0].taken.to!.name).toBe('b');
  });

  it('reports one row per transition, not one per configuration it was consulted at', () => {
    // `s0 -> s1` on `go`, and a guarded self-loop the walk offers at both
    // configurations. One transition, one row, whatever the store did in
    // between.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Twice');
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'go' });
    f.transition(s1.id, s0.id, { ownerId: sm.id, trigger: 'back', guard: 'armed' });
    const only = reachReport(m).machines[0];
    expect(only.configs).toBeGreaterThan(1);
    expect(only.undeterminedGuards).toHaveLength(1);
    expect(reachReport(m).diagnostics.filter((d) => d.code === GUARD_UNDETERMINED_CODE)).toHaveLength(
      1,
    );
  });

  it('withholds a hidden choice a WITHHELD INNER EDGE would have manufactured', () => {
    // The other half of the asymmetry, and the half that was stated wrongly
    // first. `innermost` is read off the ENABLED list, so an undetermined guard
    // strictly inside it lowers the level the choice is read at and lets outer
    // transitions the priority rule would have beaten into the row. Measured on
    // this machine: with `armed` unvalued the report carried
    // `Outer: takes O1, never O2`; with `armed = 1` — the same guard, DECIDED,
    // and true — it carries no such row at all. A row that appears only because
    // an edge was withheld is one the withholding invented.
    const build = (armed?: number) => {
      const m = new Model();
      const f = new ModelFactory(m);
      const sm = f.stateDef('Hier');
      if (armed !== undefined) f.attribute('armed', sm.id, { type: 'Integer', value: armed });
      const outer = f.state('Outer', sm.id);
      const inner = f.state('inner', outer.id);
      const o1 = f.state('O1', sm.id);
      const o2 = f.state('O2', sm.id);
      f.transition(inner.id, inner.id, { ownerId: outer.id, trigger: 'go', guard: 'armed == 1' });
      f.transition(outer.id, o1.id, { ownerId: sm.id, trigger: 'go' });
      f.transition(outer.id, o2.id, { ownerId: sm.id, trigger: 'go' });
      return reachReport(m).machines[0];
    };
    const undecided = build();
    expect(undecided.undeterminedGuards.map((g) => g.guard)).toEqual(['armed == 1']);
    expect(
      undecided.nondeterminism,
      'a choice was reported at a level a withheld edge sits strictly inside',
    ).toEqual([]);
    // Decided TRUE: the inner self-loop wins the priority rule at every
    // configuration, so `Outer`'s two transitions are never the innermost
    // level and there is no choice. This is the reading the row above claimed.
    expect(build(1).nondeterminism).toEqual([]);
    // Decided FALSE: the inner edge really is not enabled, `Outer` really is
    // innermost, and the choice really is there. Still reported — the gate
    // reads "could not decide", never "did not fire".
    expect(build(2).nondeterminism.map((n) => n.state.name)).toEqual(['Outer']);
  });

  it('keeps a choice a withheld OUTER edge sits above', () => {
    // The other side of the level test, and the one that decides `>` rather
    // than `!==`. The choice is between `inner -> A` and `inner -> B`, at the
    // innermost level; the undetermined guard is on `Outer -> X`, OUTSIDE it. A
    // transition an inner state's priority beats fires in no run while the
    // inner one is enabled, so whether it would have been enabled changes
    // nothing about the two that were — the choice stands, and withholding it
    // would withdraw a finding the walk really made. (The same-level case is
    // the `a hidden choice survives an undetermined guard beside it` control
    // above.)
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Above');
    const outer = f.state('Outer', sm.id);
    const inner = f.state('inner', outer.id);
    const a = f.state('A', sm.id);
    const b = f.state('B', sm.id);
    const x = f.state('X', sm.id);
    f.transition(inner.id, a.id, { ownerId: outer.id, trigger: 'go' });
    f.transition(inner.id, b.id, { ownerId: outer.id, trigger: 'go' });
    f.transition(outer.id, x.id, { ownerId: sm.id, trigger: 'go', guard: 'armed' });
    const only = reachReport(m).machines[0];
    expect(only.undeterminedGuards.map((g) => g.guard)).toEqual(['armed']);
    expect(
      only.nondeterminism,
      'a choice at the innermost level was withheld by a guard OUTSIDE it',
    ).toHaveLength(1);
    expect(only.nondeterminism[0].state.name).toBe('inner');
  });

  it('a deadlock survives a BOUND and never an undetermined guard', () => {
    // The asymmetry the `deadlocks` gate is written on, and it is NOT the
    // `publishable` flag. A bound stops the walk ENQUEUEING successors; every
    // input is still offered at every configuration it dequeues, so a
    // configuration it found nothing enabled at is one it really found nothing
    // enabled at. An undetermined guard is different in kind: it is an edge out
    // that may have been enabled and nothing here decided whether it was.
    // Gating the row on `publishable` instead would withdraw a sound finding on
    // every partial walk, and nothing else in this file would notice.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Bnd');
    const s0 = f.state('s0', sm.id);
    const deadEnd = f.state('deadEnd', sm.id);
    f.transition(s0.id, deadEnd.id, { ownerId: sm.id, trigger: 'go' });
    let prev = s0;
    for (let i = 1; i <= 6; i++) {
      const s = f.state(`c${i}`, sm.id);
      f.transition(prev.id, s.id, { ownerId: sm.id, trigger: 'n' });
      prev = s;
    }
    const bounded = reachReport(m, { maxConfigs: 2 }).machines[0];
    expect(bounded.boundHit).toBe('configs');
    expect(bounded.suppressed).toBe(true);
    expect(bounded.states.unreachable).toEqual([]);
    expect(bounded.transitions.dead).toEqual([]);
    expect(
      bounded.deadlocks.map((d) => d.leaf.name),
      'a bound withdrew a deadlock it could not have made wrong',
    ).toContain('deadEnd');

    // And the same machine with one undetermined guard on the way out of the
    // dead end publishes none.
    const m2 = new Model();
    const f2 = new ModelFactory(m2);
    const sm2 = f2.stateDef('Undec');
    const a = f2.state('a', sm2.id);
    const stuck = f2.state('stuck', sm2.id);
    f2.transition(a.id, stuck.id, { ownerId: sm2.id, trigger: 'go' });
    f2.transition(stuck.id, a.id, { ownerId: sm2.id, trigger: 'back', guard: 'armed' });
    const undecided = reachReport(m2).machines[0];
    expect(undecided.boundHit).toBe('none');
    expect(undecided.undeterminedGuards).toHaveLength(1);
    expect(undecided.deadlocks).toEqual([]);
  });

  it('names BOTH causes when a bound stopped the walk as well', () => {
    // Two different repairs — value the feature, raise `--max-configs` — and a
    // reader shown only the first raises nothing and wonders why the lists are
    // still short.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('BothCauses');
    const s0 = f.state('s0', sm.id);
    // Consulted at the OPENING configuration, so the bound cannot stop the walk
    // reaching it, and a chain long enough that `--max-configs 3` does stop the
    // walk somewhere else.
    f.transition(s0.id, s0.id, { ownerId: sm.id, trigger: 'probe', guard: 'armed' });
    let prev = s0;
    for (let i = 1; i <= 6; i++) {
      const s = f.state(`s${i}`, sm.id);
      f.transition(prev.id, s.id, { ownerId: sm.id, trigger: 'n' });
      prev = s;
    }
    const r = reachReport(m, { maxConfigs: 3 }).machines[0];
    expect(r.boundHit).not.toBe('none');
    expect(r.undeterminedGuards.length).toBeGreaterThan(0);
    expect(r.qualification).toContain('undetermined under');
    expect(r.qualification, 'the bound the walk also hit went unnamed').toContain('bound');
  });

  it('names no missing feature when every name in the guard resolves', () => {
    // The boundary is `evalStr` answering nothing, and that is WIDER than an
    // unresolved name: `evaluate` yields no value for a non-boolean operand
    // under `not`, for a mixed-type comparison, and for non-finite arithmetic.
    // `mode` HAS a value in all four rows below. The direction is the
    // conservative one and stays — a guard the walk could not read is not a
    // guard that is false, whichever way it failed to read — but the hint must
    // not tell an author to give a value to a feature that already has one.
    const check = (guard: string) => {
      const m = new Model();
      const f = new ModelFactory(m);
      const sm = f.stateDef('TypeErr');
      f.attribute('mode', sm.id, { type: 'Integer', value: 3 });
      const s0 = f.state('s0', sm.id);
      const s1 = f.state('s1', sm.id);
      f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'go', guard });
      const r = reachReport(m);
      return { machine: r.machines[0], diags: r.diagnostics };
    };
    for (const guard of ['not mode', 'mode and true', 'mode > "x"', 'mode / 0 == 1']) {
      const { machine, diags } = check(guard);
      expect(machine.undeterminedGuards, `\`${guard}\` was decided`).toHaveLength(1);
      expect(machine.undeterminedGuards[0].unresolved).toEqual([]);
      const row = diags.find((d) => d.code === GUARD_UNDETERMINED_CODE)!;
      expect(row.message).toContain('could not read it as a value at all');
      expect(row.hint, `\`${guard}\` was blamed on a value \`mode\` already has`).not.toContain(
        'attribute mode : Integer = 3;',
      );
      expect(row.hint).toContain('not a predicate');
    }
  });

  it('`resolveNames` is a cost switch, not a second reading of the step relation', () => {
    // The interpreter's and the property search's hot path calls
    // `enabledTransitions`, which throws the undetermined rows away — so it must
    // not pay to parse each undetermined guard and walk its AST at every
    // configuration and every input. What it must NOT change is WHICH
    // transitions are undetermined: that is the step relation, and this module
    // exists because a second reading of it drifts from the first.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Cost');
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'go', guard: 'armed' });
    const cfg = initialConfig(m, sm.id).config;
    const input = { kind: 'trigger', trigger: 'go' } as const;
    const cheap = stepCandidates(m, cfg, input);
    const full = stepCandidates(m, cfg, input, true);
    expect(cheap.enabled).toEqual(full.enabled);
    expect(cheap.undetermined.map((u) => [u.transition.id, u.guard, u.level])).toEqual(
      full.undetermined.map((u) => [u.transition.id, u.guard, u.level]),
    );
    // Only the names differ, and only the caller that keeps them pays for them.
    expect(cheap.undetermined[0].unresolved).toEqual([]);
    expect(full.undetermined[0].unresolved).toEqual(['armed']);
    // And the walk is the caller that keeps them, so the report is unaffected.
    expect(reachReport(m).machines[0].undeterminedGuards[0].unresolved).toEqual(['armed']);
  });

  it('names every name that was ever missing, not only the first configuration’s', () => {
    // The union branch, and it needs TWO ROUTES to one state rather than a
    // prefix: a store only ever gains values along a run, so a guard consulted
    // at the opening configuration is already missing every name it will ever
    // miss and nothing later adds to it. Here `T` is reached two ways — one
    // assigns `a`, the other assigns `b` — so the SAME self-loop is
    // undetermined over `b` at one configuration and over `a` at the other, and
    // one row has to carry both. Dropping the later names would send an author
    // to fix half the guard.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Union');
    const s0 = f.state('s0', sm.id);
    const t = f.state('T', sm.id);
    f.transition(s0.id, t.id, { ownerId: sm.id, trigger: 'pa', effect: 'a = true' });
    f.transition(s0.id, t.id, { ownerId: sm.id, trigger: 'pb', effect: 'b = true' });
    const loop = f.transition(t.id, t.id, { ownerId: sm.id, trigger: 'probe', guard: 'a and b' });
    const only = reachReport(m).machines[0];
    const rows = only.undeterminedGuards.filter((g) => g.transition.id === loop.id);
    // ONE row for the transition, whatever the store did on the way in.
    expect(rows).toHaveLength(1);
    expect([...rows[0].unresolved].sort(), 'the row named only one route’s missing name').toEqual([
      'a',
      'b',
    ]);
  });

  it('a guard that yields a value which is not a boolean stays DECIDED', () => {
    // The other side of the line, and the reason the gate is written on
    // "could not evaluate" rather than on "is not true". `mode` HAS a value
    // here; it is 3, which is not `true`, and the walk decided that by reading
    // it. Calling that undetermined would fire this gate on a model nothing in
    // which is unknown.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('NotAPredicate');
    f.attribute('mode', sm.id, { type: 'Integer', value: 3 });
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'go', guard: 'mode' });
    const only = reachReport(m).machines[0];
    expect(only.undeterminedGuards).toEqual([]);
    expect(only.exhaustive).toBe(true);
    expect(only.states.unreachable.map((s) => s.name)).toEqual(['s1']);
  });
});

describe('the shipped examples carry no undetermined guard, so this fix moves nothing', () => {
  // MEASURED before the gate landed: no `.sysml` in this repository carries a
  // single transition guard, so every figure `reach` prints over the corpus has
  // to be identical afterwards. If one of these moves, the gate is over-firing
  // and the fix is wrong.
  for (const path of ['examples/uav-isr.sysml', 'examples/vehicle.sysml', 'examples/views-tour.sysml']) {
    it(`${path} — every machine still walks to exhaustion`, async () => {
      const loaded = await loadModelText(read(path), { fileName: path });
      const r = reachReport(loaded.model!);
      expect(r.machines.length).toBeGreaterThan(0);
      for (const m of r.machines) {
        expect(m.undeterminedGuards, `${m.machine.qualifiedName} gained an undetermined guard`).toEqual(
          [],
        );
        expect(m.exhaustive).toBe(true);
        expect(m.suppressed).toBe(false);
        expect(m.qualification).toContain('exhaustive under');
      }
      expect(r.diagnostics.filter((d) => d.code === GUARD_UNDETERMINED_CODE)).toEqual([]);
    }, 90_000);
  }
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

/* ─────────── an edge kind the walk skips is not an edge it may ignore ────── */

/**
 * The defect this gate closes, and the durable half beside it.
 *
 * `SuccMix::Ctrl::Modes` mixes the two edge kinds the notation offers between
 * states — `transition idle then active;` and `first active then done;`. The
 * step relation used to filter `TransitionUsage` alone, so the succession was
 * in no configuration, in no census and in no report — and the walk still
 * called itself `exhaustive` while publishing `done` unreachable and `active` a
 * state with no way out. Two absence claims about an edge nothing followed.
 *
 * `Loop` is the positive control: its succession closes a cycle, so a walk that
 * merely COUNTED the edge without following it would still deadlock at
 * `active`. And `Ctrl` keeps a no-way-out row at `done` afterwards, because
 * `done` really has no outgoing edge of either kind — the row that survives is
 * the one the whole graph supports.
 */
describe('a succession between two states is an edge of the machine', () => {
  const MIXED = 'test/fixtures/verification/models/succession-mixed.sysml';
  let report: ReturnType<typeof reachReport>;
  beforeAll(async () => {
    const loaded = await loadModelText(read(MIXED), { fileName: MIXED });
    report = reachReport(loaded.model!);
  }, 90_000);

  const machine = (owner: string) =>
    report.machines.find((m) => m.machine.qualifiedName === `SuccMix::${owner}::Modes`)!;

  it('counts the succession in the transition census', () => {
    const ctrl = machine('Ctrl');
    expect(ctrl, `${MIXED} no longer declares SuccMix::Ctrl::Modes`).toBeDefined();
    expect(ctrl.transitions.total, 'the succession is not in the census the walk reports').toBe(2);
    expect(ctrl.transitions.fired).toBe(2);
    expect(ctrl.transitions.dead).toEqual([]);
  });

  it('walks it, so nothing behind it is called unreachable', () => {
    const ctrl = machine('Ctrl');
    expect(ctrl.exhaustive).toBe(true);
    expect(ctrl.states.reachable.map((s) => s.name).sort()).toEqual(['active', 'done', 'idle']);
    expect(ctrl.states.unreachable, '`done` is behind a succession, not absent').toEqual([]);
    expect(report.diagnostics.filter((d) => d.code === UNREACHABLE_STATE_CODE)).toEqual([]);
    expect(report.diagnostics.filter((d) => d.code === DEAD_TRANSITION_CODE)).toEqual([]);
  });

  it('keeps the no-way-out row the whole graph does support, and only that one', () => {
    // `active` had one because the walk could not see the edge leaving it;
    // `done` has one because it genuinely has none. Naming both would be as
    // wrong as naming neither.
    const ctrl = machine('Ctrl');
    expect(ctrl.deadlocks.map((d) => d.leaf.name)).toEqual(['done']);
    const rows = report.diagnostics.filter((d) => d.code === DEADLOCK_CODE);
    expect(rows.map((d) => d.elementName)).toEqual(['SuccMix::Ctrl::Modes::done']);
  });

  it('the control: a succession that closes a cycle leaves nothing absent at all', () => {
    const loop = machine('Loop');
    expect(loop.exhaustive).toBe(true);
    expect(loop.states.reachable.map((s) => s.name).sort()).toEqual(['active', 'idle']);
    expect(loop.states.unreachable).toEqual([]);
    expect(loop.transitions).toMatchObject({ total: 2, fired: 2 });
    expect(loop.deadlocks, 'the succession was counted but not followed').toEqual([]);
  });

  it('a machine that owns no transition at all is still answered the same way', async () => {
    // The honest message this fix must not quietly replace: `stateMachinesIn`
    // reads "owns a TransitionUsage", so a purely succession-wired state
    // definition is not one of this tool's machines and nothing is walked or
    // claimed about it.
    const ONLY = 'test/fixtures/verification/models/succession-only.sysml';
    const loaded = await loadModelText(read(ONLY), { fileName: ONLY });
    const r = reachReport(loaded.model!);
    expect(r.machines).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  }, 90_000);
});

/* ─────────────────────────── the producer census ────────────────────────── */

/**
 * EVERY EDGE UNDER THE MACHINE IS ACCOUNTED FOR, or a test fails.
 *
 * Four readers have now found four different ways the relation the walk retains
 * differs from the machine an author wrote — dwell labels over-approximating,
 * the cooperative environment over-approximating, an undetermined guard
 * under-approximating, and an edge kind simply absent. Enumerating the
 * mechanisms has failed four times, so this is the census in the same spirit as
 * the verification lane's relation census (`test/integration/verification.
 * differential.test.ts`): the edges are counted WITHOUT asking the walk, and
 * each one has to land in a bucket that says what became of it. An edge kind
 * nobody thought about lands in `unaccounted`, which fails here AND refuses the
 * machine at run time — it can no longer shrink an absence list in silence.
 */
describe('the producer census: every edge is walked, or refused with a code', () => {
  it('accounts for every edge of every machine in the shipped examples', async () => {
    for (const path of ['examples/uav-isr.sysml', 'examples/vehicle.sysml', 'examples/views-tour.sysml']) {
      const loaded = await loadModelText(read(path), { fileName: path });
      const model = loaded.model!;
      const machines = stateMachinesIn(model);
      expect(machines.length, `${path} declares no machine`).toBeGreaterThan(0);
      for (const m of machines) {
        const census = edgeCensus(model, m.id);
        expect(census.unaccounted, `${path}: ${m.declaredName}`).toEqual([]);
        expect(census.rows).toHaveLength(census.total);
        // The published transition census IS the walked bucket, read two ways.
        expect(census.counts.walked).toBe(walkableTransitions(model, m.id).length);
      }
    }
  }, 90_000);

  it('puts a succession under a machine in the walked bucket', async () => {
    const MIXED = 'test/fixtures/verification/models/succession-mixed.sysml';
    const loaded = await loadModelText(read(MIXED), { fileName: MIXED });
    const model = loaded.model!;
    const ctrl = stateMachinesIn(model).find(
      (m) => model.qualifiedName(m.id) === 'SuccMix::Ctrl::Modes',
    )!;
    const census = edgeCensus(model, ctrl.id);
    expect(census.total).toBe(2);
    expect(census.counts.walked).toBe(2);
    expect(census.rows.map((r) => r.eClass).sort()).toEqual(['Succession', 'TransitionUsage']);
    expect(census.unaccounted).toEqual([]);
  }, 90_000);

  it('an edge kind neither walked nor refused fails the census AND refuses the machine', () => {
    // Constructed through the API because no surface syntax produces one: a
    // `SuccessionFlow` between two states carries a payload the step relation
    // does not model, and it is exactly the shape this gate is for.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Payload');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'go' });
    const flow = m.create('SuccessionFlow', {
      ownerId: sm.id,
      source: [b.id],
      target: [a.id],
    });

    const census = edgeCensus(m, sm.id);
    expect(census.total).toBe(2);
    expect(census.unaccounted.map((r) => r.id)).toEqual([flow.id]);
    expect(census.unaccounted[0].reason).toMatch(/the step relation does not hold this edge/i);

    // And the walk refuses the machine rather than publishing an absence over a
    // graph it knows is missing an edge.
    const walk = exploreMachine(m, sm.id);
    expect(walk.exhaustive).toBe(false);
    expect(walk.unsupported.map((u) => u.construct)).toEqual(['edge-not-walked']);
    const only = reachReport(m).machines[0];
    expect(only.exhaustive).toBe(false);
    expect(only.states.unreachable).toEqual([]);
    expect(only.transitions.dead).toEqual([]);
    expect(only.deadlocks).toEqual([]);
    expect(only.qualification).not.toContain('exhaustive');
    const finding = reachReport(m).diagnostics.find((d) => d.code === BEHAVIOUR_UNSUPPORTED_CODE);
    expect(finding!.severity).toBe('info');
    expect(finding!.message).toContain('is not explored');
  });

  it('the initial node’s edge is accounted for as read, never as walkable', () => {
    // The one edge a walk cannot reach and must not count: `initialState` reads
    // it to decide where the machine opens and no step ever fires it. It is in
    // the census with a reason, and out of the walkable total — undoing that
    // would report it dead on every exhaustive walk.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Opens');
    const start = m.create('InitialNode', { declaredName: 'start', ownerId: sm.id });
    const idle = f.state('idle', sm.id);
    const busy = f.state('busy', sm.id);
    const open = f.transition(start.id, idle.id, { ownerId: sm.id });
    f.transition(idle.id, busy.id, { ownerId: sm.id, trigger: 'go' });

    const census = edgeCensus(m, sm.id);
    expect(census.total).toBe(2);
    expect(census.unaccounted).toEqual([]);
    expect(census.rows.find((r) => r.id === open.id)!.account).toBe('opening');
    expect(walkableTransitions(m, sm.id).map((t) => t.id)).not.toContain(open.id);
    expect(reachReport(m).machines[0].transitions.total).toBe(1);
  });

  /*
   * THE DOMAIN, and the four ways the first reading of it was wrong.
   *
   * A census that counted "every descendant carrying an endpoint" counted a
   * `FeatureTyping`, a `Subsetting`, a `Disjoining` and a `ConnectionUsage` —
   * and, finding none of them in the step relation, refused the machine and
   * withheld the whole report. `state idle : Base;` is mainstream notation that
   * parses with no diagnostic at all, and the machine walked correctly before
   * the census existed, so the census was inventing a refusal rather than
   * catching a blind spot. None of those four ever carries the control token:
   * the relation is COMPLETE without them, which is what `not-a-step` says.
   */
  it('a typed, subsetted, connected or disjoint state is not an edge the walk is missing', async () => {
    const src =
      'package NotAStep {\n' +
      '    state def Base;\n' +
      '    part def C {\n' +
      '        state def M {\n' +
      '            state idle : Base;\n' +
      '            state active :> Base;\n' +
      '            state other;\n' +
      '            connect idle to active;\n' +
      '            disjoint active from other;\n' +
      '            transition idle then active;\n' +
      '            transition active then other;\n' +
      '        }\n' +
      '    }\n' +
      '}\n';
    const loaded = await loadModelText(src, { fileName: 'not-a-step.sysml' });
    expect(loaded.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const model = loaded.model!;
    const machine = stateMachinesIn(model)[0];

    const census = edgeCensus(model, machine.id);
    expect(
      census.rows.filter((r) => r.account === 'not-a-step').map((r) => r.eClass).sort(),
    ).toEqual(['ConnectionUsage', 'Disjoining', 'FeatureTyping', 'Subsetting']);
    expect(census.unaccounted).toEqual([]);
    expect(census.counts.walked).toBe(2);

    // And the report is a report, not a refusal.
    const only = reachReport(model).machines[0];
    expect(only.exhaustive).toBe(true);
    expect(only.unsupported).toEqual([]);
    expect(only.transitions.total).toBe(2);
    expect(only.states.reachable.map((r) => r.name).sort()).toEqual(['active', 'idle', 'other']);
  }, 90_000);

  /*
   * A REDEFINITION reaches the same bucket, and is built through the API
   * because `:>>` needs an inherited feature to redefine. The four above are
   * what the notation produces; this is the one a program produces.
   */
  it('a redefinition between two states is accounted for without refusing the machine', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Redef');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'go' });
    const redef = m.create('Redefinition', { ownerId: a.id, source: [a.id], target: [b.id] });

    const census = edgeCensus(m, sm.id);
    expect(census.rows.find((r) => r.id === redef.id)!.account).toBe('not-a-step');
    expect(census.unaccounted).toEqual([]);
    expect(reachReport(m).machines[0].exhaustive).toBe(true);
  });

  /*
   * THE STACK IS NOT A METACLASS. `stepConfig` pushes whatever the transition it
   * fired TARGETS, so a `decide` node between two states goes on the stack and
   * `stepCandidates` offers the edges leaving it — the walk demonstrably
   * traverses them. A census that read "leaves a `StateUsage`" called those
   * edges unaccounted and refused a machine the walk handles perfectly, while
   * the report it withheld had been correct at the commit before.
   */
  it('a step edge leaving a control node between two states is walked, not refused', async () => {
    const src =
      'package Fork {\n' +
      '    part def Ctrl {\n' +
      '        state def Modes {\n' +
      '            state idle;\n' +
      '            state active;\n' +
      '            state done;\n' +
      '            decide pick;\n' +
      '            transition idle then pick;\n' +
      '            transition pick then active;\n' +
      '            transition pick then done;\n' +
      '        }\n' +
      '    }\n' +
      '}\n';
    const loaded = await loadModelText(src, { fileName: 'fork.sysml' });
    expect(loaded.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const model = loaded.model!;
    const machine = stateMachinesIn(model)[0];

    const census = edgeCensus(model, machine.id);
    expect(census.counts.unaccounted).toBe(0);
    expect(census.counts.walked).toBe(3);
    expect(census.counts.walked).toBe(walkableTransitions(model, machine.id).length);

    const only = reachReport(model).machines[0];
    expect(only.exhaustive).toBe(true);
    expect(only.states.reachable.map((r) => r.name).sort()).toEqual(['active', 'done', 'idle']);
    expect(only.transitions.total).toBe(3);
    expect(only.transitions.fired).toBe(3);
    expect(only.transitions.dead).toEqual([]);
  }, 90_000);

  /*
   * THE OTHER DIRECTION OF THE SAME ERROR. `initialConfig` opens the machine at
   * the ROOT'S initial substate, so nothing the walk stands on is the root
   * itself — and an edge leaving it was counted walkable because its source was
   * a `StateUsage`, then reported `dead` on an exhaustive walk. That is a
   * finding the census invented rather than the walk finding it, which is the
   * exact hazard the walkable census exists to avoid.
   */
  it('an edge leaving the machine root is accounted for and never reported dead', async () => {
    const src =
      'package Root {\n' +
      '    part def C {\n' +
      '        state def M {\n' +
      '            state outer {\n' +
      '                state a;\n' +
      '                state b;\n' +
      '                transition a then b;\n' +
      '                transition outer then b;\n' +
      '            }\n' +
      '        }\n' +
      '    }\n' +
      '}\n';
    const loaded = await loadModelText(src, { fileName: 'root.sysml' });
    expect(loaded.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const model = loaded.model!;
    const machine = stateMachinesIn(model)[0];
    expect(model.qualifiedName(machine.id)).toBe('Root::C::M::outer');

    const census = edgeCensus(model, machine.id);
    const rootEdge = census.rows.find((r) => r.account === 'off-stack')!;
    expect(rootEdge.reason).toContain('leaves the machine root');
    expect(census.unaccounted).toEqual([]);

    const only = reachReport(model).machines[0];
    expect(only.exhaustive).toBe(true);
    expect(only.transitions.total).toBe(1);
    expect(only.transitions.dead).toEqual([]);
    expect(
      reachReport(model).diagnostics.filter((d) => d.code === DEAD_TRANSITION_CODE),
    ).toEqual([]);
  }, 90_000);

  /*
   * THE TEETH, PLACED WHERE THEY CAN ACTUALLY BITE.
   *
   * The `SuccessionFlow` case above puts the un-followed edge between two
   * STATES, and a census that bucketed by metaclass passed it while leaving a
   * hole one step to the left: the same edge between two ACTIONS the walk
   * enters from a state was filed `off-stack` — "neither end is a state of this
   * machine" — and the machine was published `exhaustive` with a deadlock row,
   * over an edge nothing had followed. Which is the first MUST-NEVER, inside
   * the mechanism written to close it. `off-stack` now means neither end is a
   * node the walk can STAND ON, which is computed from the relation.
   */
  it('an unfollowed edge between two non-state ends is caught, not filed off-stack', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Hole');
    const idle = f.state('idle', sm.id);
    const a = f.action('a', sm.id);
    const b = f.action('b', sm.id);
    // The walk enters `a` from a state, so `a` is on the stack — and an edge
    // leaving it is an edge of this machine however its ends are spelled.
    f.transition(idle.id, a.id, { ownerId: sm.id, trigger: 'go' });
    const flow = m.create('SuccessionFlow', { ownerId: sm.id, source: [a.id], target: [b.id] });

    const census = edgeCensus(m, sm.id);
    expect(census.unaccounted.map((r) => r.id)).toEqual([flow.id]);
    expect(census.counts['off-stack']).toBe(0);

    const only = reachReport(m).machines[0];
    expect(only.exhaustive).toBe(false);
    expect(only.unsupported.map((u) => u.construct)).toEqual(['edge-not-walked']);
    expect(only.deadlocks).toEqual([]);
    expect(only.qualification).not.toContain('exhaustive');
  });

  /*
   * TWO SPELLINGS OF ONE MISTAKE GET ONE ANSWER. `first busy then nowhere;` and
   * `transition busy then nowhere;` are the same missing endpoint, and while the
   * dangling filter still said `TransitionUsage` the succession was refused with
   * a sentence telling its author to write it as a succession — which is what
   * they had written.
   */
  it('a succession missing an endpoint is refused like a transition missing one', async () => {
    const body = (edge: string): string =>
      'package Dangle {\n' +
      '    part def C {\n' +
      '        state def M {\n' +
      '            state idle;\n' +
      '            state busy;\n' +
      '            transition idle then busy;\n' +
      `            ${edge}\n` +
      '        }\n' +
      '    }\n' +
      '}\n';
    for (const edge of ['first busy then nowhere;', 'transition busy then nowhere;']) {
      const loaded = await loadModelText(body(edge), { fileName: 'dangle.sysml' });
      const only = reachReport(loaded.model!).machines[0];
      expect(only.unsupported.map((u) => u.construct), edge).toEqual([
        'transition-without-endpoints',
      ]);
      expect(only.unsupported[0].detail, edge).toContain('Give it both endpoints.');
      expect(only.exhaustive, edge).toBe(false);
      expect(only.states.unreachable, edge).toEqual([]);
    }
  }, 90_000);

  /*
   * A PAYLOAD, NOT A METACLASS, IS WHAT THE RELATION CANNOT MODEL. This codebase
   * already reads a `Succession` carrying an item as a succession flow
   * (`itemFlowsOf`), so a metaclass test walked one of the two spellings of the
   * same object and published `exhaustive` over it, while two shipped documents
   * said a payload-carrying edge is refused.
   */
  it('a payload turns a succession into an edge the relation refuses', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Payload');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'go' });
    const carrying = m.create('Succession', {
      ownerId: sm.id,
      source: [b.id],
      target: [a.id],
      attrs: { payload: 'Cargo' },
    });

    const census = edgeCensus(m, sm.id);
    expect(census.unaccounted.map((r) => r.id)).toEqual([carrying.id]);
    expect(census.unaccounted[0].reason).toContain('models no payload');
    const only = reachReport(m).machines[0];
    expect(only.exhaustive).toBe(false);
    expect(only.transitions.dead).toEqual([]);
    expect(only.deadlocks).toEqual([]);

    // The control: the SAME edge without the payload is walked, so what is
    // refused is the payload and not the spelling.
    const plain = new Model();
    const pf = new ModelFactory(plain);
    const psm = pf.stateDef('Plain');
    const pa = pf.state('a', psm.id);
    const pb = pf.state('b', psm.id);
    pf.transition(pa.id, pb.id, { ownerId: psm.id, trigger: 'go' });
    plain.create('Succession', { ownerId: psm.id, source: [pb.id], target: [pa.id] });
    expect(edgeCensus(plain, psm.id).counts).toMatchObject({ walked: 2, unaccounted: 0 });
    expect(reachReport(plain).machines[0].exhaustive).toBe(true);
  });

  /*
   * THE DOMAIN IS PINNED TO THE METAMODEL, not to a list somebody remembered to
   * update. `Succession` went missing from the step relation in the first place
   * because a metaclass that sequences behaviour was never classified as one, so
   * a metaclass ADDED to this build cannot arrive without someone deciding which
   * side of the line it falls on: this goes red until they do.
   */
  it('every metaclass this build knows that sequences behaviour is in the census domain', () => {
    const sequencing = ALL_METACLASSES.filter((k) => /Transition|Succession/.test(k));
    expect([...CONTROL_EDGE_KINDS].sort()).toEqual([...sequencing].sort());
    // And the relation can never follow an edge the census does not classify:
    // that gap is exactly how an edge escapes both the walk and the refusal.
    for (const k of [...STEP_EDGE_KINDS, ...SUCCESSION_KINDS]) {
      expect(CONTROL_EDGE_KINDS.has(k), k).toBe(true);
    }
  });

  it('an edge with no end in the machine’s states is accounted for, not counted against it', () => {
    // A `do` action's own flow lives under the machine and is not an edge of
    // it: no configuration's stack ever holds an action node, so no step of
    // this relation could traverse it. Accounted for by name rather than
    // filtered away silently.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('WithAction');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'go' });
    const body = f.action('body', a.id);
    const step1 = f.action('step1', body.id);
    const step2 = f.action('step2', body.id);
    const inner = f.succession(step1.id, step2.id, body.id);

    const census = edgeCensus(m, sm.id);
    expect(census.unaccounted).toEqual([]);
    expect(census.rows.find((r) => r.id === inner.id)!.account).toBe('off-stack');
    expect(reachReport(m).machines[0].exhaustive).toBe(true);
  });
});

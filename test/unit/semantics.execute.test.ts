import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { loadModelText } from '@text/load';
import {
  runActionFlow,
  runStateMachine,
  propagateBindings,
  evaluateModel,
  executeModel,
  isSimulatable,
  discoverTriggers,
  SimulationSession,
} from '../../src/semantics/index';
import { initialSubstate } from '../../src/semantics/mc/config';

/* ───────────────────────────── action flow ───────────────────────────── */

/**
 * Build: start → a → fork → (b, c) → join → done.
 * Returns the model plus the ids of every node/edge for assertions.
 */
function forkJoinModel(): {
  model: Model;
  actionId: string;
  ids: Record<string, string>;
} {
  const m = new Model();
  const f = new ModelFactory(m);
  const act = f.actionDef('Drive');
  const start = m.create('InitialNode', { ownerId: act.id });
  const a = f.action('a', act.id);
  const fork = m.create('ForkNode', { declaredName: 'fk', ownerId: act.id });
  const b = f.action('b', act.id);
  const c = f.action('c', act.id);
  const join = m.create('JoinNode', { declaredName: 'jn', ownerId: act.id });
  const done = m.create('DoneNode', { ownerId: act.id });
  f.succession(start.id, a.id, act.id);
  f.succession(a.id, fork.id, act.id);
  f.succession(fork.id, b.id, act.id);
  f.succession(fork.id, c.id, act.id);
  f.succession(b.id, join.id, act.id);
  f.succession(c.id, join.id, act.id);
  f.succession(join.id, done.id, act.id);
  return {
    model: m,
    actionId: act.id,
    ids: { start: start.id, a: a.id, fork: fork.id, b: b.id, c: c.id, join: join.id, done: done.id },
  };
}

describe('runActionFlow — fork/join', () => {
  const { model, actionId, ids } = forkJoinModel();
  const trace = runActionFlow(model, actionId);
  const order = trace.steps.map((s) => s.id);
  const pos = (id: string): number => order.indexOf(id);

  it('visits every node', () => {
    expect(trace.steps.length).toBe(7);
  });

  it('starts at the InitialNode', () => {
    expect(trace.steps[0].id).toBe(ids.start);
    expect(trace.steps[0].kind).toBe('InitialNode');
  });

  it('orders a before both parallel branches b and c', () => {
    expect(pos(ids.a)).toBeLessThan(pos(ids.b));
    expect(pos(ids.a)).toBeLessThan(pos(ids.c));
  });

  it('places the fork before its branches', () => {
    expect(pos(ids.fork)).toBeLessThan(pos(ids.b));
    expect(pos(ids.fork)).toBeLessThan(pos(ids.c));
  });

  it('tags b and c with the same parallel group (the fork id)', () => {
    const b = trace.steps.find((s) => s.id === ids.b)!;
    const c = trace.steps.find((s) => s.id === ids.c)!;
    expect(b.parallelGroup).toBe(ids.fork);
    expect(c.parallelGroup).toBe(ids.fork);
  });

  it('does not tag the sequential nodes with a parallel group', () => {
    const a = trace.steps.find((s) => s.id === ids.a)!;
    expect(a.parallelGroup).toBeUndefined();
  });

  it('puts the join after both b and c', () => {
    expect(pos(ids.join)).toBeGreaterThan(pos(ids.b));
    expect(pos(ids.join)).toBeGreaterThan(pos(ids.c));
  });

  it('puts done last and marks the run complete', () => {
    expect(order[order.length - 1]).toBe(ids.done);
    expect(trace.complete).toBe(true);
  });

  it('fires every succession edge', () => {
    expect(trace.edgesFired.length).toBe(7);
  });

  it('is deterministic across runs', () => {
    const again = runActionFlow(model, actionId);
    expect(again.steps.map((s) => s.id)).toEqual(order);
  });
});

describe('runActionFlow — decision picks the true-guard branch', () => {
  function decisionModel(temp: number): { model: Model; actionId: string; hotId: string; coldId: string } {
    const m = new Model();
    const f = new ModelFactory(m);
    const act = f.actionDef('Regulate');
    f.attribute('temp', act.id, { type: 'Real', value: temp });
    const start = m.create('InitialNode', { ownerId: act.id });
    const decide = m.create('DecisionNode', { declaredName: 'd', ownerId: act.id });
    const hot = f.action('cool', act.id);
    const cold = f.action('heat', act.id);
    f.succession(start.id, decide.id, act.id);
    // Two guarded outgoing successions from the decision node.
    m.create('Succession', {
      ownerId: act.id,
      source: [decide.id],
      target: [hot.id],
      attrs: { guard: 'temp > 20' },
    });
    m.create('Succession', {
      ownerId: act.id,
      source: [decide.id],
      target: [cold.id],
      attrs: { guard: 'temp <= 20' },
    });
    return { model: m, actionId: act.id, hotId: hot.id, coldId: cold.id };
  }

  it('takes the hot branch when temp is high', () => {
    const { model, actionId, hotId, coldId } = decisionModel(30);
    const trace = runActionFlow(model, actionId);
    const visited = trace.steps.map((s) => s.id);
    expect(visited).toContain(hotId);
    expect(visited).not.toContain(coldId);
    const hotStep = trace.steps.find((s) => s.id === hotId)!;
    expect(hotStep.guard).toBe('temp > 20');
  });

  it('takes the cold branch when temp is low', () => {
    const { model, actionId, hotId, coldId } = decisionModel(10);
    const trace = runActionFlow(model, actionId);
    const visited = trace.steps.map((s) => s.id);
    expect(visited).toContain(coldId);
    expect(visited).not.toContain(hotId);
  });
});

/* ─────────────────────────── state machine ───────────────────────────── */

function stateMachineModel(): {
  model: Model;
  smId: string;
  ids: Record<string, string>;
} {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('VehicleStates');
  const off = f.state('off', sm.id);
  const running = f.state('running', sm.id);
  const idle = f.state('idle', sm.id);
  // off --start--> running --stop--> off ; running --pause--> idle ; idle --resume--> running
  f.transition(off.id, running.id, { ownerId: sm.id, trigger: 'start' });
  f.transition(running.id, off.id, { ownerId: sm.id, trigger: 'stop' });
  f.transition(running.id, idle.id, { ownerId: sm.id, trigger: 'pause' });
  f.transition(idle.id, running.id, { ownerId: sm.id, trigger: 'resume' });
  return { model: m, smId: sm.id, ids: { off: off.id, running: running.id, idle: idle.id } };
}

describe('runStateMachine', () => {
  it('starts at the first state and fires transitions per triggers', () => {
    const { model, smId, ids } = stateMachineModel();
    const res = runStateMachine(model, smId, ['start', 'pause', 'resume', 'stop']);
    expect(res.visited[0]).toBe(ids.off);
    expect(res.visited).toEqual([ids.off, ids.running, ids.idle, ids.running, ids.off]);
    expect(res.finalState).toBe(ids.off);
    expect(res.fired.length).toBe(4);
    expect(res.fired[0].trigger).toBe('start');
    expect(res.fired[0].from).toBe(ids.off);
    expect(res.fired[0].to).toBe(ids.running);
  });

  it('ignores triggers with no enabled transition (stays put)', () => {
    const { model, smId, ids } = stateMachineModel();
    // 'stop' is not enabled from 'off'; only 'start' is.
    const res = runStateMachine(model, smId, ['stop', 'stop', 'start']);
    expect(res.fired.length).toBe(1);
    expect(res.finalState).toBe(ids.running);
  });

  it('respects transition guards', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Guarded');
    f.attribute('ready', sm.id, { type: 'Boolean', value: false });
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'go', guard: 'ready' });
    const res = runStateMachine(m, sm.id, ['go']);
    // guard false ⇒ no transition fires
    expect(res.fired.length).toBe(0);
    expect(res.finalState).toBe(s0.id);
  });
});

/**
 * A `state def` written inside a machine is a machine of its own, and the walk
 * stops at it (`regionDescendants`, `src/semantics/mc/config.ts`). The flat
 * interpreter path took its start state from every descendant, so a nested
 * definition declared BEFORE the outer machine's states handed the simulator
 * its own first state: on `nest3-first` the Simulation tab, `executeModel` and
 * the SDK started in `Inner::x` and never entered `a`, while the walk (and every
 * witness it publishes) started in `a`. The shapes are review B's probes (plan
 * O1, M3).
 */
describe('runStateMachine — a nested state def does not take the start (M3)', () => {
  const SHAPES: Record<string, string> = {
    'nest1-plain': `package Nest1 {
      state def Outer {
        state a; state b;
        transition ab first a accept e then b;
        state def Inner { state x; state y; transition xy first x accept go then y; }
      }
    }`,
    'nest2-into': `package Nest2 {
      state def Outer {
        state a; state b;
        transition ax first a accept e then Inner::x;
        state def Inner {
          state x; state y;
          transition xy first x accept go then y;
          transition yb first y accept back then Outer::b;
        }
      }
    }`,
    'nest3-first': `package Nest3 {
      state def Outer {
        state def Inner { state x; state y; transition xy first x accept go then y; }
        state a; state b;
        transition ab first a accept e then b;
      }
    }`,
    'nest4-typed': `package Nest4 {
      state def Outer {
        state def Inner { state x; state y; transition xy first x accept go then y; }
        state a;
        state s : Inner;
        transition toS first a accept e then s;
      }
    }`,
    'nest5-partdef': `package Nest5 {
      part def Drone {
        state def Outer {
          state a; state b;
          transition ab first a accept e then b;
          state def Inner { state x; state y; transition xy first x accept go then y; }
        }
      }
    }`,
    'nest6-prop': `package Nest6 {
      state def Outer {
        @SysproseVerification::PropertyPattern { attribute pattern = "absence"; attribute scope = "globally"; attribute p = "state b"; }
        state a; state b;
        transition ab first a accept e then b;
        state def Inner { state x; state y; transition xy first x accept go then y; }
      }
    }`,
  };

  async function outerOf(name: string) {
    const model = (await loadModelText(SHAPES[name], { fileName: `${name}.sysml`, library: 'none' })).model!;
    const outer = model.all().find((e) => e.eClass === 'StateDefinition' && e.declaredName === 'Outer')!;
    const named = (n: string) => model.all().find((e) => e.declaredName === n)!.id;
    return { model, outer, named };
  }

  it('starts every probe shape in the outer machine’s first state, where the walk starts', async () => {
    for (const name of Object.keys(SHAPES)) {
      const { model, outer, named } = await outerOf(name);
      const res = runStateMachine(model, outer.id, []);
      expect(res.visited[0], `${name}: the simulator's start`).toBe(named('a'));
      // The walk enters `initialSubstate` (`initialConfig`, `./mc/config.ts`);
      // the simulator must start where the walk starts.
      expect(res.visited[0], `${name}: the walk's start`).toBe(initialSubstate(model, outer.id));
    }
  });

  it('nest3-first: the nested definition declared first does not steal the start, and `e` reaches b', async () => {
    const { model, outer, named } = await outerOf('nest3-first');
    // `go` is the nested definition's trigger: no outer transition takes it.
    const res = runStateMachine(model, outer.id, ['go', 'e']);
    expect(res.visited).toEqual([named('a'), named('b')]);
    expect(res.fired.map((f) => f.transitionId)).toEqual([named('ab')]);
    expect(res.finalState).toBe(named('b'));
  });

  it('nest4-typed: a typed usage of the nested definition is the outer machine’s state, entered from a', async () => {
    const { model, outer, named } = await outerOf('nest4-typed');
    const res = runStateMachine(model, outer.id, ['e']);
    expect(res.visited).toEqual([named('a'), named('s')]);
    expect(res.finalState).toBe(named('s'));
  });

  it('nest1-plain and nest5-partdef (nested definition declared last) run as before', async () => {
    for (const name of ['nest1-plain', 'nest5-partdef']) {
      const { model, outer, named } = await outerOf(name);
      const res = runStateMachine(model, outer.id, ['go', 'e']);
      expect(res.visited, name).toEqual([named('a'), named('b')]);
      expect(res.fired.map((f) => f.transitionId), name).toEqual([named('ab')]);
    }
  });

  it('an `initial` node inside the nested definition does not choose the outer start; the outer’s own does', async () => {
    // The InitialNode came from the same descendant list: the nested definition's,
    // declared first, sent the outer run to `Inner::y` even past the outer
    // machine's own `initial`, while the walk opened at `a` (or `b`).
    const inner = 'state def Inner { initial j; first j then y; state x; state y; transition yx first y accept go then x; }';
    const cases: Array<[string, string]> = [
      [`package P { state def Outer { ${inner} state a; state b; transition ab first a accept e then b; } }`, 'a'],
      [
        `package P { state def Outer { ${inner} initial i; first i then b; state a; state b; transition ba first b accept e then a; } }`,
        'b',
      ],
    ];
    for (const [text, start] of cases) {
      const model = (await loadModelText(text, { fileName: 'initial.sysml', library: 'none' })).model!;
      const outer = model.all().find((e) => e.eClass === 'StateDefinition' && e.declaredName === 'Outer')!;
      const want = model.all().find((e) => e.declaredName === start)!.id;
      expect(runStateMachine(model, outer.id, []).visited[0], start).toBe(want);
      expect(initialSubstate(model, outer.id), start).toBe(want);
    }
  });

  it('the nested definition run by itself still starts in its own first state', async () => {
    const { model, named } = await outerOf('nest3-first');
    const res = runStateMachine(model, named('Inner'), ['go']);
    expect(res.visited).toEqual([named('x'), named('y')]);
  });

  /*
   * The machines and events the Simulation tab and `executeModel` offer read the
   * same region (the branch review's wrap-only probe). Over every descendant, a
   * `state def` holding only a nested definition was the tab's machine, with the
   * nested definition's `go` as its event and a run with no state at all, since
   * its own region holds none — and the nested definition, the one with the
   * transitions, was never listed.
   */
  it('a `state def` whose only content is a nested definition is no machine: the tab and the report name the nested one', async () => {
    for (const text of [
      'package W6 { state def Wrapper { state def Inner { state x; state y; transition xy first x accept go then y; } } }',
      'package W6 { part def Drone { state def Wrapper { state def Inner { state x; state y; transition xy first x accept go then y; } } } }',
    ]) {
      const model = (await loadModelText(text, { fileName: 'wrap.sysml', library: 'none' })).model!;
      const named = (n: string) => model.all().find((e) => e.declaredName === n)!.id;
      expect(isSimulatable(model, named('Wrapper'))).toBe(false);
      expect(isSimulatable(model, named('Inner'))).toBe(true);
      // The tab's rule (`outermostSimulatable`, `SimulationTab`): simulatable,
      // under nothing simulatable.
      const tab = model
        .all()
        .filter((e) => isSimulatable(model, e.id) && !model.ancestors(e.id).some((a) => isSimulatable(model, a.id)));
      expect(tab.map((e) => e.id)).toEqual([named('Inner')]);
      const session = new SimulationSession(model, named('Inner'));
      expect(session.triggers).toEqual(['go']);
      expect(session.trace[0].activeStates).toEqual([named('x')]);
      expect(session.inject('go').activeStates).toEqual([named('y')]);
      const traces = executeModel(model).traces.filter((t) => t.kind === 'state');
      expect(traces.map((t) => t.behaviorId)).toEqual([named('Inner')]);
      expect(traces[0].state!.finalState).toBe(named('x'));
    }
  });

  it('an outer machine’s events are its own region’s: the nested definition’s `go` is not one of them', async () => {
    for (const name of ['nest1-plain', 'nest3-first', 'nest5-partdef']) {
      const { model, outer, named } = await outerOf(name);
      expect(discoverTriggers(model, outer.id), name).toEqual(['e']);
      expect(new SimulationSession(model, outer.id).triggers, name).toEqual(['e']);
      expect(discoverTriggers(model, named('Inner')), name).toEqual(['go']);
      // The nested definition is under a machine, so the tab and the report
      // still name the outer one only, as before.
      expect(executeModel(model).traces.filter((t) => t.kind === 'state').map((t) => t.behaviorId), name).toEqual([outer.id]);
    }
  });
});

/**
 * `follow`: the declaration-order tie-break resolved the way a recorded run
 * resolved it, and nothing else. `check-behaviour` replays every witness it
 * publishes through `runStateMachine` with it (plan O1, the replay invariant),
 * so a witness that took the second branch of a choice replays through the
 * interpreter itself — and a run that asks for anything the interpreter's own
 * rules forbid still gets the interpreter's run.
 */
describe('runStateMachine — `follow` resolves the tie-break and nothing else', () => {
  /** `a` with two completions out of it (`ab` first), each with an event on. */
  async function choiceAndCycle() {
    const text = `package F {
      state def M {
        state a; state b; state c; state d; state e;
        transition ab first a then b;
        transition ac first a then c;
        transition bd first b accept go then d;
        transition cd first c accept go then d;
        transition de first d then e;
        transition ed first e then d;
        transition ex first e accept out then a;
      }
    }`;
    const model = (await loadModelText(text, { fileName: 'follow.sysml', library: 'none' })).model!;
    const named = (n: string) => model.all().find((x) => x.declaredName === n)!.id;
    return { model, m: named('M'), named };
  }

  it('without it, every run is the simulator’s: the first declared branch', async () => {
    const { model, m, named } = await choiceAndCycle();
    const res = runStateMachine(model, m, ['go']);
    expect(res.fired.slice(0, 2).map((f) => f.transitionId)).toEqual([named('ab'), named('bd')]);
  });

  it('with it, the run takes the named branch where the tie-break chooses', async () => {
    const { model, m, named } = await choiceAndCycle();
    const res = runStateMachine(model, m, ['go'], { follow: [named('ac'), named('cd')] });
    expect(res.fired.slice(0, 2).map((f) => f.transitionId)).toEqual([named('ac'), named('cd')]);
    expect(res.visited.slice(0, 3)).toEqual([named('a'), named('c'), named('d')]);
  });

  it('on the hierarchical path too, and never across the priority rule', async () => {
    const text = `package H {
      state def M {
        state p {
          state a; state b; state c;
          transition ab first a then b;
          transition ac first a then c;
        }
        state q;
        transition pq first p then q;
      }
    }`;
    const model = (await loadModelText(text, { fileName: 'follow-h.sysml', library: 'none' })).model!;
    const named = (n: string) => model.all().find((x) => x.declaredName === n)!.id;
    const m = named('M');
    expect(runStateMachine(model, m, [], { follow: [named('ac')] }).fired[0].transitionId).toBe(named('ac'));
    // `pq` leaves the composite: the inner level wins, so naming it changes nothing.
    expect(runStateMachine(model, m, [], { follow: [named('pq')] }).fired[0].transitionId).toBe(named('ab'));
  });

  it('a transition that is not enabled where it is named is not taken: the run parts from the list', async () => {
    const { model, m, named } = await choiceAndCycle();
    // `cd` is not enabled at `a`; the interpreter fires its own head there.
    const res = runStateMachine(model, m, [], { follow: [named('cd')] });
    expect(res.fired[0].transitionId).toBe(named('ab'));
  });

  it('cannot move the chase budget: the chase stops at 64 fires however long the list', async () => {
    const { model, m, named } = await choiceAndCycle();
    // `go` lands in d, whose completions cycle d ⇄ e; a list naming 100 of
    // them still gets the interpreter's 64, then the next event at the stop.
    const cycle = Array.from({ length: 100 }, (_, i) => named(i % 2 === 0 ? 'de' : 'ed'));
    const res = runStateMachine(model, m, ['go', 'out'], { follow: [named('ab'), named('bd'), ...cycle] });
    expect(res.completionBudgetHit).toBe(true);
    // 1 completion (ab), 1 event (bd), then the chase: 64 completions, and the
    // stop is at `d` (an even number of fires), where `out` is not accepted.
    expect(res.fired.slice(2).filter((f) => f.trigger === '')).toHaveLength(64);
    expect(res.fired.some((f) => f.transitionId === named('ex'))).toBe(false);
    expect(res.finalState).toBe(named('d'));
  });
});

/* ─────────────────────────── binding propagation ─────────────────────── */

describe('propagateBindings', () => {
  it('propagates a known value across a bind connector (a bind b, b=5 ⇒ a=5)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real', value: 5 });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [a.id], target: [b.id] });
    const values = propagateBindings(m);
    expect(values.get(a.id)).toBe(5);
    expect(values.get(b.id)).toBe(5);
  });

  it('propagates transitively through a chain (a=b, b=c, c=7)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real' });
    const c = f.attribute('c', p.id, { type: 'Real', value: 7 });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [a.id], target: [b.id] });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [b.id], target: [c.id] });
    const values = propagateBindings(m);
    expect(values.get(a.id)).toBe(7);
    expect(values.get(b.id)).toBe(7);
  });

  it('leaves an undetermined component unknown', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real' });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [a.id], target: [b.id] });
    const values = propagateBindings(m);
    expect(values.has(a.id)).toBe(false);
    expect(values.has(b.id)).toBe(false);
  });
});

/* ─────────────────────────── model evaluation ────────────────────────── */

describe('evaluateModel', () => {
  it('evaluates literals and derived/dependent feature expressions', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real', value: 3 });
    const b = f.attribute('b', p.id, { type: 'Real', value: 4 });
    const total = f.attribute('total', p.id, { type: 'Real', value: 'a + b' });
    const { values } = evaluateModel(m);
    expect(values.get(a.id)).toBe(3);
    expect(values.get(b.id)).toBe(4);
    expect(values.get(total.id)).toBe(7);
  });

  it('incorporates bound values into the value map', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real', value: 9 });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [a.id], target: [b.id] });
    const { values } = evaluateModel(m);
    expect(values.get(a.id)).toBe(9);
  });

  it('returns satisfied / violated constraint results', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Widget');
    f.attribute('count', p.id, { type: 'Integer', value: 10 });
    const ok = m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'count > 5' } });
    const bad = m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'count < 5' } });
    const { constraints } = evaluateModel(m);
    expect(constraints.find((c) => c.id === ok.id)!.result).toBe('satisfied');
    expect(constraints.find((c) => c.id === bad.id)!.result).toBe('violated');
  });

  it('resolves a chained derived feature through bindings and expressions', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const base = f.attribute('base', p.id, { type: 'Real', value: 10 });
    const mirror = f.attribute('mirror', p.id, { type: 'Real' });
    const doubled = f.attribute('doubled', p.id, { type: 'Real', value: 'mirror * 2' });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [mirror.id], target: [base.id] });
    const { values } = evaluateModel(m);
    expect(values.get(mirror.id)).toBe(10);
    expect(values.get(doubled.id)).toBe(20);
  });
});

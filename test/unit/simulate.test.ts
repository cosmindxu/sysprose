import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  SimulationSession,
  simulateStateMachine,
  isSimulatable,
  discoverTriggers,
  refusedStepSentence,
  runStateMachine,
  setStatementKind,
  simulationAtRest,
} from '../../src/semantics/index';
import { executionReport, simulationReport } from '../../src/api/analytics';
import { reachReport, stateMachinesIn } from '../../src/semantics/mc/explore';

/** off --start--> running --stop--> off ; running --pause--> idle --resume--> running */
function vehicleSM(): { model: Model; smId: string; ids: Record<string, string> } {
  const m = new Model();
  const f = new ModelFactory(m);
  const sm = f.stateDef('VehicleStates');
  const off = f.state('off', sm.id);
  const running = f.state('running', sm.id);
  const idle = f.state('idle', sm.id);
  f.transition(off.id, running.id, { ownerId: sm.id, trigger: 'start' });
  f.transition(running.id, off.id, { ownerId: sm.id, trigger: 'stop' });
  f.transition(running.id, idle.id, { ownerId: sm.id, trigger: 'pause' });
  f.transition(idle.id, running.id, { ownerId: sm.id, trigger: 'resume' });
  return { model: m, smId: sm.id, ids: { off: off.id, running: running.id, idle: idle.id } };
}

describe('SimulationSession — interactive stepping', () => {
  it('captures an initial sample at the initial state, clock 0', () => {
    const { model, smId, ids } = vehicleSM();
    const s = new SimulationSession(model, smId);
    expect(s.trace.length).toBe(1);
    expect(s.trace[0].index).toBe(0);
    expect(s.trace[0].clock).toBe(0);
    expect(s.trace[0].activeStates).toEqual([ids.off]);
    expect(s.trace[0].activeStateNames).toEqual(['off']);
    expect(s.trace[0].event).toBeNull();
  });

  it('injects events, firing enabled transitions with per-step firing deltas', () => {
    const { model, smId, ids } = vehicleSM();
    const s = new SimulationSession(model, smId);
    const a = s.inject('start');
    expect(a.activeStates).toEqual([ids.running]);
    expect(a.event).toBe('start');
    expect(a.fired.map((f) => f.trigger)).toEqual(['start']);
    expect(a.fired[0].from).toBe(ids.off);
    expect(a.fired[0].to).toBe(ids.running);

    const b = s.inject('pause');
    expect(b.activeStates).toEqual([ids.idle]);
    expect(b.fired.length).toBe(1); // only the pause transition this step
  });

  it('stays consistent when a time advance is added AFTER named events', () => {
    // runStateMachine routes to the hierarchical interpreter once ANY step is
    // timed; adding advance() after events re-runs the whole script through it.
    // The event samples must stay consistent and the advance must not spuriously
    // re-fire earlier transitions (prefix-stable firing delta).
    const { model, smId, ids } = vehicleSM();
    const s = new SimulationSession(model, smId);
    s.inject('start');
    const pauseSample = s.inject('pause');
    expect(pauseSample.activeStates).toEqual([ids.idle]);
    const adv = s.advance(1);
    expect(adv.clock).toBe(1);
    expect(adv.activeStates).toEqual([ids.idle]); // unchanged (no timed transition)
    expect(adv.fired).toEqual([]); // the advance fires nothing new
  });

  it('a disabled trigger fires nothing and stays put', () => {
    const { model, smId, ids } = vehicleSM();
    const s = new SimulationSession(model, smId);
    s.inject('start'); // → running
    s.inject('pause'); // → idle
    const c = s.inject('start'); // not enabled from idle
    expect(c.fired.length).toBe(0);
    expect(c.activeStates).toEqual([ids.idle]);
  });

  it('discovers the injectable trigger alphabet and is simulatable', () => {
    const { model, smId } = vehicleSM();
    expect([...discoverTriggers(model, smId)].sort()).toEqual(['pause', 'resume', 'start', 'stop']);
    expect(isSimulatable(model, smId)).toBe(true);
    const attr = new Model();
    expect(isSimulatable(attr, 'nope')).toBe(false);
  });

  it('reset re-captures the initial sample and clears history', () => {
    const { model, smId, ids } = vehicleSM();
    const s = new SimulationSession(model, smId);
    s.inject('start');
    expect(s.trace.length).toBe(2);
    const init = s.reset();
    expect(s.trace.length).toBe(1);
    expect(init.activeStates).toEqual([ids.off]);
    expect(s.clock).toBe(0);
  });
});

describe('SimulationSession — orthogonal (parallel) machines', () => {
  /**
   * Two concurrent regions: Drive (declared first: d1 --on--> d2) and Lights
   * (declared second: l1 --go--> l2). runStateMachine concatenates fired lists
   * BY REGION, so injecting 'go' then 'on' inserts the new Drive fire ahead of
   * the already-reported Lights fire in the cumulative list — the per-step delta
   * must still be exact (multiset diff, not a length slice).
   */
  function parallelSM() {
    const m = new Model();
    const f = new ModelFactory(m);
    const top = f.stateDef('Top');
    m.setAttrs(top.id, { parallel: true });
    const drive = f.state('Drive', top.id);
    const d1 = f.state('d1', drive.id);
    const d2 = f.state('d2', drive.id);
    f.transition(d1.id, d2.id, { ownerId: drive.id, trigger: 'on' });
    const lights = f.state('Lights', top.id);
    const l1 = f.state('l1', lights.id);
    const l2 = f.state('l2', lights.id);
    f.transition(l1.id, l2.id, { ownerId: lights.id, trigger: 'go' });
    return { m, topId: top.id, ids: { d2: d2.id, l2: l2.id } };
  }

  it('reports each region fire exactly once, in the right step (multiset delta)', () => {
    const { m, topId, ids } = parallelSM();
    const s = new SimulationSession(m, topId);
    const goStep = s.inject('go');
    expect(goStep.fired.map((f) => f.trigger)).toEqual(['go']);
    const onStep = s.inject('on');
    // The Drive 'on' fire is new THIS step (and not the stale 'go' duplicated).
    expect(onStep.fired.map((f) => f.trigger)).toEqual(['on']);
    // Both regions actually advanced.
    expect(onStep.activeStates).toContain(ids.d2);
    expect(onStep.activeStates).toContain(ids.l2);
    // Across the whole run each trigger fired exactly once.
    const allFires = s.trace.flatMap((sm) => sm.fired.map((f) => f.trigger));
    expect(allFires.sort()).toEqual(['go', 'on']);
  });
});

describe('SimulationSession — effects, guards, values', () => {
  it('seeds the initial value snapshot from the model literals, and initialStore overrides', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Seed');
    f.attribute('count', sm.id, { type: 'Integer', value: 0 });
    f.state('s0', sm.id);
    // Initial sample reflects the declared literal (count = 0), before any event.
    const s = new SimulationSession(m, sm.id);
    expect(s.trace[0].values.count).toBe(0);
    // initialStore overrides the literal on every re-run.
    const s2 = new SimulationSession(m, sm.id, { initialStore: { count: 42 } });
    expect(s2.trace[0].values.count).toBe(42);
  });

  it('transition effects mutate the value snapshot', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Counter');
    f.attribute('count', sm.id, { type: 'Integer', value: 0 });
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'inc', effect: 'count = count + 1' });
    f.transition(s1.id, s0.id, { ownerId: sm.id, trigger: 'inc2', effect: 'count = count + 10' });
    const s = new SimulationSession(m, sm.id);
    expect(s.inject('inc').values.count).toBe(1);
    expect(s.inject('inc2').values.count).toBe(11);
  });

  it('a guard becomes enabled once a prior effect sets its variable', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Gate');
    f.attribute('open', sm.id, { type: 'Boolean', value: false });
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    const s2 = f.state('s2', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'arm', effect: 'open = true' });
    f.transition(s1.id, s2.id, { ownerId: sm.id, trigger: 'go', guard: 'open' });
    const s = new SimulationSession(m, sm.id);
    s.inject('arm'); // open = true, now at s1
    const g = s.inject('go'); // guard open holds → fire
    expect(g.activeStates).toEqual([s2.id]);
    expect(g.values.open).toBe(true);
  });

  it('tracks live constraint status against the running values', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Speed');
    f.attribute('speed', sm.id, { type: 'Real', value: 0 });
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'floor', effect: 'speed = 120' });
    const limit = m.create('ConstraintUsage', {
      ownerId: sm.id,
      declaredName: 'limit',
      attrs: { expression: 'speed <= 100' },
    });
    const s = new SimulationSession(m, sm.id);
    const before = s.trace[0].constraints.find((c) => c.id === limit.id);
    expect(before?.status).toBe('satisfied'); // speed 0 ≤ 100
    const after = s.inject('floor').constraints.find((c) => c.id === limit.id);
    expect(after?.status).toBe('violated'); // speed 120 ≤ 100 → violated
  });

  /**
   * A `#prose` / `#prompt` statement binds nothing, so this panel has no status
   * to report for it — and the Problems panel is already silent about it. Two
   * surfaces calling the same statement `violated` and `not a constraint at all`
   * is a disagreement no author could explain.
   */
  it('leaves out a statement the author tagged as binding nothing', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Speed');
    f.attribute('speed', sm.id, { type: 'Real', value: 120 });
    f.state('s0', sm.id);
    const rule = m.create('ConstraintUsage', {
      ownerId: sm.id,
      declaredName: 'limit',
      attrs: { expression: 'speed <= 100' },
    });
    const note = m.create('RequirementUsage', {
      ownerId: sm.id,
      declaredName: 'aNote',
      attrs: { expression: 'speed <= 100' },
    });
    setStatementKind(m, note.id, 'prose');
    const rows = new SimulationSession(m, sm.id).trace[0].constraints;
    expect(rows.map((c) => c.id)).toEqual([rule.id]);
    expect(rows.find((c) => c.id === note.id)).toBeUndefined();
  });
});

describe('SimulationSession — parametrics in the loop (Phase 3)', () => {
  function engineSM() {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Engine');
    f.attribute('throttle', sm.id, { type: 'Real', value: 0 });
    f.attribute('power', sm.id, { type: 'Real' }); // DERIVED (no literal) so solve determines it
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'rev', effect: 'throttle = 5' });
    // Parametric law: power is DERIVED from the machine-driven throttle.
    m.create('ConstraintUsage', {
      ownerId: sm.id,
      declaredName: 'law',
      attrs: { expression: 'power = throttle * 10' },
    });
    return { m, smId: sm.id };
  }

  it('solves derived parametric values each step with the machine values fixed', () => {
    const { m, smId } = engineSM();
    const s = new SimulationSession(m, smId, { solve: true });
    // Initial: throttle 0 → power 0.
    expect(s.trace[0].solved.power).toBe(0);
    // After the effect sets throttle=5, the solve derives power = 50.
    const after = s.inject('rev');
    expect(after.solved.throttle).toBe(5);
    expect(after.solved.power).toBe(50);
  });

  it('leaves `solved` empty when the solve option is off (default)', () => {
    const { m, smId } = engineSM();
    const s = new SimulationSession(m, smId);
    expect(s.trace[0].solved).toEqual({});
    expect(s.inject('rev').solved).toEqual({});
  });

  it('constraint status reflects the parametric-solved (derived) values', () => {
    const { m, smId } = engineSM();
    m.create('ConstraintUsage', {
      ownerId: smId,
      declaredName: 'limit',
      attrs: { expression: 'power <= 40' },
    });
    const s = new SimulationSession(m, smId, { solve: true });
    const limit0 = s.trace[0].constraints.find((c) => c.name === 'limit');
    expect(limit0?.status).toBe('satisfied'); // power 0 ≤ 40
    const after = s.inject('rev'); // throttle 5 → power 50 (derived) → exceeds limit
    expect(after.constraints.find((c) => c.name === 'limit')?.status).toBe('violated');
    expect(after.solvedOk).toBe(true);
  });

  it('solves derived values on the OWNER part when the machine is nested inside it', () => {
    // A state machine nested in a part, mutating and constrained through the
    // part's OWN attributes (owner-chain, not the machine's descendants).
    const m = new Model();
    const vehicle = m.create('PartUsage', { declaredName: 'vehicle' });
    m.create('AttributeUsage', { ownerId: vehicle.id, declaredName: 'mass', attrs: { value: 1500 } });
    m.create('AttributeUsage', { ownerId: vehicle.id, declaredName: 'half' }); // derived
    m.create('ConstraintUsage', {
      ownerId: vehicle.id,
      declaredName: 'law',
      attrs: { expression: 'half = mass / 2' },
    });
    const sm = m.create('StateUsage', { ownerId: vehicle.id, declaredName: 'ctl' });
    const idle = m.create('StateUsage', { ownerId: sm.id, declaredName: 'idle' });
    const moving = m.create('StateUsage', { ownerId: sm.id, declaredName: 'moving' });
    m.create('TransitionUsage', {
      ownerId: sm.id,
      source: [idle.id],
      target: [moving.id],
      attrs: { trigger: 'go', effect: 'mass = mass - 100' },
    });
    const s = new SimulationSession(m, sm.id, { solve: true });
    const after = s.inject('go'); // mass 1500 → 1400 ⇒ half 700
    expect(after.values.mass).toBe(1400);
    expect(after.solved.mass).toBe(1400); // the LIVE owner value, not the stale literal
    expect(after.solved.half).toBe(700);
  });
});

describe('SimulationSession — timed transitions', () => {
  it('an after(n) transition fires once the clock passes its dwell', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Timed');
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'after(3)' });
    const s = new SimulationSession(m, sm.id);
    expect(s.trace[0].activeStates).toEqual([s0.id]);
    const early = s.advance(2); // clock 2 < 3 → not yet
    expect(early.clock).toBe(2);
    expect(early.activeStates).toEqual([s0.id]);
    const late = s.advance(5); // clock 7 ≥ 3 → fired
    expect(late.clock).toBe(7);
    expect(late.activeStates).toEqual([s1.id]);
    // after(n) is a timed trigger, NOT part of the injectable alphabet.
    expect(discoverTriggers(m, sm.id)).toEqual([]);
  });

  it('fires exactly AT the dwell boundary (clock === n), not one tick late', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Timed');
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'after(3)' });
    const s = new SimulationSession(m, sm.id);
    const atDwell = s.advance(3); // clock exactly 3 → must fire (>= boundary)
    expect(atDwell.clock).toBe(3);
    expect(atDwell.activeStates).toEqual([s1.id]);
  });
});

describe('SimulationSession — completeness', () => {
  it('reports complete when a final state is reached on the flat/event-driven path', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Job');
    const running = f.state('running', sm.id);
    const done = f.state('done', sm.id);
    m.setAttrs(done.id, { kind: 'final' });
    f.transition(running.id, done.id, { ownerId: sm.id, trigger: 'finish' });
    const s = new SimulationSession(m, sm.id);
    expect(s.trace[0].complete).toBe(false); // at 'running'
    const end = s.inject('finish');
    expect(end.activeStates).toEqual([done.id]);
    expect(end.complete).toBe(true); // derived from the final active state
  });
});

describe('SimulationSession — a step out of a composite exits it (docs/06 §8.10)', () => {
  /** `Idle -go-> C0`, `C0 { a -x-> b; b -back-> Idle }`, and `C0 -abort-> Fault` on the composite itself. */
  function leaving(): { model: Model; smId: string; ids: Record<string, string> } {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Leaving');
    const idle = f.state('Idle', sm.id);
    const c0 = f.state('C0', sm.id);
    const a = f.state('a', c0.id);
    const b = f.state('b', c0.id);
    const fault = f.state('Fault', sm.id);
    f.transition(idle.id, c0.id, { ownerId: sm.id, trigger: 'go' });
    f.transition(a.id, b.id, { ownerId: c0.id, trigger: 'x' });
    f.transition(b.id, idle.id, { ownerId: c0.id, trigger: 'back' });
    f.transition(c0.id, fault.id, { ownerId: sm.id, trigger: 'abort' });
    return { model: m, smId: sm.id, ids: { idle: idle.id, fault: fault.id } };
  }

  it('fires the composite’s own transition while the run is inside it', () => {
    const { model, smId, ids } = leaving();
    const s = new SimulationSession(model, smId);
    s.inject('go');
    const abort = s.inject('abort');
    expect(abort.fired.map((x) => x.trigger)).toEqual(['abort']);
    expect(abort.activeStates).toEqual([ids.fault]);
  });

  it('fires it no more once `back` has left the composite from a substate', () => {
    // The step used to exit `b` alone and enter `Idle` under `C0`, so `C0`
    // stayed active and `abort` took the run from `Idle` to `Fault`.
    const { model, smId, ids } = leaving();
    const s = new SimulationSession(model, smId);
    s.inject('go');
    s.inject('x');
    expect(s.inject('back').activeStates).toEqual([ids.idle]);
    const abort = s.inject('abort');
    expect(abort.fired).toEqual([]);
    expect(abort.activeStates).toEqual([ids.idle]);
    // The batched run reads the same.
    const t = simulateStateMachine(model, smId, ['go', 'x', 'back', 'abort'].map((event) => ({ event })));
    expect(t.samples[t.samples.length - 1].activeStates).toEqual([ids.idle]);
  });
});

describe('SimulationSession — a step into the machine itself is not taken (docs/06 §8.12)', () => {
  /** `a -go-> b`, `b -back-> Root` (the machine itself), `b -on-> a`. */
  function rooted(): { model: Model; smId: string; ids: Record<string, string> } {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Root');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'go' });
    const back = f.transition(b.id, sm.id, { ownerId: sm.id, trigger: 'back' });
    f.transition(b.id, a.id, { ownerId: sm.id, trigger: 'on' });
    return { model: m, smId: sm.id, ids: { a: a.id, b: b.id, back: back.id } };
  }

  it('stops at the step, says which, and takes no step after it', () => {
    // The run used to take `back` into the machine itself and stand there, a
    // state of no region with nothing more offered.
    const { model, smId, ids } = rooted();
    const s = new SimulationSession(model, smId);
    const moving = s.inject('go');
    expect(moving.refused).toBeUndefined();
    expect(simulationAtRest(moving)).toBe(false);
    const stopped = s.inject('back');
    const sentence = refusedStepSentence(model, smId, ids.back);
    expect(stopped.refused).toEqual({ id: ids.back, from: ids.b, to: smId, trigger: 'back', sentence, stopsRun: true });
    expect(stopped.fired).toEqual([]);
    expect(stopped.activeStates).toEqual([ids.b]);
    expect(stopped.complete).toBe(false);
    // No clock advance moves a stopped run on, so Play stops there.
    expect(simulationAtRest(stopped)).toBe(true);
    // `on` would take the run back to `a`; a stopped run takes nothing.
    const after = s.inject('on');
    expect(after.fired).toEqual([]);
    expect(after.activeStates).toEqual([ids.b]);
    expect(after.refused?.id).toBe(ids.back);
    // The sentence the surfaces print names the step and where it leads.
    expect(sentence).toContain('into `Root`, the machine itself');
    expect(sentence).toContain('the run stops where it stands without taking it');
    // The sample is a snapshot, and so are its words: an edit in place after
    // it (which does not stop the session) does not reword a stop that happened.
    // Composed at render time, the line read the deleted edge's raw id.
    model.remove(ids.back);
    expect(refusedStepSentence(model, smId, ids.back)).not.toBe(sentence);
    expect(stopped.refused?.sentence).toBe(sentence);
  });

  it('on a parallel machine the step stops its own region, and the sentence says the others run on', () => {
    // Region R1 `a -go-> Par` (the machine itself); region R2 `x -go-> y -go2-> z`.
    // Each region is driven on its own over the whole script, so R2 runs on.
    const m = new Model();
    const f = new ModelFactory(m);
    const par = f.stateDef('Par');
    m.setAttrs(par.id, { parallel: true });
    const r1 = f.state('R1', par.id);
    const a = f.state('a', r1.id);
    const r2 = f.state('R2', par.id);
    const x = f.state('x', r2.id);
    const y = f.state('y', r2.id);
    const z = f.state('z', r2.id);
    const into = f.transition(a.id, par.id, { ownerId: r1.id, trigger: 'go' });
    f.transition(x.id, y.id, { ownerId: r2.id, trigger: 'go' });
    f.transition(y.id, z.id, { ownerId: r2.id, trigger: 'go2' });

    const run = runStateMachine(m, par.id, ['go', 'go2']);
    expect(run.refused).toEqual({ transitionId: into.id, from: a.id, to: par.id, trigger: 'go' });
    expect(run.fired.map((q) => [q.from, q.to])).toEqual([
      [x.id, y.id],
      [y.id, z.id],
    ]);
    expect(run.activeStates).toEqual([a.id, z.id]);
    expect(run.complete).toBe(false);

    const sentence = refusedStepSentence(m, par.id, into.id);
    expect(sentence).toContain('its region stops where it stands without taking it');
    expect(sentence).toContain('other regions, each run on its own over the whole script, run on');
    expect(sentence).not.toContain('the run stops');
    const s = new SimulationSession(m, par.id);
    expect(s.inject('go').refused).toEqual({ id: into.id, from: a.id, to: par.id, trigger: 'go', sentence, stopsRun: false });
    // The Stopped line and the Fired line of one sample agree: R2 fired on.
    const second = s.inject('go2');
    expect(second.refused?.stopsRun).toBe(false);
    expect(second.fired.map((q) => [q.from, q.to])).toEqual([[y.id, z.id]]);
    // Only a region stopped, so the run is not at rest.
    expect(simulationAtRest(second)).toBe(false);
  });

  it('a composite run on its own that steps into itself is worded as one, not as the machine itself', () => {
    // `executionReport` runs every element that owns a transition, the
    // composite `C` among them. Inside `M`, `back` (`c2 -re-> C`, written in
    // `C`) exits `C` and enters it again (docs/06 §8.10); run alone, `C` has
    // nothing above it to exit to.
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('M');
    const a = f.state('a', sm.id);
    const c = f.state('C', sm.id);
    const c1 = f.state('c1', c.id);
    const c2 = f.state('c2', c.id);
    f.transition(c1.id, c2.id, { ownerId: c.id, trigger: 'go' });
    const back = f.transition(c2.id, c.id, { ownerId: c.id, trigger: 're' });
    f.transition(a.id, c.id, { ownerId: sm.id, trigger: 'enter' });
    const runs = executionReport(m).stateMachines;
    expect(runs.find((r) => r.stateMachine.id === sm.id)).not.toHaveProperty('refused');
    const alone = runs.find((r) => r.stateMachine.id === c.id)!;
    expect(alone.refused?.transitionId).toBe(back.id);
    expect(alone.finalState).toBe(c2.id);
    expect(alone.refused?.sentence).toContain('into `M::C`, a composite state of `M` run on its own');
    expect(alone.refused?.sentence).toContain('In `M` a step to an ancestor exits it and enters it again');
    expect(alone.refused?.sentence).toContain('the run stops where it stands without taking it');
    expect(alone.refused?.sentence).not.toContain('the machine itself');
  });

  it('a composite no machine holds is the machine itself, whatever state or lone definition is written above it', () => {
    // The whole-branch review's H1 and H2: the state above `C` owns no
    // transition, so `C` is the machine (`stateMachinesIn`) and no machine
    // exits and re-enters it. The sentence named `S` (and `D`) as one that
    // would, where `reach` refuses the same step as one into the machine
    // itself.
    for (const lone of [false, true]) {
      const m = new Model();
      const f = new ModelFactory(m);
      const above = lone ? f.stateDef('D') : m.create('StateUsage', { declaredName: 'S', ownerId: null });
      const c = f.state('C', above.id);
      const a = f.state('a', c.id);
      const b = f.state('b', c.id);
      f.transition(a.id, b.id, { ownerId: c.id, trigger: 'go' });
      const back = f.transition(b.id, c.id, { ownerId: c.id, trigger: 'up' });
      expect(stateMachinesIn(m).map((x) => x.id)).toEqual([c.id]);
      const name = lone ? 'D::C' : 'S::C';
      const walked = reachReport(m).machines[0];
      expect(walked.unsupported.map((u) => u.construct)).toEqual(['step-outside-states']);
      expect(walked.unsupported[0].detail).toContain(`into \`${name}\`, the machine itself`);
      const run = executionReport(m).stateMachines.find((r) => r.stateMachine.id === c.id)!;
      expect(run.refused?.transitionId).toBe(back.id);
      expect(run.refused?.sentence).toContain(`into \`${name}\`, the machine itself`);
      expect(run.refused?.sentence).not.toContain('a composite state of');
      const s = new SimulationSession(m, c.id);
      s.inject('go');
      expect(s.inject('up').refused?.sentence).toBe(run.refused?.sentence);
    }
  });

  it('the batched run and the Simulate report read the same', () => {
    const { model, smId, ids } = rooted();
    const t = simulateStateMachine(model, smId, ['go', 'back', 'on'].map((event) => ({ event })));
    expect(t.samples.map((x) => x.refused?.id ?? null)).toEqual([null, null, ids.back, ids.back]);
    expect(t.complete).toBe(false);
    const run = executionReport(model).stateMachines.find((x) => x.stateMachine.id === smId)!;
    expect(run.refused).toEqual({
      transitionId: ids.back,
      from: ids.b,
      to: smId,
      trigger: 'back',
      sentence: refusedStepSentence(model, smId, ids.back),
    });
    expect(run.complete).toBe(false);
    expect(run.finalState).toBe(ids.b);
    // A machine that takes every step it comes to carries no such field.
    const { model: plain, smId: plainId } = vehicleSM();
    expect(executionReport(plain).stateMachines[0]).not.toHaveProperty('refused');
    expect(new SimulationSession(plain, plainId).inject('start')).not.toHaveProperty('refused');
  });
});

describe('simulateStateMachine — batched runs', () => {
  it('produces one sample per step plus the initial, deterministically', () => {
    const { model, smId, ids } = vehicleSM();
    const script = [{ event: 'start' }, { event: 'pause' }, { event: 'resume' }, { event: 'stop' }];
    const t1 = simulateStateMachine(model, smId, script);
    expect(t1.samples.length).toBe(5); // initial + 4
    expect(t1.samples[t1.samples.length - 1].activeStates).toEqual([ids.off]);
    expect(t1.behaviorName).toBe('VehicleStates');
    // Deterministic: a fresh run yields an identical timeline.
    const t2 = simulateStateMachine(model, smId, script);
    expect(t2.samples.map((s) => s.activeStates)).toEqual(t1.samples.map((s) => s.activeStates));
    expect(t1.truncated).toBe(false);
  });

  it('caps the trace at maxSamples and flags truncation', () => {
    const { model, smId } = vehicleSM();
    const script = Array.from({ length: 10 }, () => ({ advance: 1 }));
    const t = simulateStateMachine(model, smId, script, { maxSamples: 3 });
    expect(t.truncated).toBe(true);
    expect(t.samples.length).toBeLessThanOrEqual(3);
  });
});

describe('simulationReport (analytics)', () => {
  it('auto-simulates the first state machine over its trigger alphabet', () => {
    const { model } = vehicleSM();
    const rep = simulationReport(model);
    expect(rep.ran).toBe(true);
    expect(rep.trace?.behaviorName).toBe('VehicleStates');
    expect(rep.trace!.samples.length).toBeGreaterThan(1);
    expect([...rep.trace!.triggers].sort()).toEqual(['pause', 'resume', 'start', 'stop']);
  });

  it('reports nothing to simulate when there is no state machine', () => {
    expect(simulationReport(new Model()).ran).toBe(false);
  });
});

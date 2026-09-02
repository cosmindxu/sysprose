import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  SimulationSession,
  simulateStateMachine,
  isSimulatable,
  discoverTriggers,
} from '../../src/semantics/index';
import { simulationReport } from '../../src/api/analytics';

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

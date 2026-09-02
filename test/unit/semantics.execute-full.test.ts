import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { runActionFlow, runStateMachine, executeModel } from '../../src/semantics/index';

/* ───────────────────────── value-store: assignment ───────────────────── */

describe('runActionFlow — assignment updates the value store', () => {
  it('evaluates the assignment expression and writes the store', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const act = f.actionDef('Calc');
    const start = m.create('InitialNode', { ownerId: act.id });
    const assign = m.create('AssignmentActionUsage', {
      ownerId: act.id,
      declaredName: 'setX',
      attrs: { target: 'x', value: '10 + 5' },
    });
    const done = m.create('DoneNode', { ownerId: act.id });
    f.succession(start.id, assign.id, act.id);
    f.succession(assign.id, done.id, act.id);

    const trace = runActionFlow(m, act.id);
    expect(trace.valueStore.get('x')).toBe(15);
    expect(trace.complete).toBe(true);
    const assignStep = trace.steps.find((s) => s.id === assign.id)!;
    expect(assignStep.note).toBe('x = 15');
  });
});

/* ───────────────────────────── while loop ────────────────────────────── */

describe('runActionFlow — while loop iterates and updates a counter', () => {
  it('runs the body N times until the guard fails', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const act = f.actionDef('Count');
    f.attribute('count', act.id, { type: 'Integer', value: 0 });
    const start = m.create('InitialNode', { ownerId: act.id });
    const loop = m.create('WhileLoopActionUsage', {
      ownerId: act.id,
      declaredName: 'w',
      attrs: { guard: 'count < 5', body: 'count = count + 1' },
    });
    const done = m.create('DoneNode', { ownerId: act.id });
    f.succession(start.id, loop.id, act.id);
    f.succession(loop.id, done.id, act.id);

    const trace = runActionFlow(m, act.id);
    expect(trace.valueStore.get('count')).toBe(5);
    expect(trace.iterations).toBe(5);
    expect(trace.complete).toBe(true);
    const loopStep = trace.steps.find((s) => s.id === loop.id)!;
    expect(loopStep.note).toBe('loop ×5');
  });

  it('respects the step budget on a runaway loop', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const act = f.actionDef('Spin');
    f.attribute('n', act.id, { type: 'Integer', value: 0 });
    const start = m.create('InitialNode', { ownerId: act.id });
    // Guard never becomes false, but the body still increments n.
    const loop = m.create('WhileLoopActionUsage', {
      ownerId: act.id,
      attrs: { guard: 'true', body: 'n = n + 1' },
    });
    f.succession(start.id, loop.id, act.id);
    const trace = runActionFlow(m, act.id, { maxSteps: 12 });
    expect(trace.iterations).toBeGreaterThan(0);
    expect(trace.iterations).toBeLessThanOrEqual(12);
  });
});

/* ────────────────────────────── for loop ─────────────────────────────── */

describe('runActionFlow — for loop accumulates over a range', () => {
  it('iterates the loop variable and runs a child assignment body', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const act = f.actionDef('Sum');
    f.attribute('sum', act.id, { type: 'Integer', value: 0 });
    const start = m.create('InitialNode', { ownerId: act.id });
    const loop = m.create('ForLoopActionUsage', {
      ownerId: act.id,
      declaredName: 'fl',
      attrs: { variable: 'i', from: '1', to: '3' },
    });
    // Loop body: sum = sum + i
    m.create('AssignmentActionUsage', {
      ownerId: loop.id,
      attrs: { target: 'sum', value: 'sum + i' },
    });
    const done = m.create('DoneNode', { ownerId: act.id });
    f.succession(start.id, loop.id, act.id);
    f.succession(loop.id, done.id, act.id);

    const trace = runActionFlow(m, act.id);
    expect(trace.iterations).toBe(3);
    expect(trace.valueStore.get('sum')).toBe(6); // 1 + 2 + 3
    expect(trace.valueStore.get('i')).toBe(3);
  });
});

/* ─────────────────────── decision against the store ──────────────────── */

describe('runActionFlow — decision picks by store value', () => {
  it('follows the branch whose guard holds after an assignment', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const act = f.actionDef('Route');
    const start = m.create('InitialNode', { ownerId: act.id });
    const assign = m.create('AssignmentActionUsage', {
      ownerId: act.id,
      attrs: { target: 'mode', value: '2' },
    });
    const decide = m.create('DecisionNode', { ownerId: act.id, declaredName: 'd' });
    const a = f.action('branchA', act.id);
    const b = f.action('branchB', act.id);
    f.succession(start.id, assign.id, act.id);
    f.succession(assign.id, decide.id, act.id);
    m.create('Succession', { ownerId: act.id, source: [decide.id], target: [a.id], attrs: { guard: 'mode == 1' } });
    m.create('Succession', { ownerId: act.id, source: [decide.id], target: [b.id], attrs: { guard: 'mode == 2' } });

    const trace = runActionFlow(m, act.id);
    const visited = trace.steps.map((s) => s.id);
    expect(trace.valueStore.get('mode')).toBe(2);
    expect(visited).toContain(b.id);
    expect(visited).not.toContain(a.id);
  });
});

/* ─────────────────────────── fork/join parallel ──────────────────────── */

describe('runActionFlow — fork/join parallelism with a store', () => {
  it('runs both branches, tags the parallel group, and merges store writes', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const act = f.actionDef('Parallel');
    const start = m.create('InitialNode', { ownerId: act.id });
    const fork = m.create('ForkNode', { ownerId: act.id, declaredName: 'fk' });
    const bAssign = m.create('AssignmentActionUsage', { ownerId: act.id, attrs: { target: 'p', value: '1' } });
    const cAssign = m.create('AssignmentActionUsage', { ownerId: act.id, attrs: { target: 'q', value: '2' } });
    const join = m.create('JoinNode', { ownerId: act.id, declaredName: 'jn' });
    const done = m.create('DoneNode', { ownerId: act.id });
    f.succession(start.id, fork.id, act.id);
    f.succession(fork.id, bAssign.id, act.id);
    f.succession(fork.id, cAssign.id, act.id);
    f.succession(bAssign.id, join.id, act.id);
    f.succession(cAssign.id, join.id, act.id);
    f.succession(join.id, done.id, act.id);

    const trace = runActionFlow(m, act.id);
    expect(trace.valueStore.get('p')).toBe(1);
    expect(trace.valueStore.get('q')).toBe(2);
    const bStep = trace.steps.find((s) => s.id === bAssign.id)!;
    const cStep = trace.steps.find((s) => s.id === cAssign.id)!;
    expect(bStep.parallelGroup).toBe(fork.id);
    expect(cStep.parallelGroup).toBe(fork.id);
    // The join executes only after both branches arrive.
    const order = trace.steps.map((s) => s.id);
    expect(order.indexOf(join.id)).toBeGreaterThan(order.indexOf(bStep.id));
    expect(order.indexOf(join.id)).toBeGreaterThan(order.indexOf(cStep.id));
    expect(trace.complete).toBe(true);
  });
});

/* ─────────────── accept / send actions are recorded ──────────────────── */

describe('runActionFlow — accept and send actions', () => {
  it('records accept and send steps with notes', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const act = f.actionDef('Comms');
    const start = m.create('InitialNode', { ownerId: act.id });
    const accept = m.create('AcceptActionUsage', { ownerId: act.id, attrs: { payload: 'temperature' } });
    const send = m.create('SendActionUsage', { ownerId: act.id, attrs: { payload: 'alarm' } });
    const done = m.create('DoneNode', { ownerId: act.id });
    f.succession(start.id, accept.id, act.id);
    f.succession(accept.id, send.id, act.id);
    f.succession(send.id, done.id, act.id);

    const trace = runActionFlow(m, act.id);
    expect(trace.steps.find((s) => s.id === accept.id)!.note).toBe('accept temperature');
    expect(trace.steps.find((s) => s.id === send.id)!.note).toBe('send alarm');
  });
});

/* ─────────────── state machine: entry/exit + effect store ────────────── */

describe('runStateMachine — entry/exit behaviors and transition effects', () => {
  it('records entry/exit behaviors and applies the transition effect to the store', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Machine');
    f.attribute('power', sm.id, { type: 'Integer', value: 0 });
    const off = f.state('off', sm.id);
    const on = f.state('on', sm.id);
    m.create('ActionUsage', { ownerId: off.id, declaredName: 'shutdown', attrs: { stateSubaction: 'exit' } });
    m.create('ActionUsage', { ownerId: on.id, declaredName: 'turnOn', attrs: { stateSubaction: 'entry' } });
    f.transition(off.id, on.id, { ownerId: sm.id, trigger: 'go', effect: 'power = 1' });

    const res = runStateMachine(m, sm.id, ['go']);
    expect(res.visited).toEqual([off.id, on.id]);
    expect(res.finalState).toBe(on.id);
    expect(res.valueStore.get('power')).toBe(1);
    expect(res.performed.some((p) => p.name === 'shutdown' && p.phase === 'exit')).toBe(true);
    expect(res.performed.some((p) => p.name === 'turnOn' && p.phase === 'entry')).toBe(true);
    expect(res.activeStates).toEqual([on.id]);
  });

  it('fires a completion (trigger-less) transition automatically', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Auto');
    const a = f.state('a', sm.id);
    const b = f.state('b', sm.id);
    const c = f.state('c', sm.id);
    // a --start--> b, then b --(completion)--> c automatically.
    f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'start' });
    f.transition(b.id, c.id, { ownerId: sm.id }); // no trigger ⇒ completion

    const res = runStateMachine(m, sm.id, ['start']);
    expect(res.finalState).toBe(c.id);
    expect(res.fired.length).toBe(2);
    expect(res.fired[1].trigger).toBe('');
  });
});

/* ─────────────────────── state machine: parallel regions ─────────────── */

describe('runStateMachine — parallel regions run concurrently', () => {
  it('advances every region on a shared trigger', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const par = m.create('StateDefinition', { declaredName: 'Par', attrs: { parallel: true } });
    // Region 1
    const r1 = f.state('r1', par.id);
    const a1 = f.state('a1', r1.id);
    const a2 = f.state('a2', r1.id);
    f.transition(a1.id, a2.id, { ownerId: r1.id, trigger: 't' });
    // Region 2
    const r2 = f.state('r2', par.id);
    const b1 = f.state('b1', r2.id);
    const b2 = f.state('b2', r2.id);
    f.transition(b1.id, b2.id, { ownerId: r2.id, trigger: 't' });

    const res = runStateMachine(m, par.id, ['t']);
    expect(res.activeStates.length).toBe(2);
    expect(new Set(res.activeStates)).toEqual(new Set([a2.id, b2.id]));
    expect(res.fired.length).toBe(2);
    expect(res.visited).toContain(a1.id);
    expect(res.visited).toContain(b2.id);
  });
});

/* ─────────────────────────── whole-model execution ───────────────────── */

describe('executeModel — consolidated values, traces and constraints', () => {
  it('propagates connector values, runs behaviors and checks constraints', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('System');
    const a = f.attribute('a', p.id, { type: 'Real' });
    const b = f.attribute('b', p.id, { type: 'Real', value: 12 });
    m.create('BindingConnectorAsUsage', { ownerId: p.id, source: [a.id], target: [b.id] });
    m.create('ConstraintUsage', { ownerId: p.id, attrs: { expression: 'b > 5' } });

    // A top-level action with a loop that should be traced.
    const act = f.actionDef('Init');
    f.attribute('k', act.id, { type: 'Integer', value: 0 });
    const start = m.create('InitialNode', { ownerId: act.id });
    const loop = m.create('WhileLoopActionUsage', {
      ownerId: act.id,
      attrs: { guard: 'k < 2', body: 'k = k + 1' },
    });
    f.succession(start.id, loop.id, act.id);

    const exec = executeModel(m);
    // Binding value propagated onto a.
    expect(exec.values.get(a.id)).toBe(12);
    // The action behavior was traced and its loop iterated.
    const trace = exec.traces.find((t) => t.behaviorId === act.id);
    expect(trace).toBeDefined();
    expect(trace!.kind).toBe('action');
    expect(trace!.action!.iterations).toBe(2);
    // The constraint was evaluated as satisfied.
    expect(exec.constraints.some((c) => c.result === 'satisfied')).toBe(true);
  });
});

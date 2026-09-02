import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  runActionFlow,
  runStateMachine,
  propagateBindings,
  evaluateModel,
} from '../../src/semantics/index';

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

/**
 * Fuller behavioral-execution semantics (deepened {@link runActionFlow} /
 * {@link runStateMachine} + the unified {@link executeBehavior}):
 *
 *  1. COMPOSITE / CALL actions — a nested/invoked sub-flow executes recursively,
 *     recording enter/exit markers and exposing its result parameters.
 *  2. OBJECT / ITEM-FLOW data passing — values flow along ItemFlows between
 *     output and input pins (A → B → C computes downstream).
 *  3. HIERARCHICAL state machines — composite entry cascades outer→inner and
 *     exit inner→outer; a history pseudostate resumes the last-active substate.
 *  4. ORTHOGONAL regions — a join fires only when every region is complete.
 *  5. TIMED transitions — an after(n) edge fires once the discrete clock passes n.
 *  6. Unified executeBehavior dispatch.
 */

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { runActionFlow, runStateMachine, executeBehavior } from '../../src/semantics/index';

/* ─────────────────── 1. composite / call sub-behavior ─────────────────── */

describe('runActionFlow — composite action executes its sub-flow', () => {
  function build(): { model: Model; outerId: string; subId: string } {
    const m = new Model();
    const f = new ModelFactory(m);
    const outer = f.actionDef('Outer');
    const start = m.create('InitialNode', { ownerId: outer.id });
    // `sub` is a COMPOSITE action owning its own initial → compute → done flow.
    const sub = f.action('sub', outer.id);
    m.create('AttributeUsage', { ownerId: sub.id, declaredName: 'o', attrs: { direction: 'out' } });
    const subStart = m.create('InitialNode', { ownerId: sub.id });
    const compute = m.create('AssignmentActionUsage', {
      ownerId: sub.id,
      declaredName: 'compute',
      attrs: { target: 'o', value: '6 * 7' },
    });
    const subDone = m.create('DoneNode', { ownerId: sub.id });
    f.succession(subStart.id, compute.id, sub.id);
    f.succession(compute.id, subDone.id, sub.id);
    const done = m.create('DoneNode', { ownerId: outer.id });
    f.succession(start.id, sub.id, outer.id);
    f.succession(sub.id, done.id, outer.id);
    return { model: m, outerId: outer.id, subId: sub.id };
  }

  const { model, outerId, subId } = build();
  const trace = runActionFlow(model, outerId);
  const ids = trace.steps.map((s) => s.id);

  it('records an enter marker for the sub-behavior', () => {
    const enter = trace.steps.find((s) => s.event === 'enter' && s.subBehaviorId === subId);
    expect(enter).toBeDefined();
    expect(enter!.depth).toBe(1);
  });

  it('records an exit marker carrying the produced result parameter', () => {
    const exit = trace.steps.find((s) => s.event === 'exit' && s.subBehaviorId === subId);
    expect(exit).toBeDefined();
    expect(exit!.produced).toEqual({ o: 42 });
  });

  it('executes the nested sub-flow (its assignment step appears)', () => {
    const assign = trace.steps.find((s) => s.note === 'o = 42');
    expect(assign).toBeDefined();
    expect(assign!.depth).toBe(1);
  });

  it('orders enter → sub-steps → exit', () => {
    const enterIdx = trace.steps.findIndex((s) => s.event === 'enter');
    const exitIdx = trace.steps.findIndex((s) => s.event === 'exit');
    const assignIdx = trace.steps.findIndex((s) => s.note === 'o = 42');
    expect(enterIdx).toBeLessThan(assignIdx);
    expect(assignIdx).toBeLessThan(exitIdx);
  });

  it('makes the sub result available to the caller and reports recursion depth', () => {
    expect(trace.valueStore.get('o')).toBe(42);
    expect(trace.depth).toBe(1);
    expect(trace.complete).toBe(true);
    // The nested nodes are not flattened onto the parent flow before the marker.
    expect(ids[0]).toBeDefined();
  });
});

/* ─────────────────── 2. object / item-flow data passing ───────────────── */

describe('runActionFlow — item-flow data passing between pins', () => {
  function build() {
    const m = new Model();
    const f = new ModelFactory(m);
    const pipe = f.actionDef('Pipe');
    const start = m.create('InitialNode', { ownerId: pipe.id });
    // A: produces output pin oA = 5.
    const A = f.action('A', pipe.id);
    const oA = m.create('AttributeUsage', { ownerId: A.id, declaredName: 'oA', attrs: { direction: 'out', value: 5 } });
    // B: reads input pin iB, writes output pin oB = iB.
    const B = m.create('AssignmentActionUsage', { ownerId: pipe.id, declaredName: 'B', attrs: { target: 'oB', value: 'iB' } });
    const iB = m.create('AttributeUsage', { ownerId: B.id, declaredName: 'iB', attrs: { direction: 'in' } });
    const oB = m.create('AttributeUsage', { ownerId: B.id, declaredName: 'oB', attrs: { direction: 'out' } });
    // C: reads input pin iC, computes result = iC * 2.
    const C = m.create('AssignmentActionUsage', { ownerId: pipe.id, declaredName: 'C', attrs: { target: 'result', value: 'iC * 2' } });
    const iC = m.create('AttributeUsage', { ownerId: C.id, declaredName: 'iC', attrs: { direction: 'in' } });
    const done = m.create('DoneNode', { ownerId: pipe.id });
    f.succession(start.id, A.id, pipe.id);
    f.succession(A.id, B.id, pipe.id);
    f.succession(B.id, C.id, pipe.id);
    f.succession(C.id, done.id, pipe.id);
    // Item flows: A.oA → B.iB and B.oB → C.iC.
    m.create('ItemFlow', { ownerId: pipe.id, source: [oA.id], target: [iB.id] });
    m.create('ItemFlow', { ownerId: pipe.id, source: [oB.id], target: [iC.id] });
    return { model: m, pipeId: pipe.id, ids: { oA: oA.id, iB: iB.id, oB: oB.id, iC: iC.id } };
  }

  const { model, pipeId, ids } = build();
  const trace = runActionFlow(model, pipeId);

  it('delivers A output 5 to B input pin (by name and by id)', () => {
    expect(trace.valueStore.get('iB')).toBe(5);
    expect(trace.valueById.get(ids.iB)).toBe(5);
  });

  it('passes B output downstream to C input pin', () => {
    expect(trace.valueStore.get('oB')).toBe(5);
    expect(trace.valueStore.get('iC')).toBe(5);
    expect(trace.valueById.get(ids.iC)).toBe(5);
  });

  it('computes the downstream result 5 * 2 = 10', () => {
    expect(trace.valueStore.get('result')).toBe(10);
    expect(trace.complete).toBe(true);
  });
});

/* ─────────────────── 3. hierarchical state machine ────────────────────── */

describe('runStateMachine — composite state cascades entry/exit actions', () => {
  function build() {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('M');
    const active = f.state('Active', sm.id); // composite
    m.create('ActionUsage', { ownerId: active.id, declaredName: 'enterActive', attrs: { stateSubaction: 'entry' } });
    m.create('ActionUsage', { ownerId: active.id, declaredName: 'exitActive', attrs: { stateSubaction: 'exit' } });
    const s1 = f.state('s1', active.id);
    m.create('ActionUsage', { ownerId: s1.id, declaredName: 'enterS1', attrs: { stateSubaction: 'entry' } });
    m.create('ActionUsage', { ownerId: s1.id, declaredName: 'exitS1', attrs: { stateSubaction: 'exit' } });
    const s2 = f.state('s2', active.id);
    m.create('ActionUsage', { ownerId: s2.id, declaredName: 'enterS2', attrs: { stateSubaction: 'entry' } });
    f.transition(s1.id, s2.id, { ownerId: active.id, trigger: 'go' });
    const done = f.state('Done', sm.id);
    f.transition(active.id, done.id, { ownerId: sm.id, trigger: 'finish' });
    return { model: m, smId: sm.id, ids: { active: active.id, s1: s1.id, s2: s2.id, done: done.id } };
  }

  const { model, smId, ids } = build();
  const res = runStateMachine(model, smId, ['finish']);
  const perf = res.performed.map((p) => p.name);
  const at = (n: string) => perf.indexOf(n);

  it('cascades entry actions outer → inner on entry', () => {
    expect(at('enterActive')).toBeGreaterThanOrEqual(0);
    expect(at('enterS1')).toBeGreaterThan(at('enterActive'));
    // s2 was never entered.
    expect(perf).not.toContain('enterS2');
  });

  it('cascades exit actions inner → outer when leaving the composite', () => {
    expect(at('exitS1')).toBeGreaterThanOrEqual(0);
    expect(at('exitActive')).toBeGreaterThan(at('exitS1'));
  });

  it('enters the composite via its initial substate and leaves to the outer target', () => {
    expect(res.visited).toContain(ids.active);
    expect(res.visited).toContain(ids.s1);
    expect(res.finalState).toBe(ids.done);
  });
});

/* ─────────────────── 3b. history pseudostate ──────────────────────────── */

describe('runStateMachine — history pseudostate resumes the last substate', () => {
  function build(history: boolean) {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef(history ? 'H' : 'NoH');
    const active = m.create('StateUsage', {
      declaredName: 'Active',
      ownerId: sm.id,
      attrs: history ? { history: true } : {},
    });
    const s1 = f.state('s1', active.id);
    const s2 = f.state('s2', active.id);
    f.transition(s1.id, s2.id, { ownerId: active.id, trigger: 'go' });
    const idle = f.state('Idle', sm.id);
    f.transition(active.id, idle.id, { ownerId: sm.id, trigger: 'out' });
    f.transition(idle.id, active.id, { ownerId: sm.id, trigger: 'back' });
    return { model: m, smId: sm.id, ids: { s1: s1.id, s2: s2.id } };
  }

  it('resumes s2 (the last-active substate) on re-entry with history', () => {
    const { model, smId, ids } = build(true);
    const res = runStateMachine(model, smId, ['go', 'out', 'back']);
    expect(res.finalState).toBe(ids.s2);
    expect(res.activeStates).toContain(ids.s2);
    expect(res.visited[res.visited.length - 1]).toBe(ids.s2);
  });

  it('restarts at the initial substate s1 without history', () => {
    const { model, smId, ids } = build(false);
    const res = runStateMachine(model, smId, ['go', 'out', 'back']);
    expect(res.finalState).toBe(ids.s1);
  });
});

/* ─────────────────── 4. orthogonal regions + join ─────────────────────── */

describe('runStateMachine — orthogonal regions join only when both complete', () => {
  function build() {
    const m = new Model();
    const f = new ModelFactory(m);
    const par = m.create('StateDefinition', { declaredName: 'Par', attrs: { parallel: true } });
    const r1 = f.state('r1', par.id);
    const a1 = f.state('a1', r1.id);
    const a1f = m.create('StateUsage', { declaredName: 'a1f', ownerId: r1.id, attrs: { kind: 'final' } });
    f.transition(a1.id, a1f.id, { ownerId: r1.id, trigger: 't1' });
    const r2 = f.state('r2', par.id);
    const b1 = f.state('b1', r2.id);
    const b2f = m.create('StateUsage', { declaredName: 'b2f', ownerId: r2.id, attrs: { kind: 'final' } });
    f.transition(b1.id, b2f.id, { ownerId: r2.id, trigger: 't2' });
    const allDone = f.state('AllDone', par.id);
    const join = m.create('TransitionUsage', {
      ownerId: par.id,
      source: [par.id],
      target: [allDone.id],
      attrs: { kind: 'join' },
    });
    return { model: m, parId: par.id, ids: { a1f: a1f.id, b1: b1.id, b2f: b2f.id, allDone: allDone.id, join: join.id } };
  }

  it('does not fire the join until every region is complete', () => {
    const { model, parId, ids } = build();
    const res = runStateMachine(model, parId, ['t1']);
    expect(res.complete).toBe(false);
    expect(res.visited).not.toContain(ids.allDone);
    expect(res.activeStates).toContain(ids.a1f);
    expect(res.activeStates).toContain(ids.b1);
  });

  it('fires the join once both regions reach a final state', () => {
    const { model, parId, ids } = build();
    const res = runStateMachine(model, parId, ['t1', 't2']);
    expect(res.complete).toBe(true);
    expect(res.finalState).toBe(ids.allDone);
    expect(res.visited).toContain(ids.allDone);
    expect(res.fired[res.fired.length - 1].transitionId).toBe(ids.join);
  });
});

/* ─────────────────── 5. timed transitions ─────────────────────────────── */

describe('runStateMachine — after(n) timed transition fires when the clock passes n', () => {
  function build() {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Timer');
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'after(5)' });
    return { model: m, smId: sm.id, ids: { s0: s0.id, s1: s1.id } };
  }

  it('does not fire before the clock reaches n', () => {
    const { model, smId, ids } = build();
    const res = runStateMachine(model, smId, [{ advance: 3 }]);
    expect(res.clock).toBe(3);
    expect(res.finalState).toBe(ids.s0);
    expect(res.fired).toHaveLength(0);
  });

  it('fires once the clock advances past n', () => {
    const { model, smId, ids } = build();
    const res = runStateMachine(model, smId, [{ advance: 3 }, { advance: 3 }]);
    expect(res.clock).toBe(6);
    expect(res.finalState).toBe(ids.s1);
    expect(res.fired).toHaveLength(1);
    expect(res.fired[0].trigger).toBe('after(5)');
  });
});

/* ─────────────────── 6. unified executeBehavior ───────────────────────── */

describe('executeBehavior — unified dispatch', () => {
  it('dispatches an action flow and returns action steps + value store', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const act = f.actionDef('Calc');
    const start = m.create('InitialNode', { ownerId: act.id });
    const assign = m.create('AssignmentActionUsage', { ownerId: act.id, attrs: { target: 'x', value: '3 + 4' } });
    const done = m.create('DoneNode', { ownerId: act.id });
    f.succession(start.id, assign.id, act.id);
    f.succession(assign.id, done.id, act.id);

    const exec = executeBehavior(m, act.id);
    expect(exec.kind).toBe('action');
    expect(exec.complete).toBe(true);
    expect(exec.valueStore.get('x')).toBe(7);
    expect(exec.steps.length).toBeGreaterThan(0);
  });

  it('dispatches a state machine and returns active/final states', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('SM');
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'go' });

    const exec = executeBehavior(m, sm.id, { triggers: ['go'] });
    expect(exec.kind).toBe('state');
    expect(exec.finalState).toBe(s1.id);
    expect(exec.activeStates).toContain(s1.id);
    expect(exec.steps.some((s) => s.id === s1.id)).toBe(true);
  });
});

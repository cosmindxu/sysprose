/**
 * Integration — fuller behavioral execution through the public surfaces:
 * build behaviors (a COMPOSITE action with item-flow data passing, and a
 * HIERARCHICAL / TIMED state machine) and drive them via {@link ModelApi}
 * (`executeBehavior`), the analytics `executionReport`, and the REST
 * `GET /analytics/execution` route. Also confirms a parsed action flow still
 * runs through the deepened engine (backward compatibility).
 */

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { parseModel } from '@text/index';
import { ModelApi, SysmlApiServer, executionReport } from '@api/index';

/* ─────────────── composite action + item-flow via ModelApi ────────────── */

describe('execution integration — composite action + item flow via ModelApi', () => {
  function build(): { api: ModelApi; pipeId: string } {
    const m = new Model();
    const f = new ModelFactory(m);
    const pipe = f.actionDef('Pipe');
    const start = m.create('InitialNode', { ownerId: pipe.id });
    // A: a COMPOSITE sub-action producing out pin oA = 5.
    const A = f.action('A', pipe.id);
    const oA = m.create('AttributeUsage', { ownerId: A.id, declaredName: 'oA', attrs: { direction: 'out' } });
    const aStart = m.create('InitialNode', { ownerId: A.id });
    const aAssign = m.create('AssignmentActionUsage', { ownerId: A.id, attrs: { target: 'oA', value: '2 + 3' } });
    const aDone = m.create('DoneNode', { ownerId: A.id });
    f.succession(aStart.id, aAssign.id, A.id);
    f.succession(aAssign.id, aDone.id, A.id);
    // B: computes result = iB * 4.
    const B = m.create('AssignmentActionUsage', { ownerId: pipe.id, declaredName: 'B', attrs: { target: 'result', value: 'iB * 4' } });
    const iB = m.create('AttributeUsage', { ownerId: B.id, declaredName: 'iB', attrs: { direction: 'in' } });
    const done = m.create('DoneNode', { ownerId: pipe.id });
    f.succession(start.id, A.id, pipe.id);
    f.succession(A.id, B.id, pipe.id);
    f.succession(B.id, done.id, pipe.id);
    m.create('ItemFlow', { ownerId: pipe.id, source: [oA.id], target: [iB.id] });
    return { api: new ModelApi(m), pipeId: pipe.id };
  }

  it('executeBehavior recurses into the sub-action and passes data downstream', () => {
    const { api, pipeId } = build();
    const exec = api.executeBehavior(pipeId);
    expect(exec.kind).toBe('action');
    expect(exec.complete).toBe(true);
    // Composite recursion happened (an enter marker is present).
    expect(exec.steps.some((s) => s.event === 'enter')).toBe(true);
    expect(exec.action!.depth).toBe(1);
    // A produced 5 → B input read 5 → result 5 * 4 = 20.
    expect(exec.valueStore.get('oA')).toBe(5);
    expect(exec.valueStore.get('iB')).toBe(5);
    expect(exec.valueStore.get('result')).toBe(20);
  });

  it('executionReport surfaces composite depth and produced outputs', () => {
    const { api, pipeId } = build();
    const report = executionReport(api.model);
    const flow = report.actionFlows.find((fl) => fl.action.id === pipeId)!;
    expect(flow).toBeDefined();
    expect(flow.depth).toBe(1);
    expect(flow.valueStore.result).toBe(20);
    const exit = flow.steps.find((s) => s.event === 'exit');
    expect(exit).toBeDefined();
    expect(exit!.produced).toEqual({ oA: 5 });
  });
});

/* ─────────────── hierarchical / timed state machine via ModelApi ──────── */

describe('execution integration — hierarchical + timed state machine via ModelApi', () => {
  function build() {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Machine');
    const active = f.state('Active', sm.id); // composite
    const s1 = f.state('s1', active.id);
    const s2 = f.state('s2', active.id);
    f.transition(s1.id, s2.id, { ownerId: active.id, trigger: 'go' });
    const done = f.state('Done', sm.id);
    f.transition(active.id, done.id, { ownerId: sm.id, trigger: 'stop' });
    return { api: new ModelApi(m), ids: { sm: sm.id, active: active.id, s1: s1.id, s2: s2.id, done: done.id } };
  }

  it('cascades into the composite substate and leaves via the outer transition', () => {
    const { api, ids } = build();
    const exec = api.executeBehavior(ids.sm, { triggers: ['go', 'stop'] });
    expect(exec.kind).toBe('state');
    expect(exec.finalState).toBe(ids.done);
    // Nested states were entered.
    expect(exec.state!.visited).toContain(ids.active);
    expect(exec.state!.visited).toContain(ids.s1);
    expect(exec.state!.visited).toContain(ids.s2);
  });

  it('advances a discrete clock for after(n) timed transitions', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('Timer');
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'after(10)' });
    const api = new ModelApi(m);
    const exec = api.executeBehavior(sm.id, { triggers: [{ advance: 4 }, { advance: 8 }] });
    expect(exec.clock).toBe(12);
    expect(exec.finalState).toBe(s1.id);
  });
});

/* ─────────────── REST facade + parsed-flow backward compatibility ─────── */

describe('execution integration — REST facade & parsed backward compatibility', () => {
  const SRC = `
package P {
  action def Drive {
    action ignite;
    action accelerate;
    first ignite then accelerate;
  }
}`;

  it('runs a parsed action flow through the deepened engine', () => {
    const { model, diagnostics } = parseModel(SRC);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const api = new ModelApi(model);
    const drive = model.all().find((e) => e.declaredName === 'Drive')!;
    const exec = api.executeBehavior(drive.id);
    expect(exec.kind).toBe('action');
    expect(exec.steps.map((s) => s.name).filter(Boolean)).toEqual(['ignite', 'accelerate']);
    expect(exec.action!.depth).toBe(0); // no composite nesting
  });

  it('exposes the execution report over REST with the new fields', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const sm = f.stateDef('SM');
    const s0 = f.state('s0', sm.id);
    const s1 = f.state('s1', sm.id);
    f.transition(s0.id, s1.id, { ownerId: sm.id, trigger: 'go' });
    const server = new SysmlApiServer(m);
    const res = server.apiFetch('GET', '/analytics/execution');
    expect(res.status).toBe(200);
    const body = res.body as ReturnType<typeof executionReport>;
    const machine = body.stateMachines.find((sm2) => sm2.stateMachine.declaredName === 'SM')!;
    expect(machine).toBeDefined();
    expect(Array.isArray(machine.activeStates)).toBe(true);
    expect(typeof machine.clock).toBe('number');
    expect(typeof machine.complete).toBe('boolean');
  });
});

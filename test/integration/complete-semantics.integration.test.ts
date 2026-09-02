/**
 * Integration — the COMPLETE semantics surface exposed through ModelApi + the
 * analytics/execution report.
 *
 * Exercises, end-to-end:
 *  1. Name resolution through the full KerML scoping rules: resolve an imported
 *     bundled-library type (`ISQ::MassValue`, re-exposed by ISQ from ISQBase)
 *     via {@link ModelApi.resolveName}, and confirm the same name is accepted as
 *     a `typeRef` by the `unresolved-type-ref` validation rule (no false flag).
 *  2. Full behavioral execution of an action flow carrying a FOR loop with a
 *     child assignment body plus a standalone assignment — asserting the evolving
 *     VALUE STORE and the loop-iteration count, both directly (ModelApi) and via
 *     the analytics `executionReport` (as surfaced in the UI Simulate affordance).
 *  3. Full behavioral execution of a state machine with an entry behavior and a
 *     transition effect — asserting the PERFORMED behaviors, the final state, and
 *     the effected value store.
 */

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { loadStandardLibrary } from '../../src/library/index';
import { ModelApi, executionReport } from '@api/index';
import { validate } from '@validation/index';

/* ─────────── 1. resolve an imported library type via ModelApi ─────────── */

describe('complete-semantics — ModelApi.resolveName over the standard library', () => {
  const model = new Model();
  loadStandardLibrary(model);
  const api = new ModelApi(model);

  it('resolves an import-exposed qualified library type (ISQ::MassValue)', () => {
    const mv = api.resolveName('ISQ::MassValue');
    expect(mv).toBeDefined();
    expect(mv!.declaredName).toBe('MassValue');
    expect(mv!.attrs.isLibrary).toBe(true);
  });

  it('resolves a strictly-owned library qualified name', () => {
    expect(api.resolveName('ScalarValues::Real')?.declaredName).toBe('Real');
  });

  it('returns undefined for a name that does not exist', () => {
    expect(api.resolveName('ISQ::NoSuchThing')).toBeUndefined();
  });

  it('unresolved-type-ref does NOT flag an imported qualified type name', () => {
    // A user part typed by the imported library name — resolvable through the
    // complete KerML scoping rules, so the rule must not report it.
    const f = new ModelFactory(model);
    const pkg = f.pkg('User');
    const part = f.part('m', pkg.id);
    model.update(part.id, { attrs: { ...part.attrs, typeRef: 'ISQ::MassValue' } });
    const flagged = validate(model).some(
      (d) => d.ruleId === 'unresolved-type-ref' && d.elementId === part.id,
    );
    expect(flagged).toBe(false);

    // Sanity: a genuinely unresolvable ref IS still flagged. The last segment is
    // deliberately not the declared/short name of any library element.
    const bad = f.part('bad', pkg.id);
    model.update(bad.id, { attrs: { ...bad.attrs, typeRef: 'Zzz::Nonexistent999' } });
    expect(
      validate(model).some((d) => d.ruleId === 'unresolved-type-ref' && d.elementId === bad.id),
    ).toBe(true);
  });
});

/* ───── 2. action flow with a loop + assignment: assert the value store ──── */

describe('complete-semantics — action flow with loop + assignment', () => {
  function buildFlow(): { model: Model; actionId: string } {
    const model = new Model();
    const f = new ModelFactory(model);
    const act = f.actionDef('Accumulate');
    f.attribute('sum', act.id, { type: 'Integer', value: 0 });
    const start = model.create('InitialNode', { ownerId: act.id });
    const loop = model.create('ForLoopActionUsage', {
      ownerId: act.id,
      declaredName: 'fl',
      attrs: { variable: 'i', from: '1', to: '4' },
    });
    // Loop body: sum = sum + i  (1+2+3+4 = 10)
    model.create('AssignmentActionUsage', {
      ownerId: loop.id,
      attrs: { target: 'sum', value: 'sum + i' },
    });
    // After the loop, double the total: total = sum * 2
    const assign = model.create('AssignmentActionUsage', {
      ownerId: act.id,
      declaredName: 'setTotal',
      attrs: { target: 'total', value: 'sum * 2' },
    });
    const done = model.create('DoneNode', { ownerId: act.id });
    f.succession(start.id, loop.id, act.id);
    f.succession(loop.id, assign.id, act.id);
    f.succession(assign.id, done.id, act.id);
    return { model, actionId: act.id };
  }

  it('ModelApi.runActionFlow iterates the loop and evolves the value store', () => {
    const { model, actionId } = buildFlow();
    const api = new ModelApi(model);
    const trace = api.runActionFlow(actionId);
    expect(trace.iterations).toBe(4);
    expect(trace.valueStore.get('sum')).toBe(10); // 1+2+3+4
    expect(trace.valueStore.get('i')).toBe(4); // last loop variable
    expect(trace.valueStore.get('total')).toBe(20); // sum * 2
    expect(trace.complete).toBe(true);
  });

  it('executionReport surfaces the value store + iteration count (UI Simulate)', () => {
    const { model } = buildFlow();
    const report = executionReport(model);
    const flow = report.actionFlows.find((r) => r.action.declaredName === 'Accumulate')!;
    expect(flow).toBeDefined();
    expect(flow.iterations).toBe(4);
    expect(flow.valueStore.sum).toBe(10);
    expect(flow.valueStore.total).toBe(20);
    expect(flow.complete).toBe(true);
  });

  it('ModelApi.executeModel traces the behavior with its loop iterations', () => {
    const { model, actionId } = buildFlow();
    const api = new ModelApi(model);
    const exec = api.executeModel();
    const trace = exec.traces.find((t) => t.behaviorId === actionId);
    expect(trace).toBeDefined();
    expect(trace!.kind).toBe('action');
    expect(trace!.action!.iterations).toBe(4);
    expect(trace!.action!.valueStore.get('total')).toBe(20);
  });
});

/* ── 3. state machine with entry + effect: assert performed + final state ── */

describe('complete-semantics — state machine with entry behavior + transition effect', () => {
  function buildMachine() {
    const model = new Model();
    const f = new ModelFactory(model);
    const sm = f.stateDef('Power');
    f.attribute('level', sm.id, { type: 'Integer', value: 0 });
    const off = f.state('off', sm.id);
    const on = f.state('on', sm.id);
    // Entry behavior on `on`, exit behavior on `off`.
    const boot = model.create('ActionUsage', {
      ownerId: on.id,
      declaredName: 'boot',
      attrs: { stateSubaction: 'entry' },
    });
    model.create('ActionUsage', {
      ownerId: off.id,
      declaredName: 'shutdown',
      attrs: { stateSubaction: 'exit' },
    });
    // Transition off --power--> on, whose effect raises `level`.
    f.transition(off.id, on.id, { ownerId: sm.id, trigger: 'power', effect: 'level = 1' });
    return { model, smId: sm.id, on, off, boot };
  }

  it('ModelApi.runStateMachine records performed behaviors, final state and effect', () => {
    const { model, smId, on, off, boot } = buildMachine();
    const api = new ModelApi(model);
    const res = api.runStateMachine(smId, ['power']);

    expect(res.visited).toEqual([off.id, on.id]);
    expect(res.finalState).toBe(on.id);
    expect(res.valueStore.get('level')).toBe(1); // transition effect applied
    expect(res.performed.some((p) => p.actionId === boot.id && p.phase === 'entry')).toBe(true);
    expect(res.performed.some((p) => p.name === 'shutdown' && p.phase === 'exit')).toBe(true);
    expect(res.activeStates).toEqual([on.id]);
  });

  it('executionReport surfaces performed behaviors + value store (UI Simulate)', () => {
    const { model, on } = buildMachine();
    const report = executionReport(model);
    const machine = report.stateMachines.find((m) => m.stateMachine.declaredName === 'Power')!;
    expect(machine).toBeDefined();
    expect(machine.triggers).toEqual(['power']);
    expect(machine.finalState).toBe(on.id);
    expect(machine.performed.some((p) => p.phase === 'entry' && p.name === 'boot')).toBe(true);
    expect(machine.valueStore.level).toBe(1);
  });
});

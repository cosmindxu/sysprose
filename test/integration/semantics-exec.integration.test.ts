/**
 * Integration — Parse → Execution semantics → API / REST / Validation.
 *
 * Exercises the behavioral-execution surface end-to-end:
 *  - parse a textual model carrying an action flow (`first … then …`
 *    successions) AND a state machine (`transition … accept … then …`), then
 *    run each through {@link ModelApi.runActionFlow} / {@link ModelApi.runStateMachine}
 *    and assert the visited-node trace + state sequence;
 *  - assert the analytics `executionReport` / REST `GET /analytics/execution`
 *    shape lists both runnable behaviors with their traces;
 *  - assert the metaclass-aware validation improvement: `ModelApi.isKindOf`
 *    drives `feature-typing-non-type` (a Usage is now trusted as a type) and the
 *    new `connector-end-not-feature` rule (a Definition endpoint is flagged).
 */

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { parseModel } from '@text/index';
import { ModelApi, SysmlApiServer, executionReport } from '@api/index';
import { validate } from '@validation/index';

const EXEC_SRC = `
package P {
  action def Drive {
    action ignite;
    action accelerate;
    first ignite then accelerate;
  }
  state def Traffic {
    state red;
    state green;
    transition t1 first red accept go then green;
    transition t2 first green accept stop then red;
  }
}`;

function parse(): Model {
  const { model, diagnostics } = parseModel(EXEC_SRC);
  expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return model;
}

const byName = (model: Model, name: string) => model.all().find((e) => e.declaredName === name)!;

describe('semantics-exec — action flow via ModelApi', () => {
  const model = parse();
  const api = new ModelApi(model);
  const drive = byName(model, 'Drive');

  it('runs the action flow and traces its steps in succession order', () => {
    const trace = api.runActionFlow(drive.id);
    const names = trace.steps.map((s) => s.name);
    expect(names).toEqual(['ignite', 'accelerate']);
    expect(trace.steps.every((s) => s.kind === 'ActionUsage')).toBe(true);
    expect(trace.edgesFired).toHaveLength(1);
    expect(trace.complete).toBe(true);
  });
});

describe('semantics-exec — state machine via ModelApi', () => {
  const model = parse();
  const api = new ModelApi(model);
  const traffic = byName(model, 'Traffic');
  const red = byName(model, 'red');
  const green = byName(model, 'green');

  it('drives the machine through its triggers and reports the visited state sequence', () => {
    const res = api.runStateMachine(traffic.id, ['go', 'stop', 'go']);
    expect(res.visited).toEqual([red.id, green.id, red.id, green.id]);
    expect(res.finalState).toBe(green.id);
    expect(res.fired.map((f) => f.trigger)).toEqual(['go', 'stop', 'go']);
  });

  it('ignores a trigger with no enabled transition (stays put)', () => {
    const res = api.runStateMachine(traffic.id, ['stop']); // not enabled from the initial state
    expect(res.fired).toHaveLength(0);
    expect(res.finalState).toBe(red.id);
  });
});

describe('semantics-exec — executionReport / REST /analytics/execution', () => {
  const model = parse();

  it('lists the runnable action flow and state machine with trace summaries', () => {
    const report = executionReport(model);

    const flow = report.actionFlows.find((f) => f.action.declaredName === 'Drive')!;
    expect(flow).toBeDefined();
    expect(flow.successionCount).toBe(1);
    expect(flow.steps.map((s) => s.name)).toEqual(['ignite', 'accelerate']);
    expect(flow.complete).toBe(true);

    const machine = report.stateMachines.find((m) => m.stateMachine.declaredName === 'Traffic')!;
    expect(machine).toBeDefined();
    expect(machine.transitionCount).toBe(2);
    expect(machine.stateCount).toBe(2);
    expect(machine.triggers).toEqual(['go', 'stop']);
    // Driven with the discovered trigger alphabet [go, stop] from the initial state.
    expect(machine.visited).toEqual([
      byName(model, 'red').id,
      byName(model, 'green').id,
      byName(model, 'red').id,
    ]);
  });

  it('exposes the same report over the REST facade (200 + JSON shape)', () => {
    const server = new SysmlApiServer(model);
    const res = server.apiFetch('GET', '/analytics/execution');
    expect(res.status).toBe(200);
    const body = res.body as ReturnType<typeof executionReport>;
    expect(Array.isArray(body.actionFlows)).toBe(true);
    expect(Array.isArray(body.stateMachines)).toBe(true);
    expect(body.actionFlows.some((f) => f.action.declaredName === 'Drive')).toBe(true);
    expect(body.stateMachines.some((m) => m.stateMachine.declaredName === 'Traffic')).toBe(true);
  });
});

describe('semantics-exec — metaclass-aware validation improvement', () => {
  it('isKindOf reflects the OMG metaclass lattice through ModelApi', () => {
    const api = new ModelApi(new Model());
    expect(api.isKindOf('PartUsage', 'Feature')).toBe(true);
    expect(api.isKindOf('PartUsage', 'Type')).toBe(true);
    expect(api.isKindOf('PartDefinition', 'Type')).toBe(true);
    expect(api.isKindOf('PartDefinition', 'Feature')).toBe(false);
    expect(api.isKindOf('Package', 'Type')).toBe(false);
  });

  it('feature-typing-non-type trusts a Usage-typed feature (no false positive)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const another = f.part('anotherPart', p.id); // PartUsage — a kind of Type
    const feature = f.part('feature', p.id);
    f.featureTyping(feature.id, another.id);
    expect(validate(m).some((d) => d.ruleId === 'feature-typing-non-type')).toBe(false);
  });

  it('connector-end-not-feature flags a Definition (non-Feature) connector endpoint', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const feature = f.part('a', p.id); // Feature end
    const def = f.partDef('Engine', p.id); // PartDefinition — a Classifier, NOT a Feature
    m.create('ConnectionUsage', {
      declaredName: 'bad',
      ownerId: p.id,
      source: [feature.id],
      target: [def.id],
    });
    const diags = validate(m).filter((d) => d.ruleId === 'connector-end-not-feature');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('error');
  });
});

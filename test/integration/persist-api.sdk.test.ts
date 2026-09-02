/**
 * Integration: end-to-end SDK automation scenario.
 *
 * Covers task §3 — programmatically build a small model through
 * ModelApi.commit(...), query it (both via evaluateQuery and via the SDK's own
 * navigation helpers), serialize it to SysML v2 text, re-import that text, and
 * assert the rebuilt model is equivalent to the authored one. This demonstrates
 * the automation API working end to end.
 */

import { describe, it, expect } from 'vitest';
import { Model, type ElementId } from '@core/index';
import {
  ModelApi,
  SysmlApiServer,
  evaluateQuery,
  requirementSatisfaction,
  type Query,
} from '@api/index';
import { exportModel, importModel } from '@persistence/index';
import { expectSameElementSet } from './helpers';

/** Author a small sensor model entirely through the SDK and return ids + commit. */
function authorModel() {
  const model = new Model();
  const api = new ModelApi(model);
  const ids: Record<string, ElementId> = {};

  const c1 = api.commit((a) => {
    const pkg = a.create('Package', { declaredName: 'SensorPkg' });
    ids.pkg = pkg.id;
    const sensorDef = a.create('PartDefinition', { declaredName: 'Sensor', ownerId: pkg.id });
    ids.sensorDef = sensorDef.id;
    const sensor = a.create('PartUsage', { declaredName: 'sensor', ownerId: pkg.id });
    ids.sensor = sensor.id;
    // type the usage by its definition (FeatureTyping owned by the usage)
    a.create('FeatureTyping', { ownerId: sensor.id, source: [sensor.id], target: [sensorDef.id] });
    const rate = a.create('AttributeUsage', {
      declaredName: 'rate',
      ownerId: sensor.id,
      attrs: { type: 'Real', value: 10 },
    });
    ids.rate = rate.id;
  });
  ids.commit1 = c1 as unknown as ElementId;

  // A second commit adds a requirement and a satisfy edge — exercises monotonic ids.
  const c2 = api.commit((a) => {
    const req = a.create('RequirementUsage', {
      declaredName: 'accuracyReq',
      ownerId: ids.pkg,
      attrs: { reqId: 'R1', text: 'rate shall be at least 5' },
    });
    ids.req = req.id;
    a.create('Satisfy', { ownerId: ids.pkg, source: [ids.sensor], target: [req.id] });
  });
  ids.commit2 = c2 as unknown as ElementId;

  return { model, api, ids, c1, c2 };
}

describe('SDK automation — authoring via commit()', () => {
  it('builds the intended element graph and returns deterministic, monotonic commit ids', () => {
    const { model, ids, c1, c2 } = authorModel();
    expect(model.size).toBe(7); // pkg, def, usage, typing, attr, req, satisfy
    expect(typeof c1).toBe('string');
    expect(typeof c2).toBe('string');
    expect(c1).not.toBe(c2);
    // Deterministic (no Date.now / random embedded).
    expect(c1).not.toMatch(/\d{13}/);
    expect(c1).toMatch(/^commit-/);
    // Containment was wired correctly.
    expect(model.get(ids.sensor)!.ownerId).toBe(ids.pkg);
    expect(model.get(ids.rate)!.ownerId).toBe(ids.sensor);
  });

  it('batches each commit into a single change notification', () => {
    const model = new Model();
    const api = new ModelApi(model);
    let batches = 0;
    model.subscribe(() => batches++);
    api.commit((a) => {
      const p = a.create('Package', { declaredName: 'P' });
      a.create('PartDefinition', { declaredName: 'A', ownerId: p.id });
      a.create('PartDefinition', { declaredName: 'B', ownerId: p.id });
    });
    expect(batches).toBe(1);
  });
});

describe('SDK automation — querying the authored model', () => {
  it('finds elements via the OMG Query engine', () => {
    const { model } = authorModel();
    const q: Query = {
      constraint: {
        kind: 'or',
        operands: [
          { property: '@type', operator: '=', value: 'PartUsage' },
          { property: '@type', operator: '=', value: 'RequirementUsage' },
        ],
      },
    };
    const result = evaluateQuery(model, q);
    expect(result.total).toBe(2);
    expect(result.elements.map((e) => e.declaredName).sort()).toEqual(['accuracyReq', 'sensor']);
  });

  it('navigates via the SDK and reports satisfaction analytics', () => {
    const { api, ids } = authorModel();
    expect(api.byName('SensorPkg::sensor')!.id).toBe(ids.sensor);
    expect(api.elementsOfType('PartUsage')).toHaveLength(1);
    // sensor is typed by Sensor; satisfies accuracyReq.
    expect(api.traverse(ids.sensor, 'FeatureTyping', 'out').map((e) => e.id)).toEqual([ids.sensorDef]);
    expect(api.traverse(ids.sensor, 'Satisfy', 'out').map((e) => e.id)).toEqual([ids.req]);

    const sat = requirementSatisfaction(api.model);
    expect(sat.total).toBe(1);
    expect(sat.satisfied).toBe(1);
    expect(sat.coverage).toBe(1);
    expect(sat.requirements[0].satisfiers.map((s) => s.declaredName)).toEqual(['sensor']);
  });

  it('exposes the authored model through the REST facade', () => {
    const { model, ids } = authorModel();
    const srv = new SysmlApiServer(model);
    const proj = srv.apiFetch('GET', '/projects/project-default');
    expect(proj.status).toBe(200);
    expect((proj.body as { name: string }).name).toBe('SensorPkg');
    const el = srv.apiFetch('GET', `/elements/${ids.sensor}`);
    expect(el.status).toBe(200);
    expect((el.body as { declaredName: string }).declaredName).toBe('sensor');
  });
});

describe('SDK automation — serialize → re-import equivalence', () => {
  it('round-trips the authored model through SysML v2 text', () => {
    const { model } = authorModel();
    const sysml = exportModel(model, 'sysml');
    expect(sysml).toContain('package SensorPkg');
    expect(sysml).toContain('part def Sensor');
    expect(sysml).toContain('accuracyReq');
    expect(sysml).toContain('satisfy accuracyReq by sensor');

    const { model: reimported, diagnostics } = importModel(sysml, 'sysml');
    expect((diagnostics ?? []).filter((d) => d.severity === 'error')).toEqual([]);
    expectSameElementSet(model, reimported);
  });

  it('also round-trips losslessly through model-json and api-json', () => {
    const { model } = authorModel();
    for (const fmt of ['model-json', 'api-json'] as const) {
      const reimported = importModel(exportModel(model, fmt), fmt).model;
      expectSameElementSet(model, reimported);
    }
  });

  it('a query yields the same elements before and after the text round-trip', () => {
    const { model } = authorModel();
    const q: Query = { constraint: { property: 'name', operator: 'exists', value: true } };
    const before = evaluateQuery(model, q).elements.map((e) => model.qualifiedName(e.id as string)).sort();

    const reimported = importModel(exportModel(model, 'sysml'), 'sysml').model;
    const after = evaluateQuery(reimported, q)
      .elements.map((e) => reimported.qualifiedName(e.id as string))
      .sort();
    expect(after).toEqual(before);
  });
});

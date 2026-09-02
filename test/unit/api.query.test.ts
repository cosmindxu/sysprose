import { describe, it, expect } from 'vitest';
import { buildSampleModel } from '@core/index';
import { ModelApi, evaluateQuery } from '@api/index';

function ctx() {
  const model = buildSampleModel();
  const api = new ModelApi(model);
  const ids = {
    vehicle: api.byName('VehicleModel::vehicle')!.id,
    engine: api.byName('VehicleModel::vehicle::engine')!.id,
  };
  return { model, ids };
}

describe('evaluateQuery — primitive operators', () => {
  it('= matches by @type', () => {
    const { model } = ctx();
    const r = evaluateQuery(model, { constraint: { property: '@type', operator: '=', value: 'PartUsage' } });
    expect(r.total).toBe(2);
    expect(r.elements).toHaveLength(2);
    expect(r.commitId).toMatch(/^commit-/);
  });

  it('!= excludes a type', () => {
    const { model } = ctx();
    const r = evaluateQuery(model, { constraint: { property: 'eClass', operator: '!=', value: 'PartUsage' } });
    expect(r.total).toBe(model.size - 2);
    expect(r.elements.every((e) => e.eClass !== 'PartUsage')).toBe(true);
  });

  it('> and < compare numeric attribute values', () => {
    const { model } = ctx();
    const gt = evaluateQuery(model, { constraint: { property: 'attrs.value', operator: '>', value: 1000 } });
    expect(gt.total).toBe(1);
    expect(gt.elements[0].declaredName).toBe('mass');
    const lt = evaluateQuery(model, { constraint: { property: 'attrs.value', operator: '<', value: 1000 } });
    expect(lt.total).toBe(0);
  });

  it('in matches against a value set', () => {
    const { model } = ctx();
    const r = evaluateQuery(model, {
      constraint: { property: '@type', operator: 'in', value: ['PartDefinition', 'RequirementUsage'] },
    });
    expect(r.total).toBe(3);
  });

  it('contains does substring matching on names', () => {
    const { model } = ctx();
    const r = evaluateQuery(model, { constraint: { property: 'declaredName', operator: 'contains', value: 'Vehicle' } });
    // 'Vehicle' (def) and 'VehicleModel' (pkg); lowercase 'vehicle' excluded.
    expect(r.elements.map((e) => e.declaredName).sort()).toEqual(['Vehicle', 'VehicleModel']);
  });

  it('exists tests presence (and absence with value:false)', () => {
    const { model } = ctx();
    const present = evaluateQuery(model, { constraint: { property: 'attrs.direction', operator: 'exists' } });
    expect(present.total).toBe(2); // fuelOut + fuelIn ports
    const absent = evaluateQuery(model, { constraint: { property: 'declaredShortName', operator: 'exists', value: false } });
    expect(absent.total).toBe(model.size); // none have a short name
  });
});

describe('evaluateQuery — composite constraints', () => {
  it('and combines leaves', () => {
    const { model } = ctx();
    const r = evaluateQuery(model, {
      constraint: {
        kind: 'and',
        operands: [
          { property: '@type', operator: '=', value: 'PortUsage' },
          { property: 'attrs.direction', operator: '=', value: 'out' },
        ],
      },
    });
    expect(r.total).toBe(1);
    expect(r.elements[0].declaredName).toBe('fuelOut');
  });

  it('or unions leaves', () => {
    const { model } = ctx();
    const r = evaluateQuery(model, {
      constraint: {
        kind: 'or',
        operands: [
          { property: 'name', operator: '=', value: 'Vehicle' },
          { property: 'name', operator: '=', value: 'Engine' },
        ],
      },
    });
    expect(r.total).toBe(2);
  });

  it('not negates', () => {
    const { model } = ctx();
    const r = evaluateQuery(model, {
      constraint: { kind: 'not', operands: [{ property: '@type', operator: '=', value: 'FeatureTyping' }] },
    });
    expect(r.elements.every((e) => e.eClass !== 'FeatureTyping')).toBe(true);
    expect(r.total).toBe(model.size - 2); // two FeatureTypings in the sample
  });
});

describe('evaluateQuery — projection, pagination, scope', () => {
  it('projects with select', () => {
    const { model } = ctx();
    const r = evaluateQuery(model, {
      constraint: { property: '@type', operator: '=', value: 'PartUsage' },
      select: ['declaredName', '@type'],
    });
    const row = r.elements[0] as unknown as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['@type', 'declaredName']);
    expect(row['@type']).toBe('PartUsage');
  });

  it('paginates with offset/limit while reporting full total', () => {
    const { model } = ctx();
    const r = evaluateQuery(model, { page: { offset: 0, limit: 2 } });
    expect(r.elements).toHaveLength(2);
    expect(r.total).toBe(model.size);
    const r2 = evaluateQuery(model, { page: { offset: 1, limit: 2 } });
    expect(r2.elements[0].id).toBe(model.all()[1].id);
  });

  it('scopes evaluation to a subtree (inclusive)', () => {
    const { model, ids } = ctx();
    const underVehicle = evaluateQuery(model, {
      scopeOwnerId: ids.vehicle,
      constraint: { property: '@type', operator: '=', value: 'PortUsage' },
    });
    expect(underVehicle.total).toBe(2);
    const underEngine = evaluateQuery(model, {
      scopeOwnerId: ids.engine,
      constraint: { property: '@type', operator: '=', value: 'PortUsage' },
    });
    expect(underEngine.total).toBe(1);
  });
});

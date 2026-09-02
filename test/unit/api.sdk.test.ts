import { describe, it, expect } from 'vitest';
import { Model, ModelFactory, buildSampleModel } from '@core/index';
import { ModelApi } from '@api/index';

function sample() {
  const model = buildSampleModel();
  const api = new ModelApi(model);
  const ids = {
    sys: api.byName('VehicleModel')!.id,
    vehicleDef: api.byName('VehicleModel::Vehicle')!.id,
    engineDef: api.byName('VehicleModel::Engine')!.id,
    vehicle: api.byName('VehicleModel::vehicle')!.id,
    engine: api.byName('VehicleModel::vehicle::engine')!.id,
    fuelOut: api.byName('VehicleModel::vehicle::engine::fuelOut')!.id,
    fuelIn: api.byName('VehicleModel::vehicle::fuelIn')!.id,
    mass: api.byName('VehicleModel::vehicle::mass')!.id,
    req: api.byName('VehicleModel::maxMass')!.id,
  };
  return { model, api, ids };
}

describe('ModelApi — navigation', () => {
  it('looks elements up by type and qualified name', () => {
    const { api } = sample();
    expect(api.elementsOfType('PartUsage')).toHaveLength(2);
    expect(api.elementsOfType('PartDefinition')).toHaveLength(2);
    expect(api.elementsOfType('PartUsage', 'PartDefinition')).toHaveLength(4);
    expect(api.byName('VehicleModel::Vehicle')?.eClass).toBe('PartDefinition');
    expect(api.byName('VehicleModel::nope')).toBeUndefined();
  });

  it('navigates owner / children / ancestors / roots', () => {
    const { api, ids } = sample();
    expect(api.owner(ids.engine)?.id).toBe(ids.vehicle);
    expect(api.children(ids.vehicle).some((e) => e.id === ids.engine)).toBe(true);
    expect(api.ancestors(ids.engine).map((e) => e.id)).toEqual([ids.vehicle, ids.sys]);
    expect(api.roots().map((e) => e.id)).toEqual([ids.sys]);
    expect(api.getElement(ids.mass)?.declaredName).toBe('mass');
  });

  it('traverses edges by relationship kind and direction', () => {
    const { api, ids } = sample();
    // Satisfy: source = vehicle, target = req.
    expect(api.traverse(ids.vehicle, 'Satisfy', 'out').map((e) => e.id)).toEqual([ids.req]);
    expect(api.traverse(ids.req, 'Satisfy', 'in').map((e) => e.id)).toEqual([ids.vehicle]);
    // FeatureTyping from vehicle → Vehicle definition.
    expect(api.traverse(ids.vehicle, 'FeatureTyping', 'out').map((e) => e.id)).toEqual([
      ids.vehicleDef,
    ]);
    expect(api.traverse(ids.vehicle, 'Satisfy', 'in')).toHaveLength(0);
  });
});

describe('ModelApi — OMG element JSON', () => {
  it('produces the reified @id/@type/ownedRelationship shape', () => {
    const { api, ids } = sample();
    const json = api.toElementJSON(ids.vehicle)!;
    expect(json['@id']).toBe(ids.vehicle);
    expect(json['@type']).toBe('PartUsage');
    expect(json.identifier).toBe(ids.vehicle);
    expect(json.declaredName).toBe('vehicle');
    expect(json.owner).toEqual({ '@id': ids.sys });
    expect(Array.isArray(json.ownedRelationship)).toBe(true);
    // The vehicle owns its own FeatureTyping relationship.
    expect(json.ownedRelationship.length).toBeGreaterThanOrEqual(1);
    // engine is an owned (non-relationship) member.
    expect(json.ownedMember.some((m) => m['@id'] === ids.engine)).toBe(true);
  });

  it('spreads attributes and serializes endpoints for edges', () => {
    const { api, ids } = sample();
    const mass = api.toElementJSON(ids.mass)!;
    expect(mass.type).toBe('Real');
    expect(mass.value).toBe(1500);

    const conn = api.byName('VehicleModel::vehicle::fuelLine')!;
    const connJson = api.toElementJSON(conn.id)!;
    expect(connJson.source).toEqual([{ '@id': ids.fuelOut }]);
    expect(connJson.target).toEqual([{ '@id': ids.fuelIn }]);
    expect(api.toElementJSON('missing')).toBeUndefined();
  });
});

describe('ModelApi — mutation & commits', () => {
  it('passes create/update/delete through to the model', () => {
    const model = new Model();
    const api = new ModelApi(model);
    const pkg = api.create('Package', { declaredName: 'P' });
    expect(model.has(pkg.id)).toBe(true);
    api.update(pkg.id, { declaredName: 'P2' });
    expect(model.get(pkg.id)?.declaredName).toBe('P2');
    const child = api.create('PartDefinition', { declaredName: 'C', ownerId: pkg.id });
    const removed = api.delete(pkg.id);
    expect(removed).toContain(child.id);
    expect(model.has(pkg.id)).toBe(false);
  });

  it('commits batch mutations and return deterministic, monotonic ids', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const root = f.pkg('Root');
    const api = new ModelApi(model);
    let batches = 0;
    model.subscribe(() => batches++);
    const c1 = api.commit((a) => {
      a.create('PartDefinition', { declaredName: 'A', ownerId: root.id });
      a.create('PartDefinition', { declaredName: 'B', ownerId: root.id });
    });
    expect(typeof c1).toBe('string');
    expect(batches).toBe(1); // batched into a single notification
    const c2 = api.commit((a) => a.create('PartDefinition', { declaredName: 'C', ownerId: root.id }));
    expect(c2).not.toBe(c1); // monotonic
    expect(c1).toMatch(/^commit-\d+-\d+$/); // deterministic, not a Date.now timestamp
  });
});

describe('ModelApi — versioning surface', () => {
  it('seeds a repository lazily with an initial commit of the working model', () => {
    const { api } = sample();
    // Initial history holds exactly the seed commit.
    const history = api.history();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(api.headCommitId());
    // Repository is deterministic (counter ids), not Date/random.
    expect(api.headCommitId()).toBe('commit-1');
    expect(api.projectId).toBe('project-1');
    // The seed commit reconstructs the current model.
    const seeded = api.repository.getModelAtCommit(api.headCommitId());
    expect(seeded.all().length).toBe(api.model.all().length);
  });

  it('commit(description) snapshots the model and advances history', () => {
    const { api, ids } = sample();
    const c1 = api.commit('add a part');
    expect(c1.id).toBe('commit-2');
    expect(c1.description).toBe('add a part');
    expect(api.headCommitId()).toBe('commit-2');
    expect(api.history().map((c) => c.id)).toEqual(['commit-1', 'commit-2']);

    // Mutate then re-snapshot: diffWithPrevious reports the delta head↔prev.
    api.create('PartDefinition', { declaredName: 'Gizmo', ownerId: ids.sys });
    const c2 = api.commit('add Gizmo');
    expect(c2.previousCommitId).toBe(c1.id);
    const diff = api.diffWithPrevious();
    expect(diff).toBeDefined();
    expect(diff!.added.some((e) => e.declaredName === 'Gizmo')).toBe(true);
    expect(diff!.removed).toHaveLength(0);
  });

  it('diffWithPrevious is undefined at the initial commit', () => {
    const { api } = sample();
    expect(api.diffWithPrevious()).toBeUndefined();
  });

  it('createBranch and tag point at the current head', () => {
    const { api } = sample();
    const head = api.headCommitId();
    const branch = api.createBranch('feature');
    expect(branch.name).toBe('feature');
    expect(branch.headCommitId).toBe(head);
    const tag = api.tag('v1');
    expect(tag.name).toBe('v1');
    expect(tag.commitId).toBe(head);
  });
});

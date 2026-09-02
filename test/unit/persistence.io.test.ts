import { describe, it, expect, beforeEach } from 'vitest';
import { buildSampleModel, Model } from '@core/index';
import {
  InMemoryStore,
  LocalStorageStore,
  createDefaultStore,
  isLocalStorageAvailable,
  exportModel,
  importModel,
  type ProjectStore,
  type ModelFormat,
} from '@persistence/index';
import { expectSameElementSet } from '../integration/helpers';

/* ───────────────────────────── shared store suite ───────────────────────── */

function storeRoundTrips(name: string, makeStore: () => ProjectStore): void {
  describe(`${name} — round-trips`, () => {
    let store: ProjectStore;
    beforeEach(() => {
      store = makeStore();
    });

    it('save → load returns an equal snapshot', async () => {
      const data = buildSampleModel().toJSON();
      await store.saveProject('demo', data);
      const loaded = await store.loadProject('demo');
      expect(loaded).not.toBeNull();
      expect(loaded).toEqual(data);
      // Reconstruct and compare element sets.
      expectSameElementSet(buildSampleModel(), Model.fromJSON(loaded!));
    });

    it('loadProject returns null for an unknown project', async () => {
      expect(await store.loadProject('does-not-exist')).toBeNull();
    });

    it('listProjects reflects saved projects', async () => {
      expect(await store.listProjects()).toEqual([]);
      await store.saveProject('a', buildSampleModel().toJSON());
      await store.saveProject('b', new Model().toJSON());
      const list = await store.listProjects();
      expect(list.sort()).toEqual(['a', 'b']);
    });

    it('saveProject overwrites an existing project', async () => {
      await store.saveProject('p', buildSampleModel().toJSON());
      const empty = new Model().toJSON();
      await store.saveProject('p', empty);
      expect(await store.loadProject('p')).toEqual(empty);
      expect(await store.listProjects()).toEqual(['p']);
    });

    it('deleteProject removes a project', async () => {
      await store.saveProject('x', buildSampleModel().toJSON());
      await store.deleteProject('x');
      expect(await store.loadProject('x')).toBeNull();
      expect(await store.listProjects()).toEqual([]);
    });

    it('stored snapshots do not alias live data', async () => {
      const data = buildSampleModel().toJSON();
      await store.saveProject('iso', data);
      data.elements[0].declaredName = 'MUTATED';
      const loaded = await store.loadProject('iso');
      expect(loaded!.elements[0].declaredName).not.toBe('MUTATED');
    });
  });
}

storeRoundTrips('InMemoryStore', () => new InMemoryStore());
storeRoundTrips('LocalStorageStore', () => {
  localStorage.clear();
  return new LocalStorageStore('test.proj.');
});

describe('LocalStorageStore — key isolation', () => {
  it('only lists keys under its own prefix', async () => {
    localStorage.clear();
    localStorage.setItem('unrelated', 'noise');
    const store = new LocalStorageStore('iso.');
    await store.saveProject('only', new Model().toJSON());
    expect(await store.listProjects()).toEqual(['only']);
  });
});

describe('createDefaultStore', () => {
  it('returns a usable ProjectStore in jsdom', async () => {
    const store = createDefaultStore({ prefix: 'def.' });
    await store.saveProject('d', new Model().toJSON());
    expect(await store.loadProject('d')).not.toBeNull();
  });

  it('reports localStorage availability under jsdom', () => {
    expect(isLocalStorageAvailable()).toBe(true);
  });
});

/* ──────────────────────────── import / export ───────────────────────────── */

const FORMATS: ModelFormat[] = ['model-json', 'sysml', 'api-json'];

describe('exportModel / importModel — round-trips', () => {
  for (const format of FORMATS) {
    it(`'${format}' export → import preserves the element set`, () => {
      const original = buildSampleModel();
      const text = exportModel(original, format);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      const { model, diagnostics } = importModel(text, format);
      if (diagnostics) expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expectSameElementSet(original, model);
    });
  }

  it("'model-json' emits a versioned SerializedModel", () => {
    const text = exportModel(buildSampleModel(), 'model-json');
    const parsed = JSON.parse(text);
    expect(parsed.formatVersion).toBeTruthy();
    expect(Array.isArray(parsed.elements)).toBe(true);
    expect(Array.isArray(parsed.rootIds)).toBe(true);
  });

  it("'sysml' emits recognizable SysML v2 text", () => {
    const text = exportModel(buildSampleModel(), 'sysml');
    expect(text).toContain('package VehicleModel');
    expect(text).toContain('part def Vehicle');
  });

  it("'api-json' emits an OMG element-graph with @id/@type and reified ownership", () => {
    const text = exportModel(buildSampleModel(), 'api-json');
    const graph = JSON.parse(text);
    expect(Array.isArray(graph.elements)).toBe(true);
    // Every element carries @id and @type.
    for (const e of graph.elements) {
      expect(typeof e['@id']).toBe('string');
      expect(typeof e['@type']).toBe('string');
    }
    // Ownership is reified as membership relationship elements.
    const memberships = graph.elements.filter(
      (e: { '@type': string }) =>
        e['@type'] === 'OwningMembership' || e['@type'] === 'FeatureMembership',
    );
    expect(memberships.length).toBeGreaterThan(0);
    // A part usage references its owning relationship.
    const vehicle = graph.elements.find((e: { declaredName?: string }) => e.declaredName === 'vehicle');
    expect(vehicle.owningRelationship).toBeTruthy();
    // Root elements appear in rootElement.
    expect(Array.isArray(graph.rootElement)).toBe(true);
    expect(graph.rootElement.length).toBeGreaterThan(0);
  });

  it("'api-json' is idempotent across two export/import cycles", () => {
    const once = exportModel(buildSampleModel(), 'api-json');
    const reparsed = importModel(once, 'api-json').model;
    const twice = exportModel(reparsed, 'api-json');
    expect(twice).toBe(once);
  });

  it("'model-json' round-trips an empty model", () => {
    const empty = new Model();
    const { model } = importModel(exportModel(empty, 'model-json'), 'model-json');
    expect(model.size).toBe(0);
  });
});

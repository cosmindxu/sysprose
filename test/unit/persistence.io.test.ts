import { describe, it, expect, beforeEach } from 'vitest';
import { buildSampleModel, Model } from '@core/index';
import { parseModel } from '@text/index';
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

  /**
   * An `alias` is a `Membership` of the model. On the wire it sits beside the
   * export's reified ownership memberships (`om-<member id>`), and the import
   * used to skip every entry of a membership type, so each alias was lost.
   */
  it("'api-json' keeps the model's own Membership elements (aliases)", () => {
    const { model: original, diagnostics } = parseModel(
      [
        'package Shop {',
        '    part def Vehicle;',
        '    alias Car for Vehicle;',
        '    package Inner {',
        '        alias <V> Wagon for Vehicle;',
        '    }',
        '}',
      ].join('\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(original.all().filter((el) => el.eClass === 'Membership')).toHaveLength(2);
    const once = exportModel(original, 'api-json');
    const { model } = importModel(once, 'api-json');
    expectSameElementSet(original, model);
    for (const alias of original.all().filter((el) => el.eClass === 'Membership')) {
      expect(model.get(alias.id)).toEqual(alias);
    }
    expect(exportModel(model, 'api-json')).toBe(once);
  });

  /**
   * A graph written elsewhere gives its memberships ids of their own. The one
   * an element names as its `owningRelationship` is its containment, as is the
   * export's `om-<element id>` (here even for an element whose back-link names a
   * relationship the graph does not hold); any other membership pointing at it
   * (here an alias, and an owning membership the element does not name, in
   * another package) is an element of the model, sits in the namespace that
   * owns it (`owningRelatedElement`) and never moves the element.
   */
  it("'api-json' takes containment from an element's owning membership only", () => {
    const ref = (id: string): { '@id': string } => ({ '@id': id });
    const graph = {
      elements: [
        { '@id': 'p', '@type': 'Package', identifier: 'p', declaredName: 'P', ownedRelationship: [ref('m1')] },
        {
          '@id': 'q',
          '@type': 'Package',
          identifier: 'q',
          declaredName: 'Q',
          ownedRelationship: [ref('m2'), ref('m3'), ref('om-e')],
        },
        {
          '@id': 'm1',
          '@type': 'OwningMembership',
          identifier: 'm1',
          memberElement: ref('d'),
          ownedMemberElement: ref('d'),
          owningRelatedElement: ref('p'),
        },
        { '@id': 'd', '@type': 'PartDefinition', identifier: 'd', declaredName: 'D', owningRelationship: ref('m1') },
        {
          '@id': 'm2',
          '@type': 'Membership',
          identifier: 'm2',
          declaredName: 'Alias',
          memberElement: ref('d'),
          owningRelatedElement: ref('q'),
          target: [ref('d')],
        },
        {
          '@id': 'm3',
          '@type': 'OwningMembership',
          identifier: 'm3',
          memberElement: ref('d'),
          ownedMemberElement: ref('d'),
          owningRelatedElement: ref('q'),
        },
        {
          '@id': 'om-e',
          '@type': 'FeatureMembership',
          identifier: 'om-e',
          memberElement: ref('e'),
          ownedMemberElement: ref('e'),
          owningRelatedElement: ref('q'),
        },
        { '@id': 'e', '@type': 'PartUsage', identifier: 'e', declaredName: 'e', owningRelationship: ref('gone') },
      ],
    };
    const { model } = importModel(JSON.stringify(graph), 'api-json');
    expect(model.get('d')?.ownerId).toBe('p');
    expect(model.get('m1'), 'the owning membership is consumed').toBeUndefined();
    expect(model.get('m2')?.eClass).toBe('Membership');
    expect(model.get('m2')?.target).toEqual(['d']);
    expect(model.get('m2')?.ownerId, 'the alias sits in its namespace').toBe('q');
    expect(model.get('m3')?.eClass, 'an owning membership d does not name is kept').toBe('OwningMembership');
    expect(model.get('m3')?.ownerId).toBe('q');
    expect(model.get('e')?.ownerId).toBe('q');
    expect(model.get('om-e')).toBeUndefined();
    expect(model.size).toBe(6);
    expect(model.rootIds()).toEqual(['p', 'q']);
  });

  /**
   * `owningRelationship` is derived, and optional on the wire: a graph can give
   * its memberships ids of their own and leave the back-link off its members.
   * Then an element's owning membership is still its containment, as the import
   * has always read it, and an alias of it still never moves it.
   */
  it("'api-json' takes containment from an owning membership its member does not name", () => {
    const ref = (id: string): { '@id': string } => ({ '@id': id });
    const graph = {
      elements: [
        { '@id': 'p', '@type': 'Package', identifier: 'p', declaredName: 'P', ownedRelationship: [ref('u1')] },
        {
          '@id': 'u1',
          '@type': 'OwningMembership',
          identifier: 'u1',
          memberElement: ref('d'),
          ownedMemberElement: ref('d'),
          owningRelatedElement: ref('p'),
        },
        { '@id': 'd', '@type': 'PartDefinition', identifier: 'd', declaredName: 'D', ownedRelationship: [ref('u2')] },
        {
          '@id': 'u2',
          '@type': 'FeatureMembership',
          identifier: 'u2',
          memberElement: ref('f'),
          ownedMemberElement: ref('f'),
          owningRelatedElement: ref('d'),
        },
        { '@id': 'f', '@type': 'PartUsage', identifier: 'f', declaredName: 'f' },
        { '@id': 'q', '@type': 'Package', identifier: 'q', declaredName: 'Q', ownedRelationship: [ref('a')] },
        {
          '@id': 'a',
          '@type': 'Membership',
          identifier: 'a',
          declaredName: 'Car',
          memberElement: ref('d'),
          owningRelatedElement: ref('q'),
          target: [ref('d')],
        },
      ],
    };
    const { model } = importModel(JSON.stringify(graph), 'api-json');
    expect(model.get('d')?.ownerId).toBe('p');
    expect(model.get('f')?.ownerId).toBe('d');
    expect(model.get('u1'), 'the owning membership is consumed').toBeUndefined();
    expect(model.get('u2'), 'the feature membership is consumed').toBeUndefined();
    expect(model.get('a')?.ownerId).toBe('q');
    expect(model.rootIds()).toEqual(['p', 'q']);
    expect(model.size).toBe(5);
  });

  it("'model-json' round-trips an empty model", () => {
    const empty = new Model();
    const { model } = importModel(exportModel(empty, 'model-json'), 'model-json');
    expect(model.size).toBe(0);
  });
});

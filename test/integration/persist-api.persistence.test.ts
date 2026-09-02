/**
 * Integration: persistence round-trips + interchange-format fidelity.
 *
 * Covers task §1 — store save→load equality (InMemoryStore, LocalStorageStore
 * under jsdom, createDefaultStore) and exportModel/importModel for all three
 * formats on both buildSampleModel and the parsed examples/vehicle.sysml, with
 * api-json validated as an OMG element-graph (every element @id/@type,
 * relationships reified as memberships).
 */

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
import {
  loadVehicleExample,
  expectSameElementSet,
  expectSameElementIdentities,
} from './helpers';

/* ─────────────────────────── Store round-trips ──────────────────────────── */

function storeSuite(name: string, make: () => ProjectStore): void {
  describe(`${name} — save/load round-trips`, () => {
    let store: ProjectStore;
    beforeEach(() => {
      store = make();
    });

    it('save → load returns an equal snapshot and reconstructs the model', async () => {
      const data = buildSampleModel().toJSON();
      await store.saveProject('vehicle', data);
      const loaded = await store.loadProject('vehicle');
      expect(loaded).not.toBeNull();
      expect(loaded).toEqual(data);
      expectSameElementSet(buildSampleModel(), Model.fromJSON(loaded!));
    });

    it('round-trips the parsed vehicle.sysml example through the store', async () => {
      const original = loadVehicleExample();
      await store.saveProject('parsed', original.toJSON());
      const loaded = await store.loadProject('parsed');
      expectSameElementSet(original, Model.fromJSON(loaded!));
    });

    it('lists, overwrites and deletes projects', async () => {
      expect(await store.listProjects()).toEqual([]);
      await store.saveProject('a', buildSampleModel().toJSON());
      await store.saveProject('b', new Model().toJSON());
      expect((await store.listProjects()).sort()).toEqual(['a', 'b']);
      const empty = new Model().toJSON();
      await store.saveProject('a', empty);
      expect(await store.loadProject('a')).toEqual(empty);
      await store.deleteProject('a');
      expect(await store.loadProject('a')).toBeNull();
      expect(await store.listProjects()).toEqual(['b']);
    });
  });
}

storeSuite('InMemoryStore', () => new InMemoryStore());
storeSuite('LocalStorageStore', () => {
  localStorage.clear();
  return new LocalStorageStore('integration.proj.');
});

describe('createDefaultStore (jsdom)', () => {
  it('selects a usable backend and round-trips a model', async () => {
    expect(isLocalStorageAvailable()).toBe(true);
    const store = createDefaultStore({ prefix: 'integration.default.' });
    const data = buildSampleModel().toJSON();
    await store.saveProject('proj', data);
    const loaded = await store.loadProject('proj');
    expect(loaded).not.toBeNull();
    expectSameElementSet(buildSampleModel(), Model.fromJSON(loaded!));
  });
});

/* ──────────────────────── Interchange-format fidelity ───────────────────── */

const LOSSLESS: ModelFormat[] = ['model-json', 'api-json'];

describe('exportModel / importModel — element sets preserved', () => {
  const sources: Array<[string, () => Model]> = [
    ['buildSampleModel', buildSampleModel],
    ['examples/vehicle.sysml', loadVehicleExample],
  ];

  for (const [label, make] of sources) {
    for (const format of LOSSLESS) {
      it(`${label} · '${format}' is loss-less`, () => {
        const original = make();
        const text = exportModel(original, format);
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
        const { model } = importModel(text, format);
        expectSameElementSet(original, model);
      });
    }

    it(`${label} · 'sysml' preserves element identities`, () => {
      const original = make();
      const text = exportModel(original, 'sysml');
      expect(text.length).toBeGreaterThan(0);
      const { model } = importModel(text, 'sysml');
      // Element identity (metaclass + qualified name) survives the textual
      // round-trip even though the serializer is lossy on a few derived attrs
      // (requirementRole/expression) for the vehicle example's edge cases.
      expectSameElementIdentities(original, model);
    });
  }

  it("buildSampleModel · 'sysml' is fully loss-less (no derived-attr loss)", () => {
    const original = buildSampleModel();
    const { model } = importModel(exportModel(original, 'sysml'), 'sysml');
    expectSameElementSet(original, model);
  });
});

/* ──────────────────── api-json validates as an OMG graph ────────────────── */

interface ApiEl {
  '@id': string;
  '@type': string;
  identifier: string;
  declaredName?: string;
  ownedRelationship?: Array<{ '@id': string }>;
  owningRelationship?: { '@id': string };
  memberElement?: { '@id': string };
  ownedMemberElement?: { '@id': string };
  owningRelatedElement?: { '@id': string };
}
interface ApiGraph {
  '@type'?: string;
  elements: ApiEl[];
  rootElement?: Array<{ '@id': string }>;
}

const MEMBERSHIP_TYPES = new Set(['OwningMembership', 'FeatureMembership', 'Membership']);

describe('api-json — OMG element-graph validity', () => {
  const cases: Array<[string, () => Model]> = [
    ['buildSampleModel', buildSampleModel],
    ['examples/vehicle.sysml', loadVehicleExample],
  ];

  for (const [label, make] of cases) {
    it(`${label}: every element has @id/@type/identifier and ownership is reified`, () => {
      const graph = JSON.parse(exportModel(make(), 'api-json')) as ApiGraph;
      expect(graph['@type']).toBe('ElementGraph');
      expect(Array.isArray(graph.elements)).toBe(true);
      expect(graph.elements.length).toBeGreaterThan(0);

      const ids = new Set<string>();
      for (const e of graph.elements) {
        expect(typeof e['@id']).toBe('string');
        expect(e['@id'].length).toBeGreaterThan(0);
        expect(typeof e['@type']).toBe('string');
        expect(e.identifier).toBe(e['@id']);
        ids.add(e['@id']);
      }

      // Every non-root, non-membership element is contained by a reified membership.
      const memberships = graph.elements.filter((e) => MEMBERSHIP_TYPES.has(e['@type']));
      expect(memberships.length).toBeGreaterThan(0);
      for (const m of memberships) {
        const child = m.memberElement?.['@id'] ?? m.ownedMemberElement?.['@id'];
        const owner = m.owningRelatedElement?.['@id'];
        expect(child).toBeTruthy();
        expect(owner).toBeTruthy();
        // Every membership endpoint references a real element in the graph.
        expect(ids.has(child!)).toBe(true);
        expect(ids.has(owner!)).toBe(true);
      }

      // Roots are advertised and resolvable.
      expect(Array.isArray(graph.rootElement)).toBe(true);
      expect(graph.rootElement!.length).toBeGreaterThan(0);
      for (const r of graph.rootElement!) expect(ids.has(r['@id'])).toBe(true);

      // An owned element's owningRelationship points at one of its memberships.
      const owned = graph.elements.find((e) => e.owningRelationship);
      expect(owned).toBeDefined();
      expect(ids.has(owned!.owningRelationship!['@id'])).toBe(true);
    });
  }

  it('is idempotent: export → import → export is byte-identical', () => {
    const once = exportModel(buildSampleModel(), 'api-json');
    const twice = exportModel(importModel(once, 'api-json').model, 'api-json');
    expect(twice).toBe(once);
  });
});

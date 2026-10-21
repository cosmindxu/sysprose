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

  /**
   * A load rebuilds each owner's children from the order the elements are listed
   * in, and `reparent` appends the element it moves to its new owner's children
   * without moving it in the order they were added: exported in that order, the
   * moved element came back where it had been added (review 2026-10-14 D-2).
   */
  for (const format of FORMATS) {
    it(`'${format}' export → import after a reparent keeps each owner's children in order`, () => {
      const original = buildSampleModel();
      // The first owner with three children or more: its first child, dragged out and back in, is now its last.
      const owner = original.all().find((e) => original.children(e.id).filter((c) => c.declaredName).length >= 3)!;
      const first = original.children(owner.id).find((c) => c.declaredName)!;
      original.reparent(first.id, null);
      original.reparent(first.id, owner.id);
      const order = (m: Model) =>
        m
          .all()
          .filter((e) => e.declaredName && m.children(e.id).some((c) => c.declaredName))
          .map((e) => `${m.qualifiedName(e.id)}: ${m.children(e.id).map((c) => c.declaredName).filter(Boolean).join(',')}`)
          .sort();
      expect(order(original).find((l) => l.startsWith(`${original.qualifiedName(owner.id)}:`))).toMatch(new RegExp(`,${first.declaredName}$`));
      const { model } = importModel(exportModel(original, format), format);
      expect(order(model)).toEqual(order(original));
    });
  }

  /**
   * The parser reparents too, while it loads: it puts a feature's
   * specialisations back in the order they were declared in, and moves a
   * relationship statement onto the element it names. Saved in the order the
   * elements were added, such a model came back with those children reordered,
   * and the Text view rewrote itself on Save then reopen and on every Undo
   * (the S2 review of D-2: 1 of the 637 models of the verdict corpus, and the
   * L5 campaign fixture).
   */
  it.each([
    [
      'a redefinition declared before its typing',
      ['package S1 {', '    part def P;', '    part def Sub :> P;', '    part def Q {', '        part p : P;', '    }', '    part q : Q {', '        part :>> p : Sub;', '    }', '}', ''],
      'part :>> p : Sub;',
    ],
    [
      'a subsetting statement written onto the part it names',
      ['package Q {', '    part def W;', '}', 'package P {', '    import Q::*;', '    part a;', '    subset b subsets a;', '    part b : W;', '}', ''],
      'part b : W :> a;',
    ],
  ])('a model the parser reordered (%s) keeps its text through Save then reopen and an Undo', (_what, lines, line) => {
    const { model, diagnostics } = parseModel(lines.join('\n'));
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const text = exportModel(model, 'sysml');
    expect(text).toContain(line);
    expect(exportModel(Model.fromJSON(JSON.parse(JSON.stringify(model.toJSON()))), 'sysml'), 'Save, then reopen').toBe(text);
    const restored = Model.fromJSON(model.toJSON());
    restored.resetPreserving(model.toJSONWhere((el) => el.attrs.isLibrary !== true), (el) => el.attrs.isLibrary === true);
    expect(exportModel(restored, 'sysml'), 'Undo').toBe(text);
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

  /**
   * Another tool owns a member through a subtype of `OwningMembership`
   * (`ParameterMembership`, `ReturnParameterMembership`, `EndFeatureMembership`,
   * `ResultExpressionMembership`, ...): that membership is the member's
   * containment, not an element of the model, and the member sits in its owner.
   */
  it("'api-json' reads the subtypes of OwningMembership as containment", () => {
    const ref = (id: string): { '@id': string } => ({ '@id': id });
    const subtypes = [
      'ParameterMembership',
      'ReturnParameterMembership',
      'EndFeatureMembership',
      'ResultExpressionMembership',
      'ObjectiveMembership',
    ];
    const own = (type: string, id: string, member: string, owner: string): Record<string, unknown> => ({
      '@id': id,
      '@type': type,
      identifier: id,
      memberElement: ref(member),
      ownedMemberElement: ref(member),
      owningRelatedElement: ref(owner),
    });
    const graph = {
      elements: [
        { '@id': 'd', '@type': 'ActionDefinition', identifier: 'd', declaredName: 'D' },
        ...subtypes.flatMap((t, i) => [
          own(t, `m${i}`, `f${i}`, 'd'),
          { '@id': `f${i}`, '@type': 'PartUsage', identifier: `f${i}`, declaredName: `f${i}` },
        ]),
        { '@id': 'a', '@type': 'Membership', identifier: 'a', memberElement: ref('f0'), owningRelatedElement: ref('d') },
        // A FeatureValue is a subtype of OwningMembership too, but carries a meaning of its
        // own: it stays an element (the export never writes one), its value unowned by it.
        { '@id': 'fv', '@type': 'FeatureValue', identifier: 'fv', memberElement: ref('f0'), owningRelatedElement: ref('d') },
      ],
    };
    const { model } = importModel(JSON.stringify(graph), 'api-json');
    subtypes.forEach((_, i) => {
      expect(model.get(`f${i}`)?.ownerId, `f${i} sits in d`).toBe('d');
      expect(model.get(`m${i}`), `m${i} is consumed`).toBeUndefined();
    });
    expect(model.rootIds()).toEqual(['d']);
    expect(model.get('a')?.ownerId, 'the alias stays an element of d').toBe('d');
    expect(model.get('fv')?.ownerId, 'a FeatureValue stays an element of d').toBe('d');
    expect(model.size).toBe(1 + subtypes.length + 2);
  });

  it("'model-json' round-trips an empty model", () => {
    const empty = new Model();
    const { model } = importModel(exportModel(empty, 'model-json'), 'model-json');
    expect(model.size).toBe(0);
  });
});

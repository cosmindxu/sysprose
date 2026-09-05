import { describe, it, expect } from 'vitest';
import { Model, type ElementRecord } from '@core/index';
// This suite exercises the CURATED library builder (the small hand-authored
// subset used as the fallback and for focused structural assertions). The
// default `loadStandardLibrary` now prefers the FULL bundled library, which the
// separate full-library.* integration tests cover.
import {
  buildCuratedLibrary as loadStandardLibrary,
  findLibraryType,
  CURATED_LIBRARY_PACKAGE_NAMES as STANDARD_LIBRARY_PACKAGES,
} from '../../src/library/index';

/** Load a fresh model with the curated standard library. */
function freshLibraryModel(): { model: Model; ids: string[] } {
  const model = new Model();
  const ids = loadStandardLibrary(model);
  return { model, ids };
}

/** Walk the specialization targets (typesOf) upward, following the first parent. */
function chainNames(model: Model, startId: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur: ElementRecord | undefined = model.get(startId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.push(cur.declaredName ?? '');
    // Follow the numeric/base single-parent chain.
    const parents = model.typesOf(cur.id);
    cur = parents[0];
  }
  return names;
}

describe('standard library — loading & structure', () => {
  it('loads into a fresh Model without throwing and returns created ids', () => {
    const { model, ids } = freshLibraryModel();
    expect(ids.length).toBeGreaterThan(0);
    // Sanity: authored count is substantial (60–120 element brief).
    expect(model.size).toBeGreaterThanOrEqual(60);
  });

  it('creates a LibraryPackage root per authored package', () => {
    const { model } = freshLibraryModel();
    for (const name of STANDARD_LIBRARY_PACKAGES) {
      const pkg = model.roots().find((r) => r.declaredName === name);
      expect(pkg, `package ${name}`).toBeDefined();
      expect(pkg!.eClass).toBe('LibraryPackage');
    }
    expect(STANDARD_LIBRARY_PACKAGES).toEqual(
      expect.arrayContaining(['Base', 'ScalarValues', 'Collections', 'Quantities', 'ISQ', 'SI']),
    );
  });

  it('places key elements at the right qualified names', () => {
    const { model } = freshLibraryModel();
    const real = model.resolveQualifiedName('ScalarValues::Real');
    expect(real).toBeDefined();
    expect(model.qualifiedName(real!.id)).toBe('ScalarValues::Real');
    expect(model.qualifiedName(model.resolveQualifiedName('Base::Anything')!.id)).toBe(
      'Base::Anything',
    );
    expect(model.qualifiedName(model.resolveQualifiedName('Collections::OrderedSet')!.id)).toBe(
      'Collections::OrderedSet',
    );
    expect(model.qualifiedName(model.resolveQualifiedName('ISQ::MassValue')!.id)).toBe(
      'ISQ::MassValue',
    );
  });

  it('has the correct numeric specialization chain Integer → Rational → Real → …', () => {
    const { model } = freshLibraryModel();
    const integer = model.resolveQualifiedName('ScalarValues::Integer')!;
    const chain = chainNames(model, integer.id);
    // Integer :> Rational :> Real :> Complex :> Number :> NumericalValue :> ScalarValue :> DataValue :> Anything
    expect(chain).toEqual([
      'Integer',
      'Rational',
      'Real',
      'Complex',
      'Number',
      'NumericalValue',
      'ScalarValue',
      'DataValue',
      'Anything',
    ]);
  });

  it('wires individual specialization edges via typesOf', () => {
    const { model } = freshLibraryModel();
    const parentName = (q: string): string =>
      model.typesOf(model.resolveQualifiedName(q)!.id)[0]?.declaredName ?? '';
    expect(parentName('ScalarValues::Natural')).toBe('Integer');
    expect(parentName('ScalarValues::Positive')).toBe('Natural');
    expect(parentName('ScalarValues::Boolean')).toBe('ScalarValue');
    expect(parentName('Collections::Array')).toBe('OrderedCollection');
    expect(parentName('Collections::Set')).toBe('UniqueCollection');
  });

  it('OrderedSet specialises BOTH OrderedCollection and UniqueCollection', () => {
    const { model } = freshLibraryModel();
    const os = model.resolveQualifiedName('Collections::OrderedSet')!;
    const parents = model.typesOf(os.id).map((p) => p.declaredName).sort();
    expect(parents).toEqual(['OrderedCollection', 'UniqueCollection']);
  });

  it('bridges Quantities into ScalarValues and Collections', () => {
    const { model } = freshLibraryModel();
    const sqv = model.resolveQualifiedName('Quantities::ScalarQuantityValue')!;
    const parents = model.typesOf(sqv.id).map((p) => p.declaredName).sort();
    expect(parents).toEqual(['NumericalValue', 'VectorQuantityValue']);
    // ISQ quantity kinds bottom out at ScalarQuantityValue.
    const mass = model.resolveQualifiedName('ISQ::MassValue')!;
    expect(model.typesOf(mass.id)[0]?.declaredName).toBe('ScalarQuantityValue');
  });

  it('models concrete SI units as typed AttributeUsages with symbol short names', () => {
    const { model } = freshLibraryModel();
    const metre = model.resolveQualifiedName('SI::metre')!;
    expect(metre.eClass).toBe('AttributeUsage');
    expect(metre.declaredShortName).toBe('m');
    // FeatureTyping to its unit definition.
    expect(model.typesOf(metre.id)[0]?.declaredName).toBe('LengthUnit');
    const kg = model.resolveQualifiedName('SI::kilogram')!;
    expect(kg.declaredShortName).toBe('kg');
    expect(model.typesOf(kg.id)[0]?.declaredName).toBe('MassUnit');
  });

  it('marks EVERY created element (incl. relationships) with attrs.isLibrary === true', () => {
    const { model, ids } = freshLibraryModel();
    for (const id of ids) {
      expect(model.get(id)!.attrs.isLibrary, `isLibrary on ${id}`).toBe(true);
    }
    // And nothing outside the returned set exists in this fresh model.
    expect(model.all().every((el) => el.attrs.isLibrary === true)).toBe(true);
  });

  it('resolves findLibraryType by simple and qualified name', () => {
    const { model } = freshLibraryModel();
    const bySimple = findLibraryType(model, 'Real');
    const byQualified = findLibraryType(model, 'ScalarValues::Real');
    expect(bySimple).toBeDefined();
    expect(byQualified).toBeDefined();
    expect(bySimple!.id).toBe(byQualified!.id);
    expect(model.qualifiedName(byQualified!.id)).toBe('ScalarValues::Real');
  });

  it('findLibraryType matches short names and returns undefined for unknowns', () => {
    const { model } = freshLibraryModel();
    expect(findLibraryType(model, 'SI::metre')!.declaredName).toBe('metre');
    expect(findLibraryType(model, 'm')!.declaredName).toBe('metre'); // symbol short name
    expect(findLibraryType(model, 'NoSuchType')).toBeUndefined();
    expect(findLibraryType(model, '')).toBeUndefined();
  });

  it('respects the packages option (partial load)', () => {
    const model = new Model();
    const ids = loadStandardLibrary(model, { packages: ['Base', 'ScalarValues'] });
    expect(ids.length).toBeGreaterThan(0);
    expect(model.roots().map((r) => r.declaredName).sort()).toEqual(['Base', 'ScalarValues']);
    // Real still resolves and its chain reaches Anything within the loaded set.
    const real = model.resolveQualifiedName('ScalarValues::Real')!;
    expect(chainNames(model, real.id)).toContain('Anything');
    // Cross-package refs to unloaded packages are skipped silently (no dangling rels).
    expect(model.relationships().every((r) => (r.target ?? []).every((t) => model.has(t)))).toBe(
      true,
    );
    // ISQ was not requested — by strict path AND by bare name, both of which
    // the curated load answers (`ISQ::TimeValue` above). Not `ISQ::MassValue`:
    // `findLibraryType` refuses a re-exported path on ANY load, so that
    // assertion holds on an empty model and tests nothing about this one.
    expect(findLibraryType(model, 'ISQ::TimeValue')).toBeUndefined();
    expect(findLibraryType(model, 'TimeValue')).toBeUndefined();
    const { model: full } = freshLibraryModel();
    expect(findLibraryType(full, 'ISQ::TimeValue')).toBeDefined();
    expect(findLibraryType(full, 'TimeValue')).toBeDefined();
  });

  it('records abstract markers and provenance notes faithfully', () => {
    const { model } = freshLibraryModel();
    expect(model.resolveQualifiedName('ScalarValues::NumericalValue')!.attrs.isAbstract).toBe(true);
    expect(model.resolveQualifiedName('ScalarValues::Real')!.attrs.isAbstract).toBeUndefined();
    // Adapted names carry a libNote flag.
    expect(typeof model.resolveQualifiedName('ISQ::TimeValue')!.attrs.libNote).toBe('string');
  });
});

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { loadStandardLibrary } from '../../src/library/index';
import {
  implicitBaseTypesOf,
  generalizationsWithImplicit,
  effectiveFeaturesWithLibrary,
  typeIntersectionConforms,
  featuringTypeOf,
} from '../../src/semantics/index';

function libModel(): { m: Model; f: ModelFactory } {
  const m = new Model();
  loadStandardLibrary(m);
  return { m, f: new ModelFactory(m) };
}

describe('semantics — implicit library specialization', () => {
  it('implicitBaseTypesOf resolves a PartUsage to the library Parts::Part', () => {
    const { m, f } = libModel();
    const pkg = f.pkg('P');
    const p = f.part('myPart', pkg.id);
    const bases = implicitBaseTypesOf(m, p.id);
    expect(bases.length).toBe(1);
    expect(bases[0].declaredName).toBe('Part');
    expect(bases[0].attrs.isLibrary).toBe(true);
    expect(m.qualifiedName(bases[0].id)).toBe('Parts::Part');
  });

  it('implicitBaseTypesOf resolves an ActionUsage to Actions::Action', () => {
    const { m, f } = libModel();
    const pkg = f.pkg('P');
    const a = f.action('act', pkg.id);
    const bases = implicitBaseTypesOf(m, a.id);
    expect(bases.map((b) => b.declaredName)).toEqual(['Action']);
  });

  it('a library element has NO implicit base (its bases are all explicit)', () => {
    const { m } = libModel();
    const part = m.resolveQualifiedName('Parts::Part')!;
    expect(implicitBaseTypesOf(m, part.id)).toEqual([]);
  });

  it('a metaclass without an implicit base (Package) yields none', () => {
    const { m, f } = libModel();
    const pkg = f.pkg('P');
    expect(implicitBaseTypesOf(m, pkg.id)).toEqual([]);
  });

  it('generalizationsWithImplicit adds the library base chain above explicit generals', () => {
    const { m, f } = libModel();
    const pkg = f.pkg('P');
    const base = f.partDef('Vehicle', pkg.id);
    const car = f.partDef('Car', pkg.id);
    f.subclassification(car.id, base.id);

    const names = generalizationsWithImplicit(m, car.id).map((g) => g.declaredName);
    // explicit user general …
    expect(names).toContain('Vehicle');
    // … PLUS the implicit library tower Part ▸ Item ▸ Object ▸ Occurrence ▸ Anything.
    expect(names).toContain('Part');
    expect(names).toContain('Item');
    expect(names).toContain('Anything');
    // The user general also drags in its own implicit base transitively.
    expect(names.filter((n) => n === 'Part').length).toBe(1); // no duplicates
  });

  it('effectiveFeaturesWithLibrary includes a feature inherited from the library base', () => {
    const { m, f } = libModel();
    const pkg = f.pkg('P');
    const p = f.part('myPart', pkg.id);

    const own = effectiveFeaturesWithLibrary(m, p.id);
    const names = own.map((e) => e.declaredName);
    // Parts::Part owns Usages such as `self`, `ownedPorts`, `ownedActions` — at
    // least one library-inherited feature must appear.
    const libInherited = own.filter((e) => e.attrs.isLibrary === true);
    expect(libInherited.length).toBeGreaterThanOrEqual(1);
    expect(names).toContain('self');
  });

  it('effectiveFeaturesWithLibrary keeps the element own features first', () => {
    const { m, f } = libModel();
    const pkg = f.pkg('P');
    const p = f.part('myPart', pkg.id);
    f.attribute('mass', p.id, { type: 'Real', value: 10 });

    const feats = effectiveFeaturesWithLibrary(m, p.id);
    expect(feats[0].declaredName).toBe('mass');
    expect(feats[0].attrs.isLibrary).not.toBe(true);
  });
});

describe('semantics — type intersection conformance & featuring', () => {
  it('a feature typed by several types conforms to their intersection', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const a = f.partDef('A');
    const b = f.partDef('B');
    f.subclassification(b.id, a.id); // B :> A
    const feat = f.partDef('F');
    f.featureTyping(feat.id, a.id);
    f.featureTyping(feat.id, b.id);

    // F is typed by both A and B → conforms to the {A,B} intersection.
    expect(typeIntersectionConforms(m, feat.id, [a.id, b.id])).toBe(true);
    // Vacuously true for the empty intersection.
    expect(typeIntersectionConforms(m, feat.id, [])).toBe(true);
  });

  it('intersection conformance fails when one required type is not conformed to', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const a = f.partDef('A');
    const b = f.partDef('B');
    const c = f.partDef('C'); // unrelated
    const feat = f.partDef('F');
    f.featureTyping(feat.id, a.id);
    f.featureTyping(feat.id, b.id);

    expect(typeIntersectionConforms(m, feat.id, [a.id])).toBe(true);
    expect(typeIntersectionConforms(m, feat.id, [a.id, c.id])).toBe(false);
  });

  it('featuringTypeOf returns the owning type of a feature', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const def = f.partDef('Engine');
    const attr = f.attribute('power', def.id, { type: 'Real', value: 100 });
    const ft = featuringTypeOf(m, attr.id);
    expect(ft?.id).toBe(def.id);
    expect(ft?.declaredName).toBe('Engine');
  });

  it('featuringTypeOf is undefined for a root feature (no owning type)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const root = f.partDef('Root'); // owner is null
    expect(featuringTypeOf(m, root.id)).toBeUndefined();
  });
});

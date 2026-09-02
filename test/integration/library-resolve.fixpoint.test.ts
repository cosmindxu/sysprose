/**
 * Type-reference binding: composition of the two resolvers, import targets,
 * and the fixpoint the binder must reach.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseModel } from '@text/index';
import { preloadFullLibrary, loadFullStandardLibrary } from '../../src/library/full-library';
import { resolveTypeReferences, resolveImportTargets } from '../../src/library/resolve';
import type { Model } from '@core/index';

function typeNamesOf(model: Model, name: string): string[] {
  const el = model.all().find((e) => e.declaredName === name)!;
  return model
    .all()
    .filter((r) => r.eClass === 'FeatureTyping' && (r.source ?? [])[0] === el.id)
    .map((r) => model.qualifiedName((r.target ?? [])[0]));
}

async function bind(src: string): Promise<Model> {
  const { model } = parseModel(src);
  await preloadFullLibrary();
  loadFullStandardLibrary(model);
  resolveTypeReferences(model);
  return model;
}

describe('binder — composition, imports, fixpoint', () => {
  beforeAll(async () => {
    await preloadFullLibrary();
  });

  it('reaches a fixpoint: a nested reference that needs an earlier binding', async () => {
    // `w : Wheel` is inside `c`, and Wheel is declared inside Car. `w` can only
    // resolve once `c` is typed by Car — a pure single pass never sees it.
    const m = await bind(
      'package P { part c : Car { part w : Wheel; } part def Car { part def Wheel; } }',
    );
    expect(typeNamesOf(m, 'c')).toEqual(['P::Car']);
    expect(typeNamesOf(m, 'w')).toEqual(['P::Car::Wheel']);
  });

  it('resolves through an in-file import once the import has a target', async () => {
    const m = await bind('package Use { import Lib::*; part w : Widget; } package Lib { part def Widget; }');
    expect(typeNamesOf(m, 'w')).toEqual(['Lib::Widget']);
  });

  it('resolves a nested type through inheritance', async () => {
    const m = await bind(
      'package P { part def Base { part def Inner; } part def Derived :> Base { part i : Inner; } }',
    );
    expect(typeNamesOf(m, 'i')).toEqual(['P::Base::Inner']);
  });

  it('binds a library import written in text to the library package', async () => {
    // Attribute VALUE types stay a display string by design (the pinned
    // "silent attribute type" decision), so the observable effect of
    // `import ISQ::*;` in text is that the import element itself gains a
    // target — it used to have none, making it a no-op for every walk.
    const m = await bind('package P { import ISQ::*; part def Payload { part q : Part; } }');
    const imp = m.all().find((e) => e.eClass === 'NamespaceImport')!;
    expect(imp.target?.length).toBe(1);
    expect(m.qualifiedName((imp.target ?? [])[0])).toBe('ISQ');
    expect(imp.source).toEqual([imp.ownerId]);
  });

  it('still lets a user declaration shadow a library name, in either order', async () => {
    const m = await bind('package P { part i : Item; part def Item; part j : Item; }');
    expect(typeNamesOf(m, 'i')).toEqual(['P::Item']);
    expect(typeNamesOf(m, 'j')).toEqual(['P::Item']);
  });

  it('is idempotent: a second pass binds nothing new', async () => {
    const m = await bind('package Use { import Lib::*; part w : Widget; } package Lib { part def Widget; }');
    const before = m.size;
    expect(resolveTypeReferences(m)).toBe(0);
    expect(resolveImportTargets(m)).toBe(0);
    expect(m.size).toBe(before);
  });
});

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { generalizationsOf, effectiveFeatures, ownFeatures } from '../../src/semantics/index';

describe('semantics — inheritance', () => {
  it('partDef B specializing A inherits A\'s features', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const a = f.partDef('A');
    f.attribute('a1', a.id, { type: 'Real', value: 10 });
    f.attribute('shared', a.id, { type: 'Real', value: 1 });
    const b = f.partDef('B');
    f.attribute('b1', b.id, { type: 'Real', value: 20 });
    f.subclassification(b.id, a.id);

    const names = effectiveFeatures(m, b.id).map((e) => e.declaredName);
    // own first, then inherited
    expect(names).toEqual(['b1', 'a1', 'shared']);
    // ownFeatures excludes inherited
    expect(ownFeatures(m, b.id).map((e) => e.declaredName)).toEqual(['b1']);
  });

  it('collects direct + transitive generalizations, cycle-safe', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const a = f.partDef('A');
    const b = f.partDef('B');
    const c = f.partDef('C');
    f.subclassification(c.id, b.id);
    f.subclassification(b.id, a.id);
    const gens = generalizationsOf(m, c.id).map((e) => e.declaredName);
    expect(gens).toEqual(['B', 'A']);
    // A has no generals
    expect(generalizationsOf(m, a.id)).toEqual([]);
  });

  it('is cycle-safe when specializations form a loop', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const a = f.partDef('A');
    const b = f.partDef('B');
    f.subclassification(a.id, b.id);
    f.subclassification(b.id, a.id); // cycle
    const gens = generalizationsOf(m, a.id).map((e) => e.declaredName);
    // Terminates (no hang); the starting type is excluded from its own generals.
    expect(gens).toEqual(['B']);
    expect(new Set(gens).size).toBe(gens.length);
  });

  it('a redefinition in B replaces A\'s same-named feature', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const a = f.partDef('A');
    const massA = f.attribute('mass', a.id, { type: 'Real', value: 1000 });
    const b = f.partDef('B');
    const massB = f.attribute('mass', b.id, { type: 'Real', value: 2000 });
    f.subclassification(b.id, a.id);
    f.redefinition(massB.id, massA.id);

    const feats = effectiveFeatures(m, b.id);
    const massFeats = feats.filter((e) => e.declaredName === 'mass');
    // Only ONE 'mass' survives, and it is B's redefining feature.
    expect(massFeats.length).toBe(1);
    expect(massFeats[0].id).toBe(massB.id);
    expect(massFeats[0].attrs.value).toBe(2000);
  });

  it('handles diamond inheritance without duplicating a shared feature', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const top = f.partDef('Top');
    f.attribute('t', top.id, { type: 'Real', value: 0 });
    const left = f.partDef('Left');
    const right = f.partDef('Right');
    f.subclassification(left.id, top.id);
    f.subclassification(right.id, top.id);
    const bottom = f.partDef('Bottom');
    f.subclassification(bottom.id, left.id);
    f.subclassification(bottom.id, right.id);
    const tCount = effectiveFeatures(m, bottom.id).filter((e) => e.declaredName === 't').length;
    expect(tCount).toBe(1);
  });
});

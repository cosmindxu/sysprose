import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import {
  generalizationsOf,
  effectiveFeatures,
  effectiveNameOf,
  effectiveQualifiedName,
  inheritedNameClashes,
  maskedByName,
  ownFeatures,
} from '../../src/semantics/index';
import { parseModel } from '../../src/text/index';

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

  // KerML: a redefined feature is not an inherited member, WHATEVER the
  // redefinition is called. Masking by declared name alone left P's `load`
  // in the effective set of `part p : P { attribute :>> load = 50.0; }`, and
  // every scope read the definition's value.
  it('masks a feature redefined by an UNNAMED redefinition, which is known by the name it redefines', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const load = f.attribute('load', p.id, { type: 'Real', value: 1 });
    const q = f.partDef('Q');
    f.subclassification(q.id, p.id);
    const redef = m.create('AttributeUsage', { ownerId: q.id, attrs: { value: 50 } });
    f.redefinition(redef.id, load.id);

    const feats = effectiveFeatures(m, q.id);
    expect(feats.map((e) => e.id)).toEqual([redef.id]);
    expect(effectiveNameOf(m, redef)).toBe('load');
    expect(effectiveNameOf(m, load)).toBe('load');
  });

  it('masks a feature redefined under another name, transitively', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const a = f.partDef('A');
    const load = f.attribute('load', a.id, { type: 'Real', value: 1 });
    const b = f.partDef('B');
    f.subclassification(b.id, a.id);
    const heavy = f.attribute('heavy', b.id, { type: 'Real', value: 50 });
    f.redefinition(heavy.id, load.id);
    const c = f.partDef('C');
    f.subclassification(c.id, b.id);
    const unnamed = m.create('AttributeUsage', { ownerId: c.id, attrs: { value: 60 } });
    f.redefinition(unnamed.id, heavy.id);

    expect(effectiveFeatures(m, b.id).map((e) => e.declaredName)).toEqual(['heavy']);
    expect(effectiveFeatures(m, c.id).map((e) => e.id)).toEqual([unnamed.id]);
    // The nearest named feature it redefines names it.
    expect(effectiveNameOf(m, unnamed)).toBe('heavy');
  });

  it('spells a qualified name by effective names, so two unnamed redefinitions are two names', () => {
    const { model } = parseModel(`package R {
      part def P { attribute a = 1.0; attribute b = 2.0; }
      part def Q { part p : P; }
      part q : Q { part :>> p { attribute :>> a = 10.0; attribute :>> b = 20.0; } }
    }`);
    const redefs = model.all().filter((e) => e.eClass === 'AttributeUsage' && e.declaredName === undefined);
    expect(redefs.map((e) => effectiveQualifiedName(model, e.id)).sort()).toEqual(['R::q::p::a', 'R::q::p::b']);
    // The raw qualified name spells both alike — one symbol to a solver.
    expect(new Set(redefs.map((e) => model.qualifiedName(e.id))).size).toBe(1);
    // A named element keeps its qualified name.
    const named = model.all().find((e) => e.declaredName === 'a' && model.qualifiedName(e.id) === 'R::P::a')!;
    expect(effectiveQualifiedName(model, named.id)).toBe('R::P::a');
  });

  // A feature ANY inherited feature redefines is not inherited, whichever
  // general the walk meets first: `part def C :> P, A` met P's `load` before
  // A's `:>> load = 5.0`, and read P's.
  it('drops a redefined feature whatever order the general types are written in', () => {
    const { model } = parseModel(`package O5 {
      part def P { attribute load default = 1.0; }
      part def A :> P { attribute :>> load = 5.0; }
      part def C :> P, A;
    }`);
    const c = model.all().find((e) => e.declaredName === 'C')!;
    const feats = effectiveFeatures(model, c.id);
    expect(feats.map((e) => e.attrs.value)).toEqual([5]);
  });

  it('names the features two general types contribute under one name, and the one a feature hides by name', () => {
    const { model } = parseModel(`package O3 {
      part def P { attribute load default = 1.0; }
      part def A :> P { attribute :>> load = 5.0; }
      part def B :> P { attribute :>> load = 7.0; }
      part def C :> A, B;
      part def D :> P { attribute load = 9.0; }
    }`);
    const byName = (n: string) => model.all().find((e) => e.declaredName === n)!;
    const clashes = inheritedNameClashes(model, byName('C').id);
    expect([...clashes.keys()]).toEqual(['load']);
    expect(clashes.get('load')!.map((f) => f.attrs.value)).toEqual([5, 7]);
    // D's own `load` masks P's by name alone: it overrides it, as a redefinition would.
    const own = model.all().find((e) => e.attrs.value === 9)!;
    expect(maskedByName(model, own).map((f) => model.qualifiedName(f.id))).toEqual(['O3::P::load']);
    expect(inheritedNameClashes(model, byName('D').id).size).toBe(0);
  });
});

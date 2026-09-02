import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { loadStandardLibrary } from '../../src/library/index';
import {
  resolveName,
  resolveQualifiedNameFull,
  unionOf,
  intersectionOf,
  differenceOf,
  featureChain,
  inverseOf,
} from '../../src/semantics/index';

/* ─────────────── KerML name resolution against the standard library ─────────── */

describe('semantics — resolveQualifiedNameFull over the standard library', () => {
  const m = new Model();
  loadStandardLibrary(m);

  it("resolves 'ISQ::MassValue' (definition owned by ISQBase, re-exposed via ISQ)", () => {
    const mv = resolveQualifiedNameFull(m, 'ISQ::MassValue');
    expect(mv).toBeDefined();
    expect(mv!.declaredName).toBe('MassValue');
    expect(mv!.attrs.isLibrary).toBe(true);
  });

  it('resolves strictly-owned library qualified names', () => {
    const real = resolveQualifiedNameFull(m, 'ScalarValues::Real');
    expect(real?.declaredName).toBe('Real');
    const part = resolveQualifiedNameFull(m, 'Parts::Part');
    expect(part?.declaredName).toBe('Part');
    expect(m.qualifiedName(part!.id)).toBe('Parts::Part');
  });

  it('resolveName finds a root library package in the global scope', () => {
    const isq = resolveName(m, null, 'ISQ');
    expect(isq?.declaredName).toBe('ISQ');
    expect(isq?.eClass).toBe('LibraryPackage');
  });

  it('resolveName finds an owned member of a resolved library package', () => {
    const isq = resolveName(m, null, 'ISQ')!;
    const owned = resolveName(m, isq.id, 'TemperatureDifferenceValue');
    expect(owned?.declaredName).toBe('TemperatureDifferenceValue');
  });

  it('returns undefined for a name that does not exist', () => {
    expect(resolveQualifiedNameFull(m, 'ISQ::NoSuchThing')).toBeUndefined();
    expect(resolveName(m, null, 'DefinitelyNotAPackage')).toBeUndefined();
  });
});

/* ───────────────── KerML name resolution over a user model (imports) ────────── */

describe('semantics — KerML scoping (owned / inherited / imported / aliased)', () => {
  it('resolves an OWNED member (including private) but hides private across imports', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const secret = f.pkg('Secret');
    const pub = f.partDef('PublicA', secret.id);
    const priv = m.create('PartDefinition', {
      declaredName: 'PrivateB',
      ownerId: secret.id,
      attrs: { visibility: 'private' },
    });

    // Owned resolution sees both public and private members.
    expect(resolveName(m, secret.id, 'PublicA')?.id).toBe(pub.id);
    expect(resolveName(m, secret.id, 'PrivateB')?.id).toBe(priv.id);

    // Importing the package only exposes its PUBLIC members.
    const user = f.pkg('User');
    m.create('NamespaceImport', { ownerId: user.id, source: [user.id], target: [secret.id] });
    expect(resolveName(m, user.id, 'PublicA')?.id).toBe(pub.id);
    expect(resolveName(m, user.id, 'PrivateB')).toBeUndefined();
  });

  it('resolves an INHERITED member through a subclassification general', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const lib = f.pkg('Lib');
    const a = f.partDef('A', lib.id);
    const x = f.attribute('x', a.id, { type: 'Real' });
    const b = f.partDef('B', lib.id);
    f.subclassification(b.id, a.id); // B :> A

    // `x` is not owned by B, but inherited from its general A.
    expect(resolveName(m, b.id, 'x')?.id).toBe(x.id);
    expect(resolveName(m, a.id, 'x')?.id).toBe(x.id);
  });

  it('resolves an IMPORTED member via a NamespaceImport (::*)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const lib = f.pkg('Lib');
    const a = f.partDef('A', lib.id);
    const app = f.pkg('App');
    m.create('NamespaceImport', { ownerId: app.id, source: [app.id], target: [lib.id] });

    expect(resolveName(m, app.id, 'A')?.id).toBe(a.id);
    // Not imported at all → not visible.
    expect(resolveName(m, app.id, 'Nope')).toBeUndefined();
  });

  it('a non-recursive import does NOT reach nested-namespace members; a recursive (::**) one does', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const outer = f.pkg('Outer');
    const inner = f.pkg('Inner', outer.id);
    const thing = f.partDef('Thing', inner.id);

    const client1 = f.pkg('Client1');
    m.create('NamespaceImport', {
      ownerId: client1.id,
      source: [client1.id],
      target: [outer.id],
      attrs: { isRecursive: false },
    });
    expect(resolveName(m, client1.id, 'Thing')).toBeUndefined();

    const client2 = f.pkg('Client2');
    m.create('NamespaceImport', {
      ownerId: client2.id,
      source: [client2.id],
      target: [outer.id],
      attrs: { isRecursive: true },
    });
    expect(resolveName(m, client2.id, 'Thing')?.id).toBe(thing.id);
  });

  it('resolves a re-exported member through a chain of public namespace imports', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const deep = f.pkg('Deep');
    const hidden = f.partDef('Hidden', deep.id);
    const mid = f.pkg('Mid');
    m.create('NamespaceImport', { ownerId: mid.id, source: [mid.id], target: [deep.id] });
    const app = f.pkg('App');
    m.create('NamespaceImport', { ownerId: app.id, source: [app.id], target: [mid.id] });

    // App imports Mid, which publicly imports Deep → Hidden is reachable.
    expect(resolveName(m, app.id, 'Hidden')?.id).toBe(hidden.id);
  });

  it('resolves a single element via a MembershipImport (only that member)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const src = f.pkg('Src');
    const x = f.partDef('X', src.id);
    f.partDef('Y', src.id);
    const dst = f.pkg('Dst');
    m.create('MembershipImport', { ownerId: dst.id, source: [dst.id], target: [x.id] });

    expect(resolveName(m, dst.id, 'X')?.id).toBe(x.id);
    expect(resolveName(m, dst.id, 'Y')).toBeUndefined();
  });

  it('resolves an ALIASED member (Membership carrying a memberName)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('AliasPkg');
    const real = f.partDef('Real1', pkg.id);
    m.create('Membership', { ownerId: pkg.id, target: [real.id], attrs: { memberName: 'Nick' } });

    expect(resolveName(m, pkg.id, 'Nick')?.id).toBe(real.id);
    expect(resolveName(m, pkg.id, 'Real1')?.id).toBe(real.id); // original name still works
  });

  it('resolveName accepts a qualified name and walks it from the given scope', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const lib = f.pkg('Lib');
    const a = f.partDef('A', lib.id);
    const x = f.attribute('x', a.id, { type: 'Real' });
    expect(resolveName(m, null, 'Lib::A')?.id).toBe(a.id);
    expect(resolveName(m, null, 'Lib::A::x')?.id).toBe(x.id);
  });
});

/* ─────────────────────── type operators, chaining & inverse ─────────────────── */

describe('semantics — type operators (union / intersection / difference)', () => {
  function chainModel(): { m: Model; A: string; B: string; C: string } {
    const m = new Model();
    const f = new ModelFactory(m);
    const a = f.partDef('A');
    const b = f.partDef('B');
    const c = f.partDef('C');
    f.subclassification(b.id, a.id); // B :> A
    f.subclassification(c.id, b.id); // C :> B
    return { m, A: a.id, B: b.id, C: c.id };
  }

  it('unionOf is the combined reflexive generalization closure of the operands', () => {
    const { m, A, B } = chainModel();
    const names = unionOf(m, [A, B]).map((r) => r.declaredName).sort();
    expect(names).toEqual(['A', 'B']);
    // No duplicates even though A appears in B\'s closure too.
    expect(unionOf(m, [A, B]).filter((r) => r.declaredName === 'A')).toHaveLength(1);
  });

  it('intersectionOf is the common generalizations of every operand', () => {
    const { m, A, B, C } = chainModel();
    // Common general of B and C is {B, A}.
    expect(intersectionOf(m, [B, C]).map((r) => r.declaredName).sort()).toEqual(['A', 'B']);
    // Common general of A and C is just {A}.
    expect(intersectionOf(m, [A, C]).map((r) => r.declaredName)).toEqual(['A']);
    expect(intersectionOf(m, [])).toEqual([]);
  });

  it('differenceOf subtracts the other operands\' closures from the first', () => {
    const { m, A, B, C } = chainModel();
    // closure(C)=[C,B,A] minus closure(A)=[A] → [C,B].
    expect(differenceOf(m, [C, A]).map((r) => r.declaredName)).toEqual(['C', 'B']);
    // closure(B)=[B,A] minus closure(C)=[C,B,A] → [].
    expect(differenceOf(m, [B, C])).toEqual([]);
    expect(differenceOf(m, [])).toEqual([]);
  });
});

describe('semantics — feature chaining & inverse', () => {
  it('featureChain resolves a well-formed a.b chain and stops at a broken link', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const wheel = f.partDef('Wheel');
    const diameter = f.attribute('diameter', wheel.id, { type: 'Real' });
    const car = f.partDef('Car');
    const wheelUsage = f.part('wheel', car.id, wheel.id); // wheel : Wheel

    // car.wheel.diameter — each step is featured by the previous step\'s type.
    const chain = featureChain(m, [wheelUsage.id, diameter.id]);
    expect(chain.map((r) => r.declaredName)).toEqual(['wheel', 'diameter']);

    // A broken chain (diameter is not a feature of Wheel\'s… of an attribute) is truncated.
    const unrelated = f.partDef('Unrelated');
    const broken = featureChain(m, [wheelUsage.id, unrelated.id]);
    expect(broken.map((r) => r.declaredName)).toEqual(['wheel']);
  });

  it('inverseOf returns the opposite end of a FeatureInverting relationship (symmetric)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const assoc = f.partDef('Assoc');
    const endA = f.part('endA', assoc.id);
    const endB = f.part('endB', assoc.id);
    m.create('FeatureInverting', { ownerId: endA.id, source: [endA.id], target: [endB.id] });

    expect(inverseOf(m, endA.id)?.id).toBe(endB.id);
    expect(inverseOf(m, endB.id)?.id).toBe(endA.id); // symmetric
    const lonely = f.part('lonely', assoc.id);
    expect(inverseOf(m, lonely.id)).toBeUndefined();
  });
});

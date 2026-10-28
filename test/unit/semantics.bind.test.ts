/**
 * `src/semantics/bind.ts` — THE reference resolver.
 *
 * Every case here goes through `parseModel` (i.e. `library: 'none'`): the point
 * of the module is that the answer does not depend on a library being loaded,
 * and a resolver tested only on hand-built models would not prove that the
 * mapper asks it the same questions the notation does.
 */
import { describe, it, expect } from 'vitest';
import { parseModel } from '@text/index';
import { resolveFullName, resolveRedefinedFeature, sharesLineWithSibling } from '../../src/semantics/bind';
import type { Model } from '@core/index';

/** Parse, then hand back the model plus a name→element lookup. */
function parsed(src: string): { model: Model; id: (name: string) => string } {
  const { model, diagnostics } = parseModel(src);
  expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return {
    model,
    id: (name: string) => {
      const el = model.all().find((e) => e.declaredName === name);
      if (!el) throw new Error(`no element named ${name}`);
      return el.id;
    },
  };
}

describe('resolveFullName — KerML §8.2.3.5.4 full resolution', () => {
  it('prefers an INHERITED member over one in an enclosing namespace', () => {
    const { model, id } = parsed(`package P {
      part def W;
      part def Base { part def W; }
      part def Car :> Base { part w1; }
    }`);
    expect(model.qualifiedName(resolveFullName(model, 'W', id('Car'))!.id)).toBe('P::Base::W');
    // From the package itself there is no inherited candidate, so the outer one
    // is the answer — the rule is per-namespace, not "always the supertype".
    expect(model.qualifiedName(resolveFullName(model, 'W', id('P'))!.id)).toBe('P::W');
  });

  it('walks OUTWARD, and a rejected candidate does not stop the walk', () => {
    const { model, id } = parsed(`package P {
      part def Widget;
      part x;
      part def Car { part def x; }
    }`);
    // `Widget` is not a member of Car; the walk finds it one scope out.
    expect(model.qualifiedName(resolveFullName(model, 'Widget', id('Car'))!.id)).toBe('P::Widget');
    // The name `x` matches in BOTH scopes. With an `accept` that rejects the
    // inner hit, the walk must carry on to the outer one — an implementation
    // that stopped at the first scope producing a match would answer undefined,
    // which is why the case needs a second, ACCEPTED candidate to be falsifiable.
    const outer = resolveFullName(model, 'x', id('Car'), {
      accept: (el) => el.eClass !== 'PartDefinition',
    });
    expect(model.qualifiedName(outer!.id)).toBe('P::x');
    // …and with nothing acceptable anywhere, the answer is still undefined.
    expect(
      resolveFullName(model, 'x', id('Car'), { accept: () => false }),
    ).toBeUndefined();
  });

  it('resolves through an import and through a qualified path', () => {
    const { model, id } = parsed(`package Lib { part def Widget { part def Cog; } }
    package Use { import Lib::*; part def W2; }`);
    expect(model.qualifiedName(resolveFullName(model, 'Widget', id('Use'))!.id)).toBe('Lib::Widget');
    // A qualified name walks the same rules segment by segment — and the
    // INTERMEDIATE segment is a package, which an `accept` for types would
    // reject if it were applied to anything but the final element.
    const cog = resolveFullName(model, 'Lib::Widget::Cog', id('Use'), {
      accept: (el) => el.eClass !== 'Package',
    });
    expect(model.qualifiedName(cog!.id)).toBe('Lib::Widget::Cog');
  });

  it('dereferences an alias rather than answering with the alias membership', () => {
    const { model, id } = parsed(`package P {
      part def Real2;
      alias A for Real2;
      part def V;
    }`);
    expect(model.qualifiedName(resolveFullName(model, 'A', id('V'))!.id)).toBe('P::Real2');
  });

  it('still reaches a named RELATIONSHIP element through the containment fallback', () => {
    // `flow f;` is not a Namespace member, so §8.2.3.5.4 cannot see it — but
    // `satisfy R by f;` names it, and that resolved before this module existed.
    const { model, id } = parsed(`package P { part a; part b; flow f from a to b; }`);
    expect(model.qualifiedName(resolveFullName(model, 'f', id('P'))!.id)).toBe('P::f');
  });

  it('never answers with the excluded element', () => {
    const { model, id } = parsed(`package P { part def Wheel; part Wheel; }`);
    const usage = model.all().find((e) => e.eClass === 'PartUsage' && e.declaredName === 'Wheel')!;
    expect(resolveFullName(model, 'Wheel', id('P'), { exclude: usage.id })!.eClass).toBe(
      'PartDefinition',
    );
  });

  it('does not see a PRIVATE member of a supertype', () => {
    const { model, id } = parsed(`package P {
      part def Base { private part def Secret; }
      part def Car :> Base { part c; }
    }`);
    expect(resolveFullName(model, 'Secret', id('Car'))).toBeUndefined();
  });
});

describe('resolveRedefinedFeature — KerML §8.2.3.5.1', () => {
  it('answers with the inherited feature, not the redefining one', () => {
    const { model, id } = parsed(`package P {
      part def Base { part w; }
      part def Car :> Base { part w :>> w; }
    }`);
    const car = id('Car');
    const w = model.children(car).find((c) => c.declaredName === 'w')!;
    expect(model.qualifiedName(resolveRedefinedFeature(model, 'w', w.id, car)!.id)).toBe(
      'P::Base::w',
    );
    // Ordinary resolution would answer with the redefining feature itself.
    expect(model.qualifiedName(resolveFullName(model, 'w', car)!.id)).toBe('P::Car::w');
  });

  it('prefers the generals of the owning type over an OUTER feature of that name', () => {
    const { model, id } = parsed(`package P {
      part w;
      part def Base { part w; }
      part def Car :> Base { part w2; }
    }`);
    const car = id('Car');
    const w2 = model.children(car).find((c) => c.declaredName === 'w2')!;
    expect(model.qualifiedName(resolveRedefinedFeature(model, 'w', w2.id, car)!.id)).toBe(
      'P::Base::w',
    );
  });

  it('finds a feature of the owning USAGE’s type (a FeatureTyping general)', () => {
    const { model, id } = parsed(`package P {
      part def Engine { part cyl; }
      part e : Engine { part c; }
    }`);
    const e = id('e');
    const c = model.children(e).find((x) => x.declaredName === 'c')!;
    expect(model.qualifiedName(resolveRedefinedFeature(model, 'cyl', c.id, e)!.id)).toBe(
      'P::Engine::cyl',
    );
  });

  // The name finds Q's declared `M`, but Q2's unnamed `attribute :>> M default = 2.0` redefines it: that one is
  // Q2's `M`, and a redefinition of Q's read Q's 1 in s on every surface (MI7). The rule is the end copy's (U10).
  it('lands on the MOST SPECIFIC feature the owning type inherits for the name', () => {
    const { model, id } = parsed(`package P {
      part def Q { attribute M default = 1.0; }
      part def Q2 :> Q { attribute :>> M default = 2.0; }
      part def Q3 :> Q2 { attribute :>> M default = 3.0; }
      part def Q4 :> Q3;
      part def R :> Q { attribute M2 redefines M default = 2.0; }
      part s : Q2 { attribute :>> M; }
      part s4 : Q4 { attribute :>> M; }
      part v : R { attribute :>> M; }
    }`);
    const own = (owner: string) => model.children(id(owner)).find((c) => c.eClass === 'AttributeUsage')!;
    const target = (owner: string) => resolveRedefinedFeature(model, 'M', own(owner).id, id(owner))!.id;
    expect(target('s')).toBe(own('Q2').id);
    // Through a general type that adds nothing, past Q3's redefinition of Q2's.
    expect(target('s4')).toBe(own('Q3').id);
    // A redefinition under another name is what an R has for M (every surface reads `r.M` as r's M2).
    expect(target('v')).toBe(id('M2'));
    // The mapper asked the same question: each usage's Redefinition holds the answer.
    const redefined = (owner: string) => model.children(own(owner).id).find((c) => c.eClass === 'Redefinition')!.target;
    expect(redefined('s')).toEqual([own('Q2').id]);
    expect(redefined('s4')).toEqual([own('Q3').id]);
    expect(redefined('v')).toEqual([id('M2')]);
  });

  it('keeps the named feature where no ONE feature is most specific, and a qualified name as written', () => {
    const { model, id } = parsed(`package P {
      part def Q { attribute L; }
      part def Q2 :> Q { attribute :>> L = 50.0; }
      part def Q3 :> Q { attribute :>> L = 60.0; }
      part q : Q2, Q3 { attribute :>> L; }
      part r : Q2 { attribute :>> Q::L; }
    }`);
    const own = (owner: string) => model.children(id(owner)).find((c) => c.eClass === 'AttributeUsage')!;
    // Q2's and Q3's each redefine Q's L and neither the other: neither is q's (MI3, the end copy's MI1).
    expect(model.qualifiedName(resolveRedefinedFeature(model, 'L', own('q').id, id('q'))!.id)).toBe('P::Q::L');
    expect(model.qualifiedName(resolveRedefinedFeature(model, 'Q::L', own('r').id, id('r'))!.id)).toBe('P::Q::L');
  });

  // Taking the most specific feature must not make two of one usage's features one (MU, CL in the four-surface
  // table): each keeps the feature its name finds, whichever of the two is written first.
  it('keeps the named feature where the most specific one would make two features one', () => {
    for (const flip of [false, true]) {
      const pair = (a: string, b: string): string => (flip ? `${b} ${a}` : `${a} ${b}`);
      const { model, id } = parsed(`package P {
        part def Q { attribute M default = 1.0; attribute N default = 1.0; }
        part def Q2 :> Q { attribute X :>> M, N default = 3.0; }
        part def Q3 :> Q { attribute :>> M, N default = 3.0; }
        part def R :> Q { attribute M2 redefines M default = 2.0; }
        part s : Q2 { ${pair('attribute :>> M = 1.0;', 'attribute :>> N = 2.0;')} }
        part u : Q3 { attribute :>> N = 2.0; }
        part v : R { ${pair('attribute :>> M = 5.0;', 'attribute M2 = 9.0;')} }
        part w : R { ${pair('attribute :>> M = 5.0;', 'attribute :>> M2 = 9.0;')} }
        part x : R { attribute :>> M = 5.0; }
      }`);
      const redefines = (owner: string): string[] =>
        model
          .children(id(owner))
          .flatMap((f) => model.children(f.id).filter((c) => c.eClass === 'Redefinition'))
          .map((r) => model.qualifiedName((r.target ?? [])[0]!))
          .sort();
      // X (and Q3's unnamed feature) redefines M and N together: a merge, never the one feature for M or N.
      expect(redefines('s'), `flip ${flip}`).toEqual(['P::Q::M', 'P::Q::N']);
      expect(redefines('u'), `flip ${flip}`).toEqual(['P::Q::N']);
      // R's M2 is what an R has for M, but v declares an M2 and w redefines R's: v's and w's `:>> M` keep Q's M.
      expect(redefines('v'), `flip ${flip}`).toEqual(['P::Q::M']);
      expect(redefines('w'), `flip ${flip}`).toEqual(['P::Q::M', 'P::R::M2']);
      // Alone, `:>> M` in an R redefines R's M2 (MI12).
      expect(redefines('x'), `flip ${flip}`).toEqual(['P::R::M2']);
    }
  });

  // Two of a usage's features must not take one NAME either: v's `:>> M` and `:>> K` each have a most specific
  // feature named M2 (R's, S's), so both would be v's M2, and the SMT engine merged them into one symbol while the
  // other surfaces read the first by text order (p2s, p2sr). A sibling is judged by the names of the line it lies in,
  // never by the feature it has taken, so the answer cannot depend on which is decided first. An M2 of S2's own,
  // inherited off the line, is masked by the renamed feature just the same (p3).
  it('keeps the named feature where two features, or an inherited one, would bear the renamed name', () => {
    for (const flip of [false, true]) {
      const pair = (a: string, b: string): string => (flip ? `${b} ${a}` : `${a} ${b}`);
      const { model, id } = parsed(`package P {
        part def Q { attribute M default = 1.0; }
        part def R :> Q { attribute M2 redefines M default = 2.0; }
        part def T { attribute K default = 7.0; }
        part def S :> T { attribute M2 redefines K default = 8.0; }
        part def S2 { attribute M2 default = 7.0; }
        part v : R, S { ${pair('attribute :>> M = 5.0;', 'attribute :>> K = 9.0;')} }
        part y : R, S2 { attribute :>> M = 5.0; }
        part z : R { attribute :>> M = 5.0; }
      }`);
      const redefines = (owner: string): string[] =>
        model
          .children(id(owner))
          .flatMap((f) => model.children(f.id).filter((c) => c.eClass === 'Redefinition'))
          .map((r) => model.qualifiedName((r.target ?? [])[0]!))
          .sort();
      expect(redefines('v'), `flip ${flip}`).toEqual(['P::Q::M', 'P::T::K']);
      expect(redefines('y'), `flip ${flip}`).toEqual(['P::Q::M']);
      // Typed by R alone, `:>> M` is R's M2 (MI12).
      expect(redefines('z'), `flip ${flip}`).toEqual(['P::R::M2']);
    }
  });

  // Q23's own `:>> M = 5.0` redefines Q's M past Q2's and Q3's (they stand in a diamond there), and is what a Q23
  // has for M: a usage typed by Q23 redefines it, as `t.M` reads it. Typed by Q2 and Q3 themselves, neither is below
  // the other, and the name's feature stays (p8b).
  it('takes the feature a type below the others owns where several are most specific', () => {
    const { model, id } = parsed(`package P {
      part def Q { attribute M default = 1.0; }
      part def Q2 :> Q { attribute :>> M default = 2.0; }
      part def Q3 :> Q { attribute :>> M default = 3.0; }
      part def Q23 :> Q2, Q3 { attribute :>> M = 5.0; }
      part s : Q23 { attribute :>> M; }
      part q : Q2, Q3 { attribute :>> M; }
    }`);
    const redefined = (owner: string) =>
      model.children(model.children(id(owner)).find((c) => c.eClass === 'AttributeUsage')!.id).find((c) => c.eClass === 'Redefinition')!.target;
    expect(redefined('s')).toEqual([model.children(id('Q23')).find((c) => c.eClass === 'AttributeUsage')!.id]);
    expect(redefined('q')).toEqual([model.children(id('Q')).find((c) => c.eClass === 'AttributeUsage')!.id]);
  });

  // The check a name meets once it is a redefined feature's own: does another feature of the usage bear a name of
  // its line? With `among`, only the features an edit touched count, to tell a collision the edit made from one the
  // text was loaded with.
  it('tells whether a sibling bears a name on the redefined feature\'s line, among the features asked', () => {
    const { model, id } = parsed(`package P {
      part def Q { attribute M default = 1.0; }
      part def R :> Q { attribute M2 redefines M default = 2.0; }
      part v : R { attribute :>> M = 5.0; attribute M2 = 9.0; }
      part w : R { attribute :>> M = 5.0; attribute Z = 9.0; }
    }`);
    const r = model.children(id('R')).find((c) => c.declaredName === 'M2')!;
    const redefining = (owner: string): string => model.children(id(owner)).find((c) => c.declaredName === undefined)!.id;
    const sibling = (owner: string, name: string): string => model.children(id(owner)).find((c) => c.declaredName === name)!.id;
    expect(sharesLineWithSibling(model, r, redefining('v'))).toBe(true);
    expect(sharesLineWithSibling(model, r, redefining('w'))).toBe(false);
    expect(sharesLineWithSibling(model, r, redefining('v'), new Set([sibling('v', 'M2')]))).toBe(true);
    // Another feature touched, not the colliding one: the collision is not the edit's.
    expect(sharesLineWithSibling(model, r, redefining('v'), new Set([redefining('v')]))).toBe(false);
  });

  it('falls back to ordinary resolution for a qualified redefinition target', () => {
    const { model, id } = parsed(`package P {
      part def Other { part z; }
      part def Car { part c; }
    }`);
    const car = id('Car');
    const c = model.children(car).find((x) => x.declaredName === 'c')!;
    expect(model.qualifiedName(resolveRedefinedFeature(model, 'Other::z', c.id, car)!.id)).toBe(
      'P::Other::z',
    );
  });
});

/**
 * `src/semantics/bind.ts` — THE reference resolver.
 *
 * Every case here goes through `parseModel` (i.e. `library: 'none'`): the point
 * of the module is that the answer does not depend on a library being loaded,
 * and a resolver tested only on hand-built models would not prove that the
 * mapper asks it the same questions the notation does.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseModel } from '@text/index';
import { redefinitionNameIsOrderDependent, resolveFullName, resolveRedefinedFeature, sharesLineWithSibling, unreadScopes } from '../../src/semantics/bind';
import { Model, ModelFactory } from '@core/index';

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

  // The parse that made a file never meets the implicit end copies a definition-level `bind` makes, so an explicit
  // `:>>` is no candidate for them: a settle that landed it on one left the page reading what the file did not (the
  // re-review's landcopy and defmin probes). The copy itself, an implicit feature, is placed by its own rule.
  it('lands an explicit :>> on no implicit end copy a definition-level bind made', () => {
    const { model, id } = parsed(`package P {
      part def L0 { attribute load default = 11.0; }
      part def Q { attribute L; part p : L0; }
      part def Q2 :> Q { attribute :>> L = 15.0; }
      part def Q3 :> Q2 { bind p.load = L; }
      part r1 : Q3 { attribute :>> L; }
      part def E1 { attribute M default = 11.0; }
      part def D1 :> E1 { attribute :>> M default = 14.0; }
      part def D2 :> E1 { attribute Zd2; bind Zd2 = M; }
      part u0 : D1, D2 { attribute :>> M; }
    }`);
    // Q3 and D2 do hold an implicit copy named so, which a name lookup in them finds first.
    const copy = (owner: string, name: string) => model.children(id(owner)).find((c) => c.declaredName === name && c.attrs.implicit === true);
    expect(copy('Q3', 'L')).toBeDefined();
    expect(copy('D2', 'M')).toBeDefined();
    const own = (owner: string) => model.children(id(owner)).find((c) => c.eClass === 'AttributeUsage' && c.attrs.implicit !== true && c.declaredName === undefined)!;
    const land = (usage: string, name: string) => resolveRedefinedFeature(model, name, own(usage).id, id(usage))!;
    // r1 : Q3 lands on Q2's unnamed `:>> L`, where Q3's copy would be the most specific.
    expect(land('r1', 'L').id).toBe(own('Q2').id);
    // u0 : D1, D2 lands on D1's `:>> M`; D2's copy named M is the feature of E1's M it redefines, to the parse.
    expect(land('u0', 'M').id).toBe(own('D1').id);
    // The parse and the resolver agree (the Redefinition the mapper made holds the same answer).
    const redefined = (usage: string) => model.children(own(usage).id).find((c) => c.eClass === 'Redefinition')!.target;
    expect(redefined('r1')).toEqual([own('Q2').id]);
    expect(redefined('u0')).toEqual([own('D1').id]);
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

  // The names of a line reach only its named features; a feature written straight at an unnamed one (the editor and
  // the SDK can, the text cannot) is found through the line itself.
  it('finds a sibling that redefines an unnamed feature of the line, which no name on it reaches', () => {
    const { model, id } = parsed(`package P {
      part def Q { attribute M default = 1.0; }
      part def Q2 :> Q { attribute :>> M default = 2.0; }
      part v : Q2 { attribute :>> M = 5.0; }
    }`);
    const hit = model.children(id('Q2')).find((c) => c.eClass === 'AttributeUsage')!;
    const redefining = model.children(id('v')).find((c) => c.eClass === 'AttributeUsage')!;
    expect(sharesLineWithSibling(model, hit, redefining.id)).toBe(false);
    const sibling = model.create('AttributeUsage', { ownerId: id('v') });
    new ModelFactory(model).redefinition(sibling.id, hit.id);
    expect(sharesLineWithSibling(model, hit, redefining.id)).toBe(true);
    // Among the features an edit touched, the sibling counts only if it is one of them.
    expect(sharesLineWithSibling(model, hit, redefining.id, new Set([redefining.id]))).toBe(false);
    expect(sharesLineWithSibling(model, hit, redefining.id, new Set([sibling.id]))).toBe(true);
  });

  it('finds a sibling on a line of features no name reaches at all', () => {
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('Anon');
    const p = f.partDef('P', pkg.id);
    const q = f.partDef('Q', pkg.id);
    f.subclassification(q.id, p.id);
    const top = model.create('AttributeUsage', { ownerId: p.id });
    const hit = model.create('AttributeUsage', { ownerId: q.id });
    f.redefinition(hit.id, top.id);
    const v = f.part('v', pkg.id, q.id);
    const redefining = model.create('AttributeUsage', { ownerId: v.id });
    f.redefinition(redefining.id, hit.id);
    expect(sharesLineWithSibling(model, hit, redefining.id)).toBe(false);
    const sibling = model.create('AttributeUsage', { ownerId: v.id });
    f.redefinition(sibling.id, hit.id);
    expect(sharesLineWithSibling(model, hit, redefining.id)).toBe(true);
  });

  // Q3's unnamed `:>> M2` is what a Q3 has for M, and it is known as M2: a usage's `:>> M` would take that name beside
  // the M2 S brings, so it keeps the name's own feature, as it does where Q2's `M2 redefines M` is written plainly.
  it('keeps the named feature where an unnamed redefinition of a renamed feature would put a name on two', () => {
    const { model, id } = parsed(`package P {
      part def Q { attribute M default = 1.0; }
      part def Q2 :> Q { attribute M2 redefines M default = 2.0; }
      part def Q3 :> Q2 { attribute :>> M2 default = 3.0; }
      part def S { attribute M2 default = 7.0; }
      part v : Q3, S { attribute :>> M = 5.0; }
      part w : Q3 { attribute :>> M = 5.0; }
    }`);
    const redefinedBy = (owner: string): string[] | undefined =>
      model.children(model.children(id(owner)).find((c) => c.eClass === 'AttributeUsage')!.id).find((c) => c.eClass === 'Redefinition')!.target;
    const feature = (def: string): string => model.children(id(def)).find((c) => c.eClass === 'AttributeUsage')!.id;
    expect(redefinedBy('v')).toEqual([feature('Q')]);
    expect(redefinedBy('w')).toEqual([feature('Q3')]);
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

// The cost of a deep line of redefinitions. A chain of definitions each redefining the one above, and a lattice of
// them each specialising the two above, are asked for the same lines again at every `:>>` of every usage below: the
// parse took the depth cubed (a chain of 300, 6 s against 0.4 s without the rule), and a lattice of 160 levels 12 s.
// The edge lookups a parse makes are counted, so the test does not depend on how loaded the machine is.
describe('resolveRedefinedFeature — a deep line of redefinitions costs its depth, not more', () => {
  const chain = (depth: number): string => {
    const lines = ['package PC {', '  part def Q0 { attribute M default = 0.0; }'];
    for (let k = 1; k <= depth; k++) lines.push(`  part def Q${k} :> Q${k - 1} { attribute :>> M default = ${k}.0; }`);
    for (let u = 0; u < 2; u++) lines.push(`  part u${u} : Q${depth} { attribute :>> M; }`);
    return [...lines, '}'].join('\n');
  };
  const lattice = (depth: number): string => {
    const lines = ['package PL {', '  part def A0 { attribute M default = 0.0; }', '  part def B0 { attribute N default = 0.0; }'];
    for (let k = 1; k <= depth; k++) {
      lines.push(`  part def A${k} :> A${k - 1}, B${k - 1} { attribute :>> M default = ${k}.0; }`);
      lines.push(`  part def B${k} :> A${k - 1}, B${k - 1} { attribute :>> M default = ${k}.5; }`);
    }
    for (let u = 0; u < 2; u++) lines.push(`  part u${u} : A${depth} { attribute :>> M; }`);
    return [...lines, '}'].join('\n');
  };
  /** The redefinition each unnamed feature makes, as `Owner->Owner.name` (`?` where the target is unnamed too). */
  const targets = (model: Model): string[] => {
    const label = (id: string): string => {
      const e = model.get(id)!;
      return `${e.ownerId ? model.get(e.ownerId)!.declaredName : ''}.${e.declaredName ?? '?'}`;
    };
    return model
      .all()
      .filter((e) => e.eClass === 'Redefinition' && e.attrs.isLibrary !== true && e.attrs.implicit !== true)
      .map((r) => `${label(r.source![0]!)}->${label(r.target![0]!)}`);
  };
  /** How often a parse asks the model for the edges of one element. */
  const edgeLookups = (src: string): number => {
    const from = vi.spyOn(Model.prototype, 'relationshipsFrom');
    const to = vi.spyOn(Model.prototype, 'relationshipsTo');
    try {
      parsed(src);
      return from.mock.calls.length + to.mock.calls.length;
    } finally {
      from.mockRestore();
      to.mockRestore();
    }
  };

  it('lands each redefinition on the one above in a chain, and on the anchor where a lattice has no one most specific', () => {
    expect(targets(parsed(chain(6)).model)).toEqual([
      'Q1.?->Q0.M', 'Q2.?->Q1.?', 'Q3.?->Q2.?', 'Q4.?->Q3.?', 'Q5.?->Q4.?', 'Q6.?->Q5.?', 'u0.?->Q6.?', 'u1.?->Q6.?',
    ]);
    // A level's two definitions each redefine the anchor (neither is below the other); a usage typed by the last
    // level redefines that level's own.
    expect(targets(parsed(lattice(3)).model)).toEqual([
      'A1.?->A0.M', 'B1.?->A0.M', 'A2.?->A0.M', 'B2.?->A0.M', 'A3.?->A0.M', 'B3.?->A0.M', 'u0.?->A3.?', 'u1.?->A3.?',
    ]);
  });

  it('asks the model for edges in proportion to the depth of a chain and of a lattice', () => {
    for (const shape of [chain, lattice]) {
      const shallow = edgeLookups(shape(30));
      const deep = edgeLookups(shape(60));
      // Twice the depth is twice the lookups (a square would be four times, a cube eight), and a few per level.
      expect(deep / shallow, shape.name).toBeLessThan(2.6);
      expect(deep, shape.name).toBeLessThan(60 * 20);
    }
  });
});

// The editor settles a usage of N `:>>` after an edit by asking, for each, whether a feature the edit touched shares
// its line (`among`). The answer for a usage whose siblings are not among the few touched is no, and it is reached
// from the touched ones, not by looking at every sibling again for every `:>>`: a settle took N squared of these
// before (a thousand and a half `:>>`, a retype 30 ms to 100 ms).
describe('sharesLineWithSibling — a usage of many redefinitions, asked of a few touched features', () => {
  it('looks at the touched features, not at every sibling, for each redefinition', () => {
    const n = 300;
    const base = Array.from({ length: n }, (_, k) => `attribute a${k} default = 1.0;`).join(' ');
    const redefs = Array.from({ length: n }, (_, k) => `attribute :>> a${k} = 2.0;`).join(' ');
    const { model, id } = parsed(`package W { part def B { ${base} } part s : B { ${redefs} } }`);
    const features = model.children(id('s')).filter((c) => c.eClass === 'AttributeUsage');
    expect(features).toHaveLength(n);
    // The edit retyped `s`: it is the one feature touched, and none of its `:>>` is.
    const touched = new Set<string>([id('s')]);
    const has = vi.spyOn(touched, 'has');
    for (const f of features) {
      const rel = model.children(f.id).find((c) => c.eClass === 'Redefinition')!;
      const hit = model.get(rel.target![0]!)!;
      // None of the siblings is among the touched, so none counts.
      expect(sharesLineWithSibling(model, hit, f.id, touched), f.declaredName).toBe(false);
    }
    expect(has.mock.calls.length).toBeLessThan(n * 10);
  });
});

describe('redefinitionNameIsOrderDependent — a simple name two of the owner\'s generals answer differently', () => {
  // `part :>> p : P2` redefines H's `p : P3`: its generals are P2 and, through the redefined p, P3. P3 has a `b` of its own
  // (it redefines `a`) beside the `b` it inherits from P, so `:>> b` is P::b by P2 and P3::b by p.
  const text = (b: string): string => `package G {
  part def P { attribute a default = 1.0; attribute b default = 2.0; }
  part def P2 :> P;
  part def P3 :> P { attribute ${b} :>> a default = 3.0; }
  part def H { part p : P3; }
  part w : H { part :>> p : P2 { attribute :>> b; } }
}`;
  const ask = (src: string): { order: boolean; owner: string } => {
    const { model, id } = parsed(src);
    const nested = model.children(id('w')).find((c) => c.eClass === 'PartUsage')!;
    const f = model.children(nested.id).find((c) => c.eClass === 'AttributeUsage')!;
    return { order: redefinitionNameIsOrderDependent(model, 'b', f.id, nested.id), owner: model.qualifiedName(resolveRedefinedFeature(model, 'b', f.id, nested.id)!.id) };
  };

  it('is true where two generals find different features, and the rule still answers by the first', () => {
    expect(ask(text('b')).order).toBe(true);
  });

  it('is false where the name is one feature, or is qualified', () => {
    expect(ask(text('a3')).order).toBe(false);
    const { model, id } = parsed(text('b'));
    const nested = model.children(id('w')).find((c) => c.eClass === 'PartUsage')!;
    const f = model.children(nested.id).find((c) => c.eClass === 'AttributeUsage')!;
    expect(redefinitionNameIsOrderDependent(model, 'G::P3::b', f.id, nested.id)).toBe(false);
    expect(model.qualifiedName(resolveRedefinedFeature(model, 'G::P3::b', f.id, nested.id)!.id)).toBe('G::P3::b');
  });
});

describe('unreadScopes — the owners whose features the saved file may read otherwise', () => {
  const named = (model: Model, scopes: ReturnType<typeof unreadScopes>): string[] => [...scopes].map(([id, why]) => `${model.qualifiedName(id)}:${why}`).sort();
  const edge = (model: Model, from: string): string => model.all().find((e) => e.eClass === 'Redefinition' && e.attrs.isLibrary !== true && model.get(e.source![0]!)?.declaredName === from)!.id;
  const SRC = `package U {
    part def P { attribute a default = 11.0; attribute b default = 12.0; }
    part def P1 :> P { attribute a1 :>> a default = 13.0; }
    part def P2 :> P1 { attribute a2 :>> a1 default = 14.0; }
    part def H { part p : P; part q : P; }
    part def H1 :> H { part p1 :>> p; }
    part w : H1 { part :>> p1 { attribute :>> b = 15.0; } }
  }`;

  it('lists nothing for the redefinitions the mapper makes (inherited, by path, a reference usage, an implicit library base)', () => {
    expect(unreadScopes(parsed(SRC).model).size).toBe(0);
    // A usage with no type whose `:>> M` the file resolves by the path the settle writes; a metadata body's keyword-less `:>>`;
    // `connect a to done`'s implicit `done` over the library's `Parts::Part::done`.
    const odd = parsed(`package V {
      metadata def Risk { attribute level : ScalarValues::Real; }
      part def Q { attribute M default = 1.0; }
      part def Car { part a; connect a to done; metadata rk : Risk { :>> level = 3.0; } }
      part t { attribute :>> V::Q::M; }
    }`);
    expect(named(odd.model, unreadScopes(odd.model))).toEqual([]);
  });

  it('lists the owner of two features under one name, or one name and one short name, and no other', () => {
    const twin = parsed(`package T { part def A { attribute x default = 1.0; attribute x default = 2.0; } part def B { attribute <y> y2; attribute y; } part def C { attribute <z> z; } }`);
    expect(named(twin.model, unreadScopes(twin.model))).toEqual(['T::A:twins', 'T::B:twins']);
  });

  it('lists the owner of a redefinition retargeted by hand to a feature it does not inherit, of another kind, or in a cycle', () => {
    const retargeted = (from: string, to: (m: Model, id: (n: string) => string) => string): string[] => {
      const { model, id } = parsed(SRC);
      model.update(edge(model, from), { target: [to(model, id)] });
      return named(model, unreadScopes(model));
    };
    // H1's p1 onto H::q, which H1 inherits: the file spells it `:>> q` and reads it back.
    expect(retargeted('p1', (_m, id) => id('q'))).toEqual([]);
    // Onto the top-level usage w, which the name `w` finds by the mapper's rule from H1: the file keeps it too.
    expect(retargeted('p1', (_m, id) => id('w'))).toEqual([]);
    // Onto the unnamed `:>> p1` inside w, which H1 does not inherit and no name finds from H1 (and w's `:>> p1` now
    // redefines a feature that redefines it back: a cycle).
    expect(retargeted('p1', (m, id) => m.children(id('w')).find((c) => c.eClass === 'PartUsage')!.id)).toEqual(['U::H1:redefinition', 'U::w:redefinition']);
    // Another kind: the part usage p1 onto the attribute b.
    expect(retargeted('p1', (_m, id) => id('b'))).toEqual(['U::H1:redefinition']);
    // A cycle: a1 onto a2, which redefines a1.
    expect(retargeted('a1', (_m, id) => id('a2'))).toEqual(['U::P1:redefinition', 'U::P2:redefinition']);
  });
});

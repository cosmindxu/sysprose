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
import { resolveFullName, resolveRedefinedFeature } from '../../src/semantics/bind';
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

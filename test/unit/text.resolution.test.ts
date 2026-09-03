/**
 * Reference resolution as `parseModel` performs it (I4).
 *
 * Everything here is `parseModel` alone — no standard library, no binder. That
 * is the contract this commit establishes: a file that refers only to itself is
 * fully resolved when the parse returns, and WHAT a name denotes does not
 * depend on where in the file it was written.
 */
import { describe, it, expect } from 'vitest';
import { parseModel, serializeModel } from '@text/index';
import type { ElementRecord, Model } from '@core/index';

function parse(src: string): { model: Model; codes: string[] } {
  const { model, diagnostics } = parseModel(src);
  return { model, codes: diagnostics.map((d) => d.code ?? d.message) };
}

const find = (model: Model, name: string): ElementRecord =>
  model.all().find((e) => e.declaredName === name)!;

const typeNames = (model: Model, el: ElementRecord): string[] =>
  model.typesOf(el.id).map((t) => model.qualifiedName(t.id));

describe('parseModel — declaration order does not decide what a name denotes (I4)', () => {
  // The witness from the I4 investigation, written both ways round. The parser
  // used to answer `P::W` when the outer definition came first and the library
  // binder `P::Base::W` when it came last: the same text, two models.
  const backward = `package P {
    part def W;
    part def Base { part def W; }
    part def Car :> Base { part w1 : W; }
  }`;
  const forward = `package P {
    part def Base { part def W; }
    part def Car :> Base { part w1 : W; }
    part def W;
  }`;

  it.each([
    ['outer declared FIRST', backward],
    ['outer declared LAST', forward],
  ])('binds the inherited W in both orders (%s)', (_label, src) => {
    const { model, codes } = parse(src);
    expect(codes).toEqual([]);
    expect(typeNames(model, find(model, 'w1'))).toEqual(['P::Base::W']);
  });

  it('reaches a name inherited through a supertype bound in a LATER round', () => {
    // `Base :> Grand` is itself forward, so `Car`'s inheritance graph is only
    // complete after the specialization fixpoint has run — and `w1 : W` has to
    // be (re)decided against the finished graph, not the one it started with.
    const { model, codes } = parse(`package P {
      part def W;
      part def Base :> Grand;
      part def Car :> Base { part w1 : W; }
      part def Grand { part def W; }
    }`);
    expect(codes).toEqual([]);
    expect(typeNames(model, find(model, 'w1'))).toEqual(['P::Grand::W']);
  });

  it('re-decides a typing once the enclosing usage gains its own type', () => {
    // `c : T` and `w1 : W` are decided in the same round; only after `c` is
    // typed can `W` be seen through T's general `G`.
    const { model, codes } = parse(`package P {
      part def W;
      part c : T { part w1 : W; }
      part def T :> G;
      part def G { part def W; }
    }`);
    expect(codes).toEqual([]);
    expect(typeNames(model, find(model, 'w1'))).toEqual(['P::G::W']);
  });

  it('re-decides through an IMPORT whose namespace gained a general', () => {
    // The same re-decision, one indirection further out: the general that
    // changes the answer is gained by `H`, which `Use` reaches only through its
    // import. A gate that walked the scope chain alone never revisited `C`, so
    // the mapper answered `Outer::W` while its own resolver said `P::Grand::W`.
    const { model, codes } = parse(`package P {
      part def Grand { part def W; }
      part def T :> Grand;
      part H : T;
    }
    package Outer {
      part def W;
      package Use { import P::H::*; part def C :> W; }
    }`);
    expect(codes).toEqual([]);
    const c = find(model, 'C');
    expect(model.typesOf(c.id).map((t) => model.qualifiedName(t.id))).toEqual(['P::Grand::W']);
  });
});

describe('parseModel — every reference kind uses the one resolver', () => {
  it('binds a `:>` whose target is reachable only by INHERITANCE', () => {
    const { model, codes } = parse(`package P {
      part def Base { part def Inner; }
      part def D :> Base { part def Sub :> Inner; }
    }`);
    expect(codes).toEqual([]);
    const sub = find(model, 'Sub');
    expect(model.children(sub.id).map((c) => c.eClass)).toContain('Subclassification');
    expect(typeNames(model, sub)).toEqual(['P::Base::Inner']);
  });

  it('binds a `:>` whose target is reachable only by IMPORT', () => {
    const { model, codes } = parse(`package Lib { part def Widget; }
    package Use { import Lib::*; part def W2 :> Widget; }`);
    expect(codes).toEqual([]);
    expect(typeNames(model, find(model, 'W2'))).toEqual(['Lib::Widget']);
  });

  it('redefines the INHERITED feature, never itself', () => {
    const { model, codes } = parse(`package P {
      part def Base { part w; }
      part def Car :> Base { part w :>> w; }
    }`);
    expect(codes).toEqual([]);
    const car = find(model, 'Car');
    const w = model.children(car.id).find((c) => c.declaredName === 'w')!;
    const red = model.children(w.id).find((c) => c.eClass === 'Redefinition')!;
    expect(model.qualifiedName((red.target ?? [])[0])).toBe('P::Base::w');
  });

  it('redefines the inherited feature even when an OUTER one shares the name', () => {
    const { model } = parse(`package P {
      part w;
      part def Base { part w; }
      part def Car :> Base { part w2 :>> w; }
    }`);
    const car = find(model, 'Car');
    const w2 = model.children(car.id).find((c) => c.declaredName === 'w2')!;
    const red = model.children(w2.id).find((c) => c.eClass === 'Redefinition')!;
    expect(model.qualifiedName((red.target ?? [])[0])).toBe('P::Base::w');
  });

  it('types a feature by the element an ALIAS names', () => {
    const { model, codes } = parse(`package P {
      part def Real2;
      alias A for Real2;
      part def V { part p : A; }
    }`);
    expect(codes).toEqual([]);
    expect(typeNames(model, find(model, 'p'))).toEqual(['P::Real2']);
  });

  it('binds a `then` whose target state is INHERITED', () => {
    const { model, codes } = parse(`package P {
      action def Base { action s2; }
      action def Flow :> Base {
        action s1;
        first s1 then s2;
      }
    }`);
    expect(codes).toEqual([]);
    const succ = model.all().find((e) => e.eClass === 'Succession')!;
    expect(succ.attrs.targetRef).toBeUndefined();
    expect(model.get((succ.target ?? [])[0])?.declaredName).toBe('s2');
  });
});

describe('parseModel — connector ends stay per-usage', () => {
  it('materialises the INHERITED end instead of binding an outer name', () => {
    const { model, codes } = parse(`package P {
      part x;
      part def Base { part x; }
      part def Car :> Base { part a; connect a to x; }
    }`);
    expect(codes).toEqual([]);
    const conn = model.all().find((e) => e.eClass === 'ConnectionUsage')!;
    const end = model.get((conn.target ?? [])[0])!;
    expect(model.qualifiedName(end.id)).toBe('P::Car::x');
    expect(end.attrs.implicit).toBe(true);
  });

  it('keeps `a.p` and `b.p` DISTINCT when the first segment is owned', () => {
    // Both segments resolve through the same definition-owned port. Binding to
    // it directly would make one shared endpoint — a self-edge on the type.
    const { model, codes } = parse(`package P {
      part def T { port p; }
      part def Sys { part a : T; part b : T; connect a.p to b.p; }
    }`);
    expect(codes).toEqual([]);
    const conn = model.all().find((e) => e.eClass === 'ConnectionUsage')!;
    const src = (conn.source ?? [])[0];
    const tgt = (conn.target ?? [])[0];
    expect(src).not.toBe(tgt);
    expect(model.qualifiedName(src)).toBe('P::Sys::a::p');
    expect(model.qualifiedName(tgt)).toBe('P::Sys::b::p');
  });

  it('binds an IMPORTED end directly instead of mirroring it', () => {
    // Materialisation exists to keep a definition-owned prototype from being
    // shared by every usage of that definition. A package inherits nothing, so
    // an imported member is not a prototype and there is nothing to mirror:
    // mirroring it fabricated an implicit `P::x` plus a Redefinition and bound
    // the connector to the invention.
    const { model, codes } = parse(`package Lib { part x; part y; }
    package P { import Lib::*; connect x to y; }`);
    expect(codes).toEqual([]);
    const conn = model.all().find((e) => e.eClass === 'ConnectionUsage')!;
    expect(model.qualifiedName((conn.source ?? [])[0])).toBe('Lib::x');
    expect(model.qualifiedName((conn.target ?? [])[0])).toBe('Lib::y');
    expect(model.all().filter((e) => e.attrs.implicit === true)).toEqual([]);
    expect(model.all().filter((e) => e.eClass === 'Redefinition')).toEqual([]);
  });

  it('keeps the example models’ connection identity', () => {
    const { model } = parse(`package V {
      part def Port;
      part def Engine { part fuelOut : Port; }
      part def Vehicle { part engine : Engine; part fuelIn : Port; }
      part vehicle : Vehicle {
        connection a connect engine.fuelOut to fuelIn;
        connection b connect engine.fuelOut to fuelIn;
      }
    }`);
    const conns = model.all().filter((e) => e.eClass === 'ConnectionUsage');
    expect(conns).toHaveLength(2);
    // The same written chain names the SAME materialised feature, so two
    // connections on one usage share their endpoints instead of multiplying.
    expect((conns[0].source ?? [])[0]).toBe((conns[1].source ?? [])[0]);
    expect(model.qualifiedName((conns[0].source ?? [])[0])).toBe('V::vehicle::engine::fuelOut');
  });
});

describe('parseModel — a warning means the reference is genuinely unresolvable', () => {
  /** Every warning message, in emission order. */
  const messages = (src: string): string[] => parseModel(src).diagnostics.map((d) => d.message);

  it('names EVERY unresolved name that shares one attribute slot', () => {
    // `typeRef` and a dependency's `sourceRef` are single slots holding one of
    // several written names. Deciding which deferred warning survives from the
    // slot dropped the others: `part x : Gone1, Gone2;` reported only the last,
    // and `dependency a, MissingX to b;` reported `a` — the one that RESOLVED.
    expect(messages(`package P { part x : Gone1, Gone2; }`)).toEqual([
      "Unresolved reference 'Gone1'",
      "Unresolved reference 'Gone2'",
    ]);
    expect(messages(`package P { part a; part b; dependency a, MissingX to b; }`)).toEqual([
      "Unresolved dependency client 'MissingX'",
    ]);
    expect(messages(`package P { part a; part b; dependency a to b, MissingY; }`)).toEqual([
      "Unresolved dependency supplier 'MissingY'",
    ]);
  });

  it('reports one unresolved SOURCE once, not once per target', () => {
    // A statement with several targets creates one relationship per target and
    // defers the source warning on each of them.
    expect(messages(`package P { part def B; part def C; subtype Missing specializes B, C; }`)).toEqual([
      "Unresolved relationship source 'Missing'",
      "Unresolved reference 'B'",
      "Unresolved reference 'C'",
    ]);
  });

  it('reports nothing for a forward `:>` or a forward alias', () => {
    expect(parse(`package P { part def Car :> Vehicle; part def Vehicle; }`).codes).toEqual([]);
    expect(parse(`package P { alias A for Later; part def Later; }`).codes).toEqual([]);
  });

  it('still reports an ABSENT specialization target', () => {
    const { model, codes } = parse(`package P { part def Car :> Nope; }`);
    expect(codes).toEqual(['ref/unresolved-specialization']);
    expect(find(model, 'Car').attrs.specializes).toEqual(['Nope']);
  });

  it('keeps an unresolved ATTRIBUTE type silent', () => {
    const { model, codes } = parse(`package P { attribute a : NotAType; }`);
    expect(codes).toEqual([]);
    expect(find(model, 'a').attrs.type).toBe('NotAType');
  });
});

describe('parseModel — declaration order is preserved in the model', () => {
  it('re-emits an element’s specializations in the order they were written', () => {
    // The specialization family is bound BEFORE typings, so without an explicit
    // reordering step this re-emits as `part def A :> B :>> c : T;`.
    const { model, codes } = parse(`package P {
      part def T;
      part def B;
      part c;
      part def A : T :> B :>> c;
    }`);
    expect(codes).toEqual([]);
    expect(serializeModel(model)).toContain('part def A : T :> B :>> c;');
  });
});

describe('parseModel — resolution performance stays in budget', () => {
  const flat = (n: number): string => {
    let s = 'package P {\n';
    for (let i = 0; i < n; i++) s += `  part def D${i};\n  part p${i} : D${i};\n`;
    return `${s}}\n`;
  };
  const deep = (n: number): string => {
    let s = 'package P {\n  part def D0;\n';
    for (let i = 1; i < n; i++) s += `  part def D${i} :> D${i - 1};\n`;
    return `${s}  part x : D${n - 1};\n}\n`;
  };

  // GROSS-BLOWUP CANARIES, and nothing finer. Measured alone on the
  // development machine (1200: ~230ms, 2400: ~650ms), but these run inside the
  // full parallel suite, where the same 2400 case has been seen at 3600ms —
  // so the budgets are the loose ones a wall-clock assertion can honestly
  // carry, and they catch an order-of-magnitude regression, not a factor.
  //
  // Say plainly what they do NOT catch, so nobody reads them as protection
  // they are not: deleting the `scopeGainedGeneral` re-decision gate in
  // `resolveDeferredRefs` leaves these green (measured ungated, alone: 340ms /
  // 1253ms). That gate is a pure optimisation — its CORRECTNESS-visible half,
  // re-deciding a reference whose scope gained a general, is pinned by the
  // witnesses at the top of this file. A ratio assertion does not separate it
  // either: parsing alone grows super-linearly here, so gated and ungated
  // slopes overlap (4x input → 8.3x gated vs 10.1x ungated).
  it.each([
    ['flat 1200 declarations', flat(1200), 3000],
    ['flat 2400 declarations', flat(2400), 6000],
  ])('parses %s within budget', (_label, src, budget) => {
    parseModel(src); // warm the parser
    const t0 = performance.now();
    const { model } = parseModel(src);
    expect(performance.now() - t0).toBeLessThan(budget);
    expect(model.size).toBeGreaterThan(0);
  });

  it('parses an 800-deep inheritance chain in under a second', () => {
    // The pathological shape for inherited resolution: every lookup walks a
    // generalization closure that grows with the file.
    const src = deep(800);
    parseModel(src);
    const t0 = performance.now();
    const { model, diagnostics } = parseModel(src);
    const ms = performance.now() - t0;
    expect(diagnostics).toEqual([]);
    expect(ms).toBeLessThan(1000);
    expect(typeNames(model, find(model, 'x'))).toEqual(['P::D799']);
  });
});

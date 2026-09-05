import { describe, it, expect } from 'vitest';
import { buildSampleModel, Model, ModelFactory, type ElementRecord } from '@core/index';
import { parseModel, serializeModel } from '@text/index';
import { validate } from '@validation/index';
import { NOTE_BODY_TERMINATOR, UnwritableNoteBodyError } from '@semantics/index';

/** Attributes that carry semantic meaning for round-trip comparison. */
const KEY_ATTRS = [
  'type',
  'typeRef',
  'value',
  'valueText',
  'direction',
  'multiplicity',
  'reqId',
  'text',
  'trigger',
  'guard',
  'effect',
  'importedName',
  'body',
  'expression',
  'stateSubaction',
  'requirementRole',
  // Round-trip-fidelity milestone (H17 wave 1): these were captured by the
  // parser but never re-emitted, and were invisible to this signature helper.
  'visibility',
  'metadata',
  'modifiers',
  'filters',
  'language',
  // Round-trip-fidelity milestone (H17 wave 3): dedicated statement attrs.
  'succession',
  'actionKind',
  'actionTarget',
  'via',
  'loopKind',
  'loopVar',
  'loopVarType',
  'condition',
  'collection',
  'thenTarget',
  'elseTarget',
  'hasElse',
  'featureRole',
  'annotation',
  'about',
  'ofPayload',
  'sendTarget',
  'payload',
  'clients',
  'suppliers',
  // Round-trip-fidelity milestone (wave 4): pre-existing gaps.
  'conjugated',
  'aliasFor',
  // The value unit (`= 640.0 [W⋅h]`). It is a separate attribute from
  // `multiplicity` (finding D1/H11) and the serializer re-quotes whatever the
  // grammar cannot read bare, so it belongs in the round-trip signature.
  'unit',
  // The language tag on `comment … locale "en-GB"`. Listed here so the snippet
  // table below fails on a serializer that stops writing it, not only the
  // targeted tests.
  'locale',
] as const;

/** A stable, order-independent signature of an element. */
function signature(model: Model, el: ElementRecord): string {
  const attrs = KEY_ATTRS.filter((k) => el.attrs[k] !== undefined)
    .map((k) => `${k}=${JSON.stringify(el.attrs[k])}`)
    .sort()
    .join(',');
  const src = (el.source ?? []).map((id) => model.qualifiedName(id)).sort().join('|');
  const tgt = (el.target ?? []).map((id) => model.qualifiedName(id)).sort().join('|');
  return `${el.eClass}@@${model.qualifiedName(el.id)}@@{${attrs}}@@${src}=>${tgt}`;
}

/** Multiset of element signatures for a whole model. */
function signatures(model: Model): Map<string, number> {
  const out = new Map<string, number>();
  for (const el of model.all()) {
    const s = signature(model, el);
    out.set(s, (out.get(s) ?? 0) + 1);
  }
  return out;
}

function expectSameElementSet(a: Model, b: Model): void {
  const sa = signatures(a);
  const sb = signatures(b);
  // Compare both directions for a precise diff on failure.
  const missing: string[] = [];
  for (const [k, n] of sa) if (sb.get(k) !== n) missing.push(`A->B ${k} (${n} vs ${sb.get(k) ?? 0})`);
  for (const [k, n] of sb) if (sa.get(k) !== n) missing.push(`B->A ${k} (${n} vs ${sa.get(k) ?? 0})`);
  expect(missing).toEqual([]);
  expect(b.size).toBe(a.size);
}

/** Round-trip a model: serialize → parse → expect equal element set. */
function roundTrip(model: Model): Model {
  const text = serializeModel(model);
  const { model: reparsed, diagnostics } = parseModel(text);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  expect(errors, `serialized text should parse without errors:\n${text}`).toEqual([]);
  expectSameElementSet(model, reparsed);
  return reparsed;
}

describe('round-trip — buildSampleModel()', () => {
  it('serialize → parse reproduces the same element set', () => {
    const m = buildSampleModel();
    roundTrip(m);
  });

  it('serializes the sample to recognizable SysML v2 text', () => {
    const text = serializeModel(buildSampleModel());
    expect(text).toContain('package VehicleModel');
    expect(text).toContain('part def Vehicle');
    expect(text).toContain('part vehicle : Vehicle');
    expect(text).toContain('attribute mass : Real = 1500');
    expect(text).toContain('out port fuelOut');
    expect(text).toContain('connect');
    expect(text).toContain('requirement <R1> maxMass');
    expect(text).toContain('satisfy maxMass by vehicle');
  });
});

describe('round-trip — hand-written snippets', () => {
  const snippets: Array<[string, string]> = [
    [
      'parts, attributes, ports & connection',
      `package Sys {
        part def Engine;
        part vehicle {
          attribute mass : Real = 1200;
          part engine : Engine {
            out port fuelOut;
          }
          in port fuelIn;
          connect engine.fuelOut to fuelIn;
        }
      }`,
    ],
    [
      'specializations & redefinition',
      `package Spec {
        part def Base;
        part def Derived :> Base;
        attribute def MassValue;
        part b : Base {
          attribute m : MassValue [1];
        }
      }`,
    ],
    [
      'requirement, subject & satisfy',
      `package Req {
        part car;
        requirement <R7> safety {
          doc /* the system shall be safe */
        }
        satisfy safety by car;
      }`,
    ],
    [
      'enumerations & import',
      `package En {
        import Lib::Common;
        enum def Gear {
          enum park;
          enum drive;
          enum reverse;
        }
      }`,
    ],
    [
      'action successions',
      `package Act {
        action def Drive {
          action start;
          action stop;
          first start then stop;
        }
      }`,
    ],
    [
      'state machine with transition',
      `package St {
        state def Machine {
          state off;
          state running;
          transition first off accept ignition if ready do crank then running;
        }
      }`,
    ],
    [
      'allocation across features',
      `package Al {
        action behavior;
        part component;
        allocate behavior to component;
      }`,
    ],
    [
      'dependency between parts',
      `package Dep {
        part a;
        part b;
        dependency a to b;
      }`,
    ],
    [
      'visibility keywords (public / private / protected)',
      `package Vis {
        public part def A;
        private part b : A;
        protected attribute x : A;
      }`,
    ],
    [
      'prefix metadata (#) & feature modifiers (ordered / nonunique)',
      `package Meta {
        #Safety part def Critical;
        attribute readings : Real ordered nonunique;
      }`,
    ],
    [
      'import with visibility & filters',
      `package Imp {
        private import Lib::Common;
        import Lib::All::*[x > 0];
      }`,
    ],
    [
      'free-standing block comment (textual representation)',
      `package Cmt {
        /* a free-standing note */
        part p;
      }`,
    ],
    [
      'behavior actions (accept / send / perform)',
      `package Beh {
        action def Proc {
          accept startSignal;
          send readySignal via outPort to controller;
          perform subtask;
        }
      }`,
    ],
    [
      'loops (while / for)',
      `package Loops {
        action def Run {
          while x > 0 {
            action tick;
          }
          for i : Int in items {
            action step;
          }
        }
      }`,
    ],
    [
      'if / then / else (body form)',
      `package Cond {
        action def Decide {
          if ready {
            action go;
          } else {
            action wait;
          }
        }
      }`,
    ],
    [
      'if with target (no body)',
      `package Cond2 {
        action def Route {
          if go finish;
        }
      }`,
    ],
    [
      'return statement',
      `package Ret {
        action def Compute {
          return result;
        }
      }`,
    ],
    [
      'requirement clauses (subject / require)',
      `package Rq {
        part vehicle;
        requirement <R1> massReq {
          subject vehicle;
          require { mass < 1500 }
        }
      }`,
    ],
    [
      'state behaviours (entry / do / exit)',
      `package St2 {
        state def Machine {
          state running {
            entry startup;
            do process;
            exit shutdown;
          }
        }
      }`,
    ],
    [
      'metadata annotation (@)',
      `package Ann {
        part def Component;
        @Safety about Component;
      }`,
    ],
    [
      'dependency with multiple clients & suppliers',
      `package Dm {
        part a;
        part b;
        part c;
        part d;
        dependency a, b to c, d;
      }`,
    ],
    [
      'flow with payload (of … from … to …)',
      `package Fl {
        item def Fuel;
        part a;
        part b;
        flow of Fuel from a to b;
      }`,
    ],
    [
      'generic definition send target (to …)',
      `package Snd {
        part receiver;
        action notify to receiver;
      }`,
    ],
    [
      'constraint body with both a member and a trailing expression',
      `package Cx {
        part def T;
        constraint c {
          part x : T;
          x <= 10
        }
      }`,
    ],
    [
      'metadata definition & usage (keyword form)',
      `package Md {
        metadata def M;
        metadata m;
      }`,
    ],
    [
      'endpoint-less flow & connection usages',
      `package Fu {
        item def T;
        flow f : T;
        connection def C;
        connection c : C;
      }`,
    ],
    [
      'binding connector (bind a = b)',
      `package Bd {
        part a;
        part b;
        bind a = b;
      }`,
    ],
    [
      'alias for a resolved target',
      `package Al2 {
        part a;
        alias b for a;
      }`,
    ],
    [
      'forward disjoint (target declared later) — F4',
      `package Dj {
        part def A;
        disjoint A from B;
        part def B;
      }`,
    ],
    [
      'forward subsetting statement (target declared later) — F4',
      `package Fs {
        part a;
        subset a subsets b;
        part b;
      }`,
    ],
    [
      'names needing quotes (spaces & reserved words)',
      `package Q {
        part 'my part';
        attribute 'true';
      }`,
    ],
    [
      'names with numbers and underscores (finding L10)',
      `package Nu {
        part wheel_01;
        action drive2;
      }`,
    ],
    [
      'empty body (finding L10)',
      `package Eb {
        part def Empty {}
      }`,
    ],
    [
      'deep nesting 4 levels (finding L10)',
      `package Dn {
        part a {
          part b {
            part c {
              part d;
            }
          }
        }
      }`,
    ],
    [
      'quoted name with escaped quote (finding L10)',
      `package Sq {
        part 'Price of X (US\\'O\\'Clock estimate)';
      }`,
    ],
    [
      'doc-commented definition (finding L10)',
      `package Dc {
        part def Motor {
          doc /* A powered rotational actuator */
        }
      }`,
    ],
    [
      'keyword-less enum literals keep no ref keyword (F5 residual)',
      `package En {
        enum def Gear {
          low = 0.25;
          high = 1;
        }
      }`,
    ],
    [
      'explicit ref prefix keeps the ref keyword (F5 residual)',
      `package Rf {
        part def A;
        ref x :>> A;
      }`,
    ],
    [
      'message and rendering keywords map to eClasses (C9-residual follow-up)',
      `package Mr {
        message def M;
        message m;
        rendering def R;
        rendering r;
      }`,
    ],
    [
      'assign := and attribute := keep the initial-value operator (F-follow-up)',
      `package Av {
        action def A {
          assign x := 5;
        }
        part def X {
          attribute a := 3;
        }
      }`,
    ],
    [
      'value units: compound, quoted, qualified and prefixed spellings',
      `package Un {
        attribute energy : ISQ::EnergyValue = 640.0 ['W\u22c5h'];
        attribute cruise : ISQ::SpeedValue = 25.0 [SI::'metre per second'];
        attribute link : ISQ::BinaryDigitRateValue = 100.0 [Mbit/s];
        attribute panel : ISQ::AreaValue = 1.5 ['m\u00b2'];
      }`,
    ],
    [
      'alias/bind bodies and doc names survive (F-follow-up)',
      `package Ab {
        part a;
        alias b for a {
          doc /* the aliased part */
        }
        bind c = a {
          doc /* bound connector */
        }
        doc overview /* the big picture */
      }`,
    ],
    [
      'a comment keeps its name, its about targets and its locale',
      `package Cm {
        part def Engine;
        part def Wheel;
        comment Note about Engine, Wheel locale "en-GB" /* what the reader should know */
      }`,
    ],
    [
      'a quote inside a locale or a language tag survives the save',
      `package Cq {
        comment N locale "en\\"GB" /* an awkward tag */
        rep R language "a\\"b" /* an awkward language */
      }`,
    ],
  ];

  for (const [label, src] of snippets) {
    it(`round-trips: ${label}`, () => {
      const { model, diagnostics } = parseModel(src);
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      roundTrip(model);
    });
  }

  it('is idempotent across two serialize/parse cycles', () => {
    const m = buildSampleModel();
    const once = serializeModel(m);
    const twice = serializeModel(parseModel(once).model);
    expect(twice).toBe(once);
  });
});

describe('round-trip — specialization relationships built from the model', () => {
  /** Count relationship elements of a given metaclass. */
  function count(model: Model, eClass: string): number {
    return model.all().filter((e) => e.eClass === eClass).length;
  }

  it('emits & reparses FeatureTyping / Subclassification / Subsetting / Redefinition / ReferenceSubsetting', () => {
    // A model wired ENTIRELY from real specialization RELATIONSHIP elements
    // (no `attrs.type` shortcut), mirroring how the standard library is built.
    const model = new Model();
    const f = new ModelFactory(model);
    const pkg = f.pkg('Units');
    const lengthUnit = f.attributeDef('LengthUnit', pkg.id);
    // Attribute typed by a RESOLVABLE type → a FeatureTyping element (as in the
    // library), not an `attrs.type` string.
    const metre = model.create('AttributeUsage', { declaredName: 'metre', ownerId: pkg.id });
    f.featureTyping(metre.id, lengthUnit.id);

    const base = f.partDef('Base', pkg.id);
    const derived = f.partDef('Derived', pkg.id);
    f.subclassification(derived.id, base.id); // `:>` on a definition

    const car = f.partDef('Car', pkg.id);
    const chassis = f.part('chassis', car.id);
    f.featureTyping(chassis.id, base.id); // `part chassis : Base`
    const subChassis = f.part('subChassis', car.id);
    f.subsetting(subChassis.id, chassis.id); // `:>` on a usage → Subsetting
    const redefChassis = f.part('redefChassis', car.id);
    f.redefinition(redefChassis.id, chassis.id); // `:>>`
    const refChassis = f.part('refChassis', car.id);
    model.create('ReferenceSubsetting', {
      ownerId: refChassis.id,
      source: [refChassis.id],
      target: [chassis.id],
    }); // `::>`

    const text = serializeModel(model);
    expect(text).toContain('attribute metre : LengthUnit');
    expect(text).toContain(':>');
    expect(text).toContain(':>>');
    expect(text).toContain('::>');

    const rt = roundTrip(model);

    // The relationship elements are reproduced (not collapsed to attrs).
    for (const cls of [
      'FeatureTyping',
      'Subclassification',
      'Subsetting',
      'Redefinition',
      'ReferenceSubsetting',
    ]) {
      expect(count(rt, cls), `${cls} count`).toBe(count(model, cls));
    }
    // The attribute typing survives as a FeatureTyping element, NOT attrs.type.
    const rtMetre = rt.all().find((e) => e.declaredName === 'metre')!;
    expect(rtMetre.attrs.type).toBeUndefined();
    expect(rt.children(rtMetre.id).some((c) => c.eClass === 'FeatureTyping')).toBe(true);
  });
});

describe('serializer — the reference form the resolver agrees with', () => {
  it('re-emits the SIMPLE name for a binding reached by import or inheritance', () => {
    // `refTo` used to test simple-name sufficiency with an owned-only walk that
    // knew nothing of imports or inheritance, so it fell back to a qualified
    // path for names that resolve perfectly well on their own — text nobody
    // wrote. It asks the resolver now, so "the simple name is enough" means
    // exactly "re-parsing it binds the same element".
    const imported = parseModel(
      `package Lib { part def Widget; }\npackage Use { import Lib::*; part w : Widget; }`,
    ).model;
    expect(serializeModel(imported)).toContain('part w : Widget;');

    const inherited = parseModel(
      `package P { part def D { part a; } part def E :> D { part b :>> a; } }`,
    ).model;
    expect(serializeModel(inherited)).toContain('part b :>> a;');
  });

  it('tests a `:>>` with the rule the RE-PARSE uses, not full resolution', () => {
    // `E` has two direct generals. Full resolution answers `a` with `D3::a`
    // (nearest general first), the §8.2.3.5.1 redefinition rule with `D::a`
    // (the FIRST direct general, through its own supertype). Testing simple-name
    // sufficiency with the wrong one emitted a bare `a` that re-parsed to the
    // OTHER element: a save/reload silently retargeted the Redefinition.
    const src = `package P {
  part def D { part a; }
  part def D2 :> D;
  part def D3 { part a; }
  part def E :> D2, D3 { part b :>> D3::a; }
}`;
    const m1 = parseModel(src).model;
    const bound = (m: Model): string => {
      const b = m.all().find((e) => e.declaredName === 'b')!;
      const red = m.children(b.id).find((c) => c.eClass === 'Redefinition')!;
      return m.qualifiedName((red.target ?? [])[0]);
    };
    expect(bound(m1)).toBe('P::D3::a');
    const t1 = serializeModel(m1);
    const m2 = parseModel(t1).model;
    expect(bound(m2)).toBe('P::D3::a');
    expect(serializeModel(m2)).toBe(t1);
  });

  it('re-emits `part w :>> w;` as the author wrote it', () => {
    // The canonical redefinition: the simple name IS enough, because the
    // redefinition rule excludes the redefining feature that shadows it.
    const model = parseModel(
      `package P { part def Base { part w; } part def Car :> Base { part w :>> w; } }`,
    ).model;
    expect(serializeModel(model)).toContain('part w :>> w;');
  });

  it('the `redefinition …` STATEMENT binds like the inline form', () => {
    // Same construct, two spellings. The statement used to resolve its target
    // with plain full resolution, so it bound to the redefining feature itself
    // and reported `specialization-cycle` — an error that vanished after one
    // save, because the serialized text is the inline form.
    const { model, diagnostics } = parseModel(
      `package P { part def Base { part w; } part def Car :> Base { part w; redefinition w redefines w; } }`,
    );
    expect(diagnostics.map((d) => d.code ?? d.message)).toEqual([]);
    const red = model.all().find((e) => e.eClass === 'Redefinition')!;
    expect(model.qualifiedName((red.target ?? [])[0])).toBe('P::Base::w');
    expect(model.qualifiedName((red.source ?? [])[0])).toBe('P::Car::w');
  });

  it('still qualifies a reference the simple name would not reach', () => {
    const model = parseModel(
      `package P { part def A { part def Inner; } part def B { part i : P::A::Inner; } }`,
    ).model;
    const text = serializeModel(model);
    expect(text).toContain('A::Inner');
    // …and the qualified form re-parses to the same element.
    const again = parseModel(text).model;
    const i = again.all().find((e) => e.declaredName === 'i')!;
    expect(again.qualifiedName(again.typesOf(i.id)[0].id)).toBe('P::A::Inner');
  });
});

describe('round-trip — relationship statements (C9-residual sweep)', () => {
  function count(model: Model, eClass: string): number {
    return model.all().filter((e) => e.eClass === eClass).length;
  }

  it('a specialization child with no statement form does not force an empty body', () => {
    // A `Conjugation` is a specialization but has no relationship-statement form,
    // so it serializes to '' as a body member — which must not spuriously emit
    // `{ }`. (Model-built; the parser cannot produce this.)
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('P');
    const a = f.partDef('A', pkg.id);
    const b = f.partDef('B', pkg.id);
    // A non-inlineable spec relationship (source ≠ its owner) with no text form.
    m.create('Conjugation', { ownerId: pkg.id, source: [a.id], target: [b.id] });
    const out = serializeModel(m);
    expect(out).not.toMatch(/\{\s*\}/); // no empty body
    expect(out).not.toMatch(/\n\n\n/); // no stray blank line
    // And it still round-trips (the Conjugation is simply not textual).
    expect(() => parseModel(out)).not.toThrow();
  });

  it('subtype/subclassifier statements on definitions build & round-trip Subclassification', () => {
    // Before the fix, `subtype A specializes B;` built a Subsetting whose
    // re-parse (inlined as `part def A :> B;`) came back as a
    // Subclassification — the element class flipped across the round-trip.
    const { model, diagnostics } = parseModel(`
      package P {
        part def A;
        part def B;
        subtype A specializes B;
      }
    `);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(count(model, 'Subclassification')).toBe(1);
    expect(count(model, 'Subsetting')).toBe(0);
    roundTrip(model);
  });

  it('a forward-declared subtype source is upgraded to Subclassification by the deferred pass', () => {
    const { model, diagnostics } = parseModel(`
      package P {
        subtype A specializes B;
        part def A;
        part def B;
      }
    `);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(count(model, 'Subclassification')).toBe(1);
    expect(count(model, 'Subsetting')).toBe(0);
    roundTrip(model);
  });

  it('a redefinition statement whose target is INHERITED binds and inlines', () => {
    // `a` lives on the supertype D. The parse-time resolver used to know
    // nothing of inherited members, so the target stayed textual and the
    // relationship could not be inlined; it now binds to `D::a` and re-emits as
    // the `:>>` the author could have written.
    const { model } = parseModel(`
      package P {
        part def D { part a; }
        part def E :> D {
          part b;
          redefinition b redefines a;
        }
      }
    `);
    expect(count(model, 'Redefinition')).toBe(1);
    const red = model.all().find((e) => e.eClass === 'Redefinition')!;
    expect(model.qualifiedName((red.target ?? [])[0])).toBe('P::D::a');
    const text = serializeModel(model);
    expect(text).toContain('part b :>> a;');
    const { model: m2, diagnostics } = parseModel(text);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(count(m2, 'Redefinition')).toBe(1);
    // Fixpoint: a second round-trip reproduces the same text.
    expect(serializeModel(m2)).toBe(text);
  });

  it('a redefinition statement with an ABSENT target survives round-trip', () => {
    // The statement form has to survive when the target genuinely does not
    // exist: the serializer used to DROP the Redefinition (not inlineable,
    // filtered from body members), losing the author's text outright.
    const { model } = parseModel(`
      package P {
        part def D { part a; }
        part def E :> D {
          part b;
          redefinition b redefines Nope;
        }
      }
    `);
    expect(count(model, 'Redefinition')).toBe(1);
    const text = serializeModel(model);
    expect(text).toContain('redefinition');
    expect(text).toContain('Nope');
    const { model: m2, diagnostics } = parseModel(text);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(count(m2, 'Redefinition')).toBe(1);
    expect(serializeModel(m2)).toBe(text);
  });

  it('an allocation with an ABSENT endpoint keeps the name', () => {
    // `mapAllocate` now records an unresolved end as a NAME instead of dropping
    // it, so the statement survives instead of re-emitting as a half line.
    const { model, diagnostics } = parseModel(`package P {
      part a;
      allocate a to Missing;
    }`);
    expect(diagnostics.map((d) => d.code)).toEqual(['ref/unresolved-allocation-end']);
    const alloc = model.all().find((e) => e.eClass === 'Allocation')!;
    expect(alloc.attrs.targetRef).toBe('Missing');
    const text = serializeModel(model);
    expect(text).toContain('allocate a to Missing;');
    expect(serializeModel(parseModel(text).model)).toBe(text);
  });

  it('a typing statement with an unresolved target survives round-trip', () => {
    const { model } = parseModel(`
      package P {
        part x;
        typing x : Missing;
      }
    `);
    expect(count(model, 'FeatureTyping')).toBe(1);
    const text = serializeModel(model);
    expect(text).toContain('typing');
    const { model: m2 } = parseModel(text);
    expect(count(m2, 'FeatureTyping')).toBe(1);
    expect(serializeModel(m2)).toBe(text);
  });

  it('a fully-dangling root-level subset statement is not emitted as a bare eClass', () => {
    // Before the fix this serialized as `Subsetting;`, which re-parsed as a
    // ReferenceUsage NAMED "Subsetting" — active corruption, not just a drop.
    const { model } = parseModel('subset nope subsets alsoNope;');
    expect(count(model, 'Subsetting')).toBe(1);
    const text = serializeModel(model);
    expect(text).toBe('subset nope :> alsoNope;');
    const { model: m2 } = parseModel(text);
    expect(count(m2, 'Subsetting')).toBe(1);
    expect(count(m2, 'ReferenceUsage')).toBe(0);
    expect(serializeModel(m2)).toBe(text);
  });

  it('rendering def parses and round-trips (was: Unknown keyword / bare eClass)', () => {
    const { model, diagnostics } = parseModel('rendering def R;');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(count(model, 'RenderingDefinition')).toBe(1);
    const text = serializeModel(model);
    expect(text).toBe('rendering def R;');
    roundTrip(model);
  });

  it('consolidating sweep: previously-suspect statement kinds keep their element multiset', () => {
    // One snippet per dedicated-statement family flagged by the C9 sweep
    // (behaviour actions, state subactions, loops/if, requirement clauses,
    // relationship statements, endpoint statements, control nodes). The
    // parse → serialize → parse element-eClass multiset must be identical and
    // the serialized text must never contain a bare metaclass token.
    const src = `
      package Sweep {
        item def Sig;
        part a;
        part b;
        requirement req1;
        action def Act {
          accept s : Sig;
          send Sig to a;
          assign x := 5;
          perform subAct;
          terminate;
          while x > 0 { action tick; }
          for i in 1..3 { action step; }
          if ready { action go; } else { action wait; }
          fork f; join j; merge m; decide d;
          return result = 1;
          first tick then step;
        }
        state def Mach {
          entry init;
          do work;
          exit teardown;
          transition first init if ready then work;
        }
        use case def UC { actor user; objective obj; include useCaseX; }
        verification def VC { verify requirement req1; }
        requirement def RD { subject subj; require constraint { 1 > 0 } assume constraint { 2 > 1 } }
        connect a to b;
        bind a = b;
        binding a of Sig = b;
        allocate a to b;
        satisfy req1 by a;
        trace req1 to b;
        subset a subsets b;
        disjoint a from b;
        flow of Sig from a to b;
        dependency a to b;
        alias aa for a;
      }
    `;
    const p1 = parseModel(src);
    expect(p1.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const text = serializeModel(p1.model);
    const p2 = parseModel(text);
    expect(p2.diagnostics.filter((d) => d.severity === 'error'), text).toEqual([]);
    const multiset = (m: Model): Map<string, number> => {
      const out = new Map<string, number>();
      for (const el of m.all()) {
        if (el.attrs.implicit === true) continue;
        out.set(el.eClass, (out.get(el.eClass) ?? 0) + 1);
      }
      return out;
    };
    const m1 = multiset(p1.model);
    const m2 = multiset(p2.model);
    const diff: string[] = [];
    for (const k of new Set([...m1.keys(), ...m2.keys()])) {
      if ((m1.get(k) ?? 0) !== (m2.get(k) ?? 0)) diff.push(`${k}: ${m1.get(k) ?? 0} -> ${m2.get(k) ?? 0}`);
    }
    expect(diff, text).toEqual([]);
    // No line of the serialized text is a bare metaclass name.
    for (const el of p1.model.all()) {
      expect(text).not.toMatch(new RegExp(`^\\s*${el.eClass}\\b`, 'm'));
    }
  });
});

describe('round-trip — H17 attributes survive serialization (wave 1)', () => {
  /** parse → serialize → parse, asserting a clean parse each way. */
  function reparse(src: string): Model {
    const { model, diagnostics } = parseModel(src);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const text = serializeModel(model);
    const rt = parseModel(text);
    expect(rt.diagnostics.filter((d) => d.severity === 'error'), text).toEqual([]);
    return rt.model;
  }
  const find = (m: Model, name: string): ElementRecord =>
    m.all().find((e) => e.declaredName === name)!;

  it('preserves visibility keywords', () => {
    const m = reparse(
      `package V { public part def A; private part b : A; protected attribute x : A; }`,
    );
    expect(find(m, 'A').attrs.visibility).toBe('public');
    expect(find(m, 'b').attrs.visibility).toBe('private');
    expect(find(m, 'x').attrs.visibility).toBe('protected');
  });

  it('preserves prefix metadata (#) and feature modifiers (ordered / nonunique)', () => {
    const m = reparse(
      `package M { #Safety part def Critical; attribute readings : Real ordered nonunique; }`,
    );
    expect(find(m, 'Critical').attrs.metadata).toEqual(['Safety']);
    expect(find(m, 'readings').attrs.modifiers).toEqual(['ordered', 'nonunique']);
  });

  it('preserves import visibility and filters', () => {
    const m = reparse(`package I { private import Lib::Common; import Lib::All::*[x > 0]; }`);
    const priv = m
      .all()
      .find((e) => e.eClass === 'MembershipImport' && e.attrs.visibility === 'private');
    expect(priv, 'private import present').toBeTruthy();
    const filtered = m.all().find((e) => Array.isArray(e.attrs.filters));
    expect(filtered?.attrs.filters).toEqual(['x > 0']);
  });

  it('preserves a free-standing block comment as a TextualRepresentation', () => {
    const m = reparse(`package C { /* a free-standing note */ part p; }`);
    const rep = m.all().find((e) => e.eClass === 'TextualRepresentation');
    expect(rep, 'TextualRepresentation created').toBeTruthy();
    expect(String(rep?.attrs.body)).toContain('a free-standing note');
  });

  it('preserves behavior action kind, via and target', () => {
    const m = reparse(`package B { action def P { send msg via port to rcv; } }`);
    const send = m.all().find((e) => e.attrs.actionKind === 'send')!;
    expect(send.eClass).toBe('SendActionUsage');
    expect(send.attrs.via).toBe('port');
    expect(send.attrs.actionTarget).toBe('rcv');
  });

  it('preserves loop kind, variable, type and collection', () => {
    const m = reparse(`package L { action def R { for i : Int in items { action s; } } }`);
    const loop = m.all().find((e) => e.attrs.loopKind === 'for')!;
    expect(loop.attrs.loopVar).toBe('i');
    expect(loop.attrs.loopVarType).toBe('Int');
    expect(loop.attrs.collection).toBe('items');
  });

  it('preserves if condition, hasElse, and then/target forms', () => {
    const body = reparse(`package C { action def D { if ready { action go; } else { action stop; } } }`);
    const ifb = body.all().find((e) => e.eClass === 'IfActionUsage')!;
    expect(ifb.attrs.condition).toBe('ready');
    expect(ifb.attrs.hasElse).toBe(true);
    const tgt = reparse(`package C2 { action def R { if go finish; } }`);
    const ift = tgt.all().find((e) => e.eClass === 'IfActionUsage')!;
    expect(ift.attrs.thenTarget).toBe('finish');
  });

  it('preserves requirement clause roles and metadata annotations', () => {
    const m = reparse(`package R { part v; requirement <R1> req { subject v; require { m < 1 } } }`);
    expect(m.all().some((e) => e.attrs.requirementRole === 'subject')).toBe(true);
    expect(m.all().some((e) => e.attrs.requirementRole === 'require')).toBe(true);
    const a = reparse(`package A { part def C; @Safety about C; }`);
    const ann = a.all().find((e) => e.eClass === 'MetadataUsage' && e.attrs.annotation === true)!;
    expect(ann.attrs.type).toBe('Safety');
    expect(ann.attrs.about).toEqual(['C']);
  });

  it('resolves a forward disjoint / subset target and leaves genuine typos unresolved (F4)', () => {
    // Forward disjoint: the Disjoining's target resolves to the later sibling.
    const dj = reparse(`package D { part def A; disjoint A from B; part def B; }`);
    const disj = dj.all().find((e) => e.eClass === 'Disjoining')!;
    expect((disj.target ?? []).length).toBe(1);
    expect(disj.attrs.targetRef).toBeUndefined();

    // Forward subsetting statement: source + target both resolve, relationship kept.
    const sub = reparse(`package S { part a; subset a subsets b; part b; }`);
    const ss = sub.all().find((e) => e.eClass === 'Subsetting')!;
    expect((ss.source ?? []).length).toBe(1);
    expect((ss.target ?? []).length).toBe(1);
    expect(ss.attrs.targetRef).toBeUndefined();

    // Node-level forward `:>` on a feature declaration → materialized Subsetting.
    const nodeSpec = reparse(`package N { part x :> y; part y; }`);
    const x = nodeSpec.all().find((e) => e.declaredName === 'x')!;
    expect(x.attrs.specializes).toBeUndefined();
    expect(nodeSpec.children(x.id).some((c) => c.eClass === 'Subsetting')).toBe(true);

    // A genuinely-absent target stays a textual ref (no false resolution).
    const miss = parseModel(`package M { part a; subset a subsets Nope; }`).model;
    const missSub = miss.all().find((e) => e.eClass === 'Subsetting')!;
    expect(missSub.attrs.targetRef).toBe('Nope');
    expect((missSub.target ?? []).length).toBe(0);
    // Round-trip (R6): the unresolvable target is re-emitted as textual ref.
    const missText = serializeModel(miss);
    expect(missText).toContain('subset');
    expect(missText).toContain('Nope');
    expect(missText).toContain(':>');
    const { model: miss2 } = parseModel(missText);
    const missSub2 = miss2.all().find((e) => e.eClass === 'Subsetting')!;
    expect(missSub2.attrs.targetRef).toBe('Nope');
    expect(missSub2.target).toEqual([]);

    // A forward typing to something IN THIS FILE is resolved by parseModel:
    // `resolveTypeReferences` is for LIBRARY content, not for declaration
    // order. (It used to be left textual, which is what made the same name mean
    // different things depending on where it was written.)
    const typed = reparse(`package T { part p : Later; part def Later; }`);
    const p = typed.all().find((e) => e.declaredName === 'p')!;
    expect(p.attrs.type ?? p.attrs.typeRef).toBeUndefined();
    expect(typed.qualifiedName(typed.typesOf(p.id)[0].id)).toBe('T::Later');
    // A typing whose target is genuinely absent still keeps its textual ref.
    const missTyped = parseModel(`package T { part p : Nope; }`).model;
    const mp = missTyped.all().find((e) => e.declaredName === 'p')!;
    expect(mp.attrs.typeRef).toBe('Nope');
  });

  it('preserves multi-client/supplier dependencies and flow payload', () => {
    const dep = reparse(`package D { part a; part b; part c; part d; dependency a, b to c, d; }`);
    const d = dep.all().find((e) => e.eClass === 'Dependency')!;
    expect(d.attrs.clients).toEqual(['a', 'b']);
    expect(d.attrs.suppliers).toEqual(['c', 'd']);
    const fl = reparse(`package F { item def Fuel; part a; part b; flow of Fuel from a to b; }`);
    const f = fl.all().find((e) => e.eClass === 'Flow')!;
    expect(f.attrs.payload).toBe('Fuel');
    expect((f.source ?? []).length).toBe(1);
    expect((f.target ?? []).length).toBe(1);
  });

  it('does not attach a resolved target to a dangling-source specialization (F4 D1)', () => {
    const m = parseModel(`package P { subset Nope subsets b; part b; }`).model;
    const text = serializeModel(m);
    // The package must NOT gain a specialization header from the dangling stmt.
    expect(text).not.toMatch(/package P\s*:/);
    // And no false Subclassification (source = the package) appears on reparse.
    expect(parseModel(text).model.all().some((e) => e.eClass === 'Subclassification')).toBe(false);
  });

  it('resolves a forward ref against its original lexical scope, not a re-homed owner (F4 D2)', () => {
    const m = parseModel(`package P { subset a subsets b; part a { part b; } part b; }`).model;
    const sub = m.all().find((e) => e.eClass === 'Subsetting')!;
    const tgt = m.get((sub.target ?? [])[0]!);
    const pkg = m.roots().find((r) => r.declaredName === 'P')!;
    // `b` must be the OUTER P::b (statement's lexical scope), not the inner a::b.
    expect(tgt?.ownerId).toBe(pkg.id);
  });

  it('rebuilds all endpoints of a multi-client/supplier dependency (F4 D3)', () => {
    const m = parseModel(`package D { dependency a, b to c, d; part a; part b; part c; part d; }`).model;
    const dep = m.all().find((e) => e.eClass === 'Dependency')!;
    expect((dep.source ?? []).length).toBe(2);
    expect((dep.target ?? []).length).toBe(2);
  });

  it('does not self-resolve a self-alias (F4 D4)', () => {
    const m = parseModel(`package A { alias x for x; }`).model;
    const alias = m.all().find((e) => e.eClass === 'Membership' && e.declaredName === 'x')!;
    expect((alias.target ?? [])[0]).not.toBe(alias.id);
  });

  it('keeps else-body members when the then-branch is a bare target', () => {
    const m = reparse(`package P { action def D { action finish; if go finish; else { action cleanup; } } }`);
    // The else-body `cleanup` must survive (it is the only body member).
    expect(m.all().some((e) => e.declaredName === 'cleanup')).toBe(true);
    const ifEl = m.all().find((e) => e.eClass === 'IfActionUsage')!;
    expect(ifEl.attrs.thenTarget).toBe('finish');
    expect(ifEl.attrs.hasElse).toBe(true);
  });

  it('preserves a dependency short name', () => {
    const m = reparse(`package P { part a; part b; dependency <D1> from a to b; }`);
    const dep = m.all().find((e) => e.eClass === 'Dependency')!;
    expect(dep.declaredShortName).toBe('D1');
  });

  it('preserves conjugation `~` on an unresolved typing', () => {
    const m = reparse(`package P { port p : ~SomePort; }`);
    const p = m.all().find((e) => e.declaredName === 'p')!;
    expect(p.attrs.conjugated).toBe(true);
  });

  it('quotes declared names with spaces or reserved words', () => {
    const m = reparse(`package Q { part 'my part'; attribute 'true'; }`);
    expect(m.all().some((e) => e.declaredName === 'my part'), 'spaced name survives').toBe(true);
    expect(m.all().some((e) => e.declaredName === 'true'), 'reserved-word name survives').toBe(true);
  });

  it('quotes names equal to grammar keywords', () => {
    const m = reparse(`package K { part 'if'; part 'var'; attribute 'to'; }`);
    for (const n of ['if', 'var', 'to']) {
      expect(m.all().some((e) => e.declaredName === n), `keyword-name ${n} survives`).toBe(true);
    }
  });

  it('round-trips the binding form with a payload (source-less bind)', () => {
    const m = reparse(`package B { part a; item def Pay; binding of Pay = a; }`);
    const bind = m.all().find((e) => e.eClass === 'BindingConnectorAsUsage')!;
    expect(bind.attrs.ofPayload).toBe('Pay');
  });

  it('preserves conjugation on an unresolved subsetting', () => {
    const m = reparse(`package C { part x :> ~Missing; }`);
    const x = m.all().find((e) => e.declaredName === 'x')!;
    expect(x.attrs.conjugated).toBe(true);
  });

  it('preserves conjugation on an unresolved attribute typing (: ~Real)', () => {
    const m = reparse(`package C { attribute a : ~Real; }`);
    const a = m.all().find((e) => e.declaredName === 'a')!;
    expect(a.attrs.conjugated).toBe(true);
    expect(a.attrs.type).toBe('Real');
  });

  it('resolves a reference to a quoted dotted name without shattering it (F7)', () => {
    const m = reparse(`package P { part 'a.b'; part u : 'a.b'; }`);
    const u = m.all().find((e) => e.declaredName === 'u')!;
    // The `: 'a.b'` typing resolved to the 'a.b' part → a FeatureTyping child
    // (not a raw typeRef), proving the `.` inside the quotes was not split.
    expect(m.children(u.id).some((c) => c.eClass === 'FeatureTyping')).toBe(true);
    expect(u.attrs.typeRef).toBeUndefined();
  });

  it('round-trips bind, disjoint and alias elements', () => {
    const b = reparse(`package B { part a; part b; bind a = b; }`);
    expect(b.all().some((e) => e.eClass === 'BindingConnectorAsUsage')).toBe(true);
    const d = reparse(`package D { part def A; part def B; disjoint A from B; }`);
    expect(d.all().some((e) => e.eClass === 'Disjoining')).toBe(true);
    const al = reparse(`package A { part a; alias b for a; }`);
    const alias = al.all().find((e) => e.eClass === 'Membership' && e.declaredName === 'b');
    expect(alias, 'alias Membership present').toBeTruthy();
  });
});

describe('round-trip — requirement cross-relationships (verify / refine / trace / derive)', () => {
  const KINDS = ['Verify', 'Refine', 'Trace', 'Derive'] as const;
  /** Surface syntax per kind: statement keyword + endpoint preposition. */
  const SYNTAX: Record<(typeof KINDS)[number], [keyword: string, prep: string]> = {
    Verify: ['verify', 'by'],
    Refine: ['refine', 'by'],
    Trace: ['trace', 'to'],
    Derive: ['derive', 'from'],
  };

  function count(model: Model, eClass: string): number {
    return model.all().filter((e) => e.eClass === eClass).length;
  }

  it('serializes model-built relationships as proper statements (never a bare eClass)', () => {
    const model = new Model();
    const pkg = model.create('Package', { declaredName: 'P' });
    const req = model.create('RequirementUsage', { declaredName: 'R', ownerId: pkg.id });
    const elem = model.create('PartUsage', { declaredName: 'X', ownerId: pkg.id });
    for (const k of KINDS) {
      // Direction contract (uniform with Satisfy): source = related element,
      // target = requirement.
      model.create(k, { ownerId: pkg.id, source: [elem.id], target: [req.id] });
    }
    const text = serializeModel(model);
    for (const k of KINDS) {
      const [kw, prep] = SYNTAX[k];
      expect(text).toContain(`${kw} R ${prep} X;`);
      expect(text).not.toMatch(new RegExp(`^\\s*${k};?$`, 'm'));
    }
    roundTrip(model);
  });

  it('parses the textual forms with source = element and target = requirement', () => {
    const { model, diagnostics } = parseModel(`
      package Q {
        requirement <'REQ-1'> R1;
        requirement R2;
        part X;
        verification def VC;
        action A;
        verify R1 by VC;
        refine requirement R1 by A;
        trace R1 to X;
        derive R2 from R1;
      }
    `);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const expected: Array<[(typeof KINDS)[number], string, string]> = [
      ['Verify', 'VC', 'R1'],
      ['Refine', 'A', 'R1'],
      ['Trace', 'X', 'R1'],
      ['Derive', 'R1', 'R2'],
    ];
    for (const [k, srcName, tgtName] of expected) {
      const rels = model.all().filter((e) => e.eClass === k);
      expect(rels, `${k} count`).toHaveLength(1);
      const [rel] = rels;
      expect(model.get(rel.source![0])?.declaredName, `${k} source`).toBe(srcName);
      expect(model.get(rel.target![0])?.declaredName, `${k} target`).toBe(tgtName);
    }
    // Full round-trip and serialize fixpoint.
    const rt = roundTrip(model);
    expect(serializeModel(rt)).toBe(serializeModel(model));
  });

  it('resolves forward-referenced endpoints via the deferred pass (like Satisfy)', () => {
    const { model, diagnostics } = parseModel(`
      package F {
        verify R by X;
        derive R from X;
        requirement R;
        part X;
      }
    `);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    for (const k of ['Verify', 'Derive']) {
      const rel = model.all().find((e) => e.eClass === k)!;
      expect(model.get(rel.source![0])?.declaredName, `${k} source`).toBe('X');
      expect(model.get(rel.target![0])?.declaredName, `${k} target`).toBe('R');
      expect(rel.attrs.sourceRef).toBeUndefined();
      expect(rel.attrs.targetRef).toBeUndefined();
    }
    roundTrip(model);
  });

  it('degrades gracefully on a genuinely-unresolvable endpoint (textual ref survives)', () => {
    const { model } = parseModel(`
      package U {
        requirement R;
        verify R by Missing;
        derive Nowhere from R;
      }
    `);
    const v = model.all().find((e) => e.eClass === 'Verify')!;
    expect(v.source ?? []).toHaveLength(0);
    expect(v.attrs.sourceRef).toBe('Missing');
    const d = model.all().find((e) => e.eClass === 'Derive')!;
    expect(d.target ?? []).toHaveLength(0);
    expect(d.attrs.targetRef).toBe('Nowhere');

    const text = serializeModel(model);
    expect(text).toContain('verify R by Missing;');
    expect(text).toContain('derive Nowhere from R;');
    const { model: m2 } = parseModel(text);
    expect(count(m2, 'Verify')).toBe(1);
    expect(count(m2, 'Derive')).toBe(1);
    expect(serializeModel(m2)).toBe(text);
  });

  it('does not hijack the nested requirement-clause forms (verify inside a body)', () => {
    const { model, diagnostics } = parseModel(`
      verification def V {
        subject s : System;
        verify requirement R;
      }
    `);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // `verify requirement R;` (no `by` tail) is still a RequirementClause
    // member, NOT a Verify relationship.
    expect(count(model, 'Verify')).toBe(0);
    const clause = model.all().find((e) => e.attrs.requirementRole === 'verify');
    expect(clause?.eClass).toBe('ConstraintUsage');
    expect(clause?.declaredName).toBe('R');
  });
});

describe('round-trip — a comment keeps what it points at', () => {
  /** parse → serialize → parse, asserting a clean parse each way. */
  function reparse(src: string): { text: string; model: Model } {
    const { model, diagnostics } = parseModel(src);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const text = serializeModel(model);
    const rt = parseModel(text);
    expect(rt.diagnostics.filter((d) => d.severity === 'error'), text).toEqual([]);
    return { text, model: rt.model };
  }
  const comment = (m: Model): ElementRecord => m.all().find((e) => e.eClass === 'Comment')!;

  it('keeps the comment name', () => {
    const { text, model } = reparse(`package C { comment Note /* a human explanation */ }`);
    expect(text).toContain('comment Note /* a human explanation */');
    expect(comment(model).declaredName).toBe('Note');
  });

  it('keeps the about targets, in order', () => {
    const { text, model } = reparse(
      `package C { part def Engine; part def Wheel; comment about Engine, Wheel /* both */ }`,
    );
    expect(text).toContain('comment about Engine, Wheel /* both */');
    expect(comment(model).attrs.about).toEqual(['Engine', 'Wheel']);
  });

  it('keeps the locale', () => {
    const { text, model } = reparse(`package C { comment locale "en-GB" /* a lift, not a lorry */ }`);
    expect(text).toContain('comment locale "en-GB" /* a lift, not a lorry */');
    expect(comment(model).attrs.locale).toBe('en-GB');
  });

  it('keeps all three together, and is idempotent', () => {
    const src = `package C {
      part def Engine;
      part def Wheel;
      comment Note about Engine, Wheel locale "en-GB" /* what the reader should know */
    }`;
    const { text, model } = reparse(src);
    expect(text).toContain(
      'comment Note about Engine, Wheel locale "en-GB" /* what the reader should know */',
    );
    const c = comment(model);
    expect(c.declaredName).toBe('Note');
    expect(c.attrs.about).toEqual(['Engine', 'Wheel']);
    expect(c.attrs.locale).toBe('en-GB');
    expect(serializeModel(model)).toBe(text);
  });

  it('quotes a comment name the grammar cannot read bare, so it comes back as a name', () => {
    // The grammar's `Name` is `ID | UNRESTRICTED_NAME | SoftKeyword`, so a HARD
    // keyword and a name with a space in it only survive quoted. Unquoted,
    // `comment part /* … */` is a mismatched token and the name is lost
    // outright — which is the loss this asserts against, not the quote marks.
    for (const name of ['part', 'my note']) {
      const { text, model } = reparse(`package C { comment '${name}' /* a note */ }`);
      expect(text).toContain(`comment '${name}' /* a note */`);
      expect(comment(model).declaredName).toBe(name);
    }
  });

  it('escapes a locale that contains a quote or a backslash', () => {
    // The value came out of a STRING terminal, so it may contain that
    // terminal's own delimiters. Written bare, `"en"GB"` ends the string early
    // and the re-parse dies on `lexer/unterminated-string`, taking the rest of
    // the file into recovery — reparse() asserts a clean re-parse, and these
    // two assertions say the value itself came back whole.
    for (const tag of ['en"GB', 'en\\GB']) {
      const { model } = reparse(`package C { comment N locale ${JSON.stringify(tag)} /* b */ }`);
      expect(comment(model).attrs.locale).toBe(tag);
    }
  });

  it('keeps an empty locale, and a blank name, rather than laundering them away', () => {
    // Presence, not truth. `locale ""` is a tag the author wrote; `comment ''`
    // is a name the validator reports as blank. A save that quietly deleted
    // either would erase the very evidence a reader needs — for the blank name,
    // its own error.
    const { text, model } = reparse(`package C { comment '' locale "" /* b */ }`);
    expect(text).toContain(`comment '' locale "" /* b */`);
    expect(comment(model).declaredName).toBe('');
    expect(comment(model).attrs.locale).toBe('');
    expect(validate(model).some((d) => d.ruleId === 'blank-name')).toBe(true);
  });

  /**
   * The same claim, across the forms that make it.
   *
   * The blank-name fix landed on the Comment branch alone, and the assertion
   * above could not tell: every other declaration form still collapsed `''`
   * into "anonymous" on save, so an error the checker had just reported came
   * back OK from the saved file. One case per emitting site, so the title above
   * stops promising more than it checks.
   */
  it.each([
    ['definition', `package C { part def '' ; }`, `part def ''`],
    ['usage', `package C { part def A; part '' : A; }`, `part '' : A`],
    ['package', `package '' { part def A; }`, `package ''`],
    ['doc', `package C { doc '' /* x */ }`, `doc '' /* x */`],
    ['rep', `package C { rep '' language "js" /* x */ }`, `rep '' language "js"`],
    ['comment', `package C { comment '' /* x */ }`, `comment '' /* x */`],
  ])('keeps a blank declared name on a %s', (_form, src, expected) => {
    const { text } = reparse(src);
    expect(text, `the blank name was laundered away:\n${text}`).toContain(expected);
  });

  it('keeps a blank SHORT name, which is the requirement id an agent reads', () => {
    const { text, model } = reparse(`package C { requirement <''> r; }`);
    expect(text).toContain(`requirement <''> r`);
    expect(model.all().find((e) => e.declaredName === 'r')?.declaredShortName).toBe('');
  });

  it('puts a named comment in its namespace, exactly as doc and rep already are', () => {
    // Keeping the name is what makes this true: before the fix a Comment was
    // anonymous and could never collide. Pinned so the new error is a recorded
    // consequence rather than a surprise.
    const { model } = parseModel(`package C { comment N /* a */ comment N /* b */ }`);
    const dups = validate(model).filter((d) => d.ruleId === 'duplicate-name');
    expect(dups).toHaveLength(2);
  });

  it('escapes a rep language tag the same way', () => {
    // Same STRING terminal, same helper: `language "a\\"b"` used to save as
    // `language "a"b"` and break the file on re-parse.
    const { model } = reparse(`package C { rep R language "a\\"b" /* x */ }`);
    const rep = model.all().find((e) => e.eClass === 'TextualRepresentation')!;
    expect(rep.attrs.language).toBe('a"b');
  });

  it('leaves a bare comment bare', () => {
    const { text, model } = reparse(`package C { comment /* nothing special */ }`);
    expect(text).toContain('comment /* nothing special */');
    const c = comment(model);
    expect(c.declaredName).toBeUndefined();
    expect(c.attrs.about).toBeUndefined();
    expect(c.attrs.locale).toBeUndefined();
  });
});

/**
 * A note body is written with NO escaping, and the sequence that ends it has no
 * spelling that survives inside it — the notation gives that delimiter no escape
 * sequence at all, unlike a name or a string literal. Written
 * verbatim it closes the note early and the rest of the value is re-read as
 * DECLARATIONS: a requirement statement typed into the Properties panel grew a
 * `Satisfy` nobody wrote, the saved file re-parsed with zero diagnostics, and
 * the second save promoted the mis-parse into the canonical form. Refusing to
 * produce that file is the only honest answer — see `semantics/notes.ts`.
 */
describe('round-trip — a note body cannot inject model structure', () => {
  /** A body whose tail would be read back as two declarations. */
  const INJECTION = `mass <= 25 kg ${NOTE_BODY_TERMINATOR} satisfy R1 by Vehicle; doc /*`;

  const model = (): Model => parseModel('package P { part def Vehicle; }').model;

  /** parse → serialize → parse, asserting a clean parse each way. */
  function reparse(src: string): { text: string; model: Model } {
    const { model: m, diagnostics } = parseModel(src);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const text = serializeModel(m);
    const rt = parseModel(text);
    expect(rt.diagnostics.filter((d) => d.severity === 'error'), text).toEqual([]);
    return { text, model: rt.model };
  }

  it('refuses to write a Documentation body that would close its own note', () => {
    const m = model();
    const p = m.all().find((e) => e.eClass === 'Package')!;
    const doc = m.create('Documentation', { ownerId: p.id, attrs: { body: INJECTION } });
    expect(() => serializeModel(m)).toThrow(UnwritableNoteBodyError);
    expect(() => serializeModel(m)).toThrow(doc.id);
  });

  it('refuses the same body on a comment and on a textual representation', () => {
    for (const eClass of ['Comment', 'TextualRepresentation'] as const) {
      const m = model();
      const p = m.all().find((e) => e.eClass === 'Package')!;
      m.create(eClass, { ownerId: p.id, attrs: { body: INJECTION, language: 'js' } });
      expect(() => serializeModel(m), eClass).toThrow(UnwritableNoteBodyError);
    }
  });

  it("refuses a requirement statement that would fabricate a Satisfy nobody wrote", () => {
    // The original reproduction, end to end: the grid and the Properties panel
    // both write `attrs.text`, and the serializer emits it as a second,
    // unescaped doc-emitting site.
    const { model: m } = parseModel(
      'package P {\n    requirement <R1> maxMass;\n    part def Vehicle;\n}\n',
    );
    const req = m.all().find((e) => e.declaredName === 'maxMass')!;
    m.setAttrs(req.id, { text: INJECTION });
    expect(() => serializeModel(m)).toThrow(UnwritableNoteBodyError);
  });

  it('writes a body that merely CONTAINS a star or a slash, unchanged', () => {
    // The refusal is about one two-character sequence, not about punctuation:
    // `/*` inside a note is legal (the terminal does not nest) and must still
    // round-trip.
    const { text, model: rt } = reparse(`package C { doc /* a /* b * c / d */ }`);
    expect(text).toContain('doc /* a /* b * c / d */');
    expect(rt.all().find((e) => e.eClass === 'Documentation')?.attrs.body).toBe('a /* b * c / d');
  });

  it('does NOT cover a value expression — the same injection, recorded not fixed', () => {
    // The claim this describe block makes is about note bodies, and it must not
    // be read as a claim about every free-text box in the panel. `attrs.value`
    // is written as the author typed it too (the Properties Value box takes free
    // text), so a value ending in `;` injects declarations exactly the way a
    // note body did. It is notation rather than prose — closing it means
    // checking that the value parses as an expression, which is a different
    // commit — so the campaign ledger records it under Known limitations, and
    // this pins the scope: the day the value box is closed, this test fails and
    // the ledger entry goes.
    const { model: m } = parseModel(
      'package P {\n    part def Vehicle {\n        attribute mass = 10;\n    }\n}\n',
    );
    const mass = m.all().find((e) => e.declaredName === 'mass')!;
    m.setAttrs(mass.id, { value: '1; part def Injected; attribute q = 2', valueText: undefined });

    const out = serializeModel(m);
    const back = parseModel(out);
    expect(back.diagnostics.filter((d) => d.severity === 'error'), out).toEqual([]);
    expect(
      back.model.all().some((e) => e.declaredName === 'Injected'),
      'still open: a value expression is written verbatim',
    ).toBe(true);
  });
});

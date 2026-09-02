import { describe, it, expect } from 'vitest';
import { buildSampleModel, Model, ModelFactory, type ElementRecord } from '@core/index';
import { parseModel, serializeModel } from '@text/index';

/** Attributes that carry semantic meaning for round-trip comparison. */
const KEY_ATTRS = [
  'type',
  'typeRef',
  'value',
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

  it('a redefinition statement with an inherited (unresolved) target survives round-trip', () => {
    // `a` lives on the supertype D, so the plain resolver leaves the target
    // textual. Before the fix the serializer silently DROPPED the Redefinition
    // (not inlineable, filtered from body members).
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
    const text = serializeModel(model);
    expect(text).toContain('redefinition');
    const { model: m2, diagnostics } = parseModel(text);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(count(m2, 'Redefinition')).toBe(1);
    // Fixpoint: a second round-trip reproduces the same text.
    expect(serializeModel(m2)).toBe(text);
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

    // typeRef stays deferred to the library-aware resolveTypeReferences pass.
    const typed = reparse(`package T { part p : Later; part def Later; }`);
    const p = typed.all().find((e) => e.declaredName === 'p')!;
    // A forward typing is NOT resolved by this pass (owned by resolveTypeReferences).
    expect(p.attrs.type ?? p.attrs.typeRef).toBeDefined();
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

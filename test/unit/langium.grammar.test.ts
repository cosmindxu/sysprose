/**
 * Self-test for the experimental Langium SysML v2 grammar (src/text/langium).
 *
 * Each snippet must tokenize + parse with ZERO lexer/parser errors, and produce
 * the expected AST root members. This exercises: definitions/usages with typing
 * + ports + attributes, action `first..then`, state transitions, requirement
 * `subject`/`require` with an expression body + `satisfy`, and a feature-value
 * expression with correct operator precedence.
 */

import { describe, it, expect } from 'vitest';
import { parseDocument } from '@text/langium/module';
import { parseModel } from '@text/index';
import {
  isDefinition,
  isTransition,
  isFirstThen,
  isRequirementClause,
  isSatisfy,
  isBinaryExpr,
  type Definition,
  type BinaryExpr,
} from '@text/langium/generated/ast';

/** Parse and assert a completely error-free parse; return the root. */
function parseClean(src: string) {
  const { ast, lexerErrors, parserErrors } = parseDocument(src);
  expect(lexerErrors, `lexer errors: ${JSON.stringify(lexerErrors)}`).toHaveLength(0);
  expect(parserErrors, `parser errors: ${parserErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  return ast;
}

describe('Langium SysML grammar — self-test', () => {
  it('parses a package with parts, ports, attributes and typing', () => {
    const ast = parseClean(`
      package VehicleModel {
        part def Vehicle {
          attribute mass : Real = 1500.0;
          port fuelIn : FuelPort;
          part engine : Engine;
        }
        port def FuelPort {
          attribute flowRate : Real;
        }
      }
    `);
    expect(ast.members).toHaveLength(1);
    const pkg = ast.members[0];
    expect(isDefinition(pkg) && pkg.keyword).toBe('package');
    const pkgDef = pkg as Definition;
    // Vehicle (part def) + FuelPort (port def)
    const bodyMembers = pkgDef.body?.members ?? [];
    expect(bodyMembers.filter(isDefinition).map((d) => `${d.keyword}${d.isDef ? ' def' : ''}`)).toEqual([
      'part def',
      'port def',
    ]);
    const vehicle = bodyMembers[0] as Definition;
    expect(vehicle.name).toBe('Vehicle');
    const attrs = (vehicle.body?.members ?? []).filter(isDefinition);
    const mass = attrs.find((d) => d.name === 'mass')!;
    expect(mass.keyword).toBe('attribute');
    expect(mass.specializations[0].types).toEqual(['Real']);
    expect(mass.valueOp).toBe('=');
    const port = attrs.find((d) => d.name === 'fuelIn')!;
    expect(port.keyword).toBe('port');
    expect(port.specializations[0].types).toEqual(['FuelPort']);
  });

  it('parses an action with first..then', () => {
    const ast = parseClean(`
      action def Drive {
        action start;
        action accelerate;
        first start then accelerate;
      }
    `);
    const drive = ast.members[0] as Definition;
    expect(isDefinition(drive) && drive.keyword).toBe('action');
    const ft = (drive.body?.members ?? []).find(isFirstThen)!;
    expect(ft.source).toBe('start');
    expect(ft.target).toBe('accelerate');
  });

  it('parses a state def with transitions (arrow and first..then forms)', () => {
    const ast = parseClean(`
      state def VehicleStates {
        state off;
        state moving;
        transition off -> moving;
        transition idling first moving accept ev [ speed > 0 ] then off;
      }
    `);
    const states = ast.members[0] as Definition;
    const transitions = (states.body?.members ?? []).filter(isTransition);
    expect(transitions).toHaveLength(2);
    expect(transitions[0].source).toBe('off');
    expect(transitions[0].target).toBe('moving');
    // Named transition carries accept + guard clauses.
    expect(transitions[1].name).toBe('idling');
    expect(transitions[1].source).toBe('moving');
    expect(transitions[1].target).toBe('off');
    expect(transitions[1].clauses).toHaveLength(2);
  });

  it('parses a requirement with subject, an expression constraint and satisfy', () => {
    const ast = parseClean(`
      package P {
        requirement def MassReq {
          subject vehicle : Vehicle;
          require constraint { vehicle.mass <= 2000.0 }
        }
        satisfy MassReq by vehicle;
      }
    `);
    const pkg = ast.members[0] as Definition;
    const req = (pkg.body?.members ?? []).find(isDefinition)! as Definition;
    expect(req.keyword).toBe('requirement');
    const clauses = (req.body?.members ?? []).filter(isRequirementClause);
    const subject = clauses.find((c) => c.kind === 'subject')!;
    expect(subject.name).toBe('vehicle');
    expect(subject.specializations[0].types).toEqual(['Vehicle']);
    const require = clauses.find((c) => c.kind === 'require')!;
    expect(isBinaryExpr(require.expr)).toBe(true);
    expect((require.expr as BinaryExpr).op).toBe('<=');
    const sat = (pkg.body?.members ?? []).find(isSatisfy)!;
    expect(sat.requirement).toBe('MassReq');
    expect(sat.satisfier).toBe('vehicle');
  });

  it('parses a feature value expression with correct precedence', () => {
    // a + b * 2 >= 10  ==>  ((a + (b * 2)) >= 10)
    const ast = parseClean(`attribute x = a + b * 2 >= 10`);
    const x = ast.members[0] as Definition;
    expect(isDefinition(x) && x.keyword).toBe('attribute');
    expect(x.name).toBe('x');
    const top = x.value as BinaryExpr;
    expect(isBinaryExpr(top)).toBe(true);
    expect(top.op).toBe('>='); // relational binds loosest here
    const left = top.left as BinaryExpr;
    expect(left.op).toBe('+');
    const rightOfPlus = left.right as BinaryExpr;
    expect(rightOfPlus.op).toBe('*'); // multiplication binds tighter than addition
  });
});

// ─────────────────────── extended KerML + SysML families ───────────────────────
// These snippets exercise the construct families added while growing the grammar
// toward the full OMG BNF. Each must tokenize + parse with ZERO errors.

describe('Langium SysML grammar — extended construct families', () => {
  it('parses library packages, visibility, imports (wildcard/recursive/aliased) and alias', () => {
    const ast = parseClean(`
      standard library package Base {
        public import ScalarValues::*;
        private import Objects::Object::**;
        protected import Occurrences::Occurrence;
        import Base::Anything;
        alias Thing for Base::Anything;
      }
    `);
    expect(ast.members).toHaveLength(1);
  });

  it('a nameless library import never crashes the mapper (deep-session finding)', () => {
    // The bundled standard library serializes SOME imports without a name
    // (`import ;`). The grammar rejects that at the lexer level, but error
    // recovery can still hand the mapper an Import node whose importedName is
    // undefined — mapImport used to call `undefined.includes('*')` on it,
    // crashing any re-import of an exported model. Parse must not throw.
    const { model } = parseModel(`library package L { import ; public import Other::Thing; }`);
    // The nameless import is skipped; the named one survives.
    const imports = model.ofKind('MembershipImport', 'NamespaceImport');
    expect(imports.map((i) => i.attrs.importedName)).toEqual(['Other::Thing']);
  });

  it('parses KerML classifiers/features with the full specialization keyword set', () => {
    parseClean(`
      abstract struct Object specializes Occurrence {
        feature self : Object redefines Occurrence::self;
        composite feature subobjects : Object[0..*] subsets objects
          intersects objects, suboccurrences;
        abstract step enactedPerformances : Performance[0..*]
          subsets involvingPerformances unions timeEnclosedOccurrences;
        feature inv1 featured by Object inverse of container;
      }
      assoc struct LinkObject specializes Link, Object;
      datatype Complex;
      classifier all C specializes Base;
    `);
  });

  it('parses conjugation, typed-by/featured-by operators and multiplicity modifiers', () => {
    parseClean(`
      part def P {
        in x : ~Conjugated;
        ref out y typed by Real [0..*] ordered nonunique;
        feature z : T [1..*] :>> base subsets other;
      }
    `);
  });

  it('parses the full expression grammar (invocation, index, conditional, ??, range, meta)', () => {
    const ast = parseClean(`
      calc def C {
        attribute a = f(x, y) + g();
        attribute b = coll->select { in i; seq#(i) == value } ->reduce '+' ?? 0;
        attribute c = if cond ? whenTrue else whenFalse;
        attribute d = (1 .. size(coll)) ;
        attribute e = obj.metadata meta SysML::Usage;
        attribute f2 = a & b | c and not d;
        attribute seqv = (1, 2, 3);
        attribute n = new Point(1.0, 2.0);
      }
    `);
    expect(ast.members).toHaveLength(1);
  });

  it('parses metadata `@` annotation with a body and prefix `#` metadata', () => {
    parseClean(`
      package M {
        @Safety { level = 3; }
        #command part def Actuator;
        metadata def Safety { attribute level : Integer; }
      }
    `);
  });

  it('parses flows, accept/send/assign and connector ends with multiplicities', () => {
    parseClean(`
      action def A {
        flow of fuel from tank.port to engine.port;
        accept sig : SignalDef via receiver;
        send payload to target;
        assign counter := counter + 1;
        connector [0..1] end1 to [1..*] end2;
      }
    `);
  });

  it('parses calc + return, while/for control and first/then successions', () => {
    parseClean(`
      calc def Sum {
        in a : Real;
        in b : Real;
        return result : Real = a + b;
      }
      action def Loop {
        action seed;
        first seed then step1;
        action whileLoop while index <= 10 {
          assign index := index + 1;
          then perform body;
        }
        for x : Item in items { perform process; }
      }
    `);
  });

  it('parses state entry/do/exit, transitions with accept/guard/effect and succession multiplicities', () => {
    const ast = parseClean(`
      state def Machine {
        entry action startup;
        do action running;
        exit action shutdown;
        state idle;
        state active;
        transition t1 first idle accept ev : Ping via p [ ready ] then active;
        succession all [*] idle then [*] active;
      }
    `);
    expect(ast.members).toHaveLength(1);
  });

  it('parses requirements with subject/actor/stakeholder/objective/frame/assert', () => {
    parseClean(`
      requirement def R {
        subject vehicle : Vehicle;
        actor driver : Person;
        stakeholder owner : Person;
        objective obj : Goal;
        frame masses : MassReq;
        require constraint { vehicle.mass <= 2000.0 }
        assume constraint { vehicle.mass > 0.0 }
        assert constraint { doc /* invariant */ notEmpty(vehicle) }
      }
    `);
  });

  it('parses case / analysis / verification / use-case with objective and subject', () => {
    parseClean(`
      case def Study {
        subject sut : System;
        objective obj : RequirementCheck;
        return verdict : VerdictKind;
      }
      analysis def Trade { subject s : System; }
      verification def V { subject s : System; verify requirement R; }
      use case def UC { subject actorX : Person; }
    `);
  });

  it('parses view / viewpoint / rendering / expose and satisfy/verify statements', () => {
    parseClean(`
      package V {
        viewpoint def Overview { }
        view def Dashboard :> Part {
          ref rendering asHtml : Rendering;
          satisfy requirement conformance by that;
        }
        rendering def AsText;
      }
    `);
  });

  it('parses dependency (bare and named from/to lists) and allocation', () => {
    parseClean(`
      package D {
        dependency from clientA, clientB to supplierA, supplierB;
        dependency <dep1> useIt from a to b;
        allocate logicalFn to physicalComponent;
      }
    `);
  });

  it('parses comment/doc/textual-representation (rep + language) elements', () => {
    parseClean(`
      package Docs {
        comment about Docs /* a package-level comment */
        doc /* documentation body */
        rep asOcl language "OCL" /* self.value > 0 */
      }
    `);
  });

  it('parses named KerML relationship elements and disjoint/binding forms', () => {
    parseClean(`
      package Rel {
        subset laterOccurrence.successors subsets earlierOccurrence.successors;
        disjoint causes.startShot from effects.endShot;
        binding [1] monitor.onOccurrence = [1] onOccurrence;
        bind a = b;
      }
    `);
  });

  it('parses enumeration literals (bare, valued and bodied) and feature values with default', () => {
    const ast = parseClean(`
      enum def VerdictKind {
        pass;
        fail { doc /* failed */ }
        low = 0.25;
      }
      part def Q {
        attribute rate : Real default 1.0;
        in clock : Clock[1] default frame.localClock;
      }
    `);
    expect(ast.members).toHaveLength(2);
  });

  // ── regression snippets for the standard-library corpus constructs that
  //    previously failed to parse (grammar coverage 96.8% → 100%). ──────────

  it('parses a value multiplicity whose bound is a #(i) sequence-index expression', () => {
    // ISQSpaceTime.sysml — `[ mRef.mRefs#(1) ]` is a multiplicity, not a bare
    // `x[i]` postfix index; the `#(…)` index appears inside the bracket bound.
    parseClean(`
      package Q {
        attribute def CartesianPosition3dVector {
          attribute x : LengthValue = num#(1) [mRef.mRefs#(1)];
          attribute y : LengthValue = num#(2) [mRef.mRefs#(2)];
        }
      }
    `);
  });

  it('parses a binding connector with `bind` and end multiplicities', () => {
    // ShapeItems.sysml — `binding [1] bind [0..*] a = [0..*] b;`
    parseClean(`
      package B {
        part def Face {
          binding [1] bind [0..*] base.edges = [0..*] be;
          binding [1] bind [0..1] tf.edges = [0..1] tfe;
        }
      }
    `);
  });

  it('parses a named succession with a multiplicity before `first` (variadic)', () => {
    // TransitionPerformances.kerml — `succession triggerAfter [taNum] first
    // [0..1] src then [*] tgt;`
    parseClean(`
      behavior NonStateTransitionPerformance {
        private succession triggerAfter [taNum] first [0..1] transitionLinkSource then [*] trigger.endShot;
      }
    `);
  });
});

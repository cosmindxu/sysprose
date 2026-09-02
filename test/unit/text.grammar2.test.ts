/**
 * End-to-end coverage for the *extended* construct families added while growing
 * the Langium grammar toward the full OMG SysML v2 / KerML BNF, exercised
 * through the DEFAULT parser (`parseModel` = Langium + AST→Model mapper).
 *
 * Each test parses a snippet and asserts the resulting {@link Model} carries the
 * right metaclass(es) + attribute conventions (metaclass = eClass; typing via
 * `attrs.type`/`typeRef` or a FeatureTyping relationship; endpoint refs on
 * `source`/`target` with `sourceRef`/`targetRef` fallbacks; free-form fragments
 * on `attrs`). Serializer-supported families are additionally round-tripped.
 *
 * These constructs were previously ignored by the mapper, so every assertion
 * here is ADDITIVE — the pre-existing text.parser / roundtrip / integration /
 * E2E suites remain unchanged and green.
 */

import { describe, it, expect } from 'vitest';
import { parseModel, serializeModel } from '@text/index';
import type { Model, ElementRecord } from '@core/index';

function ofClass(model: Model, eClass: string): ElementRecord[] {
  return model.all().filter((e) => e.eClass === eClass);
}
function byName(model: Model, name: string): ElementRecord | undefined {
  return model.all().find((e) => e.declaredName === name);
}
function noErrors(diagnostics: { severity: string }[]): void {
  expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
}

describe('grammar2 — alias / dependency / bind', () => {
  it('maps `alias N for Target` to a named Membership resolving the target', () => {
    const { model, diagnostics } = parseModel(`
      package P {
        part def Thing;
        alias <T> Widget for Thing;
      }
    `);
    noErrors(diagnostics);
    const mem = ofClass(model, 'Membership');
    expect(mem).toHaveLength(1);
    expect(mem[0].declaredName).toBe('Widget');
    expect(mem[0].declaredShortName).toBe('T');
    expect(model.qualifiedName(mem[0].target![0])).toBe('P::Thing');
  });

  it('maps a bare `dependency a to b` to a Dependency with resolved endpoints (round-trips)', () => {
    const src = `package P { part a; part b; dependency a to b; }`;
    const { model, diagnostics } = parseModel(src);
    noErrors(diagnostics);
    const deps = ofClass(model, 'Dependency');
    expect(deps).toHaveLength(1);
    expect(model.qualifiedName(deps[0].source![0])).toBe('P::a');
    expect(model.qualifiedName(deps[0].target![0])).toBe('P::b');
    // Round-trip: the serializer emits `dependency a to b;`.
    const { model: m2, diagnostics: d2 } = parseModel(serializeModel(model));
    noErrors(d2);
    const deps2 = ofClass(m2, 'Dependency');
    expect(deps2).toHaveLength(1);
    expect(m2.qualifiedName(deps2[0].source![0])).toBe('P::a');
    expect(m2.qualifiedName(deps2[0].target![0])).toBe('P::b');
  });

  it('preserves a named dependency with unresolved multi-supplier lists on attrs', () => {
    const { model, diagnostics } = parseModel(`
      package P {
        dependency <d1> useIt from client to supA, supB;
      }
    `);
    const dep = ofClass(model, 'Dependency')[0];
    expect(dep.declaredName).toBe('useIt');
    expect(dep.declaredShortName).toBe('d1');
    expect(dep.attrs.sourceRef).toBe('client');
    expect(dep.attrs.suppliers).toEqual(['supA', 'supB']);
    expect(diagnostics.some((d) => d.severity === 'warning')).toBe(true);
  });

  it('maps `bind a = b` / `binding …` to a BindingConnectorAsUsage', () => {
    const { model, diagnostics } = parseModel(`
      package P {
        attribute a;
        attribute b;
        bind a = b;
        binding [1] a = [1] b;
      }
    `);
    noErrors(diagnostics);
    const binds = ofClass(model, 'BindingConnectorAsUsage');
    expect(binds).toHaveLength(2);
    expect(model.qualifiedName(binds[0].source![0])).toBe('P::a');
    expect(model.qualifiedName(binds[0].target![0])).toBe('P::b');
  });
});

describe('grammar2 — named KerML relationship statements', () => {
  it('maps subset / redefinition / disjoint to relationship elements on the source', () => {
    const { model, diagnostics } = parseModel(`
      package P {
        part def A;
        part x : A;
        part y : A;
        subset x subsets y;
        redefinition x redefines y;
        disjoint x from y;
      }
    `);
    noErrors(diagnostics);
    const disj = ofClass(model, 'Disjoining');
    expect(disj).toHaveLength(1);
    expect(model.qualifiedName(disj[0].source![0])).toBe('P::x');
    expect(model.qualifiedName(disj[0].target![0])).toBe('P::y');

    const sub = ofClass(model, 'Subsetting').find(
      (r) => model.qualifiedName(r.source![0]) === 'P::x' && model.qualifiedName(r.target![0]) === 'P::y',
    );
    expect(sub, 'standalone subset relationship').toBeDefined();

    const redef = ofClass(model, 'Redefinition').find(
      (r) => model.qualifiedName(r.source![0]) === 'P::x' && model.qualifiedName(r.target![0]) === 'P::y',
    );
    expect(redef, 'standalone redefinition relationship').toBeDefined();
  });
});

describe('grammar2 — calc return, loops, if & behavioural actions', () => {
  it('maps `return name : T = expr` to a result ReferenceUsage', () => {
    const { model } = parseModel(`
      calc def Sum {
        return result : Real = a + b;
      }
    `);
    const result = byName(model, 'result')!;
    expect(result.eClass).toBe('ReferenceUsage');
    expect(result.attrs.featureRole).toBe('return');
    expect(result.attrs.value).toBe('a + b');
    // `Real` is unresolved in this isolated snippet → kept textually.
    expect(result.attrs.typeRef).toBe('Real');
  });

  it('maps while/for loops and the assign / perform actions inside them', () => {
    const { model, diagnostics } = parseModel(`
      action def L {
        while count <= 10 {
          assign count := count + 1;
        }
        for x : Item in items {
          perform proc;
        }
      }
    `);
    noErrors(diagnostics);
    const wl = ofClass(model, 'WhileLoopActionUsage')[0];
    expect(wl.attrs.loopKind).toBe('while');
    expect(wl.attrs.condition).toBe('count <= 10');

    const fl = ofClass(model, 'ForLoopActionUsage')[0];
    expect(fl.attrs.loopKind).toBe('for');
    expect(fl.attrs.loopVar).toBe('x');
    expect(fl.attrs.loopVarType).toBe('Item');
    expect(fl.attrs.collection).toBe('items');

    const assign = ofClass(model, 'AssignmentActionUsage')[0];
    expect(assign.attrs.actionKind).toBe('assign');
    expect(assign.attrs.value).toBe('count + 1');

    const perform = ofClass(model, 'PerformActionUsage')[0];
    expect(perform.attrs.actionKind).toBe('perform');
    expect(perform.declaredName).toBe('proc');
  });

  it('maps `if c { … } else { … }` to an IfActionUsage owning both branches', () => {
    const { model, diagnostics } = parseModel(`
      action def I {
        if ready {
          perform go;
        } else {
          perform stop;
        }
      }
    `);
    noErrors(diagnostics);
    const iff = ofClass(model, 'IfActionUsage');
    expect(iff).toHaveLength(1);
    expect(iff[0].attrs.condition).toBe('ready');
    expect(iff[0].attrs.hasElse).toBe(true);
    // Both `perform` branches are mapped as children.
    expect(model.children(iff[0].id).filter((c) => c.eClass === 'PerformActionUsage')).toHaveLength(2);
  });

  it('maps accept / send behavioural statements with via / target refs', () => {
    const { model, diagnostics } = parseModel(`
      action def B {
        accept sig via receiver;
        send payload to sink;
      }
    `);
    noErrors(diagnostics);
    const accept = ofClass(model, 'AcceptActionUsage')[0];
    expect(accept.declaredName).toBe('sig');
    expect(accept.attrs.actionKind).toBe('accept');
    expect(accept.attrs.via).toBe('receiver');

    const send = ofClass(model, 'SendActionUsage')[0];
    expect(send.declaredName).toBe('payload');
    expect(send.attrs.actionKind).toBe('send');
    expect(send.attrs.actionTarget).toBe('sink');
  });
});

describe('grammar2 — flow, metadata, annotations, imports & visibility', () => {
  it('maps `flow of P from A to B` to a Flow relationship with a payload', () => {
    const { model, diagnostics } = parseModel(`
      package F {
        part tank;
        part engine;
        flow of fuel from tank to engine;
      }
    `);
    noErrors(diagnostics);
    const flows = ofClass(model, 'Flow');
    expect(flows).toHaveLength(1);
    expect(model.qualifiedName(flows[0].source![0])).toBe('F::tank');
    expect(model.qualifiedName(flows[0].target![0])).toBe('F::engine');
    expect(flows[0].attrs.payload).toBe('fuel');
  });

  it('maps `@Type { … }` annotations and `#Meta` prefix metadata', () => {
    const { model, diagnostics } = parseModel(`
      package M {
        @Safety { attribute level = 3; }
        #command part def Actuator;
        metadata def Safety;
      }
    `);
    noErrors(diagnostics);
    const meta = ofClass(model, 'MetadataUsage').find((m) => m.attrs.annotation === true)!;
    expect(meta.attrs.type).toBe('Safety');
    expect(ofClass(model, 'MetadataDefinition')).toHaveLength(1);
    const actuator = byName(model, 'Actuator')!;
    expect(actuator.eClass).toBe('PartDefinition');
    expect(actuator.attrs.metadata).toEqual(['command']);
  });

  it('records import visibility + filter expressions', () => {
    const { model, diagnostics } = parseModel(`
      package I {
        public import A::B::*;
        private import X::Y [ a > 0 ];
      }
    `);
    noErrors(diagnostics);
    const ns = ofClass(model, 'NamespaceImport')[0];
    expect(ns.attrs.importedName).toBe('A::B::*');
    expect(ns.attrs.visibility).toBe('public');
    const mem = ofClass(model, 'MembershipImport')[0];
    expect(mem.attrs.importedName).toBe('X::Y');
    expect(mem.attrs.visibility).toBe('private');
    expect(mem.attrs.filters).toEqual(['a > 0']);
  });

  it('parses every control-node keyword — including initial/done (finding C9) — and round-trips', () => {
    const src = `package P {
  part def M { initial; done; fork f; join j; merge; decide; }
}`;
    const { model, diagnostics } = parseModel(src);
    noErrors(diagnostics);
    const classes = model
      .all()
      .filter((e) =>
        ['InitialNode', 'DoneNode', 'ForkNode', 'JoinNode', 'MergeNode', 'DecisionNode'].includes(e.eClass),
      );
    expect(classes.map((e) => e.eClass).sort()).toEqual([
      'DecisionNode',
      'DoneNode',
      'ForkNode',
      'InitialNode',
      'JoinNode',
      'MergeNode',
    ]);
    expect(byName(model, 'f')!.eClass).toBe('ForkNode');
    // Serializer emits the keyword form for every kind (was `InitialNode;`/
    // `DoneNode;` before the fix — unparseable round-trip).
    const serialized = serializeModel(model);
    for (const kw of ['initial', 'done', 'fork f', 'join j', 'merge', 'decide']) {
      expect(serialized).toContain(kw);
    }
    const { model: m2, diagnostics: d2 } = parseModel(serialized);
    noErrors(d2);
    expect(m2.size).toBe(model.size);
  });

  it('records definition visibility additively and still round-trips the model shape', () => {
    const src = `package V { public part def Pub; protected attribute a : Real; }`;
    const { model, diagnostics } = parseModel(src);
    noErrors(diagnostics);
    expect(byName(model, 'Pub')!.attrs.visibility).toBe('public');
    expect(byName(model, 'a')!.attrs.visibility).toBe('protected');
    // Visibility is not serialized, but the element set is preserved on round-trip.
    const { model: m2 } = parseModel(serializeModel(model));
    expect(m2.size).toBe(model.size);
    expect(m2.all().filter((e) => e.eClass === 'PartDefinition')).toHaveLength(1);
    expect(byName(m2, 'a')!.attrs.type).toBe('Real');
  });
});

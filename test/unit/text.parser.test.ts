import { describe, it, expect } from 'vitest';
import { parseModel, serializeModel } from '@text/index';
import type { Model } from '@core/index';

/** Find the first element matching a predicate. */
function find(model: Model, pred: (e: ReturnType<Model['all']>[number]) => boolean) {
  return model.all().find(pred);
}
function byName(model: Model, name: string) {
  return find(model, (e) => e.declaredName === name);
}
function ofClass(model: Model, eClass: string) {
  return model.all().filter((e) => e.eClass === eClass);
}

describe('parser — packages, parts, attributes', () => {
  it('parses nested packages and part definitions/usages', () => {
    const { model, diagnostics } = parseModel(`
      package P {
        part def Vehicle;
        part vehicle : Vehicle;
      }
    `);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const pkg = byName(model, 'P')!;
    expect(pkg.eClass).toBe('Package');
    const def = byName(model, 'Vehicle')!;
    expect(def.eClass).toBe('PartDefinition');
    const usage = byName(model, 'vehicle')!;
    expect(usage.eClass).toBe('PartUsage');
    expect(model.qualifiedName(usage.id)).toBe('P::vehicle');
    // FeatureTyping created and resolved to the Vehicle definition.
    const typing = ofClass(model, 'FeatureTyping')[0];
    expect(typing.target?.[0]).toBe(def.id);
  });

  it('stores attribute type/value/multiplicity in attrs', () => {
    const { model } = parseModel(`package P { part v { attribute mass : Real = 1500 [kg]; } }`);
    const mass = byName(model, 'mass')!;
    expect(mass.eClass).toBe('AttributeUsage');
    expect(mass.attrs.type).toBe('Real');
    expect(mass.attrs.value).toBe(1500);
    // The value unit `[kg]` is stored in attrs.unit — never conflated with the
    // multiplicity bracket (finding D1/H11). The unit round-trips as `= 1500 [kg]`.
    expect(mass.attrs.unit).toBe('kg');
    expect(mass.attrs.multiplicity).toBeUndefined();
    const serialized = serializeModel(model);
    expect(serialized).toContain('= 1500 [kg]');
    expect(serialized).toContain('[kg]');
  });

  it('records port direction', () => {
    const { model } = parseModel(`package P { part e { out port fuelOut; in port fuelIn; } }`);
    expect(byName(model, 'fuelOut')!.attrs.direction).toBe('out');
    expect(byName(model, 'fuelIn')!.attrs.direction).toBe('in');
  });
});

describe('parser — specialization operators', () => {
  it('maps :> to Subclassification for definitions and Subsetting for usages', () => {
    const { model } = parseModel(`
      package P {
        part def Base;
        part def Derived :> Base;
        part b : Base;
        part s :> b;
      }
    `);
    expect(ofClass(model, 'Subclassification').length).toBe(1);
    expect(ofClass(model, 'Subsetting').length).toBe(1);
  });

  it('maps :>> to Redefinition and ::> to ReferenceSubsetting', () => {
    const { model } = parseModel(`
      package P {
        part def D;
        part wheels : D [4];
        part w :>> wheels;
        ref r ::> wheels;
      }
    `);
    expect(ofClass(model, 'Redefinition').length).toBe(1);
    expect(ofClass(model, 'ReferenceSubsetting').length).toBe(1);
  });

  it('keeps unresolved references textually and warns', () => {
    const { model, diagnostics } = parseModel(`package P { part v : Missing; }`);
    const v = byName(model, 'v')!;
    expect(v.attrs.typeRef).toBe('Missing');
    expect(diagnostics.some((d) => d.severity === 'warning')).toBe(true);
  });
});

describe('parser — relationships & behaviour', () => {
  it('parses connect/connection usages', () => {
    const { model } = parseModel(`
      package P {
        part a { port p; }
        part b { port q; }
        connection link connect a.p to b.q;
      }
    `);
    const link = byName(model, 'link')!;
    expect(link.eClass).toBe('ConnectionUsage');
    expect(model.qualifiedName(link.source![0])).toBe('P::a::p');
    expect(model.qualifiedName(link.target![0])).toBe('P::b::q');
  });

  it('parses requirements with id, subject and satisfy', () => {
    const { model } = parseModel(`
      package P {
        requirement <R1> massReq { doc /* limit */ subject v; }
        part car;
        satisfy massReq by car;
      }
    `);
    const req = byName(model, 'massReq')!;
    expect(req.attrs.reqId).toBe('R1');
    expect(req.attrs.text).toBe('limit');
    const sat = ofClass(model, 'Satisfy')[0];
    expect(model.qualifiedName(sat.target![0])).toBe('P::massReq');
    expect(model.qualifiedName(sat.source![0])).toBe('P::car');
  });

  it('parses allocate, enums and imports', () => {
    const { model } = parseModel(`
      package P {
        import ISQ::*;
        enum def Gear { enum park; enum drive; }
        action a;
        part c;
        allocate a to c;
      }
    `);
    expect(ofClass(model, 'NamespaceImport')[0].attrs.importedName).toBe('ISQ::*');
    expect(ofClass(model, 'EnumerationDefinition').length).toBe(1);
    expect(ofClass(model, 'EnumerationUsage').length).toBe(2);
    expect(ofClass(model, 'Allocation').length).toBe(1);
  });

  it('parses state transitions with trigger/guard/effect', () => {
    const { model } = parseModel(`
      package P {
        state def M {
          state off;
          state on;
          transition t first off accept startSig if ok do ignite then on;
        }
      }
    `);
    const t = byName(model, 't')!;
    expect(t.eClass).toBe('TransitionUsage');
    expect(t.attrs.trigger).toBe('startSig');
    expect(t.attrs.guard).toBe('ok');
    expect(t.attrs.effect).toBe('ignite');
    expect(model.qualifiedName(t.source![0])).toBe('P::M::off');
    expect(model.qualifiedName(t.target![0])).toBe('P::M::on');
  });

  it('parses action successions (first/then)', () => {
    const { model } = parseModel(`
      package P {
        action def Flow {
          action s;
          action e;
          first s then e;
        }
      }
    `);
    const succ = model.all().filter((x) => x.eClass === 'Succession');
    expect(succ.length).toBe(1);
    expect(model.qualifiedName(succ[0].source![0])).toBe('P::Flow::s');
    expect(model.qualifiedName(succ[0].target![0])).toBe('P::Flow::e');
  });
});

describe('parser — diagnostics & recovery', () => {
  it('reports a syntax error with line/column and recovers', () => {
    const { model, diagnostics } = parseModel(`
      package P {
        part broken : ;
        part ok;
      }
    `);
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
    const err = diagnostics.find((d) => d.severity === 'error')!;
    expect(err.line).toBeGreaterThan(0);
    expect(err.column).toBeGreaterThan(0);
    // Recovery: the following declaration still parses.
    expect(byName(model, 'ok')).toBeTruthy();
  });

  it('recovers from an unterminated body and still yields the package', () => {
    const { model } = parseModel(`package Good { part x; } package P { part @@@ `);
    expect(byName(model, 'Good')).toBeTruthy();
    expect(byName(model, 'x')).toBeTruthy();
  });
});

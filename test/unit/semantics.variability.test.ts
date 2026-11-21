import { describe, it, expect } from 'vitest';
import { parseModel } from '@text/index';
import { variabilityReport, variabilityLines, VARIABILITY_CODES, type OwnerReport } from '@semantics/variability';

const BASE = (configs: string, extraConstraint = '') => `package A12 {
  part def Vehicle; part vehicle_a : Vehicle;
  part def Engine; part def Engine4Cyl :> Engine; part def Engine6Cyl :> Engine; part def Cylinder;
  part def Transmission; part def TransmissionAutomatic :> Transmission; part def TransmissionManual :> Transmission; part def Sunroof;
  attribute def LengthValue;
  variation part def TransmissionChoices:>Transmission {
      variant part transmissionAutomatic:TransmissionAutomatic;
      variant part transmissionManual:TransmissionManual;
  }
  abstract part vehicleFamily:>vehicle_a{
      variation part engine:Engine{
          variant part engine4Cyl:Engine4Cyl;
          variant part engine6Cyl:Engine6Cyl{
              part cylinder:Cylinder [6]{
                  variation attribute diameter:LengthValue{
                      variant attribute smallDiameter:LengthValue;
                      variant attribute largeDiagmeter:LengthValue;
                  }
              }
          }
       }
       variation part transmission:TransmissionChoices;
       variation part sunroof:Sunroof;
       assert constraint selectionConstraint {
           (engine==engine::engine4Cyl and
               transmission==TransmissionChoices::transmissionManual) xor
           (engine==engine::engine6Cyl and
               transmission==TransmissionChoices::transmissionAutomatic)
       }
       ${extraConstraint}
  }
  ${configs}
}`;

const owner = (src: string): OwnerReport => variabilityReport(parseModel(src).model).owners[0];
const cfg = (o: OwnerReport, n: string) => o.configurations.find((c) => c.name.endsWith(n))!;

const CONFIGS = `
  part myCar :> vehicleFamily { part :>> engine = engine::engine4Cyl; part :>> transmission = TransmissionChoices::transmissionAutomatic; }
  part okCar :> vehicleFamily { part :>> engine = engine::engine4Cyl; part :>> transmission = TransmissionChoices::transmissionManual; }
  part halfCar :> vehicleFamily { part :>> engine = engine::engine4Cyl; }
  part sixCar :> vehicleFamily { part :>> engine = engine::engine6Cyl; part :>> transmission = TransmissionChoices::transmissionAutomatic; }
  part badCar :> vehicleFamily { part :>> engine = engine::engine5Cyl; }
  part crossCar :> vehicleFamily { part :>> engine = TransmissionChoices::transmissionManual; }
  part subCar :> vehicleFamily { part :>> engine :> engine::engine4Cyl; part :>> transmission :> TransmissionChoices::transmissionManual; }
  part typedCar :> vehicleFamily { part :>> engine : Engine4Cyl; }
  part defCar :> vehicleFamily { part :>> engine default engine::engine4Cyl; }
  part bareCar :> vehicleFamily { part :>> engine = engine4Cyl; }
  part inactiveCar :> vehicleFamily { part :>> engine = engine::engine4Cyl; part :>> diameter = diameter::smallDiameter; }
`;

describe('variability — Annex A.12', () => {
  const o = owner(BASE(CONFIGS));

  it('extracts points, nesting and the variation-definition variants', () => {
    expect(o.status).toBe('read');
    const by = Object.fromEntries(o.points.map((p) => [p.name, p]));
    expect(by.engine.variants.map((v) => v.name)).toEqual(['engine4Cyl', 'engine6Cyl']);
    expect(by.transmission.variants.map((v) => v.name)).toEqual(['transmissionAutomatic', 'transmissionManual']);
    expect(by.transmission.viaDefinition).toBe('TransmissionChoices');
    expect(by.diameter.activatedBy).toBe(by.engine.variants[1].key);
    expect(by.diameter.sharedAcrossInstances).toBe(true);
    expect(by.sunroof.configurable).toBe(false);
    expect(o.constraints[0].read).toBe(true);
  });

  it('family: 3 valid of 6 structural, nothing core or dead, sunroof left out', () => {
    const a = o.analysis!;
    expect(a.structural).toBe(6); // engine {4Cyl | 6Cyl x diameter 2} = 3, times transmission 2
    expect(a.valid).toBe(3); // 4Cyl+manual, 6Cyl+{small,large}+automatic
    expect(a.exact).toBe(true);
    expect(a.void).toBe(false);
    expect(a.core).toEqual([]);
    expect(a.dead).toEqual([]);
    expect(a.falseOptional).toEqual([]);
    expect(a.excludedPoints).toEqual(['sunroof']);
  });

  it('4Cyl + automatic is VIOLATED', () => {
    const c = cfg(o, 'myCar');
    expect(c.status).toBe('violated');
    expect(c.violated).toEqual(['selectionConstraint']);
  });
  it('4Cyl + manual HOLDS', () => expect(cfg(o, 'okCar').status).toBe('holds'));
  it('`:>` of a variant is a selection too', () => expect(cfg(o, 'subCar').status).toBe('holds'));

  it('4Cyl alone is PARTIAL, completes, forced manual', () => {
    const c = cfg(o, 'halfCar');
    expect(c.status).toBe('partial');
    expect(c.missing).toEqual(['transmission']);
    expect(c.completes).toBe(true);
    expect(c.forced).toEqual(['transmission::transmissionManual']);
  });

  it('6Cyl + automatic with diameter unselected is partial (nested point active); either diameter completes', () => {
    const c = cfg(o, 'sixCar');
    expect(c.status).toBe('partial');
    expect(c.missing).toEqual(['diameter']);
    expect(c.completes).toBe(true);
    expect(c.forced).toEqual([]); // small and large both complete it
  });

  it('a name that is no variant, or a variant of another point, is invalid', () => {
    expect(cfg(o, 'badCar').status).toBe('invalid');
    expect(cfg(o, 'badCar').selections[0].reason).toContain('engine5Cyl');
    expect(cfg(o, 'crossCar').status).toBe('invalid');
    expect(cfg(o, 'crossCar').selections[0].reason).toContain('another point'.replace('another point', 'transmission'));
  });

  it('a selection under an unselected variant is invalid (P3)', () => {
    const c = cfg(o, 'inactiveCar');
    expect(c.status).toBe('invalid');
    expect(c.selections.find((s) => s.status === 'invalid')!.reason).toContain('inactive');
  });

  it('typing, a default and an unqualified name are refused, and withhold the verdict', () => {
    for (const n of ['typedCar', 'defCar', 'bareCar']) {
      const c = cfg(o, n);
      expect(c.status, n).toBe('not-evaluated');
      expect(c.selections[0].status).toBe('not-read');
    }
    expect(cfg(o, 'typedCar').selections[0].reason).toContain('type');
  });

  it('diagnostic severities', () => {
    const r = variabilityReport(parseModel(BASE(CONFIGS)).model);
    const sev = (code: string) => [...new Set(r.diagnostics.filter((d) => d.code === code).map((d) => d.severity))];
    expect(sev(VARIABILITY_CODES.constraintViolated)).toEqual(['error']);
    expect(sev(VARIABILITY_CODES.invalidSelection)).toEqual(['error']);
    expect(sev(VARIABILITY_CODES.noVariants)).toEqual(['warning']);
    expect(sev(VARIABILITY_CODES.family)).toEqual(['info']);
    expect(variabilityLines(r, 'x').join('\n')).toContain('3 valid of 6 structural');
  });

  it('a contradictory constraint makes the family void', () => {
    const v = owner(BASE('', 'assert constraint nope { engine == engine::engine4Cyl and not (engine == engine::engine4Cyl) }'));
    expect(v.analysis!.void).toBe(true);
    expect(v.analysis!.valid).toBe(0);
  });

  it('a constraint that kills a variant makes it dead; one that forces it makes it core', () => {
    const d = owner(BASE('', 'assert constraint noSix { not (engine == engine::engine6Cyl) }'));
    expect(d.analysis!.valid).toBe(1);
    expect(d.analysis!.dead).toContain('engine::engine6Cyl');
    expect(d.analysis!.dead).toContain('diameter::smallDiameter');
    expect(d.analysis!.core).toContain('engine::engine4Cyl');
  });

  it('an unread constraint is reported, the count becomes an upper bound, HOLDS is qualified', () => {
    const u = owner(BASE('part okCar :> vehicleFamily { part :>> engine = engine::engine4Cyl; part :>> transmission = TransmissionChoices::transmissionManual; }', 'assert constraint odd { engine == engine::engine4Cyl or transmission == transmission::transmissionManual and sunroof == sunroof::x }'));
    expect(u.constraints.find((c) => c.name === 'odd')!.read).toBe(false);
    expect(u.constraints.find((c) => c.name === 'odd')!.reason).toContain('without parentheses');
    expect(u.analysis!.exact).toBe(false);
    expect(u.configurations[0].status).toBe('holds-over-read-constraints');
  });
});

describe('variability — other shapes', () => {
  const R = (s: string) => variabilityReport(parseModel(s).model);

  it('an optional point, nesting under it, false-optional', () => {
    const o = R(`package P { part def E; abstract part fam {
      variation part a [0..1] { variant part a1 : E; variant part a2 : E; }
      variation part b [0..1] { variant part b1 : E; }
      assert constraint c { not (b == b::b1) implies a == a::a1 }
    } }`).owners[0];
    // structural: a in {a1,a2,none} x b in {b1,none} = 6; valid: not(b1) -> a1: (a1,none)... b=none => a=a1; b=b1 => any a (3) => 4
    expect(o.analysis!.structural).toBe(6);
    expect(o.analysis!.valid).toBe(4);
    expect(o.analysis!.falseOptional).toEqual([]);
    const f = R(`package P { part def E; abstract part fam {
      variation part a [0..1] { variant part a1 : E; }
      assert constraint c { a == a::a1 }
    } }`).owners[0];
    expect(f.analysis!.falseOptional).toEqual(['a']);
    expect(f.analysis!.core).toEqual(['a::a1']);
  });

  it('a variant reference form takes the referenced name', () => {
    const o = R(`package P { part def E; part small : E; part big : E;
      abstract part fam { variation part e : E { variant small; variant big; } } }`).owners[0];
    expect(o.points[0].variants.map((v) => v.name)).toEqual(['small', 'big']);
  });

  it('refuses a point with a multiplicity that allows several variants', () => {
    const o = R(`package P { part def E; abstract part fam { variation part e [1..*] : E { variant part x : E; } } }`).owners[0];
    expect(o.status).toBe('not-read');
    expect(o.reasons[0]).toContain('[1..*]');
  });

  it('a model with no variation reports nothing to configure', () => {
    expect(R('package P { part def E; }').owners).toEqual([]);
  });

  it('refuses constraint shapes it does not read, with the reason', () => {
    const o = R(`package P { part def E; abstract part fam {
      variation part a : E { variant part a1 : E; variant part a2 : E; }
      assert constraint c1 { a != a::a1 }
      assert constraint c2 { a == a::zz }
      assert constraint c3 { a == a::a1 implies a == a::a2 implies a == a::a1 }
    } }`).owners[0];
    expect(o.constraints.map((c) => c.read)).toEqual([false, false, false]);
    expect(o.constraints[1].reason).toContain('not a variant');
    expect(o.analysis!.valid).toBe(2);
    expect(o.analysis!.exact).toBe(false);
  });

  it('an uncompletable partial names the constraint that blocks it', () => {
    const o = R(`package P { part def E; abstract part fam {
      variation part a : E { variant part a1 : E; variant part a2 : E; }
      variation part b : E { variant part b1 : E; variant part b2 : E; }
      assert constraint ban { not (a == a::a1 and b == b::b1) }
      assert constraint other { a == a::a1 or a == a::a2 }
    }
    part c :> fam { part :>> a = a::a1; } part d :> fam { part :>> a = a::a1; part :>> b = b::b1; } }`).owners[0];
    expect(cfg(o, 'c').completes).toBe(true);
    expect(cfg(o, 'c').forced).toEqual(['b::b2']);
    expect(cfg(o, 'd').status).toBe('violated');
  });
});

describe('catalogue agreement', () => {
  it('every VARIABILITY_CODES value is in the diagnostic catalogue, and nothing else is', async () => {
    const { isKnownCode, DIAGNOSTIC_CODES } = await import('@text/index');
    for (const code of Object.values(VARIABILITY_CODES)) expect(isKnownCode(code), code).toBe(true);
    const catalogued = DIAGNOSTIC_CODES.filter((c) => c.code.startsWith('verification/variability-')).map((c) => c.code).sort();
    expect(catalogued).toEqual(Object.values(VARIABILITY_CODES).sort());
  });

  it('every emitted diagnostic carries the severity the catalogue states', async () => {
    const { DIAGNOSTIC_CODES } = await import('@text/index');
    const r = variabilityReport(parseModel(BASE(CONFIGS)).model);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    for (const d of r.diagnostics) {
      expect(DIAGNOSTIC_CODES.find((c) => c.code === d.code)?.severity, d.code).toBe(d.severity);
    }
  });
});

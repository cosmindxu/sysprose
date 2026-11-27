import { describe, it, expect } from 'vitest';
import { parseModel } from '@text/index';
import { RULES_BY_ID } from '@validation/index';
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

  // SysML v2 Usage::namingFeature(): a variant is named by the feature its ownedReferenceSubsetting references.
  const REF_FORM = (configs: string) => `package P { part def E; part small : E; part big : E;
    part def Car { variation part engine : E { variant small; variant big; } }
    ${configs} }`;

  it('reads `:>` of a reference-form variant by the name it takes from what it references', () => {
    const o = R(REF_FORM(`part c1 : Car { part :>> engine :> engine::small; }
      part c2 : Car { part :>> engine :> Car::engine::big; }
      part c3 : Car { part :>> engine = engine::small; }`)).owners[0];
    for (const n of ['c1', 'c2', 'c3']) expect(cfg(o, n).status).toBe('holds');
    expect(cfg(o, 'c1').selections[0].text).toBe(':>> engine :> engine::small');
  });

  it('a reference-form variant name resolves without an error, and the model loads clean', () => {
    const { model } = parseModel(REF_FORM('part c1 : Car { part :>> engine :> engine::small; }'));
    expect(RULES_BY_ID.get('unresolved-type-ref')!.run(model)).toEqual([]);
    expect(variabilityReport(model).owners[0].configurations[0].status).toBe('holds');
  });

  it('does not read `:>` of the referenced feature itself, and names the spelling that is read', () => {
    const c = cfg(R(REF_FORM('part c4 : Car { part :>> engine :> small; }')).owners[0], 'c4');
    expect(c.status).toBe('not-evaluated');
    expect(c.selections[0].status).toBe('not-read');
    expect(c.selections[0].reason).toContain('write `:> engine::small`');
  });

  it('an unnamed variant that only subsets takes no name (the reference form alone names a variant)', () => {
    const o = R(`package P { part def E; part x : E; part def Car { variation part engine : E { variant part :> x; } } }`).owners[0];
    expect(o.status).toBe('not-read');
    expect(o.reasons[0]).toContain('a variant has no name');
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

describe('variability — per-configuration connection typing (p12)', () => {
  const CAR = (bigPort: string) => `package P {
    port def Pw; port def Sg;
    part def Eng { port p : Pw; }
    part def Ecu { port q : Pw; }
    part def Car {
      variation part eng : Eng { variant part small : Eng; variant part big : Eng { port :>> p : ${bigPort}; } }
      part ecu : Ecu;
      connect eng.p to ecu.q;
    }
    part c1 : Car { part :>> eng = eng::big; }
    part c2 : Car { part :>> eng = eng::small; }
  }`;

  it('a variant retyping a port to an incompatible type breaks the connection in that configuration only', () => {
    const r = variabilityReport(parseModel(CAR('Sg')).model);
    const o = r.owners[0];
    expect(o.analysis!.valid).toBe(2);
    expect(o.analysis!.connectionBroken).toHaveLength(1);
    expect(o.analysis!.connectionBroken[0].configuration).toContain('big');
    const c1 = o.configurations.find((c) => c.name.endsWith('c1'))!;
    const c2 = o.configurations.find((c) => c.name.endsWith('c2'))!;
    expect(c1.connectionBroken).toHaveLength(1);
    expect(c2.connectionBroken).toBeUndefined();
    expect(r.verdict.connectionBroken).toBe(2);
    expect(r.exitCode).toBe(1);
    expect(r.diagnostics.filter((d) => d.code === VARIABILITY_CODES.connectionBroken)).toHaveLength(2);
    expect(variabilityLines(r, 'p12').join('\n')).toContain('CONNECTION BROKEN');
  });

  it('a variant keeping a conforming port type leaves every configuration clean', () => {
    const r = variabilityReport(parseModel(CAR('Pw')).model);
    expect(r.owners[0].analysis!.connectionBroken).toEqual([]);
    expect(r.verdict.connectionBroken).toBe(0);
    expect(r.exitCode).toBe(0);
  });

  it('a connector already ill-typed in the superset is not repeated (connection-compatibility owns it)', () => {
    const src = CAR('Pw').replace('port q : Pw', 'port q : Sg');
    const r = variabilityReport(parseModel(src).model);
    expect(r.owners[0].analysis!.connectionBroken).toEqual([]);
  });
});

describe('variability: per-configuration evaluation (V4) and void explanation (V3)', () => {
  const car = (body: string, tail = '') => `package P {
  part def Engine { attribute mass : Real; }
  part def Car {
    variation part eng : Engine {
      variant part small : Engine { attribute :>> mass = 100; }
      variant part big : Engine { attribute :>> mass = 400; }
    }
    attribute limit : Real = 200;
    ${body}
  }
  ${tail}
}`;
  const run = (src: string) => variabilityReport(parseModel(src).model);

  it('constraint over the chosen variant: one configuration holds, one violates, the family is VIOLATED', () => {
    const r = run(car('assert constraint ok { eng.mass <= limit }', 'part c1 : Car { part :>> eng = eng::big; } part c2 : Car { part :>> eng = eng::small; }'));
    const ev = r.owners[0].evaluations[0];
    expect(ev.verdict).toBe('violated');
    expect(ev.holds).toBe(1);
    expect(ev.violated).toBe(1);
    expect(ev.coverage).toBe('exact: all 2 enumerated');
    expect(ev.items[0].values).toEqual(['eng.mass = 400', 'limit = 200']);
    const d = r.diagnostics.filter((x) => x.code === VARIABILITY_CODES.configurationViolates);
    expect(d.map((x) => x.severity)).toEqual(['error', 'error']);
    expect(d.some((x) => x.message.includes('c1'))).toBe(true);
    expect(d.some((x) => x.message.includes('c2'))).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(variabilityLines(r, 'x').join('\n')).toContain('NOT satisfied');
  });

  it('a family where every configuration holds is HOLDS, exact', () => {
    const r = run(car('assert constraint ok { eng.mass <= 500 }'));
    expect(r.owners[0].evaluations[0].verdict).toBe('holds');
    expect(r.owners[0].evaluations[0].coverage).toBe('exact: all 2 enumerated');
    expect(r.diagnostics.some((x) => x.code === VARIABILITY_CODES.configurationViolates)).toBe(false);
  });

  it('an unreadable value makes the configuration and the family undecided, never a pass', () => {
    const src = car('assert constraint ok { eng.mass <= 500 }').replace('attribute :>> mass = 400;', '');
    const ev = run(src).owners[0].evaluations[0];
    expect(ev.verdict).toBe('undecided');
    expect(ev.undecided).toBe(1);
    expect(ev.coverage).toBe('undecided: 1 of 2 enumerated');
    expect(ev.items[0].reason).toContain('eng.mass');
  });

  it('an overridable default value is not read as the configuration\'s value', () => {
    const src = car('assert constraint ok { eng.mass <= 500 }').replace('attribute :>> mass = 400;', 'attribute :>> mass default 400;');
    expect(run(src).owners[0].evaluations[0].verdict).toBe('undecided');
  });

  it('a requirement satisfied through the point is decided per configuration', () => {
    const req = 'requirement def MassReq { subject s : Engine; require constraint { s.mass <= 200 } }';
    const r = run(car('', `${req} part c1 : Car { part :>> eng = eng::big; satisfy MassReq by c1.eng; } part c2 : Car { part :>> eng = eng::small; satisfy MassReq by c2.eng; }`));
    const evs = r.owners[0].evaluations.filter((e) => e.kind === 'requirement');
    expect(evs.map((e) => e.verdict).sort()).toEqual(['holds', 'violated']);
    expect(r.exitCode).toBe(1);
  });

  it('family-level satisfy is evaluated over every enumerated configuration', () => {
    const req = 'requirement def MassReq { subject s : Engine; require constraint { s.mass <= 200 } }';
    const r = run(car('satisfy MassReq by eng;', req));
    const ev = r.owners[0].evaluations[0];
    expect(ev.kind).toBe('requirement');
    expect(ev.verdict).toBe('violated');
    expect(ev.coverage).toBe('exact: all 2 enumerated');
  });

  it('p7: a void family names a minimal conflicting set; dead variants name their killers', () => {
    const src = `package P { part def Engine; part def Gear;
      part def Car {
        variation part eng : Engine { variant part small : Engine; variant part big : Engine; }
        variation part gb : Gear { variant part man : Gear; variant part aut : Gear; }
        assert constraint c1 { eng == eng::big implies gb == gb::aut }
        assert constraint c2 { eng == eng::big implies gb == gb::man }
        assert constraint c3 { eng == eng::big }
      } }`;
    const a = run(src).owners[0].analysis!;
    expect(a.void).toBe(true);
    expect(a.voidCore!.slice().sort()).toEqual(['c1', 'c2', 'c3']);
    const d = run(src).diagnostics.find((x) => x.code === VARIABILITY_CODES.void)!;
    expect(d.message).toContain('conflicting constraints');
    // not void: a dead variant names the constraint that kills it
    const dead = run(src.replace('assert constraint c1', 'assert constraint c1x { eng == eng::big }  assert constraint c1').replace(/assert constraint c[123] \{[^}]*\}/g, (m) => (m.includes('c1x') ? m : ''))).owners[0].analysis!;
    expect(dead.void).toBe(false);
    expect(dead.deadWhy.some((x) => x.variant.endsWith('small') && x.killedBy.includes('c1x'))).toBe(true);
  });

  it('a non-void, constraint-free family has no explanation and no evaluation', () => {
    const o = run(car('')).owners[0];
    expect(o.evaluations).toEqual([]);
    expect(o.analysis!.voidCore).toBeNull();
  });
});

describe('a named configuration whose selection violates a constraint says so beside its selection status', () => {
  it('c1 (big) is marked VIOLATES, c2 (small) is not', () => {
    const src = `package P {
  part def Engine { attribute mass : Real; }
  part def Car {
    variation part eng : Engine {
      variant part small : Engine { attribute :>> mass = 100; }
      variant part big : Engine { attribute :>> mass = 400; }
    }
    attribute limit : Real = 200;
    assert constraint ok { eng.mass <= limit }
  }
  part c1 : Car { part :>> eng = eng::big; }
  part c2 : Car { part :>> eng = eng::small; }
}`;
    const text = variabilityLines(variabilityReport(parseModel(src).model), 'x').join('\n');
    const c1 = text.split('configuration P::c1')[1].split('configuration P::c2')[0];
    const c2 = text.split('configuration P::c2')[1] ?? '';
    expect(c1).toContain('VIOLATES constraint ok');
    expect(c2).not.toContain('VIOLATES');
  });
});

describe('state machines per configuration (V6)', () => {
  const rep = (src: string) => variabilityReport(parseModel(src).model);
  const beh = (src: string) => rep(src).diagnostics.filter((d) => d.code === VARIABILITY_CODES.behaviour || d.code === VARIABILITY_CODES.behaviourDead);

  it('p10: a variant that adds a state to the machine says "superset only", never silence', () => {
    const d = beh(`package P {
  part def Eng { state s { entry state a; state b; transition t first a accept Go then b; } }
  part def Car { variation part eng : Eng { variant part small : Eng; variant part big : Eng { state s2 { entry state z; } } } }
}`);
    const sup = d.filter((x) => x.message.includes('analysed on the superset only'));
    expect(sup.some((x) => x.message.includes('big'))).toBe(true);
    expect(sup.every((x) => x.severity === 'info')).toBe(true);
    // the point's machine is on the superset: no per-configuration claim
    expect(d.some((x) => x.code === VARIABILITY_CODES.behaviourDead)).toBe(false);
  });

  it('a variant-free machine is walked once and reported in one line', () => {
    const d = beh(`package P {
  part def Eng { state s { entry state a; state b; transition t first a accept Go then b; } }
  part def Car { variation part eng : Eng { variant part small : Eng; variant part big : Eng; } }
}`);
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('the same in every configuration');
    expect(d[0].message).toContain('every state reachable');
  });

  it('a variant that owns a machine: dead there, the machine does not exist in the other configuration', () => {
    const o = rep(`package P {
  part def Eng;
  part def Car {
    variation part eng : Eng {
      variant part small : Eng;
      variant part big : Eng { state m { entry state a; state b; state c; transition t first a accept Go then b; } }
    }
  }
}`);
    const d = o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead)!;
    expect(d.severity).toBe('warning');
    expect(d.message).toContain('present only in the configurations selecting eng::big (1 of 2)');
    expect(d.message).toContain('unreachable state(s) c');
    expect(d.message).toContain('in the others the machine does not exist');
    expect(o.owners[0].behaviour.machines[0].variants).toEqual(['eng::big']);
  });

  it('a correct variant machine stays silent about dead things', () => {
    const o = rep(`package P {
  part def Eng;
  part def Car {
    variation part eng : Eng {
      variant part small : Eng;
      variant part big : Eng { state m { entry state a; state b; transition t first a accept Go then b; } }
    }
  }
}`);
    expect(o.diagnostics.some((x) => x.code === VARIABILITY_CODES.behaviourDead)).toBe(false);
    expect(o.diagnostics.some((x) => x.code === VARIABILITY_CODES.behaviour && x.message.includes('every state reachable'))).toBe(true);
  });

  it('a cut walk is inconclusive: no reachability claim', () => {
    const states = Array.from({ length: 30 }, (_, i) => `state s${i}; transition first ${i === 0 ? 'a' : `s${i - 1}`} accept Go then s${i};`).join(' ');
    const o = rep(`package P {
  part def Eng;
  part def Car { variation part eng : Eng { variant part small : Eng; variant part big : Eng { state m { entry state a; ${states} } } } }
}`);
    const ms = o.owners[0].behaviour.machines;
    for (const m of ms.filter((x) => !x.conclusive)) {
      expect(m.unreachable).toEqual([]);
      expect(m.dead).toEqual([]);
    }
    expect(variabilityLines(o, 'x').join('\n')).toContain('machine');
  });

  it('a variant of a variation state is read on the superset only', () => {
    const d = beh(`package P {
  part def Car { state mode { variation state drive { variant state eco; variant state sport; } } }
}`);
    expect(d.every((x) => x.severity === 'info')).toBe(true);
  });

  const REDEF = (bigBody: string, baseBody = 'entry state a; state b; state c; transition t first a accept Go then b;') => `package P {
  part def Eng { state s { ${baseBody} } }
  part def Car { variation part eng : Eng { variant part small : Eng; variant part big : Eng { state s :>> Eng::s { ${bigBody} } } } }
}`;

  it('a variant that redefines the machine (it keeps the members it redefines, sm-inherit): c is unreachable only where the redefinition is not selected', () => {
    const o = rep(REDEF('transition t2 first b accept Go then c;'));
    const d = o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead)!;
    expect(d.severity).toBe('warning');
    expect(d.message).toContain('walked per configuration');
    expect(d.message).toContain('the configurations selecting none of eng::big (1 of 2): unreachable state(s) c');
    expect(d.message).toContain('the configurations selecting eng::big (1 of 2): every state reachable and no transition dead');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('a correct redefinition stays silent about dead things', () => {
    const o = rep(REDEF('state d; transition t2 first b accept Go then d;', 'entry state a; state b; transition t first a accept Go then b;'));
    expect(o.diagnostics.some((x) => x.code === VARIABILITY_CODES.behaviourDead)).toBe(false);
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration') && x.message.includes('every state reachable'))).toBe(true);
  });

  const INM = (bigBody: string, baseBody = 'entry state a; state b; state c; transition t first a accept Go then b;', extra = '') => `package P {
  part def Eng { state s { ${baseBody} } }
  part def Car { variation part eng : Eng { variant part small : Eng; variant part big : Eng { state s :>> Eng::s { ${bigBody} } } ${extra} } }
}`;

  it('a variant adding a transition inside the owner machine: c is reachable only where it is selected', () => {
    const o = rep(INM('transition t2 first b accept Go then c;'));
    const d = o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead)!;
    expect(d.severity).toBe('warning');
    expect(d.message).toContain('the configurations selecting none of eng::big (1 of 2): unreachable state(s) c');
    expect(d.message).toContain('the configurations selecting eng::big (1 of 2): every state reachable and no transition dead');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('a variant adding a state and its transition inside the owner machine stays silent when all is reachable', () => {
    const o = rep(INM('state d; transition t2 first b accept Go then d;', 'entry state a; state b; transition t first a accept Go then b;'));
    expect(o.diagnostics.some((x) => x.code === VARIABILITY_CODES.behaviourDead)).toBe(false);
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration') && x.message.includes('every state reachable'))).toBe(true);
  });

  it('a variant redefining a transition target leaves a state dead only in its configuration', () => {
    const o = rep(INM('transition t :>> Eng::s::t first a accept Go then c;', 'entry state a; state b; state c; transition t first a accept Go then b;'));
    const d = o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead)!;
    expect(d.message).toContain('selecting none of eng::big (1 of 2): unreachable state(s) c');
    expect(d.message).toContain('selecting eng::big (1 of 2): unreachable state(s) b');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('a whole-machine variant and an in-machine variant of the same point are both read', () => {
    const o = rep(INM('transition t2 first b accept Go then c;', undefined, 'variant part other : Eng { state s :>> Eng::s { entry state a9; state b9; transition t9 first a9 accept Go then b9; } }'));
    const d = o.diagnostics.find((x) => x.message.includes('walked per configuration'))!;
    expect(d).toBeDefined();
    expect(d.message).toContain('eng::other');
    expect(d.message).toContain('every state reachable and no transition dead');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  const NEST = 'entry state a; state b { entry state x; state y; transition tx first x accept Go then y; } transition t first a accept Go then b;';

  it('V6a: a variant redefining a state of the machine adds its members to it: reachability per configuration', () => {
    const o = rep(INM('state b :>> Eng::s::b { entry state i1; state i2; state i3; transition ti first i1 accept Go then i2; }', 'entry state a; state b; transition t first a accept Go then b;'));
    const d = o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead)!;
    expect(d.message).toContain('walked per configuration');
    expect(d.message).toContain('selecting none of eng::big (1 of 2): every state reachable and no transition dead');
    expect(d.message).toContain('selecting eng::big (1 of 2): unreachable state(s) i3');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('V6a: a correct state redefinition stays silent about dead things', () => {
    const o = rep(INM('state b :>> Eng::s::b { entry state i1; state i2; transition ti first i1 accept Go then i2; }', 'entry state a; state b; transition t first a accept Go then b;'));
    expect(o.diagnostics.some((x) => x.code === VARIABILITY_CODES.behaviourDead)).toBe(false);
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration') && x.message.includes('every state reachable'))).toBe(true);
  });

  it('R1: a state redefinition bringing an entry without redefining the one the state has is a conflict reading, nothing claimed', () => {
    const o = rep(INM('state b :>> Eng::s::b { entry state i1; state i2; }', 'entry state a; state b { entry state x; state y; } transition t first a accept Go then b;'));
    const d = o.diagnostics.find((x) => x.message.includes('walked per configuration'))!;
    expect(d.message).toContain('selecting eng::big (1 of 2): conflict (eng::big: it brings an entry action to b, which has one, without redefining it)');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only') && x.message.includes('big'))).toBe(false);
  });

  const ENT = (bigEntry: string) => INM(`state b :>> Eng::s::b { ${bigEntry} }`, 'entry state a; state b { entry action en; then x; state x; state y; } transition t first a accept Go then b;');

  it('R1: an entry action the variant redefines replaces the inherited one: x is unreachable only where it is selected', () => {
    const o = rep(ENT('entry action en2 :>> Eng::s::b::en; then y;'));
    const d = o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead)!;
    expect(d.message).toContain('selecting none of eng::big (1 of 2): unreachable state(s) y');
    expect(d.message).toContain('selecting eng::big (1 of 2): unreachable state(s) x');
    expect(d.message).not.toContain('conflict');
  });

  it('R1: a replaced entry that opens the same states stays silent about dead things', () => {
    const o = rep(INM('state b :>> Eng::s::b { entry action en2 :>> Eng::s::b::en; then x; }', 'entry state a; state b { entry action en; then x; state x; } transition t first a accept Go then b;'));
    expect(o.diagnostics.some((x) => x.code === VARIABILITY_CODES.behaviourDead)).toBe(false);
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration') && x.message.includes('every state reachable'))).toBe(true);
  });

  it('R1: an exit action added without redefining the inherited one is a conflict, never a pick', () => {
    const o = rep(INM('state b :>> Eng::s::b { exit action out2; }', 'entry state a; state b { exit action out1; } transition t first a accept Go then b;'));
    const d = o.diagnostics.find((x) => x.message.includes('walked per configuration'))!;
    expect(d.message).toContain('conflict (eng::big: it brings an exit action to b, which has one, without redefining it)');
  });

  it('R1: an entry action the state does not have yet is just added', () => {
    const o = rep(INM('state b :>> Eng::s::b { entry action en2; }', 'entry state a; state b; transition t first a accept Go then b;'));
    expect(o.diagnostics.some((x) => x.message.includes('conflict'))).toBe(false);
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration'))).toBe(true);
  });

  it('R2: a transition naming a state the variant redefines is resolved to the redefined state: c reachable only where selected', () => {
    const o = rep(INM('state b :>> Eng::s::b { state i; } transition t2 first b accept Go then c;', 'entry state a; state b; state c; transition t first a accept Go then b;'));
    const d = o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead)!;
    expect(d.message).toContain('selecting none of eng::big (1 of 2): unreachable state(s) c');
    expect(d.message).toContain('selecting eng::big (1 of 2): every state reachable and no transition dead');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('R2: a correct transition from a redefined state stays silent about dead things', () => {
    const o = rep(INM('state b :>> Eng::s::b { state i; } transition t2 first b accept Go then c;', 'entry state a; state b; state c; transition t first a accept Go then b; transition t3 first a accept Go2 then c;'));
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration'))).toBe(true);
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('V6b: a redefinition nested two states deep: y is unreachable only where the transition is redefined', () => {
    const o = rep(INM('state b :>> Eng::s::b { transition tx :>> Eng::s::b::tx first x accept Go then x; }', NEST));
    const d = o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead)!;
    expect(d.message).toContain('selecting none of eng::big (1 of 2): every state reachable and no transition dead');
    expect(d.message).toContain('selecting eng::big (1 of 2): unreachable state(s) y');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  const TWO = (big: string, g2: string) => `package P {
  part def Eng { state s { entry state a; state b; transition t first a accept Go then b; } }
  part def Car { variation part eng : Eng { variant part small : Eng; variant part big : Eng { state s :>> Eng::s { ${big} } } }
    variation part gear : Eng { variant part g1 : Eng; variant part g2 : Eng { state s :>> Eng::s { ${g2} } } } }
}`;

  it('V6c: variants of two variation points redefining the same machine are overlaid per configuration', () => {
    const o = rep(TWO('transition t2 first b accept Go then a;', 'state c; transition t3 first b accept Go then c;'));
    const d = o.diagnostics.find((x) => x.message.includes('walked per configuration'))!;
    expect(d.message).toContain('selecting eng::big and gear::g2 (1 of 4): every state reachable and no transition dead');
    expect(d.message).not.toContain('conflict');
    expect(o.diagnostics.some((x) => x.code === VARIABILITY_CODES.behaviourDead)).toBe(false);
  });

  it('V6c: two selected variants redefining the same transition differently are a conflict for that configuration, never a pick', () => {
    const o = rep(TWO('transition t4 :>> Eng::s::t first a accept Go then a;', 'transition t5 :>> Eng::s::t first a accept Go then b;'));
    const d = o.diagnostics.find((x) => x.message.includes('walked per configuration'))!;
    expect(d.message).toContain('selecting eng::big and gear::g2 (1 of 4): conflict (eng::big and gear::g2 both redefine or fill the same member');
    expect(d.message).toContain('selecting eng::big (1 of 4): unreachable state(s) b');
    expect(o.owners[0].behaviour.machines[0].readings!!.some((r) => r.why?.includes('both redefine'))).toBe(true);
  });

  const TWOB = (big: string, g2: string) => `package P {
  part def Eng { state s { entry state a; state b; transition t first a accept Go then b; } }
  part def Car { variation part eng : Eng { variant part small : Eng; variant part big : Eng { state s :>> Eng::s { state b :>> Eng::s::b { ${big} } } } }
    variation part gear : Eng { variant part g1 : Eng; variant part g2 : Eng { state s :>> Eng::s { state b :>> Eng::s::b { ${g2} } } } } }
}`;

  it('R5: two variants redefining the same state with disjoint members are merged, not a conflict', () => {
    const o = rep(TWOB('state i1; state i2; transition ti first i1 accept Go then i2;', 'state j1; state j2; transition tj first j1 accept Go then j2;'));
    const d = o.diagnostics.find((x) => x.message.includes('walked per configuration'))!;
    expect(d.message).toContain('selecting eng::big and gear::g2 (1 of 4)');
    expect(d.message).not.toContain('conflict');
  });

  it('R5: two variants redefining the same state and both adding a member of one name are a conflict, never a pick', () => {
    const o = rep(TWOB('state i1;', 'state i1;'));
    const d = o.diagnostics.find((x) => x.message.includes('walked per configuration'))!;
    expect(d.message).toContain('selecting eng::big and gear::g2 (1 of 4): conflict (eng::big and gear::g2 both redefine or fill the same member');
  });

  it('R3: a variant redefining the machine the point types only inherits is walked per configuration', () => {
    const o = rep(`package P {
  part def Eng { state s { entry state a; state b; transition t first a accept Go then b; } }
  part def Eng2 :> Eng;
  part def Car { variation part eng : Eng2 { variant part small : Eng2; variant part big : Eng2 { state s :>> Eng::s { state c; transition t2 first b accept Go then c; } } } }
}`);
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration'))).toBe(true);
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('var-sm6 R1: a variant redefining a machine that itself redefines an inherited one and owns no step is walked per configuration', () => {
    const o = rep(`package P {
  part def Eng { exhibit state s { entry state a; state b; state c; transition t first a accept Go then b; } }
  part def Eng2 :> Eng { exhibit state s :>> Eng::s; }
  part def Car { variation part eng : Eng2 { variant part small : Eng2; variant part big : Eng2 { state s :>> Eng2::s { state e; transition t2 first b accept Go then e; } } } }
}`);
    const d = perConfig(o, 'P::Eng2::s')!;
    expect(d.message).toContain('selecting none of eng::big (1 of 2): unreachable state(s) c');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('var-sm6 R1: a state the variant adds is reachable only in its configuration, through the empty redefining usage', () => {
    const o = rep(`package P {
  part def Eng { exhibit state s { entry state a; state b; transition t first a accept Go then b; } }
  part def Eng2 :> Eng { exhibit state s :>> Eng::s; }
  part def Car { variation part eng : Eng2 { variant part small : Eng2; variant part big : Eng2 { state s :>> Eng2::s { state e; transition t2 first b accept Go then e; } } } }
}`);
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration') && x.message.includes('selecting eng::big (1 of 2): every state reachable'))).toBe(true);
  });

  it('var-sm6 R1: a variant leaving an inherited state unreachable shows it only for its configuration', () => {
    const o = rep(`package P {
  part def Eng { exhibit state s { entry state a; state b; state c; transition t first a accept Go then b; transition u first b accept Go then c; } }
  part def Eng2 :> Eng { exhibit state s :>> Eng::s; }
  part def Car { variation part eng : Eng2 { variant part small : Eng2; variant part big : Eng2 { state s :>> Eng2::s { transition u :>> Eng::s::u first b accept Go then b; } } } }
}`);
    const d = perConfig(o, 'P::Eng2::s')!;
    expect(d.message).toContain('selecting none of eng::big (1 of 2): every state reachable');
    expect(d.message).toContain('selecting eng::big (1 of 2): unreachable state(s) c');
  });

  // var-sm6 R2: no fixed 16-group cap; a work budget instead.
  const MANY = (n: number, pad = 0) => `package P {
  part def Eng { state s { entry state a; state b; state c; ${Array.from({ length: pad }, (_, i) => `state p${i};`).join(' ')} transition t first a accept Go then b; } }
  part def Car { variation part eng : Eng { ${Array.from({ length: n }, (_, i) => `variant part v${i} : Eng { state s :>> Eng::s { transition t${i} first b accept Go then c; } }`).join(' ')} } }
}`;

  it('var-sm6 R2: more than 16 groups are walked per configuration (c unreachable only where no variant is selected)', () => {
    const o = rep(MANY(20));
    const d = o.diagnostics.find((x) => x.message.includes('the state machine P::Eng::s is walked per configuration'))!;
    expect(d).toBeDefined();
    expect(d.message).toContain('selecting eng::v19 (1 of 20): every state reachable');
    expect(o.owners[0].behaviour.machines[0].readings!!.length).toBe(20);
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('var-sm6 R2: past 16 groups a dead state is still found in one configuration only', () => {
    const src = MANY(19).replace('variant part v0 : Eng { state s :>> Eng::s { transition t0 first b accept Go then c; } }', 'variant part v0 : Eng { state s :>> Eng::s { state z; } }');
    const o = rep(src);
    const d = o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead)!;
    expect(d.message).toContain('selecting eng::v0 (1 of 19): unreachable state(s) c, z');
    expect(d.message).toContain('selecting eng::v5 (1 of 19): every state reachable');
  });

  it('var-sm6 R2: a family past the walk budget keeps the superset-only info, no per-configuration claim', () => {
    const o = rep(MANY(20, 200));
    expect(perConfig(o, 'P::Eng::s')).toBeUndefined();
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only') && x.message.includes('v0'))).toBe(true);
    expect(o.diagnostics.some((x) => x.code === VARIABILITY_CODES.behaviourDead && x.message.includes('walked per configuration'))).toBe(false);
  });

  // sm-inherit I2: Eng2::s redefines Eng::s and owns a step, so it is walked on the effective machine; a variant redefining
  // a member Eng2::s only inherits from Eng::s is overlaid on that effective machine.
  const I2 = (body: string, extra = '') => `package P {
  part def Eng { exhibit state s { entry state a; state b; state c; transition t first a accept Go then b; } }
  part def Eng2 :> Eng { exhibit state s :>> Eng::s { state d; transition t2 first b accept g2 then d; } }
  part def Car { variation part eng : Eng2 { variant part small : Eng2; variant part big : Eng2 { state s :>> Eng2::s { ${body} } } ${extra} } }
}`;
  const perConfig = (o: ReturnType<typeof rep>, machine: string) => o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead && x.message.includes(`the state machine ${machine} is walked per configuration`));

  it('I2: a variant redefining a transition inherited through the redefining machine is walked per configuration', () => {
    const o = rep(I2('transition t :>> Eng::s::t first a accept Go then c;'));
    const d = perConfig(o, 'P::Eng2::s')!;
    expect(d.message).toContain('selecting none of eng::big (1 of 2): unreachable state(s) c');
    expect(d.message).toContain('selecting eng::big (1 of 2): unreachable state(s) b, d; dead transition(s) t2');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('I2: a variant redefining an inherited state with a body adds its members to the effective machine', () => {
    const o = rep(I2('state b :>> Eng::s::b { entry state i1; state i2; transition ti first i1 accept Go then i2; }'));
    const d = perConfig(o, 'P::Eng2::s')!;
    expect(d.message).toContain('selecting eng::big (1 of 2): unreachable state(s) c');
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(false);
  });

  it('I2: a variant redefining an own member of the redefining machine is walked per configuration', () => {
    const o = rep(I2('transition t2 :>> Eng2::s::t2 first b accept g2 then c;'));
    const d = perConfig(o, 'P::Eng2::s')!;
    expect(d.message).toContain('selecting eng::big (1 of 2): unreachable state(s) d');
  });

  it('I2: a correct variant over the effective machine stays silent about dead things', () => {
    const o = rep(`package P {
  part def Eng { exhibit state s { entry state a; state b; transition t first a accept Go then b; } }
  part def Eng2 :> Eng { exhibit state s :>> Eng::s { state d; transition t2 first b accept g2 then d; } }
  part def Car { variation part eng : Eng2 { variant part small : Eng2; variant part big : Eng2 { state s :>> Eng2::s { state e; transition t3 first d accept Go then e; } } } }
}`);
    expect(o.diagnostics.some((x) => x.code === VARIABILITY_CODES.behaviourDead)).toBe(false);
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration') && x.message.includes('every state reachable'))).toBe(true);
  });

  const VSH = (inner: string, extra = '') => `package P {
  part def Car { state mode { entry state off; state fin; variation state drive { state hum; ${inner} }
    transition t1 first off accept On then drive::eco; transition t2 first off accept Fast then drive::sport;
    transition t4 first drive::eco accept Done then fin; transition t5 first drive::sport accept Done then fin; ${extra} } }
}`;
  const msgs = (o: ReturnType<typeof rep>) => o.diagnostics.map((x) => x.message).join('\n');

  it('I3 (var-sm7): a variation state own member is inherited by every chosen variant (no variant redefines it)', () => {
    const o = rep(VSH('variant state eco; variant state sport;', 'transition t6 first drive::hum accept Go then fin;'));
    const t = msgs(o);
    expect(t).toContain('walked per configuration');
    expect(o.owners[0].behaviour.machines[0].readings!).toHaveLength(2);
    expect(t).not.toContain('analysed on the superset only');
    expect(t).not.toContain('unreachable state(s) hum');
  });

  it('I3 (var-sm7): a variant with no own members still has the shared members', () => {
    const o = rep(VSH('variant state eco; variant state sport { state own; }'));
    expect(msgs(o)).toContain('walked per configuration');
    expect(o.owners[0].behaviour.machines[0].readings!.every((r) => r.conclusive)).toBe(true);
  });

  it('I3 (var-sm7): a variant redefining the shared member is walked with the redefinition, the original is not', () => {
    const o = rep(VSH('variant state eco { state hum :>> drive::hum { entry state a; state b; transition tx first a accept G then b; } } variant state sport;'));
    const t = msgs(o);
    expect(t).toContain('walked per configuration');
    expect(t).not.toContain('analysed on the superset only');
    expect(o.owners[0].behaviour.machines[0].readings!).toHaveLength(2);
    expect(o.owners[0].behaviour.machines[0].readings!.every((r) => r.conclusive)).toBe(true);
  });

  it('I3 (var-sm7): a variant member with the shared name and no redefinition is a conflict reading', () => {
    const o = rep(VSH('variant state eco { state hum; } variant state sport;'));
    const t = msgs(o);
    expect(t).toContain('conflict');
    expect(t).toContain('does not redefine');
    const rd = o.owners[0].behaviour.machines[0].readings!;
    expect(rd.find((r) => r.label.includes('eco'))!.conclusive).toBe(false);
    expect(rd.find((r) => r.label.includes('sport'))!.conclusive).toBe(true);
  });

  it('I3b (sm-par-dwell): the variation state entry action is inherited by a variant with none, and walked', () => {
    const o = rep(VSH('entry action en; variant state eco; variant state sport;'));
    const t = msgs(o);
    expect(t).toContain('walked per configuration');
    expect(t).not.toContain('conflict');
    expect(o.owners[0].behaviour.machines[0].readings!.every((r) => r.conclusive)).toBe(true);
  });

  it('I3b: a variant entry action that redefines the inherited one replaces it; one that does not is a conflict reading', () => {
    const ok = rep(VSH('entry action en; variant state eco { entry action en2 :>> drive::en; } variant state sport;'));
    expect(msgs(ok)).not.toContain('conflict');
    expect(ok.owners[0].behaviour.machines[0].readings!.every((r) => r.conclusive)).toBe(true);
    const bad = rep(VSH('entry action en; variant state eco { entry action en2; } variant state sport;'));
    expect(msgs(bad)).toContain('conflict');
    expect(msgs(bad)).toContain('does not redefine the entry action');
    const rd = bad.owners[0].behaviour.machines[0].readings!;
    expect(rd.find((r) => r.label.includes('eco'))!.conclusive).toBe(false);
    expect(rd.find((r) => r.label.includes('sport'))!.conclusive).toBe(true);
  });

  it('I3b: an exit action clashes the same way, and a kind the variant does not bring stays inherited', () => {
    const bad = rep(VSH('exit action x1; variant state eco { exit action x2; } variant state sport;'));
    expect(msgs(bad)).toContain('does not redefine the exit action');
    const keep = rep(VSH('exit action x1; variant state eco { entry action e2; } variant state sport;'));
    expect(msgs(keep)).not.toContain('conflict');
  });

  it('I3 (var-sm7): a redefinition outside the variation state stays superset-only', () => {
    const o = rep(`package P {
  part def Car { state mode { entry state off; state fin; state other; variation state drive { variant state eco { state hum :>> mode::other; } variant state sport; }
    transition t1 first off accept On then drive::eco; transition t2 first off accept Fast then drive::sport; } }
}`);
    expect(msgs(o)).not.toContain('walked per configuration');
  });

  const VSTATE = (extra: string) => `package P {
  part def Car { state mode { entry state off; state fin; variation state drive { variant state eco; variant state sport; }
    transition t1 first off accept On then drive::eco; transition t2 first off accept Fast then drive::sport; ${extra} } }
}`;

  it('a variation state: a state reached only through one variant is unreachable where the other is chosen', () => {
    const o = rep(VSTATE('transition t4 first drive::eco accept Done then fin;'));
    const d = o.diagnostics.find((x) => x.code === VARIABILITY_CODES.behaviourDead)!;
    expect(d.severity).toBe('warning');
    expect(d.message).toContain('walked per configuration');
    expect(d.message).toContain('sport (1 of 2): unreachable state(s) fin');
    expect(d.message).toContain('eco (1 of 2): every state reachable and no transition dead');
    expect(o.owners[0].behaviour.machines[0].readings!).toHaveLength(2);
    expect(o.diagnostics.some((x) => x.message.includes('itself a state'))).toBe(false);
  });

  it('a variation state where every variant reaches the same states stays silent about dead things', () => {
    const o = rep(VSTATE('transition t4 first drive::eco accept Done then fin; transition t5 first drive::sport accept Done then fin;'));
    expect(o.diagnostics.some((x) => x.code === VARIABILITY_CODES.behaviourDead)).toBe(false);
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration') && x.message.includes('every state reachable'))).toBe(true);
  });

  it('a variant whose redefinition is not a whole machine keeps the superset-only line next to a readable one', () => {
    const o = rep(`package P {
  part def Eng { state s { entry state a; state b; transition t first a accept Go then b; } }
  part def Car { variation part eng : Eng { variant part small : Eng { state x { entry state y; } }
    variant part big : Eng { state s :>> Eng::s { entry state a2; state b2; transition t2 first a2 accept Go then b2; } } } }
}`);
    expect(o.diagnostics.some((x) => x.message.includes('analysed on the superset only'))).toBe(true);
    expect(o.diagnostics.some((x) => x.message.includes('walked per configuration'))).toBe(false);
    expect(o.diagnostics.every((x) => x.code !== VARIABILITY_CODES.behaviourDead)).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { RULES_BY_ID } from '@validation/index';
import { parseModel } from '@text/index';

const CODES = [
  'variation-variant-outside',
  'variation-member-not-variant',
  'variation-specializes-variation',
  'variation-variant-kind',
];

function run(src: string, id: string) {
  const m = parseModel(src).model;
  return RULES_BY_ID.get(id)!.run(m);
}
const all = (src: string) => CODES.flatMap((id) => run(src, id));

const EXAMPLES: Record<string, string> = {
  e1: 'package Spec {\n  part def Transmission; part def ManualTransmission :> Transmission; part def AutomaticTransmission :> Transmission;\n  variation part def TransmissionChoices :> Transmission {\n      variant part manual : ManualTransmission;\n      variant part automatic : AutomaticTransmission;\n  }\n}\n',
  e2: 'package Spec {\n  part def Engine; part def FourCylinderEngine :> Engine; part def SixCylinderEngine :> Engine;\n  // These are non-variant usages.\n  part smallEngine : FourCylinderEngine;\n  part bigEngine : SixCylinderEngine;\n  part def Vehicle {\n      variation part engine : Engine {\n          variant smallEngine;\n          variant bigEngine;\n      }\n  }\n}\n',
  a12: 'package A12 {\n  part def Vehicle; part vehicle_a : Vehicle;\n  part def Engine; part def Engine4Cyl :> Engine; part def Engine6Cyl :> Engine; part def Cylinder;\n  part def Transmission; part def TransmissionAutomatic :> Transmission; part def TransmissionManual :> Transmission; part def Sunroof;\n  attribute def LengthValue;\n  variation part def TransmissionChoices:>Transmission {\n      variant part transmissionAutomatic:TransmissionAutomatic;\n      variant part transmissionManual:TransmissionManual;\n  }\n  abstract part vehicleFamily:>vehicle_a{\n      variation part engine:Engine{\n          variant part engine4Cyl:Engine4Cyl;\n          variant part engine6Cyl:Engine6Cyl{\n              part cylinder:Cylinder [6]{\n                  variation attribute diameter:LengthValue{\n                      variant attribute smallDiameter:LengthValue;\n                      variant attribute largeDiagmeter:LengthValue;\n                  }\n              }\n          }\n       }\n       variation part transmission:TransmissionChoices;\n       variation part sunroof:Sunroof;\n       assert constraint selectionConstraint {\n           (engine==engine::engine4Cyl and\n               transmission==TransmissionChoices::transmissionManual) xor\n           (engine==engine::engine6Cyl and\n               transmission==TransmissionChoices::transmissionAutomatic)\n       }\n  }\n  part myCar :> vehicleFamily {\n      part :>> engine = engine::engine4Cyl;\n      part :>> transmission = TransmissionChoices::transmissionAutomatic;\n  }\n}\n',
};

describe('validation — variability (SysML v2 §7.6.7, §8.4.2.3)', () => {
  it('registers the four rules as errors', () => {
    for (const id of CODES) expect(RULES_BY_ID.get(id)!.severity).toBe('error');
  });

  it('variant outside a variation', () => {
    const d = run('package R { part def E; part def Bad { variant part x : E; } }', 'variation-variant-outside');
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('§7.6.7');
    expect(d[0].message).toContain('Bad::x');
  });

  it('a member of a variation that is not a variant', () => {
    const src = 'package R { part def E; variation part def V { variant part a : E; part n : E; part def Inner; } }';
    const d = run(src, 'variation-member-not-variant');
    expect(d).toHaveLength(2);
    expect(d[0].message).toContain('§8.4.2.3');
  });

  it('comments, doc and imports in a variation do not trip the member rule', () => {
    const src = `package R { part def E; variation part def V {
      doc /* about */
      /* a comment */
      comment c /* x */
      variant part a : E;
    } }`;
    expect(run(src, 'variation-member-not-variant')).toEqual([]);
  });

  it('a variation specializing a variation', () => {
    const d = run(
      'package R { part def E; variation part def V1 { variant part a : E; } variation part def V2 :> V1 { variant part b : E; } }',
      'variation-specializes-variation',
    );
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('§8.4.2.3');
  });

  it('a variant of the wrong kind', () => {
    const d = run('package R { variation part def V { variant action w; variant part ok; } }', 'variation-variant-kind');
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('§7.6.7');
    expect(d[0].message).toContain('V::w');
  });

  it('is silent on the specification examples and a variation specializing a non-variation', () => {
    for (const src of Object.values(EXAMPLES)) {
      expect(all(src)).toEqual([]);
    }
    expect(all('package R { part def E; variation part def V :> E { variant part a : E; } }')).toEqual([]);
  });

  describe('the checker names the verdict `sysprose variability` gives a selection constraint', () => {
    const FAM = (touring: string) => `package F { part def E; part def T;
      part def Fam {
        variation part engine : E { variant part e4 : E; variant part e6 : E; }
        variation part tr : T { variant part auto : T; variant part manual : T; }
        assert constraint sel { (engine == engine::e4 and tr == tr::manual) or (engine == engine::e6 and tr == tr::auto) }
      }
      part city : Fam { part :>> engine = engine::e4; part :>> tr = tr::manual; }
      part touring : Fam { part :>> engine = engine::e6; part :>> tr = ${touring}; }
    }`;
    const notes = (src: string) => ['constraint-violation', 'target-by-specialisation'].flatMap((id) => run(src, id));

    it('one note with the verdict per configuration, in place of "could not be evaluated" and one note per configuration', () => {
      const d = notes(FAM('tr::auto'));
      expect(d).toHaveLength(1);
      expect(d[0].ruleId).toBe('constraint-violation');
      expect(d[0].severity).toBe('info');
      expect(d[0].message).toContain('decided per configuration by `sysprose variability`: city HOLDS, touring HOLDS');
      expect(d[0].message).not.toContain('could not be evaluated');
    });

    it('a configuration it finds VIOLATED makes the note a warning, as any violated constraint', () => {
      const d = notes(FAM('tr::manual'));
      expect(d).toHaveLength(1);
      expect(d[0].severity).toBe('warning');
      expect(d[0].message).toContain('city HOLDS, touring VIOLATED');
    });

    it('a constraint the analysis does not read keeps the checker\'s own note', () => {
      const src = `package G { part def E; part def Fam {
        variation part engine : E { variant part e4 : E; }
        attribute k : Real;
        assert constraint other { k > 1.0 }
      } }`;
      const d = notes(src);
      expect(d.some((x) => x.message.includes('could not be evaluated'))).toBe(true);
      expect(d.every((x) => !x.message.includes('sysprose variability'))).toBe(true);
    });
  });
});

describe('validation — variability spec fences (warnings)', () => {
  const FENCES = [
    'variation-abstract-keyword',
    'variation-enum-keyword',
    'variation-variant-not-specializing',
    'variation-usage-typed-by-variation',
  ];
  const fences = (src: string) => FENCES.flatMap((id) => run(src, id));

  it('are registered as warnings', () => {
    for (const id of FENCES) expect(RULES_BY_ID.get(id)!.severity).toBe('warning');
  });

  it('abstract with variation (p1) is flagged; variation alone and abstract alone are silent', () => {
    const d = run('package P { part def Engine; abstract variation part def EC :> Engine { variant part a : Engine; } }', 'variation-abstract-keyword');
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('§7.6.7');
    expect(fences('package P { part def E; variation part def V :> E { variant part a : E; } abstract part def A; }')).toEqual([]);
  });

  it('a keyword on an enumeration (p5) is flagged; a plain enum def is silent', () => {
    const d = run('package P { variation enum def C3 { variant enum x; } abstract enum def D { enum q; } }', 'variation-enum-keyword');
    expect(d).toHaveLength(3);
    expect(d[0].message).toContain('§7.8.2');
    expect(fences('package P { enum def Color { enum red; enum green; } enum def C2 :> Color { enum blue; } }')).toEqual([]);
  });

  it('a variant that does not specialize its variation (p4) is flagged, definition and usage forms', () => {
    const d = run(
      'package P { part def Engine; part def Other; variation part def EC :> Engine { variant part a : Other; } part v { variation part e : Engine { variant part b : Other; } } }',
      'variation-variant-not-specializing',
    );
    expect(d).toHaveLength(2);
    expect(d[0].message).toContain('§8.4.2.3');
  });

  it('V3: the fence fires for every way a variation usage specializes a variation: subsetting, redefinition, nested typing', () => {
    const R = 'variation-usage-typed-by-variation';
    const T = 'part def T; variation part def TC :> T { variant part m : T; }';
    expect(run(`package P { ${T} part v { variation part base : T { variant part m : T; } variation part tr :> base; } }`, R)).toHaveLength(1);
    expect(run(`package P { ${T} part v { variation part base : T { variant part m : T; } variation part tr ::> base; } }`, R)).toHaveLength(1);
    expect(run(`package P { ${T} part def A { variation part base : T { variant part m : T; } } part def B :> A { variation part base2 :>> base; } }`, R)).toHaveLength(1);
    expect(run(`package P { ${T} part v { variation part tr :> TC; } }`, R)).toHaveLength(1);
    expect(run(`package P { ${T} part v { part w : T { variation part tr : TC; } } }`, R)).toHaveLength(1);
    expect(run(`package P { ${T} part v { variation part tr : TC { variant part z : T; } } }`, R)).toHaveLength(1);
  });

  it('V3: a plain usage subsetting or redefining a variation, a variation over a plain usage, and a reference-form variant stay silent', () => {
    const R = 'variation-usage-typed-by-variation';
    const T = 'part def T;';
    expect(run(`package P { ${T} part v { variation part base : T { variant part m : T; } part tr :> base; } }`, R)).toEqual([]);
    expect(run(`package P { ${T} part v { part base : T; variation part tr :> base { variant part m : T; } } }`, R)).toEqual([]);
    expect(run(`package P { ${T} part v { part sm : T; variation part e : T { variant sm; } } }`, R)).toEqual([]);
  });

  it('a conforming variant, a reference-form variant and an unresolved type stay silent', () => {
    const src = `package P { part def Engine; part def Small :> Engine; part sm : Small;
      variation part def EC :> Engine { variant part a : Small; variant part b : Engine; }
      part v { variation part e : Engine { variant part c : Small; variant sm; } } }`;
    expect(fences(src)).toEqual([]);
  });

  it('a variation usage typed by a variation definition (l.17210, A.12 form) is flagged; typing by a plain definition is silent', () => {
    const bad = 'package P { part def T; variation part def TC :> T { variant part m : T; } part v { variation part tr : TC; } }';
    const d = run(bad, 'variation-usage-typed-by-variation');
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('contradicts the normative text');
    expect(fences(EXAMPLES.e1)).toEqual([]);
    expect(fences('package P { part def T; part v { variation part tr : T { variant part m : T; } } }')).toEqual([]);
    expect(run(EXAMPLES.a12, 'variation-usage-typed-by-variation')).toHaveLength(1);
  });
});

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

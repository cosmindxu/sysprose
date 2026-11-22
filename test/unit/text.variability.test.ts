/**
 * SysML v2 §7.6.7 / §8.4.2.3 variation and variants: a `variant x;` with no kind keyword REFERENCES a usage declared
 * elsewhere (reference subsetting), and a variant has its variation as an implied general.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadModelText } from '@text/load';
import { serializeElement } from '@text/serializer';
import { effectiveFeatures, generalizationsOf, variantGeneral } from '@semantics/index';

const load = async (text: string): Promise<any> => loadModelText(text, { fileName: 'v.sysml' });
const find = (model: any, n: string) => model.all().find((e: any) => model.qualifiedName(e.id) === n);
const diags = (r: any) => r.diagnostics.filter((d: any) => d.severity === 'error' || d.severity === 'warning');
const probe = (f: string) => readFileSync(`/tmp/ps3/var/${f}`, 'utf8');

const E2 = `package Spec {
  part def Engine; part def FourCylinderEngine :> Engine; part def SixCylinderEngine :> Engine;
  part smallEngine : FourCylinderEngine;
  part bigEngine : SixCylinderEngine;
  part def Vehicle {
    variation part engine : Engine {
      variant smallEngine;
      variant bigEngine;
    }
  }
}
`;

describe('probe models load clean', () => {
  for (const f of ['e1.sysml', 'e2.sysml', 'a12.sysml']) {
    it(f, async () => {
      const r = await load(probe(f));
      expect(diags(r.report)).toEqual([]);
    });
  }
});

describe('variant reference (§7.6.7)', () => {
  it('relates the variant to the declared usage by reference subsetting', async () => {
    const { model, report } = await load(E2);
    expect(diags(report)).toEqual([]);
    const engine = find(model, 'Spec::Vehicle::engine');
    const variants = model.children(engine.id).filter((c: any) => c.attrs.isVariant === true);
    expect(variants).toHaveLength(2);
    const targets = variants.map((v: any) => {
      expect(v.declaredName).toBeUndefined();
      const rel = model.children(v.id).find((c: any) => c.eClass === 'ReferenceSubsetting');
      return model.qualifiedName(rel.target[0]);
    });
    expect(targets).toEqual(['Spec::smallEngine', 'Spec::bigEngine']);
    // no fresh feature named smallEngine was made
    expect(model.all().filter((e: any) => e.declaredName === 'smallEngine')).toHaveLength(1);
  });
  it('resolves a usage declared after the variation', async () => {
    const { model, report } = await load(
      'package P { part def V { variation part e { variant s; } } part s; }',
    );
    expect(diags(report)).toEqual([]);
    const v = model.all().find((x: any) => x.attrs.isVariant === true);
    expect(model.children(v.id).some((c: any) => c.eClass === 'ReferenceSubsetting')).toBe(true);
  });
  it('diagnoses an unresolved name and makes no fresh feature', async () => {
    const { model, report } = await load('package P { part def V { variation part e { variant nothere; } } }');
    expect(report.diagnostics.map((d: any) => d.code)).toContain('ref/unresolved-specialization');
    expect(model.all().some((e: any) => e.declaredName === 'nothere')).toBe(false);
  });
  it('round-trips as `variant smallEngine;`', async () => {
    const { model } = await load(E2);
    const out = serializeElement(model, find(model, 'Spec').id);
    expect(out).toContain('variant smallEngine;');
    expect(out).not.toMatch(/variant ::>/);
    const again = await load(out);
    expect(diags(again.report)).toEqual([]);
    expect(serializeElement(again.model, find(again.model, 'Spec').id)).toBe(out);
    const eng = find(again.model, 'Spec::Vehicle::engine');
    expect(again.model.children(eng.id).filter((c: any) => c.attrs.variantRef === true)).toHaveLength(2);
  });
  it('reads a qualified name and writes it back as the shortest reading name', async () => {
    const { model, report } = await load(E2.replace('variant smallEngine;', 'variant Spec::smallEngine;'));
    expect(diags(report)).toEqual([]);
    const v = model.all().find((x: any) => x.attrs.variantRef === true);
    expect(model.qualifiedName(model.children(v.id).find((c: any) => c.eClass === 'ReferenceSubsetting').target[0])).toBe('Spec::smallEngine');
    const out = serializeElement(model, find(model, 'Spec').id);
    expect(diags((await load(out)).report)).toEqual([]);
  });
  it('keeps a typed variant declaration (`variant part a : T;`) a declaration', async () => {
    const { model } = await load('package P { part def T; part def V { variation part e : T { variant part a : T; } } }');
    const a = find(model, 'P::V::e::a');
    expect(a.eClass).toBe('PartUsage');
    expect(a.attrs.variantRef).toBeUndefined();
  });
});

describe('implicit specialization of variants (§8.4.2.3)', () => {
  const SRC = `package P {
    part def Engine { attribute cylinders = 4; }
    part def Base { attribute weight = 9; }
    variation part def Choices :> Base { variant part a; variant part b; }
    part def Car { variation part engine : Engine { variant part small; variant part big; } }
  }`;
  it('a variant of a variation usage reads that usage and its type, with its features', async () => {
    const { model, report } = await load(SRC);
    expect(diags(report)).toEqual([]);
    const small = find(model, 'P::Car::engine::small');
    const engine = find(model, 'P::Car::engine');
    expect(variantGeneral(model, small.id).map((g: any) => g.id)).toEqual([engine.id]);
    const gens = generalizationsOf(model, small.id).map((g: any) => model.qualifiedName(g.id));
    expect(gens).toContain('P::Car::engine');
    expect(gens).toContain('P::Engine');
    const feats = effectiveFeatures(model, small.id).map((f: any) => f.declaredName);
    expect(feats).toContain('cylinders');
    expect(feats).not.toContain('big'); // a sibling variant is not an inherited feature
    const cyl = effectiveFeatures(model, small.id).find((f: any) => f.declaredName === 'cylinders');
    expect(cyl?.attrs.value).toBe(4);
  });
  it('a variant of a variation definition is defined by it', async () => {
    const { model } = await load(SRC);
    const a = find(model, 'P::Choices::a');
    const choices = find(model, 'P::Choices');
    expect(variantGeneral(model, a.id).map((g: any) => g.id)).toEqual([choices.id]);
    const feats = effectiveFeatures(model, a.id).map((f: any) => f.declaredName);
    expect(feats).toContain('weight');
  });
  it('is derived, not materialised: the isVariant / isVariation attrs and the text are unchanged', async () => {
    const { model } = await load(SRC);
    expect(find(model, 'P::Car::engine').attrs.isVariation).toBe(true);
    expect(find(model, 'P::Car::engine::small').attrs.isVariant).toBe(true);
    expect(model.children(find(model, 'P::Car::engine::small').id)).toHaveLength(0);
    const out = serializeElement(model, find(model, 'P').id);
    expect(out).toContain('variant part small;');
  });
  it('a non-variant is untouched', async () => {
    const { model } = await load('package P { part def E; part x : E { part y; } }');
    expect(variantGeneral(model, find(model, 'P::x::y').id)).toEqual([]);
  });
});

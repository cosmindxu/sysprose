/**
 * Unit tests for the *extended* SysML symbol/adornment set (task M5):
 *  - portSymbolFor: proxy (open square) vs full (filled square), conjugation `~`.
 *  - adornmentsFor: «keyword» guillemet for every metaclass + abstract/variation/
 *    variant/derived/readonly modifier flags.
 *  - edgeStyleFor: exhaustive marker/line-style coverage across the relationship
 *    families (composition/aggregation/reference/specialization/dependency/…).
 * All are pure resolvers, verified without a React Flow render context.
 */

import { describe, expect, it } from 'vitest';
import { portSymbolFor, adornmentsFor, nodeVariantFor } from '@diagram/nodes';
import { edgeStyleFor, MARKER } from '@diagram/edges';

describe('portSymbolFor — proxy vs full & conjugation', () => {
  it('a full port is a filled square, a proxy port an open square', () => {
    expect(portSymbolFor({ portKind: 'full' }).shape).toBe('full');
    expect(portSymbolFor({ portKind: 'proxy' }).shape).toBe('proxy');
    // portKind may live on the nested attrs bag.
    expect(portSymbolFor({ attrs: { portKind: 'proxy' } }).shape).toBe('proxy');
    // A metaclass hint also selects proxy.
    expect(portSymbolFor({ kind: 'ProxyPortUsage' }).shape).toBe('proxy');
  });

  it('plain ports default to full (filled) squares', () => {
    expect(portSymbolFor({ name: 'fuelPort' }).shape).toBe('full');
    expect(portSymbolFor({}).shape).toBe('full');
  });

  it('detects conjugation from a flag or a ~-prefixed label', () => {
    expect(portSymbolFor({ conjugated: true }).conjugated).toBe(true);
    expect(portSymbolFor({ attrs: { conjugated: true } }).conjugated).toBe(true);
    expect(portSymbolFor({ name: '~fuelPort' }).conjugated).toBe(true);
    expect(portSymbolFor({ name: 'fuelPort' }).conjugated).toBe(false);
  });
});

describe('adornmentsFor — keyword guillemets + modifier flags', () => {
  it('always emits the «keyword» guillemet for the metaclass first', () => {
    expect(adornmentsFor('PartUsage', {})[0]).toBe('«part»');
    expect(adornmentsFor('PartDefinition', {})[0]).toBe('«part def»');
    expect(adornmentsFor('RequirementUsage', {})[0]).toBe('«requirement»');
    // Unknown metaclass falls back to a data.keyword, else the metaclass name.
    expect(adornmentsFor('WidgetUsage', { keyword: 'widget' })[0]).toBe('«widget»');
    expect(adornmentsFor('WidgetUsage', {})[0]).toBe('«WidgetUsage»');
  });

  it('flags abstract / variation / variant / derived / readonly (data or attrs)', () => {
    expect(adornmentsFor('PartUsage', { isAbstract: true })).toContain('abstract');
    expect(adornmentsFor('PartDefinition', { isVariation: true })).toContain('variation');
    expect(adornmentsFor('PartUsage', { isVariant: true })).toContain('variant');
    expect(adornmentsFor('AttributeUsage', { isDerived: true })).toContain('derived');
    expect(adornmentsFor('AttributeUsage', { isReadonly: true })).toContain('readonly');
    // Flags read from the nested attrs bag (as the langium mapper stores them).
    expect(adornmentsFor('PartDefinition', { attrs: { isAbstract: true } })).toContain('abstract');
  });

  it('emits only the keyword when there are no modifier flags', () => {
    expect(adornmentsFor('PartUsage', {})).toEqual(['«part»']);
  });
});

describe('nodeVariantFor — distinct case/analysis/verification/view families', () => {
  it('maps the case/analysis/verification/viewpoint/view families to variants', () => {
    expect(nodeVariantFor('CaseUsage')).toBe('case');
    expect(nodeVariantFor('UseCaseDefinition')).toBe('case');
    expect(nodeVariantFor('AnalysisCaseUsage')).toBe('analysis');
    expect(nodeVariantFor('VerificationCaseDefinition')).toBe('verification');
    expect(nodeVariantFor('ViewpointUsage')).toBe('viewpoint');
    expect(nodeVariantFor('ViewDefinition')).toBe('view');
    // Existing variants remain intact.
    expect(nodeVariantFor('ConstraintUsage')).toBe('constraint');
    expect(nodeVariantFor('RequirementUsage')).toBe('requirement');
    expect(nodeVariantFor('PartUsage')).toBe('default');
  });
});

describe('edgeStyleFor — exhaustive marker/line coverage', () => {
  it('composition = filled diamond, aggregation = open diamond (source end)', () => {
    expect(edgeStyleFor('composite').markerStart).toBe(MARKER.composite);
    expect(edgeStyleFor('composition').markerStart).toBe(MARKER.composite);
    expect(edgeStyleFor('aggregate').markerStart).toBe(MARKER.aggregate);
    expect(edgeStyleFor('aggregation').markerStart).toBe(MARKER.aggregate);
    expect(edgeStyleFor('reference').markerStart).toBe(MARKER.reference);
    // Aggregation's diamond is distinct from composition's.
    expect(MARKER.aggregate).not.toBe(MARKER.composite);
  });

  it('specialization family = hollow triangle at the general (target) end', () => {
    for (const k of ['specialize', 'specialization', 'subclassification', 'subsetting', 'redefinition']) {
      expect(edgeStyleFor(k).markerEnd).toBe(MARKER.specialize);
      expect(edgeStyleFor(k).dashed).toBeFalsy();
    }
    // Feature typing keeps the triangle but a dashed line.
    for (const k of ['typed-by', 'typing', 'feature-typing']) {
      expect(edgeStyleFor(k).markerEnd).toBe(MARKER.specialize);
      expect(edgeStyleFor(k).dashed).toBe(true);
    }
  });

  it('dependency family = dashed + open arrow + «keyword» (incl. include)', () => {
    const cases: Array<[string, string]> = [
      ['satisfy', 'satisfy'],
      ['verify', 'verify'],
      ['refine', 'refine'],
      ['derive', 'derive'],
      ['trace', 'trace'],
      ['allocate', 'allocate'],
      ['dependency', 'dependency'],
      ['include', 'include'],
    ];
    for (const [kind, keyword] of cases) {
      const s = edgeStyleFor(kind);
      expect(s.dashed).toBe(true);
      expect(s.markerEnd).toBe(MARKER.open);
      expect(s.keyword).toBe(keyword);
    }
  });

  it('containment carries the ⊕ crosshair at the owner (source) end', () => {
    const s = edgeStyleFor('containment');
    expect(s.markerStart).toBe(MARKER.crosshair);
    expect(s.markerEnd).toBe(MARKER.arrow);
  });

  it('behavioural flow (succession/transition/flow/bind) is a solid filled arrow', () => {
    for (const k of ['succession', 'transition', 'flow', 'bind']) {
      expect(edgeStyleFor(k).markerEnd).toBe(MARKER.arrow);
      expect(edgeStyleFor(k).dashed).toBeFalsy();
    }
  });

  it('connection/interface are plain (unmarked) coloured lines', () => {
    expect(edgeStyleFor('connection').markerStart).toBeUndefined();
    expect(edgeStyleFor('connection').markerEnd).toBeUndefined();
    expect(edgeStyleFor('connection').stroke).toBeTruthy();
  });

  it('an unknown kind falls back to a plain filled arrow', () => {
    expect(edgeStyleFor('mystery').markerEnd).toBe(MARKER.arrow);
  });
});

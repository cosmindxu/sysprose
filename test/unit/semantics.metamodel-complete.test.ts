import { describe, it, expect } from 'vitest';
import { isKindOf, DIRECT_SUPERTYPES } from '../../src/semantics/index';
import stdlibJson from '../../src/library/std/stdlib.json';

/**
 * Completeness bar: collect EVERY distinct `eClass` in the bundled standard
 * library and assert the metaclass hierarchy classifies each as a kind of
 * `Element`. This is the load-bearing test that the DIRECT_SUPERTYPES lattice
 * actually covers the full KerML+SysML abstract syntax the library exercises.
 */
function libraryMetaclasses(): string[] {
  const data = stdlibJson as unknown as { elements: Array<{ eClass: string }> };
  return [...new Set(data.elements.map((e) => e.eClass))].sort();
}

describe('semantics — metaclass hierarchy is complete over the standard library', () => {
  const metaclasses = libraryMetaclasses();

  it('the library uses a non-trivial set of distinct metaclasses', () => {
    // Guards against silently reading an empty/relocated bundle.
    expect(metaclasses.length).toBeGreaterThanOrEqual(80);
  });

  it('EVERY distinct library metaclass is a kind of Element', () => {
    const missing = metaclasses.filter((mc) => !isKindOf(mc, 'Element'));
    expect(missing, `metaclasses not reaching Element: ${missing.join(', ')}`).toEqual([]);
  });

  it('EVERY distinct library metaclass has an entry in the hierarchy', () => {
    const absent = metaclasses.filter((mc) => DIRECT_SUPERTYPES[mc] === undefined);
    expect(absent, `metaclasses missing a DIRECT_SUPERTYPES entry: ${absent.join(', ')}`).toEqual([]);
  });

  it('every hierarchy entry (not just library ones) bottoms out at Element (acyclic)', () => {
    const orphans = Object.keys(DIRECT_SUPERTYPES).filter((mc) => !isKindOf(mc, 'Element'));
    expect(orphans, `metaclasses not reaching Element: ${orphans.join(', ')}`).toEqual([]);
  });

  it('the previously-missing library metaclasses are now classified correctly', () => {
    expect(isKindOf('AllocationDefinition', 'ConnectionDefinition')).toBe(true);
    expect(isKindOf('AllocationUsage', 'ConnectionUsage')).toBe(true);
    expect(isKindOf('AssertConstraintUsage', 'ConstraintUsage')).toBe(true);
    expect(isKindOf('AssociationStructure', 'Association')).toBe(true);
    expect(isKindOf('AssociationStructure', 'Structure')).toBe(true);
    expect(isKindOf('ConjugatedPortDefinition', 'PortDefinition')).toBe(true);
    expect(isKindOf('EventOccurrenceUsage', 'OccurrenceUsage')).toBe(true);
    expect(isKindOf('SuccessionAsUsage', 'Succession')).toBe(true);
    expect(isKindOf('SuccessionAsUsage', 'ConnectionUsage')).toBe(true);
  });

  it('the KerML expression tower is classified through Step ▸ Feature', () => {
    expect(isKindOf('Expression', 'Step')).toBe(true);
    expect(isKindOf('Expression', 'Feature')).toBe(true);
    expect(isKindOf('OperatorExpression', 'InvocationExpression')).toBe(true);
    expect(isKindOf('OperatorExpression', 'Expression')).toBe(true);
    expect(isKindOf('LiteralInteger', 'LiteralExpression')).toBe(true);
    expect(isKindOf('LiteralInteger', 'Expression')).toBe(true);
    expect(isKindOf('NullExpression', 'Expression')).toBe(true);
    expect(isKindOf('FeatureReferenceExpression', 'Expression')).toBe(true);
  });

  it('the specialization & featuring relationship families are kinds of Relationship', () => {
    for (const mc of [
      'TypeFeaturing',
      'FeatureChaining',
      'FeatureInverting',
      'Unioning',
      'Intersecting',
      'Differencing',
      'Disjoining',
      'Conjugation',
    ]) {
      expect(isKindOf(mc, 'Relationship'), `${mc} should be a Relationship`).toBe(true);
      expect(isKindOf(mc, 'Element')).toBe(true);
    }
    // TypeFeaturing specializes the abstract Featuring.
    expect(isKindOf('TypeFeaturing', 'Featuring')).toBe(true);
  });

  it('membership variants are classified under FeatureMembership/OwningMembership', () => {
    expect(isKindOf('EndFeatureMembership', 'FeatureMembership')).toBe(true);
    expect(isKindOf('ParameterMembership', 'FeatureMembership')).toBe(true);
    expect(isKindOf('ReturnParameterMembership', 'ParameterMembership')).toBe(true);
    expect(isKindOf('ResultExpressionMembership', 'FeatureMembership')).toBe(true);
    expect(isKindOf('ReturnParameterMembership', 'OwningMembership')).toBe(true);
  });

  it('Multiplicity is a Feature and MultiplicityRange a Multiplicity', () => {
    expect(isKindOf('Multiplicity', 'Feature')).toBe(true);
    expect(isKindOf('MultiplicityRange', 'Multiplicity')).toBe(true);
    expect(isKindOf('MultiplicityRange', 'Feature')).toBe(true);
  });
});

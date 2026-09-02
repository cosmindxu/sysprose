import { describe, it, expect } from 'vitest';
import { ALL_METACLASSES } from '@core/index';
import { isKindOf, metaclassChain, DIRECT_SUPERTYPES } from '../../src/semantics/index';

describe('semantics — metaclass hierarchy (isKindOf / metaclassChain)', () => {
  it('a metaclass is a kind of itself (reflexive)', () => {
    expect(isKindOf('PartUsage', 'PartUsage')).toBe(true);
    expect(isKindOf('Usage', 'Usage')).toBe(true);
    expect(isKindOf('Element', 'Element')).toBe(true);
  });

  it('PartUsage is a kind of Usage, Feature, Type and Element', () => {
    expect(isKindOf('PartUsage', 'Usage')).toBe(true);
    expect(isKindOf('PartUsage', 'OccurrenceUsage')).toBe(true);
    expect(isKindOf('PartUsage', 'Feature')).toBe(true);
    expect(isKindOf('PartUsage', 'Type')).toBe(true);
    expect(isKindOf('PartUsage', 'Namespace')).toBe(true);
    expect(isKindOf('PartUsage', 'Element')).toBe(true);
  });

  it('PartUsage is NOT a kind of Relationship (it is a Feature, not an edge)', () => {
    expect(isKindOf('PartUsage', 'Relationship')).toBe(false);
    expect(isKindOf('PartUsage', 'Classifier')).toBe(false);
    expect(isKindOf('PartUsage', 'Definition')).toBe(false);
  });

  it('PartDefinition is a kind of Definition and Classifier but not a Feature', () => {
    expect(isKindOf('PartDefinition', 'Definition')).toBe(true);
    expect(isKindOf('PartDefinition', 'ItemDefinition')).toBe(true);
    expect(isKindOf('PartDefinition', 'Classifier')).toBe(true);
    expect(isKindOf('PartDefinition', 'Type')).toBe(true);
    expect(isKindOf('PartDefinition', 'Feature')).toBe(false);
    expect(isKindOf('PartDefinition', 'Usage')).toBe(false);
  });

  it('FeatureTyping (and the specialization family) are kinds of Relationship', () => {
    expect(isKindOf('FeatureTyping', 'Specialization')).toBe(true);
    expect(isKindOf('FeatureTyping', 'Relationship')).toBe(true);
    expect(isKindOf('FeatureTyping', 'Element')).toBe(true);
    expect(isKindOf('Redefinition', 'Subsetting')).toBe(true);
    expect(isKindOf('Redefinition', 'Relationship')).toBe(true);
    // A membership is a relationship but not a specialization.
    expect(isKindOf('FeatureMembership', 'OwningMembership')).toBe(true);
    expect(isKindOf('FeatureMembership', 'Relationship')).toBe(true);
    expect(isKindOf('FeatureMembership', 'Specialization')).toBe(false);
  });

  it('deep behavioral chains resolve (ConstraintUsage ▸ … ▸ ActionUsage ▸ … ▸ Feature)', () => {
    expect(isKindOf('ConstraintUsage', 'CalculationUsage')).toBe(true);
    expect(isKindOf('ConstraintUsage', 'ActionUsage')).toBe(true);
    expect(isKindOf('ConstraintUsage', 'Feature')).toBe(true);
    expect(isKindOf('RequirementUsage', 'ConstraintUsage')).toBe(true);
    // Control nodes are action-flow features.
    expect(isKindOf('ForkNode', 'ActionUsage')).toBe(true);
    expect(isKindOf('ForkNode', 'Feature')).toBe(true);
  });

  it('unknown metaclasses are only a kind of themselves', () => {
    expect(isKindOf('Bogus', 'Bogus')).toBe(true);
    expect(isKindOf('Bogus', 'Element')).toBe(false);
  });

  it('metaclassChain starts at the metaclass, ends at Element, and is ordered', () => {
    const chain = metaclassChain('PartUsage');
    expect(chain[0]).toBe('PartUsage');
    expect(chain[chain.length - 1]).toBe('Element');
    // Every supertype appears exactly once.
    expect(new Set(chain).size).toBe(chain.length);
    // Contains the expected ancestry.
    for (const mc of ['ItemUsage', 'OccurrenceUsage', 'Usage', 'Feature', 'Type', 'Namespace']) {
      expect(chain).toContain(mc);
    }
    // A subtype always precedes its supertype (nearest-first ordering).
    const idx = (mc: string): number => chain.indexOf(mc);
    expect(idx('Usage')).toBeLessThan(idx('Feature'));
    expect(idx('Feature')).toBeLessThan(idx('Type'));
    expect(idx('Type')).toBeLessThan(idx('Namespace'));
    expect(idx('Namespace')).toBeLessThan(idx('Element'));
  });

  it('metaclassChain of an unknown metaclass is just itself', () => {
    expect(metaclassChain('Bogus')).toEqual(['Bogus']);
  });

  it('every catalogued metaclass bottoms out at Element', () => {
    for (const mc of ALL_METACLASSES) {
      expect(DIRECT_SUPERTYPES[mc], `${mc} must be in the hierarchy`).toBeDefined();
      expect(isKindOf(mc, 'Element'), `${mc} should be a kind of Element`).toBe(true);
    }
  });
});

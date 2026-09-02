/**
 * Dedicated unit tests for {@link evaluateQuantity} and
 * {@link dimensionalFacets} (finding L13 — units-eval.ts previously untested).
 */

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { loadStandardLibrary } from '../../src/library/index';
import { evaluateQuantity, dimensionalFacets } from '../../src/semantics/units-eval';

function libModel(): Model {
  const m = new Model();
  loadStandardLibrary(m);
  return m;
}

describe('semantics — evaluateQuantity', () => {
  it('reads magnitude + dimension + unit from a feature with value + unit', () => {
    const m = libModel();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const mass = f.attribute('mass', p.id);
    m.setAttrs(mass.id, { value: '1500', unit: 'kg' });
    const q = evaluateQuantity(m, mass.id);
    expect(q).toBeDefined();
    expect(q!.magnitude).toBe(1500);
    expect(q!.unit).toBe('kg');
    expect(typeof q!.dimension).toBe('object');
    expect(q!.dimension.M).toBe(1);
  });

  it('returns undefined when the feature has no value', () => {
    const m = libModel();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const attr = f.attribute('unset', p.id);
    expect(evaluateQuantity(m, attr.id)).toBeUndefined();
  });

  it('returns undefined for a nonexistent feature id', () => {
    const m = libModel();
    expect(evaluateQuantity(m, 'nonexistent')).toBeUndefined();
  });

  it('returns magnitude without unit when only value is set', () => {
    const m = libModel();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const attr = f.attribute('count', p.id);
    m.setAttrs(attr.id, { value: '42' });
    const q = evaluateQuantity(m, attr.id);
    expect(q).toBeDefined();
    expect(q!.magnitude).toBe(42);
    expect(q!.unit).toBeUndefined();
  });
});

describe('semantics — dimensionalFacets', () => {
  it('returns unit and kind dimensions for a typed feature with a value unit', () => {
    const m = libModel();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const mass = f.attribute('mass', p.id);
    m.setAttrs(mass.id, { value: '1000', unit: 'kg' });
    const massValueType = m.resolveQualifiedName('ISQ::MassValue');
    if (massValueType) {
      m.create('FeatureTyping', { ownerId: mass.id, source: [mass.id], target: [massValueType.id] });
    }
    const facets = dimensionalFacets(m, mass.id);
    expect(facets).toBeDefined();
  });

  it('returns an empty object for a nonexistent feature', () => {
    const m = libModel();
    const facets = dimensionalFacets(m, 'nonexistent');
    expect(facets).toEqual({});
  });
});

import { describe, it, expect } from 'vitest';
import { buildSampleModel } from '@core/index';
import { evaluateQuery, type Query } from '@api/index';

function model() {
  return buildSampleModel();
}

describe('evaluateQuery — extended operators (<=, >=, matches)', () => {
  it('>= and <= bound a numeric attribute (inclusive)', () => {
    const m = model();
    expect(evaluateQuery(m, { constraint: { property: 'attrs.value', operator: '>=', value: 1500 } }).total).toBe(1);
    expect(evaluateQuery(m, { constraint: { property: 'attrs.value', operator: '<=', value: 1500 } }).total).toBe(1);
    expect(evaluateQuery(m, { constraint: { property: 'attrs.value', operator: '>=', value: 2000 } }).total).toBe(0);
    expect(evaluateQuery(m, { constraint: { property: 'attrs.value', operator: '<=', value: 1000 } }).total).toBe(0);
  });

  it('matches applies a regex to string properties', () => {
    const m = model();
    const r = evaluateQuery(m, { constraint: { property: 'declaredName', operator: 'matches', value: '^Vehicle' } });
    expect(r.elements.map((e) => e.declaredName).sort()).toEqual(['Vehicle', 'VehicleModel']);
    // Regex is case-sensitive, so lowercase 'vehicle' is excluded.
    const none = evaluateQuery(m, { constraint: { property: 'declaredName', operator: 'matches', value: '^zzz' } });
    expect(none.total).toBe(0);
  });
});

describe('evaluateQuery — OMG-canonical composite spelling', () => {
  it('{operator,constraint} and-composite matches the ergonomic {kind,operands}', () => {
    const m = model();
    const canonical: Query = {
      constraint: {
        operator: 'and',
        constraint: [
          { property: '@type', operator: '=', value: 'PortUsage' },
          { property: 'attrs.direction', operator: '=', value: 'out' },
        ],
      },
    };
    const ergonomic: Query = {
      constraint: {
        kind: 'and',
        operands: [
          { property: '@type', operator: '=', value: 'PortUsage' },
          { property: 'attrs.direction', operator: '=', value: 'out' },
        ],
      },
    };
    const a = evaluateQuery(m, canonical);
    const b = evaluateQuery(m, ergonomic);
    expect(a.total).toBe(1);
    expect(a.elements[0].declaredName).toBe('fuelOut');
    expect(a.elements.map((e) => e.id)).toEqual(b.elements.map((e) => e.id));
  });

  it('{operator,constraint} or/not composites evaluate correctly', () => {
    const m = model();
    const or = evaluateQuery(m, {
      constraint: {
        operator: 'or',
        constraint: [
          { property: 'name', operator: '=', value: 'Vehicle' },
          { property: 'name', operator: '=', value: 'Engine' },
        ],
      },
    });
    expect(or.total).toBe(2);
    const not = evaluateQuery(m, {
      constraint: { operator: 'not', constraint: [{ property: '@type', operator: '=', value: 'FeatureTyping' }] },
    });
    expect(not.elements.every((e) => e.eClass !== 'FeatureTyping')).toBe(true);
    expect(not.total).toBe(m.size - 2);
  });
});

describe('evaluateQuery — orderBy (stable multi-key)', () => {
  it('sorts ascending and descending by a string property', () => {
    const m = model();
    const base: Query = { constraint: { property: '@type', operator: '=', value: 'PartUsage' } };
    const asc = evaluateQuery(m, { ...base, orderBy: [{ property: 'name', direction: 'asc' }] });
    expect(asc.elements.map((e) => e.declaredName)).toEqual(['engine', 'vehicle']);
    const desc = evaluateQuery(m, { ...base, orderBy: [{ property: 'name', direction: 'desc' }] });
    expect(desc.elements.map((e) => e.declaredName)).toEqual(['vehicle', 'engine']);
  });

  it('is stable: equal keys preserve original insertion order', () => {
    const m = model();
    const r = evaluateQuery(m, { orderBy: [{ property: 'attrs.__absent__' }] });
    expect(r.elements.map((e) => e.id)).toEqual(m.all().map((e) => e.id));
    expect(r.total).toBe(m.size);
  });
});

describe('evaluateQuery — cursor pagination', () => {
  it('walks pages via nextCursor and stops when exhausted', () => {
    const m = model();
    const all = m.all();
    const p1 = evaluateQuery(m, { page: { size: 5 } });
    expect(p1.elements).toHaveLength(5);
    expect(p1.total).toBe(m.size);
    expect(p1.nextCursor).toBe(p1.elements[4].id);

    const p2 = evaluateQuery(m, { page: { size: 5, after: p1.nextCursor } });
    expect(p2.elements).toHaveLength(5);
    expect(p2.elements[0].id).toBe(all[5].id);
    expect(p2.nextCursor).toBe(all[9].id);

    const p3 = evaluateQuery(m, { page: { size: 5, after: p2.nextCursor } });
    expect(p3.elements).toHaveLength(m.size - 10);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('omits nextCursor when the page covers the whole result set', () => {
    const m = model();
    const r = evaluateQuery(m, { page: { size: 999 } });
    expect(r.elements).toHaveLength(m.size);
    expect(r.nextCursor).toBeUndefined();
  });

  it('an unknown cursor yields an empty page', () => {
    const m = model();
    const r = evaluateQuery(m, { page: { size: 5, after: 'no-such-id' } });
    expect(r.elements).toHaveLength(0);
    expect(r.total).toBe(m.size);
  });
});

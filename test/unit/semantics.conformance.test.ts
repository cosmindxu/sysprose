import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { loadStandardLibrary } from '../../src/library/index';
import { conforms, valueConformsToType } from '../../src/semantics/index';

function libModel(): Model {
  const m = new Model();
  loadStandardLibrary(m);
  return m;
}

describe('semantics — conformance (specialization)', () => {
  it('ScalarValues::Integer conforms to Real and to Number', () => {
    const m = libModel();
    const integer = m.resolveQualifiedName('ScalarValues::Integer')!;
    const real = m.resolveQualifiedName('ScalarValues::Real')!;
    const number = m.resolveQualifiedName('ScalarValues::Number')!;
    expect(conforms(m, integer.id, real.id)).toBe(true);
    expect(conforms(m, integer.id, number.id)).toBe(true);
  });

  it('Real does NOT conform to Integer', () => {
    const m = libModel();
    const integer = m.resolveQualifiedName('ScalarValues::Integer')!;
    const real = m.resolveQualifiedName('ScalarValues::Real')!;
    expect(conforms(m, real.id, integer.id)).toBe(false);
  });

  it('a type conforms to itself', () => {
    const m = libModel();
    const real = m.resolveQualifiedName('ScalarValues::Real')!;
    expect(conforms(m, real.id, real.id)).toBe(true);
  });

  it('a user subtype conforms to its supertype but not vice-versa', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const vehicle = f.partDef('Vehicle');
    const car = f.partDef('Car');
    f.subclassification(car.id, vehicle.id);
    expect(conforms(m, car.id, vehicle.id)).toBe(true);
    expect(conforms(m, vehicle.id, car.id)).toBe(false);
  });
});

describe('semantics — valueConformsToType', () => {
  it('accepts a matching numeric literal (Real / Integer)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const real = f.attribute('r', p.id, { type: 'Real', value: 3.14 });
    const int = f.attribute('i', p.id, { type: 'Integer', value: 42 });
    expect(valueConformsToType(m, real.id)).toBe('ok');
    expect(valueConformsToType(m, int.id)).toBe('ok');
  });

  it('flags a non-integer value on an Integer feature as mismatch', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const bad = f.attribute('i', p.id, { type: 'Integer', value: 3.5 });
    expect(valueConformsToType(m, bad.id)).toBe('mismatch');
  });

  it('enforces Natural (>=0) and Positive (>0)', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const nat = f.attribute('n', p.id, { type: 'Natural', value: -1 });
    const pos = f.attribute('pv', p.id, { type: 'Positive', value: 0 });
    const okNat = f.attribute('n2', p.id, { type: 'Natural', value: 0 });
    expect(valueConformsToType(m, nat.id)).toBe('mismatch');
    expect(valueConformsToType(m, pos.id)).toBe('mismatch');
    expect(valueConformsToType(m, okNat.id)).toBe('ok');
  });

  it('checks Boolean and String families', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const b = f.attribute('flag', p.id, { type: 'Boolean', value: true });
    const s = f.attribute('label', p.id, { type: 'String', value: '"hi"' });
    const bad = f.attribute('bad', p.id, { type: 'Boolean', value: 5 });
    expect(valueConformsToType(m, b.id)).toBe('ok');
    expect(valueConformsToType(m, s.id)).toBe('ok');
    expect(valueConformsToType(m, bad.id)).toBe('mismatch');
  });

  it('returns unknown when there is no value or no recognised type', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const noVal = f.attribute('x', p.id, { type: 'Real' });
    const noType = f.attribute('y', p.id, { value: 3 });
    expect(valueConformsToType(m, noVal.id)).toBe('unknown');
    expect(valueConformsToType(m, noType.id)).toBe('unknown');
  });
});

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { parseModel } from '../../src/text/index';
import {
  scopeFor,
  evaluateFeatureValue,
  checkConstraints,
} from '../../src/semantics/index';

/**
 * Build a requirement `maxMass` whose subject is typed by a Vehicle part def
 * carrying `mass`, and a `require { mass <= 2000 }` constraint — mirroring the
 * exact element/attr shape the Langium mapper produces for a `require` clause.
 */
function requirementModel(massValue?: number): {
  model: Model;
  constraintId: string;
} {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('P');
  const vehicle = f.partDef('Vehicle', pkg.id);
  f.attribute('mass', vehicle.id, massValue === undefined ? { type: 'Real' } : { type: 'Real', value: massValue });
  const req = f.requirement('maxMass', pkg.id, { reqId: 'R1' });
  const subj = m.create('ReferenceUsage', {
    declaredName: 'v',
    ownerId: req.id,
    attrs: { requirementRole: 'subject' },
  });
  f.featureTyping(subj.id, vehicle.id);
  const con = m.create('ConstraintUsage', {
    ownerId: req.id,
    attrs: { requirementRole: 'require', expression: 'mass <= 2000' },
  });
  return { model: m, constraintId: con.id };
}

describe('semantics — scopeFor / evaluateFeatureValue', () => {
  it('resolves bare feature names and dotted chains through a subject type', () => {
    const { model } = requirementModel(1500);
    const req = model.roots()[0]; // P
    const maxMass = model.descendants(req.id).find((e) => e.declaredName === 'maxMass')!;
    const scope = scopeFor(model, maxMass.id);
    expect(scope('mass')).toBe(1500);
    expect(scope('v.mass')).toBe(1500);
    expect(scope('nope')).toBeUndefined();
  });

  it('evaluates a feature value expression against sibling features', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    f.attribute('a', p.id, { type: 'Real', value: 3 });
    f.attribute('b', p.id, { type: 'Real', value: 4 });
    const total = f.attribute('total', p.id, { type: 'Real', value: 'a + b' });
    const r = evaluateFeatureValue(m, total.id);
    expect(r).toEqual({ value: 7 });
  });

  it('evaluates a plain numeric feature value', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const x = f.attribute('x', p.id, { type: 'Real', value: 42 });
    expect(evaluateFeatureValue(m, x.id)).toEqual({ value: 42 });
  });

  it('returns unknown for a feature with no value or expression', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('P');
    const x = f.attribute('x', p.id, { type: 'Real' });
    expect(evaluateFeatureValue(m, x.id)).toEqual({ unknown: true });
  });
});

describe('semantics — checkConstraints', () => {
  it("require { mass <= 2000 } with mass=1500 → satisfied", () => {
    const { model, constraintId } = requirementModel(1500);
    const checks = checkConstraints(model);
    const c = checks.find((x) => x.id === constraintId)!;
    expect(c.result).toBe('satisfied');
    expect(c.expression).toBe('mass <= 2000');
  });

  it("require { mass <= 2000 } with mass=2500 → violated", () => {
    const { model, constraintId } = requirementModel(2500);
    const c = checkConstraints(model).find((x) => x.id === constraintId)!;
    expect(c.result).toBe('violated');
    expect(c.message).toContain('violated');
  });

  it('missing subject value → unknown', () => {
    const { model, constraintId } = requirementModel(undefined);
    const c = checkConstraints(model).find((x) => x.id === constraintId)!;
    expect(c.result).toBe('unknown');
  });

  it('integrates with the Langium parser for a real require clause', () => {
    const src = `
package P {
  part def Vehicle {
    attribute mass : Real = 1500;
  }
  requirement <R1> maxMass {
    subject v : Vehicle;
    require { mass <= 2000 }
  }
}`;
    const { model } = parseModel(src);
    const checks = checkConstraints(model);
    expect(checks.length).toBe(1);
    expect(checks[0].result).toBe('satisfied');
  });

  it('classifies a standalone violated constraint on its owner scope', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.partDef('Widget');
    f.attribute('count', p.id, { type: 'Integer', value: 10 });
    const con = m.create('ConstraintUsage', {
      ownerId: p.id,
      attrs: { expression: 'count < 5' },
    });
    const c = checkConstraints(m).find((x) => x.id === con.id)!;
    expect(c.result).toBe('violated');
  });
});

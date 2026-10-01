/**
 * Dedicated unit tests for evaluate-model.ts edge cases (finding L13).
 * The main path (scopeFor / evaluateFeatureValue / checkConstraints) is covered
 * by semantics.constraints.test.ts; this file adds edge-case coverage.
 */

import { describe, it, expect } from 'vitest';
import { Model, ModelFactory } from '@core/index';
import { scopeFor, evaluateFeatureValue, checkConstraints } from '../../src/semantics/index';
import { featureIdsFor } from '../../src/semantics/evaluate-model';
import { parseModel } from '../../src/text/index';
import { validate } from '../../src/validation/index';

describe('semantics — scopeFor edge cases', () => {
  it('returns undefined for an unresolvable name on a constraint', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const c = m.create('ConstraintUsage', {
      declaredName: 'C', ownerId: p.id,
      attrs: { expression: 'x' },
    });
    const scope = scopeFor(m, c.id);
    expect(scope('x')).toBeUndefined();
  });

  it('resolves a bare name for a reachable feature', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const attr = f.attribute('width', p.id);
    m.setAttrs(attr.id, { value: '5' });
    const scope = scopeFor(m, p.id);
    expect(scope('width')).toBe(5);
  });
});

describe('semantics — evaluateFeatureValue edge cases', () => {
  it('evaluates a literal numeric value', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const attr = f.attribute('width', p.id);
    m.setAttrs(attr.id, { value: '42.5' });
    const v = evaluateFeatureValue(m, attr.id);
    // evaluateFeatureValue returns an EvalResult: { value: 42.5 } or { unknown: true }
    expect(v).toBeDefined();
    expect((v as { value: unknown }).value).toBe(42.5);
  });

  it('returns unknown for a feature with no value and no expression', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const attr = f.attribute('unset', p.id);
    const v = evaluateFeatureValue(m, attr.id);
    expect((v as { unknown?: boolean }).unknown).toBe(true);
  });
});

describe('semantics — checkConstraints edge cases', () => {
  it('returns an empty array for a model with no constraints', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    f.pkg('P');
    const checks = checkConstraints(m);
    expect(checks).toEqual([]);
  });

  it('reports unknown for a constraint with a non-boolean expression', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const p = f.pkg('P');
    const _c = m.create('ConstraintUsage', {
      declaredName: 'C', ownerId: p.id,
      attrs: { expression: '42' },
    });
    const checks = checkConstraints(m);
    expect(checks.length).toBe(1);
    expect(checks[0].result).toBe('unknown');
  });
});

/**
 * A feature whose declared type is one of its OWN owners (`item def Person {
 * timeslice asPresident : Person; }`) names an unbounded tower of dotted
 * scopes — `asPresident.asPresident.…`. Both name collectors (`collectIds`
 * here and `collectQuantityIds` in units-eval) walk that tower, and their
 * cycle guard used to be keyed on `${prefix} ${ownerId}`, which never repeats
 * while the prefix grows, so the walk recursed until the stack died and the
 * whole checker returned `import/internal-error` with NO validation output.
 * C6 made this ordinary input: a `:>> p` that binds gives the reference the
 * self-typed type it previously lacked.
 */
describe('semantics — a self-typed feature does not blow the name walk', () => {
  const SELF_TYPED = `package P {
  item def Person {
    attribute age;
    timeslice asPresident : Person;
  }
  item def Country { ref p : Person; }
  item def US :> Country { ref q :>> p { assert constraint { age >= 35 } } }
}`;

  it('featureIdsFor terminates on a feature typed by its own owner', () => {
    const { model } = parseModel(SELF_TYPED);
    const person = model.all().find((e) => e.declaredName === 'Person');
    expect(person).toBeDefined();
    const ids = featureIdsFor(model, person!.id);
    // It stops at the first repeat of the owner, so no tower of prefixes.
    expect([...ids.keys()].some((k) => k.includes('asPresident.asPresident'))).toBe(false);
  });

  it('checkConstraints answers instead of throwing', () => {
    const { model } = parseModel(SELF_TYPED);
    expect(() => checkConstraints(model)).not.toThrow();
  });

  it('validate answers instead of throwing', () => {
    const { model } = parseModel(SELF_TYPED);
    expect(() => validate(model)).not.toThrow();
  });
});

describe('semantics — a valueless feature fixed by an equation beside it (CV-17)', () => {
  const SRC = `package LA {
    attribute fleet = 12;
    attribute flight = 40;
    attribute transit = 7.41;
    attribute swap = 20;
    attribute share = 0.12;
    #Estimate attribute watched;
    assert constraint { watched == fleet * ((flight - transit) / (flight + swap)) * share }
    require constraint target { watched >= 0.9 }
  }`;

  it('gives the feature the value the equation fixes, in the scope and in evaluateFeatureValue', () => {
    const m = parseModel(SRC).model;
    const la = m.all().find((e) => e.declaredName === 'LA')!;
    expect(scopeFor(m, la.id)('watched')).toBeCloseTo(0.78216, 5);
    const watched = m.all().find((e) => e.declaredName === 'watched')!;
    expect((evaluateFeatureValue(m, watched.id) as { value: number }).value).toBeCloseTo(0.78216, 5);
  });

  it('reads the equation as a definition and judges the target by the value it fixes', () => {
    const checks = checkConstraints(parseModel(SRC).model);
    const equation = checks.find((c) => c.expression.startsWith('watched =='))!;
    expect(equation.result).toBe('satisfied');
    expect(equation.message).toBe('Constraint satisfied: defines watched = 0.78216');
    const target = checks.find((c) => c.expression === 'watched >= 0.9')!;
    expect(target.result).toBe('violated');
  });

  it('answers unknown, not a hang, for two equations that define each other', () => {
    const m = parseModel('package P { attribute x; attribute y; assert constraint { x == y + 1 } assert constraint { y == x - 1 } }').model;
    const p = m.all().find((e) => e.declaredName === 'P')!;
    expect(scopeFor(m, p.id)('x')).toBeUndefined();
    for (const c of checkConstraints(m)) expect(c.result).toBe('unknown');
  });

  it('leaves a feature that states a value alone, even beside an equation that disagrees', () => {
    const m = parseModel('package P { attribute a = 2; attribute b = 5; assert constraint { b == a * 2 } }').model;
    const check = checkConstraints(m).find((c) => c.expression.startsWith('b =='))!;
    expect(check.result).toBe('violated');
  });
});

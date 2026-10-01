/**
 * Dedicated unit tests for evaluate-model.ts edge cases (finding L13).
 * The main path (scopeFor / evaluateFeatureValue / checkConstraints) is covered
 * by semantics.constraints.test.ts; this file adds edge-case coverage.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Model, ModelFactory } from '@core/index';
import { scopeFor, evaluateFeatureValue, checkConstraints } from '../../src/semantics/index';
import { featureIdsFor } from '../../src/semantics/evaluate-model';
import { parseModel } from '../../src/text/index';
import { validate } from '../../src/validation/index';
import { loadModelText } from '@text/load';
import type { ConstraintCheck } from '../../src/semantics/evaluate-model';

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

  // Only an ASSERTED equation defines. The same equation as a `require`, a
  // plain `constraint` or a requirement's `assume` is a check of a value the
  // model gives elsewhere — a brief's test condition, `require constraint {
  // jammed == 0.5 }` on a measure with no value, read "defines jammed = 0.5".
  it.each([
    ['require constraint', 'require constraint { watched == fleet * share }'],
    ['plain constraint', 'constraint { watched == fleet * share }'],
    ['named require constraint', 'require constraint condition { watched == fleet * share }'],
  ])('does not read a %s as a definition', (_kind, clause) => {
    const m = parseModel(`package LA {
      attribute fleet = 12;
      attribute share = 0.05;
      attribute watched;
      ${clause}
    }`).model;
    const la = m.all().find((e) => e.declaredName === 'LA')!;
    expect(scopeFor(m, la.id)('watched')).toBeUndefined();
    const watched = m.all().find((e) => e.declaredName === 'watched')!;
    expect((evaluateFeatureValue(m, watched.id) as { unknown?: boolean }).unknown).toBe(true);
    const check = checkConstraints(m).find((c) => c.expression === 'watched == fleet * share')!;
    expect(check.result).toBe('unknown');
    expect(check.message).toBe('Could not evaluate: watched has no value anywhere and nothing specialises it');
  });

  it('does not read a requirement’s assume or require as a definition', () => {
    const m = parseModel(`package P {
      requirement def R {
        attribute x;
        attribute y;
        assume constraint { x == 2 }
        require constraint { y == x * 3 }
      }
    }`).model;
    const r = m.all().find((e) => e.declaredName === 'R')!;
    expect(scopeFor(m, r.id)('x')).toBeUndefined();
    expect(scopeFor(m, r.id)('y')).toBeUndefined();
    for (const c of checkConstraints(m)) {
      expect(c.result, c.expression).toBe('unknown');
      expect(c.message, c.expression).not.toMatch(/defines/);
    }
  });

  it('reads the same equation as a definition once it is asserted', () => {
    const m = parseModel(
      'package LA { attribute fleet = 12; attribute share = 0.05; attribute watched; assert constraint { watched == fleet * share } }',
    ).model;
    const check = checkConstraints(m).find((c) => c.expression === 'watched == fleet * share')!;
    expect(check.result).toBe('satisfied');
    expect(check.message).toBe('Constraint satisfied: defines watched = 0.6');
  });
});

/*
 * A target over a measure with no value of its own, read through the features
 * that specialise the measure — once per context.
 *
 * The shape is a layered brief's: `package Common { attribute m : Real;
 * require constraint t { m >= 0.9 } }` states the target on an abstract
 * measure that carries no value BY DESIGN, and each layer gives its estimate
 * as a feature that subsets or redefines it (`LA::m :> Common::m`, a literal
 * or fixed by an equation beside it — CV-17). `checkConstraints` evaluated `t`
 * in Common's scope, never walked down to the specialisers, and answered
 * "a referenced value is unknown" for every target of the brief while the tool
 * held both layers' numbers. LA and PA may disagree, so no one value may be
 * invented for Common: `t` stays unknown, says why, and is read once per
 * context — through the SAME pipeline as any other check (unit-aware first,
 * then the refusals, then the scalar path).
 */
const model = (src: string): Model => parseModel(src).model;
const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;
/** The check of the constraint with this qualified name. */
const checkOf = (m: Model, qualified: string): ConstraintCheck =>
  checkConstraints(m).find((c) => c.id === named(m, qualified).id)!;
const verdicts = (c: ConstraintCheck) => (c.instances ?? []).map((i) => [i.context, i.result]);

/** Common target, LA estimate fixed by an equation (CV-17), PA estimate a literal. */
const BRIEF = `package B {
  package Common {
    attribute m : ScalarValues::Real;
    require constraint t { m >= 0.9 }
  }
  package LA {
    attribute fleet = 12;
    attribute share = 0.05;
    attribute m :> Common::m;
    assert constraint { m == fleet * share }
  }
  package PA {
    attribute m :> Common::m = 0.95;
  }
}`;

describe('checkConstraints — a target read through the features that specialise its measure', () => {
  it('keeps the target unknown, names why, and reads it once per context', () => {
    const m = model(BRIEF);
    const t = checkOf(m, 'B::Common::t');
    expect(t.result).toBe('unknown');
    expect(t.message).toBe('Could not evaluate: m has no value here; evaluated per specialisation: LA::m, PA::m');
    expect(verdicts(t)).toEqual([
      ['LA', 'violated'],
      ['PA', 'satisfied'],
    ]);
    const [la, pa] = t.instances!;
    expect(la.featureId).toBe(named(m, 'B::LA::m').id);
    expect(la.qualifiedName).toBe('B::LA::m');
    expect(la.value).toBe(0.6);
    expect(la.message).toBe('LA::m = 0.6 misses Common::t (m >= 0.9)');
    expect(pa.message).toBe('PA::m = 0.95 meets Common::t (m >= 0.9)');
    expect(la.bindings).toEqual([{ name: 'm', featureId: la.featureId, qualifiedName: 'B::LA::m', value: 0.6 }]);
  });

  it('says nothing specialises a valueless measure (the budget shape), and attaches no instances', () => {
    const m = model(`package Common { attribute fleetSize : ScalarValues::Integer; require constraint b { fleetSize <= 12 } }
      package LA { attribute fleetCount = 12; }`);
    const b = checkOf(m, 'Common::b');
    expect(b.result).toBe('unknown');
    expect(b.message).toBe('Could not evaluate: fleetSize has no value anywhere and nothing specialises it');
    expect(b.instances).toBeUndefined();
  });

  it('finds a subsetter with a different name and a `:>>` redefinition', () => {
    const m = model(`package Common { attribute m : Real; constraint t { m >= 0.9 } }
      package LA { attribute estimate :> Common::m = 0.5; }
      package PA { attribute m :>> Common::m = 1.0; }`);
    const t = checkOf(m, 'Common::t');
    expect(verdicts(t)).toEqual([
      ['LA', 'violated'],
      ['PA', 'satisfied'],
    ]);
    expect(t.instances![0].message).toBe('LA::estimate = 0.5 misses Common::t (m >= 0.9)');
  });

  it('walks a chain once per context: PA::m :>> LA::m :> Common::m', () => {
    const m = model(`package Common { attribute m : Real; constraint t { m >= 0.9 } }
      package LA { attribute m :> Common::m = 0.5; }
      package PA { attribute m :>> LA::m = 0.95; }`);
    const t = checkOf(m, 'Common::t');
    expect(verdicts(t)).toEqual([
      ['LA', 'violated'],
      ['PA', 'satisfied'],
    ]);
  });

  it('reads the deepest specialiser of a chain inside one context, not each link', () => {
    const m = model(`package Common { attribute m : Real; constraint t { m >= 0.9 } }
      package LA { attribute general :> Common::m; attribute specific :> general = 0.95; }`);
    const t = checkOf(m, 'Common::t');
    expect(t.instances).toHaveLength(1);
    expect(t.instances![0].qualifiedName).toBe('LA::specific');
    expect(t.instances![0].result).toBe('satisfied');
  });

  it('reads a chain whose specific end also subsets the measure directly, whatever the declaration order', () => {
    // `a :> Common::m, b` and `b :> Common::m` are both one step from the
    // measure; ordered by that distance they kept declaration order, and the
    // context read as two rival estimates when `a` came first.
    for (const la of [
      'attribute a :> Common::m, b = 0.95; attribute b :> Common::m;',
      'attribute b :> Common::m; attribute a :> Common::m, b = 0.95;',
    ]) {
      const m = model(`package Common { attribute m : Real; constraint t { m >= 0.9 } } package LA { ${la} }`);
      const t = checkOf(m, 'Common::t');
      expect(t.message, la).toBe('Could not evaluate: m has no value here; evaluated per specialisation: LA::a');
      expect(t.instances!.map((i) => [i.qualifiedName, i.result]), la).toEqual([['LA::a', 'satisfied']]);
    }
  });

  it('answers unknown, naming both, for two specialisers of one measure in one context', () => {
    const m = model(`package Common { attribute m : Real; constraint t { m >= 0.9 } }
      package PA { attribute a :> Common::m = 0.5; attribute b :> Common::m = 0.95; }`);
    const [pa] = checkOf(m, 'Common::t').instances!;
    expect(pa.result).toBe('unknown');
    expect(pa.message).toBe(
      'Common::t (m >= 0.9) could not be evaluated for PA: 2 features in PA specialise m (PA::a, PA::b); ' +
        'no one of them is the estimate',
    );
  });

  it('reads a specialiser fixed by an asserted equation, and only an asserted one', () => {
    // BRIEF's LA layer with its equation's keyword varied: the asserted one is
    // the estimate, the same equation as a check gives the layer no value.
    const read = (keyword: string) => {
      const src = BRIEF.replace('assert constraint { m == fleet * share }', `${keyword} { m == fleet * share }`);
      expect(src.includes('assert constraint { m =='), keyword).toBe(keyword === 'assert constraint');
      const [la] = checkOf(model(src), 'B::Common::t').instances!;
      return [la.result, la.value, la.message];
    };
    expect(read('assert constraint')).toEqual(['violated', 0.6, 'LA::m = 0.6 misses Common::t (m >= 0.9)']);
    for (const keyword of ['require constraint', 'constraint']) {
      expect(read(keyword), keyword).toEqual([
        'unknown',
        undefined,
        'Common::t (m >= 0.9) could not be evaluated for LA: LA::m has no value and no defining equation',
      ]);
    }
  });

  it('gives an unknown instance, not a skipped one, for a specialiser with no value', () => {
    const m = model(`package Common { attribute m : Real; constraint t { m >= 0.9 } }
      package LA { attribute m :> Common::m; }`);
    const [la] = checkOf(m, 'Common::t').instances!;
    expect(la.result).toBe('unknown');
    expect(la.value).toBeUndefined();
    expect(la.message).toBe('Common::t (m >= 0.9) could not be evaluated for LA: LA::m has no value and no defining equation');
  });

  it('reads a body over two measures only in a context that specialises both', () => {
    const m = model(`package Common {
        attribute area : Real; attribute loss : Real;
        constraint t { area >= 0.9 and loss <= 0.25 }
      }
      package LA { attribute area :> Common::area = 0.95; attribute loss :> Common::loss = 0.1; }
      package PA { attribute area :> Common::area = 0.95; }`);
    const t = checkOf(m, 'Common::t');
    expect(t.message).toBe(
      'Could not evaluate: area has no value here; evaluated per specialisation: LA::area, PA::area; ' +
        'loss has no value here; evaluated per specialisation: LA::loss',
    );
    const [la, pa] = t.instances!;
    expect(la.result).toBe('satisfied');
    expect(la.message).toBe('LA::area = 0.95, LA::loss = 0.1 meets Common::t (area >= 0.9 and loss <= 0.25)');
    expect(pa.result).toBe('unknown');
    expect(pa.message).toBe(
      'Common::t (area >= 0.9 and loss <= 0.25) could not be evaluated for PA: PA does not specialise loss',
    );
  });

  it('leaves a dotted subject reference alone (the EPBS contract shape)', () => {
    const src = `package E {
      part def Software { attribute areaFraction : Real; }
      part software : Software;
      requirement def SoftwareContract {
        subject coordination : Software;
        require constraint { coordination.areaFraction >= 0.9 }
      }
      package LA { attribute areaFraction :> Software::areaFraction = 0.5; }
    }`;
    const m = model(src);
    const c = checkConstraints(m).find((x) => x.expression === 'coordination.areaFraction >= 0.9')!;
    expect(c.result).toBe('unknown');
    expect(c.message).toBe('Could not evaluate: a referenced value is unknown');
    expect(c.instances).toBeUndefined();
  });

  it('terminates on a subsetting cycle and on an equation that reads the measure back', () => {
    const m = model(`package Common { attribute m : Real; constraint t { m >= 0.9 } }
      package LA { attribute a :> Common::m, b; attribute b :> a; assert constraint { a == b + 1 } assert constraint { b == a - 1 } }`);
    const t = checkOf(m, 'Common::t');
    expect(t.result).toBe('unknown');
    for (const inst of t.instances ?? []) expect(inst.result).toBe('unknown');
  });

  it('reads a usage’s redefinition of its definition’s default, not the default', () => {
    const m = model(`package P {
      part def D { attribute mass : Real; attribute maxMass : Real = 10; constraint c { mass <= maxMass } }
      part light : D { attribute :>> mass = 5; attribute :>> maxMass = 3; }
      part heavy : D { attribute :>> mass = 5; }
    }`);
    const c = checkOf(m, 'P::D::c');
    expect(verdicts(c)).toEqual([
      ['light', 'violated'],
      ['heavy', 'satisfied'],
    ]);
    expect(c.instances![0].message).toBe('light::mass = 5 misses D::c (mass <= maxMass)');
  });
});

describe('checkConstraints — a specialiser is judged by the same unit rules as any check', () => {
  const DIMENSIONED = `package U {
    package Common {
      attribute endurance : ISQ::DurationValue;
      constraint bare { endurance >= 45.0 }
      constraint withUnit { endurance >= 45.0 [min] }
    }
    package LA {
      attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
      attribute power : ISQ::PowerValue = 650.0 [W];
      attribute endurance :> Common::endurance = capacity / power;
      constraint local { endurance >= 45.0 }
    }
    package PA { attribute endurance :> Common::endurance = 30 [min]; }
  }`;

  it('refuses a derived dimensioned estimate against a bare literal, exactly as the check in its own context does', async () => {
    const { model: m } = await loadModelText(DIMENSIONED);
    const local = checkOf(m!, 'U::LA::local');
    expect(local.result).toBe('unknown');
    expect(local.message).toMatch(/is derived from dimensioned quantities \(T\)/);
    const [la] = checkOf(m!, 'U::Common::bare').instances!;
    expect(la.result).toBe('unknown');
    expect(la.message).toBe(`Common::bare (endurance >= 45.0) could not be evaluated for LA: ${local.message.replace(/^Could not evaluate: /, '')}`);
  });

  it('judges a target written with a unit literal, converting, and shows the value as compared', async () => {
    const { model: m } = await loadModelText(DIMENSIONED);
    const t = checkOf(m!, 'U::Common::withUnit');
    expect(t.result).toBe('unknown');
    expect(verdicts(t)).toEqual([
      ['LA', 'satisfied'],
      ['PA', 'violated'],
    ]);
    // 640 Wh / 650 W is 3544.6 s, 59 min: it meets 45 min. The raw scalar 0.98
    // (hours) printed beside `[min]` would read as a miss.
    expect(t.instances![0].message).toBe('LA::endurance = 3544.62 [s] meets Common::withUnit (endurance >= 45.0 [min])');
    expect(t.instances![1].message).toBe('PA::endurance = 30 [min] misses Common::withUnit (endurance >= 45.0 [min])');
  });

  // The same estimate fixed by an equation beside it (CV-17) rather than by a
  // value expression. Its scalar is the unit-blind 640 / 650 = 0.98, and it
  // was labelled with the kind's dimension as if it were SI — 0.98 s — so the
  // target written with `[min]` reported a miss of a value that meets it.
  const BY_EQUATION = `package U {
    package Common {
      attribute endurance : ISQ::DurationValue;
      constraint bare { endurance >= 45.0 }
      constraint withUnit { endurance >= 45.0 [min] }
    }
    package LA {
      attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
      attribute power : ISQ::PowerValue = 650.0 [W];
      attribute endurance : ISQ::DurationValue :> Common::endurance;
      assert constraint { endurance == capacity / power }
      constraint localBare { endurance >= 45.0 }
      constraint localWithUnit { endurance >= 45.0 [min] }
    }
  }`;

  it('reads an estimate fixed by an equation as the quantity the equation derives, never its raw scalar', async () => {
    const { model: m } = await loadModelText(BY_EQUATION);
    // Written in LA, the unit-aware pass does not read the equation: unknown, not a miss.
    expect(checkOf(m!, 'U::LA::localWithUnit').result).not.toBe('violated');
    const [withUnit] = checkOf(m!, 'U::Common::withUnit').instances!;
    expect(withUnit.result).toBe('satisfied');
    expect(withUnit.message).toBe('LA::endurance = 3544.62 [s] meets Common::withUnit (endurance >= 45.0 [min])');
    // Against a bare literal it is a derivation like any other: refused, never 0.98 < 45.
    const [bare] = checkOf(m!, 'U::Common::bare').instances!;
    expect(bare.result).toBe('unknown');
    expect(bare.message).toMatch(/"endurance" is derived from dimensioned quantities \(T\) and cannot be compared as a bare number/);
  });

  it('does not compare a dimensioned estimate whose equation cannot be read as a quantity', async () => {
    // `capacity2` is itself fixed by an equation, which the unit-aware scope
    // does not read; the scalar 640 / 650 is all that is left, and it is no
    // duration — the instance says so instead of comparing it.
    const { model: m } = await loadModelText(
      BY_EQUATION.replace(
        'assert constraint { endurance == capacity / power }',
        'attribute capacity2 : ISQ::EnergyValue; assert constraint { capacity2 == capacity } ' +
          'assert constraint { endurance == capacity2 / power }',
      ),
    );
    for (const target of ['U::Common::bare', 'U::Common::withUnit']) {
      const [la] = checkOf(m!, target).instances!;
      expect(la.result, target).toBe('unknown');
      expect(la.value, target).toBeUndefined();
      expect(la.message, target).toMatch(
        /LA::endurance \(ISQ::DurationValue\) has no value that could be read as a quantity: .*its raw number is not compared$/,
      );
    }
  });

  it('keeps a specialiser whose derivation disagrees with its type a refusal, not a raw magnitude', async () => {
    const { model: m } = await loadModelText(`package U {
      package Common { attribute endurance : Real; constraint t { endurance >= 45.0 } }
      package LA {
        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
        attribute power : ISQ::PowerValue = 650.0 [W];
        attribute endurance : Real :> Common::endurance = capacity / power * 60.0;
      }
    }`);
    const [la] = checkOf(m!, 'U::Common::t').instances!;
    expect(la.result).toBe('unknown');
    expect(la.message).toMatch(/derives to a dimension that disagrees with its declared type/);
  });
});

/**
 * A layered brief trimmed from a real drone-swarm model: twelve #MoE targets
 * in Common, each with an #Estimate in LA and in PA (two of them fixed by an
 * equation in both layers, two more in PA), and ten #Budget targets nothing
 * specialises. The fixture lives in the verification corpus, so the
 * differential gate holds the two engines to the unchanged base verdicts too.
 */
describe('the brief fixture — every target gets a verdict per layer', () => {
  const FIXTURE = 'test/fixtures/verification/models/brief-targets-by-layer.sysml';
  const EXPECTED: Record<string, [string, string]> = {
    areaUnderWatchTarget: ['violated', 'violated'],
    coverageLossAfterMemberLossTarget: ['satisfied', 'satisfied'],
    coverageUnderMeshJammingTarget: ['violated', 'violated'],
    reportAgeAtOperationsCentreTarget: ['satisfied', 'satisfied'],
    positionErrorWithoutSatelliteTarget: ['violated', 'violated'],
    reportHoldWhileCutOffTarget: ['satisfied', 'satisfied'],
    missedDetectionTarget: ['violated', 'violated'],
    falseAlarmsPerHourTarget: ['violated', 'violated'],
    alertsReachingOperatorTarget: ['violated', 'satisfied'],
    acknowledgedReportsThatMatterTarget: ['violated', 'violated'],
    onboardClassificationCostTarget: ['violated', 'violated'],
    unattendedWatchDurationTarget: ['violated', 'violated'],
  };

  it('reads all twelve MoE targets in LA and PA, and leaves the ten budgets unknown with the reason', async () => {
    const { model: m } = await loadModelText(readFileSync(resolve(process.cwd(), FIXTURE), 'utf8'));
    const checks = checkConstraints(m!);
    const common = checks.filter((c) => m!.qualifiedName(c.id).startsWith('BriefTargets::Common::'));
    const got: Record<string, [string, string]> = {};
    for (const c of common) {
      const name = m!.get(c.id)!.declaredName!;
      expect(c.result, name).toBe('unknown');
      if (name.endsWith('Budget')) {
        expect(c.message, name).toMatch(/has no value anywhere and nothing specialises it$/);
        expect(c.instances, name).toBeUndefined();
        continue;
      }
      expect(c.instances!.map((i) => i.context), name).toEqual(['LA', 'PA']);
      got[name] = [c.instances![0].result, c.instances![1].result];
    }
    expect(got).toEqual(EXPECTED);
    const area = common.find((c) => m!.get(c.id)!.declaredName === 'areaUnderWatchTarget')!;
    expect(area.instances![0].message).toBe(
      'LA::areaUnderWatchFraction = 0.78216 misses Common::areaUnderWatchTarget (areaUnderWatchFraction >= 0.9)',
    );
    const jam = common.find((c) => m!.get(c.id)!.declaredName === 'coverageUnderMeshJammingTarget')!;
    expect(jam.instances!.map((i) => i.value)).toEqual([0.58, 0.68]);
  });
});

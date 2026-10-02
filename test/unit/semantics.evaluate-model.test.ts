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
import { checkConstraintsNumeric } from '../../src/semantics/solver';
import { DIMENSIONLESS } from '../../src/semantics/units';
import { equationDerivation } from '../../src/semantics/units-eval';
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
    // The message names the missing assert: the equation an author reads as
    // the definition is right there, and it is a check.
    expect(check.message).toBe(
      'Could not evaluate: watched has no value anywhere, no asserted equation, and nothing specialises it',
    );
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
        'Common::t (m >= 0.9) could not be evaluated for LA: LA::m has no value and no asserted equation',
      ]);
    }
  });

  it('says a measure whose only equation is required has no asserted one, and still reads it per specialisation', () => {
    const m = model(`package Common {
        attribute m : Real;
        require constraint condition { m == 0.5 }
        require constraint t { m >= 0.9 }
      }
      package LA { attribute m :> Common::m = 0.95; }`);
    expect(checkOf(m, 'Common::t').message).toBe(
      'Could not evaluate: m has no value here and no asserted equation; evaluated per specialisation: LA::m',
    );
    expect(verdicts(checkOf(m, 'Common::t'))).toEqual([['LA', 'satisfied']]);
    // With nothing specialising it either, the test condition itself names all three.
    const alone = model('package Common { attribute m : Real; require constraint condition { m == 0.5 } }');
    expect(checkOf(alone, 'Common::condition').message).toBe(
      'Could not evaluate: m has no value anywhere, no asserted equation, and nothing specialises it',
    );
  });

  it('does not say "no asserted equation" beside an asserted one that yields no value', () => {
    // `fix` IS the asserted equation; it yields nothing only because `k` has no value.
    const body = `attribute k : Real;
        attribute m : Real;
        assert constraint fix { m == k * 2 }
        require constraint condition { m == 0.5 }
        require constraint t { m >= 0.9 }`;
    const alone = model(`package Common { ${body} }`);
    expect(checkOf(alone, 'Common::fix').message).toBe(
      'Could not evaluate: m has no value anywhere and nothing specialises it; ' +
        'k has no value anywhere and nothing specialises it',
    );
    for (const name of ['Common::condition', 'Common::t']) {
      expect(checkOf(alone, name).message, name).toBe(
        'Could not evaluate: m has no value anywhere and nothing specialises it',
      );
    }
    const layered = model(`package Common { ${body} } package LA { attribute m :> Common::m = 0.95; }`);
    expect(checkOf(layered, 'Common::t').message).toBe(
      'Could not evaluate: m has no value here; evaluated per specialisation: LA::m',
    );
  });

  it('gives an unknown instance, not a skipped one, for a specialiser with no value', () => {
    const m = model(`package Common { attribute m : Real; constraint t { m >= 0.9 } }
      package LA { attribute m :> Common::m; }`);
    const [la] = checkOf(m, 'Common::t').instances!;
    expect(la.result).toBe('unknown');
    expect(la.value).toBeUndefined();
    expect(la.message).toBe('Common::t (m >= 0.9) could not be evaluated for LA: LA::m has no value and no asserted equation');
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

  it('does not read a dotted subject reference per specialisation, and says what it reads (the EPBS contract shape)', () => {
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
    expect(c.message).toBe(
      'Could not evaluate: coordination.areaFraction has no value: Software::areaFraction is declared without one ' +
        'and what specialises it (LA::areaFraction) is not read through a feature chain',
    );
    expect(c.instances).toBeUndefined();
  });
});

/*
 * A requirement on a configuration item reads its subject's features through
 * a dotted chain (`coordination.areaUnderWatchFraction >= 0.9` over `subject
 * coordination : MemberCoordinationSoftware`). When the chain ends at a
 * feature declared without a value, the check answered "a referenced value is
 * unknown" — naming neither the value nor where it is missing. The outcome
 * stays unknown; the message now follows the chain through each feature's
 * type to the feature it ends at and says why that has no value.
 */
describe('checkConstraints — why a feature chain has no value', () => {
  const contract = (defBody: string, body: string) =>
    model(`package E {
      part def Software { ${defBody} }
      requirement def SoftwareContract {
        subject coordination : Software;
        require constraint { ${body} }
      }
    }`);
  const only = (m: Model) => checkConstraints(m).find((c) => m.qualifiedName(c.id).startsWith('E::SoftwareContract'))!;

  it('names the feature the chain ends at, declared without a value, that nothing specialises', () => {
    const c = only(contract('attribute areaFraction : Real; attribute authenticated : Boolean = true;',
      'coordination.areaFraction >= 0.9 and coordination.authenticated == true'));
    expect(c.result).toBe('unknown');
    expect(c.message).toBe(
      'Could not evaluate: coordination.areaFraction has no value: ' +
        'Software::areaFraction is declared without one and nothing specialises it',
    );
    expect(c.instances).toBeUndefined();
  });

  it('names every chain the body lacks, once each, and none it has a value for', () => {
    const c = only(contract('attribute a : Real; attribute b : Real; attribute k : Real = 30;',
      'coordination.a <= 20 and coordination.a * coordination.k <= 3600 and coordination.b >= 1'));
    expect(c.message).toBe(
      'Could not evaluate: coordination.a has no value: Software::a is declared without one and nothing specialises it; ' +
        'coordination.b has no value: Software::b is declared without one and nothing specialises it',
    );
  });

  it('follows the chain through more than one type, and through an inherited feature', () => {
    const m = model(`package E {
      part def Base { attribute rate : Real; }
      part def Radio :> Base { attribute on : Boolean = true; }
      part def Drone { part radio : Radio; }
      requirement def R { subject d : Drone; require constraint { d.radio.rate >= 2 } }
    }`);
    const c = checkConstraints(m).find((x) => x.expression === 'd.radio.rate >= 2')!;
    expect(c.message).toBe(
      'Could not evaluate: d.radio.rate has no value: Base::rate is declared without one and nothing specialises it',
    );
  });

  it('says an equation beside the feature that is only required is not an asserted one', () => {
    const c = only(contract('attribute a : Real; require constraint { a == 0.5 }', 'coordination.a >= 0.9'));
    expect(c.message).toBe(
      'Could not evaluate: coordination.a has no value: ' +
        'Software::a is declared without one, has no asserted equation, and nothing specialises it',
    );
  });

  it('reads an asserted equation beside the feature through a feature chain that changes nothing it reads', () => {
    const c = only(contract('attribute a : Real; assert constraint { a == 0.95 }', 'coordination.a >= 0.9'));
    expect([c.result, c.message]).toEqual(['satisfied', 'Constraint satisfied']);
  });

  it('says an asserted equation is not read through a feature chain that redefines what it reads', () => {
    const c = only(
      model(`package E {
      part def Software { attribute k : Real = 1.0; attribute a : Real; assert constraint { a == k * 0.95 } }
      part def Tuned :> Software { attribute :>> k = 2.0; }
      requirement def SoftwareContract {
        subject coordination : Tuned;
        require constraint { coordination.a >= 0.9 }
      }
    }`),
    );
    expect(c.result).toBe('unknown');
    expect(c.message).toBe(
      'Could not evaluate: coordination.a has no value: Software::a is declared without one, ' +
        'its asserted equation is not read through a feature chain that redefines what it reads, and nothing ' +
        'specialises it',
    );
  });

  it('keeps the generic sentence for a chain that does not resolve, or ends at a value it could not evaluate', () => {
    for (const [defBody, body] of [
      ['attribute a : Real;', 'coordination.missing >= 0.9'],
      ['attribute a : Real = b * 2;', 'coordination.a >= 0.9'],
      ['attribute a : Real; attribute b : Real = 1;', 'coordination.a >= 0.9 and other >= 1'],
    ]) {
      const c = only(contract(defBody, body));
      expect(c.result, body).toBe('unknown');
      expect(c.message, body).toBe('Could not evaluate: a referenced value is unknown');
    }
  });

  it('keeps a chain’s cause beside the reason a bare measure has no value', () => {
    const m = model(`package E {
      part def Software { attribute a : Real; }
      requirement def R { subject s : Software; attribute m : Real; require constraint t { m >= 0.9 and s.a >= 1 } }
    }`);
    const c = checkConstraints(m).find((x) => x.expression === 'm >= 0.9 and s.a >= 1')!;
    expect(c.message).toBe(
      'Could not evaluate: m has no value anywhere and nothing specialises it; ' +
        's.a has no value: Software::a is declared without one and nothing specialises it',
    );
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
    const [withUnit] = checkOf(m!, 'U::Common::withUnit').instances!;
    expect(withUnit.result).toBe('satisfied');
    expect(withUnit.message).toBe('LA::endurance = 3544.62 [s] meets Common::withUnit (endurance >= 45.0 [min])');
    // Against a bare literal it is a derivation like any other: refused, never 0.98 < 45.
    const [bare] = checkOf(m!, 'U::Common::bare').instances!;
    expect(bare.result).toBe('unknown');
    expect(bare.message).toMatch(/"endurance" is derived from dimensioned quantities \(T\) and cannot be compared as a bare number/);
  });

  /*
   * An estimate fixed by an equation whose input is ITSELF fixed by one (the
   * `capacity2` shape). The scalar scope always read the chain; the quantity
   * scope did not, so `endurance` had no quantity and was refused — through
   * the specialiser and beside the equation alike, the equation included —
   * where the one-step estimate was judged. The chain is now derived with its
   * units, link by link.
   */
  const BY_CHAIN = BY_EQUATION.replace(
    'assert constraint { endurance == capacity / power }',
    'attribute capacity2 : ISQ::EnergyValue; assert constraint { capacity2 == capacity * 2.0 } ' +
      'assert constraint { endurance == capacity2 / power }',
  );

  it('reads an estimate fixed through a chain of equations as the quantity the chain derives', async () => {
    const { model: m } = await loadModelText(BY_CHAIN);
    // 1280 Wh / 650 W is 7089.23 s, 118 min.
    const [withUnit] = checkOf(m!, 'U::Common::withUnit').instances!;
    expect([withUnit.result, withUnit.message]).toEqual([
      'satisfied',
      'LA::endurance = 7089.23 [s] meets Common::withUnit (endurance >= 45.0 [min])',
    ]);
    expect(checkOf(m!, 'U::LA::localWithUnit').result).toBe('satisfied');
    const equation = checkConstraints(m!).find((c) => c.expression === 'endurance == capacity2 / power')!;
    expect([equation.result, equation.message]).toEqual(['satisfied', 'Constraint satisfied: defines endurance = 7089.23 [s]']);
    // Against a bare literal: refused, with exactly the reason the one-step estimate gets.
    const { model: oneStep } = await loadModelText(BY_EQUATION);
    expect(checkOf(m!, 'U::LA::localBare').message).toBe(checkOf(oneStep!, 'U::LA::localBare').message);
    expect(checkOf(m!, 'U::Common::bare').instances![0].message).toBe(
      checkOf(oneStep!, 'U::Common::bare').instances![0].message,
    );
  });

  it('still does not compare a dimensioned estimate whose chain cannot be read as a quantity', async () => {
    // The guard on the rule above: a link the unit-aware evaluator cannot
    // read (a string literal is scalar-only) leaves the scalar 1280 / 650,
    // which is no duration — the reading says so, naming the link, instead of
    // comparing it.
    const { model: m } = await loadModelText(
      BY_CHAIN.replace(
        'capacity2 == capacity * 2.0',
        'capacity2 == if "on" == "on" then capacity * 2.0 else capacity',
      ),
    );
    const why =
      'endurance (ISQ::DurationValue) has no value that could be read as a quantity: "capacity2" cannot be ' +
      'derived: the expression is not a unit-aware expression, and its raw number is not compared';
    for (const target of ['U::Common::bare', 'U::Common::withUnit']) {
      const [la] = checkOf(m!, target).instances!;
      expect(la.result, target).toBe('unknown');
      expect(la.value, target).toBeUndefined();
      expect(la.message.endsWith(`could not be evaluated for LA: LA::${why}`), la.message).toBe(true);
    }
    for (const local of ['U::LA::localBare', 'U::LA::localWithUnit']) {
      expect([checkOf(m!, local).result, checkOf(m!, local).message], local).toEqual(['unknown', `Could not evaluate: ${why}`]);
    }
  });

  /*
   * The SAME estimate read where its equation is written. The unit-aware
   * scope does not read a feature fixed by an equation and the scalar scope
   * reads it unit-blind, so `localBare` was violated by 0.98 < 45,
   * `localWithUnit` was unknown, and the equation reported "defines endurance
   * = 0.984615" — while the target in Common, read through the same feature,
   * was refused and judged. The constraint beside the equation now reads the
   * feature exactly as the specialiser path does.
   */
  it('judges a constraint beside the equation exactly as the target read through the specialiser', async () => {
    const { model: m } = await loadModelText(BY_EQUATION);
    // Against a bare literal: refused, with the reason the specialiser reading gives.
    const localBare = checkOf(m!, 'U::LA::localBare');
    const [bare] = checkOf(m!, 'U::Common::bare').instances!;
    expect(localBare.result).toBe('unknown');
    expect(localBare.message).toBe(
      'Could not evaluate: "endurance" is derived from dimensioned quantities (T) and cannot be compared as a bare ' +
        'number; compare against a unit literal of dimension T, e.g. `45.0 [s]` or `45.0 [min]` or `45.0 [h]`',
    );
    expect(bare.message).toBe(
      `Common::bare (endurance >= 45.0) could not be evaluated for LA: ${localBare.message.replace(/^Could not evaluate: /, '')}`,
    );
    // Against a unit literal: judged, converting — 59 min meets 45 min.
    const localWithUnit = checkOf(m!, 'U::LA::localWithUnit');
    expect(localWithUnit.result).toBe('satisfied');
    expect(checkOf(m!, 'U::Common::withUnit').instances![0].result).toBe(localWithUnit.result);
  });

  it('says what a dimensioned equation defines with its unit', async () => {
    const { model: m } = await loadModelText(BY_EQUATION);
    const equation = checkConstraints(m!).find((c) => c.expression === 'endurance == capacity / power')!;
    expect(equation.result).toBe('satisfied');
    expect(equation.message).toBe('Constraint satisfied: defines endurance = 3544.62 [s]');
  });

  /*
   * A kind on the feature relabels a dimensionless derivation: `endurance :
   * DurationValue` over unitless Real inputs is 3544.62 s. Judged against
   * that binding, the equation it came from compared seconds with its own
   * dimensionless side and reported the definition violated — a warning in
   * Problems on an equation that holds, while the target read through the
   * same feature in another package met its limit.
   */
  it('keeps satisfied the equation a kinded feature is fixed by over unitless inputs, and gives its unit', async () => {
    const { model: m } = await loadModelText(`package K {
      attribute capacityWh : Real = 640.0;
      attribute powerW : Real = 650.0;
      attribute endurance : ISQ::DurationValue;
      assert constraint fix { endurance == capacityWh / powerW * 3600.0 }
      constraint withUnit { endurance >= 45.0 [min] }
      attribute limit : ISQ::MassValue;
      assert constraint cap { limit == 25.0 }
    }`);
    const judged = (name: string) => [checkOf(m!, name).result, checkOf(m!, name).message];
    expect(judged('K::fix')).toEqual(['satisfied', 'Constraint satisfied: defines endurance = 3544.62 [s]']);
    expect(judged('K::cap')).toEqual(['satisfied', 'Constraint satisfied: defines limit = 25 [kg]']);
    expect(judged('K::withUnit')).toEqual(['satisfied', 'Constraint satisfied']);

    // The same equation in a layer, under a target in Common read through it.
    const { model: layered } = await loadModelText(`package U {
      package Common { attribute endurance : ISQ::DurationValue; constraint withUnit { endurance >= 45.0 [min] } }
      package LA {
        attribute capacityWh : Real = 640.0;
        attribute powerW : Real = 650.0;
        attribute endurance : ISQ::DurationValue :> Common::endurance;
        assert constraint fix { endurance == capacityWh / powerW * 3600.0 }
      }
    }`);
    expect([checkOf(layered!, 'U::LA::fix').result, checkOf(layered!, 'U::LA::fix').message]).toEqual([
      'satisfied',
      'Constraint satisfied: defines endurance = 3544.62 [s]',
    ]);
    expect(checkOf(layered!, 'U::Common::withUnit').instances!.map((i) => [i.result, i.message])).toEqual([
      ['satisfied', 'LA::endurance = 3544.62 [s] meets Common::withUnit (endurance >= 45.0 [min])'],
    ]);
  });

  it('refuses, and defines nothing, when the equation derives a dimension its feature’s type does not have', async () => {
    const { model: m } = await loadModelText(`package Q {
      attribute len : ISQ::LengthValue = 5.0 [m];
      attribute e : ISQ::DurationValue;
      assert constraint { e == len }
      constraint bare { e >= 1.0 }
      constraint withUnit { e >= 1.0 [s] }
    }`);
    const refusal = 'Could not evaluate: "e" derives to a dimension that disagrees with its declared type, so it is excluded from unit-aware evaluation';
    for (const c of checkConstraints(m!)) {
      expect(c.result, c.expression).toBe('unknown');
      expect(c.message, c.expression).toBe(refusal);
    }
  });

  it('refuses an untyped dimensioned derivation against a bare literal, naming the pure-ratio repair', async () => {
    const { model: m } = await loadModelText(`package Q {
      attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
      attribute power : ISQ::PowerValue = 650.0 [W];
      attribute e;
      assert constraint { e == capacity / power }
      constraint bare { e >= 45.0 }
      constraint withUnit { e >= 45.0 [min] }
    }`);
    expect(checkOf(m!, 'Q::bare').message).toMatch(
      /^Could not evaluate: "e" is derived from dimensioned quantities \(T\) and cannot be compared as a bare number; if it is meant as a pure ratio/,
    );
    expect(checkOf(m!, 'Q::withUnit').result).toBe('satisfied');
  });

  it('leaves a dimensionless derivation as it was: the scalar value, the same verdicts, the same message', () => {
    // v9's shape: every estimate a unitless Real, fixed by an asserted equation.
    const checks = checkConstraints(parseModel(`package LA {
      attribute fleet : Real = 12; attribute share : Real = 0.05; attribute loss : Real = 0.12;
      attribute watched : Real;
      attribute lost : Real;
      assert constraint { watched == fleet * share }
      assert constraint { lost == loss / watched }
      require constraint high { watched >= 0.9 }
      require constraint low { lost <= 0.25 }
    }`).model);
    const by = (e: string) => checks.find((c) => c.expression === e)!;
    expect([by('watched == fleet * share').result, by('watched == fleet * share').message]).toEqual([
      'satisfied',
      'Constraint satisfied: defines watched = 0.6',
    ]);
    // `lost` is fixed through another fixed value: the same number either way
    // (see the unitless chain below).
    expect([by('lost == loss / watched').result, by('lost == loss / watched').message]).toEqual([
      'satisfied',
      'Constraint satisfied: defines lost = 0.2',
    ]);
    expect([by('watched >= 0.9').result, by('watched >= 0.9').message]).toEqual([
      'violated',
      'Constraint violated: watched >= 0.9',
    ]);
    expect(by('lost <= 0.25').result).toBe('satisfied');
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

/*
 * `==` and `!=` beside a bare literal. The ordering comparisons read a bare
 * literal against a kinded feature in the feature's declared unit (the
 * bare-literal contract), and refuse it against a derived dimensioned one;
 * equality answered the question itself instead — "dimensions differ, so the
 * values differ" — and `limit : MassValue = 25.0` was VIOLATED against
 * `limit == 25.0` while `limit >= 25.0` and `limit <= 25.0` both held.
 */
describe('checkConstraints — `==` and `!=` read a bare literal exactly as the orderings do', () => {
  const LIMIT = `package L {
    attribute limit : ISQ::MassValue = 25.0;
    constraint eq { limit == 25.0 }
    constraint ne { limit != 25.0 }
    constraint eqOther { limit == 26.0 }
    constraint ge { limit >= 25.0 }
    constraint le { limit <= 25.0 }
    constraint eqKg { limit == 25 [kg] }
    constraint eqG { limit == 25 [g] }
  }`;

  it('judges a literal-valued kinded feature against a bare literal in its declared unit', async () => {
    const { model: m } = await loadModelText(LIMIT);
    const result = (name: string) => checkOf(m!, `L::${name}`).result;
    expect(['eq', 'ne', 'eqOther', 'ge', 'le'].map(result)).toEqual([
      'satisfied',
      'violated',
      'violated',
      'satisfied',
      'satisfied',
    ]);
    // Against a unit literal it was, and is, a conversion: 25 kg is not 25 g.
    expect(['eqKg', 'eqG'].map(result)).toEqual(['satisfied', 'violated']);
    // The numeric surface reads the equality from the same contract, and a
    // `!=` as the negation of its equality.
    const numeric = new Map(checkConstraintsNumeric(m!).map((r) => [r.raw, r.result]));
    expect(['limit == 25.0', 'limit != 25.0', 'limit == 26.0', 'limit >= 25.0'].map((r) => numeric.get(r))).toEqual([
      'satisfied',
      'violated',
      'violated',
      'satisfied',
    ]);
  });

  it('refuses `==` and `!=` exactly where an ordering is refused, with the same reason', async () => {
    const { model: m } = await loadModelText(`package D {
      attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
      attribute power : ISQ::PowerValue = 650.0 [W];
      attribute e : ISQ::DurationValue = capacity / power;
      constraint ge { e >= 45.0 }
      constraint eq { e == 45.0 }
      constraint ne { e != 45.0 }
      attribute d : ISQ::LengthValue = 5.0 [m];
      attribute t : ISQ::DurationValue = 5.0 [s];
      constraint geClash { d >= t }
      constraint eqClash { d == t }
      constraint neClash { d != t }
    }`);
    const judged = (name: string) => [checkOf(m!, `D::${name}`).result, checkOf(m!, `D::${name}`).message];
    // A DERIVED dimensioned feature is never compared as a bare number:
    // `e == 45.0` was a confident violation, `e != 45.0` a confident pass.
    expect(judged('ge')[1]).toMatch(/^Could not evaluate: "e" is derived from dimensioned quantities \(T\)/);
    expect(judged('eq')).toEqual(judged('ge'));
    expect(judged('ne')).toEqual(judged('ge'));
    // Two real dimensions: refused for every operator, as they were.
    expect(judged('geClash')[0]).toBe('unknown');
    expect(judged('eqClash')).toEqual(judged('geClash'));
    expect(judged('neClash')).toEqual(judged('geClash'));
  });

  it('still refuses an equality on an offset scale, whatever the other side', async () => {
    // The guard on the rule above: `t == 20.0` on a °C value is the offset
    // refusal it always was (the solver lane's gate reads it as offset
    // arithmetic too), not the bare-literal contract an ordering reads it by.
    const { model: m } = await loadModelText(`package T {
      attribute t : ISQ::TemperatureValue = 20.0 [°C];
      constraint eq { t == 20.0 }
      constraint ge { t >= 20.0 }
    }`);
    expect(checkOf(m!, 'T::eq').result).toBe('unknown');
    expect(checkOf(m!, 'T::eq').message).toMatch(/is on an offset temperature scale/);
    expect(checkOf(m!, 'T::ge').result).toBe('satisfied');
  });
});

/*
 * A feature fixed by an asserted equation whose inputs are fixed by asserted
 * equations too: the unit-aware derivation follows them, link by link, as the
 * scalar scope always did — with a guard on a loop, a cap on the depth, and a
 * refusal anywhere in the chain kept as the refusal it is.
 */
describe('checkConstraints — a chain of asserted equations is derived with its units', () => {
  it('derives a three-step chain, and judges it against a unit literal', async () => {
    const { model: m } = await loadModelText(`package Q {
      attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
      attribute power : ISQ::PowerValue = 650.0 [W];
      attribute c2 : ISQ::EnergyValue;
      attribute c3 : ISQ::EnergyValue;
      attribute e : ISQ::DurationValue;
      assert constraint { c2 == capacity * 2.0 }
      assert constraint { c3 == c2 + capacity }
      assert constraint { e == c3 / power }
      constraint meets { e >= 177.0 [min] }
      constraint misses { e >= 178.0 [min] }
    }`);
    const by = (expr: string) => checkConstraints(m!).find((c) => c.expression === expr)!;
    // 1920 Wh / 650 W is 10633.8 s, 177.2 min.
    expect([by('c3 == c2 + capacity').result, by('c3 == c2 + capacity').message]).toEqual([
      'satisfied',
      'Constraint satisfied: defines c3 = 6912000 [J]',
    ]);
    expect([by('e == c3 / power').result, by('e == c3 / power').message]).toEqual([
      'satisfied',
      'Constraint satisfied: defines e = 10633.8 [s]',
    ]);
    expect([checkOf(m!, 'Q::meets').result, checkOf(m!, 'Q::misses').result]).toEqual(['satisfied', 'violated']);
  });

  it('refuses a loop of equations, naming every link of it, on both paths', async () => {
    const { model: m } = await loadModelText(`package C {
      package Common { attribute a : ISQ::LengthValue; constraint t { a >= 1.0 [m] } }
      package LA {
        attribute a : ISQ::LengthValue :> Common::a;
        attribute b : ISQ::LengthValue;
        assert constraint { a == b * 2.0 }
        assert constraint { b == a / 2.0 }
        constraint local { a >= 1.0 [m] }
      }
    }`);
    expect([checkOf(m!, 'C::LA::local').result, checkOf(m!, 'C::LA::local').message]).toEqual([
      'unknown',
      'Could not evaluate: "a" cannot be derived: "a" is defined through itself: a → b → a',
    ]);
    const [la] = checkOf(m!, 'C::Common::t').instances!;
    expect([la.result, la.message]).toEqual([
      'unknown',
      'Common::t (a >= 1.0 [m]) could not be evaluated for LA: "LA::a" cannot be derived: "a" is defined through itself: a → b → a',
    ]);
    // A unitless loop is named the same way; neither path has a value for it.
    const unitless = model('package P { attribute x; attribute y; assert constraint { x == y + 1 } assert constraint { y == x - 1 } }');
    expect(checkConstraints(unitless).map((c) => c.message)).toEqual([
      'Could not evaluate: "x" cannot be derived: "x" is defined through itself: x → y → x',
      'Could not evaluate: "y" cannot be derived: "y" is defined through itself: y → x → y',
    ]);
  });

  it('refuses a chain with a refused link, with the link’s own reason, on both paths', async () => {
    // `c2 == len` gives an energy a length: refused. Before, the chain above
    // it lost the reason — `e` read as a feature with no value at all.
    const { model: m } = await loadModelText(`package R {
      package Common { attribute e : ISQ::DurationValue; constraint t { e >= 45.0 [min] } }
      package LA {
        attribute len : ISQ::LengthValue = 5.0 [m];
        attribute power : ISQ::PowerValue = 650.0 [W];
        attribute c2 : ISQ::EnergyValue;
        assert constraint { c2 == len }
        attribute e : ISQ::DurationValue :> Common::e;
        assert constraint { e == c2 / power }
        constraint local { e >= 45.0 [min] }
      }
    }`);
    const why = '"c2" derives to a dimension that disagrees with its declared type, so it is excluded from unit-aware evaluation';
    expect([checkOf(m!, 'R::LA::local').result, checkOf(m!, 'R::LA::local').message]).toEqual([
      'unknown',
      `Could not evaluate: "e" cannot be derived: ${why}`,
    ]);
    const [la] = checkOf(m!, 'R::Common::t').instances!;
    expect([la.result, la.message]).toEqual([
      'unknown',
      `Common::t (e >= 45.0 [min]) could not be evaluated for LA: "LA::e" cannot be derived: ${why}`,
    ]);
  });

  it('names offset arithmetic in a link as the link’s, not the feature’s the chain fixes, on both paths', async () => {
    // `x == t0 * 2.0` scales a °C value: refused, and `x` is named for it as
    // it always was. Through the chain the refusal kept its verdict and lost
    // its subject — `e`, a duration, read "is on an offset temperature scale".
    const { model: m } = await loadModelText(`package O {
      package Common { attribute e : ISQ::DurationValue; constraint t { e >= 45.0 [min] } }
      package LA {
        attribute power : ISQ::PowerValue = 650.0 [W];
        attribute t0 : ISQ::TemperatureValue = 20.0 [°C];
        attribute x : ISQ::EnergyValue;
        assert constraint { x == t0 * 2.0 }
        attribute e : ISQ::DurationValue :> Common::e;
        assert constraint { e == x / power }
        constraint local { e >= 45.0 [min] }
        constraint bare { e >= 45.0 }
      }
    }`);
    const scale =
      'is on an offset temperature scale (°C/°F); differences and sums on it are not supported — use K (or °C ' +
      'values may only be ordered)';
    const inX = `"x" cannot be derived: "°C" ${scale}`;
    const why = `"e" cannot be derived: ${inX}`;
    const by = (expr: string) => checkConstraints(m!).find((c) => c.expression === expr)!;
    expect([by('x == t0 * 2.0').result, by('x == t0 * 2.0').message]).toEqual([
      'unknown',
      `Could not evaluate: "x" ${scale}`,
    ]);
    expect([by('e == x / power').result, by('e == x / power').message]).toEqual(['unknown', `Could not evaluate: ${why}`]);
    for (const local of ['O::LA::local', 'O::LA::bare']) {
      expect([checkOf(m!, local).result, checkOf(m!, local).message], local).toEqual(['unknown', `Could not evaluate: ${why}`]);
    }
    const [la] = checkOf(m!, 'O::Common::t').instances!;
    expect([la.result, la.message]).toEqual([
      'unknown',
      `Common::t (e >= 45.0 [min]) could not be evaluated for LA: "LA::e" cannot be derived: ${inX}`,
    ]);
    // A link that states its value as an expression is named the same way.
    const { model: byValue } = await loadModelText(
      `package V {
        attribute power : ISQ::PowerValue = 650.0 [W];
        attribute t0 : ISQ::TemperatureValue = 20.0 [°C];
        attribute x : ISQ::EnergyValue = t0 * 2.0;
        attribute e : ISQ::DurationValue;
        assert constraint { e == x / power }
        constraint local { e >= 45.0 [min] }
      }`,
    );
    expect(checkOf(byValue!, 'V::local').message).toBe(`Could not evaluate: ${why}`);
  });

  it('reads a unitless chain to the same numbers on both paths', async () => {
    // v9's shape. The scalar values are the ones the chain always had; the
    // quantity the unit-aware path now derives is that same number, exactly.
    const m = model(`package LA {
      attribute fleet : Real = 12; attribute share : Real = 0.05; attribute loss : Real = 0.12;
      attribute watched : Real;
      attribute lost : Real;
      attribute third : Real;
      assert constraint { watched == fleet * share }
      assert constraint { lost == loss / watched }
      assert constraint { third == lost * watched + 1 }
    }`);
    const la = named(m, 'LA');
    const scalar = scopeFor(m, la.id);
    const watched = 12 * 0.05;
    const lost = 0.12 / watched;
    expect(['watched', 'lost', 'third'].map((n) => scalar(n))).toEqual([watched, lost, lost * watched + 1]);
    for (const [name, expr] of [
      ['lost', 'lost == loss / watched'],
      ['third', 'third == lost * watched + 1'],
    ]) {
      expect(equationDerivation(m, named(m, `LA::${name}`).id, expr).q, name).toEqual({
        magnitude: scalar(name),
        dimension: DIMENSIONLESS,
      });
    }
    expect(checkConstraints(m).map((c) => c.message)).toEqual([
      'Constraint satisfied: defines watched = 0.6',
      'Constraint satisfied: defines lost = 0.2',
      'Constraint satisfied: defines third = 1.12',
    ]);
  });

  it('caps the depth of a chain, whatever order its links are declared in', async () => {
    // Past the cap the answer is `depth`, not a stack overflow; and it is a
    // fact about the chain, so a link judged after the links below it were
    // (and cached) answers what it answers alone.
    const links: string[] = [];
    for (let i = 1; i <= 66; i++) {
      links.push(`attribute x${i} : ISQ::LengthValue; assert constraint { x${i} == x${i - 1} + x0 }`);
    }
    const targets = 'constraint t64 { x64 >= 0.5 [m] } constraint t65 { x65 >= 0.5 [m] } constraint t66 { x66 >= 0.5 [m] }';
    for (const order of [links, [...links].reverse()]) {
      const { model: m } = await loadModelText(
        `package P { attribute x0 : ISQ::LengthValue = 1.0 [m]; ${order.join(' ')} ${targets} }`,
      );
      expect(['P::t64', 'P::t65', 'P::t66'].map((t) => checkOf(m!, t).result)).toEqual(['satisfied', 'unknown', 'unknown']);
      expect(checkOf(m!, 'P::t65').message).toBe(
        'Could not evaluate: "x65" cannot be derived: its defining equations nest more than 64 deep',
      );
    }
  });
});

/*
 * Which of several asserted equations defines a name. The first in which the
 * name stood alone on EITHER side used to: `b == a` written above `a == x0 *
 * 2.0` read the alias as `a`'s definition, so `a` was derived from `b`, `b`
 * from `a`, and both were refused as the loop "a → b → a" — swap the two lines
 * and a = b = 2 m. The rule both paths share now takes the first equation
 * that gives the name a value, the `x == <expr>` form first: one that would
 * read a feature back into its own derivation, or whose input nothing fixes,
 * is passed over.
 */
describe('checkConstraints — the defining equation does not depend on the order equations are written in', () => {
  const judged = (m: Model) => checkConstraints(m).map((c) => [c.expression, c.result, c.message]);
  const swapped = (order: string[]) => [...order].reverse();

  it('reads an alias and the definition it aliases alike in either order, on every path', async () => {
    const pair = ['assert constraint { b == a }', 'assert constraint { a == x0 * 2.0 }'];
    for (const order of [pair, swapped(pair)]) {
      const { model: m } = await loadModelText(`package A {
        attribute x0 : ISQ::LengthValue = 1.0 [m];
        attribute a : ISQ::LengthValue;
        attribute b : ISQ::LengthValue;
        ${order.join(' ')}
        constraint ta { a >= 1.5 [m] }
        constraint tb { b >= 1.5 [m] }
      }`);
      expect(judged(m!).sort(), order[0]).toEqual([
        ['a == x0 * 2.0', 'satisfied', 'Constraint satisfied: defines a = 2 [m]'],
        ['a >= 1.5 [m]', 'satisfied', 'Constraint satisfied'],
        ['b == a', 'satisfied', 'Constraint satisfied: defines b = 2 [m]'],
        ['b >= 1.5 [m]', 'satisfied', 'Constraint satisfied'],
      ]);
      // The scalar scope reads the same equations: a unitless twin.
      const u = model(`package U { attribute x0 : Real = 1.0; attribute a : Real; attribute b : Real; ${order.join(' ')} }`);
      const scalar = scopeFor(u, named(u, 'U').id);
      expect([scalar('a'), scalar('b')], order[0]).toEqual([2, 2]);
      // And a target read through the specialiser an alias fixes.
      const { model: layered } = await loadModelText(`package Y {
        package Common { attribute e : ISQ::LengthValue; constraint t { e >= 1.5 [m] } }
        package LA {
          attribute x0 : ISQ::LengthValue = 1.0 [m];
          attribute e : ISQ::LengthValue :> Common::e;
          attribute est : ISQ::LengthValue;
          ${order.map((e) => e.replace('b == a', 'e == est').replace('a == x0', 'est == x0')).join(' ')}
        }
      }`);
      const [la] = checkOf(layered!, 'Y::Common::t').instances!;
      expect([la.result, la.message], order[0]).toEqual(['satisfied', 'LA::e = 2 [m] meets Common::t (e >= 1.5 [m])']);
    }
  });

  it('reads one equation between two features as no loop, in either order, when nothing else defines them', async () => {
    // `e2 == e` read as `e`'s definition and then as `e2`'s named the loop
    // "e → e2 → e", which no one wrote. One equation read back is no loop.
    // `e == capacity / 650.0 [W]` holds a unit literal, and is the definition
    // of `e` as every relation body is read (the shared reader parses `[unit]`
    // literals): `e` is 3544.62 s, and `e2` is `e`, in either order.
    const pair = ['assert constraint { e2 == e }', 'assert constraint { e == capacity / 650.0 [W] }'];
    const seen: unknown[] = [];
    for (const order of [pair, swapped(pair)]) {
      const { model: m } = await loadModelText(`package E {
        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
        attribute e : ISQ::DurationValue;
        attribute e2 : ISQ::DurationValue;
        ${order.join(' ')}
        constraint te { e >= 45.0 [min] }
        constraint te2 { e2 >= 45.0 [min] }
      }`);
      expect([checkOf(m!, 'E::te').message, checkOf(m!, 'E::te2').message], order[0]).toEqual([
        'Constraint satisfied',
        'Constraint satisfied',
      ]);
      seen.push(judged(m!).sort());
    }
    expect(seen[1]).toEqual(seen[0]);
    // An alias alone is the same: no value, not "a → b → a".
    const { model: alone } = await loadModelText(
      'package L { attribute a : ISQ::LengthValue; attribute b : ISQ::LengthValue; assert constraint { a == b } ' +
        'constraint ta { a >= 1.0 [m] } }',
    );
    expect(checkOf(alone!, 'L::ta').message).toBe('Could not evaluate: a has no value anywhere and nothing specialises it');
  });

  it('resolves a ring of three aliases through its one real definition, wherever that is written', async () => {
    const ring = ['assert constraint { a == b }', 'assert constraint { b == c }', 'assert constraint { c == a }'];
    const real = 'assert constraint { c == x0 * 2.0 }';
    const ringModel = (order: string[]) => `package R {
      attribute x0 : ISQ::LengthValue = 1.0 [m];
      attribute a : ISQ::LengthValue;
      attribute b : ISQ::LengthValue;
      attribute c : ISQ::LengthValue;
      ${order.join(' ')}
      constraint ta { a >= 1.5 [m] }
      constraint tb { b >= 1.5 [m] }
      constraint tc { c >= 1.5 [m] }
    }`;
    for (const order of [[...ring, real], [real, ...ring], [ring[2]!, real, ring[0]!, ring[1]!]]) {
      const { model: m } = await loadModelText(ringModel(order));
      const checks = checkConstraints(m!);
      expect(checks.map((c) => c.result), order.join(' ')).toEqual(checks.map(() => 'satisfied'));
      expect(checks.filter((c) => c.expression.includes('==')).map((c) => c.message.replace(/defines \w/, 'defines ·'))).toEqual(
        Array(4).fill('Constraint satisfied: defines · = 2 [m]'),
      );
    }
    // With no real definition the ring is a loop the author did write: it is
    // still refused, naming every link of it.
    const { model: loop } = await loadModelText(ringModel(ring));
    expect(checkOf(loop!, 'R::ta').message).toBe(
      'Could not evaluate: "a" cannot be derived: "a" is defined through itself: a → b → c → a',
    );
  });

  it('takes `x == <expr>` over `<expr> == x` when two equations fix a name to different values, in either order', () => {
    // A model at odds with itself: which equation defines decided by
    // declaration order alone before, so swapping the lines swapped the value
    // and which of the two read as violated.
    const pair = ['assert constraint { 2.0 == x }', 'assert constraint { x == 1.0 }'];
    for (const order of [pair, swapped(pair)]) {
      const m = model(`package C { attribute x : Real; ${order.join(' ')} constraint t { x >= 1.5 } }`);
      expect(scopeFor(m, named(m, 'C').id)('x'), order[0]).toBe(1);
      const by = (e: string) => checkConstraints(m).find((c) => c.expression === e)!;
      expect([by('x == 1.0').message, by('2.0 == x').result, by('x >= 1.5').result], order[0]).toEqual([
        'Constraint satisfied: defines x = 1',
        'violated',
        'violated',
      ]);
    }
  });

  it('gives a feature the value it has alone, whichever check reads it first', () => {
    // `a`'s first definition reads `b`, whose only one reads `a` back: passed
    // over, `a` is 2, and `b` with it. Read from `b`'s side first, `a` is
    // derived while `b` is in flight — an answer that depends on the stack,
    // and kept for a later check it read `a` through `b` as 4.
    const eqs = ['assert constraint { a == b * 2.0 }', 'assert constraint { a == 2.0 }', 'assert constraint { b == a }'];
    for (const order of [eqs, [eqs[2]!, eqs[0]!, eqs[1]!]]) {
      const m = model(`package I { attribute a : Real; attribute b : Real; ${order.join(' ')} }`);
      for (const first of ['a', 'b'] as const) {
        const scope = scopeFor(m, named(m, 'I').id);
        const asked = { [first]: scope(first) } as Record<'a' | 'b', unknown>;
        const then = first === 'a' ? 'b' : 'a';
        asked[then] = scope(then);
        expect([asked.a, asked.b], `${order[0]}, ${first} first`).toEqual([2, 2]);
      }
      const by = (e: string) => checkConstraints(m).find((c) => c.expression === e)!;
      expect([by('a == 2.0').message, by('b == a').message, by('a == b * 2.0').result], order[0]).toEqual([
        'Constraint satisfied: defines a = 2',
        'Constraint satisfied: defines b = 2',
        'violated',
      ]);
    }
  });

  it('passes over an equation that reads the feature back through a unit literal, in either order, on every path', async () => {
    // `v = a + 0.0 [m]` is no scalar expression. The scalar scope read `a ==
    // v` as an equation whose input has no value, and took it; the unit-aware
    // derivation saw the loop in it and took `a == x0 * 2.0`. Paired, the two
    // left `a` with no value anywhere when `a == v` was written first, and
    // a = 2 m when it was written second.
    const variants = [
      ['a + 0.0 [m]', 'a == v'],
      ['a + 0.5 [m]', 'a == v - x0 * 0.5'],
    ];
    for (const [v, back] of variants) {
      const pair = [`assert constraint { ${back} }`, 'assert constraint { a == x0 * 2.0 }'];
      for (const order of [pair, swapped(pair)]) {
        const { model: m } = await loadModelText(`package A {
          attribute x0 : ISQ::LengthValue = 1.0 [m];
          attribute a : ISQ::LengthValue;
          attribute v : ISQ::LengthValue = ${v};
          ${order.join(' ')}
          constraint ta { a >= 1.5 [m] }
          constraint tv { v >= 1.5 [m] }
        }`);
        expect(judged(m!).sort(), order[0]).toEqual([
          [back, 'satisfied', 'Constraint satisfied: defines a = 2 [m]'],
          ['a == x0 * 2.0', 'satisfied', 'Constraint satisfied: defines a = 2 [m]'],
          ['a >= 1.5 [m]', 'satisfied', 'Constraint satisfied'],
          ['v >= 1.5 [m]', 'satisfied', 'Constraint satisfied'],
        ]);
        // And a target read through the specialiser the same two equations fix.
        const { model: layered } = await loadModelText(`package Y {
          package Common { attribute e : ISQ::LengthValue; constraint t { e >= 1.5 [m] } }
          package LA {
            attribute x0 : ISQ::LengthValue = 1.0 [m];
            attribute e : ISQ::LengthValue :> Common::e;
            attribute v : ISQ::LengthValue = ${v.replace('a', 'e')};
            ${order.map((eq) => eq.replace('{ a ==', '{ e ==')).join(' ')}
          }
        }`);
        const [la] = checkOf(layered!, 'Y::Common::t').instances!;
        expect([la.result, la.message], order[0]).toEqual(['satisfied', 'LA::e = 2 [m] meets Common::t (e >= 1.5 [m])']);
      }
    }
  });

  it('passes over an equation whose input nothing fixes, whichever equation is written first', async () => {
    // Stopping at the first equation that failed for a reason of its own made
    // the value turn on declaration order. `b == c + 0.0`, with `c` fixed by
    // nothing, written above `b == x0 * 2.0` left `b` with no value. And `a ==
    // d + e`, with `e` fixed by nothing, was passed over as "a loop" or taken
    // according to how `d` got its value — directly, or after passing over
    // `d == a`, which reads `a` back — so swapping `d`'s two equations, neither
    // of them `a`'s, decided whether `a` had one.
    const unfixed = ['assert constraint { b == c + 0.0 }', 'assert constraint { b == x0 * 2.0 }'];
    const incidental = [
      'assert constraint { d == x0 * 2.0 }',
      'assert constraint { d == a }',
      'assert constraint { a == d + e }',
    ];
    for (const order of [unfixed, swapped(unfixed), incidental, [incidental[1]!, incidental[0]!, incidental[2]!]]) {
      const u = model(
        `package U { attribute x0 : Real = 1.0; ${['a', 'b', 'c', 'd', 'e'].map((n) => `attribute ${n} : Real;`).join(' ')} ` +
          `${order.join(' ')} }`,
      );
      const scalar = scopeFor(u, named(u, 'U').id);
      const name = order.length === 2 ? 'b' : 'a';
      expect(scalar(name), order.join(' ')).toBe(2);
      const { model: m } = await loadModelText(`package D {
        attribute x0 : ISQ::LengthValue = 1.0 [m];
        ${['a', 'b', 'c', 'd', 'e'].map((n) => `attribute ${n} : ISQ::LengthValue;`).join(' ')}
        ${order.join(' ')}
        constraint t { ${name} >= 1.5 [m] }
      }`);
      expect([checkOf(m!, 'D::t').result, checkOf(m!, 'D::t').message], order.join(' ')).toEqual([
        'satisfied',
        'Constraint satisfied',
      ]);
    }
  });
});

/*
 * Past the cap on nested definitions neither path has a value. The unit-aware
 * derivation answered `depth` there, but only a kinded feature read through
 * its equation was refused for it: a value expression over the chain, an
 * untyped feature fixed by one, and the scalar path itself read on to the raw
 * number — `u == x70 * 1.0` then `u >= 1.0` was satisfied, `u >= 1.0 [m]`
 * refused for "1 and L are different physical dimensions".
 */
describe('checkConstraints — a chain nested past the cap is refused on every path', () => {
  const chain = (n: number, kind: string, unit: string) => {
    const links = [`attribute x0 : ${kind} = 1.0${unit};`];
    for (let i = 1; i <= n; i++) links.push(`attribute x${i} : ${kind}; assert constraint { x${i} == x${i - 1} + x0 }`);
    return links.join(' ');
  };
  const depth = (name: string) => `Could not evaluate: "${name}" cannot be derived: its defining equations nest more than 64 deep`;

  it('never compares a dimensioned chain past the cap as a raw number', async () => {
    const shapes = (n: number) => `
      attribute v : ISQ::LengthValue = x${n} * 1.0;
      attribute u;
      assert constraint du { u == x${n} * 1.0 }
      constraint vBare { v >= 1.0 }
      constraint vUnit { v >= 1.0 [m] }
      constraint uBare { u >= 1.0 }
      constraint uEq { u == ${n + 1}.0 }
      constraint uUnit { u >= 1.0 [m] }
      constraint xBare { x${n} >= 1.0 }`;
    const { model: m } = await loadModelText(`package P { ${chain(70, 'ISQ::LengthValue', ' [m]')} ${shapes(70)} }`);
    const read = (t: string) => [checkOf(m!, `P::${t}`).result, checkOf(m!, `P::${t}`).message];
    const through = `Could not evaluate: "v" cannot be derived: "x70" cannot be derived: its defining equations nest more than 64 deep`;
    expect(['vBare', 'vUnit'].map(read)).toEqual([['unknown', through], ['unknown', through]]);
    expect(['du', 'uBare', 'uEq', 'uUnit'].map(read)).toEqual(Array(4).fill(['unknown', depth('u')]));
    expect(read('xBare')).toEqual(['unknown', depth('x70')]);
    // Within the cap the same readings are judged, against a unit literal.
    const { model: short } = await loadModelText(`package P { ${chain(10, 'ISQ::LengthValue', ' [m]')} ${shapes(10)} }`);
    expect(['P::vUnit', 'P::uUnit', 'P::du'].map((t) => checkOf(short!, t).result)).toEqual(['satisfied', 'satisfied', 'satisfied']);
  });

  it('caps the scalar path where the unit-aware one is capped', async () => {
    const shapes = (n: number) => `
      attribute v : Real = x${n} * 1.0;
      attribute w = if "on" == "on" then x${n} else 0.0;
      constraint vBare { v >= 1.0 }
      constraint wBare { w >= 1.0 }
      constraint xEq { x${n} == ${n + 1}.0 }`;
    const { model: m } = await loadModelText(`package Q { ${chain(70, 'Real', '')} ${shapes(70)} }`);
    const q = named(m!, 'Q').id;
    // The scalar scope: a value up to the cap, none past it — not the 66 and
    // 71 it read on to.
    expect([scopeFor(m!, q)('x64'), scopeFor(m!, q)('x65'), scopeFor(m!, q)('x70')]).toEqual([65, undefined, undefined]);
    expect(evaluateFeatureValue(m!, named(m!, 'Q::x70').id)).toEqual({ unknown: true });
    expect(evaluateFeatureValue(m!, named(m!, 'Q::v').id)).toEqual({ unknown: true });
    // `w` is scalar-only (a string literal), so only the scalar fallback
    // reads it: it says why it has no value, as the unit-aware path says it
    // of `v`.
    expect(checkOf(m!, 'Q::wBare').message).toBe(depth('w'));
    expect(checkOf(m!, 'Q::vBare').message).toBe(
      'Could not evaluate: "v" cannot be derived: "x70" cannot be derived: its defining equations nest more than 64 deep',
    );
    expect(checkOf(m!, 'Q::xEq').message).toBe(depth('x70'));
    const { model: short } = await loadModelText(`package Q { ${chain(10, 'Real', '')} ${shapes(10)} }`);
    expect(['Q::vBare', 'Q::wBare', 'Q::xEq'].map((t) => checkOf(short!, t).result)).toEqual(['satisfied', 'satisfied', 'satisfied']);
  });

  it('reads a chain past the cap through a unit-literal value expression on the scalar path too', async () => {
    // `v = x70 + 0.0 [m]` is no scalar expression, so the scalar scope read
    // nothing of it: `a == v` failed there as an equation whose input has no
    // value, while the unit-aware derivation refused `a` for the depth. The
    // scalar-only `w` read "a referenced value is unknown" beside it.
    const { model: m } = await loadModelText(`package D { ${chain(70, 'ISQ::LengthValue', ' [m]')}
      attribute a : ISQ::LengthValue; attribute b : ISQ::LengthValue;
      attribute v : ISQ::LengthValue = x70 + 0.0 [m];
      assert constraint { a == v } assert constraint { a == b }
      attribute w = if "on" == "on" then a else 0.0;
      constraint ta { a >= 1.0 [m] } constraint tw { w >= 1.0 }
    }`);
    expect([checkOf(m!, 'D::ta').message, checkOf(m!, 'D::tw').message]).toEqual([depth('a'), depth('w')]);
  });

  it('takes a definition nested past the cap as the answer, whichever check reads the chain first', () => {
    // A guard on the one failure that ends the search for a definition. `f`'s
    // first definition reads a 30-link chain, and through it the 46 links
    // above `f` nest 77 deep. The cap is met on a count of definitions in
    // flight: derived from `w45` down, `f`'s first definition meets it, and
    // passing it over for the second gave w45 = 48 — but once a lookup had
    // settled `y30` or `f`, the first read whole, and w45 had no value.
    const links = ['attribute x0 : Real = 1.0; attribute y0 : Real = 1.0;'];
    for (let i = 1; i <= 30; i++) links.push(`attribute y${i} : Real; assert constraint { y${i} == y${i - 1} + x0 }`);
    links.push('attribute f : Real; assert constraint { f == y30 + x0 } assert constraint { f == x0 * 2.0 }');
    links.push('attribute w0 : Real; assert constraint { w0 == f + x0 }');
    for (let i = 1; i <= 45; i++) links.push(`attribute w${i} : Real; assert constraint { w${i} == w${i - 1} + x0 }`);
    const m = model(`package P { ${links.join(' ')} constraint t { w45 >= 1.0 } }`);
    const p = named(m, 'P').id;
    for (const first of ['', 'y30', 'f', 'w20']) {
      const scope = scopeFor(m, p);
      if (first) scope(first);
      expect(scope('w45'), first || 'fresh').toBeUndefined();
    }
    expect(scopeFor(m, p)('f')).toBe(32);
    expect(checkOf(m, 'P::t').message).toBe(depth('w45'));
  });
});

/*
 * One pass settles each derivation once. Without a memo the scalar scope
 * re-derived every input along every reference PATH: a fan-out of equations
 * took 47 s at 22 links, and a 200-link loop 105 s, in one checkConstraints.
 * The time bounds are generous — each sweep takes milliseconds — and are here
 * only so a lost memo fails the test instead of hanging it.
 */
describe('checkConstraints — a pass settles each derivation once', () => {
  it('reads a fan-out of asserted equations in linear time', async () => {
    const fib = (n: number) => {
      const links = ['attribute f0 : Real = 1.0; attribute f1 : Real = 1.0;'];
      for (let i = 2; i <= n; i++) links.push(`attribute f${i} : Real; assert constraint { f${i} == f${i - 1} + f${i - 2} }`);
      return `package P { ${links.join(' ')} constraint t { f${n} >= 1.0 } }`;
    };
    const { model: m } = await loadModelText(fib(22));
    let t0 = performance.now();
    const checks = checkConstraints(m!);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(checks.every((c) => c.result === 'satisfied')).toBe(true);
    expect(checks.find((c) => c.expression === 'f22 == f21 + f20')!.message).toBe('Constraint satisfied: defines f22 = 28657');
    // One scalar scope is one pass: f40 = fib(41).
    const { model: long } = await loadModelText(fib(40));
    t0 = performance.now();
    expect(scopeFor(long!, named(long!, 'P').id)('f40')).toBe(165580141);
    expect(performance.now() - t0).toBeLessThan(2000);
  }, 30_000);

  it('checks a 200-link loop of equations in well under its old 105 s', async () => {
    // No link of a loop is ever settled — each answer depends on what is in
    // flight — so every one is derived again where it is read; each is read
    // only as deep as the cap, from settled defining equations.
    const links = ['attribute k : ISQ::LengthValue = 1.0 [m];'];
    for (let i = 1; i <= 200; i++) {
      links.push(`attribute x${i} : ISQ::LengthValue; assert constraint { x${i} == x${i === 1 ? 200 : i - 1} + k }`);
    }
    const { model: m } = await loadModelText(`package P { ${links.join(' ')} constraint t { x200 >= 1.0 [m] } }`);
    const t0 = performance.now();
    const checks = checkConstraints(m!);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(checks.find((c) => c.expression === 'x200 >= 1.0 [m]')!.message).toBe(
      'Could not evaluate: "x200" cannot be derived: its defining equations nest more than 64 deep',
    );
  }, 30_000);

  it('checks a chain past the cap whose links each have several definitions in well under a second', async () => {
    // A guard. A link past the cap is refused and never settled, so a link
    // that searched on past the refusal of its first definition re-derived
    // the link below once for each of its own, and climbed back up through
    // `x_{i-1} == x_i - k` each time: a 150-link chain did not finish in five
    // minutes. The bound is generous; the sweep takes tens of milliseconds.
    const links = ['attribute k : ISQ::LengthValue = 1.0 [m]; attribute x0 : ISQ::LengthValue = 1.0 [m];'];
    for (let i = 1; i <= 150; i++) {
      links.push(
        `attribute x${i} : ISQ::LengthValue; attribute u${i} : ISQ::LengthValue;`,
        `assert constraint { x${i} == x${i - 1} + u${i} } assert constraint { x${i} == x${i - 1} + k }`,
      );
      if (i > 1) links.push(`assert constraint { x${i - 1} == x${i} - k }`);
    }
    const { model: m } = await loadModelText(`package P { ${links.join(' ')} constraint t { x150 >= 1.0 [m] } }`);
    const t0 = performance.now();
    const checks = checkConstraints(m!);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(checks.find((c) => c.expression === 'x150 >= 1.0 [m]')!.message).toBe(
      'Could not evaluate: "x150" cannot be derived: its defining equations nest more than 64 deep',
    );
    expect(checks.find((c) => c.expression === 'x64 == x63 + k')!.message).toBe('Constraint satisfied: defines x64 = 65 [m]');
  }, 30_000);
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

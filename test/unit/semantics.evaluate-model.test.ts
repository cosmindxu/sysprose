/**
 * Dedicated unit tests for evaluate-model.ts edge cases (finding L13).
 * The main path (scopeFor / evaluateFeatureValue / checkConstraints) is covered
 * by semantics.constraints.test.ts; this file adds edge-case coverage.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Model, ModelFactory } from '@core/index';
import { scopeFor, evaluateFeatureValue, checkConstraints, instanceRollup, anchorFor, quotePath, foldByVerdictAndCause } from '../../src/semantics/index';
import { featureIdsFor, unreadValuesOf, valueAtPath, valueKey, withEveryInstanceJudged } from '../../src/semantics/evaluate-model';
import { idScopeFor } from '../../src/semantics/relations';
import {
  assertDefinitionsIn,
  assertHeldInSome,
  bindingCapOf,
  bindingFrames,
  boundAboveSentence,
  boundHereSentence,
  boundPartnerSafe,
  boundSourceIn,
  classified,
  defaultGivesWay,
  defaultGivesWayIn,
  defaultGivesWaySomewhere,
  defaultStandsIn,
  equatedPartsMeasureRefusal,
  hasUserBindings,
  instanceGroups,
  instanceIndexSeam,
  instancesOfDefinition,
  isFailedReading,
  isBindingConnector,
  lookupsHold,
  lookupsOf,
  lookupsWhile,
  pastCapEnd,
  readsOtherwise,
  recordingLookups,
  replayLookups,
  shadowedNamesOf,
  sharedDefinitions,
} from '../../src/semantics/defining-equation';
import { obligationsOf } from '../../src/semantics/obligations';
import { refusalHead, refusalTail } from '../../src/semantics/engines/literal';
import { checkConstraintsNumeric, solveFeasible } from '../../src/semantics/solver';
import { DIMENSIONLESS } from '../../src/semantics/units';
import { equationDerivation, evaluateConstraintQuantityDetailed } from '../../src/semantics/units-eval';
import { parseModel } from '../../src/text/index';
import { verifyModel } from '../../src/api/verification';
import { validate } from '../../src/validation/index';
import { loadModelText } from '@text/load';
import type { ConstraintCheck } from '../../src/semantics/evaluate-model';

/**
 * The throwing stub (A.2.9, planted bug P17): four functions of the instance
 * index a per-instance reading calls, wrapped — every answer is the real one —
 * unless a test arms the stub to throw for the arguments it names. Only the
 * containment tests at the end of this file arm it.
 */
const thrower = vi.hoisted(() => ({ armed: undefined as undefined | ((fn: string, args: readonly unknown[]) => boolean) }));
vi.mock('../../src/semantics/defining-equation', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/semantics/defining-equation')>();
  const stub =
    <A extends unknown[], R>(fn: string, f: (...args: A) => R) =>
    (...args: A): R => {
      if (thrower.armed?.(fn, args) === true) throw new RangeError(`${fn}, planted to throw`);
      return f(...args);
    };
  return {
    ...real,
    boundSourceIn: stub('boundSourceIn', real.boundSourceIn),
    defaultGivesWayIn: stub('defaultGivesWayIn', real.defaultGivesWayIn),
    defaultStandsIn: stub('defaultStandsIn', real.defaultStandsIn),
    enclosingAssertOn: stub('enclosingAssertOn', real.enclosingAssertOn),
    assertDefinitionIn: stub('assertDefinitionIn', real.assertDefinitionIn),
    definedAgainstBoundIn: stub('definedAgainstBoundIn', real.definedAgainstBoundIn),
  };
});
// The obligations lane's reading of one relation (A.2.9): the same stub, which only `groupGoalRows`' test arms.
vi.mock('../../src/semantics/contracts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/semantics/contracts')>();
  return {
    ...real,
    readRelation: (...args: Parameters<typeof real.readRelation>) => {
      if (thrower.armed?.('readRelation', args) === true) throw new RangeError('readRelation, planted to throw');
      return real.readRelation(...args);
    },
  };
});

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

/*
 * THE ONE WALK every scope reads names through — the scalar scope, the quantity
 * scope and the variable scope the gates, the solver and the verification lane
 * read (`DefiningEquations.scope`). The three were three copies of one
 * collector, and the bare-name convenience they offered answered a name with
 * whatever feature the depth-first walk met first.
 */
describe('semantics — the one walk, and the bare-name rule', () => {
  const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;

  it('lets a direct feature claim its bare name though it states no value (xr3)', () => {
    const m = parseModel(`package XR3 {
      part def Q { attribute x = 7.0; }
      part def P { attribute x : Real; part q : Q; constraint lo { x >= 5.0 } constraint hi { x <= 5.0 } }
    }`).model;
    const p = named(m, 'XR3::P');
    // The scalar scope has no value for P's own x — and never Q's 7.
    expect(scopeFor(m, p.id)('x')).toBeUndefined();
    expect(scopeFor(m, p.id)('q.x')).toBe(7);
    expect(idScopeFor(m, p.id).get('x')).toBe(named(m, 'XR3::P::x').id);
    for (const c of checkConstraints(m)) expect(c.result, c.expression).toBe('unknown');
  });

  it('reads a name the context does not declare through its owners, where it is one value in every instance (E3)', () => {
    const m = parseModel(`package LX {
      attribute K = 7.0;
      part def Q { attribute L default = 1.0; part p { attribute x = K + L; } }
      part q : Q;
      part def R { attribute M default = 1.0; part s { attribute y = M; } constraint c { s.y <= 5.0 } }
      part r : R { attribute :>> M = 50.0; }
    }`).model;
    // The package's K is one value; Q's L is 1 in every Q, q declaring nothing anew.
    expect(scopeFor(m, named(m, 'LX::Q::p').id)('K')).toBe(7);
    expect(scopeFor(m, named(m, 'LX::Q::p').id)('x')).toBe(8);
    // R's M is 50 in r: read where it is declared, R's s would read R's 1 for r's s too — so it is read nowhere,
    // and the check names the element that changes it.
    expect(scopeFor(m, named(m, 'LX::R::s').id)('y')).toBeUndefined();
    const c = checkConstraints(m).find((x) => m.qualifiedName(x.id) === 'LX::R::c')!;
    expect([c.result, c.message]).toEqual([
      'unknown',
      'Could not evaluate: M is read through LX::R, which declares it, and is not one value in every instance of it: LX::r declares M anew',
    ]);
    // Read where the body is written, as KerML resolves it there: an import on the way answers K first (C's 9),
    // so the outer 3 is not read; nor is a K the writer cannot see (H's, for A declared outside H).
    const w = parseModel(`package LW {
      attribute K = 3.0;
      package C { attribute K = 9.0; }
      package U { import C::*; part def B { attribute x = K; } }
      part def A { attribute y = J; }
      part def H { attribute J = 70.0; part a : A; }
    }`).model;
    expect(scopeFor(w, named(w, 'LW::U::B').id)('x')).toBeUndefined();
    expect(scopeFor(w, named(w, 'LW::H::a').id)('y')).toBeUndefined();
    // An assert typed by a constraint definition names what it gives its parameters (`in a = L`): L, a default
    // it sets in every Q, is not read for Q's p.
    const t = parseModel(`package LT {
      constraint def Eq { in a; a == 50.0 }
      part def Q { attribute L default = 1.0; assert constraint e : Eq { in a = L; } part p { attribute y = L; } }
    }`).model;
    expect(scopeFor(t, named(t, 'LT::Q::p').id)('y')).toBeUndefined();
  });

  it('offers a nested bare name only when exactly one feature below has it (xb1)', () => {
    const m = parseModel(`package XB1 {
      part def P { attribute y = 4.0; }
      part def Q { attribute y = 100.0; attribute z = 3.0; }
      part def Sys { part a : P; part b : Q; constraint c { y <= 10.0 } constraint d { z <= 10.0 } }
    }`).model;
    const sys = named(m, 'XB1::Sys');
    const ids = idScopeFor(m, sys.id);
    expect(ids.has('y')).toBe(false);
    expect(ids.get('a.y')).toBe(named(m, 'XB1::P::y').id);
    expect(ids.get('b.y')).toBe(named(m, 'XB1::Q::y').id);
    // One `z` below: the convenience stands, on every scope alike.
    expect(scopeFor(m, sys.id)('z')).toBe(3);
    const checks = new Map(checkConstraints(m).map((c) => [c.expression, c.result]));
    expect([checks.get('y <= 10.0'), checks.get('z <= 10.0')]).toEqual(['unknown', 'satisfied']);
  });

  it('never offers a constraint’s or a calculation’s own features as bare names around it (xr1)', () => {
    const m = parseModel(`package XR1 {
      part def P {
        attribute x : Real;
        constraint c { in x = 1.0; x >= 0.0 }
        calc g { in w = 2.0; w * 2.0 }
        constraint lo { x >= 5.0 }
        constraint uses { w >= 1.0 }
      }
    }`).model;
    const p = named(m, 'XR1::P');
    expect(idScopeFor(m, p.id).get('x')).toBe(named(m, 'XR1::P::x').id);
    expect(idScopeFor(m, p.id).has('w')).toBe(false);
    expect(idScopeFor(m, p.id).get('c.x')).toBe(named(m, 'XR1::P::c::x').id);
    const checks = new Map(checkConstraints(m).map((c) => [c.expression, c.result]));
    expect([checks.get('x >= 5.0'), checks.get('w >= 1.0')]).toEqual(['unknown', 'unknown']);
  });

  it('denotes the same feature by every name on the value and the variable scopes', () => {
    const m = parseModel(`package W {
      part def Cell { attribute v = 2.0; attribute w; }
      part def Pack { part a : Cell; part b : Cell; attribute total = a.v + b.v; attribute v = 9.0; }
      part pack : Pack;
    }`).model;
    for (const ctx of ['W', 'W::Pack', 'W::pack']) {
      const id = named(m, ctx).id;
      const ids = idScopeFor(m, id);
      for (const [name, featureId] of featureIdsFor(m, id)) expect(ids.get(name), `${ctx} ${name}`).toBe(featureId);
    }
  });

  it('reads a chain through the USAGE: its own redefinition, then what its type declares', () => {
    const m = parseModel(`package R6 {
      part def P { attribute load default = 1.0; attribute k = 3.0; }
      part def Q { part p : P; }
      part q : Q { part :>> p { attribute :>> load = 50.0; } }
    }`).model;
    const root = named(m, 'R6');
    expect(scopeFor(m, root.id)('q.p.load')).toBe(50);
    expect(scopeFor(m, root.id)('q.p.k')).toBe(3);
  });

  it('answers a renamed redefinition under the name it redefines too (r15)', () => {
    const m = parseModel(`package R15 {
      part def P { attribute load default = 1.0; }
      part p : P { attribute heavy redefines load = 50.0; }
    }`).model;
    const root = named(m, 'R15');
    expect(scopeFor(m, root.id)('p.heavy')).toBe(50);
    expect(scopeFor(m, root.id)('p.load')).toBe(50);
  });

  // The nested convenience is this tool's reading of a name KerML resolves to nothing where it is written. A's
  // `x = K` beside `part p : P` with P's `K = 7.0` is the package's K, which KerML gives it: read as p's 7, every
  // surface held `x <= 10.0` (NX3), and the H5 rules read the other side of an assert by the same walk (NX1,
  // NX4: x's default stood and the check flagged the assert).
  it('reads a bare name as KerML resolves it where it is written, before the one feature nested below (NX1, NX3, NX4)', async () => {
    const m = parseModel(`package NX3 {
      attribute K = 50.0;
      part def P { attribute K = 7.0; }
      part def A { attribute x = K; part p : P; constraint c { x <= 10.0 } }
    }`).model;
    const a = named(m, 'NX3::A');
    expect(idScopeFor(m, a.id).get('K')).toBe(named(m, 'NX3::K').id);
    expect(scopeFor(m, a.id)('x')).toBe(50);
    expect(checkConstraints(m).find((c) => m.qualifiedName(c.id) === 'NX3::A::c')!.result).toBe('violated');
    // q1's tie reads the package's K (50), not r's (7): x's `default = 7.0` stands against the assert (decision 14
    // amended 2026-10-22), so the tie is violated where KerML resolves K, and would hold at r's 7.
    const { model: n } = await loadModelText(`package NX4 {
      attribute K = 50.0;
      part def P { attribute x default = 7.0; constraint c { x <= 10.0 } }
      part def R { attribute K = 7.0; }
      part def Q { part p : P; part r : R; }
      part q1 : Q { assert constraint tie { p.x == K } }
      constraint top { q1.p.x <= 10.0 }
    }`);
    const checks = checkConstraints(n!);
    expect(checks.find((c) => n!.qualifiedName(c.id) === 'NX4::q1::tie')!.result).toBe('violated');
    expect(checks.find((c) => n!.qualifiedName(c.id) === 'NX4::top')!.result).toBe('satisfied');
    // A name KerML resolves to nothing where it is written is still the one feature below (xb1's z), and one it
    // resolves is never it, even where it leaves that name unread (an import on the way).
    const w = parseModel(`package NXI {
      package C { attribute K = 9.0; }
      package U { import C::*; part def P { attribute K = 7.0; } part def B { attribute x = K; part p : P; } }
    }`).model;
    expect(idScopeFor(w, named(w, 'NXI::U::B').id).get('K')).toBeUndefined();
    expect(scopeFor(w, named(w, 'NXI::U::B').id)('x')).toBeUndefined();
  });

  // DY1: Q's p's `:>> load = L` is Q's L (1) in every Q — KerML resolves it where it is written — but q's p, which
  // declares its own L (50), answered the bare name with that: `q.p.m2 <= 0.0` held on three surfaces.
  it('reads no name a context declares itself that a body of a general reads through the general’s owners (DY1)', async () => {
    const { model: m } = await loadModelText(`package DY1 {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
      part def Q { attribute L : ScalarValues::Real = 1.0; part p : P { attribute :>> load = L; } constraint c { p.m2 >= 0.0 } }
      part q : Q { part :>> p { attribute L : ScalarValues::Real = 50.0; } }
      constraint topT { q.p.m2 >= 0.0 }
      constraint topF { q.p.m2 <= 0.0 }
    }`);
    const qp = sharedDefinitions(m!).denote(named(m!, 'DY1::q').id).get('p')!.feature;
    const shadow = sharedDefinitions(m!).clashesIn(qp.id).get('L');
    expect([shadow?.shadow !== undefined, shadow?.contradiction, m!.qualifiedName(shadow!.other.id)]).toEqual([true, false, 'DY1::Q::L']);
    const checks = checkConstraints(m!);
    const sentence =
      'DY1::q::p declares `L` itself, and `load` in DY1::Q::p reads `L` as DY1::Q::L, as KerML resolves it where it is ' +
      'written; one reading of DY1::q::p cannot give the name both meanings, so neither is read there';
    for (const top of ['DY1::topT', 'DY1::topF']) {
      const c = checks.find((x) => m!.qualifiedName(x.id) === top)!;
      expect([c.result, c.message]).toEqual(['unknown', `Could not evaluate: ${sentence}`]);
      expect(checkConstraintsNumeric(m!).find((r) => m!.qualifiedName(r.id) === top)!.result).toBe('unknown');
    }
    // Q's own p reads the body at Q's L, its value in every Q: m2 is 9. No `#clash` row is filed for the shadow.
    expect(checks.find((c) => m!.qualifiedName(c.id) === 'DY1::Q::c')!.result).toBe('satisfied');
    expect(checks.filter((c) => c.conflict === 'clash')).toEqual([]);
  });

  // MI1: Q2's and Q3's `L` (50, 60) both reach q through Q23 — the `#clash` says neither is read — but q's end copy
  // of `bind p.load = L` redefines Q's valueless L and masked them: P's default 1 was read for q's p's load, and
  // `q.p.load == 50.0` refuted on three surfaces of a model that states both values.
  it('reads no value an end copy masks two inherited values under, nor one a binding carries from it (MI1)', async () => {
    const { model: m } = await loadModelText(`package MI1 {
      part def P { attribute load default = 1.0; attribute m2 = 10.0 - load; }
      part def Q { attribute L; part p : P; }
      part def Q2 :> Q { attribute :>> L = 50.0; }
      part def Q3 :> Q { attribute :>> L = 60.0; }
      part def Q23 :> Q2, Q3;
      part q : Q23 { bind p.load = L; }
      constraint t50 { q.p.load == 50.0 }
      constraint t60 { q.p.load == 60.0 }
      constraint u50 { q.L == 50.0 }
    }`);
    const checks = checkConstraints(m!);
    const numeric = checkConstraintsNumeric(m!);
    for (const row of ['MI1::t50', 'MI1::t60', 'MI1::u50']) {
      const c = checks.find((x) => m!.qualifiedName(x.id) === row)!;
      expect(c.result, row).toBe('unknown');
      expect(c.message, row).toContain('MI1::q inherits Q2::L = 50.0 and Q3::L = 60.0 under the one name `L`');
      expect(numeric.find((r) => m!.qualifiedName(r.id) === row)!.result, row).toBe('unknown');
    }
    // The `#clash` row stays the one finding, at Q23.
    expect(checks.filter((c) => c.conflict === 'clash').map((c) => [m!.qualifiedName(c.ownerId!), c.result])).toEqual([['MI1::Q23', 'violated']]);
  });

  // The same pair where the usage is itself the diamond (MI1D: `part q : Q2, Q3`; MI2: one `=` and one `default`)
  // or under an explicit valueless redefinition (MI3: `attribute :>> L;`): q's L read P's default 1 through q's
  // own L on every surface, and MI1D filed no `#clash`, so a model that states both 50 and 60 read as consistent.
  it('reads no value the usage’s own diamond, or a valueless redefinition, masks (MI1D, MI2, MI3)', async () => {
    const shape = (pkg: string, q3: string, q: string) => `package ${pkg} {
      part def P { attribute load default = 1.0; attribute m2 = 10.0 - load; }
      part def Q { attribute L; part p : P; }
      part def Q2 :> Q { attribute :>> L = 50.0; }
      part def Q3 :> Q { attribute :>> L ${q3}; }
      ${q}
      constraint t1 { q.p.load == 1.0 }
      constraint t50 { q.p.load == 50.0 }
    }`;
    const read = async (text: string, pkg: string) => {
      const { model: m } = await loadModelText(text);
      const checks = checkConstraints(m!);
      const numeric = checkConstraintsNumeric(m!);
      return {
        rows: ['t1', 't50'].map((r) => [
          checks.find((x) => m!.qualifiedName(x.id) === `${pkg}::${r}`)!.result,
          numeric.find((x) => m!.qualifiedName(x.id) === `${pkg}::${r}`)!.result,
        ]),
        clash: checks.filter((c) => c.conflict === 'clash').map((c) => [m!.qualifiedName(c.ownerId!), c.result]),
      };
    };
    const unknown = [
      ['unknown', 'unknown'],
      ['unknown', 'unknown'],
    ];
    expect(await read(shape('MI1D', '= 60.0', 'part q : Q2, Q3 { bind p.load = L; }'), 'MI1D')).toEqual({
      rows: unknown,
      clash: [['MI1D::q', 'violated']],
    });
    expect(await read(shape('MI2', 'default = 60.0', 'part q : Q2, Q3 { bind p.load = L; }'), 'MI2')).toEqual({ rows: unknown, clash: [] });
    expect(await read(shape('MI3', '= 60.0', 'part def Q23 :> Q2, Q3; part q : Q23 { attribute :>> L; bind p.load = L; }'), 'MI3')).toEqual({
      rows: unknown,
      clash: [['MI3::Q23', 'violated']],
    });
    // Two that agree (ME6: both 50), under the copy, read P's default 1 through it on every surface (t1 held, t50
    // refuted): the copy redefines neither. Read nowhere now, no contradiction filed, in a sentence that says so.
    expect(await read(shape('ME6', '= 50.0', 'part q : Q2, Q3 { bind p.load = L; }'), 'ME6')).toEqual({ rows: unknown, clash: [] });
    const { model: me6 } = await loadModelText(shape('ME6', '= 50.0', 'part q : Q2, Q3 { bind p.load = L; }'));
    expect(checkConstraints(me6!).find((x) => me6!.qualifiedName(x.id) === 'ME6::t50')!.message).toBe(
      'Could not evaluate: q.p.load has no value: ME6::q inherits Q2::L = 50.0 and Q3::L = 50.0 under the one name `L`, which agree; ' +
        'but its own `L` states nothing (an implicit connector-end copy, or a redefinition with no value) and redefines neither, and ' +
        'this tool does not read the value they agree on through it, so neither is read',
    );
    // With no binding, nothing joins P's default to L: q's p's load is P's 1, read as before.
    expect(await read(shape('ME6C', '= 50.0', 'part q : Q2, Q3;'), 'ME6C')).toEqual({
      rows: [
        ['satisfied', 'satisfied'],
        ['violated', 'violated'],
      ],
      clash: [],
    });
  });
});

/*
 * A value written with `=` is a BINDING (KerML): every instance of its owner
 * has it, so a usage that redefines it with another value contradicts the
 * model, and only a `default` is overridable. Every surface used to read a
 * redefinition as an override where it read it at all — and mostly did not:
 * an unnamed `:>> load = 50.0` claimed no name, so `p.load` was P's 1.
 */
describe('checkConstraints — a redefinition is the feature in its context, and `=` binds', () => {
  const R1 = (op: string) => `package R1 {
    part def P {
      attribute load : Real ${op} 1.0;
      attribute m2 : Real = 10.0 - load;
    }
    part p : P { attribute :>> load = 50.0; }
    constraint hi { p.load >= 10.0 }
    constraint lo { p.load <= 10.0 }
    constraint m2 { p.m2 >= 0.0 }
  }`;
  const by = (m: Model) => new Map(checkConstraints(m).map((c) => [c.expression, c]));

  it('reads a usage’s redefinition of a default in its place, on both pipelines', () => {
    const m = parseModel(R1('default =')).model;
    const checks = by(m);
    expect([checks.get('p.load >= 10.0')!.result, checks.get('p.load <= 10.0')!.result]).toEqual([
      'satisfied',
      'violated',
    ]);
    const rows = new Map(checkConstraintsNumeric(m).map((r) => [r.raw, r.result]));
    expect([rows.get('p.load >= 10.0'), rows.get('p.load <= 10.0')]).toEqual(['satisfied', 'violated']);
  });

  it('reads a derived value whose input the usage changed in the usage, as its own value (Stage 2)', () => {
    // P's `m2 = 10.0 - load` read as `p.m2` is p's: 10 − 50 = −40 — not P's 9
    // (a false proof), and not "no value" (Stage 1's refusal).
    const m = parseModel(R1('default =')).model;
    const m2 = by(m).get('p.m2 >= 0.0')!;
    expect([m2.result, m2.message]).toEqual(['violated', 'Constraint violated: p.m2 >= 0.0']);
    const row = checkConstraintsNumeric(m).find((r) => r.raw === 'p.m2 >= 0.0')!;
    expect([row.result, row.slack]).toEqual(['violated', -40]);
    const root = named(m, 'R1');
    expect(scopeFor(m, root.id)('p.m2')).toBe(-40);
  });

  it('reads every derived value in the usage that changes its input — a value, a definition, a calculation, a copy, a binding', () => {
    const m = parseModel(`package R3 {
      part def P {
        attribute load : Real default = 1.0;
        attribute m2 : Real = 10.0 - load;
        attribute e : Real;
        assert constraint de { e == 10.0 - load }
        calc margin { 10.0 - load }
      }
      part p : P {
        attribute :>> load = 50.0;
        constraint own { m2 <= -40.0 and e <= -40.0 and margin <= -40.0 }
      }
      part q : P { attribute :>> load = 50.0; attribute :>> m2; }
      attribute w2 : Real;
      bind w2 = p.m2;
      constraint viaCopy { q.m2 >= 0.0 }
      constraint viaBind { w2 >= 0.0 }
      constraint viaChain { p.e >= 0.0 }
    }`).model;
    const checks = by(m);
    // Inside p, by bare names; through q's `:>> m2;`, which states nothing and
    // reads P's value in q; through the binding to the copy of p's m2; and
    // through a chain to P's asserted definition, read over p's load.
    expect(checks.get('m2 <= -40.0 and e <= -40.0 and margin <= -40.0')!.result).toBe('satisfied');
    for (const e of ['q.m2 >= 0.0', 'w2 >= 0.0', 'p.e >= 0.0']) expect(checks.get(e)!.result, e).toBe('violated');
    const rows = new Map(checkConstraintsNumeric(m).map((r) => [r.raw, r]));
    for (const e of ['q.m2 >= 0.0', 'w2 >= 0.0', 'p.e >= 0.0']) {
      expect([rows.get(e)!.result, rows.get(e)!.slack], e).toEqual(['violated', -40]);
    }
    // P's own values stand beside them.
    const root = named(m, 'R3');
    expect([scopeFor(m, root.id)('p.m2'), evaluateFeatureValue(m, m.all().find((e) => e.declaredName === 'm2')!.id)]).toEqual([
      -40,
      { value: 9 },
    ]);
  });

  it('calls a redefinition that changes a BINDING a contradiction, and reads neither value', () => {
    const m = parseModel(R1('=')).model;
    const checks = by(m);
    for (const e of ['p.load >= 10.0', 'p.load <= 10.0']) {
      expect(checks.get(e)!.result, e).toBe('unknown');
      expect(checks.get(e)!.message, e).toContain(
        'p::load = 50.0 contradicts P::load = 1.0, a binding every P holds (a value written with `=`)',
      );
    }
    // The contradiction itself is a violation, anchored at the redefinition.
    const contradiction = checks.get('load == 1.0')!;
    expect(contradiction.result).toBe('violated');
    const redef = m.all().find((e) => e.eClass === 'AttributeUsage' && e.declaredName === undefined)!;
    expect(contradiction.id).toBe(redef.id);
    const rows = new Map(checkConstraintsNumeric(m).map((r) => [r.raw, r.result]));
    expect([rows.get('p.load >= 10.0'), rows.get('p.load <= 10.0')]).toEqual(['unknown', 'unknown']);
  });

  it('finds no contradiction in a redefinition that restates the binding, or states nothing', () => {
    for (const redef of ['attribute :>> load = 1.0;', 'attribute :>> load;']) {
      const checks = by(parseModel(R1('=').replace('attribute :>> load = 50.0;', redef)).model);
      expect([...checks.values()].some((c) => c.message.includes('contradicts')), redef).toBe(false);
      expect(checks.get('p.load <= 10.0')!.result, redef).toBe('satisfied');
      // Neither changes what P's derived value reads: it is read, in its context.
      expect(checks.get('p.m2 >= 0.0')!.result, redef).toBe('satisfied');
    }
  });

  it('reads a definition’s constraint in every context that specialises it and changes what it reads (r19, r20)', () => {
    const m = parseModel(`package R20 {
      part def D {
        attribute mass : Real;
        attribute k : Real default = 2.0;
        attribute lim : Real = 10.0 * k;
        constraint c { mass <= lim }
        constraint cap { k <= 1.0 }
      }
      part light : D { attribute :>> mass = 5.0; attribute :>> k = 0.1; }
      part heavy : D { attribute :>> mass = 50.0; }
      part plain : D;
    }`).model;
    const checks = by(m);
    const c = checks.get('mass <= lim')!;
    expect(c.result).toBe('unknown');
    // `lim` reads `k`, which light changes: light's lim is light's own, 10 ×
    // 0.1 = 1 — never D's 20. heavy changes only `mass`. `plain` changes nothing.
    expect(verdicts(c)).toEqual([
      ['light', 'violated'],
      ['heavy', 'violated'],
    ]);
    expect(c.instances![0].message).toBe('light::mass = 5, light::lim = 1 misses D::c (mass <= lim)');
    expect(c.instances![1].message).toBe('heavy::mass = 50 misses D::c (mass <= lim)');
    // D's own verdict at D's values stands beside the readings in its contexts.
    const cap = checks.get('k <= 1.0')!;
    expect(cap.result).toBe('violated');
    expect(verdicts(cap)).toEqual([['light', 'satisfied']]);
  });
});

/*
 * A body that reads a name its own element declares is read by NO surface: an
 * evaluator reads a body in its owner's scope first, where that name is
 * another feature (D6). The test keys on the element's EFFECTIVE names, so an
 * unnamed `in :>> y = 100.0` is `y` too (xs1).
 */
describe('semantics — a name a body declares itself is no owner feature', () => {
  it('finds the shadowed names, an unnamed redefined parameter included', () => {
    const m = parseModel(`package XS1 {
      constraint def Lim { in y : Real; }
      part def P {
        attribute y = 4.0;
        attribute z = 1.0;
        constraint c : Lim { in :>> y = 100.0; y <= 10.0 }
        constraint own { in y = 100.0; y <= 10.0 }
        constraint free { in q = 2.0; q <= 10.0 and z <= 2.0 }
      }
    }`).model;
    const el = (n: string) => m.all().find((e) => e.declaredName === n)!;
    expect(shadowedNamesOf(m, el('c'), ['y'])).toEqual(['y']);
    expect(shadowedNamesOf(m, el('own'), ['y'])).toEqual(['y']);
    // A parameter the owner has no feature for, and an owner feature the body
    // does not declare, shadow nothing.
    expect(shadowedNamesOf(m, el('free'), ['q', 'z'])).toEqual([]);
    const checks = new Map(checkConstraints(m).map((c) => [c.id, c]));
    expect(checks.get(el('c').id)!.result).toBe('unknown');
    expect(checks.get(el('c').id)!.message).toMatch(/^Could not evaluate: `y` in c is XS1::P::c::y, its own in parameter/);
    expect(checks.get(el('own').id)!.result).toBe('unknown');
    expect(checks.get(el('free').id)!.result).toBe('satisfied');
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
      package LA { attribute m :> Common::m default = 0.5; }
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

  it('reads an asserted equation through a feature chain that redefines what it reads, over the chain’s names', () => {
    // The equation holds of every Software; read for a Tuned, it reads Tuned's
    // k: a = 2 × 0.95 = 1.9.
    const text = (bound: string) => `package E {
      part def Software { attribute k : Real default = 1.0; attribute a : Real; assert constraint { a == k * 0.95 } }
      part def Tuned :> Software { attribute :>> k = 2.0; }
      requirement def SoftwareContract {
        subject coordination : Tuned;
        require constraint { coordination.a >= ${bound} }
      }
    }`;
    expect(only(model(text('1.8'))).result).toBe('satisfied');
    expect(only(model(text('1.95'))).result).toBe('violated');
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
      part def D { attribute mass : Real; attribute maxMass : Real default = 10; constraint c { mass <= maxMass } }
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
    // And each carries the exact decimals it is derived from — one fifth, and
    // twenty-eight twenty-fifths — which a tie over it is decided by.
    for (const [name, expr, exact] of [
      ['lost', 'lost == loss / watched', { num: 1n, den: 5n }],
      ['third', 'third == lost * watched + 1', { num: 28n, den: 25n }],
    ] as const) {
      expect(equationDerivation(m, named(m, `LA::${name}`).id, expr).q, name).toEqual({
        magnitude: scalar(name),
        dimension: DIMENSIONLESS,
        exact,
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

/*
 * A BOUND PARTNER IS READ FOR AN INSTANCE ONLY WHERE EVERY INSTANCE READS IT
 * ALIKE (plan per-instance-check, step F1). A valueless feature a binding
 * holds reads its partner where the partner is written (`boundDerivation`):
 * Q's `L = 2.0 * K` read at Q is 1, so P's `m2 = 10.0 - load` in Q's p read 9
 * for q's p too, whose K of 25 makes L 50 and m2 −40 — a false refutation of
 * `q.p.m2 <= 0.0`, and a false contradiction of the binding itself. The
 * partner is now read only where every instance the reading stands for reads
 * it as written; elsewhere nothing is read, until a reading per instance.
 */
describe('checkConstraints — a bound partner is read only where every instance reads it alike', () => {
  const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;
  const resultOf = (checks: ConstraintCheck[], m: Model, qualified: string) =>
    checks.find((c) => m.qualifiedName(c.id) === qualified)?.result;
  /** The ends of the one binding connector `holder` owns: [source, target]. */
  const endsOf = (m: Model, holder: string): [string, string] => {
    const b = m.children(named(m, holder).id).find((c) => c.eClass === 'BindingConnectorAsUsage')!;
    return [b.source![0]!, b.target![0]!];
  };
  const P = 'part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }';
  const M2 = `package M2 {
    ${P}
    part def Q {
      attribute K : ScalarValues::Real default = 0.5;
      attribute L : ScalarValues::Real = 2.0 * K;
      part p : P;
      bind p.load = L;
    }
    part q : Q { attribute :>> K = 25.0; }
    constraint m2NegT { q.p.m2 <= 0.0 }
    constraint m2PosF { q.p.m2 >= 0.0 }
  }`;
  /** A binding carried down `depth` usages, each level binding its `a`'s end to its own L. */
  const bindingChain = (depth: number) =>
    [
      'package Deep {',
      `  ${P.replace('part def P', 'part def T0')}`,
      ...Array.from(
        { length: depth },
        (_, i) =>
          `  part def T${i + 1} { attribute L : ScalarValues::Real default = 1.0; part a : T${i}; bind a.${i === 0 ? 'load' : 'L'} = L; }`,
      ),
      `  part top : T${depth} { attribute :>> L = 50.0; }`,
      '}',
    ].join('\n');

  it('reads a member otherwise where the context changes what its value reads, and never a literal', async () => {
    const { model: m } = await loadModelText(M2);
    const L = named(m!, 'M2::Q::L');
    // q's K of 25 makes Q's `L = 2.0 * K` q's own 50: read IN q.
    expect(readsOtherwise(m!, named(m!, 'M2::q').id, 'L', L)).toBe(named(m!, 'M2::q').id);
    expect(readsOtherwise(m!, named(m!, 'M2::Q').id, 'L', L)).toBeUndefined();
    // An asserted definition read where the context changes what it reads.
    const { model: a } = await loadModelText(`package M2a {
      ${P}
      part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real; assert constraint defL { L == 2.0 * K } part p : P; bind p.load = L; }
      part q : Q { attribute :>> K = 25.0; }
    }`);
    expect(readsOtherwise(a!, named(a!, 'M2a::q').id, 'L', named(a!, 'M2a::Q::L'))).toBe(named(a!, 'M2a::q').id);
    // A literal is one value in every instance.
    const { model: h } = await loadModelText(`package H2 {
      ${P}
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q : Q { attribute :>> L = 50.0; }
    }`);
    const q = named(h!, 'H2::q');
    expect(readsOtherwise(h!, q.id, 'L', sharedDefinitions(h!).byName(q.id).get('L')!)).toBeUndefined();
    // A redefinition that states nothing reads the value it redefines in its own usage: p's copy of
    // P's m2 is p's −40 however it is reached.
    const { model: w } = await loadModelText(`package W { ${P} part p : P { attribute :>> load = 50.0; } attribute w : ScalarValues::Real; bind w = p.m2; }`);
    const copy = w!.get(endsOf(w!, 'W')[1])!;
    expect(readsOtherwise(w!, named(w!, 'W').id, 'p.m2', copy)).toBeUndefined();
  });

  it('reads no partner for a usage that stands for an instance the binding reads otherwise (M2)', async () => {
    const { model: m } = await loadModelText(M2);
    const [load] = endsOf(m!, 'M2::Q');
    expect(boundPartnerSafe(m!, named(m!, 'M2::Q::p').id, 'load', load)).toBe(false);
    const checks = checkConstraints(m!);
    // m2 is −40 in q, read per instance (F5): never the 9 Q's own p reads.
    expect([resultOf(checks, m!, 'M2::m2NegT'), resultOf(checks, m!, 'M2::m2PosF')]).toEqual(['satisfied', 'violated']);
    // Nor is the binding a contradiction in q: its bound end states no value of its own.
    expect(checks.filter((c) => c.conflict === 'bind')).toEqual([]);
  });

  it('reads no partner where a usage puts its own feature in the place of one the binding joins', async () => {
    const { model: m } = await loadModelText(`package M7F {
      part def Q {
        attribute K : ScalarValues::Real default = 0.5;
        attribute L : ScalarValues::Real default = 2.0 * K;
        attribute load : ScalarValues::Real;
        bind load = L;
        constraint c { load <= 5.0 }
      }
      part q2 : Q { attribute :>> L = 50.0; }
    }`);
    const [load] = endsOf(m!, 'M7F::Q');
    // Q's own reading reads Q's L of 1, as the connector joins it; q2 joins load to its own L of 50.
    expect(boundPartnerSafe(m!, named(m!, 'M7F::Q').id, 'load', load)).toBe(true);
    expect(boundPartnerSafe(m!, named(m!, 'M7F::q2').id, 'load', load)).toBe(false);
    const checks = checkConstraints(m!);
    const c = checks.find((x) => m!.qualifiedName(x.id) === 'M7F::Q::c')!;
    expect(c.result).toBe('satisfied');
    // Read per instance (F5): q2's load is its own L of 50, so `load <= 5.0` is violated there.
    expect(c.instances!.map((i) => [i.context, i.result])).toEqual([['q2', 'violated']]);
    expect(checks.filter((x) => x.conflict === 'bind')).toEqual([]);
  });

  it('reads the partner where every context reads it alike', async () => {
    const { model: m } = await loadModelText(`package M6 {
      attribute K : ScalarValues::Real default = 0.5;
      attribute L : ScalarValues::Real = 2.0 * K;
      attribute load : ScalarValues::Real;
      bind load = L;
      constraint c1 { load <= 1.0 }
      constraint c2 { load >= 1.0 }
    }`);
    const [load] = endsOf(m!, 'M6');
    expect(boundPartnerSafe(m!, named(m!, 'M6').id, 'load', load)).toBe(true);
    const checks = checkConstraints(m!);
    expect([resultOf(checks, m!, 'M6::c1'), resultOf(checks, m!, 'M6::c2')]).toEqual(['satisfied', 'satisfied']);
  });

  it('refines the frame cap per binding: one deep binding does not abstain every bound read', async () => {
    const { model: deep } = await loadModelText(bindingChain(33));
    const { model: shallow } = await loadModelText(bindingChain(32));
    // The package frame of T1's binding lies 33 usages down (`top.a.….a`): left out, not silently.
    expect(bindingCapOf(deep!)).toBe('segments');
    expect(bindingCapOf(shallow!)).toBeUndefined();
    // Any reading of a binding's end answers the cap, in the sentence every surface gives.
    const definitions = sharedDefinitions(deep!);
    const a = named(deep!, 'Deep::T1::a');
    const above = definitions.boundAbove(a.id, ['load']);
    expect(above).toEqual({ pastCap: 'segments' });
    expect(boundAboveSentence(definitions, a.id, above!)).toBe(
      'the relation is read in Deep::T1::a and reads a value a binding joins, and a binding of this model is read ' +
        'deeper than 32 usages: past that, this tool reads no bound value for any one instance, so it is not carried',
    );
    // Per binding, not model-wide: M6's own binding is not the one the deep chain capped, so its
    // partner still reads — `bindingCapOf` reports the model-wide summary, the guards do not.
    const M6 = (deepChain: boolean) => `package M6 {
      attribute K : ScalarValues::Real default = 0.5;
      attribute L : ScalarValues::Real = 2.0 * K;
      attribute load : ScalarValues::Real;
      bind load = L;
      constraint c1 { load <= 1.0 }
      ${deepChain ? bindingChain(33).split('\n').slice(1, -1).join('\n') : ''}
    }`;
    for (const deepChain of [false, true] as const) {
      const { model: m } = await loadModelText(M6(deepChain));
      expect(bindingCapOf(m!), String(deepChain)).toBe(deepChain ? 'segments' : undefined);
      const [load] = endsOf(m!, 'M6');
      expect(boundPartnerSafe(m!, named(m!, 'M6').id, 'load', load), String(deepChain)).toBe(true);
      expect(resultOf(checkConstraints(m!), m!, 'M6::c1'), String(deepChain)).toBe('satisfied');
      const custom = sharedDefinitions(m!);
      const inside = named(m!, 'M6');
      expect(custom.boundAbove(inside.id, ['load']), String(deepChain)).toBeUndefined();
    }
  });

  // CAP1 (the 2026-10-14 review, A-C3): the package's `bind Y = top.a.….a.load` joins Y's default to the load
  // T1's `bind a.load = L` gives X's 50 thirty-three usages down — a binding past the segment cap. Read in the
  // package alone, Y's default and the load's fall-through were two defaults that agree, and Y stood at 1:
  // `Y >= 40.0` refuted where it holds, on all four surfaces. The cap reaches every binding joined to the
  // capped one, through what an end redefines (the package's end at that path redefines T1's).
  it('carries a cap along every binding joined to the capped one, through what an end redefines (CAP1)', async () => {
    const as = (n: number) => Array.from({ length: n }, () => 'a').join('.');
    const cap1 = (y: string) =>
      [
        'package CAP {',
        `  ${P.replace('part def P', 'part def T0')}`,
        '  part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; bind a.load = L; }',
        ...Array.from({ length: 32 }, (_, i) => `  part def T${i + 2} { part a : T${i + 1}; }`),
        '  part top : T33;',
        '  attribute X : ScalarValues::Real = 50.0;',
        `  bind top.${as(32)}.L = X;`,
        `  attribute Y : ScalarValues::Real${y};`,
        `  bind Y = top.${as(33)}.load;`,
        '  constraint yT { Y >= 40.0 }',
        '  constraint yF { Y <= 5.0 }',
        `  constraint negT { top.${as(33)}.m2 <= 0.0 }`,
        '  attribute V : ScalarValues::Real = 3.0;',
        '  attribute W : ScalarValues::Real;',
        '  bind W = V;',
        '  constraint wT { W >= 2.0 }',
        '  part def U { part a : T0; attribute M : ScalarValues::Real default = 1.0; bind a.load = M; }',
        '  part u : U;',
        '  constraint uF { u.a.load == 9.0 }',
        '  constraint uT { u.M <= 5.0 }',
        '}',
      ].join('\n');
    for (const y of [' default = 1.0', ''] as const) {
      const { model: m } = await loadModelText(cap1(y));
      expect(bindingCapOf(m!), y).toBe('segments');
      const Y = named(m!, 'CAP::Y');
      const src = boundSourceIn(m!, 'CAP::Y');
      expect(src && 'abstain' in src && src.abstain, y).toBe('past-cap');
      expect(defaultStandsIn(m!, 'CAP::Y'), y).toBeUndefined();
      expect(boundPartnerSafe(m!, named(m!, 'CAP').id, 'Y', Y.id), y).toBe(false);
      expect(sharedDefinitions(m!).boundAbove(named(m!, 'CAP').id, ['Y']), y).toEqual({ pastCap: 'segments' });
      if (y !== '') expect(defaultGivesWay(m!, Y)).toBe(true);
      const checks = checkConstraints(m!);
      expect(['CAP::yT', 'CAP::yF', 'CAP::negT'].map((r) => resultOf(checks, m!, r)), y).toEqual(['unknown', 'unknown', 'unknown']);
      // Y has a value (its default, or the one the capped binding gives): the cap is why it is not read.
      expect(checks.find((c) => m!.qualifiedName(c.id) === 'CAP::yT')!.message, y).toBe(
        'Could not evaluate: Y is not read in CAP: a binding of this model is read deeper than 32 usages',
      );
      expect(pastCapEnd(m!, Y.id), y).toBe(true);
      // A binding the capped one does not reach reads as before.
      const w = boundSourceIn(m!, 'CAP::W');
      expect(w && !('abstain' in w) && w.via.source, y).toBe('V');
      expect(resultOf(checks, m!, 'CAP::wT'), y).toBe('satisfied');
      // Nor does one that redefines only what the capped binding's end redefines (CAPU2): U's end and T1's
      // both redefine T0's load, which no binding names. Joined through it, U's M and load were held past
      // T1's cap, and the numeric lane solved `u.a.load == 9.0` as a design equation.
      expect(pastCapEnd(m!, named(m!, 'CAP::U::M').id), y).toBe(false);
      const u = boundSourceIn(m!, 'CAP::u::a::load');
      expect(u && 'abstain' in u ? u.abstain : 'read', y).not.toBe('past-cap');
      expect([resultOf(checks, m!, 'CAP::uF'), resultOf(checks, m!, 'CAP::uT')], y).toEqual(['violated', 'satisfied']);
    }
  });

  it('counts only the bindings the user wrote: a model that writes none asks nothing of them', async () => {
    // The full library carries binding connectors of its own (82); the uav ISR example writes none. It
    // stands in here for v9 (planted bug P16), which lives outside the repository: v9 itself is checked
    // structurally at every step (82 library connectors, 0 the user's, `hasUserBindings` false under both
    // libraries — plan D.6).
    const { model: m } = await loadModelText(readFileSync(resolve(process.cwd(), 'examples/uav-isr.sysml'), 'utf8'), {
      library: 'full',
    });
    expect(m!.all().filter((e) => isBindingConnector(e) && e.attrs.isLibrary === true).length).toBeGreaterThan(0);
    expect(hasUserBindings(m!)).toBe(false);
    const { model: b } = await loadModelText(M2, { library: 'full' });
    expect(hasUserBindings(b!)).toBe(true);
  });

  it('reads neither of two values written with `=` a binding joins in a context, and says why (A.5)', async () => {
    // q joins Q's `load = 3.0` to its own L of 50 (a contradiction the binding's own row reports):
    // no name of the body is another feature in q, so the finding names what q reads — neither of the
    // two values written with `=` (A.5, U11: d1plain's shape), and why.
    const { model: m } = await loadModelText(`package LF {
      part def Q { attribute L : ScalarValues::Real default = 1.0; attribute load : ScalarValues::Real = 3.0; bind load = L; constraint c { load <= 5.0 } }
      part q : Q { attribute :>> L = 50.0; }
    }`);
    const c = checkConstraints(m!).find((x) => m!.qualifiedName(x.id) === 'LF::Q::c')!;
    expect(c.instances!.map((i) => [i.context, i.result, i.message])).toEqual([
      [
        'q',
        'unknown',
        'Q::c (load <= 5.0) could not be evaluated for q: "load" cannot be derived: load is not read in LF::q: ' +
          '`bind load = L` of LF::Q joins two values the model states (q.load, q.L), and a binding holds in every ' +
          'instance (see the binding\u2019s own finding)',
      ],
    ]);
    expect(checkConstraints(m!).filter((x) => x.conflict === 'bind').map((x) => x.result)).toEqual(['violated']);
    // A pair only an evaluation compares (q's `L = 2.0 * K`) is evaluated, both where the binding's valued members
    // are read (E6): 50 against 3 differ, so neither is read, as of two values that differ as written — read as
    // before, q's load was 3 and the row a false `satisfied`. The binding's own row judges the pair at the two
    // values as written, and reports it.
    const lf = (k: string) => `package LF {
      part def Q { attribute L : ScalarValues::Real default = 1.0; attribute load : ScalarValues::Real = 3.0; bind load = L; constraint c { load <= 5.0 } }
      part q : Q { attribute K : ScalarValues::Real${k}; attribute :>> L = 2.0 * K; }
    }`;
    const { model: e } = await loadModelText(lf(' = 25.0'));
    const ce = checkConstraints(e!).find((x) => e!.qualifiedName(x.id) === 'LF::Q::c')!;
    expect(ce.instances!.map((i) => [i.context, i.result, i.message])).toEqual([
      [
        'q',
        'unknown',
        'Q::c (load <= 5.0) could not be evaluated for q: "load" cannot be derived: load is not read in LF::q: ' +
          '`bind load = L` of LF::Q joins two values the model states (q.load, q.L), and a binding holds in every ' +
          'instance (see the binding\u2019s own finding)',
      ],
    ]);
    expect(checkConstraints(e!).filter((x) => x.conflict === 'bind').map((x) => [x.ownerId === named(e!, 'LF::q').id, x.result])).toEqual([
      [true, 'violated'],
    ]);
    // Where the two meet (K 1.5: 3 against 3) they are one value, and it is read: a true reading the S2 rule had
    // given up (D1C, bc2-ctx-derived), and no binding row.
    const { model: meets } = await loadModelText(lf(' = 1.5'));
    const cm = checkConstraints(meets!);
    expect(cm.find((x) => meets!.qualifiedName(x.id) === 'LF::Q::c')!.instances!.map((i) => [i.context, i.result])).toEqual([['q', 'satisfied']]);
    expect(cm.filter((x) => x.conflict === 'bind')).toEqual([]);
    // Where the evaluation decides neither (K stated nowhere), neither is read, in a sentence of its own, and the
    // binding's own row reports nothing it cannot judge.
    const { model: open } = await loadModelText(lf(''));
    const co = checkConstraints(open!);
    expect(co.find((x) => open!.qualifiedName(x.id) === 'LF::Q::c')!.instances!.map((i) => [i.context, i.result, i.message])).toEqual([
      [
        'q',
        'unknown',
        'Q::c (load <= 5.0) could not be evaluated for q: "load" cannot be derived: load is not read in LF::q: ' +
          '`bind load = L` of LF::Q joins Q::load = 3.0 to q::L = 2.0 * K, two values written with `=` that are not ' +
          'the same as written, and a binding holds in every instance; whether the two meet there takes an evaluation ' +
          'this tool does not make, so neither is read',
      ],
    ]);
    expect(co.filter((x) => x.conflict === 'bind' && x.result === 'violated')).toEqual([]);
    // The binding's own row reads only its two ends where each is stated: a value it reads through another pair
    // A.5 abstains on (K, which `bind K = M` joins to M's 30) is no value it judges, so SC's `bind load = L` files
    // no row beside `bind K = M`'s own (a newly decided row on a self-contradictory model, before).
    const { model: sc } = await loadModelText(`package SC {
      part def Q {
        attribute K : ScalarValues::Real = 25.0;
        attribute M : ScalarValues::Real = 30.0;
        bind K = M;
        attribute L : ScalarValues::Real = 2.0 * K;
        attribute load : ScalarValues::Real = 60.0;
        bind load = L;
      }
      part q : Q;
    }`);
    expect(checkConstraints(sc!).filter((x) => x.conflict === 'bind').map((x) => [x.expression, x.result])).toEqual([['K == M', 'violated']]);
    // A binding whose end is outside the element that writes it (R's L in q's body, EB4) is read in R, which
    // holds both ends: its own row reports the pair in r2 (no row before per-instance-rest S3). r2's row, read
    // through the package, names no binding it can point at yet.
    const { model: eb } = await loadModelText(`package EB4 {
      part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }
      part def Q { part p : P; }
      part def R { attribute L : ScalarValues::Real default = 5.0; part q : Q { bind p.load = L; } }
      part r2 : R { attribute :>> L = 50.0; part :>> q { part :>> p { attribute :>> load = 3.0; } } }
    }`);
    const ceb = checkConstraints(eb!).find((x) => eb!.qualifiedName(x.id) === 'EB4::P::c')!;
    const r2 = ceb.instances!.find((i) => i.instance === 'EB4::r2::q::p')!;
    expect([r2.result, r2.message.includes('joins two values the model states')]).toEqual(['unknown', true]);
    expect(checkConstraints(eb!).filter((x) => x.conflict === 'bind').map((x) => [eb!.qualifiedName(x.ownerId!), x.result])).toEqual([
      ['EB4::r2', 'violated'],
    ]);
  });

  it('reports a binding violated only where its own two ends state different values with `=` (A.5)', async () => {
    // A.5 reads no value its component joins against a differing one, so the `#bind` row is decided from the
    // binding's own pair, never from the component. BC1C's `bind K = L` joins 30 to 30 and FAN's `bind
    // r.load = L` joins r's default (which gives way) to L: each was reported "different values" beside the
    // binding that states them.
    const P = 'part def P { attribute load : ScalarValues::Real default = 1.0; }';
    for (const [text, expr] of [
      [
        `package BC1C { ${P} part def Q { attribute L : ScalarValues::Real = 30.0; attribute K : ScalarValues::Real = 30.0;
          attribute M : ScalarValues::Real = 50.0; bind K = L; bind L = M; } part q : Q; }`,
        'L == M',
      ],
      [
        `package FAN { ${P} part def Q { attribute L : ScalarValues::Real = 50.0; part p : P; part r : P; bind p.load = L; bind r.load = L; }
          part q : Q { part :>> p { attribute :>> load = 30.0; } } }`,
        'p.load == L',
      ],
    ] as const) {
      const { model: m } = await loadModelText(text);
      const bind = checkConstraints(m!).filter((c) => c.conflict === 'bind');
      expect(bind.map((c) => [c.expression, c.result]), expr).toEqual([[expr, 'violated']]);
      expect(checkConstraintsNumeric(m!).filter((r) => r.conflict === 'bind').map((r) => r.result), expr).toEqual(['violated']);
    }
    // A usage body's binding (h2-bodyspec over d1plain): its ends are implicit copies that state no value of
    // their own, so the pair is what they redefine — q's p.load 30 (Q3's) against L 50. `sysml-check
    // --strict` reported nothing while SMT found the axioms inconsistent.
    const { report } = await loadModelText(
      `package UB2 { ${P} part def Q { attribute L : ScalarValues::Real = 50.0; part p : P; }
        part def Q3 :> Q { part :>> p { attribute :>> load = 30.0; } } part q : Q3 { bind p.load = L; } }`,
      { fileName: 'ub2.sysml', strict: true },
    );
    expect(report.ok).toBe(false);
    expect(report.diagnostics.filter((d) => d.severity === 'warning').map((d) => [d.code, d.message])).toEqual([
      [
        'validation/constraint-violation',
        'Constraint violated: UB2::q binds p.load to L (`bind p.load = L`), and the model states different values for ' +
          'the two there — a binding holds in every instance, as a value written with `=` does, so the model states both values',
      ],
    ]);
  });

  /** R's `L = 2.0 * K`, bound into its q's p by a binding written in q's body (or in a definition nested in R). */
  const enclosed = (pkg: string, nested: boolean, override: boolean) => `package ${pkg} {
    ${P}
    ${nested ? '' : 'part def Q { part p : P; }'}
    part def R {
      attribute K : ScalarValues::Real default = 0.5;
      attribute L : ScalarValues::Real = 2.0 * K;
      ${nested ? 'part def Q { part p : P; bind p.load = L; } part q : Q;' : 'part q : Q { bind p.load = L; }'}
    }
    part r : R${override ? ' { attribute :>> K = 25.0; }' : ';'}
    part r0 : R;
    constraint negT { r.q.p.m2 <= 0.0 }
    constraint ctlA { r0.q.p.m2 >= 8.5 }
  }`;

  it('reads a partner of an enclosing instance in the instance around each reading (W1, W3)', async () => {
    for (const nested of [false, true]) {
      // r's K makes R's L r's 50: r's q's m2 is −40, never the 9 R's own L of 1 gave (a false refutation),
      // and r0's q reads r0's L of 1 (O6 S1, E3: both abstained before).
      const { model: m } = await loadModelText(enclosed('E', nested, true));
      const checks = checkConstraints(m!);
      expect([resultOf(checks, m!, 'E::negT'), resultOf(checks, m!, 'E::ctlA')], String(nested)).toEqual(['satisfied', 'satisfied']);
      // Where every R reads it alike, it is read as before.
      const { model: u } = await loadModelText(enclosed('U', nested, false));
      const alike = checkConstraints(u!);
      expect([resultOf(alike, u!, 'U::negT'), resultOf(alike, u!, 'U::ctlA')], String(nested)).toEqual(['violated', 'satisfied']);
    }
    // A package's own partner is one instance wherever it is read.
    const { model: g } = await loadModelText(`package G {
      ${P}
      attribute K : ScalarValues::Real default = 0.5;
      attribute X : ScalarValues::Real = 2.0 * K;
      part def Q { part p : P; bind p.load = X; }
      part q : Q;
      constraint ctlT { q.p.m2 >= 8.5 }
    }`);
    expect(resultOf(checkConstraints(g!), g!, 'G::ctlT')).toBe('satisfied');
  });

  it('reads no value a binding gives where an end it joins has no instance in a context it holds in', async () => {
    // R's nested Q used outside any R: z's q has no R whose L the binding could mean.
    const { model: m } = await loadModelText(`package X {
      ${P}
      part def R {
        attribute K : ScalarValues::Real default = 0.5;
        attribute L : ScalarValues::Real = 2.0 * K;
        part def Q { part p : P; bind p.load = L; }
      }
      part def S { part z : R::Q; }
      part s : S;
      constraint z1 { s.z.p.m2 >= 8.5 }
    }`);
    expect(bindingCapOf(m!)).toBeUndefined();
    const definitions = sharedDefinitions(m!);
    const z = named(m!, 'X::S::z');
    const above = definitions.boundAbove(z.id, ['p.load']);
    expect(above).toEqual({ pastCap: 'outside' });
    expect(boundAboveSentence(definitions, z.id, above!)).toBe(
      'the relation is read in X::S::z and reads a value a binding joins, and that binding joins a feature outside ' +
        'where it is written that this tool finds no instance of in a context the binding holds in: so it reads no ' +
        'value the binding gives for any one instance, and the relation is not carried',
    );
    expect(resultOf(checkConstraints(m!), m!, 'X::z1')).toBe('unknown');
  });

  it('lists one context for usages that change nothing a bound member reads, and reads each it lists for that alone at its instance', async () => {
    // Q2's K makes Q's asserted L Q2's own 50 — and every `qi : Q2` reads it as Q2 does: one context row,
    // not one per usage (a thousand usages made 2,003 findings), read at Q2's own instance (E7). The binding
    // joins that L to p's load, whose P's `default = 1.0` no assertion replaces (decision 14 amended
    // 2026-10-22, H2f's shape): two values there, 50 and 1, so the row is not read (it read the 50).
    const { model: m } = await loadModelText(
      [
        'package FanA {',
        `  ${P}`,
        '  part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real; assert constraint defL { L == 2.0 * K } part p : P; bind p.load = L; constraint cq { p.load <= 5.0 } }',
        '  part def Q2 :> Q { attribute :>> K = 25.0; }',
        ...Array.from({ length: 200 }, (_, i) => `  part q${i} : Q2;`),
        '}',
      ].join('\n'),
    );
    const definitions = sharedDefinitions(m!);
    const cq = named(m!, 'FanA::Q::cq');
    const Q2 = named(m!, 'FanA::Q2');
    expect(definitions.changingContexts(cq, ['p.load']).map((x) => m!.qualifiedName(x.id))).toEqual(['FanA::Q2']);
    expect(definitions.readsBoundOnly(cq, ['p.load'], Q2.id)).toBe(true);
    const checks = checkConstraints(m!);
    const row = checks.find((c) => c.id === cq.id)!;
    expect(definitions.boundStatedTwiceIn(cq, ['p.load'], Q2.id)).toBe('two-values');
    expect(row.instances!.map((i) => [i.context, i.result])).toEqual([['Q2', 'unknown']]);
    // Four rows as before — and Q2's own report of the pair the binding joins, one row more, not two hundred.
    expect(checks.reduce((n, c) => n + 1 + (c.instances?.length ?? 0), 0)).toBe(5);
    expect(checks.filter((c) => c.conflict === 'bind').map((c) => [m!.qualifiedName(c.ownerId!), c.result])).toEqual([['FanA::Q2', 'violated']]);
    // Usages whose own values sign the member apart are each listed: q's K of 25, q2's of 0.1.
    const { model: t } = await loadModelText(`package M7T {
      part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real = 2.0 * K; attribute load : ScalarValues::Real; bind load = L; constraint c { load <= 5.0 } }
      part q : Q { attribute :>> K = 25.0; }
      part q2 : Q { attribute :>> K = 0.1; }
      part q3 : Q;
    }`);
    const c = checkConstraints(t!).find((x) => t!.qualifiedName(x.id) === 'M7T::Q::c')!;
    expect(c.instances!.map((i) => [i.context, i.result])).toEqual([
      ['q', 'violated'],
      ['q2', 'satisfied'],
    ]);
  });

  it('reads no context listed by a member’s own value alone where the model states a second value of the member there', async () => {
    // load's own `= 1.0` beside the bound `L = 2.0 * K`: q2's load is 1 and 50. Its instance reading reads
    // the 1 alone, a false T; every surface leaves q2's reading undecided, in one sentence. Neither end of the
    // pair is read in q2 (A.5 over a pair only an evaluation compares, E6), so q2's L is not either.
    const { model: m } = await loadModelText(`package M7S {
      part def Q {
        attribute K : ScalarValues::Real default = 0.5;
        attribute L : ScalarValues::Real = 2.0 * K;
        attribute load : ScalarValues::Real = 1.0;
        bind load = L;
        constraint c { load <= 5.0 }
        constraint d { L <= 5.0 }
      }
      part q2 : Q { attribute :>> K = 25.0; }
    }`);
    const definitions = sharedDefinitions(m!);
    const c = named(m!, 'M7S::Q::c');
    const q2 = named(m!, 'M7S::q2');
    expect(definitions.readsBoundOnly(c, ['load'], q2.id)).toBe(true);
    expect(definitions.boundStatedTwiceIn(c, ['load'], q2.id)).toBe('two-values');
    const sentence = boundHereSentence(definitions, q2.id, 'two-values');
    expect(sentence).toBe(
      'the relation is read in M7S::q2, and a binding joins what it reads to a value M7S::q2 reads as its own and to ' +
        'another value the model states there: this tool reads neither of two values, so it is not carried',
    );
    const checks = checkConstraints(m!);
    const rows = (q: string) => checks.find((x) => m!.qualifiedName(x.id) === q)!.instances!.map((i) => [i.context, i.result, i.detail]);
    expect(rows('M7S::Q::c')).toEqual([['q2', 'unknown', `Could not evaluate: ${sentence}`]]);
    expect(rows('M7S::Q::d').map(([ctx, result]) => [ctx, result])).toEqual([['q2', 'unknown']]);
    const goal = obligationsOf(m!).find((o) => o.element.qualifiedName === 'M7S::Q::c in M7S::q2')!;
    expect(goal.encodable).toEqual({ reason: 'unread-definition', detail: sentence });
    const numeric = checkConstraintsNumeric(m!).find((r) => r.id === `${c.id}@${q2.id}`)!;
    expect([numeric.result, numeric.reason]).toEqual(['unknown', sentence]);
  });

  it('reads a context listed by a member’s own value alone at its instance, and as no contradiction (FanS)', async () => {
    // P's default read through QB's end copy (the G340 defect) met Q2's asserted L of 50: Q2's row
    // published p.load = 1 against a load of 50, and every usage of Q2 repeated it. Read at Q2's own
    // instance (E7), p's load is not read: P's `default = 1.0` stands against Q's asserted L (decision 14
    // amended 2026-10-22), so the binding joins two values there, 50 and 1 (it read the binding's 50).
    const { model: m } = await loadModelText(`package FanS {
      ${P}
      part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real; assert constraint defL { L == 2.0 * K } part p : P; }
      part def QB :> Q { bind p.load = L; constraint cq { p.load <= 5.0 } }
      part def Q2 :> QB { attribute :>> K = 25.0; }
      part q0 : Q2;
      part q1 : Q2;
    }`);
    const checks = checkConstraints(m!);
    const cq = checks.find((c) => m!.qualifiedName(c.id) === 'FanS::QB::cq')!;
    expect(cq.instances!.map((i) => [i.context, i.result])).toEqual([['Q2', 'unknown']]);
    // QB's binding reads QB::L, which Q's own assert defines (2.0 * K, 1 in QB itself, where the two meet):
    // the false `#bind` the implicit end copy's missed assert filed in QB is gone, and none is added for q0 or
    // q1. In Q2 the binding reports the pair the model states, the assert's 50 against the default's 1.
    expect(checks.filter((c) => c.conflict === 'bind').map((c) => [m!.qualifiedName(c.ownerId!), c.result])).toEqual([['FanS::Q2', 'violated']]);
  });

  it('expands a shared usage into its generic row and one row per instance (M8, F7)', async () => {
    const { model: m } = await loadModelText(`package M8 {
      part def P { attribute load : ScalarValues::Real default = 3.0; constraint c { load <= 10.0 } }
      part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real = 2.0 * K; part p : P; bind p.load = L; }
      part q : Q { attribute :>> K = 25.0; }
    }`);
    const c = checkConstraints(m!).find((x) => m!.qualifiedName(x.id) === 'M8::P::c')!;
    expect(c.instances!.map((i) => [m!.qualifiedName(i.contextId), i.result, i.instance, i.generic])).toEqual([
      ['M8::Q::p', 'satisfied', undefined, true],
      ['M8::Q::p', 'violated', 'M8::q::p', undefined],
    ]);
  });
});

/*
 * DEFAULTS A BINDING JOINS AGREE AS CONSTANTS, NEVER BY TEXT (plan
 * per-instance-check, step F1b, A.4 Part 0). Two defaults bound to each other
 * with no value beside them stand where they are one value, and give way
 * where they differ (decision 10). They were agreed per SOURCE and by their
 * TEXT: R3a's one `v default = 2.0 * K`, read at a1.v and at a2.v where a2
 * sets K to 5, stood as 2 for a1 and 10 for a2 — every surface decided rows
 * over a value that does not exist, and the check called the binding a
 * contradiction. They are now counted per MEMBER, and agree only as constants
 * compared exactly.
 */
describe('checkConstraints — defaults a binding joins stand only as one constant', () => {
  const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;
  /** Each check of a sweep by qualified name (a conflict row as `<name>#<kind>`), with its result. */
  const results = (m: Model) =>
    checkConstraints(m).map((c) => [`${m.qualifiedName(c.id)}${c.conflict ? `#${c.conflict}` : ''}`, c.result]);
  const R3A = `package R3a {
    part def A { attribute K : ScalarValues::Real default = 1.0; attribute v : ScalarValues::Real default = 2.0 * K; }
    part a1 : A;
    part a2 : A { attribute :>> K = 5.0; }
    bind a1.v = a2.v;
    constraint c1 { a1.v <= 3.0 }
    constraint c3 { a1.v >= 9.0 }
  }`;

  it('holds one default read in two instances: R3a’s `2.0 * K` is 2 in a1 and 10 in a2', async () => {
    const { model: m } = await loadModelText(R3A);
    // Read as both, c1 held at a1's 2 and c3 failed — on the numeric surface too — and the binding
    // was called a contradiction.
    expect(results(m!)).toEqual([
      ['R3a::c1', 'unknown'],
      ['R3a::c3', 'unknown'],
    ]);
    expect(checkConstraintsNumeric(m!).map((r) => [m!.qualifiedName(r.id), r.result])).toEqual([
      ['R3a::c1', 'unknown'],
      ['R3a::c3', 'unknown'],
    ]);
  });

  it('holds two defaults alike in text that read two different Ks (R3b, R3c)', async () => {
    const { model: b } = await loadModelText(`package R3b {
      part def A { attribute K : ScalarValues::Real default = 1.0; attribute v : ScalarValues::Real default = 2.0 * K; }
      part def B { attribute K : ScalarValues::Real default = 5.0; attribute w : ScalarValues::Real default = 2.0 * K; }
      part a : A;
      part b : B;
      bind a.v = b.w;
      constraint c1 { a.v <= 3.0 }
    }`);
    expect(results(b!)).toEqual([['R3b::c1', 'unknown']]);
    const { model: c } = await loadModelText(`package R3c {
      part def P {
        attribute K : ScalarValues::Real default = 1.0;
        attribute load : ScalarValues::Real default = 2.0 * K;
        attribute m2 : ScalarValues::Real = 10.0 - load;
      }
      part def Q {
        attribute K : ScalarValues::Real default = 25.0;
        attribute L : ScalarValues::Real default = 2.0 * K;
        part p : P;
        bind p.load = L;
      }
      part q : Q;
      constraint m2NegT { q.p.m2 <= 0.0 }
    }`);
    // P's 2 and Q's 50: Q's L gives way, and so does the end copy of P's load (q.p.m2 reads none).
    expect(defaultGivesWay(c!, named(c!, 'R3c::Q::L'))).toBe(true);
    expect(results(c!)).toEqual([['R3c::m2NegT', 'unknown']]);
  });

  it('keeps one default standing, an expression too, carried into a feature with nothing of its own', async () => {
    const { model: m } = await loadModelText(`package K1 {
      part def P { attribute K : ScalarValues::Real default = 0.5; attribute load : ScalarValues::Real default = 2.0 * K; }
      part def Q { attribute w : ScalarValues::Real; part p : P; bind w = p.load; constraint c { w <= 2.0 } }
    }`);
    // w is P's 1: the numeric surface reads it (the check reads a bound partner per instance, plan F5).
    expect(checkConstraintsNumeric(m!).map((r) => [m!.qualifiedName(r.id), r.result])).toEqual([['K1::Q::c', 'satisfied']]);
  });

  it('keeps two defaults standing where they are one constant exactly, and holds them where they differ', async () => {
    const two = (load: string, L: string, unit: string) => `package D2 {
      part def P { attribute load : ${unit} default = ${load}; }
      part def Q { attribute L : ${unit} default = ${L}; part p : P; bind p.load = L; constraint c { L == p.load } }
    }`;
    for (const [load, L, unit, gives] of [
      ['1.0', '1.0', 'ScalarValues::Real', false],
      ['1.0', '2.0 * 0.5', 'ScalarValues::Real', false],
      ['1000.0 [SI::g]', '1.0 [SI::kg]', 'ISQ::MassValue', false],
      // k4: two values, neither stated — no value.
      ['1.0', '2.0', 'ScalarValues::Real', true],
      // A bare number and a quantity are not compared by reading them.
      ['1.0', '1.0 [SI::kg]', 'ISQ::MassValue', true],
    ] as const) {
      const { model: m } = await loadModelText(two(load, L, unit));
      expect(defaultGivesWay(m!, named(m!, 'D2::Q::L')), `${load} vs ${L}`).toBe(gives);
      expect(results(m!), `${load} vs ${L}`).toEqual([['D2::Q::c', gives ? 'unknown' : 'satisfied']]);
    }
    const { model: t } = await loadModelText(`package DB {
      part def P { attribute on : ScalarValues::Boolean default = true; }
      part def Q { attribute flag : ScalarValues::Boolean default = true; part p : P; bind p.on = flag; }
    }`);
    expect(defaultGivesWay(t!, named(t!, 'DB::Q::flag'))).toBe(false);
  });

  it('reads no asserted value into two defaults a binding joins, which give way to each other (GA6)', async () => {
    // GA6: every P asserts load = 7 beside its `default = 7.0`, every Q asserts L = 5 beside its `default = 5.0`,
    // and Q binds p.load = L, in its definition (GA6), in a usage's body (GA12) or between two instances whose
    // one default `2.0 * K` reads 3 and 4 (GA5B, each asserting its own). While an asserted equation replaced a
    // default, each end read its assert's value, and the binding reported the two. No assertion replaces a
    // default since decision 14 was amended (2026-10-22): the two defaults differ, so they give way to each
    // other (A.9 `defaults-differ`) and the bound ends read no value — never the asserts' 7 and 5, which the
    // check read past the binding as "defines L = 5" — and no pair is reported where no value is read.
    const P = 'part def P { attribute load : ScalarValues::Real default = 7.0; assert constraint pa { load == 7.0 } }';
    const L = 'attribute L : ScalarValues::Real default = 5.0; assert constraint qa { L == 5.0 } part p : P;';
    for (const [text, holder] of [
      [`package GA6 { ${P} part def Q { ${L} bind p.load = L; } part q : Q; }`, 'GA6::Q'],
      [`package GA12 { ${P} part def Q { ${L} } part q : Q { bind p.load = L; } }`, 'GA12::q'],
      [
        `package GA5B {
          part def A { attribute K : ScalarValues::Real default = 1.0; attribute v : ScalarValues::Real default = 2.0 * K; }
          part a1 : A { attribute :>> K = 1.5; assert constraint x1 { v == 3.0 } }
          part a2 : A { attribute :>> K = 2.0; assert constraint x2 { v == 4.0 } }
          bind a1.v = a2.v;
        }`,
        'GA5B',
      ],
    ] as const) {
      const { model: m } = await loadModelText(text);
      const checks = checkConstraints(m!);
      expect(checks.filter((c) => c.conflict === 'bind'), holder).toEqual([]);
      expect(checkConstraintsNumeric(m!).filter((r) => r.conflict === 'bind'), holder).toEqual([]);
      // Each assert over a bound end reads no value; no check says "defines" of a feature that writes a default.
      const bound = ({ 'GA6::Q': ['GA6::Q::qa'], 'GA12::q': [], GA5B: ['GA5B::a1::x1', 'GA5B::a2::x2'] } as Record<string, readonly string[]>)[holder]!;
      expect(checks.filter((c) => bound.includes(m!.qualifiedName(c.id))).map((c) => c.result), holder).toEqual(bound.map(() => 'unknown'));
      expect(checks.filter((c) => c.message.includes('defines')), holder).toEqual([]);
      expect(solveFeasible(m!).decided, holder).toBe(false);
    }
    // F5 names the defaults that differ (A.9 `defaults-differ`), not "declared without one".
    const { model: r } = await loadModelText(R3A);
    expect(checkConstraints(r!).find((c) => r!.qualifiedName(c.id) === 'R3a::c1')!.message).toMatch(
      /^Could not evaluate: v has no value in R3a::a1: .*defaults that differ or are not constants/,
    );
  });
});

/*
 * H5 (plan J decision 14, close-open-items O5 S1–S2) made an asserted EQUATION that defines a feature stand
 * over its `default`, as a binding does (decision 10). Decision 14 was amended by the maintainer on
 * 2026-10-22 (the soft/hard defaults analysis, Q1 = a): a `default` stands against every assertion, as a
 * value written with `=` does, and the assert is reported violated; an asserted equation defines only a
 * feature WITHOUT a value. F's invariants (a)–(i), the ones S1 and S2 reach, one test each, now pin that.
 */
describe('checkConstraints — a default stands against an asserted equation (decision 14 amended)', () => {
  const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;
  const verdicts = (m: Model) => checkConstraints(m).map((c) => [m.qualifiedName(c.id), c.result]);
  const numeric = (m: Model) => checkConstraintsNumeric(m).map((r) => [m.qualifiedName(r.id), r.result]);
  const axioms = (m: Model) => obligationsOf(m).filter((o) => o.role === 'axiom').map((o) => o.element.qualifiedName);
  const HL = `package HL {
    attribute L : ScalarValues::Real default = 2.0;
    assert constraint qa { L == 5.0 }
    constraint c { L <= 3.0 }
  }`;

  it('reads the default, not the asserted value, on every surface, through one predicate family (HL, HD; c)', async () => {
    const { model: m } = await loadModelText(HL);
    const L = named(m!, 'HL::L');
    // (c) One predicate family decides it, for every surface: the default gives way nowhere (it gave way
    // everywhere, and `qa` read *defines L = 5*, `c` violated).
    expect([defaultGivesWay(m!, L), defaultGivesWayIn(m!, L, 'HL::L'), defaultGivesWaySomewhere(m!, L)]).toEqual([false, false, false]);
    expect(verdicts(m!)).toEqual([
      ['HL::qa', 'violated'],
      ['HL::c', 'satisfied'],
    ]);
    expect(numeric(m!)).toEqual([
      ['HL::qa', 'violated'],
      ['HL::c', 'satisfied'],
    ]);
    // The SMT lane files L's value axiom beside the assert, as for `L = 2.0` (HP): the two contradict.
    expect(axioms(m!)).toEqual(expect.arrayContaining(['HL::L', 'HL::qa']));
    const { model: d } = await loadModelText(`package HD {
      part def Q { attribute L : ScalarValues::Real default = 2.0; assert constraint qa { L == 5.0 } constraint c { L <= 3.0 } }
      part q : Q;
      constraint top { q.L <= 3.0 }
    }`);
    expect(verdicts(d!)).toEqual([
      ['HD::Q::qa', 'violated'],
      ['HD::Q::c', 'satisfied'],
      ['HD::top', 'satisfied'],
    ]);
  });

  it('reads a `default` as it reads a value written with `=`, whatever the assert (a, U5)', async () => {
    // (a) A plain `=` against the assert is the strict-KerML contradiction (HP): the value stands, the assert fails.
    const { model: p } = await loadModelText(HL.replace('HL', 'HP').replace('default = 2.0', '= 2.0'));
    expect(verdicts(p!)).toEqual([
      ['HP::qa', 'violated'],
      ['HP::c', 'satisfied'],
    ]);
    expect(axioms(p!)).toContain('HP::L');
    // U5: an inequality defines nothing. The default stands and the assert is checked against it.
    const { model: u } = await loadModelText(HL.replace('HL', 'U5').replace('L == 5.0', 'L >= 5.0'));
    expect(defaultGivesWay(u!, named(u!, 'U5::L'))).toBe(false);
    expect(verdicts(u!)).toEqual([
      ['U5::qa', 'violated'],
      ['U5::c', 'satisfied'],
    ]);
  });

  it('leaves the names a local assert fixes to the caller, deriving nothing in a body’s own scope (b)', async () => {
    // A feature WITHOUT a value, which the asserted equation defines (decision 14 keeps those): the body's own
    // unit-aware scope reads no value for L; the check binds it from the equation.
    const { model: m } = await loadModelText(HL.replace('HL', 'HN').replace(' default = 2.0', ''));
    const c = named(m!, 'HN::c');
    expect(evaluateConstraintQuantityDetailed(m!, c).verdict).toBe('unknown');
    expect(checkConstraints(m!).find((k) => k.id === c.id)!.result).toBe('violated');
    // Over a `default`, the body's own scope reads the default, which no equation replaces.
    const { model: d } = await loadModelText(HL);
    expect(evaluateConstraintQuantityDetailed(d!, named(d!, 'HL::c')).verdict).toBe('satisfied');
  });

  it('says why a violated assert left a default standing, and how to write the value it meant to give', async () => {
    // The analysis's `mass` shape: `check` printed nothing (the assert gave mass 0.8) and `lim` passed.
    const { model: m } = await loadModelText(`package MASS {
      part def Battery {
        attribute mass : ScalarValues::Real default = 1.2;
        attribute cells : ScalarValues::Real = 4.0;
        assert constraint massSum { mass == 0.2 * cells }
        constraint lim { mass <= 1.0 }
      }
    }`);
    const message = (model: Model, q: string) => checkConstraints(model).find((c) => model.qualifiedName(c.id) === q)!.message;
    expect(message(m!, 'MASS::Battery::massSum')).toBe(
      "Constraint violated: mass == 0.2 * cells — Battery::mass's `default = 1.2` is not changed by an assertion: write the " +
        'analysis as the value (`:>> mass = …`) to replace it',
    );
    expect(message(m!, 'MASS::Battery::lim')).toBe('Constraint violated: mass <= 1.0');
    // Not over a value written with `=`, nor a `default` a binding gives another value (it is not the value
    // read), nor where the assert holds: none of them is a default an assertion was taken to change.
    for (const [text, rel, said] of [
      ['package E { attribute mass : ScalarValues::Real = 1.2; assert constraint a { mass == 0.8 } }', 'E::a', 'Constraint violated: mass == 0.8'],
      [
        'package B { attribute mass : ScalarValues::Real default = 1.2; attribute m : ScalarValues::Real = 0.8; bind mass = m; assert constraint a { mass == 0.5 } }',
        'B::a',
        'Constraint violated: mass == 0.5',
      ],
      ['package H { attribute mass : ScalarValues::Real default = 1.2; assert constraint a { mass >= 1.0 } }', 'H::a', 'Constraint satisfied'],
      // Nor over an inequality, which never defined a default (U5): naming the requirement's limit, or the design
      // value, as the thing to rewrite would tell an agent to silence a real violation.
      [
        'package Z { attribute mass : ScalarValues::Real = 2.0; attribute limit : ScalarValues::Real default = 1.0; assert constraint a { mass <= limit } }',
        'Z::a',
        'Constraint violated: mass <= limit',
      ],
      ['package C { attribute mass : ScalarValues::Real default = 1.2; assert constraint a { mass <= 1.0 } }', 'C::a', 'Constraint violated: mass <= 1.0'],
      // Nor over a default the equation only reads, on its other side, nor two defaults it sets equal (U7).
      [
        'package K { attribute cells : ScalarValues::Real default = 4.0; attribute mass : ScalarValues::Real = 3.0; assert constraint a { mass == 0.2 * cells } }',
        'K::a',
        'Constraint violated: mass == 0.2 * cells',
      ],
      [
        'package U { attribute L : ScalarValues::Real default = 2.0; attribute M : ScalarValues::Real default = 3.0; assert constraint a { L == M } }',
        'U::a',
        'Constraint violated: L == M',
      ],
    ] as const) {
      const { model: x } = await loadModelText(text);
      expect(message(x!, rel), rel).toBe(said);
    }
    // A dotted name, written in an instance, says where the value goes: a bare `:>> x` there names no feature of q1's.
    const { model: d } = await loadModelText(`package DT {
      part def P { attribute x : ScalarValues::Real default = 2.0; }
      part def Q { part p : P; }
      part q1 : Q { assert constraint tie { p.x == 50.0 } }
    }`);
    expect(message(d!, 'DT::q1::tie')).toBe(
      "Constraint violated: p.x == 50.0 — P::x's `default = 2.0` is not changed by an assertion: write the analysis as the " +
        'value (`part :>> p { attribute :>> x = …; }` in DT::q1) to replace it',
    );
  });

  it('defines a side with no value from the other, and checks two values against each other (e, U7)', async () => {
    // M has no value: the equation defines M from L's default, which stands.
    const { model: o } = await loadModelText(`package OR {
      attribute L : ScalarValues::Real default = 2.0;
      attribute M : ScalarValues::Real;
      assert constraint eq { L == M }
      constraint c { M <= 2.5 }
    }`);
    expect(defaultGivesWay(o!, named(o!, 'OR::L'))).toBe(false);
    expect(verdicts(o!)).toEqual([
      ['OR::eq', 'satisfied'],
      ['OR::c', 'satisfied'],
    ]);
    // Two defaults set equal (U7, the local form of Q4's `p.x == L`): both stand, and the equation is checked
    // against the two (neither was read, `c` could not be evaluated).
    const { model: q } = await loadModelText(`package Q4L {
      attribute L : ScalarValues::Real default = 2.0;
      attribute K : ScalarValues::Real default = 3.0;
      assert constraint eq { L == K }
      constraint c { L <= 2.5 }
    }`);
    expect([defaultGivesWay(q!, named(q!, 'Q4L::L')), defaultGivesWay(q!, named(q!, 'Q4L::K'))]).toEqual([false, false]);
    expect(verdicts(q!)).toEqual([
      ['Q4L::eq', 'violated'],
      ['Q4L::c', 'satisfied'],
    ]);
    // So through a chain, of the inherited default the chain ends at (RH2's p.L, T's `L == M`): p's L is T's 2.
    const { model: rh } = await loadModelText(`package RH2 {
      part def T { attribute L : ScalarValues::Real default = 2.0; attribute M : ScalarValues::Real default = 5.0; assert constraint qa { L == M } }
      part def P :> T { attribute :>> M default = L * 2.0; constraint c { L <= 1.0 } }
      part p : P;
      constraint top { p.L <= 1.0 }
    }`);
    expect(checkConstraints(rh!).find((k) => rh!.qualifiedName(k.id) === 'RH2::top')!.result).toBe('violated');
    // …and T's own equation read in P, of both its sides: 2 against P's M of 4.
    const inP = checkConstraints(rh!).find((k) => rh!.qualifiedName(k.id) === 'RH2::T::qa')!.instances!.find((i) => i.context === 'P')!;
    expect([inP.result, inP.message]).toEqual(['violated', 'P::M = 4 misses T::qa (L == M)']);
    // A default a BINDING holds, in a model with no assert (BW4, BW5): the chain names the binding, never an
    // asserted equation the model does not have ("which gives way to an asserted equation" it said).
    for (const [pkg, rel, body] of [
      ['BW4', 'BW4::top', 'part q : Q; constraint top { q.p.load <= 3.0 }'],
      ['BW5', 'BW5::Q::c', 'part q : Q;'],
    ] as const) {
      const { model: bw } = await loadModelText(`package ${pkg} {
        part def P { attribute load : ScalarValues::Real default = 2.0; }
        part def Q {
          attribute K : ScalarValues::Real; attribute L : ScalarValues::Real = 2.0 * K; part p : P; bind p.load = L;
          ${pkg === 'BW5' ? 'constraint c { p.load <= 3.0 }' : ''}
        }
        ${body}
      }`);
      const message = checkConstraints(bw!).find((k) => bw!.qualifiedName(k.id) === rel)!.message;
      expect(message, pkg).toContain(`p::load states \`default = 2.0\`, which gives way to ${pkg}::Q's \`bind p.load = L\``);
      expect(message, pkg).not.toMatch(/asserted/);
    }
    expect(checkConstraintsNumeric(q!).find((r) => r.name === 'c')!.result).toBe('satisfied');
    // A side that reads the feature itself gives it no value of its own, nor does one over a default: every
    // default stands (L's 2 gave way to `2.0 * K`, 3, and `c` was violated).
    const { model: x } = await loadModelText(`package EX {
      attribute K : ScalarValues::Real default = 1.5;
      attribute L : ScalarValues::Real default = 2.0;
      attribute N : ScalarValues::Real default = 1.0;
      assert constraint eq { L == 2.0 * K }
      assert constraint self { N == N * 2.0 }
      constraint c { L <= 2.5 }
    }`);
    expect([defaultGivesWay(x!, named(x!, 'EX::L')), defaultGivesWay(x!, named(x!, 'EX::K')), defaultGivesWay(x!, named(x!, 'EX::N'))]).toEqual([
      false,
      false,
      false,
    ]);
    expect(verdicts(x!)).toEqual([
      ['EX::eq', 'violated'],
      ['EX::self', 'violated'],
      ['EX::c', 'satisfied'],
    ]);
    // Nor one that reads it back through the values it reads in turn: M = K * 2.0 with K = L (IND). The
    // default stands, and the assert is reported violated against it.
    const { model: i } = await loadModelText(`package IND {
      attribute L : ScalarValues::Real default = 2.0;
      attribute K : ScalarValues::Real = L;
      attribute M : ScalarValues::Real = K * 2.0;
      assert constraint qa { L == M }
      constraint c { L <= 1.0 }
    }`);
    expect(defaultGivesWay(i!, named(i!, 'IND::L'))).toBe(false);
    expect(verdicts(i!)).toEqual([
      ['IND::qa', 'violated'],
      ['IND::c', 'violated'],
    ]);
  });

  it('reads neither an element’s asserted equation nor the plain value a binding joins it to (RBL2)', async () => {
    // p's own `x == 3.0` defines x; q's `bind p.x = L` joins it to q's plain `L = 4.0`. The check read the 3,
    // the numeric surface the binding's 4: `top` was T on the one and F on the other. The model states both.
    const { model: m } = await loadModelText(`package RBL2 {
      part def P { attribute x : ScalarValues::Real; constraint c { x <= 3.5 } }
      part q { part p : P { assert constraint tie { x == 3.0 } } attribute L : ScalarValues::Real = 4.0; bind p.x = L; }
      constraint top { q.p.x <= 3.5 }
    }`);
    const checks = checkConstraints(m!);
    const sentence =
      "x is not read in RBL2::q::p: RBL2::q::p's asserted `x == 3.0` defines it, and `bind p.x = L` of RBL2::q " +
      'joins it to q::L = 4.0, a value written with `=` that differs from the one the equation gives it there: a ' +
      'binding holds in every instance, so the model states two values for it, and it is not read (see the ' +
      'binding\u2019s own finding)';
    const row = (q: string) => checks.find((c) => m!.qualifiedName(c.id) === q)!;
    expect([row('RBL2::top').result, row('RBL2::top').message]).toEqual(['unknown', `Could not evaluate: ${sentence}`]);
    expect([row('RBL2::q::p::tie').result, row('RBL2::q::p::tie').message]).toEqual(['unknown', `Could not evaluate: ${sentence}`]);
    expect(row('RBL2::P::c').instances!.map((i) => [i.context, i.result])).toEqual([['p', 'unknown']]);
    // The binding's own row reports the pair, judged at the two values as written.
    expect(checks.filter((c) => c.conflict === 'bind').map((c) => c.result)).toEqual(['violated']);
    // So with L a `default`, which no assertion replaces (decision 14 amended 2026-10-22): it stands as `L = 4.0`
    // does, and the pair reads as RBL2's (the default gave way, and the equation's 3 was read, top T).
    const { model: d } = await loadModelText(`package RBL3 {
      part def P { attribute x : ScalarValues::Real; constraint c { x <= 3.5 } }
      part q { part p : P { assert constraint tie { x == 3.0 } } attribute L : ScalarValues::Real default = 4.0; bind p.x = L; }
      constraint top { q.p.x <= 3.5 }
    }`);
    const rbl3 = checkConstraints(d!);
    expect(rbl3.find((c) => d!.qualifiedName(c.id) === 'RBL3::top')!.message).toBe(
      "Could not evaluate: x is not read in RBL3::q::p: RBL3::q::p's asserted `x == 3.0` defines it, and `bind p.x = L` " +
        "of RBL3::q joins it to q::L's `default = 4.0`, a value no assertion replaces (as one written with `=`) that " +
        'differs from the one the equation gives it there: a binding holds in every instance, so the model states two ' +
        'values for it, and it is not read (see the binding\u2019s own finding)',
    );
    expect(rbl3.filter((c) => c.conflict === 'bind').map((c) => c.result)).toEqual(['violated']);
    // Where the equation gives x the value bound to it — evaluated, `y * 2.0` at y 1.5 against q's `L = 3.0` —
    // the two are one value, and it is read (RY3, RY4): giving them up let `lim`'s true violation through
    // `sysml-check --strict`.
    const ry = (lim: string) => `package RY {
      part def P { attribute x : ScalarValues::Real; attribute y : ScalarValues::Real = 1.5; }
      part q { part p : P { assert constraint tie { x == y * 2.0 } } attribute L : ScalarValues::Real = 3.0; bind p.x = L; }
      constraint lim { q.p.x <= ${lim} }
    }`;
    for (const [lim, result] of [
      ['2.5', 'violated'],
      ['3.5', 'satisfied'],
    ] as const) {
      const { model: y } = await loadModelText(ry(lim));
      const cy = checkConstraints(y!);
      expect(cy.find((c) => y!.qualifiedName(c.id) === 'RY::lim')!.result, lim).toBe(result);
      expect(cy.filter((c) => c.conflict === 'bind'), lim).toEqual([]);
    }
    // An equation P writes, read through `q.p.x` (RBB), and one written in an instance's own redefinition of p
    // (RBL4: q1's `part :>> p { assert … }` under Q's binding) are read at q's and q1's p, where they meet the
    // binding's 4: neither is read there, as p's own is not — where q's chain read P's 3 beside an abstention
    // of P's `tie` in q's p, and q1's chain the 3 against the numeric surface's 4.
    const { model: rbb } = await loadModelText(`package RBB {
      part def P { attribute x : ScalarValues::Real; assert constraint tie { x == 3.0 } }
      part q { part p : P; attribute L : ScalarValues::Real = 4.0; bind p.x = L; }
      part def Q { part p : P; attribute L : ScalarValues::Real = 4.0; bind p.x = L; constraint dc { p.x <= 3.5 } }
      part qq : Q;
      constraint top { q.p.x <= 3.5 }
      constraint topq { qq.p.x <= 3.5 }
    }`);
    const cb = checkConstraints(rbb!);
    for (const r of ['RBB::top', 'RBB::topq', 'RBB::Q::dc']) {
      expect(cb.find((c) => rbb!.qualifiedName(c.id) === r)!.message, r).toMatch(/^Could not evaluate: x is not read in RBB::(q|qq|Q)::p: RBB::P's asserted/);
    }
    const { model: rbl4 } = await loadModelText(`package RBL4 {
      part def P { attribute x : ScalarValues::Real; }
      part def Q { part p : P; attribute L : ScalarValues::Real = 4.0; bind p.x = L; }
      part q1 : Q { part :>> p { assert constraint tie { x == 3.0 } } }
      constraint t1 { q1.p.x <= 3.5 }
    }`);
    expect(checkConstraints(rbl4!).find((c) => rbl4!.qualifiedName(c.id) === 'RBL4::t1')!.message).toMatch(
      /^Could not evaluate: x is not read in RBL4::q1::p: RBL4::q1::p's asserted `x == 3\.0` defines it/,
    );
  });

  it('checks an inherited assert against a redefinition’s default, in a usage and in a specialisation (f, HR)', async () => {
    const { model: m } = await loadModelText(`package HR {
      part def Q { attribute L : ScalarValues::Real default = 2.0; assert constraint qa { L == 5.0 } }
      part q : Q { attribute :>> L default = 9.0; }
      part def Q2 :> Q { attribute :>> L default = 7.0; }
      part q2 : Q2;
      constraint top { q.L <= 6.0 }
      constraint top2 { q2.L <= 6.0 }
    }`);
    // The unnamed redefinitions, by their effective names.
    const redef = (owner: string) => m!.all().find((e) => e.attrs.defaultValue === true && m!.qualifiedName(e.ownerId!) === owner)!;
    // q's 9 and Q2's 7 stand (they gave way to Q's assert, 5): each is read, and the assert is violated there.
    expect([redef('HR::q'), redef('HR::Q2')].map((f) => defaultGivesWay(m!, f))).toEqual([false, false]);
    const v = new Map(verdicts(m!) as Array<[string, string]>);
    expect([v.get('HR::top'), v.get('HR::top2')]).toEqual(['violated', 'violated']);
    const qa = checkConstraints(m!).find((c) => m!.qualifiedName(c.id) === 'HR::Q::qa')!;
    expect(qa.instances!.map((i) => [i.context, i.result])).toEqual([
      ['q', 'violated'],
      ['Q2', 'violated'],
    ]);
  });

  it('leaves an assert of an enclosing context to the per-instance reading (d: the local rule only)', async () => {
    // q1's `p.x == 50.0` is written outside x's owner and its types: P's default is not held by it here.
    const { model: m } = await loadModelText(`package HE {
      part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 10.0 } }
      part def Q { part p : P; }
      part q1 : Q { assert constraint tie { p.x == 50.0 } }
    }`);
    const x = named(m!, 'HE::P::x');
    expect([defaultGivesWay(m!, x), defaultGivesWaySomewhere(m!, x)]).toEqual([false, false]);
  });

  it('decides no new row on a model whose asserts contradict themselves (h)', async () => {
    // The rows a body-scope derivation for asserted names once decided there (F's §2.4) stay undecided.
    for (const [text, rows] of [
      [
        `package N2 { attribute x; attribute y; assert constraint a1 { x == 1.0 } assert constraint a2 { x == 2.0 }
          constraint c { y == x + 1.0 } constraint lim { x >= 5.0 } }`,
        ['a1', 'a2', 'lim'],
      ],
      [
        `package R8 {
          part def P { attribute load : ScalarValues::Real; attribute m2 : ScalarValues::Real = 10.0 - load; assert constraint dl { load == 1.0 } }
          part p : P { attribute :>> load; assert constraint d50 { load == 50.0 } }
          constraint pLoad { p.load >= 10.0 }
          constraint pM2 { p.m2 >= 0.0 }
        }`,
        ['d50'],
      ],
      [
        `package GA5B {
          part def A { attribute K : ScalarValues::Real default = 1.0; attribute v : ScalarValues::Real default = 2.0 * K; }
          part a1 : A { attribute :>> K = 1.5; assert constraint x1 { v == 3.0 } }
          part a2 : A { attribute :>> K = 2.0; assert constraint x2 { v == 4.0 } }
          bind a1.v = a2.v;
        }`,
        ['x1', 'x2'],
      ],
      [
        // GA6's Q's `qa` too: Q binds its L to its p's load, two defaults that differ, so neither is read — and
        // since decision 14 was amended no assert reads its value into either. P's own `pa` is no such row: P's
        // `load default = 7.0` stands in P's own instance, where nothing binds it, and the assert holds there.
        `package GA6 {
          part def P { attribute load : ScalarValues::Real default = 7.0; assert constraint pa { load == 7.0 } }
          part def Q { attribute L : ScalarValues::Real default = 5.0; assert constraint qa { L == 5.0 } part p : P; bind p.load = L; }
          part q : Q;
        }`,
        ['qa'],
      ],
    ] as const) {
      const { model: m } = await loadModelText(text);
      const got = checkConstraintsNumeric(m!).filter((r) => (rows as readonly string[]).includes(r.name) && !r.id.includes('@'));
      expect(got.map((r) => [r.name, r.result])).toEqual(rows.map((r) => [r, 'unknown']));
    }
  });

  it('works the index out once per revision, and again after an edit (i)', async () => {
    // The one assert that still holds a default is typed by an equation's definition, which no surface reads
    // (an untyped one holds none since decision 14 was amended): L is read nowhere while Eq holds an equation.
    const { model: m } = await loadModelText(`package HT {
      constraint def Eq { in x : ScalarValues::Real; x == 5.0 }
      attribute L : ScalarValues::Real default = 2.0;
      assert constraint qa : Eq { in x = L; }
      constraint c { L <= 3.0 }
    }`);
    const L = named(m!, 'HT::L');
    expect(defaultGivesWay(m!, L)).toBe(true);
    expect(checkConstraints(m!).find((k) => m!.qualifiedName(k.id) === 'HT::c')!.result).toBe('unknown');
    m!.setAttrs(named(m!, 'HT::Eq').id, { expression: 'x >= 5.0' });
    expect(defaultGivesWay(m!, L)).toBe(false);
    expect(checkConstraints(m!).find((k) => m!.qualifiedName(k.id) === 'HT::c')!.result).toBe('satisfied');
  });

  it('reads a valueless feature an enclosing assert defines by its dotted path (S2: B1, B3, with units)', async () => {
    const { model: m } = await loadModelText(`package B1 {
      part def P { attribute x : ScalarValues::Real; attribute y : ScalarValues::Real = x * 2.0; }
      part p : P;
      assert constraint px { p.x == 3.0 }
      constraint g1 { p.y == 6.0 }
      constraint gF { p.y == 7.0 }
    }`);
    expect(verdicts(m!)).toEqual([
      ['B1::px', 'satisfied'],
      ['B1::g1', 'satisfied'],
      ['B1::gF', 'violated'],
    ]);
    const { model: k } = await loadModelText(`package DKU {
      part def P { attribute x : ISQ::MassValue; attribute y : ISQ::MassValue = x * 2.0; }
      part p : P { constraint k { x <= 5.0 [kg] } }
      assert constraint px { p.x == 3.0 [kg] }
      constraint z { p.y <= 7.0 [kg] }
    }`);
    expect(verdicts(k!)).toEqual([
      ['DKU::p::k', 'satisfied'],
      ['DKU::px', 'satisfied'],
      ['DKU::z', 'satisfied'],
    ]);
    // Not one over a name: in a definition it is another value in each instance (S5's `p.x == L`, read per
    // instance by the enclosing rule), and the generic reading reads none.
    const { model: s } = await loadModelText(`package S4 {
      part def P { attribute x : ScalarValues::Real; constraint c { x <= 10.0 } }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; assert constraint tie { p.x == L } }
      part q1 : Q { attribute :>> L = 50.0; }
      constraint top { q1.p.x <= 10.0 }
    }`);
    expect(sharedDefinitions(s!).reachingAssert(named(s!, 'S4::Q::p').id, 'x')).toBeUndefined();
    expect(checkConstraints(s!).find((c) => s!.qualifiedName(c.id) === 'S4::top')!.result).toBe('unknown');
    // Nor a feature a binding joins (RB: the end copy `bind p.x = L` makes reads L's 4), nor a part a binding
    // equates with another (PV: q's r is s, whose x is 4), nor one two asserts give two values (TWO).
    const { model: b } = await loadModelText(`package RB {
      part def P { attribute x : ScalarValues::Real; }
      part q { part p : P; attribute L : ScalarValues::Real = 4.0; bind p.x = L; }
      assert constraint tie { q.p.x == 3.0 }
      constraint top { q.p.x <= 3.5 }
    }`);
    expect(sharedDefinitions(b!).reachingAssert(named(b!, 'RB::q::p').id, 'x')).toBeUndefined();
    expect(verdicts(b!)).toEqual([
      ['RB::tie', 'violated'],
      ['RB::top', 'violated'],
    ]);
    const { model: v } = await loadModelText(`package PV {
      part def P { attribute x : ScalarValues::Real; }
      part s : P { attribute :>> x = 4.0; }
      part q { part r : P; bind r = s; }
      assert constraint tie { q.r.x == 3.0 }
      constraint top { q.r.x <= 3.5 }
    }`);
    expect(sharedDefinitions(v!).reachingAssert(named(v!, 'PV::q::r').id, 'x')).toBeUndefined();
    expect(checkConstraints(v!).find((c) => v!.qualifiedName(c.id) === 'PV::top')!.result).toBe('unknown');
    const { model: t } = await loadModelText(`package TWO {
      part def P { attribute x : ScalarValues::Real; }
      part p : P;
      assert constraint a1 { p.x == 3.0 }
      assert constraint a2 { p.x == 4.0 }
      constraint top { p.x <= 3.5 }
    }`);
    expect(sharedDefinitions(t!).reachingAssert(named(t!, 'TWO::p').id, 'x')).toBeUndefined();
    expect(verdicts(t!)).toEqual([
      ['TWO::a1', 'unknown'],
      ['TWO::a2', 'unknown'],
      ['TWO::top', 'unknown'],
    ]);
  });
});

/*
 * H5's enclosing rule (plan J decision 14, close-open-items O5 S3, F's §2.6) made an asserted equation written
 * in an instance around a defaulted feature — or in the package, or in the instance's type — define the
 * feature in that instance alone. Since decision 14 was amended (2026-10-22) no assertion replaces a
 * `default`: the default stands in every instance, nothing splits one off, and the assert is checked against
 * the default, as against a value written with `=`. F's invariants (d) and (g), and O2's inputs to the step.
 */
describe('checkConstraints — an enclosing assert is checked against a default in its instance (decision 14 amended)', () => {
  const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;
  const rows = (m: Model, rel: string) => {
    const c = checkConstraints(m).find((k) => m.qualifiedName(k.id) === rel)!;
    return [`own ${c.result}`, ...(c.instances ?? []).map((i) => `${i.instance ?? (i.generic ? 'generic' : m.qualifiedName(i.contextId))} ${i.result}`)];
  };
  const numeric = (m: Model) => new Map(checkConstraintsNumeric(m).map((r) => [r.id.includes('@') ? r.id.split('@')[1]! : m.qualifiedName(r.id), r.result]));
  const HE = `package HE {
    part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 10.0 } }
    part def Q { part p : P; }
    part q1 : Q { assert constraint tie { p.x == 50.0 } }
    part q2 : Q;
    constraint top { q1.p.x <= 10.0 }
  }`;

  it('splits no instance, and checks the assert against the default, on every surface (d, HE)', async () => {
    const { model: m } = await loadModelText(HE);
    const x = named(m!, 'HE::P::x');
    // One predicate family: the default gives way nowhere (it gave way at q1's p, which read 50).
    expect([defaultGivesWay(m!, x), defaultGivesWaySomewhere(m!, x), assertHeldInSome(m!, x)]).toEqual([false, false, false]);
    expect(['HE::q1::p', 'HE::q2::p', 'HE::Q::p', 'HE::P'].map((i) => defaultGivesWayIn(m!, x, i))).toEqual([false, false, false, false]);
    expect(rows(m!, 'HE::P::c')).toEqual(['own satisfied']);
    expect(rows(m!, 'HE::top')).toEqual(['own satisfied']);
    expect(rows(m!, 'HE::q1::tie')).toEqual(['own violated']);
    const n = numeric(m!);
    expect([n.get('HE::P::c'), n.get('HE::q1::p'), n.get('HE::top')]).toEqual(['satisfied', undefined, 'satisfied']);
    // The SMT lane reads q1's p's x as P's x, its value axiom beside the assert: the two contradict.
    const axioms = obligationsOf(m!).filter((o) => o.role === 'axiom');
    expect(axioms.map((o) => [o.element.qualifiedName, o.vars.map((v) => v.qualifiedName).join(' ')])).toEqual([
      ['HE::q1::tie', 'HE::P::x'],
      ['HE::P::x', 'HE::P::x'],
    ]);
    // (i) The index is worked out once per revision — again after an edit: as an equation or an inequality,
    // q1's assert splits nothing.
    const tie = named(m!, 'HE::q1::tie');
    m!.setAttrs(tie.id, { expression: 'p.x >= 5.0' });
    expect([assertHeldInSome(m!, x), defaultGivesWayIn(m!, x, 'HE::q1::p'), rows(m!, 'HE::P::c')]).toEqual([false, false, ['own satisfied']]);
    m!.setAttrs(tie.id, { expression: 'p.x == 50.0' });
    expect([assertHeldInSome(m!, x), defaultGivesWayIn(m!, x, 'HE::q1::p'), rows(m!, 'HE::P::c')]).toEqual([false, false, ['own satisfied']]);
  });

  it('reads a binding into the instance over its type’s assert, which is checked against it (RB, BND)', async () => {
    // q1's plain K = 7, bound to p.x, against Q's asserted `p.x == 50.0`: the contradiction of decision 1.
    // q1's p reads the binding's 7 on every surface — never the assert's 50 on the check beside the numeric 7.
    const { model: m } = await loadModelText(`package BND {
      part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 10.0 } }
      part def Q { part p : P; assert constraint tie { p.x == 50.0 } }
      part q1 : Q { attribute K : ScalarValues::Real = 7.0; bind p.x = K; }
      part q2 : Q;
      constraint top1 { q1.p.x <= 10.0 }
      constraint top2 { q2.p.x <= 10.0 }
    }`);
    // q2's p, which nothing binds, keeps P's 2, against which Q's assert is checked (it read 50, Q's assert
    // defining it there); q1's p, bound and under Q's assert, is not read on the check (A.2.4).
    const x = named(m!, 'BND::P::x');
    expect([assertDefinitionsIn(m!, x, 'BND::q1::p').length, assertDefinitionsIn(m!, x, 'BND::q2::p').length]).toEqual([0, 0]);
    expect(rows(m!, 'BND::P::c')).toEqual(['own satisfied', 'generic satisfied', 'BND::q1::p unknown', 'BND::q2::p satisfied']);
    expect(rows(m!, 'BND::Q::tie')).toEqual(['own violated', 'BND::q1 violated']);
    expect([...rows(m!, 'BND::top1'), ...rows(m!, 'BND::top2')]).toEqual(['own satisfied', 'own satisfied']);
    const n = numeric(m!);
    expect([n.get('BND::top1'), n.get('BND::q1::p'), n.get('BND::top2')]).toEqual(['satisfied', 'unknown', 'satisfied']);
  });

  it('reads a redefined default under an enclosing assert in its one instance, on the SMT lane too (U7 Q3)', async () => {
    // q1's own `:>> x default = 9.0` stands for q1's p's x alone, and q1's assert is checked against it: every
    // surface reads its 9 (U7's Q3 read 50 and no 9), and the SMT lane emits its `x == 9` axiom, which the
    // assert contradicts. P's own x keeps its 2.
    const { model: m } = await loadModelText(`package Q3E {
      part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 10.0 } }
      part def Q { part p : P; }
      part q1 : Q { part :>> p { attribute :>> x default = 9.0; } assert constraint tie { p.x == 50.0 } }
      constraint top { q1.p.x <= 10.0 }
    }`);
    const redef = m!.all().find((e) => e.attrs.defaultValue === true && e.attrs.value === 9)!;
    expect([defaultGivesWay(m!, redef), defaultGivesWay(m!, named(m!, 'Q3E::P::x'))]).toEqual([false, false]);
    expect([...rows(m!, 'Q3E::q1::tie'), ...rows(m!, 'Q3E::top')]).toEqual(['own violated', 'own satisfied']);
    expect(numeric(m!).get('Q3E::top')).toBe('satisfied');
    const axioms = obligationsOf(m!).filter((o) => o.role === 'axiom');
    expect(axioms.map((o) => o.element.qualifiedName)).toEqual(['Q3E::q1::tie', 'Q3E::P::x', 'Q3E::q1::p::x']);
  });

  it('checks an assert that sets the default equal to another default against the two (U7 Q4)', async () => {
    const { model: m } = await loadModelText(`package Q4E {
      part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 5.0 } }
      part def Q { part p : P; }
      part q1 : Q { attribute L : ScalarValues::Real default = 9.0; assert constraint tie { p.x == L } }
      part q2 : Q;
      constraint top { q1.p.x <= 5.0 }
    }`);
    // Both stand (both gave way in q1, and neither was read): x is P's 2 at q1's p, and q1's L its 9.
    expect([defaultGivesWayIn(m!, named(m!, 'Q4E::P::x'), 'Q4E::q1::p'), defaultGivesWay(m!, named(m!, 'Q4E::q1::L'))]).toEqual([false, false]);
    expect(rows(m!, 'Q4E::P::c')).toEqual(['own satisfied']);
    expect([...rows(m!, 'Q4E::q1::tie'), ...rows(m!, 'Q4E::top')]).toEqual(['own violated', 'own satisfied']);
    expect(numeric(m!).get('Q4E::top')).toBe('satisfied');
  });

  it('checks the asserts of every frame above the instance against its default: the package’s and its type’s (H1C, H1F2)', async () => {
    const body = `part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute x : ScalarValues::Real default = 2.0;
        constraint c { load + x <= 10.0 }
      }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }`;
    const { model: c } = await loadModelText(`package H1C { ${body}
      part q1 : Q { attribute :>> L = 3.0; }
      part q2 : Q;
      assert constraint t { q1.p.x == 50.0 }
      constraint top1 { q1.p.load + q1.p.x <= 10.0 }
    }`);
    // q1's p's x is P's 2 (it read the package's 50): the package's own top1 reads it, 3 + 2; q1's p's row, under
    // the package's assert, is not read (A.2.4), as for a value written with `=`.
    expect(rows(c!, 'H1C::P::c')).toEqual(['own satisfied', 'generic satisfied', 'H1C::q1::p unknown', 'H1C::q2::p satisfied']);
    expect([...rows(c!, 'H1C::t'), ...rows(c!, 'H1C::top1')]).toEqual(['own violated', 'own satisfied']);
    const { model: f } = await loadModelText(`package H1F2 { ${body}
      part def Q2 :> Q { assert constraint tie { p.x == 50.0 } }
      part q1 : Q2 { attribute :>> L = 3.0; }
      part q2 : Q;
      constraint top1 { q1.p.load + q1.p.x <= 10.0 }
    }`);
    // Q2's assert is checked in every Q2 against the default: its own p and q1's p read 2 (they read 50).
    expect(rows(f!, 'H1F2::P::c')).toEqual([
      'own satisfied',
      'generic satisfied',
      'H1F2::Q2::p satisfied',
      'H1F2::q1::p satisfied',
      'H1F2::q2::p satisfied',
    ]);
    expect([rows(f!, 'H1F2::Q2::tie'), numeric(f!).get('H1F2::top1')]).toEqual([['own violated'], 'satisfied']);
  });

  it('checks an equation over the frame’s own names there against the default, and two that disagree (U7)', async () => {
    const { model: m } = await loadModelText(`package HX {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute x : ScalarValues::Real default = 2.0;
        attribute s : ScalarValues::Real = x + 1.0; constraint c { s <= 10.0 } }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 3.0; assert constraint t1 { p.x == 50.0 } }
      part q3 : Q { attribute :>> L = 3.0; assert constraint t3 { p.x == 5.0 } }
      part q4 : Q { attribute :>> L = 3.0; attribute M : ScalarValues::Real = 60.0; assert constraint t4 { p.x == M } }
      part q5 : Q { attribute :>> L = 3.0; attribute M : ScalarValues::Real = 6.0; assert constraint t5 { p.x == M } }
    }`);
    // x is P's 2 in every instance, s 3 (it read q1's 51 and q3's 6, and q4's and q5's M): no instance is read
    // apart, and each frame's assert is checked against the 2.
    expect(rows(m!, 'HX::P::c')).toEqual(['own satisfied']);
    expect(['HX::q1::t1', 'HX::q3::t3', 'HX::q4::t4', 'HX::q5::t5'].flatMap((r) => rows(m!, r))).toEqual([
      'own violated',
      'own violated',
      'own violated',
      'own violated',
    ]);
    const { model: t } = await loadModelText(`package TWOE {
      part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 10.0 } }
      part def Q { part p : P; }
      part q1 : Q { assert constraint t1 { p.x == 50.0 } }
      assert constraint t2 { q1.p.x == 60.0 }
    }`);
    // Two asserts that give q1's p's x two values are both checked against its 2 (it was read as no value).
    expect([...rows(t!, 'TWOE::P::c'), ...rows(t!, 'TWOE::q1::t1'), ...rows(t!, 'TWOE::t2')]).toEqual(['own satisfied', 'own violated', 'own violated']);
    // One text over names, read in two frames: q1's M is Q's 50, the package's M is 60 — two values.
    const { model: v } = await loadModelText(`package TV {
      part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 55.0 } }
      part def Q { part p : P; attribute M : ScalarValues::Real = 50.0; }
      attribute M : ScalarValues::Real = 60.0;
      part q1 : Q { assert constraint t1 { p.x == M } }
      assert constraint t2 { q1.p.x == M }
    }`);
    expect([...rows(v!, 'TV::P::c'), ...rows(v!, 'TV::q1::t1'), ...rows(v!, 'TV::t2')]).toEqual(['own satisfied', 'own violated', 'own violated']);
  });

  it('leaves the default standing under an inequality, which it checks (U5, HI)', async () => {
    const { model: m } = await loadModelText(`package HI {
      part def P { attribute x : ScalarValues::Real default = 2.0; }
      part def Q { part p : P; }
      part q1 : Q { assert constraint lim { p.x >= 5.0 } }
      constraint top { q1.p.x <= 10.0 }
    }`);
    expect([assertHeldInSome(m!, named(m!, 'HI::P::x')), defaultGivesWayIn(m!, named(m!, 'HI::P::x'), 'HI::q1::p')]).toEqual([false, false]);
    expect([...rows(m!, 'HI::q1::lim'), ...rows(m!, 'HI::top')]).toEqual(['own violated', 'own satisfied']);
  });

  // The planted bug P5 (literals counted in `readsOtherwise`) was an equivalent mutant, and is one again: the
  // one shape that reached the guard was a literal `default` an asserted equation overrode, read where the
  // context changes what it reads (q1's K of 25 made its L 50), and no assertion replaces a default since
  // decision 14 was amended (2026-10-22). L keeps its 7 in every Q, where Q's binding joins it to P's `load
  // default = 1.0`: two defaults that differ, so Q's p reads neither, and q1 reads nothing otherwise.
  it('reads a literal default no assertion replaces as written, in every context (P5)', async () => {
    const { model: m } = await loadModelText(`package P5G {
      part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }
      part def Q {
        attribute K : ScalarValues::Real default = 1.0;
        attribute L : ScalarValues::Real default = 7.0;
        assert constraint ldef { L == 2.0 * K }
        part p : P;
        bind p.load = L;
      }
      part q1 : Q { attribute :>> K = 25.0; }
      part q2 : Q;
    }`);
    const L = named(m!, 'P5G::Q::L');
    expect(readsOtherwise(m!, named(m!, 'P5G::q1').id, 'L', L)).toBeUndefined();
    expect(rows(m!, 'P5G::P::c')).toEqual(['own satisfied', 'P5G::Q::p unknown']);
  });

  // P5 itself — the guard dropped, so that every literal counts — is still an equivalent mutant after H5: a literal
  // no assert holds reads no name, so what follows the guard answers it as the guard does. Planted at per-instance-rest
  // S3, it moved no row of the four-surface table, the 665 M-generator files (literal members included), or P5L
  // here: a literal written with `=` that an asserted equation also defines, read where q1 changes the equation's
  // input (decision 1's contradiction). So no test can turn red on it; this pins the contract the guard short-cuts,
  // as its sibling above does since no assertion replaces a default.
  it('reads a literal no assert holds where it is written, in every context (P5)', async () => {
    const { model: m } = await loadModelText(`package P5L {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute on : ScalarValues::Boolean = true; constraint c { load <= 10.0 } }
      part def Q {
        attribute K : ScalarValues::Real default = 1.0;
        attribute L : ScalarValues::Real = 2.0;
        assert constraint ldef { L == 2.0 * K }
        part p : P;
        bind p.load = L;
      }
      part q1 : Q { attribute :>> K = 25.0; }
      part q2 : Q;
      constraint top1 { q1.p.load <= 10.0 }
    }`);
    const q1 = named(m!, 'P5L::q1').id;
    expect(readsOtherwise(m!, q1, 'L', named(m!, 'P5L::Q::L'))).toBeUndefined();
    expect(readsOtherwise(m!, q1, 'p.on', named(m!, 'P5L::P::on'))).toBeUndefined();
    // Read at the `=` value, as everywhere else: the asserted equation is checked against it (decision 1).
    const checks = checkConstraints(m!);
    expect(checks.find((c) => m!.qualifiedName(c.id) === 'P5L::top1')!.result).toBe('satisfied');
    expect(checks.find((c) => m!.qualifiedName(c.id) === 'P5L::Q::ldef')!.instances!.map((i) => i.result)).toEqual(['violated']);
  });

  // A context whose instances read a relation otherwise only through what a binding's partner reads, or where it
  // renames the bound end (R38: `attribute ld :>> load`), was listed nowhere: no surface filed `c in q2`, and
  // `sysml-check --strict` said OK over q2's load of 50. R22B (q2's own `assert constraint { K == 25.0 }` over K's
  // default, which `L = 2.0 * K` reads and Q's `bind load = L` carries into load) and R27F (the package's `q2.K
  // == 25.0` over q2's own `default`) were such contexts while an asserted equation replaced a default; since
  // decision 14 was amended (2026-10-22) each assert is checked against K's default, and q2 reads Q's 0.5 (R22B)
  // or its own 1 (R27F): load 1 or 2, c holds, and the assert is reported violated.
  it('reads a relation in a context that changes what a bound partner reads, or renames the bound end (R22B, R27F, R38)', async () => {
    const shape = (pkg: string, q2: string, outer = '') => `package ${pkg} {
      part def Q {
        attribute K : ScalarValues::Real default = 0.5;
        attribute L : ScalarValues::Real = 2.0 * K;
        attribute load : ScalarValues::Real;
        bind load = L;
        constraint c { load <= 5.0 }
      }
      part q2 : Q { ${q2} }
      ${outer}
    }`;
    const row = async (text: string, pkg: string) => {
      const { model: m, report } = await loadModelText(text, { strict: true });
      const c = checkConstraints(m!).find((x) => m!.qualifiedName(x.id) === `${pkg}::Q::c`)!;
      const own = c.instances?.find((i) => m!.qualifiedName(i.contextId) === `${pkg}::q2`);
      // The binding carries q2's input into load: an instance's reading (PI-3), `constraint-by-instance`'s —
      // never `target-by-specialisation`, which mbse-workflow reports and does not block on.
      const codes = report.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.code);
      return [c.result, own?.result, report.ok, codes];
    };
    expect(await row(shape('R22B', 'assert constraint k2 { K == 25.0 }'), 'R22B')).toEqual([
      'satisfied',
      undefined,
      false,
      ['validation/constraint-violation'],
    ]);
    expect(await row(shape('R27F', 'attribute :>> K default = 1.0;', 'assert constraint ak { q2.K == 25.0 }'), 'R27F')).toEqual([
      'satisfied',
      'satisfied',
      false,
      ['validation/constraint-violation'],
    ]);
    // Renamed, q2's load is `ld`, through which this tool reads no binding: the row is filed, and abstains in a
    // sentence that names the renaming — the instance's own row too, an info `constraint-by-instance` at q2's
    // `ld :>> load` (it was a target's `target-by-specialisation`, which mbse-workflow reports and never blocks on).
    expect(await row(shape('R38', 'attribute :>> K = 25.0; attribute ld :>> load;'), 'R38')).toEqual(['satisfied', 'unknown', true, []]);
    const r38text = shape('R38', 'attribute :>> K = 25.0; attribute ld :>> load;');
    const { model: r38, report: r38report } = await loadModelText(r38text, { strict: true });
    const found = r38report.diagnostics.filter((d) => d.code?.startsWith('validation/'));
    expect(found.map((d) => [d.code, d.severity])).toEqual([['validation/constraint-by-instance', 'info']]);
    expect(r38text.slice(found[0]!.range!.start.offset)).toMatch(/^attribute ld :>> load;/);
    const c38 = checkConstraints(r38!).find((x) => r38!.qualifiedName(x.id) === 'R38::Q::c')!;
    expect(c38.instances!.find((i) => r38!.qualifiedName(i.contextId) === 'R38::q2')!.detail).toBe(
      'Could not evaluate: R38::q2 redefines the bound `load` under a name of its own (`ld :>> load`), and this tool does not ' +
        "read what a binding gives a feature so renamed, so R38::Q's `load` is not read there",
    );
  });

  // CD1: `assert constraint e : Eq { in a = L; }` over Eq's `a == 50.0` makes L 50 (decision 14), but no surface reads
  // an assert typed by a constraint definition: L's default 1 was read, and `L == 50.0` refuted on all four.
  it('reads no default an assert typed by an equation’s definition names, and says which assert (CD1)', async () => {
    const { model: m } = await loadModelText(`package CD1 {
      constraint def Eq { in a : ScalarValues::Real; a == 50.0 }
      part def Q {
        attribute L : ScalarValues::Real default = 1.0;
        assert constraint e : Eq { in a = L; }
        constraint cl { L == 50.0 }
      }
      part q : Q;
      constraint topL { q.L == 50.0 }
      constraint def Le { in a : ScalarValues::Real; a <= 0.5 }
      part def R { attribute M : ScalarValues::Real default = 1.0; assert constraint f : Le { in a = M; } constraint cm { M <= 5.0 } }
    }`);
    const checks = checkConstraints(m!);
    const c = (rel: string) => checks.find((x) => m!.qualifiedName(x.id) === rel)!;
    expect([c('CD1::Q::cl').result, c('CD1::Q::cl').message]).toEqual([
      'unknown',
      'Could not evaluate: L is not read: its `default = 1.0` is named by `assert constraint e : Eq` in CD1::Q, whose equation this ' +
        'tool does not read',
    ]);
    expect(c('CD1::topL').result).toBe('unknown');
    // No design freedom to the numeric surface either: `L == 50.0` is not solved as a design equation.
    const cl = checkConstraintsNumeric(m!).find((r) => m!.qualifiedName(r.id) === 'CD1::Q::cl')!;
    expect([cl.result, cl.imposed]).toEqual(['unknown', undefined]);
    // An inequality defines nothing (U5): R's M keeps its default.
    expect(c('CD1::R::cm').result).toBe('satisfied');
  });

  // CD13: a design relation that disagrees with the typed equation (`p.load == 5.0`, where L and so load are 50)
  // was solved as a design equation over the given-way L, and c and c2 decided at load 5: the Solve view's false
  // violation of c2 and false hold of c. And a typed assert away from the default it names — in a usage (cd9), with
  // a dotted parameter (cd6), in a package (cd5), with a bound parameter (cd21), over a valueless feature (cd15) —
  // read the default, or left the feature a design freedom, on every surface.
  it('reads nothing an assert typed by an equation’s definition names, wherever it is written (CD13, cd5–cd15)', async () => {
    const Eq = 'constraint def Eq { in a : ScalarValues::Real; a == 50.0 }';
    const load = async (text: string) => (await loadModelText(text)).model!;
    const rows = (m: Model, which: readonly string[]) => {
      const checks = checkConstraints(m);
      const numeric = checkConstraintsNumeric(m);
      return which.map((q) => [
        q,
        checks.find((x) => m.qualifiedName(x.id) === q)!.result,
        numeric.find((x) => m.qualifiedName(x.id) === q)!.result,
        numeric.find((x) => m.qualifiedName(x.id) === q)!.imposed ?? false,
      ]);
    };
    const cd13 = await load(`package CD13 {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
      ${Eq}
      part def Q {
        attribute L : ScalarValues::Real default = 1.0;
        part p : P;
        bind p.load = L;
        assert constraint e : Eq { in a = L; }
        constraint c { p.m2 >= 0.0 }
        constraint c2 { p.m2 <= 0.0 }
        constraint cl { p.load == 5.0 }
      }
      part q : Q;
      constraint top { q.p.m2 >= 0.0 }
    }`);
    expect(rows(cd13, ['CD13::Q::c', 'CD13::Q::c2', 'CD13::Q::cl', 'CD13::top'])).toEqual([
      ['CD13::Q::c', 'unknown', 'unknown', false],
      ['CD13::Q::c2', 'unknown', 'unknown', false],
      ['CD13::Q::cl', 'unknown', 'unknown', false],
      ['CD13::top', 'unknown', 'unknown', false],
    ]);
    const cd9 = await load(`package CD9 {
      ${Eq}
      part def Q { attribute L : ScalarValues::Real default = 1.0; }
      part q : Q { assert constraint e : Eq { in a = L; } }
      constraint top { q.L == 50.0 }
    }`);
    expect(rows(cd9, ['CD9::top'])).toEqual([['CD9::top', 'unknown', 'unknown', false]]);
    const cd6 = await load(`package CD6 {
      ${Eq}
      part def P { attribute load : ScalarValues::Real default = 1.0; }
      part def Q { part p : P; assert constraint e : Eq { in a = p.load; } }
      part q : Q;
      constraint top { q.p.load <= 10.0 }
    }`);
    expect(rows(cd6, ['CD6::top'])).toEqual([['CD6::top', 'unknown', 'unknown', false]]);
    const cd5 = await load(`package CD5 {
      ${Eq}
      part def Q { attribute L : ScalarValues::Real default = 1.0; }
      part q : Q;
      assert constraint e : Eq { in a = q.L; }
      constraint top { q.L == 50.0 }
    }`);
    expect(rows(cd5, ['CD5::top'])).toEqual([['CD5::top', 'unknown', 'unknown', false]]);
    // A parameter bound rather than valued holds the feature it is bound to (cd21).
    const cd21 = await load(`package CD21 {
      ${Eq}
      part def Q { attribute L : ScalarValues::Real default = 1.0; assert constraint e : Eq { bind a = L; } }
      part q : Q;
      constraint top { q.L == 50.0 }
    }`);
    expect(rows(cd21, ['CD21::top'])).toEqual([['CD21::top', 'unknown', 'unknown', false]]);
    // A body that reads a parameter's feature (`x.load` over `in x = p`, or `bind x = p`) may define p's load (TP1,
    // TP5); so may a parameter value a constraint usage the assert specialises gives (TP2's `ea :> e0`). Each read
    // P's default 1 on all four surfaces, where p's load is 50 (the branch review of per-instance-rest).
    for (const [name, eq, q] of [
      ['TP1', 'constraint def Eq { in x : P; x.load == 50.0 }', 'assert constraint e : Eq { in x = p; }'],
      ['TP5', 'constraint def Eq { in x : P; x.load == 50.0 }', 'assert constraint e : Eq { bind x = p; }'],
      ['TP2', 'constraint def Eq { in x : ScalarValues::Real; x == 50.0 }', 'constraint e0 : Eq { in x = p.load; } assert constraint ea :> e0;'],
    ] as const) {
      const tp = await load(`package ${name} {
        part def P { attribute load : ScalarValues::Real default = 1.0; }
        ${eq}
        part def Q { part p : P; ${q} constraint c { p.load <= 10.0 } }
        part q : Q;
        constraint top { q.p.load <= 10.0 }
      }`);
      expect(rows(tp, [`${name}::Q::c`, `${name}::top`]), name).toEqual([
        [`${name}::Q::c`, 'unknown', 'unknown', false],
        [`${name}::top`, 'unknown', 'unknown', false],
      ]);
    }
    // An equation in a conjunction may define L too; an inequality alone defines nothing (U5), and M's default stands.
    const cd23 = await load(`package CD23 {
      constraint def Eq { in a : ScalarValues::Real; a == 50.0 and a >= 0.0 }
      constraint def Le { in a : ScalarValues::Real; a >= 0.0 and a <= 100.0 }
      part def Q {
        attribute L : ScalarValues::Real default = 1.0;
        attribute M : ScalarValues::Real default = 1.0;
        assert constraint e : Eq { in a = L; }
        assert constraint f : Le { in a = M; }
        constraint cl { L == 50.0 }
        constraint cm { M == 1.0 }
      }
    }`);
    expect(rows(cd23, ['CD23::Q::cl', 'CD23::Q::cm'])).toEqual([
      ['CD23::Q::cl', 'unknown', 'unknown', false],
      ['CD23::Q::cm', 'satisfied', 'satisfied', false],
    ]);
    const cd15 = await load(`package CD15 {
      ${Eq}
      part def Q { attribute L : ScalarValues::Real; assert constraint e : Eq { in a = L; } constraint cl { L == 5.0 } constraint c { L >= 10.0 } }
    }`);
    expect(rows(cd15, ['CD15::Q::cl', 'CD15::Q::c'])).toEqual([
      ['CD15::Q::cl', 'unknown', 'unknown', false],
      ['CD15::Q::c', 'unknown', 'unknown', false],
    ]);
    expect(checkConstraints(cd15).find((x) => cd15.qualifiedName(x.id) === 'CD15::Q::c')!.message).toBe(
      'Could not evaluate: L has no value this tool reads: it is named by `assert constraint e : Eq` in CD15::Q, whose equation ' +
        'this tool does not read',
    );
  });
});

describe('a binding reads through a renamed redefinition and a package’s definition-feature bind (H5 S4)', () => {
  const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;
  const result = (m: Model, rel: string) => checkConstraints(m).find((k) => m.qualifiedName(k.id) === rel)!.result;
  const numeric = (m: Model, rel: string) => checkConstraintsNumeric(m).find((r) => m.qualifiedName(r.id) === rel)!.result;
  const axioms = (m: Model, element: string) =>
    obligationsOf(m)
      .filter((o) => o.role === 'axiom' && o.element.qualifiedName === element)
      .map((o) => `${o.expression} [${o.encodable === true ? 'ok' : o.encodable.reason}] ${o.vars.map((v) => v.qualifiedName).join(' ')}`);
  const source = (m: Model, symbol: string) => {
    const s = boundSourceIn(m, symbol);
    return s === undefined ? undefined : 'abstain' in s ? s.abstain : s.via.source;
  };

  it('reads the slot a renamed redefinition fills (`part pp :>> p`) on every surface, never a sibling (R13)', async () => {
    const { model: m } = await loadModelText(`package R13s {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; part p3 : P; bind p.load = L; }
      part q : Q { attribute :>> L = 50.0; part pp :>> p; }
      constraint m2PosF { q.pp.m2 >= 0.0 }
      constraint sibT { q.p3.m2 >= 0.0 }
    }`);
    expect([source(m!, 'R13s::q::pp::load'), source(m!, 'R13s::q::p3::load')]).toEqual(['q.L', undefined]);
    expect([result(m!, 'R13s::m2PosF'), numeric(m!, 'R13s::m2PosF')]).toEqual(['violated', 'violated']);
    expect([result(m!, 'R13s::sibT'), numeric(m!, 'R13s::sibT')]).toEqual(['satisfied', 'satisfied']);
    // The SMT lane reads Q's binding in q at q's own spelling: one symbol with the relation's, not an unresolved `p.load`.
    expect(axioms(m!, 'R13s::Q::«BindingConnectorAsUsage» in R13s::q')).toEqual(['pp.load == L [ok] R13s::q::pp::load R13s::q::L']);
  });

  it('reads a package’s `bind P::load = L` in every instance of P, a redefined default giving way (w4)', async () => {
    const { model: m } = await loadModelText(`package W4 {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
      part def Q { part p : P; }
      attribute L : ScalarValues::Real = 50.0;
      bind P::load = L;
      part p2 : P;
      part p3 : P { attribute :>> load default = 7.0; }
      part q : Q;
      constraint c2 { p2.m2 >= 0.0 }
      constraint c3 { p3.m2 >= 0.0 }
      constraint cq { q.p.m2 >= 0.0 }
    }`);
    expect(['W4::p2::load', 'W4::p3::load', 'W4::q::p::load', 'W4::Q::p::load'].map((s) => source(m!, s))).toEqual(['L', 'L', 'L', 'L']);
    // p3's `:>> load default = 7.0` gives way to the binding as P's own does.
    const redefined = m!.children(named(m!, 'W4::p3').id).find((c) => c.eClass === 'AttributeUsage')!;
    expect([defaultGivesWay(m!, redefined), defaultGivesWay(m!, named(m!, 'W4::P::load'))]).toEqual([true, true]);
    for (const rel of ['W4::c2', 'W4::c3', 'W4::cq']) expect([rel, result(m!, rel), numeric(m!, rel)]).toEqual([rel, 'violated', 'violated']);
    // The SMT lane holds the binding in each instance, over the instance's load and the package's one L.
    expect(axioms(m!, 'W4::«BindingConnectorAsUsage» in W4::p3')).toEqual(['load == W4::L [ok] W4::p3::load W4::L']);
    expect(axioms(m!, 'W4::P::load in W4::p3')).toEqual([]);
    // (i) Read once per revision, and again after an edit: L at 5 makes every m2 5.
    m!.setAttrs(named(m!, 'W4::L').id, { value: 5.0 });
    for (const rel of ['W4::c2', 'W4::c3', 'W4::cq']) expect([rel, result(m!, rel)]).toEqual([rel, 'satisfied']);
  });

  it('reads no value per instance for a package’s binding between two features of a definition (W4d)', async () => {
    const { model: m } = await loadModelText(`package W4d {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute cap : ScalarValues::Real; attribute m2 : ScalarValues::Real = 10.0 - load; }
      bind P::load = P::cap;
      part p2 : P { attribute :>> cap = 50.0; }
      constraint c2F { p2.m2 >= 0.0 }
    }`);
    // P's load default of 1 was read at p2 on every surface, where p2's cap makes it 50.
    expect([source(m!, 'W4d::p2::load'), defaultGivesWay(m!, named(m!, 'W4d::P::load'))]).toEqual(['free', true]);
    expect([result(m!, 'W4d::c2F'), numeric(m!, 'W4d::c2F')]).toEqual(['unknown', 'violated']);
    expect(axioms(m!, 'W4d::«BindingConnectorAsUsage» in W4d::p2')).toEqual(['load == cap [ok] W4d::p2::load W4d::p2::cap']);
  });

  it('stands no default where an instance carries a value of its own into a valueless partner (W4v)', async () => {
    const { model: m } = await loadModelText(`package W4v {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
      attribute L : ScalarValues::Real;
      bind P::load = L;
      part p2 : P;
      part p4 : P { attribute :>> load = 7.0; }
      constraint c2 { p2.m2 <= 5.0 }
    }`);
    // p4's 7 is L's, and p2's: P's default 1 stood for p2 and for L on the check, the literal and numeric surfaces.
    expect([source(m!, 'W4v::p2::load'), defaultStandsIn(m!, 'W4v::p2::load'), defaultStandsIn(m!, 'W4v::L')]).toEqual([
      'defaults-differ',
      undefined,
      undefined,
    ]);
    expect([result(m!, 'W4v::c2'), numeric(m!, 'W4v::c2')]).toEqual(['unknown', 'unknown']);
  });

  it('stands no default where an instance’s slot is fixed outside the binding — another binding, an assert (W4X)', async () => {
    const { model: m } = await loadModelText(`package W4X {
      part def P { attribute load : ScalarValues::Real default = 50.0; }
      attribute L : ScalarValues::Real;
      bind P::load = L;
      part def Q { attribute M : ScalarValues::Real = 7.0; part p : P; bind p.load = M; }
      part q : Q;
      part p2 : P;
      constraint cqT { q.p.load <= 10.0 }
      constraint c2T { p2.load <= 10.0 }
    }`);
    // Q's binding makes q's p's load 7, so L and p2's load are 7: P's default 50 stood for p2 on all four
    // surfaces, and the SMT lane kept its axiom beside q's 7 (inconsistent-axioms on a consistent model).
    expect([defaultGivesWay(m!, named(m!, 'W4X::P::load')), defaultStandsIn(m!, 'W4X::p2::load')]).toEqual([true, undefined]);
    expect(checkConstraints(m!).find((k) => m!.qualifiedName(k.id) === 'W4X::c2T')!.message).toContain(
      'a binding read in W4X at q.p.load gives P.load a value in one of them',
    );
    expect([result(m!, 'W4X::c2T'), numeric(m!, 'W4X::c2T'), result(m!, 'W4X::cqT')]).toEqual(['unknown', 'satisfied', 'satisfied']);
    const { model: a } = await loadModelText(`package W4A {
      part def P { attribute load : ScalarValues::Real; }
      attribute M : ScalarValues::Real default = 9.0;
      bind P::load = M;
      part p2 : P;
      assert constraint fix { p2.load == 5.0 }
      part p3 : P;
      constraint c3T { p3.load <= 6.0 }
    }`);
    // An asserted equation fixes no slot a `default` gives way to (decision 14 amended 2026-10-22): M's 9 stands
    // in every instance of P, as `M = 9.0` does, so p3's load is 9 and the assert is checked against it. Read as
    // the assert's 5, M gave way and c3T was T on the numeric and SMT surfaces.
    expect([defaultGivesWay(a!, named(a!, 'W4A::M')), source(a!, 'W4A::p3::load')]).toEqual([false, 'M']);
    expect([result(a!, 'W4A::c3T'), numeric(a!, 'W4A::c3T'), result(a!, 'W4A::fix')]).toEqual(['violated', 'violated', 'violated']);
  });

  // A row that reads a usage's own redefinition reads it by the feature's own symbol, so its instance was never
  // held to the bindings of its types: p4's `:>> load = 7.0 [kg]` beside the package's `bind P::load = L` (W4u),
  // r2's q's p's `:>> load = 3.0` beside R's q's `bind p.load = L` over r2's L of 50 (EB4). Every surface but SMT
  // reads neither value (A.5); the SMT lane had no such axiom, and proved `<= 10` at the own value.
  it('holds a usage whose own feature a row reads to the bindings of its types (EB4, W4u)', async () => {
    const binds = (m: Model) =>
      obligationsOf(m)
        .filter((o) => o.role === 'axiom' && o.source === 'bind')
        .map((o) => `${o.vars.map((v) => v.qualifiedName).join(' == ')} [${o.encodable === true ? 'ok' : o.encodable.reason}]`);
    const { model: u } = await loadModelText(`package W4u {
      part def P { attribute load : ISQ::MassValue default = 1.0 [kg]; }
      attribute L : ISQ::MassValue = 50.0 [kg];
      bind P::load = L;
      part p4 : P { attribute :>> load = 7.0 [kg]; }
      constraint c4lo { p4.load <= 10.0 [kg] }
    }`);
    expect(binds(u!)).toContain('W4u::p4::load == W4u::L [ok]');
    const { model: e } = await loadModelText(`package EB4 {
      part def P { attribute load default = 1.0; constraint c { load <= 10.0 } }
      part def Q { part p : P; }
      part def R { attribute L default = 5.0; part q : Q { bind p.load = L; } }
      part r2 : R { attribute :>> L = 50.0; part :>> q { part :>> p { attribute :>> load = 3.0; } } }
      constraint t2 { r2.q.p.load <= 10.0 }
    }`);
    expect(binds(e!)).toContain('EB4::r2::q::p::load == EB4::r2::L [ok]');
    expect(result(e!, 'EB4::t2')).toBe('unknown');
    // The binding is read in R, which holds both its ends: its own row reports the pair in r2, where no row did.
    expect(
      checkConstraints(e!)
        .filter((c) => c.conflict === 'bind')
        .map((c) => [e!.qualifiedName(c.ownerId!), c.result, c.expression]),
    ).toEqual([['EB4::r2', 'violated', 'q.p.load == L']]);
    // Quoted as written, where it is written — the line an author searches for — then as it is read in R.
    expect(checkConstraints(e!).find((c) => c.conflict === 'bind')!.message).toMatch(
      /^Constraint violated: `bind p\.load = L` in EB4::R::q, read in EB4::r2 through EB4::R as `q\.p\.load == L`, binds q\.p\.load to L/,
    );
  });
});

describe('a value, a reference and a binding that equate two parts or structured attributes (O9 S1)', () => {
  const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;
  const check = (m: Model, rel: string) => checkConstraints(m).find((k) => m.qualifiedName(k.id) === rel)!;
  const numeric = (m: Model, rel: string) => checkConstraintsNumeric(m).find((r) => m.qualifiedName(r.id) === rel)!.result;
  const goal = (m: Model, rel: string) => obligationsOf(m).find((o) => o.role !== 'axiom' && o.element.qualifiedName === rel)!;
  const T = `part def T0 { attribute load : ScalarValues::Real default = 1.0; }
      part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; bind a.load = L; }`;

  it('reads a reference a definition values with a path at each instance’s own partner (V8R)', async () => {
    const { model: m } = await loadModelText(`package V8R {
      ${T}
      part def W { part top : T1; ref part pp : T0 = top.a; constraint pT { pp.load >= 40.0 } }
      part w : W { part :>> top { attribute :>> L = 50.0; } }
    }`);
    // w's pp is w's top's a, whose L w sets to 50: it read W's own top's a (1), F on all four surfaces.
    const at = sharedDefinitions(m!).denote(named(m!, 'V8R::w').id).get('pp.load')!;
    expect(at.instance).toBe('V8R::w::top::a');
    const c = check(m!, 'V8R::W::pT');
    expect([c.result, c.instances!.map((i) => [m!.qualifiedName(i.contextId), i.result])]).toEqual([
      'violated',
      [['V8R::w', 'satisfied']],
    ]);
    expect(goal(m!, 'V8R::W::pT in V8R::w').vars.map((v) => v.qualifiedName)).toEqual(['V8R::w::top::a::load']);
  });

  it('reads a part valued with another as that other where it says nothing else of its own, and nowhere else (PPV)', async () => {
    const { model: m } = await loadModelText(`package PPV {
      ${T}
      part top : T1 { attribute :>> L = 50.0; }
      part pp : T0 = top.a;
      constraint pT { pp.load >= 40.0 }
    }`);
    // pp is top's a (50): it read pp's own default 1, then abstained on every surface.
    expect([check(m!, 'PPV::pT').result, numeric(m!, 'PPV::pT'), goal(m!, 'PPV::pT').encodable]).toEqual(['satisfied', 'satisfied', true]);
    const { model: q } = await loadModelText(`package PPQ {
      ${T}
      part top : T1 { attribute :>> L = 50.0; }
      part top2 : T1 { attribute :>> L = 50.0; }
      part pp : T0 = top.a;
      part pq : T0 = top.a { attribute :>> load default = 3.0; }
      constraint pT { pp.load >= 40.0 }
      constraint qT { pq.load >= 40.0 }
      constraint aT { top.a.load >= 40.0 }
      constraint oT { top2.a.load >= 40.0 }
    }`);
    // pq says something of its own: no surface reads through its value, and the goal files it under its own
    // reason, a limit of this tool. Its partner, top's a, has what pq says too, so a row that reads top's a —
    // directly, or through pp, which stands for it — abstains in the same sentence (they read top's a's own 50
    // with pq's load beside it unread); top2's a is no partner and keeps its verdict.
    const sentence =
      '`pq = top.a` in PPQ values a part, port, item or structured attribute with another, which equates the two as a ' +
      'binding does; this tool reads through such a value only where the feature says nothing else of its own and its ' +
      'value is a path, below where it is written, to one as plain, and that is not so here, so no relation that may ' +
      'read a value it carries is read';
    for (const rel of ['PPQ::qT', 'PPQ::pT', 'PPQ::aT']) {
      expect([check(q!, rel).result, check(q!, rel).message], rel).toEqual(['unknown', `Could not evaluate: ${sentence}`]);
      expect(goal(q!, rel).encodable, rel).toEqual({ reason: 'unread-binding', detail: sentence });
    }
    expect([check(q!, 'PPQ::oT').result, numeric(q!, 'PPQ::oT'), goal(q!, 'PPQ::oT').encodable]).toEqual(['satisfied', 'satisfied', true]);
  });

  it('reads a binding or a value between two structured attributes as one between two parts (R8A, R8V)', async () => {
    const V = `attribute def V { attribute x : ScalarValues::Real default = 1.0; }
      part def T1 { attribute L : ScalarValues::Real default = 1.0; attribute pos : V; bind pos.x = L; }
      part top : T1 { attribute :>> L = 50.0; }`;
    const { model: a } = await loadModelText(`package R8A { ${V} attribute q : V; bind q = top.pos; constraint qT { q.x >= 40.0 } }`);
    const { model: v } = await loadModelText(`package R8V { ${V} attribute q : V = top.pos; constraint qT { q.x >= 40.0 } }`);
    // q's x is top's pos's 50: both read q's own default 1, F on all four surfaces.
    for (const [m, rel] of [
      [a!, 'R8A::qT'],
      [v!, 'R8V::qT'],
    ] as const) {
      expect([check(m, rel).result, numeric(m, rel), goal(m, rel).vars.map((x) => x.qualifiedName)], rel).toEqual([
        'satisfied',
        'satisfied',
        [`${rel.split('::')[0]}::top::pos::x`],
      ]);
    }
    // A scalar attribute's binding is the binding reading's, as before: no part-valued pair.
    const { model: s } = await loadModelText(`package R8S {
      part def P { attribute load : ScalarValues::Real default = 1.0; }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q : Q { attribute :>> L = 50.0; }
      constraint c { q.p.load >= 40.0 }
    }`);
    expect(check(s!, 'R8S::c').result).toBe('satisfied');
    // So is an attribute whose user type specialises a library scalar or quantity value and adds a feature: its
    // value is one mass or one number, and `m = base`, `m2 = 2.0 * base` and `bind m1 = m2` are the scalar
    // readings' (they were read as two structured attributes equated, and abstained on all four surfaces).
    const { model: f } = await loadModelText(`package Q1F {
      private import SI::*;
      attribute def RatedMass :> ISQ::MassValue { attribute margin : ScalarValues::Real default = 0.1; }
      part def P { attribute base : ISQ::MassValue = 5.0 [kg]; attribute m : RatedMass = base; attribute m2 : RatedMass = 2.0 * base; }
      part p : P;
      constraint cT { p.m <= 10.0 [kg] }
      constraint dF { p.m2 >= 40.0 [kg] }
    }`);
    const { model: b } = await loadModelText(`package Q1C {
      attribute def Num :> ScalarValues::Real { attribute tol : ScalarValues::Real default = 0.1; }
      part def P { attribute m1 : Num; attribute m2 : Num = 5.0; bind m1 = m2; }
      part p : P;
      constraint cF { p.m1 >= 40.0 }
    }`);
    for (const [m, rel, result] of [
      [f!, 'Q1F::cT', 'satisfied'],
      [f!, 'Q1F::dF', 'violated'],
      [b!, 'Q1C::cF', 'violated'],
    ] as const) {
      expect([check(m, rel).result, numeric(m, rel), goal(m, rel).encodable], rel).toEqual([result, result, true]);
    }
  });

  it('reads on through a reference, a subject or a satisfy to what an equated part or a reference stands for (PPR, RC)', async () => {
    const { model: m } = await loadModelText(`package PPR {
      ${T}
      part top : T1 { attribute :>> L = 50.0; }
      part pp : T0;
      bind pp = top.a;
      ref part r : T0 = pp;
      requirement def RF { subject s : T0; require constraint { s.load <= 5.0 } }
      satisfy RF by pp;
      constraint rT { r.load >= 40.0 }
    }`);
    // r is pp, and pp is top's a: every row that read through pp abstained (pp was not plain), and before
    // that r's load read pp's own 1.
    const definitions = sharedDefinitions(m!);
    const pkg = named(m!, 'PPR');
    expect(definitions.subjectOf(pkg.id, named(m!, 'PPR::r'))!.id).toBe(definitions.subjectOf(pkg.id, named(m!, 'PPR::pp'))!.id);
    expect(definitions.denote(pkg.id).get('r.load')!.instance).toBe('PPR::top::a');
    expect([check(m!, 'PPR::rT').result, numeric(m!, 'PPR::rT')]).toEqual(['satisfied', 'satisfied']);
    const satisfied = check(m!, 'PPR::RF::«ConstraintUsage»').instances!;
    expect(satisfied.map((i) => [m!.qualifiedName(i.contextId), i.result, i.reads?.[0]?.symbol])).toEqual([
      ['PPR::«Satisfy»', 'violated', 'PPR::top::a::load'],
    ]);
    const { model: j } = await loadModelText(`package PSJ {
      ${T}
      part top : T1 { attribute :>> L = 50.0; }
      part pp : T0;
      bind pp = top.a;
      requirement def RF { subject s : T0; require constraint { s.load <= 5.0 } }
      requirement r1 : RF { subject s = pp; }
    }`);
    expect(check(j!, 'PSJ::RF::«ConstraintUsage»').instances!.map((i) => [j!.qualifiedName(i.contextId), i.result])).toEqual([
      ['PSJ::r1', 'violated'],
    ]);
    const { model: c } = await loadModelText(`package RC {
      part def T0 { attribute load : ScalarValues::Real default = 1.0; }
      part p1 : T0 { attribute :>> load = 50.0; }
      ref part r1 : T0 = p1;
      ref part r2 : T0 = r1;
      constraint rT { r2.load >= 40.0 }
    }`);
    // r2 is r1, and r1 is p1: r2's load read r1's own default 1, F on all four surfaces.
    expect([check(c!, 'RC::rT').result, numeric(c!, 'RC::rT')]).toEqual(['satisfied', 'satisfied']);
    // A value that leads back to itself stands for nothing, and the walk ends.
    const { model: loop } = await loadModelText(`package RL {
      part def T0 { attribute load : ScalarValues::Real default = 1.0; }
      ref part r1 : T0 = r2;
      ref part r2 : T0 = r1;
      constraint rT { r2.load >= 0.5 }
    }`);
    // The cycle stands for nothing, so r2 is read as itself: T0's default 1.
    expect(check(loop!, 'RL::rT').result).toBe('satisfied');
  });

  it('reads no satisfaction a definition writes through a reference or an equated part, which an instance can change (SD)', async () => {
    for (const [name, body] of [
      ['SD', 'part pp : T0; bind pp = top.a; ref part r : T0 = pp; satisfy RF by r;'],
      ['SD3', 'part pp : T0 = top.a; satisfy RF by pp;'],
    ] as const) {
      const { model: m } = await loadModelText(`package ${name} {
        ${T}
        requirement def RF { subject s : T0; require constraint { s.load <= 5.0 } }
        part def W { part top : T1; ${body} }
        part w : W { part :>> top { attribute :>> L = 50.0; } }
      }`);
      // The satisfaction is read once, at W's own top's a (1), and held, where w's top's a (50) breaks it: no
      // row of it is read, in a sentence of its own (it abstained until the reference, the value and the
      // binding were read through, then held on all four surfaces).
      const rows = check(m!, `${name}::RF::«ConstraintUsage»`).instances!;
      expect(rows.map((i) => [m!.qualifiedName(i.contextId), i.result]), name).toEqual([[`${name}::W::«Satisfy»`, 'unknown']]);
      expect(rows[0]!.message, name).toContain(`in ${name}::W names its satisfier through a feature that stands for another`);
      const g = obligationsOf(m!).find((o) => o.role !== 'axiom' && o.instance?.contextId === rows[0]!.contextId)!;
      expect(g.encodable, name).toMatchObject({ reason: 'unread-binding' });
    }
  });

  it('reads no satisfaction, or subject, a definition writes through a reference with no value an instance redefines (F1, F3)', async () => {
    const T0 = `part def T0 { attribute load : ScalarValues::Real default = 1.0; }
      requirement def RF { subject s : T0; require constraint { s.load <= 5.0 } }
      part p50 : T0 { attribute :>> load = 50.0; }`;
    const texts = {
      F1: `${T0} part def W { ref part r : T0; satisfy RF by r; } part w : W { ref part :>> r = p50; }`,
      F3: `${T0} part def W { ref part r : T0; requirement rr : RF { subject s = r; } } part w : W { ref part :>> r = p50; }`,
    };
    const said = { F1: 'in F1::W names its satisfier through a feature', F3: '`subject s = r` in F3::W::rr names the subject through a feature' };
    // w's r is p50, which breaks RF: each read W's own r alone (T0's 1), held on all four surfaces, and
    // `sysml-check --strict`, `verify` and `verify --engine literal` all passed. Each row of it abstains now.
    for (const [name, body] of Object.entries(texts)) {
      const { model: m, report } = await loadModelText(`package ${name} { ${body} }`, { fileName: `${name}.sysml`, strict: true });
      const rows = check(m!, `${name}::RF::«ConstraintUsage»`).instances!;
      expect(rows.length, name).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.result, name).toBe('unknown');
        expect(row.message, name).toContain(said[name as keyof typeof said]);
      }
      const goals = obligationsOf(m!).filter((o) => o.role !== 'axiom' && o.instance !== undefined);
      expect(goals.length, name).toBeGreaterThan(0);
      for (const g of goals) expect(g.encodable, name).toMatchObject({ reason: 'unread-binding' });
      expect(report.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message), name).toEqual([]);
    }
  });

  it('names the unread binding for a partner of an unread valued part on the numeric surface (SBV)', async () => {
    // `pp = top.a` values a part this tool does not read through: top.a.load has no value of its own there, and the
    // numeric row said only that ("top.a.load" has no value in scope) where the other surfaces name the binding.
    const { model: m } = await loadModelText(`package SBV {
      part def T0 { attribute load : ScalarValues::Real default = 1.0; }
      part def T1 { part a : T0; }
      part top : T1;
      part pp : T0 = top.a;
      attribute seven : ScalarValues::Real = 7.0;
      bind pp.load = seven;
      constraint pT { pp.load >= 5.0 }
      constraint aT { top.a.load >= 5.0 }
      constraint typo { pp.lod >= 5.0 }
    }`);
    // A typo is the author's defect on every surface: the numeric row keeps saying the name has no value.
    expect(checkConstraintsNumeric(m!).find((r) => r.name === 'typo')!.reason).toContain('has no value in scope');
    for (const name of ['pT', 'aT']) {
      const row = checkConstraintsNumeric(m!).find((r) => r.name === name)!;
      expect([name, row.result], name).toEqual([name, 'unknown']);
      expect(row.reason, name).toContain('`pp = top.a` in SBV values a part');
      expect(row.reason, name).not.toContain('has no value in scope');
    }
  });

  /** The numeric surface's row of `rel` read in the context `ctx` (`rel@ctx`). */
  const numericIn = (m: Model, rel: string, ctx: string) =>
    checkConstraintsNumeric(m).find((r) => {
      const [base, at] = String(r.id).split('@');
      return at !== undefined && m.qualifiedName(base!) === rel && m.qualifiedName(at) === ctx;
    })?.result;

  it('reads a definition’s relation in an instance that rebinds a reference on its path, or renames a part on it (v8x, v8xd, v8n)', async () => {
    const shapes = {
      V8X: { W: 'ref part top : T1; ref part pp : T0 = top.a;', w: 'ref part :>> top = t50;', read: 'pp.load', at: 'V8X::t50::a' },
      V8XD: { W: 'ref part top : T1;', w: 'ref part :>> top = t50;', read: 'top.a.load', at: 'V8XD::t50::a' },
      V8N: { W: 'part top : T1; ref part pp : T0 = top.a;', w: 'part top2 redefines top { attribute :>> L = 50.0; }', read: 'pp.load', at: 'V8N::w::top2::a' },
    };
    for (const [name, s] of Object.entries(shapes)) {
      const { model: m, report } = await loadModelText(`package ${name} {
        ${T}
        part t50 : T1 { attribute :>> L = 50.0; }
        part def W { ${s.W} constraint pT { ${s.read} >= 40.0 } constraint pF { ${s.read} <= 5.0 } }
        part w : W { ${s.w} }
      }`, { fileName: `${name}.sysml`, strict: true });
      // w reads it in t50's a, or in its own top2's a, where L is 50; W reads it in W's own top's a (1). The
      // feature is T1's a's load in both, so no row was filed for w: W's pF held for every W, `sysml-check
      // --strict` passed and `verify` exited 0 (O9's review).
      expect(sharedDefinitions(m!).denote(named(m!, `${name}::w`).id).get(s.read)!.instance, name).toBe(s.at);
      for (const [rel, own, there] of [
        ['pT', 'violated', 'satisfied'],
        ['pF', 'satisfied', 'violated'],
      ] as const) {
        const c = check(m!, `${name}::W::${rel}`);
        expect([c.result, c.instances!.map((i) => [m!.qualifiedName(i.contextId), i.result])], `${name} ${rel}`).toEqual([
          own,
          [[`${name}::w`, there]],
        ]);
        expect(numericIn(m!, `${name}::W::${rel}`, `${name}::w`), `${name} ${rel}`).toBe(there);
        expect(goal(m!, `${name}::W::${rel} in ${name}::w`).encodable, `${name} ${rel}`).toBe(true);
      }
      expect(report.diagnostics.some((d) => d.severity === 'warning' && d.message.includes('= 50 misses W::pF')), name).toBe(true);
    }
  });

  it('reads no satisfaction, or subject, a definition writes where an instance reads its satisfier otherwise (sd0, sd1, sbj0)', async () => {
    const RF = 'requirement def RF { subject s : T0; require constraint { s.load <= 5.0 } }';
    const p50 = 'part :>> p1 { attribute :>> load = 50.0; }';
    const shapes = {
      SD0: { W: 'part p1 : T0; satisfy RF by p1;', w: p50, ctx: 'SD0::W::«Satisfy»', said: '`satisfy RF by p1` in SD0::W is read at SD0::W’s' },
      SD1: { W: 'part top : T1; satisfy RF by top.a;', w: 'part :>> top { attribute :>> L = 50.0; }', ctx: 'SD1::W::«Satisfy»', said: '`satisfy RF by top.a` in SD1::W is read at SD1::W’s' },
      SBJ0: { W: 'part p1 : T0; requirement q : RF { subject s = p1; }', w: p50, ctx: 'SBJ0::W::q', said: '`subject s = p1` in SBJ0::W::q is read at SBJ0::W’s' },
    };
    for (const [name, s] of Object.entries(shapes)) {
      const { model: m, report } = await loadModelText(`package ${name} { ${T} ${RF} part def W { ${s.W} } part w : W { ${s.w} } }`, {
        fileName: `${name}.sysml`,
        strict: true,
      });
      // Every surface reads it once, at W's own values (1), never in each instance of W: w's 50 breaks RF, yet
      // no row was filed for it, `sysml-check --strict` passed and `verify` exited 0 (O9's review). Its row
      // abstains now, naming the instance, on every surface.
      const rows = check(m!, `${name}::RF::«ConstraintUsage»`).instances!;
      expect(rows.map((i) => [m!.qualifiedName(i.contextId), i.result]), name).toEqual([[s.ctx, 'unknown']]);
      expect(rows[0]!.message.replace(/'/g, '’'), name).toContain(s.said);
      expect(rows[0]!.message, name).toContain(`${name}::w reads`);
      expect(numericIn(m!, `${name}::RF::«ConstraintUsage»`, s.ctx), name).toBe('unknown');
      const g = obligationsOf(m!).find((o) => o.role !== 'axiom' && o.instance?.contextId === rows[0]!.contextId)!;
      expect(g.encodable, name).toMatchObject({ reason: 'unread-binding' });
      expect(report.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message), name).toEqual([]);
    }
    // A requirement usage's own clause over the subject abstains with it.
    const { model: own } = await loadModelText(`package SBJOWN { ${T}
      requirement def RG { subject s : T0; }
      part def W { part p1 : T0; requirement q : RG { subject s = p1; require constraint qc { s.load <= 5.0 } } }
      part w : W { ${p50} }
    }`);
    expect(check(own!, 'SBJOWN::W::q::qc').result).toBe('unknown');
    expect(goal(own!, 'SBJOWN::W::q::qc').encodable).toMatchObject({ reason: 'unread-binding' });
    // An instance that changes nothing the satisfier reads — none at all, another part, another feature of p1 —
    // reads it as W does: no row of its own, nothing withheld.
    const { model: same } = await loadModelText(`package NC1 {
      part def T0 { attribute load : ScalarValues::Real default = 1.0; attribute tag : ScalarValues::Real default = 0.0; }
      ${RF}
      part def W { part p1 : T0; part p2 : T0; satisfy RF by p1; requirement q : RF { subject s = p1; } }
      part w0 : W;
      part w1 : W { part :>> p2 { attribute :>> load = 50.0; } }
      part w2 : W { part :>> p1 { attribute :>> tag = 9.0; } }
    }`);
    const c = check(same!, 'NC1::RF::«ConstraintUsage»');
    expect([c.result, c.instances ?? []]).toEqual(['satisfied', []]);
  });

  it('reads a satisfaction in the instance it is written in: its own redefinition of the satisfier, or one it inherits (nc2, sd0k, nc4)', async () => {
    const RF = 'requirement def RF { subject s : T0; require constraint { s.load <= 5.0 } }';
    const shapes = {
      // The relationship records W's p1, which w redefines: it read W's p1 (1), and held on all four surfaces.
      NC2: { body: `part def W { part p1 : T0; } part w : W { part :>> p1 { attribute :>> load = 50.0; } satisfy RF by p1; }`, ctx: 'NC2::w::«Satisfy»' },
      SD0K: { body: `part def W { part p1 : T0; } part w : W { part :>> p1 { attribute :>> load = 50.0; } } satisfy RF by w.p1;`, ctx: 'SD0K::«Satisfy»' },
      // sys's p1 is W's, whose load W's binding gives sys's K: it read W's p1 at W's K (1).
      NC4: {
        body: `part def W { part p1 : T0; attribute K : ScalarValues::Real default = 1.0; bind p1.load = K; } part sys : W { attribute :>> K = 50.0; satisfy RF by p1; }`,
        ctx: 'NC4::sys::«Satisfy»',
      },
    };
    for (const [name, s] of Object.entries(shapes)) {
      const { model: m, report } = await loadModelText(`package ${name} { ${T} ${RF} ${s.body} }`, { fileName: `${name}.sysml`, strict: true });
      const rows = check(m!, `${name}::RF::«ConstraintUsage»`).instances!;
      expect(rows.map((i) => [m!.qualifiedName(i.contextId), i.result]), name).toEqual([[s.ctx, 'violated']]);
      expect(numericIn(m!, `${name}::RF::«ConstraintUsage»`, s.ctx), name).toBe('violated');
      const g = obligationsOf(m!).find((o) => o.role !== 'axiom' && o.instance?.contextId === rows[0]!.contextId)!;
      const at = name === 'NC4' ? 'sys' : 'w';
      expect([g.encodable, g.vars.map((v) => v.qualifiedName)], name).toEqual([true, [`${name}::${at}::p1::load`]]);
      // A warning, so `sysml-check --strict` fails. Which of the two per-context codes a value a binding carries
      // into a `satisfy` context belongs to (NC4: sys's K through W's `bind p1.load = K`) is the
      // constraint-by-instance revisit's to weigh, so the code is not pinned here.
      const codes = ['validation/target-by-specialisation', 'validation/constraint-by-instance'];
      expect(report.diagnostics.some((d) => d.severity === 'warning' && codes.includes(d.code ?? '')), name).toBe(true);
    }
  });

  it('reads a reference a nested usage writes in each instance, or abstains where its value names a feature around it (cown3, cown2)', async () => {
    const T0 = 'part def T0 { attribute load : ScalarValues::Real default = 1.0; }';
    // W's sub's `r = x` reached as `w.sub.r` is w's sub's x, whose load W's binding gives w's K of 50: it named W's
    // own sub's x (K's default 1), T on all four surfaces, beside `w.sub.x.load` read F.
    const { model: own } = await loadModelText(`package COWN3 { ${T0}
      part def W { attribute K : ScalarValues::Real default = 1.0; part sub { part x : T0; ref part r : T0 = x; } bind sub.x.load = K; }
      part w : W { attribute :>> K = 50.0; }
      constraint k { w.sub.r.load <= 5.0 }
    }`);
    expect(sharedDefinitions(own!).denote(named(own!, 'COWN3').id).get('w.sub.r.load')!.instance).toBe('COWN3::w::sub::x');
    expect([check(own!, 'COWN3::k').result, numeric(own!, 'COWN3::k'), goal(own!, 'COWN3::k').encodable]).toEqual(['violated', 'violated', true]);
    // W's sub's `r = p1` names W's p1, around sub: read at W's own p1 (1) for every W, where w's is 50, both the
    // relation sub writes and the package's read through w's sub held on all four surfaces. Each abstains now.
    const W = `part def W { part p1 : T0; part sub { ref part r : T0 = p1; constraint c { r.load <= 5.0 } } }`;
    const { model: out, report } = await loadModelText(`package COWN2 { ${T0} ${W}
      part w : W { part :>> p1 { attribute :>> load = 50.0; } }
      constraint k { w.sub.r.load <= 5.0 }
    }`, { fileName: 'cown2.sysml', strict: true });
    for (const rel of ['COWN2::W::sub::c', 'COWN2::k']) {
      const c = check(out!, rel);
      expect([c.result, numeric(out!, rel)], rel).toEqual(['unknown', 'unknown']);
      expect(c.message, rel).toContain('`r = p1` in COWN2::W::sub names a feature of COWN2::W, which is read at COWN2::W');
      expect(c.message, rel).toContain('COWN2::w reads it otherwise');
      expect(goal(out!, rel).encodable, rel).toMatchObject({ reason: 'unread-binding' });
    }
    expect(report.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message)).toEqual([]);
    // Where no instance reads p1 otherwise, it reads as written.
    const { model: same } = await loadModelText(`package COWN0 { ${T0} ${W} part w : W; }`);
    expect([check(same!, 'COWN0::W::sub::c').result, numeric(same!, 'COWN0::W::sub::c')]).toEqual(['satisfied', 'satisfied']);
    // A group that reads each instance re-resolves such a reference there (X17's q1 T, q2 not read), and keeps its
    // rows; a read from outside (`q2.p.r.x`, Q's own s's 2 where q2's is 100) abstains.
    const { model: grp } = await loadModelText(`package X17K {
      part def R { attribute k : ScalarValues::Real default = 1.0; attribute x : ScalarValues::Real = 2.0 * k; }
      part def P { attribute load : ScalarValues::Real default = 1.0; ref part r : R; constraint c { load + r.x <= 10.0 } }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part s : R; part p : P { ref part :>> r = s; } bind p.load = L; }
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q { part :>> s { attribute :>> k = 50.0; } }
      constraint k { q2.p.r.x <= 10.0 }
    }`);
    expect(check(grp!, 'X17K::P::c').instances!.map((i) => [i.instance ?? grp!.qualifiedName(i.contextId), i.result])).toEqual([
      ['X17K::Q::p', 'satisfied'],
      ['X17K::q1::p', 'satisfied'],
      ['X17K::q2::p', 'unknown'],
    ]);
    expect([check(grp!, 'X17K::k').result, numeric(grp!, 'X17K::k')]).toEqual(['unknown', 'unknown']);
  });

  it('reads no satisfaction, or subject, whose requirement reads the satisfier through a feature of its own where an instance reads it otherwise (sm1, sm3, sm6, sm2)', async () => {
    const m = 'attribute m : ScalarValues::Real = s.load; require constraint { m <= 5.0 }';
    const p50 = 'part :>> p1 { attribute :>> load = 50.0; }';
    const shapes = {
      // Only the names a clause spells through the subject were read: R's own `m` (over `s.load`, or a binding
      // to it) was dropped, w was never found to read p1 otherwise, and RF held on all four surfaces (the
      // review of per-instance-rest S1).
      SM1: { R: `requirement def RF { subject s : T0; ${m} }`, W: 'part p1 : T0; satisfy RF by p1;', ctx: 'SM1::W::«Satisfy»', said: '`satisfy RF by p1` in SM1::W is read at SM1::W’s' },
      SM6: {
        R: 'requirement def RF { subject s : T0; attribute m : ScalarValues::Real; bind m = s.load; require constraint { m <= 5.0 } }',
        W: 'part p1 : T0; satisfy RF by p1;',
        ctx: 'SM6::W::«Satisfy»',
        said: '`satisfy RF by p1` in SM6::W is read at SM6::W’s',
      },
      SM3: { R: `requirement def RF { subject s : T0; ${m} }`, W: 'part p1 : T0; requirement q : RF { subject s = p1; }', ctx: 'SM3::W::q', said: '`subject s = p1` in SM3::W::q is read at SM3::W’s' },
    };
    for (const [name, s] of Object.entries(shapes)) {
      const { model: x, report } = await loadModelText(`package ${name} { ${T} ${s.R} part def W { ${s.W} } part w : W { ${p50} } }`, {
        fileName: `${name}.sysml`,
        strict: true,
      });
      const rel = `${name}::RF::«ConstraintUsage»`;
      const rows = check(x!, rel).instances!;
      expect(rows.map((i) => [x!.qualifiedName(i.contextId), i.result]), name).toEqual([[s.ctx, 'unknown']]);
      expect(rows[0]!.message.replace(/'/g, '’'), name).toContain(s.said);
      expect(rows[0]!.message, name).toContain(`${name}::w reads`);
      expect(numericIn(x!, rel, s.ctx), name).toBe('unknown');
      const g = obligationsOf(x!).find((o) => o.role !== 'axiom' && o.instance?.contextId === rows[0]!.contextId)!;
      expect(g.encodable, name).toMatchObject({ reason: 'unread-binding' });
      expect(report.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message), name).toEqual([]);
    }
    // A requirement usage's own clause over a feature of its own that reads the subject abstains with it.
    const { model: own } = await loadModelText(`package SM2 { ${T}
      requirement def RG { subject s : T0; }
      part def W { part p1 : T0; requirement q : RG { subject s = p1; ${m.replace('require constraint', 'require constraint qc')} } }
      part w : W { ${p50} }
    }`);
    expect([check(own!, 'SM2::W::q::qc').result, numeric(own!, 'SM2::W::q::qc')]).toEqual(['unknown', 'unknown']);
    expect(goal(own!, 'SM2::W::q::qc').encodable).toMatchObject({ reason: 'unread-binding' });
    // Read from outside through the subject, any feature below p1 counts, not only what R's clauses read: RF's
    // `s.tag` w leaves alone (no row of w's), but `w.q.s.load` read W's own p1's 1 where w's is 50.
    const { model: out } = await loadModelText(`package SBO {
      part def T0 { attribute load : ScalarValues::Real default = 1.0; attribute tag : ScalarValues::Real default = 0.0; }
      requirement def RF { subject s : T0; require constraint { s.tag <= 5.0 } }
      part def W { part p1 : T0; requirement q : RF { subject s = p1; } }
      part w : W { ${p50} }
      constraint k { w.q.s.load <= 5.0 }
    }`);
    expect([check(out!, 'SBO::RF::«ConstraintUsage»').result, check(out!, 'SBO::RF::«ConstraintUsage»').instances ?? []]).toEqual(['satisfied', []]);
    expect([check(out!, 'SBO::k').result, numeric(out!, 'SBO::k'), goal(out!, 'SBO::k').encodable]).toMatchObject(['unknown', 'unknown', { reason: 'unread-binding' }]);
    expect(check(out!, 'SBO::k').message).toContain('`subject s = p1` in SBO::W::q is read at SBO::W');
    // Followed through `m`, the test reads what R reads: an instance that changes another feature of p1 reads the
    // satisfaction and q as W does, no row of its own, nothing withheld.
    const { model: tag } = await loadModelText(`package NC1M {
      part def T0 { attribute load : ScalarValues::Real default = 1.0; attribute tag : ScalarValues::Real default = 0.0; }
      requirement def RF { subject s : T0; ${m} }
      part def W { part p1 : T0; satisfy RF by p1; requirement q : RF { subject s = p1; } }
      part w2 : W { part :>> p1 { attribute :>> tag = 9.0; } }
    }`);
    const t = check(tag!, 'NC1M::RF::«ConstraintUsage»');
    expect([t.result, t.instances ?? []]).toEqual(['satisfied', []]);
    // W's own p1 at 50, which no instance reads otherwise, reads as written: violated.
    const { model: same } = await loadModelText(`package SM1W { ${T}
      requirement def RF { subject s : T0; ${m} }
      part def W { part p1 : T0 { attribute :>> load = 50.0; } satisfy RF by p1; }
    }`);
    const c = check(same!, 'SM1W::RF::«ConstraintUsage»');
    expect(c.instances!.map((i) => [same!.qualifiedName(i.contextId), i.result])).toEqual([['SM1W::W::«Satisfy»', 'violated']]);
  });

  it('reads a definition’s relation in an instance that rebinds a reference a value it reads goes through (rb9, rb9d, rb10, rbb1, rbd16n)', async () => {
    // A chain of `n + 1` values, m = m1 … mn = pp.load.
    const chain = (n: number) =>
      `ref part top : T1; ref part pp : T0 = top.a; attribute m : ScalarValues::Real = m1; ${Array.from(
        { length: n - 1 },
        (_, i) => `attribute m${i + 1} : ScalarValues::Real = m${i + 2};`,
      ).join(' ')} attribute m${n} : ScalarValues::Real = pp.load;`;
    const shapes = {
      RB9: { W: 'ref part top : T1; ref part pp : T0 = top.a; attribute m : ScalarValues::Real = pp.load;', w: 'ref part :>> top = t50;', there: 'violated' },
      RB9D: { W: 'ref part top : T1; attribute m : ScalarValues::Real = top.a.load;', w: 'ref part :>> top = t50;', there: 'violated' },
      // Through a binding rather than a value (RBB1, RBB2), and past 16 values (RBD16N, where both readings ended
      // in one mark): no row was filed for w on any surface until the branch review.
      RBB1: { W: 'ref part top : T1; ref part pp : T0 = top.a; attribute m : ScalarValues::Real; bind m = pp.load;', w: 'ref part :>> top = t50;', there: 'violated' },
      RBB2: { W: 'ref part top : T1; attribute m : ScalarValues::Real; bind m = top.a.load;', w: 'ref part :>> top = t50;', there: 'violated' },
      RBD15N: { W: chain(15), w: 'ref part :>> top = t50;', there: 'violated' },
      RBD16N: { W: chain(16), w: 'ref part :>> top = t50;', there: 'violated' },
      // w's top2 renames W's top, and the `top.a` W's pp is valued with names no feature of w: the row is w's
      // own, and abstains (the name-scope rule), where W's 1 stood for w's 50.
      RB10: { W: 'part top : T1; ref part pp : T0 = top.a; attribute m : ScalarValues::Real = pp.load;', w: 'part top2 redefines top { attribute :>> L = 50.0; }', there: 'unknown' },
    };
    for (const [name, s] of Object.entries(shapes)) {
      const { model: x, report } = await loadModelText(`package ${name} {
        ${T}
        part t50 : T1 { attribute :>> L = 50.0; }
        part def W { ${s.W} constraint pF { m <= 5.0 } }
        part w : W { ${s.w} }
      }`, { fileName: `${name}.sysml`, strict: true });
      // m is W's own in W and in w, read alike by name, so no row was filed for w: W's pF held for every W,
      // `sysml-check --strict` passed and `verify` exited 0 (the review of per-instance-rest S1).
      const c = check(x!, `${name}::W::pF`);
      expect([c.result, c.instances!.map((i) => [x!.qualifiedName(i.contextId), i.result])], name).toEqual([
        'satisfied',
        [[`${name}::w`, s.there]],
      ]);
      expect(numericIn(x!, `${name}::W::pF`, `${name}::w`), name).toBe(s.there);
      if (s.there === 'violated') {
        expect(goal(x!, `${name}::W::pF in ${name}::w`).encodable, name).toBe(true);
        expect(report.diagnostics.some((d) => d.severity === 'warning' && d.message.includes('w::m = 50 misses W::pF')), name).toBe(true);
      }
    }
    // A value's name resolved outward of where it is written (Q's `pl` for Q's p), or one only a nested usage of
    // the instance answers under that name (q's p's own L, where Q's p's `load = L` names Q's), lands nowhere
    // else: no row of the instance's own. The first is q0's, as Q's; the second DY1's misreading (KNOWN_FALSE).
    const P = 'part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }';
    for (const [name, rest] of [
      ['LexU', 'part def Q { attribute L : ScalarValues::Real default = 1.0; attribute pl : ScalarValues::Real = 2.0 * L; part p : P { attribute :>> load = pl; } constraint c { p.m2 >= 0.0 } } part q0 : Q;'],
      ['DY1', 'part def Q { attribute L : ScalarValues::Real = 1.0; part p : P { attribute :>> load = L; } constraint c { p.m2 >= 0.0 } } part q : Q { part :>> p { attribute L : ScalarValues::Real = 50.0; } }'],
    ] as const) {
      const { model: x } = await loadModelText(`package ${name} { ${P} ${rest} }`);
      expect(check(x!, `${name}::Q::c`).instances ?? [], name).toEqual([]);
    }
  });

  it('abstains on a relation read through a value or a binding over a reference an instance reads otherwise, and through a valueless reference redefinition (rc7, rc7b, vr1, cown7)', async () => {
    const T0 = 'part def T0 { attribute load : ScalarValues::Real default = 1.0; }';
    const p50 = 'part :>> p1 { attribute :>> load = 50.0; }';
    // A value or a binding over W's sub's `r = p1` read W's own p1 (1) for every W, where w's is 50: true on all
    // four surfaces, as the reference itself was before it abstained (the review of per-instance-rest S1).
    for (const [name, W, read] of [
      ['RC7', 'part p1 : T0; part sub { ref part r : T0 = p1; attribute m : ScalarValues::Real = r.load; } constraint c { sub.m <= 5.0 }', 'w.sub.m'],
      ['RC7B', 'part p1 : T0; part sub { ref part r : T0 = p1; } attribute m : ScalarValues::Real = sub.r.load; constraint c { m <= 5.0 }', 'w.m'],
      ['RC7C', 'part p1 : T0; part sub { ref part r : T0 = p1; } attribute m : ScalarValues::Real; bind m = sub.r.load; constraint c { m <= 5.0 }', 'w.m'],
    ] as const) {
      const { model: x, report } = await loadModelText(`package ${name} { ${T0} part def W { ${W} } part w : W { ${p50} } constraint k { ${read} <= 5.0 } }`, {
        fileName: `${name}.sysml`,
        strict: true,
      });
      for (const rel of [`${name}::W::c`, `${name}::k`]) {
        const c = check(x!, rel);
        expect([c.result, numeric(x!, rel)], rel).toEqual(['unknown', 'unknown']);
        expect(c.message, rel).toContain(`\`r = p1\` in ${name}::W::sub names a feature of ${name}::W`);
        expect(goal(x!, rel).encodable, rel).toMatchObject({ reason: 'unread-binding' });
      }
      expect(report.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message), name).toEqual([]);
    }
    // `ref part :>> r;` states no value of W's `r = x`: the walk read a fresh T0 (1) for w's r where x is 50.
    const { model: vr } = await loadModelText(`package VR1 { ${T0}
      part def W { part x : T0 { attribute :>> load = 50.0; } ref part r : T0 = x; constraint c { r.load <= 5.0 } }
      part w : W { ref part :>> r; }
      constraint k { w.r.load <= 5.0 }
    }`);
    const c = check(vr!, 'VR1::W::c');
    expect([c.result, c.instances!.map((i) => [vr!.qualifiedName(i.contextId), i.result])]).toEqual(['violated', [['VR1::w', 'unknown']]]);
    expect(c.instances![0]!.message).toContain('`r` in VR1::w redefines VR1::W::r (`= x`) and states no value of its own');
    expect([check(vr!, 'VR1::k').result, numeric(vr!, 'VR1::k'), goal(vr!, 'VR1::k').encodable]).toMatchObject(['unknown', 'unknown', { reason: 'unread-binding' }]);
    // So the copy a binding's end written in w makes of W's valued pp (RBB4K): `w.m` read a fresh T0's 1 there, on
    // all four surfaces, where w's `ref part :>> top = t50` makes it 50 (the branch review of per-instance-rest).
    const { model: rbb } = await loadModelText(`package RBB4K { ${T0}
      part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; bind a.load = L; }
      part t50 : T1 { attribute :>> L = 50.0; }
      part def W { ref part top : T1; ref part pp : T0 = top.a; attribute m : ScalarValues::Real; constraint pF { m <= 5.0 } }
      part w : W { ref part :>> top = t50; bind m = pp.load; }
      constraint k { w.m <= 5.0 }
    }`);
    const k = check(rbb!, 'RBB4K::k');
    expect([k.result, numeric(rbb!, 'RBB4K::k'), goal(rbb!, 'RBB4K::k').encodable]).toMatchObject(['unknown', 'unknown', { reason: 'unread-binding' }]);
    expect(k.message).toContain("the copy of RBB4K::W::pp (`= top.a`) that a binding's end makes in RBB4K::w as `pp` states no value of its own");
    expect([check(rbb!, 'RBB4K::W::pF').result, check(rbb!, 'RBB4K::W::pF').instances ?? []]).toEqual(['unknown', []]);
    // The same nested, over an outward reference: w's sub's row was T on the engines (a new row of S1's), k T.
    const { model: nested } = await loadModelText(`package COWN7 { ${T0}
      part def W { part p1 : T0; part sub { ref part r : T0 = p1; constraint c { r.load <= 5.0 } } }
      part w : W { ${p50} part :>> sub { ref part :>> r; } }
      constraint k { w.sub.r.load <= 5.0 }
    }`);
    expect([check(nested!, 'COWN7::k').result, goal(nested!, 'COWN7::k').encodable]).toMatchObject(['unknown', { reason: 'unread-binding' }]);
    for (const o of obligationsOf(nested!).filter((g) => g.role !== 'axiom' && g.element.qualifiedName === 'COWN7::W::sub::c')) {
      expect(o.encodable, o.instance?.contextId ?? 'own').toMatchObject({ reason: 'unread-binding' });
    }
  });
});

describe('an enclosing equation read through a binding or a reference, and a relation read through one (O9 S2)', () => {
  const check = (m: Model, rel: string) => checkConstraints(m).find((k) => m.qualifiedName(k.id) === rel)!;
  const numeric = (m: Model, rel: string) => checkConstraintsNumeric(m).find((r) => m.qualifiedName(r.id) === rel)!.result;
  const goal = (m: Model, rel: string) => obligationsOf(m).find((o) => o.role !== 'axiom' && o.element.qualifiedName === rel)!;
  const rowsOf = (m: Model, rel: string) =>
    (check(m, rel).instances ?? []).map((i) => [i.instance ?? m.qualifiedName(i.contextId), i.result]);

  it('reads a definition’s relation in a context whose usage changes an input the owner reads in another (n02)', async () => {
    const { model: m } = await loadModelText(`package N02 {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0; attribute m2 : ScalarValues::Real = 10.0 - load - extra; }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; constraint c { p.m2 >= 0.0 } }
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q { part :>> p { attribute :>> extra = 50.0; } }
      part q5 : Q { part :>> p { attribute tag : ScalarValues::Real = 1.0; } }
    }`);
    // q2's m2 is 10 − 1 − 50: Q reads m2 in Q's p (its binding changes load) and q2 in q2's p (its extra), so
    // the two readings looked alike and q2 had no row, and `sysml-check --strict` passed. q5 changes no input.
    expect(rowsOf(m!, 'N02::Q::c')).toEqual([
      ['N02::q1', 'satisfied'],
      ['N02::q2', 'violated'],
    ]);
    const { report } = await loadModelText(`package N02 {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0; attribute m2 : ScalarValues::Real = 10.0 - load - extra; }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; constraint c { p.m2 >= 0.0 } }
      part q2 : Q { part :>> p { attribute :>> extra = 50.0; } }
    }`, { fileName: 'n02.sysml', strict: true });
    expect(report.ok).toBe(false);
    expect(report.diagnostics.some((d) => d.severity === 'warning' && d.message.includes('= -41 misses Q::c'))).toBe(true);
  });

  it('checks an equation whose other side only usages value against the default, in each such instance (PIN2, invariant (e))', async () => {
    const { model: m } = await loadModelText(`package PIN2 {
      part def P { attribute L : ScalarValues::Real default = 2.0; attribute M : ScalarValues::Real; assert constraint qa { L == M } constraint c { L <= 6.0 } }
      part p : P { attribute :>> M = 7.0; }
      part p2 : P { attribute :>> M = 5.0; }
      part p3 : P { attribute :>> M default = 4.0; }
      constraint top { p.L <= 6.0 }
      constraint top2 { p2.L <= 6.0 }
      constraint top3 { p3.L <= 6.0 }
    }`);
    // L's default 2 stands in every P, against which `qa` is checked where a usage values M (7, 5, and p3's
    // `default = 4.0`): violated in each; P's own L is 2, the equation defining M from it (decision 14 keeps a
    // feature without a value). It read p's L 7 and p2's 5 (invariant (e)), and abstained on p3 (U7).
    expect(['PIN2::top', 'PIN2::top2', 'PIN2::top3', 'PIN2::P::c'].map((r) => [check(m!, r).result, numeric(m!, r)])).toEqual([
      ['satisfied', 'satisfied'],
      ['satisfied', 'satisfied'],
      ['satisfied', 'satisfied'],
      ['satisfied', 'satisfied'],
    ]);
    expect(rowsOf(m!, 'PIN2::P::c')).toEqual([]);
    expect(rowsOf(m!, 'PIN2::P::qa')).toEqual([
      ['PIN2::p', 'violated'],
      ['PIN2::p2', 'violated'],
      ['PIN2::p3', 'violated'],
    ]);
  });

  it('checks an assert past the part a plain part-valued binding has another end stand for against its default (SF)', async () => {
    const { model: m } = await loadModelText(`package SF {
      part def P { attribute x : ScalarValues::Real default = 2.0; }
      part def Q { part p : P; assert constraint tie { p.x == 50.0 } }
      part q : Q;
      part pp : P;
      bind pp = q.p;
      constraint k { pp.x <= 10.0 }
      constraint k2 { q.p.x <= 10.0 }
    }`);
    // q's p is its own instance, which pp stands for: its x is P's 2, which Q's assert does not replace (it read
    // the assert's 50 while an asserted equation replaced a default), and the assert is reported violated.
    expect(['SF::k', 'SF::k2'].map((r) => [check(m!, r).result, numeric(m!, r)])).toEqual([
      ['satisfied', 'satisfied'],
      ['satisfied', 'satisfied'],
    ]);
    expect(check(m!, 'SF::Q::tie').result).toBe('violated');
  });

  it('reads the default an assert meets through a binding’s end, a reference or a valued part (RB3, RB5, RF)', async () => {
    const texts = {
      RB3: `part def P { attribute x : ScalarValues::Real; }
        part q { part p : P; attribute L : ScalarValues::Real default = 4.0; bind p.x = L; }
        assert constraint tie { q.p.x == 3.0 }
        constraint top { q.L <= 3.5 }`,
      RB5: `part def P { attribute x : ScalarValues::Real; }
        part def Q { part p : P; assert constraint tie { p.x == 50.0 } }
        part q1 : Q { attribute K : ScalarValues::Real default = 9.0; bind p.x = K; }
        constraint top { q1.K <= 10.0 }`,
      RF: `part def P { attribute x : ScalarValues::Real default = 2.0; }
        part def Q { ref part r : P; assert constraint tie { r.x == 50.0 } }
        part p1 : P;
        part q : Q { ref part :>> r = p1; }
        constraint top { p1.x <= 10.0 }`,
    };
    // Each read the default against the assert (RB3: 4, violated; RB5: 9, held; RF: 2, held) — and abstained on
    // every surface while decision 14 gave 3, 50 and 50. No assertion replaces a default since it was amended
    // (2026-10-22): RB3 and RF read their default again, on every surface. RB5's K stands at 9 too, but Q's
    // assert, which holds at q1 and is violated there, is read for q1 by no surface: read without it, K's 9 was
    // held everywhere and the model passed unreported, so every reading of the pair abstains, an unread binding.
    const read = { RB3: 'violated', RB5: 'unknown', RF: 'satisfied' } as const;
    for (const [name, body] of Object.entries(texts)) {
      const { model: m } = await loadModelText(`package ${name} { ${body} }`);
      const want = read[name as keyof typeof read];
      expect([check(m!, `${name}::top`).result, numeric(m!, `${name}::top`)], name).toEqual([want, want]);
      if (want === 'unknown') expect(goal(m!, `${name}::top`).encodable, name).toMatchObject({ reason: 'unread-binding' });
      else expect(goal(m!, `${name}::top`).encodable, name).toBe(true);
    }
    const { model: rb5 } = await loadModelText(`package RB5 { ${texts.RB5} }`);
    expect(check(rb5!, 'RB5::top').message).toContain(
      'is not read where `bind p.x = K` in RB5::q1 joins p.x to a `default`, which no assertion replaces',
    );
  });

  it('reads a relation in a context below which an assert, or a usage valuing a name, constrains what it reads, at its default', async () => {
    const P = 'part def P { attribute L : ScalarValues::Real default = 2.0; attribute M : ScalarValues::Real; assert constraint qa { L == M } }';
    const texts = {
      // q's p values M, so P's `L == M` makes q's p's L 7 (pinL2); a nested context, and a derived value over it.
      PL2: `${P} part def Q { part p : P; constraint cq { p.L <= 6.0 } } part q : Q { part :>> p { attribute :>> M = 7.0; } }`,
      PL5: `${P} part def Q { part p : P; } part def W { part q : Q; constraint cw { q.p.L <= 6.0 } }
        part w : W { part :>> q { part :>> p { attribute :>> M = 7.0; } } }`,
      PL6: `${P} part def Q { part p : P; attribute y : ScalarValues::Real = p.L * 1.0; constraint cq { y <= 6.0 } }
        part q : Q { part :>> p { attribute :>> M = 7.0; } }`,
      // w's q asserts its p's x 50, and W's pp stands for that p (sfW); q2's p asserts its own extra 20 (h5bQ2).
      SFW: `part def P { attribute x : ScalarValues::Real default = 2.0; } part def Q { part p : P; }
        part def W { part pp : P; part q : Q; bind pp = q.p; constraint cw { pp.x <= 10.0 } }
        part w : W { part :>> q { assert constraint tie { p.x == 50.0 } } }`,
      HQ2: `part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0; }
        part def Q { part p : P; constraint cq { p.load + p.extra <= 10.0 } }
        part q2 : Q { part :>> p { assert constraint a1 { extra == 20.0 } } }`,
    };
    const rows: Record<string, [string, string]> = {
      PL2: ['PL2::Q::cq', 'PL2::q'],
      PL5: ['PL5::W::cw', 'PL5::w'],
      PL6: ['PL6::Q::cq', 'PL6::q'],
      SFW: ['SFW::W::cw', 'SFW::w'],
      HQ2: ['HQ2::Q::cq', 'HQ2::q2'],
    };
    // Each read only the owner's own value, true there, with no row for the context: `sysml-check --strict`
    // said OK on a model whose context read the assert's value (it was then read there, and violated). No
    // assertion replaces a default since decision 14 was amended (2026-10-22): the context reads the owner's
    // default, as the owner does, and the assert is reported violated against it — the check still fails.
    for (const [name, body] of Object.entries(texts)) {
      const text = `package ${name} { ${body} }`;
      const { model: m, report } = await loadModelText(text, { fileName: `${name}.sysml`, strict: true });
      const [rel, context] = rows[name]!;
      expect([check(m!, rel).result, ...rowsOf(m!, rel)], `${name} ${context}`).toEqual(['satisfied']);
      expect(report.ok, name).toBe(false);
    }
  });

  it('reads the default a binding carries against an assert over it, wherever the binding or the assert is written', async () => {
    const texts = {
      // The binding in a redefinition of the assert's path, in the package, or in a definition around the instance.
      RB5C: `part def P { attribute x : ScalarValues::Real; } part def Q { part p : P; assert constraint tie { p.x == 50.0 } }
        part q1 : Q { part :>> p { attribute K : ScalarValues::Real default = 9.0; bind x = K; } }
        constraint top { q1.p.K <= 10.0 }`,
      RB5D: `part def P { attribute x : ScalarValues::Real; } part def Q { part p : P; assert constraint tie { p.x == 50.0 } }
        part q1 : Q; attribute K : ScalarValues::Real default = 9.0; bind q1.p.x = K;
        constraint top { K <= 10.0 }`,
      RB5F: `part def P { attribute x : ScalarValues::Real; } part def Q { part p : P; assert constraint tie { p.x == 50.0 } }
        part def W { part q1 : Q; attribute K : ScalarValues::Real default = 9.0; bind q1.p.x = K; } part w : W;
        constraint top { w.K <= 10.0 }`,
      // The assert in a specialisation or a usage of the binding's owner, or beside it in the package.
      RBS1: `part def P { attribute x : ScalarValues::Real; }
        part def Q { part p : P; attribute L : ScalarValues::Real default = 4.0; bind p.x = L; }
        part def Q2 :> Q { assert constraint tie { p.x == 3.0 } } part q : Q2;
        constraint top { q.L <= 3.5 }`,
      RBS2: `part def P { attribute x : ScalarValues::Real; } part q { part p : P; }
        attribute L : ScalarValues::Real default = 4.0; bind q.p.x = L; assert constraint tie { q.p.x == 3.0 }
        constraint top { L <= 3.5 }`,
      RBS5: `part def P { attribute x : ScalarValues::Real; }
        part def Q { part p : P; attribute L : ScalarValues::Real default = 4.0; bind p.x = L; }
        part q : Q { assert constraint tie { p.x == 3.0 } }
        constraint top { q.L <= 3.5 }`,
      // A local equation over a name a usage values, its other side a binding's end (pinJ: q's p's L is 7).
      PJ: `part def P { attribute L : ScalarValues::Real default = 2.0; attribute M : ScalarValues::Real; assert constraint qa { L == M } }
        part q { part p : P { attribute :>> M = 7.0; } attribute K : ScalarValues::Real default = 1.0; bind p.L = K; }
        constraint top { q.p.L <= 6.0 }
        constraint topK { q.K <= 6.0 }`,
    };
    // Each read the binding's default against the assert (RB5*'s K 9, held; RBS*'s L 4, the assert reported
    // violated; PJ's K 1, held on the numeric surface), and abstained on every surface while decision 14 gave 50,
    // 3 and 7. No assertion replaces a default since it was amended (2026-10-22): RBS*'s L 4 is read again, and
    // RBS*'s assert reported violated against the 4. RB5*'s K stands at 9, against Q's assert at q1, which no
    // surface reads there: every reading of the pair abstains, an unread binding, as in RB5. PJ's binding joins
    // q's p's L default 2 to K's 1, two that differ: neither is read on any surface — not the 7 P's `L == M`
    // would carry into L at p's M (the numeric surface solved it so, and read K at P's own 2 across the binding,
    // `topK` T).
    const read = { RB5C: 'unknown', RB5D: 'unknown', RB5F: 'unknown', RBS1: 'violated', RBS2: 'violated', RBS5: 'violated', PJ: 'unknown' };
    for (const [name, body] of Object.entries(texts)) {
      const { model: m } = await loadModelText(`package ${name} { ${body} }`, { fileName: `${name}.sysml`, strict: true });
      const want = read[name as keyof typeof read];
      expect([check(m!, `${name}::top`).result, numeric(m!, `${name}::top`)], name).toEqual([want, want]);
      if (name.startsWith('RB5')) expect(goal(m!, `${name}::top`).encodable, name).toMatchObject({ reason: 'unread-binding' });
      else if (name !== 'PJ') expect(goal(m!, `${name}::top`).encodable, name).toBe(true);
    }
    const { model: pj } = await loadModelText(`package PJ { ${texts.PJ} }`);
    expect([check(pj!, 'PJ::topK').result, numeric(pj!, 'PJ::topK')]).toEqual(['unknown', 'unknown']);
    expect(check(pj!, 'PJ::topK').message).toMatch(/joins defaults that differ/);
  });

  it('checks a local equation over a name a binding joins to a value against the default, and reports the pair (pinA4)', async () => {
    const { model: m, report } = await loadModelText(`package PA4 {
      part def P { attribute L : ScalarValues::Real default = 2.0; attribute M : ScalarValues::Real; assert constraint qa { L == M } }
      part p : P { attribute :>> M = 7.0; }
      part p2 : P { attribute K : ScalarValues::Real = 9.0; bind M = K; }
      constraint top2 { p2.L <= 6.0 }
    }`, { fileName: 'pa4.sysml', strict: true });
    // p2's L is its default 2, which no assertion replaces (decision 14 amended 2026-10-22; it was read as K's 9
    // through M, and abstained): top2 holds. The equation defines M from that 2, which `bind M = K` joins to K's 9:
    // two values, which the binding's own row reports, and `qa` in p2 is not read.
    expect([check(m!, 'PA4::top2').result, numeric(m!, 'PA4::top2')]).toEqual(['satisfied', 'satisfied']);
    const bind = checkConstraints(m!).find((k) => k.conflict === 'bind')!;
    expect(bind.result).toBe('violated');
    expect(rowsOf(m!, 'PA4::P::qa')).toEqual([
      ['PA4::p', 'violated'],
      ['PA4::p2', 'unknown'],
    ]);
    expect(report.ok).toBe(false);
  });

  it('reads a package path two enclosing equations disagree on at its default, and checks both (LE)', async () => {
    const { model: m } = await loadModelText(`package LE {
      part def P { attribute x : ScalarValues::Real default = 2.0; assert constraint own { x == 3.0 } }
      part def Q { part p : P; }
      part q1 : Q { assert constraint tie { p.x == 50.0 } }
      constraint top { q1.p.x <= 10.0 }
    }`);
    // x is P's 2 at q1's p, and both asserts are checked against it (top read P's 3, then abstained on two values).
    expect([check(m!, 'LE::top').result, check(m!, 'LE::P::own').result, check(m!, 'LE::q1::tie').result]).toEqual([
      'satisfied',
      'violated',
      'violated',
    ]);
  });

  it('reads a relation in a context below which a usage is typed by a definition that asserts what it reads, at its default', async () => {
    const P = 'part def P { attribute L : ScalarValues::Real default = 2.0; attribute M : ScalarValues::Real; assert constraint qa { L == M } }';
    const PX = `part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0;
      attribute m2 : ScalarValues::Real = 10.0 - load - extra; }`;
    const texts = {
      // P5 values M, so q's p, a P5, has L 7 (PL5T); through a specialisation of Q, and a derived value over it (PL7).
      PL5T: `${P} part def P5 :> P { attribute :>> M = 7.0; } part def Q { part p : P; constraint cq { p.L <= 6.0 } }
        part q : Q { part :>> p : P5; }`,
      PL7: `${P} part def P5 :> P { attribute :>> M = 7.0; }
        part def Q { part p : P; attribute y : ScalarValues::Real = p.L; constraint cq { y <= 6.0 } }
        part def Q2 :> Q { part :>> p : P5; } part q2 : Q2; part q : Q { part :>> p : P5; }`,
      // P2 asserts its extra 50 (N4: q2's m2 is 10 − 1 − 50) or 20 (C3).
      N4: `${PX} part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; constraint cq { p.m2 >= 0.0 } }
        part def P2 :> P { assert constraint a2 { extra == 50.0 } } part q2 : Q { part :>> p : P2; }`,
      C3: `${PX} part def Q { part p : P; constraint cq { p.load + p.extra <= 10.0 } }
        part def P2 :> P { assert constraint a2 { extra == 20.0 } } part q2 : Q { part :>> p : P2; }`,
    };
    const rows: Record<string, string[][]> = {
      PL5T: [['PL5T::q', 'violated']],
      PL7: [['PL7::Q2', 'violated'], ['PL7::q', 'violated']],
      N4: [['N4::q2', 'violated']],
      C3: [['C3::q2', 'violated']],
    };
    // Each read only Q's own value, true there, with no row for the context: `sysml-check --strict` said OK on
    // a model whose context read the assert's value (then read there, and violated: `rows`). No assertion
    // replaces a default since decision 14 was amended (2026-10-22): the context reads the default, as Q does,
    // and the assert is reported violated against it — the check still fails.
    for (const [name, body] of Object.entries(texts)) {
      const { model: m, report } = await loadModelText(`package ${name} { ${body} }`, { fileName: `${name}.sysml`, strict: true });
      const rel = `${name}::Q::cq`;
      expect([check(m!, rel).result, ...rowsOf(m!, rel)], `${name} ${JSON.stringify(rows[name])}`).toEqual(['satisfied']);
      expect(report.ok, name).toBe(false);
    }
  });

  it('checks an assert a definition typing a redefinition of the bound part writes against the binding’s default (M1, M3)', async () => {
    const texts = {
      M1: `part def P { attribute load : ScalarValues::Real; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def P2 :> P { assert constraint a2 { load == 50.0 } } part q2 : Q { part :>> p : P2; }
        constraint top { q2.L <= 10.0 }`,
      M3: `part def P { attribute load : ScalarValues::Real; } part def P2 :> P { assert constraint a2 { load == 50.0 } }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def Q3 :> Q { part :>> p : P2; } part q3 : Q3;
        constraint top { q3.L <= 10.0 }`,
    };
    // q2's p and q3's p are P2s, whose assert stood over the 1 the binding carries (decision 14), L 50, and every
    // surface abstained. No assertion replaces a default since it was amended (2026-10-22): L is its 1, which
    // the binding carries into the P2's load, and the assert is reported missed there, as for `L = 1.0`.
    for (const [name, body] of Object.entries(texts)) {
      const { model: m, report } = await loadModelText(`package ${name} { ${body} }`, { fileName: `${name}.sysml`, strict: true });
      expect([check(m!, `${name}::top`).result, numeric(m!, `${name}::top`)], name).toEqual(['satisfied', 'satisfied']);
      expect(goal(m!, `${name}::top`).encodable, name).toBe(true);
      expect(report.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message), name).toEqual(['p::load = 1 misses P2::a2 (load == 50.0)']);
    }
  });

  it('a throw while the unread asserts are read leaves no partial index behind (equatedParts)', async () => {
    const { model: m } = await loadModelText(`package RB3 {
      part def P { attribute x : ScalarValues::Real; }
      part q { part p : P; attribute L : ScalarValues::Real default = 4.0; bind p.x = L; }
      assert constraint tie { q.p.x == 3.0 }
      constraint top { q.L <= 3.5 }
      constraint top2 { q.p.x <= 3.5 }
    }`);
    const results = () => ['RB3::tie', 'RB3::top', 'RB3::top2'].map((r) => check(m!, r).result);
    // Every row reads the binding's default 4, which no assertion replaces (decision 14 amended 2026-10-22;
    // while an asserted equation replaced a default, the package's tie stood over it, unread, and all three
    // abstained).
    expect(results()).toEqual(['violated', 'violated', 'violated']);
    // A fresh revision, and one throw from the first sweep the assert index makes of the model: the index of
    // equated parts was kept without what the sweep lists, and at the same revision every row was decided as
    // if nothing had failed. A listing that failed leaves every row that may read one undecided.
    (m as unknown as { _rev: number })._rev++;
    const all = Model.prototype.all.bind(m!);
    let armed = true;
    const spy = vi.spyOn(m!, 'all').mockImplementation(() => {
      if (armed && new Error().stack!.includes('enclosingAsserts')) {
        armed = false;
        throw new RangeError('enclosingAsserts, planted to throw');
      }
      return all();
    });
    try {
      try {
        checkConstraints(m!);
      } catch {
        // Thrown or contained, the reading after it is what is checked.
      }
      expect(armed).toBe(false);
      expect(results()).toEqual(['unknown', 'unknown', 'unknown']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('valueAtPath — a path has the value the relation reads it at', () => {
  const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;
  const P = 'part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }';

  it('reads a derived value in the instance that overrides its input, not where it is declared (M3)', async () => {
    const { model: m } = await loadModelText(`package M3 {
      part def Q {
        attribute K : ScalarValues::Real default = 0.5;
        attribute L : ScalarValues::Real = 2.0 * K;
        attribute m2 : ScalarValues::Real = 10.0 - L;
      }
      part q : Q { attribute :>> K = 25.0; }
      part q2 : Q { attribute :>> K = 0.1; }
      constraint c { q.m2 <= q2.m2 }
    }`);
    const c = named(m!, 'M3::c');
    // q's K of 25 makes its L 50 and its m2 −40; q2's K of 0.1, 9.8; Q's own m2 (K = 0.5) is 9.
    expect(valueAtPath(m!, c, 'q.m2')).toBe(-40);
    expect(valueAtPath(m!, c, 'q2.m2')).toBeCloseTo(9.8, 12);
    expect(evaluateFeatureValue(m!, named(m!, 'M3::Q::m2').id)).toEqual({ value: 9 });
    // A bare name is read in the relation's owner: the definition's own.
    const { model: n } = await loadModelText(`package N3 {
      part def Q { attribute K : ScalarValues::Real default = 0.5; attribute m2 : ScalarValues::Real = 10.0 - 2.0 * K; constraint c { m2 <= 0.0 } }
      part q : Q { attribute :>> K = 25.0; }
    }`);
    expect(valueAtPath(n!, named(n!, 'N3::Q::c'), 'm2')).toBe(9);
  });

  it('reads no value where the check reads none: a bound derived partner abstains (M2), never the definition’s 9', async () => {
    const { model: m } = await loadModelText(`package M2 {
      ${P}
      part def Q {
        attribute K : ScalarValues::Real default = 0.5;
        attribute L : ScalarValues::Real = 2.0 * K;
        part p : P;
        bind p.load = L;
      }
      part q : Q { attribute :>> K = 25.0; }
      constraint c { q.p.m2 <= 0.0 }
    }`);
    const c = named(m!, 'M2::c');
    // Read per instance (F5): q's p's m2 is −40, so `<= 0.0` holds.
    expect(checkConstraints(m!).find((x) => x.id === c.id)!.result).toBe('satisfied');
    expect(valueAtPath(m!, c, 'q.p.m2')).toBe(-40);
    expect(evaluateFeatureValue(m!, named(m!, 'M2::P::m2').id)).toEqual({ value: 9 });
  });

  it('answers a number, a boolean or a string, and nothing for a name that reads none', async () => {
    const { model: m } = await loadModelText(`package T {
      part def P { attribute n : ScalarValues::Real = 3.0; attribute ok : ScalarValues::Boolean = true; attribute s : ScalarValues::String = "x"; attribute free : ScalarValues::Real; }
      part p : P;
      constraint c { p.n >= 0.0 }
    }`);
    const c = named(m!, 'T::c');
    expect(valueAtPath(m!, c, 'p.n')).toBe(3);
    expect(valueAtPath(m!, c, 'p.ok')).toBe(true);
    expect(valueAtPath(m!, c, 'p.s')).toBe('x');
    expect(valueAtPath(m!, c, 'p.free')).toBeUndefined();
    expect(valueAtPath(m!, c, 'p.nothing')).toBeUndefined();
    expect(valueAtPath(m!, c, 'nothing')).toBeUndefined();
  });
});

/*
 * THE INSTANCE INDEX (plan per-instance-check, step F3): the frames a binding
 * holds in, the component each instance reads through, and the source of the
 * value it gives there. F3 has no consumer, so these tests exercise the index
 * itself: `boundSourceIn` on each A.3 case, the outermost-root component as the
 * global union-find of what the connectors join, and every instance the full
 * `denote` walk finds being in the frame enumeration (frames ⊇ denote).
 */
describe('the instance index — frames, components, and bound sources', () => {
  const named = (m: Model, qualified: string) => m.all().find((e) => m.qualifiedName(e.id) === qualified)!;
  const P = 'part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }';

  it('finds the outermost frame root and the valued member a bound load reads (M2)', async () => {
    const { model: m } = await loadModelText(`package M2 {
      ${P}
      part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real = 2.0 * K; part p : P; bind p.load = L; }
      part q : Q { attribute :>> K = 25.0; }
    }`);
    const src = boundSourceIn(m!, 'M2::q::p::load');
    expect(src && !('abstain' in src)).toBe(true);
    if (!src || 'abstain' in src) return;
    // The outermost root is the package, not q (whose own instance is a prefix too).
    expect(m!.qualifiedName(src.root)).toBe('M2');
    expect([...src.paths].sort()).toEqual(['q.L', 'q.p.load']);
    // L states the value; p's load is a default the binding holds.
    expect(src.via.source).toBe('q.L');
    const cls = classified(m!, src.root, src.component);
    expect(cls.valued).toEqual(['q.L']);
    expect(cls.heldDefaults).toEqual(['q.p.load']);
  });

  // A-C2 (the 2026-10-14 review): q2's `bind p.extra = E` makes an implicit end copy of P's `extra default =
  // 0.0` that writes no default of its own. Held, it held P's extra at q2's p only where the copy WROTE a
  // default — never, so P's 0 stood at q2's p beside the binding's 20 (decision 10), and the SMT lane's
  // instance value row asserted it there. The redefined default gives way at the instance where the copy
  // falls through to it, and only there — so too where an asserted equation names the end (GA6): no assertion
  // replaces a default (decision 14 amended 2026-10-22; under decision 14 P's load gave way to its assert in
  // every instance), and the copy falls through to P's 7, which Q's binding joins to Q's 5 at Q's p and q's p.
  it('holds the redefined default at the instance where a held end copy falls through to it (A4)', async () => {
    const { model: m } = await loadModelText(`package A4 {
      part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute extra : ScalarValues::Real default = 0.0;
        constraint c { load + extra <= 10.0 }
      }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
    }`);
    const [load, extra] = [named(m!, 'A4::P::load'), named(m!, 'A4::P::extra')];
    // P's extra gives way at q2's p, where q2's E holds the copy; P's load at q1's p, where q1's L does.
    expect(defaultGivesWayIn(m!, extra, 'A4::q2::p')).toBe(true);
    expect(defaultGivesWayIn(m!, load, 'A4::q1::p')).toBe(true);
    // Not elsewhere: q1's extra and q2's load are P's own defaults, and so are Q's own p's.
    expect(defaultGivesWayIn(m!, extra, 'A4::q1::p')).toBe(false);
    expect(defaultGivesWayIn(m!, load, 'A4::q2::p')).toBe(false);
    expect(defaultGivesWayIn(m!, extra, 'A4::Q::p')).toBe(false);
    // No instance value row asserts P's default for q2's extra beside the binding that holds it.
    const rows = obligationsOf(m!).filter((o) => o.role === 'axiom').map((o) => o.element.qualifiedName);
    expect(rows).not.toContain('A4::P::extra in A4::q2::p');
    expect(rows).toContain('A4::P::extra in A4::q1::p');
    const { model: g } = await loadModelText(`package GA6 {
      part def P { attribute load : ScalarValues::Real default = 7.0; assert constraint pa { load == 7.0 } }
      part def Q { attribute L : ScalarValues::Real default = 5.0; assert constraint qa { L == 5.0 } part p : P; bind p.load = L; }
      part q : Q;
    }`);
    const gl = named(g!, 'GA6::P::load');
    expect([defaultGivesWayIn(g!, gl, 'GA6::Q::p'), defaultGivesWayIn(g!, gl, 'GA6::q::p'), defaultGivesWay(g!, gl)]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('reads one valued member, and abstains free / two-values / defaults-differ as A.3 does', async () => {
    // A single valued member: the default carried into a valueless feature stands.
    const { model: k } = await loadModelText(`package K {
      attribute x : ScalarValues::Real default = 5.0;
      attribute w : ScalarValues::Real;
      bind w = x;
    }`);
    const carried = boundSourceIn(k!, 'K::w');
    expect(carried && !('abstain' in carried) && carried.via.source).toBe('x');
    // No value anywhere: free.
    const { model: f } = await loadModelText(`package F {
      attribute x : ScalarValues::Real;
      attribute y : ScalarValues::Real;
      bind x = y;
    }`);
    const free = boundSourceIn(f!, 'F::x');
    expect(free && 'abstain' in free && free.abstain).toBe('free');
    // Two stated values the binding joins: a contradiction the binding's own row reports.
    const { model: t } = await loadModelText(`package T {
      attribute a : ScalarValues::Real = 1.0;
      attribute b : ScalarValues::Real = 2.0;
      bind a = b;
    }`);
    const two = boundSourceIn(t!, 'T::a');
    expect(two && 'abstain' in two && two.abstain).toBe('two-values');
    // Two defaults that read a name and differ: defaults-differ.
    const { model: r } = await loadModelText(`package R3a {
      part def A { attribute K : ScalarValues::Real default = 1.0; attribute v : ScalarValues::Real default = 2.0 * K; }
      part a1 : A;
      part a2 : A { attribute :>> K = 5.0; }
      bind a1.v = a2.v;
    }`);
    const differ = boundSourceIn(r!, 'R3a::a1::v');
    expect(differ && 'abstain' in differ && differ.abstain).toBe('defaults-differ');
    // A name no binding holds: nothing.
    expect(boundSourceIn(r!, 'R3a::a1::K')).toBeUndefined();
  });

  it('reads the outermost frame root as the global union-find of what the connectors join', async () => {
    const { model: m } = await loadModelText(`package U {
      attribute a : ScalarValues::Real = 1.0;
      attribute b : ScalarValues::Real;
      attribute c : ScalarValues::Real;
      bind a = b;
      bind b = c;
    }`);
    // An independent global union-find over the connectors' ends.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      while (parent.get(x) !== root) {
        const next = parent.get(x)!;
        parent.set(x, root);
        x = next;
      }
      return root;
    };
    const connectors = m!.all().filter((e) => isBindingConnector(e) && e.attrs.isLibrary !== true);
    for (const e of connectors) {
      for (const id of [e.source?.[0], e.target?.[0]]) if (id !== undefined) parent.set(id, id);
    }
    for (const e of connectors) {
      const [a, b] = [e.source![0]!, e.target![0]!];
      const [ra, rb] = [find(a), find(b)];
      if (ra !== rb) parent.set(ra, rb);
    }
    const bId = named(m!, 'U::b').id;
    const unionClass = [...new Set(parent.keys())]
      .filter((id) => find(id) === find(bId))
      .map((id) => m!.get(id)!.declaredName)
      .sort();
    // The component at the outermost root holds exactly that class.
    const src = boundSourceIn(m!, 'U::b');
    expect(src && !('abstain' in src)).toBe(true);
    if (!src || 'abstain' in src) return;
    expect([...src.paths].sort()).toEqual(unionClass);
  });

  it('enumerates every instance the full denote walk finds: frames cover denote', async () => {
    const { model: m } = await loadModelText(`package N {
      ${P}
      part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real = 2.0 * K; part p : P; bind p.load = L; }
      part q : Q { attribute :>> K = 25.0; }
      part r : Q;
      part def R { part qq : Q; part pp : P; }
      part s : R;
    }`);
    const definitions = sharedDefinitions(m!);
    const D = named(m!, 'N::P');
    // The frame enumeration alone.
    const frameInstances = new Set<string>();
    const { frames } = bindingFrames(definitions, D);
    for (const { root, prefix } of frames) {
      if (prefix === '') {
        frameInstances.add(definitions.instanceNameOf(root.id));
        continue;
      }
      const d = definitions.denote(root.id).get(prefix);
      if (d) frameInstances.add(definitions.instanceNameOf(d.feature.id));
    }
    // The generic instance and the two direct usages of P reach every frame.
    expect(frameInstances.has('N::P')).toBe(true);
    expect(frameInstances.has('N::Q::p')).toBe(true);
    expect(frameInstances.has('N::R::pp')).toBe(true);
    // Every instance the full denote walk over every user package finds is in the frames.
    for (const pkg of m!.all().filter((e) => e.eClass === 'Package' && e.attrs.isLibrary !== true)) {
      for (const d of definitions.denote(pkg.id).values()) {
        if (d.feature.id === D.id || definitions.specialisersOf(D.id).some((s) => s.id === d.feature.id)) {
          expect(frameInstances.has(definitions.instanceNameOf(d.feature.id)), definitions.instanceNameOf(d.feature.id)).toBe(true);
        }
      }
    }
    // The full index (frames ∪ denote) agrees, deduplicated, generic first.
    const all = instancesOfDefinition(definitions, D);
    expect(all[0]).toBe('N::P');
    expect(new Set(all).size).toBe(all.length);
  });

  // An instance that differs only by a binding written in or around it (A7's q2: `bind p.extra = E`, whose
  // implicit end copy is q2's p). No binding of Q tells Q's instances apart and nothing q2's p reads is
  // another feature, so no group and no context listed Q's p: every surface published P's own row alone and
  // the model clean, where q2's p breaks c (20 > 10) — PI-1's symptom by another path (O2 S4). The binding
  // reaching into a redefinition of Q's p now makes Q's p a group, read per instance.
  it('makes a usage a group where a binding written in or around one instance reaches into it', async () => {
    const { model: m } = await loadModelText(`package A7N {
      part def P {
        attribute extra : ScalarValues::Real default = 0.0;
        attribute k : ScalarValues::Real default = 1.0;
        constraint c { extra <= 10.0 }
      }
      part def Q { part p : P; }
      part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
      part q3 : Q;
      part q4 : Q { attribute K : ScalarValues::Real = 7.0; bind p.k = K; }
      part q5 : Q;
      attribute X : ScalarValues::Real = 30.0;
      bind q5.p.extra = X;
    }`);
    const qn = (id: string | undefined) => (id === undefined ? undefined : m!.qualifiedName(id));
    const definitions = sharedDefinitions(m!);
    // What reaches into Q's p is the element the binding is written in — for the names read: q4's binding
    // reaches k, which c does not read.
    const reached = (names: string[]) => {
      const above = definitions.boundAbove(named(m!, 'A7N::Q::p').id, names);
      return above && 'id' in above ? qn(above.id) : above;
    };
    expect([reached(['extra']), reached(['k'])]).toEqual(['A7N::q2', 'A7N::q4']);
    const [group, ...rest] = instanceGroups(m!);
    expect(rest).toEqual([]);
    expect([qn(group!.relationId), qn(group!.usageId), group!.instances]).toEqual([
      'A7N::P::c',
      'A7N::Q::p',
      ['A7N::Q::p', 'A7N::q2::p', 'A7N::q3::p', 'A7N::q4::p', 'A7N::q5::p'],
    ]);
    // q2's and q5's p are read in their end copies, at the extra the bindings carry in; q4's, whose copy
    // reaches only k, through Q's p.
    expect(Object.fromEntries([...(group!.readIn ?? new Map())].map(([i, e]) => [i, qn(e)]))).toEqual({
      'A7N::q2::p': 'A7N::q2::p',
      'A7N::q5::p': 'A7N::q5::p',
    });
    const rows = (checkConstraints(m!).find((c) => qn(c.id) === 'A7N::P::c')!.instances ?? []).map(
      (i) => `${i.instance ?? (i.generic ? 'generic' : qn(i.contextId))} ${i.result}`,
    );
    expect(rows).toEqual([
      'generic satisfied',
      'A7N::q2::p violated',
      'A7N::q3::p satisfied',
      'A7N::q4::p satisfied',
      'A7N::q5::p violated',
    ]);
  });

  // By path, not by feature (O2 S4's residual): q2's `bind p.s.extra = E` reaches Q's p's `s.extra`, never its
  // `t.extra`, though both are S's `extra`. Matched by feature, it made Q's p a group for `ct` too — three rows
  // read alike, extra rows, never another verdict. A value that reads the end (`m = s.extra * 2.0`) is matched
  // by feature still: what a value reads is no path.
  it('makes a usage a group only where a binding reaches a path the relation reads (BA)', async () => {
    const { model: m } = await loadModelText(`package BA {
      part def S { attribute extra : ScalarValues::Real default = 1.0; }
      part def P {
        part s : S;
        part t : S;
        attribute m : ScalarValues::Real = s.extra * 2.0;
        constraint ct { t.extra <= 10.0 }
        constraint cs { s.extra <= 10.0 }
        constraint cm { m <= 10.0 }
      }
      part def Q { part p : P; }
      part q1 : Q;
      part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.s.extra = E; }
    }`);
    const qn = (id: string) => m!.qualifiedName(id);
    expect(instanceGroups(m!).map((g) => `${qn(g.relationId)} in ${qn(g.usageId)}`)).toEqual(['BA::P::cs in BA::Q::p', 'BA::P::cm in BA::Q::p']);
    const checks = checkConstraints(m!);
    const rows = (rel: string) =>
      (checks.find((c) => qn(c.id) === rel)!.instances ?? []).map((i) => `${i.instance ?? (i.generic ? 'generic' : qn(i.contextId))} ${i.result}`);
    expect(rows('BA::P::ct')).toEqual([]);
    for (const rel of ['BA::P::cs', 'BA::P::cm']) {
      expect(rows(rel), rel).toEqual(['generic satisfied', 'BA::q1::p satisfied', 'BA::q2::p violated']);
    }
  });

  // A-H2 (O2 S5): the groups were worked out again by every caller — the check, the obligations lane, the
  // numeric lane, and the app's validation sweep, Check and Solve, all of one revision (8.4 s of big-bind-600's
  // check). They are worked out once per model revision now (B.5's INSTANCE_GROUPS), and so is each bound
  // source under them; an edit is a new revision, read anew.
  it('works the groups and bound sources out once per model revision, and anew after an edit (B.5)', async () => {
    const { model: m } = await loadModelText(`package C5 {
      part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 50.0; }
      part q2 : Q;
    }`);
    const qn = (id: string) => m!.qualifiedName(id);
    const rows = () =>
      (checkConstraints(m!).find((c) => qn(c.id) === 'C5::P::c')!.instances ?? []).map(
        (i) => `${i.instance ?? (i.generic ? 'generic' : qn(i.contextId))} ${i.result}`,
      );
    const groups = instanceGroups(m!);
    expect(groups.map((g) => g.instances)).toEqual([['C5::Q::p', 'C5::q1::p', 'C5::q2::p']]);
    const source = boundSourceIn(m!, 'C5::q1::p::load');
    expect(source && !('abstain' in source) && source.via.source).toBe('q1.L');
    expect(rows()).toEqual(['generic satisfied', 'C5::q1::p violated', 'C5::q2::p satisfied']);
    obligationsOf(m!);
    checkConstraintsNumeric(m!);
    // Every surface asked the same revision: the same list and the same source, never worked out again — and
    // the list is frozen, so no caller changes what the next one reads.
    expect(instanceGroups(m!)).toBe(groups);
    expect(boundSourceIn(m!, 'C5::q1::p::load')).toBe(source);
    expect(Object.isFrozen(groups) && groups.every((g) => Object.isFrozen(g) && Object.isFrozen(g.instances))).toBe(true);
    expect(() => (groups[0]!.instances as string[]).sort()).toThrow(TypeError);
    // So is the memoised source, with its lists: one caller's in-place sort would change what every lane reads.
    if (!source || 'abstain' in source) throw new Error('no source');
    expect([source, source.paths, source.via, source.via.bindingIds].every((x) => Object.isFrozen(x))).toBe(true);
    const cls = classified(m!, source.root, source.component);
    expect([cls, cls.valued, cls.readable, cls.heldDefaults].every((x) => Object.isFrozen(x))).toBe(true);
    // An edit is a new revision: everything is read anew, the edit included.
    const L = m!.children(named(m!, 'C5::q1').id).find((e) => e.eClass === 'AttributeUsage')!;
    m!.setAttrs(L.id, { value: 5.0 });
    expect(instanceGroups(m!)).not.toBe(groups);
    expect(boundSourceIn(m!, 'C5::q1::p::load')).not.toBe(source);
    expect(rows()).toEqual(['generic satisfied', 'C5::q1::p satisfied', 'C5::q2::p satisfied']);
    m!.remove(named(m!, 'C5::q2').id);
    expect(instanceGroups(m!).map((g) => g.instances)).toEqual([['C5::Q::p', 'C5::q1::p']]);
  });

  // The connectors that join a component are found by the ends they join, not by testing every user binding
  // once per component (cold-check S1): the same list as filtering them all — those whose two ends are both
  // among the component's features, whichever end is the source, in the model's order.
  it('lists the connectors that join a component in the model\'s order, from either end and none of another component\'s', async () => {
    const { model: m } = await loadModelText(`package CC {
      part def U { attribute A : ScalarValues::Real default = 1.0; attribute B : ScalarValues::Real default = 2.0; bind A = B; }
      part def T0 { attribute load : ScalarValues::Real default = 1.0; }
      part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; part b : T0; bind L = a.load; bind b.load = L; }
      part u : U;
      part top : T1 { attribute :>> L = 50.0; }
    }`);
    const source = boundSourceIn(m!, 'CC::top::b::load');
    if (!source || 'abstain' in source) throw new Error('no source');
    const position = new Map(m!.all().map((e, i) => [e.id, i]));
    const joined = source.via.bindingIds;
    // The two connectors of T1, and U's `bind A = B` is no part of it.
    expect(joined.map((id) => m!.qualifiedName(m!.get(id)!.ownerId!))).toEqual(['CC::T1', 'CC::T1']);
    expect(joined.map((id) => position.get(id)!)).toEqual([...joined.map((id) => position.get(id)!)].sort((a, b) => a - b));
    // `bind L = a.load` (source L) is written before `bind b.load = L` (source b.load): the model's order in this
    // shape, where it is also the order the members are met in (so the sort itself is not pinned here, and a
    // member's target end is always a member too: the target test is the old filter's second condition, kept).
    const ends = joined.map((id) => m!.get(id)!.source?.[0]);
    expect(ends.map((id) => m!.qualifiedName(id!))).toEqual(['CC::T1::L', 'CC::T1::b::load']);
  });

  // A-H2 (O2 S5), the E target tree10 ≤ 2× main: tree10's 3,070 instances read L from eleven components, and
  // each was judged by the whole pipeline (115 ms against 8). A decided reading is now kept with the questions
  // it asked of its instance's spelling — where a binding carries a value in, whether a default stands or gives
  // way there, whether an enclosing assert constrains a read — and an instance whose questions get the same
  // answers takes that reading, its own symbols spelled for it. Every row must be the row its own reading gives.
  const TREE = `package T {
    part def T0 {
      attribute load : ScalarValues::Real default = 1.0;
      attribute m2 : ScalarValues::Real = 10.0 - load;
      constraint c { load <= 10.0 }
      constraint d { m2 >= 0.0 }
    }
    part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; part b : T0; bind a.load = L; bind b.load = L; }
    part def T2 { attribute L : ScalarValues::Real default = 1.0; part a : T1; part b : T1; bind a.L = L; bind b.L = L; }
    part def T3 { attribute L : ScalarValues::Real default = 1.0; part a : T2; part b : T2; bind a.L = L; bind b.L = L; }
    part top : T3 { attribute :>> L = 50.0; }
    part mid : T3 { attribute :>> L = 7.0; }
  }`;

  it('shares one reading among instances read alike, each row the one its own reading gives (E, tree10)', async () => {
    const { model: m } = await loadModelText(TREE);
    const shared = checkConstraints(m!);
    expect(shared).toEqual(withEveryInstanceJudged(() => checkConstraints(m!)));
    const rows = (relation: string) =>
      (shared.find((c) => m!.qualifiedName(c.id) === relation)!.instances ?? []).filter((i) => i.instance !== undefined);
    const c = rows('T::T0::c');
    const d = rows('T::T0::d');
    // T1's a, read in T2 (2), T3 (4), top (4) and mid (4); so is T1's b.
    expect(c.length).toBe(28);
    const verdict = (list: typeof c, inst: string) => list.find((i) => i.instance === inst)?.result;
    expect(verdict(c, 'T::top::b::a::a')).toBe('violated');
    expect(verdict(c, 'T::mid::b::a::a')).toBe('satisfied');
    expect(verdict(c, 'T::T3::b::a::a')).toBe('satisfied');
    expect(verdict(d, 'T::top::a::b::b')).toBe('violated');
    expect(verdict(d, 'T::mid::a::b::b')).toBe('satisfied');
    // Each row names its own instance and the source it read, never the one it shares a reading with.
    const row = c.find((i) => i.instance === 'T::top::b::a::b')!;
    expect(row.reads?.map((r) => [r.symbol, r.value, r.via?.sourceSymbol])).toEqual([['T::top::b::a::b::load', 50, 'T::top::L']]);
    expect(row.message).toBe('Constraint violated: load <= 10.0 (load = 50 in T::top::b::a::b, its L T::top::L through T::T1\'s `bind a.load = L`)');
  });

  it('asks a kept reading\'s questions again of another instance, and takes it only where every answer is the same', async () => {
    const { model: m } = await loadModelText(TREE);
    const { value, lookups } = recordingLookups(() => boundSourceIn(m!, 'T::top::a::a::a::load'));
    const asked = lookupsOf(lookups, 'T::top::a::a::a');
    expect(asked).toEqual([{ kind: 'source', symbol: 'T::top::a::a::a::load', answer: value }]);
    // Another instance under top: the same member (top's L) of the same component.
    expect(lookupsHold(m!, asked, 'T::top::a::a::a', 'T::top::b::b::a')).toBe(true);
    // Under mid, or in T3's own instance: another component, another L.
    expect(lookupsHold(m!, asked, 'T::top::a::a::a', 'T::mid::b::b::a')).toBe(false);
    expect(lookupsHold(m!, asked, 'T::top::a::a::a', 'T::T3::a::a::a')).toBe(false);
    // A question that does not spell the instance asks the same of every instance: not asked again.
    expect(lookupsOf(lookups, 'T::mid::a::a::a')).toEqual([]);
  });

  // The branch review of O2 S5: a reading took a value the pass's memo had worked out for another relation,
  // and recorded none of the questions it was worked out with — so it asked nothing of its instance, and every
  // other instance took its verdict. TREE with `e`, a copy of `d`, read after it: e read m2 = 9 at every
  // instance where d read −40, and held there. A memo entry keyed on an instance keeps its questions, and a
  // hit asks them again, in the scalar scope and the unit-aware derivation alike.
  it('asks again the questions of a value taken from the memo: a relation and its copy read alike (Sh1, TREE+e)', async () => {
    const { model: m } = await loadModelText(TREE.replace('constraint d { m2 >= 0.0 }', 'constraint d { m2 >= 0.0 }\n      constraint e { m2 >= 0.0 }'));
    const shared = checkConstraints(m!);
    expect(shared).toEqual(withEveryInstanceJudged(() => checkConstraints(m!)));
    const rows = (relation: string) =>
      (shared.find((c) => m!.qualifiedName(c.id) === relation)!.instances ?? []).map((i) => [i.instance ?? 'own', i.result, i.reads?.map((r) => r.value)]);
    expect(rows('T::T0::e')).toEqual(rows('T::T0::d'));
    // Under top, m2 is 10 − 50: e is violated at every one of the eight instances, as d is.
    const underTop = rows('T::T0::e').filter(([inst]) => String(inst).startsWith('T::top::'));
    expect(underTop.map(([, result, reads]) => [result, reads])).toEqual(Array.from({ length: 8 }, () => ['violated', [-40]]));
    // In units too (the unit-aware derivation's memo): Sh2's `m <= 10.0 [kg]` after `m <= 1000.0 [kg]`.
    for (const unit of ['', ' [SI::kg]']) {
      const { model: s1 } = await loadModelText(`package Sh1 {
        part def P {
          attribute load : ${unit ? 'ISQ::MassValue' : 'ScalarValues::Real'} default = 1.0${unit};
          attribute m : ${unit ? 'ISQ::MassValue' : 'ScalarValues::Real'} = load * 2.0;
          constraint c1 { m <= 1000.0${unit} }
          constraint c2 { m <= 10.0${unit} }
        }
        part def Q { attribute L : ${unit ? 'ISQ::MassValue' : 'ScalarValues::Real'} default = 1.0${unit}; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0${unit}; }
        part q2 : Q { attribute :>> L = 50.0${unit}; }
      }`);
      const checks = checkConstraints(s1!);
      expect(checks, unit).toEqual(withEveryInstanceJudged(() => checkConstraints(s1!)));
      const q2 = checks.find((c) => s1!.qualifiedName(c.id) === 'Sh1::P::c2')!.instances!.find((i) => i.instance === 'Sh1::q2::p')!;
      expect([q2.result, q2.reads?.map((r) => [r.symbol, r.value])], unit).toEqual(['violated', [['Sh1::q2::p::m', 100]]]);
    }
  });

  it('keeps the questions a memo entry keyed on an instance was worked out with, each once, and asks them at a hit', async () => {
    const { model: m } = await loadModelText(TREE);
    // Worked out inside a reading: its questions are that reading's too, and kept for the entry.
    const { value, lookups } = recordingLookups(() =>
      lookupsWhile(() => [boundSourceIn(m!, 'T::top::a::a::a::load'), boundSourceIn(m!, 'T::top::a::a::a::load')]),
    );
    expect(value.lookups).toEqual([{ kind: 'source', symbol: 'T::top::a::a::a::load', answer: value.value[0] }]);
    expect(lookups).toEqual(value.lookups);
    // A hit: the kept questions, asked of the reading being recorded — and of none where nothing records.
    expect(recordingLookups(() => replayLookups(value.lookups)).lookups).toEqual(value.lookups);
    expect(() => replayLookups(value.lookups)).not.toThrow();
  });

  // The coverage guard (A.7; the 2026-10-14 review's A-C1). A group reads every instance of its shared usage
  // through the usage's own features; an instance whose element reads a name of the relation — or a name such a
  // name's value reads — through another feature was read so all the same, and published the usage's value as
  // its own (A2: q2's p states extra = 20, and the group held it at 0). O2 S1 had such an instance abstain; S2
  // reads it in that element — the most specific one that denotes it — at the instance, on every surface, and
  // the element's own context row is that row, filed once.
  it('reads an instance in its own element where that element reads the relation otherwise', async () => {
    const { model: m } = await loadModelText(`package G {
      part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute k : ScalarValues::Real default = 0.0;
        attribute extra : ScalarValues::Real default = 2.0 * k;
        constraint c { load + extra <= 10.0 }
      }
      part def P2 :> P { attribute :>> extra = 20.0; }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part def Q2 :> Q { part :>> p : P2; }
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q { part :>> p { attribute :>> extra = 20.0; } }
      part q3 : Q { part :>> p { attribute :>> k = 10.0; } }
      part q4 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
      part q5 : Q2;
    }`);
    const qn = (id: string | undefined) => (id === undefined ? undefined : m!.qualifiedName(id));
    const [group] = instanceGroups(m!);
    expect(group && m!.qualifiedName(group.relationId)).toBe('G::P::c');
    // Generic first, then frame order: Q's specialiser, the usages redefining Q's p, then the climb to Q's
    // own usages.
    expect(group!.instances).toEqual(['G::Q::p', 'G::Q2::p', 'G::q2::p', 'G::q3::p', 'G::q1::p', 'G::q4::p', 'G::q5::p']);
    // q2 redefines a name the relation reads; q3 one that a read name's value reads (extra's 2.0 * k); q4's
    // own binding gives its p's extra an implicit end copy (A4); Q2 types p by P2, whose extra is 20 (A3), and
    // q5 — a Q2 that redefines nothing — is read in Q2's p, at q5's own values. q1's L reaches p's load through
    // Q's own binding, which the per-instance reading reads: read through Q's p.
    expect(group!.otherwise).toBeUndefined();
    expect(Object.fromEntries([...(group!.readIn ?? new Map())].map(([i, e]) => [i, qn(e)]))).toEqual({
      'G::Q2::p': 'G::Q2::«PartUsage»',
      'G::q2::p': 'G::q2::«PartUsage»',
      'G::q3::p': 'G::q3::«PartUsage»',
      'G::q4::p': 'G::q4::p',
      'G::q5::p': 'G::Q2::«PartUsage»',
    });
    // The elements whose own instance the group reads: their context rows are the group's rows.
    expect(Object.fromEntries([...(group!.standsFor ?? new Map())].map(([i, e]) => [i, qn(e)]))).toEqual({
      'G::Q2::p': 'G::Q2::«PartUsage»',
      'G::q2::p': 'G::q2::«PartUsage»',
      'G::q3::p': 'G::q3::«PartUsage»',
      'G::q4::p': 'G::q4::p',
    });
    // The check: every instance is one row, read at its own values — 1 + 20 > 10 wherever extra is 20 — and no
    // row reads Q2's, q2's or q3's p as a context of its own beside it.
    const rows = new Map(
      (checkConstraints(m!).find((c) => m!.qualifiedName(c.id) === 'G::P::c')!.instances ?? []).map((i) => [
        i.instance ?? (i.generic ? 'generic' : m!.qualifiedName(i.contextId)),
        i,
      ]),
    );
    expect([...rows].map(([k, i]) => `${k} ${i.result} ${i.abstention ?? ''}`.trim())).toEqual([
      'G::P2 violated',
      'generic satisfied',
      'G::Q2::p violated',
      'G::q2::p violated',
      'G::q3::p violated',
      'G::q1::p satisfied',
      'G::q4::p violated',
      'G::q5::p violated',
    ]);
    expect(qn(rows.get('G::q5::p')!.contextId)).toBe('G::Q2::«PartUsage»');
    expect(rows.get('G::q5::p')!.elementId).toBeUndefined();
    expect(qn(rows.get('G::q2::p')!.elementId)).toBe('G::q2::«PartUsage»');
    // The obligations: one goal row per instance, each over the instance's own symbols — q2's own extra, P2's
    // extra (one literal for every instance) and q5's own load — and none for the elements' contexts.
    const goals = obligationsOf(m!).filter((o) => o.instance?.baseId === group!.relationId && o.role === 'obligation');
    expect(goals.map((o) => o.element.qualifiedName)).toEqual([
      'G::P::c in G::P2',
      "G::P::c in G::Q::p (G::Q's own)",
      'G::P::c in G::Q2::p',
      'G::P::c in G::q2::p',
      'G::P::c in G::q3::p',
      'G::P::c in G::q1::p',
      'G::P::c in G::q4::p',
      'G::P::c in G::q5::p',
    ]);
    const vars = (path: string) =>
      goals.find((o) => o.instance?.path === path)!.vars.map((v) => `${v.path}=${v.qualifiedName}`);
    expect(goals.every((o) => o.encodable === true)).toBe(true);
    expect(vars('G::q2::p')).toEqual(['load=G::q2::p::load', 'extra=G::q2::p::extra']);
    expect(vars('G::q4::p')).toEqual(['load=G::q4::p::load', 'extra=G::q4::p::extra']);
    expect(vars('G::q5::p')).toEqual(['load=G::q5::p::load', 'extra=G::P2::extra']);
    expect(qn(goals.find((o) => o.instance?.path === 'G::q5::p')!.instance!.contextId)).toBe('G::Q2::«PartUsage»');
  });

  // What the reading in an instance's own element must not miss (O2 S2). An assert of an instance ENCLOSING
  // that element constrains what it reads there (A.2.4): the row abstains, `enclosing-assert`, as every
  // per-instance reading of an enclosed value does. A group of a more specific usage (Q2's p, where q2 sets
  // L) reads its instances itself: the outer group files none of them, so q2's p is one row, not two. And an
  // element that reads the relation as the usage does, but is a context of its own (q2's p redefines what a
  // binding gives `extra`), is no second row beside the group's.
  it('abstains under an enclosing assert, and files every instance once', async () => {
    const head = `part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute extra : ScalarValues::Real default = 0.0;
        constraint c { load + extra <= 10.0 }
      }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }`;
    const { model: a } = await loadModelText(`package G {
      ${head}
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q { part :>> p { attribute :>> extra = 20.0; } assert constraint { p.load >= 0.5 } }
    }`);
    const [ga] = instanceGroups(a!);
    expect(ga!.readIn).toBeUndefined();
    expect([...(ga!.otherwise ?? new Map())]).toEqual([
      [
        'G::q2::p',
        {
          kind: 'enclosing-assert',
          sentence:
            "G::P::c is not read in G::q2::p: G::q2's asserted `p.load >= 0.5` constrains it there, " +
            'and this tool does not read a value an enclosing assert constrains',
        },
      ],
    ]);
    const rowsOf = (m: Model, rel: string) =>
      (checkConstraints(m).find((c) => m.qualifiedName(c.id) === rel)!.instances ?? []).map(
        (i) => `${i.instance ?? (i.generic ? 'generic' : m.qualifiedName(i.contextId))} ${i.result}${i.abstention ? ` ${i.abstention}` : ''}`,
      );
    expect(rowsOf(a!, 'G::P::c')).toEqual(['generic satisfied', 'G::q2::p unknown enclosing-assert', 'G::q1::p satisfied']);
    const names = (m: Model) =>
      obligationsOf(m)
        .filter((o) => o.role === 'obligation' && o.instance !== undefined)
        .map((o) => o.element.qualifiedName);
    // Two groups, one below the other: each instance is read by the more specific one.
    const { model: b } = await loadModelText(`package G {
      ${head}
      part def P2 :> P { attribute :>> extra = 20.0; }
      part def Q2 :> Q { part :>> p : P2; }
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q2 { attribute :>> L = 2.0; }
    }`);
    expect(instanceGroups(b!).map((g) => [b!.qualifiedName(g.usageId), g.instances])).toEqual([
      ['G::Q::p', ['G::Q::p', 'G::q1::p']],
      ['G::Q2::«PartUsage»', ['G::Q2::p', 'G::q2::p']],
    ]);
    expect(rowsOf(b!, 'G::P::c')).toEqual([
      'generic satisfied',
      'G::q1::p satisfied',
      'G::P2 violated',
      'generic violated',
      'G::q2::p violated',
    ]);
    expect(names(b!)).toEqual([
      "G::P::c in G::Q::p (G::Q's own)",
      'G::P::c in G::q1::p',
      'G::P::c in G::P2',
      "G::P::c in G::Q2::p (G::Q2's own)",
      'G::P::c in G::q2::p',
    ]);
    // q2's p redefines what P binds extra to; the group reads it through Q's p and the binding, at q2's own
    // values (2 × 50): q2's p is no context row of its own beside it.
    const { model: c } = await loadModelText(`package G {
      part def S { attribute v : ScalarValues::Real default = 1.0; attribute w : ScalarValues::Real = 2.0 * v; }
      part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute extra : ScalarValues::Real;
        part sub : S;
        bind extra = sub.w;
        constraint c { load + extra <= 10.0 }
      }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q { part :>> p { part :>> sub { attribute :>> v = 50.0; } } }
    }`);
    const [gc] = instanceGroups(c!);
    expect(gc!.readIn).toBeUndefined();
    expect([...(gc!.standsFor ?? new Map()).keys()]).toEqual(['G::q2::p']);
    expect(rowsOf(c!, 'G::P::c')).toEqual(['generic satisfied', 'G::q2::p violated', 'G::q1::p satisfied']);
    expect(names(c!)).toEqual(["G::P::c in G::Q::p (G::Q's own)", 'G::P::c in G::q2::p', 'G::P::c in G::q1::p']);
  });

  // What the reading in an instance's own element must not read either (the review of O2 S2). An instance on
  // whose path a name is inherited twice, neither feature redefining the other (Q3 :> Q2, Q4 over Q2's and
  // Q4's `part :>> p`), is P2's p and P4's p at once: no one element stands for it, so it abstains, in the
  // group it is taken from — no group of one of the two takes it. A name two inherited values collide under
  // (Q2's p, typed P2, inherits P2's `extra = 9.5` and the end copy of Q's `bind p.extra = X`) has no value,
  // and none is read through the binding in its place (it was X's default, 0). A `default` an asserted
  // equation of the element's own constrains is read at the default, which no assertion replaces (decision 14
  // amended 2026-10-22): H5B's q3's p's extra is P's 0, as its group reads it (O9 S2 read the assert's 20 in
  // q3's p, violated; it abstained as `not-enumerated` before that).
  // And an enclosing assert makes an instance abstain whether it is read in its own element (q2, the guard)
  // or through Q's p (q1, the reading itself, at q1's frames: A-H1, O2 S3).
  it('abstains where no one element stands for an instance, a name reads two values, or an own assert meets a default', async () => {
    const P3 = `part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute extra : ScalarValues::Real default = 0.0;
        attribute extra2 : ScalarValues::Real default = 0.0;
        constraint c { load + extra + extra2 <= 10.0 }
      }
      part def P2 :> P { attribute :>> extra = 0.5; }
      part def P4 :> P { attribute :>> extra2 = 20.0; }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part def Q2 :> Q { part :>> p : P2; }
      part def Q4 :> Q { part :>> p : P4; }`;
    const rowsOf = (m: Model, rel: string) =>
      (checkConstraints(m).find((c) => m.qualifiedName(c.id) === rel)!.instances ?? []).map(
        (i) => `${i.instance ?? (i.generic ? 'generic' : m.qualifiedName(i.contextId))} ${i.result}${i.abstention ? ` ${i.abstention}` : ''}`,
      );
    const { model: d } = await loadModelText(`package G {
      ${P3}
      part def Q3 :> Q2, Q4;
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q2 { attribute :>> L = 2.0; }
      part q3 : Q3;
    }`);
    const groups = instanceGroups(d!);
    expect(groups.map((g) => [d!.qualifiedName(g.usageId), g.instances])).toEqual([
      ['G::Q::p', ['G::Q::p', 'G::Q4::p', 'G::Q3::p', 'G::q1::p', 'G::q3::p']],
      ['G::Q2::«PartUsage»', ['G::Q2::p', 'G::q2::p']],
    ]);
    expect(groups[0]!.otherwise?.get('G::q3::p')).toEqual({
      kind: 'not-enumerated',
      sentence:
        'G::P::c is not read in G::q3::p: G::q3 inherits G::Q2::p and G::Q4::p under the one name `p`, neither ' +
        'redefining the other, so this tool cannot tell which element stands for it there',
    });
    expect(rowsOf(d!, 'G::P::c')).toEqual([
      'G::P2 satisfied',
      'G::P4 violated',
      'generic satisfied',
      'G::Q4::p violated',
      'G::Q3::p unknown not-enumerated',
      'G::q1::p satisfied',
      'G::q3::p unknown not-enumerated',
      'generic satisfied',
      'G::q2::p satisfied',
    ]);
    const head = `part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute extra : ScalarValues::Real default = 0.0;
        constraint c { load + extra <= 10.0 }
      }`;
    const { model: h } = await loadModelText(`package G {
      ${head}
      part def P2 :> P { attribute :>> extra = 9.5; }
      part def Q {
        attribute L : ScalarValues::Real default = 1.0;
        attribute X : ScalarValues::Real default = 0.0;
        part p : P;
        bind p.load = L;
        bind p.extra = X;
      }
      part def Q2 :> Q { part :>> p : P2; }
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q2 { attribute :>> L = 3.0; }
    }`);
    const clash =
      'Could not evaluate: extra has no value: G::Q2::p inherits P::extra = 0.0 and P2::extra = 9.5 under the one ' +
      'name `extra`, and which one an instance has is not decided by reading them, so neither is read';
    const hc = checkConstraints(h!).find((c) => h!.qualifiedName(c.id) === 'G::P::c')!;
    expect(rowsOf(h!, 'G::P::c')).toEqual([
      'G::P2 violated',
      'generic satisfied',
      'G::q1::p satisfied',
      'generic unknown',
      'G::q2::p unknown',
    ]);
    for (const i of (hc.instances ?? []).filter((x) => x.result === 'unknown')) expect(i.message).toBe(clash);
    const { model: b } = await loadModelText(`package G {
      ${head}
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 2.0; assert constraint { p.load >= 0.5 } }
      part q2 : Q { part :>> p { attribute :>> extra = 0.5; } assert constraint { p.load >= 0.5 } }
      part q3 : Q { part :>> p { assert constraint { extra == 20.0 } } }
    }`);
    const [gb] = instanceGroups(b!);
    expect(Object.fromEntries([...(gb!.otherwise ?? new Map())].map(([i, o]) => [i, o.kind]))).toEqual({
      'G::q2::p': 'enclosing-assert',
    });
    expect([...(gb!.readIn ?? new Map()).keys()]).toEqual([]);
    expect(rowsOf(b!, 'G::P::c')).toEqual([
      'generic satisfied',
      'G::q2::p unknown enclosing-assert',
      'G::q3::p satisfied',
      'G::q1::p unknown',
    ]);
    // Nor an equation over a name with no value (`extra == M`, M valueless: it defines M from the default,
    // invariant (e)): it abstained in the guard's sentence, and now reads the default as the group does.
    const { model: b2 } = await loadModelText(`package G {
      ${head}
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 2.0; }
      part q3 : Q { part :>> p { attribute M : ScalarValues::Real; assert constraint { extra == M } } }
    }`);
    expect(instanceGroups(b2!)[0]!.otherwise?.get('G::q3::p')).toBeUndefined();
    // q1's p is read through Q's p, and q1's assert is of an instance enclosing it: it abstains in A.9's
    // sentence, as the own row reading `q1.p.load` does.
    const bq1 = checkConstraints(b!).find((c) => b!.qualifiedName(c.id) === 'G::P::c')!.instances!.find((i) => i.instance === 'G::q1::p')!;
    expect(bq1.message).toBe(
      "Could not evaluate: load is not read in G::q1::p: G::q1's asserted `p.load >= 0.5` constrains it there, " +
        'and this tool does not read a value an enclosing assert constrains',
    );
  });

  // A-H1 (the 2026-10-14 review): a group row reads Q's p for q1's p, and read through Q's p's frames it
  // read x's default past q1's `assert constraint { p.x == 50.0 }` — T where the own row reading `q1.p.x`
  // abstained. It is read at q1's p's own frames, a value derived from x too (m2 = 10 − x, read in P for
  // q1's p). Under H5's enclosing rule (O5 S3) the equation defined x there, m2 −40, the row violated; since
  // decision 14 was amended (2026-10-22) no assertion replaces x's default, and the row abstains as the own
  // row does, on q1's assert (A.2.4) — with Q's own assert beside it too.
  it('reads an instance at the frames that enclose it, a derived value too (A-H1)', async () => {
    const text = (qAssert: string) => `package G {
      part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute x : ScalarValues::Real default = 2.0;
        attribute m2 : ScalarValues::Real = 10.0 - x;
        constraint c { load + m2 >= 0.0 }
      }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; ${qAssert} }
      part q1 : Q { attribute :>> L = 3.0; assert constraint tie { p.x == 50.0 } }
      part q2 : Q;
    }`;
    const rowsOf = (m: Model) =>
      (checkConstraints(m).find((c) => m.qualifiedName(c.id) === 'G::P::c')!.instances ?? []).map(
        (i) => [i.instance ?? 'generic', i.result, i.result === 'unknown' ? i.message : ''],
      );
    const { model: m } = await loadModelText(text(''));
    expect(sharedDefinitions(m!).framesAbove('G::q1::p')!.map((f) => f.instance)).toEqual(['G', 'G::q1']);
    const q1Assert =
      "Could not evaluate: x is not read in G::q1::p: G::q1's asserted `p.x == 50.0` constrains it there, and this tool does " +
      'not read a value an enclosing assert constrains';
    expect(rowsOf(m!)).toEqual([
      ['generic', 'satisfied', ''],
      ['G::q1::p', 'unknown', q1Assert],
      ['G::q2::p', 'satisfied', ''],
    ]);
    const { model: d } = await loadModelText(text('assert constraint qx { p.x == 2.0 }'));
    expect(rowsOf(d!)).toEqual([
      ['generic', 'satisfied', ''],
      ['G::q1::p', 'unknown', q1Assert],
      ['G::q2::p', 'satisfied', ''],
    ]);
    // The package is the outermost of q1's p's frames (H1C3, the review of O2 S3): its `assert constraint {
    // q1.p.x == 50.0 }` constrains q1's p's x as q1's own does, and q2's p, read in its own element, is under
    // the package's `q2.p.x == 50.0` too.
    const { model: h } = await loadModelText(`package H {
      part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute x : ScalarValues::Real default = 2.0;
        constraint c { load + x <= 10.0 }
      }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 3.0; }
      part q2 : Q { part :>> p { attribute :>> load default = 4.0; } }
      part q3 : Q;
      assert constraint t { q2.p.x == 50.0 }
      assert constraint t1 { q1.p.x == 50.0 }
    }`);
    expect(sharedDefinitions(h!).framesAbove('H::q1::p')!.map((f) => f.instance)).toEqual(['H', 'H::q1']);
    const hRows = (checkConstraints(h!).find((c) => h!.qualifiedName(c.id) === 'H::P::c')!.instances ?? []).map(
      (i) => [i.instance ?? h!.qualifiedName(i.contextId), i.result, i.result === 'unknown' ? i.message : ''],
    );
    // q1's p and q2's p abstain on the package's asserts (q1's read the assert's 50 there, violated; q2's, read
    // in its own `part :>> p`, read the 50 too, and abstained on its own load, a default its redefinition writes
    // that q2's L's binding joins): the assert is the guard's now, read before what q2's p's own element states.
    expect(hRows.map(([i, r]) => `${i} ${r}`)).toEqual([
      'H::Q::p satisfied',
      'H::q2::p unknown',
      'H::q1::p unknown',
      'H::q3::p satisfied',
    ]);
    expect(hRows[1]![2]).toContain("H's asserted `q2.p.x == 50.0` constrains it there");
  });

  // The guard's other causes (the review of O2 S1). A reference's value is resolved once, where it is
  // written: `ref part :>> r = s` in Q's p is Q's `s`, so an instance whose own `s` is another feature
  // (q2's override, Q2's `s : R2`) or is bound per instance (Q's `bind s.k = K`) is not read; nor one whose
  // own p redefines the relation (q5). One whose own p refers elsewhere (q4's `r = ra`) is read in that p (O2
  // S2). And a usage that reads through a part a binding joins to another (`bind p.r = s`) is read per
  // instance nowhere — its own row included, which read R's own x where Q's s has k = 50.
  it('re-reads a reference at the instance, and reads no group through a bound part', async () => {
    const groupsOf = async (text: string) => {
      const { model: m } = await loadModelText(text);
      return instanceGroups(m!).map((g) => ({
        instances: g.instances,
        expanded: g.expanded,
        refusal: g.refusal,
        otherwise: Object.fromEntries([...(g.otherwise ?? new Map())].map(([i, o]) => [i, o.sentence])),
        readIn: [...(g.readIn?.keys() ?? [])],
      }));
    };
    const rp = `part def R { attribute k : ScalarValues::Real default = 1.0; attribute x : ScalarValues::Real = 2.0 * k; }
      part def P { attribute load : ScalarValues::Real default = 1.0; ref part r : R; constraint c { load + r.x <= 10.0 } }`;
    const tail = 'and this tool resolves what a reference stands for only where its value is written';
    expect(
      await groupsOf(`package X {
      ${rp}
      part def R2 :> R { attribute :>> k = 50.0; }
      part ra : R { attribute :>> k = 50.0; }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part s : R; part p : P { ref part :>> r = s; } bind p.load = L; }
      part def Q2 :> Q { part :>> s : R2; }
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q { part :>> s { attribute :>> k = 50.0; } }
      part q3 : Q2;
      part q4 : Q { part :>> p { ref part :>> r = ra; } }
      part q5 : Q { part :>> p { constraint :>> c { load + r.x <= 100.0 } } }
    }`),
    ).toEqual([
      {
        instances: ['X::Q::p', 'X::q4::p', 'X::q5::p', 'X::Q2::p', 'X::q1::p', 'X::q2::p', 'X::q3::p'],
        expanded: true,
        refusal: undefined,
        otherwise: {
          'X::q5::p':
            'X::P::c is not read in X::q5::p: its c there is X::q5::p::c, not X::P::c, and that relation is read in a row of its own',
          'X::Q2::p': `X::P::c is not read in X::Q2::p: its r there stands for X::Q2::s, not X::Q::s, ${tail}`,
          'X::q2::p': `X::P::c is not read in X::q2::p: its r there stands for X::q2::s, not X::Q::s, ${tail}`,
          'X::q3::p': `X::P::c is not read in X::q3::p: its r there stands for X::Q2::s, not X::Q::s, ${tail}`,
        },
        readIn: ['X::q4::p'],
      },
    ]);
    // q1's s is Q's, but Q binds its k to K, which q1 sets: what r stands for there is q1's s, not Q's.
    expect(
      await groupsOf(`package X {
      ${rp}
      part def Q {
        attribute L : ScalarValues::Real default = 1.0;
        attribute K : ScalarValues::Real default = 1.0;
        part s : R;
        part p : P { ref part :>> r = s; }
        bind p.load = L;
        bind s.k = K;
      }
      part q1 : Q { attribute :>> K = 50.0; }
    }`).then((g) => g.map((x) => x.otherwise)),
    ).toEqual([{ 'X::q1::p': `X::P::c is not read in X::q1::p: its r stands for X::Q::s of that instance, which a binding reaches into, ${tail}` }]);
    // `bind p.r = s`: the whole group keeps a refusal, and no row of it is read.
    const bound = `package X {
      ${rp}
      part def Q { attribute L : ScalarValues::Real default = 1.0; part s : R { attribute :>> k = 50.0; } part p : P; bind p.r = s; bind p.load = L; }
      part q1 : Q { attribute :>> L = 2.0; }
    }`;
    const sentence =
      'X::P::c is not read per instance in X::Q::p: it reads r.x through r, which a binding joins to another feature, ' +
      'and this tool reads no feature through a bound part';
    expect(await groupsOf(bound)).toEqual([
      { instances: ['X::Q::p', 'X::q1::p'], expanded: false, refusal: { kind: 'not-enumerated', sentence }, otherwise: {}, readIn: [] },
    ]);
    const { model: m } = await loadModelText(bound);
    const row = checkConstraints(m!).find((c) => m!.qualifiedName(c.id) === 'X::P::c')!.instances!;
    expect(row.map((i) => [m!.qualifiedName(i.contextId), i.result, i.abstention, i.message])).toEqual([
      ['X::Q::p', 'unknown', 'not-enumerated', `Could not evaluate: ${sentence}`],
    ]);
  });

  // A.2.7 (planted bug P6): the unit-aware reading reads per instance only where a caller asks
  // (`instances`) — the check's judgeBound and the literal and SMT quantities. The numeric lane and an
  // equation's own quantity check ask for the per-FEATURE reading, which refuses a default a binding holds
  // somewhere ("the unit-aware lane cannot key it per instance"): q1's binding gives P's load 50 at q1's p, so
  // P's default 5 is no value of the feature's, while at P's own instance it stands. With `instances` on by
  // default (P6) no verdict moved on the D.3 corpus, the M-generator or the 637-model differential (one
  // numeric unknown named another name as its reason): only this contract tells the two readings apart.
  it('reads per instance in the unit-aware path only where the caller asks (A.2.7)', async () => {
    const { model: m } = await loadModelText(`package C6B {
      part def P { attribute load : ScalarValues::Real default = 5.0; constraint c { load <= 5.0 } }
      part def Q { attribute L : ScalarValues::Real; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 50.0; }
      part q2 : Q;
    }`);
    const c = named(m!, 'C6B::P::c');
    expect(evaluateConstraintQuantityDetailed(m!, c)).toMatchObject({ verdict: 'unknown', reason: 'unresolved' });
    expect(evaluateConstraintQuantityDetailed(m!, c, { instances: true }).verdict).toBe('satisfied');
    expect(evaluateConstraintQuantityDetailed(m!, c, { instances: false }).verdict).toBe('unknown');
    // The check reads the model's bindings per instance: P's own row is read at P's own instance.
    expect(checkConstraints(m!).find((x) => x.id === c.id)!.result).toBe('satisfied');
  });
});

/*
 * A.2.2 (the review of O2 S6: U5, U8, U1, V5): a value a binding carries into one instance is read in the unit
 * the feature it fills declares — P's `load`, the binding's implicit end copy included — and the body in units
 * with it. Read as the number its source writes, q1's `L = 20.0 [kg]` was 20 against P's `cap = 10000.0 [g]`
 * as 10000, and held on all four surfaces; q2's `L = 5000.0 [g]` was 5000 against 10 kg, violated.
 */
describe('a value a binding carries is read in the unit its feature declares (A.2.2)', () => {
  const instanceRows = (m: Model, checks: ConstraintCheck[], qualified: string) =>
    Object.fromEntries(
      checks
        .find((x) => m.qualifiedName(x.id) === qualified)!
        .instances!.filter((i) => i.instance !== undefined)
        .map((i) => [i.instance!, i.result]),
    );
  const MODEL = `package UC {
    part def P {
      attribute load : ISQ::MassValue default = 1.0 [SI::kg];
      attribute cap : ISQ::MassValue = 10000.0 [SI::g];
      constraint c { load <= cap }
      constraint lit { load <= 10.0 }
    }
    part def Q { attribute L : ISQ::MassValue default = 1.0 [SI::kg]; part p : P; bind p.load = L; }
    part q1 : Q { attribute :>> L = 20.0 [SI::kg]; }
    part q2 : Q { attribute :>> L = 5000.0 [SI::g]; }
    constraint top { q1.p.load <= q1.p.cap }
  }`;

  it('compares it as the quantity it is, and prints it in the declared unit (U5, U8)', async () => {
    const { model: m } = await loadModelText(MODEL);
    const checks = checkConstraints(m!);
    expect(instanceRows(m!, checks, 'UC::P::c')).toEqual({ 'UC::q1::p': 'violated', 'UC::q2::p': 'satisfied' });
    expect(checks.find((x) => m!.qualifiedName(x.id) === 'UC::top')!.result).toBe('violated');
    // The witness is the value in `load`'s unit (kg), exactly: the point the solver lane stores.
    const q2 = checks.find((x) => m!.qualifiedName(x.id) === 'UC::P::c')!.instances!.find((i) => i.instance === 'UC::q2::p')!;
    expect(q2.message).toBe("Constraint satisfied (load = 5 [SI::kg] in UC::q2::p, its L UC::q2::L through UC::Q's `bind p.load = L`)");
    expect(q2.reads).toEqual([
      expect.objectContaining({ path: 'load', symbol: 'UC::q2::p::load', value: 5, exact: '5/1', unit: 'SI::kg' }),
    ]);
    // …and the two sides of its comparison in SI, for the literal and SMT notes (A-M2).
    expect(q2.sides).toEqual({ lhsSI: 5, rhsSI: 10, dimension: 'M' });
  });

  it('compares no bare number with a quantity carried into a feature that declares no unit (UB4, E9)', async () => {
    // q's L is `2.0 * K` over `K = 25000.0 [g]`: 50000 as written, 50 kg in SI. Into an untyped load, the
    // check compared the 50000 with the bare 1000 (F) where the numeric surface compared 50 (T).
    const { model: m } = await loadModelText(`package UB4 {
      part def P { attribute load default = 1.0; }
      part def Q { attribute K : ISQ::MassValue default = 500.0 [SI::g]; attribute L : ISQ::MassValue = 2.0 * K; part p : P; bind p.load = L; }
      part q : Q { attribute :>> K = 25000.0 [SI::g]; }
      constraint cX { q.p.load <= 1000.0 }
      constraint kg { q.p.load <= 60.0 [SI::kg] }
    }`);
    const checks = checkConstraints(m!);
    const row = (q: string) => checks.find((c) => m!.qualifiedName(c.id) === q)!;
    expect([row('UB4::cX').result, row('UB4::cX').message]).toEqual([
      'unknown',
      'Could not evaluate: load is not read in UB4::q::p: the binding carries 50 (M, coherent SI) into it, and it ' +
        'declares no unit or kind: a bare number beside it is read in no unit the model states, so no comparison is ' +
        'made on it',
    ]);
    // A quantity beside it is compared in units, as before.
    expect(row('UB4::kg').result).toBe('satisfied');
    // A carried value whose number as written is its SI one is read as before (no unit to disagree with).
    const { model: si } = await loadModelText(`package UB5 {
      part def P { attribute load default = 1.0; }
      part def Q { attribute K : ISQ::MassValue default = 1.0 [SI::kg]; attribute L : ISQ::MassValue = 2.0 * K; part p : P; bind p.load = L; }
      part q : Q { attribute :>> K = 25.0 [SI::kg]; }
      constraint cT { q.p.load <= 1000.0 }
    }`);
    expect(checkConstraints(si!).find((c) => si!.qualifiedName(c.id) === 'UB5::cT')!.result).toBe('satisfied');
  });

  it('reads a chain to a binding’s end at the value the binding carries, on the numeric surface too (GA7)', async () => {
    // P's `load default = 2.0 * K` behind the end copy of Q's `bind p.load = L` was taken for a derived value
    // no surface reads at Q's p, so the numeric surface abstained where the check reads L's 5. (L was a
    // `default = 2.0 * K` an asserted `L == 5.0` replaced; no assertion replaces a default since decision 14 was
    // amended on 2026-10-22, so L states its 5 with `=`.)
    const { model: m } = await loadModelText(`package GA7 {
      part def P { attribute load : ScalarValues::Real default = 2.0 * K; attribute K : ScalarValues::Real default = 1.0; }
      part def Q {
        attribute L : ScalarValues::Real = 5.0;
        attribute K : ScalarValues::Real default = 1.0;
        part p : P;
        bind p.load = L;
        constraint pl { p.load <= 3.0 }
      }
      part q : Q;
    }`);
    const pl = named(m!, 'GA7::Q::pl');
    expect(unreadValuesOf(m!, pl, ['p.load'])).toEqual([]);
    expect(checkConstraints(m!).find((c) => c.id === pl.id)!.result).toBe('violated');
    expect(checkConstraintsNumeric(m!).find((r) => r.id === pl.id)!.result).toBe('violated');
  });

  it('prints the value beside a decided group row (A-M2)', async () => {
    const { model: m } = await loadModelText(`package AM {
      part def P {
        attribute load : ScalarValues::Real default = 1.0;
        attribute extra : ScalarValues::Real default = 0.0;
        constraint c { load + extra <= 10.0 }
      }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 2.0; }
      part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
    }`);
    const rows = checkConstraints(m!).find((x) => m!.qualifiedName(x.id) === 'AM::P::c')!.instances!;
    const row = (inst?: string) => rows.find((i) => (inst === undefined ? i.generic === true : i.instance === inst))!;
    const read = (inst: string | undefined, path: string) => row(inst).reads!.find((r) => r.path === path)!;
    // The generic row's load comes through Q's `bind p.load = L`: a value alone, no source clause for it.
    expect([read(undefined, 'load').value, read(undefined, 'load').via]).toEqual([1, undefined]);
    // q2's extra, 20, comes through q2's own binding: a read of the row, with no source clause of its own.
    expect([read('AM::q2::p', 'extra').value, read('AM::q2::p', 'extra').via]).toEqual([20, undefined]);
    expect(read('AM::q1::p', 'load')).toEqual(expect.objectContaining({ value: 2, via: expect.anything() }));
  });

  it('reads a bare literal beside it in the declared unit, as for every value of the feature (U1)', async () => {
    const { model: m } = await loadModelText(MODEL);
    // 20 kg > 10; 5000 g is 5 kg <= 10 — not 5000.
    expect(instanceRows(m!, checkConstraints(m!), 'UC::P::lit')).toEqual({ 'UC::q1::p': 'violated', 'UC::q2::p': 'satisfied' });
  });

  it('stores the end copy in that unit on the solver lane: a feature declared in grams holds 20 kg as 20000 (V5)', async () => {
    const { model: m } = await loadModelText(`package V5 {
      part def P { attribute load : ISQ::MassValue default = 1000.0 [SI::g]; attribute cap : ISQ::MassValue = 10.0 [SI::kg]; }
      part p1 : P;
      attribute L : ISQ::MassValue = 20.0 [SI::kg];
      bind p1.load = L;
      constraint top1 { p1.load <= p1.cap }
      constraint top2 { p1.load >= 15.0 [SI::kg] }
    }`);
    const verdict = (rows: readonly { id: string; result: string }[], name: string) =>
      rows.find((r) => m!.qualifiedName(r.id) === name)!.result;
    for (const rows of [checkConstraints(m!), checkConstraintsNumeric(m!)]) {
      expect([verdict(rows, 'V5::top1'), verdict(rows, 'V5::top2')]).toEqual(['violated', 'satisfied']);
    }
  });

  it('reads an enclosing assert in units too (A-H1, the units twin of R1)', async () => {
    // q1's assert constrains x at q1's p, and the unit-aware reading of the body, given load's quantity, abstains
    // there as the scalar one does (A.2.4), never reading P's default x past it (3 + 2 <= 10, T). Under H5's
    // enclosing rule it read the assert's 50 (3 + 50 kg); no assertion replaces a default since decision 14 was
    // amended (2026-10-22).
    const { model: m } = await loadModelText(`package R1U {
      part def P {
        attribute load : ISQ::MassValue default = 1.0 [SI::kg];
        attribute x : ISQ::MassValue default = 2.0 [SI::kg];
        constraint c { load + x <= 10.0 [SI::kg] }
        constraint b { load + x <= 10.0 }
      }
      part def Q { attribute L : ISQ::MassValue default = 1.0 [SI::kg]; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 3.0 [SI::kg]; assert constraint tie { p.x == 50.0 [SI::kg] } }
      part q2 : Q;
    }`);
    const checks = checkConstraints(m!);
    for (const rel of ['R1U::P::c', 'R1U::P::b']) {
      expect(instanceRows(m!, checks, rel)).toEqual({ 'R1U::q1::p': 'unknown', 'R1U::q2::p': 'satisfied' });
    }
  });

  // The branch review of O2: the unit-aware reading judges a body first, and for a body over a DERIVED value
  // it derived that value at the instance, x read at P's default past q1's assert: `s <= 10.0` held at s = 5
  // in q1's p where `load + x <= 10.0`, the same quantity, abstained — and so did a package relation over
  // `q1.p.s` beside top1's abstention over `q1.p.x`. Under H5's enclosing rule (O5 S3) q1's assert defined x
  // there (s 53); no assertion replaces a default since decision 14 was amended (2026-10-22), and the derived
  // value abstains at q1's p as x does, in units or not, on the check and the numeric surface alike.
  it('abstains past an enclosing assert through a value derived from what it constrains too (R1D)', async () => {
    for (const [type, unit] of [
      ['ScalarValues::Real', ''],
      ['ISQ::MassValue', ' [SI::kg]'],
    ]) {
      const { model: m } = await loadModelText(`package R1D {
        part def P {
          attribute load : ${type} default = 1.0${unit};
          attribute x : ${type} default = 2.0${unit};
          attribute s : ${type} = load + x;
          constraint cd { s <= 10.0${unit} }
        }
        part def Q { attribute L : ${type} default = 1.0${unit}; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 3.0${unit}; assert constraint tie { p.x == 50.0${unit} } }
        part q2 : Q;
        constraint topd { q1.p.s <= 10.0${unit} }
      }`);
      const checks = checkConstraints(m!);
      expect(instanceRows(m!, checks, 'R1D::P::cd'), unit).toEqual({ 'R1D::q1::p': 'unknown', 'R1D::q2::p': 'satisfied' });
      const topd = checks.find((c) => m!.qualifiedName(c.id) === 'R1D::topd')!;
      expect(topd.result, unit).toBe('unknown');
      // The numeric surface reads the instance rows the check gives (`contextRows`).
      const numeric = checkConstraintsNumeric(m!).find((r) => r.id.endsWith(`@R1D::q1::p`) && m!.qualifiedName(r.id.split('@')[0]!) === 'R1D::P::cd');
      expect(numeric?.result, unit).toBe('unknown');
    }
    // In a tree: top's `part :>> b` asserts its a's k, and m = load * k is read for top's b's a: not read there.
    const { model: t } = await loadModelText(`package Sh7 {
      part def T0 {
        attribute load : ScalarValues::Real default = 1.0;
        attribute k : ScalarValues::Real default = 1.0;
        attribute m : ScalarValues::Real = load * k;
        constraint c { m <= 10.0 }
      }
      part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; bind a.load = L; }
      part def T2 { attribute L : ScalarValues::Real default = 1.0; part b : T1; bind b.L = L; }
      part top : T2 { attribute :>> L = 5.0; part :>> b { assert constraint { a.k == 50.0 } } }
    }`);
    expect(instanceRows(t!, checkConstraints(t!), 'Sh7::T0::c')).toEqual({ 'Sh7::T2::b::a': 'satisfied', 'Sh7::top::b::a': 'unknown' });
  });

  it('reads no value of another dimension: both comparisons abstain, in their own sentences', async () => {
    const { model: m } = await loadModelText(`package UD {
      part def P {
        attribute load : ISQ::MassValue default = 1.0 [SI::kg];
        attribute cap : ISQ::MassValue = 10.0 [SI::kg];
        constraint lit { load <= 10.0 }
        constraint c { load <= cap }
      }
      part def Q { attribute L : ISQ::LengthValue default = 1.0 [SI::m]; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 5.0 [SI::m]; }
    }`);
    const checks = checkConstraints(m!);
    const row = (rel: string) => checks.find((x) => m!.qualifiedName(x.id) === rel)!.instances!.find((i) => i.instance === 'UD::q1::p')!;
    expect([row('UD::P::lit').result, row('UD::P::c').result]).toEqual(['unknown', 'unknown']);
    expect(row('UD::P::lit').message).toBe(
      'Could not evaluate: load is not read in UD::q1::p: the binding carries 5 [SI::m] into it, a quantity of L ' +
        'where it declares M, so no comparison is made on it',
    );
    expect(row('UD::P::c').message).toContain('L and M are different physical dimensions');
  });
});

describe('instanceRollup — the reporting formatter (F4)', () => {
  const m = parseModel(`package R {
    part def P { attribute load : ScalarValues::Real; constraint c { load <= 10.0 } }
    part q : P;
    part p2 : P;
  }`).model;
  const rel = m.all().find((e) => m.qualifiedName(e.id) === 'R::P::c')!;

  const groupRow = (
    i: number,
    result: 'satisfied' | 'violated' | 'unknown',
    generic = false,
  ) => ({
    contextId: rel.id,
    context: 'R::q',
    featureId: rel.id,
    qualifiedName: 'R::P::c',
    result,
    bindings: [] as unknown[],
    message: '',
    ...(generic ? { generic: true as const } : { instance: `R::q${i}` }),
  });

  const check = (instances: unknown[]): ConstraintCheck => ({
    id: rel.id,
    ownerId: rel.ownerId,
    expression: 'load <= 10.0',
    result: 'unknown',
    message: '',
    instances: instances as ConstraintCheck['instances'],
  });

  it('counts a group, caps violated findings at five, and warns only when one is violated', () => {
    const rows = instanceRollup(
      m,
      check([
        groupRow(0, 'satisfied', true),
        groupRow(1, 'violated'),
        groupRow(2, 'violated'),
        groupRow(3, 'violated'),
        groupRow(4, 'violated'),
        groupRow(5, 'violated'),
        groupRow(6, 'violated'),
        groupRow(7, 'satisfied'),
      ]),
    );
    const rollup = rows.find((r) => r.instances);
    expect(rollup).toBeDefined();
    expect(rollup!.instances).toMatchObject({ total: 8, generic: 1, satisfied: 2, violated: 6, unknown: 0, unread: 0 });
    expect(rollup!.severity).toBe('warning');
    // At most five violated-instance findings, in instance order.
    const violated = rows.filter((r) => r.instance !== undefined);
    expect(violated.map((r) => r.instance)).toEqual(['R::q1', 'R::q2', 'R::q3', 'R::q4', 'R::q5']);
  });

  it('is info when every instance holds, and never says "all" when some are unread', () => {
    const clean = instanceRollup(m, check([groupRow(0, 'satisfied', true), groupRow(1, 'satisfied')]));
    expect(clean.find((r) => r.instances)!.severity).toBe('info');
    const unread = instanceRollup(
      m,
      check([
        groupRow(0, 'satisfied', true),
        groupRow(1, 'satisfied'),
        { ...groupRow(2, 'unknown'), abstention: 'past-cap' as const },
      ]),
    );
    const rollup = unread.find((r) => r.instances)!;
    expect(rollup.instances!.unread).toBe(1);
    expect(rollup.message).not.toMatch(/\ball\b/i);
  });

  it('reports the violation of a group of one, with no roll-up to count it (PI-1)', () => {
    // A relation a usage owns, read in its one other instance: the group is
    // that instance alone (the usage's own row is the check itself).
    const one = instanceRollup(m, check([groupRow(1, 'violated')]));
    expect(one.map((r) => [r.severity, r.instance, r.relation, r.instances])).toEqual([
      ['warning', 'R::q1', 'R::P::c', undefined],
    ]);
    expect(one[0]!.message).toBe('R::P::c (load <= 10.0) is violated in R::q1');
    // One that holds is counted nowhere and listed nowhere: no finding at all.
    expect(instanceRollup(m, check([groupRow(1, 'satisfied')]))).toEqual([]);
  });

  it('folds binding-carried context rows past twenty, one finding per result (via)', () => {
    const via = (k: number, result: 'satisfied' | 'violated') => ({
      ...groupRow(0, result),
      instance: undefined,
      via: true as const,
      context: `R::c${k}`,
      featureId: rel.id,
      message: `row ${k}`,
    });
    const rows = (n: number) => Array.from({ length: n }, (_, k) => via(k, k < 3 ? 'violated' : 'satisfied'));
    // Twenty: one finding each, in the pipeline's own words.
    expect(instanceRollup(m, check(rows(20))).map((r) => r.message)).toEqual(rows(20).map((r) => r.message));
    // Twenty-one: one per result, counting the rest.
    const folded = instanceRollup(m, check(rows(21)));
    expect(folded.map((r) => [r.severity, r.message])).toEqual([
      ['warning', 'R::P::c (load <= 10.0): 3 of 21 contexts a binding carries a value into miss the target (R::c0, R::c1, R::c2)'],
      [
        'info',
        'R::P::c (load <= 10.0): 18 of 21 contexts a binding carries a value into meet the target (R::c3, R::c4, R::c5, R::c6, R::c7, \u2026 and 13 more)',
      ],
    ]);
  });

  it('reports a group of one whose instance could not be read, as the verify lane does (info)', () => {
    // No roll-up counts it, so it is a finding of its own, in the row's own
    // sentence: `could not be read` for an unknown, `is not read` for one the
    // tool did not read (a cap, the coverage guard) — the roll-up's two words.
    // A row sentence that already begins `{relation} is not read in {instance}:`
    // says it once (it said it twice: `… is not read in R::q1: R::P::c is not read in R::q1: why`).
    const unknown = { ...groupRow(1, 'unknown'), message: 'Could not evaluate: load has no value in R::q1: defaults differ' };
    const notRead = { ...groupRow(1, 'unknown'), abstention: 'not-enumerated' as const, message: 'Could not evaluate: R::P::c is not read in R::q1: why' };
    expect(instanceRollup(m, check([unknown])).map((r) => [r.severity, r.instance, r.relation, r.instances, r.message])).toEqual([
      ['info', 'R::q1', 'R::P::c', undefined, 'R::P::c (load <= 10.0) could not be read in R::q1: load has no value in R::q1: defaults differ'],
    ]);
    expect(instanceRollup(m, check([notRead]))[0]!.message).toBe('R::P::c (load <= 10.0) is not read in R::q1: why');
    // Only that head: a sentence naming another relation or instance is kept whole.
    const other = { ...notRead, message: 'Could not evaluate: R::P::d is not read in R::q1: why' };
    expect(instanceRollup(m, check([other]))[0]!.message).toBe(
      'R::P::c (load <= 10.0) is not read in R::q1: R::P::d is not read in R::q1: why',
    );
    // In a group of two or more, the roll-up counts it, and no row of its own is added.
    const two = instanceRollup(m, check([groupRow(0, 'satisfied', true), unknown]));
    expect(two.map((r) => [r.severity, r.instances?.unknown])).toEqual([['info', 1]]);
  });

  it('makes sysml-check --strict fail on a usage-owned relation violated in its one other instance (PI-1)', async () => {
    // E's r17: Q's own p holds (L's default 1), q1's p does not (50 > 10).
    // `verify` refutes `R17::Q::p::c2 in R17::q1::p`; the check said "OK, 0
    // findings" because the instance was a group of one, which had no roll-up.
    const text = [
      'package R17 {',
      '  part def P { attribute load : ScalarValues::Real default = 1.0; }',
      '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P { constraint c2 { load <= 10.0 } } bind p.load = L; }',
      '  part q1 : Q { attribute :>> L = 50.0; }',
      '}',
    ].join('\n');
    const { report } = await loadModelText(text, { fileName: 'r17.sysml', strict: true });
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((d) => [d.code, d.severity, d.instance, d.relation])).toEqual([
      ['validation/constraint-by-instance', 'warning', 'R17::q1::p', 'R17::Q::p::c2'],
    ]);
    // At the anchor rule's element, with a span: q1's redefinition the binding
    // carries into q1's p (PI-2), not the shared usage `part p : P`.
    const { range } = report.diagnostics[0]!;
    expect(range?.start.line).toBe(4);
    expect(text.slice(range!.start.offset, range!.start.offset + 'attribute :>> L = 50.0'.length)).toBe('attribute :>> L = 50.0');
    expect(report.diagnostics[0]!.message).toBe(
      'R17::Q::p::c2 (load <= 10.0) is violated in R17::q1::p: load = 50 — q1.L = 50 through R17::Q\'s `bind p.load = L`',
    );
  });

  it('gives sysml-check an info finding for a usage-owned relation its one other instance could not be read in', async () => {
    // q1's L is a default that differs from Q's: the binding joins two defaults, and q1's p's load has no
    // value. `verify` prints that row inconclusive; the check printed nothing (no roll-up for a group of one).
    const text = [
      'package SLD {',
      '  part def P { attribute load : ScalarValues::Real default = 1.0; }',
      '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P { constraint c2 { load <= 10.0 } } bind p.load = L; }',
      '  part q1 : Q { attribute :>> L default = 50.0; }',
      '}',
    ].join('\n');
    const { report } = await loadModelText(text, { fileName: 'sld.sysml', strict: true });
    expect(report.ok).toBe(true);
    expect(report.diagnostics.map((d) => [d.code, d.severity, d.instance, d.relation])).toEqual([
      ['validation/constraint-by-instance', 'info', 'SLD::q1::p', 'SLD::Q::p::c2'],
    ]);
    expect(report.diagnostics[0]!.message).toMatch(/^SLD::Q::p::c2 \(load <= 10\.0\) could not be read in SLD::q1::p: load has no value in SLD::q1::p: /);
  });

  it('rolls up per usage, and folds the roll-ups of one relation past twenty usages (PI-4, A-L1)', async () => {
    // big-bind-N: N definitions Qk binding their p's load to their L, qk setting L to k: N usages of P,
    // two instances each. Five relations k0..k4 are violated (constraint-violation's); the shared `c` holds.
    const bigBind = (n: number): string =>
      [
        'package Big {',
        '  part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; constraint c { m2 <= 100.0 } }',
        ...Array.from({ length: n }, (_, k) => [
          `  part def Q${k} { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }`,
          `  part q${k} : Q${k} { attribute :>> L = ${k}.0; }`,
          ...(k < 5 ? [`  constraint k${k} { q${k}.p.m2 <= 5.0 }`] : []),
        ]).flat(),
        '}',
      ].join('\n');
    const findings = (text: string) => loadModelText(text, { fileName: 'bb.sysml' }).then(({ model: m }) => validate(m!));
    const at20 = (await findings(bigBind(20))).filter((d) => d.ruleId === 'constraint-by-instance');
    // Twenty usages: one roll-up each, not folded.
    expect(at20.map((d) => d.instances?.total)).toEqual(Array.from({ length: 20 }, () => 2));
    expect(at20[0]!.message).toBe(
      "Big::P::c (m2 <= 100.0) read in each of 2 instances of Big::Q0::p: holds in 2 — 1 of them generic (Big::Q0's own)",
    );
    const all = await findings(bigBind(21));
    const rollups = all.filter((d) => d.ruleId === 'constraint-by-instance');
    // Twenty-one: one finding for the relation, counting every instance and listing the first five usages.
    expect(rollups.map((d) => [d.severity, d.message, d.instances?.total, d.instances?.satisfied])).toEqual([
      [
        'info',
        'Big::P::c (m2 <= 100.0) read per instance in 21 usages (42 instances; first Big::Q0::p, Big::Q1::p, Big::Q2::p, Big::Q3::p, Big::Q4::p, \u2026 and 16 more): holds in 42',
        42,
        42,
      ],
    ]);
    // The generic rows are the roll-up's, not the target rule's (PI-5), and k0..k4 stand: 5 + 1 findings.
    expect(all.filter((d) => d.ruleId === 'target-by-specialisation')).toEqual([]);
    expect(all.filter((d) => d.ruleId === 'constraint-violation')).toHaveLength(5);
  });

  it('names an unknown’s cause and the cap an unread instance met, and ends a long violated list with an ellipsis (PI-6, C.3)', () => {
    const cap = 'Could not evaluate: load is not read in R::q4: a binding of this model holds in more than 4,096 contexts';
    const rows = [
      groupRow(0, 'satisfied', true),
      { ...groupRow(1, 'unknown'), cause: 'defaults-differ' as const },
      { ...groupRow(2, 'unknown'), cause: 'defaults-differ' as const },
      { ...groupRow(3, 'unknown'), cause: 'free' as const },
      { ...groupRow(4, 'unknown'), abstention: 'past-cap' as const, cause: 'past-cap' as const, detail: cap },
      ...[5, 6, 7, 8, 9, 10].map((i) => groupRow(i, 'violated')),
    ];
    const rollup = instanceRollup(m, check(rows)).find((r) => r.instances)!;
    // Unknown instances by cause, each with its first path; the unread ones by the cap; `, …` for the sixth violated.
    expect(rollup.message).toBe(
      "R::P::c (load <= 10.0) read in each of 11 instances of R::q: violated in 6 (R::q5, R::q6, R::q7, R::q8, R::q9, …), " +
        'holds in 1, could not be read in 3 (defaults differ: R::q1; no bound feature has a value: R::q3); ' +
        "not read in 1 (a binding of this model holds in more than 4,096 contexts) — 1 of them generic (R::P's own)",
    );
    expect(rollup.instances).toMatchObject({ total: 11, violated: 6, unknown: 3, unread: 1 });
    // An unknown row with no kind gives the cause in its own sentence, not "for another reason".
    const bare = instanceRollup(m, check([groupRow(0, 'satisfied', true), { ...groupRow(1, 'unknown'), detail: 'Could not evaluate: a referenced value is unknown' }]));
    expect(bare.find((r) => r.instances)!.message).toContain('could not be read in 1 (a referenced value is unknown: R::q1)');
  });

  it('quotes a path segment holding " in " or "@", in the relation, the usage and the instance (PI-11)', async () => {
    expect(quotePath('R::q1::p')).toBe('R::q1::p');
    expect(quotePath('R::q in 1::p')).toBe("R::'q in 1'::p");
    expect(quotePath('A@B::x')).toBe("'A@B'::x");
    expect(quotePath("R::'q in 1'::p")).toBe("R::'q in 1'::p");
    const quoted = instanceRollup(m, check([groupRow(0, 'satisfied', true), { ...groupRow(1, 'violated'), instance: 'R::q in 1' }]));
    expect(quoted.map((r) => r.message)).toEqual([
      "R::P::c (load <= 10.0) read in each of 2 instances of R::q: violated in 1 (R::'q in 1'), holds in 1 — 1 of them generic (R::P's own)",
      "R::P::c (load <= 10.0) is violated in R::'q in 1'",
    ]);
    // The row's own fields stay the raw path: they are data, not text.
    expect(quoted[1]!.instance).toBe('R::q in 1');
    expect(quoted[0]!.instances!.listed).toEqual(['R::q in 1']);
    // And in a context row's sentence, the specialiser's path (target-by-specialisation, a binding-carried row).
    const { model: tm } = await loadModelText(`package Common { attribute m : ScalarValues::Real; constraint t { m >= 0.9 } }
      package LA { part def 'X in Y' { attribute 'est@1' :>> Common::m = 0.78; } }`);
    expect(validate(tm!).filter((d) => d.ruleId === 'target-by-specialisation').map((d) => d.message)).toEqual([
      "'X in Y'::'est@1' = 0.78 misses Common::t (m >= 0.9)",
    ]);
  });

  it('folds context rows by verdict and cause, past twenty (PI-12)', () => {
    const via = (k: number, cause: 'free' | 'defaults-differ') => ({
      ...groupRow(0, 'unknown'),
      instance: undefined,
      via: true as const,
      context: `R::c${k}`,
      cause,
      message: `row ${k}`,
    });
    const rows = Array.from({ length: 22 }, (_, k) => via(k, k < 12 ? 'free' : 'defaults-differ'));
    expect(instanceRollup(m, check(rows)).map((r) => r.message)).toEqual([
      'R::P::c (load <= 10.0): 12 of 22 contexts a binding carries a value into could not be read, no bound feature has a value (R::c0, R::c1, R::c2, R::c3, R::c4, … and 7 more)',
      'R::P::c (load <= 10.0): 10 of 22 contexts a binding carries a value into could not be read, defaults differ (R::c12, R::c13, R::c14, R::c15, R::c16, … and 5 more)',
    ]);
    // The target rule folds with the same helper: two verdicts and two causes are four findings.
    expect(foldByVerdictAndCause(rows).map((g) => [g.result, g.cause, g.rows.length])).toEqual([
      ['unknown', 'free', 12],
      ['unknown', 'defaults-differ', 10],
    ]);
  });

  it('puts the source value and the binding in a violated instance’s sentence (PI-11, C.3)', async () => {
    const { model: um } = await loadModelText(`package UV {
      part def P { attribute load : ISQ::MassValue default = 1.0 [kg]; constraint c { load <= 10.0 [kg] } }
      part def Q { attribute L : ISQ::MassValue default = 1.0 [kg]; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 50000.0 [g]; }
      part q2 : Q { attribute :>> L = 5.0 [kg]; }
    }`);
    const violated = validate(um!).filter((d) => d.ruleId === 'constraint-by-instance' && d.instance !== undefined);
    expect(violated.map((d) => d.message)).toEqual([
      "UV::P::c (load <= 10.0 [kg]) is violated in UV::q1::p: load = 50 [kg] — q1.L = 50000 [g] through UV::Q's `bind p.load = L`",
    ]);
    // A source path and a holder holding " in " or "@" are quoted, in the message only (the listed names stay raw).
    const { model: qm } = await loadModelText(`package UQ {
      part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }
      part def 'Q in R' { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part 'q in 1' : 'Q in R' { attribute :>> L = 50.0; }
      part 'A@B' : 'Q in R' { attribute :>> L = 60.0; }
    }`);
    const quoted = validate(qm!).filter((d) => d.ruleId === 'constraint-by-instance');
    expect(quoted.filter((d) => d.instance !== undefined).map((d) => d.message).sort()).toEqual([
      "UQ::P::c (load <= 10.0) is violated in UQ::'A@B'::p: load = 60 — 'A@B'.L = 60 through the `bind p.load = L` of UQ::'Q in R'",
      "UQ::P::c (load <= 10.0) is violated in UQ::'q in 1'::p: load = 50 — 'q in 1'.L = 50 through the `bind p.load = L` of UQ::'Q in R'",
    ]);
    expect(quoted.find((d) => d.instances !== undefined)!.instances!.listed.slice().sort()).toEqual(['UQ::A@B::p', 'UQ::q in 1::p']);
    // A derived source in another unit prints no figure of the wrong unit: the converted reading stands alone.
    const { model: dm } = await loadModelText(`package UD {
      part def P { attribute load : ISQ::MassValue default = 1.0 [kg]; constraint c { load <= 10.0 [kg] } }
      part def Q { attribute L : ISQ::MassValue default = 1.0 [kg]; attribute M : ISQ::MassValue default = 1.0 [kg]; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> M = 25000.0 [g]; attribute :>> L = M * 2; }
    }`);
    const derived = validate(dm!).filter((d) => d.ruleId === 'constraint-by-instance' && d.instance !== undefined);
    expect(derived.map((d) => d.message)).toEqual([
      "UD::P::c (load <= 10.0 [kg]) is violated in UD::q1::p: load = 50 [kg] — q1.L through UD::Q's `bind p.load = L`",
    ]);
  });

  it('counts a group of more instances than the tool reads as unread, naming the cap (PI-7)', async () => {
    // Nine relations over 2,001 instances each: the ninth would take the sweep past 16,384 instance readings,
    // so its group is left unexpanded. It was one target-by-specialisation sentence with no count.
    const text = [
      'package CapN {',
      `  part def P { attribute load : ScalarValues::Real default = 1.0; ${Array.from({ length: 9 }, (_, k) => `constraint c${k} { load <= ${10 + k}.0 }`).join(' ')} }`,
      '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }',
      ...Array.from({ length: 2000 }, (_, k) => `  part q${k} : Q { attribute :>> L = ${k % 7}.0; }`),
      '}',
    ].join('\n');
    const { model: cm } = await loadModelText(text);
    const d = validate(cm!);
    const capped = d.filter((x) => x.ruleId === 'constraint-by-instance' && x.instances !== undefined && x.instances.unread > 0);
    expect(capped.map((x) => [x.severity, x.message, x.instances])).toEqual([
      [
        'info',
        'CapN::P::c8 (load <= 18.0) read per instance in CapN::Q::p: not read in 2,001 (more than 16,384 instance readings in this model)',
        { total: 2001, generic: 0, satisfied: 0, violated: 0, unknown: 0, unread: 2001, listed: [] },
      ],
    ]);
    // The unread group is the roll-up's now, not target-by-specialisation's sentence beside it.
    expect(d.filter((x) => x.ruleId === 'target-by-specialisation')).toEqual([]);
    // The frame cap (a binding held in more than 4,096 contexts) leaves a group unread too: a lower bound of its instances.
    const frames = [
      'package CapF {',
      '  part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }',
      '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }',
      ...Array.from({ length: 2100 }, (_, k) => `  part q${k} : Q { attribute :>> L = ${k % 7}.0; }`),
      '}',
    ].join('\n');
    const { model: fm } = await loadModelText(frames);
    const fd = validate(fm!);
    expect(fd.filter((x) => x.ruleId === 'constraint-by-instance').map((x) => [x.severity, x.message])).toEqual([
      ['info', 'CapF::P::c (load <= 10.0) read per instance in CapF::Q::p: not read in at least 2,101 (a binding of this model holds in more than 4,096 contexts)'],
    ]);
    // The structured count is a lower bound too (the `instances` payload says so).
    expect(fd.find((x) => x.ruleId === 'constraint-by-instance')?.instances).toMatchObject({ unread: 2101, atLeast: true });
    expect(fd.filter((x) => x.ruleId === 'target-by-specialisation')).toEqual([]);
  }, 120000);

  it('leaves a definition’s own (generic) row to the roll-up, not to target-by-specialisation (PI-5)', async () => {
    // E's m1: the generic row used to be reported twice, once by each rule, and the app listed only one.
    const { model: m } = await loadModelText(
      [
        'package H {',
        '  part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }',
        '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }',
        '  part q1 : Q { attribute :>> L = 50.0; }',
        '  part q2 : Q { attribute :>> L = 5.0; }',
        '}',
      ].join('\n'),
    );
    const d = validate(m!);
    expect(d.filter((x) => x.ruleId === 'target-by-specialisation')).toEqual([]);
    expect(d.filter((x) => x.ruleId === 'constraint-by-instance').map((x) => x.instances?.total).sort()).toEqual([3, undefined]);
  });

  it('points a violated instance at the line that makes it differ, never at the usage they share (PI-2)', async () => {
    // E's m1: each instance's finding pointed at Q's `part p : P`, the line every instance shares, so an
    // agent edited the definition. It points at the member stating the value the binding carries in (q1's
    // `:>> L`, also where the relation reads a value derived from the bound one), else at the element the
    // instance is read in (q2's `part :>> p`), else at the instance's innermost own usage (r1, whose K the
    // bound L derives from — never the `sys` r1 and r2 share).
    const anchored = async (text: string) => {
      const { report } = await loadModelText(text, { fileName: 'pi2.sysml' });
      return report.diagnostics
        .filter((d) => d.code === 'validation/constraint-by-instance' && d.instance !== undefined)
        .map((d) => [d.instance, d.range!.start.line, text.slice(d.range!.start.offset).split(/[;{]/)[0]!.trim()]);
    };
    expect(
      await anchored(
        [
          'package PA {',
          '  part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0; constraint c { load + extra <= 10.0 } }',
          '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }',
          '  part q1 : Q { attribute :>> L = 50.0; }',
          '  part q2 : Q { part :>> p { attribute :>> extra = 20.0; } }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([
      ['PA::q1::p', 4, 'attribute :>> L = 50.0'],
      ['PA::q2::p', 5, 'part :>> p'],
    ]);
    expect(
      await anchored(
        [
          'package PB {',
          '  part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }',
          '  part def R { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real = 2.0 * K; part p : P { constraint c2 { m2 >= 0.0 } } bind p.load = L; }',
          '  part sys {',
          '    part r1 : R { attribute :>> K = 5.5; }',
          '    part r2 : R { attribute :>> K = 6.0; }',
          '  }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([
      ['PB::sys::r1::p', 5, 'part r1 : R'],
      ['PB::sys::r2::p', 6, 'part r2 : R'],
    ]);
    expect(
      await anchored(
        [
          'package PC {',
          '  part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; constraint c { m2 >= 0.0 } }',
          '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }',
          '  part q1 : Q {',
          '    attribute :>> L = 50.0;',
          '  }',
          '  part q2 : Q {',
          '    attribute :>> L = 60.0;',
          '  }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([
      ['PC::q1::p', 5, 'attribute :>> L = 50.0'],
      ['PC::q2::p', 8, 'attribute :>> L = 60.0'],
    ]);
    // A specialised definition's own instance (Q2's p) is read in Q2: its finding points at Q2's `:>> L`,
    // not at Q's `part p : P`, which Q's own p and q3's p share.
    expect(
      await anchored(
        [
          'package R3 {',
          '  part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }',
          '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }',
          '  part def Q2 :> Q {',
          '    attribute :>> L = 50.0;',
          '  }',
          '  part q3 : Q;',
          '}',
        ].join('\n'),
      ),
    ).toEqual([['R3::Q2::p', 5, 'attribute :>> L = 50.0']]);
  });

  it('names the value that breaks the relation, points at its line, and states a cause shared by instances once (PI-2, S1)', async () => {
    const findings = async (text: string) => {
      const { report } = await loadModelText(text, { fileName: 'pi2s1.sysml' });
      return report.diagnostics
        .filter((d) => d.code === 'validation/constraint-by-instance' && d.instance !== undefined)
        .map((d) => [d.instance, d.range!.start.line, text.slice(d.range!.start.offset).split(/[;{]/)[0]!.trim(), d.elementName, d.message.slice(d.message.indexOf(' is violated in '))]);
    };
    const defs = [
      '  part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0; }',
      '  part def Q {',
      '    attribute L : ScalarValues::Real default = 1.0;',
      '    part p : P { constraint c2 { load + extra <= 10.0 } }',
      '    bind p.load = L;',
      '  }',
    ];
    // Two values reach q2's p: `load = 2` through `L`, `extra = 20` through `E`. Put back to its default `extra` holds
    // the relation, `load` does not, so `extra` is the difference: named, and anchored at the line stating it.
    expect(
      await findings(['package G1 {', ...defs, '  part q2 : Q { attribute :>> L = 2.0; attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }', '}'].join('\n')),
    ).toEqual([['G1::q2::p', 8, 'attribute E : ScalarValues::Real = 20.0', 'E', ' is violated in G1::q2::p: extra = 20']]);
    // A relation Q owns, read in q2 (a context, not a group): the same line, where it had pointed at `part q2`.
    expect(
      (
        await findings(
          [
            'package G0 {',
            ...defs.slice(0, 1),
            '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; constraint c2 { p.load + p.extra <= 10.0 } }',
            '  part q2 : Q { attribute :>> L = 2.0; attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }',
            '}',
          ].join('\n'),
        )
      ).map((f) => f.slice(0, 4)),
    ).toEqual([['G0::q2', 4, 'attribute E : ScalarValues::Real = 20.0', 'E']]);
    // Only the one read there is: named too, where no binding carries it (it had no value clause).
    expect(
      await findings(['package G2 {', ...defs, '  part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }', '}'].join('\n')),
    ).toEqual([['G2::q2::p', 8, 'attribute E : ScalarValues::Real = 20.0', 'E', ' is violated in G2::q2::p: extra = 20']]);
    // Neither put back alone holds it: the first read a binding carried is named, as before.
    expect(
      await findings(['package G3 {', ...defs, '  part q2 : Q { attribute :>> L = 20.0; attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }', '}'].join('\n')),
    ).toEqual([['G3::q2::p', 8, 'attribute :>> L = 20.0', 'L', " is violated in G3::q2::p: load = 20 — q2.L = 20 through G3::Q's `bind p.load = L`"]]);
    // One cause: a definition's usage states the value, so its own instance and each part typed by the definition
    // read it from that one line. One finding, at the line (named for what it redefines), listing the others.
    const shared = await findings(
      ['package G4 {', ...defs, '  part def R { part q : Q { attribute :>> L = 50.0; } }', '  part r1 : R;', '  part r2 : R;', '}'].join('\n'),
    );
    expect(shared).toEqual([
      [
        'G4::R::q::p',
        8,
        'attribute :>> L = 50.0',
        'L',
        " is violated in G4::R::q::p: load = 50 — q.L = 50 through G4::Q's `bind p.load = L`; the same line breaks it in G4::r1::q::p, G4::r2::q::p",
      ],
    ]);
    // Not a cause the line states: the relation fails on a default too (`extra`), so putting the read back does not
    // mend it. No fold and no 'breaks it' clause: one finding per instance, at its own line.
    const notCause = await findings(
      ['package FN {', '  part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 20.0; }', ...defs.slice(1), '  part def R { part q : Q { attribute :>> L = 5.0; } }', '  part r1 : R;', '  part r2 : R;', '}'].join('\n'),
    );
    expect(notCause.map((f) => f[0])).toEqual(['FN::R::q::p', 'FN::r1::q::p', 'FN::r2::q::p']);
    expect(notCause.some((f) => String(f[4]).includes('the same line breaks it'))).toBe(false);
    // Past the five a group asks, instances that read alike share the answer: seven parts typed by R, beside a part
    // whose binding gives a second read, are still one finding at the shared line, not one more per later part.
    const many = await findings(
      ['package FC {', ...defs, '  part def R { part q : Q { attribute :>> L = 50.0; } }', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `  part r${n} : R;`), '  part q9 : Q { attribute E : ScalarValues::Real = 0.0; bind p.extra = E; }', '}'].join('\n'),
    );
    expect(many.filter((f) => f[2] === 'attribute :>> L = 50.0')).toHaveLength(1);
    expect(many.map((f) => f[0])).toEqual(['FC::R::q::p']);
    expect(String(many[0]![4])).toContain('… and 2 more');
    // A finding about a context that reaches a value through a reference names the context's instance, not
    // the feature the last link ends at (p50's `load`, q2's p1's): the line to edit is the instance's.
    const named = async (text: string) =>
      (await loadModelText(text, { fileName: 'pi2s1n.sysml' })).report.diagnostics
        .filter((d) => d.code === 'validation/target-by-specialisation')
        .map((d) => d.message);
    const T0 = 'part def T0 { attribute load : ScalarValues::Real default = 1.0; }';
    expect(
      await named(
        ['package G7 {', T0, 'part p1 : T0;', 'part p50 : T0 { attribute :>> load = 50.0; }', 'part def P { ref part r1 : T0 default = p1; ref part r2 : T0 = r1; constraint c { r2.load <= 10.0 } }', 'part pa : P;', 'part pb : P { ref part :>> r1 = p50; }', '}'].join('\n'),
      ),
    ).toEqual(['pb::r2.load = 50 misses P::c (r2.load <= 10.0)']);
    expect(
      await named(
        ['package G8 {', T0, 'part def P { part p1 : T0; ref part r1 : T0 = p1; ref part r2 : T0 = r1; constraint c { r2.load <= 10.0 } }', 'part def Q { part p : P; }', 'part q1 : Q;', 'part q2 : Q { part :>> p { part :>> p1 { attribute :>> load = 50.0; } } }', '}'].join('\n'),
      ),
    ).toEqual(['q2::p::r2.load = 50 misses P::c (r2.load <= 10.0)']);
    // A satisfy context keeps the satisfier's name (h6), and a renamed redefinition no reference is read through
    // its own (f1f): neither is the context's anonymous element or a name the finding's line does not carry.
    expect(
      await named(
        ['package H6 {', 'part def P { attribute load : ScalarValues::Real default = 1.0; }', "requirement def 'Load in range' { subject s : P; require constraint { s.load <= 10.0 } }", 'part p1 : P { attribute :>> load = 50.0; }', "satisfy 'Load in range' by p1;", '}'].join('\n'),
      ),
    ).toEqual(["p1::s.load = 50 misses a constraint in 'Load in range' (s.load <= 10.0)"]);
    expect(
      await named(
        ['package F1f {', 'part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }', 'part p : P { attribute heavy :>> load = 50.0; }', '}'].join('\n'),
      ),
    ).toEqual(['p::heavy = 50 misses P::c (load <= 10.0)']);
    // A value the instance's own element redefines (`extra`) is not among the reads: the relation is not mended by
    // putting the one read back, so no read is said to break it and the first read a binding carried is named.
    expect(
      await findings(
        ['package G5 {', ...defs, '  part q2 : Q { attribute :>> L = 2.0; part :>> p { attribute :>> extra = 20.0; } }', '}'].join('\n'),
      ),
    ).toEqual([['G5::q2::p', 8, 'attribute :>> L = 2.0', 'L', " is violated in G5::q2::p: load = 2 — q2.L = 2 through G5::Q's `bind p.load = L`"]]);
  });

  it('takes every context reading a binding carries, at the line stating the carried value (PI-3)', async () => {
    // h2c and k2: q's L reaches Q's `p.m2` through Q's `bind p.load = L` (`bind p.x = L`); M7: q2's K
    // reaches the bound L. They were target-by-specialisation findings at P's m2, which mbse-workflow
    // reports as a target's verdict ("do not change an estimate to meet it"); they are instance findings,
    // at the member stating the value the binding carries in (q's `:>> L`, Q2's in a definition context),
    // else at the context itself (M7: q2's K feeds Q's L, written in Q for every Q).
    const findings = async (lines: string[]) => {
      const text = lines.join('\n');
      const { report } = await loadModelText(text, { fileName: 'pi3.sysml' });
      return report.diagnostics
        .filter((d) => d.code === 'validation/constraint-by-instance' || d.code === 'validation/target-by-specialisation')
        .map((d) => [d.code!.slice('validation/'.length), d.severity, d.instance, d.range!.start.line, text.slice(d.range!.start.offset).split(/[;{]/)[0]!.trim()]);
    };
    const P = '  part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }';
    const Q = '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; constraint c { p.m2 >= 0.0 } }';
    expect(
      await findings(['package H2C {', P, Q, '  part q : Q {', '    attribute :>> L = 50.0;', '  }', '  part q2 : Q { attribute :>> L = 60.0; }', '}']),
    ).toEqual([
      ['constraint-by-instance', 'warning', 'H2C::q', 5, 'attribute :>> L = 50.0'],
      ['constraint-by-instance', 'warning', 'H2C::q2', 7, 'attribute :>> L = 60.0'],
    ]);
    // Its Solve row points where its Check row does (C.3: `anchorId ?? baseId`), not at the relation.
    const h2c = parseModel(['package H2C {', P, Q, '  part q : Q { attribute :>> L = 50.0; }', '}'].join('\n')).model;
    const solved = checkConstraintsNumeric(h2c).filter((r) => r.context?.contextId !== undefined);
    expect(solved.map((r) => [h2c.qualifiedName(r.context!.contextId), h2c.qualifiedName(h2c.get(r.anchorId!)!.ownerId!), h2c.get(r.anchorId!)!.attrs.value])).toEqual([
      ['H2C::q', 'H2C::q', 50],
    ]);
    expect(
      await findings(['package H2D {', P, Q, '  part def Q2 :> Q {', '    attribute :>> L = 50.0;', '  }', '}']),
    ).toEqual([['constraint-by-instance', 'warning', 'H2D::Q2', 5, 'attribute :>> L = 50.0']]);
    expect(
      await findings([
        'package K2 {',
        '  part def P { attribute x : ScalarValues::Real; attribute m2 : ScalarValues::Real = 10.0 - x; }',
        '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.x = L; constraint c { p.m2 >= 0.0 } }',
        '  part q : Q {',
        '    attribute :>> L = 50.0;',
        '  }',
        '}',
      ]),
    ).toEqual([['constraint-by-instance', 'warning', 'K2::q', 5, 'attribute :>> L = 50.0']]);
    // M7's q2 is read at its own instance (E7): its load of 50 breaks c, at q2's own usage (the K it sets
    // reaches the load through Q's own `L = 2.0 * K`, which no member of q2 states).
    expect(
      await findings([
        'package M7 {',
        '  part def Q {',
        '    attribute K : ScalarValues::Real default = 0.5;',
        '    attribute L : ScalarValues::Real = 2.0 * K;',
        '    attribute load : ScalarValues::Real;',
        '    bind load = L;',
        '    constraint c { load <= 5.0 }',
        '  }',
        '  part q1 : Q;',
        '  part q2 : Q { attribute :>> K = 25.0; }',
        '}',
      ]),
    ).toEqual([['constraint-by-instance', 'warning', 'M7::q2', 10, 'part q2 : Q']]);
    // No binding carries the reading: a target over L that q redefines reads q's own L, and Q's asserted
    // `defL` read in Q2 reads L, the binding's source, not a value carried in. Both stay a target's.
    expect(
      await findings([
        'package DIRECT {',
        '  part def P { attribute load : ScalarValues::Real; }',
        '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; constraint lim { L <= 100.0 } }',
        '  part q : Q { attribute :>> L = 500.0; }',
        '}',
      ]),
    ).toEqual([['target-by-specialisation', 'warning', undefined, 4, 'attribute :>> L = 500.0']]);
    expect(
      await findings([
        'package FanA {',
        P,
        '  part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real; assert constraint defL { L == 2.0 * K } part p : P; bind p.load = L; constraint cq { p.load <= 5.0 } }',
        '  part def Q2 :> Q { attribute :>> K = 25.0; }',
        '  part q0 : Q2;',
        '}',
      ]),
    ).toEqual([
      // Q2's own readings of defL and cq, at Q2's instance (E7): the binding joins Q2's asserted L of 50 to p's
      // `load default = 1.0`, which no assertion replaces (decision 14 amended 2026-10-22), so neither row is
      // read there — instance findings still, at Q2 (the 50 was read, and cq violated, a warning).
      ['constraint-by-instance', 'info', 'FanA::Q2', 4, 'part def Q2 :> Q'],
      ['constraint-by-instance', 'info', 'FanA::Q2', 4, 'part def Q2 :> Q'],
    ]);
  });
});

describe('anchorFor — the anchor rule (F4)', () => {
  const m = parseModel(`package A {
    part def P { attribute load : ScalarValues::Real; constraint c { load <= 10.0 } }
    part q : P;
  }`).model;
  const rel = m.all().find((e) => m.qualifiedName(e.id) === 'A::P::c')!;
  const q = m.all().find((e) => m.qualifiedName(e.id) === 'A::q')!;
  const check: ConstraintCheck = {
    id: rel.id,
    ownerId: rel.ownerId,
    expression: 'load <= 10.0',
    result: 'unknown',
    message: '',
  };
  const inst = (featureId: string, contextId: string) => ({
    contextId,
    context: 'A::q',
    featureId,
    qualifiedName: 'A::P::c',
    result: 'violated' as const,
    bindings: [],
    message: '',
  });

  it('keeps a user, non-implicit feature and falls back off an implicit one', () => {
    expect(anchorFor(m, check, inst(rel.id, q.id))).toBe(rel.id);
    // A missing (implicit) feature re-anchors to the context's user usage.
    expect(anchorFor(m, check, inst('missing', q.id))).toBe(q.id);
    // Nothing at all: the relation itself.
    expect(anchorFor(m, check, inst('missing', 'missing'))).toBe(rel.id);
  });
});

/*
 * A.2.9: a per-instance reading that throws is that reading's `internal` abstention, in the A.9 sentence
 * naming the error's class — never a throw out of the sweep. `validate()` threw with it, and the app's
 * Problems view (`safeValidate`) then showed nothing: every other relation's verdict and every other rule's
 * finding went with it. Each case arms the stub above for one read, so the rest of the model reads as it
 * does unarmed; each fails with its containment removed (planted bug P17 and its siblings).
 */
describe('a per-instance reading that throws is reported, never thrown (A.2.9)', () => {
  afterEach(() => {
    thrower.armed = undefined;
  });
  const rowOf = (m: Model, checks: ConstraintCheck[], qualified: string) => checks.find((x) => m.qualifiedName(x.id) === qualified)!;
  const instanceRow = (m: Model, checks: ConstraintCheck[], qualified: string, at: string) =>
    rowOf(m, checks, qualified).instances!.find((i) => i.instance === at)!;
  /** What survives a throw: `other`'s violation (another relation) and the unresolved import (another rule). */
  const survivors = (m: Model) => {
    const other = m.all().find((e) => e.declaredName === 'other')!.id;
    return validate(m)
      .filter((d) => d.ruleId === 'unresolved-import' || (d.ruleId === 'constraint-violation' && d.elementId === other))
      .map((d) => d.ruleId)
      .sort();
  };
  const failed = (name: string, instance: string) =>
    `${name} is not read in ${instance}: the per-instance reading failed (RangeError); reported, not dropped`;

  // Two instances of one shared usage Q's p (F7): q1's p holds (2 + 3 <= 10), q2's p does not (20 + 3).
  const GROUP = `package T2 {
    import Missing::*;
    part def P { attribute x : ScalarValues::Real default = 3.0; attribute load : ScalarValues::Real default = 1.0; constraint c { load + x <= 10.0 } }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
    part q1 : Q { attribute :>> L = 2.0; }
    part q2 : Q { attribute :>> L = 20.0; }
    constraint other { q1.L >= 100.0 }
  }`;

  it('a bound read that throws is the read’s abstention, not a depth limit (valueBoundInInstance, P17)', async () => {
    // q's p's load is read through the binding (A.2.2), inside m2's value: the engine's own stack guard
    // around a value expression swallowed any throw there as a depth limit, so P17 left the row unknown in
    // the wrong sentence, and every unit suite green.
    const { model: m } = await loadModelText(`package T1 {
      import Missing::*;
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
      part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
      part q : Q { attribute :>> L = 50.0; }
      attribute z : ScalarValues::Real = 1.0;
      constraint m2NegT { q.p.m2 <= 0.0 }
      constraint loadT { q.p.load <= 100.0 }
      constraint other { z >= 100.0 }
    }`);
    expect([rowOf(m!, checkConstraints(m!), 'T1::m2NegT').result, rowOf(m!, checkConstraints(m!), 'T1::loadT').result]).toEqual([
      'satisfied',
      'satisfied',
    ]);
    // The binding's source, looked up for q's p's load.
    thrower.armed = (fn, args) => fn === 'boundSourceIn' && args[1] === 'T1::q::p::load';
    let checks = checkConstraints(m!);
    expect(rowOf(m!, checks, 'T1::m2NegT').result).toBe('unknown');
    expect(rowOf(m!, checks, 'T1::m2NegT').message).toContain(failed('load', 'T1::q::p'));
    expect(rowOf(m!, checks, 'T1::other').result).toBe('violated');
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
    // The value the source names, read at the binding's root (the package): q's L, at q — failing there
    // only, inside the scalar read through the binding (a throw from every read of q's L is no per-instance
    // failure: the binding's own `#bind` row reads it too). loadT reads q's p's load directly, outside any
    // value's stack guard. m2NegT's unit-aware reading did not fail, but the scalar reading of the m2 it
    // reads did: a verdict over a name the per-instance reading abstains on is that abstention (the branch
    // review of O2, A-H1 through a derived value), so the failure is reported there too, never dropped
    // beside the twin's verdict.
    const inside = (fn: string) => new Error().stack!.includes(fn);
    thrower.armed = (fn, args) => fn === 'defaultGivesWayIn' && args[2] === 'T1::q' && inside('valueBoundInInstance');
    checks = checkConstraints(m!);
    expect(rowOf(m!, checks, 'T1::loadT').result).toBe('unknown');
    expect(rowOf(m!, checks, 'T1::loadT').message).toContain(failed('load', 'T1::q::p'));
    expect(rowOf(m!, checks, 'T1::m2NegT').result).toBe('unknown');
    expect(rowOf(m!, checks, 'T1::m2NegT').message).toContain(failed('load', 'T1::q::p'));
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
    // The same, inside its unit-aware twin only (m2's derivation, which decides m2NegT): its failure is
    // that reading's `internal` refusal, never a value read unit-blind past it — the scalar read, which
    // succeeds, does not fill it. loadT reads no derivation, and stands.
    thrower.armed = (fn, args) => fn === 'defaultGivesWayIn' && args[2] === 'T1::q' && inside('boundInInstanceQ');
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
    checks = checkConstraints(m!);
    expect([rowOf(m!, checks, 'T1::m2NegT').result, rowOf(m!, checks, 'T1::loadT').result]).toEqual(['unknown', 'satisfied']);
    expect(rowOf(m!, checks, 'T1::m2NegT').message).toContain(failed('load', 'T1::q::p'));
  });

  it('a default standing that throws is the read’s abstention (valueBoundInInstance, F8)', async () => {
    // W2's q2: Q's L is valueless, so P's default 5 is q2's p's load, read where the binding holds it per
    // feature (defaultStandsIn) — inside m2's value, where a throw passed for a depth limit.
    const { model: m } = await loadModelText(`package W2 {
      import Missing::*;
      part def P { attribute load : ScalarValues::Real default = 5.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
      part def Q { attribute L : ScalarValues::Real; part p : P; bind p.load = L; }
      part q1 : Q { attribute :>> L = 50.0; }
      part q2 : Q;
      constraint c2 { q2.p.m2 >= 0.0 }
      constraint other { q1.L >= 100.0 }
    }`);
    expect(rowOf(m!, checkConstraints(m!), 'W2::c2').result).toBe('satisfied');
    thrower.armed = (fn, args) => fn === 'defaultStandsIn' && args[1] === 'W2::q2::p::load';
    const checks = checkConstraints(m!);
    expect(rowOf(m!, checks, 'W2::c2').result).toBe('unknown');
    expect(rowOf(m!, checks, 'W2::c2').message).toContain(failed('load', 'W2::q2::p'));
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
  });

  it('an enclosing-assert walk that throws is the read’s abstention (enclosingAssertOn)', async () => {
    const { model: m } = await loadModelText(GROUP);
    thrower.armed = (fn, args) => fn === 'enclosingAssertOn' && args[4] === 'T2::q1::p';
    const checks = checkConstraints(m!);
    // q1's p read for its group row: the walk threw for the name it read, which abstains in the read's sentence.
    const q1 = instanceRow(m!, checks, 'T2::P::c', 'T2::q1::p');
    expect([q1.result, q1.cause]).toEqual(['unknown', 'internal']);
    expect(q1.message).toContain(failed('load', 'T2::q1::p'));
    // The group's other rows read as unarmed.
    expect(instanceRow(m!, checks, 'T2::P::c', 'T2::q2::p').result).toBe('violated');
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
    // Thrown at every read, own rows' included (`other` reads q1.L at the package's instance), where no group
    // row is around it: the sweep still stands.
    thrower.armed = (fn) => fn === 'enclosingAssertOn';
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
    expect(instanceRow(m!, checkConstraints(m!), 'T2::P::c', 'T2::q1::p').message).toContain(failed('load', 'T2::q1::p'));
    // So is the enclosing rule's own question, asked before it (H5, assertDefinitionIn).
    thrower.armed = (fn, args) => fn === 'assertDefinitionIn' && args[2] === 'T2::q1::p';
    const asked = instanceRow(m!, checkConstraints(m!), 'T2::P::c', 'T2::q1::p');
    expect([asked.result, asked.cause]).toEqual(['unknown', 'internal']);
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
  });

  it('an element’s equation against a bound value that throws is the read’s abstention (definedAgainstBoundIn)', async () => {
    // RY4's shape: p's `x == y * 2.0` against q's bound `L = 3.0`, which meet (3): `lim` is violated.
    const { model: m } = await loadModelText(`package RY {
      import Missing::*;
      part def P { attribute x : ScalarValues::Real; attribute y : ScalarValues::Real = 1.5; }
      part q { part p : P { assert constraint tie { x == y * 2.0 } } attribute L : ScalarValues::Real = 3.0; bind p.x = L; }
      attribute z : ScalarValues::Real = 1.0;
      constraint lim { q.p.x <= 2.5 }
      constraint other { z >= 100.0 }
    }`);
    expect(rowOf(m!, checkConstraints(m!), 'RY::lim').result).toBe('violated');
    // Thrown for q's p's x, wherever it is asked — the scalar read, the specialiser's, the unit-aware twin's and
    // the binding's own row: the row abstains in the read's sentence, and every other row and rule stands.
    thrower.armed = (fn, args) => fn === 'definedAgainstBoundIn' && args[2] === 'RY::q::p';
    const checks = checkConstraints(m!);
    expect(rowOf(m!, checks, 'RY::lim').result).toBe('unknown');
    expect(rowOf(m!, checks, 'RY::lim').message).toContain(failed('x', 'RY::q::p'));
    expect(rowOf(m!, checks, 'RY::other').result).toBe('violated');
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
    // Inside the unit-aware twin only (`definedQuantity`): its failure is that reading's `internal` refusal, never
    // a throw out of the read.
    const inside = (fn: string) => new Error().stack!.includes(fn);
    thrower.armed = (fn) => fn === 'definedAgainstBoundIn' && inside('definedQuantity');
    expect(() => checkConstraints(m!)).not.toThrow();
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
  });

  it('a binding’s own reading that throws is its row, reported, and the sweep stands (bindingConflicts)', async () => {
    const { model: m } = await loadModelText(GROUP);
    // The binding's reading sits deeper below the sweep than a stack trace's default ten frames.
    const inside = (fn: string) => {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 200;
      try {
        return new Error().stack!.includes(fn);
      } finally {
        Error.stackTraceLimit = limit;
      }
    };
    // The `#bind` reading of Q's `bind p.load = L` (in Q, and in q1 and q2, where L is another value), which
    // asks whether the two ends' values differ there: nothing contained it, and validate() threw.
    thrower.armed = (fn) => fn === 'defaultGivesWayIn' && inside('bindingConflicts');
    const checks = checkConstraints(m!);
    const bound = checks.filter((c) => c.conflict === 'bind');
    expect(bound.length).toBeGreaterThan(0);
    for (const c of bound) {
      expect(c.result).toBe('unknown');
      expect(c.message).toMatch(/^Could not evaluate: `bind p\.load = L` is not read in .*: the per-instance reading failed \(RangeError\); reported, not dropped$/);
    }
    expect(instanceRow(m!, checks, 'T2::P::c', 'T2::q2::p').result).toBe('violated');
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
  });

  it('a group row whose reading throws is that row’s abstention, and the group’s others stand (F7)', async () => {
    const { model: m } = await loadModelText(GROUP);
    // q2's p's own default, asked at q2's p only: nothing contains the throw but the group's expansion.
    thrower.armed = (fn, args) => fn === 'defaultGivesWayIn' && args[2] === 'T2::q2::p';
    const checks = checkConstraints(m!);
    const q2 = instanceRow(m!, checks, 'T2::P::c', 'T2::q2::p');
    expect([q2.result, q2.abstention, q2.cause]).toEqual(['unknown', 'internal', 'internal']);
    expect(q2.message).toBe(`Could not evaluate: ${failed('T2::P::c', 'T2::q2::p')}`);
    expect(instanceRow(m!, checks, 'T2::P::c', 'T2::q1::p').result).toBe('satisfied');
    expect(rowOf(m!, checks, 'T2::other').result).toBe('violated');
    // The roll-up counts the row as not read (it names no unknown's cause yet: PI-6, N3); the other rule's
    // finding stands.
    expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
    const rollup = validate(m!).filter((d) => d.ruleId === 'constraint-by-instance' && d.instances !== undefined);
    expect(rollup.map((d) => d.message)).toEqual([
      "T2::P::c (load + x <= 10.0) read in each of 3 instances of T2::Q::p: holds in 2, could not be read in 1 (the reading failed: T2::q2::p) — 1 of them generic (T2::Q's own)",
    ]);
  });

  /** The obligations lane's rows of `rel` read in a context, with why each is not encoded. */
  const goals = (m: Model, rel: string) =>
    obligationsOf(m)
      .filter((o) => o.element.qualifiedName.startsWith(`${rel} in `))
      .map((o) => `${o.element.qualifiedName}: ${o.encodable === true ? 'encoded' : o.encodable.detail}`);

  it('a goal row whose reading throws is that row’s refusal, and the worklist stands (groupGoalRows)', async () => {
    const { model: m } = await loadModelText(GROUP);
    // q2's p's goal row, read in the obligations lane: nothing contained its reading, and `verify` threw.
    thrower.armed = (fn, args) => fn === 'readRelation' && args[6] === 'T2::q2::p';
    expect(goals(m!, 'T2::P::c')).toEqual([
      "T2::P::c in T2::Q::p (T2::Q's own): encoded",
      'T2::P::c in T2::q1::p: encoded',
      `T2::P::c in T2::q2::p: ${failed('T2::P::c', 'T2::q2::p')}`,
    ]);
    // `verify` closes such a row in a sentence that blames the tool, not the user's relation.
    const sentence = failed('T2::P::c', 'T2::q2::p');
    expect(isFailedReading(sentence)).toBe(true);
    expect(refusalHead('unread-definition', sentence)).toBe('this tool failed while reading the relation');
    expect(refusalTail('unread-definition', sentence)).toContain('This is a failure of this tool, not a defect in the relation');
    // A limit of the tool is not a failure of it, and a relation nobody can read is a defect of the relation.
    expect(refusalTail('unread-definition', 'T2::P::c is not read in T2::q3::p: why')).toContain('This is a limit of this tool');
    // A body over a parameter of its own may state no value: the model does not decide it, and the relation is no defect.
    const shadowed = 'y in own is SH::P::own::y, its own in parameter; this tool reads a body in its owner\'s scope, where `y` is SH::P::y — another feature — so the body is not read';
    expect(refusalTail('unread-definition', shadowed)).toContain('its body is over a parameter of its own');
    expect(refusalTail('unread-definition', shadowed)).not.toContain('the model decides it');
    expect(refusalTail('unresolved-name', 'x')).toContain('This is a defect in the relation');
  });

  // The instance index's own calls (the seam, A.2.9): armed before the model loads, since the load's validation
  // builds the index once per revision. Unarmed, the load threw away the model.
  describe('through the instance index’s seam', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a usage whose grouping throws is that group’s one `internal` refusal, and the sweep stands (instanceGroups)', async () => {
      const real = instanceIndexSeam.instanceSitesOf;
      vi.spyOn(instanceIndexSeam, 'instanceSitesOf').mockImplementation((definitions, usage) => {
        if (usage.declaredName === 'p') throw new RangeError('instanceSitesOf, planted to throw');
        return real(definitions, usage);
      });
      const { model: m } = await loadModelText(GROUP);
      expect(m).toBeDefined();
      const checks = checkConstraints(m!);
      const rows = rowOf(m!, checks, 'T2::P::c').instances!;
      expect(rows.map((i) => [m!.qualifiedName(i.contextId), i.result, i.abstention, i.message])).toEqual([
        ['T2::Q::p', 'unknown', 'internal', `Could not evaluate: ${failed('T2::P::c', 'T2::Q::p')}`],
      ]);
      expect(rowOf(m!, checks, 'T2::other').result).toBe('violated');
      expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
      // `verify` closes that row in a sentence that blames the tool, on both engines.
      for (const engine of ['literal', 'smt'] as const) {
        const row = (await verifyModel(m!, { engine })).results.find((r) => r.detail.includes('T2::Q::p'));
        expect(row?.detail, engine).toContain('this tool failed while reading the relation (unread-definition)');
        expect(row?.detail, engine).toContain('This is a failure of this tool, not a defect in the relation');
      }
      // The obligations lane and the numeric lane read the same refusal.
      expect(goals(m!, 'T2::P::c')).toEqual([`T2::P::c in T2::Q::p: ${failed('T2::P::c', 'T2::Q::p')}`]);
      expect(checkConstraintsNumeric(m!).filter((r) => r.context?.baseId === rowOf(m!, checks, 'T2::P::c').id).map((r) => r.result)).toEqual([
        'unknown',
      ]);
    });

    it('a guard reads no asserted default, so a throw planted there is never met (readFeatures)', async () => {
      // The guard read an asserted equation over a default, which it now never asks of: no assertion replaces a
      // default since decision 14 was amended (2026-10-22, `replaceableDefaults`). A throw planted there made
      // the group's one `internal` refusal; the group now reads as without it.
      const planted = vi.spyOn(instanceIndexSeam, 'assertHeldInSome').mockImplementation(() => {
        throw new RangeError('assertHeldInSome, planted to throw');
      });
      // P's x is the asserted `x == 2.0 * K` over its default; Q's binding gives p's K each Q's L.
      const { model: m } = await loadModelText(`package T3 {
        import Missing::*;
        part def P {
          attribute K : ScalarValues::Real default = 1.0;
          attribute x : ScalarValues::Real default = 2.0;
          assert constraint xd { x == 2.0 * K }
          constraint c { x <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.K = L; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { attribute :>> L = 20.0; }
        constraint other { q1.L >= 100.0 }
      }`);
      expect(m).toBeDefined();
      const checks = checkConstraints(m!);
      expect(planted).not.toHaveBeenCalled();
      // x is P's 2 in every P, and `c` holds there: no instance reads it otherwise.
      expect([rowOf(m!, checks, 'T3::P::c').result, rowOf(m!, checks, 'T3::P::c').instances ?? []]).toEqual(['satisfied', []]);
      expect(survivors(m!)).toEqual(['constraint-violation', 'unresolved-import']);
    });

    it('listing the asserted equations no surface reads that throws leaves every row unknown, never the sweep (equatedParts)', async () => {
      vi.spyOn(instanceIndexSeam, 'enclosingAsserts').mockImplementation(() => {
        throw new RangeError('enclosingAsserts, planted to throw');
      });
      const { model: m } = await loadModelText(GROUP);
      expect(m).toBeDefined();
      const sentence =
        'the asserted equations that define a `default` this tool does not read (decision 14) could not be listed: the reading ' +
        'failed (RangeError); reported, not dropped, so no relation that may read one is read';
      const checks = checkConstraints(m!);
      const c = rowOf(m!, checks, 'T2::P::c');
      expect([c.result, c.message]).toEqual(['unknown', `Could not evaluate: ${sentence}`]);
      expect(c.instances!.map((i) => [i.result, i.cause])).toEqual([
        ['unknown', 'internal'],
        ['unknown', 'internal'],
        ['unknown', 'internal'],
      ]);
      expect(rowOf(m!, checks, 'T2::other').result).toBe('unknown');
      // Another rule's finding stands, beside the rows it could not read (an `info` each); the obligations lane
      // encodes no goal over them.
      const found = validate(m!);
      expect(found.filter((d) => d.ruleId === 'unresolved-import').length).toBe(1);
      expect(found.filter((d) => d.ruleId === 'constraint-violation').map((d) => d.severity)).toEqual(['info', 'info']);
      expect(obligationsOf(m!).filter((o) => o.role !== 'axiom' && o.encodable === true)).toEqual([]);
    });

    it('listing what an instance reads otherwise that throws leaves every row unknown, never the load (satisfierTaint)', async () => {
      vi.spyOn(instanceIndexSeam, 'satisfiersOtherwise').mockImplementation(() => {
        throw new RangeError('satisfiersOtherwise, planted to throw');
      });
      // Unarmed, the throw ended the load: `import/internal-error`, and no model at all (the branch review of
      // per-instance-rest).
      const { model: m, report } = await loadModelText(`package SD0B {
        part def T0 { attribute load : ScalarValues::Real default = 1.0; }
        requirement def RF { subject s : T0; require constraint { s.load <= 5.0 } }
        part def W { part p1 : T0; satisfy RF by p1; }
        part w : W { part :>> p1 { attribute :>> load = 50.0; } }
        attribute K : ScalarValues::Real = 3.0;
        constraint plain { K <= 5.0 }
      }`);
      expect(m).toBeDefined();
      expect(report.diagnostics.filter((d) => d.code === 'import/internal-error')).toEqual([]);
      const sentence =
        'the satisfactions, subjects and references an instance reads otherwise could not be listed: the reading failed ' +
        '(RangeError); reported, not dropped, so no relation that may read one is read';
      const checks = checkConstraints(m!);
      expect(rowOf(m!, checks, 'SD0B::plain').message).toBe(`Could not evaluate: ${sentence}`);
      const rf = checks.find((c) => m!.qualifiedName(c.id) === 'SD0B::RF::«ConstraintUsage»')!;
      expect(rf.instances!.map((i) => [i.result, i.abstention, i.message])).toEqual([['unknown', 'internal', `Could not evaluate: ${sentence}`]]);
      // The numeric surface and the obligations lane read the same refusal; `bounds`' refusal names it too.
      expect(checkConstraintsNumeric(m!).filter((r) => r.result !== 'unknown')).toEqual([]);
      expect(obligationsOf(m!).filter((o) => o.role !== 'axiom' && o.encodable === true)).toEqual([]);
      const k = m!.all().find((e) => m!.qualifiedName(e.id) === 'SD0B::K')!;
      expect(equatedPartsMeasureRefusal(m!, k.id, 'SD0B::K', 'K')).toBe(
        'the satisfactions, subjects and references an instance reads otherwise could not be listed: the reading failed ' +
          '(RangeError); reported, not dropped, so no bound of a value read through one is claimed',
      );
    });
  });
});

describe('the per-instance memo key (A-L2)', () => {
  it('keys a value on the feature, the instance and the context it is read in', () => {
    // Two names that differ only in `at`, under one `inst`, are two values: neither answers for the other.
    expect(valueKey('f', 'M::q::p', 'ctx1')).not.toBe(valueKey('f', 'M::q::p', 'ctx2'));
    expect(valueKey('f', 'M::q::p', 'ctx1')).not.toBe(valueKey('f', 'M::q::p'));
    expect(valueKey('f', 'M::q::p', 'ctx1')).not.toBe(valueKey('f', 'M::q2::p', 'ctx1'));
    // Read where it is written, and not in an instance, the key is what it was.
    expect(valueKey('f')).toBe('f');
    expect(valueKey('f', undefined, 'ctx1')).toBe('f@ctx1');
    expect(valueKey('f', 'M::q::p')).toBe('f@M::q::p');
  });
});

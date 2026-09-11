/**
 * The verification lane's two reporting surfaces, before any solver exists.
 *
 * `contracts` says what each requirement assumes and guarantees, on which
 * subject, honoured by which part. `obligations` says what would have to be
 * shown, over which axioms, and which relations the unit gates refuse. Neither
 * says anything about truth, and this file is where that line is held: every
 * assertion below is about STRUCTURE — how many clauses, in which bucket, with
 * which refusal reason — and none of them asks whether a requirement holds.
 *
 * Three things make the suite worth its runtime rather than a restatement of
 * the implementation:
 *
 *  - The two shipped examples are measured, not described. `uav-isr` is the
 *    flagship, and its two requirements are the ones the plan's first
 *    deliverable quotes; if the inventory stops finding them the numbers here
 *    move.
 *  - The role map is enumerated. Five ways a relation enters a model —
 *    `require`, `assume`, `assert constraint`, a plain `constraint`, a feature
 *    value — land in exactly three buckets, and the one the first draft of the
 *    plan got wrong (a plain `constraint` is an OBLIGATION, not an axiom) has a
 *    case of its own with the consequence spelled out.
 *  - Every gate that refuses a relation is exercised through the report rather
 *    than through the gate, because "encodability is the same gate the numeric
 *    surface applies" is a claim about what this module CALLS.
 *
 * The `Verify` / `Derive` / `Refine` orientations are measured on probe models
 * written here: neither shipped example declares one (`examples/uav-isr.sysml`
 * carries two `satisfy` statements and nothing else), so an assertion about
 * their direction has nowhere else to come from.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Model } from '@core/index';
import { parseModel } from '@text/index';
import { isUserElement } from '@api/index';
import { contractReport, obligationDigest, obligationsReport } from '@api/index';
import {
  clauseInheritanceCensus,
  contractsOf,
  contractOf,
  isUserModelElement,
  obligationsOf,
  STATEMENT_KIND_LIBRARY,
  SYSPROSE_VERIFICATION_LIBRARY,
} from '@semantics/index';
import { checkText } from '@text/check';
import { loadModelText } from '@text/load';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** Load a snippet with the standard library bound, as every command does. */
async function load(text: string, name = 'probe.sysml'): Promise<Model> {
  const { model } = await loadModelText(text, { fileName: name });
  if (!model) throw new Error(`${name} produced no model`);
  return model;
}

/**
 * Every dotted path an expression node names.
 *
 * Written here rather than imported so the assertion is independent of the
 * walk under test: a bug in `contracts.ts`'s own path collection would
 * otherwise agree with itself.
 */
function refPaths(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) return [];
  const n = node as Record<string, unknown>;
  if (n.kind === 'ref') return [(n.path as string[]).join('.')];
  return ['operand', 'left', 'right', 'cond', 'then', 'else'].flatMap((k) => refPaths(n[k]));
}

describe('contracts — the inventory of examples/uav-isr.sysml', () => {
  let model: Model;
  beforeAll(async () => {
    model = await load(read('examples/uav-isr.sysml'), 'examples/uav-isr.sysml');
  }, 60_000);

  it('finds two contracts, one per requirement, both on `uav : AirVehicle`', () => {
    const r = contractReport(model);
    expect(r.total).toBe(2);
    expect(r.contracts.map((c) => c.qualifiedName)).toEqual([
      'UAVSurveillanceSystem::EnduranceRequirement',
      'UAVSurveillanceSystem::MassRequirement',
    ]);
    for (const c of r.contracts) {
      expect(c.subject).toMatchObject({ name: 'uav', typeRef: 'AirVehicle', origin: 'declared' });
    }
    expect(r.subjects).toBe(1);
  });

  it('gives each one 0 assumptions, 1 guarantee and `satisfy … by uav`', () => {
    const r = contractReport(model);
    for (const c of r.contracts) {
      expect(c.assumptions).toHaveLength(0);
      expect(c.guarantees).toHaveLength(1);
      expect(c.satisfiedBy.map((s) => s.declaredName)).toEqual(['uav']);
      expect(c.verifiedBy).toEqual([]);
      expect(c.derivedFrom).toEqual([]);
      expect(c.refinedBy).toEqual([]);
    }
    expect(r.contracts.map((c) => c.guarantees[0].expression)).toEqual([
      'uav.endurance >= 45.0 [min]',
      'uav.mtow <= 25.0 [kg]',
    ]);
  });

  it('reads both guarantees as linear real arithmetic, with nothing freed', () => {
    const r = contractReport(model);
    expect(r.contracts.map((c) => c.fragment)).toEqual(['qf-lra', 'qf-lra']);
    expect(r.guaranteesQfLra).toBe(2);
    expect(r.guaranteesQfNra).toBe(0);
    expect(r.guaranteesUnsupported).toBe(0);
    expect(r.contracts.flatMap((c) => c.unsupported)).toEqual([]);
  });

  it('names each guarantee’s variable with its unit and SI factor', () => {
    const [endurance, mass] = contractsOf(model);
    expect(endurance.variables).toEqual([
      {
        path: 'uav.endurance',
        featureId: expect.any(String),
        qualifiedName: 'UAVSurveillanceSystem::AirVehicle::endurance',
        role: 'derived',
        unit: null,
        siFactor: 1,
        siOffset: 0,
      },
    ]);
    expect(mass.variables[0]).toMatchObject({
      path: 'uav.mtow',
      role: 'parameter',
      unit: 'kg',
      siFactor: 1,
    });
  });

  it('`contractOf` answers for one requirement and nothing for a stranger', () => {
    const req = model.all().find((e) => e.declaredName === 'MassRequirement');
    expect(contractOf(model, req!.id)?.qualifiedName).toBe(
      'UAVSurveillanceSystem::MassRequirement',
    );
    const part = model.all().find((e) => e.declaredName === 'uav');
    expect(contractOf(model, part!.id)).toBeUndefined();
  });

  it('the obligations are two open guarantees over an axiom set of bindings', () => {
    const r = obligationsReport(model);
    const guarantees = r.obligations.filter((o) => o.role === 'obligation');
    expect(guarantees).toHaveLength(2);
    for (const o of guarantees) {
      expect(o.status).toBe('open');
      expect(o.encodable).toBe(true);
      expect(o.nonlinear).toBe(false);
      expect(o.evidence).toEqual([]);
    }
    expect(r.byRole.premise).toBe(0);
    // Every axiom is a feature-value binding — the model states no `assert`
    // and no `bind`, so the axiom set is exactly what the features say.
    expect(new Set(r.obligations.filter((o) => o.role === 'axiom').map((o) => o.source))).toEqual(
      new Set(['feature-value']),
    );
    // One of them is the derived endurance equation; the rest are literals.
    const equations = r.obligations.filter(
      (o) => o.role === 'axiom' && o.expression.includes('*'),
    );
    expect(equations.map((o) => o.expression)).toEqual([
      'endurance == battery.capacity * usableEnergyFraction / cruisePower',
    ]);
    expect(r.byStatus['not-encodable']).toBe(0);
    expect(r.byStatus['no-formal-clause']).toBe(0);
  });

  /**
   * THE AXIOM MAGNITUDE, PINNED BY VALUE — the invariant that was invisible for
   * two commits.
   *
   * A literal feature value states the magnitude the FILE STORES: `capacity =
   * 640.0 [W*h]` states `capacity == 640`, not `capacity == 2304000`. The gates
   * never grant that relation a scale (a dimensioned operand against a bare
   * literal is gate (c)'s declared-unit contract), so the row is read verbatim,
   * and a converted number met an unscaled variable in the derived-endurance
   * equation — one symbol pinned twice, 3600 apart, which made every obligation
   * over the shipped example `verification/inconsistent-axioms`. Nothing
   * asserted an axiom's number in either direction: the only thing that would
   * have gone red is an SMT golden that did not exist yet.
   */
  it('states a literal feature value in the magnitude the file stores, never in SI', () => {
    const axioms = new Map(
      obligationsOf(model)
        .filter((o) => o.role === 'axiom' && o.source === 'feature-value')
        .map((o) => [o.element.qualifiedName.split('::').pop() ?? '', o]),
    );
    // 640 W·h, not 2 304 000 J; 25 km, not 25 000 m.
    expect(axioms.get('capacity')?.expression).toBe('capacity == 640');
    expect(axioms.get('range')?.expression).toBe('range == 25');
    // `scaled` is the published answer to "did the gates grant this row a scale
    // map?", and it is what every reader of the worklist lifts its variables
    // by. `false` here is the whole reason the magnitude above is the stored one.
    expect(axioms.get('capacity')?.scaled, 'a literal axiom was granted a scale').toBe(false);
    expect(axioms.get('range')?.scaled).toBe(false);
    // And the variable really does carry the SI factor, so the conversion is
    // available to whoever needs it — it is simply not baked into the axiom.
    expect(axioms.get('range')?.vars[0]?.unit).toBe('km');
  });

  /**
   * The fragment rule, on the one relation in the shipped examples that turns
   * on it. `endurance = battery.capacity * usableEnergyFraction / cruisePower`
   * is a product AND a quotient, so it is nonlinear in general — and linear as
   * the model stands, because all three of its right-hand features carry
   * literal values and fold to a constant. Freeing any of them (a later
   * commit's `--free`) promotes the obligation to QF_NRA. The variable list is
   * asserted with the verdict: a reading that lost the three literal-valued
   * features would answer `false` for the wrong reason.
   */
  it('the derived-endurance axiom is linear once its own literals are substituted', () => {
    const eq = obligationsOf(model).find(
      (o) => o.source === 'feature-value' && o.expression.includes('*'),
    );
    expect(eq?.expression).toBe(
      'endurance == battery.capacity * usableEnergyFraction / cruisePower',
    );
    expect(eq?.vars.map((v) => v.path).sort()).toEqual([
      'battery.capacity',
      'cruisePower',
      'endurance',
      'usableEnergyFraction',
    ]);
    expect(eq?.nonlinear).toBe(false);
    expect(eq?.encodable).toBe(true);
  });
});

describe('contracts — examples/vehicle.sysml', () => {
  it('yields exactly one contract', async () => {
    const model = await load(read('examples/vehicle.sysml'), 'examples/vehicle.sysml');
    const r = contractReport(model);
    expect(r.total).toBe(1);
    expect(r.contracts[0].qualifiedName).toBe('VehicleModel::MassRequirement');
    expect(r.contracts[0].guarantees).toHaveLength(1);
    expect(r.contracts[0].satisfiedBy.map((s) => s.declaredName)).toEqual(['vehicle']);
  }, 60_000);
});

describe('what is and is not a contract', () => {
  it('a `#prose` requirement contributes none', async () => {
    const model = await load(`package P {
  part def Sys { attribute m : Real = 3.0; }
  part s : Sys;
  #prose requirement def Explanation { subject u : Sys; require constraint { u.m > 1.0 } }
  requirement def Real1 { subject u : Sys; require constraint { u.m < 9.0 } }
}`);
    expect(contractsOf(model).map((c) => c.qualifiedName)).toEqual(['P::Real1']);
    // …and neither does its `require` body. The keyword is written on the
    // REQUIREMENT, not on the clause, so a worklist that asked only the clause
    // carried a row belonging to no contract in the inventory beside it — the
    // two surfaces of one commit disagreeing about one model.
    const obligations = obligationsOf(model).filter((o) => o.role === 'obligation');
    expect(obligations.map((o) => o.expression)).toEqual(['u.m < 9.0']);
    expect(obligations[0].requirement?.qualifiedName).toBe('P::Real1');
  }, 60_000);

  /**
   * `requirement r : Def;` is the standard's ordinary way of APPLYING a
   * requirement, and it is the shape commit 2b opened the subject for. It owns
   * no clause, and the clause it inherits is filed once — on the definition, so
   * one constraint does not enter the worklist twice. What it must not be is
   * "prose only, nothing to encode": that is false about a requirement with a
   * constraint body, it is the row a `satisfy` names, and it would inflate
   * `--missing`, the figure that measures how much of a model this lane cannot
   * reach.
   */
  it('a requirement usage inherits its definition’s clause and is not counted as bodiless', async () => {
    const model = await load(`package P {
  part def Sys { attribute m : Real = 3.0; }
  part s : Sys;
  requirement def MassLimit { subject u : Sys; require constraint { u.m < 9.0 } }
  requirement massOk : MassLimit;
  satisfy massOk by s;
}`);
    const usage = contractsOf(model).find((c) => c.qualifiedName === 'P::massOk')!;
    expect(usage.guarantees).toHaveLength(0);
    expect(usage.clausesInheritedFrom.map((d) => d.qualifiedName)).toEqual(['P::MassLimit']);
    expect(usage.subject).toMatchObject({ name: 'u', origin: 'inherited' });
    expect(usage.satisfiedBy.map((s) => s.declaredName)).toEqual(['s']);
    // The clause is filed exactly once, on the definition.
    const shown = obligationsOf(model).filter((o) => o.role === 'obligation');
    expect(shown.map((o) => [o.requirement?.qualifiedName, o.expression, o.status])).toEqual([
      ['P::MassLimit', 'u.m < 9.0', 'open'],
    ]);
    expect(contractReport(model).noFormalClause).toBe(0);
    expect(obligationsOf(model, { missing: true })).toEqual([]);
    expect(obligationsReport(model).missing).toBe(0);
  }, 60_000);

  it('a use case def with an objective is a contract on a behaviour', async () => {
    const model = await load(`package P {
  part def Sys { attribute armed : Real = 1.0; attribute alt : Real = 100.0; }
  part s : Sys;
  use case def Surveil {
    subject sub : Sys;
    objective {
      assume constraint { sub.armed == 1.0 }
      require constraint { sub.alt > 0.0 }
    }
  }
}`);
    const cs = contractsOf(model);
    expect(cs).toHaveLength(1);
    expect(cs[0].qualifiedName).toBe('P::Surveil');
    expect(cs[0].assumptions).toHaveLength(1);
    expect(cs[0].guarantees).toHaveLength(1);
    expect(cs[0].assumptions[0].via).toBe('objective');
    expect(cs[0].subject).toMatchObject({ name: 'sub', typeRef: 'Sys', origin: 'declared' });
    // The objective's assumption is the CASE's, never a system requirement.
    const obs = obligationsOf(model);
    expect(obs.filter((o) => o.role === 'premise').map((o) => o.expression)).toEqual([
      'sub.armed == 1.0',
    ]);
  }, 60_000);

  it('a case with no subject of its own defaults to the case result', async () => {
    const model = await load(`package P {
  case def Measure {
    objective { require constraint { 1.0 > 0.0 } }
  }
}`);
    const cs = contractsOf(model);
    expect(cs).toHaveLength(1);
    expect(cs[0].subject).toEqual({
      name: 'result',
      typeRef: 'Cases::Case::result',
      typeId: null,
      origin: 'case-default',
    });
  }, 60_000);

  /**
   * The notation is `verification def`, not `verification case def`: the
   * grammar's definition keyword list carries `verification` on its own
   * (`sysml.langium`:434) and `VerificationCaseDefinition: 'verification def'`
   * is what the metamodel writes back. Measured, `verification case def X`
   * parses as a nameless `VerificationCaseUsage` followed by a
   * `CaseDefinition X`, which is why the spelling is pinned here.
   */
  it('a verification case binds its subject rather than defaulting it', async () => {
    const model = await load(`package P {
  verification def CheckIt {
    objective { require constraint { 1.0 > 0.0 } }
  }
}`);
    expect(contractsOf(model)[0].subject).toEqual({
      name: 'subj',
      typeRef: 'VerificationCases::VerificationCase::subj',
      typeId: null,
      origin: 'case-bound',
    });
  }, 60_000);

  it('a requirement with prose and no constraint body has no formal clause', async () => {
    const model = await load(`package P {
  part def Sys { attribute m : Real = 3.0; }
  requirement def Wordy { doc /* it shall be good */ subject u : Sys; }
}`);
    const r = contractReport(model);
    expect(r.total).toBe(1);
    expect(r.noFormalClause).toBe(1);
    expect(r.contracts[0].fragment).toBe('unsupported');
    const obs = obligationsOf(model);
    expect(obs.filter((o) => o.status === 'no-formal-clause')).toHaveLength(1);
    expect(obligationsOf(model, { missing: true })).toHaveLength(1);
  }, 60_000);

  it('an assumption with nothing to prove is reported, not silently kept', async () => {
    const model = await load(`package P {
  part def Sys { attribute m : Real = 3.0; }
  requirement def Empty { subject u : Sys; assume constraint { u.m > 0.0 } }
}`);
    const r = contractReport(model);
    expect(r.contracts[0].guarantees).toHaveLength(0);
    expect(r.diagnostics.map((d) => d.code)).toContain('verification/contract-no-guarantee');
    for (const d of r.diagnostics) expect(d.source).toBe('verification');
  }, 60_000);
});

describe('the role map — every relation lands in exactly one bucket', () => {
  let model: Model;
  beforeAll(async () => {
    model = await load(`package P {
  part def Sys {
    attribute m : Real = 3.0;
    attribute derivedM : Real = m * 2.0;
  }
  part s : Sys;
  requirement def R {
    subject u : Sys;
    assume constraint { u.m > 0.0 }
    require constraint { u.m < 9.0 }
  }
  constraint plain { s.m <= 5.0 }
  assert constraint stated { s.m >= 1.0 }
}`);
  }, 60_000);

  it('require is an obligation, assume a premise, assert an axiom', () => {
    const by = (expr: string) => obligationsOf(model).find((o) => o.expression === expr);
    expect(by('u.m < 9.0')).toMatchObject({ role: 'obligation', source: 'require' });
    expect(by('u.m > 0.0')).toMatchObject({ role: 'premise', source: 'assume' });
    expect(by('s.m >= 1.0')).toMatchObject({ role: 'axiom', source: 'assert' });
  });

  /**
   * The row the plan's first draft was missing, and the reason it matters:
   * `checkConstraints` JUDGES a plain constraint, so the SMT engine must judge
   * it too. Filed as an axiom, one false plain constraint would make the axiom
   * set unsatisfiable and downgrade every genuine violation in the run to
   * inconclusive.
   */
  it('a plain `constraint` is an OBLIGATION, not an axiom', () => {
    const plain = obligationsOf(model).find((o) => o.expression === 's.m <= 5.0');
    expect(plain).toMatchObject({ role: 'obligation', source: 'constraint' });
    expect(obligationsOf(model).filter((o) => o.role === 'axiom').map((o) => o.source)).not.toContain(
      'constraint',
    );
  });

  it('a feature value is a binding, so it is an axiom', () => {
    const axioms = obligationsOf(model).filter((o) => o.role === 'axiom');
    expect(axioms.map((o) => o.expression)).toContain('derivedM == m * 2.0');
    expect(axioms.find((o) => o.expression === 'derivedM == m * 2.0')?.source).toBe(
      'feature-value',
    );
  });

  it('a `bind` equality is an axiom', async () => {
    const bound = await load(`package B {
  part def Sys { attribute a : Real = 2.0; attribute b : Real; }
  part s : Sys;
  bind s.a = s.b;
}`);
    const binds = obligationsOf(bound).filter((o) => o.source === 'bind');
    expect(binds).toHaveLength(1);
    expect(binds[0].role).toBe('axiom');
  }, 60_000);

  /**
   * Set EQUALITY, not membership. A `for (const s of sources) expect([…])`
   * passes vacuously on an empty axiom set — a role map that files nothing at
   * all satisfies every allow-list — so the assertion has to name the buckets
   * this model actually produces and fail on a missing one as well as an extra
   * one. `bind` has its own case above; `calculation` has one below, and is a
   * source the plan's §3.2 list does not mention.
   */
  it('the axiom set on this model is exactly its feature values and its `assert`', () => {
    const sources = new Set(
      obligationsOf(model)
        .filter((o) => o.role === 'axiom')
        .map((o) => o.source),
    );
    expect(sources).toEqual(new Set(['feature-value', 'assert']));
  });

  /**
   * A calculation is a DEFINITION when its body is a value expression, and the
   * question is asked of the parsed node rather than of the raw string. The
   * first draft asked a regex, which found the `>` inside the condition of
   * `if s.x > 0.0 then s.a else s.b` and filed a definition as a claim — while
   * `relationEquation` of `./solver`, which switches on `node.kind`, read the
   * same body as `self == expr`. Two surfaces disagreeing about which relations
   * a model states is the divergence the shared relation layer exists to stop.
   */
  it('a calculation with a comparison nested inside its body is still a definition', async () => {
    const calc = await load(`package C {
  part def Sys { attribute a : Real = 1.0; attribute b : Real = 2.0; attribute x : Real = 3.0; }
  part s : Sys;
  calc c2 { if s.x > 0.0 then s.a else s.b }
  calc c4 { s.a * (s.b - 1.0) }
}`);
    const rows = obligationsOf(calc).filter((o) => o.source === 'calculation');
    expect(rows.map((o) => [o.role, o.expression])).toEqual([
      ['axiom', 'c2 == if s.x > 0.0 then s.a else s.b'],
      ['axiom', 'c4 == s.a * (s.b - 1.0)'],
    ]);
  }, 60_000);
});

describe('a clause the standard does not admit where it was written', () => {
  it('`assume constraint` in an action def parses and is reported', async () => {
    const model = await load(`package P {
  action def Go {
    attribute x : Real = 1.0;
    assume constraint { x > 0.0 }
  }
}`);
    const r = contractReport(model);
    const d = r.diagnostics.filter((x) => x.code === 'verification/nonstandard-clause-location');
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe('info');
    expect(d[0].source).toBe('verification');
    expect(d[0].message).toContain('action def');
  }, 60_000);

  it('a named `assert constraint` in an action def is the standard idiom and is silent', async () => {
    const model = await load(`package P {
  action def Go {
    attribute x : Real = 1.0;
    assert constraint precondition { x > 0.0 }
  }
}`);
    expect(
      contractReport(model).diagnostics.map((d) => d.code),
    ).not.toContain('verification/nonstandard-clause-location');
  }, 60_000);
});

describe('the gates that refuse a relation, each listed with its reason', () => {
  const SYS = `part def Sys {
    attribute d : ISQ::LengthValue = 5.0 [km];
    attribute dur : ISQ::DurationValue = 3000.0 [s];
    attribute t1 : ISQ::ThermodynamicTemperatureValue = 20.0 ['°C'];
    attribute t2 : ISQ::ThermodynamicTemperatureValue = 30.0 ['°C'];
    attribute xs : Real[3];
    attribute k : Real = 2.0;
  }`;

  async function refusalFor(body: string): Promise<{ reason: string; detail: string }> {
    const model = await load(`package P {
  ${SYS}
  part s : Sys;
  requirement def R { subject u : Sys; require constraint { ${body} } }
}`);
    const g = contractsOf(model)[0].guarantees[0];
    expect(g.encodable, `\`${body}\` was expected to be refused`).not.toBe(true);
    return g.encodable as { reason: string; detail: string };
  }

  /**
   * The gate that has to be asked FIRST, because every gate below it is
   * satisfied vacuously without it.
   *
   * `relationVarsOf` collects the ids the body's names map to, and a misspelt
   * name maps to none — so a one-character typo produced a relation with an
   * empty variable list, no dimension to clash, no scale to refuse, and a
   * verdict of `encodable: true` in QF_LRA. The same run reported
   * `validation/constraint-violation … a referenced value is unknown` about the
   * identical clause, and `obligations --missing` said "every relation in this
   * model is encodable". A worklist that is honest about what it cannot decide
   * cannot also call an unreadable relation decidable.
   */
  it('refuses a name that resolves to nothing, rather than encoding an empty relation', async () => {
    const model = await load(`package P {
  ${SYS}
  part s : Sys;
  requirement def R { subject u : Sys; require constraint { u.enduranse >= 45.0 } }
}`);
    const g = contractsOf(model)[0].guarantees[0];
    expect(g.encodable).not.toBe(true);
    expect((g.encodable as { reason: string }).reason).toBe('unresolved-name');
    expect((g.encodable as { detail: string }).detail).toContain('u.enduranse');
    expect(g.fragment).toBe('unsupported');
    const r = contractReport(model);
    expect(r.guaranteesQfLra).toBe(0);
    expect(r.guaranteesUnsupported).toBe(1);
    expect(obligationsReport(model).missing).toBe(1);
  }, 60_000);

  /**
   * The invariant behind that gate, asserted on the shipped example rather than
   * on a probe: an ENCODABLE relation names no variable the report cannot also
   * name. `sortPerVar` is keyed by path, so this says every reference in the
   * body reached a feature with a sort.
   */
  it('every reference in an encodable relation appears in its own variable list', async () => {
    const model = await load(read('examples/uav-isr.sysml'), 'examples/uav-isr.sysml');
    for (const o of obligationsOf(model)) {
      if (o.encodable !== true || o.node === null) continue;
      const named = new Set(o.vars.map((v) => v.path));
      for (const path of refPaths(o.node)) {
        expect(named, `${o.expression} reads ${path}, which its variable list does not name`)
          .toContain(path);
        expect(o.sortPerVar[path]).toBeDefined();
      }
    }
  }, 60_000);

  it('refuses a dimension clash', async () => {
    const r = await refusalFor('u.d >= u.dur');
    expect(r.reason).toBe('dimension-clash');
    expect(r.detail).toMatch(/dimension/i);
  }, 60_000);

  it('refuses arithmetic on an offset scale', async () => {
    const r = await refusalFor('u.t2 - u.t1 <= 5.0');
    expect(r.reason).toBe('offset-arithmetic');
    expect(r.detail).toMatch(/offset/i);
  }, 60_000);

  it('refuses a collection-valued feature', async () => {
    const r = await refusalFor('u.xs > 1.0');
    expect(r.reason).toBe('collection-valued');
    expect(r.detail).toContain('xs');
  }, 60_000);

  it('orders °C rather than refusing it — the affine map is monotone', async () => {
    const model = await load(`package P {
  ${SYS}
  part s : Sys;
  requirement def R { subject u : Sys; require constraint { u.t2 >= 300.0 [K] } }
}`);
    expect(contractsOf(model)[0].guarantees[0].encodable).toBe(true);
  }, 60_000);

  it('lists a refused relation rather than dropping it, and says so in the report', async () => {
    const model = await load(`package P {
  ${SYS}
  part s : Sys;
  requirement def R { subject u : Sys; require constraint { u.d >= u.dur } }
}`);
    const r = contractReport(model);
    expect(r.guaranteesUnsupported).toBe(1);
    expect(r.contracts[0].unsupported).toEqual([
      {
        expression: 'u.d >= u.dur',
        reason: 'dimension-clash',
        detail: expect.stringMatching(/dimension/i),
      },
    ]);
    expect(r.diagnostics.map((d) => d.code)).toContain('verification/unsupported-expression');
    const o = obligationsReport(model).obligations.find((x) => x.expression === 'u.d >= u.dur');
    expect(o?.status).toBe('not-encodable');
    expect(obligationsOf(model, { missing: true }).map((x) => x.expression)).toContain(
      'u.d >= u.dur',
    );
  }, 60_000);

  it('a nonlinear guarantee is encodable and marked NRA', async () => {
    const model = await load(`package P {
  part def Sys { attribute a : Real; attribute b : Real; }
  part s : Sys;
  requirement def R { subject u : Sys; require constraint { u.a * u.b <= 10.0 } }
}`);
    const c = contractsOf(model)[0];
    expect(c.guarantees[0].encodable).toBe(true);
    expect(c.guarantees[0].nonlinear).toBe(true);
    expect(c.fragment).toBe('qf-nra');
  }, 60_000);
});

describe('the four orientations, measured on their own probe models', () => {
  it('`satisfy R by X` puts X in satisfiedBy', async () => {
    const model = await load(`package P {
  part def Sys { attribute m : Real = 1.0; }
  part s : Sys;
  requirement def R { subject u : Sys; require constraint { u.m > 0.0 } }
  satisfy R by s;
}`);
    expect(contractsOf(model)[0].satisfiedBy.map((x) => x.declaredName)).toEqual(['s']);
  }, 60_000);

  it('`verify R by C` puts the CASE in verifiedBy', async () => {
    const model = await load(`package P {
  part def Sys { attribute m : Real = 1.0; }
  part s : Sys;
  requirement def R { subject u : Sys; require constraint { u.m > 0.0 } }
  verification def CheckR { objective { require constraint { 1.0 > 0.0 } } }
  verify R by CheckR;
}`);
    const c = contractsOf(model).find((x) => x.qualifiedName === 'P::R')!;
    expect(c.verifiedBy.map((x) => x.declaredName)).toEqual(['CheckR']);
    expect(c.satisfiedBy).toEqual([]);
  }, 60_000);

  it('`derive D from O` reads O as the original and D as the derived', async () => {
    const model = await load(`package P {
  part def Sys { attribute m : Real = 1.0; }
  requirement def Original { subject u : Sys; require constraint { u.m > 0.0 } }
  requirement def Derived { subject u : Sys; require constraint { u.m > 1.0 } }
  derive Derived from Original;
}`);
    const derived = contractsOf(model).find((c) => c.qualifiedName === 'P::Derived')!;
    const original = contractsOf(model).find((c) => c.qualifiedName === 'P::Original')!;
    expect(derived.derivedFrom.map((x) => x.declaredName)).toEqual(['Original']);
    expect(original.derivedFrom).toEqual([]);
  }, 60_000);

  it('`refine R by X` puts X in refinedBy', async () => {
    const model = await load(`package P {
  part def Sys { attribute m : Real = 1.0; }
  requirement def R { subject u : Sys; require constraint { u.m > 0.0 } }
  requirement def Finer { subject u : Sys; require constraint { u.m > 2.0 } }
  refine R by Finer;
}`);
    const c = contractsOf(model).find((x) => x.qualifiedName === 'P::R')!;
    expect(c.refinedBy.map((x) => x.declaredName)).toEqual(['Finer']);
  }, 60_000);
});

describe('`--element` narrows every figure, not only the listing', () => {
  const SCOPED = `package P {
  part def Sys { attribute m : Real = 3.0; }
  package Scoped {
    requirement def Inner { subject u : Sys; require constraint { u.m < 9.0 } }
  }
  package Elsewhere {
    #prose requirement def Prosy { subject u : Sys; require constraint { u.m > 0.0 } }
    action def Go { attribute x : Real = 1.0; assume constraint { x > 0.0 } }
    requirement def NoGuar { subject u : Sys; assume constraint { u.m > 0.0 } }
  }
}`;

  /**
   * A report that narrows its listing and not its findings contradicts itself
   * in one block: it prints `scoped to P::Scoped` and then a diagnostic about
   * `P::Elsewhere::Go`, and a census of statements the reader did not ask
   * about. Both reports are checked, because the second built its diagnostics
   * from an unscoped inventory of its own.
   */
  it('a scoped report carries no diagnostic and no exclusion from outside the scope', async () => {
    const model = await load(SCOPED);
    const scope = model.all().find((e) => model.qualifiedName(e.id) === 'P::Scoped')!;
    const whole = contractReport(model);
    expect(whole.diagnostics.map((d) => d.code).sort()).toEqual([
      'verification/contract-no-guarantee',
      'verification/nonstandard-clause-location',
    ]);
    expect(whole.nonNormativeExcluded).toBe(1);

    const scoped = contractReport(model, { scopeId: scope.id });
    expect(scoped.contracts.map((c) => c.qualifiedName)).toEqual(['P::Scoped::Inner']);
    expect(scoped.diagnostics).toEqual([]);
    expect(scoped.nonNormativeExcluded).toBe(0);
    expect(obligationsReport(model, { scopeId: scope.id }).diagnostics).toEqual([]);
  }, 60_000);

  it('the article of the clause-location message follows the word after it', async () => {
    const model = await load(SCOPED);
    const d = contractReport(model).diagnostics.find(
      (x) => x.code === 'verification/nonstandard-clause-location',
    );
    expect(d?.message).toContain('in the body of an action def');
  }, 60_000);
});

describe('the variables a clause reads, named one per path', () => {
  const PORTS = `package P {
  port def PowerPort { attribute voltage : Real = 12.0; }
  part def Sys {
    out port powerOut : PowerPort;
    in port powerIn : PowerPort;
    attribute plain : Real = 2.0;
  }
  part s : Sys;
  requirement def R {
    subject u : Sys;
    require constraint { u.powerOut.voltage >= u.powerIn.voltage + u.plain }
  }
}`;

  /**
   * An attribute declared in a `port def` is owned by the DEFINITION, so
   * `u.powerOut.voltage` and `u.powerIn.voltage` resolve to one element. A list
   * built per resolved id therefore printed one row for two quantities and lost
   * the other path entirely — in a report whose stated job is to name the
   * variables a clause reads.
   */
  it('two ports of one definition are two variables, not one', async () => {
    const model = await load(PORTS);
    const g = contractsOf(model)[0].guarantees[0];
    expect(g.variables.map((v) => v.path)).toEqual([
      'u.powerOut.voltage',
      'u.powerIn.voltage',
      'u.plain',
    ]);
    // …and they really are the same element, which is why the paths matter.
    expect(g.variables[0].featureId).toBe(g.variables[1].featureId);
    expect(contractsOf(model)[0].variables.map((v) => v.path)).toEqual(g.variables.map((v) => v.path));
  }, 60_000);

  /**
   * §3.1: "Port `attrs.direction` classifies variables as inputs vs outputs."
   * The direction is on the port USAGE, never on the port definition's own
   * attribute, so it is read off the path the relation names rather than off
   * the resolved feature's owner chain — which stops at a `PortDefinition` and
   * would report every port-borne quantity as a plain parameter.
   */
  it('a port-borne variable takes the direction of the port it is read through', async () => {
    const model = await load(PORTS);
    const g = contractsOf(model)[0].guarantees[0];
    expect(g.variables.map((v) => [v.path, v.role])).toEqual([
      ['u.powerOut.voltage', 'output'],
      ['u.powerIn.voltage', 'input'],
      ['u.plain', 'parameter'],
    ]);
  }, 60_000);

  it('a direction written on the feature itself is read too', async () => {
    const model = await load(`package P {
  action def Go { in attribute x : Real = 1.0; out attribute y : Real = 2.0; }
  requirement def R { subject a : Go; require constraint { a.y >= a.x } }
}`);
    expect(contractsOf(model)[0].guarantees[0].variables.map((v) => [v.path, v.role])).toEqual([
      ['a.y', 'output'],
      ['a.x', 'input'],
    ]);
  }, 60_000);

  /**
   * "N contract(s) on M subject(s)" is a census, and a census keyed on two
   * display strings collapses two different `part def Sys` into one.
   */
  it('two same-named subjects of different types are two subjects', async () => {
    const model = await load(`package A {
  part def Sys { attribute m : Real = 1.0; }
  requirement def R1 { subject u : Sys; require constraint { u.m > 0.0 } }
}
package B {
  part def Sys { attribute m : Real = 1.0; }
  requirement def R2 { subject u : Sys; require constraint { u.m > 0.0 } }
}`);
    const r = contractReport(model);
    expect(r.total).toBe(2);
    expect(r.subjects).toBe(2);
  }, 60_000);
});

describe('what the reports never say, and what they always exclude', () => {
  it('a claimed verdict with no evidence record is reported as claimed, not as a pass', async () => {
    const model = await load(`package P {
  part def Sys { attribute m : Real = 3.0; }
  requirement def R {
    subject u : Sys;
    require constraint { u.m < 9.0 }
    metadata RequirementMetadata { attribute verdict = "pass"; }
  }
}`);
    const o = obligationsOf(model).find((x) => x.role === 'obligation')!;
    expect(o.claimedVerdict).toBe('pass');
    expect(o.status).toBe('open');
    expect(o.evidence).toEqual([]);
  }, 60_000);

  it('the library is excluded and the figure is stated', async () => {
    const model = await load(read('examples/uav-isr.sysml'), 'examples/uav-isr.sysml');
    const r = contractReport(model);
    expect(r.libraryExcluded).toBeGreaterThan(0);
    expect(r.contracts.every((c) => !c.qualifiedName.startsWith('Requirements::'))).toBe(true);
  }, 60_000);

  /**
   * `contractsOf` filters with a predicate of its own rather than importing
   * `isUserElement` from `src/api/analytics.ts`, because the API layer imports
   * the semantics layer and the reverse import would close a cycle. A copied
   * predicate is a predicate that drifts, so the two are compared element by
   * element over both shipped examples.
   */
  it('its user-element filter agrees with the one every other report uses', async () => {
    for (const path of ['examples/uav-isr.sysml', 'examples/vehicle.sysml']) {
      const model = await load(read(path), path);
      const mine = model.all().filter((el) => isUserModelElement(model, el)).map((e) => e.id);
      const theirs = model.all().filter((el) => isUserElement(model, el)).map((e) => e.id);
      expect(mine, `${path}: the two user-element filters disagree`).toEqual(theirs);
    }
  }, 60_000);
});

/**
 * The clause a child did not write, and the count of who writes one.
 *
 * `contracts` has always printed `(inherited)` for the SUBJECT of a
 * requirement that takes its definition's. It withheld the same word for
 * CLAUSES: a child that wrote one clause and inherited another was shown one
 * clause where two apply, with nothing on the row to say the second existed.
 * The cases below are written against that asymmetry from both sides — the
 * disclosure appears, and NOTHING else moves: not the model-wide clause
 * counts, not the worklist, not an obligation digest, and not the two rows
 * that already said where a bodiless usage's clauses are filed.
 *
 * The census beside them is the deliverable rather than decoration. It is the
 * number that says whether any modeller writes this shape at all, and it is
 * asserted at 0 over every shipped example so a later feature that would only
 * ever answer for inherited clauses has to justify itself against a
 * measurement rather than against an intuition.
 */
describe('a clause the element did not write is disclosed, and never filed twice', () => {
  /** The probe, in the two spellings whose digests must agree. */
  const probe = (mass: string, speed: string) => `package SpecInherit {
    part def Vehicle {
        attribute mass : ISQ::MassValue;
        attribute topSpeed : ISQ::SpeedValue;
    }
    requirement def MassLimit {
        subject v : Vehicle;
        require constraint { v.mass <= ${mass} }
    }
    requirement def StrictMassLimit :> MassLimit {
        require constraint { v.topSpeed <= ${speed} }
    }
}`;
  const UNITS = probe('1500 [kg]', '60 [m/s]');
  const BARE = probe('1500.0', '60.0');

  it('lists the inherited clause on the child, beside the one the child wrote', async () => {
    const model = await load(UNITS);
    const child = contractsOf(model).find((c) => c.qualifiedName === 'SpecInherit::StrictMassLimit')!;
    // What the child wrote is still exactly what the child wrote.
    expect(child.guarantees.map((g) => g.expression)).toEqual(['v.topSpeed <= 60 [m/s]']);
    expect(child.guarantees.map((g) => g.origin)).toEqual(['declared']);
    // …and the clause it did not write is disclosed rather than withheld.
    expect(child.inheritedClauses.map((g) => g.expression)).toEqual(['v.mass <= 1500 [kg]']);
    expect(child.inheritedClauses.map((g) => g.origin)).toEqual(['inherited']);
    expect(child.inheritedClauses.map((g) => g.role)).toEqual(['require']);
    expect(child.clausesInheritedFrom.map((d) => d.qualifiedName)).toEqual(['SpecInherit::MassLimit']);
    // The disclosure is not a second filing: the model-wide clause census
    // counts the two bodies this file writes, not three.
    const r = contractReport(model);
    expect(r.guaranteesQfLra).toBe(2);
    expect(r.assumptions).toBe(0);
    expect(r.noFormalClause).toBe(0);
  }, 60_000);

  it('files nothing new — one obligation per body, on the element that holds it', async () => {
    const model = await load(UNITS);
    const shown = obligationsOf(model).filter((o) => o.role === 'obligation');
    expect(shown.map((o) => [o.requirement?.qualifiedName, o.expression])).toEqual([
      ['SpecInherit::MassLimit', 'v.mass <= 1500 [kg]'],
      ['SpecInherit::StrictMassLimit', 'v.topSpeed <= 60 [m/s]'],
    ]);
    expect(obligationsReport(model).missing).toBe(0);
  }, 60_000);

  /**
   * The digest is over the SI-lowered normal form, so the two spellings of one
   * relation are one obligation identity. Asserted here because the disclosure
   * above is exactly the point at which a reader might expect an inherited
   * clause to acquire an identity of its own on the child — it does not, and
   * an evidence record keyed on one of these would otherwise be written into
   * the other element's braces.
   */
  it('moves no obligation digest: both spellings of the probe hash the same', async () => {
    const digests = async (text: string) => {
      const model = await load(text);
      return obligationsOf(model)
        .filter((o) => o.role === 'obligation')
        .map((o) => obligationDigest({
          node: o.node,
          vars: o.vars,
          expression: o.expression,
          element: o.element,
        }));
    };
    const withUnits = await digests(UNITS);
    const bare = await digests(BARE);
    expect(withUnits).toHaveLength(2);
    expect(bare).toEqual(withUnits);
  }, 60_000);

  it('counts the shape by the edge family the author wrote it with', async () => {
    const model = await load(UNITS);
    const census = clauseInheritanceCensus(model, contractsOf(model));
    expect(census.contractsWithInheritedClauses).toBe(1);
    expect(census.byEdgeKind.Subclassification).toBe(1);
    expect(census.byEdgeKind.FeatureTyping).toBe(0);
    // The shipped `require constraint { … }` idiom builds an ANONYMOUS clause,
    // which no name can mask — so redefinition of a clause is inexpressible in
    // this spelling however many clauses it inherits.
    expect(census.anonymousClausesInherited).toBe(1);
    expect(census.namedClausesMasked).toBe(0);
  }, 60_000);

  it('reads a usage’s applied definition as the other edge family', async () => {
    const model = await load(`package P {
    part def Sys { attribute mass; }
    requirement def MassLimit {
        subject u : Sys;
        require constraint { u.mass <= 25.0 }
    }
    requirement r : MassLimit;
}`);
    const census = clauseInheritanceCensus(model, contractsOf(model));
    expect(census.contractsWithInheritedClauses).toBe(1);
    expect(census.byEdgeKind.FeatureTyping).toBe(1);
    expect(census.byEdgeKind.Subclassification).toBe(0);
  }, 60_000);

  /**
   * Masking is by `declaredName`, so it fires only where both clauses are
   * NAMED — and the count exists to say how rare that is. A named clause on
   * the child hides the parent's, and the hidden one is absent from the
   * inherited list for the same reason it is absent from every other reading
   * of the type.
   */
  it('counts a named clause a nearer one masks, and does not list it as inherited', async () => {
    const model = await load(`package P {
    part def Sys { attribute mass; }
    requirement def MassLimit {
        subject u : Sys;
        require constraint massOk { u.mass <= 25.0 }
    }
    requirement def StrictMassLimit :> MassLimit {
        require constraint massOk { u.mass <= 10.0 }
    }
}`);
    const contracts = contractsOf(model);
    const child = contracts.find((c) => c.qualifiedName === 'P::StrictMassLimit')!;
    expect(child.guarantees.map((g) => g.expression)).toEqual(['u.mass <= 10.0']);
    expect(child.inheritedClauses).toEqual([]);
    const census = clauseInheritanceCensus(model, contracts);
    expect(census.namedClausesMasked).toBe(1);
    expect(census.contractsWithInheritedClauses).toBe(0);
  }, 60_000);

  /**
   * The census as a measurement, not as a description. Every example this
   * repository ships reads 0 — which is the number a feature that could only
   * ever answer for an inherited clause has to be argued against.
   */
  it('reads 0 on every shipped example', async () => {
    for (const path of [
      'examples/contract-authoring-prompts.sysml',
      'examples/uav-isr-verification.sysml',
      'examples/uav-isr.sysml',
      'examples/uav-power-budget.sysml',
      'examples/vehicle.sysml',
      'examples/views-tour.sysml',
    ]) {
      const model = await load(read(path), path);
      const census = clauseInheritanceCensus(model, contractsOf(model));
      expect(census, `${path} inherits a clause`).toEqual({
        contractsWithInheritedClauses: 0,
        byEdgeKind: { Subclassification: 0, FeatureTyping: 0 },
        namedClausesMasked: 0,
        anonymousClausesInherited: 0,
      });
    }
  }, 180_000);

  /**
   * The other half of the same claim, and the half a fixture can break without
   * anybody noticing: the census is 0 over the WHOLE corpus, not only over the
   * six examples the previous case walks. A fixture that inherits a clause
   * would open a held feature's release gate silently; here it fails loudly
   * instead.
   */
  it('reads 0 over every model in the corpus, not only the examples', async () => {
    const files = execFileSync(
      'find',
      ['examples', 'test/fixtures', '-name', '*.sysml'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .sort();
    expect(files.length).toBeGreaterThan(100);
    let read_ = 0;
    for (const path of files) {
      // A handful of L0 fixtures are deliberately not SysML at all — the case
      // IS that they do not load. Counted rather than silently passed over, so
      // this never becomes an assertion over an empty set.
      const { model } = await loadModelText(read(path), { fileName: path });
      if (!model) continue;
      read_ += 1;
      const census = clauseInheritanceCensus(model, contractsOf(model));
      expect(
        [
          census.contractsWithInheritedClauses,
          census.namedClausesMasked,
          census.anonymousClausesInherited,
        ],
        `${path} inherits a clause`,
      ).toEqual([0, 0, 0]);
    }
    expect(read_).toBeGreaterThan(files.length - 10);
  }, 600_000);

  /**
   * A chain of three, which is where one attribution for the whole row goes
   * wrong: `C :> B :> A` inherits A's assumption and B's guarantee, and a line
   * saying either came from "B, A" names an element that did not write the
   * clause printed beneath it.
   */
  it('attributes each inherited clause to the element that wrote THAT clause', async () => {
    const model = await load(`package Q {
    part def Sys { attribute a; attribute b; attribute c; }
    requirement def A { subject u : Sys; assume constraint { u.a > 0.0 } }
    requirement def B :> A { require constraint { u.b <= 1.0 } }
    requirement def C :> B { require constraint { u.c <= 2.0 } }
}`);
    const c = contractsOf(model).find((x) => x.qualifiedName === 'Q::C')!;
    expect(
      c.inheritedClauses.map((x) => [x.role, x.expression, x.inheritedFrom?.qualifiedName]),
    ).toEqual([
      // Effective-feature order: the nearer general type first.
      ['require', 'u.b <= 1.0', 'Q::B'],
      ['assume', 'u.a > 0.0', 'Q::A'],
    ]);
    // The row-level set is still the distinct owners, and it is the union of
    // the two — which is exactly why it cannot stand in for either.
    expect(c.clausesInheritedFrom.map((d) => d.qualifiedName)).toEqual(['Q::B', 'Q::A']);
    // A clause disclosed twice down the chain is still ONE anonymous clause.
    expect(clauseInheritanceCensus(model, contractsOf(model))).toEqual({
      contractsWithInheritedClauses: 2,
      byEdgeKind: { Subclassification: 2, FeatureTyping: 0 },
      namedClausesMasked: 0,
      anonymousClausesInherited: 2,
    });
  }, 60_000);

  /**
   * The disclosure is a promise that the clause is filed somewhere, so it is
   * made only about an element whose own contract files it. A `#prose` general
   * type files nothing — the author said it binds nothing and the same report
   * counts it under "left out" — and publishing its body on a child's row
   * would show a clause the run files ZERO times.
   */
  it('says nothing about a clause on a general type the run left out', async () => {
    const model = await load(`package V {
    part def Sys { attribute m; }
    #prose requirement def Draft { subject u : Sys; require constraint { u.m <= 30.0 } }
    requirement def Real :> Draft { require constraint { u.m >= 1.0 } }
}`);
    const contracts = contractsOf(model);
    const child = contracts.find((c) => c.qualifiedName === 'V::Real')!;
    expect(child.inheritedClauses).toEqual([]);
    expect(child.clausesInheritedFrom).toEqual([]);
    // Every clause disclosed anywhere is filed exactly once, and the one on the
    // `#prose` statement is filed nowhere — so it is disclosed nowhere either.
    expect(
      obligationsOf(model)
        .filter((o) => o.role === 'obligation')
        .map((o) => o.expression),
    ).toEqual(['u.m >= 1.0']);
    expect(clauseInheritanceCensus(model, contracts).contractsWithInheritedClauses).toBe(0);
  }, 60_000);

  /**
   * The same gate on the case side: a case's contract is read out of its
   * `objective` alone, so an `assume` written straight in a case body is filed
   * by no contract — the general type has no row in the report at all — and a
   * child must not publish it as an inherited promise.
   */
  it('says nothing about a case clause outside an objective, which no contract files', async () => {
    const model = await load(`package U {
    part def Sys { attribute alt; }
    use case def Parent { subject s : Sys; require constraint { s.alt > 0.0 } }
    use case def Child :> Parent { objective { require constraint { s.alt < 100.0 } } }
}`);
    const contracts = contractsOf(model);
    expect(contracts.map((c) => c.qualifiedName)).toEqual(['U::Child']);
    expect(contracts[0].inheritedClauses).toEqual([]);
    expect(clauseInheritanceCensus(model, contracts).contractsWithInheritedClauses).toBe(0);
  }, 60_000);

  /**
   * And the case shape that IS filed. A case's clauses live inside its
   * `objective`, so the walk has to descend one level into an inherited
   * objective rather than stopping at it — otherwise `case def Child :> Parent`
   * keeps the very asymmetry this disclosure closes, on a row whose `subject`
   * line already prints `(inherited)`.
   */
  it('discloses a clause inherited through a case objective', async () => {
    const model = await load(`package S {
    part def Sys { attribute alt; }
    use case def Parent { subject s : Sys; objective { require constraint { s.alt > 0.0 } } }
    use case def Child :> Parent { objective { require constraint { s.alt < 100.0 } } }
}`);
    const contracts = contractsOf(model);
    const child = contracts.find((c) => c.qualifiedName === 'S::Child')!;
    expect(child.guarantees.map((g) => g.expression)).toEqual(['s.alt < 100.0']);
    expect(
      child.inheritedClauses.map((g) => [g.expression, g.via, g.inheritedFrom?.qualifiedName]),
    ).toEqual([['s.alt > 0.0', 'objective', 'S::Parent']]);
    // Read where its AUTHOR wrote it, and filed once — on the parent case.
    expect(
      obligationsOf(model)
        .filter((o) => o.role === 'obligation')
        .map((o) => [o.requirement?.qualifiedName, o.expression]),
    ).toEqual([
      ['S::Parent', 's.alt > 0.0'],
      ['S::Child', 's.alt < 100.0'],
    ]);
    expect(clauseInheritanceCensus(model, contracts).contractsWithInheritedClauses).toBe(1);
  }, 60_000);

  /**
   * `namedClausesMasked` is the number §3.4b's release gate is read off, so it
   * counts only what that gate could then check: one CLAUSE redefining
   * another. An `attribute` claiming a clause's name hides it from every
   * reading of the type, but redefines no promise.
   */
  it('does not count a clause an attribute hides as a redefinition', async () => {
    const model = await load(`package W {
    part def Sys { attribute m; }
    requirement def A { subject u : Sys; require constraint massOk { u.m <= 30.0 } }
    requirement def B :> A { attribute massOk; require constraint { u.m >= 1.0 } }
}`);
    expect(clauseInheritanceCensus(model, contractsOf(model)).namedClausesMasked).toBe(0);
  }, 60_000);

  /** …and one masking is one masking, however many descendants can see it. */
  it('counts a masking once, not once per descendant that sees it', async () => {
    const model = await load(`package X {
    part def Sys { attribute m; }
    requirement def A { subject u : Sys; require constraint massOk { u.m <= 30.0 } }
    requirement def B :> A { require constraint massOk { u.m <= 20.0 } }
    requirement def C :> B { require constraint { u.m >= 1.0 } }
}`);
    expect(clauseInheritanceCensus(model, contractsOf(model)).namedClausesMasked).toBe(1);
  }, 60_000);

  /**
   * The report must not contradict itself in one block. `contracts` now lists
   * an inherited guarantee on the row, and a finding four lines below saying
   * the same element "guarantees nothing" is the second half of a
   * contradiction printed on the default text path with no flag.
   */
  it('never says an element guarantees nothing on a row that shows an inherited guarantee', async () => {
    const model = await load(`package P {
    part def Sys { attribute mass; attribute power; }
    requirement def Base { subject s : Sys; require constraint { s.mass <= 25.0 } }
    requirement def Child :> Base { assume constraint { s.power > 0.0 } }
}`);
    const r = contractReport(model);
    const child = r.contracts.find((c) => c.qualifiedName === 'P::Child')!;
    expect(child.guarantees).toEqual([]);
    expect(child.inheritedClauses.map((c) => c.role)).toEqual(['require']);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('verification/contract-no-guarantee');
  }, 60_000);

  /** …and still says it where nothing, written or inherited, is guaranteed. */
  it('still says an element guarantees nothing when it inherits none either', async () => {
    const model = await load(`package P {
    part def Sys { attribute power; }
    requirement def Base { subject s : Sys; assume constraint { s.power > 0.0 } }
    requirement def Child :> Base { assume constraint { s.power < 99.0 } }
}`);
    const r = contractReport(model);
    expect(
      r.diagnostics
        .filter((d) => d.code === 'verification/contract-no-guarantee')
        .map((d) => d.elementName)
        .sort(),
    ).toEqual(['P::Base', 'P::Child']);
  }, 60_000);
});

/**
 * The keyword inventory, and the two ways a vocabulary this tool did not define
 * is allowed to touch a report.
 *
 * `contracts --keywords` is an INVENTORY: it says what the file carries and
 * what each keyword resolves to, and it changes nothing. `obligations
 * --from-keywords` is the one door through which a foreign spelling may file a
 * row, it is shut by default, and every row it opens prints the spelling that
 * opened it. The cases below are written against exactly those two claims,
 * because between them they are the whole of "cannot silently let a vocabulary
 * it did not define change a proof".
 */
describe('the keyword inventory', () => {
  /**
   * One file, five keywords, four fates: the shipped one (resolved through an
   * import), a third-party spelling of it, a third-party clause word, a
   * misspelling, and one that names a definition the model declares itself.
   */
  const VOCABULARY = `${SYSPROSE_VERIFICATION_LIBRARY}

package P {
  import SysproseVerification::*;
  metadata def <safety> SafetyTag;
  part def Sys { attribute m : Real = 3.0; }
  #exceptional state failsafe;
  #Exception state abort;
  #precondtion action launch;
  #safety part def Housing;
  requirement def R { subject u : Sys; require constraint { u.m < 9.0 } }
}`;

  it('is not taken at all unless it was asked for', async () => {
    const model = await load(VOCABULARY);
    const quiet = contractReport(model);
    expect(quiet.keywordsAsked).toBe(false);
    expect(quiet.keywords).toEqual([]);
    // And no keyword code is published on a report nobody asked a keyword
    // question of: `contracts` on its own says exactly what it said before
    // keywords existed.
    expect(quiet.diagnostics.map((d) => d.code)).not.toContain('verification/foreign-keyword');
    expect(quiet.diagnostics.map((d) => d.code)).not.toContain(
      'verification/keyword-names-nothing',
    );
  }, 60_000);

  it('classifies every use into exactly one origin, with what it resolves to', async () => {
    const model = await load(VOCABULARY);
    const r = contractReport(model, { keywords: true });
    expect(r.keywordsAsked).toBe(true);
    expect(r.keywords.map((k) => [k.keyword, k.origin])).toEqual([
      ['exceptional', 'sysprose'],
      ['Exception', 'foreign'],
      ['precondtion', 'unresolved'],
      ['safety', 'other'],
    ]);
    const [shipped, foreign, misspelt, own] = r.keywords;
    expect(shipped.resolvedTo?.qualifiedName).toBe('SysproseVerification::ExceptionalOutcome');
    expect(shipped.foreign).toBeNull();
    expect(misspelt.resolvedTo).toBeNull();
    // A model that declares its own vocabulary is reported as using its own,
    // not as using ours: the origin is read off the RESOLVED definition.
    expect(own.resolvedTo?.qualifiedName).toBe('P::SafetyTag');
    // The third-party spelling names nothing in this file, and the row still
    // says what this tool would make of it — which is the fact a reader needs,
    // and the one "names nothing" would have hidden.
    expect(foreign.resolvedTo).toBeNull();
    expect(foreign.foreign?.readAs).toContain('SysproseVerification::exceptional');
    expect(foreign.foreign?.note).toContain('not SysML v2, not a Sysprose keyword');
    // Every row names the element it was written on, so the inventory is
    // navigable rather than a list of spellings.
    expect(r.keywords.map((k) => k.element.qualifiedName)).toEqual([
      'P::failsafe',
      'P::abort',
      'P::launch',
      'P::Housing',
    ]);
  }, 60_000);

  /**
   * A foreign spelling that the model ALSO declares is two facts, not one.
   *
   * The alias table decides the origin, because the spelling is what a later
   * command acts on and a reader has to be told which spellings those are. The
   * resolution is kept beside it, because the definition is the reader's own
   * and a row that hid it would say their declaration had been ignored.
   */
  it('keeps both facts when a third-party spelling also names something', async () => {
    const model = await load(`package P {
  metadata def <Exception> MyException;
  #Exception state abort;
}`);
    const [row] = contractReport(model, { keywords: true }).keywords;
    expect(row.origin).toBe('foreign');
    expect(row.resolvedTo?.qualifiedName).toBe('P::MyException');
    expect(row.foreign?.readAs).toContain('SysproseVerification::exceptional');
  }, 60_000);

  it('publishes one info per foreign spelling and one per keyword that names nothing', async () => {
    const model = await load(VOCABULARY);
    const r = contractReport(model, { keywords: true });
    const keywordCodes = r.diagnostics.filter((d) => d.code?.startsWith('verification/'));
    expect(
      keywordCodes.filter((d) => d.code === 'verification/foreign-keyword').map((d) => d.message),
    ).toEqual([
      '`#Exception` on P::abort is a third-party spelling read as `SysproseVerification::exceptional` — not SysML v2, not a Sysprose keyword.',
    ]);
    expect(
      keywordCodes
        .filter((d) => d.code === 'verification/keyword-names-nothing')
        .map((d) => d.message),
    ).toEqual(['`#precondtion` on P::launch resolves to no metadata definition in scope.']);
    // Info, all of it: none of these is a defect in the model, and one of them
    // is a file written for another tool being read correctly.
    for (const d of keywordCodes) {
      expect(d.severity).toBe('info');
      expect(d.source).toBe('verification');
    }
    // One numbering for the whole lane, whichever half produced the row.
    expect(new Set(r.diagnostics.map((d) => d.id)).size).toBe(r.diagnostics.length);
  }, 60_000);

  /**
   * The promise that keeps the inventory free: a keyword is never a finding
   * about a file. The 24 validation rules, `check`'s exit contract and the 81
   * fixtures are untouched by anything in this commit, and the way to show it
   * is to run the checker over the file the inventory has the most to say
   * about.
   */
  it('says none of it through `npm run check`', async () => {
    const report = await checkText(VOCABULARY, { library: 'full' });
    expect(
      report.summary,
      report.diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`).join('\n'),
    ).toMatchObject({ errors: 0, warnings: 0 });
    expect(report.diagnostics.filter((d) => d.code?.startsWith('verification/'))).toEqual([]);
  }, 60_000);

  /**
   * The tool's OWN statement keywords, in a file written the way the guide
   * documents them.
   *
   * `#prose` / `#prompt` / `#'requirement'` are read from the SPELLING —
   * `statement-kind.ts` says so in its header and every rule in the tool honours
   * it — so a conformant file declares no `SysproseStatements` package and they
   * resolve to nothing. Classifying that as `unresolved` put
   * `verification/keyword-names-nothing` against `#prose` in the same report
   * whose census line said one statement had been left out BECAUSE of it, and
   * offered a hint naming the wrong package. A tag this tool acted on is not a
   * tag it failed to find.
   */
  it('calls its own statement keywords its own, spelling alone', async () => {
    const text = `package P {
  part def Sys { attribute m : Real = 3.0; }
  #prose requirement def R1 { subject u : Sys; doc /* narrative */ }
  #prompt part guidance;
  #'requirement' part def Q;
  requirement def R2 { subject u : Sys; require constraint { u.m < 9.0 } }
}`;
    const model = await load(text);
    const r = contractReport(model, { keywords: true });
    expect(r.keywords.map((k) => [k.keyword, k.origin])).toEqual([
      ['prose', 'sysprose'],
      ['prompt', 'sysprose'],
      ["'requirement'", 'sysprose'],
    ]);
    // Read from the spelling, and the row says so rather than pretending a
    // resolution it does not have.
    for (const use of r.keywords) {
      expect(use.resolvedTo).toBeNull();
      expect(use.readBySpelling).toEqual({ package: 'SysproseStatements' });
    }
    // The report acted on `#prose` — its own census line proves it — so it may
    // not also report the tag as naming nothing.
    expect(r.nonNormativeExcluded).toBe(1);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('verification/keyword-names-nothing');

    // Declaring AND importing the package binds them — a sibling package that
    // neither declares nor imports resolves nothing, which is the notation's
    // answer and not a limitation — and then the row says what they NAME.
    const bound = await load(
      `${STATEMENT_KIND_LIBRARY}\n\n${text.replace('package P {', 'package P {\n  import SysproseStatements::*;')}`,
    );
    const boundUses = contractReport(bound, { keywords: true }).keywords;
    expect(boundUses.map((k) => [k.origin, k.resolvedTo?.qualifiedName])).toEqual([
      ['sysprose', 'SysproseStatements::ProseStatement'],
      ['sysprose', 'SysproseStatements::PromptStatement'],
      ['sysprose', 'SysproseStatements::RequirementStatement'],
    ]);
    for (const use of boundUses) expect(use.readBySpelling).toBeNull();
  }, 60_000);

  it('is narrowed by `--element` like every other figure in the report', async () => {
    const model = await load(VOCABULARY);
    const housing = model.all().find((el) => el.declaredName === 'Housing')!;
    const scoped = contractReport(model, { scopeId: housing.id, keywords: true });
    expect(scoped.keywords.map((k) => k.keyword)).toEqual(['safety']);
  }, 60_000);
});

describe('a foreign clause keyword, and the door it has to come through', () => {
  /**
   * A file written for another tool: the two conditions are keywords on plain
   * constraints, which is how a tool that has no `assume` / `require` says it.
   */
  const FOREIGN = `package P {
  part def Sys { attribute m : Real = 3.0; attribute cap : Real = 9.0; }
  action def Move {
    #precondition constraint before { P::Sys::m > 0.0 }
    #postcondition constraint after { P::Sys::m < P::Sys::cap }
  }
}`;

  /** The same file with the keywords taken off — the pre-keyword worklist. */
  const PLAIN = FOREIGN.replaceAll('#precondition ', '').replaceAll('#postcondition ', '');

  /** A worklist with the ids stripped, since every load mints its own. */
  const shape = (rows: ReturnType<typeof obligationsOf>) =>
    rows.map((o) => ({
      role: o.role,
      source: o.source,
      expression: o.expression,
      status: o.status,
      encodable: o.encodable,
      element: o.element.qualifiedName,
      provenance: o.provenance ?? null,
    }));

  /**
   * The invariant the whole design hangs on: with the flag absent, a file
   * carrying somebody else's vocabulary produces bit-for-bit the worklist the
   * same file without it produces. The keyword is read, kept and listed; it
   * files nothing.
   */
  it('changes nothing at all unless `--from-keywords` was passed', async () => {
    const withKeywords = await load(FOREIGN, 'foreign.sysml');
    const without = await load(PLAIN, 'plain.sysml');
    expect(shape(obligationsOf(withKeywords))).toEqual(shape(obligationsOf(without)));
    // Both plain constraints, both obligations — which is what a plain
    // constraint is, keyword or no keyword.
    expect(obligationsOf(withKeywords).filter((o) => o.source === 'constraint')).toHaveLength(2);
    expect(obligationsOf(withKeywords).some((o) => o.provenance)).toBe(false);
  }, 60_000);

  it('files a premise and an obligation under the flag, each naming the keyword', async () => {
    const model = await load(FOREIGN, 'foreign.sysml');
    const rows = obligationsOf(model, { fromKeywords: true }).filter(
      (o) => o.source === 'keyword',
    );
    expect(rows.map((o) => [o.element.declaredName, o.role])).toEqual([
      ['before', 'premise'],
      ['after', 'obligation'],
    ]);
    // `source` is `keyword`, never `assume`: the author did not write `assume`,
    // and a row that said so would make the role map uncheckable.
    for (const row of rows) {
      expect(row.provenance?.keyword).toMatch(/^(pre|post)condition$/);
      expect(row.provenance?.note).toContain('third-party spelling');
    }
    const report = obligationsReport(model, { fromKeywords: true });
    expect(report.fromKeywords).toBe(true);
    expect(report.byRole.premise).toBe(1);
    // And the report says out loud which spelling moved which row.
    const named = report.diagnostics.filter((d) => d.code === 'verification/foreign-keyword');
    expect(named).toHaveLength(2);
    expect(named[0].message).toContain('#precondition');
    expect(named[0].message).toContain('filed this premise');
  }, 60_000);

  /**
   * A keyword may not overrule the notation. SysML v2 expresses a precondition
   * three ways, so a file that wrote one of them has already said what it
   * meant; a foreign keyword on top of it is at best a duplicate and at worst
   * another tool's opinion about somebody else's model.
   *
   * TWO HALVES, because the notation closes the door before the code does and
   * a case that stopped at the first half would be vacuous. Measured: a clause
   * has no prefix-metadata slot at all — `#precondition require constraint { … }`
   * is a `parse/mismatched-token`, exactly as `#prompt satisfy r by p;` is — so
   * no FILE can present this situation. A model built through the API can, and
   * the guard is what answers it there.
   */
  it('never overrules a written clause role, even under the flag', async () => {
    const notation = parseModel(`package P {
  part def Sys { attribute m : Real = 3.0; }
  requirement def R {
    subject u : Sys;
    #precondition require constraint { u.m < 9.0 }
  }
}`);
    expect(
      notation.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
      'a clause is expected to have no slot for a keyword — if it now has one, this case is stale',
    ).toContain('parse/mismatched-token');

    const model = await load(`package P {
  part def Sys { attribute m : Real = 3.0; }
  requirement def R {
    subject u : Sys;
    require constraint { u.m < 9.0 }
  }
}`);
    // The tag written the only way it can be: through the API, onto the clause.
    const clause = model
      .all()
      .find((el) => el.eClass === 'ConstraintUsage' && el.attrs.requirementRole === 'require')!;
    model.setAttrs(clause.id, { metadata: ['precondition'] });

    const rows = obligationsOf(model, { fromKeywords: true }).filter((o) => o.role !== 'axiom');
    expect(rows.map((o) => [o.role, o.source])).toEqual([['obligation', 'require']]);
    expect(rows[0].provenance).toBeUndefined();
  }, 60_000);

  /**
   * And it may never make an AXIOM. A premise is something a proof may lean on
   * while showing something else; an axiom is a fact put into the context
   * unconditionally. A keyword that could add one would be a foreign vocabulary
   * changing what every other obligation in the run is judged against.
   */
  it('can file a premise or an obligation, never an axiom', async () => {
    const model = await load(`package P {
  part def Sys { attribute m : Real = 3.0; }
  #precondition constraint c { P::Sys::m > 0.0 }
  #Exception constraint d { P::Sys::m < 9.0 }
}`);
    const rows = obligationsOf(model, { fromKeywords: true });
    // The length first, because `.every` over an empty array is true and a case
    // whose promise can only be kept vacuously is not a case at all.
    expect(rows.filter((o) => o.provenance)).toHaveLength(1);
    expect(rows.filter((o) => o.provenance).every((o) => o.role !== 'axiom')).toBe(true);
    // `#Exception` is a valence tag, not a clause role: it files nothing here
    // whatever the flag says.
    const exceptional = rows.find((o) => o.element.declaredName === 'd')!;
    expect(exceptional.source).toBe('constraint');
    expect(exceptional.provenance).toBeUndefined();
  }, 60_000);

  /**
   * And it may never take an axiom AWAY, which is the direction the first draft
   * of this guard missed and the worse of the two.
   *
   * A `CalculationUsage` with a bare body has no written clause role, so a
   * guard that tested only `requirementRole` let `#postcondition` REPLACE
   * `{axiom, calculation}`: the joining equality `total == a + b` vanished from
   * the proof context and the bare term `a + b` — a real-valued expression, not
   * a claim — was filed as something to show, `encodable: true`. Every
   * obligation mentioning `total` was then standing on a free variable, and the
   * only thing the report said out loud was that a row had been FILED.
   */
  it('leaves a calculation’s defining axiom exactly where it was', async () => {
    const model = await load(`package P {
  part def Sys {
    attribute a : Real;
    attribute b : Real;
    #postcondition calc total { a + b }
  }
}`);
    const before = obligationsOf(model);
    const after = obligationsOf(model, { fromKeywords: true });
    expect(before.map((o) => [o.role, o.source, o.expression])).toEqual([
      ['axiom', 'calculation', 'total == a + b'],
    ]);
    expect(after.map((o) => [o.role, o.source, o.expression])).toEqual(
      before.map((o) => [o.role, o.source, o.expression]),
    );
    // Nothing was filed, so nothing claims to have been.
    expect(after.some((o) => o.provenance)).toBe(false);
    const report = obligationsReport(model, { fromKeywords: true });
    expect(report.byRole).toEqual(obligationsReport(model).byRole);
    expect(report.filedByKeyword).toBe(0);
    expect(report.diagnostics.filter((d) => d.code === 'verification/foreign-keyword')).toEqual(
      [],
    );
  }, 60_000);

  /**
   * The count on the header is over the WHOLE worklist, like every other figure
   * beside it.
   *
   * `--missing` narrows the LISTING and nothing else — the report says so in
   * `obligationsReport` — so a keyword count taken off the narrowed listing
   * printed "0 row(s) filed by a keyword" three lines above the diagnostic
   * naming the keyword that filed one, in the same report whose own histogram
   * counted that premise.
   */
  it('counts the rows a keyword filed over the whole worklist, not the narrowed one', async () => {
    const model = await load(`package P {
  part def Sys {
    attribute m : Real = 3.0;
    #precondition constraint before { m > 0.0 }
  }
  requirement def R { subject u : Sys; doc /* no formal clause */ }
}`);
    const whole = obligationsReport(model, { fromKeywords: true });
    const narrowed = obligationsReport(model, { fromKeywords: true, missing: true });
    expect(whole.filedByKeyword).toBe(1);
    // The premise is encodable, so `--missing` drops it from the listing — and
    // the figure has to survive that, exactly as `total` and `byRole` do.
    expect(narrowed.obligations.some((o) => o.provenance)).toBe(false);
    expect(narrowed.filedByKeyword).toBe(whole.filedByKeyword);
    expect(narrowed.total).toBe(whole.total);
  }, 60_000);

  /**
   * A spelling this table knows, over a definition the MODEL declares.
   *
   * The inventory was already fixed to keep both facts; the worklist row said
   * only "a third-party spelling" and left the author's own
   * `metadata def <precondition>` unmentioned on every row it filed. The two
   * surfaces now say the same thing about the same keyword.
   */
  it('names the definition the model itself declared, on the row it filed', async () => {
    const model = await load(`package MyTool {
  metadata def <precondition> MyPrecondition;
}

package P {
  import MyTool::*;
  part def Sys {
    attribute m : Real = 3.0;
    #precondition constraint before { m > 0.0 }
  }
}`);
    const [row] = obligationsOf(model, { fromKeywords: true }).filter(
      (o) => o.source === 'keyword',
    );
    expect(row.role).toBe('premise');
    expect(row.provenance?.note).toContain('read as an `assume` clause');
    expect(row.provenance?.note).toContain('it names MyTool::MyPrecondition here');
    // And the inventory's line for the same keyword agrees, which is the point.
    const [use] = contractReport(model, { keywords: true }).keywords;
    expect(use.resolvedTo?.qualifiedName).toBe('MyTool::MyPrecondition');
  }, 60_000);
});

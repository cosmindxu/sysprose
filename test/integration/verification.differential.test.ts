/**
 * The differential gate and the relation census (plan §5).
 *
 * TWO MECHANISMS, AND THE SECOND EXISTS BECAUSE OF THE FIRST'S BLIND SPOT.
 *
 * **The differential gate.** With nothing freed, the SMT engine answers the
 * same question `checkConstraints` answers — "does this relation hold with
 * every feature at the value the model binds it to?" — so on every encodable
 * relation of the whole fixture corpus and both shipped examples the two must
 * give the same answer. `proved` ⇔ `satisfied`, `refuted` ⇔ `violated`, and the
 * third row the first draft of this plan left undefined: `unknown` ⇔
 * `inconclusive: not evaluable`. That row is asserted rather than assumed
 * because it is exactly where two engines are most likely to differ, and
 * exactly the case §1's warning is about — a constraint that silently
 * disappears reads as one that holds.
 *
 * The gate is DIRECTIONAL where it has to be. A verdict may never disagree:
 * `proved` implies the numeric surface said `satisfied` and `refuted` implies
 * it said `violated`, both ways round, with no exceptions at all. The reverse
 * direction admits the solver being MORE CONSERVATIVE than the point
 * evaluation, and only for reasons it has to NAME — the premises were
 * unsatisfiable, the axiom set contradicts itself, or its own witness failed
 * re-evaluation. Anything else is a disagreement and fails with both sentences
 * printed. That asymmetry is the ratchet of §5 expressed as a test: a golden
 * verdict may become more conservative without ceremony and may never become
 * less conservative.
 *
 * **What the gate does NOT prove**, stated here because it is the reason the
 * census exists. The gate compares TWO CONSUMERS OF ONE GATHERER. A relation
 * neither surface gathers — a construct `parseRelationBody` drops, a feature
 * chain that fails to resolve — is absent from both, both say "nothing to
 * report", and the gate is green. So the gate establishes that the two ENGINES
 * agree on the relations the shared gatherer produced. It establishes nothing
 * about a relation the gatherer dropped.
 *
 * **The relation census** is the counter-measure. Every constraint-bearing
 * element of the USER's model is counted independently of the worklist — a
 * plain walk of the element graph — and then accounted for: encoded, or refused
 * with a reason, or reported to `verify` under a `verification/*` code. The
 * counts must equal the census. A relation that leaves the pipeline without a
 * word said about it fails here, which is the one thing the differential gate
 * cannot see. The reconciliation is a pure function so its own teeth can be
 * tested: dropping one row from the worklist must be reported, not absorbed.
 *
 * MEASURED, so the §6 budget stays honest: the sweep loads 103 models (both
 * examples, all 82 campaign fixtures, the 19 L8 corpus models) and runs both
 * engines over each — ~18 s wall clock on this machine, of which the library
 * bind is the great majority.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ElementId, Model } from '@core/index';
import {
  ALLOW_INCONCLUSIVE_CODES,
  boundsReport,
  consistencyReport,
  isUserElement,
  refinementReport,
  verifyModel,
  type ObligationVerdict,
} from '@api/index';
import { checkConstraints, type ConstraintCheck } from '@semantics/evaluate-model';
import { obligationsOf, type Obligation } from '@semantics/obligations';
import { checkConstraintsNumeric } from '@semantics/solver';
import { loadZ3, z3Disabled } from '@semantics/smt/z3-bridge';
import { loadModelText } from '@text/load';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');

/**
 * Every model this repository ships as an input, in one list.
 *
 * The campaign corpus is here for its BREADTH rather than its content: most of
 * its 82 cases state no requirement at all, and the ones that do state a
 * malformed one. That is the point — the gate has to hold over the files a
 * person actually hands this tool, not only over the two that were written to
 * be verified.
 */
function corpusPaths(): string[] {
  const campaign = readdirSync(root('test/fixtures/agent-authoring'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `test/fixtures/agent-authoring/${e.name}/input.sysml`)
    .filter((p) => existsSync(root(p)));
  const verdictModels = readdirSync(root('test/fixtures/verification/models'))
    .filter((f) => f.endsWith('.sysml'))
    .map((f) => `test/fixtures/verification/models/${f}`);
  return ['examples/uav-isr.sysml', 'examples/vehicle.sysml', ...campaign.sort(), ...verdictModels.sort()];
}

/** One model, with everything three surfaces made of it. */
interface Loaded {
  path: string;
  model: Model;
  /** The numeric surface, by element id. */
  checks: Map<ElementId, ConstraintCheck>;
  /** The shared gatherer's worklist, by element id. */
  worklist: Map<ElementId, Obligation>;
  smt: ObligationVerdict[];
  literal: ObligationVerdict[];
}

/* ───────────────────────────── the relation census ───────────────────────── */

/**
 * Every constraint-bearing element of the user's model, counted WITHOUT asking
 * the worklist.
 *
 * The criterion is the one `checkConstraints` applies — a `ConstraintUsage` or
 * `RequirementUsage` carrying a non-empty boolean expression — restricted to
 * the user's own elements, because the bundled standard library carries tens of
 * thousands of its own and none of them is this model's obligation. It is
 * deliberately NOT computed from `obligationsOf`: a census taken from the thing
 * it audits could not see the thing it exists to catch.
 */
function elementCensus(model: Model): ElementId[] {
  return model
    .ofKind('ConstraintUsage', 'RequirementUsage')
    .filter((el) => isUserElement(model, el))
    .filter((el) => typeof el.attrs.expression === 'string' && el.attrs.expression.trim() !== '')
    .map((el) => el.id);
}

/** How one censused relation was accounted for. */
type Account = 'encoded' | 'refused' | 'missing';

/**
 * Reconcile a census against a worklist — a PURE function, so the gate's own
 * teeth can be tested by handing it a worklist with a row taken out.
 *
 * `missing` is the finding this whole mechanism exists for: a relation the
 * model states and the gatherer never filed. It is not "unsupported" and not
 * "refused" — nobody said anything about it at all, and every surface
 * downstream reports silence, which reads as agreement.
 */
export function reconcile(
  census: readonly ElementId[],
  worklist: ReadonlyMap<ElementId, Obligation>,
): Map<ElementId, Account> {
  const out = new Map<ElementId, Account>();
  for (const id of census) {
    const row = worklist.get(id);
    out.set(id, row === undefined ? 'missing' : row.encodable === true ? 'encoded' : 'refused');
  }
  return out;
}

/* ──────────────────────────────── the sweep ──────────────────────────────── */

const loaded: Loaded[] = [];
/** One row as three surfaces saw it. */
interface Compared {
  path: string;
  clause: string;
  expression: string;
  check: ConstraintCheck | undefined;
  smt: ObligationVerdict;
  literal: ObligationVerdict | undefined;
}
/** Every (row, both verdicts, numeric reading) triple the VERDICT rules compare. */
const compared: Compared[] = [];
/**
 * The same triples for EVERY censused row, refused ones included.
 *
 * The verdict rules above are about relations both engines could read, so they
 * take `compared`. The `--allow-inconclusive` scope rule is not: a flag scope
 * that differs between the engines is a defect precisely where neither engine
 * reached a verdict, and filtering to `encodable === true` made the one test
 * written to catch that split structurally unable to see it. MEASURED: `bus.seats
 * % 2 == 0` with `seats = 13` is refused by the gates, so it never entered
 * `compared`, and `--engine smt --allow-inconclusive` exited 0 over a violated
 * requirement while `--engine literal --allow-inconclusive` exited 1 — with this
 * whole file green.
 */
const everyRow: Compared[] = [];

/** The solver, or the reason it is absent — `z3-solver` is an OPTIONAL dependency. */
let backendPresent = false;
let absentReason = '';
/** Is the optional dependency actually on disk? */
const installed = existsSync(root('node_modules/z3-solver/package.json'));

/**
 * Skip a solver case where the optional dependency is not installed.
 *
 * The same pattern, for the same reason, as
 * `test/integration/smt-z3.integration.test.ts`: a clone that skipped optional
 * dependencies must still run every suite, so the rules that need a backend
 * degrade to a SKIP rather than to a failure — and the skip is itself guarded
 * in `beforeAll`, so it can never fire on a machine that has the package.
 */
const withZ3 = (name: string, fn: () => void | Promise<void>, timeout = 120_000) =>
  it(
    name,
    async (ctx) => {
      if (!backendPresent) {
        expect(absentReason.length, 'no backend and no reason either').toBeGreaterThan(20);
        ctx.skip();
        return;
      }
      await fn();
    },
    timeout,
  );

/** The reasons the SMT engine is allowed to be MORE conservative than a point evaluation. */
const CONSERVATIVE_CODES = new Set([
  // The premises cannot all hold: the point evaluation read the guarantee, the
  // solver read the antecedent as well.
  'verification/vacuous',
  // Every negation is unsat under a contradiction, so nothing was decided.
  'verification/inconsistent-axioms',
  // The witness re-evaluation gate declined — including the strict-boundary
  // tie of `d568a1f`, which is where the two surfaces genuinely differ.
  'verification/not-evaluable',
]);

beforeAll(async () => {
  const load = await loadZ3();
  if (load.absent) absentReason = load.reason;
  else backendPresent = true;
  // A skip that fired on a machine which HAS the solver would turn every rule
  // below into vacuous green the moment `loadZ3` broke.
  if (!backendPresent && installed && !z3Disabled()) {
    throw new Error(
      '`node_modules/z3-solver` is installed and SYSPROSE_NO_Z3 is unset, so `loadZ3()` must ' +
        `return a backend. It answered: ${absentReason}`,
    );
  }
  for (const path of corpusPaths()) {
    const text = read(path);
    const { model } = await loadModelText(text, { fileName: path });
    // A file that does not parse to a model has no relations to account for;
    // the count of those is asserted below so this cannot swallow the corpus.
    if (!model) continue;
    const entry: Loaded = {
      path,
      model,
      checks: new Map(checkConstraints(model).map((c) => [c.id, c])),
      worklist: new Map(obligationsOf(model).map((r) => [r.element.id, r])),
      smt: (await verifyModel(model, { engine: 'smt', sourceText: text })).results,
      literal: (await verifyModel(model, { engine: 'literal', sourceText: text })).results,
    };
    loaded.push(entry);
    const literalBy = new Map(entry.literal.map((r) => [r.clause.id, r]));
    for (const row of entry.smt) {
      const triple: Compared = {
        path,
        clause: row.clause.qualifiedName,
        expression: row.expression,
        check: entry.checks.get(row.clause.id),
        smt: row,
        literal: literalBy.get(row.clause.id),
      };
      everyRow.push(triple);
      // The VERDICT rules take only the relations the gates PASSED. A refused
      // one is compared by the census instead: there the question is whether it
      // was accounted for, not whether two engines agree about a verdict
      // neither of them reached. The flag-scope rule takes `everyRow`.
      const w = entry.worklist.get(row.clause.id);
      if (w?.encodable !== true) continue;
      compared.push(triple);
    }
  }
}, 600_000);

/** The sentence a disagreement prints: both engines and the numeric surface. */
function bothMessages(c: (typeof compared)[number]): string {
  return (
    `\n  ${c.path} — ${c.clause}\n    ${c.expression}\n` +
    `    numeric surface: ${c.check?.result ?? 'not gathered'}${c.check?.message ? ` (${c.check.message})` : ''}\n` +
    `    smt:     ${c.smt.claim}${c.smt.code ? ` [${c.smt.code}]` : ''} — ${c.smt.detail}\n` +
    `    literal: ${c.literal?.claim ?? 'absent'}${c.literal?.code ? ` [${c.literal.code}]` : ''} — ${c.literal?.detail ?? ''}`
  );
}

describe('the differential gate — the two engines agree on the relations the gatherer produced', () => {
  it('sweeps the whole corpus, and the sweep is not empty', () => {
    // Every rule below is an implication over rows, and an implication with no
    // instance holds trivially: a corpus that silently emptied — a load that
    // started failing, a glob that stopped matching — would leave this file
    // green while proving nothing.
    expect(loaded.length, 'the corpus collapsed').toBeGreaterThan(90);
    expect(compared.length, 'no encodable relation was compared at all').toBeGreaterThan(10);
    expect(
      loaded.filter((l) => l.path.startsWith('examples/')).length,
      'the shipped examples left the sweep',
    ).toBe(2);
  });

  withZ3('`proved` ⇔ `satisfied`: a proof never disagrees with the point evaluation', () => {
    for (const c of compared) {
      if (c.smt.claim === 'proved') {
        expect(c.check?.result, `proved a relation the values do not satisfy:${bothMessages(c)}`).toBe(
          'satisfied',
        );
        expect(c.literal?.claim, `the literal engine disagrees:${bothMessages(c)}`).toBe(
          'holds-at-values',
        );
      }
      // …and the other way, allowing only a NAMED conservatism.
      if (c.check?.result === 'satisfied' && c.smt.claim !== 'proved') {
        expect(
          c.smt.code !== null && CONSERVATIVE_CODES.has(c.smt.code),
          `the solver declined a satisfied relation without naming why:${bothMessages(c)}`,
        ).toBe(true);
      }
    }
  });

  withZ3('`refuted` ⇔ `violated`: a refutation never disagrees with the point evaluation', () => {
    for (const c of compared) {
      if (c.smt.claim === 'refuted') {
        expect(c.check?.result, `refuted a relation the values satisfy:${bothMessages(c)}`).toBe(
          'violated',
        );
        expect(c.literal?.claim, `the literal engine disagrees:${bothMessages(c)}`).toBe('refuted');
        // The witness gate is what makes this true rather than hoped for.
        expect(c.smt.detail, `a refutation that was not re-evaluated:${bothMessages(c)}`).toContain(
          'confirmed by re-evaluation on the numeric surface',
        );
      }
      if (c.check?.result === 'violated' && c.smt.claim !== 'refuted') {
        expect(
          c.smt.code !== null && CONSERVATIVE_CODES.has(c.smt.code),
          `the solver declined a violated relation without naming why:${bothMessages(c)}`,
        ).toBe(true);
      }
    }
  });

  withZ3('`unknown` ⇔ `inconclusive: not evaluable` — the third row, on both engines', () => {
    // The row the first draft left undefined. A relation the values cannot
    // decide is neither a pass nor a fail on EITHER engine, it carries the code
    // nothing forgives, and it exits 2.
    for (const c of compared) {
      if (c.check?.result !== 'unknown') continue;
      expect(c.smt.claim, `a verdict over a relation the values cannot decide:${bothMessages(c)}`).toBe(
        'inconclusive',
      );
      expect(c.smt.code, `${bothMessages(c)}`).toBe('verification/not-evaluable');
      expect(c.literal?.claim, `${bothMessages(c)}`).toBe('inconclusive');
      expect(c.literal?.code, `the two engines put one relation in two flag scopes:${bothMessages(c)}`).toBe(
        'verification/not-evaluable',
      );
    }
    // And in the other direction: `not-evaluable` from the SMT engine over a
    // relation the values DID decide is the witness gate declining, never a
    // verdict quietly withdrawn.
    for (const c of compared) {
      if (c.smt.code !== 'verification/not-evaluable') continue;
      if (c.check?.result === 'unknown') continue;
      expect(c.smt.detail, `a decided relation reported unreadable:${bothMessages(c)}`).toMatch(
        /witness not confirmed|cannot be read|PARTIAL context/,
      );
    }
  });

  withZ3('puts one relation in one `--allow-inconclusive` scope, whichever engine ran', () => {
    // Two engines with two copies of the forgivable set would be two scopes for
    // one flag: the same file exiting 0 under `--engine smt` and 2 under
    // `--engine literal`. Measured — `constraint c { a + + 2 }` did exactly
    // that until the SMT engine stopped calling an unreadable body a construct
    // outside the fragment.
    //
    // Asserted over the flag's SCOPE (`ALLOW_INCONCLUSIVE_CODES`) rather than
    // over `forgiven`, and that is not a detail: this sweep runs WITHOUT
    // `--allow-inconclusive`, so every row's `forgiven` is false and a
    // comparison of those two falses would hold whatever the codes said.
    //
    // Over `everyRow` rather than `compared`, and that is not a detail either:
    // the split this rule exists to catch was on a relation the GATES refused,
    // which `compared` filters out — so the test written to prevent it could
    // not see it, and the whole file stayed green while `--engine smt
    // --allow-inconclusive` exited 0 over a violated requirement.
    // The scope is a partition of the UNDECIDED codes, so the comparison is
    // made where both engines left the row undecided. A row one engine DECIDED
    // carries no undecided code for a flag to lower — `holds-at-values` on a
    // gate-refused relation the values satisfy is a claim, not an omission —
    // and asserting scope equality there would be comparing two different
    // questions. The violation half is the rule below, which needs no such
    // guard because a violation is never forgivable on either engine.
    let undecidedRefused = 0;
    for (const c of everyRow) {
      if (c.literal === undefined) continue;
      if (c.smt.claim !== 'inconclusive' || c.literal.claim !== 'inconclusive') continue;
      const lowerable = (v: ObligationVerdict) =>
        v.code !== null && ALLOW_INCONCLUSIVE_CODES.has(v.code);
      expect(lowerable(c.smt), `the flag reaches one engine's row and not the other's:${bothMessages(c)}`).toBe(
        lowerable(c.literal),
      );
      const w = loaded.find((l) => l.path === c.path)?.worklist.get(c.smt.clause.id);
      if (w !== undefined && w.encodable !== true) undecidedRefused += 1;
    }
    // The positive controls. `everyRow` is strictly bigger than `compared`, and
    // the extra rows — the ones the gates refused — really do reach this rule:
    // filtering them out is what let the split live under a green file.
    expect(everyRow.length, 'the widened sweep sees no more rows than the narrow one').toBeGreaterThan(
      compared.length,
    );
    expect(
      undecidedRefused,
      'no gate-refused row reaches this rule — it is filtering out exactly what it was widened for',
    ).toBeGreaterThan(0);
  });

  withZ3('never forgives a violation the numeric surface reads, whichever engine ran', () => {
    // §2, stated over the corpus: `--allow-inconclusive` lowers exit 2 to 0 for
    // the two undecided codes and NEVER over a violation. A gate-refused
    // relation the values read `violated` is a violation whoever reads it — the
    // literal engine has always said so — and the SMT engine calling it
    // `unsupported-construct` put it inside the flag's scope.
    for (const c of everyRow) {
      if (c.check?.result !== 'violated') continue;
      for (const v of [c.smt, c.literal]) {
        if (v === undefined) continue;
        expect(
          v.code !== null && ALLOW_INCONCLUSIVE_CODES.has(v.code),
          `a flag scoped to undecided rows reaches a violated relation:${bothMessages(c)}`,
        ).toBe(false);
      }
    }
    expect(
      everyRow.filter((c) => c.check?.result === 'violated').length,
      'no violated relation in the whole corpus — this rule holds vacuously',
    ).toBeGreaterThan(0);
  });

  withZ3('exercises all three rows, so none of the rules above holds vacuously', () => {
    const claims = new Set(compared.map((c) => c.smt.claim));
    const readings = new Set(compared.map((c) => c.check?.result));
    expect([...readings].sort(), 'the corpus stopped exercising a numeric-surface row').toEqual([
      'satisfied',
      'unknown',
      'violated',
    ]);
    expect(claims.has('proved'), 'no proof in the whole corpus').toBe(true);
    expect(claims.has('refuted'), 'no refutation in the whole corpus').toBe(true);
    expect(claims.has('inconclusive'), 'no undecided row in the whole corpus').toBe(true);
    expect(
      compared.some((c) => c.smt.claim === 'vacuous'),
      'no vacuity in the whole corpus — the conservatism clause holds vacuously',
    ).toBe(true);
  });

  withZ3('declines rather than refutes at an exact strict boundary (`d568a1f`)', async () => {
    // The one place the two surfaces genuinely read a relation differently. The
    // unit-aware evaluator counts a tie as EQUAL for every operator, the strict
    // ones included, so `mass < 18.5 [kg]` at 18.5 kg is `satisfied` there; the
    // encoder reasons over exact rationals, so the negation is satisfiable and
    // z3 answers sat. The witness re-evaluation gate is what stops that
    // becoming a refutation of a requirement the numeric surface passes: the
    // row is `inconclusive`, exit 2, with both readings in the sentence.
    const text = [
      'package StrictBoundary {',
      '    part def Chassis {',
      '        attribute mass : ISQ::MassValue = 18.5 [kg];',
      '    }',
      '    part chassis : Chassis;',
      '    requirement def StrictUnder {',
      '        subject chassis : Chassis;',
      '        require constraint { chassis.mass < 18.5 [kg] }',
      '    }',
      '    requirement def LooseUnder {',
      '        subject chassis : Chassis;',
      '        require constraint { chassis.mass <= 18.5 [kg] }',
      '    }',
      '}',
      '',
    ].join('\n');
    const { model } = await loadModelText(text, { fileName: 'strict.sysml' });
    const report = await verifyModel(model!, { engine: 'smt', sourceText: text });
    const by = new Map(report.results.map((r) => [r.requirement?.qualifiedName ?? '', r]));

    const strict = by.get('StrictBoundary::StrictUnder');
    expect(strict, 'the strict requirement left the model').toBeDefined();
    expect(strict!.claim, 'a tie under a strict ordering was printed as a violation').toBe(
      'inconclusive',
    );
    expect(strict!.code).toBe('verification/not-evaluable');
    expect(strict!.detail).toContain('witness not confirmed');
    expect(strict!.detail, 'the other surface’s reading is not in the sentence').toContain(
      'the numeric surface reads this relation as `satisfied`',
    );
    expect(strict!.forgiven, 'a cross-surface disagreement was forgiven').toBe(false);

    // The non-strict sibling is the control: at the same boundary, on the same
    // value, both surfaces agree and the proof is available.
    expect(by.get('StrictBoundary::LooseUnder')!.claim).toBe('proved');
    expect(report.exitCode, 'a run carrying an undecided row went green').toBe(2);
  });
});

/* ─────────────── derived values, read alike by all four surfaces ─────────────── */

/**
 * A bare literal against a kinded feature, against a value derived from
 * dimensioned quantities, and against a unit literal — read by
 * `checkConstraints`, the numeric surface, the literal engine and the SMT
 * engine, which must give each relation one verdict or one refusal, in one
 * sentence.
 *
 * The sweep above cannot see this: its corpus states no such relation, and it
 * leaves the numeric surface out. Every split below was real. `limit != 25.0`
 * on a kinded `limit = 25.0` had no residual on the numeric surface, so it was
 * `unknown` there and `violated` everywhere else. A derived `e` (640 Wh / 650
 * W, so 3544.6 s) against a bare `45.0` was refused by the validation surface
 * while the solver lane compared the raw magnitude — 3544.6 in the value form
 * (kinded or not), 0.98 (hours) when an asserted equation fixed `e` — and the
 * SMT engine proved `e >= 45.0` or `e <= 60.0` accordingly. A check written
 * above a definition fixed the defined feature on the solver lane; a feature
 * chain to a defined value was judged there and had no value on the
 * validation surface; `m = e + 5.0` was 5.98 on one surface and 3549.6 on the
 * other; a `Real` derived from a duration was refused by three surfaces and
 * proved by the fourth; and 500 g was not 0.5 kg to the SMT engine.
 */
describe('derived values — one verdict, or one refusal, on all four surfaces', () => {
  const INPUTS = `attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
    attribute power : ISQ::PowerValue = 650.0 [W];`;
  /** The same eight relations over `e`, whichever way `e` is derived. */
  const OVER_E = `
    constraint eq { e == 45.0 }
    constraint ne { e != 45.0 }
    constraint ge { e >= 45.0 }
    constraint le { e <= 60.0 }
    constraint geMin { e >= 45.0 [min] }
    constraint leHour { e <= 60.0 [min] }
    constraint neMin { e != 45.0 [min] }
    constraint eqH { e == 1.0 [h] }`;
  const CASES: Record<string, string> = {
    kinded: `package K {
    attribute limit : ISQ::MassValue = 25.0;
    constraint eq { limit == 25.0 }
    constraint ne { limit != 25.0 }
    constraint ge { limit >= 25.0 }
    constraint eqOther { limit == 26.0 }
    constraint neOther { limit != 26.0 }
    constraint eqNear { limit == 25.0000001 }
    constraint neNear { limit != 25.0000001 }
    constraint notEq { not (limit == 25.0) }
    constraint neOr { limit != 25.0 or limit >= 20.0 }
  }`,
    kindedDimensionless: `package KD {
    attribute half = 12.5;
    attribute k : ISQ::MassValue = half * 2.0;
    constraint eq { k == 25.0 }
    constraint ne { k != 25.0 }
    constraint ge { k >= 25.0 }
    constraint eqOther { k == 26.0 }
  }`,
    value: `package V { ${INPUTS}
    attribute e = capacity / power; ${OVER_E}
  }`,
    equation: `package E { ${INPUTS}
    attribute e;
    assert constraint fixE { e == capacity / power } ${OVER_E}
  }`,
    kindedValue: `package KV { ${INPUTS}
    attribute e : ISQ::DurationValue = capacity / power; ${OVER_E}
  }`,
    kindedEquation: `package KE { ${INPUTS}
    attribute e : ISQ::DurationValue;
    assert constraint fixE { e == capacity / power } ${OVER_E}
  }`,
    valueChain: `package VC { ${INPUTS}
    attribute c2 = capacity * 2.0;
    attribute e = c2 / power; ${OVER_E}
  }`,
    equationChain: `package EC { ${INPUTS}
    attribute c2;
    attribute e;
    assert constraint fixC2 { c2 == capacity * 2.0 }
    assert constraint fixE { e == c2 / power } ${OVER_E}
  }`,
    checkAboveDefinition: `package T { ${INPUTS}
    attribute e;
    constraint eqH { e == 1.0 [h] }
    assert constraint fixE { e == capacity / power }
    constraint geMin { e >= 45.0 [min] }
    constraint leS { e <= 3000.0 [s] }
  }`,
    mixedChain: `package J { ${INPUTS}
    attribute c2;
    attribute c3 = c2 / 4.0;
    attribute e;
    assert constraint fixC2 { c2 == capacity * 2.0 }
    assert constraint fixE { e == c3 / power }
    constraint geMin { e >= 45.0 [min] }
    constraint leS { e <= 3000.0 [s] }
    constraint eqH { e == 1.0 [h] }
  }`,
    featureChain: `package S {
    part def P { ${INPUTS}
      attribute e;
      assert constraint fixE { e == capacity / power }
    }
    part p : P { attribute :>> capacity = 1300.0 [Wh]; }
    constraint geMin { p.e >= 45.0 [min] }
    constraint eqH { p.e == 1.0 [h] }
    constraint ge { p.e >= 45.0 }
  }`,
    // The same chain through a usage that changes nothing the definition reads.
    featureChainRead: `package SR {
    part def P { ${INPUTS}
      attribute e;
      assert constraint fixE { e == capacity / power }
    }
    part p : P;
    constraint geMin { p.e >= 45.0 [min] }
    constraint eqH { p.e == 1.0 [h] }
    constraint ge { p.e >= 45.0 }
  }`,
    chainNotRead: `package OC {
    part def B { attribute k = 3.0; attribute e; assert constraint d { e == 2.0 * k } }
    part p : B { attribute :>> k = 5.0; }
    attribute flag = 1.0;
    constraint orChain { flag > 0.0 or p.e <= 1.0 }
    constraint andChain { flag < 0.0 and p.e <= 1.0 }
    constraint onChain { p.e <= 1.0 }
  }`,
    chainRead: `package OR {
    part def B { attribute k = 3.0; attribute e; assert constraint d { e == 2.0 * k } }
    part p : B;
    attribute flag = 1.0;
    constraint orChain { flag > 0.0 or p.e <= 1.0 }
    constraint andChain { flag < 0.0 and p.e <= 1.0 }
    constraint onChain { p.e <= 1.0 }
  }`,
    inheritedDefinition: `package B4 {
    part def P { ${INPUTS} attribute e; assert constraint d { e == capacity / power } }
    part def S :> P {
      attribute :>> capacity = 320.0 [Wh];
      constraint u { e <= 30.0 [min] }
      constraint b { e <= 30.0 }
    }
  }`,
    // The same definition where the specialisation changes nothing it reads:
    // P's e, 59.1 min.
    inheritedDefinitionRead: `package B5 {
    part def P { ${INPUTS} attribute e; assert constraint d { e == capacity / power } }
    part def S :> P {
      constraint u { e <= 30.0 [min] }
      constraint b { e <= 30.0 }
    }
  }`,
    bound: `package B2 { ${INPUTS}
    attribute e = capacity / power;
    attribute x;
    bind x = e;
    constraint ge { x >= 45.0 }
    constraint ne { x != 45.0 }
    constraint geMin { x >= 45.0 [min] }
    constraint leMin { x <= 50.0 [min] }
  }`,
    calculation: `package K1 { ${INPUTS}
    calc e { capacity / power } ${OVER_E}
  }`,
    calculationWithUnit: `package K3 {
    attribute power : ISQ::PowerValue = 650.0 [W];
    calc e { 640.0 [Wh] / power } ${OVER_E}
  }`,
    valueOverCalculation: `package K4 { ${INPUTS}
    calc endurance { capacity / power }
    attribute e = endurance; ${OVER_E}
  }`,
    unitInEquation: `package Y4 {
    attribute power : ISQ::PowerValue = 650.0 [W];
    attribute e;
    assert constraint fixE { e == 640.0 [Wh] / power } ${OVER_E}
  }`,
    unitInKindedEquation: `package Y5 {
    attribute power : ISQ::PowerValue = 650.0 [W];
    attribute e : ISQ::DurationValue;
    assert constraint fixE { e == 640.0 [Wh] / power } ${OVER_E}
  }`,
    connectives: `package Y1 { ${INPUTS}
    attribute e = capacity / power;
    constraint implT { e >= 45.0 [min] implies e <= 60.0 [min] }
    constraint implF { e >= 45.0 [min] implies e <= 50.0 [min] }
    constraint xorT { e >= 45.0 [min] xor e <= 50.0 [min] }
    constraint ifT { (if e >= 45.0 [min] then 1.0 else 0.0) == 1.0 }
    constraint ifF { (if e >= 60.0 [min] then 1.0 else 0.0) == 1.0 }
    constraint xorBare { e >= 45.0 [min] xor e <= 60.0 }
  }`,
    valueWithBare: `package M { ${INPUTS}
    attribute e = capacity / power;
    attribute m = e + 5.0;
    constraint le { m <= 10.0 }
    constraint ne { m != 5.98 }
    constraint geS { m >= 50.0 [s] }
  }`,
    realTyped: `package R { ${INPUTS}
    attribute e : ScalarValues::Real = capacity / power;
    constraint le { e <= 60.0 }
    constraint ne { e != 45.0 }
    constraint ge { e >= 45.0 }
  }`,
    realTypedEquation: `package RE { ${INPUTS}
    attribute e : ScalarValues::Real;
    assert constraint fixE { e == capacity / power }
    constraint le { e <= 60.0 }
    constraint ne { e != 45.0 }
  }`,
    shortCircuit: `package O { ${INPUTS}
    attribute e = capacity / power;
    constraint orBare { e >= 45.0 [min] or e <= 60.0 }
    constraint andBare { e <= 45.0 [min] and e <= 60.0 }
  }`,
    grams: `package G {
    attribute m1 : ISQ::MassValue = 500.0 [g];
    attribute m2 : ISQ::MassValue = 1.5 [kg];
    attribute s : ISQ::MassValue = m1 + m2;
    constraint eqKg { m1 == 0.5 [kg] }
    constraint neKg { m1 != 0.5 [kg] }
    constraint leG { m1 <= 500.0 [g] }
    constraint eqG { s == 2000.0 [g] }
    constraint neG { s != 2000.0 [g] }
  }`,
    notContract: `package CK {
    attribute limit : ISQ::MassValue [g] = 500.0;
    constraint n { not (limit == 500.0) }
    constraint n2 { not (limit == 0.5) }
    constraint a { limit > 400.0 and limit < 600.0 }
  }`,
    gram: `package G1 {
    attribute m : ISQ::MassValue = 1.0 [g];
    constraint eq { m == 1.0 [g] }
    constraint ne { m != 1.0 [g] }
    constraint ge { m >= 1.0 [g] }
    constraint eqKg { m == 0.001 [kg] }
    constraint neMg { m != 1000.0 [mg] }
  }`,
    otherUnits: `package F3 {
    attribute L : ISQ::LengthValue = 3.0 [ft];
    attribute v : ISQ::SpeedValue = 36.0 [km/h];
    constraint eqM { L == 0.9144 [m] }
    constraint neM { L != 0.9144 [m] }
    constraint eqMm { L == 914.4 [mm] }
    constraint eqMs { v == 10.0 [m/s] }
    constraint neMs { v != 10.0 [m/s] }
  }`,
    derivedGram: `package Z5 {
    attribute m1 : ISQ::MassValue = 0.1 [g];
    attribute m2 : ISQ::MassValue = 0.2 [g];
    attribute s = m1 + m2;
    constraint eq { s == 0.3 [g] }
    constraint ne { s != 0.3 [g] }
    constraint neKg { s != 0.0003 [kg] }
    constraint le { s <= 0.3 [g] }
  }`,
    derivedMinutes: `package Z9 {
    attribute t1 : ISQ::DurationValue = 7.0 [min];
    attribute t2 : ISQ::DurationValue = 0.1 [h];
    attribute s = t1 + t2;
    constraint eq { s == 13.0 [min] }
    constraint ne { s != 13.0 [min] }
    constraint eqS { s == 780.0 [s] }
    constraint neS { s != 780.0 [s] }
  }`,
    celsius: `package T {
    attribute t : ISQ::TemperatureValue = 20.0 [°C];
    constraint eq { t == 20.0 }
    constraint ne { t != 20.0 }
    constraint ge { t >= 20.0 }
  }`,
    celsiusIdentity: `package N {
    attribute t1 : ISQ::TemperatureValue = 20.0 [°C];
    attribute t2 = t1;
    constraint eq { t2 == 20.0 }
    constraint ne { t2 != 20.0 }
    constraint ge { t2 >= 20.0 }
    constraint geK { t2 >= 290.0 [K] }
  }`,
    celsiusEquation: `package Z13 {
    attribute t1 : ISQ::TemperatureValue = 20.0 [°C];
    attribute t2;
    assert constraint d { t2 == t1 }
    constraint eq { t2 == 20.0 }
    constraint ne { t2 != 20.0 }
    constraint geK { t2 >= 290.0 [K] }
  }`,
  };
  /**
   * A refusal: the reason both engines name, and the sentence every surface
   * gives. `forgivable` refusals are a limit of the tool or a shape outside
   * the fragment (`verification/unsupported-construct`); the rest are a
   * defect in the relation (`verification/not-evaluable`).
   */
  type Refused = { refused: string; sentence: RegExp; forgivable?: boolean };
  type Expected = 'satisfied' | 'violated' | 'offset' | Refused;
  const untyped: Refused = {
    refused: 'derived-bare-literal',
    sentence:
      /^"e" is derived from dimensioned quantities \(T\) and cannot be compared as a bare number; if it is meant as a pure ratio/,
  };
  const typed: Refused = {
    refused: 'derived-bare-literal',
    sentence:
      /^"e" is derived from dimensioned quantities \(T\) and cannot be compared as a bare number; compare against a unit literal of dimension T/,
  };
  const mismatch: Refused = {
    refused: 'refused-derivation',
    sentence: /^"e" derives to a dimension that disagrees with its declared type/,
  };
  /** 3544.6 s is 59.1 min; the chains double it, to 118.2 min. */
  const overE = (bare: Refused): Record<string, Expected> => ({
    eq: bare,
    ne: bare,
    ge: bare,
    le: bare,
    geMin: 'satisfied',
    leHour: 'satisfied',
    neMin: 'satisfied',
    eqH: 'violated',
  });
  const doubled = (bare: Refused): Record<string, Expected> => ({ ...overE(bare), leHour: 'violated' });
  // A chain to — or an inherited — value only an asserted equation defines:
  // undecided wherever the verdict turns on it. NOT forgivable: the value
  // exists in the model, and a requirement it violates must not exit 0 under
  // `--allow-inconclusive`.
  const chain: Refused = {
    refused: 'unread-definition',
    sentence: /^p\.e has no value: P::e is declared without one, its asserted equation is not read through a feature chain/,
  };
  const inherited: Refused = {
    refused: 'unread-definition',
    sentence: /^e has no value here: P::e is declared without one, its asserted equation in P is not read in S/,
  };
  const named = (name: string, of: Refused): Refused => ({
    ...of,
    sentence: new RegExp(of.sentence.source.replace('^"e"', `^"${name}"`)),
  });
  /** A point on an offset scale in arithmetic, in the unit-aware evaluator's sentence. */
  const offsetPoint = (unit: string): Refused => ({
    refused: 'offset-arithmetic',
    sentence: new RegExp(`^"${unit}" is on an offset temperature scale`),
    forgivable: true,
  });
  const inside: Refused = {
    refused: 'derived-bare-literal',
    sentence: /^"m" cannot be derived: "e" is derived from dimensioned quantities \(T\)/,
  };
  const EXPECTED: Record<string, Record<string, Expected>> = {
    kinded: {
      eq: 'satisfied',
      ne: 'violated',
      ge: 'satisfied',
      eqOther: 'violated',
      neOther: 'satisfied',
      eqNear: 'violated',
      neNear: 'satisfied',
      notEq: 'violated',
      neOr: 'satisfied',
    },
    kindedDimensionless: { eq: 'satisfied', ne: 'violated', ge: 'satisfied', eqOther: 'violated' },
    value: overE(untyped),
    equation: overE(untyped),
    kindedValue: overE(typed),
    kindedEquation: overE(typed),
    valueChain: doubled(untyped),
    equationChain: doubled(untyped),
    // 3544.6 s, whatever check is written above its definition.
    checkAboveDefinition: { eqH: 'violated', geMin: 'satisfied', leS: 'violated' },
    // 1280 Wh / 4 / 650 W = 1772.3 s, 29.5 min.
    mixedChain: { geMin: 'violated', leS: 'satisfied', eqH: 'violated' },
    featureChain: { geMin: chain, eqH: chain, ge: chain },
    featureChainRead: { geMin: 'satisfied', eqH: 'violated', ge: named('p.e', untyped) },
    valueWithBare: { le: inside, ne: inside, geS: inside },
    realTyped: { le: mismatch, ne: mismatch, ge: mismatch },
    realTypedEquation: { le: mismatch, ne: mismatch },
    shortCircuit: { orBare: untyped, andBare: untyped },
    grams: { eqKg: 'satisfied', neKg: 'violated', leG: 'satisfied', eqG: 'satisfied', neG: 'violated' },
    // Decided without the chain where an `or` / `and` is; undecided where not.
    chainNotRead: {
      orChain: 'satisfied',
      andChain: 'violated',
      onChain: { ...chain, sentence: /^p\.e has no value: B::e is declared without one/ },
    },
    chainRead: { orChain: 'satisfied', andChain: 'violated', onChain: 'violated' },
    // `S` redefines `capacity`; P's equation over P's inputs is not `e` here.
    inheritedDefinition: { u: inherited, b: inherited },
    inheritedDefinitionRead: { u: 'violated', b: named('e', untyped) },
    // `x` is bound to the duration `e`: refused against a bare number as `e`
    // is, and judged against a unit literal.
    bound: { ge: named('x', untyped), ne: named('x', untyped), geMin: 'satisfied', leMin: 'violated' },
    // A calculation's value body is a derivation like any value.
    calculation: overE(untyped),
    calculationWithUnit: overE(untyped),
    valueOverCalculation: overE(untyped),
    // A defining equation with a `[unit]` literal is a definition everywhere.
    unitInEquation: overE(untyped),
    unitInKindedEquation: overE(typed),
    // `implies`, `xor` and `if` are read by the unit-aware evaluator too.
    connectives: { implT: 'satisfied', implF: 'violated', xorT: 'satisfied', ifT: 'satisfied', ifF: 'violated', xorBare: untyped },
    // The declared-unit contract inside a `not` is the contract: 500 is read in
    // grams, where the SMT engine scaled it to 0.5 kg and proved `n`.
    notContract: { n: 'violated', n2: 'satisfied', a: 'satisfied' },
    // Exact where the author's decimals are: 1 g is 1/1000 kg, 3 ft is 0.9144 m, 36 km/h is 10 m/s.
    gram: { eq: 'satisfied', ne: 'violated', ge: 'satisfied', eqKg: 'satisfied', neMg: 'violated' },
    otherUnits: { eqM: 'satisfied', neM: 'violated', eqMm: 'satisfied', eqMs: 'satisfied', neMs: 'violated' },
    // 0.1 g + 0.2 g is 0.3 g; 7 min + 0.1 h is 13 min, 780 s.
    derivedGram: { eq: 'satisfied', ne: 'violated', neKg: 'violated', le: 'satisfied' },
    derivedMinutes: { eq: 'satisfied', ne: 'violated', eqS: 'satisfied', neS: 'violated' },
    celsius: { eq: 'offset', ne: 'offset', ge: 'satisfied' },
    // `t2 = t1` is the point 20 °C: an equality on it is offset arithmetic,
    // asked before gate (e), in one sentence; an ordering in kelvin is judged.
    celsiusIdentity: {
      eq: offsetPoint('°C'),
      ne: offsetPoint('°C'),
      ge: { ...named('t2', untyped), sentence: /^"t2" is derived from dimensioned quantities \(Θ\)/ },
      geK: 'satisfied',
    },
    // `assert t2 == t1` is an equality on that scale: no definition, refused
    // as offset arithmetic wherever `t2` is read.
    celsiusEquation: { eq: offsetPoint('t2'), ne: offsetPoint('t2'), geK: offsetPoint('t2') },
  };

  /** Every surface's reading of each named constraint of one model. */
  async function fourSurfaces(name: string) {
    const text = CASES[name]!;
    const { model } = await loadModelText(text, { fileName: `${name}.sysml` });
    const m = model!;
    const named = (id: string) => m.get(id)?.declaredName ?? '';
    const checks = new Map(checkConstraints(m).map((c) => [named(c.id), c]));
    const numeric = new Map(checkConstraintsNumeric(m).map((r) => [named(r.id), r]));
    const byClause = (rows: ObligationVerdict[]) => new Map(rows.map((r) => [named(r.clause.id), r]));
    const literal = byClause((await verifyModel(m, { engine: 'literal', sourceText: text })).results);
    const smt = byClause((await verifyModel(m, { engine: 'smt', sourceText: text })).results);
    return { checks, numeric, literal, smt };
  }

  for (const name of Object.keys(CASES)) {
    withZ3(`${name}: every surface agrees`, async () => {
      const { checks, numeric, literal, smt } = await fourSurfaces(name);
      for (const [clause, expected] of Object.entries(EXPECTED[name]!)) {
        const check = checks.get(clause);
        const num = numeric.get(clause);
        const lit = literal.get(clause);
        const proof = smt.get(clause);
        const where =
          `${name}::${clause} (${check?.expression}) — check: ${check?.result} ${check?.message}; ` +
          `numeric: ${num?.result} ${num?.reason ?? ''}; literal: ${lit?.claim} ${lit?.detail}; ` +
          `smt: ${proof?.claim} ${proof?.detail}`;
        expect(check && num && lit && proof, `a surface has no row: ${where}`).toBeTruthy();
        if (expected === 'satisfied' || expected === 'violated') {
          expect([check!.result, num!.result], where).toEqual([expected, expected]);
          expect(lit!.claim, where).toBe(expected === 'satisfied' ? 'holds-at-values' : 'refuted');
          expect(proof!.claim, where).toBe(expected === 'satisfied' ? 'proved' : 'refuted');
        } else if (expected === 'offset') {
          // An equality on an offset scale is refused everywhere, as it was.
          expect([check!.result, num!.result], where).toEqual(['unknown', 'unknown']);
          expect([check!.message, num!.reason ?? ''].join(' '), where).not.toMatch(/derived from dimensioned/);
          expect([lit!.claim, proof!.claim], where).toEqual(['inconclusive', 'inconclusive']);
          expect([lit!.detail, proof!.detail].join(' '), where).toContain('offset-arithmetic');
        } else {
          // One refusal, in one sentence, wherever it is read.
          expect([check!.result, num!.result], where).toEqual(['unknown', 'unknown']);
          const reason = check!.message.replace(/^Could not evaluate: /, '');
          expect(reason, where).toMatch(expected.sentence);
          expect(num!.reason, where).toBe(reason);
          const code = expected.forgivable ? 'verification/unsupported-construct' : 'verification/not-evaluable';
          for (const v of [lit!, proof!]) {
            expect([v.claim, v.code], where).toEqual(['inconclusive', code]);
            expect(v.detail, where).toContain(`(${expected.refused}): ${reason}`);
          }
        }
      }
    });
  }
});

/**
 * A PROOF at the model's own values is confirmed against the validation
 * surface, as a refutation is. The solver reasons in exact arithmetic, the
 * evaluators within a relative tolerance; on a tie inside that tolerance the
 * SMT engine proved `e != 3544.6153847 [s]` (640 Wh / 650 W is
 * 3544.615384615…) while the three other surfaces read it violated. It is now
 * undecided, with both readings — never a pass the other surface contradicts.
 */
describe('a proof the validation surface reads as violated is not a pass', () => {
  withZ3('downgrades it to undecided, naming both readings', async () => {
    const text = `package V {
    attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
    attribute power : ISQ::PowerValue = 650.0 [W];
    attribute e = capacity / power;
    constraint neNear { e != 3544.6153847 [s] }
    constraint neFar { e != 3500.0 [s] }
  }`;
    const { model } = await loadModelText(text, { fileName: 'near.sysml' });
    const m = model!;
    const named = (id: string) => m.get(id)?.declaredName ?? '';
    const checks = new Map(checkConstraints(m).map((c) => [named(c.id), c.result]));
    expect([checks.get('neNear'), checks.get('neFar')]).toEqual(['violated', 'satisfied']);
    const report = await verifyModel(m, { engine: 'smt', sourceText: text });
    const by = new Map(report.results.map((r) => [named(r.clause.id), r]));
    const near = by.get('neNear')!;
    expect([near.claim, near.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
    expect(near.detail).toMatch(/^proof not confirmed: A ∧ P ∧ ¬G is unsat in exact arithmetic, but/);
    expect(near.detail).toContain('reads this relation as `violated`');
    // A proof the validation surface agrees with stands.
    expect(by.get('neFar')!.claim).toBe('proved');
  });
});

/*
 * ONE PROOF CONTEXT, ONE READING — and no value the tool does not read may
 * decide anything.
 *
 * Regression cases for the derived-values work, each a verdict that was once
 * wrong in a way no other surface of the tool contradicted:
 *
 *  - NUMERALS. The SMT encoder reads a numeral either as the binary64 the
 *    validation surface holds (plain numbers) or as the author's decimal
 *    (quantities). Chosen one relation at a time, a plain feature's value
 *    axiom (`f = 0.1`) was binary while the goal `f * mass != 0.1 [kg]` was
 *    decimal, and `0.1 × 1 kg ≠ 0.1 kg` was PROVED; the commands that never
 *    chose at all (consistency, bounds) read `mass = 0.1 [kg]` in binary
 *    beside `mass <= 0.1 [kg]` in decimals and called the simplest model
 *    inconsistent. The reading is now a property of the proof context.
 *  - A RELEASE (`--free`) took the model's own point out of the proof's
 *    point check, so a proof the numeric surface contradicts there printed
 *    `proved`.
 *  - THE °F ORIGIN was one ulp low, so `32 °F < 273.15 K` was proved.
 *  - A COMPOSED UNIT's factor was read as the double its parts multiply to,
 *    so `1 [ft^3] > 0.028316846592 [m^3]` and `1 [g/cm^3] < 1000 [kg/m^3]`
 *    were proved.
 *  - A VALUE THE TOOL DOES NOT READ HERE (a chain `p.e`, an inherited `e`)
 *    is a symbol of its own: an axiom over it pinned what a goal read, a
 *    premise over it hid vacuity, `--allow-inconclusive` forgave a
 *    requirement it violates, and `consistency` called a violated
 *    requirement consistent.
 *  - A CALCULATION's body read outside its own context, or over its own
 *    parameter, passed a false requirement through the literal gate.
 */
async function contextModel(text: string, name: string): Promise<Model> {
  const { model } = await loadModelText(text, { fileName: `${name}.sysml` });
  if (!model) throw new Error(`${name} produced no model`);
  return model;
}

/** One engine's verdicts on a model, by the relation's text, and its exit code. */
async function verifyOne(
  text: string,
  opts: { engine: 'smt' | 'literal'; free?: string[]; allowInconclusive?: boolean },
): Promise<{ by: (expression: string) => ObligationVerdict; exitCode: number }> {
  const m = await contextModel(text, 'case');
  const report = await verifyModel(m, { sourceText: text, ...opts });
  const rows = new Map(report.results.map((r) => [r.expression.replace(/\s+/g, ' ').trim(), r]));
  return {
    by: (expression) => {
      const row = rows.get(expression);
      if (!row) throw new Error(`no row \`${expression}\`; rows: ${[...rows.keys()].join(' | ')}`);
      return row;
    },
    exitCode: report.exitCode,
  };
}

const VEHICLE = `
    part def AirVehicle {
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        attribute usableEnergyFraction : ScalarValues::Real = 0.1;
        attribute mass : ISQ::MassValue = 1.0 [kg];
    }
    part uav : AirVehicle;`;

const requirement = (pkg: string, body: string, model = VEHICLE) => `package ${pkg} { ${model}
    requirement def R { subject uav : AirVehicle; ${body} }
    satisfy R by uav; }`;

describe('every numeral of one proof context is read one way', () => {
  withZ3('a plain value beside a quantity: the true tie refuted, the true bounds proved', async () => {
    const ne = 'uav.usableEnergyFraction * uav.mass != 0.1 [kg]';
    const r = await verifyOne(requirement('NE', `require constraint { ${ne} }`), { engine: 'smt' });
    expect([r.by(ne).claim, r.exitCode]).toEqual(['refuted', 1]);
    for (const op of ['<=', '==', '>=']) {
      const goal = `uav.usableEnergyFraction * uav.mass ${op} 0.1 [kg]`;
      const t = await verifyOne(requirement('T', `require constraint { ${goal} }`), { engine: 'smt' });
      expect([t.by(goal).claim, t.exitCode], goal).toEqual(['proved', 0]);
    }
  });

  withZ3('a release of another feature does not turn the false `!=` into a proof', async () => {
    const goal = 'uav.usableEnergyFraction * uav.mass != 0.1 [kg] and uav.cruisePower >= 100.0 [W]';
    const text = requirement(
      'NFO',
      `assume constraint { uav.cruisePower >= 100.0 [W] and uav.cruisePower <= 900.0 [W] }
       require constraint { ${goal} }`,
    );
    const r = await verifyOne(text, { engine: 'smt', free: ['uav.cruisePower'] });
    expect(r.by(goal).claim).not.toBe('proved');
    expect(r.exitCode).not.toBe(0);
    // The literal engine has always refuted it.
    expect((await verifyOne(text, { engine: 'literal' })).by(goal).claim).toBe('refuted');
  });

  withZ3('releasing the plain value itself does not prove it either', async () => {
    const goal = 'uav.usableEnergyFraction * uav.mass != 0.1 [kg]';
    const text = requirement(
      'NFF',
      `assume constraint { uav.usableEnergyFraction >= 0.1 and uav.usableEnergyFraction <= 0.2 }
       require constraint { ${goal} }`,
    );
    const r = await verifyOne(text, { engine: 'smt', free: ['uav.usableEnergyFraction'] });
    expect(r.by(goal).claim).not.toBe('proved');
    expect(r.exitCode).not.toBe(0);
  });

  withZ3('an assumption over a valueless plain feature is read in the same decimals', async () => {
    const goal = 'uav.ratio * uav.mass != 0.1 [kg]';
    const model = `
    part def AirVehicle { attribute ratio : ScalarValues::Real; attribute mass : ISQ::MassValue = 1.0 [kg]; }
    part uav : AirVehicle;`;
    const r = await verifyOne(
      requirement('UN', `assume constraint { uav.ratio == 0.1 } require constraint { ${goal} }`, model),
      { engine: 'smt' },
    );
    expect(r.by(goal).claim).not.toBe('proved');
    expect(r.exitCode).toBe(2);
  });

  withZ3('a dimensionless unit literal, and 0.1 × 3 kg, are read as written', async () => {
    const ul = `package UL {
    part def Cell { attribute load : ScalarValues::Real = 0.1; }
    part c : Cell;
    requirement def R { subject c : Cell; require constraint { c.load != 0.1 [E] } }
    satisfy R by c; }`;
    expect((await verifyOne(ul, { engine: 'smt' })).by('c.load != 0.1 [E]').claim).toBe('refuted');
    const three = requirement(
      'TH',
      'require constraint { uav.f * uav.mass != 0.3 [kg] }',
      `part def AirVehicle { attribute f : ScalarValues::Real = 0.1; attribute mass : ISQ::MassValue = 3.0 [kg]; }
    part uav : AirVehicle;`,
    );
    expect((await verifyOne(three, { engine: 'smt' })).by('uav.f * uav.mass != 0.3 [kg]').claim).toBe('refuted');
  });

  withZ3('a context of plain numbers only keeps binary64, and is not proved (guard)', async () => {
    // In binary64 0.1 + 0.2 is not 0.3, so the solver finds a witness; the
    // check reads the sum within its tolerance and does not confirm it. That
    // is the reading this context has always had — a decimal reading would
    // PROVE it, which no other relation of this context asks for.
    const text = `package PL {
    attribute a = 0.1; attribute b = 0.2; attribute c = 0.3;
    constraint k { a + b == c } }`;
    const row = (await verifyOne(text, { engine: 'smt' })).by('a + b == c');
    expect([row.claim, row.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
    expect(row.detail).toMatch(/^witness not confirmed/);
  });
});

describe('a release does not take the model’s own point out of the claim', () => {
  withZ3('a proof the numeric surface reads violated at the model’s point is not printed', async () => {
    const goal = 'b.e != 3544.6153847 [s]';
    const text = `package NF {
    part def B { attribute capacity : ISQ::EnergyValue = 640.0 [Wh]; attribute power : ISQ::PowerValue = 650.0 [W];
      attribute e = capacity / power; }
    part b : B;
    requirement def R { subject b : B; assume constraint { b.power >= 650.0 [W] and b.power <= 650.0 [W] }
      require constraint { ${goal} } }
    satisfy R by b; }`;
    const r = await verifyOne(text, { engine: 'smt', free: ['b.power'] });
    const row = r.by(goal);
    expect([row.claim, row.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
    expect(row.detail).toContain('are a point the proof covers over its 1 freed feature(s)');
  });
});

describe('the °F origin is the correctly rounded 45967/180 K', () => {
  const PROBE = (pkg: string, body: string) => `package ${pkg} {
    part def Probe { attribute tf : ISQ::ThermodynamicTemperatureValue = 32.0 [fahrenheit]; }
    part p : Probe;
    requirement def R { subject p : Probe; ${body} }
    satisfy R by p; }`;

  withZ3('32 °F is 273.15 K: the tie is no `<`, and is `>=`', async () => {
    const lt = await verifyOne(PROBE('FL', 'require constraint { p.tf < 273.15 [K] }'), { engine: 'smt' });
    expect(lt.by('p.tf < 273.15 [K]').claim).not.toBe('proved');
    const ge = await verifyOne(PROBE('FG', 'require constraint { p.tf >= 273.15 [K] }'), { engine: 'smt' });
    expect([ge.by('p.tf >= 273.15 [K]').claim, ge.exitCode]).toEqual(['proved', 0]);
  });

  withZ3('released over [0, 32] °F, `tf < 273.15 [K]` is not a universal truth', async () => {
    const r = await verifyOne(
      PROBE('FF', 'assume constraint { p.tf >= 0.0 and p.tf <= 32.0 } require constraint { p.tf < 273.15 [K] }'),
      { engine: 'smt', free: ['p.tf'] },
    );
    expect(r.by('p.tf < 273.15 [K]').claim).not.toBe('proved');
    expect(r.exitCode).not.toBe(0);
  });
});

describe('a composed unit is the rational its parts define', () => {
  const PROBE = (pkg: string, attribute: string, goal: string) => `package ${pkg} {
    part def Probe { ${attribute} }
    part p : Probe;
    requirement def R { subject p : Probe; require constraint { ${goal} } }
    satisfy R by p; }`;
  const FT3 = 'attribute v : ISQ::VolumeValue = 1.0 [ft^3];';
  const GCM3 = 'attribute rho : ISQ::MassDensityValue = 1.0 [g/cm^3];';

  /** The goal's claim and the run's exit code. */
  const verdict = async (pkg: string, attribute: string, goal: string): Promise<[string, number]> => {
    const r = await verifyOne(PROBE(pkg, attribute, goal), { engine: 'smt' });
    return [r.by(goal).claim, r.exitCode];
  };

  withZ3('1 ft³ is 0.028316846592 m³: the tie is no `>`, and is `<=`, `==` and `>=`', async () => {
    expect(await verdict('VG', FT3, 'p.v > 0.028316846592 [m^3]')).toEqual(['inconclusive', 2]);
    for (const op of ['<=', '==', '>=']) {
      const goal = `p.v ${op} 0.028316846592 [m^3]`;
      expect(await verdict('VT', FT3, goal), goal).toEqual(['proved', 0]);
    }
  });

  withZ3('1 g/cm³ is 1000 kg/m³: the tie is no `<`, and is `>=`, `==` and `<=`', async () => {
    expect(await verdict('DL', GCM3, 'p.rho < 1000.0 [kg/m^3]')).toEqual(['inconclusive', 2]);
    for (const op of ['>=', '==', '<=']) {
      const goal = `p.rho ${op} 1000.0 [kg/m^3]`;
      expect(await verdict('DT', GCM3, goal), goal).toEqual(['proved', 0]);
    }
  });

  withZ3('a composed `[unit]` literal is read the same way', async () => {
    const w = 'attribute w : ISQ::VolumeValue = 0.028316846592 [m^3];';
    expect(await verdict('WL', w, 'p.w < 1.0 [ft^3]')).toEqual(['inconclusive', 2]);
    expect(await verdict('WG', w, 'p.w >= 1.0 [ft^3]')).toEqual(['proved', 0]);
    const d = 'attribute d : ISQ::MassDensityValue = 1000.0 [kg/m^3];';
    expect(await verdict('EG', d, 'p.d > 1.0 [g/cm^3]')).toEqual(['inconclusive', 2]);
    expect(await verdict('EL', d, 'p.d <= 1.0 [g/cm^3]')).toEqual(['proved', 0]);
  });
});

describe('a value this tool does not read here pins nothing, and is never forgiven', () => {
  // `P2` redefines the input P's equation reads, so P's `e` (6) is not P2's
  // (8): read through `P2`, it is a value this tool does not read.
  const P = `part def P {
      attribute x : ScalarValues::Real = 3.0;
      attribute e : ScalarValues::Real;
      assert constraint defE { e == x * 2.0 }
      attribute k : ScalarValues::Real = 5.0;
    }
    part def P2 :> P { attribute :>> x = 4.0; }`;

  withZ3('an axiom over an inherited name does not prove a goal over it', async () => {
    const text = `package IS { ${P}
    part def S :> P2 { assert constraint big { e >= 10.0 } constraint goal { e >= 9.0 } }
    part s : S; }`;
    const r = await verifyOne(text, { engine: 'smt' });
    expect(r.by('e >= 9.0').claim).not.toBe('proved');
    expect(r.exitCode).toBe(2);
    // The axiom is refused, with its reason, so no proof can rest on it.
    const m = await contextModel(text, 'IS');
    const big = obligationsOf(m).find((o) => o.element.qualifiedName.endsWith('::big'))!;
    expect(big.encodable).toMatchObject({ reason: 'unread-definition' });
  });

  withZ3('an axiom over a chain does not prove a goal over it, nor one in another context', async () => {
    const chain = `package CS { ${P}
    part def Q { part p : P2; assert constraint big { p.e >= 10.0 } constraint goal { p.e >= 9.0 } }
    part q : Q; }`;
    expect((await verifyOne(chain, { engine: 'smt' })).by('p.e >= 9.0').claim).not.toBe('proved');
    const pin = `package AP {
    part def P { attribute a = 2.0; attribute e; assert constraint d { e == a * 3.0 } }
    part p : P { attribute :>> a = 4.0; }
    assert constraint a1 { p.e == 3.0 }
    constraint g { p.e <= 4.0 } }`;
    const r = await verifyOne(pin, { engine: 'smt' });
    expect([r.by('p.e <= 4.0').claim, r.exitCode]).toEqual(['inconclusive', 2]);
  });

  withZ3('an assumption over a chain cannot be shown non-vacuous, so nothing is proved', async () => {
    const text = `package CV { ${P}
    part p : P2;
    requirement def R { subject p : P2; assume constraint { p.e >= 10.0 } require constraint { p.e >= 9.0 } }
    satisfy R by p; }`;
    const row = (await verifyOne(text, { engine: 'smt' })).by('p.e >= 9.0');
    expect([row.claim, row.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
    expect(row.detail).toMatch(/^proof not claimed: .*the assumption `p\.e >= 10\.0` reads `p\.e`/);
  });

  withZ3('nor refuted: a witness that meets an assumption by a value the model does not state is no violation', async () => {
    // At the model's values every assumption is false or unread, so `assume ⇒
    // require` holds there or is undecided — never a violation, exit 1.
    for (const [name, decl, assume] of [
      ['unread', 'part p : P2;', 'p.e >= 10.0'],
      ['valueless', 'part def V :> P { attribute u : ScalarValues::Real; } part p : V;', 'p.u >= 10.0'],
      ['parameter', 'part def C :> P { calc g { in y = 100.0; y } } part p : C;', 'p.g <= 10.0'],
    ] as const) {
      const sub = decl.match(/part p : (\w+);/)![1];
      const text = `package UP { ${P}
    ${decl}
    requirement def R { subject p : ${sub}; assume constraint { ${assume} } require constraint { p.k <= 1.0 } }
    satisfy R by p; }`;
      const r = await verifyOne(text, { engine: 'smt' });
      const row = r.by('p.k <= 1.0');
      expect([row.claim, row.code, r.exitCode], name).toEqual(['inconclusive', 'verification/not-evaluable', 2]);
      expect(row.detail, name).toMatch(/^refutation not claimed: .*the assumption `/);
    }
  });

  withZ3('a requirement the unread value violates is not forgiven by --allow-inconclusive', async () => {
    const text = `package CF { ${P}
    part p : P2;
    requirement def R { subject p : P2; require constraint { p.e <= 1.0 } }
    satisfy R by p; }`;
    for (const engine of ['smt', 'literal'] as const) {
      const r = await verifyOne(text, { engine, allowInconclusive: true });
      const row = r.by('p.e <= 1.0');
      expect([row.claim, row.code, r.exitCode], engine).toEqual(['inconclusive', 'verification/not-evaluable', 2]);
      expect(row.detail, engine).toContain('(unread-definition): p.e has no value');
    }
  });

  withZ3('a chain or an inherited name that changes nothing the definition reads IS read, on every engine', async () => {
    const text = `package CR { ${P}
    part p : P;
    part def S :> P { constraint own { e <= 1.0 } }
    requirement def R { subject p : P; require constraint { p.e <= 1.0 } }
    satisfy R by p; }`;
    for (const engine of ['smt', 'literal'] as const) {
      const r = await verifyOne(text, { engine, allowInconclusive: true });
      expect([r.by('p.e <= 1.0').claim, r.by('e <= 1.0').claim, r.exitCode], engine).toEqual(['refuted', 'refuted', 1]);
    }
  });

  withZ3('a relation that also reads a value the model never states is filed under that defect', async () => {
    const launder = `package LD { ${P}
    part def Q { part p : P2; attribute w : ScalarValues::Real; }
    part q : Q;
    requirement def R { subject q : Q; require constraint { q.p.e <= 100.0 and q.w <= 1.0 } }
    satisfy R by q; }`;
    const missing = `package UM {
    part def P { attribute a = 2.0; attribute e; assert constraint d { e == a * 3.0 } }
    part p : P { attribute :>> a = 4.0; }
    attribute x;
    constraint c2 { p.e <= x } }`;
    for (const [text, goal] of [
      [launder, 'q.p.e <= 100.0 and q.w <= 1.0'],
      [missing, 'p.e <= x'],
    ] as const) {
      for (const engine of ['smt', 'literal'] as const) {
        const r = await verifyOne(text, { engine, allowInconclusive: true });
        const row = r.by(goal);
        expect([row.claim, row.code, r.exitCode], `${engine}: ${goal}`).toEqual([
          'inconclusive',
          'verification/not-evaluable',
          2,
        ]);
        expect(row.detail, `${engine}: ${goal}`).not.toContain('unread-definition');
      }
    }
  });

  withZ3('consistency at the model’s values does not call a violated requirement consistent', async () => {
    const text = `package CU { ${P}
    part p : P2;
    requirement def R { subject p : P2; require constraint { p.e <= 1.0 } }
    satisfy R by p; }`;
    const r = await consistencyReport(await contextModel(text, 'CU'), { withValues: true, sourceText: text });
    expect([r.consistent, r.exitCode]).toEqual([0, 2]);
  });

  withZ3('consistency is undecided, never forgiven, wherever a refused unread relation reaches the set', async () => {
    const cases = {
      // A refused clause beside one that is asserted.
      clause: `package CA { ${P}
    part p : P2;
    requirement def R { subject p : P2; require constraint { p.e <= 1.0 } require constraint { p.k <= 9.0 } }
    satisfy R by p; }`,
      // An asserted axiom over the chain, which excludes the requirement's point.
      axiom: `package CB { ${P}
    part def Q { part p : P2; assert constraint cap { p.e <= 1.0 } }
    part q : Q;
    requirement def R { subject q : Q; require constraint { q.p.x >= 1.0 } }
    satisfy R by q; }`,
      // A value axiom over an inherited name the specialisation redefines the input of.
      value: `package CC { ${P}
    part def S :> P2 { attribute g : ScalarValues::Real = e * 2.0; }
    part s : S;
    requirement def R { subject s : S; require constraint { s.g <= 1.0 } }
    satisfy R by s; }`,
    };
    for (const [name, text] of Object.entries(cases)) {
      for (const withValues of [false, true]) {
        const r = await consistencyReport(await contextModel(text, name), {
          withValues,
          allowInconclusive: true,
          sourceText: text,
        });
        expect([r.consistent, r.exitCode], `${name}, withValues ${withValues}`).toEqual([0, 2]);
        expect(r.groups.map((g) => g.code), name).toContain('verification/not-evaluable');
      }
    }
    // Read where nothing is redefined, the clause set is inconsistent — exit 1.
    const read = cases.clause.replaceAll('P2', 'P');
    const r = await consistencyReport(await contextModel(read, 'CR'), { withValues: true, sourceText: read });
    expect([r.inconsistent, r.exitCode]).toEqual([1, 1]);
  });

  withZ3('bounds does not establish a bound a refused unread relation may tighten', async () => {
    const req = `package BD { ${P}
    part def B :> P { assert constraint xr { x >= 0.0 and x <= 100.0 } }
    part def B2 :> B { attribute :>> x = 4.0; }
    part p : B2;
    requirement def R { subject p : B2; require constraint { p.e <= 1.0 } }
    satisfy R by p; }`;
    const m = await contextModel(req, 'BD');
    const withReq = await boundsReport(m, {
      measure: 'BD::P::x',
      sense: 'max',
      freeAll: true,
      withRequirements: true,
      sourceText: req,
    });
    expect([withReq.bounds.map((b) => b.outcome), withReq.exitCode]).toEqual([['inconclusive'], 2]);
    const ax = `package BA { ${P}
    part def Q { part p : P2; assert constraint cap { p.e <= 1.0 } }
    part q : Q; }`;
    const axiom = await boundsReport(await contextModel(ax, 'BA'), {
      measure: 'BA::P::x',
      sense: 'max',
      freeAll: true,
      sourceText: ax,
    });
    expect([axiom.bounds.map((b) => b.outcome), axiom.exitCode]).toEqual([['inconclusive'], 2]);
  });

  withZ3('refine reads a contract over an unread value as the feature it names', async () => {
    const pack = (top: string, cell: string) => `package RF {
    part def Cell {
      attribute x : ScalarValues::Real = 3.0;
      attribute e : ScalarValues::Real;
      assert constraint d { e == x * 2.0 }
    }
    part def Pack { part cell : Cell { attribute :>> x = 4.0; } }
    requirement def Top { subject sys : Pack; require constraint { ${top} } }
    requirement def CellReq { subject c : Cell; require constraint { ${cell} } }
    satisfy Top by Pack;
    satisfy CellReq by Pack::cell; }`;
    const refined = pack('sys.cell.e <= 10.0', 'c.e <= 1.0');
    const r = await refinementReport(await contextModel(refined, 'RF'), { sourceText: refined });
    expect([r.refined, r.notRefined, r.inconclusive, r.exitCode]).toEqual([1, 0, 0, 0]);
    const loose = pack('sys.cell.e <= 1.0', 'c.e <= 10.0');
    const n = await refinementReport(await contextModel(loose, 'RF'), { sourceText: loose });
    expect([n.refined, n.notRefined, n.exitCode]).toEqual([0, 1, 1]);
  });
});

describe('a calculation’s body is read where it is a value, and nowhere else', () => {
  withZ3('a calculation over its own parameter states no value the check reads', async () => {
    const text = `package A8 {
    attribute y = 4.0;
    calc g { in y = 100.0; y }
    constraint cg { g <= 10.0 } }`;
    const r = await verifyOne(text, { engine: 'literal' });
    expect([r.by('g <= 10.0').claim, r.exitCode]).toEqual(['inconclusive', 2]);
  });

  withZ3('a calculation typed by a calc def has the definition’s parameters, default or not', async () => {
    for (const param of ['in x : ScalarValues::Real = 100.0;', 'in x : ScalarValues::Real;']) {
      const text = `package A9 {
    calc def Scale { ${param} x * 2.0 }
    part def P { attribute x : ScalarValues::Real = 3.0; calc t : Scale { x * 5.0 } constraint c { t <= 20.0 } }
    part p : P; }`;
      for (const engine of ['literal', 'smt'] as const) {
        const r = await verifyOne(text, { engine });
        expect([r.by('t <= 20.0').claim, r.exitCode], `${engine}: ${param}`).toEqual(['inconclusive', 2]);
      }
      // No axiom is asserted from its body: the SMT engine proved `t <= 20.0` from `t == 3 * 5`.
      const m = await contextModel(text, 'A9');
      const axiom = obligationsOf(m).find((o) => o.source === 'calculation')!;
      expect(axiom.encodable, param).toMatchObject({ reason: 'unread-definition' });
      // Nor is it solved from: the numeric surface judged it satisfied at t = 15.
      const rows = new Map(checkConstraintsNumeric(m).map((r) => [r.raw, r.result]));
      expect([rows.get('t <= 20.0'), checkConstraints(m).find((c) => c.expression === 't <= 20.0')!.result], param).toEqual([
        'unknown',
        'unknown',
      ]);
    }
  });

  withZ3('an inherited calculation is not read in the usage that redefines its input', async () => {
    const text = `package A11 {
    part def P { attribute load = 1.0; calc margin { 10.0 - load } }
    part p : P { attribute :>> load = 50.0; constraint c { margin >= 0.0 } } }`;
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyOne(text, { engine });
      const row = r.by('margin >= 0.0');
      expect([row.claim, r.exitCode], engine).toEqual(['inconclusive', 2]);
      expect(row.detail, engine).toContain('P::margin is a calculation of P');
    }
  });

  withZ3('an inherited calculation is read where the context changes nothing it reads, and through a chain', async () => {
    const text = `package A12 {
    part def P { attribute load = 5.0; calc margin { 10.0 - load } }
    part p : P { attribute spare = 1.0; constraint ok { margin >= 0.0 } constraint hi { margin >= 6.0 } }
    constraint outer { p.margin >= 0.0 } }`;
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyOne(text, { engine });
      expect([r.by('margin >= 0.0').claim, r.by('p.margin >= 0.0').claim, r.by('margin >= 6.0').claim], engine).toEqual(
        engine === 'smt' ? ['proved', 'proved', 'refuted'] : ['holds-at-values', 'holds-at-values', 'refuted'],
      );
    }
    // Redefining what an input's value reads is redefining the input.
    const deep = `package A13 {
    part def P { attribute base = 1.0; attribute load = base * 5.0; calc margin { 10.0 - load } }
    part p : P { attribute base :>> base = 4.0; constraint ok { margin >= 0.0 } } }`;
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyOne(deep, { engine });
      expect([r.by('margin >= 0.0').claim, r.exitCode], engine).toEqual(['inconclusive', 2]);
    }
  });
});

describe('a mass of 0.1 kg under a 0.1 kg limit, on every command', () => {
  const TIE = `package CT {
    part def AirVehicle { attribute mass : ISQ::MassValue = 0.1 [kg]; attribute payload : ISQ::MassValue;
      assert constraint cap { mass <= 0.1 [kg] }
      assert constraint split { payload <= mass } }
    part uav : AirVehicle;
    requirement def RMax { subject uav : AirVehicle; require constraint { uav.mass <= 0.1 [kg] } }
    satisfy RMax by uav; }`;

  withZ3('verify proves it on both engines', async () => {
    const smt = await verifyOne(TIE, { engine: 'smt' });
    expect([smt.by('uav.mass <= 0.1 [kg]').claim, smt.exitCode]).toEqual(['proved', 0]);
    const literal = await verifyOne(TIE, { engine: 'literal' });
    expect([literal.by('uav.mass <= 0.1 [kg]').claim, literal.exitCode]).toEqual(['holds-at-values', 0]);
  });

  withZ3('consistency at the model’s values calls it consistent', async () => {
    const r = await consistencyReport(await contextModel(TIE, 'CT'), { withValues: true, sourceText: TIE });
    expect([r.consistent, r.inconsistent, r.exitCode]).toEqual([1, 0, 0]);
  });

  withZ3('bounds reads the bound 0.1 kg, asserted or required', async () => {
    const m = await contextModel(TIE, 'CT');
    const payload = await boundsReport(m, { measure: 'uav.payload', sense: 'max', sourceText: TIE });
    expect([payload.bounds.map((b) => [b.outcome, b.value]), payload.exitCode]).toEqual([[['optimum', 0.1]], 0]);
    const withReq = await boundsReport(m, { measure: 'uav.mass', sense: 'both', withRequirements: true, sourceText: TIE });
    expect([withReq.bounds.map((b) => [b.outcome, b.value]), withReq.exitCode]).toEqual([
      [
        ['optimum', 0.1],
        ['optimum', 0.1],
      ],
      0,
    ]);
  });
});

describe('the relation census — no relation leaves the pipeline unaccounted for', () => {
  it('accounts for every constraint-bearing user element as encoded or refused', () => {
    const unaccounted: string[] = [];
    let census = 0;
    let encoded = 0;
    let refused = 0;
    for (const l of loaded) {
      const ids = elementCensus(l.model);
      census += ids.length;
      for (const [id, account] of reconcile(ids, l.worklist)) {
        if (account === 'encoded') encoded += 1;
        else if (account === 'refused') refused += 1;
        else unaccounted.push(`${l.path}: ${l.model.qualifiedName(id)}`);
      }
    }
    expect(
      unaccounted,
      `a relation the model states and the worklist never filed — it is not refused, not ` +
        `unsupported, and nothing downstream will say a word about it:\n${unaccounted.join('\n')}`,
    ).toEqual([]);
    // THE COUNTS ARE ASSERTED EQUAL TO THE ELEMENT CENSUS. That is the whole
    // mechanism: a partition with a hole in it is a partition whose parts still
    // add up to less than the whole.
    expect(encoded + refused, 'the accounting does not add up to the census').toBe(census);
    expect(census, 'the census found no relation at all').toBeGreaterThan(10);
    expect(encoded, 'nothing in the corpus encodes').toBeGreaterThan(0);
    expect(refused, 'nothing in the corpus is refused — the refusal path is untested').toBeGreaterThan(0);
  });

  it('gives every refused relation a reason a person can act on', () => {
    for (const l of loaded) {
      for (const id of elementCensus(l.model)) {
        const row = l.worklist.get(id);
        if (row === undefined || row.encodable === true) continue;
        const where = `${l.path}: ${l.model.qualifiedName(id)}`;
        // A refusal is branchable AND readable: automation reads the reason,
        // a person reads the detail, and neither may be empty.
        expect(row.encodable.reason.length, `${where} was refused with no reason`).toBeGreaterThan(0);
        expect(row.encodable.detail.length, `${where} was refused with no sentence`).toBeGreaterThan(20);
      }
    }
  });

  it('reports every obligation the worklist filed, under a code when it was not decided', () => {
    // The second half of the accounting: the worklist is not the report. A row
    // gathered and then dropped between `obligationsOf` and `verifyModel` would
    // pass the census above and still say nothing to a reader.
    for (const l of loaded) {
      const reported = new Set(l.smt.map((r) => r.clause.id));
      const filed = [...l.worklist.values()].filter((r) => r.role === 'obligation');
      expect(
        filed.filter((r) => !reported.has(r.element.id)).map((r) => r.element.qualifiedName),
        `${l.path}: an obligation the worklist filed never reached the report`,
      ).toEqual([]);
      for (const row of l.smt) {
        const w = l.worklist.get(row.clause.id);
        if (w === undefined || w.encodable === true) continue;
        expect(row.code, `${l.path}: ${row.clause.qualifiedName} was refused with no code`).toMatch(
          /^verification\//,
        );
        expect(row.discharged, `${l.path}: a refused relation was discharged`).toBe(false);
      }
    }
  });

  it('the census has teeth: a relation removed from the worklist is reported missing', () => {
    // The negative control. Every assertion above is "the accounting adds up",
    // and an accounting that could not fail would add up over an empty world
    // too — so the reconciliation is exercised against a worklist with one row
    // deliberately taken out, which is what "a relation silently disappears"
    // looks like from inside this file.
    const withRelations = loaded.find((l) => elementCensus(l.model).length > 0);
    expect(withRelations, 'no model in the corpus states a relation').toBeDefined();
    const ids = elementCensus(withRelations!.model);
    const dropped = new Map(withRelations!.worklist);
    dropped.delete(ids[0]);
    const accounts = [...reconcile(ids, dropped).values()];
    expect(accounts.filter((a) => a === 'missing').length, 'the gate absorbed a dropped relation').toBe(
      1,
    );
    // And it is green again when nothing is dropped, so the control is a
    // control and not a permanently red assertion.
    expect([...reconcile(ids, withRelations!.worklist).values()]).not.toContain('missing');
  });

  it('walks a self-typed feature rather than dying on it', async () => {
    // `item def Person { timeslice asPresident : Person; }` names an unbounded
    // tower of dotted scopes. The numeric surface's collector was given a cycle
    // guard keyed on the owner when that fixture was filed; the worklist's was
    // not, and nothing reached it until an engine read the worklist — so the
    // whole verification lane died with a RangeError on a file that checks
    // clean. A gatherer that throws is the loudest form of the blind spot this
    // census exists to close: no relation refused, none encoded, no report.
    const path = 'test/fixtures/agent-authoring/L4-self-typed-feature/input.sysml';
    const text = read(path);
    const { model } = await loadModelText(text, { fileName: path });
    expect(model, 'the self-typed fixture stopped parsing').toBeDefined();
    expect(() => obligationsOf(model!), 'the worklist gatherer died on a self-typed feature').not.toThrow();
    const report = await verifyModel(model!, { engine: 'smt', sourceText: text });
    expect(report.exitCode, 'the run did not reach a verdict at all').toBeGreaterThanOrEqual(0);
  }, 120_000);
});

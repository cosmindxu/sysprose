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
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ElementId, Model } from '@core/index';
import {
  ALLOW_INCONCLUSIVE_CODES,
  analysisReport,
  boundsReport,
  consistencyReport,
  faultTreeReport,
  isUserElement,
  refinementReport,
  verifyModel,
  type ObligationVerdict,
} from '@api/index';
import {
  anchorFor,
  checkConstraints,
  checksByRow,
  withEveryInstanceJudged,
  type ConstraintCheck,
  type SpecialisationInstance,
} from '@semantics/evaluate-model';
import { effectiveQualifiedName } from '@semantics/inheritance';
import { obligationsOf, type Obligation } from '@semantics/obligations';
import { checkConstraintsNumeric, solveFeasible } from '@semantics/solver';
import { resolveFreeFeatures } from '@semantics/engines/smt';
import {
  DEAD_MODULE_MARGIN_MS,
  DEFAULT_TIMEOUT_MS,
  loadZ3,
  resetZ3Cache,
  z3Disabled,
} from '@semantics/smt/z3-bridge';
import { BINARY_PREFIXES, SI_PREFIXES, UNIT_REGISTRY, resolveUnit } from '@semantics/units';
import { loadModelText } from '@text/load';
import { validate } from '@validation/index';

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
 * The least timeout a solver case may run under: the bridge's death guard
 * (a check's budget plus {@link DEAD_MODULE_MARGIN_MS}, 35 s for the default
 * one) plus 5 s, as in `test/campaign/verification.test.ts` (defect D5).
 */
const SOLVER_CASE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS + DEAD_MODULE_MARGIN_MS + 5_000;

/**
 * Skip a solver case where the optional dependency is not installed.
 *
 * The same pattern, for the same reason, as
 * `test/integration/smt-z3.integration.test.ts`: a clone that skipped optional
 * dependencies must still run every suite, so the rules that need a backend
 * degrade to a SKIP rather than to a failure — and the skip is itself guarded
 * in `beforeAll`, so it can never fire on a machine that has the package. The
 * timeout floor is held when the case is declared, as it is there.
 */
const withZ3 = (name: string, fn: () => void | Promise<void>, timeout = 120_000) => {
  if (timeout < SOLVER_CASE_TIMEOUT_MS) {
    throw new Error(
      `"${name}" drives z3 under a ${timeout} ms timeout; a solver case needs at least ` +
        `${SOLVER_CASE_TIMEOUT_MS} ms, the death guard plus 5 s (defect D5)`,
    );
  }
  return it(
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
};

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
      // By the id a worklist row carries: a definition's constraint read in a
      // context that specialises it is compared with that context's reading.
      checks: checksByRow(checkConstraints(model)),
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

  withZ3('refutes at an exact strict boundary, on both engines (the tie rule)', async () => {
    // Once the one place the two surfaces read a relation differently: the
    // unit-aware evaluator counted a tie as EQUAL for every operator, the
    // strict ones included, so `mass < 18.5 [kg]` at 18.5 kg was `satisfied`
    // there while z3, over exact rationals, found the negation satisfiable —
    // and the witness gate declined to refute (`d568a1f`). Every surface now
    // decides a tie by the decimals written: the boundary is the boundary.
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
    expect([strict!.claim, strict!.code], 'a strict ordering at its boundary was not refuted').toEqual([
      'refuted',
      'verification/refuted',
    ]);
    expect(strict!.detail).toContain('confirmed by re-evaluation on the numeric surface');
    const literal = await verifyModel(model!, { engine: 'literal', sourceText: text });
    const lit = literal.results.find((r) => r.requirement?.qualifiedName === 'StrictBoundary::StrictUnder');
    expect(lit!.claim, 'the literal engine read the boundary otherwise').toBe('refuted');

    // The non-strict sibling is the control: at the same boundary, on the same
    // value, both surfaces agree and the proof is available.
    expect(by.get('StrictBoundary::LooseUnder')!.claim).toBe('proved');
    expect(report.exitCode, 'a run carrying a refutation did not exit 1').toBe(1);
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
  /** The inputs where a usage or a specialisation overrides one: a `default`, not a binding. */
  const DEFAULT_INPUTS = `attribute capacity : ISQ::EnergyValue default = 640.0 [Wh];
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
    part def P { ${DEFAULT_INPUTS}
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
    part def B { attribute k default = 3.0; attribute e; assert constraint d { e == 2.0 * k } }
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
    part def P { ${DEFAULT_INPUTS} attribute e; assert constraint d { e == capacity / power } }
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
    // A chain to — or an inherited — value only an asserted equation defines,
    // through a context that changes what it reads: that context's own value,
    // the definition read over its names (p's 1300 Wh / 650 W, 2 h).
    featureChain: { geMin: 'satisfied', eqH: 'violated', ge: named('p.e', untyped) },
    featureChainRead: { geMin: 'satisfied', eqH: 'violated', ge: named('p.e', untyped) },
    valueWithBare: { le: inside, ne: inside, geS: inside },
    realTyped: { le: mismatch, ne: mismatch, ge: mismatch },
    realTypedEquation: { le: mismatch, ne: mismatch },
    shortCircuit: { orBare: untyped, andBare: untyped },
    grams: { eqKg: 'satisfied', neKg: 'violated', leG: 'satisfied', eqG: 'satisfied', neG: 'violated' },
    // p's own e, 2 × 5.
    chainNotRead: { orChain: 'satisfied', andChain: 'violated', onChain: 'violated' },
    chainRead: { orChain: 'satisfied', andChain: 'violated', onChain: 'violated' },
    // `S` redefines `capacity`: P's equation read over S's inputs, 320 Wh /
    // 650 W, 29.5 min — not P's 59.1.
    inheritedDefinition: { u: 'satisfied', b: named('e', untyped) },
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
 * A NEAR MISS IS DECIDED BY THE DECIMALS, on every surface. The solver reasons
 * in exact arithmetic; the evaluators read a tie within a relative tolerance as
 * equal, so the SMT engine proved `e != 3544.6153847 [s]` (640 Wh / 650 W is
 * 3544.615384615…) while the three other surfaces read it violated — and the
 * proof was held undecided rather than published beside them. The evaluators
 * decide that tie by the decimals now (the tie rule), so all four agree: the
 * two numbers differ.
 */
describe('a near miss the evaluators read as a tie is decided by the decimals, on every surface', () => {
  withZ3('`e != 3544.6153847 [s]` is satisfied, holds and is proved', async () => {
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
    expect([checks.get('neNear'), checks.get('neFar')]).toEqual(['satisfied', 'satisfied']);
    const numeric = new Map(checkConstraintsNumeric(m).map((r) => [named(r.id), r.result]));
    expect([numeric.get('neNear'), numeric.get('neFar')]).toEqual(['satisfied', 'satisfied']);
    const literal = await verifyModel(m, { engine: 'literal', sourceText: text });
    expect(literal.results.map((r) => r.claim)).toEqual(['holds-at-values', 'holds-at-values']);
    const report = await verifyModel(m, { engine: 'smt', sourceText: text });
    const by = new Map(report.results.map((r) => [named(r.clause.id), r]));
    expect([by.get('neNear')!.claim, by.get('neFar')!.claim]).toEqual(['proved', 'proved']);
  });
});

/*
 * ONE PROOF CONTEXT, ONE READING — and no value the tool does not read may
 * decide anything.
 *
 * Regression cases for the derived-values work, each a verdict that was once
 * wrong in a way no other surface of the tool contradicted:
 *
 *  - NUMERALS. The SMT encoder read a numeral either as the binary64 the
 *    validation surface holds (plain numbers) or as the author's decimal
 *    (quantities). Chosen one relation at a time, a plain feature's value
 *    axiom (`f = 0.1`) was binary while the goal `f * mass != 0.1 [kg]` was
 *    decimal, and `0.1 × 1 kg ≠ 0.1 kg` was PROVED; the commands that never
 *    chose at all (consistency, bounds) read `mass = 0.1 [kg]` in binary
 *    beside `mass <= 0.1 [kg]` in decimals and called the simplest model
 *    inconsistent. Chosen per proof context, a context of plain numbers kept
 *    binary64 and PROVED `0.1 + 0.2 > 0.3`, and an unrelated dimensioned
 *    requirement over one more feature flipped the verdict. Every numeral is
 *    now the decimal written, in every context.
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

  withZ3('a context of plain numbers only is read as written, and `0.1 + 0.2 == 0.3` is proved', async () => {
    // Read in binary64, 0.1 + 0.2 was not 0.3: the solver found a witness the
    // check did not confirm, and a true relation was left undecided.
    const text = `package PL {
    attribute a = 0.1; attribute b = 0.2; attribute c = 0.3;
    constraint k { a + b == c } }`;
    const r = await verifyOne(text, { engine: 'smt' });
    expect([r.by('a + b == c').claim, r.exitCode]).toEqual(['proved', 0]);
  });
});

describe('a release does not take the model’s own point out of the claim', () => {
  withZ3('a proof over a release is read at the model’s point too, and agrees with it there', async () => {
    const goal = 'b.e != 3544.6153847 [s]';
    const text = `package NF {
    part def B { attribute capacity : ISQ::EnergyValue = 640.0 [Wh]; attribute power : ISQ::PowerValue = 650.0 [W];
      attribute e = capacity / power; }
    part b : B;
    requirement def R { subject b : B; assume constraint { b.power >= 650.0 [W] and b.power <= 650.0 [W] }
      require constraint { ${goal} } }
    satisfy R by b; }`;
    // The released `power` admits only 650 W, so the model's own point is the
    // one the proof covers. The numeric surface reads the goal there by the
    // decimals written — 3544.615384615… is not 3544.6153847 — and agrees, so
    // the proof stands; read within a tolerance, the same tie was `violated`
    // there and the proof undecided.
    const r = await verifyOne(text, { engine: 'smt', free: ['b.power'] });
    const row = r.by(goal);
    expect([row.claim, row.code]).toEqual(['proved', null]);
    expect(checkConstraints(await contextModel(text, 'NF')).find((c) => c.expression.includes('3544'))?.result).toBe(
      'satisfied',
    );
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
    expect(await verdict('VG', FT3, 'p.v > 0.028316846592 [m^3]')).toEqual(['refuted', 1]);
    for (const op of ['<=', '==', '>=']) {
      const goal = `p.v ${op} 0.028316846592 [m^3]`;
      expect(await verdict('VT', FT3, goal), goal).toEqual(['proved', 0]);
    }
  });

  withZ3('1 g/cm³ is 1000 kg/m³: the tie is no `<`, and is `>=`, `==` and `<=`', async () => {
    expect(await verdict('DL', GCM3, 'p.rho < 1000.0 [kg/m^3]')).toEqual(['refuted', 1]);
    for (const op of ['>=', '==', '<=']) {
      const goal = `p.rho ${op} 1000.0 [kg/m^3]`;
      expect(await verdict('DT', GCM3, goal), goal).toEqual(['proved', 0]);
    }
  });

  withZ3('a composed `[unit]` literal is read the same way', async () => {
    const w = 'attribute w : ISQ::VolumeValue = 0.028316846592 [m^3];';
    expect(await verdict('WL', w, 'p.w < 1.0 [ft^3]')).toEqual(['refuted', 1]);
    expect(await verdict('WG', w, 'p.w >= 1.0 [ft^3]')).toEqual(['proved', 0]);
    const d = 'attribute d : ISQ::MassDensityValue = 1000.0 [kg/m^3];';
    expect(await verdict('EG', d, 'p.d > 1.0 [g/cm^3]')).toEqual(['refuted', 1]);
    expect(await verdict('EL', d, 'p.d <= 1.0 [g/cm^3]')).toEqual(['proved', 0]);
  });
});

describe('a value read where its inputs are changed is that context’s own, and pins only it', () => {
  // `P2` redefines the input P's equation reads, so P's `e` (6) is not P2's
  // (8): read through `P2`, it is P2's own value — P's equation read over
  // P2's names — and its own symbol (Stage 2; Stage 1 read it as nothing).
  const P = `part def P {
      attribute x : ScalarValues::Real default = 3.0;
      attribute e : ScalarValues::Real;
      assert constraint defE { e == x * 2.0 }
      attribute k : ScalarValues::Real = 5.0;
    }
    part def P2 :> P { attribute :>> x = 4.0; }`;

  withZ3('an axiom an inherited value breaks makes the axioms inconsistent, and proves nothing', async () => {
    const text = `package IS { ${P}
    part def S :> P2 { assert constraint big { e >= 10.0 } constraint goal { e >= 9.0 } }
    part s : S; }`;
    // S's e is 8 (P's equation read over S's x): `big` contradicts it.
    const r = await verifyOne(text, { engine: 'smt' });
    const row = r.by('e >= 9.0');
    expect([row.claim, row.code, r.exitCode]).toEqual(['inconclusive', 'verification/inconsistent-axioms', 2]);
    expect(row.detail).toContain('IS::P::defE in IS::S');
    const m = await contextModel(text, 'IS');
    const big = obligationsOf(m).find((o) => o.element.qualifiedName.endsWith('::big'))!;
    expect([big.encodable, big.vars.map((v) => v.qualifiedName)]).toEqual([true, ['IS::S::e']]);
  });

  withZ3('an axiom over a chain does not prove a goal over it, nor one in another context', async () => {
    const chain = `package CS { ${P}
    part def Q { part p : P2; assert constraint big { p.e >= 10.0 } constraint goal { p.e >= 9.0 } }
    part q : Q; }`;
    expect((await verifyOne(chain, { engine: 'smt' })).by('p.e >= 9.0').claim).not.toBe('proved');
    const pin = `package AP {
    part def P { attribute a default = 2.0; attribute e; assert constraint d { e == a * 3.0 } }
    part p : P { attribute :>> a = 4.0; }
    assert constraint a1 { p.e == 3.0 }
    constraint g { p.e <= 4.0 } }`;
    const r = await verifyOne(pin, { engine: 'smt' });
    expect([r.by('p.e <= 4.0').claim, r.exitCode]).toEqual(['inconclusive', 2]);
  });

  withZ3('an assumption over a chain is read at the chain’s value: false there, the requirement is vacuous', async () => {
    const text = `package CV { ${P}
    part p : P2;
    requirement def R { subject p : P2; assume constraint { p.e >= 10.0 } require constraint { p.e >= 9.0 } }
    satisfy R by p; }`;
    const smt = (await verifyOne(text, { engine: 'smt' })).by('p.e >= 9.0');
    expect([smt.claim, smt.code]).toEqual(['vacuous', 'verification/vacuous']);
    const literal = (await verifyOne(text, { engine: 'literal' })).by('p.e >= 9.0');
    expect([literal.claim, literal.code]).toEqual(['vacuous', 'verification/vacuous-pass']);
  });

  withZ3('nor refuted: a witness that meets an assumption by a value the model does not state is no violation', async () => {
    // At the model's values every assumption is false or unread, so `assume ⇒
    // require` holds there or is undecided — never a violation, exit 1.
    for (const [name, decl, assume] of [
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
    // P2's e, read where it is (8), makes the assumption false: vacuous, never a violation.
    const unread = `package UP { ${P}
    part p : P2;
    requirement def R { subject p : P2; assume constraint { p.e >= 10.0 } require constraint { p.k <= 1.0 } }
    satisfy R by p; }`;
    for (const engine of ['smt', 'literal'] as const) {
      const r = await verifyOne(unread, { engine });
      expect([r.by('p.k <= 1.0').claim, r.exitCode], engine).toEqual(['vacuous', 2]);
    }
  });

  withZ3('a requirement the value read in its context violates is refuted, under --allow-inconclusive too', async () => {
    const text = `package CF { ${P}
    part p : P2;
    requirement def R { subject p : P2; require constraint { p.e <= 1.0 } }
    satisfy R by p; }`;
    for (const engine of ['smt', 'literal'] as const) {
      const r = await verifyOne(text, { engine, allowInconclusive: true });
      const row = r.by('p.e <= 1.0');
      expect([row.claim, row.code, r.exitCode], engine).toEqual(['refuted', 'verification/refuted', 1]);
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
    part def P { attribute a default = 2.0; attribute e; assert constraint d { e == a * 3.0 } }
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
    expect([r.consistent, r.inconsistent, r.exitCode]).toEqual([0, 1, 1]);
  });

  withZ3('consistency decides the set over the values its contexts read, each instance by its own symbols', async () => {
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
    // [consistent, inconsistent, exit] without values, then at the model's values.
    const expected: Record<string, Array<[number, number, number]>> = {
      // P2's e is 8: `p.e <= 1.0` holds of some design, and not at the model's values.
      clause: [
        [1, 0, 0],
        [0, 1, 1],
      ],
      // q's p's `cap` makes its x at most 0.5, against the requirement's 1; at
      // the model's values (x = 4) the axioms themselves collide.
      axiom: [
        [0, 1, 1],
        [0, 0, 2],
      ],
      // s's g is 2 × 8.
      value: [
        [1, 0, 0],
        [0, 1, 1],
      ],
    };
    for (const [name, text] of Object.entries(cases)) {
      for (const [i, withValues] of [false, true].entries()) {
        const r = await consistencyReport(await contextModel(text, name), {
          withValues,
          allowInconclusive: true,
          sourceText: text,
        });
        expect([r.consistent, r.inconsistent, r.exitCode], `${name}, withValues ${withValues}`).toEqual(expected[name]![i]);
        expect(r.groups.map((g) => g.code), name).not.toContain('verification/not-evaluable');
      }
    }
    // Read where nothing is redefined, the clause set is inconsistent — exit 1.
    // (Without P2 at all: renamed `P`, it is a second P that specialises the
    // first and redefines its x, a context P's assert is read in anew.)
    const read = cases.clause.replace(/part def P2 :> P \{[^}]*\}/, '').replaceAll('P2', 'P');
    const r = await consistencyReport(await contextModel(read, 'CR'), { withValues: true, sourceText: read });
    expect([r.inconsistent, r.exitCode]).toEqual([1, 1]);
  });

  withZ3('bounds reads a measure over the instances that read it, each by its own symbols', async () => {
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
    // P's own x, bounded by B's assert read in B2: p's e, over B2's x, is
    // another instance's, and tightens nothing of P's.
    expect([withReq.bounds.map((b) => [b.outcome, b.value]), withReq.exitCode]).toEqual([[['optimum', 100]], 0]);
    const ax = `package BA { ${P}
    part def Q { part p : P2; assert constraint cap { p.e <= 1.0 } }
    part q : Q; }`;
    const axiom = await boundsReport(await contextModel(ax, 'BA'), {
      measure: 'BA::P::x',
      sense: 'max',
      freeAll: true,
      sourceText: ax,
    });
    // q's p's `cap` pins q's p's x: nothing pins P's own.
    expect([axiom.bounds.map((b) => b.outcome), axiom.exitCode]).toEqual([['unbounded'], 0]);
  });

  withZ3('refine reads a contract over an unread value as the feature it names', async () => {
    const pack = (top: string, cell: string) => `package RF {
    part def Cell {
      attribute x : ScalarValues::Real default = 3.0;
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

  withZ3('an inherited calculation is read in the usage that redefines its input, over the usage’s names', async () => {
    const text = `package A11 {
    part def P { attribute load default = 1.0; calc margin { 10.0 - load } }
    part p : P { attribute :>> load = 50.0; constraint c { margin >= 0.0 } } }`;
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyOne(text, { engine });
      const row = r.by('margin >= 0.0');
      expect([row.claim, r.exitCode], engine).toEqual(['refuted', 1]);
      expect(row.detail, engine).toContain('(-40 vs 0');
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
    part def P { attribute base default = 1.0; attribute load = base * 5.0; calc margin { 10.0 - load } }
    part p : P { attribute base :>> base = 4.0; constraint ok { margin >= 0.0 } } }`;
    // p's load is 4 × 5: its margin −10.
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyOne(deep, { engine });
      expect([r.by('margin >= 0.0').claim, r.exitCode], engine).toEqual(['refuted', 1]);
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

/**
 * What a STRICT ordering between two equal quantities reads as on the SMT
 * engine: a refutation, confirmed. The evaluators once read a tie within
 * their tolerance as equal for every operator — the strict ones satisfied —
 * and the witness gate declined (`d568a1f`); they decide a tie by the
 * decimals written now (the tie rule), as the encoder does. The one place
 * the information-unit cases below state it.
 */
const AT_A_STRICT_TIE = { claim: 'refuted', code: 'verification/refuted' };

/*
 * A VALUE IN A UNIT OF DIMENSION ONE WITH A FACTOR — B, GiB, Hart, nat, mm/m —
 * IS THE MAGNITUDE IT STATES, on every SMT command. Its value axiom was scaled
 * as an author's `==` is (the gates refuse a scale only against a DIMENSIONED
 * operand), so `cap = 2.0 [GiB]` was pinned to 2 bits: `verify` proved `cap <
 * 2.0 [GiB]` and `cap < 1.0 [GiB]` beside a `bind`, `consistency --with-values`
 * called `cap >= 1.0 [GiB]` inconsistent and `cap <= 1.0 [GiB]` consistent,
 * and `bounds` printed 2.3e-10 GiB. A unit written beside an EXPRESSION value
 * (`(k * 2.0) [GiB]`, `(d1 / d2) [km]`) was dropped from the joining equality
 * the same way; and `(cap * 2.0) [GiB]`, which puts a unit on bits, was read as
 * 2^35 GiB everywhere. The registry round trip is every unit the registry
 * names, prefixed every way it allows.
 */
describe('a value stored in a dimension-one unit with a factor is the magnitude it states, on every command', () => {
  const mem = (pkg: string, attrs: string, ...goals: string[]) => `package ${pkg} {
    part def Mem { attribute cap : ISQ::StorageCapacityValue = 2.0 [GiB]; ${attrs} }
    part m : Mem;
    ${goals.map((g, i) => `requirement def R${i} { subject m : Mem; require constraint { ${g} } } satisfy R${i} by m;`).join('\n    ')}
}`;

  withZ3('verify proves what 2 GiB is, refutes what it is not, and reads the strict tie as kg does', async () => {
    const holds = ['m.cap <= 2.0 [GiB]', 'm.cap == 2048.0 [MiB]', 'm.cap >= 17179869184.0 [bit]', 'm.cap > 2.0 [GB]'];
    for (const engine of ['smt', 'literal'] as const) {
      const ok = await verifyOne(mem('IP', '', ...holds), { engine });
      for (const g of holds) {
        expect(ok.by(g).claim, `${engine}: ${g}`).toBe(engine === 'smt' ? 'proved' : 'holds-at-values');
      }
      expect(ok.exitCode, engine).toBe(0);
      const no = await verifyOne(mem('IR', '', 'm.cap < 1.0 [GiB]'), { engine });
      expect([no.by('m.cap < 1.0 [GiB]').claim, no.exitCode], engine).toEqual(['refuted', 1]);
    }
    const tie = await verifyOne(mem('IT', '', 'm.cap < 2.0 [GiB]'), { engine: 'smt' });
    expect(tie.by('m.cap < 2.0 [GiB]')).toMatchObject(AT_A_STRICT_TIE);
    const kg = await verifyOne(
      `package KT { part def Mem { attribute cap : ISQ::MassValue = 2.0 [kg]; } part m : Mem;
    requirement def R { subject m : Mem; require constraint { m.cap < 2.0 [kg] } } satisfy R by m; }`,
      { engine: 'smt' },
    );
    expect(kg.by('m.cap < 2.0 [kg]')).toMatchObject(AT_A_STRICT_TIE);
    // Through a `bind`, which copies the stored value: 2 GiB is not under 1 GiB.
    const bound = await verifyOne(
      mem('IB', 'attribute mirror : ISQ::StorageCapacityValue; bind mirror = cap;', 'm.mirror < 1.0 [GiB]'),
      { engine: 'smt' },
    );
    expect(bound.by('m.mirror < 1.0 [GiB]').claim).not.toBe('proved');
  });

  withZ3('a release elsewhere does not make 2 bytes at most 2 bits', async () => {
    const text = `package IF {
    part def Mem { attribute cap : ISQ::StorageCapacityValue = 2.0 [B]; attribute k : ScalarValues::Real = 5.0; }
    part m : Mem;
    requirement def R { subject m : Mem; assume constraint { m.k >= 0.0 and m.k <= 10.0 } require constraint { m.cap <= 2.0 [bit] } }
    satisfy R by m; }`;
    const r = await verifyOne(text, { engine: 'smt', free: ['m.k'] });
    expect([r.by('m.cap <= 2.0 [bit]').claim, r.exitCode]).toEqual(['design-admitted', 2]);
  });

  withZ3('consistency at the model’s values reads 2 GiB, and bounds prints it', async () => {
    const consistent = await consistencyReport(await contextModel(mem('IC', '', 'm.cap >= 1.0 [GiB]'), 'IC'), {
      withValues: true,
    });
    expect([consistent.consistent, consistent.inconsistent, consistent.exitCode]).toEqual([1, 0, 0]);
    const missed = await consistencyReport(await contextModel(mem('IM', '', 'm.cap <= 1.0 [GiB]'), 'IM'), {
      withValues: true,
    });
    expect([missed.consistent, missed.inconsistent, missed.exitCode]).toEqual([0, 1, 1]);
    const m = await contextModel(mem('IX', 'attribute total = cap * 2.0;', 'm.cap >= 1.0 [GiB]'), 'IX');
    const cap = await boundsReport(m, { measure: 'm.cap', sense: 'max' });
    expect([cap.bounds.map((b) => [b.outcome, b.value]), cap.exitCode]).toEqual([[['optimum', 2]], 0]);
    // A derived value declares no unit, so it is printed in bits: 2^35.
    const total = await boundsReport(m, { measure: 'm.total', sense: 'max' });
    expect([total.bounds.map((b) => [b.outcome, b.value]), total.exitCode]).toEqual([[['optimum', 34359738368]], 0]);
  });

  withZ3('a value written `(expr) [unit]` is `expr` in that unit, on every command', async () => {
    const lifted = mem(
      'IL',
      'attribute k : ScalarValues::Real = 3.0; attribute total : ISQ::StorageCapacityValue = (k * 2.0) [GiB];',
    );
    const proved = await verifyOne(
      mem(
        'ILP',
        'attribute k : ScalarValues::Real = 3.0; attribute total : ISQ::StorageCapacityValue = (k * 2.0) [GiB];',
        'm.total == 6.0 [GiB]',
      ),
      { engine: 'smt' },
    );
    expect([proved.by('m.total == 6.0 [GiB]').claim, proved.exitCode]).toEqual(['proved', 0]);
    const total = await boundsReport(await contextModel(lifted, 'IL'), { measure: 'm.total', sense: 'max' });
    expect([total.bounds.map((b) => [b.outcome, b.value]), total.exitCode]).toEqual([[['optimum', 6]], 0]);
    const under = mem(
      'ILU',
      'attribute k : ScalarValues::Real = 3.0; attribute total : ISQ::StorageCapacityValue = (k * 2.0) [GiB];',
      'm.total < 1.0 [GiB]',
    );
    const r = await consistencyReport(await contextModel(under, 'ILU'), { withValues: true });
    expect([r.consistent, r.inconsistent, r.exitCode]).toEqual([0, 1, 1]);
    // Dimensioned: the ratio is 2000, in km — not `d1` read in its stored km.
    const ratio = `package IK {
    part def V { attribute d1 : ISQ::LengthValue = 2.0 [km]; attribute d2 : ISQ::LengthValue = 1.0 [m];
      attribute lenMeasure : ISQ::LengthValue = (d1 / d2) [km]; }
    part v : V;
    requirement def R { subject v : V; require constraint { v.lenMeasure <= 10.0 [km] } } satisfy R by v; }`;
    const k = await consistencyReport(await contextModel(ratio, 'IK'), { withValues: true });
    expect([k.consistent, k.inconsistent, k.exitCode]).toEqual([0, 1, 1]);
    const len = await verifyOne(ratio, { engine: 'smt' });
    expect([len.by('v.lenMeasure <= 10.0 [km]').claim, len.exitCode]).toEqual(['refuted', 1]);
  });

  withZ3('a value that puts a unit on bits is refused, never read as 2^35 GiB', async () => {
    const dbl = 'attribute dbl : ISQ::StorageCapacityValue = (cap * 2.0) [GiB];';
    const sentence =
      '"m.dbl" cannot be derived: a unit literal [GiB] was applied to an operand computed from a value in "GiB" — dimension one is not unitless';
    for (const engine of ['smt', 'literal'] as const) {
      const r = await verifyOne(mem('RL', dbl, 'm.dbl == 4.0 [GiB]', 'm.dbl > 1000.0 [GiB]'), { engine });
      for (const g of ['m.dbl == 4.0 [GiB]', 'm.dbl > 1000.0 [GiB]']) {
        expect(r.by(g), `${engine}: ${g}`).toMatchObject({ claim: 'inconclusive', code: 'verification/not-evaluable' });
        expect(r.by(g).detail, `${engine}: ${g}`).toContain(sentence);
      }
      expect(r.exitCode, engine).toBe(2);
    }
    const m = await contextModel(mem('RB', dbl, 'm.dbl == 4.0 [GiB]'), 'RB');
    const b = await boundsReport(m, { measure: 'm.dbl', sense: 'max' });
    expect([b.bounds.map((x) => x.outcome), b.exitCode]).toEqual([['inconclusive'], 2]);
    const c = await consistencyReport(m, { withValues: true });
    expect([c.consistent, c.inconsistent, c.exitCode]).toEqual([0, 0, 2]);
  });

  /*
   * The same relabel where the model's point does not show it: with an input
   * the model gives no value, the evaluator merely has no value for the
   * feature, and the axiom joined `(cap * k) [GiB]` as 2^34·k GiB — `verify`
   * PROVED `dbl >= 1000.0 [GiB]` from `k >= 1.0` (and from a plain `k == 3.0`,
   * and over an `if` on a valueless Boolean), `consistency --with-values`
   * called `tot <= 10.0 [GiB]` INCONSISTENT for `tot = (cap + k) [GiB]`, and
   * `bounds` printed its min as 17179869184 GiB "exactly". The join is decided
   * for every value of the free inputs and both branches.
   */
  withZ3('a value that puts a unit on bits for SOME value of a free input is refused, not proved', async () => {
    const shapes: Array<[string, string]> = [
      ['attribute k : ScalarValues::Real; assert constraint kpos { k >= 1.0 }', '(cap * k) [GiB]'],
      ['attribute k : ScalarValues::Real; constraint pin { k == 3.0 }', '(cap * k) [GiB]'],
      ['attribute big : ScalarValues::Boolean;', '(if big then cap * 1.0 else cap * 2.0) [GiB]'],
      ['attribute y : ISQ::StorageCapacityValue; assert constraint ylo { y >= cap }', '(y) [GiB]'],
    ];
    for (const [i, [inputs, value]] of shapes.entries()) {
      const text = mem(`FV${i}`, `${inputs} attribute dbl : ISQ::StorageCapacityValue = ${value};`, 'm.dbl >= 1000.0 [GiB]');
      const r = await verifyOne(text, { engine: 'smt' });
      expect([r.by('m.dbl >= 1000.0 [GiB]').claim, r.exitCode], value).toEqual(['inconclusive', 2]);
    }
    const m = await contextModel(
      mem(
        'FL',
        'attribute k : ScalarValues::Real; assert constraint kpos { k >= 0.0 } attribute tot : ISQ::StorageCapacityValue = (cap + k) [GiB];',
        'm.tot <= 10.0 [GiB]',
      ),
      'FL',
    );
    const c = await consistencyReport(m, { withValues: true });
    expect([c.inconsistent, c.exitCode]).toEqual([0, 2]);
    const b = await boundsReport(m, { measure: 'm.tot', sense: 'min' });
    expect([b.bounds.map((x) => x.outcome), b.exitCode]).toEqual([['inconclusive'], 2]);
    // A number for every value of the free input is still joined, and proved.
    const number = await verifyOne(
      mem(
        'FN',
        `attribute k : ScalarValues::Real; assert constraint kpos { k >= 3.0 }
      attribute total : ISQ::StorageCapacityValue = (k * 2.0) [GiB];
      attribute y : ISQ::StorageCapacityValue; assert constraint ylo { y >= cap }
      attribute z : ISQ::StorageCapacityValue = (y / 1.0 [GiB]) [GiB];`,
        'm.total >= 6.0 [GiB]',
        'm.z >= 2.0 [GiB]',
      ),
      { engine: 'smt' },
    );
    expect([number.by('m.total >= 6.0 [GiB]').claim, number.by('m.z >= 2.0 [GiB]').claim, number.exitCode]).toEqual([
      'proved',
      'proved',
      0,
    ]);
  });

  withZ3('information over a ratio of lengths is still information, not a number to relabel', async () => {
    // One power of GiB and one of mm/m summed to zero: `x` read 2^34 / 0.002
    // bit as 8.6e12 GiB, where the quantity is 1000 GiB, and the SMT engine
    // PROVED `x > 1.0E12 [GiB]` and refuted `x < 2000.0 [GiB]`.
    const text = mem(
      'XK',
      'attribute strain : ScalarValues::Real = 2.0 [mm/m]; attribute x : ISQ::StorageCapacityValue = (cap / strain) [GiB];',
      'm.x < 2000.0 [GiB]',
      'm.x > 1.0E12 [GiB]',
    );
    for (const engine of ['smt', 'literal'] as const) {
      const r = await verifyOne(text, { engine });
      for (const g of ['m.x < 2000.0 [GiB]', 'm.x > 1.0E12 [GiB]']) {
        expect(r.by(g).claim, `${engine}: ${g}`).toBe('inconclusive');
      }
      expect(r.exitCode, engine).toBe(2);
    }
    const m = await contextModel(text, 'XK');
    expect(checkConstraints(m).map((x) => x.result)).toEqual(['unknown', 'unknown']);
    expect(checkConstraintsNumeric(m).map((x) => x.result)).toEqual(['unknown', 'unknown']);
  });

  withZ3(
    'the information and ratio ties: equal is proved, unequal refuted, and a strict tie read as kg reads it',
    async () => {
      const PAIRS: Array<[string, string, string, string]> = [
        ['1.0', 'GiB', '8589934592.0', 'bit'],
        ['1.0', 'KiB', '1024.0', 'B'],
        ['1.0', 'kHart', '1000.0', 'Hart'],
        ['1000000.0', 'mm/m', '1.0', 'km/m'],
      ];
      const EXPECT: Record<string, { claim: string; code?: string }> = {
        '<=': { claim: 'proved' },
        '==': { claim: 'proved' },
        '>=': { claim: 'proved' },
        '!=': { claim: 'refuted' },
        '<': AT_A_STRICT_TIE,
        '>': AT_A_STRICT_TIE,
      };
      for (const [a, A, b, B] of PAIRS) {
        // Three shapes: the stored value against a literal, a literal against
        // the stored value, and two stored values.
        const goals: string[] = [];
        for (const op of Object.keys(EXPECT)) {
          goals.push(`p.x ${op} ${b} ['${B}']`, `${a} ['${A}'] ${op} p.y`, `p.x ${op} p.y`);
        }
        const text = `package TI {
    part def P { attribute x = ${a} ['${A}']; attribute y = ${b} ['${B}']; }
    part p : P;
    ${goals.map((g, i) => `requirement def R${i} { subject p : P; require constraint { ${g} } } satisfy R${i} by p;`).join('\n    ')}
}`;
        const r = await verifyOne(text, { engine: 'smt' });
        for (const [i, g] of goals.entries()) {
          const op = Object.keys(EXPECT)[Math.floor(i / 3)]!;
          expect(r.by(g), `${A}/${B}: ${g}`).toMatchObject(EXPECT[op]!);
        }
      }
    },
  );

  /*
   * The round trip declares ~1 200 features in the one z3 context this process
   * shares, and every check after it pays for them (the tie matrix above ran
   * ten times slower behind it): the block hands the next one a fresh module.
   */
  describe('the registry round trip', () => {
    afterAll(() => resetZ3Cache({ terminate: true }));

    /** Every unit a value can be written in: each registry row, each prefix it allows, and the dimension-one ratios. */
    const everyUnit = (): string[] => {
      const out: string[] = [];
      for (const u of UNIT_REGISTRY) {
        out.push(u.symbol);
        const prefixes = [...(u.prefixable ? SI_PREFIXES : []), ...(u.binaryPrefixable ? BINARY_PREFIXES : [])];
        for (const p of prefixes) {
          if (resolveUnit(`${p.symbol}${u.symbol}`)?.name === `${p.name}${u.name}`) out.push(`${p.symbol}${u.symbol}`);
        }
      }
      return [...out, 'km/m', 'mm/m', 'g/kg', 'min/s', 'L/m^3', 'B/bit', 'kWh/J', 'mi/km', 'lb/kg'];
    };
    const OFFSET = new Set(['°C', '°F']);

    /*
     * One relation per operator, conjoined over every unit, so that ~600 units
     * cost three proofs: a conjunction is proved exactly when each conjunct is,
     * and satisfied exactly when each is.
     */
    for (const [form, value] of [
      ['1.0 [u]', (u: string) => `1.0 ['${u}']`],
      ['(k * 2.0) [u]', (u: string) => `(k * 2.0) ['${u}']`],
    ] as const) {
      withZ3(`round trip, every unit: \`x = ${form}\` against \`1.0 [u]\` holds on all four surfaces`, async () => {
        const units = everyUnit().filter((u) => !OFFSET.has(u));
        expect(units.length).toBeGreaterThan(600);
        const goals = ['==', '<=', '>='].map((op) => units.map((u, i) => `x${i} ${op} 1.0 ['${u}']`).join(' and '));
        const text = [
          'package RT {',
          '    attribute k : ScalarValues::Real = 0.5;',
          ...units.map((u, i) => `    attribute x${i} = ${value(u)};`),
          ...goals.map((g, j) => `    constraint c${j} { ${g} }`),
          '}',
        ].join('\n');
        const m = await contextModel(text, 'RT');
        const all = ['satisfied', 'satisfied', 'satisfied'];
        expect(checkConstraints(m).map((c) => c.result), form).toEqual(all);
        expect(checkConstraintsNumeric(m).map((c) => c.result), form).toEqual(all);
        for (const [engine, claim] of [
          ['literal', 'holds-at-values'],
          ['smt', 'proved'],
        ] as const) {
          const r = await verifyModel(m, { engine, sourceText: text });
          expect([r.results.map((x) => x.claim), r.exitCode], `${form}, ${engine}`).toEqual([[claim, claim, claim], 0]);
        }
      });
    }

    withZ3('round trip on an offset scale: held by the evaluators, undecided on the SMT engine, never refuted', async () => {
      for (const u of OFFSET) {
        for (const value of [`1.0 ['${u}']`, `(k * 2.0) ['${u}']`]) {
          const text = `package RO {
    attribute k : ScalarValues::Real = 0.5;
    attribute x = ${value};
    constraint lo { x <= 1.0 ['${u}'] }
    constraint hi { x >= 1.0 ['${u}'] }
}`;
          const m = await contextModel(text, 'RO');
          expect(checkConstraints(m).map((c) => c.result), value).toEqual(['satisfied', 'satisfied']);
          const smt = await verifyModel(m, { engine: 'smt', sourceText: text });
          expect(smt.results.map((x) => x.claim), value).toEqual(['inconclusive', 'inconclusive']);
        }
      }
    });
  });
});

/*
 * PLAIN NUMERALS ARE THE DECIMALS WRITTEN, on every command and every surface.
 * Read as the doubles they parse to wherever no quantity met them, `0.1 + 0.2
 * > 0.3` was PROVED (exit 0), `0.1 + 0.2 == 0.3` was undecided and
 * inconsistent with the model's own values, `refine` refuted `x <= 0.1, y <=
 * 0.2 ⇒ x + y <= 0.3` over a witness it "confirmed", `bounds` printed
 * 0.30000000000000004 as an optimum, and a dimensioned requirement over one
 * more feature flipped a verdict. The evaluators read a tie within their
 * relative tolerance as equal for every operator, so a false tie was held
 * undecided on the SMT engine; they decide it by the decimals now (the tie
 * rule), and a false tie is refuted on every surface, a true sum confirmed.
 */
describe('0.1 + 0.2 is 0.3 over plain numbers, on every command', () => {
  const F = 'attribute f : ScalarValues::Real = 0.1;';
  const plain = (pkg: string, attrs: string, body: string, extra = '') => `package ${pkg} {
    part def P { ${attrs} }
    part p : P;
    requirement def R { subject p : P; ${body} }
    ${extra}
    satisfy R by p; }`;
  const X = (value: string) => `attribute x : ScalarValues::Real = ${value};`;
  const ABSORBED = 'attribute a : ScalarValues::Real = 10000000000000000.0; attribute x : ScalarValues::Real = a + 1.0;';
  /** [attributes, goal, SMT claim, exit code], against the decimals' exact arithmetic. */
  const ROWS: Array<[string, string, 'proved' | 'refuted', number]> = [
    [F, 'p.f + 0.2 == 0.3', 'proved', 0],
    [F, 'p.f + 0.2 <= 0.3', 'proved', 0],
    [F, 'p.f + 0.2 >= 0.3', 'proved', 0],
    [F, 'p.f + 0.2 != 0.3', 'refuted', 1],
    // False of the decimals, at a tie binary64 rounds: refuted, never proved.
    [F, 'p.f + 0.2 > 0.3', 'refuted', 1],
    [F, 'p.f + 0.2 < 0.3', 'refuted', 1],
    // An exact tie under a strict ordering is the boundary, not inside it.
    [X('25.0'), 'p.x < 25.0', 'refuted', 1],
    // A near miss is no tie to the decimals: 0.9999999999 < 1.0 is true, and
    // it is not at least 1.0.
    [X('0.9999999999'), 'p.x < 1.0', 'proved', 0],
    [X('0.9999999999'), 'p.x >= 1.0', 'refuted', 1],
    // A derived value is its definition over the decimals.
    [`${F} attribute y : ScalarValues::Real = f * 3.0;`, 'p.y == 0.3', 'proved', 0],
    [`${F} attribute y : ScalarValues::Real = f * 3.0;`, 'p.y <= 0.3', 'proved', 0],
    // 640/650 · 3600 is 3544.615384615…, which no 11-digit decimal is.
    [
      'attribute c : ScalarValues::Real = 640.0; attribute w : ScalarValues::Real = 650.0; ' +
        'attribute e : ScalarValues::Real = c / w * 3600.0;',
      'p.e != 3544.6153846',
      'proved',
      0,
    ],
    // binary64 absorbs 1e-17 into 1.0, and 1 into 1e16; the decimals do not.
    [X('1.0 + 0.00000000000000001'), 'p.x > 1.0', 'proved', 0],
    [X('1.0 + 0.00000000000000001'), 'p.x == 1.0', 'refuted', 1],
    [X('1.0 + 0.00000000000000001'), 'p.x <= 1.0', 'refuted', 1],
    [ABSORBED, 'p.x > p.a', 'proved', 0],
    [ABSORBED, 'p.x == p.a', 'refuted', 1],
  ];
  for (const [i, [attrs, goal, claim, exitCode]] of ROWS.entries()) {
    withZ3(`verify: \`${goal}\` over \`${attrs}\` is ${claim}, and every surface agrees`, async () => {
      const text = plain(`PN${i}`, attrs, `require constraint { ${goal} }`);
      const r = await verifyOne(text, { engine: 'smt' });
      const row = r.by(goal);
      expect([row.claim, r.exitCode], `${goal}: ${row.detail}`).toEqual([claim, exitCode]);
      // The validation surface, the numeric surface and the literal engine
      // read the same relation the same way, decided by the same decimals.
      const model = await contextModel(text, `PN${i}`);
      const same = (expression: string) => expression.replace(/\s+/g, ' ').trim() === goal;
      const reading = claim === 'proved' ? 'satisfied' : 'violated';
      const check = checkConstraints(model).find((c) => same(c.expression));
      const numeric = checkConstraintsNumeric(model).find((c) => same(c.raw));
      expect([check?.result, numeric?.result], `${goal}: ${check?.message}`).toEqual([reading, reading]);
      const literal = await verifyOne(text, { engine: 'literal' });
      expect([literal.by(goal).claim, literal.exitCode], goal).toEqual([
        claim === 'proved' ? 'holds-at-values' : 'refuted',
        exitCode,
      ]);
      // And `solveFeasible` does not call a model feasible that a stated bound breaks.
      if (/[<>]/.test(goal) && !goal.includes('!=')) {
        expect(solveFeasible(model).feasible, goal).toBe(claim === 'proved');
      }
    });
  }

  // A value a solve produced is known to the solve's tolerance and no closer:
  // a strict ordering or a `!=` inside it turns on a difference the solve does
  // not know. Read as a tie there, `p.x < 0.1000005` at a solved 0.1 was
  // violated and infeasible beside an SMT proof. (A value a BINDING carries —
  // `bind b = a` over `a = 0.1` — is read exactly by F5's per-instance reading,
  // so its strict ordering is decided, not a tie.)
  const SOLVED = 'attribute x : ScalarValues::Real; assert constraint { x * 3.0 == 0.3 }';
  const SOLVED_SMALL = 'attribute x : ScalarValues::Real; assert constraint { x * 10000000.0 == 1.0 }';
  const UNDECIDED: Array<[string, string]> = [
    [SOLVED, 'p.x < 0.1000005'],
    [SOLVED, 'p.x != 0.1000005'],
    [SOLVED_SMALL, 'p.x < 0.0000005'],
  ];
  for (const [i, [attrs, goal]] of UNDECIDED.entries()) {
    withZ3(`verify: \`${goal}\` over a value the solve gives is proved, and no surface reads it violated`, async () => {
      const text = plain(`SV${i}`, attrs, `require constraint { ${goal} }`);
      const r = await verifyOne(text, { engine: 'smt' });
      expect([r.by(goal).claim, r.exitCode], r.by(goal).detail).toEqual(['proved', 0]);
      const model = await contextModel(text, `SV${i}`);
      const numeric = checkConstraintsNumeric(model).find((c) => c.raw.replace(/\s+/g, ' ').trim() === goal);
      expect(numeric?.result, goal).toBe('unknown');
      expect(numeric?.reason, goal).toMatch(/known only to that tolerance/);
      const f = solveFeasible(model);
      expect([f.feasible, f.decided, f.violations], goal).toEqual([true, false, []]);
      expect(analysisReport(model).feasible, goal).not.toBe(false);
    });
  }

  withZ3('verify: the reading does not depend on what else the run reads', async () => {
    const goal = 'p.f + 0.2 > 0.3';
    const attrs = `${F} attribute mass : ISQ::MassValue = 1.0 [kg];`;
    const alone = await verifyOne(plain('GA', attrs, `require constraint { ${goal} }`), { engine: 'smt' });
    const linked = await verifyOne(
      plain(
        'GL',
        attrs,
        `require constraint { ${goal} }`,
        'requirement def R2 { subject p : P; require constraint { p.f * p.mass <= 1.0 [kg] } } satisfy R2 by p;',
      ),
      { engine: 'smt' },
    );
    expect([alone.by(goal).claim, linked.by(goal).claim]).toEqual(['refuted', 'refuted']);
    // And an assumption over a feature with no value does not hold at the
    // model's values: no refutation there, and no proof.
    const freed = await verifyOne(
      plain(
        'UF',
        `${F} attribute u : ScalarValues::Real;`,
        `assume constraint { p.u >= 0.0 and p.u <= 1.0 } require constraint { ${goal} }`,
      ),
      { engine: 'smt' },
    );
    expect([freed.by(goal).claim, freed.exitCode]).toEqual(['inconclusive', 2]);
  });

  withZ3('consistency at the model’s values reads the decimals', async () => {
    const consistency = async (pkg: string, body: string, withValues = true) => {
      const text = plain(pkg, `attribute a : ScalarValues::Real = 0.1; attribute b : ScalarValues::Real = 0.2;`, body);
      const r = await consistencyReport(await contextModel(text, pkg), { withValues, sourceText: text });
      return [r.consistent, r.inconsistent, r.inconclusive, r.exitCode];
    };
    // The true sum was called INCONSISTENT with the values that make it true,
    // and then undecided: the solver's point was the model's own, and the
    // witness re-read compared it in binary64. It reads z3's rationals and
    // the decimals now, and confirms it.
    expect(await consistency('CE', 'require constraint { p.a + p.b == 0.3 }')).toEqual([1, 0, 0, 0]);
    expect(await consistency('CP', 'require constraint { p.a + p.b <= 0.3 and p.a + p.b >= 0.3 }')).toEqual([
      1, 0, 0, 0,
    ]);
    // And the false one was called CONSISTENT.
    expect(await consistency('CN', 'require constraint { p.a + p.b != 0.3 }')).toEqual([0, 1, 0, 1]);
    // With the values released the one point z3 can choose is `a` = one
    // tenth, at which binary64 does not make the sum 0.3 (read in binary64, z3
    // chose 0.09999999999999998 and the set was confirmed consistent); read
    // as the rational it is, it does.
    expect(await consistency('CR', 'require constraint { p.a + 0.2 == 0.3 }', false)).toEqual([1, 0, 0, 0]);
  });

  withZ3('refine: x <= 0.1 and y <= 0.2 refine x + y <= 0.3', async () => {
    const text = `package RP {
    part def A { attribute x : ScalarValues::Real; }
    part def B { attribute y : ScalarValues::Real; }
    part def Sys { part a : A; part b : B; }
    requirement def Top { subject s : Sys; require constraint { s.a.x + s.b.y <= 0.3 } }
    requirement def AReq { subject a : A; require constraint { a.x <= 0.1 } }
    requirement def BReq { subject b : B; require constraint { b.y <= 0.2 } }
    satisfy Top by Sys; satisfy AReq by Sys::a; satisfy BReq by Sys::b; }`;
    const r = await refinementReport(await contextModel(text, 'RP'), { sourceText: text });
    expect([r.refined, r.notRefined, r.exitCode]).toEqual([1, 0, 0]);
  });

  withZ3('bounds: f + 0.2 is three tenths exactly', async () => {
    const text = plain('BP', `${F} attribute g : ScalarValues::Real = f + 0.2;`, 'require constraint { p.g <= 0.3 }');
    const r = await boundsReport(await contextModel(text, 'BP'), { measure: 'p.g', sense: 'both', sourceText: text });
    expect([r.bounds.map((b) => [b.outcome, b.value, b.term]), r.exitCode]).toEqual([
      [
        ['optimum', 0.3, '(/ 3.0 10.0)'],
        ['optimum', 0.3, '(/ 3.0 10.0)'],
      ],
      0,
    ]);
  });
});

/*
 * A NUMERAL WRITTEN PAST 15 SIGNIFICANT DIGITS IS THE DOUBLE IT PARSES TO, on
 * every SMT command: the double does not determine the decimal written there,
 * and it is the number every binary64 surface holds. Read as the shorter
 * decimal that double prints as (`0.29999999999999999` as three tenths), it
 * was neither, and beside decimals it PROVED `0.1 + 0.2 <= 0.29999999999999999`,
 * proved `f + 0.2 <= 0.3` at `f = 0.10000000000000001`, called `f + 0.2 > 0.3`
 * inconsistent with that value, and refined `x + y <= 0.29999999999999999`
 * from `x <= 0.1` and `y <= 0.2`. A value axiom read the print while a
 * `[unit]` literal read its text, so `m == 0.30000000000000001 [kg]` was
 * inconsistent with the very value that states it.
 */
describe('a numeral past 15 significant digits is its double, on every command', () => {
  const plain = (pkg: string, attrs: string, goal: string) => `package ${pkg} {
    part def P { ${attrs} }
    part p : P;
    requirement def R { subject p : P; require constraint { ${goal} } }
    satisfy R by p; }`;
  const F = 'attribute f : ScalarValues::Real';
  const M = 'attribute m : ISQ::MassValue = 0.30000000000000001 [kg];';
  /** [attributes, goal, SMT claim, exit code, `consistency --with-values` verdict]. */
  const ROWS: Array<[string, string, string, number, 'consistent' | 'inconsistent']> = [
    [`${F} = 0.1;`, 'p.f + 0.2 <= 0.29999999999999999', 'refuted', 1, 'inconsistent'],
    [`${F} = 0.10000000000000001;`, 'p.f + 0.2 <= 0.3', 'refuted', 1, 'inconsistent'],
    [`${F} = 0.10000000000000001;`, 'p.f + 0.2 > 0.3', 'proved', 0, 'consistent'],
    // 0.30000000000000001 parses to 0.299999999999999988897…, below three tenths.
    [`${F} = 0.1;`, 'p.f + 0.2 >= 0.30000000000000001', 'proved', 0, 'consistent'],
    [M, 'p.m == 0.30000000000000001 [kg]', 'proved', 0, 'consistent'],
    [M, 'p.m != 0.30000000000000001 [kg]', 'refuted', 1, 'inconsistent'],
  ];
  for (const [i, [attrs, goal, claim, exitCode, verdict]] of ROWS.entries()) {
    withZ3(`\`${goal}\` over \`${attrs}\`: ${claim}, and ${verdict} at the values`, async () => {
      const text = plain(`LD${i}`, attrs, goal);
      const r = await verifyOne(text, { engine: 'smt' });
      const row = r.by(goal);
      expect([row.claim, r.exitCode], `${goal}: ${row.detail}`).toEqual([claim, exitCode]);
      const model = await contextModel(text, `LD${i}`);
      const check = checkConstraints(model).find((c) => c.expression.replace(/\s+/g, ' ').trim() === goal);
      if (claim === 'proved') expect(check?.result, goal).toBe('satisfied');
      if (claim === 'refuted') expect(check?.result, goal).toBe('violated');
      const c = await consistencyReport(model, { withValues: true, sourceText: text });
      expect([c.consistent, c.inconsistent, c.inconclusive]).toEqual(verdict === 'consistent' ? [1, 0, 0] : [0, 1, 0]);
    });
  }

  withZ3('refine: x <= 0.1 and y <= 0.2 do not refine x + y <= 0.29999999999999999', async () => {
    const text = `package RL {
    part def A { attribute x : ScalarValues::Real; }
    part def B { attribute y : ScalarValues::Real; }
    part def Sys { part a : A; part b : B; }
    requirement def Top { subject s : Sys; require constraint { s.a.x + s.b.y <= 0.29999999999999999 } }
    requirement def AReq { subject a : A; require constraint { a.x <= 0.1 } }
    requirement def BReq { subject b : B; require constraint { b.y <= 0.2 } }
    satisfy Top by Sys; satisfy AReq by Sys::a; satisfy BReq by Sys::b; }`;
    const r = await refinementReport(await contextModel(text, 'RL'), { sourceText: text });
    expect([r.refined, r.notRefined, r.exitCode]).toEqual([0, 1, 1]);
  });
});

describe('a relation nothing asserted stands a requirement set down, never a widened answer', () => {
  /** `g` is 3 at the model's values, by a remainder no gate encodes. */
  const MOD = (pkg: string, require: string, extra = '') => `package ${pkg} {
    part def P {
        attribute x : ScalarValues::Real = 7.0;
        attribute g : ScalarValues::Real = x % 4.0;
        attribute y : ScalarValues::Real = 5.0;
        attribute h : ScalarValues::Real = y % 2.0; ${extra}
    }
    part p : P;
    requirement def R { subject p : P; ${require} }
    satisfy R by p; }`;
  const consistency = async (text: string, name: string, withValues: boolean, allowInconclusive = false) =>
    consistencyReport(await contextModel(text, name), { withValues, allowInconclusive, sourceText: text });

  withZ3('a refused axiom the set reaches is undecided in both modes, and never forgiven', async () => {
    const cases = {
      // g = 3 violates it at the values; and NO x makes |x % 4| reach 5.
      value: MOD('CV', 'require constraint { p.g <= 1.0 }'),
      neverReached: MOD('CN', 'require constraint { p.g >= 5.0 }'),
      // The same definition written as an asserted equation, and a variable exponent.
      asserted: MOD('CA', 'require constraint { p.k <= 1.0 }', 'attribute k : ScalarValues::Real; assert constraint dk { k == x % 4.0 }'),
      power: MOD('CP', 'require constraint { p.q <= 1.0 }', 'attribute q : ScalarValues::Real = 2.0 ^ x;'),
      // Reached through an encoded equation, not directly.
      chained: MOD('CC', 'require constraint { p.c >= 5.0 }', 'attribute c : ScalarValues::Real = g + 0.0;'),
    };
    for (const [name, text] of Object.entries(cases)) {
      for (const withValues of [false, true]) {
        const r = await consistency(text, name, withValues, true);
        expect([r.consistent, r.groups[0].code, r.exitCode], `${name}, withValues ${withValues}`).toEqual([
          0,
          'verification/not-evaluable',
          2,
        ]);
        expect(r.groups[0].detail, name).toMatch(/but only without \d+ relation\(s\)/);
      }
    }
  });

  withZ3('a feature value no gate reads reaches its own feature and nothing else', async () => {
    // `mode = Mode::cruise` and `xs = (1.0, 2.0)` are refused unparseable, and
    // no requirement reads either feature: each is free to equal its value.
    for (const [pkg, decl] of [
      ['NE', 'attribute mode : Mode = Mode::cruise;'],
      ['NC', 'attribute xs : ScalarValues::Real[2] = (1.0, 2.0);'],
    ] as const) {
      const text = `package ${pkg} {
    enum def Mode { enum cruise; enum hover; }
    part def P { ${decl} attribute x : ScalarValues::Real = 2.0; }
    part p : P;
    requirement def R { subject s : P; require constraint { s.x <= 5.0 } }
    satisfy R by p; }`;
      const v = await verifyOne(text, { engine: 'smt' });
      expect([v.by('s.x <= 5.0').claim, v.exitCode], pkg).toEqual(['proved', 0]);
      const c = await consistency(text, pkg, true);
      expect([c.consistent, c.exitCode], pkg).toEqual([1, 0]);
    }
    // In a part no requirement reads, beside a requirement the values violate.
    const unrelated = `package NU {
    enum def Mode { enum cruise; enum hover; }
    part def Radio { attribute mode : Mode = Mode::cruise; }
    part def P { attribute x : ScalarValues::Real = 2.0; attribute y : ScalarValues::Real = 7.0; }
    part p : P;
    part radio : Radio;
    requirement def R { subject s : P; require constraint { s.x <= 5.0 } }
    requirement def R2 { subject s : P; require constraint { s.y <= 5.0 } }
    satisfy R by p; satisfy R2 by p; }`;
    const u = await verifyOne(unrelated, { engine: 'smt' });
    expect([u.by('s.x <= 5.0').claim, u.by('s.y <= 5.0').claim, u.exitCode]).toEqual(['proved', 'refuted', 1]);
    expect((await verifyOne(unrelated, { engine: 'literal' })).by('s.y <= 5.0').claim).toBe('refuted');
  });

  withZ3('a refused axiom the set does not reach changes nothing', async () => {
    // Neither `g = x % 4.0` nor `h = y % 2.0` reads `w`, so both factorise.
    const text = MOD('CU', 'require constraint { p.w <= 10.0 }', 'attribute w : ScalarValues::Real = 1.0;');
    for (const withValues of [false, true]) {
      const r = await consistency(text, 'CU', withValues);
      expect([r.groups[0].outcome, r.exitCode, r.refused]).toEqual(['consistent', 0, 2]);
    }
  });

  withZ3('the set’s own relation outside the fragment is undecided, forgivable only beside a decided set', async () => {
    const own = (x: string) => `package CO {
    part def P { attribute x : ScalarValues::Real = ${x}; }
    part def Q { attribute w : ScalarValues::Real = 1.0; }
    part p : P;
    part q : Q;
    requirement def R1 { subject p : P; require constraint { p.x <= 3.0 } }
    requirement def R2 { subject p : P; require constraint { p.x % 4.0 >= 2.0 } }
    requirement def R3 { subject q : Q; require constraint { q.w <= 2.0 } }
    satisfy R1 by p; satisfy R2 by p; satisfy R3 by q; }`;
    // 2.5 % 4 = 2.5: the clause holds at the values.
    for (const withValues of [false, true]) {
      const r = await consistency(own('2.5'), 'CO', withValues);
      const p = r.groups.find((g) => g.subject?.typeQualifiedName === 'CO::P')!;
      expect([p.outcome, p.code, r.exitCode]).toEqual(['inconclusive', 'verification/unsupported-construct', 2]);
      const f = await consistency(own('2.5'), 'CO', withValues, true);
      expect([f.consistent, f.forgiven, f.exitCode]).toEqual([1, 1, 0]);
    }
    // 0.5 % 4 = 0.5: false at the values, which `verify` refutes and no flag
    // forgives — so `--with-values` does not forgive it either. Released, the
    // values answer nothing and the shape is all that is left.
    const violated = own('0.5');
    expect((await verifyOne(violated, { engine: 'smt', allowInconclusive: true })).exitCode).toBe(1);
    const v = await consistency(violated, 'CO', true, true);
    const vp = v.groups.find((g) => g.subject?.typeQualifiedName === 'CO::P')!;
    expect([vp.outcome, vp.code, v.forgiven, v.exitCode]).toEqual(['inconclusive', 'verification/not-evaluable', 0, 2]);
    expect(vp.detail).toContain('`p.x % 4.0 >= 2.0` (CO::R2::');
    expect(vp.detail).toContain('false at the values this file states');
    const released = await consistency(violated, 'CO', false, true);
    expect([released.forgiven, released.exitCode]).toEqual([1, 0]);
    // The empty set filed under the same rule: its only relation is the violated one.
    const alone = violated.replace(/requirement def R1 [^\n]*\n/, '').replace('satisfy R1 by p; ', '');
    const e = await consistency(alone, 'CO', true, true);
    expect([e.groups.find((g) => g.subject?.typeQualifiedName === 'CO::P')!.code, e.exitCode]).toEqual([
      'verification/not-evaluable',
      2,
    ]);
    // A refused ASSUMPTION stands its requirement down; the set without it is not consistent.
    const premise = `package CQ {
    part def P { attribute x : ScalarValues::Real = 4.0; attribute y : ScalarValues::Real = 0.0; }
    part p : P;
    requirement def R1 { subject p : P; assume constraint { p.x % 2.0 == 0.0 } require constraint { p.y >= 5.0 } }
    requirement def R2 { subject p : P; require constraint { p.y <= 1.0 } }
    satisfy R1 by p; satisfy R2 by p; }`;
    const q = await consistency(premise, 'CQ', true);
    expect([q.consistent, q.exitCode]).toEqual([0, 2]);
  });

  withZ3('a defect in the set’s own relation is never forgiven, as `verify` never forgives it', async () => {
    const clash = `package CD {
    part def P { attribute x : ScalarValues::Real = 1.0; }
    part def Q { attribute m : ISQ::MassValue = 2.0 [kg]; }
    part p : P;
    part q : Q;
    requirement def RP { subject p : P; require constraint { p.x <= 10.0 } }
    requirement def RQ { subject q : Q; require constraint { q.m <= 1.0 [m] } }
    requirement def RQ2 { subject q : Q; require constraint { q.m <= 1.0 [kg] } }
    satisfy RP by p; satisfy RQ by q; satisfy RQ2 by q; }`;
    const r = await consistency(clash, 'CD', false, true);
    const q = r.groups.find((g) => g.subject?.typeQualifiedName === 'CD::Q')!;
    expect([q.outcome, q.code, r.exitCode]).toEqual(['inconclusive', 'verification/not-evaluable', 2]);
    // The empty set filed under the same code: its only relation is the clash.
    const only = clash.replace('satisfy RQ2 by q;', '').replace(/requirement def RQ2 [^\n]*\n/, '');
    const e = await consistency(only, 'CE', false, true);
    expect([e.groups.find((g) => g.subject?.typeQualifiedName === 'CD::Q')!.code, e.exitCode]).toEqual([
      'verification/not-evaluable',
      2,
    ]);
  });

  withZ3('an inconsistency found without the refused relation still stands', async () => {
    const text = MOD('CI', 'require constraint { p.x <= 1.0 } require constraint { p.x >= 2.0 } require constraint { p.g <= 1.0 }');
    for (const withValues of [false, true]) {
      const r = await consistency(text, 'CI', withValues);
      expect([r.groups[0].outcome, r.exitCode]).toEqual(['inconsistent', 1]);
    }
  });

  withZ3('every surface abstains or agrees: none calls the violated set satisfied', async () => {
    const text = MOD('CS', 'require constraint { p.g <= 1.0 }');
    const m = await contextModel(text, 'CS');
    const row = checkConstraints(m).find((c) => c.expression.includes('p.g <= 1.0'))!;
    expect(row.result).toBe('violated');
    expect((await verifyOne(text, { engine: 'literal' })).exitCode).toBe(1);
    expect((await verifyOne(text, { engine: 'smt' })).exitCode).toBe(2);
    expect((await consistencyReport(m, { withValues: true, sourceText: text })).exitCode).toBe(2);
    const b = await boundsReport(m, { measure: 'CS::P::g', sense: 'both', sourceText: text });
    expect([b.bounds.map((x) => x.outcome), b.exitCode]).toEqual([['inconclusive', 'inconclusive'], 2]);
  });

  withZ3('bounds does not publish a bound a withheld requirement would have tightened', async () => {
    const text = (second: string) => `package BW {
    part def P { attribute x : ScalarValues::Real = 3.0; attribute z : ScalarValues::Real = 4.0; }
    part p : P;
    requirement def R { subject p : P; require constraint { p.x <= 5.0 } ${second} }
    satisfy R by p; }`;
    const run = async (t: string) =>
      boundsReport(await contextModel(t, 'BW'), {
        measure: 'BW::P::x',
        sense: 'max',
        freeAll: true,
        withRequirements: true,
        sourceText: t,
      });
    // Encodable: the requirement bounds x at 5.
    const read = await run(text(''));
    expect([read.bounds[0].outcome, read.exitCode]).toEqual(['optimum', 0]);
    // A second clause the gates refuse withholds the WHOLE requirement, so
    // "unbounded above" would be a bound over a space the file does not state.
    const withheld = await run(text('require constraint { p.z % 2.0 == 0.0 }'));
    expect([withheld.bounds[0].outcome, withheld.bounds[0].code, withheld.exitCode]).toEqual([
      'inconclusive',
      'verification/not-evaluable',
      2,
    ]);
  });
});

describe('“assumptions satisfiable” is earned over the whole antecedent, or at the model’s own point', () => {
  const MOD = (pkg: string, attrs: string, body: string) => `package ${pkg} {
    part def P { ${attrs} }
    part p : P;
    requirement def R { subject p : P; ${body} }
    satisfy R by p; }`;
  const BAND = 'assume constraint { p.x % 4.0 >= 3.5 } assume constraint { p.x >= 5.0 and p.x <= 5.5 } require constraint { p.y <= 1.0 }';

  withZ3('a refused assumption no point satisfies makes the pass vacuous, or undecided where the model leaves it open', async () => {
    // x % 4 is in [1, 1.5] on [5, 5.5]: the two assumptions hold nowhere. The
    // solver saw only the second, and printed "assumptions satisfiable".
    const valued = await verifyOne(MOD('VH', 'attribute x : ScalarValues::Real = 5.0; attribute y : ScalarValues::Real = 0.0;', BAND), {
      engine: 'smt',
    });
    expect([valued.by('p.y <= 1.0').claim, valued.by('p.y <= 1.0').code, valued.exitCode]).toEqual([
      'vacuous',
      'verification/vacuous',
      2,
    ]);
    const literal = await verifyOne(MOD('VL', 'attribute x : ScalarValues::Real = 5.0; attribute y : ScalarValues::Real = 0.0;', BAND), {
      engine: 'literal',
    });
    expect(literal.by('p.y <= 1.0').claim).toBe('vacuous');
    const open = await verifyOne(MOD('VO', 'attribute x : ScalarValues::Real; attribute y : ScalarValues::Real = 0.0;', BAND), {
      engine: 'smt',
      allowInconclusive: true,
    });
    const row = open.by('p.y <= 1.0');
    expect([row.claim, row.code, open.exitCode]).toEqual(['inconclusive', 'verification/not-evaluable', 2]);
    expect(row.detail).toMatch(/^proof not claimed: .*only without 1 relation\(s\)/);
  });

  withZ3('a refused axiom in reach is re-read at the model’s point: false is a contradiction, true keeps the proof', async () => {
    const G = 'attribute x : ScalarValues::Real = 7.0; attribute g : ScalarValues::Real = x % 4.0;';
    // A closed assert no gate encodes, false: the axiom set contradicts itself.
    const closed = await verifyOne(
      MOD('VC', 'attribute x : ScalarValues::Real = 1.0; assert constraint fact { 7.0 % 4.0 == 0.0 }', 'require constraint { p.x <= 10.0 }'),
      { engine: 'smt' },
    );
    expect([closed.by('p.x <= 10.0').claim, closed.by('p.x <= 10.0').code]).toEqual([
      'inconclusive',
      'verification/inconsistent-axioms',
    ]);
    // g = 3: an asserted band the solver met at g = 10 is false at the model.
    const band = await verifyOne(
      MOD('VB', `${G} assert constraint band { g >= 10.0 and g <= 20.0 }`, 'require constraint { p.g <= 30.0 }'),
      { engine: 'smt' },
    );
    expect([band.by('p.g <= 30.0').claim, band.by('p.g <= 30.0').code]).toEqual([
      'inconclusive',
      'verification/inconsistent-axioms',
    ]);
    // An assumption the solver met at g = 10 is false at the model: vacuous.
    const premise = await verifyOne(
      MOD('VP', `${G} attribute y : ScalarValues::Real = 0.0;`, 'assume constraint { p.g >= 10.0 } require constraint { p.y <= 1.0 }'),
      { engine: 'smt' },
    );
    expect(premise.by('p.y <= 1.0').claim).toBe('vacuous');
    // A band the model's g = 3 meets: the proof stands, on both engines.
    const kept = MOD('VK', `${G} assert constraint band { g >= 0.0 and g <= 5.0 }`, 'require constraint { p.g <= 30.0 }');
    expect([(await verifyOne(kept, { engine: 'smt' })).by('p.g <= 30.0').claim, (await verifyOne(kept, { engine: 'literal' })).by('p.g <= 30.0').claim]).toEqual([
      'proved',
      'holds-at-values',
    ]);
    // A refused assumption that holds at the model, beside a feature with no value: the proof stands.
    const free = MOD(
      'VF',
      'attribute k : ScalarValues::Real = 4.0; attribute v : ScalarValues::Real; assert constraint vb { v >= 0.0 and v <= 1.0 }',
      'assume constraint { p.k % 2.0 == 0.0 } require constraint { p.v <= 2.0 }',
    );
    expect((await verifyOne(free, { engine: 'smt' })).by('p.v <= 2.0').claim).toBe('proved');
  });

  withZ3('with a feature released there is no model point to re-read at, so nothing is claimed', async () => {
    const text = MOD(
      'VR',
      'attribute x : ScalarValues::Real = 5.0; attribute y : ScalarValues::Real = 0.0;',
      'assume constraint { p.x % 4.0 >= 1.0 } assume constraint { p.y >= -1.0 and p.y <= 1.0 } ' +
        'require constraint { p.y <= p.x }',
    );
    expect((await verifyOne(text, { engine: 'smt' })).by('p.y <= p.x').claim).toBe('proved');
    const freed = await verifyOne(text, { engine: 'smt', free: ['VR::P::y'] });
    const row = freed.by('p.y <= p.x');
    expect([row.claim, row.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
    expect(row.detail).toContain('there is no model point to re-read them at');
  });

  withZ3('a counterexample is confirmed only by a reading of the same feature', async () => {
    // P's own `x` has no value; the numeric surface's scope gave the bare `x`
    // to the nested part's `x = 7.0` and read `x <= 5.0` violated there.
    const text = `package XR {
    part def Q { attribute x = 7.0; }
    part def P { attribute x : Real; part q : Q; constraint lo { x >= 5.0 } constraint hi { x <= 5.0 } }
    part p : P; }`;
    // Every surface now reads P's own `x` (the names group): valueless, so
    // the counterexample has no model point to be confirmed at.
    const r = await verifyOne(text, { engine: 'smt' });
    expect(r.by('x <= 5.0').claim).not.toBe('refuted');
    expect(r.by('x <= 5.0').detail).toContain('reads this relation as `unknown` there');
    // Nor is a relation no gate encodes read violated over q's `x`: it is
    // outside the fragment, and that is all it is.
    const refused = `package XS {
    part def Q { attribute x = 7.0; }
    part def P { attribute x : Real; part q : Q; constraint hi { x % 4.0 >= 3.5 } }
    part p : P; }`;
    const s = await verifyOne(refused, { engine: 'smt', allowInconclusive: true });
    const row = s.by('x % 4.0 >= 3.5');
    expect([row.claim, row.code, s.exitCode]).toEqual(['inconclusive', 'verification/unsupported-construct', 0]);
  });
});

describe('refine holds a verdict to what it stood on', () => {
  withZ3('a refutation over a refused connection is undecided, never published', async () => {
    const text = `package RB {
    part def Alpha { attribute m : ISQ::MassValue = 1.0 [kg]; }
    part def Beta { attribute m : ISQ::LengthValue = 1.0 [m]; }
    part def Loop { part alpha : Alpha; part beta : Beta; bind Alpha::m = Beta::m; }
    requirement def Top { subject sys : Loop; require constraint { sys.alpha.m <= 2.0 [kg] } }
    requirement def BetaReq { subject b : Beta; require constraint { b.m <= 1.0 [m] } }
    satisfy Top by Loop;
    satisfy BetaReq by Loop::beta; }`;
    const r = await refinementReport(await contextModel(text, 'RB'), { sourceText: text });
    expect([r.notRefined, r.inconclusive, r.exitCode]).toEqual([0, 1, 2]);
    const three = r.groups[0].obligations.find((o) => o.kind === 'composition')!;
    expect([three.outcome, three.code]).toEqual(['undecided', 'verification/not-evaluable']);
    expect(three.detail).toContain('PARTIAL connection set');
  });

  withZ3('a refutation over a sub-contract withheld for a refused assumption is undecided', async () => {
    // AReq's `assume` is refused, and true at every point: its normal form is
    // `a.x <= 1.0`, which excludes the counterexample a premise set without it finds.
    const text = `package RW {
    part def A { attribute x : ScalarValues::Real; attribute k : ScalarValues::Real; }
    part def B { attribute y : ScalarValues::Real; }
    part def Sys { part a : A; part b : B; }
    requirement def Top { subject sys : Sys; require constraint { sys.a.x <= 1.0 } }
    requirement def AReq { subject a : A; assume constraint { a.k * 0.0 % 2.0 == 0.0 } require constraint { a.x <= 1.0 } }
    requirement def BReq { subject b : B; require constraint { b.y <= 5.0 } }
    satisfy Top by Sys; satisfy AReq by Sys::a; satisfy BReq by Sys::b; }`;
    const r = await refinementReport(await contextModel(text, 'RW'), { sourceText: text });
    expect([r.notRefined, r.exitCode]).toEqual([0, 2]);
    const three = r.groups[0].obligations.find((o) => o.kind === 'composition')!;
    expect([three.outcome, three.code]).toEqual(['undecided', 'verification/refinement-undecided']);
  });

  withZ3('step (0) satisfiable only without a refused guarantee is no evidence against vacuity', async () => {
    const pack = (cell: string) => `package RV {
    part def Cell { attribute x : ScalarValues::Real = 5.0; }
    part def Pack { part cell : Cell; }
    requirement def Top { subject sys : Pack; require constraint { sys.cell.x <= 6.0 } }
    requirement def CellReq { subject c : Cell; ${cell} require constraint { c.x >= 5.0 } require constraint { c.x <= 5.5 } }
    satisfy Top by Pack;
    satisfy CellReq by Pack::cell; }`;
    // x in [5, 5.5] puts x % 4 in [1, 1.5]: the component promises nothing any design meets.
    const vacuous = pack('require constraint { c.x % 4.0 >= 3.5 }');
    const r = await refinementReport(await contextModel(vacuous, 'RV'), { sourceText: vacuous });
    expect([r.refined, r.inconclusive, r.exitCode]).toEqual([0, 1, 2]);
    const three = r.groups[0].obligations.find((o) => o.kind === 'composition')!;
    expect([three.outcome, three.code]).toEqual(['undecided', 'verification/refinement-undecided']);
    expect(three.detail).toContain('step (0) found the antecedent satisfiable only without');
    const f = await faultTreeReport(await contextModel(vacuous, 'RV'), { sourceText: vacuous });
    expect(f.groups[0].outcome).toBe('inconclusive');
    // The same clause where the point step (0) found meets it: refined.
    const met = pack('require constraint { c.x % 4.0 >= 1.0 }');
    const m = await refinementReport(await contextModel(met, 'RV'), { sourceText: met });
    expect([m.refined, m.exitCode]).toEqual([1, 0]);
  });
});

/*
 * TWO INSTANCES OF A FEATURE WITH NO VALUE ARE TWO UNKNOWNS. One symbol per
 * feature made them one — an equality nobody wrote — so `s.c1.v >= 5.0`
 * beside `s.c2.v <= 3.0` was "inconsistent", `p1.m2 == p2.m2` was "proved",
 * and `d = a.v - b.v` had the maximum 0 "exactly". An interim guard withheld
 * every such UNSAT; every instance now has symbols of its own, so the answer
 * is the model's, on every command.
 */
describe('two instances of a feature with no value are two unknowns, on every command', () => {
  withZ3('consistency: two cells are not one cell, and one cell read twice still is', async () => {
    const pack = (second: string) => `package AC {
    part def Cell { attribute v : ScalarValues::Real; }
    part def Pack { part c1 : Cell; part c2 : Cell; }
    part pack : Pack;
    requirement def R1 { subject s : Pack; require constraint { s.c1.v >= 5.0 } }
    requirement def R2 { subject t : Pack; require constraint { ${second} <= 3.0 } }
    satisfy R1 by pack; satisfy R2 by pack; }`;
    for (const withValues of [false, true]) {
      const two = await consistencyReport(await contextModel(pack('t.c2.v'), 'AC'), { withValues, sourceText: pack('t.c2.v') });
      expect([two.inconsistent, two.consistent, two.exitCode], `withValues ${withValues}`).toEqual([0, 1, 0]);
      const one = await consistencyReport(await contextModel(pack('t.c1.v'), 'AC'), { withValues, sourceText: pack('t.c1.v') });
      expect([one.inconsistent, one.exitCode], `withValues ${withValues}`).toEqual([1, 1]);
    }
  });

  withZ3('verify: two instances are not proved to agree, directly or through a derived value', async () => {
    const text = `package AV {
    part def P { attribute load : ScalarValues::Real; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part p1 : P;
    part p2 : P;
    constraint eq { p1.m2 == p2.m2 }
    constraint sum { p1.m2 + p2.load == 10.0 } }`;
    const r = await verifyOne(text, { engine: 'smt' });
    for (const goal of ['p1.m2 == p2.m2', 'p1.m2 + p2.load == 10.0']) {
      expect([r.by(goal).claim, r.by(goal).code], goal).toEqual(['inconclusive', 'verification/not-evaluable']);
    }
    // One instance read through a derived value and the definition's own
    // equation is ONE instance: the proof stands.
    const one = `package AO {
    part def Cell { attribute v : ScalarValues::Real; }
    part def Sys { part a : Cell; attribute d : ScalarValues::Real = a.v * 2.0; assert constraint av { a.v >= 0.0 and a.v <= 1.0 } }
    part sys : Sys;
    constraint c { sys.d <= 2.0 } }`;
    expect((await verifyOne(one, { engine: 'smt' })).by('sys.d <= 2.0').claim).toBe('proved');
  });

  withZ3('bounds: a difference of two instances ranges over both', async () => {
    const text = `package AB {
    part def Cell { attribute v : ScalarValues::Real; }
    part def Sys { part a : Cell; part b : Cell; attribute d : ScalarValues::Real = a.v - b.v; }
    part sys : Sys; }`;
    const b = await boundsReport(await contextModel(text, 'AB'), { measure: 'AB::Sys::d', sense: 'both', sourceText: text });
    expect([b.bounds.map((x) => x.outcome), b.exitCode]).toEqual([['unbounded', 'unbounded'], 0]);
  });

  withZ3('a bare read is its own instance’s, never a child’s, and a subtype’s axiom is no supertype’s', async () => {
    // A Pack's own `v` and its `c1.v` are two instances.
    const own = `package AW {
    part def Base { attribute v : ScalarValues::Real; }
    part def Pack :> Base {
        part c1 : Base;
        assert constraint { c1.v <= 3.0 }
        constraint goal { v <= 3.0 }
        attribute d : ScalarValues::Real = v - c1.v;
        assert constraint band { d >= -1.0 and d <= 1.0 }
    }
    part pack : Pack; }`;
    const goal = (await verifyOne(own, { engine: 'smt' })).by('v <= 3.0');
    expect([goal.claim, goal.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
    const m = await contextModel(own, 'AW');
    const b = await boundsReport(m, { measure: 'AW::Pack::d', sense: 'both', sourceText: own });
    expect([b.bounds.map((x) => [x.outcome, x.value]), b.exitCode]).toEqual([
      [
        ['optimum', -1],
        ['optimum', 1],
      ],
      0,
    ]);
    // Two requirements on one pack: its `c1.v` above 5 and its own `v` below 3 hold together.
    const reqs = `package AS {
    part def Base { attribute v : ScalarValues::Real; }
    part def Pack :> Base { part c1 : Base; }
    part pack : Pack;
    requirement def R1 { subject s : Pack; require constraint { s.c1.v >= 5.0 } }
    requirement def R2 { subject s : Pack; require constraint { s.v <= 3.0 } }
    satisfy R1 by pack; satisfy R2 by pack; }`;
    for (const withValues of [false, true]) {
      const c = await consistencyReport(await contextModel(reqs, 'AS'), { withValues, sourceText: reqs });
      expect([c.inconsistent, c.consistent, c.exitCode], `withValues ${withValues}`).toEqual([0, 1, 0]);
    }
    // A component at `c1` bounds the c1's `v`, not the system's own.
    const refine = `package AF {
    part def Base { attribute v : ScalarValues::Real; }
    part def Pack :> Base { part c1 : Base; }
    requirement def Top { subject sys : Pack; require constraint { sys.v <= 3.0 } }
    requirement def BaseReq { subject b : Base; require constraint { b.v <= 3.0 } }
    satisfy Top by Pack;
    satisfy BaseReq by Pack::c1; }`;
    const r = await refinementReport(await contextModel(refine, 'AF'), { sourceText: refine });
    expect([r.refined, r.notRefined, r.exitCode]).toEqual([0, 1, 1]);
    // An axiom every `Sub` meets says nothing of a `cell : Cell`.
    const sub = `package AT {
    part def Cell { attribute v : ScalarValues::Real; }
    part def Sub :> Cell { assert constraint { v <= 3.0 } }
    part cell : Cell;
    constraint goal { cell.v <= 3.0 } }`;
    const t = (await verifyOne(sub, { engine: 'smt' })).by('cell.v <= 3.0');
    expect([t.claim, t.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
  });

  withZ3('a requirement’s subject is the instance that satisfies it, and no other instance', async () => {
    const pack = (axiom: string, require: string) => `package AP {
    part def Cell { attribute v : ScalarValues::Real; }
    part def Pack { part c1 : Cell; }
    part pack : Pack;
    part pack2 : Pack { assert constraint { ${axiom} } }
    requirement def R1 { subject s : Pack; require constraint { ${require} } }
    satisfy R1 by pack; }`;
    // pack2's own assertion proves nothing about pack's cell…
    const proof = (await verifyOne(pack('c1.v >= 5.0', 's.c1.v >= 4.0'), { engine: 'smt' })).by('s.c1.v >= 4.0');
    expect([proof.claim, proof.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
    // …and does not collide with a requirement on it.
    const set = pack('c1.v <= 3.0', 's.c1.v >= 5.0');
    for (const withValues of [false, true]) {
      const c = await consistencyReport(await contextModel(set, 'AP'), { withValues, sourceText: set });
      expect([c.inconsistent, c.consistent, c.exitCode], `withValues ${withValues}`).toEqual([0, 1, 0]);
    }
    // A package's relation about `q`, beside a requirement satisfied by `s`.
    const cells = (require: string) => `package AQ {
    part def Cell { attribute v : ScalarValues::Real; }
    part q : Cell;
    part s : Cell;
    assert constraint qv { q.v >= 5.0 }
    requirement def R { subject x : Cell; require constraint { ${require} } }
    satisfy R by s; }`;
    const bare = (await verifyOne(cells('x.v >= 5.0'), { engine: 'smt' })).by('x.v >= 5.0');
    expect([bare.claim, bare.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
    const collide = cells('x.v <= 3.0');
    const cq = await consistencyReport(await contextModel(collide, 'AQ'), { sourceText: collide });
    expect([cq.inconsistent, cq.consistent, cq.exitCode]).toEqual([0, 1, 0]);
    // The same through a part, and a definition's axiom read at an instance of
    // ANOTHER type with a part of the same name.
    const nested = `package AN {
    part def Cell { attribute v : ScalarValues::Real; }
    part def Sys { part a : Cell; }
    part q : Sys;
    part s : Sys;
    assert constraint qa { q.a.v >= 5.0 }
    requirement def R { subject x : Sys; require constraint { x.a.v >= 5.0 } }
    satisfy R by s; }`;
    expect((await verifyOne(nested, { engine: 'smt' })).by('x.a.v >= 5.0').code).toBe('verification/not-evaluable');
    for (const [pkg, goal] of [
      ['AD', 'q.a.v >= 5.0'],
      ['AE', 'q.a.v >= 4.0'],
    ] as const) {
      const other = `package ${pkg} {
    part def Cell { attribute v : ScalarValues::Real; }
    part def Sys { part a : Cell; assert constraint av { a.v >= 5.0 } }
    part def Other { part a : Cell; }
    part q : Other;
    constraint c { ${goal} } }`;
      expect((await verifyOne(other, { engine: 'smt' })).by(goal).code, pkg).toBe('verification/not-evaluable');
    }
  });

  withZ3('refine: two cells under one contract do not refine a bound on their difference', async () => {
    const text = `package AR {
    part def Cell { attribute x : ScalarValues::Real; }
    part def Pack { part c1 : Cell; part c2 : Cell; }
    requirement def Top { subject sys : Pack; require constraint { sys.c1.x - sys.c2.x <= 0.5 } }
    requirement def CellReq { subject c : Cell; require constraint { c.x >= 0.0 } require constraint { c.x <= 1.0 } }
    satisfy Top by Pack;
    satisfy CellReq by Pack::c1;
    satisfy CellReq by Pack::c2; }`;
    const r = await refinementReport(await contextModel(text, 'AR'), { sourceText: text });
    expect([r.refined, r.notRefined, r.exitCode]).toEqual([0, 1, 1]);
    expect(r.groups[0].obligations.find((o) => o.kind === 'composition')!.code).toBe('verification/refinement-failed');
  });

  withZ3('refine and fault-tree: every part that satisfies a sub-contract is a sub-contract of its own', async () => {
    const cells = (top: string, order = 'satisfy CellReq by Pack::c1; satisfy CellReq by Pack::c2;') => `package RF {
    part def Cell { attribute x : ScalarValues::Real; }
    part def Pack { part c1 : Cell; part c2 : Cell; }
    requirement def Top { subject sys : Pack; require constraint { ${top} } }
    requirement def CellReq { subject c : Cell; require constraint { c.x <= 1.0 } }
    satisfy Top by Pack;
    ${order} }`;
    // Grouped with its first satisfier alone, c2 had no contract: `not refined`, a witness with c2.x = 2.
    for (const [top, order] of [
      ['sys.c1.x + sys.c2.x <= 2.0', undefined],
      ['sys.c2.x <= 1.0', undefined],
      ['sys.c1.x + sys.c2.x <= 2.0', 'satisfy CellReq by Pack::c2; satisfy CellReq by Pack::c1;'],
    ] as const) {
      const text = cells(top, order);
      const r = await refinementReport(await contextModel(text, 'RF'), { sourceText: text });
      expect([r.refined, r.notRefined, r.groups[0].components.length, r.exitCode], top).toEqual([1, 0, 2, 0]);
    }
    // One basic event per part: either cell's contract withdrawn breaks the sum, neither alone the top.
    const sum = cells('sys.c1.x + sys.c2.x <= 2.0');
    const f = await faultTreeReport(await contextModel(sum, 'RF'), { sourceText: sum });
    expect([f.groups[0].outcome, f.groups[0].cutSets.map((c) => [c.order, c.shortIds])]).toEqual([
      'cut-sets',
      [
        [1, ['CellReq on c1']],
        [1, ['CellReq on c2']],
      ],
    ]);
    // A sub-contract read over another instance than the system reads is no
    // premise about the system's: every Pack's c1 is CellReq's, pack's too,
    // and a usage's c1 says nothing of every Pack's. Neither is refuted.
    for (const [name, text] of [
      [
        'every Pack’s c1, the system a usage that says something of its own',
        `package RU {
    part def Cell { attribute x : ScalarValues::Real; }
    part def Pack { part c1 : Cell; }
    part pack : Pack { attribute note : ScalarValues::Real = 1.0; }
    requirement def Top { subject sys : Pack; require constraint { sys.c1.x <= 1.0 } }
    requirement def CellReq { subject c : Cell; require constraint { c.x <= 1.0 } }
    satisfy Top by pack;
    satisfy CellReq by Pack::c1; }`,
      ],
      [
        'pack’s cells, the system read at every Pack',
        `package RU {
    part def Cell { attribute x : ScalarValues::Real; }
    part def Pack { part c1 : Cell; part c2 : Cell; }
    part pack : Pack;
    requirement def Top { subject sys : Pack; require constraint { sys.c2.x <= 1.0 } }
    requirement def CellReq { subject c : Cell; require constraint { c.x <= 1.0 } }
    satisfy Top by pack;
    satisfy CellReq by pack.c1;
    satisfy CellReq by pack.c2; }`,
      ],
    ] as const) {
      const m = await contextModel(text, 'RU');
      const r = await refinementReport(m, { sourceText: text });
      expect([r.notRefined, r.groups[0].code, r.exitCode], name).toEqual([0, 'verification/refinement-undecided', 2]);
      const t = await faultTreeReport(m, { sourceText: text });
      expect([t.groups[0].outcome, t.groups[0].cutSets.length], name).toEqual(['inconclusive', 0]);
    }
  });

  withZ3('a subject bound to a chain is that chain’s instance, and no other requirement’s', async () => {
    const text = (assert: string, first: string, second: string) => `package RC {
    part def P { attribute x : ScalarValues::Real; }
    part def Q { part p : P; }
    part q1 : Q;
    part q2 : Q { ${assert} }
    requirement r1 { subject s = q1.p; require constraint { ${first} } }
    requirement r2 { subject s = q2.p; require constraint { ${second} } } }`;
    // Read as Q's one p, q1's and q2's were "inconsistent" and bounded to [5, 7] "exactly".
    const apart = text('', 's.x >= 5.0', 's.x <= 3.0');
    for (const withValues of [false, true]) {
      const c = await consistencyReport(await contextModel(apart, 'RC'), { withValues, sourceText: apart });
      expect([c.inconsistent, c.consistent, c.exitCode], `withValues ${withValues}`).toEqual([0, 1, 0]);
    }
    const b = await boundsReport(await contextModel(apart, 'RC'), {
      measure: 'q1.p.x',
      sense: 'both',
      withRequirements: true,
      sourceText: apart,
    });
    expect([b.bounds.map((x) => [x.outcome, x.value]), b.exitCode]).toEqual([
      [
        ['optimum', 5],
        ['unbounded', null],
      ],
      0,
    ]);
    // q2's own assert is a fact of q2's p, which the second subject reads, and of no other.
    const facts = await verifyOne(text('assert constraint { p.x >= 6.0 }', 's.x >= 4.0', 's.x >= 5.0'), { engine: 'smt' });
    expect([facts.by('s.x >= 4.0').claim, facts.by('s.x >= 5.0').claim]).toEqual(['inconclusive', 'proved']);
  });

  withZ3('a unit beside a value is joined where the value is read, an instance’s inputs included', async () => {
    const text = `package IU {
    part def P {
        attribute cap : ISQ::StorageCapacityValue default = 2.0 [GiB];
        attribute k : ScalarValues::Real default = 1.0;
        attribute total : ISQ::StorageCapacityValue = (k * 2.0) [GiB];
    }
    part p : P { attribute :>> k = 1.0 [GiB]; }
    part r : P { attribute :>> k = cap / 1.0 [GiB]; }
    constraint pBig { p.total >= 1000.0 [GiB] }
    constraint rT { r.total == 4.0 [GiB] } }`;
    // Joined at P, where k is a number, p's copy read p's bits as GiB:
    // PROVED, and bounded at 2^35 GiB "exactly", where no surface derives it.
    const v = await verifyOne(text, { engine: 'smt' });
    expect([v.by('p.total >= 1000.0 [GiB]').claim, v.by('r.total == 4.0 [GiB]').claim]).toEqual(['inconclusive', 'proved']);
    const b = await boundsReport(await contextModel(text, 'IU'), { measure: 'p.total', sense: 'both', sourceText: text });
    expect([b.bounds.map((x) => x.outcome), b.exitCode]).toEqual([['inconclusive', 'inconclusive'], 2]);
    const req = `package IV {
    part def P { attribute k : ScalarValues::Real default = 1.0; attribute total : ISQ::StorageCapacityValue = (k * 2.0) [GiB]; }
    part p : P { attribute :>> k = 1.0 [GiB]; }
    requirement def R { subject s : P; require constraint { s.total <= 5.0 [GiB] } }
    satisfy R by p; }`;
    const c = await consistencyReport(await contextModel(req, 'IV'), { withValues: true, sourceText: req });
    expect([c.inconsistent, c.groups[0].code, c.exitCode]).toEqual([0, 'verification/not-evaluable', 2]);
  });
});

describe('a metadata value annotates an element and is no fact about the design', () => {
  withZ3('it is no axiom, and no relation body can name it', async () => {
    for (const [pkg, decl, name] of [
      ['MR', 'metadata rk : Risk { :>> level = 3.0; }', 'level'],
      ['MN', 'metadata rk : Risk { attribute level2 : ScalarValues::Real = 3.0; }', 'level2'],
    ] as const) {
      const text = `package ${pkg} {
    metadata def Risk { attribute level : ScalarValues::Real; }
    part def P { attribute x : ScalarValues::Real = 2.0; ${decl} }
    part p : P;
    constraint c1 { p.rk.${name} >= 5.0 } }`;
      const rows = obligationsOf(await contextModel(text, pkg));
      expect(rows.filter((o) => o.source === 'feature-value').map((o) => o.element.qualifiedName), pkg).toEqual([`${pkg}::P::x`]);
      expect(rows.find((o) => o.expression.startsWith('p.rk'))!.encodable, pkg).toMatchObject({ reason: 'unresolved-name' });
    }
  });

  withZ3('an annotation no gate can read does not stand a requirement set down', async () => {
    const text = read('examples/uav-isr-verification.sysml');
    const m = await contextModel(text, 'uav-isr-verification');
    const r = await consistencyReport(m, { withValues: true, sourceText: text });
    expect([r.refused, r.exitCode]).toEqual([0, 0]);
  });
});

/** One engine's verdicts on a model, by the CLAUSE's qualified name — two rows may share a body. */
async function verifyByClause(
  text: string,
  opts: { engine: 'smt' | 'literal'; allowInconclusive?: boolean },
): Promise<{ by: (clause: string) => ObligationVerdict; exitCode: number; clauses: string[] }> {
  const m = await contextModel(text, 'case');
  const report = await verifyModel(m, { sourceText: text, ...opts });
  const rows = new Map(report.results.map((r) => [r.clause.qualifiedName, r]));
  return {
    by: (clause) => {
      const row = rows.get(clause);
      if (!row) throw new Error(`no row ${clause}; rows: ${[...rows.keys()].join(' | ')}`);
      return row;
    },
    exitCode: report.exitCode,
    clauses: [...rows.keys()],
  };
}

/*
 * KerML, strictly (the soundness pass, decision 1). A usage's redefinition IS
 * the feature in its context — named or not (`attribute :>> load`), renamed
 * (`heavy redefines load`), however deep the chain that reaches it — and a
 * value written with `=` is a BINDING: every instance of its owner has it, so
 * a redefinition with another value contradicts the model. Only `default` is
 * overridable. Every surface read P's `load` through `p` before — `p.load <=
 * 10.0` was PROVED at 1 where p's is 50 — and a definition's constraints only
 * at P's values.
 */
describe('a redefinition is the feature in its context, and a value written with `=` binds every instance', () => {
  const R1 = (op: string, redef = 'attribute :>> load = 50.0;') => `package R1 {
    part def P { attribute load : ScalarValues::Real ${op} 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part p : P { ${redef} }
    part def Q { part p : P; }
    part q : Q { part :>> p { ${redef} } }
    part def S :> P { ${redef} }
    part s : S;
    constraint hi { p.load >= 10.0 }
    constraint lo { p.load <= 10.0 }
    constraint qlo { q.p.load <= 10.0 }
    constraint slo { s.load <= 10.0 }
    constraint m2 { p.m2 >= 0.0 }
  }`;

  withZ3('reads a redefinition of a DEFAULT in its context — unnamed, `redefines`, renamed, through a chain — on every engine', async () => {
    for (const redef of [
      'attribute :>> load = 50.0;',
      'attribute redefines load = 50.0;',
      'attribute heavy redefines load = 50.0;',
    ]) {
      const text = R1('default =', redef);
      for (const engine of ['literal', 'smt'] as const) {
        const r = await verifyOne(text, { engine });
        const tag = `${engine}: ${redef}`;
        expect(r.by('p.load >= 10.0').claim, tag).toBe(engine === 'smt' ? 'proved' : 'holds-at-values');
        for (const goal of ['p.load <= 10.0', 'q.p.load <= 10.0', 's.load <= 10.0']) {
          const row = r.by(goal);
          expect([row.claim, row.detail.includes('50 vs 10')], `${tag}: ${goal}`).toEqual(['refuted', true]);
        }
        // P's derived value over a changed input is p's own: 10 − 50.
        const m2 = r.by('p.m2 >= 0.0');
        expect([m2.claim, m2.detail.includes('-40 vs 0')], tag).toEqual(['refuted', true]);
        expect(r.exitCode, tag).toBe(1);
      }
    }
  });

  withZ3('calls a redefinition that changes a BINDING a contradiction: read by no surface, inconsistent axioms', async () => {
    const text = R1('=');
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyOne(text, { engine, allowInconclusive: true });
      for (const goal of ['p.load >= 10.0', 'p.load <= 10.0', 'q.p.load <= 10.0', 's.load <= 10.0']) {
        const row = r.by(goal);
        expect([row.claim, row.code], `${engine}: ${goal}`).toEqual(['inconclusive', 'verification/not-evaluable']);
        expect(row.detail, `${engine}: ${goal}`).toContain('contradicts P::load = 1.0, a binding every P holds');
      }
      expect(r.exitCode, engine).toBe(2);
    }
    // The verification lane carries both values, and they collide.
    const smt = await verifyOne(text, { engine: 'smt' });
    expect([smt.by('p.m2 >= 0.0').claim, smt.by('p.m2 >= 0.0').code]).toEqual([
      'inconclusive',
      'verification/inconsistent-axioms',
    ]);
    const m = await contextModel(text, 'R1');
    const binding = obligationsOf(m).find((o) => o.element.qualifiedName === 'R1::P::load in R1::p')!;
    expect([binding.role, binding.expression, binding.vars.map((v) => v.qualifiedName)]).toEqual([
      'axiom',
      'load == 1',
      ['R1::p::load'],
    ]);
    // The check surface reports it, at the redefinition.
    const contradiction = checkConstraints(m).filter((c) => c.result === 'violated' && c.message.includes('contradicts'));
    expect(contradiction).toHaveLength(3);
  });

  withZ3('reads two unnamed redefinitions of one usage as two symbols', async () => {
    const text = `package R18 {
    part def P { attribute a : ScalarValues::Real default = 1.0; attribute b : ScalarValues::Real default = 2.0; }
    part p : P { attribute :>> a = 10.0; attribute :>> b = 20.0; }
    constraint ab { p.a + p.b <= 5.0 } }`;
    const r = await verifyOne(text, { engine: 'smt' });
    const row = r.by('p.a + p.b <= 5.0');
    expect([row.claim, row.detail.includes('30 vs 5')]).toEqual(['refuted', true]);
    const m = await contextModel(text, 'R18');
    const row2 = obligationsOf(m).find((o) => o.expression === 'p.a + p.b <= 5.0')!;
    expect(row2.vars.map((v) => v.qualifiedName)).toEqual(['R18::p::a', 'R18::p::b']);
  });

  withZ3('reads a definition’s constraint in each context that changes it, beside its own verdict', async () => {
    const text = `package R19 {
    part def P {
      attribute load : ScalarValues::Real default = 1.0;
      attribute m2 : ScalarValues::Real = 10.0 - load;
      constraint cM2 { m2 >= 0.0 }
      constraint cLoad { load <= 10.0 }
    }
    part p : P { attribute :>> load = 50.0; }
    part plain : P; }`;
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyByClause(text, { engine });
      expect(r.by('R19::P::cLoad').claim, engine).toBe(engine === 'smt' ? 'proved' : 'holds-at-values');
      expect(r.by('R19::P::cLoad in R19::p').claim, engine).toBe('refuted');
      // p's m2 is p's own, −40.
      expect(r.by('R19::P::cM2 in R19::p').claim, engine).toBe('refuted');
      expect(r.by('R19::P::cM2').claim, engine).toBe(engine === 'smt' ? 'proved' : 'holds-at-values');
      // `plain` changes nothing either relation reads: no reading of its own.
      expect(r.clauses.filter((c) => c.includes('plain')), engine).toEqual([]);
      expect(r.exitCode, engine).toBe(1);
    }
  });

  withZ3('reads a definition’s assert in each context: a broken one makes the axioms inconsistent', async () => {
    const text = `package R24 {
    part def P { attribute load : ScalarValues::Real default = 1.0; assert constraint lim { load <= 10.0 } }
    part p : P { attribute :>> load = 50.0; }
    constraint c { p.load >= 20.0 } }`;
    const row = (await verifyOne(text, { engine: 'smt' })).by('p.load >= 20.0');
    expect([row.claim, row.code]).toEqual(['inconclusive', 'verification/inconsistent-axioms']);
    const m = await contextModel(text, 'R24');
    const instance = obligationsOf(m).find((o) => o.element.qualifiedName === 'R24::P::lim in R24::p')!;
    expect([instance.role, instance.instance?.contextId]).toEqual(['axiom', m.all().find((e) => e.declaredName === 'p')!.id]);
  });

  withZ3('reads a `default` a binding gives a value as the binding gives it, never the default — on every surface (h2, k3)', async () => {
    // Decision 10: `bind p.load = L` overrides P's `load default = 1.0` as a
    // redefinition would, so q's p's load is q's L of 50 and its m2 is −40.
    // Read as the default beside the binding, every engine answered the
    // contradiction it made: the check and the literal engine read m2 = 9
    // (`<= 0.0` refuted, `>= 0.0` holding), the SMT engine's axioms were
    // inconsistent. Through an implicit connector-end copy (h2), and on a
    // feature the binding names directly (k3).
    const h2 = `package H2 {
    part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
    part q : Q { attribute :>> L = 50.0; }
    constraint m2NegT { q.p.m2 <= 0.0 }
    constraint m2PosF { q.p.m2 >= 0.0 } }`;
    const k3 = `package K3 {
    part def Q {
      attribute L : ScalarValues::Real default = 1.0;
      attribute load : ScalarValues::Real default = 2.0;
      attribute m2 : ScalarValues::Real = 10.0 - load;
      bind load = L;
    }
    part q : Q { attribute :>> L = 50.0; }
    constraint m2NegT { q.m2 <= 0.0 }
    constraint m2PosF { q.m2 >= 0.0 } }`;
    // Along a chain of bindings the default gives way to the value at its
    // far end: in one definition (`bind B = A; bind C = B;`, c4), across two
    // (R's `bind q.L = M` over Q's `bind p.load = L`, c3) — the last default
    // stood, and every surface read m2 = 9 — and where a context redefines
    // the bound end with a default of its own (q's `:>> load default = 30.0`
    // in a p Q binds to its `L = 50.0`, d1b), which also read as a
    // contradiction of the binding.
    const c4 = `package C4 {
    part def Q {
      attribute A : ScalarValues::Real = 50.0;
      attribute B : ScalarValues::Real default = 1.0;
      attribute C : ScalarValues::Real default = 1.0;
      attribute m2 : ScalarValues::Real = 10.0 - C;
      bind B = A;
      bind C = B;
    }
    part q : Q;
    constraint m2NegT { q.m2 <= 0.0 }
    constraint m2PosF { q.m2 >= 0.0 } }`;
    const c3 = `package C3 {
    part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
    part def R { attribute M : ScalarValues::Real = 50.0; part q : Q; bind q.L = M; }
    part r : R;
    constraint m2NegT { r.q.p.m2 <= 0.0 }
    constraint m2PosF { r.q.p.m2 >= 0.0 } }`;
    const d1b = `package D1B {
    part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part def Q { attribute L : ScalarValues::Real = 50.0; part p : P; bind p.load = L; }
    part q : Q { part :>> p { attribute :>> load default = 30.0; } }
    constraint m2NegT { q.p.m2 <= -30.0 }
    constraint m2PosF { q.p.m2 >= -30.0 } }`;
    for (const [name, text, m2, bound] of [
      ['H2', h2, 'q.p.m2', '0.0'],
      ['K3', k3, 'q.m2', '0.0'],
      ['C4', c4, 'q.m2', '0.0'],
      ['C3', c3, 'r.q.p.m2', '0.0'],
      ['D1B', d1b, 'q.p.m2', '-30.0'],
    ] as const) {
      const smt = await verifyOne(text, { engine: 'smt' });
      expect(smt.by(`${m2} <= ${bound}`).claim, name).toBe('proved');
      expect([smt.by(`${m2} >= ${bound}`).claim, smt.by(`${m2} >= ${bound}`).code], name).toEqual([
        'refuted',
        'verification/refuted',
      ]);
      // The check and the literal engine read a value a binding gives per
      // instance (F5): q's p's m2 is −40, so `<= 0.0` holds and `>= 0.0` fails.
      const literal = await verifyOne(text, { engine: 'literal' });
      expect(literal.by(`${m2} <= ${bound}`).claim, `${name}`).toBe('holds-at-values');
      expect(literal.by(`${m2} >= ${bound}`).claim, `${name}`).toBe('refuted');
      const m = await contextModel(text, name);
      expect(checkConstraints(m).map((c) => c.result), name).toEqual(['satisfied', 'violated']);
      expect(checkConstraintsNumeric(m).map((r) => [r.name, r.result]), name).toEqual([
        ['m2NegT', 'satisfied'],
        ['m2PosF', 'violated'],
      ]);
      const f = solveFeasible(m);
      expect([f.violations.map((v) => v.name), f.decided], name).toEqual([['m2PosF'], true]);
    }
    // A definition's constraint over a value read through its binding is
    // read per instance (F5): Q's `c` is proved at Q's L of 1, and q — whose
    // L of 50 makes p's m2 −40 — is read in q and violated there.
    const h2c = `package H2C {
    part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; constraint c { p.m2 >= 0.0 } }
    part q : Q { attribute :>> L = 50.0; } }`;
    const mc = await contextModel(h2c, 'H2C');
    const c = checkConstraints(mc).find((r) => r.expression === 'p.m2 >= 0.0')!;
    expect(c.instances?.map((i) => [i.context, i.result])).toEqual([['q', 'violated']]);
    const inQ = (await verifyModel(mc, { sourceText: h2c, engine: 'smt' })).results;
    expect(inQ.map((r) => [r.expression.trim(), r.claim])).toEqual([
      ['p.m2 >= 0.0', 'proved'],
      ['p.m2 >= 0.0', 'refuted'],
    ]);
    // P's own constraint read in Q's p is now read per instance (F7): Q's own
    // p (the generic row) proves it, and q's p — whose load Q's binding joins
    // to q's L of 50 — refutes it.
    const h2p = `package H2P {
    part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
    part q : Q { attribute :>> L = 50.0; } }`;
    const inP = (await verifyModel(await contextModel(h2p, 'H2P'), { sourceText: h2p, engine: 'smt' })).results;
    expect(inP.map((r) => [r.clause.qualifiedName, r.claim])).toEqual([
      ['H2P::P::c', 'proved'],
      ['H2P::P::c in H2P::Q::p (H2P::Q\u0027s own)', 'proved'],
      ['H2P::P::c in H2P::q::p', 'refuted'],
    ]);
  });

  withZ3('calls a binding a value written with `=` contradicts a contradiction on every surface (h2f, h2g)', async () => {
    // P's `load = 1.0` binds every P; Q's `bind p.load = L` binds q's p's
    // load to q's L of 50. The SMT engine found the axioms inconsistent; the
    // check and the numeric surface read nothing of the binding, and the
    // model was feasible, decided.
    const h2f = `package H2F {
    part def P { attribute load : ScalarValues::Real = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
    part q : Q { attribute :>> L = 50.0; }
    constraint m2PosF { q.p.m2 >= 0.0 } }`;
    const h2g = `package H2G {
    part def P { attribute load : ScalarValues::Real = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part p : P;
    attribute L : ScalarValues::Real = 50.0;
    bind p.load = L;
    constraint m2PosF { p.m2 >= 0.0 } }`;
    // A context's redefinition written with `=` contradicts the binding as P's
    // `load = 1.0` does (d2).
    const d2 = `package D2 {
    part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part def Q { attribute L : ScalarValues::Real = 50.0; part p : P; bind p.load = L; }
    part q : Q { part :>> p { attribute :>> load = 30.0; } }
    constraint m2PosF { q.p.m2 >= 0.0 } }`;
    for (const [name, text, goal, context] of [
      ['H2F', h2f, 'q.p.m2 >= 0.0', 'q'],
      ['H2G', h2g, 'p.m2 >= 0.0', undefined],
      ['D2', d2, 'q.p.m2 >= 0.0', 'q'],
    ] as const) {
      const smt = await verifyOne(text, { engine: 'smt' });
      expect(smt.by(goal).code, name).toBe('verification/inconsistent-axioms');
      const m = await contextModel(text, name);
      const edge = m.all().find((e) => e.eClass === 'BindingConnectorAsUsage')!;
      const ctx = context === undefined ? undefined : m.all().find((e) => e.declaredName === context)!;
      const id = ctx ? `${edge.id}@${ctx.id}` : edge.id;
      const check = checkConstraints(m).find((c) => c.conflict === 'bind')!;
      expect([check.id, check.expression, check.result], name).toEqual([id, 'p.load == L', 'violated']);
      expect(check.message, name).toMatch(/the model states different values for the two there/);
      const row = checkConstraintsNumeric(m).find((r) => r.conflict === 'bind')!;
      expect([row.id, row.result], name).toEqual([id, 'violated']);
      const f = solveFeasible(m);
      expect([f.feasible, f.decided], name).toEqual([false, true]);
    }
    // Two defaults bound to each other state no value: neither is a fact, and
    // differing they are no contradiction either — the model is any load
    // equal to L. Read as both, it was called a contradiction on the check
    // and the numeric surface, infeasible, and the axioms inconsistent (k4).
    const k4 = `package K4 {
    part def Q {
      attribute L : ScalarValues::Real default = 1.0;
      attribute load : ScalarValues::Real default = 2.0;
      attribute m2 : ScalarValues::Real = 10.0 - load;
      bind load = L;
    }
    part q : Q;
    constraint m2Pos { q.m2 >= 0.0 } }`;
    const m4 = await contextModel(k4, 'K4');
    expect(checkConstraints(m4).map((c) => [c.expression, c.result, c.conflict])).toEqual([
      ['q.m2 >= 0.0', 'unknown', undefined],
    ]);
    expect(checkConstraintsNumeric(m4).filter((r) => r.conflict !== undefined)).toEqual([]);
    expect(analysisReport(m4).feasible).toBe(true);
    const smt4 = (await verifyOne(k4, { engine: 'smt' })).by('q.m2 >= 0.0');
    expect([smt4.claim, smt4.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
  });

  withZ3('names an unnamed redefinition by its effective qualified name, so `--free` reaches it', async () => {
    const text = R1('default =');
    const m = await contextModel(text, 'R1');
    const freed = resolveFreeFeatures(m, ['R1::p::load'], obligationsOf(m));
    expect([freed.unresolved, [...freed.qualifiedNames]]).toEqual([[], ['R1::p::load']]);
  });

  withZ3('reads consistency and bounds where a context changes what a derived value reads, at the context’s value', async () => {
    const r22 = `package R22 {
    part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    requirement r1 {
      subject s : P { attribute :>> load = 50.0; }
      require constraint c1 { s.load >= 10.0 }
      require constraint c2 { s.m2 <= 0.0 }
    } }`;
    // s's own load (50) and m2 (−40) meet both clauses.
    const c = await consistencyReport(await contextModel(r22, 'R22'), { withValues: true, sourceText: r22 });
    expect([c.consistent, c.inconsistent, c.exitCode]).toEqual([1, 0, 0]);
    const r23 = `package R23 {
    part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part p : P { attribute :>> load = 50.0; }
    attribute total : ScalarValues::Real = p.m2 * 2.0; }`;
    // total is twice p's m2: −80, not twice P's 9.
    const b = await boundsReport(await contextModel(r23, 'R23'), { measure: 'R23::total', sense: 'max', sourceText: r23 });
    expect([b.bounds.map((x) => [x.outcome, x.value]), b.exitCode]).toEqual([[['optimum', -80]], 0]);
  });
});

/*
 * PER-INSTANCE READINGS: FOUR SURFACES, ONE VERDICT (the ROADMAP item "Per-instance readings in the
 * check and the literal engine"; decisions 2, 10 and 13 of the soundness pass).
 *
 * A value a binding carries into ONE instance of a definition — Q's `bind p.load = L` with q's L of 50
 * — is that instance's own: q's p's m2 is 10 − 50. The numeric surface and the SMT engine read it at
 * the instance path (`q.p.m2`); the check and the literal engine abstain (decision 13). Where a derived
 * value or a second binding hid the binding from them, they read the definition's value instead and
 * published a FALSE verdict; they now read a bound partner only where every instance it stands for
 * reads it alike (`boundPartnerSafe`), and abstain elsewhere. This table pins every probe of that
 * work, row by row, on all four surfaces, as they stand, and states what each change must keep:
 *
 *  I1  no row is T on one surface and F on another;
 *  I2  a decided verdict is the hand-computed `ref` — except the rows of KNOWN_FALSE, false today and
 *      each named with the step that corrects it; the list is EXACT, so a row that stops being false
 *      fails here until it leaves the list;
 *  I3  every row, and its four verdicts, as they stand: the column a change moves is that change's diff;
 *  I4  every abstention says why;
 *  I5  a row has one element id on every surface that files it, the numeric surface's included;
 *  I6  the witness a literal or SMT row prints for each side of its relation that is one path is the
 *      value it compared (`bindings[].value` and the evidence record's `witness`, against `bound.si.lhs`
 *      and `.rhs`; one printed with a unit as its SI quantity) — except the rows of KNOWN_FALSE_WITNESS,
 *      listed exactly as I2's are;
 *      a witness printed with no value is not compared, and its rows are listed exactly too;
 *  I7  the SMT engine's `inconsistent-axioms` beside a T or F on another surface only where listed, with
 *      the reason — and only while it still happens, so the list cannot rot;
 *  I8  no engine files two rows under one name, one proved and the other refuted. A group's row for an
 *      instance and the row of the element that instance is (q2's `part :>> p { … }`) are both
 *      `{Rel} in q2::p` on the verify surface; such a name filed twice is keyed by each row's element id,
 *      as the check and the numeric surface key them, and this invariant reads the names as printed;
 *  I9  no engine files two rows under one name at all: an instance that is an element's own is that
 *      element's reading, and one a group of a more specific usage reads is that group's (O2 S2).
 *  I10 check ≡ verify: `sysml-check --strict` is never silent on a row literal or SMT refutes (PI-1).
 *  I11 the rows the check shares among instances read alike are the rows each instance's own reading
 *      gives (`withEveryInstanceJudged`), row for row, message and witness included (O2 S5's sharing);
 *  I12 a relation and its verbatim copy (`c` and `c__dup`, the same body beside it) give the same rows,
 *      per context and instance: verdict, abstention and the values read — so no reading of one relation
 *      takes what another worked out before it (Sh1's `m <= 10.0` read q2's p at q1's m, worked out for
 *      `m <= 1000.0`);
 *  I13 an instance row the SMT engine refutes with nothing freed, and the check decides otherwise — the
 *      witness the same-point gate demotes to `inconclusive` — only where listed, with the reason: both
 *      read the model's own point, so one of them is wrong (it was the signature of Sh1's false T).
 *
 * Letters, in the order check / literal / numeric / SMT: T holds (the literal engine's
 * `holds-at-values`), F violated or refuted, ? abstains, X inconsistent axioms, V vacuous, U a construct
 * outside the fragment, t the numeric surface's "imposed by the solve" (no decision), - no such row on
 * that surface. `ref`: T or F, the verdict decisions 1–13 give (H2: a literal default stands per usage);
 * ? no value (a contradiction, two defaults that differ, a valueless feature); - no such fact (a
 * conflict row that must not exist); null where the decisions settle nothing (out of scope: a
 * definition's feature bound from outside, an enclosing assert's value, a contradictory model).
 *
 * The probes are the design's, inlined; three more are pinned out of tree because of their size (r4cap's
 * 4,100 instances, perf9 and perf9b) with the rest of the probe corpus.
 */
describe('per-instance readings: four surfaces, one verdict', () => {
  type Letter = 'T' | 'F' | '?' | 'X' | 'V' | 'U' | 't' | '-';
  type Ref = 'T' | 'F' | '?' | '-' | null;
  /** One row as the four surfaces filed it. */
  interface SurfaceRow {
    /** check / literal / numeric / SMT. */
    verdicts: [Letter, Letter, Letter, Letter];
    /** Every element id a surface filed the row under. */
    ids: Set<string>;
    /** Why each abstaining surface abstained, by surface. */
    why: [string, string, string, string];
    /** I6: each printed witness that is not the value compared. */
    witness: string[];
    /** I6: each witness printed with no value (recorded, not compared). */
    unprinted: string[];
  }
  const SURFACES = ['check', 'literal', 'numeric', 'smt'] as const;
  const POINT: Record<string, Letter> = { satisfied: 'T', violated: 'F', unknown: '?' };
  const engineLetter = (r: ObligationVerdict): Letter =>
    r.claim === 'proved' || r.claim === 'holds-at-values'
      ? 'T'
      : r.claim === 'refuted'
        ? 'F'
        : r.claim === 'vacuous'
          ? 'V'
          : r.code === 'verification/inconsistent-axioms'
            ? 'X'
            : r.code === 'verification/unsupported-construct'
              ? 'U'
              : '?';
  const decided = (l: Letter) => l === 'T' || l === 'F';
  /** I8: per probe, each verify name an engine filed both proved and refuted (`literal: R in I`). */
  const bothWays = new Map<string, string[]>();
  /** I9: per probe, each verify name an engine filed more than once, with its letters. */
  const twice = new Map<string, string[]>();
  /** I10: per probe, each row literal or SMT refutes that `sysml-check --strict` names in no warning. */
  const unreported = new Map<string, string[]>();
  /** I11: per probe, each check row the shared reading gives otherwise than the instance's own reading. */
  const unshared = new Map<string, string[]>();
  /** I12: per probe, each row of a relation's verbatim copy that differs from the relation's own. */
  const copied = new Map<string, string[]>();
  /** I12: the relations each probe's copy run compared, so the invariant is not vacuous. */
  let copiedRelations = 0;

  /**
   * I12: `text` with every one-line relation `constraint c { … }` (not an `assert`, `assume` or `require`)
   * followed by its verbatim copy `constraint c__dup { … }`, checked: each copy's rows must be its
   * relation's — the verdict, the abstention and the values read, per context and instance.
   */
  async function copiedRows(text: string, pkg: string): Promise<void> {
    let any = false;
    const copy = text.replace(
      /(^|[^\w])(constraint\s+)([A-Za-z_]\w*)(\s*\{)([^{}\n]*)(\})/g,
      (all, before: string, kw: string, name: string, open: string, body: string, close: string, at: number, whole: string) => {
        if (/\b(?:assert|assume|require)\s*$/.test(whole.slice(Math.max(0, at - 12), at + before.length))) return all;
        // One the model names elsewhere (a redefinition `constraint :>> c2 { … }` in q2) is read otherwise there.
        if ((whole.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length > 1) return all;
        any = true;
        return `${all} ${kw}${name}__dup${open}${body}${close}`;
      },
    );
    if (!any) return;
    const { model: m } = await loadModelText(copy, { fileName: `${pkg}-copy.sysml` });
    if (!m) throw new Error(`${pkg}'s copy produced no model`);
    const qn = (id: string) => m.qualifiedName(id as ElementId) || id;
    const checks = checkConstraints(m);
    const byName = new Map(checks.map((c) => [qn(c.id), c]));
    const where = (i: SpecialisationInstance) => `${i.generic ? 'own ' : ''}${(i as { instance?: string }).instance ?? qn(i.contextId)}`;
    const sig = (i: SpecialisationInstance) =>
      `${i.result} ${i.abstention ?? ''} ${JSON.stringify((i.reads ?? []).map((r) => [r.path, r.value]))}`;
    const out: string[] = [];
    for (const [name, c] of byName) {
      const d = byName.get(`${name}__dup`);
      if (name.endsWith('__dup') || d === undefined) continue;
      copiedRelations++;
      if (c.result !== d.result) out.push(`${name}: ${c.result}, its copy ${d.result}`);
      const theirs = new Map((d.instances ?? []).map((i) => [where(i), i]));
      for (const i of c.instances ?? []) {
        const j = theirs.get(where(i));
        if (j === undefined) out.push(`${name} in ${where(i)}: no row of the copy`);
        else if (sig(i) !== sig(j)) out.push(`${name} in ${where(i)}: ${sig(i)}, its copy ${sig(j)}`);
      }
    }
    if (out.length > 0) copied.set(pkg, out);
  }

  /** Every row of a model on the four surfaces, by qualified name (`R in C` for a context's reading). */
  async function fourSurfaces(text: string, pkg: string): Promise<Map<string, SurfaceRow>> {
    // The model, and the report `sysml-check --strict` prints for the same text (I10).
    const { model: m, report } = await loadModelText(text, { fileName: `${pkg}.sysml`, strict: true });
    if (!m) throw new Error(`${pkg} produced no model`);
    const qn = (id: string) => m.qualifiedName(id as ElementId) || id;
    const key = (id: string) => {
      const [base, ctx] = id.split('@');
      return ctx === undefined ? qn(base!) : `${qn(base!)} in ${qn(ctx)}`;
    };
    // A group's generic row is named `{Rel} in {U} ({D}'s own)` on the verify
    // surface; the other surfaces file it `{Rel} in {U}` (its id is `${id}@${U}`).
    // Strip the suffix so one row is one row across all four surfaces.
    const norm = (q: string) => q.replace(/ \([^()]*'s own\)$/, '');
    const rows = new Map<string, SurfaceRow>();
    const put = (k: string, s: number, letter: Letter, id: string, why: string) => {
      let row = rows.get(k);
      if (!row) {
        row = { verdicts: ['-', '-', '-', '-'], ids: new Set(), why: ['', '', '', ''], witness: [], unprinted: [] };
        rows.set(k, row);
      }
      if (row.verdicts[s] !== '-') throw new Error(`${pkg}: two ${SURFACES[s]} rows are both ${k}`);
      row.verdicts[s] = letter;
      row.ids.add(id);
      if (!decided(letter)) row.why[s] = why;
    };
    // I10: each per-instance row the check files, by its id, with the check it belongs to.
    const filedBy = new Map<string, { check: ConstraintCheck; inst: SpecialisationInstance }>();
    const checks = checkConstraints(m);
    // I11: every row as each instance's own reading gives it, none taken from another read alike.
    const rowsOf = (list: ConstraintCheck[]) =>
      list.flatMap((c) => [
        `${key(c.id)}: ${c.result} | ${c.message}`,
        ...(c.instances ?? []).map(
          (i) =>
            `${key(c.id)} in ${(i as { instance?: string }).instance ?? qn(i.contextId)}: ${i.result} ${i.abstention ?? ''} ${i.cause ?? ''} | ` +
            `${i.message} | ${JSON.stringify(i.reads ?? null)}`,
        ),
      ]);
    const shared = rowsOf(checks);
    const full = rowsOf(withEveryInstanceJudged(() => checkConstraints(m)));
    const differ = shared.flatMap((row, k) => (row === full[k] ? [] : [`shared ${row} ≠ own ${full[k] ?? 'no row'}`]));
    if (differ.length > 0 || shared.length !== full.length) unshared.set(pkg, differ.length > 0 ? differ : ['a different number of rows']);
    // I12: the same model with each relation's body copied beside it under another name.
    await copiedRows(text, pkg);
    for (const c of checks) {
      put(c.conflict ? `${key(c.id)}#${c.conflict}` : key(c.id), 0, POINT[c.result]!, c.id, c.message);
      for (const i of c.instances ?? []) {
        // An instance row (plan F7: `instance`, its path as the solver spells it) is keyed and filed by
        // that path, as the other surfaces file it (`${id}@${path}`); a context's reading by the context.
        const at = (i as { instance?: string }).instance;
        put(`${key(c.id)} in ${at ?? qn(i.contextId)}`, 0, POINT[i.result]!, `${c.id}@${at ?? i.contextId}`, i.message);
        filedBy.set(`${c.id}@${at ?? i.contextId}`, { check: c, inst: i });
      }
    }
    for (const r of checkConstraintsNumeric(m)) {
      const k = r.conflict ? `${key(r.id)}#${r.conflict}` : key(r.id);
      put(k, 2, r.imposed ? 't' : POINT[r.result]!, r.id, r.reason ?? '');
    }
    for (const [s, engine] of [
      [1, 'literal'],
      [3, 'smt'],
    ] as const) {
      const report = await verifyModel(m, { engine, sourceText: text });
      // I8: a name filed twice is two rows (a group's instance row and the row of the element that
      // instance is), keyed by element id as the other surfaces key them; read here as printed.
      const printed = new Map<string, Letter[]>();
      for (const r of report.results) {
        const n = norm(r.clause.qualifiedName);
        printed.set(n, [...(printed.get(n) ?? []), engineLetter(r)]);
      }
      for (const [n, letters] of printed) {
        if (letters.includes('T') && letters.includes('F')) bothWays.set(pkg, [...(bothWays.get(pkg) ?? []), `${engine}: ${n}`]);
        if (letters.length > 1) twice.set(pkg, [...(twice.get(pkg) ?? []), `${engine}: ${n} ${letters.join('/')}`]);
      }
      // A generic row is keyed by its id too (`${id}@${U}`), as the other surfaces key it: for a usage with
      // no name of its own (Q2's `part :>> p : P2`) the verify name spells U's effective name, they its own.
      const rowKey = (r: ObligationVerdict) => {
        const n = norm(r.clause.qualifiedName);
        return printed.get(n)!.length > 1 || n !== r.clause.qualifiedName ? key(r.clause.id) : n;
      };
      for (const r of report.results) {
        put(rowKey(r), s, engineLetter(r), r.clause.id, r.detail);
        // I6: each side of the relation, where it is one bare path the row prints a value for — in the
        // row's bindings and in its evidence record. A value printed with a unit is compared as a quantity
        // (its SI value, as `bound.si` holds the compared sides); one printed with NO value is recorded,
        // not compared. A side that is a literal or an expression has no path of its own and is skipped.
        const si2 = r.bound.si;
        const split = /^(.*?)(?:<=|>=|==|!=|<|>)(.*)$/s.exec(r.expression);
        if (si2 === undefined || split === null) continue;
        const bare = (side: string) => /^\s*([A-Za-z_][\w.]*)\s*$/.exec(side)?.[1];
        const row = rows.get(rowKey(r))!;
        const record = report.records.find(
          (x) => x.obligation.clause === r.clause.qualifiedName && x.obligation.expression === r.expression,
        );
        for (const [path, compared, side] of [
          [bare(split[1]!), si2.lhs, 'lhs'],
          [bare(split[2]!), si2.rhs, 'rhs'],
        ] as const) {
          if (path === undefined) continue;
          for (const [where, b] of [
            ['bindings', r.bindings.find((x) => x.path === path)],
            ['record', record?.witness?.values.find((x) => x.path === path)],
          ] as const) {
            if (!b) continue;
            if (b.value === null || b.value === undefined) {
              row.unprinted.push(`${engine}: ${where}`);
              continue;
            }
            const unit = b.unit == null ? undefined : resolveUnit(b.unit);
            const si =
              typeof b.value !== 'number' || (b.unit != null && !unit)
                ? undefined
                : unit
                  ? b.value * unit.factorToSI + (unit.offsetSI ?? 0)
                  : b.value;
            const same =
              si !== undefined && (unit ? Math.abs(si - compared) <= 1e-12 * Math.max(1, Math.abs(compared)) : si === compared);
            if (!same)
              row.witness.push(
                `${engine}: ${where} ${side === 'rhs' ? '(rhs) ' : ''}${b.value}${b.unit == null ? '' : ` [${b.unit}]`} vs compared ${compared}`,
              );
          }
        }
      }
    }
    // I10 (check ≡ verify, PI-1): a row literal or SMT refutes fails `sysml-check --strict`, under a
    // warning that names it:
    //  - the relation's own row: a `constraint-violation` anchored at the relation;
    //  - any row read in an instance or a context: a constraint-by-instance finding naming that relation and
    //    that instance or context;
    //  - a group's row (an instance's, or the usage's own generic one) also: the group's roll-up listing
    //    it, or counting it among the violations it lists no path of — one row per such violation;
    //  - a context's row that met no binding also: a target-by-specialisation miss of the relation at the
    //    element that rule anchors that row's finding at — one row per such miss.
    // A fold of more than 20 contexts names none, and is matched by nobody: such a probe fails here until
    // it is read.
    const warned = report.diagnostics.filter((d) => d.severity === 'warning' || d.severity === 'error');
    const targetOf = (id: string) => {
      const el = m.get(id as ElementId);
      const owner = el?.ownerId != null ? m.get(el.ownerId) : undefined;
      const ownerName = owner?.declaredName ?? owner?.declaredShortName ?? `«${owner?.eClass}»`;
      const own = el?.declaredName ?? el?.declaredShortName;
      return own ? `${ownerName}::${own}` : `a constraint in ${ownerName}`;
    };
    // Per relation, the violations its roll-ups count and list no path of, not yet taken by a row; per
    // anchor and relation, the misses not yet taken.
    const unlisted = new Map<string, number>();
    for (const d of warned) {
      if (d.code !== 'validation/constraint-by-instance' || d.instances === undefined || d.relation === undefined) continue;
      unlisted.set(d.relation, (unlisted.get(d.relation) ?? 0) + d.instances.violated - d.instances.listed.length);
    }
    const missesTaken = new Map<string, number>();
    const silent: string[] = [];
    for (const [k, row] of rows) {
      if (row.verdicts[1] !== 'F' && row.verdicts[3] !== 'F') continue;
      const [base, at] = [...row.ids][0]!.split('@') as [string, string | undefined];
      if (at === undefined) {
        const own = warned.some(
          (d) => d.code === 'validation/constraint-violation' && d.elementId === base && d.instance === undefined && d.instances === undefined,
        );
        if (!own) silent.push(k);
        continue;
      }
      // Named as the findings name them: an unnamed element by what it redefines (Q2's `part :>> p` is
      // `Q2::p`, its row `… in Q2::«PartUsage»`).
      const rel = effectiveQualifiedName(m, base as ElementId);
      const where = m.get(at as ElementId) ? effectiveQualifiedName(m, at as ElementId) : at;
      const byCode = (code: string) => warned.filter((d) => d.code === code);
      if (byCode('validation/constraint-by-instance').some((d) => d.relation === rel && d.instance === where)) continue;
      const filed = [...row.ids].map((id) => filedBy.get(id)).find((x) => x !== undefined);
      if (filed !== undefined && (filed.inst.instance !== undefined || filed.inst.generic === true)) {
        const rollups = byCode('validation/constraint-by-instance').filter((d) => d.relation === rel && d.instances !== undefined);
        if (rollups.some((d) => d.instances!.listed.includes(where))) continue;
        const left = unlisted.get(rel) ?? 0;
        if (left > 0) {
          unlisted.set(rel, left - 1);
          continue;
        }
      } else if (filed !== undefined && filed.inst.via !== true) {
        const anchor = anchorFor(m, filed.check, filed.inst);
        const misses = byCode('validation/target-by-specialisation').filter(
          (d) => d.elementId === anchor && d.message.includes(` misses ${targetOf(base)} (`),
        ).length;
        const taken = missesTaken.get(`${anchor} ${base}`) ?? 0;
        if (taken < misses) {
          missesTaken.set(`${anchor} ${base}`, taken + 1);
          continue;
        }
      }
      silent.push(k);
    }
    const refuted = [...rows.values()].some((r) => r.verdicts[1] === 'F' || r.verdicts[3] === 'F');
    if (refuted && report.ok) silent.push('sysml-check --strict passes (exit 0)');
    if (silent.length > 0) unreported.set(pkg, silent);
    return rows;
  }

  const probe = (text: string, rows: Record<string, [string, Ref]>) => ({ text, rows });
  /** big-bind-N: N definitions Qk binding their p's load to their L, each Qk's usage qk setting L to k. */
  const bigBind = (n: number) =>
    [
      'package Big {',
      '  part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; constraint c { m2 <= 100.0 } }',
      ...Array.from({ length: n }, (_, k) => [
        `  part def Q${k} { attribute L : ScalarValues::Real default = 1.0; attribute K : ScalarValues::Real = 2.0; part p : P; bind p.load = L; }`,
        `  part q${k} : Q${k} { attribute :>> L = ${k}.0; }`,
        `  constraint k${k} { q${k}.p.m2 <= 5.0 }`,
      ]).flat(),
      '}',
    ].join('\n');
  /** A binding carried down `depth` usages: top's L of 50 is top.a.….a's load, so its m2 is −40. */
  const bindingChain = (depth: number) => {
    const path = `top.${Array.from({ length: depth }, () => 'a').join('.')}.m2`;
    return [
      'package Deep {',
      '  part def T0 { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }',
      ...Array.from(
        { length: depth },
        (_, i) =>
          `  part def T${i + 1} { attribute L : ScalarValues::Real default = 1.0; part a : T${i}; bind a.${i === 0 ? 'load' : 'L'} = L; }`,
      ),
      `  part top : T${depth} { attribute :>> L = 50.0; }`,
      `  constraint deepNegT { ${path} <= 0.0 }`,
      `  constraint deepPosF { ${path} >= 0.0 }`,
      '}',
    ].join('\n');
  };
  /**
   * A binding written ONCE, at package level, `depth − 1` usages down — `bind top.a.….a.L = X` into the T1
   * whose own `bind a.load = L` carries it into the T0 below: top.a.….a's load is X's 50, so its m2 is
   * −40. Past 32 segments the package frame is the one dropped (`heldDefaults`' segment cap), and it is the
   * one that carries the value — unlike `bindingChain`, whose every level re-binds.
   */
  const bindingChainPkg = (depth: number) => {
    const as = (n: number) => Array.from({ length: n }, () => 'a').join('.');
    return [
      `package DP${depth} {`,
      '  part def T0 { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }',
      '  part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; bind a.load = L; }',
      ...Array.from({ length: depth - 1 }, (_, i) => `  part def T${i + 2} { part a : T${i + 1}; }`),
      `  part top : T${depth};`,
      '  attribute X : ScalarValues::Real = 50.0;',
      `  bind top.${as(depth - 1)}.L = X;`,
      `  constraint negT { top.${as(depth)}.m2 <= 0.0 }`,
      `  constraint posF { top.${as(depth)}.m2 >= 0.0 }`,
      '}',
    ].join('\n');
  };

  /**
   * Each probe: its text, and per row `[check/literal/numeric/SMT as they stand, ref]`. The design's names:
   * the binding and default probes of the soundness pass (h2 … w3, r14, the cross-track c3c and c5), the
   * mapper's siblings and shared usages, the derived-partner series M1–M9, big-bind, the refutation round
   * (refute-*), a binding carried past 32 usages, the shapes the table's own review found (a package
   * binding past 32 segments, a usage-body binding whose type redefines an end, an asserted partner, the
   * M2 family with units, a specialised override or a sibling, a plain value against a binding), the
   * controls that must keep abstaining (k4 … n4), and the rows where the check decides and another
   * surface abstains (d1-dec-inst … c1-chain).
   */
  const PROBES: Record<string, { text: string; rows: Record<string, [string, Ref]> }> = {
    h2: probe(`package H2 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q : Q { attribute :>> L = 50.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'H2::m2NegT': ['T/T/T/T', 'T'],
      'H2::m2PosF': ['F/F/F/F', 'F'],
    }),
    h2h: probe(`package H2H {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part p : P;
        attribute L : ScalarValues::Real = 50.0;
        bind p.load = L;
        constraint m2NegT { p.m2 <= 0.0 }
        constraint m2PosF { p.m2 >= 0.0 }
      }`, {
      'H2H::m2NegT': ['T/T/T/T', 'T'],
      'H2H::m2PosF': ['F/F/F/F', 'F'],
    }),
    h2i: probe(`package H2I {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real = 50.0; part p : P; bind p.load = L; }
        part q : Q;
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'H2I::m2NegT': ['T/T/T/T', 'T'],
      'H2I::m2PosF': ['F/F/F/F', 'F'],
    }),
    h2c: probe(`package H2C {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          part p : P;
          bind p.load = L;
          constraint c { p.m2 >= 0.0 }
        }
        part q : Q { attribute :>> L = 50.0; }
      }`, {
      'H2C::Q::c': ['T/T/T/T', 'T'],
      'H2C::Q::c in H2C::q': ['F/F/F/F', 'F'],
    }),
    h2p: probe(`package H2P {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute m2 : ScalarValues::Real = 10.0 - load;
          constraint c { load <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q : Q { attribute :>> L = 50.0; }
      }`, {
      'H2P::P::c': ['T/T/T/T', 'T'],
      'H2P::P::c in H2P::Q::p': ['T/T/T/T', 'T'],
      'H2P::P::c in H2P::q::p': ['F/F/F/F', 'F'],
    }),
    k1: probe(`package K1 {
        attribute L : ScalarValues::Real = 50.0;
        attribute x : ScalarValues::Real;
        bind x = L;
        constraint c { x >= 40.0 }
      }`, {
      'K1::c': ['T/T/T/T', 'T'],
    }),
    k2: probe(`package K2 {
        part def P { attribute x : ScalarValues::Real; attribute m2 : ScalarValues::Real = 10.0 - x; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.x = L; constraint c { p.m2 >= 0.0 } }
        part q : Q { attribute :>> L = 50.0; }
        constraint d { q.p.m2 <= 0.0 }
      }`, {
      'K2::Q::c': ['T/T/T/T', 'T'],
      'K2::Q::c in K2::q': ['F/F/F/F', 'F'],
      'K2::d': ['T/T/T/T', 'T'],
    }),
    k2p: probe(`package K2P {
        part def P {
          attribute load : ScalarValues::Real;
          constraint c { load <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q : Q { attribute :>> L = 50.0; }
      }`, {
      'K2P::P::c': ['?/?/?/?', '?'],
    }),
    k3: probe(`package K3 {
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          attribute load : ScalarValues::Real default = 2.0;
          attribute m2 : ScalarValues::Real = 10.0 - load;
          bind load = L;
        }
        part q : Q { attribute :>> L = 50.0; }
        constraint dNegT { q.m2 <= 0.0 }
      }`, {
      'K3::dNegT': ['T/T/T/T', 'T'],
    }),
    k3b: probe(`package K3 {
          part def Q {
            attribute L : ScalarValues::Real default = 1.0;
            attribute load : ScalarValues::Real default = 2.0;
            attribute m2 : ScalarValues::Real = 10.0 - load;
            bind load = L;
          }
          part q : Q { attribute :>> L = 50.0; }
          constraint m2NegT { q.m2 <= 0.0 }
          constraint m2PosF { q.m2 >= 0.0 } }`, {
      'K3::m2NegT': ['T/T/T/T', 'T'],
      'K3::m2PosF': ['F/F/F/F', 'F'],
    }),
    k5: probe(`package K5 {
        attribute L : ScalarValues::Real = 50.0;
        attribute load : ScalarValues::Real default = 1.0;
        attribute m2 : ScalarValues::Real = 10.0 - load;
        bind load = L;
        constraint k { load == 7.0 }
        constraint n { m2 <= -30.0 }
      }`, {
      'K5::k': ['F/F/F/F', 'F'],
      'K5::n': ['T/T/T/T', 'T'],
    }),
    c2: probe(`package C2 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def R { attribute M : ScalarValues::Real default = 1.0; part q : Q; bind q.L = M; }
        part r : R { attribute :>> M = 50.0; }
        constraint m2NegT { r.q.p.m2 <= 0.0 }
        constraint m2PosF { r.q.p.m2 >= 0.0 }
      }`, {
      'C2::m2NegT': ['T/T/T/T', 'T'],
      'C2::m2PosF': ['F/F/F/F', 'F'],
    }),
    c3: probe(`package C3 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def R { attribute M : ScalarValues::Real = 50.0; part q : Q; bind q.L = M; }
        part r : R;
        constraint m2NegT { r.q.p.m2 <= 0.0 }
        constraint m2PosF { r.q.p.m2 >= 0.0 }
      }`, {
      'C3::m2NegT': ['T/T/T/T', 'T'],
      'C3::m2PosF': ['F/F/F/F', 'F'],
    }),
    c4: probe(`package C4 {
        part def Q {
          attribute A : ScalarValues::Real = 50.0;
          attribute B : ScalarValues::Real default = 1.0;
          attribute C : ScalarValues::Real default = 1.0;
          attribute m2 : ScalarValues::Real = 10.0 - C;
          bind B = A;
          bind C = B;
        }
        part q : Q;
        constraint m2NegT { q.m2 <= 0.0 }
        constraint m2PosF { q.m2 >= 0.0 }
      }`, {
      'C4::m2NegT': ['T/T/T/T', 'T'],
      'C4::m2PosF': ['F/F/F/F', 'F'],
    }),
    d1: probe(`package D1 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real = 50.0; part p : P; bind p.load = L; }
        part q : Q { part :>> p { attribute :>> load default = 30.0; } }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'D1::m2NegT': ['T/T/T/T', 'T'],
      'D1::m2PosF': ['F/F/F/F', 'F'],
    }),
    d1b: probe(`package D1b {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real = 50.0; part p : P; bind p.load = L; }
        part q : Q { part :>> p { attribute :>> load default = 30.0; } }
        constraint atL { q.p.m2 <= -30.0 }
        constraint at30 { q.p.m2 >= -30.0 }
      }`, {
      'D1b::at30': ['F/F/F/F', 'F'],
      'D1b::atL': ['T/T/T/T', 'T'],
    }),
    d3: probe(`package D3 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def P2 :> P { attribute :>> load default = 5.0; }
        part def Q { attribute L : ScalarValues::Real = 50.0; part p : P2; bind p.load = L; }
        part q : Q;
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'D3::m2NegT': ['T/T/T/T', 'T'],
      'D3::m2PosF': ['F/F/F/F', 'F'],
    }),
    d4: probe(`package D4 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute L : ScalarValues::Real = 50.0;
          part p : P { attribute :>> load default = 30.0; }
          bind p.load = L;
        }
        part q : Q;
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'D4::m2NegT': ['T/T/T/T', 'T'],
      'D4::m2PosF': ['F/F/F/F', 'F'],
    }),
    g2: probe(`package G2 {
        part def P { attribute load : ScalarValues::Real = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute L : ScalarValues::Real default = 7.0;
          attribute dL : ScalarValues::Real = L * 2.0;
          part p : P;
          bind p.load = L;
        }
        part q : Q;
        constraint dlT { q.dL <= 2.0 }
        constraint dlF { q.dL >= 10.0 }
      }`, {
      'G2::dlF': ['F/F/F/F', 'F'],
      'G2::dlT': ['T/T/T/T', 'T'],
    }),
    w2: probe(`package W2 {
        part def P { attribute load : ScalarValues::Real default = 5.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 50.0; }
        part q2 : Q;
        constraint c1 { q1.p.m2 <= 0.0 }
        constraint c2 { q2.p.m2 >= 0.0 }
        constraint c3 { q2.p.m2 <= 2.0 }
      }`, {
      'W2::c1': ['T/T/T/T', 'T'],
      'W2::c2': ['T/T/T/T', 'T'],
      'W2::c3': ['F/F/F/F', 'F'],
    }),
    w3: probe(`package W3 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real = 50.0; part p : P; }
        part q1 : Q { bind p.load = L; }
        part q2 : Q;
        constraint c1 { q1.p.m2 <= 0.0 }
        constraint c2 { q2.p.m2 >= 0.0 }
        constraint c3 { q2.p.m2 <= 5.0 }
      }`, {
      'W3::c1': ['T/T/T/T', 'T'],
      'W3::c2': ['T/T/T/T', 'T'],
      'W3::c3': ['F/F/F/F', 'F'],
    }),
    r14: probe(`package R14 {
          part def P { attribute load : ScalarValues::Real = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
          part p : P { attribute :>> load = 50.0; }
          attribute w : ScalarValues::Real;
          attribute w2 : ScalarValues::Real;
          bind w = p.load;
          bind w2 = p.m2;
          constraint wF { w <= 10.0 }
          constraint w2F { w2 >= 0.0 }
      }`, {
      'R14::p::«AttributeUsage»#binding': ['F/-/F/-', 'F'],
      'R14::w2F': ['?/?/?/?', '?'],
      'R14::wF': ['?/?/?/?', '?'],
    }),
    'r14-dflt': probe(`package R14 {
          part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
          part p : P { attribute :>> load = 50.0; }
          attribute w : ScalarValues::Real;
          attribute w2 : ScalarValues::Real;
          bind w = p.load;
          bind w2 = p.m2;
          constraint wF { w <= 10.0 }
          constraint w2F { w2 >= 0.0 }
      }`, {
      'R14::w2F': ['F/F/F/F', 'F'],
      'R14::wF': ['F/F/F/F', 'F'],
    }),
    'xtrack-c3c': probe(`package C3C {
          part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; attribute m3 : ScalarValues::Real = m2 * 2.0; }
          part p : P;
          attribute w : ScalarValues::Real;
          bind w = p.m3;
          constraint wF { w == 5.0 }
      }`, {
      'C3C::wF': ['F/F/F/F', 'F'],
    }),
    'xtrack-c5': probe(`package C5 {
          part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
          part def Top { part p : P; attribute w : ScalarValues::Real; bind w = p.m2; }
          part t : Top { part :>> p { attribute :>> load = 50.0; } }
          constraint wF { t.w == 18.0 }
      }`, {
      'C5::wF': ['F/F/F/F', 'F'],
    }),
    'mapper-s1': probe(`package S1 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q : Q { attribute :>> L = 50.0; }
        part q2 : Q;
        part other : P;
        constraint inQ2 { q2.p.m2 >= 0.0 }
        constraint inOther { other.m2 >= 0.0 }
        constraint inP { other.load <= 2.0 }
      }`, {
      'S1::inOther': ['T/T/T/T', 'T'],
      'S1::inP': ['T/T/T/T', 'T'],
      'S1::inQ2': ['T/T/T/T', 'T'],
    }),
    'mapper-s2': probe(`package S2 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute m2 : ScalarValues::Real = 10.0 - load;
          constraint c { m2 >= 0.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def R { part a : Q; part b : Q; attribute X : ScalarValues::Real default = 1.0; bind a.L = X; }
        part r1 : R { attribute :>> X = 50.0; }
        part r2 : R;
      }`, {
      'S2::P::c': ['T/T/T/T', 'T'],
      'S2::P::c in S2::Q::p': ['T/T/T/T', 'T'],
      'S2::P::c in S2::R::a::p': ['T/T/T/T', 'T'],
      'S2::P::c in S2::R::b::p': ['T/T/T/T', 'T'],
      'S2::P::c in S2::r1::a::p': ['F/F/F/F', 'F'],
      'S2::P::c in S2::r2::a::p': ['T/T/T/T', 'T'],
      'S2::P::c in S2::r1::b::p': ['T/T/T/T', 'T'],
      'S2::P::c in S2::r2::b::p': ['T/T/T/T', 'T'],
    }),
    'mapper-s3': probe(`package S3 {
        part def P { attribute x : ScalarValues::Real; constraint c { x >= 40.0 } }
        part def Q { attribute L : ScalarValues::Real = 50.0; part p : P; bind p.x = L; }
        part q : Q;
        constraint top { q.p.x >= 40.0 }
      }`, {
      'S3::P::c': ['?/?/?/?', '?'],
      'S3::top': ['T/T/T/T', 'T'],
    }),
    S1: probe(`package S1 {
        part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 50.0; }
        part q2 : Q { attribute :>> L = 3.0; }
        part q3 : Q;
        part p0 : P;
      }`, {
      'S1::P::c': ['T/T/T/T', 'T'],
      'S1::P::c in S1::Q::p': ['T/T/T/T', 'T'],
      'S1::P::c in S1::q1::p': ['F/F/F/F', 'F'],
      'S1::P::c in S1::q2::p': ['T/T/T/T', 'T'],
      'S1::P::c in S1::q3::p': ['T/T/T/T', 'T'],
    }),
    M1: probe(`package M1 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real default = 2.0 * K;
          part p : P;
          bind p.load = L;
        }
        part q : Q { attribute :>> L = 50.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'M1::m2NegT': ['T/T/T/T', 'T'],
      'M1::m2PosF': ['F/F/F/F', 'F'],
    }),
    M2: probe(`package M2 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          part p : P;
          bind p.load = L;
        }
        part q : Q { attribute :>> K = 25.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'M2::m2NegT': ['T/T/T/T', 'T'],
      'M2::m2PosF': ['F/F/F/F', 'F'],
    }),
    M2b: probe(`package M2b {
        part def P { attribute load : ScalarValues::Real default = 3.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          part p : P;
          bind p.load = L;
        }
        part q : Q { attribute :>> K = 25.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'M2b::m2NegT': ['T/T/T/T', 'T'],
      'M2b::m2PosF': ['F/F/F/F', 'F'],
    }),
    M3: probe(`package M3 {
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          attribute m2 : ScalarValues::Real = 10.0 - L;
        }
        part q : Q { attribute :>> K = 25.0; }
        constraint m2NegT { q.m2 <= 0.0 }
        constraint m2PosF { q.m2 >= 0.0 }
      }`, {
      'M3::m2NegT': ['T/T/T/T', 'T'],
      'M3::m2PosF': ['F/F/F/F', 'F'],
    }),
    // M3 with a second instance and the paths on the RIGHT: I6 compares each bare-path side, so q2's own 9.8
    // (not Q's 9) beside q's −40, and q's −40 as the right-hand side of a literal.
    M3R: probe(`package M3R {
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          attribute m2 : ScalarValues::Real = 10.0 - L;
        }
        part q : Q { attribute :>> K = 25.0; }
        part q2 : Q { attribute :>> K = 0.1; }
        constraint lowT { q.m2 <= q2.m2 }
        constraint lowF { q.m2 >= q2.m2 }
        constraint rhsT { 0.0 >= q.m2 }
        constraint rhsF { 0.0 <= q.m2 }
      }`, {
      'M3R::lowT': ['T/T/T/T', 'T'],
      'M3R::lowF': ['F/F/F/F', 'F'],
      'M3R::rhsT': ['T/T/T/T', 'T'],
      'M3R::rhsF': ['F/F/F/F', 'F'],
    }),
    M4: probe(`package M4 {
        part def P { attribute load : ScalarValues::Real; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          part p : P;
          bind p.load = L;
        }
        part q : Q { attribute :>> K = 25.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'M4::m2NegT': ['T/T/T/T', 'T'],
      'M4::m2PosF': ['F/F/F/F', 'F'],
    }),
    M5: probe(`package M5 {
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          attribute load : ScalarValues::Real;
          attribute m2 : ScalarValues::Real = 10.0 - load;
          bind load = L;
        }
        part q : Q { attribute :>> K = 25.0; }
        constraint m2NegT { q.m2 <= 0.0 }
        constraint m2PosF { q.m2 >= 0.0 }
      }`, {
      'M5::m2NegT': ['T/T/T/T', 'T'],
      'M5::m2PosF': ['F/F/F/F', 'F'],
    }),
    M6: probe(`package M6 {
        attribute K : ScalarValues::Real default = 0.5;
        attribute L : ScalarValues::Real = 2.0 * K;
        attribute load : ScalarValues::Real;
        bind load = L;
        constraint c1 { load <= 1.0 }
        constraint c2 { load >= 1.0 }
      }`, {
      'M6::c1': ['T/T/T/T', 'T'],
      'M6::c2': ['T/T/T/T', 'T'],
    }),
    M7: probe(`package M7 {
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          attribute load : ScalarValues::Real;
          bind load = L;
          constraint c { load <= 5.0 }
        }
        part q1 : Q;
        part q2 : Q { attribute :>> K = 25.0; }
      }`, {
      'M7::Q::c': ['T/T/T/T', 'T'],
      'M7::Q::c in M7::q2': ['?/?/?/?', 'F'],
    }),
    M8: probe(`package M8 {
        part def P {
          attribute load : ScalarValues::Real default = 3.0;
          constraint c { load <= 10.0 }
        }
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          part p : P;
          bind p.load = L;
        }
        part q : Q { attribute :>> K = 25.0; }
      }`, {
      'M8::P::c': ['T/T/T/T', 'T'],
      'M8::P::c in M8::Q::p': ['T/T/T/T', 'T'],
      'M8::P::c in M8::q::p': ['F/F/F/F', 'F'],
    }),
    M9: probe(`package M9 {
        part def P {
          attribute load : ScalarValues::Real default = 3.0;
          constraint c { load <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q : Q { attribute :>> L = 50.0; }
      }`, {
      'M9::P::c': ['T/T/T/T', 'T'],
      'M9::P::c in M9::Q::p': ['?/?/?/?', '?'],
      'M9::P::c in M9::q::p': ['F/F/F/F', 'F'],
    }),
    // Found by F1: a derived DEFAULT partner a usage overrides. Q's c read in q2 read Q's L of 1 for q2's
    // load, which is q2's own L of 50 (T/T/T/? before F1, and a false `#bind` in q2).
    M7dflt: probe(`package M7F {
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real default = 2.0 * K;
          attribute load : ScalarValues::Real;
          bind load = L;
          constraint c { load <= 5.0 }
        }
        part q1 : Q;
        part q2 : Q { attribute :>> L = 50.0; }
        constraint top { q2.load <= 5.0 }
      }`, {
      'M7F::Q::c': ['T/T/T/T', 'T'],
      'M7F::Q::c in M7F::q2': ['F/F/F/F', 'F'],
      'M7F::top': ['F/F/F/F', 'F'],
    }),
    bigBind5: probe(bigBind(5), {
      'Big::P::c': ['T/T/T/T', 'T'],
      'Big::P::c in Big::Q0::p': ['T/T/T/T', 'T'],
      'Big::P::c in Big::Q1::p': ['T/T/T/T', 'T'],
      'Big::P::c in Big::Q2::p': ['T/T/T/T', 'T'],
      'Big::P::c in Big::Q3::p': ['T/T/T/T', 'T'],
      'Big::P::c in Big::Q4::p': ['T/T/T/T', 'T'],
      'Big::P::c in Big::q0::p': ['T/T/T/T', 'T'],
      'Big::P::c in Big::q1::p': ['T/T/T/T', 'T'],
      'Big::P::c in Big::q2::p': ['T/T/T/T', 'T'],
      'Big::P::c in Big::q3::p': ['T/T/T/T', 'T'],
      'Big::P::c in Big::q4::p': ['T/T/T/T', 'T'],
      'Big::k0': ['F/F/F/F', 'F'],
      'Big::k1': ['F/F/F/F', 'F'],
      'Big::k2': ['F/F/F/F', 'F'],
      'Big::k3': ['F/F/F/F', 'F'],
      'Big::k4': ['F/F/F/F', 'F'],
    }),
    // q1 asserts `p.x == 50.0` over P's `x default = 2.0`: the assert stands over the default in q1's p
    // (H5's enclosing rule, plan J decision 14, U6), so q1's p's x is 50 on every surface — the own row top1
    // and q1's group row read it (F), q1's `tie` holds — while P's own x, Q's p's and q2's p's keep 2. The
    // SMT lane gives q1's p's x a variable of its own: one variable for x had made the default's axiom and
    // the assert contradict (T/T/T/X, I7), and every reading of q1's p's x abstained (A.2.4).
    'refute-r1': probe(`package R1 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute x : ScalarValues::Real default = 2.0;
          constraint c { load + x <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 3.0; assert constraint tie { p.x == 50.0 } }
        part q2 : Q;
        constraint top1 { q1.p.load + q1.p.x <= 10.0 }
      }`, {
      'R1::P::c': ['T/T/T/T', 'T'],
      'R1::P::c in R1::Q::p': ['T/T/T/T', 'T'],
      'R1::P::c in R1::q1::p': ['F/F/F/F', 'F'],
      'R1::P::c in R1::q2::p': ['T/T/T/T', 'T'],
      'R1::q1::tie': ['T/-/T/-', 'T'],
      'R1::top1': ['F/F/F/F', 'F'],
    }),
    // Two defaults a binding joins with no value beside them stand only as one CONSTANT (A.4 Part 0): R3a's
    // one `2.0 * K` read at a1.v and a2.v is 2 and 10, R3b's and R3c's two alike texts read two Ks. Agreed
    // by their text, they were read (T/T/T/X, F/F/F/X) and called a contradiction (`#bind`) until F1b.
    'refute-r3a': probe(`package R3a {
        part def A { attribute K : ScalarValues::Real default = 1.0; attribute v : ScalarValues::Real default = 2.0 * K; }
        part a1 : A;
        part a2 : A { attribute :>> K = 5.0; }
        bind a1.v = a2.v;
        constraint c1 { a1.v <= 3.0 }
        constraint c2 { a2.v >= 9.0 }
        constraint c3 { a1.v >= 9.0 }
      }`, {
      'R3a::c1': ['?/?/?/?', '?'],
      'R3a::c2': ['?/?/?/?', '?'],
      'R3a::c3': ['?/?/?/?', '?'],
    }),
    'refute-r3b': probe(`package R3b {
        part def A { attribute K : ScalarValues::Real default = 1.0; attribute v : ScalarValues::Real default = 2.0 * K; }
        part def B { attribute K : ScalarValues::Real default = 5.0; attribute w : ScalarValues::Real default = 2.0 * K; }
        part a : A;
        part b : B;
        bind a.v = b.w;
        constraint c1 { a.v <= 3.0 }
        constraint c2 { b.w >= 9.0 }
        constraint c3 { a.v >= 9.0 }
      }`, {
      'R3b::c1': ['?/?/?/?', '?'],
      'R3b::c2': ['?/?/?/?', '?'],
      'R3b::c3': ['?/?/?/?', '?'],
    }),
    'refute-r3c': probe(`package R3c {
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
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'R3c::m2NegT': ['?/?/?/?', '?'],
      'R3c::m2PosF': ['?/?/?/?', '?'],
    }),
    // Found by F1b's review. Both ends of a binding are written `default`, and each has an asserted equation
    // that defines it: every P asserts load = 7, every Q asserts L = 5. The check reads the asserted values,
    // so the binding is a contradiction — in Q's definition (GA6), in a usage's body (GA12), and between two
    // instances whose one default `2.0 * K` the binding holds (GA5B). A guard that skipped a pair whose ends
    // are both written `default` dropped it (and the model read feasible). The model contradicts itself, so
    // its other rows settle nothing. Each default gives way to its own asserted equation (H5, O5 S1): the
    // solve no longer pins load = 7 or L = 5 from a default, so it meets the two asserts and the binding
    // together and does not converge there (pa, qa numeric `?`); P's load is no end a value is carried
    // into, so GA12's per-instance pa rows (O2 S4) are gone, and Q's qa is read in GA12's q.
    'ga6-asserted-ends': probe(`package GA6 {
        part def P { attribute load : ScalarValues::Real default = 7.0; assert constraint pa { load == 7.0 } }
        part def Q { attribute L : ScalarValues::Real default = 5.0; assert constraint qa { L == 5.0 } part p : P; bind p.load = L; }
        part q : Q;
      }`, {
      'GA6::P::pa': ['T/-/?/-', null],
      'GA6::P::pa in GA6::Q::p': ['T/-/T/-', null],
      'GA6::Q::qa': ['T/-/?/-', null],
      'GA6::Q::«BindingConnectorAsUsage»#bind': ['F/-/F/-', 'F'],
    }),
    'ga12-asserted-ends-usage': probe(`package GA12 {
        part def P { attribute load : ScalarValues::Real default = 7.0; assert constraint pa { load == 7.0 } }
        part def Q { attribute L : ScalarValues::Real default = 5.0; assert constraint qa { L == 5.0 } part p : P; }
        part q : Q { bind p.load = L; }
      }`, {
      'GA12::P::pa': ['T/-/?/-', null],
      'GA12::Q::qa': ['T/-/?/-', null],
      'GA12::Q::qa in GA12::q': ['T/-/T/-', null],
      'GA12::q::«BindingConnectorAsUsage»#bind': ['F/-/F/-', 'F'],
    }),
    'ga5b-asserted-held-source': probe(`package GA5B {
        part def A { attribute K : ScalarValues::Real default = 1.0; attribute v : ScalarValues::Real default = 2.0 * K; }
        part a1 : A { attribute :>> K = 1.5; assert constraint x1 { v == 3.0 } }
        part a2 : A { attribute :>> K = 2.0; assert constraint x2 { v == 4.0 } }
        bind a1.v = a2.v;
        constraint c { a1.v <= 3.5 }
      }`, {
      'GA5B::«BindingConnectorAsUsage»#bind': ['F/-/F/-', 'F'],
      'GA5B::a1::x1': ['T/-/?/-', null],
      'GA5B::a2::x2': ['T/-/?/-', null],
      'GA5B::c': ['T/T/?/?', null],
    }),
    // F1b's reading beyond R3a–c, put to the user under H1 (plan J). (1) Two defaults alike in text that read
    // a name, bound to each other, are held even where every instance reads them alike — U1's one
    // `2.0 * K` at a1 and a2 (2 and 2; T/T/T/T and F/F/F/F before F1b), U6's in a definition, U8's Boolean
    // `K > 0.5` — and so are two alike quoted strings (U2; T on the check and the literal engine before):
    // the rule's constants are numbers, Booleans and expressions that read no name. Sound, not false.
    // (2) A held default's feature with an asserted equation is read at that equation (GA7's L = 5; F on the
    // check and numeric, judged at the alike defaults' 2, before F1b), as an asserted definition beside a
    // default the binding holds already was (GA6's qa); its `pl` (T/T/T/X before) abstained while
    // default-vs-assert was open. H5 (plan J decision 14, O5 S1): Q's asserted `L == 5.0` stands over L's
    // default, so the binding carries 5 into p's load and `pl` is F (ref F, U6). The numeric surface abstains
    // as it does with a plain `L = 5.0` there (P's `load default = 2.0 * K` behind the end copy is a derived
    // value it reads no value for at Q's p): an open gap, short of F's F/F/F/F.
    'u1-same-source-alike': probe(`package U1 {
        part def A { attribute K : ScalarValues::Real default = 1.0; attribute v : ScalarValues::Real default = 2.0 * K; }
        part a1 : A;
        part a2 : A;
        bind a1.v = a2.v;
        constraint c1 { a1.v <= 3.0 }
        constraint c3 { a1.v >= 9.0 }
      }`, {
      'U1::c1': ['?/?/?/?', 'T'],
      'U1::c3': ['?/?/?/?', 'F'],
    }),
    'u6-same-source-alike-def': probe(`package U6 {
        part def A { attribute K : ScalarValues::Real default = 1.0; attribute v : ScalarValues::Real default = 2.0 * K; }
        part def S { part a1 : A; part a2 : A; bind a1.v = a2.v; constraint c1 { a1.v <= 3.0 } }
        part s : S;
        constraint top { s.a1.v <= 3.0 }
      }`, {
      'U6::S::c1': ['?/?/?/?', 'T'],
      'U6::top': ['?/?/?/?', 'T'],
    }),
    'u8-same-source-boolean': probe(`package U8 {
        part def A { attribute K : ScalarValues::Real default = 1.0; attribute ok : ScalarValues::Boolean default = K > 0.5; }
        part a1 : A;
        part a2 : A;
        bind a1.ok = a2.ok;
        constraint c1 { a1.ok }
      }`, {
      'U8::c1': ['?/?/?/?', 'T'],
    }),
    'u2-string-defaults': probe(`package U2 {
        part def P { attribute nm : ScalarValues::String default = "x"; }
        part def Q { attribute n : ScalarValues::String default = "x"; part p : P; bind p.nm = n; constraint c { n == "x" } constraint d { p.nm == "x" } }
        part q : Q;
        constraint top { q.n == "x" }
      }`, {
      'U2::Q::c': ['?/U/?/U', 'T'],
      'U2::Q::d': ['?/U/?/U', 'T'],
      'U2::top': ['?/U/?/U', 'T'],
    }),
    'ga7-held-default-assert': probe(`package GA7 {
        part def P { attribute load : ScalarValues::Real default = 2.0 * K; attribute K : ScalarValues::Real default = 1.0; }
        part def Q {
          attribute L : ScalarValues::Real default = 2.0 * K;
          attribute K : ScalarValues::Real default = 1.0;
          assert constraint qa { L == 5.0 }
          part p : P;
          bind p.load = L;
          constraint pl { p.load <= 3.0 }
        }
        part q : Q;
      }`, {
      'GA7::Q::qa': ['T/-/T/-', null],
      'GA7::Q::pl': ['F/F/?/F', 'F'],
    }),
    'refute-r6': probe(`package R6 {
        part def P { attribute k : ScalarValues::Real default = 0.5; attribute load : ScalarValues::Real default = 2.0 * k; }
        part def Q { attribute w : ScalarValues::Real; part p : P; bind w = p.load; }
        part q1 : Q { part :>> p { attribute :>> k = 25.0; } }
        constraint wNegT { q1.w >= 40.0 }
        constraint wPosF { q1.w <= 2.0 }
      }`, {
      'R6::wNegT': ['T/T/T/T', 'T'],
      'R6::wPosF': ['F/F/F/F', 'F'],
    }),
    'refute-r8': probe(`package R8 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute N : ScalarValues::Real default = 1.0;
          attribute K : ScalarValues::Real = 0.5 * N;
          attribute L : ScalarValues::Real = 2.0 * K;
          part p : P;
          bind p.load = L;
        }
        part q : Q { attribute :>> N = 50.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'R8::m2NegT': ['T/T/T/T', 'T'],
      'R8::m2PosF': ['F/F/F/F', 'F'],
    }),
    // A renamed redefinition of a bound usage (`part pp :>> p` in q, under Q's `bind p.load = L`) is the slot the
    // binding fills: q's pp's load is q's L on every surface (H5 S4, E8), its own `default` giving way (R13b).
    'refute-r13': probe(`package R13 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q : Q { attribute :>> L = 50.0; part pp :>> p; }
        constraint m2NegT { q.pp.m2 <= 0.0 }
        constraint m2PosF { q.pp.m2 >= 0.0 }
      }`, {
      'R13::m2NegT': ['T/T/T/T', 'T'],
      'R13::m2PosF': ['F/F/F/F', 'F'],
    }),
    'refute-r13b': probe(`package R13b {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q : Q { attribute :>> L = 50.0; part pp :>> p { attribute :>> load default = 7.0; } }
        constraint m2NegT { q.pp.m2 <= 0.0 }
        constraint m2PosF { q.pp.m2 >= 0.0 }
      }`, {
      'R13b::m2NegT': ['T/T/T/T', 'T'],
      'R13b::m2PosF': ['F/F/F/F', 'F'],
    }),
    // A sibling of the renamed slot (`p3 : P`, unbound) reads its own default: the binding matches a path segment by
    // segment, never by the feature it ends at.
    'r13-sibling': probe(`package R13s {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; part p3 : P; bind p.load = L; }
        part q : Q { attribute :>> L = 50.0; part pp :>> p; }
        constraint sibT { q.p3.m2 >= 0.0 }
        constraint sibF { q.p3.m2 <= 0.0 }
        constraint m2NegT { q.pp.m2 <= 0.0 }
      }`, {
      'R13s::m2NegT': ['T/T/T/T', 'T'],
      'R13s::sibF': ['F/F/F/F', 'F'],
      'R13s::sibT': ['T/T/T/T', 'T'],
    }),
    'refute-r13c': probe(`package R13c {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q : Q { attribute M :>> L = 50.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'R13c::m2NegT': ['T/T/T/T', 'T'],
      'R13c::m2PosF': ['F/F/F/F', 'F'],
    }),
    'refute-r14b': probe(`package R14b {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          constraint c { load <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def Q2 :> Q { attribute :>> L = 50.0; }
        part q2 : Q;
      }`, {
      'R14b::P::c': ['T/T/T/T', 'T'],
      'R14b::P::c in R14b::Q::p': ['T/T/T/T', 'T'],
      'R14b::P::c in R14b::Q2::p': ['F/F/F/F', 'F'],
      'R14b::P::c in R14b::q2::p': ['T/T/T/T', 'T'],
    }),
    'refute-r14c': probe(`package R14c {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          constraint c { load <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def R {
          part q : Q { attribute :>> L = 50.0; }
          constraint inR { q.p.load <= 10.0 }
        }
        part def Q2 :> Q {
          attribute :>> L = 50.0;
          constraint inQ2 { p.load <= 10.0 }
        }
        part q2 : Q;
      }`, {
      'R14c::P::c': ['T/T/T/T', 'T'],
      'R14c::P::c in R14c::Q::p': ['T/T/T/T', 'T'],
      'R14c::P::c in R14c::R::q::p': ['F/F/F/F', 'F'],
      'R14c::P::c in R14c::Q2::p': ['F/F/F/F', 'F'],
      'R14c::P::c in R14c::q2::p': ['T/T/T/T', 'T'],
      'R14c::Q2::inQ2': ['F/F/F/F', 'F'],
      'R14c::R::inR': ['F/F/F/F', 'F'],
    }),
    'refute-r14d': probe(`package R14d {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          constraint c { load <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q2 : Q;
        package Inner {
          part q9 : Q { attribute :>> L = 50.0; }
          constraint inInner { q9.p.load <= 10.0 }
        }
      }`, {
      'R14d::Inner::inInner': ['F/F/F/F', 'F'],
      'R14d::P::c': ['T/T/T/T', 'T'],
      'R14d::P::c in R14d::Q::p': ['T/T/T/T', 'T'],
      'R14d::P::c in R14d::q2::p': ['T/T/T/T', 'T'],
      'R14d::P::c in R14d::Inner::q9::p': ['F/F/F/F', 'F'],
    }),
    'refute-r14e': probe(`package R14eLib {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          constraint c { load <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q2 : Q;
      }
      package R14eUse {
        part q9 : R14eLib::Q { attribute :>> L = 50.0; }
        constraint inUse { q9.p.load <= 10.0 }
      }`, {
      'R14eLib::P::c': ['T/T/T/T', 'T'],
      'R14eLib::P::c in R14eLib::Q::p': ['T/T/T/T', 'T'],
      'R14eLib::P::c in R14eLib::q2::p': ['T/T/T/T', 'T'],
      'R14eLib::P::c in R14eUse::q9::p': ['F/F/F/F', 'F'],
      'R14eUse::inUse': ['F/F/F/F', 'F'],
    }),
    'refute-r15': probe(`package R15 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute m2 : ScalarValues::Real = 10.0 - load;
          constraint c { m2 >= 0.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P[2]; bind p.load = L; }
        part q : Q { attribute :>> L = 50.0; }
        part qs : Q[3];
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
        constraint qsT { qs.p.m2 >= 0.0 }
      }`, {
      'R15::P::c': ['T/T/T/T', 'T'],
      'R15::P::c in R15::Q::p': ['T/T/T/T', 'T'],
      'R15::P::c in R15::q::p': ['F/F/F/F', 'F'],
      'R15::P::c in R15::qs::p': ['T/T/T/T', 'T'],
      'R15::m2NegT': ['T/T/T/T', 'T'],
      'R15::m2PosF': ['F/F/F/F', 'F'],
      'R15::qsT': ['T/T/T/T', 'T'],
    }),
    'refute-r16': probe(`package R16 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute N : ScalarValues::Real default = 1.0;
          attribute J : ScalarValues::Real default = 0.5 * N;
          attribute K : ScalarValues::Real;
          bind K = J;
          attribute L : ScalarValues::Real = 2.0 * K;
          part p : P;
          bind p.load = L;
        }
        part q : Q { attribute :>> N = 50.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'R16::m2NegT': ['T/T/T/T', 'T'],
      'R16::m2PosF': ['F/F/F/F', 'F'],
    }),
    'refute-r16b': probe(`package R16b {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute N : ScalarValues::Real default = 1.0;
          attribute J : ScalarValues::Real = 0.5 * N;
          attribute K : ScalarValues::Real;
          bind K = J;
          attribute L : ScalarValues::Real = 2.0 * K;
          part p : P;
          bind p.load = L;
        }
        part q : Q { attribute :>> N = 50.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'R16b::m2NegT': ['T/T/T/T', 'T'],
      'R16b::m2PosF': ['F/F/F/F', 'F'],
    }),
    'refute-r16c': probe(`package R16c {
        part def Q {
          attribute N : ScalarValues::Real default = 1.0;
          attribute J : ScalarValues::Real = 0.5 * N;
          attribute K : ScalarValues::Real;
          bind K = J;
          attribute m2 : ScalarValues::Real = 10.0 - 2.0 * K;
        }
        part q : Q { attribute :>> N = 50.0; }
        constraint m2NegT { q.m2 <= 0.0 }
        constraint m2PosF { q.m2 >= 0.0 }
      }`, {
      'R16c::m2NegT': ['T/T/T/T', 'T'],
      'R16c::m2PosF': ['F/F/F/F', 'F'],
    }),
    'refute-r17': probe(`package R17 {
        part def P { attribute load : ScalarValues::Real default = 1.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def R {
          attribute X : ScalarValues::Real default = 1.0;
          part q : Q {
            constraint c { p.load <= 10.0 }
          }
          bind q.L = X;
        }
        part r1 : R { attribute :>> X = 50.0; }
        part r2 : R;
        constraint top { r1.q.p.load <= 10.0 }
      }`, {
      'R17::R::q::c': ['T/T/T/T', 'T'],
      'R17::R::q::c in R17::r1::q': ['F/F/F/F', 'F'],
      'R17::R::q::c in R17::r2::q': ['T/T/T/T', 'T'],
      'R17::top': ['F/F/F/F', 'F'],
    }),
    'refute-r17c': probe(`package R17c {
        part def P { attribute load : ScalarValues::Real default = 1.0; }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          part p : P {
            constraint c2 { load <= 10.0 }
          }
          bind p.load = L;
        }
        part q : Q { attribute :>> L = 50.0; }
        constraint top { q.p.load <= 10.0 }
      }`, {
      'R17c::Q::p::c2': ['T/T/T/T', 'T'],
      'R17c::Q::p::c2 in R17c::q::p': ['F/F/F/F', 'F'],
      'R17c::top': ['F/F/F/F', 'F'],
    }),
    // PI-1: a relation a usage owns, read in its one other instance — a group of one — with no package
    // constraint beside it, so `sysml-check --strict` fails on that instance's finding or not at all (I10):
    // E's r17, the same one level down (R's q, r1's q), and in a specialising definition (Q2's p).
    'pi1-r17': probe(`package PI1 {
        part def P { attribute load : ScalarValues::Real default = 1.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P { constraint c2 { load <= 10.0 } } bind p.load = L; }
        part q1 : Q { attribute :>> L = 50.0; }
      }`, {
      'PI1::Q::p::c2': ['T/T/T/T', 'T'],
      'PI1::Q::p::c2 in PI1::q1::p': ['F/F/F/F', 'F'],
    }),
    'pi1-nested': probe(`package PI1N {
        part def P { attribute load : ScalarValues::Real default = 1.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def R {
          attribute X : ScalarValues::Real default = 1.0;
          part q : Q { constraint c { p.load <= 10.0 } }
          bind q.L = X;
        }
        part r1 : R { attribute :>> X = 50.0; }
      }`, {
      'PI1N::R::q::c': ['T/T/T/T', 'T'],
      'PI1N::R::q::c in PI1N::r1::q': ['F/F/F/F', 'F'],
    }),
    'pi1-spec': probe(`package PI1S {
        part def P { attribute load : ScalarValues::Real default = 1.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P { constraint c2 { load <= 10.0 } } bind p.load = L; }
        part def Q2 :> Q { attribute :>> L = 50.0; }
      }`, {
      'PI1S::Q::p::c2': ['T/T/T/T', 'T'],
      'PI1S::Q::p::c2 in PI1S::Q2::p': ['F/F/F/F', 'F'],
    }),
    // An instance whose only difference is a binding written in its own element (q2's `bind p.extra = E`,
    // whose implicit end copy is q2's p): no binding of an owner tells it apart, so no group and no context
    // listed it, and every surface published the own row alone — the model clean, q2's p at 1 + 20 > 10
    // (A-H3's coverage, PI-1's symptom). The binding reaching into a redefinition of the usage now makes it
    // a group (`boundAbove`), and the instance is read in its end copy: a relation the usage owns, with and
    // without a binding of the owner (body-bind-owned, -owned-free); a definition's, read in Q's p
    // (body-bind-def, A7's own shape with no package constraint beside it: A7N); two usages deep, from R's
    // usage r2 (-deep, -deep-owned); and from the package (-package).
    'body-bind-owned': probe(`package BBO {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0; }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          part p : P { constraint c2 { load + extra <= 10.0 } }
          bind p.load = L;
        }
        part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
      }`, {
      'BBO::Q::p::c2': ['T/T/T/T', 'T'],
      'BBO::Q::p::c2 in BBO::q2::p': ['F/F/F/F', 'F'],
    }),
    'body-bind-owned-free': probe(`package BBOF {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0; }
        part def Q { part p : P { constraint c2 { load + extra <= 10.0 } } }
        part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
      }`, {
      'BBOF::Q::p::c2': ['T/T/T/T', 'T'],
      'BBOF::Q::p::c2 in BBOF::q2::p': ['F/F/F/F', 'F'],
    }),
    'body-bind-def': probe(`package BBD {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0; constraint c { load + extra <= 10.0 } }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
      }`, {
      'BBD::P::c': ['T/T/T/T', 'T'],
      'BBD::P::c in BBD::Q::p': ['T/T/T/T', 'T'],
      'BBD::P::c in BBD::q2::p': ['F/F/F/F', 'F'],
    }),
    A7N: probe(`package A7N {
        part def P { attribute extra : ScalarValues::Real default = 0.0; constraint c { extra <= 10.0 } }
        part def Q { part p : P; }
        part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
      }`, {
      'A7N::P::c': ['T/T/T/T', 'T'],
      'A7N::P::c in A7N::Q::p': ['T/T/T/T', 'T'],
      'A7N::P::c in A7N::q2::p': ['F/F/F/F', 'F'],
    }),
    'body-bind-deep': probe(`package BBP {
        part def P { attribute extra : ScalarValues::Real default = 0.0; constraint c { extra <= 10.0 } }
        part def Q { part p : P; }
        part def R { part q : Q; }
        part r2 : R { attribute E : ScalarValues::Real = 20.0; bind q.p.extra = E; }
      }`, {
      'BBP::P::c': ['T/T/T/T', 'T'],
      'BBP::P::c in BBP::Q::p': ['T/T/T/T', 'T'],
      'BBP::P::c in BBP::R::q::p': ['T/T/T/T', 'T'],
      'BBP::P::c in BBP::r2::q::p': ['F/F/F/F', 'F'],
    }),
    'body-bind-deep-owned': probe(`package BBPO {
        part def P { attribute extra : ScalarValues::Real default = 0.0; }
        part def Q { part p : P { constraint c2 { extra <= 10.0 } } }
        part def R { part q : Q; }
        part r2 : R { attribute E : ScalarValues::Real = 20.0; bind q.p.extra = E; }
      }`, {
      'BBPO::Q::p::c2': ['T/T/T/T', 'T'],
      'BBPO::Q::p::c2 in BBPO::R::q::p': ['T/T/T/T', 'T'],
      'BBPO::Q::p::c2 in BBPO::r2::q::p': ['F/F/F/F', 'F'],
    }),
    'body-bind-package': probe(`package BBK {
        part def P { attribute extra : ScalarValues::Real default = 0.0; constraint c { extra <= 10.0 } }
        part def Q { part p : P; }
        part q2 : Q;
        attribute E : ScalarValues::Real = 20.0;
        bind q2.p.extra = E;
      }`, {
      'BBK::P::c': ['T/T/T/T', 'T'],
      'BBK::P::c in BBK::Q::p': ['T/T/T/T', 'T'],
      'BBK::P::c in BBK::q2::p': ['F/F/F/F', 'F'],
    }),
    'refute-r18': probe(`package R18 {
        calc def Twice { in x : ScalarValues::Real; return r : ScalarValues::Real = 2.0 * x; }
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = Twice(K);
          part p : P;
          bind p.load = L;
        }
        part q : Q { attribute :>> K = 25.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'R18::m2NegT': ['?/?/?/?', 'T'],
      'R18::m2PosF': ['?/?/?/?', 'F'],
    }),
    'refute-r19': probe(`package R19 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute m2 : ScalarValues::Real = 10.0 - load;
          constraint c { m2 >= 0.0 }
        }
        part def P2 :> P { attribute :>> load default = 3.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P2; bind p.load = L; }
        part q1 : Q { attribute :>> L = 50.0; }
        part q2 : Q;
        part solo : P2;
        constraint soloT { solo.m2 >= 0.0 }
        constraint q2T { q2.p.m2 >= 0.0 }
      }`, {
      'R19::P::c': ['T/T/T/T', 'T'],
      'R19::P::c in R19::P2': ['T/T/T/T', 'T'],
      'R19::P::c in R19::Q::p': ['?/?/?/?', '?'],
      'R19::P::c in R19::q1::p': ['F/F/F/F', 'F'],
      'R19::P::c in R19::q2::p': ['?/?/?/?', '?'],
      'R19::P::c in R19::solo': ['T/T/T/T', 'T'],
      'R19::q2T': ['?/?/?/?', '?'],
      'R19::soloT': ['T/T/T/T', 'T'],
    }),
    // Found by the 2026-10-14 review (A1–A9, A-C1): an instance of a shared usage whose own element reads the
    // relation through ANOTHER feature or source than the usage — a redefinition with a value of its own (A1,
    // A2), a specialised type (A3), a binding written in the instance's body (A4), a nested override (A6),
    // under a usage-owned relation (A9). The group read every instance through the usage's features and
    // published P's `extra` of 0 for an instance that states 20: T on all four surfaces where it is F, beside
    // the row of the element that instance is, refuted under the same name (I8). O2 S1 had those rows abstain
    // (A.7's coverage guard); O2 S2 reads each in that element at the instance — 1 + 20 > 10, F on every
    // surface — and the element's own row is that row, filed once (I9). A4's SMT `inconsistent-axioms` on every
    // row came from its q2 row read through Q's p, which asserted P's default of 0 for q2's extra against q2's
    // binding: read in q2's own p (the implicit end copy, which states no default) it is gone. A5 (the value
    // carried by the usage's own binding) and A8 are controls that keep their verdicts; A7, whose q2 differs by
    // its own binding alone, was read for Q's p by no surface until O2 S4 made Q's p a group (its q2 row is F,
    // as `top` is). A3L: where q2 sets L,
    // Q2's p is a group of its own, below Q's p; each instance is read once, by the group of the more specific
    // usage. A2E: q2 asserts a relation over its p's load; read in q2's p, which reads none of q2's asserts, the
    // row abstains (`enclosing-assert`, A.2.4).
    'A1-redef-in-instance': probe(`package A1 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q : Q { attribute :>> L = 2.0; part :>> p { attribute :>> extra = 20.0; } }
      }`, {
      'A1::P::c': ['T/T/T/T', 'T'],
      'A1::P::c in A1::Q::p': ['T/T/T/T', 'T'],
      'A1::P::c in A1::q::p': ['F/F/F/F', 'F'],
    }),
    'A2-redef-in-instance-noL': probe(`package A2 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { part :>> p { attribute :>> extra = 20.0; } }
      }`, {
      'A2::P::c': ['T/T/T/T', 'T'],
      'A2::P::c in A2::Q::p': ['T/T/T/T', 'T'],
      'A2::P::c in A2::q1::p': ['T/T/T/T', 'T'],
      'A2::P::c in A2::q2::p': ['F/F/F/F', 'F'],
    }),
    'A2E-enclosing-assert': probe(`package A2E {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { part :>> p { attribute :>> extra = 20.0; } assert constraint { p.load >= 0.5 } }
      }`, {
      'A2E::P::c': ['T/T/T/T', 'T'],
      'A2E::P::c in A2E::Q::p': ['T/T/T/T', 'T'],
      'A2E::P::c in A2E::q1::p': ['T/T/T/T', 'T'],
      'A2E::P::c in A2E::q2::p': ['?/?/?/?', 'F'],
      'A2E::q2::«ConstraintUsage»': ['T/-/T/-', 'T'],
    }),
    'A3-spec-type': probe(`package A3 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
        part def P2 :> P { attribute :>> extra = 20.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def Q2 :> Q { part :>> p : P2; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q2;
      }`, {
      'A3::P::c': ['T/T/T/T', 'T'],
      'A3::P::c in A3::P2': ['F/F/F/F', 'F'],
      'A3::P::c in A3::Q::p': ['T/T/T/T', 'T'],
      'A3::P::c in A3::Q2::p': ['F/F/F/F', 'F'],
      'A3::P::c in A3::q1::p': ['T/T/T/T', 'T'],
      'A3::P::c in A3::q2::p': ['F/F/F/F', 'F'],
    }),
    'A3L-spec-type-L': probe(`package A3L {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
        part def P2 :> P { attribute :>> extra = 20.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def Q2 :> Q { part :>> p : P2; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q2 { attribute :>> L = 2.0; }
      }`, {
      'A3L::P::c': ['T/T/T/T', 'T'],
      'A3L::P::c in A3L::P2': ['F/F/F/F', 'F'],
      'A3L::P::c in A3L::Q::p': ['T/T/T/T', 'T'],
      'A3L::P::c in A3L::Q2::«PartUsage»': ['F/F/F/F', 'F'],
      'A3L::P::c in A3L::q1::p': ['T/T/T/T', 'T'],
      'A3L::P::c in A3L::q2::p': ['F/F/F/F', 'F'],
    }),
    'A4-second-binding': probe(`package A4 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
      }`, {
      'A4::P::c': ['T/T/T/T', 'T'],
      'A4::P::c in A4::Q::p': ['T/T/T/T', 'T'],
      'A4::P::c in A4::q1::p': ['T/T/T/T', 'T'],
      'A4::P::c in A4::q2::p': ['F/F/F/F', 'F'],
    }),
    'A5-instance-assert': probe(`package A5 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real;
          constraint c { load + extra <= 10.0 }
        }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          attribute X : ScalarValues::Real default = 0.0;
          part p : P;
          bind p.load = L;
          bind p.extra = X;
        }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { attribute :>> X = 20.0; }
      }`, {
      'A5::P::c': ['?/?/?/?', '?'],
      'A5::P::c in A5::Q::p': ['T/T/T/T', 'T'],
      'A5::P::c in A5::q1::p': ['T/T/T/T', 'T'],
      'A5::P::c in A5::q2::p': ['F/F/F/F', 'F'],
    }),
    'A6-nested': probe(`package A6 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def R { part q : Q; }
        part r1 : R { part :>> q { attribute :>> L = 2.0; } }
        part r2 : R { part :>> q { part :>> p { attribute :>> extra = 20.0; } } }
      }`, {
      'A6::P::c': ['T/T/T/T', 'T'],
      'A6::P::c in A6::Q::p': ['T/T/T/T', 'T'],
      'A6::P::c in A6::R::q::p': ['T/T/T/T', 'T'],
      'A6::P::c in A6::r1::q::p': ['T/T/T/T', 'T'],
      'A6::P::c in A6::r2::q::p': ['F/F/F/F', 'F'],
    }),
    'A7-body-binding-default': probe(`package A7 {
        part def P { attribute extra : ScalarValues::Real default = 0.0; constraint c { extra <= 10.0 } }
        part def Q { part p : P; }
        part q2 : Q { attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
        constraint top { q2.p.extra <= 10.0 }
      }`, {
      'A7::P::c': ['T/T/T/T', 'T'],
      'A7::P::c in A7::Q::p': ['T/T/T/T', 'T'],
      'A7::P::c in A7::q2::p': ['F/F/F/F', 'F'],
      'A7::top': ['F/F/F/F', 'F'],
    }),
    'A8-body-binding-default-def': probe(`package A8 {
        part def P { attribute extra : ScalarValues::Real default = 0.0; constraint c { extra <= 10.0 } }
        part def Q { part p : P; attribute E : ScalarValues::Real = 20.0; bind p.extra = E; }
        part q2 : Q;
        constraint top { q2.p.extra <= 10.0 }
      }`, {
      'A8::P::c': ['T/T/T/T', 'T'],
      'A8::P::c in A8::Q::p': ['F/F/F/F', 'F'],
      'A8::top': ['F/F/F/F', 'F'],
    }),
    'A9-owned-redef': probe(`package A9 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute extra : ScalarValues::Real default = 0.0; }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          part p : P { constraint c2 { load + extra <= 10.0 } }
          bind p.load = L;
        }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { part :>> p { attribute :>> extra = 20.0; } }
        constraint top { q2.p.load + q2.p.extra <= 10.0 }
      }`, {
      'A9::Q::p::c2': ['T/T/T/T', 'T'],
      'A9::Q::p::c2 in A9::q1::p': ['T/T/T/T', 'T'],
      'A9::Q::p::c2 in A9::q2::p': ['F/F/F/F', 'F'],
      'A9::top': ['F/F/F/F', 'F'],
    }),
    // Found by the review of O2 S6 (its U5, U8, U9, V1, V4): a value a binding carries into an instance, with a
    // unit, was read as the number its source writes and compared as one — q1's `L = 20.0 [kg]` against P's `cap
    // = 10000.0 [g]` as 20 <= 10000, held on all four surfaces (U8; the same in a usage's own relation, U9, and
    // through a package binding, V1/V4, where the check and the literal engine abstained at 7277a97); q1's `L =
    // 5000.0 [g]` against 10 [kg] as 5000, violated where it holds (U5). The value is now read in the unit the
    // feature it fills declares (P's `load`, kg, the binding's end copy included), the body in units with it, and
    // the solver lane stores the end copy in that unit. U1 is the bare-literal contract over such a value: the
    // literal is read in `load`'s declared unit, as for every value of it (5000 g is 5 kg <= 10).
    'U5-bound-unit-two-features': probe(`package U5 {
        part def P { attribute load : ISQ::MassValue default = 1.0 [SI::kg]; attribute cap : ISQ::MassValue = 10.0 [SI::kg]; constraint c { load <= cap } }
        part def Q { attribute L : ISQ::MassValue default = 1.0 [SI::kg]; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 5000.0 [SI::g]; }
        part q2 : Q { attribute :>> L = 50000.0 [SI::g]; }
      }`, {
      'U5::P::c': ['T/T/T/T', 'T'],
      'U5::P::c in U5::Q::p': ['T/T/T/T', 'T'],
      'U5::P::c in U5::q1::p': ['T/T/T/T', 'T'],
      'U5::P::c in U5::q2::p': ['F/F/F/F', 'F'],
    }),
    'U8-bound-unit-false-T': probe(`package U8 {
        part def P { attribute load : ISQ::MassValue default = 1.0 [SI::kg]; attribute cap : ISQ::MassValue = 10000.0 [SI::g]; constraint c { load <= cap } }
        part def Q { attribute L : ISQ::MassValue default = 1.0 [SI::kg]; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 20.0 [SI::kg]; }
        part q2 : Q { attribute :>> L = 5.0 [SI::kg]; }
        constraint top1 { q1.p.load <= q1.p.cap }
      }`, {
      'U8::P::c': ['T/T/T/T', 'T'],
      'U8::P::c in U8::Q::p': ['T/T/T/T', 'T'],
      'U8::P::c in U8::q1::p': ['F/F/F/F', 'F'],
      'U8::P::c in U8::q2::p': ['T/T/T/T', 'T'],
      'U8::top1': ['F/F/F/F', 'F'],
    }),
    'U9-bound-unit-single': probe(`package U9 {
        part def P { attribute load : ISQ::MassValue default = 1.0 [SI::kg]; attribute cap : ISQ::MassValue = 10000.0 [SI::g]; }
        part def Q { attribute L : ISQ::MassValue default = 1.0 [SI::kg]; part p : P { constraint c2 { load <= cap } } bind p.load = L; }
        part q1 : Q { attribute :>> L = 20.0 [SI::kg]; }
      }`, {
      'U9::Q::p::c2': ['T/T/T/T', 'T'],
      'U9::Q::p::c2 in U9::q1::p': ['F/F/F/F', 'F'],
    }),
    'V1-bound-unit-package': probe(`package V1 {
        part def P { attribute load : ISQ::MassValue default = 1.0 [SI::kg]; attribute cap : ISQ::MassValue = 10000.0 [SI::g]; }
        part p1 : P;
        attribute L : ISQ::MassValue = 20.0 [SI::kg];
        bind p1.load = L;
        constraint top1 { p1.load <= p1.cap }
      }`, {
      'V1::top1': ['F/F/F/F', 'F'],
    }),
    'V4-bound-unit-valueless': probe(`package V4 {
        part def P { attribute load : ISQ::MassValue; attribute cap : ISQ::MassValue = 10000.0 [SI::g]; }
        part p1 : P;
        attribute L : ISQ::MassValue = 20.0 [SI::kg];
        bind p1.load = L;
        constraint top1 { p1.load <= p1.cap }
      }`, {
      'V4::top1': ['F/F/F/F', 'F'],
    }),
    'U1-bound-unit-bare-literal': probe(`package U1 {
        part def P { attribute load : ISQ::MassValue default = 1.0 [SI::kg]; constraint c { load <= 10.0 } }
        part def Q { attribute L : ISQ::MassValue default = 1.0 [SI::kg]; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 5000.0 [SI::g]; }
        part q2 : Q { attribute :>> L = 50000.0 [SI::g]; }
        part q3 : Q { attribute :>> L = 5.0 [SI::kg]; }
      }`, {
      'U1::P::c': ['T/T/T/T', 'T'],
      'U1::P::c in U1::Q::p': ['T/T/T/T', 'T'],
      'U1::P::c in U1::q1::p': ['T/T/T/T', 'T'],
      'U1::P::c in U1::q2::p': ['F/F/F/F', 'F'],
      'U1::P::c in U1::q3::p': ['T/T/T/T', 'T'],
    }),
    // Found by the review of O2 S2. DM1–DM4, DN1, DN2 (the review's M1, M2, N1, N2, and two more): an instance on
    // whose path a name is inherited twice, neither feature redefining the other — `part def Q3 :> Q2, Q4` over
    // Q2's `part :>> p : P2` and Q4's `part :>> p : P4` (DM1; DM2 with bodies; DM3 where Q3's own `part :>> p;`
    // redefines Q's p only; DM4 where Q2's and Q4's p are groups of their own), a usage typed by both (DN1), the
    // same one level down (DN2). Every Q3 is a Q2 and a Q4, so its p is P2's and P4's at once: 1 + 0.5 + 20 > 10.
    // The denote walk reads it through one of them (Q2's), and S2's first cut read the row there, T on all four
    // surfaces; the row abstains, as at S1 (no one element stands for it), and no group of one of the features
    // takes it. CI1, CI2, CH1, CH2 (the review's I1, I2, H1, H2): a name two values the context inherits collide
    // under (Q2's p, typed P2, inherits P2's `:>> extra = 9.5` and the end copy of Q's `bind p.extra = X`) has no
    // value; since F5 the per-instance reading read it through the binding instead, at X's default of 0 — T where
    // it is F (P2's 9.5 is a binding X gives way to), and T where the defaults differ (CH1, `?`). It reads
    // nothing through the binding now, on every surface. CI1's context row is split, as X11's is: the check and
    // the numeric surface name Q2's unnamed p by its qualified name, the verify surface by its effective name.
    'DM1-diamond': probe(`package DM1 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          attribute extra2 : ScalarValues::Real default = 0.0;
          constraint c { load + extra + extra2 <= 10.0 }
        }
        part def P2 :> P { attribute :>> extra = 0.5; }
        part def P4 :> P { attribute :>> extra2 = 20.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def Q2 :> Q { part :>> p : P2; }
        part def Q4 :> Q { part :>> p : P4; }
        part def Q3 :> Q2, Q4;
        part q1 : Q { attribute :>> L = 2.0; }
        part q3 : Q3;
      }`, {
      'DM1::P::c': ['T/T/T/T', 'T'],
      'DM1::P::c in DM1::P2': ['T/T/T/T', 'T'],
      'DM1::P::c in DM1::P4': ['F/F/F/F', 'F'],
      'DM1::P::c in DM1::Q::p': ['T/T/T/T', 'T'],
      'DM1::P::c in DM1::q1::p': ['T/T/T/T', 'T'],
      'DM1::P::c in DM1::Q2::p': ['T/T/T/T', 'T'],
      'DM1::P::c in DM1::Q3::p': ['?/?/?/?', 'F'],
      'DM1::P::c in DM1::q3::p': ['?/?/?/?', 'F'],
      'DM1::P::c in DM1::Q4::p': ['F/F/F/F', 'F'],
    }),
    'DM2-diamond-own': probe(`package DM2 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          attribute extra2 : ScalarValues::Real default = 0.0;
          constraint c { load + extra + extra2 <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def Q2 :> Q { part :>> p { attribute :>> extra = 0.5; } }
        part def Q4 :> Q { part :>> p { attribute :>> extra2 = 20.0; } }
        part def Q3 :> Q2, Q4;
        part q1 : Q { attribute :>> L = 2.0; }
        part q3 : Q3;
      }`, {
      'DM2::P::c': ['T/T/T/T', 'T'],
      'DM2::P::c in DM2::Q::p': ['T/T/T/T', 'T'],
      'DM2::P::c in DM2::q1::p': ['T/T/T/T', 'T'],
      'DM2::P::c in DM2::Q2::p': ['T/T/T/T', 'T'],
      'DM2::P::c in DM2::Q3::p': ['?/?/?/?', 'F'],
      'DM2::P::c in DM2::q3::p': ['?/?/?/?', 'F'],
      'DM2::P::c in DM2::Q4::p': ['F/F/F/F', 'F'],
    }),
    'DM3-diamond-own-redef': probe(`package DM3 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          attribute extra2 : ScalarValues::Real default = 0.0;
          constraint c { load + extra + extra2 <= 10.0 }
        }
        part def P2 :> P { attribute :>> extra = 0.5; }
        part def P4 :> P { attribute :>> extra2 = 20.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def Q2 :> Q { part :>> p : P2; }
        part def Q4 :> Q { part :>> p : P4; }
        part def Q3 :> Q2, Q4 { part :>> p; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q3 : Q3;
      }`, {
      'DM3::P::c': ['T/T/T/T', 'T'],
      'DM3::P::c in DM3::P2': ['T/T/T/T', 'T'],
      'DM3::P::c in DM3::P4': ['F/F/F/F', 'F'],
      'DM3::P::c in DM3::Q::p': ['T/T/T/T', 'T'],
      'DM3::P::c in DM3::q1::p': ['T/T/T/T', 'T'],
      'DM3::P::c in DM3::Q2::p': ['T/T/T/T', 'T'],
      'DM3::P::c in DM3::Q3::p': ['?/?/?/?', 'F'],
      'DM3::P::c in DM3::q3::p': ['?/?/?/?', 'F'],
      'DM3::P::c in DM3::Q4::p': ['F/F/F/F', 'F'],
    }),
    'DM4-diamond-groups': probe(`package DM4 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          attribute extra2 : ScalarValues::Real default = 0.0;
          constraint c { load + extra + extra2 <= 10.0 }
        }
        part def P2 :> P { attribute :>> extra = 0.5; }
        part def P4 :> P { attribute :>> extra2 = 20.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def Q2 :> Q { part :>> p : P2; }
        part def Q4 :> Q { part :>> p : P4; }
        part def Q3 :> Q2, Q4;
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q2 { attribute :>> L = 2.0; }
        part q4 : Q4 { attribute :>> L = 2.0; }
        part q3 : Q3;
      }`, {
      'DM4::P::c': ['T/T/T/T', 'T'],
      'DM4::P::c in DM4::P2': ['T/T/T/T', 'T'],
      'DM4::P::c in DM4::P4': ['F/F/F/F', 'F'],
      'DM4::P::c in DM4::Q::p': ['T/T/T/T', 'T'],
      'DM4::P::c in DM4::q1::p': ['T/T/T/T', 'T'],
      'DM4::P::c in DM4::Q2::«PartUsage»': ['T/T/T/T', 'T'],
      'DM4::P::c in DM4::q2::p': ['T/T/T/T', 'T'],
      'DM4::P::c in DM4::Q3::p': ['?/?/?/?', 'F'],
      'DM4::P::c in DM4::q3::p': ['?/?/?/?', 'F'],
      'DM4::P::c in DM4::Q4::«PartUsage»': ['F/F/F/F', 'F'],
      'DM4::P::c in DM4::q4::p': ['F/F/F/F', 'F'],
    }),
    'DN1-multi-typed': probe(`package DN1 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          attribute extra2 : ScalarValues::Real default = 0.0;
          constraint c { load + extra + extra2 <= 10.0 }
        }
        part def P2 :> P { attribute :>> extra = 0.5; }
        part def P4 :> P { attribute :>> extra2 = 20.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def Q2 :> Q { part :>> p : P2; }
        part def Q4 :> Q { part :>> p : P4; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q3 : Q2, Q4;
      }`, {
      'DN1::P::c': ['T/T/T/T', 'T'],
      'DN1::P::c in DN1::P2': ['T/T/T/T', 'T'],
      'DN1::P::c in DN1::P4': ['F/F/F/F', 'F'],
      'DN1::P::c in DN1::Q::p': ['T/T/T/T', 'T'],
      'DN1::P::c in DN1::q1::p': ['T/T/T/T', 'T'],
      'DN1::P::c in DN1::Q2::p': ['T/T/T/T', 'T'],
      'DN1::P::c in DN1::q3::p': ['?/?/?/?', 'F'],
      'DN1::P::c in DN1::Q4::p': ['F/F/F/F', 'F'],
    }),
    'DN2-nested-diamond': probe(`package DN2 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          attribute extra2 : ScalarValues::Real default = 0.0;
          constraint c { load + extra + extra2 <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def R { part q : Q; }
        part def R1 :> R { part :>> q { part :>> p { attribute :>> extra = 0.5; } } }
        part def R2 :> R { part :>> q { part :>> p { attribute :>> extra2 = 20.0; } } }
        part def R3 :> R1, R2;
        part r0 : R { part :>> q { attribute :>> L = 2.0; } }
        part r3 : R3;
      }`, {
      'DN2::P::c': ['T/T/T/T', 'T'],
      'DN2::P::c in DN2::Q::p': ['T/T/T/T', 'T'],
      'DN2::P::c in DN2::R::q::p': ['T/T/T/T', 'T'],
      'DN2::P::c in DN2::r0::q::p': ['T/T/T/T', 'T'],
      'DN2::P::c in DN2::R1::q::p': ['T/T/T/T', 'T'],
      'DN2::P::c in DN2::R2::q::p': ['F/F/F/F', 'F'],
      'DN2::P::c in DN2::R3::q::p': ['?/?/?/?', 'F'],
      'DN2::P::c in DN2::r3::q::p': ['?/?/?/?', 'F'],
    }),
    'CI1-clash-nogroup': probe(`package CI1 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
        part def P2 :> P { attribute :>> extra = 9.5; }
        part def Q {
          attribute X : ScalarValues::Real default = 0.0;
          part p : P;
          bind p.extra = X;
        }
        part def Q2 :> Q { part :>> p : P2; }
        part q3 : Q2;
        constraint topF { q3.p.extra <= 5.0 }
      }`, {
      'CI1::P::c': ['T/T/T/T', 'T'],
      'CI1::P::c in CI1::P2': ['F/F/F/F', 'F'],
      'CI1::P::c in CI1::Q2::«PartUsage»': ['?/-/?/-', 'F'],
      'CI1::P::c in CI1::Q2::p': ['-/?/-/?', 'F'],
      'CI1::topF': ['?/?/?/?', 'F'],
    }),
    'CI2-clash-onegroup': probe(`package CI2 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
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
        constraint topF { q2.p.load + q2.p.extra <= 10.0 }
      }`, {
      'CI2::P::c': ['T/T/T/T', 'T'],
      'CI2::P::c in CI2::P2': ['F/F/F/F', 'F'],
      'CI2::P::c in CI2::Q::p': ['T/T/T/T', 'T'],
      'CI2::P::c in CI2::q1::p': ['T/T/T/T', 'T'],
      'CI2::P::c in CI2::Q2::«PartUsage»': ['?/?/?/?', 'F'],
      'CI2::P::c in CI2::q2::p': ['?/?/?/?', 'F'],
      'CI2::topF': ['?/?/?/?', 'F'],
    }),
    'CH1-clash-default': probe(`package CH1 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
        part def P2 :> P { attribute :>> extra default = 9.5; }
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
        part q3 : Q2;
      }`, {
      'CH1::P::c': ['T/T/T/T', 'T'],
      'CH1::P::c in CH1::P2': ['F/F/F/F', 'F'],
      'CH1::P::c in CH1::Q::p': ['T/T/T/T', 'T'],
      'CH1::P::c in CH1::q1::p': ['T/T/T/T', 'T'],
      'CH1::P::c in CH1::Q2::«PartUsage»': ['?/?/?/?', '?'],
      'CH1::P::c in CH1::q2::p': ['?/?/?/?', '?'],
      'CH1::P::c in CH1::q3::p': ['?/?/?/?', '?'],
    }),
    'CH2-clash-value': probe(`package CH2 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute extra : ScalarValues::Real default = 0.0;
          constraint c { load + extra <= 10.0 }
        }
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
        part q3 : Q2;
      }`, {
      'CH2::P::c': ['T/T/T/T', 'T'],
      'CH2::P::c in CH2::P2': ['F/F/F/F', 'F'],
      'CH2::P::c in CH2::Q::p': ['T/T/T/T', 'T'],
      'CH2::P::c in CH2::q1::p': ['T/T/T/T', 'T'],
      'CH2::P::c in CH2::Q2::«PartUsage»': ['?/?/?/?', 'F'],
      'CH2::P::c in CH2::q2::p': ['?/?/?/?', 'F'],
      'CH2::P::c in CH2::q3::p': ['?/?/?/?', 'F'],
    }),
    // Found by the review of O2 S1: the guard compared the features a reading reads, not the feature a
    // REFERENCE stands for, nor what a part bound to another reads. X15b: q2's p refers to ra (k = 50) where
    // Q's p refers to rb — the same R::x read through another feature; O2 S2 reads it in q2's p (F). X17: `ref
    // part :>> r = s` written in Q's p is Q's `s`, resolved once where it is written, and q2's p reads q2's `s`
    // (k = 50); X19: Q2 types its `s` by R2 (k = 50). Z1: q1's `s` is Q's `s`, but Q binds its k to K and q1
    // sets K = 50. Each such instance read T on all four surfaces where it is F; the guard re-reads the
    // reference at the instance and has it abstain. X18 and X24: `bind p.r = s` binds a PART, and every row
    // read r.x as R's own x (2) — X24's own row T where Q's s has k = 50 (F); no per-instance reading carries a
    // bound part, so the group is refused whole, its own row included. X9: the context row of q2's own p read
    // T through a memo entry its group row left (A-L2); q2's row is now read in q2's p, once (F). X11: q2's p
    // redefines the relation itself; P's c is not read there (what such a redefinition means for P's c is not
    // decided).
    'X15b-ref-at-instance': probe(`package X15b {
        part def R { attribute k : ScalarValues::Real default = 1.0; attribute x : ScalarValues::Real = 2.0 * k; }
        part def P { attribute load : ScalarValues::Real default = 1.0; ref part r : R; constraint c { load + r.x <= 10.0 } }
        part ra : R { attribute :>> k = 50.0; }
        part rb : R { attribute :>> k = 1.0; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P { ref part :>> r default = rb; } bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { part :>> p { ref part :>> r = ra; } }
      }`, {
      'X15b::P::c': ['T/T/T/T', 'T'],
      'X15b::P::c in X15b::Q::p': ['T/T/T/T', 'T'],
      'X15b::P::c in X15b::q1::p': ['T/T/T/T', 'T'],
      'X15b::P::c in X15b::q2::p': ['F/F/F/F', 'F'],
    }),
    'X17-ref-sibling': probe(`package X17 {
        part def R { attribute k : ScalarValues::Real default = 1.0; attribute x : ScalarValues::Real = 2.0 * k; }
        part def P { attribute load : ScalarValues::Real default = 1.0; ref part r : R; constraint c { load + r.x <= 10.0 } }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part s : R; part p : P { ref part :>> r = s; } bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { part :>> s { attribute :>> k = 50.0; } }
      }`, {
      'X17::P::c': ['T/T/T/T', 'T'],
      'X17::P::c in X17::Q::p': ['T/T/T/T', 'T'],
      'X17::P::c in X17::q1::p': ['T/T/T/T', 'T'],
      'X17::P::c in X17::q2::p': ['?/?/?/?', 'F'],
    }),
    'X19-ref-sibling-spec': probe(`package X19 {
        part def R { attribute k : ScalarValues::Real default = 1.0; attribute x : ScalarValues::Real = 2.0 * k; }
        part def R2 :> R { attribute :>> k = 50.0; }
        part def P { attribute load : ScalarValues::Real default = 1.0; ref part r : R; constraint c { load + r.x <= 10.0 } }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part s : R; part p : P { ref part :>> r = s; } bind p.load = L; }
        part def Q2 :> Q { part :>> s : R2; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q2;
      }`, {
      'X19::P::c': ['T/T/T/T', 'T'],
      'X19::P::c in X19::Q::p': ['T/T/T/T', 'T'],
      'X19::P::c in X19::Q2::p': ['?/?/?/?', 'F'],
      'X19::P::c in X19::q1::p': ['T/T/T/T', 'T'],
      'X19::P::c in X19::q2::p': ['?/?/?/?', 'F'],
    }),
    'Z1-ref-target-bound': probe(`package Z1 {
        part def R { attribute k : ScalarValues::Real default = 1.0; attribute x : ScalarValues::Real = 2.0 * k; }
        part def P { attribute load : ScalarValues::Real default = 1.0; ref part r : R; constraint c { load + r.x <= 10.0 } }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          attribute K : ScalarValues::Real default = 1.0;
          part s : R;
          part p : P { ref part :>> r = s; }
          bind p.load = L;
          bind s.k = K;
        }
        part q1 : Q { attribute :>> K = 50.0; }
      }`, {
      'Z1::P::c': ['T/T/T/T', 'T'],
      'Z1::P::c in Z1::Q::p': ['T/T/T/T', 'T'],
      'Z1::P::c in Z1::q1::p': ['?/?/?/?', 'F'],
    }),
    'X18-bind-ref': probe(`package X18 {
        part def R { attribute k : ScalarValues::Real default = 1.0; attribute x : ScalarValues::Real = 2.0 * k; }
        part def P { attribute load : ScalarValues::Real default = 1.0; ref part r : R; constraint c { load + r.x <= 10.0 } }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part s : R; part p : P; bind p.r = s; bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { part :>> s { attribute :>> k = 50.0; } }
      }`, {
      'X18::P::c': ['T/T/T/T', 'T'],
      'X18::P::c in X18::Q::p': ['?/?/?/?', 'T'],
    }),
    'X24-bind-ref-valued': probe(`package X24 {
        part def R { attribute k : ScalarValues::Real default = 1.0; attribute x : ScalarValues::Real = 2.0 * k; }
        part def P { attribute load : ScalarValues::Real default = 1.0; ref part r : R; constraint c { load + r.x <= 10.0 } }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part s : R { attribute :>> k = 50.0; } part p : P; bind p.r = s; bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0; }
      }`, {
      'X24::P::c': ['T/T/T/T', 'T'],
      'X24::P::c in X24::Q::p': ['?/?/?/?', 'F'],
    }),
    'X9-sub-value-reads': probe(`package X9 {
        part def S { attribute v : ScalarValues::Real default = 1.0; attribute w : ScalarValues::Real = 2.0 * v; }
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          part sub : S;
          attribute extra : ScalarValues::Real = sub.w;
          constraint c { load + extra <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { part :>> p { part :>> sub { attribute :>> v = 50.0; } } }
      }`, {
      'X9::P::c': ['T/T/T/T', 'T'],
      'X9::P::c in X9::Q::p': ['T/T/T/T', 'T'],
      'X9::P::c in X9::q1::p': ['T/T/T/T', 'T'],
      'X9::P::c in X9::q2::p': ['F/F/F/F', 'F'],
    }),
    'X11-constraint-redef': probe(`package X11 {
        part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { attribute :>> L = 50.0; part :>> p { constraint :>> c { load <= 100.0 } } }
      }`, {
      'X11::P::c': ['T/T/T/T', 'T'],
      'X11::P::c in X11::Q::p': ['T/T/T/T', 'T'],
      'X11::P::c in X11::q1::p': ['T/T/T/T', 'T'],
      'X11::P::c in X11::q2::p': ['?/?/?/?', null],
      'X11::q2::«PartUsage»::«ConstraintUsage»': ['T/-/?/-', 'T'],
      'X11::q2::p::c': ['-/T/-/T', 'T'],
    }),
    chain33: probe(bindingChain(33), {
      'Deep::deepNegT': ['?/?/T/T', 'T'],
      'Deep::deepPosF': ['?/?/F/?', 'F'],
    }),
    // Found by the soundness review of this table (F0): shapes the design's probes did not build.
    chainPkg33: probe(bindingChainPkg(33), {
      'DP33::negT': ['?/?/T/T', 'T'],
      'DP33::posF': ['?/?/F/?', 'F'],
    }),
    chainPkg32: probe(bindingChainPkg(32), {
      'DP32::negT': ['T/T/T/T', 'T'],
      'DP32::posF': ['F/F/F/F', 'F'],
    }),
    // CAP1 (the 2026-10-14 review, A-C3): chainPkg33 plus `bind Y = top.a.….a.load` read in the package, over
    // `Y default = 1.0`. T1's binding is past the segment cap, and the package's second binding carried its
    // value on: Y's default and the load's fall-through were read there as two defaults that agree, so Y and
    // the load stood at 1 — yT and negT F/F/F/X, yF and posF T/T/T/X, where Y is 50 and m2 is −40. The cap
    // reaches every binding joined to the capped one (O2 S3): the check and the literal engine abstain, the
    // numeric and SMT lanes solve the bindings and decide. It sits beside chainPkg33, the cap's pin here;
    // P4's others are the 33-level chain unit test (CAP1 is pinned beside it too) and r4cap, out of tree.
    cap1: probe(
      bindingChainPkg(33)
        .replace('package DP33 {', 'package CAP1 {')
        .replace(
          /\n}$/,
          [
            '',
            '  attribute Y : ScalarValues::Real default = 1.0;',
            `  bind Y = top.${Array.from({ length: 33 }, () => 'a').join('.')}.load;`,
            '  constraint yT { Y >= 40.0 }',
            '  constraint yF { Y <= 5.0 }',
            '}',
          ].join('\n'),
        ),
      {
        'CAP1::negT': ['?/?/T/T', 'T'],
        'CAP1::posF': ['?/?/F/?', 'F'],
        'CAP1::yT': ['?/?/T/T', 'T'],
        'CAP1::yF': ['?/?/F/?', 'F'],
      },
    ),
    // CAPU2 (the review of O2 S3): chainPkg33 plus U's own `bind a.load = M` on its `part a : T0`. Both U's end
    // and T1's capped one redefine T0's load, and joined through it U's binding was held past T1's cap: M and
    // the load were free to the numeric lane, which solved `u.a.load == 9.0` as a design equation and refuted
    // c2–c4 at 9 (the app's Solve: infeasible), where u's load and M are U's default of 1. A binding joins a
    // capped one only through another binding's end.
    capu2: probe(
      bindingChainPkg(33)
        .replace('package DP33 {', 'package CAPU2 {')
        .replace(
          /\n}$/,
          [
            '',
            '  part def U { part a : T0; attribute M : ScalarValues::Real default = 1.0; bind a.load = M; }',
            '  part u : U;',
            '  constraint c1 { u.a.load == 9.0 }',
            '  constraint c2 { u.a.load <= 5.0 }',
            '  constraint c3 { u.M <= 5.0 }',
            '  constraint c4 { u.a.m2 >= 5.0 }',
            '}',
          ].join('\n'),
        ),
      {
        'CAPU2::negT': ['?/?/T/T', 'T'],
        'CAPU2::posF': ['?/?/F/?', 'F'],
        'CAPU2::c1': ['F/F/F/F', 'F'],
        'CAPU2::c2': ['T/T/T/T', 'T'],
        'CAPU2::c3': ['T/T/T/T', 'T'],
        'CAPU2::c4': ['T/T/T/T', 'T'],
      },
    ),
    // CAPU4 (the same review; at 5943654 too): a shallow `part s : T1;` beside the capped chain. T1's binding
    // is past the cap, so s's L and its a's load are held at T1's default of 1 and read by no surface — but
    // the numeric lane read them as a design freedom: c1 `s.a.load == 9.0` was satisfied by construction,
    // and c2 and c3 refuted at that 9. A value held past a cap that no binding carries from a stated value
    // is no freedom: every surface abstains.
    capu4: probe(
      bindingChainPkg(33)
        .replace('package DP33 {', 'package CAPU4 {')
        .replace(
          /\n}$/,
          [
            '',
            '  part s : T1;',
            '  constraint c1 { s.a.load == 9.0 }',
            '  constraint c2 { s.a.load <= 5.0 }',
            '  constraint c3 { s.L <= 5.0 }',
            '}',
          ].join('\n'),
        ),
      {
        'CAPU4::negT': ['?/?/T/T', 'T'],
        'CAPU4::posF': ['?/?/F/?', 'F'],
        'CAPU4::c1': ['?/?/?/?', 'F'],
        'CAPU4::c2': ['?/?/?/?', 'T'],
        'CAPU4::c3': ['?/?/?/?', 'T'],
      },
    ),
    'h2-bodyspec-plain': probe(`package H2BP {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real; part p : P; }
        part def Q2 :> Q { attribute :>> L = 50.0; }
        part q : Q2 { bind p.load = L; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'H2BP::m2NegT': ['F/F/F/F', 'T'],
      'H2BP::m2PosF': ['T/T/T/T', 'F'],
    }),
    'h2-bodyspec-rev': probe(`package H2BR {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; }
        part def Q2 :> Q { part :>> p { attribute :>> load = 50.0; } }
        part q : Q2 { bind L = p.load; }
        constraint lT { q.L >= 40.0 }
        constraint lF { q.L <= 2.0 }
      }`, {
      'H2BR::lF': ['T/T/T/T', 'F'],
      'H2BR::lT': ['F/F/F/F', 'T'],
    }),
    // Found by F2's review (identical before F1): a bound partner's default RESTATED, equal to the partner
    // definition's own, in a redefinition (`part :>> p { attribute :>> a default = 50.0; }`). The restated
    // default is held, so q4's p.a reads nothing, but p.b is read at P::b over P::a's own default — and the
    // guard sees the restated default as alike, so the generic partner counts as safe. The binding gives a
    // the value 2.0 in every instance (decision 10), so b is 8. A restated 30.0 abstains; the same text as P's
    // own default does not — unanimously false on all four surfaces, in the usage, with a derived L, and in a
    // specialising definition.
    'held-redef': probe(`package HB {
        part def P { attribute a : ScalarValues::Real default = 50.0; attribute b : ScalarValues::Real = 10.0 - a; }
        part def Q { attribute L : ScalarValues::Real = 2.0; part p : P; bind p.a = L; }
        part q4 : Q { part :>> p { attribute :>> a default = 50.0; } }
        constraint same50 { q4.p.b >= 0.0 }
        constraint same50F { q4.p.b <= 0.0 }
      }`, {
      'HB::same50': ['T/T/T/T', 'T'],
      'HB::same50F': ['F/F/F/F', 'F'],
    }),
    'held-redef-derived': probe(`package HBD {
        part def P { attribute a : ScalarValues::Real default = 50.0; attribute b : ScalarValues::Real = 10.0 - a; }
        part def Q { attribute K : ScalarValues::Real default = 1.0; attribute L : ScalarValues::Real = 2.0 * K; part p : P; bind p.a = L; }
        part q4 : Q { part :>> p { attribute :>> a default = 50.0; } }
        constraint same50 { q4.p.b >= 0.0 }
        constraint same50F { q4.p.b <= 0.0 }
      }`, {
      'HBD::same50': ['T/T/T/T', 'T'],
      'HBD::same50F': ['F/F/F/F', 'F'],
    }),
    'held-redef-spec': probe(`package HBG {
        part def P { attribute a : ScalarValues::Real default = 50.0; attribute b : ScalarValues::Real = 10.0 - a; }
        part def Q { attribute L : ScalarValues::Real = 2.0; part p : P; bind p.a = L; }
        part def Q2 :> Q { part :>> p { attribute :>> a default = 50.0; } }
        part q5 : Q2;
        constraint same50 { q5.p.b >= 0.0 }
        constraint same50F { q5.p.b <= 0.0 }
      }`, {
      'HBG::same50': ['T/T/T/T', 'T'],
      'HBG::same50F': ['F/F/F/F', 'F'],
    }),
    'assert-min': probe(`package AM {
        part def P { attribute load : ScalarValues::Real default = 3.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real; assert constraint defL { L == 1.0 } part p : P; }
        part def QB :> Q { bind p.load = L; }
        part q0 : QB;
        constraint ctlT { q0.p.m2 >= 8.5 }
        constraint ctlF { q0.p.m2 <= 8.0 }
      }`, {
      'AM::Q::defL': ['T/-/T/-', 'T'],
      'AM::Q::defL in AM::QB': ['T/-/T/-', 'T'],
      'AM::ctlF': ['F/F/F/F', 'F'],
      'AM::ctlT': ['T/T/T/T', 'T'],
    }),
    'assert-min-def': probe(`package AMD {
        part def P { attribute load : ScalarValues::Real default = 3.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real; assert constraint defL { L == 1.0 } part p : P; bind p.load = L; }
        part q0 : Q;
        constraint ctlT { q0.p.m2 >= 8.5 }
        constraint ctlF { q0.p.m2 <= 8.0 }
      }`, {
      'AMD::Q::defL': ['T/-/T/-', 'T'],
      'AMD::ctlF': ['F/F/F/F', 'F'],
      'AMD::ctlT': ['T/T/T/T', 'T'],
    }),
    M2a: probe(`package M2a {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real; assert constraint defL { L == 2.0 * K } part p : P; bind p.load = L; }
        part q : Q { attribute :>> K = 25.0; }
        part q0 : Q;
        constraint negT { q.p.m2 <= 0.0 }
        constraint posF { q.p.m2 >= 0.0 }
        constraint ctlA { q0.p.m2 >= 8.5 }
      }`, {
      'M2a::Q::defL': ['T/-/T/-', 'T'],
      'M2a::Q::defL in M2a::q': ['T/-/T/-', 'T'],
      'M2a::ctlA': ['T/T/T/T', 'T'],
      'M2a::negT': ['T/T/T/T', 'T'],
      'M2a::posF': ['F/F/F/F', 'F'],
    }),
    G340: probe(`package G340 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real; assert constraint defL { L == 2.0 * K } part p : P; }
        part def Q2 :> Q { attribute :>> K = 25.0; }
        part def R { part q : Q2; }
        part r : R;
        part def R0 { part q : Q; }
        part r0 : R0;
        bind r.q.p.load = r.q.L;
        constraint negT { r.q.p.m2 <= 0.0 }
        constraint posF { r.q.p.m2 >= 0.0 }
        constraint ctlA { r0.q.p.m2 >= 8.5 }
      }`, {
      'G340::Q::defL': ['T/-/T/-', 'T'],
      'G340::Q::defL in G340::Q2': ['T/-/T/-', 'T'],
      'G340::ctlA': ['T/T/T/T', 'T'],
      'G340::negT': ['T/T/T/T', 'T'],
      'G340::posF': ['F/F/F/F', 'F'],
    }),
    'u-m2': probe(`package UM2 {
        part def P { attribute load : ISQ::MassValue default = 1.0 [SI::kg]; attribute m2 : ISQ::MassValue = 10.0 [SI::kg] - load; }
        part def Q {
          attribute K : ISQ::MassValue default = 0.5 [SI::kg];
          attribute L : ISQ::MassValue = 2.0 * K;
          part p : P;
          bind p.load = L;
        }
        part q : Q { attribute :>> K = 25.0 [SI::kg]; }
        constraint m2NegT { q.p.m2 <= 0.0 [SI::kg] }
        constraint m2PosF { q.p.m2 >= 0.0 [SI::kg] }
      }`, {
      'UM2::m2NegT': ['T/T/T/?', 'T'],
      'UM2::m2PosF': ['F/F/F/?', 'F'],
    }),
    // I6 on quantities: p's witness 2000 [g] IS the compared 2 kg; p2's k prints its own 10 (unit-less), as
    // the row compared 10 kg — not P's 4000 (grams, F2).
    'u-witness': probe(`package UG {
        part def P { attribute m : ISQ::MassValue default = 2000.0 [SI::g]; attribute k : ISQ::MassValue = m * 2.0; }
        part p : P;
        part p2 : P { attribute :>> m = 5.0 [SI::kg]; }
        constraint cT { p.m <= 3.0 [SI::kg] }
        constraint cF { p.m >= 3.0 [SI::kg] }
        constraint dT { p2.k >= 9.0 [SI::kg] }
        constraint gT { p.m <= 3000.0 [SI::g] }
      }`, {
      'UG::cF': ['F/F/F/F', 'F'],
      'UG::cT': ['T/T/T/T', 'T'],
      'UG::dT': ['T/T/T/T', 'T'],
      'UG::gT': ['T/T/T/T', 'T'],
    }),
    'spec-m2': probe(`package SM2 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          part p : P;
          bind p.load = L;
        }
        part def Q2 :> Q { attribute :>> K = 25.0; }
        part q : Q2;
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'SM2::m2NegT': ['T/T/T/T', 'T'],
      'SM2::m2PosF': ['F/F/F/F', 'F'],
    }),
    'm2-dup': probe(`package M2D {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real = 2.0 * K; part p : P; bind p.load = L; }
        part q : Q { attribute :>> K = 25.0; }
        part q2 : Q { attribute :>> K = 0.1; }
        constraint aT { q.p.m2 <= 0.0 }
        constraint bT { q2.p.m2 >= 9.7 }
        constraint cF { q2.p.m2 >= 9.9 }
      }`, {
      'M2D::aT': ['T/T/T/T', 'T'],
      'M2D::bT': ['T/T/T/T', 'T'],
      'M2D::cF': ['F/F/F/F', 'F'],
    }),
    d1plain: probe(`package D1P {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute L : ScalarValues::Real = 50.0; part p : P; bind p.load = L; }
        part q : Q { part :>> p { attribute :>> load = 30.0; } }
        constraint at30 { q.p.m2 >= -20.0 }
        constraint atL { q.p.m2 <= -40.0 }
      }`, {
      'D1P::Q::«BindingConnectorAsUsage» in D1P::q#bind': ['F/-/F/-', 'F'],
      'D1P::at30': ['T/T/T/X', '?'],
      'D1P::atL': ['F/F/F/X', '?'],
    }),
    // Found by the F1 reviews. A binding in a usage body whose partner is a feature of the ENCLOSING
    // definition (R's L): read only where it is written, its partner was R's own 1 for r's q, whose K
    // makes L 50 — false on all four surfaces before (negT F/F/F/F). The binding is now read in every
    // instance of R, so r reads it otherwise and no surface reads R's L for r's q.
    'encl-W1': probe(`package EnclW1 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { part p : P; }
        part def R { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real = 2.0 * K; part q : Q { bind p.load = L; } }
        part r : R { attribute :>> K = 25.0; }
        part r0 : R;
        constraint negT { r.q.p.m2 <= 0.0 }
        constraint posF { r.q.p.m2 >= 0.0 }
        constraint ctlA { r0.q.p.m2 >= 8.5 }
      }`, {
      'EnclW1::ctlA': ['?/?/?/?', 'T'],
      'EnclW1::negT': ['?/?/?/?', 'T'],
      'EnclW1::posF': ['?/?/?/?', 'F'],
    }),
    // The same with the binding in a definition nested in R: read where it is written, by L's own id, for
    // every R alike.
    'encl-W3': probe(`package EnclW3 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def R {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          part def Q { part p : P; bind p.load = L; }
          part q : Q;
        }
        part r : R { attribute :>> K = 25.0; }
        part r0 : R;
        constraint negT { r.q.p.m2 <= 0.0 }
        constraint posF { r.q.p.m2 >= 0.0 }
        constraint ctlA { r0.q.p.m2 >= 8.5 }
      }`, {
      'EnclW3::ctlA': ['?/?/?/?', 'T'],
      'EnclW3::negT': ['?/?/?/?', 'T'],
      'EnclW3::posF': ['?/?/?/?', 'F'],
    }),
    // A literal default partner r overrides: the two defaults agreed in the one context the binding was
    // read in, so P's 1 stood for r's load of 50 (negT F/F/F/F, posF T/T/T/T). Now r's frame holds it.
    'encl-W5': probe(`package EnclW5 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { part p : P; }
        part def R { attribute L : ScalarValues::Real default = 1.0; part q : Q { bind p.load = L; } }
        part r : R { attribute :>> L = 50.0; }
        part r0 : R;
        constraint negT { r.q.p.m2 <= 0.0 }
        constraint posF { r.q.p.m2 >= 0.0 }
        constraint ctlA { r0.q.p.m2 >= 8.5 }
      }`, {
      'EnclW5::ctlA': ['?/?/T/T', 'T'],
      'EnclW5::negT': ['T/T/T/?', 'T'],
      'EnclW5::posF': ['F/F/F/?', 'F'],
    }),
    // R's own constraint over the bound path, and the context row r gains (q's m2 is −40 there).
    'encl-W4': probe(`package EnclW4 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; constraint c { m2 >= 8.5 } }
        part def Q { part p : P; }
        part def R {
          attribute K : ScalarValues::Real default = 0.5;
          attribute L : ScalarValues::Real = 2.0 * K;
          part q : Q { bind p.load = L; }
          constraint rc { q.p.m2 >= 8.5 }
        }
        part r : R { attribute :>> K = 25.0; }
        part r0 : R;
      }`, {
      'EnclW4::P::c': ['T/T/T/T', 'T'],
      // R's q's binding reaches into its p, an end copy of Q's p: P's c is read per instance of Q's p — the
      // three in R's q abstain (r's is F: L = 50), where no row of them existed before (O2 S4); reading them
      // at the instance is O6 S4's (E7).
      'EnclW4::P::c in EnclW4::Q::p': ['T/T/T/T', 'T'],
      'EnclW4::P::c in EnclW4::R::q::p': ['?/?/?/T', 'T'],
      'EnclW4::P::c in EnclW4::r::q::p': ['?/?/?/?', 'F'],
      'EnclW4::P::c in EnclW4::r0::q::p': ['?/?/?/?', 'T'],
      'EnclW4::R::rc': ['?/?/T/T', 'T'],
      'EnclW4::R::rc in EnclW4::r': ['?/?/?/?', 'F'],
    }),
    // A package's own partner is one instance wherever it is read: still read (a control).
    'global-W10': probe(`package GlobW10 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        attribute K : ScalarValues::Real default = 0.5;
        attribute G : ScalarValues::Real = 2.0 * K;
        part def Q { part p : P; bind p.load = G; }
        part q : Q;
        constraint ctlT { q.p.m2 >= 8.5 }
        constraint ctlF { q.p.m2 <= 8.0 }
      }`, {
      'GlobW10::ctlF': ['F/F/F/?', 'F'],
      'GlobW10::ctlT': ['T/T/T/?', 'T'],
    }),
    // An asserted partner a specialised definition's usages share: q0 and q1 change nothing Q2 does not,
    // so they read QB's binding as Q2 does and add no row (each added one; FanA1000's thousand made 2,003
    // findings). Q2's own row read P's default through the end copy (the G340 defect) and published a
    // false T; a context listed only because a member reads its own value there decides nothing yet.
    FanS2: probe(`package FanS2 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real; assert constraint defL { L == 2.0 * K } part p : P; }
        part def QB :> Q { bind p.load = L; constraint cq { p.load <= 5.0 } }
        part def Q2 :> QB { attribute :>> K = 25.0; }
        part q0 : Q2;
        part q1 : Q2;
      }`, {
      'FanS2::Q::defL': ['T/-/T/-', 'T'],
      'FanS2::Q::defL in FanS2::Q2': ['T/-/T/-', 'T'],
      'FanS2::Q::defL in FanS2::QB': ['T/-/T/-', 'T'],
      'FanS2::QB::cq': ['T/T/T/T', 'T'],
      'FanS2::QB::cq in FanS2::Q2': ['?/?/?/?', 'F'],
    }),
    // The M-generator's bind2 family in a usage body, in kg (G271): the guard on a bound partner's VALUE
    // withheld its kilograms from the unit gates too, which refused `L == 2.0 * K` and `P::m2 in r::q::p`
    // and so left r0's correct refutation (7 kg vs 8.5) inconclusive. The gates read the dimension again.
    G271: probe(`package G271 {
        part def P { attribute load : ISQ::MassValue default = 3.0 [SI::kg]; attribute m2 : ISQ::MassValue = 10.0 [SI::kg] - load; }
        part def Q { attribute N : ISQ::MassValue default = 1.0 [SI::kg]; attribute J : ISQ::MassValue default = 0.5 * N; attribute K : ISQ::MassValue; bind K = J; attribute L : ISQ::MassValue = 2.0 * K; part p : P; }
        part def Q2 :> Q { attribute :>> N = 50.0 [SI::kg]; }
        part def R { part q : Q2; }
        part r : R { part :>> q { bind p.load = L; } }
        part def R0 { part q : Q; }
        part r0 : R0;
        constraint negT { r.q.p.m2 <= 0.0 [SI::kg] }
        constraint posF { r.q.p.m2 >= 0.0 [SI::kg] }
        constraint ctlA { r0.q.p.m2 >= 8.5 [SI::kg] }
      }`, {
      'G271::ctlA': ['F/F/F/F', 'F'],
      'G271::negT': ['T/T/T/T', 'T'],
      'G271::posF': ['F/F/F/F', 'F'],
    }),
    // A partner read through a reference feature's value (q's r is r1, whose K makes L 50): `subjectOf`
    // reads the feature the `ref` names, so all four surfaces read r1's 50 (q's m2 is −40) and agree with
    // the hand-computed verdict; they once read R's own L instead (F1's review); the pins below hold the fix.
    'ref-W9': probe(`package RefW9 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def R { attribute K : ScalarValues::Real default = 0.5; attribute L : ScalarValues::Real = 2.0 * K; }
        part def Q { ref part r : R; part p : P; bind p.load = r.L; }
        part r1 : R { attribute :>> K = 25.0; }
        part q : Q { ref part :>> r = r1; }
        part q0 : Q;
        constraint negT { q.p.m2 <= 0.0 }
        constraint posF { q.p.m2 >= 0.0 }
      }`, {
      'RefW9::negT': ['T/T/T/T', 'T'],
      'RefW9::posF': ['F/F/F/F', 'F'],
    }),
    k4: probe(`package K4 {
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          attribute load : ScalarValues::Real default = 2.0;
          attribute m2 : ScalarValues::Real = 10.0 - load;
          bind load = L;
        }
        part q : Q;
        constraint m2Pos { q.m2 >= 0.0 }
      }`, {
      'K4::m2Pos': ['?/?/?/?', '?'],
    }),
    // A package's binding on a definition's feature (`bind P::load = L`, w4) holds in every instance of P, on every
    // surface (H5 S4, decision 14): p2's load is L's 50 (U6: W4 c2 ref F), and so is a nested instance's, Q's own p
    // included (W4N), and a redefinition's whose `default` gives way to it (W4b, F before on all four surfaces).
    w4: probe(`package W4 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        attribute L : ScalarValues::Real = 50.0;
        bind P::load = L;
        part p2 : P;
        constraint c2 { p2.m2 >= 0.0 }
      }`, {
      'W4::c2': ['F/F/F/F', 'F'],
    }),
    'w4-nested': probe(`package W4N {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; constraint c { m2 >= 0.0 } }
        part def Q { part p : P; }
        attribute L : ScalarValues::Real = 50.0;
        bind P::load = L;
        part p2 : P;
        part q : Q;
        constraint cF { q.p.m2 >= 0.0 }
        constraint cT { q.p.m2 <= 0.0 }
      }`, {
      'W4N::P::c': ['F/F/F/F', 'F'],
      'W4N::P::c in W4N::Q::p': ['F/F/F/F', 'F'],
      'W4N::P::c in W4N::p2': ['F/F/F/F', 'F'],
      'W4N::cF': ['F/F/F/F', 'F'],
      'W4N::cT': ['T/T/T/T', 'T'],
    }),
    'w4-redef': probe(`package W4b {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        attribute L : ScalarValues::Real = 50.0;
        bind P::load = L;
        part p3 : P { attribute :>> load default = 7.0; }
        constraint c3F { p3.m2 >= 0.0 }
        constraint c3T { p3.m2 <= 0.0 }
      }`, {
      'W4b::c3F': ['F/F/F/F', 'F'],
      'W4b::c3T': ['T/T/T/T', 'T'],
    }),
    // With L valueless, an instance's own value is carried into every other through L: p4's `= 7.0` makes L and p2's
    // load 7 (W4v, F before on three surfaces: P's default 1 stood), and p4's `default = 7.0` beside P's 1 is two
    // defaults that differ (W4w): no default stands for any instance.
    'w4-redef-value': probe(`package W4v {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        attribute L : ScalarValues::Real;
        bind P::load = L;
        part p2 : P;
        part p4 : P { attribute :>> load = 7.0; }
        constraint c2 { p2.m2 <= 5.0 }
        constraint cL { L >= 5.0 }
      }`, {
      'W4v::c2': ['?/?/?/?', 'T'],
      'W4v::cL': ['?/?/?/?', 'T'],
    }),
    'w4-redef-defaults': probe(`package W4w {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        attribute L : ScalarValues::Real;
        bind P::load = L;
        part p2 : P;
        part p4 : P { attribute :>> load default = 7.0; }
        constraint c2 { p2.m2 <= 5.0 }
      }`, {
      'W4w::c2': ['?/?/?/?', '?'],
    }),
    // Two features of one definition bound at package level (`bind P::load = P::cap`) are joined in each instance at
    // its own values: the check and the literal engine read none (P's load default gives way; T/F before on all
    // four surfaces), the numeric and SMT lanes solve p2's load from p2's cap.
    'w4-defpair': probe(`package W4d {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute cap : ScalarValues::Real; attribute m2 : ScalarValues::Real = 10.0 - load; }
        bind P::load = P::cap;
        part p2 : P { attribute :>> cap = 50.0; }
        constraint c2F { p2.m2 >= 0.0 }
        constraint c2T { p2.m2 <= 0.0 }
      }`, {
      'W4d::c2F': ['?/?/F/?', 'F'],
      'W4d::c2T': ['?/?/T/T', 'T'],
    }),
    // A plain `=` on a redefinition the package's binding fills is the contradiction of decision 1: d1plain's
    // shape, which U11 decided (A.5, `two-values`: ref ?, see KNOWN_FALSE).
    'w4-plain': probe(`package W4o {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        attribute L : ScalarValues::Real = 50.0;
        bind P::load = L;
        part p4 : P { attribute :>> load = 7.0; }
        constraint c4 { p4.m2 >= 0.0 }
      }`, {
      'W4o::c4': ['T/T/T/X', '?'],
    }),
    // The package's binding makes L one value with every instance's load, so a slot an instance fixes OUTSIDE the
    // binding fixes L and every other instance: Q's `bind p.load = M` (W4X1, W4X6), the package's own `bind p2.load
    // = L` (W4X3), an asserted `p2.load == 5.0` (W4X5). No default the binding joins stands — P's 50 (W4X1) or L's
    // or M's (W4X3, W4X5, W4X6) was read for p2 or p3, F on all four surfaces, and beside it SMT kept P's default
    // axiom (X on a consistent model). Each is 7 or 5: the check and the literal engine abstain, naming what fixes it.
    'w4-coupled-def': probe(`package W4X1 {
        part def P { attribute load : ScalarValues::Real default = 50.0; }
        attribute L : ScalarValues::Real;
        bind P::load = L;
        part def Q { attribute M : ScalarValues::Real = 7.0; part p : P; bind p.load = M; }
        part q : Q;
        part p2 : P;
        constraint cqT { q.p.load <= 10.0 }
        constraint c2T { p2.load <= 10.0 }
        constraint cLT { L <= 10.0 }
      }`, {
      'W4X1::c2T': ['?/?/T/T', 'T'],
      'W4X1::cLT': ['?/?/T/T', 'T'],
      'W4X1::cqT': ['T/T/T/T', 'T'],
    }),
    'w4-coupled-pkg': probe(`package W4X3 {
        part def P { attribute load : ScalarValues::Real; }
        attribute L : ScalarValues::Real = 5.0;
        attribute M : ScalarValues::Real default = 9.0;
        bind P::load = M;
        part p2 : P;
        bind p2.load = L;
        part p3 : P;
        constraint c3T { p3.load <= 6.0 }
        constraint cMT { M <= 6.0 }
      }`, {
      'W4X3::c3T': ['?/?/?/?', 'T'],
      'W4X3::cMT': ['?/?/?/?', 'T'],
    }),
    'w4-coupled-assert': probe(`package W4X5 {
        part def P { attribute load : ScalarValues::Real; }
        attribute M : ScalarValues::Real default = 9.0;
        bind P::load = M;
        part p2 : P;
        assert constraint fix { p2.load == 5.0 }
        part p3 : P;
        constraint c3T { p3.load <= 6.0 }
      }`, {
      'W4X5::c3T': ['?/?/T/T', 'T'],
      'W4X5::fix': ['?/-/T/-', 'T'],
    }),
    'w4-coupled-ldef': probe(`package W4X6 {
        part def P { attribute load : ScalarValues::Real; }
        attribute L : ScalarValues::Real default = 50.0;
        bind P::load = L;
        part def Q { attribute M : ScalarValues::Real = 7.0; part p : P; bind p.load = M; }
        part q : Q;
        part p2 : P;
        constraint c2T { p2.load <= 10.0 }
      }`, {
      'W4X6::c2T': ['?/?/?/?', 'T'],
    }),
    h2p0: probe(`package H2P0 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          constraint c { load <= 10.0 }
        }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          attribute pl : ScalarValues::Real = L;
          part p : P { attribute :>> load = pl; }
        }
        part q : Q { attribute :>> L = 50.0; }
      }`, {
      'H2P0::P::c': ['T/T/T/T', 'T'],
      'H2P0::P::c in H2P0::Q::p': ['?/?/?/?', 'T'],
    }),
    h2c0: probe(`package H2C0 {
        part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          part p : P { attribute :>> load = L; }
          constraint c { p.m2 >= 0.0 }
        }
        part q : Q { attribute :>> L = 50.0; }
      }`, {
      'H2C0::Q::c': ['?/?/?/?', 'T'],
    }),
    'mapper-s4': probe(`package S4 {
        part def P { attribute x : ScalarValues::Real; constraint c { x <= 10.0 } }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          part p : P;
          assert constraint tie { p.x == L }
        }
        part q1 : Q { attribute :>> L = 50.0; }
        constraint top { q1.p.x <= 10.0 }
      }`, {
      'S4::P::c': ['?/?/?/?', '?'],
      'S4::Q::tie': ['?/-/T/-', null],
      'S4::Q::tie in S4::q1': ['?/-/?/-', null],
      'S4::top': ['?/?/F/?', 'F'],
    }),
    'mapper-s5': probe(`package S5 {
        part def P { attribute x : ScalarValues::Real; attribute m2 : ScalarValues::Real = 10.0 - x; constraint c { m2 >= 0.0 } }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          part p : P;
          assert constraint tie { p.x == L }
        }
        part q1 : Q { attribute :>> L = 50.0; }
      }`, {
      'S5::P::c': ['?/?/?/?', '?'],
      'S5::Q::tie': ['?/-/T/-', null],
      'S5::Q::tie in S5::q1': ['?/-/?/-', null],
    }),
    // Class C (O5 S2): an asserted equation that defines a valueless feature by its DOTTED path, `assert
    // constraint { p.x == 3.0 }` at the package over `part p : P`, is p's x — read through p's `y = x * 2.0`
    // (g1, g2, gF) and bound by the caller for the assert's own row (px). B2's `p.x <= 3.0` defines nothing.
    'xtrack-b1': probe(`package B1 {
          part def P { attribute x : ScalarValues::Real; attribute y : ScalarValues::Real = x * 2.0; }
          part p : P;
          assert constraint px { p.x == 3.0 }
          constraint g1 { p.y == 6.0 }
          constraint g2 { p.y <= 6.0 }
      }`, {
      'B1::g1': ['T/T/T/T', 'T'],
      'B1::g2': ['T/T/T/T', 'T'],
      'B1::px': ['T/-/T/-', 'T'],
    }),
    'xtrack-b2': probe(`package B2 {
          part def P { attribute x : ScalarValues::Real; attribute y : ScalarValues::Real = x * 2.0; }
          part def Q { part p : P; assert constraint qx { p.x <= 3.0 } }
          part q : Q;
          constraint g1 { q.p.y <= 6.0 }
      }`, {
      'B2::Q::qx': ['?/-/?/-', null],
      'B2::g1': ['?/?/?/T', 'T'],
    }),
    'xtrack-b3': probe(`package B3 {
          part def P { attribute x : ScalarValues::Real; attribute y : ScalarValues::Real = x * 2.0; }
          part p : P;
          assert constraint px { p.x == 3.0 }
          constraint gF { p.y == 7.0 }
      }`, {
      'B3::gF': ['F/F/F/F', 'F'],
      'B3::px': ['T/-/T/-', 'T'],
    }),
    'xtrack-s2-usage-assert-leak': probe(`package S2 {
          part def C { attribute v : ScalarValues::Real; attribute u : ScalarValues::Real default = 1.0; }
          part a : C { assert constraint { v >= 5.0 } attribute :>> u = 7.0; }
          part b : C;
          constraint n1 { b.v >= 5.0 }
          constraint n2 { b.u == 7.0 }
          constraint y1 { a.v >= 5.0 }
          constraint y2 { a.u == 7.0 }
          constraint y3 { b.u == 1.0 }
      }`, {
      'S2::a::«ConstraintUsage»': ['?/-/?/-', null],
      'S2::n1': ['?/?/?/?', '?'],
      'S2::n2': ['F/F/F/F', 'F'],
      'S2::y1': ['?/?/?/T', 'T'],
      'S2::y2': ['T/T/T/T', 'T'],
      'S2::y3': ['T/T/T/T', 'T'],
    }),
    n4: probe(`package N4 {
        attribute x;
        attribute z;
        assert constraint c1 { x * x == -1.0 }
        constraint cz { z == 3.0 }
        constraint zl { z <= 2.0 }
        constraint xl { x <= 100.0 }
      }`, {
      'N4::c1': ['?/-/?/-', null],
      'N4::cz': ['?/?/t/X', null],
      'N4::xl': ['?/?/?/X', null],
      'N4::zl': ['?/?/F/X', null],
    }),
    'xtrack-d1-dec-inst': probe(`package D1 {
          part def P {
              attribute a : ScalarValues::Real default = 0.5;
              attribute b : ScalarValues::Real default = 0.5;
              attribute s : ScalarValues::Real = a + b;
          }
          part q : P { attribute :>> a = 0.1; attribute :>> b = 0.2; }
          constraint gSumF { q.a + q.b > 0.3 }
          constraint gSumT { q.a + q.b <= 0.3 }
          constraint gDerF { q.s > 0.3 }
          constraint gDerT { q.s <= 0.3 }
          attribute w : ScalarValues::Real;
          bind w = q.s;
          constraint gBindF { w > 0.3 }
      }`, {
      'D1::gBindF': ['F/F/?/F', 'F'],
      'D1::gDerF': ['F/F/F/?', 'F'],
      'D1::gDerT': ['T/T/T/T', 'T'],
      'D1::gSumF': ['F/F/F/F', 'F'],
      'D1::gSumT': ['T/T/T/T', 'T'],
    }),
    'soundC-r8': probe(`package R8 {
          part def P {
              attribute load : ScalarValues::Real;
              attribute m2 : ScalarValues::Real = 10.0 - load;
              assert constraint dl { load == 1.0 }
          }
          part p : P {
              attribute :>> load;
              assert constraint d50 { load == 50.0 }
          }
          constraint pLoad { p.load >= 10.0 }
          constraint pM2 { p.m2 >= 0.0 }
      }`, {
      'R8::P::dl': ['T/-/T/-', null],
      'R8::P::dl in R8::p': ['F/-/F/-', null],
      'R8::p::d50': ['T/-/?/-', null],
      'R8::pLoad': ['T/T/?/X', null],
      'R8::pM2': ['F/F/F/X', null],
    }),
    n2: probe(`package N2 {
        attribute x;
        attribute y;
        assert constraint a1 { x == 1.0 }
        assert constraint a2 { x == 2.0 }
        constraint c { y == x + 1.0 }
        constraint lim { x >= 5.0 }
      }`, {
      'N2::a1': ['T/-/?/-', null],
      'N2::a2': ['F/-/?/-', null],
      'N2::c': ['?/?/?/X', null],
      'N2::lim': ['F/F/?/X', null],
    }),
    fx4: probe(`package Fx4 {
          attribute x = 9.0;
          attribute z = x % 4.0;
          constraint c { z == 1.0 }
          constraint c2 { z <= 1.5 }
      }`, {
      'Fx4::c': ['T/T/T/?', 'T'],
      'Fx4::c2': ['T/T/T/?', 'T'],
    }),
    'xtrack-c1-chain': probe(`package C1 {
          part def P {
              attribute load : ScalarValues::Real default = 1.0;
              attribute m2 : ScalarValues::Real = 10.0 - load;
              attribute m3 : ScalarValues::Real = m2 * 2.0;
          }
          part p : P { attribute :>> load = 50.0; }
          constraint gT { p.m3 <= -79.0 }
          constraint gF { p.m3 >= 0.0 }
          attribute w : ScalarValues::Real;
          bind w = p.m3;
          constraint wT { w == -80.0 }
          constraint wF { w == 18.0 }
      }`, {
      'C1::gF': ['F/F/F/?', 'F'],
      'C1::gT': ['T/T/T/T', 'T'],
      'C1::wF': ['F/F/F/F', 'F'],
      'C1::wT': ['T/T/T/T', 'T'],
    }),
    // The branch review of O2: a reading shared among instances read alike (O2 S5) took a value the memo had
    // worked out for another relation without the questions it was worked out with, so it recorded none, and
    // every other instance took its verdict. Sh1: `m <= 1000.0` works q1's m (4) out first; `m <= 10.0` then
    // read q2's p at that 4 and held, on all four surfaces bar SMT, whose refutation at 100 the same-point gate
    // demoted (I13). Sh4b: the same through Q's own relation over `p.m`, declared first. TREE+e: tree10's tree
    // (the unit test's TREE) with `e`, a copy of `d`: e read m2 = 9 at every instance where d read −40 (I12).
    'sh1-memo-two-relations': probe(`package Sh1 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute m : ScalarValues::Real = load * 2.0;
          constraint c1 { m <= 1000.0 }
          constraint c2 { m <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { attribute :>> L = 50.0; }
      }`, {
      'Sh1::P::c1': ['T/T/T/T', 'T'],
      'Sh1::P::c1 in Sh1::Q::p': ['T/T/T/T', 'T'],
      'Sh1::P::c1 in Sh1::q1::p': ['T/T/T/T', 'T'],
      'Sh1::P::c1 in Sh1::q2::p': ['T/T/T/T', 'T'],
      'Sh1::P::c2': ['T/T/T/T', 'T'],
      'Sh1::P::c2 in Sh1::Q::p': ['T/T/T/T', 'T'],
      'Sh1::P::c2 in Sh1::q1::p': ['T/T/T/T', 'T'],
      'Sh1::P::c2 in Sh1::q2::p': ['F/F/F/F', 'F'],
    }),
    'sh4b-owned-reader-first': probe(`package Sh4b {
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          part p : P;
          bind p.load = L;
          constraint cq { p.m <= 1000.0 }
        }
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute m : ScalarValues::Real = load * 2.0;
          constraint c2 { m <= 10.0 }
        }
        part q1 : Q { attribute :>> L = 2.0; }
        part q2 : Q { attribute :>> L = 50.0; }
      }`, {
      'Sh4b::Q::cq': ['T/T/T/T', 'T'],
      'Sh4b::Q::cq in Sh4b::q1': ['T/T/T/T', 'T'],
      'Sh4b::Q::cq in Sh4b::q2': ['T/T/T/T', 'T'],
      'Sh4b::P::c2': ['T/T/T/T', 'T'],
      'Sh4b::P::c2 in Sh4b::Q::p': ['T/T/T/T', 'T'],
      'Sh4b::P::c2 in Sh4b::q1::p': ['T/T/T/T', 'T'],
      'Sh4b::P::c2 in Sh4b::q2::p': ['F/F/F/F', 'F'],
    }),
    'tree-e': probe(
      `package T {
        part def T0 {
          attribute load : ScalarValues::Real default = 1.0;
          attribute m2 : ScalarValues::Real = 10.0 - load;
          constraint c { load <= 10.0 }
          constraint d { m2 >= 0.0 }
          constraint e { m2 >= 0.0 }
        }
        part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; part b : T0; bind a.load = L; bind b.load = L; }
        part def T2 { attribute L : ScalarValues::Real default = 1.0; part a : T1; part b : T1; bind a.L = L; bind b.L = L; }
        part def T3 { attribute L : ScalarValues::Real default = 1.0; part a : T2; part b : T2; bind a.L = L; bind b.L = L; }
        part top : T3 { attribute :>> L = 50.0; }
        part mid : T3 { attribute :>> L = 7.0; }
      }`,
      // Each instance of T1's a and b reads the L of the root it is in: T2's and T3's own default 1, top's 50,
      // mid's 7. Under top, load is 50 (> 10) and m2 is −40 (< 0): c, d and e are violated there, and hold
      // everywhere else (load 1 or 7, m2 9 or 3).
      Object.fromEntries(
        ['c', 'd', 'e'].flatMap((rel) => [
          [`T::T0::${rel}`, ['T/T/T/T', 'T']],
          ...['a', 'b'].flatMap((g) => [
            [`T::T0::${rel} in T::T1::${g}`, ['T/T/T/T', 'T']],
            ...['T2', 'T3', 'top', 'mid'].flatMap((root) =>
              (root === 'T2' ? ['a', 'b'] : ['a::a', 'a::b', 'b::a', 'b::b']).map((path) => [
                `T::T0::${rel} in T::${root}::${path}::${g}`,
                root === 'top' ? ['F/F/F/F', 'F'] : ['T/T/T/T', 'T'],
              ]),
            ),
          ]),
        ]),
      ) as Record<string, [string, Ref]>,
    ),
    // A-H1 through a DERIVED value (the branch review of O2): the unit-aware reading, which judges a body before
    // the scalar one, read R1D's `s = load + x` in q1's p at x's default, past q1's `assert constraint tie {
    // p.x == 50.0 }` — `cd in q1::p` held at s = 5. Under H5's enclosing rule (O5 S3) s is 3 + 50 there, on
    // every surface, and the unit-aware reading reads no default an enclosing assert defines somewhere. Sh7:
    // the same in a tree, the assert in top's `part :>> b`, over `m = load * k` (5 × 50 under top).
    'refute-r1d': probe(`package R1D {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute x : ScalarValues::Real default = 2.0;
          attribute s : ScalarValues::Real = load + x;
          constraint cd { s <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 3.0; assert constraint tie { p.x == 50.0 } }
        part q2 : Q;
        constraint topd { q1.p.s <= 10.0 }
      }`, {
      'R1D::P::cd': ['T/T/T/T', 'T'],
      'R1D::P::cd in R1D::Q::p': ['T/T/T/T', 'T'],
      'R1D::P::cd in R1D::q1::p': ['F/F/F/F', 'F'],
      'R1D::P::cd in R1D::q2::p': ['T/T/T/T', 'T'],
      'R1D::q1::tie': ['T/-/T/-', 'T'],
      'R1D::topd': ['F/F/F/F', 'F'],
    }),
    'sh7-tree-assert-derived': probe(`package Sh7 {
        part def T0 {
          attribute load : ScalarValues::Real default = 1.0;
          attribute k : ScalarValues::Real default = 1.0;
          attribute m : ScalarValues::Real = load * k;
          constraint c { m <= 10.0 }
        }
        part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; bind a.load = L; }
        part def T2 { attribute L : ScalarValues::Real default = 1.0; part b : T1; bind b.L = L; }
        part top : T2 { attribute :>> L = 5.0; part :>> b { assert constraint { a.k == 50.0 } } }
      }`, {
      'Sh7::T0::c': ['T/T/T/T', 'T'],
      'Sh7::T0::c in Sh7::T1::a': ['T/T/T/T', 'T'],
      'Sh7::T0::c in Sh7::T2::b::a': ['T/T/T/T', 'T'],
      'Sh7::T0::c in Sh7::top::b::a': ['F/F/F/F', 'F'],
      'Sh7::top::«PartUsage»::«ConstraintUsage»': ['T/-/T/-', 'T'],
    }),
    // H5 (plan J decision 14, O5 S1): an asserted EQUATION of the feature's owner, or of a type its owner
    // specialises, stands over the feature's `default`, as a binding does (F's probes HL, HD, HR). HL at the
    // package, HD in a definition read through a usage, HR an assert inherited from Q over q's own `:>> L
    // default = 9.0`. Each was T/T/T/X with the assert violated: the default read beside the assert.
    'h5-hl': probe(`package HL {
        attribute L : ScalarValues::Real default = 2.0;
        assert constraint qa { L == 5.0 }
        constraint c { L <= 3.0 }
      }`, {
      'HL::c': ['F/F/F/F', 'F'],
      'HL::qa': ['T/-/T/-', 'T'],
    }),
    'h5-hd': probe(`package HD {
        part def Q { attribute L : ScalarValues::Real default = 2.0; assert constraint qa { L == 5.0 } constraint c { L <= 3.0 } }
        part q : Q;
        constraint top { q.L <= 3.0 }
      }`, {
      'HD::Q::c': ['F/F/F/F', 'F'],
      'HD::Q::qa': ['T/-/T/-', 'T'],
      'HD::top': ['F/F/F/F', 'F'],
    }),
    'h5-hr': probe(`package HR {
        part def Q { attribute L : ScalarValues::Real default = 2.0; assert constraint qa { L == 5.0 } }
        part q : Q { attribute :>> L default = 9.0; }
        constraint top { q.L <= 6.0 }
      }`, {
      'HR::Q::qa': ['T/-/T/-', 'T'],
      'HR::Q::qa in HR::q': ['T/-/T/-', 'T'],
      'HR::top': ['T/T/T/T', 'T'],
    }),
    // (a) Only a `default` gives way: a plain `=` against the assert stays the strict-KerML contradiction
    // (decision 1, F's HP), as it read before H5.
    'h5-hp': probe(`package HP {
        attribute L : ScalarValues::Real = 2.0;
        assert constraint qa { L == 5.0 }
        constraint c { L <= 3.0 }
      }`, {
      'HP::c': ['T/T/T/X', null],
      'HP::qa': ['F/-/F/-', 'F'],
    }),
    // S2's dotted assert does not reach a feature a binding joins (the end copy `bind p.x = L` makes): the
    // binding's value is read and the assert is checked against it, as before S2. RB's plain `L = 4.0` makes
    // the model contradict itself (decision 1); RB3's `L default = 4.0` stays open (an enclosing equation read
    // through a binding's end; not S4's definition-feature binds): read through the binding, the assert would
    // stand over L's default, and top/top2 are T (refs null until then).
    'h5-rbind': probe(`package RB {
        part def P { attribute x : ScalarValues::Real; constraint c { x <= 3.5 } }
        part q { part p : P; attribute L : ScalarValues::Real = 4.0; bind p.x = L; }
        assert constraint tie { q.p.x == 3.0 }
        constraint top { q.p.x <= 3.5 }
      }`, {
      'RB::P::c': ['?/?/?/X', null],
      'RB::tie': ['F/-/F/-', 'F'],
      'RB::top': ['F/F/F/X', null],
    }),
    'h5-rb3': probe(`package RB3 {
        part def P { attribute x : ScalarValues::Real; constraint c { x <= 3.5 } }
        part q { part p : P; attribute L : ScalarValues::Real default = 4.0; bind p.x = L; }
        assert constraint tie { q.p.x == 3.0 }
        constraint top { q.L <= 3.5 }
        constraint top2 { q.p.x <= 3.5 }
      }`, {
      'RB3::P::c': ['?/?/?/X', null],
      'RB3::tie': ['F/-/F/-', null],
      'RB3::top': ['F/F/F/X', null],
      'RB3::top2': ['F/F/F/X', null],
    }),
    // H5's enclosing rule (O5 S3): an asserted equation written in an instance around a defaulted feature —
    // `p.x == 50.0` in q1 — defines it in that instance alone, on every surface, as a binding would; P's own
    // x and every other instance's keep the default. With no binding in the model (HE), q1's assert alone
    // splits P's `c` per instance: `c in q1::p` is a row of its own, read at 50.
    'h5-he': probe(`package HE {
        part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 10.0 } }
        part def Q { part p : P; }
        part q1 : Q { assert constraint tie { p.x == 50.0 } }
        constraint top { q1.p.x <= 10.0 }
      }`, {
      'HE::P::c': ['T/T/T/T', 'T'],
      'HE::P::c in HE::Q::p': ['T/T/T/T', 'T'],
      'HE::P::c in HE::q1::p': ['F/F/F/F', 'F'],
      'HE::q1::tie': ['T/-/T/-', 'T'],
      'HE::top': ['F/F/F/F', 'F'],
    }),
    // U5: an inequality defines nothing. The default stands, q1's `lim` is violated against it, and the SMT
    // lane finds the axioms contradict (I7, reviewed).
    'h5-hi': probe(`package HI {
        part def P { attribute x : ScalarValues::Real default = 2.0; }
        part def Q { part p : P; }
        part q1 : Q { assert constraint lim { p.x >= 5.0 } }
        constraint top { q1.p.x <= 10.0 }
      }`, {
      'HI::q1::lim': ['F/-/F/-', 'F'],
      'HI::top': ['T/T/T/X', 'T'],
    }),
    // A context whose own assert changes what a relation of its type reads (q1's `p.x == 50.0` under Q's `c`),
    // and a specialisation whose bare `L == 5.0` holds over the L it inherits (D :> Q): each reads Q's
    // relations as its own row.
    'h5-hq': probe(`package HQ {
        part def P { attribute x : ScalarValues::Real default = 2.0; }
        part def Q {
          part p : P;
          attribute L : ScalarValues::Real default = 2.0;
          constraint c { p.x <= 10.0 }
          constraint cl { L <= 3.0 }
        }
        part def D :> Q { assert constraint dl { L == 5.0 } }
        part q1 : Q { assert constraint tie { p.x == 50.0 } }
        part q2 : Q;
        part d : D;
      }`, {
      'HQ::D::dl': ['T/-/T/-', 'T'],
      'HQ::Q::c': ['T/T/T/T', 'T'],
      'HQ::Q::c in HQ::q1': ['F/F/F/F', 'F'],
      'HQ::Q::cl': ['T/T/T/T', 'T'],
      'HQ::Q::cl in HQ::D': ['F/F/F/F', 'F'],
      'HQ::q1::tie': ['T/-/T/-', 'T'],
    }),
    // O2's inputs to O5 S3: own rows read past q1's assert on the unit-aware path (R1M's top2 over the derived
    // `m2 = 10.0 - x`, R1B6's top4/top6/top7), decided from x's default until H5; the package's assert (H1C);
    // and an assert inherited from the instance's type (H1F2's `Q2 :> Q`), which no reading saw: q1's p and
    // Q2's own p read T at x's default.
    'h5-r1u': probe(`package R1U {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute x : ScalarValues::Real default = 2.0;
          attribute m2 : ScalarValues::Real = 10.0 - x;
          constraint c { load + x <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 3.0; assert constraint tie { p.x == 50.0 } }
        part q2 : Q;
        constraint top2 { q1.p.m2 >= 0.0 }
        constraint top4 { q1.p.x >= 0.0 }
        constraint top6 { q1.p.x <= 10.0 }
        constraint top7 { q1.p.x + q1.p.load <= 10.0 }
      }`, {
      'R1U::P::c': ['T/T/T/T', 'T'],
      'R1U::P::c in R1U::Q::p': ['T/T/T/T', 'T'],
      'R1U::P::c in R1U::q1::p': ['F/F/F/F', 'F'],
      'R1U::P::c in R1U::q2::p': ['T/T/T/T', 'T'],
      'R1U::q1::tie': ['T/-/T/-', 'T'],
      'R1U::top2': ['F/F/F/F', 'F'],
      'R1U::top4': ['T/T/T/T', 'T'],
      'R1U::top6': ['F/F/F/F', 'F'],
      'R1U::top7': ['F/F/F/F', 'F'],
    }),
    'h5-h1c': probe(`package H1C {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute x : ScalarValues::Real default = 2.0;
          constraint c { load + x <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 3.0; }
        part q2 : Q;
        assert constraint t { q1.p.x == 50.0 }
        constraint top1 { q1.p.load + q1.p.x <= 10.0 }
      }`, {
      'H1C::P::c': ['T/T/T/T', 'T'],
      'H1C::P::c in H1C::Q::p': ['T/T/T/T', 'T'],
      'H1C::P::c in H1C::q1::p': ['F/F/F/F', 'F'],
      'H1C::P::c in H1C::q2::p': ['T/T/T/T', 'T'],
      'H1C::t': ['T/-/T/-', 'T'],
      'H1C::top1': ['F/F/F/F', 'F'],
    }),
    'h5-h1f2': probe(`package H1F2 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute x : ScalarValues::Real default = 2.0;
          constraint c { load + x <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part def Q2 :> Q { assert constraint tie { p.x == 50.0 } }
        part q1 : Q2 { attribute :>> L = 3.0; }
        part q2 : Q;
        constraint top1 { q1.p.load + q1.p.x <= 10.0 }
      }`, {
      'H1F2::P::c': ['T/T/T/T', 'T'],
      'H1F2::P::c in H1F2::Q2::p': ['F/F/F/F', 'F'],
      'H1F2::P::c in H1F2::Q::p': ['T/T/T/T', 'T'],
      'H1F2::P::c in H1F2::q1::p': ['F/F/F/F', 'F'],
      'H1F2::P::c in H1F2::q2::p': ['T/T/T/T', 'T'],
      'H1F2::Q2::tie': ['T/-/T/-', 'T'],
      'H1F2::top1': ['F/F/F/F', 'F'],
    }),
    // An enclosing equation over the frame's own names (q4's `p.x == M`) is read in that frame's instance, and
    // each instance under its own frame (q1's 50 and q3's 5) apart, read through the derived `s = x + 1.0`.
    'h5-hx': probe(`package HX4 {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute x : ScalarValues::Real default = 2.0;
          attribute s : ScalarValues::Real = x + 1.0;
          constraint c { s <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 3.0; assert constraint t1 { p.x == 50.0 } }
        part q3 : Q { attribute :>> L = 3.0; assert constraint t3 { p.x == 5.0 } }
        part q4 : Q { attribute :>> L = 3.0; attribute M : ScalarValues::Real = 60.0; assert constraint t4 { p.x == M } }
        constraint top4 { q4.p.x <= 10.0 }
      }`, {
      'HX4::P::c': ['T/T/T/T', 'T'],
      'HX4::P::c in HX4::Q::p': ['T/T/T/T', 'T'],
      'HX4::P::c in HX4::q1::p': ['F/F/F/F', 'F'],
      'HX4::P::c in HX4::q3::p': ['T/T/T/T', 'T'],
      'HX4::P::c in HX4::q4::p': ['F/F/F/F', 'F'],
      'HX4::q1::t1': ['T/-/T/-', 'T'],
      'HX4::q3::t3': ['T/-/T/-', 'T'],
      'HX4::q4::t4': ['T/-/T/-', 'T'],
      'HX4::top4': ['F/F/F/F', 'F'],
    }),
    // The planted bug P5's shape (literals counted in `readsOtherwise`): a literal `default` the local rule
    // overrides (Q's `L default = 7.0` under `L == 2.0 * K`) is the equation's value, and q1, whose K is 25,
    // reads it otherwise — 50 — through Q's binding. With the literal guard over it, Q's p read P's `c` for
    // every Q (T) and q1's p was never read. The SMT `?` at q2's p is the unconfirmed witness of a group row
    // whose bound value an asserted equation gives (E9).
    'h5-p5': probe(`package P5G {
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
      }`, {
      'P5G::P::c': ['T/T/T/T', 'T'],
      'P5G::P::c in P5G::Q::p': ['T/T/T/T', 'T'],
      'P5G::P::c in P5G::q1::p': ['F/F/F/F', 'F'],
      'P5G::P::c in P5G::q2::p': ['T/T/T/?', 'T'],
      'P5G::Q::ldef': ['T/-/T/-', 'T'],
      'P5G::Q::ldef in P5G::q1': ['T/-/T/-', 'T'],
    }),
    // A binding into the instance is read over its type's assert, which is checked against it (RB): q1's plain
    // K = 7, bound to p.x, against Q's `p.x == 50.0` is the contradiction of decision 1, and q1's p reads 7 on
    // every surface. Read at the assert's 50 instead, top1 was F on the check beside the numeric T.
    'h5-bnd': probe(`package BND {
        part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 10.0 } }
        part def Q { part p : P; assert constraint tie { p.x == 50.0 } }
        part q1 : Q { attribute K : ScalarValues::Real = 7.0; bind p.x = K; }
        part q2 : Q;
        constraint top1 { q1.p.x <= 10.0 }
        constraint top2 { q2.p.x <= 10.0 }
      }`, {
      'BND::P::c': ['T/T/T/X', null],
      'BND::P::c in BND::Q::p': ['F/F/F/X', null],
      'BND::P::c in BND::q1::p': ['T/T/T/X', null],
      'BND::P::c in BND::q2::p': ['F/F/F/X', null],
      'BND::Q::tie': ['T/-/T/-', null],
      'BND::Q::tie in BND::q1': ['F/-/F/-', 'F'],
      'BND::top1': ['T/T/T/X', null],
      'BND::top2': ['F/F/F/X', null],
    }),
    // U7's Q3 under an enclosing assert: a redefined `default` that stands for one instance, which an assert
    // of q1 (Q3E) or of q1's type (TWO) defines, reads the assert's 50 on every surface; the SMT lane emits
    // no `x == 9` axiom beside it, which made every row of the file `inconsistent-axioms`.
    'h5-q3e': probe(`package Q3E {
        part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 10.0 } }
        part def Q { part p : P; }
        part q1 : Q { part :>> p { attribute :>> x default = 9.0; } assert constraint tie { p.x == 50.0 } }
        constraint top { q1.p.x <= 10.0 }
      }`, {
      'Q3E::P::c': ['T/T/T/T', 'T'],
      'Q3E::P::c in Q3E::Q::p': ['T/T/T/T', 'T'],
      'Q3E::P::c in Q3E::q1::p': ['F/F/F/F', 'F'],
      'Q3E::q1::tie': ['T/-/T/-', 'T'],
      'Q3E::top': ['F/F/F/F', 'F'],
    }),
    'h5-two': probe(`package TWO {
        part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 10.0 } }
        part def Q { part p : P; assert constraint tie { p.x == 50.0 } }
        part q1 : Q { part :>> p { attribute :>> x default = 9.0; } }
        part q2 : Q;
        part pp : P;
        constraint both { q1.p.x - pp.x == 48.0 }
        constraint both2 { q2.p.x + pp.x == 52.0 }
      }`, {
      'TWO::P::c': ['T/T/T/T', 'T'],
      'TWO::P::c in TWO::Q::p': ['F/F/F/F', 'F'],
      'TWO::P::c in TWO::q1::p': ['F/F/F/F', 'F'],
      'TWO::P::c in TWO::q2::p': ['F/F/F/F', 'F'],
      'TWO::Q::tie': ['T/-/T/-', 'T'],
      'TWO::both': ['T/T/t/T', 'T'],
      'TWO::both2': ['T/T/T/T', 'T'],
    }),
    // U7's Q4 under an enclosing assert: `p.x == L` (Q4E) or `p.x == M` (Q4B) with defaults on both sides
    // gives no value — both defaults give way in q1 and neither is read, on every surface; P's own reading,
    // Q's p and q2's p keep x's default. Both read the default and the inconsistent axioms before.
    'h5-q4e': probe(`package Q4E {
        part def P { attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 5.0 } }
        part def Q { part p : P; }
        part q1 : Q { attribute L : ScalarValues::Real default = 9.0; assert constraint tie { p.x == L } }
        part q2 : Q;
        constraint top { q1.p.x <= 5.0 }
      }`, {
      'Q4E::P::c': ['T/T/T/T', 'T'],
      'Q4E::P::c in Q4E::Q::p': ['T/T/T/T', 'T'],
      'Q4E::P::c in Q4E::q1::p': ['?/?/?/?', '?'],
      'Q4E::P::c in Q4E::q2::p': ['T/T/T/T', 'T'],
      'Q4E::q1::tie': ['?/-/T/-', null],
      'Q4E::top': ['?/?/?/?', '?'],
    }),
    'h5-q4b': probe(`package Q4B {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute x : ScalarValues::Real default = 2.0;
          constraint c { load + x <= 10.0 }
        }
        part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
        part q1 : Q { attribute :>> L = 3.0; attribute M : ScalarValues::Real default = 60.0; assert constraint tie { p.x == M } }
        part q2 : Q;
        constraint top1 { q1.p.load + q1.p.x <= 10.0 }
      }`, {
      'Q4B::P::c': ['T/T/T/T', 'T'],
      'Q4B::P::c in Q4B::Q::p': ['T/T/T/T', 'T'],
      'Q4B::P::c in Q4B::q1::p': ['?/?/?/?', '?'],
      'Q4B::P::c in Q4B::q2::p': ['T/T/T/T', 'T'],
      'Q4B::q1::tie': ['?/-/T/-', null],
      'Q4B::top1': ['?/?/?/?', '?'],
    }),
    // The same equation of Q over a name q states with `=` (the corpus's h2e): q's `:>> L = 50.0` is no
    // default, so in q the equation reads it and defines q's p's load as 50 — m2 is −40. Q's own row keeps
    // U7's abstention (L's default and load's). Every surface read load's default 1 before, or none (SMT X).
    'h5-h2e': probe(`package H2E {
        part def P {
          attribute load : ScalarValues::Real default = 1.0;
          attribute m2 : ScalarValues::Real = 10.0 - load;
        }
        part def Q {
          attribute L : ScalarValues::Real default = 1.0;
          part p : P;
          assert constraint tie { p.load == L }
        }
        part q : Q { attribute :>> L = 50.0; }
        constraint m2NegT { q.p.m2 <= 0.0 }
        constraint m2PosF { q.p.m2 >= 0.0 }
      }`, {
      'H2E::Q::tie': ['?/-/T/-', null],
      'H2E::Q::tie in H2E::q': ['T/-/T/-', 'T'],
      'H2E::m2NegT': ['T/T/T/T', 'T'],
      'H2E::m2PosF': ['F/F/F/F', 'F'],
    }),
  };

  /**
   * I2's exceptions: the rows a surface decides FALSELY today, `probe | row` → why, and the step that
   * corrects it.
   *
   * F1 corrected the rows where a derived value a binding reaches through a second definition-level
   * value (M2's `L = 2.0 * K` under q's K of 25, refute-r8's two levels, refute-r16*'s input through a
   * second binding, an asserted partner, units, a specialised override, a sibling) was read at the
   * definition — q's p's m2 read 9 where it is −40, and the same reading called the binding a
   * contradiction (`#bind`) — and a package binding past 32 segments (chainPkg33) left the end's default
   * standing: the check and the literal engine now abstain on them.
   *
   * The table's own review added rows false on ALL FOUR surfaces — no clash, so only a `ref` sees them:
   * a usage-body binding whose type redefines a bound end (h2-bodyspec-*) — still no step — an assert
   * inherited through the end copy (assert-min, G340; FanS2's `#bind`), a bound redefinition's fall-through
   * (held-redef*) and a binding through a reference feature (ref-W9): all four are now corrected on every
   * surface. d1plain is A.5 against A.2.1, still for the plan to settle; w4-plain is its shape through a
   * package's binding on a definition's feature (H5 S4), with no `#bind` row on the check.
   *
   * F1b corrected the rows where two defaults a binding joins were agreed by their TEXT (`2.0 * K` read in
   * two instances, R3a–c) though their values differ (2 vs 10; 2 vs 50): no value exists, and no
   * contradiction (their `#bind`); every surface now abstains on them.
   */
  const KNOWN_FALSE = new Map<string, string>([
    ...[
      ['h2-bodyspec-plain', 'H2BP::m2NegT'],
      ['h2-bodyspec-plain', 'H2BP::m2PosF'],
      ['h2-bodyspec-rev', 'H2BR::lT'],
      ['h2-bodyspec-rev', 'H2BR::lF'],
    ].map(
      ([p, row]) =>
        [
          `${p} | ${row}`,
          'NO STEP YET (plan amendment needed): the implicit end copy of a usage-body binding redefines the DECLARING feature (`H2BP::q::L` redefines Q::L, not Q2::L), so every surface reads the general value or none, and P’s default stands; outside B.1’s files (the copy should redefine the most specific inherited feature, or such a binding be refused on all four surfaces)',
        ] as const,
    ),
    ...['D1P::at30', 'D1P::atL'].map(
      (row) =>
        [
          `d1plain | ${row}`,
          'A.5 against A.2.1, for the plan to settle: q’s plain `load = 30.0` against the bound L = 50.0 is two values (decision 1), and A.5 has both read nothing (the conflict row reports it); A.2.1 never replaces today’s decided reading, so no step yet makes these abstain',
        ] as const,
    ),
    [
      'w4-plain | W4o::c4',
      'd1plain’s shape through a package’s `bind P::load = L` (E6, U11 decided A.5: O6 S3): p4’s plain `:>> load = 7.0` against L = 50.0 is two values (decision 1), and A.5 has both read nothing; unlike d1plain, the check and the numeric surface file no per-instance `#bind` row for a package’s binding on a definition’s feature, so `sysml-check` is silent where SMT reports inconsistent-axioms',
    ] as const,
  ]);
  /**
   * I6's exceptions: rows whose printed witness is not the value they compared. There were eleven (M3's two,
   * refute-r19's three, sound-C r8's p, d1plain's two, assert-min-def's two, u-witness's p2.k): every one a
   * path read through an instance of its own, whose witness `modelBindings` took from the feature
   * (`evaluateFeatureValue`, the definition's 9 or 7 or 4000) instead of from where the relation reads it.
   * F2 reads such a path with `valueAtPath`, and the list is empty — it stays, exact, so that a witness
   * that stops being the compared value fails here instead of being listed.
   */
  const KNOWN_FALSE_WITNESS = new Set<string>();
  /**
   * I6's rows whose witness prints NO value for the compared path (`value: null`), on both engines, in
   * the row and in its record — recorded, not compared, and listed exactly as the false ones are.
   * u-m2's (a derived quantity, `q.p.m2` in kg, left empty beside the compared 9) left with F1, which
   * decides those rows no longer where the witness was printed; G271's control r0's `q.p.m2` (kg) is
   * such a quantity too, beside its correct refutation. W4N's P's own `m2`, derived from the load a package's
   * `bind P::load = L` gives, is K5's shape: a derived value over a bound default.
   */
  const WITNESS_UNPRINTED = new Set(['k5 | K5::n', 'w4-nested | W4N::P::c']);
  /**
   * I7's exceptions: an SMT `inconsistent-axioms` beside a T or F elsewhere, `probe | row` → reason.
   * Checked on every probe, not only those with `bind` or `default`: three of the reviewed entries (n4,
   * sound-C r8, n2) are models whose asserts alone admit no value. sound-C r8's two variants are one
   * text, so it is one probe here, and its `pM2` sits beside `pLoad` for the same reason.
   */
  const I7_ALLOWED = new Map<string, string>([
    ['n4 | N4::zl', 'an asserted `x * x == -1.0` admits no model; the numeric surface reads z apart from it (out of scope)'],
    ['soundC-r8 | R8::pLoad', 'P’s asserted `load == 1.0` and p’s asserted `load == 50.0` contradict; the check reads p’s'],
    ['soundC-r8 | R8::pM2', 'the same contradiction, read through m2'],
    ['n2 | N2::lim', 'two asserts give x two values; the check reads one'],
    ['h5-hp | HP::c', 'L’s plain `= 2.0` against the asserted `L == 5.0`: the strict-KerML contradiction (decision 1); the check reads L’s value'],
    ['h5-rbind | RB::top', 'q’s plain `L = 4.0`, bound to q.p.x, against the asserted `q.p.x == 3.0`: the contradiction of decision 1'],
    ['w4-plain | W4o::c4', 'p4’s plain `:>> load = 7.0` against the package’s bound L = 50.0: the strict-KerML contradiction (decision 1) the SMT engine reports; the other surfaces read p4’s value (see KNOWN_FALSE)'],
    // Not decision 1: under H5 the assert would stand over L's default through the binding (open: binding-component reads).
    ...['RB3::top', 'RB3::top2'].map(
      (row) => [`h5-rb3 | ${row}`, 'the asserted `q.p.x == 3.0` against L’s default 4.0, bound to q.p.x: the enclosing equation is not read through a binding’s end yet (H5, open)'] as const,
    ),
    ['h5-hi | HI::top', 'an inequality defines nothing (U5): x’s default stands and q1’s asserted `p.x >= 5.0` contradicts it; the check reads the default'],
    ...['BND::P::c', 'BND::P::c in BND::Q::p', 'BND::P::c in BND::q1::p', 'BND::P::c in BND::q2::p', 'BND::top1', 'BND::top2'].map(
      (row) =>
        [
          `h5-bnd | ${row}`,
          'q1’s plain `K = 7.0`, bound to q1.p.x, against Q’s asserted `p.x == 50.0`: the contradiction of decision 1; q1’s p reads the binding’s 7 (RB)',
        ] as const,
    ),
    ...['D1P::at30', 'D1P::atL'].map(
      (row) =>
        [
          `d1plain | ${row}`,
          'q’s plain `load = 30.0` against the bound L = 50.0: the strict-KerML contradiction (decision 1) the SMT engine reports; the other surfaces read q’s value (A.5 against A.2.1, see KNOWN_FALSE)',
        ] as const,
    ),
  ]);

  const seen = new Map<string, Map<string, SurfaceRow>>();
  beforeAll(async () => {
    if (!backendPresent) return;
    for (const [name, p] of Object.entries(PROBES)) seen.set(name, await fourSurfaces(p.text, name));
  }, 600_000);
  /** Every row a probe pins or a surface filed, with its `ref` (null for a row no pin names: I3 reports it). */
  const each = () =>
    Object.entries(PROBES).flatMap(([name, p]) =>
      [...new Set([...Object.keys(p.rows), ...(seen.get(name)?.keys() ?? [])])].map((row) => ({
        name,
        row,
        ref: p.rows[row]?.[1] ?? null,
        got: seen.get(name)?.get(row),
      })),
    );

  withZ3('I3: every probe’s rows, and each row’s four verdicts, are as pinned', () => {
    const drift: string[] = [];
    for (const [name, p] of Object.entries(PROBES)) {
      const got = seen.get(name)!;
      for (const [row, s] of got) {
        const pinned = p.rows[row]?.[0];
        if (pinned !== s.verdicts.join('/')) drift.push(`${name} | ${row}: pinned ${pinned ?? 'no row'}, now ${s.verdicts.join('/')}`);
      }
      for (const row of Object.keys(p.rows)) if (!got.has(row)) drift.push(`${name} | ${row}: pinned, now no row`);
    }
    expect(drift).toEqual([]);
  });

  withZ3('I1: no row is T on one surface and F on another', () => {
    const clash = each().filter((r) => r.got && r.got.verdicts.includes('T') && r.got.verdicts.includes('F'));
    expect(clash.map((r) => `${r.name} | ${r.row}: ${r.got!.verdicts.join('/')}`)).toEqual([]);
  });

  withZ3('I2: a decided verdict is the hand-computed one — the known false ones exactly excepted', () => {
    const wrong = new Map<string, string>();
    for (const { name, row, ref, got } of each()) {
      if (ref === null || !got) continue;
      const bad = got.verdicts.flatMap((l, s) => (decided(l) && l !== ref ? [`${SURFACES[s]} ${l}`] : []));
      if (bad.length > 0) wrong.set(`${name} | ${row}`, `${bad.join(', ')} where it is ${ref}`);
    }
    // Exactly the known ones: a new false verdict fails, and so does a corrected one still listed.
    expect([...wrong.keys()].filter((k) => !KNOWN_FALSE.has(k)).map((k) => `${k}: ${wrong.get(k)}`)).toEqual([]);
    expect([...KNOWN_FALSE.keys()].filter((k) => !wrong.has(k))).toEqual([]);
    // Every known one a step of this plan corrects is one the check and the literal engine publish, the
    // surfaces this work corrects; one whose reason starts with `NO STEP` is exempt from that.
    for (const [k, why] of KNOWN_FALSE) if (!why.startsWith('NO STEP')) expect(wrong.get(k), k).toMatch(/check [TF]/);
  });

  withZ3('I4: every abstention says why', () => {
    const silent = each().flatMap(({ name, row, got }) =>
      got
        ? got.verdicts.flatMap((l, s) =>
            l !== '-' && l !== 't' && !decided(l) && got.why[s]!.trim().length < 20 ? [`${name} | ${row}: ${SURFACES[s]}`] : [],
          )
        : [],
    );
    expect(silent).toEqual([]);
  });

  withZ3('I5: a row has one element id on every surface that files it', () => {
    const split = each().filter((r) => r.got && r.got.ids.size !== 1);
    expect(split.map((r) => `${r.name} | ${r.row}: ${[...r.got!.ids].join(', ')}`)).toEqual([]);
  });

  withZ3('I6: a literal or SMT witness is the value the row compared — the known false ones exactly excepted', () => {
    const wrong = each().filter((r) => r.got && r.got.witness.length > 0);
    expect(
      wrong.filter((r) => !KNOWN_FALSE_WITNESS.has(`${r.name} | ${r.row}`)).map((r) => `${r.name} | ${r.row}: ${r.got!.witness.join('; ')}`),
    ).toEqual([]);
    expect([...KNOWN_FALSE_WITNESS].filter((k) => !wrong.some((r) => `${r.name} | ${r.row}` === k))).toEqual([]);
    // Every one of them is printed by both engines, in the row and in its evidence record.
    for (const r of wrong) expect(r.got!.witness.map((w) => w.split(' ').slice(0, 2).join(' ')), r.row).toEqual([
      'literal: bindings',
      'literal: record',
      'smt: bindings',
      'smt: record',
    ]);
    // A witness with no value is not compared — and not silently skipped: exactly the listed rows, everywhere.
    const unprinted = each().filter((r) => r.got && r.got.unprinted.length > 0);
    expect(unprinted.map((r) => `${r.name} | ${r.row}`).filter((k) => !WITNESS_UNPRINTED.has(k))).toEqual([]);
    expect([...WITNESS_UNPRINTED].filter((k) => !unprinted.some((r) => `${r.name} | ${r.row}` === k))).toEqual([]);
    for (const r of unprinted) expect(r.got!.unprinted, r.row).toEqual(['literal: bindings', 'literal: record', 'smt: bindings', 'smt: record']);
  });

  withZ3('I7: inconsistent axioms beside a decided verdict only where reviewed, and only while it happens', () => {
    const beside = each().filter((r) => r.got && r.got.verdicts[3] === 'X' && r.got.verdicts.some(decided));
    const keys = beside.map((r) => `${r.name} | ${r.row}`);
    expect(keys.filter((k) => !I7_ALLOWED.has(k))).toEqual([]);
    expect([...I7_ALLOWED.keys()].filter((k) => !keys.includes(k))).toEqual([]);
  });

  withZ3('I8: no engine reads one name both proved and refuted', () => {
    expect([...bothWays].flatMap(([name, rows]) => rows.map((r) => `${name} | ${r}`))).toEqual([]);
  });

  withZ3('I9: no engine files one name twice', () => {
    expect([...twice].flatMap(([name, rows]) => rows.map((r) => `${name} | ${r}`))).toEqual([]);
  });

  withZ3('I11: a row shared among instances read alike is the row the instance’s own reading gives', () => {
    expect([...unshared].flatMap(([name, rows]) => rows.map((r) => `${name} | ${r}`))).toEqual([]);
  });

  withZ3('I12: a relation and its verbatim copy give the same rows', () => {
    expect([...copied].flatMap(([name, rows]) => rows.map((r) => `${name} | ${r}`))).toEqual([]);
    // Not vacuous: the copies of every probe's own one-line relations were compared.
    expect(copiedRelations).toBeGreaterThan(150);
  });

  /**
   * I13's exceptions, `probe | row` → reason: an instance row the SMT engine refutes with nothing freed — the
   * witness must then be the model's own point — while the check reads that point otherwise; the same-point
   * gate demotes the SMT row to `inconclusive` ("witness not confirmed: with nothing freed …"). Listed exactly.
   */
  const SAME_POINT_DEMOTED = new Map<string, string>([
    [
      'h5-p5 | P5G::P::c in P5G::q2::p',
      'q2’s p’s load is Q’s bound L, which only the asserted `L == 2.0 * K` gives a value: the group row reads no instance axiom for it (E9)',
    ],
  ]);
  withZ3('I13: an SMT refutation with nothing freed against the check’s verdict only where listed', () => {
    const demoted = each().filter(
      (r) =>
        r.got !== undefined &&
        r.row.includes(' in ') &&
        decided(r.got.verdicts[0]) &&
        r.got.verdicts[3] === '?' &&
        r.got.why[3].includes('witness not confirmed: with nothing freed'),
    );
    const keys = demoted.map((r) => `${r.name} | ${r.row}`);
    expect(keys.filter((k) => !SAME_POINT_DEMOTED.has(k))).toEqual([]);
    expect([...SAME_POINT_DEMOTED.keys()].filter((k) => !keys.includes(k))).toEqual([]);
  });

  // PI-1: a usage-owned relation's one other instance (pi1-r17's q1::p) was refuted by verify while
  // `sysml-check --strict` printed "OK, 0 findings" and exited 0, so nothing gating on it could block.
  withZ3('I10: check ≡ verify — sysml-check is never silent on a row verify refutes', () => {
    expect([...unreported].flatMap(([name, rows]) => rows.map((r) => `${name} | ${r}`))).toEqual([]);
    // Not vacuous: the table holds refuted rows of every kind I10 names.
    const refutedRows = each().filter((r) => r.got && (r.got.verdicts[1] === 'F' || r.got.verdicts[3] === 'F'));
    expect(refutedRows.filter((r) => !r.row.includes(' in ')).length).toBeGreaterThan(0);
    expect(refutedRows.filter((r) => r.row.includes(' in ')).length).toBeGreaterThan(0);
  });
});

/*
 * The witness a literal or SMT row prints for a path read through an instance of its own — q's m2, over
 * `part q : Q { :>> K = 25.0 }` — is that instance's value, read where the relation reads it
 * (`valueAtPath`), in the row's bindings and in its evidence record. It was the feature's own value, Q's 9
 * beside the −40 the row compared; and where the check reads no value at the path it is no value, not 9.
 * The per-instance table pins the left-hand side of every row (I6); this pins the rest of a relation.
 */
describe('a witness is the value at the path the row read, not the feature’s own', () => {
  const Q = `part def Q {
      attribute K : ScalarValues::Real default = 0.5;
      attribute L : ScalarValues::Real = 2.0 * K;
      attribute m2 : ScalarValues::Real = 10.0 - L;
    }`;
  const TWO = `package W2 { ${Q}
      part q : Q { attribute :>> K = 25.0; }
      part q2 : Q { attribute :>> K = 0.1; }
      constraint both { q.m2 <= q2.m2 }
    }`;
  const M2 = `package W3 {
      part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
      part def Q2 {
        attribute K : ScalarValues::Real default = 0.5;
        attribute L : ScalarValues::Real = 2.0 * K;
        part p : P;
        bind p.load = L;
      }
      part q : Q2 { attribute :>> K = 25.0; }
      constraint m2NegT { q.p.m2 <= 0.0 }
    }`;
  /** The values a row printed per path, in its bindings and in its record. */
  async function printed(text: string, pkg: string, engine: 'literal' | 'smt', clause: string) {
    const m = await contextModel(text, pkg);
    const report = await verifyModel(m, { engine, sourceText: text });
    const row = report.results.find((r) => r.clause.qualifiedName === clause)!;
    const record = report.records.find((x) => x.obligation.clause === clause);
    const by = (list: ReadonlyArray<{ path: string; value?: unknown }> | undefined) =>
      Object.fromEntries((list ?? []).map((b) => [b.path, b.value ?? null]));
    return { claim: row.claim, row: by(row.bindings), record: by(record?.witness?.values) };
  }
  const close = (got: Record<string, unknown>, want: Record<string, number>) => {
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const [path, v] of Object.entries(want)) expect(got[path] as number, path).toBeCloseTo(v, 12);
  };

  it('literal: each instance of one definition prints its own value on both sides of the relation', async () => {
    const p = await printed(TWO, 'W2', 'literal', 'W2::both');
    expect(p.claim).toBe('holds-at-values');
    close(p.row, { 'q.m2': -40, 'q2.m2': 9.8 });
    close(p.record, { 'q.m2': -40, 'q2.m2': 9.8 });
  });

  withZ3('smt: the same point, in the row and in its record', async () => {
    const p = await printed(TWO, 'W2', 'smt', 'W2::both');
    expect(p.claim).toBe('proved');
    close(p.row, { 'q.m2': -40, 'q2.m2': 9.8 });
    close(p.record, { 'q.m2': -40, 'q2.m2': 9.8 });
  });

  it('literal: prints the value the check read per instance (F5): q.p.m2 is −40, never the definition’s 9', async () => {
    const p = await printed(M2, 'W3', 'literal', 'W3::m2NegT');
    expect(p.claim).toBe('holds-at-values');
    expect(p.row).toEqual({ 'q.p.m2': -40 });
    expect(p.record).toEqual({ 'q.p.m2': -40 });
  });

  withZ3('smt: the same point, read per instance, in the row and in its record', async () => {
    const p = await printed(M2, 'W3', 'smt', 'W3::m2NegT');
    expect(p.claim).toBe('proved');
    expect(p.row).toEqual({ 'q.p.m2': -40 });
    expect(p.record).toEqual({ 'q.p.m2': -40 });
  });

  // xtrack iu1: a unit literal applied to a computed operand. The scalar reading `valueAtPath` does not
  // read r's total (4 GiB), though the unit-aware reading the row is judged by does — so the row is decided
  // and F5's `check.reads` prints r.total = 4 GiB.
  const IU1 = `package IU1 {
      part def P {
        attribute cap : ISQ::StorageCapacityValue default = 2.0 [GiB];
        attribute k : ScalarValues::Real default = 1.0;
        attribute total : ISQ::StorageCapacityValue = (k * 2.0) [GiB];
      }
      part r : P { attribute :>> k = cap / 1.0 [GiB]; }
      constraint rT { r.total == 4.0 [GiB] }
    }`;

  it('literal: a decided row whose value is a unit-literal expression prints it (F5): r.total = 4 GiB', async () => {
    const p = await printed(IU1, 'IU1', 'literal', 'IU1::rT');
    expect(p.claim).toBe('holds-at-values');
    expect(p.row).toEqual({ 'r.total': 4 });
    expect(p.record).toEqual({ 'r.total': 4 });
  });

  withZ3('smt: the same, proved', async () => {
    const p = await printed(IU1, 'IU1', 'smt', 'IU1::rT');
    expect(p.claim).toBe('proved');
    expect(p.row).toEqual({ 'r.total': 4 });
    expect(p.record).toEqual({ 'r.total': 4 });
  });

  it('keeps the feature’s own value, in its declared unit, for a path read through no instance of its own', async () => {
    const text = `package W4 {
      part def P { attribute m : ISQ::MassValue default = 2000.0 [SI::g]; attribute n : ScalarValues::Real = 3.0; }
      part p : P;
      constraint c { p.m <= 3.0 [SI::kg] }
      constraint d { p.n <= 4.0 }
    }`;
    const lit = await printed(text, 'W4', 'literal', 'W4::c');
    expect(lit.row).toEqual({ 'p.m': 2000 });
    expect(lit.record).toEqual({ 'p.m': 2000 });
    expect((await printed(text, 'W4', 'literal', 'W4::d')).row).toEqual({ 'p.n': 3 });
  });
});

/*
 * A body is read in its OWNER's scope by every evaluator, and SysML resolves a
 * name in the innermost namespace first: where a body declares a name itself
 * — a parameter, a local, a parameter of the definition typing it, an unnamed
 * `in :>> y` — and its owner has the same name, every surface read the
 * owner's. Such a body is read by NO surface now, in one sentence (D6), and an
 * assumption that is one is no premise a proof may stand on.
 */
describe('a body that reads a name its own element declares is read by no surface', () => {
  const CASES: Record<string, [string, string]> = {
    ownParameter: ['package P06 { attribute y = 4.0; constraint c { in y = 100.0; y <= 10.0 } }', 'y <= 10.0'],
    unbound: ['package P23 { attribute y = 4.0; constraint c { in y; y <= 10.0 } }', 'y <= 10.0'],
    local: ['package P28 { attribute y = 4.0; constraint c { attribute y = 100.0; y <= 10.0 } }', 'y <= 10.0'],
    fromDef: [
      `package P07 { constraint def Lim { in y : Real = 100.0; y <= 10.0 }
        part def P { attribute y = 4.0; constraint c : Lim { y <= 10.0 } } }`,
      'y <= 10.0',
    ],
    redefinedParameter: [
      `package XS1 { constraint def Lim { in y : Real; }
        part def P { attribute y = 4.0; constraint c : Lim { in :>> y = 100.0; y <= 10.0 } } }`,
      'y <= 10.0',
    ],
    requireClause: [
      `package P25 { part def P { attribute y = 4.0; } part p : P;
        requirement r { subject s : P = p; attribute y = 4.0; require constraint { in y = 100.0; y <= 10.0 } } }`,
      'y <= 10.0',
    ],
    featureValue: ['package P37 { attribute k = 4.0; attribute w = k * 2.0 { attribute k = 100.0; } constraint cw { w <= 10.0 } }', 'w <= 10.0'],
    assertedDefinition: [
      `package P36 { part def P { attribute x = 3.0; attribute e;
        assert constraint d { in x = 1.0; e == x * 2.0 } constraint chk { e <= 4.0 } } }`,
      'e <= 4.0',
    ],
  };

  withZ3('leaves every such body undecided on both engines, never forgiven', async () => {
    for (const [name, [text, goal]] of Object.entries(CASES)) {
      for (const engine of ['literal', 'smt'] as const) {
        const r = await verifyOne(text, { engine, allowInconclusive: true });
        const row = r.by(goal);
        expect([row.claim, row.code, r.exitCode], `${engine}: ${name}`).toEqual([
          'inconclusive',
          'verification/not-evaluable',
          2,
        ]);
      }
      const m = await contextModel(text, name);
      const check = checkConstraints(m).find((c) => c.expression === goal)!;
      expect(check.result, name).toBe('unknown');
      expect(checkConstraintsNumeric(m).find((c) => c.raw === goal)!.result, name).toBe('unknown');
    }
  });

  withZ3('leaves a body that declares names its owner lacks, and one that declares none, alone', async () => {
    const own = `package P22 { constraint c { in z = 100.0; z <= 10.0 } }`;
    const plain = `package P13 { attribute y = 4.0; calc g { y * 2.0 } constraint cg { g <= 10.0 } constraint cg2 { g >= 10.0 } }`;
    for (const engine of ['literal', 'smt'] as const) {
      expect((await verifyOne(own, { engine })).by('z <= 10.0').claim, engine).toBe('refuted');
      const r = await verifyOne(plain, { engine });
      expect([r.by('g <= 10.0').claim, r.by('g >= 10.0').claim], engine).toEqual([
        engine === 'smt' ? 'proved' : 'holds-at-values',
        'refuted',
      ]);
    }
  });

  withZ3('carries no assert that is such a body: an unrelated goal is proved', async () => {
    const text = `package Q2 { part def P { attribute y = 4.0; attribute w = 1.0;
      assert constraint a { in y = 100.0; y >= 50.0 } constraint c { w <= 2.0 } } }`;
    const r = await verifyOne(text, { engine: 'smt' });
    expect([r.by('w <= 2.0').claim, r.exitCode]).toEqual(['proved', 0]);
  });

  withZ3('claims no proof that stands without an assumption no surface reads (xp38)', async () => {
    const text = `package XP38 {
    part def P { attribute m = 30.0; attribute y = 4.0; }
    part p : P;
    requirement r {
      subject s : P = p;
      assume constraint { in y = 100.0; y <= 10.0 }
      require constraint { s.m <= 35.0 }
    } }`;
    const smt = (await verifyOne(text, { engine: 'smt' })).by('s.m <= 35.0');
    expect([smt.claim, smt.code]).toEqual(['inconclusive', 'verification/not-evaluable']);
    expect(smt.detail).toMatch(/^proof not claimed: .*the assumption `y <= 10.0`, which no surface reads/);
    const literal = (await verifyOne(text, { engine: 'literal' })).by('s.m <= 35.0');
    expect(literal.claim).toBe('inconclusive');
  });

  withZ3('reads no feature of a calculation with a parameter through a chain, nor one with an inherited body', async () => {
    const chain = `package P09 { attribute y = 4.0; calc g { in y = 100.0; return r = y; } constraint cg { g.r <= 10.0 } }`;
    const body = `package P31 { calc def Two { 2.0 }
      part def P { attribute x = 3.0; calc t : Two { x * 5.0 } constraint c { t <= 20.0 } } }`;
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyOne(chain, { engine });
      expect([r.by('g.r <= 10.0').claim, r.by('g.r <= 10.0').code, r.exitCode], engine).toEqual([
        'inconclusive',
        'verification/not-evaluable',
        2,
      ]);
      expect((await verifyOne(body, { engine })).by('t <= 20.0').claim, engine).toBe('inconclusive');
    }
  });
});

/*
 * The bare-name convenience, on every engine: a direct feature claims its
 * name valued or not, a nested one only where it is the only one below, and a
 * body's own features never stand in for a name of the scope around it.
 */
describe('a bare name is the context’s own feature, or the one feature below it of that name', () => {
  withZ3('decides nothing from another feature’s value', async () => {
    const cases: Array<[string, string]> = [
      // A nested `q.x = 7.0` answered P's valueless x: `x >= 5.0` held, `x <= 5.0` was refuted.
      [`package XR3 { part def Q { attribute x = 7.0; }
        part def P { attribute x : Real; part q : Q; constraint lo { x >= 5.0 } constraint hi { x <= 5.0 } } part p : P; }`, 'x <= 5.0'],
      // Of `a.y` and `b.y`, whichever the walk met first: proved at 4.
      [`package XB1 { part def P { attribute y = 4.0; } part def Q { attribute y = 100.0; }
        part def Sys { part a : P; part b : Q; constraint c { y <= 10.0 } } part sys : Sys; }`, 'y <= 10.0'],
      // A sibling constraint's `in x = 1.0` answered P's valueless x.
      [`package XR1 { part def P { attribute x : Real; constraint c { in x = 1.0; x >= 0.0 } constraint lo { x >= 5.0 } } part p : P; }`, 'x >= 5.0'],
    ];
    for (const [text, goal] of cases) {
      for (const engine of ['literal', 'smt'] as const) {
        const r = await verifyOne(text, { engine });
        expect([r.by(goal).claim, r.exitCode], `${engine}: ${goal}`).toEqual(['inconclusive', 2]);
      }
    }
  });

  withZ3('reads a requirement’s own feature before its subject’s (p33)', async () => {
    const text = `package P33 { part def P { attribute y = 4.0; } part p : P;
      requirement r { subject s : P = p; attribute y = 100.0; require constraint { y <= 10.0 } } }`;
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyOne(text, { engine });
      expect([r.by('y <= 10.0').claim, r.exitCode], engine).toEqual(['refuted', 1]);
    }
  });
});

/*
 * What the first reading of strict redefinition still got wrong, each on the
 * model that showed it. A fact one instance states is carried only over
 * symbols of its own; a value is read only where everything it reads — every
 * name WHOLE, `e.load` and a nested `load` alike — is what it is where the
 * value is written; two values are compared as values, never as spelled; a
 * behaviour's features are never a bare name of the part around it; a
 * requirement is read where its subject is bound; and the numeric surface
 * reads every context the check reads.
 */
describe('a fact is carried over its own symbols, and a value read only where it is the same', () => {
  const I4 = `package I4 {
    part def P { attribute a : ScalarValues::Real default = 2.0; attribute x : ScalarValues::Real; assert constraint ax { x >= a } }
    part p : P { attribute :>> a = 5.0; }
    part q : P { attribute :>> a = 100.0; }
    constraint pF { p.x >= 99.0 } }`;

  withZ3('carries each instance’s facts over its own symbols, and the definition’s over its own (i4, i5, i6)', async () => {
    // q's `x >= 100` was asserted over P's `x`, every P's: `p.x >= 99.0` PROVED
    // for a p whose `a` is 5. Each instance's x is its own symbol now, and the
    // assert is carried for each, over it.
    const r4 = await verifyOne(I4, { engine: 'smt' });
    expect([r4.by('p.x >= 99.0').claim, r4.exitCode]).toEqual(['inconclusive', 2]);
    const m4 = await contextModel(I4, 'I4');
    const rows = obligationsOf(m4);
    for (const [name, x] of [
      ['I4::P::ax', 'I4::P::x'],
      ['I4::P::ax in I4::p', 'I4::p::x'],
      ['I4::P::ax in I4::q', 'I4::q::x'],
    ]) {
      const row = rows.find((o) => o.element.qualifiedName === name)!;
      expect([row.role, row.encodable], name).toEqual(['axiom', true]);
      expect(row.vars.map((v) => v.qualifiedName), name).toContain(x);
    }
    // One instance alone: `b.inner` changes nothing, and still read q's fact; bounds said `min = 100 exactly`.
    const I5 = `package I5 {
      part def P { attribute a : ScalarValues::Real default = 2.0; attribute x : ScalarValues::Real; assert constraint ax { x >= a } }
      part q : P { attribute :>> a = 100.0; }
      part def Box { part inner : P; }
      part b : Box;
      constraint bF { b.inner.x >= 99.0 } }`;
    expect((await verifyOne(I5, { engine: 'smt' })).by('b.inner.x >= 99.0').claim).toBe('inconclusive');
    // P's own x is bounded by P's own assert at P's own a; q's fact is q's.
    const bounds = await boundsReport(await contextModel(I5, 'I5'), { measure: 'I5::P::x', sense: 'min', sourceText: I5 });
    expect([bounds.bounds.map((b) => [b.outcome, b.value]), bounds.exitCode]).toEqual([[['optimum', 2]], 0]);
    // Two instances each consistent on its own made the axioms inconsistent.
    const I6 = `package I6 {
      part def P {
        attribute a : ScalarValues::Real default = 2.0; attribute b : ScalarValues::Real default = 50.0;
        attribute x : ScalarValues::Real;
        assert constraint lo { x >= a } assert constraint hi { x <= b } }
      part p : P { attribute :>> a = 100.0; attribute :>> b = 200.0; }
      part q : P { attribute :>> a = 0.0; attribute :>> b = 10.0; }
      constraint other { p.a >= 1.0 } }`;
    const r6 = await verifyOne(I6, { engine: 'smt' });
    expect([r6.by('p.a >= 1.0').claim, r6.exitCode]).toEqual(['proved', 0]);
  });

  withZ3('reads a derived value whose input a context changes through a chain, a nested name or an outer value there (h1–h6)', async () => {
    const E = 'part def E { attribute load : ScalarValues::Real default = 1.0; }';
    const P = (body: string) => `part def P { part e : E; ${body} }`;
    const REDEF = 'part p : P { part :>> e { attribute :>> load = 50.0; } }';
    const cases: Array<[string, string, string]> = [
      ['H1', `${E} ${P('attribute m2 : ScalarValues::Real = 10.0 - e.load;')} ${REDEF}`, 'p.m2'],
      ['H2', `${E} ${P('attribute m2 : ScalarValues::Real = 10.0 - load;')} ${REDEF}`, 'p.m2'],
      ['H5', `${E} ${P('attribute m2 : ScalarValues::Real; assert constraint d { m2 == 10.0 - e.load }')} ${REDEF}`, 'p.m2'],
      ['H6', `${E} ${P('calc margin { 10.0 - e.load }')} ${REDEF}`, 'p.margin'],
      [
        'H3',
        `part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
         part def Q { part p : P; attribute t : ScalarValues::Real = p.m2 * 2.0; }
         part q : Q { part :>> p { attribute :>> load = 50.0; } }`,
        'q.t',
      ],
    ];
    for (const [pkg, body, value] of cases) {
      // The truth is −40 (−80 for q.t): `>= 0.0` was PROVED and `<= 0.0` refuted at 9 (18).
      const text = `package ${pkg} { ${body} constraint pos { ${value} >= 0.0 } constraint neg { ${value} <= 0.0 } }`;
      for (const engine of ['literal', 'smt'] as const) {
        const r = await verifyOne(text, { engine });
        expect(r.by(`${value} >= 0.0`).claim, `${pkg} ${engine}`).toBe('refuted');
        expect(r.by(`${value} <= 0.0`).claim, `${pkg} ${engine}`).toBe(engine === 'smt' ? 'proved' : 'holds-at-values');
        expect(r.exitCode, `${pkg} ${engine}`).toBe(1);
      }
    }
    // P's own constraint over such a value is read in p too — violated there, beside P's verdict.
    const H4 = `package H4 { ${E} ${P('attribute m2 : ScalarValues::Real = 10.0 - e.load; constraint cM2 { m2 >= 0.0 }')} ${REDEF} }`;
    const r4 = await verifyByClause(H4, { engine: 'smt' });
    expect(r4.by('H4::P::cM2').claim).toBe('proved');
    expect(r4.by('H4::P::cM2 in H4::p').claim).toBe('refuted');
  });

  withZ3('compares a redefinition with the binding it restates as a value — units, spacing, arithmetic', async () => {
    const restated: Array<[string, string, string]> = [
      ['A1', 'attribute mass : ISQ::MassValue = 1.0 [SI::kg];', 'attribute :>> mass = 1000.0 [SI::g];'],
      ['A5', 'attribute mass : ISQ::MassValue = 1.0 [SI::kg];', 'attribute :>> mass = 1.0 [kg];'],
      ['RV6', 'attribute mass : ISQ::MassValue = 1.0 [t];', 'attribute :>> mass = 1000.0 [kg];'],
      ['A2', 'attribute mass : ScalarValues::Real = 1.0;', 'attribute :>> mass = 2.0 * 0.5;'],
      ['A4', 'attribute k : ScalarValues::Real default = 1.0; attribute mass : ScalarValues::Real = 10.0 - k;', 'attribute :>> mass = 10.0-k;'],
    ];
    for (const [pkg, def, redef] of restated) {
      const text = `package ${pkg} { part def P { ${def} } part p : P { ${redef} } constraint mT { p.mass <= 2000.0 } }`;
      const m = await contextModel(text, pkg);
      expect(checkConstraints(m).filter((c) => c.conflict !== undefined), pkg).toEqual([]);
      for (const engine of ['literal', 'smt'] as const) {
        const r = await verifyOne(text, { engine });
        expect([r.by('p.mass <= 2000.0').claim, r.exitCode], `${pkg} ${engine}`).toEqual([
          engine === 'smt' ? 'proved' : 'holds-at-values',
          0,
        ]);
      }
    }
    // Two literals that differ in SI are a contradiction whatever their units: the binding's unit is carried.
    for (const [pkg, def, redef] of [
      ['U1', '1.0 [SI::kg]', '1.0 [SI::g]'],
      ['RV7', '1.0 [g]', '1.0 [kg]'],
    ]) {
      const text = `package ${pkg} {
        part def P { attribute mass : ISQ::MassValue = ${def}; attribute k : ScalarValues::Real = 1.0; }
        part p : P { attribute :>> mass = ${redef}; }
        constraint kT { p.k >= 0.0 } }`;
      const m = await contextModel(text, pkg);
      expect(checkConstraints(m).filter((c) => c.conflict === 'binding').map((c) => c.result), pkg).toEqual(['violated']);
      const row = (await verifyOne(text, { engine: 'smt' })).by('p.k >= 0.0');
      expect([row.claim, row.code], pkg).toEqual(['inconclusive', 'verification/inconsistent-axioms']);
    }
    // A pair only an evaluation compares is undecided on the check — never `violated` — and the solver lane decides.
    const RV2B = `package RV2B {
      part def P { attribute a : ScalarValues::Real = 2.0; attribute load : ScalarValues::Real = a * 2.0; attribute k : ScalarValues::Real = 1.0; }
      part p : P { attribute :>> load = 4.0; }
      constraint kT { p.k >= 0.0 } }`;
    const m2b = await contextModel(RV2B, 'RV2B');
    expect(checkConstraints(m2b).filter((c) => c.conflict === 'binding').map((c) => c.result)).toEqual(['unknown']);
    expect((await verifyOne(RV2B, { engine: 'smt' })).by('p.k >= 0.0').claim).toBe('proved');
  });

  withZ3('overrides a binding hidden by name, and reads no value two general types bind differently (b1, o3)', async () => {
    const B1 = `package B1 {
      part def P { attribute load : ScalarValues::Real = 1.0; }
      part p : P { attribute load : ScalarValues::Real = 50.0; }
      constraint lF { p.load <= 10.0 } }`;
    const mb = await contextModel(B1, 'B1');
    expect(checkConstraints(mb).filter((c) => c.conflict === 'binding').map((c) => c.result)).toEqual(['violated']);
    for (const engine of ['literal', 'smt'] as const) {
      expect((await verifyOne(B1, { engine })).by('p.load <= 10.0').claim, engine).toBe('inconclusive');
    }
    const O3 = `package O3 {
      part def P { attribute load : ScalarValues::Real default = 1.0; }
      part def A :> P { attribute :>> load = 5.0; }
      part def B :> P { attribute :>> load = 7.0; }
      part def C :> A, B;
      part c : C;
      constraint cF { c.load <= 6.0 }
      constraint cF2 { c.load >= 6.0 } }`;
    const mo = await contextModel(O3, 'O3');
    const clash = checkConstraints(mo).filter((c) => c.conflict === 'clash');
    expect([clash.map((c) => c.result), clash.map((c) => mo.qualifiedName(c.ownerId!))]).toEqual([['violated'], ['O3::C']]);
    // Reported at C, the line that joins the two; a restatement in other units warns of nothing.
    const warned = validate(mo).filter((d) => d.ruleId === 'constraint-violation' && d.severity === 'warning');
    expect(warned.map((d) => mo.qualifiedName(d.elementId!))).toEqual(['O3::C']);
    const A1 = `package A1 { part def P { attribute mass : ISQ::MassValue = 1.0 [kg]; } part p : P { attribute :>> mass = 1000.0 [g]; } }`;
    expect(validate(await contextModel(A1, 'A1')).filter((d) => d.ruleId === 'constraint-violation')).toEqual([]);
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyOne(O3, { engine });
      expect([r.by('c.load <= 6.0').claim, r.by('c.load >= 6.0').claim, r.exitCode], engine).toEqual([
        'inconclusive',
        'inconclusive',
        2,
      ]);
    }
    expect(obligationsOf(mo).find((o) => o.element.qualifiedName === 'O3::B::load in O3::C')?.expression).toBe(
      'load == 7.0',
    );
  });

  withZ3('never reads a behaviour’s feature, nor a parameter, as a bare name of the part around it (s2–s5)', async () => {
    const cases: Array<[string, string]> = [
      ['package S2 { part def P { action fly { in speed : ScalarValues::Real = 10.0; } constraint c { speed <= 5.0 } } }', 'speed <= 5.0'],
      [
        `package S3 { action def Deliver { in payload : ScalarValues::Real; }
          part def Drone { attribute maxPayload : ScalarValues::Real = 3.0;
            perform action deliver : Deliver { in payload = 5.0; } constraint c { payload <= maxPayload } } }`,
        'payload <= maxPayload',
      ],
      ['package S4 { part def P { port pwr { in attribute voltage : ScalarValues::Real = 12.0; } constraint c { voltage <= 5.0 } } }', 'voltage <= 5.0'],
      [
        `package S5 { part def P { state modes { entry; then idle; state idle { attribute rate : ScalarValues::Real = 9.0; } }
          constraint c { rate <= 5.0 } } }`,
        'rate <= 5.0',
      ],
    ];
    for (const [text, goal] of cases) {
      for (const engine of ['literal', 'smt'] as const) {
        const r = await verifyOne(text, { engine });
        expect([r.by(goal).claim, r.exitCode], `${engine}: ${goal}`).toEqual(['inconclusive', 2]);
      }
    }
  });

  withZ3('reads a requirement where its subject is bound — `satisfy R by p`, `subject s = p` (S1, r08)', async () => {
    const P = `part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
      part p : P { attribute :>> load = 50.0; }`;
    // R's clause at P's values was PROVED while p, its satisfier, has m2 −40 and load 50.
    const R21 = `package R21 { ${P}
      requirement def R { subject s : P; require constraint { s.m2 >= 0.0 } }
      satisfy R by p; }`;
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyByClause(R21, { engine });
      expect(r.by('R21::R::«ConstraintUsage» in R21::p').claim, engine).toBe('refuted');
      expect(r.exitCode, engine).toBe(1);
    }
    const c21 = await consistencyReport(await contextModel(R21, 'R21'), { withValues: true, sourceText: R21 });
    expect([c21.consistent, c21.inconsistent, c21.exitCode]).toEqual([0, 1, 1]);
    const I3 = `package I3 { ${P}
      requirement def R { subject s : P; require constraint { s.load <= 10.0 } }
      requirement r : R { subject s = p; }
      satisfy R by p; }`;
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyByClause(I3, { engine });
      expect([r.by('I3::R::«ConstraintUsage» in I3::r').claim, r.exitCode], engine).toEqual(['refuted', 1]);
    }
    // A subject bound by value IS the feature: `s.m2` is p's, read in the requirement itself.
    const RV8 = `package RV8 { ${P}
      requirement r { subject s : P = p; require constraint { s.m2 >= 0.0 } } }`;
    for (const engine of ['literal', 'smt'] as const) {
      const r = await verifyOne(RV8, { engine });
      expect([r.by('s.m2 >= 0.0').claim, r.exitCode], engine).toEqual(['refuted', 1]);
    }
    const c8 = await consistencyReport(await contextModel(RV8, 'RV8'), { withValues: true, sourceText: RV8 });
    expect([c8.consistent, c8.inconsistent, c8.exitCode]).toEqual([0, 1, 1]);
    // A component contract read at the part that satisfies it, γ through the same feature: refined.
    const R08 = `package R08 {
      part def Cell { attribute x : ScalarValues::Real = 1.0; }
      part def Pack { part cell : Cell; attribute cap : ScalarValues::Real = 1.0; bind cap = cell.x; }
      requirement def Top { subject sys : Pack; require constraint { sys.cap <= 2.0 } }
      requirement def CellReq { subject c : Cell; require constraint { c.x <= 1.0 } }
      satisfy Top by Pack;
      satisfy CellReq by Pack::cell; }`;
    const refined = await refinementReport(await contextModel(R08, 'R08'), { sourceText: R08 });
    expect([refined.refined, refined.notRefined, refined.inconclusive, refined.exitCode]).toEqual([1, 0, 0, 0]);
  });

  withZ3('reads a definition’s relations in every context, and a value stated twice, on the numeric surface too', async () => {
    const R19 = `package R19 {
      part def P { attribute load : ScalarValues::Real default = 1.0; constraint cLoad { load <= 10.0 } }
      part p : P { attribute :>> load = 50.0; } }`;
    const m19 = await contextModel(R19, 'R19');
    const p19 = m19.all().find((e) => e.declaredName === 'p')!.id;
    const row = checkConstraintsNumeric(m19).find((r) => r.context?.contextId === p19)!;
    expect([row.raw, row.kind, row.result]).toEqual(['load <= 10.0', 'inequality', 'violated']);
    const feasible = solveFeasible(m19);
    expect([feasible.feasible, feasible.violations.map((v) => v.id)]).toEqual([false, [row.id]]);
    const R24 = `package R24 {
      part def P { attribute load : ScalarValues::Real default = 1.0; assert constraint lim { load <= 10.0 } }
      part p : P { attribute :>> load = 50.0; } }`;
    const a24 = analysisReport(await contextModel(R24, 'R24'));
    expect([a24.feasible, a24.violations.map((v) => v.element.qualifiedName)]).toEqual([false, ['R24::P::lim in R24::p']]);
    // A value stated twice is a violation there, and neither value is a solved one.
    const R1 = `package R1 {
      part def P { attribute load : ScalarValues::Real = 1.0; }
      part p : P { attribute :>> load = 50.0; } }`;
    const m1 = await contextModel(R1, 'R1');
    const redef = m1.all().find((e) => e.attrs.value === 50)!.id;
    const conflict = checkConstraintsNumeric(m1).find((r) => r.conflict === 'binding')!;
    expect([conflict.id, conflict.result]).toEqual([redef, 'violated']);
    const a1 = analysisReport(m1);
    expect([a1.feasible, a1.values.some((v) => v.element.id === redef)]).toEqual([false, false]);
    expect(solveFeasible(m1).feasible).toBe(false);
  });
});

/*
 * KerML gives every instance its own values (the soundness pass, D1 Stage 2).
 * A value expression of P read in a usage p is p's own — evaluated over p's
 * names — and a feature read through two instances is two values: the
 * verification lane reads each by a symbol of its own (`R::g1::g`), and files
 * for each the relations its types hold of every instance. One symbol per
 * feature made `g1.g == g2.g` PROVED of two values nothing relates, two
 * instances each consistent on its own "inconsistent" together, and `max sys.d
 * = 0 exactly` of `a.v - b.v`.
 */
describe('one symbol per instance, and every instance holds what its types hold', () => {
  withZ3('proves no equality of two instances’ values nothing relates (r10, x22, x23, xa3)', async () => {
    const cases: Array<[string, string, string, string[]]> = [
      [
        'R10',
        'part def G { attribute g : ScalarValues::Real; } part g1 : G; part g2 : G; constraint c { g1.g == g2.g }',
        'g1.g == g2.g',
        ['R10::g1::g', 'R10::g2::g'],
      ],
      [
        'X22',
        `port def PP { attribute voltage : ScalarValues::Real; }
         part def U { port powerIn : PP; port powerOut : PP; } part u : U;
         constraint c { u.powerIn.voltage == u.powerOut.voltage }`,
        'u.powerIn.voltage == u.powerOut.voltage',
        ['X22::u::powerIn::voltage', 'X22::u::powerOut::voltage'],
      ],
      [
        'X23',
        'part def Cell { attribute v : ScalarValues::Real; } part a : Cell; part b : Cell; constraint c { a.v + 1.0 <= b.v + 1.0 }',
        'a.v + 1.0 <= b.v + 1.0',
        ['X23::a::v', 'X23::b::v'],
      ],
      [
        'XA3',
        `part def P { attribute load : ScalarValues::Real; attribute m2 : ScalarValues::Real = 10.0 - load; }
         part p1 : P; part p2 : P; constraint c { p1.m2 == p2.m2 }`,
        'p1.m2 == p2.m2',
        ['XA3::p1::m2', 'XA3::p2::m2'],
      ],
    ];
    for (const [pkg, body, goal, symbols] of cases) {
      const text = `package ${pkg} { ${body} }`;
      const r = await verifyOne(text, { engine: 'smt' });
      expect([r.by(goal).claim, r.exitCode], pkg).toEqual(['inconclusive', 2]);
      const m = await contextModel(text, pkg);
      const rows = obligationsOf(m);
      expect(rows.find((o) => o.expression === goal)!.vars.map((v) => v.qualifiedName), pkg).toEqual(symbols);
    }
    // Each instance's value is its own, read over its own load.
    const m = await contextModel('package XA3 { part def P { attribute load : ScalarValues::Real; attribute m2 : ScalarValues::Real = 10.0 - load; } part p1 : P; part p2 : P; constraint c { p1.m2 == p2.m2 } }', 'XA3');
    const value = obligationsOf(m).find((o) => o.element.qualifiedName === 'XA3::P::m2 in XA3::p1')!;
    expect([value.role, value.expression, value.vars.map((v) => v.qualifiedName)]).toEqual([
      'axiom',
      'm2 == 10.0 - load',
      ['XA3::p1::m2', 'XA3::p1::load'],
    ]);
  });

  withZ3('calls two instances each consistent on its own consistent, and bounds no aliased difference (xa1, xa2)', async () => {
    const XA1 = `package XA1 {
    part def Cell { attribute v : ScalarValues::Real; }
    part def Sys { part a : Cell; part b : Cell; }
    part sys : Sys;
    requirement def R { subject s : Sys;
      require constraint { s.a.v >= 5.0 }
      require constraint { s.b.v <= 3.0 } }
    satisfy R by sys; }`;
    for (const withValues of [false, true]) {
      const c = await consistencyReport(await contextModel(XA1, 'XA1'), { withValues, sourceText: XA1 });
      expect([c.consistent, c.inconsistent, c.exitCode], `withValues ${withValues}`).toEqual([1, 0, 0]);
    }
    const XA2 = `package XA2 {
    part def Cell { attribute v : ScalarValues::Real; }
    part def Sys { part a : Cell; part b : Cell; attribute d : ScalarValues::Real = a.v - b.v; }
    part sys : Sys;
    constraint c { sys.d <= 0.0 } }`;
    expect((await verifyOne(XA2, { engine: 'smt' })).by('sys.d <= 0.0').claim).toBe('inconclusive');
    const b = await boundsReport(await contextModel(XA2, 'XA2'), { measure: 'sys.d', sense: 'max', sourceText: XA2 });
    expect([b.measure?.qualifiedName, b.bounds.map((x) => x.outcome), b.exitCode]).toEqual([
      'XA2::sys::d',
      ['unbounded'],
      0,
    ]);
  });

  withZ3('reads one instance through two paths of usages as two (q1.p, q2.p), and holds each to its type’s asserts', async () => {
    const text = (fact: string) => `package NI {
    part def P { attribute x : ScalarValues::Real; assert constraint lim { x <= 5.0 } }
    part def Q { part p : P; }
    part q1 : Q;
    part q2 : Q;
    assert constraint fact { ${fact} }
    constraint same { q1.p.x == q2.p.x }
    constraint capped { q1.p.x <= 5.0 } }`;
    const r = await verifyOne(text('q1.p.x >= 1.0'), { engine: 'smt' });
    // Q's p is read in q1 and in q2: two instances, and P's assert holds of each.
    expect([r.by('q1.p.x == q2.p.x').claim, r.by('q1.p.x <= 5.0').claim]).toEqual(['inconclusive', 'proved']);
    const m = await contextModel(text('q1.p.x >= 1.0'), 'NI');
    const lim = obligationsOf(m).filter((o) => o.instance?.path !== undefined && o.instance.baseId === m.all().find((e) => e.declaredName === 'lim')!.id);
    expect(lim.map((o) => [o.element.qualifiedName, o.vars.map((v) => v.qualifiedName)])).toEqual([
      ['NI::P::lim in NI::q1::p', ['NI::q1::p::x']],
      ['NI::P::lim in NI::q2::p', ['NI::q2::p::x']],
    ]);
    // An instance's fact against its type's assert is a contradiction of the model.
    const broken = (await verifyOne(text('q1.p.x >= 10.0'), { engine: 'smt' })).by('q1.p.x <= 5.0');
    expect([broken.claim, broken.code]).toEqual(['inconclusive', 'verification/inconsistent-axioms']);
    expect(broken.detail).toContain('NI::P::lim in NI::q1::p');
    // A binding its type states holds of each instance too.
    const TB = `package TB {
    part def T { attribute x : ScalarValues::Real; attribute e : ScalarValues::Real = 5.0; bind x = e; }
    part t1 : T;
    assert constraint six { t1.x == 6.0 }
    constraint k { t1.e >= 0.0 } }`;
    const tb = (await verifyOne(TB, { engine: 'smt' })).by('t1.e >= 0.0');
    expect([tb.claim, tb.code]).toEqual(['inconclusive', 'verification/inconsistent-axioms']);
  });

  withZ3('holds every instance to what the instances ENCLOSING it state (c7, a3, k12, k13, k14)', async () => {
    // Sys's binding is a fact of `s.q.load`: P's asserts alone left it free in [0, 10].
    const C7 = `package C7 {
    part def P { attribute load : ScalarValues::Real; assert constraint lim { load <= 10.0 } assert constraint lo { load >= 0.0 } }
    part def Sys { part p : P; part q : P; bind p.load = q.load; }
    part s : Sys;
    assert constraint pFix { s.p.load == 5.0 }
    constraint qT { s.q.load <= 5.0 } }`;
    const c7 = await boundsReport(await contextModel(C7, 'C7'), { measure: 's.q.load', sense: 'both', sourceText: C7 });
    expect([c7.measure?.qualifiedName, c7.bounds.map((x) => [x.outcome, x.value]), c7.exitCode]).toEqual([
      'C7::s::q::load',
      [
        ['optimum', 5],
        ['optimum', 5],
      ],
      0,
    ]);
    expect((await verifyOne(C7, { engine: 'smt' })).by('s.q.load <= 5.0').claim).toBe('proved');
    // P's assert is a fact of `p.sub.x`.
    const A3 = `package A3 {
    part def Sub { attribute x : ScalarValues::Real; }
    part def P { part sub : Sub; assert constraint lim { sub.x <= 10.0 } }
    part p : P;
    constraint le { p.sub.x <= 10.0 }
    constraint gtF { p.sub.x >= 20.0 } }`;
    const a3 = await verifyOne(A3, { engine: 'smt' });
    expect([a3.by('p.sub.x <= 10.0').claim, a3.by('p.sub.x >= 20.0').claim]).toEqual(['proved', 'inconclusive']);
    // An assert and a binding of Q bound `q1.p.x`, which they left unbounded.
    const K12 = `package K12 {
    part def P { attribute x : ScalarValues::Real; }
    part def Q { part p : P; assert constraint qa { p.x <= 10.0 } }
    part q1 : Q;
    assert constraint lo { q1.p.x >= 0.0 } }`;
    const k12 = await boundsReport(await contextModel(K12, 'K12'), { measure: 'q1.p.x', sense: 'max', sourceText: K12 });
    expect([k12.bounds.map((x) => [x.outcome, x.value]), k12.exitCode]).toEqual([[['optimum', 10]], 0]);
    expect(obligationsOf(await contextModel(K12, 'K12')).map((o) => o.element.qualifiedName)).toContain(
      'K12::Q::qa in K12::q1',
    );
    const K13 = `package K13 {
    part def P { attribute x : ScalarValues::Real; }
    part def Q { part p : P; attribute y : ScalarValues::Real; bind p.x = y; assert constraint yc { y <= 5.0 } }
    part q1 : Q;
    constraint g { q1.p.x <= 5.0 } }`;
    expect((await verifyOne(K13, { engine: 'smt' })).by('q1.p.x <= 5.0').claim).toBe('proved');
    // A requirement on any Top reads Q's assert at Top's q: it cannot hold.
    const K14 = `package K14 {
    part def P { attribute x : ScalarValues::Real; }
    part def Q { part p : P; assert constraint qa { p.x >= 1.0 } }
    part def Top { part q : Q; }
    part t : Top;
    requirement def RT { subject s : Top; require constraint { s.q.p.x <= 0.0 } }
    satisfy RT by t; }`;
    const k14 = await consistencyReport(await contextModel(K14, 'K14'), { sourceText: K14 });
    expect([k14.inconsistent, k14.exitCode]).toEqual([1, 1]);
  });

  withZ3('reads a subject as the generic instance of its type only where its requirement is the root (g5, g6, g7, j1)', async () => {
    const cases: Array<[string, string, string]> = [
      // Two usages of one requirement are two subjects.
      [
        'G5',
        `part def P { attribute load : ScalarValues::Real; }
         requirement def R { subject s : P; }
         requirement r1 : R; requirement r2 : R;
         assert constraint a { r1.s.load >= 5.0 }
         constraint c { r2.s.load >= 5.0 }`,
        'r2.s.load >= 5.0',
      ],
      // A nested requirement's subject is not the requirement's own.
      [
        'G6',
        `part def P { attribute load : ScalarValues::Real; }
         requirement def R2 { subject t : P; }
         requirement def R { subject s : P; requirement r2 : R2;
           assume constraint a { s.load >= 5.0 }
           require constraint c { r2.t.load >= 5.0 } }`,
        'r2.t.load >= 5.0',
      ],
      // Neither a part's requirement's subject, nor the generic one, is another part's.
      [
        'G7',
        `part def P { attribute load : ScalarValues::Real; }
         requirement def R { subject s : P; require constraint c { s.load >= 5.0 } }
         part def Sys { part a : P; part b : P; requirement ra : R; requirement rb : R; }
         part sys : Sys;
         assert constraint x { sys.ra.s.load >= 5.0 }
         constraint y { sys.rb.s.load >= 5.0 }`,
        'sys.rb.s.load >= 5.0',
      ],
      // A subject's own assert is a fact of that subject, not of every P.
      [
        'J1',
        `part def B { attribute load : ScalarValues::Real; }
         part def P :> B;
         requirement def R { subject s : P { assert constraint sa { load <= 3.0 } } require constraint r { s.load <= 3.0 } }
         requirement def R2 { subject t : P; require constraint c { t.load <= 3.0 } }`,
        't.load <= 3.0',
      ],
    ];
    for (const [pkg, body, goal] of cases) {
      const r = await verifyOne(`package ${pkg} { ${body} }`, { engine: 'smt' });
      expect(r.by(goal).claim, pkg).toBe('inconclusive');
    }
    // G7's requirement on any P is no consequence of an assert on one P, and
    // J1's R reads its subject's own assert.
    expect((await verifyOne(`package G7 { ${cases[2]![1]} }`, { engine: 'smt' })).by('s.load >= 5.0').claim).toBe(
      'inconclusive',
    );
    expect((await verifyOne(`package J1 { ${cases[3]![1]} }`, { engine: 'smt' })).by('s.load <= 3.0').claim).toBe(
      'proved',
    );
  });

  withZ3('reads a requirement at each context of its own (k2), and at a satisfier that holds more than its subject (s1, k11)', async () => {
    // A constraint's own `k` is each satisfier's: one symbol for both made two
    // satisfiers, each consistent alone, "inconsistent" together.
    const K2 = `package K2 {
    part def P { attribute load : ScalarValues::Real default = 1.0; }
    requirement def R {
      subject s : P;
      require constraint lim { attribute k : ScalarValues::Real; k == s.load * 2.0 and k <= 200.0 } }
    part p1 : P { attribute :>> load = 50.0; }
    part p2 : P { attribute :>> load = 3.0; }
    satisfy R by p1;
    satisfy R by p2; }`;
    const k2 = await consistencyReport(await contextModel(K2, 'K2'), { withValues: true, sourceText: K2 });
    expect([k2.consistent, k2.inconsistent, k2.exitCode]).toEqual([1, 0, 0]);
    const vars = obligationsOf(await contextModel(K2, 'K2'))
      .filter((o) => o.element.qualifiedName.startsWith('K2::R::lim'))
      .map((o) => o.vars[0]!.qualifiedName);
    expect(vars).toEqual(['K2::R::lim::k', 'K2::p1::«satisfy R»::lim::k', 'K2::p2::«satisfy R»::lim::k']);
    // R at a satisfier whose own assert, or whose enclosing Q's assert, it
    // cannot meet: read only at the generic P, the set was "consistent".
    const satisfied = (pkg: string, model: string, by: string) => `package ${pkg} {
    part def P { attribute x : ScalarValues::Real; }
    ${model}
    requirement def R { subject s : P; require constraint c { s.x <= 0.0 } }
    satisfy R by ${by}; }`;
    for (const [pkg, text] of [
      ['S1', satisfied('S1', 'part p1 : P { assert constraint a { x >= 1.0 } }', 'p1')],
      ['K11', satisfied('K11', 'part def Q { part p : P; assert constraint qa { p.x >= 1.0 } } part q1 : Q;', 'q1.p')],
    ] as const) {
      const c = await consistencyReport(await contextModel(text, pkg), { sourceText: text });
      expect([c.inconsistent, c.exitCode], pkg).toEqual([1, 1]);
    }
    const k11 = obligationsOf(
      await contextModel(satisfied('K11', 'part def Q { part p : P; assert constraint qa { p.x >= 1.0 } } part q1 : Q;', 'q1.p'), 'K11'),
    );
    expect(k11.filter((o) => o.instance).map((o) => [o.element.qualifiedName, o.vars[0]!.qualifiedName])).toEqual([
      ['K11::R::c in K11::q1::p', 'K11::q1::p::x'],
      ['K11::Q::qa in K11::q1', 'K11::q1::p::x'],
    ]);
    // A satisfier that holds exactly what R's subject holds reads R as the
    // subject does: no row of its own.
    const plain = satisfied('S0', 'part p1 : P;', 'p1');
    expect(obligationsOf(await contextModel(plain, 'S0')).filter((o) => o.instance)).toEqual([]);
  });

  withZ3('holds a definition’s binding in a context that reads its ends otherwise (h2f)', async () => {
    // Q binds p.load to L; in q, L is 50 and P binds load to 1.0 — the model
    // contradicts itself there, as the assert form already said.
    const text = (link: string) => `package H2F {
    part def P { attribute load : ScalarValues::Real = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; ${link} }
    part q : Q { attribute :>> L = 50.0; }
    constraint m2PosF { q.p.m2 >= 0.0 } }`;
    for (const link of ['bind p.load = L;', 'assert constraint tie { p.load == L }']) {
      const r = await verifyOne(text(link), { engine: 'smt' });
      const row = r.by('q.p.m2 >= 0.0');
      expect([row.claim, row.code, r.exitCode], link).toEqual(['inconclusive', 'verification/inconsistent-axioms', 2]);
      expect(row.detail, link).toMatch(/in H2F::q/);
    }
  });

  withZ3('releases an instance’s own value by its symbol or by its path, and no other instance’s', async () => {
    const text = `package FR {
    part def G { attribute g : ScalarValues::Real = 1.0; attribute h : ScalarValues::Real; }
    part g1 : G;
    part g2 : G;
    constraint c { g1.h <= g2.h } }`;
    const m = await contextModel(text, 'FR');
    const rows = obligationsOf(m);
    for (const spelling of ['FR::g1::h', 'g1.h']) {
      const freed = resolveFreeFeatures(m, [spelling], rows);
      expect([freed.unresolved, freed.unread, [...freed.qualifiedNames]], spelling).toEqual([[], [], ['FR::g1::h']]);
    }
    // A literal is the one value in every instance: read, and released, by the feature's own symbol.
    expect([...resolveFreeFeatures(m, ['g1.g'], rows).qualifiedNames]).toEqual(['FR::G::g']);
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

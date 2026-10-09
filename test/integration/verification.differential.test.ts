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
import { checkConstraints, checksByRow, type ConstraintCheck } from '@semantics/evaluate-model';
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

  // A value a solve produced, or a binding carried, is known to the solve's
  // tolerance and no closer: a strict ordering or a `!=` inside it turns on a
  // difference the solve does not know. Read as a tie there, `p.x < 0.1000005`
  // at a solved 0.1 was violated and infeasible beside an SMT proof.
  const SOLVED = 'attribute x : ScalarValues::Real; assert constraint { x * 3.0 == 0.3 }';
  const SOLVED_SMALL = 'attribute x : ScalarValues::Real; assert constraint { x * 10000000.0 == 1.0 }';
  const CARRIED =
    'attribute a : ScalarValues::Real = 0.1; attribute b : ScalarValues::Real; ' +
    'attribute c : ScalarValues::Real = b + 0.2; bind b = a;';
  const UNDECIDED: Array<[string, string]> = [
    [SOLVED, 'p.x < 0.1000005'],
    [SOLVED, 'p.x != 0.1000005'],
    [SOLVED_SMALL, 'p.x < 0.0000005'],
    [CARRIED, 'p.c > 0.29999999'],
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
        'inconclusive',
        'verification/not-evaluable',
      ]);
      // The check and the literal engine read a value a binding gives as they
      // read any feature a binding holds: not the default, and here no value.
      const literal = await verifyOne(text, { engine: 'literal' });
      for (const goal of [`${m2} <= ${bound}`, `${m2} >= ${bound}`]) {
        expect(literal.by(goal).claim, `${name}: ${goal}`).toBe('inconclusive');
      }
      const m = await contextModel(text, name);
      expect(checkConstraints(m).map((c) => c.result), name).toEqual(['unknown', 'unknown']);
      expect(checkConstraintsNumeric(m).map((r) => [r.name, r.result]), name).toEqual([
        ['m2NegT', 'satisfied'],
        ['m2PosF', 'violated'],
      ]);
      const f = solveFeasible(m);
      expect([f.violations.map((v) => v.name), f.decided], name).toEqual([['m2PosF'], true]);
    }
    // A definition's constraint over a value read through its binding is
    // read anew in a context that joins the binding to another value: Q's `c`
    // was proved at Q's L of 1, and q — whose L of 50 makes p's m2 −40 —
    // was no context of it, on any surface.
    const h2c = `package H2C {
    part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; constraint c { p.m2 >= 0.0 } }
    part q : Q { attribute :>> L = 50.0; } }`;
    const mc = await contextModel(h2c, 'H2C');
    const c = checkConstraints(mc).find((r) => r.expression === 'p.m2 >= 0.0')!;
    expect(c.instances?.map((i) => [i.context, i.result])).toEqual([['q', 'unknown']]);
    const inQ = (await verifyModel(mc, { sourceText: h2c, engine: 'smt' })).results;
    expect(inQ.map((r) => [r.expression.trim(), r.claim])).toEqual([
      ['p.m2 >= 0.0', 'proved'],
      ['p.m2 >= 0.0', 'inconclusive'],
    ]);
    // P's own constraint read in Q's p is read for Q's own p alone: q's p,
    // whose load Q's binding joins to q's L of 50, is an instance no context
    // names, and that reading was PROVED for every Q's p (h2p).
    const h2p = `package H2P {
    part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
    part q : Q { attribute :>> L = 50.0; } }`;
    const inP = (await verifyModel(await contextModel(h2p, 'H2P'), { sourceText: h2p, engine: 'smt' })).results;
    expect(inP.map((r) => [r.claim, r.code])).toEqual([
      ['proved', null],
      ['inconclusive', 'verification/not-evaluable'],
    ]);
    expect(inP[1]!.detail).toMatch(/a binding above it joins what it reads to another value in H2P::q/);
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

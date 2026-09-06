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
  isUserElement,
  verifyModel,
  type ObligationVerdict,
} from '@api/index';
import { checkConstraints, type ConstraintCheck } from '@semantics/evaluate-model';
import { obligationsOf, type Obligation } from '@semantics/obligations';
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

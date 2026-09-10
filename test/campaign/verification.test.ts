/**
 * Level L8 — the verdict corpus: known-answer models with golden verdicts.
 *
 * L8 IS A SUITE LEVEL, NOT A FIXTURE LEVEL. `test/fixtures/agent-authoring/`
 * holds L0–L5, and every directory in it is a `validation/*` case with a golden
 * diagnostic list and a `fixed.sysml` that proves its own repair. Nothing here
 * is a validation rule and nothing here has a repair: these are models whose
 * VERDICT is known by construction, and the golden is the verdict.
 *
 * WHAT A CASE IS. A directory with `meta.json` (which engine, which flags, and
 * which model) and `expected.json` (the golden). The models live once, under
 * `models/`, and the two shipped examples are named where they already are —
 * because half these cases are the SAME model run under different flags, and a
 * corpus that copied `refuted-at-values.sysml` twice would let the two copies
 * drift and then disagree about one model.
 *
 * WHAT THE GOLDEN PINS, AND WHY EACH FIELD IS IN IT:
 *
 *  - **The exit code**, which is the whole contract (`VERIFY_EXIT_CODES`). Six
 *    of the twelve cases exist only to pin it under a flag: a refutation is
 *    exit 1 even with `--allow-inconclusive`, vacuity and `not-evaluable` and
 *    an absent solver are exit 2 with it, and an unsupported construct is the
 *    one thing it may lower to 0. Without that last case — the positive
 *    control — every other one would pass against a flag that did nothing.
 *  - **The claim word per obligation.** `holds-at-values` and `proved` are
 *    different claims and this file is where the difference is held: the
 *    literal engine's rows say the first, forever, and a commit that taught it
 *    to say the second would show up as a diff here rather than as a sentence
 *    nobody re-read.
 *  - **`discharged` beside `verdict`.** They are different questions and the
 *    plan is explicit about it: under `--engine literal` a `holds-at-values`
 *    row IS discharged (the reader asked for a point evaluation by name) and
 *    its verdict facet is still `inconclusive`. A golden holding only one of
 *    the two could not tell a correct run from one that had collapsed them.
 *  - **The obligation digest.** It is a function of the relation's normal form
 *    alone, so it survives a reparse and moves when a literal moves — which is
 *    exactly the mutation check the plan's §5 asks for, and having it in the
 *    golden makes that check a diff rather than an assertion somebody has to
 *    remember to write.
 *
 * WHAT IT DELIBERATELY DOES NOT PIN: the model digest and the tool version.
 * Both are correct to move — the first on any edit to the model, the second on
 * every commit — and a golden that carried them would go red for reasons that
 * have nothing to do with a verdict. They are asserted directly, in the cases
 * below, for the properties that actually matter about them.
 *
 * THE RATCHET, in the spirit of the L6 round-trip invariant: a golden verdict
 * may become MORE conservative without ceremony (a row that was discharged
 * becoming inconclusive is the tool getting more careful) and may never become
 * LESS conservative without an explicit re-record and a reason in the commit
 * message. `CAMPAIGN_UPDATE=1 npx vitest run test/campaign/verification.test.ts`
 * regenerates the goldens; a regenerated golden is a DRAFT and every one in
 * this corpus was read by hand.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Ajv from 'ajv';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Model } from '@core/index';
import {
  ALLOW_INCONCLUSIVE_CODES,
  attachEvidence,
  boundsReport,
  faultTreeReport,
  faultTreeVerdict,
  canonicalElements,
  consistencyReport,
  detachEvidence,
  evidenceStatus,
  isUserElement,
  modelVersionOf,
  refinementReport,
  sha256Hex,
  toolVersion,
  traceabilityMatrix,
  VERIFICATION_CODES,
  VERIFICATION_ERROR_CODES,
  verifyModel,
  type VerifyEngineOption,
  type VerifyReport,
} from '@api/index';
import { findCommand, flagsFor } from '../../scripts/lib/sysprose-spec';
import {
  behaviourLaneRefusal,
  checkBounds,
  checkConsistency,
  computeFaultTree,
  isBehaviouralElement,
  CONNECTION_HINT,
  CONTRACT_LEVEL_NOTE,
  DEFAULT_MAX_ORDER,
  FAULT_TREE_CODES,
  ORDERS_NOT_EXPLORED_NOTE,
  SINGLE_POINT_OF_FAILURE_CODE,
  SYSPROSE_VERIFICATION_LIBRARY,
  optimize,
  CONNECTIONS_AS_EQUALITIES_NOTE,
  CONTRACT_SET_VACUOUS_CODE,
  READING,
  REFINEMENT_FAILED_CODE,
  REFINEMENT_UNDECIDED_CODE,
  UNCONNECTED_ASSUMPTION_CODE,
  runVerificationCases,
  writeVerdict,
} from '@semantics/index';
import { parsePropertyText } from '@semantics/mc/patterns';
import { loadZ3, z3Disabled, type Z3Backend } from '@semantics/smt/z3-bridge';
import { loadModelText } from '@text/load';
import { serializeModel } from '@text/serializer';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');
const CASES = root('test/fixtures/verification');
const UPDATE = process.env.CAMPAIGN_UPDATE === '1';

/** What a case declares: which model, which engine, which flags. */
interface Meta {
  level: string;
  title: string;
  /** Repo-relative path to the model. Shared between cases on purpose. */
  model: string;
  engine: VerifyEngineOption;
  allowInconclusive?: boolean;
  /**
   * Features released by `--free`, in the spellings a person types.
   *
   * An SMT-engine option — the literal engine REFUSES it rather than accepting
   * and ignoring it — and the one flag in this lane that changes what a verdict
   * MEANS: a refutation under it is a design the model admits, not a violation
   * of it.
   */
  free?: string[];
  /** Raise a vacuity row to `verification/vacuous-property`, an error (§2). */
  strictVacuity?: boolean;
  /**
   * Run with `SYSPROSE_NO_Z3=1`, the switch the plan's §5 CI job uses to
   * exercise the honest-absence path on every push. It is set here rather than
   * relied on being absent, so these cases keep their meaning on the day
   * `z3-solver` lands in `node_modules`.
   */
  noZ3?: boolean;
  note: string;
}

/** The golden: everything about a run that must not move by accident. */
interface Golden {
  engineAsked: string;
  engine: string;
  toolAbsent: boolean;
  /**
   * Whether the run was given the flag — in the golden, not only in `meta.json`.
   *
   * Six cases here are a PAIR: the same model with and without
   * `--allow-inconclusive`. If the runner ever dropped the flag on the floor,
   * four of those pairs would produce identical goldens and stay green, and the
   * one property they exist to pin — that the flag is refused — would be
   * checked against a run that never asked for it.
   */
  allowInconclusive: boolean;
  /**
   * The other two flags that change what was shown, for the same reason.
   *
   * `strictVacuity` is half of a pair whose whole assertion is that it moves
   * the CODE and not the exit status, and `free` is the flag that turns a
   * violation into a design the model admits — a golden that did not record
   * which features were released would pin a verdict without pinning the bound
   * it was reached under.
   */
  strictVacuity: boolean;
  free: string[];
  exitCode: number;
  counts: {
    discharged: number;
    violated: number;
    inconclusive: number;
    designAdmitted: number;
    vacuous: number;
    forgiven: number;
  };
  obligations: Array<{
    requirement: string | null;
    shortId: string;
    clause: string;
    expression: string;
    obligationDigest: string;
    claim: string;
    verdict: string;
    discharged: boolean;
    code: string | null;
    forgiven: boolean;
    /**
     * `check(¬G)` alone was unsat — the goal is true of every model.
     *
     * In the golden because it is a claim ABOUT a proof rather than a proof:
     * `x == x` is honestly `proved` and honestly useless, and a commit that
     * dropped the flag would leave a corpus of identities reading as a verified
     * design with every other field unchanged.
     */
    tautology: boolean;
    /**
     * The SYMBOLS of the solver's witness, never its terms.
     *
     * Whether a row carries a witness at all is a property of this tool — a
     * proof stands on a satisfiable-assumptions model, a refutation on a
     * counterexample — and which symbols it names is a property of the encoding.
     * The VALUES are z3's own exact rationals, and pinning those would make
     * every golden a pin on a solver's model-construction order rather than on
     * this tool's behaviour. The cases that need a number assert it directly.
     */
    witnessSymbols: string[];
    detail: string;
    premises: Array<{ expression: string; holds: string }>;
  }>;
}

/** The projection a golden is taken over — see the header for what is left out. */
function project(r: VerifyReport): Golden {
  return {
    engineAsked: r.engineAsked,
    engine: r.engine,
    toolAbsent: r.toolAbsent,
    allowInconclusive: r.allowInconclusive,
    strictVacuity: r.strictVacuity,
    free: r.free,
    exitCode: r.exitCode,
    counts: {
      discharged: r.discharged,
      violated: r.violated,
      inconclusive: r.inconclusive,
      designAdmitted: r.designAdmitted,
      vacuous: r.vacuous,
      forgiven: r.forgiven,
    },
    obligations: r.results.map((v) => ({
      requirement: v.requirement?.qualifiedName ?? null,
      shortId: v.shortId,
      clause: v.clause.qualifiedName,
      expression: v.expression,
      obligationDigest: v.obligationDigest,
      claim: v.claim,
      verdict: v.verdict,
      discharged: v.discharged,
      code: v.code,
      forgiven: v.forgiven,
      tautology: v.tautology,
      witnessSymbols: v.witness.map((w) => w.symbol),
      detail: v.detail,
      premises: v.premises.map((p) => ({ expression: p.expression, holds: p.holds })),
    })),
  };
}

/**
 * The solver, or the reason it is absent — `z3-solver` is an OPTIONAL dependency.
 *
 * A clone that skipped optional dependencies must still run every suite, so the
 * cases whose ANSWER needs a backend degrade to a SKIP rather than to a
 * failure, exactly as `test/integration/smt-z3.integration.test.ts` does it.
 * The skip is guarded in `beforeAll` below, so it can never fire on a machine
 * that has the package: a suite that skipped everything because `loadZ3()`
 * quietly broke would read as a suite that passed.
 */
let backendPresent = false;
let absentReason = '';
const installed = existsSync(root('node_modules/z3-solver/package.json'));

beforeAll(async () => {
  const load = await loadZ3();
  if (load.absent) absentReason = load.reason;
  else backendPresent = true;
  if (!backendPresent && installed && !z3Disabled()) {
    throw new Error(
      '`node_modules/z3-solver` is installed and SYSPROSE_NO_Z3 is unset, so `loadZ3()` must ' +
        `return a backend. It answered: ${absentReason}`,
    );
  }
}, 60_000);

/** Does this case mean what it says only when a backend answered? */
function needsSolver(meta: Meta): boolean {
  return meta.noZ3 !== true && meta.engine !== 'literal';
}

/** Skip a solver case where the optional dependency is not installed. */
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

const caseNames = readdirSync(CASES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'models')
  .map((e) => e.name)
  .sort();

/**
 * One parse per MODEL, not one per case.
 *
 * Half the corpus runs the same model under a different flag, and binding the
 * standard library costs a second every time. The model is a pure input here —
 * nothing in this lane mutates it — so the cache is safe as well as fast.
 */
const models = new Map<string, Model>();
async function modelFor(path: string): Promise<Model> {
  const cached = models.get(path);
  if (cached) return cached;
  const { model } = await loadModelText(read(path), { fileName: path });
  if (!model) throw new Error(`${path} produced no model`);
  models.set(path, model);
  return model;
}

/** Run one case exactly as its `meta.json` declares it. */
async function runCase(meta: Meta): Promise<VerifyReport> {
  const model = await modelFor(meta.model);
  const before = process.env.SYSPROSE_NO_Z3;
  if (meta.noZ3 === true) process.env.SYSPROSE_NO_Z3 = '1';
  try {
    return await verifyModel(model, {
      engine: meta.engine,
      allowInconclusive: meta.allowInconclusive === true,
      ...(meta.free !== undefined ? { free: meta.free } : {}),
      ...(meta.strictVacuity === true ? { strictVacuity: true } : {}),
      sourceText: read(meta.model),
    });
  } finally {
    if (before === undefined) delete process.env.SYSPROSE_NO_Z3;
    else process.env.SYSPROSE_NO_Z3 = before;
  }
}

describe('L8 — the verdict corpus', () => {
  it('has cases, and every one of them declares a model that exists', () => {
    // A corpus that silently emptied would make every `it.each` below vacuous:
    // zero cases, zero assertions, green.
    expect(caseNames.length, 'test/fixtures/verification has no case directories').toBeGreaterThan(5);
    for (const name of caseNames) {
      const meta = JSON.parse(read(`test/fixtures/verification/${name}/meta.json`)) as Meta;
      expect(meta.level, `${name}: meta.level`).toBe('L8');
      expect(meta.note.length, `${name}: every case says why it exists`).toBeGreaterThan(40);
      expect(existsSync(root(meta.model)), `${name}: ${meta.model} does not exist`).toBe(true);
    }
  });

  for (const name of caseNames) {
    it(
      `${name} matches its golden verdict`,
      async (ctx) => {
        const dir = `test/fixtures/verification/${name}`;
        const meta = JSON.parse(read(`${dir}/meta.json`)) as Meta;
        if (needsSolver(meta) && !backendPresent) {
          expect(absentReason.length, 'no backend and no reason either').toBeGreaterThan(20);
          ctx.skip();
          return;
        }
        const actual = project(await runCase(meta));
        const goldenPath = root(`${dir}/expected.json`);
        if (UPDATE) {
          writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
          return;
        }
        expect(existsSync(goldenPath), `${name} has no expected.json — bootstrap it with CAMPAIGN_UPDATE=1`).toBe(true);
        const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as Golden;
        expect(actual, `${name}: ${meta.title}`).toEqual(golden);
      },
      120_000,
    );
  }
});

/**
 * The exit contract, asserted over the corpus rather than case by case.
 *
 * Every rule below is a sentence from §2 of the plan turned into a property of
 * every case at once, so a thirteenth case cannot be added that quietly breaks
 * one of them. The goldens above catch a changed VERDICT; these catch a changed
 * RULE, and they are the ones that still fail when a golden is re-recorded to
 * match a mutation.
 *
 * They run the cases rather than reading `expected.json` back, and that is not
 * an accident: a property asserted over the goldens is a property about twelve
 * JSON files, and a mutation to the engine that nobody re-recorded would leave
 * every one of them green. Measured — a mutation making `--engine auto` fall
 * back to the literal engine reddened only the two golden comparisons until
 * these were moved onto the live runs. The models are cached, so the second
 * sweep costs a few hundred milliseconds.
 *
 * Commit 5 adds the rules that only exist once a solver can answer: what
 * `proved` is allowed to stand on, that a design admitted under `--free` is
 * never a violation, and that `--strict-vacuity` is loud and inert.
 */
describe('L8 — the exit contract holds over the whole corpus', () => {
  const goldens: Array<{ name: string; meta: Meta; golden: Golden }> = [];
  beforeAll(async () => {
    for (const name of caseNames) {
      const meta = JSON.parse(read(`test/fixtures/verification/${name}/meta.json`)) as Meta;
      // With no backend a solver case reports `verification/tool-absent` for
      // every row, which is the honest answer and is NOT the answer these rules
      // are written over. It is left out rather than asserted against; the
      // rules that need it are `withZ3` cases and skip.
      if (needsSolver(meta) && !backendPresent) continue;
      goldens.push({ name, meta, golden: project(await runCase(meta)) });
    }
  }, 240_000);

  it('exits 1 only for a refutation, and always for one', () => {
    for (const { name, golden } of goldens) {
      expect(golden.exitCode === 1, `${name}`).toBe(golden.counts.violated > 0);
    }
  });

  it('never exits 0 with anything undecided and unforgiven', () => {
    for (const { name, golden } of goldens) {
      if (golden.exitCode !== 0) continue;
      const undecided = golden.obligations.filter((o) => !o.discharged && !o.forgiven);
      expect(undecided.map((o) => o.clause), `${name} exits 0 with undecided rows`).toEqual([]);
    }
  });

  it('forgives exactly the two undecided codes, and nothing else', () => {
    for (const { name, golden } of goldens) {
      for (const o of golden.obligations) {
        if (!o.forgiven) continue;
        expect(
          o.code !== null && ALLOW_INCONCLUSIVE_CODES.has(o.code),
          `${name} forgave ${o.code ?? 'a decided row'}`,
        ).toBe(true);
      }
    }
  });

  it('never forgives an absent solver, a vacuous obligation or a violation', () => {
    // Stated as its own case rather than left to the one above, because these
    // three are the ones a future flag would be tempted to widen to.
    const never = ['verification/tool-absent', 'verification/vacuous-pass', 'verification/design-admitted'];
    for (const { name, golden } of goldens) {
      for (const o of golden.obligations) {
        if (o.code !== null && never.includes(o.code)) {
          expect(o.forgiven, `${name} forgave ${o.code}`).toBe(false);
        }
        if (o.claim === 'refuted') expect(o.forgiven, `${name} forgave a refutation`).toBe(false);
      }
    }
  });

  it('writes the pass facet for `proved` alone, and the fail facet for `refuted` alone', () => {
    for (const { name, golden } of goldens) {
      for (const o of golden.obligations) {
        expect(o.verdict === 'pass', `${name}: ${o.claim} wrote a pass facet`).toBe(o.claim === 'proved');
        expect(o.verdict === 'fail', `${name}: ${o.claim} wrote a fail facet`).toBe(o.claim === 'refuted');
      }
    }
  });

  it('never says `proved` from the literal engine', () => {
    // The one sentence this engine may never print. It is asserted over the
    // corpus AND over the detail strings, because a claim word that leaked into
    // prose would be read by a person long before it was read by a schema.
    for (const { name, golden } of goldens) {
      if (golden.engine !== 'literal') continue;
      for (const o of golden.obligations) {
        expect(o.claim, `${name}`).not.toBe('proved');
        expect(o.detail, `${name}: the literal engine's own sentence`).not.toMatch(/\bproved\b/);
      }
    }
  });

  it('`auto` never resolves to `literal`, whatever is installed', () => {
    for (const { name, meta, golden } of goldens) {
      if (meta.engine !== 'auto') continue;
      expect(golden.engine, `${name}: auto fell back to a point evaluation`).toBe('smt');
      expect(golden.exitCode, `${name}: a run with no solver must not be green`).toBe(2);
    }
  });

  it('never exits 0 when the engine that was asked for did not run', () => {
    // Stated over `toolAbsent` rather than over the rows, because the rows are
    // where this rule was lost: `exitCodeOf` consulted them alone, so a run
    // with NO rows — an `auto` run with no solver over a model that states no
    // requirement — fell through to `return 0` while stdout said "this run is
    // exit 2". A missing tool must never produce a green build; that is the
    // whole reason VERIFY_EXIT_CODES is a third contract.
    for (const { name, golden } of goldens) {
      if (!golden.toolAbsent) continue;
      expect(golden.exitCode, `${name}: no engine ran and the build went green`).toBe(2);
    }
  });

  it('never exits 0 over a model that states no obligation at all', () => {
    // Exit 0 says every obligation was discharged. A model that states none has
    // been shown nothing, and a build that went green because every requirement
    // was deleted is the same silence the lane exists to break. Asserted for
    // BOTH engines, so it cannot be read as a special case about solvers.
    for (const { name, golden } of goldens) {
      if (golden.obligations.length > 0) continue;
      expect(golden.exitCode, `${name}: nothing was verified and the build went green`).toBe(2);
    }
  });

  /* ── the rules that only exist once a solver can answer (commit 5) ──────── */

  it('says `proved` only from the SMT engine, and only on a decided row', () => {
    // The one sentence this repository is built around. `proved` may appear
    // under exactly one engine, it always writes the pass facet, it is always
    // discharged, and it never carries a code — because a code is what an
    // UNDECIDED row carries, and a proof is decided.
    for (const { name, golden } of goldens) {
      for (const o of golden.obligations) {
        if (o.claim !== 'proved') continue;
        expect(golden.engine, `${name}: a non-SMT engine printed \`proved\``).toBe('smt');
        expect(golden.toolAbsent, `${name}: \`proved\` from a run where no solver ran`).toBe(false);
        expect(o.verdict, `${name}: a proof that did not write the pass facet`).toBe('pass');
        expect(o.discharged, `${name}: a proof that did not discharge its obligation`).toBe(true);
        expect(o.code, `${name}: a proof carrying an undecided code`).toBeNull();
        // The sentence a person reads has to say what the proof stood on.
        expect(o.detail, `${name}: a proof that did not name the negation check`).toContain('¬G unsat');
        expect(o.detail, `${name}: a proof with no satisfiable-assumptions witness`).toContain(
          'assumptions satisfiable',
        );
        expect(o.witnessSymbols.length, `${name}: a proof with an empty witness`).toBeGreaterThan(0);
      }
    }
  });

  withZ3('flags a tautology, and flags nothing else', () => {
    // `x == x` is honestly proved and honestly useless. The flag is the only
    // thing that tells the two apart, and it may only ever sit on a proof.
    for (const { name, golden } of goldens) {
      for (const o of golden.obligations) {
        if (!o.tautology) continue;
        expect(o.claim, `${name}: a tautology flag on a row that was not proved`).toBe('proved');
        expect(o.detail, `${name}: the flag is set and the sentence does not say so`).toContain(
          'TAUTOLOGY',
        );
      }
    }
    const taut = goldens.find((g) => g.name === 'smt-tautology');
    expect(taut, 'the tautology case left the corpus').toBeDefined();
    expect(taut!.golden.obligations.map((o) => o.tautology)).toEqual([true]);
  });

  it('never calls a refutation under `--free` a violation of the model', () => {
    // A `=` value is a binding. A counterexample that exists only because the
    // binding was released is a design the model ADMITS, and reporting it as
    // exit 1 would make every exploration read as a defect report.
    for (const { name, golden } of goldens) {
      for (const o of golden.obligations) {
        if (o.claim !== 'design-admitted') continue;
        expect(golden.free.length, `${name}: design-admitted with nothing freed`).toBeGreaterThan(0);
        expect(o.verdict, `${name}: design-admitted wrote a verdict facet`).toBe('inconclusive');
        expect(o.code, `${name}`).toBe('verification/design-admitted');
        expect(golden.exitCode, `${name}: a design the model admits was reported as exit 1`).toBe(2);
        expect(o.forgiven, `${name}: a flag forgave a design-admitted row`).toBe(false);
      }
      // And with nothing freed, `design-admitted` is unreachable by construction.
      if (golden.free.length === 0) {
        expect(
          golden.counts.designAdmitted,
          `${name}: a design was admitted under a bound nobody released`,
        ).toBe(0);
      }
    }
  });

  it('never refutes over a freed feature the context does not confine on both sides', () => {
    // The rule that stops the fabricated counterexample. A row that reported
    // `free-variable-unbounded` must not ALSO be a refutation, and the sentence
    // has to name the side that escaped so a reader can add the premise.
    for (const { name, golden } of goldens) {
      for (const o of golden.obligations) {
        if (o.code !== 'verification/free-variable-unbounded') continue;
        expect(o.claim, `${name}: an unbounded free variable produced a verdict`).toBe('inconclusive');
        expect(o.detail, `${name}: the side that escaped is not named`).toMatch(
          /unbounded (above|below)/,
        );
        expect(golden.exitCode, `${name}`).toBe(2);
        expect(o.forgiven, `${name}: a flag forgave an unbounded free variable`).toBe(false);
      }
    }
  });

  withZ3(
    'names no point on a row whose own proof context released one',
    async () => {
      // THE POINT A CLAIM WAS READ AT IS A FACT ABOUT THE RUN, and where the
      // context released a variable there is no single point to name.
      //
      // MEASURED: `bindings` was keyed on the GOAL's own variables while the
      // bound was keyed on the whole proof context, and the two disagree
      // whenever the freed feature reaches the goal through a premise or a
      // derived equation. `uav.endurance >= 45.0 [min]` reads only
      // `endurance`; `--free uav.cruisePower` reaches it through the model's
      // own endurance equation. So a `design-admitted` row — the row reporting
      // that the requirement FAILS somewhere in the released domain — carried
      // the model's own 650 W point as its witness plus an SI pair
      // `{lhs: 2835.69, rhs: 2700}`, which is the comparison SATISFIED. One
      // predicate has to decide both, and this is what keeps them one.
      let freedRows = 0;
      for (const name of caseNames) {
        const meta = JSON.parse(read(`test/fixtures/verification/${name}/meta.json`)) as Meta;
        if (meta.free === undefined || meta.free.length === 0) continue;
        const report = await runCase(meta);
        for (const o of report.results) {
          if (o.bound.kind !== 'free-variables') continue;
          freedRows += 1;
          expect(
            o.bindings,
            `${name}: the model's own values offered as the point a released claim was read at`,
          ).toEqual([]);
          expect(
            o.bound.si,
            `${name}: an SI pair read at the model's own point, under a domain the run released`,
          ).toBeUndefined();
        }
      }
      expect(freedRows, 'no case releases anything — this rule holds vacuously').toBeGreaterThan(0);
      // The other direction, so the rule is not "the point is never named":
      // with nothing freed there IS one point, and it is named with the pair
      // the comparison was made on.
      const pinned = await runCase(
        JSON.parse(read('test/fixtures/verification/smt-uav-proved/meta.json')) as Meta,
      );
      expect(pinned.results.length, 'the pinned control left the corpus').toBeGreaterThan(0);
      for (const o of pinned.results) {
        expect(o.bound.kind, 'a run that released nothing stopped naming its point').toBe('model-values');
        expect(o.bindings.length, 'a pinned row with no values').toBeGreaterThan(0);
        expect(o.bound.si, 'a pinned row with no SI pair').toBeDefined();
      }
    },
    240_000,
  );

  withZ3('`--strict-vacuity` changes the code and changes nothing else', () => {
    // §2's promise, asserted as the DIFFERENCE between two runs of one model:
    // the flag is loud and inert. Anything else moving here is the flag
    // deciding something, which is exactly what it may not do.
    const plain = goldens.find((g) => g.name === 'smt-vacuous');
    const strict = goldens.find((g) => g.name === 'smt-vacuous-strict');
    expect(plain && strict, 'the strict-vacuity pair left the corpus').toBeTruthy();
    expect(strict!.golden.exitCode, 'the flag moved the exit code').toBe(plain!.golden.exitCode);
    expect(strict!.golden.exitCode).toBe(2);
    expect(strict!.golden.counts).toEqual(plain!.golden.counts);
    expect(plain!.golden.obligations.map((o) => o.code)).toEqual(['verification/vacuous']);
    expect(strict!.golden.obligations.map((o) => o.code)).toEqual(['verification/vacuous-property']);
    // Everything but the code is byte-identical, which is the honest way to
    // state "and nothing else".
    const strip = (g: Golden) => ({ ...g, strictVacuity: false, obligations: g.obligations.map((o) => ({ ...o, code: null })) });
    expect(strip(strict!.golden)).toEqual(strip(plain!.golden));
  });

  it('never forgives a proof-voiding code, whatever the flag says', () => {
    // The four codes that say a proof would be VOID rather than absent. None of
    // them is a limit of the tool, so none of them is in the flag's scope: a
    // contradictory model, an unsatisfiable premise set and an unconfined free
    // variable all survive `--allow-inconclusive` and all exit 2.
    const never = [
      'verification/inconsistent-axioms',
      'verification/vacuous',
      'verification/vacuous-property',
      'verification/free-variable-unbounded',
      'verification/refuted',
    ];
    for (const { name, golden } of goldens) {
      for (const o of golden.obligations) {
        if (o.code === null || !never.includes(o.code)) continue;
        expect(o.forgiven, `${name} forgave ${o.code}`).toBe(false);
        expect(ALLOW_INCONCLUSIVE_CODES.has(o.code), `${o.code} entered the flag's scope`).toBe(false);
      }
    }
  });

  withZ3('decides nothing at all over a contradictory axiom set, and names the core', () => {
    // The loudest way this lane could be silently wrong: every negation is
    // unsat under a contradiction, so the failure mode is a full sheet of
    // proofs rather than an error.
    const bad = goldens.find((g) => g.name === 'smt-inconsistent-axioms');
    expect(bad, 'the inconsistent-axioms case left the corpus').toBeDefined();
    expect(bad!.golden.counts.discharged, 'something was proved from a contradiction').toBe(0);
    expect(bad!.golden.exitCode).toBe(2);
    for (const o of bad!.golden.obligations) {
      expect(o.claim).toBe('inconclusive');
      expect(o.code).toBe('verification/inconsistent-axioms');
      expect(o.detail, 'the colliding facts are not named').toContain('core: ');
    }
  });

  withZ3('reads a false plain `constraint` as a claim, not as a fact', () => {
    // Both engines, one model: two refutations and exit 1. Read as an axiom the
    // false claim would make the context contradictory and the run would report
    // nothing wrong with either fault — a model with two visible defects coming
    // back "undecided" is worse than one coming back wrong.
    for (const name of ['smt-two-refutations', 'literal-two-refutations']) {
      const g = goldens.find((x) => x.name === name);
      expect(g, `${name} left the corpus`).toBeDefined();
      expect(g!.golden.exitCode, `${name}`).toBe(1);
      expect(g!.golden.counts.violated, `${name}`).toBe(2);
      for (const o of g!.golden.obligations) {
        expect(o.claim, `${name}`).toBe('refuted');
        expect(o.code, `${name}`).toBe('verification/refuted');
        expect(o.detail, `${name}: a refutation reported as a contradictory context`).not.toContain(
          'axiom set is unsatisfiable',
        );
      }
    }
    // And the two engines agree about WHICH relations are wrong, expression by
    // expression — the differential gate in miniature, pinned as a golden.
    const smt = goldens.find((g) => g.name === 'smt-two-refutations')!.golden;
    const lit = goldens.find((g) => g.name === 'literal-two-refutations')!.golden;
    expect(smt.obligations.map((o) => o.expression)).toEqual(lit.obligations.map((o) => o.expression));
    expect(smt.obligations.map((o) => o.obligationDigest)).toEqual(
      lit.obligations.map((o) => o.obligationDigest),
    );
  });

  it('says the refusal out loud on a relation a gate refused but the values decided', () => {
    // `%` evaluates on the numeric surface and is refused by the gates. The
    // point evaluation is honest and is reported; the refusal must travel with
    // it, or a reader sees `holds-at-values` and cannot tell that no other
    // engine will ever confirm it. (`obligations` already prints the refusal;
    // `verify` used to drop it entirely.)
    const gated = goldens.find((g) => g.name === 'gate-refused-holds-at-values');
    expect(gated, 'the gate-refusal case left the corpus').toBeDefined();
    const [only] = gated!.golden.obligations;
    expect(only.claim).toBe('holds-at-values');
    expect(only.detail, 'the refusal was dropped from the sentence').toContain('a gate refuses this relation');
    expect(only.detail).toContain('unsupported-operator');
  });

  withZ3('never lowers a gate-refused relation the values read `violated`, on either engine', () => {
    // §2: `--allow-inconclusive` lowers the two UNDECIDED codes and never a
    // violation. A relation `%` puts outside the encodable fragment can still
    // be FALSE at the model's own values, and reporting that row
    // `verification/unsupported-construct` put it inside the flag's scope: the
    // same file was exit 0 under `--engine smt --allow-inconclusive` and exit 1
    // under `--engine literal --allow-inconclusive`, with `auto` resolving to
    // the first. The pair pins both halves of the answer.
    const smt = goldens.find((g) => g.name === 'smt-gate-refused-refuted');
    const lit = goldens.find((g) => g.name === 'literal-gate-refused-refuted');
    expect(smt && lit, 'the gate-refused refutation pair left the corpus').toBeTruthy();
    for (const g of [smt!, lit!]) {
      expect(g.meta.allowInconclusive, `${g.name}: the case stopped asking for the flag`).toBe(true);
      expect(g.golden.exitCode, `${g.name}: a violation was lowered to a green build`).toBe(1);
      expect(g.golden.counts.forgiven, `${g.name}: a violation was forgiven`).toBe(0);
      expect(g.golden.obligations.map((o) => o.code), `${g.name}`).toEqual(['verification/refuted']);
      expect(g.golden.obligations.map((o) => o.claim), `${g.name}`).toEqual(['refuted']);
      // The refusal still travels with the verdict: a reader has to be able to
      // see that no engine will ever prove this row either way.
      expect(g.golden.obligations[0].detail, `${g.name}: the refusal was dropped`).toContain(
        'a gate refuses this relation',
      );
    }
    // One flag, one scope: the two engines agree code for code and exit for exit.
    expect(smt!.golden.obligations.map((o) => o.code)).toEqual(lit!.golden.obligations.map((o) => o.code));
    expect(smt!.golden.exitCode).toBe(lit!.golden.exitCode);
  });

  withZ3('suppresses a refutation only for a refused relation the goal can REACH', () => {
    // "A refutation needs the whole context" is a rule about this obligation's
    // context, not about the file. Reading the run-level refused set made one
    // unencodable feature value anywhere in a model downgrade every confirmed
    // counterexample in it. The pair is the control: same shape, same refusal
    // reason, and the only difference is whether the refused relation reads the
    // symbol the requirement constrains.
    const off = goldens.find((g) => g.name === 'smt-refused-axiom-irrelevant');
    const on = goldens.find((g) => g.name === 'smt-refused-axiom-relevant');
    expect(off && on, 'the refused-axiom relevance pair left the corpus').toBeTruthy();
    expect(off!.golden.exitCode, 'an unrelated refusal suppressed a refutation').toBe(1);
    expect(off!.golden.obligations.map((o) => o.code)).toEqual(['verification/refuted']);
    expect(on!.golden.exitCode, 'a refusal that touches the goal did not suppress one').toBe(2);
    expect(on!.golden.obligations.map((o) => o.code)).toEqual(['verification/not-evaluable']);
    expect(on!.golden.obligations[0].detail, 'the dropped relation is not named').toContain(
      'PARTIAL context',
    );
    expect(on!.golden.obligations[0].detail).toContain('massPerSeat');
    expect(on!.golden.obligations[0].forgiven, 'a partial context was forgiven').toBe(false);
  });

  withZ3('covers all three exit codes, both sides of the flag, and an empty run', () => {
    // A corpus that lost its exit-1 or its forgiven case would still be green
    // above: every rule there is an implication, and an implication with no
    // instance holds trivially.
    const codes = new Set(goldens.map((g) => g.golden.exitCode));
    expect([...codes].sort(), 'the corpus no longer exercises every exit code').toEqual([0, 1, 2]);
    expect(
      goldens.some((g) => g.golden.counts.forgiven > 0),
      'no case exercises --allow-inconclusive actually forgiving something',
    ).toBe(true);
    expect(
      goldens.some((g) => g.meta.allowInconclusive === true && g.golden.exitCode !== 0),
      'no case exercises --allow-inconclusive being refused',
    ).toBe(true);
    expect(
      goldens.some((g) => g.golden.counts.vacuous > 0),
      'no case exercises vacuity',
    ).toBe(true);
    expect(
      goldens.some((g) => g.golden.obligations.length === 0),
      'no case exercises a model that states no obligation — the rule above would hold vacuously',
    ).toBe(true);
    expect(
      goldens.some((g) => g.golden.toolAbsent && g.golden.obligations.length === 0),
      'no case exercises an absent engine over an empty model, which is where exit 0 leaked',
    ).toBe(true);
    // Both sides of the refusal split, or the mapping could collapse back to
    // one code and only the two goldens that name it would notice.
    expect(
      goldens.some((g) =>
        g.golden.obligations.some((o) => o.code === 'verification/not-evaluable' && g.meta.allowInconclusive === true),
      ),
      'no case shows a malformed relation being refused forgiveness',
    ).toBe(true);
    expect(
      goldens.some((g) =>
        g.golden.obligations.some((o) => o.code === 'verification/unsupported-construct' && o.forgiven),
      ),
      'no case shows an out-of-fragment construct being forgiven',
    ).toBe(true);
    // The SMT engine's own positive controls. Every rule added at commit 5 is
    // an implication over rows of a given claim, and an implication with no
    // instance holds trivially — so losing the case that produces the claim
    // would silently retire the rule rather than fail it.
    const anyRow = (p: (o: Golden['obligations'][number]) => boolean) =>
      goldens.some((g) => g.golden.obligations.some(p));
    expect(anyRow((o) => o.claim === 'proved'), 'no case reaches `proved` at all').toBe(true);
    expect(anyRow((o) => o.tautology), 'no case exercises the tautology flag').toBe(true);
    expect(anyRow((o) => o.claim === 'design-admitted'), 'no case exercises `--free`').toBe(true);
    for (const code of [
      'verification/refuted',
      'verification/vacuous',
      'verification/vacuous-property',
      'verification/inconsistent-axioms',
      'verification/free-variable-unbounded',
    ]) {
      expect(anyRow((o) => o.code === code), `no case reaches ${code}`).toBe(true);
    }
    // A proof under `--free` and a proof with nothing freed are different
    // claims, and both have to be reachable or the two-sided rule could be
    // "no verdict is ever available under --free" and stay green.
    expect(
      goldens.some((g) => g.golden.free.length > 0 && g.golden.counts.discharged > 0),
      'no case proves anything over a released domain',
    ).toBe(true);
  });
});

/**
 * The digest, which is the thing every record is indexed by.
 *
 * These are the plan's own checks: byte-stable across two loads of the same
 * text (**the UUID test** — element ids are fresh on every load, so a digest
 * over a raw snapshot would fail this), moving when a literal moves, ignoring
 * the bundled library, and omitting the git sha rather than inventing one.
 */
describe('L8 — the model digest survives a reparse and notices an edit', () => {
  const text = read('examples/uav-isr.sysml');

  it('is byte-identical across two loads of the same text', async () => {
    const a = await loadModelText(text, { fileName: 'a.sysml' });
    const b = await loadModelText(text, { fileName: 'b.sysml' });
    const first = modelVersionOf(a.model!);
    const second = modelVersionOf(b.model!);
    // The USER ids really are different — otherwise this case would pass for
    // the wrong reason and would keep passing if the canonicalisation were
    // removed. (The bundled library's ids ARE stable: they come out of the
    // shipped JSON, which is why the comparison is over the user's elements.)
    const idsA = a.model!.all().filter((el) => isUserElement(a.model!, el)).map((el) => el.id);
    const idsB = new Set(b.model!.all().filter((el) => isUserElement(b.model!, el)).map((el) => el.id));
    expect(idsA.length, 'the example has user elements').toBeGreaterThan(50);
    expect(idsA.some((id) => idsB.has(id)), 'the two loads shared element ids').toBe(false);
    expect(second.graph, 'the digest moved on a no-op reparse').toBe(first.graph);
  }, 120_000);

  it('moves when a literal moves', async () => {
    const edited = text.replace('mtow : ISQ::MassValue = 18.5 [kg]', 'mtow : ISQ::MassValue = 18.6 [kg]');
    expect(edited, 'the edit did not apply — the example was reworded').not.toBe(text);
    const a = await loadModelText(text, { fileName: 'a.sysml' });
    const b = await loadModelText(edited, { fileName: 'b.sysml' });
    expect(modelVersionOf(b.model!).graph).not.toBe(modelVersionOf(a.model!).graph);
  }, 120_000);

  it('hashes the user model alone, and says plainly when no library was bound', async () => {
    const bound = await loadModelText(text, { fileName: 'a.sysml' });
    const unbound = await loadModelText(text, { fileName: 'a.sysml', library: 'none' });
    expect(
      bound.model!.all().length - unbound.model!.all().length,
      'the bound load did not actually pull the library in',
    ).toBeGreaterThan(30_000);

    // THE LIBRARY EXCLUSION, ASSERTED RATHER THAN DESCRIBED. No assertion over
    // the DIGEST can see this property: the bundled library's ids come out of
    // shipped JSON and are stable across loads, so a hash that wrongly swept in
    // all 38 000 of them would still be byte-identical on a reparse, would
    // still move when a literal moved, and would still differ between these two
    // loads. Every other case in this file stays green under "drop the
    // isUserElement filter". What reddens is the COUNT of what goes in, and the
    // tie between that list and the digest.
    const fedIn = canonicalElements(bound.model!);
    const userElements = bound.model!.all().filter((el) => isUserElement(bound.model!, el)).length;
    expect(fedIn.length, 'the digest is taken over the user model').toBe(userElements);
    expect(fedIn.length, 'the user model is ~113 elements, not ~38 000').toBeLessThan(1000);
    expect(
      modelVersionOf(bound.model!).graph,
      'the graph is no longer the digest of exactly those elements',
    ).toBe(`sha256:${sha256Hex(JSON.stringify({ elements: fedIn }))}`);
    // And nothing in the list is a library element, by its own qualified name.
    expect(
      fedIn.filter((json) => /"qualifiedName":"(ISQ|SI|ScalarValues|Quantities)::/.test(json)),
      'a standard-library element reached the digest',
    ).toEqual([]);

    // What IS in the record is the library count, and it is 0 when nothing was
    // bound: an unbound run analyses a model whose library types resolve to
    // nothing, and a record claiming a standard library that was never in force
    // would be evidence about a context nobody used.
    expect(modelVersionOf(bound.model!).library).toBeGreaterThan(30_000);
    expect(modelVersionOf(unbound.model!).library).toBe(0);
    // And the graph moves too, because binding resolves typings on the USER's
    // own elements. That is honest: the two runs really did analyse different
    // models, and a digest that hid the difference would let evidence from one
    // be replayed as evidence about the other.
    expect(modelVersionOf(unbound.model!).graph).not.toBe(modelVersionOf(bound.model!).graph);
  }, 120_000);

  it('binds the source bytes as well as the graph, when it is given them', async () => {
    const { model } = await loadModelText(text, { fileName: 'a.sysml' });
    expect(modelVersionOf(model!).source).toBeUndefined();
    expect(modelVersionOf(model!, text).source).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 120_000);

  it('omits the git sha when there is no repository, and never invents one', () => {
    // Run in a directory that is not a working tree. An absence that cannot be
    // exercised is an absence that rots into a fabricated commit id.
    expect(toolVersion('/').git).toBeUndefined();
    expect(Object.keys(toolVersion('/'))).toEqual(['name', 'version']);
  });
});

/**
 * The records, against the schema that documents them.
 *
 * `obligationDigest` is `required` in the schema, and that is the assertion
 * with teeth: a record that could not be matched back to a normal form could
 * not be checked against an edited model, which is the whole point of writing
 * one.
 */
describe('L8 — every evidence record validates against its schema', () => {
  // `allowUnionTypes` because a witness value really is one of number, boolean,
  // string or null — the model's own values are not all of one type — and ajv's
  // strict mode would rather see four sub-schemas than say so once.
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const schema = JSON.parse(read('docs/schemas/evidence-record.schema.json')) as object;
  const validate = ajv.compile(schema);

  it('requires the obligation digest, so a record can always be re-checked', () => {
    const required = (schema as { properties: { obligation: { required: string[] } } }).properties
      .obligation.required;
    expect(required, 'the schema stopped requiring obligationDigest').toContain('obligationDigest');
  });

  it('validates the records of every case in the corpus', async () => {
    for (const name of caseNames) {
      const meta = JSON.parse(read(`test/fixtures/verification/${name}/meta.json`)) as Meta;
      const report = await runCase(meta);
      expect(report.records.length, `${name} produced no records`).toBe(report.results.length);
      for (const record of report.records) {
        const ok = validate(record);
        expect(ok, `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      }
    }
  }, 240_000);

  it('records the flags that changed what was shown, and the bound it was shown under', async () => {
    const meta = JSON.parse(read('test/fixtures/verification/holds-at-values-uav/meta.json')) as Meta;
    const report = await runCase(meta);
    for (const record of report.records) {
      expect(record.flags.engine).toBe('literal');
      expect(record.flags.free).toEqual([]);
      expect(record.bound.kind).toBe('model-values');
      // The point the claim was read at, not merely the claim.
      expect(record.witness?.values.length ?? 0).toBeGreaterThan(0);
      expect(record.claim).toBe('holds-at-values');
      expect(record.verdict, 'a point evaluation never writes a pass facet').toBe('inconclusive');
    }
  }, 120_000);

  it('never leaves a witness that reads as refuting the claim it supports', async () => {
    // THE DERIVED-FEATURE TRAP, pinned by value. `uav.endurance` is computed by
    // the model's own equation and STORES 0.7877 — hours — with no declared
    // unit, beside a requirement written `>= 45.0 [min]`. A record carrying
    // only that number reads as a refutation of the verdict it is the evidence
    // for. Two things have to be true for it not to: the binding must say the
    // value is DERIVED, and the bound must carry the pair the comparison was
    // actually made on. Both were computed and thrown away before this case.
    const meta = JSON.parse(read('test/fixtures/verification/holds-at-values-uav/meta.json')) as Meta;
    const report = await runCase(meta);
    const endurance = report.records
      .flatMap((r) => r.witness?.values ?? [])
      .find((v) => v.path === 'uav.endurance');
    expect(endurance, 'the flagship example stopped reading uav.endurance').toBeDefined();
    expect(endurance!.role, 'a computed value that does not say it is computed').toBe('derived');
    expect(endurance!.unit, 'the model declares none — the role is what explains the number').toBeNull();

    const row = report.records.find((r) => r.obligation.expression.includes('endurance'));
    expect(row, 'the endurance obligation left the report').toBeDefined();
    expect(row!.bound.si, 'the SI pair the comparison was made on is missing').toBeDefined();
    // 640 Wh × 0.8 / 650 W = 0.7877 h = 2835.69 s, against 45 min = 2700 s.
    expect(row!.bound.si!.lhs).toBeCloseTo(2835.6923, 3);
    expect(row!.bound.si!.rhs).toBeCloseTo(2700, 6);
    expect(row!.bound.si!.dimension, 'the dimension the two were compared in').toBe('T');
    expect(row!.bound.si!.lhs).toBeGreaterThan(row!.bound.si!.rhs);
    expect(row!.bound.detail, 'the sentence a person reads carries them too').toContain('coherent SI');
  }, 120_000);

  it('is a pure function of the model, the engine and the options — no timestamp', async () => {
    const meta = JSON.parse(read('test/fixtures/verification/holds-at-values-vehicle/meta.json')) as Meta;
    const a = await runCase(meta);
    const b = await runCase(meta);
    expect(JSON.stringify(b.records)).toBe(JSON.stringify(a.records));
  }, 120_000);
});

/** The one option the literal engine refuses rather than accepts and ignores. */
describe('L8 — `--free` is refused by the engine that cannot honour it', () => {
  it('throws rather than printing a verdict under a bound that was not in force', async () => {
    const { model } = await loadModelText(read('examples/uav-isr.sysml'), { fileName: 'a.sysml' });
    await expect(
      verifyModel(model!, { engine: 'literal', free: ['UAVSurveillanceSystem::AirVehicle::cruisePower'] }),
    ).rejects.toThrow(/SMT-engine option/);
  }, 120_000);
});

/**
 * L8 — single-field mutations, which is the plan's §5 "Mutation" for this layer.
 *
 * A golden corpus catches a verdict that MOVED. It cannot catch a verdict that
 * stopped moving: an engine that answered `proved` for everything, or one whose
 * digest was a constant, would match every golden in this directory on the day
 * it was recorded and would keep matching forever. So each case here edits ONE
 * field of one model and asserts the verdict moves in the direction that edit
 * implies — and that the digest the record is indexed by moves with it, because
 * a claim that cannot be told apart from the claim about a different model is
 * not evidence about either.
 *
 * The two edits are the ones §5 names: a literal moved by one tick
 * (`18.5` → `18.6`), and a non-strict ordering made strict at an exact
 * boundary. The second moves the verdict CONSERVATIVELY rather than to the
 * opposite verdict, and that is the honest answer: the unit-aware evaluator
 * counts a tie as equal for every operator and the encoder reasons over exact
 * rationals, so at the boundary the two surfaces genuinely differ and the
 * witness gate declines instead of printing a refutation.
 */
describe('L8 — a single-field mutation moves the verdict, and moves the digest', () => {
  const base = [
    'package Mutation {',
    '    part def Chassis {',
    '        attribute mass : ISQ::MassValue = 18.5 [kg];',
    '    }',
    '    part chassis : Chassis;',
    '    requirement def MassLimit {',
    '        subject chassis : Chassis;',
    '        require constraint { chassis.mass <= 18.5 [kg] }',
    '    }',
    '    satisfy MassLimit by chassis;',
    '}',
    '',
  ].join('\n');

  /** One run over one text: the single row's claim, and the two digests. */
  async function judge(text: string): Promise<{
    claim: string;
    code: string | null;
    obligationDigest: string;
    modelDigest: string;
  }> {
    const { model } = await loadModelText(text, { fileName: 'mutation.sysml' });
    const report = await verifyModel(model!, { engine: 'smt', sourceText: text });
    expect(report.results.length, 'the mutation changed how many obligations there are').toBe(1);
    const [only] = report.results;
    return {
      claim: only.claim,
      code: only.code,
      obligationDigest: only.obligationDigest,
      modelDigest: report.modelVersion.graph,
    };
  }

  withZ3('is proved at the boundary before anything is touched', async () => {
    const before = await judge(base);
    expect(before.claim, 'the control case stopped being provable').toBe('proved');
    expect(before.code).toBeNull();
  }, 120_000);

  withZ3('`18.5` → `18.6` in the VALUE flips proved to refuted and moves the model digest', async () => {
    const before = await judge(base);
    const after = await judge(base.replace('= 18.5 [kg]', '= 18.6 [kg]'));
    expect(after.claim, 'the verdict did not move when the value went over the limit').toBe('refuted');
    expect(after.code).toBe('verification/refuted');
    expect(after.modelDigest, 'the model digest did not move on an edited literal').not.toBe(
      before.modelDigest,
    );
    // The OBLIGATION digest is a function of the relation's normal form alone,
    // so it must NOT move: the same requirement is being judged, about a
    // different model. A record that moved both could not be matched back.
    expect(after.obligationDigest, 'the obligation digest moved when only a value did').toBe(
      before.obligationDigest,
    );
  }, 120_000);

  withZ3('`18.5` → `18.6` in the RELATION moves the obligation digest and keeps the verdict', async () => {
    const before = await judge(base);
    const after = await judge(base.replace('<= 18.5 [kg] }', '<= 18.6 [kg] }'));
    expect(after.claim, '18.5 <= 18.6 stopped holding').toBe('proved');
    expect(after.obligationDigest, 'the obligation digest did not move on an edited relation').not.toBe(
      before.obligationDigest,
    );
    expect(after.modelDigest, 'the relation is part of the model').not.toBe(before.modelDigest);
  }, 120_000);

  withZ3('`<=` → `<` at the exact boundary moves the verdict conservatively, never to a refutation', async () => {
    const before = await judge(base);
    const after = await judge(base.replace('<= 18.5 [kg] }', '< 18.5 [kg] }'));
    expect(after.claim, 'the strict ordering did not move the verdict at all').not.toBe('proved');
    // The direction matters and is the whole point: the two surfaces read a tie
    // differently, so the engine declines. A refutation here would be this tool
    // contradicting its own checker on a boundary case.
    expect(after.claim, 'a boundary tie was printed as a violation').toBe('inconclusive');
    expect(after.code).toBe('verification/not-evaluable');
    expect(after.obligationDigest, 'the operator is part of the normal form').not.toBe(
      before.obligationDigest,
    );
  }, 120_000);
});

/**
 * L8 — `consistency`: the requirement set, rather than one obligation.
 *
 * A SUITE-LEVEL CASE RATHER THAN A GOLDEN DIRECTORY, and the reason is the
 * runner above: `test/fixtures/verification/<case>/expected.json` is a
 * projection of a `VerifyReport`, and a consistency run is a different report
 * about a different question. Rather than teach one runner two shapes — where
 * every corpus-wide rule above would then have to say which of the two it is
 * written over — the models live beside the others in `models/` and the
 * properties are asserted here, in the file the plan calls the L8 suite.
 *
 * WHAT EACH CASE PINS is a sentence from §3.5's MUST-NEVER list turned into a
 * property: a core is only ever printed as a "conflicting subset" unless a
 * completed deletion loop earned the other word; "consistent" never appears
 * without the count of what was left out and the mode it was computed in; a
 * relation a gate refused is listed and is not in the core; and the word
 * `realizable` is nowhere, because that is a different question this lane does
 * not answer.
 */
describe('L8 — consistency: a requirement set, and the subset that conflicts', () => {
  const CONFLICT = 'test/fixtures/verification/models/consistency-conflict.sysml';
  const OFFSET = 'test/fixtures/verification/models/consistency-offset-scale.sysml';
  const COMPUTED = 'test/fixtures/verification/models/consistency-computed-value.sysml';
  const MODES = 'test/fixtures/verification/models/consistency-modes.sysml';
  const UNENGAGEABLE = 'test/fixtures/verification/models/consistency-unengageable.sysml';
  const SUBTYPE = 'test/fixtures/verification/models/consistency-subtype.sysml';
  const ANONYMOUS = 'test/fixtures/verification/models/consistency-anonymous.sysml';

  /** One run over one model, with the flags a person would type. */
  async function check(
    path: string,
    opts: Parameters<typeof consistencyReport>[1] = {},
  ): Promise<Awaited<ReturnType<typeof consistencyReport>>> {
    const model = await modelFor(path);
    return consistencyReport(model, { ...opts, sourceText: read(path) });
  }

  withZ3(
    'says the shipped example is consistent, with a re-evaluated witness, and names the mode',
    async () => {
      const withValues = await check('examples/uav-isr.sysml', { withValues: true });
      expect(withValues.exitCode, 'the shipped example stopped being satisfiable').toBe(0);
      expect(withValues.consistent).toBe(1);
      expect(withValues.released, '`--with-values` released something').toEqual([]);
      const [group] = withValues.groups;
      expect(group.outcome).toBe('consistent');
      // The witness is the model's OWN point, and it is re-read in process
      // before it is printed — the two facts the plan asks for on a SAT answer.
      expect(group.witnessConfirmed, 'a design point was printed unconfirmed').toBe(true);
      const mtow = group.witness.find((w) => w.symbol.endsWith('::mtow'));
      expect(mtow, 'the witness no longer names the mass the requirement is about').toBeDefined();
      expect(mtow!.value, 'the witness is not the value the file states').toBeCloseTo(18.5, 9);
      const power = group.witness.find((w) => w.symbol.endsWith('::cruisePower'));
      expect(power!.value).toBeCloseTo(650, 9);
      // MUST NEVER say "consistent" without the refused count beside it, or
      // without the mode it was computed in.
      expect(group.detail, 'a consistent verdict with no refused count').toMatch(/\d+ relations? refused/);
      expect(group.detail, 'a consistent verdict that does not name its mode').toContain('--with-values');
      // The plan's own fragment vocabulary: pinned values make the reasoning
      // linear even though the script's bytes are not.
      expect(group.fragment).toBe('qf-lra');
      expect(group.logic, 'the set-logic line is computed from the bytes').toBe('QF_NRA');
    },
  );

  withZ3('releases the literal values unless it is asked not to, and says which', async () => {
    // THE DEFAULT IS THE DIFFERENT QUESTION. Without `--with-values` the file's
    // own numbers are not what answers, and the report says exactly which ones
    // it let go — a mode nobody can see is a mode nobody can check.
    const released = await check('examples/uav-isr.sysml');
    expect(released.exitCode).toBe(0);
    expect(released.withValues).toBe(false);
    expect(released.released, 'nothing was released, so the default is the other question').toContain(
      'UAVSurveillanceSystem::AirVehicle::mtow',
    );
    expect(released.released).toContain('UAVSurveillanceSystem::AirVehicle::cruisePower');
    expect(released.groups[0].detail).toContain('every literal feature value released');
    // And the point the solver chose is NOT the model's own, precisely because
    // the model's own values were not asserted.
    const mtow = released.groups[0].witness.find((w) => w.symbol.endsWith('::mtow'));
    expect(mtow, 'the released run stopped naming the freed feature').toBeDefined();
    expect(mtow!.value, 'the released run answered at the file’s own value').not.toBeCloseTo(18.5, 9);
  });

  withZ3('names both constraints when a mass floor contradicts a mass ceiling', async () => {
    const r = await check(CONFLICT);
    expect(r.exitCode, 'a requirement set nothing can satisfy is a decided finding').toBe(1);
    expect(r.inconsistent).toBe(1);
    const [group] = r.groups;
    expect(group.outcome).toBe('inconsistent');
    expect(group.code).toBe('verification/inconsistent-requirements');
    // THE CORE, NAMED. An inconsistency printed without one is the thing §3.5
    // forbids: a reader told their requirements collide and not told which.
    expect(group.core.map((m) => m.qualifiedName).sort()).toEqual([
      'ConsistencyConflict::MassCeiling::mtowCeiling',
      'ConsistencyConflict::MassFloor::mtowFloor',
    ]);
    // Both ways, per §3.5: by the reader's name for the requirement, and by
    // the element the relation IS.
    expect(group.core.map((m) => m.requirement?.shortId).sort()).toEqual(['R-UAV-002', 'R-UAV-004']);
    for (const member of group.core) {
      expect(member.id, 'a core member with no element id').toBeTruthy();
      // A core member from a requirement is its GUARANTEE, asserted under that
      // requirement's assumptions — which these two do not have.
      expect(member.kind).toBe('guarantee');
      expect(member.assumptions).toEqual([]);
    }
    expect(group.detail).toContain('R-UAV-002::mtowCeiling');
    expect(group.detail).toContain('R-UAV-004::mtowFloor');
    // The diagnostic is an ERROR and is anchored at a real element.
    const finding = r.diagnostics.find((d) => d.code === 'verification/inconsistent-requirements');
    expect(finding, 'an inconsistency that filed no diagnostic').toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.elementId).toBeTruthy();
  });

  withZ3('calls a core "a conflicting subset" until a deletion loop has run', async () => {
    // The word "minimal" is a claim about every OTHER member of the set, and
    // only the deletion loop makes it. Three runs: without the flag, with it,
    // and with a budget too small for it to run at all.
    const plain = await check(CONFLICT);
    expect(plain.groups[0].minimized).toBe(false);
    expect(plain.groups[0].coreLabel).toBe('a conflicting subset');
    expect(plain.groups[0].detail).not.toContain('minimal');

    const reduced = await check(CONFLICT, { minimize: true });
    expect(reduced.groups[0].minimized, 'the deletion loop did not complete').toBe(true);
    expect(reduced.groups[0].coreLabel).toBe('a minimal conflicting subset');
    expect(reduced.groups[0].detail).toContain('a minimal conflicting subset');
    // It is still the same subset — this core was already minimal, which is
    // why the flag is what earns the WORD and not what changes the answer.
    expect(reduced.groups[0].core.map((m) => m.qualifiedName).sort()).toEqual(
      plain.groups[0].core.map((m) => m.qualifiedName).sort(),
    );
    // Every member of a minimised core is needed: dropping any one of them
    // leaves a set that IS satisfiable. Asserted rather than assumed, because
    // a deletion loop that tested each candidate against the whole script
    // instead of against the core returned a satisfiable singleton labelled
    // minimal, and every assertion above it stayed green.
    expect(reduced.groups[0].core.length).toBeGreaterThan(1);

    // THE MODE THE DEFECT LIVES IN. With the values released the core and the
    // script coincide, so a loop that re-checks against the whole script and
    // one that shrinks the core itself are byte-identical and every assertion
    // above stays green under the defect restored. Pinning the value of the
    // very feature the core is about is what separates them: the pinned axiom
    // keeps every trial unsatisfiable, so the broken loop deletes a member the
    // rest does not contradict without and returns the SATISFIABLE singleton
    // {`mtow >= 30`} labelled minimal.
    const pinned = await check(CONFLICT, { minimize: true, withValues: true });
    expect(pinned.exitCode).toBe(1);
    expect(pinned.groups[0].minimized, 'the deletion loop did not complete').toBe(true);
    expect(
      pinned.groups[0].core.length,
      'the deletion loop reduced a core to a set that is satisfiable on its own',
    ).toBeGreaterThan(1);
    expect(pinned.groups[0].core.map((m) => m.requirement?.shortId).sort()).toEqual([
      'R-UAV-002',
      'R-UAV-004',
    ]);

    const budgeted = await check(CONFLICT, { minimize: true, maxCore: 1 });
    expect(budgeted.groups[0].minimized, 'a budget too small still claimed minimality').toBe(false);
    expect(budgeted.groups[0].coreLabel).toBe('a conflicting subset');
    expect(budgeted.groups[0].detail, 'the line does not say the budget was why').toContain(
      '--max-core 1',
    );
  });

  withZ3('lists a °C relation under refused, and never inside the core', async () => {
    // Arithmetic on an offset scale is refused by the same gate the numeric
    // surface applies. The refusal has to travel with the verdict — a relation
    // that disappears from a satisfiability question reads as one that was
    // satisfied — and it can never be part of a core, because nothing asserted
    // it.
    const r = await check(OFFSET);
    expect(r.exitCode).toBe(1);
    const [group] = r.groups;
    expect(group.refused.map((x) => x.reason)).toEqual(['offset-arithmetic']);
    expect(group.refused[0].qualifiedName).toBe('ConsistencyOffsetScale::RiseLimit::riseLimit');
    expect(
      group.core.map((m) => m.qualifiedName),
      'a relation nothing asserted turned up in an unsat core',
    ).not.toContain('ConsistencyOffsetScale::RiseLimit::riseLimit');
    expect(group.core).toHaveLength(2);
    // And the count travels with the verdict, on the line and in the report.
    expect(group.detail).toContain('1 relation(s) refused');
    expect(r.refused).toBe(1);
    expect(
      r.diagnostics.some(
        (d) => d.code === 'verification/unsupported-expression' && d.elementName?.endsWith('riseLimit'),
      ),
      'the refused relation was dropped rather than listed',
    ).toBe(true);
  });

  it('decides nothing with no solver, exits 2, and no flag lowers it', async () => {
    // Forced rather than waited for: the honest-absence path is the single
    // most likely thing in this lane to rot into a silent green, and a machine
    // that HAS z3 cannot exercise it by accident.
    const before = process.env.SYSPROSE_NO_Z3;
    process.env.SYSPROSE_NO_Z3 = '1';
    try {
      for (const allowInconclusive of [false, true]) {
        const r = await check('examples/uav-isr.sysml', { allowInconclusive });
        expect(r.toolAbsent, 'the switch did not force the absent path').toBe(true);
        expect(r.exitCode, 'an absent solver produced a green build').toBe(2);
        expect(r.forgiven, 'a flag forgave an absent solver').toBe(0);
        expect(r.consistent).toBe(0);
        expect(r.groups.map((g) => g.code)).toEqual(['verification/tool-absent']);
        // The CENSUS is still true: "0 requirements on 0 subjects" over this
        // file would let an absent solver read as an empty model.
        expect(r.requirements, 'the absent path forgot the model it did not check').toBe(2);
        expect(r.groups[0].requirements).toHaveLength(2);
      }
    } finally {
      if (before === undefined) delete process.env.SYSPROSE_NO_Z3;
      else process.env.SYSPROSE_NO_Z3 = before;
    }
  }, 120_000);

  withZ3('never decides a requirement set that states nothing this lane encodes', async () => {
    // An empty conjunction is satisfiable. Reporting that as "consistent"
    // would call a file of prose requirements a checked one.
    const r = await check('test/fixtures/verification/models/prose-only.sysml', {
      allowInconclusive: true,
    });
    expect(r.consistent).toBe(0);
    expect(r.groups.map((g) => g.outcome)).toEqual(['inconclusive']);
    expect(r.groups[0].noFormalClause).toBe(1);
    // The rule this turns on is the FIRST one in the exit contract — a run in
    // which nothing at all was decided is exit 2 — and NOT the flag's scope. A
    // prose-only set is coded `verification/unsupported-construct`, which the
    // flag does forgive: it is forgiven here, and the same set beside a set
    // that WAS decided would go green. What keeps this run at 2 is that
    // nothing was decided at all, and naming the wrong rule in the failure
    // message is how a case survives the change that breaks it.
    expect(r.exitCode, 'a run that decided nothing is exit 2 whatever the flag says').toBe(2);
    expect(r.forgiven, 'the flag did forgive the undecided set — and did not lower the run').toBe(1);
    expect(r.groups[0].detail).not.toContain('consistent');
  });

  withZ3('releases a stated value however it was spelled, and does not answer at it', async () => {
    // THE RELEASE IS SEMANTIC, NOT A TEST OF THE STORAGE FORM. The mapper keeps
    // a bare numeral as a number and every other value expression as verbatim
    // source text, so `= 2.0 * 5.0` and `= -(30.0)` reach this lane in a shape
    // that does not parse as a numeral. A release that asked about the storage
    // form would PIN those two and release the plain ones, and this set — which
    // any design satisfies once `k` is free — would come back inconsistent, an
    // error and exit 1, purely because of how a value was spelled. Two
    // spellings of one number must not give opposite verdicts.
    const r = await check(COMPUTED);
    expect(r.exitCode, 'a satisfiable requirement set was refused over a spelling').toBe(0);
    expect(r.consistent).toBe(1);
    expect(r.released, 'a closed value expression stayed pinned').toContain(
      'ConsistencyComputedValue::Craft::k',
    );
    expect(r.released, 'a parenthesised negative literal stayed pinned').toContain(
      'ConsistencyComputedValue::Craft::j',
    );
    expect(r.groups[0].core, 'a released value turned up in a conflicting subset').toEqual([]);
    // And the header's count of what it let go is the truth about this run: "0
    // of them" beside a verdict computed at the file's own values is the
    // sentence this case exists to keep out.
    expect(r.released).toHaveLength(2);

    // THE POSITIVE CONTROL. `--with-values` re-pins them and the collision is
    // real: `k` is 10 and `R-K1` asks for 20. Without this half, a release that
    // let go of EVERYTHING — including the defining equations that are
    // structure — would pass the assertions above.
    const pinned = await check(COMPUTED, { withValues: true });
    expect(pinned.exitCode).toBe(1);
    expect(pinned.inconsistent).toBe(1);
    expect(
      pinned.groups[0].core.some((m) => m.kind === 'axiom'),
      'the pinned value is not in the subset that conflicts',
    ).toBe(true);
  });

  withZ3('does not call two mode-guarded requirements a conflict', async () => {
    // THE READING, exercised on the pattern that separates the two. Asserting
    // `A ∧ G` per requirement forces one design point to satisfy every
    // antecedent at once, so a cruise ceiling and a ferry floor — guarded by
    // modes that cannot both hold — come back as a conflicting subset naming
    // two guarantees that never have to hold together. That is a false alarm on
    // one of the commonest patterns in systems engineering, and it is what this
    // model exists to keep out. The guarantees themselves DO collide, which is
    // `consistency-conflict.sysml` above: the difference is the `assume`.
    const r = await check(MODES);
    expect(r.exitCode, 'mode-guarded requirements were called a contradiction').toBe(0);
    expect(r.consistent).toBe(1);
    expect(r.inconsistent).toBe(0);
    const [group] = r.groups;
    expect(group.outcome).toBe('consistent');
    expect(group.core, 'a consistent set named a conflicting subset').toEqual([]);
    // Both requirements were asked, antecedent and consequent alike — a reading
    // that dropped the `assume` clauses would be green here for the wrong
    // reason, and the per-requirement census is where that shows.
    expect(group.requirements.map((x) => x.asserted)).toEqual([2, 2]);
    // "Consistent" under an implication reading and under a conjunction reading
    // are different claims, so the line says which one it is.
    expect(group.detail, 'the verdict does not say what a requirement was taken to mean').toContain(
      READING,
    );
    // Neither requirement is vacuous: each mode is reachable, which is the
    // whole discrimination the implication reading buys.
    expect(group.unengageable).toEqual([]);
  });

  withZ3('refuses to call a set consistent when one of its requirements can never apply', async () => {
    // WHAT THE IMPLICATION READING COSTS, and where it is paid. `⋀ (A ⇒ G)` is
    // satisfiable by falsifying every antecedent, so a set can hold for the one
    // reason nobody wants. Both shapes are here: an assumption that contradicts
    // itself, and two requirements under the SAME assumption whose guarantees
    // collide — the conflict a conjunction reading was kept for, still found.
    for (const allowInconclusive of [false, true]) {
      const r = await check(UNENGAGEABLE, { allowInconclusive });
      expect(r.consistent, 'a set that engages nothing was called consistent').toBe(0);
      expect(r.exitCode, 'vacuity went green in a lane where no flag lowers it').toBe(2);
      expect(r.forgiven, 'a flag forgave a vacuity').toBe(0);
      expect(r.groups.map((g) => g.code)).toEqual([
        'verification/vacuous',
        'verification/vacuous',
      ]);
      expect(r.unengageable, 'the requirements nothing engages were not named').toBe(3);
      // NAMED, with the clauses that cannot hold — a reader told their set is
      // undecided and not told which requirement never applies has nothing to
      // act on.
      expect(r.groups.flatMap((g) => g.unengageable.map((u) => u.shortId)).sort()).toEqual([
        'R-GCS-1',
        'R-GCS-2',
        'R-NEVER',
      ]);
      expect(r.groups[0].unengageable[0].assumptions).toEqual([
        'uav.mode > 5.0 and uav.mode < 2.0',
      ]);
      // The set IS satisfiable and the witness says so: what is undecided is
      // whether the requirements mean anything at that point.
      expect(r.groups[0].witness.length, 'the satisfying point was withheld').toBeGreaterThan(0);
      expect(r.groups[0].witnessConfirmed).toBe(true);
      expect(r.groups[0].detail).not.toContain('can hold together');
      // And one INFO per requirement, carrying the same code `verify` files for
      // an obligation discharged by an antecedent nothing satisfies.
      expect(
        r.diagnostics.filter((d) => d.message.includes('applies at no point this requirement set')),
        'a requirement nothing engages was counted and never named to a reader',
      ).toHaveLength(3);
      expect(r.diagnostics.every((d) => d.code === 'verification/vacuous')).toBe(true);
    }
  });

  withZ3('counts a supertype’s relations once, and answers for a subtype that states none', async () => {
    // A CONTRACT ABOUT A SUPERTYPE IS A MEMBER OF EVERY SUBTYPE'S GROUP — that
    // is what "a type answers for its subtypes" means — so a run-level figure
    // built by concatenating the groups counts one relation twice the moment a
    // model has a hierarchy. `requirements` was always deduplicated; a report
    // whose three census figures disagree about how big the model is is worse
    // than any one of them being wrong, and the refused count is the figure
    // §3.5 makes travel beside the word "consistent".
    const r = await check(SUBTYPE);
    expect(r.groups).toHaveLength(2);
    expect(r.requirements, 'the shared requirements were counted once per group').toBe(4);
    expect(r.refused, 'one refused relation was counted once per group').toBe(1);
    expect(r.noFormalClause, 'one prose requirement was counted once per group').toBe(1);
    expect(
      r.diagnostics.filter((d) => d.code === 'verification/unsupported-expression'),
      'the same refusal was filed once per group it appears in',
    ).toHaveLength(1);
    expect(
      r.diagnostics.filter((d) => d.code === 'verification/unsupported-construct'),
    ).toHaveLength(1);
    // The per-group rows are unaffected: each group really does hold the
    // supertype's requirements, and that is the promise being kept.
    expect(r.groups.map((g) => g.requirements.length)).toEqual([3, 4]);

    // `--subject` NARROWS BY WHAT THE READER TYPED. Three spellings, all of
    // which a reader reaches for, and the argument order of the conformance
    // test they rest on inverts silently.
    const model = await modelFor(SUBTYPE);
    const idOf = (qualified: string): string => {
      const el = model.all().find((e) => model.qualifiedName(e.id) === qualified);
      expect(el, `${qualified} is not in the model`).toBeDefined();
      return el!.id;
    };
    // A subtype no contract names at all: its group exists because its
    // supertypes' requirements are requirements about it.
    const air = await check(SUBTYPE, { subjectId: idOf('ConsistencySubtype::AirVehicle') });
    expect(air.groups).toHaveLength(1);
    expect(air.groups[0].subject?.typeQualifiedName).toBe('ConsistencySubtype::AirVehicle');
    expect(air.groups[0].requirements.map((x) => x.shortId).sort()).toEqual([
      'R-AMASS',
      'R-PROSE',
      'R-RISE',
      'R-VMASS',
    ]);
    // The part usage the file writes after `subject`, which every row of this
    // report prints beside the type — narrowed through its declared type.
    const usage = await check(SUBTYPE, { subjectId: idOf('ConsistencySubtype::uav') });
    expect(usage.groups.map((g) => g.subject?.typeQualifiedName)).toEqual([
      'ConsistencySubtype::AirVehicle',
    ]);
    // And a supertype answers for itself AND its subtypes, which is the other
    // half of the same rule.
    const vehicle = await check(SUBTYPE, { subjectId: idOf('ConsistencySubtype::Vehicle') });
    expect(vehicle.groups.map((g) => g.subject?.typeQualifiedName)).toEqual([
      'ConsistencySubtype::Vehicle',
      'ConsistencySubtype::AirVehicle',
    ]);
  });

  withZ3('says how many requirements stated nothing, beside the word "consistent"', async () => {
    // The refused count is not the only way a requirement leaves the question.
    // A requirement with no relation at all was never encoded, no gate refused
    // it, and "4 requirement(s) can hold together … 0 relations refused" over a
    // set where one of them is prose reads as a checked set. Both figures
    // travel with the verdict or neither does.
    const r = await check(SUBTYPE);
    const air = r.groups.find((g) => g.subject?.typeQualifiedName?.endsWith('AirVehicle'))!;
    expect(air.outcome).toBe('consistent');
    expect(air.noFormalClause).toBe(1);
    expect(air.detail, 'the consistent verdict hides the prose-only count').toContain(
      '1 requirement(s) state no relation at all',
    );
    expect(air.detail, 'the consistent verdict hides the refused count').toContain(
      '1 relation(s) refused',
    );
    // And the reader can find out WHICH one, rather than only how many.
    const info = r.diagnostics.find(
      (d) => d.code === 'verification/unsupported-construct' && d.elementName?.endsWith('ProseOnly'),
    );
    expect(info, 'the prose-only requirement was counted and never named').toBeDefined();
    expect(info!.severity).toBe('info');
  });

  withZ3('names two anonymous clauses of one requirement apart', async () => {
    // A NAMED SUBSET IS THE WHOLE POINT, and an anonymous clause has no name of
    // its own — which is how most of the verification corpus is written. Both
    // members of this core render as `R-ANON::«ConstraintUsage»`, so the
    // sentence §3.5 requires be a named subset would print one name twice and
    // leave a reader with nothing to look up. Where the name repeats, the
    // relation itself separates them.
    const r = await check(ANONYMOUS);
    expect(r.exitCode).toBe(1);
    const [group] = r.groups;
    expect(group.core).toHaveLength(2);
    expect(
      new Set(group.core.map((m) => m.qualifiedName)).size,
      'the fixture stopped being the anonymous shape this case is about',
    ).toBe(1);
    expect(group.detail).toContain('R-ANON::«ConstraintUsage» `craft.mass <= 25.0 [kg]`');
    expect(group.detail).toContain('R-ANON::«ConstraintUsage» `craft.mass >= 30.0 [kg]`');
    // The diagnostic a reader is shown is that same sentence, so the
    // disambiguation has to be in the sentence and not only in the CLI's list.
    const finding = r.diagnostics.find((d) => d.code === 'verification/inconsistent-requirements')!;
    expect(finding.message).toContain('craft.mass <= 25.0 [kg]');
    expect(finding.message).toContain('craft.mass >= 30.0 [kg]');
  });

  it('does not print a design point its own evaluator cannot reproduce', async () => {
    // THE RE-EVALUATION GATE, exercised from the failing side. A backend that
    // answers `sat` with a point the requirements do not hold at is exactly
    // what an encoder defect looks like from here, and a gate asserted only
    // from the passing side would stay green if `confirmWitness` were replaced
    // by `() => ({ ok: true })`. Driven with a stub rather than with z3,
    // because a correct solver cannot produce this answer.
    const model = await modelFor(CONFLICT);
    const stub: Z3Backend = {
      absent: false,
      version: '0.0.0',
      fullVersion: 'stub',
      seed: 0,
      initMs: 0,
      async check(_script, opts) {
        return {
          status: 'sat',
          reason: '',
          timedOut: false,
          timeoutMs: opts?.timeoutMs ?? 0,
          elapsedMs: 0,
          // Every symbol the script declared, at a magnitude no mass ceiling
          // admits — a point the solver "found" and the model refutes.
          witness: (opts?.variables ?? []).map((symbol) => ({
            symbol,
            term: '999999.0',
            value: 999999,
          })),
          core: [],
        };
      },
      // This stub exists to answer ONE question wrongly on purpose. It bounds
      // nothing, and a bounds run that reached it would be a caller asking a
      // consistency stub for an optimum.
      async optimize(_script, _sense, opts) {
        return {
          status: 'error',
          reason: 'this stub answers checks only',
          timedOut: false,
          timeoutMs: opts?.timeoutMs ?? 0,
          elapsedMs: 0,
          bound: null,
          witness: [],
        };
      },
    };
    const r = await checkConsistency(model, { backend: stub });
    const [group] = r.groups;
    expect(group.outcome, 'an unconfirmed design point was reported as a verdict').toBe(
      'inconclusive',
    );
    expect(group.code).toBe('verification/not-evaluable');
    expect(group.witnessConfirmed, 'a point this tool could not reproduce was confirmed').toBe(
      false,
    );
    expect(group.detail).toContain('would not confirm it');
    // The point is still shown — a reader debugging an encoder defect needs it
    // — and it is shown as the thing that failed, not as evidence.
    expect(group.witness.length).toBeGreaterThan(0);
  });

  it('never says the reserved word, in any surface this command reaches a reader through', () => {
    // §6 non-goal 5: `consistency` decides SATISFIABILITY of static contracts.
    // The reactive question is a different one with a different answer, and its
    // word is reserved by the claims guard. The plan document is excluded — it
    // is where the boundary is DISCUSSED, and discussing it is the reason this
    // case exists.
    //
    // COMMENT LINES IN SOURCE ARE EXCLUDED, and only comment lines: a doc
    // comment saying which word this file refuses to print is not the tool
    // printing it, and a guard that could not tell the two apart would forbid
    // the module from stating its own charter. Every string a reader can be
    // shown is still scanned, in source and in prose alike.
    const speech = (file: string): string =>
      file.endsWith('.md')
        ? read(file)
        : read(file)
            .split('\n')
            .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
            .join('\n');
    // The guard is not vacuous: the word IS in the file this command lives in,
    // in the comment that says it will not be printed.
    expect(read('src/semantics/consistency.ts'), 'the charter no longer names what it refuses').toMatch(
      /realiz|realis/i,
    );
    for (const file of [
      'src/semantics/consistency.ts',
      // The safety lane's own module, added with it: `fault-tree` prints a
      // sentence about what it is on every report, and the reserved word is
      // exactly the one a fault-tree report would reach for.
      'src/semantics/fault-tree.ts',
      'src/api/verification.ts',
      'scripts/sysprose.ts',
      'scripts/lib/sysprose-spec.ts',
      'src/text/langium/diagnostic-codes.ts',
      'docs/CLI-REFERENCE.md',
      'docs/DIAGNOSTIC-CODES.md',
      'docs/USER-GUIDE.md',
      // The two documents this command's own prose was added to. A file list
      // that stopped at the surfaces the CLI prints would leave the places
      // where the boundary is DESCRIBED unscanned, which is where a reserved
      // word is most likely to be reached for.
      'docs/CONFORMANCE.md',
      'docs/AGENT-AUTHORING-CAMPAIGN.md',
      'README.md',
    ]) {
      expect(speech(file), `${file} says the reserved word to a reader`).not.toMatch(/realiz|realis/i);
    }
  });
});

/**
 * L8 — verification cases: the method gate, and the two verdict words.
 *
 * These cases sit beside the golden-verdict corpus rather than inside it. A
 * golden pins the OBLIGATION rows of a run and the exit code they add up to,
 * which is exactly what the four new corpus directories here pin — that the
 * shipped example is exit 2 with every obligation in it discharged, and exit 2
 * again with `--allow-inconclusive`. What a golden cannot pin is the sentence
 * the gate prints and the difference between the two verdict words, because the
 * projection a golden is taken over does not carry a case at all. So the
 * corpus holds the exit contract and this block holds the reasoning behind it.
 */
describe('L8 — the verification-case method gate', () => {
  const EXAMPLE = 'examples/uav-isr-verification.sysml';

  async function casesOf(
    path: string,
    opts: { engine?: VerifyEngineOption; allowInconclusive?: boolean } = {},
  ): Promise<VerifyReport> {
    const model = await modelFor(path);
    return verifyModel(model, {
      engine: opts.engine ?? 'literal',
      allowInconclusive: opts.allowInconclusive === true,
      sourceText: read(path),
    });
  }

  const named = (r: VerifyReport, name: string) => {
    const c = r.cases.cases.find((x) => x.case.qualifiedName.endsWith(`::${name}`));
    if (!c) throw new Error(`${name} is not among ${r.cases.cases.map((x) => x.case.qualifiedName).join(', ')}`);
    return c;
  };

  it('judges the analyze case, and attaches the obligation rows the verdict stands on', async () => {
    const r = await casesOf(EXAMPLE);
    const c = named(r, 'enduranceAnalysis');
    expect(c.judged, 'a case declaring `analyze` is judged').toBe(true);
    expect(c.method.declared).toEqual(['analyze']);
    expect(c.method.notPerformed).toEqual([]);
    expect(c.verdict).toBe('pass');
    expect(c.code).toBeNull();
    // The rows are ON the case, not merely counted by it: a verdict a reader
    // cannot expand into the obligations it was computed from is a verdict they
    // have to take on trust.
    expect(c.obligations.map((o) => o.expression)).toEqual(['uav.endurance >= 45.0 [min]']);
    expect(c.obligations[0].claim).toBe('holds-at-values');
    // THE TWO WORDS DIVERGE HERE, and that is the point of having two. The run
    // is green because `--engine literal` was asked for by name; the file may
    // still not say `pass` about a point evaluation.
    expect(c.facet).toBe('inconclusive');
  });

  it('does not judge a `test` case at all, and says which method it was', async () => {
    const c = named(await casesOf(EXAMPLE), 'massBench');
    expect(c.judged, 'this tool performs analysis only').toBe(false);
    expect(c.method.declared).toEqual(['test']);
    expect(c.method.performed).toEqual([]);
    expect(c.code).toBe('verification/method-not-performed');
    expect(c.detail).toContain('inconclusive: method is test — this tool performs analysis only');
    expect(c.verdict).toBe('inconclusive');
    expect(c.facet).toBe('inconclusive');
    // NOT JUDGED IS NOT NOT-HOLDING. The case reads a requirement that is
    // perfectly true at the model's values, and none of that reaches the verdict.
    expect(c.verifies.map((v) => v.requirement.qualifiedName)).toEqual([
      'UAVSurveillanceVerification::MassRequirement',
    ]);
    expect(c.obligations, 'an unjudged case computes no rows').toEqual([]);
  });

  it('is exit 2 with and without --allow-inconclusive, and never exit 1', async () => {
    // The flag's scope is stated over CODES (§2): `verification/timeout` and
    // `verification/unsupported-construct`. An unperformed method is neither,
    // and there is no `--allow-unperformed` to add it.
    expect(ALLOW_INCONCLUSIVE_CODES).not.toContain('verification/method-not-performed');
    const plain = await casesOf(EXAMPLE);
    const forgiven = await casesOf(EXAMPLE, { allowInconclusive: true });
    for (const r of [plain, forgiven]) {
      // Every obligation in the file holds at its values — the exit code is 2
      // for the CASE, not for anything the engine could not decide.
      expect(r.violated).toBe(0);
      expect(r.inconclusive).toBe(0);
      expect(r.discharged).toBe(3);
      expect(r.exitCode).toBe(2);
    }
    expect(forgiven.forgiven, 'nothing was forgiven, because nothing was forgivable').toBe(0);
    expect(
      plain.diagnostics.some((d) => d.code === 'verification/method-not-performed'),
      'the gate reaches the report as a code, not only as prose',
    ).toBe(true);
    // AND THE SEVERITY IS READ FROM THE CODE, never fixed at `info`. A second
    // copy of a severity nothing compares is a copy that drifts: promote a case
    // code to `error` in the catalogue and a hardcoded line would keep emitting
    // `info` while docs/DIAGNOSTIC-CODES.md printed `error`, which is the exact
    // drift `verdictFinding`'s own docstring was written against.
    for (const d of plain.diagnostics) {
      if (!d.code?.startsWith('verification/')) continue;
      expect(d.severity, `${d.code} disagrees with VERIFICATION_ERROR_CODES`).toBe(
        VERIFICATION_ERROR_CODES.has(d.code) ? 'error' : 'info',
      );
    }
  });

  it('judges a mixed `kind = (analyze, test)` case on the analyze part and reports the rest', async () => {
    const c = named(await casesOf(EXAMPLE), 'linkQualification');
    expect(c.method.declared).toEqual(['analyze', 'test']);
    expect(c.method.performed).toEqual(['analyze']);
    expect(c.method.notPerformed).toEqual(['test']);
    expect(c.judged).toBe(true);
    expect(c.verdict).toBe('pass');
    expect(c.detail).toContain('test not performed by this tool');
    expect(c.obligations.map((o) => o.expression)).toEqual(['uav.radio.range >= 20.0 [km]']);
  });

  it('fails a case over a refuted requirement, with the witness on the row beneath it', async () => {
    const path = 'test/fixtures/verification/models/verification-case-refuted.sysml';
    const r = await casesOf(path);
    const c = named(r, 'massAnalysis');
    expect(c.judged).toBe(true);
    expect(c.verdict).toBe('fail');
    expect(c.facet).toBe('fail');
    expect(c.detail).toContain('refuted with every feature at its model value');
    expect(r.exitCode, 'a refuted case is the one thing that is exit 1').toBe(1);
    // The witness is the engine's, read off the row the case stands on — the
    // case layer never re-argues a verdict and never invents a counterexample.
    const row = r.results.find((v) => v.claim === 'refuted');
    expect(row?.bindings.map((b) => b.path)).toContain('chassis.mass');
    expect(row?.bindings.find((b) => b.path === 'chassis.mass')?.value).toBe(3000);
  });

  it('reports a case with no property to check, and the near miss that is not one', async () => {
    const r = await casesOf('test/fixtures/verification/models/verification-case-no-property.sysml');

    // NAMES NOTHING AT ALL — the plainest shape.
    const empty = named(r, 'emptyCase');
    expect(empty.judged, 'the method is fine; it is the property that is missing').toBe(true);
    expect(empty.code).toBe('verification/no-property');
    expect(empty.detail).toContain('names no requirement at all');

    // NAMES SOMETHING THAT IS NOT A REQUIREMENT. `objective { verify chassis; }`
    // never becomes a `Verify` edge at all — the mapper keeps the CLAUSE
    // reading for a name that does not resolve to a requirement — so a report
    // that walked only the edges would say this case names nothing, over a file
    // that plainly states a `verify`. It is read off containment and listed as
    // dangling, with the name as written.
    const part = named(r, 'partWatch');
    expect(part.code).toBe('verification/no-property');
    expect(part.verifies).toEqual([]);
    expect(part.dangling.map((d) => d.named)).toEqual(['chassis']);
    expect(part.detail).toContain('`chassis` is not a requirement in this model');

    // THE NEAR MISS, and it is deliberately NOT `no-property`: the case names a
    // real requirement, and that requirement's own row is the one that could
    // not be decided. There was a property to look for, and looking for it is
    // what failed — a distinction a reader acts on differently.
    const prose = named(r, 'proseWatch');
    expect(prose.judged).toBe(true);
    expect(prose.code).toBeNull();
    expect(prose.verdict).toBe('inconclusive');
    expect(prose.obligations.map((o) => o.code)).toEqual(['verification/unsupported-construct']);

    expect(r.exitCode, 'a case that checked nothing has not passed').toBe(2);

    // AND NO FLAG LOWERS THE CASE-LEVEL CODE, even where it legitimately
    // forgives the row beneath it: `verification/unsupported-construct` IS in
    // the flag's scope and is forgiven here, and the run is still exit 2
    // because two cases in the file have no property to check.
    const forgiven = await casesOf(
      'test/fixtures/verification/models/verification-case-no-property.sysml',
      { allowInconclusive: true },
    );
    expect(forgiven.forgiven, 'the unsupported-construct row is forgivable').toBe(1);
    expect(forgiven.exitCode, '`verification/no-property` is not').toBe(2);
  });

  it('finds both spellings, and says which one a traceability matrix could have seen', async () => {
    const model = await modelFor(EXAMPLE);
    const r = await casesOf(EXAMPLE);
    const found = r.cases.cases.flatMap((c) =>
      c.verifies.map((v) => `${c.case.qualifiedName} -${v.via}-> ${v.requirement.qualifiedName}`),
    );
    expect(found.sort()).toEqual([
      'UAVSurveillanceVerification::enduranceAnalysis -objective-> UAVSurveillanceVerification::EnduranceRequirement',
      'UAVSurveillanceVerification::linkQualification -objective-> UAVSurveillanceVerification::RangeRequirement',
      'UAVSurveillanceVerification::massBench -relationship-> UAVSurveillanceVerification::MassRequirement',
    ]);
    // THE CROSS-CHECK, and the reason it is not an equality. `trace --relation
    // verify` walks source→target pairs; `objective { verify R; }` builds a
    // `Verify` whose source is EMPTY, because the case OWNS it rather than
    // being one of its endpoints. So the matrix sees exactly the
    // `verify R by V;` rows and no others — one link where the file states
    // three — and that is a property of the matrix, not a defect in it.
    const matrix = traceabilityMatrix(
      model,
      'VerificationCaseUsage',
      'RequirementDefinition',
      'Verify',
    );
    expect(matrix.links.length).toBe(1);
    const relationshipRows = found.filter((f) => f.includes('-relationship->'));
    expect(
      relationshipRows.length,
      'every row the matrix can see must be a row this report found',
    ).toBe(matrix.links.length);
    const linked = matrix.links.map(
      (l) =>
        `${model.qualifiedName(l.from)} -relationship-> ${model.qualifiedName(l.to)}`,
    );
    expect(relationshipRows.sort()).toEqual(linked.sort());
  });

  it('refuses to write a verdict for a case the method gate did not judge', async () => {
    // The one throw in this module, and the charter it enforces: a verdict
    // written for a method this tool did not perform is what the gate exists to
    // prevent, so the write path may not quietly write `inconclusive` instead.
    const { model } = await loadModelText(read(EXAMPLE), { fileName: EXAMPLE });
    if (!model) throw new Error('the example produced no model');
    const r = await verifyModel(model, { engine: 'literal', sourceText: read(EXAMPLE) });
    const bench = r.cases.cases.find((c) => c.case.qualifiedName.endsWith('::massBench'));
    expect(bench).toBeDefined();
    expect(() => writeVerdict(model, bench!)).toThrow(/was not judged/);
  });

  it('record then attach puts the facet and the standard method annotation in the file', async () => {
    // The pipeline of §3.4, in process: the record carries the CLAIM, the facet
    // is derived from it, and `@VerificationCases::VerificationMethod` is
    // written onto a case that stated no method — the one standard slot this
    // lane writes, so the file says which method the verdict was reached under.
    const source = `package RecordThenAttach {
    part def Chassis { attribute mass : ISQ::MassValue = 18.5 [kg]; }
    part chassis : Chassis;
    requirement def MassLimit {
        attribute id = "R-1";
        subject chassis : Chassis;
        require constraint { chassis.mass <= 25.0 [kg] }
    }
    verification massAnalysis {
        subject chassis : Chassis;
        objective { verify MassLimit; }
    }
    satisfy MassLimit by chassis;
}
`;
    const { model } = await loadModelText(source, { fileName: 'record-then-attach.sysml' });
    if (!model) throw new Error('the probe produced no model');
    const r = await verifyModel(model, { engine: 'literal', sourceText: source });
    const c = r.cases.cases[0];
    expect(c.method.declaresMethod, 'the case states no method at all').toBe(false);
    expect(c.judged, 'a case that states no method is judged on the analyze part').toBe(true);
    attachEvidence(model, r.records);
    const written = writeVerdict(model, c);
    expect(written.written).toEqual([
      { requirement: 'RecordThenAttach::MassLimit', verdict: 'inconclusive' },
    ]);
    expect(written.methodWritten).toBe(true);
    const text = serializeModel(model);
    expect(text).toContain('attribute verdict = "inconclusive"');
    expect(text).toContain('@VerificationCases::VerificationMethod');
    expect(text).toContain('attribute kind = analyze');
    // Idempotent from here: the case now DECLARES a method, so a second write
    // does not stack a second annotation on it.
    const second = await verifyModel(model, { engine: 'literal', sourceText: text });
    expect(writeVerdict(model, second.cases.cases[0]).methodWritten).toBe(false);
  });

  it('never writes `pass` into a file over a point evaluation', async () => {
    // The laundering the plan forbids, checked at the two places it could
    // happen: the facet the case computes, and the bytes a write produces.
    const { model } = await loadModelText(read(EXAMPLE), { fileName: EXAMPLE });
    if (!model) throw new Error('the example produced no model');
    const r = await verifyModel(model, { engine: 'literal', sourceText: read(EXAMPLE) });
    for (const c of r.cases.cases) {
      expect(c.facet, `${c.case.qualifiedName} wrote a pass over a literal run`).not.toBe('pass');
      if (c.judged && c.code === null) writeVerdict(model, c);
    }
    expect(serializeModel(model)).not.toContain('attribute verdict = "pass"');
  });

  it('an unrecognised method spelling fails towards not-performed, never towards a verdict', async () => {
    const source = `package MisspeltMethod {
    part def Chassis { attribute mass : ISQ::MassValue = 18.5 [kg]; }
    part chassis : Chassis;
    requirement def MassLimit {
        subject chassis : Chassis;
        require constraint { chassis.mass <= 25.0 [kg] }
    }
    verification massAnalyse {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod { attribute kind = analyse; }
        objective { verify MassLimit; }
    }
    satisfy MassLimit by chassis;
}
`;
    const { model } = await loadModelText(source, { fileName: 'misspelt-method.sysml' });
    if (!model) throw new Error('the probe produced no model');
    const r = await verifyModel(model, { engine: 'literal', sourceText: source });
    const c = r.cases.cases[0];
    expect(c.method.declared, 'a spelling this tool cannot read is not `analyze`').toEqual([]);
    expect(c.method.unrecognised).toEqual(['analyse']);
    expect(c.judged).toBe(false);
    expect(c.code).toBe('verification/method-not-performed');
    // The word is NAMED, so a reader can see which spelling was not understood.
    expect(c.detail).toContain('analyse');
    expect(r.exitCode).toBe(2);
  });

  it('reports a `verdict` facet the file states and this run does not compute', async () => {
    const source = `package VerdictChanged {
    part def Chassis { attribute mass : ISQ::MassValue = 18.5 [kg]; }
    part chassis : Chassis;
    requirement def MassLimit {
        subject chassis : Chassis;
        require constraint { chassis.mass <= 25.0 [kg] }
        metadata RequirementMetadata { attribute verdict = "pass"; }
    }
    verification massAnalysis {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod { attribute kind = analyze; }
        objective { verify MassLimit; }
    }
    satisfy MassLimit by chassis;
}
`;
    const { model } = await loadModelText(source, { fileName: 'verdict-changed.sysml' });
    if (!model) throw new Error('the probe produced no model');
    const r = await verifyModel(model, { engine: 'literal', sourceText: source });
    const c = r.cases.cases[0];
    expect(c.changed).toEqual([
      {
        requirement: 'VerdictChanged::MassLimit',
        claimed: 'pass',
        computed: 'inconclusive',
        overstates: true,
      },
    ]);
    const finding = r.diagnostics.find((d) => d.code === 'verification/verdict-changed');
    expect(finding, 'the disagreement reaches the report').toBeDefined();
    expect(finding?.severity, 'a facet reached by inspection is not a defect').toBe('info');
    expect(finding?.message).toContain('the file claims more than this run showed');
    // NOTHING IS REWRITTEN BY REPORTING IT.
    expect(serializeModel(model)).toContain('attribute verdict = "pass"');
  });

  it('reads the method in every spelling the notation has, including an inherited one', async () => {
    // THE GATE'S FAIL DIRECTION, MEASURED. `declaresMethod: false` is the arm
    // that JUDGES, so a spelling this reader cannot see is a `test` case that
    // passes. Four of them parse clean and were invisible: the bare `metadata
    // VerificationMethod` form (the DEFINITION name lands in `declaredName`,
    // the same fact `getRequirementMetadata` reads), the typed `metadata vm :
    // …` form (the name lands on a `FeatureTyping` child and the usage's own
    // `attrs` are empty), the `attribute :>> kind` redefinition cell (no
    // declared name at all), and a method declared once on a `verification def`
    // and inherited by its usages, which is the standard factoring.
    const source = `package Spellings {
    part def Chassis { attribute mass : ISQ::MassValue = 18.5 [kg]; }
    part chassis : Chassis;
    requirement def MassLimit {
        subject chassis : Chassis;
        require constraint { chassis.mass <= 25.0 [kg] }
    }
    verification bareMetadata {
        subject chassis : Chassis;
        metadata VerificationMethod { attribute kind = test; }
        objective { verify MassLimit; }
    }
    verification typedMetadata {
        subject chassis : Chassis;
        metadata vm : VerificationCases::VerificationMethod { attribute kind = test; }
        objective { verify MassLimit; }
    }
    verification redefinedCell {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod { attribute :>> kind = test; }
        objective { verify MassLimit; }
    }
    verification def BenchDef {
        @VerificationCases::VerificationMethod { attribute kind = test; }
    }
    verification inheritedMethod : BenchDef {
        subject chassis : Chassis;
        objective { verify MassLimit; }
    }
    satisfy MassLimit by chassis;
}
`;
    const { model } = await loadModelText(source, { fileName: 'spellings.sysml' });
    if (!model) throw new Error('the probe produced no model');
    const r = await verifyModel(model, { engine: 'literal', sourceText: source });
    for (const name of ['bareMetadata', 'typedMetadata', 'redefinedCell', 'inheritedMethod']) {
      const c = named(r, name);
      expect(c.method.declared, `${name}: the method was not read`).toEqual(['test']);
      expect(c.judged, `${name} was judged over a method this tool does not perform`).toBe(false);
      expect(c.code).toBe('verification/method-not-performed');
    }
    expect(r.exitCode).toBe(2);
    // AND AN ANNOTATION THIS TOOL DOES NOT UNDERSTAND IS NOT A METHOD. A case
    // may carry any metadata at all, and a gate that shut on every unread
    // annotation would refuse to judge models that say nothing about a method.
    const quiet = `package QuietAnnotation {
    part def Chassis { attribute mass : ISQ::MassValue = 18.5 [kg]; }
    part chassis : Chassis;
    requirement def MassLimit {
        subject chassis : Chassis;
        require constraint { chassis.mass <= 25.0 [kg] }
    }
    verification massAnalysis {
        subject chassis : Chassis;
        @Nonsense { attribute note = "not a method"; }
        objective { verify MassLimit; }
    }
    satisfy MassLimit by chassis;
}
`;
    const quietModel = (await loadModelText(quiet, { fileName: 'quiet.sysml' })).model;
    if (!quietModel) throw new Error('the probe produced no model');
    const q = await verifyModel(quietModel, { engine: 'literal', sourceText: quiet });
    expect(q.cases.cases[0].method.declaresMethod).toBe(false);
    expect(q.cases.cases[0].judged).toBe(true);
  });

  it('reads a case usage’s `verify` targets through the definition it specializes', async () => {
    // THE MIRROR OF THE GATE BUG, and it is a FALSE diagnostic rather than a
    // false pass: a def/usage model whose objective lives on the definition
    // reported `verification/no-property` — "it names no requirement at all" —
    // over a file that plainly states one, and forced the run to exit 2.
    const source = `package DefUsageAnalyze {
    part def Chassis { attribute mass : ISQ::MassValue = 18.5 [kg]; }
    part chassis : Chassis;
    requirement def MassLimit {
        subject chassis : Chassis;
        require constraint { chassis.mass <= 25.0 [kg] }
    }
    verification def MassCase {
        @VerificationCases::VerificationMethod { attribute kind = analyze; }
        objective { verify MassLimit; }
    }
    verification massAnalysis : MassCase { subject chassis : Chassis; }
    satisfy MassLimit by chassis;
}
`;
    const { model } = await loadModelText(source, { fileName: 'def-usage.sysml' });
    if (!model) throw new Error('the probe produced no model');
    const r = await verifyModel(model, { engine: 'literal', sourceText: source });
    const usage = named(r, 'massAnalysis');
    expect(usage.code, 'the usage inherits the objective its definition states').toBeNull();
    expect(usage.method.declared).toEqual(['analyze']);
    expect(usage.verifies.map((v) => v.requirement.qualifiedName)).toEqual([
      'DefUsageAnalyze::MassLimit',
    ]);
    expect(usage.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
  });

  it('judges a case that states its property directly, rather than calling it propertyless', async () => {
    // `objective { require constraint { … } }` is the spelling `contractsOf`
    // reads as a contract whose subject is the CASE, so the obligation row it
    // produces is filed under the case rather than under a requirement.
    // Ignoring those rows printed two rows about one element that contradicted
    // each other: the case's own obligation, and, two lines below it, "it names
    // no requirement at all".
    const source = `package ObjConstraint {
    part def Chassis { attribute mass : ISQ::MassValue = 18.5 [kg]; }
    part chassis : Chassis;
    verification massCheck {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod { attribute kind = analyze; }
        objective { require constraint { chassis.mass <= 25.0 [kg] } }
    }
}
`;
    const { model } = await loadModelText(source, { fileName: 'obj-constraint.sysml' });
    if (!model) throw new Error('the probe produced no model');
    const r = await verifyModel(model, { engine: 'literal', sourceText: source });
    const c = named(r, 'massCheck');
    expect(r.results.length, 'the case owns an obligation row').toBe(1);
    expect(c.code, 'a case with its own obligation row is not propertyless').toBeNull();
    expect(c.obligations.length).toBe(1);
    expect(c.obligations[0].expression).toBe('chassis.mass <= 25.0 [kg]');
    // Nothing to write a facet onto: the property is the case's own, and the
    // facet lives on a requirement.
    expect(writeVerdict(model, c).written).toEqual([]);
  });

  it('a `#prose` requirement leaves its case propertyless, and the catalogue says so', async () => {
    // The OTHER half of the `no-property` sentence, and the reachable one. An
    // UNTAGGED prose requirement raises a row of its own
    // (`verification/unsupported-construct`), so its case is judged; a `#prose`
    // tag says the requirement is deliberately informal and it contributes no
    // row at all, so a case that verifies nothing else has nothing to check.
    const source = `package ProseTagged {
    part def Chassis { attribute mass : ISQ::MassValue = 18.5 [kg]; }
    part chassis : Chassis;
    #prose requirement def Appearance {
        doc /* The chassis shall present a finished appearance. */
        subject chassis : Chassis;
    }
    verification proseWatch {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod { attribute kind = analyze; }
        objective { verify Appearance; }
    }
    satisfy Appearance by chassis;
}
`;
    const { model } = await loadModelText(source, { fileName: 'prose-tagged.sysml' });
    if (!model) throw new Error('the probe produced no model');
    const r = await verifyModel(model, { engine: 'literal', sourceText: source });
    const c = named(r, 'proseWatch');
    expect(r.results, 'a `#prose` requirement states no obligation').toEqual([]);
    expect(c.judged).toBe(true);
    expect(c.code).toBe('verification/no-property');
    expect(c.detail).toContain('state no formal clause this lane could gather');
    expect(r.exitCode).toBe(2);
    // Nothing is written onto a requirement this run said nothing about.
    expect(writeVerdict(model, c).written).toEqual([]);
  });

  it('rolls the verdict facet up per requirement, never per case', async () => {
    // THE FACET IS ABOUT ONE REQUIREMENT. Stamping the case's word onto each of
    // the requirements it verifies made the file contradict itself: `fail` on a
    // requirement this same run showed holding, right beside an `@Evidence`
    // carrier saying `holds-at-values`.
    const source = `package TwoReqs {
    part def Chassis {
        attribute mass : ISQ::MassValue = 3000.0 [kg];
        attribute width : ISQ::LengthValue = 1.5 [m];
    }
    part chassis : Chassis;
    requirement def MassLimit {
        subject chassis : Chassis;
        require constraint { chassis.mass <= 2000.0 [kg] }
    }
    requirement def WidthLimit {
        subject chassis : Chassis;
        require constraint { chassis.width <= 2.0 [m] }
    }
    verification bothAnalysis {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod { attribute kind = analyze; }
        objective { verify MassLimit; verify WidthLimit; }
    }
    satisfy MassLimit by chassis;
    satisfy WidthLimit by chassis;
}
`;
    const { model } = await loadModelText(source, { fileName: 'two-reqs.sysml' });
    if (!model) throw new Error('the probe produced no model');
    const r = await verifyModel(model, { engine: 'literal', sourceText: source });
    const c = named(r, 'bothAnalysis');
    expect(c.verdict, 'one refuted obligation fails the case').toBe('fail');
    expect(c.facet).toBe('fail');
    // …and the per-requirement roll-up disagrees with it, correctly.
    expect(c.facets).toEqual([
      { requirementId: expect.any(String), requirement: 'TwoReqs::MassLimit', facet: 'fail', rows: 1 },
      {
        requirementId: expect.any(String),
        requirement: 'TwoReqs::WidthLimit',
        facet: 'inconclusive',
        rows: 1,
      },
    ]);
    expect(writeVerdict(model, c).written).toEqual([
      { requirement: 'TwoReqs::MassLimit', verdict: 'fail' },
      { requirement: 'TwoReqs::WidthLimit', verdict: 'inconclusive' },
    ]);
  });

  it('writes nothing onto a verified requirement this run produced no row for', async () => {
    // A record set narrowed by `--case` covers one case's requirements and not
    // another's; rolling every case up from whatever rows are present then
    // wrote `pass` into the file for a requirement the model REFUTES. A
    // requirement with no row of its own is skipped, by name, with the reason.
    const source = `package CrossCase {
    part def Chassis {
        attribute mass : ISQ::MassValue = 18.5 [kg];
        attribute width : ISQ::LengthValue = 5.0 [m];
    }
    part chassis : Chassis;
    requirement def MassLimit {
        subject chassis : Chassis;
        require constraint { chassis.mass <= 25.0 [kg] }
    }
    requirement def WidthLimit {
        subject chassis : Chassis;
        require constraint { chassis.width <= 2.0 [m] }
    }
    verification massOnly {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod { attribute kind = analyze; }
        objective { verify MassLimit; }
    }
    verification wholeVehicle {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod { attribute kind = analyze; }
        objective { verify MassLimit; verify WidthLimit; }
    }
    satisfy MassLimit by chassis;
    satisfy WidthLimit by chassis;
}
`;
    const { model } = await loadModelText(source, { fileName: 'cross-case.sysml' });
    if (!model) throw new Error('the probe produced no model');
    const mass = model
      .all()
      .find((el) => model.qualifiedName(el.id) === 'CrossCase::massOnly');
    expect(mass).toBeDefined();
    // The narrowed run: only `MassLimit` is judged, and `wholeVehicle` is rolled
    // up from those rows alone.
    const narrowed = await verifyModel(model, {
      engine: 'literal',
      sourceText: source,
      caseId: mass!.id,
    });
    expect(narrowed.results.length).toBe(1);
    const whole = runVerificationCases(model, { judged: narrowed.results }).cases.find((c) =>
      c.case.qualifiedName.endsWith('::wholeVehicle'),
    );
    expect(whole).toBeDefined();
    expect(whole!.facets.map((f) => [f.requirement, f.facet])).toEqual([
      ['CrossCase::MassLimit', 'inconclusive'],
      ['CrossCase::WidthLimit', null],
    ]);
    const w = writeVerdict(model, whole!);
    expect(w.written.map((x) => x.requirement)).toEqual(['CrossCase::MassLimit']);
    expect(w.skipped.map((x) => x.requirement)).toEqual(['CrossCase::WidthLimit']);
    expect(w.skipped[0].reason).toContain('produced no obligation row for it');
    expect(serializeModel(model), 'a facet reached a requirement nothing checked').not.toContain(
      'attribute verdict = "pass"',
    );
  });

  it('the method annotation this lane writes is out of the model digest, and comes off again', async () => {
    // WHY IT MUST BE OUT: the annotation goes INTO the model the records were
    // taken over, so `evidence-attach` invalidated inside one command the
    // evidence it had just attached — the saved file was born
    // `validation/stale-evidence`. WHY THE EXCLUSION IS SAFE: a case that
    // declares no method is judged on the analyze part, so the annotation and
    // its absence are gate-equivalent and it can change no verdict. WHY IT IS
    // DRAWN THIS TIGHTLY: change the kind and the shape stops matching, so an
    // author's own edit of a load-bearing method moves the digest again.
    const source = `package DigestProbe {
    part def Chassis { attribute mass : ISQ::MassValue = 18.5 [kg]; }
    part chassis : Chassis;
    requirement def MassLimit {
        subject chassis : Chassis;
        require constraint { chassis.mass <= 25.0 [kg] }
    }
    verification massAnalysis {
        subject chassis : Chassis;
        objective { verify MassLimit; }
    }
    satisfy MassLimit by chassis;
}
`;
    const { model } = await loadModelText(source, { fileName: 'digest-probe.sysml' });
    if (!model) throw new Error('the probe produced no model');
    const before = modelVersionOf(model).graph;
    const r = await verifyModel(model, { engine: 'literal', sourceText: source });
    attachEvidence(model, r.records);
    writeVerdict(model, r.cases.cases[0]);
    expect(modelVersionOf(model).graph, 'the attach moved the model it was recorded over').toBe(
      before,
    );
    expect(evidenceStatus(model).stale, 'the attach wrote a file it calls stale').toBe(0);
    expect(evidenceStatus(model).current).toBe(1);

    // A METHOD THAT SAYS SOMETHING ELSE IS THE AUTHOR'S, and it is in the hash.
    const other = `package DigestProbe {
    part def Chassis { attribute mass : ISQ::MassValue = 18.5 [kg]; }
    part chassis : Chassis;
    requirement def MassLimit {
        subject chassis : Chassis;
        require constraint { chassis.mass <= 25.0 [kg] }
    }
    verification massAnalysis {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod { attribute kind = test; }
        objective { verify MassLimit; }
    }
    satisfy MassLimit by chassis;
}
`;
    const edited = (await loadModelText(other, { fileName: 'digest-probe.sysml' })).model;
    if (!edited) throw new Error('the probe produced no model');
    expect(
      modelVersionOf(edited).graph,
      'a method the gate reads was excluded from the digest',
    ).not.toBe(before);

    // AND DETACH IS AN INVERSE. A tool-authored sentence about the METHOD that
    // no command removes would outlive every claim it was written beside.
    const detached = detachEvidence(model);
    expect(detached.methodAnnotationsRemoved).toEqual(['DigestProbe::massAnalysis']);
    // Asserted on the graph rather than on the text: the bundled library
    // DEFINES `VerificationMethod`, so a serialization of the whole model
    // contains the word whatever the reader's own file says.
    const caseEl = model.all().find((el) => model.qualifiedName(el.id) === 'DigestProbe::massAnalysis');
    expect(caseEl).toBeDefined();
    expect(model.children(caseEl!.id).filter((c) => c.eClass === 'MetadataUsage')).toEqual([]);
    expect(serializeModel(model)).not.toContain('attribute verdict = ');
  });

  it('leaves a model with no verification case exactly as it decided it before', async () => {
    // The regression this whole layer could have been: `cases.exitCode` is 0
    // over an empty list, so the two shipped examples are decided by their
    // obligations and by nothing else.
    for (const path of ['examples/uav-isr.sysml', 'examples/vehicle.sysml']) {
      const r = await casesOf(path);
      expect(r.cases.cases, `${path} declares no verification case`).toEqual([]);
      expect(r.cases.exitCode).toBe(0);
      expect(r.exitCode).toBe(0);
    }
  });
});

/**
 * L8 — `refine --via composition`: an architecture, rather than a requirement.
 *
 * A SUITE-LEVEL CASE for the same reason the consistency block above is one:
 * `test/fixtures/verification/<case>/expected.json` is a projection of a
 * `VerifyReport`, and a refinement run is a different report about a different
 * question. The known-answer models live beside the others in `models/` and the
 * properties are asserted here.
 *
 * WHAT EACH CASE PINS is a sentence from §3.6's MUST-NEVER list turned into a
 * property. Two of them are the plan's own named counter-examples and are the
 * reason the checker is shaped the way it is:
 *
 *  - **the soundness case** — A₁ = G₂ = p, A₂ = G₁ = p against ⟨true, p⟩. The
 *    bare-guarantee obligation is `p ∧ p ⊨ p`, provable by inspection; the
 *    normal-form one is `⊤ ⊨ p` and must be REFUTED, or mutual support buys a
 *    verdict an implementation with `p` false would break.
 *  - **the vacuity case** — ⟨true, x > 10⟩ and ⟨true, x < 5⟩ over one bind
 *    class against ⟨true, x > 1000000⟩. The antecedent of (3) is unsatisfiable,
 *    so (3) holds vacuously; without step (0) the tool prints "obligation (3)
 *    proved" over an architecture whose components cannot coexist.
 *
 * The rest pin γ: a `flow` discharges a downstream assumption on its own, and a
 * bare `connect` encodes NOTHING and is listed rather than silently folded in.
 */
describe('L8 — refine: Cimatti’s obligations, in normal form, over the equalities the model states', () => {
  const BUDGET = 'examples/uav-power-budget.sysml';
  const MUTUAL = 'test/fixtures/verification/models/refinement-mutual-support.sysml';
  const SIBLINGS = 'test/fixtures/verification/models/refinement-contradictory-siblings.sysml';
  const BARE = 'test/fixtures/verification/models/refinement-bare-connection.sysml';
  const MIXED = 'test/fixtures/verification/models/refinement-mixed-vacuity.sysml';
  const REFUSED = 'test/fixtures/verification/models/refinement-refused-clause.sysml';
  const LEVELS = 'test/fixtures/verification/models/refinement-three-level.sysml';
  const SHORTFALL = 'test/fixtures/verification/models/refinement-sibling-shortfall.sysml';
  const ALLOCATED = 'test/fixtures/verification/models/refinement-allocation.sysml';

  /** One run over one model, with the flags a person would type. */
  async function refine(
    path: string,
    opts: Parameters<typeof refinementReport>[1] = {},
    text?: string,
  ): Promise<Awaited<ReturnType<typeof refinementReport>>> {
    const source = text ?? read(path);
    const { model } = await loadModelText(source, { fileName: path });
    if (!model) throw new Error(`${path} produced no model`);
    return refinementReport(model, { ...opts, sourceText: source });
  }

  withZ3('proves obligation (3) on the power-budget example, over bind and flow', async () => {
    const r = await refine(BUDGET);
    expect(r.exitCode, 'the shipped decomposition stopped refining').toBe(0);
    expect(r.refined).toBe(1);
    expect(r.notRefined + r.vacuous + r.inconclusive).toBe(0);
    const [group] = r.groups;
    expect(group.outcome).toBe('refined');
    expect(group.code).toBeNull();
    // γ IS WHAT THE MODEL STATES: two bindings and one item flow, and the one
    // bare connection listed rather than folded in.
    expect(r.bindEqualities).toBe(2);
    expect(r.itemFlows).toBe(1);
    expect(r.connectionEqualities, 'a bare connect was read as an equality without the flag').toBe(0);
    expect(r.notEncoded).toBe(1);
    expect(group.notEncoded[0].hint).toBe(CONNECTION_HINT);
    // Obligation (3), plus one (4) per component. The battery assumes nothing,
    // so its (4) is empty rather than proved — an empty obligation is not a
    // discharged one.
    const three = group.obligations.find((o) => o.kind === 'composition')!;
    expect(three.outcome).toBe('proved');
    expect(three.detail).toContain('negation unsat');
    expect(three.detail).toContain('nf(C) = ¬A ∨ G');
    const four = group.obligations.filter((o) => o.kind === 'assumption');
    expect(four.map((o) => o.outcome).sort()).toEqual([
      'no-assumption',
      'proved',
      'proved',
      'proved',
    ]);
    // MUST NEVER claim anything temporal.
    expect(group.detail).toContain('Nothing here is about ordering or time');
    for (const o of group.obligations) {
      expect(o.detail, 'a verdict line mentioned time').not.toMatch(/\b(before|after|eventually|until)\b/);
    }
  });

  withZ3('refutes obligation (3) when a component guarantee is removed, and names that part', async () => {
    // The propulsion unit stops promising anything, so `nf(C_prop)` is ⊤ and
    // its draw is unbounded — the sum can exceed what the pack delivers.
    const text = read(BUDGET).replace('        require constraint { p.draw <= 600.0 [W] }\n', '');
    expect(text, 'the mutation matched nothing').not.toBe(read(BUDGET));
    const r = await refine(BUDGET, {}, text);
    expect(r.exitCode, 'a broken decomposition went green').toBe(1);
    expect(r.notRefined).toBe(1);
    const [group] = r.groups;
    expect(group.outcome).toBe('not-refined');
    expect(group.code).toBe(REFINEMENT_FAILED_CODE);
    const three = group.obligations.find((o) => o.kind === 'composition')!;
    expect(three.outcome).toBe('refuted');
    // A WITNESS THAT NAMES THE PART. A refutation with no counterexample is an
    // assertion, and one whose counterexample names nothing is not actionable.
    expect(three.witnessConfirmed, 'a counterexample was printed unconfirmed').toBe(true);
    expect(three.witness.map((w) => w.symbol)).toContain('UAVPowerBudget::PropulsionUnit::draw');
    expect(three.detail).toContain('witness');
  });

  withZ3('refutes a component’s own (4) when its assumption outruns what its siblings promise', async () => {
    // The flight controller now needs 30 V; the battery promises 22.
    const text = read(BUDGET).replace(
      'assume constraint { fc.supplyVoltage >= 20.0 [V] }',
      'assume constraint { fc.supplyVoltage >= 30.0 [V] }',
    );
    expect(text, 'the mutation matched nothing').not.toBe(read(BUDGET));
    const r = await refine(BUDGET, {}, text);
    expect(r.exitCode).toBe(1);
    const [group] = r.groups;
    const four = group.obligations.find(
      (o) => o.kind === 'assumption' && o.component?.qualifiedName === 'UAVPowerBudget::ComputerDraw',
    )!;
    expect(four.outcome).toBe('refuted');
    // NOT the unconnected code: the quantity IS connected — two bind edges
    // reach it — so this is a design problem and not a wiring one, and the two
    // have different fixes.
    expect(four.code).toBe(REFINEMENT_FAILED_CODE);
    expect(four.detail).toContain('its siblings do not guarantee what it assumes');
    expect(four.witnessConfirmed).toBe(true);
    // The siblings' own assumptions are still discharged: 22 V clears 20 V.
    const radio = group.obligations.find(
      (o) => o.component?.qualifiedName === 'UAVPowerBudget::RadioDraw',
    )!;
    expect(radio.outcome).toBe('proved');
  });

  withZ3('the soundness case: mutual support passes bare guarantees and fails normal form', async () => {
    const r = await refine(MUTUAL);
    const [group] = r.groups;
    // The bare-guarantee obligation here is `G₁ ∧ G₂ ⊨ G`, i.e. `p ∧ p ⊨ p`,
    // where every conjunct IS the goal — provable by inspection, and provable
    // by any checker that asserts guarantees rather than normal forms. This one
    // asserts `nf(Cᵢ) = ¬p ∨ p = ⊤`, so the obligation is `⊤ ⊨ p`.
    expect(group.outcome, 'mutual support bought a refinement verdict').toBe('not-refined');
    const three = group.obligations.find((o) => o.kind === 'composition')!;
    expect(three.outcome).toBe('refuted');
    expect(three.witnessConfirmed).toBe(true);
    // The counterexample is exactly the implementation the plan names: `p`
    // false, both component contracts satisfied, the system guarantee broken.
    const signal = three.witness.find((w) => w.symbol === 'RefinementMutualSupport::Alpha::signal')!;
    expect(signal, 'the witness no longer names the quantity p is about').toBeDefined();
    expect(Number(signal.value), 'the witness satisfies the system guarantee it is meant to break').toBeLessThan(1);
    expect(r.exitCode).toBe(1);
    // Step (0) still answered SAT — this is a refutation, not a vacuity, and
    // the two must not be reported as each other.
    expect(group.code).toBe(REFINEMENT_FAILED_CODE);
    expect(r.vacuous).toBe(0);
  });

  withZ3('the vacuity case: contradictory siblings are vacuous, never refined', async () => {
    const r = await refine(SIBLINGS);
    expect(r.vacuous).toBe(1);
    expect(r.refined, 'a contradiction proved an architecture').toBe(0);
    const [group] = r.groups;
    expect(group.outcome).toBe('vacuous');
    expect(group.code).toBe(CONTRACT_SET_VACUOUS_CODE);
    expect(group.detail).toContain('cannot hold together');
    expect(group.detail, 'a vacuity was printed as a refinement').not.toContain('refines:');
    // The core names the statements that collide, so the row is actionable.
    expect(group.vacuityCore.length, 'a vacuity with no core names nothing').toBeGreaterThan(1);
    // NOT ONE OBLIGATION IS CLAIMED. Step (0) stops before (3) and (4), which
    // is the whole point: `⊤` entails both of them under a contradiction.
    expect(group.obligations, 'an obligation was judged under an unsatisfiable antecedent').toEqual([]);
    // Vacuity is inconclusive in this lane, exits 2, and no flag lowers it.
    expect(r.exitCode).toBe(2);
    const forgiven = await refine(SIBLINGS, { allowInconclusive: true });
    expect(forgiven.exitCode, '--allow-inconclusive laundered a vacuity').toBe(2);
    expect(forgiven.forgiven).toBe(0);
  });

  withZ3('a vacuity beside a proof is still exit 2, and no flag lowers it', async () => {
    // THE ARITHMETIC THIS CASE EXISTS FOR. A vacuous decomposition has its own
    // count and is NOT one of the `inconclusive` ones, so an exit rule that
    // only subtracted the forgiven inconclusives from the undecided total would
    // return 0 here — laundering the vacuity behind the refinement beside it.
    // With one group of each, the first rule ("nothing decided") no longer
    // fires, which is what makes this the shape that catches it.
    const r = await refine(MIXED);
    expect(r.refined).toBe(1);
    expect(r.vacuous).toBe(1);
    expect(r.inconclusive).toBe(0);
    expect(r.exitCode, 'a vacuity went green behind a proof beside it').toBe(2);
    const forgiven = await refine(MIXED, { allowInconclusive: true });
    expect(forgiven.exitCode, '--allow-inconclusive laundered a vacuity').toBe(2);
    expect(forgiven.forgiven).toBe(0);
  });

  withZ3('a `flow` discharges the downstream assumption with no opt-in at all', async () => {
    // The radio's bus voltage arrives over the item flow and over nothing else:
    // no bind edge touches `DataLink::supplyVoltage`. If γ dropped item flows,
    // this row would read "not discharged: witness supplyVoltage = 0" — the
    // false negative §3.6's worked example is about.
    const r = await refine(BUDGET);
    expect(r.connectionsAsEqualities, 'the opt-in was on and the case proves nothing').toBe(false);
    const [group] = r.groups;
    const flows = group.gamma.filter((g) => g.kind === 'flow');
    expect(flows).toHaveLength(1);
    expect(flows[0].expression).toContain('UAVPowerBudget::DataLink::supplyVoltage');
    const radio = group.obligations.find(
      (o) => o.component?.qualifiedName === 'UAVPowerBudget::RadioDraw',
    )!;
    expect(radio.outcome, 'the item flow was not encoded').toBe('proved');
  });

  withZ3('a bare `connect` encodes nothing, lists the connection, and never passes silently', async () => {
    const r = await refine(BARE);
    expect(r.bindEqualities + r.itemFlows + r.connectionEqualities, 'a bare connect became γ').toBe(0);
    expect(r.notEncoded).toBe(1);
    expect(r.exitCode, 'a model with no encoded equality went green').toBe(1);
    const [group] = r.groups;
    expect(group.gamma).toEqual([]);
    expect(group.notEncoded[0].hint).toBe(CONNECTION_HINT);
    const load = group.obligations.find(
      (o) => o.component?.qualifiedName === 'RefinementBareConnection::LoadDraw',
    )!;
    // The STRUCTURAL code, not the design one: nothing connects the quantity.
    expect(load.outcome).toBe('refuted');
    expect(load.code).toBe(UNCONNECTED_ASSUMPTION_CODE);
    expect(load.detail).toContain('RefinementBareConnection::Load::supplyVoltage');

    // And under the opt-in the same model refines — with the fact printed on
    // every verdict line, because it changes what the verdict claims.
    const opted = await refine(BARE, { connectionsAsEqualities: true });
    expect(opted.exitCode).toBe(0);
    expect(opted.connectionEqualities).toBe(1);
    expect(opted.notEncoded).toBe(0);
    const [optedGroup] = opted.groups;
    expect(optedGroup.outcome).toBe('refined');
    expect(optedGroup.detail).toContain(CONNECTIONS_AS_EQUALITIES_NOTE);
    for (const o of optedGroup.obligations) {
      expect(o.detail, 'a verdict line hid the opt-in').toContain(CONNECTIONS_AS_EQUALITIES_NOTE);
    }
  });

  it('decides nothing with no solver, and still counts the model', async () => {
    // The honest-absence path. There is no point-evaluation counterpart here at
    // all: a refinement obligation is a claim about every implementation the
    // contracts admit, not about the values in the file.
    const before = process.env.SYSPROSE_NO_Z3;
    process.env.SYSPROSE_NO_Z3 = '1';
    try {
      const r = await refine(BUDGET);
      expect(r.toolAbsent).toBe(true);
      expect(r.exitCode).toBe(2);
      expect(r.refined + r.notRefined).toBe(0);
      expect(r.inconclusive).toBe(1);
      // THE CENSUS IS STILL TRUE — an absent solver must not read as a model
      // with no architecture in it.
      expect(r.contracts).toBe(5);
      expect(r.groups[0].components).toHaveLength(4);
      expect(r.bindEqualities).toBe(2);
      expect(r.groups[0].code).toBe('verification/tool-absent');
      const forgiven = await refine(BUDGET, { allowInconclusive: true });
      expect(forgiven.exitCode, '--allow-inconclusive lowered an absent solver').toBe(2);
    } finally {
      if (before === undefined) delete process.env.SYSPROSE_NO_Z3;
      else process.env.SYSPROSE_NO_Z3 = before;
    }
  }, 120_000);


  withZ3('a refused clause on the SYSTEM contract stands the whole decomposition down', async () => {
    // THE GOAL DIRECTION. `nf(C)` with a conjunct missing is WEAKER, and a
    // weaker goal is easier to entail — the one direction in which a relation
    // the tool could not read buys the verdict rather than costing it. So
    // nothing at all is claimed: not one obligation row, and the code says why.
    const r = await refine(REFUSED);
    const group = r.groups.find(
      (g) => g.system.qualifiedName === 'RefinementRefusedClause::SystemSideTop',
    )!;
    expect(group.outcome).toBe('inconclusive');
    expect(group.code).toBe(REFINEMENT_UNDECIDED_CODE);
    expect(group.obligations, 'an obligation was judged against a goal the file did not state').toEqual([]);
    expect(group.detail).toContain('refused 1 clause(s) of the system contract');
    expect(group.refused.map((x) => x.reason)).toContain('unsupported-operator');
    expect(r.exitCode).toBe(2);
    const forgiven = await refine(REFUSED, { allowInconclusive: true });
    expect(forgiven.exitCode, '--allow-inconclusive lowered a refused clause').toBe(2);
    expect(forgiven.forgiven).toBe(0);
  });

  withZ3('a refused `assume` on a COMPONENT is never read as "promises unconditionally"', async () => {
    // THE PREMISE DIRECTION, and the one that used to go green. Dropping a
    // conjunct of `A` STRENGTHENS `nf(C′) = ¬A ∨ G` — `¬(a₁ ∧ a₂)` is
    // `¬a₁ ∨ ¬a₂` — and with the only `assume` refused the normal form
    // collapses to a bare `G`. Here `ComponentSideTop` is provable from the bus
    // contract alone, so a build that asserted that collapsed form would report
    // every row proved or empty, say `refined`, and exit 0 on an axiom this
    // file does not contain.
    const r = await refine(REFUSED);
    const group = r.groups.find(
      (g) => g.system.qualifiedName === 'RefinementRefusedClause::ComponentSideTop',
    )!;
    expect(group.outcome, 'a refused assumption bought a refinement verdict').toBe('inconclusive');
    expect(group.code).toBe(REFINEMENT_UNDECIDED_CODE);
    const motor = group.obligations.find(
      (o) => o.component?.qualifiedName === 'RefinementRefusedClause::ComponentSideMotor',
    )!;
    expect(motor.outcome).toBe('undecided');
    expect(motor.code).toBe(REFINEMENT_UNDECIDED_CODE);
    // The sentence that must never be printed over a contract that DOES state
    // an assumption, because it is the axiom the collapse would have asserted.
    expect(motor.detail, 'a refused assumption was published as no assumption').not.toContain(
      'promises its guarantee unconditionally',
    );
    // Its normal form was not asserted either: obligation (3) is proved over
    // the ONE sub-contract that contributed a premise, not over two.
    const three = group.obligations.find((o) => o.kind === 'composition')!;
    expect(three.outcome).toBe('proved');
    expect(three.detail).toContain('over 1 sub-contract(s)');
    expect(r.exitCode).toBe(2);
  });

  withZ3('decomposes a three-level tree level by level, across the part TYPE', async () => {
    // `satisfy CellCharge by Pack::cell` names a usage whose OWNER is the part
    // DEFINITION `Pack`, and no contract is satisfied by `Pack`. Under a walk
    // that climbed `ownerId` alone the two leaf contracts joined no group at
    // all — silently, with the run still exiting 0 over the level above them.
    const r = await refine(LEVELS);
    expect(r.groups).toHaveLength(2);
    expect(r.refined).toBe(2);
    expect(r.exitCode).toBe(0);
    const inner = r.groups.find(
      (g) => g.system.qualifiedName === 'RefinementThreeLevel::PackBudget',
    )!;
    expect(
      inner.components.map((c) => c.contract.qualifiedName).sort(),
      'the leaf contracts joined no decomposition',
    ).toEqual(['RefinementThreeLevel::CellCharge', 'RefinementThreeLevel::HeaterCharge']);
    // Every contract with a satisfier is in some group: nothing vanished.
    const judged = new Set(
      r.groups.flatMap((g) => [g.system.qualifiedName, ...g.components.map((c) => c.contract.qualifiedName)]),
    );
    expect(judged.size).toBe(4);
  });

  withZ3('counts and names the connections of ITS OWN level, not the file’s', async () => {
    // γ is trimmed per decomposition and so is its refused half. `mount` is
    // wiring of the vehicle level and `cellTie` of the pack level; a group that
    // printed the file's total would state a figure about the file dressed as a
    // figure about the answer, and point a reader at another group's connector.
    const r = await refine(LEVELS);
    expect(r.notEncoded, 'the run-level census is still the whole file').toBe(2);
    const outer = r.groups.find(
      (g) => g.system.qualifiedName === 'RefinementThreeLevel::VehicleBudget',
    )!;
    const inner = r.groups.find(
      (g) => g.system.qualifiedName === 'RefinementThreeLevel::PackBudget',
    )!;
    expect(outer.notEncoded.map((c) => c.qualifiedName)).toEqual(['RefinementThreeLevel::Vehicle::mount']);
    expect(inner.notEncoded.map((c) => c.qualifiedName)).toEqual(['RefinementThreeLevel::Pack::cellTie']);
    for (const g of [outer, inner]) {
      expect(g.detail).toContain('1 connection(s) not encoded as equalities');
    }
  });

  withZ3('separates a sibling shortfall from a missing wire, and confirms both witnesses', async () => {
    const r = await refine(SHORTFALL);
    const [group] = r.groups;
    const node = group.obligations.find(
      (o) => o.component?.qualifiedName === 'RefinementSiblingShortfall::NodeAssumes',
    )!;
    // A DESIGN shortfall: the sibling constrains the very same quantity, just
    // not enough, so no `bind` can repair it and the wiring hint would be
    // advice a reader cannot act on.
    expect(node.outcome).toBe('refuted');
    expect(node.code, 'a design shortfall was filed as a wiring problem').toBe(REFINEMENT_FAILED_CODE);
    expect(node.detail).toContain('its siblings do not guarantee what it assumes');
    // THE WITNESS GATE, on the shape that used to defeat it: the solver
    // satisfies `LoneAssumes`'s premise `¬A ∨ G` through `¬A`, so the symbols
    // of that `G` are absent from the model it returns. Reading the guarantee
    // first and calling the point unreadable degraded this genuine refutation
    // to `verification/not-evaluable`, which `--allow-inconclusive` does not
    // lower.
    expect(node.witnessConfirmed, 'a genuine counterexample was rejected by the witness gate').toBe(true);
    expect(node.witness.map((w) => w.symbol)).not.toContain('RefinementSiblingShortfall::Isolated::delivered');
    // And the converse: a quantity nothing in the group and no equality
    // mentions IS the wiring problem.
    const lone = group.obligations.find(
      (o) => o.component?.qualifiedName === 'RefinementSiblingShortfall::LoneAssumes',
    )!;
    expect(lone.outcome).toBe('refuted');
    expect(lone.code).toBe(UNCONNECTED_ASSUMPTION_CODE);
    expect(lone.detail).toContain('RefinementSiblingShortfall::Isolated::spare');
    expect(r.exitCode).toBe(1);
  });

  withZ3('an `allocate` is not a `connect`, and the opt-in does not read it', async () => {
    // The connector walk this lane shares with value propagation holds
    // `Allocation` too. The opt-in does not: its own sentence, printed on every
    // verdict line, is about bare `connect` edges, and reading an allocation as
    // `target == source` would assert an equality nobody wrote and then say
    // `connect` about a file that contains none.
    for (const connectionsAsEqualities of [false, true]) {
      const r = await refine(ALLOCATED, { connectionsAsEqualities });
      expect(r.connectionEqualities, 'an allocation became a value equality').toBe(0);
      expect(r.notEncoded).toBe(1);
      expect(r.exitCode, 'an allocation bought a refinement verdict').toBe(1);
      const [group] = r.groups;
      expect(group.notEncoded[0].eClass).toBe('Allocation');
      expect(group.notEncoded[0].hint).toContain('an allocation maps one element onto another');
      const load = group.obligations.find(
        (o) => o.component?.qualifiedName === 'RefinementAllocation::LoadDraw',
      )!;
      expect(load.outcome).toBe('refuted');
      if (connectionsAsEqualities) {
        // The opt-in does not empty the list, so the verdict line must not read
        // as though the whole wiring had been taken in.
        expect(group.detail).toContain(CONNECTIONS_AS_EQUALITIES_NOTE);
        expect(group.detail).toContain('still not encoded as equalities');
      }
    }
  });

  withZ3('states no decomposition where the model states none, and is not green for it', async () => {
    // `examples/uav-isr.sysml` has two requirements, both satisfied by the same
    // part, so there is no decomposition to check — and exit 0 would say every
    // architecture in the file was shown to refine.
    const r = await refine('examples/uav-isr.sysml');
    expect(r.groups).toEqual([]);
    expect(r.exitCode).toBe(2);
    // Its nine bare connections are listed rather than counted away.
    expect(r.notEncoded).toBe(9);
  });
});

/**
 * L8 — `refine --via derive|refine`: a requirement written down from another
 * requirement, checked with the orientation the mapper actually stores.
 *
 * THE ORIENTATION IS THE POINT OF THIS BLOCK, and it is the one thing here that
 * could go wrong silently. The two families store their ends the opposite way
 * round — `derive requirement D from R` maps to `Derive` with source `R` and
 * target `D`, while `refine requirement X by Y` maps to `Refine` with source
 * `Y` and target `X`, uniform with `satisfy` — so a checker that assumed one
 * rule for both would not fail loudly: it would check the mirror obligations
 * and report "refines" for a chain written the other way up. The reversed case
 * below is what makes that a red test rather than a plausible report.
 *
 * The two obligations, from §3.6: `A_R ⊨ ⋀ A_D` (the derived set assumes no
 * more) and `A_R ∧ ⋀ nf(C_D) ⊨ G_R` (together they entail what the parent
 * promised), in normal form for the same reason the composition ones are.
 */
describe('L8 — refine: derivation and refinement chains, with the measured orientation', () => {
  const STRONGER = 'test/fixtures/verification/models/derivation-stronger-assumption.sysml';
  const CONJOINS = 'test/fixtures/verification/models/derivation-conjoins.sysml';
  const REFINES = 'test/fixtures/verification/models/derivation-refine-chain.sysml';
  const REFUSED = 'test/fixtures/verification/models/derivation-refused-clause.sysml';
  const VACUOUS = 'test/fixtures/verification/models/derivation-vacuous.sysml';
  const DANGLING = 'test/fixtures/verification/models/derivation-dangling-edge.sysml';
  const MIXED = 'test/fixtures/verification/models/refinement-mixed-families.sysml';

  async function refine(
    path: string,
    opts: Parameters<typeof refinementReport>[1] = {},
    text?: string,
  ): Promise<Awaited<ReturnType<typeof refinementReport>>> {
    const source = text ?? read(path);
    const { model } = await loadModelText(source, { fileName: path });
    if (!model) throw new Error(`${path} produced no model`);
    return refinementReport(model, { ...opts, sourceText: source });
  }

  withZ3('a derived requirement that assumes MORE does not refine, and names the witness', async () => {
    const r = await refine(STRONGER, { via: 'derive' });
    expect(r.exitCode, 'a chain that is not a refinement went green').toBe(1);
    expect(r.notRefined).toBe(1);
    const [group] = r.groups;
    expect(group.via).toBe('derive');
    expect(group.system.qualifiedName).toBe('DerivationStrongerAssumption::MassBudget');
    // A DERIVATION NAMES NO PART. The edge joins two requirements and says
    // nothing about who satisfies either of them.
    expect(group.part, 'a derivation group named a part the edge never mentions').toBeNull();
    expect(group.components.map((c) => c.contract.qualifiedName)).toEqual([
      'DerivationStrongerAssumption::BodyMass',
    ]);
    const assumption = group.obligations.find((o) => o.kind === 'assumption')!;
    expect(assumption.outcome).toBe('refuted');
    expect(assumption.code).toBe('verification/derivation-not-refinement');
    expect(assumption.detail).toContain('assumes MORE than');
    // The witness is a speed the parent covers and the child does not, re-read
    // through this tool's own evaluator before it was printed.
    expect(assumption.witnessConfirmed, 'a counterexample was printed unconfirmed').toBe(true);
    const speed = assumption.witness.find(
      (w) => w.symbol === 'DerivationStrongerAssumption::Vehicle::speed',
    )!;
    expect(speed, 'the witness no longer names the quantity the assumptions differ on').toBeDefined();
    expect(Number(speed.value)).toBeGreaterThan(10);
    expect(Number(speed.value)).toBeLessThanOrEqual(30);
    expect(group.code).toBe('verification/derivation-not-refinement');
    // MUST NEVER claim anything temporal.
    expect(group.detail).toContain('Nothing here is about ordering or time');
  });

  withZ3('two derived children conjoin to imply the parent, and neither does alone', async () => {
    const r = await refine(CONJOINS, { via: 'derive' });
    expect(r.exitCode).toBe(0);
    expect(r.refined).toBe(1);
    const [group] = r.groups;
    expect(group.components).toHaveLength(2);
    const composition = group.obligations.find((o) => o.kind === 'composition')!;
    expect(composition.outcome).toBe('proved');
    expect(composition.detail).toContain('negation unsat');
    expect(composition.detail).toContain('nf(C) = ¬A ∨ G');
    // Neither child assumes anything, so there is nothing to discharge — and an
    // empty obligation is reported as empty rather than as proved.
    expect(group.obligations.filter((o) => o.kind === 'assumption').map((o) => o.outcome)).toEqual([
      'no-assumption',
      'no-assumption',
    ]);

    // AND THE CONJUNCTION IS WHAT DOES IT: with one of the two derivations
    // removed, the remaining child does not entail the parent.
    const alone = read(CONJOINS).replace('    derive requirement PackMass from TotalMass;\n', '');
    expect(alone, 'the mutation matched nothing').not.toBe(read(CONJOINS));
    const one = await refine(CONJOINS, { via: 'derive' }, alone);
    expect(one.exitCode, 'one bound of two entailed the total').toBe(1);
    expect(one.groups[0].obligations.find((o) => o.kind === 'composition')!.outcome).toBe('refuted');
  });

  withZ3('the reversed direction is refuted, so the orientation cannot be assumed', async () => {
    // `derive requirement TotalMass from BodyMass;` makes the 18 kg body bound
    // the PARENT and the 25 kg total the derived requirement. Read that way the
    // chain does not refine — a checker that had the orientation backwards
    // would report the same model as refined, which is why this case exists.
    const reversed = read(CONJOINS).replace(
      '    derive requirement BodyMass from TotalMass;\n    derive requirement PackMass from TotalMass;',
      '    derive requirement TotalMass from BodyMass;',
    );
    expect(reversed, 'the mutation matched nothing').not.toBe(read(CONJOINS));
    const r = await refine(CONJOINS, { via: 'derive' }, reversed);
    expect(r.exitCode).toBe(1);
    const [group] = r.groups;
    expect(group.system.qualifiedName, 'the parent is the SOURCE of a `derive` edge').toBe(
      'DerivationConjoins::BodyMass',
    );
    expect(group.components.map((c) => c.contract.qualifiedName)).toEqual([
      'DerivationConjoins::TotalMass',
    ]);
    const composition = group.obligations.find((o) => o.kind === 'composition')!;
    expect(composition.outcome).toBe('refuted');
    expect(composition.witnessConfirmed).toBe(true);
  });

  withZ3('a `refine` edge is read the OTHER way round, because that is how it is stored', async () => {
    // `refine requirement X by Y` puts `Y` on the source end and `X` on the
    // target, uniform with `satisfy` — so `X` is the parent here where a
    // `derive` edge's parent is its source. Both are measured, neither is
    // assumed, and the reversed spelling below is refuted.
    const r = await refine(REFINES, { via: 'refine' });
    expect(r.exitCode).toBe(0);
    const [group] = r.groups;
    expect(group.via).toBe('refine');
    expect(group.system.qualifiedName).toBe('DerivationRefineChain::SpeedEnvelope');
    expect(group.components.map((c) => c.contract.qualifiedName)).toEqual([
      'DerivationRefineChain::CruiseSpeed',
    ]);
    expect(group.obligations.find((o) => o.kind === 'composition')!.outcome).toBe('proved');

    const reversed = read(REFINES).replace(
      'refine requirement SpeedEnvelope by CruiseSpeed;',
      'refine requirement CruiseSpeed by SpeedEnvelope;',
    );
    expect(reversed, 'the mutation matched nothing').not.toBe(read(REFINES));
    const back = await refine(REFINES, { via: 'refine' }, reversed);
    expect(back.exitCode, 'a 30 m/s envelope refined a 25 m/s cruise limit').toBe(1);
    expect(back.groups[0].system.qualifiedName).toBe('DerivationRefineChain::CruiseSpeed');
  });

  withZ3('`--via all` reads every family in one run, each row saying which it came from', async () => {
    // The three families answer different questions over different edges, so a
    // run over all of them is three sets of groups side by side — never one
    // merged answer a reader would have to know the provenance of.
    const source = read(CONJOINS).replace(
      '    derive requirement PackMass from TotalMass;',
      '    derive requirement PackMass from TotalMass;\n    refine requirement TotalMass by BodyMass;',
    );
    expect(source, 'the mutation matched nothing').not.toBe(read(CONJOINS));
    const r = await refine(CONJOINS, { via: 'all' }, source);
    expect(r.via).toBe('all');
    expect(r.groups.map((g) => g.via).sort()).toEqual(['derive', 'refine']);
    // The `refine` chain is a single 18 kg bound against a 25 kg total, which
    // does not entail it — so the run carries one of each verdict and is exit 1.
    expect(r.refined).toBe(1);
    expect(r.notRefined).toBe(1);
    expect(r.exitCode).toBe(1);
  });

  withZ3('a child that lost a GUARANTEE conjunct stays in the premise set; one that lost an `assume` does not', async () => {
    // THE TWO HALVES OF `nf(C_D)` DO NOT MOVE IN THE SAME DIRECTION, and reading
    // them as if they did cost a real verdict: withholding a child on ANY
    // refusal turned this chain — which does refine — into exit 1 with a
    // CONFIRMED witness at `massPack = 8`, a design `PackMass` forbids.
    const shipped = await refine(REFUSED, { via: 'derive' });
    expect(shipped.exitCode, 'a refused `require` conjunct refuted a chain that refines').toBe(0);
    expect(shipped.refined).toBe(1);
    expect(shipped.refused, 'the refusal was dropped instead of being listed').toBeGreaterThan(0);
    expect(shipped.groups[0].obligations.find((o) => o.kind === 'composition')!.outcome).toBe(
      'proved',
    );

    // The other direction: the SAME clause written as an `assume` strengthens
    // the child's normal form once the gate drops it (`¬a₁` entails
    // `¬a₁ ∨ ¬a₂`, and with the only `assume` gone it collapses to a bare `G`),
    // so the child is kept out of the premise set and files its own undecided
    // row. And the composition row over what is left is never a REFUTATION: the
    // clause that was dropped may exclude the very point it found.
    const asAssume = read(REFUSED).replace(
      '        require constraint { rig.mode == "auto" }',
      '        assume constraint { rig.mode == "auto" }',
    );
    expect(asAssume, 'the mutation matched nothing').not.toBe(read(REFUSED));
    const withheld = await refine(REFUSED, { via: 'derive' }, asAssume);
    expect(withheld.exitCode, 'a refutation was published over a partial premise set').toBe(2);
    expect(withheld.notRefined).toBe(0);
    const composition = withheld.groups[0].obligations.find((o) => o.kind === 'composition')!;
    expect(composition.outcome).toBe('undecided');
    expect(composition.code).toBe('verification/refinement-undecided');
    expect(composition.detail).toContain('PARTIAL premise set');
    expect(
      withheld.groups[0].obligations.find(
        (o) => o.component?.qualifiedName === 'DerivationRefusedClause::PackMass',
      )!.outcome,
    ).toBe('undecided');
  });

  withZ3('a chain whose antecedent is unsatisfiable is VACUOUS, never refined', async () => {
    // STEP (0), ONE LEVEL DOWN. `Parent` applies only below 5 kg and `Child`
    // demands at least 10, so both derivation obligations are entailed by a
    // contradiction. Without step (0) this file prints "derivation refines" at
    // exit 0 — the twin of the contradictory-sibling case one level up.
    const r = await refine(VACUOUS, { via: 'derive' });
    expect(r.exitCode).toBe(2);
    expect(r.vacuous).toBe(1);
    expect(r.refined, 'a contradiction bought a refinement verdict').toBe(0);
    const [group] = r.groups;
    expect(group.outcome).toBe('vacuous');
    expect(group.code).toBe('verification/contract-set-vacuous');
    expect(group.vacuityCore.length, 'a vacuity with no core names nothing').toBeGreaterThan(0);
    // …and no flag launders it: §2 puts vacuity outside `--allow-inconclusive`
    // altogether.
    expect(ALLOW_INCONCLUSIVE_CODES.has('verification/contract-set-vacuous')).toBe(false);
    const forgiven = await refine(VACUOUS, { via: 'derive', allowInconclusive: true });
    expect(forgiven.exitCode).toBe(2);
  });

  withZ3('a `derive` edge whose other end states no contract is counted, not silently dropped', async () => {
    // `derive requirement Child from rig;` names a PART on its other end, so
    // there is no obligation over two contracts to check and no group to make.
    // Reporting only the groups made the run say "this model states no `derive`
    // chain at all" about a file that plainly writes one.
    const r = await refine(DANGLING, { via: 'derive' });
    expect(r.groups).toEqual([]);
    expect(r.exitCode).toBe(2);
    expect(r.unreadEdges, 'an edge this lane could not read vanished from the census').toBe(1);
  });

  it('publishes the families in the SAME order with a solver and without one', async () => {
    // `--via all` is three sets of groups side by side, and a census taken
    // family-by-family in one order against a run taken in another moves rows
    // for no reason a reader can see. The fixture states BOTH families, which
    // is what makes the order observable at all.
    const before = process.env.SYSPROSE_NO_Z3;
    process.env.SYSPROSE_NO_Z3 = '1';
    let census: string[];
    try {
      const absent = await refine(MIXED, { via: 'all' });
      expect(absent.toolAbsent).toBe(true);
      census = absent.groups.map((g) => `${g.via}:${g.system.qualifiedName}`);
      expect(census.length, 'the fixture no longer states both families').toBeGreaterThan(1);
      expect(new Set(census.map((r) => r.split(':')[0])).size).toBe(2);
    } finally {
      if (before === undefined) delete process.env.SYSPROSE_NO_Z3;
      else process.env.SYSPROSE_NO_Z3 = before;
    }
    const solved = await refine(MIXED, { via: 'all' });
    expect(solved.groups.map((g) => `${g.via}:${g.system.qualifiedName}`)).toEqual(census);
  }, 120_000);

  it('states no chain where the model states none, and is not green for it', async () => {
    // `examples/uav-power-budget.sysml` states a decomposition and no
    // derivation at all, and exit 0 would say every chain in it was shown to
    // refine.
    const r = await refine('examples/uav-power-budget.sysml', { via: 'derive' });
    expect(r.groups).toEqual([]);
    expect(r.exitCode).toBe(2);
  }, 120_000);
});

/**
 * L8 — `bounds`: the tightest value the model admits, or the sentence saying it
 * is not the tightest.
 *
 * WHAT EACH CASE PINS is a sentence from §3.7's MUST-NEVER list turned into a
 * property:
 *
 *  - a `require` body is not an axiom, so `--free all` answers **unbounded
 *    above** over a file that states a 25 kg limit — and the line says which
 *    clauses were axioms, every time;
 *  - `--with-requirements` folds that body in and the line says SO, which is the
 *    other half of the same rule;
 *  - a nonlinear objective yields a value and never the word "optimum", because
 *    νZ is complete for linear real arithmetic and this is not it;
 *  - the heuristic `optimize` in `src/semantics/solver.ts` is a different thing
 *    with a different guarantee, and it never beats the bound z3 proved.
 */
describe('L8 — bounds: exact, or honest about not being exact', () => {
  const UAV = 'test/fixtures/verification/models/bounds-uav.sysml';
  const REFUSED_AXIOM = 'test/fixtures/verification/models/bounds-refused-axiom.sysml';
  const ASSUME = 'test/fixtures/verification/models/bounds-assume.sysml';

  async function bounds(
    opts: Parameters<typeof boundsReport>[1],
    path = UAV,
  ): Promise<Awaited<ReturnType<typeof boundsReport>>> {
    const source = read(path);
    const { model } = await loadModelText(source, { fileName: path });
    if (!model) throw new Error(`${path} produced no model`);
    return boundsReport(model, { ...opts, sourceText: source });
  }

  withZ3('a two-sided range gives an exact min and max, in the unit the file declares', async () => {
    const r = await bounds({ measure: 'uav.payload', sense: 'both', free: ['uav.payload'] });
    expect(r.exitCode).toBe(0);
    expect(r.bounds.map((b) => [b.sense, b.outcome, b.value])).toEqual([
      ['min', 'optimum', 2],
      ['max', 'optimum', 6],
    ]);
    for (const b of r.bounds) {
      expect(b.detail).toContain('[kg]');
      expect(b.detail, 'a verdict line did not say which clauses were axioms').toContain(
        '`require` and `assume` clauses excluded',
      );
    }
    // The derived measure over the same range, which is the interesting one: a
    // linear equation carries the range through to the total.
    const derived = await bounds({ measure: 'uav.mtow', sense: 'both', free: ['uav.payload'] });
    expect(derived.bounds.map((b) => b.value)).toEqual([14.5, 18.5]);
    expect(derived.exitCode).toBe(0);
  });

  withZ3('answers UNBOUNDED over a file that states a limit, because a limit is not an axiom', async () => {
    const r = await bounds({ measure: 'uav.mtow', sense: 'max', freeAll: true });
    expect(r.bounds).toHaveLength(1);
    const [max] = r.bounds;
    expect(max.outcome, 'a `require` clause bounded a measure it was never an axiom of').toBe(
      'unbounded',
    );
    expect(max.detail).toContain('unbounded above');
    expect(max.detail).toContain('`require` and `assume` clauses excluded');
    expect(max.value).toBeNull();
    // A decided answer: z3 proved there is no finite bound, and that is exit 0.
    expect(r.exitCode).toBe(0);

    // …and with the requirement folded in, the same measure is 25 exactly, with
    // the fact printed on the line rather than left to be inferred.
    const folded = await bounds({
      measure: 'uav.mtow',
      sense: 'max',
      freeAll: true,
      withRequirements: true,
    });
    expect(folded.bounds[0].outcome).toBe('optimum');
    expect(folded.bounds[0].value).toBe(25);
    expect(folded.bounds[0].detail).toContain('--with-requirements');
    expect(folded.requirements).toEqual(['BoundsUav::MassRequirement']);
    expect(folded.exitCode).toBe(0);
  });

  withZ3('a nonlinear objective is a bound and never an optimum, and exits 2', async () => {
    const r = await bounds({
      measure: 'uav.endurance',
      sense: 'max',
      free: ['BoundsUav::BatteryPack::capacity'],
    });
    const [max] = r.bounds;
    expect(max.outcome).toBe('bound-without-optimality');
    expect(max.code).toBe('verification/optimality-not-established');
    expect(max.detail).toContain('optimality not established (nonlinear)');
    expect(max.detail, 'a non-optimal bound was presented as the optimum').not.toContain('exactly');
    expect(max.value).toBeCloseTo(3101.538, 2);
    expect(r.nonlinear).toBe(true);
    // NOT ONE OF THE TWO CODES `--allow-inconclusive` LOWERS. A flag that
    // forgave this would put a bound whose optimality nobody established into a green build.
    expect(ALLOW_INCONCLUSIVE_CODES.has('verification/optimality-not-established')).toBe(false);
    expect(r.exitCode).toBe(2);
  });

  withZ3('the νZ optimum is never beaten by the heuristic `optimize`', async () => {
    // TWO DIFFERENT THINGS WITH TWO DIFFERENT GUARANTEES, and the report says
    // which is which: `optimize` is a coordinate descent with a golden-section
    // line search that returns a point it FOUND, and this returns a bound z3
    // PROVED. A search that beat the proved bound would mean one of them is
    // wrong about the model. The tolerance is relative and tiny: the heuristic
    // reads its objective back through the numeric surface, so the last bits of
    // a binary64 division are not the property under test.
    const source = read(UAV);
    const { model } = await loadModelText(source, { fileName: UAV });
    if (!model) throw new Error('the fixture produced no model');
    const idOf = (qualifiedName: string): string => {
      const el = model.all().find((e) => model.qualifiedName(e.id) === qualifiedName);
      if (!el) throw new Error(`no ${qualifiedName}`);
      return el.id;
    };
    const capacity = idOf('BoundsUav::BatteryPack::capacity');
    const endurance = idOf('BoundsUav::AirVehicle::endurance');
    const range = new Map<string, [number, number]>([[capacity, [500, 700]]]);
    const proved = await bounds({
      measure: 'uav.endurance',
      sense: 'both',
      free: ['BoundsUav::BatteryPack::capacity'],
    });
    const [min, max] = proved.bounds;
    const noise = (v: number) => Math.abs(v) * 1e-9;
    const heuristicMax = optimize(model, endurance, [capacity], { sense: 'max', bounds: range });
    expect(heuristicMax.value).toBeLessThanOrEqual(max.value! + noise(max.value!));
    const heuristicMin = optimize(model, endurance, [capacity], { sense: 'min', bounds: range });
    expect(heuristicMin.value).toBeGreaterThanOrEqual(min.value! - noise(min.value!));
    // And the report names the other one, so the two are never read as one.
    expect(max.detail).toContain('νZ');
  });

  withZ3('a strict bound is a supremum, and says it is never attained', async () => {
    // THE THIRD ANSWER A SINGLE NUMBER CANNOT TELL APART. `payload < 6` has no
    // maximum: 6 is the supremum and no design takes it. z3 says so as
    // `6 + (−1)·ε`, and a report that printed `6` as the optimum would name a
    // value the model excludes.
    const source = read(UAV).replace('payload <= 6.0 [kg]', 'payload < 6.0 [kg]');
    expect(source, 'the mutation matched nothing').not.toBe(read(UAV));
    const { model } = await loadModelText(source, { fileName: UAV });
    if (!model) throw new Error('the probe produced no model');
    const r = await boundsReport(model, {
      measure: 'uav.payload',
      sense: 'max',
      free: ['uav.payload'],
      sourceText: source,
    });
    const [max] = r.bounds;
    expect(max.outcome).toBe('supremum');
    expect(max.value).toBe(6);
    expect(max.detail).toContain('never attained');
    expect(max.term, 'the exact answer no longer carries the epsilon z3 wrote').toContain('epsilon');
    // AND IT PUBLISHES NO POINT. The optimiser still hands one back, and it is
    // a feasible design BELOW the supremum — printing `payload = 5` beside
    // "6 exactly, approached and never attained" invites the one reading this
    // row exists to deny, exactly as it would on an unbounded row.
    expect(max.witness, 'a supremum row printed the point the optimiser stopped at').toEqual([]);
    // An exact bound IS an answer about the model, so it is decided and green.
    expect(r.exitCode).toBe(0);
  });

  withZ3('an axiom set that cannot hold together bounds nothing, and says so with a core', async () => {
    // A vacuity, one level down from `refine`'s: a bound over an unsatisfiable
    // set is entailed by a contradiction, and no flag launders that into a
    // number.
    const source = read(UAV).replace(
      'assert constraint payloadRange { payload >= 2.0 [kg] and payload <= 6.0 [kg] }',
      'assert constraint payloadRange { payload >= 8.0 [kg] and payload <= 6.0 [kg] }',
    );
    expect(source, 'the mutation matched nothing').not.toBe(read(UAV));
    const { model } = await loadModelText(source, { fileName: UAV });
    if (!model) throw new Error('the probe produced no model');
    const r = await boundsReport(model, {
      measure: 'uav.mtow',
      sense: 'max',
      free: ['uav.payload'],
      sourceText: source,
    });
    expect(r.bounds[0].outcome).toBe('vacuous');
    expect(r.bounds[0].code).toBe('verification/inconsistent-axioms');
    expect(r.vacuityCore.length, 'a vacuity with no core names nothing').toBeGreaterThan(0);
    expect(r.exitCode).toBe(2);
  });

  it('decides nothing with no solver, and still names the measure', async () => {
    // The honest-absence path. There is no point evaluation to fall back to: a
    // bound is a claim about every design the axioms admit, and the value in
    // the file is one of them.
    const before = process.env.SYSPROSE_NO_Z3;
    process.env.SYSPROSE_NO_Z3 = '1';
    try {
      const r = await bounds({ measure: 'uav.mtow', sense: 'both' });
      expect(r.toolAbsent).toBe(true);
      expect(r.exitCode).toBe(2);
      expect(r.measure?.qualifiedName).toBe('BoundsUav::AirVehicle::mtow');
      expect(r.bounds.map((b) => b.code)).toEqual([
        'verification/tool-absent',
        'verification/tool-absent',
      ]);
      expect(r.diagnostics[0].code).toBe('verification/tool-absent');
    } finally {
      if (before === undefined) delete process.env.SYSPROSE_NO_Z3;
      else process.env.SYSPROSE_NO_Z3 = before;
    }
  }, 120_000);

  withZ3('refuses a REF that names no feature this lane reads, rather than calling it unbounded', async () => {
    // "Unbounded" is arithmetically true of a quantity no relation mentions,
    // and it would read as a finding about a model that never constrains it.
    const r = await bounds({ measure: 'uav.battery', sense: 'max' });
    expect(r.bounds[0].outcome).toBe('inconclusive');
    expect(r.bounds[0].code).toBe('verification/unsupported-construct');
    expect(r.bounds[0].detail).toContain('no relation this lane encodes reads');
    expect(r.exitCode).toBe(2);
    // ONE ROW PER SENSE, whatever `--sense` asked for: a payload whose SHAPE
    // depended on which branch produced it would make two runs of one command
    // two different documents.
    const both = await bounds({ measure: 'uav.battery', sense: 'both' });
    expect(both.bounds.map((b) => b.sense)).toEqual(['min', 'max']);
    expect(both.exitCode).toBe(2);
  });

  withZ3('a design point this tool cannot reproduce is not a bound', async () => {
    // §5's WITNESS GATE, at the surface with the least redundancy behind it:
    // `bounds` is the one command whose ANSWER is a number the encoder
    // produced, so an encoder defect of the class §5 names — a wrong unit
    // factor, a sign error, a mis-scaled offset — has nothing else to catch it.
    // Measured with a real encoder defect (every numeric literal scaled by 1.5
    // in `smt/encode.ts`): without this gate the run publishes
    // `max payload = 9 [kg] exactly` at exit 0.
    //
    // Here the defect is injected at the BACKEND instead, so the case pins the
    // gate rather than one encoder bug: the real solver answers, and the point
    // it stopped at is replaced by one the model's own `payloadRange` forbids.
    const source = read(UAV);
    const { model } = await loadModelText(source, { fileName: UAV });
    if (!model) throw new Error('the fixture produced no model');
    const measureId = model.all().find(
      (e) => model.qualifiedName(e.id) === 'BoundsUav::AirVehicle::payload',
    )!.id;
    const real = await loadZ3();
    if (real.absent) throw new Error('the solver is required for this case');

    // The control: the solver's own point, re-read and confirmed.
    const honest = await checkBounds(model, {
      backend: real,
      measureId,
      sense: 'max',
      free: new Set(['BoundsUav::AirVehicle::payload']),
    });
    expect(honest.bounds[0].outcome).toBe('optimum');
    expect(honest.bounds[0].value).toBe(6);

    // The same run with one value of the point moved outside the range the
    // model states. Nothing else changes — the bound z3 returned is the bound
    // it returned.
    const tampered: Z3Backend = {
      ...real,
      check: (script, opts) => real.check(script, opts),
      optimize: async (script, sense, opts) => {
        const outcome = await real.optimize(script, sense, opts);
        return {
          ...outcome,
          witness: outcome.witness.map((w) =>
            w.symbol === 'BoundsUav::AirVehicle::payload'
              ? { ...w, term: '9.0', value: 9 }
              : w,
          ),
        };
      },
    };
    const r = await checkBounds(model, {
      backend: tampered,
      measureId,
      sense: 'max',
      free: new Set(['BoundsUav::AirVehicle::payload']),
    });
    const [max] = r.bounds;
    expect(max.outcome, 'a bound was published over a point this tool cannot reproduce').toBe(
      'inconclusive',
    );
    expect(max.code).toBe('verification/not-evaluable');
    expect(max.detail).toContain('would not confirm the point it stopped at');
    expect(max.value, 'a number was published beside an unconfirmed point').toBeNull();
  });

  withZ3('a refused axiom the objective can REACH stands the row down; one it cannot does not', async () => {
    // A DROPPED AXIOM WIDENS THE SPACE, so the bound over what is left is
    // LOOSER than the model's — and every decided outcome here claims it is
    // not. The reach test is the one `verify` applies before it publishes a
    // refutation, over the same closure.
    const near = await bounds(
      { measure: 'b.depth', sense: 'max', free: ['BoundsRefusedAxiom::TankB::depth'] },
      REFUSED_AXIOM,
    );
    expect(near.refused).toBe(1);
    expect(near.bounds[0].outcome, 'a bound over a partial axiom set was published as one').toBe(
      'inconclusive',
    );
    expect(near.bounds[0].code).toBe('verification/not-evaluable');
    expect(near.bounds[0].detail).toContain('PARTIAL axiom set');
    expect(near.exitCode).toBe(2);

    // The same refusal, out of reach: it shares no symbol with `TankA::level`,
    // so an assignment satisfying it pastes onto one satisfying A's closure and
    // it can move neither the bound nor whether one exists. Listing it is all
    // this run owes it.
    const far = await bounds(
      { measure: 'a.level', sense: 'max', free: ['BoundsRefusedAxiom::TankA::level'] },
      REFUSED_AXIOM,
    );
    expect(far.refused, 'the run-level refusal census no longer sees it').toBe(1);
    expect(far.bounds[0].outcome).toBe('optimum');
    expect(far.bounds[0].value).toBe(3);
    expect(far.exitCode).toBe(0);
  });

  withZ3('an UNBOUNDEDNESS reached over a nonlinear script is not one νZ established', async () => {
    // νZ is complete for LINEAR real arithmetic and nothing else, and `oo` is as
    // much a claim about the tightest value as a number is. The finite half of
    // this rule was already pinned; the infinite half escaped it, and exited 0
    // over the same script the same run called nonlinear.
    const source = read(UAV).replace(
      'assert constraint packSize { battery.capacity >= 500.0 [Wh] and battery.capacity <= 700.0 [Wh] }',
      'assert constraint packSize { battery.capacity >= 500.0 [Wh] }',
    );
    expect(source, 'the mutation matched nothing').not.toBe(read(UAV));
    const { model } = await loadModelText(source, { fileName: UAV });
    if (!model) throw new Error('the probe produced no model');
    const r = await boundsReport(model, {
      measure: 'uav.endurance',
      sense: 'max',
      free: ['BoundsUav::BatteryPack::capacity'],
      sourceText: source,
    });
    expect(r.nonlinear).toBe(true);
    const [max] = r.bounds;
    expect(max.outcome, 'an `oo` over a nonlinear script was published as proved').toBe(
      'bound-without-optimality',
    );
    expect(max.code).toBe('verification/optimality-not-established');
    expect(max.term).toBe('oo');
    expect(max.detail).toContain('not linear');
    expect(r.exitCode).toBe(2);
  });

  withZ3('an `assume` is not an axiom, and folded in it is escapable through its own antecedent', async () => {
    // BOTH HALVES OF THE `assume` RULE. Without the flag, `HeavyPayload`'s
    // `assume` constrains nothing — it is requirement CONTEXT, not a fact about
    // the design — so nothing outside a requirement bounds `emptyMass`.
    const bare = await bounds(
      { measure: 'uav.emptyMass', sense: 'max', freeAll: true },
      ASSUME,
    );
    expect(bare.bounds[0].outcome, 'an `assume` bounded a measure it is not an axiom of').toBe(
      'unbounded',
    );
    expect(bare.bounds[0].detail).toContain('`require` and `assume` clauses excluded');
    expect(bare.requirements).toEqual([]);

    // With the flag, the requirement is folded in as `assume ⇒ require`, and the
    // ANTECEDENT is what makes the answer 23 rather than 20: a 2 kg payload
    // escapes `HeavyPayload` entirely and is held only by the 25 kg total.
    // Folding the `assume` into the AXIOM set, or asserting the guarantee
    // without it, answers 20 — a TIGHTER bound than the file states.
    const folded = await bounds(
      { measure: 'uav.emptyMass', sense: 'max', freeAll: true, withRequirements: true },
      ASSUME,
    );
    expect(folded.bounds[0].outcome).toBe('optimum');
    expect(folded.bounds[0].value, 'the folded implication was not escapable through its antecedent').toBe(23);
    expect(folded.requirements).toEqual(['BoundsAssume::MassRequirement', 'BoundsAssume::HeavyPayload']);
    expect(folded.exitCode).toBe(0);
  });
});

/**
 * L8 — `fault-tree`: which combinations of contract failures break the top event.
 *
 * A SUITE-LEVEL CASE for the reason the refinement block above is one: a
 * `test/fixtures/verification/<case>/expected.json` is a projection of a
 * `VerifyReport`, and a cut-set enumeration is a different report about a
 * different question.
 *
 * WHAT EACH CASE PINS is a sentence from §3.9's MUST-NEVER list turned into a
 * property, and three of them are the reason the module is shaped the way it is:
 *
 *  - **A vacuous baseline is never "no cut set".** Obligation (3) cannot FAIL
 *    from an unsatisfiable antecedent, so a contract set that entails
 *    everything survives every fault set — and the tool that enumerated over it
 *    would print the most reassuring sentence it has about the least safe model
 *    in the corpus.
 *  - **An undecided order-1 check forbids the no-single-point claim.** Driven
 *    by a stub backend rather than by a timeout, so the case says what it means
 *    on every machine: one check comes back `unknown` and the group's
 *    `singlePointOfFailure` must be `null`, not `false`.
 *  - **A state machine is refused, in BOTH builds.** The pointer to
 *    `check-behaviour` is conditional on that row existing, and the fallback
 *    sentence is checked here because the build that needs it is the one this
 *    repository does not have — phase 4 has landed, so the live branch is the
 *    pointer and the fallback would otherwise never be executed at all.
 *
 * The redundancy fixture carries the two answers a fault tree exists to tell
 * apart: one sub-contract whose failure alone breaks the top requirement, and
 * two that have to fail together.
 */
describe('L8 — fault-tree: cut sets from contract-failure injection', () => {
  const BUDGET = 'examples/uav-power-budget.sysml';
  const REDUNDANT = 'test/fixtures/verification/models/fault-tree-redundant.sysml';
  const SIBLINGS = 'test/fixtures/verification/models/refinement-contradictory-siblings.sysml';
  const LEVELS = 'test/fixtures/verification/models/refinement-three-level.sysml';
  const MUTUAL = 'test/fixtures/verification/models/refinement-mutual-support.sysml';

  /** One run over one model, with the flags a person would type. */
  async function tree(
    path: string,
    opts: Parameters<typeof faultTreeReport>[1] = {},
    text?: string,
  ): Promise<Awaited<ReturnType<typeof faultTreeReport>>> {
    const source = text ?? read(path);
    const { model } = await loadModelText(source, { fileName: path });
    if (!model) throw new Error(`${path} produced no model`);
    return faultTreeReport(model, { ...opts, sourceText: source });
  }

  withZ3('{battery} is an order-1 cut set on the power-budget example, with the bound stated', async () => {
    // THE FLAGSHIP EXAMPLE, AND WHAT IT HONESTLY SAYS. `{battery}` — the pack's
    // own contract — is an order-1 cut set: withdraw its guarantee and the
    // available power is unconstrained, so the loads no longer fit inside it.
    //
    // AND SO ARE THE OTHER THREE, which is a fact about this model rather than
    // about the tool: each load's draw is bounded by ITS OWN guarantee and by
    // nothing else, so withdrawing any one of them frees a term of the sum.
    // §4's own sentence for this commit expects `{radio}` NOT to be a cut set
    // here, and on the model as shipped that is false — the property it is
    // about is redundancy, which this example does not have and
    // `fault-tree-redundant.sysml` does. Both are pinned, and the shipped
    // example is pinned as it is rather than as the plan hoped.
    const r = await tree(BUDGET);
    expect(r.exitCode, 'a single point of failure went green').toBe(1);
    const [group] = r.groups;
    expect(group.outcome).toBe('cut-sets');
    expect(group.singlePointOfFailure).toBe(true);
    expect(group.code).toBe(SINGLE_POINT_OF_FAILURE_CODE);
    expect(group.events.map((e) => e.shortId || e.contract.declaredName)).toEqual([
      'BatterySupply',
      'ComputerDraw',
      'PropulsionDraw',
      'RadioDraw',
    ]);
    const battery = group.cutSets.find((c) => c.shortIds.includes('BatterySupply'));
    expect(battery, '{battery} is no longer a cut set of the power budget').toBeDefined();
    expect(battery!.order).toBe(1);
    // The witness is a design the remaining contracts admit and the top
    // requirement forbids — re-read in process before it was printed, exactly
    // as `refine` re-reads a counterexample.
    expect(battery!.witness.length).toBeGreaterThan(0);
    // Every order-2 subset contains one of the four singletons, so pruning
    // leaves the check count at step (0) + the baseline + four.
    expect(group.checks, 'supersets of a cut set were checked rather than pruned').toBe(6);
    expect(group.maxOrder).toBe(DEFAULT_MAX_ORDER);
    expect(group.maxOrderSource).toBe('default');
    // MUST NEVER be read as a behavioural analysis, on any surface.
    expect(group.detail).toContain('not a behavioural safety analysis');
  });

  withZ3('redundancy is an order-2 cut set, neither half is one, and the radio is not', async () => {
    const r = await tree(REDUNDANT);
    const [group] = r.groups;
    expect(group.outcome).toBe('cut-sets');
    expect(group.cutSets.map((c) => c.shortIds.join('+'))).toEqual([
      'BatteryCapacity',
      'PrimaryOutput+BackupOutput',
    ]);
    // THE THREE PROPERTIES THE MODEL EXISTS FOR, one assertion each.
    expect(
      group.cutSets.filter((c) => c.order === 1).map((c) => c.shortIds[0]),
      'a supply on its own became a single point of failure, so the redundancy was not read',
    ).toEqual(['BatteryCapacity']);
    expect(
      group.cutSets.some((c) => c.shortIds.includes('RadioDraw')),
      'a sub-contract the top requirement never mentions was reported as a cut set',
    ).toBe(false);
    expect(group.singlePointOfFailure).toBe(true);
    // Step (0), the baseline, four order-1 checks and the three order-2 subsets
    // that are not supersets of `{BatteryCapacity}`.
    expect(group.checks).toBe(9);
    expect(group.undecided).toEqual([]);
    expect(r.exitCode).toBe(1);
  });

  withZ3('--max-order 1 finds the single point and never claims the order-2 set absent', async () => {
    const r = await tree(REDUNDANT, { maxOrder: 1 });
    const [group] = r.groups;
    expect(group.maxOrder).toBe(1);
    expect(group.maxOrderSource).toBe('flag');
    expect(group.cutSets.map((c) => c.shortIds.join('+'))).toEqual(['BatteryCapacity']);
    // THE ORDER-2 SET IS NOT MENTIONED, and neither is its absence: the pair
    // that IS a cut set at order 2 was never checked, and a run bounded at 1
    // that said anything about order 2 would be claiming the absence of a
    // failure it did not look for.
    expect(group.detail).toContain('up to order 1');
    expect(group.detail, 'a run bounded at order 1 spoke about order 2').not.toContain('order 2');
    expect(group.detail).not.toContain('BackupOutput');
    expect(group.checks, 'order-2 subsets were checked under --max-order 1').toBe(6);
  });

  withZ3('a vacuous baseline reports the contract set vacuous, never "no cut set"', async () => {
    // THE CASE §3.9 IS WRITTEN AGAINST. C₁ = ⟨true, x > 10⟩ and C₂ = ⟨true,
    // x < 5⟩ over one bind class cannot hold together, so obligation (3) can
    // never FAIL — and an enumeration over them would print the most
    // reassuring sentence this command has about a contract set that entails
    // everything.
    const r = await tree(SIBLINGS);
    const [group] = r.groups;
    expect(group.outcome).toBe('vacuous');
    expect(group.code).toBe(CONTRACT_SET_VACUOUS_CODE);
    expect(group.detail).toContain('contract set vacuous');
    // The CLAIM form, not the phrase: the sentence quotes "no cut set" in order
    // to say it is not that, and a guard that could not tell a mention from a
    // claim would forbid the row from stating its own charter. What must never
    // appear is the bounded-absence sentence — "no cut set up to order N" — or
    // the note that travels with it.
    expect(group.detail, 'a vacuity was printed as an absence of failure').not.toMatch(
      /no cut set up to order/,
    );
    expect(group.detail).not.toContain(ORDERS_NOT_EXPLORED_NOTE);
    expect(group.cutSets, 'a vacuous baseline produced cut sets').toEqual([]);
    expect(group.singlePointOfFailure, 'a vacuity claimed something about single points').toBeNull();
    expect(group.checks, 'the enumeration ran past step (0)').toBe(1);
    expect(r.exitCode).toBe(2);
    expect(r.vacuous).toBe(1);
  });

  withZ3('a top event already open with every sub-contract honoured is not enumerated', async () => {
    // The mutual-support model's obligation (3) is `⊤ ⊨ p`, which is refuted
    // with nothing withdrawn: the empty set is the cut set. Injecting failures
    // into an architecture that does not refine would describe failures nothing
    // has to cause, so the row says so and points at the report that owns it.
    const r = await tree(MUTUAL);
    const [group] = r.groups;
    expect(group.outcome).toBe('top-event-open');
    expect(group.code).toBe(REFINEMENT_FAILED_CODE);
    expect(group.detail).toContain('with EVERY sub-contract honoured');
    expect(group.detail).toContain('refine --via composition');
    expect(group.cutSets).toEqual([]);
    expect(group.checks, 'the enumeration ran past the baseline').toBe(2);
    // A decided negative about the architecture, so it is exit 1 — never a
    // green build, and never an empty cut-set list read as "nothing breaks it".
    expect(r.exitCode).toBe(1);
    expect(r.topEventOpen).toBe(1);
  });

  it('an undecided order-1 check forbids the no-single-point claim', async () => {
    // A STUB BACKEND, NOT A TIMEOUT, so the case means the same thing on every
    // machine: step (0) is satisfiable, the baseline holds, and the FIRST
    // order-1 check comes back `unknown`. Every other check holds, so a build
    // that read "not shown to fail" as "shown to be harmless" would report `no
    // cut set` with `singlePointOfFailure: false` — the one sentence §3.9 says
    // this command may never write.
    const { model } = await loadModelText(read(REDUNDANT), { fileName: REDUNDANT });
    if (!model) throw new Error('the probe produced no model');
    let call = 0;
    const stub: Z3Backend = {
      absent: false,
      version: '0.0.0-stub',
      fullVersion: 'stub',
      seed: 0,
      initMs: 0,
      async check(_script, opts) {
        call += 1;
        const status = call === 1 ? 'sat' : call === 3 ? 'unknown' : 'unsat';
        return {
          status,
          reason: status === 'unknown' ? 'stubbed' : '',
          timedOut: false,
          timeoutMs: opts?.timeoutMs ?? 0,
          elapsedMs: 0,
          witness: [],
          core: [],
        };
      },
      async optimize(_script, _sense, opts) {
        return {
          status: 'error',
          reason: 'this stub answers checks only',
          timedOut: false,
          timeoutMs: opts?.timeoutMs ?? 0,
          elapsedMs: 0,
          bound: null,
          witness: [],
        };
      },
    };
    const r = await computeFaultTree(model, { backend: stub });
    const [group] = r.groups;
    expect(group.cutSets).toEqual([]);
    expect(group.undecided.map((u) => u.order)).toEqual([1]);
    expect(
      group.singlePointOfFailure,
      'an undecided order-1 check was read as a component shown to be harmless',
    ).toBeNull();
    expect(group.outcome, 'an undecided enumeration was reported as an absence').toBe(
      'inconclusive',
    );
    expect(group.detail).toContain('nothing is claimed about single points of failure');
    expect(group.detail, 'an absence was claimed over a check nobody decided').not.toContain(
      'no single point of failure',
    );
  });

  it('a state machine is refused in both builds, and never answered with an empty list', () => {
    // THE TWO SAFETY LANES STAY APART. The refusal is the same and so is the
    // exit code; only the POINTER moves, and it moves on whether the row
    // exists. The live branch is the pointer — phase 4 has landed — so the
    // fallback is checked here, against the build this repository does not
    // have but the plan explicitly allows.
    expect(
      findCommand('check-behaviour'),
      'the pointer branch below is checked against a command that no longer exists',
    ).toBeDefined();
    const withCommand = behaviourLaneRefusal('P::FlightModes', 'check-behaviour');
    expect(withCommand).toContain('is a state machine; contract-level fault trees do not cover behaviour');
    // RE-RECORDED, deliberately: this line pinned `--from-keywords`, a flag
    // `check-behaviour` does not declare and never will. The pointer names
    // `--pattern` now, and the case below reads every printed invocation back
    // against the command table so the substring cannot drift off it again.
    expect(withCommand).toContain('check-behaviour <file> --element P::FlightModes --pattern');
    const fallback = behaviourLaneRefusal('P::FlightModes', null);
    expect(
      fallback,
      'the fallback sentence points at a subcommand this build may not ship',
    ).not.toContain('check-behaviour');
    // AND IT POINTS AT NOTHING AT ALL, rather than at a command spelled from
    // whatever the lookup returned: a build with no behavioural lane must not
    // print "run `npm run sysprose -- null`" either.
    expect(fallback, 'the fallback still tells a reader to run something').not.toContain(
      'npm run sysprose',
    );
    expect(fallback).toContain('is a state machine; contract-level fault trees do not cover behaviour');
    // THE REFUSAL IS THE SAME REFUSAL; only the pointer is added to it. That is
    // §4's own sentence for this commit — "the refusal and the exit code are
    // unchanged either way" — and it is what makes the conditional safe.
    expect(withCommand.startsWith(fallback), 'the two builds refuse differently').toBe(true);
    // Both say what an empty cut-set list would have said instead, which is the
    // thing being refused rather than a flourish.
    for (const message of [withCommand, fallback]) {
      expect(message).toContain('empty cut-set list');
    }
    // And the predicate the CLI branches on names the metaclass a machine is.
    expect(isBehaviouralElement({ eClass: 'StateUsage' } as never)).toBe(true);
    expect(isBehaviouralElement({ eClass: 'PartUsage' } as never)).toBe(false);
  });

  it('every command a printed sentence names exists, with the flags it names', () => {
    // THE CLASS, NOT THE INSTANCE. The refusal above once pointed a reader at
    // `check-behaviour … --from-keywords`, and that flag is declared on
    // `obligations` alone: a reader who pasted the sentence got
    // `unknown option: --from-keywords` and exit 2 from the very command the
    // tool had just told them to run. Nothing went red, because no guard read a
    // printed invocation against the table the parser and `--help` are both
    // rendered from — so the instance was fixed here and the CLASS is closed
    // here too.
    //
    // WHAT THIS WALK COVERS, exactly, because the sentence above is a promise
    // and an absence claim is only worth the walk behind it: every
    // `npm run sysprose -- …` line and every backticked `<subcommand> --flag`
    // reference spelled LITERALLY in a `.ts` or `.tsx` source under `src/` or
    // `scripts/`, plus the state-machine refusal rendered. It does not read
    // `.md`, and it cannot read a subcommand assembled out of parts at runtime.
    // Three parts, because none of them can see the others:
    //
    //  1. the refusal RENDERED, which is the form a user meets — a source scan
    //     cannot read it at all, because its subcommand is a `${…}` and its
    //     flags sit in a later template chunk with no `npm run sysprose` in
    //     front of them;
    //  2. every literal `npm run sysprose -- …`, checked the way `parseArgs`
    //     would parse it, because that is a line somebody PASTES;
    //  3. every backticked `<subcommand> --flag` reference, checked for
    //     EXISTENCE only. That form is how this codebase names a flag in prose
    //     (`verify --record`, `obligations --missing`), not a pasteable line, so
    //     a value flag standing there with no value is correct English rather
    //     than a defect. It is by far the commonest of the three, and the typo
    //     that started all of this would have been invisible without it.
    interface Invocation {
      /** The subcommand, or `null` where the source spells a placeholder. */
      command: string | null;
      /** Everything after it, in order — the flags and their values. */
      rest: string[];
      where: string;
    }

    // Stops at the quote that closes the string it is written in, so a template
    // chunk contributes what it actually spells and never runs on into prose —
    // EXCEPT for a balanced `"…"` run, which is a shell-quoted flag value. The
    // pointer this commit rewrote carries one (`--pattern "pattern=absence, …"`)
    // and a scanner that stopped at its opening quote would report the flag as
    // valueless: it would go red on the only spelling that runs, and green on
    // the metavariable that does not. Sources here are single-quoted or
    // template strings, so a `"` in one is printed text rather than a delimiter.
    const INVOCATION = /npm run sysprose -- ((?:"[^"\n]*"|[^\n`'"])*)/g;

    /** A backticked `<subcommand> --flag …` reference, the bare prose form. */
    const BARE = /`([a-z][a-z-]*)([^`\n]*--[a-zA-Z][^`\n]*)`/g;

    /** Split on spaces, but a `"…"` run is ONE token: it is one flag value. */
    const tokenise = (raw: string): string[] =>
      (raw.trim().match(/"[^"]*"|\S+/g) ?? [])
        // A template chunk ends on an ESCAPED backtick, so the source carries a
        // trailing backslash that no reader ever sees. Drop it and nothing else.
        .map((t) => t.replace(/\\+$/, ''))
        .filter(Boolean);

    function invocationsIn(text: string, where: string): Invocation[] {
      const out: Invocation[] = [];
      for (const m of text.matchAll(INVOCATION)) {
        const tokens = tokenise(m[1]);
        const head = tokens[0];
        // `<subcommand>`, `${cmd.name}` and the bare `--help` of the top-level
        // usage line name no command: they are the shapes of an invocation
        // rather than one, and there is nothing to look up.
        const placeholder =
          head === undefined ||
          head.startsWith('-') ||
          head.startsWith('<') ||
          head.includes('${');
        out.push({ command: placeholder ? null : head, rest: tokens.slice(1), where });
      }
      return out;
    }

    /** The table `parseArgs` and `--help` are both rendered from, keyed as argv. */
    function flagKeys(
      command: string,
      where: string,
    ): Map<string, ReturnType<typeof flagsFor>[number]> {
      const cmd = findCommand(command);
      expect(
        cmd,
        `${where} sends a reader to \`npm run sysprose -- ${command}\`, which is not a subcommand`,
      ).toBeDefined();
      const byKey = new Map<string, ReturnType<typeof flagsFor>[number]>();
      for (const flag of flagsFor(cmd!)) {
        byKey.set(`--${flag.name}`, flag);
        // A SHORT ALIAS IS A FLAG TOO: `-h` is one, and a scan that skipped
        // single-dash tokens would let `-z` through on a line that answers
        // `unknown option: -z`.
        if (flag.short) byKey.set(`-${flag.short}`, flag);
      }
      return byKey;
    }

    /** Does this token name a flag of that command at all? Nothing more. */
    function checkFlagExists(command: string, token: string, where: string): void {
      const key = token.split('=')[0];
      expect(
        flagKeys(command, where).get(key),
        `${where} names \`${key}\` on \`${command}\`, which does not accept it — a reader who pastes this gets \`unknown option: ${key}\``,
      ).toBeDefined();
    }

    /**
     * The whole check for a pasteable line: it names a row, and only flags of
     * that row, and every flag it names is spelled the way `parseArgs` reads.
     *
     * The three clauses below are `parseArgs`'s own (scripts/lib/args.ts): a
     * value flag whose next token starts with `-` is a MISSING value rather
     * than a value, `-` alone is stdin and the one exception, and a boolean
     * flag with an `=` on it is refused outright. A guard looser than the
     * parser passes lines the parser rejects, which is the failure this whole
     * case exists to make impossible.
     */
    function checkAgainstTheTable(inv: Invocation): void {
      const byKey = flagKeys(inv.command!, inv.where);
      inv.rest.forEach((token, i) => {
        if (!token.startsWith('-') || token === '-') return;
        const key = token.split('=')[0];
        const flag = byKey.get(key);
        expect(
          flag,
          `${inv.where} names \`${key}\` on \`${inv.command}\`, which does not accept it — a reader who pastes this gets \`unknown option: ${key}\``,
        ).toBeDefined();
        if (flag!.kind === 'boolean') {
          expect(
            token.includes('='),
            `${inv.where} prints \`${key}=…\`, and the parser answers \`--${flag!.name} takes no value\``,
          ).toBe(false);
          return;
        }
        // AND THE PASTED LINE HAS TO RUN. `parseArgs` rejects a value flag with
        // nothing after it, and rejects a following option as its value.
        if (token.includes('=')) return;
        const next = inv.rest[i + 1];
        expect(
          next !== undefined && (!next.startsWith('-') || next === '-'),
          `${inv.where} prints \`${key}\` with no value; the parser answers \`missing value for --${flag!.name}\``,
        ).toBe(true);
      });
    }

    // ── part one: the refusal, rendered ─────────────────────────────────────
    const pointer = invocationsIn(
      behaviourLaneRefusal('P::FlightModes', 'check-behaviour'),
      'the state-machine refusal',
    );
    expect(
      pointer.map((i) => i.command),
      'the refusal no longer points at a subcommand, so the check below reads nothing',
    ).toEqual(['check-behaviour']);
    expect(
      pointer[0].rest.filter((t) => t.startsWith('--')),
      'the refusal names no flag, so the flag clause of this check is vacuous',
    ).not.toEqual([]);
    // AND THE VALUE IS ONE THE COMMAND CAN READ, which a table lookup cannot
    // tell you. The pointer once printed `--pattern SPEC`: the flag exists, the
    // metavariable is a token, every check above is happy — and the pasted line
    // still exited 2 with `verification/malformed-property`, because
    // `parsePropertyText` reads a property as `key=value` fields and `SPEC` is
    // none. So the printed value is handed to the reader `check-behaviour`
    // itself decides it with. It is shell-quoted because it holds spaces: three
    // bare words would reach the command as three arguments.
    const printedPattern = pointer[0].rest[pointer[0].rest.indexOf('--pattern') + 1];
    expect(
      printedPattern !== undefined &&
        printedPattern.startsWith('"') &&
        printedPattern.endsWith('"'),
      'the printed --pattern value is not one shell-quoted argument — or the tokeniser split it',
    ).toBe(true);
    expect(
      parsePropertyText(printedPattern!.slice(1, -1), 'flag').ok,
      'the pointer prints a --pattern value the command answers verification/malformed-property to',
    ).toBe(true);
    for (const inv of pointer) checkAgainstTheTable(inv);
    // The fallback build names no command at all, which is the whole point of
    // it, so it contributes no invocation to check.
    expect(
      invocationsIn(behaviourLaneRefusal('P::FlightModes', null), 'the fallback refusal'),
      'the fallback names a subcommand this build may not ship',
    ).toEqual([]);

    // ── part two: every literal invocation the tool can print ───────────────
    // `.tsx` AS WELL AS `.ts`, because the widest printed surface is the app:
    // `src/ui/panels/Properties.tsx` renders a `npm run sysprose -- verify …`
    // line into the Evidence panel, and a walk that stopped at `.ts` would have
    // published a claim about the repository while never opening the file that
    // shows a command to the most readers.
    const sources = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(root(dir), { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...sources(p));
        else if (/\.tsx?$/.test(entry.name)) out.push(p);
      }
      return out;
    };
    const files = [...sources('src'), ...sources('scripts')];
    const named: Invocation[] = [];
    for (const file of files) {
      named.push(...invocationsIn(read(file), file).filter((i) => i.command !== null));
    }
    // NON-VACUITY, because a regex that matched nothing would pass everything.
    // Measured on this tree: 24 literal invocations naming 11 distinct
    // subcommands and carrying 17 flag tokens between them; the floors are well
    // under all three, so an ordinary edit to a hint does not move them and a
    // broken scan does. The third floor is not redundant: nine of the 24
    // invocations carry no flag at all, so deleting every flag from every hint
    // would leave both counts above their floors with nothing checked.
    expect(named.length, 'the source scan found almost no invocations — the pattern stopped matching').toBeGreaterThanOrEqual(15);
    expect(
      new Set(named.map((i) => i.command)).size,
      'the source scan resolved almost no distinct subcommands',
    ).toBeGreaterThanOrEqual(8);
    expect(
      named.flatMap((i) => i.rest.filter((t) => t.startsWith('--'))).length,
      'the source scan reads invocations but no longer reads a single flag on one',
    ).toBeGreaterThanOrEqual(10);
    for (const inv of named) checkAgainstTheTable(inv);

    // ── part three: the bare `subcommand --flag` references in prose ────────
    // EXISTENCE ONLY, and deliberately. `verify --record` in a sentence names a
    // flag; it is not a line anybody pastes, so demanding a value after it
    // would go red on correct prose. What it does catch is the species that
    // started this: a flag named on a command that does not declare it.
    const bare: { command: string; token: string; where: string }[] = [];
    for (const file of files) {
      for (const m of read(file).matchAll(BARE)) {
        if (findCommand(m[1]) === undefined) continue;
        for (const token of tokenise(m[2])) {
          if (token.startsWith('--')) bare.push({ command: m[1], token, where: file });
        }
      }
    }
    // Measured: 46 such references across `src/` and `scripts/`, which is twice
    // what the prefixed form spells — this is the tool's dominant printed shape.
    expect(
      bare.length,
      'the bare-reference scan found almost nothing — the pattern stopped matching',
    ).toBeGreaterThanOrEqual(25);
    for (const ref of bare) checkFlagExists(ref.command, ref.token, ref.where);
  });

  withZ3('the enumeration is deterministic: two runs produce identical JSON', async () => {
    // A CUT-SET LIST IS A DIFF SOMEBODY READS. Subsets are enumerated in
    // lexicographic order over the components in model order, so two runs over
    // one file cannot disagree about the order the sets are printed in — which
    // is what makes a change to this list a change worth reviewing.
    const first = await tree(REDUNDANT);
    const second = await tree(REDUNDANT);
    const project = (r: Awaited<ReturnType<typeof faultTreeReport>>) =>
      JSON.stringify(
        r.groups.map((g) => ({
          top: g.top.qualifiedName,
          events: g.events.map((e) => e.contract.qualifiedName),
          cutSets: g.cutSets.map((c) => ({ order: c.order, events: c.events })),
          checks: g.checks,
          outcome: g.outcome,
        })),
        null,
        2,
      );
    expect(project(first)).toBe(project(second));
  });

  withZ3('a hierarchy expands a sub-contract that is itself a system into an intermediate event', async () => {
    // `bozzano-2014`'s intermediate event: a basic event whose failure is not
    // primitive, because the sub-contract that fails is the TOP event of the
    // tree one level down. The three-level model yields two trees, and the
    // mid-level contract is a basic event of the upper one and the top of the
    // lower one — which is what "expands" means here.
    const r = await tree(LEVELS);
    expect(r.groups.map((g) => g.top.declaredName)).toEqual(['VehicleBudget', 'PackBudget']);
    const [vehicle, pack] = r.groups;
    const [midEvent] = vehicle.events;
    expect(midEvent.contract.declaredName).toBe('PackBudget');
    expect(midEvent.intermediate, 'a whole subsystem was presented as an atom').toBe(true);
    expect(midEvent.expandsTo).toBe(pack.top.qualifiedName);
    // And the leaves of the lower tree are leaves.
    expect(pack.events.map((e) => e.intermediate)).toEqual([false, false]);
    // The upper tree has ONE sub-contract, so its order bound is clamped to 1
    // and the report says which number was asked for.
    expect(vehicle.maxOrder).toBe(1);
    expect(vehicle.detail).toContain('asked for 2');
  });

  withZ3('a FaultHypothesis carrier pins the bound in the model, and --max-order overrides it', async () => {
    // §3.9's sync handle (`rauzy-2019`): the order bound is the one part of
    // this analysis that is an ASSUMPTION rather than a computation, so the
    // model can carry it where a reviewer sees it. The shipped package is
    // prepended rather than retyped — the carrier is the tool's own vocabulary,
    // and a hand-copied package resolves whatever the copy says.
    const source = `${SYSPROSE_VERIFICATION_LIBRARY}\n\n${read(REDUNDANT).replace(
      '    requirement def MissionPower {',
      '    requirement def MissionPower {\n        @SysproseVerification::FaultHypothesis { attribute maxOrder = 1; }',
    )}`;
    expect(source, 'the carrier was not inserted').toContain('FaultHypothesis { attribute maxOrder');
    const pinned = await tree(REDUNDANT, {}, source);
    expect(pinned.groups[0].maxOrder).toBe(1);
    expect(pinned.groups[0].maxOrderSource).toBe('carrier');
    expect(pinned.groups[0].cutSets.map((c) => c.shortIds.join('+'))).toEqual(['BatteryCapacity']);
    // The flag is an override a reviewer can see, not a second opinion.
    const overridden = await tree(REDUNDANT, { maxOrder: 2 }, source);
    expect(overridden.groups[0].maxOrder).toBe(2);
    expect(overridden.groups[0].maxOrderSource).toBe('flag');
    expect(overridden.groups[0].cutSets.map((c) => c.shortIds.join('+'))).toEqual([
      'BatteryCapacity',
      'PrimaryOutput+BackupOutput',
    ]);
  });

  withZ3('#exceptional labels the top event and leaves its cut sets unchanged', async () => {
    const bare = await tree(REDUNDANT);
    const source = `${SYSPROSE_VERIFICATION_LIBRARY}\n\n${read(REDUNDANT).replace(
      '    requirement def MissionPower {',
      '    #SysproseVerification::exceptional requirement def MissionPower {',
    )}`;
    const tagged = await tree(REDUNDANT, {}, source);
    expect(bare.groups[0].exceptional, 'an untagged outcome was read as a failure').toBe(false);
    expect(tagged.groups[0].exceptional, 'the shipped keyword no longer resolves').toBe(true);
    // THE TAG IS A LABEL, NOT AN INPUT. It says an outcome is a failure rather
    // than an equally valid result; it is not a fact the solver reads, and the
    // tree is the same tree.
    expect(tagged.groups[0].cutSets.map((c) => c.shortIds.join('+'))).toEqual(
      bare.groups[0].cutSets.map((c) => c.shortIds.join('+')),
    );
    expect(tagged.groups[0].checks).toBe(bare.groups[0].checks);
    expect(tagged.exitCode).toBe(bare.exitCode);
  });

  withZ3('an undecided check spends the 2 even when the same tree found cut sets', async () => {
    // THE STATE THE EXIT CODE ONCE COULD NOT SEE. `inconclusive` counts trees
    // whose OUTCOME was undecided, and a tree that found an order-2 cut set and
    // left an order-1 check unanswered has outcome `cut-sets` — so it was
    // counted as enumerated, filed no diagnostic, and the run went GREEN over
    // exactly the state §3.9's MUST-NEVER list is about. The undecided CHECKS
    // are counted separately for that reason and spend the 2 on their own.
    //
    // Driven by forcing ONE answer of the real solver to `unknown` — the same
    // status a budget overrun returns — and the check is selected by the
    // premises its script names rather than by a call index, so the case says
    // the same thing if the encoding ever reorders.
    const source = read(REDUNDANT);
    const { model } = await loadModelText(source, { fileName: REDUNDANT });
    if (!model) throw new Error('the probe produced no model');
    const real = await loadZ3();
    if (real.absent) throw new Error('the probe found no solver');
    const wrapped: Z3Backend = {
      ...real,
      async check(script, opts) {
        const out = await real.check(script, opts);
        // The order-1 check that withdraws {BatteryCapacity}: the only script
        // that keeps all three other premises and drops that one.
        const drops = (name: string) => !script.includes(`premise:FaultTreeRedundant::${name}`);
        const forced =
          drops('BatteryCapacity') &&
          !drops('PrimaryOutput') &&
          !drops('BackupOutput') &&
          !drops('RadioDraw');
        return forced
          ? { ...out, status: 'unknown' as const, reason: 'forced', witness: [], core: [] }
          : out;
      },
    };
    const result = await computeFaultTree(model, { backend: wrapped, timeoutMs: 30_000 });
    const [group] = result.groups;
    // The tree is a clean enumeration by its own outcome, and it still has an
    // order-1 check nobody answered.
    expect(group.outcome).toBe('cut-sets');
    expect(group.cutSets.length).toBeGreaterThan(0);
    expect(group.undecided.map((u) => u.order)).toEqual([1]);
    expect(group.singlePointOfFailure).toBeNull();
    const verdict = faultTreeVerdict(result);
    expect(verdict.inconclusive, 'the tree is counted as enumerated — that is the trap').toBe(0);
    expect(verdict.withCutSets).toBe(1);
    expect(verdict.undecidedChecks).toBe(1);
    expect(verdict.exitCode, 'an undecided order-1 check went green').toBe(2);
    // AND IT IS SAID OUT LOUD. Before this row the state filed no diagnostic at
    // all, so the JSON named nothing the exit code was spent on.
    const said = verdict.diagnostics.find((d) => d.code === group.undecided[0].code);
    expect(said, 'the run exited 2 and its diagnostics named nothing').toBeDefined();
    expect(said?.severity).toBe('info');
    expect(said?.message).toContain('NOT decided');
    // MINIMALITY IS NOT CLAIMED OVER A SUBSET NOBODY DECIDED. Every listed set
    // that contains the undecided singleton is a real cut set — each was
    // confirmed against a counterexample — but the singleton inside it may be
    // the cut set, so the word "minimal" is withheld from the row and from the
    // head sentence.
    const supersets = group.cutSets.filter((c) => c.shortIds.includes('BatteryCapacity'));
    expect(supersets.length).toBeGreaterThan(0);
    expect(supersets.every((c) => c.minimal)).toBe(false);
    const unaffected = group.cutSets.filter((c) => !c.shortIds.includes('BatteryCapacity'));
    expect(unaffected.length).toBeGreaterThan(0);
    expect(
      unaffected.every((c) => c.minimal),
      'a set no undecided subset touches lost its minimality claim',
    ).toBe(true);
    expect(group.detail).toContain('NOT shown to be minimal');
    expect(group.detail, 'a set nothing showed to be irreducible was called minimal').not.toContain(
      'minimal cut set(s)',
    );
    for (const c of supersets) expect(c.detail).toContain('MINIMALITY NOT ESTABLISHED');
  });

  withZ3('a tree with no cut set up to the bound is exit 0, and the absence carries it', async () => {
    // THE GREEN PATH, which is the one sentence §3.9 lets this command say
    // about an absence: "no cut set up to order 1 — higher orders not
    // explored". Nothing else in this block executes `return 0`, and an exit
    // contract whose 0 is never taken is a contract nothing holds to.
    //
    // The model is the redundancy fixture with the top requirement's ENERGY
    // clause dropped, so the only thing it asks for is the bus voltage — which
    // two sub-contracts guarantee through the same bound quantity. No single
    // one of them is a cut set, which is what redundancy looks like.
    const source = read(REDUNDANT).replace(
      '        require constraint { sys.battery.usableEnergy >= 300.0 [Wh] }\n',
      '',
    );
    expect(source, 'the energy clause was not dropped').not.toContain('usableEnergy >= 300.0');
    const r = await tree(REDUNDANT, { maxOrder: 1 }, source);
    const [group] = r.groups;
    expect(group.outcome).toBe('no-cut-set');
    expect(group.cutSets).toEqual([]);
    expect(group.undecided).toEqual([]);
    expect(group.code, 'an absence within the bound is not a finding').toBeNull();
    expect(group.singlePointOfFailure, 'every order-1 check was decided and none broke it').toBe(
      false,
    );
    expect(r.noCutSet).toBe(1);
    expect(r.undecidedChecks).toBe(0);
    expect(r.exitCode, 'a fully decided, unbroken tree was not green').toBe(0);
    // EVERY ABSENCE CARRIES ITS BOUND. `Σ C(n,k)` checks up to k say nothing
    // about k+1, and the sentence says so in the same breath as the absence.
    expect(group.detail).toContain('no cut set up to order 1');
    expect(group.detail).toContain(ORDERS_NOT_EXPLORED_NOTE);
    expect(group.detail).toContain('no single point of failure');
    expect(group.detail).toContain(CONTRACT_LEVEL_NOTE);
    // And the same model at the default bound finds the pair, still green:
    // two sub-contracts that must fail TOGETHER is a description of the
    // architecture, not a finding against it.
    const two = await tree(REDUNDANT, { maxOrder: 2 }, source);
    expect(two.groups[0].cutSets.map((c) => c.shortIds.join('+'))).toEqual([
      'PrimaryOutput+BackupOutput',
    ]);
    expect(two.groups[0].singlePointOfFailure).toBe(false);
    expect(two.exitCode, 'an order-2 cut set spent the 1 that belongs to a single point').toBe(0);
  });

  withZ3('reads the bound in BOTH carrier spellings, and never invents one', async () => {
    // §3.9 WRITES THE KEYWORD-LESS FORM — `@SysproseVerification::FaultHypothesis
    // { maxOrder = 2; }` — and the parser stores that as a keyword-less
    // `ReferenceUsage` rather than as an `AttributeUsage`. A reader who copies
    // the carrier out of the specification must not have their bound silently
    // replaced by the default: the bound is the one input of this analysis that
    // is an assumption, and an assumption dropped without a word is the failure
    // the sync handle exists to prevent.
    const carry = (cell: string) =>
      `${SYSPROSE_VERIFICATION_LIBRARY}\n\n${read(REDUNDANT).replace(
        '    requirement def MissionPower {',
        `    requirement def MissionPower {\n        @SysproseVerification::FaultHypothesis { ${cell} }`,
      )}`;
    for (const cell of ['maxOrder = 1;', 'attribute maxOrder = 1;']) {
      const r = await tree(REDUNDANT, {}, carry(cell));
      expect(r.groups[0].maxOrder, `\`${cell}\` was not read`).toBe(1);
      expect(r.groups[0].maxOrderSource).toBe('carrier');
    }
    // A CELL THIS TOOL CANNOT READ IS NOT A DEFAULT. The bound is not guessed
    // at from a malformed cell — inventing one would put a number nobody wrote
    // onto every absence — but the run says the carrier is there and was not
    // read, instead of attributing the assumption to nobody.
    const unreadable = await tree(REDUNDANT, {}, carry('attribute maxOrder = "two";'));
    expect(unreadable.groups[0].maxOrder).toBe(DEFAULT_MAX_ORDER);
    expect(unreadable.groups[0].maxOrderSource).toBe('carrier-unreadable');
    const row = unreadable.diagnostics.find((d) => d.message.includes('FaultHypothesis'));
    expect(row, 'a carrier nobody could read was passed off as the default').toBeDefined();
    expect(row?.severity).toBe('info');
    expect(row?.code).toBe('verification/unsupported-expression');
    // And a model with no carrier at all still says `default`, with no row.
    const bare = await tree(REDUNDANT);
    expect(bare.groups[0].maxOrderSource).toBe('default');
    expect(bare.diagnostics.some((d) => d.message.includes('FaultHypothesis'))).toBe(false);
  });

  it('names every code it can file, borrowed ones included', () => {
    // The constant is what an exit-contract table keys on, so a code this
    // command files that is missing from it would document an exit contract
    // whose loudest 2 — an undecided order-1 check — has no code in the list.
    for (const code of [
      SINGLE_POINT_OF_FAILURE_CODE,
      CONTRACT_SET_VACUOUS_CODE,
      REFINEMENT_FAILED_CODE,
      REFINEMENT_UNDECIDED_CODE,
      'verification/timeout',
      'verification/not-evaluable',
      'verification/tool-absent',
      'verification/unsupported-expression',
    ]) {
      expect(FAULT_TREE_CODES, `${code} is filed by this lane and not declared`).toContain(code);
      expect(VERIFICATION_CODES, `${code} is not in the lane's catalogue`).toContain(code);
    }
  });

  it('decides nothing with no solver, and prints no empty cut-set list', async () => {
    const before = process.env.SYSPROSE_NO_Z3;
    process.env.SYSPROSE_NO_Z3 = '1';
    try {
      const r = await tree(REDUNDANT, { maxOrder: 1 });
      expect(r.toolAbsent).toBe(true);
      expect(r.exitCode).toBe(2);
      const [group] = r.groups;
      // THE BOUND THE READER ASKED FOR, not the one the module defaults to. A
      // run that enumerated nothing must not attribute an order bound to a
      // source the reader did not use — the census reports the bound this
      // command WOULD have enumerated to, and where the number came from.
      expect(group.maxOrder).toBe(1);
      expect(group.maxOrderSource).toBe('flag');
      expect(group.code).toBe('verification/tool-absent');
      expect(group.outcome).toBe('inconclusive');
      // THE CENSUS IS STILL TRUE — an absent solver must not read as a model
      // with no architecture in it — and no absence is claimed over it.
      expect(group.events.length).toBe(4);
      expect(group.cutSets).toEqual([]);
      expect(group.singlePointOfFailure).toBeNull();
      expect(group.detail, 'an absence of failure was claimed with no solver').not.toContain(
        'no cut set',
      );
      expect(r.checks).toBe(0);
    } finally {
      if (before === undefined) delete process.env.SYSPROSE_NO_Z3;
      else process.env.SYSPROSE_NO_Z3 = before;
    }
  });
});

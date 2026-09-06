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
  canonicalElements,
  isUserElement,
  modelVersionOf,
  sha256Hex,
  toolVersion,
  verifyModel,
  type VerifyEngineOption,
  type VerifyReport,
} from '@api/index';
import { loadModelText } from '@text/load';

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
      detail: v.detail,
      premises: v.premises.map((p) => ({ expression: p.expression, holds: p.holds })),
    })),
  };
}

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
      async () => {
        const dir = `test/fixtures/verification/${name}`;
        const meta = JSON.parse(read(`${dir}/meta.json`)) as Meta;
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
 */
describe('L8 — the exit contract holds over the whole corpus', () => {
  const goldens: Array<{ name: string; meta: Meta; golden: Golden }> = [];
  beforeAll(async () => {
    for (const name of caseNames) {
      const meta = JSON.parse(read(`test/fixtures/verification/${name}/meta.json`)) as Meta;
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

  it('covers all three exit codes, both sides of the flag, and an empty run', () => {
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

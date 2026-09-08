/**
 * Counts quoted in prose must match the tree.
 *
 * `test/unit/validation.rules.test.ts` pins `RULES.length` and
 * `test/unit/diagnostic-codes.test.ts` pins catalogue/documentation AGREEMENT,
 * but neither of those looks at the figures a reader actually reads: the
 * sentences in docs/AGENT-AUTHORING-CAMPAIGN.md and docs/FEATURE-PARITY.md, and
 * the comment in src/ui/store.ts. Those repeat the numbers in words, so they
 * could — and did — go stale with a fully green gate. A document that says
 * "measured" has to be measurable, which is what this file makes it.
 *
 * Adding a rule, a diagnostic code or a fixture directory therefore fails here
 * until the prose is updated with it. That is the intent: the edit is one word.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDefinition, type Model } from '@core/index';
import { buildDiagram, buildRequirementsTable } from '@diagram/index';
import {
  connectivityReport,
  modelMetrics,
  orphanReport,
  propertyCheck,
  propertyDraft,
  requirementSatisfaction,
} from '@api/index';
import type { TextRange } from '@validation/types';
import { DIAGNOSTIC_CODES } from '@text/index';
import { loadModelText } from '@text/load';
import { RULES } from '@validation/index';
// The command table itself, for the same reason `RULES` is imported rather than
// counted in prose: the number of subcommands is a fact about the table, and a
// document that quotes it has to be checked against the table and not against
// the last person who remembered.
import { COMMANDS } from '../../scripts/lib/sysprose-spec';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');

/**
 * `ViewKind` is a type, so there is nothing to import at runtime and no exported
 * list of every view (`Toolbar.tsx`'s `VIEW_GROUPS` is module-private): count the
 * union members in the declaration itself.
 */
function viewKindCount(): number {
  const decl = /export type ViewKind =([\s\S]*?);/.exec(read('src/diagram/types.ts'));
  if (!decl) throw new Error('src/diagram/types.ts no longer declares `export type ViewKind`');
  return [...decl[1].matchAll(/'[a-z]+'/g)].length;
}

/**
 * A constant the guide quotes, read out of the source that declares it.
 *
 * `UNDO_LIMIT` and `RECOMPUTE_MAX_WAIT_MS` are module-private in `store.ts`, so
 * there is nothing to import — but a guide that promises "50 steps" and a
 * source that says 30 is the drift this file exists to catch, and the
 * declaration is a stable enough thing to read.
 */
/**
 * How many cases a test file states, counted the way a reader would.
 *
 * A CASE COUNT quoted in prose is exactly as perishable as a rule count and was
 * not guarded: `docs/FEATURE-PARITY.md` and `docs/TEST-REPORT.md` both carried
 * "60 cases" for `U validation.rules` while the file ran seventy-odd, and
 * nothing went red. Counted off the tree here for the same reason the rule
 * count is.
 */
function caseCount(file: string): number {
  return [...read(file).matchAll(/^ *it\(/gm)].length;
}

function sourceNumber(file: string, pattern: RegExp): number {
  const m = pattern.exec(read(file));
  if (!m) throw new Error(`${file} no longer declares ${pattern}`);
  return Number(m[1]);
}

/** What the bundled standard library actually contains, per its own manifest. */
const libraryManifest = JSON.parse(read('src/library/std/manifest.json')) as {
  emittedElementCount: number;
  packages: string[];
};

/** Fixture corpus size — the same `ls … | wc -l` the ledger tells you to run. */
const fixtureCount = readdirSync(root('test/fixtures/agent-authoring'), {
  withFileTypes: true,
}).filter((e) => e.isDirectory()).length;

/**
 * The shipped example models, counted off `examples/`.
 *
 * A guard that arrives after the count it guards has already moved guards
 * nothing, so it lands with the FIRST commit that adds an example rather than
 * with the last one: `examples/` held two models from the first release until
 * `uav-isr-verification.sysml`, and every later commit of the verification plan
 * that ships one now has a real entry to update instead of a no-op edit.
 * Directories are excluded because `examples/` is a flat list of models today
 * and a subdirectory of assets would otherwise read as a third example.
 */
const exampleCount = readdirSync(root('examples'), { withFileTypes: true }).filter(
  (e) => e.isFile() && e.name.endsWith('.sysml'),
).length;

/**
 * The L7 case count the campaign ledger's Levels table quotes.
 *
 * That table's own paragraph says "Every count in this table is read off the
 * tree, not remembered" — and the L7 figure was the one nothing read: it said
 * 12 while its two suites held 48, because a fixture count can be derived with
 * `ls` and a test count cannot. It can be derived HERE, though, at the same
 * grain the row is written in: one `it(` per case, in the two files the row now
 * names. A commit that adds an L7 case fails until the row is updated with it.
 */
function l7CaseCount(): number {
  const files = ['test/campaign/cli.test.ts', 'test/campaign/cli.sysprose.test.ts'];
  return files.reduce(
    (n, f) => n + [...read(f).matchAll(/^[ \t]*it(?:\.\w+)?\(/gm)].length,
    0,
  );
}

/**
 * The L8 case count, which is a directory count like the fixture corpus's.
 *
 * L8 is a SUITE level, so its cases are verdict fixtures rather than rows in
 * `test/fixtures/agent-authoring` — but the Levels table quotes a figure for it
 * all the same, and the paragraph under that table promises every figure in it
 * is read off the tree. `models/` holds the shared `.sysml` files the cases
 * name, not cases, so it is excluded.
 */
function l8CaseCount(): number {
  return readdirSync(root('test/fixtures/verification'), { withFileTypes: true }).filter(
    (e) => e.isDirectory() && e.name !== 'models',
  ).length;
}

/** Every `*.test.ts` / `*.spec.ts` under `dir`, skipping the directories named. */
function specFiles(dir: string, skip: string[] = []): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root(dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!skip.includes(p) && e.name !== 'node_modules') out.push(...specFiles(p, skip));
    } else if (/\.(test|spec)\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * The two file counts docs/CONFORMANCE.md quotes as measured.
 *
 * The scorecard says its numbers are "captured from a live test run", but
 * nothing checked them, so adding one test file left three sentences stale with
 * a green gate — the exact drift the previous commit fixed by hand. Test COUNTS
 * cannot be derived without running the suite, but FILE counts can: they are
 * the same globs vitest.config.ts and playwright.config.ts collect, so a commit
 * that adds a test file fails here until the scorecard is re-measured.
 */
const vitestFileCount = specFiles('test', ['test/e2e']).length + specFiles('src').length;
const e2eSpecCount = specFiles('test/e2e').length;

/**
 * Every place a measured count is written out in prose. `pattern` must capture
 * the number in group 1; `actual` is what the tree says it should be.
 *
 * Whitespace in the patterns is `\s+` on purpose: these figures sit inside
 * hard-wrapped Markdown, so a re-wrap can put a newline mid-phrase.
 */
const CLAIMS: Array<{ file: string; what: string; pattern: RegExp; actual: () => number }> = [
  {
    file: 'docs/AGENT-AUTHORING-CAMPAIGN.md',
    what: 'fixture directories',
    pattern: /\*\*(\d+)\s+fixture\s+directories\*\*/,
    actual: () => fixtureCount,
  },
  {
    file: 'docs/AGENT-AUTHORING-CAMPAIGN.md',
    what: 'catalogue codes',
    pattern: /\*\*(\d+)\s+catalogue\s+codes\*\*/,
    actual: () => DIAGNOSTIC_CODES.length,
  },
  {
    file: 'docs/AGENT-AUTHORING-CAMPAIGN.md',
    what: 'validation rules',
    pattern: /\*\*(\d+)\s+validation\s+rules\*\*/,
    actual: () => RULES.length,
  },
  {
    file: 'docs/AGENT-AUTHORING-CAMPAIGN.md',
    what: 'L7 case count in the Levels table',
    pattern: /\|\s*L7\s*\|[^|]*\|\s*(\d+)\s+tests\s*\|/,
    actual: l7CaseCount,
  },
  {
    file: 'docs/AGENT-AUTHORING-CAMPAIGN.md',
    what: 'L8 case count in the Levels table',
    pattern: /\|\s*L8\s*\|[^|]*\|\s*(\d+)\s+cases\s*\|/,
    actual: l8CaseCount,
  },
  {
    file: 'docs/FEATURE-PARITY.md',
    what: 'rule count in the validation row',
    pattern: /\((\d+)\s+rules,\s+\d+\s+cases\)/,
    actual: () => RULES.length,
  },
  {
    file: 'docs/FEATURE-PARITY.md',
    what: 'rule count in the summary',
    pattern: /(\d+)-rule\s+validation/,
    actual: () => RULES.length,
  },
  {
    file: 'src/ui/store.ts',
    what: 'rule count in the RECOMPUTE comment',
    pattern: /validation\s+\((\d+)\s+rules\)/,
    actual: () => RULES.length,
  },
  {
    file: 'docs/FEATURE-PARITY.md',
    what: 'view count in the view-switching row',
    pattern: /\(all (\d+) `tb-view-\*`\)/,
    actual: viewKindCount,
  },
  {
    file: 'docs/FEATURE-PARITY.md',
    what: 'view count in the summary',
    pattern: /\*\*(\d+) diagram view kinds\*\*/,
    actual: viewKindCount,
  },
  {
    file: 'docs/TEST-REPORT.md',
    what: 'rule count in the validation-engine row',
    pattern: /Validation engine — all (\d+) rules/,
    actual: () => RULES.length,
  },
  {
    file: 'docs/TEST-REPORT.md',
    what: 'rule count in the coverage matrix',
    pattern: /\| Validation — (\d+) rules incl\./,
    actual: () => RULES.length,
  },
  {
    file: 'docs/architecture/05-data-flow.md',
    what: 'rule count in the data-flow diagram',
    pattern: /safeValidate\(model\)\\n(\d+) rules/,
    actual: () => RULES.length,
  },
  {
    file: 'docs/architecture/06-sequence-diagrams.md',
    what: 'rule count in the sequence diagram',
    pattern: /validate\(model\) \[(\d+) rules/,
    actual: () => RULES.length,
  },
  {
    file: 'docs/CONFORMANCE.md',
    what: 'suite file count in the scorecard row',
    pattern: /passed\s+\/\s+0\s+failed\s+\/\s+0\s+skipped\*\*\s+across\s+\*\*(\d+)\s+files\*\*/,
    actual: () => vitestFileCount,
  },
  {
    file: 'docs/CONFORMANCE.md',
    what: 'suite file count in the reproduce command',
    pattern: /0\s+skip,\s+(\d+)\s+files\)/,
    actual: () => vitestFileCount,
  },
  {
    file: 'docs/CONFORMANCE.md',
    what: 'E2E spec-file count in the scorecard row',
    pattern: /E2E\*\*\s+across\s+\*\*(\d+)\s+spec\s+files\*\*/,
    actual: () => e2eSpecCount,
  },
  {
    file: 'docs/CONFORMANCE.md',
    what: 'E2E spec-file count in the reproduce command',
    pattern: /End-to-end\s+\(\d+\s+tests\s+across\s+(\d+)\s+spec\s+files\)/,
    actual: () => e2eSpecCount,
  },
  // ── the command-line surface ──────────────────────────────────────────────
  // Two figures a reader takes at face value and nothing measured: how many
  // subcommands this tool has, and how many models it ships to run them on.
  // Both moved with almost every commit of the verification plan, and both are
  // derivable — the first from the table the dispatcher, `--help` and
  // `docs/CLI-REFERENCE.md` are all rendered from, the second with `readdirSync`.
  {
    file: 'docs/CONFORMANCE.md',
    what: 'subcommand count in the command-line surface row',
    pattern: /\*\*(\d+)\s+subcommands\*\*/,
    actual: () => COMMANDS.length,
  },
  {
    file: 'docs/CONFORMANCE.md',
    what: 'example-model count in the command-line surface row',
    pattern: /\*\*(\d+)\s+shipped\s+example\s+models\*\*/,
    actual: () => exampleCount,
  },
  // ── docs/USER-GUIDE.md ────────────────────────────────────────────────────
  // The guide is written for a person deciding whether to trust the tool, so a
  // figure in it that no longer holds costs more than one in an internal doc.
  // These are the ones it quotes about the TREE; the ones it quotes from a run
  // over the shipped example are measured against that run further down.
  {
    file: 'docs/USER-GUIDE.md',
    what: 'view count in the opening description',
    pattern: /gives\s+you\s+back\s+(\d+)\s+views/,
    actual: viewKindCount,
  },
  {
    file: 'docs/USER-GUIDE.md',
    what: 'rule count in the four-buttons table',
    pattern: /the\s+rule\s+engine\s+\((\d+)\s+rules\)/,
    actual: () => RULES.length,
  },
  {
    file: 'docs/USER-GUIDE.md',
    what: 'standard-library element count',
    pattern: /(\d+)\s+elements\s+in\s+\d+\s*\n?\s*packages/,
    actual: () => libraryManifest.emittedElementCount,
  },
  {
    file: 'docs/USER-GUIDE.md',
    what: 'standard-library package count',
    pattern: /\d+\s+elements\s+in\s+(\d+)\s*\n?\s*packages/,
    actual: () => libraryManifest.packages.length,
  },
  {
    file: 'docs/USER-GUIDE.md',
    what: 'standard-library download size in MB',
    pattern: /(\d+\.\d)\s+MB\s+download/,
    actual: () => Math.round(statSync(root('src/library/std/stdlib.json')).size / 1e5) / 10,
  },
  {
    file: 'docs/FEATURE-PARITY.md',
    what: 'the validation.rules case count',
    pattern: /`U validation\.rules` \(25 rules, (\d+) cases\)/,
    actual: () => caseCount('test/unit/validation.rules.test.ts'),
  },
  {
    file: 'docs/TEST-REPORT.md',
    what: 'the validation.rules case count',
    pattern: /`U validation\.rules` \((\d+) cases\)/,
    actual: () => caseCount('test/unit/validation.rules.test.ts'),
  },
  {
    file: 'docs/USER-GUIDE.md',
    what: 'undo depth',
    pattern: /Undo\s+is\s+(\d+)\s+snapshots\s+deep/,
    actual: () => sourceNumber('src/ui/store.ts', /const UNDO_LIMIT = (\d+);/),
  },
  {
    file: 'docs/USER-GUIDE.md',
    what: 'the derived-surface lag the reader is promised',
    pattern: /lag\s+a\s+burst\s+of\s+edits\s+by\s+up\s+to\s+(\d+)\s*ms/,
    actual: () => sourceNumber('src/ui/store.ts', /const RECOMPUTE_MAX_WAIT_MS = (\d+);/),
  },
  {
    // §8 tells a reader the PNG is bigger than the canvas, which is a promise
    // about a default argument nobody would think to grep for.
    file: 'docs/USER-GUIDE.md',
    what: 'the PNG rasterisation scale',
    pattern: /of\s+the\s+SVG\s+at\s+(\d+)×/,
    actual: () =>
      sourceNumber('src/ui/panels/Toolbar.tsx', /downloadSvgAsPng\([^)]*scale = (\d+)\)/),
  },
];

/**
 * The scorecard's own arithmetic, which nothing else can check.
 *
 * Test COUNTS need a run to derive, so the suite total and the E2E total are
 * transcribed by hand and this file cannot tell a stale one from a fresh one.
 * What it CAN tell is whether the three numbers in that sentence still add up:
 * a commit that updates the suite figure and forgets the "= N green" sum
 * leaves a total that was never true of any run. Two of the three moving
 * together is the ordinary edit; one moving alone is the mistake.
 */
describe('the conformance scorecard adds up', () => {
  it('suite total + E2E total = the green total it claims', () => {
    const m =
      /\*\*(\d[\d,]*)\s+passed\s+\/\s+0\s+failed\s+\/\s+0\s+skipped\*\*\s+across\s+\*\*\d+\s+files\*\*\s+\+\s+\*\*(\d[\d,]*)\s+E2E\*\*[\s\S]*?=\s+\*\*(\d[\d,]*)\s+green\*\*/.exec(
        read('docs/CONFORMANCE.md'),
      );
    expect(m, 'docs/CONFORMANCE.md no longer states "N passed … + M E2E … = T green"').not.toBeNull();
    const [suite, e2e, total] = m!.slice(1, 4).map((n) => Number(n.replace(/,/g, '')));
    expect(suite + e2e, `${suite} + ${e2e} is ${suite + e2e}, but the scorecard claims ${total}`).toBe(
      total,
    );
  });
});

describe('counts quoted in prose', () => {
  for (const claim of CLAIMS) {
    it(`${claim.file} — ${claim.what}`, () => {
      const m = claim.pattern.exec(read(claim.file));
      expect(m, `${claim.file} no longer states a ${claim.what} figure matching ${claim.pattern}`)
        .not.toBeNull();
      expect(
        Number(m![1]),
        `${claim.file} (${claim.what}) says ${m![1]}; the tree says ${claim.actual()} — update the prose`,
      ).toBe(claim.actual());
    });
  }
});

/**
 * The figures the user guide quotes from a run over the shipped example.
 *
 * docs/USER-GUIDE.md shows real transcripts — `2 of 2 requirement(s) satisfied`,
 * `15 port(s), 9 connection(s), 14 connected` — because a guide that describes
 * output in the abstract teaches nobody to read it. A transcript is a claim
 * about a file in this repository, so it is checked against that file: the same
 * model load the command performs, then the same reports it prints.
 *
 * `test/integration/uav-example.test.ts` pins these numbers at the FUNCTION;
 * this pins the sentences a reader reads. Both matter, and they fail
 * differently: one says the report regressed, the other says the documentation
 * did.
 */
describe("the user guide's transcripts of examples/uav-isr.sysml", () => {
  let model: Model;
  let ranges: Map<string, TextRange>;
  let source: string;

  beforeAll(async () => {
    // The full library bind is what the command does, so it is what the
    // transcripts show — every exclusion figure in them is about the library.
    source = read('examples/uav-isr.sysml');
    const loaded = await loadModelText(source, { fileName: 'examples/uav-isr.sysml' });
    model = loaded.model!;
    ranges = loaded.ranges;
  }, 60_000);

  /** The requirement the two `property-*` transcripts are taken over. */
  const massRequirement = (): string => {
    const el = model.all().find((e) => e.declaredName === 'MassRequirement');
    expect(el, 'examples/uav-isr.sysml no longer declares MassRequirement').toBeDefined();
    return el!.id;
  };

  const GUIDE = 'docs/USER-GUIDE.md';
  const claims: Array<{ what: string; pattern: RegExp; actual: () => number }> = [
    {
      what: 'total elements in the stats line',
      pattern: /(\d+) element\(s\) — \d+ node\(s\)/,
      actual: () => modelMetrics(model).totalElements,
    },
    {
      what: 'nodes in the stats line',
      pattern: /\d+ element\(s\) — (\d+) node\(s\)/,
      actual: () => modelMetrics(model).nodeCount,
    },
    {
      what: 'relationships in the stats line',
      pattern: /(\d+) relationship\(s\), \d+ root\(s\)/,
      actual: () => modelMetrics(model).relationshipCount,
    },
    {
      what: 'roots in the stats line',
      pattern: /\d+ relationship\(s\), (\d+) root\(s\)/,
      actual: () => modelMetrics(model).rootCount,
    },
    {
      what: 'max depth in the stats line',
      pattern: /max depth (\d+)/,
      actual: () => modelMetrics(model).maxDepth,
    },
    {
      what: 'library elements in the stats block',
      pattern: /library elements\s+(\d+)/,
      actual: () => modelMetrics(model).libraryElements,
    },
    {
      what: 'the metaclass census — FeatureTyping',
      pattern: /FeatureTyping\s+(\d+)/,
      actual: () => modelMetrics(model).byMetaclass.FeatureTyping,
    },
    {
      what: 'the metaclass census — AttributeUsage',
      pattern: /AttributeUsage\s+(\d+)/,
      actual: () => modelMetrics(model).byMetaclass.AttributeUsage,
    },
    {
      what: 'the metaclass census — PortUsage',
      pattern: /PortUsage\s+(\d+)/,
      actual: () => modelMetrics(model).byMetaclass.PortUsage,
    },
    {
      what: 'requirements satisfied',
      pattern: /(\d+) of \d+ requirement\(s\) satisfied/,
      actual: () => requirementSatisfaction(model).satisfied,
    },
    {
      what: 'requirements in total',
      pattern: /\d+ of (\d+) requirement\(s\) satisfied/,
      actual: () => requirementSatisfaction(model).total,
    },
    {
      what: 'library requirements the report leaves out',
      pattern: /(\d+) bundled library requirement\(s\)/,
      actual: () => requirementSatisfaction(model).libraryExcluded,
    },
    {
      what: 'declared ports',
      pattern: /(\d+) port\(s\), \d+ connection\(s\)/,
      actual: () => connectivityReport(model).portCount,
    },
    {
      what: 'connections',
      pattern: /\d+ port\(s\), (\d+) connection\(s\)/,
      actual: () => connectivityReport(model).connectionCount,
    },
    {
      what: 'connected ports',
      pattern: /\d+ connection\(s\), (\d+) connected/,
      actual: () => connectivityReport(model).connectedPortCount,
    },
    {
      what: 'unconnected ports',
      pattern: /(\d+) unconnected/,
      actual: () => connectivityReport(model).unconnectedPorts.length,
    },
    {
      what: 're-derived requirement copies the report leaves out',
      pattern: /(\d+) re-derived copy\/copies/,
      actual: () => requirementSatisfaction(model).implicitExcluded,
    },
    {
      what: 'unused definitions',
      pattern: /(\d+) of \d+ definition\(s\) unused/,
      actual: () => orphanReport(model).orphans.length,
    },
    // The orphans exclusion line is the EVIDENCE for the paragraph under the
    // transcripts ("every report … says how many it excluded"), which is why it
    // is quoted in full rather than elided, and why all three of its figures
    // are pinned here.
    {
      what: 'namespace packages the orphan report skips',
      pattern: /(\d+) package\(s\) skipped as namespaces/,
      actual: () => orphanReport(model).packagesSkipped,
    },
    {
      what: 'library definitions the orphan report leaves out',
      pattern: /(\d+) library and \d+ re-derived definition\(s\) excluded/,
      actual: () => orphanReport(model).libraryExcluded,
    },
    {
      what: 're-derived definitions the orphan report leaves out',
      pattern: /\d+ library and (\d+) re-derived definition\(s\) excluded/,
      actual: () => orphanReport(model).implicitExcluded,
    },
    {
      what: 'definitions examined for orphans',
      pattern: /\d+ of (\d+) definition\(s\) unused/,
      actual: () => orphanReport(model).definitionsExamined,
    },
    // The §6 property-authoring transcripts. The dictionary size is a fact about
    // this file's feature tree and moves the moment somebody adds an attribute
    // to the UAV, which is exactly the kind of edit that leaves a guide quoting
    // a number no run has produced since.
    {
      what: 'legal names in the property-draft dictionary',
      pattern: /data dictionary — (\d+) legal name\(s\)/,
      actual: () => propertyDraft(model, massRequirement()).dictionary.length,
    },
  ];

  for (const claim of claims) {
    it(claim.what, () => {
      const m = claim.pattern.exec(read(GUIDE));
      expect(m, `${GUIDE} no longer shows a ${claim.what} matching ${claim.pattern}`).not.toBeNull();
      expect(
        Number(m![1]),
        `${GUIDE} (${claim.what}) shows ${m![1]}; the example reports ${claim.actual()} — re-run the command and paste what it says`,
      ).toBe(claim.actual());
    });
  }

  /**
   * The line number `property-check`'s transcript quotes, which is a position in
   * a file rather than a figure in a report.
   *
   * It is the one number in this guide that moves when somebody edits a file
   * NOWHERE NEAR the sentence quoting it: adding three lines anywhere above
   * `MassRequirement` in the shipped example silently makes the transcript point
   * at the wrong place, and a reader following it would put a clause outside the
   * requirement body. Checked against the run rather than remembered.
   */
  it('the insertion line the property-check transcript quotes', async () => {
    const report = await propertyCheck(model, massRequirement(), 'uav.mtow <= 25.0 [kg]', {
      ranges,
      sourceText: source,
    });
    expect(report.range, 'property-check no longer returns an insertion range').not.toBeNull();
    const m = /line (\d+), column 1/.exec(read(GUIDE));
    expect(m, `${GUIDE} no longer shows an insertion line`).not.toBeNull();
    expect(
      Number(m![1]),
      `${GUIDE} shows line ${m![1]}; the run puts the clause on line ${report.range!.start.line}`,
    ).toBe(report.range!.start.line);
  }, 60_000);

  /**
   * Step 2 of the walkthrough is followable to the WRONG picture unless it names
   * the right element.
   *
   * It first told the reader to scope the interconnection view to `uav`, which
   * is `part uav : AirVehicle;` — a usage that owns nothing. Scoping is
   * containment-only (`scopeIds` in src/diagram/build.ts takes `rootId` plus
   * `model.descendants(rootId)`; it never follows a usage's type), so the
   * promised "that assembly's parts and the connections between their ports"
   * came out as one box and no edges. Nothing stopped the reader: `uav` IS a
   * top-level box on the unscoped view, and the context menu offers "Scope
   * diagram to this" on every node.
   *
   * So the element the guide names is read back out of the guide and the
   * diagram is actually built. A future edit that renames it back to a usage
   * fails here rather than in a reader's browser.
   */
  it('the element step 2 tells the reader to scope to really has a diagram under it', () => {
    const named = /Right-click the `([A-Za-z][A-Za-z0-9_]*)` box → \*\*Scope diagram to this\*\*/
      .exec(read(GUIDE));
    expect(named, `${GUIDE} step 2 no longer names the element it scopes to`).not.toBeNull();
    const el = model.all().find((e) => e.declaredName === named![1] && isDefinition(e.eClass));
    expect(el, `examples/uav-isr.sysml has no definition called ${named![1]}`).toBeDefined();
    const scoped = buildDiagram(model, 'interconnection', el!.id);
    expect(
      { nodes: scoped.nodes.length, edges: scoped.edges.length },
      `scoping the interconnection view to ${named![1]} draws ${scoped.nodes.length} node(s) and ${scoped.edges.length} edge(s) — the guide promises parts AND the connections between their ports`,
    ).toEqual({ nodes: 7, edges: 9 });
  });

  /**
   * Step 3 promised "an id" per requirement row; the ID column is empty on both.
   *
   * `attrs.reqId` is set only from a declared short name, and the example writes
   * `attribute id = "R-UAV-001";` — an ordinary child attribute. The table
   * renders its `(id)` placeholder, so a reader following the guide sees the
   * opposite of what it says. The guide now explains that, and this is the
   * assertion that keeps the explanation true.
   */
  it('the requirement rows have the empty ID column step 3 describes', () => {
    const rows = buildRequirementsTable(model).rows;
    expect(rows.length, 'the example has requirement rows').toBeGreaterThan(0);
    expect(
      rows.filter((r) => r.reqId !== '').map((r) => `${r.name} = ${r.reqId}`),
      'a requirement row now HAS an id — §3 of the guide says the ID column reads `(id)`',
    ).toEqual([]);
    expect(read(GUIDE), 'the guide still explains the empty ID column').toContain(
      'The **ID** column reads `(id)`',
    );
  });
});

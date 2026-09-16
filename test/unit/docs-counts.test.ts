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
  behaviourReport,
  connectivityReport,
  modelMetrics,
  orphanReport,
  propertyCheck,
  propertyDraft,
  reachReport,
  requirementSatisfaction,
} from '@api/index';
import type { PropertyVerdict } from '@api/index';
import type { TextRange } from '@validation/types';
import { DIAGNOSTIC_CODES } from '@text/index';
import { SEMANTIC_PROFILE, WITNESS_CLAIMS } from '@api/index';
import { loadModelText } from '@text/load';
import { RULES } from '@validation/index';
import { contractsOf } from '@semantics/index';
// The command table itself, for the same reason `RULES` is imported rather than
// counted in prose: the number of subcommands is a fact about the table, and a
// document that quotes it has to be checked against the table and not against
// the last person who remembered.
import { COMMANDS } from '../../scripts/lib/sysprose-spec';
// The summary generator's pure half, so its refusal to summarise a red run is
// asserted by CALLING it (the script guards its `main()` with `isMainModule`,
// as `gen-cli-reference.ts` does for its own drift test).
import { summarize, type VitestJson } from '../../scripts/gen-test-report';

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
/** A count written out as a word — "six-field" — read back as its number. */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const figure = (text: string, words: boolean | undefined): number => {
  if (!words) return Number(text);
  const n = WORDS.indexOf(text.toLowerCase());
  if (n < 0) throw new Error(`"${text}" is not a number word this file knows`);
  return n;
};

/** The fixture directories of one campaign level, by their `L<n>-` prefix. */
const fixturesAtLevel = (level: string): number =>
  readdirSync(root('test/fixtures/agent-authoring'), { withFileTypes: true }).filter(
    (e) => e.isDirectory() && e.name.startsWith(`${level}-`),
  ).length;

const CLAIMS: Array<{ file: string; what: string; pattern: RegExp; actual: () => number; words?: boolean }> = [
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
  // The D5 paragraph quotes two figures about the campaign file itself: how
  // many of its cases are `withZ3`, and how many blocks start on a fresh
  // module. Both are read off the file, at the grain the sentence uses.
  {
    file: 'docs/AGENT-AUTHORING-CAMPAIGN.md',
    what: 'withZ3 case count in the D5 paragraph',
    pattern: /\*\*(\d+)\s+`withZ3`\s+cases\*\*/,
    actual: () => [...read('test/campaign/verification.test.ts').matchAll(/^[ \t]*withZ3\(/gm)].length,
  },
  {
    file: 'docs/AGENT-AUTHORING-CAMPAIGN.md',
    what: 'solver block count in the D5 paragraph',
    pattern: /\*\*(\d+)\s+solver\s+blocks\*\*/,
    actual: () => [...read('test/campaign/verification.test.ts').matchAll(/beforeAll\(freshModule\)/g)].length,
  },
  // ── the closing commit's re-measurement ───────────────────────────────────
  // Every figure below was hand-pasted once and guarded by nothing: the
  // conformance-suite file count, TEST-REPORT §1's per-directory file counts
  // (which contradicted its own §7 for one commit), the E2E spec-file count in
  // §5, the third mention of the view count, the Levels table's per-level
  // fixture counts, and the semantic profile's arity in prose. Each is
  // derivable off the tree, so each is derived.
  {
    file: 'docs/CONFORMANCE.md',
    what: 'conformance-suite file count in the headline table',
    pattern: /Conformance suite \(`test\/conformance`\)\s*\|\s*\*\*\d+\s+passed\s+\/\s+0\s+failed\*\*\s+across\s+\*\*(\d+)\s+files\*\*/,
    actual: () => specFiles('test/conformance').length,
  },
  {
    file: 'docs/CONFORMANCE.md',
    what: 'conformance-suite file count in the reproduce command',
    pattern: /Just the conformance scorecard suite \(\d+ pass, (\d+) files\)/,
    actual: () => specFiles('test/conformance').length,
  },
  ...(['unit', 'integration', 'conformance', 'server', 'interop', 'campaign'] as const).map((dir) => ({
    file: 'docs/TEST-REPORT.md',
    what: `the ${dir} file count in §1`,
    pattern: new RegExp(String.raw`— ${dir}(?: \([^)]*\))? \| \d+ passed across (\d+) files? \|`),
    actual: () => specFiles(`test/${dir}`).length,
  })),
  {
    file: 'docs/TEST-REPORT.md',
    what: 'the E2E spec-file count in §5',
    pattern: /All\s+\*\*\d+\*\*\s+scenarios\s+across\s+\*\*(\d+)\*\*\s+spec\s+files/,
    actual: () => e2eSpecCount,
  },
  {
    file: 'docs/TEST-REPORT.md',
    what: 'the E2E spec-file count in §1',
    pattern: /\*\*E2E scenarios\*\*\s*\|\s*\*\*\d+\s+passed[^|]*across\s+\*\*(\d+)\s+spec\s+files\*\*/,
    actual: () => e2eSpecCount,
  },
  {
    file: 'docs/TEST-REPORT.md',
    what: 'the suite file count in §1',
    pattern: /\*\*Vitest checks\*\*\s*\|\s*\*\*\d+\s+passed\s+\/\s+0\s+failed\s+\/\s+0\s+skipped\*\*\s+across\s+\*\*(\d+)\s+files\*\*/,
    actual: () => vitestFileCount,
  },
  {
    file: 'docs/TEST-REPORT.md',
    what: 'view count in the graphical-notation pillar row of §7',
    pattern: /\*\*Graphical notation\*\* \((\d+) view kinds\)/,
    actual: viewKindCount,
  },
  // The three remaining statements of the view count in the same report —
  // the §1 scope sentence, the §2.3 heading and the unbolded §8 recap — each
  // in a shape the bolded patterns above cannot match, so the closing review
  // found them unguarded beside three guarded twins.
  {
    file: 'docs/TEST-REPORT.md',
    what: 'view count in the §1 scope sentence',
    pattern: /graphical notation \((\d+) view kinds\)/,
    actual: viewKindCount,
  },
  {
    file: 'docs/TEST-REPORT.md',
    what: 'view count in the §2.3 heading',
    pattern: /View switching — all (\d+) view kinds/,
    actual: viewKindCount,
  },
  {
    file: 'docs/TEST-REPORT.md',
    what: 'view count in the §8 recap',
    pattern: /all (\d+) view switches, the full/,
    actual: viewKindCount,
  },
  ...(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const).map((level) => ({
    file: 'docs/AGENT-AUTHORING-CAMPAIGN.md',
    what: `${level} fixture count in the Levels table`,
    pattern: new RegExp(String.raw`\|\s*${level}\s*\|[^|]*\|\s*(\d+)\s*\|`),
    actual: () => fixturesAtLevel(level),
  })),
  {
    // The derived figure beside the six operands above: every input to the
    // sum was a claim and the sum was not, so a fixture added and its row
    // bumped left the sentence stale with a green gate.
    file: 'docs/AGENT-AUTHORING-CAMPAIGN.md',
    what: 'the L0–L5 sum in the Levels paragraph',
    pattern: /rows above sum to (\d+)/,
    actual: () => ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].reduce((n, level) => n + fixturesAtLevel(level), 0),
  },
  {
    // Trap 83 of the model-checking plan: the arity of the profile is stated in
    // prose in the one document readers treat as measured, and a seventh field
    // would leave the sentence false with a green gate.
    file: 'docs/CONFORMANCE.md',
    what: 'the semantic profile arity in §8.5',
    pattern: /the (\w+)-field semantic profile/,
    actual: () => SEMANTIC_PROFILE.length,
    words: true,
  },
  {
    file: 'docs/USER-GUIDE.md',
    what: 'the semantic profile arity in the reach walkthrough',
    pattern: /names (\w+) things every published formalisation/,
    actual: () => SEMANTIC_PROFILE.length,
    words: true,
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
  // TEST-REPORT quotes the view count nine times and had NONE of them pinned,
  // which is how it came to say 16 in nine places while the union said 17. Two
  // are pinned here — the §2 opening claim and the §4 pillar figure — because
  // they are the two a reader meets first and because they are written in two
  // different shapes, so a future rename cannot silently take both.
  {
    file: 'docs/TEST-REPORT.md',
    what: 'view count in the interaction-surface claim',
    pattern: /all \*\*(\d+) view switches\*\*/,
    actual: viewKindCount,
  },
  {
    file: 'docs/TEST-REPORT.md',
    what: 'view count in the graphical-notation pillar',
    pattern: /\*\*(\d+) ViewKinds\*\*/,
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
  {
    // The README's verification section tells a reader how many subcommands the
    // lane's commands are among, which is the same fact `docs/CONFORMANCE.md`
    // states and the same table both are rendered from. It is quoted in the
    // most-read document in the repository, so it is the one most worth
    // measuring: a reader who counts the Develop block and finds a different
    // number stops believing the rest of the page.
    file: 'README.md',
    what: 'subcommand count in the verification section',
    pattern: /\*\*(\d+)\s+subcommands\*\*/,
    actual: () => COMMANDS.length,
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

  it('the TEST-REPORT bottom line adds up the same way, and to the same figures', () => {
    // The same three numbers, in the other order (green total first, then
    // the suite and E2E figures in a parenthesis, with a line break inside
    // the phrase). One commit moved the two inner figures and left the
    // headline where it was, so the sentence claimed a total no run produced.
    const m =
      /\*\*(\d[\d,]*)\s+green\s+automated\s+checks\*\*\s+\(\*\*(\d[\d,]*)\*\*[\s\S]*?across\s+\*\*(\d+)\s+files\*\*[\s\S]*?\+\s+\*\*(\d[\d,]*)\s+E2E\*\*/.exec(
        read('docs/TEST-REPORT.md'),
      );
    expect(m, 'docs/TEST-REPORT.md no longer states "**T green automated checks** (**N** … across **F files** … + **M E2E**"').not.toBeNull();
    const [total, suite, files, e2e] = m!.slice(1, 5).map((n) => Number(n.replace(/,/g, '')));
    expect(suite + e2e, `${suite} + ${e2e} is ${suite + e2e}, but the bottom line claims ${total}`).toBe(total);
    const c =
      /\*\*(\d[\d,]*)\s+passed\s+\/\s+0\s+failed\s+\/\s+0\s+skipped\*\*\s+across\s+\*\*(\d+)\s+files\*\*\s+\+\s+\*\*(\d[\d,]*)\s+E2E\*\*/.exec(
        read('docs/CONFORMANCE.md'),
      )!;
    expect([suite, files, e2e], 'TEST-REPORT and CONFORMANCE state different suite figures').toEqual(c.slice(1, 4).map((n) => Number(n.replace(/,/g, ''))));
  });
});

describe('counts quoted in prose', () => {
  for (const claim of CLAIMS) {
    it(`${claim.file} — ${claim.what}`, () => {
      const m = claim.pattern.exec(read(claim.file));
      expect(m, `${claim.file} no longer states a ${claim.what} figure matching ${claim.pattern}`)
        .not.toBeNull();
      expect(
        figure(m![1], claim.words),
        `${claim.file} (${claim.what}) says ${m![1]}; the tree says ${claim.actual()} — update the prose`,
      ).toBe(claim.actual());
    });
  }
});

/**
 * The suite totals, quoted in four documents, are one number.
 *
 * Test COUNTS come from a run and cannot be derived here; what can be checked
 * is that the four places quoting them quote the SAME run. `docs/TEST-REPORT.md`
 * §1 carried a table dated three weeks before its own §7 — 1242 tests against
 * 3276 — and `docs/TEST-SUMMARY.md`, which `npm run build` publishes, said 1061
 * over 374 files; nothing reddened. So: CONFORMANCE's scorecard, TEST-REPORT §1
 * and §7, and the generated TEST-SUMMARY are read for the suite total, the file
 * count and the E2E total, and held equal — and §1's sub-rows are held to sum
 * to its own headline, because a table whose rows do not add up to its total
 * was never true of any run.
 */
describe('the suite totals agree across the documents that quote them', () => {
  const num = (s: string) => Number(s.replace(/,/g, ''));
  const conformance = () => {
    const m =
      /\*\*(\d[\d,]*)\s+passed\s+\/\s+0\s+failed\s+\/\s+0\s+skipped\*\*\s+across\s+\*\*(\d+)\s+files\*\*\s+\+\s+\*\*(\d[\d,]*)\s+E2E\*\*\s+across\s+\*\*(\d+)\s+spec\s+files\*\*/.exec(
        read('docs/CONFORMANCE.md'),
      );
    expect(m, 'docs/CONFORMANCE.md no longer states the scorecard row').not.toBeNull();
    const [tests, files, e2e, specs] = m!.slice(1, 5).map(num);
    return { tests, files, e2e, specs };
  };
  const report1 = () => {
    const r = read('docs/TEST-REPORT.md');
    const v = /\*\*Vitest checks\*\*\s*\|\s*\*\*(\d[\d,]*)\s+passed\s+\/\s+0\s+failed\s+\/\s+0\s+skipped\*\*\s+across\s+\*\*(\d+)\s+files\*\*/.exec(r);
    const e = /\*\*E2E scenarios\*\*\s*\|\s*\*\*(\d[\d,]*)\s+passed[^|]*across\s+\*\*(\d+)\s+spec\s+files\*\*/.exec(r);
    const g = /\*\*Grand total\*\*\s*\|\s*\*\*(\d[\d,]*)\s+automated\s+checks\s+passed/.exec(r);
    expect(v, 'TEST-REPORT §1 no longer states the Vitest row').not.toBeNull();
    expect(e, 'TEST-REPORT §1 no longer states the E2E row').not.toBeNull();
    expect(g, 'TEST-REPORT §1 no longer states the grand total').not.toBeNull();
    const rows = [...r.matchAll(/— (unit|integration|conformance|server|interop|campaign)(?: \([^)]*\))? \| (\d+) passed across (\d+) files? \|/g)].map((m) => ({
      dir: m[1],
      tests: num(m[2]),
      files: num(m[3]),
    }));
    return { tests: num(v![1]), files: num(v![2]), e2e: num(e![1]), specs: num(e![2]), total: num(g![1]), rows };
  };
  const summary = () => {
    const s = read('docs/TEST-SUMMARY.md');
    const f = /- \*\*Files:\*\* (\d+)/.exec(s);
    const t = /- \*\*Tests:\*\* (\d+) total — (\d+) passed, (\d+) failed, (\d+) skipped/.exec(s);
    expect(f, 'TEST-SUMMARY no longer states a file count').not.toBeNull();
    expect(t, 'TEST-SUMMARY no longer states a test count').not.toBeNull();
    return { files: num(f![1]), tests: num(t![1]), passed: num(t![2]), failed: num(t![3]), skipped: num(t![4]) };
  };

  it('TEST-REPORT §1 quotes the run CONFORMANCE quotes, and its sub-rows add up to it', () => {
    const c = conformance();
    const r = report1();
    expect({ tests: r.tests, files: r.files, e2e: r.e2e, specs: r.specs }, 'TEST-REPORT §1 and the CONFORMANCE scorecard quote different runs').toEqual(c);
    expect(r.total, 'the grand total is not the sum of the two rows above it').toBe(r.tests + r.e2e);
    expect(r.rows.map((x) => x.dir), 'a test directory is missing from the §1 sub-rows').toEqual([
      'unit',
      'integration',
      'conformance',
      'server',
      'interop',
      'campaign',
    ]);
    expect(r.rows.reduce((n, x) => n + x.tests, 0), 'the §1 sub-rows do not sum to the Vitest total').toBe(r.tests);
    expect(r.rows.reduce((n, x) => n + x.files, 0), 'the §1 sub-rows do not sum to the file count').toBe(r.files);
    // And the file count is the tree's, which also says `src/` holds no test
    // file today — a `*.test.ts` added under `src/` lands in the total and in
    // no sub-row, which is exactly what the previous assertion catches.
    expect(r.files).toBe(vitestFileCount);
  });

  it('the generated TEST-SUMMARY is the run the hand-written documents quote, and records a green one', () => {
    const c = conformance();
    const s = summary();
    expect({ files: s.files, tests: s.tests }, 'docs/TEST-SUMMARY.md was generated from a different run — `npm run report -- --from <the gate’s vitest.json>`').toEqual({
      files: c.files,
      tests: c.tests,
    });
    expect(s.passed + s.failed + s.skipped, 'the Tests line does not add up').toBe(s.tests);
    // The published summary is a GREEN run's. The generator refuses to write
    // one of a red or skipped run (asserted below by calling it), so the only
    // ways this file can record a failure are a hand edit or a generator
    // whose refusal was removed — and both must redden here. (The closing
    // commit's first draft read neither field, arguing that a red summary
    // would be a fixed point the next run could not leave; that was true of
    // the generator BEFORE it refused red runs and is false since, and a
    // review defanged the refusal with its guarding `if` intact and nothing
    // reddened.)
    expect(s.failed, 'the published summary records a failure').toBe(0);
    expect(s.skipped, 'the published summary records a skip').toBe(0);
  });

  it('the generator refuses a red or skipped run and renders a green one', () => {
    // Behavioural, not textual: the refusal is exercised on a synthetic run,
    // not read out of the script's source, so removing the throw reddens
    // this whichever strings stay behind. The shape is vitest's own JSON
    // reporter's, reduced to the fields the generator reads.
    const file = (name: string, statuses: string[]) => ({
      name: resolve(process.cwd(), name),
      assertionResults: statuses.map((status) => ({ status })),
    });
    const green: VitestJson = {
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
      numPendingTests: 0,
      numTotalTestSuites: 7,
      testResults: [file('test/unit/b.test.ts', ['passed']), file('test/unit/a.test.ts', ['passed', 'passed'])],
    };
    expect(() => summarize({ ...green, numPassedTests: 2, numFailedTests: 1 })).toThrow(/records green runs only/);
    expect(() => summarize({ ...green, numPassedTests: 2, numPendingTests: 1 })).toThrow(/records green runs only/);
    const text = summarize(green);
    // Files are counted, not describe blocks (`numTotalTestSuites` is 7 here
    // and must not appear), the totals line is the run's, and the rows are
    // one per file in path order.
    expect(text).toContain('- **Files:** 2');
    expect(text).toContain('- **Tests:** 3 total — 3 passed, 0 failed, 0 skipped');
    expect(text).not.toContain('**Files:** 7');
    expect(text.indexOf('| test/unit/a.test.ts | 2 | 0 | 0 |'), 'per-file rows are in path order').toBeLessThan(
      text.indexOf('| test/unit/b.test.ts | 1 | 0 | 0 |'),
    );
  });

  it('every other suite figure in TEST-REPORT is §1’s, or sits in a section whose opening paragraph brackets it as history', () => {
    // §3 and §4 are the 2026-07-03 run's per-area tables, kept as history and
    // bracketed as such at their head — a reader meets the bracket before the
    // figure. This holds the rule the other way round: a figure of the shape
    // §1 uses that is NOT §1's must sit under such a bracket, so a stale
    // total cannot stand unlabelled anywhere in the report — the footer's
    // re-measured figure included, which is held to §1 by the same rule.
    const r = report1();
    const text = read('docs/TEST-REPORT.md');
    const byDir = new Map(r.rows.map((x) => [x.dir, x]));
    for (const sec of text.split(/^## /m).slice(1)) {
      const title = sec.slice(0, sec.indexOf('\n'));
      const head = sec.slice(0, sec.indexOf('\n|') > 0 ? sec.indexOf('\n|') : sec.length);
      const historical = /\[\d{4}-\d{2}-\d{2}:/.test(head);
      const figures: Array<{ tests: number; files: number; dir?: string }> = [
        ...[...sec.matchAll(/(\d[\d,]*) \/ \d[\d,]* passed across (\d+) files/g)].map((m) => ({ tests: num(m[1]), files: num(m[2]) })),
        ...[...sec.matchAll(/(\d[\d,]*) passed \/\s+0 skipped across (\d+) files/g)].map((m) => ({ tests: num(m[1]), files: num(m[2]) })),
        ...[...sec.matchAll(/\((\d+) files, (\d+) tests\)/g)].map((m) => ({ tests: num(m[2]), files: num(m[1]), dir: 'unit' })),
        ...[...sec.matchAll(/\*\*(\w+) subtotal\*\* \| \*\*(\d+)\*\*[^\n]*\| (\d+) files?/g)].map((m) => ({ dir: m[1].toLowerCase(), tests: num(m[2]), files: num(m[3]) })),
      ];
      for (const f of figures) {
        const current = f.dir === undefined ? { tests: r.tests, files: r.files } : byDir.get(f.dir);
        const isCurrent = current !== undefined && current.tests === f.tests && current.files === f.files;
        // (A historical figure that happens to equal today's — the conformance
        // directory has not moved since that run — is not held either way.)
        expect(
          isCurrent || historical,
          `§"${title}" states ${f.tests} tests across ${f.files} files${f.dir ? ` (${f.dir})` : ''}, which is not §1's, and its opening paragraph carries no dated bracket`,
        ).toBe(true);
      }
    }
  });

  it('the scorecard names W3 by its register kind', () => {
    // §8.5's modality paragraph called W3 "an existential witness" while the
    // register types it `maximality` — the one distinction the plan's §2.3
    // says is load-bearing — and the same sentence then stated the
    // maximality rule. The word is read off the register.
    const m = /register row W3, an? (\w+)\s+witness/.exec(read('docs/CONFORMANCE.md'));
    expect(m, 'docs/CONFORMANCE.md no longer names W3’s witness kind').not.toBeNull();
    expect(m![1]).toBe(WITNESS_CLAIMS.find((w) => w.id === 'W3')!.kind);
  });

  it('the L6 figure in the Levels table is the invariants file’s own row in TEST-SUMMARY', () => {
    // L6 is the one level whose count cannot be read off the tree with a
    // regex — `invariants.test.ts` has thirteen `it(` and one `it.each` — so
    // the Levels table quotes the RUN, and the run's own per-file row is what
    // it is held to.
    const l6 = /\|\s*L6\s*\|[^|]*\|\s*(\d+)\s+assertions\s*\(run-measured\)\s*\|/.exec(read('docs/AGENT-AUTHORING-CAMPAIGN.md'));
    expect(l6, 'the Levels table no longer quotes a run-measured L6 figure').not.toBeNull();
    const row = /\| test\/campaign\/invariants\.test\.ts \| (\d+) \| 0 \| 0 \|/.exec(read('docs/TEST-SUMMARY.md'));
    expect(row, 'TEST-SUMMARY has no row for test/campaign/invariants.test.ts').not.toBeNull();
    expect(num(l6![1]), 'the L6 figure is not what the run recorded for invariants.test.ts').toBe(num(row![1]));
  });
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
    // The `reach` walkthrough's FlightModes transcript. None of its figures was
    // pinned until the trap commit — the guide had been re-pasted by hand
    // twice — so each is read off `reachReport` over the shipped example. The
    // patterns anchor on the FIRST matching line, which is the FlightModes
    // block: the trap-probe transcript further down is pinned separately by
    // its own machine name.
    {
      what: 'configurations explored in the reach transcript',
      pattern: /(\d+) configuration\(s\) explored, depth \d+ — exhaustive/,
      actual: () => reachReport(model).machines[0].configs,
    },
    {
      what: 'depth in the reach transcript',
      pattern: /\d+ configuration\(s\) explored, depth (\d+) — exhaustive/,
      actual: () => reachReport(model).machines[0].depth,
    },
    {
      what: 'reachable states in the reach transcript',
      pattern: /(\d+) of \d+ state\(s\) reachable/,
      actual: () => reachReport(model).machines[0].states.reachable.length,
    },
    {
      what: 'states in total in the reach transcript',
      pattern: /\d+ of (\d+) state\(s\) reachable/,
      actual: () => reachReport(model).machines[0].states.total,
    },
    {
      what: 'transitions fired in the reach transcript',
      pattern: /(\d+) of \d+ transition\(s\) fired/,
      actual: () => reachReport(model).machines[0].transitions.fired,
    },
    {
      what: 'transitions in total in the reach transcript',
      pattern: /\d+ of (\d+) transition\(s\) fired/,
      actual: () => reachReport(model).machines[0].transitions.total,
    },
    {
      what: 'dead transitions in the reach transcript',
      pattern: /transition\(s\) fired, (\d+) dead/,
      actual: () => reachReport(model).machines[0].transitions.dead.length,
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
   * The trap-probe transcript under the same walkthrough, pinned against ITS
   * file. Anchored on the machine's own block, because the FlightModes block
   * above it matches the same shapes first.
   */
  describe('the trap-probe transcript', () => {
    let probe: Model;
    beforeAll(async () => {
      const file = 'test/fixtures/verification/models/trap-probe.sysml';
      probe = (await loadModelText(read(file), { fileName: file })).model!;
    }, 60_000);
    const block = () => {
      const m = /TrapProbe::Probe::Modes \[StateDefinition\]\n([\s\S]*?)\n  semantic profile/.exec(
        read(GUIDE),
      );
      expect(m, `${GUIDE} no longer shows the trap-probe block`).not.toBeNull();
      return m![1];
    };
    const probeClaims: Array<{ what: string; pattern: RegExp; actual: () => number }> = [
      {
        what: 'configurations explored',
        pattern: /(\d+) configuration\(s\) explored, depth \d+/,
        actual: () => reachReport(probe).machines[0].configs,
      },
      {
        what: 'depth',
        pattern: /configuration\(s\) explored, depth (\d+)/,
        actual: () => reachReport(probe).machines[0].depth,
      },
      {
        what: 'transitions fired',
        pattern: /(\d+) of \d+ transition\(s\) fired/,
        actual: () => reachReport(probe).machines[0].transitions.fired,
      },
      {
        what: 'configurations in the trap',
        pattern: /trap {2,}\{[^}]*\} — (\d+) configuration\(s\) nothing leaves/,
        actual: () => reachReport(probe).machines[0].traps[0].configs,
      },
      {
        what: 'steps into the trap',
        pattern: /nothing leaves; entered in (\d+) step\(s\)/,
        actual: () => reachReport(probe).machines[0].traps[0].steps,
      },
    ];
    for (const claim of probeClaims) {
      it(claim.what, () => {
        const m = claim.pattern.exec(block());
        expect(m, `${GUIDE} trap-probe block no longer shows ${claim.what}`).not.toBeNull();
        expect(
          Number(m![1]),
          `${GUIDE} (trap-probe ${claim.what}) shows ${m![1]}; the fixture reports ${claim.actual()} — re-run the command and paste what it says`,
        ).toBe(claim.actual());
      });
    }
    it('names the trap by its states, and the finding code beneath it', () => {
      expect(block()).toContain('trap         {failsafe, failsafeHold}');
      expect(read(GUIDE)).toContain(
        'verification/unrecoverable-mode  trap — 2 configuration(s) form a set nothing leaves: {failsafe, failsafeHold}. Entered in 3 step(s) from `standby`.',
      );
    });
  });

  /**
   * The `recovery` transcript on the trap probe, pinned against ITS file: the
   * two numbers of §3.2b — the cannot-reach count and the trap overlap — the
   * nearest entry depth, and the machine's configuration count, each read off
   * `behaviourReport` rather than remembered. Anchored on the row's own
   * `not recoverable:` sentence, which no other transcript in the guide prints.
   */
  describe('the recovery transcript', () => {
    let probe: Model;
    let row: PropertyVerdict;
    beforeAll(async () => {
      const file = 'test/fixtures/verification/models/trap-probe.sysml';
      probe = (await loadModelText(read(file), { fileName: file })).model!;
      const machine = probe.all().find((e) => probe.qualifiedName(e.id) === 'TrapProbe::Probe::Modes');
      expect(machine, 'trap-probe.sysml no longer declares TrapProbe::Probe::Modes').toBeDefined();
      row = behaviourReport(probe, {
        machineId: machine!.id,
        pattern: 'pattern=recovery, scope=globally, p=state standby',
      }).properties[0];
      expect(row.claim).toBe('fail');
    }, 60_000);
    const block = () => {
      const m = /pattern=recovery, scope=globally, p=state standby'\n([\s\S]*?)\n  semantic profile/.exec(read(GUIDE));
      expect(m, `${GUIDE} no longer shows the recovery transcript`).not.toBeNull();
      return m![1];
    };
    const recoveryClaims: Array<{ what: string; pattern: RegExp; actual: () => number }> = [
      {
        what: 'configurations that cannot reach the state',
        pattern: /not recoverable: (\d+) configuration\(s\) cannot reach/,
        actual: () => row.recovery!.cannotReach!,
      },
      {
        what: 'configurations in the trap',
        pattern: /Of these, (\d+) form a set nothing leaves/,
        actual: () => row.recovery!.bottomSccOverlap!,
      },
      {
        what: 'steps to the nearest',
        pattern: /the nearest is entered in (\d+) step\(s\)/,
        actual: () => Number(/entered in (\d+) step/.exec(row.detail)![1]),
      },
      {
        what: 'configurations explored',
        pattern: /(\d+) configuration\(s\) explored — exhaustive/,
        actual: () => row.machineConfigs,
      },
    ];
    for (const claim of recoveryClaims) {
      it(claim.what, () => {
        const m = claim.pattern.exec(block());
        expect(m, `${GUIDE} recovery block no longer shows ${claim.what}`).not.toBeNull();
        expect(
          Number(m![1]),
          `${GUIDE} (recovery ${claim.what}) shows ${m![1]}; the fixture reports ${claim.actual()} — re-run the command and paste what it says`,
        ).toBe(claim.actual());
      });
    }
    it('quotes the detail sentence exactly as the row composes it', () => {
      expect(block()).toContain(`    ${row.detail}\n`);
    });
  });

  /**
   * The `every run?` line the `check-behaviour` transcript shows, checked
   * against the run rather than remembered.
   *
   * It is the one line of that transcript with no figure in it, so the count
   * claims above cannot see it move — and it moves whenever the modality's
   * sentence, the simulator sentence folded into it, or the avoiding cycle on
   * `FlightModes` changes. The transcript prints the line exactly as
   * `propertyLines` composes it, so the whole sentence is the claim.
   */
  it('the modality line the check-behaviour transcript quotes', () => {
    const machine = model.all().find((e) => e.declaredName === 'FlightModes');
    expect(machine, 'examples/uav-isr.sysml no longer declares FlightModes').toBeDefined();
    const report = behaviourReport(model, {
      machineId: machine!.id,
      pattern: 'pattern=absence, scope=globally, p=state failsafe',
    });
    const row = report.properties[0];
    expect(row.claim).toBe('fail');
    expect(row.modality, 'the fail row carries no modality').not.toBeNull();
    expect(row.modality!.value).toBe('potential');
    expect(read(GUIDE)).toContain(`    every run? ${row.modality!.sentence}\n`);
  });

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
  /**
   * The `refine` transcript, pinned against the same behaviour §3 is about.
   *
   * The guide's transcript first read `R-PWR-000 on \`…::PowerSystem\` — refined`,
   * and the tool prints `UAVPowerBudget::PowerBudget` there: `attribute id =
   * "R-PWR-000";` is an ordinary child attribute and not a declared short name,
   * so `shortId` is empty for every contract in that example. It is the SAME
   * pinned behaviour as the empty ID column above, met in a second place, and
   * nothing guarded the transcript — so this does.
   */
  it('the refine transcript names the contract the way the tool does', async () => {
    const source = read('examples/uav-power-budget.sysml');
    const loaded = await loadModelText(source, { fileName: 'examples/uav-power-budget.sysml' });
    expect(loaded.model, 'the power-budget example no longer loads').toBeDefined();
    const budget = contractsOf(loaded.model!).find(
      (c) => c.qualifiedName === 'UAVPowerBudget::PowerBudget',
    );
    expect(budget, 'the example no longer states the contract the transcript is about').toBeDefined();
    expect(
      budget!.shortId,
      '`attribute id` is not a declared short name — if that changed, the transcript may quote it',
    ).toBe('');
    expect(
      read(GUIDE),
      'the guide transcript quotes a short id the report does not print',
    ).toContain('UAVPowerBudget::PowerBudget on `UAVPowerBudget::PowerSystem` — refined');
  });

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

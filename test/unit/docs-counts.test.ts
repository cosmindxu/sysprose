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
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DIAGNOSTIC_CODES } from '@text/index';
import { RULES } from '@validation/index';

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

/** Fixture corpus size — the same `ls … | wc -l` the ledger tells you to run. */
const fixtureCount = readdirSync(root('test/fixtures/agent-authoring'), {
  withFileTypes: true,
}).filter((e) => e.isDirectory()).length;

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

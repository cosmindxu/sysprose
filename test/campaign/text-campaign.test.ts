/**
 * The agent text-authoring campaign — golden comparison.
 *
 * One test per fixture: check the flawed `input.sysml` and assert the tool
 * reported what an agent needs to repair it. See `docs/AGENT-TEXT-CAMPAIGN.md`
 * for the design and `test/campaign/harness.ts` for the matching rules.
 *
 * Regenerate goldens with `CAMPAIGN_UPDATE=1 npx vitest run test/campaign`.
 * A regenerated golden is a DRAFT: it records what the tool does today, which
 * is not the same as what an agent needs. Read every diff before committing.
 */
import { describe, it, expect } from 'vitest';
import { checkText } from '@text/check';
import { loadCases, goldenFailures, asGolden, writeGolden, UPDATING } from './harness';

const cases = loadCases();

describe('agent text campaign — fixtures', () => {
  it('finds the fixture corpus', () => {
    expect(cases.length).toBeGreaterThan(30);
  });

  for (const c of cases) {
    const label = `${c.golden.level} ${c.name} — ${c.golden.title}`;
    it(label, async () => {
      const report = await checkText(c.input, {
        library: 'full',
        fileName: c.name === 'L0-wrong-extension' ? 'model.txt.bak' : `${c.name}.sysml`,
      });
      if (UPDATING) {
        writeGolden(c, report);
        return;
      }
      const problems = goldenFailures(c.golden, report);
      if (c.golden.expectFail) {
        // A known shortfall. It must STILL be a shortfall: if this starts
        // passing, the tool improved and the fixture should be promoted.
        expect(
          problems.length,
          `KNOWN-FAILING case now passes — promote it by removing "expectFail" (${c.golden.expectFail.reason})`,
        ).toBeGreaterThan(0);
        return;
      }
      expect(
        problems,
        `${label}\n${problems.join('\n')}\n\nactual report as a golden:\n${asGolden(c.golden, report)}`,
      ).toEqual([]);
    });
  }
});

describe('agent text campaign — repairs', () => {
  for (const c of cases.filter((x) => x.fixed !== undefined)) {
    it(`${c.name}: the documented repair checks clean`, async () => {
      const report = await checkText(c.fixed as string, {
        library: 'full',
        fileName: `${c.name}.fixed.sysml`,
      });
      expect(
        report.summary.errors,
        `fixed.sysml should have no errors, got:\n${report.diagnostics
          .filter((d) => d.severity === 'error')
          .map((d) => `  ${d.code} @${d.range?.start.line}: ${d.message}`)
          .join('\n')}`,
      ).toBe(0);
    });
  }
});

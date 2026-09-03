/**
 * The agent authoring testing campaign — golden comparison.
 *
 * One test per fixture: check the flawed `input.sysml` and assert the tool
 * reported what an agent needs to repair it. See `docs/AGENT-AUTHORING-CAMPAIGN.md`
 * for the design and `test/campaign/harness.ts` for the matching rules.
 *
 * Regenerate goldens with `CAMPAIGN_UPDATE=1 npx vitest run test/campaign`.
 * A regenerated golden is a DRAFT: it records what the tool does today, which
 * is not the same as what an agent needs. Read every diff before committing.
 */
import { describe, it, expect } from 'vitest';
import { checkText } from '@text/check';
import { loadCases, goldenFailures, asGolden, matches, writeGolden, UPDATING } from './harness';

const cases = loadCases();

describe('agent authoring campaign — fixtures', () => {
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

describe('agent authoring campaign — repairs', () => {
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

      // The repair must actually REPAIR: none of the codes this case exists to
      // teach may survive in fixed.sysml at error or warning severity. Checking
      // errors alone let a documented repair reproduce the very warning it
      // claimed to fix (the phantom-port hint, found 2026-09-02). Info-level
      // outcomes are tolerated: a repair can legitimately leave an unevaluable
      // constraint behind.
      const taught = new Set(
        c.golden.diagnostics
          .filter((d) => d.severity === undefined || d.severity !== 'info')
          .map((d) => d.code),
      );
      const survivors = report.diagnostics.filter(
        (d) => d.severity !== 'info' && d.code !== undefined && taught.has(d.code),
      );
      expect(
        survivors.map((d) => `${d.code} @${d.range?.start.line}: ${d.message}`),
        `fixed.sysml still reports the code(s) this case is about`,
      ).toEqual([]);

      // An INFO golden that pins a MESSAGE is pinning a specific fault, not
      // merely "something here is unevaluable": that message must be gone from
      // the repair. Without this a case whose only golden diagnostic is an info
      // (L4-dimension-clash) had a vacuous repair test — an unchanged copy of
      // `input.sysml` passed it. The two L2 syntax cases stay exempt: their
      // info goldens pin no message precisely because a repaired-but-still-
      // unevaluable constraint is the honest outcome there.
      const pinnedMessages = c.golden.diagnostics.filter(
        (d) => d.severity === 'info' && d.message !== undefined,
      );
      const reappeared = report.diagnostics.filter((d) =>
        pinnedMessages.some((exp) => matches({ ...exp, line: '*', column: '*' }, d)),
      );
      expect(
        reappeared.map((d) => `${d.code} @${d.range?.start.line}: ${d.message}`),
        `fixed.sysml still reports the very message this case teaches`,
      ).toEqual([]);
    });
  }
});

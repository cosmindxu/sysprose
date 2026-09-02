/**
 * Scenario 8 — the API console over the live SDK:
 *  - run a JSON query and confirm rows are tabulated,
 *  - run the one-click Metrics and Requirement-satisfaction analytics,
 *  - confirm `window.sysml` is the live SDK.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, openTab, shot } from './fixtures';

test('API console runs a query and analytics; window.sysml is the live SDK', async ({ page }) => {
  await gotoApp(page);
  await openTab(page, 'tab-api');

  const query = page.getByTestId('api-query');
  const results = page.getByTestId('api-results');
  await expect(query).toBeVisible();

  // ── Run a JSON query for all PartDefinitions ──
  await query.fill(
    JSON.stringify({
      constraint: { property: '@type', operator: '=', value: 'PartDefinition' },
    }),
  );
  await page.getByTestId('api-run').click();

  // A results table appears with at least one row (Vehicle / Engine).
  await expect(results.locator('table.api-table')).toBeVisible();
  expect(await results.locator('tbody tr').count()).toBeGreaterThanOrEqual(1);
  await expect(results).toContainText('PartDefinition');
  await shot(page, '08a-query');

  // ── Metrics ──
  await page.getByTestId('api-metrics').click();
  await expect(results).toContainText('Model metrics');
  await shot(page, '08b-metrics');

  // ── Requirement satisfaction ──
  await page.getByTestId('api-satisfaction').click();
  await expect(results).toContainText('Requirement satisfaction');
  await shot(page, '08c-satisfaction');

  // ── window.sysml is the live SDK ──
  const partDefCount = await page.evaluate(
    () =>
      (window as unknown as { sysml: { elementsOfType: (t: string) => unknown[] } }).sysml
        .elementsOfType('PartDefinition').length,
  );
  expect(partDefCount).toBeGreaterThan(0);

  // ── Versioning affordance: Commit snapshots the model and lists commit ids ──
  const commitId = page.getByTestId('api-commit-id');
  await expect(commitId).toHaveText('commit-1'); // seeded initial commit
  await page.getByTestId('api-commit').click();
  await expect(commitId).toHaveText('commit-2');
  await expect(page.getByTestId('api-commit-list')).toContainText('commit-1, commit-2');
  await shot(page, '08d-commit');

  // window.sysml exposes the same version history.
  const headId = await page.evaluate(
    () => (window as unknown as { sysml: { headCommitId: () => string } }).sysml.headCommitId(),
  );
  expect(headId).toBe('commit-2');
});

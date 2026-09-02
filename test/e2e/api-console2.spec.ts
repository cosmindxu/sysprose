/**
 * API Console — second pass, focused on the where-used analytic and the full
 * query → analytics → history surface that the first api-console spec doesn't
 * fully cover.
 *
 *  - run a JSON query (api-query + api-run) → tabulated api-results rows;
 *  - each analytics button (api-metrics, api-satisfaction, api-whereused)
 *    renders a result into api-results;
 *  - the commit/history affordance (api-commit → api-commit-id/api-commit-list)
 *    advances the head and lists the commit ids;
 *  - `window.sysml` exposes the live SDK.
 */

import { test, expect } from '@playwright/test';
import { findElementId, gotoApp, openTab, selectElementById, shot } from './fixtures';

test('API console: query, metrics, satisfaction, where-used, and commit history', async ({
  page,
}) => {
  await gotoApp(page);
  await openTab(page, 'tab-api');

  const query = page.getByTestId('api-query');
  const results = page.getByTestId('api-results');
  await expect(query).toBeVisible();

  // ── Query: all PartUsages → tabulated rows ──
  await query.fill(
    JSON.stringify({ constraint: { property: '@type', operator: '=', value: 'PartUsage' } }),
  );
  await page.getByTestId('api-run').click();
  await expect(results.locator('table.api-table')).toBeVisible();
  expect(await results.locator('tbody tr').count()).toBeGreaterThanOrEqual(1);
  await expect(results).toContainText('PartUsage');
  await shot(page, 'api2-query');

  // ── Metrics ──
  await page.getByTestId('api-metrics').click();
  await expect(results).toContainText('Model metrics');

  // ── Requirement satisfaction ──
  await page.getByTestId('api-satisfaction').click();
  await expect(results).toContainText('Requirement satisfaction');

  // ── Where-used (needs a selection): select the Vehicle definition, which is
  //    referenced by the typed `vehicle` part and the satisfy relationship. ──
  const vehicleDefId = await findElementId(page, 'PartDefinition', 'Vehicle');
  await selectElementById(page, vehicleDefId);
  await openTab(page, 'tab-api'); // selecting in the tree doesn't leave the tab, but be explicit
  await page.getByTestId('api-whereused').click();
  await expect(results).toContainText('Where used');
  await shot(page, 'api2-whereused');

  // ── Commit history advances and lists ids ──
  const commitId = page.getByTestId('api-commit-id');
  await expect(commitId).toHaveText('commit-1');
  await page.getByTestId('api-commit').click();
  await expect(commitId).toHaveText('commit-2');
  await expect(page.getByTestId('api-commit-list')).toContainText('commit-1, commit-2');
  await shot(page, 'api2-commit');

  // ── window.sysml is the live SDK ──
  const [partDefs, head] = await page.evaluate(() => {
    const api = (
      window as unknown as {
        sysml: { elementsOfType: (t: string) => unknown[]; headCommitId: () => string };
      }
    ).sysml;
    return [api.elementsOfType('PartDefinition').length, api.headCommitId()] as const;
  });
  expect(partDefs).toBeGreaterThan(0);
  expect(head).toBe('commit-2');
});

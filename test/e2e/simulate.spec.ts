/**
 * Scenario — execution/simulation surface: build a small action flow through the
 * live `window.sysml` SDK, click the toolbar "Simulate" affordance, and confirm
 * the trace is surfaced in the Problems tab as navigable info rows.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, openTab, shot } from './fixtures';

/** SDK surface (subset) used to author an action flow in-page. */
interface SimSdk {
  create(eClass: string, opts: Record<string, unknown>): { id: string };
}

test('Simulate runs the active action flow and lists its trace in Problems', async ({ page }) => {
  await gotoApp(page);

  // Author: DriveE2E { ignite → accelerate } directly on the live model.
  await page.evaluate(() => {
    const api = (window as unknown as { sysml: SimSdk }).sysml;
    const act = api.create('ActionDefinition', { declaredName: 'DriveE2E' });
    const a = api.create('ActionUsage', { declaredName: 'ignite', ownerId: act.id });
    const b = api.create('ActionUsage', { declaredName: 'accelerate', ownerId: act.id });
    api.create('Succession', { ownerId: act.id, source: [a.id], target: [b.id] });
  });

  await page.getByTestId('tb-simulate').click();
  await openTab(page, 'tab-problems');

  const rows = page.getByTestId('problem-row');
  await expect(rows.first()).toBeVisible();
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'Action flow' }).first(),
  ).toBeVisible();
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'ignite' }).first(),
  ).toBeVisible();
  await shot(page, 'sim-a-trace');

  // A trace step row carries the underlying element id (navigable).
  const stepRow = page.getByTestId('problem-row').filter({ hasText: 'ignite' }).first();
  const elementId = await stepRow.getAttribute('data-elementid');
  expect(elementId).toBeTruthy();
});

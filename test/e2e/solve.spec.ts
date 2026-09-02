/**
 * Scenario — parametric numeric solving: author a small parametric chain through
 * the live `window.sysml` SDK, switch to the Parametric view, click the toolbar
 * "Solve" affordance (`tb-solve`), and confirm the solved values / MoE results
 * are surfaced in the Problems tab as navigable info rows.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, openTab, shot } from './fixtures';

/** SDK surface (subset) used to author the parametric model in-page. */
interface SolveSdk {
  create(eClass: string, opts: Record<string, unknown>): { id: string };
}

test('Solve computes parametric values + MoEs and lists them in Problems', async ({ page }) => {
  await gotoApp(page);

  // Author: Dynamics { mass=1500, acceleration=2, force = mass*acceleration,
  // forceMoE (a measure) } directly on the live model.
  await page.evaluate(() => {
    const api = (window as unknown as { sysml: SolveSdk }).sysml;
    const def = api.create('PartDefinition', { declaredName: 'DynamicsE2E' });
    api.create('AttributeUsage', { declaredName: 'mass', ownerId: def.id, attrs: { value: 1500 } });
    api.create('AttributeUsage', {
      declaredName: 'acceleration',
      ownerId: def.id,
      attrs: { value: 2 },
    });
    api.create('AttributeUsage', {
      declaredName: 'forceMoE',
      ownerId: def.id,
      attrs: { value: 'mass * acceleration' },
    });
  });

  // Switch to the Parametric view, then run Solve.
  await page.getByTestId('tb-view-parametric').click();
  await page.getByTestId('tb-solve').click();
  await openTab(page, 'tab-problems');

  const rows = page.getByTestId('problem-row');
  await expect(rows.first()).toBeVisible();

  // The header reports convergence.
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'Solve:' }).first(),
  ).toBeVisible();

  // A solved value row for the computed force (= 3000).
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'forceMoE = 3000' }).first(),
  ).toBeVisible();

  // The measure of effectiveness is reported (navigable to its element).
  const moeRow = page.getByTestId('problem-row').filter({ hasText: 'MoE:' }).first();
  await expect(moeRow).toBeVisible();
  const elementId = await moeRow.getAttribute('data-elementid');
  expect(elementId).toBeTruthy();

  await shot(page, 'solve-parametric');
});

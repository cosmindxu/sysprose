/**
 * The validation *loop*, not just the validation *report*.
 *
 * `validation.spec.ts` proves a duplicate-name problem shows up and navigates.
 * What a modeller actually does next is fix it — so this test walks the round
 * trip: break the model through the GUI, see the finding, repair it through the
 * Properties form, re-run Validate, and confirm the finding is gone while the
 * rest of the report is untouched.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, openTab, shot } from './fixtures';
import { addChild, renameInTree, setPropName } from './model-helpers';

test('a duplicate-name finding clears once the user renames the offender', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const dupRows = page.getByTestId('problem-row').filter({ hasText: 'Duplicate name' });

  // ── Baseline: validate the pristine sample ──
  await page.getByTestId('tb-validate').click();
  await openTab(page, 'tab-problems');
  const dupBaseline = await dupRows.count();

  // ── Break it: a second sibling PartDefinition also called "Vehicle" ──
  const rootId = await findElementId(page, 'Package', 'VehicleModel');
  const clashId = await addChild(page, rootId, 'PartDefinition');
  await renameInTree(page, clashId, 'Vehicle');

  await page.getByTestId('tb-validate').click();
  await openTab(page, 'tab-problems');
  await expect.poll(() => dupRows.count()).toBeGreaterThan(dupBaseline);
  // The report points at the element we just created.
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'Duplicate name' }).first(),
  ).toBeVisible();
  const flagged = await dupRows.evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('data-elementid')),
  );
  expect(flagged).toContain(clashId);
  await shot(page, 'fixloop-a-broken');

  // ── Fix it through the Properties form ──
  await setPropName(page, clashId, 'VehicleVariant');

  await page.getByTestId('tb-validate').click();
  await openTab(page, 'tab-problems');
  await expect.poll(() => dupRows.count()).toBe(dupBaseline);
  const stillFlagged = await dupRows.evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('data-elementid')),
  );
  expect(stillFlagged).not.toContain(clashId);
  await shot(page, 'fixloop-b-fixed');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

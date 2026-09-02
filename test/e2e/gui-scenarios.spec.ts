import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';

/**
 * Regroup what-if scenarios: save named snapshots of the bundle assignment,
 * reload one, and diff two (which parts moved between bundles).
 */
test('regroup: save, list, diff and delete what-if scenarios', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-regroup').click();
  await expect(page.getByTestId('regroup-view')).toBeVisible();
  await expect(page.getByTestId('regroup-scenarios')).toBeVisible();

  // Save the current (base) config.
  await page.getByTestId('scenario-name').fill('base');
  await page.getByTestId('scenario-save').click();
  await expect(page.getByTestId('scenario-list')).toContainText('base');

  // Change the assignment (seed from clusters), then save a second scenario.
  await page.getByTestId('regroup-seed').click();
  await page.getByTestId('scenario-name').fill('seeded');
  await page.getByTestId('scenario-save').click();
  await expect(page.getByTestId('scenario-list').locator('li')).toHaveCount(2);

  // Pick both → the diff panel appears comparing them.
  await page.getByTestId('scenario-pick').nth(0).check();
  await page.getByTestId('scenario-pick').nth(1).check();
  const diff = page.getByTestId('scenario-diff');
  await expect(diff).toBeVisible();
  await expect(diff).toContainText(/change/);

  // Reload the base scenario.
  await page.getByTestId('scenario-load').first().click();

  // Delete a scenario → the list shrinks.
  await page.getByTestId('scenario-delete').first().click();
  await expect(page.getByTestId('scenario-list').locator('li')).toHaveCount(1);

  // Scenarios persist across a reload (localStorage-backed).
  await page.reload();
  await page.getByTestId('tb-view-regroup').click();
  await expect(page.getByTestId('scenario-list').locator('li')).toHaveCount(1);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

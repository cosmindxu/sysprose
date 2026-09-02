import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Diagram legend: a collapsible bottom-left overlay listing the relationship
 * notation families present in the ACTIVE view.
 */
test('canvas: the legend lists the notation families present in the view', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const toggle = page.getByTestId('legend-toggle');
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId('legend-list')).toHaveCount(0); // collapsed by default

  await toggle.click();
  const list = page.getByTestId('legend-list');
  await expect(list).toBeVisible();
  // The general view carries a «satisfy» (dependency family) + specialization.
  await expect(list.locator('li')).not.toHaveCount(0);
  await expect(list).toContainText(/Dependency|Specialization|Composition/);
  await shot(page, '84-legend');

  // Collapses again.
  await toggle.click();
  await expect(page.getByTestId('legend-list')).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

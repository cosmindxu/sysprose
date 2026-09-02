import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Palette polish:
 *  - per-metaclass tool glyphs + a clearer armed-tool hint naming the tool;
 *  - Escape disarms the pending tool (matches the Cancel affordance);
 *  - the palette column is HIDDEN on the non-graph views (table/analysis/…),
 *    where it would only be dead space, and returns on a diagram view.
 */
test('palette: armed-tool hint + Escape-cancel; hidden on non-graph views', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  const viewbar = page.locator('.viewbar');

  // Graph view (General): the palette is present with tools.
  await expect(page.getByTestId('palette')).toBeVisible();
  await expect(page.getByTestId('palette-tool').first()).toBeVisible();

  // Arm the Part tool → the hint names it and the tool shows active.
  const partTool = page.locator('[data-testid="palette-tool"][data-kind="PartUsage"]').first();
  await partTool.click();
  await expect(page.getByTestId('palette-hint')).toContainText('Placing');
  await expect(partTool).toHaveClass(/is-active/);

  // Escape disarms it.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette-hint')).toHaveCount(0);
  await expect(partTool).not.toHaveClass(/is-active/);
  await shot(page, '77-palette');

  // A non-graph view (Grid): the palette column is gone entirely.
  await viewbar.locator('[data-testid="tb-view-grid"]').click();
  await expect(page.getByTestId('center-grid')).toBeVisible();
  await expect(page.getByTestId('palette')).toHaveCount(0);

  // Back on a diagram view, the palette returns.
  await viewbar.locator('[data-testid="tb-view-general"]').click();
  await expect(page.getByTestId('palette')).toBeVisible();

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

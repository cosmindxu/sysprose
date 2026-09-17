/**
 * The palette's Checks section, in the browser.
 *
 * What a person can do from a diagram: run the check that fits the view, read
 * the verdict where they clicked, see the findings in the Checks tab, click a
 * finding to select the element — and, for a check this page cannot run, get
 * the command instead of a verdict nobody earned.
 */
import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';

test('a model check runs here, lands in the Checks tab, and goes stale on an edit', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const orphans = page.locator('[data-testid="palette-check"][data-check="orphans"]');
  await expect(orphans).toBeVisible();
  // Nothing has run yet, and the palette says so rather than showing a verdict.
  await expect(orphans.getByTestId('palette-check-verdict')).toHaveText('not run');

  await orphans.getByTestId('palette-check-run').click();
  await expect(orphans).toHaveAttribute('data-verdict', /holds|issues/);

  // The results are in front of the person who asked for them.
  await expect(page.locator('.bottom-tab.is-active')).toContainText('Checks');
  const result = page.locator('[data-testid="checks-result"][data-check="orphans"]');
  await expect(result).toBeVisible();
  await expect(result).toContainText('definitions touch nothing');

  // An edit does not silently invalidate the verdict: it is labelled stale.
  await page.getByTestId('tb-new').click();
  await expect(page.locator('[data-testid="checks-result"][data-check="orphans"]')).toHaveAttribute('data-verdict', 'stale');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a finding selects its element', async ({ page }) => {
  await gotoApp(page);
  const requirements = page.locator('[data-testid="palette-check"][data-check="requirements"]');
  await requirements.getByTestId('palette-check-run').click();
  await expect(page.locator('[data-testid="checks-result"][data-check="requirements"]')).toBeVisible();
  const link = page.getByTestId('checks-row-select').first();
  if (await link.count()) {
    await link.click();
    await expect(page.getByTestId('properties')).toBeVisible();
  }
});

test('a solver check offers its command instead of a verdict it cannot give', async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId('tb-view-contracts').click();
  const faultTree = page.locator('[data-testid="palette-check"][data-check="fault-tree"]');
  await expect(faultTree).toBeVisible();
  await faultTree.getByTestId('palette-check-run').click();
  await expect(faultTree).toHaveAttribute('data-verdict', 'unavailable');
  await expect(faultTree.getByTestId('palette-check-verdict')).toHaveText('not here');
  const result = page.locator('[data-testid="checks-result"][data-check="fault-tree"]');
  await expect(result).toContainText('cross-origin-isolated');
  await expect(result).toContainText('sysprose -- fault-tree');
});

test('every view has a palette; a table view has checks but nothing to draw', async ({ page }) => {
  await gotoApp(page);
  for (const view of ['general', 'state', 'allocation', 'contracts', 'analysis', 'grid']) {
    await page.getByTestId(`tb-view-${view}`).click();
    await expect(page.getByTestId('palette'), view).toBeVisible();
    await expect(page.getByTestId('palette-checks'), view).toBeVisible();
    await expect(page.getByTestId('palette-edit'), view).toBeVisible();
  }
  // A table draws nothing, so it offers no drawing tools.
  await expect(page.getByTestId('palette-tools')).toHaveCount(0);
  // Back on a diagram, the tools are there, with an explicit Select.
  await page.getByTestId('tb-view-general').click();
  await expect(page.getByTestId('palette-tools')).toBeVisible();
  await expect(page.getByTestId('palette-select')).toBeVisible();
});

test('the palette column can be put away and comes back', async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId('palette-collapse').click();
  await expect(page.getByTestId('palette')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('palette-checks')).toHaveCount(0);
  await page.getByTestId('palette-expand').click();
  await expect(page.getByTestId('palette')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('palette-checks')).toBeVisible();
});

test('Edit acts on the selection, and is disabled without one', async ({ page }) => {
  await gotoApp(page);
  // The app opens with the root selected, so the actions are live from the start.
  await expect(page.getByTestId('palette-duplicate')).toBeEnabled();
  await page.locator('.react-flow__node').first().click();
  await expect(page.getByTestId('palette-delete')).toBeEnabled();
  await expect(page.getByTestId('palette-rename')).toBeEnabled();
  // Clearing the selection on the empty canvas disables them again.
  await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('palette-delete')).toBeDisabled();
  await expect(page.getByTestId('palette-duplicate')).toBeDisabled();
});

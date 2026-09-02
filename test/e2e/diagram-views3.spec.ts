import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Coverage for the two views wired in after the diagram module gained the
 * 'case' (React Flow use-case graph) and 'grid' (tabular GridView) projections:
 *
 *  - tb-view-case → the React Flow canvas renders (nodes or an empty graph)
 *    with no console/page errors — same contract as the other graph views;
 *  - tb-view-grid → the dedicated grid table (grid-view) is visible and the
 *    React Flow canvas is NOT present.
 *
 * Both views are exercised in one session, asserting zero console/page errors
 * throughout and capturing a screenshot per view.
 */
test('case + grid views render without errors', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Case view: a graph view — keeps the React Flow canvas (its testid survives).
  await page.getByTestId('tb-view-case').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  // The canvas mounts React Flow even when the projection is empty.
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, '21-view-case');

  // Grid view: the dedicated table renders; the graph canvas must NOT be present.
  await page.getByTestId('tb-view-grid').click();
  await expect(page.getByTestId('grid-view')).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  // The sample model yields at least one grid row + the fixed column headers.
  await expect(page.getByTestId('grid-col-header').first()).toBeVisible();
  await expect(page.getByTestId('grid-row').first()).toBeVisible();
  await shot(page, '21-view-grid');

  // Clicking a grid row selects its element (reported through store.select).
  const firstRow = page.getByTestId('grid-row').first();
  const rowId = await firstRow.getAttribute('data-element-id');
  await firstRow.click();
  expect(rowId).toBeTruthy();

  // Switching back to a graph view restores the React Flow canvas.
  await page.getByTestId('tb-view-general').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

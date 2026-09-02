import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Coverage for the views wired in after the diagram module gained the
 * parametric React Flow graph plus the dedicated allocation/sequence renderers
 * and the lazy Three.js geometry view:
 *
 *  - tb-view-parametric → the React Flow canvas renders (nodes or an empty
 *    graph) with no console/page errors;
 *  - tb-view-geometry   → the lazy Three.js `geometry-3d` WebGL view renders
 *    (no diagram-canvas);
 *  - tb-view-allocation → the allocation matrix table (matrix-view) is visible;
 *  - tb-view-sequence   → the sequence diagram SVG (sequence-view) is visible.
 *
 * Every view is exercised in one session, asserting zero console/page errors
 * throughout and capturing a screenshot per view.
 */
test('new views (parametric/geometry/allocation/sequence) render without errors', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Parametric: keep the React Flow canvas (its data-testid must survive).
  await page.getByTestId('tb-view-parametric').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, '20-view-parametric');

  // Geometry: the lazy Three.js WebGL view replaces the React Flow canvas.
  await page.getByTestId('tb-view-geometry').click();
  await expect(page.getByTestId('geometry-3d')).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  await page.waitForTimeout(500);
  await shot(page, '20-view-geometry');

  // Allocation view: the dedicated matrix table renders.
  await page.getByTestId('tb-view-allocation').click();
  await expect(page.getByTestId('matrix-view')).toBeVisible();
  // The graph canvas must NOT be present for the matrix view.
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  await shot(page, '20-view-allocation');

  // Sequence view: the dedicated SVG renders.
  await page.getByTestId('tb-view-sequence').click();
  await expect(page.getByTestId('sequence-view')).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  await shot(page, '20-view-sequence');

  // Switching back to a graph view restores the React Flow canvas.
  await page.getByTestId('tb-view-general').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

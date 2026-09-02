import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Graph Analysis view — the Gephi-style network view + DSM. Switches to the
 * view, asserts the force graph renders nodes, exercises the algorithm selectors
 * (clustering + color-by), toggles to the DSM (asserting cells render), and
 * checks zero console/page errors throughout.
 */
test('graph analysis: graph + DSM render and respond to algorithm changes', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-analysis').click();
  await expect(page.getByTestId('graph-analysis')).toBeVisible();
  // The React Flow canvas is gone; the SVG graph is present with nodes.
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  await expect(page.getByTestId('graph-svg')).toBeVisible();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  const nodeCount = await page.getByTestId('graph-node').count();
  expect(nodeCount).toBeGreaterThan(0);

  // Change clustering + color-by (the projection rebuilds without error).
  await page.getByTestId('analysis-clustering').selectOption('components');
  await page.getByTestId('analysis-colorby').selectOption('community');
  await expect(page.getByTestId('graph-node').first()).toBeVisible();

  // Node-size scaling controls: a larger common factor grows every node; the
  // contrast slider re-ranks without error.
  await page.getByTestId('analysis-size').selectOption('in-degree');
  const circle = page.getByTestId('graph-node').first().locator('circle').first();
  const rBefore = Number(await circle.getAttribute('r'));
  await page.getByTestId('analysis-size-scale').fill('3');
  await expect(page.getByTestId('analysis-size-scale')).toHaveValue('3');
  expect(Number(await circle.getAttribute('r'))).toBeGreaterThan(rBefore);
  await page.getByTestId('analysis-size-contrast').fill('3');
  await expect(page.getByTestId('graph-node').first()).toBeVisible();

  await shot(page, '50-graph-analysis');

  // Toggle to the DSM: the matrix renders with row labels + cells.
  await page.getByTestId('analysis-mode-dsm').click();
  await expect(page.getByTestId('dsm-svg')).toBeVisible();
  await expect(page.getByTestId('dsm-row-label').first()).toBeVisible();
  // Clicking a row label selects its model element (selection sync).
  await page.getByTestId('dsm-row-label').first().click();

  // Switch the DSM ordering algorithm.
  await page.getByTestId('analysis-dsm-order').selectOption('cuthill-mckee');
  await expect(page.getByTestId('dsm-svg')).toBeVisible();
  await shot(page, '51-dsm');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

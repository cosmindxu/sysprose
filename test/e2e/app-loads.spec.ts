/**
 * Scenario 1 — the app boots with the sample project: the explorer tree, the
 * properties panel and a laid-out diagram all render, and no uncaught console
 * errors are produced during load.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

test('app loads the sample project with tree + diagram and no console errors', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Explorer shows the containment tree (the sample root is "VehicleModel").
  await expect(page.getByTestId('explorer')).toBeVisible();
  const treeNodes = page.getByTestId('tree-node');
  expect(await treeNodes.count()).toBeGreaterThan(0);
  await expect(page.getByText('VehicleModel').first()).toBeVisible();

  // Properties + palette + bottom panel present.
  await expect(page.getByTestId('properties')).toBeVisible();
  await expect(page.getByTestId('palette')).toBeVisible();

  // A diagram is rendered into the canvas with at least one node.
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  expect(await page.locator('.react-flow__node').count()).toBeGreaterThan(0);

  // The live SDK is exposed and sees the sample elements.
  const partDefs = await page.evaluate(
    () =>
      (window as unknown as { sysml: { elementsOfType: (t: string) => unknown[] } }).sysml
        .elementsOfType('PartDefinition').length,
  );
  expect(partDefs).toBeGreaterThan(0);

  await shot(page, '01-app-loaded');

  // No uncaught console/page errors during the whole bootstrap.
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

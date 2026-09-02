/**
 * Authoring a parametric chain with nothing but the GUI.
 *
 * `solve.spec.ts` seeds its model through the `window.sysml` SDK and then checks
 * the solver — useful, but it never proves a *user* can build such a model. Here
 * every element and every value comes from the Explorer's "add child" picker,
 * the inline rename box and the Properties form; only the assertions read the
 * model back. The test then edits one input through Properties and re-solves, so
 * the analyse → tweak → re-analyse loop is covered end-to-end.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, openTab, shot } from './fixtures';
import { addChild, renameInTree, setPropValue } from './model-helpers';

test('a parametric chain authored through the GUI solves, and re-solves after an edit', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const rootId = await findElementId(page, 'Package', 'VehicleModel');

  // ── Author `part def DynamicsGui { guiMass; guiAccel; guiForceMoE }` ──
  const defId = await addChild(page, rootId, 'PartDefinition');
  await renameInTree(page, defId, 'DynamicsGui');

  const massId = await addChild(page, defId, 'AttributeUsage');
  await renameInTree(page, massId, 'guiMass');
  await setPropValue(page, massId, '1200');

  const accelId = await addChild(page, defId, 'AttributeUsage');
  await renameInTree(page, accelId, 'guiAccel');
  await setPropValue(page, accelId, '3');

  const forceId = await addChild(page, defId, 'AttributeUsage');
  await renameInTree(page, forceId, 'guiForceMoE');
  await setPropValue(page, forceId, 'guiMass * guiAccel');
  await shot(page, 'parametric-a-authored');

  // ── Solve: the derived value is reported and navigates to its element ──
  await page.getByTestId('tb-view-parametric').click();
  await page.getByTestId('tb-solve').click();
  await openTab(page, 'tab-problems');

  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'Solve:' }).first(),
  ).toBeVisible();
  const solved = page.getByTestId('problem-row').filter({ hasText: 'guiForceMoE = 3600' }).first();
  await expect(solved).toBeVisible();
  expect(await solved.getAttribute('data-elementid')).toBe(forceId);
  await shot(page, 'parametric-b-solved');

  // ── Change an input through Properties and solve again ──
  await setPropValue(page, massId, '2000');
  await page.getByTestId('tb-solve').click();
  await openTab(page, 'tab-problems');

  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'guiForceMoE = 6000' }).first(),
  ).toBeVisible();
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'guiForceMoE = 3600' }),
  ).toHaveCount(0);
  await shot(page, 'parametric-c-resolved');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

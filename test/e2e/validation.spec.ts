/**
 * Scenario 6 — validation surface: introduce a duplicate-name error (two
 * sibling PartDefinitions both named "Vehicle"), run validation, and confirm a
 * problem row is listed in the Problems tab and that clicking it selects the
 * offending element.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, openTab, shot } from './fixtures';

test('validation flags a duplicate name and the problem row selects the element', async ({
  page,
}) => {
  await gotoApp(page);

  // Root "VehicleModel" already owns a `part def Vehicle`. Add a second
  // PartDefinition under the same owner and name it "Vehicle" → duplicate.
  const rootRow = page.locator('[data-elementid]').filter({ hasText: 'VehicleModel' }).first();
  await rootRow.click();
  await rootRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('PartDefinition');

  const newId = await page.evaluate(() => {
    const api = (window as unknown as {
      sysml: { elementsOfType: (t: string) => { id: string; declaredName?: string }[] };
    }).sysml;
    const parts = api.elementsOfType('PartDefinition');
    return (parts.find((p) => !p.declaredName) ?? parts[parts.length - 1]).id;
  });

  const newRow = page.locator(`[data-elementid="${newId}"]`).first();
  await newRow.dblclick();
  const rename = page.getByTestId('tree-rename');
  await rename.fill('Vehicle');
  await rename.press('Enter');

  // ── Run validation, open the Problems tab ──
  await page.getByTestId('tb-validate').click();
  await openTab(page, 'tab-problems');

  const problemRows = page.getByTestId('problem-row');
  await expect(problemRows.first()).toBeVisible();
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'Duplicate name' }).first(),
  ).toBeVisible();
  await shot(page, '06a-problems');

  // ── Clicking a problem row selects the offending element ──
  const dupRow = page.getByTestId('problem-row').filter({ hasText: 'Duplicate name' }).first();
  const targetId = await dupRow.getAttribute('data-elementid');
  expect(targetId).toBeTruthy();
  await dupRow.click();

  await expect(page.locator(`[data-elementid="${targetId}"].tree-node`)).toHaveClass(
    /is-selected/,
  );
  await expect(page.getByTestId('prop-name')).toHaveValue('Vehicle');
  await shot(page, '06b-problem-selected');
});

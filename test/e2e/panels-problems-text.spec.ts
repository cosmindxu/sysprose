/**
 * Bottom panels — Problems and Text.
 *
 * Problems: introduce a structural issue (duplicate sibling name), run Validate,
 * open the Problems tab, assert problem rows are listed, and confirm clicking a
 * row selects the offending element (tree row + Properties reflect it).
 *
 * Text: the Text tab shows the serialized SysML v2 notation; editing it and
 * clicking Apply reparses the notation into the model (a new element appears in
 * the tree); and mutating the model via the Explorer regenerates the text.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, openTab, shot } from './fixtures';

test('Problems tab lists validation issues and a row selects its element', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Introduce a duplicate name: add a 2nd PartDefinition under the root and
  // rename it to the existing "Vehicle".
  const rootRow = page.locator('[data-elementid]').filter({ hasText: 'VehicleModel' }).first();
  await rootRow.click();
  await rootRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('PartDefinition');

  const newId = await page.evaluate(() => {
    const parts = (
      window as unknown as {
        sysml: { elementsOfType: (t: string) => { id: string; declaredName?: string }[] };
      }
    ).sysml.elementsOfType('PartDefinition');
    return (parts.find((p) => !p.declaredName) ?? parts[parts.length - 1]).id;
  });
  const newRow = page.locator(`[data-elementid="${newId}"]`).first();
  await newRow.dblclick();
  const rename = page.getByTestId('tree-rename');
  await rename.fill('Vehicle');
  await rename.press('Enter');

  // Validate → Problems tab lists rows.
  await page.getByTestId('tb-validate').click();
  await openTab(page, 'tab-problems');
  const rows = page.getByTestId('problem-row');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
  const dupRow = rows.filter({ hasText: 'Duplicate name' }).first();
  await expect(dupRow).toBeVisible();
  await shot(page, 'panels-problems');

  // Clicking a problem row selects the offending element.
  const targetId = await dupRow.getAttribute('data-elementid');
  expect(targetId).toBeTruthy();
  await dupRow.click();
  await expect(page.locator(`[data-elementid="${targetId}"].tree-node`)).toHaveClass(
    /is-selected/,
  );
  await expect(page.getByTestId('prop-name')).toHaveValue('Vehicle');

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('Text tab serializes, applies an edit, and regenerates from the model', async ({ page }) => {
  await gotoApp(page);

  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();

  // Serialized notation reflects the sample model.
  const initial = await editor.inputValue();
  expect(initial).toContain('package VehicleModel');
  expect(initial).toContain('part def Vehicle');
  await shot(page, 'panels-text-initial');

  // Edit the text to add a new PartDefinition, then Apply → model.
  const edited = initial.replace('part def Engine;', 'part def Engine;\n    part def Gearbox;');
  expect(edited).not.toEqual(initial);
  await editor.fill(edited);
  await expect(page.locator('.text-editor-status.is-dirty')).toBeVisible();
  await page.getByTestId('text-apply').click();

  // The new element exists in the model and the Explorer tree.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            sysml: { elementsOfType: (t: string) => { declaredName?: string }[] };
          }
        ).sysml
          .elementsOfType('PartDefinition')
          .some((e) => e.declaredName === 'Gearbox'),
      ),
    )
    .toBe(true);
  await expect(page.getByTestId('explorer').getByText('Gearbox', { exact: true })).toBeVisible();
  await shot(page, 'panels-text-applied');

  // Mutating the model via the Explorer regenerates the text automatically.
  const gearRow = page.locator('[data-elementid]').filter({ hasText: 'Gearbox' }).first();
  await gearRow.dblclick();
  const rename = page.getByTestId('tree-rename');
  await rename.fill('Transmission');
  await rename.press('Enter');

  await expect.poll(async () => await editor.inputValue()).toContain('part def Transmission');
  await expect(page.locator('.text-editor-status')).not.toHaveClass(/is-dirty/);
  await shot(page, 'panels-text-regenerated');
});

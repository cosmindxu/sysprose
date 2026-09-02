/**
 * Scenario 2 — full Explorer CRUD: add a Package under the root, add a
 * PartDefinition under that package (tree-add + metaclass pick), rename it
 * inline, select it, then delete it — asserting the tree reflects each step.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, shot } from './fixtures';

test('explorer create / rename / select / delete round-trip', async ({ page }) => {
  await gotoApp(page);

  const countOfType = (eClass: string) =>
    page.evaluate(
      (e) =>
        (window as unknown as { sysml: { elementsOfType: (t: string) => unknown[] } }).sysml
          .elementsOfType(e).length,
      eClass,
    );

  const pkgBefore = await countOfType('Package');

  // Root row (the sample "VehicleModel" package) is initially selected.
  const rootRow = page.locator('[data-elementid]').filter({ hasText: 'VehicleModel' }).first();
  await rootRow.click();

  // ── Add a Package child via the root row's "+" (tree-add) + metaclass pick ──
  await rootRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('Package');
  await expect.poll(() => countOfType('Package')).toBe(pkgBefore + 1);

  // The new package becomes the selection; find its id from the SDK (the last
  // Package created — it has no declared name yet).
  const newPkgId = await page.evaluate(() => {
    const api = (window as unknown as {
      sysml: { elementsOfType: (t: string) => { id: string; declaredName?: string }[] };
    }).sysml;
    const pkgs = api.elementsOfType('Package');
    const unnamed = pkgs.find((p) => !p.declaredName);
    return (unnamed ?? pkgs[pkgs.length - 1]).id;
  });

  const newPkgRow = page.locator(`[data-elementid="${newPkgId}"]`).first();
  await expect(newPkgRow).toBeVisible();
  await newPkgRow.click();

  // ── Add a PartDefinition under the new package ──
  const partDefsBefore = await countOfType('PartDefinition');
  await newPkgRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('PartDefinition');
  await expect.poll(() => countOfType('PartDefinition')).toBe(partDefsBefore + 1);

  const newPartId = await page.evaluate(() => {
    const api = (window as unknown as {
      sysml: { elementsOfType: (t: string) => { id: string; declaredName?: string }[] };
    }).sysml;
    const parts = api.elementsOfType('PartDefinition');
    const unnamed = parts.find((p) => !p.declaredName);
    return (unnamed ?? parts[parts.length - 1]).id;
  });
  const partRow = page.locator(`[data-elementid="${newPartId}"]`).first();
  await expect(partRow).toBeVisible();

  await shot(page, '02a-created');

  // ── Rename it inline via tree-rename ──
  await partRow.dblclick();
  const renameInput = page.getByTestId('tree-rename');
  await expect(renameInput).toBeVisible();
  await renameInput.fill('Gearbox');
  await renameInput.press('Enter');

  await expect.poll(async () =>
    page.evaluate(
      (id) =>
        (window as unknown as { sysml: { getElement: (i: string) => { declaredName?: string } } })
          .sysml.getElement(id)?.declaredName,
      newPartId,
    ),
  ).toBe('Gearbox');
  await expect(partRow.getByText('Gearbox')).toBeVisible();

  // ── Select it and confirm the Properties panel reflects the selection ──
  await partRow.click();
  await expect(page.getByTestId('prop-name')).toHaveValue('Gearbox');

  await shot(page, '02b-renamed-selected');

  // ── Delete it via tree-delete; the row disappears and the count drops ──
  await partRow.getByTestId('tree-delete').click();
  await expect.poll(() => countOfType('PartDefinition')).toBe(partDefsBefore);
  await expect(page.locator(`[data-elementid="${newPartId}"]`)).toHaveCount(0);

  await shot(page, '02c-deleted');
});

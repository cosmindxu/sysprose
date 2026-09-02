/**
 * Scenario 9 — undo / redo: create an element, undo to restore the prior state,
 * then redo to reapply the change.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, shot } from './fixtures';

const countOfType = (page: import('@playwright/test').Page, eClass: string) =>
  page.evaluate(
    (e) =>
      (window as unknown as { sysml: { elementsOfType: (t: string) => unknown[] } }).sysml
        .elementsOfType(e).length,
    eClass,
  );

test('undo restores and redo reapplies a create', async ({ page }) => {
  await gotoApp(page);

  const before = await countOfType(page, 'PartDefinition');

  // ── Make a change: add a PartDefinition under the root package ──
  const rootRow = page.locator('[data-elementid]').filter({ hasText: 'VehicleModel' }).first();
  await rootRow.click();
  await rootRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('PartDefinition');
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(before + 1);
  await shot(page, '09a-created');

  // ── Undo restores the prior state ──
  await expect(page.getByTestId('tb-undo')).toBeEnabled();
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(before);
  await shot(page, '09b-undone');

  // ── Redo reapplies the change ──
  await expect(page.getByTestId('tb-redo')).toBeEnabled();
  await page.getByTestId('tb-redo').click();
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(before + 1);
  await shot(page, '09c-redone');
});

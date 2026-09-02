/**
 * Scenario 5 — bidirectional text ↔ model sync:
 *  - the Text tab shows the serialized SysML v2 notation for the model,
 *  - editing the text + "Apply" reparses it into the model (new element shows
 *    up in the Explorer),
 *  - mutating the model via the Explorer regenerates the text automatically.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, openTab, shot } from './fixtures';

test('text editor serializes, applies edits, and regenerates from model', async ({ page }) => {
  await gotoApp(page);

  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();

  // ── Serialized notation reflects the sample model ──
  const initial = await editor.inputValue();
  expect(initial).toContain('package VehicleModel');
  expect(initial).toContain('part def Vehicle');
  await shot(page, '05a-text-initial');

  // ── Edit the text to add a new PartDefinition, then Apply → model ──
  const edited = initial.replace('part def Engine;', 'part def Engine;\n    part def Wheel;');
  expect(edited).not.toEqual(initial);
  await editor.fill(edited);
  await expect(page.locator('.text-editor-status.is-dirty')).toBeVisible();

  await page.getByTestId('text-apply').click();

  // The new element exists in the model and appears in the Explorer tree.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as {
            sysml: { elementsOfType: (t: string) => { declaredName?: string }[] };
          }).sysml
            .elementsOfType('PartDefinition')
            .some((e) => e.declaredName === 'Wheel'),
      ),
    )
    .toBe(true);
  await expect(page.getByTestId('explorer').getByText('Wheel', { exact: true })).toBeVisible();
  await shot(page, '05b-text-applied');

  // ── Mutate the model via the Explorer; the text regenerates automatically ──
  const wheelRow = page.locator('[data-elementid]').filter({ hasText: 'Wheel' }).first();
  await wheelRow.dblclick();
  const rename = page.getByTestId('tree-rename');
  await rename.fill('Wheel2');
  await rename.press('Enter');

  await expect.poll(async () => await editor.inputValue()).toContain('part def Wheel2');
  await expect(page.locator('.text-editor-status')).not.toHaveClass(/is-dirty/);
  await shot(page, '05c-text-regenerated');
});

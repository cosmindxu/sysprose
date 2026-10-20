/**
 * Scenario 5 — bidirectional text ↔ model sync:
 *  - the Text tab shows the serialized SysML v2 notation for the model,
 *  - editing the text + "Apply" reparses it into the model (new element shows
 *    up in the Explorer),
 *  - mutating the model via the Explorer regenerates the text automatically,
 *  - a field's change over typed text applies that text first, or leaves it.
 */

import { test, expect, type Page } from '@playwright/test';
import { findElementId, gotoApp, openTab, selectElementById, shot, treeName } from './fixtures';
import { nameOf } from './model-helpers';

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
  await treeName(wheelRow).dblclick();
  const rename = page.getByTestId('tree-rename');
  await rename.fill('Wheel2');
  await rename.press('Enter');

  await expect.poll(async () => await editor.inputValue()).toContain('part def Wheel2');
  await expect(page.locator('.text-editor-status')).not.toHaveClass(/is-dirty/);
  await shot(page, '05c-text-regenerated');
});

/** Whether an edit's recompute — the Text view's refresh among it — is still to run. */
function recomputePending(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    (window as unknown as { sysprose: { diagram: { recomputePending(): boolean } } }).sysprose.diagram.recomputePending(),
  );
}

/**
 * A change applied from a field while the Text view holds text typed there and
 * not applied used to re-serialise the view over that text, with no note and no
 * Undo. The typed text now goes in first, under the ids its elements had — so
 * Properties stays on the element — and the change over it. A text that cannot
 * go first (a syntax error) stays, reading "not yet applied".
 */
test('a field’s change keeps text typed in the Text view: applied first, or left standing', async ({ page }) => {
  await gotoApp(page);
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  const status = page.locator('.text-editor-status');
  const initial = await editor.inputValue();
  expect(initial).toContain('part def Engine;');

  await editor.fill(initial.replace('part def Engine;', 'part def Engine;\n    part def Wheel;'));
  await expect(status).toHaveClass(/is-dirty/);
  const engine = await findElementId(page, 'PartDefinition', 'Engine');
  await selectElementById(page, engine);
  await page.getByTestId('prop-name').fill('Motor');

  await expect.poll(() => editor.inputValue()).toContain('part def Motor;');
  expect(await editor.inputValue(), 'the typed text went in first').toContain('part def Wheel;');
  await expect(status).not.toHaveClass(/is-dirty/);
  expect(await nameOf(page, engine), 'the change, on the element of the same id').toBe('Motor');
  await expect(page.getByTestId('prop-name')).toHaveValue('Motor');

  const faulted = (await editor.inputValue()).replace('part def Wheel;', 'part def Wheel;\n    blok bad;');
  await editor.fill(faulted);
  await page.getByTestId('prop-name').fill('Motor2');
  await expect.poll(() => nameOf(page, engine)).toBe('Motor2');
  await expect.poll(() => recomputePending(page)).toBe(false);
  expect(await editor.inputValue(), 'a text with a syntax error stays').toBe(faulted);
  await expect(status).toHaveClass(/is-dirty/);
});

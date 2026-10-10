/**
 * Keyboard-shortcut coverage — exercises every shortcut wired in
 * `src/ui/commands.ts` `handleShortcut` (undo/redo/save) via `page.keyboard`,
 * asserting the effect on the live model rather than merely that a key fired:
 *
 *  - Ctrl/⌘+Z          → undo (reverts a create)
 *  - Ctrl/⌘+Y          → redo (reapplies the create)
 *  - Ctrl/⌘+Shift+Z    → redo (the alternate binding)
 *  - Ctrl/⌘+S          → save (the project becomes openable from the picker)
 *  - Ctrl/⌘+S in a field → save too, the field's typed value committed first
 *                         (a Properties box, the Explorer search, a rename —
 *                         which closes, the focus going to Save)
 *
 * `ControlOrMeta` lets the same spec drive the Ctrl (Linux/Win) and ⌘ (macOS)
 * modifiers the handler accepts.
 */

import { test, expect, type Page } from '@playwright/test';
import { findElementId, gotoApp, selectElementById, shot, treeName } from './fixtures';
import { exists, nameOf } from './model-helpers';

function countOfType(page: Page, eClass: string): Promise<number> {
  return page.evaluate(
    (e) =>
      (window as unknown as { sysml: { elementsOfType: (t: string) => unknown[] } }).sysml
        .elementsOfType(e).length,
    eClass,
  );
}

test('undo/redo/save keyboard shortcuts drive the model', async ({ page }) => {
  await gotoApp(page);

  const before = await countOfType(page, 'PartDefinition');

  // Create a PartDefinition under the root so there is a change to undo.
  const rootRow = page.locator('[data-elementid]').filter({ hasText: 'VehicleModel' }).first();
  await treeName(rootRow).click();
  await rootRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('PartDefinition');
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(before + 1);

  // Move focus off any form control so the global window handler receives keys
  // (in a field it takes the save keys alone).
  await page.locator('.toolbar-brand').click();

  // ── Ctrl/⌘+Z → undo ──
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(before);
  await shot(page, 'kbd-a-undo');

  // ── Ctrl/⌘+Y → redo ──
  await page.keyboard.press('ControlOrMeta+y');
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(before + 1);
  await shot(page, 'kbd-b-redo-y');

  // ── Ctrl/⌘+Z (undo) then Ctrl/⌘+Shift+Z (the alternate redo binding) ──
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(before);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(before + 1);
  await shot(page, 'kbd-c-redo-shiftz');

  // ── Ctrl/⌘+S → save; the project becomes listed in the Open picker ──
  await page.keyboard.press('ControlOrMeta+s');
  await page.getByTestId('tb-open').click();
  await expect(page.getByTestId('project-picker')).toBeVisible();
  await expect(page.getByTestId('project-pick').first()).toBeVisible();
  await shot(page, 'kbd-d-saved');
});

/** Whether a project saved in this browser holds `needle` — read from IndexedDB, as the app stored it. */
function savedHolds(page: Page, needle: string): Promise<boolean> {
  return page.evaluate(async (needle) => {
    const done = <T>(req: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    // Only a database the app has opened: opening one that is not there yet
    // would create it empty, without the store the app's first save makes.
    for (const { name } of await indexedDB.databases()) {
      if (name === undefined) continue;
      const db = await done(indexedDB.open(name));
      try {
        for (const storeName of Array.from(db.objectStoreNames)) {
          const values = await done(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
          if (values.some((v) => JSON.stringify(v).includes(needle))) return true;
        }
      } finally {
        db.close();
      }
    }
    return false;
  }, needle);
}

/**
 * Ctrl/⌘+S typed into a field is the app's Save, never the browser's "Save
 * page" dialog — and the save holds what was typed there. A requirement
 * attribute's box writes on leaving it, not per keystroke: the key commits it
 * first, and the caret stays in the box, so typing goes on there (a digit
 * does not switch the view, Backspace does not delete the requirement).
 */
test('Ctrl/⌘+S in a Properties field or the Explorer search saves, what was typed included', async ({ page }) => {
  await gotoApp(page);
  // Whether the app took each Ctrl/⌘+S (default prevented): the browser's dialog stays shut.
  await page.evaluate(() => {
    const w = window as unknown as { saveKeys: boolean[] };
    w.saveKeys = [];
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') w.saveKeys.push(e.defaultPrevented);
    });
  });
  const saveKeys = () => page.evaluate(() => (window as unknown as { saveKeys: boolean[] }).saveKeys);

  const reqId = await findElementId(page, 'RequirementUsage', 'maxMass');
  await selectElementById(page, reqId);
  const rationale = page.getByTestId('prop-rm-rationale');
  await rationale.fill('Road limit');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => savedHolds(page, 'Road limit')).toBe(true);
  expect(await saveKeys()).toEqual([true]);
  await expect(rationale).toBeFocused();

  // The caret is still in the box: these keys are the box's own.
  await page.keyboard.type(' 3');
  await expect(rationale).toHaveValue('Road limit 3');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(rationale).toHaveValue('Road limit');
  await expect(page.getByTestId('tb-view-general')).toHaveClass(/is-active/);
  expect(await findElementId(page, 'RequirementUsage', 'maxMass')).toBe(reqId);
  await shot(page, 'kbd-e-saved-from-a-field');

  // The Explorer search: the model's latest edit is saved, the search kept.
  await page.getByTestId('prop-rm-owner').fill('Chassis team');
  await page.getByTestId('prop-rm-owner').blur();
  const search = page.getByTestId('explorer-search');
  await search.fill('maxM');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => savedHolds(page, 'Chassis team')).toBe(true);
  expect(await saveKeys()).toEqual([true, true]);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('maxM');
});

/**
 * Ctrl/⌘+S in a rename box commits the name and closes the box, as Enter does.
 * The focus goes to the Save button, as after a click on it: left to fall to
 * the page, the next Backspace — typed on as in the box — would delete the
 * element just renamed, with its subtree.
 */
test('Ctrl/⌘+S in the Explorer rename box saves the name, and the next Backspace deletes nothing', async ({ page }) => {
  await gotoApp(page);
  const id = await findElementId(page, 'PartDefinition', 'Vehicle');
  await selectElementById(page, id);
  await treeName(page.locator(`[data-elementid="${id}"]`).first()).dblclick();
  const box = page.getByTestId('tree-rename');
  await box.fill('VehicleRenamed');

  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => savedHolds(page, 'VehicleRenamed')).toBe(true);
  await expect(box).toHaveCount(0);
  await expect(page.getByTestId('tb-save')).toBeFocused();

  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  expect(await nameOf(page, id)).toBe('VehicleRenamed');
  expect(await exists(page, id)).toBe(true);
  await shot(page, 'kbd-f-rename-saved');
});

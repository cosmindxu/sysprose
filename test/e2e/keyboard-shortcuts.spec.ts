/**
 * Keyboard-shortcut coverage — exercises every shortcut wired in
 * `src/ui/commands.ts` `handleShortcut` (undo/redo/save) via `page.keyboard`,
 * asserting the effect on the live model rather than merely that a key fired:
 *
 *  - Ctrl/⌘+Z          → undo (reverts a create)
 *  - Ctrl/⌘+Y          → redo (reapplies the create)
 *  - Ctrl/⌘+Shift+Z    → redo (the alternate binding)
 *  - Ctrl/⌘+S          → save (the project becomes openable from the picker)
 *
 * `ControlOrMeta` lets the same spec drive the Ctrl (Linux/Win) and ⌘ (macOS)
 * modifiers the handler accepts.
 */

import { test, expect, type Page } from '@playwright/test';
import { gotoApp, shot } from './fixtures';

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
  await rootRow.click();
  await rootRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('PartDefinition');
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(before + 1);

  // Move focus off any form control so the global window handler receives keys
  // (it deliberately ignores INPUT/TEXTAREA/contenteditable targets).
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

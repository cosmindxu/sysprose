/**
 * Shared menu keyboard navigation (roving tabindex + focus lifecycle).
 *
 * The canvas context menus (node · pane) and the toolbar dropdowns share one
 * behavior via useRovingMenu: opening focuses the first [data-menuitem], ↑/↓ rove
 * (wrapping), Home/End jump, ONLY the focused item is a Tab stop, Tab out closes
 * the menu, and focus is RESTORED to the opener on close. This pins all of that
 * on both a canvas context menu and a toolbar dropdown.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';

/** data-testid of the currently focused element (or null). */
const activeTestId = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);

test('canvas context menu: roving nav, single-Tab-stop tabindex, group role', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const menu = page.getByTestId('node-ctx-menu');
  await page.locator('.react-flow__node').first().click({ button: 'right' });
  await expect(menu).toBeVisible();
  // Hybrid widget (buttons + a metaclass <select>) → a labelled group, NOT role=menu.
  await expect(menu).toHaveAttribute('role', 'group');

  // Opening focuses the first item (Rename), which is the ONLY Tab stop.
  await expect.poll(() => activeTestId(page)).toBe('node-ctx-rename');
  await expect(page.getByTestId('node-ctx-rename')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('node-ctx-copy')).toHaveAttribute('tabindex', '-1');

  // ↓ moves to Copy and the roving tabindex follows (single Tab stop invariant).
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => activeTestId(page)).toBe('node-ctx-copy');
  await expect(page.getByTestId('node-ctx-copy')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('node-ctx-rename')).toHaveAttribute('tabindex', '-1');

  // ↑ wraps back to Rename; End → Delete; Home → Rename; ↑ from first wraps to last.
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => activeTestId(page)).toBe('node-ctx-rename');
  await page.keyboard.press('End');
  await expect.poll(() => activeTestId(page)).toBe('node-ctx-delete');
  await page.keyboard.press('Home');
  await expect.poll(() => activeTestId(page)).toBe('node-ctx-rename');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => activeTestId(page)).toBe('node-ctx-delete');

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('canvas context menu: cancelling rename returns focus into the menu (roving survives)', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const menu = page.getByTestId('node-ctx-menu');
  await page.locator('.react-flow__node').first().click({ button: 'right' });
  await expect.poll(() => activeTestId(page)).toBe('node-ctx-rename');

  // Enter starts the inline rename; the input autofocuses.
  await page.keyboard.press('Enter');
  const input = page.getByTestId('node-ctx-rename-input');
  await expect(input).toBeFocused();
  await input.fill('KeepTypingXYZ');

  // Arrow keys while typing are NATIVE (not hijacked by roving): focus stays in
  // the input and the menu stays open (nothing committed).
  await page.keyboard.press('ArrowDown');
  await expect(input).toBeFocused();
  await expect(menu).toBeVisible();

  // Escape cancels the rename, keeps the menu open, and RETURNS focus to Rename
  // (not stranded on <body>), so roving keeps working.
  await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
  await expect.poll(() => activeTestId(page)).toBe('node-ctx-rename');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => activeTestId(page)).toBe('node-ctx-copy');

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('pane context menu: roving focuses the top menuitem', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.evaluate(() => {
    document.querySelector('.react-flow__pane')?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 240 }),
    );
  });
  const menu = page.getByTestId('pane-ctx-menu');
  await expect(menu).toBeVisible();

  // Fit view is rendered first so the roving focus lands at the TOP (above the
  // non-menuitem Add-element <select>); a single menuitem wraps onto itself.
  await expect.poll(() => activeTestId(page)).toBe('pane-ctx-fit');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => activeTestId(page)).toBe('pane-ctx-fit');

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('toolbar dropdown: roving, tabindex, focus restore on close, Tab-out closes', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const trigger = page.getByTestId('tb-export');
  const menu = page.getByTestId('tb-export-menu');

  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('role', 'menu'); // all-menuitem → valid menu

  await expect.poll(() => activeTestId(page)).toBe('tb-export-sysml');
  await expect(page.getByTestId('tb-export-sysml')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('tb-export-json')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => activeTestId(page)).toBe('tb-export-json');
  await expect(page.getByTestId('tb-export-json')).toHaveAttribute('tabindex', '0');

  // Escape closes AND restores focus to the trigger (not <body>).
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect.poll(() => activeTestId(page)).toBe('tb-export');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  // Reopen and Tab out → the menu closes (APG) and aria-expanded clears.
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect.poll(() => activeTestId(page)).toBe('tb-export-sysml');
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

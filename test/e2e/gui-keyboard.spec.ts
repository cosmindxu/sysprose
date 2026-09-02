import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

const modelSize = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () => (window as unknown as { sysml: { model: { all(): unknown[] } } }).sysml.model.all().length,
  );

/**
 * Global keyboard shortcuts: Delete removes the selection (the single delete
 * path — React Flow's own delete is disabled so the model can't desync), plain
 * digits switch primary views, and `/` jumps to the Explorer search.
 */
test('keyboard: Delete removes the selected element', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Select a node on the canvas (click focuses a <div>, not an input, so the
  // global handler is free to act).
  const node = page.locator('.react-flow__node').first();
  await node.click();

  const n0 = await modelSize(page);
  await page.keyboard.press('Delete');
  await expect.poll(() => modelSize(page)).toBeLessThan(n0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('keyboard: Backspace does NOT delete while a button holds focus', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Select a node, then click a mini-toolbar button so a <button> keeps focus
  // (a node stays selected in the store — buttons don't change the selection).
  await page.locator('.react-flow__node').first().click();
  await page.getByTestId('diagram-fit').click();
  const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? null);
  expect(focusedTag).toBe('BUTTON');

  // A reflex Backspace must be swallowed by the guard — the model is unchanged.
  const n0 = await modelSize(page);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  expect(await modelSize(page)).toBe(n0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('keyboard: Ctrl/Cmd+D duplicates the selection', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await page.locator('.react-flow__node').first().click();

  const n0 = await modelSize(page);
  await page.keyboard.press('Control+d');
  await expect.poll(() => modelSize(page)).toBeGreaterThan(n0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('keyboard: digit hotkeys switch the primary view', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Move focus off any input by clicking the empty canvas.
  await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });

  await page.keyboard.press('2'); // interconnection
  await expect(page.getByTestId('tb-view-interconnection')).toHaveClass(/is-active/);

  await page.keyboard.press('4'); // state
  await expect(page.getByTestId('tb-view-state')).toHaveClass(/is-active/);

  await page.keyboard.press('1'); // general
  await expect(page.getByTestId('tb-view-general')).toHaveClass(/is-active/);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await shot(page, '81-keyboard-view-hotkeys');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('keyboard: "/" focuses the Explorer search box', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });

  await page.keyboard.press('/');
  const focusedTestId = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') ?? null,
  );
  expect(focusedTestId).toBe('explorer-search');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

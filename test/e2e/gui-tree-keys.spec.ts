import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';

/**
 * Arrow-key navigation of the Explorer tree: ↑/↓ move the selection through the
 * visible rows, ↑ returns. (→/← expand/collapse or descend/ascend.)
 */
test('explorer: arrow keys move the selection through the tree', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const tree = page.getByTestId('explorer-tree');
  const selectedId = () =>
    page.locator('.tree-node.is-selected').first().getAttribute('data-elementid');

  await expect.poll(() => page.locator('.tree-node').count()).toBeGreaterThanOrEqual(2);

  // Click the first row → it selects and focuses the tree.
  await page.locator('.tree-node').first().click();
  const id0 = await selectedId();
  expect(id0).toBeTruthy();

  // ↓ moves the selection to the next visible row.
  await tree.press('ArrowDown');
  const id1 = await selectedId();
  expect(id1).not.toBe(id0);

  // ↑ returns to the original row.
  await tree.press('ArrowUp');
  expect(await selectedId()).toBe(id0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

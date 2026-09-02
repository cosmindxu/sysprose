import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';

const modelSize = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () => (window as unknown as { sysml: { model: { all(): unknown[] } } }).sysml.model.all().length,
  );

/**
 * Copy / paste of subtrees across owners via the node context menu: copy one
 * element's subtree, then "Paste into" another element → a deep clone lands
 * under the target (one undo step; internal refs remapped by the core paste).
 */
test('canvas: Copy a node, then Paste into another element', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const nodes = page.locator('.react-flow__node');
  await expect.poll(() => nodes.count()).toBeGreaterThanOrEqual(2);

  // Copy the first node's subtree.
  await nodes.nth(0).click({ button: 'right' });
  await page.getByTestId('node-ctx-copy').click();

  // Paste into the second node.
  const before = await modelSize(page);
  await nodes.nth(1).click({ button: 'right' });
  const paste = page.getByTestId('node-ctx-paste');
  await expect(paste).toBeVisible(); // only shown once the clipboard has content
  await paste.click();

  await expect.poll(() => modelSize(page)).toBeGreaterThan(before); // clone materialized

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

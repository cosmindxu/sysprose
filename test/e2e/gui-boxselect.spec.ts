import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';

/**
 * Box-select: Shift+drag a rectangle over the canvas selects every enclosed
 * node into the store's multi-selection (React Flow's default box-select, synced
 * via onSelectionChange). Bulk Delete then removes them all.
 */
test('canvas: shift-drag box-selects multiple nodes', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const nodes = page.locator('.react-flow__node');
  await expect.poll(() => nodes.count()).toBeGreaterThanOrEqual(2);
  const b0 = (await nodes.nth(0).boundingBox())!;
  const b1 = (await nodes.nth(1).boundingBox())!;

  // A rectangle enclosing the first two nodes (Shift makes the drag a box-select
  // even if it starts over a node).
  const x1 = Math.min(b0.x, b1.x) - 12;
  const y1 = Math.min(b0.y, b1.y) - 12;
  const x2 = Math.max(b0.x + b0.width, b1.x + b1.width) + 12;
  const y2 = Math.max(b0.y + b0.height, b1.y + b1.height) + 12;

  await page.keyboard.down('Shift');
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('Shift');

  // Both (at least) are now selected in the store → reflected on the canvas.
  await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBeGreaterThanOrEqual(
    2,
  );

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/**
 * The last few unexercised chrome affordances.
 *
 * `gui-canvas` covers the mini-toolbar's fit / fit-to-selection / snap buttons
 * but not its Auto-layout; `gui-context-menu` covers the pane menu's
 * Add-element and Escape but not its Fit view; `gui-explorer` resizes the
 * Explorer but nothing ever resized the Properties panel; and `api-console2`
 * reads commit history without ever using the API console's own commit bar.
 *
 * Each of these is a control whose only job is to change something observable,
 * so each assertion here is on the observable change — a viewport transform, a
 * node position, a panel width, a commit id — rather than on the click landing.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, gotoApp, openTab, shot } from './fixtures';

/** The React Flow viewport transform (pan/zoom), as a string. */
async function transform(page: Page): Promise<string> {
  return page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);
}

/** Positions of the laid-out nodes, as a comparable string. */
async function positions(page: Page): Promise<string> {
  return page
    .locator('.react-flow__node')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform).join('|'));
}

test('the pane menu fits the view and the mini-toolbar re-runs auto-layout', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await page.waitForTimeout(400); // let the async elkjs layout settle

  // ── Pan away, then "Fit view" from the canvas pane menu restores a fit ──
  const pane = page.locator('.react-flow__pane');
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 220, box.y + box.height / 2 - 160, { steps: 8 });
  await page.mouse.up();
  const panned = await transform(page);

  // Dispatch the contextmenu on the pane itself — a positioned mouse right-click
  // risks landing on a node (this test has just panned the graph around).
  await page.evaluate(() =>
    document.querySelector('.react-flow__pane')?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 240 }),
    ),
  );
  await expect(page.getByTestId('pane-ctx-menu')).toBeVisible();
  await expect(page.getByTestId('pane-ctx-fit')).toBeVisible();
  await page.getByTestId('pane-ctx-fit').click();

  // The menu closes and the viewport is no longer where the pan left it.
  await expect(page.getByTestId('pane-ctx-menu')).toHaveCount(0);
  await expect.poll(() => transform(page)).not.toBe(panned);
  await shot(page, 'canvas-extras-a-fit');

  // ── Auto-layout re-lays the graph: nodes are re-placed, none is lost ──
  const nodeCount = await page.locator('.react-flow__node').count();
  // Drag the node up-and-left: the canvas corners are all occupied (mini-toolbar
  // top-right, minimap bottom-right, Controls bottom-left), and dropping onto one
  // of those panels is intercepted rather than delivered to the canvas.
  const first = page.locator('.react-flow__node').first();
  const nb = (await first.boundingBox())!;
  await page.mouse.move(nb.x + nb.width / 2, nb.y + 8);
  await page.mouse.down();
  await page.mouse.move(nb.x + nb.width / 2 - 130, nb.y + 8 - 70, { steps: 10 });
  await page.mouse.up();
  const moved = await positions(page);

  await page.getByTestId('diagram-autolayout').click();
  await expect.poll(() => positions(page)).not.toBe(moved);
  await expect(page.locator('.react-flow__node')).toHaveCount(nodeCount);
  await shot(page, 'canvas-extras-b-autolayout');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('the Properties splitter resizes the panel, and the API console commits', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // ── Drag the Properties splitter left → the panel gets wider ──
  const panel = page.locator('.app-properties');
  const before = (await panel.boundingBox())!.width;
  const splitter = page.getByTestId('properties-splitter');
  await expect(splitter).toBeVisible();
  const sb = (await splitter.boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x - 120, sb.y + sb.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 50);
  await shot(page, 'canvas-extras-c-resized');

  // ── The API console's commit bar snapshots the model into the history ──
  await openTab(page, 'tab-api');
  await expect(page.getByTestId('api-commit-bar')).toBeVisible();
  const firstId = await page.getByTestId('api-commit-id').textContent();
  const listBefore = (await page.getByTestId('api-commit-list').textContent()) ?? '';

  await page.getByTestId('api-commit').click();

  // A NEW commit id becomes current, and the history grows to include it.
  await expect.poll(() => page.getByTestId('api-commit-id').textContent()).not.toBe(firstId);
  const newId = (await page.getByTestId('api-commit-id').textContent())!.trim();
  expect(newId).toMatch(/commit-/);
  const listAfter = (await page.getByTestId('api-commit-list').textContent()) ?? '';
  expect(listAfter).toContain(newId);
  expect(listAfter.length).toBeGreaterThan(listBefore.length);
  await shot(page, 'canvas-extras-d-committed');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

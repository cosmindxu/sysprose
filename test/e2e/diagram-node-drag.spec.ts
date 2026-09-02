/**
 * Manual layout — dragging a node onto EMPTY canvas persists its position.
 *
 * React Flow node drag is wired to `onNodeDragStop`. When the drop lands on empty
 * canvas (no node under the pointer) it persists the tweaked position back into
 * `store.diagram` — a pure layout tweak that must NOT reparent and must NOT push
 * an undo entry. (Dropping onto another node is the reparent path, covered by
 * gui-reparent.spec.ts.) This drives a real mouse drag to a computed empty spot
 * and asserts the node relocated, its owner is unchanged, and undo stays disabled.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, shot, type SysmlSdk } from './fixtures';

test('dragging a node to empty canvas persists position without reparent or undo', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-general').click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await page.waitForTimeout(500);

  const vehicleId = await findElementId(page, 'PartDefinition', 'Vehicle');
  const node = page.locator(`.react-flow__node[data-id="${vehicleId}"]`);
  await expect(node).toBeVisible();
  const before = await node.boundingBox();
  if (!before) throw new Error('node has no bounding box');

  const ownerBefore = await page.evaluate((id) => {
    const api = (window as unknown as { sysml: SysmlSdk }).sysml;
    return api.ancestors(id)[0]?.id ?? null;
  }, vehicleId);
  // A pure layout tweak pushes no undo entry — the toolbar Undo starts disabled.
  await expect(page.getByTestId('tb-undo')).toBeDisabled();
  await shot(page, 'drag-a-before');

  // Find a screen point inside the canvas that overlaps no node and no overlay
  // (controls / minimap / legend / minibar) — a genuine empty drop target.
  const empty = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="diagram-canvas"]')!.getBoundingClientRect();
    const blockers = [
      ...document.querySelectorAll(
        '.react-flow__node, .react-flow__panel, .react-flow__controls, .react-flow__minimap, .react-flow__attribution',
      ),
    ].map((n) => n.getBoundingClientRect());
    const hits = (x: number, y: number) =>
      blockers.some((r) => x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12);
    // Scan outward from the vertical middle for an empty column.
    for (let y = canvas.top + canvas.height / 2; y < canvas.bottom - 40; y += 20) {
      for (let x = canvas.left + 40; x < canvas.right - 40; x += 20) {
        if (!hits(x, y)) return { x, y };
      }
    }
    return null;
  });
  if (!empty) throw new Error('no empty canvas point found');

  // Grab the node near its header and drag it to the empty point.
  const grabX = before.x + Math.min(20, before.width / 2);
  const grabY = before.y + 8;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move((grabX + empty.x) / 2, (grabY + empty.y) / 2, { steps: 10 });
  await page.mouse.move(empty.x, empty.y, { steps: 10 });
  await page.mouse.up();

  // The node relocated and STAYED (no rebuild snaps it back — a position tweak
  // doesn't trigger a recompute), the owner is unchanged, and undo is still off.
  await expect
    .poll(async () => {
      const b = await node.boundingBox();
      return b ? Math.round(Math.abs(b.x - before.x) + Math.abs(b.y - before.y)) : 0;
    })
    .toBeGreaterThan(40);
  const ownerAfter = await page.evaluate((id) => {
    const api = (window as unknown as { sysml: SysmlSdk }).sysml;
    return api.ancestors(id)[0]?.id ?? null;
  }, vehicleId);
  expect(ownerAfter).toBe(ownerBefore); // no reparent
  await expect(page.getByTestId('tb-undo')).toBeDisabled(); // no undo entry pushed
  await shot(page, 'drag-b-after');

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

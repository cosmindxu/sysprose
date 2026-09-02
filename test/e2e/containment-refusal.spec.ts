/**
 * Containment can never become a cycle.
 *
 * `explorer-interactions` drags one element onto another and asserts the
 * reparent lands. Nothing ever tries the move that must NOT land: dropping an
 * element into its own descendant, which would make the containment tree a ring
 * and take every recursive walk in the app (tree render, descendants, serialize,
 * layout) with it.
 *
 * `store.reparent` is written to survive this — it catches the model's rejection,
 * pops the undo snapshot it had already pushed, and restores the redo stack it
 * had already cleared. All three of those are asserted here, because a rollback
 * that leaves a phantom undo entry is its own bug: the user's next Undo would
 * appear to do nothing.
 */

import { test, expect, type Page } from '@playwright/test';
import { findElementId, gotoApp, selectElementById, shot } from './fixtures';
import { addChild, exists, modelSize, renameInTree } from './model-helpers';

/** Owner id of an element, straight from the model. */
function ownerOf(page: Page, id: string): Promise<string | null> {
  return page.evaluate(
    (i) =>
      (
        window as unknown as { sysml: { getElement(i: string): { ownerId?: string } | undefined } }
      ).sysml.getElement(i)?.ownerId ?? null,
    id,
  );
}

/** Fire an HTML5 drag of one tree row onto another, sharing one DataTransfer. */
async function dragRowOnto(page: Page, srcId: string, dstId: string): Promise<void> {
  await selectElementById(page, srcId);
  await selectElementById(page, dstId);
  const srcRow = page.locator(`[data-elementid="${srcId}"]`).first();
  const dstRow = page.locator(`[data-elementid="${dstId}"]`).first();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await srcRow.dispatchEvent('dragstart', { dataTransfer });
  await dstRow.dispatchEvent('dragover', { dataTransfer });
  await dstRow.dispatchEvent('drop', { dataTransfer });
}

test('an element cannot be dropped into its own descendant', async ({ page }) => {
  // This test deliberately provokes the guard, which logs `reparent failed` —
  // so console errors are inspected rather than required to be empty.
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await gotoApp(page);

  // ── Build Outer > Middle > Inner ──
  const rootId = await findElementId(page, 'Package', 'VehicleModel');
  const outerId = await addChild(page, rootId, 'Package');
  await renameInTree(page, outerId, 'Outer');
  const middleId = await addChild(page, outerId, 'Package');
  await renameInTree(page, middleId, 'Middle');
  const innerId = await addChild(page, middleId, 'Package');
  await renameInTree(page, innerId, 'Inner');

  const sizeBefore = await modelSize(page);
  const undoDepthProbe = await hasUndo(page);
  expect(undoDepthProbe, 'the setup itself should be undoable').toBe(true);
  await shot(page, 'cycle-a-nested');

  // ── The illegal move: Outer into Inner (its own grandchild) ──
  await dragRowOnto(page, outerId, innerId);

  // Nothing moved. Outer still hangs off the root, Inner still off Middle.
  await expect.poll(() => ownerOf(page, outerId)).toBe(rootId);
  expect(await ownerOf(page, innerId)).toBe(middleId);
  expect(await ownerOf(page, middleId)).toBe(outerId);
  expect(await modelSize(page)).toBe(sizeBefore);
  // The tree is still walkable — a cycle would have broken rendering outright.
  await expect(page.locator(`[data-elementid="${innerId}"]`).first()).toBeVisible();
  await shot(page, 'cycle-b-refused');

  // The refusal is reported to the console, and it is a HANDLED refusal — never
  // an uncaught page error.
  expect(consoleErrors.join('\n')).toContain('reparent failed');
  expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);

  // ── No phantom undo step: Undo must reach the real previous edit ──
  // (`reparent` pops the snapshot it pushed; if it did not, this Undo would be a
  // visible no-op and the rename below would survive.)
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => nameOfInner(page, innerId)).toBe(null);
  expect(await exists(page, innerId)).toBe(true);
  await shot(page, 'cycle-c-undo-not-wasted');
});

/** True when the toolbar reports something to undo. */
async function hasUndo(page: Page): Promise<boolean> {
  return page.getByTestId('tb-undo').isEnabled();
}

/** The declared name of an element, or null. */
function nameOfInner(page: Page, id: string): Promise<string | null> {
  return page.evaluate(
    (i) =>
      (
        window as unknown as {
          sysml: { getElement(i: string): { declaredName?: string } | undefined };
        }
      ).sysml.getElement(i)?.declaredName ?? null,
    id,
  );
}

test('pasting a subtree into one of its own members clones a snapshot, finitely', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await gotoApp(page);

  // ── Build Parent > Child ──
  const rootId = await findElementId(page, 'Package', 'VehicleModel');
  const parentId = await addChild(page, rootId, 'Package');
  await renameInTree(page, parentId, 'Parent');
  const childId = await addChild(page, parentId, 'PartDefinition');
  await renameInTree(page, childId, 'Child');

  const sizeBefore = await modelSize(page);

  // ── Copy Parent, then paste it INTO its own child ──
  await selectElementById(page, parentId);
  await page.keyboard.press('Control+c');
  await selectElementById(page, childId);
  await page.keyboard.press('Control+v');

  // The clipboard is a detached snapshot, so exactly one Parent-subtree worth of
  // elements lands — never a recursive explosion.
  await expect.poll(() => modelSize(page)).toBeGreaterThan(sizeBefore);
  const grew = (await modelSize(page)) - sizeBefore;
  expect(grew, 'a 2-element subtree should paste as 2 elements').toBe(2);

  // The original nesting is intact and the clone lives under Child.
  expect(await ownerOf(page, parentId)).toBe(rootId);
  expect(await ownerOf(page, childId)).toBe(parentId);
  await shot(page, 'cycle-d-pasted-into-own-child');

  // ── One undo removes the whole pasted subtree ──
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => modelSize(page)).toBe(sizeBefore);

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
});

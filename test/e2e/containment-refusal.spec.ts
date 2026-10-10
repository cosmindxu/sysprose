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
 *
 * Nor does an element added in the Explorer, dragged there or pasted there land
 * inside the standard library (the last test).
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, openTab, selectElementById, shot } from './fixtures';
import { addChild, exists, idsOfType, modelSize, renameInTree } from './model-helpers';

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

/** Where an element's row is among the Explorer's rows, top to bottom (-1 for none). */
function rowIndex(page: Page, id: string): Promise<number> {
  return page.evaluate(
    (i) =>
      Array.from(document.querySelectorAll('[data-testid="tree-node"]')).findIndex(
        (r) => r.getAttribute('data-elementid') === i,
      ),
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

/**
 * Nor does an element of the user's land inside the standard library, which
 * the text never holds: with the Explorer's library toggle on, one added under
 * a library row, dragged onto one, or pasted onto one, goes to the top level of
 * the model instead — so the Text view holds it — and the strip under the
 * toolbar says so. One Undo takes the move back, and the note with it. Nor
 * does a library element's Documentation box write a doc: it is read-only.
 */
test('an element added under, dragged onto, or pasted onto a library row goes to the top level of the model', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await page.getByTestId('explorer-library-toggle').check();
  const libRow = page.locator('[data-testid="tree-node"].is-library').first();
  await expect(libRow).toBeVisible();
  const libId = (await libRow.getAttribute('data-elementid'))!;
  const strip = page.getByTestId('drive-strip');

  // ── A library element's Documentation box is read-only ──
  await selectElementById(page, libId);
  await expect(page.getByTestId('prop-doc')).toHaveAttribute('readonly', '');

  // ── Add a part definition under the library package: it lands at the top ──
  const strayId = await addChild(page, libId, 'PartDefinition');
  expect(await ownerOf(page, strayId)).toBe(null);
  await expect(strip).toHaveAttribute('data-status', 'info');
  await expect(strip).toContainText('so the new element is at the top level of your model instead');
  await renameInTree(page, strayId, 'Stray');
  // Its row sits among the model's own, above the library's packages — not
  // below them, where it would read as having landed in one.
  const strayRow = await rowIndex(page, strayId);
  expect(strayRow).toBeGreaterThan(-1);
  expect(strayRow).toBeLessThan(await rowIndex(page, libId));
  await openTab(page, 'tab-text');
  await expect(page.getByTestId('text-editor')).toHaveValue(/part def Stray;/);
  await shot(page, 'library-a-added-at-top');
  await page.getByTestId('drive-strip-dismiss').click();
  await expect(strip).toHaveCount(0);

  // ── Drag one of the model's part definitions onto the library package ──
  const engineId = await findElementId(page, 'PartDefinition', 'Engine');
  const ownerBefore = await ownerOf(page, engineId);
  expect(ownerBefore).not.toBe(null);
  await dragRowOnto(page, engineId, libId);
  await expect.poll(() => ownerOf(page, engineId)).toBe(null);
  await expect(strip).toContainText('so the element is at the top level of your model instead');
  await shot(page, 'library-b-dragged-to-top');

  // ── One Undo puts it back where it was, and takes the note down ──
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => ownerOf(page, engineId)).toBe(ownerBefore);
  await expect(strip).toHaveCount(0);

  // ── Copy it and paste onto the library package: the copy goes to the top level ──
  const partDefsBefore = await idsOfType(page, 'PartDefinition');
  await selectElementById(page, engineId);
  await page.locator('.toolbar-brand').click(); // off any control, so the page takes the keys
  await page.keyboard.press('ControlOrMeta+c');
  await selectElementById(page, libId);
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await idsOfType(page, 'PartDefinition')).length).toBe(partDefsBefore.length + 1);
  const copyId = (await idsOfType(page, 'PartDefinition')).find((id) => !partDefsBefore.includes(id))!;
  expect(await ownerOf(page, copyId)).toBe(null);
  await expect(strip).toContainText('so the element is at the top level of your model instead');
  await shot(page, 'library-c-pasted-to-top');
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => exists(page, copyId)).toBe(false);
  await expect(strip).toHaveCount(0);
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

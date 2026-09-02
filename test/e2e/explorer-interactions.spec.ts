/**
 * Explorer interaction coverage — the containment tree's full interaction
 * surface, each assertion verified against the live `window.sysml` model:
 *
 *  - expand / collapse a node via its twisty;
 *  - create children of several metaclasses via tree-add + the picker;
 *  - inline rename via dblclick + Enter, and Escape cancelling a rename;
 *  - delete cascading to descendants via tree-delete;
 *  - HTML5 drag-and-drop reparent (dragstart/dragover/drop on tree rows),
 *    asserting the model reparents the dragged element under the drop target.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, gotoApp, findElementId, shot } from './fixtures';

function countOfType(page: Page, eClass: string): Promise<number> {
  return page.evaluate(
    (e) =>
      (window as unknown as { sysml: { elementsOfType: (t: string) => unknown[] } }).sysml
        .elementsOfType(e).length,
    eClass,
  );
}

/** All element ids of a metaclass via the SDK. */
function idsOfType(page: Page, eClass: string): Promise<string[]> {
  return page.evaluate(
    (e) =>
      (window as unknown as {
        sysml: { elementsOfType: (t: string) => { id: string }[] };
      }).sysml
        .elementsOfType(e)
        .map((x) => x.id),
    eClass,
  );
}

/** The child element ids of `id` via the SDK. */
function childIds(page: Page, id: string): Promise<string[]> {
  return page.evaluate(
    (i) =>
      (window as unknown as { sysml: { children: (x: string) => { id: string }[] } }).sysml
        .children(i)
        .map((c) => c.id),
    id,
  );
}

/** Create a child of `eClass` under the given tree row and return its new id. */
async function addChild(
  page: Page,
  ownerRow: ReturnType<Page['locator']>,
  eClass: string,
): Promise<string> {
  const before = await idsOfType(page, eClass);
  await ownerRow.click();
  await ownerRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption(eClass);
  await expect.poll(async () => (await idsOfType(page, eClass)).length).toBe(before.length + 1);
  const after = await idsOfType(page, eClass);
  const created = after.find((id) => !before.includes(id));
  if (!created) throw new Error(`No new ${eClass} created`);
  return created;
}

test('explorer expand/collapse, multi-metaclass create, rename, delete-cascade, drag-reparent', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const rootId = await findElementId(page, 'Package', 'VehicleModel');
  const rootRow = page.locator(`[data-elementid="${rootId}"]`).first();

  // ── Expand / collapse: the root starts expanded; collapse hides its child
  //    `part def Vehicle` row (matched by id, not label, to avoid the root's
  //    own "VehicleModel" text matching a "Vehicle" substring) ──
  const vehicleDefId = await findElementId(page, 'PartDefinition', 'Vehicle');
  const twisty = page.locator(`[data-elementid="${rootId}"] .tree-twisty`).first();
  await expect(twisty).toHaveText('▾');
  await expect(page.locator(`[data-elementid="${vehicleDefId}"]`)).toBeVisible();
  await twisty.click();
  await expect(twisty).toHaveText('▸');
  await expect(page.locator(`[data-elementid="${vehicleDefId}"]`)).toHaveCount(0);
  await twisty.click();
  await expect(twisty).toHaveText('▾');
  await expect(page.locator(`[data-elementid="${vehicleDefId}"]`)).toBeVisible();
  await shot(page, 'explorer-a-expand-collapse');

  // ── Create children of several metaclasses under the root ──
  for (const eClass of ['Package', 'PartDefinition', 'ActionDefinition', 'StateDefinition']) {
    const before = await countOfType(page, eClass);
    await addChild(page, rootRow, eClass);
    await expect.poll(() => countOfType(page, eClass)).toBe(before + 1);
  }
  await shot(page, 'explorer-b-created');

  // ── Inline rename: dblclick + Enter commits ──
  const renameTargetId = await addChild(page, rootRow, 'PartDefinition');
  const renameRow = page.locator(`[data-elementid="${renameTargetId}"]`).first();
  await renameRow.dblclick();
  await page.getByTestId('tree-rename').fill('Renamed1');
  await page.getByTestId('tree-rename').press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as unknown as {
            sysml: { getElement: (i: string) => { declaredName?: string } | undefined };
          }).sysml.getElement(id)?.declaredName,
        renameTargetId,
      ),
    )
    .toBe('Renamed1');

  // ── Inline rename: Escape cancels (name unchanged) ──
  await renameRow.dblclick();
  await page.getByTestId('tree-rename').fill('ShouldNotStick');
  await page.getByTestId('tree-rename').press('Escape');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as unknown as {
            sysml: { getElement: (i: string) => { declaredName?: string } | undefined };
          }).sysml.getElement(id)?.declaredName,
        renameTargetId,
      ),
    )
    .toBe('Renamed1');
  await shot(page, 'explorer-c-renamed');

  // ── Delete cascades: a parent Package with a child, deleting the parent
  //    removes the child too ──
  const parentId = await addChild(page, rootRow, 'Package');
  const parentRow = page.locator(`[data-elementid="${parentId}"]`).first();
  const childId = await addChild(page, parentRow, 'PartDefinition');
  expect(await childIds(page, parentId)).toContain(childId);

  await parentRow.getByTestId('tree-delete').click();
  await expect(page.locator(`[data-elementid="${parentId}"]`)).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (ids) => {
          const api = (window as unknown as {
            sysml: { getElement: (i: string) => unknown };
          }).sysml;
          return [api.getElement(ids.p), api.getElement(ids.c)].every((e) => e === undefined);
        },
        { p: parentId, c: childId },
      ),
    )
    .toBe(true);
  await shot(page, 'explorer-d-deleted');

  // ── Drag-and-drop reparent: drag "DragSrc" onto "DragDst" ──
  const srcId = await addChild(page, rootRow, 'Package');
  const srcRow = page.locator(`[data-elementid="${srcId}"]`).first();
  await srcRow.dblclick();
  await page.getByTestId('tree-rename').fill('DragSrc');
  await page.getByTestId('tree-rename').press('Enter');

  const dstId = await addChild(page, rootRow, 'Package');
  const dstRow = page.locator(`[data-elementid="${dstId}"]`).first();
  await dstRow.dblclick();
  await page.getByTestId('tree-rename').fill('DragDst');
  await page.getByTestId('tree-rename').press('Enter');

  // Precondition: src is NOT yet a child of dst.
  expect(await childIds(page, dstId)).not.toContain(srcId);

  // Fire an HTML5 drag with a shared DataTransfer so the row handlers see the id.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await srcRow.dispatchEvent('dragstart', { dataTransfer });
  await dstRow.dispatchEvent('dragover', { dataTransfer });
  await dstRow.dispatchEvent('drop', { dataTransfer });

  await expect.poll(() => childIds(page, dstId)).toContain(srcId);
  await shot(page, 'explorer-e-reparented');

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

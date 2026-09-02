/**
 * Undo / redo as a modeller actually experiences it.
 *
 * `undo-redo.spec.ts` covers the single-step create/undo/redo round-trip. This
 * suite goes after the properties that matter once a real editing session gets
 * going:
 *
 *  1. **Granularity + depth** — a five-operation session (create, rename,
 *     create, rename, delete) unwinds one operation at a time back to the
 *     starting model, then replays forward to the end state. This pins the undo
 *     *granularity* contract: each user gesture is exactly one step.
 *  2. **Redo invalidation** — editing after an undo discards the redo branch
 *     (the toolbar's Redo goes back to disabled), so a user can never replay a
 *     future that no longer belongs to the current history.
 *  3. **Subtree atomicity** — deleting a container removes its whole subtree
 *     (and the relationships that referenced it) and a *single* undo brings all
 *     of it back, ids included.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, shot } from './fixtures';
import {
  addChild,
  countOfType,
  deleteInTree,
  exists,
  hasNamed,
  modelSize,
  nameOf,
  renameInTree,
} from './model-helpers';

test('a five-step editing session unwinds one gesture at a time, then replays forward', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const rootId = await findElementId(page, 'Package', 'VehicleModel');
  const pkgBase = await countOfType(page, 'Package');
  const partBase = await countOfType(page, 'PartDefinition');

  // ── Five distinct gestures ──────────────────────────────────────────────
  const pkgId = await addChild(page, rootId, 'Package'); // 1. create package
  await renameInTree(page, pkgId, 'Chassis'); //            2. rename it
  const defId = await addChild(page, pkgId, 'PartDefinition'); // 3. create part def
  await renameInTree(page, defId, 'Axle'); //               4. rename it
  await deleteInTree(page, defId); //                       5. delete it
  await shot(page, 'undo-deep-a-session-end');

  const undo = page.getByTestId('tb-undo');
  const redo = page.getByTestId('tb-redo');

  // ── Unwind, checking the state after each single step ───────────────────
  await undo.click(); // undo 5 → the deleted "Axle" is back
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Axle')).toBe(true);

  await undo.click(); // undo 4 → it loses its name but still exists
  await expect.poll(() => nameOf(page, defId)).toBe(null);
  expect(await exists(page, defId)).toBe(true);

  await undo.click(); // undo 3 → the part def is gone again
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(partBase);

  await undo.click(); // undo 2 → the package loses the name "Chassis"
  await expect.poll(() => hasNamed(page, 'Package', 'Chassis')).toBe(false);
  await expect.poll(() => countOfType(page, 'Package')).toBe(pkgBase + 1);

  await undo.click(); // undo 1 → back to the starting model
  await expect.poll(() => countOfType(page, 'Package')).toBe(pkgBase);
  await shot(page, 'undo-deep-b-unwound');

  // ── Replay the whole session forward ────────────────────────────────────
  for (let i = 0; i < 5; i++) {
    await expect(redo).toBeEnabled();
    await redo.click();
  }
  await expect.poll(() => hasNamed(page, 'Package', 'Chassis')).toBe(true);
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Axle')).toBe(false);
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(partBase);
  await shot(page, 'undo-deep-c-replayed');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('editing after an undo discards the redo branch', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const rootId = await findElementId(page, 'Package', 'VehicleModel');
  const redo = page.getByTestId('tb-redo');

  // A fresh session has nothing to redo.
  await expect(redo).toBeDisabled();

  // Make a change, undo it → the change becomes redoable.
  const pkgId = await addChild(page, rootId, 'Package');
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => exists(page, pkgId)).toBe(false);
  await expect(redo).toBeEnabled();

  // A *new* edit forks the history → the abandoned branch is unreachable.
  const partBase = await countOfType(page, 'PartDefinition');
  await addChild(page, rootId, 'PartDefinition');
  await expect(redo).toBeDisabled();
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBe(partBase + 1);

  // The undone package stays gone — there is no way back to it.
  expect(await exists(page, pkgId)).toBe(false);
  await shot(page, 'undo-deep-d-branch-discarded');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('deleting a container drops its whole subtree, and one undo restores all of it', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // The sample's `vehicle` part owns engine / mass / fuelIn plus the fuelLine
  // connection and is the target of a satisfy relationship — deleting it is a
  // genuinely wide cascade, not a leaf removal.
  const vehicleId = await findElementId(page, 'PartUsage', 'vehicle');
  const engineId = await findElementId(page, 'PartUsage', 'engine');
  const massId = await findElementId(page, 'AttributeUsage', 'mass');
  const fuelInId = await findElementId(page, 'PortUsage', 'fuelIn');
  const connBefore = await countOfType(page, 'ConnectionUsage');
  const sizeBefore = await modelSize(page);

  await deleteInTree(page, vehicleId);

  // Every descendant went with it, and so did the connection between its ports.
  for (const id of [engineId, massId, fuelInId]) {
    expect(await exists(page, id), `${id} should be gone with its owner`).toBe(false);
  }
  await expect.poll(() => countOfType(page, 'ConnectionUsage')).toBe(connBefore - 1);
  expect(await modelSize(page)).toBeLessThan(sizeBefore);
  await shot(page, 'undo-deep-e-cascade-deleted');

  // ── One undo brings the entire subtree back, ids and all ──
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => exists(page, vehicleId)).toBe(true);
  for (const id of [engineId, massId, fuelInId]) {
    expect(await exists(page, id), `${id} should be restored`).toBe(true);
  }
  await expect.poll(() => countOfType(page, 'ConnectionUsage')).toBe(connBefore);
  await expect.poll(() => modelSize(page)).toBe(sizeBefore);
  await shot(page, 'undo-deep-f-cascade-restored');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

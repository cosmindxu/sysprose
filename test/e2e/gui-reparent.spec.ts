/**
 * Canvas drag-to-reparent.
 *
 * Dragging a node and dropping it ONTO another node re-owns the dragged element
 * under that node (mirroring the Explorer's drop-to-reparent). This drives a real
 * mouse drag of one rendered node onto an unrelated one and asserts: (a) the drop
 * target is highlighted mid-drag, (b) the model owner changes, and (c) undo
 * restores the original owner. Backed by the pure `resolveReparentTarget` helper
 * + the `reparentMany` store action (one undo step).
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot, type SysmlSdk } from './fixtures';

test('dragging a node onto another reparents it, with highlight + undo', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-general').click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await page.waitForTimeout(500);

  // Pick two rendered, UNRELATED nodes A,B (neither an ancestor of the other,
  // and B is not already A's owner), preferring the shallowest so A isn't
  // extent-locked deep inside a parent. Returns model ids + A's current owner.
  const pick = await page.evaluate(() => {
    const api = (window as unknown as { sysml: SysmlSdk }).sysml;
    const cands = api
      .elementsOfType('PartDefinition', 'PartUsage')
      .filter((p) => document.querySelector(`.react-flow__node[data-id="${p.id}"]`))
      .map((p) => ({ id: p.id, anc: api.ancestors(p.id).map((a) => a.id) }))
      .sort((a, b) => a.anc.length - b.anc.length);
    for (const A of cands) {
      for (const B of cands) {
        if (A.id === B.id) continue;
        if (A.anc.includes(B.id) || B.anc.includes(A.id)) continue; // related
        if ((A.anc[0] ?? null) === B.id) continue; // already owned by B
        return { a: A.id, b: B.id, ownerA: A.anc[0] ?? null };
      }
    }
    return null;
  });
  if (!pick) throw new Error('no two unrelated rendered nodes to reparent between');

  const nodeA = page.locator(`.react-flow__node[data-id="${pick.a}"]`);
  const nodeB = page.locator(`.react-flow__node[data-id="${pick.b}"]`);
  const a0 = await nodeA.boundingBox();
  const b0 = await nodeB.boundingBox();
  if (!a0 || !b0) throw new Error('picked nodes have no bounding box');
  await shot(page, 'reparent-a-before');

  // Grab A near its header, drag it onto B's centre in steps so onNodeDrag fires.
  const grabX = a0.x + Math.min(20, a0.width / 2);
  const grabY = a0.y + 8;
  const dropX = b0.x + b0.width / 2;
  const dropY = b0.y + b0.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move((grabX + dropX) / 2, (grabY + dropY) / 2, { steps: 10 });
  await page.mouse.move(dropX, dropY, { steps: 10 });

  // (a) B is highlighted as the drop target while the drag hovers it.
  await expect(nodeB).toHaveClass(/rf-reparent-target/);
  await shot(page, 'reparent-b-hover');

  await page.mouse.up();

  // (b) The model owner of A becomes B (assert via the ancestor chain).
  await expect
    .poll(async () =>
      page.evaluate((id) => {
        const api = (window as unknown as { sysml: SysmlSdk }).sysml;
        return api.ancestors(id)[0]?.id ?? null;
      }, pick.a),
    )
    .toBe(pick.b);
  // The highlight clears after the drop.
  await expect(nodeB).not.toHaveClass(/rf-reparent-target/);
  await shot(page, 'reparent-c-after');

  // (c) Undo restores the original owner.
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () =>
      page.evaluate((id) => {
        const api = (window as unknown as { sysml: SysmlSdk }).sysml;
        return api.ancestors(id)[0]?.id ?? null;
      }, pick.a),
    )
    .toBe(pick.ownerA);

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('multi-select drag reparents the whole selection in one undo step', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-general').click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await page.waitForTimeout(500);

  // Pick THREE pairwise-unrelated rendered nodes a,b,c (none an ancestor of
  // another; c not already the owner of a or b) so [a,b] can both move under c.
  const pick = await page.evaluate(() => {
    const api = (window as unknown as { sysml: SysmlSdk }).sysml;
    const cands = api
      .elementsOfType('PartDefinition', 'PartUsage')
      .filter((p) => document.querySelector(`.react-flow__node[data-id="${p.id}"]`))
      .map((p) => ({ id: p.id, anc: api.ancestors(p.id).map((a) => a.id) }));
    const unrel = (x: { id: string; anc: string[] }, y: { id: string; anc: string[] }) =>
      x.id !== y.id && !x.anc.includes(y.id) && !y.anc.includes(x.id);
    for (const a of cands)
      for (const b of cands)
        for (const c of cands) {
          if (!unrel(a, b) || !unrel(a, c) || !unrel(b, c)) continue;
          if ((a.anc[0] ?? null) === c.id || (b.anc[0] ?? null) === c.id) continue;
          return { a: a.id, b: b.id, c: c.id, ownerA: a.anc[0] ?? null, ownerB: b.anc[0] ?? null };
        }
    return null;
  });
  if (!pick) throw new Error('no three unrelated rendered nodes to multi-reparent');

  const nodeA = page.locator(`.react-flow__node[data-id="${pick.a}"]`);
  const nodeB = page.locator(`.react-flow__node[data-id="${pick.b}"]`);
  const nodeC = page.locator(`.react-flow__node[data-id="${pick.c}"]`);

  // Build the multi-selection: click a, Ctrl+click b.
  await nodeA.click();
  await nodeB.click({ modifiers: ['Control'] });

  // Drag a (part of the selection) onto c's centre → both a and b reparent under c.
  const a0 = await nodeA.boundingBox();
  const c0 = await nodeC.boundingBox();
  if (!a0 || !c0) throw new Error('nodes lost bounding boxes');
  await page.mouse.move(a0.x + Math.min(20, a0.width / 2), a0.y + 8);
  await page.mouse.down();
  await page.mouse.move(c0.x + c0.width / 2, c0.y + c0.height / 2, { steps: 12 });
  await page.mouse.up();

  const ownersOf = () =>
    page.evaluate((ids) => {
      const api = (window as unknown as { sysml: SysmlSdk }).sysml;
      return ids.map((id) => api.ancestors(id)[0]?.id ?? null);
    }, [pick.a, pick.b]);

  await expect.poll(ownersOf).toEqual([pick.c, pick.c]); // BOTH re-owned by c

  // A SINGLE undo restores BOTH original owners (one undo step).
  await page.keyboard.press('Control+z');
  await expect.poll(ownersOf).toEqual([pick.ownerA, pick.ownerB]);

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

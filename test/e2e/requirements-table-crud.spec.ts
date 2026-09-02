/**
 * Requirements table — the row operations `requirements-table.spec.ts` skips.
 *
 * That suite adds a TOP-LEVEL requirement, edits a cell and links/unlinks a
 * satisfier. Two row actions are never touched: "+" (add a NESTED requirement,
 * which is how a requirement hierarchy gets built) and "✕" (delete a
 * requirement, the only destructive action in the table). Neither the resulting
 * parent/child containment nor the delete's effect on the model was asserted
 * anywhere.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';
import { countOfType, exists, nameOf } from './model-helpers';

test('a nested requirement is added under its parent, then deleted from the table', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-requirements').click();
  await expect(page.getByTestId('requirements-table')).toBeVisible();

  const rows = page.getByTestId('req-row');
  const rowsBefore = await rows.count();
  expect(rowsBefore).toBeGreaterThan(0);
  const reqsBefore = await countOfType(page, 'RequirementUsage');

  // The sample's own requirement is the parent we nest under.
  const parentId = await rows.first().getAttribute('data-element-id');
  expect(parentId).toBeTruthy();

  // ── "+" on the parent row adds a CHILD requirement ──
  await rows.first().getByTestId('req-add-child').click();
  await expect.poll(() => countOfType(page, 'RequirementUsage')).toBe(reqsBefore + 1);
  await expect.poll(() => rows.count()).toBe(rowsBefore + 1);

  // The new row is genuinely owned by the parent — not a sibling.
  const childId = await page.evaluate((pid) => {
    const api = (
      window as unknown as { sysml: { children(id: string): { id: string; eClass: string }[] } }
    ).sysml;
    return api.children(pid).find((c) => c.eClass === 'RequirementUsage')?.id ?? null;
  }, parentId!);
  expect(childId, 'the added requirement should be a child of the clicked row').toBeTruthy();
  await expect(page.locator(`[data-testid="req-row"][data-element-id="${childId}"]`)).toHaveCount(1);
  await shot(page, 'req-crud-a-nested');

  // ── Name it through the inline cell editor ──
  const childRow = page.locator(`[data-testid="req-row"][data-element-id="${childId}"]`);
  await childRow.locator('[data-testid="req-cell"][data-col-key="name"]').click();
  const cellInput = page.getByTestId('req-cell-input');
  await expect(cellInput).toBeVisible();
  await cellInput.fill('DerivedMassLimit');
  await cellInput.press('Enter');
  await expect.poll(() => nameOf(page, childId!)).toBe('DerivedMassLimit');
  await shot(page, 'req-crud-b-named');

  // ── "✕" deletes it: gone from the table and from the model ──
  await childRow.getByTestId('req-delete').click();
  await expect.poll(() => exists(page, childId!)).toBe(false);
  await expect(page.locator(`[data-testid="req-row"][data-element-id="${childId}"]`)).toHaveCount(0);
  await expect.poll(() => rows.count()).toBe(rowsBefore);
  await expect.poll(() => countOfType(page, 'RequirementUsage')).toBe(reqsBefore);

  // The parent it hung under is untouched.
  expect(await exists(page, parentId!)).toBe(true);
  await shot(page, 'req-crud-c-deleted');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

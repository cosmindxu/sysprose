import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';

const gone = (page: import('@playwright/test').Page, ids: (string | null)[]) =>
  page.evaluate(
    (ids) => {
      const all = (
        window as unknown as { sysml: { model: { all(): { id: string }[] } } }
      ).sysml.model.all();
      const live = new Set(all.map((e) => e.id));
      return ids.every((id) => id != null && !live.has(id));
    },
    ids,
  );

/**
 * Multi-selection on the canvas: ⌘/Ctrl-click extends the selection set, and
 * bulk Delete / the "Delete N" context-menu act on the whole set in one step.
 */
test('canvas: ctrl-click multi-selects; Delete removes every selected element', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const nodes = page.locator('.react-flow__node');
  await expect.poll(() => nodes.count()).toBeGreaterThanOrEqual(2);
  const id0 = await nodes.nth(0).getAttribute('data-id');
  const id1 = await nodes.nth(1).getAttribute('data-id');

  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ['Control'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);

  await page.keyboard.press('Delete');
  await expect.poll(() => gone(page, [id0, id1])).toBe(true); // both removed
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('canvas: right-click a multi-selection → "Delete N" removes all', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const nodes = page.locator('.react-flow__node');
  await expect.poll(() => nodes.count()).toBeGreaterThanOrEqual(2);
  const id0 = await nodes.nth(0).getAttribute('data-id');
  const id1 = await nodes.nth(1).getAttribute('data-id');

  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ['Control'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);

  // Right-click a MEMBER of the selection → the set is preserved, menu goes bulk.
  await nodes.nth(0).click({ button: 'right' });
  const del = page.getByTestId('node-ctx-delete');
  await expect(del).toHaveText(/Delete 2/);
  await del.click();
  await expect.poll(() => gone(page, [id0, id1])).toBe(true);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

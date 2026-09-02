import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

type Sysml = { elementsOfType(k: string): { id: string; declaredName?: string }[] };
const idByName = (page: import('@playwright/test').Page, kind: string, name: string) =>
  page.evaluate(
    ([k, n]) =>
      (window as unknown as { sysml: Sysml }).sysml.elementsOfType(k).find((e) => e.declaredName === n)
        ?.id,
    [kind, name],
  );

/**
 * Explorer & layout GUI improvements:
 *  - the standard library is HIDDEN by default; a toggle reveals it;
 *  - a search box filters the tree (matches + ancestors) with a result count;
 *  - selecting an element anywhere (here: a requirement in the Requirements view)
 *    reveals it in the Explorer — the two parallel trees stay in sync;
 *  - the side panels collapse to a rail and resize via a splitter.
 * Zero console errors throughout.
 */
test('explorer: hide-library, search, selection-reveal, collapse + resize', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const nodes = () => page.getByTestId('tree-node').count();

  // ── Library hidden by default; toggle reveals the bundled packages ────────
  await expect(page.getByTestId('explorer-library-toggle')).not.toBeChecked();
  const userOnly = await nodes();
  await page.getByTestId('explorer-library-toggle').check();
  await expect.poll(nodes).toBeGreaterThan(userOnly); // «library package» roots appear
  await page.getByTestId('explorer-library-toggle').uncheck();
  await expect.poll(nodes).toBe(userOnly);

  await shot(page, '70-explorer-header');

  // ── Search filters to matches + their ancestor path, with a count ─────────
  const search = page.getByTestId('explorer-search');
  await search.fill('engine');
  await expect(page.getByTestId('explorer-search-count')).toBeVisible();
  await expect(page.locator('.tree-node.is-match').first()).toBeVisible();
  const matched = await nodes();
  expect(matched).toBeLessThanOrEqual(userOnly); // narrowed (or equal in a tiny model)
  await shot(page, '71-explorer-search');
  await search.press('Escape'); // clears the filter
  await expect(page.getByTestId('explorer-search')).toHaveValue('');
  await expect.poll(nodes).toBe(userOnly);

  // ── Parallel-tree sync: select a requirement in the Requirements view; the
  //    left Explorer reveals (auto-expands + scrolls to) the same element ────
  await page.getByTestId('tb-view-requirements').click();
  const reqRow = page.getByTestId('req-row').first();
  await expect(reqRow).toBeVisible();
  const reqId = await reqRow.getAttribute('data-element-id');
  await reqRow.click();
  await expect(
    page.locator(`[data-testid="tree-node"][data-elementid="${reqId}"]`),
  ).toBeVisible(); // revealed in the Explorer even though selected elsewhere

  // ── Resize the Explorer via the splitter ──────────────────────────────────
  const asideBox = async () => (await page.locator('.app-explorer').boundingBox())!;
  const before = (await asideBox()).width;
  const sp = await page.getByTestId('explorer-splitter').boundingBox();
  if (!sp) throw new Error('no splitter');
  await page.mouse.move(sp.x + 2, sp.y + sp.height / 2);
  await page.mouse.down();
  await page.mouse.move(sp.x + 90, sp.y + sp.height / 2, { steps: 6 });
  await page.mouse.up();
  expect((await asideBox()).width).toBeGreaterThan(before + 40);

  // ── Collapse the Explorer to its rail, then re-open ───────────────────────
  await page.getByTestId('explorer-collapse').click();
  await expect(page.getByTestId('explorer')).toHaveCount(0);
  await expect(page.getByTestId('explorer-expand')).toBeVisible();
  await shot(page, '72-explorer-collapsed');
  await page.getByTestId('explorer-expand').click();
  await expect(page.getByTestId('explorer')).toBeVisible();

  // ── Collapse Properties too ───────────────────────────────────────────────
  await page.getByTestId('properties-collapse').click();
  await expect(page.getByTestId('properties-expand')).toBeVisible();
  await page.getByTestId('properties-expand').click();

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('explorer: focus scopes the tree to one subtree, then "Show all" restores it', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const vehicleId = await idByName(page, 'PartUsage', 'vehicle');
  const engineDefId = await idByName(page, 'PartDefinition', 'Engine'); // a SIBLING, outside vehicle
  expect(vehicleId && engineDefId).toBeTruthy();

  // Focus on the `vehicle` subtree via its row's ◎ action (hover reveals it).
  const vRow = page.locator(`[data-testid="tree-node"][data-elementid="${vehicleId}"]`);
  await vRow.hover();
  await vRow.locator('[data-testid="tree-focus"]').click();

  // Focus strip appears; the tree is scoped — the sibling `Engine` def is gone.
  await expect(page.getByTestId('explorer-focus')).toContainText('vehicle');
  await expect(
    page.locator(`[data-testid="tree-node"][data-elementid="${engineDefId}"]`),
  ).toHaveCount(0);
  await shot(page, '75-explorer-focus');

  // "Show all" restores the whole tree.
  await page.getByTestId('explorer-focus-clear').click();
  await expect(page.getByTestId('explorer-focus')).toHaveCount(0);
  await expect(
    page.locator(`[data-testid="tree-node"][data-elementid="${engineDefId}"]`),
  ).toBeVisible();

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

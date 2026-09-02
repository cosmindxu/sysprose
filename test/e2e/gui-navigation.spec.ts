import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

type Sysml = { elementsOfType(k: string): { id: string; declaredName?: string }[] };

/**
 * Navigation polish:
 *  - tree rows carry a per-metaclass type ICON (the verbose «keyword» text moved
 *    to the row tooltip);
 *  - a BREADCRUMB shows the selection's containment path; clicking a segment
 *    selects that ancestor;
 *  - hovering an element in one navigator CROSS-HIGHLIGHTS it in the other
 *    (Requirements row ↔ Explorer node).
 */
test('navigation: type icons, breadcrumb path, cross-tree hover link', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // ── Type icons render on rows (keyword text is no longer inline) ──────────
  await expect(page.locator('.tree-icon').first()).toBeVisible();

  // ── Breadcrumb reflects the selection's path ──────────────────────────────
  const engineId = await page.evaluate(
    () =>
      (window as unknown as { sysml: Sysml }).sysml
        .elementsOfType('PartUsage')
        .find((p) => p.declaredName === 'engine')?.id,
  );
  expect(engineId).toBeTruthy();
  await page.getByTestId('explorer-search').fill('engine');
  await page.locator(`[data-testid="tree-node"][data-elementid="${engineId}"]`).click();

  const crumbs = page.getByTestId('breadcrumb-item');
  await expect(crumbs.last()).toHaveText('engine'); // selection is the last segment
  await expect(page.getByTestId('breadcrumb')).toContainText('VehicleModel'); // root ancestor
  await shot(page, '73-breadcrumb');

  // Clicking an ancestor segment selects it (breadcrumb → selection).
  await crumbs.first().click();
  await expect(page.getByTestId('breadcrumb-item').last()).toHaveText('VehicleModel');

  // ── Cross-tree hover link: hovering a requirement row highlights the same
  //    element's node in the Explorer ────────────────────────────────────────
  await page.getByTestId('explorer-search').fill(''); // clear the filter
  await page.getByTestId('tb-view-requirements').click();
  const reqRow = page.getByTestId('req-row').first();
  await expect(reqRow).toBeVisible();
  const reqId = await reqRow.getAttribute('data-element-id');
  await reqRow.hover();
  await expect(
    page.locator(`[data-testid="tree-node"][data-elementid="${reqId}"]`),
  ).toHaveClass(/is-hover-linked/);
  await shot(page, '74-hover-link');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

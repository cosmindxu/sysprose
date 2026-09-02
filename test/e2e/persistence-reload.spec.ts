/**
 * Does the user's work survive closing the tab?
 *
 * `toolbar-lifecycle.spec.ts` round-trips Save → New → Open inside one page
 * session, which only proves the in-memory project store works. These tests
 * cross a **real browser reload**, so the assertion is about IndexedDB-backed
 * persistence and about the app's honest boot behaviour:
 *
 *  - a saved project is still there after the reload and reopens intact;
 *  - unsaved edits are *not* silently resurrected — the app boots the sample,
 *    so nobody is misled into thinking their work was kept.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';
import { addChild, hasNamed, idsOfType, renameInTree } from './model-helpers';

/** Wait for the app shell + SDK after a reload (gotoApp without the navigation). */
async function waitForApp(page: Page): Promise<void> {
  await expect(page.getByTestId('explorer')).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => !!(window as unknown as { sysml?: unknown }).sysml);
}

/** Id of the root package of the freshly-created "NewModel" project. */
async function newModelRoot(page: Page): Promise<string> {
  const pkgs = await idsOfType(page, 'Package');
  const root = await page.evaluate(
    (ids) =>
      ids.find(
        (id) =>
          (
            window as unknown as {
              sysml: { getElement(i: string): { declaredName?: string } | undefined };
            }
          ).sysml.getElement(id)?.declaredName === 'NewModel',
      ) ?? null,
    pkgs,
  );
  if (!root) throw new Error('no "NewModel" package after tb-new');
  return root;
}

test('a saved project is still there after a full browser reload', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Start a clean project and put a uniquely-named marker in it.
  await page.getByTestId('tb-new').click();
  await expect(page.locator('[data-elementid]').filter({ hasText: 'NewModel' }).first()).toBeVisible();
  const rootId = await newModelRoot(page);
  const markerId = await addChild(page, rootId, 'PartDefinition');
  await renameInTree(page, markerId, 'SurvivesReload');
  await page.getByTestId('tb-save').click();
  await shot(page, 'reload-a-saved');

  // ── Reload the browser: a cold boot shows the sample, not our project ──
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'SurvivesReload')).toBe(false);
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(true);

  // ── …but the saved project is listed and reopens intact ──
  await page.getByTestId('tb-open').click();
  await expect(page.getByTestId('project-picker')).toBeVisible();
  const pick = page.getByTestId('project-pick').filter({ hasText: 'NewModel' }).first();
  await expect(pick).toBeVisible();
  await pick.click();

  await expect.poll(() => hasNamed(page, 'PartDefinition', 'SurvivesReload')).toBe(true);
  await expect(page.getByTestId('explorer').getByText('SurvivesReload')).toBeVisible();
  await shot(page, 'reload-b-reopened');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('unsaved edits are discarded by a reload rather than silently restored', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Edit the sample without ever pressing Save.
  const rootId = await page.evaluate(
    () =>
      (
        window as unknown as {
          sysml: { elementsOfType(e: string): { id: string; declaredName?: string }[] };
        }
      ).sysml
        .elementsOfType('Package')
        .find((p) => p.declaredName === 'VehicleModel')!.id,
  );
  const ghostId = await addChild(page, rootId, 'PartDefinition');
  await renameInTree(page, ghostId, 'NeverSaved');
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'NeverSaved')).toBe(true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);

  // The unsaved element is gone and the pristine sample is back.
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'NeverSaved')).toBe(false);
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(true);
  await shot(page, 'reload-c-unsaved-discarded');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

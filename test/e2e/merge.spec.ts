/**
 * Scenario 35 — in-UI 3-way branch merge (Versions tab, over the live
 * ProjectRepository via `store.api.repository`):
 *
 *   create content → Commit → New branch 'feature' → DIVERGENT edit + Commit →
 *   switch to main → CONFLICTING edit to the same element + Commit →
 *   Merge feature→main (strategy 'theirs'):
 *     • a merge-commit id appears (`version-merge-result`), and
 *     • a conflict row is reported (`version-conflict`) for the doubly-edited
 *       element, showing which side won.
 *   Then a fresh 'manual' merge over a new divergence reports conflicts and
 *   produces NO commit.
 *
 * Asserts zero uncaught console/page errors throughout.
 */

import { test, expect, type Page } from '@playwright/test';
import { gotoApp, openTab, findElementId, shot } from './fixtures';

/** Rename an element's declaredName through the live `window.sysml` SDK. */
async function renameElement(page: Page, id: string, name: string): Promise<void> {
  await page.evaluate(
    ({ id, name }) => {
      (
        window as unknown as {
          sysml: { update: (id: string, patch: Record<string, unknown>) => void };
        }
      ).sysml.update(id, { declaredName: name });
    },
    { id, name },
  );
}

test('Versions tab drives a 3-way merge: theirs resolves with a conflict; manual reports conflicts, no commit', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

  await gotoApp(page);

  // The element we edit on both branches to force a conflict.
  const vehicleId = await findElementId(page, 'PartDefinition', 'Vehicle');

  await openTab(page, 'tab-versions');

  // Seeded state: the working project's `main` branch + its initial commit.
  await expect(page.getByTestId('version-current')).toContainText('main');
  await expect(page.getByTestId('version-branch')).toHaveCount(1);
  await expect(page.getByTestId('version-commit')).toHaveCount(1); // commit-1

  // 1) Content baseline → Commit on main (commit-2).
  await page.getByTestId('version-commit-btn').click();
  await expect(page.getByTestId('version-commit')).toHaveCount(2);
  await shot(page, '35a-main-committed');

  // 2) New branch 'feature' (branches off the head and switches to it).
  await page.getByTestId('version-branch-name').fill('feature');
  await page.getByTestId('version-branch-new').click();
  await expect(page.getByTestId('version-current')).toContainText('feature');
  await expect(page.getByTestId('version-branch')).toHaveCount(2);

  // 3) DIVERGENT edit on feature (rename Vehicle) + Commit.
  await renameElement(page, vehicleId, 'FeatureVehicle');
  await page.getByTestId('version-commit-btn').click();
  await shot(page, '35b-feature-committed');

  // 4) Switch back to main (loads main's head into the workspace).
  await page.getByTestId('version-branch').filter({ hasText: 'main' }).first().click();
  await expect(page.getByTestId('version-current')).toContainText('main');

  // 5) CONFLICTING edit to the SAME element on main + Commit.
  await renameElement(page, vehicleId, 'MainVehicle');
  await page.getByTestId('version-commit-btn').click();

  // 6) Merge feature → main with strategy 'theirs'.
  await page.getByTestId('version-merge-source').selectOption({ label: 'feature' });
  await page.getByTestId('version-merge-target').selectOption({ label: 'main' });
  await page.getByTestId('version-merge-strategy').selectOption('theirs');
  await page.getByTestId('version-merge-btn').click();

  // A merge commit id appears …
  await expect(page.getByTestId('version-merge-result')).toContainText('commit-');
  // … and a conflict row is reported for the doubly-edited element (theirs won).
  await expect(page.getByTestId('version-conflict')).toHaveCount(1);
  await expect(page.getByTestId('version-conflict')).toContainText('Vehicle');
  await expect(page.getByTestId('version-conflict')).toContainText('theirs (source) won');
  await shot(page, '35c-theirs-merged');

  // 7) Manual merge path: introduce a fresh conflicting edit on main, then merge
  //    feature → main with strategy 'manual' → conflicts reported, NO commit.
  await renameElement(page, vehicleId, 'MainAgain');
  await page.getByTestId('version-commit-btn').click();

  await page.getByTestId('version-merge-source').selectOption({ label: 'feature' });
  await page.getByTestId('version-merge-target').selectOption({ label: 'main' });
  await page.getByTestId('version-merge-strategy').selectOption('manual');
  await page.getByTestId('version-merge-btn').click();

  await expect(page.getByTestId('version-merge-result')).toHaveText('(no commit)');
  await expect(page.getByTestId('version-conflict')).toHaveCount(1);
  await expect(page.getByTestId('version-conflict')).toContainText('change-change');
  await shot(page, '35d-manual-conflicts');

  // Zero uncaught console / page errors throughout.
  expect(errors).toEqual([]);
});

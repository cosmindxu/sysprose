/**
 * The merge path that SUCCEEDS.
 *
 * `merge.spec.ts` only ever drives merges that conflict — `theirs` resolving a
 * change-change collision, and `manual` refusing to commit. The clean case is
 * the one a modeller actually hits most, and it was untested: two branches that
 * touched *different* elements should merge with no conflicts, produce a real
 * merge commit, and end with BOTH edits present in the working model.
 *
 * `manual` is deliberately the strategy under test — it is the strict one, the
 * only one that refuses to invent a resolution, so a commit coming out of it is
 * proof the merge genuinely found nothing to arbitrate.
 *
 * Edits go through the Properties form rather than the SDK, so this also covers
 * "GUI edit → commit → branch → merge" as one continuous user story.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, openTab, shot } from './fixtures';
import { hasNamed, setPropName } from './model-helpers';

test('two branches touching different elements merge cleanly and keep both edits', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const engineId = await findElementId(page, 'PartDefinition', 'Engine');
  const vehicleId = await findElementId(page, 'PartDefinition', 'Vehicle');

  await openTab(page, 'tab-versions');
  await expect(page.getByTestId('versions-panel')).toBeVisible();
  await expect(page.getByTestId('version-current')).toContainText('main');

  // ── Baseline commit on main ──
  await page.getByTestId('version-commit-btn').click();
  await expect(page.getByTestId('version-commit')).toHaveCount(2);

  // ── Branch off and rename ENGINE there ──
  await page.getByTestId('version-branch-name').fill('engine-work');
  await page.getByTestId('version-branch-new').click();
  await expect(page.getByTestId('version-current')).toContainText('engine-work');

  await setPropName(page, engineId, 'PowerUnit');
  await openTab(page, 'tab-versions');
  await page.getByTestId('version-commit-btn').click();
  await shot(page, 'clean-merge-a-branch-edit');

  // ── Back on main, rename a DIFFERENT element ──
  await page.getByTestId('version-branch').filter({ hasText: 'main' }).first().click();
  await expect(page.getByTestId('version-current')).toContainText('main');
  // Switching branches reloads main's head, so the branch rename is not here.
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'PowerUnit')).toBe(false);

  await setPropName(page, vehicleId, 'Chassis');
  await openTab(page, 'tab-versions');
  await page.getByTestId('version-commit-btn').click();

  // ── Merge engine-work → main with the STRICT strategy ──
  await page.getByTestId('version-merge-source').selectOption({ label: 'engine-work' });
  await page.getByTestId('version-merge-target').selectOption({ label: 'main' });
  await page.getByTestId('version-merge-strategy').selectOption('manual');
  await page.getByTestId('version-merge-btn').click();

  // Nothing to arbitrate: no conflict rows, an explicit "no conflicts" notice,
  // and a real merge commit — `manual` would have refused to commit otherwise.
  await expect(page.getByTestId('version-merge-box')).toBeVisible();
  await expect(page.getByTestId('version-noconflict')).toBeVisible();
  await expect(page.getByTestId('version-conflict')).toHaveCount(0);
  await expect(page.getByTestId('version-merge-result')).toContainText('commit-');
  await shot(page, 'clean-merge-b-merged');

  // ── Both branches' edits survive into the merged model ──
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'PowerUnit')).toBe(true);
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Chassis')).toBe(true);
  await shot(page, 'clean-merge-c-both-edits');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

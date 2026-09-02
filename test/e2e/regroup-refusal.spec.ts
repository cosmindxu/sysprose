/**
 * Regroup workbench — the REFUSAL path.
 *
 * `regroup.spec.ts` and `regroup-enhancements.spec.ts` only drive configurations
 * that work. But the workbench's most safety-relevant behaviour is the one that
 * says *no*: `planApply` refuses configurations it cannot model faithfully
 * (rather than silently mis-porting the result), and the Apply button is meant
 * to go dead while any such error stands.
 *
 * The reachable-from-the-GUI case is NESTED existing targets — bundling into
 * `vehicle` and into `engine` at the same time, when `engine` lives inside
 * `vehicle`. The flat interior classifier cannot represent one bundle sitting
 * inside another, so the config must be rejected.
 *
 * The point of the test is that the refusal is *visible and blocking*: an error
 * shown but Apply still clickable would be worse than no check at all.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';
import { modelSize } from './model-helpers';

test('nested existing targets are refused, and Apply stays disabled until fixed', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  const sizeBefore = await modelSize(page);

  await page.getByTestId('tb-view-regroup').click();
  await expect(page.getByTestId('regroup-view')).toBeVisible();

  const picker = page.getByTestId('regroup-add-existing');
  const bins = page.getByTestId('regroup-bin');
  const binsBefore = await bins.count();

  // ── Bundle into `vehicle`, then also into `engine` (which is inside it) ──
  await picker.selectOption({ label: 'vehicle' });
  await expect(bins).toHaveCount(binsBefore + 1);
  // One target alone is fine — no complaint yet.
  await expect(page.getByTestId('regroup-errors')).toHaveCount(0);

  await picker.selectOption({ label: 'engine' });
  await expect(bins).toHaveCount(binsBefore + 2);

  // ── The nesting is reported, and Apply is dead while it stands ──
  const errorBox = page.getByTestId('regroup-errors');
  await expect(errorBox).toBeVisible();
  await expect(errorBox).toContainText(/nest|inside|cycle/i);
  await expect(page.getByTestId('regroup-apply')).toBeDisabled();
  await shot(page, 'regroup-refusal-a-nested');

  // ── Removing one of the two clears the refusal ──
  await page.getByTestId('regroup-remove-bundle').last().click();
  await expect(bins).toHaveCount(binsBefore + 1);
  await expect(page.getByTestId('regroup-errors')).toHaveCount(0);
  await shot(page, 'regroup-refusal-b-cleared');

  // Nothing above touched the model — the workbench is preview-only until Apply.
  expect(await modelSize(page)).toBe(sizeBefore);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

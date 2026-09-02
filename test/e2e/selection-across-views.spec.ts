/**
 * The selection is one thing, seen from sixteen places.
 *
 * `view-switching` tours all 16 views and checks each renders its own panel. It
 * starts from a clean slate every time and never carries state across the tour.
 * But a modeller's whole workflow is "select something, look at it another way",
 * and each view maintains its own node/row/cell rendering — so a view that
 * dropped or hijacked the selection on mount would break that workflow while
 * still rendering perfectly.
 *
 * This test carries one selection through the full tour and then checks the
 * undo stack still refers to the same session, because view switches rebuild the
 * diagram and a rebuild that leaked into history would silently cost the user an
 * undo step.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, selectElementById, shot } from './fixtures';
import { hasNamed, nameOf } from './model-helpers';

/** Every view the toolbar offers, in toolbar order. */
const VIEWS = [
  'general',
  'interconnection',
  'action',
  'state',
  'requirement',
  'tree',
  'parametric',
  'sequence',
  'allocation',
  'geometry',
  'case',
  'grid',
  'requirements',
  'analysis',
  'planning',
  'regroup',
] as const;

test('one selection survives a tour of all 16 views, and undo still lands', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // ── Make an edit, then select the element it produced ──
  const engineId = await findElementId(page, 'PartDefinition', 'Engine');
  await selectElementById(page, engineId);
  await page.getByTestId('prop-name').fill('TourSubject');
  await expect.poll(() => nameOf(page, engineId)).toBe('TourSubject');

  // ── The tour: every view, selection intact at each stop ──
  for (const view of VIEWS) {
    await page.getByTestId(`tb-view-${view}`).click();
    // The Properties panel is the selection's single source of truth across views.
    await expect(page.getByTestId('prop-name'), `selection lost on the ${view} view`).toHaveValue(
      'TourSubject',
    );
    // …and the Explorer row still shows as selected.
    await expect(
      page.locator(`[data-elementid="${engineId}"].tree-node`),
      `Explorer lost the selection on the ${view} view`,
    ).toHaveClass(/is-selected/);
  }
  await shot(page, 'tour-a-selection-held');

  // ── The tour rebuilt the diagram 16 times; none of it entered the history ──
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Engine')).toBe(true);
  await expect.poll(() => nameOf(page, engineId)).toBe('Engine');
  await shot(page, 'tour-b-undo-lands');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Planning view — the DOORS→CodeBeamer-style migration/effort wave planner.
 * Switches to the view, asserts the board + summary render, exercises the
 * ordering / grouping / capacity config controls (the plan rebuilds without
 * error), and checks zero console/page errors throughout.
 *
 * NOTE: the built-in sample model carries few/no satisfy links, so the board
 * may be mostly ungrouped under the default config — the spec asserts the view
 * and its summary render (at least one wave OR the summary readout), not any
 * specific wave contents.
 */
test('planning: wave board renders and responds to config changes', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-planning').click();
  await expect(page.getByTestId('planning-view')).toBeVisible();
  // The React Flow canvas is replaced by the dedicated planner.
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);

  // The summary readout always renders once the plan is built; its structure is
  // `N item(s) · N group(s) · N <unit>(s) · N total` — a real shape, not just "items".
  await expect(page.getByTestId('plan-summary')).toBeVisible();
  const summary = (await page.getByTestId('plan-summary').textContent()) ?? '';
  expect(summary).toMatch(/\d+ items? · \d+ groups? · \d+ \w+ · [\d.]+ total/);
  // The default sample rolls its requirement into a satisfy group → at least one wave.
  await expect(page.getByTestId('plan-wave').first()).toBeVisible();

  // Config strip is present.
  await expect(page.getByTestId('plan-atomic-kind')).toBeVisible();
  await expect(page.getByTestId('plan-workload-attr')).toBeVisible();
  await expect(page.getByTestId('plan-timeunit')).toBeVisible();

  // Selection sync: clicking a group row selects its model element (row highlights).
  const firstGroup = page.getByTestId('plan-group').first();
  await firstGroup.click();
  await expect(firstGroup).toHaveClass(/is-selected/);

  // Capacity edit takes effect: the wave header echoes the new per-slice budget.
  await page.getByTestId('plan-capacity').fill('10');
  await page.getByTestId('plan-capacity').press('Enter');
  await expect(page.getByTestId('plan-wave').first()).toContainText('/10 per');

  // Ordering + grouping changes rebuild the board without error.
  await page.getByTestId('plan-ordering').selectOption('capacity');
  await expect(page.getByTestId('plan-summary')).toBeVisible();
  await page.getByTestId('plan-grouping').selectOption('containment');
  await expect(page.getByTestId('plan-summary')).toBeVisible();
  await expect(page.getByTestId('planning-view')).toBeVisible();

  // Optimization layer: annealing ordering + the hard functional-block
  // cohesion constraint rebuild the board and surface the MinLA coupling-cost
  // readout (`coupling N`, populated for every ordering).
  await page.getByTestId('plan-ordering').selectOption('annealing');
  await expect(page.getByTestId('plan-coupling-cost')).toBeVisible();
  await expect(page.getByTestId('plan-coupling-cost')).toContainText(/coupling [\d.]+/);
  await page.getByTestId('plan-cohesion').check();
  await expect(page.getByTestId('plan-cohesion')).toBeChecked();
  await expect(page.getByTestId('plan-summary')).toBeVisible();
  await expect(page.getByTestId('plan-wave').first()).toBeVisible();
  await expect(page.getByTestId('plan-coupling-cost')).toBeVisible();

  // Exact MILP ordering also rebuilds cleanly with cohesion still on.
  await page.getByTestId('plan-ordering').selectOption('milp');
  await expect(page.getByTestId('plan-coupling-cost')).toBeVisible();
  await expect(page.getByTestId('planning-view')).toBeVisible();

  await shot(page, '52-planning');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

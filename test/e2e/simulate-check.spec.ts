/**
 * Execution & analysis toolbar actions.
 *
 *  - tb-simulate on the ACTION view runs the active action flow and lists its
 *    trace (header + numbered steps) as navigable info rows in Problems;
 *  - tb-simulate on the STATE view drives the state machine and lists its state
 *    trace;
 *  - tb-check evaluates constraints/requirements and surfaces constraint-check
 *    rows (satisfied/violated) in Problems, plus one row per context for a
 *    target over a valueless measure that another package specialises.
 *
 * The behaviors/constraint are authored on the live model through
 * `window.sysml`; simulate/check read the model directly, so no diagram render
 * is required for the traces to appear.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, openTab, shot } from './fixtures';

interface AuthorSdk {
  create(eClass: string, opts: Record<string, unknown>): { id: string };
}

/** Author an action flow, a state machine, and a checkable constraint. */
async function authorBehaviors(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as unknown as { sysml: AuthorSdk }).sysml;

    // Action flow: DriveE2E { ignite → accelerate }.
    const act = api.create('ActionDefinition', { declaredName: 'DriveE2E' });
    const ignite = api.create('ActionUsage', { declaredName: 'ignite', ownerId: act.id });
    const accel = api.create('ActionUsage', { declaredName: 'accelerate', ownerId: act.id });
    api.create('Succession', { ownerId: act.id, source: [ignite.id], target: [accel.id] });

    // State machine: DriveStatesE2E { idle -start-> running }.
    const sm = api.create('StateDefinition', { declaredName: 'DriveStatesE2E' });
    const idle = api.create('StateUsage', { declaredName: 'idle', ownerId: sm.id });
    const running = api.create('StateUsage', { declaredName: 'running', ownerId: sm.id });
    api.create('TransitionUsage', {
      ownerId: sm.id,
      source: [idle.id],
      target: [running.id],
      attrs: { trigger: 'start' },
    });

    // Checkable constraint under `vehicle` (mass = 1500) → satisfied.
    const vehicle = (
      window as unknown as {
        sysml: { elementsOfType: (t: string) => { id: string; declaredName?: string }[] };
      }
    ).sysml
      .elementsOfType('PartUsage')
      .find((p) => p.declaredName === 'vehicle');
    api.create('ConstraintUsage', {
      ownerId: vehicle!.id,
      declaredName: 'massWithinLimit',
      attrs: { expression: 'mass < 2000' },
    });
    // An equation that defines a valueless feature (CV-17): Check says what it
    // fixes, not only that it holds.
    api.create('AttributeUsage', { ownerId: vehicle!.id, declaredName: 'payloadE2E' });
    api.create('ConstraintUsage', {
      ownerId: vehicle!.id,
      declaredName: 'payloadDefinition',
      attrs: { expression: 'payloadE2E == mass / 3' },
    });
    // A target over a measure with no value of its own, read through the
    // feature that specialises it in another package: Check lists the reading
    // as its own row, at the estimate (target-by-specialisation).
    const common = api.create('Package', { declaredName: 'CommonE2E' });
    const measure = api.create('AttributeUsage', { ownerId: common.id, declaredName: 'coverageE2E' });
    api.create('ConstraintUsage', {
      ownerId: common.id,
      declaredName: 'coverageTargetE2E',
      attrs: { expression: 'coverageE2E >= 0.9' },
    });
    const layer = api.create('Package', { declaredName: 'LayerE2E' });
    const estimate = api.create('AttributeUsage', {
      ownerId: layer.id,
      declaredName: 'coverageE2E',
      attrs: { value: '0.5' },
    });
    api.create('Subsetting', { ownerId: estimate.id, source: [estimate.id], target: [measure.id] });
  });
}

test('Simulate lists action-flow and state-machine traces; Check lists constraints', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await authorBehaviors(page);

  /* ── Simulate on the action view → action-flow trace ── */
  await page.getByTestId('tb-view-action').click();
  await page.getByTestId('tb-simulate').click();
  await openTab(page, 'tab-problems');
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'Action flow' }).first(),
  ).toBeVisible();
  const igniteRow = page.getByTestId('problem-row').filter({ hasText: 'ignite' }).first();
  await expect(igniteRow).toBeVisible();
  // A trace step row carries the underlying element id (navigable).
  expect(await igniteRow.getAttribute('data-elementid')).toBeTruthy();
  await shot(page, 'simcheck-action');

  /* ── Simulate on the state view → state-machine trace ── */
  await page.getByTestId('tb-view-state').click();
  await page.getByTestId('tb-simulate').click();
  await openTab(page, 'tab-problems');
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'State machine' }).first(),
  ).toBeVisible();
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'idle' }).first(),
  ).toBeVisible();
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'running' }).first(),
  ).toBeVisible();
  await shot(page, 'simcheck-state');

  /* ── Check → constraint-satisfaction rows ── */
  await page.getByTestId('tb-check').click();
  await openTab(page, 'tab-problems');
  const checkRow = page.getByTestId('problem-row').filter({ hasText: 'constraint-check' }).first();
  await expect(checkRow).toBeVisible();
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'Constraint satisfied' }).first(),
  ).toBeVisible();
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'Constraint satisfied: defines payloadE2E = 500' }).first(),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('problem-row')
      .filter({ hasText: 'LayerE2E::coverageE2E = 0.5 misses CommonE2E::coverageTargetE2E (coverageE2E >= 0.9)' })
      .first(),
  ).toBeVisible();
  await shot(page, 'simcheck-check');

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

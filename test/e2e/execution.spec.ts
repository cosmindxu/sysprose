/**
 * Scenario — fuller behavioral execution surface: author a COMPOSITE action
 * (an action whose nested sub-flow computes and returns a result parameter)
 * through the live `window.sysml` SDK, click the toolbar "Simulate" affordance,
 * and confirm the deeper trace surfaces in the Problems tab: composite
 * sub-behavior enter/exit markers and the produced data value.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, openTab, shot } from './fixtures';

/** SDK surface (subset) used to author a composite action in-page. */
interface SimSdk {
  create(eClass: string, opts: Record<string, unknown>): { id: string };
}

test('Simulate shows the deeper composite trace (enter/exit + produced data)', async ({ page }) => {
  await gotoApp(page);

  // Author: CompositeE2E { start → subtask{ compute result = 20+22 } → done }.
  await page.evaluate(() => {
    const api = (window as unknown as { sysml: SimSdk }).sysml;
    const outer = api.create('ActionDefinition', { declaredName: 'CompositeE2E' });
    const start = api.create('InitialNode', { ownerId: outer.id });
    const sub = api.create('ActionUsage', { declaredName: 'subtask', ownerId: outer.id });
    api.create('AttributeUsage', { ownerId: sub.id, declaredName: 'result', attrs: { direction: 'out' } });
    const subStart = api.create('InitialNode', { ownerId: sub.id });
    const compute = api.create('AssignmentActionUsage', {
      ownerId: sub.id,
      declaredName: 'compute',
      attrs: { target: 'result', value: '20 + 22' },
    });
    const subDone = api.create('DoneNode', { ownerId: sub.id });
    api.create('Succession', { ownerId: sub.id, source: [subStart.id], target: [compute.id] });
    api.create('Succession', { ownerId: sub.id, source: [compute.id], target: [subDone.id] });
    const done = api.create('DoneNode', { ownerId: outer.id });
    api.create('Succession', { ownerId: outer.id, source: [start.id], target: [sub.id] });
    api.create('Succession', { ownerId: outer.id, source: [sub.id], target: [done.id] });
  });

  await page.getByTestId('tb-simulate').click();
  await openTab(page, 'tab-problems');

  const rows = page.getByTestId('problem-row');
  await expect(rows.first()).toBeVisible();

  // Header row names the composite action flow.
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'Action flow' }).first(),
  ).toBeVisible();

  // A sub-behavior enter marker for the nested action.
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'enter' }).first(),
  ).toBeVisible();

  // The exit marker carries the produced result parameter (20 + 22 = 42).
  const exitRow = page.getByTestId('problem-row').filter({ hasText: 'result=42' }).first();
  await expect(exitRow).toBeVisible();

  await shot(page, 'exec-composite-trace');

  // Trace rows remain navigable (carry the underlying element id).
  const elementId = await exitRow.getAttribute('data-elementid');
  expect(elementId).toBeTruthy();
});

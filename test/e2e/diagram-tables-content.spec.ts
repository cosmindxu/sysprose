/**
 * The Grid and Sequence views — their CONTENT, not just that they mount.
 *
 * `diagram-views2/3` check these two renderers for "renders without console
 * errors", and `diagram-views3` additionally counts grid rows and column
 * headers. Neither ever reads a cell, a lifeline or a message. A grid that
 * rendered every cell empty, or a sequence view that drew lifelines but dropped
 * every message, would sail through all of it.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, openTab, shot } from './fixtures';
import { hasNamed } from './model-helpers';

/** One cell of the grid row for `id`, by column key. */
const cellOf = (page: Page, id: string, col: string) =>
  page.locator(`[data-testid="grid-row"][data-element-id="${id}"] [data-col-key="${col}"]`);

test('grid cells carry each element real metaclass, type and value', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-grid').click();
  await expect(page.getByTestId('grid-view')).toBeVisible();
  await expect.poll(() => page.getByTestId('grid-row').count()).toBeGreaterThan(0);

  // The sample's `mass` attribute is `attribute mass : Real = 1500` — every one
  // of those facts is a separate column, so the row proves the whole projection.
  const massId = await findElementId(page, 'AttributeUsage', 'mass');
  await expect(cellOf(page, massId, 'name')).toHaveText('mass');
  await expect(cellOf(page, massId, 'metaclass')).toHaveText('AttributeUsage');
  await expect(cellOf(page, massId, 'value')).toHaveText('1500');
  await expect(cellOf(page, massId, 'type')).toContainText('Real');
  await shot(page, 'grid-a-cells');

  // A part usage row projects the same columns, with its own metaclass.
  const vehicleId = await findElementId(page, 'PartUsage', 'vehicle');
  await expect(cellOf(page, vehicleId, 'name')).toHaveText('vehicle');
  await expect(cellOf(page, vehicleId, 'metaclass')).toHaveText('PartUsage');
  await expect(cellOf(page, vehicleId, 'type')).toContainText('Vehicle');

  // Relationships are deliberately NOT rows — the grid lists elements.
  const rowIds = await page
    .getByTestId('grid-row')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-element-id')));
  const satisfyId = await findElementId(page, 'SatisfyRequirementUsage').catch(() => null);
  if (satisfyId) expect(rowIds).not.toContain(satisfyId);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

const FLOW = `package Flow {
  action def Trip {
    action start;
    action drive;
    action arrive;
    succession start then drive;
    succession drive then arrive;
  }
}
`;

test('the sequence view draws one lifeline per participant and one message per succession', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await openTab(page, 'tab-text');
  await page.getByTestId('text-editor').fill(FLOW);
  await page.getByTestId('text-apply').click();
  // (The bundled standard library contributes Successions of its own, so wait on
  // OUR last action rather than on a global count.)
  await expect.poll(() => hasNamed(page, 'ActionUsage', 'arrive')).toBe(true);

  await page.getByTestId('tb-view-sequence').click();

  // Three actions take part, so three lifelines — deduplicated by participant,
  // not one per message endpoint (`drive` is both a target and a source).
  const lifelines = page.getByTestId('sequence-lifeline');
  await expect(lifelines).toHaveCount(3);

  // …and one message per succession, in declaration order.
  const messages = page.getByTestId('sequence-message');
  await expect(messages).toHaveCount(2);
  await shot(page, 'sequence-a-content');

  // Each lifeline is anchored to a real model element.
  const ids = await lifelines.evaluateAll((ls) => ls.map((l) => l.getAttribute('data-element-id')));
  for (const name of ['start', 'drive', 'arrive']) {
    const id = await findElementId(page, 'ActionUsage', name);
    expect(ids, `${name} should have a lifeline`).toContain(id);
  }

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

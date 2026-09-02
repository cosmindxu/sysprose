import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Regroup Workbench enhancements:
 *  1. Bundle INTO an existing part — the "+ Existing part…" picker adds an
 *     existing-part bundle (config-only), which the "×" removes again.
 *  2. Inline port rename — when a crossing connection exists, the boundary panel
 *     exposes an editable delegation-port name.
 *  3. Regroup a selected Analysis cluster — the Graph Analysis view hands the
 *     selected node's whole community to the workbench and switches to it.
 * All preview-only: zero model mutation, zero console errors.
 */

const modelSize = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () => (window as unknown as { sysml: { model: { all(): unknown[] } } }).sysml.model.all().length,
  );

test('regroup: existing-part picker adds + removes a target bundle (config-only)', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  const countBefore = await modelSize(page);

  await page.getByTestId('tb-view-regroup').click();
  await expect(page.getByTestId('regroup-view')).toBeVisible();

  const picker = page.getByTestId('regroup-add-existing');
  await expect(picker).toBeEnabled();
  const binsBefore = await page.getByTestId('regroup-bin').count();

  // Pick the first real existing part (index 0 is the placeholder option).
  await picker.selectOption({ index: 1 });
  await expect(page.getByTestId('regroup-bin')).toHaveCount(binsBefore + 1);
  // The added bundle is flagged "existing" and carries a remove button.
  await expect(page.getByTestId('regroup-bins')).toContainText('existing');
  const remove = page.getByTestId('regroup-remove-bundle');
  await expect(remove.first()).toBeVisible();

  // Removing it returns to the prior bin count.
  await remove.first().click();
  await expect(page.getByTestId('regroup-bin')).toHaveCount(binsBefore);

  await shot(page, '62-regroup-existing-picker');

  // Everything above is preview-only.
  expect(await modelSize(page)).toBe(countBefore);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('regroup: a crossing connection exposes an editable delegation-port name', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  const countBefore = await modelSize(page);

  await page.getByTestId('tb-view-regroup').click();
  await page.getByTestId('regroup-seed').click();
  await page.getByTestId('regroup-add-bundle').click();

  // Split a seeded chip into the new bundle so a connection crosses (same idiom
  // as the main regroup spec — HTML5 DnD via synthesized DragEvents).
  await page.evaluate(() => {
    const chip = document.querySelector('[data-testid="regroup-part"]') as HTMLElement;
    const bins = document.querySelectorAll('[data-testid="regroup-bin"]');
    const bin = bins[bins.length - 1] as HTMLElement;
    const dataTransfer = new DataTransfer();
    const opts = { bubbles: true, cancelable: true, dataTransfer };
    chip.dispatchEvent(new DragEvent('dragstart', opts));
    bin.dispatchEvent(new DragEvent('dragover', opts));
    bin.dispatchEvent(new DragEvent('drop', opts));
  });

  // A proposed-port name input appears; rename it and confirm the boundary rows
  // adopt the new name.
  const portInput = page.getByTestId('regroup-port-name').first();
  await expect(portInput).toBeVisible();
  await portInput.fill('renamedPort');
  await portInput.blur();
  await expect(page.getByTestId('regroup-boundary')).toContainText('renamedPort');

  await shot(page, '63-regroup-port-rename');

  expect(await modelSize(page)).toBe(countBefore); // still preview-only
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('analysis → regroup: "Regroup cluster" seeds the workbench from a selected community', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  const countBefore = await modelSize(page);

  await page.getByTestId('tb-view-analysis').click();
  await expect(page.getByTestId('graph-analysis')).toBeVisible();

  // With Louvain on (default) and a clustered node selected, the handoff button
  // is enabled. Select a PART node via a dispatched DOM click — the force-graph
  // node sits at a panned viewBox coordinate the SVG would otherwise intercept,
  // and picking a part guarantees the community rolls up to a real bundle.
  const btn = page.getByTestId('analysis-regroup-cluster');
  const partId = await page.evaluate(
    () =>
      (window as unknown as { sysml: { elementsOfType(k: string): { id: string }[] } }).sysml
        .elementsOfType('PartUsage')[0]?.id,
  );
  await page.evaluate((id) => {
    const node = document.querySelector(
      `[data-testid="graph-node"][data-element-id="${id}"]`,
    ) as HTMLElement;
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, partId);
  await expect(btn).toBeEnabled();

  await btn.click();

  // We land in the Regroup Workbench, seeded with ≥1 bundle (its remove "×"
  // proves a bundle bin was created from the selected community).
  await expect(page.getByTestId('regroup-view')).toBeVisible();
  await expect(page.getByTestId('regroup-bins')).toBeVisible();
  expect(await page.getByTestId('regroup-remove-bundle').count()).toBeGreaterThanOrEqual(1);

  await shot(page, '64-analysis-to-regroup');

  // The whole handoff is preview-only.
  expect(await modelSize(page)).toBe(countBefore);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Canvas mini-toolbar (top-right of the diagram): Fit (zoom-to-fit),
 * Fit-to-selection (enabled once an on-canvas element is selected), and a
 * Snap-to-grid toggle — surfaced on the diagram itself, not just the toolbar.
 */
test('canvas mini-toolbar: fit, fit-to-selection, snap-to-grid toggle', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // The mini-toolbar is present on a graph view.
  const bar = page.getByTestId('diagram-minibar');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('diagram-fit')).toBeVisible();

  // Fit-to-selection is disabled until an on-canvas node is selected.
  await expect(page.getByTestId('diagram-fit-selection')).toBeDisabled();
  await page.locator('.react-flow__node').first().click(); // selects that element
  await expect(page.getByTestId('diagram-fit-selection')).toBeEnabled();

  // Fit + fit-selection run without error (no assertion on the resulting zoom).
  await page.getByTestId('diagram-fit-selection').click();
  await page.getByTestId('diagram-fit').click();

  // Snap-to-grid toggles its active state.
  const snap = page.getByTestId('diagram-snap');
  await expect(snap).not.toHaveClass(/is-active/);
  await snap.click();
  await expect(snap).toHaveClass(/is-active/);
  await shot(page, '78-canvas-minibar');
  await snap.click();
  await expect(snap).not.toHaveClass(/is-active/);

  // The mini-toolbar rides with the canvas: gone on a non-graph view.
  await page.locator('.viewbar [data-testid="tb-view-grid"]').click();
  await expect(page.getByTestId('diagram-minibar')).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

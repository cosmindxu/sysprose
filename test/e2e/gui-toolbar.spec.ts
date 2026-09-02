import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Toolbar restructure — two tiers instead of one long horizontally-scrolling row:
 *  - Row 1 (command bar) no longer holds the 16 view tabs, and the five export
 *    commands collapse into a single Export ▾ dropdown.
 *  - Row 2 (view bar) is a dedicated, category-grouped view switcher (Diagrams /
 *    Tables / Analyze) that wraps instead of scrolling; the tabs keep their ids.
 */
test('toolbar: command row + grouped view bar; Export is a menu; view tabs relocated', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Row 2 view bar with the three category groups.
  const viewbar = page.locator('.viewbar');
  await expect(viewbar).toBeVisible();
  for (const group of ['Diagrams', 'Tables', 'Analyze']) {
    await expect(viewbar).toContainText(group);
  }

  // The view tabs moved OUT of the command row into the view bar (same testids).
  await expect(page.locator('.toolbar [data-testid="tb-view-general"]')).toHaveCount(0);
  await expect(viewbar.locator('[data-testid="tb-view-general"]')).toBeVisible();

  // Switching still works from the view bar.
  await viewbar.locator('[data-testid="tb-view-analysis"]').click();
  await expect(page.getByTestId('graph-analysis')).toBeVisible();
  await viewbar.locator('[data-testid="tb-view-general"]').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // Export is now a dropdown: its items are hidden until the menu is opened.
  await expect(page.getByTestId('tb-export-sysml')).toHaveCount(0);
  await page.getByTestId('tb-export').click();
  await expect(page.getByTestId('tb-export-menu')).toBeVisible();
  await expect(page.getByTestId('tb-export-sysml')).toBeVisible();
  await expect(page.getByTestId('tb-export-png')).toBeVisible();
  await shot(page, '76-toolbar');

  // An outside click (on the brand) closes the menu.
  await page.getByTestId('toolbar-brand').click();
  await expect(page.getByTestId('tb-export-menu')).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('toolbar: diagram-only tools (Auto-layout, SVG/PNG export) disable off a graph view', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  const viewbar = page.locator('.viewbar');

  // On a graph view (General): Auto-layout enabled; the SVG/PNG export items enabled.
  await expect(page.getByTestId('tb-layout')).toBeEnabled();
  await page.getByTestId('tb-export').click();
  await expect(page.getByTestId('tb-export-svg')).toBeEnabled();
  await expect(page.getByTestId('tb-export-sysml')).toBeEnabled(); // model export always on
  await page.getByTestId('toolbar-brand').click(); // close menu

  // Switch to a non-graph view (Grid, a table): diagram-only tools go inert.
  await viewbar.locator('[data-testid="tb-view-grid"]').click();
  await expect(page.getByTestId('center-grid')).toBeVisible();
  await expect(page.getByTestId('tb-layout')).toBeDisabled();
  await page.getByTestId('tb-export').click();
  await expect(page.getByTestId('tb-export-svg')).toBeDisabled(); // diagram export inert
  await expect(page.getByTestId('tb-export-png')).toBeDisabled();
  await expect(page.getByTestId('tb-export-sysml')).toBeEnabled(); // …but model export stays on

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/**
 * The palette's Checks section, in the browser.
 *
 * What a person can do from a diagram: run the check that fits the view, read
 * the verdict where they clicked, see the findings in the Checks tab, click a
 * finding to select the element — and, for a check this page cannot run, get
 * the command instead of a verdict nobody earned.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, selectElementById } from './fixtures';

test('a model check runs here, lands in the Checks tab, and goes stale on an edit', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const orphans = page.locator('[data-testid="palette-check"][data-check="orphans"]');
  await expect(orphans).toBeVisible();
  // Nothing has run yet, and the palette says so rather than showing a verdict.
  await expect(orphans.getByTestId('palette-check-verdict')).toHaveText('not run');

  await orphans.getByTestId('palette-check-run').click();
  await expect(orphans).toHaveAttribute('data-verdict', /holds|issues/);

  // The results are in front of the person who asked for them.
  await expect(page.locator('.bottom-tab.is-active')).toContainText('Checks');
  const result = page.locator('[data-testid="checks-result"][data-check="orphans"]');
  await expect(result).toBeVisible();
  await expect(result).toContainText('definitions touch nothing');

  // An edit does not silently invalidate the verdict: it is labelled stale.
  await page.getByTestId('tb-new').click();
  await expect(page.locator('[data-testid="checks-result"][data-check="orphans"]')).toHaveAttribute('data-verdict', 'stale');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a finding selects its element', async ({ page }) => {
  await gotoApp(page);
  const requirements = page.locator('[data-testid="palette-check"][data-check="requirements"]');
  await requirements.getByTestId('palette-check-run').click();
  await expect(page.locator('[data-testid="checks-result"][data-check="requirements"]')).toBeVisible();
  const link = page.getByTestId('checks-row-select').first();
  if (await link.count()) {
    await link.click();
    await expect(page.getByTestId('properties')).toBeVisible();
  }
});

test('a solver check offers its command instead of a verdict it cannot give', async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId('tb-view-contracts').click();
  const faultTree = page.locator('[data-testid="palette-check"][data-check="fault-tree"]');
  await expect(faultTree).toBeVisible();
  await faultTree.getByTestId('palette-check-run').click();
  await expect(faultTree).toHaveAttribute('data-verdict', 'unavailable');
  await expect(faultTree.getByTestId('palette-check-verdict')).toHaveText('not here');
  const result = page.locator('[data-testid="checks-result"][data-check="fault-tree"]');
  await expect(result).toContainText('cross-origin-isolated');
  await expect(result).toContainText('sysprose -- fault-tree');
});

test('contracts and obligations read the selection as --element does, and say when they cover the whole model', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await page.getByTestId('tb-view-requirement').click();
  const contracts = page.locator('[data-testid="palette-check"][data-check="contracts"]');
  const obligations = page.locator('[data-testid="palette-check"][data-check="obligations"]');

  // A part selected: the run covers it and what it contains, and the command names it.
  const vehicle = await findElementId(page, 'PartUsage', 'vehicle');
  await selectElementById(page, vehicle);
  await expect(obligations.getByTestId('palette-check-copy')).toHaveAttribute(
    'title',
    /^npm run sysprose -- obligations \S+ --element VehicleModel::vehicle$/,
  );
  await obligations.getByTestId('palette-check-run').click();
  await expect(obligations).toContainText('— scoped to VehicleModel::vehicle');
  // The whole model's figure beside the scoped one, so it never reads as the total.
  await expect(obligations.locator('.palette-check-summary')).toHaveText(/^\d+ of \d+ obligation\(s\)/);
  const result = page.locator('[data-testid="checks-result"][data-check="obligations"]');
  await expect(result).toContainText('scoped to VehicleModel::vehicle');
  await expect(result.getByTestId('checks-row').first()).toContainText('checks/scoped');

  // Beside a command for another element the result is stale; back on its own, it is current
  // again. The Checks tab, whose rows select what they name, keeps what it said.
  await expect(obligations).toHaveAttribute('data-verdict', 'holds');
  await selectElementById(page, await findElementId(page, 'Package', 'VehicleModel'));
  await expect(obligations).toHaveAttribute('data-verdict', 'stale');
  await expect(result).toHaveAttribute('data-verdict', 'holds');
  await selectElementById(page, vehicle);
  await expect(obligations).toHaveAttribute('data-verdict', 'holds');

  // The model is edited in place: a renamed selection is named anew in the command.
  await page.evaluate(
    (id) =>
      (window as unknown as { sysml: { update(id: string, patch: { declaredName: string }): unknown } }).sysml.update(id, {
        declaredName: 'car',
      }),
    vehicle,
  );
  await expect(contracts.getByTestId('palette-check-copy')).toHaveAttribute(
    'title',
    /^npm run sysprose -- contracts \S+ --element VehicleModel::car$/,
  );

  // Nothing selected: the whole model, the terminal's own default, and the row says so.
  await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
  await expect(contracts.getByTestId('palette-check-copy')).toHaveAttribute('title', /^npm run sysprose -- contracts \S+$/);
  await contracts.getByTestId('palette-check-run').click();
  await expect(contracts).toContainText('— covers the whole model: nothing is selected');
  await expect(page.locator('[data-testid="checks-result"][data-check="contracts"]')).toContainText('checks/whole-model');
  // A check that needs an element says what the placeholder in its command is for.
  await expect(page.locator('[data-testid="palette-check"][data-check="where-used"]').getByTestId('palette-check-note')).toContainText(
    'nothing is selected',
  );

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/*
 * On open the app selects the model's first root, which nobody chose. The
 * shipped views-tour example starts with a header comment, so that root is the
 * comment: a Run scoped to it would report zero contracts for a model that has
 * some. It covers the whole model instead, and says why.
 */
test('a Run nobody narrowed covers the whole model when the root selected on open holds no contract', async ({ page }, testInfo) => {
  const errors = captureErrors(page);
  const tour = readFileSync(resolve(testInfo.project.testDir, '../../examples/views-tour.sysml'), 'utf8');
  await page.route('**/linked/views-tour.sysml', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: tour }));
  await page.goto('/?model=linked/views-tour.sysml', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('diagram-canvas')).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        ((window as unknown as { sysml?: { roots(): { declaredName?: string }[] } }).sysml?.roots() ?? []).map((r) => r.declaredName ?? ''),
      ),
    )
    .toContain('DroneDemo');
  await expect(page.getByTestId('breadcrumb')).toContainText('«TextualRepresentation»');

  await page.getByTestId('tb-view-contracts').click();
  const contracts = page.locator('[data-testid="palette-check"][data-check="contracts"]');
  const obligations = page.locator('[data-testid="palette-check"][data-check="obligations"]');
  await expect(contracts.getByTestId('palette-check-copy')).toHaveAttribute('title', /^npm run sysprose -- contracts \S+$/);
  await contracts.getByTestId('palette-check-run').click();
  await obligations.getByTestId('palette-check-run').click();
  const why = '— covers the whole model: «TextualRepresentation» contains no contract or obligation';
  await expect(contracts.locator('.palette-check-summary')).toHaveText(new RegExp(`^[1-9]\\d* contract\\(s\\) ${why}$`));
  await expect(obligations.locator('.palette-check-summary')).toHaveText(new RegExp(`^[1-9]\\d* obligation\\(s\\): .* ${why}$`));
  await expect(page.locator('[data-testid="checks-result"][data-check="contracts"]')).toContainText('checks/whole-model');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('every view has a palette; a table view has checks but nothing to draw', async ({ page }) => {
  await gotoApp(page);
  for (const view of ['general', 'state', 'allocation', 'contracts', 'analysis', 'grid']) {
    await page.getByTestId(`tb-view-${view}`).click();
    await expect(page.getByTestId('palette'), view).toBeVisible();
    await expect(page.getByTestId('palette-checks'), view).toBeVisible();
    await expect(page.getByTestId('palette-edit'), view).toBeVisible();
  }
  // A table draws nothing, so it offers no drawing tools.
  await expect(page.getByTestId('palette-tools')).toHaveCount(0);
  // Back on a diagram, the tools are there, with an explicit Select.
  await page.getByTestId('tb-view-general').click();
  await expect(page.getByTestId('palette-tools')).toBeVisible();
  await expect(page.getByTestId('palette-select')).toBeVisible();
});

test('the palette column can be put away and comes back', async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId('palette-collapse').click();
  await expect(page.getByTestId('palette')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('palette-checks')).toHaveCount(0);
  await page.getByTestId('palette-expand').click();
  await expect(page.getByTestId('palette')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('palette-checks')).toBeVisible();
});

test('Edit acts on the selection, and is disabled without one', async ({ page }) => {
  await gotoApp(page);
  // The app opens with the root selected, so the actions are live from the start.
  await expect(page.getByTestId('palette-duplicate')).toBeEnabled();
  await page.locator('.react-flow__node').first().click();
  await expect(page.getByTestId('palette-delete')).toBeEnabled();
  await expect(page.getByTestId('palette-rename')).toBeEnabled();
  // Clearing the selection on the empty canvas disables them again.
  await page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('palette-delete')).toBeDisabled();
  await expect(page.getByTestId('palette-duplicate')).toBeDisabled();
});

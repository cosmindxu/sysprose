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
import { test, expect, type Locator, type Page } from '@playwright/test';
import { captureErrors, diagramSettled, findElementId, gotoApp, openTab, selectElementById } from './fixtures';
import { modelSize } from './model-helpers';

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

test('a palette put away says what it hides, on screen and to a screen reader', async ({ page }) => {
  await gotoApp(page);
  // Open, the hide button has a name of its own (its glyph is not one).
  await expect(page.getByRole('button', { name: 'Hide the palette', exact: true })).toHaveAttribute(
    'data-testid',
    'palette-collapse',
  );
  const open = (await page.locator('.app-palette').boundingBox())!.width;
  await page.getByTestId('palette-collapse').click();

  // A visible label, not only a tooltip, names the sections the column holds.
  const label = page.getByTestId('palette-collapsed-label');
  await expect(label).toBeVisible();
  await expect(label).toHaveText(/^Palette:\s+Tools, Edit, Checks$/);
  // The strip's accessible name holds that label whole and says what a click does.
  const shown = ((await label.textContent()) ?? '').trim().replace(/\s+/g, ' ');
  const strip = page.getByRole('button', { name: 'Show Palette: Tools, Edit, Checks', exact: true });
  await expect(strip).toHaveAttribute('data-testid', 'palette-expand');
  await expect(strip).toHaveAttribute('aria-expanded', 'false');
  expect(await strip.getAttribute('aria-label')).toContain(shown);
  // Put away, the column is the strip: the canvas has the width back, not a blank column.
  const rail = (await page.locator('.app-palette').boundingBox())!.width;
  expect(rail, `rail ${rail}px, open ${open}px`).toBeLessThan(40);
  expect(open).toBeGreaterThan(150);

  // A table draws nothing, so it has no Tools to name.
  await page.getByTestId('tb-view-grid').click();
  await expect(label).toHaveText(/^Palette:\s+Edit, Checks$/);
  await expect(page.getByRole('button', { name: 'Show Palette: Edit, Checks', exact: true })).toBeVisible();

  // The strip brings the column back, and the label goes with it.
  await page.getByTestId('tb-view-general').click();
  await expect(label).toHaveText(/Tools, Edit, Checks/);
  await strip.click();
  await expect(label).toHaveCount(0);
  await expect(page.getByTestId('palette-checks')).toBeVisible();
  expect((await page.locator('.app-palette').boundingBox())!.width).toBe(open);

  // From the keyboard, each control hands the focus to the one that replaces it (a
  // focus left on <body> sends the next Tab back to the top of the page), and the
  // put-away strip shows a focus ring. The ring is drawn outside the strip's box and
  // the column clips to the strip, so a computed outline would read right while the
  // paint is cut away: compare what is painted, focused against not.
  await page.getByTestId('palette-collapse').focus();
  await page.keyboard.press('Enter');
  await expect(strip).toBeFocused();
  const box = (await page.locator('.app-palette').boundingBox())!;
  const clip = { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 240) };
  await page.mouse.move(box.x + 400, box.y + 300);
  const ringed = await page.screenshot({ clip });
  await page.keyboard.press('Tab');
  await expect(strip).not.toBeFocused();
  const plain = await page.screenshot({ clip });
  expect(ringed.equals(plain), 'the put-away strip paints a focus ring').toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expect(strip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette-collapse')).toBeFocused();

  // A window too short for the whole label cuts it inside the strip (an ellipsis), and
  // the accessible name stays whole.
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.getByTestId('palette-collapse').click();
  const railBox = (await strip.boundingBox())!;
  const labelBox = (await label.boundingBox())!;
  expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(railBox.y + railBox.height + 0.5);
  expect(await label.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(strip).toHaveAttribute('aria-label', 'Show Palette: Tools, Edit, Checks');
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

/*
 * The checks that walk a state machine run in a worker. A walk is bounded by
 * configurations, not by time: a machine of a few composite states, each with a
 * few substates, reaches the 10,000-configuration bound and holds a page for a
 * good part of a second if it runs there. These tests use such a machine and
 * check what a person is promised: the check says it is running, the page stays
 * usable, Cancel ends it, and an answer that arrives after the model changed is
 * not passed off as current.
 */

/**
 * `composites` composite states of `children` substates each, driven by events,
 * with every composite reachable from every other: the walk keeps where each
 * composite was left, so its configurations multiply until the bound.
 */
function heavyMachine(composites: number, children: number): string {
  const L = ['package Heavy {', '  item def Cmd { attribute id; }', '  part def Machine {', '    state def Modes {', '      initial start;', '      transition start -> Idle;', '      state Idle;'];
  for (let c = 0; c < composites; c++) {
    L.push(`      state C${c} {`, '        initial go;', `        transition go -> C${c}_0;`);
    for (let k = 0; k < children; k++) L.push(`        state C${c}_${k};`);
    for (let k = 0; k + 1 < children; k++) L.push(`        transition c${c}_${k} first C${c}_${k} accept step${c}_${k} : Cmd then C${c}_${k + 1};`);
    for (let k = 0; k < children; k++) L.push(`        transition lv${c}_${k} first C${c}_${k} accept back${c}_${k} : Cmd then Idle;`);
    L.push('      }');
  }
  for (let c = 0; c < composites; c++) {
    L.push(`      transition in${c} first Idle accept enter${c} : Cmd then C${c};`, `      transition out${c} first C${c} accept leave${c} : Cmd then Idle;`);
    for (let d = 0; d < composites; d++) if (c !== d) L.push(`      transition jump${c}_${d} first C${c} accept jump${c}_${d} : Cmd then C${d};`);
  }
  L.push('    }', '  }', '}');
  return `${L.join('\n')}\n`;
}

/** Open the app on `source` served as a linked model, on the state view. */
async function openMachine(page: Page, source: string): Promise<void> {
  await page.route('**/linked/Heavy.sysml', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: source }));
  await page.goto('/?model=linked/Heavy.sysml', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('diagram-canvas')).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => ((window as unknown as { sysml?: { roots(): { declaredName?: string }[] } }).sysml?.roots() ?? []).map((r) => r.declaredName)))
    .toContain('Heavy');
  await page.getByTestId('tb-view-state').click();
}

/** The longest gap between two animation frames from now on: how long the page was held at a stretch. */
async function watchFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __frameGap: number };
    w.__frameGap = 0;
    let last = performance.now();
    const tick = (): void => {
      const now = performance.now();
      w.__frameGap = Math.max(w.__frameGap, now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const longestFrameGap = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __frameGap: number }).__frameGap);

const checkRow = (page: Page, id: string): Locator => page.locator(`[data-testid="palette-check"][data-check="${id}"]`);

/**
 * Keep the worker's replies from the page until {@link releaseWorker}: the worker
 * still walks, the answer waits. A person's next move is made while a check runs;
 * a test cannot rely on a walk being slow enough to make it in time.
 */
async function holdWorkerReplies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { Worker: typeof Worker; __release?: () => void };
    const Real = w.Worker;
    const held: Array<() => void> = [];
    let open = false;
    w.__release = () => {
      open = true;
      for (const deliver of held.splice(0)) deliver();
    };
    w.Worker = class extends Real {
      set onmessage(handler: ((e: MessageEvent) => unknown) | null) {
        super.onmessage = handler === null ? null : (e: MessageEvent) => (open ? handler.call(this, e) : held.push(() => handler.call(this, e)));
      }
      get onmessage(): ((e: MessageEvent) => unknown) | null {
        return super.onmessage as ((e: MessageEvent) => unknown) | null;
      }
    };
  });
}
const releaseWorker = (page: Page): Promise<void> => page.evaluate(() => (window as unknown as { __release(): void }).__release());

/** The user's own roots in the model (the library's are not the person's). */
const userRoots = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (window as unknown as { sysml: { roots(): Array<{ declaredName?: string; attrs?: { isLibrary?: boolean } }> } }).sysml
      .roots()
      .filter((r) => r.attrs?.isLibrary !== true)
      .map((r) => r.declaredName ?? ''),
  );
const focusedTestId = (page: Page): Promise<string | null> =>
  page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.getAttribute('data-testid') ?? ''}`);

test('a state-machine check runs in a worker: it says so, the page stays usable, and the answer lands', async ({ page, browser }) => {
  const errors = captureErrors(page);
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  await openMachine(page, heavyMachine(6, 4));
  const reach = checkRow(page, 'reach');
  await watchFrames(page);

  await expect(page.locator('.bottom-tab.is-active')).not.toContainText('Checks');
  await reach.getByTestId('palette-check-run').click();
  // From the click the check is running, and the person can stop it.
  await expect(reach).toHaveAttribute('data-verdict', 'running');
  await expect(reach.getByTestId('palette-check-verdict')).toHaveText('running…');
  await expect(reach.getByTestId('palette-check-run')).toHaveAttribute('aria-disabled', 'true');
  await expect(reach.getByTestId('palette-check-cancel')).toBeVisible();
  // The Checks tab comes forward at the click, where the answer will be, and lists the check as running.
  await expect(page.locator('.bottom-tab.is-active')).toContainText('Checks');
  await expect(page.locator('[data-testid="checks-result"][data-check="reach"]')).toHaveAttribute('data-verdict', 'running');
  // Another check, started while it runs, is answered on the spot.
  await checkRow(page, 'stats').getByTestId('palette-check-run').click();
  await expect(checkRow(page, 'stats')).toHaveAttribute('data-verdict', 'holds');
  await expect(reach).toHaveAttribute('data-verdict', 'running');

  // A walk to the bound says nothing about the machine it did not finish, and says so.
  await expect(reach).toHaveAttribute('data-verdict', 'undecided', { timeout: 60_000 });
  await expect(reach.locator('.palette-check-summary')).toContainText('withheld');
  // The worker walked it: a worker that started and failed would have left the page to run it.
  await expect(reach).toHaveAttribute('data-ran-in', 'worker');
  await expect(reach.getByTestId('palette-check-cancel')).toHaveCount(0);
  await expect(reach.getByTestId('palette-check-run')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.bottom-tab.is-active')).toContainText('Checks');
  await expect(page.locator('[data-testid="checks-result"][data-check="reach"]')).toContainText('SUPPRESSED');
  await expect(page.locator('[data-testid="checks-result"][data-check="reach"]')).toHaveAttribute('data-verdict', 'undecided');

  expect(workers.some((u) => u.includes('checks-worker')), `the worker started: ${workers.join(', ')}`).toBe(true);
  const workerGap = await longestFrameGap(page);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);

  // The same walk on a page with no worker holds the page for a good part of a second; in the worker
  // no frame waited anything like as long. Compared with the page's own run, not a figure of ours: a
  // loaded machine slows both, and an absolute bound the page's run also meets proves nothing. A
  // context of its own: the app's service worker, installed by the first page, would answer the second
  // one's request for the model before the test's route could.
  const context = await browser.newContext();
  try {
    const plain = await context.newPage();
    await plain.addInitScript(() => {
      delete (window as unknown as { Worker?: unknown }).Worker;
    });
    await openMachine(plain, heavyMachine(6, 4));
    await watchFrames(plain);
    const pageReach = checkRow(plain, 'reach');
    await pageReach.getByTestId('palette-check-run').click();
    await expect(pageReach).toHaveAttribute('data-verdict', 'undecided', { timeout: 60_000 });
    await expect(pageReach).toHaveAttribute('data-ran-in', 'page');
    const pageGap = await longestFrameGap(plain);
    expect(workerGap, `the longest wait between two frames, in ms: worker ${workerGap.toFixed(0)}, page ${pageGap.toFixed(0)}`).toBeLessThan(pageGap / 2);
  } finally {
    await context.close();
  }
});

test('Cancel ends a running check, which keeps what it said before, and the next run starts again', async ({ page }) => {
  const errors = captureErrors(page);
  await holdWorkerReplies(page);
  await openMachine(page, heavyMachine(2, 3));
  const reach = checkRow(page, 'reach');
  expect(await userRoots(page)).toEqual(['Heavy']);

  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'running');
  await reach.getByTestId('palette-check-cancel').click();
  await expect(reach).toHaveAttribute('data-verdict', 'not-run');
  await expect(reach.getByTestId('palette-check-verdict')).toHaveText('not run');
  await expect(reach.getByTestId('palette-check-cancel')).toHaveCount(0);
  // A cancelled run decided nothing, and the Checks tab has nothing from it.
  await expect(page.locator('[data-testid="checks-result"][data-check="reach"]')).toHaveCount(0);
  // The button that had the focus is gone, and the focus went to the one that stays: a
  // button keeps a reflex Backspace or Delete from deleting the selected model.
  expect(await focusedTestId(page)).toBe('BUTTON:palette-check-run');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  expect(await userRoots(page)).toEqual(['Heavy']);

  await releaseWorker(page);
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'running');
  await expect(reach).toHaveAttribute('data-verdict', /holds|issues|undecided/, { timeout: 60_000 });
  await expect(reach).toHaveAttribute('data-ran-in', 'worker');
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a walk that finishes after the model was edited is shown stale, not current', async ({ page }) => {
  await holdWorkerReplies(page);
  await openMachine(page, heavyMachine(2, 3));
  const reach = checkRow(page, 'reach');
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'running');
  // An edit while the worker walks the model as it was.
  const machine = await findElementId(page, 'StateDefinition', 'Modes');
  await page.evaluate(
    (id) => (window as unknown as { sysml: { update(id: string, patch: { declaredName: string }): unknown } }).sysml.update(id, { declaredName: 'Modes2' }),
    machine,
  );
  await releaseWorker(page);
  await expect(reach).toHaveAttribute('data-verdict', 'stale', { timeout: 60_000 });
  await expect(page.locator('[data-testid="checks-result"][data-check="reach"]')).toHaveAttribute('data-verdict', 'stale');
});

test('on a page with no worker the check runs on the page, and answers the same', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Worker?: unknown }).Worker;
  });
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  await openMachine(page, heavyMachine(2, 3));
  const reach = checkRow(page, 'reach');
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', /holds|issues|undecided/);
  await expect(reach.locator('.palette-check-summary')).toContainText('machine(s)');
  await expect(reach).toHaveAttribute('data-ran-in', 'page');
  expect(workers.filter((u) => u.includes('checks-worker'))).toEqual([]);
});

test('a model with no state machine is told so at once, with no worker started', async ({ page }) => {
  const errors = captureErrors(page);
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  await gotoApp(page);
  await page.getByTestId('tb-view-state').click();
  const reach = checkRow(page, 'reach');
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'not-run');
  await expect(reach.locator('.palette-check-summary')).toHaveText('this file declares no element that owns a transition, so there is no configuration graph to walk');
  await expect(reach).toHaveAttribute('data-ran-in', 'page');
  await expect(reach.getByTestId('palette-check-cancel')).toHaveCount(0);
  expect(workers.filter((u) => u.includes('checks-worker')), 'nothing to walk, nothing to start a worker for').toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('an answer that lands while the person is typing in another tab leaves the tab and the cursor alone', async ({ page }) => {
  const errors = captureErrors(page);
  await holdWorkerReplies(page);
  await openMachine(page, heavyMachine(2, 3));
  const reach = checkRow(page, 'reach');

  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'running');
  // The person goes on working: to the Text tab, with the cursor in the text.
  await page.getByTestId('tab-text').click();
  const text = page.getByTestId('text-editor');
  await text.click();
  await expect(page.locator('.bottom-tab.is-active')).toContainText('Text');
  await expect(text).toBeFocused();
  await expect(reach).toHaveAttribute('data-verdict', 'running');

  await releaseWorker(page);
  await expect(reach).toHaveAttribute('data-verdict', /holds|issues|undecided/);
  await expect(reach).toHaveAttribute('data-ran-in', 'worker');
  // The answer is in the Checks tab for whenever they go there; they are still where they were.
  await expect(page.locator('.bottom-tab.is-active')).toContainText('Text');
  await expect(text).toBeFocused();
  // A key typed now goes into the text, and nothing of it reaches the model.
  await page.keyboard.type('a');
  expect(await userRoots(page)).toEqual(['Heavy']);
  await expect(text).toBeFocused();
  await page.getByTestId('tab-checks').click();
  await expect(page.locator('[data-testid="checks-result"][data-check="reach"]')).not.toHaveAttribute('data-verdict', 'running');
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('an answer that lands while Cancel has the keyboard focus moves it to Run, not to nowhere', async ({ page }) => {
  await holdWorkerReplies(page);
  await openMachine(page, heavyMachine(2, 3));
  const reach = checkRow(page, 'reach');

  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'running');
  await reach.getByTestId('palette-check-cancel').focus();
  expect(await focusedTestId(page)).toBe('BUTTON:palette-check-cancel');
  await releaseWorker(page);
  await expect(reach).toHaveAttribute('data-verdict', /holds|issues|undecided/);
  await expect(reach.getByTestId('palette-check-cancel')).toHaveCount(0);
  expect(await focusedTestId(page)).toBe('BUTTON:palette-check-run');
  await page.keyboard.press('Backspace');
  expect(await userRoots(page)).toEqual(['Heavy']);
});
/* ════════════ behaviour verification: the report under a result (E7) ══════ */

/** Load a model from text, and wait for the library merge (which bumps `rev`). */
async function loadText(page: Page, text: string): Promise<void> {
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await page.getByTestId('text-apply').click();
  await expect.poll(() => modelSize(page)).toBeGreaterThan(1000);
  await diagramSettled(page);
}

/** Select an element by qualified name, through the live SDK and the tree. */
async function selectByQualifiedName(page: Page, qn: string): Promise<void> {
  const id = await page.evaluate((q) => {
    const api = (window as unknown as { sysml: { byName: (q: string) => { id: string } | undefined } }).sysml;
    return api.byName(q)?.id ?? null;
  }, qn);
  if (!id) throw new Error(`no element named ${qn}`);
  await selectElementById(page, id);
}

const carrier = (pattern: string, p: string): string =>
  `@SysproseVerification::PropertyPattern { attribute pattern = "${pattern}"; attribute scope = "globally"; attribute p = "${p}"; }`;
const MISSION_FAIL = `package MissionDag { part def Mission { state def Modes { ${carrier('absence', 'state landed')} state takeoff; state cruise; state landed; transition takeoff then cruise; transition cruise then landed; } } }`;
const MISSION_RESP =
  'package MissionDag { part def Mission { state def Modes { @SysproseVerification::PropertyPattern { attribute pattern = "response"; attribute scope = "globally"; attribute p = "state takeoff"; attribute s = "state landed"; } state takeoff; state cruise; state landed; transition takeoff then cruise; transition cruise then landed; } } }';
const A15_COVER = `package P { state def M { ${carrier('cover', 'state c')} state a; state b; state c; transition a_b first a then b; transition a_c first a accept e then c; transition b_a first b accept back then a; } }`;

test('the reach report is the terminal lines, machine by machine (latch)', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadText(page, readFileSync('test/fixtures/verification/models/latch.sysml', 'utf8'));
  await page
    .locator('[data-testid="palette-check"][data-check="reach"]')
    .getByTestId('palette-check-run')
    .click();
  const report = page.locator('[data-testid="checks-report"]');
  await expect(report).toBeVisible();
  await expect(
    report.locator('.checks-report-line[data-kind="trap-refused"][data-withholds="true"]').first(),
  ).toContainText('inconclusive: this machine names triggers');
  await expect(report.locator('.checks-report-machine[data-status~="withheld"]')).toHaveCount(1);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('an inconclusive property shows its detail in the report (missionResp)', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadText(page, MISSION_RESP);
  await page.getByTestId('tb-view-state').click();
  await selectByQualifiedName(page, 'MissionDag::Mission::Modes');
  await page
    .locator('[data-testid="palette-check"][data-check="check-behaviour"]')
    .getByTestId('palette-check-run')
    .click();
  const block = page.locator('[data-testid="checks-report"] [data-claim="inconclusive"]');
  await expect(block).toBeVisible();
  await expect(block).toContainText('inconclusive: liveness not checked in-process');
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a fail property shows every run? and its three witness steps (missionFail)', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadText(page, MISSION_FAIL);
  await page.getByTestId('tb-view-state').click();
  await selectByQualifiedName(page, 'MissionDag::Mission::Modes');
  await page
    .locator('[data-testid="palette-check"][data-check="check-behaviour"]')
    .getByTestId('palette-check-run')
    .click();
  const block = page.locator('[data-testid="checks-report"] [data-claim="fail"]');
  await expect(block).toBeVisible();
  await expect(block).toContainText('every run?');
  await expect(block.locator('.checks-report-line[data-kind="witness-step"]')).toHaveCount(3);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a15 cover reads not-covered, with no witness and no walk-only note (a15)', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadText(page, A15_COVER);
  await page.getByTestId('tb-view-state').click();
  await selectByQualifiedName(page, 'P::M');
  await page
    .locator('[data-testid="palette-check"][data-check="check-behaviour"]')
    .getByTestId('palette-check-run')
    .click();
  const block = page.locator('[data-testid="checks-report"] [data-claim="not-covered"]');
  await expect(block).toBeVisible();
  await expect(block.locator('.checks-witness-step')).toHaveCount(0);
  await expect(block).not.toContainText('walk only');
  await expect(page.getByTestId('checks-report-note')).toHaveCount(0);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/* ════════════ behaviour verification: the state-view marks (E8, E9) ════════ */

const TERM = 'package Q { state def Term { state a; state b; state final; transition a then b; transition b then final; } }';
const SPURIOUS = 'package P { state def M { state a; state b; state c; state d; transition a_b first a then b; transition a_c first a accept e then c; transition a_d first a accept e then d; transition b_a first b accept e then a; } }';
const LONELY = 'package Q { state def Lonely { state a; state b; } state def M { state x; state y; transition first x then y; transition first y then x; } part def Drone { exhibit state modes : M; } }';

/** The node of an element, by qualified name, through the live SDK. */
async function nodeByQn(page: Page, qn: string) {
  const id = await page.evaluate((q) => {
    const api = (window as unknown as { sysml: { byName: (q: string) => { id: string } | undefined } }).sysml;
    return api.byName(q)?.id ?? null;
  }, qn);
  if (!id) throw new Error(`no element named ${qn}`);
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

/** Run Reachability from the state view's palette. */
async function runReach(page: Page): Promise<void> {
  await page.getByTestId('tb-view-state').click();
  await page
    .locator('[data-testid="palette-check"][data-check="reach"]')
    .getByTestId('palette-check-run')
    .click();
}

test('nothing is marked before Run (E8)', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await page.getByTestId('tb-view-state').click();
  await expect(page.locator('.react-flow__node[class*="rf-beh"]')).toHaveCount(0);
  await expect(page.getByTestId('behaviour-marks')).toHaveCount(0);
  // A non-behaviour check paints no marks either.
  const orphans = page.locator('[data-testid="palette-check"][data-check="orphans"]');
  await orphans.getByTestId('palette-check-run').click();
  await expect(page.locator('.react-flow__node[class*="rf-beh"]')).toHaveCount(0);
  await expect(page.getByTestId('behaviour-marks')).toHaveCount(0);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('marks show findings, withheld, not-decided and not-walked, beside the simulation glow (E9)', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const marksPanel = page.locator('.react-flow__panel.top.left [data-testid="behaviour-marks"]');

  // guard-undetermined: the five A.4 marks, by qualified name.
  await loadText(page, readFileSync('test/fixtures/verification/models/guard-undetermined.sysml', 'utf8'));
  await runReach(page);
  await expect(marksPanel).toBeVisible();
  await expect(marksPanel).toHaveAttribute('data-state', 'current');
  await expect(await nodeByQn(page, 'GuardProbe::Ctrl::Modes::idle')).toHaveAttribute('class', /rf-beh-withheld/);
  await expect(await nodeByQn(page, 'GuardProbe::Ctrl::Modes::hazard')).toHaveAttribute('class', /rf-beh-not-decided/);
  await expect(await nodeByQn(page, 'GuardProbe::Decided::Modes::hazard')).toHaveAttribute('class', /rf-beh-unreachable/);
  await expect(await nodeByQn(page, 'GuardProbe::Decided::Modes::idle')).toHaveAttribute('class', /rf-beh-no-way-out/);
  await expect(await nodeByQn(page, 'GuardProbe::Fires::Modes::hazard')).toHaveAttribute('class', /rf-beh-no-way-out/);

  // trap-probe: two traps and one choice, and the badge word in the ::after.
  await loadText(page, readFileSync('test/fixtures/verification/models/trap-probe.sysml', 'utf8'));
  await runReach(page);
  await expect(page.locator('.react-flow__node.rf-beh-trap')).toHaveCount(2);
  await expect(page.locator('.react-flow__node.rf-beh-choice')).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.querySelector('.react-flow__node.rf-beh-trap') as HTMLElement | null;
        return el ? getComputedStyle(el, '::after').content : null;
      }),
    )
    .toBe('"trap"');

  // latch: no marks, but the trap answer is withheld on 1 of 1.
  await loadText(page, readFileSync('test/fixtures/verification/models/latch.sysml', 'utf8'));
  await runReach(page);
  await expect(page.locator('.react-flow__node[class*="rf-beh"]')).toHaveCount(0);
  await expect(marksPanel).toContainText('trap answer withheld on 1 of 1');

  // term: no marks at all.
  await loadText(page, TERM);
  await runReach(page);
  await expect(marksPanel).toContainText('no state marked');

  // spurious: two unreachable marks (the walk is exact, so no walk-only mark).
  await loadText(page, SPURIOUS);
  await runReach(page);
  await expect(page.locator('.react-flow__node.rf-beh-unreachable')).toHaveCount(2);
  await expect(marksPanel).toContainText('2 unreachable');

  // lonely: three not-walked marks.
  await loadText(page, LONELY);
  await runReach(page);
  await expect(page.locator('.react-flow__node.rf-beh-not-walked')).toHaveCount(3);
  await expect(marksPanel).toContainText('3 not walked');

  // The details toggle names a row; Hide marks removes the marks and reads hidden.
  await loadText(page, readFileSync('test/fixtures/verification/models/trap-probe.sysml', 'utf8'));
  await runReach(page);
  await page.getByTestId('behaviour-marks-details').click();
  await expect(marksPanel).toContainText('names a row');
  await page.getByTestId('behaviour-marks-hide').click();
  await expect(marksPanel).toHaveAttribute('data-state', 'hidden');
  await expect(page.locator('.react-flow__node[class*="rf-beh"]')).toHaveCount(0);
  // The hide toggle is UI state that survives a reload: show the marks again
  // before the both-visible check, which needs them painted.
  await page.getByTestId('behaviour-marks-hide').click();
  await expect(marksPanel).toHaveAttribute('data-state', 'current');

  // Both visible: a simulation glow and a mark on one node, with no outline stolen.
  await loadText(page, readFileSync('test/fixtures/verification/models/trap-probe.sysml', 'utf8'));
  await runReach(page);
  await openTab(page, 'tab-simulation');
  await page.getByTestId('sim-start').click();
  const both = page.locator('.react-flow__node.rf-sim-active.rf-beh-choice, .react-flow__node.rf-sim-active.rf-beh-trap');
  await expect(both.first()).toBeVisible();
  await expect
    .poll(() => both.first().evaluate((n) => getComputedStyle(n).outlineStyle))
    .toBe('solid');
  await expect
    .poll(() => both.first().evaluate((n) => getComputedStyle(n, '::before').borderTopStyle))
    .toMatch(/dashed|dotted/);

  // Re-applying changed text moves rev under the stored trap-probe run: the
  // marks go stale without a new run, not current.
  await loadText(page, `${TERM}\npackage Extra;`);
  await page.getByTestId('tb-view-state').click();
  await expect(marksPanel).toHaveAttribute('data-state', 'stale');
  await expect(page.locator('.react-flow__node[class*="rf-beh"]')).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/* ════════════ behaviour verification: the witness stepper (E10) ════════ */

test('witness steps paint the state view and leave a live simulation and the selection alone (E10)', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  const selectedId = () =>
    page.evaluate(() => document.querySelector('.tree-node.is-selected')?.getAttribute('data-elementid') ?? null);

  // missionFail: a no-gap witness whose steps are buttons.
  await loadText(page, MISSION_FAIL);
  await page.getByTestId('tb-view-state').click();
  await selectByQualifiedName(page, 'MissionDag::Mission::Modes');
  await page
    .locator('[data-testid="palette-check"][data-check="check-behaviour"]')
    .getByTestId('palette-check-run')
    .click();
  const selectionBefore = await selectedId();
  expect(selectionBefore).not.toBeNull();

  // Start a live simulation and record its position and glow.
  await openTab(page, 'tab-simulation');
  await page.getByTestId('sim-start').click();
  await expect(page.locator('.react-flow__node.rf-sim-active').first()).toBeVisible();
  const simIndexBefore = await page.getByTestId('sim-index').textContent();
  const glowBefore = await page.locator('.react-flow__node.rf-sim-active').count();
  expect(glowBefore).toBeGreaterThan(0);

  // Step to the third witness step (landed) from the Checks tab.
  await openTab(page, 'tab-checks');
  await page.locator('.checks-witness-step[data-step="2"]').click();

  await expect(await nodeByQn(page, 'MissionDag::Mission::Modes::landed')).toHaveAttribute('class', /rf-beh-witness-at/);
  await expect(await nodeByQn(page, 'MissionDag::Mission::Modes::takeoff')).toHaveAttribute('class', /rf-beh-witness-seen/);
  await expect(await nodeByQn(page, 'MissionDag::Mission::Modes::cruise')).toHaveAttribute('class', /rf-beh-witness-seen/);
  await expect(page.locator('.react-flow__node.rf-sim-active')).toHaveCount(0);
  await expect(page.locator('.react-flow__panel.top.left [data-testid="behaviour-marks"]')).toHaveAttribute(
    'data-state',
    'witness',
  );
  expect(await selectedId()).toBe(selectionBefore);

  // Close: the simulation position, glow and selection are untouched.
  await page.locator('.checks-witness-close').click();
  await expect(page.locator('.react-flow__node.rf-sim-active')).toHaveCount(glowBefore);
  // The stepper lives on the Checks tab; the Simulation panel (and its index)
  // is only rendered on its own tab, so read it from there.
  await openTab(page, 'tab-simulation');
  expect(await page.getByTestId('sim-index').textContent()).toBe(simIndexBefore);
  expect(await selectedId()).toBe(selectionBefore);

  // a15: the walk is exact, so cover reads not-covered and there is no witness to step.
  await loadText(page, A15_COVER);
  await page.getByTestId('tb-view-state').click();
  await selectByQualifiedName(page, 'P::M');
  await page
    .locator('[data-testid="palette-check"][data-check="check-behaviour"]')
    .getByTestId('palette-check-run')
    .click();
  const a15Block = page.locator('[data-testid="checks-report"] [data-claim="not-covered"]');
  await expect(a15Block).toBeVisible();
  await expect(a15Block.locator('.checks-witness-step')).toHaveCount(0);
  await expect(a15Block).not.toContainText('walk only');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

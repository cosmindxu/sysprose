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

/*
 * The checks that walk a state machine run in a worker. A walk is bounded by
 * configurations, not by time: a machine of a few composite states, each with a
 * few substates, reaches the 10,000-configuration bound and holds a page for
 * seconds if it runs there. These tests use such a machine and check what a
 * person is promised: the check says it is running, the page stays usable, Cancel
 * ends it, and an answer that arrives after the model changed is not passed off
 * as current.
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

test('a state-machine check runs in a worker: it says so, the page stays usable, and the answer lands', async ({ page }) => {
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
  await expect(reach.locator('.palette-check-summary')).toContainText('hit a bound');
  // The worker walked it: a worker that started and failed would have left the page to run it.
  await expect(reach).toHaveAttribute('data-ran-in', 'worker');
  await expect(reach.getByTestId('palette-check-cancel')).toHaveCount(0);
  await expect(reach.getByTestId('palette-check-run')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.bottom-tab.is-active')).toContainText('Checks');
  await expect(page.locator('[data-testid="checks-result"][data-check="reach"]')).toContainText('verification/bound-hit');
  await expect(page.locator('[data-testid="checks-result"][data-check="reach"]')).toHaveAttribute('data-verdict', 'undecided');

  // Run on this page's thread, the walk holds it for seconds; in the worker no frame waited long for it.
  expect(workers.some((u) => u.includes('checks-worker')), `the worker started: ${workers.join(', ')}`).toBe(true);
  expect(await longestFrameGap(page), 'the longest wait between two frames, in ms').toBeLessThan(500);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
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
  await expect(reach.locator('.palette-check-summary')).toHaveText('No state machine in this model.');
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

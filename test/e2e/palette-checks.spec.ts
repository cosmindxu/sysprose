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
import { attrOf, modelSize } from './model-helpers';

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
  // From the click the check is under way, and the person can stop it: first the worker parses the
  // model's text the serializer wrote (a text no parse has measured), then it walks.
  await expect(reach).toHaveAttribute('data-verdict', /checking|running/);
  await expect(reach.getByTestId('palette-check-run')).toHaveAttribute('aria-disabled', 'true');
  await expect(reach.getByTestId('palette-check-cancel')).toBeVisible();
  // The Checks tab comes forward at the click, where the answer will be, and lists the check as under way.
  await expect(page.locator('.bottom-tab.is-active')).toContainText('Checks');
  await expect(page.locator('[data-testid="checks-result"][data-check="reach"]')).toHaveAttribute('data-verdict', /checking|running/);
  await expect(reach).toHaveAttribute('data-verdict', 'running', { timeout: 60_000 });
  await expect(reach.getByTestId('palette-check-verdict')).toHaveText('running…');
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

/**
 * The drone-swarm model of mbse-workflow, byte for byte
 * (`examples/drone-swarm-v9/SurveillanceDroneSwarm.sysml` at 9122db0, sha256 7f31cfe3…): the
 * reference model the app is measured on, 3,823 elements of the user's and 17 state machines.
 * A copy as of that commit: it does not follow later edits of the model, and is refreshed by
 * hand when they would change what the guard measures. Kept as `.txt` so the tree's walks over
 * `.sysml` files (the successor census in `U semantics.mc.successors`) do not count it among the
 * repository's models. Relative to the E2E test directory, so the guard reads it from whatever
 * directory Playwright was started in.
 */
const DRONE_SWARM = '../fixtures/drone-swarm-v9.sysml.txt';

/** What {@link watchPageThread} records, in the page's `performance.now()` milliseconds. */
interface PageThreadWatch {
  /** The page's long tasks (the browser reports those over 50 ms). */
  long: Array<{ start: number; duration: number }>;
  /** When each pointer press came. */
  clicks: number[];
  /** Each palette row's verdict as it changes. */
  verdicts: Array<{ check: string; verdict: string; at: number }>;
  /** When each frame began. */
  frames: number[];
}

/**
 * Record, in the page, how its thread is held from now on: the long tasks, each click, each
 * palette row's verdict as it changes, and the frames. Installed once; {@link pageThread} reads
 * it, and {@link clearPageThread} starts it afresh.
 */
async function watchPageThread(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __thread: PageThreadWatch };
    w.__thread = { long: [], clicks: [], verdicts: [], frames: [] };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__thread.long.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask' });
    document.addEventListener('pointerdown', () => w.__thread.clicks.push(performance.now()), true);
    new MutationObserver((records) => {
      const at = performance.now();
      for (const r of records) {
        const el = r.target as Element;
        if (el.getAttribute('data-testid') === 'palette-check') w.__thread.verdicts.push({ check: el.getAttribute('data-check') ?? '', verdict: el.getAttribute('data-verdict') ?? '', at });
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-verdict'] });
    const tick = (): void => {
      w.__thread.frames.push(performance.now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const clearPageThread = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const t = (window as unknown as { __thread: PageThreadWatch }).__thread;
    for (const list of [t.long, t.clicks, t.verdicts, t.frames]) list.length = 0;
  });
const pageThread = (page: Page): Promise<PageThreadWatch> => page.evaluate(() => (window as unknown as { __thread: PageThreadWatch }).__thread);

/** Rename the first part definition of the user's through the SDK: an edit, with a text no parse has measured. */
async function renameFirstPartDef(page: Page, name: string): Promise<void> {
  await page.evaluate((to) => {
    const api = (window as unknown as { sysml: { elementsOfType(t: string): Array<{ id: string; attrs?: { isLibrary?: boolean } }>; update(id: string, p: { declaredName: string }): unknown } }).sysml;
    const def = api.elementsOfType('PartDefinition').find((e) => e.attrs?.isLibrary !== true);
    if (def === undefined) throw new Error('no part definition of the user’s');
    api.update(def.id, { declaredName: to });
  }, name);
}

/**
 * Rename the first part definition of the user's, then press Run on the palette row `check` in
 * the next task: the edit's own rendering is done, and its recompute — a timer due no sooner than
 * 80 ms after it, which the next task's timer comes before — still waits, however fast or loaded
 * the machine. Returns whether that recompute was waiting at the click and still was after it (the
 * click left it for later), when the click came, and how long the click's handler held the page.
 */
function editThenRun(page: Page, check: string, name: string): Promise<{ waiting: boolean; stillWaiting: boolean; at: number; held: number }> {
  return page.evaluate(
    async ({ check, name }) => {
      const w = window as unknown as {
        sysml: { elementsOfType(t: string): Array<{ id: string; attrs?: { isLibrary?: boolean } }>; update(id: string, p: { declaredName: string }): unknown };
        sysprose: { diagram: { recomputePending(): boolean } };
      };
      const def = w.sysml.elementsOfType('PartDefinition').find((e) => e.attrs?.isLibrary !== true);
      if (def === undefined) throw new Error('no part definition of the user’s');
      w.sysml.update(def.id, { declaredName: name });
      await new Promise((next) => setTimeout(next, 0));
      const waiting = w.sysprose.diagram.recomputePending();
      const run = document.querySelector<HTMLButtonElement>(`[data-testid="palette-check"][data-check="${check}"] [data-testid="palette-check-run"]`);
      if (run === null) throw new Error(`no Run button on the ${check} row`);
      const at = performance.now();
      run.click();
      const held = performance.now() - at;
      return { waiting, stillWaiting: w.sysprose.diagram.recomputePending(), at, held };
    },
    { check, name },
  );
}

/** The long task the page was in at `at`, in ms; 0 when that task was under 50 ms, which the browser does not report. */
const taskAt = (watch: PageThreadWatch, at: number): number => watch.long.find((t) => t.start <= at && t.start + t.duration >= at)?.duration ?? 0;

test('on the drone-swarm model, a check clicked after an edit holds the page for no task over 200 ms of its own, and the edit’s own work waits for a frame (review 2026-10-14, D-3)', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const errors = captureErrors(page);
  const source = readFileSync(resolve(testInfo.project.testDir, DRONE_SWARM), 'utf8');
  await page.route('**/linked/SurveillanceDroneSwarm.sysml', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: source }));
  await page.goto('/?model=linked/SurveillanceDroneSwarm.sysml', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('diagram-canvas')).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => userRoots(page), { timeout: 120_000 }).toContain('SurveillanceDroneSwarm');
  await page.getByTestId('tb-view-state').click();
  await diagramSettled(page);
  const reach = checkRow(page, 'reach');
  const answered = /holds|issues|undecided/;
  // A first Run starts the worker, which loads the library and builds the text parser, then
  // parses the text Export ▾ SysML writes (not the file's own text, so no parse has measured it
  // although nothing was edited), and then walks.
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', answered, { timeout: 120_000 });
  await expect(reach).toHaveAttribute('data-ran-in', 'worker');
  await watchPageThread(page);
  const measured: string[] = [];

  // 1. An edit, its recompute run (the drawing settles), then Run. The edit's text is new, so
  // the click before S1 parsed and validated it on the page: 0.37 to 0.66 s here, in one task.
  // Now the worker does that, and nothing from the click to the answer holds the page 200 ms.
  await renameFirstPartDef(page, 'SwarmEditedOnce');
  await diagramSettled(page);
  await clearPageThread(page);
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', answered, { timeout: 120_000 });
  await expect(reach).toHaveAttribute('data-ran-in', 'worker');
  await page.waitForTimeout(1000); // the answer drawn, and anything it set off
  const settled = await pageThread(page);
  const settledClick = settled.clicks[0];
  const settledLong = settled.long.filter((t) => t.start + t.duration >= settledClick).map((t) => Math.round(t.duration));
  measured.push(`after the edit's recompute: long tasks from the click to the answer ${JSON.stringify(settledLong)} ms`);
  expect(Math.max(0, ...settledLong), `the longest task from the click to the answer, in ms (all: ${settledLong.join(', ')})`).toBeLessThan(200);
  // The load went to the worker: the row read `checking the load…` before `running…`.
  expect(settled.verdicts.filter((v) => v.check === 'reach').map((v) => v.verdict)).toContain('checking');

  // 2. An edit, then Run straight after it, while the edit's recompute still waits: that
  // recompute validates the model and writes its text, 0.14 to 0.63 s here as the machine is
  // loaded, and the load cannot be read before it. The run begins first: the click's handler
  // does nothing that grows with the model (it is no long task: under 50 ms), its task holds the
  // page under 200 ms, the row reads `checking the load…`, a frame is drawn, and only then does
  // the page do the edit's work — a task that is the edit's, run after every edit with or
  // without a click, and not the click's to bound (TODO.md has it).
  await clearPageThread(page);
  const click = await editThenRun(page, 'reach', 'SwarmEditedTwice');
  await expect(reach).toHaveAttribute('data-verdict', answered, { timeout: 120_000 });
  await expect(reach).toHaveAttribute('data-ran-in', 'worker');
  await page.waitForTimeout(1000);
  const pending = await pageThread(page);
  const after = pending.long.filter((t) => t.start > click.at);
  const heavy = after.find((t) => t.duration >= 200);
  measured.push(
    `with the edit's recompute waiting: the click's handler ${Math.round(click.held)} ms, its task ${Math.round(taskAt(pending, click.at))} ms (0: under 50); ` +
      `long tasks after it ${JSON.stringify(after.map((t) => Math.round(t.duration)))} ms`,
  );
  expect(click.waiting, 'the edit’s recompute was still waiting at the click').toBe(true);
  expect(click.stillWaiting, 'the click left the edit’s recompute for later').toBe(true);
  expect(click.held, 'how long the click’s handler held the page, in ms').toBeLessThan(50);
  expect(taskAt(pending, click.at), 'how long the click’s task held the page, in ms').toBeLessThan(200);
  expect(pending.verdicts.find((v) => v.check === 'reach' && v.at >= click.at)?.verdict, 'the row under way from the click').toBe('checking');
  if (heavy !== undefined) {
    expect(pending.frames.some((f) => f > click.at + click.held && f < heavy.start), 'a frame drawn between the click and the edit’s work').toBe(true);
  }

  // 3. A check not judged over the load (Statistics) reads the model alone, which the edit has
  // changed already: straight after an edit, its click does not run the edit's recompute either,
  // and its task holds the page under 200 ms. (Its handler runs the check itself, 10 to 50 ms on
  // this model, so it is not held to the 50 ms of Reachability's, which runs nothing.)
  await diagramSettled(page);
  await clearPageThread(page);
  const stats = checkRow(page, 'stats');
  const statsClick = await editThenRun(page, 'stats', 'SwarmEditedThrice');
  await expect(stats).toHaveAttribute('data-verdict', answered);
  await page.waitForTimeout(1000); // the browser reports a long task after it ends
  const third = await pageThread(page);
  measured.push(`Statistics straight after an edit: the click's handler ${Math.round(statsClick.held)} ms, its task ${Math.round(taskAt(third, statsClick.at))} ms`);
  expect(statsClick.waiting, 'the edit’s recompute was still waiting at the click').toBe(true);
  expect(statsClick.stillWaiting, 'the Statistics click left the edit’s recompute for later').toBe(true);
  expect(taskAt(third, statsClick.at), 'how long the Statistics click’s task held the page, in ms').toBeLessThan(200);
  testInfo.annotations.push({ type: 'page thread on the drone-swarm model', description: measured.join('; ') });
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('Cancel ends a running check, which keeps what it said before, and the next run starts again', async ({ page }) => {
  const errors = captureErrors(page);
  await holdWorkerReplies(page);
  await openMachine(page, heavyMachine(2, 3));
  const reach = checkRow(page, 'reach');
  expect(await userRoots(page)).toEqual(['Heavy']);

  await reach.getByTestId('palette-check-run').click();
  // The worker's replies are held: the run waits on the load it asked the worker to check.
  await expect(reach).toHaveAttribute('data-verdict', 'checking');
  await expect(reach.getByTestId('palette-check-verdict')).toHaveText('checking the load…');
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
  await expect(reach).toHaveAttribute('data-verdict', /checking|running/);
  await expect(reach).toHaveAttribute('data-verdict', /holds|issues|undecided/, { timeout: 60_000 });
  await expect(reach).toHaveAttribute('data-ran-in', 'worker');
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a walk that finishes after the model was edited is shown stale, not current', async ({ page }) => {
  await holdWorkerReplies(page);
  await openMachine(page, heavyMachine(2, 3));
  const reach = checkRow(page, 'reach');
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', /checking|running/);
  // An edit while the worker checks the load of, then walks, the model as it was.
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

/** Record, in the page, what the checks worker is asked: a load to check (`health`) or a check to run. */
async function recordWorkerRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { Worker: typeof Worker; __asked: string[] };
    w.__asked = [];
    const Real = w.Worker;
    w.Worker = class extends Real {
      private readonly checks: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        // The layout worker takes messages too; only the checks worker's are counted.
        this.checks = String(url).includes('checks-worker');
      }
      postMessage(message: unknown, ...rest: unknown[]): void {
        const m = message as { kind?: string; check?: string };
        if (this.checks) w.__asked.push(m.kind === 'health' ? 'health' : `check:${m.check}`);
        (super.postMessage as (...a: unknown[]) => void)(message, ...rest);
      }
    };
  });
}
const workerAsked = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __asked: string[] }).__asked);

test('a model with no state machine starts no walk: its load is checked once, then the row says there is nothing to walk', async ({ page }) => {
  const errors = captureErrors(page);
  await recordWorkerRequests(page);
  await gotoApp(page);
  await page.getByTestId('tb-view-state').click();
  const reach = checkRow(page, 'reach');
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'not-run', { timeout: 60_000 });
  await expect(reach.locator('.palette-check-summary')).toHaveText('this file declares no element that owns a transition, so there is no configuration graph to walk');
  await expect(reach).toHaveAttribute('data-ran-in', 'page');
  await expect(reach.getByTestId('palette-check-cancel')).toHaveCount(0);
  // The worker parsed the sample's text, which nothing had parsed, and was sent no walk.
  expect(await workerAsked(page), 'the load, and nothing to walk').toEqual(['health']);
  // Run again over the model unchanged: its load is known, and nothing goes to the worker.
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'not-run');
  expect(await workerAsked(page)).toEqual(['health']);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a guard, trigger or effect typed in Properties that the text cannot hold: Reachability is never `holds` over it (review 2026-10-14, LH-1)', async ({ page }) => {
  const errors = captureErrors(page);
  // A machine that ends: Reachability holds over it, until its text no longer loads.
  await openMachine(page, 'package Heavy {\n  state def M {\n    state a;\n    state b;\n    state final;\n    transition t1 first a then b;\n    transition t2 first b then final;\n  }\n}\n');
  const reach = checkRow(page, 'reach');
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'holds', { timeout: 60_000 });

  // An effect of `}`: the serializer writes it back as typed and sees nothing wrong in it; the
  // worker parses the text, as a terminal would, and finds it does not load.
  const t1 = await findElementId(page, 'TransitionUsage', 't1');
  await selectElementById(page, t1);
  await page.getByTestId('prop-effect').fill('}');
  await expect.poll(() => attrOf(page, t1, 'effect')).toBe('}');
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'undecided', { timeout: 60_000 });
  await expect(reach.locator('.palette-check-summary')).toContainText('did not load cleanly');
  await expect(reach).toHaveAttribute('data-ran-in', 'worker');
  const result = page.locator('[data-testid="checks-result"][data-check="reach"]');
  await expect(result.getByTestId('checks-row').first()).toContainText('syntax error');
  await expect(result.getByTestId('checks-row').first()).toContainText('exits 1');
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a value typed in Properties that closes its owner and adds a machine: the text loads, but as another model, and Reachability is not `holds` (review 2026-10-14)', async ({ page }) => {
  const errors = captureErrors(page);
  await openMachine(page, 'package Heavy {\n  state def M {\n    state a;\n    state b;\n    state final;\n    transition t1 first a then b;\n    transition t2 first b then final;\n  }\n  part def Pump { attribute rate = 2; }\n}\n');
  const reach = checkRow(page, 'reach');
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'holds', { timeout: 60_000 });

  // The value is written back as typed: the text parses cleanly, to a model with a second machine in it.
  const value = '2; } state def Z { state a; state b; state c; transition first a then b; } part def Q { attribute zz = 0';
  const rate = await findElementId(page, 'AttributeUsage', 'rate');
  await selectElementById(page, rate);
  await page.getByTestId('prop-value').fill(value);
  await expect.poll(() => attrOf(page, rate, 'value')).toBe(value);
  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', 'undecided', { timeout: 60_000 });
  await expect(reach).toHaveAttribute('data-ran-in', 'worker');
  const row = page.locator('[data-testid="checks-result"][data-check="reach"]').getByTestId('checks-row').first();
  await expect(row).toContainText('parses cleanly, but to a model other than the one on screen');
  // A terminal loads that file, so no exit code is claimed for it.
  await expect(row).not.toContainText('exits 1');
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('an answer that lands while the person is typing in another tab leaves the tab and the cursor alone', async ({ page }) => {
  const errors = captureErrors(page);
  await holdWorkerReplies(page);
  await openMachine(page, heavyMachine(2, 3));
  const reach = checkRow(page, 'reach');

  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', /checking|running/);
  // The person goes on working: to the Text tab, with the cursor in the text.
  await page.getByTestId('tab-text').click();
  const text = page.getByTestId('text-editor');
  await text.click();
  await expect(page.locator('.bottom-tab.is-active')).toContainText('Text');
  await expect(text).toBeFocused();
  await expect(reach).toHaveAttribute('data-verdict', /checking|running/);

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
  await expect(page.locator('[data-testid="checks-result"][data-check="reach"]')).not.toHaveAttribute('data-verdict', /checking|running/);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('an answer that lands while Cancel has the keyboard focus moves it to Run, not to nowhere', async ({ page }) => {
  await holdWorkerReplies(page);
  await openMachine(page, heavyMachine(2, 3));
  const reach = checkRow(page, 'reach');

  await reach.getByTestId('palette-check-run').click();
  await expect(reach).toHaveAttribute('data-verdict', /checking|running/);
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
/** Review B's `nest6-prop`: a `state def` written inside the machine that carries the property. */
const NEST6 = `package Nest6 { state def Outer { ${carrier('absence', 'state b')} state a; state b; transition ab first a accept e then b; state def Inner { state x; state y; transition xy first x accept go then y; } } }`;

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

test('a pick row for a machine that holds a nested state def selects it, and the next Run checks it (nest6)', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadText(page, NEST6);
  await page.getByTestId('tb-view-state').click();
  await selectByQualifiedName(page, 'Nest6');
  const run = page
    .locator('[data-testid="palette-check"][data-check="check-behaviour"]')
    .getByTestId('palette-check-run');
  await run.click();
  // The package holds two machines — `Outer` and the `state def` written in
  // it — so the run is refused with a pick row for each.
  const result = page.locator('[data-testid="checks-result"][data-check="check-behaviour"]');
  await expect(result).toHaveAttribute('data-verdict', 'not-run');
  const picks = result.locator('[data-testid="checks-row"][data-code="checks/pick-machine"]');
  await expect(picks).toHaveCount(2);
  await expect(picks.first()).toContainText('Nest6::Outer —');
  // Following `Outer`'s row and running again checks `Outer`. It used to be
  // refused as holding two machines, with `Outer`'s row offered again.
  await picks.first().getByTestId('checks-row-select').click();
  await run.click();
  await expect(result).toHaveAttribute('data-verdict', 'issues', { timeout: 60_000 });
  await expect(result.locator('[data-testid="checks-report"] [data-claim="fail"]')).toContainText(
    '`state b` never holds',
  );
  await expect(result.locator('[data-testid="checks-row"][data-code="checks/pick-machine"]')).toHaveCount(0);
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

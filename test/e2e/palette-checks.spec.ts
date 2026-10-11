/**
 * The palette's Checks section, in the browser.
 *
 * What a person can do from a diagram: run the check that fits the view, read
 * the verdict where they clicked, see the findings in the Checks tab, click a
 * finding to select the element — and, for a check this page cannot run, get
 * the command instead of a verdict nobody earned.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { captureErrors, diagramSettled, gotoApp, openTab, selectElementById } from './fixtures';
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

test('a walk-only covered property shows NOT COUNTED and its note (a15)', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadText(page, A15_COVER);
  await page.getByTestId('tb-view-state').click();
  await selectByQualifiedName(page, 'P::M');
  await page
    .locator('[data-testid="palette-check"][data-check="check-behaviour"]')
    .getByTestId('palette-check-run')
    .click();
  const block = page.locator('[data-testid="checks-report"] [data-claim="covered"][data-walk-only="true"]');
  await expect(block).toBeVisible();
  await expect(block).toContainText('NOT COUNTED');
  await expect(block.getByTestId('checks-report-note')).toBeVisible();
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

test('marks show findings, withheld, not-decided, not-walked and walk-only, beside the simulation glow (E9)', async ({ page }) => {
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

  // spurious: three walk-only marks.
  await loadText(page, SPURIOUS);
  await runReach(page);
  await expect(page.locator('.react-flow__node.rf-beh-walk-only')).toHaveCount(3);
  await expect(marksPanel).toContainText('3 walk only');

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

  // Re-applying changed text makes the marks stale, not current.
  await loadText(page, `${TERM}\npackage Extra;`);
  await runReach(page);
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
  expect(await page.getByTestId('sim-index').textContent()).toBe(simIndexBefore);
  expect(await selectedId()).toBe(selectionBefore);

  // a15: a walk-only witness is never stepped — no button, and the caveat text.
  await loadText(page, A15_COVER);
  await page.getByTestId('tb-view-state').click();
  await selectByQualifiedName(page, 'P::M');
  await page
    .locator('[data-testid="palette-check"][data-check="check-behaviour"]')
    .getByTestId('palette-check-run')
    .click();
  const a15Block = page.locator('[data-testid="checks-report"] [data-claim="covered"][data-walk-only="true"]');
  await expect(a15Block.locator('.checks-witness-step')).toHaveCount(0);
  await expect(a15Block).toContainText('(walk only: not drawn on the diagram)');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

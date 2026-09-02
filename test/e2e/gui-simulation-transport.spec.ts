/**
 * The simulation TRANSPORT — the half of the Simulation tab `gui-simulation`
 * never touches.
 *
 * That suite drives the event-driven path (Start / Inject / scrub / Reset) on a
 * machine with no timed transition, so Play is asserted only in its *disabled*
 * state and Step, Stop, the clock readout, the trace list and the plot's x-axis
 * toggle are never exercised at all.
 *
 * Here the user turns an event transition into a TIMED one (`after(2)`) through
 * the Properties form, which is what enables the whole clock-driven path, and
 * then drives it: Step advances the clock, the timed transition fires on its own
 * once the dwell is met, the trace list scrubs, the plot switches its x-axis
 * from sample index to simulation clock, and Stop tears the session down.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  captureErrors,
  findElementId,
  gotoApp,
  openTab,
  selectElementById,
  shot,
} from './fixtures';

/** A machine whose red→green transition we retarget as timed. */
const MACHINE = `package Demo {
  state def Traffic {
    attribute count = 0;
    state red;
    state green;
    transition red accept go -> green;
  }
}
`;

async function loadMachine(page: Page): Promise<void> {
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await editor.fill(MACHINE);
  await page.getByTestId('text-apply').click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { sysml: { elementsOfType: (t: string) => unknown[] } }).sysml
            .elementsOfType('StateDefinition').length,
      ),
    )
    .toBeGreaterThan(0);
}

/** Read the simulation clock shown next to the cursor. */
async function clock(page: Page): Promise<number> {
  return Number((await page.getByTestId('sim-clock').textContent())?.trim());
}

test('a transition made timed in Properties unlocks Play, and Step drives the clock', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadMachine(page);

  // ── Before: purely event-driven, so Play has nothing to advance ──
  await openTab(page, 'tab-simulation');
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-active')).toContainText('red');
  await expect(page.getByTestId('sim-play')).toBeDisabled();

  // ── The user makes it timed: trigger `go` → `after(2)` in Properties ──
  const transitionId = await findElementId(page, 'TransitionUsage');
  await selectElementById(page, transitionId);
  const trigger = page.getByTestId('prop-trigger');
  await expect(trigger).toBeVisible();
  await trigger.fill('after(2)');

  await openTab(page, 'tab-simulation');
  // Play is live now — the machine has something the clock can fire.
  await expect(page.getByTestId('sim-play')).toBeEnabled();
  await shot(page, 'sim-transport-a-timed');

  // ── Restart on the edited machine and drive the clock by hand ──
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-active')).toContainText('red');
  expect(await clock(page)).toBe(0);

  // One tick: the clock moves but the dwell (2) is not met, so red still holds.
  await page.getByTestId('sim-step').click();
  await expect.poll(() => clock(page)).toBe(1);
  await expect(page.getByTestId('sim-active')).toContainText('red');

  // Second tick: dwell met → the timed transition fires with no event injected.
  await page.getByTestId('sim-step').click();
  await expect.poll(() => clock(page)).toBe(2);
  await expect(page.getByTestId('sim-active')).toContainText('green');
  await shot(page, 'sim-transport-b-fired');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('the trace list scrubs, the plot x-axis toggles, and Stop tears the session down', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadMachine(page);

  await openTab(page, 'tab-simulation');
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-active')).toContainText('red');

  // Build a trace worth scrubbing.
  await page.getByTestId('sim-event').selectOption('go');
  await page.getByTestId('sim-inject').click();
  await expect(page.getByTestId('sim-active')).toContainText('green');

  const rows = page.getByTestId('sim-trace-row');
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('sim-trace')).toBeVisible();

  // Regression guard: `.sim-tab` is a column flex box, and the trace list used to
  // default to flex-shrink:1 and collapse to a ZERO-height content box as soon as
  // the plot block appeared — rows rendered, `toBeVisible()` passed, and every row
  // was clipped out of reach. Assert the list actually has room for its rows.
  const listHeight = await page
    .getByTestId('sim-trace')
    .evaluate((el) => (el as HTMLElement).clientHeight);
  expect(listHeight, 'the trace list must not collapse to nothing').toBeGreaterThanOrEqual(20);

  // ── Clicking a trace row scrubs the readout back to that sample ──
  // The bottom panel is a fixed 220px, so the trace sits below the Simulation
  // tab's fold and the user scrolls to it — as this does.
  await expect(page.getByTestId('sim-index')).not.toHaveText('0');
  await rows.first().scrollIntoViewIfNeeded();
  await rows.first().click();
  await expect(page.getByTestId('sim-index')).toHaveText('0');
  await expect(page.getByTestId('sim-active')).toContainText('red');
  await expect(rows.first()).toHaveClass(/is-current/);
  await shot(page, 'sim-transport-c-scrubbed');

  // ── The plot's x-axis flips between sample index and simulation clock ──
  const xBy = page.getByTestId('sim-xby');
  await expect(xBy).toHaveText('x: index');
  await xBy.click();
  await expect(xBy).toHaveText('x: clock');
  await expect(page.getByTestId('sim-plot')).toBeVisible();
  await xBy.click();
  await expect(xBy).toHaveText('x: index');

  // ── Stop ends the session: the transport goes away, Start comes back ──
  await page.getByTestId('sim-stop').click();
  await expect(page.getByTestId('sim-transport')).toHaveCount(0);
  await expect(page.getByTestId('sim-trace')).toHaveCount(0);
  await expect(page.getByTestId('sim-stop')).toHaveCount(0);
  await expect(page.getByTestId('sim-start')).toBeVisible();
  await shot(page, 'sim-transport-d-stopped');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

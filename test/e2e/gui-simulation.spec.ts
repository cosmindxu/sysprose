/**
 * Interactive simulation (Phase 2): the Simulation bottom-panel tab drives the
 * time-stepped SimulationSession — Start, Inject events, scrub, Reset — and the
 * active state(s) glow on the state view (rf-sim-active), with a value plot.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, openTab } from './fixtures';

const MACHINE = `package Demo {
  state def Traffic {
    attribute count = 0;
    state red;
    state green;
    state yellow;
    transition red accept go -> green;
    transition green accept caution -> yellow;
    transition yellow accept stop -> red;
  }
}
`;

async function loadMachine(page: import('@playwright/test').Page): Promise<void> {
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await editor.fill(MACHINE);
  await page.getByTestId('text-apply').click();
  // Wait for the state machine to appear in the model.
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

test('simulation tab: start, inject, animate active state, scrub, reset', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadMachine(page);

  await openTab(page, 'tab-simulation');
  const tab = page.getByTestId('sim-tab');
  await expect(tab).toBeVisible();
  await expect(page.getByTestId('sim-target')).toContainText('Traffic');

  // Start → initial state 'red' is active, and the value plot renders (count=0).
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-active')).toContainText('red');
  await expect(page.getByTestId('sim-plot')).toBeVisible();
  // Traffic is purely event-driven (no after(n) transition) → Play is disabled.
  await expect(page.getByTestId('sim-play')).toBeDisabled();

  // The parametric-solve toggle wires through (restarts the session cleanly).
  await page.getByTestId('sim-solve').check();
  await expect(page.getByTestId('sim-solve')).toBeChecked();
  await expect(page.getByTestId('sim-active')).toContainText('red');
  await page.getByTestId('sim-solve').uncheck();

  // Inject 'go' → transitions to 'green'; the trace grows and clock/fired update.
  await page.getByTestId('sim-event').selectOption('go');
  await page.getByTestId('sim-inject').click();
  await expect(page.getByTestId('sim-active')).toContainText('green');
  await expect(page.getByTestId('sim-active')).not.toContainText('red');
  await expect(page.getByTestId('sim-fired')).toContainText('go');
  const rows = page.getByTestId('sim-trace-row');
  await expect.poll(async () => rows.count()).toBeGreaterThanOrEqual(2);

  // The active state glows on the state view: click the active chip (reveals the
  // state view + selects), then assert a node carries the rf-sim-active class.
  await page.getByTestId('sim-active-chip').first().click();
  await expect(page.locator('.react-flow__node.rf-sim-active').first()).toBeVisible();

  // Inject 'caution' → 'yellow'.
  await page.getByTestId('sim-event').selectOption('caution');
  await page.getByTestId('sim-inject').click();
  await expect(page.getByTestId('sim-active')).toContainText('yellow');

  // Scrub the cursor back to sample 0 → active state returns to 'red' (view only).
  await page.getByTestId('sim-cursor').fill('0');
  await expect(page.getByTestId('sim-active')).toContainText('red');

  // Reset → back to the initial state; the trace truly collapses to one sample
  // (not just a cursor move — a seek-to-0 would leave the earlier rows behind).
  await page.getByTestId('sim-reset').click();
  await expect(page.getByTestId('sim-active')).toContainText('red');
  await expect(page.getByTestId('sim-index')).toHaveText('0');
  await expect(page.getByTestId('sim-trace-row')).toHaveCount(1);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

const PARAMETRIC = `package Demo {
  part def Rig {
    attribute throttle = 3;
    attribute power;
    constraint law { power == throttle * 10 }
    state def Ctl {
      state a;
      state b;
      transition a accept go -> b;
    }
  }
}
`;

test('simulation tab: Solve parametrics surfaces a derived value series', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await openTab(page, 'tab-text');
  await page.getByTestId('text-editor').fill(PARAMETRIC);
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

  await openTab(page, 'tab-simulation');
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-tab')).toBeVisible();

  // With Solve parametrics ON, the DERIVED `power` (= throttle*10) appears as a
  // plottable series — it only exists in the solved network, not the raw values.
  await page.getByTestId('sim-solve').check();
  await expect(page.getByTestId('sim-plot')).toBeVisible();
  await expect(page.locator('.sim-series-toggle').filter({ hasText: 'power' })).toBeVisible();

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

const ROOTED = `package Demo {
  state def Loop {
    state idle;
    state busy;
    transition start first idle accept go then busy;
    transition again first busy accept back then Loop;
    transition rest first busy accept done then idle;
  }
}
`;

test('simulation tab: a step into the machine itself is not taken, and the tab says why', async ({ page }) => {
  // docs/06 §8.12: `again` targets the machine's own root, which sits in no
  // chain of its states, so no reading of the step is defined. The run stops
  // at `busy` without taking it, takes nothing after it, and says which step.
  const errors = captureErrors(page);
  await gotoApp(page);
  await openTab(page, 'tab-text');
  await page.getByTestId('text-editor').fill(ROOTED);
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

  await openTab(page, 'tab-simulation');
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-active')).toContainText('idle');
  await expect(page.getByTestId('sim-refused')).toHaveCount(0);
  await page.getByTestId('sim-event').selectOption('go');
  await page.getByTestId('sim-inject').click();
  await expect(page.getByTestId('sim-active')).toContainText('busy');
  await expect(page.getByTestId('sim-refused')).toHaveCount(0);

  await page.getByTestId('sim-event').selectOption('back');
  await page.getByTestId('sim-inject').click();
  await expect(page.getByTestId('sim-refused')).toContainText('`Demo::Loop::again` leads from `Demo::Loop::busy` into `Demo::Loop`, the machine itself');
  await expect(page.getByTestId('sim-active')).toContainText('busy');
  await expect(page.getByTestId('sim-fired')).toHaveCount(0);

  // `done` would take the run back to `idle`; a stopped run takes nothing.
  await page.getByTestId('sim-event').selectOption('done');
  await page.getByTestId('sim-inject').click();
  await expect(page.getByTestId('sim-index')).toHaveText('3');
  await expect(page.getByTestId('sim-active')).toContainText('busy');
  await expect(page.getByTestId('sim-refused')).toBeVisible();

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('simulation tab: empty state when the model has no state machine', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page); // the sample model has parts/requirements but no state machine
  await openTab(page, 'tab-simulation');
  await expect(page.getByTestId('sim-empty')).toBeVisible();
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

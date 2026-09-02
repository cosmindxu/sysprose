/**
 * Simulation OUTCOME readouts — completion and constraint status.
 *
 * `gui-simulation` drives a machine that never terminates and carries no
 * constraints, so two of the sample readout's three lines have never rendered in
 * a test: the "complete" badge that tells a modeller the run reached a final
 * state, and the constraint chips that say whether the model's constraints held
 * at that instant. Both are the *conclusions* a simulation exists to produce.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, gotoApp, openTab, shot } from './fixtures';

async function loadText(page: Page, text: string): Promise<void> {
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await editor.fill(text);
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

/* `isFinalState` treats a state named `final` as terminal. */
const TERMINATING = `package Demo {
  state def Run {
    state working;
    state final;
    transition working accept stop -> final;
  }
}
`;

test('reaching a final state flags the sample complete', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadText(page, TERMINATING);

  await openTab(page, 'tab-simulation');
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-active')).toContainText('working');

  // Mid-run: not complete — the badge must not be a permanent fixture.
  await expect(page.getByTestId('sim-complete')).toHaveCount(0);
  await shot(page, 'sim-outcome-a-running');

  // ── Drive it into the final state ──
  await page.getByTestId('sim-event').selectOption('stop');
  await page.getByTestId('sim-inject').click();
  await expect(page.getByTestId('sim-active')).toContainText('final');
  await expect(page.getByTestId('sim-complete')).toBeVisible();
  await expect(page.getByTestId('sim-complete')).toHaveText('complete');
  await shot(page, 'sim-outcome-b-complete');

  // ── Scrubbing back to an earlier sample un-flags it: the badge belongs to the
  //    SAMPLE under the cursor, not to the session ──
  await page.getByTestId('sim-cursor').fill('0');
  await expect(page.getByTestId('sim-active')).toContainText('working');
  await expect(page.getByTestId('sim-complete')).toHaveCount(0);
  await shot(page, 'sim-outcome-c-scrubbed-back');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/**
 * `checkConstraintsWithStore` evaluates ONLY constraints inside the simulated
 * behaviour's own subtree — a constraint elsewhere in the model must never be
 * shadowed by this machine's bare-name value store. `inMachine` is in scope;
 * `outsideMachine` deliberately is not, and the test asserts both directions.
 */
const CONSTRAINED = `package Demo {
  part def Rig {
    attribute rigPower = 999;
    constraint outsideMachine { rigPower == 1 }
    state def Ctl {
      attribute throttle = 3;
      attribute power = 30;
      constraint inMachine { power == throttle * 10 }
      state idle;
      state busy;
      transition idle accept go -> busy;
    }
  }
}
`;

test('constraint chips report live status, scoped to the simulated machine', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadText(page, CONSTRAINED);

  await openTab(page, 'tab-simulation');
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-active')).toContainText('idle');

  // ── The machine's own constraint is evaluated against this sample's values ──
  const chips = page.getByTestId('sim-constraint');
  await expect(chips).toHaveCount(1);
  // power (30) == throttle (3) * 10 holds against the live store.
  await expect(chips.first()).toHaveText('inMachine: satisfied');
  const cls = (await chips.first().getAttribute('class')) ?? '';
  expect(cls, 'the chip must carry its status as a style hook').toContain('sim-c-satisfied');

  // ── The constraint OUTSIDE the machine is not evaluated here — evaluating it
  //    against this machine's bare-name store is exactly the shadowing bug the
  //    scoping rule exists to prevent (it would read as violated) ──
  await expect(page.getByTestId('sim-constraint').filter({ hasText: 'outsideMachine' })).toHaveCount(
    0,
  );
  await shot(page, 'sim-outcome-d-constraint');

  // ── Clicking a chip selects the constraint element itself ──
  await chips.first().click();
  await expect(page.getByTestId('prop-name')).toHaveValue('inMachine');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

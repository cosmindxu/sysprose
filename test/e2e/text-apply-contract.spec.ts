/**
 * What "Apply" in the Text tab promises when the notation is WRONG.
 *
 * `text-sync` and `panels-problems-text` only ever apply valid notation. But
 * Apply is the single most destructive control in the app: `store.applyText`
 * reparses the buffer and `model.reset()`s the live model wholesale. Whatever
 * comes out of a failed parse therefore *becomes* the user's model, and the only
 * thing standing between a typo and a lost afternoon is (a) the parse errors
 * being surfaced and (b) the `pushUndo()` taken before the reset.
 *
 * These tests pin exactly that contract, and found the first half of it broken:
 * Problems stayed EMPTY for every malformed input. The cause was not the parser
 * (it reports fine) but `refreshAfterLibraryLoad` erasing the parse diagnostics
 * a few hundred ms later, when the asynchronous standard-library merge settled.
 * Fixed in `src/ui/store.ts`; both halves are asserted below.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, gotoApp, openTab, shot } from './fixtures';
import { hasNamed, modelSize } from './model-helpers';

async function applyText(page: Page, text: string): Promise<void> {
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await page.getByTestId('text-apply').click();
}

test('applying unparseable text cannot cost the user their model', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Baseline: the sample model.
  expect(await hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(true);
  const sizeBefore = await modelSize(page);

  // ── Apply text that is not SysML ──
  await applyText(page, '!!! this is not sysml at all !!!\n');

  // Apply really did replace the model — this is not a no-op that the test could
  // pass through inattention.
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(false);
  await shot(page, 'text-contract-a-replaced');

  // ── The guarantee that holds: ONE undo restores the model exactly ──
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(true);
  await expect.poll(() => modelSize(page)).toBe(sizeBefore);
  await shot(page, 'text-contract-b-undone');

  // The restored model is coherent: the Text tab re-serializes it…
  await openTab(page, 'tab-text');
  await expect.poll(() => page.getByTestId('text-editor').inputValue()).toContain(
    'part def Vehicle',
  );

  // …and a subsequent VALID apply still works — the failure left no sticky state.
  await applyText(page, 'package Fixed {\n  part def Gearbox;\n}\n');
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Gearbox')).toBe(true);

  // Whatever the parser makes of junk, it must not throw at the console.
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/**
 * The other half of the contract: the user must be TOLD.
 *
 * This was a real defect when the suite first reached it — Problems stayed empty
 * for every malformed input, so applying a typo replaced the model and said
 * nothing. The parser was never at fault: it reported 6 diagnostics for the
 * input below. `applyText` published them and then started the asynchronous
 * standard-library merge, whose `refreshAfterLibraryLoad` landed a few hundred
 * ms later with a validation-only diagnostics list and erased them. Fixed by
 * carrying `ruleId === 'parse'` findings across that refresh.
 *
 * The wait matters: an assertion that ran before the library merge would have
 * passed against the broken build too, so this polls the row THROUGH the merge.
 */
test('unparseable text reports parse errors, and they survive the library merge', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await applyText(page, '!!! this is not sysml at all !!!\n');
  await openTab(page, 'tab-problems');

  const parseRows = page.getByTestId('problem-row').filter({ hasText: /line \d+:\d+/ });
  await expect(parseRows.first()).toBeVisible();
  // Wait for the standard-library merge to actually land — `applyText` drops the
  // library with `model.reset`, so the model growing back past the user's handful
  // of elements IS the signal that `refreshAfterLibraryLoad` has run. The rows
  // must still be there afterwards; that refresh is what used to erase them.
  await expect.poll(() => modelSize(page), { timeout: 30_000 }).toBeGreaterThan(1000);
  await expect.poll(() => parseRows.count(), { timeout: 10_000 }).toBeGreaterThan(0);
  await shot(page, 'text-contract-e-parse-errors');

  // A well-formed apply leaves no parse rows behind.
  await applyText(page, 'package Fine {\n  part def Ok;\n}\n');
  await openTab(page, 'tab-problems');
  await expect.poll(() => modelSize(page), { timeout: 30_000 }).toBeGreaterThan(1000);
  await expect.poll(() => parseRows.count(), { timeout: 10_000 }).toBe(0);
  await shot(page, 'text-contract-f-parse-cleared');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

const MACHINE = `package Demo {
  state def Traffic {
    state red;
    state green;
    transition red accept go -> green;
  }
}
`;

test('applying text stops a running simulation instead of orphaning it', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await applyText(page, MACHINE);

  // Start a session against the machine that is about to be replaced.
  await openTab(page, 'tab-simulation');
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-active')).toContainText('red');
  await expect(page.getByTestId('sim-transport')).toBeVisible();
  await shot(page, 'text-contract-c-simulating');

  // ── Replace the model out from under the session ──
  await applyText(page, 'package Other {\n  part def Nothing;\n}\n');

  // The session is torn down, not left pointing at a deleted state machine.
  await openTab(page, 'tab-simulation');
  await expect(page.getByTestId('sim-transport')).toHaveCount(0);
  // No machine in the new model at all → the tab falls back to its empty state.
  await expect(page.getByTestId('sim-empty')).toBeVisible();
  await shot(page, 'text-contract-d-sim-stopped');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

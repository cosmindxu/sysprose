import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Regroup Workbench. Phase 1: switches to the view, seeds the bundles from
 * Louvain clusters over the part graph, and asserts the config strip / bins /
 * boundary panel render — while verifying the PREVIEW never mutates the model.
 * Phase 2: clicks Apply — the composites/ports/bindings land as ONE undoable
 * mutation — then Undo restores the exact pre-apply element count. Zero
 * console/page errors throughout.
 */
test('regroup workbench: preview is pure; Apply mutates once and Undo restores', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Element count BEFORE — the preview must never touch the model.
  const modelSize = () =>
    page.evaluate(
      () =>
        (window as unknown as { sysml: { model: { all(): unknown[] } } }).sysml.model.all().length,
    );
  const countBefore = await modelSize();

  await page.getByTestId('tb-view-regroup').click();
  await expect(page.getByTestId('regroup-view')).toBeVisible();
  // The React Flow canvas is gone; the workbench renders instead.
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  await expect(page.getByTestId('regroup-summary')).toBeVisible();
  await expect(page.getByTestId('regroup-bins')).toBeVisible();

  // Seed bundles from clusters over the part connectivity graph.
  await page.getByTestId('regroup-seed').click();
  await expect(page.getByTestId('regroup-bin').first()).toBeVisible();
  const binsAfterSeed = await page.getByTestId('regroup-bin').count();
  expect(binsAfterSeed).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('regroup-summary')).toBeVisible();

  // Adding an empty proposed bundle grows the bin row (config-only state).
  await page.getByTestId('regroup-add-bundle').click();
  await expect(page.getByTestId('regroup-bin')).toHaveCount(binsAfterSeed + 1);

  // Boundary panel: concrete crossing rows, or the explicit empty note.
  await expect(page.getByTestId('regroup-boundary')).toBeVisible();
  const rows = await page.getByTestId('regroup-boundary-row').count();
  if (rows === 0) {
    await expect(page.getByTestId('regroup-boundary')).toContainText(
      'No external interfaces yet',
    );
  }

  // Drag a chip out of its seeded bundle into the new empty one (HTML5 DnD —
  // dispatched as real DragEvents with a DataTransfer, since Playwright's
  // mouse-level dragTo does not synthesize the HTML5 dataTransfer protocol).
  // In the sample model `engine` is a CHILD part of `vehicle`, joined by the
  // fuelLine connection. Splitting them puts the child's composite INSIDE the
  // parent's (nested bundles), so the fuelLine is internal to the outer bundle
  // and crosses only the INNER one → exactly ONE boundary row + one port (the
  // hierarchical classifier does not synthesize a spurious outer port).
  await page.evaluate(() => {
    const chip = document.querySelector('[data-testid="regroup-part"]') as HTMLElement;
    const bins = document.querySelectorAll('[data-testid="regroup-bin"]');
    const bin = bins[bins.length - 1] as HTMLElement;
    const dataTransfer = new DataTransfer();
    const opts = { bubbles: true, cancelable: true, dataTransfer };
    chip.dispatchEvent(new DragEvent('dragstart', opts));
    bin.dispatchEvent(new DragEvent('dragover', opts));
    bin.dispatchEvent(new DragEvent('drop', opts));
  });
  const emptyBin = page.getByTestId('regroup-bin').last();
  await expect(emptyBin.getByTestId('regroup-part')).toHaveCount(1); // membership moved
  await expect(page.getByTestId('regroup-boundary-row')).toHaveCount(1);
  await expect(page.getByTestId('regroup-boundary')).toContainText('+ port');

  await shot(page, '60-regroup');

  // Preview-only guarantee: everything so far left the model untouched.
  expect(await modelSize()).toBe(countBefore);

  // ── Phase 2: APPLY ─────────────────────────────────────────────────────────
  // The note now advertises the concrete plan and the Apply button is armed.
  await expect(page.getByTestId('regroup-note')).toContainText('as one undoable step');
  await expect(page.getByTestId('regroup-apply')).toBeEnabled();
  await page.getByTestId('regroup-apply').click();

  // The mutation landed: 2 composites (Bundle 1 + Bundle 2), plus ONE delegation
  // port and ONE binding for the fuelLine crossing the inner bundle → +4.
  await expect(page.getByTestId('regroup-boundary')).toContainText('No external interfaces yet');
  expect(await modelSize()).toBe(countBefore + 4);
  const hasComposite = await page.evaluate(() => {
    const sysml = (window as unknown as {
      sysml: { elementsOfType(k: string): { declaredName?: string }[] };
    }).sysml;
    const names = sysml.elementsOfType('PartUsage').map((e) => e.declaredName);
    return names.includes('Bundle 1') && names.includes('Bundle 2');
  });
  expect(hasComposite).toBe(true);
  // The composite under the root package shows up in the Explorer tree.
  await expect(
    page.getByTestId('tree-node').filter({ hasText: 'Bundle 2' }).first(),
  ).toBeVisible();
  // The config was consumed: fresh preview, nothing left to apply.
  await expect(page.getByTestId('regroup-apply')).toBeDisabled();
  await expect(page.getByTestId('regroup-bin')).toHaveCount(1); // Unassigned only

  await shot(page, '61-regroup-applied');

  // ── Undo: the ONE step restores the exact pre-apply model ────────────────
  await page.getByTestId('tb-undo').click();
  await expect
    .poll(() => modelSize(), { message: 'undo should restore the element count' })
    .toBe(countBefore);
  const stillThere = await page.evaluate(() => {
    const sysml = (window as unknown as {
      sysml: { elementsOfType(k: string): { declaredName?: string }[] };
    }).sysml;
    return sysml.elementsOfType('PartUsage').some((e) => e.declaredName === 'Bundle 1');
  });
  expect(stillThere).toBe(false);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

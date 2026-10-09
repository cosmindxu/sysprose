/**
 * Systematic toolbar / project-lifecycle coverage.
 *
 * Exercises every File/Model toolbar command as a user would, asserting the
 * effect on the live model (via the `window.sysml` SDK) and the UI, with zero
 * uncaught console/page errors throughout:
 *
 *  1. lifecycle   — New (reset) → create content → Save → New → Open (restore).
 *  2. validate/check — Validate populates the Problems tab; Check surfaces
 *     constraint-check rows in the Problems tab.
 *  3. layout/io   — Auto-layout re-lays the diagram; Export .sysml / JSON /
 *     API-JSON all download recognizable, non-empty content; Import round-trips
 *     a native model-JSON snapshot back into the project.
 *  4. unsaved work — New, Open and Import ask first when the model has work no
 *     save holds (an edit, an import, typed text), and never otherwise (the
 *     untouched sample, a saved project, a New one); Keep editing, Discard and
 *     continue, and Save and continue (the save in this browser) answer.
 *  5. typed text — Save and Ctrl+S apply text typed in the Text view first,
 *     keep back a text with a syntax error and say so in the strip; an edit
 *     made through `window.sysml` reaches the Text view and reads unsaved.
 *
 * These focus on the toolbar surface itself; problem-row navigation is covered
 * by validation.spec and the .sysml import path by import-export.spec, so this
 * suite deliberately does not re-test those.
 */

import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { captureErrors, gotoApp, openTab, shot, treeName } from './fixtures';
import { addChild, renameInTree } from './model-helpers';

/** Count model elements of a metaclass via the live SDK. */
function countOfType(page: Page, eClass: string): Promise<number> {
  return page.evaluate(
    (e) =>
      (window as unknown as { sysml: { elementsOfType: (t: string) => unknown[] } }).sysml
        .elementsOfType(e).length,
    eClass,
  );
}

/** True when a named element of the given metaclass exists in the model. */
function hasNamed(page: Page, eClass: string, name: string): Promise<boolean> {
  return page.evaluate(
    ({ e, n }) =>
      (window as unknown as {
        sysml: { elementsOfType: (t: string) => { declaredName?: string }[] };
      }).sysml
        .elementsOfType(e)
        .some((el) => el.declaredName === n),
    { e: eClass, n: name },
  );
}

test('New resets the model, Save persists it, and Open restores the saved project', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // The sample model owns `part def Vehicle`.
  expect(await hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(true);

  // ── New: the sample is discarded for an empty "NewModel" package ──
  await page.getByTestId('tb-new').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(false);
  const newRoot = page.locator('[data-elementid]').filter({ hasText: 'NewModel' }).first();
  await expect(newRoot).toBeVisible();

  // ── Create content: a uniquely-named PartDefinition under the root ──
  await newRoot.click();
  await newRoot.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('PartDefinition');
  const markerId = await page.evaluate(() => {
    const parts = (window as unknown as {
      sysml: { elementsOfType: (t: string) => { id: string; declaredName?: string }[] };
    }).sysml.elementsOfType('PartDefinition');
    return (parts.find((p) => !p.declaredName) ?? parts[parts.length - 1]).id;
  });
  const markerRow = page.locator(`[data-elementid="${markerId}"]`).first();
  await treeName(markerRow).dblclick();
  const rename = page.getByTestId('tree-rename');
  await rename.fill('RoundTripMarker');
  await rename.press('Enter');
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'RoundTripMarker')).toBe(true);
  await shot(page, 'lifecycle-a-created');

  // ── Save: persists under the current project name ("NewModel") ──
  await page.getByTestId('tb-save').click();

  // ── New again: the marker is gone ──
  await page.getByTestId('tb-new').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'RoundTripMarker')).toBe(false);

  // ── Open: the project picker lists the saved project; pick it to restore ──
  await page.getByTestId('tb-open').click();
  await expect(page.getByTestId('project-picker')).toBeVisible();
  const pick = page.getByTestId('project-pick').filter({ hasText: 'NewModel' }).first();
  await expect(pick).toBeVisible();
  await pick.click();

  await expect.poll(() => hasNamed(page, 'PartDefinition', 'RoundTripMarker')).toBe(true);
  await expect(
    page.getByTestId('explorer').getByText('RoundTripMarker'),
  ).toBeVisible();
  await shot(page, 'lifecycle-b-restored');

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('Validate populates Problems and Check surfaces constraint-check results', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Seed a checkable ConstraintUsage under `vehicle` (whose `mass` = 1500) so
  // Check has a real constraint to report, plus a duplicate name so Validate
  // has a structural problem to surface.
  await page.evaluate(() => {
    const api = (window as unknown as {
      sysml: {
        elementsOfType: (t: string) => { id: string; declaredName?: string }[];
        create: (e: string, opts: Record<string, unknown>) => { id: string };
      };
    }).sysml;
    const vehicle = api.elementsOfType('PartUsage').find((p) => p.declaredName === 'vehicle');
    api.create('ConstraintUsage', {
      ownerId: vehicle!.id,
      declaredName: 'massWithinLimit',
      attrs: { expression: 'mass < 2000' },
    });
  });

  // Add a duplicate `Vehicle` PartDefinition sibling to trip the validator.
  const rootRow = page.locator('[data-elementid]').filter({ hasText: 'VehicleModel' }).first();
  await treeName(rootRow).click();
  await rootRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('PartDefinition');
  const dupId = await page.evaluate(() => {
    const parts = (window as unknown as {
      sysml: { elementsOfType: (t: string) => { id: string; declaredName?: string }[] };
    }).sysml.elementsOfType('PartDefinition');
    return (parts.find((p) => !p.declaredName) ?? parts[parts.length - 1]).id;
  });
  const dupRow = page.locator(`[data-elementid="${dupId}"]`).first();
  await treeName(dupRow).dblclick();
  await page.getByTestId('tree-rename').fill('Vehicle');
  await page.getByTestId('tree-rename').press('Enter');

  // ── Validate → the Problems tab lists the structural finding ──
  await page.getByTestId('tb-validate').click();
  await openTab(page, 'tab-problems');
  await expect(page.getByTestId('problem-row').first()).toBeVisible();
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'Duplicate name' }).first(),
  ).toBeVisible();
  await shot(page, 'lifecycle-c-validate');

  // ── Check → the Problems tab lists the constraint-check row(s) ──
  await page.getByTestId('tb-check').click();
  await expect(
    page.getByTestId('problem-row').filter({ hasText: 'constraint-check' }).first(),
  ).toBeVisible();
  await shot(page, 'lifecycle-d-check');

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('Auto-layout re-lays the diagram; all three exports download; import round-trips', async ({
  page,
}) => {
  // Force the <input type=file> fallback so the import file-chooser is used.
  await page.addInitScript(() => {
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
  const errors = captureErrors(page);
  await gotoApp(page);

  // ── Auto-layout: the diagram is rebuilt and still renders nodes ──
  await page.getByTestId('tb-layout').click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await shot(page, 'lifecycle-e-layout');

  // ── Export .sysml (via the Export ▾ menu) ──
  const dlSysml = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-sysml').click();
  const sysmlText = readFileSync((await (await dlSysml).path())!, 'utf8');
  expect(sysmlText).toContain('package VehicleModel');

  // ── Export native model JSON ──
  const dlJson = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-json').click();
  const jsonText = readFileSync((await (await dlJson).path())!, 'utf8');
  const parsed = JSON.parse(jsonText) as { elements?: unknown[]; rootIds?: unknown[] };
  expect(Array.isArray(parsed.elements)).toBe(true);
  expect((parsed.elements ?? []).length).toBeGreaterThan(0);
  expect(Array.isArray(parsed.rootIds)).toBe(true);

  // ── Export OMG API element-graph JSON ──
  const dlApi = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-api-json').click();
  const apiText = readFileSync((await (await dlApi).path())!, 'utf8');
  const apiParsed = JSON.parse(apiText) as unknown;
  // The API graph is a recognizable, non-empty JSON payload.
  const apiSize = Array.isArray(apiParsed)
    ? apiParsed.length
    : Object.keys(apiParsed as object).length;
  expect(apiSize).toBeGreaterThan(0);
  expect(apiText).toMatch(/@type|rootElement|Vehicle/);
  await shot(page, 'lifecycle-f-exported');

  // ── Import round-trip: re-import the native JSON snapshot we just exported ──
  mkdirSync('test-results', { recursive: true });
  const importPath = 'test-results/roundtrip.model.json';
  writeFileSync(importPath, jsonText, 'utf8');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('tb-import').click();
  (await chooserPromise).setFiles(importPath);

  // The model reloads intact — the sample's `Vehicle` part def survives.
  await expect.poll(() => countOfType(page, 'PartDefinition')).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as {
          sysml: { elementsOfType: (t: string) => { declaredName?: string }[] };
        }).sysml
          .elementsOfType('PartDefinition')
          .some((e) => e.declaredName === 'Vehicle'),
      ),
    )
    .toBe(true);
  await shot(page, 'lifecycle-g-imported');

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('New, Open and Import ask before they replace work no save holds — and only then', async ({ page }) => {
  // Force the <input type=file> fallback so the import file-chooser is used.
  await page.addInitScript(() => {
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
  const errors = captureErrors(page);
  await gotoApp(page);
  // The question is a row of the strip under the toolbar, on a deployment
  // without Google Drive too (this one has none).
  const strip = page.getByTestId('drive-strip');

  // ── The sample as the session started: New asks nothing ──
  await page.getByTestId('tb-new').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(false);
  await expect(strip).toHaveCount(0);
  const rootId = (await page
    .locator('[data-elementid]')
    .filter({ hasText: 'NewModel' })
    .first()
    .getAttribute('data-elementid'))!;

  // ── Saved, then New, then Open: nothing to ask either ──
  await renameInTree(page, await addChild(page, rootId, 'PartDefinition'), 'GuardSaved');
  await page.getByTestId('tb-save').click();
  await page.getByTestId('tb-new').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'GuardSaved')).toBe(false);
  await expect(strip).toHaveCount(0);
  await page.getByTestId('tb-open').click();
  await page.getByTestId('project-pick').filter({ hasText: 'NewModel' }).first().click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'GuardSaved')).toBe(true);
  await expect(strip).toHaveCount(0);

  // ── An edit no save holds: New asks; Keep editing keeps it ──
  const openedRoot = (await page
    .locator('[data-elementid]')
    .filter({ hasText: 'NewModel' })
    .first()
    .getAttribute('data-elementid'))!;
  await renameInTree(page, await addChild(page, openedRoot, 'PartDefinition'), 'GuardUnsaved');
  await page.getByTestId('tb-new').click();
  await expect(strip).toHaveAttribute('data-status', 'guard');
  await expect(strip).toHaveAttribute('role', 'alert');
  await expect(strip).toContainText('NewModel has unsaved changes.');
  await expect(page.getByTestId('guard-save')).toHaveText('Save and continue');
  await shot(page, 'lifecycle-h-guard');
  await page.getByTestId('guard-keep').click();
  await expect(strip).toHaveCount(0);
  expect(await hasNamed(page, 'PartDefinition', 'GuardUnsaved')).toBe(true);

  // ── Import asks once the file is chosen; Discard and continue imports it ──
  mkdirSync('test-results', { recursive: true });
  const importPath = 'test-results/guarded-import.sysml';
  writeFileSync(importPath, 'package GuardImported {\n    part def Widget;\n}\n', 'utf8');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('tb-import').click();
  await (await chooser).setFiles(importPath);
  await expect(strip).toHaveAttribute('data-status', 'guard');
  expect(await hasNamed(page, 'PartDefinition', 'Widget')).toBe(false);
  await page.getByTestId('guard-discard').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Widget')).toBe(true);
  await expect(strip).toHaveCount(0);

  // ── An import is no save: Open asks; Save and continue keeps it in this
  //    browser, then opens the project picked ──
  await page.getByTestId('tb-open').click();
  await page.getByTestId('project-pick').filter({ hasText: 'NewModel' }).first().click();
  await expect(strip).toHaveAttribute('data-status', 'guard');
  await expect(strip).toContainText('GuardImported has unsaved changes.');
  await page.getByTestId('guard-save').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'GuardSaved')).toBe(true);
  expect(await hasNamed(page, 'PartDefinition', 'GuardUnsaved')).toBe(false);
  await expect(strip).toHaveCount(0);
  await page.getByTestId('tb-open').click();
  await expect(page.locator('[data-testid="project-pick"][data-name="GuardImported"]')).toHaveCount(1);
  await page.getByTestId('tb-open').click();

  // ── A project just opened: nothing to ask. Text typed in the Text view
  //    and not applied is work no save holds ──
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await editor.fill((await editor.inputValue()).replace('GuardSaved', 'GuardTyped'));
  await page.getByTestId('tb-new').click();
  await expect(strip).toHaveAttribute('data-status', 'guard');
  await page.getByTestId('guard-keep').click();
  await expect(editor).toHaveValue(/GuardTyped/);
  await page.getByTestId('text-apply').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'GuardTyped')).toBe(true);
  await page.getByTestId('tb-new').click();
  await expect(strip).toHaveAttribute('data-status', 'guard');
  await page.getByTestId('guard-discard').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'GuardTyped')).toBe(false);
  await expect(strip).toHaveCount(0);

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('Save holds the text typed in the Text view, keeps back a text with a syntax error and says so; an SDK edit reaches the Text view', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  const strip = page.getByTestId('drive-strip');
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  const status = page.locator('.text-editor-status');

  // ── An edit through the SDK on window.sysml: the Text view shows it, and
  //    it is work no save holds — New asks ──
  await page.evaluate(() => {
    const api = (window as unknown as {
      sysml: {
        elementsOfType: (t: string) => { id: string; declaredName?: string }[];
        update: (id: string, patch: { declaredName: string }) => unknown;
      };
    }).sysml;
    const def = api.elementsOfType('PartDefinition').find((p) => p.declaredName === 'Vehicle')!;
    api.update(def.id, { declaredName: 'ScriptedCar' });
  });
  await expect(editor).toHaveValue(/part def ScriptedCar\b/);
  await expect(status).not.toHaveClass(/is-dirty/);
  await page.getByTestId('tb-new').click();
  await expect(strip).toHaveAttribute('data-status', 'guard');
  await page.getByTestId('guard-keep').click();
  await expect(strip).toHaveCount(0);

  // ── Text typed and not applied: the toolbar's Save applies it first ──
  await editor.fill((await editor.inputValue()).replaceAll('ScriptedCar', 'TypedCar'));
  await expect(status).toHaveClass(/is-dirty/);
  await page.getByTestId('tb-save').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'TypedCar')).toBe(true);
  await expect(status).not.toHaveClass(/is-dirty/);
  await expect(strip).toHaveCount(0);

  // ── A syntax error: Ctrl+S, with the focus on the diagram, keeps the model
  //    as it stands, and the strip says so ──
  const refs = await countOfType(page, 'ReferenceUsage');
  await editor.fill((await editor.inputValue()).replace('part def TypedCar', 'blok bad;\n    part def TypedCar'));
  await page.locator('.react-flow__node').first().focus();
  await page.keyboard.press('Control+S');
  await expect(strip).toHaveAttribute('data-status', 'info');
  await expect(strip).toHaveAttribute('role', 'status');
  await expect(strip).toContainText(
    /^Saved in this browser without the text typed in the Text view: it has a syntax error at line \d+\. Fix it, then save again\./,
  );
  await expect(editor).toHaveValue(/blok bad;/);
  await expect(status).toHaveClass(/is-dirty/);
  expect(await hasNamed(page, 'PartDefinition', 'TypedCar'), 'the model as it stands').toBe(true);
  expect(await countOfType(page, 'ReferenceUsage'), 'no recovery of `blok bad;`').toBe(refs);
  await shot(page, 'lifecycle-i-kept-back');
  await page.getByTestId('drive-strip-dismiss').click();
  await expect(strip).toHaveCount(0);

  // ── What the browser holds is the text as applied, without the broken line ──
  await page.getByTestId('tb-new').click();
  await expect(strip).toHaveAttribute('data-status', 'guard');
  await page.getByTestId('guard-discard').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'TypedCar')).toBe(false);
  await page.getByTestId('tb-open').click();
  await page.locator('[data-testid="project-pick"][data-name="VehicleModel"]').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'TypedCar')).toBe(true);
  await expect(editor).not.toHaveValue(/blok/);

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

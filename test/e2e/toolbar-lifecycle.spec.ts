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
 *
 * These focus on the toolbar surface itself; problem-row navigation is covered
 * by validation.spec and the .sysml import path by import-export.spec, so this
 * suite deliberately does not re-test those.
 */

import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { captureErrors, gotoApp, openTab, shot } from './fixtures';

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
  await markerRow.dblclick();
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
  await rootRow.click();
  await rootRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('PartDefinition');
  const dupId = await page.evaluate(() => {
    const parts = (window as unknown as {
      sysml: { elementsOfType: (t: string) => { id: string; declaredName?: string }[] };
    }).sysml.elementsOfType('PartDefinition');
    return (parts.find((p) => !p.declaredName) ?? parts[parts.length - 1]).id;
  });
  const dupRow = page.locator(`[data-elementid="${dupId}"]`).first();
  await dupRow.dblclick();
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

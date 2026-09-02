/**
 * Scenario 7 — import / export round-trip:
 *  - Export .sysml  → intercept the download, assert it is non-empty SysML.
 *  - Export JSON    → intercept the download, assert it parses to a model with
 *                     a non-empty `elements` array.
 *  - Import         → drive the hidden <input type=file> fallback (the File
 *                     System Access picker is removed so the input path is used)
 *                     and confirm the imported model replaces the project.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gotoApp, shot } from './fixtures';

test('export .sysml and JSON download non-empty content; import replaces the model', async ({
  page,
}) => {
  // Force the <input type=file> fallback by removing the FS Access picker.
  await page.addInitScript(() => {
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
  await gotoApp(page);

  // ── Export .sysml (the export commands live in the Export ▾ menu) ──
  const sysmlDownload = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-sysml').click();
  const dl1 = await sysmlDownload;
  const sysmlPath = await dl1.path();
  expect(sysmlPath).toBeTruthy();
  const sysmlText = readFileSync(sysmlPath!, 'utf8');
  expect(sysmlText.length).toBeGreaterThan(0);
  expect(sysmlText).toContain('package VehicleModel');

  // ── Export JSON ──
  const jsonDownload = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-json').click();
  const dl2 = await jsonDownload;
  const jsonPath = await dl2.path();
  const jsonText = readFileSync(jsonPath!, 'utf8');
  const parsed = JSON.parse(jsonText) as { elements?: unknown[]; rootIds?: unknown[] };
  expect(Array.isArray(parsed.elements)).toBe(true);
  expect((parsed.elements ?? []).length).toBeGreaterThan(0);
  await shot(page, '07a-exported');

  // ── Import a fresh model via the file-input fallback ──
  mkdirSync('test-results', { recursive: true });
  const importPath = 'test-results/imported.sysml';
  writeFileSync(importPath, 'package ImportedModel {\n    part def Widget;\n}\n', 'utf8');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('tb-import').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(importPath);

  // The imported model becomes the live project.
  await expect(page.getByTestId('explorer').getByText('ImportedModel')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as {
            sysml: { elementsOfType: (t: string) => { declaredName?: string }[] };
          }).sysml
            .elementsOfType('PartDefinition')
            .some((e) => e.declaredName === 'Widget'),
      ),
    )
    .toBe(true);
  await shot(page, '07b-imported');
});

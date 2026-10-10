/**
 * Scenario 7 — import / export round-trip:
 *  - Export .sysml  → intercept the download, assert it is non-empty SysML.
 *  - Export JSON    → intercept the download, assert it parses to a model with
 *                     a non-empty `elements` array.
 *  - Import         → drive the hidden <input type=file> fallback (the File
 *                     System Access picker is removed so the input path is used)
 *                     and confirm the imported model replaces the project.
 *  - Round trip     → the exported .sysml is the Text view's text, without the
 *                     merged standard library, and imports back to the same
 *                     user model beside one library.
 *  - Typed text     → Export ▾ → SysML applies text typed in the Text view
 *                     first, as Save does (one Undo step); a text with a
 *                     syntax error is kept back, and the strip says so.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { captureErrors, gotoApp, openTab, shot } from './fixtures';

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

/**
 * Export ▾ → SysML once wrote the merged standard library after the user's
 * packages (~1.28 MB). Imported back, every library root became the user's,
 * with hundreds of parse errors, and the library was merged again beside it.
 */
test('Export ▾ → SysML writes the Text view’s text, and that file imports back to the same model', async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
  await gotoApp(page);

  /** The user's model as the SDK sees it, and how much library sits beside it. */
  const snapshot = () =>
    page.evaluate(() => {
      const api = (window as unknown as {
        sysml: {
          roots: () => { declaredName?: string }[];
          toModelJSON: () => { '@type': string; declaredName?: string }[];
          libraryElementCount: () => number;
        };
      }).sysml;
      return {
        roots: api.roots().map((r) => r.declaredName),
        elements: api
          .toModelJSON()
          .map((e) => `${e['@type']} ${e.declaredName ?? ''}`)
          .sort(),
        library: api.libraryElementCount(),
      };
    });
  const before = await snapshot();
  expect(before.library, 'the standard library merged').toBeGreaterThan(1000);
  await page.getByTestId('tab-problems').click();
  const problems = page.getByTestId('problem-row');
  const problemsBefore = await problems.count();

  const download = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-sysml').click();
  const exportedPath = await (await download).path();
  const exported = readFileSync(exportedPath!, 'utf8');
  expect(exported).toContain('package VehicleModel');
  expect(exported).not.toContain('library package');

  await openTab(page, 'tab-text');
  expect(await page.getByTestId('text-editor').inputValue(), 'the Text view’s text').toBe(exported);

  // The model before the import already equals `before`, so the poll below
  // waits for the import to land first: it pushes the only undo there is.
  const undo = page.getByTestId('tb-undo');
  await expect(undo).toBeDisabled();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('tb-import').click();
  await (await chooser).setFiles(exportedPath!);
  await expect(undo, 'the import landed').toBeEnabled();
  await expect.poll(snapshot).toEqual(before);
  await page.getByTestId('tab-problems').click();
  await expect.poll(() => problems.count(), 'no parse errors came with the file').toBe(problemsBefore);
});

/**
 * Export ▾ → SysML wrote the model without the text typed in the Text view
 * and not applied, and the guide said to press Apply first. It applies the
 * text first now, as Save does — one Undo step, as Apply's — and keeps back a
 * text with a syntax error: the file holds the model as it stands, and the
 * strip under the toolbar says so, until an export holds the text.
 */
test('Export ▾ → SysML applies the text typed in the Text view first, as Save does — and keeps back a text with a syntax error, saying so', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  const status = page.locator('.text-editor-status');
  const strip = page.getByTestId('drive-strip');
  const undo = page.getByTestId('tb-undo');
  /** Export ▾ → SysML: the file it downloads. */
  const exportSysml = async (): Promise<string> => {
    const download = page.waitForEvent('download');
    await page.getByTestId('tb-export').click();
    await page.getByTestId('tb-export-sysml').click();
    return readFileSync((await (await download).path())!, 'utf8');
  };
  const hasPartDef = (name: string) =>
    page.evaluate(
      (n) =>
        (window as unknown as {
          sysml: { elementsOfType: (t: string) => { declaredName?: string }[] };
        }).sysml
          .elementsOfType('PartDefinition')
          .some((e) => e.declaredName === n),
      name,
    );

  // ── Typed and not applied: the export applies it, and the file holds it ──
  await expect(undo).toBeDisabled();
  await editor.fill((await editor.inputValue()).replace('part def Engine;', 'part def Engine;\n    part def Typed;'));
  await expect(status).toHaveClass(/is-dirty/);
  const applied = await exportSysml();
  expect(applied).toContain('    part def Typed;\n');
  expect(await hasPartDef('Typed'), 'applied').toBe(true);
  await expect(status).not.toHaveClass(/is-dirty/);
  await expect(editor, 'the file is the Text view’s text').toHaveValue(applied);
  await expect(strip).toHaveCount(0);

  // ── One Undo step, as Apply's, takes it back ──
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect.poll(() => hasPartDef('Typed')).toBe(false);
  await expect(editor).not.toHaveValue(/part def Typed;/);
  await expect(undo).toBeDisabled();

  // ── A syntax error: the model as it stands, nothing applied, and the strip says so ──
  const broken = (await editor.inputValue()).replace('part def Engine;', 'part def Engine;\n    blok bad;');
  const line = broken.split('\n').findIndex((l) => l.includes('blok bad;')) + 1;
  await editor.fill(broken);
  const asItStands = await exportSysml();
  expect(asItStands).toContain('part def Engine;');
  expect(asItStands).not.toContain('blok');
  await expect(strip).toHaveAttribute('data-status', 'info');
  await expect(strip).toHaveAttribute('role', 'status');
  await expect(strip).toContainText(
    `Exported without the text typed in the Text view: it has a syntax error at line ${line}. Fix it, then export again.`,
  );
  await expect(editor).toHaveValue(broken);
  await expect(status).toHaveClass(/is-dirty/);
  await expect(undo, 'nothing applied').toBeDisabled();
  await shot(page, '07c-export-kept-back');

  // ── Fixed: the next export holds it, and takes the note down ──
  await editor.fill(broken.replace('blok bad;', 'part def Fixed;'));
  expect(await exportSysml()).toContain('part def Fixed;');
  expect(await hasPartDef('Fixed')).toBe(true);
  await expect(strip).toHaveCount(0);

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

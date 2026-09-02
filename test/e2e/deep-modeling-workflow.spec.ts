/**
 * DEEP MODELING SESSION — exploratory, end-to-end authoring workflow.
 *
 * Unlike the per-feature specs, this drives one continuous session the way a
 * real user would: build a powertrain model from scratch through the UI
 * (palette + explorer + properties + edge tool), round-trip it through the
 * text editor, validate it, undo/redo across it, persist and restore it, and
 * finally render every view. Console/page errors are watched for the WHOLE
 * session and asserted at the end.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, gotoApp, selectElementById, shot } from './fixtures';

test.setTimeout(600_000);

interface SdkLite {
  elementsOfType: (t: string) => { id: string; declaredName?: string }[];
  children: (id: string) => { id: string; eClass: string; declaredName?: string }[];
  getElement: (id: string) => { id: string; eClass: string; declaredName?: string } | undefined;
}

const idsOfType = (page: Page, eClass: string): Promise<string[]> =>
  page.evaluate(
    (e) =>
      (window as unknown as { sysml: SdkLite }).sysml
        .elementsOfType(e)
        .filter((x) => !x.id.startsWith('stdlib:'))
        .map((x) => x.id),
    eClass,
  );

const countOfType = (page: Page, eClass: string): Promise<number> =>
  page.evaluate(
    (e) =>
      (window as unknown as { sysml: SdkLite }).sysml
        .elementsOfType(e)
        .filter((x) => !x.id.startsWith('stdlib:'))
        .length,
    eClass,
  );

const hasNamed = (page: Page, eClass: string, name: string): Promise<boolean> =>
  page.evaluate(
    ({ e, n }) =>
      (window as unknown as { sysml: SdkLite }).sysml
        .elementsOfType(e)
        .filter((el) => !el.id.startsWith('stdlib:'))
        .some((el) => el.declaredName === n),
    { e: eClass, n: name },
  );

/** Arm a palette node tool and click empty canvas → new element id. */
async function armNodeAndPlace(page: Page, nodeKind: string): Promise<string> {
  const before = await idsOfType(page, nodeKind);
  await page
    .locator(`[data-testid="palette-tool"][data-kind="${nodeKind}"][data-tooltype="node"]`)
    .first()
    .click();
  await page
    .locator('.react-flow__pane')
    .click({ force: true, position: { x: 30 + Math.random() * 150, y: 30 + Math.random() * 150 } });
  await expect.poll(() => countOfType(page, nodeKind)).toBe(before.length + 1);
  const after = await idsOfType(page, nodeKind);
  const created = after.find((id) => !before.includes(id));
  if (!created) throw new Error(`no new ${nodeKind} id found`);
  return created;
}

/** Create a child of `ownerId` via the explorer row + button + picker. */
async function createChild(page: Page, ownerId: string, eClass: string): Promise<string> {
  const beforeIds = await page.evaluate(
    ({ oid }) =>
      (window as unknown as { sysml: SdkLite }).sysml
        .children(oid)
        .map((c) => c.id),
    { oid: ownerId },
  );
  await selectElementById(page, ownerId);
  const row = page.locator(`[data-elementid="${ownerId}"]`).first();
  await row.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption(eClass);
  let createdId: string | null = null;
  await expect
    .poll(async () => {
      const kids = await page.evaluate(
        ({ oid }) =>
          (window as unknown as { sysml: SdkLite }).sysml
            .children(oid)
            .map((c) => ({ id: c.id, eClass: c.eClass })),
        { oid: ownerId },
      );
      const created = kids.filter(
        (k) => k.eClass === eClass && !beforeIds.includes(k.id),
      );
      createdId = created[0]?.id ?? null;
      return createdId !== null;
    })
    .toBe(true);
  if (!createdId) throw new Error(`no new ${eClass} child found`);
  return createdId;
}

/** Rename an element through its explorer row double-click. */
async function renameViaExplorer(page: Page, id: string, name: string): Promise<void> {
  await selectElementById(page, id);
  await page.locator(`[data-elementid="${id}"]`).first().dblclick();
  await page.getByTestId('tree-rename').fill(name);
  await page.getByTestId('tree-rename').press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        (i) => (window as unknown as { sysml: SdkLite }).sysml.getElement(i)?.declaredName,
        id,
      ),
    )
    .toBe(name);
}

/** Set a property panel field by testid (fill + Enter for text inputs). */
async function setProp(page: Page, testid: string, value: string): Promise<void> {
  await page.getByTestId(testid).fill(value);
  await page.getByTestId(testid).press('Enter');
}

test('deep modeling session: powertrain from scratch → text → validate → undo → persist → all views', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  /* ── 1. New project ── */
  await page.getByTestId('tb-new').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(false);
  const newRoot = page.locator('[data-elementid]').filter({ hasText: 'NewModel' }).first();
  await expect(newRoot).toBeVisible();
  const rootId = await newRoot.getAttribute('data-elementid');
  expect(rootId).toBeTruthy();
  await shot(page, 'deep-01-new');

  /* ── 2. Definitions: one via the palette node tool, one via the explorer
         (palette clicks land wherever the click hits — on a node they create a
         CHILD — so only the first, guaranteed-empty-canvas click uses it) ── */
  const engineDef = await armNodeAndPlace(page, 'PartDefinition');
  const transDef = await createChild(page, rootId!, 'PartDefinition');
  await renameViaExplorer(page, engineDef, 'Engine');
  await renameViaExplorer(page, transDef, 'Transmission');
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Engine')).toBe(true);
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Transmission')).toBe(true);

  /* ── 3. Attributes on Engine: named + valued ── */
  const displacement = await createChild(page, engineDef, 'AttributeUsage');
  await selectElementById(page, displacement);
  await setProp(page, 'prop-name', 'displacement');
  await setProp(page, 'prop-value', '2.0');
  const cylinders = await createChild(page, engineDef, 'AttributeUsage');
  await selectElementById(page, cylinders);
  await setProp(page, 'prop-name', 'cylinders');
  await setProp(page, 'prop-value', '4');
  await expect.poll(() => hasNamed(page, 'AttributeUsage', 'displacement')).toBe(true);
  await expect.poll(() => hasNamed(page, 'AttributeUsage', 'cylinders')).toBe(true);

  /* ── 4. Ports on the definitions ── */
  const engOutPort = await createChild(page, engineDef, 'PortUsage');
  await selectElementById(page, engOutPort);
  await setProp(page, 'prop-name', 'torqueOut');
  await page.getByTestId('prop-direction').selectOption('out');
  const transInPort = await createChild(page, transDef, 'PortUsage');
  await selectElementById(page, transInPort);
  await setProp(page, 'prop-name', 'torqueIn');
  await page.getByTestId('prop-direction').selectOption('in');
  await expect.poll(() => hasNamed(page, 'PortUsage', 'torqueOut')).toBe(true);
  await expect.poll(() => hasNamed(page, 'PortUsage', 'torqueIn')).toBe(true);

  /* ── 5. Composite usages in the root ── */
  const engUsage = await createChild(page, rootId!, 'PartUsage');
  await renameViaExplorer(page, engUsage, 'engine');
  const transUsage = await createChild(page, rootId!, 'PartUsage');
  await renameViaExplorer(page, transUsage, 'transmission');
  await expect.poll(() => hasNamed(page, 'PartUsage', 'engine')).toBe(true);
  await expect.poll(() => hasNamed(page, 'PartUsage', 'transmission')).toBe(true);

  /* ── 6. Edge tool: connect engine → transmission in interconnection view ── */
  await page.getByTestId('tb-view-interconnection').click();
  // Auto-layout first: explorer-created usages get deterministic, non-overlapping
  // positions (without it their nodes can stack under the definition frames and
  // the click-to-connect gesture misses).
  await page.getByTestId('tb-layout').click();
  await page.waitForTimeout(800);
  await expect(
    page.locator(`.react-flow__node[data-id="${engUsage}"]`),
  ).toBeVisible();
  await expect(
    page.locator(`.react-flow__node[data-id="${transUsage}"]`),
  ).toBeVisible();
  const edgesBefore = await countOfType(page, 'ConnectionUsage');
  await page
    .locator(`[data-testid="palette-tool"][data-kind="ConnectionUsage"][data-tooltype="edge"]`)
    .first()
    .click();
  const HEAD = { force: true, position: { x: 8, y: 6 } } as const;
  // Click via raw mouse at the box centre: React re-renders nodes after the
  // first click (pendingSource decoration), which can detach a locator click.
  const clickNodeCenter = async (id: string): Promise<void> => {
    const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
    if (!box) throw new Error(`node ${id} not found`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  await page.locator(`.react-flow__node[data-id="${engUsage}"]`).click(HEAD);
  await page.waitForTimeout(400);
  await clickNodeCenter(transUsage);
  await expect.poll(() => countOfType(page, 'ConnectionUsage')).toBe(edgesBefore + 1);
  const wired = await page.evaluate(
    ({ src, tgt }) =>
      (window as unknown as {
        sysml: { elementsOfType: (t: string) => { source?: string[]; target?: string[] }[] };
      }).sysml
        .elementsOfType('ConnectionUsage')
        .some((r) => (r.source ?? []).includes(src) && (r.target ?? []).includes(tgt)),
    { src: engUsage, tgt: transUsage },
  );
  expect(wired).toBe(true);
  await shot(page, 'deep-06-connected');

  /* ── 7. Constraint on the composite ── */
  const constraint = await createChild(page, rootId!, 'ConstraintUsage');
  await selectElementById(page, constraint);
  await setProp(page, 'prop-name', 'powerBalance');
  await expect.poll(() => hasNamed(page, 'ConstraintUsage', 'powerBalance')).toBe(true);

  /* ── 8. Text round-trip: serialize, verify, extend, apply ── */
  await page.getByTestId('tab-text').click();
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  for (const frag of [
    'part def Engine',
    'part def Transmission',
    'part engine',
    'part transmission',
    'torqueOut',
    'torqueIn',
    'powerBalance',
  ]) {
    // The text buffer regenerates on a debounced recompute — poll for it.
    await expect
      .poll(async () => (await editor.inputValue()).includes(frag), {
        message: `serialized text should contain ${frag}`,
      })
      .toBe(true);
  }
  const text1 = await editor.inputValue();
  // Insert the attribute INSIDE the existing Engine body (balanced braces) —
  // never wrap the definition in an unclosed brace.
  const marker = 'attribute displacement';
  expect(text1).toContain(marker);
  const text2 = text1.replace(
    marker,
    'attribute torque : Real = 320;\n            ' + marker,
  );
  await editor.fill(text2);
  await page.getByTestId('text-apply').click();
  await expect.poll(() => hasNamed(page, 'AttributeUsage', 'torque')).toBe(true);
  await shot(page, 'deep-08-text');

  /* ── 9. Validation: introduce + clear a duplicate name ── */
  await page.getByTestId('tb-validate').click();
  await page.getByTestId('tab-problems').click();
  await expect
    .poll(() => page.locator('[data-testid="problem-row"]').count())
    .toBe(0);
  await page.getByTestId('tab-text').click();
  const text3 = (await editor.inputValue()).replace(
    'part transmission',
    'part engine\n        part transmission',
  );
  await editor.fill(text3);
  await page.getByTestId('text-apply').click();
  await page.getByTestId('tb-validate').click();
  await page.getByTestId('tab-problems').click();
  await expect
    .poll(() => page.locator('[data-testid="problem-row"]').count())
    .toBeGreaterThan(0);
  await shot(page, 'deep-09-problem');

  /* ── 10. Undo the duplicate, redo it, undo again ── */
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => countOfType(page, 'PartUsage')).toBe(2);
  await page.getByTestId('tb-redo').click();
  await expect.poll(() => countOfType(page, 'PartUsage')).toBe(3);
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => countOfType(page, 'PartUsage')).toBe(2);
  await page.getByTestId('tb-validate').click();
  await expect.poll(() => page.locator('[data-testid="problem-row"]').count()).toBe(0);

  /* ── 11. Persistence: save → new → open ── */
  await page.getByTestId('tb-save').click();
  await page.waitForTimeout(400);
  await shot(page, 'deep-11-saved');
  await page.getByTestId('tb-new').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Engine')).toBe(false);
  await page.getByTestId('tb-open').click();
  await page.locator('[data-testid="project-pick"]').first().click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Engine')).toBe(true);
  await expect.poll(() => hasNamed(page, 'AttributeUsage', 'torque')).toBe(true);
  await expect.poll(() => countOfType(page, 'ConnectionUsage')).toBeGreaterThan(0);
  await shot(page, 'deep-11-restored');

  /* ── 12. Views render the restored model ── */
  for (const view of [
    'general',
    'interconnection',
    'action',
    'state',
    'requirement',
    'parametric',
    'case',
    'analysis',
    'grid',
    'tree',
    'requirements',
    'planning',
    'regroup',
  ]) {
    await page.getByTestId(`tb-view-${view}`).click();
    await page.waitForTimeout(250);
  }
  await page.getByTestId('tb-view-general').click();
  await shot(page, 'deep-12-views');

  /* ── 14. API console: query + metrics + where-used + commit (same session) ── */
  await page.getByTestId('tab-api').click();
  const query = page.getByTestId('api-query');
  const results = page.getByTestId('api-results');
  await expect(query).toBeVisible();
  await query.fill(
    JSON.stringify({ constraint: { property: '@type', operator: '=', value: 'PartUsage' } }),
  );
  await page.getByTestId('api-run').click();
  await expect(results.locator('table.api-table')).toBeVisible();
  await expect(results).toContainText('engine');
  await expect(results).toContainText('transmission');
  await page.getByTestId('api-metrics').click();
  await expect(results).toContainText('Model metrics');
  // Where-used needs a selection: the Engine definition is referenced by the
  // typed engine usage.
  const engineDefId = await page.evaluate(() => {
    const s = (window as unknown as { sysml: SdkLite }).sysml;
    return (
      s
        .elementsOfType('PartDefinition')
        .filter((e) => !e.id.startsWith('stdlib:') && e.declaredName === 'Engine')[0]?.id ?? null
    );
  });
  expect(engineDefId).toBeTruthy();
  await selectElementById(page, engineDefId!);
  await page.getByTestId('tab-api').click();
  await page.getByTestId('api-whereused').click();
  await expect(results).toContainText('Where used');
  await page.getByTestId('api-commit').click();
  await expect(page.getByTestId('api-commit-id')).toBeVisible();
  await shot(page, 'deep2-api');

  /* ── 15. Export .sysml → download content references the powertrain ── */
  const sysmlDownload = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-sysml').click();
  const dl1 = await sysmlDownload;
  const sysmlPath = await dl1.path();
  expect(sysmlPath).toBeTruthy();
  const { readFileSync } = await import('node:fs');
  const sysmlText = readFileSync(sysmlPath!, 'utf8');
  expect(sysmlText).toContain('part def Engine');
  expect(sysmlText).toContain('part engine');
  expect(sysmlText).toContain('torque');
  // The download temp path carries no .sysml extension (format detection
  // needs it) — stage the content under a proper name for the import.
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('test-results', { recursive: true });
  const stagedSysml = 'test-results/deep-powertrain.sysml';
  // Stage only the user model: the export includes the merged ~36 k-element
  // standard library, and re-importing THAT in the browser blocks the main
  // thread for minutes (a separate performance concern — see the review doc).
  // Library content begins at the first `library ` statement; everything
  // before it is the authored powertrain.
  const libStart = sysmlText.indexOf('\nlibrary ');
  const userPart = libStart === -1 ? sysmlText : sysmlText.slice(0, libStart);
  expect(userPart).toContain('part def Engine');
  writeFileSync(stagedSysml, userPart, 'utf8');

  /* ── 16. Export JSON → valid SerializedModel shape ── */
  const jsonDownload = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-json').click();
  const dl2 = await jsonDownload;
  const jsonPath = await dl2.path();
  expect(jsonPath).toBeTruthy();
  const parsed = JSON.parse(readFileSync(jsonPath!, 'utf8')) as {
    elements?: unknown[];
    rootIds?: unknown[];
  };
  expect(Array.isArray(parsed.elements)).toBe(true);
  expect((parsed.elements ?? []).length).toBeGreaterThan(0);

  /* ── 17. Import the exported .sysml into a FRESH project → model restored ── */
  // Force the <input type=file> fallback (the FS Access picker emits no
  // Playwright filechooser event); init scripts apply at navigation, so reload.
  await page.addInitScript(() => {
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
  await page.reload();
  await expect(page.getByTestId('explorer')).toBeVisible();
  await page.getByTestId('tb-new').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Engine')).toBe(false);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('tb-import').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(stagedSysml);
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Engine')).toBe(true);
  await expect.poll(() => hasNamed(page, 'PartUsage', 'engine')).toBe(true);
  await expect.poll(() => hasNamed(page, 'AttributeUsage', 'torque')).toBe(true);
  await shot(page, 'deep2-imported');

  /* ── 18. Solve on the restored model ── */
  await page.getByTestId('tb-solve').click();
  await page.waitForTimeout(600);

  /* ── 19. Zero console errors across the whole session ── */
  expect(errors, errors.join('\n')).toEqual([]);
});

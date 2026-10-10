/**
 * Does the user's work survive closing the tab?
 *
 * `toolbar-lifecycle.spec.ts` round-trips Save → New → Open inside one page
 * session, which only proves the in-memory project store works. These tests
 * cross a **real browser reload**, so the assertion is about IndexedDB-backed
 * persistence and about the app's honest boot behaviour:
 *
 *  - a saved project is still there after the reload and reopens intact;
 *  - unsaved edits are *not* silently resurrected — the app boots the sample,
 *    so nobody is misled into thinking their work was kept;
 *  - boxes moved by hand on a diagram are saved with the project, beside the
 *    model — through the apply Save makes of text typed in the Text view —
 *    and Open puts them back where they were.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { captureErrors, diagramSettled, findElementId, gotoApp, openTab, shot } from './fixtures';
import { addChild, exists, hasNamed, idsOfType, renameInTree } from './model-helpers';

/** Wait for the app shell + SDK after a reload (gotoApp without the navigation). */
async function waitForApp(page: Page): Promise<void> {
  await expect(page.getByTestId('explorer')).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => !!(window as unknown as { sysml?: unknown }).sysml);
}

/** Id of the root package of the freshly-created "NewModel" project. */
async function newModelRoot(page: Page): Promise<string> {
  const pkgs = await idsOfType(page, 'Package');
  const root = await page.evaluate(
    (ids) =>
      ids.find(
        (id) =>
          (
            window as unknown as {
              sysml: { getElement(i: string): { declaredName?: string } | undefined };
            }
          ).sysml.getElement(id)?.declaredName === 'NewModel',
      ) ?? null,
    pkgs,
  );
  if (!root) throw new Error('no "NewModel" package after tb-new');
  return root;
}

test('a saved project is still there after a full browser reload', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Start a clean project and put a uniquely-named marker in it.
  await page.getByTestId('tb-new').click();
  await expect(page.locator('[data-elementid]').filter({ hasText: 'NewModel' }).first()).toBeVisible();
  const rootId = await newModelRoot(page);
  const markerId = await addChild(page, rootId, 'PartDefinition');
  await renameInTree(page, markerId, 'SurvivesReload');
  await page.getByTestId('tb-save').click();
  await shot(page, 'reload-a-saved');

  // ── Reload the browser: a cold boot shows the sample, not our project ──
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'SurvivesReload')).toBe(false);
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(true);

  // ── …but the saved project is listed and reopens intact ──
  await page.getByTestId('tb-open').click();
  await expect(page.getByTestId('project-picker')).toBeVisible();
  const pick = page.getByTestId('project-pick').filter({ hasText: 'NewModel' }).first();
  await expect(pick).toBeVisible();
  await pick.click();

  await expect.poll(() => hasNamed(page, 'PartDefinition', 'SurvivesReload')).toBe(true);
  await expect(page.getByTestId('explorer').getByText('SurvivesReload')).toBeVisible();
  await shot(page, 'reload-b-reopened');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('unsaved edits are discarded by a reload rather than silently restored', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Edit the sample without ever pressing Save.
  const rootId = await page.evaluate(
    () =>
      (
        window as unknown as {
          sysml: { elementsOfType(e: string): { id: string; declaredName?: string }[] };
        }
      ).sysml
        .elementsOfType('Package')
        .find((p) => p.declaredName === 'VehicleModel')!.id,
  );
  const ghostId = await addChild(page, rootId, 'PartDefinition');
  await renameInTree(page, ghostId, 'NeverSaved');
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'NeverSaved')).toBe(true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);

  // The unsaved element is gone and the pristine sample is back.
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'NeverSaved')).toBe(false);
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(true);
  await shot(page, 'reload-c-unsaved-discarded');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/** Where the diagram on screen places the box of `id` (React Flow's position, as the store holds it). */
function boxAt(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id) => {
    const view = window as unknown as {
      sysprose: { diagram: { current(): { nodes: { id: string; position?: { x: number; y: number } }[] } | null } };
    };
    return view.sysprose.diagram.current()?.nodes.find((n) => n.id === id)?.position ?? null;
  }, id);
}

/**
 * The boxes moved by hand that the project `name` holds in this browser —
 * read from IndexedDB, as the app stored it beside the model — or null.
 */
function savedPins(page: Page, name: string): Promise<unknown> {
  return page.evaluate(async (name) => {
    const done = <T>(req: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    // Only once the app has made it: opening a database that is not there yet
    // would create it empty, without the store the app's first save makes.
    if (!(await indexedDB.databases()).some((d) => d.name === 'sysmlv2-modeler')) return null;
    const db = await done(indexedDB.open('sysmlv2-modeler'));
    try {
      if (!db.objectStoreNames.contains('projects')) return null;
      const record = await done(db.transaction('projects', 'readonly').objectStore('projects').get(name));
      return (record as { meta?: { diagramPins?: unknown } } | undefined)?.meta?.diagramPins ?? null;
    } finally {
      db.close();
    }
  }, name);
}

/** Drag `node` by its header to a point of the canvas that no box or overlay covers, well away from it. */
async function dragToEmptyCanvas(page: Page, node: Locator): Promise<void> {
  const before = await node.boundingBox();
  if (!before) throw new Error('node has no bounding box');
  const empty = await page.evaluate((from) => {
    const canvas = document.querySelector('[data-testid="diagram-canvas"]')!.getBoundingClientRect();
    const blockers = [
      ...document.querySelectorAll(
        '.react-flow__node, .react-flow__panel, .react-flow__controls, .react-flow__minimap, .react-flow__attribution',
      ),
    ].map((n) => n.getBoundingClientRect());
    const hits = (x: number, y: number) =>
      blockers.some((r) => x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12);
    for (let y = canvas.top + canvas.height / 2; y < canvas.bottom - 40; y += 20) {
      for (let x = canvas.left + 40; x < canvas.right - 40; x += 20) {
        if (!hits(x, y) && Math.hypot(x - from.x, y - from.y) >= 120) return { x, y };
      }
    }
    return null;
  }, { x: before.x + before.width / 2, y: before.y + before.height / 2 });
  if (!empty) throw new Error('no empty canvas point found');
  const grabX = before.x + Math.min(20, before.width / 2);
  const grabY = before.y + 8;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move((grabX + empty.x) / 2, (grabY + empty.y) / 2, { steps: 10 });
  await page.mouse.move(empty.x, empty.y, { steps: 10 });
  await page.mouse.up();
}

test('a box moved by hand is saved with the project, and is where it was when the project reopens after a reload', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await page.getByTestId('tb-view-general').click();
  await diagramSettled(page);

  const vehicleId = await findElementId(page, 'PartDefinition', 'Vehicle');
  const laidOut = await boxAt(page, vehicleId);
  if (!laidOut) throw new Error('the General view draws no Vehicle box');
  await dragToEmptyCanvas(page, page.locator(`.react-flow__node[data-id="${vehicleId}"]`));
  await expect
    .poll(async () => {
      const at = await boxAt(page, vehicleId);
      return at ? Math.round(Math.abs(at.x - laidOut.x) + Math.abs(at.y - laidOut.y)) : 0;
    })
    .toBeGreaterThan(40);
  const dropped = (await boxAt(page, vehicleId))!;

  // A line typed in the Text view and not applied: Save applies it first, and
  // the apply makes every element anew, under a new id — the box stays put.
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await editor.fill((await editor.inputValue()).replace(/part def Vehicle\b/, 'part def Kite;\n    part def Vehicle'));
  await expect(page.locator('.text-editor-status')).toHaveClass(/is-dirty/);

  // Save stores the box beside the model — the sample's project is VehicleModel.
  await page.getByTestId('tb-save').click();
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Kite')).toBe(true);
  const savedId = await findElementId(page, 'PartDefinition', 'Vehicle');
  expect(savedId, 'the apply made Vehicle anew').not.toBe(vehicleId);
  await diagramSettled(page);
  expect(await boxAt(page, savedId), 'the box stays where it was dropped').toEqual(dropped);
  await expect
    .poll(async () => ((await savedPins(page, 'VehicleModel')) as Record<string, unknown> | null)?.['general|'])
    .toEqual({ [savedId]: dropped });
  await shot(page, 'reload-d-box-moved');

  // ── Reload: a cold boot lays the sample out afresh… ──
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  expect(await exists(page, savedId), 'the booted sample is new elements').toBe(false);

  // ── …and Open puts the saved project's box back where it was dropped ──
  await page.getByTestId('tb-open').click();
  await page.locator('[data-testid="project-pick"][data-name="VehicleModel"]').click();
  await expect.poll(() => exists(page, savedId)).toBe(true);
  await page.getByTestId('tb-view-general').click();
  await diagramSettled(page);
  expect(await boxAt(page, savedId)).toEqual(dropped);
  await expect(page.locator(`.react-flow__node[data-id="${savedId}"]`)).toBeVisible();
  await shot(page, 'reload-e-box-where-it-was');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

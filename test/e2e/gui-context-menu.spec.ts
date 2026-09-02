import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

const modelSize = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () => (window as unknown as { sysml: { model: { all(): unknown[] } } }).sysml.model.all().length,
  );

/**
 * Right-click node context menu on the diagram canvas — brings the common
 * model-editing actions (rename / add child / delete) + Zoom-to onto the canvas
 * so the user need not round-trip through the Explorer tree.
 */
test('canvas node context menu: add child, rename, Escape, delete', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  const node = () => page.locator('.react-flow__node').first();
  const menu = page.getByTestId('node-ctx-menu');

  // Right-click a node → the menu opens (and selects the node).
  await node().click({ button: 'right' });
  await expect(menu).toBeVisible();
  await shot(page, '79-node-context-menu');

  // Add child → the model grows by one and the menu closes.
  const n0 = await modelSize(page);
  await page.getByTestId('node-ctx-add').selectOption({ label: 'part' }); // PartUsage
  await expect.poll(() => modelSize(page)).toBe(n0 + 1);
  await expect(menu).toHaveCount(0);

  // Escape closes the menu.
  await node().click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Rename via the menu → the new label renders on the canvas.
  await node().click({ button: 'right' });
  await page.getByTestId('node-ctx-rename').click();
  const input = page.getByTestId('node-ctx-rename-input');
  await input.fill('RenamedNode');
  await input.press('Enter');
  await expect(
    page.locator('.react-flow__node').filter({ hasText: 'RenamedNode' }).first(),
  ).toBeVisible(); // the renamed label renders on the canvas node

  // Delete removes the element (model shrinks).
  const n1 = await modelSize(page);
  await node().click({ button: 'right' });
  await page.getByTestId('node-ctx-delete').click();
  await expect.poll(() => modelSize(page)).toBeLessThan(n1);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('canvas node context menu: Duplicate deep-clones the element as a sibling', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  const node = () => page.locator('.react-flow__node').first();
  const menu = page.getByTestId('node-ctx-menu');

  await node().click({ button: 'right' });
  await expect(menu).toBeVisible();

  const n0 = await modelSize(page);
  await page.getByTestId('node-ctx-duplicate').click();
  // The clone brings at least the element itself (subtrees grow it by more).
  await expect.poll(() => modelSize(page)).toBeGreaterThan(n0);
  await expect(menu).toHaveCount(0);

  // A "… copy" element now exists (unique-sibling-name suffix).
  const hasCopy = await page.evaluate(() =>
    (
      window as unknown as { sysml: { model: { all(): { declaredName?: string }[] } } }
    ).sysml.model.all().some((e) => e.declaredName?.endsWith('copy')),
  );
  expect(hasCopy).toBe(true);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('canvas context menu closes on a CANVAS wheel, not on an unrelated panel scroll', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  const menu = page.getByTestId('node-ctx-menu');

  await page.locator('.react-flow__node').first().click({ button: 'right' });
  await expect(menu).toBeVisible();

  // Regression: a scroll / wheel in a NON-canvas panel must NOT dismiss the menu
  // (the Explorer selection-reveal scroll fired by the same right-click used to
  // self-close it ~1 frame after opening).
  await page.evaluate(() => {
    const tree = document.querySelector('.explorer-tree');
    tree?.dispatchEvent(new Event('scroll', { bubbles: true }));
    tree?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    window.dispatchEvent(new Event('scroll'));
  });
  await expect(menu).toBeVisible(); // still open

  // Wheeling the canvas itself (zoom) DOES dismiss it.
  await page.mouse.wheel(0, 120); // pointer is over the right-clicked node
  await expect(menu).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('canvas edge context menu: right-click a connection → Delete removes it', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // The general view has a relationship edge (the «satisfy» link). Right-click it
  // via a dispatched contextmenu — a real mouse click on the thin SVG edge path
  // is unreliable in headless Chromium.
  const edge = page.locator('[data-testid^="rf__edge-rel:"]').first();
  await expect(edge).toBeAttached();
  const opened = await page.evaluate(() => {
    const e = document.querySelector('[data-testid^="rf__edge-rel:"]');
    if (!e) return false;
    e.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 520, clientY: 320 }),
    );
    return true;
  });
  expect(opened).toBe(true);

  const menu = page.getByTestId('node-ctx-menu');
  await expect(menu).toBeVisible();
  // A relationship (edge) offers only Delete — no Rename / Add-child / Zoom.
  await expect(page.getByTestId('node-ctx-rename')).toHaveCount(0);
  await expect(page.getByTestId('node-ctx-add')).toHaveCount(0);
  await expect(page.getByTestId('node-ctx-fit')).toHaveCount(0);
  await expect(page.getByTestId('node-ctx-delete')).toBeVisible();

  const n0 = await modelSize(page);
  await page.getByTestId('node-ctx-delete').click();
  await expect.poll(() => modelSize(page)).toBeLessThan(n0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('canvas pane context menu: right-click empty canvas → add a top-level element', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Right-click the empty pane (dispatched contextmenu — a positioned mouse
  // click risks hitting a node or overshooting onto the bottom panel).
  const rightClickPane = () =>
    page.evaluate(() => {
      document
        .querySelector('.react-flow__pane')
        ?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 320,
            clientY: 240,
          }),
        );
    });
  await rightClickPane();
  const menu = page.getByTestId('pane-ctx-menu');
  await expect(menu).toBeVisible();
  await shot(page, '80-pane-context-menu');

  // Add element → the model grows by one and the menu closes.
  const n0 = await modelSize(page);
  await page.getByTestId('pane-ctx-add').selectOption('PartDefinition');
  await expect.poll(() => modelSize(page)).toBe(n0 + 1);
  await expect(menu).toHaveCount(0);
  // …and it's created at the ROOT (top-level), not under the current selection.
  const rootDef = await page.evaluate(
    () =>
      (window as unknown as { sysml: { model: { roots(): { eClass: string }[] } } }).sysml.model
        .roots()
        .some((r) => r.eClass === 'PartDefinition'),
  );
  expect(rootDef).toBe(true);

  // Reopen → Escape closes it.
  await rightClickPane();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

/**
 * Diagram readability and hand editing, in the real app.
 *
 *  - Laid-out edges are drawn along ELK's orthogonal routes (no curves), so no
 *    line crosses a box it does not connect.
 *  - A box moved by hand stays where it was dropped across a rebuild (a view
 *    switch here), its edges stepping orthogonally to it; Auto-layout forgets
 *    the move and lays the diagram out afresh.
 *  - The tree view grows one branch at a time: "+N" on a box opens what it
 *    owns, "−" closes it again.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, findElementId, gotoApp } from './fixtures';

interface Diagram {
  nodes: { id: string; position?: { x: number; y: number } }[];
  viewKind: string;
}

const current = (page: Page): Promise<Diagram> =>
  page.evaluate(() => (window as unknown as { sysprose: { diagram: { current: () => Diagram } } }).sysprose.diagram.current());

async function positionOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const d = await current(page);
  return d.nodes.find((n) => n.id === id)!.position!;
}

/** Every drawn edge path is straight segments and rounded corners — no Bézier curves. */
async function expectOrthogonalEdges(page: Page): Promise<void> {
  const paths = await page.locator('.react-flow__edge-path').evaluateAll((els) => els.map((e) => e.getAttribute('d') ?? ''));
  expect(paths.length).toBeGreaterThan(0);
  for (const d of paths) expect(d, `edge path "${d.slice(0, 60)}…" is curved`).not.toMatch(/[Cc]/);
}

async function showView(page: Page, view: string): Promise<void> {
  await page.getByTestId(`tb-view-${view}`).click();
  await expect.poll(async () => (await current(page))?.viewKind).toBe(view);
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
}

test('laid-out edges follow orthogonal routes', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  // The views the sample model populates (it has no states, actions or cases).
  for (const view of ['general', 'requirement', 'tree']) {
    await showView(page, view);
    await expectOrthogonalEdges(page);
  }
  expect(errors).toEqual([]);
});

test('a box moved by hand stays put across a rebuild; Auto-layout puts it back', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await showView(page, 'general');

  const id = await findElementId(page, 'PartDefinition', 'Vehicle');
  const laidOut = await positionOf(page, id);
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  const box = (await node.boundingBox())!;

  // Drag it down-right by a clear margin, onto empty canvas below the diagram.
  const empty = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="diagram-canvas"]')!.getBoundingClientRect();
    const blockers = [...document.querySelectorAll('.react-flow__node, .react-flow__panel, .react-flow__controls, .react-flow__minimap')].map((n) =>
      n.getBoundingClientRect(),
    );
    const hits = (x: number, y: number) => blockers.some((r) => x >= r.left - 16 && x <= r.right + 16 && y >= r.top - 16 && y <= r.bottom + 16);
    for (let y = canvas.bottom - 60; y > canvas.top + 40; y -= 20) {
      for (let x = canvas.left + 60; x < canvas.right - 60; x += 20) if (!hits(x, y)) return { x, y };
    }
    return null;
  });
  if (!empty) throw new Error('no empty canvas point found');
  const grab = { x: box.x + Math.min(20, box.width / 2), y: box.y + 8 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move((grab.x + empty.x) / 2, (grab.y + empty.y) / 2, { steps: 8 });
  await page.mouse.move(empty.x, empty.y, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => {
    const p = await positionOf(page, id);
    return Math.abs(p.x - laidOut.x) + Math.abs(p.y - laidOut.y);
  }).toBeGreaterThan(40);
  const moved = await positionOf(page, id);
  await expectOrthogonalEdges(page);

  // A rebuild (leave the view and come back) keeps the hand-placed box.
  await showView(page, 'requirement');
  await showView(page, 'general');
  const afterRebuild = await positionOf(page, id);
  expect(afterRebuild.x).toBeCloseTo(moved.x, 0);
  expect(afterRebuild.y).toBeCloseTo(moved.y, 0);
  await expectOrthogonalEdges(page);

  // Auto-layout forgets the move.
  await page.getByTestId('diagram-autolayout').click();
  await expect.poll(async () => {
    const p = await positionOf(page, id);
    return Math.abs(p.x - laidOut.x) + Math.abs(p.y - laidOut.y);
  }).toBeLessThan(1);
  expect(errors).toEqual([]);
});

test('the tree grows one branch at a time', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await showView(page, 'tree');

  const count = async () => (await current(page)).nodes.length;
  const before = await count();
  const closed = page.getByTestId('tree-toggle').filter({ hasText: /^\+\d+$/ }).first();
  await expect(closed).toBeVisible();
  const hidden = Number((await closed.textContent())!.slice(1));
  const owner = await closed.evaluate((el) => el.closest('.react-flow__node')!.getAttribute('data-id'));

  await closed.click();
  await expect.poll(count).toBe(before + hidden);
  const opened = page.locator(`.react-flow__node[data-id="${owner}"]`).getByTestId('tree-toggle');
  await expect(opened).toHaveText('−');
  // The Explorer opened the same branch.
  await expect(page.locator(`[data-elementid="${owner}"].tree-node`)).toBeVisible();

  await opened.click();
  await expect.poll(count).toBe(before);
  expect(errors).toEqual([]);
});

/** A model big enough that its whole drawing and one package's differ a lot. */
function layeredModel(): string {
  const pkg = (name: string) =>
    `    package ${name} {\n` +
    // Loose boxes pack into a block, so one package is a small part of the whole.
    Array.from({ length: 40 }, (_, i) => `        part def ${name}Block${i};`).join('\n') +
    '\n    }';
  return `package Layered {\n${['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map(pkg).join('\n')}\n}\n`;
}

/** How much of the canvas the drawn boxes fill (the larger of the two ratios), and the zoom. */
async function fill(page: Page): Promise<{ ratio: number; zoom: number }> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="diagram-canvas"]')!.getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.react-flow__node')].map((n) => n.getBoundingClientRect());
    const x0 = Math.min(...boxes.map((b) => b.left));
    const x1 = Math.max(...boxes.map((b) => b.right));
    const y0 = Math.min(...boxes.map((b) => b.top));
    const y1 = Math.max(...boxes.map((b) => b.bottom));
    const m = /scale\(([\d.]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform);
    return { ratio: Math.max((x1 - x0) / c.width, (y1 - y0) / c.height), zoom: m ? Number(m[1]) : 1 };
  });
}

test('scoping to one package opens it fitted, says so, and can be undone', async ({ page }) => {
  const errors = captureErrors(page);
  await page.route('**/layered/Layered.sysml', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: layeredModel() }),
  );
  await page.goto('/?model=layered/Layered.sysml', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('diagram-canvas')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => (window as unknown as { sysml?: { roots: () => { declaredName?: string }[] } }).sysml?.roots().some((r) => r.declaredName === 'Layered'));
  await expect.poll(async () => (await current(page))?.nodes.length).toBe(240);

  // Scope to Beta from the Explorer.
  const betaId = await findElementId(page, 'Package', 'Beta');
  const row = page.locator(`[data-testid="tree-node"][data-elementid="${betaId}"]`);
  await row.hover();
  await row.getByTestId('tree-scope').click();
  await expect.poll(async () => (await current(page))?.nodes.length).toBe(40);
  await expect(page.getByTestId('scope-chip')).toContainText('Beta');

  // The drawing is fitted to Beta, not left at the whole model's zoom.
  await expect
    .poll(async () => {
      const f = await fill(page);
      return f.ratio >= 0.5 || f.zoom >= 0.999;
    }, { timeout: 15_000 })
    .toBe(true);

  // The chip's × shows the whole model again.
  await page.getByTestId('scope-clear').click();
  await expect.poll(async () => (await current(page))?.nodes.length).toBe(240);
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);

  // Folding the bottom panel leaves its tabs and gives the canvas the room.
  const before = (await page.getByTestId('diagram-canvas').boundingBox())!.height;
  await page.getByTestId('bottom-collapse').click();
  await expect.poll(async () => (await page.getByTestId('diagram-canvas').boundingBox())!.height).toBeGreaterThan(before + 100);
  await expect(page.getByTestId('tab-problems')).toBeVisible();
  await page.getByTestId('tab-problems').click();
  await expect.poll(async () => (await page.getByTestId('diagram-canvas').boundingBox())!.height).toBeLessThan(before + 5);
  expect(errors).toEqual([]);
});


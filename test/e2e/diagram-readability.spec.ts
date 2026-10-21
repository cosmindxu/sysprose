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
 *  - A box that many dependency lines end on leads a one-layer General view,
 *    its lines running from the boxes that point at it.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, selectElementById, viewportSettled } from './fixtures';

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


/** Three layer packages linked by chains, so connected pieces span two or three of them. */
function chainedModel(): string {
  return `package Chained {
    package OA {
        part def Operator;
        part def Mission;
    }
    package SA {
        part def Swarm :> OA::Operator;
        part def Drone;
        part def Relay :> OA::Mission;
    }
    package PA {
        part def Airframe :> SA::Drone;
        part def Radio;
        part def Dish :> SA::Relay;
        part def Loner;
    }
}
`;
}

test('a layered General view names each column above its boxes, and the export carries the names', async ({ page }) => {
  const errors = captureErrors(page);
  await page.route('**/layered/Chained.sysml', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: chainedModel() }),
  );
  await page.goto('/?model=layered/Chained.sysml', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('diagram-canvas')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await current(page))?.nodes.length).toBe(9);
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible' });

  // Three pieces span packages (OA·SA·PA, OA·SA, SA·PA): seven headers, each
  // reading its package's name.
  const headers = page.getByTestId('column-header');
  await expect(headers).toHaveCount(7);
  expect((await headers.allTextContents()).sort()).toEqual(['OA', 'OA', 'PA', 'PA', 'SA', 'SA', 'SA']);
  // Fit frames the headers with the boxes: none is cut off at the canvas's edge.
  for (let i = 0; i < 7; i += 1) await expect(headers.nth(i)).toBeInViewport({ ratio: 0.99 });

  // Drawn: no header lies over a box, and each spans exactly the boxes beneath it.
  const geometry = await page.evaluate(() => {
    const rects = (sel: string) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
    const heads = rects('[data-testid="column-header"]');
    const boxes = rects('.react-flow__node');
    const overlapping = heads.filter((h) =>
      boxes.some((b) => Math.min(h.right, b.right) - Math.max(h.left, b.left) > 1 && Math.min(h.bottom, b.bottom) - Math.max(h.top, b.top) > 1),
    ).length;
    const spans = heads.map((h) => {
      const under = boxes.filter((b) => b.top >= h.bottom - 0.5 && b.left >= h.left - 1.5 && b.right <= h.right + 1.5);
      return {
        boxes: under.length,
        left: under.length ? Math.min(...under.map((b) => b.left)) - h.left : NaN,
        right: under.length ? h.right - Math.max(...under.map((b) => b.right)) : NaN,
      };
    });
    return { overlapping, spans };
  });
  expect(geometry.overlapping).toBe(0);
  for (const s of geometry.spans) {
    expect(s.boxes).toBeGreaterThan(0);
    expect(Math.abs(s.left)).toBeLessThan(1.5);
    expect(Math.abs(s.right)).toBeLessThan(1.5);
  }

  // A header is not in the way of the canvas: a click on it lands on what is under it.
  const first = (await headers.first().boundingBox())!;
  const hitsHeader = await page.evaluate(
    ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="column-header"]'),
    { x: first.x + first.width / 2, y: first.y + first.height / 2 },
  );
  expect(hitsHeader, 'a click on a header is taken by the header').toBe(false);

  // SVG export: the headers are in the file, ahead of the edges and boxes.
  const { readFileSync } = await import('node:fs');
  const svgDownload = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-svg').click();
  const svg = readFileSync((await (await svgDownload).path())!, 'utf8');
  expect(svg.match(/data-column-id="/g)).toHaveLength(7);
  for (const name of ['OA', 'SA', 'PA']) expect(svg).toContain(`>${name}</text>`);
  expect(svg.indexOf('data-layer="column-headers"')).toBeLessThan(svg.indexOf('data-layer="nodes"'));

  // PNG export: the band's fill is painted into the picture.
  const pngDownload = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-png').click();
  const png = readFileSync((await (await pngDownload).path())!).toString('base64');
  const bandPixels = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 0xe8 && d[i + 1] === 0xf0 && d[i + 2] === 0xfe) n += 1;
    return n;
  }, png);
  expect(bandPixels, 'the PNG has no header bands').toBeGreaterThan(1000);

  // Scoped to one package it is not layered, so nothing is headed.
  const saId = await findElementId(page, 'Package', 'SA');
  const row = page.locator(`[data-testid="tree-node"][data-elementid="${saId}"]`);
  await row.hover();
  await row.getByTestId('tree-scope').click();
  await expect.poll(async () => (await current(page))?.nodes.length).toBe(3);
  await expect(headers).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the first screen of a layered General view shows every column header clear of the canvas toolbar', async ({ browser }) => {
  // Common window sizes: the toolbar floats over the canvas's top-right, where the top row of headers sits.
  // Each size opens in a fresh context: a second visit in one would restore the first one's session.
  // At 1024x700 the canvas (about 320 px tall) is shorter than the zoom controls and the legend stacked
  // in its bottom-left corner, which cover boxes there as well; only what hangs from the top is checked.
  for (const size of [{ width: 1400, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 700 }]) {
    const context = await browser.newContext({ viewport: size });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.route('**/layered/Chained.sysml', (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain', body: chainedModel() }),
    );
    await page.goto('/?model=layered/Chained.sysml', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('diagram-canvas')).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await current(page))?.nodes.length).toBe(9);
    await expect(page.getByTestId('column-header')).toHaveCount(7);
    // Wait for the opening fit to settle: the viewport stops moving.
    const viewport = () => page.locator('.react-flow__viewport').getAttribute('style');
    let last = await viewport();
    await expect
      .poll(async () => {
        const now = await viewport();
        const same = now === last;
        last = now;
        return same;
      }, { timeout: 15_000 })
      .toBe(true);
    await page.waitForTimeout(300);

    const overlay = size.width >= 1280 ? '.react-flow__panel, .react-flow__controls, .react-flow__minimap' : '.react-flow__panel.top';
    const covered = await page.evaluate((overlaySelector) => {
      const inter = (a: DOMRect, b: DOMRect) =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      const overlays = [...document.querySelectorAll(overlaySelector)].map((e) => ({
        name: e.className.toString().replace(/\s+/g, '.'),
        rect: e.getBoundingClientRect(),
      }));
      return [...document.querySelectorAll('[data-testid="column-header"]')].flatMap((h) =>
        overlays.filter((o) => inter(h.getBoundingClientRect(), o.rect)).map((o) => `${h.textContent} under ${o.name}`),
      );
    }, overlay);
    expect(covered, `column headers hidden by the canvas's own controls at ${size.width}x${size.height}`).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  }
});

/** One connected piece 60 boxes tall and three wide columns: each of SA's units specialises OA's mission, and PA's task its unit. */
function tallModel(): string {
  const name = (kind: string, i: number): string => `${kind}${i}WithALongNameThatKeepsItsColumnWideEnoughToLabel`;
  const units = Array.from({ length: 60 }, (_, i) => `        part def ${name('Unit', i)} :> OA::${name('Mission', 0)};`).join('\n');
  const tasks = Array.from({ length: 60 }, (_, i) => `        part def ${name('Task', i)} :> SA::${name('Unit', i)};`).join('\n');
  return `package Tall {\n    package OA {\n        part def ${name('Mission', 0)};\n    }\n    package SA {\n${units}\n    }\n    package PA {\n${tasks}\n    }\n}\n`;
}

test('a column header stays on screen in a frozen strip, at Fit and while panning down a tall column', async ({ page }) => {
  const errors = captureErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.route('**/layered/Tall.sysml', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: tallModel() }),
  );
  await page.goto('/?model=layered/Tall.sysml', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('diagram-canvas')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await current(page))?.nodes.length).toBe(121);
  await expect(page.getByTestId('column-header')).toHaveCount(3);
  await viewportSettled(page);

  const canvas = page.getByTestId('diagram-canvas');
  const cells = page.getByTestId('column-strip-cell');
  /** Every strip header on screen: inside the canvas, clear of the toolbar, at a size that reads. */
  const expectStripOnScreen = async (): Promise<void> => {
    const box = (await canvas.boundingBox())!;
    const bar = (await page.locator('.react-flow__panel.top.right').boundingBox())!;
    for (let i = 0; i < (await cells.count()); i += 1) {
      const rect = (await cells.nth(i).boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(rect.y).toBeGreaterThanOrEqual(bar.y + bar.height);
      expect(rect.y + rect.height).toBeLessThanOrEqual(box.y + box.height);
      expect(await cells.nth(i).evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(9);
    }
  };
  const zoom = () =>
    page.evaluate(() => Number(/scale\(([\d.e-]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)![1]));

  // At Fit the whole piece is on screen, far too small for its own bands to read: the strip names all three columns.
  expect(await zoom()).toBeLessThan(0.3);
  await expect.poll(async () => (await cells.allTextContents()).sort()).toEqual(['OA', 'PA', 'SA']);
  await expectStripOnScreen();

  // Zoomed to a box deep in the PA column, the column's own band is far above the screen; the strip still names it.
  await selectElementById(page, await findElementId(page, 'PartDefinition', 'Task50WithALongNameThatKeepsItsColumnWideEnoughToLabel'));
  await page.getByTestId('diagram-fit-selection').click();
  await viewportSettled(page);
  expect(await zoom()).toBeGreaterThan(0.9);
  const own = (await page.getByTestId('column-header').first().boundingBox())!;
  expect(own.y + own.height, "the headers' own bands are above the canvas").toBeLessThan((await canvas.boundingBox())!.y);
  await expect.poll(async () => await cells.allTextContents()).toContain('PA');
  await expectStripOnScreen();
  expect(errors).toEqual([]);
});

/** The drone-swarm model's operational layer in small: every step is done by one activity per member, and the two members' activities share a definition. */
function hubModel(): string {
  const each = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('\n    ');
  return `package Watch {
    part def Member;
    part memberA : Member;
    part memberB : Member;
    ${each(6, (i) => `use case def Case${i} { ref holder : Member; }`)}
    ${each(3, (i) => `requirement hazard${i} { ref holder : Member; }`)}
    ${each(8, (i) => `action def Step${i};`)}
    ${each(8, (i) => `action alpha${i} : Step${i};\n    action bravo${i} : Step${i};`)}
    ${each(8, (i) => `allocate alpha${i} to memberA;\n    allocate bravo${i} to memberB;`)}
    ${each(3, (i) => `satisfy hazard${i} by alpha${i};`)}
}
`;
}

test('the biggest hub that many dependency lines end on leads a one-layer General view, its lines running from the boxes that point at it', async ({ page }) => {
  const errors = captureErrors(page);
  await page.route('**/layered/Hub.sysml', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: hubModel() }));
  await page.goto('/?model=layered/Hub.sysml', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('diagram-canvas')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await current(page))?.nodes.length, { timeout: 60_000 }).toBe(45);
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(500);

  const d = (await page.evaluate(() =>
    (window as unknown as { sysprose: { diagram: { current: () => unknown } } }).sysprose.diagram.current(),
  )) as {
    nodes: { id: string; label: string; position: { x: number; y: number }; size: { w: number; h: number } }[];
    edges: { kind: string; source: string; target: string; route?: { x: number; y: number }[] }[];
  };
  const byLabel = (label: string) => d.nodes.find((n) => n.label === label)!;
  const onOutline = (p: { x: number; y: number }, n: (typeof d.nodes)[number]): boolean =>
    p.x >= n.position.x - 1 && p.x <= n.position.x + n.size.w + 1 && p.y >= n.position.y - 1 && p.y <= n.position.y + n.size.h + 1 &&
    (Math.abs(p.x - n.position.x) < 1 || Math.abs(p.x - n.position.x - n.size.w) < 1 || Math.abs(p.y - n.position.y) < 1 || Math.abs(p.y - n.position.y - n.size.h) < 1);

  // The two members take eight lines each, so only the first leads (letting both lead interleaves their fans): memberA sits
  // left of its eight activities and memberB right of its own, and every line still runs from its activity to its member.
  for (const [hub, who, leads] of [['memberA', 'alpha', true], ['memberB', 'bravo', false]] as const) {
    const h = byLabel(hub);
    for (let i = 0; i < 8; i += 1) {
      const a = byLabel(`${who}${i}`);
      if (leads) expect(a.position.x, `${who}${i} is right of ${hub}`).toBeGreaterThan(h.position.x + h.size.w);
      else expect(a.position.x + a.size.w, `${who}${i} is left of ${hub}`).toBeLessThan(h.position.x);
    }
    const lines = d.edges.filter((e) => e.kind === 'allocate' && e.target === h.id);
    expect(lines).toHaveLength(8);
    for (const e of lines) {
      const src = d.nodes.find((n) => n.id === e.source)!;
      expect(onOutline(e.route![0]!, src), `a ${who} line starts on its activity`).toBe(true);
      expect(onOutline(e.route![e.route!.length - 1]!, h), `a ${who} line ends on ${hub}`).toBe(true);
    }
  }
  await expectOrthogonalEdges(page);
  expect(errors).toEqual([]);
});

/**
 * Shared E2E helpers: app bootstrap, console-error capture, screenshots, and
 * model-aware tree navigation driven through the live `window.sysml` SDK.
 *
 * These keep the spec files terse and resilient: selection is performed by
 * expanding the element's ancestor chain (via the SDK) and clicking the tree
 * row carrying the matching `data-elementid`, rather than relying on fragile
 * label text or row indices.
 */

import { type Locator, type Page, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

export const SHOT_DIR = 'test-results/screenshots';

/** Minimal shape of an element record as returned by the SDK over the wire. */
export interface WireElement {
  id: string;
  eClass: string;
  declaredName?: string;
  declaredShortName?: string;
}

/** Attach console/page error listeners; returns the live error array. */
export function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  return errors;
}

/** Navigate to the app, wait for the sample model to mount + lay out. */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('explorer')).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  // The initial diagram is laid out asynchronously (elkjs); wait for a node.
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible' });
  // Wait for the SDK to be exposed on window.
  await page.waitForFunction(() => !!(window as unknown as { sysml?: unknown }).sysml);
}

/** Save a full-page screenshot under the screenshots dir. */
export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

/** Loosely-typed SDK surface used inside page.evaluate. */
export interface SysmlSdk {
  elementsOfType(...eClasses: string[]): WireElement[];
  ancestors(id: string): WireElement[];
  getElement(id: string): WireElement | undefined;
  children(id: string): WireElement[];
  roots(): WireElement[];
}

/** Find one element id by metaclass + (optional) declared name via the SDK. */
export async function findElementId(
  page: Page,
  eClass: string,
  name?: string,
): Promise<string> {
  const id = await page.evaluate(
    ({ eClass, name }) => {
      const api = (window as unknown as { sysml: SysmlSdk }).sysml;
      const hits = api.elementsOfType(eClass);
      const hit = name ? hits.find((e) => e.declaredName === name) : hits[0];
      return hit?.id ?? null;
    },
    { eClass, name },
  );
  if (!id) throw new Error(`No ${eClass}${name ? ` named "${name}"` : ''} found`);
  return id;
}

/**
 * Expand the element's ancestor chain (top-down) so its tree row is rendered,
 * then click the row to select it. Returns the element id.
 */
export async function selectElementById(page: Page, id: string): Promise<void> {
  // Ancestor chain comes back owner→root; reverse to expand from the root down.
  const ancestors = await page.evaluate((id) => {
    const api = (window as unknown as { sysml: SysmlSdk }).sysml;
    return api.ancestors(id).map((e) => e.id);
  }, id);
  const topDown = [...ancestors].reverse();

  for (const aid of topDown) {
    const twisty = page.locator(`[data-elementid="${aid}"] .tree-twisty`).first();
    if ((await twisty.count()) === 0) continue;
    const glyph = (await twisty.textContent())?.trim();
    if (glyph === '▸') await twisty.click();
  }

  const row = page.locator(`[data-elementid="${id}"]`).first();
  await row.waitFor({ state: 'visible' });
  await treeName(row).click();
}

/**
 * The name in a tree row — where a user clicks it. A row's centre is not safe:
 * in a narrow Explorer the row's action buttons (◎ ⊞ + ✎ ✕) reach it, and a
 * click there focuses or scopes instead of selecting.
 */
export function treeName(row: Locator): Locator {
  return row.locator('.tree-label').first();
}

/**
 * Wait until the diagram shows the model as it is now: no edit's recompute
 * still waiting, no layout running, and neither the boxes nor the viewport
 * moving. Layout runs in a worker, so on a slow machine it lands well after the
 * edit; a click aimed at a box before then can hit where the box used to be.
 */
export async function diagramSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !(window as unknown as { sysprose: { diagram: { busy: () => boolean } } }).sysprose.diagram.busy(),
  );
  let last = '';
  await expect
    .poll(
      async () => {
        const key = await page.evaluate(() =>
          [...document.querySelectorAll('.react-flow__node')]
            .map((n) => (n as HTMLElement).style.transform)
            .join(';'),
        );
        const same = key === last;
        last = key;
        return same;
      },
      { intervals: [200] },
    )
    .toBe(true);
  await viewportSettled(page);
}

/** The React Flow viewport transform (pan and zoom), as a string. */
export async function viewportTransform(page: Page): Promise<string> {
  return page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);
}

/**
 * Wait until the viewport has stopped moving: the same pan and zoom on two
 * polls 200 ms apart. A fit animates for 250 ms, and a box read during it is
 * already stale.
 */
export async function viewportSettled(page: Page): Promise<void> {
  let last: string | undefined;
  await expect
    .poll(
      async () => {
        const key = await viewportTransform(page);
        const same = key === last;
        last = key;
        return same;
      },
      { intervals: [200] },
    )
    .toBe(true);
}

/**
 * Make a canvas node clickable and return where to click it: a point relative
 * to its box, for `click({ position })`. The point is `aim` (the header
 * corner), clamped to the rendered box so that a zoomed-out header still
 * contains it. If the topmost element there is not this node, the whole
 * diagram is fitted first. That happens when the node lies outside React
 * Flow's clipped wrapper (an edit keeps the viewport, so a box the layout
 * pushed down stays below the fold) or under the Controls, MiniMap, Legend or
 * minibar.
 *
 * Never `force` a click on a canvas node. The wrapper is `overflow: hidden`
 * and React Flow scrolls it back to 0,0 on its next render. Playwright scrolls
 * the point into view before it clicks, and its retries 1–3 of 4 call an
 * unconditional `scrollIntoView`, so a click can scroll the wrapper even when
 * the node is visible. On a busy machine the mouse events then land after the
 * reset, on the pane or outside the canvas: an armed edge tool silently drops
 * its pending source, and an armed node tool never reaches the node.
 * Only Playwright's hit-target check, which `force` skips, makes that harmless:
 * it sees the event miss and retries. Dropping `force` is what fixes the race.
 * This reveal makes the click fast and deterministic, and puts the node in the
 * screenshot.
 *
 * Measured on diagram-create-connect, 8 runs beside 12 busy loops on 16 cores
 * (scripts/e2e-under-load.sh): with the forced header click 2 failed, one at
 * the Port click and one at the connect; revealed and unforced, 8 of 8 passed.
 */
export async function revealNode(
  page: Page,
  id: string,
  aim: { x: number; y: number } = { x: 8, y: 6 },
): Promise<{ x: number; y: number }> {
  // What is under the pointer at the aim point: `node <id>` when it is this
  // node, otherwise the element found there and the point, for the failure.
  const probe = () =>
    page.evaluate(
      ({ id, aim }) => {
        const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);
        if (!node) return { x: 0, y: 0, top: 'no such node' };
        const box = node.getBoundingClientRect();
        const x = Math.min(aim.x, box.width / 4);
        const y = Math.min(aim.y, box.height / 3);
        const px = Math.round(box.left + x);
        const py = Math.round(box.top + y);
        const el = document.elementFromPoint(box.left + x, box.top + y);
        const hit = el?.closest<HTMLElement>('.react-flow__node[data-id]')?.dataset.id;
        const what = !el
          ? 'nothing (off-screen)'
          : hit
            ? `node ${hit}`
            : `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''}`;
        return { x, y, top: hit === id ? `node ${id}` : `${what} at (${px}, ${py})` };
      },
      { id, aim },
    );
  let p = await probe();
  if (p.top === `node ${id}`) return { x: p.x, y: p.y };
  // Wait for the fit to start before waiting for it to stop: on a loaded
  // machine the transition can begin after viewportSettled's second read, which
  // would then report the old viewport as settled — harmless for a locator
  // click, which waits for a stable target, but not for a raw page.mouse.click.
  // A fit that changes nothing (already fitted) moves nothing; give up after 2 s.
  const before = await viewportTransform(page);
  await page.getByTestId('diagram-fit').click();
  for (let waited = 0; waited < 2000 && (await viewportTransform(page)) === before; waited += 50) {
    await page.waitForTimeout(50);
  }
  await viewportSettled(page);
  await expect
    .poll(
      async () => {
        p = await probe();
        return p.top;
      },
      { message: `node ${id} should be under the pointer at its header (${aim.x}, ${aim.y}) after a fit` },
    )
    .toBe(`node ${id}`);
  return { x: p.x, y: p.y };
}

/** Open a bottom-panel tab by its data-testid. */
export async function openTab(page: Page, testid: string): Promise<void> {
  await page.getByTestId(testid).click();
}

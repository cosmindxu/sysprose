/**
 * Shared E2E helpers: app bootstrap, console-error capture, screenshots, and
 * model-aware tree navigation driven through the live `window.sysml` SDK.
 *
 * These keep the spec files terse and resilient: selection is performed by
 * expanding the element's ancestor chain (via the SDK) and clicking the tree
 * row carrying the matching `data-elementid`, rather than relying on fragile
 * label text or row indices.
 */

import { type Page, expect } from '@playwright/test';
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
  await row.click();
}

/** Open a bottom-panel tab by its data-testid. */
export async function openTab(page: Page, testid: string): Promise<void> {
  await page.getByTestId(testid).click();
}

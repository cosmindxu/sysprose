/**
 * Scenario — real-time multi-user collaboration (Yjs CRDT + presence).
 *
 * Opens TWO independent browser contexts at the SAME room (via
 * `?room=<r>&collabUrl=ws://localhost:1234`, both auto-connecting on load) and
 * verifies genuine cross-client behaviour over the live y-websocket relay
 * (`npm run collab`, started by playwright.config.ts's webServer array):
 *
 *   1. both clients report a live connection + see each other in presence
 *      (each roster shows >= 2 participants: self + the remote peer);
 *   2. an element CREATED in page1 converges into page2's model + Explorer;
 *   3. a SELECTION made in page1 lights up as a remote-selection highlight on
 *      page2's Explorer row (peer colour ring).
 *
 * Presence/awareness is lightweight and reliable; whole-model CRDT sync (both
 * clients also carry the full standard library) is heavier, so the convergence
 * assertions use tolerant timeouts. If a future headless environment cannot run
 * two synced ws contexts, the deterministic unit convergence tests
 * (`test/unit/collab.binding.test.ts`) remain the primary proof and the
 * single-page connect + self-presence assertions below still hold.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { captureErrors, shot } from './fixtures';

/** Loosely-typed SDK surface used inside page.evaluate. */
interface SysmlSdk {
  create(eClass: string, opts: { declaredName?: string; ownerId?: string | null }): { id: string };
  getElement(id: string): { id: string; declaredName?: string } | undefined;
  elementsOfType(...eClasses: string[]): { id: string; declaredName?: string }[];
}

/** A generous timeout for cross-client CRDT convergence over the relay. */
const SYNC = 60_000;

/** Navigate a page to the app joined to `room`, waiting for boot + auto-connect. */
async function gotoRoom(page: Page, room: string): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(room)}&collabUrl=ws://localhost:1234`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByTestId('explorer')).toBeVisible();
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => !!(window as unknown as { sysml?: unknown }).sysml);
}

/** Open the Collaborate popover and wait for the status line to read "Connected". */
async function openCollabConnected(page: Page): Promise<void> {
  await page.getByTestId('tb-collab').click();
  await expect(page.getByTestId('collab-panel')).toBeVisible();
  await expect(page.getByTestId('collab-status')).toHaveAttribute('data-connected', 'true', {
    timeout: SYNC,
  });
}

test('two users collaborate: presence + element convergence + remote-selection highlight', async ({
  browser,
}) => {
  // Two heavy contexts + whole-model CRDT sync (both carry the full standard
  // library) need well beyond the default per-test budget.
  test.setTimeout(240_000);
  const room = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const ctx1: BrowserContext = await browser.newContext();
  const ctx2: BrowserContext = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();
  const errors1 = captureErrors(page1);
  const errors2 = captureErrors(page2);

  try {
    await gotoRoom(page1, room);
    await gotoRoom(page2, room);

    // ── 1) Both clients connect and see each other in presence ──────────────
    await openCollabConnected(page1);
    await openCollabConnected(page2);

    // Each roster shows self + the remote peer → >= 2 participants.
    await expect
      .poll(() => page1.getByTestId('collab-peer').count(), { timeout: SYNC })
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => page2.getByTestId('collab-peer').count(), { timeout: SYNC })
      .toBeGreaterThanOrEqual(2);

    await shot(page1, 'collab-1a-page1-presence');
    await shot(page2, 'collab-1b-page2-presence');

    // ── 2) An element created in page1 converges into page2 ─────────────────
    const probeName = `CollabProbe-${Math.floor(Math.random() * 1e6)}`;
    const newId = await page1.evaluate((name) => {
      const api = (window as unknown as { sysml: SysmlSdk }).sysml;
      // Create at ROOT so it lands cleanly in every peer (no dependency on the
      // creator's random-id owners) and is a top-level Explorer row everywhere.
      return api.create('Package', { declaredName: name, ownerId: null }).id;
    }, probeName);

    // The CRDT replicates it into page2's model (proves doc-level convergence).
    await expect
      .poll(
        () =>
          page2.evaluate(
            (id) => !!(window as unknown as { sysml: SysmlSdk }).sysml.getElement(id),
            newId,
          ),
        { timeout: SYNC },
      )
      .toBe(true);

    // And it shows up in page2's Explorer as a row (new root element).
    const page2Row = page2.locator(`[data-elementid="${newId}"]`).first();
    await expect(page2Row).toBeVisible({ timeout: SYNC });
    await expect(page2Row).toContainText(probeName);

    await shot(page2, 'collab-2-page2-converged');

    // ── 3) A selection in page1 highlights on page2's Explorer row ──────────
    // page1's model gained the element too (its own local create); select it to
    // publish the selection over awareness.
    const page1Row = page1.locator(`[data-elementid="${newId}"]`).first();
    await expect(page1Row).toBeVisible({ timeout: SYNC });
    await page1Row.click();

    // page2 renders the remote-selection ring (peer colour) on that row.
    await expect(page2Row).toHaveAttribute('data-remote-selected', /.+/, { timeout: SYNC });
    await expect(
      page2.locator(`[data-elementid="${newId}"] [data-testid="tree-remote-selection"]`).first(),
    ).toBeVisible({ timeout: SYNC });

    await shot(page2, 'collab-3-page2-remote-selection');

    // ── 0 uncaught console errors across the whole two-user session ──────────
    expect(errors1, `page1 console errors:\n${errors1.join('\n')}`).toEqual([]);
    expect(errors2, `page2 console errors:\n${errors2.join('\n')}`).toEqual([]);
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});

test('single page connects and shows self in presence (deterministic fallback)', async ({
  page,
}) => {
  const errors = captureErrors(page);
  const room = `e2e-solo-${Date.now()}`;
  await gotoRoom(page, room);

  await page.getByTestId('tb-collab').click();
  await expect(page.getByTestId('collab-panel')).toBeVisible();
  await expect(page.getByTestId('collab-status')).toHaveAttribute('data-connected', 'true', {
    timeout: SYNC,
  });

  // At minimum the local client is present in the roster (self row).
  await expect(page.getByTestId('collab-peer').first()).toBeVisible();
  await expect(page.locator('[data-testid="collab-peer"][data-self="true"]')).toBeVisible();

  // Disconnect tears the session down and clears the connected flag.
  await page.getByTestId('collab-disconnect').click();
  await expect(page.getByTestId('collab-status')).toHaveAttribute('data-connected', 'false');

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

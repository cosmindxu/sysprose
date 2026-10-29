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
 *      page2's Explorer row (peer colour ring);
 *   4. a room over a model of the drone-swarm example's size (a first message
 *      over the relay's old 10 MiB cap) syncs between two pages, and a message
 *      over the relay's cap closes only its own connection;
 *   5. two elements each moved into the other at once are held alike by both
 *      pages and a page that joins.
 *
 * Presence/awareness is lightweight and reliable; whole-model CRDT sync (both
 * clients also carry the full standard library) is heavier, so the convergence
 * assertions use tolerant timeouts. If a future headless environment cannot run
 * two synced ws contexts, the deterministic unit convergence tests
 * (`test/unit/collab.binding.test.ts`) remain the primary proof and the
 * single-page connect + self-presence assertions below still hold.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { captureErrors, shot, treeName } from './fixtures';

/** Loosely-typed SDK surface used inside page.evaluate. */
interface SysmlSdk {
  create(
    eClass: string,
    opts: { id?: string; declaredName?: string; ownerId?: string | null; attrs?: Record<string, unknown> },
  ): { id: string };
  getElement(id: string): { id: string; declaredName?: string; ownerId: string | null } | undefined;
  elementsOfType(...eClasses: string[]): { id: string; declaredName?: string }[];
  libraryElementCount(): number;
  reparent(id: string, ownerId: string | null): unknown;
  roots(): { id: string }[];
}

/** A generous timeout for cross-client CRDT convergence over the relay. */
const SYNC = 60_000;

const RELAY = 'ws://localhost:1234';
const MIB = 1024 * 1024;
/** The relay's cap on one message (`scripts/collab-server.ts`). */
const RELAY_CAP = 64 * MIB;

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
    await treeName(page1Row).click();

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

/**
 * The bytes the relay sends a client that asks for a room's whole document: what a
 * peer's first message weighs, as the relay holds it.
 */
function relayDocBytes(room: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${RELAY}/${encodeURIComponent(room)}`);
    const timer = setTimeout(() => reject(new Error('the relay sent no document')), 30_000);
    ws.on('error', reject);
    ws.on('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0); // messageSync
      syncProtocol.writeSyncStep1(enc, new Y.Doc());
      ws.send(encoding.toUint8Array(enc));
    });
    ws.on('message', (data: Buffer) => {
      // The relay opens with its own SyncStep1 (tag 0, 0); the reply to ours is SyncStep2 (0, 1).
      if (data[0] === 0 && data[1] === 1) {
        clearTimeout(timer);
        ws.close();
        resolve(data.byteLength);
      }
    });
  });
}

test('a room over a model of the drone-swarm example\'s size syncs between two pages', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = `e2e-big-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();
  const errors1 = captureErrors(page1);
  const errors2 = captureErrors(page2);
  try {
    // Page 1 holds the model before it joins: the sample, the standard library, and about 3 MB of
    // elements more — the room's document, which its first message carries, passes 10 MiB.
    await page1.goto(`/?collabUrl=${encodeURIComponent(RELAY)}`, { waitUntil: 'domcontentloaded' });
    await expect(page1.getByTestId('explorer')).toBeVisible();
    await page1.waitForFunction(() => !!(window as unknown as { sysml?: unknown }).sysml);
    await page1.waitForFunction(() => (window as unknown as { sysml: SysmlSdk }).sysml.libraryElementCount() > 0);
    const last = await page1.evaluate(() => {
      const api = (window as unknown as { sysml: SysmlSdk }).sysml;
      const pkg = api.create('Package', { declaredName: 'BulkModel', ownerId: null });
      let id = pkg.id;
      for (let i = 0; i < 700; i++) {
        id = api.create('PartUsage', { declaredName: `bulk${i}`, ownerId: pkg.id, attrs: { note: `${i} `.padEnd(4096, 'x') } }).id;
      }
      return id;
    });
    await page1.getByTestId('tb-collab').click();
    await page1.getByTestId('collab-room').fill(room);
    await page1.getByTestId('collab-connect').click();
    // The model has work no save holds: join without saving.
    const join = page1.getByTestId('guard-discard');
    if (await join.isVisible({ timeout: 3_000 }).catch(() => false)) await join.click();
    // The click on the strip closes the panel: open it to read the status.
    if (!(await page1.getByTestId('collab-panel').isVisible())) await page1.getByTestId('tb-collab').click();
    await expect(page1.getByTestId('collab-status')).toHaveAttribute('data-connected', 'true', { timeout: SYNC });

    // The relay holds it all, and the document is over the old cap.
    await expect
      .poll(() => relayDocBytes(room), { timeout: SYNC, message: 'the relay holds the room' })
      .toBeGreaterThan(10 * MIB);
    expect(await relayDocBytes(room)).toBeLessThan(RELAY_CAP);

    // A second page joins the room and takes the model in.
    await gotoRoom(page2, room);
    await openCollabConnected(page2);
    await expect
      .poll(
        () => page2.evaluate((id) => !!(window as unknown as { sysml: SysmlSdk }).sysml.getElement(id), last),
        { timeout: SYNC },
      )
      .toBe(true);
    // The relay is still up, and so is page 1's connection to it.
    await expect(page1.getByTestId('collab-status')).toHaveAttribute('data-connected', 'true');
    expect(errors1, `page1 console errors:\n${errors1.join('\n')}`).toEqual([]);
    expect(errors2, `page2 console errors:\n${errors2.join('\n')}`).toEqual([]);
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});

test('a message over the relay\'s cap closes its own connection, not the relay or another room', async () => {
  test.setTimeout(120_000);
  const room = `e2e-cap-${Date.now()}`;
  const open = (name: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`${RELAY}/${name}`);
      ws.on('error', reject);
      ws.on('open', () => resolve(ws));
    });
  const sender = await open(room);
  const bystander = await open(room);
  const other = await open(`${room}-other`);
  try {
    let bystanderClosed = false;
    let otherClosed = false;
    bystander.on('close', () => (bystanderClosed = true));
    other.on('close', () => (otherClosed = true));
    const closed = new Promise<number>((resolve) => sender.on('close', (code) => resolve(code)));
    sender.on('error', () => undefined);
    sender.send(Buffer.alloc(RELAY_CAP + 1));
    expect(await closed, 'the sender is closed for the size (1009)').toBe(1009);
    await new Promise((r) => setTimeout(r, 500));
    // Everyone else is still connected, and the relay answers a new connection.
    expect([bystanderClosed, otherClosed, bystander.readyState, other.readyState]).toEqual([false, false, WebSocket.OPEN, WebSocket.OPEN]);
    expect((await fetch('http://localhost:1234/')).status).toBe(200);
    const fresh = await open(room);
    fresh.close();
  } finally {
    for (const ws of [sender, bystander, other]) ws.terminate();
  }
});

/**
 * Hold a page's traffic with the relay, both ways, while `held` is set — a page that is cut off and
 * edits — and send what waited on `release`. Set up before the page loads.
 */
async function cuttable(page: Page): Promise<{ hold(): void; release(): void }> {
  let held = false;
  const toServer: Array<string | Buffer> = [];
  const toPage: Array<string | Buffer> = [];
  let flush = (): void => undefined;
  await page.routeWebSocket(/localhost:1234/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => (held ? toServer.push(m) : server.send(m)));
    server.onMessage((m) => (held ? toPage.push(m) : ws.send(m)));
    flush = () => {
      for (const m of toServer.splice(0)) server.send(m);
      for (const m of toPage.splice(0)) ws.send(m);
    };
  });
  return {
    hold: () => (held = true),
    release: () => {
      held = false;
      flush();
    },
  };
}

test('two peers who each move one of two elements into the other at once, and a page that joins, hold the pair alike', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const room = `e2e-cycle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const tag = `cyc${Date.now()}`;
  // The lower id: the one the room puts at the top level.
  const [x, y] = [`${tag}-a`, `${tag}-b`];
  const ctxs: BrowserContext[] = [];
  const open = async (): Promise<Page> => {
    const ctx = await browser.newContext();
    ctxs.push(ctx);
    return ctx.newPage();
  };
  const owners = (page: Page): Promise<Array<string | null | undefined>> =>
    page.evaluate(
      ([a, b]) => {
        const api = (window as unknown as { sysml: SysmlSdk }).sysml;
        return [api.getElement(a)?.ownerId, api.getElement(b)?.ownerId];
      },
      [x, y],
    );
  try {
    const page1 = await open();
    const page2 = await open();
    const errors = [captureErrors(page1), captureErrors(page2)];
    const cut1 = await cuttable(page1);
    const cut2 = await cuttable(page2);
    await gotoRoom(page1, room);
    await gotoRoom(page2, room);
    await openCollabConnected(page1);
    await openCollabConnected(page2);

    await page1.evaluate(
      ([a, b]) => {
        const api = (window as unknown as { sysml: SysmlSdk }).sysml;
        api.create('Package', { id: a, declaredName: 'CycleA', ownerId: null });
        api.create('Package', { id: b, declaredName: 'CycleB', ownerId: null });
      },
      [x, y],
    );
    await expect.poll(() => owners(page2), { timeout: SYNC }).toEqual([null, null]);

    // Both pages move one into the other before either hears of the other's move.
    cut1.hold();
    cut2.hold();
    await page1.evaluate(([a, b]) => (window as unknown as { sysml: SysmlSdk }).sysml.reparent(a, b), [x, y]);
    await page2.evaluate(([a, b]) => (window as unknown as { sysml: SysmlSdk }).sysml.reparent(b, a), [x, y]);
    expect(await owners(page1)).toEqual([y, null]);
    expect(await owners(page2)).toEqual([null, x]);
    cut1.release();
    cut2.release();

    // Both end with the lower id at the top level and the other under it, and so does a page that joins.
    const page3 = await open();
    errors.push(captureErrors(page3));
    await gotoRoom(page3, room);
    for (const page of [page1, page2, page3]) {
      await expect.poll(() => owners(page), { timeout: SYNC }).toEqual([null, x]);
      const roots = await page.evaluate(() => (window as unknown as { sysml: SysmlSdk }).sysml.roots().map((r) => r.id));
      expect(roots).toContain(x);
      expect(roots).not.toContain(y);
      await expect(page.locator(`[data-elementid="${x}"]`).first()).toBeVisible({ timeout: SYNC });
    }
    for (const [i, e] of errors.entries()) expect(e, `page${i + 1} console errors:\n${e.join('\n')}`).toEqual([]);
  } finally {
    for (const ctx of ctxs) await ctx.close();
  }
});

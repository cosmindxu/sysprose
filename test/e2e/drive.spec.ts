/**
 * Scenario — Google Drive (optional), against faked Google surfaces
 * (`drive-fakes.ts`; nothing here reaches Google).
 *
 * THE SERVICE WORKER IS BLOCKED in this spec. The production worker claims the
 * page as soon as it activates (`clients.claim()`, vite.config.ts) and answers
 * every same-origin GET itself, so after the first load — on every reload and
 * every second `goto` — `./drive.json` is fetched BY THE WORKER, and
 * `page.route` never sees that request: the app would read the preview's
 * placeholder and a routed configuration would vanish mid-spec. Playwright's
 * `'block'` replaces `navigator.serviceWorker.register` with a stub that only
 * warns, so the app's own registration (src/main.tsx) quietly does nothing and
 * no console error results. Per spec only: `gui-pwa.spec.ts` keeps asserting
 * that the worker activates, and a worker-served `drive.json` in production is
 * a manual check, not a CI one.
 *
 * What the fakes prove is the app's side of the contract with Google, as
 * Google documents it: the requests it makes, what it does with every answer,
 * and that the page's CSP admits each URL the fakes answer (a refused one is a
 * console error, which fails the test). The consent popup, real token
 * lifetimes, `drive.file` sharing, the Picker's iframe, the revocation's real
 * answer and Google's CORS preflights (Playwright answers each preflight
 * itself, allowing anything) are the manual check's (plan F.4), not CI's.
 *
 * The edits here are a user's — a part definition renamed in the Explorer,
 * text typed in the Text view — and, once, an agent's through `window.sysml`,
 * because Save, Ctrl/Cmd+S and Ctrl/Cmd+Shift+S send nothing to an attached
 * file that already holds the model. Every test fails on a console error,
 * less the "Failed to load resource" line Chromium logs for each 4xx/5xx a
 * fake Google answers on purpose.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { captureErrors, commandsUnderMore, findElementId, gotoApp, openTab } from './fixtures';
import { hasNamed, modelSize, renameInTree } from './model-helpers';
import {
  FAKE_ACCOUNT,
  FAKE_CONFIG,
  FAKE_FILE_ID,
  FAKE_PICKER_CONFIG,
  installDriveFakes,
  type DriveFakeOptions,
  type DriveFakes,
} from './drive-fakes';
import { DRIVE_API_ORIGIN, DRIVE_SCRIPTS } from '../../src/persistence/drive/hosts';

test.use({ serviceWorkers: 'block' });

/** The attached file, as `window.sysprose.drive.file()` shows it. */
interface DriveFileView {
  id: string;
  name: string;
  md5Checksum?: string;
  headRevisionId?: string;
  resourceKey?: string;
  openedFrom: string;
  rewrites: boolean;
  trashed: boolean;
  canEdit: boolean;
}

/** The Drive surface the app puts on `window.sysprose` (absent until the library settles). */
type DriveWindow = {
  sysprose?: {
    drive?: { status(): string; file(): DriveFileView | null; dirty(): boolean; link(): string | null };
  };
};

/** A model as this app writes it. */
const SWARM = 'package Swarm {\n    part def Drone;\n}\n';
/** The same model written by hand: a `//` comment and trailing blanks, which this app's layout drops. */
const HAND = 'package Swarm {\n    // the airframe\n    part def Drone;  \n}\n';
/** A model with a syntax error (`blok`). */
const FAULTED = 'package Faulted {\n    part def Drone;\n    blok bad;\n}\n';
/**
 * {@link SWARM} as a model JSON snapshot: the shape of Export ▾ → JSON (`formatVersion`, `elements`,
 * `rootIds`), without the library.
 */
const SWARM_JSON = JSON.stringify({
  formatVersion: '0.1.0',
  elements: [
    { id: 'json-swarm', eClass: 'Package', declaredName: 'Swarm', ownerId: null, attrs: {} },
    { id: 'json-drone', eClass: 'PartDefinition', declaredName: 'Drone', ownerId: 'json-swarm', attrs: {} },
  ],
  rootIds: ['json-swarm'],
});

/**
 * Collect console and page errors — less Chromium's "Failed to load resource:
 * the server responded with a status of …" for a fake Google API's 4xx/5xx,
 * which these tests provoke on purpose. A load that never got an answer (an
 * aborted one, a CSP refusal) is still collected.
 */
function driveErrors(page: Page): string[] {
  return captureErrors(page, {
    ignore: (m) =>
      /^Failed to load resource: the server responded with a status of \d{3}\b/.test(m.text()) &&
      /^https:\/\/([a-z0-9-]+\.)*googleapis\.com\//.test(m.location().url),
  });
}

/** Configured with the fakes, the sample model open; the fakes. */
async function configured(page: Page, opts: DriveFakeOptions = {}): Promise<DriveFakes> {
  const fakes = await installDriveFakes(page, { config: FAKE_CONFIG, ...opts });
  await gotoApp(page);
  expect(await driveStatus(page)).toBe('ready');
  return fakes;
}

/** The Drive strip under the toolbar. */
function strip(page: Page): Locator {
  return page.getByTestId('drive-strip');
}

/** Open the Drive ▾ panel (if it is not open). */
async function openPanel(page: Page): Promise<void> {
  const panel = page.getByTestId('drive-panel');
  if (!(await panel.isVisible())) await page.getByTestId('tb-drive').click();
  await expect(panel).toBeVisible();
}

/** Close the Drive ▾ panel (if it is open). */
async function closePanel(page: Page): Promise<void> {
  const panel = page.getByTestId('drive-panel');
  if (await panel.isVisible()) await page.getByTestId('tb-drive').click();
  await expect(panel).toHaveCount(0);
}

/** Drive ▾ → Sign in to Google…, once Google's script is there; the panel is closed after. */
async function signIn(page: Page): Promise<void> {
  await openPanel(page);
  const button = page.getByTestId('tb-drive-signin');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId('drive-account')).toHaveText(`Signed in as ${FAKE_ACCOUNT.email}`);
  await closePanel(page);
}

/** Drive ▾ → Save to Drive as… `name` → Save; the new file's id. */
async function saveAs(page: Page, name: string): Promise<string> {
  await openPanel(page);
  await page.getByTestId('tb-drive-save-as').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'saveas');
  await page.getByTestId('drive-saveas-name').fill(name);
  await page.getByTestId('drive-saveas-confirm').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  const file = await driveFile(page);
  if (file === null) throw new Error('Save to Drive as… attached no file');
  return file.id;
}

/** Drive ▾ → Recent → the file `id`. */
async function openRecent(page: Page, id: string): Promise<void> {
  await openPanel(page);
  await page.locator(`[data-testid="drive-recent-item"][data-id="${id}"]`).click();
}

/** An edit as a user makes one: part definition `from` renamed `to` in the Explorer. */
async function rename(page: Page, from: string, to: string): Promise<void> {
  await renameInTree(page, await findElementId(page, 'PartDefinition', from), to);
}

/** The strip's Save to Drive, once it says there are unsaved changes. */
async function saveFromStrip(page: Page): Promise<void> {
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  await page.getByTestId('drive-strip-save').click();
}

/** New, from the bar — or from More ▾ when the bar is too narrow for it (same test id). */
async function clickNew(page: Page): Promise<void> {
  const onBar = page.getByTestId('tb-new');
  if (await onBar.isVisible()) {
    await onBar.click();
    return;
  }
  await page.getByTestId('tb-more').click();
  await page.getByTestId('tb-more-menu').getByTestId('tb-new').click();
}

async function driveFile(page: Page): Promise<DriveFileView | null> {
  return page.evaluate(() => (window as unknown as DriveWindow).sysprose?.drive?.file() ?? null);
}

async function driveLink(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as DriveWindow).sysprose?.drive?.link() ?? null);
}

/** The Text view's text (the Text tab is opened for it). */
async function textView(page: Page): Promise<string> {
  await openTab(page, 'tab-text');
  return page.getByTestId('text-editor').inputValue();
}

/** `text` with exactly one final newline: what a save writes. */
function withFinalNewline(text: string): string {
  return text.replace(/\n*$/, '\n');
}

/**
 * Every record this page keeps in browser storage — each key of localStorage
 * and sessionStorage, each record of every object store of every IndexedDB
 * database — with which of `needles` its value holds, as JSON.
 */
async function storedRecords(page: Page, needles: string[]): Promise<Array<{ where: string; holds: string[] }>> {
  return page.evaluate(async (needles) => {
    const records: Array<{ where: string; holds: string[] }> = [];
    const add = (where: string, value: unknown) => {
      const json = JSON.stringify(value) ?? '';
      records.push({ where, holds: needles.filter((needle) => json.includes(needle)) });
    };
    for (const [area, storage] of [
      ['localStorage', localStorage],
      ['sessionStorage', sessionStorage],
    ] as const) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i) ?? '';
        add(`${area} ${key}`, storage.getItem(key));
      }
    }
    const done = <T>(req: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    for (const { name } of await indexedDB.databases()) {
      if (name === undefined) continue;
      const db = await done(indexedDB.open(name));
      for (const storeName of Array.from(db.objectStoreNames)) {
        const store = db.transaction(storeName, 'readonly').objectStore(storeName);
        const [keys, values] = await Promise.all([done(store.getAllKeys()), done(store.getAll())]);
        keys.forEach((key, i) => add(`indexedDB ${name}/${storeName} ${String(key)}`, values[i]));
      }
      db.close();
    }
    return records;
  }, needles);
}

/** Which of `needles` the project `name` saved in this browser (Save, Open ▾) holds; null when none is saved. */
async function browserProjectHolds(page: Page, name: string, needles: string[]): Promise<string[] | null> {
  const record = (await storedRecords(page, needles)).find((r) => r.where.endsWith(`/projects ${name}`));
  return record?.holds ?? null;
}

/** Whether leaving the page now would ask first: a cancelable `beforeunload`, prevented or not. */
async function leavingAsks(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
}

/** What `window.sysprose.drive.status()` says once the boot has read drive.json. */
async function driveStatus(page: Page): Promise<string> {
  const handle = await page.waitForFunction(() => {
    const status = (window as unknown as DriveWindow).sysprose?.drive?.status();
    return status !== undefined && status !== 'loading' ? status : null;
  });
  return (await handle.jsonValue()) as string;
}

/** Wait until the app has left its loading gate and the SDK is up. */
async function appReady(page: Page): Promise<void> {
  await expect(page.getByTestId('diagram-canvas')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => !!(window as unknown as { sysml?: unknown }).sysml);
}

async function rootNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { sysml: { roots(): { declaredName?: string }[] } }).sysml
      .roots()
      .map((r) => r.declaredName ?? ''),
  );
}

test('without a configuration nothing changes, and nothing is asked of Google', async ({ page }) => {
  const errors = captureErrors(page);
  const fakes = await installDriveFakes(page); // no route: the preview serves the build's file
  await gotoApp(page);
  expect(await driveStatus(page)).toBe('absent');
  await expect(page.getByTestId('tb-drive')).toHaveCount(0);

  // The build ships the disabled placeholder, served as JSON.
  const res = await page.request.get('/drive.json');
  expect(res.ok()).toBe(true);
  expect(res.headers()['content-type']).toMatch(/json/);
  expect(await res.json()).toEqual({
    $comment: 'Google Drive is off. A deployment enables it by replacing this file; see README, Deploy.',
  });

  expect(fakes.googleRequests).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a routed configuration reads as ready — on a reload too, the worker being blocked', async ({
  page,
}) => {
  const errors = captureErrors(page);
  const fakes = await installDriveFakes(page, { config: FAKE_CONFIG });
  await gotoApp(page);
  expect(await driveStatus(page)).toBe('ready');

  // The reload is what a live worker would answer itself, out of page.route's
  // sight; blocked, the page has no controller and the route still answers.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await appReady(page);
  expect(await driveStatus(page)).toBe('ready');
  expect(await page.evaluate(() => !navigator.serviceWorker?.controller)).toBe(true);

  // The toolbar shows Drive ▾, signed out; its panel is not open.
  await expect(page.getByTestId('tb-drive')).toBeVisible();
  await expect(page.getByTestId('tb-drive')).toHaveAttribute('data-status', 'signed-out');
  await expect(page.getByTestId('drive-panel')).toHaveCount(0);

  // A configured site still asks nothing of Google until the user does.
  expect(fakes.googleRequests).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('an HTML answer for drive.json — a server’s SPA fallback — is no configuration', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await installDriveFakes(page);
  await page.route('**/drive.json', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Sysprose</title>' }),
  );
  await gotoApp(page);
  expect(await driveStatus(page)).toBe('absent');
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a ?drive= link on a deployment without Drive opens the sample model', async ({ page }) => {
  const errors = captureErrors(page);
  const fakes = await installDriveFakes(page);
  await page.goto(`/?drive=${FAKE_FILE_ID}`, { waitUntil: 'domcontentloaded' });
  await appReady(page);
  expect(await driveStatus(page)).toBe('absent');
  expect(await rootNames(page)).toEqual(['VehicleModel']);
  // The strip says why the link's file is not what is open — the one thing
  // Drive shows on a deployment without it — and goes when dismissed.
  const strip = page.getByTestId('drive-strip');
  await expect(strip).toHaveAttribute('data-status', 'link-unsupported');
  await expect(strip).toHaveText(
    /^This link names a Google Drive file, but this deployment has no Google Drive support\./,
  );
  await page.getByTestId('drive-strip-dismiss').click();
  await expect(strip).toHaveCount(0);
  expect(fakes.googleRequests).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a ?drive= link on a configured deployment holds the loading gate for the file', async ({
  page,
}) => {
  const errors = captureErrors(page);
  const fakes = await installDriveFakes(page, { config: FAKE_CONFIG });
  await page.goto(`/?drive=${FAKE_FILE_ID}&model=linked/Ignored.sysml`, { waitUntil: 'domcontentloaded' });
  const gate = page.getByTestId('drive-link-gate');
  await expect(gate).toContainText('This link opens a file from Google Drive.', { timeout: 60_000 });
  await expect(gate).toHaveAttribute('data-status', 'pending');
  expect(await driveStatus(page)).toBe('ready');
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  // ?drive= won: the ?model= file was never asked for.
  const asked = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
  expect(asked.filter((url) => url.includes('Ignored.sysml'))).toEqual([]);
  // The link starts loading Google's sign-in script before any click — the
  // gate's sign-in must open its window inside the click — and asks Google
  // for nothing else: no token was requested.
  await expect.poll(() => fakes.googleRequests).toEqual([DRIVE_SCRIPTS.gis]);
  expect(
    await page.evaluate(
      () => (window as unknown as { __fakeGoogle?: { requests: unknown[] } }).__fakeGoogle?.requests ?? null,
    ),
  ).toEqual([]);
  // With the script there, the gate's one click may sign in.
  await expect(page.getByTestId('drive-link-signin')).toBeEnabled();
  await expect(page.getByTestId('drive-link-signin')).toHaveText('Sign in and open');

  // Skip: the sample model, and nothing about the link left behind.
  await page.getByTestId('drive-link-skip').click();
  await appReady(page);
  expect(await rootNames(page)).toEqual(['VehicleModel']);
  await expect(page.getByTestId('drive-strip')).toHaveCount(0);
  await expect(page.getByTestId('linked-banner')).toHaveCount(0);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('the fake Drive is as strict as Drive about an upload’s framing: bare line feeds are refused', async ({
  page,
}) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  await signIn(page);
  // The same upload framed with bare LF, then with CRLF: the fake that takes
  // this app's saves refuses the first, so a save that went through was
  // framed as RFC 2046 and Drive's own example have it.
  const upload = (eol: string): Promise<number> =>
    page.evaluate(
      async ({ eol, token, url }) => {
        const b = 'fake_boundary_0123456789';
        const body = [
          `--${b}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          JSON.stringify({ name: 'Framed.sysml', mimeType: 'text/plain' }),
          `--${b}`,
          'Content-Type: text/plain; charset=UTF-8',
          '',
          'package Framed {\n    part def Drone;\n}\n',
          `--${b}--`,
          '',
        ].join(eol);
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${b}` },
          body,
        });
        return res.status;
      },
      { eol, token: fakes.issued[0], url: `${DRIVE_API_ORIGIN}/upload/drive/v3/files?uploadType=multipart` },
    );
  expect(await upload('\n')).toBe(400);
  expect(fakes.files()).toEqual([]);
  expect(await upload('\r\n')).toBe(200);
  expect(fakes.files().map((f) => [f.name, f.body])).toEqual([
    // The text's own line feeds are content, and kept; the CRLF before the
    // closing delimiter belongs to the delimiter.
    ['Framed.sysml', 'package Framed {\n    part def Drone;\n}\n'],
  ]);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('sign in, save as, edit and save — from the panel, the strip, the toolbar’s Save and both keys', async ({
  page,
}) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  const tbDrive = page.getByTestId('tb-drive');

  // Drive ▾ → Sign in: Google's account chooser, asked for inside the click's
  // own handler (no `await` before it, which a stricter browser would punish
  // by blocking the window).
  await openPanel(page);
  await expect(page.getByTestId('drive-account')).toHaveText('Not signed in');
  await signIn(page);
  await expect(tbDrive).toHaveAttribute('data-status', 'signed-in');
  expect(fakes.tokenRequests).toEqual([
    {
      prompt: 'select_account',
      login_hint: null,
      activated: true,
      inEvent: 'click',
      answer: 'grant',
      token: 'fake-token-1',
    },
  ]);

  // Save to Drive as…: the form, prefilled from the project's name.
  await openPanel(page);
  await page.getByTestId('tb-drive-save-as').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'saveas');
  await expect(page.getByTestId('drive-saveas-name')).toHaveValue('VehicleModel.sysml');
  await page.getByTestId('drive-saveas-name').fill('DriveSpec');
  await page.getByTestId('drive-saveas-confirm').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  await expect(strip(page)).toContainText('DriveSpec.sysml · saved to your Google Drive at');
  await expect(tbDrive).toHaveAttribute('data-file', 'DriveSpec.sysml');

  // What went to Drive is the Text view's text: the user's model, never the
  // standard library merged into it.
  const [saved] = fakes.files();
  expect(saved).toMatchObject({ name: 'DriveSpec.sysml', mimeType: 'text/plain', headRevisionId: 'r1' });
  expect(saved.body).toBe(withFinalNewline(await textView(page)));
  expect(saved.body).toContain('package VehicleModel {');
  expect(saved.body).not.toMatch(/\bpackage (ScalarValues|ISQ|SI|Base|KerML)\b/);
  expect(saved.body.length).toBeLessThan(20_000);
  expect(await driveFile(page)).toMatchObject({ id: saved.id, md5Checksum: saved.md5Checksum, openedFrom: 'save-as' });

  // An edit → unsaved; Save to Drive in the panel writes it.
  await rename(page, 'Vehicle', 'Car');
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  await expect(strip(page)).toContainText('DriveSpec.sysml · unsaved changes');
  await expect(tbDrive).toHaveAttribute('data-status', 'attention');
  await openPanel(page);
  await page.getByTestId('tb-drive-save').click();
  await expect.poll(() => fakes.file(saved.id).headRevisionId).toBe('r2');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(saved.id).md5Checksum).not.toBe(saved.md5Checksum);
  expect(fakes.file(saved.id).body).toContain('part def Car;');
  expect(await driveFile(page)).toMatchObject({ md5Checksum: fakes.file(saved.id).md5Checksum, headRevisionId: 'r2' });

  // Ctrl+Shift+S from the diagram: the focus on one of its boxes.
  await rename(page, 'Car', 'Truck');
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  await page.locator('.react-flow__node').first().focus();
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="diagram-canvas"]'))).toBe(true);
  await page.keyboard.press('Control+Shift+S');
  await expect.poll(() => fakes.file(saved.id).headRevisionId).toBe('r3');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(saved.id).body).toContain('part def Truck;');

  // Ctrl+Shift+S typed in the Text view, right after typing there: the text
  // is made the model, and that is what Drive gets.
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await editor.fill((await editor.inputValue()).replace('part def Truck;', 'part def Bus;'));
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  await editor.press('Control+Shift+S');
  await expect.poll(() => fakes.file(saved.id).headRevisionId).toBe('r4');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(saved.id).body).toContain('part def Bus;');
  expect(fakes.file(saved.id).body).toBe(withFinalNewline(await editor.inputValue()));
  expect(await hasNamed(page, 'PartDefinition', 'Bus')).toBe(true);

  // The toolbar's Save, with a Drive file attached, saves to it — and, as
  // without Drive, in this browser (Open ▾ lists the project).
  await rename(page, 'Bus', 'Van');
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  expect(await browserProjectHolds(page, 'VehicleModel', ['"Van"'])).toBeNull();
  await page.getByTestId('tb-save').click();
  await expect.poll(() => fakes.file(saved.id).headRevisionId).toBe('r5');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(saved.id).body).toContain('part def Van;');
  await expect.poll(() => browserProjectHolds(page, 'VehicleModel', ['"Van"'])).toEqual(['"Van"']);
  await page.getByTestId('tb-open').click();
  await expect(page.locator('[data-testid="project-pick"][data-name="VehicleModel"]')).toBeVisible();
  await page.getByTestId('tb-open').click(); // closes it
  await expect(page.getByTestId('project-picker')).toHaveCount(0);

  // Ctrl+S, away from the Text view, does the same: Drive and this browser.
  await rename(page, 'Van', 'Jeep');
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  await page.locator('.react-flow__node').first().focus();
  await page.keyboard.press('Control+S');
  await expect.poll(() => fakes.file(saved.id).headRevisionId).toBe('r6');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(saved.id).body).toContain('part def Jeep;');
  await expect.poll(() => browserProjectHolds(page, 'VehicleModel', ['"Jeep"'])).toEqual(['"Jeep"']);

  // An edit made through the SDK on window.sysml, as an agent scripting the
  // page makes one: it reaches the Text view, so the file reads unsaved, and
  // Ctrl+Shift+S sends it.
  const jeep = await findElementId(page, 'PartDefinition', 'Jeep');
  await page.evaluate(
    (id) =>
      (window as unknown as { sysml: { update(id: string, patch: { declaredName: string }): unknown } }).sysml.update(id, {
        declaredName: 'Scripted',
      }),
    jeep,
  );
  await expect(page.getByTestId('text-editor')).toHaveValue(/part def Scripted;/);
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  await page.locator('.react-flow__node').first().focus();
  await page.keyboard.press('Control+Shift+S');
  await expect.poll(() => fakes.file(saved.id).headRevisionId).toBe('r7');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(saved.id).body).toContain('part def Scripted;');

  // The token was in the Authorization header of every request and nowhere
  // the page keeps anything: not in localStorage, sessionStorage or any
  // IndexedDB store (where Save just wrote), not on window.sysprose.
  expect(fakes.requests.length).toBeGreaterThan(0);
  expect(fakes.requests.every((r) => r.token === 'fake-token-1' && !r.path.includes('fake-token'))).toBe(true);
  expect(fakes.requests.some((r) => r.resourceKeys !== undefined)).toBe(false);
  const records = await storedRecords(page, fakes.issued);
  expect(records.some((r) => r.where.startsWith('indexedDB '))).toBe(true);
  expect(records.filter((r) => r.holds.length > 0)).toEqual([]);
  const onWindow = await page.evaluate(() =>
    JSON.stringify((window as unknown as DriveWindow).sysprose?.drive?.file()),
  );
  for (const token of fakes.issued) expect(onWindow).not.toContain(token);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('Recent reopens a file after a reload, which signed the user out; leaving asks only while unsaved', async ({
  page,
}) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  fakes.seed({ name: 'Older.sysml', body: 'package Older {\n    part def Glider;\n}\n' });
  const swarm = fakes.seed({ name: 'Swarm.sysml', body: SWARM });
  // Shared with the user but never chosen for this app: drive.file keeps it out of the list.
  fakes.seed({ name: 'NotPicked.sysml', body: SWARM, granted: false });
  await signIn(page);
  await openPanel(page);
  const recent = page.getByTestId('drive-recent-item');
  await expect(recent).toHaveCount(2);
  expect(await recent.evaluateAll((items) => items.map((i) => i.getAttribute('data-name')))).toEqual([
    'Swarm.sysml',
    'Older.sysml',
  ]);

  // The token lived in the page's memory: a reload signs the user out.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await appReady(page);
  await openPanel(page);
  await expect(page.getByTestId('drive-account')).toHaveText('Not signed in');
  await signIn(page);
  expect(fakes.tokenRequests.map((r) => r.prompt)).toEqual(['select_account', 'select_account']);

  await openRecent(page, swarm.id);
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  await expect(strip(page)).toContainText('Swarm.sysml · saved to your Google Drive at');
  expect(await rootNames(page)).toEqual(['Swarm']);
  await expect(page.getByTestId('tb-undo')).toBeDisabled();
  expect(await driveFile(page)).toMatchObject({ id: swarm.id, openedFrom: 'recent', rewrites: false });

  // Leaving the page asks first exactly while the file has unsaved changes —
  // and Undo back to the saved model is saved again.
  expect(await leavingAsks(page)).toBe(false);
  await rename(page, 'Drone', 'Rotor');
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  await expect.poll(() => leavingAsks(page)).toBe(true);
  await page.getByTestId('tb-undo').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  await expect.poll(() => leavingAsks(page)).toBe(false);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a model JSON file from Drive opens but is not attached; Save to Drive as… writes the model as .sysml', async ({
  page,
}) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  const json = fakes.seed({ name: 'Swarm.json', body: SWARM_JSON, mimeType: 'application/json' });
  await signIn(page);

  // Opened from Recent: the model is the file's, and Undo starts over from it…
  await openRecent(page, json.id);
  await expect(strip(page)).toHaveAttribute('data-status', 'info');
  await expect(strip(page)).toContainText(
    'Opened Swarm.json from Drive as JSON. Save to Drive as… writes it as a .sysml file.',
  );
  await expect.poll(() => rootNames(page)).toEqual(['Swarm']);
  expect(await hasNamed(page, 'PartDefinition', 'Drone')).toBe(true);
  await expect(page.getByTestId('tb-undo')).toBeDisabled();
  // …but no file is attached: a save would write another format into it.
  expect(await driveFile(page)).toBeNull();
  await expect(page.getByTestId('tb-drive')).toHaveAttribute('data-file', '');
  await openPanel(page);
  await expect(page.getByTestId('tb-drive-save')).toBeDisabled();
  await expect(page.getByTestId('tb-drive-save')).toHaveAttribute(
    'title',
    'No Drive file is open — Save to Drive as… writes one',
  );
  await expect(page.getByTestId('drive-close')).toHaveCount(0);

  // Save to Drive as…: a new .sysml file, which is the one attached; the JSON
  // file stays as it was.
  await page.getByTestId('tb-drive-save-as').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'saveas');
  await expect(page.getByTestId('drive-saveas-name')).toHaveValue('Swarm.sysml');
  await page.getByTestId('drive-saveas-confirm').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  const written = fakes.files().find((f) => f.name === 'Swarm.sysml');
  if (written === undefined) throw new Error('Save to Drive as… wrote no .sysml file');
  expect(written).toMatchObject({ body: SWARM, mimeType: 'text/plain' });
  expect(await driveFile(page)).toMatchObject({ id: written.id, openedFrom: 'save-as' });
  expect(fakes.file(json.id)).toMatchObject({ body: SWARM_JSON, headRevisionId: 'r1' });
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a ?drive= link: the gate waits for Google’s script, then one click signs in and opens the file', async ({
  page,
}) => {
  const errors = driveErrors(page);
  const fakes = await installDriveFakes(page, { config: FAKE_CONFIG, holdGis: true });
  const linked = fakes.seed({ name: 'Linked.sysml', body: SWARM });
  await page.goto(`/?drive=${linked.id}`, { waitUntil: 'domcontentloaded' });
  const gate = page.getByTestId('drive-link-gate');
  const signInButton = page.getByTestId('drive-link-signin');
  await expect(gate).toHaveAttribute('data-status', 'pending', { timeout: 60_000 });

  // Google's script was asked for before any click, and until it is there the
  // gate's sign-in waits: its popup must open inside the click.
  await expect.poll(() => fakes.googleRequests).toEqual([DRIVE_SCRIPTS.gis]);
  await expect(signInButton).toBeDisabled();
  await expect(signInButton).toHaveText('Loading Google sign-in…');
  fakes.releaseGis();
  await expect(signInButton).toBeEnabled();
  await expect(signInButton).toHaveText('Sign in and open');
  expect(fakes.tokenRequests).toEqual([]);

  await signInButton.click();
  await appReady(page);
  expect(await rootNames(page)).toEqual(['Swarm']);
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  await expect(page.getByTestId('tb-undo')).toBeDisabled();
  expect(fakes.tokenRequests).toMatchObject([
    { prompt: 'select_account', activated: true, inEvent: 'click', answer: 'grant' },
  ]);
  expect(await driveFile(page)).toMatchObject({ id: linked.id, openedFrom: 'link' });
  expect(await driveLink(page)).toBe(`${new URL(page.url()).origin}/?drive=${linked.id}`);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a ?drive= link Drive denies: choosing the one file in the Picker grants it, and it opens', async ({
  page,
}) => {
  const errors = driveErrors(page);
  const fakes = await installDriveFakes(page, { config: FAKE_PICKER_CONFIG });
  // A classmate shared it; this app has never been given it (drive.file).
  const shared = fakes.seed({ name: 'Shared.sysml', body: SWARM, granted: false, by: 'A classmate' });
  fakes.answerPicks({ id: shared.id, name: 'Shared.sysml' });
  await page.goto(`/?drive=${shared.id}`, { waitUntil: 'domcontentloaded' });
  const gate = page.getByTestId('drive-link-gate');
  await expect(page.getByTestId('drive-link-signin')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('drive-link-signin').click();
  await expect(gate).toHaveAttribute('data-status', 'denied');
  await expect(page.getByTestId('drive-link-denied')).toContainText(
    'Google Drive did not let Sysprose open this file. If it was shared with you, choose it once:',
  );
  await expect(page.getByTestId('drive-link-denied')).toContainText(`Signed in as ${FAKE_ACCOUNT.email}.`);

  await page.getByTestId('drive-link-browse').click();
  await appReady(page);
  expect(await rootNames(page)).toEqual(['Swarm']);
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(shared.id).granted).toBe(true);
  expect(await driveFile(page)).toMatchObject({ id: shared.id, openedFrom: 'link' });
  // The Picker showed that one file: one view, given its id and nothing else.
  const origin = new URL(page.url()).origin;
  expect(fakes.pickerBuilds).toEqual([
    {
      views: [{ viewId: 'all', calls: [['setFileIds', shared.id]] }],
      developerKey: FAKE_PICKER_CONFIG.apiKey,
      appId: FAKE_PICKER_CONFIG.appId,
      origin,
      hasToken: true,
    },
  ]);

  // Browse Drive… in the panel: My Drive and Shared with me. Closed, nothing changes.
  await openPanel(page);
  await page.getByTestId('tb-drive-browse').click();
  await expect.poll(() => fakes.pickerBuilds.length).toBe(2);
  const types = 'text/plain,application/octet-stream,application/json';
  expect(fakes.pickerBuilds[1].views).toEqual([
    { viewId: 'all', calls: [['setIncludeFolders', true], ['setMimeTypes', types]] },
    { viewId: 'all', calls: [['setOwnedByMe', false], ['setIncludeFolders', true], ['setMimeTypes', types]] },
  ]);
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(await driveFile(page)).toMatchObject({ id: shared.id });
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a ?drive= link whose open fails: the gate says why beside the privacy page, and Try again opens the file', async ({
  page,
}) => {
  const errors = driveErrors(page);
  // The sign-in window closes without a token — all GIS reports when Google
  // showed its "Access blocked" page in it.
  const fakes = await installDriveFakes(page, { config: FAKE_CONFIG, signIn: 'popup_closed' });
  const linked = fakes.seed({ name: 'Linked.sysml', body: SWARM });
  await page.goto(`/?drive=${linked.id}`, { waitUntil: 'domcontentloaded' });
  const gate = page.getByTestId('drive-link-gate');
  const retry = page.getByTestId('drive-link-retry');
  const privacy = page.getByTestId('drive-link-privacy');
  await expect(page.getByTestId('drive-link-signin')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('drive-link-signin').click();

  // The gate holds, saying why — beside the page that names the client ID for
  // an administrator, the one way to it while the gate is up.
  await expect(gate).toHaveAttribute('data-status', 'failed');
  await expect(gate).toContainText(
    'Sign-in was cancelled or blocked. If Google showed an "Access blocked" page, your organisation\'s ' +
      "administrator has to allow this app — Privacy & data explains how and names the app's client ID.",
  );
  await expect(privacy).toHaveText('Privacy & data ↗');
  await expect(privacy).toHaveAttribute('href', FAKE_CONFIG.privacyUrl);
  await expect(privacy).toHaveAttribute('target', '_blank');
  await expect(privacy).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByTestId('drive-link-skip')).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  expect(fakes.requests).toEqual([]);

  // Try again signs in inside its own click. Drive then fails the open — its
  // metadata answered 500 twice, so the one automatic retry does not hide it:
  // the gate says so, Try again and the privacy page still there.
  let failed = 0;
  await page.route(
    (url) => url.origin === DRIVE_API_ORIGIN && url.pathname === `/drive/v3/files/${linked.id}`,
    (route) =>
      failed++ < 2
        ? route.fulfill({
            status: 500,
            headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({
              error: { code: 500, message: 'Backend Error', errors: [{ domain: 'global', reason: 'backendError' }] },
            }),
          })
        : route.fallback(),
  );
  await retry.click();
  await expect(gate).toContainText(
    'Google Drive did not answer properly (HTTP 500). Nothing was changed; try again.',
  );
  await expect(gate).toHaveAttribute('data-status', 'failed');
  await expect(retry).toBeEnabled();
  await expect(privacy).toHaveAttribute('href', FAKE_CONFIG.privacyUrl);
  expect(fakes.tokenRequests).toMatchObject([
    { prompt: 'select_account', answer: 'popup_closed' },
    { prompt: 'select_account', activated: true, inEvent: 'click', answer: 'grant' },
  ]);

  // Try again, signed in now: the file opens, as the link's.
  await retry.click();
  await appReady(page);
  expect(await rootNames(page)).toEqual(['Swarm']);
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  await expect(page.getByTestId('tb-undo')).toBeDisabled();
  expect(await driveFile(page)).toMatchObject({ id: linked.id, openedFrom: 'link' });
  expect(fakes.tokenRequests).toHaveLength(2);
  // Drive itself saw only that open: the metadata, then the content.
  expect(fakes.requests.filter((r) => r.path.includes(linked.id)).map((r) => [r.method, r.status])).toEqual([
    ['GET', 200],
    ['GET', 200],
  ]);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a pasted Drive share link keeps its resource key, and every request for the file carries it', async ({
  page,
}) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  const KEY = '0-KeyFromAShareLink';
  // A link-shared file Drive finds only with its resource key.
  const keyed = fakes.seed({ name: 'Keyed.sysml', body: SWARM, resourceKey: KEY, keyRequired: true });
  await signIn(page);

  // The bare id: without the key, Drive does not find it.
  await openPanel(page);
  await page.getByTestId('drive-open-id').fill(keyed.id);
  await page.getByTestId('drive-open-id-go').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'error');
  await expect(strip(page)).toContainText('Google Drive did not let Sysprose open this file.');
  expect(await rootNames(page)).toEqual(['VehicleModel']);

  // The share link carries it.
  await openPanel(page);
  const shareLink = `https://drive.google.com/file/d/${keyed.id}/view?usp=sharing&resourcekey=${KEY}`;
  await page.getByTestId('drive-open-id').fill(shareLink);
  await page.getByTestId('drive-open-id-go').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(await rootNames(page)).toEqual(['Swarm']);
  expect(await driveFile(page)).toMatchObject({ id: keyed.id, resourceKey: KEY, openedFrom: 'paste' });
  expect(await driveLink(page)).toBe(`${new URL(page.url()).origin}/?drive=${keyed.id}&resourcekey=${KEY}`);

  // A save carries it as well: the check before the write, and the write.
  await rename(page, 'Drone', 'Rotor');
  await saveFromStrip(page);
  await expect.poll(() => fakes.file(keyed.id).headRevisionId).toBe('r2');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  const forFile = fakes.requests.filter((r) => r.path.includes(keyed.id));
  expect(forFile.map((r) => [r.method, r.resourceKeys ?? null, r.status])).toEqual([
    ['GET', null, 404],
    ['GET', `${keyed.id}/${KEY}`, 200],
    ['GET', `${keyed.id}/${KEY}`, 200],
    ['GET', `${keyed.id}/${KEY}`, 200],
    ['PATCH', `${keyed.id}/${KEY}`, 200],
  ]);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a conflict only when the content changed in Drive — and each way out of one', async ({ page }) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  await signIn(page);
  const id = await saveAs(page, 'Conflict');

  // A rename or a share moves `version` and `modifiedTime`, not the content: no conflict.
  fakes.touchMeta(id);
  await rename(page, 'Vehicle', 'Car');
  await saveFromStrip(page);
  await expect.poll(() => fakes.file(id).headRevisionId).toBe('r2');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');

  // A classmate saved new content: the save stops, writes nothing, and asks.
  fakes.bump(id);
  const theirs = fakes.file(id);
  await rename(page, 'Car', 'Truck');
  await saveFromStrip(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'conflict');
  await expect(strip(page)).toHaveAttribute('role', 'alert');
  await expect(strip(page)).toContainText('Conflict.sysml changed in Drive since you opened it (A classmate, ');
  expect(fakes.file(id)).toEqual(theirs);

  // Save as copy: a new file, which the model is attached to from now on.
  await page.getByTestId('drive-strip-copy-save').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'saveas');
  await expect(page.getByTestId('drive-saveas-name')).toHaveValue('Conflict (copy).sysml');
  await page.getByTestId('drive-saveas-confirm').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  await expect(strip(page)).toContainText('Conflict (copy).sysml · saved to your Google Drive at');
  const copy = fakes.files().find((f) => f.name === 'Conflict (copy).sysml');
  if (copy === undefined) throw new Error('no copy was written');
  expect(copy.body).toContain('part def Truck;');
  expect(fakes.file(id)).toEqual(theirs);

  // Overwrite: this model goes over the classmate's version.
  fakes.bump(copy.id);
  await rename(page, 'Truck', 'Bus');
  await saveFromStrip(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'conflict');
  await page.getByTestId('drive-strip-overwrite').click();
  await expect.poll(() => fakes.file(copy.id).headRevisionId).toBe('r3');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(copy.id).body).toContain('part def Bus;');
  expect(fakes.file(copy.id).body).not.toContain('changed in Drive');

  // Reload from Drive: the classmate's version replaces the model, with one
  // Undo step back to this one — which Drive does not hold.
  fakes.bump(copy.id, 'package Theirs {\n    part def Glider;\n}\n');
  await rename(page, 'Bus', 'Van');
  await saveFromStrip(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'conflict');
  await page.getByTestId('drive-strip-reload').click();
  await expect.poll(() => rootNames(page)).toEqual(['Theirs']);
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  await expect(page.getByTestId('tb-undo')).toBeEnabled();
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => rootNames(page)).toEqual(['VehicleModel']);
  expect(await hasNamed(page, 'PartDefinition', 'Van')).toBe(true);
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a sign-in Google or the browser refuses says why, and changes nothing', async ({ page }) => {
  const errors = driveErrors(page);
  const refusals = [
    ['access_denied', 'You did not grant Sysprose access to Google Drive. Nothing was saved.'],
    // Granular consent: Allow pressed with the Drive box unticked.
    ['scope_unticked', 'You did not grant Sysprose access to Google Drive. Nothing was saved.'],
    // Also all GIS reports when Google showed its "Access blocked" page.
    ['popup_closed', 'Sign-in was cancelled or blocked. If Google showed an "Access blocked" page'],
    [
      'popup_failed_to_open',
      'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.',
    ],
  ] as const;
  const fakes = await configured(page, { signIn: refusals.map(([code]) => code) });
  await openPanel(page);
  const signInButton = page.getByTestId('tb-drive-signin');
  for (const [n, [code, message]] of refusals.entries()) {
    await expect(signInButton).toBeEnabled();
    await signInButton.click();
    await expect.poll(() => fakes.tokenRequests.length).toBe(n + 1);
    expect(fakes.tokenRequests[n].answer).toBe(code);
    await expect(strip(page), code).toHaveAttribute('data-status', 'error');
    await expect(strip(page), code).toContainText(message);
    // Beside every error: the page that names the client ID for an administrator.
    await expect(page.getByTestId('drive-strip-privacy')).toBeVisible();
    await expect(page.getByTestId('drive-strip-privacy')).toHaveAttribute('href', FAKE_CONFIG.privacyUrl);
    await expect(page.getByTestId('drive-account')).toHaveText('Not signed in');
    await expect(page.getByTestId('tb-drive')).toHaveAttribute('data-status', 'error');
  }
  // Then one Google grants.
  await signInButton.click();
  await expect(page.getByTestId('drive-account')).toHaveText(`Signed in as ${FAKE_ACCOUNT.email}`);
  await expect(strip(page)).toHaveCount(0);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a refused token is renewed by a brief sign-in, or a click when that is blocked; a busy Drive is retried', async ({
  page,
}) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  fakes.issueToken('t1');
  await signIn(page);
  const id = await saveAs(page, 'Renewed');
  const forFile = (): Array<[string, string | null, number]> =>
    fakes.requests
      .filter((r) => r.path.includes(`/files/${id}`))
      .map((r): [string, string | null, number] => [r.method, r.token, r.status]);

  // Revoked elsewhere: the save's request is refused, a brief sign-in as the
  // same account (no account chooser) renews the token, and the save goes on.
  fakes.expireToken('t1');
  fakes.issueToken('t2');
  await rename(page, 'Vehicle', 'Car');
  await saveFromStrip(page);
  await expect.poll(() => fakes.file(id).headRevisionId).toBe('r2');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  // (Asked after the refusal came back, so outside the click's handler —
  // `inEvent` is not asserted: whether its window may open is the browser's
  // call, and a blocked one parks the save for "Sign in and continue".)
  expect(fakes.tokenRequests.at(-1)).toMatchObject({
    prompt: '',
    login_hint: FAKE_ACCOUNT.email,
    answer: 'grant',
    token: 't2',
  });
  expect(forFile()).toEqual([
    ['GET', 't1', 401],
    ['GET', 't2', 200],
    ['PATCH', 't2', 200],
  ]);

  // A busy Drive answers 503 once: one automatic retry, and the save completes.
  fakes.failNext(503);
  await rename(page, 'Car', 'Truck');
  await saveFromStrip(page);
  await expect.poll(() => fakes.file(id).headRevisionId).toBe('r3');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');

  // Twice: the strip says so, and Try again saves.
  fakes.failNext(500);
  fakes.failNext(500);
  await rename(page, 'Truck', 'Bus');
  await saveFromStrip(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'error');
  await expect(strip(page)).toContainText(
    'Google Drive did not answer properly (HTTP 500). Nothing was changed; try again.',
  );
  expect(fakes.file(id).headRevisionId).toBe('r3');
  await page.getByTestId('drive-strip-retry').click();
  await expect.poll(() => fakes.file(id).headRevisionId).toBe('r4');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(id).body).toContain('part def Bus;');
  expect(forFile().slice(3)).toEqual([
    ['GET', 't2', 503],
    ['GET', 't2', 200],
    ['PATCH', 't2', 200],
    ['GET', 't2', 500],
    ['GET', 't2', 500],
    ['GET', 't2', 200],
    ['PATCH', 't2', 200],
  ]);

  // Refused again, and the renewal's window blocked — it opens after an
  // await, outside the click. The save waits for Sign in and continue: a
  // click, inside which the window opens, and the save goes on.
  fakes.expireToken('t2');
  fakes.issueToken('t3');
  fakes.answerSignIns('popup_failed_to_open');
  await rename(page, 'Bus', 'Van');
  await saveFromStrip(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'expired');
  await expect(strip(page)).toContainText('Your Google sign-in expired.');
  expect(fakes.file(id).headRevisionId).toBe('r4');
  await page.getByTestId('drive-strip-signin').click();
  await expect.poll(() => fakes.file(id).headRevisionId).toBe('r5');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(id).body).toContain('part def Van;');
  expect(fakes.tokenRequests.slice(-2)).toMatchObject([
    { prompt: '', login_hint: FAKE_ACCOUNT.email, answer: 'popup_failed_to_open' },
    { prompt: '', login_hint: FAKE_ACCOUNT.email, activated: true, inEvent: 'click', answer: 'grant', token: 't3' },
  ]);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('view-only access and a file gone from Drive are said so; Save to Drive as… keeps a copy', async ({ page }) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  await signIn(page);
  const id = await saveAs(page, 'Shared');

  // Now view-only (the owner downgraded the share): nothing is written.
  fakes.setReadonly(id);
  await rename(page, 'Vehicle', 'Car');
  await saveFromStrip(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'readonly');
  await expect(strip(page)).toContainText('Shared.sysml · you have view access · unsaved changes');
  expect(fakes.file(id).headRevisionId).toBe('r1');
  await openPanel(page);
  await expect(page.getByTestId('tb-drive-save')).toBeDisabled();
  await expect(page.getByTestId('tb-drive-save')).toHaveAttribute(
    'title',
    'You have view access only — Save to Drive as… keeps your own copy',
  );
  await closePanel(page);

  await page.getByTestId('drive-strip-save-as').click();
  await expect(page.getByTestId('drive-saveas-name')).toHaveValue('Shared (copy).sysml');
  await page.getByTestId('drive-saveas-confirm').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  const copy = fakes.files().find((f) => f.name === 'Shared (copy).sysml');
  if (copy === undefined) throw new Error('no copy was written');
  expect(copy.body).toContain('part def Car;');

  // Trashed in Drive: the save says so, and the model stays as it is.
  fakes.trash(copy.id);
  await rename(page, 'Car', 'Truck');
  await saveFromStrip(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'gone');
  await expect(strip(page)).toContainText(
    'Shared (copy).sysml is no longer in Drive (deleted or unshared). Your model is still here.',
  );
  await expect(page.getByTestId('drive-strip-save-as')).toBeVisible();
  await expect(page.getByTestId('tb-drive')).toHaveAttribute('data-status', 'attention');
  expect(fakes.file(copy.id).headRevisionId).toBe('r1');
  expect(await hasNamed(page, 'PartDefinition', 'Truck')).toBe(true);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('offline, what needs Google waits and says so; the strip’s Save keeps the changes in this browser', async ({
  page,
  context,
}) => {
  const errors = driveErrors(page);
  const fakes = await configured(page, { config: FAKE_PICKER_CONFIG });
  await signIn(page);

  // No Drive file attached yet: Ctrl/Cmd+Shift+S opens the Save-as form, whose
  // Save waits for the network too — and nothing is sent. (First the sign-in's
  // Recent list is read, so no Drive action is still running.)
  await openPanel(page);
  await expect(page.getByTestId('drive-recent-refresh')).toBeEnabled();
  await closePanel(page);
  await context.setOffline(true);
  const before = fakes.requests.length;
  await page.keyboard.press('Control+Shift+S');
  await expect(strip(page)).toHaveAttribute('data-status', 'saveas');
  await expect(page.getByTestId('drive-saveas-confirm')).toBeDisabled();
  await expect(page.getByTestId('drive-saveas-confirm')).toHaveAttribute('title', 'Offline');
  await page.getByTestId('drive-saveas-cancel').click();
  await expect(strip(page)).toHaveCount(0);
  expect(fakes.requests.length).toBe(before);
  await context.setOffline(false);
  const id = await saveAs(page, 'Offline');

  // Text typed in the Text view, not applied: the file has unsaved changes.
  // Then the network goes.
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  const typed = (await editor.inputValue()).replace(/^( *)part def Vehicle;$/m, '$1part def Vehicle;\n$1part def Trailer;');
  expect(typed).toContain('part def Trailer;');
  await editor.fill(typed);
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  await context.setOffline(true);
  await expect(strip(page)).toHaveAttribute('data-status', 'offline');
  await expect(strip(page)).toContainText(
    'Offline — Offline.sysml has unsaved changes. They stay in this tab; Save keeps them in this browser; ' +
      'Save to Drive will work when you are back online.',
  );
  await expect(page.getByTestId('tb-drive')).toHaveAttribute('data-status', 'attention');

  // Drive ▾: every command that needs Google is disabled, its title saying
  // why. Sign out is not: it signs out here, with Google or without.
  await openPanel(page);
  for (const testid of ['tb-drive-save', 'tb-drive-save-as', 'drive-recent-refresh', 'tb-drive-browse']) {
    await expect(page.getByTestId(testid), testid).toBeDisabled();
    await expect(page.getByTestId(testid), testid).toHaveAttribute('title', 'Offline');
  }
  const recent = page.locator(`[data-testid="drive-recent-item"][data-id="${id}"]`);
  await expect(recent).toBeDisabled();
  await expect(recent).toHaveAttribute('title', 'Offline');
  await page.getByTestId('drive-open-id').fill(id);
  await expect(page.getByTestId('drive-open-id-go')).toBeDisabled();
  await expect(page.getByTestId('drive-open-id-go')).toHaveAttribute('title', 'Offline');
  await expect(page.getByTestId('tb-drive-signout')).toBeEnabled();
  await closePanel(page);

  // Ctrl/Cmd+Shift+S sends nothing, and says why; dismissed, the offline row is back.
  const asked = fakes.requests.length;
  await editor.press('Control+Shift+S');
  await expect(strip(page)).toHaveAttribute('data-status', 'error');
  await expect(strip(page)).toContainText(
    'You appear to be offline. Your edits stay in this tab; Save keeps them in this browser, and Save to Drive ' +
      'will work when you are back online.',
  );
  await page.getByTestId('drive-strip-dismiss').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'offline');

  // The strip's Save: the typed text is made the model, and the project kept
  // in this browser. Drive still lacks it, and the row stays.
  expect(await browserProjectHolds(page, 'VehicleModel', ['"Trailer"'])).toBeNull();
  await page.getByTestId('drive-strip-save-local').click();
  await expect.poll(() => browserProjectHolds(page, 'VehicleModel', ['"Trailer"'])).toEqual(['"Trailer"']);
  expect(await hasNamed(page, 'PartDefinition', 'Trailer')).toBe(true);
  await expect(strip(page)).toHaveAttribute('data-status', 'offline');
  expect(fakes.requests.length).toBe(asked);
  expect(fakes.file(id).headRevisionId).toBe('r1');

  // Back online: Save to Drive works again.
  await context.setOffline(false);
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  await saveFromStrip(page);
  await expect.poll(() => fakes.file(id).headRevisionId).toBe('r2');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(id).body).toContain('part def Trailer;');
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('sign-out revokes the token at Google and forgets the session, the list and the file', async ({ page }) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  await signIn(page);
  await saveAs(page, 'Leaving');
  await openPanel(page);
  await expect(page.getByTestId('drive-recent-item')).toHaveCount(1);

  await page.getByTestId('tb-drive-signout').click();
  await expect(page.getByTestId('drive-account')).toHaveText('Not signed in');
  expect(fakes.revoked).toEqual(['fake-token-1']);
  await expect(strip(page)).toHaveCount(0);
  await expect(page.getByTestId('drive-recent-item')).toHaveCount(0);
  await expect(page.getByTestId('tb-drive-signin')).toBeVisible();
  await expect(page.getByTestId('tb-drive')).toHaveAttribute('data-status', 'signed-out');
  await expect(page.getByTestId('tb-drive')).toHaveAttribute('data-file', '');
  expect(await driveFile(page)).toBeNull();
  // Revoked by the app's own request to Google, not by GIS's helper.
  const gisRevoked = await page.evaluate(
    () => (window as unknown as { __fakeGoogle: { gisRevoked: string[] } }).__fakeGoogle.gisRevoked,
  );
  expect(gisRevoked).toEqual([]);

  // Google does not confirm the revocation: signed out here all the same, and told so.
  fakes.revokeOk = false;
  await signIn(page);
  await openPanel(page);
  await page.getByTestId('tb-drive-signout').click();
  await expect(page.getByTestId('drive-account')).toHaveText('Not signed in');
  await expect(strip(page)).toHaveAttribute('data-status', 'error');
  await expect(strip(page)).toContainText(
    'Signed out here, but Google did not confirm the revocation. You can remove Sysprose under Google Account ' +
      '› Security › Third-party access.',
  );
  expect(fakes.revokeRequests).toEqual(['fake-token-1', 'fake-token-2']);
  expect(fakes.revoked).toEqual(['fake-token-1']);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('signing out after the hour renews the sign-in inside the click, then revokes; refused, nothing is revoked', async ({
  page,
}) => {
  // The page's clock, so that an hour can pass.
  await page.clock.install();
  const errors = driveErrors(page);
  const fakes = await configured(page);
  await signIn(page);

  // An hour later the token is past its life: revoking needs a live one, so
  // the click first asks Google for one (a brief window, no account chooser).
  fakes.issueToken('t3');
  await page.clock.fastForward('01:00:00');
  await openPanel(page);
  await page.getByTestId('tb-drive-signout').click();
  await expect(page.getByTestId('drive-account')).toHaveText('Not signed in');
  expect(fakes.tokenRequests.at(-1)).toEqual({
    prompt: '',
    login_hint: FAKE_ACCOUNT.email,
    activated: true,
    inEvent: 'click',
    answer: 'grant',
    token: 't3',
  });
  expect(fakes.revokeRequests).toEqual(['t3']);
  expect(fakes.revoked).toEqual(['t3']);
  await expect(strip(page)).toHaveCount(0);

  // The renewal's window closed: nothing is revoked, and the notice says so.
  await signIn(page);
  fakes.answerSignIns('popup_closed');
  await page.clock.fastForward('01:00:00');
  await openPanel(page);
  await page.getByTestId('tb-drive-signout').click();
  await expect(page.getByTestId('drive-account')).toHaveText('Not signed in');
  await expect(strip(page)).toHaveAttribute('data-status', 'error');
  await expect(strip(page)).toContainText(
    'Signed out here. Nothing was revoked: your Google sign-in had already expired. Remove Sysprose under ' +
      'Google Account › Security › Third-party access.',
  );
  expect(fakes.tokenRequests.at(-1)).toMatchObject({
    prompt: '',
    login_hint: FAKE_ACCOUNT.email,
    answer: 'popup_closed',
  });
  expect(fakes.revokeRequests).toEqual(['t3']);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a command that would drop unsaved Drive changes asks first; so does an open over edited work', async ({
  page,
}) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  await signIn(page);
  const id = await saveAs(page, 'Guarded');
  const drive = fakes.file(id).body;

  // New, with unsaved changes: the strip asks. Keep editing: nothing happens.
  await rename(page, 'Vehicle', 'Car');
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  await clickNew(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'guard');
  await expect(strip(page)).toHaveAttribute('role', 'alert');
  await expect(strip(page)).toContainText('Guarded.sysml has unsaved changes to Drive.');
  await page.getByTestId('drive-guard-keep').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'dirty');
  expect(await rootNames(page)).toEqual(['VehicleModel']);

  // Again, and Discard and continue: the new model, and the file let go.
  await clickNew(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'guard');
  await page.getByTestId('drive-guard-discard').click();
  await expect.poll(() => rootNames(page)).toEqual(['NewModel']);
  await expect(strip(page)).toHaveAttribute('data-status', 'closed');
  await expect(strip(page)).toContainText('Guarded.sysml closed. Save to Drive as… writes a new file.');
  expect(await driveFile(page)).toBeNull();
  expect(fakes.file(id).body).toBe(drive);
  await page.getByTestId('drive-strip-dismiss').click();
  await expect(strip(page)).toHaveCount(0);

  // Undo brings back the edited model the discard let go: edited work that
  // no Drive file holds. An open from Drive over it asks too.
  await page.getByTestId('tb-undo').click();
  await expect.poll(() => rootNames(page)).toEqual(['VehicleModel']);
  expect(await hasNamed(page, 'PartDefinition', 'Car')).toBe(true);
  expect(await driveFile(page)).toBeNull();
  await expect(strip(page)).toHaveCount(0);
  await openRecent(page, id);
  await expect(strip(page)).toHaveAttribute('data-status', 'guard');
  await expect(strip(page)).toContainText('Opening from Drive replaces the current model and clears Undo.');
  await page.getByTestId('drive-guard-open-anyway').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(await rootNames(page)).toEqual(['VehicleModel']);
  expect(await hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(true);
  expect(await hasNamed(page, 'PartDefinition', 'Car')).toBe(false);
  await expect(page.getByTestId('tb-undo')).toBeDisabled();
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('with Drive configured the toolbar keeps its commands at the e2e viewport', async ({ page }) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  for (const id of [
    'tb-validate',
    'tb-check',
    'tb-undo',
    'tb-redo',
    'tb-collab',
    'tb-drive',
    'tb-save',
    'tb-open',
    'tb-export',
  ]) {
    await expect(page.getByTestId(id), id).toBeVisible();
  }
  // Drive ▾ adds width beside Collaborate, and still nothing gives way at the
  // viewport the specs run at, where they click toolbar commands by test id.
  // This is the fullest bar they drive, so a command added to it runs out of
  // room here first; the failure names the commands that went.
  expect(
    await commandsUnderMore(page),
    `commands under More ▾ at ${page.viewportSize()?.width} px with Drive ▾ on the bar: the bar no longer fits`,
  ).toEqual([]);
  expect(fakes.googleRequests).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a hand-written file is rewritten only when the user says so; a syntax error survives the save', async ({
  page,
}) => {
  const errors = driveErrors(page);
  const fakes = await configured(page);
  const hand = fakes.seed({ name: 'Hand.sysml', body: HAND });
  const faulted = fakes.seed({ name: 'Faulted.sysml', body: FAULTED });
  await signIn(page);

  // Written by hand: the first save asks. Save as copy leaves the file as it is.
  await openRecent(page, hand.id);
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(await driveFile(page)).toMatchObject({ id: hand.id, rewrites: true });
  await rename(page, 'Drone', 'Rotor');
  await saveFromStrip(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'rewrite');
  await expect(strip(page)).toContainText('Hand.sysml was written by hand or by another tool.');
  await page.getByTestId('drive-strip-rewrite-copy').click();
  await expect(page.getByTestId('drive-saveas-name')).toHaveValue('Hand (copy).sysml');
  await page.getByTestId('drive-saveas-confirm').click();
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  const copy = fakes.files().find((f) => f.name === 'Hand (copy).sysml');
  if (copy === undefined) throw new Error('no copy was written');
  expect(copy.body).toBe('package Swarm {\n    part def Rotor;\n}\n');
  expect(fakes.file(hand.id)).toMatchObject({ body: HAND, headRevisionId: 'r1' });

  // Opened again, Save anyway rewrites it in this app's layout — once asked,
  // the next save does not ask again.
  await openRecent(page, hand.id);
  await expect.poll(async () => (await driveFile(page))?.id).toBe(hand.id);
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  await rename(page, 'Drone', 'Rotor');
  await saveFromStrip(page);
  await expect(strip(page)).toHaveAttribute('data-status', 'rewrite');
  await page.getByTestId('drive-strip-rewrite-ok').click();
  await expect.poll(() => fakes.file(hand.id).headRevisionId).toBe('r2');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(hand.id).body).toBe('package Swarm {\n    part def Rotor;\n}\n');
  await rename(page, 'Rotor', 'Blade');
  await saveFromStrip(page);
  await expect.poll(() => fakes.file(hand.id).headRevisionId).toBe('r3');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');

  // A syntax error: the Problems panel names it after the open…
  await openRecent(page, faulted.id);
  await expect.poll(async () => (await driveFile(page))?.id).toBe(faulted.id);
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  await openTab(page, 'tab-problems');
  const parseRows = page.getByTestId('problem-row').filter({ hasText: /line \d+:\d+/ });
  await expect(parseRows.first()).toBeVisible();
  // …the user types on, the error still there, and saves from the Text view:
  // Drive gets the text as typed, and the parse row is still shown.
  const typed = FAULTED.replace('part def Drone;', 'part def Drone;\n    part def Rotor;');
  await openTab(page, 'tab-text');
  await page.getByTestId('text-editor').fill(typed);
  await page.getByTestId('text-editor').press('Control+Shift+S');
  // A text the app could not lay out is a rewrite it cannot vouch for: asked.
  await expect(strip(page)).toHaveAttribute('data-status', 'rewrite');
  await page.getByTestId('drive-strip-rewrite-ok').click();
  await expect.poll(() => fakes.file(faulted.id).headRevisionId).toBe('r2');
  await expect(strip(page)).toHaveAttribute('data-status', 'clean');
  expect(fakes.file(faulted.id).body).toBe(typed);
  await openTab(page, 'tab-problems');
  // The library merges again after the apply; the row must outlast that.
  await expect.poll(() => modelSize(page), { timeout: 30_000 }).toBeGreaterThan(1000);
  await expect.poll(() => parseRows.count(), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(fakes.unanswered).toEqual([]);
  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

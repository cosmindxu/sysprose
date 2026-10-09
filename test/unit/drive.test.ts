/**
 * Google Drive (optional) — the pure modules under `src/persistence/drive/`.
 *
 * Nothing here talks to Google: every fetch is an injected stand-in. The
 * configuration cases pin the one rule that keeps a deployment WITHOUT Drive
 * unchanged — the shipped placeholder and the preview server's HTML fallback
 * both read as "no config" — and the link cases pin what may enter a request
 * path (a file id) or a header (a resource key): Drive's own alphabet, nothing
 * else, refused rather than repaired.
 *
 * The gateway cases hold the REST calls to what Drive documents — each URL,
 * query, method and header, the token in the `Authorization` header and never
 * in a URL — and to what the app may believe of an answer: metadata of the
 * right shape, UTF-8 text within the cap, failures sorted into the
 * `DriveError` classes with messages that repeat nothing a response said. The
 * multipart cases parse the upload body the way a strict server does, by CRLF
 * alone.
 *
 * The loader, sign-in and Picker cases run against stand-ins for Google's
 * scripts — a detached document that never fetches, and fake
 * `google.accounts.oauth2`, `gapi` and `google.picker` namespaces — and pin
 * what the browser and Google require of the app: only the two allowed
 * scripts are ever added; the sign-in popup is requested inside the click,
 * with no `await` before it; the token stays in the closure, stops being
 * handed out a minute before it expires, and is revoked at sign-out only
 * when Google would still accept it — counted as revoked only on Google's own
 * success answer; a script that ran without defining what it was loaded for
 * is fetched again; and the Picker opened on one shared file is a single view
 * with nothing but `setFileIds` set on it.
 *
 * The Drive ▾ panel (`DriveMenu`) is rendered over the store, with the same
 * stand-ins behind it: nothing at all without a configuration; nothing asked
 * of Google until the panel opens; "Sign in to Google…" disabled, saying it
 * is loading, until Google's script is there — and its click then asks for
 * the account chooser before anything is awaited; the items following the
 * session; and every command that replaces the model going through the
 * guard — New, Open and Import on the toolbar, a branch switch and a merge in
 * the Versions tab, a room join under Collaborate — which asks in Drive's
 * words with a Drive file attached and, without one, about work not saved in
 * this browser: on a deployment without Google Drive too. The toolbar it sits
 * on holds every command, Drive ▾ among them, to one rule: it gives way under
 * More ▾ or is pinned to the bar.
 *
 * The Drive strip (`DriveStrip`) is rendered from prepared store states, one
 * per row it can show, and held to the order the slice documents — a
 * question, then a conflict, an action running, a notice, a sign-in to renew,
 * then the attached file's own state — with a conflict, an error and a guard
 * as alerts, and the privacy page beside every error — on the `?drive=`
 * gate too, where a blocked sign-in lands with nothing else on screen. A link
 * the clipboard refused is shown to copy by hand whatever row is up, and
 * the offline row's Save applies typed text first. Its controls that may
 * sign in (the Save-as form's Save, the `?drive=` gate's Sign in and open)
 * wait, disabled and saying so, until Google's script is there, and then ask
 * for the account chooser inside their own click. The `?model=` banner gives
 * way to it.
 */
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import {
  DRIVE_API_ORIGIN,
  DRIVE_DOWNLOAD_MAX_BYTES,
  DRIVE_FIELDS,
  DRIVE_FILE_ID,
  DRIVE_HOSTS,
  DRIVE_PICKER_MIME_TYPES,
  DRIVE_RESOURCE_KEY,
  DRIVE_RETRY_AFTER_MAX_MS,
  DRIVE_REVOKE_TIMEOUT_MS,
  DRIVE_REVOKE_URL,
  DRIVE_SCOPE,
  DRIVE_SCRIPTS,
  DRIVE_SCRIPT_TIMEOUT_MS,
  DRIVE_TOKEN_MARGIN_MS,
  DRIVE_UPLOAD_MAX_BYTES,
  DriveAuthError,
  DriveBadResponseError,
  DriveError,
  DriveForbiddenError,
  DriveNetworkError,
  DriveNotFoundError,
  DriveRateLimitError,
  FakeDriveAuth,
  FakeDrivePicker,
  InMemoryDriveGateway,
  buildMultipart,
  createGisPopupAuth,
  createGooglePicker,
  createRestDriveGateway,
  createScriptLoader,
  driveDeepLink,
  driveErrorFor,
  driveErrorMessage,
  driveLinkFromUrl,
  driveWebViewLink,
  isDriveFileMeta,
  loadDriveConfig,
  loadScriptOnce,
  multipartBoundary,
  parseDriveConfig,
  parseDriveFileRef,
  type DriveFileMeta,
  type DriveGateway,
  type DriveSignInPrompt,
  type GapiNs,
  type GisTokenResponse,
  type GoogleNs,
  type GooglePickerNs,
} from '@persistence/index';
import { LINKED_MODEL_MAX_BYTES } from '@ui/linked-model';

// The panel cases render against the store, which merges the standard
// library on import: stubbed, as in the other tests that import the store.
vi.mock('../../src/library/full-library', () => ({
  loadFullStandardLibrary: () => {},
  preloadFullLibrary: async () => {},
}));
vi.mock('../../src/library/standard-library', () => ({
  loadCuratedLibrary: () => {},
}));

import {
  DRIVE_MESSAGES,
  browserDirty,
  driveConflictMessage,
  driveDirty,
  driveLink,
  driveTime,
  initialDriveState,
  setDriveServices,
  useAppStore,
  whenLibrarySettled,
  type AppState,
  type DriveFile,
  type DriveState,
} from '../../src/ui/store';
import { DriveMenu, driveMenuStatus } from '../../src/ui/panels/DriveMenu';
import {
  DRIVE_EXPIRY_WARNING_MS,
  DriveLinkGate,
  DriveStrip,
  driveLinkHolds,
  driveStripStatus,
} from '../../src/ui/panels/DriveStrip';
import { LinkedModelBanner } from '../../src/ui/panels/LinkedModelBanner';
import { COLLAPSE_ORDER, PINNED_COMMANDS, Toolbar } from '../../src/ui/panels/Toolbar';
import { BottomPanel } from '../../src/ui/panels/BottomPanel';
import { Collaborate } from '../../src/ui/panels/Collaborate';
import { commandById } from '../../src/ui/commands';

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const API_KEY = `AIza${'Sy0_-'.repeat(7)}`;
const VALID = {
  clientId: CLIENT_ID,
  apiKey: API_KEY,
  appId: '123456789012',
  privacyUrl: 'https://example.org/site/privacy/',
  supportUrl: 'https://example.org/issues',
};
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-012';
const KEY = '0-AbCdEfGhIjKlMn';
const PAGE = 'https://example.org/site/app/';

/** The placeholder the build ships, as `vite build` copies it into `dist/`. */
const placeholderText = (): string => readFileSync(resolve(process.cwd(), 'public/drive.json'), 'utf8');

/** A stand-in for `fetch` that answers every request with one Response. */
function answering(body: string, init: ResponseInit = {}) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body, init));
}
const JSON_TYPE = { 'content-type': 'application/json' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseDriveConfig — what a deployment may put in drive.json', () => {
  it('reads a full configuration, normalising the URLs', () => {
    expect(parseDriveConfig(VALID)).toEqual(VALID);
  });

  it('accepts a configuration without the Picker pair', () => {
    const { apiKey: _k, appId: _a, supportUrl: _s, ...bare } = VALID;
    expect(parseDriveConfig(bare)).toEqual({ clientId: CLIENT_ID, privacyUrl: VALID.privacyUrl });
  });

  it('treats an object with no clientId — {} or the shipped placeholder — as off, silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseDriveConfig({})).toBeNull();
    expect(parseDriveConfig(JSON.parse(placeholderText()))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('ships the one-key $comment placeholder, so the build has Drive off', () => {
    const value = JSON.parse(placeholderText()) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['$comment']);
    expect(value.$comment).toBe(
      'Google Drive is off. A deployment enables it by replacing this file; see README, Deploy.',
    );
  });

  it('ignores unknown keys, $comment included', () => {
    expect(parseDriveConfig({ ...VALID, $comment: 'ours', extra: 1 })).toEqual(VALID);
  });

  it('refuses a configuration that is present but unusable, saying why once', () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /not a JSON object/],
      ['clientId', /not a JSON object/],
      [null, /not a JSON object/],
      [{ ...VALID, clientId: 'abc' }, /clientId/],
      [{ ...VALID, clientId: `${CLIENT_ID}.evil.example` }, /clientId/],
      [{ ...VALID, clientId: 42 }, /clientId/],
      [{ ...VALID, privacyUrl: 'http://example.org/privacy/' }, /privacyUrl/],
      [{ clientId: CLIENT_ID }, /privacyUrl/],
      [{ ...VALID, privacyUrl: 'javascript:alert(1)' }, /privacyUrl/],
      [{ ...VALID, appId: undefined }, /apiKey and appId/],
      [{ ...VALID, apiKey: undefined }, /apiKey and appId/],
      [{ ...VALID, apiKey: 'AIzaShort' }, /apiKey/],
      [{ ...VALID, appId: 'project-name' }, /appId/],
      [{ ...VALID, appId: 123456789012 }, /appId/],
      [{ ...VALID, supportUrl: 'http://example.org/issues' }, /supportUrl/],
    ];
    for (const [value, reason] of cases) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseDriveConfig(value), JSON.stringify(value)).toBeNull();
      expect(warn, JSON.stringify(value)).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/^drive\.json is present but invalid \(.+\); Google Drive is disabled\.$/);
      expect(String(warn.mock.calls[0][0]), JSON.stringify(value)).toMatch(reason);
      warn.mockRestore();
    }
  });
});

describe('loadDriveConfig — fetching ./drive.json next to the page', () => {
  it('reads a valid file served as JSON, revalidating with the server', async () => {
    const f = answering(JSON.stringify(VALID), { status: 200, headers: JSON_TYPE });
    await expect(loadDriveConfig(PAGE, { fetchImpl: f })).resolves.toEqual(VALID);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(
      'https://example.org/site/app/drive.json',
      expect.objectContaining({ cache: 'no-cache', signal: expect.any(AbortSignal) }),
    );
  });

  it('reads the shipped placeholder and {} as no config', async () => {
    for (const body of [placeholderText(), '{}']) {
      const f = answering(body, { status: 200, headers: JSON_TYPE });
      await expect(loadDriveConfig(PAGE, { fetchImpl: f }), body).resolves.toBeNull();
    }
  });

  it('reads a 200 that is not JSON by its content-type as no config — the preview’s SPA fallback', async () => {
    // `vite preview` answers a missing drive.json with index.html and 200.
    const html = '<!doctype html><html><head><title>Sysprose</title></head></html>';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = answering(html, { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(loadDriveConfig(PAGE, { fetchImpl: f })).resolves.toBeNull();
    // Even a JSON body is not read when the server does not call it JSON.
    const g = answering(JSON.stringify(VALID), { status: 200, headers: { 'content-type': 'text/plain' } });
    await expect(loadDriveConfig(PAGE, { fetchImpl: g })).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a non-2xx answer as no config', async () => {
    for (const status of [404, 500]) {
      const f = answering(JSON.stringify(VALID), { status, headers: JSON_TYPE });
      await expect(loadDriveConfig(PAGE, { fetchImpl: f }), String(status)).resolves.toBeNull();
    }
  });

  it('reads a JSON-typed body that does not parse as no config, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = answering('{ "clientId": ', { status: 200, headers: JSON_TYPE });
    await expect(loadDriveConfig(PAGE, { fetchImpl: f })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'drive.json is present but invalid (not JSON); Google Drive is disabled.',
    );
  });

  it('never rejects: a network failure is no config', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(loadDriveConfig(PAGE, { fetchImpl: f })).resolves.toBeNull();
  });

  it('gives up after the timeout', async () => {
    const f = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    await expect(loadDriveConfig(PAGE, { fetchImpl: f, timeoutMs: 20 })).resolves.toBeNull();
  });

  it('resolves ./drive.json against the page, with and without a trailing slash', async () => {
    const asked = async (base: string): Promise<string> => {
      const f = answering('{}', { status: 200, headers: JSON_TYPE });
      await loadDriveConfig(base, { fetchImpl: f });
      return String(f.mock.calls[0][0]);
    };
    expect(await asked('https://example.org/site/app/')).toBe('https://example.org/site/app/drive.json');
    expect(await asked('https://example.org/site/app/index.html?drive=x&model=m#h')).toBe(
      'https://example.org/site/app/drive.json',
    );
    // The page `/site/app` (no slash) resolves its relative URLs against
    // `/site/`, its assets included — drive.json is no exception.
    expect(await asked('https://example.org/site/app')).toBe('https://example.org/site/drive.json');
  });
});

describe('driveLinkFromUrl — ?drive= and ?resourcekey=', () => {
  it('returns null when the page carries no well-formed id', () => {
    expect(driveLinkFromUrl('')).toBeNull();
    expect(driveLinkFromUrl('?model=m.sysml')).toBeNull();
    expect(driveLinkFromUrl('?drive=')).toBeNull();
  });

  it('reads a well-formed id', () => {
    expect(driveLinkFromUrl(`?drive=${ID}`)).toEqual({ id: ID });
  });

  it('refuses an id outside Drive’s alphabet or length', () => {
    for (const bad of [
      '../x',
      '..%2F..%2Fetc%2Fpasswd',
      `${ID.slice(0, 5)}%2F${ID.slice(5)}`,
      'abcdefghi', // nine characters
      'a'.repeat(129),
      encodeURIComponent('ÄbcdefghijklÖ'),
      `${ID}%0D%0AX-Evil:%201`,
      `${ID}%20`,
    ]) {
      expect(driveLinkFromUrl(`?drive=${bad}`), bad).toBeNull();
    }
    expect(DRIVE_FILE_ID.test('a'.repeat(10))).toBe(true);
    expect(DRIVE_FILE_ID.test('a'.repeat(128))).toBe(true);
  });

  it('keeps a well-formed resource key and drops a malformed one silently', () => {
    expect(driveLinkFromUrl(`?drive=${ID}&resourcekey=${KEY}`)).toEqual({ id: ID, resourceKey: KEY });
    for (const bad of ['abcd', 'a'.repeat(129), `${KEY}%0D%0AX:1`, `${KEY}%2Fx`, '']) {
      expect(driveLinkFromUrl(`?drive=${ID}&resourcekey=${bad}`), bad).toEqual({ id: ID });
    }
    expect(DRIVE_RESOURCE_KEY.test('abcde')).toBe(true);
  });
});

describe('parseDriveFileRef — what the paste field accepts', () => {
  it('accepts a bare id, trimmed', () => {
    expect(parseDriveFileRef(ID)).toEqual({ id: ID });
    expect(parseDriveFileRef(`  ${ID}\n`)).toEqual({ id: ID });
  });

  it('accepts a Drive share link, with and without a resource key', () => {
    expect(parseDriveFileRef(`https://drive.google.com/file/d/${ID}/view?usp=sharing`)).toEqual({ id: ID });
    expect(parseDriveFileRef(`https://drive.google.com/file/d/${ID}`)).toEqual({ id: ID });
    expect(parseDriveFileRef(`https://drive.google.com/file/d/${ID}/edit`)).toEqual({ id: ID });
    expect(
      parseDriveFileRef(`https://drive.google.com/file/d/${ID}/view?usp=drive_link&resourcekey=${KEY}`),
    ).toEqual({ id: ID, resourceKey: KEY });
  });

  it('accepts the open?id= form, with and without a resource key', () => {
    expect(parseDriveFileRef(`https://drive.google.com/open?id=${ID}`)).toEqual({ id: ID });
    expect(parseDriveFileRef(`https://drive.google.com/open?id=${ID}&resourcekey=${KEY}`)).toEqual({
      id: ID,
      resourceKey: KEY,
    });
  });

  it('accepts this app’s own deep link from any deployment', () => {
    expect(parseDriveFileRef(`https://example.org/site/app/?drive=${ID}`)).toEqual({ id: ID });
    expect(parseDriveFileRef(`http://localhost:4173/?drive=${ID}&resourcekey=${KEY}`)).toEqual({
      id: ID,
      resourceKey: KEY,
    });
  });

  it('drops a malformed resource key and keeps the file', () => {
    expect(parseDriveFileRef(`https://drive.google.com/file/d/${ID}/view?resourcekey=a%20b`)).toEqual({
      id: ID,
    });
  });

  it('refuses everything else', () => {
    for (const bad of [
      '',
      'not an id',
      `http://drive.google.com/file/d/${ID}/view`,
      `drive.google.com/file/d/${ID}/view`,
      `https://evil.example/file/d/${ID}/view`,
      `https://drive.google.com.evil.example/file/d/${ID}/view`,
      `https://docs.google.com/document/d/${ID}/edit`,
      `https://drive.google.com/drive/folders/${ID}`,
      `https://drive.google.com/uc?id=${ID}&export=download`,
      'https://drive.google.com/file/d/../view',
      `https://drive.google.com/open?id=../${ID}`,
      `javascript:alert('${ID}')`,
      `data:text/plain,?drive=${ID}`,
      `https://example.org/app/?drive=..%2Fx`,
    ]) {
      expect(parseDriveFileRef(bad), bad).toBeNull();
    }
  });
});

describe('driveDeepLink — the link that reopens a file here', () => {
  it('keeps the page’s origin and path and drops every other parameter and the hash', () => {
    expect(driveDeepLink({ id: ID }, 'https://example.org/site/app/index.html?model=m.sysml&room=r#frag')).toBe(
      `https://example.org/site/app/index.html?drive=${ID}`,
    );
  });

  it('appends the resource key only when the reference has one', () => {
    expect(driveDeepLink({ id: ID, resourceKey: KEY }, PAGE)).toBe(`${PAGE}?drive=${ID}&resourcekey=${KEY}`);
    expect(driveDeepLink({ id: ID }, PAGE)).not.toContain('resourcekey');
  });

  it('reads back as the same reference', () => {
    for (const ref of [{ id: ID }, { id: ID, resourceKey: KEY }]) {
      const link = driveDeepLink(ref, `${PAGE}?model=x`);
      expect(driveLinkFromUrl(new URL(link).search)).toEqual(ref);
      expect(parseDriveFileRef(link)).toEqual(ref);
    }
  });
});

describe('driveWebViewLink — Drive’s own page for a file, and nothing else', () => {
  it('keeps an https page on Drive’s origins as Drive reported it', () => {
    for (const link of [
      `https://drive.google.com/file/d/${ID}/view?usp=drivesdk`,
      `https://docs.google.com/document/d/${ID}/edit`,
    ]) {
      expect(driveWebViewLink(link)).toBe(link);
    }
  });

  it('renders no other link: another host, another scheme, or no URL at all', () => {
    for (const link of [
      undefined,
      '',
      'drive.google.com/file/d/x',
      'http://drive.google.com/file/d/x/view',
      'https://drive.google.com.example.org/file/d/x/view',
      'https://example.org/?next=https://drive.google.com/',
      'javascript:alert(1)//https://drive.google.com/',
      'data:text/html,<a href="https://drive.google.com/">',
    ]) {
      expect(driveWebViewLink(link), String(link)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The gateway: buildMultipart, createRestDriveGateway, InMemoryDriveGateway.
// ---------------------------------------------------------------------------

const TOKEN = 'ya29.a0-test-token_0123456789';
const API = 'https://www.googleapis.com';
const MD5 = '0123456789abcdef0123456789abcdef';

/** Drive's files resource as `DRIVE_FIELDS` selects it. */
const RESOURCE = {
  id: ID,
  name: 'Swarm.sysml',
  mimeType: 'text/plain',
  version: '7',
  modifiedTime: '2026-10-07T12:00:00.000Z',
  headRevisionId: '0B-rev7',
  md5Checksum: MD5,
  webViewLink: `https://drive.google.com/file/d/${ID}/view?usp=drivesdk`,
  trashed: false,
  capabilities: { canEdit: true },
  lastModifyingUser: { displayName: 'Alice' },
};
/** The same file as the app keeps it. */
const META: DriveFileMeta = {
  id: ID,
  name: 'Swarm.sysml',
  mimeType: 'text/plain',
  version: '7',
  modifiedTime: '2026-10-07T12:00:00.000Z',
  headRevisionId: '0B-rev7',
  md5Checksum: MD5,
  webViewLink: `https://drive.google.com/file/d/${ID}/view?usp=drivesdk`,
  trashed: false,
  canEdit: true,
  lastModifiedBy: 'Alice',
};

/** One answer of the fetch stand-in: a fresh Response per call, or a thrown error. */
type Answer = (() => Response | Promise<Response>) | Error;

/** A JSON answer, typed the way Drive types it. */
const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}): Answer =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
    });

/**
 * Drive's JSON error shape. Its free-text `message`s carry a token-like string
 * and a file name, which no `DriveError` may repeat.
 */
const googleError = (status: number, reason?: string, headers: Record<string, string> = {}): Answer =>
  json(
    {
      error: {
        code: status,
        message: 'Request had invalid credentials ya29.leaked-token <b>Swarm.sysml</b>',
        errors: reason ? [{ domain: 'global', reason, message: 'No access to Swarm.sysml for ya29.leaked-token' }] : [],
      },
    },
    status,
    headers,
  );

/** A media answer: the file's bytes as they are. */
const media =
  (body: BodyInit, headers: Record<string, string> = {}): Answer =>
  () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/plain', ...headers } });

/**
 * A stand-in for `fetch` that answers each call with the next answer — the
 * last one again once the list runs out — and records every request.
 */
function driveAnswering(...answers: Answer[]) {
  let i = 0;
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const next = answers[Math.min(i++, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next();
  });
}
type FetchStandIn = ReturnType<typeof driveAnswering>;

/** The `n`-th request the stand-in received. */
function sent(f: FetchStandIn, n = 0) {
  const [input, init] = f.mock.calls[n];
  return {
    url: new URL(String(input)),
    href: String(input),
    method: init?.method ?? 'GET',
    headers: new Headers(init?.headers),
    body: init?.body,
    init: init ?? {},
  };
}

/** The query of a request URL, as a plain object. */
const query = (url: URL): Record<string, string> => Object.fromEntries(url.searchParams);

function gateway(f: FetchStandIn, extra: Partial<Parameters<typeof createRestDriveGateway>[0]> = {}): DriveGateway {
  return createRestDriveGateway({ token: () => TOKEN, fetchImpl: f as unknown as typeof fetch, ...extra });
}

/** The error a promise rejects with (fails the test when it resolves). */
async function rejection(p: Promise<unknown>): Promise<DriveError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(DriveError);
    return err as DriveError;
  }
  throw new Error('expected a rejection');
}

/**
 * Split a multipart body the way a strict server does — by CRLF delimiters and
 * nothing else — into each part's header lines and content.
 */
function parseMultipart(body: string, contentType: string): Array<{ headers: string[]; content: string }> {
  const m = /^multipart\/related; boundary=([A-Za-z0-9_-]{1,70})$/.exec(contentType);
  expect(m, contentType).not.toBeNull();
  const boundary = m![1];
  const open = `--${boundary}\r\n`;
  const close = `\r\n--${boundary}--\r\n`;
  expect(body.startsWith(open), 'opening delimiter').toBe(true);
  expect(body.endsWith(close), 'closing delimiter').toBe(true);
  return body
    .slice(open.length, body.length - close.length)
    .split(`\r\n--${boundary}\r\n`)
    .map((part) => {
      const end = part.indexOf('\r\n\r\n');
      expect(end, 'a part has a header block ended by an empty CRLF line').toBeGreaterThan(0);
      return { headers: part.slice(0, end).split('\r\n'), content: part.slice(end + 4) };
    });
}

describe('the Drive constants the gateway relies on', () => {
  it('asks Drive for the content hash, the revision and the resource key', () => {
    expect(DRIVE_FIELDS.split(',')).toEqual(
      expect.arrayContaining(['md5Checksum', 'headRevisionId', 'resourceKey', 'capabilities(canEdit)']),
    );
  });

  it('caps a download at the ?model= cap and an upload at 5 MiB', () => {
    expect(DRIVE_DOWNLOAD_MAX_BYTES).toBe(LINKED_MODEL_MAX_BYTES);
    expect(DRIVE_DOWNLOAD_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(DRIVE_UPLOAD_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('names the REST host, and lists that name among the hosts the CSP admits for requests', () => {
    expect(DRIVE_API_ORIGIN).toBe(API);
    expect(DRIVE_HOSTS.connect as readonly string[]).toContain(DRIVE_API_ORIGIN);
  });
});

describe('buildMultipart — the upload body', () => {
  const B = 'part_0123456789abcdef';
  const TEXT = 'package Swarm {\n  part def Drone;\n}\n';

  it('lays out the metadata, then the text, each with its content type, then the closing delimiter', () => {
    const { body, contentType } = buildMultipart({ name: 'Swarm.sysml', mimeType: 'text/plain' }, TEXT, B);
    expect(contentType).toBe(`multipart/related; boundary=${B}`);
    expect(body).toBe(
      `--${B}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n' +
        '\r\n' +
        '{"name":"Swarm.sysml","mimeType":"text/plain"}\r\n' +
        `--${B}\r\n` +
        'Content-Type: text/plain; charset=UTF-8\r\n' +
        '\r\n' +
        `${TEXT}\r\n` +
        `--${B}--\r\n`,
    );
  });

  it('ends every delimiter and header line in CRLF: outside the text there is no bare LF or CR', () => {
    const { body } = buildMultipart({ name: 'Swarm.sysml\nsecond line' }, TEXT, B);
    const framing = body.replace(TEXT, '');
    expect(framing).not.toMatch(/(?<!\r)\n/);
    expect(framing).not.toMatch(/\r(?!\n)/);
    for (const line of [`--${B}\r\n`, 'charset=UTF-8\r\n\r\n', `--${B}--\r\n`]) expect(body).toContain(line);
  });

  it('keeps the text exactly as given — its own LF and CRLF endings are content, not framing', () => {
    const text = 'package P {\n  doc /* line one\r\n line two */\n}\n\n';
    const { body, contentType } = buildMultipart({ name: 'P.sysml' }, text, B);
    const [meta, media] = parseMultipart(body, contentType);
    expect(meta.headers).toEqual(['Content-Type: application/json; charset=UTF-8']);
    expect(media.headers).toEqual(['Content-Type: text/plain; charset=UTF-8']);
    expect(media.content).toBe(text);
  });

  it('round-trips non-ASCII names and text', () => {
    const meta = { name: 'Drohnenschwarm – Ü ✈.sysml', mimeType: 'text/plain' };
    const text = 'package Schwärm {\n  doc /* 無人機 🛩 */\n}\n';
    const [m, t] = parseMultipart(...(Object.values(buildMultipart(meta, text, B)) as [string, string]));
    expect(JSON.parse(m.content)).toEqual(meta);
    expect(t.content).toBe(text);
  });

  it('refuses a boundary that occurs in the content, or that is not a plain token', () => {
    expect(() => buildMultipart({ name: 'a' }, `x\r\n--${B}\r\ny`, B)).toThrow(RangeError);
    expect(() => buildMultipart({ name: B }, 'x', B)).toThrow(RangeError);
    for (const bad of ['', 'has space', 'semi;colon', 'quote"', 'x'.repeat(71), 'line\r\nbreak']) {
      expect(() => buildMultipart({ name: 'a' }, 'x', bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});

describe('multipartBoundary — a delimiter the content does not contain', () => {
  it('draws 128 random bits, differently each time', () => {
    const a = multipartBoundary('text');
    const b = multipartBoundary('text');
    expect(a).toMatch(/^part_[0-9a-f]{32}$/);
    expect(b).not.toBe(a);
  });

  it('draws again when the content contains the first draw', () => {
    const draws = [new Uint8Array(16), new Uint8Array(16).fill(0x11)];
    const random = vi.fn((n: number) => {
      expect(n).toBe(16);
      return draws.shift()!;
    });
    const content = `a text quoting --part_${'0'.repeat(32)} as if it were a delimiter`;
    expect(multipartBoundary(content, random)).toBe(`part_${'11'.repeat(16)}`);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it('gives up rather than send a body that splits wrongly', () => {
    const content = `--part_${'0'.repeat(32)}`;
    expect(() => multipartBoundary(content, () => new Uint8Array(16))).toThrow(/no multipart boundary/);
  });
});

describe('createRestDriveGateway — the six requests', () => {
  it('about: GET drive/v3/about for the user’s address and name', async () => {
    const f = driveAnswering(json({ user: { emailAddress: 'alice@school.edu', displayName: 'Alice' } }));
    await expect(gateway(f).about()).resolves.toEqual({ email: 'alice@school.edu', name: 'Alice' });
    const req = sent(f);
    expect(req.method).toBe('GET');
    expect(`${req.url.origin}${req.url.pathname}`).toBe(`${API}/drive/v3/about`);
    expect(query(req.url)).toEqual({ fields: 'user(emailAddress,displayName)' });
    expect(req.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(req.body).toBeUndefined();
  });

  it('about: an answer without the user reads as unknown, not as an error', async () => {
    await expect(gateway(driveAnswering(json({}))).about()).resolves.toEqual({ email: null, name: null });
  });

  it('get: GET drive/v3/files/{id} with DRIVE_FIELDS on all drives, read into a DriveFileMeta', async () => {
    const f = driveAnswering(json(RESOURCE));
    await expect(gateway(f).get({ id: ID })).resolves.toEqual(META);
    const req = sent(f);
    expect(req.method).toBe('GET');
    expect(`${req.url.origin}${req.url.pathname}`).toBe(`${API}/drive/v3/files/${ID}`);
    expect(query(req.url)).toEqual({ fields: DRIVE_FIELDS, supportsAllDrives: 'true' });
  });

  it('get: reads md5Checksum, headRevisionId, resourceKey and webViewLink when Drive reports them, and only then', async () => {
    const { md5Checksum: _m, headRevisionId: _h, webViewLink: _w, lastModifyingUser: _l, ...bare } = RESOURCE;
    const plain = await gateway(driveAnswering(json(bare))).get({ id: ID });
    for (const key of ['md5Checksum', 'headRevisionId', 'resourceKey', 'webViewLink', 'lastModifiedBy']) {
      expect(plain, key).not.toHaveProperty(key);
    }
    const keyed = await gateway(driveAnswering(json({ ...RESOURCE, resourceKey: KEY }))).get({ id: ID });
    expect(keyed).toEqual({ ...META, resourceKey: KEY });
  });

  it('download: GET the file with alt=media and return its UTF-8 text untouched', async () => {
    const text = 'package Schwärm {\r\n  // 無人機\n}\n';
    const f = driveAnswering(media(new TextEncoder().encode(text)));
    await expect(gateway(f).download({ id: ID })).resolves.toBe(text);
    const req = sent(f);
    expect(req.method).toBe('GET');
    expect(`${req.url.origin}${req.url.pathname}`).toBe(`${API}/drive/v3/files/${ID}`);
    expect(query(req.url)).toEqual({ alt: 'media', supportsAllDrives: 'true' });
  });

  it('create: POST a CRLF multipart — metadata naming a text/plain file, then the text — to the upload endpoint', async () => {
    const text = 'package Swarm {\n  part def Drone;\n}\n';
    const f = driveAnswering(json(RESOURCE));
    await expect(gateway(f).create('Swarm.sysml', text)).resolves.toEqual(META);
    const req = sent(f);
    expect(req.method).toBe('POST');
    expect(`${req.url.origin}${req.url.pathname}`).toBe(`${API}/upload/drive/v3/files`);
    expect(query(req.url)).toEqual({ uploadType: 'multipart', supportsAllDrives: 'true', fields: DRIVE_FIELDS });
    const contentType = req.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/^multipart\/related; boundary=part_[0-9a-f]{32}$/);
    const [meta, body] = parseMultipart(String(req.body), contentType);
    expect(JSON.parse(meta.content)).toEqual({ name: 'Swarm.sysml', mimeType: 'text/plain' });
    expect(body.headers).toEqual(['Content-Type: text/plain; charset=UTF-8']);
    expect(body.content).toBe(text);
  });

  it('create: a text written to look like multipart framing still arrives as one text', async () => {
    const text = 'doc /*\r\n--part_x\r\nContent-Type: text/html\r\n\r\n<b>--</b>\r\n*/\n';
    const f = driveAnswering(json(RESOURCE));
    await gateway(f).create('Tricky.sysml', text);
    const req = sent(f);
    const parts = parseMultipart(String(req.body), req.headers.get('content-type') ?? '');
    expect(parts).toHaveLength(2);
    expect(parts[1].content).toBe(text);
  });

  it('update: PATCH the text as media to upload/drive/v3/files/{id}', async () => {
    const text = 'package Swarm {\n  part def Drone;\n  part def Base;\n}\n';
    const f = driveAnswering(json({ ...RESOURCE, version: '8', headRevisionId: '0B-rev8' }));
    await expect(gateway(f).update({ id: ID }, text)).resolves.toEqual({
      ...META,
      version: '8',
      headRevisionId: '0B-rev8',
    });
    const req = sent(f);
    expect(req.method).toBe('PATCH');
    expect(`${req.url.origin}${req.url.pathname}`).toBe(`${API}/upload/drive/v3/files/${ID}`);
    expect(query(req.url)).toEqual({ uploadType: 'media', supportsAllDrives: 'true', fields: DRIVE_FIELDS });
    expect(req.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
    expect(req.body).toBe(text);
  });

  it('list: GET untrashed files, newest first, at most N, with DRIVE_FIELDS for each', async () => {
    const other = { ...RESOURCE, id: `${ID}x`, name: 'Other.sysml' };
    const f = driveAnswering(json({ files: [RESOURCE, other] }));
    await expect(gateway(f).list(25)).resolves.toEqual([META, { ...META, id: `${ID}x`, name: 'Other.sysml' }]);
    const req = sent(f);
    expect(req.method).toBe('GET');
    expect(`${req.url.origin}${req.url.pathname}`).toBe(`${API}/drive/v3/files`);
    expect(query(req.url)).toEqual({
      q: 'trashed=false',
      orderBy: 'modifiedTime desc',
      pageSize: '25',
      fields: `files(${DRIVE_FIELDS})`,
    });
  });

  it('list: an empty answer is an empty list, and the page size stays within what Drive accepts', async () => {
    await expect(gateway(driveAnswering(json({}))).list(10)).resolves.toEqual([]);
    await expect(gateway(driveAnswering(json({ files: [] }))).list(10)).resolves.toEqual([]);
    for (const [limit, size] of [[0, '1'], [-3, '1'], [2.7, '2'], [5000, '1000'], [NaN, '1']] as const) {
      const f = driveAnswering(json({ files: [] }));
      await gateway(f).list(limit);
      expect(sent(f).url.searchParams.get('pageSize'), String(limit)).toBe(size);
    }
  });
});

describe('createRestDriveGateway — what every request carries, and what none may', () => {
  /** Each method once, against a stand-in that answers whatever it is asked. */
  const everyCall = (g: DriveGateway, ref: { id: string; resourceKey?: string } = { id: ID }) => [
    ['about', () => g.about()],
    ['get', () => g.get(ref)],
    ['download', () => g.download(ref)],
    ['create', () => g.create('Swarm.sysml', 'package P;\n')],
    ['update', () => g.update(ref, 'package P;\n')],
    ['list', () => g.list(10)],
  ] as const;

  /** Answers every request with something it can read. */
  const anything = () =>
    driveAnswering(() =>
      new Response(JSON.stringify({ ...RESOURCE, files: [], user: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

  it('sends the token as a bearer header only — never in a URL', async () => {
    const f = anything();
    for (const [, call] of everyCall(gateway(f))) await call();
    expect(f).toHaveBeenCalledTimes(6);
    for (let n = 0; n < 6; n++) {
      const req = sent(f, n);
      expect(req.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(req.href).not.toContain(TOKEN);
      expect(req.href).not.toContain(encodeURIComponent(TOKEN));
      for (const param of ['access_token', 'key', 'oauth_token']) expect(req.url.searchParams.has(param)).toBe(false);
      expect(req.url.origin).toBe(API);
    }
  });

  it('never answers from the HTTP cache and sends no cookies', async () => {
    const f = anything();
    for (const [, call] of everyCall(gateway(f))) await call();
    for (let n = 0; n < 6; n++) {
      expect(sent(f, n).init.cache).toBe('no-store');
      expect(sent(f, n).init.credentials).toBe('omit');
    }
  });

  it('sends X-Goog-Drive-Resource-Keys: <id>/<key> on get, download and update exactly when the reference has a key', async () => {
    const keyed = anything();
    for (const [, call] of everyCall(gateway(keyed), { id: ID, resourceKey: KEY })) await call();
    const plain = anything();
    for (const [, call] of everyCall(gateway(plain))) await call();
    everyCall(gateway(keyed)).forEach(([op], n) => {
      const expected = ['get', 'download', 'update'].includes(op) ? `${ID}/${KEY}` : null;
      expect(sent(keyed, n).headers.get('x-goog-drive-resource-keys'), op).toBe(expected);
      expect(sent(plain, n).headers.get('x-goog-drive-resource-keys'), op).toBeNull();
    });
  });

  it('fails with DriveAuthError before any request when there is no token', async () => {
    const f = anything();
    for (const [op, call] of everyCall(gateway(f, { token: () => null }))) {
      const err = await rejection(call());
      expect(err, op).toBeInstanceOf(DriveAuthError);
      expect([err.status, err.reason], op).toEqual([0, 'no-token']);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a reference that is not Drive-shaped before any request', async () => {
    const f = anything();
    const g = gateway(f);
    for (const ref of [{ id: '../../about' }, { id: 'short' }, { id: `${ID}/x` }, { id: ID, resourceKey: 'a b\r\nX: 1' }]) {
      for (const call of [() => g.get(ref), () => g.download(ref), () => g.update(ref, 'x')]) {
        const err = await rejection(call());
        expect([err.status, err.reason], JSON.stringify(ref)).toEqual([0, 'bad-ref']);
      }
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses an upload over 5 MiB before any request', async () => {
    const f = anything();
    const g = gateway(f);
    const big = 'é'.repeat(DRIVE_UPLOAD_MAX_BYTES / 2 + 1); // 2 bytes each in UTF-8
    for (const call of [() => g.create('Big.sysml', big), () => g.update({ id: ID }, big)]) {
      const err = await rejection(call());
      expect([err.status, err.reason]).toEqual([0, 'too-large']);
    }
    expect(f).not.toHaveBeenCalled();
  });
});

describe('createRestDriveGateway — failures', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sorts HTTP failures into the DriveError classes', async () => {
    // A POST is never retried, so each answer is seen exactly once.
    const cases: Array<[Answer, new (...args: never[]) => DriveError, number, string | undefined]> = [
      [googleError(401, 'authError'), DriveAuthError, 401, 'authError'],
      [googleError(403, 'insufficientFilePermissions'), DriveForbiddenError, 403, 'insufficientFilePermissions'],
      [googleError(403, 'appNotAuthorizedToFile'), DriveForbiddenError, 403, 'appNotAuthorizedToFile'],
      // Not view-only access, though forbidden too: the reason is what tells them apart.
      [googleError(403, 'storageQuotaExceeded'), DriveForbiddenError, 403, 'storageQuotaExceeded'],
      [googleError(403, 'dailyLimitExceeded'), DriveForbiddenError, 403, 'dailyLimitExceeded'],
      [googleError(403, 'userRateLimitExceeded'), DriveRateLimitError, 403, 'userRateLimitExceeded'],
      [googleError(403, 'rateLimitExceeded'), DriveRateLimitError, 403, 'rateLimitExceeded'],
      [googleError(404, 'notFound'), DriveNotFoundError, 404, 'notFound'],
      [googleError(429, 'rateLimitExceeded'), DriveRateLimitError, 429, 'rateLimitExceeded'],
      [googleError(429), DriveRateLimitError, 429, undefined],
      [googleError(500, 'backendError'), DriveError, 500, 'backendError'],
      [googleError(400, 'badRequest'), DriveError, 400, 'badRequest'],
    ];
    for (const [answer, cls, status, reason] of cases) {
      const f = driveAnswering(answer);
      const err = await rejection(gateway(f).create('a.sysml', 'x'));
      const what = `${status} ${reason}`;
      expect(err, what).toBeInstanceOf(cls);
      if (cls === DriveError) expect(err.constructor, what).toBe(DriveError);
      expect([err.status, err.reason], what).toEqual([status, reason]);
      expect(err.name, what).toBe(cls.name);
      expect(f, what).toHaveBeenCalledTimes(1);
    }
  });

  it('reads the reason from error.status when Drive gives no errors[] entry', async () => {
    const f = driveAnswering(json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'x' } }, 403));
    const err = await rejection(gateway(f).create('a.sysml', 'x'));
    expect(err).toBeInstanceOf(DriveForbiddenError);
    expect(err.reason).toBe('PERMISSION_DENIED');
  });

  it('reports a network failure as DriveNetworkError, status 0', async () => {
    const err = await rejection(gateway(driveAnswering(new TypeError('Failed to fetch'))).get({ id: ID }));
    expect(err).toBeInstanceOf(DriveNetworkError);
    expect([err.status, err.reason]).toEqual([0, 'network']);
  });

  it('words every message from the status and reason code alone — nothing a response said', async () => {
    const answers: Answer[] = [
      googleError(403, 'insufficientFilePermissions'),
      googleError(404, '<img src=x onerror=alert(1)>'),
      googleError(500, 'reason with spaces'),
      () => new Response('<html>ya29.leaked-token Swarm.sysml</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
      () => new Response('{"error": ', { status: 503, headers: { 'content-type': 'application/json' } }),
    ];
    const messages: string[] = [];
    for (const answer of answers) {
      const err = await rejection(gateway(driveAnswering(answer)).create('a.sysml', 'x'));
      messages.push(err.message);
      expect(err.message).toBe(driveErrorMessage(err.status, err.reason));
      expect(err.message).not.toMatch(/ya29|Swarm|<|access|onerror/);
    }
    expect(messages).toEqual([
      'Google Drive answered HTTP 403 (insufficientFilePermissions)',
      'Google Drive answered HTTP 404',
      'Google Drive answered HTTP 500',
      'Google Drive answered HTTP 502',
      'Google Drive answered HTTP 503',
    ]);
  });

  it('driveErrorMessage and driveErrorFor drop a reason that is not a plain code', () => {
    expect(driveErrorMessage(0, 'timeout')).toBe('Google Drive request failed (timeout)');
    expect(driveErrorMessage(0)).toBe('Google Drive request failed');
    expect(driveErrorMessage(401, 'a b')).toBe('Google Drive answered HTTP 401');
    expect(driveErrorFor(404, 'x\r\ny').reason).toBeUndefined();
    expect(driveErrorFor(429, 'rateLimitExceeded', 2000).retryAfterMs).toBe(2000);
  });

  it('retries a GET once after a 5xx, after 1 s plus at most 0.5 s', async () => {
    vi.useFakeTimers();
    const f = driveAnswering(googleError(503, 'backendError'), json(RESOURCE));
    const done = gateway(f).get({ id: ID });
    await vi.advanceTimersByTimeAsync(999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(501);
    expect(f).toHaveBeenCalledTimes(2);
    await expect(done).resolves.toEqual(META);
  });

  it('retries a PATCH once after a 429, waiting what Retry-After asks', async () => {
    vi.useFakeTimers();
    const f = driveAnswering(googleError(429, 'rateLimitExceeded', { 'retry-after': '3' }), json(RESOURCE));
    const done = gateway(f).update({ id: ID }, 'package P;\n');
    await vi.advanceTimersByTimeAsync(2999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(2);
    await expect(done).resolves.toEqual(META);
    expect(sent(f, 1).method).toBe('PATCH');
    expect(sent(f, 1).body).toBe('package P;\n');
  });

  it('retries a 403 rate limit like a 429', async () => {
    vi.useFakeTimers();
    const f = driveAnswering(googleError(403, 'userRateLimitExceeded'), json({ files: [] }));
    const done = gateway(f).list(5);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(done).resolves.toEqual([]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('reads an HTTP-date Retry-After against the injected clock', async () => {
    vi.useFakeTimers();
    const now = () => Date.parse('Wed, 07 Oct 2026 12:00:00 GMT');
    const f = driveAnswering(
      googleError(503, 'backendError', { 'retry-after': 'Wed, 07 Oct 2026 12:00:04 GMT' }),
      json(RESOURCE),
    );
    const done = gateway(f, { now }).get({ id: ID });
    await vi.advanceTimersByTimeAsync(3999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual(META);
  });

  it('asks for the token again for the retry', async () => {
    vi.useFakeTimers();
    const tokens = ['t1', 't2'];
    const f = driveAnswering(googleError(500), json(RESOURCE));
    const done = gateway(f, { token: () => tokens.shift() ?? null }).get({ id: ID });
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect([sent(f, 0), sent(f, 1)].map((r) => r.headers.get('authorization'))).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('retries only once', async () => {
    vi.useFakeTimers();
    const f = driveAnswering(googleError(503, 'backendError'));
    const done = rejection(gateway(f).download({ id: ID }));
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await done;
    expect(err.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('never retries a POST — repeating a create whose answer was lost could leave two files', async () => {
    for (const answer of [googleError(503, 'backendError'), googleError(429), googleError(403, 'userRateLimitExceeded')]) {
      const f = driveAnswering(answer, json(RESOURCE));
      await rejection(gateway(f).create('a.sysml', 'x'));
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('does not retry what waiting cannot fix', async () => {
    const answers: Answer[] = [
      googleError(401, 'authError'),
      googleError(403, 'insufficientFilePermissions'),
      googleError(404, 'notFound'),
      googleError(400, 'badRequest'),
      new TypeError('Failed to fetch'),
      json({ id: 'not a drive id' }),
    ];
    for (const answer of answers) {
      const f = driveAnswering(answer, json(RESOURCE));
      await rejection(gateway(f).get({ id: ID }));
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('does not wait out a readable Retry-After beyond the cap: it reports the wait instead', async () => {
    // The stand-in shows the header to the gateway, as a same-origin answer or
    // one that lists it in Access-Control-Expose-Headers would; an answer that
    // hides it is the no-Retry-After case, which waits 1–1.5 s (above).
    const seconds = DRIVE_RETRY_AFTER_MAX_MS / 1000 + 1;
    const f = driveAnswering(googleError(429, 'rateLimitExceeded', { 'retry-after': String(seconds) }), json(RESOURCE));
    const err = await rejection(gateway(f).get({ id: ID }));
    expect(err).toBeInstanceOf(DriveRateLimitError);
    expect(err.retryAfterMs).toBe(seconds * 1000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('gives a metadata request or a download 30 s, and an upload 60 s', async () => {
    vi.useFakeTimers();
    const silent = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const g = gateway(silent as unknown as FetchStandIn);
    const cases: Array<[string, () => Promise<unknown>, number]> = [
      ['get', () => g.get({ id: ID }), 30_000],
      ['download', () => g.download({ id: ID }), 30_000],
      ['list', () => g.list(5), 30_000],
      ['create', () => g.create('a.sysml', 'x'), 60_000],
      ['update', () => g.update({ id: ID }, 'x'), 60_000],
    ];
    for (const [op, call, limit] of cases) {
      let settled = false;
      const done = rejection(call().finally(() => (settled = true)));
      await vi.advanceTimersByTimeAsync(limit - 1);
      expect(settled, op).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const err = await done;
      expect(err, op).toBeInstanceOf(DriveNetworkError);
      expect([err.status, err.reason], op).toEqual([0, 'timeout']);
    }
  });

  it('times out a body that stops arriving, and honours the configured limits', async () => {
    vi.useFakeTimers();
    const stalls = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('package P {\n'));
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return new Response(body, { status: 200 });
    });
    const g = gateway(stalls as unknown as FetchStandIn, { timeoutMs: 5_000 });
    const done = rejection(g.download({ id: ID }));
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await done;
    expect(err).toBeInstanceOf(DriveNetworkError);
    expect(err.reason).toBe('timeout');
  });
});

describe('createRestDriveGateway — what an answer must be', () => {
  it('refuses a download over 20 MB by its Content-Length, before reading it', async () => {
    const f = driveAnswering(media('package P;\n', { 'content-length': String(DRIVE_DOWNLOAD_MAX_BYTES + 1) }));
    const err = await rejection(gateway(f).download({ id: ID }));
    expect(err).toBeInstanceOf(DriveBadResponseError);
    expect([err.status, err.reason]).toEqual([200, 'too-large-download']);
  });

  it('lets go of an answer it refuses unread: the request is aborted, so the body stops arriving', async () => {
    const tooLong = { 'content-length': String(DRIVE_DOWNLOAD_MAX_BYTES + 1) };
    const html = { 'content-type': 'text/html' };
    const refusals: Array<[string, ResponseInit, (g: DriveGateway) => Promise<unknown>]> = [
      ['a Content-Length over the cap', { headers: tooLong }, (g) => g.download({ id: ID })],
      ['a 2xx that is not JSON', { headers: html }, (g) => g.get({ id: ID })],
      ['an error body that is not JSON', { status: 404, headers: html }, (g) => g.get({ id: ID })],
    ];
    for (const [what, init, call] of refusals) {
      const cancel = vi.fn();
      let signal: AbortSignal | undefined;
      const f = vi.fn(async (_input: RequestInfo | URL, req?: RequestInit) => {
        signal = req?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(1024)), cancel });
        // As fetch does: aborting the request ends its response's body.
        signal?.addEventListener('abort', () => void body.cancel().catch(() => {}));
        return new Response(body, { status: 200, ...init });
      });
      await rejection(call(gateway(f as unknown as FetchStandIn)));
      expect(f, what).toHaveBeenCalledTimes(1);
      expect(signal?.aborted, what).toBe(true);
      expect(cancel, what).toHaveBeenCalled();
    }
  });

  it('tells an oversized download from an oversized upload, by class, status and reason', async () => {
    const tooLong = { 'content-length': String(DRIVE_DOWNLOAD_MAX_BYTES + 1) };
    const down = await rejection(gateway(driveAnswering(media('x', tooLong))).download({ id: ID }));
    const big = 'x'.repeat(DRIVE_UPLOAD_MAX_BYTES + 1);
    const up = await rejection(gateway(driveAnswering(json(RESOURCE))).create('Big.sysml', big));
    expect([down.constructor, down.status, down.reason]).toEqual([DriveBadResponseError, 200, 'too-large-download']);
    expect([up.constructor, up.status, up.reason]).toEqual([DriveError, 0, 'too-large']);
  });

  it('refuses a download over 20 MB by what arrives, stopping the read', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let pulled = 0;
    const cancel = vi.fn();
    const f = driveAnswering(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(chunk);
            },
            cancel,
          }),
          { status: 200 },
        ),
    );
    const err = await rejection(gateway(f).download({ id: ID }));
    expect([err.status, err.reason]).toEqual([200, 'too-large-download']);
    expect(pulled).toBeLessThanOrEqual(DRIVE_DOWNLOAD_MAX_BYTES / chunk.byteLength + 2);
    expect(cancel).toHaveBeenCalled();
  });

  it('accepts a download of exactly 20 MB', async () => {
    const f = driveAnswering(media(new Uint8Array(DRIVE_DOWNLOAD_MAX_BYTES).fill(0x61)));
    await expect(gateway(f).download({ id: ID })).resolves.toHaveLength(DRIVE_DOWNLOAD_MAX_BYTES);
  });

  it('refuses a download that is not UTF-8 text', async () => {
    for (const bytes of [
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // a PNG signature
      [0x70, 0x61, 0x63, 0xc3], // truncated multi-byte sequence
      [0x70, 0x00, 0x71], // valid UTF-8 with a NUL: a binary file
    ]) {
      const err = await rejection(gateway(driveAnswering(media(new Uint8Array(bytes)))).download({ id: ID }));
      expect(err, String(bytes)).toBeInstanceOf(DriveBadResponseError);
      expect(err.reason, String(bytes)).toBe('not-text');
    }
  });

  it('refuses metadata that does not read as a DriveFileMeta', async () => {
    const { capabilities: _c, ...noCaps } = RESOURCE;
    const shapes: unknown[] = [
      [],
      'Swarm.sysml',
      { ...RESOURCE, id: undefined },
      { ...RESOURCE, id: '../../etc' },
      { ...RESOURCE, name: 42 },
      { ...RESOURCE, version: 7 },
      { ...RESOURCE, trashed: 'false' },
      noCaps,
      { ...RESOURCE, capabilities: { canEdit: 'yes' } },
      { ...RESOURCE, md5Checksum: 5 },
      { ...RESOURCE, resourceKey: 'a b' },
      { ...RESOURCE, lastModifyingUser: { displayName: ['Alice'] } },
    ];
    for (const shape of shapes) {
      for (const call of [(g: DriveGateway) => g.get({ id: ID }), (g: DriveGateway) => g.update({ id: ID }, 'x')]) {
        const err = await rejection(call(gateway(driveAnswering(json(shape)))));
        expect(err, JSON.stringify(shape)).toBeInstanceOf(DriveBadResponseError);
        expect(err.reason, JSON.stringify(shape)).toBe('bad-shape');
      }
    }
    for (const files of [[RESOURCE, { ...RESOURCE, id: 7 }], 'none', { 0: RESOURCE }]) {
      const err = await rejection(gateway(driveAnswering(json({ files }))).list(5));
      expect(err.reason, JSON.stringify(files)).toBe('bad-shape');
    }
    expect((await rejection(gateway(driveAnswering(json([]))).about())).reason).toBe('bad-shape');
  });

  it('refuses an answer that is not JSON, by its type or its body', async () => {
    const answers: Answer[] = [
      () => new Response(JSON.stringify(RESOURCE), { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response('{"id": ', { status: 200, headers: { 'content-type': 'application/json' } }),
      () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200, headers: { 'content-type': 'application/json' } }),
    ];
    for (const answer of answers) {
      const err = await rejection(gateway(driveAnswering(answer)).get({ id: ID }));
      expect(err).toBeInstanceOf(DriveBadResponseError);
      expect(err.reason).toBe('not-json');
    }
  });

  it('isDriveFileMeta holds the shape the rest of the app relies on', () => {
    expect(isDriveFileMeta(META)).toBe(true);
    expect(isDriveFileMeta({ ...META, resourceKey: KEY })).toBe(true);
    const { md5Checksum: _m, headRevisionId: _h, webViewLink: _w, lastModifiedBy: _l, ...required } = META;
    expect(isDriveFileMeta(required)).toBe(true);
    for (const bad of [
      null,
      [],
      { ...META, id: 'x' },
      { ...META, canEdit: undefined },
      { ...META, trashed: 0 },
      { ...META, modifiedTime: undefined },
      { ...META, resourceKey: '' },
      { ...META, webViewLink: null },
    ]) {
      expect(isDriveFileMeta(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('InMemoryDriveGateway — Drive in memory, for the tests above the gateway', () => {
  it('creates files, reads them back and lists them newest first', async () => {
    const g = new InMemoryDriveGateway();
    const a = await g.create('A.sysml', 'package A;\n');
    const b = await g.create('B.sysml', 'package B;\n');
    for (const meta of [a, b]) {
      expect(isDriveFileMeta(meta)).toBe(true);
      expect(meta.webViewLink).toBe(`https://drive.google.com/file/d/${meta.id}/view`);
    }
    expect(a.id).not.toBe(b.id);
    await expect(g.get({ id: a.id })).resolves.toEqual(a);
    await expect(g.download({ id: b.id })).resolves.toBe('package B;\n');
    expect((await g.list(10)).map((m) => m.name)).toEqual(['B.sysml', 'A.sysml']);
    expect((await g.list(1)).map((m) => m.name)).toEqual(['B.sysml']);
    await expect(g.about()).resolves.toEqual({ email: 'student@example.org', name: 'Student' });
  });

  it('moves every marker on a content write, and only version and modifiedTime on touchMeta', async () => {
    const g = new InMemoryDriveGateway();
    const v1 = await g.create('A.sysml', 'package A;\n');
    const v2 = await g.update({ id: v1.id }, 'package A2;\n');
    expect(v2.version).toBe('2');
    expect(v2.headRevisionId).not.toBe(v1.headRevisionId);
    expect(v2.md5Checksum).not.toBe(v1.md5Checksum);
    expect(v2.modifiedTime > v1.modifiedTime).toBe(true);
    const touched = g.touchMeta(v1.id);
    expect(touched.version).toBe('3');
    expect(touched.modifiedTime > v2.modifiedTime).toBe(true);
    expect([touched.md5Checksum, touched.headRevisionId]).toEqual([v2.md5Checksum, v2.headRevisionId]);
    // The hash moves with the content and nothing else: the same text again keeps it.
    const same = await g.update({ id: v1.id }, 'package A2;\n');
    expect(same.md5Checksum).toBe(v2.md5Checksum);
    expect(same.headRevisionId).not.toBe(v2.headRevisionId);
    const bumped = g.bump(v1.id);
    expect(bumped.md5Checksum).not.toBe(same.md5Checksum);
    expect(bumped.lastModifiedBy).toBe('A classmate');
    expect(g.textOf(v1.id)).toBe('package A2;\n// changed in Drive\n');
  });

  it('can leave out md5Checksum and headRevisionId, for the conflict check’s fallbacks', async () => {
    const g = new InMemoryDriveGateway({ md5Checksum: false, headRevisionId: false });
    const meta = await g.create('A.sysml', 'x');
    const next = await g.update({ id: meta.id }, 'y');
    for (const m of [meta, next]) {
      expect(m).not.toHaveProperty('md5Checksum');
      expect(m).not.toHaveProperty('headRevisionId');
    }
  });

  it('answers 404 for a file this app was not granted, until it is', async () => {
    const g = new InMemoryDriveGateway();
    const shared = g.seed({ id: ID, name: 'Shared.sysml', text: 'package S;\n', granted: false });
    for (const call of [() => g.get({ id: ID }), () => g.download({ id: ID }), () => g.update({ id: ID }, 'x')]) {
      expect(await rejection(call())).toBeInstanceOf(DriveNotFoundError);
    }
    expect(await g.list(10)).toEqual([]);
    expect(await rejection(g.get({ id: `${ID}-gone` }))).toBeInstanceOf(DriveNotFoundError);
    g.grant(ID);
    await expect(g.get({ id: ID })).resolves.toEqual(shared);
    expect(g.files().map((m) => m.id)).toEqual([ID]);
  });

  it('refuses an update without edit access with a 403, and leaves the file alone', async () => {
    const g = new InMemoryDriveGateway();
    const meta = await g.create('A.sysml', 'package A;\n');
    g.setReadonly(meta.id);
    const err = await rejection(g.update({ id: meta.id }, 'package B;\n'));
    expect(err).toBeInstanceOf(DriveForbiddenError);
    expect(err.reason).toBe('insufficientFilePermissions');
    expect(g.textOf(meta.id)).toBe('package A;\n');
    expect((await g.get({ id: meta.id })).canEdit).toBe(false);
  });

  it('keeps a trashed file readable by id and out of the list; a removed one is gone', async () => {
    const g = new InMemoryDriveGateway();
    const meta = await g.create('A.sysml', 'package A;\n');
    g.trash(meta.id);
    expect((await g.get({ id: meta.id })).trashed).toBe(true);
    expect(await g.list(10)).toEqual([]);
    g.remove(meta.id);
    expect(await rejection(g.get({ id: meta.id }))).toBeInstanceOf(DriveNotFoundError);
  });

  it('records every call with the resource key it carried', async () => {
    const g = new InMemoryDriveGateway();
    g.seed({ id: ID, name: 'Linked.sysml', text: 'package L;\n', resourceKey: KEY });
    await g.get({ id: ID, resourceKey: KEY });
    await g.download({ id: ID });
    await g.update({ id: ID, resourceKey: KEY }, 'package L2;\n');
    expect(g.calls).toEqual([
      { op: 'get', id: ID, resourceKey: KEY },
      { op: 'download', id: ID },
      { op: 'update', id: ID, resourceKey: KEY, text: 'package L2;\n' },
    ]);
    expect((await g.get({ id: ID })).resourceKey).toBe(KEY);
  });

  it('can require the resource key, as Drive does of some link-shared files: without it, a 404', async () => {
    const g = new InMemoryDriveGateway();
    g.seed({ id: ID, name: 'Linked.sysml', text: 'package L;\n', resourceKey: KEY, keyRequired: true });
    for (const ref of [{ id: ID }, { id: ID, resourceKey: `${KEY}x` }]) {
      for (const call of [() => g.get(ref), () => g.download(ref), () => g.update(ref, 'package L2;\n')]) {
        expect(await rejection(call()), JSON.stringify(ref)).toBeInstanceOf(DriveNotFoundError);
      }
    }
    expect(g.textOf(ID)).toBe('package L;\n');
    const ref = { id: ID, resourceKey: KEY };
    await expect(g.get(ref)).resolves.toMatchObject({ id: ID, resourceKey: KEY });
    await expect(g.download(ref)).resolves.toBe('package L;\n');
    await expect(g.update(ref, 'package L2;\n')).resolves.toMatchObject({ version: '2' });
    expect(() => g.seed({ name: 'NoKey.sysml', text: 'x', keyRequired: true })).toThrow(/resource key/);
  });

  it('fails the next call — or the next call of one kind — with the class the REST gateway would throw', async () => {
    const g = new InMemoryDriveGateway();
    const meta = await g.create('A.sysml', 'package A;\n');
    g.failNext(403, { op: 'update', reason: 'userRateLimitExceeded' });
    await expect(g.get({ id: meta.id })).resolves.toBeDefined();
    const limited = await rejection(g.update({ id: meta.id }, 'x'));
    expect(limited).toBeInstanceOf(DriveRateLimitError);
    expect(limited.message).toBe('Google Drive answered HTTP 403 (userRateLimitExceeded)');
    await expect(g.update({ id: meta.id }, 'x')).resolves.toBeDefined();
    g.failNext(401);
    expect(await rejection(g.about())).toBeInstanceOf(DriveAuthError);
    const odd = new DriveBadResponseError('Google Drive answered HTTP 200 (not-text)', 200, 'not-text');
    g.failNext(odd, { op: 'download' });
    expect(await rejection(g.download({ id: meta.id }))).toBe(odd);
    expect(g.calls.map((c) => c.op)).toEqual(['create', 'get', 'update', 'update', 'about', 'download']);
  });

  it('refuses as the REST gateway does: no token, a malformed reference, an oversized text', async () => {
    let token: string | null = 't1';
    const g = new InMemoryDriveGateway({ token: () => token });
    const meta = await g.create('A.sysml', 'x');
    token = null;
    const err = await rejection(g.get({ id: meta.id }));
    expect(err).toBeInstanceOf(DriveAuthError);
    expect([err.status, err.reason]).toEqual([0, 'no-token']);
    token = 't2';
    expect((await rejection(g.get({ id: '../x' }))).reason).toBe('bad-ref');
    const big = 'x'.repeat(DRIVE_UPLOAD_MAX_BYTES + 1);
    expect((await rejection(g.update({ id: meta.id }, big))).reason).toBe('too-large');
    expect(g.textOf(meta.id)).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// Google's scripts, sign-in and the Picker: loader, auth, picker.
// ---------------------------------------------------------------------------

/** A second well-formed Drive file id. */
const ID2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa_-987';
/** The clock of the sign-in cases. */
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

/** A document with no browsing context: a `<script>` added to it is never fetched, never run. */
const detachedDocument = (): Document => document.implementation.createHTMLDocument('loader');

/** The `<script>` elements of `doc`, in document order. */
const scriptsIn = (doc: Document): HTMLScriptElement[] => [...doc.querySelectorAll('script')];

/** Let every callback already due run (no timers involved). */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Whether `p` has settled once every callback already due has run. */
async function hasSettled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  await flush();
  return done;
}

/** What `storage` holds, as one string. */
function storageText(storage: Storage): string {
  let text = '';
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) text += `${key}=${storage.getItem(key)}\n`;
  }
  return text;
}

describe('loadScriptOnce — Google’s two scripts, and nothing else', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts exactly the two scripts of DRIVE_SCRIPTS, each admitted by a script-src entry of DRIVE_HOSTS', () => {
    expect(Object.values(DRIVE_SCRIPTS).sort()).toEqual([
      'https://accounts.google.com/gsi/client',
      'https://apis.google.com/js/api.js',
    ]);
    // CSP source matching: a bare origin admits every path on it; a path
    // ending in '/' admits what is under it; any other path admits itself.
    const admits = (source: string, url: string): boolean => {
      const s = new URL(source);
      const u = new URL(url);
      if (s.origin !== u.origin) return false;
      if (source === s.origin) return true;
      return source.endsWith('/') ? u.pathname.startsWith(s.pathname) : u.pathname === s.pathname;
    };
    for (const url of Object.values(DRIVE_SCRIPTS)) {
      expect(DRIVE_HOSTS.script.some((source) => admits(source, url)), url).toBe(true);
    }
    // Importing the Drive modules added nothing to the page.
    expect(document.querySelectorAll('script[src]')).toHaveLength(0);
  });

  it('refuses any other URL, as written, before an element is made', async () => {
    const doc = detachedDocument();
    const load = createScriptLoader({ document: () => doc });
    const others = [
      'https://evil.example/gsi/client',
      'http://accounts.google.com/gsi/client',
      'https://accounts.google.com/gsi/client?onload=x',
      'https://accounts.google.com/gsi/client#',
      'https://accounts.google.com/gsi/client/',
      'https://ACCOUNTS.google.com/gsi/client',
      ' https://accounts.google.com/gsi/client',
      'https://apis.google.com',
      'https://apis.google.com/js/platform.js',
      'https://apis.google.com/js/api.js?onload=x',
      '//apis.google.com/js/api.js',
      'javascript:alert(1)',
      'data:text/javascript,alert(1)',
      '',
    ];
    for (const url of others) {
      const err = await rejection(load(url));
      expect([err.status, err.reason], url).toEqual([0, 'script-refused']);
    }
    expect(scriptsIn(doc)).toEqual([]);
    // The app's own loader refuses the same way, and leaves the page alone.
    expect((await rejection(loadScriptOnce('https://evil.example/x.js'))).reason).toBe('script-refused');
    expect(document.querySelectorAll('script[src]')).toHaveLength(0);
  });

  it('adds one async <script> per URL, without integrity, shared by every caller', async () => {
    const doc = detachedDocument();
    const load = createScriptLoader({ document: () => doc });
    const first = load(DRIVE_SCRIPTS.gis);
    expect(load(DRIVE_SCRIPTS.gis)).toBe(first);
    expect(scriptsIn(doc)).toHaveLength(1);
    const [script] = scriptsIn(doc);
    expect(script.src).toBe(DRIVE_SCRIPTS.gis);
    expect(script.async).toBe(true);
    // Google changes these scripts in place: a pinned hash would break sign-in.
    expect(script.hasAttribute('integrity')).toBe(false);
    expect(script.parentNode).toBe(doc.head);
    expect(await hasSettled(first)).toBe(false);
    script.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBeUndefined();
    await expect(load(DRIVE_SCRIPTS.gis)).resolves.toBeUndefined();
    expect(scriptsIn(doc)).toHaveLength(1);
    // The other script is a load of its own.
    const gapi = load(DRIVE_SCRIPTS.gapi);
    expect(scriptsIn(doc).map((s) => s.src)).toEqual([DRIVE_SCRIPTS.gis, DRIVE_SCRIPTS.gapi]);
    scriptsIn(doc)[1].dispatchEvent(new Event('load'));
    await expect(gapi).resolves.toBeUndefined();
  });

  it('rejects a script that fails to load, removes it, and tries afresh on the next call', async () => {
    const doc = detachedDocument();
    const load = createScriptLoader({ document: () => doc });
    const first = load(DRIVE_SCRIPTS.gapi);
    scriptsIn(doc)[0].dispatchEvent(new Event('error'));
    const err = await rejection(first);
    expect(err).not.toBeInstanceOf(DriveNetworkError); // not "offline": its own message
    expect([err.status, err.reason, err.message]).toEqual([0, 'script-failed', 'Google Drive request failed (script-failed)']);
    expect(scriptsIn(doc)).toEqual([]);
    const again = load(DRIVE_SCRIPTS.gapi);
    expect(again).not.toBe(first);
    expect(scriptsIn(doc)).toHaveLength(1);
    scriptsIn(doc)[0].dispatchEvent(new Event('load'));
    await expect(again).resolves.toBeUndefined();
  });

  it('counts a script that ran without defining what it was loaded for as failed, and fetches it afresh next time', async () => {
    // A 200 can still be an empty stand-in: a content blocker's no-op, a proxy's page.
    const doc = detachedDocument();
    const load = createScriptLoader({ document: () => doc });
    let defined = false;
    const first = load(DRIVE_SCRIPTS.gis, () => defined);
    scriptsIn(doc)[0].dispatchEvent(new Event('load'));
    const err = await rejection(first);
    expect([err.status, err.reason]).toEqual([0, 'script-failed']);
    expect(scriptsIn(doc)).toEqual([]);
    // A check that throws says "not defined" as well.
    const second = load(DRIVE_SCRIPTS.gis, () => {
      throw new Error('google is not defined');
    });
    expect(scriptsIn(doc)).toHaveLength(1);
    scriptsIn(doc)[0].dispatchEvent(new Event('load'));
    expect((await rejection(second)).reason).toBe('script-failed');
    defined = true;
    const third = load(DRIVE_SCRIPTS.gis, () => defined);
    expect(scriptsIn(doc)).toHaveLength(1);
    scriptsIn(doc)[0].dispatchEvent(new Event('load'));
    await expect(third).resolves.toBeUndefined();
    // Kept from then on: a later caller shares it, whatever check it brings.
    expect(load(DRIVE_SCRIPTS.gis, () => false)).toBe(third);
    expect(scriptsIn(doc)).toHaveLength(1);
  });

  it('rejects a load that has not finished within 15 s, and tries afresh on the next call', async () => {
    vi.useFakeTimers();
    expect(DRIVE_SCRIPT_TIMEOUT_MS).toBe(15_000);
    const doc = detachedDocument();
    const load = createScriptLoader({ document: () => doc });
    let outcome = 'pending';
    load(DRIVE_SCRIPTS.gis).then(
      () => (outcome = 'loaded'),
      (e: DriveError) => (outcome = `${e.status} ${e.reason}`),
    );
    await vi.advanceTimersByTimeAsync(DRIVE_SCRIPT_TIMEOUT_MS - 1);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('0 script-timeout');
    expect(scriptsIn(doc)).toEqual([]);
    const again = load(DRIVE_SCRIPTS.gis);
    expect(scriptsIn(doc)).toHaveLength(1);
    scriptsIn(doc)[0].dispatchEvent(new Event('load'));
    await expect(again).resolves.toBeUndefined();
  });

  it('rejects when there is no document to load into', async () => {
    const load = createScriptLoader({ document: () => undefined });
    const err = await rejection(load(DRIVE_SCRIPTS.gis));
    expect([err.status, err.reason]).toEqual([0, 'no-document']);
  });

  it('turns a document with nowhere to put the element into script-failed, and does not keep that failure', async () => {
    // An XML document without a root: no head, no documentElement.
    let doc: Document = document.implementation.createDocument(null, null);
    const load = createScriptLoader({ document: () => doc });
    const err = await rejection(load(DRIVE_SCRIPTS.gis));
    expect([err.status, err.reason]).toEqual([0, 'script-failed']);
    doc = detachedDocument();
    const again = load(DRIVE_SCRIPTS.gis);
    expect(scriptsIn(doc)).toHaveLength(1);
    scriptsIn(doc)[0].dispatchEvent(new Event('load'));
    await expect(again).resolves.toBeUndefined();
  });
});

type GisOAuth2 = NonNullable<NonNullable<GoogleNs['accounts']>['oauth2']>;
type GisConfig = Parameters<GisOAuth2['initTokenClient']>[0];

/**
 * A stand-in for `google.accounts.oauth2`. It records what the app asks of
 * GIS, and answers the popup the way GIS does: the token callback with a
 * token or an OAuth error, or `error_callback` with a GIS error (an `Error`
 * carrying a `type`). It has GIS's `revoke` too, which the app must not use.
 */
function fakeGis() {
  const requests: Array<{ prompt: DriveSignInPrompt; login_hint?: string }> = [];
  const configs: GisConfig[] = [];
  const requestAccessToken = vi.fn((overrides: { prompt: DriveSignInPrompt; login_hint?: string }) => {
    requests.push({ ...overrides });
  });
  const oauth2 = {
    initTokenClient: vi.fn((config: GisConfig) => {
      configs.push(config);
      return { requestAccessToken };
    }),
    hasGrantedAllScopes: vi.fn((response: GisTokenResponse, ...scopes: string[]) =>
      scopes.every((scope) => (response.scope ?? '').split(' ').includes(scope)),
    ),
    // GIS's helper reports success for an answer it could not read: not used.
    revoke: vi.fn((_token: string, done?: (response: { successful?: boolean }) => void) => {
      done?.({ successful: true });
    }),
  };
  const config = (): GisConfig => {
    expect(configs, 'initTokenClient was called once').toHaveLength(1);
    return configs[0];
  };
  return {
    google: { accounts: { oauth2 } } as GoogleNs,
    oauth2,
    requestAccessToken,
    requests,
    /** The token callback, with whatever GIS might hand it. */
    answer: (response: GisTokenResponse) => config().callback(response),
    /** A granted token, as GIS hands it over. */
    grant: (token = TOKEN, expiresIn: number | string = 3600) =>
      config().callback({ access_token: token, expires_in: expiresIn, scope: DRIVE_SCOPE }),
    /** `error_callback`, with a GIS error of `type`. */
    fail: (type?: string) => config().error_callback(Object.assign(new Error('Popup window closed'), { type })),
  };
}

/**
 * A stand-in for `fetch` at Google's revocation endpoint. It records every
 * request and answers each with the next queued answer: a status (200 is
 * Google's success, with its `{}` body), an `Error` to reject with (offline,
 * refused by the CSP, an answer the page may not read), or `'never'` — no
 * answer until the request is aborted. With nothing queued it answers 200.
 */
function revokeEndpoint(...answers: Array<number | Error | 'never'>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    requests.push({ url: String(input), init });
    const answer = answers.shift() ?? 200;
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === 'never') {
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))),
      );
    }
    const body = answer === 200 ? '{}' : '{"error":"invalid_token","error_description":"Token expired or revoked"}';
    return Promise.resolve(new Response(body, { status: answer, headers: JSON_TYPE }));
  });
  return { fetchImpl, requests };
}

/**
 * `createGisPopupAuth` over {@link fakeGis}. As on a page, the `google`
 * namespace exists only once the script has loaded — at once, unless `load`
 * says otherwise. Sign-out's revocations go to `endpoint` (by default, one
 * that answers 200).
 */
function gisAuth(
  opts: {
    gis?: ReturnType<typeof fakeGis>;
    now?: () => number;
    load?: (url: string) => Promise<void>;
    endpoint?: ReturnType<typeof revokeEndpoint>;
  } = {},
) {
  const gis = opts.gis ?? fakeGis();
  const endpoint = opts.endpoint ?? revokeEndpoint();
  let onPage = false;
  const load = vi.fn(async (url: string, _usable?: () => boolean) => {
    await (opts.load ?? (async () => {}))(url);
    onPage = true;
  });
  const auth = createGisPopupAuth(CLIENT_ID, {
    load,
    google: () => (onPage ? gis.google : undefined),
    now: opts.now ?? (() => T0),
    fetchImpl: endpoint.fetchImpl,
  });
  return { auth, gis, load, endpoint };
}

describe('createGisPopupAuth — sign-in through Google Identity Services', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads GIS only when first asked, once, and makes one token client for the Drive scope alone', async () => {
    const { auth, gis, load } = gisAuth();
    expect(load).not.toHaveBeenCalled();
    await Promise.all([auth.ready(), auth.ready()]);
    for (const token of ['t1', 't2']) {
      const session = auth.signIn({ prompt: 'select_account' });
      gis.grant(token);
      await session;
    }
    await auth.ready();
    expect(load.mock.calls.map(([url]) => url)).toEqual([DRIVE_SCRIPTS.gis]);
    expect(gis.oauth2.initTokenClient).toHaveBeenCalledTimes(1);
    const config = gis.oauth2.initTokenClient.mock.calls[0][0];
    expect(Object.keys(config).sort()).toEqual(['callback', 'client_id', 'error_callback', 'scope']);
    expect([config.client_id, config.scope]).toEqual([CLIENT_ID, DRIVE_SCOPE]);
  });

  it('requests the token inside the click: before signIn returns, before any microtask, once ready', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    let microtaskRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    const session = auth.signIn({ prompt: 'select_account' });
    expect(gis.requests).toEqual([{ prompt: 'select_account' }]);
    expect(microtaskRan).toBe(false);
    gis.grant();
    await expect(session).resolves.toEqual({ expiresAt: T0 + 3_600_000 });
  });

  it('forwards the prompt as given, and the account hint as login_hint', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    const asked: Array<{ prompt: DriveSignInPrompt; hint?: string }> = [
      { prompt: '', hint: 'alice@school.edu' },
      { prompt: 'consent' },
      { prompt: 'select_account', hint: '' },
    ];
    for (const opts of asked) {
      const session = auth.signIn(opts);
      gis.grant();
      await session;
    }
    expect(gis.requests).toEqual([
      { prompt: '', login_hint: 'alice@school.edu' },
      { prompt: 'consent' },
      { prompt: 'select_account' },
    ]);
  });

  it('asked before the script is ready, loads it first and then requests the token', async () => {
    let finish!: () => void;
    const { auth, gis, load } = gisAuth({ load: () => new Promise<void>((resolve) => (finish = resolve)) });
    const session = auth.signIn({ prompt: 'select_account' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(gis.requests).toEqual([]);
    finish();
    await flush();
    expect(gis.requests).toEqual([{ prompt: 'select_account' }]);
    gis.grant();
    await expect(session).resolves.toEqual({ expiresAt: T0 + 3_600_000 });
  });

  it('hands the token out until a minute before it expires, then never again', async () => {
    let now = T0;
    const { auth, gis } = gisAuth({ now: () => now });
    await auth.ready();
    expect(auth.token()).toBeNull();
    const session = auth.signIn({ prompt: 'select_account' });
    gis.grant(TOKEN, 3599);
    const expiresAt = T0 + 3_599_000;
    await expect(session).resolves.toEqual({ expiresAt });
    expect(DRIVE_TOKEN_MARGIN_MS).toBe(60_000);
    expect(auth.token()).toBe(TOKEN);
    now = expiresAt - DRIVE_TOKEN_MARGIN_MS - 1;
    expect(auth.token()).toBe(TOKEN);
    now = expiresAt - DRIVE_TOKEN_MARGIN_MS;
    expect(auth.token()).toBeNull();
    now = expiresAt + 1;
    expect(auth.token()).toBeNull();
    // `expires_in` as a string, the form of a token in a URL fragment, reads the same.
    now = T0;
    const again = auth.signIn({ prompt: '' });
    gis.grant('t2', '120');
    await expect(again).resolves.toEqual({ expiresAt: T0 + 120_000 });
    expect(auth.token()).toBe('t2');
  });

  it('rejects with GIS’s own code when the popup fails, and keeps no token', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    for (const type of ['popup_closed', 'popup_failed_to_open', 'unknown']) {
      const session = auth.signIn({ prompt: 'select_account' });
      gis.fail(type);
      const err = await rejection(session);
      expect(err, type).toBeInstanceOf(DriveAuthError);
      expect([err.status, err.reason, err.message]).toEqual([0, type, `Google Drive request failed (${type})`]);
    }
    // A type that is not a plain code is not repeated; no type at all is `unknown`.
    for (const type of ['closed by ya29.leaked <b>', undefined]) {
      const session = auth.signIn({ prompt: 'select_account' });
      gis.fail(type);
      const err = await rejection(session);
      expect(err.reason).toBe('unknown');
      expect(err.message).not.toContain('ya29');
    }
    expect(auth.token()).toBeNull();
  });

  it('rejects a token answer that carries an OAuth error, with that error as the reason', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    for (const error of ['access_denied', 'invalid_scope']) {
      const session = auth.signIn({ prompt: 'select_account' });
      gis.answer({ error });
      const err = await rejection(session);
      expect(err).toBeInstanceOf(DriveAuthError);
      expect([err.status, err.reason]).toEqual([0, error]);
    }
    expect(auth.token()).toBeNull();
  });

  it('treats a token without the Drive scope as access_denied — the box was unticked — and keeps it not', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    const session = auth.signIn({ prompt: 'select_account' });
    const response = { access_token: TOKEN, expires_in: 3600, scope: 'openid email' };
    gis.answer(response);
    const err = await rejection(session);
    expect(err).toBeInstanceOf(DriveAuthError);
    expect(err.reason).toBe('access_denied');
    expect(gis.oauth2.hasGrantedAllScopes).toHaveBeenCalledWith(response, DRIVE_SCOPE);
    expect(auth.token()).toBeNull();
  });

  it('refuses a token answer it cannot read, keeping no token', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    const answers: GisTokenResponse[] = [
      { expires_in: 3600, scope: DRIVE_SCOPE },
      { access_token: '', expires_in: 3600, scope: DRIVE_SCOPE },
      { access_token: TOKEN, scope: DRIVE_SCOPE },
      { access_token: TOKEN, expires_in: 0, scope: DRIVE_SCOPE },
      { access_token: TOKEN, expires_in: 'soon', scope: DRIVE_SCOPE },
      null as unknown as GisTokenResponse,
    ];
    for (const response of answers) {
      const session = auth.signIn({ prompt: 'select_account' });
      gis.answer(response);
      const err = await rejection(session);
      expect([err.status, err.reason], JSON.stringify(response)).toEqual([0, 'bad-token-response']);
    }
    expect(auth.token()).toBeNull();
  });

  it('turns GIS throwing inside requestAccessToken into a DriveAuthError, and signs in on the next try', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    gis.requestAccessToken.mockImplementationOnce(() => {
      throw Object.assign(new Error('Missing required parameter client_id.'), { type: 'missing_required_parameter' });
    });
    const err = await rejection(auth.signIn({ prompt: 'select_account' }));
    expect(err).toBeInstanceOf(DriveAuthError);
    expect(err.reason).toBe('missing_required_parameter');
    const session = auth.signIn({ prompt: 'select_account' });
    gis.grant();
    await expect(session).resolves.toEqual({ expiresAt: T0 + 3_600_000 });
  });

  it('reports a window the browser refused to open, which GIS says from inside requestAccessToken', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    // What GIS does when window.open returns null: error_callback, synchronously.
    gis.requestAccessToken.mockImplementationOnce(() => gis.fail('popup_failed_to_open'));
    const err = await rejection(auth.signIn({ prompt: 'select_account' }));
    expect(err).toBeInstanceOf(DriveAuthError);
    expect(err.reason).toBe('popup_failed_to_open');
    expect(auth.token()).toBeNull();
    const session = auth.signIn({ prompt: 'select_account' });
    gis.grant();
    await expect(session).resolves.toEqual({ expiresAt: T0 + 3_600_000 });
  });

  it('opens a popup for every click, and lets sign-ins that overlap share the one answer', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    const first = auth.signIn({ prompt: 'select_account' });
    const second = auth.signIn({ prompt: 'select_account' });
    expect(gis.requests).toHaveLength(2);
    gis.grant('t1');
    await expect(first).resolves.toEqual({ expiresAt: T0 + 3_600_000 });
    await expect(second).resolves.toEqual({ expiresAt: T0 + 3_600_000 });
    expect(auth.token()).toBe('t1');
  });

  it('keeps a token that answers after GIS reported its popup closed — but none after a sign-out, and none unasked', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    gis.grant('stray');
    expect(auth.token()).toBeNull();
    // GIS checks every half second whether the popup closed: it can report
    // popup_closed just before the token of a consent completed at that moment.
    const session = auth.signIn({ prompt: '' });
    gis.fail('popup_closed');
    expect((await rejection(session)).reason).toBe('popup_closed');
    gis.grant('t1');
    expect(auth.token()).toBe('t1');
    await expect(auth.signOut()).resolves.toEqual({ revoked: true, hadToken: true });
    // An answer to a request made before the sign-out is not kept.
    gis.grant('late');
    expect(auth.token()).toBeNull();
  });

  it('fails ready() when the script does not load, or loads without GIS — and loads again on the next call', async () => {
    const gis = fakeGis();
    const timeout = new DriveError('Google Drive request failed (script-timeout)', 0, 'script-timeout');
    const load = vi
      .fn(async (_url: string) => {})
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(new TypeError('not a DriveError'));
    let ns: GoogleNs | undefined;
    const auth = createGisPopupAuth(CLIENT_ID, { load, google: () => ns, now: () => T0 });
    expect(await rejection(auth.ready())).toBe(timeout);
    expect((await rejection(auth.ready())).reason).toBe('script-failed');
    // Loaded, but without google.accounts.oauth2 (an extension stubbed it out).
    ns = {};
    expect((await rejection(auth.ready())).reason).toBe('script-failed');
    expect((await rejection(auth.signIn({ prompt: 'select_account' }))).reason).toBe('script-failed');
    // Defined after all (a load that outlasted its limit ran): used, not fetched again.
    ns = gis.google;
    await expect(auth.ready()).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(4);
    await auth.ready();
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('with the real loader, fetches GIS afresh when the script ran but defined nothing — a blocker’s empty stand-in', async () => {
    const doc = detachedDocument();
    const gis = fakeGis();
    // What the page's `google` is: nothing until a script defines it.
    const page: { google?: GoogleNs } = {};
    const auth = createGisPopupAuth(CLIENT_ID, {
      load: createScriptLoader({ document: () => doc }),
      google: () => page.google,
      now: () => T0,
    });
    const first = auth.ready();
    expect(scriptsIn(doc)).toHaveLength(1);
    scriptsIn(doc)[0].dispatchEvent(new Event('load'));
    expect((await rejection(first)).reason).toBe('script-failed');
    expect(scriptsIn(doc)).toEqual([]);
    const second = auth.ready();
    expect(scriptsIn(doc)).toHaveLength(1);
    page.google = gis.google;
    scriptsIn(doc)[0].dispatchEvent(new Event('load'));
    await expect(second).resolves.toBeUndefined();
    expect(gis.oauth2.initTokenClient).toHaveBeenCalledTimes(1);
  });

  it('with the real loader, uses GIS that ran after its load gave up, rather than fetching a second copy', async () => {
    vi.useFakeTimers();
    const doc = detachedDocument();
    const gis = fakeGis();
    // What the page's `google` is: nothing until a script defines it.
    const page: { google?: GoogleNs } = {};
    const auth = createGisPopupAuth(CLIENT_ID, {
      load: createScriptLoader({ document: () => doc }),
      google: () => page.google,
      now: () => T0,
    });
    const first = rejection(auth.ready());
    await vi.advanceTimersByTimeAsync(DRIVE_SCRIPT_TIMEOUT_MS);
    expect((await first).reason).toBe('script-timeout');
    // Removing the element did not stop the fetch: the script ran later.
    page.google = gis.google;
    await expect(auth.ready()).resolves.toBeUndefined();
    expect(scriptsIn(doc)).toEqual([]);
  });

  it('signs out by POSTing the token to Google’s revocation endpoint — in a form body, without cookies — forgotten at once', async () => {
    const { auth, gis, endpoint } = gisAuth();
    await auth.ready();
    const session = auth.signIn({ prompt: 'select_account' });
    gis.grant(TOKEN);
    await session;
    const out = auth.signOut();
    // Forgotten before Google answers: nothing can use it during the revocation.
    expect(auth.token()).toBeNull();
    await expect(out).resolves.toEqual({ revoked: true, hadToken: true });
    expect(endpoint.requests).toHaveLength(1);
    const [{ url, init }] = endpoint.requests;
    expect(url).toBe(DRIVE_REVOKE_URL);
    expect(init.method).toBe('POST');
    // The request GIS's own revoke makes: the token as a form field, the one
    // field — a CORS-safelisted body, so no preflight — and never in the URL
    // or a header.
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect([...(init.body as URLSearchParams).entries()]).toEqual([['token', TOKEN]]);
    expect(init.headers).toBeUndefined();
    expect([init.credentials, init.cache]).toEqual(['omit', 'no-store']);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Not through GIS's helper, which reports success for an answer it could not read.
    expect(gis.oauth2.revoke).not.toHaveBeenCalled();
  });

  it('revokes at the endpoint hosts.ts names, which the CSP admits for requests', () => {
    expect(DRIVE_REVOKE_URL).toBe('https://oauth2.googleapis.com/revoke');
    expect(DRIVE_HOSTS.connect as readonly string[]).toContain(new URL(DRIVE_REVOKE_URL).origin);
  });

  it('reports only Google’s own success as revoked: a refusal, a server error or no readable answer is unconfirmed', async () => {
    // A TypeError is what fetch gives offline, when the CSP refuses the
    // request, and when the answer lacks the CORS header the page needs to read it.
    const endpoint = revokeEndpoint(400, 503, new TypeError('Failed to fetch'), 200);
    const { auth, gis } = gisAuth({ endpoint });
    await auth.ready();
    for (const revoked of [false, false, false, true]) {
      const session = auth.signIn({ prompt: 'select_account' });
      gis.grant(TOKEN);
      await session;
      await expect(auth.signOut()).resolves.toEqual({ revoked, hadToken: true });
      expect(auth.token()).toBeNull();
    }
    expect(endpoint.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('abandons a revocation Google has not answered within 10 s as unconfirmed, and calls a fetch that throws unconfirmed at once', async () => {
    vi.useFakeTimers();
    const endpoint = revokeEndpoint('never');
    const { auth, gis } = gisAuth({ endpoint });
    await auth.ready();
    const session = auth.signIn({ prompt: 'select_account' });
    gis.grant(TOKEN);
    await session;
    let outcome: unknown = 'pending';
    void auth.signOut().then((r) => (outcome = r));
    await vi.advanceTimersByTimeAsync(DRIVE_REVOKE_TIMEOUT_MS - 1);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual({ revoked: false, hadToken: true });
    expect(endpoint.requests[0].init.signal?.aborted).toBe(true);

    const again = auth.signIn({ prompt: '' });
    gis.grant('t2');
    await again;
    endpoint.fetchImpl.mockImplementationOnce(() => {
      throw new TypeError('fetch is not available');
    });
    await expect(auth.signOut()).resolves.toEqual({ revoked: false, hadToken: true });
    expect(auth.token()).toBeNull();
  });

  it('without a token Google would still accept, signs out without a revocation', async () => {
    let now = T0;
    const { auth, gis, endpoint } = gisAuth({ now: () => now });
    // Never signed in.
    await expect(auth.signOut()).resolves.toEqual({ revoked: false, hadToken: false });
    await auth.ready();
    await expect(auth.signOut()).resolves.toEqual({ revoked: false, hadToken: false });
    // Signed in, but within a minute of expiry: forgotten, not revoked.
    const session = auth.signIn({ prompt: 'select_account' });
    gis.grant(TOKEN, 3600);
    await session;
    now = T0 + 3_600_000 - DRIVE_TOKEN_MARGIN_MS;
    await expect(auth.signOut()).resolves.toEqual({ revoked: false, hadToken: false });
    now = T0;
    expect(auth.token()).toBeNull();
    expect(endpoint.fetchImpl).not.toHaveBeenCalled();
  });

  it('ends a sign-in still waiting at sign-out, and keeps no token that answers after', async () => {
    const { auth, gis } = gisAuth();
    await auth.ready();
    const waiting = rejection(auth.signIn({ prompt: 'select_account' }));
    await expect(auth.signOut()).resolves.toEqual({ revoked: false, hadToken: false });
    const err = await waiting;
    expect(err).toBeInstanceOf(DriveAuthError);
    expect(err.reason).toBe('signed-out');
    gis.grant('late');
    expect(auth.token()).toBeNull();
  });

  it('ends a sign-in still waiting for the script at sign-out: no popup opens for it once the script is ready', async () => {
    let finish!: () => void;
    const { auth, gis } = gisAuth({ load: () => new Promise<void>((resolve) => (finish = resolve)) });
    const waiting = rejection(auth.signIn({ prompt: 'select_account' }));
    await expect(auth.signOut()).resolves.toEqual({ revoked: false, hadToken: false });
    finish();
    const err = await waiting;
    expect(err).toBeInstanceOf(DriveAuthError);
    expect(err.reason).toBe('signed-out');
    expect(gis.requests).toEqual([]);
    // The next sign-in, with the script ready, opens its popup at once.
    const session = auth.signIn({ prompt: 'select_account' });
    expect(gis.requests).toHaveLength(1);
    gis.grant();
    await expect(session).resolves.toEqual({ expiresAt: T0 + 3_600_000 });
  });

  it('keeps the token in its closure: not in JSON, keys, the session, storage or the console', async () => {
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const { auth, gis } = gisAuth();
    await auth.ready();
    const pending = auth.signIn({ prompt: 'select_account' });
    gis.grant(TOKEN);
    const session = await pending;
    expect(auth.token()).toBe(TOKEN);
    expect(JSON.stringify(auth)).not.toContain(TOKEN);
    expect(Object.keys(auth).sort()).toEqual(['ready', 'signIn', 'signOut', 'token']);
    expect(Object.keys(session)).toEqual(['expiresAt']);
    expect(JSON.stringify(session)).not.toContain(TOKEN);
    expect(storageText(localStorage)).not.toContain(TOKEN);
    expect(storageText(sessionStorage)).not.toContain(TOKEN);
    await expect(auth.signOut()).resolves.toEqual({ revoked: true, hadToken: true });
    for (const spy of logged) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    }
  });
});

describe('FakeDriveAuth — sign-in for the tests above the boundary', () => {
  it('issues tokens that expire like the real ones, and records each call as it is made', async () => {
    let now = T0;
    const auth = new FakeDriveAuth({ now: () => now });
    await auth.ready();
    const session = auth.signIn({ prompt: 'select_account' });
    // Recorded synchronously, at the call: what "inside the click" needs to see.
    expect(auth.calls).toEqual([{ op: 'ready' }, { op: 'signIn', prompt: 'select_account' }]);
    await expect(session).resolves.toEqual({ expiresAt: T0 + 3_600_000 });
    expect(auth.token()).toBe('fake-token-1');
    now = T0 + 3_600_000 - DRIVE_TOKEN_MARGIN_MS;
    expect(auth.token()).toBeNull();
    auth.expiresIn = 600;
    await expect(auth.signIn({ prompt: '', hint: 'alice@school.edu' })).resolves.toEqual({
      expiresAt: now + 600_000,
    });
    expect(auth.calls.at(-1)).toEqual({ op: 'signIn', prompt: '', hint: 'alice@school.edu' });
    expect(auth.token()).toBe('fake-token-2');
    expect(JSON.stringify(auth)).not.toContain('fake-token');
    auth.expire();
    expect(auth.token()).toBeNull();
  });

  it('fails the next sign-ins with the GIS codes queued, then signs in again', async () => {
    const auth = new FakeDriveAuth();
    auth.failNextSignIn('popup_closed', 'access_denied');
    for (const code of ['popup_closed', 'access_denied']) {
      const err = await rejection(auth.signIn({ prompt: '' }));
      expect(err).toBeInstanceOf(DriveAuthError);
      expect([err.status, err.reason, err.message]).toEqual([0, code, `Google Drive request failed (${code})`]);
    }
    expect(auth.token()).toBeNull();
    await auth.signIn({ prompt: '' });
    expect(auth.token()).toBe('fake-token-1');
  });

  it('revokes only a token it would still hand out, and reports what Google said', async () => {
    const auth = new FakeDriveAuth();
    await expect(auth.signOut()).resolves.toEqual({ revoked: false, hadToken: false });
    await auth.signIn({ prompt: 'select_account' });
    await expect(auth.signOut()).resolves.toEqual({ revoked: true, hadToken: true });
    expect(auth.token()).toBeNull();
    await auth.signIn({ prompt: 'select_account' });
    auth.revokeOk = false;
    await expect(auth.signOut()).resolves.toEqual({ revoked: false, hadToken: true });
    await auth.signIn({ prompt: 'select_account' });
    auth.expire();
    await expect(auth.signOut()).resolves.toEqual({ revoked: false, hadToken: false });
    expect(auth.calls.filter((c) => c.op === 'revoke')).toEqual([
      { op: 'revoke', token: 'fake-token-1' },
      { op: 'revoke', token: 'fake-token-2' },
    ]);
  });

  it('can hold the script load, so the loading state can be seen; a sign-in waits for it', async () => {
    const auth = new FakeDriveAuth({ loaded: false });
    const ready = auth.ready();
    const session = auth.signIn({ prompt: 'select_account' });
    expect(await hasSettled(ready)).toBe(false);
    expect(await hasSettled(session)).toBe(false);
    expect(auth.calls.map((c) => c.op)).toEqual(['ready', 'signIn']);
    auth.finishLoading();
    await ready;
    await session;
    expect(auth.token()).toBe('fake-token-1');
    await auth.ready();

    const failing = new FakeDriveAuth({ loaded: false });
    const first = failing.ready();
    const timeout = new DriveError('Google Drive request failed (script-timeout)', 0, 'script-timeout');
    failing.finishLoading(timeout);
    expect(await rejection(first)).toBe(timeout);
    const second = failing.ready();
    expect(await hasSettled(second)).toBe(false);
    failing.finishLoading();
    await expect(second).resolves.toBeUndefined();
  });

  it('ends a sign-in waiting for the script when a sign-out comes first, as the real one does — no token issued', async () => {
    const auth = new FakeDriveAuth({ loaded: false });
    auth.failNextSignIn('popup_closed');
    const waiting = rejection(auth.signIn({ prompt: '' }));
    await expect(auth.signOut()).resolves.toEqual({ revoked: false, hadToken: false });
    auth.finishLoading();
    const err = await waiting;
    expect(err).toBeInstanceOf(DriveAuthError);
    expect(err.reason).toBe('signed-out');
    expect(auth.token()).toBeNull();
    // Its popup never opened, so the queued failure is still the next sign-in's.
    expect((await rejection(auth.signIn({ prompt: '' }))).reason).toBe('popup_closed');
    await auth.signIn({ prompt: '' });
    expect(auth.token()).toBe('fake-token-1');
  });
});

/** One method call on a recorded Picker object. */
type PickerCall = [string, unknown[]];

/**
 * A stand-in for `gapi` and `google.picker`. Every `DocsView` and
 * `PickerBuilder` records each method called on it — whatever its name, so a
 * call the app should not make is seen too — and returns itself, as Google's
 * do. A test answers the Picker through the builder's callback, keyed by the
 * `Response`/`Document` constants; `gapi.load` answers per `loadAnswers`.
 */
function fakePicker(opts: { loadAnswers?: Array<'callback' | 'onerror' | 'never' | 'throw'> } = {}) {
  const views: Array<{ viewId?: string; calls: PickerCall[] }> = [];
  const viewObjects: object[] = [];
  const builders: Array<{ calls: PickerCall[]; visible?: unknown }> = [];
  const recorder = (calls: PickerCall[], special: Record<string, (...args: unknown[]) => unknown> = {}): object => {
    const self: object = new Proxy(
      {},
      {
        get: (_target, name) =>
          (...args: unknown[]) => {
            calls.push([String(name), args]);
            const own = special[String(name)];
            return own ? own(...args) : self;
          },
      },
    );
    return self;
  };
  class DocsView {
    constructor(viewId?: string) {
      const view = { viewId, calls: [] as PickerCall[] };
      views.push(view);
      const self = recorder(view.calls);
      viewObjects.push(self);
      return self as DocsView;
    }
  }
  class PickerBuilder {
    constructor() {
      const builder: { calls: PickerCall[]; visible?: unknown } = { calls: [] };
      builders.push(builder);
      return recorder(builder.calls, {
        build: () => ({ setVisible: (visible: unknown) => (builder.visible = visible) }),
      }) as PickerBuilder;
    }
  }
  const ns = {
    PickerBuilder,
    DocsView,
    ViewId: { DOCS: 'all' },
    Action: { PICKED: 'picked', CANCEL: 'cancel', LOADED: 'loaded', ERROR: 'error' },
    Response: { ACTION: 'action', DOCUMENTS: 'docs' },
    Document: { ID: 'id', NAME: 'name' },
  } as unknown as GooglePickerNs;
  const loadAnswers = [...(opts.loadAnswers ?? [])];
  const gapi = {
    load: vi.fn((_module: 'picker', handlers: { callback: () => void; onerror: () => void }) => {
      const answer = loadAnswers.shift() ?? 'callback';
      if (answer === 'throw') throw new Error('gapi.load failed');
      if (answer === 'callback') handlers.callback();
      if (answer === 'onerror') handlers.onerror();
    }),
  } satisfies GapiNs;
  /** The arguments of the one call of `method` on builder `b`. */
  const argsOf = (b: { calls: PickerCall[] }, method: string): unknown[] => {
    const calls = b.calls.filter(([name]) => name === method);
    expect(calls, method).toHaveLength(1);
    return calls[0][1];
  };
  return {
    ns,
    gapi,
    views,
    viewObjects,
    builders,
    argsOf,
    /** Answer the newest Picker, as Google calls back. */
    answer: (data: Record<string, unknown>) => {
      const callback = argsOf(builders.at(-1)!, 'setCallback')[0] as (data: Record<string, unknown>) => void;
      callback(data);
    },
  };
}

const PICKER_CFG = { apiKey: API_KEY, appId: '123456789012', origin: 'https://example.org' };

/**
 * `createGooglePicker` over {@link fakePicker}, with a script load that
 * succeeds at once. As on a page, `gapi` exists only once `api.js` has loaded.
 */
function googlePicker(fake = fakePicker()) {
  let onPage = false;
  const load = vi.fn(async (_url: string, _usable?: () => boolean) => {
    onPage = true;
  });
  const picker = createGooglePicker(PICKER_CFG, {
    load,
    gapi: () => (onPage ? fake.gapi : undefined),
    picker: () => fake.ns,
  });
  return { picker, fake, load };
}

describe('createGooglePicker — Google’s Picker, to browse or on one shared file', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('browses with two views — My Drive, then Shared with me — and the deployment’s key, project and origin', async () => {
    const { picker, fake, load } = googlePicker();
    const picked = picker.pick({ token: TOKEN });
    await flush();
    expect(load.mock.calls.map(([url]) => url)).toEqual([DRIVE_SCRIPTS.gapi]);
    // Loaded with a check that gapi was defined: an empty stand-in is a failure.
    expect(load.mock.calls[0][1]?.()).toBe(true);
    expect(fake.gapi.load.mock.calls.map(([module]) => module)).toEqual(['picker']);
    expect(fake.views).toEqual([
      {
        viewId: 'all',
        calls: [
          ['setIncludeFolders', [true]],
          ['setMimeTypes', [DRIVE_PICKER_MIME_TYPES]],
        ],
      },
      {
        viewId: 'all',
        calls: [
          ['setOwnedByMe', [false]],
          ['setIncludeFolders', [true]],
          ['setMimeTypes', [DRIVE_PICKER_MIME_TYPES]],
        ],
      },
    ]);
    expect(fake.builders).toHaveLength(1);
    const [builder] = fake.builders;
    const added = builder.calls.filter(([name]) => name === 'addView').map(([, args]) => args[0]);
    expect(added.length).toBe(2);
    expect(added[0] === fake.viewObjects[0] && added[1] === fake.viewObjects[1]).toBe(true);
    expect(fake.argsOf(builder, 'setDeveloperKey')).toEqual([API_KEY]);
    expect(fake.argsOf(builder, 'setAppId')).toEqual(['123456789012']);
    expect(fake.argsOf(builder, 'setOAuthToken')).toEqual([TOKEN]);
    expect(fake.argsOf(builder, 'setOrigin')).toEqual(['https://example.org']);
    expect(typeof fake.argsOf(builder, 'setCallback')[0]).toBe('function');
    expect(fake.argsOf(builder, 'build')).toEqual([]);
    expect(builder.visible).toBe(true);
    fake.answer({ action: 'cancel' });
    await expect(picked).resolves.toBeNull();
  });

  it('opened on shared files: one view, setFileIds with the ids joined by commas, and nothing else on it', async () => {
    const { picker, fake } = googlePicker();
    const picked = picker.pick({ token: TOKEN, fileIds: [ID, ID2] });
    await flush();
    // In particular no setOwnedByMe (it would hide a file shared WITH the
    // user), and no setParent or setEnableDrives (setFileIds overrides them).
    expect(fake.views).toEqual([{ viewId: 'all', calls: [['setFileIds', [`${ID},${ID2}`]]] }]);
    const [builder] = fake.builders;
    const added = builder.calls.filter(([name]) => name === 'addView').map(([, args]) => args[0]);
    expect(added.length === 1 && added[0] === fake.viewObjects[0]).toBe(true);
    expect(fake.argsOf(builder, 'setOAuthToken')).toEqual([TOKEN]);
    fake.answer({ action: 'picked', docs: [{ id: ID, name: 'Shared.sysml', mimeType: 'text/plain' }] });
    await expect(picked).resolves.toEqual({ id: ID, name: 'Shared.sysml' });
  });

  it('answers when the user picks or closes it — the dialog opening is no answer, and the first answer stands', async () => {
    const { picker, fake } = googlePicker();
    const picked = picker.pick({ token: TOKEN });
    await flush();
    fake.answer({ action: 'loaded' });
    expect(await hasSettled(picked)).toBe(false);
    fake.answer({ action: 'picked', docs: [{ id: ID, name: 'Mine.sysml' }, { id: ID2, name: 'Other.sysml' }] });
    fake.answer({ action: 'cancel' });
    await expect(picked).resolves.toEqual({ id: ID, name: 'Mine.sysml' });
    // A chosen file without a name still opens: Drive's own metadata names it.
    const unnamed = picker.pick({ token: TOKEN });
    await flush();
    fake.answer({ action: 'picked', docs: [{ id: ID2 }] });
    await expect(unnamed).resolves.toEqual({ id: ID2, name: '' });
  });

  it('rejects when the Picker reports an error, and still waits after it says it has opened', async () => {
    const { picker, fake } = googlePicker();
    const picked = picker.pick({ token: TOKEN });
    await flush();
    fake.answer({ action: 'loaded' });
    expect(await hasSettled(picked)).toBe(false);
    fake.answer({ action: 'error' });
    const err = await rejection(picked);
    expect([err.status, err.reason]).toEqual([0, 'picker-failed']);
    // A Picker without an ERROR action: an unknown action is no answer.
    const older = fakePicker();
    const withoutError = { ...older.ns, Action: { PICKED: 'picked', CANCEL: 'cancel' } } as GooglePickerNs;
    const p2 = createGooglePicker(PICKER_CFG, { load: async () => {}, gapi: () => older.gapi, picker: () => withoutError });
    const waiting = p2.pick({ token: TOKEN });
    await flush();
    older.answer({ action: 'error' });
    older.answer({});
    expect(await hasSettled(waiting)).toBe(false);
    older.answer({ action: 'cancel' });
    await expect(waiting).resolves.toBeNull();
  });

  it('refuses ids outside Drive’s alphabet — in fileIds before loading anything, and in the answer', async () => {
    const { picker, fake, load } = googlePicker();
    for (const fileIds of [[], ['../x'], [ID, 'short'], [`${ID}/`]]) {
      const err = await rejection(picker.pick({ token: TOKEN, fileIds }));
      expect([err.status, err.reason], JSON.stringify(fileIds)).toEqual([0, 'bad-ref']);
    }
    expect(load).not.toHaveBeenCalled();
    expect(fake.builders).toEqual([]);
    for (const docs of [[{ id: '../../x', name: 'x' }], [{ name: 'x' }], [], undefined, ['not-an-object']]) {
      const picked = picker.pick({ token: TOKEN });
      await flush();
      fake.answer({ action: 'picked', docs });
      const err = await rejection(picked);
      expect([err.status, err.reason], JSON.stringify(docs)).toEqual([0, 'bad-ref']);
    }
  });

  it('loads api.js and the picker module once, at the first pick; a failed module load is tried again at the next', async () => {
    const fake = fakePicker({ loadAnswers: ['onerror', 'throw'] });
    const { picker, load } = googlePicker(fake);
    expect(load).not.toHaveBeenCalled();
    const failed = await rejection(picker.pick({ token: TOKEN }));
    expect([failed.status, failed.reason]).toEqual([0, 'script-failed']);
    expect((await rejection(picker.pick({ token: TOKEN }))).reason).toBe('script-failed');
    for (let i = 0; i < 2; i++) {
      const picked = picker.pick({ token: TOKEN });
      await flush();
      fake.answer({ action: 'cancel' });
      await expect(picked).resolves.toBeNull();
    }
    // api.js stayed on the page: only the picker module was asked for again.
    expect(load.mock.calls.map(([url]) => url)).toEqual([DRIVE_SCRIPTS.gapi]);
    expect(fake.gapi.load).toHaveBeenCalledTimes(3);
  });

  it('passes a failed api.js load on, and fails cleanly when gapi or google.picker is missing after it', async () => {
    const timeout = new DriveError('Google Drive request failed (script-timeout)', 0, 'script-timeout');
    const fake = fakePicker();
    let gapi: GapiNs | undefined = undefined;
    let ns: GooglePickerNs | undefined = undefined;
    const load = vi.fn(async (_url: string) => {}).mockRejectedValueOnce(timeout);
    const picker = createGooglePicker(PICKER_CFG, { load, gapi: () => gapi, picker: () => ns });
    expect(await rejection(picker.pick({ token: TOKEN }))).toBe(timeout);
    expect((await rejection(picker.pick({ token: TOKEN }))).reason).toBe('script-failed');
    expect(load).toHaveBeenCalledTimes(2);
    // gapi defined after all (a late api.js ran): used, not fetched again.
    gapi = fake.gapi;
    expect((await rejection(picker.pick({ token: TOKEN }))).reason).toBe('script-failed');
    expect(load).toHaveBeenCalledTimes(2);
    ns = fake.ns;
    const picked = picker.pick({ token: TOKEN });
    await flush();
    fake.answer({ action: 'cancel' });
    await expect(picked).resolves.toBeNull();
  });

  it('gives up on a picker module that has not loaded within 15 s', async () => {
    vi.useFakeTimers();
    const { picker } = googlePicker(fakePicker({ loadAnswers: ['never'] }));
    let outcome = 'pending';
    picker.pick({ token: TOKEN }).then(
      () => (outcome = 'answered'),
      (e: DriveError) => (outcome = `${e.status} ${e.reason}`),
    );
    await vi.advanceTimersByTimeAsync(DRIVE_SCRIPT_TIMEOUT_MS - 1);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('0 script-timeout');
  });

  it('reports a Picker that throws while being built as picker-failed', async () => {
    const fake = fakePicker();
    const broken = {
      ...fake.ns,
      PickerBuilder: class {
        constructor() {
          throw new Error('The API developer key is invalid.');
        }
      },
    } as unknown as GooglePickerNs;
    const picker = createGooglePicker(PICKER_CFG, { load: async () => {}, gapi: () => fake.gapi, picker: () => broken });
    const err = await rejection(picker.pick({ token: TOKEN }));
    expect([err.status, err.reason, err.message]).toEqual([0, 'picker-failed', 'Google Drive request failed (picker-failed)']);
  });
});

describe('FakeDrivePicker — the Picker for the tests above it', () => {
  it('answers from its queue, grants what is picked, and closes when nothing is queued', async () => {
    const g = new InMemoryDriveGateway();
    g.seed({ id: ID, name: 'Shared.sysml', text: 'package S;\n', granted: false });
    const picker = new FakeDrivePicker({ onPicked: (id) => g.grant(id) });
    expect(await rejection(g.get({ id: ID }))).toBeInstanceOf(DriveNotFoundError);
    picker.answerNext({ id: ID, name: 'Shared.sysml' }, null);
    await expect(picker.pick({ token: 't1', fileIds: [ID] })).resolves.toEqual({ id: ID, name: 'Shared.sysml' });
    await expect(g.get({ id: ID })).resolves.toMatchObject({ id: ID, name: 'Shared.sysml' });
    await expect(picker.pick({ token: 't1' })).resolves.toBeNull();
    await expect(picker.pick({ token: 't1' })).resolves.toBeNull();
    const failure = new DriveError('Google Drive request failed (picker-failed)', 0, 'picker-failed');
    picker.answerNext(failure);
    expect(await rejection(picker.pick({ token: 't2' }))).toBe(failure);
    expect(picker.calls).toEqual([
      { token: 't1', fileIds: [ID] },
      { token: 't1' },
      { token: 't1' },
      { token: 't2' },
    ]);
  });

  it('refuses what the real Picker refuses, and an answer outside the files it was opened on', async () => {
    const picker = new FakeDrivePicker();
    for (const fileIds of [[], ['../x']]) {
      expect((await rejection(picker.pick({ token: 't', fileIds }))).reason).toBe('bad-ref');
    }
    picker.answerNext({ id: ID2, name: 'Other.sysml' });
    await expect(picker.pick({ token: 't', fileIds: [ID] })).rejects.toThrow(/not among the files/);
  });
});

// ---------------------------------------------------------------------------
// The Drive ▾ panel, over the store and the stand-ins above.
// ---------------------------------------------------------------------------

describe('DriveMenu — the Drive ▾ button and its panel', () => {
  const CONFIG = { clientId: CLIENT_ID, privacyUrl: VALID.privacyUrl };
  const EMAIL = 'student@example.org';
  const ACCOUNT = { email: EMAIL, name: 'Student' };
  const TEXT = 'package Swarm {\n    part def Drone;\n}\n';
  const RECENT: DriveFileMeta[] = [
    { ...META, id: ID, name: 'Swarm.sysml', resourceKey: KEY },
    { ...META, id: ID2, name: 'Fleet.sysml' },
  ];

  const st = () => useAppStore.getState();
  let auth: FakeDriveAuth;
  let gateway: InMemoryDriveGateway;
  /** Store actions a case replaced with a spy, put back after it. */
  let replaced: Partial<AppState> = {};

  /** A Drive file attached to the model, holding the text the Text view shows. */
  const attachedFile = (over: Partial<DriveFile> = {}): DriveFile => ({
    id: ID,
    name: 'Swarm.sysml',
    mimeType: 'text/plain',
    version: '1',
    modifiedTime: '2026-10-07T12:00:00.000Z',
    trashed: false,
    canEdit: true,
    webViewLink: `https://drive.google.com/file/d/${ID}/view`,
    savedText: TEXT,
    rewrites: false,
    rewriteAcknowledged: false,
    openedFrom: 'save-as',
    ...over,
  });

  const setDrive = (fields: Partial<DriveState>): void =>
    act(() => useAppStore.setState((s) => ({ drive: { ...s.drive, ...fields } })));

  /** Replace a store action with a spy, as the panel reaches it at the click. */
  function spyOn<K extends 'driveOpen' | 'driveSave' | 'driveSaveAs' | 'driveSignOut' | 'driveDetach' | 'driveCopyLink'>(
    name: K,
  ) {
    if (!(name in replaced)) Object.assign(replaced, { [name]: st()[name] });
    const spy = vi.fn(async () => {});
    useAppStore.setState({ [name]: spy } as Partial<AppState>);
    return spy;
  }

  const button = () => screen.getByTestId('tb-drive');
  const panel = () => screen.queryByTestId('drive-panel');
  const item = (id: string) => screen.getByTestId(id);
  const openPanel = (): void => {
    fireEvent.click(button());
    expect(panel()).not.toBeNull();
  };
  const show = () => render(React.createElement(DriveMenu));

  beforeEach(() => {
    auth = new FakeDriveAuth({ loaded: false });
    gateway = new InMemoryDriveGateway({ token: () => auth.token() });
    setDriveServices({ auth, gateway, picker: new FakeDrivePicker() });
    useAppStore.setState({
      textBuffer: TEXT,
      textDirty: false,
      serializeError: null,
      // Saved in this browser as it stands: only what a case changes is unsaved.
      savedText: TEXT,
      undoStack: [],
      redoStack: [],
      drive: { ...initialDriveState, configStatus: 'ready', config: CONFIG },
    });
  });

  afterEach(() => {
    cleanup(); // unmounted first: the reset below is not an update to a panel on screen
    useAppStore.setState({ ...replaced, drive: initialDriveState, undoStack: [], redoStack: [] });
    replaced = {};
    setDriveServices(null);
  });

  it('renders nothing at all on a deployment without Google Drive, or before its configuration is read', () => {
    for (const configStatus of ['absent', 'loading'] as const) {
      useAppStore.setState({ drive: { ...initialDriveState, configStatus } });
      const view = show();
      expect(view.container.innerHTML, configStatus).toBe('');
      view.unmount();
    }
    expect(auth.calls, 'nothing asked of Google').toEqual([]);
  });

  it('asks nothing of Google until it opens; then Sign in waits for the script, and its click asks for the account chooser at once', async () => {
    show();
    expect(button()).toHaveAttribute('data-status', 'signed-out');
    expect(button()).toHaveAttribute('data-file', '');
    expect(panel()).toBeNull();
    expect(auth.calls, 'a configured site loads no Google script until the panel opens').toEqual([]);

    openPanel();
    expect(auth.calls).toEqual([{ op: 'ready' }]);
    expect(item('drive-account')).toHaveTextContent('Not signed in');
    expect(item('tb-drive-signin')).toBeDisabled();
    expect(item('tb-drive-signin')).toHaveTextContent('Loading Google sign-in…');
    expect(item('drive-privacy')).toHaveAttribute('href', CONFIG.privacyUrl);
    expect(item('drive-privacy')).toHaveAttribute('rel', 'noopener noreferrer');
    for (const id of ['tb-drive-save', 'tb-drive-save-as', 'tb-drive-signout', 'drive-open-id']) {
      expect(screen.queryByTestId(id), `${id} needs a sign-in`).toBeNull();
    }

    await act(async () => auth.finishLoading());
    expect(item('tb-drive-signin')).toBeEnabled();
    expect(item('tb-drive-signin')).toHaveTextContent('Sign in to Google…');
    expect(item('tb-drive-signin')).toHaveAttribute('title', 'Choose your Google account');

    // Offline, the sign-in waits for the network, and says why.
    setDrive({ online: false });
    expect(item('tb-drive-signin')).toBeDisabled();
    expect(item('tb-drive-signin')).toHaveAttribute('title', 'Offline');
    setDrive({ online: true });
    expect(item('tb-drive-signin')).toBeEnabled();

    await act(async () => {
      fireEvent.click(item('tb-drive-signin'));
      // Synchronously, inside the click: the popup is the click's own.
      expect(auth.calls.filter((c) => c.op === 'signIn')).toEqual([{ op: 'signIn', prompt: 'select_account' }]);
      await vi.waitFor(() => expect(st().drive.busy).toBeNull());
    });
    expect(item('drive-account')).toHaveTextContent(`Signed in as ${EMAIL}`);
    expect(button()).toHaveAttribute('data-status', 'signed-in');
    expect(screen.queryByTestId('tb-drive-signin')).toBeNull();
    // No Picker key here, so no Browse Drive… to point to.
    expect(item('drive-recent-empty')).toHaveTextContent(/^No models saved from this app yet\.$/);
    setDrive({ config: { ...CONFIG, apiKey: API_KEY, appId: '123456789012' } });
    expect(item('drive-recent-empty')).toHaveTextContent(
      'No models saved from this app yet. Browse Drive… finds files shared with you.',
    );
  });

  it('says so when Google’s script did not load, instead of loading for ever, and tries again on the next opening — which clears the error once it loads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    show();
    openPanel();
    await act(async () => auth.finishLoading(new DriveError('Google Drive request failed (script-failed)', 0, 'script-failed')));
    expect(item('tb-drive-signin')).toBeDisabled();
    expect(item('tb-drive-signin')).toHaveTextContent('Google sign-in did not load');
    expect(item('tb-drive-signin')).toHaveAttribute('title', DRIVE_MESSAGES.scriptFailed);
    expect(button()).toHaveAttribute('data-status', 'error');

    fireEvent.click(button());
    expect(panel()).toBeNull();
    openPanel();
    expect(auth.calls.filter((c) => c.op === 'ready')).toHaveLength(2);
    expect(item('tb-drive-signin')).toHaveTextContent('Loading Google sign-in…');

    // It loads this time: the failure no longer holds, so neither do its
    // notice and the red dot.
    await act(async () => auth.finishLoading());
    expect(item('tb-drive-signin')).toBeEnabled();
    expect(item('tb-drive-signin')).toHaveTextContent('Sign in to Google…');
    expect(st().drive.notice).toBeNull();
    expect(button()).toHaveAttribute('data-status', 'signed-out');
  });

  it('signed in: Save and Save as, Recent, Browse with a Picker key, the paste field, Sign out', () => {
    setDrive({ account: ACCOUNT, authReady: true, recent: [] });
    show();
    openPanel();
    expect(item('drive-account')).toHaveTextContent(`Signed in as ${EMAIL}`);
    expect(item('tb-drive-save')).toBeDisabled();
    expect(item('tb-drive-save')).toHaveAttribute('title', 'No Drive file is open — Save to Drive as… writes one');
    expect(item('tb-drive-save')).toHaveTextContent('Save to Drive Ctrl+Shift+S');
    expect(item('tb-drive-save-as')).toBeEnabled();
    expect(item('drive-recent-empty')).toBeInTheDocument();
    expect(item('drive-recent-refresh')).toBeEnabled();
    expect(item('tb-drive-signout')).toBeEnabled();
    for (const id of ['tb-drive-signin', 'drive-recent-item', 'drive-copy-link', 'drive-open-in-drive', 'drive-close', 'tb-drive-browse']) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }

    setDrive({ recent: RECENT });
    const rows = screen.getAllByTestId('drive-recent-item');
    expect(rows.map((r) => [r.getAttribute('data-id'), r.getAttribute('data-name')])).toEqual([
      [ID, 'Swarm.sysml'],
      [ID2, 'Fleet.sysml'],
    ]);
    expect(rows[0]).toHaveTextContent(/^Swarm\.sysml · \d{2}:\d{2}/);
    expect(screen.queryByTestId('drive-recent-empty')).toBeNull();

    // The Picker needs the deployment's key and project number.
    setDrive({ config: { ...CONFIG, apiKey: API_KEY, appId: '123456789012' } });
    expect(item('tb-drive-browse')).toBeEnabled();

    // An account Drive would not name still reads as signed in.
    setDrive({ account: { email: null, name: null } });
    expect(item('drive-account')).toHaveTextContent('Signed in to Google');

    // Offline, or another Drive action running: what needs Drive waits, and says why.
    setDrive({ online: false });
    for (const id of ['tb-drive-save-as', 'tb-drive-browse', 'drive-recent-refresh']) {
      expect(item(id), id).toBeDisabled();
      expect(item(id)).toHaveAttribute('title', 'Offline');
    }
    expect(screen.getAllByTestId('drive-recent-item').every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    setDrive({ online: true, busy: 'listing' });
    expect(item('tb-drive-save-as')).toBeDisabled();
    expect(item('tb-drive-save-as')).toHaveAttribute('title', 'Reading your Drive…');
  });

  it('with a file attached: its link, Drive’s page for it, Close — and Save only when there is something to save', () => {
    setDrive({ account: ACCOUNT, authReady: true, recent: [], file: attachedFile() });
    show();
    expect(button()).toHaveAttribute('data-file', 'Swarm.sysml');
    expect(button()).toHaveAttribute('data-status', 'signed-in');
    openPanel();
    expect(item('drive-copy-link')).toHaveAttribute('data-link', driveLink(st()));
    expect(item('drive-copy-link').getAttribute('data-link')).toMatch(new RegExp(`\\?drive=${ID}$`));
    expect(item('drive-open-in-drive')).toBeInTheDocument();
    expect(item('drive-close')).toBeInTheDocument();
    expect(item('tb-drive-save')).toBeDisabled();
    expect(item('tb-drive-save')).toHaveAttribute('title', 'No unsaved changes');

    act(() => useAppStore.setState({ textBuffer: TEXT.replace('Drone', 'Kite') }));
    expect(item('tb-drive-save')).toBeEnabled();
    expect(button()).toHaveAttribute('data-status', 'attention');

    const reasons: Array<[Partial<DriveState>, string]> = [
      [{ online: false }, 'Offline'],
      [{ busy: 'saving' }, 'Saving to Drive…'],
      [{ file: attachedFile({ canEdit: false }) }, 'You have view access only — Save to Drive as… keeps your own copy'],
      [{ file: attachedFile({ trashed: true }) }, 'Swarm.sysml is no longer in Drive — Save to Drive as… writes a new file'],
    ];
    for (const [fields, title] of reasons) {
      setDrive(fields);
      expect(item('tb-drive-save'), title).toBeDisabled();
      expect(item('tb-drive-save')).toHaveAttribute('title', title);
      setDrive({ online: true, busy: null, file: attachedFile() });
    }

    // A link Drive's metadata names somewhere else is not offered.
    setDrive({ file: attachedFile({ webViewLink: 'https://example.org/file/d/x/view' }) });
    expect(screen.queryByTestId('drive-open-in-drive')).toBeNull();
    setDrive({ file: attachedFile({ webViewLink: undefined }) });
    expect(screen.queryByTestId('drive-open-in-drive')).toBeNull();
  });

  it('Save, Save as and Drive’s page go on outside the panel, which closes for them', () => {
    const save = spyOn('driveSave');
    const saveAs = spyOn('driveSaveAs');
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    setDrive({ account: ACCOUNT, authReady: true, recent: [], file: attachedFile() });
    act(() => useAppStore.setState({ textBuffer: TEXT.replace('Drone', 'Kite') }));
    show();

    openPanel();
    fireEvent.click(item('tb-drive-save'));
    expect(save).toHaveBeenCalledWith();
    expect(panel()).toBeNull();

    openPanel();
    fireEvent.click(item('tb-drive-save-as'));
    expect(saveAs).toHaveBeenCalledWith();
    expect(panel()).toBeNull();

    openPanel();
    fireEvent.click(item('drive-open-in-drive'));
    expect(opened).toHaveBeenCalledWith(`https://drive.google.com/file/d/${ID}/view`, '_blank', 'noopener,noreferrer');
    expect(panel()).toBeNull();
  });

  it('copies the file’s link — and when the clipboard refuses, closes, and the strip shows the link to copy by hand', async () => {
    setDrive({ account: ACCOUNT, authReady: true, recent: [], file: attachedFile() });
    const copy = spyOn('driveCopyLink');
    render(React.createElement(React.Fragment, null, React.createElement(DriveMenu), React.createElement(DriveStrip)));
    openPanel();
    await act(async () => fireEvent.click(item('drive-copy-link')));
    expect(item('drive-copy-link')).toHaveTextContent('Link copied');
    expect(screen.queryByTestId('drive-link-text')).toBeNull();

    copy.mockRejectedValueOnce(new Error('clipboard refused'));
    fireEvent.click(button());
    openPanel();
    expect(item('drive-copy-link')).toHaveTextContent('Copy link to this file');
    await act(async () => fireEvent.click(item('drive-copy-link')));
    // Out from under the panel: the strip's field, in focus, ready to copy.
    expect(panel()).toBeNull();
    const field = item('drive-link-text');
    expect(field.closest('[data-testid="drive-strip"]')).not.toBeNull();
    expect(field).toHaveValue(driveLink(st()));
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveFocus();
    expect(screen.getAllByDisplayValue(driveLink(st())!), 'shown once, in the strip').toHaveLength(1);
  });

  it('every command here that replaces the model, or lets go of the file, goes through the guard first', () => {
    const detach = spyOn('driveDetach');
    const signOut = spyOn('driveSignOut');
    const open = spyOn('driveOpen');
    setDrive({ account: ACCOUNT, authReady: true, recent: RECENT, file: attachedFile() });
    show();

    // Clean: Sign out runs at once — inside the click, where its sign-in
    // window may open — and the panel stays to show who is signed in.
    openPanel();
    fireEvent.click(item('tb-drive-signout'));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(panel()).not.toBeNull();

    // Unsaved Drive changes: Close and Sign out ask in the strip first, and
    // the panel gets out of the question's way.
    act(() => useAppStore.setState({ textBuffer: TEXT.replace('Drone', 'Kite') }));
    for (const [id, label, spy] of [
      ['drive-close', 'Close Drive file', detach],
      ['tb-drive-signout', 'Sign out', signOut],
    ] as const) {
      spy.mockClear();
      if (panel() === null) openPanel();
      fireEvent.click(item(id));
      expect(st().drive.prompt, id).toEqual({ kind: 'guard', label, variant: 'dirty' });
      expect(spy, `${id} waits for the answer`).not.toHaveBeenCalled();
      expect(panel()).toBeNull();
      act(() => void st().driveRunPending('discard'));
      expect(spy, `${id} runs once the user goes on`).toHaveBeenCalledTimes(1);
    }

    // No Drive file, and work no save holds: Sign out keeps the model, so it
    // has nothing to ask — it runs at once, inside the click, where its
    // sign-in window may open.
    setDrive({ file: null });
    expect(browserDirty(st())).toBe(true);
    signOut.mockClear();
    openPanel();
    fireEvent.click(item('tb-drive-signout'));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(st().drive.prompt).toBeNull();

    // Opening from Drive replaces the model: it asks first.
    if (panel() === null) openPanel();
    fireEvent.click(screen.getAllByTestId('drive-recent-item')[0]);
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'Open from Drive', variant: 'open' });
    expect(open).not.toHaveBeenCalled();
    act(() => void st().driveRunPending('open-anyway'));
    // The row's resource key goes with it.
    expect(open).toHaveBeenCalledWith({ id: ID, resourceKey: KEY }, 'recent');

    // Nothing to lose — saved, however long Undo's history: the open runs at
    // once, and the panel closes for it.
    act(() =>
      useAppStore.setState((s) => ({ savedText: s.textBuffer, undoStack: [{} as AppState['undoStack'][number]] })),
    );
    openPanel();
    fireEvent.click(screen.getAllByTestId('drive-recent-item')[1]);
    expect(open).toHaveBeenLastCalledWith({ id: ID2 }, 'recent');
    expect(panel()).toBeNull();
  });

  it('the paste field opens what it can read as a Drive file, and nothing else', () => {
    const open = spyOn('driveOpen');
    setDrive({ account: ACCOUNT, authReady: true, recent: [] });
    show();
    openPanel();
    const field = item('drive-open-id');
    for (const text of ['', 'not a link', 'https://example.org/file/d/x', `https://drive.google.com/file/d/../x/view`]) {
      fireEvent.change(field, { target: { value: text } });
      expect(item('drive-open-id-go'), text).toBeDisabled();
      fireEvent.keyDown(field, { key: 'Enter' });
    }
    expect(open).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: ` https://drive.google.com/file/d/${ID}/view?resourcekey=${KEY} ` } });
    expect(item('drive-open-id-go')).toBeEnabled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(open).toHaveBeenCalledWith({ id: ID, resourceKey: KEY }, 'paste');
    expect(panel()).toBeNull();

    openPanel();
    expect(item('drive-open-id')).toHaveValue('');
    fireEvent.change(item('drive-open-id'), { target: { value: ID2 } });
    fireEvent.click(item('drive-open-id-go'));
    expect(open).toHaveBeenLastCalledWith({ id: ID2 }, 'paste');
  });

  it('closes on Escape and on a click outside it, not on one inside', () => {
    setDrive({ account: ACCOUNT, authReady: true, recent: [] });
    show();
    openPanel();
    fireEvent.mouseDown(item('drive-account'));
    expect(panel()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel()).toBeNull();
    openPanel();
    fireEvent.mouseDown(document.body);
    expect(panel()).toBeNull();
  });

  it('the dot: an error, else signed out, else something waiting for the user, else signed in', () => {
    const signedIn: DriveState = { ...initialDriveState, configStatus: 'ready', config: CONFIG, account: ACCOUNT };
    const error = { kind: 'error' as const, message: 'x', retryable: false };
    expect(driveMenuStatus(initialDriveState, false)).toBe('signed-out');
    expect(driveMenuStatus({ ...initialDriveState, notice: error }, false)).toBe('error');
    expect(driveMenuStatus(signedIn, false)).toBe('signed-in');
    expect(driveMenuStatus({ ...signedIn, notice: { ...error, kind: 'info' } }, false)).toBe('signed-in');
    expect(driveMenuStatus({ ...signedIn, prompt: { kind: 'saveas', suggested: 'a.sysml', asCopy: false } }, false)).toBe(
      'signed-in',
    );
    const waiting: Array<[string, DriveState, boolean]> = [
      ['unsaved changes', signedIn, true],
      ['a conflict', { ...signedIn, conflict: { remote: RECENT[0] } }, false],
      ['a sign-in to renew', { ...signedIn, pending: { op: 'save' } }, false],
      ['a guard', { ...signedIn, prompt: { kind: 'guard', label: 'New', variant: 'dirty' } }, false],
      ['a rewrite question', { ...signedIn, prompt: { kind: 'rewrite' } }, false],
      ['a file gone from Drive', { ...signedIn, file: attachedFile({ trashed: true }) }, false],
    ];
    for (const [what, d, dirty] of waiting) expect(driveMenuStatus(d, dirty), what).toBe('attention');
    expect(driveMenuStatus({ ...signedIn, notice: error }, true), 'an error first').toBe('error');
    // The question about work no save holds is not Drive's.
    expect(
      driveMenuStatus({ ...signedIn, prompt: { kind: 'guard', label: 'New', variant: 'browser' } }, false),
    ).toBe('signed-in');
  });
});

describe('Toolbar — where Drive ▾ sits, and the commands that replace the model', () => {
  const CONFIG = { clientId: CLIENT_ID, privacyUrl: VALID.privacyUrl };
  const TEXT = 'package Swarm {\n    part def Drone;\n}\n';
  const FILE: DriveFile = {
    ...META,
    savedText: TEXT,
    rewrites: false,
    rewriteAcknowledged: false,
    openedFrom: 'save-as',
  };
  const st = () => useAppStore.getState();
  let replaced: Partial<AppState> = {};
  // jsdom has no ResizeObserver, which the toolbar's overflow measure uses: a
  // stand-in that never reports. jsdom lays nothing out, so every command that
  // can give way sits under More ▾ — and is reached there, as on a narrow bar.
  let addedObserver = false;

  beforeAll(() => {
    if (!('ResizeObserver' in globalThis)) {
      addedObserver = true;
      Object.assign(globalThis, {
        ResizeObserver: class {
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
        },
      });
    }
  });
  afterAll(() => {
    if (addedObserver) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  /** Replace store actions with spies, as the toolbar reads them; put back after the case. */
  function spies<K extends 'newProject' | 'loadProject' | 'listProjects' | 'saveProject' | 'driveSave'>(...names: K[]) {
    const made = {} as Record<K, ReturnType<typeof vi.fn>>;
    for (const name of names) {
      if (!(name in replaced)) Object.assign(replaced, { [name]: st()[name] });
      made[name] = vi.fn(async () => {});
    }
    useAppStore.setState(made as unknown as Partial<AppState>);
    return made;
  }

  beforeEach(() => {
    useAppStore.setState({
      textBuffer: TEXT,
      textDirty: false,
      serializeError: null,
      savedText: TEXT,
      undoStack: [],
      redoStack: [],
      projectName: 'Swarm',
      drive: { ...initialDriveState, configStatus: 'ready', config: CONFIG },
    });
  });
  afterEach(() => {
    cleanup();
    useAppStore.setState({ ...replaced, drive: initialDriveState, undoStack: [], redoStack: [] });
    replaced = {};
  });

  it('puts Drive ▾ immediately left of Collaborate — and nothing at all there without Google Drive', () => {
    const view = render(React.createElement(Toolbar));
    const drive = view.getByTestId('tb-drive').closest('.toolbar-drive');
    expect(drive?.nextElementSibling).toBe(view.getByTestId('tb-collab').closest('.toolbar-collab'));
    expect(drive?.previousElementSibling).toHaveClass('toolbar-spacer');
    view.unmount();

    useAppStore.setState({ drive: initialDriveState });
    const plain = render(React.createElement(Toolbar));
    expect(plain.queryByTestId('tb-drive')).toBeNull();
    expect(plain.container.querySelector('.toolbar-spacer')?.nextElementSibling).toHaveClass('toolbar-collab');
  });

  it('every command on the bar gives way under More ▾ in COLLAPSE_ORDER, or is pinned — Drive ▾ too', () => {
    // jsdom lays nothing out, so this is the bar at its narrowest: every
    // command COLLAPSE_ORDER lets go is under More ▾, and what is left on the
    // bar is what never leaves it. A command added to the bar in neither list
    // would stay there too, without anyone deciding it should. A control is
    // anything a user can reach or a spec can click: a native control, an
    // interactive role, anything focusable, and anything with a `tb-` test id.
    const view = render(React.createElement(Toolbar));
    const bar = view.container.querySelector('.toolbar')!;
    const roles = [
      'button', 'link', 'switch', 'checkbox', 'radio', 'tab', 'combobox',
      'slider', 'spinbutton', 'textbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    ];
    const controls = [
      'button, a, input, select, textarea, [tabindex], [data-testid^="tb-"]',
      ...roles.map((r) => `[role="${r}"]`),
    ].join(', ');
    const onBar = [...bar.querySelectorAll<HTMLElement>(controls)].map(
      (el) => el.dataset.testid ?? `<${el.localName}> "${el.textContent?.trim()}" (no test id)`,
    );
    const pinned = new Set<string>(PINNED_COMMANDS);
    expect(
      onBar.filter((id) => id !== 'tb-more' && !pinned.has(id)),
      'on the bar at its narrowest, yet not pinned: put each in COLLAPSE_ORDER or PINNED_COMMANDS (Toolbar.tsx)',
    ).toEqual([]);
    expect(PINNED_COMMANDS.filter((id) => !onBar.includes(id)), 'pinned, yet not on the bar').toEqual([]);
    expect(COLLAPSE_ORDER.filter((id) => pinned.has(id)), 'both pinned and let go').toEqual([]);

    fireEvent.click(view.getByTestId('tb-more'));
    const under = [...screen.getByTestId('tb-more-menu').querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(
      under.map((el) => el.dataset.testid),
      'what More ▾ holds at the narrowest bar, first to give way first',
    ).toEqual([...COLLAPSE_ORDER]);
  });

  it('Save saves in this browser — and, with a Drive file attached, to that file too', () => {
    const { saveProject, driveSave } = spies('saveProject', 'driveSave');
    const view = render(React.createElement(Toolbar));
    expect(view.getByTestId('tb-save')).toHaveAttribute('title', 'Save project "Swarm"');
    fireEvent.click(view.getByTestId('tb-save'));
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(driveSave).not.toHaveBeenCalled();

    act(() => useAppStore.setState((s) => ({ drive: { ...s.drive, file: FILE } })));
    expect(view.getByTestId('tb-save')).toHaveAttribute('title', 'Save to Drive: Swarm.sysml (and this browser)');
    // The file holds the model already: the browser save, and nothing for Drive.
    fireEvent.click(view.getByTestId('tb-save'));
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(driveSave).not.toHaveBeenCalled();

    act(() => useAppStore.setState({ textBuffer: TEXT.replace('Drone', 'Kite') }));
    fireEvent.click(view.getByTestId('tb-save'));
    expect(driveSave).toHaveBeenCalledWith({ alsoInBrowser: true });
    expect(saveProject, 'the browser save is driveSave’s to make, after the typed text is applied').toHaveBeenCalledTimes(2);
  });

  it('New and Open ask first while the attached Drive file has unsaved changes, and run at once otherwise', async () => {
    const { newProject, loadProject, listProjects } = spies('newProject', 'loadProject', 'listProjects');
    listProjects.mockResolvedValue(['Alpha']);
    useAppStore.setState((s) => ({ drive: { ...s.drive, file: FILE } }));
    const view = render(React.createElement(Toolbar));
    /** Click New, on the bar or under More ▾ (the same test id either way). */
    const clickNew = (): void => {
      if (screen.queryByTestId('tb-new') === null) fireEvent.click(view.getByTestId('tb-more'));
      fireEvent.click(screen.getByTestId('tb-new'));
    };

    // Saved: New runs at once.
    clickNew();
    expect(newProject).toHaveBeenCalledTimes(1);

    // Unsaved Drive changes: the strip asks, and New waits for the answer.
    act(() => useAppStore.setState({ textBuffer: TEXT.replace('Drone', 'Kite') }));
    clickNew();
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'New', variant: 'dirty' });
    expect(newProject).toHaveBeenCalledTimes(1);
    act(() => void st().driveRunPending('keep'));
    expect(newProject).toHaveBeenCalledTimes(1);

    await act(async () => fireEvent.click(view.getByTestId('tb-open')));
    fireEvent.click(await view.findByTestId('project-pick'));
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'Open', variant: 'dirty' });
    expect(loadProject).not.toHaveBeenCalled();
    await act(async () => st().driveRunPending('discard'));
    expect(loadProject).toHaveBeenCalledWith('Alpha');

    // A file gone from Drive holds nothing any more: with no changes to it
    // unsaved, the question is the one about work no save holds.
    act(() =>
      useAppStore.setState((s) => ({
        textBuffer: TEXT,
        savedText: 'package Elsewhere;\n',
        drive: { ...s.drive, prompt: null, file: { ...FILE, trashed: true } },
      })),
    );
    clickNew();
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
    expect(newProject).toHaveBeenCalledTimes(1);
    act(() => void st().driveRunPending('keep'));

    // With changes unsaved to it too — the usual case: a save or a reload is
    // what finds a file gone — no Save to Drive can keep them, and the
    // question is still this browser's; none once the browser holds them.
    act(() => useAppStore.setState({ textBuffer: TEXT.replace('Drone', 'Kite') }));
    expect(driveDirty(st())).toBe(true);
    clickNew();
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
    expect(newProject).toHaveBeenCalledTimes(1);
    act(() => void st().driveRunPending('keep'));
    act(() => useAppStore.setState({ savedText: TEXT.replace('Drone', 'Kite') }));
    clickNew();
    expect(st().drive.prompt).toBeNull();
    expect(newProject).toHaveBeenCalledTimes(2);
  });

  it('without Google Drive, New and Open ask first while the model has unsaved work, and run at once while it is saved', async () => {
    const { newProject, loadProject, listProjects } = spies('newProject', 'loadProject', 'listProjects');
    listProjects.mockResolvedValue(['Alpha']);
    useAppStore.setState({ drive: initialDriveState, savedText: TEXT });
    const view = render(React.createElement(Toolbar));
    const clickNew = (): void => {
      if (screen.queryByTestId('tb-new') === null) fireEvent.click(view.getByTestId('tb-more'));
      fireEvent.click(screen.getByTestId('tb-new'));
    };

    // Saved (here: as the session started): New runs at once.
    clickNew();
    expect(newProject).toHaveBeenCalledTimes(1);
    expect(st().drive.prompt).toBeNull();

    // An edit nothing holds: the strip asks, in this browser's words.
    act(() => useAppStore.setState({ textBuffer: TEXT.replace('Drone', 'Kite') }));
    clickNew();
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
    expect(newProject).toHaveBeenCalledTimes(1);
    act(() => void st().driveRunPending('keep'));
    expect(newProject).toHaveBeenCalledTimes(1);

    await act(async () => fireEvent.click(view.getByTestId('tb-open')));
    fireEvent.click(await view.findByTestId('project-pick'));
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'Open', variant: 'browser' });
    expect(loadProject).not.toHaveBeenCalled();
    await act(async () => st().driveRunPending('discard'));
    expect(loadProject).toHaveBeenCalledWith('Alpha');

    // The command table's New asks as the button does.
    act(() => void commandById('tb-new')!.run());
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
    expect(newProject).toHaveBeenCalledTimes(1);
    act(() => void st().driveRunPending('keep'));
  });
});

/**
 * The commands outside the toolbar's File group that load another model in
 * place of this one: a branch switch and a merge (`switchBranch` loads the
 * merged head) in the Versions tab, and a room join under Collaborate. Each
 * goes through the guard as New does — Drive's question with a Drive file
 * attached, this browser's without — and never detaches a file with unsaved
 * changes unasked.
 */
describe('Versions and Collaborate — a branch switch, a merge that loads and a room join ask first', () => {
  const CONFIG = { clientId: CLIENT_ID, privacyUrl: VALID.privacyUrl };
  const TEXT = 'package Swarm {\n    part def Drone;\n}\n';
  const EDITED = TEXT.replace('Drone', 'Kite');
  const FILE: DriveFile = {
    ...META,
    savedText: TEXT,
    rewrites: false,
    rewriteAcknowledged: false,
    openedFrom: 'save-as',
  };
  const st = () => useAppStore.getState();
  let replaced: Partial<AppState> = {};

  /** Replace store actions with spies, as the panels read them; put back after the case. */
  function spies<K extends 'switchBranch' | 'mergeBranchesCmd' | 'connectCollab'>(...names: K[]) {
    const made = {} as Record<K, ReturnType<typeof vi.fn>>;
    for (const name of names) {
      if (!(name in replaced)) Object.assign(replaced, { [name]: st()[name] });
      made[name] = vi.fn();
    }
    useAppStore.setState(made as unknown as Partial<AppState>);
    return made;
  }
  /** A Drive file attached — with unsaved changes, as the text was edited. */
  const attachDrive = (): void =>
    act(() => useAppStore.setState({ drive: { ...initialDriveState, configStatus: 'ready', config: CONFIG, file: FILE } }));

  beforeEach(() => {
    useAppStore.setState({
      textBuffer: TEXT,
      textDirty: false,
      serializeError: null,
      savedText: TEXT,
      projectName: 'Swarm',
      drive: initialDriveState,
    });
  });
  afterEach(() => {
    cleanup();
    useAppStore.setState({ ...replaced, drive: initialDriveState });
    replaced = {};
  });

  it('the Versions tab switches and merges at once while the model is saved, and asks first otherwise', async () => {
    const { switchBranch, mergeBranchesCmd } = spies('switchBranch', 'mergeBranchesCmd');
    const view = render(React.createElement(BottomPanel));
    fireEvent.click(view.getByTestId('tab-versions'));
    const branch = await view.findByTestId('version-branch');

    fireEvent.click(branch);
    fireEvent.click(view.getByTestId('version-merge-btn'));
    expect(switchBranch).toHaveBeenCalledTimes(1);
    expect(mergeBranchesCmd).toHaveBeenCalledTimes(1);
    expect(st().drive.prompt).toBeNull();

    act(() => useAppStore.setState({ textBuffer: EDITED }));
    fireEvent.click(branch);
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'Switch branch', variant: 'browser' });
    expect(switchBranch).toHaveBeenCalledTimes(1);
    await act(async () => st().driveRunPending('discard'));
    expect(switchBranch).toHaveBeenCalledTimes(2);
    fireEvent.click(view.getByTestId('version-merge-btn'));
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'Merge', variant: 'browser' });
    await act(async () => st().driveRunPending('keep'));
    expect(mergeBranchesCmd).toHaveBeenCalledTimes(1);

    // An attached Drive file with unsaved changes: Drive's question, which a
    // switch or a merge used to skip, detaching the file unasked.
    attachDrive();
    fireEvent.click(branch);
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'Switch branch', variant: 'dirty' });
    await act(async () => st().driveRunPending('keep'));
    fireEvent.click(view.getByTestId('version-merge-btn'));
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'Merge', variant: 'dirty' });
    await act(async () => st().driveRunPending('discard'));
    expect(switchBranch).toHaveBeenCalledTimes(2);
    expect(mergeBranchesCmd).toHaveBeenCalledTimes(2);

    // A merge that would meet conflicts (`manual`) loads nothing: it runs at
    // once, unsaved work or not.
    act(() => useAppStore.setState({ drive: initialDriveState }));
    const wouldApply = vi.spyOn(st().api.repository, 'mergeWouldApply').mockReturnValue(false);
    try {
      fireEvent.click(view.getByTestId('version-merge-btn'));
      expect(wouldApply).toHaveBeenCalledWith(st().api.projectId, expect.any(String), expect.any(String), {
        strategy: 'manual',
      });
      expect(mergeBranchesCmd).toHaveBeenCalledTimes(3);
      expect(st().drive.prompt).toBeNull();
    } finally {
      wouldApply.mockRestore();
    }
  });

  it('Collaborate joins a room at once while the model is saved, and asks first otherwise — from Connect and from Enter', async () => {
    const { connectCollab } = spies('connectCollab');
    const view = render(React.createElement(Collaborate));
    fireEvent.click(view.getByTestId('tb-collab'));
    fireEvent.change(view.getByTestId('collab-room'), { target: { value: 'swarm' } });

    fireEvent.click(view.getByTestId('collab-connect'));
    expect(connectCollab).toHaveBeenCalledTimes(1);
    expect(connectCollab).toHaveBeenLastCalledWith('swarm');
    expect(st().drive.prompt).toBeNull();

    act(() => useAppStore.setState({ textBuffer: EDITED }));
    fireEvent.click(view.getByTestId('collab-connect'));
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'Join room', variant: 'browser' });
    await act(async () => st().driveRunPending('keep'));
    fireEvent.keyDown(view.getByTestId('collab-room'), { key: 'Enter' });
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'Join room', variant: 'browser' });
    await act(async () => st().driveRunPending('discard'));
    expect(connectCollab).toHaveBeenCalledTimes(2);

    attachDrive();
    fireEvent.click(view.getByTestId('collab-connect'));
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'Join room', variant: 'dirty' });
    await act(async () => st().driveRunPending('keep'));
    expect(connectCollab).toHaveBeenCalledTimes(2);
  });
});

describe('DriveStrip — the strip under the toolbar, and the gate a ?drive= link holds', () => {
  const CONFIG = { clientId: CLIENT_ID, privacyUrl: VALID.privacyUrl };
  const PICKER_CONFIG = { ...CONFIG, apiKey: API_KEY, appId: '123456789012' };
  const ACCOUNT = { email: 'student@example.org', name: 'Student' };
  const TEXT = 'package Swarm {\n    part def Drone;\n}\n';
  const EDITED = TEXT.replace('Drone', 'Kite');

  const st = () => useAppStore.getState();
  let auth: FakeDriveAuth;
  let gateway: InMemoryDriveGateway;
  /** Store actions a case replaced with a spy, put back after it. */
  let replaced: Partial<AppState> = {};

  const FILE: DriveFile = {
    ...META,
    savedText: TEXT,
    rewrites: false,
    rewriteAcknowledged: false,
    openedFrom: 'save-as',
  };
  const attachedFile = (over: Partial<DriveFile> = {}): DriveFile => ({ ...FILE, ...over });

  const setDrive = (fields: Partial<DriveState>): void =>
    act(() => useAppStore.setState((s) => ({ drive: { ...s.drive, ...fields } })));
  const setText = (textBuffer: string): void => act(() => useAppStore.setState({ textBuffer }));

  type Spied =
    | 'driveSave'
    | 'driveSaveAs'
    | 'driveOpen'
    | 'driveBrowse'
    | 'driveCopyLink'
    | 'driveRetry'
    | 'driveResume'
    | 'driveLinkRetry'
    | 'driveRunPending'
    | 'driveResolveConflict'
    | 'driveAcknowledgeRewrite'
    | 'saveProject';
  /** Replace a store action with a spy, as the strip reaches it at the click. */
  function spyOn(name: Spied) {
    if (!(name in replaced)) Object.assign(replaced, { [name]: st()[name] });
    const spy = vi.fn(async (..._args: unknown[]) => {});
    useAppStore.setState({ [name]: spy } as Partial<AppState>);
    return spy;
  }

  const strip = () => screen.queryByTestId('drive-strip');
  const status = () => strip()?.getAttribute('data-status') ?? null;
  const item = (id: string) => screen.getByTestId(id);
  const absent = (...ids: string[]): void => {
    for (const id of ids) expect(screen.queryByTestId(id), id).toBeNull();
  };
  const show = () => render(React.createElement(DriveStrip));
  const showGate = () => render(React.createElement(DriveLinkGate));
  const signIns = () => auth.calls.filter((c) => c.op === 'signIn');

  beforeEach(() => {
    auth = new FakeDriveAuth({ loaded: false });
    gateway = new InMemoryDriveGateway({ token: () => auth.token() });
    setDriveServices({ auth, gateway, picker: new FakeDrivePicker() });
    useAppStore.setState({
      textBuffer: TEXT,
      textDirty: false,
      serializeError: null,
      undoStack: [],
      redoStack: [],
      projectName: 'Swarm',
      linkedModel: null,
      drive: { ...initialDriveState, configStatus: 'ready', config: CONFIG },
    });
  });

  afterEach(() => {
    cleanup(); // unmounted first: the reset below is not an update to a strip on screen
    useAppStore.setState({ ...replaced, drive: initialDriveState, undoStack: [], redoStack: [], linkedModel: null });
    replaced = {};
    setDriveServices(null);
  });

  it('renders nothing with nothing to say — and without Google Drive, only the note that a ?drive= link cannot open here', () => {
    useAppStore.setState({ drive: initialDriveState });
    const view = show();
    expect(view.container.innerHTML).toBe('');

    setDrive({ link: { ref: { id: ID }, status: 'unsupported' } });
    expect(status()).toBe('link-unsupported');
    expect(strip()).toHaveAttribute('role', 'status');
    expect(strip()).toHaveTextContent(DRIVE_MESSAGES.linkUnsupported);
    absent('drive-strip-privacy', 'drive-strip-retry');
    fireEvent.click(item('drive-strip-dismiss'));
    expect(st().drive.link).toBeNull();
    expect(strip()).toBeNull();

    // Configured: signed out, or signed in with no file and nothing asked.
    setDrive({ configStatus: 'ready', config: CONFIG });
    expect(strip()).toBeNull();
    setDrive({ account: ACCOUNT, authReady: true, recent: [] });
    expect(strip()).toBeNull();
    expect(auth.calls, 'the strip asks nothing of Google by itself').toEqual([]);
  });

  /**
   * A save in this browser that kept typed text back — it has a syntax error
   * — says so on every deployment: the note is an `info` row, with nothing
   * of Google's in it. An error notice is a configured deployment's alone,
   * beside the privacy page only a configuration names.
   */
  it('without Google Drive too: the note that a save in this browser kept the typed text back', () => {
    useAppStore.setState({ drive: initialDriveState });
    show();
    setDrive({ notice: { kind: 'info', message: DRIVE_MESSAGES.typedTextKeptBack(3), retryable: false } });
    expect(status()).toBe('info');
    expect(strip()).toHaveAttribute('role', 'status');
    expect(strip()).toHaveTextContent(
      'Saved in this browser without the text typed in the Text view: it has a syntax error at line 3. Fix it, then save again.',
    );
    absent('drive-strip-privacy', 'drive-strip-retry');
    fireEvent.click(item('drive-strip-dismiss'));
    expect(st().drive.notice).toBeNull();
    expect(strip()).toBeNull();

    setDrive({ notice: { kind: 'error', message: DRIVE_MESSAGES.browserSaveFailed, retryable: false } });
    expect(strip()).toBeNull();
    expect(driveStripStatus({ ...initialDriveState, notice: { kind: 'info', message: 'x', retryable: false } }, false)).toBe('info');
    // The question before a command replaces the model still comes first.
    expect(
      driveStripStatus(
        {
          ...initialDriveState,
          prompt: { kind: 'guard', label: 'New', variant: 'browser' },
          notice: { kind: 'info', message: 'x', retryable: false },
        },
        false,
      ),
    ).toBe('guard');
  });

  it('the attached file: saved, with Drive’s page and the link; unsaved, with Save; view access, gone and offline, each with its way on', () => {
    const save = spyOn('driveSave');
    const saveAs = spyOn('driveSaveAs');
    const saveProject = spyOn('saveProject');
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    setDrive({ account: ACCOUNT, authReady: true, file: attachedFile() });
    show();

    expect(status()).toBe('clean');
    expect(strip()).toHaveAttribute('role', 'status');
    expect(strip()).toHaveTextContent(`Swarm.sysml · saved to your Google Drive at ${driveTime(FILE.modifiedTime)}`);
    expect(item('drive-strip-copy')).toHaveAttribute('data-link', driveLink(st()));
    expect(item('drive-strip-copy').getAttribute('data-link')).toMatch(new RegExp(`\\?drive=${ID}$`));
    fireEvent.click(item('drive-strip-open-in-drive'));
    expect(opened).toHaveBeenCalledWith(FILE.webViewLink, '_blank', 'noopener,noreferrer');
    absent('drive-strip-save', 'drive-strip-save-as', 'drive-strip-save-local', 'drive-strip-dismiss', 'drive-strip-privacy');
    // A page Drive's metadata puts anywhere else is not offered.
    setDrive({ file: attachedFile({ webViewLink: 'https://example.org/file/d/x/view' }) });
    absent('drive-strip-open-in-drive');
    setDrive({ file: attachedFile() });

    setText(EDITED);
    expect(status()).toBe('dirty');
    expect(strip()).toHaveTextContent(/^Swarm\.sysml · unsaved changesSave to Drive$/);
    absent('drive-strip-copy', 'drive-strip-open-in-drive');
    fireEvent.click(item('drive-strip-save'));
    expect(save).toHaveBeenCalledWith();
    setDrive({ busy: 'listing' });
    expect(item('drive-strip-save')).toBeDisabled();
    expect(item('drive-strip-save')).toHaveAttribute('title', 'Reading your Drive…');
    setDrive({ busy: null });

    setDrive({ file: attachedFile({ canEdit: false }) });
    expect(status()).toBe('readonly');
    expect(strip()).toHaveTextContent(/^Swarm\.sysml · you have view access · unsaved changesSave to Drive as…$/);
    absent('drive-strip-save');
    fireEvent.click(item('drive-strip-save-as'));
    expect(saveAs, 'a copy of the file only viewed').toHaveBeenLastCalledWith(undefined, { asCopy: true });
    setText(TEXT);
    expect(strip()).toHaveTextContent(/^Swarm\.sysml · you have view accessSave to Drive as…$/);

    setDrive({ file: attachedFile({ trashed: true }) });
    expect(status()).toBe('gone');
    expect(strip()).toHaveTextContent(DRIVE_MESSAGES.goneOnOpen('Swarm.sysml'));
    fireEvent.click(item('drive-strip-save-as'));
    expect(saveAs).toHaveBeenLastCalledWith();

    // Offline: unsaved changes go to this browser for now; saved ones stay saved.
    setDrive({ file: attachedFile(), online: false });
    expect(status()).toBe('clean');
    setText(EDITED);
    expect(status()).toBe('offline');
    expect(strip()).toHaveTextContent(
      'Offline — Swarm.sysml has unsaved changes. They stay in this tab; Save keeps them in this browser; Save to Drive will work when you are back online.',
    );
    absent('drive-strip-save');
    fireEvent.click(item('drive-strip-save-local'));
    expect(saveProject).toHaveBeenCalledTimes(1);
  });

  it('offline, Save applies the text typed in the Text view first — the browser save holds what the row says it keeps', async () => {
    // The apply replaces the live model's contents in place: put back after.
    const snapshot = st().model.toJSON();
    let savedTyped: boolean | null = null;
    let savedBroken: boolean | null = null;
    const saveProject = spyOn('saveProject').mockImplementation(async () => {
      const saved = JSON.stringify(st().model.toJSON());
      savedTyped = saved.includes('TypedOffline');
      savedBroken = saved.includes('Broken');
    });
    try {
      setDrive({ account: ACCOUNT, authReady: true, file: attachedFile(), online: false });
      show();
      // Typed in the Text view, as its textarea does: not applied, so not the model yet.
      act(() => st().setTextBuffer(`${TEXT}package TypedOffline;\n`));
      expect(st().textDirty).toBe(true);
      expect(status()).toBe('offline');
      await act(async () => {
        fireEvent.click(item('drive-strip-save-local'));
        await whenLibrarySettled();
      });
      expect(saveProject).toHaveBeenCalledTimes(1);
      expect(savedTyped, 'the browser save ran on the model with the typed package').toBe(true);
      expect(st().textDirty).toBe(false);
      expect(status(), 'still not in Drive').toBe('offline');

      // A text with a parse error is not applied: the parser's recovery of
      // it is not what is on screen. The browser keeps the model as it
      // stands, the text stays as typed and not applied, and no Undo step is
      // spent — on this Save or the next.
      const undo = st().undoStack.length;
      act(() => st().setTextBuffer(`${TEXT}package Broken {\n`));
      await act(async () => {
        fireEvent.click(item('drive-strip-save-local'));
        await whenLibrarySettled();
      });
      expect(saveProject).toHaveBeenCalledTimes(2);
      expect(savedBroken, 'the model as it stood').toBe(false);
      expect(savedTyped).toBe(true);
      expect(st().textDirty, 'kept as typed').toBe(true);
      expect(st().undoStack).toHaveLength(undo);
      // ...and the strip says so, as Save and Ctrl/Cmd+S say it: the `}`
      // missing at the end of the text, line 5. Put away, the row is back.
      expect(status()).toBe('info');
      expect(st().drive.notice?.message).toBe(DRIVE_MESSAGES.typedTextKeptBack(5));
      fireEvent.click(item('drive-strip-dismiss'));
      expect(status()).toBe('offline');
      await act(async () => {
        fireEvent.click(item('drive-strip-save-local'));
        await whenLibrarySettled();
      });
      expect(saveProject).toHaveBeenCalledTimes(3);
      expect(st().undoStack, 'no second apply').toHaveLength(undo);
    } finally {
      act(() => st().model.reset(snapshot));
    }
  });

  it('says the sign-in expires soon in its last two minutes, and that it expired once it has', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const t0 = Date.UTC(2026, 9, 7, 12, 0, 0);
      vi.setSystemTime(t0);
      setDrive({ account: ACCOUNT, authReady: true, file: attachedFile(), expiresAt: t0 + DRIVE_EXPIRY_WARNING_MS + 60_000 });
      setText(EDITED);
      show();
      expect(strip()).toHaveTextContent(/^Swarm\.sysml · unsaved changesSave to Drive$/);
      act(() => vi.advanceTimersByTime(61_000));
      expect(strip()).toHaveTextContent(/^Swarm\.sysml · unsaved changes · sign-in expires soonSave to Drive$/);
      act(() => vi.advanceTimersByTime(DRIVE_EXPIRY_WARNING_MS));
      expect(strip()).toHaveTextContent(/^Swarm\.sysml · unsaved changes · sign-in expiredSave to Drive$/);
      // A fresh sign-in an hour long: nothing to say about it.
      setDrive({ expiresAt: Date.now() + 3600_000 });
      expect(strip()).toHaveTextContent(/^Swarm\.sysml · unsaved changesSave to Drive$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks first: whether to rewrite a hand-written file — and, as an alert, before a command replaces the model', () => {
    const acknowledge = spyOn('driveAcknowledgeRewrite');
    const runPending = spyOn('driveRunPending');
    setDrive({ account: ACCOUNT, authReady: true, file: attachedFile({ rewrites: true }), prompt: { kind: 'rewrite' } });
    show();
    expect(status()).toBe('rewrite');
    expect(strip()).toHaveAttribute('role', 'status');
    expect(strip()).toHaveTextContent(
      'Swarm.sysml was written by hand or by another tool. Sysprose writes files in its own layout and drops // comments. Save anyway? Drive keeps the previous version for about 30 days (Manage versions → Keep forever holds it longer).',
    );
    for (const [id, how] of [
      ['drive-strip-rewrite-ok', 'save'],
      ['drive-strip-rewrite-copy', 'copy'],
      ['drive-strip-rewrite-cancel', 'cancel'],
    ] as const) {
      fireEvent.click(item(id));
      expect(acknowledge, id).toHaveBeenLastCalledWith(how);
    }

    // Unsaved Drive changes, and New about to replace them.
    setText(EDITED);
    setDrive({ file: attachedFile(), prompt: { kind: 'guard', label: 'New', variant: 'dirty' } });
    expect(status()).toBe('guard');
    expect(strip()).toHaveAttribute('role', 'alert');
    expect(strip()).toHaveTextContent(/^Swarm\.sysml has unsaved changes to Drive\./);
    expect(item('drive-guard-save')).toHaveAttribute('title', 'Save to Drive first, then New');
    absent('drive-guard-open-anyway');
    for (const [id, how] of [
      ['drive-guard-save', 'save'],
      ['drive-guard-discard', 'discard'],
      ['drive-guard-keep', 'keep'],
    ] as const) {
      fireEvent.click(item(id));
      expect(runPending, id).toHaveBeenLastCalledWith(how);
    }
    // A save that cannot happen is not offered: view access only, or offline.
    setDrive({ file: attachedFile({ canEdit: false }) });
    expect(item('drive-guard-save')).toBeDisabled();
    expect(item('drive-guard-save')).toHaveAttribute('title', 'You have view access only');
    setDrive({ file: attachedFile(), online: false });
    expect(item('drive-guard-save')).toBeDisabled();
    expect(item('drive-guard-save')).toHaveAttribute('title', 'Offline');
    expect(item('drive-guard-discard')).toBeEnabled();

    // Edited work no Drive file holds, and a Drive open about to replace it.
    setDrive({ online: true, file: null, prompt: { kind: 'guard', label: 'Open from Drive', variant: 'open' } });
    expect(strip()).toHaveAttribute('role', 'alert');
    expect(strip()).toHaveTextContent(/^Opening from Drive replaces the current model and clears Undo\./);
    absent('drive-guard-save', 'drive-guard-discard');
    fireEvent.click(item('drive-guard-open-anyway'));
    expect(runPending).toHaveBeenLastCalledWith('open-anyway');
    fireEvent.click(item('drive-guard-keep'));
    expect(runPending).toHaveBeenLastCalledWith('keep');
  });

  it('without Google Drive too: the question before a command replaces unsaved work, whose Save is this browser’s', () => {
    const runPending = spyOn('driveRunPending');
    useAppStore.setState({ drive: initialDriveState });
    show();
    setDrive({ prompt: { kind: 'guard', label: 'New', variant: 'browser' } });
    expect(status()).toBe('guard');
    expect(strip()).toHaveAttribute('role', 'alert');
    expect(strip()).toHaveTextContent(/^Swarm has unsaved changes\.Save and continue/);
    expect(item('guard-save')).toHaveAttribute('title', 'Save the project in this browser, then New');
    expect(item('guard-discard')).toHaveAttribute('title', 'New without saving');
    expect(item('guard-keep')).toHaveAttribute('title', 'Cancel New and keep editing this model');
    absent('drive-guard-save', 'drive-guard-discard', 'drive-guard-keep', 'drive-guard-open-anyway', 'drive-strip-privacy');
    for (const [id, how] of [
      ['guard-save', 'save'],
      ['guard-discard', 'discard'],
      ['guard-keep', 'keep'],
    ] as const) {
      fireEvent.click(item(id));
      expect(runPending, id).toHaveBeenLastCalledWith(how);
    }

    // The browser refused the save: the question stands, saying so — with no
    // other copy to speak of.
    setDrive({ prompt: { kind: 'guard', label: 'New', variant: 'browser', refused: true } });
    expect(strip()).toHaveTextContent(`Swarm has unsaved changes. ${DRIVE_MESSAGES.browserRefused}Save and continue`);

    // Joining a room drops nothing at once — the room's model merges over this
    // one — so its button does not say discard.
    setDrive({ prompt: { kind: 'guard', label: 'Join room', variant: 'browser' } });
    expect(item('guard-discard')).toHaveTextContent('Join without saving');
    expect(item('guard-discard')).toHaveAttribute(
      'title',
      "Join the room without saving: the room's model may change or replace this one",
    );
    expect(item('guard-keep')).toHaveAttribute('title', 'Cancel Join room and keep editing this model');
    setDrive({ prompt: { kind: 'guard', label: 'New', variant: 'browser' } });
    expect(item('guard-discard')).toHaveTextContent('Discard and continue');

    // Text typed in the Text view that the parser cannot read: no model to save.
    act(() => useAppStore.setState({ textBuffer: 'package Swarm {\n    blok bad;\n}\n', textDirty: true }));
    expect(item('guard-save')).toBeDisabled();
    expect(item('guard-save')).toHaveAttribute(
      'title',
      'The text typed in the Text view has a syntax error — fix it, or discard it',
    );
    expect(item('guard-discard')).toBeEnabled();
    act(() => useAppStore.setState({ textBuffer: EDITED }));
    expect(item('guard-save')).toBeEnabled();

    // With Google Drive configured and no file attached, the same question.
    setDrive({ configStatus: 'ready', config: CONFIG, prompt: { kind: 'guard', label: 'Import', variant: 'browser' } });
    expect(item('guard-save')).toHaveAttribute('title', 'Save the project in this browser, then Import');
    expect(driveStripStatus({ ...initialDriveState, prompt: { kind: 'guard', label: 'New', variant: 'browser' } }, false)).toBe(
      'guard',
    );
  });

  it('a conflict, as an amber alert with its three answers — none of them while another Drive action runs', () => {
    const resolve = spyOn('driveResolveConflict');
    const remote: DriveFileMeta = { ...META, md5Checksum: 'f'.repeat(32), modifiedTime: '2026-10-07T12:05:00.000Z' };
    setText(EDITED);
    setDrive({ account: ACCOUNT, authReady: true, file: attachedFile(), conflict: { remote } });
    show();
    expect(status()).toBe('conflict');
    expect(strip()).toHaveAttribute('role', 'alert');
    expect(strip()).toHaveClass('drive-strip-conflict');
    expect(strip()).toHaveTextContent(driveConflictMessage('Swarm.sysml', remote));
    expect(strip()).toHaveTextContent(`(Alice, ${driveTime(remote.modifiedTime)})`);
    for (const [id, how] of [
      ['drive-strip-copy-save', 'copy'],
      ['drive-strip-overwrite', 'overwrite'],
      ['drive-strip-reload', 'reload'],
    ] as const) {
      fireEvent.click(item(id));
      expect(resolve, id).toHaveBeenLastCalledWith(how);
    }
    // Overwriting or reloading: the question stands, its answers wait.
    setDrive({ busy: 'saving' });
    expect(status()).toBe('conflict');
    for (const id of ['drive-strip-copy-save', 'drive-strip-overwrite', 'drive-strip-reload']) {
      expect(item(id), id).toBeDisabled();
      expect(item(id)).toHaveAttribute('title', 'Saving to Drive…');
    }
  });

  it('an action running, a notice, and a sign-in to renew — every error beside the privacy page', () => {
    const retry = spyOn('driveRetry');
    const resume = spyOn('driveResume');
    setDrive({ account: ACCOUNT, authReady: true, file: attachedFile(), busy: 'saving' });
    show();
    expect(status()).toBe('saving');
    expect(strip()).toHaveTextContent(/^Saving Swarm\.sysml…$/);
    setDrive({ file: null });
    expect(strip()).toHaveTextContent(/^Saving to Google Drive…$/);
    setDrive({ busy: 'opening' });
    expect(status()).toBe('opening');
    expect(strip()).toHaveTextContent(/^Opening a file from Google Drive…$/);
    // Named once the open knows the name: a Recent row's, a reload's, Drive's answer.
    setDrive({ opening: 'Fleet.sysml' });
    expect(strip()).toHaveTextContent(/^Opening Fleet\.sysml…$/);
    setDrive({ opening: null });
    setDrive({ busy: 'listing' });
    expect(strip(), 'reading the Recent list is the panel’s to show').toBeNull();

    setDrive({
      busy: null,
      notice: { kind: 'error', message: DRIVE_MESSAGES.rateLimited, retryable: true, retry: { op: 'save' } },
    });
    expect(status()).toBe('error');
    expect(strip()).toHaveAttribute('role', 'alert');
    expect(strip()).toHaveClass('drive-strip-error');
    expect(strip()).toHaveTextContent(DRIVE_MESSAGES.rateLimited);
    expect(item('drive-strip-privacy')).toHaveAttribute('href', CONFIG.privacyUrl);
    expect(item('drive-strip-privacy')).toHaveAttribute('target', '_blank');
    expect(item('drive-strip-privacy')).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(item('drive-strip-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    fireEvent.click(item('drive-strip-dismiss'));
    expect(st().drive.notice).toBeNull();
    expect(strip()).toBeNull();

    // Signed out, a sign-in Google blocked: no Try again, and the page that
    // names the client ID for an administrator right there.
    setDrive({ account: null, notice: { kind: 'error', message: DRIVE_MESSAGES.signInCancelled, retryable: false } });
    expect(status()).toBe('error');
    absent('drive-strip-retry');
    expect(item('drive-strip-privacy')).toHaveTextContent('Privacy & data ↗');

    // Notes: "<name> closed", and the rest.
    setDrive({ account: ACCOUNT, notice: { kind: 'info', message: DRIVE_MESSAGES.closed('Swarm.sysml'), retryable: false } });
    expect(status()).toBe('closed');
    expect(strip()).toHaveAttribute('role', 'status');
    expect(strip()).toHaveTextContent('Swarm.sysml closed. Save to Drive as… writes a new file.');
    absent('drive-strip-privacy');
    expect(item('drive-strip-dismiss')).toBeInTheDocument();
    setDrive({ notice: { kind: 'info', message: DRIVE_MESSAGES.openedJson('Swarm.json'), retryable: false } });
    expect(status()).toBe('info');

    // A save parked for a sign-in only a click can open.
    setDrive({ notice: null, file: attachedFile(), pending: { op: 'save' } });
    expect(status()).toBe('expired');
    expect(strip()).toHaveTextContent(/^Your Google sign-in expired\.Sign in and continue$/);
    fireEvent.click(item('drive-strip-signin'));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('copies the link; when the clipboard refuses, shows it read-only to copy by hand until it loses focus', async () => {
    const copy = spyOn('driveCopyLink');
    setDrive({ account: ACCOUNT, authReady: true, file: attachedFile() });
    show();
    await act(async () => fireEvent.click(item('drive-strip-copy')));
    expect(item('drive-strip-copy')).toHaveTextContent('Link copied');
    absent('drive-link-text');

    copy.mockRejectedValueOnce(new Error('clipboard refused'));
    await act(async () => fireEvent.click(item('drive-strip-copy')));
    expect(item('drive-strip-copy')).toHaveTextContent('Copy link');
    const field = item('drive-link-text');
    expect(field).toHaveValue(driveLink(st()));
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveFocus();
    act(() => field.blur());
    absent('drive-link-text');
  });

  it('a link the panel could not copy shows beside whatever row is up, keeps its place as rows change, and goes with its file', async () => {
    setDrive({
      account: ACCOUNT,
      authReady: true,
      recent: [],
      file: attachedFile(),
      notice: { kind: 'error', message: DRIVE_MESSAGES.rateLimited, retryable: false },
    });
    const copy = spyOn('driveCopyLink');
    copy.mockRejectedValue(new Error('clipboard refused'));
    render(React.createElement(React.Fragment, null, React.createElement(DriveMenu), React.createElement(DriveStrip)));
    const copyFromPanel = async (): Promise<void> => {
      fireEvent.click(item('tb-drive'));
      await act(async () => fireEvent.click(item('drive-copy-link')));
    };

    // An error standing: the panel closes, and the link is in the strip, in focus.
    await copyFromPanel();
    expect(screen.queryByTestId('drive-panel')).toBeNull();
    expect(status()).toBe('error');
    let field = item('drive-link-text');
    expect(field).toHaveValue(driveLink(st()));
    expect(field).toHaveFocus();
    // The row changes around it; the field stays — the same one, still in focus.
    setDrive({ notice: null });
    expect(status()).toBe('clean');
    expect(item('drive-link-text')).toBe(field);
    expect(field).toHaveFocus();
    act(() => field.blur());
    absent('drive-link-text');

    // A save running: the same.
    setDrive({ busy: 'saving' });
    await copyFromPanel();
    expect(status()).toBe('saving');
    field = item('drive-link-text');
    expect(field).toHaveFocus();
    // The user goes on typing in the Text view; the save ends. The field
    // took the focus once, as it appeared, and does not take it back.
    const editor = document.createElement('textarea');
    document.body.appendChild(editor);
    try {
      act(() => editor.focus());
      absent('drive-link-text');
      setDrive({ busy: null });
      expect(status()).toBe('clean');
      expect(editor).toHaveFocus();
    } finally {
      editor.remove();
    }

    // Shown again, then another file is attached: that link was the other file's.
    setDrive({ prompt: { kind: 'saveas', suggested: 'Swarm (copy).sysml', asCopy: true } });
    await copyFromPanel();
    expect(status()).toBe('saveas');
    expect(item('drive-link-text')).toHaveValue(driveLink(st()));
    setDrive({ prompt: null, file: attachedFile({ id: ID2, name: 'Fleet.sysml' }) });
    absent('drive-link-text');
    expect(status()).toBe('clean');
    // Forgotten, not just hidden: back on the first file, nothing pops up.
    setDrive({ file: attachedFile() });
    absent('drive-link-text');
  });

  it('the Save-as form: prefilled and in focus; Save writes the name typed, a copy as a copy; Cancel and Escape close it', () => {
    const saveAs = spyOn('driveSaveAs');
    setDrive({ account: ACCOUNT, authReady: true, prompt: { kind: 'saveas', suggested: 'Swarm.sysml', asCopy: false } });
    show();
    expect(status()).toBe('saveas');
    expect(strip()).toHaveAttribute('role', 'status');
    expect(strip()).toHaveTextContent(/^Save to Google Drive as/);
    const name = item('drive-saveas-name');
    expect(name).toHaveValue('Swarm.sysml');
    expect(name).toHaveFocus();
    expect(item('drive-saveas-confirm')).toHaveTextContent(/^Save$/);

    fireEvent.change(name, { target: { value: '  ' } });
    expect(item('drive-saveas-confirm')).toBeDisabled();
    expect(item('drive-saveas-confirm')).toHaveAttribute('title', 'Type a name for the file');
    fireEvent.submit(name.closest('form')!);
    expect(saveAs).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: 'Fleet' } });
    fireEvent.click(item('drive-saveas-confirm'));
    expect(saveAs).toHaveBeenLastCalledWith('Fleet', { asCopy: false });
    fireEvent.submit(name.closest('form')!); // Enter in the field
    expect(saveAs).toHaveBeenCalledTimes(2);

    // Offline, or another Drive action running: Save waits, saying why.
    setDrive({ online: false });
    expect(item('drive-saveas-confirm')).toBeDisabled();
    expect(item('drive-saveas-confirm')).toHaveAttribute('title', 'Offline');
    setDrive({ online: true });

    // A copy of the attached file: its own suggestion, written as a copy.
    setDrive({ file: attachedFile(), prompt: { kind: 'saveas', suggested: 'Swarm (copy).sysml', asCopy: true } });
    expect(strip()).toHaveTextContent(/^Save a copy to Google Drive as/);
    expect(item('drive-saveas-name')).toHaveValue('Swarm (copy).sysml');
    fireEvent.click(item('drive-saveas-confirm'));
    expect(saveAs).toHaveBeenLastCalledWith('Swarm (copy).sysml', { asCopy: true });

    fireEvent.keyDown(item('drive-saveas-name'), { key: 'Escape' });
    expect(st().drive.prompt).toBeNull();
    expect(status()).toBe('clean');
    setDrive({ prompt: { kind: 'saveas', suggested: 'Swarm.sysml', asCopy: false } });
    fireEvent.click(item('drive-saveas-cancel'));
    expect(st().drive.prompt).toBeNull();
  });

  it('signed out, the form’s Save is the sign-in: disabled until Google’s script is there, then the account chooser opens inside its click', async () => {
    show();
    // Ctrl/Cmd+Shift+S with the panel never opened: the form, and the script starts loading.
    act(() => void st().driveSave());
    expect(status()).toBe('saveas');
    expect(auth.calls).toEqual([{ op: 'ready' }]);
    expect(item('drive-saveas-confirm')).toBeDisabled();
    expect(item('drive-saveas-confirm')).toHaveTextContent('Loading Google sign-in…');

    await act(async () => auth.finishLoading());
    expect(item('drive-saveas-confirm')).toBeEnabled();
    expect(item('drive-saveas-confirm')).toHaveTextContent('Sign in and save');

    await act(async () => {
      fireEvent.click(item('drive-saveas-confirm'));
      // Synchronously, inside the click: the popup is the click's own.
      expect(signIns()).toEqual([{ op: 'signIn', prompt: 'select_account' }]);
      await vi.waitFor(() => expect(st().drive.busy).toBeNull());
    });
    expect(st().drive.file?.name).toBe('Swarm.sysml');
    expect(gateway.calls.filter((c) => c.op === 'create')).toHaveLength(1);
    expect(status()).toBe('clean');
  });

  it('signed out, says so when Google’s script did not load, rather than loading for ever', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    show();
    act(() => void st().driveSave());
    await act(async () => auth.finishLoading(new DriveError('Google Drive request failed (script-failed)', 0, 'script-failed')));
    expect(status(), 'the form stays, its Save explains').toBe('saveas');
    expect(item('drive-saveas-confirm')).toBeDisabled();
    expect(item('drive-saveas-confirm')).toHaveTextContent('Google sign-in did not load');
    expect(item('drive-saveas-confirm')).toHaveAttribute('title', DRIVE_MESSAGES.scriptFailed);
  });

  it('the shown row follows the slice’s order: a question, a conflict, an action, a notice, a sign-in to renew, then the file', () => {
    const remote = { ...META, md5Checksum: 'f'.repeat(32) };
    const error = { kind: 'error' as const, message: 'x', retryable: false };
    const base: DriveState = { ...initialDriveState, configStatus: 'ready', config: CONFIG, account: ACCOUNT, file: FILE };
    const all: DriveState = {
      ...base,
      prompt: { kind: 'rewrite' },
      conflict: { remote },
      busy: 'saving',
      notice: error,
      pending: { op: 'save' },
      file: attachedFile({ trashed: true, canEdit: false }),
      online: false,
    };
    expect(driveStripStatus(all, true)).toBe('rewrite');
    expect(driveStripStatus({ ...all, prompt: null }, true)).toBe('conflict');
    expect(driveStripStatus({ ...all, prompt: null, conflict: null }, true)).toBe('saving');
    expect(driveStripStatus({ ...all, prompt: null, conflict: null, busy: 'opening' }, true)).toBe('opening');
    expect(driveStripStatus({ ...all, prompt: null, conflict: null, busy: 'signing-in' }, true)).toBe('error');
    expect(driveStripStatus({ ...all, prompt: null, conflict: null, busy: null, notice: null }, true)).toBe('expired');
    const fileOnly = { ...all, prompt: null, conflict: null, busy: null, notice: null, pending: null };
    expect(driveStripStatus(fileOnly, true)).toBe('gone');
    expect(driveStripStatus({ ...fileOnly, file: attachedFile({ canEdit: false }) }, true)).toBe('readonly');
    expect(driveStripStatus({ ...fileOnly, file: FILE }, true)).toBe('offline');
    expect(driveStripStatus({ ...fileOnly, file: FILE }, false)).toBe('clean');
    expect(driveStripStatus({ ...fileOnly, file: FILE, online: true }, true)).toBe('dirty');
    expect(driveStripStatus({ ...fileOnly, file: null }, true)).toBeNull();
    // Without Google Drive: the note about a link, or nothing — whatever else is there.
    expect(driveStripStatus({ ...all, configStatus: 'absent' }, true)).toBeNull();
    expect(driveStripStatus({ ...all, configStatus: 'loading', link: { ref: { id: ID }, status: 'unsupported' } }, true)).toBe(
      'link-unsupported',
    );
  });

  it('the ?model= banner gives way while a Drive file is attached or a ?drive= link is set', () => {
    useAppStore.setState({ linkedModel: { url: 'https://example.org/models/Swarm.sysml', source: null, status: 'loaded' } });
    render(React.createElement(LinkedModelBanner));
    expect(screen.getByTestId('linked-banner')).toBeInTheDocument();
    setDrive({ file: attachedFile() });
    absent('linked-banner');
    setDrive({ file: null, link: { ref: { id: ID }, status: 'pending' } });
    absent('linked-banner');
    setDrive({ link: null });
    expect(screen.getByTestId('linked-banner')).toBeInTheDocument();
  });

  it('a ?drive= link holds the loading gate while it waits, opens or was refused — not once Drive turned out to be absent', () => {
    expect(driveLinkHolds(null)).toBe(false);
    for (const s of ['pending', 'opening', 'denied', 'failed'] as const) {
      expect(driveLinkHolds({ ref: { id: ID }, status: s }), s).toBe(true);
    }
    expect(driveLinkHolds({ ref: { id: ID }, status: 'unsupported' })).toBe(false);
  });

  it('the gate: Sign in and open waits for Google’s script, then asks for the account chooser inside its click', async () => {
    setDrive({ link: { ref: { id: ID2 }, status: 'pending' } });
    showGate();
    const gate = item('drive-link-gate');
    expect(gate).toHaveAttribute('data-status', 'pending');
    expect(gate).toHaveTextContent('This link opens a file from Google Drive.');
    expect(item('drive-link-signin')).toBeDisabled();
    expect(item('drive-link-signin')).toHaveTextContent('Loading Google sign-in…');
    expect(item('drive-link-skip')).toBeEnabled();
    absent('drive-link-denied', 'drive-link-retry');

    // The boot starts the script for a pending link; once it is there, the click may sign in.
    await act(async () => {
      void st().drivePrepare();
      auth.finishLoading();
    });
    expect(item('drive-link-signin')).toBeEnabled();
    expect(item('drive-link-signin')).toHaveTextContent('Sign in and open');
    expect(item('drive-link-signin')).toHaveAttribute('title', 'Choose your Google account, then open the file');
    // Signed in already (a sign-out cut an open short, then a sign-in): only the click to open.
    setDrive({ account: ACCOUNT });
    expect(item('drive-link-signin')).toHaveTextContent(/^Open$/);
    expect(item('drive-link-signin')).toHaveAttribute('title', 'Open the file from Google Drive');
    setDrive({ account: null });

    await act(async () => {
      fireEvent.click(item('drive-link-signin'));
      // Synchronously, inside the click.
      expect(signIns()).toEqual([{ op: 'signIn', prompt: 'select_account' }]);
      expect(st().drive.link?.status).toBe('opening');
      await vi.waitFor(() => expect(st().drive.busy).toBeNull());
    });
    // Not granted to this app yet: Drive answered 404, and the gate says what to do — on a
    // site without Google's Picker, that only the Picker grants a file, and it is not here.
    expect(item('drive-link-gate')).toHaveAttribute('data-status', 'denied');
    expect(item('drive-link-denied')).toHaveTextContent(
      "Google Drive did not let Sysprose open this file. A file shared with you opens here only once it has been chosen in Google's file picker, on a site that offers it — this one does not.",
    );
    setDrive({ config: PICKER_CONFIG });
    expect(item('drive-link-denied')).toHaveTextContent(
      'Google Drive did not let Sysprose open this file. If it was shared with you, choose it once:',
    );
  });

  it('a sign-in cancelled or blocked at the gate — a school account, say — stays on the gate, beside Privacy & data', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDrive({ link: { ref: { id: ID }, status: 'pending' } });
    showGate();
    await act(async () => {
      void st().drivePrepare();
      auth.finishLoading();
    });
    absent('drive-link-privacy');
    auth.failNextSignIn('popup_closed');
    await act(async () => {
      fireEvent.click(item('drive-link-signin'));
      await vi.waitFor(() => expect(st().drive.busy).toBeNull());
    });
    expect(item('drive-link-gate')).toHaveAttribute('data-status', 'failed');
    expect(item('drive-link-gate')).toHaveTextContent(DRIVE_MESSAGES.signInCancelled);
    expect(item('drive-link-privacy')).toHaveAttribute('href', CONFIG.privacyUrl);
    expect(item('drive-link-retry')).toBeEnabled();
  });

  it('the denied gate: Google’s picker on that one file with a Picker key, the file’s Drive link pasted, or Skip', () => {
    const browse = spyOn('driveBrowse');
    const open = spyOn('driveOpen');
    setDrive({ account: ACCOUNT, authReady: true, link: { ref: { id: ID }, status: 'denied' } });
    const view = showGate();
    absent('drive-link-browse', 'drive-link-signin', 'drive-link-retry', 'drive-link-privacy');
    // The account the chooser picked may not be the one the file was shared with: which, and the way to the other.
    expect(item('drive-link-denied')).toHaveTextContent(
      'Signed in as student@example.org. Shared with another of your Google accounts? Skip, choose Sign out under Drive ▾, then open this link again.',
    );
    setDrive({ account: { email: null, name: null } });
    expect(item('drive-link-denied')).not.toHaveTextContent('Signed in as');
    expect(item('drive-link-denied')).toHaveTextContent('Shared with another of your Google accounts?');
    setDrive({ account: ACCOUNT });
    setDrive({ config: PICKER_CONFIG });
    fireEvent.click(item('drive-link-browse'));
    expect(browse).toHaveBeenCalledWith([ID]);

    const field = item('drive-link-id');
    for (const text of ['', 'not a link', 'https://example.org/file/d/x']) {
      fireEvent.change(field, { target: { value: text } });
      expect(item('drive-link-id-go'), text).toBeDisabled();
      fireEvent.keyDown(field, { key: 'Enter' });
    }
    expect(open).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: `https://drive.google.com/file/d/${ID}/view?resourcekey=${KEY}` } });
    fireEvent.click(item('drive-link-id-go'));
    // Opened as the link — its failures land on this gate — with the resource key.
    expect(open).toHaveBeenCalledWith({ id: ID, resourceKey: KEY }, 'link');

    fireEvent.click(item('drive-link-skip'));
    expect(st().drive.link).toBeNull();
    expect(view.container.innerHTML).toBe('');
  });

  it('the gate after any other failure: why, Try again and Skip; offline, only Skip; while the file opens, nothing to click', () => {
    const retry = spyOn('driveLinkRetry');
    setDrive({ authReady: true, link: { ref: { id: ID }, status: 'failed', error: DRIVE_MESSAGES.signInCancelled } });
    const view = showGate();
    expect(item('drive-link-gate')).toHaveTextContent(DRIVE_MESSAGES.signInCancelled);
    // The message sends a blocked school account to Privacy & data: the gate
    // carries it, as nothing else on screen does while the gate holds.
    expect(DRIVE_MESSAGES.signInCancelled).toContain('Privacy & data');
    const privacy = item('drive-link-privacy');
    expect(privacy).toHaveTextContent('Privacy & data ↗');
    expect(privacy).toHaveAttribute('href', CONFIG.privacyUrl);
    expect(privacy).toHaveAttribute('target', '_blank');
    expect(privacy).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(item('drive-link-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(item('drive-link-skip')).toBeEnabled();

    setDrive({ online: false });
    expect(item('drive-link-gate')).toHaveTextContent(DRIVE_MESSAGES.linkOffline);
    absent('drive-link-retry', 'drive-link-signin', 'drive-link-privacy');
    expect(item('drive-link-skip')).toBeEnabled();
    setDrive({ link: { ref: { id: ID }, status: 'pending' } });
    absent('drive-link-signin');

    setDrive({ online: true, link: { ref: { id: ID }, status: 'opening' } });
    expect(item('drive-link-gate')).toHaveTextContent(/^Opening the file from Google Drive…$/);
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
  });
});

/**
 * The Google side of the Drive E2E (`drive.spec.ts`), faked with `page.route`
 * and two page bindings.
 *
 * Nothing here contacts Google, and nothing may: every request to a Google host
 * is recorded, and one no fake answers is aborted — so it can neither reach the
 * real service nor pass unnoticed (Chromium logs the aborted load as a console
 * error, which `captureErrors` collects, and it is listed in `unanswered`). A
 * fake that answers a Google URL is registered after the catch-all and so
 * takes precedence over it (Playwright tries routes newest first).
 *
 * Faked, each as Google documents it:
 * - the deployment's `drive.json`, served from the route or — with no
 *   `config` — left to the preview server, which serves the placeholder the
 *   build ships;
 * - Google Identity Services' script: a token client whose every request is
 *   recorded on `window.__fakeGoogle.requests` at the call (with whether the
 *   page had the user's activation then, and which event it was dispatching —
 *   what lets a real popup open) and answered from this process: a token, or
 *   one of GIS's refusals;
 * - `api.js` and the Picker it loads, recording every view the app builds and
 *   answering with the file the test chose (choosing one grants it, as under
 *   `drive.file`) or a cancel;
 * - Drive's REST API: an in-memory Drive in this process;
 * - Google's token revocation endpoint, which sign-out POSTs to.
 *
 * The fake Drive is never more lenient than Drive where the app's correctness
 * rests on it: a multipart upload whose delimiter and header lines do not end
 * in CRLF is answered 400; a bearer Google would not accept, 401; a file not
 * granted to the app, 404; a file that needs its resource key, 404 unless the
 * request carries it in `X-Goog-Drive-Resource-Keys`; a write without edit
 * access, 403. Metadata comes back as Drive's `fields` selector shapes it: only
 * the fields it names, and Drive's default four (`kind`, `id`, `name`,
 * `mimeType`) when it names none — so a field the app needs and does not ask
 * for is missing here too. `about` without a selector, a selector that does not
 * parse, and one naming a field the fake does not model are answered 400 (the
 * last is stricter than Drive for a real field left out here: a test that needs
 * one adds it to {@link FILE_FIELDS}). Every error is in Google's JSON shape,
 * and every answer carries the CORS header a cross-origin `fetch` needs to read
 * it. Its `md5Checksum` is the MD5 of the content (Node's `crypto`), so it
 * moves with the content and with nothing else, as Drive's does.
 *
 * CORS preflights never reach these fakes: Playwright answers the preflight of
 * every intercepted request itself, allowing whatever origin, method and
 * headers it asks for. Whether Google's own preflight admits `Authorization`
 * and `X-Goog-Drive-Resource-Keys` is therefore not tested here, only by the
 * manual check against Google (plan F.4 step 5b).
 */
import { createHash } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import {
  DRIVE_API_ORIGIN,
  DRIVE_REVOKE_URL,
  DRIVE_SCRIPTS,
  DRIVE_WEB_ORIGINS,
} from '../../src/persistence/drive/hosts';
import type { DriveConfig } from '../../src/persistence/drive/types';

/** A configuration that passes `parseDriveConfig`, with no Picker key. */
export const FAKE_CONFIG: DriveConfig = {
  clientId: '123456789012-drivefake.apps.googleusercontent.com',
  privacyUrl: 'https://example.org/privacy/',
};

/**
 * A configuration with the Picker: an API key of the shape Google issues
 * (built, so no key-shaped literal sits in the source) and a project number.
 */
export const FAKE_PICKER_CONFIG: DriveConfig = {
  ...FAKE_CONFIG,
  apiKey: `AIza${'Fk3_-'.repeat(7)}`,
  appId: '123456789012',
};

/** A Drive-shaped file id (letters, digits, `-`, `_`; 10–128 of them). */
export const FAKE_FILE_ID = '1FakeDriveFileId_0123456789-abc';

/** Who the fake Drive says is signed in (`about`). */
export const FAKE_ACCOUNT = { email: 'student@example.org', name: 'Student' };

/**
 * How the fake GIS answers one token request: `grant` a token; refuse it the
 * way GIS reports each refusal — `access_denied` in the token response, or
 * `popup_closed` / `popup_failed_to_open` through `error_callback`; or
 * `scope_unticked`, a token granted with the Drive box unticked (granular
 * consent), which only `hasGrantedAllScopes` tells apart.
 */
export type FakeSignIn = 'grant' | 'access_denied' | 'scope_unticked' | 'popup_closed' | 'popup_failed_to_open';

/** One token request the page made, as the fake GIS received it. */
export interface FakeTokenRequest {
  prompt: string | null;
  login_hint: string | null;
  /**
   * The page had the user's transient activation at the call. Chromium keeps it
   * for seconds after a click, through any `await`, so this alone cannot tell a
   * call made inside the click from one made after it.
   */
  activated: boolean;
  /**
   * The event the page was dispatching at the call (`window.event`), or null:
   * `'click'` for a call made inside a click's handler. A timer or network
   * `await` before the call clears it (an already-settled promise does not),
   * and that is the call a stricter browser (Safari) refuses a popup for.
   */
  inEvent: string | null;
  answer: FakeSignIn;
  /** The token granted, when it was. */
  token?: string;
}

/** One Picker the page built and showed: its views and the builder's settings. */
export interface FakePickerBuild {
  /** Each view added, in order, with every method called on it and its argument. */
  views: Array<{ viewId: string; calls: Array<[string, unknown]> }>;
  developerKey?: string;
  appId?: string;
  origin?: string;
  /** Whether the builder was given an OAuth token (never the token itself). */
  hasToken: boolean;
}

/** One request the fake Drive answered. */
export interface FakeDriveRequest {
  method: string;
  /** Path and query, as sent. */
  path: string;
  /** The bearer token the request carried, or null. */
  token: string | null;
  /** `X-Goog-Drive-Resource-Keys`, when the request carried it. */
  resourceKeys?: string;
  status: number;
}

/** A file in the fake Drive, as a test reads it. */
export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  body: string;
  version: string;
  headRevisionId: string;
  md5Checksum: string;
  modifiedTime: string;
  trashed: boolean;
  canEdit: boolean;
  /** Whether `drive.file` lets the app see it: it created the file, or the user picked it. */
  granted: boolean;
  resourceKey?: string;
  /** Whether a request must carry the resource key to reach it. */
  keyRequired: boolean;
  lastModifiedBy: string;
}

/** What a test seeds the fake Drive with. */
export interface FakeDriveSeed {
  name: string;
  body: string;
  id?: string;
  mimeType?: string;
  /** Default true: a file the app can already see. False: shared with the user, not yet picked. */
  granted?: boolean;
  canEdit?: boolean;
  resourceKey?: string;
  keyRequired?: boolean;
  by?: string;
}

export interface DriveFakeOptions {
  /** Served as the deployment's `drive.json`; omitted, the preview's own file answers. */
  config?: DriveConfig;
  /** How the first sign-ins are answered, in order; every later one is granted. */
  signIn?: FakeSignIn | FakeSignIn[];
  /** The lifetime GIS reports for a token, in seconds (default an hour). */
  expiresIn?: number;
  /** Whether Google confirms a revocation (default true). */
  revokeOk?: boolean;
  /** Hold GIS's script back until `releaseGis()`: the page is left waiting for it. */
  holdGis?: boolean;
}

export interface DriveFakes {
  /** Every request the page made to a Google host, in order. */
  googleRequests: string[];
  /** Requests to a Google host no fake answers: aborted, never sent. */
  unanswered: string[];
  /** Every token request, in order. */
  tokenRequests: FakeTokenRequest[];
  /** Every token granted, in order. */
  issued: string[];
  /** Every Picker shown, in order. */
  pickerBuilds: FakePickerBuild[];
  /** Every request the fake Drive answered, in order. */
  requests: FakeDriveRequest[];
  /** Every token sign-out asked Google to revoke, in order. */
  revokeRequests: string[];
  /** The tokens Google confirmed revoked. */
  revoked: string[];
  /** Whether Google confirms the next revocations. */
  revokeOk: boolean;
  /** The lifetime GIS reports for the next tokens, in seconds. */
  expiresIn: number;
  /** Let GIS's script answer (with `holdGis`). */
  releaseGis(): void;
  /** How the next sign-ins are answered, in order (after those already queued). */
  answerSignIns(...answers: FakeSignIn[]): void;
  /** What the next Pickers answer, in order: a file chosen, or null (closed). With none queued, the user closes it. */
  answerPicks(...answers: Array<{ id: string; name: string } | null>): void;
  /** Every file, granted or not, trashed or not. */
  files(): FakeDriveFile[];
  /** File `id`; throws when there is none. */
  file(id: string): FakeDriveFile;
  /** Put a file in the fake Drive. */
  seed(file: FakeDriveSeed): FakeDriveFile;
  /** Let the app see file `id` — what choosing it in the Picker does. */
  grant(id: string): void;
  /** Someone else saved new content (default: the old with a line appended): every marker moves. */
  bump(id: string, body?: string, by?: string): FakeDriveFile;
  /** A rename or a share: `version` and `modifiedTime` move, the content markers do not. */
  touchMeta(id: string): FakeDriveFile;
  /** The user keeps view access only. */
  setReadonly(id: string): void;
  /** The file goes to the trash: still readable by id, no longer listed. */
  trash(id: string): void;
  /** Google stops accepting `token`: a request carrying it is answered 401. */
  expireToken(token: string): void;
  /** The next token granted is `token` (queued after those already named). */
  issueToken(token: string): void;
  /** Answer the next Drive request with `status` (and `reason`, Drive's reason code), whatever it asked. */
  failNext(status: number, reason?: string): void;
}

/** Every Google host the app could be talking to. */
const GOOGLE_HOST = /(^|\.)(google\.com|googleapis\.com|googleusercontent\.com|gstatic\.com)$/;

/** What every fake answer to a cross-origin `fetch` carries so the page may read it. */
const CORS = { 'access-control-allow-origin': '*' } as const;

/**
 * Google Identity Services, faked: `google.accounts.oauth2`'s token client.
 * Each request is recorded at the call, then answered by this process through
 * the `__driveFakeToken` binding. `revoke` is GIS's helper, recorded so a test
 * can tell it was never used (sign-out POSTs to the endpoint itself).
 */
const FAKE_GIS = `(() => {
  const fake = (window.__fakeGoogle = window.__fakeGoogle || { requests: [] });
  fake.gisRevoked = fake.gisRevoked || [];
  window.google = window.google || {};
  window.google.accounts = {
    oauth2: {
      initTokenClient(config) {
        return {
          requestAccessToken(overrides) {
            const o = overrides || {};
            const activated = !!(navigator.userActivation && navigator.userActivation.isActive);
            const inEvent = window.event ? window.event.type : null;
            fake.requests.push({ prompt: o.prompt, login_hint: o.login_hint, activated, inEvent });
            window
              .__driveFakeToken({
                prompt: o.prompt === undefined ? null : o.prompt,
                login_hint: o.login_hint === undefined ? null : o.login_hint,
                activated,
                inEvent,
                scope: config.scope,
              })
              .then((answer) => {
                if (answer.errorType) config.error_callback({ type: answer.errorType });
                else config.callback(answer.response);
              });
          },
        };
      },
      hasGrantedAllScopes(response, ...scopes) {
        const granted = String((response && response.scope) || '').split(' ');
        return scopes.every((scope) => granted.includes(scope));
      },
      revoke(token, done) {
        fake.gisRevoked.push(token);
        if (done) setTimeout(() => done({ successful: true }), 0);
      },
    },
  };
})();`;

/**
 * `api.js`, faked: `gapi.load('picker')` defines `google.picker`, whose
 * builder records the views and settings it is given and, when shown, hands
 * them to this process (`__driveFakePick`), which answers with the file
 * chosen or none. Constants are the Picker's own values.
 */
const FAKE_GAPI = `(() => {
  const ns = {
    ViewId: { DOCS: 'all' },
    Action: { PICKED: 'picked', CANCEL: 'cancel', LOADED: 'loaded', ERROR: 'error' },
    Response: { ACTION: 'action', DOCUMENTS: 'docs' },
    Document: { ID: 'id', NAME: 'name', MIME_TYPE: 'mimeType' },
    Feature: { MULTISELECT_ENABLED: 'multiselectEnabled', SUPPORT_DRIVES: 'sdr' },
  };
  class DocsView {
    constructor(viewId) {
      this.viewId = viewId;
      this.calls = [];
    }
  }
  for (const method of [
    'setIncludeFolders', 'setMimeTypes', 'setOwnedByMe', 'setFileIds', 'setParent',
    'setEnableDrives', 'setSelectFolderEnabled', 'setMode', 'setQuery', 'setStarred',
  ]) {
    DocsView.prototype[method] = function (arg) {
      this.calls.push([method, arg]);
      return this;
    };
  }
  class PickerBuilder {
    constructor() {
      this.views = [];
      this.settings = { hasToken: false };
      this.callback = null;
    }
    addView(view) { this.views.push(view); return this; }
    enableFeature() { return this; }
    setDeveloperKey(key) { this.settings.developerKey = key; return this; }
    setAppId(appId) { this.settings.appId = appId; return this; }
    setOAuthToken(token) { this.settings.hasToken = typeof token === 'string' && token !== ''; return this; }
    setOrigin(origin) { this.settings.origin = origin; return this; }
    setCallback(callback) { this.callback = callback; return this; }
    build() {
      const builder = this;
      return {
        setVisible(visible) {
          if (!visible) return;
          const record = {
            views: builder.views.map((v) => ({ viewId: v.viewId, calls: v.calls })),
            ...builder.settings,
          };
          window.__driveFakePick(record).then((answer) => {
            const done = builder.callback;
            if (!done) return;
            done({ action: ns.Action.LOADED });
            if (!answer) {
              done({ action: ns.Action.CANCEL });
              return;
            }
            const doc = { id: answer.id, name: answer.name, mimeType: 'text/plain' };
            done({ action: ns.Action.PICKED, docs: [doc] });
          });
        },
        dispose() {},
      };
    }
  }
  ns.DocsView = DocsView;
  ns.PickerBuilder = PickerBuilder;
  window.gapi = window.gapi || {};
  window.gapi.load = (name, handlers) => {
    const callback = typeof handlers === 'function' ? handlers : handlers && handlers.callback;
    setTimeout(() => {
      if (name === 'picker') {
        window.google = window.google || {};
        window.google.picker = ns;
      }
      if (callback) callback();
    }, 0);
  };
})();`;

/** A Drive API error, in Google's JSON shape. */
function googleError(status: number, reason: string, message: string): string {
  return JSON.stringify({
    error: { code: status, message, errors: [{ domain: 'global', reason, message }] },
  });
}

/** What Drive answers for each failure the fake models. */
const ERRORS: Record<number, { reason: string; message: string }> = {
  400: { reason: 'badRequest', message: 'Bad Request' },
  401: { reason: 'authError', message: 'Invalid Credentials' },
  403: {
    reason: 'insufficientFilePermissions',
    message: 'The user does not have sufficient permissions for this file.',
  },
  404: { reason: 'notFound', message: 'File not found.' },
  429: { reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' },
  500: { reason: 'backendError', message: 'Backend Error' },
  503: { reason: 'backendError', message: 'Service Unavailable' },
};

/**
 * The parts of a `multipart/related` body — or null when it is not one, read
 * as strictly as RFC 2046 has it: the body opens with `--boundary` CRLF;
 * every part is header lines each ending in CRLF, an empty line, then the
 * content; parts are separated by CRLF `--boundary` CRLF; the body closes
 * with CRLF `--boundary--` and at most one CRLF. A bare line feed anywhere in
 * that framing — a body delimited by `\n` alone — is no multipart body. The
 * content of a part is taken as it is, its own line endings included.
 */
function parseMultipart(
  body: string,
  contentType: string,
): Array<{ headers: Record<string, string>; content: string }> | null {
  const type = /^multipart\/related;\s*boundary=("?)([A-Za-z0-9'()+_,./:=?-]{1,70})\1$/i.exec(contentType.trim());
  if (!type) return null;
  const delimiter = `--${type[2]}`;
  if (!body.startsWith(`${delimiter}\r\n`)) return null;
  const close = `\r\n${delimiter}--`;
  const end = body.lastIndexOf(close);
  if (end < delimiter.length) return null;
  const tail = body.slice(end + close.length);
  if (tail !== '' && tail !== '\r\n') return null;
  const parts: Array<{ headers: Record<string, string>; content: string }> = [];
  for (const part of body.slice(delimiter.length + 2, end).split(`\r\n${delimiter}\r\n`)) {
    const blank = part.indexOf('\r\n\r\n');
    if (blank < 0) return null;
    const headers: Record<string, string> = {};
    for (const line of part.slice(0, blank).split('\r\n')) {
      const header = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/.exec(line);
      if (!header) return null;
      headers[header[1].toLowerCase()] = header[2];
    }
    parts.push({ headers, content: part.slice(blank + 4) });
  }
  return parts;
}

/** The MD5 of `text` as UTF-8, in hex — what Drive reports as `md5Checksum`. */
function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * The fields of a resource the fake models, as a `fields` selector may name
 * them: `true` for a plain field, the nested fields for a nested resource.
 */
interface FieldSchema {
  [field: string]: true | FieldSchema;
}

/** Drive's files resource, as far as the fake models it. */
const FILE_FIELDS: FieldSchema = {
  kind: true,
  id: true,
  name: true,
  mimeType: true,
  version: true,
  modifiedTime: true,
  headRevisionId: true,
  md5Checksum: true,
  resourceKey: true,
  webViewLink: true,
  trashed: true,
  capabilities: { canEdit: true },
  lastModifyingUser: { kind: true, displayName: true },
};

/** A `files.list` answer. */
const FILE_LIST_FIELDS: FieldSchema = { kind: true, incompleteSearch: true, nextPageToken: true, files: FILE_FIELDS };

/** An `about` answer. */
const ABOUT_FIELDS: FieldSchema = { kind: true, user: { kind: true, displayName: true, emailAddress: true } };

/** What Drive selects of a file when a request names no fields. */
const DEFAULT_FILE_SELECTOR = 'kind,id,name,mimeType';

/** What Drive selects of a list when a request names no fields. */
const DEFAULT_LIST_SELECTOR = `kind,incompleteSearch,files(${DEFAULT_FILE_SELECTOR})`;

/** The fields a selector picks out: `true` for the whole field, the nested ones otherwise. */
interface Selection {
  [field: string]: true | Selection;
}

/**
 * A `fields` selector read as Drive's partial-response syntax has it — fields
 * separated by commas, `a/b` or `a(b,c)` for fields of a nested resource, `*`
 * for every field at its level — or null when it does not parse or names a
 * field `schema` lacks.
 */
function parseSelector(selector: string, schema: FieldSchema): Selection | null {
  let at = 0;
  // field := '*' | name ( '/' field | '(' fields ')' )?
  const field = (fields: FieldSchema, into: Selection): boolean => {
    if (selector[at] === '*') {
      at += 1;
      for (const name of Object.keys(fields)) into[name] = true;
      return true;
    }
    const name = /^[A-Za-z][A-Za-z0-9_]*/.exec(selector.slice(at))?.[0];
    if (name === undefined || !Object.hasOwn(fields, name)) return false;
    at += name.length;
    const nested = fields[name];
    if (selector[at] !== '/' && selector[at] !== '(') {
      into[name] = true;
      return true;
    }
    if (nested === true) return false; // a plain field has no fields
    // Named whole already, it stays whole; named in part, the parts add up.
    const already = into[name];
    const sub: Selection = already === undefined || already === true ? {} : already;
    const open = selector[at];
    at += 1;
    const parsed = open === '/' ? field(nested, sub) : list(nested, sub) && selector[at] === ')';
    if (!parsed) return false;
    if (open === '(') at += 1;
    if (already !== true) into[name] = sub;
    return true;
  };
  // fields := field ( ',' field )*
  const list = (fields: FieldSchema, into: Selection): boolean => {
    for (;;) {
      if (!field(fields, into)) return false;
      if (selector[at] !== ',') return true;
      at += 1;
    }
  };
  const selected: Selection = {};
  return list(schema, selected) && at === selector.length ? selected : null;
}

/** `value` with only the fields `selected` names — in each element alike, for an array. */
function project(value: unknown, selected: Selection | true): unknown {
  if (selected === true || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => project(item, selected));
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(selected)) {
    const field = (value as Record<string, unknown>)[name];
    if (field !== undefined) out[name] = project(field, sub);
  }
  return out;
}

/** The in-memory Drive behind the REST route. */
class FakeDrive {
  readonly requests: FakeDriveRequest[] = [];
  readonly valid = new Set<string>();
  private readonly store = new Map<string, FakeDriveFile & { revision: number }>();
  private readonly failures: Array<{ status: number; reason?: string }> = [];
  private lastId = 0;
  private lastTime = 0;

  files(): FakeDriveFile[] {
    return [...this.store.values()].map((f) => this.view(f));
  }

  file(id: string): FakeDriveFile {
    return this.view(this.stored(id));
  }

  seed(file: FakeDriveSeed): FakeDriveFile {
    const id = file.id ?? `1FakeDriveFile${String(++this.lastId).padStart(4, '0')}`;
    if (this.store.has(id)) throw new Error(`fake Drive: file ${id} exists`);
    if (file.keyRequired && file.resourceKey === undefined) throw new Error(`fake Drive: ${id} needs a resource key`);
    this.store.set(id, {
      id,
      name: file.name,
      mimeType: file.mimeType ?? 'text/plain',
      body: file.body,
      version: '1',
      revision: 1,
      headRevisionId: 'r1',
      md5Checksum: md5(file.body),
      modifiedTime: this.tick(),
      trashed: false,
      canEdit: file.canEdit ?? true,
      granted: file.granted ?? true,
      ...(file.resourceKey !== undefined ? { resourceKey: file.resourceKey } : {}),
      keyRequired: file.keyRequired ?? false,
      lastModifiedBy: file.by ?? FAKE_ACCOUNT.name,
    });
    return this.file(id);
  }

  grant(id: string): void {
    this.stored(id).granted = true;
  }

  bump(id: string, body?: string, by = 'A classmate'): FakeDriveFile {
    const file = this.stored(id);
    this.write(file, body ?? `${file.body}// changed in Drive\n`, by);
    return this.view(file);
  }

  touchMeta(id: string): FakeDriveFile {
    const file = this.stored(id);
    file.version = String(Number(file.version) + 1);
    file.modifiedTime = this.tick();
    return this.view(file);
  }

  setReadonly(id: string): void {
    this.stored(id).canEdit = false;
  }

  trash(id: string): void {
    const file = this.stored(id);
    file.trashed = true;
    file.version = String(Number(file.version) + 1);
  }

  failNext(status: number, reason?: string): void {
    this.failures.push({ status, reason });
  }

  /** Answer one request to Drive's REST API (never a CORS preflight: Playwright answers those). */
  async answer(route: Route): Promise<void> {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());
    const headers = await req.allHeaders();
    const token = /^Bearer (\S+)$/.exec(headers['authorization'] ?? '')?.[1] ?? null;
    const resourceKeys = headers['x-goog-drive-resource-keys'];
    const entry: FakeDriveRequest = {
      method,
      path: `${url.pathname}${url.search}`,
      token,
      ...(resourceKeys !== undefined ? { resourceKeys } : {}),
      status: 0,
    };
    this.requests.push(entry);
    const reply = async (status: number, body: string, contentType = 'application/json; charset=UTF-8') => {
      entry.status = status;
      await route.fulfill({ status, headers: { ...CORS, 'content-type': contentType }, body });
    };
    const fail = (status: number, reason?: string, message?: string) => {
      const known = ERRORS[status] ?? { reason: 'unknown', message: 'Error' };
      return reply(status, googleError(status, reason ?? known.reason, message ?? known.message));
    };

    if (token === null || !this.valid.has(token)) return fail(401);
    const failure = this.failures.shift();
    if (failure) return fail(failure.status, failure.reason);

    const path = url.pathname;
    const params = url.searchParams;
    // What a metadata answer holds: the fields the request names, or Drive's
    // default ones when it names none.
    const fields = params.get('fields');
    const select = (schema: FieldSchema, byDefault: string): Selection | null =>
      parseSelector(fields ?? byDefault, schema);
    const badFields = () => fail(400, 'invalidParameter', `Invalid field selection ${fields}`);
    if (method === 'GET' && path === '/drive/v3/about') {
      // Drive answers `about` only for a selector.
      if (fields === null) return fail(400, 'required', "The 'fields' parameter is required for this method.");
      const selected = parseSelector(fields, ABOUT_FIELDS);
      if (selected === null) return badFields();
      const user = { kind: 'drive#user', displayName: FAKE_ACCOUNT.name, emailAddress: FAKE_ACCOUNT.email };
      return reply(200, JSON.stringify(project({ kind: 'drive#about', user }, selected)));
    }
    if (method === 'GET' && path === '/drive/v3/files') {
      const selected = select(FILE_LIST_FIELDS, DEFAULT_LIST_SELECTOR);
      if (selected === null) return badFields();
      const listed = [...this.store.values()]
        .filter((f) => f.granted && !(params.get('q') === 'trashed=false' && f.trashed))
        .sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : a.modifiedTime > b.modifiedTime ? -1 : 0))
        .slice(0, Number(params.get('pageSize') ?? 100))
        .map((f) => this.resource(f));
      const list = { kind: 'drive#fileList', incompleteSearch: false, files: listed };
      return reply(200, JSON.stringify(project(list, selected)));
    }
    if (method === 'POST' && path === '/upload/drive/v3/files') {
      if (params.get('uploadType') !== 'multipart') return fail(400);
      const selected = select(FILE_FIELDS, DEFAULT_FILE_SELECTOR);
      if (selected === null) return badFields();
      const parts = parseMultipart(req.postDataBuffer()?.toString('utf8') ?? '', headers['content-type'] ?? '');
      if (parts === null || parts.length !== 2) return fail(400, 'badContent');
      const [meta, media] = parts;
      if (!/^application\/json\b/i.test(meta.headers['content-type'] ?? '')) return fail(400, 'badContent');
      let resource: { name?: unknown; mimeType?: unknown; parents?: unknown };
      try {
        resource = JSON.parse(meta.content) as typeof resource;
      } catch {
        return fail(400, 'parseError');
      }
      if (typeof resource.name !== 'string') return fail(400, 'required');
      const created = this.seed({
        name: resource.name,
        body: media.content,
        mimeType:
          typeof resource.mimeType === 'string'
            ? resource.mimeType
            : (media.headers['content-type'] ?? 'text/plain').split(';')[0],
      });
      return reply(200, JSON.stringify(project(this.resource(this.stored(created.id)), selected)));
    }

    const file = /^\/(upload\/)?drive\/v3\/files\/([A-Za-z0-9_-]+)$/.exec(path);
    if (file === null) return fail(400);
    const [, upload, id] = file;
    // The content itself (`alt=media`) has no fields to select.
    const content = method === 'GET' && !upload && params.get('alt') === 'media';
    const selected = content ? true : select(FILE_FIELDS, DEFAULT_FILE_SELECTOR);
    if (selected === null) return badFields();
    const found = this.store.get(id);
    // Not granted to this app, or a file that needs the resource key the
    // request did not carry: Drive says it is not there.
    if (
      found === undefined ||
      !found.granted ||
      (found.keyRequired && resourceKeys !== `${found.id}/${found.resourceKey}`)
    ) {
      return fail(404);
    }
    if (content) return reply(200, found.body, `${found.mimeType}; charset=UTF-8`);
    if (method === 'GET' && !upload) return reply(200, JSON.stringify(project(this.resource(found), selected)));
    if (method === 'PATCH' && upload) {
      if (params.get('uploadType') !== 'media') return fail(400);
      if (!found.canEdit) return fail(403, 'insufficientFilePermissions');
      this.write(found, req.postDataBuffer()?.toString('utf8') ?? '', FAKE_ACCOUNT.name);
      return reply(200, JSON.stringify(project(this.resource(found), selected)));
    }
    return fail(400);
  }

  /** The file as Drive's files resource has it: every field the fake models ({@link FILE_FIELDS}). */
  private resource(f: FakeDriveFile): Record<string, unknown> {
    return {
      kind: 'drive#file',
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      version: f.version,
      modifiedTime: f.modifiedTime,
      headRevisionId: f.headRevisionId,
      md5Checksum: f.md5Checksum,
      ...(f.resourceKey !== undefined ? { resourceKey: f.resourceKey } : {}),
      webViewLink: `${DRIVE_WEB_ORIGINS[0]}/file/d/${f.id}/view?usp=drivesdk`,
      trashed: f.trashed,
      capabilities: { canEdit: f.canEdit },
      lastModifyingUser: { kind: 'drive#user', displayName: f.lastModifiedBy },
    };
  }

  private stored(id: string): FakeDriveFile & { revision: number } {
    const file = this.store.get(id);
    if (!file) throw new Error(`fake Drive: no file ${id}`);
    return file;
  }

  private view(f: FakeDriveFile & { revision: number }): FakeDriveFile {
    const { revision: _revision, ...file } = f;
    return { ...file };
  }

  /** New content: a new revision, version, checksum and time. */
  private write(file: FakeDriveFile & { revision: number }, body: string, by: string): void {
    file.body = body;
    file.revision += 1;
    file.headRevisionId = `r${file.revision}`;
    file.version = String(Number(file.version) + 1);
    file.md5Checksum = md5(body);
    file.modifiedTime = this.tick();
    file.lastModifiedBy = by;
  }

  /** The clock as Drive's `modifiedTime`, strictly increasing so every write is ordered. */
  private tick(): string {
    this.lastTime = Math.max(Date.now(), this.lastTime + 1);
    return new Date(this.lastTime).toISOString();
  }
}

/**
 * Install the fakes on `page` before it navigates. `config` is served as the
 * deployment's `drive.json`; omitted, the preview's own file answers.
 */
export async function installDriveFakes(page: Page, opts: DriveFakeOptions = {}): Promise<DriveFakes> {
  const drive = new FakeDrive();
  const signIns: FakeSignIn[] = opts.signIn === undefined ? [] : [opts.signIn].flat();
  const nextTokens: string[] = [];
  const picks: Array<{ id: string; name: string } | null> = [];
  let issuedCount = 0;
  let releaseGis = (): void => {};
  const gisHeld = opts.holdGis ? new Promise<void>((resolve) => (releaseGis = resolve)) : Promise.resolve();

  const fakes: DriveFakes = {
    googleRequests: [],
    unanswered: [],
    tokenRequests: [],
    issued: [],
    pickerBuilds: [],
    requests: drive.requests,
    revokeRequests: [],
    revoked: [],
    revokeOk: opts.revokeOk ?? true,
    expiresIn: opts.expiresIn ?? 3600,
    releaseGis: () => releaseGis(),
    answerSignIns: (...answers) => void signIns.push(...answers),
    answerPicks: (...answers) => void picks.push(...answers),
    files: () => drive.files(),
    file: (id) => drive.file(id),
    seed: (file) => drive.seed(file),
    grant: (id) => drive.grant(id),
    bump: (id, body, by) => drive.bump(id, body, by),
    touchMeta: (id) => drive.touchMeta(id),
    setReadonly: (id) => drive.setReadonly(id),
    trash: (id) => drive.trash(id),
    expireToken: (token) => void drive.valid.delete(token),
    issueToken: (token) => void nextTokens.push(token),
    failNext: (status, reason) => drive.failNext(status, reason),
  };

  page.on('request', (req) => {
    if (GOOGLE_HOST.test(new URL(req.url()).hostname)) fakes.googleRequests.push(req.url());
  });

  // GIS's token requests and the Picker's answers, made in this process.
  await page.exposeFunction(
    '__driveFakeToken',
    (req: {
      prompt: string | null;
      login_hint: string | null;
      activated: boolean;
      inEvent: string | null;
      scope: string;
    }) => {
      const answer = signIns.shift() ?? 'grant';
      const record: FakeTokenRequest = {
        prompt: req.prompt,
        login_hint: req.login_hint,
        activated: req.activated,
        inEvent: req.inEvent,
        answer,
      };
      fakes.tokenRequests.push(record);
      if (answer === 'popup_closed' || answer === 'popup_failed_to_open') return { errorType: answer };
      if (answer === 'access_denied') return { response: { error: 'access_denied' } };
      const token = nextTokens.shift() ?? `fake-token-${++issuedCount}`;
      record.token = token;
      fakes.issued.push(token);
      drive.valid.add(token);
      const scope = answer === 'scope_unticked' ? 'openid' : req.scope;
      return { response: { access_token: token, expires_in: fakes.expiresIn, scope, token_type: 'Bearer' } };
    },
  );
  await page.exposeFunction('__driveFakePick', (build: FakePickerBuild) => {
    fakes.pickerBuilds.push(build);
    const answer = picks.shift() ?? null;
    // Choosing a file in the Picker is what grants it to the app.
    if (answer !== null) drive.grant(answer.id);
    return answer;
  });

  await page.route(
    (url) => GOOGLE_HOST.test(url.hostname),
    (route) => {
      fakes.unanswered.push(route.request().url());
      return route.abort();
    },
  );
  await page.route(DRIVE_SCRIPTS.gis, async (route) => {
    await gisHeld;
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_GIS }).catch(() => {});
  });
  await page.route(DRIVE_SCRIPTS.gapi, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_GAPI }),
  );
  await page.route(
    (url) => url.origin === DRIVE_API_ORIGIN,
    (route) => drive.answer(route),
  );
  // ASSUMED, NOT KNOWN: that Google's revocation endpoint answers a page's
  // POST with a CORS header, so the page may read the answer. This route
  // answers with one; sign-out (auth.ts) counts an answer it may not read as
  // "not confirmed". If Google sends none, every real sign-out would say
  // "Google did not confirm the revocation" while this spec stays green — only
  // the manual check against Google (plan F.4 step 9) can tell.
  await page.route(DRIVE_REVOKE_URL, async (route) => {
    const req = route.request();
    const token = new URLSearchParams(req.postDataBuffer()?.toString('utf8') ?? '').get('token');
    if (token !== null) fakes.revokeRequests.push(token);
    // Google confirms only the revocation of a token it still accepts.
    const ok = req.method() === 'POST' && token !== null && fakes.revokeOk && drive.valid.has(token);
    if (ok) {
      fakes.revoked.push(token);
      drive.valid.delete(token);
    }
    await route.fulfill({
      status: ok ? 200 : 400,
      headers: { ...CORS, 'content-type': 'application/json; charset=UTF-8' },
      body: ok ? '{}' : JSON.stringify({ error: 'invalid_token', error_description: 'Token expired or revoked' }),
    });
  });

  const { config } = opts;
  if (config) {
    await page.route('**/drive.json', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }),
    );
  }
  return fakes;
}

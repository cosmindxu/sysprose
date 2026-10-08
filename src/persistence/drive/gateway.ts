/**
 * Google Drive (optional) — the REST calls, and an in-memory stand-in for them.
 *
 * Six requests to Drive's v3 API, each authorised by the bearer token the
 * caller's `token()` hands over for that one request. The token travels in the
 * `Authorization` header and nowhere else — never in a URL, where history,
 * logs and `Referer` would keep it. Everything that enters a request is held
 * to a shape first: a file id to Drive's alphabet before it enters the path, a
 * resource key likewise before it enters the `X-Goog-Drive-Resource-Keys`
 * header (sent only when the reference has one, which no file this app
 * created does).
 *
 * Everything that comes back is held to a shape too: metadata must read as a
 * {@link DriveFileMeta}, a download must be UTF-8 text within
 * {@link DRIVE_DOWNLOAD_MAX_BYTES}, or the call fails with a
 * {@link DriveBadResponseError}. Failures are {@link DriveError}s whose message
 * is the status and a reason code, never anything a response said.
 *
 * Time: a request without an answer is abandoned after 30 s (60 s for an
 * upload), and a call that failed lets go of whatever of the answer it did not
 * read. Retries: one, after a rate limit or a 5xx, for GET and PATCH only — a
 * POST creates a file, and repeating one whose answer was lost could leave
 * two. The wait is 1 s plus up to 0.5 s of jitter, unless the answer names one
 * in `Retry-After` AND lets the page read it: that header is not
 * CORS-safelisted, so a cross-origin answer shows it only when the server
 * lists it in `Access-Control-Expose-Headers`, and nothing here assumes Drive
 * does. A readable wait is honoured up to {@link DRIVE_RETRY_AFTER_MAX_MS}; a longer
 * one is not waited for here, but reported as `retryAfterMs`.
 *
 * Drive v3 has no conditional write (no ETag, no `If-Match`); the conflict
 * check that stands in for one belongs to the caller, which compares
 * {@link DriveFileMeta.md5Checksum} before it calls `update`.
 */
import { DRIVE_API_ORIGIN, DRIVE_WEB_ORIGINS } from './hosts';
import { DRIVE_FILE_ID, DRIVE_RESOURCE_KEY } from './links';
import {
  DRIVE_DOWNLOAD_MAX_BYTES,
  DRIVE_FIELDS,
  DRIVE_REASON,
  DRIVE_UPLOAD_MAX_BYTES,
  DriveAuthError,
  DriveBadResponseError,
  DriveError,
  DriveForbiddenError,
  DriveNetworkError,
  DriveNotFoundError,
  DriveRateLimitError,
  driveErrorMessage,
  type DriveFileMeta,
  type DriveFileRef,
} from './types';

/** Who is signed in, as Drive's `about` reports it; either may be unknown. */
export interface DriveAccount {
  email: string | null;
  name: string | null;
}

/** What the app asks of Google Drive. Every method rejects with a {@link DriveError}. */
export interface DriveGateway {
  /** The signed-in account (`drive/v3/about`). */
  about(): Promise<DriveAccount>;
  /** A file's metadata — the fields of {@link DRIVE_FIELDS}. */
  get(ref: DriveFileRef): Promise<DriveFileMeta>;
  /** A file's content, as UTF-8 text. */
  download(ref: DriveFileRef): Promise<string>;
  /** A new `text/plain` file named `name` in the root of My Drive. */
  create(name: string, text: string): Promise<DriveFileMeta>;
  /** Replace a file's content (its metadata is left alone). */
  update(ref: DriveFileRef, text: string): Promise<DriveFileMeta>;
  /** The files this app can see, most recently modified first, untrashed, at most `limit`. */
  list(limit: number): Promise<DriveFileMeta[]>;
}

/** How long a metadata request or a download may go unanswered. */
export const DRIVE_TIMEOUT_MS = 30_000;
/** How long an upload may go unanswered. */
export const DRIVE_UPLOAD_TIMEOUT_MS = 60_000;
/**
 * The longest `Retry-After` the one automatic retry waits for. A server that
 * asks for more gets no retry from here: the error carries the wait
 * (`retryAfterMs`) and the user decides, rather than watch a request hang.
 * It applies only to a `Retry-After` the page can read (see the module
 * comment); without one the retry waits 1–1.5 s.
 */
export const DRIVE_RETRY_AFTER_MAX_MS = 10_000;

/** The content type of every upload: there is no registered type for `.sysml`. */
const TEXT_TYPE = 'text/plain; charset=UTF-8';
/** An error body is read for its reason code only, and only this much of it. */
const ERROR_BODY_MAX_BYTES = 64 * 1024;
/** The most files Drive returns in one `files.list` page. */
const LIST_MAX = 1000;
/** A multipart boundary that needs no quoting in `Content-Type` (RFC 2046 allows up to 70 characters). */
const MULTIPART_BOUNDARY = /^[A-Za-z0-9_-]{1,70}$/;
/** `Retry-After` as an HTTP-date (IMF-fixdate), the form RFC 9110 servers send. */
const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` is absent, or a string. */
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/**
 * `value` is a {@link DriveFileMeta}: every required field of its type, every
 * optional one absent or a string, the id in Drive's alphabet (it will enter a
 * request path) and the resource key too (it will enter a header).
 */
export function isDriveFileMeta(value: unknown): value is DriveFileMeta {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    DRIVE_FILE_ID.test(value.id) &&
    typeof value.name === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.version === 'string' &&
    typeof value.modifiedTime === 'string' &&
    typeof value.trashed === 'boolean' &&
    typeof value.canEdit === 'boolean' &&
    optionalString(value.headRevisionId) &&
    optionalString(value.md5Checksum) &&
    optionalString(value.webViewLink) &&
    optionalString(value.lastModifiedBy) &&
    (value.resourceKey === undefined ||
      (typeof value.resourceKey === 'string' && DRIVE_RESOURCE_KEY.test(value.resourceKey)))
  );
}

/**
 * Drive's files resource, as {@link DRIVE_FIELDS} selects it, read into a
 * {@link DriveFileMeta} (`capabilities.canEdit` → `canEdit`,
 * `lastModifyingUser.displayName` → `lastModifiedBy`), or null when it does
 * not read as one.
 */
function fileMetaFrom(json: unknown): DriveFileMeta | null {
  if (!isRecord(json)) return null;
  const capabilities = isRecord(json.capabilities) ? json.capabilities : {};
  const modifier = isRecord(json.lastModifyingUser) ? json.lastModifyingUser : {};
  const meta: Record<string, unknown> = {
    id: json.id,
    name: json.name,
    mimeType: json.mimeType,
    version: json.version,
    modifiedTime: json.modifiedTime,
    trashed: json.trashed,
    canEdit: capabilities.canEdit,
  };
  const optional: Array<[keyof DriveFileMeta, unknown]> = [
    ['headRevisionId', json.headRevisionId],
    ['md5Checksum', json.md5Checksum],
    ['resourceKey', json.resourceKey],
    ['webViewLink', json.webViewLink],
    ['lastModifiedBy', modifier.displayName],
  ];
  for (const [key, value] of optional) if (value !== undefined) meta[key] = value;
  return isDriveFileMeta(meta) ? meta : null;
}

/**
 * The {@link DriveError} for an HTTP failure: 401 → auth; 429, or a 403 whose
 * reason ends in `RateLimitExceeded` → rate limit; any other 403 → forbidden;
 * 404 → not found; anything else → the base class. A reason that is not a
 * plain code is dropped. Shared by both gateways, so the in-memory one fails
 * the way the real one does.
 */
export function driveErrorFor(status: number, reason?: string, retryAfterMs?: number): DriveError {
  const code = reason !== undefined && DRIVE_REASON.test(reason) ? reason : undefined;
  const message = driveErrorMessage(status, code);
  if (status === 401) return new DriveAuthError(message, status, code, retryAfterMs);
  if (status === 429 || (status === 403 && code !== undefined && /RateLimitExceeded$/i.test(code))) {
    return new DriveRateLimitError(message, status, code, retryAfterMs);
  }
  if (status === 403) return new DriveForbiddenError(message, status, code, retryAfterMs);
  if (status === 404) return new DriveNotFoundError(message, status, code, retryAfterMs);
  return new DriveError(message, status, code, retryAfterMs);
}

/** A failure decided before any request leaves (status 0). */
function refused(reason: string): DriveError {
  return new DriveError(driveErrorMessage(0, reason), 0, reason);
}

/** Refuse a reference whose id or key would not survive the path or the header as written. */
function checkRef(ref: DriveFileRef): void {
  if (!DRIVE_FILE_ID.test(ref.id)) throw refused('bad-ref');
  if (ref.resourceKey !== undefined && !DRIVE_RESOURCE_KEY.test(ref.resourceKey)) throw refused('bad-ref');
}

/** Refuse a text Drive would refuse: more than one simple upload carries. */
function checkUploadSize(text: string): void {
  if (new TextEncoder().encode(text).byteLength > DRIVE_UPLOAD_MAX_BYTES) throw refused('too-large');
}

/** `limit` as a `pageSize` Drive accepts. */
function pageSize(limit: number): number {
  return Math.min(LIST_MAX, Math.max(1, Math.floor(limit) || 1));
}

/**
 * The body and content type of a `multipart/related` upload: the metadata as
 * JSON, then the text.
 *
 * Every delimiter and header line ends in CRLF, as RFC 2046 and Drive's own
 * example have it; a server is entitled to refuse a body delimited by bare
 * line feeds. The text itself goes in exactly as given — its `\n` line endings
 * are content, not framing. `boundary` must not occur in either part
 * ({@link multipartBoundary} draws one that does not); this throws if it does,
 * rather than send a body whose parts the server would split differently.
 */
export function buildMultipart(
  meta: object,
  text: string,
  boundary: string,
): { body: string; contentType: string } {
  if (!MULTIPART_BOUNDARY.test(boundary)) throw new RangeError('the multipart boundary is not a plain token');
  const json = JSON.stringify(meta);
  if (json.includes(boundary) || text.includes(boundary)) {
    throw new RangeError('the multipart boundary occurs in the content');
  }
  const CRLF = '\r\n';
  const body =
    `--${boundary}${CRLF}` +
    `Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}` +
    `${json}${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Type: ${TEXT_TYPE}${CRLF}${CRLF}` +
    `${text}${CRLF}` +
    `--${boundary}--${CRLF}`;
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

/**
 * A random multipart boundary that `content` does not contain — drawn again
 * when it does, which for 128 random bits means content written to collide.
 */
export function multipartBoundary(
  content: string,
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const hex = Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
    const boundary = `part_${hex}`;
    if (!content.includes(boundary)) return boundary;
  }
  throw new Error('no multipart boundary could be drawn that the content does not contain');
}

/**
 * A response body, refused once it passes `max` bytes: by its declared
 * `Content-Length` before reading, then by what actually arrives (a body may be
 * compressed, chunked or undeclared), stopping the read at the cap. The reason
 * is `too-large-download`, never the `too-large` of an upload refused before
 * sending, so the two cannot be worded alike by mistake.
 */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const tooLarge = (): DriveError =>
    new DriveBadResponseError(
      driveErrorMessage(res.status, 'too-large-download'),
      res.status,
      'too-large-download',
    );
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } else {
    const whole = new Uint8Array(await res.arrayBuffer());
    total = whole.byteLength;
    if (total > max) throw tooLarge();
    chunks.push(whole);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** `bytes` as UTF-8, or null when they are not (a lone byte of a binary file is enough). */
function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Drive's reason code from a JSON error body (`error.errors[0].reason`, else `error.status`), if any. */
async function errorReason(res: Response): Promise<string | undefined> {
  if (!/json/i.test(res.headers.get('content-type') ?? '')) return undefined;
  try {
    const text = utf8(await readCapped(res, ERROR_BODY_MAX_BYTES));
    const body: unknown = text === null ? null : JSON.parse(text);
    const error = isRecord(body) && isRecord(body.error) ? body.error : {};
    const first = Array.isArray(error.errors) && isRecord(error.errors[0]) ? error.errors[0] : {};
    for (const candidate of [first.reason, error.status]) {
      if (typeof candidate === 'string' && DRIVE_REASON.test(candidate)) return candidate;
    }
  } catch {
    /* an unreadable error body names no reason */
  }
  return undefined;
}

/** A request as {@link createRestDriveGateway} sends it. */
interface DriveRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  params: Record<string, string>;
  /** Sent as `X-Goog-Drive-Resource-Keys` when it carries a key. */
  ref?: DriveFileRef;
  contentType?: string;
  body?: string;
  timeoutMs: number;
}

/**
 * The gateway over Drive's REST API.
 *
 * `token` is asked once per request (a retry asks again); when it has none the
 * call fails with a {@link DriveAuthError} before anything is sent. `fetchImpl`
 * replaces `fetch` (tests), `timeoutMs`/`uploadTimeoutMs` the two time limits,
 * and `now` the clock an HTTP-date `Retry-After` is read against.
 */
export function createRestDriveGateway(opts: {
  token: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  now?: () => number;
}): DriveGateway {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DRIVE_TIMEOUT_MS;
  const uploadTimeoutMs = opts.uploadTimeoutMs ?? DRIVE_UPLOAD_TIMEOUT_MS;

  /**
   * `Retry-After` in ms — delay-seconds or an HTTP-date — or undefined, which
   * is also what a cross-origin answer that does not expose the header gives.
   */
  const retryAfter = (value: string | null): number | undefined => {
    const v = value?.trim() ?? '';
    if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
    if (!HTTP_DATE.test(v)) return undefined;
    const at = Date.parse(v);
    return Number.isNaN(at) ? undefined : Math.max(0, at - now());
  };

  /** How long to wait before the one retry, or null when `err` gets none. */
  const retryDelay = (err: unknown): number | null => {
    if (!(err instanceof DriveError)) return null;
    const transient = err instanceof DriveRateLimitError || (err.status >= 500 && err.status <= 599);
    if (!transient) return null;
    if (err.retryAfterMs !== undefined) return err.retryAfterMs <= DRIVE_RETRY_AFTER_MAX_MS ? err.retryAfterMs : null;
    return 1000 + Math.floor(Math.random() * 500);
  };

  /** One attempt: headers, time limit, status → error, and `read` for a 2xx. */
  const attempt = async <T>(req: DriveRequest, read: (res: Response) => Promise<T>): Promise<T> => {
    const token = opts.token();
    if (token === null) throw new DriveAuthError(driveErrorMessage(0, 'no-token'), 0, 'no-token');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (req.ref?.resourceKey !== undefined) {
      headers['X-Goog-Drive-Resource-Keys'] = `${req.ref.id}/${req.ref.resourceKey}`;
    }
    if (req.contentType !== undefined) headers['Content-Type'] = req.contentType;
    const url = new URL(req.path, DRIVE_API_ORIGIN);
    for (const [key, value] of Object.entries(req.params)) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const res = await doFetch(url.href, {
        method: req.method,
        headers,
        body: req.body,
        signal: controller.signal,
        // Metadata feeds the conflict check: never an answer from the HTTP cache.
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!res.ok) {
        throw driveErrorFor(res.status, await errorReason(res), retryAfter(res.headers.get('retry-after')));
      }
      return await read(res);
    } catch (err) {
      if (err instanceof DriveError) throw err;
      // The timer covers the body as well as the headers: a read it cut short
      // is a timeout, like a request that never answered.
      const reason = controller.signal.aborted ? 'timeout' : 'network';
      throw new DriveNetworkError(driveErrorMessage(0, reason), 0, reason);
    } finally {
      clearTimeout(timer);
      // Let go of what was not read — a body refused by its Content-Length or
      // its type, an error body that names no reason — so the request does not
      // stay open, holding a stream and its buffered bytes, after the call has
      // already failed. A body read to its end is not touched by this.
      controller.abort();
    }
  };

  /** {@link attempt}, once more after a transient failure — for GET and PATCH only. */
  const send = async <T>(req: DriveRequest, read: (res: Response) => Promise<T>): Promise<T> => {
    const retries = req.method === 'POST' ? 0 : 1;
    for (let tried = 0; ; tried++) {
      try {
        return await attempt(req, read);
      } catch (err) {
        const wait = tried < retries ? retryDelay(err) : null;
        if (wait === null) throw err;
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
    }
  };

  const bad = (res: Response, reason: string): DriveError =>
    new DriveBadResponseError(driveErrorMessage(res.status, reason), res.status, reason);

  const readJson = async (res: Response): Promise<unknown> => {
    if (!/json/i.test(res.headers.get('content-type') ?? '')) throw bad(res, 'not-json');
    const text = utf8(await readCapped(res, DRIVE_DOWNLOAD_MAX_BYTES));
    if (text === null) throw bad(res, 'not-json');
    try {
      return JSON.parse(text);
    } catch {
      throw bad(res, 'not-json');
    }
  };

  const readMeta = async (res: Response): Promise<DriveFileMeta> => {
    const meta = fileMetaFrom(await readJson(res));
    if (meta === null) throw bad(res, 'bad-shape');
    return meta;
  };

  const readText = async (res: Response): Promise<string> => {
    const text = utf8(await readCapped(res, DRIVE_DOWNLOAD_MAX_BYTES));
    // A NUL decodes as UTF-8 but no model text has one: it is a binary file.
    if (text === null || text.includes('\u0000')) throw bad(res, 'not-text');
    return text;
  };

  const filePath = (prefix: string, ref: DriveFileRef): string => `${prefix}/${encodeURIComponent(ref.id)}`;

  return {
    about: () =>
      send(
        {
          method: 'GET',
          path: '/drive/v3/about',
          params: { fields: 'user(emailAddress,displayName)' },
          timeoutMs,
        },
        async (res) => {
          const json = await readJson(res);
          if (!isRecord(json)) throw bad(res, 'bad-shape');
          const user = isRecord(json.user) ? json.user : {};
          return {
            email: typeof user.emailAddress === 'string' ? user.emailAddress : null,
            name: typeof user.displayName === 'string' ? user.displayName : null,
          };
        },
      ),

    get: async (ref) => {
      checkRef(ref);
      return send(
        {
          method: 'GET',
          path: filePath('/drive/v3/files', ref),
          params: { fields: DRIVE_FIELDS, supportsAllDrives: 'true' },
          ref,
          timeoutMs,
        },
        readMeta,
      );
    },

    download: async (ref) => {
      checkRef(ref);
      return send(
        {
          method: 'GET',
          path: filePath('/drive/v3/files', ref),
          params: { alt: 'media', supportsAllDrives: 'true' },
          ref,
          timeoutMs,
        },
        readText,
      );
    },

    create: async (name, text) => {
      checkUploadSize(text);
      const meta = { name, mimeType: 'text/plain' };
      const { body, contentType } = buildMultipart(meta, text, multipartBoundary(JSON.stringify(meta) + text));
      return send(
        {
          method: 'POST',
          path: '/upload/drive/v3/files',
          params: { uploadType: 'multipart', supportsAllDrives: 'true', fields: DRIVE_FIELDS },
          contentType,
          body,
          timeoutMs: uploadTimeoutMs,
        },
        readMeta,
      );
    },

    update: async (ref, text) => {
      checkRef(ref);
      checkUploadSize(text);
      return send(
        {
          method: 'PATCH',
          path: filePath('/upload/drive/v3/files', ref),
          params: { uploadType: 'media', supportsAllDrives: 'true', fields: DRIVE_FIELDS },
          ref,
          contentType: TEXT_TYPE,
          body: text,
          timeoutMs: uploadTimeoutMs,
        },
        readMeta,
      );
    },

    list: (limit) =>
      send(
        {
          method: 'GET',
          path: '/drive/v3/files',
          params: {
            q: 'trashed=false',
            orderBy: 'modifiedTime desc',
            pageSize: String(pageSize(limit)),
            fields: `files(${DRIVE_FIELDS})`,
          },
          timeoutMs,
        },
        async (res) => {
          const json = await readJson(res);
          if (!isRecord(json)) throw bad(res, 'bad-shape');
          if (json.files === undefined) return []; // nothing to list
          if (!Array.isArray(json.files)) throw bad(res, 'bad-shape');
          return json.files.map((file) => {
            const meta = fileMetaFrom(file);
            if (meta === null) throw bad(res, 'bad-shape');
            return meta;
          });
        },
      ),
  };
}

/** A gateway method, as {@link InMemoryDriveGateway} records it. */
export type DriveGatewayOp = keyof DriveGateway;

/** One call the in-memory gateway received — answered or refused. */
export interface DriveGatewayCall {
  op: DriveGatewayOp;
  /** The file id, for `get`/`download`/`update`. */
  id?: string;
  /** The key the reference carried: what the REST gateway sends as `X-Goog-Drive-Resource-Keys`. */
  resourceKey?: string;
  /** The name, for `create`. */
  name?: string;
  /** The uploaded text, for `create`/`update`. */
  text?: string;
}

interface StoredFile {
  meta: DriveFileMeta;
  text: string;
  /** Whether `drive.file` lets this app see it: created here, or picked. */
  granted: boolean;
  /** Whether a request must carry the file's resource key to reach it. */
  keyRequired: boolean;
  revision: number;
}

/**
 * A stand-in for the content hash Drive reports as `md5Checksum`: 128 bits
 * from four FNV-1a lanes. What the conflict check needs of it — that it moves
 * with the content and with nothing else — holds; it is not MD5.
 */
function contentHash(text: string): string {
  let out = '';
  for (const seed of [0x811c9dc5, 0x050c5d1f, 0x9e3779b9, 0x85ebca6b]) {
    let h = seed;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

/**
 * Google Drive in memory, for tests of everything above the gateway.
 *
 * It answers like the REST gateway under `drive.file`: a file is reachable
 * only once granted (created here, or {@link grant}ed as a pick would);
 * an unreachable or unknown one is a 404; an update without edit access is a
 * 403 `insufficientFilePermissions`; `list` returns the granted, untrashed
 * files, newest first. A file {@link seed}ed with `keyRequired` is a 404 too
 * when the reference lacks its resource key, as Drive answers for a
 * link-shared file under its resource-key rule — so a caller that drops the
 * key after opening such a file fails here as it would in production, not
 * only there. Each content write mints a new `version`,
 * `headRevisionId` and content hash; {@link touchMeta} moves `version` and
 * `modifiedTime` alone, as a rename or a share does in Drive. Failures are
 * built by {@link driveErrorFor}, so they are the classes the REST gateway
 * throws. Every call, refused or not, is appended to {@link calls}.
 *
 * `md5Checksum: false` / `headRevisionId: false` leave those markers out of
 * every file, for the fallbacks of the conflict check. `token`, when given, is
 * asked on every call, and its null is the REST gateway's `no-token` failure.
 */
export class InMemoryDriveGateway implements DriveGateway {
  /** Every call received, in order. */
  readonly calls: DriveGatewayCall[] = [];
  /** What `about` answers. */
  account: DriveAccount = { email: 'student@example.org', name: 'Student' };

  private readonly store = new Map<string, StoredFile>();
  private readonly failures: Array<{ op?: DriveGatewayOp; error: DriveError }> = [];
  private readonly now: () => number;
  private readonly token?: () => string | null;
  private readonly withMd5: boolean;
  private readonly withRevision: boolean;
  private lastTime = 0;
  private lastId = 0;

  constructor(
    opts: {
      token?: () => string | null;
      now?: () => number;
      md5Checksum?: boolean;
      headRevisionId?: boolean;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.token = opts.token;
    this.withMd5 = opts.md5Checksum ?? true;
    this.withRevision = opts.headRevisionId ?? true;
  }

  async about(): Promise<DriveAccount> {
    this.enter({ op: 'about' });
    return { ...this.account };
  }

  async get(ref: DriveFileRef): Promise<DriveFileMeta> {
    this.enter({ op: 'get', ...refCall(ref) }, ref);
    return { ...this.reachable(ref).meta };
  }

  async download(ref: DriveFileRef): Promise<string> {
    this.enter({ op: 'download', ...refCall(ref) }, ref);
    return this.reachable(ref).text;
  }

  async create(name: string, text: string): Promise<DriveFileMeta> {
    this.enter({ op: 'create', name, text });
    checkUploadSize(text);
    return { ...this.add({ name, text, granted: true }).meta };
  }

  async update(ref: DriveFileRef, text: string): Promise<DriveFileMeta> {
    this.enter({ op: 'update', ...refCall(ref), text }, ref);
    checkUploadSize(text);
    const file = this.reachable(ref);
    if (!file.meta.canEdit) throw driveErrorFor(403, 'insufficientFilePermissions');
    this.write(file, text, this.account.name ?? undefined);
    return { ...file.meta };
  }

  async list(limit: number): Promise<DriveFileMeta[]> {
    this.enter({ op: 'list' });
    return [...this.store.values()]
      .filter((f) => f.granted && !f.meta.trashed)
      .map((f) => ({ ...f.meta }))
      .sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : a.modifiedTime > b.modifiedTime ? -1 : 0))
      .slice(0, pageSize(limit));
  }

  /**
   * Put a file in this Drive — granted unless `granted: false` (a file shared
   * with the user that this app has not been given yet). `keyRequired: true`
   * (which needs a `resourceKey`) makes `get`, `download` and `update` answer
   * 404 unless the reference carries that key.
   */
  seed(file: {
    name: string;
    text: string;
    id?: string;
    mimeType?: string;
    resourceKey?: string;
    keyRequired?: boolean;
    canEdit?: boolean;
    granted?: boolean;
    by?: string;
  }): DriveFileMeta {
    return { ...this.add({ ...file, granted: file.granted ?? true }).meta };
  }

  /** Every file held, granted or not, trashed or not. */
  files(): DriveFileMeta[] {
    return [...this.store.values()].map((f) => ({ ...f.meta }));
  }

  /** The content of file `id`, or undefined. */
  textOf(id: string): string | undefined {
    return this.store.get(id)?.text;
  }

  /** Let this app see file `id` — what choosing it in the Picker does. */
  grant(id: string): void {
    this.file(id).granted = true;
  }

  /** Someone else saved new content: every marker moves. */
  bump(id: string, text?: string, by = 'A classmate'): DriveFileMeta {
    const file = this.file(id);
    this.write(file, text ?? `${file.text}// changed in Drive\n`, by);
    return { ...file.meta };
  }

  /** A rename or a share: `version` and `modifiedTime` move, the content markers do not. */
  touchMeta(id: string): DriveFileMeta {
    const file = this.file(id);
    file.meta.version = String(Number(file.meta.version) + 1);
    file.meta.modifiedTime = this.tick();
    return { ...file.meta };
  }

  /** The user keeps view access only. */
  setReadonly(id: string): void {
    this.file(id).meta.canEdit = false;
  }

  /** The file goes to the trash: still readable by id, no longer listed. */
  trash(id: string): void {
    const file = this.file(id);
    file.meta.trashed = true;
    file.meta.version = String(Number(file.meta.version) + 1);
  }

  /** The file is deleted: a 404 from now on. */
  remove(id: string): void {
    this.store.delete(id);
  }

  /**
   * Fail the next call (of `op`, when given) with `failure` — a status, read
   * as the REST gateway reads it (with `reason` as Drive's reason code), or a
   * ready-made error.
   */
  failNext(failure: number | DriveError, opts: { op?: DriveGatewayOp; reason?: string } = {}): void {
    const error = typeof failure === 'number' ? driveErrorFor(failure, opts.reason) : failure;
    this.failures.push({ op: opts.op, error });
  }

  /** Record a call, then refuse it the way the REST gateway would, if it would. */
  private enter(call: DriveGatewayCall, ref?: DriveFileRef): void {
    this.calls.push(call);
    if (ref) checkRef(ref);
    if (this.token && this.token() === null) {
      throw new DriveAuthError(driveErrorMessage(0, 'no-token'), 0, 'no-token');
    }
    const i = this.failures.findIndex((f) => f.op === undefined || f.op === call.op);
    if (i >= 0) throw this.failures.splice(i, 1)[0].error;
  }

  private reachable(ref: DriveFileRef): StoredFile {
    const file = this.store.get(ref.id);
    if (!file || !file.granted) throw driveErrorFor(404, 'notFound');
    if (file.keyRequired && ref.resourceKey !== file.meta.resourceKey) throw driveErrorFor(404, 'notFound');
    return file;
  }

  private file(id: string): StoredFile {
    const file = this.store.get(id);
    if (!file) throw new Error(`InMemoryDriveGateway: no file ${id}`);
    return file;
  }

  private add(file: {
    name: string;
    text: string;
    granted: boolean;
    id?: string;
    mimeType?: string;
    resourceKey?: string;
    keyRequired?: boolean;
    canEdit?: boolean;
    by?: string;
  }): StoredFile {
    const id = file.id ?? `mem${String(++this.lastId).padStart(9, '0')}`;
    if (!DRIVE_FILE_ID.test(id) || this.store.has(id)) throw new Error(`InMemoryDriveGateway: bad or taken id ${id}`);
    if (file.resourceKey !== undefined && !DRIVE_RESOURCE_KEY.test(file.resourceKey)) {
      throw new Error(`InMemoryDriveGateway: bad resource key ${file.resourceKey}`);
    }
    if (file.keyRequired && file.resourceKey === undefined) {
      throw new Error(`InMemoryDriveGateway: file ${id} requires a resource key it does not have`);
    }
    const by = file.by ?? this.account.name ?? undefined;
    const stored: StoredFile = {
      meta: {
        id,
        name: file.name,
        mimeType: file.mimeType ?? 'text/plain',
        version: '1',
        modifiedTime: this.tick(),
        ...(this.withRevision ? { headRevisionId: 'r1' } : {}),
        ...(this.withMd5 ? { md5Checksum: contentHash(file.text) } : {}),
        ...(file.resourceKey !== undefined ? { resourceKey: file.resourceKey } : {}),
        webViewLink: `${DRIVE_WEB_ORIGINS[0]}/file/d/${id}/view`,
        trashed: false,
        canEdit: file.canEdit ?? true,
        ...(by !== undefined ? { lastModifiedBy: by } : {}),
      },
      text: file.text,
      granted: file.granted,
      keyRequired: file.keyRequired ?? false,
      revision: 1,
    };
    this.store.set(id, stored);
    return stored;
  }

  /** New content: a new revision, version, hash and time. */
  private write(file: StoredFile, text: string, by: string | undefined): void {
    file.text = text;
    file.revision += 1;
    file.meta.version = String(Number(file.meta.version) + 1);
    file.meta.modifiedTime = this.tick();
    if (this.withRevision) file.meta.headRevisionId = `r${file.revision}`;
    if (this.withMd5) file.meta.md5Checksum = contentHash(text);
    if (by !== undefined) file.meta.lastModifiedBy = by;
    else delete file.meta.lastModifiedBy;
  }

  /** The clock as Drive's `modifiedTime`, strictly increasing so every write is ordered. */
  private tick(): string {
    this.lastTime = Math.max(this.now(), this.lastTime + 1);
    return new Date(this.lastTime).toISOString();
  }
}

/** The id and key of `ref`, as a {@link DriveGatewayCall} records them. */
function refCall(ref: DriveFileRef): Pick<DriveGatewayCall, 'id' | 'resourceKey'> {
  return ref.resourceKey !== undefined ? { id: ref.id, resourceKey: ref.resourceKey } : { id: ref.id };
}

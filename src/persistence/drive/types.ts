/**
 * Google Drive (optional) — the shapes the rest of the feature agrees on.
 *
 * The unit stored in Drive is a model's `.sysml` TEXT, keyed by Drive's file
 * id; nothing here touches the browser project store, which keeps its
 * name-keyed JSON snapshots. The feature is off unless the deployed site puts a
 * client ID in `drive.json` next to `index.html` (see `config.ts`).
 */
import { LINKED_MODEL_MAX_BYTES } from '../../ui/linked-model';

/**
 * What a deployment supplies in `drive.json`. All of it is public by design —
 * the client ID and the API key travel in every request to Google — and is made
 * acceptable by the restrictions set on Google's side, not by hiding it.
 */
export interface DriveConfig {
  /** OAuth 2.0 Web client ID (`…apps.googleusercontent.com`). */
  clientId: string;
  /** Picker API key; present exactly when `appId` is. */
  apiKey?: string;
  /** The Google Cloud project NUMBER the Picker grants access under. */
  appId?: string;
  /** The deployment's privacy page (https). */
  privacyUrl: string;
  /** Where users ask for help (https), when the deployment names one. */
  supportUrl?: string;
}

/**
 * A Drive file as a link or a pasted id names it. `resourceKey` is the extra
 * token some link-shared files need; it travels with the id wherever the id
 * goes, because without it Drive answers 404 for those files.
 */
export interface DriveFileRef {
  id: string;
  resourceKey?: string;
}

/** The metadata kept for a Drive file — the fields of {@link DRIVE_FIELDS}. */
export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  version: string;
  modifiedTime: string;
  headRevisionId?: string;
  /** The hash of the file's content: the conflict check's first marker. */
  md5Checksum?: string;
  resourceKey?: string;
  webViewLink?: string;
  trashed: boolean;
  canEdit: boolean;
  lastModifiedBy?: string;
}

/** A signed-in session as the UI may see it. The access token is never in it. */
export interface DriveSession {
  expiresAt: number;
}

/** The `fields` selector every metadata request asks Drive for. */
export const DRIVE_FIELDS =
  'id,name,mimeType,version,modifiedTime,headRevisionId,md5Checksum,resourceKey,webViewLink,trashed,capabilities(canEdit),lastModifyingUser(displayName)';

/**
 * The one OAuth scope this app asks for: files the user created with it or
 * chose in Google's picker, and nothing else in their Drive. This identifier
 * is the only URL spelled in this directory outside `hosts.ts` — it names a
 * permission and is never fetched.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Largest text one multipart upload may carry (Drive's simple-upload limit). */
export const DRIVE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Largest file a download may carry: the cap a `?model=` link already has. */
export const DRIVE_DOWNLOAD_MAX_BYTES = LINKED_MODEL_MAX_BYTES;

/**
 * Why a Drive request failed, as far as the app may say.
 *
 * `message` is built from `status` and `reason` alone (see
 * {@link driveErrorMessage}) — never from a response's headers or body — so
 * nothing a server or another user wrote, and nothing token-like, can reach a
 * notice or a log. `status` is the HTTP status, or 0 when no answer came
 * (offline, timed out, refused before sending, or a sign-in that did not
 * happen). `reason` is a short code: Drive's own error reason (an identifier
 * such as `insufficientFilePermissions`), or one of the feature's own — from
 * the gateway `network`, `timeout`, `no-token`, `bad-ref`, `too-large` (an
 * upload over {@link DRIVE_UPLOAD_MAX_BYTES}), `not-json`, `bad-shape`,
 * `not-text`, `too-large-download` (an answer over
 * {@link DRIVE_DOWNLOAD_MAX_BYTES}); from loading Google's scripts
 * (`loader.ts`, `picker.ts`) `script-refused`, `no-document`, `script-failed`,
 * `script-timeout` — the same codes whether the sign-in script or the
 * Picker's failed to load; from the Picker `bad-ref`, `picker-failed`; from
 * sign-in (`auth.ts`) `bad-token-response`, `signed-out` (a sign-in ended by
 * a sign-out: nothing went wrong) — or, for a sign-in, the code Google
 * Identity Services reported (`popup_closed`, `popup_failed_to_open`,
 * `access_denied`, …).
 *
 * `retryAfterMs` is the wait the server asked for, when it named one AND the
 * page could read it: `Retry-After` is not a CORS-safelisted response header,
 * so a cross-origin answer shows it only when the server lists it in
 * `Access-Control-Expose-Headers`. Its absence therefore says nothing about
 * the server, and no wording may depend on it.
 */
export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

/** 401, or no usable token: sign-in is needed (again). GIS failures carry status 0 and their code. */
export class DriveAuthError extends DriveError {
  override name = 'DriveAuthError';
}
/**
 * 403 for any reason but a rate limit. Typically view-only access
 * (`insufficientFilePermissions`), but the same status also means a full Drive
 * (`storageQuotaExceeded`), a used-up daily quota (`dailyLimitExceeded`) or an
 * organisation's policy — so only the `reason` says whether the user lacks
 * edit access.
 */
export class DriveForbiddenError extends DriveError {
  override name = 'DriveForbiddenError';
}
/** 429, or a 403 whose reason is a `…RateLimitExceeded`. */
export class DriveRateLimitError extends DriveError {
  override name = 'DriveRateLimitError';
}
/** 404: no such file, or one this app has not been granted (`drive.file`). */
export class DriveNotFoundError extends DriveError {
  override name = 'DriveNotFoundError';
}
/** No answer: the request failed to leave or to come back, or timed out (status 0). */
export class DriveNetworkError extends DriveError {
  override name = 'DriveNetworkError';
}
/**
 * An answer the app cannot use, with the answer's own (2xx) status and one of
 * four reasons: `not-json` (metadata that is not JSON), `bad-shape` (JSON that
 * is not what was asked for), `not-text` (a download that is not UTF-8 text) or
 * `too-large-download` (an answer over {@link DRIVE_DOWNLOAD_MAX_BYTES}). An
 * upload refused for its size is not one of these: it is a plain
 * {@link DriveError} with status 0 and reason `too-large`, decided before
 * anything was sent.
 */
export class DriveBadResponseError extends DriveError {
  override name = 'DriveBadResponseError';
}

/**
 * What a reason code may look like: a word of letters, digits, `_` and `-`.
 * Drive's own reasons (`userRateLimitExceeded`), this module's (`not-text`)
 * and GIS's (`popup_closed`) all are; free text is not.
 */
export const DRIVE_REASON = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * The one way a {@link DriveError} message is worded: the status and the reason
 * code, nothing else. A reason that is not a plain code is left out.
 */
export function driveErrorMessage(status: number, reason?: string): string {
  const code = reason !== undefined && DRIVE_REASON.test(reason) ? reason : undefined;
  if (status === 0) return `Google Drive request failed${code ? ` (${code})` : ''}`;
  return `Google Drive answered HTTP ${status}${code ? ` (${code})` : ''}`;
}

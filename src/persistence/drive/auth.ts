/**
 * Google Drive (optional) — signing in: the one boundary the rest of the app
 * talks to, and Google Identity Services' popup flow behind it.
 *
 * {@link DriveAuth} is all the store knows of sign-in. {@link createGisPopupAuth}
 * implements it with GIS's token model in a popup: no redirect, no client
 * secret, no refresh token. A redirect flow would implement the same four
 * methods, and nothing outside this file would know which is in use.
 *
 * The access token lives in a closure here and nowhere else — not in the
 * store, not on `window.sysprose`, not in a URL, a log or any browser storage.
 * {@link DriveAuth.token} hands it out for one request at a time, and stops a
 * minute ({@link DRIVE_TOKEN_MARGIN_MS}) before it expires, so no request
 * leaves with a token that runs out on the way. (GIS also copies every token
 * into `gapi.client` when that library is on the page; this feature asks gapi
 * for its `picker` module only, never for `client`.)
 *
 * A browser lets a page open a popup only inside the user's click. So once
 * {@link DriveAuth.ready} has resolved, {@link DriveAuth.signIn} calls GIS
 * without awaiting anything first, and the UI keeps its sign-in buttons
 * disabled until it has: fetching the script inside the click could outlast
 * the click's permission to open a window.
 */
import { DRIVE_REVOKE_URL, DRIVE_SCRIPTS } from './hosts';
import { loadScriptOnce, type ScriptLoader } from './loader';
import {
  DRIVE_REASON,
  DRIVE_SCOPE,
  DriveAuthError,
  DriveError,
  driveErrorMessage,
  type DriveSession,
} from './types';

/**
 * What GIS's popup shows: the account chooser (`select_account`), the consent
 * screen again (`consent`), or only what Google needs to ask (`''` — after the
 * first consent, a brief window that closes by itself).
 */
export type DriveSignInPrompt = 'select_account' | 'consent' | '';

/** Signing in to Google for Drive — the boundary behind which the flow can change. */
export interface DriveAuth {
  /**
   * Ask Google for a token: a popup. Call it synchronously inside a user
   * gesture once {@link ready} has resolved; `hint` (an email address) skips
   * the account chooser. Rejects with a {@link DriveAuthError} whose reason is
   * GIS's code (`popup_closed`, `popup_failed_to_open`, `access_denied`, …),
   * or with the script load's {@link DriveError} when GIS could not be loaded.
   * The token itself never leaves the implementation.
   */
  signIn(opts: { prompt: DriveSignInPrompt; hint?: string }): Promise<DriveSession>;
  /** The bearer for one request, or null when there is none or it expires within {@link DRIVE_TOKEN_MARGIN_MS}. */
  token(): string | null;
  /**
   * Revoke the current token at Google and forget everything. A token that
   * {@link token} would not hand out counts as none: it is forgotten without a
   * revocation, which needs a token Google still accepts. Resolves with whether
   * there was a token to revoke and whether Google confirmed the revocation —
   * `revoked` is true only on Google's own success answer; offline, refused,
   * timed out or unreadable all read as not confirmed. Never rejects.
   *
   * Every sign-in still in progress is ended (`signed-out`), including one
   * that is waiting for its popup. So a caller that signs in again first, to
   * have a token to revoke, awaits that sign-in before calling this — calling
   * it while the popup is open ends the very sign-in it was waiting for.
   */
  signOut(): Promise<{ revoked: boolean; hadToken: boolean }>;
  /**
   * Resolve once the vendor script is loaded and usable, starting the load if
   * needed. Called when the Drive panel opens or a `?drive=` link is pending;
   * after a failure, the next call tries again.
   */
  ready(): Promise<void>;
}

/** How long before its expiry a token stops being handed out. */
export const DRIVE_TOKEN_MARGIN_MS = 60_000;
/** How long sign-out waits for Google to answer a revocation before calling it unconfirmed (and abandoning it). */
export const DRIVE_REVOKE_TIMEOUT_MS = 10_000;

/** What GIS hands the token callback: a token, or an OAuth error code. */
export interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
}

/**
 * The `google` namespace as far as sign-in uses it: `google.accounts.oauth2`.
 * Not its `revoke`: that one calls an answer it could not read a success
 * (sign-out makes the same request itself, see {@link createGisPopupAuth}).
 */
export interface GoogleNs {
  accounts?: {
    oauth2?: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: GisTokenResponse) => void;
        error_callback: (error: { type?: string }) => void;
      }): { requestAccessToken(overrides: { prompt: DriveSignInPrompt; login_hint?: string }): void };
      hasGrantedAllScopes(response: GisTokenResponse, scope: string, ...more: string[]): boolean;
    };
  };
}

type GisOAuth2 = NonNullable<NonNullable<GoogleNs['accounts']>['oauth2']>;
type GisTokenClient = ReturnType<GisOAuth2['initTokenClient']>;

/** A sign-in that did not produce a token; a reason that is not a plain code reads `unknown`. */
function authError(reason: string): DriveAuthError {
  const code = DRIVE_REASON.test(reason) ? reason : 'unknown';
  return new DriveAuthError(driveErrorMessage(0, code), 0, code);
}

/** The code of an error GIS threw or reported (its `type`), or `unknown`. */
function gisCode(error: unknown): string {
  const type = typeof error === 'object' && error !== null ? (error as { type?: unknown }).type : undefined;
  return typeof type === 'string' ? type : 'unknown';
}

/** GIS did not load, or loaded without what sign-in needs. */
function gisMissing(): DriveError {
  return new DriveError(driveErrorMessage(0, 'script-failed'), 0, 'script-failed');
}

/** A token is handed out until {@link DRIVE_TOKEN_MARGIN_MS} before it expires. */
function usable(held: { token: string; expiresAt: number } | null, now: number): string | null {
  return held !== null && now < held.expiresAt - DRIVE_TOKEN_MARGIN_MS ? held.token : null;
}

/**
 * Sign-in through GIS's token model in a popup, for the OAuth web client
 * `clientId`, asking for {@link DRIVE_SCOPE} alone.
 *
 * `load` replaces the script loader, `google` the lookup of the page's
 * `google` namespace, `now` the clock and `fetchImpl` the `fetch` sign-out
 * revokes with — all four for tests.
 *
 * A token answer is accepted only when the user granted the Drive scope:
 * granular consent lets a user untick it and still press Allow, which reads
 * here as `access_denied`. Two sign-ins started before Google answers share
 * that answer (the second opens its own popup, so a click always gets a
 * window, even if an earlier one never reported back). A token that answers
 * after its sign-in was already told no — GIS checks every half second whether
 * the popup closed, and can report `popup_closed` just before the token of a
 * consent completed at that moment arrives — is kept, so the next action finds
 * a token without another popup; one that answers after a sign-out is not.
 *
 * Sign-out revokes by POSTing the token, in a form body, to
 * {@link DRIVE_REVOKE_URL} — the request `google.accounts.oauth2.revoke`
 * makes — rather than through that helper, because the helper reports
 * success whenever it could not read an answer: offline, refused by the
 * page's CSP, or cut off in transit. Here only a 2xx from Google counts as
 * revoked, and an answer the page may not read (no CORS header) does not.
 * (A stand-in for Google in tests answers that POST and finds the token in
 * its form body; GIS's `revoke` is never called.)
 */
export function createGisPopupAuth(
  clientId: string,
  deps: {
    load?: ScriptLoader;
    google?: () => GoogleNs | undefined;
    now?: () => number;
    fetchImpl?: typeof fetch;
  } = {},
): DriveAuth {
  const load = deps.load ?? loadScriptOnce;
  const google = deps.google ?? (() => (globalThis as { google?: GoogleNs }).google);
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetchImpl ?? fetch;

  let oauth2: GisOAuth2 | null = null;
  let client: GisTokenClient | null = null;
  let loading: Promise<void> | null = null;
  let held: { token: string; expiresAt: number } | null = null;
  const waiting: Array<{ resolve: (session: DriveSession) => void; reject: (error: DriveError) => void }> = [];
  // Sign-outs so far, and how many there had been at the latest token request:
  // an answer to a request made before the latest sign-out is not kept.
  let signOuts = 0;
  let requestedAt = -1;

  const settleAll = (outcome: DriveSession | DriveError): void => {
    for (const waiter of waiting.splice(0)) {
      if (outcome instanceof DriveError) waiter.reject(outcome);
      else waiter.resolve({ ...outcome });
    }
  };

  /** Read a token answer: keep the token and return the session, or say why not. */
  const accept = (api: GisOAuth2, response: GisTokenResponse): DriveSession | DriveError => {
    if (typeof response !== 'object' || response === null) return authError('bad-token-response');
    if (typeof response.error === 'string' && response.error !== '') return authError(response.error);
    let granted = false;
    try {
      granted = api.hasGrantedAllScopes(response, DRIVE_SCOPE) === true;
    } catch {
      granted = false;
    }
    if (!granted) return authError('access_denied');
    const token = response.access_token;
    const seconds = Number(response.expires_in);
    if (typeof token !== 'string' || token === '' || !Number.isFinite(seconds) || seconds <= 0) {
      return authError('bad-token-response');
    }
    held = { token, expiresAt: now() + seconds * 1000 };
    return { expiresAt: held.expiresAt };
  };

  const onToken = (response: GisTokenResponse): void => {
    // Nothing asked for since the latest sign-out: not kept.
    if (oauth2 === null || requestedAt !== signOuts) return;
    settleAll(accept(oauth2, response));
  };

  const onError = (error: { type?: string }): void => {
    settleAll(authError(gisCode(error)));
  };

  /** `google.accounts.oauth2`, once GIS has defined it. */
  const gis = (): GisOAuth2 | undefined => {
    const api = google()?.accounts?.oauth2;
    return api && typeof api.initTokenClient === 'function' ? api : undefined;
  };

  const ready = (): Promise<void> => {
    if (client !== null) return Promise.resolve();
    // Already on the page (a load that outlasted its time limit ran after
    // all): used as it is, not fetched a second time.
    loading ??= (gis() ? Promise.resolve() : load(DRIVE_SCRIPTS.gis, () => gis() !== undefined))
      .then(() => {
        const api = gis();
        if (!api) throw gisMissing();
        client = api.initTokenClient({
          client_id: clientId,
          scope: DRIVE_SCOPE,
          callback: onToken,
          error_callback: onError,
        });
        oauth2 = api;
      })
      .catch((error: unknown) => {
        // Forgotten, so the next call (the panel opened again) retries.
        loading = null;
        throw error instanceof DriveError ? error : gisMissing();
      });
    return loading;
  };

  /**
   * Open the popup now — no `await` before `requestAccessToken`. The waiter is
   * in place first: when the browser refuses the window, GIS reports
   * `popup_failed_to_open` from inside `requestAccessToken`, synchronously.
   */
  const request = (tokenClient: GisTokenClient, opts: { prompt: DriveSignInPrompt; hint?: string }) =>
    new Promise<DriveSession>((resolve, reject) => {
      const waiter = { resolve, reject };
      waiting.push(waiter);
      requestedAt = signOuts;
      try {
        tokenClient.requestAccessToken({
          prompt: opts.prompt,
          ...(opts.hint ? { login_hint: opts.hint } : {}),
        });
      } catch (error) {
        const at = waiting.indexOf(waiter);
        if (at >= 0) waiting.splice(at, 1);
        reject(authError(gisCode(error)));
      }
    });

  /** POST the token to Google's revocation endpoint: true only on Google's 2xx. */
  const revoke = async (token: string): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DRIVE_REVOKE_TIMEOUT_MS);
    try {
      const res = await doFetch(DRIVE_REVOKE_URL, {
        method: 'POST',
        // A form body (CORS-safelisted, so no preflight) — never the URL.
        body: new URLSearchParams({ token }),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
      return res.ok;
    } catch {
      // Offline, refused by the CSP, an answer the page may not read, or the
      // time limit: Google's answer, if any, is unknown.
      return false;
    } finally {
      clearTimeout(timer);
      // The answer's body is not needed: let the request go.
      controller.abort();
    }
  };

  return {
    signIn: (opts) => {
      if (client !== null) return request(client, opts);
      const signOutsBefore = signOuts;
      return ready().then(() => {
        if (client === null) throw gisMissing();
        // Signed out while the script loaded: no popup for a sign-in already ended.
        if (signOuts !== signOutsBefore) throw authError('signed-out');
        return request(client, opts);
      });
    },

    token: () => usable(held, now()),

    signOut: async () => {
      signOuts++;
      settleAll(authError('signed-out'));
      const current = usable(held, now());
      held = null;
      if (current === null) return { revoked: false, hadToken: false };
      return { revoked: await revoke(current), hadToken: true };
    },

    ready,
  };
}

/** One call {@link FakeDriveAuth} received, recorded at the moment it was made. */
export type FakeDriveAuthCall =
  | { op: 'ready' }
  | { op: 'signIn'; prompt: DriveSignInPrompt; hint?: string }
  | { op: 'signOut' }
  | { op: 'revoke'; token: string };

/**
 * A {@link DriveAuth} for tests of everything above it, with Google left out
 * and the contract of {@link createGisPopupAuth} kept: tokens
 * (`fake-token-1`, `fake-token-2`, …) live `expiresIn` seconds and are handed
 * out until {@link DRIVE_TOKEN_MARGIN_MS} before that; sign-out revokes only a
 * token that is still handed out; the token is held where `JSON.stringify`
 * cannot see it, as the closure holds the real one.
 *
 * Every call is appended to {@link calls} synchronously, at the call — so a
 * test can tell a sign-in that opened inside the click from one that waited
 * for something first — and a revocation is recorded as its own `revoke`
 * entry. {@link failNextSignIn} queues GIS codes for the next sign-ins;
 * {@link expire} runs the current token out; `revokeOk` is what Google's
 * revocation answer reports. Constructed with `loaded: false`, the script
 * "loads" only when {@link finishLoading} says so, and a sign-in before then
 * waits for it, as the real one does — and, as the real one does, ends with
 * `signed-out` and issues no token when a sign-out came while it waited.
 */
export class FakeDriveAuth implements DriveAuth {
  /** Every call, in order. */
  readonly calls: FakeDriveAuthCall[] = [];
  /** Whether Google confirms the next revocation. */
  revokeOk = true;
  /** How long the next tokens live, in seconds (GIS's `expires_in`). */
  expiresIn = 3600;

  private readonly now: () => number;
  private loaded: boolean;
  private load: { promise: Promise<void>; resolve: () => void; reject: (error: DriveError) => void } | null =
    null;
  private readonly failures: string[] = [];
  private issued = 0;
  private signOuts = 0;
  // An ES private field, not a TypeScript one: kept out of JSON.stringify and
  // Object.keys, as the real token is.
  #held: { token: string; expiresAt: number } | null = null;

  constructor(opts: { now?: () => number; loaded?: boolean } = {}) {
    this.now = opts.now ?? Date.now;
    this.loaded = opts.loaded ?? true;
  }

  ready(): Promise<void> {
    this.calls.push({ op: 'ready' });
    return this.whenLoaded();
  }

  async signIn(opts: { prompt: DriveSignInPrompt; hint?: string }): Promise<DriveSession> {
    this.calls.push({ op: 'signIn', prompt: opts.prompt, ...(opts.hint !== undefined ? { hint: opts.hint } : {}) });
    if (!this.loaded) {
      const signOutsBefore = this.signOuts;
      await this.whenLoaded();
      if (this.signOuts !== signOutsBefore) throw authError('signed-out');
    }
    const failure = this.failures.shift();
    if (failure !== undefined) throw authError(failure);
    const token = `fake-token-${++this.issued}`;
    this.#held = { token, expiresAt: this.now() + this.expiresIn * 1000 };
    return { expiresAt: this.#held.expiresAt };
  }

  token(): string | null {
    return usable(this.#held, this.now());
  }

  async signOut(): Promise<{ revoked: boolean; hadToken: boolean }> {
    this.calls.push({ op: 'signOut' });
    this.signOuts++;
    const current = this.token();
    this.#held = null;
    if (current === null) return { revoked: false, hadToken: false };
    this.calls.push({ op: 'revoke', token: current });
    return { revoked: this.revokeOk, hadToken: true };
  }

  /** Fail the next sign-ins, one per code, with GIS's codes (`popup_closed`, `access_denied`, …). */
  failNextSignIn(...codes: string[]): void {
    this.failures.push(...codes);
  }

  /** The current token runs out now: {@link token} is null until the next sign-in. */
  expire(): void {
    if (this.#held) this.#held = { ...this.#held, expiresAt: this.now() };
  }

  /**
   * End the script load in flight: it succeeds, or fails with `error` (the
   * load is then forgotten, and the next {@link ready} starts another).
   * After a success every later {@link ready} resolves at once.
   */
  finishLoading(error?: DriveError): void {
    const load = this.load;
    this.load = null;
    if (error === undefined) this.loaded = true;
    if (load === null) return;
    if (error === undefined) load.resolve();
    else load.reject(error);
  }

  private whenLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.load === null) {
      let resolve!: () => void;
      let reject!: (error: DriveError) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.load = { promise, resolve, reject };
    }
    return this.load.promise;
  }
}

/**
 * The deployment's Google Drive configuration: `drive.json`, next to
 * `index.html`.
 *
 * The feature flag is "the deployed site put a `clientId` in that file" —
 * never Sysprose source. The build ships a placeholder that names no client
 * (`public/drive.json`, a lone `$comment`), so a deployment that does nothing
 * has the feature off, and its offline cache has an answer.
 *
 * "No config" is any of: a non-2xx answer; a 2xx that is not JSON by its
 * content-type; a body that does not parse; a value {@link parseDriveConfig}
 * refuses; an object with no `clientId`. The content-type rule is not
 * pedantry: `vite preview` (its SPA fallback) answers a MISSING `drive.json`
 * with `index.html` and status 200, so a status check alone would read an HTML
 * page as a configuration.
 */
import type { DriveConfig } from './types';

/** An OAuth 2.0 Web application client ID. */
const CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;
/** A Google API key (used by the Picker only). */
const API_KEY = /^AIza[0-9A-Za-z_-]{35}$/;
/** A Google Cloud project NUMBER (the Picker's app id). */
const APP_ID = /^[0-9]{6,}$/;

/** How long the boot waits for `drive.json` before treating it as absent. */
export const DRIVE_CONFIG_TIMEOUT_MS = 5_000;

/** `value` as an absolute https URL, or null. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Read a parsed `drive.json`. An object without a `clientId` — the shipped
 * placeholder, or `{}` — is "off" and says nothing; anything else that is not a
 * usable configuration is "off" with one `console.warn` naming why, so a
 * deployer who mistyped a field finds out from the console rather than from a
 * missing button. Unknown keys (including `$comment`) are ignored.
 */
export function parseDriveConfig(value: unknown): DriveConfig | null {
  const invalid = (reason: string): null => {
    console.warn(`drive.json is present but invalid (${reason}); Google Drive is disabled.`);
    return null;
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('not a JSON object');
  }
  const o = value as Record<string, unknown>;
  if (o.clientId === undefined) return null;
  if (typeof o.clientId !== 'string' || !CLIENT_ID.test(o.clientId)) {
    return invalid('clientId is not an OAuth web client ID');
  }
  const privacyUrl = httpsUrl(o.privacyUrl);
  if (privacyUrl === null) return invalid('privacyUrl must be an https URL');
  // The Picker needs both; one without the other is a half-done deployment,
  // not a Picker-less one.
  if ((o.apiKey === undefined) !== (o.appId === undefined)) {
    return invalid('apiKey and appId must be given together');
  }
  if (o.apiKey !== undefined && (typeof o.apiKey !== 'string' || !API_KEY.test(o.apiKey))) {
    return invalid('apiKey is not a Google API key');
  }
  if (o.appId !== undefined && (typeof o.appId !== 'string' || !APP_ID.test(o.appId))) {
    return invalid('appId is not a Google Cloud project number');
  }
  let supportUrl: string | null = null;
  if (o.supportUrl !== undefined) {
    supportUrl = httpsUrl(o.supportUrl);
    if (supportUrl === null) return invalid('supportUrl must be an https URL');
  }
  return {
    clientId: o.clientId,
    privacyUrl,
    ...(typeof o.apiKey === 'string' && typeof o.appId === 'string'
      ? { apiKey: o.apiKey, appId: o.appId }
      : {}),
    ...(supportUrl !== null ? { supportUrl } : {}),
  };
}

/**
 * Fetch `./drive.json` relative to `baseHref` (the page) and read it.
 * Resolves null for every "no config" case above, a network failure and a
 * timeout; it never rejects, because a missing Drive must never stop the app.
 */
export async function loadDriveConfig(
  baseHref: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DriveConfig | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  let url: URL;
  try {
    url = new URL('./drive.json', baseHref);
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DRIVE_CONFIG_TIMEOUT_MS);
  try {
    let text: string;
    try {
      // `no-cache` revalidates, so a rotated client ID is picked up on the
      // next online visit even behind a long max-age.
      const res = await doFetch(url.href, { signal: controller.signal, cache: 'no-cache' });
      if (!res.ok) return null;
      if (!/json/i.test(res.headers.get('content-type') ?? '')) return null;
      text = await res.text();
    } catch {
      return null; // offline, blocked or timed out: the feature stays off
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      console.warn('drive.json is present but invalid (not JSON); Google Drive is disabled.');
      return null;
    }
    return parseDriveConfig(value);
  } finally {
    clearTimeout(timer);
  }
}

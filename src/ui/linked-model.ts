/**
 * Open a model named in the page URL: `?model=<url>` (and optionally
 * `?source=<url>`, where changes to that model are proposed).
 *
 * This is how a project publishes a one-link view of its model — for example
 * `…/app/?model=model/Swarm.sysml&source=https://github.com/o/r/tree/main/…`.
 * A relative `model` is resolved against the page, so a model deployed next to
 * the app is a same-origin fetch and needs no CSP change. An absolute URL must
 * be http(s), and its origin must be allowed by the `connect-src` directive in
 * `index.html` (which admits `https://raw.githubusercontent.com` for exactly
 * this; the Google hosts beside it are there for the Drive feature, and a URL
 * on one of them is fetched too, as nothing here sorts hosts by purpose; any
 * other host needs a CSP edit there, not here).
 *
 * The linked model is never persisted: every visit fetches it afresh, so the
 * link always shows what upstream holds. Edits live in the session until the
 * user saves the project or exports the text — or, when the deployment enables
 * it, saves it to the user's own Google Drive (`src/persistence/drive/`) —
 * and changes go back to the source by whatever process the source repository
 * uses, never from here.
 */

/** What the page URL asks for. Both null when there is no `?model=`. */
export interface LinkedModelParams {
  /** The raw `model` parameter — a URL or a path relative to the page. */
  model: string | null;
  /** The raw `source` parameter — where changes to the model are proposed. */
  source: string | null;
}

/** The model the session was opened from, kept in the store for the banner. */
export interface LinkedModel {
  /** Absolute URL the model text was fetched from. */
  url: string;
  /** Absolute http(s) URL where changes are proposed, or null when not given. */
  source: string | null;
}

/** Largest model text accepted (bytes of UTF-16 text length, roughly). */
export const LINKED_MODEL_MAX_BYTES = 20 * 1024 * 1024;
/** How long the fetch may take before it is abandoned. */
export const LINKED_MODEL_TIMEOUT_MS = 30_000;

/** Read `model=` and `source=` from a query string (defaults to the page's). */
export function linkedModelFromUrl(search?: string): LinkedModelParams {
  let model: string | null = null;
  let source: string | null = null;
  try {
    const query =
      search ?? (typeof window !== 'undefined' && window.location ? window.location.search : '');
    const params = new URLSearchParams(query);
    model = params.get('model') || null;
    source = params.get('source') || null;
  } catch {
    /* non-browser / opaque location — nothing linked */
  }
  return { model, source };
}

/**
 * Resolve a `model=`/`source=` value against the page URL. Only http(s)
 * results are accepted: `javascript:`, `data:`, `file:` and friends return
 * null, so a crafted link can neither run script from the banner's anchor nor
 * read local files.
 */
export function resolveHttpUrl(param: string, base: string): URL | null {
  let url: URL;
  try {
    url = new URL(param, base);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/**
 * Fetch the model text. Rejects on a non-2xx status, a body over `maxBytes`
 * (checked against Content-Length first, then the text itself), or a fetch
 * that takes longer than `timeoutMs`.
 */
export async function fetchLinkedModel(
  url: URL,
  opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? LINKED_MODEL_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? LINKED_MODEL_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      // `no-cache` revalidates with the server, so a republished model is
      // picked up on the next visit even when the host sends long max-ages.
      res = await doFetch(url.href, { signal: controller.signal, cache: 'no-cache' });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`timed out after ${timeoutMs / 1000} s`);
      throw new Error(`network error (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(declared, maxBytes);
    const text = await res.text();
    if (text.length > maxBytes) throw tooLarge(text.length, maxBytes);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function tooLarge(size: number, max: number): Error {
  const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
  return new Error(`model is ${mb(size)} MB, over the ${mb(max)} MB limit`);
}

/** The last path segment of a URL, for naming the model in the banner. */
export function modelFileName(url: string): string {
  try {
    const { pathname } = new URL(url);
    const last = pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : url;
  } catch {
    return url;
  }
}

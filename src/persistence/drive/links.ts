/**
 * Drive file references from links and pasted text, and the deep link back.
 *
 * A file id goes into a request PATH and a resource key into a request HEADER,
 * so both are held to Drive's own alphabet (letters, digits, `-`, `_`) before
 * they go anywhere. Anything else is refused rather than repaired: a link that
 * smuggles `../` or a header break never becomes a reference.
 *
 * The deep link is `?drive=<id>` on the app's own page, plus
 * `&resourcekey=<key>` for a file that needs one (some link-shared files: Drive
 * answers 404 for them unless the key comes along). It wins over `?model=` at
 * boot — the more specific intent (see `src/ui/store.ts`).
 */
import { DRIVE_WEB_ORIGINS } from './hosts';
import type { DriveFileRef } from './types';

/** A Drive file id, as it may enter a URL path. */
export const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,128}$/;
/** A Drive resource key, as it may enter a request header. */
export const DRIVE_RESOURCE_KEY = /^[A-Za-z0-9_-]{5,128}$/;

/** A reference when `id` is well formed; a malformed key is dropped, not fatal. */
function refOf(id: string | null, key: string | null): DriveFileRef | null {
  if (id === null || !DRIVE_FILE_ID.test(id)) return null;
  return key !== null && DRIVE_RESOURCE_KEY.test(key) ? { id, resourceKey: key } : { id };
}

/** Read `drive=` (and `resourcekey=`) from a query string (defaults to the page's). */
export function driveLinkFromUrl(search?: string): DriveFileRef | null {
  try {
    const query =
      search ?? (typeof window !== 'undefined' && window.location ? window.location.search : '');
    const params = new URLSearchParams(query);
    return refOf(params.get('drive'), params.get('resourcekey'));
  } catch {
    return null; // non-browser / opaque location — nothing linked
  }
}

/**
 * Read what a user pasted: a bare file id; a Drive share link
 * (`drive.google.com/file/d/<id>/…` or `drive.google.com/open?id=<id>`, over
 * https); or this app's own deep link (any http(s) URL carrying `?drive=<id>`).
 * A `resourcekey=` on any of the three is kept. Nothing else is accepted.
 */
export function parseDriveFileRef(input: string): DriveFileRef | null {
  const text = input.trim();
  if (DRIVE_FILE_ID.test(text)) return { id: text };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const key = url.searchParams.get('resourcekey');
  if (url.origin === DRIVE_WEB_ORIGINS[0]) {
    const file = /^\/file\/d\/([^/]+)(?:\/.*)?$/.exec(url.pathname);
    if (file) return refOf(file[1], key);
    if (url.pathname === '/open') return refOf(url.searchParams.get('id'), key);
    return null;
  }
  if ((url.protocol === 'https:' || url.protocol === 'http:') && url.searchParams.has('drive')) {
    return refOf(url.searchParams.get('drive'), key);
  }
  return null;
}

/**
 * The deep link that reopens `ref` in this app: the page's origin and path,
 * `?drive=<id>`, and `&resourcekey=<key>` only when the reference has one.
 * Every other parameter (a `?model=`, a `?room=`) and the hash are dropped —
 * the link names the file and nothing else.
 */
export function driveDeepLink(ref: DriveFileRef, pageHref: string): string {
  const url = new URL(pageHref);
  url.search = '';
  url.hash = '';
  url.searchParams.set('drive', ref.id);
  if (ref.resourceKey) url.searchParams.set('resourcekey', ref.resourceKey);
  return url.href;
}

/**
 * A file's "Open in Drive" link, when it is one: an https page on one of
 * Drive's own origins, as Drive's metadata reports it in `webViewLink`. The
 * app opens it in a new tab, so nothing else — another host, another scheme,
 * a string that is no URL — is ever rendered as a link.
 */
export function driveWebViewLink(link: string | undefined): string | null {
  if (link === undefined) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  return (DRIVE_WEB_ORIGINS as readonly string[]).includes(url.origin) ? url.href : null;
}

/**
 * Google's scripts, loaded at runtime — never bundled, and never fetched
 * before the user opens Drive ▾ or follows a `?drive=` link on a configured
 * site (the callers decide when; importing this module fetches nothing).
 *
 * {@link loadScriptOnce} adds a `<script>` for one of {@link DRIVE_SCRIPTS}
 * and for nothing else: any other URL is refused before an element is made,
 * so no caller and no configuration value can turn it into a way to run
 * someone else's code. The URL is compared as written — no normalising, so
 * no spelling of a different URL can pass for an allowed one.
 *
 * A URL is loaded once per page: every caller, at the same time or later,
 * shares the one load. A load counts only when the script defined what it is
 * loaded for: the caller passes that check (`usable`), asked at the `load`
 * event, because a script answered with status 200 can still be an empty
 * stand-in (a content blocker's no-op, a filtering proxy's page). A load that
 * fails — the `error` event, a script that is not usable, or no `load` within
 * {@link DRIVE_SCRIPT_TIMEOUT_MS} — removes its element and is forgotten, so
 * the next call (the user reopening Drive ▾) fetches again rather than repeat
 * the failure. Failures are {@link DriveError}s with status 0 and a reason:
 * `script-refused`, `no-document`, `script-failed` or `script-timeout`.
 *
 * Removing the element does not stop a fetch already under way: a script that
 * arrives after its time limit still runs. So the callers (`auth.ts`,
 * `picker.ts`) look for what the script defines before asking for it again,
 * and use a late arrival rather than load a second copy.
 *
 * No `integrity` attribute: Google changes these scripts in place, so a pinned
 * hash would break sign-in on its next release.
 */
import { DRIVE_SCRIPTS } from './hosts';
import { DriveError, driveErrorMessage } from './types';

/** How long a script may take to load before the load has failed. */
export const DRIVE_SCRIPT_TIMEOUT_MS = 15_000;

/** The URLs {@link loadScriptOnce} accepts: exactly the two of {@link DRIVE_SCRIPTS}. */
const ALLOWED: readonly string[] = Object.values(DRIVE_SCRIPTS);

/** A load that did not happen (status 0). */
function scriptError(reason: string): DriveError {
  return new DriveError(driveErrorMessage(0, reason), 0, reason);
}

/** The page's `document`, when there is one (there is none under Node). */
function pageDocument(): Document | undefined {
  return typeof document !== 'undefined' && document !== null ? document : undefined;
}

/**
 * Load `url` — one of {@link DRIVE_SCRIPTS} — and resolve once it has run and
 * `usable` (when given) says it defined what it is loaded for. A load already
 * in flight is shared, with the check its first caller gave.
 */
export type ScriptLoader = (url: string, usable?: () => boolean) => Promise<void>;

/**
 * A script loader with its own once-per-URL memory. The app uses the one
 * instance, {@link loadScriptOnce}; tests make their own, with a detached
 * `document` (which never fetches) and a time limit of their choosing.
 */
export function createScriptLoader(
  opts: { document?: () => Document | undefined; timeoutMs?: number } = {},
): ScriptLoader {
  const getDocument = opts.document ?? pageDocument;
  const timeoutMs = opts.timeoutMs ?? DRIVE_SCRIPT_TIMEOUT_MS;
  const loads = new Map<string, Promise<void>>();

  /** Whether the script defined what it was loaded for; a check that throws says no. */
  const defined = (usable: (() => boolean) | undefined): boolean => {
    if (usable === undefined) return true;
    try {
      return usable() === true;
    } catch {
      return false;
    }
  };

  return (url, usable) => {
    if (!ALLOWED.includes(url)) return Promise.reject(scriptError('script-refused'));
    const known = loads.get(url);
    if (known) return known;
    const doc = getDocument();
    if (!doc) return Promise.reject(scriptError('no-document'));

    const load = new Promise<void>((resolve, reject) => {
      let script: HTMLScriptElement | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: DriveError): void => {
        clearTimeout(timer);
        if (script) {
          script.onload = null;
          script.onerror = null;
        }
        if (error === undefined) {
          resolve();
          return;
        }
        script?.remove();
        reject(error);
      };
      try {
        script = doc.createElement('script');
        script.onload = () => settle(defined(usable) ? undefined : scriptError('script-failed'));
        script.onerror = () => settle(scriptError('script-failed'));
        script.async = true;
        script.src = url;
        timer = setTimeout(() => settle(scriptError('script-timeout')), timeoutMs);
        // A document with nowhere to put the element throws here.
        (doc.head ?? doc.documentElement).appendChild(script);
      } catch {
        settle(scriptError('script-failed'));
      }
    });
    loads.set(url, load);
    // A failed load is forgotten, element and all, so the next call starts
    // afresh. (Registered before any caller's handler, so it runs first.)
    load.catch(() => {
      if (loads.get(url) === load) loads.delete(url);
    });
    return load;
  };
}

/** Load one of {@link DRIVE_SCRIPTS} into the page, once. */
export const loadScriptOnce: ScriptLoader = createScriptLoader();

/**
 * Every Google URL the Drive feature can reach — the only place they are
 * spelled (the scope identifier in `types.ts` names a permission and is never
 * fetched).
 */

/**
 * The Drive REST API: every request of the gateway goes here. Named rather than
 * picked out of {@link DRIVE_HOSTS} by position, so reordering that list can
 * never send Drive calls to another Google host.
 */
export const DRIVE_API_ORIGIN = 'https://www.googleapis.com';

/**
 * The two scripts the feature runs, by full URL: Google Identity Services
 * (sign-in) and `api.js`, the loader the Picker comes from. `loader.ts` loads
 * these and no other URL. Each is admitted by an entry of
 * {@link DRIVE_HOSTS}`.script` — GIS by its own path, `api.js` by its host,
 * because `gapi.load('picker')` goes on to fetch the Picker's code from there.
 */
export const DRIVE_SCRIPTS = {
  gis: 'https://accounts.google.com/gsi/client',
  gapi: 'https://apis.google.com/js/api.js',
} as const;

/**
 * Google's OAuth revocation endpoint. Sign-out POSTs the token here itself
 * (`auth.ts`), the request `google.accounts.oauth2.revoke` makes, so that only
 * Google's own answer counts as a revocation. Admitted by the
 * `oauth2.googleapis.com` entry of {@link DRIVE_HOSTS}`.connect`.
 */
export const DRIVE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * Every host the feature contacts, grouped BY CSP DIRECTIVE, because the
 * Content-Security-Policy in `index.html` is static and has to admit each of
 * these before the browser lets the request leave the page.
 * `test/unit/branding.test.ts` holds the two in step: every entry below must
 * appear in its directive of that policy, and a directive may admit nothing
 * else beyond what it admitted before Drive. A host a module contacts without
 * being listed here is a request production refuses while CI, which fakes
 * Google, stays green — so a new host goes here first.
 */
export const DRIVE_HOSTS = {
  /** Google Identity Services, and the loader the Picker comes from. */
  script: [DRIVE_SCRIPTS.gis, 'https://apis.google.com'],
  /** GIS's own stylesheet. */
  style: ['https://accounts.google.com/gsi/style'],
  /**
   * GIS's token endpoints, the Drive REST API, and the revocation endpoint:
   * sign-out POSTs to {@link DRIVE_REVOKE_URL}, so without it sign-out could
   * not revoke anything in production.
   */
  connect: ['https://accounts.google.com/gsi/', DRIVE_API_ORIGIN, 'https://oauth2.googleapis.com'],
  /** GIS's iframe, and the Picker's. */
  frame: ['https://accounts.google.com/gsi/', 'https://docs.google.com'],
} as const;

/**
 * Where Drive's own pages live. These are NAVIGATED to — a share link a user
 * pastes, a file's "Open in Drive" link — and never fetched, so no CSP
 * directive names them. Share links are parsed only from the first.
 */
export const DRIVE_WEB_ORIGINS = ['https://drive.google.com', 'https://docs.google.com'] as const;

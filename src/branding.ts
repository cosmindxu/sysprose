/**
 * Product identity — the single source of truth for how this tool names itself.
 *
 * The tool implements a SysML v2–style textual notation and an OMG-API-shaped
 * element graph, but it is a *candidate* implementation: it is not certified or
 * conformant, and "SysML" is a trademark of the Object Management Group. The
 * product therefore carries its own name, defined here. Language-level names
 * (the `.sysml` file extension, "SysML v2 textual notation", KerML, the OMG API
 * shape) are NOT product identity and stay as they are.
 *
 * Anything that renders or serialises the product name imports from this module
 * so a future rebrand is one edit. The static assets that cannot import TypeScript
 * (`index.html`, `public/manifest.webmanifest`, `package.json`) are kept in step by
 * `test/unit/branding.test.ts`, which fails if they drift from these constants.
 */

/** Full product name, as shown in the UI, page title and API documents. */
export const PRODUCT_NAME = 'Sysprose';

/** Short name for constrained surfaces (PWA launcher, home-screen icon). */
export const PRODUCT_SHORT_NAME = 'Sysprose';

/** Machine-readable slug: package name, generator id, container/image names. */
export const PRODUCT_SLUG = 'sysprose';

/** One-line positioning statement. */
export const PRODUCT_TAGLINE =
  'Another system modeler — models as prose, tested by agents in the browser.';

/** Longer description used by the manifest, package metadata and the OpenAPI info block. */
export const PRODUCT_DESCRIPTION =
  'A pure-browser system modeler with an AI-agent focus: models are developed as ' +
  'textual definitions and exercised by agents driving the app in the browser.';

/** Value written to `generator` in every serialised model document. */
export const GENERATOR_ID = PRODUCT_SLUG;

/** `$id` of the OMG element-graph JSON Schema. */
export const ELEMENT_GRAPH_SCHEMA_ID = `urn:${PRODUCT_SLUG}:element-graph`;

/**
 * Browser storage namespace (IndexedDB database name / localStorage prefix).
 *
 * DELIBERATELY still the pre-rename slug: it is invisible to users, and changing
 * it would orphan every project already saved in a browser. A one-time migration
 * to the new slug is a separate change.
 */
export const LEGACY_STORAGE_DB = 'sysmlv2-modeler';

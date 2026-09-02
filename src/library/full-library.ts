/**
 * The FULL bundled SysML v2 / KerML standard model library.
 *
 * Loads the converted OMG standard library that lives (as a `SerializedModel`)
 * in {@link ./std/stdlib.json} and merges it into a live {@link Model}. Every
 * bundled element already carries `attrs.isLibrary === true`; ids are namespaced
 * with a `stdlib:` prefix so they never collide with user-model ids.
 *
 * LICENSING: the JSON under `src/library/std/` is EPL-2.0 (see
 * `src/library/std/{LICENSE,NOTICE}` and `docs/LICENSES.md`); the rest of the
 * repository is MIT.
 *
 * ── BUNDLING ────────────────────────────────────────────────────────────────
 * This module NO LONGER statically imports the multi-MB library JSON. If it
 * did, Vite would pull ~8MB of data into a JS chunk, which (a) bloats the app
 * and (b) breaks esbuild minification (the es-module-lexer chokes on the giant
 * chunk with "Parse error @:1:1"). Instead the JSON is referenced as a DATA
 * ASSET via `new URL('./std/stdlib.json', import.meta.url)`: Vite emits it as a
 * hashed asset OUTSIDE the JS graph (e.g. `dist/assets/stdlib-<hash>.json`) and
 * rewrites the URL for the browser build. The data is then loaded lazily:
 *
 *   - Node (vitest + the Express server): read synchronously from disk. We keep
 *     a SYNCHRONOUS public API (`loadFullStandardLibrary`, the count constants,
 *     `isFullLibraryBundleAvailable`) so every existing Node caller/test is
 *     unchanged. `process.getBuiltinModule('node:fs')` gives us `readFileSync`
 *     WITHOUT an `import 'node:fs'` statement — so nothing node-specific ever
 *     enters the browser chunk (no externalization warnings).
 *   - Browser: the merge helpers require the data to be fetched first. Callers
 *     `await preloadFullLibrary()` (async fetch of the emitted asset) before the
 *     synchronous merge. The UI store already loads this module through a
 *     DYNAMIC import, so the (now tiny) module is code-split into a lazy chunk.
 *
 * Environment detection uses `process.getBuiltinModule` (present in Node and in
 * the vitest/jsdom runtime, absent in a real browser) rather than the resolved
 * URL protocol, because Vite rewrites the literal `new URL(..., import.meta.url)`
 * to a dev/asset `http:` URL even under vitest. The Node file path is therefore
 * resolved from a VARIABLE-held `import.meta.url` (which Vite leaves as a real
 * `file:` URL), while the literal form — used only on the browser fetch path — is
 * what makes Vite emit the hashed asset.
 */

import { Model, type ElementId, type ElementRecord } from '@core/index';

/** The bundled library data (typed loosely to avoid deep JSON literal inference). */
interface LibraryData {
  elements?: ElementRecord[];
  rootIds?: ElementId[];
}

/** Provenance manifest shape (only the fields we consume). */
interface StdlibManifest {
  sourceRepo?: string;
  commit?: string;
  generatedFromCount?: number;
  emittedElementCount?: number;
  packages?: string[];
}

/**
 * `import.meta.url` captured into a variable so that
 * `new URL('./std/…', metaUrl)` is NOT matched by Vite's
 * `asset-import-meta-url` transform — under vitest it then resolves to the real
 * on-disk `file:` URL instead of being rewritten to a dev-server `http:` URL.
 */
const metaUrl = import.meta.url;

/** True when running under Node (real server OR the vitest/jsdom runtime). */
function inNode(): boolean {
  return (
    typeof process !== 'undefined' &&
    typeof (process as { getBuiltinModule?: unknown }).getBuiltinModule === 'function'
  );
}

/** Read + parse a JSON file synchronously in Node, without an `import 'node:fs'`. */
function readJsonSync<T>(relative: string): T {
  const proc = process as unknown as {
    getBuiltinModule: (id: string) => unknown;
  };
  const fs = proc.getBuiltinModule('node:fs') as {
    readFileSync: (p: string, enc: string) => string;
  };
  const nodeUrl = proc.getBuiltinModule('node:url') as {
    fileURLToPath: (u: URL) => string;
  };
  const fileUrl = new URL(relative, metaUrl); // variable base → real file: URL
  return JSON.parse(fs.readFileSync(nodeUrl.fileURLToPath(fileUrl), 'utf8')) as T;
}

/** Fetch + parse a JSON asset in the browser (URLs rewritten to hashed assets). */
async function fetchJson<T>(url: URL): Promise<T> {
  const res = await fetch(url);
  return (await res.json()) as T;
}

// ── Memoised caches ──────────────────────────────────────────────────────────
let dataCache: LibraryData | null = null;
let manifestCache: StdlibManifest | null = null;

/** Populate the caches synchronously in Node. No-op if already loaded. */
function ensureLoadedSync(): void {
  if (dataCache && manifestCache) return;
  if (!inNode()) return; // browser: must go through preloadFullLibrary()
  try {
    dataCache = readJsonSync<LibraryData>('./std/stdlib.json');
    manifestCache = readJsonSync<StdlibManifest>('./std/manifest.json');
  } catch {
    // Leave caches null; callers fall back to the curated subset.
  }
}

// Eagerly populate in Node at module load so the derived constants below reflect
// the real bundle (matching the previous static-import behaviour). In the
// browser this is a no-op and the constants stay at their empty defaults (the
// browser never reads them — it goes through the async loaders/merge).
ensureLoadedSync();

/**
 * Load the full standard library data, working in BOTH environments and
 * memoising the result. Node reads it synchronously from disk; the browser
 * fetches the Vite-emitted data asset. Callers on the browser MUST await this
 * before invoking the synchronous {@link loadFullStandardLibrary}.
 */
export async function preloadFullLibrary(): Promise<void> {
  if (dataCache && manifestCache) return;
  if (inNode()) {
    ensureLoadedSync();
    return;
  }
  // Browser: the literal `new URL(..., import.meta.url)` form is what Vite
  // rewrites to the hashed emitted asset URLs.
  const [data, manifest] = await Promise.all([
    fetchJson<LibraryData>(new URL('./std/stdlib.json', import.meta.url)),
    fetchJson<StdlibManifest>(new URL('./std/manifest.json', import.meta.url)),
  ]);
  dataCache = data;
  manifestCache = manifest;
}

// NOTE: the caches are read through explicit `as` casts below. In the module's
// top-level control flow TypeScript narrows the `let` caches to their `null`
// initializer (their reassignments live in nested functions it cannot follow),
// so an un-cast read would collapse to `never`. The cast restores the declared
// union; at runtime `ensureLoadedSync()` above has already populated them in Node.
const md = manifestCache as StdlibManifest | null;
const dd = dataCache as LibraryData | null;

/** Package names authored by the full standard library (declaration order). */
export const FULL_LIBRARY_PACKAGE_NAMES: string[] = [...(md?.packages ?? [])];

/** Number of elements the bundle carries (per the emitted JSON). */
export const FULL_LIBRARY_ELEMENT_COUNT: number = Array.isArray(dd?.elements)
  ? dd.elements.length
  : 0;

/** Number of elements recorded in the provenance manifest. */
export const FULL_LIBRARY_MANIFEST_COUNT: number = md?.emittedElementCount ?? 0;

/** The upstream source-repo commit the bundle was derived from. */
export const FULL_LIBRARY_SOURCE_COMMIT: string | undefined = md?.commit;

/**
 * True when the bundled library JSON is present and non-empty. In Node this
 * reads the bundle on demand; in the browser it reflects whether
 * {@link preloadFullLibrary} has already run.
 */
export function isFullLibraryBundleAvailable(): boolean {
  ensureLoadedSync();
  return Array.isArray(dataCache?.elements) && dataCache!.elements!.length > 0;
}

/**
 * Merge the FULL standard library into `model` (preserving all existing user
 * content). Every merged element keeps `attrs.isLibrary === true`.
 *
 * Idempotent: if the model already contains any library element the merge is
 * skipped and the ids of the existing library elements are returned, so calling
 * this repeatedly (bootstrap, after every apply/import) never duplicates the
 * library.
 *
 * SYNCHRONOUS by design (unchanged public API). In Node the data is read on
 * demand; in the browser the caller must `await preloadFullLibrary()` first —
 * if the data has not been loaded this returns `[]` and the caller falls back
 * to the curated subset.
 *
 * Elements are inserted via {@link Model.create} (owner-before-child, resolving
 * the handful of forward containment references the bundle contains) inside a
 * single transaction. This intentionally does NOT use {@link Model.reset}:
 * `create` leaves every pre-existing user element object untouched, so element
 * references captured by callers before the merge remain valid (and the
 * subsequent {@link resolveTypeReferences} pass mutates those same objects).
 * User roots keep their leading position in the containment order.
 *
 * @returns the ids of every library element now present in the model.
 */
export function loadFullStandardLibrary(model: Model): ElementId[] {
  ensureLoadedSync();
  if (!Array.isArray(dataCache?.elements) || dataCache!.elements!.length === 0) return [];

  // Already loaded? Return existing library ids without re-adding.
  const existing = model.all().filter((e) => e.attrs.isLibrary === true);
  if (existing.length > 0) return existing.map((e) => e.id);

  const libElements = dataCache!.elements as ElementRecord[];
  const byId = new Map<ElementId, ElementRecord>(libElements.map((e) => [e.id, e]));
  const done = new Set<ElementId>();

  const insert = (el: ElementRecord): void => {
    if (done.has(el.id) || model.has(el.id)) {
      done.add(el.id);
      return;
    }
    // Ensure the owner exists first (the bundle mostly lists owners before
    // children, but a few forward references need this recursion).
    const ownerId = el.ownerId ?? null;
    if (ownerId !== null && !model.has(ownerId)) {
      const owner = byId.get(ownerId);
      if (owner) insert(owner);
    }
    model.create(el.eClass, {
      id: el.id,
      declaredName: el.declaredName,
      declaredShortName: el.declaredShortName,
      // If the owner still isn't present (dangling containment ref) fall back to
      // a root rather than throwing.
      ownerId: ownerId !== null && model.has(ownerId) ? ownerId : null,
      attrs: el.attrs,
      source: el.source,
      target: el.target,
    });
    done.add(el.id);
  };

  model.transaction(() => {
    for (const el of libElements) insert(el);
  });

  return libElements.map((e) => e.id);
}

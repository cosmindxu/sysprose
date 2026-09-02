/**
 * Public surface of the bundled standard model library.
 *
 * Exposes the default loader ({@link loadStandardLibrary} — the FULL bundled
 * library, falling back to the curated subset when the bundle is unavailable),
 * the full loader ({@link loadFullStandardLibrary}) and curated builder
 * ({@link buildCuratedLibrary}), the list of authored package names
 * ({@link STANDARD_LIBRARY_PACKAGES}), the reference resolver
 * ({@link findLibraryType}) and the type-reference binder
 * ({@link resolveTypeReferences} / {@link resolveModel}).
 *
 * NOTE FOR BUNDLING: this barrel statically imports {@link ../full-library},
 * which in turn statically imports the multi-MB library JSON. Node/vitest use
 * this path freely. The BROWSER build, however, must NOT reach this module on
 * its synchronous entry graph — the UI store imports {@link ../resolve}
 * (JSON-free) directly and loads the full library through a DYNAMIC import of
 * {@link ../full-library}, so the JSON is code-split into a lazy chunk. Keep it
 * that way: do not statically import `@library` / `../library/index` from any
 * module reachable from the app entry.
 */

import type { ElementId, Model } from '@core/index';
import {
  buildCuratedLibrary,
  loadCuratedLibrary,
  CURATED_LIBRARY_PACKAGE_NAMES,
  type LoadStandardLibraryOptions,
} from './standard-library';
import {
  loadFullStandardLibrary,
  isFullLibraryBundleAvailable,
  FULL_LIBRARY_PACKAGE_NAMES,
  FULL_LIBRARY_ELEMENT_COUNT,
  FULL_LIBRARY_MANIFEST_COUNT,
  FULL_LIBRARY_SOURCE_COMMIT,
} from './full-library';
import { findLibraryType, resolveTypeReferences } from './resolve';

export { findLibraryType, resolveTypeReferences };
export {
  buildCuratedLibrary,
  loadCuratedLibrary,
  CURATED_LIBRARY_PACKAGE_NAMES,
  type LoadStandardLibraryOptions,
};
export {
  loadFullStandardLibrary,
  isFullLibraryBundleAvailable,
  FULL_LIBRARY_PACKAGE_NAMES,
  FULL_LIBRARY_ELEMENT_COUNT,
  FULL_LIBRARY_MANIFEST_COUNT,
  FULL_LIBRARY_SOURCE_COMMIT,
};

/**
 * Load the standard library into `model`, preferring the FULL bundled library
 * and falling back to the curated subset when the bundle is missing/unreadable.
 *
 * When `opts.packages` is given, the CURATED builder is used (its per-package
 * partial-load semantics have no equivalent in the pre-converted full bundle).
 *
 * @returns the ids of every library element now present in the model.
 */
export function loadStandardLibrary(
  model: Model,
  opts: LoadStandardLibraryOptions = {},
): ElementId[] {
  // Explicit package selection → curated builder (partial-load semantics).
  if (opts.packages) return buildCuratedLibrary(model, opts);

  if (isFullLibraryBundleAvailable()) {
    try {
      const ids = loadFullStandardLibrary(model);
      if (ids.length > 0) return ids;
    } catch (err) {
      // Fall through to the curated subset on any bundle/merge failure.
      console.error('full standard library failed to load; using curated subset', err);
    }
  }
  return buildCuratedLibrary(model, opts);
}

/** Package names of the standard library actually loaded by default (full). */
export const STANDARD_LIBRARY_PACKAGES: string[] = FULL_LIBRARY_PACKAGE_NAMES;

/**
 * Ensure the standard library is present in `model` (loading it when no
 * `attrs.isLibrary` element exists yet), then resolve all outstanding type
 * references. Safe to call repeatedly.
 *
 * @returns the number of references newly resolved.
 */
export function resolveModel(model: Model): number {
  const hasLibrary = model.all().some((el) => el.attrs.isLibrary === true);
  if (!hasLibrary) loadStandardLibrary(model);
  return resolveTypeReferences(model);
}

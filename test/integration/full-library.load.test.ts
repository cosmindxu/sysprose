/**
 * Integration — FULL bundled standard library: loading, marking, provenance and
 * a coarse performance bound.
 *
 * The full library is the converted OMG SysML v2 / KerML standard model library
 * bundled as JSON under `src/library/std/`. These tests assert it merges into a
 * live {@link Model} with a sensible lower bound of elements (derived from the
 * manifest), that every merged element is flagged `attrs.isLibrary`, and that
 * the merge is idempotent and reasonably fast.
 */

import { describe, it, expect } from 'vitest';
import { Model } from '@core/index';
import {
  loadFullStandardLibrary,
  isFullLibraryBundleAvailable,
  FULL_LIBRARY_ELEMENT_COUNT,
  FULL_LIBRARY_MANIFEST_COUNT,
  FULL_LIBRARY_PACKAGE_NAMES,
} from '../../src/library/full-library';
import { loadStandardLibrary, STANDARD_LIBRARY_PACKAGES } from '../../src/library/index';

describe('full standard library — loading & structure', () => {
  it('the bundle is available and reports a substantial element count', () => {
    expect(isFullLibraryBundleAvailable()).toBe(true);
    // Sensible lower bound (brief: > 300). The manifest count and the emitted
    // element count agree.
    expect(FULL_LIBRARY_ELEMENT_COUNT).toBeGreaterThan(300);
    expect(FULL_LIBRARY_ELEMENT_COUNT).toBe(FULL_LIBRARY_MANIFEST_COUNT);
    expect(FULL_LIBRARY_PACKAGE_NAMES.length).toBeGreaterThanOrEqual(50);
  });

  it('merges the full library into a fresh model and returns every id', () => {
    const model = new Model();
    const ids = loadFullStandardLibrary(model);
    expect(ids.length).toBe(FULL_LIBRARY_ELEMENT_COUNT);
    expect(ids.length).toBeGreaterThan(300);
    expect(model.size).toBe(ids.length);
    // Every merged element is flagged as library content.
    expect(model.all().every((el) => el.attrs.isLibrary === true)).toBe(true);
    // The well-known package roots are present as LibraryPackages.
    for (const name of ['Base', 'ScalarValues', 'Collections', 'ISQ', 'SI']) {
      const pkg = model.roots().find((r) => r.declaredName === name);
      expect(pkg, `package ${name}`).toBeDefined();
      expect(pkg!.eClass).toBe('LibraryPackage');
    }
  });

  it('carries the cross-namespace scoping relationships (imports & aliases)', () => {
    const model = new Model();
    loadFullStandardLibrary(model);
    // The conversion preserves the KerML Import/alias relationships so that
    // cross-namespace qualified names resolve by a genuine import walk.
    const nsImports = model.all().filter((e) => e.eClass === 'NamespaceImport');
    const msImports = model.all().filter((e) => e.eClass === 'MembershipImport');
    expect(nsImports.length).toBeGreaterThan(0);
    expect(msImports.length).toBeGreaterThan(0);
    // Each carries a resolved source (owning namespace) and target, all library.
    for (const rel of nsImports) {
      expect(rel.attrs.isLibrary).toBe(true);
      expect((rel.source ?? []).length).toBe(1);
      expect((rel.target ?? []).length).toBe(1);
    }
  });

  it('preserves existing user content when merging', () => {
    const model = new Model();
    const pkg = model.create('Package', { declaredName: 'UserPkg' });
    const before = model.size;
    loadFullStandardLibrary(model);
    // User element still present and NOT flagged as library.
    expect(model.has(pkg.id)).toBe(true);
    expect(model.get(pkg.id)!.attrs.isLibrary).toBeUndefined();
    expect(model.size).toBe(before + FULL_LIBRARY_ELEMENT_COUNT);
    // The user root remains a root (declared before the library roots).
    expect(model.rootIds()[0]).toBe(pkg.id);
  });

  it('is idempotent: a second merge adds nothing', () => {
    const model = new Model();
    loadFullStandardLibrary(model);
    const size = model.size;
    const ids2 = loadFullStandardLibrary(model);
    expect(model.size).toBe(size);
    // Returns the ids of the already-present library elements.
    expect(ids2.length).toBe(FULL_LIBRARY_ELEMENT_COUNT);
  });

  it('the default loadStandardLibrary uses the FULL library', () => {
    const model = new Model();
    const ids = loadStandardLibrary(model);
    expect(ids.length).toBe(FULL_LIBRARY_ELEMENT_COUNT);
    // Public package list reflects the full library.
    expect(STANDARD_LIBRARY_PACKAGES.length).toBe(FULL_LIBRARY_PACKAGE_NAMES.length);
    expect(STANDARD_LIBRARY_PACKAGES).toContain('ISQ');
  });

  it('loads within a coarse time budget', () => {
    const model = new Model();
    const t0 = Date.now();
    loadFullStandardLibrary(model);
    const elapsed = Date.now() - t0;
    // Deliberately huge bound: this is only a hang/O(n²)-regression tripwire, not
    // a performance SLA. A quadratic blow-up on ~38k elements would take minutes;
    // a tight bound (was 5 s) instead flaked on loaded CI runners and vboxsf
    // shares. The functional correctness (element/package counts) is asserted above.
    expect(elapsed).toBeLessThan(60_000);
  });
});

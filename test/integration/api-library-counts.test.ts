/**
 * Integration — the counts an AI agent sees when the standard library is loaded.
 *
 * The browser exposes `window.sysml` (a {@link ModelApi}) only AFTER merging the
 * ~38,700-element bundled library, so every count an agent reads is taken in
 * that state. Those counts used to include the library: an 8-element model
 * reported 38,770 elements, 189 roots and 1,011 AttributeDefinitions. Nothing
 * crashed and no data was wrong — the numbers simply answered a different
 * question than the one asked, which for the audience this tool targets is the
 * failure that matters.
 *
 * Confirmed by a Fable advisory, 2026-09-02. These tests pin the user-model
 * default AND the deliberate opt-in, because discovering library types is a
 * legitimate thing for an agent to want.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { parseModel } from '@text/index';
import { ModelApi, modelMetrics } from '@api/index';
import { preloadFullLibrary, loadFullStandardLibrary } from '../../src/library/full-library';
import { resolveTypeReferences } from '../../src/library/resolve';
import type { Model } from '@core/index';

const SOURCE = `package Vehicle {
    part def Car {
        attribute mass : Real = 1200.0;
    }
    part def Wheel;
    part car : Car;
    requirement def MassReq {
        subject car : Car;
    }
}
`;

describe('ModelApi counts with the full standard library loaded', () => {
  let model: Model;
  let api: ModelApi;
  let userElements: number;

  beforeAll(async () => {
    const parsed = parseModel(SOURCE);
    model = parsed.model;
    const authored = model.all().length;
    await preloadFullLibrary();
    loadFullStandardLibrary(model);
    resolveTypeReferences(model);
    api = new ModelApi(model);
    // Binding adds a FeatureTyping to the USER's attribute (`mass : Real` →
    // ScalarValues::Real), so the user model legitimately grows by one. That
    // relationship belongs to the user's element, not to the library, and must
    // stay in these counts — the filter keys on `isLibrary`, not on origin.
    userElements = model.all().filter((el) => el.attrs.isLibrary !== true).length;
    expect(userElements).toBe(authored + 1);
  });

  it('loads a library large enough for the distinction to matter', () => {
    expect(model.all().length).toBeGreaterThan(30_000);
    expect(api.libraryElementCount()).toBeGreaterThan(30_000);
  });

  it('reports the user model, not the library, in metrics', () => {
    const m = modelMetrics(model);
    expect(m.totalElements).toBeLessThan(100);
    expect(m.totalElements).toBe(userElements);
    expect(m.rootCount).toBe(1);
    expect(m.libraryElements).toBe(api.libraryElementCount());
  });

  it('returns only the user root, with the library available on request', () => {
    expect(api.roots()).toHaveLength(1);
    expect(api.roots()[0].declaredName).toBe('Vehicle');
    expect(api.roots({ includeLibrary: true }).length).toBeGreaterThan(100);
  });

  it('counts only the user\'s elements of a metaclass by default', () => {
    const userDefs = api.elementsOfType('PartDefinition');
    expect(userDefs.map((e) => e.declaredName).sort()).toEqual(['Car', 'Wheel']);
    expect(
      api.elementsOfType({ includeLibrary: true }, 'PartDefinition').length,
      'the library must still be reachable deliberately',
    ).toBeGreaterThan(userDefs.length);
  });

  it('does not answer a question about the model with the library', () => {
    // The failure that motivated this: an agent asking how many attribute
    // definitions its model has got the library's thousand.
    expect(api.elementsOfType('AttributeDefinition')).toHaveLength(0);
    expect(
      api.elementsOfType({ includeLibrary: true }, 'AttributeDefinition').length,
    ).toBeGreaterThan(500);
  });

  it('serializes the user model, not a 38k-element dump', () => {
    expect(api.toModelJSON()).toHaveLength(userElements);
    expect(api.toModelJSON({ includeLibrary: true }).length).toBeGreaterThan(30_000);
  });

  it('leaves the raw Model untouched — it is the library-inclusive source', () => {
    // `model.all()` is deliberately NOT filtered: the e2e suite polls it to
    // prove the async library merge landed, and filtering it would break the
    // one honest signal that the library is present.
    expect(model.all().length).toBeGreaterThan(userElements);
  });
});

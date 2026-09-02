/**
 * Integration — standard-library type-reference resolution.
 *
 * Exercises the full pipeline the UI wires up: parse SysML v2 text (which
 * preserves unresolved typings as `attrs.typeRef` / `attrs.type` strings), load
 * the bundled standard library into the SAME model, then resolve those textual
 * references into real FeatureTyping relationships. Also asserts the validation
 * rule and diagram projection behave correctly around the loaded library.
 */

import { describe, it, expect } from 'vitest';
import { parseModel } from '@text/index';
import { validate } from '@validation/index';
import { buildDiagram } from '@diagram/index';
import type { ElementRecord, Model } from '@core/index';
import {
  loadStandardLibrary,
  resolveTypeReferences,
  resolveModel,
  findLibraryType,
} from '../../src/library/index';

/** First element matching a predicate (throws when absent — keeps tests honest). */
function must(model: Model, pred: (el: ElementRecord) => boolean, what: string): ElementRecord {
  const el = model.all().find(pred);
  if (!el) throw new Error(`expected to find ${what}`);
  return el;
}

describe('library-resolve: attribute typing against ScalarValues::Real', () => {
  it('binds `attribute mass : Real` to ScalarValues::Real without a warning', () => {
    const { model } = parseModel('package P { part def V { attribute mass : Real; } }');

    const mass = must(model, (e) => e.declaredName === 'mass', 'the mass attribute');

    // Parser records attribute typing as a display string, not a relationship.
    expect(mass.eClass).toBe('AttributeUsage');
    expect(mass.attrs.type).toBe('Real');
    expect(model.typesOf(mass.id)).toHaveLength(0);

    // Load the library + resolve.
    loadStandardLibrary(model);
    const count = resolveTypeReferences(model);
    expect(count).toBeGreaterThanOrEqual(1);

    // A FeatureTyping to ScalarValues::Real now exists…
    const types = model.typesOf(mass.id);
    expect(types).toHaveLength(1);
    expect(model.qualifiedName(types[0].id)).toBe('ScalarValues::Real');
    expect(types[0].attrs.isLibrary).toBe(true);

    // …the display string is preserved…
    expect(mass.attrs.type).toBe('Real');

    // …and the materialised FeatureTyping is a USER relationship, not library.
    const typing = must(
      model,
      (e) => e.eClass === 'FeatureTyping' && (e.source ?? []).includes(mass.id),
      'the mass FeatureTyping',
    );
    expect(typing.attrs.isLibrary).toBeUndefined();
    expect(typing.ownerId).toBe(mass.id);

    // Validation reports no unresolved-type-ref anywhere (in particular on mass).
    const diags = validate(model);
    expect(diags.filter((d) => d.ruleId === 'unresolved-type-ref')).toHaveLength(0);
    expect(diags.some((d) => d.ruleId === 'feature-typing-non-type')).toBe(false);
  });
});

describe('library-resolve: plain feature typeRef (library + user forward reference)', () => {
  it('resolves a library type and a forward-declared user type, deleting typeRef', () => {
    // `Q::Later` is a genuine forward, cross-package reference: package Q is
    // declared AFTER package P, so the parser cannot resolve it while parsing P
    // and preserves it as attrs.typeRef. `LengthValue` is likewise unresolved
    // because the standard library is not loaded yet.
    const src = `package P {
      part def V {
        item len : LengthValue;
        part sub : Q::Later;
      }
    }
    package Q {
      part def Later;
    }`;
    const { model } = parseModel(src);

    const len = must(model, (e) => e.declaredName === 'len', 'the len feature');
    const sub = must(model, (e) => e.declaredName === 'sub', 'the sub feature');

    // Both are unresolved at parse time (library not loaded; Q::Later is forward).
    expect(len.attrs.typeRef).toBe('LengthValue');
    expect(sub.attrs.typeRef).toBe('Q::Later');
    expect(model.typesOf(len.id)).toHaveLength(0);
    expect(model.typesOf(sub.id)).toHaveLength(0);

    loadStandardLibrary(model);
    const count = resolveTypeReferences(model);
    expect(count).toBe(2);

    // Library type bound + textual ref removed. In the FULL library `LengthValue`
    // is owned by the `ISQBase` package (and re-exported through `ISQ`), so the
    // last-segment resolver binds to `ISQBase::LengthValue`.
    expect(len.attrs.typeRef).toBeUndefined();
    expect(model.qualifiedName(model.typesOf(len.id)[0].id)).toBe('ISQBase::LengthValue');

    // User forward reference bound to the in-model definition (Q::Later).
    expect(sub.attrs.typeRef).toBeUndefined();
    const subType = model.typesOf(sub.id)[0];
    expect(subType.declaredName).toBe('Later');
    expect(model.qualifiedName(subType.id)).toBe('Q::Later');
    expect(subType.attrs.isLibrary).toBeUndefined();

    // No unresolved warnings remain.
    expect(validate(model).some((d) => d.ruleId === 'unresolved-type-ref')).toBe(false);
  });
});

describe('library-resolve: resolveModel loads the library on demand + idempotency', () => {
  it('auto-loads the library, resolves, and is a no-op on a second pass', () => {
    const { model } = parseModel('package P { part def V { attribute mass : Real; } }');

    // No library present yet.
    expect(model.all().some((e) => e.attrs.isLibrary === true)).toBe(false);

    const first = resolveModel(model);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(model.all().some((e) => e.attrs.isLibrary === true)).toBe(true);
    expect(findLibraryType(model, 'Real')).toBeDefined();

    // Second pass finds nothing new (no duplicate FeatureTypings/library).
    const before = model.size;
    const second = resolveTypeReferences(model);
    expect(second).toBe(0);
    expect(model.size).toBe(before);
    expect(model.typesOf(must(model, (e) => e.declaredName === 'mass', 'mass').id)).toHaveLength(1);
  });
});

describe('library-resolve: validation rule treats library refs as resolved', () => {
  it('does not warn for a library-resolvable typeRef but warns for an unknown one', () => {
    const { model } = parseModel('package P { part def V { part good; part bad; } }');
    loadStandardLibrary(model);

    const good = must(model, (e) => e.declaredName === 'good', 'good');
    const bad = must(model, (e) => e.declaredName === 'bad', 'bad');

    // Inject unresolved textual refs directly (no resolution pass run).
    model.setAttrs(good.id, { typeRef: 'MassValue' }); // exists in ISQ
    model.setAttrs(bad.id, { typeRef: 'NoSuchType' });

    const warnings = validate(model).filter((d) => d.ruleId === 'unresolved-type-ref');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].elementId).toBe(bad.id);
  });
});

describe('library-resolve: diagram excludes library elements by default', () => {
  it('projects only user elements while opts.excludeLibrary=false includes the library', () => {
    const { model } = parseModel('package P { part def V { attribute mass : Real; } }');
    resolveModel(model);

    const userGraph = buildDiagram(model, 'general');
    const libNodes = userGraph.nodes.filter((n) => model.get(n.elementId)?.attrs.isLibrary === true);
    expect(libNodes).toHaveLength(0);
    expect(userGraph.nodes.some((n) => n.label === 'V')).toBe(true);

    const withLib = buildDiagram(model, 'general', undefined, { excludeLibrary: false });
    expect(withLib.nodes.length).toBeGreaterThan(userGraph.nodes.length);
    expect(withLib.nodes.some((n) => model.get(n.elementId)?.attrs.isLibrary === true)).toBe(true);
  });
});

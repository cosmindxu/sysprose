/**
 * Integration — resolving names and textual type references against the FULL
 * bundled standard library.
 *
 * Confirms that the well-known qualified names the SysML v2 spec exposes resolve
 * through {@link findLibraryType} (including a name re-exported through a package
 * import, `ISQ::MassValue`), and that a parsed `attribute mass : Real` binds to a
 * real FeatureTyping into the full library.
 */

import { describe, it, expect } from 'vitest';
import { Model } from '@core/index';
import { parseModel } from '@text/index';
import { validate } from '@validation/index';
import {
  loadFullStandardLibrary,
  findLibraryType,
  resolveTypeReferences,
} from '../../src/library/index';
import { resolveName, resolveQualifiedNameFull } from '../../src/semantics/index';

/** A fresh model carrying the full standard library. */
function libModel(): Model {
  const model = new Model();
  loadFullStandardLibrary(model);
  return model;
}

describe('full library — findLibraryType resolves the well-known names', () => {
  const model = libModel();

  const cases: Array<[query: string, expectedQName: string]> = [
    ['ScalarValues::Real', 'ScalarValues::Real'],
    ['SI::metre', 'SI::metre'],
    ['Collections::List', 'Collections::List'],
    ['Base::Anything', 'Base::Anything'],
    // `MassValue` is defined in `ISQBase` and re-exported through `ISQ`'s public
    // NamespaceImport. findLibraryType's last-segment fallback binds it too; the
    // genuine import walk is asserted separately below.
    ['ISQ::MassValue', 'ISQBase::MassValue'],
  ];

  for (const [query, expected] of cases) {
    it(`resolves ${query}`, () => {
      const el = findLibraryType(model, query);
      expect(el, query).toBeDefined();
      expect(el!.attrs.isLibrary).toBe(true);
      expect(model.qualifiedName(el!.id)).toBe(expected);
    });
  }

  it('resolves bare names and the metre unit symbol', () => {
    expect(model.qualifiedName(findLibraryType(model, 'Real')!.id)).toBe('ScalarValues::Real');
    expect(findLibraryType(model, 'm')!.declaredName).toBe('metre');
    expect(findLibraryType(model, 'NoSuchType')).toBeUndefined();
  });
});

describe('full library — cross-namespace names resolve via the real KerML import walk', () => {
  const model = libModel();

  it('carries the converted Import/alias scoping relationships', () => {
    // The XMI conversion now preserves the scoping relationships that name
    // resolution walks (previously stripped, forcing a library-wide fallback).
    const nsImports = model.all().filter((e) => e.eClass === 'NamespaceImport');
    const msImports = model.all().filter((e) => e.eClass === 'MembershipImport');
    const aliases = model.all().filter((e) => e.eClass === 'Membership');
    expect(nsImports.length).toBeGreaterThan(0);
    expect(msImports.length).toBeGreaterThan(0);
    expect(aliases.length).toBeGreaterThan(0);
    // Every scoping relationship is flagged as library content and points into
    // the loaded library (source + target present).
    for (const rel of [...nsImports, ...msImports, ...aliases]) {
      expect(rel.attrs.isLibrary).toBe(true);
      expect(model.has((rel.source ?? [])[0]!)).toBe(true);
      expect(model.has((rel.target ?? [])[0]!)).toBe(true);
    }
  });

  it("ISQ owns a public NamespaceImport of ISQBase", () => {
    const isq = resolveName(model, null, 'ISQ')!;
    const imports = model.children(isq.id).filter((c) => c.eClass === 'NamespaceImport');
    expect(imports.length).toBeGreaterThan(0);
    // At least one import targets the ISQBase namespace that owns MassValue.
    const toISQBase = imports.some((imp) => {
      const target = model.get((imp.target ?? [])[0]!);
      return target?.declaredName === 'ISQBase';
    });
    expect(toISQBase).toBe(true);
  });

  it("resolves 'ISQ::MassValue' by WALKING the import (no fallback needed)", () => {
    // Resolve segment-by-segment through the scoping rules only — this is exactly
    // what resolveQualifiedNameFull does before its findLibraryType safety net,
    // so a hit here proves the walk (not the fallback) resolves the name.
    const isq = resolveName(model, null, 'ISQ');
    expect(isq?.declaredName).toBe('ISQ');
    const mv = resolveName(model, isq!.id, 'MassValue');
    expect(mv, 'MassValue reached through ISQ import of ISQBase').toBeDefined();
    expect(mv!.declaredName).toBe('MassValue');
    expect(mv!.attrs.isLibrary).toBe(true);
    expect(model.qualifiedName(mv!.id)).toBe('ISQBase::MassValue');

    // The public entry point resolves to the same element.
    const full = resolveQualifiedNameFull(model, 'ISQ::MassValue');
    expect(model.qualifiedName(full!.id)).toBe('ISQBase::MassValue');
  });
});

describe('full library — parsed `attribute mass : Real` binds a FeatureTyping', () => {
  it('materialises a FeatureTyping into ScalarValues::Real', () => {
    const { model } = parseModel('package P { part def V { attribute mass : Real; } }');
    const mass = model.all().find((e) => e.declaredName === 'mass')!;
    expect(mass.eClass).toBe('AttributeUsage');
    expect(mass.attrs.type).toBe('Real');
    expect(model.typesOf(mass.id)).toHaveLength(0);

    loadFullStandardLibrary(model);
    const count = resolveTypeReferences(model);
    expect(count).toBeGreaterThanOrEqual(1);

    // A single FeatureTyping into the full library's ScalarValues::Real.
    const types = model.typesOf(mass.id);
    expect(types).toHaveLength(1);
    expect(model.qualifiedName(types[0].id)).toBe('ScalarValues::Real');
    expect(types[0].attrs.isLibrary).toBe(true);

    // The materialised typing is a USER relationship (not library), owned by mass.
    const typing = model
      .children(mass.id)
      .find((c) => c.eClass === 'FeatureTyping' && (c.target ?? []).includes(types[0].id))!;
    expect(typing).toBeDefined();
    expect(typing.attrs.isLibrary).toBeUndefined();

    // No structural validation noise from the (large) library or the binding.
    const diags = validate(model);
    expect(diags.filter((d) => d.ruleId === 'unresolved-type-ref')).toHaveLength(0);
    expect(diags.some((d) => d.ruleId === 'feature-typing-non-type')).toBe(false);
  });

  it('binds a plain feature typeRef (item len : LengthValue) into the library', () => {
    const { model } = parseModel('package P { part def V { item len : LengthValue; } }');
    const len = model.all().find((e) => e.declaredName === 'len')!;
    expect(len.attrs.typeRef).toBe('LengthValue');

    loadFullStandardLibrary(model);
    resolveTypeReferences(model);

    expect(len.attrs.typeRef).toBeUndefined();
    const t = model.typesOf(len.id)[0];
    expect(t.attrs.isLibrary).toBe(true);
    expect(model.qualifiedName(t.id)).toBe('ISQBase::LengthValue');
  });
});

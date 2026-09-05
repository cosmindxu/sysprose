/**
 * Integration — resolving names and textual type references against the FULL
 * bundled standard library.
 *
 * Confirms that the well-known qualified names the SysML v2 spec exposes resolve
 * through {@link findLibraryType}, that a name re-exported through a package
 * import (`ISQ::MassValue`) resolves by the genuine KerML import walk, that a
 * DANGLING qualified path resolves to nothing at all, that a user package
 * sharing a library root's NAME does not hide the library behind it, and that a
 * parsed `attribute mass : Real` binds to a real FeatureTyping into the full
 * library.
 */

import { describe, it, expect } from 'vitest';
import { Model } from '@core/index';
import { parseModel } from '@text/index';
import { loadModelText } from '@text/load';
import { validate } from '@validation/index';
import {
  loadFullStandardLibrary,
  findLibraryType,
  resolveTypeReferences,
} from '../../src/library/index';
import {
  generalizationsWithImplicit,
  resolveName,
  resolveQualifiedNameFull,
} from '../../src/semantics/index';

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

  it('does NOT answer a QUALIFIED name with a last-segment namesake', () => {
    // The last-segment index is the safety net for a BARE name (`Real`, the
    // unit symbol `m`). Applying it to a qualified name threw the qualifier
    // away, so any dangling path whose final segment happened to collide with a
    // library name resolved to a stranger: `NoSuchPkg::B` → `SI::byte`,
    // `Totally::Bogus::Path::m` → `SI::metre`. A qualified name now answers only
    // when the library really contains it.
    expect(findLibraryType(model, 'NoSuchPkg::B')).toBeUndefined();
    expect(findLibraryType(model, 'Totally::Bogus::Path::m')).toBeUndefined();
    expect(findLibraryType(model, 'SI::NoSuchThing')).toBeUndefined();
    // The bare names those paths END in still resolve — only the qualified
    // spelling is refused.
    expect(model.qualifiedName(findLibraryType(model, 'B')!.id)).toBe('SI::byte');
    expect(model.qualifiedName(findLibraryType(model, 'm')!.id)).toBe('SI::metre');
  });

  it('re-exported `ISQ::MassValue` resolves by the import walk, not the index', () => {
    // The qualified half of the safety net was justified by this name — but the
    // converted library carries the real `Import` relationships, so the genuine
    // KerML walk already answers it. `findLibraryType` no longer needs to, and
    // the fallback that also bound strangers is gone.
    expect(findLibraryType(model, 'ISQ::MassValue')).toBeUndefined();
    expect(model.qualifiedName(resolveQualifiedNameFull(model, 'ISQ::MassValue')!.id)).toBe(
      'ISQBase::MassValue',
    );
  });

  it('is not shadowed by a USER package of the same root name', async () => {
    // The qualified walk used to start at EVERY root and take the first one
    // answering to the leading segment, with no way back. A user file opening
    // `package Parts { … }` therefore captured `Parts::Part` — the implicit base
    // every part specializes — and the model silently lost its whole library
    // tower: no `Parts::Part`, so no `Items::Item`, no `Occurrences::Occurrence`,
    // and inherited library members such as `timeSlices` stopped resolving.
    // A dozen library roots have names a reader might reasonably reuse
    // (`Parts`, `Requirements`, `Actions`, `Views`, `Metadata`, `Flows`…), so
    // this is not an exotic file.
    const { model: m, report } = await loadModelText(
      'package Parts {\n    part def Fastener;\n}\npackage P {\n' +
        '    part def Car {\n        part slice :>> timeSlices;\n    }\n}\n',
      { fileName: 'shadow.sysml' },
    );
    expect(m).toBeDefined();
    expect(m!.qualifiedName(findLibraryType(m!, 'Parts::Part')!.id)).toBe('Parts::Part');

    const car = m!.all().find((e) => e.declaredName === 'Car')!;
    expect(
      generalizationsWithImplicit(m!, car.id).map((g) => m!.qualifiedName(g.id)),
      'the implicit library tower survives a user package named `Parts`',
    ).toEqual([
      'Parts::Part',
      'Items::Item',
      'Objects::Object',
      'Occurrences::Occurrence',
      'Base::Anything',
    ]);
    // And the inherited library member the tower carries still resolves: with
    // the library shadowed away, `:>> timeSlices` had nothing to redefine and
    // the run raised a validation ERROR. (The `ref/unresolved-specialization`
    // warning on the same line is unrelated — the reference reporter does not
    // follow inherited members, and it is raised with or without the shadow.)
    expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(report.diagnostics.map((d) => d.code)).toEqual(['ref/unresolved-specialization']);
  }, 60_000);
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

  it('binds a QUALIFIED typeRef re-exported through a package import', () => {
    // The other side of the dangling-path refusal: `ISQ::LengthValue` is a real
    // path — `ISQ` publicly imports `ISQBase`, which owns `LengthValue` — and
    // the binder must still resolve it now that the library index refuses
    // qualified names. It does, by the genuine KerML import walk, which is what
    // makes the refusal a narrowing of guesswork rather than a loss of reach.
    const { model } = parseModel('package P { part def V { item len : ISQ::LengthValue; } }');
    const len = model.all().find((e) => e.declaredName === 'len')!;
    expect(len.attrs.typeRef).toBe('ISQ::LengthValue');

    loadFullStandardLibrary(model);
    resolveTypeReferences(model);

    expect(len.attrs.typeRef, 'bound, so the textual form is cleared').toBeUndefined();
    const t = model.typesOf(len.id)[0];
    expect(t, 'a real path must still bind').toBeDefined();
    expect(model.qualifiedName(t.id)).toBe('ISQBase::LengthValue');
  });

  it('answers an `attribute` and an `item` the same way on one re-exported path', () => {
    // The binder has two branches — `attrs.typeRef` for a plain feature,
    // `attrs.type` for an AttributeUsage — and only the first was given the
    // KerML import walk. So `attribute a : AnalysisTooling::Real` silently lost
    // its typing while `item b : AnalysisTooling::Real` on the very next line
    // kept it: one written path, two answers, decided by metaclass. There are
    // 74 library roots that re-export a `ScalarValues` member this way.
    const { model } = parseModel(
      'package P { part def V { attribute a : AnalysisTooling::Real; ' +
        'item b : AnalysisTooling::Real; } }',
    );
    loadFullStandardLibrary(model);
    resolveTypeReferences(model);

    const typeOf = (name: string): string | undefined => {
      const el = model.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true)!;
      const t = model.typesOf(el.id)[0];
      return t ? model.qualifiedName(t.id) : undefined;
    };
    expect(typeOf('b'), 'the branch that always had the walk').toBe('ScalarValues::Real');
    expect(typeOf('a'), 'the branch that did not').toBe('ScalarValues::Real');
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

describe('full library — a dangling QUALIFIED reference is not bound to a stranger', () => {
  const SRC = `package H {
  part def Vehicle {
    part engine : B;
    part wheel : NoSuchPkg::B;
    part gear : Totally::Bogus::Path::m;
  }
}
`;

  it('leaves the dangling paths unbound and says so', async () => {
    // `npm run check` used to report OK on this file: `NoSuchPkg::B` bound to
    // `SI::byte` and `Totally::Bogus::Path::m` to `SI::metre`, because the
    // library index was consulted with the qualifier thrown away. A wrong
    // binding is worse than a loud one — the writer never learns the path is
    // fiction, and every report downstream believes the type.
    const { model, report } = await loadModelText(SRC, { fileName: 'h.sysml' });
    const typeOf = (name: string): string | undefined => {
      const el = model!.all().find((e) => e.declaredName === name)!;
      const t = model!.typesOf(el.id)[0];
      return t ? model!.qualifiedName(t.id) : undefined;
    };

    expect(typeOf('wheel'), 'NoSuchPkg::B names nothing').toBeUndefined();
    expect(typeOf('gear'), 'Totally::Bogus::Path::m names nothing').toBeUndefined();
    // The BARE name is the recorded leniency and still binds.
    expect(typeOf('engine')).toBe('SI::byte');

    const unresolved = report.diagnostics.filter(
      (d) => d.code === 'ref/unresolved-specialization',
    );
    expect(unresolved.map((d) => d.message).sort()).toEqual([
      "Unresolved reference 'NoSuchPkg::B'",
      "Unresolved reference 'Totally::Bogus::Path::m'",
    ]);
  }, 60_000);
});

/**
 * Type-reference resolution against the loaded standard library.
 *
 * The textual parser preserves unresolved feature typings as strings on
 * `attrs` (a non-attribute feature keeps `attrs.typeRef`; an AttributeUsage
 * keeps `attrs.type`) rather than fabricating dangling relationships. Once the
 * standard library has been loaded into the same {@link Model} (see
 * {@link ../index}.loadStandardLibrary), those textual references can be bound
 * to real library types.
 *
 * {@link resolveTypeReferences} walks every NON-library element and, for each
 * still-unresolved typing, creates a {@link FeatureTyping} to the resolved
 * library (or user) type — mirroring exactly the shape the parser/factory
 * produce for an in-model typing (ownerId = feature, source = [feature],
 * target = [type]). For plain feature typings it also removes the now-redundant
 * `attrs.typeRef`; attribute typings keep their `attrs.type` string for display
 * while gaining the semantic FeatureTyping link.
 *
 * The pass is idempotent: an element that already carries a FeatureTyping to a
 * real type is skipped, so running it repeatedly (bootstrap, after every
 * apply/import) never duplicates relationships.
 *
 * This module is deliberately JSON-free (it imports no library-data module) so
 * that importing it — from validation, the UI store, etc. — never pulls the
 * multi-MB library bundle onto the entry graph. The library data is loaded
 * elsewhere ({@link ../full-library} / {@link ../standard-library}); this module
 * only *resolves* against whatever library elements are already present.
 */

import {
  Model,
  resolveTypeInScopeChain,
  type ElementId,
  type ElementRecord,
} from '@core/index';

/**
 * Resolve `name` against the loaded standard-library elements (those carrying
 * `attrs.isLibrary === true`).
 *
 * Resolution order:
 *  1. exact fully-qualified name via strict containment (e.g.
 *     `ScalarValues::Real`, `SI::metre`, `Collections::List`, `Base::Anything`);
 *  2. failing that, the last `::`-segment matched against a library element's
 *     `declaredName` or `declaredShortName` (e.g. a bare `Real`, the unit symbol
 *     `m`, or a name re-exported through a package import such as
 *     `ISQ::MassValue`, whose definition is owned by `ISQBase`).
 *
 * Step 1 uses {@link Model.resolveQualifiedName} (a roots→children walk) rather
 * than scanning + stringifying every library element, so it stays fast even
 * against the full library (tens of thousands of elements).
 *
 * @returns the matching {@link ElementRecord}, or `undefined` when none matches.
 */
export function findLibraryType(model: Model, name: string): ElementRecord | undefined {
  const query = name.trim();
  if (query === '') return undefined;

  // 1. Exact qualified-name match via strict containment (fast).
  const exact = model.resolveQualifiedName(query);
  if (exact && exact.attrs.isLibrary === true) return exact;

  // 2. Last-segment match on declaredName / declaredShortName among library
  //    elements (handles bare names, unit symbols, and import re-exports).
  //    Backed by a per-revision index so this is O(1) instead of an O(n) scan
  //    over the full ~38k-element library on every unresolved reference.
  const last = query.split('::').pop()?.trim();
  if (!last) return undefined;
  return libraryNameIndex(model).get(last);
}

/** rev-keyed cache of {last-segment name → first matching library element}. */
interface LibNameIndex {
  rev: number;
  byName: Map<string, ElementRecord>;
}
const libNameIndexCache = new WeakMap<Model, LibNameIndex>();

function libraryNameIndex(model: Model): Map<string, ElementRecord> {
  const cached = libNameIndexCache.get(model);
  if (cached && cached.rev === model.rev) return cached.byName;
  const byName = new Map<string, ElementRecord>();
  for (const el of model.all()) {
    if (el.attrs.isLibrary !== true) continue;
    // First writer wins, matching the previous Array.find (first match) order.
    if (el.declaredName && !byName.has(el.declaredName)) byName.set(el.declaredName, el);
    if (el.declaredShortName && !byName.has(el.declaredShortName)) {
      byName.set(el.declaredShortName, el);
    }
  }
  libNameIndexCache.set(model, { rev: model.rev, byName });
  return byName;
}

/** True when `el` already owns a FeatureTyping whose target exists in-model. */
function hasResolvedFeatureTyping(model: Model, el: ElementRecord): boolean {
  return model
    .children(el.id)
    .some((c) => c.eClass === 'FeatureTyping' && (c.target ?? []).some((t) => model.has(t)));
}

/** Delete a single attribute key from an element and emit a change event. */
function clearAttr(model: Model, id: ElementId, key: string): void {
  const el = model.get(id);
  if (!el || !(key in el.attrs)) return;
  delete el.attrs[key];
  // Re-emit so subscribers (UI `rev`, diagram) see the mutation.
  model.setAttrs(id, {});
}

/** Create the canonical FeatureTyping relationship for `featureId → typeId`. */
function addFeatureTyping(model: Model, featureId: ElementId, typeId: ElementId): void {
  model.create('FeatureTyping', {
    ownerId: featureId,
    source: [featureId],
    target: [typeId],
  });
}

/**
 * True when `type` is a member of the `ScalarValues` library package (e.g.
 * `Real`, `Integer`, `Boolean`, `String`). Attribute typings are only bound to
 * scalar value types per the module brief.
 */
function isScalarValueType(model: Model, type: ElementRecord): boolean {
  if (type.attrs.isLibrary !== true) return false;
  const owner = type.ownerId ? model.get(type.ownerId) : undefined;
  return owner?.declaredName === 'ScalarValues';
}

/**
 * Resolve every unresolved textual type reference on NON-library elements
 * against the loaded standard library (falling back to a user-model qualified
 * name), materialising a {@link FeatureTyping} for each one bound.
 *
 * @returns the number of references newly resolved (FeatureTypings created).
 */
export function resolveTypeReferences(model: Model): number {
  let resolved = 0;

  model.transaction(() => {
    // Snapshot up front: `model.all()` is a copy, so FeatureTypings created
    // during the loop are not themselves revisited.
    for (const el of model.all()) {
      if (el.attrs.isLibrary === true) continue; // never touch library content

      // (1) Plain feature typing preserved as attrs.typeRef (PartUsage, PortUsage…).
      const typeRef = el.attrs.typeRef;
      if (typeof typeRef === 'string' && typeRef.trim() !== '') {
        if (!hasResolvedFeatureTyping(model, el)) {
          // ORDER IS THE CONTRACT (KerML v1.0 §8.2.3.5.4): resolve outward
          // through the referencing element's own namespaces FIRST, and fall
          // back to the bundled library only when nothing local answers to the
          // name. Searching the library first — as this did — made a forward
          // reference bind to whatever library element happened to share the
          // name or short name (`part e : B` bound to `SI::byte`), so the same
          // name resolved differently depending on where it was written.
          const target =
            resolveTypeInScopeChain(model, typeRef, el.ownerId, el.id) ??
            findLibraryType(model, typeRef) ??
            model.resolveQualifiedName(typeRef);
          if (target && target.id !== el.id) {
            addFeatureTyping(model, el.id, target.id);
            clearAttr(model, el.id, 'typeRef');
            resolved++;
            continue;
          }
        } else {
          // Already typed by a real type — the textual ref is redundant.
          clearAttr(model, el.id, 'typeRef');
        }
      }

      // (2) Attribute typing preserved as an attrs.type string naming a
      //     ScalarValues type. Keep the display string; add the semantic link.
      if (el.eClass === 'AttributeUsage') {
        const type = el.attrs.type;
        if (typeof type === 'string' && type.trim() !== '' && !hasResolvedFeatureTyping(model, el)) {
          const target = findLibraryType(model, type);
          if (target && isScalarValueType(model, target)) {
            addFeatureTyping(model, el.id, target.id);
            resolved++;
          }
        }
      }
    }
  });

  return resolved;
}

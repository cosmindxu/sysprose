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
  findLibraryType,
  isRelationship,
  type ElementId,
  type ElementRecord,
} from '@core/index';
import {
  resolveFullName,
  resolveImportTargets as bindImportTargets,
} from '../semantics/bind';
import { resolveQualifiedNameFull } from '../semantics/resolve-names';

// `findLibraryType` lives in core (src/core/scope.ts) so that the semantics
// layer can use it without depending on this module — that dependency was a
// cycle waiting to happen once this module needed the full KerML resolver.
// Re-exported here for the callers and tests that always imported it from
// the library layer.
export { findLibraryType } from '@core/index';

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
/**
 * Is `el` something a feature may legally be typed by? Packages are namespaces,
 * not types; binding a feature to one yields a `feature-typing-non-type` error
 * further down the pipeline, so a candidate walk steps over them.
 */
function isTypeCandidate(el: ElementRecord): boolean {
  return !isRelationship(el.eClass) && el.eClass !== 'Package' && el.eClass !== 'LibraryPackage';
}

/**
 * The scope-chain resolution for one type name — KerML v1.0 §8.2.3.5.4 "full
 * resolution", implemented once in `src/semantics/bind.ts` and shared with the
 * textual mapper so a name cannot denote different elements in the two passes.
 *
 * All this layer adds is WHAT COUNTS AS AN ANSWER: the element itself is never
 * its own type (the mapper already self-binds `part Wheel : Wheel`), a Package
 * is a namespace rather than a type, and a library element surfacing through an
 * implicit base such as `Parts::Part` must not win over a user declaration one
 * scope further out — the library is the namespace of LAST resort, consulted by
 * {@link resolveTypeReferences} after this returns nothing.
 */
function resolveUserType(
  model: Model,
  name: string,
  scopeId: ElementId | null,
  excludeId: ElementId,
): ElementRecord | undefined {
  return resolveFullName(model, name, scopeId, {
    exclude: excludeId,
    accept: (hit) => hit.attrs.isLibrary !== true && isTypeCandidate(hit),
  });
}

/**
 * The library-side half of type resolution for ONE written name: the library's
 * own index first, then the genuine KerML walk from the roots.
 *
 * WHY BOTH, IN THIS ORDER. {@link findLibraryType} answers a bare name (`Real`),
 * a unit symbol (`m`) and a path the library strictly contains (`SI::metre`) off
 * an index, but it refuses a qualified path it does not contain rather than
 * guessing from the last segment. {@link resolveQualifiedNameFull} then walks
 * owned, inherited AND IMPORTED members at every hop, which is what still
 * resolves a member re-exported through a package import — `ISQ::MassValue`,
 * defined in `ISQBase`, or `AnalysisTooling::Real`, defined in `ScalarValues`.
 *
 * Factored out because BOTH branches of {@link resolveTypeReferences} need it
 * and only one of them used to have it: an `attribute a : AnalysisTooling::Real`
 * silently lost its typing while `item b : AnalysisTooling::Real` in the same
 * file kept it — one written path, two answers, decided by metaclass.
 */
function resolveLibraryTypeName(model: Model, name: string): ElementRecord | undefined {
  return findLibraryType(model, name) ?? resolveQualifiedNameFull(model, name);
}

/**
 * The element a feature's written type name denotes, by the full binder chain:
 * the user model first (the library is the namespace of LAST resort), then
 * {@link resolveLibraryTypeName}.
 *
 * Exported so a report that has to ask "what does this unfollowed type string
 * name?" (`src/api/analytics.ts`) asks the binder rather than re-deriving an
 * answer that could differ from the one the model was built with.
 */
export function resolveDeclaredTypeName(
  model: Model,
  name: string,
  scopeId: ElementId | null,
  excludeId: ElementId,
): ElementRecord | undefined {
  const query = name.trim();
  if (query === '') return undefined;
  return resolveUserType(model, query, scopeId, excludeId) ?? resolveLibraryTypeName(model, query);
}

/**
 * Give every import its `target` so `resolveName`'s import walk can see it —
 * the shared, library-free pass from `src/semantics/bind.ts` plus this layer's
 * namespace of last resort, so `import ISQ::*;` binds to bundled library
 * content the parse could not see.
 *
 * @returns the number of imports newly bound.
 */
export function resolveImportTargets(model: Model): number {
  return bindImportTargets(model, (name) => findLibraryType(model, name));
}

/** One binding the pure phase decided on; applied in the mutating phase. */
interface PendingBinding {
  elementId: ElementId;
  targetId: ElementId;
  clearTypeRef: boolean;
}

/**
 * Resolve every unresolved textual type reference on NON-library elements —
 * the element's own namespaces first (KerML §8.2.3.5.4), then the bundled
 * standard library, then a root-anchored qualified name — materialising a
 * {@link FeatureTyping} for each one bound.
 *
 * TWO PHASES, TO A FIXPOINT. `Model.emit` bumps `rev` on every mutation even
 * inside a transaction, and every resolver memo (name cache, generalization
 * closures, the ~38k-element library index) is keyed on `rev` — so binding one
 * reference used to cold-start every cache for the next. Phase 1 is pure reads
 * with hot caches; phase 2 applies. But a binding can ENABLE a resolution
 * (`part c : Car { part w : Wheel; }` — `w` resolves through `c`'s type only
 * once `c` is typed), so the pair loops until phase 1 finds nothing new. Bounded
 * by the number of unresolved references.
 *
 * @returns the number of references newly resolved (FeatureTypings created).
 */
export function resolveTypeReferences(model: Model): number {
  let resolved = 0;
  resolveImportTargets(model);

  for (;;) {
    // Phase 1 — decide, without mutating.
    const pending: PendingBinding[] = [];
    const redundant: ElementId[] = [];
    for (const el of model.all()) {
      if (el.attrs.isLibrary === true) continue; // never touch library content

      // (1) Plain feature typing preserved as attrs.typeRef (PartUsage, PortUsage…).
      const typeRef = el.attrs.typeRef;
      if (typeof typeRef === 'string' && typeRef.trim() !== '') {
        if (hasResolvedFeatureTyping(model, el)) {
          redundant.push(el.id); // already typed by a real type — the textual ref is redundant
          continue;
        }
        const target = resolveDeclaredTypeName(model, typeRef, el.ownerId, el.id);
        if (target && target.id !== el.id) {
          pending.push({ elementId: el.id, targetId: target.id, clearTypeRef: true });
        }
        continue;
      }

      // (2) Attribute typing preserved as an attrs.type string naming a
      //     ScalarValues type. Keep the display string; add the semantic link.
      if (el.eClass === 'AttributeUsage') {
        const type = el.attrs.type;
        if (typeof type === 'string' && type.trim() !== '' && !hasResolvedFeatureTyping(model, el)) {
          // The SAME library chain branch (1) uses. Ending on `findLibraryType`
          // alone made the metaclass decide whether a re-exported path such as
          // `AnalysisTooling::Real` was followed at all; the `isScalarValueType`
          // gate below — not the resolver — is what keeps attribute typings to
          // `ScalarValues` members.
          const target = resolveLibraryTypeName(model, type);
          if (target && isScalarValueType(model, target)) {
            pending.push({ elementId: el.id, targetId: target.id, clearTypeRef: false });
          }
        }
      }
    }

    if (pending.length === 0 && redundant.length === 0) break;

    // Phase 2 — apply.
    model.transaction(() => {
      for (const id of redundant) clearAttr(model, id, 'typeRef');
      for (const b of pending) {
        addFeatureTyping(model, b.elementId, b.targetId);
        if (b.clearTypeRef) clearAttr(model, b.elementId, 'typeRef');
        resolved++;
      }
    });
    if (pending.length === 0) break; // only redundancies were cleared; nothing new can resolve
  }

  return resolved;
}

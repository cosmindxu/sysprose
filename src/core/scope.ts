/**
 * KerML **full name resolution** over the owner chain.
 *
 * KerML v1.0 §8.2.3.5.4 ("Full Resolution"): resolving a simple name relative to
 * a Namespace considers memberships not only in that Namespace but in every
 * directly or indirectly containing Namespace, walking OUTWARD to the global
 * namespace. Declaration ORDER is irrelevant — resolution is over the finished
 * namespace, not the token stream — and there is no step anywhere in the spec
 * that prefers a library name over a user name.
 *
 * WHY THIS MODULE EXISTS. Two passes used to resolve type references and they
 * disagreed. The parser resolved a BACKWARD reference scope-aware and bound it
 * to the user's type; a FORWARD reference fell through to the library binder,
 * which searched the bundled standard library FIRST and had no notion of an
 * enclosing scope. The consequences were both a false error and, worse, a silent
 * mis-binding: in `package P { part e : B; part def B; }` the feature `e` bound
 * to the library element `SI::byte` (short name "B") rather than to `P::B`, so
 * the SAME name resolved to DIFFERENT types depending on where it was written.
 *
 * SCOPE OF THIS IMPLEMENTATION. It walks OWNED members outward through the owner
 * chain — the outer loop of KerML "full resolution". Inherited and imported
 * members are the per-namespace concern of `resolveName` in
 * `src/semantics/resolve-names.ts`; `resolveFullName` in
 * `src/semantics/bind.ts` composes the two: `resolveName` at each scope,
 * walking outward, then this owned-only walk, then the library. That
 * composition became possible once `findLibraryType` (below) moved here from
 * the library layer, removing the semantics→library edge that would otherwise
 * have made library→semantics a cycle.
 *
 * THE SPLIT IS CLOSED. The textual mapper used to resolve BACKWARD references
 * at parse time with its own owned-only walk, so a name declared both in a
 * supertype and in an outer scope bound to the OUTER one when written after its
 * declaration and to the INHERITED one when written before. `parseModel` now
 * defers every reference to a single resolution point that calls
 * `resolveFullName`, so declaration order no longer decides which element a
 * name denotes.
 */

import type { ElementId, ElementRecord } from './metamodel';
import { isRelationship } from './metamodel';
import type { Model } from './model';

/** Does this element answer to `name`, by declared name or short name? */
function named(el: ElementRecord, name: string): boolean {
  return el.declaredName === name || el.declaredShortName === name;
}

/**
 * Can `el` legally type a feature? A Package is a namespace, not a type, and
 * binding a feature to one produces a `feature-typing-non-type` error further
 * down the pipeline — so the walk steps over packages and keeps looking rather
 * than returning a match that is guaranteed to be rejected.
 */
function isTypeCandidate(el: ElementRecord): boolean {
  return !isRelationship(el.eClass) && el.eClass !== 'Package' && el.eClass !== 'LibraryPackage';
}

/**
 * Resolve a simple name against the owner chain of `scopeId`, innermost scope
 * first, ending at the root namespace.
 *
 * Only the USER model is searched (`attrs.isLibrary !== true`): the bundled
 * standard library is the global namespace of last resort and is looked up by
 * its own index afterwards, which keeps local declarations shadowing library
 * ones exactly as the spec requires.
 *
 * `excludeId` is the element doing the referencing, so a feature can never bind
 * to itself.
 */
export function resolveTypeInScopeChain(
  model: Model,
  name: string,
  scopeId: ElementId | null,
  excludeId?: ElementId,
): ElementRecord | undefined {
  const query = name.trim();
  if (query === '') return undefined;
  // A qualified name is not a simple-name lookup; `Model.resolveQualifiedName`
  // owns that case (and, for a library path, {@link findLibraryType} step 1).
  if (query.includes('::')) return undefined;

  const seen = new Set<ElementId>();
  let scope: ElementId | null = scopeId;

  // Walk outward: innermost scope, then each containing namespace.
  while (scope !== null && !seen.has(scope)) {
    seen.add(scope);
    const hit = model
      .children(scope)
      .find(
        (c) =>
          c.id !== excludeId &&
          c.attrs.isLibrary !== true &&
          isTypeCandidate(c) &&
          named(c, query),
      );
    if (hit) return hit;
    scope = model.get(scope)?.ownerId ?? null;
  }

  // Finally the root namespace — user roots only; the library is searched by
  // the caller afterwards.
  return model
    .roots()
    .find(
      (r) =>
        r.id !== excludeId && r.attrs.isLibrary !== true && isTypeCandidate(r) && named(r, query),
    );
}

/* ─────────────────── library lookup (moved here from src/library/resolve.ts) ─────────────────── */

/**
 * Resolve `name` against the loaded standard-library elements (those carrying
 * `attrs.isLibrary === true`).
 *
 * Resolution order:
 *  1. exact fully-qualified name by strict containment FROM THE LIBRARY ROOTS
 *     (e.g. `ScalarValues::Real`, `SI::metre`, `Collections::List`,
 *     `Base::Anything`);
 *  2. failing that — and ONLY for an UNQUALIFIED name — that name matched
 *     against a library element's `declaredName` or `declaredShortName` (a bare
 *     `Real`, the unit symbol `m`).
 *
 * WHY STEP 1 SEEDS FROM THE LIBRARY ROOTS. It used to call
 * {@link Model.resolveQualifiedName}, which starts at ALL roots and takes the
 * FIRST one answering to the leading segment, with no backtracking. A user file
 * that opens `package Parts { … }` therefore captured `Parts::Part` — the
 * implicit base every PartDefinition and PartUsage specializes
 * (`IMPLICIT_BASE_TYPE`, src/semantics/featuring.ts) — and the whole model
 * silently lost its library bases: no `Parts::Part`, so no `Items::Item`, no
 * `Occurrences::Occurrence`, and inherited library members such as `timeSlices`
 * stopped resolving. The library and the user model are different namespaces of
 * last resort; this one searches only its own.
 *
 * WHY STEP 2 REFUSES A QUALIFIED NAME. It used to match the LAST `::`-segment
 * of any query, throwing the qualifier away. Every dangling path whose final
 * segment happened to collide with a library name therefore resolved to a
 * stranger — `part wheel : NoSuchPkg::B` bound to `SI::byte`,
 * `part gear : Totally::Bogus::Path::m` to `SI::metre` — and `npm run check`
 * reported the file clean. A silent wrong answer is worse than a loud failure,
 * and nothing here can tell whether a qualifier the library does not contain
 * was a typo or fiction, so it declines to guess. The one name that justified
 * the leniency, a member re-exported through a package import such as
 * `ISQ::MassValue` (defined in `ISQBase`), is answered by the GENUINE KerML
 * import walk in `resolveQualifiedNameFull` — the converted library carries the
 * `Import` relationships that walk needs — so the qualified half of the safety
 * net bought nothing it did not also break.
 *
 * Step 1 is a roots→children walk rather than a scan that stringifies every
 * library element, so it stays fast even against the full library (tens of
 * thousands of elements).
 *
 * @returns the matching {@link ElementRecord}, or `undefined` when none matches.
 */
export function findLibraryType(model: Model, name: string): ElementRecord | undefined {
  const query = name.trim();
  if (query === '') return undefined;
  // No library merged yet ⇒ nothing to find. Worth its own line because this
  // runs for every unresolved reference during a PARSE, where the answer is
  // always "no" and both steps below are whole-model work (step 1 walks the
  // root set; the name index rebuilds on every revision, and the mapper bumps
  // the revision per element it creates).
  if (!model.hasLibrary) return undefined;

  // 1. Exact qualified-name match by strict containment from the LIBRARY roots
  //    (fast, and unshadowable by a user package of the same name).
  const exact = resolveLibraryPath(model, query);
  if (exact) return exact;

  // 2. Simple-name match on declaredName / declaredShortName among library
  //    elements (bare names and unit symbols). A QUALIFIED name that step 1
  //    could not find is NOT retried here: matching its last segment alone
  //    answered a written path with an element that path does not name (see the
  //    doc comment). Backed by a per-revision index so this is O(1) instead of
  //    an O(n) scan over the full ~38k-element library on every unresolved
  //    reference.
  if (query.includes('::')) return undefined;
  return libraryNameIndex(model).get(query);
}

/**
 * Walk `A::B::C` segment by segment through OWNED members, seeded from the
 * library roots only, and answer only with a library element.
 *
 * Deliberately not {@link Model.resolveQualifiedName}: that one seeds from every
 * root, so a user `package Parts` shadows the library `Parts` for the whole
 * path and the walk cannot back out of it (see the doc comment above).
 */
function resolveLibraryPath(model: Model, query: string): ElementRecord | undefined {
  const segs = query
    .split('::')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length === 0) return undefined;
  let candidates = model.roots().filter((r) => r.attrs.isLibrary === true);
  let found: ElementRecord | undefined;
  for (const seg of segs) {
    found = candidates.find((el) => named(el, seg));
    if (!found) return undefined;
    candidates = model.children(found.id);
  }
  return found && found.attrs.isLibrary === true ? found : undefined;
}

/** rev-keyed cache of {simple name → first matching library element}. */
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

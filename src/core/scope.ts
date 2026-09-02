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
 * SCOPE OF THIS IMPLEMENTATION. It walks owned members outward through the owner
 * chain. It deliberately does NOT follow inherited or imported members — those
 * need the generalization and import machinery in `src/semantics/resolve-names.ts`,
 * which cannot be imported here without a dependency cycle (that module already
 * depends on the library layer). A type reference reachable only through an
 * `import` or through inheritance therefore still does not resolve; that gap is
 * recorded in `docs/AGENT-AUTHORING-CAMPAIGN.md`.
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
  // and the library index own that case.
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

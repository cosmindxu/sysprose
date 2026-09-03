/**
 * THE reference resolver — KerML full name resolution, library-free.
 *
 * WHY THIS MODULE EXISTS. Reference binding used to be split across two
 * resolvers with different scoping rules. The textual mapper resolved BACKWARD
 * references at parse time with an owned-only scope walk that never consulted
 * inherited or imported members and never dereferenced an alias; the library
 * binder resolved the FORWARD ones afterwards with the spec's rule (per scope:
 * owned → inherited → imported, then outward). Whichever ran first won, so
 * `part w : W` inside `part def Car :> Base` denoted the OUTER `P::W` when `W`
 * was declared earlier in the file and the INHERITED `P::Base::W` when it was
 * declared later — the same text, two meanings, chosen by declaration order.
 * The spec (KerML v1.0 §8.2.3.5.3/§8.2.3.5.4) is explicit that resolution is
 * over the finished namespace, so the inherited answer is the right one in both
 * orders. This module is the single rule both callers now use.
 *
 * LIBRARY-FREE ON PURPOSE. It imports no library data module, so the mapper can
 * call it inside `parseModel` without dragging the multi-MB standard-library
 * bundle onto the parse path — and `--no-library` checking resolves everything
 * that does not genuinely need the library. The library layer
 * (`src/library/resolve.ts`) composes on top by adding its own last-resort
 * lookup.
 *
 * WHAT "FULL RESOLUTION" MEANS HERE (§8.2.3.5.4), in order:
 *  1. per namespace, from the referencing scope OUTWARD, the local resolution
 *     of the first segment — owned + alias, then inherited, then imported
 *     members (`resolveName`). A hit the caller REJECTS does not stop the walk:
 *     the answer may be one scope further out;
 *  2. root-level imports, which no enclosing namespace covers;
 *  3. an owned-containment descent from each scope — the pre-existing walk,
 *     kept because it reaches things §8.2.3.5.4 does not: a relationship
 *     element named as a reference (`flow f;` then `satisfy R by f;`) is not a
 *     Namespace member at all, yet the notation lets you name it;
 *  4. a root-anchored qualified name.
 *
 * Steps 3–4 are FALLBACKS, never overrides: they run only when the spec walk
 * found nothing acceptable, so nothing that resolved before this module existed
 * stopped resolving, and nothing they reach can shadow a spec-correct answer.
 */

import {
  isRelationship,
  refSegments,
  type ElementId,
  type ElementRecord,
  type Model,
} from '@core/index';
import { generalizationsWithImplicit } from './featuring';
import { resolveName } from './resolve-names';

/** Options for {@link resolveFullName}. */
export interface ResolveFullNameOptions {
  /**
   * The element doing the referencing. It can never be its own answer, which is
   * what keeps `part w :>> w` from redefining itself.
   */
  exclude?: ElementId;
  /**
   * Is this element an acceptable answer? Applied to the FINAL element only —
   * an intermediate segment is a namespace being walked through, not the
   * denoted element, so `Q::Later` resolves even though a caller that only
   * accepts types would reject the package `Q` on its own.
   *
   * A rejected candidate does not end the search: the walk continues outward,
   * exactly as it would had the name not matched at all.
   */
  accept?: (el: ElementRecord) => boolean;
}

/** Does this element answer to `seg`, by declared name or short name? */
function named(el: ElementRecord, seg: string): boolean {
  return el.declaredName === seg || el.declaredShortName === seg;
}

/** Enclosing-scope chain (innermost → outermost → the `null` root scope). */
function scopeChain(model: Model, scopeId: ElementId | null): Array<ElementId | null> {
  const scopes: Array<ElementId | null> = [];
  let cur: ElementId | null = scopeId;
  const guard = new Set<ElementId>();
  while (cur != null && !guard.has(cur)) {
    scopes.push(cur);
    guard.add(cur);
    cur = model.get(cur)?.ownerId ?? null;
  }
  scopes.push(null);
  return scopes;
}

/**
 * Walk the segments AFTER the first, from a resolved anchor. Each segment is
 * looked up by the same scoping rules (so `Pkg::Nested::x` sees inherited and
 * imported members at every hop), falling back to plain containment for the
 * elements `resolveName` does not enumerate.
 */
function descendFrom(
  model: Model,
  anchor: ElementRecord,
  rest: readonly string[],
): ElementRecord | undefined {
  let cur: ElementRecord | undefined = anchor;
  for (const seg of rest) {
    if (!cur) return undefined;
    cur = resolveName(model, cur.id, seg) ?? model.children(cur.id).find((c) => named(c, seg));
  }
  return cur;
}

/** Owned-containment descent through `segs` starting at one scope. */
function descendMatchIn(
  model: Model,
  segs: readonly string[],
  scope: ElementId | null,
): ElementRecord | undefined {
  let candidates = scope === null ? model.roots() : model.children(scope);
  let found: ElementRecord | undefined;
  for (const seg of segs) {
    found = candidates.find((e) => named(e, seg));
    if (!found) return undefined;
    candidates = model.children(found.id);
  }
  return found;
}

/**
 * Resolve a (possibly qualified or dotted) reference written in `scopeId`,
 * following KerML full resolution. Returns the denoted element, or `undefined`.
 *
 * `ref` is the source spelling: `::` and `.` both separate segments and a
 * quoted segment stays whole (`'a.b'::c`), per {@link refSegments}.
 */
export function resolveFullName(
  model: Model,
  ref: string,
  scopeId: ElementId | null,
  opts: ResolveFullNameOptions = {},
): ElementRecord | undefined {
  const segs = refSegments(ref);
  if (segs.length === 0) return undefined;
  const head = segs[0];
  const rest = segs.slice(1);
  const accept = opts.accept;
  const exclude = opts.exclude;
  const ok = (el: ElementRecord | undefined): ElementRecord | undefined =>
    el && el.id !== exclude && (accept === undefined || accept(el)) ? el : undefined;
  const fromAnchor = (anchor: ElementRecord | undefined): ElementRecord | undefined =>
    anchor === undefined
      ? undefined
      : ok(rest.length === 0 ? anchor : descendFrom(model, anchor, rest));

  const scopes = scopeChain(model, scopeId);

  // (1) Local resolution at each namespace, walking outward.
  for (const scope of scopes) {
    const hit = fromAnchor(resolveName(model, scope, head));
    if (hit) return hit;
  }

  // (2) Root-level imports — `resolveName(model, null, …)` cannot see them,
  //     because the root "namespace" is a set of roots, not an element.
  for (const root of model.roots()) {
    if (root.eClass !== 'NamespaceImport' && root.eClass !== 'MembershipImport') continue;
    const nsId = (root.target ?? [])[0];
    if (!nsId) continue;
    const hit = fromAnchor(resolveName(model, nsId, head));
    if (hit) return hit;
  }

  // (3) Owned-containment descent — reaches named relationship elements and
  //     anything else that is not a Namespace member.
  for (const scope of scopes) {
    const hit = ok(descendMatchIn(model, segs, scope));
    if (hit) return hit;
  }

  // (4) A fully-qualified name anchored at the roots.
  return ok(model.resolveQualifiedName(segs.join('::')));
}

/**
 * Resolve the feature a Redefinition redefines — KerML §8.2.3.5.1, which gives
 * `:>>` its OWN rule rather than plain full resolution: "the basic name
 * resolution process is repeated with the general Type of each ownedSpecialization
 * of the owningType considered in turn as the local Namespace".
 *
 * WHY IT CANNOT BE ORDINARY RESOLUTION. `part def Car :> Base { part w :>> w; }`
 * is the canonical redefinition, and ordinary resolution answers it with the
 * redefining feature itself; excluding that, with an outer `w` if one exists.
 * Both are wrong — the whole point of the declaration is the INHERITED `w`. So
 * the generals of the owning type are asked first, nearest first, and only then
 * does this fall back to {@link resolveFullName}, which is what still resolves a
 * qualified `:>> Other::w` or a redefinition written at package level.
 *
 * The redefining feature is excluded throughout, so a redefinition can never be
 * its own target.
 */
export function resolveRedefinedFeature(
  model: Model,
  ref: string,
  featureId: ElementId,
  scopeId: ElementId | null,
): ElementRecord | undefined {
  const segs = refSegments(ref);
  if (segs.length === 0) return undefined;
  const head = segs[0];
  const rest = segs.slice(1);
  const owningType = model.get(featureId)?.ownerId ?? null;

  if (owningType !== null) {
    // Explicit generals first — including the FeatureTyping targets of a usage
    // owner, so `part c : Engine { part p :>> port1; }` finds Engine's feature —
    // then the full closure (transitive generals + implicit library bases).
    const seen = new Set<ElementId>();
    const ordered = [...model.typesOf(owningType), ...generalizationsWithImplicit(model, owningType)];
    for (const general of ordered) {
      if (seen.has(general.id)) continue;
      seen.add(general.id);
      const anchor = resolveName(model, general.id, head);
      if (!anchor) continue;
      const hit = rest.length === 0 ? anchor : descendFrom(model, anchor, rest);
      if (hit && hit.id !== featureId) return hit;
    }
  }

  return resolveFullName(model, ref, scopeId, { exclude: featureId });
}

/**
 * Give every import its `target` (and `source`) so `resolveName`'s import walk
 * can see it.
 *
 * The textual mapper creates `NamespaceImport`/`MembershipImport` elements with
 * only `attrs.importedName`, because at parse time the imported namespace may be
 * declared later in the file or live in a standard library that is not loaded
 * yet. Without a target every import was a no-op for name resolution on any
 * parsed model — `import Lib::*;` bound nothing, silently. Idempotent: an
 * import that already has a target is left alone.
 *
 * `fallback` is the caller's namespace of last resort (the library layer passes
 * `findLibraryType`); this module has none of its own, which is what keeps it
 * usable from inside a parse.
 *
 * @returns the number of imports newly bound.
 */
export function resolveImportTargets(
  model: Model,
  fallback?: (name: string) => ElementRecord | undefined,
): number {
  let bound = 0;
  model.transaction(() => {
    for (const el of model.all()) {
      if (el.attrs.isLibrary === true) continue;
      if (el.eClass !== 'NamespaceImport' && el.eClass !== 'MembershipImport') continue;
      if ((el.target ?? []).length > 0) continue;
      const raw = el.attrs.importedName;
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      const recursive = /::\*\*\s*$/.test(raw);
      const name = raw.replace(/::\*+\s*$/, '').trim();
      if (name === '') continue;
      // An import names a NAMESPACE — a package is the usual answer, so the
      // type-candidate filter the typing resolver uses would reject exactly the
      // right hit. Only relationships are excluded.
      const target =
        resolveFullName(model, name, el.ownerId, {
          exclude: el.id,
          accept: (hit) => !isRelationship(hit.eClass),
        }) ??
        model.resolveQualifiedName(name) ??
        fallback?.(name);
      if (!target || target.id === el.id) continue;
      model.update(el.id, {
        target: [target.id],
        ...(el.ownerId !== null && (el.source ?? []).length === 0 ? { source: [el.ownerId] } : {}),
      });
      if (recursive) model.setAttrs(el.id, { isRecursive: true });
      bound++;
    }
  });
  return bound;
}

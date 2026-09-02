/**
 * KerML **name resolution** over a {@link Model}.
 *
 * Implements the OMG KerML scoping rules for resolving a (possibly qualified)
 * name to the element it denotes, following — in priority order — the three
 * sources of members a Namespace exposes:
 *
 *  1. **Owned members** — elements directly contained by the scope (in this
 *     denormalised metamodel, its non-relationship children), plus *alias*
 *     memberships (a `Membership` relationship carrying `attrs.memberName`,
 *     re-exposing another element under a new name — the KerML `as` alias).
 *  2. **Inherited members** — the (public) owned members of every general type
 *     in {@link generalizationsWithImplicit}, so a Usage sees the features it
 *     inherits from its types and from the implicit standard-library base.
 *  3. **Imported members** — members brought in by the scope's `Import`
 *     relationships: a {@link NamespaceImport} (`::*`, or recursive `::**` when
 *     `attrs.isRecursive`) exposes the imported namespace's *public* members
 *     (recursively re-exporting that namespace's own public imports), and a
 *     {@link MembershipImport} exposes a single named element.
 *
 * Visibility is honoured: a scope sees its own members regardless of
 * visibility, but only *public* members (`attrs.visibility !== 'private'`) are
 * visible through inheritance or across an import boundary.
 *
 * Two entry points are exposed:
 *  - {@link resolveName} — resolve a simple (or, for convenience, qualified)
 *    name in a given scope (or the global root scope when `scopeId` is `null`).
 *  - {@link resolveQualifiedNameFull} — resolve a `A::B::C` qualified name by
 *    walking segment-by-segment through the scoping rules above.
 *
 * BUNDLED-LIBRARY NOTE: as of F2 the converted standard library
 * (`src/library/std/stdlib.json`) DOES carry the KerML `Import`/`Membership`
 * relationship elements (`NamespaceImport`/`MembershipImport`/alias `Membership`)
 * from the upstream `.kerml` sources. A qualified name such as `ISQ::MassValue` —
 * where `ISQ` publicly imports `ISQBase`, which owns `MassValue` — therefore
 * resolves by the genuine KerML import walk (the same walk used for user models).
 * {@link resolveQualifiedNameFull} additionally retains a library-wide lookup
 * ({@link findLibraryType}) purely as a safety net for any import target that
 * fails to dereference.
 *
 * Both entry points are memoised per {@link Model} and cycle-safe; the walks are
 * bounded (owned children are indexed, generalization closures are memoised and
 * short, and import traversal guards against re-visiting a namespace), so they
 * never explode over the ~38k-element standard library.
 *
 * Spec references: docs/02-omg-standard-reference.md (KerML Namespaces,
 * Memberships, Imports & name resolution).
 */

import { type ElementId, type ElementRecord, type Model, isRelationship } from '@core/index';
import { findLibraryType } from '../library/resolve';
import { generalizationsWithImplicit } from './featuring';

/* ─────────────────────────── memoisation caches ─────────────────────────── */

type NameCache = Map<string, ElementRecord | undefined>;
/** Cache holds the model revision it was computed at, so a mutation invalidates it. */
interface RevCache {
  rev: number;
  map: NameCache;
}
const nameCache = new WeakMap<Model, RevCache>();
const qnameCache = new WeakMap<Model, RevCache>();

const cacheFor = (store: WeakMap<Model, RevCache>, model: Model): NameCache => {
  let c = store.get(model);
  if (!c || c.rev !== model.rev) {
    // Stale (or absent): a rename/reparent/retype since last use would make the
    // memoised name→element results wrong. Rebuild at the current revision.
    c = { rev: model.rev, map: new Map() };
    store.set(model, c);
  }
  return c.map;
};

/* ───────────────────────────── visibility helpers ───────────────────────── */

/** A member is public unless it explicitly declares `attrs.visibility === 'private'`. */
function isPublic(el: ElementRecord): boolean {
  return el.attrs.visibility !== 'private';
}

/** Does an element expose `name` as its (own) declared or short name? */
function matchesOwnName(el: ElementRecord, name: string): boolean {
  return el.declaredName === name || el.declaredShortName === name;
}

/**
 * The alias name a `Membership`/`MembershipImport` relationship exposes, if any
 * (the KerML `member as alias` form). Stored on `attrs.memberName`.
 */
function aliasNameOf(rel: ElementRecord): string | undefined {
  const n = rel.attrs.memberName;
  return typeof n === 'string' && n !== '' ? n : undefined;
}

/* ───────────────────────────── member enumeration ───────────────────────── */

/**
 * Resolve `name` among the OWNED members of `scopeId` (its non-relationship
 * children, plus alias `Membership` children). When `publicOnly` is set, private
 * members are skipped (used when looking across an inheritance/import boundary).
 * A `null` scope searches the model's root elements (the global namespace).
 */
function resolveOwned(
  model: Model,
  scopeId: ElementId | null,
  name: string,
  publicOnly: boolean,
): ElementRecord | undefined {
  const children = scopeId === null ? model.roots() : model.children(scopeId);
  // First pass: direct (owned) members by their own name.
  for (const child of children) {
    if (isRelationship(child.eClass)) continue;
    if (publicOnly && !isPublic(child)) continue;
    if (matchesOwnName(child, name)) return child;
  }
  // Second pass: alias memberships (a Membership relationship re-exposing an
  // element under `attrs.memberName`).
  for (const child of children) {
    if (child.eClass !== 'Membership') continue;
    if (publicOnly && !isPublic(child)) continue;
    if (aliasNameOf(child) !== name) continue;
    const targetId = (child.target ?? [])[0];
    const target = targetId ? model.get(targetId) : undefined;
    if (target) return target;
  }
  return undefined;
}

/**
 * Resolve `name` among the members INHERITED by `scopeId` — the public owned
 * members of each of its general types (explicit generals + implicit library
 * base). Cycle-safe via {@link generalizationsWithImplicit} (itself memoised).
 */
function resolveInherited(
  model: Model,
  scopeId: ElementId,
  name: string,
): ElementRecord | undefined {
  for (const general of generalizationsWithImplicit(model, scopeId)) {
    const hit = resolveOwned(model, general.id, name, /* publicOnly */ true);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Resolve `name` as seen when IMPORTING namespace `nsId` — i.e. among its
 * *public* members. This includes the namespace's public owned + inherited
 * members and, transitively, the members re-exported by its own public
 * namespace imports (and, when `recursive`, its public owned sub-namespaces).
 * `visited` guards against import cycles.
 */
function resolveImportedFrom(
  model: Model,
  nsId: ElementId,
  name: string,
  recursive: boolean,
  visited: Set<ElementId>,
): ElementRecord | undefined {
  if (visited.has(nsId)) return undefined;
  visited.add(nsId);

  // Public owned + inherited members of the imported namespace.
  const owned = resolveOwned(model, nsId, name, /* publicOnly */ true);
  if (owned) return owned;
  const inherited = resolveInherited(model, nsId, name);
  if (inherited) return inherited;

  // Re-exported public imports of the imported namespace, and (when recursive)
  // its public owned sub-namespaces.
  const reexport = resolveViaImports(model, nsId, name, visited, /* publicOnly */ true);
  if (reexport) return reexport;

  if (recursive) {
    for (const child of model.children(nsId)) {
      if (isRelationship(child.eClass) || !isPublic(child)) continue;
      const hit = resolveImportedFrom(model, child.id, name, true, visited);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Resolve `name` through the `Import` relationships declared by `scopeId`.
 * `NamespaceImport` targets are followed into the imported namespace's public
 * members; `MembershipImport` targets expose a single (optionally aliased)
 * element. When `publicOnly` is set (re-export context), only public imports of
 * the scope contribute.
 */
function resolveViaImports(
  model: Model,
  scopeId: ElementId,
  name: string,
  visited: Set<ElementId>,
  publicOnly: boolean,
): ElementRecord | undefined {
  for (const rel of model.children(scopeId)) {
    if (publicOnly && !isPublic(rel)) continue;

    if (rel.eClass === 'NamespaceImport') {
      const nsId = (rel.target ?? [])[0];
      if (!nsId) continue;
      const recursive = rel.attrs.isRecursive === true;
      const hit = resolveImportedFrom(model, nsId, name, recursive, visited);
      if (hit) return hit;
    } else if (rel.eClass === 'MembershipImport' || rel.eClass === 'Expose') {
      const targetId = (rel.target ?? [])[0];
      const target = targetId ? model.get(targetId) : undefined;
      if (!target) continue;
      const exposedName = aliasNameOf(rel) ?? target.declaredName ?? target.declaredShortName;
      if (exposedName === name) return target;
    }
  }
  return undefined;
}

/* ─────────────────────────────── public API ─────────────────────────────── */

/**
 * Resolve a name in a scope following the KerML scoping rules (owned, then
 * inherited, then imported members). `scopeId === null` resolves against the
 * global root namespace. `name` is normally a simple identifier; a qualified
 * `A::B` name is also accepted and resolved segment-by-segment starting from the
 * given scope. Returns the denoted {@link ElementRecord}, or `undefined`.
 *
 * Memoised per model; cycle-safe.
 */
export function resolveName(
  model: Model,
  scopeId: ElementId | null,
  name: string,
): ElementRecord | undefined {
  const query = name.trim();
  if (query === '') return undefined;

  // Convenience: a qualified name is walked segment-by-segment from this scope.
  if (query.includes('::')) {
    const segs = query.split('::').map((s) => s.trim()).filter(Boolean);
    if (segs.length === 0) return undefined;
    let cur: ElementRecord | undefined = resolveName(model, scopeId, segs[0]);
    for (let i = 1; i < segs.length && cur; i++) cur = resolveName(model, cur.id, segs[i]);
    return cur;
  }

  const cache = cacheFor(nameCache, model);
  const key = `${scopeId ?? ' root'} ${query}`;
  if (cache.has(key)) return cache.get(key);
  // Guard re-entrancy (a scope reachable from its own imports) by seeding the
  // cache with `undefined` before recursing.
  cache.set(key, undefined);

  let result: ElementRecord | undefined = resolveOwned(model, scopeId, query, /* publicOnly */ false);
  if (!result && scopeId !== null) result = resolveInherited(model, scopeId, query);
  if (!result && scopeId !== null) {
    result = resolveViaImports(model, scopeId, query, new Set<ElementId>(), /* publicOnly */ false);
  }

  cache.set(key, result);
  return result;
}

/**
 * Resolve a fully-qualified `A::B::C` name by walking the KerML scoping rules
 * segment-by-segment: the first segment is resolved in the global root scope,
 * each subsequent segment in the scope of the previously resolved element.
 *
 * When the scoped walk fails AND the name refers to bundled-library content
 * whose `Import` relationships were stripped during conversion (see the module
 * note), this falls back to a library-wide lookup so names like `ISQ::MassValue`
 * still resolve. Returns `undefined` when nothing matches.
 *
 * Memoised per model; cycle-safe.
 */
export function resolveQualifiedNameFull(
  model: Model,
  qname: string,
): ElementRecord | undefined {
  const query = qname.trim();
  if (query === '') return undefined;

  const cache = cacheFor(qnameCache, model);
  if (cache.has(query)) return cache.get(query);

  const segs = query.split('::').map((s) => s.trim()).filter(Boolean);
  let cur: ElementRecord | undefined;
  if (segs.length > 0) {
    cur = resolveName(model, null, segs[0]);
    for (let i = 1; i < segs.length && cur; i++) cur = resolveName(model, cur.id, segs[i]);
  }

  // Fallback for import-stripped library content (and bare/short names).
  const result = cur ?? findLibraryType(model, query);
  cache.set(query, result);
  return result;
}

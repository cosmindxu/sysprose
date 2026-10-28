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
import { redefinedBy, redefinedClosure } from './inheritance';
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
 *
 * A simple name lands on the MOST SPECIFIC feature the owning type inherits
 * for it ({@link mostSpecificRedefining}): in `part s : Q2 { attribute :>> M;
 * }`, `M` finds Q's declared `M` by name, but Q2's unnamed `attribute :>> M
 * default = 2.0` redefines it and is Q2's `M` (KerML's effective name) — a
 * redefinition of Q's `M` read Q's 1 in s, so `s.M == 2.0` was refuted on
 * every surface. The implicit end copy of a usage-body binding takes the same
 * feature (`resolveChainEnd` in the text mapper, U10).
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
      // A qualified or dotted name (`:>> Q::M`) says which feature it means.
      const hit =
        rest.length === 0 ? mostSpecificRedefining(model, ordered, anchor, featureId) : descendFrom(model, anchor, rest);
      if (hit && hit.id !== featureId) return hit;
    }
  }

  return resolveFullName(model, ref, scopeId, { exclude: featureId });
}

/**
 * The feature that stands for `anchor` in a type whose general types are
 * `generals`: the one most specific among `anchor` and the features of those
 * types that redefine it, transitively — the rule the text mapper's
 * `findTypeFeature` gives the implicit end copy (U10). Name resolution matches
 * declared names only, so it finds Q's `M` past `attribute :>> M default =
 * 2.0` in `part def Q2 :> Q`, which KerML calls `M` and which hides Q's from
 * everything Q2 types. A redefinition under another name is taken too:
 * `attribute M2 redefines M` is what a Q2 has for M (every surface reads `t.M`
 * as t's M2 in `part t : Q2`), so `attribute :>> M = 5.0` in a Q2 redefines
 * M2 and is known by its name — Save writes it `:>> M2` — and `v.M2` reads
 * that 5, where it read Q2's default beside it.
 *
 * Only the ONE most specific: where two general types each redefine it and
 * neither the other (`part q : Q2, Q3`, or `part def Q23 :> Q2, Q3`), neither
 * is, and `anchor` is kept, as the end copy keeps it (MI1, MI3). An `anchor`
 * the general types do not own (an imported one) is kept as found.
 *
 * `anchor` is kept too where the one most specific feature would make TWO
 * features one ({@link joinsTwo}): Q2's `attribute X :>> M, N` would take both
 * `:>> M = 1.0` and `:>> N = 2.0` of `part s : Q2`, and the SMT engine read
 * X's two values as inconsistent axioms beside a check that refuted `s.N ==
 * 2.0` (MU); `attribute :>> M = 5.0` would take the name M2 beside `attribute
 * M2 = 9.0` in the same `part v : R` (CL). Each keeps the feature its name
 * finds, as before, which every surface reads alike.
 */
function mostSpecificRedefining(
  model: Model,
  generals: readonly ElementRecord[],
  anchor: ElementRecord,
  featureId: ElementId,
): ElementRecord {
  const owners = new Set<ElementId>(generals.map((g) => g.id));
  if (anchor.ownerId === null || !owners.has(anchor.ownerId)) return anchor;
  // Walk the redefinitions back from `anchor` (the edge index), through the general types' features only.
  const hits: ElementRecord[] = [];
  const seen = new Set<ElementId>([anchor.id]);
  const queue: ElementRecord[] = [anchor];
  for (let i = 0; i < queue.length; i++) {
    const g = queue[i];
    for (const r of model.relationshipsTo(g.id)) {
      if (r.eClass !== 'Redefinition') continue;
      for (const id of r.source ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const f = model.get(id);
        if (!f || f.ownerId === null || !owners.has(f.ownerId)) continue;
        queue.push(f);
        hits.push(f);
      }
    }
  }
  if (hits.length === 0) return anchor;
  // A hit is the most specific when no other hit redefines it, through any number of redefinitions: asking each hit
  // for its redefiners stops at the first hit found, so a chain of depth D over one feature costs D, not D cubed, on
  // every `:>>` of a usage typed by its deepest general.
  const hitIds = new Set<ElementId>(hits.map((h) => h.id));
  const most = hits.filter((h) => {
    let redefined = false;
    redefinersOf(model, h.id, (x) => (redefined = hitIds.has(x)));
    return !redefined;
  });
  return most.length === 1 && !joinsTwo(model, anchor, most[0], featureId) ? most[0] : anchor;
}

/**
 * Every feature that redefines `id`, through any number of redefinitions — the reverse of `redefinedClosure`, over
 * the same edges. `stop` is asked about each as it is found and ends the walk early on `true`.
 */
function redefinersOf(model: Model, id: ElementId, stop?: (found: ElementId) => boolean): Set<ElementId> {
  const out = new Set<ElementId>();
  const queue: ElementId[] = [id];
  while (queue.length > 0) {
    const g = queue.pop()!;
    for (const r of model.relationshipsTo(g)) {
      if (r.eClass !== 'Redefinition') continue;
      for (const x of r.source ?? []) {
        if (x === id || out.has(x) || !model.get(x)) continue;
        out.add(x);
        if (stop?.(x)) return out;
        queue.push(x);
      }
    }
  }
  return out;
}

/**
 * Would redefining `hit`, the most specific feature for `anchor`, make two
 * features one? Either:
 *
 *  - `hit` MERGES: it also redefines a feature outside `anchor`'s line (Q2's
 *    `attribute X :>> M, N`, found from M, redefines N too), so a usage's
 *    `:>> M` and `:>> N` would both land on X; or
 *  - the redefining feature's owner already has a feature of that line: one
 *    declared under a name `hit` or what it redefines bears (`attribute M2 =
 *    9.0` beside `attribute :>> M = 5.0`, when `hit` is R's `M2 redefines M`),
 *    or one that redefines a feature of the line (`attribute :>> M2 = 9.0`
 *    there, or a second `:>> M`).
 *
 * Order-independent, so the mapper's rounds settle: an owner's other feature
 * is judged by its declared name and by what it redefines, and whatever it
 * redefines lies in the line either way. Implicit end copies are left out:
 * the mapper makes them after its rounds, so the serializer's re-parse test
 * must not see them either.
 */
function joinsTwo(model: Model, anchor: ElementRecord, hit: ElementRecord, featureId: ElementId): boolean {
  const above = redefinedClosure(model, hit);
  const anchorLine = new Set<ElementId>([anchor.id, ...redefinedClosure(model, anchor).map((g) => g.id)]);
  // A feature `hit` redefines is on the line when it is `anchor` or below it, or redefines `anchor` itself.
  const redefinersOfAnchor = redefinersOf(model, anchor.id);
  if (above.some((g) => !anchorLine.has(g.id) && !redefinersOfAnchor.has(g.id))) return true;
  const ownerId = model.get(featureId)?.ownerId ?? null;
  if (ownerId === null) return false;
  const line = new Set<ElementId>([hit.id, ...above.map((g) => g.id)]);
  const names = new Set<string>([hit, ...above].flatMap((g) => (g.declaredName !== undefined ? [g.declaredName] : [])));
  const redefinersOfHit = redefinersOf(model, hit.id);
  return model.children(ownerId).some(
    (sib) =>
      sib.id !== featureId &&
      sib.attrs.implicit !== true &&
      ((sib.declaredName !== undefined && names.has(sib.declaredName)) ||
        redefinedBy(model, sib).some((t) => line.has(t.id) || redefinersOfHit.has(t.id))),
  );
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

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
  isUsage,
  refSegments,
  type ElementId,
  type ElementRecord,
  type Model,
} from '@core/index';
import { generalizationsWithImplicit } from './featuring';
import { effectiveNameOf, mostSpecificOwned, ownFeatures, redefinedBy, redefinedClosure } from './inheritance';
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

  // An EXPLICIT `:>>` is read as the parse that made its file read it, and that parse never meets the implicit end
  // copies a definition-level `bind` makes (`part def Q3 :> Q2 { bind p.load = L; }` gives Q3 a valueless `L`): they
  // are no candidates for it, or one edit would land `part r1 : Q3 { attribute :>> L; }` on Q3's copy where the file
  // lands it on Q2's `:>> L`. An implicit end copy itself is placed by the editor's own rule (`endCopyProto`).
  const explicit = model.get(featureId)?.attrs.implicit !== true;
  if (owningType !== null) {
    // Explicit generals first — including the FeatureTyping targets of a usage
    // owner, so `part c : Engine { part p :>> port1; }` finds Engine's feature —
    // then the full closure (transitive generals + implicit library bases).
    const seen = new Set<ElementId>();
    const ordered = redefinitionGenerals(model, owningType);
    for (const general of ordered) {
      if (seen.has(general.id)) continue;
      seen.add(general.id);
      let anchor = resolveName(model, general.id, head);
      if (anchor && explicit && anchor.attrs.implicit === true) anchor = resolveWithoutCopies(model, general.id, head);
      if (!anchor) continue;
      // A qualified or dotted name (`:>> Q::M`) says which feature it means.
      const hit =
        rest.length === 0
          ? mostSpecificRedefining(model, ordered, anchor, featureId, explicit)
          : descendFrom(model, anchor, rest);
      if (hit && hit.id !== featureId && !(explicit && hit.attrs.implicit === true)) return hit;
    }
  }

  return resolveFullName(model, ref, scopeId, {
    exclude: featureId,
    ...(explicit ? { accept: (el: ElementRecord) => el.attrs.implicit !== true } : {}),
  });
}

/**
 * What `resolveName` finds for `head` in `general` when the implicit end copies are left out, as the parse meets it: the
 * first member named so that is no copy, in `general` and then in each type it specialises, nearest first. A copy the
 * name finds first is not the answer, nor the feature it redefines: a type further along the line may own one of the
 * name (`D2`'s new `N2`, past `D3`'s copy of `D1`'s, for a `D4 :> D3, D2`).
 */
function resolveWithoutCopies(model: Model, general: ElementId, head: string): ElementRecord | undefined {
  for (const g of [general, ...generalizationsWithImplicit(model, general).map((x) => x.id)]) {
    const hit = model.children(g).find((c) => !isRelationship(c.eClass) && c.attrs.implicit !== true && named(c, head) && (g === general || c.attrs.visibility !== 'private'));
    if (hit) return hit;
  }
  return undefined;
}

/** The types whose features `:>>` is read against in `owningType`: its explicit generals, then the full closure. */
function redefinitionGenerals(model: Model, owningType: ElementId): ElementRecord[] {
  return [...model.typesOf(owningType), ...generalizationsWithImplicit(model, owningType)];
}

/**
 * Does the owner of `featureId` hold another feature on `hit`'s line, or one that bears a name `hit` or what it
 * redefines bears? That is what makes {@link resolveRedefinedFeature} keep the base feature a name finds instead of
 * `hit` (a name two of the usage's features would bear, or one feature that two names would take): the part of
 * {@link joinsTwo} a feature's OWN name meets once the name is `hit`'s. With `among`, only those siblings count: the
 * editor asks it of the features an edit has just touched, to tell a collision the edit made (a sibling renamed
 * into `hit`'s name) from one the text was loaded with, which it leaves as written.
 */
export function sharesLineWithSibling(
  model: Model,
  hit: ElementRecord,
  featureId: ElementId,
  among?: ReadonlySet<ElementId>,
): boolean {
  const ownerId = model.get(featureId)?.ownerId ?? null;
  if (ownerId === null) return false;
  const owners = new Set<ElementId>(redefinitionGenerals(model, ownerId).map((g) => g.id));
  return joinsTwo(model, owners, hit, hit, featureId, among);
}

/**
 * The feature that stands for `anchor` in a type whose general types are
 * `generals`: the one most specific among `anchor` and the features of those
 * types that redefine it, transitively — the rule {@link findTypeFeature}
 * gives the implicit end copy the text mapper makes (U10). Name resolution matches
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
 * is, and `anchor` is kept, as the end copy keeps it (MI1, MI3) — unless one
 * of the features is owned by a type that specialises the owners of all the
 * others (`part def Q23 :> Q2, Q3 { attribute :>> M = 5.0; }`, whose own `M`
 * is what a Q23 has for M, as `t.M` reads it in `part t : Q23`): that one is
 * ({@link mostSpecificOwned}). An `anchor` the general types do not own (an
 * imported one) is kept as found.
 *
 * `anchor` is kept too where the one most specific feature would make TWO
 * features one ({@link joinsTwo}): Q2's `attribute X :>> M, N` would take both
 * `:>> M = 1.0` and `:>> N = 2.0` of `part s : Q2`, and the SMT engine read
 * X's two values as inconsistent axioms beside a check that refuted `s.N ==
 * 2.0` (MU); `attribute :>> M = 5.0` would take the name M2 beside `attribute
 * M2 = 9.0` in the same `part v : R` (CL), or beside a `:>> K` that takes the
 * name M2 as well in `part v : R, S`, or beside an M2 of S's own. Each keeps
 * the feature its name finds, as before, which every surface reads alike.
 *
 * With `explicit` (the redefining feature is one the text writes), the implicit end copies of a `bind` are no hit.
 */
function mostSpecificRedefining(
  model: Model,
  generals: readonly ElementRecord[],
  anchor: ElementRecord,
  featureId: ElementId,
  explicit = false,
): ElementRecord {
  const owners = new Set<ElementId>();
  for (const g of generals) owners.add(g.id);
  if (anchor.ownerId === null || !owners.has(anchor.ownerId)) return anchor;
  // Walk the redefinitions back from `anchor` (the edge index), through the general types' features only.
  const hits: ElementRecord[] = [];
  const seen = new Set<ElementId>([anchor.id]);
  const queue: ElementRecord[] = [anchor];
  for (let i = 0; i < queue.length; i++) {
    const g = queue[i];
    for (const id of redefinerIds(model, g.id)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const f = model.get(id);
      if (!f || f.ownerId === null || !owners.has(f.ownerId)) continue;
      // An explicit `:>>` meets no implicit end copy ({@link resolveRedefinedFeature}), nor a line through one.
      if (explicit && f.attrs.implicit === true) continue;
      queue.push(f);
      hits.push(f);
    }
  }
  if (hits.length === 0) return anchor;
  // A hit is the most specific when no other hit redefines it, through any number of redefinitions: asking each hit
  // for its redefiners stops at the first hit found, so a chain of depth D over one feature costs D, not D cubed, on
  // every `:>>` of a usage typed by its deepest general.
  const hitIds = new Set<ElementId>();
  for (const h of hits) hitIds.add(h.id);
  const most = hits.length === 1 ? hits : hits.filter((h) => !redefinedByOneOf(model, h.id, hitIds));
  const one = mostSpecificOwned(model, most);
  return one !== undefined && !joinsTwo(model, owners, anchor, one, featureId) ? one : anchor;
}

/**
 * {@link named}, or — for a feature that declares no name — whether it is
 * a redefinition of a feature named `seg` (KerML's effective name):
 * `attribute :>> load = 50.0` in `part p` is p's `load`. A connector or `bind`
 * end `p.load` then lands on that explicit redefinition, not on an implicit
 * copy materialised beside it — a second, valueless `p::load` the binding held
 * while every scope read the redefinition.
 */
function memberNamed(model: Model, e: ElementRecord, seg: string): boolean {
  if (named(e, seg)) return true;
  return e.declaredName === undefined && e.declaredShortName === undefined && effectiveNameOf(model, e) === seg;
}

/**
 * The child of `ownerId` a chain segment `seg` names: one {@link memberNamed}
 * `seg`, else one that REDEFINES a feature named `seg` under another name —
 * `attribute heavy redefines load = 50.0` is p's `load` too, as the feature it
 * redefines is no member of p beside it. Read as no child, `bind w = p.load`
 * materialised an implicit, valueless `p::load` next to `heavy`, and the
 * binding held the copy while every scope read `heavy`'s 50.
 */
export function childNamed(model: Model, ownerId: ElementId, seg: string): ElementRecord | undefined {
  const kids = model.children(ownerId);
  return (
    kids.find((e) => memberNamed(model, e, seg)) ??
    kids.find((e) => !isRelationship(e.eClass) && redefinedClosure(model, e).some((g) => named(g, seg)))
  );
}

/**
 * Transitive specialization closure of `el`: every element reachable through
 * resolved specialization relationships (FeatureTyping / Subsetting /
 * Redefinition / Subclassification) plus still-textual `attrs.typeRef` strings
 * (resolved in-model, read-only — this never binds a typeRef; that stays
 * `resolveTypeReferences`' job). Cycle-safe (A :> B :> A terminates).
 */
function typeClosure(model: Model, el: ElementRecord): ElementRecord[] {
  const out: ElementRecord[] = [];
  const seen = new Set<ElementId>([el.id]);
  const stack: ElementRecord[] = [el];
  while (stack.length) {
    const cur = stack.pop()!;
    const next: ElementRecord[] = [...model.typesOf(cur.id)];
    const typeRef = cur.attrs.typeRef;
    if (typeof typeRef === 'string') {
      const t = resolveFullName(model, typeRef, cur.ownerId, { exclude: cur.id });
      if (t) next.push(t);
    }
    for (const n of next) {
      if (!seen.has(n.id)) {
        seen.add(n.id);
        out.push(n);
        stack.push(n);
      }
    }
  }
  return out;
}

/**
 * Feature named `seg` inherited from `el`'s type closure (not a direct child)
 * — by its effective name ({@link childNamed}), and the most specific one: a
 * feature another type of the closure redefines is not inherited beside it.
 * `part def S :> P { attribute :>> load = 5.0; }` gives `s : S` S's load; the
 * walk took P's by declared name, and the implicit copy it materialised for
 * `bind w = s.load` redefined P's `load` — masking S's 5 in `s` itself.
 */
export function findTypeFeature(model: Model, el: ElementRecord, seg: string, unique = false): ElementRecord | undefined {
  const hits: ElementRecord[] = [];
  for (const t of typeClosure(model, el)) {
    const hit = childNamed(model, t.id, seg);
    if (hit && !hits.includes(hit)) hits.push(hit);
  }
  const most = hits.filter((h) => !hits.some((o) => o !== h && redefinedClosure(model, o).includes(h)));
  // `unique`: none where two types each redefine it and neither the other (Q2's and Q3's `:>> L`, both general to Q23)
  // — unless one is owned by a type below the others' owners (Q23's own `:>> L`, which a Q23 has for L).
  if (unique) return mostSpecificOwned(model, most);
  return most[0] ?? hits[0];
}

/**
 * The feature the implicit end copy of a usage-body binding redefines when the name `head` finds `hit` among the
 * features the usage `scopeEl` inherits: the ONE most specific feature its types have for the name where that
 * redefines `hit` (`part q : Q2 { bind p.load = L; }` finds Q's declared `L`, but Q2's `attribute :>> L = 50.0` is
 * what a Q2 has for it — a copy redefining Q's `L` read the general value in q, MI6), else `hit`. The text mapper
 * makes the copy by it ({@link findTypeFeature}); the editor moves a copy to it when an edit changed what the usage
 * inherits, so the page holds the copy the saved file makes anew.
 */
export function endCopyProto(model: Model, scopeEl: ElementRecord, head: string, hit: ElementRecord): ElementRecord {
  const special = findTypeFeature(model, scopeEl, head, true);
  return special && special !== hit && redefinedClosure(model, special).includes(hit) ? special : hit;
}

/**
 * What {@link mostSpecificRedefining} and {@link joinsTwo} ask of the model's edges and children again and again, kept
 * for one revision of the model: a chain of D definitions, each redefining the one above, makes D such calls over D
 * features, and a lookup per ask made a parse of it cost D cubed.
 */
interface BindMemo {
  rev: number;
  /** A feature → the ids of the features that redefine it directly, in the edge index's order. */
  redefiners: Map<ElementId, ElementId[]>;
  /** A feature → every feature that redefines it, through any number of redefinitions. */
  allRedefiners: Map<ElementId, ReadonlySet<ElementId>>;
  /** An owner → its children by declared name, in order. */
  names: Map<ElementId, Map<string, ElementRecord[]>>;
  /** An owner → its features by effective name ({@link effectiveNameOf}), in order. */
  effectiveNames: Map<ElementId, Map<string, ElementRecord[]>>;
  /** An owner → its children that can lie on a line of redefinitions: a declared name, or a redefinition of their own. */
  bearers: Map<ElementId, { list: ElementRecord[]; ids: Set<ElementId> }>;
}
const bindMemos = new WeakMap<Model, BindMemo>();
function memoOf(model: Model): BindMemo {
  let memo = bindMemos.get(model);
  if (memo === undefined || memo.rev !== model.rev) {
    memo = {
      rev: model.rev,
      redefiners: new Map(),
      allRedefiners: new Map(),
      names: new Map(),
      effectiveNames: new Map(),
      bearers: new Map(),
    };
    bindMemos.set(model, memo);
  }
  return memo;
}

/** The ids of the features that redefine `id` DIRECTLY — the sources of the Redefinitions that target it. */
function redefinerIds(model: Model, id: ElementId): readonly ElementId[] {
  const memo = memoOf(model);
  let ids = memo.redefiners.get(id);
  if (ids === undefined) {
    ids = [];
    for (const r of model.relationshipsTo(id)) {
      if (r.eClass === 'Redefinition') for (const x of r.source ?? []) ids.push(x);
    }
    memo.redefiners.set(id, ids);
  }
  return ids;
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
    for (const x of redefinerIds(model, g)) {
      if (x === id || out.has(x) || !model.get(x)) continue;
      out.add(x);
      if (stop?.(x)) return out;
      queue.push(x);
    }
  }
  return out;
}

/** {@link redefinersOf} without a stop: every `:>>` of a usage asks it of one anchor. */
function allRedefinersOf(model: Model, id: ElementId): ReadonlySet<ElementId> {
  const memo = memoOf(model);
  let all = memo.allRedefiners.get(id);
  if (all === undefined) {
    all = redefinersOf(model, id);
    memo.allRedefiners.set(id, all);
  }
  return all;
}

/**
 * Does any of `among` redefine `id`, through any number of redefinitions? A direct redefiner, nearly always the
 * answer, is looked at first.
 */
function redefinedByOneOf(model: Model, id: ElementId, among: ReadonlySet<ElementId>): boolean {
  for (const x of redefinerIds(model, id)) if (x !== id && among.has(x) && model.get(x)) return true;
  let found = false;
  redefinersOf(model, id, (x) => (found = among.has(x)));
  return found;
}

/**
 * Would redefining `hit`, the most specific feature for `anchor`, make two
 * features one, or put one name on two? Either:
 *
 *  - `hit` MERGES: it also redefines a feature outside `anchor`'s line (Q2's
 *    `attribute X :>> M, N`, found from M, redefines N too), so a usage's
 *    `:>> M` and `:>> N` would both land on X; or
 *  - the redefining feature's owner already has a feature of that line: one
 *    declared under a name `hit` or what it redefines bears (`attribute M2 =
 *    9.0` beside `attribute :>> M = 5.0`, when `hit` is R's `M2 redefines M`),
 *    or one whose own line meets it, through what it redefines or what
 *    redefines that (`attribute :>> M2 = 9.0` there, a second `:>> M`, or a
 *    `:>> K` in `part v : R, S` whose S has `M2 redefines K`, which would take
 *    the name M2 as well); or
 *  - `hit` would RENAME the feature (`M2 redefines M`: `v`'s `:>> M` is then
 *    known as M2), and the owner inherits another feature of that name off the
 *    line (S's own `M2 default = 7.0` in `part v : R, S`): `v.M2` read the one
 *    of v's own and masked S's, where the name stood ambiguous.
 *
 * Order-independent, so the mapper's rounds settle: a sibling is judged by its
 * declared name and by the line its redefinitions lie in (what they redefine,
 * and everything of the general types' that redefines that), never by the
 * feature it has taken this round — that is `hit` or `anchor`, one line
 * either way, and judging by it let two siblings each give way to the other
 * and take it back. Implicit end copies are left out: the mapper makes them
 * after its rounds, so the serializer's re-parse test must not see them either.
 */
function joinsTwo(
  model: Model,
  owners: ReadonlySet<ElementId>,
  anchor: ElementRecord,
  hit: ElementRecord,
  featureId: ElementId,
  among?: ReadonlySet<ElementId>,
): boolean {
  const above = redefinedClosure(model, hit);
  const anchorLine = new Set<ElementId>([anchor.id, ...redefinedClosure(model, anchor).map((g) => g.id)]);
  // A feature `hit` redefines is on the line when it is `anchor` or below it, or redefines `anchor` itself.
  const redefinersOfAnchor = allRedefinersOf(model, anchor.id);
  if (above.some((g) => !anchorLine.has(g.id) && !redefinersOfAnchor.has(g.id))) return true;
  const ownerId = model.get(featureId)?.ownerId ?? null;
  if (ownerId === null) return false;
  const line = [hit, ...above];
  const renamed = hit.declaredName ?? above.find((g) => g.declaredName !== undefined)?.declaredName;
  if (renamed !== undefined && renamed !== effectiveNameOf(model, anchor)) {
    const onLine = new Set<ElementId>([...line.map((g) => g.id), ...anchorLine, ...redefinersOfAnchor]);
    for (const id of owners) {
      if (featuresNamed(model, id, renamed).some((f) => !onLine.has(f.id))) return true;
    }
  }
  // What is left asks about the owner's other features: an owner with none that bears a name or redefines something
  // (the definitions of a chain, each holding one `:>>`) joins nothing, and its line is not walked. The guard must
  // name every kind of sibling the tests below it can find (a Redefinition's source, a declared name): a third kind
  // added below has to be added to {@link bearersOf} too, or this returns before it is asked.
  if (!hasOtherBearer(model, ownerId, featureId, among)) return false;
  const names = new Set<string>(line.flatMap((g) => (g.declaredName !== undefined ? [g.declaredName] : [])));
  // Every feature of the general types that bears one of those names, with what each redefines: a sibling that
  // redefines any of them lies in a line the hit's meets (at a feature the one redefines or is, the other the same).
  // One walk from all of them, each feature met once: a closure per feature made a deep chain cost its depth cubed.
  const reach = new Set<ElementId>();
  const toExpand: ElementRecord[] = [];
  const reachFrom = (f: ElementRecord): void => {
    if (reach.has(f.id)) return;
    reach.add(f.id);
    toExpand.push(f);
  };
  for (const id of owners) {
    for (const name of names) {
      for (const f of childrenNamed(model, id, name)) if (isUsage(f.eClass)) reachFrom(f);
    }
  }
  for (const g of line) reachFrom(g);
  while (toExpand.length > 0) for (const g of redefinedBy(model, toExpand.pop()!)) reachFrom(g);
  // A sibling whose line meets the hit's redefines (through any number of redefinitions) a feature in `reach`, or
  // one that does: asked of the redefiners of `reach`, whose few edges are looked up, never of each of the usage's
  // features in turn.
  const queue = [...reach];
  const seen = new Set<ElementId>(reach);
  while (queue.length > 0) {
    for (const x of redefinerIds(model, queue.pop()!)) {
      if (seen.has(x)) continue;
      seen.add(x);
      queue.push(x);
      const f = model.get(x);
      if (f && f.ownerId === ownerId && f.id !== featureId && f.attrs.implicit !== true && (!among || among.has(f.id))) return true;
    }
  }
  // A sibling declared under one of those names.
  for (const name of names) {
    const bearing = childrenNamed(model, ownerId, name);
    if (bearing.some((sib) => sib.id !== featureId && sib.attrs.implicit !== true && (!among || among.has(sib.id)))) return true;
  }
  return false;
}

/**
 * The children of `ownerId` declared under `name`, in order — an index of the owner's children by declared name.
 * {@link joinsTwo} asks it once per name of the line for each `:>>` it reads, where a scan of the owner's features
 * per call made a usage of N redefinitions cost N squared.
 */
function childrenNamed(model: Model, ownerId: ElementId, name: string): readonly ElementRecord[] {
  const memo = memoOf(model);
  let index = memo.names.get(ownerId);
  if (index === undefined) {
    index = new Map();
    for (const c of model.children(ownerId)) {
      if (c.declaredName === undefined) continue;
      const same = index.get(c.declaredName);
      if (same === undefined) index.set(c.declaredName, [c]);
      else same.push(c);
    }
    memo.names.set(ownerId, index);
  }
  return index.get(name) ?? [];
}

/**
 * The features `ownerId` owns whose effective name is `name`, in order — the effective names of an owner's features
 * are asked once per owner, where each ask walked the redefinitions of every one of them.
 */
function featuresNamed(model: Model, ownerId: ElementId, name: string): readonly ElementRecord[] {
  const memo = memoOf(model);
  let index = memo.effectiveNames.get(ownerId);
  if (index === undefined) {
    index = new Map();
    for (const f of ownFeatures(model, ownerId)) {
      const effective = effectiveNameOf(model, f);
      if (effective === undefined) continue;
      const same = index.get(effective);
      if (same === undefined) index.set(effective, [f]);
      else same.push(f);
    }
    memo.effectiveNames.set(ownerId, index);
  }
  return index.get(name) ?? [];
}

/**
 * The children of `ownerId` {@link joinsTwo} can find on a line of redefinitions: one that is not an implicit end
 * copy and bears a declared name, or redefines something (is the source of a Redefinition).
 */
function bearersOf(model: Model, ownerId: ElementId): { list: ElementRecord[]; ids: Set<ElementId> } {
  const memo = memoOf(model);
  let bearers = memo.bearers.get(ownerId);
  if (bearers === undefined) {
    const list = model
      .children(ownerId)
      .filter(
        (c) =>
          c.attrs.implicit !== true &&
          (c.declaredName !== undefined || model.relationshipsFrom(c.id).some((r) => r.eClass === 'Redefinition')),
      );
    bearers = { list, ids: new Set(list.map((c) => c.id)) };
    memo.bearers.set(ownerId, bearers);
  }
  return bearers;
}

/**
 * Does `ownerId` hold a {@link bearersOf bearer} other than `featureId`, one of `among` when given? The editor asks
 * with the few features an edit touched, of a usage that may hold a thousand `:>>`: the smaller of the two is walked,
 * so a settle of N redefinitions does not cost N squared here.
 */
function hasOtherBearer(model: Model, ownerId: ElementId, featureId: ElementId, among?: ReadonlySet<ElementId>): boolean {
  const { list, ids } = bearersOf(model, ownerId);
  if (among !== undefined && among.size < list.length) {
    for (const id of among) if (id !== featureId && ids.has(id)) return true;
    return false;
  }
  return list.some((c) => c.id !== featureId && (!among || among.has(c.id)));
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

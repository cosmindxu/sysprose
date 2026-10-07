/**
 * KerML inheritance semantics over a {@link Model}.
 *
 * Implements two pure queries from the OMG KerML specification's specialization
 * and feature-membership rules (see docs/02-omg-standard-reference.md):
 *
 *  - {@link generalizationsOf} — the transitive closure of a type's general
 *    types, following the whole specialization family
 *    (Subclassification / Subsetting / FeatureTyping / Redefinition /
 *    ReferenceSubsetting / Conjugation / Specialization); cycle-safe and
 *    library-aware.
 *  - {@link effectiveFeatures} — a type's own features plus every feature
 *    inherited from its generals, with redefinition resolution: a redefining
 *    feature masks the inherited feature it redefines — by its Redefinition,
 *    whatever its name, or by its effective name ({@link effectiveNameOf}).
 *
 * Both functions are deterministic (own-first, then inherited in generalization
 * order) and never mutate the model.
 */

import { type ElementId, type ElementRecord, type Model, isUsage } from '@core/index';

/**
 * All direct and transitive general types of `typeId`, via the specialization
 * relationship family. Order is a breadth-first walk from the direct generals
 * outward; each type appears once. Cycle-safe; includes standard-library types.
 *
 * The starting type itself is NOT included.
 */
export function generalizationsOf(model: Model, typeId: ElementId): ElementRecord[] {
  const out: ElementRecord[] = [];
  const seen = new Set<ElementId>([typeId]);
  const queue: ElementId[] = [typeId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const general of model.typesOf(cur)) {
      if (seen.has(general.id)) continue;
      seen.add(general.id);
      out.push(general);
      queue.push(general.id);
    }
  }
  return out;
}

/**
 * The features directly owned by `typeId` — its owned Usages/features in
 * declaration (containment) order.
 */
export function ownFeatures(model: Model, typeId: ElementId): ElementRecord[] {
  return model.children(typeId).filter((c) => isUsage(c.eClass));
}

/**
 * The features `f` redefines DIRECTLY — the targets of its Redefinitions.
 */
export function redefinedBy(model: Model, f: ElementRecord): ElementRecord[] {
  const out: ElementRecord[] = [];
  for (const r of model.relationshipsFrom(f.id)) {
    if (r.eClass !== 'Redefinition') continue;
    for (const t of r.target ?? []) {
      const g = model.get(t);
      if (g && g.id !== f.id) out.push(g);
    }
  }
  return out;
}

/**
 * Every feature `f` redefines, through any number of redefinitions, nearest
 * first (a breadth-first walk). Cycle-safe; `f` itself is not included.
 */
export function redefinedClosure(model: Model, f: ElementRecord): ElementRecord[] {
  const out: ElementRecord[] = [];
  const seen = new Set<ElementId>([f.id]);
  const queue = redefinedBy(model, f);
  while (queue.length > 0) {
    const g = queue.shift()!;
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    out.push(g);
    queue.push(...redefinedBy(model, g));
  }
  return out;
}

/**
 * The features `f` masks BY NAME in its owner's effective feature set
 * ({@link effectiveFeatures}) — every feature of a general type of `f`'s owner
 * with `f`'s effective name that `f` does not redefine — with what each of
 * them redefines in turn. `attribute load = 50.0` written in `part p : P`
 * without `:>>` hides P's `load` just as a redefinition would; `[]` for a
 * feature that masks nothing.
 */
export function maskedByName(model: Model, f: ElementRecord): ElementRecord[] {
  const name = effectiveNameOf(model, f);
  if (name === undefined || f.ownerId == null) return [];
  const out: ElementRecord[] = [];
  const seen = new Set<ElementId>([f.id, ...redefinedClosure(model, f).map((g) => g.id)]);
  for (const general of generalizationsOf(model, f.ownerId)) {
    for (const h of ownFeatures(model, general.id)) {
      if (seen.has(h.id) || effectiveNameOf(model, h) !== name) continue;
      for (const g of [h, ...redefinedClosure(model, h)]) {
        if (seen.has(g.id)) continue;
        seen.add(g.id);
        out.push(g);
      }
    }
  }
  return out;
}

/**
 * The name a feature is known by — KerML's `effectiveName`: its declared
 * name, else, for a redefinition written without one (`attribute :>> load =
 * 50.0`, `attribute redefines load = 50.0`), the effective name of the first
 * feature it redefines. `undefined` for an unnamed feature that redefines
 * nothing named. Cycle-safe.
 *
 * Every scope used to read `declaredName` alone, so an unnamed redefinition
 * claimed no name: the usage's `load` read the DEFINITION's (`p.load` was 1,
 * not 50), and the verification lane filed no axiom for the 50 at all.
 */
export function effectiveNameOf(model: Model, f: ElementRecord): string | undefined {
  if (f.declaredName !== undefined) return f.declaredName;
  for (const g of redefinedClosure(model, f)) if (g.declaredName !== undefined) return g.declaredName;
  return undefined;
}

/**
 * The qualified name of `id` with every segment spelled by its effective name
 * ({@link effectiveNameOf}): `R::q::p::load` for `part q : Q { part :>> p {
 * attribute :>> load = 50.0; } }`, where {@link Model.qualifiedName} reads
 * `R::q::«PartUsage»::«AttributeUsage»` — a spelling two unnamed redefinitions
 * of one owner share, so they would read as ONE symbol to the verification
 * lane (`p.a + p.b` as 2·a). Equal to the qualified name for every element
 * whose owners are all named, or unnamed without redefining anything.
 */
export function effectiveQualifiedName(model: Model, id: ElementId): string {
  const parts: string[] = [];
  const visited = new Set<ElementId>();
  let cur = model.get(id);
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    parts.unshift(effectiveNameOf(model, cur) ?? cur.declaredShortName ?? `«${cur.eClass}»`);
    cur = cur.ownerId !== null ? model.get(cur.ownerId) : undefined;
  }
  return parts.join('::');
}

/**
 * The effective feature set of `typeId`: own features first (in declaration
 * order), then features inherited from every general type, with redefinition
 * resolution.
 *
 * Redefinition rule (KerML: a redefined feature is not an inherited member):
 * an inherited feature is dropped when a more-specific feature already
 * contributed REDEFINES it — by an explicit Redefinition, transitively, whatever
 * its name (`attribute :>> load = 50.0` declares none, `attribute heavy
 * redefines load` another one) — or when one with the same effective name
 * ({@link effectiveNameOf}) already appears. Matching by declared name alone
 * left `P::load` in the effective set of `part p : P { attribute :>> load =
 * 50.0; }` under the name `load`, so every scope read the definition's value.
 */
export function effectiveFeatures(model: Model, typeId: ElementId): ElementRecord[] {
  const result: ElementRecord[] = [];
  const claimedNames = new Set<string>();
  const seenIds = new Set<ElementId>();
  const candidates = [...ownFeatures(model, typeId)];
  for (const general of generalizationsOf(model, typeId)) candidates.push(...ownFeatures(model, general.id));
  // Every feature ANY candidate redefines, before any is contributed: a
  // feature a more specific one redefines is not inherited, whichever general
  // the walk meets first — `part def C :> P, A` met P's `load` before A's `:>>
  // load = 5.0` and read P's.
  const redefinedIds = new Set<ElementId>();
  for (const f of candidates) for (const g of redefinedClosure(model, f)) redefinedIds.add(g.id);

  for (const feat of candidates) {
    if (seenIds.has(feat.id) || redefinedIds.has(feat.id)) continue;
    const name = effectiveNameOf(model, feat);
    // A named feature already claimed by a more-specific type is masked.
    if (name !== undefined && claimedNames.has(name)) continue;
    seenIds.add(feat.id);
    if (name !== undefined) claimedNames.add(name);
    result.push(feat);
  }
  return result;
}

/**
 * The features of `typeId` hidden by NAME alone among what it inherits — two
 * features of two of its general types under one name, neither redefining the
 * other (`part def C :> A, B` over A's and B's `:>> load`): name → the
 * feature {@link effectiveFeatures} keeps first, then the others. A name one
 * of `typeId`'s own features claims is not among them.
 */
export function inheritedNameClashes(model: Model, typeId: ElementId): Map<string, ElementRecord[]> {
  const own = new Set<string>();
  for (const f of ownFeatures(model, typeId)) {
    const n = effectiveNameOf(model, f);
    if (n !== undefined) own.add(n);
  }
  const candidates: ElementRecord[] = [];
  let contributing = 0;
  for (const general of generalizationsOf(model, typeId)) {
    if (general.attrs.isLibrary === true) continue;
    const features = ownFeatures(model, general.id);
    if (features.length > 0) contributing++;
    candidates.push(...features);
  }
  // One general type contributes no two features of one name.
  if (contributing < 2) return new Map();
  const redefinedIds = new Set<ElementId>();
  for (const f of candidates) for (const g of redefinedClosure(model, f)) redefinedIds.add(g.id);
  const byName = new Map<string, ElementRecord[]>();
  for (const f of candidates) {
    if (redefinedIds.has(f.id)) continue;
    const n = effectiveNameOf(model, f);
    if (n === undefined || own.has(n)) continue;
    const list = byName.get(n);
    if (!list) byName.set(n, [f]);
    else if (!list.includes(f)) list.push(f);
  }
  for (const [n, list] of byName) if (list.length < 2) byName.delete(n);
  return byName;
}

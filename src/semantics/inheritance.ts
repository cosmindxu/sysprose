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
 *    feature (matched by name) masks the inherited feature it redefines.
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
 * The effective feature set of `typeId`: own features first (in declaration
 * order), then features inherited from every general type, with redefinition
 * resolution.
 *
 * Redefinition rule: an inherited feature is dropped when a more-specific
 * feature with the same `declaredName` already appears (own features, or a
 * feature contributed by a nearer general). This models a redefining feature
 * masking the one it redefines, matched by name as the task specifies.
 */
export function effectiveFeatures(model: Model, typeId: ElementId): ElementRecord[] {
  const result: ElementRecord[] = [];
  const claimedNames = new Set<string>();
  const seenIds = new Set<ElementId>();

  const contribute = (feat: ElementRecord): void => {
    if (seenIds.has(feat.id)) return;
    const name = feat.declaredName;
    // A named feature already claimed by a more-specific type is masked.
    if (name !== undefined && claimedNames.has(name)) return;
    seenIds.add(feat.id);
    if (name !== undefined) claimedNames.add(name);
    result.push(feat);
  };

  for (const f of ownFeatures(model, typeId)) contribute(f);
  for (const general of generalizationsOf(model, typeId)) {
    for (const f of ownFeatures(model, general.id)) contribute(f);
  }
  return result;
}

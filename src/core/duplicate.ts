/**
 * Deep-clone an element and its whole containment subtree as a new sibling.
 *
 * The clone is structurally independent: every element gets a fresh id, and any
 * relationship whose `source`/`target` points *inside* the subtree is rewired to
 * the corresponding clone, while references to elements *outside* the subtree are
 * preserved. The root clone gets a unique sibling name (`"X copy"`, `"X copy 2"`,
 * …) so repeated duplication doesn't stack identical names; its short name is
 * cleared to avoid colliding with the original in the same namespace.
 *
 * Pure model mutation (no UI/undo concerns) so it can be unit-tested directly;
 * the store action wraps it with a single undo checkpoint + selection update.
 */

import type { Model } from './model';
import type { ElementId } from './metamodel';

/** Duplicate `id`'s subtree as a sibling; returns the new root id (or null). */
export function duplicateSubtree(model: Model, id: ElementId): ElementId | null {
  const root = model.get(id);
  if (!root) return null;

  // Subtree in top-down order — owners precede their children so a clone's
  // owner already exists when we create it. A `seen` set guards against a
  // malformed ownership cycle (the model's invariants prevent one, but the
  // rest of the codebase — e.g. `ancestors` — is defensive here too).
  const order: ElementId[] = [];
  const seen = new Set<ElementId>();
  const walk = (nid: ElementId): void => {
    if (seen.has(nid)) return;
    seen.add(nid);
    order.push(nid);
    for (const c of model.childIds(nid)) walk(c);
  };
  walk(id);

  // A unique name for the clone root among its siblings.
  const siblingNames = new Set(
    model
      .childIds(root.ownerId)
      .map((cid) => model.get(cid)?.declaredName)
      .filter((n): n is string => !!n),
  );
  let rootName = root.declaredName;
  if (rootName) {
    const base = `${rootName} copy`;
    rootName = base;
    for (let k = 2; siblingNames.has(rootName); k++) rootName = `${base} ${k}`;
  }

  // Phase 1: clone every element, remapping owners. Endpoints are set in phase 2
  // because a relationship may point at a descendant not yet cloned.
  const idMap = new Map<ElementId, ElementId>();
  for (const oldId of order) {
    const el = model.get(oldId)!;
    const isRoot = oldId === id;
    const clone = model.create(el.eClass, {
      ownerId: isRoot ? el.ownerId : idMap.get(el.ownerId!)!,
      declaredName: isRoot ? rootName : el.declaredName,
      declaredShortName: isRoot ? undefined : el.declaredShortName,
      attrs: el.attrs ? structuredClone(el.attrs) : undefined,
    });
    idMap.set(oldId, clone.id);
  }

  // Phase 2: rewire endpoints. Inside-subtree → clone; outside → preserved.
  for (const oldId of order) {
    const el = model.get(oldId)!;
    const patch: { source?: ElementId[]; target?: ElementId[] } = {};
    if (el.source?.length) patch.source = el.source.map((s) => idMap.get(s) ?? s);
    if (el.target?.length) patch.target = el.target.map((t) => idMap.get(t) ?? t);
    if (patch.source || patch.target) model.update(idMap.get(oldId)!, patch);
  }

  return idMap.get(id)!;
}

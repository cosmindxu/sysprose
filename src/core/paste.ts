/**
 * Copy / paste of element subtrees, possibly across owners or documents.
 *
 * `collectSubtrees` snapshots the selected subtrees into a detached, id-bearing
 * payload (a clipboard), so a later edit can't disturb it. `pasteSubtrees`
 * materializes that payload under a new owner with fresh ids: references that
 * pointed INSIDE the copied set are rewired to the pasted clones, references to
 * elements OUTSIDE it are kept only if those elements still exist, and each
 * pasted root gets a name unique among its new siblings.
 *
 * Pure model functions (no UI/undo concerns) so they can be unit-tested; the
 * store wraps paste with a single undo checkpoint + selection update.
 */

import type { Model } from './model';
import type { ElementId, ElementRecord } from './metamodel';

/** A detached, serializable clipboard of one or more subtrees. */
export interface ClipboardPayload {
  /** Deep-copied records of every element in the copied subtrees (own ids). */
  records: ElementRecord[];
  /** The top-level (root) element ids of the copied subtrees. */
  rootIds: ElementId[];
}

/** Snapshot the given roots (and their subtrees) into a clipboard payload.
 *  Roots that are descendants of another given root are dropped (carried along
 *  by their ancestor); the payload records are independent deep copies. */
export function collectSubtrees(model: Model, rootIds: ElementId[]): ClipboardPayload {
  const rootSet = new Set(rootIds);
  const tops = rootIds.filter(
    (id) => model.get(id) && !model.ancestors(id).some((a) => rootSet.has(a.id)),
  );
  const records: ElementRecord[] = [];
  const seen = new Set<ElementId>();
  const walk = (id: ElementId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const el = model.get(id);
    if (!el) return;
    records.push(structuredClone(el));
    for (const c of model.childIds(id)) walk(c);
  };
  for (const t of tops) walk(t);
  return { records, rootIds: tops };
}

/** A name unique among `taken`, suffixing `" copy"`, `" copy 2"`, … as needed. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const base = `${name} copy`;
  let out = base;
  for (let k = 2; taken.has(out); k++) out = `${base} ${k}`;
  return out;
}

/** Paste a clipboard payload under `targetOwnerId` (null = a new root). Returns
 *  the ids of the newly-created roots (empty if the payload was empty). */
export function pasteSubtrees(
  model: Model,
  payload: ClipboardPayload,
  targetOwnerId: ElementId | null,
): ElementId[] {
  if (payload.records.length === 0) return [];
  // A target owner that no longer exists ⇒ paste at the root.
  const owner = targetOwnerId != null && model.has(targetOwnerId) ? targetOwnerId : null;
  const rootSet = new Set(payload.rootIds);
  const siblingNames = new Set(
    model
      .childIds(owner)
      .map((cid) => model.get(cid)?.declaredName)
      .filter((n): n is string => !!n),
  );

  // Phase 1: create every element (payload is per-subtree top-down, so a clone's
  // owner already exists when we reach it), remapping owners + naming roots.
  const idMap = new Map<ElementId, ElementId>();
  const roots: ElementId[] = [];
  for (const rec of payload.records) {
    const isRoot = rootSet.has(rec.id);
    let name = rec.declaredName;
    if (isRoot && name) {
      name = uniqueName(name, siblingNames);
      siblingNames.add(name);
    }
    const clone = model.create(rec.eClass, {
      ownerId: isRoot ? owner : idMap.get(rec.ownerId!)!,
      declaredName: name,
      declaredShortName: isRoot ? undefined : rec.declaredShortName,
      attrs: rec.attrs ? structuredClone(rec.attrs) : undefined,
    });
    idMap.set(rec.id, clone.id);
    if (isRoot) roots.push(clone.id);
  }

  // Phase 2: rewire endpoints. Inside-payload → clone; outside → keep iff it
  // still exists in the model (a copied reference to a since-deleted element is
  // dropped rather than left dangling).
  const remap = (ids: ElementId[]): ElementId[] =>
    // Every copied element was created in phase 1, so an inside-payload ref maps
    // to a live clone; an outside ref is kept only if it still exists.
    ids.map((x) => idMap.get(x) ?? x).filter((x) => model.has(x));
  const broken: ElementId[] = [];
  for (const rec of payload.records) {
    const cloneId = idMap.get(rec.id)!;
    const patch: { source?: ElementId[]; target?: ElementId[] } = {};
    let orphaned = false;
    if (rec.source?.length) {
      patch.source = remap(rec.source);
      if (patch.source.length === 0) orphaned = true; // had a source, now none
    }
    if (rec.target?.length) {
      patch.target = remap(rec.target);
      if (patch.target.length === 0) orphaned = true;
    }
    // A relationship that lost ALL of a required endpoint (every one was an
    // external, since-deleted element) is incomplete — drop the clone rather
    // than materialize an empty-endpoint orphan.
    if (orphaned) broken.push(cloneId);
    else if (patch.source || patch.target) model.update(cloneId, patch);
  }
  for (const id of broken) if (model.has(id)) model.remove(id);

  return roots.filter((r) => model.has(r));
}

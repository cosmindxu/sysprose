/**
 * Pure drop-target resolution for canvas drag-to-reparent.
 *
 * When a node — or a whole multi-selection of nodes — is dragged and dropped
 * onto another node on the canvas, that node's element becomes the new OWNER of
 * the dragged element(s), mirroring the Explorer's drop-to-reparent. This helper
 * decides, from the geometrically-overlapping candidate nodes (ordered
 * innermost-first by the caller), which element is a VALID new owner — or `null`
 * when the drop is just a position tweak with no valid target.
 *
 * A candidate is rejected when it is:
 *  - one of the dragged elements itself (an element can't own itself),
 *  - not present in the model (a stale candidate),
 *  - inside any dragged element's subtree — reparenting there would create a
 *    containment cycle (mirrors {@link Model.reparent}'s own guard),
 *  - an ANCESTOR of any dragged element — the dragged node already lives inside
 *    it (and with React Flow's `extent:'parent'` a nested node's rect always
 *    overlaps its whole ancestor chain, so without this guard a mere
 *    position-nudge of a deeply-nested node would silently reparent it up a
 *    level); dragging within your own container tree must stay a position tweak,
 *  - or already the owner of every dragged element (a pure no-op).
 *
 * The first surviving candidate wins, so callers pass the most specific
 * (innermost / smallest) overlapped node first. Kept DOM- and React-Flow-free so
 * it is exhaustively unit-testable; the caller supplies the overlap list.
 */

/** The slice of the model this resolver reads (kept minimal for testing). */
export interface ReparentTargetModel {
  has(id: string): boolean;
  get(id: string): { ownerId: string | null } | undefined;
  /** Ancestor chain (immediate owner → root); only `.id` is read. */
  ancestors(id: string): { id: string }[];
}

/**
 * Resolve the valid new-owner element for a drag-to-reparent gesture, or `null`.
 *
 * @param model        model accessor (has / get / ancestors)
 * @param draggedIds   element ids being dragged (1..N; the multi-selection)
 * @param candidateIds overlapped element ids, MOST SPECIFIC (innermost) FIRST
 */
export function resolveReparentTarget(
  model: ReparentTargetModel,
  draggedIds: readonly string[],
  candidateIds: readonly string[],
): string | null {
  if (draggedIds.length === 0) return null;
  const dragged = new Set(draggedIds);
  // Union of every dragged element's ancestor ids — a candidate in this set is
  // an ancestor of something being dragged, so the drag is happening INSIDE it
  // (never a reparent intent).
  const draggedAncestorIds = new Set<string>();
  for (const d of draggedIds) for (const a of model.ancestors(d)) draggedAncestorIds.add(a.id);
  for (const cand of candidateIds) {
    if (dragged.has(cand)) continue; // the node itself / another dragged node
    if (!model.has(cand)) continue; // stale candidate
    if (draggedAncestorIds.has(cand)) continue; // an ancestor of a dragged element
    // Cycle guard: the candidate must not sit inside any dragged element's
    // subtree — otherwise it would become its own (transitive) descendant.
    const ancestorIds = new Set(model.ancestors(cand).map((a) => a.id));
    if (draggedIds.some((d) => ancestorIds.has(d))) continue;
    // Only meaningful if it actually re-owns at least one dragged element;
    // dropping everything back onto its current owner is a no-op.
    const meaningful = draggedIds.some((d) => {
      const el = model.get(d);
      return el != null && el.ownerId !== cand;
    });
    if (!meaningful) continue;
    return cand;
  }
  return null;
}

/**
 * Reduce a set of element ids to its "subtree roots": drop any id that is a
 * descendant of another id in the set. Reparenting must move whole subtrees, not
 * flatten them — mirrors the store's `duplicateSelection` convention. Cycle-safe
 * via {@link ReparentTargetModel.ancestors}.
 */
export function subtreeRoots(
  model: ReparentTargetModel,
  ids: readonly string[],
): string[] {
  const set = new Set(ids);
  return ids.filter((id) => !model.ancestors(id).some((a) => set.has(a.id)));
}

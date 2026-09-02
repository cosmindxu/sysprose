/**
 * Sequence-diagram builder (sequence view).
 *
 * A SysML v2 Sequence view shows **lifelines** — participating occurrences /
 * parts / actions — and the **time-ordered messages** exchanged between them
 * (docs/02 §4.1: "Lifelines and time-ordered message/event occurrences"). This
 * module projects the {@link Model} into the {@link SequenceDiagram} contract in
 * `./types.ts`.
 *
 * Message semantics in the abstract syntax are captured by *transfer* edges —
 * `SuccessionFlow` / `Flow` / `FlowUsage` carry an item from a source to a
 * target feature. When a model has such transfers we use them directly; when it
 * does not (a common early-modelling situation where only control flow exists),
 * we fall back to plain `Succession` control edges between action lifelines so
 * the view is still populated. Endpoints of the chosen edges become lifelines
 * (deduplicated, in first-appearance order); each edge becomes one message with
 * an incrementing `order` and its element name as the label.
 */

import type { ElementId, ElementRecord } from '@core/index';
import { Model } from '@core/index';
import type { SequenceDiagram } from './types';

/** Best human label for an element. */
function labelOf(el: ElementRecord): string {
  return el.declaredName ?? el.declaredShortName ?? el.eClass;
}

/** Transfer / message-bearing edge metaclasses (preferred message source). */
const FLOW_KINDS = ['SuccessionFlow', 'Flow', 'FlowUsage'];
/** Control-flow edge metaclasses used as a fallback message source. */
const SUCCESSION_KINDS = ['Succession'];

/** Element ids in scope: the subtree of `rootId` (or the whole model), minus library elements. */
function scopeIds(model: Model, rootId: ElementId | undefined): Set<ElementId> {
  const ids = rootId
    ? new Set<ElementId>([rootId, ...model.descendants(rootId).map((d) => d.id)])
    : new Set<ElementId>(model.all().map((e) => e.id));
  for (const id of ids) {
    if (model.get(id)?.attrs.isLibrary === true) ids.delete(id);
  }
  return ids;
}

/**
 * Edges of the given metaclasses in scope with both endpoints resolvable and in
 * scope, returned in model declaration order (a stable time order).
 */
function orderedEdges(
  model: Model,
  scope: Set<ElementId>,
  kinds: string[],
): ElementRecord[] {
  const kindSet = new Set(kinds);
  const out: ElementRecord[] = [];
  for (const el of model.all()) {
    if (!kindSet.has(el.eClass) || !scope.has(el.id)) continue;
    const src = el.source?.[0];
    const tgt = el.target?.[0];
    if (!src || !tgt || !scope.has(src) || !scope.has(tgt)) continue;
    if (!model.get(src) || !model.get(tgt)) continue;
    out.push(el);
  }
  return out;
}

/**
 * Build the sequence diagram for `model`, optionally scoped to the subtree
 * rooted at `rootId`. Prefers transfer (flow) edges for messages and falls back
 * to control-flow successions when the model has no transfers.
 */
export function buildSequence(model: Model, rootId?: ElementId): SequenceDiagram {
  const scope = scopeIds(model, rootId);

  let edges = orderedEdges(model, scope, FLOW_KINDS);
  if (edges.length === 0) edges = orderedEdges(model, scope, SUCCESSION_KINDS);

  const lifelines: SequenceDiagram['lifelines'] = [];
  const seen = new Set<ElementId>();
  const addLifeline = (id: ElementId): void => {
    if (seen.has(id)) return;
    const el = model.get(id);
    if (!el) return;
    seen.add(id);
    lifelines.push({ id, elementId: id, label: labelOf(el) });
  };

  const messages: SequenceDiagram['messages'] = [];
  let order = 0;
  for (const e of edges) {
    const from = e.source![0];
    const to = e.target![0];
    addLifeline(from);
    addLifeline(to);
    order += 1;
    messages.push({
      id: `msg:${e.id}`,
      fromLifeline: from,
      toLifeline: to,
      label: e.declaredName,
      order,
      elementId: e.id,
    });
  }

  return { lifelines, messages };
}

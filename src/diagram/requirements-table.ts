/**
 * buildRequirementsTable — project a {@link Model} into a
 * {@link RequirementsTableModel} for the requirements-table editor view.
 *
 * A DOORS-NG / CodeBeamer-style requirements grid, natively bound to the SysML
 * v2 model: every non-library `RequirementUsage`/`RequirementDefinition` becomes
 * a row, HIERARCHICAL by containment (nested requirements get outline numbers
 * like `1.2.1` and an indentation `depth`). Scalar columns (id/name/text) map to
 * `attrs.reqId` / `declaredName` / `attrs.text`; REFERENCE columns resolve the
 * requirement relationships to their related model elements.
 *
 * DIRECTION CONVENTION (uniform across all reference kinds, matching
 * `factory.satisfy` + `analytics.requirementSatisfaction`): a relationship has
 * `source = [the related element]` and `target = [the requirement]`. So a
 * requirement R's references for a kind K are
 * `model.relationshipsTo(R).filter(eClass ∈ K).flatMap(source)`.
 *
 * This is a PURE function (no model mutation, no React) so it is unit-testable;
 * the `RequirementsTable` panel calls it on every `rev` to render live.
 */

import type { ElementId, ElementRecord } from '@core/index';
import { Model, isRequirement } from '@core/index';
import type { RequirementsTableModel, ReqRefColumn, ReqReference, ReqRow } from './types';

/** The editable scalar columns, left of the reference columns. */
const SCALAR_COLUMNS: { key: string; label: string }[] = [
  { key: 'reqId', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'text', label: 'Text' },
];

/**
 * The reference columns. `kinds` are the relationship metaclasses resolved for
 * the column (source = related element, target = requirement). Satisfy accepts
 * the usage-layer variant too, matching `analytics.SATISFY_KINDS`.
 */
const REF_COLUMNS: ReqRefColumn[] = [
  { key: 'satisfiedBy', label: 'Satisfied By', kinds: ['Satisfy', 'SatisfyRequirementUsage'] },
  { key: 'verifiedBy', label: 'Verified By', kinds: ['Verify'] },
  { key: 'refinedBy', label: 'Refined By', kinds: ['Refine'] },
  { key: 'tracedTo', label: 'Traced To', kinds: ['Trace'] },
  { key: 'derivedFrom', label: 'Derived From', kinds: ['Derive'] },
];

/** The reference-column definitions (exported so the panel + tests share them). */
export const REQUIREMENT_REF_COLUMNS = REF_COLUMNS;
export const REQUIREMENT_SCALAR_COLUMNS = SCALAR_COLUMNS;

/** Best human label for a related element. */
function labelOf(el: ElementRecord): string {
  return el.declaredName ?? (el.attrs.reqId as string | undefined) ?? el.declaredShortName ?? el.eClass;
}

/** Is `el` a user (non-library) requirement? */
function isUserRequirement(el: ElementRecord): boolean {
  return isRequirement(el.eClass) && el.attrs.isLibrary !== true;
}

/**
 * Related elements for requirement `reqId` under the given relationship kinds.
 * Uses `edgesTo` (all endpoint-bearing elements incident on the target), not
 * `relationshipsTo` — the latter filters to `isRelationship`, which would drop
 * the usage-layer `SatisfyRequirementUsage` and disagree with
 * `analytics.requirementSatisfaction`. The explicit `kinds` set already
 * constrains the eClass, so `edgesTo` is safe here.
 */
function referencesFor(model: Model, reqId: ElementId, kinds: string[]): ReqReference[] {
  const kindSet = new Set(kinds);
  const out: ReqReference[] = [];
  const seen = new Set<string>();
  for (const rel of model.edgesTo(reqId)) {
    if (!kindSet.has(rel.eClass)) continue;
    for (const sid of rel.source ?? []) {
      const el = model.get(sid);
      if (!el) continue;
      const dedup = `${rel.id}:${sid}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      out.push({ targetId: sid, label: labelOf(el), eClass: el.eClass, relId: rel.id });
    }
  }
  return out;
}

export function buildRequirementsTable(model: Model): RequirementsTableModel {
  const allReqs = model.all().filter(isUserRequirement);
  const reqIds = new Set(allReqs.map((r) => r.id));

  const rows: ReqRow[] = [];
  const visited = new Set<ElementId>(); // containment is acyclic, but guard anyway

  const emit = (el: ElementRecord, number: string, depth: number): void => {
    if (visited.has(el.id)) return;
    visited.add(el.id);
    rows.push({
      id: el.id,
      number,
      depth,
      reqId: String(el.attrs.reqId ?? ''),
      name: el.declaredName ?? '',
      text: String(el.attrs.text ?? ''),
      eClass: el.eClass,
      refs: Object.fromEntries(
        REF_COLUMNS.map((c) => [c.key, referencesFor(model, el.id, c.kinds)]),
      ),
    });
    // Nested requirements (containment children that are themselves requirements).
    const children = model.children(el.id).filter(isUserRequirement);
    children.forEach((child, i) => emit(child, `${number}.${i + 1}`, depth + 1));
  };

  // Top-level rows = requirements whose owner is NOT itself a requirement, in
  // containment/insertion order (model.all() preserves it).
  const topLevel = allReqs.filter((r) => !(r.ownerId != null && reqIds.has(r.ownerId)));
  topLevel.forEach((r, i) => emit(r, String(i + 1), 0));

  return { scalarColumns: SCALAR_COLUMNS, refColumns: REF_COLUMNS, rows };
}

/**
 * buildRequirementsTable — project a {@link Model} into a
 * {@link RequirementsTableModel} for the requirements-table editor view.
 *
 * A DOORS-NG / CodeBeamer-style requirements grid, natively bound to the SysML
 * v2 model: every non-library `RequirementUsage`/`RequirementDefinition` becomes
 * a row, HIERARCHICAL by containment (nested requirements get outline numbers
 * like `1.2.1` and an indentation `depth`). Scalar columns (id/name/text) map to
 * `requirementShortId` (the native short name, falling back to the legacy
 * `attrs.reqId`) / `declaredName` / `attrs.text`; REFERENCE columns resolve the
 * requirement relationships to their related model elements; FACET columns
 * carry the statement kind and the nine management attributes
 * (`src/semantics/requirements.ts`), so a row says not only what a requirement
 * demands but what state it is in — and whether it is a requirement at all.
 *
 * A `prose` or `prompt` row stays in the grid. It is labelled by its Kind cell,
 * not hidden: the table is where a model's statements are read, and dropping
 * the non-normative ones would make the one editable grid in the app the one
 * place they cannot be edited. Coverage is the number that excludes them
 * (`analytics.requirementSatisfaction`), and it says so.
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
import {
  RM_ATTR_KEYS,
  RM_ENUM_VALUES,
  getRequirementAttrs,
  requirementShortId,
} from '@semantics/requirements';
import { evidenceHolders, evidenceStatus, type EvidenceStatusRow } from '@api/evidence';
import type {
  RequirementsTableModel,
  ReqAttrColumn,
  ReqEvidenceCell,
  ReqRefColumn,
  ReqReference,
  ReqRow,
} from './types';

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

/**
 * Headings for the facet columns. Every key of {@link RM_ATTR_KEYS} needs one,
 * which `Record` makes the compiler check: a tenth facet added to that list
 * without a heading here does not compile, rather than shipping a column
 * labelled `undefined`.
 */
const ATTR_LABELS: Record<(typeof RM_ATTR_KEYS)[number], string> = {
  statementKind: 'Kind',
  status: 'Status',
  verdict: 'Verdict',
  risk: 'Risk',
  priority: 'Priority',
  criticality: 'Criticality',
  rationale: 'Rationale',
  source: 'Source',
  owner: 'Owner',
  verificationMethod: 'Verification',
};

/**
 * The facet columns: the statement KIND first, then the nine management
 * attributes in the order {@link RM_ATTR_KEYS} declares them.
 *
 * Kind leads because it decides what the rest of the row means — a `prose` row
 * is in the grid to be read, not to be covered — and because it is the one
 * facet every row has. The nine follow their own declared order, so the table,
 * the Properties panel and any future editor offer them the same way round.
 *
 * `values` is copied from the same table `setRequirementAttr` validates
 * against, so what a cell offers and what a write accepts cannot drift apart.
 */
const ATTR_COLUMNS: ReqAttrColumn[] = [
  'statementKind' as const,
  ...RM_ATTR_KEYS.filter((k) => k !== 'statementKind'),
].map((key) => ({ key, label: ATTR_LABELS[key], values: RM_ENUM_VALUES[key] }));

/**
 * The column definitions, all three published on the `@diagram` barrel so a
 * consumer can ask what a table WILL have without building one. The attribute
 * list was the odd one out — declared here and reachable nowhere — which made
 * this sentence false for it; `test/unit/requirements-table.test.ts` now asks
 * for all three through the barrel, so it cannot go back to being half true.
 */
export const REQUIREMENT_REF_COLUMNS = REF_COLUMNS;
export const REQUIREMENT_SCALAR_COLUMNS = SCALAR_COLUMNS;
export const REQUIREMENT_ATTR_COLUMNS = ATTR_COLUMNS;

/**
 * The evidence column, which is one column and not two.
 *
 * The Verdict facet already has a column of its own, in {@link ATTR_COLUMNS} —
 * it is one of the ten a requirement carries and it is EDITABLE, because a
 * verdict reached by inspection is a verdict a person types. What was missing
 * beside it is the read-only half: whether anything stands behind that verdict,
 * and whether what stands behind it is still about this model. That is this
 * column, and its cell carries the claim word so the pair can never render a
 * point evaluation and a proof the same way.
 */
const EVIDENCE_COLUMNS: { key: string; label: string }[] = [{ key: 'evidence', label: 'Evidence' }];
export const REQUIREMENT_EVIDENCE_COLUMNS = EVIDENCE_COLUMNS;

/** The cell for a row nothing was ever recorded about — most of a model. */
const NO_EVIDENCE: ReqEvidenceCell = {
  status: 'none',
  claim: null,
  records: 0,
  detail: 'no evidence recorded — run `npm run sysprose -- verify <file> --record evidence.json`',
  slice: [],
};

/** One status row projected onto the cell the table renders. */
function evidenceCell(row: EvidenceStatusRow): ReqEvidenceCell {
  return {
    status: row.status,
    // The CLAIM, verbatim from the record. Never `row.verdict`, which is the
    // three-valued facet: `holds-at-values` and `proved` both summarise to
    // something else there, and collapsing them is the one display defect this
    // whole column exists to make impossible.
    claim: row.claim ?? null,
    records: row.records,
    detail: row.detail,
    slice: row.slice,
    ...(row.code !== undefined ? { code: row.code } : {}),
  };
}

/**
 * Best human label for a related element. The native short name comes before
 * the legacy `attrs.reqId`, the same preference every reader of a requirement
 * id has, so an edited id is the one a chip shows.
 */
function labelOf(el: ElementRecord): string {
  return el.declaredName ?? el.declaredShortName ?? (el.attrs.reqId as string | undefined) ?? el.eClass;
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
      // The slot the FILE keeps, through the one reader every consumer shares:
      // the cell read `attrs.reqId` alone while the serializer writes the
      // native short name, so an edited id showed the stale legacy copy.
      reqId: requirementShortId(model, el.id),
      name: el.declaredName ?? '',
      text: String(el.attrs.text ?? ''),
      eClass: el.eClass,
      refs: Object.fromEntries(
        REF_COLUMNS.map((c) => [c.key, referencesFor(model, el.id, c.kinds)]),
      ),
      // Reading only: `getRequirementAttrs` answers from the carrier if there
      // is one and reports the kind from the keyword or the metaclass. It never
      // creates the carrier, so opening the table on a model does not change it.
      attrs: getRequirementAttrs(model, el.id),
      // Filled by the pass below, when the model carries anything to fill it
      // with. Never undefined: a consumer reading `row.evidence.status` must
      // not have to know whether this model has been verified.
      evidence: NO_EVIDENCE,
    });
    // Nested requirements (containment children that are themselves requirements).
    const children = model.children(el.id).filter(isUserRequirement);
    children.forEach((child, i) => emit(child, `${number}.${i + 1}`, depth + 1));
  };

  // Top-level rows = requirements whose owner is NOT itself a requirement, in
  // containment/insertion order (model.all() preserves it).
  const topLevel = allReqs.filter((r) => !(r.ownerId != null && reqIds.has(r.ownerId)));
  topLevel.forEach((r, i) => emit(r, String(i + 1), 0));

  // The evidence pass runs LAST and only when there is something to say.
  // `evidenceStatus` takes the canonical digest of the whole user model, and
  // this function is called on every store revision — so a model that has never
  // heard of the verification lane must not pay for a hash on every keystroke.
  // Two things make a model worth asking about: a carrier, or a verdict facet
  // somebody wrote by hand (which is the `unrecorded` row, and is exactly the
  // one a cheap "are there carriers?" test would miss).
  const worthAsking =
    evidenceHolders(model).length > 0 || rows.some((r) => r.attrs.verdict !== undefined);
  if (worthAsking) {
    const status = new Map(evidenceStatus(model).rows.map((r) => [r.id, r]));
    for (const row of rows) {
      const found = status.get(row.id);
      if (found) row.evidence = evidenceCell(found);
    }
  }

  return {
    scalarColumns: SCALAR_COLUMNS,
    refColumns: REF_COLUMNS,
    attrColumns: ATTR_COLUMNS,
    evidenceColumns: EVIDENCE_COLUMNS,
    rows,
  };
}

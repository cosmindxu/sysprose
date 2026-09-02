/**
 * buildGrid — project a {@link Model} into a tabular {@link GridModel} (grid view).
 *
 * The grid view is the SysML v2 *table/grid* rendering (docs/02 §4): every
 * in-scope element becomes a **row**, and a fixed set of computed properties —
 * name, metaclass, type, multiplicity, value, redefines, doc — become the
 * **columns**. It complements the graphical views for bulk inspection/editing of
 * element properties. Rows are the in-scope, non-relationship, non-library
 * elements (optionally filtered by metaclass); cells are derived from each
 * element's `declaredName`/`eClass`/`attrs` and its resolved types/redefinitions.
 */

import type { ElementId, ElementRecord } from '@core/index';
import { Model, isAnnotation, isRelationship } from '@core/index';
import type { GridModel } from './types';

/* ─────────────────────────────── helpers ───────────────────────────────── */

/** Best human label for an element. */
function labelOf(el: ElementRecord): string {
  return el.declaredName ?? el.declaredShortName ?? el.eClass;
}

/** Stringify an attribute value for a cell (empty string when absent). */
function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** The fixed column set of the grid view (a sensible subset per element). */
const GRID_COLUMNS: { key: string; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'metaclass', label: 'Metaclass' },
  { key: 'type', label: 'Type' },
  { key: 'multiplicity', label: 'Multiplicity' },
  { key: 'value', label: 'Value' },
  { key: 'redefines', label: 'Redefines' },
  { key: 'doc', label: 'Doc' },
];

/** The types a feature is typed by / specialises, as a display string. */
function typeCell(model: Model, el: ElementRecord): string {
  const types = model.typesOf(el.id).map((t) => labelOf(t));
  if (types.length) return types.join(', ');
  // Fall back to the plain `attrs.type` string the factory/parser records.
  return str(el.attrs.type);
}

/** Elements this element redefines, as a display string. */
function redefinesCell(model: Model, el: ElementRecord): string {
  const targets = model
    .relationshipsFrom(el.id)
    .filter((r) => r.eClass === 'Redefinition')
    .flatMap((r) => (r.target ?? []).map((t) => model.get(t)).filter(Boolean) as ElementRecord[])
    .map((t) => labelOf(t));
  return targets.join(', ');
}

/** Documentation text for an element (a Documentation/Comment child, or attrs). */
function docCell(model: Model, el: ElementRecord): string {
  for (const child of model.children(el.id)) {
    if (child.eClass === 'Documentation' || child.eClass === 'Comment') {
      const body = str(child.attrs.body);
      if (body) return body;
    }
  }
  return str(el.attrs.text) || str(el.attrs.body);
}

/** Ids in scope: subtree of `rootId` (or whole model), excluding library elements. */
function scopeIds(model: Model, rootId?: ElementId, excludeLibrary = true): Set<ElementId> {
  const ids = rootId
    ? new Set<ElementId>([rootId, ...model.descendants(rootId).map((d) => d.id)])
    : new Set<ElementId>(model.all().map((e) => e.id));
  if (excludeLibrary) {
    for (const id of ids) {
      if (model.get(id)?.attrs.isLibrary === true) ids.delete(id);
    }
  }
  return ids;
}

/* ─────────────────────────────── builder ───────────────────────────────── */

/** Options controlling a {@link buildGrid} projection. */
export interface BuildGridOptions {
  /** Restrict rows to these metaclasses (`eClass`). Omit for all node kinds. */
  kinds?: string[];
  /** Scope the grid to the subtree rooted at this element. */
  rootId?: ElementId;
  /** Exclude bundled standard-library elements (`attrs.isLibrary`). Default `true`. */
  excludeLibrary?: boolean;
}

/**
 * Build the {@link GridModel} for `model`: one row per in-scope element that is
 * a node (not a relationship) and — unless `opts.kinds` is given — of any
 * metaclass, with the fixed {@link GRID_COLUMNS}. Row order follows model
 * declaration order. Library elements are excluded by default.
 */
export function buildGrid(model: Model, opts: BuildGridOptions = {}): GridModel {
  const scope = scopeIds(model, opts.rootId, opts.excludeLibrary ?? true);
  const kindFilter = opts.kinds ? new Set(opts.kinds) : undefined;

  const rows: GridModel['rows'] = [];
  for (const el of model.all()) {
    if (!scope.has(el.id)) continue;
    // Rows are model *elements* — skip relationships and annotation/doc nodes
    // (their content surfaces in the `doc` column of the element they annotate).
    if (isRelationship(el.eClass) || isAnnotation(el.eClass)) continue;
    if (kindFilter && !kindFilter.has(el.eClass)) continue;
    rows.push({
      id: el.id,
      label: labelOf(el),
      cells: {
        name: el.declaredName ?? el.declaredShortName ?? '',
        metaclass: el.eClass,
        type: typeCell(model, el),
        multiplicity: str(el.attrs.multiplicity),
        value: str(el.attrs.value),
        redefines: redefinesCell(model, el),
        doc: docCell(model, el),
      },
    });
  }

  return { columns: GRID_COLUMNS.map((c) => ({ ...c })), rows };
}

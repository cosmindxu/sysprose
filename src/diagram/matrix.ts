/**
 * Traceability / allocation *matrix* builders (allocation view).
 *
 * SysML v2 renders cross-cutting mappings — most notably `allocate` links
 * (function → component), but also `satisfy`, `verify`, `refine`, `trace` and
 * generic dependencies — as a **matrix / table** rather than a node-and-edge
 * graph (docs/02 §4.1: "Allocation (matrix)"). This module projects the
 * {@link Model} into the {@link AllocationMatrix} contract declared in
 * `./types.ts`: rows × columns of model elements with a populated cell wherever
 * a relationship of the requested kind connects a row element to a column
 * element.
 *
 * The generic engine is {@link buildTraceabilityMatrix}; {@link buildAllocationMatrix}
 * is the zero-config convenience that targets `Allocation` relationships and
 * falls back to `Satisfy` when a model has no explicit allocations yet.
 */

import type { ElementId, ElementRecord } from '@core/index';
import { Model } from '@core/index';
import type { AllocationMatrix } from './types';

/* ─────────────────────────────── helpers ───────────────────────────────── */

/** Best human label for an element. */
function labelOf(el: ElementRecord): string {
  return el.declaredName ?? el.declaredShortName ?? el.eClass;
}

/** Normalise a `string | string[]` selector into a `Set`. */
function toSet(v: string | string[]): Set<string> {
  return new Set(Array.isArray(v) ? v : [v]);
}

/**
 * Cell-kind keyword for a relationship metaclass — the `«keyword»` the notation
 * shows for the mapping (mirrors the cross-cutting edge kinds in `build.ts`).
 */
const REL_KEYWORD: Record<string, string> = {
  Allocation: 'allocate',
  Satisfy: 'satisfy',
  Verify: 'verify',
  Refine: 'refine',
  Trace: 'trace',
  Derive: 'derive',
  Dependency: 'dependency',
};

function cellKind(eClass: string): string {
  return REL_KEYWORD[eClass] ?? eClass;
}

/** Ids of the non-library elements in scope (whole model). */
function scopeIds(model: Model, excludeLibrary: boolean): Set<ElementId> {
  const ids = new Set<ElementId>();
  for (const el of model.all()) {
    if (excludeLibrary && el.attrs.isLibrary === true) continue;
    ids.add(el.id);
  }
  return ids;
}

/* ─────────────────────────── generic builder ───────────────────────────── */

/**
 * Build a traceability matrix: rows are in-scope elements whose metaclass is in
 * `fromKind`, columns are in-scope elements whose metaclass is in `toKind`, and
 * a cell `(row, col)` is populated for every relationship whose metaclass is in
 * `relKind` and whose first source endpoint is `row` and first target endpoint
 * is `col`. Library elements (and relationships/cells touching them) are
 * excluded by default. Row and column order follows model declaration order.
 */
export function buildTraceabilityMatrix(
  model: Model,
  fromKind: string | string[],
  toKind: string | string[],
  relKind: string | string[],
  opts: { excludeLibrary?: boolean } = {},
): AllocationMatrix {
  const excludeLibrary = opts.excludeLibrary ?? true;
  const fromSet = toSet(fromKind);
  const toKindSet = toSet(toKind);
  const relSet = toSet(relKind);
  const scope = scopeIds(model, excludeLibrary);

  const rowEls: ElementRecord[] = [];
  const colEls: ElementRecord[] = [];
  for (const el of model.all()) {
    if (!scope.has(el.id)) continue;
    if (fromSet.has(el.eClass)) rowEls.push(el);
    if (toKindSet.has(el.eClass)) colEls.push(el);
  }
  const rowIds = new Set(rowEls.map((e) => e.id));
  const colIds = new Set(colEls.map((e) => e.id));

  const cells: AllocationMatrix['cells'] = [];
  for (const r of model.all()) {
    if (!relSet.has(r.eClass)) continue;
    if (excludeLibrary && r.attrs.isLibrary === true) continue;
    const src = r.source?.[0];
    const tgt = r.target?.[0];
    if (!src || !tgt) continue;
    if (rowIds.has(src) && colIds.has(tgt)) {
      cells.push({ rowId: src, colId: tgt, relId: r.id, kind: cellKind(r.eClass) });
    }
  }

  return {
    rowElements: rowEls.map((e) => ({ id: e.id, label: labelOf(e) })),
    colElements: colEls.map((e) => ({ id: e.id, label: labelOf(e) })),
    cells,
    relKind: [...relSet].join('|'),
  };
}

/* ──────────────────────── allocation convenience ───────────────────────── */

/**
 * Build a matrix from the *actual* endpoints of every `relEClass` relationship
 * in scope: rows are the distinct source elements (first-seen order), columns
 * the distinct target elements. Only endpoints that resolve to non-library
 * elements participate.
 */
function matrixFromEndpoints(
  model: Model,
  scope: Set<ElementId>,
  relEClass: string,
): AllocationMatrix {
  const rowEls: ElementRecord[] = [];
  const colEls: ElementRecord[] = [];
  const rowSeen = new Set<ElementId>();
  const colSeen = new Set<ElementId>();
  const cells: AllocationMatrix['cells'] = [];

  for (const r of model.all()) {
    if (r.eClass !== relEClass) continue;
    if (r.attrs.isLibrary === true) continue;
    const src = r.source?.[0];
    const tgt = r.target?.[0];
    if (!src || !tgt || !scope.has(src) || !scope.has(tgt)) continue;
    const srcEl = model.get(src);
    const tgtEl = model.get(tgt);
    if (!srcEl || !tgtEl) continue;
    if (!rowSeen.has(src)) {
      rowSeen.add(src);
      rowEls.push(srcEl);
    }
    if (!colSeen.has(tgt)) {
      colSeen.add(tgt);
      colEls.push(tgtEl);
    }
    cells.push({ rowId: src, colId: tgt, relId: r.id, kind: cellKind(relEClass) });
  }

  return {
    rowElements: rowEls.map((e) => ({ id: e.id, label: labelOf(e) })),
    colElements: colEls.map((e) => ({ id: e.id, label: labelOf(e) })),
    cells,
    relKind: cellKind(relEClass),
  };
}

/**
 * Convenience allocation matrix: the source × target elements of the model's
 * `Allocation` relationships. When the model has no allocations yet, fall back
 * to a sensible default — the `Satisfy` mapping (satisfier → requirement) — so
 * the allocation view is still meaningful. Library elements are excluded.
 * Returns an empty (but well-formed) matrix when neither mapping exists.
 */
export function buildAllocationMatrix(model: Model): AllocationMatrix {
  const scope = scopeIds(model, true);
  for (const relE of ['Allocation', 'Satisfy']) {
    const m = matrixFromEndpoints(model, scope, relE);
    if (m.cells.length > 0) return m;
  }
  return { rowElements: [], colElements: [], cells: [], relKind: 'allocate' };
}

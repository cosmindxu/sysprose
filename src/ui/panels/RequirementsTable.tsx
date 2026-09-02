/**
 * RequirementsTable — a DOORS-NG / CodeBeamer-style requirements editor, natively
 * bound to the SysML v2 model (the 'requirements' view).
 *
 * MODEL-BACKED (like Explorer): it reads the live {@link Model} and subscribes to
 * `rev` so it re-derives its rows via {@link buildRequirementsTable} on every
 * mutation, and it edits the model IN PLACE through store commands (no
 * projection). Features:
 *  - editable ID / Name / Text cells (commit on blur/Enter, revert on Escape);
 *  - reference columns (Satisfied By / Verified By / Refined By / Traced To /
 *    Derived From) rendered as clickable chips of the related model elements —
 *    click a chip to select the target, ✕ to remove the link (deletes the
 *    backing relationship), + to add a link (picks an element → creates the
 *    relationship with source = element, target = requirement);
 *  - hierarchical requirements (outline numbers, indentation) with add-child;
 *  - add / delete requirement; row ↔ model selection sync.
 */

import { useState } from 'react';
import { useAppStore } from '../store';
import { buildRequirementsTable } from '@diagram/index';
import type { ReqReference, ReqRefColumn, ReqRow } from '@diagram/index';
import { isAnnotation, isRelationship, type ElementId, type ElementRecord } from '@core/index';
import './panels.css';

/** An editable scalar column: which store write applies on commit. */
type ScalarKey = 'reqId' | 'name' | 'text';

export function RequirementsTable(): JSX.Element {
  // Re-render on every model mutation; read the live model directly.
  const rev = useAppStore((s) => s.rev);
  void rev;
  const model = useAppStore((s) => s.model);
  const selectionId = useAppStore((s) => s.selectionId);
  const hoverId = useAppStore((s) => s.hoverId);

  const select = useAppStore((s) => s.select);
  const setHover = useAppStore((s) => s.setHover);
  const createElement = useAppStore((s) => s.createElement);
  const updateElement = useAppStore((s) => s.updateElement);
  const setAttr = useAppStore((s) => s.setAttr);
  const deleteElement = useAppStore((s) => s.deleteElement);
  const connect = useAppStore((s) => s.connect);

  // Which (row, column) scalar cell is being edited, and which (row, refColumn)
  // has its add-link picker open.
  const [editing, setEditing] = useState<{ id: ElementId; col: ScalarKey } | null>(null);
  const [picking, setPicking] = useState<{ id: ElementId; col: string } | null>(null);

  const table = buildRequirementsTable(model);

  /** Candidate elements a requirement may be linked to (non-library, non-relationship, non-annotation, not self). */
  function linkCandidates(reqId: ElementId): ElementRecord[] {
    return model
      .all()
      .filter(
        (e) =>
          e.id !== reqId &&
          e.attrs.isLibrary !== true &&
          !isRelationship(e.eClass) &&
          !isAnnotation(e.eClass) &&
          (e.declaredName || e.attrs.reqId),
      )
      .sort((a, b) => label(a).localeCompare(label(b)));
  }

  function label(el: ElementRecord): string {
    return (
      el.declaredName ?? (el.attrs.reqId as string | undefined) ?? el.declaredShortName ?? el.eClass
    );
  }

  /**
   * Remove ONE (element → requirement) link. A 1:1 relationship is deleted
   * outright; a multi-endpoint relationship (only reachable via JSON/API import)
   * has just this row's endpoint spliced out, so removing a chip on one
   * requirement's row never severs another row's link.
   */
  function unlinkReference(ref: ReqReference, reqRowId: ElementId): void {
    const rel = model.get(ref.relId);
    if (!rel) return;
    const src = rel.source ?? [];
    const tgt = rel.target ?? [];
    if (src.length <= 1 && tgt.length <= 1) deleteElement(ref.relId);
    else if (tgt.length > 1) updateElement(ref.relId, { target: tgt.filter((t) => t !== reqRowId) });
    else updateElement(ref.relId, { source: src.filter((s) => s !== ref.targetId) });
  }

  /** Commit an edited scalar cell to the model. */
  function commitScalar(id: ElementId, col: ScalarKey, raw: string): void {
    const value = col === 'text' ? raw : raw.trim();
    if (col === 'name') updateElement(id, { declaredName: value || undefined });
    else setAttr(id, col, value);
    setEditing(null);
  }

  /** A default owner (package) for a new top-level requirement. */
  function defaultOwner(): ElementId | null {
    const firstReq = table.rows[0];
    if (firstReq) {
      const owner = model.get(firstReq.id)?.ownerId;
      if (owner) return owner;
    }
    const root = model.roots().find((r) => r.attrs.isLibrary !== true);
    return root?.id ?? null;
  }

  function addRequirement(ownerId: ElementId | null): void {
    // Auto-name so a reference link added before the user renames it still
    // serializes to parseable text (a relationship referencing an ANONYMOUS
    // element serializes as `«RequirementUsage»`, which corrupts the Text view).
    const id = createElement('RequirementUsage', ownerId, 'Requirement');
    select(id);
    setEditing({ id, col: 'name' });
  }

  /* ─────────────────────────── cell renderers ──────────────────────────── */

  /** Inner content of a scalar cell — the editor input while editing, else text. */
  function scalarContent(row: ReqRow, col: ScalarKey): JSX.Element {
    const value = col === 'reqId' ? row.reqId : col === 'name' ? row.name : row.text;
    const isEditing = editing?.id === row.id && editing.col === col;
    if (isEditing) {
      return (
        <input
          className="req-cell-input"
          data-testid="req-cell-input"
          autoFocus
          defaultValue={value}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commitScalar(row.id, col, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(null);
            }
          }}
        />
      );
    }
    return (
      <span className={`req-cell-text${value ? '' : ' req-cell-empty'}`}>
        {col === 'name' && <span className="req-kw">«{shortKw(row.eClass)}»</span>}
        {value || placeholderFor(col)}
      </span>
    );
  }

  function referenceCell(row: ReqRow, column: ReqRefColumn): JSX.Element {
    const refs: ReqReference[] = row.refs[column.key] ?? [];
    const isPicking = picking?.id === row.id && picking.col === column.key;
    const kind = column.kinds[0];
    return (
      <div className="req-refcell" data-testid="req-refcell" data-col-key={column.key}>
        <div className="req-chips">
          {refs.map((r) => (
            <span
              key={r.relId + r.targetId}
              className="ref-chip"
              data-testid="req-ref-chip"
              data-rel-id={r.relId}
              data-target-id={r.targetId}
              title={`${r.eClass} — click to select, ✕ to remove`}
              onClick={(e) => {
                e.stopPropagation();
                select(r.targetId);
              }}
            >
              <span className="ref-chip-label">{r.label}</span>
              <button
                className="ref-chip-remove"
                data-testid="req-ref-remove"
                title="Remove link"
                onClick={(e) => {
                  e.stopPropagation();
                  unlinkReference(r, row.id);
                }}
              >
                ✕
              </button>
            </span>
          ))}
          {isPicking ? (
            <select
              className="req-ref-picker"
              data-testid="req-ref-picker"
              autoFocus
              defaultValue=""
              onClick={(e) => e.stopPropagation()}
              onBlur={() => setPicking(null)}
              onChange={(e) => {
                e.stopPropagation();
                const targetElId = e.currentTarget.value;
                if (targetElId) {
                  connect(targetElId, row.id, kind); // source=element, target=requirement
                  // connect() selects the new relationship; keep the requirement
                  // row selected so its highlight doesn't vanish.
                  select(row.id);
                }
                setPicking(null);
              }}
            >
              <option value="" disabled>
                Link {column.label.toLowerCase()}…
              </option>
              {linkCandidates(row.id).map((c) => (
                <option key={c.id} value={c.id}>
                  {label(c)} «{shortKw(c.eClass)}»
                </option>
              ))}
            </select>
          ) : (
            <button
              className="req-ref-add"
              data-testid="req-ref-add"
              title={`Add ${column.label}`}
              onClick={(e) => {
                e.stopPropagation();
                setPicking({ id: row.id, col: column.key });
              }}
            >
              +
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ────────────────────────────── render ───────────────────────────────── */

  return (
    <div className="req-table-wrap" data-testid="requirements-table">
      <div className="req-toolbar">
        <button
          data-testid="req-add-row"
          className="req-ref-add"
          title="Add a top-level requirement"
          onClick={() => addRequirement(defaultOwner())}
        >
          + Requirement
        </button>
        <span className="req-count">{table.rows.length} requirement(s)</span>
      </div>

      {table.rows.length === 0 ? (
        <div className="req-empty">
          No requirements yet. Click <strong>+ Requirement</strong> to add one.
        </div>
      ) : (
        <div className="req-scroll" onMouseLeave={() => setHover(null)}>
          <table className="req-table">
            <thead>
              <tr>
                <th className="req-col-num">#</th>
                {table.scalarColumns.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
                {table.refColumns.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid="req-row"
                  data-element-id={row.id}
                  className={
                    row.id === selectionId
                      ? 'is-selected'
                      : row.id === hoverId
                        ? 'is-hover-linked'
                        : undefined
                  }
                  onClick={() => select(row.id)}
                  onMouseEnter={() => setHover(row.id)}
                >
                  <td className="req-col-num">{row.number}</td>
                  {table.scalarColumns.map((c) => {
                    const key = c.key as ScalarKey;
                    const isEditing = editing?.id === row.id && editing.col === key;
                    return (
                      <td
                        key={c.key}
                        data-testid="req-cell"
                        data-col-key={c.key}
                        className={isEditing ? undefined : 'req-cell-editable'}
                        title={isEditing ? undefined : 'Click to edit'}
                        style={c.key === 'name' ? { paddingLeft: 8 + row.depth * 16 } : undefined}
                        onClick={
                          isEditing
                            ? undefined
                            : (e) => {
                                e.stopPropagation();
                                setEditing({ id: row.id, col: key });
                              }
                        }
                      >
                        {scalarContent(row, key)}
                      </td>
                    );
                  })}
                  {table.refColumns.map((c) => (
                    <td key={c.key}>{referenceCell(row, c)}</td>
                  ))}
                  <td className="req-row-actions">
                    <button
                      data-testid="req-add-child"
                      title="Add nested requirement"
                      onClick={(e) => {
                        e.stopPropagation();
                        addRequirement(row.id);
                      }}
                    >
                      +
                    </button>
                    <button
                      className="req-del"
                      data-testid="req-delete"
                      title="Delete requirement"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteElement(row.id);
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** A compact metaclass keyword for the chip/name hint. */
function shortKw(eClass: string): string {
  return eClass.replace(/Definition$/, ' def').replace(/Usage$/, '');
}

function placeholderFor(col: ScalarKey): string {
  return col === 'reqId' ? '(id)' : col === 'name' ? '(unnamed)' : '(no text)';
}

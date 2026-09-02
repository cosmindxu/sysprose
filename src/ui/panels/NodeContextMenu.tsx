/**
 * NodeContextMenu — a right-click menu on a diagram node, bringing the common
 * model-editing actions (rename / add child / delete) onto the canvas so the
 * user doesn't have to round-trip through the Explorer tree. Also offers
 * "Zoom to" (fit the node in view). Closes on an action, an outside click, or
 * Escape. Positioned at the cursor (fixed to the viewport).
 */

import { useEffect, useRef, useState } from 'react';
import {
  DEFINITION_KINDS,
  USAGE_KINDS,
  CONTROL_NODE_KINDS,
  ANNOTATION_KINDS,
  TEXTUAL_KEYWORD,
  type ElementId,
} from '@core/index';
import { useAppStore } from '../store';
import { useContextMenuChrome } from './useContextMenuChrome';
import { useRovingMenu } from './useRovingMenu';

/** Grouped metaclass choices for the "add child / add element" pickers. */
export const PICKER_GROUPS: Array<{ label: string; kinds: readonly string[] }> = [
  { label: 'Definitions', kinds: DEFINITION_KINDS },
  { label: 'Usages', kinds: USAGE_KINDS },
  { label: 'Control nodes', kinds: CONTROL_NODE_KINDS },
  { label: 'Annotations', kinds: ANNOTATION_KINDS },
];

export const keywordFor = (eClass: string): string => TEXTUAL_KEYWORD[eClass] ?? eClass;

export function NodeContextMenu(props: {
  x: number;
  y: number;
  elementId: ElementId;
  /** Opened on an edge (relationship/connection) → only Delete applies. */
  isEdge: boolean;
  onClose: () => void;
  onFit: (elementId: ElementId) => void;
}): JSX.Element | null {
  const { x, y, elementId, isEdge, onClose, onFit } = props;
  const rev = useAppStore((s) => s.rev);
  void rev;
  const model = useAppStore((s) => s.model);
  const updateElement = useAppStore((s) => s.updateElement);
  const deleteElement = useAppStore((s) => s.deleteElement);
  const createElement = useAppStore((s) => s.createElement);
  const duplicateElement = useAppStore((s) => s.duplicateElement);
  const selectionCount = useAppStore((s) => s.selectionIds.length);
  const deleteSelection = useAppStore((s) => s.deleteSelection);
  const setDiagramRoot = useAppStore((s) => s.setDiagramRoot);
  const diagramRootId = useAppStore((s) => s.diagramRootId);
  const duplicateSelection = useAppStore((s) => s.duplicateSelection);
  const copySelection = useAppStore((s) => s.copySelection);
  const pasteClipboard = useAppStore((s) => s.pasteClipboard);
  const hasClipboard = useAppStore((s) => s.clipboard != null);
  // A multi-selection (>1) turns Duplicate/Delete into bulk actions over the set.
  const multi = !isEdge && selectionCount > 1;

  const [renaming, setRenaming] = useState(false);
  const { ref, pos } = useContextMenuChrome(x, y, onClose);
  useRovingMenu(ref, onClose);

  // When an inline rename ends (cancel or commit), return focus into the menu so
  // roving keyboard nav keeps working (the unmounting input otherwise drops focus
  // to <body>). Only on the true→false transition, not the initial mount.
  const prevRenaming = useRef(renaming);
  useEffect(() => {
    if (prevRenaming.current && !renaming) {
      ref.current?.querySelector<HTMLElement>('[data-testid="node-ctx-rename"]')?.focus();
    }
    prevRenaming.current = renaming;
  }, [renaming, ref]);

  // If the target element is deleted by any means while the menu is open, close.
  const gone = !model.get(elementId);
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  const el = model.get(elementId);
  if (!el) return null;
  const label = el.declaredName || el.declaredShortName || `«${keywordFor(el.eClass)}»`;

  const commitRename = (value: string): void => {
    const v = value.trim();
    if (v && v !== (el.declaredName ?? '')) updateElement(elementId, { declaredName: v });
    onClose();
  };

  return (
    <div
      ref={ref}
      className="node-ctx-menu"
      data-testid="node-ctx-menu"
      role="group"
      aria-label={`${label} actions`}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="node-ctx-title" title={`«${keywordFor(el.eClass)}» ${label}`}>
        {label}
      </div>
      {!isEdge &&
        (renaming ? (
          <input
            className="node-ctx-rename-input"
            data-testid="node-ctx-rename-input"
            autoFocus
            defaultValue={el.declaredName ?? ''}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(e.currentTarget.value);
              else if (e.key === 'Escape') {
                e.stopPropagation();
                setRenaming(false);
              }
            }}
            onBlur={(e) => commitRename(e.currentTarget.value)}
          />
        ) : (
          <button
            className="node-ctx-item"
            data-menuitem=""
            data-testid="node-ctx-rename"
            onClick={() => setRenaming(true)}
          >
            <span className="node-ctx-ico" aria-hidden="true">✎︎</span>Rename…
          </button>
        ))}

      {!isEdge && (
        <label className="node-ctx-add">
          <span><span className="node-ctx-ico" aria-hidden="true">＋</span>Add child</span>
          <select
            className="node-ctx-add-select"
            data-testid="node-ctx-add"
            defaultValue=""
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const k = e.currentTarget.value;
              if (k) createElement(k, elementId);
              onClose();
            }}
          >
            <option value="" disabled>
              Kind…
            </option>
            {PICKER_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.kinds.map((k) => (
                  <option key={k} value={k}>
                    {keywordFor(k)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}

      {!isEdge && (
        <button
          className="node-ctx-item"
          data-menuitem=""
          data-testid="node-ctx-copy"
          onClick={() => {
            copySelection();
            onClose();
          }}
        >
          <span className="node-ctx-ico" aria-hidden="true">⧉</span>
          {multi ? `Copy ${selectionCount}` : 'Copy'}
        </button>
      )}

      {!isEdge && hasClipboard && (
        <button
          className="node-ctx-item"
          data-menuitem=""
          data-testid="node-ctx-paste"
          onClick={() => {
            pasteClipboard(elementId);
            onClose();
          }}
        >
          <span className="node-ctx-ico" aria-hidden="true">▤</span>Paste into
        </button>
      )}

      {!isEdge && (
        <button
          className="node-ctx-item"
          data-menuitem=""
          data-testid="node-ctx-duplicate"
          onClick={() => {
            if (multi) duplicateSelection();
            else duplicateElement(elementId);
            onClose();
          }}
        >
          <span className="node-ctx-ico" aria-hidden="true">⊕</span>
          {multi ? `Duplicate ${selectionCount}` : 'Duplicate'}
        </button>
      )}

      {!isEdge && (
        <button
          className="node-ctx-item"
          data-menuitem=""
          data-testid="node-ctx-fit"
          onClick={() => {
            onFit(elementId);
            onClose();
          }}
        >
          <span className="node-ctx-ico" aria-hidden="true">⊙</span>Zoom to
        </button>
      )}

      {/* Scope: draw only this element's subtree. Zooming makes a node bigger;
          scoping removes everything that is not part of it, which is what an
          internal block diagram of one assembly actually means. */}
      {!isEdge && (
        <button
          className="node-ctx-item"
          data-menuitem=""
          data-testid="node-ctx-scope"
          onClick={() => {
            setDiagramRoot(elementId);
            onClose();
          }}
        >
          <span className="node-ctx-ico" aria-hidden="true">⊞</span>Scope diagram to this
        </button>
      )}

      {diagramRootId !== null && (
        <button
          className="node-ctx-item"
          data-menuitem=""
          data-testid="node-ctx-scope-clear"
          onClick={() => {
            setDiagramRoot(null);
            onClose();
          }}
        >
          <span className="node-ctx-ico" aria-hidden="true">⊟</span>Show whole model
        </button>
      )}
      <button
        className="node-ctx-item node-ctx-danger"
        data-menuitem=""
        data-testid="node-ctx-delete"
        onClick={() => {
          if (multi) deleteSelection();
          else deleteElement(elementId);
          onClose();
        }}
      >
        <span className="node-ctx-ico" aria-hidden="true">✕</span>
        {multi ? `Delete ${selectionCount}` : 'Delete'}
      </button>
    </div>
  );
}

export default NodeContextMenu;

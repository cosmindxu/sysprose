/**
 * Explorer — the containment (ownership) tree of the live {@link Model}.
 *
 * Renders roots → children recursively with expand/collapse twisties, a
 * «keyword» metaclass badge per row, click-to-select, inline rename, delete,
 * an "add child" metaclass picker, and HTML5 drag-to-reparent. It reads the
 * model directly and subscribes to `rev` so it re-renders on every mutation.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  DEFINITION_KINDS,
  USAGE_KINDS,
  CONTROL_NODE_KINDS,
  ANNOTATION_KINDS,
  TEXTUAL_KEYWORD,
  type ElementId,
  type ElementRecord,
} from '@core/index';
import { useAppStore } from '../store';

/** MIME-ish key used to carry the dragged element id between rows. */
const DRAG_KEY = 'application/x-sysml-element-id';

/** Grouped metaclass choices for the "add child" picker. */
const PICKER_GROUPS: Array<{ label: string; kinds: readonly string[] }> = [
  { label: 'Definitions', kinds: DEFINITION_KINDS },
  { label: 'Usages', kinds: USAGE_KINDS },
  { label: 'Control nodes', kinds: CONTROL_NODE_KINDS },
  { label: 'Annotations', kinds: ANNOTATION_KINDS },
];

/** Human label for a metaclass: prefer the textual keyword, fall back to eClass. */
function keywordFor(eClass: string): string {
  return TEXTUAL_KEYWORD[eClass] ?? eClass;
}

/**
 * A compact monochrome type glyph per metaclass CATEGORY — replaces the verbose
 * «keyword» text in the row (the full keyword moves to the row's tooltip),
 * making the tree denser and faster to scan. Order matters: the specific
 * categories are tested before the generic Definition/Usage fallbacks.
 */
function iconFor(eClass: string): string {
  const e = eClass;
  const has = (kinds: readonly string[]): boolean => kinds.includes(e);
  if (e === 'Package' || e === 'Namespace' || e.endsWith('Package')) return '▤';
  if (e.includes('Port')) return '◻';
  if (e.includes('Requirement')) return '◈';
  if (e.includes('Constraint')) return 'ƒ';
  if (e.includes('State')) return '◉';
  if (e.includes('Action') || e === 'Step' || has(CONTROL_NODE_KINDS)) return '▷';
  if (
    e.includes('Connection') ||
    e.includes('Interface') ||
    e.includes('Flow') ||
    e.includes('Binding')
  )
    return '⇄';
  if (e.includes('Attribute') || e.includes('Item')) return '▪';
  if (has(ANNOTATION_KINDS) || e === 'Comment' || e === 'Documentation') return '✎';
  if (has(DEFINITION_KINDS) || e.endsWith('Definition')) return '◆';
  if (has(USAGE_KINDS) || e.endsWith('Usage')) return '▭';
  return '·';
}

/** Display label for a tree row. */
function rowLabel(el: ElementRecord): string {
  return el.declaredName || el.declaredShortName || `«${el.eClass}»`;
}

/**
 * One row of the containment tree — a self-contained recursive component (H5).
 *
 * It subscribes to the store through NARROW per-row selectors (name, eClass,
 * flags, child ids via `useShallow`), so a mutation re-renders only the rows
 * whose own data actually changed instead of the whole tree. Row handlers are
 * store actions (stable references); transient UI state (rename input,
 * drag-over, add-child picker, subtree focus) lives in the store for the same
 * reason.
 */
function TreeRow({
  id,
  depth,
  filtering,
  visibleIds,
  matchedIds,
  peers,
  scrollRef,
}: {
  id: ElementId;
  depth: number;
  filtering: boolean;
  visibleIds: Set<ElementId> | null;
  matchedIds: Set<ElementId>;
  peers: readonly { color: string; name: string; clientId: number; selection: ElementId | null }[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
}): JSX.Element | null {
  const name = useAppStore((s) => s.model.get(id)?.declaredName);
  const shortName = useAppStore((s) => s.model.get(id)?.declaredShortName);
  const eClass = useAppStore((s) => s.model.get(id)?.eClass);
  const isLibrary = useAppStore((s) => s.model.get(id)?.attrs.isLibrary === true);
  const childIds = useAppStore(useShallow((s) => s.model.childIds(id)));
  const expanded = useAppStore((s) => s.expandedIds.has(id));
  const selected = useAppStore((s) => s.selectionIds.includes(id) || s.selectionId === id);
  const isRenaming = useAppStore((s) => s.renamingId === id);
  const isDropTarget = useAppStore((s) => s.dragOverId === id);
  const isPickerOpen = useAppStore((s) => s.pickerId === id);
  const isHoverLinked = useAppStore((s) => s.hoverId === id && s.selectionId !== id);
  const select = useAppStore((s) => s.select);
  const setHover = useAppStore((s) => s.setHover);
  const toggleExpand = useAppStore((s) => s.toggleExpand);
  const expand = useAppStore((s) => s.expand);
  const createElement = useAppStore((s) => s.createElement);
  const updateElement = useAppStore((s) => s.updateElement);
  const deleteElement = useAppStore((s) => s.deleteElement);
  const reparent = useAppStore((s) => s.reparent);
  const setRenamingId = useAppStore((s) => s.setRenamingId);
  const setDragOverId = useAppStore((s) => s.setDragOverId);
  const setPickerId = useAppStore((s) => s.setPickerId);
  const setFocusId = useAppStore((s) => s.setFocusId);

  // The element may have been deleted: render nothing until the parent's
  // child-ids selector removes this row. Hooks above run unconditionally.
  if (eClass === undefined) return null;

  const label = name || shortName || `«${eClass}»`;
  const filteredChildren = filtering && visibleIds ? childIds.filter((c) => visibleIds.has(c)) : childIds;
  const hasChildren = filteredChildren.length > 0;
  const childrenOpen = filtering ? true : expanded;
  const isMatch = filtering && matchedIds.has(id);
  const remote = peers.find((p) => p.selection === id);

  const commitRename = (value: string): void => {
    setRenamingId(null);
    const trimmed = value.trim();
    const st = useAppStore.getState();
    const current = st.model.get(id);
    if (current && trimmed !== (current.declaredName ?? '')) {
      updateElement(id, { declaredName: trimmed || undefined });
    }
  };

  return (
    <div className="tree-branch">
      <div
        className={`tree-node${selected ? ' is-selected' : ''}${
          isDropTarget ? ' is-drop-target' : ''
        }${isLibrary ? ' is-library' : ''}${remote ? ' has-remote-selection' : ''}${
          isMatch ? ' is-match' : ''
        }${isHoverLinked ? ' is-hover-linked' : ''}`}
        data-testid="tree-node"
        data-elementid={id}
        data-remote-selected={remote ? remote.color : undefined}
        data-remote-clientid={remote ? remote.clientId : undefined}
        title={remote ? `Selected by ${remote.name}` : `«${keywordFor(eClass)}»`}
        style={{
          paddingLeft: 8 + depth * 14,
          ...(remote ? { boxShadow: `inset 3px 0 0 0 ${remote.color}` } : null),
        }}
        draggable={!isRenaming}
        onMouseEnter={() => setHover(id)}
        onClick={(e) => {
          select(id, { additive: e.shiftKey || e.ctrlKey || e.metaKey });
          scrollRef.current?.focus({ preventScroll: true }); // enable arrow-key nav after a click
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setRenamingId(id);
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_KEY, id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (useAppStore.getState().dragOverId !== id) setDragOverId(id);
        }}
        onDragLeave={() => {
          if (useAppStore.getState().dragOverId === id) setDragOverId(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOverId(null);
          const dragId = e.dataTransfer.getData(DRAG_KEY);
          if (dragId && dragId !== id) reparent(dragId, id);
        }}
      >
        <span
          className="tree-twisty"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) toggleExpand(id);
          }}
        >
          {hasChildren ? (childrenOpen ? '▾' : '▸') : ''}
        </span>
        <span className="tree-icon" aria-hidden>
          {iconFor(eClass)}
        </span>
        {isRenaming ? (
          <input
            data-testid="tree-rename"
            className="tree-rename-input"
            autoFocus
            defaultValue={name ?? ''}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => commitRename(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(e.currentTarget.value);
              else if (e.key === 'Escape') setRenamingId(null);
            }}
          />
        ) : (
          <span className="tree-label">{label}</span>
        )}
        {remote && (
          <span
            className="tree-remote-badge"
            data-testid="tree-remote-selection"
            data-clientid={remote.clientId}
            style={{ background: remote.color }}
            title={`Selected by ${remote.name}`}
          />
        )}
        <span className="tree-actions">
          <button
            data-testid="tree-focus"
            title="Focus on this subtree"
            onClick={(e) => {
              e.stopPropagation();
              setFocusId(id);
              expand(id, true);
              select(id);
            }}
          >
            ◎
          </button>
          <button
            data-testid="tree-add"
            title="Add child element"
            onClick={(e) => {
              e.stopPropagation();
              setPickerId(isPickerOpen ? null : id);
            }}
          >
            +
          </button>
          <button
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              setRenamingId(id);
            }}
          >
            ✎
          </button>
          <button
            data-testid="tree-delete"
            title="Delete element"
            onClick={(e) => {
              e.stopPropagation();
              deleteElement(id);
            }}
          >
            ✕
          </button>
        </span>
      </div>

      {isPickerOpen && (
        <div className="tree-picker" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
          <select
            className="tree-picker-select"
            autoFocus
            defaultValue=""
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const eClass = e.currentTarget.value;
              setPickerId(null);
              if (eClass) createElement(eClass, id);
            }}
            onBlur={() => setPickerId(null)}
          >
            <option value="" disabled>
              Add child…
            </option>
            {PICKER_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.kinds.map((k) => (
                  <option key={k} value={k}>
                    {keywordFor(k)} ({k})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}

      {childrenOpen && hasChildren && (
        <div
          className="tree-children"
          style={{ ['--guide-x' as string]: `${8 + depth * 14 + 6}px` }}
        >
          {filteredChildren.map((cid) => (
            <TreeRow
              key={cid}
              id={cid}
              depth={depth + 1}
              filtering={filtering}
              visibleIds={visibleIds}
              matchedIds={matchedIds}
              peers={peers}
              scrollRef={scrollRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Explorer(): JSX.Element {
  // Re-render trigger + stable model instance.
  const rev = useAppStore((s) => s.rev);
  const model = useAppStore((s) => s.model);
  const selectionId = useAppStore((s) => s.selectionId);
  const expandedIds = useAppStore((s) => s.expandedIds);
  const peers = useAppStore((s) => s.collab.peers);
  const focusId = useAppStore((s) => s.focusId);
  const dragOverId = useAppStore((s) => s.dragOverId);

  const select = useAppStore((s) => s.select);
  const setHover = useAppStore((s) => s.setHover);
  const setDragOverId = useAppStore((s) => s.setDragOverId);
  const setFocusId = useAppStore((s) => s.setFocusId);
  const expand = useAppStore((s) => s.expand);
  const reparent = useAppStore((s) => s.reparent);

  const [filter, setFilter] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // `rev` is read so the component re-renders on model mutations.
  void rev;

  // Reveal the current selection wherever it comes from (canvas, requirements
  // table, Problems, API): expand every ancestor so the row mounts, then scroll
  // it into view after that expansion has rendered. Keyed on `selectionId` ALONE
  // (not `expandedIds`) so an unrelated expand/collapse never scroll-jacks the
  // viewport back to the selection.
  useEffect(() => {
    if (!selectionId || !model.get(selectionId)) return;
    // If a focus (subtree scope) is active and the new selection lies OUTSIDE it,
    // drop the focus so the selection is revealable rather than stranded.
    if (
      focusId &&
      selectionId !== focusId &&
      !model.ancestors(selectionId).some((a) => a.id === focusId)
    ) {
      setFocusId(null);
    }
    for (const anc of model.ancestors(selectionId)) expand(anc.id, true);
    const raf = requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector(
        `[data-elementid="${CSS.escape(selectionId)}"]`,
      ) as HTMLElement | null;
      row?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionId]);

  // Roots to show: when FOCUSED, just that element's subtree (scope-to-subtree);
  // otherwise the user model always + the (huge) standard library only when
  // toggled on — off by default so the tree isn't a 38k-row haystack.
  const focusEl = focusId ? model.get(focusId) : undefined;
  const roots = focusEl
    ? [focusEl]
    : model.roots().filter((r) => showLibrary || r.attrs.isLibrary !== true);

  // Live filter: match rows by name / short name / metaclass keyword. When active,
  // show only matches PLUS their ancestors (so the path stays visible) and force
  // every shown branch open. Bounded to the currently-visible roots.
  const q = filter.trim().toLowerCase();
  const { visibleIds, matchedIds } = useMemo(() => {
    if (!q) return { visibleIds: null as Set<ElementId> | null, matchedIds: new Set<ElementId>() };
    const visible = new Set<ElementId>();
    const matched = new Set<ElementId>();
    const hit = (el: ElementRecord): boolean =>
      `${rowLabel(el)} ${keywordFor(el.eClass)} ${el.declaredShortName ?? ''}`
        .toLowerCase()
        .includes(q);
    const walk = (id: ElementId): boolean => {
      const el = model.get(id);
      if (!el) return false;
      let anyChild = false;
      for (const cid of model.childIds(id)) if (walk(cid)) anyChild = true;
      const self = hit(el);
      if (self) matched.add(id);
      if (self || anyChild) {
        visible.add(id);
        return true;
      }
      return false;
    };
    for (const r of roots) walk(r.id);
    return { visibleIds: visible, matchedIds: matched };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, rev, showLibrary]);
  const filtering = visibleIds !== null;

  const shownRoots = filtering ? roots.filter((r) => visibleIds!.has(r.id)) : roots;

  // Flat, in-render-order list of the currently-visible row ids (mirrors
  // renderNode's traversal) — the basis for arrow-key navigation.
  const visibleOrder = useMemo(() => {
    const out: ElementId[] = [];
    const seen = new Set<ElementId>(); // guard a malformed ownership cycle
    const walk = (id: ElementId): void => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push(id);
      const all = model.childIds(id);
      const kids = filtering ? all.filter((c) => visibleIds!.has(c)) : all;
      if ((filtering ? true : expandedIds.has(id)) && kids.length) for (const c of kids) walk(c);
    };
    for (const r of shownRoots) walk(r.id);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownRoots, model, filtering, visibleIds, expandedIds, rev]);

  // Arrow-key navigation over the visible tree: ↑/↓ move the selection, →
  // expands (or descends into the first child), ← collapses (or ascends to the
  // parent). Attached to the focusable tree container.
  const onTreeKeyDown = (e: import('react').KeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return; // rename input keeps its arrows
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    e.preventDefault();
    const order = visibleOrder;
    if (order.length === 0) return;
    const idx = selectionId ? order.indexOf(selectionId) : -1;
    if (idx < 0) {
      // Selection isn't in the visible list (e.g. an ancestor was collapsed) —
      // land on its nearest visible ancestor, else the top row.
      const anc = selectionId
        ? model.ancestors(selectionId).find((a) => order.includes(a.id))
        : undefined;
      select(anc ? anc.id : order[0]);
      return;
    }
    const cur = order[idx];
    const hasKids = model.childIds(cur).length > 0;
    const isOpen = filtering || expandedIds.has(cur);
    switch (e.key) {
      case 'ArrowDown':
        if (idx < order.length - 1) select(order[idx + 1]);
        break;
      case 'ArrowUp':
        if (idx > 0) select(order[idx - 1]);
        break;
      case 'ArrowRight':
        if (hasKids && !isOpen) expand(cur, true);
        else if (idx < order.length - 1) select(order[idx + 1]);
        break;
      case 'ArrowLeft':
        if (hasKids && isOpen && !filtering) expand(cur, false);
        else {
          const owner = model.get(cur)?.ownerId;
          if (owner && order.includes(owner)) select(owner);
        }
        break;
    }
  };
  /** Drop on the panel's empty/header space → reparent the dragged element to root. */
  const onRootDragOver = (e: React.DragEvent): void => {
    e.preventDefault();
    if (dragOverId !== 'root') setDragOverId('root');
  };
  const onRootDrop = (e: React.DragEvent): void => {
    setDragOverId(null);
    const dragId = e.dataTransfer.getData(DRAG_KEY);
    // Drop on empty space reparents to the top of what's VISIBLE: the focus
    // element when scoped, else the model root.
    if (dragId) reparent(dragId, focusId ?? null);
  };
  return (
    <div data-testid="explorer" className="explorer" onDragOver={onRootDragOver} onDrop={onRootDrop}>
      <div className="explorer-head">
        <div className="explorer-head-row">
          <span className="panel-title panel-title-inline">Explorer</span>
          <label
            className={`explorer-libtoggle${focusEl ? ' is-disabled' : ''}`}
            title={
              focusEl
                ? 'Clear the focus (Show all) to toggle the standard library'
                : 'Show the bundled standard-library packages'
            }
          >
            <input
              type="checkbox"
              data-testid="explorer-library-toggle"
              checked={showLibrary}
              disabled={!!focusEl}
              onChange={(e) => setShowLibrary(e.currentTarget.checked)}
            />
            Library
          </label>
        </div>
        <div className="explorer-search">
          <span className="explorer-search-icon" aria-hidden>
            ⌕
          </span>
          <input
            data-testid="explorer-search"
            className="explorer-search-input"
            placeholder="Search elements…"
            value={filter}
            aria-label="Filter the explorer tree"
            onChange={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilter('');
            }}
          />
          {filtering && (
            <span className="explorer-search-count" data-testid="explorer-search-count">
              {matchedIds.size}
            </span>
          )}
        </div>
        {focusEl && (
          <div className="explorer-focus" data-testid="explorer-focus">
            <span className="explorer-focus-icon" aria-hidden>
              ◎
            </span>
            <span className="explorer-focus-name" title={`Focused on «${keywordFor(focusEl.eClass)}» ${rowLabel(focusEl)}`}>
              {rowLabel(focusEl)}
            </span>
            <button
              className="explorer-focus-clear"
              data-testid="explorer-focus-clear"
              title="Show the whole tree"
              onClick={() => setFocusId(null)}
            >
              Show all
            </button>
          </div>
        )}
      </div>
      <div
        ref={scrollRef}
        className="explorer-tree"
        data-testid="explorer-tree"
        tabIndex={0}
        role="tree"
        onKeyDown={onTreeKeyDown}
        onMouseLeave={() => setHover(null)}
      >
        {shownRoots.length === 0 ? (
          <div className="panel-empty">
            {filtering ? 'No matches.' : 'No elements. Use New or add a root.'}
          </div>
        ) : (
          shownRoots.map((r) => (
            <TreeRow
              key={r.id}
              id={r.id}
              depth={0}
              filtering={filtering}
              visibleIds={visibleIds}
              matchedIds={matchedIds}
              peers={peers}
              scrollRef={scrollRef}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default Explorer;

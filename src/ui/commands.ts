/**
 * Command-palette / keyboard-shortcut definitions.
 *
 * Each {@link Command} is a thin, declarative wrapper over a {@link useAppStore}
 * action so the toolbar, a command palette, and the global keydown handler can
 * all drive the same surface without duplicating logic. `run` reads the live
 * store via `useAppStore.getState()` so commands are safe to invoke from any
 * context (React or plain DOM event handlers).
 */

import { useAppStore } from './store';
import type { ViewKind } from '@diagram/index';
import type { ModelFormat } from '@persistence/index';

/** A single invokable command. */
export interface Command {
  /** Stable command id (matches the related toolbar data-testid where one exists). */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Optional keyboard hint, e.g. 'Ctrl+Z'. */
  shortcut?: string;
  /** Perform the command against the live store. */
  run(): void | Promise<void>;
}

/** The default project name used by the "New" command. */
const DEFAULT_PROJECT_NAME = 'NewModel';

/** All toolbar/keyboard commands, in display order. */
export const COMMANDS: Command[] = [
  {
    id: 'tb-new',
    label: 'New',
    shortcut: 'Ctrl+N',
    run: () => useAppStore.getState().newProject(DEFAULT_PROJECT_NAME),
  },
  {
    id: 'tb-save',
    label: 'Save',
    shortcut: 'Ctrl+S',
    run: () => useAppStore.getState().saveProject(),
  },
  {
    id: 'tb-export-sysml',
    label: 'Export .sysml',
    run: () => {
      useAppStore.getState().exportModel('sysml' as ModelFormat);
    },
  },
  {
    id: 'tb-export-json',
    label: 'Export JSON',
    run: () => {
      useAppStore.getState().exportModel('model-json' as ModelFormat);
    },
  },
  {
    id: 'tb-validate',
    label: 'Validate',
    run: () => useAppStore.getState().runValidation(),
  },
  {
    id: 'tb-check',
    label: 'Check',
    run: () => useAppStore.getState().runConstraintCheck(),
  },
  {
    id: 'tb-layout',
    label: 'Auto-layout',
    run: () => useAppStore.getState().rebuildDiagram(),
  },
  {
    id: 'tb-undo',
    label: 'Undo',
    shortcut: 'Ctrl+Z',
    run: () => useAppStore.getState().undo(),
  },
  {
    id: 'tb-redo',
    label: 'Redo',
    shortcut: 'Ctrl+Y',
    run: () => useAppStore.getState().redo(),
  },
];

/** The view-switch commands, paired with their toolbar data-testids. */
export const VIEW_COMMANDS: Array<{ id: string; label: string; view: ViewKind }> = [
  { id: 'tb-view-general', label: 'General', view: 'general' },
  { id: 'tb-view-interconnection', label: 'Interconnection', view: 'interconnection' },
  { id: 'tb-view-action', label: 'Action', view: 'action' },
  { id: 'tb-view-state', label: 'State', view: 'state' },
  { id: 'tb-view-requirement', label: 'Requirement', view: 'requirement' },
  { id: 'tb-view-tree', label: 'Tree', view: 'tree' },
];

/** Look a command up by id. */
export function commandById(id: string): Command | undefined {
  return COMMANDS.find((c) => c.id === id);
}

/**
 * Plain digit → primary-view hotkeys (no modifier). Keyed to the six most-used
 * views so a user can flip between them without reaching for the view tabs.
 */
const VIEW_HOTKEYS: Record<string, ViewKind> = {
  '1': 'general',
  '2': 'interconnection',
  '3': 'action',
  '4': 'state',
  '5': 'requirement',
  '6': 'tree',
};

/** Move keyboard focus to the Explorer search box, if it is mounted. */
function focusExplorerSearch(): boolean {
  const el = document.querySelector<HTMLInputElement>('[data-testid="explorer-search"]');
  if (!el) return false;
  el.focus();
  el.select();
  return true;
}

/**
 * Global keyboard handler — wire to `window` keydown. Returns true when a
 * shortcut was handled (so callers can `preventDefault`).
 *
 * The App-level listener already suppresses this while the user is typing in an
 * input / textarea / select / contenteditable, so the plain-key shortcuts below
 * (Delete, digits, `/`) are safe from swallowing real text entry.
 */
export function handleShortcut(e: KeyboardEvent): boolean {
  const store = useAppStore.getState();

  // --- Plain-key shortcuts (no Ctrl/Cmd/Alt) -------------------------------
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    // Delete / Backspace → remove the current selection. React Flow's own
    // delete is disabled (deleteKeyCode={null}) so this is the single path,
    // keeping the model and the diagram in sync.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // Guard the *destructive* keys when a focusable control (button / link)
      // holds focus: after clicking any toolbar / mini-toolbar / menu button
      // that button keeps DOM focus, and a reflex Backspace must NOT silently
      // delete (and cascade-delete) the selection. Non-destructive shortcuts
      // below stay live in that state.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'BUTTON' || tag === 'A') return false;
      if (store.selectionIds.length > 0) {
        store.deleteSelection();
        return true;
      }
      return false;
    }
    // `/` → jump to the Explorer search box (GitHub-style).
    if (e.key === '/') {
      return focusExplorerSearch();
    }
    // Digit → switch to a primary view.
    const view = VIEW_HOTKEYS[e.key];
    if (view) {
      store.setActiveView(view);
      return true;
    }
    return false;
  }

  // --- Ctrl/Cmd shortcuts --------------------------------------------------
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return false;
  const key = e.key.toLowerCase();
  switch (key) {
    case 'z':
      if (e.shiftKey) store.redo();
      else store.undo();
      return true;
    case 'y':
      store.redo();
      return true;
    case 's':
      void store.saveProject();
      return true;
    case 'd':
      // Duplicate the selection (deep-clone as a sibling). preventDefault stops
      // the browser's Ctrl/Cmd+D bookmark action.
      if (store.selectionIds.length > 0) {
        store.duplicateSelection();
        return true;
      }
      return false;
    case 'c':
      // Copy the selected subtrees — unless the user is copying page text
      // (a non-empty text selection), in which case defer to native copy.
      if (store.selectionIds.length > 0 && !window.getSelection()?.toString()) {
        store.copySelection();
        return true;
      }
      return false;
    case 'v':
      // Paste the clipboard under the current selection.
      if (store.clipboard) {
        store.pasteClipboard();
        return true;
      }
      return false;
    default:
      return false;
  }
}

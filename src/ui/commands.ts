/**
 * Command-palette / keyboard-shortcut definitions.
 *
 * Each {@link Command} is a thin, declarative wrapper over a {@link useAppStore}
 * action so the toolbar, a command palette, and the global keydown handler can
 * all drive the same surface without duplicating logic. `run` reads the live
 * store via `useAppStore.getState()` so commands are safe to invoke from any
 * context (React or plain DOM event handlers).
 */

import { flushSync } from 'react-dom';
import {
  applyTypedTextToSave,
  driveDirty,
  forcedRecomputePending,
  sayWhatTheBrowserKept,
  sayWhatTheExportKept,
  useAppStore,
  type AppState,
} from './store';
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

/**
 * The attached Google Drive file lacks something of the model: what Save to
 * Drive is for. An edit whose recompute is still waiting has not reached the
 * text yet, so it counts.
 */
function driveUnsaved(store: AppState): boolean {
  return store.drive.file !== null && (driveDirty(store) || forcedRecomputePending());
}

/**
 * Save, as the Save button and Ctrl/Cmd+S do it — the key anywhere on the
 * page, in a field too (`handlePageKey`): the project in this browser — and,
 * while the attached Google Drive file lacks something of the model, that
 * file too. A student who presses Save and later finds nothing in Drive is
 * the one loss the Drive strip alone cannot prevent. With no Drive file, or
 * one that holds the model already, it is the browser save it always was.
 *
 * Save stores the MODEL, and text typed in the Text view and not applied is
 * not the model yet: it is applied first, so the save holds what is on screen
 * (`applyTypedTextToSave`), under the open project's name. Not a text with a
 * parse error — the parser's recovery of it is not what is on screen, and
 * would overwrite the last good copy in this browser — and not in a
 * collaboration room, where applying it would replace the room's model for
 * every peer: the model is saved as it stands, the editor still reads "not
 * yet applied", and with no Drive file attached the strip under the toolbar
 * says the typed text was kept back (`sayWhatTheBrowserKept`). A save to the
 * attached Drive file applies a faulted text for its upload, as Save to Drive
 * does, and keeps the browser copy as the model stood before.
 */
export function runSave(): Promise<void> {
  const kept = applyTypedTextToSave();
  const store = useAppStore.getState();
  if (driveUnsaved(store)) return store.driveSave({ alsoInBrowser: true });
  return store.saveProject().then(() => sayWhatTheBrowserKept(kept));
}

/**
 * Export ▾ → SysML, the menu's and the command's: the model's text, so text
 * typed in the Text view and not applied is applied first, as Save does
 * (`applyTypedTextToSave`) — the file holds what is on screen, and the apply
 * is one Undo step, as Apply's — and kept back for Save's reasons: over a
 * parse error, and in a collaboration room. The file then holds the model
 * as it stands, and the strip under the toolbar says the typed text is not
 * in it (`sayWhatTheExportKept`) — unless the export wrote nothing: a model
 * the serializer refuses is named where the Text view shows it. Returns the
 * text exported ('' for none).
 */
export function runExportSysml(): string {
  const kept = applyTypedTextToSave();
  const text = useAppStore.getState().exportModel('sysml');
  // A refusal returns '' and records why; an empty model's text is '' too.
  if (text !== '' || useAppStore.getState().serializeError === null) sayWhatTheExportKept(kept);
  return text;
}

/**
 * Save to Drive, as Ctrl/Cmd+Shift+S does it: the attached file when it lacks
 * something of the model, the Save-as form when no file is attached — and
 * nothing for a file that holds the model already, as the panel's Save to
 * Drive is disabled then: no new revision in Drive's history, no sign-in
 * window after the hour, no question about a layout nothing would rewrite.
 */
export function runDriveSave(): Promise<void> {
  const store = useAppStore.getState();
  return store.drive.file === null || driveUnsaved(store) ? store.driveSave() : Promise.resolve();
}

/** All toolbar/keyboard commands, in display order. */
export const COMMANDS: Command[] = [
  {
    // No `shortcut` here: this command carried a `Ctrl+N` label that
    // `handleShortcut` never handled, so the app's own command table advertised
    // a key that did nothing. A label is a claim about behaviour, and
    // `test/unit/user-guide.test.ts` now fails on a declared shortcut the
    // handler does not receive — Ctrl+N is also the browser's own new-window
    // chord, which is why wiring it instead was not the fix.
    id: 'tb-new',
    label: 'New',
    // As the toolbar's New: asked first when the model has unsaved work.
    run: () =>
      useAppStore.getState().driveGuard('New', 'dirty', () => useAppStore.getState().newProject(DEFAULT_PROJECT_NAME)),
  },
  {
    id: 'tb-save',
    label: 'Save',
    shortcut: 'Ctrl+S',
    run: () => runSave(),
  },
  {
    // Google Drive (optional). On a deployment without it this does nothing,
    // and its key is left to the browser (see `handleShortcut`). With no Drive
    // file attached it opens the Save-as form.
    id: 'tb-drive-save',
    label: 'Save to Drive',
    shortcut: 'Ctrl+Shift+S',
    run: () => runDriveSave(),
  },
  {
    id: 'tb-export-sysml',
    label: 'Export .sysml',
    run: () => {
      runExportSysml();
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
    run: () => useAppStore.getState().autoLayout(),
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
 * Global keyboard handler — the page's listener (`handlePageKey`) calls it.
 * Returns true when a shortcut was handled (so callers can `preventDefault`).
 *
 * The page's listener hands on no key typed into an input / textarea / select /
 * contenteditable but the two save keys, so the plain-key shortcuts below
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
      // Ctrl/Cmd+Shift+S → Save to Drive (the Save-as form when no Drive file
      // is attached). Without Google Drive on this deployment the key is not
      // this app's, and the browser keeps it.
      if (e.shiftKey) {
        if (store.drive.configStatus === 'ready') {
          void runDriveSave();
          return true;
        }
        return false;
      }
      void runSave();
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

/**
 * Whether `e` is one of the app's save keys: Ctrl/Cmd+S, and Ctrl/Cmd+Shift+S
 * on a deployment with Google Drive — without Drive that one is the browser's
 * (`handleShortcut`).
 */
function isSaveKey(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return false;
  return !e.shiftKey || useAppStore.getState().drive.configStatus === 'ready';
}

/** The field a key was typed into — an input, a text area, a select, an editable element — or null. */
function fieldOf(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable === true) return el;
  return null;
}

/**
 * Where the focus goes when Ctrl/Cmd+S closed the box it was typed in (a
 * rename, a table cell): to the Save button, as a click on it leaves the focus.
 * Left to fall to the page, the next keys would be the page's — Backspace or
 * Delete would remove the selection, often the element just renamed, and a
 * digit would switch the view — while a button is one the destructive keys
 * leave alone (`handleShortcut`). A control that holds the focus already, a
 * button, a link or another field, keeps it.
 */
function focusSave(): void {
  const active = document.activeElement;
  const tag = active?.tagName;
  if (tag === 'BUTTON' || tag === 'A' || fieldOf(active) !== null) return;
  document.querySelector<HTMLElement>('[data-testid="tb-save"]')?.focus({ preventScroll: true });
}

/**
 * Commit what was typed into `field` and not written yet, as leaving the field
 * does, and give the field its focus back. Properties writes Subject, Tags,
 * Type and the requirement attributes on Enter or on leaving the box, not per
 * keystroke — as do the Explorer's rename, the Requirements table's cells and
 * the planning and regrouping boxes — so a save from inside one would miss the
 * value on screen.
 *
 * The blur renders before focus goes back (`flushSync`): a requirement
 * attribute's box is rebuilt around the value it wrote, and the caret goes
 * into the new box where it was in the old one. A box the commit closes — a
 * rename — stays closed, as Enter leaves it, and the focus goes to Save
 * (`focusSave`). A select writes on change, a read-only box holds nothing
 * typed (the Drive strip's link box goes away on blur), and leaving a box
 * marked `data-blur-cancels` throws away what was typed (the Requirements
 * table's reference picker): none of them is touched.
 */
function commitField(field: HTMLElement): void {
  if (
    field.tagName === 'SELECT' ||
    (field as HTMLInputElement).readOnly === true ||
    field.dataset.blurCancels !== undefined
  )
    return;
  const parent = field.parentElement;
  const testid = field.dataset.testid;
  const typed = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null;
  const caret = typed ? { start: typed.selectionStart, end: typed.selectionEnd } : null;
  flushSync(() => field.blur());
  // The box itself, or the one rebuilt in its place: the same test id, under the same parent.
  const rebuilt = (el: Element): el is HTMLElement => el instanceof HTMLElement && el.dataset.testid === testid;
  const back = field.isConnected
    ? field
    : parent?.isConnected && testid !== undefined
      ? (Array.from(parent.children).find(rebuilt) ?? null)
      : null;
  if (back === null) {
    focusSave();
    return;
  }
  back.focus({ preventScroll: true });
  if (
    back !== field &&
    caret?.start != null &&
    caret.end != null &&
    (back instanceof HTMLInputElement || back instanceof HTMLTextAreaElement)
  ) {
    const length = back.value.length;
    back.setSelectionRange(Math.min(caret.start, length), Math.min(caret.end, length));
  }
}

/**
 * The page's keydown listener (`App` puts it on `window`).
 *
 * Out of a field every key is `handleShortcut`'s. A key typed into a field is
 * the field's — a digit, Delete, Ctrl/Cmd+Z and the rest — but for the save
 * keys: Ctrl/Cmd+S is the app's Save anywhere on the page, and Ctrl/Cmd+Shift+S
 * its Save to Drive where the deployment has Google Drive, so the browser's own
 * "Save page" dialog never opens over the app. A save from a field holds what
 * was typed there: the field is committed first, as leaving it does
 * (`commitField`); text typed in the Text view's editor the save applies
 * itself (`runSave`).
 */
export function handlePageKey(e: KeyboardEvent): void {
  const field = fieldOf(e.target);
  if (field === null) {
    if (handleShortcut(e)) e.preventDefault();
    return;
  }
  if (!isSaveKey(e)) return;
  // Taken before the commit runs: whatever a field does on leaving, the
  // browser's dialog stays shut.
  e.preventDefault();
  commitField(field);
  handleShortcut(e);
}

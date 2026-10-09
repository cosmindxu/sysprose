import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { Model } from '@core/index';
import { bindModelToDoc } from '../../src/collab/model-doc';

// The store kicks off an async standard-library merge at module load; stub it so
// the singleton model stays deterministic for these reducer tests (finding C12).
// A test can hold a load open — each load awaits the next queued promise — to
// make two of them overlap (`whenLibrarySettled`), and can give the merge a
// body that changes the model, as the real merge does.
const lib = vi.hoisted(() => ({
  holds: [] as Promise<void>[],
  merge: null as ((model: Model) => void) | null,
}));
vi.mock('../../src/library/full-library', () => ({
  loadFullStandardLibrary: (model: Model) => lib.merge?.(model),
  preloadFullLibrary: async () => {
    await lib.holds.shift();
  },
}));
vi.mock('../../src/library/standard-library', () => ({
  loadCuratedLibrary: () => {},
}));

// No relay under Vitest: a collab session here is its document and its
// awareness, and the transport does nothing (no socket, no IndexedDB). What
// runs is the store's own collab wiring — its model listener above all. The
// latest session's status listener is kept, so a test can say the relay came
// up (or went away), as the real transport would; and its document, so a test
// can sync a peer's document with it, as the relay would.
const relay = vi.hoisted(() => ({
  status: null as ((e: { status: string }) => void) | null,
  doc: null as import('yjs').Doc | null,
}));
vi.mock('../../src/collab/provider', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/collab/provider')>();
  const { Awareness } = await import('y-protocols/awareness');
  return {
    ...mod,
    connect: (doc: ConstructorParameters<typeof Awareness>[0]) => {
      relay.doc = doc;
      const awareness = new Awareness(doc);
      return {
        provider: {
          on: (event: string, listener: (e: { status: string }) => void) => {
            if (event === 'status') relay.status = listener;
          },
          off: () => {},
        },
        awareness,
        persistence: null,
        disconnect: () => awareness.destroy(),
      };
    },
  };
});

// Installed before the store module is imported (vi.hoisted runs first), so a
// fetch the module makes ON IMPORT is recorded — the Drive boot must make none.
const fetchSpy = vi.hoisted(() => vi.spyOn(globalThis, 'fetch'));

import {
  DRIVE_MESSAGES,
  bootDrive,
  browserDirty,
  checkFileName,
  driveBeforeUnload,
  driveDirty,
  driveFileName,
  driveLink,
  driveMessage,
  flushRecompute,
  forcedRecomputePending,
  initialDriveState,
  lastAppliedText,
  mergeLoads,
  openText,
  pageLinks,
  recomputePending,
  setDriveServices,
  useAppStore,
  whenLibrarySettled,
  withFinalNewline,
  type AppState,
} from '../../src/ui/store';
import {
  DRIVE_SCOPE,
  DRIVE_UPLOAD_MAX_BYTES,
  DriveBadResponseError,
  DriveError,
  DriveForbiddenError,
  DriveNetworkError,
  FakeDriveAuth,
  FakeDrivePicker,
  InMemoryDriveGateway,
  LocalStorageStore,
  createGisPopupAuth,
  exportModel,
  type DriveConfig,
  type GisTokenResponse,
  type GoogleNs,
} from '@persistence/index';
import { parseModel, serializeModel } from '@text/index';
import {
  NOTE_BODY_TERMINATOR,
  getRequirementAttr,
  requirementShortId,
  statementKindOf,
} from '@semantics/index';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { commandById, handleShortcut, runSave } from '../../src/ui/commands';
import { TextEditor } from '../../src/ui/panels/TextEditor';

/** The Drive slice as the module left it on import, before any test touched it. */
const driveOnImport = useAppStore.getState().drive;

/** Reset the singleton store to a fresh, empty model before each test. */
function reset(): void {
  useAppStore.setState({
    model: new Model(),
    undoStack: [],
    redoStack: [],
    selectionId: null,
    selectionIds: [],
    drive: initialDriveState,
  });
}

const st = () => useAppStore.getState();

describe('useAppStore — reducers / undo-redo (C12)', () => {
  beforeEach(reset);

  it('createElement adds an element, bumps rev, and pushes an undo snapshot', () => {
    const before = st().rev;
    const id = st().createElement('PartDefinition', null, 'Widget');
    expect(st().model.get(id)?.declaredName).toBe('Widget');
    expect(st().model.get(id)?.eClass).toBe('PartDefinition');
    expect(st().undoStack.length).toBe(1);
    expect(st().rev).toBeGreaterThan(before);
  });

  /**
   * The store is the backstop for every caller that is not a panel.
   *
   * A note body is written into the file with no escaping and the notation
   * gives the sequence that ends a note no escape, so a value carrying it
   * cannot be saved — and must therefore not be stored. The panels ask first
   * and put the reason on the box; this refuses the same value for the
   * diagram, the API console and anything else holding the command, and it
   * refuses BEFORE the undo snapshot so a refused write costs no undo step.
   */
  it('setAttr refuses a note body the file could not hold, without spending an undo step', () => {
    const id = st().createElement('Documentation', null);
    st().setAttr(id, 'body', 'a real note');
    const undos = st().undoStack.length;

    st().setAttr(id, 'body', `a ${NOTE_BODY_TERMINATOR} b`);
    expect(st().model.get(id)?.attrs.body, 'the refused value was not stored').toBe('a real note');
    expect(st().undoStack.length, 'a refused write is not an undo step').toBe(undos);
  });

  it('setAttr refuses a requirement statement carrying it, and allows it elsewhere', () => {
    const req = st().createElement('RequirementUsage', null, 'R');
    st().setAttr(req, 'text', `a ${NOTE_BODY_TERMINATOR} b`);
    expect(st().model.get(req)?.attrs.text, 'a requirement statement is written as a note').toBeUndefined();

    // On anything else `attrs.text` is never emitted as a note, so refusing it
    // would be a refusal with no defect behind it.
    const part = st().createElement('PartUsage', null, 'p');
    st().setAttr(part, 'text', `a ${NOTE_BODY_TERMINATOR} b`);
    expect(st().model.get(part)?.attrs.text).toBe(`a ${NOTE_BODY_TERMINATOR} b`);
  });

  /**
   * What the Text view is allowed to say when the model cannot be written.
   *
   * The refusals above cover the panels and the store command, but a model can
   * still arrive already carrying an unwritable note body — a model-JSON
   * import, the element-graph API. The serializer then throws, and the throw
   * used to be swallowed into the empty string: the Text tab showed an EMPTY
   * document, the status strip still said "in sync with model", and one click
   * on "Apply text → model" replaced the whole model with nothing. An empty
   * document that claims to be the model is exactly the silent wrong answer
   * this codebase refuses.
   */
  describe('a model that cannot be written as text', () => {
    /** A model whose Documentation body carries the sequence that ends a note. */
    function poison(): void {
      const id = st().createElement('PartDefinition', null, 'Engine');
      const doc = st().createElement('Documentation', id);
      st().setAttr(doc, 'body', 'a real note');
      st().regenerateText();
      // Straight onto the model — the element-graph API and a model-JSON import
      // both reach the serializer without passing the store's refusal.
      st().model.setAttrs(doc, { body: `bad ${NOTE_BODY_TERMINATOR} part def Ghost; doc /*` });
    }

    it('keeps the last text it could write, and says why it is not the model', () => {
      poison();
      const before = st().textBuffer;
      expect(before, 'the good text was written first').toContain('Engine');

      st().regenerateText();
      expect(st().textBuffer, 'an empty document is not the model').toBe(before);
      expect(st().serializeError, 'the Text view says what happened').toContain(
        NOTE_BODY_TERMINATOR,
      );
    });

    it('refuses "Apply text → model" while the text is not the model', () => {
      poison();
      st().regenerateText();
      // The buffer is now BEHIND the model: this element was added after the
      // last text that could be written, so it exists nowhere in the buffer.
      // Applying it would delete it — which is what "one click replaces the
      // model with a text that never described it" costs in practice.
      st().createElement('PartDefinition', null, 'Gearbox');

      st().applyText();
      expect(
        st().model.all().some((e) => e.declaredName === 'Gearbox'),
        'one click must not replace the model with a stale text',
      ).toBe(true);
    });

    it('still applies a text the user actually typed — the way out of the state', () => {
      // The refusal is over the buffer NOBODY typed into. A text the author
      // edited is their explicit intent, and re-applying it is how the model
      // stops carrying the thing that could not be written; refusing that too
      // would leave the state with no exit but a page reload.
      poison();
      st().regenerateText();
      st().setTextBuffer('package Q {\n    part def B;\n}\n');

      st().applyText();
      expect(st().model.all().some((e) => e.declaredName === 'B'), 'the edit was applied').toBe(
        true,
      );
      expect(st().serializeError, 'the model can be written again').toBeNull();
    });

    it('exportModel refuses instead of throwing into the click handler', () => {
      poison();
      let text: string | undefined;
      expect(() => {
        text = st().exportModel('sysml');
      }, 'a React click handler has nothing to catch this').not.toThrow();
      expect(text, 'nothing is offered for download').toBe('');
      expect(st().serializeError).toContain(NOTE_BODY_TERMINATOR);
    });

    it('clears the refusal once the model can be written again', () => {
      poison();
      st().regenerateText();
      expect(st().serializeError).not.toBeNull();

      const doc = st().model.all().find((e) => e.eClass === 'Documentation')!;
      st().setAttr(doc.id, 'body', 'fixed');
      st().regenerateText();
      expect(st().serializeError).toBeNull();
      expect(st().textBuffer).toContain('fixed');
    });
  });

  /**
   * Export ▾ → SysML used to write every root, the merged standard library
   * after the user's packages. Text carries no `isLibrary` flag, so the
   * exported file imported back as the user's — and the library was merged a
   * second time beside it.
   */
  it('Export ▾ → SysML writes the Text view’s text, never the merged library, and imports back to the same model', async () => {
    const merge = lib.merge;
    lib.merge = (m) => {
      if (!m.all().some((e) => e.attrs.isLibrary === true)) {
        m.create('Package', { declaredName: 'ScalarValues', attrs: { isLibrary: true } });
      }
    };
    const roots = () =>
      st()
        .model.roots()
        .map((r) => `${r.declaredName}${r.attrs.isLibrary === true ? ' (library)' : ''}`);
    try {
      st().importModel('package Swarm {\n    part def Drone;\n}', 'sysml');
      await whenLibrarySettled();
      expect(roots(), 'the library merged after the user’s package').toEqual([
        'Swarm',
        'ScalarValues (library)',
      ]);

      const text = st().exportModel('sysml');
      expect(text, 'what the Text view shows').toBe(st().textBuffer);
      expect(text).toContain('part def Drone;');
      expect(text).not.toContain('ScalarValues');

      st().importModel(text, 'sysml');
      await whenLibrarySettled();
      expect(roots(), 'one library, and still the library').toEqual(['Swarm', 'ScalarValues (library)']);
      expect(st().diagnostics.filter((d) => d.ruleId === 'parse')).toEqual([]);
      expect(st().exportModel('sysml')).toBe(text);
    } finally {
      lib.merge = merge;
    }
  });

  it('setAttr and updateElement mutate the element', () => {
    const id = st().createElement('AttributeUsage', null, 'mass');
    st().setAttr(id, 'value', 1500);
    expect(st().model.get(id)?.attrs.value).toBe(1500);
    st().updateElement(id, { declaredName: 'weight' });
    expect(st().model.get(id)?.declaredName).toBe('weight');
  });

  it('deleteElement removes the element from the model', () => {
    const id = st().createElement('PartUsage', null, 'gone');
    expect(st().model.get(id)).toBeDefined();
    st().deleteElement(id);
    expect(st().model.get(id)).toBeUndefined();
  });

  it('undo restores the prior model state; redo re-applies it', () => {
    const id = st().createElement('PartDefinition', null, 'Temp');
    expect(st().model.get(id)).toBeDefined();
    const sizeAfterCreate = st().model.size;

    st().undo();
    expect(st().model.all().some((e) => e.declaredName === 'Temp')).toBe(false);

    st().redo();
    expect(st().model.all().some((e) => e.declaredName === 'Temp')).toBe(true);
    expect(st().model.size).toBe(sizeAfterCreate);
  });

  it('reparent moves an element under a new owner', () => {
    const pkg = st().createElement('Package', null, 'Pkg');
    const part = st().createElement('PartDefinition', null, 'P');
    st().reparent(part, pkg);
    expect(st().model.get(part)?.ownerId).toBe(pkg);
  });

  it('reparentMany moves several elements under one owner in a single undo step', () => {
    const pkg = st().createElement('Package', null, 'Pkg');
    const a = st().createElement('PartDefinition', null, 'A');
    const b = st().createElement('PartDefinition', null, 'B');
    const undoBefore = st().undoStack.length;
    st().reparentMany([a, b], pkg);
    expect(st().model.get(a)?.ownerId).toBe(pkg);
    expect(st().model.get(b)?.ownerId).toBe(pkg);
    expect(st().undoStack.length).toBe(undoBefore + 1); // ONE snapshot for both
    st().undo();
    expect(st().model.get(a)?.ownerId).toBe(null);
    expect(st().model.get(b)?.ownerId).toBe(null);
  });

  it('reparentMany skips illegal (cycle) members but applies the legal ones', () => {
    const parent = st().createElement('Package', null, 'Parent');
    const child = st().createElement('Package', parent, 'Child');
    const other = st().createElement('PartDefinition', null, 'Other');
    // Reparenting `parent` under its own `child` is a cycle → skipped; `other`
    // moves under `child` fine. Net: one legal move, one undo snapshot.
    st().reparentMany([parent, other], child);
    expect(st().model.get(parent)?.ownerId).toBe(null); // unchanged (cycle)
    expect(st().model.get(other)?.ownerId).toBe(child); // moved
  });

  it('reparentMany with only no-op moves neither mutates nor pushes an undo', () => {
    const pkg = st().createElement('Package', null, 'Pkg');
    const a = st().createElement('PartDefinition', pkg, 'A'); // already under pkg
    const undoBefore = st().undoStack.length;
    const revBefore = st().rev;
    st().reparentMany([a], pkg);
    expect(st().undoStack.length).toBe(undoBefore); // no snapshot
    expect(st().rev).toBe(revBefore); // no mutation
  });

  it('reparentMany reduces to subtree roots — a parent+child set moves the subtree whole', () => {
    const parent = st().createElement('Package', null, 'Parent');
    const child = st().createElement('PartDefinition', parent, 'Child'); // under parent
    const dest = st().createElement('Package', null, 'Dest');
    // Dragging both parent AND its child onto dest must move only the subtree
    // root; child stays under parent (not flattened into a sibling of parent).
    st().reparentMany([parent, child], dest);
    expect(st().model.get(parent)?.ownerId).toBe(dest);
    expect(st().model.get(child)?.ownerId).toBe(parent); // NOT dest
  });

  it('reparentMany with an all-illegal set preserves undo AND redo history', () => {
    const parent = st().createElement('Package', null, 'Parent');
    const mid = st().createElement('Package', parent, 'Mid');
    const grandchild = st().createElement('Package', mid, 'Grand');
    // Seed a redo entry: make an edit, then undo it.
    const temp = st().createElement('PartDefinition', null, 'Temp');
    st().deleteElement(temp);
    st().undo(); // Temp restored; redoStack now has one entry
    expect(st().redoStack.length).toBe(1);
    const undoBefore = st().undoStack.length;
    const revBefore = st().rev;
    // Reparent parent under its own grandchild → cycle → every move fails.
    st().reparentMany([parent], grandchild);
    expect(st().model.get(parent)?.ownerId).toBe(null); // unchanged
    expect(st().undoStack.length).toBe(undoBefore); // snapshot rolled back
    expect(st().rev).toBe(revBefore); // no mutation
    expect(st().redoStack.length).toBe(1); // redo history NOT destroyed
  });

  it('connect creates a relationship edge between two elements', () => {
    const a = st().createElement('PartUsage', null, 'a');
    const b = st().createElement('PartUsage', null, 'b');
    const before = st().model.size;
    st().connect(a, b, 'ConnectionUsage');
    expect(st().model.size).toBeGreaterThan(before);
    const edge = st().model.all().find((e) => e.eClass === 'ConnectionUsage');
    expect(edge).toBeDefined();
    expect(edge?.source?.[0]).toBe(a);
    expect(edge?.target?.[0]).toBe(b);
  });

  it('saveScenario / loadScenario / deleteScenario snapshot the regroup config', () => {
    st().setRegroupConfig({ membership: { p: 'b1' }, bundles: [{ id: 'b1', label: 'B1', isNew: true }] });
    st().saveScenario('one');
    expect(Object.keys(st().scenarios)).toContain('one');

    st().setRegroupConfig({ membership: { p: 'b2' } }); // change live config
    expect(st().regroupConfig.membership.p).toBe('b2');

    st().loadScenario('one'); // restores the snapshot
    expect(st().regroupConfig.membership.p).toBe('b1');

    // Snapshot is a deep copy — mutating the live config doesn't touch it.
    st().setRegroupConfig({ membership: { p: 'b3' } });
    expect(st().scenarios.one.membership.p).toBe('b1');

    st().deleteScenario('one');
    expect(st().scenarios.one).toBeUndefined();
  });

  it('select updates the selection id', () => {
    const id = st().createElement('PartDefinition', null, 'Sel');
    st().select(id);
    expect(st().selectionId).toBe(id);
  });

  it('duplicateElement deep-clones a subtree in exactly one undo step', () => {
    const car = st().createElement('PartDefinition', null, 'Car');
    st().createElement('PartUsage', car, 'engine');
    st().createElement('PartUsage', car, 'wheel');
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;

    const clone = st().duplicateElement(car);
    expect(clone).toBeTruthy();
    expect(st().model.size).toBe(sizeBefore + 3); // Car + engine + wheel
    expect(st().selectionId).toBe(clone); // selection follows the clone
    expect(st().model.get(clone!)?.declaredName).toBe('Car copy');
    expect(st().undoStack.length).toBe(undoBefore + 1); // single undo entry

    st().undo(); // one step restores the pre-duplicate model
    expect(st().model.size).toBe(sizeBefore);
    expect(st().model.all().some((e) => e.declaredName === 'Car copy')).toBe(false);
  });

  it('select additive toggles the multi-selection set; primary follows', () => {
    const a = st().createElement('PartUsage', null, 'a');
    const b = st().createElement('PartUsage', null, 'b');
    const c = st().createElement('PartUsage', null, 'c');

    st().select(a); // plain click → single
    expect(st().selectionIds).toEqual([a]);
    expect(st().selectionId).toBe(a);

    st().select(b, { additive: true }); // extend
    st().select(c, { additive: true });
    expect(new Set(st().selectionIds)).toEqual(new Set([a, b, c]));
    expect(st().selectionId).toBe(c); // primary = last toggled

    st().select(b, { additive: true }); // toggle b OFF
    expect(new Set(st().selectionIds)).toEqual(new Set([a, c]));

    st().select(a); // plain click → collapses to single
    expect(st().selectionIds).toEqual([a]);
  });

  it('setSelection replaces the selection with a deduped, live set (primary = last)', () => {
    const a = st().createElement('PartUsage', null, 'a');
    const b = st().createElement('PartUsage', null, 'b');
    const c = st().createElement('PartUsage', null, 'c');

    st().setSelection([a, b, b, c]); // dup b
    expect(st().selectionIds).toEqual([a, b, c]);
    expect(st().selectionId).toBe(c); // primary = last

    st().deleteElement(b);
    st().setSelection([a, b, c]); // b is gone → dropped
    expect(st().selectionIds).toEqual([a, c]);
    expect(st().selectionId).toBe(c);
  });

  it('deleteSelection removes every selected element in one undo step', () => {
    const a = st().createElement('PartUsage', null, 'a');
    const b = st().createElement('PartUsage', null, 'b');
    const c = st().createElement('PartUsage', null, 'c');
    st().select(a);
    st().select(b, { additive: true });
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;

    st().deleteSelection(); // removes a + b, keeps c
    expect(st().model.size).toBe(sizeBefore - 2);
    expect(st().model.get(c)).toBeDefined();
    expect(st().selectionIds).toEqual([]);
    expect(st().undoStack.length).toBe(undoBefore + 1); // one undo entry

    st().undo();
    expect(st().model.size).toBe(sizeBefore); // both restored in one step
  });

  it('duplicateSelection clones each top-level selection; skips a nested descendant', () => {
    const car = st().createElement('PartDefinition', null, 'Car');
    const engine = st().createElement('PartUsage', car, 'engine'); // descendant of Car
    const wheel = st().createElement('PartUsage', null, 'wheel');
    st().select(car);
    st().select(engine, { additive: true }); // engine is under Car → should be dropped
    st().select(wheel, { additive: true });
    const sizeBefore = st().model.size;

    st().duplicateSelection();
    // Car (+ engine child) = 2 new, wheel = 1 new; engine NOT cloned standalone.
    expect(st().model.size).toBe(sizeBefore + 3);
    // Two new roots selected (Car copy, wheel copy).
    expect(st().selectionIds.length).toBe(2);
    expect(st().model.all().filter((e) => e.declaredName === 'engine').length).toBe(2); // original + the clone under Car copy
  });

  it('copySelection + pasteClipboard clones under the target in one undo step', () => {
    const src = st().createElement('PartDefinition', null, 'Src');
    st().createElement('PartUsage', src, 'child');
    const dst = st().createElement('PartDefinition', null, 'Dst');

    st().select(src);
    st().copySelection();
    expect(st().clipboard).not.toBeNull();

    st().select(dst);
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;
    const roots = st().pasteClipboard(); // paste under the primary selection (dst)
    expect(roots.length).toBe(1);
    expect(st().model.size).toBe(sizeBefore + 2); // Src + child
    expect(st().model.get(roots[0])?.ownerId).toBe(dst);
    expect(st().selectionIds).toEqual(roots);
    expect(st().undoStack.length).toBe(undoBefore + 1);

    st().undo();
    expect(st().model.size).toBe(sizeBefore); // one-step undo
  });

  it('duplicateElement refuses a relationship (keyboard matches the node-only menu)', () => {
    const a = st().createElement('PartUsage', null, 'a');
    const b = st().createElement('PartUsage', null, 'b');
    const rel = st().connect(a, b, 'Dependency'); // a relationship metaclass
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;

    expect(st().duplicateElement(rel)).toBeNull();
    expect(st().model.size).toBe(sizeBefore); // no clone created
    expect(st().undoStack.length).toBe(undoBefore); // no undo entry pushed
  });

  it('setRequirementAttr writes a facet in ONE undo step, whatever it costs in elements', () => {
    const req = st().createElement('RequirementUsage', null, 'maxMass');
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;

    st().setRequirementAttr(req, 'status', 'open');
    // A carrier and an attribute: two new elements, one undo entry.
    expect(st().model.size).toBe(sizeBefore + 2);
    expect(st().undoStack.length).toBe(undoBefore + 1);
    expect(getRequirementAttr(st().model, req, 'status')).toBe('open');

    st().undo();
    expect(st().model.size).toBe(sizeBefore);
    expect(getRequirementAttr(st().model, req, 'status')).toBeUndefined();
  });

  it('setRequirementAttr refuses a value the key does not allow, leaving no phantom undo step', () => {
    const req = st().createElement('RequirementUsage', null, 'maxMass');
    st().setRequirementAttr(req, 'risk', 'high');
    // Give the store a redo entry to protect: undo, then redo, then a bad write.
    st().undo();
    const redoBefore = st().redoStack.length;
    expect(redoBefore).toBeGreaterThan(0);
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    st().setRequirementAttr(req, 'risk', 'extreme');
    errors.mockRestore();

    expect(st().model.size).toBe(sizeBefore); // nothing written
    expect(st().undoStack.length).toBe(undoBefore); // no phantom step
    expect(st().redoStack.length).toBe(redoBefore); // redo history survives
  });

  it('setRequirementAttr clears a facet, and the kind rides on the declaration', () => {
    const req = st().createElement('RequirementUsage', null, 'maxMass');
    st().setRequirementAttr(req, 'owner', 'chief engineer');
    st().setRequirementAttr(req, 'statementKind', 'prose');
    expect(st().model.get(req)?.attrs.metadata).toEqual(['prose']);

    st().setRequirementAttr(req, 'owner', '');
    expect(getRequirementAttr(st().model, req, 'owner')).toBeUndefined();
    // The carrier went with the last facet it held.
    expect(st().model.ofKind('MetadataUsage')).toHaveLength(0);
    expect(getRequirementAttr(st().model, req, 'statementKind')).toBe('prose');
  });

  it('setRequirementAttr does nothing at all when a clear would clear nothing', () => {
    const req = st().createElement('RequirementUsage', null, 'maxMass');
    st().setRequirementAttr(req, 'status', 'open');
    // Give the store a redo entry to protect, as the refusal test does.
    st().undo();
    const redoBefore = st().redoStack.length;
    expect(redoBefore).toBeGreaterThan(0);
    const sizeBefore = st().model.size;
    const undoBefore = st().undoStack.length;

    st().setRequirementAttr(req, 'owner', ''); // 'owner' was never set
    st().setRequirementAttr(req, 'statementKind', ''); // no keyword to remove

    expect(st().model.size).toBe(sizeBefore);
    expect(st().undoStack.length).toBe(undoBefore); // no step spent on a no-op
    expect(st().redoStack.length).toBe(redoBefore); // and redo survives it
  });

  it('setRequirementAttr leaves a library requirement alone — undo could not take it back', () => {
    const model = st().model;
    const libPkg = model.create('Package', { declaredName: 'Lib', attrs: { isLibrary: true } });
    const libReq = model.create('RequirementUsage', {
      declaredName: 'LibReq',
      ownerId: libPkg.id,
      attrs: { isLibrary: true },
    });
    const undoBefore = st().undoStack.length;

    st().setRequirementAttr(libReq.id, 'status', 'open');
    st().setRequirementAttr(libReq.id, 'statementKind', 'prose');

    expect(getRequirementAttr(st().model, libReq.id, 'status')).toBeUndefined();
    // `resetPreserving(snap, isLibraryEl)` keeps library elements verbatim, so a
    // keyword written here would have outlived its own undo step.
    expect(st().model.get(libReq.id)?.attrs.metadata).toBeUndefined();
    expect(st().undoStack.length).toBe(undoBefore);
  });

  /**
   * The id edit used to go through `setAttr(id, 'reqId', …)`, which writes the
   * legacy slot the serializer only falls back to: the grid showed the new id,
   * the Text tab kept the old one, and the saved file reverted the edit.
   */
  it('setRequirementShortId writes the slot the file keeps, in one undo step', () => {
    const { model } = parseModel(
      'package P {\n    requirement <R1> maxMass {\n        doc /* body */\n    }\n}',
    );
    useAppStore.setState({ model });
    const req = model.ofKind('RequirementUsage')[0]!.id;
    const undoBefore = st().undoStack.length;

    st().setRequirementShortId(req, 'R9');
    expect(requirementShortId(st().model, req)).toBe('R9');
    expect(st().model.require(req).attrs.reqId).toBeUndefined();
    const text = serializeModel(st().model);
    expect(text).toContain('<R9>');
    expect(text).not.toContain('<R1>');
    expect(st().undoStack.length).toBe(undoBefore + 1);

    // The same value again is not a change and spends no undo step.
    st().setRequirementShortId(req, 'R9');
    expect(st().undoStack.length).toBe(undoBefore + 1);

    st().undo();
    expect(requirementShortId(st().model, req)).toBe('R1');
    expect(serializeModel(st().model)).toContain('<R1>');
  });

  it('setRequirementShortId leaves a library requirement alone, and refuses a non-requirement', () => {
    const model = st().model;
    const libPkg = model.create('Package', { declaredName: 'Lib', attrs: { isLibrary: true } });
    const libReq = model.create('RequirementUsage', {
      declaredName: 'LibReq',
      declaredShortName: 'L1',
      ownerId: libPkg.id,
      attrs: { isLibrary: true },
    });
    const part = model.create('PartUsage', { declaredName: 'p' });
    const undoBefore = st().undoStack.length;
    st().setRequirementShortId(libReq.id, 'L2');
    st().setRequirementShortId(part.id, 'X');
    expect(st().model.require(libReq.id).declaredShortName).toBe('L1');
    expect(st().model.require(part.id).declaredShortName).toBeUndefined();
    expect(st().undoStack.length).toBe(undoBefore);
  });

  /**
   * The grid commits on blur whether or not a key was pressed, and the
   * writer reads `''` as "clear". Compared on the raw slot, a blank `<''>` id
   * — displayed as '' — looked like a change, and clicking into the cell and
   * away rewrote the author's file without the `<''>`.
   */
  it('setRequirementShortId leaves a blank <\'\'> id alone when the value it shows comes back', () => {
    const src = "package P {\n    requirement <''> r;\n}";
    const { model } = parseModel(src);
    useAppStore.setState({ model });
    const req = model.ofKind('RequirementUsage')[0]!.id;
    expect(requirementShortId(st().model, req)).toBe('');
    const undoBefore = st().undoStack.length;
    st().setRequirementShortId(req, '');
    expect(serializeModel(st().model)).toBe(src);
    expect(st().undoStack.length).toBe(undoBefore);
  });

  it('setRequirementShortId refuses a requirement under a faulted declaration, at no undo cost', () => {
    const src = 'package P {\n    blok def V {\n        requirement <R1> nested;\n    }\n}';
    const { model } = parseModel(src);
    useAppStore.setState({ model, undoStack: [], redoStack: [] });
    const req = model.ofKind('RequirementUsage')[0]!.id;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      st().setRequirementShortId(req, 'R9');
    } finally {
      errors.mockRestore();
    }
    expect(requirementShortId(st().model, req)).toBe('R1');
    expect(serializeModel(st().model)).toBe(src);
    expect(st().undoStack.length).toBe(0);
  });

  /**
   * The kind is the one facet that is not about requirements.
   *
   * Guidance is most useful written on a definition or a package, where every
   * element of that type or in that scope inherits it — and neither is a
   * requirement, so `setRequirementAttr` refuses both. Without its own command
   * the Kind control could only ever be offered on requirement rows, which is
   * the one place a `prompt` is least useful.
   */
  it('setStatementKind tags a part — the element a prompt is most useful on', () => {
    const part = st().createElement('PartUsage', null, 'engine');
    const undoBefore = st().undoStack.length;

    st().setStatementKind(part, 'prompt');
    expect(statementKindOf(st().model, part)).toBe('prompt');
    expect(st().undoStack.length).toBe(undoBefore + 1);

    st().undo();
    expect(statementKindOf(st().model, part)).toBeUndefined();
  });

  it('setStatementKind clears a kind, and spends no undo step on a no-op', () => {
    const part = st().createElement('PartUsage', null, 'engine');
    const untagged = st().createElement('PartUsage', null, 'wheel');
    st().setStatementKind(part, 'prose');
    st().setStatementKind(part, null);
    expect(statementKindOf(st().model, part)).toBeUndefined();

    // Give the store a redo entry to protect, as the refusal cases do; the undo
    // puts `part` back to prose.
    st().undo();
    expect(statementKindOf(st().model, part)).toBe('prose');
    const redoBefore = st().redoStack.length;
    expect(redoBefore).toBeGreaterThan(0);
    const undoBefore = st().undoStack.length;

    st().setStatementKind(untagged, null); // nothing to clear
    st().setStatementKind(part, 'prose'); // already prose
    expect(st().undoStack.length).toBe(undoBefore);
    expect(st().redoStack.length).toBe(redoBefore);
  });

  it('setStatementKind refuses a notation with nowhere to write the keyword', () => {
    const part = st().createElement('PartUsage', null, 'engine');
    const doc = st().createElement('Documentation', part);
    const undoBefore = st().undoStack.length;
    const redoBefore = st().redoStack.length;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    st().setStatementKind(doc, 'prompt');
    errors.mockRestore();

    expect(st().model.get(doc)?.attrs.metadata).toBeUndefined();
    expect(st().undoStack.length).toBe(undoBefore); // no phantom step
    expect(st().redoStack.length).toBe(redoBefore);
  });

  it('setStatementKind leaves a library element alone', () => {
    const model = st().model;
    const libPart = model.create('PartUsage', {
      declaredName: 'LibPart',
      attrs: { isLibrary: true },
    });
    const undoBefore = st().undoStack.length;
    st().setStatementKind(libPart.id, 'prose');
    expect(st().model.get(libPart.id)?.attrs.metadata).toBeUndefined();
    expect(st().undoStack.length).toBe(undoBefore);
  });
});

describe('useAppStore — diagram scope', () => {
  /**
   * The builder has always accepted a scope root; nothing ever passed one, so
   * an interconnection view was always the entire model. Confirmed by a Fable
   * advisor, 2026-09-02. Scope is the lever that narrows the picture WITHOUT
   * removing anything from the view — filtering definitions out was tried
   * instead and reverted, because an empty definition frame is what a user
   * drops new parts into.
   */
  it('defaults to the whole model', () => {
    const s = useAppStore.getState();
    s.newProject();
    expect(useAppStore.getState().diagramRootId).toBeNull();
  });

  it('scopes to an element and back again', () => {
    useAppStore.getState().newProject();
    const id = useAppStore.getState().createElement('PartDefinition', null, 'Assembly');

    useAppStore.getState().setDiagramRoot(id);
    expect(useAppStore.getState().diagramRootId).toBe(id);

    useAppStore.getState().setDiagramRoot(null);
    expect(useAppStore.getState().diagramRootId).toBeNull();
  });

  it('forgets a scope whose root was deleted, rather than rendering an empty canvas', async () => {
    useAppStore.getState().newProject();
    const id = useAppStore.getState().createElement('PartDefinition', null, 'Doomed');

    useAppStore.getState().setDiagramRoot(id);
    useAppStore.getState().deleteElement(id);
    await useAppStore.getState().rebuildDiagram();

    expect(useAppStore.getState().diagramRootId).toBeNull();
  });
});

describe('useAppStore.solveParametric — the Solve rows carry their units (I6)', () => {
  beforeEach(reset);

  /** Load a parsed source into the singleton store and solve it. */
  function solveRows(src: string): string[] {
    const { model } = parseModel(src);
    useAppStore.setState({ model });
    st().solveParametric();
    return st().diagnostics.map((d) => d.message);
  }

  it('a dimensioned violation names the SI unit its amount is in', () => {
    const rows = solveRows(`package P {
    part def V { attribute mass : ISQ::MassValue = 2500.0 [kg]; }
    part v : V;
    requirement def R { subject v : V; require constraint { v.mass <= 2000.0 [kg] } }
}
`);
    expect(rows.some((m) => m.includes('violated inequality: v.mass <= 2000.0 [kg] (by 500.0 [kg])'))).toBe(
      true,
    );
  });

  it('a unitless violation keeps its row byte-identical (no empty suffix)', () => {
    const rows = solveRows(`package P {
    part def V { attribute x : Real = 20.0; constraint c { x <= 10.0 } }
    part v : V;
}
`);
    expect(rows).toContain('violated inequality: x <= 10.0 (by 10.00)');
  });

  it('a STRICT ordering violated at its boundary says so instead of "by 0.000"', () => {
    // The violation is the tie itself, so the amount is 0 — and a row reading
    // "violated … (by 0.000)" reads as no violation at all.
    const rows = solveRows(`package P {
    part def V { attribute mass : ISQ::MassValue = 25.0 [kg]; }
    part v : V;
    constraint c5 { v.mass < 25.0 }
}
`);
    expect(rows).toContain('violated inequality: v.mass < 25.0 (at the boundary)');
  });

  it('a relation neither engine can judge is an INFO row, not a silent drop', () => {
    const rows = solveRows(`package P {
    part def V { attribute range : ISQ::LengthValue = 5.0 [km]; }
    part v : V;
    requirement def R { subject v : V; require constraint { v.range >= 4.0 [furlong] } }
}
`);
    const row = rows.find((m) => m.startsWith('unjudged inequality:'));
    expect(row).toBeDefined();
    expect(row).toContain('v.range >= 4.0 [furlong]');
    expect(row).toMatch(/furlong/);
    const unjudged = st().diagnostics.find((d) => d.id.startsWith('solve#unknown#'));
    expect(unjudged?.severity).toBe('info');
    // …and the feasibility header must not read "all satisfied" beside it:
    // `feasible` means no KNOWN violation, which is not the same claim.
    const feasibility = rows.find((m) => m.startsWith('Feasibility:'));
    expect(feasibility).toBe('Feasibility: no violated inequality constraint. 1 constraint(s) unjudged.');
  });

  it('the feasibility header says nothing about unjudged rows when there are none', () => {
    const rows = solveRows(`package P {
    part def V { attribute x : Real = 5.0; constraint c { x <= 10.0 } }
    part v : V;
}
`);
    expect(rows).toContain('Feasibility: no violated inequality constraint.');
  });

  it('a design freedom gets a free row, not a value row, and no verdict is read off it (D5)', () => {
    // `dry` has no value, so the asserted loop fixes nothing: the solve used
    // to publish dry 0.952, mass 1.19 and call `mass >= 130.0` violated there.
    const rows = solveRows(`package D2 {
    attribute dry;
    attribute mass;
    attribute fuel;
    assert constraint dm { mass == dry + fuel }
    assert constraint df { fuel == mass * 0.2 }
    constraint need { mass >= 130.0 }
    constraint cap { dry <= 110.0 }
}
`);
    expect(rows.filter((m) => m.startsWith('value:'))).toEqual([]);
    const free = st().diagnostics.filter((d) => d.id.startsWith('solve#free#'));
    const name = (id: string | undefined) => st().model.get(id ?? '')?.declaredName;
    expect(free.map((d) => name(d.elementId)).sort()).toEqual(['dry', 'fuel', 'mass']);
    expect(free.every((d) => d.severity === 'info')).toBe(true);
    expect(free[0]!.message).toMatch(/^free: \w+ — left free by the equations/);
    const need = st().diagnostics.find((d) => d.id.startsWith('solve#unknown#') && d.message.includes('mass >= 130.0'));
    expect(need?.message).toMatch(/mass is left free by the equations/);
    expect(rows.some((m) => m.startsWith('violated'))).toBe(false);
    expect(rows).toContain('Feasibility: no violated inequality constraint. 2 constraint(s) unjudged.');
    expect(rows[0]).not.toMatch(/no parametric constraints/);
  });
});

describe('useAppStore — typing by name, and who owns a drawn typing', () => {
  function load(text: string): void {
    useAppStore.setState({ model: parseModel(text).model, undoStack: [], redoStack: [], selectionId: null, selectionIds: [] });
  }
  const byName = (n: string) => st().model.all().find((e) => e.declaredName === n)!;
  const typings = (id: string) =>
    st()
      .model.relationshipsFrom(id)
      .filter((r) => r.eClass === 'FeatureTyping')
      .map((r) => st().model.get(r.target![0]!)?.declaredName);

  it('a typing or specialization drawn with a tool belongs to its source, like a parsed one', () => {
    load('package P { part def T; part def S; part x; requirement r; }');
    const typing = st().connect(byName('x').id, byName('T').id, 'FeatureTyping');
    expect(st().model.get(typing)!.ownerId).toBe(byName('x').id);
    const spec = st().connect(byName('S').id, byName('T').id, 'Specialization');
    expect(st().model.get(spec)!.ownerId).toBe(byName('S').id);
    // Any other relationship goes beside its source.
    const sat = st().connect(byName('x').id, byName('r').id, 'Satisfy');
    expect(st().model.get(sat)!.ownerId).toBe(byName('P').id);
  });

  it('bindType types a usage by a name that resolves, replacing its old type', () => {
    load('package P { part def Engine; part def Motor; part e : Engine; }');
    const e = byName('e').id;
    expect(typings(e)).toEqual(['Engine']);
    st().bindType(e, 'Motor');
    expect(typings(e)).toEqual(['Motor']);
    expect(st().model.relationshipsFrom(e).find((r) => r.eClass === 'FeatureTyping')!.ownerId).toBe(e);
    // One undo step restores the old type.
    st().undo();
    expect(typings(byName('e').id)).toEqual(['Engine']);
  });

  it('bindType leaves the model alone for an unknown name, and an empty name removes the type', () => {
    load('package P { part def Engine; part e : Engine; }');
    const e = byName('e').id;
    const undoDepth = st().undoStack.length;
    st().bindType(e, 'NoSuchThing');
    expect(typings(e)).toEqual(['Engine']);
    expect(st().undoStack.length).toBe(undoDepth);
    st().bindType(e, '');
    expect(typings(e)).toEqual([]);
  });
});

describe('useAppStore — interfaces drawn port to port, tags and subjects', () => {
  function load(text: string): void {
    useAppStore.setState({ model: parseModel(text).model, undoStack: [], redoStack: [], selectionId: null, selectionIds: [] });
  }
  const byQn = (qn: string) => st().model.all().find((e) => st().model.qualifiedName(e.id) === qn)!;
  const text = () => serializeModel(st().model);

  const WIRING = `package R {
    port def P;
    interface def I { end a : P; end b : ~P; }
    part def M { out port o : P; in port i : ~P; port own : P; }
    part m1 : M;
    part m2 : M;
    part m3 { out port q : P; }
  }`;

  it('connectPorts ends an interface on the ports a part has through its type — `m1.o`, not `m1`', () => {
    load(WIRING);
    const id = st().connectPorts(
      'InterfaceUsage',
      { owner: byQn('R::m1').id, port: byQn('R::M::o').id },
      { owner: byQn('R::m2').id, port: byQn('R::M::i').id },
    );
    const iface = st().model.get(id)!;
    expect(iface.eClass).toBe('InterfaceUsage');
    expect(iface.ownerId).toBe(byQn('R').id);
    expect(text()).toContain('interface connect m1.o to m2.i;');
    // It re-parses to the same wiring.
    const again = parseModel(text()).model;
    const reparsed = again.all().find((e) => e.eClass === 'InterfaceUsage')!;
    expect(again.qualifiedName(reparsed.source![0]!)).toBe('R::m1::o');
    expect(again.qualifiedName(reparsed.target![0]!)).toBe('R::m2::i');
    st().undo();
    expect(st().model.all().some((e) => e.eClass === 'InterfaceUsage')).toBe(false);
  });

  it('connectPorts ends on a part\'s own port directly', () => {
    load(WIRING);
    st().connectPorts('ConnectionUsage', { port: byQn('R::m3::q').id }, { owner: byQn('R::m1').id, port: byQn('R::M::i').id });
    expect(text()).toContain('connect m3.q to m1.i;');
  });

  it('setTags writes the #Tag keywords, keeps a statement kind, and refuses a name that is not one', () => {
    load('package R { metadata def Hazard; metadata def Accepted; #prose part note; requirement H; }');
    const h = byQn('R::H').id;
    st().setTags(h, '#Hazard, Accepted');
    expect(st().model.get(h)!.attrs.metadata).toEqual(['Hazard', 'Accepted']);
    expect(text()).toContain('#Hazard #Accepted requirement H;');
    const depth = st().undoStack.length;
    st().setTags(h, 'not a-tag!');
    expect(st().model.get(h)!.attrs.metadata).toEqual(['Hazard', 'Accepted']);
    expect(st().undoStack.length).toBe(depth);
    const note = byQn('R::note').id;
    st().setTags(note, 'Hazard');
    expect(st().model.get(note)!.attrs.metadata).toEqual(['prose', 'Hazard']);
    st().setTags(h, '');
    expect(st().model.get(h)!.attrs.metadata).toBeUndefined();
  });

  it('setSubject writes `subject name : Type`, retypes it, and an empty text removes it', () => {
    load('package R { part def D; part def E; requirement H { doc /* t */ } }');
    const h = byQn('R::H').id;
    st().setSubject(h, 'holder : D');
    expect(text()).toContain('subject holder : D;');
    st().setSubject(h, 'holder : E');
    expect(text()).toContain('subject holder : E;');
    expect(text()).not.toContain(': D;');
    const depth = st().undoStack.length;
    st().setSubject(h, 'holder : NoSuchType');
    expect(st().undoStack.length).toBe(depth);
    st().setSubject(h, '');
    expect(text()).not.toContain('subject');
    expect(st().model.children(h).some((c) => c.attrs.requirementRole === 'subject')).toBe(false);
  });
});

/**
 * The app's Check lists what the constraint report says, row for row:
 * `runConstraintCheck` drops the validator's own constraint rows and re-lists
 * `constraintReport` in their place. A target over a valueless measure gets one
 * row per context that specialises the measure — navigable to the specialiser,
 * worded as the validator words it — and an equation that defines a valueless
 * feature still says what it defines (0b09f65).
 */
const BRIEF_TARGETS = `package B {
  package Common {
    attribute m : ScalarValues::Real;
    require constraint t { m >= 0.9 }
  }
  package LA {
    attribute fleet = 12;
    attribute share = 0.05;
    attribute m :> Common::m;
    assert constraint { m == fleet * share }
  }
  package PA {
    attribute m :> Common::m = 0.95;
  }
}`;

describe('store — Check lists one row per specialisation of a target', () => {
  beforeEach(() => {
    useAppStore.setState({ model: new Model(), undoStack: [], redoStack: [], diagnostics: [] });
  });

  it('follows the target’s own row with a row per context, at the specialiser', () => {
    const model = parseModel(BRIEF_TARGETS).model;
    useAppStore.setState({ model });
    st().runConstraintCheck();
    const id = (q: string) => model.all().find((e) => model.qualifiedName(e.id) === q)!.id;
    const rows = st().diagnostics.filter((d) => d.ruleId === 'constraint-check');
    const at = rows.findIndex((d) => d.elementId === id('B::Common::t'));
    expect(rows[at].message).toBe(
      'Constraint could not be evaluated ("m >= 0.9"): Could not evaluate: m has no value here; ' +
        'evaluated per specialisation: LA::m, PA::m.',
    );
    expect(rows.slice(at + 1, at + 3).map((d) => [d.severity, d.elementId, d.message])).toEqual([
      ['warning', id('B::LA::m'), 'LA::m = 0.6 misses Common::t (m >= 0.9)'],
      ['info', id('B::PA::m'), 'PA::m = 0.95 meets Common::t (m >= 0.9)'],
    ]);
    // The validator's own rows for the same findings are not listed twice.
    expect(st().diagnostics.filter((d) => d.ruleId === 'target-by-specialisation')).toEqual([]);
    expect(st().diagnostics.filter((d) => d.ruleId === 'constraint-violation')).toEqual([]);
  });

  it('still says what an equation defines', () => {
    const model = parseModel(BRIEF_TARGETS).model;
    useAppStore.setState({ model });
    st().runConstraintCheck();
    expect(st().diagnostics.map((d) => d.message)).toContain(
      'Constraint satisfied: defines m = 0.6 (m == fleet * share)',
    );
  });
});

/**
 * Google Drive (optional) — what the boot reads, and the model-side helpers a
 * Drive open and save stand on. The boot itself never runs under Vitest (it is
 * gated on the build MODE); `bootDrive` is called here with an injected fetch,
 * so nothing leaves the process.
 */
describe('google drive — the boot, and opening a file’s text', () => {
  const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-012';
  const KEY = '0-AbCdEfGhIjKlMn';
  const PAGE = 'https://example.org/site/app/';
  const CONFIG = {
    clientId: '123456789012-abc123def456.apps.googleusercontent.com',
    privacyUrl: 'https://example.org/site/privacy/',
  };
  const answering = (body: string, contentType: string): typeof fetch =>
    vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': contentType } })) as unknown as typeof fetch;
  const parseRows = () => st().diagnostics.filter((d) => d.ruleId === 'parse');
  const rootNames = () => st().model.roots().map((r) => r.declaredName);

  beforeEach(async () => {
    // Let any library load an earlier test started finish first, so a hold
    // queued below is taken by THIS test's load and not by a straggler.
    await whenLibrarySettled();
    lib.merge = null;
    reset();
    useAppStore.setState({ textBuffer: '', textDirty: false, diagnostics: [], serializeError: null });
  });

  it('fetches no drive.json on import: the boot is gated on the build MODE', () => {
    const asked = fetchSpy.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
    expect(asked.filter((url) => url.includes('drive.json'))).toEqual([]);
    expect(driveOnImport).toEqual(initialDriveState);
  });

  it('lets a well-formed ?drive= win over ?model=, saying so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(pageLinks(`?model=m.sysml&source=https%3A%2F%2Fexample.org&drive=${ID}&resourcekey=${KEY}`)).toEqual({
        drive: { id: ID, resourceKey: KEY },
        model: { model: null, source: null },
      });
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
      // A malformed id is no link at all, so ?model= keeps the page.
      expect(pageLinks('?drive=..%2Fx&model=m.sysml')).toEqual({
        drive: null,
        model: { model: 'm.sysml', source: null },
      });
      expect(pageLinks('?model=m.sysml')).toEqual({ drive: null, model: { model: 'm.sysml', source: null } });
      expect(pageLinks(`?drive=${ID}`)).toEqual({ drive: { id: ID }, model: { model: null, source: null } });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('boots to absent on the shipped placeholder, turning a pending link unsupported', async () => {
    const placeholder = readFileSync(resolve(process.cwd(), 'public/drive.json'), 'utf8');
    const booting = bootDrive({ id: ID }, PAGE, answering(placeholder, 'application/json'));
    // Synchronously — before the first render — so the loading gate holds.
    expect(st().drive.configStatus).toBe('loading');
    expect(st().drive.link).toEqual({ ref: { id: ID }, status: 'pending' });
    await booting;
    expect(st().drive.configStatus).toBe('absent');
    expect(st().drive.config).toBeNull();
    expect(st().drive.link).toEqual({ ref: { id: ID }, status: 'unsupported' });
  });

  it('boots to absent on an HTML 200 — the preview server’s answer for a missing file', async () => {
    await bootDrive(null, PAGE, answering('<!doctype html><title>Sysprose</title>', 'text/html'));
    expect(st().drive.configStatus).toBe('absent');
    expect(st().drive.link).toBeNull();
  });

  it('boots to ready on a valid drive.json, keeping a ?drive= link pending', async () => {
    await bootDrive({ id: ID, resourceKey: KEY }, PAGE, answering(JSON.stringify(CONFIG), 'application/json'));
    expect(st().drive.configStatus).toBe('ready');
    expect(st().drive.config).toEqual(CONFIG);
    expect(st().drive.link).toEqual({ ref: { id: ID, resourceKey: KEY }, status: 'pending' });
  });

  it('openText opens .sysml through the text path and resolves once the library has settled', async () => {
    const text = 'package Opened {\n    part def Drone;\n}\n';
    const revBefore = st().rev;
    await openText(text, 'sysml');
    expect(rootNames()).toEqual(['Opened']);
    // One bump for the apply, one for the refresh after the re-merge: it ran.
    expect(st().rev).toBe(revBefore + 2);
    expect(st().textDirty).toBe(false);
    expect(st().textBuffer).toContain('part def Drone;');
    expect(lastAppliedText()).toBe(text);
    expect(recomputePending()).toBe(false);
    // The apply's one step; a caller opening a file clears the stacks itself.
    expect(st().undoStack.length).toBe(1);
  });

  it('openText imports a model JSON file, and resolves once the library has settled', async () => {
    const json = exportModel(parseModel('package Imported {\n    part def P;\n}\n').model, 'model-json');
    const revBefore = st().rev;
    await openText(json, 'model-json');
    expect(rootNames()).toEqual(['Imported']);
    expect(st().rev).toBe(revBefore + 2);
    expect(st().textBuffer).toContain('package Imported');
    // No text was applied: an import is not a parse of the buffer.
    expect(lastAppliedText()).toBeNull();
  });

  /**
   * The open path must not end in a recompute. `refreshAfterLibraryLoad`
   * keeps a faulted file's parse rows and its text; a recompute rebuilds the
   * diagnostics from validation alone, so a file with a syntax error would
   * open with an empty Problems panel and a text nobody can see is broken.
   */
  it('openText keeps a faulted file’s parse rows and its text as given', async () => {
    const typed = 'package P {\n    blok bad;\n}\n';
    await openText(typed, 'sysml');
    const rows = parseRows();
    expect(rows.some((d) => d.severity === 'error')).toBe(true);
    expect(st().textBuffer).toBe(typed);
    expect(st().textDirty).toBe(true);
    // Nothing is waiting, so a flush recomputes nothing and the rows stand.
    flushRecompute();
    expect(parseRows()).toEqual(rows);
    expect(st().textBuffer).toBe(typed);
    expect(lastAppliedText()).toBe(typed);
  });

  it('flushRecompute runs the recompute an edit is waiting on, now, with its force flag', () => {
    useAppStore.setState({ textBuffer: 'typed, not applied', textDirty: true });
    st().createElement('PartDefinition', null, 'Flushed');
    expect(recomputePending()).toBe(true);
    expect(st().textBuffer).toBe('typed, not applied');
    flushRecompute();
    expect(recomputePending()).toBe(false);
    // A local edit's recompute is a FORCED one: it replaces even a dirty buffer.
    expect(st().textBuffer).toContain('part def Flushed');
    expect(st().textDirty).toBe(false);
  });

  it('lastAppliedText outlives the library refresh and nothing else', async () => {
    const text = 'package A {\n    part def P;\n}\n';
    await openText(text, 'sysml');
    expect(lastAppliedText()).toBe(text);
    st().createElement('PartDefinition', null, 'Q');
    expect(lastAppliedText()).toBeNull();
    st().undo();
    // Back to the applied model by undo — but not by applying that text, and
    // the buffer is the regenerated one: a save re-applies what it uploads.
    expect(lastAppliedText()).toBeNull();
  });

  /** A merge body that adds the library, as the real one does: the model changes under it. */
  const addLibrary = (model: Model): void => {
    if (!model.all().some((e) => e.attrs.isLibrary === true)) {
      model.create('Package', { declaredName: 'Lib', attrs: { isLibrary: true } });
    }
  };

  it('lastAppliedText outlives a merge that changes the model, and a refresh of the panels', async () => {
    lib.merge = addLibrary;
    const text = 'package A {\n    part def P;\n}\n';
    await openText(text, 'sysml');
    expect(st().model.all().some((e) => e.attrs.isLibrary === true), 'the merge added the library').toBe(true);
    expect(lastAppliedText()).toBe(text);
    // A store `rev` bump alone — a panel refresh, a presence change — is not a
    // change to the model.
    useAppStore.setState((s) => ({ rev: s.rev + 1 }));
    expect(lastAppliedText()).toBe(text);
  });

  /**
   * With a collab session connected, the store's model listener bumps `rev`
   * for every event batch — the merge's included — and every presence change
   * bumps it too; and the listener schedules a recompute, which after a
   * faulted open would rebuild the diagnostics from validation alone. Neither
   * may cost the open its parse rows, nor a save its "already applied": two
   * saves of a faulted file would otherwise stack two identical undo steps.
   */
  it('in a collab session, a faulted open keeps its parse rows and its applied text', async () => {
    lib.merge = addLibrary;
    const typed = 'package P {\n    blok bad;\n}\n';
    st().connectCollab('drive-test');
    try {
      await openText(typed, 'sysml');
      expect(recomputePending(), 'the merge armed a recompute').toBe(false);
      const rows = parseRows();
      expect(rows.some((d) => d.severity === 'error')).toBe(true);
      expect(lastAppliedText()).toBe(typed);

      // A presence change: the selection goes out to the peers, and back as `rev`.
      const revBefore = st().rev;
      const id = st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id;
      const next = st().selectionId === id ? null : id;
      useAppStore.setState({ selectionId: next, selectionIds: next ? [next] : [] });
      expect(st().rev, 'the presence change reached the store').toBeGreaterThan(revBefore);
      expect(lastAppliedText()).toBe(typed);

      // A Drive save's first steps, twice: apply only a buffer not yet applied,
      // then fire a pending recompute. Nothing is applied, nothing is erased.
      const undo = st().undoStack.length;
      for (let i = 0; i < 2; i++) {
        if (st().textDirty && st().textBuffer !== lastAppliedText()) {
          st().applyText();
          await whenLibrarySettled();
        }
        flushRecompute();
      }
      expect(st().undoStack.length).toBe(undo);
      expect(parseRows()).toEqual(rows);
      expect(st().textBuffer).toBe(typed);

      // An edit is a change to the model, collab or not.
      st().createElement('PartDefinition', null, 'Q');
      expect(lastAppliedText()).toBeNull();
    } finally {
      st().disconnectCollab();
    }
  });

  /**
   * Hold a library load open: the next load to start waits in its preload
   * until the returned function is called. Resolves once that load is IN its
   * preload, so the next one starts while this one is genuinely in flight —
   * and only then (two library imports racing each other in the same tick are
   * a Vitest mocking hazard: the second can resolve to the real module).
   */
  async function heldLoad(text: string): Promise<() => void> {
    let release = (): void => {};
    lib.holds.push(new Promise<void>((r) => (release = r)));
    useAppStore.setState({ textBuffer: text });
    st().applyText();
    await vi.waitFor(() => expect(lib.holds).toHaveLength(0));
    return release;
  }

  it('whenLibrarySettled waits for a load started while it was already waiting', async () => {
    const releases: Array<() => void> = [];
    try {
      // The first load stands for the boot load, still merging…
      releases.push(await heldLoad('package First;\n'));
      let settled = false;
      const waiting = whenLibrarySettled().then(() => {
        settled = true;
      });
      // …when an apply starts a second one.
      releases.push(await heldLoad('package Second;\n'));
      releases[0]();
      await new Promise((r) => setTimeout(r, 20));
      expect(settled, 'released while the second load was still running').toBe(false);
      const revBefore = st().rev;
      releases[1]();
      await waiting;
      expect(st().rev, 'the second load’s refresh had run').toBe(revBefore + 1);
      expect(rootNames()).toEqual(['Second']);
    } finally {
      for (const release of releases) release();
    }
  });

  it('whenLibrarySettled waits for every load in flight, not only the latest', async () => {
    const releases: Array<() => void> = [];
    try {
      releases.push(await heldLoad('package First;\n'));
      releases.push(await heldLoad('package Second;\n'));
      let settled = false;
      const waiting = whenLibrarySettled().then(() => {
        settled = true;
      });
      releases[1]();
      await new Promise((r) => setTimeout(r, 20));
      expect(settled, 'released while the first load was still running').toBe(false);
      releases[0]();
      await waiting;
      expect(settled).toBe(true);
    } finally {
      for (const release of releases) release();
    }
  });
});

/**
 * Google Drive (optional) — the store's actions over the test doubles of the
 * three Google boundaries: `FakeDriveAuth` (sign-in), `InMemoryDriveGateway`
 * (Drive) and `FakeDrivePicker`, on a fake clock. The slice is `absent` under
 * Vitest (the boot does not run), so each case starts from a configured one.
 */
describe('google drive', () => {
  const CONFIG: DriveConfig = {
    clientId: '123456789012-abc123def456.apps.googleusercontent.com',
    privacyUrl: 'https://example.org/site/privacy/',
  };
  const PAGE = 'https://example.org/site/app/';
  const KEY = '0-AbCdEfGhIjKlMn';
  const EMAIL = 'student@example.org';
  const T0 = Date.parse('2026-10-07T12:00:00Z');
  const HOUR = 3600_000;
  const SWARM = 'package Swarm {\n    part def Drone;\n}\n';
  /** Hand-written: a `//` comment and a blank-padded line the app's layout drops. */
  const HAND = 'package Swarm {\n    // the airframe\n    part def Drone;  \n}\n';
  const FAULTED = 'package Swarm {\n    blok bad;\n}\n';

  let clock = T0;
  let auth: FakeDriveAuth;
  let gateway: InMemoryDriveGateway;
  let picker: FakeDrivePicker;
  let warn: ReturnType<typeof vi.spyOn>;

  const drive = () => st().drive;
  const file = () => st().drive.file!;
  const rootNames = () => st().model.roots().filter((r) => r.attrs.isLibrary !== true).map((r) => r.declaredName);
  const parseRows = () => st().diagnostics.filter((d) => d.ruleId === 'parse');
  const calls = (op: string) => gateway.calls.filter((c) => c.op === op);
  const signIns = () => auth.calls.filter((c) => c.op === 'signIn');
  const revokes = () => auth.calls.filter((c) => c.op === 'revoke');
  const answering = (body: string): typeof fetch =>
    vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  /** Fresh doubles of the Google side, wired into the store (the gateway asks the sign-in for its token). */
  function google(opts: { md5Checksum?: boolean; headRevisionId?: boolean; loaded?: boolean } = {}): void {
    auth = new FakeDriveAuth({ now: () => clock, loaded: opts.loaded ?? true });
    gateway = new InMemoryDriveGateway({
      now: () => clock,
      token: () => auth.token(),
      md5Checksum: opts.md5Checksum,
      headRevisionId: opts.headRevisionId,
    });
    picker = new FakeDrivePicker({ onPicked: (id) => gateway.grant(id) });
    setDriveServices({ auth, gateway, picker });
  }

  /** Replace the model with `text`, as a file opened in this session (Undo empty). */
  async function model(text = SWARM): Promise<void> {
    await openText(text, 'sysml');
    useAppStore.setState({ undoStack: [], redoStack: [] });
  }

  /** Signed in, a model, and that model saved as a new Drive file: its id. */
  async function attached(text = SWARM): Promise<string> {
    await st().driveSignIn();
    await model(text);
    await st().driveSaveAs('Swarm');
    return file().id;
  }

  /** An edit by the diagram, its recompute fired: the Text view now differs from Drive. */
  function edit(name = 'Relay'): void {
    st().createElement('PartDefinition', st().model.roots().find((r) => r.attrs.isLibrary !== true)?.id ?? null, name);
    flushRecompute();
  }

  /** Spy on a store action through the state object (what the store calls it by), restoring it afterwards. */
  function spyAction<K extends 'applyText' | 'importModel' | 'saveProject'>(name: K) {
    const original = st()[name];
    const spy = vi.fn((...args: Parameters<AppState[K]>) =>
      (original as (...a: Parameters<AppState[K]>) => ReturnType<AppState[K]>)(...args),
    );
    useAppStore.setState({ [name]: spy } as Partial<AppState>);
    return { spy, restore: () => useAppStore.setState({ [name]: original } as Partial<AppState>) };
  }

  /**
   * Hold every download until the returned function is called — `before`
   * Drive answers (the request waits), or `after` it did (the text is in, the
   * open has not used it yet). A download takes a while, and the model stays
   * editable meanwhile.
   */
  function holdDownloads(when: 'before' | 'after' = 'before'): () => void {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const download = gateway.download.bind(gateway);
    vi.spyOn(gateway, 'download').mockImplementation(async (ref) => {
      if (when === 'before') await held;
      const text = await download(ref);
      if (when === 'after') await held;
      return text;
    });
    return release;
  }

  /** Hold the next library load until the returned function is called. */
  function holdLibrary(): () => void {
    let release!: () => void;
    lib.holds.push(new Promise<void>((r) => (release = r)));
    return release;
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** A merge body that adds a library root, as the real merge does. */
  const addLibrary = (m: Model): void => {
    if (!m.all().some((e) => e.attrs.isLibrary === true)) {
      m.create('Package', { declaredName: 'ScalarValues', attrs: { isLibrary: true } });
    }
  };

  beforeEach(async () => {
    await whenLibrarySettled();
    lib.merge = null;
    reset();
    clock = T0;
    google();
    useAppStore.setState({
      textBuffer: '',
      textDirty: false,
      diagnostics: [],
      serializeError: null,
      // The empty model these start from is saved: only Drive is asked about.
      savedText: withFinalNewline(''),
      linkedModel: null,
      projectName: 'Swarm',
      drive: { ...initialDriveState, configStatus: 'ready', config: CONFIG },
    });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    setDriveServices(null);
  });

  describe('signing in and out', () => {
    it('opens the account chooser inside the click, then reads the account and the Recent list', async () => {
      gateway.seed({ name: 'Earlier.sysml', text: SWARM });
      const signingIn = st().driveSignIn();
      // Synchronously, before anything was awaited: the popup is the click's.
      expect(auth.calls).toEqual([{ op: 'signIn', prompt: 'select_account' }]);
      expect(drive().busy).toBe('signing-in');
      await signingIn;
      expect(drive().account).toEqual({ email: EMAIL, name: 'Student' });
      expect(drive().expiresAt).toBe(T0 + HOUR);
      expect(drive().authReady).toBe(true);
      expect(drive().recent?.map((f) => f.name)).toEqual(['Earlier.sysml']);
      expect(drive().busy).toBeNull();
      // The token stays inside the sign-in: nothing of it is in the store.
      expect(auth.token()).toBe('fake-token-1');
      expect(JSON.stringify(drive())).not.toContain('fake-token');
    });

    it('reads as "Signed in to Google" when Drive will not say who it is', async () => {
      gateway.failNext(403, { op: 'about' });
      await st().driveSignIn();
      expect(drive().account).toEqual({ email: null, name: null });
      expect(drive().notice).toBeNull();
    });

    it('says why a sign-in did not happen, and signs nobody in', async () => {
      const cases: Array<[string, string]> = [
        ['popup_closed', DRIVE_MESSAGES.signInCancelled],
        ['access_denied', DRIVE_MESSAGES.accessDenied],
        ['popup_failed_to_open', DRIVE_MESSAGES.popupBlocked],
      ];
      for (const [code, message] of cases) {
        auth.failNextSignIn(code);
        await st().driveSignIn();
        expect(drive().account, code).toBeNull();
        expect(drive().notice, code).toEqual({ kind: 'error', message, retryable: false });
      }
      expect(gateway.calls).toEqual([]);
    });

    it('signs out by revoking the live token, then forgets the session, the Recent list and the file', async () => {
      await attached();
      await st().driveSignOut();
      expect(revokes()).toEqual([{ op: 'revoke', token: 'fake-token-1' }]);
      expect(drive()).toMatchObject({ account: null, expiresAt: null, recent: null, file: null, busy: null });
      // A sign-out is not a "closed" file: nothing is standing in the strip.
      expect(drive().notice).toBeNull();
      expect(auth.token()).toBeNull();
    });

    /**
     * Revoking needs a token Google still accepts, and a browser-flow token
     * lives an hour with nothing to refresh it. So a sign-out after the hour
     * signs in again first — inside the click, the one place a window may open
     * — and revokes THAT token.
     */
    it('after the hour, signs in again inside the click and revokes the renewed token', async () => {
      await st().driveSignIn();
      clock += HOUR;
      expect(auth.token()).toBeNull();
      auth.calls.splice(0);
      const signingOut = st().driveSignOut();
      expect(auth.calls).toEqual([{ op: 'signIn', prompt: '', hint: EMAIL }]);
      await signingOut;
      expect(auth.calls).toEqual([
        { op: 'signIn', prompt: '', hint: EMAIL },
        { op: 'signOut' },
        { op: 'revoke', token: 'fake-token-2' },
      ]);
      expect(drive().notice).toBeNull();
      expect(drive().account).toBeNull();
    });

    it('revokes nothing when that renewal is refused, and says so', async () => {
      await st().driveSignIn();
      clock += HOUR;
      auth.failNextSignIn('popup_closed');
      await st().driveSignOut();
      expect(revokes()).toEqual([]);
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.nothingRevoked);
      expect(drive().account).toBeNull();
    });

    it('signs out anyway when Google does not confirm the revocation, and says so', async () => {
      await st().driveSignIn();
      auth.revokeOk = false;
      await st().driveSignOut();
      expect(revokes()).toEqual([{ op: 'revoke', token: 'fake-token-1' }]);
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.revokeUnconfirmed);
      expect(drive().account).toBeNull();
    });

    it('shows nothing an action read after the user signed out meanwhile', async () => {
      await st().driveSignIn();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const list = gateway.list.bind(gateway);
      vi.spyOn(gateway, 'list').mockImplementation(async (limit) => {
        const files = await list(limit);
        await held;
        return files;
      });
      const refreshing = st().driveRefreshRecent();
      await vi.waitFor(() => expect(gateway.list).toHaveBeenCalled());
      await st().driveSignOut();
      release();
      await refreshing;
      expect(drive().recent).toBeNull();
      expect(drive().account).toBeNull();
    });

    it('signs out once, however often Sign out is clicked while it revokes', async () => {
      await st().driveSignIn();
      auth.calls.splice(0);
      await Promise.all([st().driveSignOut(), st().driveSignOut()]);
      expect(auth.calls, 'no sign-in window to revoke nothing').toEqual([
        { op: 'signOut' },
        { op: 'revoke', token: 'fake-token-1' },
      ]);
      expect(drive().notice).toBeNull();
    });

    /**
     * Google refused the token (a 401) and the renewal that would revoke it
     * was refused too. That token is still within its hour, so the sign-in
     * still holds it — and must forget it all the same.
     */
    it('forgets a token Google refused when the renewal to revoke it is refused too', async () => {
      await attached();
      edit();
      gateway.failNext(401, { op: 'get' });
      auth.failNextSignIn('popup_failed_to_open');
      await st().driveSave();
      expect(drive().pending).toEqual({ op: 'save' });
      expect(auth.token(), 'refused by Google, within its hour').toBe('fake-token-1');
      auth.failNextSignIn('popup_closed');
      auth.revokeOk = false; // Google does not revoke a token it no longer takes
      await st().driveSignOut();
      expect(auth.token()).toBeNull();
      expect(drive()).toMatchObject({ account: null, file: null, pending: null });
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.nothingRevokedRefused);
    });

    /**
     * The same over Google's real sign-in, which may report a closed window
     * just before a token it was still issuing: such a late token is dropped
     * only once the sign-in has been told about the sign-out.
     */
    it('holds no token Google sends late, after such a sign-out', async () => {
      let gis!: { callback: (r: GisTokenResponse) => void; error_callback: (e: { type?: string }) => void };
      let requested = 0;
      const google: GoogleNs = {
        accounts: {
          oauth2: {
            initTokenClient: (config) => {
              gis = config;
              return { requestAccessToken: () => void requested++ };
            },
            hasGrantedAllScopes: (r, scope) => (r.scope ?? '').split(' ').includes(scope),
          },
        },
      };
      const real = createGisPopupAuth(CONFIG.clientId, {
        load: async () => {},
        google: () => google,
        now: () => clock,
        // Google answers the revocation of a token it no longer takes with a 400.
        fetchImpl: (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch,
      });
      gateway = new InMemoryDriveGateway({ now: () => clock, token: () => real.token() });
      setDriveServices({ auth: real, gateway, picker: null });
      const answer = (token: string) => gis.callback({ access_token: token, expires_in: 3600, scope: DRIVE_SCOPE });

      await st().drivePrepare();
      const signingIn = st().driveSignIn();
      answer('tok-A');
      await signingIn;
      await model();
      await st().driveSaveAs('Swarm');
      edit();
      gateway.failNext(401, { op: 'get' });
      const saving = st().driveSave();
      await vi.waitFor(() => expect(requested).toBe(2));
      gis.error_callback({ type: 'popup_failed_to_open' });
      await saving;
      expect(drive().pending).toEqual({ op: 'save' });

      const signingOut = st().driveSignOut();
      gis.error_callback({ type: 'popup_closed' });
      await tick();
      answer('tok-LATE');
      await signingOut;
      expect(real.token()).toBeNull();
      expect(drive().account).toBeNull();
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.nothingRevokedRefused);
    });

    /**
     * A lab computer: student A saves, signs out and leaves while Drive is
     * still answering, and student B signs in on the same tab. What A's save
     * learns after the sign-out — the file it wrote, a failure naming it — is
     * not B's to see.
     */
    describe('an answer that comes after a sign-out', () => {
      const B = { email: 'classmate@example.org', name: 'Classmate' };

      /**
       * Run `start` with its `op` call held; sign A out meanwhile and B in
       * (whose Drive holds nothing of this app's); then let Drive answer —
       * with what it wrote, or with `fails`.
       */
      async function answeredAfterSignOut(op: 'create' | 'update', start: () => Promise<void>, fails?: DriveError) {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        const original = gateway[op].bind(gateway) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(gateway, op).mockImplementation((async (...args: unknown[]) => {
          if (fails) {
            await held;
            throw fails;
          }
          const meta = await original(...args);
          await held;
          return meta;
        }) as never);
        const running = start();
        await vi.waitFor(() => expect(gateway[op]).toHaveBeenCalled());
        await st().driveSignOut();
        gateway.account = B;
        vi.spyOn(gateway, 'list').mockResolvedValue([]);
        await st().driveSignIn();
        expect(drive()).toMatchObject({ account: B, recent: [], file: null, notice: null });
        release();
        await running;
      }

      it('a new file A saved stays out of B’s Recent list', async () => {
        await st().driveSignIn();
        await model();
        await answeredAfterSignOut('create', () => st().driveSaveAs('A-private-plan'));
        expect(gateway.files().map((f) => f.name), 'Drive did write it').toEqual(['A-private-plan.sysml']);
        expect(drive()).toMatchObject({ account: B, recent: [], file: null, notice: null, busy: null });
      });

      it('nor does a save of A’s file, or its failure, reach B’s session', async () => {
        const id = await attached();
        edit();
        await answeredAfterSignOut('update', () => st().driveSave());
        expect(gateway.textOf(id), 'Drive did write it').toContain('part def Relay;');
        expect(drive()).toMatchObject({ account: B, recent: [], file: null, notice: null, busy: null });
      });

      it('and a failure of A’s, which would name A’s file, says nothing to B', async () => {
        await attached();
        edit();
        const full = new DriveForbiddenError('Google Drive answered HTTP 403 (storageQuotaExceeded)', 403, 'storageQuotaExceeded');
        await answeredAfterSignOut('update', () => st().driveSave(), full);
        expect(drive()).toMatchObject({ account: B, recent: [], notice: null, pending: null, busy: null });

        await model();
        const failed = new DriveError('Google Drive answered HTTP 500', 500);
        await answeredAfterSignOut('create', () => st().driveSaveAs('A-private-plan'), failed);
        expect(drive()).toMatchObject({ account: B, recent: [], notice: null, busy: null });
      });
    });

    /**
     * Google's sign-in window may report "closed" just before the token of a
     * consent completed at that moment arrives; the sign-in keeps that token
     * (see `createGisPopupAuth`). The next action uses it — and first shows
     * whose session it is, so Sign out is there to end it.
     */
    it('shows a sign-in Google finished after reporting its window closed, before using it', async () => {
      let gis!: { callback: (r: GisTokenResponse) => void; error_callback: (e: { type?: string }) => void };
      let requested = 0;
      const google: GoogleNs = {
        accounts: {
          oauth2: {
            initTokenClient: (config) => {
              gis = config;
              return { requestAccessToken: () => void requested++ };
            },
            hasGrantedAllScopes: (r, scope) => (r.scope ?? '').split(' ').includes(scope),
          },
        },
      };
      const real = createGisPopupAuth(CONFIG.clientId, { load: async () => {}, google: () => google, now: () => clock });
      gateway = new InMemoryDriveGateway({ now: () => clock, token: () => real.token() });
      setDriveServices({ auth: real, gateway, picker: null });

      await st().drivePrepare();
      const signingIn = st().driveSignIn();
      gis.error_callback({ type: 'popup_closed' });
      await signingIn;
      gis.callback({ access_token: 'tok-LATE', expires_in: 3600, scope: DRIVE_SCOPE });
      expect(drive().account).toBeNull();
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.signInCancelled);

      await model();
      await st().driveSaveAs('Swarm');
      expect(requested, 'no second window: the token is there').toBe(1);
      expect(calls('about')).toHaveLength(1);
      expect(drive().account, 'whose session it is, and with it Sign out').toEqual({ email: EMAIL, name: 'Student' });
      expect(file().name).toBe('Swarm.sysml');
    });

    /**
     * A renewal's `login_hint` is only a hint: when the account signed in
     * here is no longer signed in to Google, the brief window lets the user
     * pick another. The new token is then another account's session.
     */
    describe('a renewal that comes back as another account', () => {
      const B = { email: 'classmate@example.org', name: 'Classmate' };
      /** `about` answers for the token it is asked with: the first sign-in's is A's, any later one B's. */
      const tokensAreAccounts = () =>
        vi.spyOn(gateway, 'about').mockImplementation(async () =>
          auth.token() === 'fake-token-1' ? { email: EMAIL, name: 'Student' } : B,
        );

      it('after the hour: nothing is written, A’s file is let go, and B is who is signed in', async () => {
        const id = await attached();
        edit();
        const before = gateway.textOf(id);
        tokensAreAccounts();
        auth.expire();
        await st().driveSave();
        expect(signIns().at(-1)).toEqual({ op: 'signIn', prompt: '', hint: EMAIL });
        expect(calls('get').concat(calls('update')), 'nothing asked of A’s file as B').toEqual([]);
        expect(gateway.textOf(id)).toBe(before);
        expect(drive()).toMatchObject({ account: B, file: null, recent: null, pending: null });
        expect(drive().notice).toMatchObject({ kind: 'error', retryable: false });
        expect(drive().notice?.message).toBe(DRIVE_MESSAGES.otherAccount(B.email, EMAIL));
      });

      it('after a 401 mid-save: the same', async () => {
        const id = await attached();
        edit();
        const before = gateway.textOf(id);
        tokensAreAccounts();
        gateway.failNext(401, { op: 'get' });
        await st().driveSave();
        expect(calls('update')).toEqual([]);
        expect(gateway.textOf(id)).toBe(before);
        expect(drive()).toMatchObject({ account: B, file: null, recent: null });
        expect(drive().notice?.message).toBe(DRIVE_MESSAGES.otherAccount(B.email, EMAIL));
      });

      it('signing out after the hour revokes the token it has — B’s — and says A’s access stays', async () => {
        await attached();
        tokensAreAccounts();
        auth.expire();
        await st().driveSignOut();
        expect(revokes()).toEqual([{ op: 'revoke', token: 'fake-token-2' }]);
        expect(drive()).toMatchObject({ account: null, file: null, recent: null });
        expect(drive().notice?.message).toBe(DRIVE_MESSAGES.revokedOther(B.email, EMAIL));
      });

      it('the same account again goes on as before', async () => {
        const id = await attached();
        edit();
        auth.expire();
        await st().driveSave();
        expect(drive()).toMatchObject({ account: { email: EMAIL, name: 'Student' }, notice: null });
        expect(gateway.textOf(id)).toContain('part def Relay;');
        expect(driveDirty(st())).toBe(false);
      });
    });
  });

  describe('saving', () => {
    /**
     * Drive gets the Text view's text — the user's roots only, the merged
     * standard library left out, as Export ▾ → SysML leaves it out.
     */
    it('Save to Drive as writes the Text view’s text, never the library, and attaches the file', async () => {
      lib.merge = addLibrary;
      await st().driveSignIn();
      await model();
      expect(st().model.roots().some((r) => r.attrs.isLibrary === true), 'the library merged').toBe(true);
      useAppStore.setState({ linkedModel: { url: `${PAGE}m.sysml`, source: null, status: 'loaded' } });

      await st().driveSaveAs('Swarm');
      expect(calls('create').map((c) => c.name)).toEqual(['Swarm.sysml']);
      const uploaded = gateway.textOf(file().id)!;
      expect(uploaded).toBe(withFinalNewline(st().textBuffer));
      expect(uploaded, 'what Export writes, with one final newline').toBe(
        withFinalNewline(exportModel(st().model, 'sysml')),
      );
      expect(uploaded).toContain('part def Drone;');
      expect(uploaded).not.toContain('ScalarValues');
      expect(uploaded).not.toMatch(/\blibrary\b|\bstandard\b/);
      expect(file()).toMatchObject({ name: 'Swarm.sysml', openedFrom: 'save-as', savedText: uploaded, rewrites: false });
      expect(st().linkedModel, 'the strip replaces the ?model= banner').toBeNull();
      expect(driveDirty(st())).toBe(false);
      expect(drive().recent?.map((f) => f.name)).toEqual(['Swarm.sysml']);
    });

    it('reads unsaved after an edit, saved after Save — with new content markers — and saved again after Undo', async () => {
      const id = await attached();
      const before = { ...file() };
      edit('Relay');
      expect(driveDirty(st())).toBe(true);
      await st().driveSave();
      expect(gateway.textOf(id)).toContain('part def Relay;');
      expect(file().md5Checksum).not.toBe(before.md5Checksum);
      expect(file().headRevisionId).toBe('r2');
      expect(driveDirty(st())).toBe(false);
      edit('Gimbal');
      expect(driveDirty(st())).toBe(true);
      st().undo();
      expect(driveDirty(st()), 'Undo back to what Drive holds').toBe(false);
    });

    it('fires an edit’s pending recompute, so the upload holds the edit', async () => {
      const id = await attached();
      st().createElement('PartDefinition', null, 'Pending');
      expect(recomputePending()).toBe(true);
      await st().driveSave();
      expect(gateway.textOf(id)).toContain('part def Pending;');
      expect(recomputePending()).toBe(false);
    });

    /**
     * The renewal of an expired sign-in must be the action's FIRST step: its
     * popup opens only inside the click, and applying the typed text first
     * would put an await (the library merge) before it.
     */
    it('asks for a token before it applies the typed text — inside the click', async () => {
      const id = await attached();
      clock += HOUR;
      st().setTextBuffer(SWARM.replace('Drone', 'Glider'));
      const apply = spyAction('applyText');
      const signIn = vi.spyOn(auth, 'signIn');
      try {
        const saving = st().driveSave();
        expect(signIn).toHaveBeenCalledTimes(1);
        expect(signIn).toHaveBeenCalledWith({ prompt: '', hint: EMAIL });
        expect(apply.spy).not.toHaveBeenCalled();
        await saving;
        expect(apply.spy).toHaveBeenCalledTimes(1);
        expect(signIn.mock.invocationCallOrder[0]).toBeLessThan(apply.spy.mock.invocationCallOrder[0]);
        expect(gateway.textOf(id)).toContain('part def Glider;');
      } finally {
        apply.restore();
        signIn.mockRestore();
      }
    });

    it('applies typed text before saving it, and uploads its canonical form', async () => {
      const id = await attached();
      st().setTextBuffer('package Swarm {\n  part def   Drone;\n part def Relay;}');
      await st().driveSave();
      const uploaded = gateway.textOf(id)!;
      expect(uploaded).toBe(withFinalNewline(st().textBuffer));
      expect(uploaded).toContain('    part def Relay;');
      expect(st().textDirty).toBe(false);
      expect(driveDirty(st())).toBe(false);
    });

    /**
     * A faulted text keeps the user's text as typed — and reads `textDirty`
     * although nobody typed since. Re-applying it on each save would push one
     * identical undo step per save.
     */
    it('uploads a faulted text as typed, reads it saved, and spends no undo step on a second save', async () => {
      const id = await attached();
      st().setTextBuffer(FAULTED);
      const undos = st().undoStack.length;
      await st().driveSave();
      expect(gateway.textOf(id)).toBe(FAULTED);
      expect(st().textDirty).toBe(true);
      expect(driveDirty(st())).toBe(false);
      expect(st().undoStack.length, 'the one apply').toBe(undos + 1);
      await st().driveSave();
      expect(calls('update')).toHaveLength(2);
      expect(st().undoStack.length, 'nothing applied again').toBe(undos + 1);
      expect(parseRows().some((d) => d.severity === 'error')).toBe(true);
    });

    /**
     * A text with a syntax error reads `textDirty` from its apply on, and a
     * diagram edit made on top of it arms a FORCED recompute, which replaces
     * that text. Saved within the recompute's wait, applying the old text
     * first would put it back over the edit.
     */
    it('keeps a diagram edit made over a faulted text within the recompute’s wait', async () => {
      const id = await attached();
      st().setTextBuffer(FAULTED);
      await st().driveSave();
      expect(st().textDirty).toBe(true);
      st().createElement('PartDefinition', st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id, 'Relay');
      expect(recomputePending()).toBe(true);
      await st().driveSave();
      expect(st().model.all().some((e) => e.declaredName === 'Relay'), 'the edit is in the model').toBe(true);
      expect(gateway.textOf(id)).toContain('part def Relay;');
      expect(driveDirty(st())).toBe(false);
    });

    it('sends nothing for a model the serializer refuses', async () => {
      await attached();
      const owner = st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id;
      const doc = st().createElement('Documentation', owner);
      st().setAttr(doc, 'body', 'a real note');
      st().model.setAttrs(doc, { body: `bad ${NOTE_BODY_TERMINATOR} part def Ghost; doc /*` });
      st().regenerateText();
      expect(st().serializeError).not.toBeNull();
      expect(driveDirty(st()), 'a model that cannot be written is not what Drive holds').toBe(true);
      const sent = gateway.calls.length;
      await st().driveSave();
      expect(gateway.calls.length).toBe(sent);
      expect(drive().notice).toEqual({ kind: 'error', message: DRIVE_MESSAGES.cannotSerialize, retryable: false });
    });

    it('refuses a text over 5 MB before any request', async () => {
      await attached();
      useAppStore.setState({ textBuffer: 'x'.repeat(DRIVE_UPLOAD_MAX_BYTES), textDirty: false });
      const sent = gateway.calls.length;
      await st().driveSave();
      await st().driveSaveAs('Big');
      expect(gateway.calls.length).toBe(sent);
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.tooLarge);
    });

    it('opens the Save-as form when no file is attached, prefilled from the project name', async () => {
      google({ loaded: false });
      await model();
      await st().driveSave();
      expect(drive().prompt).toEqual({ kind: 'saveas', suggested: 'Swarm.sysml', asCopy: false });
      expect(gateway.calls).toEqual([]);
      // A form needs no sign-in — but its Save does, signed out, and that
      // click must find Google's script loaded: it starts loading now.
      expect(auth.calls).toEqual([{ op: 'ready' }]);
      expect(drive().authReady).toBe(false);
      auth.finishLoading();
      await vi.waitFor(() => expect(drive().authReady).toBe(true));
      const saving = st().driveSaveAs('Swarm');
      expect(signIns(), 'the popup opens inside the Save click').toEqual([{ op: 'signIn', prompt: 'select_account' }]);
      await saving;
      expect(file().name).toBe('Swarm.sysml');

      // Signed in, the script is there already: nothing more to load.
      const before = auth.calls.length;
      st().driveDetach();
      await st().driveSave();
      expect(drive().prompt).toEqual({ kind: 'saveas', suggested: 'Swarm.sysml', asCopy: false });
      expect(auth.calls).toHaveLength(before);
    });

    it('signs in with the account chooser when a save is the first thing asked of Drive', async () => {
      await model();
      await st().driveSaveAs('First');
      expect(signIns()).toEqual([{ op: 'signIn', prompt: 'select_account' }]);
      expect(drive().account?.email).toBe(EMAIL);
      expect(file().name).toBe('First.sysml');
    });

    it('also saves in this browser when asked — the applied model, whatever becomes of the Drive save', async () => {
      const id = await attached();
      st().setTextBuffer(SWARM.replace('Drone', 'Glider'));
      const seen: boolean[] = [];
      const save = spyAction('saveProject');
      save.spy.mockImplementation(async () => {
        seen.push(st().model.all().some((e) => e.declaredName === 'Glider'));
      });
      try {
        await st().driveSave({ alsoInBrowser: true });
        expect(seen, 'saved once, after the typed text was applied').toEqual([true]);
        expect(gateway.textOf(id)).toContain('part def Glider;');

        // No session to be had: the browser save still happens.
        clock += HOUR;
        auth.failNextSignIn('popup_closed');
        edit('Relay');
        await st().driveSave({ alsoInBrowser: true });
        expect(seen).toHaveLength(2);
        expect(drive().notice?.message).toBe(DRIVE_MESSAGES.signInCancelled);

        // Offline: no request, and the browser save.
        useAppStore.setState((s) => ({ drive: { ...s.drive, online: false } }));
        const sent = gateway.calls.length;
        await st().driveSave({ alsoInBrowser: true });
        expect(gateway.calls.length).toBe(sent);
        expect(seen).toHaveLength(3);
        expect(drive().notice?.message).toBe(DRIVE_MESSAGES.offline);
      } finally {
        save.restore();
      }
    });

    /**
     * A field Drive's fresh answer leaves out is gone, not kept from before:
     * a stale content hash would make the next save see a change nobody made.
     */
    it('takes the metadata of each save as Drive gave it', async () => {
      const id = await attached();
      expect(file().md5Checksum).toBeDefined();
      const update = gateway.update.bind(gateway);
      vi.spyOn(gateway, 'update').mockImplementation(async (ref, text) => {
        const { md5Checksum: _hash, ...meta } = await update(ref, text);
        return meta;
      });
      edit('Relay');
      await st().driveSave();
      expect(file().md5Checksum).toBeUndefined();
      expect(file().headRevisionId).toBe('r2');
      edit('Kite');
      await st().driveSave();
      expect(drive().conflict, 'the head revision says nothing changed in Drive').toBeNull();
      expect(gateway.textOf(id)).toContain('part def Kite;');
    });

    /**
     * A Save as whose request left with no answer saying whether Drive made
     * the file — the connection dropped, the server failed, or its answer
     * did not parse — may have made it: saving again could make a second.
     */
    it('does not offer Retry for a new file Drive may have made already', async () => {
      await st().driveSignIn();
      await model();
      const failures: Array<[DriveError | number, string]> = [
        [new DriveNetworkError('network', 0, 'network'), DRIVE_MESSAGES.createUncertain],
        [503, DRIVE_MESSAGES.createUncertain],
        [new DriveBadResponseError('bad shape', 200, 'bad-shape'), DRIVE_MESSAGES.createUncertain],
        [new DriveNetworkError('timeout', 0, 'timeout'), DRIVE_MESSAGES.createTimeout],
      ];
      for (const [failure, message] of failures) {
        gateway.failNext(failure, { op: 'create' });
        await st().driveSaveAs('Again');
        expect(drive().notice, String(failure)).toEqual({ kind: 'error', message, retryable: false });
      }
      // Refused outright (a rate limit): nothing was made, and Retry is safe.
      gateway.failNext(429, { op: 'create' });
      await st().driveSaveAs('Again');
      expect(drive().notice).toMatchObject({ message: DRIVE_MESSAGES.rateLimited, retryable: true });
    });

    it('does not attach a file to a model replaced while its upload was in flight', async () => {
      const id = await attached();
      edit('Relay');
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const update = gateway.update.bind(gateway);
      const spy = vi.spyOn(gateway, 'update').mockImplementation(async (ref, text) => {
        await held;
        return update(ref, text);
      });
      try {
        const saving = st().driveSave();
        await vi.waitFor(() => expect(spy).toHaveBeenCalled());
        st().newProject('Fresh');
        release();
        await saving;
        expect(gateway.textOf(id), 'Drive holds the model the file was attached to').toContain('part def Relay;');
        expect(drive().file, 'the new model stays unattached').toBeNull();
        expect(rootNames()).toEqual(['Fresh']);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('Drive’s copy changed: conflicts', () => {
    it('turns a save over changed content (content hash) into a conflict, and writes nothing', async () => {
      const id = await attached();
      gateway.bump(id, 'package Theirs;\n');
      edit();
      await st().driveSave();
      expect(drive().conflict?.remote.lastModifiedBy).toBe('A classmate');
      expect(calls('update')).toEqual([]);
      expect(gateway.textOf(id)).toBe('package Theirs;\n');
    });

    it('falls back to the head revision when Drive reports no content hash', async () => {
      google({ md5Checksum: false });
      const id = await attached();
      expect(file().md5Checksum).toBeUndefined();
      gateway.bump(id);
      edit();
      await st().driveSave();
      expect(drive().conflict).not.toBeNull();
      expect(calls('update')).toEqual([]);
    });

    /**
     * A rename or a share moves `version` and `modifiedTime` and leaves the
     * content alone — and sharing is the very next step after a Save as.
     */
    it('takes a rename or a share for what it is: no conflict', async () => {
      const id = await attached();
      gateway.touchMeta(id);
      edit();
      await st().driveSave();
      expect(drive().conflict).toBeNull();
      expect(calls('update')).toHaveLength(1);
      expect(driveDirty(st())).toBe(false);
    });

    it('compares the modified time only when Drive reports neither content marker', async () => {
      google({ md5Checksum: false, headRevisionId: false });
      const id = await attached();
      gateway.touchMeta(id);
      edit();
      await st().driveSave();
      expect(drive().conflict).not.toBeNull();
    });

    it('Overwrite writes over Drive’s version', async () => {
      const id = await attached();
      gateway.bump(id, 'package Theirs;\n');
      edit('Relay');
      await st().driveSave();
      await st().driveResolveConflict('overwrite');
      expect(gateway.textOf(id)).toContain('part def Relay;');
      expect(drive().conflict).toBeNull();
      expect(driveDirty(st())).toBe(false);
    });

    it('Save as copy writes a new file and attaches it, leaving Drive’s version alone', async () => {
      const id = await attached();
      gateway.bump(id, 'package Theirs;\n');
      edit('Relay');
      await st().driveSave();
      await st().driveResolveConflict('copy');
      expect(drive().prompt).toEqual({ kind: 'saveas', suggested: 'Swarm (copy).sysml', asCopy: true });
      await st().driveSaveAs('Swarm (copy).sysml', { asCopy: true });
      expect(file().id).not.toBe(id);
      expect(file().name).toBe('Swarm (copy).sysml');
      expect(gateway.textOf(file().id)).toContain('part def Relay;');
      expect(gateway.textOf(id)).toBe('package Theirs;\n');
      expect(drive().conflict).toBeNull();
    });

    /** Applying the text pushes its one undo step itself: no second snapshot of the same model. */
    it('Reload from Drive takes Drive’s version with exactly one Undo step back', async () => {
      const id = await attached();
      gateway.bump(id, 'package Theirs {\n    part def Kite;\n}\n');
      edit('Relay');
      await st().driveSave();
      const undos = st().undoStack.length;
      await st().driveResolveConflict('reload');
      expect(rootNames()).toEqual(['Theirs']);
      expect(st().undoStack.length).toBe(undos + 1);
      expect(drive().conflict).toBeNull();
      expect(driveDirty(st())).toBe(false);
      expect(file().savedText).toBe(withFinalNewline(st().textBuffer));
      st().undo();
      expect(st().model.all().some((e) => e.declaredName === 'Relay'), 'Undo returns to the local version').toBe(true);
    });
  });

  describe('opening', () => {
    it('opens a .sysml file in place of the model: Undo starts over, the file is attached', async () => {
      await model();
      const canonical = withFinalNewline(st().textBuffer);
      await model('package Other;\n');
      edit('Scratch');
      useAppStore.setState({ linkedModel: { url: `${PAGE}m.sysml`, source: null, status: 'loaded' } });
      const meta = gateway.seed({ name: 'Swarm.sysml', text: canonical });
      await st().driveOpen({ id: meta.id }, 'recent');
      expect(rootNames()).toEqual(['Swarm']);
      expect(st().undoStack).toEqual([]);
      expect(st().redoStack).toEqual([]);
      expect(st().linkedModel).toBeNull();
      expect(file()).toMatchObject({ id: meta.id, name: 'Swarm.sysml', openedFrom: 'recent', rewrites: false });
      expect(file().savedText).toBe(withFinalNewline(st().textBuffer));
      expect(driveDirty(st())).toBe(false);
    });

    it('marks a hand-written file as one a save would rewrite', async () => {
      const meta = gateway.seed({ name: 'Hand.sysml', text: HAND });
      await st().driveOpen({ id: meta.id }, 'picker');
      expect(file().rewrites).toBe(true);
      expect(driveDirty(st()), 'opened, not edited').toBe(false);
    });

    /**
     * `rev` moves when the library settles after an open, a few hundred ms
     * later and without any edit — which is why the saved marker is the text.
     */
    it('reads saved after the library settles over the opened file, although `rev` moved', async () => {
      lib.merge = addLibrary;
      const meta = gateway.seed({ name: 'Swarm.sysml', text: SWARM });
      await st().driveSignIn();
      let release!: () => void;
      lib.holds.push(new Promise<void>((r) => (release = r)));
      const opening = st().driveOpen({ id: meta.id }, 'recent');
      await vi.waitFor(() => expect(lib.holds).toHaveLength(0));
      const revApplied = st().rev;
      release();
      await opening;
      expect(st().rev, 'the library refresh ran').toBeGreaterThan(revApplied);
      expect(file().id).toBe(meta.id);
      expect(driveDirty(st())).toBe(false);
    });

    it('keeps a faulted file’s parse rows through the open and through a save', async () => {
      const meta = gateway.seed({ name: 'Broken.sysml', text: FAULTED });
      await st().driveOpen({ id: meta.id }, 'recent');
      await whenLibrarySettled();
      const rows = parseRows();
      expect(rows.some((d) => d.severity === 'error')).toBe(true);
      expect(st().textBuffer).toBe(FAULTED);
      expect(driveDirty(st())).toBe(false);
      // The app never laid this text out, so whether a save rewrites it
      // cannot be told: the first save asks, as for a hand-written file.
      expect(file().rewrites).toBe(true);
      await st().driveSave();
      expect(drive().prompt).toEqual({ kind: 'rewrite' });
      await st().driveAcknowledgeRewrite('save');
      expect(calls('update')).toHaveLength(1);
      expect(parseRows()).toEqual(rows);
      expect(gateway.textOf(meta.id)).toBe(FAULTED);
      expect(st().undoStack, 'the faulted text was not applied again').toEqual([]);
    });

    /**
     * A hand-written file is the kind that arrives with a syntax error. The
     * refresh keeps such a text as fetched, so it compares equal to itself —
     * and once the student fixes the error, the save regenerates it in the
     * app's layout, `//` comments gone. That is the save that must ask.
     */
    it('asks before rewriting a hand-written file that opened with a syntax error', async () => {
      const handFaulted = 'package Swarm {\n    // the airframe\n    part def Drone;\n    blok bad;\n}\n';
      const meta = gateway.seed({ name: 'Hand.sysml', text: handFaulted });
      await st().driveOpen({ id: meta.id }, 'recent');
      expect(parseRows().some((d) => d.severity === 'error')).toBe(true);
      expect(file().rewrites).toBe(true);
      st().setTextBuffer(handFaulted.replace('blok bad;', 'part def Bad;'));
      await st().driveSave();
      expect(drive().prompt).toEqual({ kind: 'rewrite' });
      expect(calls('update'), 'asked before anything is written').toEqual([]);
      expect(gateway.textOf(meta.id)).toBe(handFaulted);
      await st().driveAcknowledgeRewrite('save');
      expect(gateway.textOf(meta.id)).toBe(withFinalNewline(st().textBuffer));
      expect(gateway.textOf(meta.id)).toContain('part def Bad;');
      expect(gateway.textOf(meta.id)).not.toContain('// the airframe');
    });

    /**
     * The app's own text keeps trailing blanks inside a `doc` body, which an
     * editor's normalization strips: compared one-sidedly, a file this app
     * wrote would read as written elsewhere, and the question would come up
     * in the everyday loop of saving and reopening.
     */
    it('takes a file it wrote for its own, trailing blanks in a doc body and all', async () => {
      await st().driveSignIn();
      await model('package Swarm {\n    doc /* first line   \n     * second line */\n    part def Drone;\n}\n');
      expect(st().textBuffer, 'the app keeps the blanks').toMatch(/[ \t]+$/m);
      await st().driveSaveAs('Mine');
      const id = file().id;
      st().driveDetach();
      await st().driveOpen({ id }, 'recent');
      expect(file().rewrites).toBe(false);
      expect(driveDirty(st())).toBe(false);
    });

    it('opens model JSON through the import, without attaching it', async () => {
      const json = exportModel(parseModel(SWARM).model, 'model-json');
      const meta = gateway.seed({ name: 'Swarm.json', text: json, mimeType: 'application/json' });
      const importing = spyAction('importModel');
      try {
        await st().driveOpen({ id: meta.id }, 'recent');
        expect(importing.spy).toHaveBeenCalledTimes(1);
      } finally {
        importing.restore();
      }
      expect(rootNames()).toEqual(['Swarm']);
      expect(drive().file).toBeNull();
      expect(drive().notice).toEqual({ kind: 'info', message: DRIVE_MESSAGES.openedJson('Swarm.json'), retryable: false });
    });

    it('leaves the model as it was for a file it cannot open', async () => {
      await model();
      edit('Mine');
      const undos = st().undoStack.length;
      const apiJson = gateway.seed({ name: 'graph.json', text: '{"@type":"Project"}', mimeType: 'application/json' });
      const notJson = gateway.seed({ name: 'notes.json', text: 'not json at all', mimeType: 'application/json' });
      for (const meta of [apiJson, notJson]) {
        await st().driveOpen({ id: meta.id }, 'recent');
        expect(drive().notice?.message, meta.name).toBe(DRIVE_MESSAGES.unknownFormat(meta.name));
        expect(st().model.all().some((e) => e.declaredName === 'Mine'), meta.name).toBe(true);
        expect(st().undoStack.length, meta.name).toBe(undos);
        expect(drive().file).toBeNull();
      }
    });

    it('carries a resource key with the file: in every request, and in its link', async () => {
      const meta = gateway.seed({ name: 'Keyed.sysml', text: SWARM, resourceKey: KEY, keyRequired: true });
      await st().driveOpen({ id: meta.id, resourceKey: KEY }, 'paste');
      expect(calls('get').map((c) => c.resourceKey)).toEqual([KEY]);
      expect(calls('download').map((c) => c.resourceKey)).toEqual([KEY]);
      expect(file().resourceKey).toBe(KEY);
      expect(driveLink(st(), `${PAGE}?model=x.sysml#top`)).toBe(`${PAGE}?drive=${meta.id}&resourcekey=${KEY}`);
      edit();
      await st().driveSave();
      expect(calls('update').map((c) => c.resourceKey)).toEqual([KEY]);
    });

    it('says why a file Drive will not hand over did not open', async () => {
      await model();
      await st().driveOpen({ id: 'NotGrantedYet0123' }, 'paste');
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.notFoundOnOpen);
      expect(rootNames()).toEqual(['Swarm']);
    });

    it('opens what Google’s Picker hands over, and nothing when it is closed', async () => {
      const meta = gateway.seed({ name: 'Shared.sysml', text: SWARM, granted: false });
      await st().driveBrowse();
      expect(drive().file).toBeNull();
      picker.answerNext({ id: meta.id, name: 'Shared.sysml' });
      await st().driveBrowse();
      expect(picker.calls).toEqual([{ token: 'fake-token-1' }, { token: 'fake-token-1' }]);
      expect(file()).toMatchObject({ id: meta.id, openedFrom: 'picker' });
    });

    it('names the file it is opening, once it knows the name', async () => {
      await st().driveSignIn();
      const meta = gateway.seed({ name: 'Fleet.sysml', text: SWARM });
      await st().driveRefreshRecent();
      const release = holdDownloads();
      // From the Recent list: named at once.
      const opening = st().driveOpen({ id: meta.id }, 'recent');
      expect(drive()).toMatchObject({ busy: 'opening', opening: 'Fleet.sysml' });
      release();
      await opening;
      expect(drive()).toMatchObject({ busy: null, opening: null });
      vi.mocked(gateway.download).mockRestore();

      // From the Picker: named once Drive's answer says the name.
      const other = gateway.seed({ name: 'Shared.sysml', text: SWARM, granted: false });
      picker.answerNext({ id: other.id, name: 'Shared.sysml' });
      const named: Array<string | null> = [];
      const unsubscribe = useAppStore.subscribe((s) => {
        if (s.drive.busy === 'opening' && named.at(-1) !== s.drive.opening) named.push(s.drive.opening);
      });
      await st().driveBrowse();
      unsubscribe();
      expect(named).toEqual([null, 'Shared.sysml']);
      expect(file().name).toBe('Shared.sysml');
    });
  });

  /**
   * An open replaces the model and clears Undo — what the user agreed to when
   * they asked for it (the guard asked, if there was anything to lose). The
   * download and the library merge after it take a while, and the model
   * stays editable meanwhile: whatever happened to it since must survive.
   */
  describe('while a file opens', () => {
    const OTHER = 'package Other {\n    part def Kite;\n}\n';

    it('does not open over an edit made while the file downloaded: the edit, its Undo and the attached file stay', async () => {
      const a = await attached();
      const other = gateway.seed({ name: 'Other.sysml', text: OTHER });
      const release = holdDownloads();
      // The attached file is clean: the guard lets the open through.
      st().driveGuard('Open', 'open', () => st().driveOpen({ id: other.id }, 'recent'));
      await vi.waitFor(() => expect(gateway.download).toHaveBeenCalled());
      edit('Unsaved');
      const undos = st().undoStack.length;
      release();
      await vi.waitFor(() => expect(drive().busy).toBeNull());
      expect(rootNames()).toEqual(['Swarm']);
      expect(st().model.all().some((e) => e.declaredName === 'Unsaved')).toBe(true);
      expect(st().undoStack).toHaveLength(undos);
      expect(file().id).toBe(a);
      expect(driveDirty(st())).toBe(true);
      expect(drive().notice).toEqual({ kind: 'info', message: DRIVE_MESSAGES.openStopped('Other.sysml'), retryable: false });
    });

    it('nor over text typed while it downloaded', async () => {
      await st().driveSignIn();
      await model();
      const other = gateway.seed({ name: 'Other.sysml', text: OTHER });
      const release = holdDownloads();
      const opening = st().driveOpen({ id: other.id }, 'recent');
      await vi.waitFor(() => expect(gateway.download).toHaveBeenCalled());
      st().setTextBuffer('package Typed;\n');
      release();
      await opening;
      expect(st().textBuffer).toBe('package Typed;\n');
      expect(rootNames()).toEqual(['Swarm']);
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.openStopped('Other.sysml'));
    });

    it('nor over a model a command replaced while it downloaded', async () => {
      await st().driveSignIn();
      await model();
      const other = gateway.seed({ name: 'Other.sysml', text: OTHER });
      const release = holdDownloads();
      const opening = st().driveOpen({ id: other.id }, 'recent');
      await vi.waitFor(() => expect(gateway.download).toHaveBeenCalled());
      st().importModel('package Imported {\n    part def Mine;\n}\n', 'sysml');
      release();
      await opening;
      expect(rootNames()).toEqual(['Imported']);
      expect(st().undoStack, 'the import’s own step').toHaveLength(1);
      expect(drive().file).toBeNull();
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.openStopped('Other.sysml'));
    });

    /**
     * New lands after the opened text was applied, while the library merges
     * over it. Attached then, the file would hold neither model, and its next
     * Save would write New's model into the file the user opened.
     */
    it('attaches nothing, and keeps New and its Undo, when New lands while the library settles', async () => {
      await st().driveSignIn();
      await model('package Mine;\n');
      const remote = gateway.seed({ name: 'Remote.sysml', text: 'package Remote;\n' });
      const release = holdLibrary();
      const opening = st().driveOpen({ id: remote.id }, 'recent');
      await vi.waitFor(() => expect(rootNames()).toEqual(['Remote']));
      st().newProject('Fresh');
      const undos = st().undoStack.length;
      release();
      await opening;
      expect(rootNames()).toEqual(['Fresh']);
      expect(drive().file).toBeNull();
      expect(st().undoStack, 'New’s step, and the open’s before it').toHaveLength(undos);
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.openNotAttached('Remote.sysml'));
      edit('Intruder');
      await st().driveSave();
      expect(drive().prompt?.kind, 'no file to write into: the Save-as form').toBe('saveas');
      expect(gateway.textOf(remote.id)).toBe('package Remote;\n');
    });

    it('attaches the file but reads unsaved when the model is edited while the library settles', async () => {
      await st().driveSignIn();
      const remote = gateway.seed({ name: 'Remote.sysml', text: SWARM });
      const release = holdLibrary();
      const opening = st().driveOpen({ id: remote.id }, 'recent');
      await vi.waitFor(() => expect(rootNames()).toEqual(['Swarm']));
      edit('Relay');
      release();
      await opening;
      expect(file().id).toBe(remote.id);
      expect(st().textBuffer).toContain('part def Relay;');
      expect(driveDirty(st()), 'Drive does not hold the edit').toBe(true);
      expect(driveBeforeUnload(st(), new Event('beforeunload', { cancelable: true }))).toBe(true);
      expect(st().undoStack, 'the edit’s step, nothing from before the open').toHaveLength(1);
      st().undo();
      expect(st().model.all().some((e) => e.declaredName === 'Relay')).toBe(false);
      expect(driveDirty(st()), 'back to what Drive holds').toBe(false);
    });

    /**
     * Keys typed in the Text view while the library settles over the opened
     * file land before its refresh, which keeps them "not yet applied":
     * neither Drive nor this browser holds them.
     */
    it('attaches the file but reads unsaved when text is typed while the library settles', async () => {
      await st().driveSignIn();
      const remote = gateway.seed({ name: 'Remote.sysml', text: SWARM });
      const release = holdLibrary();
      const opening = st().driveOpen({ id: remote.id }, 'recent');
      await vi.waitFor(() => expect(rootNames()).toEqual(['Swarm']));
      const typed = st().textBuffer.replace('Drone', 'Kite');
      st().setTextBuffer(typed);
      release();
      await opening;
      expect(file().id).toBe(remote.id);
      expect(st().textBuffer, 'the refresh keeps what was typed').toBe(typed);
      expect(st().textDirty).toBe(true);
      expect(file().savedText, 'Drive does not hold it').not.toContain('Kite');
      expect(driveDirty(st())).toBe(true);
      expect(browserDirty(st()), 'nor does this browser').toBe(true);
      expect(driveBeforeUnload(st(), new Event('beforeunload', { cancelable: true }))).toBe(true);
      const run = vi.fn();
      st().driveGuard('New', 'dirty', run);
      expect(run).not.toHaveBeenCalled();
      expect(drive().prompt).toEqual({ kind: 'guard', label: 'New', variant: 'dirty' });
      await st().driveRunPending('keep');
      await st().driveSave();
      expect(gateway.textOf(remote.id), 'Save to Drive applies it and uploads it').toContain('part def Kite;');
      expect(driveDirty(st())).toBe(false);
    });

    it('and so does Reload from Drive', async () => {
      const id = await attached();
      gateway.bump(id, 'package Theirs {\n    part def Kite;\n}\n');
      edit('Relay');
      await st().driveSave();
      expect(drive().conflict).not.toBeNull();
      const release = holdLibrary();
      const reloading = st().driveResolveConflict('reload');
      await vi.waitFor(() => expect(rootNames()).toEqual(['Theirs']));
      const typed = st().textBuffer.replace('Kite', 'Wing');
      st().setTextBuffer(typed);
      release();
      await reloading;
      expect(drive().conflict).toBeNull();
      expect(st().textBuffer).toBe(typed);
      expect(file().savedText).not.toContain('Wing');
      expect(driveDirty(st())).toBe(true);
      expect(browserDirty(st())).toBe(true);
    });

    /** An SDK edit pushes no Undo step, and the open would clear Undo: nothing would bring it back. */
    it('nor over an edit made through the SDK while it downloaded', async () => {
      await st().driveSignIn();
      // The SDK edits the model the store started with.
      useAppStore.setState({ model: st().api.model });
      await model('package Mine;\n');
      const other = gateway.seed({ name: 'Other.sysml', text: OTHER });
      const release = holdDownloads();
      const opening = st().driveOpen({ id: other.id }, 'recent');
      await vi.waitFor(() => expect(gateway.download).toHaveBeenCalled());
      const root = st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id;
      st().api.create('PartDefinition', { declaredName: 'Scripted', ownerId: root });
      release();
      await opening;
      expect(rootNames()).toEqual(['Mine']);
      expect(st().model.all().some((e) => e.declaredName === 'Scripted')).toBe(true);
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.openStopped('Other.sysml'));
    });

    for (const when of ['before', 'after'] as const) {
      it(`attaches nothing after a sign-out while the file downloads (held ${when} Drive answered)`, async () => {
        await st().driveSignIn();
        await model('package Mine;\n');
        const remote = gateway.seed({ name: 'Remote.sysml', text: 'package Remote;\n' });
        const release = holdDownloads(when);
        const opening = st().driveOpen({ id: remote.id }, 'recent');
        await vi.waitFor(() => expect(gateway.download).toHaveBeenCalled());
        await st().driveSignOut();
        release();
        await opening;
        expect(drive()).toMatchObject({ account: null, file: null, notice: null, pending: null });
        expect(rootNames()).toEqual(['Mine']);
        expect(signIns(), 'no window to renew a token for a signed-out user').toHaveLength(1);
      });
    }
  });

  describe('when Drive refuses a save', () => {
    it('reads gone for a file trashed in Drive, or deleted', async () => {
      const id = await attached();
      gateway.trash(id);
      edit();
      await st().driveSave();
      expect(file().trashed).toBe(true);
      expect(calls('update')).toEqual([]);

      const other = await (async () => {
        await st().driveSaveAs('Other');
        return file().id;
      })();
      gateway.remove(other);
      edit('Kite');
      await st().driveSave();
      expect(file().trashed).toBe(true);
    });

    /**
     * A save or a reload is what finds a file gone, so it has changes no Save
     * to Drive can keep. Before New the question is then this browser's — and
     * there is none once the browser holds them.
     */
    it('asks about a file gone from Drive what it asks with none attached', async () => {
      const id = await attached();
      edit('Relay');
      gateway.trash(id);
      await runSave();
      expect(file().trashed).toBe(true);
      expect(driveDirty(st())).toBe(true);
      expect(browserDirty(st()), 'Save kept it in this browser').toBe(false);
      const run = vi.fn();
      st().driveGuard('New', 'dirty', run);
      expect(run).toHaveBeenCalledTimes(1);
      expect(drive().prompt).toBeNull();

      edit('Kite');
      st().driveGuard('New', 'dirty', run);
      expect(run).toHaveBeenCalledTimes(1);
      expect(drive().prompt).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
      await st().driveRunPending('save');
      expect(run, 'saved in this browser, then New').toHaveBeenCalledTimes(2);
      expect(browserDirty(st())).toBe(false);
    });

    it('reads view-only for a file the user may not change', async () => {
      const id = await attached();
      gateway.setReadonly(id);
      edit();
      await st().driveSave();
      expect(file().canEdit).toBe(false);
      expect(calls('update')).toEqual([]);

      await st().driveSaveAs('Writable');
      gateway.failNext(403, { op: 'update', reason: 'insufficientFilePermissions' });
      edit('Kite');
      await st().driveSave();
      expect(file().canEdit).toBe(false);
    });

    it('renews a refused token once, silently, and completes the save', async () => {
      const id = await attached();
      edit('Relay');
      gateway.failNext(401, { op: 'get' });
      auth.calls.splice(0);
      await st().driveSave();
      expect(signIns()).toEqual([{ op: 'signIn', prompt: '', hint: EMAIL }]);
      expect(gateway.textOf(id)).toContain('part def Relay;');
      expect(drive().pending).toBeNull();
      expect(driveDirty(st())).toBe(false);
    });

    /**
     * That renewal comes after an await, where a browser may refuse its popup.
     * The save is parked, and "Sign in and continue" — a fresh click — signs in
     * inside that click and completes it.
     */
    it('parks the save when that renewal’s popup is refused, and resumes it on the next click', async () => {
      const id = await attached();
      edit('Relay');
      gateway.failNext(401, { op: 'get' });
      auth.failNextSignIn('popup_closed');
      await st().driveSave();
      expect(drive().pending).toEqual({ op: 'save' });
      expect(drive().notice).toBeNull();
      expect(calls('update')).toEqual([]);

      auth.calls.splice(0);
      const resuming = st().driveResume();
      expect(auth.calls, 'signed in inside the click').toEqual([{ op: 'signIn', prompt: '', hint: EMAIL }]);
      await resuming;
      expect(drive().pending).toBeNull();
      expect(gateway.textOf(id)).toContain('part def Relay;');
    });

    it('keeps a parked save through other Drive actions, until it is run', async () => {
      const id = await attached();
      edit('Relay');
      gateway.failNext(401, { op: 'get' });
      auth.failNextSignIn('popup_closed');
      await st().driveSave();
      expect(drive().pending).toEqual({ op: 'save' });
      await st().driveRefreshRecent();
      await st().driveBrowse();
      expect(drive().pending, 'nothing saved it: still waiting').toEqual({ op: 'save' });
      await st().driveResume();
      expect(drive().pending).toBeNull();
      expect(gateway.textOf(id)).toContain('part def Relay;');
    });

    it('does not renew twice: a second refusal is a failure', async () => {
      await attached();
      edit();
      gateway.failNext(401, { op: 'get' });
      gateway.failNext(401, { op: 'get' });
      auth.calls.splice(0);
      await st().driveSave();
      expect(signIns()).toHaveLength(1);
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.signInAgain);
      expect(calls('update')).toEqual([]);
    });

    it('offers Retry for a failure worth retrying, and Retry saves', async () => {
      const id = await attached();
      edit('Relay');
      gateway.failNext(503, { op: 'get' });
      await st().driveSave();
      expect(drive().notice).toEqual({
        kind: 'error',
        message: DRIVE_MESSAGES.badAnswer(503),
        retryable: true,
        retry: { op: 'save' },
      });
      await st().driveRetry();
      expect(drive().notice).toBeNull();
      expect(gateway.textOf(id)).toContain('part def Relay;');

      // A save whose upload timed out is retried — its check finds out whether
      // it landed; a new file whose upload timed out is not: it may exist.
      gateway.failNext(new DriveNetworkError('timeout', 0, 'timeout'), { op: 'update' });
      edit('Kite');
      await st().driveSave();
      expect(drive().notice).toMatchObject({ message: DRIVE_MESSAGES.uploadTimeout, retryable: true });
      gateway.failNext(new DriveNetworkError('timeout', 0, 'timeout'), { op: 'create' });
      await st().driveSaveAs('Again');
      expect(drive().notice).toEqual({ kind: 'error', message: DRIVE_MESSAGES.createTimeout, retryable: false });
    });

    /**
     * Drive answered the upload without saying what became of it: a 2xx whose
     * answer did not parse (the text is in Drive), or a server failure after
     * the write. Not "Nothing was changed", and no Retry as if it were: the
     * next save's content check asks which version to keep if Drive took it.
     */
    it('does not say "nothing was changed" of an upload Drive may have taken', async () => {
      const id = await attached();
      edit('Relay');
      const update = gateway.update.bind(gateway);
      vi.spyOn(gateway, 'update').mockImplementationOnce(async (ref, text) => {
        await update(ref, text);
        throw new DriveBadResponseError('Google Drive answered HTTP 200 (bad-shape)', 200, 'bad-shape');
      });
      await st().driveSave();
      expect(gateway.textOf(id), 'Drive took it').toContain('part def Relay;');
      expect(drive().notice).toEqual({ kind: 'error', message: DRIVE_MESSAGES.saveUncertain, retryable: false });
      expect(driveDirty(st()), 'the strip still offers Save to Drive').toBe(true);
      // Saving again: the content check finds Drive's copy moved, and asks.
      await st().driveSave();
      expect(drive().conflict).not.toBeNull();

      // A server failure answering the upload: it may have landed.
      await st().driveResolveConflict('overwrite');
      edit('Kite');
      gateway.failNext(502, { op: 'update' });
      await st().driveSave();
      expect(drive().notice).toEqual({ kind: 'error', message: DRIVE_MESSAGES.saveUncertain, retryable: false });
      // The same failure on the check before it: nothing was written, and Retry is offered.
      gateway.failNext(502, { op: 'get' });
      await st().driveSave();
      expect(drive().notice).toMatchObject({ message: DRIVE_MESSAGES.badAnswer(502), retryable: true });
    });

    /**
     * Every 403 that is not a rate limit is "forbidden", but only Drive's
     * own reason says view access: a full Drive, a daily quota or a policy
     * refuses with a 403 too, and "Save to Drive as… keeps your own copy"
     * would send the user to what was just refused.
     */
    it('says view access only when Drive says so: a full Drive, and any other refusal, in their own words', async () => {
      const id = await attached();
      edit('Relay');
      gateway.failNext(403, { op: 'update', reason: 'storageQuotaExceeded' });
      await st().driveSave();
      expect(drive().notice).toEqual({ kind: 'error', message: DRIVE_MESSAGES.driveFull, retryable: false });
      expect(file().canEdit).toBe(true);

      gateway.failNext(403, { op: 'create', reason: 'storageQuotaExceeded' });
      await st().driveSaveAs('Copy');
      expect(drive().notice?.message, 'a new file into a full Drive').toBe(DRIVE_MESSAGES.driveFull);

      gateway.failNext(403, { op: 'update', reason: 'dailyLimitExceeded' });
      await st().driveSave();
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.refused(403));
      expect(file().id).toBe(id);
      expect(file().canEdit).toBe(true);

      gateway.failNext(403, { op: 'list', reason: 'domainPolicy' });
      await st().driveRefreshRecent();
      expect(drive().notice?.message, 'nor is a list refused for view access').toBe(DRIVE_MESSAGES.refused(403));

      gateway.failNext(403, { op: 'update', reason: 'insufficientFilePermissions' });
      await st().driveSave();
      expect(file().canEdit, 'view access: the strip’s own row').toBe(false);

      const forbidden = (reason: string) => new DriveForbiddenError(`Google Drive answered HTTP 403 (${reason})`, 403, reason);
      expect(driveMessage(forbidden('insufficientFilePermissions'), { op: 'save', name: 'Swarm.sysml' })).toBe(
        DRIVE_MESSAGES.readOnly('Swarm.sysml'),
      );
      expect(driveMessage(forbidden('insufficientFilePermissions'), { op: 'save-as', name: 'Swarm.sysml' })).toBe(
        DRIVE_MESSAGES.refused(403),
      );
      expect(driveMessage(forbidden('appNotAuthorizedToFile'), { op: 'open' })).toBe(DRIVE_MESSAGES.openRefused);
    });

    /**
     * Save and Ctrl/Cmd+S also keep the model in this browser (decision J.1),
     * and the offline row promises it. A browser that refuses — its storage
     * full, or blocked — is said so: the copy is not there.
     */
    it('says so when this browser refuses the copy Save keeps there', async () => {
      const save = spyAction('saveProject');
      save.spy.mockImplementation(async () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      });
      try {
        const id = await attached();
        edit('Relay');
        await st().driveSave({ alsoInBrowser: true });
        expect(gateway.textOf(id), 'Drive has it').toContain('part def Relay;');
        expect(drive().notice).toEqual({ kind: 'error', message: DRIVE_MESSAGES.browserSaveFailed, retryable: false });

        // Beside a Drive failure, in the same row.
        edit('Kite');
        gateway.failNext(503, { op: 'get' });
        await st().driveSave({ alsoInBrowser: true });
        expect(drive().notice).toMatchObject({
          message: `${DRIVE_MESSAGES.badAnswer(503)} ${DRIVE_MESSAGES.browserSaveFailed}`,
          retryable: true,
        });

        // The offline row's Save.
        useAppStore.setState((s) => ({ drive: { ...s.drive, online: false, notice: null } }));
        await st().driveSaveLocal();
        expect(save.spy).toHaveBeenCalledTimes(3);
        expect(drive().notice).toEqual({ kind: 'error', message: DRIVE_MESSAGES.browserSaveFailed, retryable: false });
      } finally {
        save.restore();
      }
    });
  });

  describe('the attached file follows the model', () => {
    it('is detached by every command that replaces the model — and not by applying text', async () => {
      await st().saveProject('Stored');
      const replacements: Array<[string, () => unknown]> = [
        ['newProject', () => st().newProject('Fresh')],
        ['importModel', () => st().importModel('package Imported;\n', 'sysml')],
        ['loadProject', () => st().loadProject('Stored')],
        ['connectCollab', () => st().connectCollab('drive-detach')],
        [
          'switchBranch',
          () => {
            st().refreshVersions();
            st().commitVersion('before the switch');
            st().switchBranch(st().currentBranchId);
          },
        ],
      ];
      for (const [command, run] of replacements) {
        await attached();
        const name = file().name;
        await run();
        expect(drive().file, command).toBeNull();
        expect(drive().notice, command).toEqual({ kind: 'info', message: DRIVE_MESSAGES.closed(name), retryable: false });
        st().disconnectCollab();
      }
      await attached();
      st().setTextBuffer(SWARM.replace('Drone', 'Glider'));
      st().applyText();
      expect(drive().file, 'the same document, edited as text').not.toBeNull();
    });

    /**
     * Joining a room lets go of the attached file because the room's peers
     * change the model from then on. So nothing attaches one while connected:
     * Save to Drive would otherwise write whatever a peer put in the model
     * into the student's own file. A relay out of reach is no room yet — and
     * once it comes up, a file attached meanwhile lets go, as at the join.
     */
    it('opens or attaches no Drive file while connected to a room, and lets go of one when the relay comes up', async () => {
      await st().driveSignIn();
      const shared = gateway.seed({ name: 'Shared.sysml', text: SWARM });
      await model();
      relay.status = null;
      st().connectCollab('drive-room');
      try {
        relay.status!({ status: 'connected' });
        expect(st().collab.connected).toBe(true);
        const info = { kind: 'info', message: DRIVE_MESSAGES.inRoom, retryable: false };

        await st().driveSaveAs();
        expect(drive().prompt, 'no Save-as form').toBeNull();
        expect(drive().notice).toEqual(info);
        await st().driveSaveAs('Mine');
        await st().driveOpen({ id: shared.id }, 'recent');
        picker.answerNext({ id: shared.id, name: 'Shared.sysml' });
        await st().driveBrowse();
        expect(picker.calls, 'the Picker does not open').toEqual([]);
        expect(drive().notice).toEqual(info);
        expect(calls('create').concat(calls('download'))).toEqual([]);
        expect(drive().file).toBeNull();

        // A ?drive= link: on its gate.
        useAppStore.setState((s) => ({ drive: { ...s.drive, notice: null, link: { ref: { id: shared.id }, status: 'pending' } } }));
        await st().driveOpen({ id: shared.id }, 'link');
        expect(drive().link).toEqual({ ref: { id: shared.id }, status: 'failed', error: DRIVE_MESSAGES.inRoom });
        useAppStore.setState((s) => ({ drive: { ...s.drive, link: null } }));

        // The relay goes away: a file may be attached — until it comes back.
        relay.status!({ status: 'disconnected' });
        await st().driveSaveAs('Mine');
        expect(file().name).toBe('Mine.sysml');
        relay.status!({ status: 'connected' });
        expect(drive().file).toBeNull();
        expect(drive().notice).toEqual({ kind: 'info', message: DRIVE_MESSAGES.closed('Mine.sysml'), retryable: false });
      } finally {
        st().disconnectCollab();
      }
      await st().driveSaveAs('After');
      expect(file().name, 'out of the room, as before').toBe('After.sysml');
    });

    it('is not guarded when clean, or when there is none', () => {
      const run = vi.fn();
      st().driveGuard('New', 'dirty', run);
      expect(run).toHaveBeenCalledTimes(1);
      expect(drive().prompt).toBeNull();
    });

    it('guards unsaved Drive changes: Keep editing keeps them, and the command does not run', async () => {
      await attached();
      edit();
      const run = vi.fn();
      st().driveGuard('New', 'dirty', run);
      expect(drive().prompt).toEqual({ kind: 'guard', label: 'New', variant: 'dirty' });
      expect(run).not.toHaveBeenCalled();
      await st().driveRunPending('keep');
      expect(run).not.toHaveBeenCalled();
      expect(drive().prompt).toBeNull();
      expect(driveDirty(st())).toBe(true);
    });

    it('Discard and continue runs the command, which detaches the file', async () => {
      const name = (await attached(), file().name);
      edit();
      st().driveGuard('New', 'dirty', () => st().newProject('Fresh'));
      await st().driveRunPending('discard');
      expect(rootNames()).toEqual(['Fresh']);
      expect(drive().file).toBeNull();
      expect(drive().notice?.message).toBe(DRIVE_MESSAGES.closed(name));
    });

    it('Save to Drive and continue saves first — and holds the command when the save does not land', async () => {
      const id = await attached();
      edit('Relay');
      const run = vi.fn();
      st().driveGuard('Sign out', 'dirty', run);
      await st().driveRunPending('save');
      expect(gateway.textOf(id)).toContain('part def Relay;');
      expect(run).toHaveBeenCalledTimes(1);

      gateway.bump(id);
      edit('Kite');
      st().driveGuard('Sign out', 'dirty', run);
      await st().driveRunPending('save');
      expect(drive().conflict).not.toBeNull();
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('Save to Drive and continue runs the command once saved, whatever else is parked', async () => {
      const id = await attached();
      const other = gateway.seed({ name: 'Other.sysml', text: SWARM });
      gateway.failNext(401, { op: 'get' });
      auth.failNextSignIn('popup_closed');
      await st().driveOpen({ id: other.id }, 'recent');
      expect(drive().pending).toMatchObject({ op: 'open', arg: other.id });
      edit('Relay');
      const run = vi.fn();
      st().driveGuard('New', 'dirty', run);
      await st().driveRunPending('save');
      expect(gateway.textOf(id)).toContain('part def Relay;');
      expect(run, 'the save landed: the command runs').toHaveBeenCalledTimes(1);
    });

    /** "Sign in and continue" may come long after the open was parked, over a model edited since. */
    it('asks again before a parked open replaces work done since it was parked', async () => {
      await st().driveSignIn();
      await model();
      const other = gateway.seed({ name: 'Other.sysml', text: 'package Other;\n' });
      gateway.failNext(401, { op: 'get' });
      auth.failNextSignIn('popup_closed');
      await st().driveOpen({ id: other.id }, 'recent');
      expect(drive().pending).toMatchObject({ op: 'open' });
      edit('Mine');
      await st().driveResume();
      expect(drive().prompt).toEqual({ kind: 'guard', label: 'Open from Drive', variant: 'open' });
      expect(rootNames()).toEqual(['Swarm']);
      await st().driveRunPending('open-anyway');
      expect(rootNames()).toEqual(['Other']);
      expect(file().id).toBe(other.id);
    });

    it('guards a Drive open over edited work no Drive file holds', async () => {
      const run = vi.fn();
      st().driveGuard('Open', 'open', run);
      expect(run, 'nothing edited: nothing to lose').toHaveBeenCalledTimes(1);

      await model();
      edit();
      st().driveGuard('Open', 'open', run);
      expect(drive().prompt).toEqual({ kind: 'guard', label: 'Open', variant: 'open' });
      await st().driveRunPending('open-anyway');
      expect(run).toHaveBeenCalledTimes(2);

      // Answering a guard no longer standing runs nothing.
      await st().driveRunPending('discard');
      expect(run).toHaveBeenCalledTimes(2);
    });
  });

  describe('a ?drive= link', () => {
    it('starts loading Google’s sign-in script as soon as the configuration arrives', async () => {
      google({ loaded: false });
      useAppStore.setState({ drive: initialDriveState });
      await bootDrive({ id: 'LinkedFile01234' }, PAGE, answering(JSON.stringify(CONFIG)));
      expect(drive().configStatus).toBe('ready');
      expect(auth.calls, 'before any click').toEqual([{ op: 'ready' }]);
      expect(drive().authReady).toBe(false);
      auth.finishLoading();
      await vi.waitFor(() => expect(drive().authReady).toBe(true));
    });

    it('opens its file on "Sign in and open": the gate drops, Undo starts over', async () => {
      const meta = gateway.seed({ name: 'Linked.sysml', text: SWARM });
      edit('Scratch');
      useAppStore.setState((s) => ({ drive: { ...s.drive, link: { ref: { id: meta.id }, status: 'pending' } } }));
      const opening = st().driveOpen({ id: meta.id }, 'link');
      expect(auth.calls, 'the account chooser, inside the click').toEqual([{ op: 'signIn', prompt: 'select_account' }]);
      expect(drive().link?.status).toBe('opening');
      await opening;
      expect(drive().link).toBeNull();
      expect(file()).toMatchObject({ id: meta.id, openedFrom: 'link' });
      expect(drive().account?.email).toBe(EMAIL);
      expect(st().undoStack).toEqual([]);
    });

    it('reads denied for a file not granted yet; the Picker on that one file grants and opens it', async () => {
      const meta = gateway.seed({ name: 'Shared.sysml', text: SWARM, granted: false, resourceKey: KEY });
      const ref = { id: meta.id, resourceKey: KEY };
      useAppStore.setState((s) => ({ drive: { ...s.drive, link: { ref, status: 'pending' } } }));
      await st().driveOpen(ref, 'link');
      expect(drive().link).toEqual({ ref, status: 'denied' });
      expect(drive().notice).toBeNull();

      picker.answerNext({ id: meta.id, name: 'Shared.sysml' });
      await st().driveBrowse([meta.id]);
      expect(picker.calls).toEqual([{ token: 'fake-token-1', fileIds: [meta.id] }]);
      expect(drive().link).toBeNull();
      expect(file()).toMatchObject({ id: meta.id, resourceKey: KEY, openedFrom: 'link' });
    });

    it('fails on the gate, not in the strip, when the sign-in is refused', async () => {
      const ref = { id: 'LinkedFile01234' };
      useAppStore.setState((s) => ({ drive: { ...s.drive, link: { ref, status: 'pending' } } }));
      auth.failNextSignIn('popup_closed');
      await st().driveOpen(ref, 'link');
      expect(drive().link).toEqual({ ref, status: 'failed', error: DRIVE_MESSAGES.signInCancelled });
      expect(drive().notice).toBeNull();
    });

    /**
     * The gate is the one sign-in offered while a link is pending, and its
     * button waits for Google's script: a script that never loads (a blocking
     * extension, a school filter) must not leave it waiting for good.
     */
    it('puts a sign-in script that did not load on the gate, whose Try again loads it again', async () => {
      google({ loaded: false });
      useAppStore.setState({ drive: initialDriveState });
      const ref = { id: 'LinkedFile01234' };
      await bootDrive(ref, PAGE, answering(JSON.stringify(CONFIG)));
      auth.finishLoading(new DriveError('script', 0, 'script-failed'));
      await vi.waitFor(() => expect(drive().link?.status).toBe('failed'));
      expect(drive().link).toEqual({ ref, status: 'failed', error: DRIVE_MESSAGES.scriptFailedOnLink });
      expect(drive().notice, 'the gate shows it, not the strip').toBeNull();
      const retrying = st().driveLinkRetry();
      expect(drive().link).toEqual({ ref, status: 'pending' });
      auth.finishLoading();
      await retrying;
      expect(drive().authReady).toBe(true);
      expect(drive().link).toEqual({ ref, status: 'pending' });
    });

    it('waits for a sign-in again when a sign-out cuts its open short', async () => {
      await st().driveSignIn();
      const meta = gateway.seed({ name: 'Linked.sysml', text: SWARM });
      const ref = { id: meta.id };
      useAppStore.setState((s) => ({ drive: { ...s.drive, link: { ref, status: 'pending' } } }));
      const release = holdDownloads();
      const opening = st().driveOpen(ref, 'link');
      await vi.waitFor(() => expect(gateway.download).toHaveBeenCalled());
      expect(drive().link?.status).toBe('opening');
      await st().driveSignOut();
      release();
      await opening;
      expect(drive().link).toEqual({ ref, status: 'pending' });
      expect(drive().file).toBeNull();
    });

    it('drops to the sample on Skip', async () => {
      await model();
      useAppStore.setState((s) => ({ drive: { ...s.drive, link: { ref: { id: 'LinkedFile01234' }, status: 'denied' } } }));
      st().driveLinkSkip();
      expect(drive().link).toBeNull();
      expect(rootNames()).toEqual(['Swarm']);
      expect(gateway.calls).toEqual([]);
    });
  });

  describe('what the UI reads', () => {
    it('the deep link names the file and nothing else of the page', async () => {
      expect(driveLink(st(), PAGE)).toBeNull();
      const id = await attached();
      expect(driveLink(st(), `${PAGE}?model=x.sysml&room=r#frag`)).toBe(`${PAGE}?drive=${id}`);
      expect(driveLink(st())).toBe(`${window.location.origin}${window.location.pathname}?drive=${id}`);
    });

    it('the Check panel’s commands name the Drive file once one is attached', async () => {
      expect(checkFileName(st())).toBe('Swarm.sysml');
      expect(checkFileName({ drive: { file: null }, projectName: '' })).toBe('model.sysml');
      await attached();
      await st().driveSaveAs('Fleet plan');
      expect(checkFileName(st())).toBe('Fleet plan.sysml');
    });

    it('asks before leaving exactly while the attached file has unsaved changes', async () => {
      const leaving = () => new Event('beforeunload', { cancelable: true });
      let e = leaving();
      expect(driveBeforeUnload(st(), e)).toBe(false);
      expect(e.defaultPrevented, 'no file').toBe(false);
      await attached();
      e = leaving();
      expect(driveBeforeUnload(st(), e)).toBe(false);
      expect(e.defaultPrevented, 'saved').toBe(false);
      edit();
      e = leaving();
      expect(driveBeforeUnload(st(), e)).toBe(true);
      expect(e.defaultPrevented, 'unsaved changes').toBe(true);
    });

    it('names a Drive file as a .sysml file, without path or control characters, and not too long', () => {
      expect(driveFileName('Swarm')).toBe('Swarm.sysml');
      expect(driveFileName('Swarm.SYSML')).toBe('Swarm.sysml');
      expect(driveFileName(' ../a/b\\c\u0000d\u007f ')).toBe('..abcd.sysml');
      expect(driveFileName('   ')).toBe('model.sysml');
      const long = driveFileName('é'.repeat(300));
      expect(long.length).toBeLessThanOrEqual(200);
      expect(long.endsWith('.sysml')).toBe(true);
      // Cut between characters: a surrogate pair stays whole.
      const astral = driveFileName(`a${'😀'.repeat(150)}`);
      expect(astral).toBe(`a${'😀'.repeat(96)}.sysml`);
      expect(driveFileName('n'.repeat(20_000))).toBe(`${'n'.repeat(194)}.sysml`);
    });

    it('ends a text in exactly one newline', () => {
      expect(withFinalNewline('')).toBe('\n');
      expect(withFinalNewline('a')).toBe('a\n');
      expect(withFinalNewline('a\n')).toBe('a\n');
      expect(withFinalNewline(`a${'\n'.repeat(20_000)}`)).toBe('a\n');
      expect(withFinalNewline('a\n\nb\n\n')).toBe('a\n\nb\n');
    });

    it('a rewrite of a hand-written file is asked once: a copy leaves the original, Save anyway rewrites it', async () => {
      const meta = gateway.seed({ name: 'Hand.sysml', text: HAND });
      await st().driveOpen({ id: meta.id }, 'recent');
      edit();
      await st().driveSave();
      expect(drive().prompt).toEqual({ kind: 'rewrite' });
      expect(calls('update'), 'asked before anything is written').toEqual([]);

      await st().driveAcknowledgeRewrite('copy');
      expect(drive().prompt).toEqual({ kind: 'saveas', suggested: 'Hand (copy).sysml', asCopy: true });
      await st().driveSaveAs('Hand (copy).sysml', { asCopy: true });
      expect(gateway.textOf(meta.id), 'the original is untouched').toBe(HAND);

      await st().driveOpen({ id: meta.id }, 'recent');
      edit();
      await st().driveSave();
      await st().driveAcknowledgeRewrite('cancel');
      expect(drive().prompt).toBeNull();
      expect(calls('update')).toEqual([]);
      await st().driveSave();
      await st().driveAcknowledgeRewrite('save');
      expect(gateway.textOf(meta.id)).toBe(withFinalNewline(st().textBuffer));
      expect(file().rewrites).toBe(false);
      edit('Kite');
      await st().driveSave();
      expect(drive().prompt, 'asked once').toBeNull();
      expect(calls('update')).toHaveLength(2);
    });

    it('Dismiss closes a notice, the Save-as form and the "no Drive here" note of a link', () => {
      useAppStore.setState((s) => ({
        drive: {
          ...s.drive,
          notice: { kind: 'info', message: 'x', retryable: false },
          prompt: { kind: 'saveas', suggested: 'a.sysml', asCopy: false },
          link: { ref: { id: 'LinkedFile01234' }, status: 'unsupported' },
        },
      }));
      st().driveDismiss();
      expect(drive()).toMatchObject({ notice: null, prompt: null, link: null });
    });
  });

  describe('the keys, and Save with a Drive file attached', () => {
    /** A Ctrl (or, `meta`, Cmd) keydown, as the page's listener hands it to the shortcut handler. */
    const key = (k: string, mods: { shift?: boolean; meta?: boolean } = {}): KeyboardEvent =>
      new KeyboardEvent('keydown', {
        key: k,
        ctrlKey: mods.meta !== true,
        metaKey: mods.meta === true,
        shiftKey: mods.shift === true,
        cancelable: true,
      });

    /** The browser save (IndexedDB), stood in for and counted. */
    function browserSave() {
      const save = spyAction('saveProject');
      save.spy.mockImplementation(async () => {});
      return save;
    }

    const writes = () => gateway.calls.filter((c) => c.op === 'create' || c.op === 'update');

    it('Ctrl/Cmd+Shift+S saves to Drive — the Save-as form with no file attached — and is the browser’s without Drive', async () => {
      const save = browserSave();
      try {
        expect(handleShortcut(key('S', { shift: true }))).toBe(true);
        expect(drive().prompt).toEqual({ kind: 'saveas', suggested: 'Swarm.sysml', asCopy: false });
        expect(auth.calls, 'signed out, the script starts loading for the form’s Save').toEqual([{ op: 'ready' }]);

        const id = await attached();
        edit();
        expect(handleShortcut(key('S', { shift: true, meta: true }))).toBe(true);
        await vi.waitFor(() => expect(drive().busy).toBeNull());
        expect(driveDirty(st())).toBe(false);
        expect(gateway.textOf(id)).toBe(withFinalNewline(st().textBuffer));
        expect(save.spy, 'Shift+S is Drive’s alone').not.toHaveBeenCalled();

        // A deployment without Google Drive: the key is not this app's.
        useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
        edit('Kite');
        const sent = gateway.calls.length;
        expect(handleShortcut(key('S', { shift: true }))).toBe(false);
        expect(gateway.calls).toHaveLength(sent);
        expect(save.spy).not.toHaveBeenCalled();
      } finally {
        save.restore();
      }
    });

    it('Ctrl/Cmd+S and Save save in this browser — and to the attached Drive file too, when there is one', async () => {
      const save = browserSave();
      try {
        expect(handleShortcut(key('s'))).toBe(true);
        await commandById('tb-save')!.run();
        expect(save.spy).toHaveBeenCalledTimes(2);
        expect(drive().prompt, 'no Drive file: the browser save it always was, and no form').toBeNull();
        expect(writes()).toEqual([]);

        const id = await attached();
        save.spy.mockClear();
        edit();
        expect(handleShortcut(key('s', { meta: true }))).toBe(true);
        await vi.waitFor(() => expect(drive().busy).toBeNull());
        expect(save.spy).toHaveBeenCalledTimes(1);
        expect(driveDirty(st())).toBe(false);
        expect(gateway.textOf(id)).toBe(withFinalNewline(st().textBuffer));

        edit('Kite');
        await commandById('tb-save')!.run();
        expect(save.spy).toHaveBeenCalledTimes(2);
        expect(driveDirty(st())).toBe(false);
        expect(gateway.textOf(id)).toContain('part def Kite;');
      } finally {
        save.restore();
      }
    });

    it('the command table names Save to Drive with the key that runs it', async () => {
      const command = commandById('tb-drive-save');
      expect(command).toMatchObject({ label: 'Save to Drive', shortcut: 'Ctrl+Shift+S' });
      await command!.run();
      expect(drive().prompt).toEqual({ kind: 'saveas', suggested: 'Swarm.sysml', asCopy: false });
    });

    it('the Text view’s editor hands on Ctrl/Cmd+S and Ctrl/Cmd+Shift+S — Drive gets what was typed — and keeps every other key', async () => {
      const save = browserSave();
      const view = render(React.createElement(TextEditor));
      try {
        const id = await act(() => attached());
        const editor = view.getByTestId('text-editor');
        const typed = SWARM.replace('Drone', 'Glider');
        fireEvent.change(editor, { target: { value: typed } });
        expect(st().textDirty).toBe(true);

        // The editor's own keys: nothing prevented, nothing saved, nothing undone.
        const depth = st().undoStack.length;
        for (const init of [
          { key: 'z', ctrlKey: true },
          { key: 'z', metaKey: true, shiftKey: true },
          { key: 'y', ctrlKey: true },
          { key: 'd', ctrlKey: true },
          { key: 'c', ctrlKey: true },
          { key: 'v', metaKey: true },
          { key: 's' },
          { key: 'S', shiftKey: true },
          { key: 's', altKey: true },
        ]) {
          expect(fireEvent.keyDown(editor, init), JSON.stringify(init)).toBe(true);
        }
        expect(st().undoStack.length).toBe(depth);
        expect(st().textBuffer).toBe(typed);
        expect(save.spy).not.toHaveBeenCalled();
        expect(calls('update')).toEqual([]);

        // Ctrl+Shift+S: the typed text is applied, and that is what Drive gets.
        expect(fireEvent.keyDown(editor, { key: 'S', ctrlKey: true, shiftKey: true }), 'default prevented').toBe(false);
        await act(() => vi.waitFor(() => expect(calls('update')).toHaveLength(1)));
        await act(() => vi.waitFor(() => expect(drive().busy).toBeNull()));
        expect(gateway.textOf(id)).toContain('part def Glider;');
        expect(save.spy).not.toHaveBeenCalled();

        // Cmd+S: this browser, and Drive again.
        fireEvent.change(editor, { target: { value: SWARM.replace('Drone', 'Kite') } });
        expect(fireEvent.keyDown(editor, { key: 's', metaKey: true }), 'default prevented').toBe(false);
        await act(() => vi.waitFor(() => expect(drive().busy).toBeNull()));
        expect(save.spy).toHaveBeenCalledTimes(1);
        expect(gateway.textOf(id)).toContain('part def Kite;');

        // Without Google Drive, Ctrl+Shift+S is left to the browser.
        act(() => useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } })));
        expect(fireEvent.keyDown(editor, { key: 'S', ctrlKey: true, shiftKey: true })).toBe(true);
      } finally {
        view.unmount();
        save.restore();
      }
    });

    /**
     * Ctrl/Cmd+S saves the MODEL. Text typed in the Text view and not applied
     * is not the model yet, so the editor applies it first: what the browser
     * keeps is what is on screen — on every deployment, and when the Drive
     * save cannot go ahead (offline) as well. The Drive save then uploads it
     * as the app lays it out, once the library settled over the apply.
     */
    it('Ctrl/Cmd+S typed in the Text view saves what was typed — without Google Drive, with it and no file, offline with a file — and Drive gets it laid out', async () => {
      /** The user parts the model held at each browser save. */
      const saved: string[][] = [];
      const save = browserSave();
      save.spy.mockImplementation(async () => {
        saved.push(st().model.all().filter((e) => e.eClass === 'PartDefinition' && e.attrs.isLibrary !== true).map((e) => e.declaredName ?? ''));
      });
      const view = render(React.createElement(TextEditor));
      const editor = view.getByTestId('text-editor');
      /** Type a part beside the Drone — laid out by hand — and press Ctrl+S in the editor. */
      const typeAndSave = async (name: string): Promise<void> => {
        fireEvent.change(editor, { target: { value: `package Swarm {\n  part def   Drone;\n part def ${name};}` } });
        expect(st().textDirty).toBe(true);
        expect(fireEvent.keyDown(editor, { key: 's', ctrlKey: true }), 'default prevented').toBe(false);
        await act(() => vi.waitFor(() => expect(drive().busy).toBeNull()));
        await act(() => whenLibrarySettled());
      };
      try {
        await act(() => model());
        const depth = st().undoStack.length;

        // A deployment without Google Drive (the placeholder `drive.json`).
        act(() => useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } })));
        await typeAndSave('Glider');
        expect(saved).toEqual([['Drone', 'Glider']]);
        expect(st().textDirty, 'applied').toBe(false);
        expect(st().undoStack.length, 'one undo step, as Apply').toBe(depth + 1);

        // Google Drive, no file attached: Ctrl+S is the browser save, with no form.
        act(() => useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'ready' } })));
        await typeAndSave('Kite');
        expect(saved.at(-1)).toEqual(['Drone', 'Kite']);
        expect(drive().prompt).toBeNull();
        expect(gateway.calls).toEqual([]);

        // A file attached, offline: the Drive save cannot go ahead; the browser save holds the typed text.
        const id = await act(() => attached());
        act(() => useAppStore.setState((s) => ({ drive: { ...s.drive, online: false } })));
        await typeAndSave('Blimp');
        expect(saved.at(-1)).toEqual(['Drone', 'Blimp']);
        expect(calls('update')).toEqual([]);
        expect(drive().notice?.message).toBe(DRIVE_MESSAGES.offline);

        // Online again: both saves hold it, and Drive gets the app's layout of it.
        act(() => useAppStore.setState((s) => ({ drive: { ...s.drive, online: true } })));
        await typeAndSave('Rotor');
        expect(saved.at(-1)).toEqual(['Drone', 'Rotor']);
        expect(calls('update')).toHaveLength(1);
        expect(gateway.textOf(id)).toBe(withFinalNewline(st().textBuffer));
        expect(gateway.textOf(id)).toContain('\n    part def Rotor;\n');
        expect(driveDirty(st())).toBe(false);
      } finally {
        view.unmount();
        save.restore();
      }
    });

    /**
     * Ctrl/Cmd+S does not apply a text with a syntax error: the parser's
     * recovery of it — here the parts after a stray `}` land outside the
     * package — is not what is on screen, and would overwrite the last good
     * copy in this browser. The browser keeps the model as it stands, and the
     * editor still reads "not yet applied"; Drive gets the text as typed.
     */
    it('Ctrl/Cmd+S typed in the Text view over a syntax error keeps the model as it stands in this browser — and Drive gets the text as typed', async () => {
      const GOOD = 'package Swarm {\n    part def Drone;\n    part def Relay;\n}\n';
      const STRAY = GOOD.replace('    part def Relay;', '    }\n    part def Relay;');
      /** The user's part definitions, each with the package that owns it. */
      const shape = () =>
        st()
          .model.all()
          .filter((e) => e.eClass === 'PartDefinition' && e.attrs.isLibrary !== true)
          .map((e) => `${e.declaredName}<${e.ownerId ? st().model.get(e.ownerId)?.declaredName : '-'}`);
      const saved: string[][] = [];
      const save = browserSave();
      save.spy.mockImplementation(async () => {
        saved.push(shape());
      });
      const view = render(React.createElement(TextEditor));
      const editor = view.getByTestId('text-editor');
      const typeAndSave = async (text: string): Promise<void> => {
        fireEvent.change(editor, { target: { value: text } });
        expect(fireEvent.keyDown(editor, { key: 's', ctrlKey: true }), 'default prevented').toBe(false);
        await act(() => vi.waitFor(() => expect(drive().busy).toBeNull()));
        await act(() => whenLibrarySettled());
      };
      try {
        await act(() => model(GOOD));
        const depth = st().undoStack.length;

        // Without Google Drive.
        act(() => useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } })));
        await typeAndSave(STRAY);
        expect(saved).toEqual([['Drone<Swarm', 'Relay<Swarm']]);
        expect(shape(), 'the model as it stood').toEqual(['Drone<Swarm', 'Relay<Swarm']);
        expect(st().textDirty, 'still "not yet applied"').toBe(true);
        expect(st().textBuffer).toBe(STRAY);
        expect(st().undoStack.length, 'nothing applied').toBe(depth);

        // A Drive file attached: the browser keeps the model as it stood, Drive the text as typed.
        act(() => useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'ready' } })));
        const id = await act(() => attached(GOOD));
        await typeAndSave(STRAY);
        expect(saved.at(-1)).toEqual(['Drone<Swarm', 'Relay<Swarm']);
        expect(gateway.textOf(id)).toBe(STRAY);
        expect(driveDirty(st())).toBe(false);
      } finally {
        view.unmount();
        save.restore();
      }
    });

    /**
     * Save to Drive is for what the file does not hold yet — the panel's
     * button is disabled otherwise. A save of the same text would still be a
     * new revision in Drive's history (of which it keeps about 100), and
     * after the hour a sign-in window for nothing.
     */
    it('sends nothing to a file that holds the model already — Ctrl/Cmd+S, Save, Ctrl/Cmd+Shift+S, also after the hour — but saves an edit still waiting on its recompute', async () => {
      const save = browserSave();
      try {
        const id = await attached();
        expect(driveDirty(st())).toBe(false);
        expect(handleShortcut(key('s'))).toBe(true);
        await commandById('tb-save')!.run();
        expect(handleShortcut(key('S', { shift: true })), 'the key is still this app’s').toBe(true);
        await commandById('tb-drive-save')!.run();
        await vi.waitFor(() => expect(drive().busy).toBeNull());
        expect(save.spy, 'the browser save still happens').toHaveBeenCalledTimes(2);
        expect(calls('update'), 'no new revision of the same text').toEqual([]);
        expect(drive().prompt).toBeNull();

        // After the hour: no sign-in window for nothing to save.
        clock += HOUR;
        const asked = signIns().length;
        handleShortcut(key('s', { meta: true }));
        handleShortcut(key('S', { shift: true, meta: true }));
        await vi.waitFor(() => expect(drive().busy).toBeNull());
        expect(signIns()).toHaveLength(asked);
        expect(calls('update')).toEqual([]);

        // An edit whose recompute still waits has not reached the text yet: that is saved.
        st().createElement('PartDefinition', st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id, 'Relay');
        expect(recomputePending()).toBe(true);
        expect(handleShortcut(key('S', { shift: true }))).toBe(true);
        await vi.waitFor(() => expect(calls('update')).toHaveLength(1));
        await vi.waitFor(() => expect(drive().busy).toBeNull());
        expect(gateway.textOf(id)).toContain('part def Relay;');
        expect(driveDirty(st())).toBe(false);

        // A hand-written file, opened and untouched: no question about a layout nothing would rewrite.
        const hand = gateway.seed({ name: 'Hand.sysml', text: HAND });
        await st().driveOpen({ id: hand.id }, 'recent');
        expect(file().rewrites).toBe(true);
        expect(handleShortcut(key('S', { shift: true }))).toBe(true);
        expect(drive().prompt).toBeNull();
        expect(calls('update')).toHaveLength(1);
      } finally {
        save.restore();
      }
    });

    /** The user's part definitions, by name. */
    const parts = () =>
      st()
        .model.all()
        .filter((e) => e.eClass === 'PartDefinition' && e.attrs.isLibrary !== true)
        .map((e) => e.declaredName ?? '');

    /** The browser save, recording the user parts the model held at each one. */
    function recordingSave() {
      const saved: string[][] = [];
      const save = browserSave();
      save.spy.mockImplementation(async () => {
        saved.push(parts());
      });
      return { saved, restore: save.restore };
    }

    /**
     * Save and Ctrl/Cmd+S store the MODEL, from the diagram, the tree or the
     * Text view's editor alike. Text typed in the Text view and not applied
     * is applied first, as the editor's Ctrl/Cmd+S always did, so the browser
     * keeps what is on screen; the toolbar's Save, and the key pressed with
     * the focus on the diagram or the tree, used to store the model without
     * it.
     */
    it('Save and Ctrl/Cmd+S away from the Text view apply what was typed there first — without Google Drive, with it and no file, offline and online with a file', async () => {
      const { saved, restore } = recordingSave();
      /** Type a part beside the Drone — laid out by hand — then Save (`button`) or press Ctrl+S with the focus elsewhere. */
      const typeAndSave = async (name: string, how: 'button' | 'key'): Promise<void> => {
        st().setTextBuffer(`package Swarm {\n  part def   Drone;\n part def ${name};}`);
        if (how === 'button') await commandById('tb-save')!.run();
        else expect(handleShortcut(key('s'))).toBe(true);
        await vi.waitFor(() => expect(drive().busy).toBeNull());
        await whenLibrarySettled();
      };
      try {
        await model();
        const depth = st().undoStack.length;

        // A deployment without Google Drive.
        useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
        await typeAndSave('Glider', 'button');
        expect(saved).toEqual([['Drone', 'Glider']]);
        expect(st().textDirty, 'applied').toBe(false);
        expect(st().undoStack.length, 'one undo step, as Apply').toBe(depth + 1);
        await typeAndSave('Kite', 'key');
        await vi.waitFor(() => expect(saved).toHaveLength(2));
        expect(saved.at(-1)).toEqual(['Drone', 'Kite']);

        // Google Drive, no file attached: the browser save, with no form.
        useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'ready' } }));
        await typeAndSave('Blimp', 'button');
        expect(saved.at(-1)).toEqual(['Drone', 'Blimp']);
        expect(drive().prompt).toBeNull();

        // A file attached, offline: the Drive save cannot go ahead; the browser save holds the typed text.
        const id = await attached();
        useAppStore.setState((s) => ({ drive: { ...s.drive, online: false } }));
        await typeAndSave('Rotor', 'key');
        await vi.waitFor(() => expect(saved.at(-1)).toEqual(['Drone', 'Rotor']));
        expect(calls('update')).toEqual([]);

        // Online again: both saves hold it, and Drive gets the app's layout of it.
        useAppStore.setState((s) => ({ drive: { ...s.drive, online: true } }));
        await typeAndSave('Vane', 'button');
        expect(saved.at(-1)).toEqual(['Drone', 'Vane']);
        expect(calls('update')).toHaveLength(1);
        expect(gateway.textOf(id)).toContain('\n    part def Vane;\n');
        expect(driveDirty(st())).toBe(false);
      } finally {
        restore();
      }
    });

    /**
     * Over a syntax error Save keeps the model as it stands in this browser:
     * the parser's recovery of the typed text is not what is on screen. And
     * since neither Problems nor the editor's strip lists the parse errors of
     * a text not applied, the strip under the toolbar says so and names the
     * line — on a deployment without Google Drive too. The next save that
     * holds the typed text takes the note down; a notice standing for
     * another reason is never covered by it.
     */
    it('Save and Ctrl/Cmd+S over a syntax error keep the model as it stands in this browser and say so, naming the line — until a save holds the text', async () => {
      const BROKEN = SWARM.replace('part def Drone;', 'part def Drone;\n    blok bad;');
      const { saved, restore } = recordingSave();
      try {
        await model();
        const depth = st().undoStack.length;
        useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
        st().setTextBuffer(BROKEN);
        await commandById('tb-save')!.run();
        expect(saved).toEqual([['Drone']]);
        expect(st().textDirty, 'still "not yet applied"').toBe(true);
        expect(st().textBuffer).toBe(BROKEN);
        expect(st().undoStack.length, 'nothing applied').toBe(depth);
        expect(drive().notice).toEqual({ kind: 'info', message: DRIVE_MESSAGES.typedTextKeptBack(3), retryable: false });
        expect(drive().notice?.message).toBe(
          'Saved in this browser without the text typed in the Text view: it has a syntax error at line 3. Fix it, then save again.',
        );

        // Ctrl+S, the same: no apply, no undo step, the one note.
        const note = drive().notice;
        expect(handleShortcut(key('s'))).toBe(true);
        await vi.waitFor(() => expect(saved).toHaveLength(2));
        expect(saved.at(-1)).toEqual(['Drone']);
        expect(st().undoStack.length).toBe(depth);
        expect(drive().notice).toEqual(note);

        // Fixed: the save holds it, and the note goes.
        st().setTextBuffer(SWARM.replace('Drone', 'Glider'));
        await commandById('tb-save')!.run();
        expect(saved.at(-1)).toEqual(['Glider']);
        expect(drive().notice).toBeNull();

        // A notice standing for another reason stays as it is.
        const refused = { kind: 'error' as const, message: DRIVE_MESSAGES.browserSaveFailed, retryable: false };
        useAppStore.setState((s) => ({ drive: { ...s.drive, notice: refused } }));
        st().setTextBuffer(BROKEN);
        await commandById('tb-save')!.run();
        expect(drive().notice).toBe(refused);
        st().setTextBuffer(SWARM);
        await commandById('tb-save')!.run();
        expect(drive().notice).toBe(refused);
      } finally {
        restore();
      }
    });

    /**
     * An edit made in the app after the typing replaces the typed text — its
     * recompute is forced — so a Save before that recompute ran must not
     * apply the older text over the edit: the edit goes first, as in a Drive
     * save's upload.
     */
    it('Save right after an edit in the app holds the edit: the edit’s recompute goes before the typed text', async () => {
      const { saved, restore } = recordingSave();
      try {
        await model();
        useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
        st().setTextBuffer(SWARM.replace('Drone', 'Typed'));
        st().createElement('PartDefinition', st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id, 'Edited');
        expect(forcedRecomputePending()).toBe(true);
        await commandById('tb-save')!.run();
        expect(saved).toEqual([['Drone', 'Edited']]);
        expect(st().textDirty).toBe(false);
        expect(st().textBuffer).toContain('part def Edited;');
      } finally {
        restore();
      }
    });

    /**
     * Save writes the project that is open. An apply names the project after
     * the model's first package, so a Save that applied typed text stored it
     * under that name — over another saved project, which a package renamed
     * in the app may share — and left the open project as it was.
     */
    it('Save that applies typed text writes the project that is open, not another one named after its package', async () => {
      const userParts = () => parts().sort();
      await model();
      useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
      await st().saveProject('Swarm');
      edit('Relay');
      await st().saveProject('Fleet');
      expect(st().projectName).toBe('Fleet');

      st().setTextBuffer(st().textBuffer.replace('part def Relay;', 'part def Relay;\n    part def Typed;'));
      await commandById('tb-save')!.run();
      expect(st().textDirty, 'applied').toBe(false);
      expect(st().projectName, 'still the open project').toBe('Fleet');
      await st().loadProject('Swarm');
      expect(userParts(), 'the other project, untouched').toEqual(['Drone']);
      await st().loadProject('Fleet');
      expect(userParts(), 'the open project holds the typed text').toEqual(['Drone', 'Relay', 'Typed']);
    });

    /**
     * In a collaboration room Save does not apply text typed in the Text
     * view: an apply resets the room's model for every peer, and the text was
     * typed over the model as it stood before — the room keeps a typed buffer
     * when a peer edits — so one Save erased the peers' edits for everyone.
     * It keeps the text back and says so; Apply text → model still puts it
     * over the room's model, as a choice. The guard's Save applies it: the
     * command it guards replaces the model anyway.
     */
    it('in a collaboration room, Save and Ctrl/Cmd+S keep typed text back — a peer’s edit since the typing stays, in the room and in the save — and say so', async () => {
      const { saved, restore } = recordingSave();
      const sorted = (names: string[]) => [...names].sort();
      const peerDoc = new Y.Doc();
      await model();
      useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
      st().connectCollab('save-room');
      try {
        // A peer, synced with the room through its document.
        const roomDoc = relay.doc!;
        Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(roomDoc));
        roomDoc.on('update', (u: Uint8Array, origin: unknown) => {
          if (origin !== 'peer') Y.applyUpdate(peerDoc, u, 'room');
        });
        peerDoc.on('update', (u: Uint8Array, origin: unknown) => {
          if (origin !== 'room') Y.applyUpdate(roomDoc, u, 'peer');
        });
        const peer = new Model();
        bindModelToDoc(peer, peerDoc);
        const peerParts = () =>
          sorted(peer.all().filter((e) => e.eClass === 'PartDefinition').map((e) => e.declaredName ?? ''));
        expect(peerParts()).toEqual(['Drone']);

        // Typed here; the peer adds a part meanwhile.
        st().setTextBuffer(SWARM.replace('part def Drone;', 'part def Drone;\n    part def Typed;'));
        peer.create('PartDefinition', { declaredName: 'PeerWork', ownerId: peer.roots()[0].id });
        flushRecompute();
        expect(sorted(parts())).toEqual(['Drone', 'PeerWork']);
        expect(st().textDirty, 'the typed text stays').toBe(true);

        await commandById('tb-save')!.run();
        expect(saved.map(sorted)).toEqual([['Drone', 'PeerWork']]);
        expect(peerParts(), 'the peer’s edit stays in the room').toEqual(['Drone', 'PeerWork']);
        expect(st().textDirty, 'still "not yet applied"').toBe(true);
        expect(drive().notice).toEqual({ kind: 'info', message: DRIVE_MESSAGES.typedTextInRoom, retryable: false });
        expect(handleShortcut(key('s'))).toBe(true);
        await vi.waitFor(() => expect(saved).toHaveLength(2));
        expect(peerParts()).toEqual(['Drone', 'PeerWork']);

        // Apply text → model puts it over the room's model; Save then holds it, and the note goes.
        st().applyText();
        expect(peerParts()).toEqual(['Drone', 'Typed']);
        await commandById('tb-save')!.run();
        expect(sorted(saved.at(-1)!)).toEqual(['Drone', 'Typed']);
        expect(drive().notice).toBeNull();

        // The guard's Save applies typed text, in a room too, and New goes on.
        st().setTextBuffer(st().textBuffer.replace('part def Typed;', 'part def Typed;\n    part def Guarded;'));
        const run = vi.fn();
        st().driveGuard('New', 'dirty', run);
        expect(drive().prompt).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
        await st().driveRunPending('save');
        expect(sorted(saved.at(-1)!)).toEqual(['Drone', 'Guarded', 'Typed']);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        st().disconnectCollab();
        peerDoc.destroy();
        restore();
      }
    });

    /**
     * The library merges again after every apply, and the refresh after it
     * lays the text out anew — but not over text typed since. Keystrokes made
     * right after a Save that applied the text, while the library merged,
     * were replaced: neither in the model nor anywhere else.
     */
    it('typing right after a Save that applied the text, while the library merges again, is kept', async () => {
      const { restore } = recordingSave();
      try {
        await model();
        useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
        const release = holdLibrary();
        st().setTextBuffer(SWARM.replace('part def Drone;', 'part def Drone;\n    part def Saved;'));
        await commandById('tb-save')!.run();
        expect(st().textDirty, 'applied').toBe(false);
        const typed = st().textBuffer.replace('part def Saved;', 'part def Saved;\n    part def AfterSave;');
        st().setTextBuffer(typed);
        release();
        await whenLibrarySettled();
        expect(st().textBuffer).toBe(typed);
        expect(st().textDirty, 'still "not yet applied"').toBe(true);
        expect(parts()).toEqual(['Drone', 'Saved']);
      } finally {
        restore();
      }
    });

    /**
     * An edit made through the SDK on `window.sysml` reaches the Text view, so
     * the attached Drive file reads unsaved and Save to Drive sends it — as
     * Save does. It used to change the model alone: Ctrl/Cmd+Shift+S sent
     * nothing, while Save stored the edit in the browser.
     */
    it('an edit made through the SDK reads unsaved in Drive: Ctrl/Cmd+Shift+S and Save send it', async () => {
      const save = browserSave();
      // The SDK is bound to the model the store started with: these run on it.
      useAppStore.setState({ model: st().api.model });
      try {
        const id = await attached();
        const root = st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id;

        // Its recompute still waiting: the edit counts already.
        const relay = st().api.create('PartDefinition', { declaredName: 'Relay', ownerId: root });
        expect(forcedRecomputePending()).toBe(true);
        expect(handleShortcut(key('S', { shift: true }))).toBe(true);
        await vi.waitFor(() => expect(calls('update')).toHaveLength(1));
        await vi.waitFor(() => expect(drive().busy).toBeNull());
        expect(gateway.textOf(id)).toContain('part def Relay;');
        expect(driveDirty(st())).toBe(false);

        // Its recompute run: the strip's "unsaved changes", and Save sends it too.
        st().api.update(relay.id, { declaredName: 'Kite' });
        flushRecompute();
        expect(driveDirty(st())).toBe(true);
        await commandById('tb-save')!.run();
        expect(save.spy).toHaveBeenCalledTimes(1);
        expect(calls('update')).toHaveLength(2);
        expect(gateway.textOf(id)).toContain('part def Kite;');
        expect(driveDirty(st())).toBe(false);
      } finally {
        save.restore();
      }
    });
  });
});

/**
 * What New, Open ▾, Import, a branch switch, a merge and a room join ask
 * about: work nothing holds. The text the model had when last saved — in this
 * browser or to Google Drive — or opened is recorded as text, never as `rev`,
 * and the session's starting model counts as saved: a first visit that
 * touched nothing has nothing to lose. These run without Google Drive (the
 * slice is `absent`, as on most deployments): the question is asked there too.
 */
describe('unsaved work — what a command that replaces the model asks about', () => {
  const SWARM = 'package Swarm {\n    part def Drone;\n}\n';
  const FAULTED = 'package Swarm {\n    blok bad;\n}\n';
  const rootNames = () => st().model.roots().filter((r) => r.attrs.isLibrary !== true).map((r) => r.declaredName);
  const named = (name: string) => st().model.all().some((e) => e.declaredName === name);
  const unsaved = () => browserDirty(st());
  const prompt = () => st().drive.prompt;
  const rootId = () => st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id;
  let warn: ReturnType<typeof vi.spyOn>;

  /** An edit by the tree, its recompute fired: the Text view shows it. */
  function edit(name = 'Relay'): void {
    st().createElement('PartDefinition', rootId(), name);
    flushRecompute();
  }

  /** Hold the next library load until the returned function is called. */
  function holdLibrary(): () => void {
    let release!: () => void;
    lib.holds.push(new Promise<void>((r) => (release = r)));
    return release;
  }

  beforeEach(async () => {
    await whenLibrarySettled();
    lib.merge = null;
    reset();
    useAppStore.setState({ textBuffer: '', textDirty: false, diagnostics: [], serializeError: null });
    st().newProject('Swarm');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    useAppStore.setState({ drive: initialDriveState });
  });

  it('reads saved after New, Save and Open, unsaved after an edit, an import or typed text — and saved again after Undo', async () => {
    expect(st().drive.configStatus, 'no Google Drive here').toBe('absent');
    expect(unsaved(), 'New').toBe(false);
    edit('Relay');
    expect(unsaved(), 'an edit').toBe(true);
    st().undo();
    expect(unsaved(), 'undone back to the saved model').toBe(false);
    st().redo();
    expect(unsaved()).toBe(true);
    await st().saveProject('Swarm');
    expect(unsaved(), 'Save').toBe(false);

    const saved = st().textBuffer;
    st().setTextBuffer(saved.replace('Relay', 'Kite'));
    expect(unsaved(), 'text typed and not applied').toBe(true);
    st().setTextBuffer(saved);
    expect(unsaved(), 'typed back as it was').toBe(false);

    st().importModel(SWARM, 'sysml');
    expect(unsaved(), 'an import is not a save').toBe(true);
    await whenLibrarySettled();
    await st().loadProject('Swarm');
    expect(rootNames()).toEqual(['Swarm']);
    expect(named('Relay')).toBe(true);
    expect(unsaved(), 'Open').toBe(false);
    await whenLibrarySettled();
    expect(unsaved(), 'and still once its library merged').toBe(false);
  });

  it('counts a save from the click: an edit made while the browser stores it reads unsaved, and a refused save is taken back', async () => {
    edit('Relay');
    const saving = st().saveProject('Swarm');
    expect(unsaved(), 'saved as of the click').toBe(false);
    edit('Kite');
    await saving;
    expect(unsaved(), 'the edit made meanwhile').toBe(true);

    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      await expect(st().saveProject('Swarm')).rejects.toThrow();
      expect(unsaved(), 'nothing was stored').toBe(true);
    } finally {
      refuse.mockRestore();
    }
  });

  it('takes back a refused save that the library merge laid out afresh while the browser stored it', async () => {
    await st().saveProject('Swarm');
    let refuse!: () => void;
    const refusing = new Promise<void>((r) => (refuse = r));
    const store = vi.spyOn(LocalStorageStore.prototype, 'saveProject').mockImplementation(async () => {
      await refusing;
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      // Typed text the app lays out otherwise: Save applies it, and the
      // library merges over it while the browser stores it.
      const release = holdLibrary();
      st().setTextBuffer('package   Swarm {\n\n\n  part def   Drone ;\n}\n');
      const saving = runSave();
      release();
      await whenLibrarySettled();
      expect(st().textBuffer, 'laid out afresh').toBe('package Swarm {\n    part def Drone;\n}');
      expect(unsaved(), 'saved as of the click').toBe(false);
      refuse();
      await expect(saving).rejects.toThrow();
      expect(unsaved(), 'nothing was stored').toBe(true);
      const run = vi.fn();
      st().driveGuard('New', 'dirty', run);
      expect(run).not.toHaveBeenCalled();
      expect(prompt()).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
      await st().driveRunPending('keep');
    } finally {
      store.mockRestore();
    }
  });

  it('the library merge after an open leaves a saved model saved, in its new layout — but not an edit waiting on its recompute', async () => {
    edit('Relay');
    await st().saveProject('Swarm');
    // A merge that changes how the user's text reads, as binding the
    // library's types may: the refresh lays the text out anew.
    lib.merge = (m) => {
      const relay = m.all().find((e) => e.declaredName === 'Relay');
      if (relay && relay.declaredShortName === undefined) m.setShortName(relay.id, 'R1');
    };
    let release = holdLibrary();
    await st().loadProject('Swarm');
    expect(unsaved()).toBe(false);
    release();
    await whenLibrarySettled();
    expect(st().textBuffer, 'the refresh changed the text').toContain('<R1>');
    expect(unsaved(), 'the merge is not an edit').toBe(false);

    lib.merge = (m) => {
      const relay = m.all().find((e) => e.declaredName === 'Relay');
      if (relay) m.setShortName(relay.id, 'R2');
    };
    release = holdLibrary();
    await st().loadProject('Swarm');
    st().createElement('PartDefinition', rootId(), 'Waiting');
    expect(recomputePending()).toBe(true);
    release();
    await whenLibrarySettled();
    flushRecompute();
    expect(st().textBuffer).toContain('Waiting');
    expect(unsaved(), 'the edit made while the library merged').toBe(true);
  });

  it('asks before a command replaces unsaved work: Keep editing keeps it, Discard runs the command, Save saves it in this browser first', async () => {
    const run = vi.fn();
    st().driveGuard('New', 'dirty', run);
    expect(run, 'saved: at once').toHaveBeenCalledTimes(1);
    expect(prompt()).toBeNull();

    // An edit whose recompute is still waiting counts.
    st().createElement('PartDefinition', rootId(), 'Relay');
    expect(recomputePending()).toBe(true);
    st().driveGuard('New', 'dirty', run);
    expect(prompt()).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
    await st().driveRunPending('keep');
    expect(run).toHaveBeenCalledTimes(1);
    expect(prompt()).toBeNull();
    expect(named('Relay')).toBe(true);

    st().driveGuard('Switch branch', 'dirty', run);
    await st().driveRunPending('discard');
    expect(run).toHaveBeenCalledTimes(2);
    expect(prompt()).toBeNull();

    // Save and continue: the text typed in the Text view is applied and
    // saved with the model, then the command runs.
    st().setTextBuffer(st().textBuffer.replace('Relay', 'Kite'));
    st().driveGuard('Import', 'dirty', () => st().newProject('Fresh'));
    expect(prompt()).toEqual({ kind: 'guard', label: 'Import', variant: 'browser' });
    await st().driveRunPending('save');
    expect(rootNames()).toEqual(['Fresh']);
    await st().loadProject('Swarm');
    expect(named('Kite'), 'what was typed was saved').toBe(true);
    expect(named('Relay')).toBe(false);

    // A question no longer standing runs nothing.
    await st().driveRunPending('discard');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('Save and continue, then New: the saved text’s parse rows do not come back once its library settles', async () => {
    const release = holdLibrary();
    st().setTextBuffer('package Swarm {\n    part def Drone :> Missing;\n}\n');
    st().driveGuard('New', 'dirty', () => st().newProject('Fresh'));
    expect(prompt()).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
    await st().driveRunPending('save');
    expect(rootNames()).toEqual(['Fresh']);
    release();
    await whenLibrarySettled();
    flushRecompute();
    expect(st().textBuffer).toBe('package Fresh;');
    expect(st().diagnostics.filter((d) => d.ruleId === 'parse')).toEqual([]);
  });

  it('holds the command when the browser refuses the save, saying so — and when the typed text has a syntax error', async () => {
    edit('Relay');
    const run = vi.fn();
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      st().driveGuard('New', 'dirty', run);
      await st().driveRunPending('save');
      expect(run).not.toHaveBeenCalled();
      expect(prompt(), 'the question stands again').toEqual({ kind: 'guard', label: 'New', variant: 'browser', refused: true });
      expect(unsaved()).toBe(true);
    } finally {
      refuse.mockRestore();
    }
    await st().driveRunPending('save');
    expect(run, 'saved this time').toHaveBeenCalledTimes(1);
    expect(unsaved()).toBe(false);

    // Typed text the parser cannot read is not a model this browser can keep.
    st().setTextBuffer(FAULTED);
    st().driveGuard('New', 'dirty', run);
    await st().driveRunPending('save');
    expect(run).toHaveBeenCalledTimes(1);
    expect(prompt()).toEqual({ kind: 'guard', label: 'New', variant: 'browser', refused: false });
    expect(st().textBuffer, 'not applied').toBe(FAULTED);
    expect(st().textDirty).toBe(true);
    expect(rootNames()).toEqual(['Swarm']);
  });

  it('waits for a save the browser is still storing: runs once it is kept, asks — saying so — once it is refused', async () => {
    edit('Relay');
    const run = vi.fn();
    let saving = st().saveProject('Swarm');
    st().driveGuard('New', 'dirty', run);
    expect(run, 'not while the browser stores it').not.toHaveBeenCalled();
    expect(prompt()).toBeNull();
    await saving;
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(prompt(), 'kept: nothing to ask').toBeNull();

    edit('Kite');
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      saving = st().saveProject('Swarm');
      st().driveGuard('New', 'dirty', run);
      await expect(saving).rejects.toThrow();
      await vi.waitFor(() => expect(prompt()).not.toBeNull());
      expect(prompt()).toEqual({ kind: 'guard', label: 'New', variant: 'browser', refused: true });
      expect(run).toHaveBeenCalledTimes(1);
      await st().driveRunPending('keep');
    } finally {
      refuse.mockRestore();
    }

    // A Drive open runs inside its click, so it does not wait: it asks.
    const open = vi.fn();
    saving = st().saveProject('Swarm');
    st().driveGuard('Open from Drive', 'open', open);
    expect(prompt()).toEqual({ kind: 'guard', label: 'Open from Drive', variant: 'open' });
    await saving;
    await st().driveRunPending('keep');
    st().driveGuard('Open from Drive', 'open', open);
    expect(open, 'saved, and stored').toHaveBeenCalledTimes(1);
  });

  it("a Drive open asks about work no save holds — text typed and not applied too — not about Undo's history", async () => {
    const open = vi.fn();
    useAppStore.setState({ undoStack: [], redoStack: [] });
    st().setTextBuffer(SWARM);
    st().driveGuard('Open from Drive', 'open', open);
    expect(prompt(), 'typed, not applied').toEqual({ kind: 'guard', label: 'Open from Drive', variant: 'open' });
    await st().driveRunPending('keep');

    st().applyText();
    await st().saveProject('Swarm');
    expect(st().undoStack.length).toBeGreaterThan(0);
    st().driveGuard('Open from Drive', 'open', open);
    expect(open, 'saved, Undo or not').toHaveBeenCalledTimes(1);
    expect(prompt()).toBeNull();
  });

  it('a Versions commit holds the work as a save does, and so does a branch head the tab loads; a merge that meets conflicts loads nothing', async () => {
    const run = vi.fn();
    st().refreshVersions();
    const main = st().currentBranchId;
    edit('Relay');
    expect(unsaved()).toBe(true);
    st().commitVersion('relay');
    expect(unsaved(), 'committed').toBe(false);
    st().driveGuard('New', 'dirty', run);
    expect(run, 'nothing a commit does not hold').toHaveBeenCalledTimes(1);

    st().createBranchCmd('kite');
    const kite = st().currentBranchId;
    const relay = () => st().model.all().find((e) => e.declaredName === 'Relay' || e.declaredName === 'Kite' || e.declaredName === 'Wing')!;
    st().updateElement(relay().id, { declaredName: 'Kite' });
    flushRecompute();
    st().commitVersion('kite');
    st().switchBranch(main);
    expect(named('Kite')).toBe(false);
    expect(unsaved(), 'the head of main').toBe(false);
    await whenLibrarySettled();
    expect(unsaved(), 'and once its library merged').toBe(false);

    // main renames the same element: a manual merge meets a conflict, makes
    // no commit and loads nothing — so the Versions tab asks nothing first.
    st().updateElement(relay().id, { declaredName: 'Wing' });
    flushRecompute();
    st().commitVersion('wing');
    expect(mergeLoads(kite, main, 'manual')).toBe(false);
    expect(mergeLoads(kite, main, 'theirs')).toBe(true);
    edit('Unsaved');
    const text = st().textBuffer;
    st().mergeBranchesCmd(kite, main, 'manual');
    expect(st().mergeResult?.commitId).toBeUndefined();
    expect(st().textBuffer, 'nothing loaded').toBe(text);
    expect(unsaved()).toBe(true);

    // One that resolves loads its merge commit, which holds it.
    st().mergeBranchesCmd(kite, main, 'theirs');
    expect(named('Kite')).toBe(true);
    expect(named('Unsaved')).toBe(false);
    expect(unsaved(), 'the merge commit').toBe(false);
  });

  it('a model saved to or opened from Drive needs no saving; with a Drive file attached its own question is the only one', async () => {
    const CONFIG: DriveConfig = {
      clientId: '123456789012-abc123def456.apps.googleusercontent.com',
      privacyUrl: 'https://example.org/site/privacy/',
    };
    const auth = new FakeDriveAuth({ now: () => Date.now(), loaded: true });
    const gateway = new InMemoryDriveGateway({ now: () => Date.now(), token: () => auth.token() });
    setDriveServices({ auth, gateway, picker: null });
    useAppStore.setState({ drive: { ...initialDriveState, configStatus: 'ready', config: CONFIG } });
    try {
      await st().driveSignIn();
      const run = vi.fn();

      // Saved to Drive as a new file: Drive holds it — and while it is
      // attached, only its unsaved changes are asked about.
      edit('Relay');
      await st().driveSaveAs('Swarm');
      expect(st().drive.file).not.toBeNull();
      expect(unsaved(), 'a Drive save').toBe(false);
      useAppStore.setState({ savedText: 'package Elsewhere;\n' });
      st().driveGuard('New', 'dirty', run);
      expect(run, 'the attached file holds the model').toHaveBeenCalledTimes(1);
      edit('Kite');
      st().driveGuard('New', 'dirty', run);
      expect(prompt()).toEqual({ kind: 'guard', label: 'New', variant: 'dirty' });
      await st().driveRunPending('keep');

      // Let go of, unsaved: the question is this browser's now.
      st().driveDetach();
      st().driveGuard('Join room', 'dirty', run);
      expect(prompt()).toEqual({ kind: 'guard', label: 'Join room', variant: 'browser' });
      await st().driveRunPending('keep');

      // A file opened from Drive is saved where it came from: the .sysml
      // attached, a model JSON file not attached.
      const other = gateway.seed({ name: 'Other.sysml', text: 'package Other;\n' });
      await st().driveOpen({ id: other.id }, 'recent');
      expect(rootNames()).toEqual(['Other']);
      st().driveDetach();
      expect(unsaved(), 'a Drive open').toBe(false);
      const json = gateway.seed({ name: 'Json.json', text: exportModel(parseModel(SWARM).model, 'model-json') });
      await st().driveOpen({ id: json.id }, 'recent');
      expect(st().drive.file).toBeNull();
      expect(rootNames()).toEqual(['Swarm']);
      expect(unsaved(), 'a Drive open of model JSON').toBe(false);
      st().driveGuard('New', 'dirty', run);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      setDriveServices(null);
    }
  });
});

/**
 * The SDK on `window.sysml` changes the model directly, outside every store
 * command. Outside a collaboration room nothing used to follow: the Text view
 * kept the old text, so neither the copy in this browser nor an attached
 * Drive file read unsaved, and New, Open or Import asked nothing before
 * dropping the edit. Every SDK call that moves the model now refreshes what
 * the store derives from it, once — and never replaces text typed in the Text
 * view and not applied.
 */
describe('edits through the SDK on window.sysml — the Text view, and what reads unsaved', () => {
  const FAULTED = 'package Swarm {\n    blok bad;\n}\n';
  const sdk = () => st().api;
  const named = (name: string) => st().model.all().some((e) => e.declaredName === name);
  const unsaved = () => browserDirty(st());
  const rootId = () => st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id;

  beforeEach(async () => {
    await whenLibrarySettled();
    lib.merge = null;
    reset();
    // The SDK is bound to the model the store started with: these run on it.
    useAppStore.setState({ model: sdk().model, textBuffer: '', textDirty: false, diagnostics: [], serializeError: null });
    st().newProject('Swarm');
  });

  afterEach(() => {
    useAppStore.setState({ drive: initialDriveState });
  });

  it('every edit it makes refreshes the Text view at once and reads unsaved — create, update, reparent, delete, commit(fn) — and a read changes nothing', async () => {
    const root = rootId();
    let rev = st().rev;
    sdk().elementsOfType('PartDefinition');
    sdk().getElement(root);
    sdk().toModelJSON();
    expect(st().rev, 'a read').toBe(rev);
    expect(recomputePending()).toBe(false);

    const relay = sdk().create('PartDefinition', { declaredName: 'Relay', ownerId: root });
    expect(st().rev, 'the Explorer and Properties refresh at once').toBe(rev + 1);
    expect(recomputePending(), 'the Text view, Problems and the diagram with the next recompute').toBe(true);
    flushRecompute();
    expect(st().textBuffer).toContain('part def Relay;');
    expect(st().textDirty).toBe(false);
    expect(unsaved()).toBe(true);
    await st().saveProject('Swarm');
    expect(unsaved()).toBe(false);

    sdk().update(relay.id, { declaredName: 'Kite' });
    flushRecompute();
    expect(st().textBuffer).toContain('part def Kite;');
    expect(unsaved()).toBe(true);

    const fleet = sdk().create('Package', { declaredName: 'Fleet' });
    sdk().reparent(relay.id, fleet.id);
    flushRecompute();
    expect(st().textBuffer).toMatch(/package Fleet \{\s*part def Kite;\s*\}/);

    // A deleted selection does not stay selected.
    st().select(relay.id);
    sdk().delete(fleet.id);
    expect(st().selectionIds).not.toContain(relay.id);
    flushRecompute();
    expect(st().textBuffer).not.toContain('Kite');
    expect(st().textBuffer).not.toContain('Fleet');

    // A batch is one edit: one refresh.
    rev = st().rev;
    sdk().commit((api) => {
      api.create('PartDefinition', { declaredName: 'Alpha', ownerId: root });
      api.create('PartDefinition', { declaredName: 'Beta', ownerId: root });
    });
    expect(st().rev).toBe(rev + 1);
    flushRecompute();
    expect(st().textBuffer).toMatch(/part def Alpha;\s*part def Beta;/);

    // Unsaved, so New asks first.
    const run = vi.fn();
    st().driveGuard('New', 'dirty', run);
    expect(run).not.toHaveBeenCalled();
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
    await st().driveRunPending('keep');
  });

  /**
   * Validate, Check, Simulate and Solve set rows of their own, and used to
   * drop the recompute an edit was still waiting on — its Text view refresh
   * with it. A script's edit followed by one of them (`sysml.create(…)`, then
   * Validate) never reached the text: nothing read unsaved, an attached
   * Drive file read clean, and New dropped the edit without asking.
   */
  it('an edit, then Validate, Check, Simulate or Solve before its refresh: the Text view shows it, and New asks', async () => {
    const actions: Array<[string, () => void]> = [
      ['Validated', () => st().runValidation()],
      ['Checked', () => st().runConstraintCheck()],
      ['Simulated', () => st().simulate()],
      ['Solved', () => st().solveParametric()],
    ];
    for (const [name, run] of actions) {
      await st().saveProject('Swarm');
      expect(unsaved()).toBe(false);
      sdk().create('PartDefinition', { declaredName: name, ownerId: rootId() });
      expect(recomputePending()).toBe(true);
      run();
      expect(recomputePending(), name).toBe(false);
      expect(st().textBuffer, name).toContain(`part def ${name};`);
      expect(unsaved(), name).toBe(true);
    }
    expect(st().diagnostics.some((d) => d.ruleId === 'solve'), 'Solve’s rows stand').toBe(true);

    const run = vi.fn();
    st().driveGuard('New', 'dirty', run);
    expect(run).not.toHaveBeenCalled();
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
    await st().driveRunPending('keep');
  });

  /**
   * THE RULE FOR THE TEXT. Text typed in the Text view and not applied is the
   * user's, and an SDK edit never replaces it: it stays, reading "not yet
   * applied", as it does when a collaborator edits the model. Applying it
   * puts it over the SDK's edit, and one Undo brings the edit back. A text
   * nobody typed — the one a faulted apply kept — is no longer the model
   * once the SDK edits it, and is regenerated: a Drive file opened with a
   * syntax error must read unsaved after the edit.
   */
  it('never replaces text typed and not applied — Apply puts it over the edit, one Undo away — but regenerates the text a faulted apply kept', async () => {
    const relay = sdk().create('PartDefinition', { declaredName: 'Relay', ownerId: rootId() });
    flushRecompute();
    await st().saveProject('Swarm');
    const typed = st().textBuffer.replace('Relay', 'Typed');
    st().setTextBuffer(typed);

    sdk().update(relay.id, { declaredName: 'Kite' });
    expect(recomputePending()).toBe(true);
    expect(forcedRecomputePending(), 'a recompute that keeps the typed text').toBe(false);
    flushRecompute();
    expect(st().textBuffer, 'the typed text stays').toBe(typed);
    expect(st().textDirty).toBe(true);
    expect(named('Kite'), 'the edit is in the model').toBe(true);
    expect(unsaved()).toBe(true);

    st().applyText();
    expect(named('Typed')).toBe(true);
    expect(named('Kite')).toBe(false);
    st().undo();
    expect(named('Kite'), 'one Undo brings the edit back').toBe(true);
    await whenLibrarySettled();

    await openText(FAULTED, 'sysml');
    expect(st().textDirty, 'a faulted apply keeps its text').toBe(true);
    expect(lastAppliedText()).toBe(FAULTED);
    sdk().create('PartDefinition', { declaredName: 'Fresh', ownerId: rootId() });
    expect(forcedRecomputePending()).toBe(true);
    flushRecompute();
    expect(st().textDirty).toBe(false);
    expect(st().textBuffer).toContain('part def Fresh;');
    expect(lastAppliedText()).toBeNull();
  });

  /**
   * A Text view typed back to the model's own text — a character typed and
   * deleted, the textarea's own Undo — holds nothing typed: an SDK edit then
   * shows in it and reads unsaved, and Save keeps the edit rather than
   * applying the old text over it.
   */
  it('takes a text typed back to the model’s for the model’s: an SDK edit shows, reads unsaved, and Save keeps it', async () => {
    sdk().create('PartDefinition', { declaredName: 'Relay', ownerId: rootId() });
    flushRecompute();
    await st().saveProject('Swarm');
    const same = st().textBuffer;
    st().setTextBuffer(`${same}x`);
    expect(st().textDirty).toBe(true);
    st().setTextBuffer(same);
    expect(st().textDirty, 'nothing typed stands').toBe(false);

    sdk().create('PartDefinition', { declaredName: 'Kite', ownerId: rootId() });
    expect(forcedRecomputePending()).toBe(true);
    flushRecompute();
    expect(st().textBuffer).toContain('part def Kite;');
    expect(unsaved()).toBe(true);
    const run = vi.fn();
    st().driveGuard('New', 'dirty', run);
    expect(run).not.toHaveBeenCalled();
    expect(st().drive.prompt).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
    await st().driveRunPending('keep');

    await runSave();
    expect(named('Kite')).toBe(true);
    expect(unsaved()).toBe(false);
    await st().loadProject('Swarm');
    expect(named('Kite'), 'the save holds the edit').toBe(true);
  });

  /**
   * In a room the store's model listener already refreshes after every
   * change, the SDK's included — keeping a dirty buffer, as a peer's edit
   * must. The SDK edit adds no second `rev` bump and no second recompute; it
   * only makes that recompute regenerate a text nobody typed.
   */
  it('in a collaboration room, one SDK edit is one refresh — which regenerates a text nobody typed there too', async () => {
    const rebuild = st().rebuildDiagram;
    const rebuilt = vi.fn(async () => {});
    useAppStore.setState({ rebuildDiagram: rebuilt });
    st().connectCollab('sdk-room');
    try {
      const relay = sdk().create('PartDefinition', { declaredName: 'Relay', ownerId: rootId() });
      await vi.waitFor(() => expect(recomputePending()).toBe(false));
      rebuilt.mockClear();
      const rev = st().rev;
      sdk().update(relay.id, { declaredName: 'Kite' });
      expect(st().rev, 'one bump: the listener’s').toBe(rev + 1);
      await vi.waitFor(() => expect(recomputePending()).toBe(false));
      expect(rebuilt, 'one recompute').toHaveBeenCalledTimes(1);
      expect(st().textBuffer).toContain('part def Kite;');

      await openText(FAULTED, 'sysml');
      expect(lastAppliedText()).toBe(FAULTED);
      sdk().create('PartDefinition', { declaredName: 'Fresh', ownerId: rootId() });
      flushRecompute();
      expect(st().textBuffer).toContain('part def Fresh;');
      expect(st().textDirty).toBe(false);
    } finally {
      st().disconnectCollab();
      useAppStore.setState({ rebuildDiagram: rebuild });
    }
  });
});

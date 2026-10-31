import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { Model, isRelationship, type ElementRecord } from '@core/index';
import { LEGACY_STORAGE_DB } from '../../src/branding';
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
  askBeforeLeaving,
  bootDrive,
  browserDirty,
  checkFileName,
  driveDirty,
  driveFileName,
  driveLink,
  driveMessage,
  flushRecompute,
  forcedRecomputePending,
  initialDriveState,
  lastAppliedText,
  leaveBeforeUnload,
  loadHealth,
  loadHealthAtHand,
  loadHealthNow,
  mergeLoads,
  openText,
  pageLinks,
  recomputePending,
  sayWhatTheBrowserKept,
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
  createDefaultStore,
  createGisPopupAuth,
  exportModel,
  type DriveConfig,
  type GisTokenResponse,
  type GoogleNs,
} from '@persistence/index';
import * as textApi from '@text/index';
import * as validationApi from '@validation/index';
import { isStaleCopy, parseModel, serializeElement, serializeModel, serializeUserModelSignals, settleRedefinitions } from '@text/index';
import {
  NOTE_BODY_TERMINATOR,
  checkConstraints,
  checkConstraintsNumeric,
  getRequirementAttr,
  requirementShortId,
  statementKindOf,
} from '@semantics/index';
import { effectiveNameOf } from '@semantics/inheritance';
import { initialSubstate } from '@semantics/mc/config';
import { verifyModel } from '../../src/api/verification';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { commandById, handlePageKey, handleShortcut, runExportSysml, runSave } from '../../src/ui/commands';
import { CHECKS, runCheck } from '../../src/ui/checks';
import { degradedRow } from '../../src/ui/behaviour-checks';
import { TextEditor } from '../../src/ui/panels/TextEditor';
import { Properties } from '../../src/ui/panels/Properties';

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

  /**
   * Undo, Redo and Save then Open take the model through a serialised copy, and
   * a load rebuilds each owner's children from the order that copy lists them
   * in. Listed in the order they were added, a reparented state came back where
   * it had been added: the Text view rewrote itself, and a machine with no
   * `initial` opened in another state (review 2026-10-14 D-2, D's probe d3).
   */
  it('Undo, Redo and Save then Open after a reparent give the model back as it was: its text byte for byte, and the states it opens in', async () => {
    st().importModel(
      [
        'package P {',
        '    part def Machine {',
        '        state def M {',
        '            state A;',
        '            state B;',
        '            state C;',
        '            state Work {',
        '                state Prep;',
        '                state Run;',
        '            }',
        '            transition t1 first A accept go then B;',
        '        }',
        '    }',
        '}',
        '',
      ].join('\n'),
      'sysml',
    );
    await whenLibrarySettled();
    flushRecompute();
    const named = (name: string) => st().model.all().find((e) => e.declaredName === name)!.id;
    // Neither the machine nor its composite state names an `initial`: each opens in its first state.
    const opensIn = () =>
      ['M', 'Work'].map((owner) => st().model.get(initialSubstate(st().model, named(owner))!)?.declaredName).join(' ');
    expect(opensIn()).toBe('A Prep');
    // In the Explorer: A dragged out of the machine and back in, now its last state; C, older than Work, dragged into it.
    st().reparent(named('A'), named('Machine'));
    st().reparent(named('A'), named('M'));
    st().reparent(named('C'), named('Work'));
    flushRecompute();
    const moved = st().textBuffer;
    expect(moved.indexOf('state A;')).toBeGreaterThan(moved.indexOf('state Work'));
    expect(moved.indexOf('state C;')).toBeGreaterThan(moved.indexOf('state Run;'));
    expect(opensIn()).toBe('B Prep');

    // An edit after the reparents, undone: the model as it was before the edit, the reparents in it.
    st().createElement('PartDefinition', named('P'), 'Later');
    flushRecompute();
    const edited = st().textBuffer;
    expect(edited).toContain('part def Later;');
    st().undo();
    flushRecompute();
    expect(st().textBuffer, 'Undo').toBe(moved);
    expect(opensIn(), 'Undo').toBe('B Prep');
    st().redo();
    flushRecompute();
    expect(st().textBuffer, 'Redo').toBe(edited);
    expect(opensIn(), 'Redo').toBe('B Prep');
    st().undo();
    flushRecompute();
    expect(st().textBuffer, 'Undo after Redo').toBe(moved);

    await st().saveProject('Reparented');
    st().newProject('Other');
    await st().loadProject('Reparented');
    await whenLibrarySettled();
    flushRecompute();
    expect(st().textBuffer, 'Save, then Open').toBe(moved);
    expect(opensIn(), 'Save, then Open').toBe('B Prep');
  });

  /**
   * The page decides by the order its model lists the elements in — the walk
   * finds its machines in it, and takes the first of two transitions out of an
   * `initial` from it — while Undo, Save and the checks worker rebuild the
   * model in the order each owner holds its children. So a drag lists the
   * page's model in that order too (`Model.adoptSerialOrder`): else a machine
   * dragged out of its package and back was reported last on the page and
   * first by the worker, and an unrelated edit undone moved it back (review
   * 2026-10-14 D-1, the S2 review).
   */
  it('a drag, and a drag of several, list the model as Undo, Save and the checks worker rebuild it', async () => {
    st().importModel(
      [
        'package P {',
        '    state def M1 {',
        '        state a;',
        '        state b;',
        '        state dead1;',
        '        transition t1 first a then b;',
        '    }',
        '    state def M2 {',
        '        state x;',
        '        state y;',
        '        state dead2;',
        '        transition t2 first x then y;',
        '    }',
        '}',
        '',
      ].join('\n'),
      'sysml',
    );
    await whenLibrarySettled();
    flushRecompute();
    const named = (name: string) => st().model.all().find((e) => e.declaredName === name)!.id;
    const listedAsCopies = () => {
      const all = st().model.all();
      return st().model.inSerialOrder().every((el, i) => el === all[i]);
    };
    const reach = CHECKS.find((c) => c.id === 'reach')!;
    const healthy: ReturnType<typeof loadHealth> = {
      errors: 0,
      saved: { parseErrors: 0 },
      exported: { parseErrors: 0 },
      sameText: true,
      validationErrors: 0,
      validateThrew: false,
      unwritable: null,
      libraryPending: false,
    };
    const machines = () =>
      runCheck(reach, { model: st().model, selectionId: null, selectionName: null, isolated: false, fileName: 'x.sysml', loadHealth: healthy })
        .rows.map((r) => /`P::(M\d)::/.exec(r.message)?.[1])
        .filter((m, i, all) => m !== undefined && all.indexOf(m) === i);
    expect(machines()).toEqual(['M1', 'M2']);

    // M1 dragged out of the package and back in: the text lists M2 first, and so does the page.
    st().reparent(named('M1'), null);
    st().reparent(named('M1'), named('P'));
    flushRecompute();
    expect(st().textBuffer.indexOf('state def M2')).toBeLessThan(st().textBuffer.indexOf('state def M1'));
    expect(listedAsCopies(), 'reparent').toBe(true);
    expect(machines()).toEqual(['M2', 'M1']);
    // An edit after it, undone: the model comes back from a snapshot, listed as it was.
    st().createElement('PartDefinition', named('P'), 'Later');
    flushRecompute();
    st().undo();
    flushRecompute();
    expect(machines(), 'Undo').toEqual(['M2', 'M1']);

    // Two of M1's states dragged together into M2, after its own.
    st().reparentMany([named('a'), named('b')], named('M2'));
    expect(st().model.children(named('M2')).map((e) => e.declaredName)).toEqual(['x', 'y', 'dead2', 't2', 'a', 'b']);
    expect(listedAsCopies(), 'reparentMany').toBe(true);
  });

  /**
   * And between owners. A machine made in a package above another machine's,
   * or a package dragged out of its owner and back in, goes where the text puts
   * it in the Text view and for a terminal over the saved text, but stayed
   * where it was added in the page's model and the checks worker's copy: the
   * page reported the machines in the order they were added (review 2026-10-14
   * D-1, its S2 review). Every edit lists the page's model in the order its
   * text gives it — made through the app's commands or through the SDK on
   * `window.sysml`.
   */
  it('an edit lists the model in the order its text gives it: a machine made above another, a package dragged back in, through the app and the SDK', async () => {
    // The SDK edits the model the store started with.
    useAppStore.setState({ model: st().api.model });
    st().importModel(
      [
        'package P {',
        '    package Q1 {',
        '        state def M1 {',
        '            state a;',
        '            state b;',
        '            state dead1;',
        '            transition t1 first a then b;',
        '        }',
        '    }',
        '    package Q2 {',
        '        state def M2 {',
        '            state x;',
        '            state y;',
        '            state dead2;',
        '            transition t2 first x then y;',
        '        }',
        '    }',
        '}',
        '',
      ].join('\n'),
      'sysml',
    );
    await whenLibrarySettled();
    flushRecompute();
    const named = (name: string) => st().model.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true)!.id;
    const reach = CHECKS.find((c) => c.id === 'reach')!;
    const healthy: ReturnType<typeof loadHealth> = {
      errors: 0,
      saved: { parseErrors: 0 },
      exported: { parseErrors: 0 },
      sameText: true,
      validationErrors: 0,
      validateThrew: false,
      unwritable: null,
      libraryPending: false,
    };
    const machinesIn = (model: Model) =>
      runCheck(reach, { model, selectionId: null, selectionName: null, isolated: false, fileName: 'x.sysml', loadHealth: healthy })
        .rows.map((r) => /`P::Q\d::(M\d)::/.exec(r.message)?.[1])
        .filter((m, i, all) => m !== undefined && all.indexOf(m) === i);
    /** The page's machines, and a terminal's over the text Save writes: the same, in the same order. */
    const machines = async (): Promise<Array<string | undefined>> => {
      const page = machinesIn(st().model);
      const terminal = (await textApi.loadModelText(st().textBuffer, { fileName: 'x.sysml' })).model!;
      expect(machinesIn(terminal), 'a terminal over the saved text').toEqual(page);
      const all = st().model.all();
      expect(st().model.inSerialOrder().every((el, i) => el === all[i]), 'listed as every copy is rebuilt').toBe(true);
      return page;
    };
    expect(await machines()).toEqual(['M1', 'M2']);

    // A machine made in Q1, below M1 and above Q2's M2, through the app's commands.
    const M0 = st().createElement('StateDefinition', named('Q1'), 'M0');
    const u = st().createElement('StateUsage', M0, 'u');
    const v = st().createElement('StateUsage', M0, 'v');
    st().createElement('StateUsage', M0, 'dead0');
    st().connect(u, v, 'TransitionUsage');
    flushRecompute();
    expect(await machines(), 'made in Q1').toEqual(['M1', 'M0', 'M2']);

    // Q1 dragged out of P and back in: now P's last.
    st().reparent(named('Q1'), null);
    st().reparent(named('Q1'), named('P'));
    flushRecompute();
    expect(await machines(), 'Q1 dragged back in').toEqual(['M2', 'M1', 'M0']);

    // A machine made in Q2, above Q1's, through the SDK — one call at a time, and in one commit.
    const api = st().api;
    const M3 = api.create('StateDefinition', { declaredName: 'M3', ownerId: named('Q2') });
    const s = api.create('StateUsage', { declaredName: 's', ownerId: M3.id });
    const t = api.create('StateUsage', { declaredName: 't', ownerId: M3.id });
    api.commit(() => {
      api.create('StateUsage', { declaredName: 'dead3', ownerId: M3.id });
      api.create('TransitionUsage', { declaredName: 't3', ownerId: M3.id, source: [s.id], target: [t.id] });
    });
    flushRecompute();
    expect(await machines(), 'through the SDK').toEqual(['M2', 'M3', 'M1', 'M0']);

    // A project an earlier build stored, or a Model JSON it exported, after the SDK's edit: M3 and what it holds listed
    // last, as they were added. Opened or imported, it is listed in the order its text gives it.
    const now = st().model.toJSON();
    const inM3 = new Set([M3.id, ...st().model.descendants(M3.id).map((e) => e.id)]);
    const earlier = { ...now, elements: [...now.elements.filter((e) => !inM3.has(e.id)), ...now.elements.filter((e) => inM3.has(e.id))] };
    await new LocalStorageStore().saveProject('Stored earlier', earlier);
    st().newProject('Other');
    await st().loadProject('Stored earlier');
    await whenLibrarySettled();
    flushRecompute();
    expect(await machines(), 'Open of a project an earlier build stored').toEqual(['M2', 'M3', 'M1', 'M0']);
    st().importModel(JSON.stringify(earlier), 'model-json');
    await whenLibrarySettled();
    flushRecompute();
    expect(await machines(), 'Import of a Model JSON an earlier build exported').toEqual(['M2', 'M3', 'M1', 'M0']);
  });

  /**
   * A declaration added to a typed usage — a doc typed into Properties'
   * Documentation box, an attribute — goes before the usage's typing among its
   * children, where a terminal over the saved text holds it, and the typing
   * stays where the load listed it among the typings. Before, the typing was
   * walked among the declarations, ahead of every other usage's, and the
   * palette's Where used listed the usage first where a terminal lists it last
   * (the review of collab-order S1).
   */
  it('a doc or an attribute added to the later of two typed usages leaves Where used in the order a terminal gives', async () => {
    st().importModel('package X {\n    part def D {\n        attribute a = 1;\n    }\n    part u1 : D;\n    part u2 : D;\n}\n', 'sysml');
    await whenLibrarySettled();
    flushRecompute();
    const healthy: ReturnType<typeof loadHealth> = {
      errors: 0,
      saved: { parseErrors: 0 },
      exported: { parseErrors: 0 },
      sameText: true,
      validationErrors: 0,
      validateThrew: false,
      unwritable: null,
      libraryPending: false,
    };
    const whereUsedRow = CHECKS.find((c) => c.id === 'where-used')!;
    const usedBy = (model: Model): string[] => {
      const D = model.all().find((e) => e.declaredName === 'D' && e.attrs.isLibrary !== true)!;
      const c = { model, selectionId: D.id, selectionName: 'D', isolated: false, fileName: 'x.sysml', loadHealth: healthy };
      return runCheck(whereUsedRow, c).rows.map((r) => r.message);
    };
    /** The page's rows, and a terminal's over the text Save writes: the same, in the same order. */
    const rows = async (): Promise<string[]> => {
      const terminal = (await textApi.loadModelText(st().textBuffer, { fileName: 'x.sysml' })).model!;
      expect(usedBy(st().model), 'a terminal over the saved text').toEqual(usedBy(terminal));
      return usedBy(st().model);
    };
    const named = (name: string) => st().model.all().find((e) => e.declaredName === name && e.attrs.isLibrary !== true)!.id;
    expect(await rows()).toEqual(['u1 (PartUsage)', 'u2 (PartUsage)']);

    // The Documentation box's first keystroke on u2: it makes u2's doc.
    const doc = st().createElement('Documentation', named('u2'), undefined, { field: true });
    st().setAttr(doc, 'body', 'note');
    flushRecompute();
    expect(st().textBuffer).toContain('part u2 : D {');
    expect(await rows(), 'a doc on u2').toEqual(['u1 (PartUsage)', 'u2 (PartUsage)']);
    expect(st().model.children(named('u2')).map((e) => e.eClass), 'held as a terminal holds it').toEqual(['Documentation', 'FeatureTyping']);

    // An attribute added to u2.
    st().createElement('AttributeUsage', named('u2'), 'extra');
    flushRecompute();
    expect(await rows(), 'an attribute on u2').toEqual(['u1 (PartUsage)', 'u2 (PartUsage)']);
    expect(st().model.children(named('u2')).map((e) => e.eClass)).toEqual(['Documentation', 'AttributeUsage', 'FeatureTyping']);
  });

  /**
   * In a collaboration room the page holds each element's members in the order
   * the peer who made the edit holds them, and its Text view writes them so: a
   * batch a peer makes in one transaction used to reach the page last to first,
   * and a peer's Undo that only puts them back in their order did not reach it
   * at all (review 2026-10-14 D-2, collab-order S2).
   */
  it('in a collaboration room, a peer\'s batch and a peer\'s Undo that only re-orders reach the Text view in that peer\'s order', async () => {
    st().importModel('package X {\n    part def D;\n}\n', 'sysml');
    await whenLibrarySettled();
    flushRecompute();
    const peerDoc = new Y.Doc();
    st().connectCollab('order-room');
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
      const X = peer.all().find((e) => e.declaredName === 'X' && e.attrs.isLibrary !== true)!.id;
      const written = (): string[] => [...st().textBuffer.matchAll(/part (\w+);/g)].map((m) => m[1]);

      // The peer pastes three parts: one transaction.
      peer.transaction(() => {
        for (const name of ['a', 'b', 'c']) peer.create('PartUsage', { declaredName: name, ownerId: X });
      });
      peer.adoptSerialOrder();
      flushRecompute();
      expect(written()).toEqual(['a', 'b', 'c']);

      // The peer drags a out of X and back in, then undoes it: no element changes owner, only the order does.
      const before = peer.toJSON();
      const a = peer.all().find((e) => e.declaredName === 'a')!.id;
      peer.reparent(a, null);
      peer.reparent(a, X);
      peer.adoptSerialOrder();
      flushRecompute();
      expect(written()).toEqual(['b', 'c', 'a']);
      const rev = st().rev;
      peer.reset(before);
      flushRecompute();
      expect(st().rev, 'the page is told').toBeGreaterThan(rev);
      expect(written()).toEqual(['a', 'b', 'c']);
      expect(st().model.childIds(X)).toEqual(peer.childIds(X));
    } finally {
      st().disconnectCollab();
      peerDoc.destroy();
    }
  });

  /**
   * A load can reorder an owner's children itself: the parser puts a feature's
   * specialisations back in the order they were declared. Import keeps that
   * order now, so the Text view reads as the file, where it used to read
   * `part : Sub :>> p;` (the S2 review of D-2).
   */
  it('Import keeps a feature\'s specialisations in the order the file declares them, through an Undo', async () => {
    st().importModel(
      ['package S1 {', '    part def P;', '    part def Sub :> P;', '    part def Q {', '        part p : P;', '    }', '    part q : Q {', '        part :>> p : Sub;', '    }', '}', ''].join('\n'),
      'sysml',
    );
    await whenLibrarySettled();
    flushRecompute();
    const imported = st().textBuffer;
    expect(imported).toContain('part :>> p : Sub;');
    st().createElement('PartDefinition', st().model.all().find((e) => e.declaredName === 'S1')!.id, 'Later');
    flushRecompute();
    st().undo();
    flushRecompute();
    expect(st().textBuffer, 'Undo').toBe(imported);
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

/**
 * The Text view, Save to Drive and Export ▾ → SysML write the user's roots
 * only, never the standard library's. An element of the user's put under a
 * library root — added in the Explorer with its library toggle on, drawn with
 * a library element selected, dragged onto one, or made through the SDK —
 * carried no library flag, yet all three left it out while model JSON kept
 * it; and an edit to it did not read unsaved (what is saved is compared as
 * text), so New, Open ▾ and Import dropped it without asking. Asked to go
 * there, a user element now goes to the top level of the user's model, and
 * the strip under the toolbar says so. A line drawn from a library box goes to
 * the top level too, and the Type field of a library usage types nothing
 * (connect and bindType, below). The other way round, a library element
 * dragged onto an element of the user's stays in the library.
 */
describe('createElement, reparent, reparentMany, paste and the SDK never put a user element inside the standard library', () => {
  const sdk = () => st().api;
  const ownerOf = (id: string) => st().model.get(id)?.ownerId;
  const said = (what: 'new' | number) => ({
    kind: 'info',
    message: DRIVE_MESSAGES.notIntoLibrary(what),
    retryable: false,
  });
  /** The user's root package, a library root, a library element in it, and an element of nobody's flag left in it. */
  let own: string;
  let shelf: string;
  let shelved: string;
  let stray: string;

  beforeEach(async () => {
    await whenLibrarySettled();
    lib.merge = null;
    reset();
    // The SDK is bound to the model the store started with: these run on it.
    useAppStore.setState({ model: sdk().model, textBuffer: '', textDirty: false, diagnostics: [], serializeError: null });
    st().newProject('Hangar');
    own = st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id;
    const model = st().model;
    shelf = model.create('Package', { declaredName: 'Shelf', attrs: { isLibrary: true } }).id;
    shelved = model.create('PartDefinition', { declaredName: 'Shelved', ownerId: shelf, attrs: { isLibrary: true } }).id;
    stray = model.create('PartDefinition', { declaredName: 'Stray', ownerId: shelf }).id;
    flushRecompute();
  });

  afterEach(() => {
    // New keeps library elements: take this one away for the tests after.
    for (const r of st().model.roots()) if (r.attrs.isLibrary === true) st().model.remove(r.id);
    useAppStore.setState({ drive: initialDriveState, undoStack: [], redoStack: [] });
  });

  it('createElement puts a child of a library element at the top level of the model, says so — and the text holds it', async () => {
    await st().saveProject('Hangar');
    const undos = st().undoStack.length;
    const id = st().createElement('PartDefinition', shelved, 'Spare');
    expect(ownerOf(id), 'not inside the library').toBeNull();
    expect(st().model.get(id)?.attrs.isLibrary).toBeUndefined();
    expect(st().drive.notice).toEqual(said('new'));
    expect(st().selectionId).toBe(id);
    expect(st().undoStack.length).toBe(undos + 1);
    flushRecompute();
    expect(st().textBuffer).toContain('part def Spare;');
    expect(browserDirty(st()), 'New, Open and Import ask before dropping it').toBe(true);
    st().undo();
    expect(st().model.has(id)).toBe(false);
  });

  it('createElement with no owner takes the selection — and a selection in the library is no owner either', () => {
    st().select(shelved);
    const fromLibrary = st().createElement('PartDefinition');
    expect(ownerOf(fromLibrary)).toBeNull();
    expect(st().drive.notice).toEqual(said('new'));

    // An element with no flag of its own under a library root is in the library all the same.
    useAppStore.setState({ drive: initialDriveState });
    st().select(stray);
    const fromStray = st().createElement('PartDefinition');
    expect(ownerOf(fromStray)).toBeNull();
    expect(st().drive.notice).toEqual(said('new'));

    // In the user's own package nothing changes, and nothing is said.
    useAppStore.setState({ drive: initialDriveState });
    st().select(own);
    const inOwn = st().createElement('PartDefinition');
    expect(ownerOf(inOwn)).toBe(own);
    expect(st().drive.notice).toBeNull();
  });

  it('reparent onto a library element moves the element to the top level instead, in one undo step, and says so', () => {
    const wheel = st().createElement('PartDefinition', own, 'Wheel');
    const undos = st().undoStack.length;
    st().reparent(wheel, shelved);
    expect(ownerOf(wheel)).toBeNull();
    expect(st().drive.notice).toEqual(said(1));
    expect(st().undoStack.length).toBe(undos + 1);
    st().undo();
    expect(ownerOf(wheel), 'one Undo puts it back').toBe(own);
    expect(st().drive.notice, 'and takes the note down: it no longer holds').toBeNull();

    // Already at the top level: nothing moves, no undo step — and it is still said.
    useAppStore.setState({ drive: initialDriveState });
    const top = st().createElement('PartDefinition', null, 'Top');
    const before = st().undoStack.length;
    st().reparent(top, shelf);
    expect(ownerOf(top)).toBeNull();
    expect(st().undoStack.length).toBe(before);
    expect(st().drive.notice).toEqual(said(1));

    // An element of the user's left in the library comes out when it is moved within it.
    st().reparent(stray, shelved);
    expect(ownerOf(stray)).toBeNull();
    // A library element moves within the library as it always did.
    useAppStore.setState({ drive: initialDriveState });
    const bin = st().model.create('Package', { declaredName: 'Bin', ownerId: shelf, attrs: { isLibrary: true } }).id;
    st().reparent(shelved, bin);
    expect(ownerOf(shelved)).toBe(bin);
    expect(st().drive.notice).toBeNull();
  });

  it('reparentMany onto a library element moves every user element to the top level, in one undo step, and says how many', () => {
    const a = st().createElement('PartDefinition', own, 'A');
    const b = st().createElement('PartDefinition', own, 'B');
    const top = st().createElement('PartDefinition', null, 'C');
    const undos = st().undoStack.length;
    st().reparentMany([a, b, top], shelved);
    expect([ownerOf(a), ownerOf(b), ownerOf(top)]).toEqual([null, null, null]);
    expect(st().drive.notice).toEqual(said(3));
    expect(st().undoStack.length).toBe(undos + 1);
    st().undo();
    expect([ownerOf(a), ownerOf(b), ownerOf(top)]).toEqual([own, own, null]);

    // All of them at the top level already: nothing moves, no undo step, and it is said.
    useAppStore.setState({ drive: initialDriveState });
    const before = st().undoStack.length;
    st().reparentMany([top], shelf);
    expect(ownerOf(top)).toBeNull();
    expect(st().undoStack.length).toBe(before);
    expect(st().drive.notice).toEqual(said(1));
  });

  it('connect from an element in the library puts the relationship at the top level of the model, in one undo step, and says so', () => {
    const wheel = st().createElement('PartDefinition', own, 'Wheel');
    const undos = st().undoStack.length;
    // A typing / specialization is owned by its source; any other goes beside it — both would sit in the library.
    const special = st().connect(shelved, wheel, 'Specialization');
    const depends = st().connect(stray, wheel, 'Dependency');
    expect([ownerOf(special), ownerOf(depends)], 'not inside the library').toEqual([null, null]);
    expect(st().model.get(special)?.attrs.isLibrary).toBeUndefined();
    expect(st().drive.notice).toEqual(said('new'));
    expect(st().undoStack.length).toBe(undos + 2);
    flushRecompute();
    expect(st().textBuffer, 'the text holds both').toMatch(/subtype Shelf::Shelved :> Hangar::Wheel;[\s\S]*dependency Shelf::Stray to Hangar::Wheel;/);
    st().undo();
    expect(st().model.has(depends)).toBe(false);
    expect(st().drive.notice, 'Undo takes the note down').toBeNull();

    // From an element of the user's own, nothing changes, and nothing is said.
    useAppStore.setState({ drive: initialDriveState });
    const own2 = st().createElement('PartDefinition', own, 'Axle');
    const inOwn = st().connect(own2, wheel, 'Specialization');
    expect(ownerOf(inOwn)).toBe(own2);
    expect(st().drive.notice).toBeNull();
  });

  it('bindType on an element in the library changes nothing and says so — a blur that changes nothing is silent', () => {
    const motor = st().createElement('PartDefinition', null, 'Motor');
    const usage = st().model.create('PartUsage', { declaredName: 'drive', ownerId: shelf, attrs: { isLibrary: true } }).id;
    const undos = st().undoStack.length;
    const size = st().model.all().length;
    st().bindType(usage, '');
    expect(st().drive.notice, 'nothing to remove: nothing to say').toBeNull();
    st().bindType(usage, 'Motor');
    expect(st().model.all().length).toBe(size);
    expect(st().undoStack.length, 'no undo step').toBe(undos);
    expect(st().drive.notice).toEqual({ kind: 'info', message: DRIVE_MESSAGES.notTypedInLibrary, retryable: false });
    // An element of the user's own is typed as before.
    useAppStore.setState({ drive: initialDriveState });
    const mine = st().createElement('PartUsage', own, 'mine');
    st().bindType(mine, 'Motor');
    expect(st().model.relationshipsFrom(mine).some((r) => r.eClass === 'FeatureTyping' && r.target?.[0] === motor)).toBe(true);
    expect(st().drive.notice).toBeNull();
  });

  const stays = (n: number) => ({ kind: 'info', message: DRIVE_MESSAGES.libraryStays(n), retryable: false });

  it('reparent of a library element under one of the user\'s moves nothing and says so — within the library, or to the top level, it moves', () => {
    const undos = st().undoStack.length;
    st().reparent(shelved, own);
    expect(ownerOf(shelved)).toBe(shelf);
    expect(st().undoStack.length, 'no undo step').toBe(undos);
    expect(st().drive.notice).toEqual(stays(1));
    flushRecompute();
    expect(st().textBuffer).not.toContain('Shelved');

    useAppStore.setState({ drive: initialDriveState });
    st().reparent(shelved, stray);
    expect(ownerOf(shelved)).toBe(stray);
    st().reparent(shelved, null);
    expect(ownerOf(shelved)).toBeNull();
    expect(st().drive.notice).toBeNull();

    // An owner that is not in the model is no element of the user's: not this note.
    st().reparent(shelved, 'nope');
    expect(st().drive.notice).toBeNull();
  });

  it('reparentMany leaves the library elements where they are, says how many, and moves the rest', () => {
    const a = st().createElement('PartDefinition', null, 'A');
    const other = st().model.create('PartDefinition', { declaredName: 'Other', ownerId: shelf, attrs: { isLibrary: true } }).id;
    st().reparentMany([shelved, other], own);
    expect([ownerOf(shelved), ownerOf(other)]).toEqual([shelf, shelf]);
    expect(st().drive.notice).toEqual(stays(2));

    useAppStore.setState({ drive: initialDriveState });
    const undos = st().undoStack.length;
    st().reparentMany([shelved, a], own);
    expect([ownerOf(shelved), ownerOf(a)], 'the user\'s own element still moves').toEqual([shelf, own]);
    expect(st().drive.notice).toEqual(stays(1));
    expect(st().undoStack.length).toBe(undos + 1);
  });

  it('the SDK on window.sysml does the same — create and reparent, alone or in commit(fn) — and a library element goes where it is asked', () => {
    const made = sdk().create('PartDefinition', { declaredName: 'Scripted', ownerId: shelved });
    expect(made.ownerId).toBeNull();
    expect(st().drive.notice).toEqual(said('new'));
    flushRecompute();
    expect(st().textBuffer).toContain('part def Scripted;');

    useAppStore.setState({ drive: initialDriveState });
    const moved = sdk().create('PartDefinition', { declaredName: 'Moved', ownerId: own });
    expect(moved.ownerId).toBe(own);
    expect(st().drive.notice).toBeNull();
    sdk().reparent(moved.id, shelf);
    expect(ownerOf(moved.id)).toBeNull();
    expect(st().drive.notice).toEqual(said(1));

    sdk().commit((api) => {
      api.create('PartDefinition', { declaredName: 'Batched', ownerId: stray });
    });
    expect(st().model.all().find((e) => e.declaredName === 'Batched')?.ownerId).toBeNull();

    useAppStore.setState({ drive: initialDriveState });
    const library = sdk().create('PartDefinition', { declaredName: 'Bound', ownerId: shelf, attrs: { isLibrary: true } });
    expect(library.ownerId).toBe(shelf);
    expect(st().drive.notice).toBeNull();
  });

  it('paste under a library element puts the copies at the top level of the model, in one undo step, and says so', () => {
    const wheel = st().createElement('PartDefinition', own, 'Wheel');
    const axle = st().createElement('PartDefinition', own, 'Axle');
    st().select(wheel);
    st().copySelection();
    const undos = st().undoStack.length;
    const [copy] = st().pasteClipboard(shelved);
    expect(ownerOf(copy!), 'not inside the library').toBeNull();
    expect(st().model.get(copy!)?.declaredName).toBe('Wheel');
    expect(st().drive.notice).toEqual(said(1));
    expect(st().selectionId).toBe(copy);
    expect(st().undoStack.length).toBe(undos + 1);
    flushRecompute();
    expect(st().textBuffer, 'the text holds the copy').toContain('part def Wheel;');
    st().undo();
    expect(st().model.has(copy!)).toBe(false);
    expect(st().drive.notice, 'and takes the note down').toBeNull();

    // Pasting with no owner given takes the selection: a selection in the
    // library is no owner either, flag or no flag — and every root says so at once.
    useAppStore.setState({ drive: initialDriveState });
    st().setSelection([wheel, axle]);
    st().copySelection();
    st().select(stray);
    const both = st().pasteClipboard();
    expect(both.map(ownerOf)).toEqual([null, null]);
    expect(st().drive.notice).toEqual(said(2));

    // In the user's own package nothing changes, and nothing is said.
    useAppStore.setState({ drive: initialDriveState });
    const [inOwn] = st().pasteClipboard(own);
    expect(ownerOf(inOwn!)).toBe(own);
    expect(st().drive.notice).toBeNull();

    // A copied library element goes where it is asked, within the library.
    st().select(shelved);
    st().copySelection();
    const [inLibrary] = st().pasteClipboard(shelf);
    expect(ownerOf(inLibrary!)).toBe(shelf);
    expect(st().drive.notice).toBeNull();
  });

  /**
   * The note names an element of the model on screen, so a command that
   * replaces the model takes it down, as Undo does: New, Open, Import, a
   * file opened as text. (A note that a save kept typed text back, or a
   * notice of another kind, is a different note, and stands.)
   */
  describe('the note comes down when the model it is about is replaced', () => {
    const sayIt = (): void => {
      useAppStore.setState({ drive: initialDriveState });
      st().createElement('PartDefinition', shelved, 'Spare');
      expect(st().drive.notice).toEqual(said('new'));
    };

    it('New', () => {
      sayIt();
      st().newProject('Other');
      expect(st().drive.notice).toBeNull();
    });

    it('Open', async () => {
      await st().saveProject('Hangar');
      sayIt();
      await st().loadProject('Hangar');
      expect(st().drive.notice).toBeNull();
    });

    it('Import', () => {
      sayIt();
      st().importModel('package Imported;\n', 'sysml');
      expect(st().drive.notice).toBeNull();
    });

    it('a file opened as text', async () => {
      sayIt();
      await openText('package Other {\n    part def Opened;\n}\n', 'sysml');
      expect(st().model.all().some((e) => e.declaredName === 'Opened')).toBe(true);
      expect(st().drive.notice).toBeNull();
    });

    it('a note held behind another notice is forgotten with the model: it never comes up after', () => {
      const failed = { kind: 'error' as const, message: 'Drive refused the save.', retryable: true, retry: { op: 'save' as const } };
      useAppStore.setState((s) => ({ drive: { ...s.drive, notice: failed } }));
      st().createElement('PartDefinition', shelved, 'Spare');
      expect(st().drive.notice, 'held behind the error').toBe(failed);
      st().newProject('Other');
      st().driveDismiss();
      expect(st().drive.notice).toBeNull();
    });
  });

  /**
   * The note is about what was just done, so it replaces an earlier one, or
   * the note that a save kept typed text back. It never covers a notice of
   * another kind — a failed Drive save and its Try again, `<name> closed`:
   * it waits until that one has gone. Undo and Redo take it down, held or
   * standing: the element it names may be back where it was, or gone.
   */
  it('the note replaces a kept-back note, waits behind a notice of another kind, and goes with an Undo', () => {
    sayWhatTheBrowserKept({ line: 3, column: 5 });
    expect(st().drive.notice?.message).toBe(DRIVE_MESSAGES.typedTextKeptBack(3));
    st().createElement('PartDefinition', shelved, 'First');
    expect(st().drive.notice, 'over the kept-back note').toEqual(said('new'));

    // A failed Drive save, and its Try again: the note waits behind it — the latest of them.
    const failed = { kind: 'error' as const, message: 'Drive refused the save.', retryable: true, retry: { op: 'save' as const } };
    useAppStore.setState((s) => ({ drive: { ...s.drive, notice: failed } }));
    const spare = st().createElement('PartDefinition', shelved, 'Spare');
    expect(ownerOf(spare)).toBeNull();
    expect(st().drive.notice, 'the error and its Try again stand').toBe(failed);
    st().reparent(spare, shelf);
    expect(st().drive.notice).toBe(failed);
    st().driveDismiss();
    expect(st().drive.notice, 'then the note goes up').toEqual(said(1));

    // `<name> closed`, the same; then Undo takes the note down.
    const closed = { kind: 'info' as const, message: DRIVE_MESSAGES.closed('Swarm.sysml'), retryable: false };
    useAppStore.setState((s) => ({ drive: { ...s.drive, notice: closed } }));
    const other = st().createElement('PartDefinition', shelved, 'Other');
    expect(st().drive.notice).toBe(closed);
    st().driveDismiss();
    expect(st().drive.notice).toEqual(said('new'));
    st().undo();
    expect(st().model.has(other)).toBe(false);
    expect(st().drive.notice, 'the element it names is gone').toBeNull();

    // A held note goes with an Undo too, and never comes up after.
    useAppStore.setState((s) => ({ drive: { ...s.drive, notice: failed } }));
    st().createElement('PartDefinition', shelved, 'Third');
    st().undo();
    expect(st().drive.notice).toBe(failed);
    st().driveDismiss();
    expect(st().drive.notice).toBeNull();
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

describe('useAppStore.simulate — a run stopped at a step it does not take says so (docs/06 §8.12)', () => {
  beforeEach(reset);

  it('the trace header names the step into the machine itself and why the run stopped there', () => {
    const { model } = parseModel(`package Demo {
    state def Loop {
        state idle;
        state busy;
        transition start first idle accept go then busy;
        transition again first busy accept back then Loop;
        transition rest first busy accept done then idle;
    }
}
`);
    useAppStore.setState({ model, activeView: 'state', selectionId: null });
    st().simulate();
    const header = st().diagnostics[0].message;
    // Driven with its alphabet `[go, back, done]`: `back` would take `again`
    // into the machine itself, so the run stops at `busy`, and `done` never fires.
    expect(header).toContain('1 transition(s) fired; active: busy.');
    expect(header).toContain(
      'Stopped: `Demo::Loop::again` leads from `Demo::Loop::busy` into `Demo::Loop`, the machine itself.',
    );
    expect(header).not.toContain('; complete');
    // A machine that takes every step it comes to has no such clause.
    useAppStore.setState({ model: parseModel('package P { state def M { state a; state b; transition t first a accept go then b; } }\n').model });
    st().simulate();
    expect(st().diagnostics[0].message).not.toContain('Stopped:');
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

  // The page and the file it saves must read alike. t's `:>> M` redefines Q2's unnamed `:>> M default = 2.0`, which
  // the text can only write as `:>> M`; once t is no longer a Q2 the next load lands that on another feature, so the
  // edit moves the page's redefinition there in the same undo step (a retype, a typing deleted or drawn, a delete).
  describe('an edit that changes what a usage inherits moves its explicit redefinitions where the saved text puts them', () => {
    const src = `package P {
  part def Q { attribute M default = 1.0; }
  part def Q2 :> Q { attribute :>> M default = 2.0; }
  part def Q3 :> Q { attribute :>> M default = 3.0; }
  part def Q4 :> Q2 { attribute :>> M default = 4.0; }
  part t : Q2 { attribute :>> M; }
  constraint t1 { t.M == 1.0 }
  constraint t2 { t.M == 2.0 }
  constraint t3 { t.M == 3.0 }
  constraint t4 { t.M == 4.0 }
}`;
    const reads = (m: Model): string[] =>
      checkConstraints(m)
        .filter((c) => c.result === 'satisfied')
        .map((c) => m.qualifiedName(c.id));
    /** What the page reads, and what the file it saves reads when it is opened. */
    const pageAndFile = (): [string[], string[]] => [reads(st().model), reads(parseModel(serializeModel(st().model)).model)];

    it('bindType: a valueless `:>> M` read 2 on the page and 1, 3 or 4 in the reopened file', () => {
      for (const [to, held] of [['Q4', 'P::t4'], ['Q3', 'P::t3'], ['Q', 'P::t1']] as const) {
        load(src);
        expect(reads(st().model)).toEqual(['P::t2']);
        st().bindType(byName('t').id, to);
        expect(pageAndFile(), to).toEqual([[held], [held]]);
        // One undo step brings the old type and the old redefinition back.
        st().undo();
        expect(reads(st().model), to).toEqual(['P::t2']);
      }
    });

    it('deleting the typing, or the Q2 the usage was typed by, moves it too', () => {
      load(src);
      st().deleteElement(st().model.relationshipsFrom(byName('t').id).find((r) => r.eClass === 'FeatureTyping')!.id);
      // Untyped, the `:>> M` is Q's M (the name the file writes finds): 1, on the page and in the file.
      expect(pageAndFile()).toEqual([['P::t1'], ['P::t1']]);
      load(src);
      st().deleteElement(byName('Q2').id);
      const [page, file] = pageAndFile();
      expect(page).toEqual(file);
    });

    it('a typing drawn from the usage to another type, and a relationship end moved, move it too', () => {
      load(src);
      st().connect(byName('t').id, byName('Q4').id, 'FeatureTyping');
      const [page, file] = pageAndFile();
      expect(page).toEqual(file);
      load(src);
      const typing = st().model.relationshipsFrom(byName('t').id).find((r) => r.eClass === 'FeatureTyping')!.id;
      st().updateElement(typing, { target: [byName('Q3').id] });
      expect(pageAndFile()).toEqual([['P::t3'], ['P::t3']]);
    });

    it('deleting the unnamed feature a redefinition targets leaves the redefinition on the one it redefined', () => {
      load(src.replace('part t : Q2 { attribute :>> M; }', 'part t : Q2 { attribute :>> M = 5.0; }'));
      const q2m = st().model.children(byName('Q2').id).find((c) => c.eClass === 'AttributeUsage')!.id;
      st().deleteElement(q2m);
      expect(serializeModel(st().model)).toMatch(/part t : Q2 \{\s*attribute :>> M = 5\.0;\s*\}/);
    });
  });

  // EVERY command that edits the model settles the redefinitions it leaves, in its one undo step. The listening is in
  // `pushUndo` and `afterMutation`, which each of them goes through, so none names what it changes and none can
  // forget it. Each case below is a probe of the second review of S1: the page's four surfaces (check, literal,
  // numeric, SMT) read what the file it saves reads, the page's redefinitions are those of the reloaded file, the
  // command is one undo step, and Undo puts every target back.
  describe('every command settles the redefinitions it leaves — the page reads what its saved file reads', { timeout: 120_000 }, () => {
    const LETTER = { satisfied: 'T', violated: 'F', unknown: '?' } as const;
    /** check / literal / numeric / SMT, per constraint, as the differential table writes them. */
    async function surfaces(m: Model): Promise<Record<string, string>> {
      const rows = new Map<string, string[]>();
      const put = (k: string, s: number, l: string): void => {
        const r = rows.get(k) ?? ['-', '-', '-', '-'];
        r[s] = l;
        rows.set(k, r);
      };
      for (const c of checkConstraints(m)) if (!c.conflict) put(m.qualifiedName(c.id), 0, LETTER[c.result as keyof typeof LETTER] ?? '?');
      for (const r of checkConstraintsNumeric(m)) {
        if (!r.conflict) put(m.qualifiedName(r.id), 2, r.imposed ? 't' : (LETTER[r.result as keyof typeof LETTER] ?? '?'));
      }
      const letter = (r: { claim?: string; code?: string | null }): string =>
        r.claim === 'proved' || r.claim === 'holds-at-values'
          ? 'T'
          : r.claim === 'refuted'
            ? 'F'
            : r.code === 'verification/inconsistent-axioms'
              ? 'X'
              : '?';
      const sourceText = serializeModel(m);
      for (const [s, engine] of [[1, 'literal'], [3, 'smt']] as const) {
        const rep = await verifyModel(m, { engine, sourceText });
        for (const r of rep.results) put(r.clause.qualifiedName.replace(/ \([^()]*'s own\)$/, ''), s, letter(r));
      }
      return Object.fromEntries([...rows].sort().map(([k, v]) => [k, v.join('/')]));
    }
    /** Where an element sits, whatever its id: the owner's name and its place among the owner's features. */
    const place = (m: Model, id: string): string => {
      const e = m.get(id);
      if (!e) return '?';
      const at = e.ownerId === null ? 0 : m.children(e.ownerId).filter((c) => !isRelationship(c.eClass)).findIndex((c) => c.id === id);
      return `${e.ownerId === null ? '' : m.qualifiedName(e.ownerId)}#${at}${e.declaredName === undefined ? '' : `:${e.declaredName}`}`;
    };
    /** The implicit end copy a usage-body binding made: the text leaves it out. */
    const isCopy = (m: Model, redefinition: ElementRecord): boolean => m.get(redefinition.source![0]!)?.attrs.implicit === true;
    /** Every explicit redefinition the text holds: the feature, and the feature it redefines. */
    const targets = (m: Model): string[] =>
      m
        .all()
        .filter((e) => e.eClass === 'Redefinition' && e.attrs.isLibrary !== true && !isCopy(m, e))
        .map((r) => `${place(m, r.source![0]!)} -> ${(r.target ?? []).map((t) => place(m, t)).join(',')}`)
        .sort();
    /** The implicit end copies a usage-body binding made (the text leaves them out), by where each sits and what it redefines. */
    const copies = (m: Model): Map<string, string> =>
      new Map(
        m
          .all()
          .filter((e) => e.eClass === 'Redefinition' && e.attrs.isLibrary !== true && isCopy(m, e))
          // A copy is told by its name, not its place: the page makes it where the binding was, the file after the others.
          .map((r) => [m.qualifiedName(r.source![0]!), (r.target ?? []).map((t) => (m.get(t)?.attrs.implicit === true ? m.qualifiedName(t) : place(m, t))).join(',')] as const),
      );
    /**
     * The copies the page and its file both hold that redefine another feature on each. The file makes a copy anew
     * for every binding it can read; one it cannot (the name is no longer inherited) is a reference the Problems panel
     * reports, not a redefinition to compare.
     */
    const copiesApart = (page: Model, file: Model): string[] => {
      const there = copies(file);
      const over = copiesOverCopies(page);
      return [...copies(page)]
        .filter(([k, v]) => there.has(k) && there.get(k) !== v && !over.has(k))
        .map(([k, v]) => `${k} -> ${v}, the file: ${there.get(k)}`);
    };
    /**
     * The copies of a DEFINITION'S binding that redefine the copy of a definition it specialises (`D2 :> D3`, both with
     * `bind ... = N`): the file lands D2's on D3's if D3 is written first, and on Q0's if D2 is, so no page is the file
     * for both (the mapper decides by text order, as it does for no other redefinition).
     */
    const copiesOverCopies = (m: Model): Set<string> =>
      new Set(
        m
          .all()
          .filter((e) => e.eClass === 'Redefinition' && e.attrs.isLibrary !== true && isCopy(m, e))
          .filter((e) => m.get(m.get(e.source![0]!)!.ownerId!)?.eClass === 'PartDefinition')
          .filter((e) => (e.target ?? []).some((t) => m.get(t)?.attrs.implicit === true))
          .map((e) => m.qualifiedName(e.source![0]!)),
      );
    const held = (m: Model): string[] => [...targets(m), ...[...copies(m)].map(([k, v]) => `(implicit) ${k} -> ${v}`).sort()];
    const reopened = (m: Model): Model => parseModel(serializeModel(m)).model;
    /** What the page reads on every surface is what the file it saves reads, and the redefinitions are the same. */
    async function pageIsFile(note: string): Promise<void> {
      const page = st().model;
      const file = reopened(page);
      expect(targets(page), `${note}: redefinitions`).toEqual(targets(file));
      expect(copiesApart(page, file), `${note}: implicit end copies`).toEqual([]);
      expect(await surfaces(page), `${note}: four surfaces`).toEqual(await surfaces(file));
    }
    /** The command is one undo step, and Undo puts every redefinition target back (Redo, too). */
    function oneStep(note: string, run: () => void): void {
      const before = held(st().model);
      const undos = st().undoStack.length;
      run();
      expect(st().undoStack.length, `${note}: one undo step`).toBe(undos + 1);
      const after = held(st().model);
      st().undo();
      expect(held(st().model), `${note}: undo`).toEqual(before);
      st().redo();
      expect(held(st().model), `${note}: redo`).toEqual(after);
    }
    const typingOf = (name: string): string =>
      st().model.relationshipsFrom(byName(name).id).find((r) => r.eClass === 'FeatureTyping')!.id;
    const feature = (owner: string, at = 0): string =>
      st().model.children(byName(owner).id).filter((c) => c.eClass === 'AttributeUsage')[at]!.id;
    const satisfied = (m: Model): string[] =>
      checkConstraints(m)
        .filter((c) => c.result === 'satisfied')
        .map((c) => m.qualifiedName(c.id).replace(/^[A-Z0-9]+::/, ''))
        .sort();

    const src = `package P {
  part def Q { attribute M default = 1.0; }
  part def Q2 :> Q { attribute :>> M default = 2.0; }
  part def Q3 :> Q;
  part def Q4 :> Q2 { attribute :>> M default = 4.0; }
  part t : Q2 { attribute :>> M; }
  constraint t1 { t.M == 1.0 }
  constraint t2 { t.M == 2.0 }
  constraint t4 { t.M == 4.0 }
}`;

    it('Delete on a typing (deleteSelection: the Delete key, the palette button, the multi-select menu)', async () => {
      load(src);
      expect(satisfied(st().model)).toEqual(['t2']);
      st().setSelection([typingOf('t')]);
      oneStep('delete', () => st().deleteSelection());
      // t is untyped: its `:>> M` is Q's M, the name the saved file writes finds (the page kept Q2's, read 2).
      expect(satisfied(st().model)).toEqual(['t1']);
      await pageIsFile('delete');
    });

    it('Delete on several elements at once settles them together, in one undo step', async () => {
      load(src);
      // The typing and Q4 (nobody's general here), one selection.
      st().setSelection([typingOf('t'), byName('Q4').id]);
      oneStep('multi delete', () => st().deleteSelection());
      expect(st().model.all().some((e) => e.declaredName === 'Q4')).toBe(false);
      await pageIsFile('multi delete');
      // The type itself: Q2 and its unnamed feature go, and t is typed by nothing.
      load(src);
      st().setSelection([byName('Q2').id]);
      oneStep('delete the type', () => st().deleteSelection());
      await pageIsFile('delete the type');
    });

    it('an Explorer drag of the feature a redefinition targets (reparent, reparentMany) settles it', async () => {
      // Q2's unnamed `:>> M` dragged into Q3, which is no general of t: t no longer inherits it.
      load(src);
      oneStep('drag', () => st().reparent(feature('Q2'), byName('Q3').id));
      expect(satisfied(st().model)).toEqual(['t1']);
      await pageIsFile('drag');
      load(src);
      oneStep('drag many', () => st().reparentMany([feature('Q2'), feature('Q4')], byName('Q3').id));
      await pageIsFile('drag many');
      // And back: the redefinition is Q2's again, on the page and in the file.
      load(src);
      st().reparent(feature('Q2'), byName('Q3').id);
      st().reparent(feature('Q3'), byName('Q2').id);
      await pageIsFile('dragged back');
    });

    describe('a rename (updateElement on declaredName or declaredShortName)', () => {
      /** v's `:>> M` is R's `M2 redefines M`; v's other feature is named `other`. */
      const text = (order: 'forward' | 'reversed', other: string): string => {
        const body =
          order === 'forward' ? `attribute :>> M = 5.0; attribute ${other} = 9.0;` : `attribute ${other} = 9.0; attribute :>> M = 5.0;`;
        const c = order === 'forward' ? ['v.M == 5.0', 'v.M2 == 9.0', 'v.M2 == 5.0'] : ['5.0 == v.M', '9.0 == v.M2', '5.0 == v.M2'];
        return `package RN {
  part def Q { attribute M default = 1.0; }
  part def R :> Q { attribute M2 redefines M default = 2.0; }
  part v : R { ${body} }
  constraint vM5 { ${c[0]} }
  constraint vM29 { ${c[1]} }
  constraint vM25 { ${c[2]} }
}`;
      };
      const sibling = (name: string): string => st().model.children(byName('v').id).find((c) => c.declaredName === name)!.id;
      for (const order of ['forward', 'reversed'] as const) {
        it(`into the name v's \`:>> M\` is known by keeps the two features apart (text order ${order})`, async () => {
          load(text(order, 'Z'));
          // v's `:>> M` is R's M2 (v.M2 is the 5); v's other feature is named Z.
          expect(satisfied(st().model)).toEqual(['vM25', 'vM5']);
          oneStep('rename', () => st().updateElement(sibling('Z'), { declaredName: 'M2' }));
          // The sibling is M2 now, and `:>> M` stays Q's M, as the file says it: M2 is the 9, M the 5 (the table's
          // `redef-target-own-name`), not two features of one name.
          expect(satisfied(st().model)).toEqual(['vM29', 'vM5']);
          expect(serializeModel(st().model)).toMatch(/attribute :>> M = 5\.0;/);
          await pageIsFile('rename');
          // ...which is the same text written by hand.
          expect(await surfaces(st().model)).toEqual(await surfaces(parseModel(text(order, 'M2')).model));
        });
        it(`away from it keeps v's \`:>> M\` where it was, and the file reads alike (text order ${order})`, async () => {
          load(text(order, 'M2'));
          expect(satisfied(st().model)).toEqual(['vM29', 'vM5']);
          oneStep('rename away', () => st().updateElement(sibling('M2'), { declaredName: 'Z' }));
          // Q's M stays redefined, now named by its path: the page and the file keep the 5 on M, and R's M2 its 2.
          await pageIsFile('rename away');
          expect(serializeModel(st().model)).toMatch(/attribute :>> RN::Q::M = 5\.0;/);
        });
      }
      it('a short name is a rename too', async () => {
        load(text('forward', 'Z'));
        oneStep('short name', () => st().updateElement(sibling('Z'), { declaredShortName: 'M2' }));
        await pageIsFile('short name');
      });

      it('an edit made through the SDK settles too (it has no undo step of its own)', async () => {
        const model = st().api.model;
        model.resetPreserving(parseModel(text('forward', 'Z')).model.toJSON(), (el) => el.attrs.isLibrary === true);
        useAppStore.setState({ model, undoStack: [], redoStack: [], selectionId: null, selectionIds: [] });
        st().api.update(sibling('Z'), { declaredName: 'M2' });
        expect(satisfied(st().model)).toEqual(['vM29', 'vM5']);
        await pageIsFile('sdk rename');
        model.resetPreserving(new Model().toJSON(), () => false);
      });
    });

    it('deleting a feature that skips a level of the chain lands the redefinition where the name finds it now', async () => {
      // Q4's `M4 redefines Q::M` skips Q2's unnamed `:>> M`; s's `:>> M` redefines M4. Without M4 the text reads Q2's.
      const da = `package DA {
  part def Q { attribute M default = 1.0; }
  part def Q2 :> Q { attribute :>> M default = 2.0; }
  part def Q4 :> Q2 { attribute M4 redefines Q::M default = 4.0; }
  part s : Q4 { attribute :>> M; }
  constraint s1 { s.M == 1.0 }
  constraint s2 { s.M == 2.0 }
  constraint s4 { s.M == 4.0 }
}`;
      load(da);
      expect(satisfied(st().model)).toEqual(['s4']);
      oneStep('delete M4', () => st().deleteElement(byName('M4').id));
      expect(satisfied(st().model)).toEqual(['s2']);
      // The user's `:>> M` stays: not a qualified name nobody wrote.
      expect(serializeModel(st().model)).toMatch(/part s : Q4 \{\s*attribute :>> M;\s*\}/);
      await pageIsFile('delete M4');
      // The Delete key takes the same way.
      load(da);
      st().setSelection([byName('M4').id]);
      oneStep('delete M4 (selection)', () => st().deleteSelection());
      expect(satisfied(st().model)).toEqual(['s2']);
      await pageIsFile('delete M4 (selection)');
    });

    it('the same delete made through the SDK, or on the model itself, lands the redefinition where the name finds it', async () => {
      const da = `package DA {
  part def Q { attribute M default = 1.0; }
  part def Q2 :> Q { attribute :>> M default = 2.0; }
  part def Q4 :> Q2 { attribute M4 redefines Q::M default = 4.0; }
  part s : Q4 { attribute :>> M; }
  constraint s1 { s.M == 1.0 }
  constraint s2 { s.M == 2.0 }
  constraint s4 { s.M == 4.0 }
}`;
      const model = st().api.model;
      const fromSdk = (): void => {
        model.resetPreserving(parseModel(da).model.toJSON(), (el) => el.attrs.isLibrary === true);
        useAppStore.setState({ model, undoStack: [], redoStack: [], selectionId: null, selectionIds: [] });
      };
      for (const [how, remove] of [
        ['window.sysml.delete', (id: string): unknown => st().api.delete(id)],
        ['window.sysml.model.remove', (id: string): unknown => st().api.model.remove(id)],
        ['window.sysml.commit(delete)', (id: string): unknown => st().api.commit(() => st().api.delete(id))],
      ] as const) {
        fromSdk();
        expect(satisfied(st().model), how).toEqual(['s4']);
        remove(byName('M4').id);
        // Q2's unnamed `:>> M` is the most specific `M` Q4 has now; the user's `:>> M` is not a qualified name.
        expect(satisfied(st().model), how).toEqual(['s2']);
        expect(serializeModel(st().model), how).toMatch(/part s : Q4 \{\s*attribute :>> M;\s*\}/);
        await pageIsFile(how);
        // ...which is the text without M4.
        expect(await surfaces(st().model), how).toEqual(
          await surfaces(parseModel(da.replace('attribute M4 redefines Q::M default = 4.0;', '')).model),
        );
      }
      model.resetPreserving(new Model().toJSON(), () => false);
    });

    it('a feature dragged where no path can name it takes along the redefinitions that named it by one', async () => {
      // w's `:>> A::a` names a feature of a type w does not specialise, by its path; in the unnamed part there is no path.
      load(`package G {
  part def A { attribute a default = 1.0; }
  part w { attribute :>> A::a = 5.0; }
  part z { part { attribute y = 1.0; } }
}`);
      expect(targets(st().model)).toHaveLength(1);
      const inner = st().model.children(byName('z').id).find((c) => c.eClass === 'PartUsage')!;
      oneStep('drag into an unnamed part', () => st().reparent(byName('a').id, inner.id));
      await pageIsFile('drag into an unnamed part');
      // and into a named one, where the path is written anew
      load(`package G {
  part def A { attribute a default = 1.0; }
  part w { attribute :>> A::a = 5.0; }
  part z;
}`);
      oneStep('drag into a named part', () => st().reparent(byName('a').id, byName('z').id));
      expect(serializeModel(st().model)).toMatch(/attribute :>> G::z::a = 5\.0;/);
      await pageIsFile('drag into a named part');
    });

    it('an edit that cannot move a redefinition does not ask every one a type the edit touched has below it', () => {
      // 100 usages of D2, which specialises D and redefines D's 12 attributes, each usage redefining 12 in turn: 1200
      // redefinitions below D. Renaming D's `a0`, or adding a feature to D, moves only those known by `a0`'s line.
      const A = 12;
      const U = 100;
      const attrs = Array.from({ length: A }, (_, i) => `attribute a${i} default = ${i}.0;`).join(' ');
      const re = Array.from({ length: A }, (_, i) => `attribute :>> a${i} default = ${i + 1}.0;`).join(' ');
      const uses = Array.from(
        { length: U },
        (_, j) => `part u${j} : D2 { ${Array.from({ length: A }, (_, i) => `attribute :>> a${i} = ${j}.0;`).join(' ')} }`,
      ).join('\n');
      load(`package G { part def D { ${attrs} } part def D2 :> D { ${re} } ${uses} }`);
      const m = st().model;
      const a0 = m.children(byName('D').id).find((c) => c.declaredName === 'a0')!;
      const all = m.all().filter((e) => e.attrs.isLibrary !== true && !isRelationship(e.eClass)).map((e) => e.id);
      const time = (f: () => void): number => {
        const t = performance.now();
        f();
        return performance.now() - t;
      };
      // The measure: every redefinition of the model asked once (nothing moves).
      const full = time(() => settleRedefinitions(m, all));
      const rename = time(() => st().updateElement(a0.id, { declaredName: 'a0x' }));
      const create = time(() => st().createElement('AttributeUsage', byName('D').id, 'zz'));
      expect(rename, `rename ${rename.toFixed(0)} ms against a full settle ${full.toFixed(0)} ms`).toBeLessThan(full / 2);
      expect(create, `create ${create.toFixed(0)} ms against a full settle ${full.toFixed(0)} ms`).toBeLessThan(full / 2);
      // What the rename did ask, it settled: the redefinitions of the renamed line follow it, and the file agrees.
      expect(targets(m)).toEqual(targets(reopened(m)));
      expect(serializeModel(m)).toMatch(/attribute :>> a0x = 0\.0;/);
    }, 120_000);

    it('a redefinition nested in a redefined part follows an edit of the base, the part or its type', async () => {
      // w's nested `part :>> p { attribute :>> load; }` resolves `load` through the part it redefines, whose own type
      // redefines P's load in turn: each edit below moves the part, or the feature, and the nested one with it.
      const nested = `package G {
  part def P { attribute load default = 1.0; }
  part def P2 :> P { attribute :>> load default = 2.0; }
  part def H { part p : P; }
  part def H2 :> H { part :>> p : P2; }
  part w : H2 { part :>> p { attribute :>> load = 5.0; } }
  constraint c1 { w.p.load == 1.0 }
  constraint c5 { w.p.load == 5.0 }
}`;
      load(nested);
      expect(targets(st().model)).toHaveLength(4);
      await pageIsFile('loaded');
      const p = byName('P').id;
      const feature = (owner: string) => st().model.children(byName(owner).id).find((c) => c.eClass === 'AttributeUsage')!.id;
      oneStep('rename the base', () => st().updateElement(st().model.children(p).find((c) => c.declaredName === 'load')!.id, { declaredName: 'power' }));
      await pageIsFile('rename the base');
      load(nested);
      oneStep('retype w', () => st().bindType(byName('w').id, 'H'));
      await pageIsFile('retype w');
      load(nested);
      oneStep('delete P2', () => st().deleteElement(byName('P2').id));
      await pageIsFile('delete P2');
      load(nested);
      oneStep('drag the unnamed load out', () => st().reparent(feature('P2'), byName('H').id));
      await pageIsFile('drag the unnamed load out');
    });

    it('a paste and a duplicate settle what they bring', async () => {
      // t's `:>> M` pasted into u, a Q: the copy redefines Q2's unnamed feature, which u does not inherit.
      load(src.replace('constraint t1', 'part u : Q;\n  constraint t1'));
      st().setSelection([feature('t')]);
      st().copySelection();
      oneStep('paste', () => {
        expect(st().pasteClipboard(byName('u').id)).toHaveLength(1);
      });
      await pageIsFile('paste');
      load(src);
      oneStep('duplicate', () => {
        expect(st().duplicateElement(feature('Q2'))).not.toBeNull();
      });
      await pageIsFile('duplicate');
    });

    it('the implicit end copy a usage-body binding makes follows a retype: Q2 to Q, and back', async () => {
      // `bind p.load = L` in `part r : Q2` makes r an implicit `L`, which redefines what the name finds in r's type: Q2's
      // `:>> L = 50.0`. The saved file leaves the copy out and makes it anew, on Q's `L` once r is a Q.
      const ec = `package EC {
  part def P { attribute load default = 1.0; }
  part def Q { attribute L; part p : P; }
  part def Q2 :> Q { attribute :>> L = 50.0; }
  part r : Q2 { bind p.load = L; }
  constraint r50 { r.p.load == 50.0 }
  constraint r1 { r.p.load == 1.0 }
}`;
      const landsOn = (): string | undefined => copies(st().model).get('EC::r::L');
      const l = (owner: string): string => place(st().model, st().model.children(byName(owner).id).find((c) => c.eClass === 'AttributeUsage')!.id);
      load(ec);
      expect(satisfied(st().model)).toEqual(['r50']);
      expect(landsOn()).toBe(l('Q2'));
      oneStep('retype r to Q', () => st().bindType(byName('r').id, 'Q'));
      // The copy is the one the binding holds, moved: it redefines Q's `L` now, and the page reads Q's value.
      expect(landsOn()).toBe(l('Q'));
      expect(satisfied(st().model)).toEqual(['r1']);
      await pageIsFile('retype r to Q');
      oneStep('retype r back to Q2', () => st().bindType(byName('r').id, 'Q2'));
      expect(landsOn()).toBe(l('Q2'));
      expect(satisfied(st().model)).toEqual(['r50']);
      await pageIsFile('retype r back to Q2');
      // Typed by Q from the start, and retyped the other way.
      load(ec.replace('part r : Q2', 'part r : Q'));
      expect(satisfied(st().model)).toEqual(['r1']);
      oneStep('retype r to Q2', () => st().bindType(byName('r').id, 'Q2'));
      expect(satisfied(st().model)).toEqual(['r50']);
      await pageIsFile('retype r to Q2');
      // The same without the retype: Q2's unnamed `:>> L` deleted, r's copy goes to Q's `L` as the name finds it.
      load(ec);
      const bindings = (): number => st().model.all().filter((e) => e.eClass === 'BindingConnectorAsUsage' && e.attrs.isLibrary !== true).length;
      const before = bindings();
      oneStep('delete Q2\'s L', () => st().deleteElement(st().model.children(byName('Q2').id).find((c) => c.eClass === 'AttributeUsage')!.id));
      expect(bindings()).toBe(before);
      expect(satisfied(st().model)).toEqual(['r1']);
      await pageIsFile('delete Q2\'s L');
    });

    // The settle takes a round per hop (re-review: four rounds left a chain of five copies, or five nested explicit
    // `:>>`s, on the features the page had before the retype, and the page read nothing where the file read 1).
    it('settles a chain of five implicit end copies, and five nested explicit redefinitions, on a retype', async () => {
      const chain = `package DP {
  part def T0 { attribute x = 1.0; }
  part def T0b :> T0 { attribute :>> x = 2.0; }
  part def A0 { part n1 : A1; }
  part def A1 { part n2 : A2; }
  part def A2 { part n3 : A3; }
  part def A3 { part n4 : T0; }
  part def B0 :> A0 { part :>> n1 : B1; }
  part def B1 :> A1 { part :>> n2 : B2; }
  part def B2 :> A2 { part :>> n3 : B3; }
  part def B3 :> A3 { part :>> n4 : T0b; }
  part r : B0 { BODY }
  constraint c3 { r.n1.n2.n3.n4.x == 1.0 }
  constraint c4 { r.n1.n2.n3.n4.x == 2.0 }
}`;
      // `bind y = n1.n2.n3.n4.x` makes four hop copies and the leaf: five implicit end copies, one per round.
      const bound = chain.replace('BODY', 'attribute y; bind y = n1.n2.n3.n4.x;').replace('}\n', '}\n  constraint c1 { r.y == 1.0 }\n');
      const nested = chain.replace('BODY', 'part :>> n1 { part :>> n2 { part :>> n3 { part :>> n4 { attribute :>> x; } } } }');
      for (const [note, text, copiesMade, read] of [
        ['bind chain', bound, 5, ['c1', 'c3']],
        ['explicit chain', nested, 0, ['c3']],
      ] as const) {
        load(text);
        expect(copies(st().model).size, `${note}: copies`).toBe(copiesMade);
        oneStep(`${note}: retype r to A0`, () => st().bindType(byName('r').id, 'A0'));
        // The file reads T0's 1 through every hop; the page, left on B's redefinitions, read nothing.
        expect(satisfied(st().model), `${note}: retyped`).toEqual(read);
        await pageIsFile(`${note}: retype r to A0`);
        oneStep(`${note}: retype r back to B0`, () => st().bindType(byName('r').id, 'B0'));
        await pageIsFile(`${note}: retype r back to B0`);
      }
    }, 120_000);

    // An explicit `:>>` of a usage is no candidate for an implicit end copy a definition-level `bind` made: the parse that
    // wrote the file never sees it (re-review: `part r1 : Q2 { attribute :>> L; }` retyped to Q3 landed on Q3's `L`).
    it('keeps an explicit :>> off the implicit end copy of a definition-level bind', async () => {
      load(`package LC {
  part def P { attribute load default = 11.0; }
  part def Q { attribute L; part p : P; }
  part def Q2 :> Q { attribute :>> L = 15.0; }
  part def Q3 :> Q2 { bind p.load = L; }
  part r1 : Q2 { attribute :>> L; }
  constraint c1 { r1.L == 15.0 }
  constraint c2 { r1.p.load == 15.0 }
}`);
      const aim = (): string[] => targets(st().model).filter((t) => t.startsWith('LC::r1#0 '));
      expect(aim()).toEqual(['LC::r1#0 -> LC::Q2#0']);
      oneStep('retype r1 to Q3', () => st().bindType(byName('r1').id, 'Q3'));
      expect(aim()).toEqual(['LC::r1#0 -> LC::Q2#0']);
      expect(satisfied(st().model)).toEqual(['c1', 'c2']);
      await pageIsFile('retype r1 to Q3');
      // A typing drawn to a definition whose `bind` made a copy of the name (the re-review's defmin probe): u0 stays on D1's
      // `:>> M`, as `part u0 : D1, D2` read afresh puts it, and the four surfaces read the 14.
      load(`package G {
  part def Q0 { attribute M default = 11.0; }
  part def D1 :> Q0 { attribute :>> M default = 14.0; }
  part def D2 :> Q0 { attribute Zd2; bind Zd2 = M; }
  part u0 : D1 { attribute :>> M; }
  constraint z11 { u0.Zd2 == 11.0 }
  constraint z14 { u0.Zd2 == 14.0 }
}`);
      oneStep('draw u0 : D2', () => st().connect(byName('u0').id, byName('D2').id, 'FeatureTyping'));
      expect(targets(st().model).filter((t) => t.startsWith('G::u0#0 '))).toEqual(['G::u0#0 -> G::D1#0']);
      await pageIsFile('draw u0 : D2');
      // A full settle of the model as loaded moves no explicit redefinition: the next edit starts from the file's.
      load(serializeModel(st().model));
      const all = st().model.all().filter((e) => e.attrs.isLibrary !== true && !isRelationship(e.eClass)).map((e) => e.id);
      const before = targets(st().model);
      settleRedefinitions(st().model, all);
      expect(targets(st().model)).toEqual(before);
    });

    // An implicit end copy is named by the most specific feature it redefines (`bind Zb = M` in `part u0 : D4, D3` makes
    // `u0::N2`, D1's `N2 redefines M` that D4 redefines again), and `bind Zb = N2` is read on the next open as D2's
    // other `N2`: the copy keeps the name the author wrote and Save writes that (seed 2373 of the property soak).
    it('saves an implicit end copy under the name the author wrote, so the next open makes the same copy', async () => {
      const text = `package G {
  part def Q0 { attribute M default = 11.0; attribute N default = 12.0; }
  part def D1 :> Q0 { attribute N2 redefines M default = 13.0; attribute Zd1; bind Zd1 = N; }
  part def D2 :> Q0 { attribute X redefines M default = 14.0; attribute N2 default = 15.0; attribute Zd2; bind Zd2 = N; }
  part def D3 :> Q0, D1 {  }
  part def D4 :> D3, D2 { attribute :>> N default = 16.0; attribute :>> N2 default = 17.0; }
  part u0 : D4, D3 { attribute Z1 = 19.0; attribute Zb = 1.0; bind Zb = M; }
  constraint cM { u0.M == 17.0 }
  constraint cZ { u0.Zb == 17.0 }
}`;
      load(text);
      const saved = serializeModel(st().model);
      expect(saved).toContain('bind Zb = M;');
      expect(saved).not.toContain('bind Zb = N2;');
      await pageIsFile('seed 2373');
      // Renamed away, the head no longer names what the copy redefines: the copy goes by its own name, as before.
      st().updateElement(byName('M').id, { declaredName: 'MM' });
      expect(serializeModel(st().model)).not.toContain('bind Zb = M;');
    });

    // The head is kept only while the next open reads it onto the copy's own line: a feature `M` of the usage, or a
    // closer `M` in a type, would take `bind Zb = M` off the copy, so the copy goes by its own name (the review's probes).
    it('writes an implicit end copy by its own name where a feature of the usage or a type shadows the head', async () => {
      const text = `package G {
  part def Q0 { attribute M default = 11.0; attribute N default = 12.0; }
  part def D1 :> Q0 { attribute N2 redefines M default = 13.0; }
  part def D3 :> Q0, D1 {  }
  part u0 : D3 { attribute Zb = 1.0; bind Zb = M; }
}`;
      load(text);
      expect(serializeModel(st().model)).toContain('bind Zb = M;');
      st().createElement('AttributeUsage', byName('u0').id, 'M');
      expect(serializeModel(st().model)).toContain('bind Zb = N2;');
      await pageIsFile('own M in u0');
      load(text);
      st().createElement('AttributeUsage', byName('D3').id, 'M');
      expect(serializeModel(st().model)).toContain('bind Zb = N2;');
      await pageIsFile('M in D3');
    });

    // An implicit end copy whose name nothing its owner inherits any more (after a retype, a delete or a rename) is a
    // copy the next open does not make: the settle parts it from the feature it redefined (a STALE copy, a feature of
    // its owner with no value and no relation), so the page reads the binding as the file reads it, with the end
    // unresolved; and a retype back, or a rename back, puts the copy on a feature again.
    describe('an implicit end copy the next open would not make is stale, and the page reads what the file reads', () => {
      const EC = `package EC {
  part def P { attribute load default = 1.0; }
  part def Q { attribute L; part p : P; }
  part def Q2 :> Q { attribute :>> L = 50.0; }
  part def Z;
  part def Z2 { part p : P; }
  part r : Q2 { bind p.load = L; }
  constraint r1 { r.p.load == 1.0 }
  constraint r50 { r.p.load == 50.0 }
}`;
      const qL = (): string => st().model.children(byName('Q').id).find((c) => c.declaredName === 'L')!.id;
      /** The implicit end copies of `r` that redefine nothing: what the settle left stale. */
      const stale = (): string[] =>
        st()
          .model.children(byName('r').id)
          .filter((c) => isStaleCopy(st().model, c))
          .map((c) => c.declaredName ?? '')
          .sort();

      it('a retype to a type without the name, with only a part of it, or a type deleted', async () => {
        for (const [note, run] of [
          ['retype r to Z', () => st().bindType(byName('r').id, 'Z')],
          ['retype r to Z2', () => st().bindType(byName('r').id, 'Z2')],
          ['delete Q2', () => st().deleteElement(byName('Q2').id)],
        ] as const) {
          load(EC);
          expect(stale(), `${note}: none before`).toEqual([]);
          oneStep(note, run);
          expect(stale().length, `${note}: the copy of L is stale`).toBeGreaterThan(0);
          await pageIsFile(note);
        }
      });

      it('the feature the name finds deleted or renamed', async () => {
        load(EC);
        st().deleteElement(qL());
        expect(stale()).toContain('L');
        await pageIsFile('delete Q::L');
        load(EC);
        oneStep('rename Q::L', () => st().updateElement(qL(), { declaredName: 'LL' }));
        expect(stale()).toContain('L');
        await pageIsFile('rename Q::L to LL');
        // Renamed back, the copy redefines a feature again.
        st().updateElement(byName('LL').id, { declaredName: 'L' });
        expect(stale()).toEqual([]);
        await pageIsFile('rename Q::LL back to L');
      });

      it('a retype back puts the copy on the feature again, and the binding reads through it', async () => {
        load(EC);
        st().bindType(byName('r').id, 'Z');
        expect(stale().length).toBeGreaterThan(0);
        st().bindType(byName('r').id, 'Q2');
        expect(stale()).toEqual([]);
        expect(satisfied(st().model)).toEqual(['r50']);
        await pageIsFile('retype Z then back to Q2');
        // And onto a type that bears the name differently: Q's `L`, not Q2's `:>> L = 50.0`.
        st().bindType(byName('r').id, 'Z');
        st().bindType(byName('r').id, 'Q');
        expect(satisfied(st().model)).toEqual(['r1']);
        await pageIsFile('retype Z then to Q');
      });

      // The two readings that stay WEAKER or different than the file's, pinned with their reasons (docs/USER-GUIDE.md,
      // 'Five more cases are not followed'): neither is a satisfied or refuted verdict the file does not give.
      it('the readings that differ from the file stay abstentions, not verdicts', async () => {
        // A binding with a stale end is set aside: the numeric lane abstains where the file decides.
        load(`package DB {
  part def P { attribute load default = 11.0; }
  part def Q { attribute L; part p : P; }
  part def Q1 :> Q { attribute :>> L default = 12.0; bind p.load = L; }
  part r0 : Q1 { bind p.load = L; }
  constraint c1 { r0.p.load == 12.0 }
  constraint c2 { r0.p.load == 11.0 }
}`);
        st().deleteElement(st().model.children(byName('Q').id).find((c) => c.declaredName === 'L')!.id);
        const page = await surfaces(st().model);
        const file = await surfaces(reopened(st().model));
        expect(page['DB::c1'], 'page: the numeric lane abstains (?)').toBe('F/F/?/F');
        expect(file['DB::c1'], 'file: decided').toBe('F/F/F/F');
        // A name the stale copy still bears resolves on the page: the numeric lane reads the equation as imposed (t),
        // where the file's unresolved name decides nothing. No satisfied or refuted cell on any surface of either.
        load(`package RN {
  part def P { attribute load; }
  part def Q { attribute L; part p : P; }
  part def Q1 :> Q { attribute :>> L = 14.0; }
  part r0 : Q1 { bind p.load = L; }
  constraint a { r0.L == 14.0 }
  constraint b { r0.p.load == 14.0 }
}`);
        st().updateElement(st().model.children(byName('Q').id).find((c) => c.declaredName === 'L')!.id, { declaredName: 'Zz' });
        const renamed = await surfaces(st().model);
        const reopenedFile = await surfaces(reopened(st().model));
        expect(renamed['RN::a'], 'page: imposed (t) through the stale copy').toBe('?/?/t/?');
        expect(reopenedFile['RN::a'], 'file: unresolved').toBe('?/?/?/?');
        for (const row of [renamed['RN::a']!, reopenedFile['RN::a']!, page['DB::c1']!]) expect(row).not.toMatch(/T/);
      });

      // Renaming the feature a copy redefines: the next open names the copy by the new name (the copy follows, so a row
      // written with the old name reads as the file reads it), or merges the binding into a feature of the owner that
      // bears the new name (the copy is parted: the page abstains where the file decides, and never inverts).
      it('renaming the feature the copy redefines renames the copy, or parts it where the name is taken', async () => {
        load(`package G {
  part def Q0 { attribute M default = 11.0; }
  part def D2 :> Q0 { attribute N2 :>> M default = 15.0; }
  part u0 : D2 { attribute Zb; bind Zb = M; }
  constraint cOld { u0.N2 == 21.0 }
}`);
        st().updateElement(byName('N2').id, { declaredName: 'Zd3' });
        expect(st().model.children(byName('u0').id).some((c) => c.declaredName === 'Zd3' && c.attrs.implicit === true)).toBe(true);
        await pageIsFile('rename D2::N2 to Zd3');
        load(`package G {
  part def Q0 { attribute N default = 12.0; }
  part def D2 :> Q0 { attribute :>> N default = 14.0; }
  part u0 : D2 { attribute Z1 = 21.0; attribute Zb; bind Zb = N; }
  constraint c14 { u0.Zb == 14.0 }
  constraint c21 { u0.Zb == 21.0 }
}`);
        st().updateElement(st().model.children(byName('D2').id).find((c) => c.eClass === 'AttributeUsage')!.id, { declaredName: 'Z1' });
        const page = await surfaces(st().model);
        expect(page['G::c14'], 'page: abstains where the file decides, never inverted').toBe('?/?/?/?');
        expect(page['G::c21']).toBe('?/?/?/?');
      });

      // A binding whose end is a copy the saved file does not make AND whose name a member of the owner bears: the file
      // binds that member (a retype, a rename, a feature made), the page cannot say what it then joins. The scope of
      // the binding's owner is withheld (DefiningEquations.partedHolder), so a row naming one decides nothing, where
      // the page used to read the binding set aside (Zb at its own 1.0: F) and the file reads two values joined (??).
      // Soak seeds 333, 1115, 3034 of review-2026-10-14/wave3-probes/fence-editor/b.test.ts.
      it('a copy whose name a member of its owner bears parts the binding: the rows of both ends are withheld, as the file reads them', async () => {
        const cells = (row: string | undefined): string[] => (row ?? '').split('/');
        /** No cell the page decides (T or F) that the file does not give alike: the file may decide more, never less sure. */
        const neverMore = (page: Record<string, string>, file: Record<string, string>, note: string): void => {
          for (const [k, row] of Object.entries(page)) {
            cells(row).forEach((c, i) => {
              if (c === 'T' || c === 'F') expect(cells(file[k])[i], `${note}: ${k} lane ${i}`).toBe(c);
            });
          }
        };
        // (a) The copy is stale after a retype, then a rename gives a member of the owner its name (seed 3034).
        load(`package PB {
  part def Q0 { attribute N default = 12.0; }
  part def D1 :> Q0;
  part def D4 :> D1 { attribute K2 default = 15.0; }
  part u1 : D4 { attribute :>> N = 19.0; attribute Zb = 1.0; bind Zb = K2; }
  constraint cZb { u1.Zb == 11.0 }
  constraint cN { u1.N == 19.0 }
  constraint cK { u1.K2 == 15.0 }
}`);
        st().bindType(byName('u1').id, 'D1');
        const retyped = await surfaces(st().model);
        neverMore(retyped, await surfaces(reopened(st().model)), 'retype u1 to D1');
        st().updateElement(st().model.children(byName('Q0').id).find((c) => c.declaredName === 'N')!.id, { declaredName: 'K2' });
        const a = await surfaces(st().model);
        expect(a['PB::cZb'], 'page: the binding is parted, Zb is not read').toBe('?/?/?/?');
        const said = checkConstraints(st().model).find((r) => st().model.qualifiedName(r.id) === 'PB::cZb')!;
        expect(said.message, 'the check says why').toContain('u1.Zb is not read: PB::u1 owns a binding whose end is a copy the saved file reads as another feature');
        neverMore(a, await surfaces(reopened(st().model)), 'rename Q0::N to K2');
        // (b) The copy is not stale: the rename gives a member of the owner the name its feature bears (seed 1115).
        load(`package PC {
  part def T0 { attribute K default = 13.0; }
  part def D1 :> T0 { attribute K2 default = 14.0; attribute M2 :>> K default = 15.0; }
  part u1 : D1 { attribute :>> M2 = 17.0; attribute Zb = 1.0; bind Zb = K2; }
  constraint cM2 { u1.M2 == 18.0 }
  constraint cZb { u1.Zb == 14.0 }
}`);
        st().updateElement(st().model.children(byName('T0').id).find((c) => c.declaredName === 'K')!.id, { declaredName: 'K2' });
        const b = await surfaces(st().model);
        expect(b['PC::cM2'], 'page: u1 is withheld').toBe('?/?/?/?');
        neverMore(b, await surfaces(reopened(st().model)), 'rename T0::K to K2');
        // (c) A bound end moved up into a type its owner specialises: the file makes the copy `u0::Zb` the page does
        // not hold (seed 20290), and reads the two values joined where the page read M at its own 18.0.
        load(`package PD {
  part def Q0 { attribute M default = 11.0; }
  part u0 : Q0 { attribute :>> M = 18.0; attribute Zb = 1.0; bind Zb = M; }
  constraint cM { u0.M == 18.0 }
  constraint cZ { u0.Zb == 18.0 }
}`);
        st().reparent(byName('Zb').id, byName('Q0').id);
        const c = await surfaces(st().model);
        expect(c['PD::cM'], 'page: u0 is withheld').toBe('?/?/?/?');
        expect(c['PD::cZ']).toBe('?/?/?/?');
        neverMore(c, await surfaces(reopened(st().model)), 'move u0::Zb up into Q0');
        // (d) A binding that reaches the parted scope through ANOTHER binding (review of fence-editor2): `v.x` joins
        // `u1.Zb`, whose own binding is parted, so no lane reads K2 of the owner (default 14.0) or the stated value
        // through the set-aside binding: the page abstains where the file decides, never the reverse.
        load(`package PE {
  part def T0 { attribute K default = 13.0; }
  part def D1 :> T0 { attribute K2 default = 14.0; attribute M2 :>> K default = 15.0; }
  part u1 : D1 { attribute :>> M2 = 17.0; attribute Zb default = 1.0; bind Zb = K2; }
  part v { attribute x; }
  bind v.x = u1.Zb;
  constraint cV1 { v.x == 1.0 }
  constraint cV14 { v.x == 14.0 }
  constraint cV17 { v.x == 17.0 }
}`);
        st().updateElement(st().model.children(byName('T0').id).find((c2) => c2.declaredName === 'K')!.id, { declaredName: 'K2' });
        const d = await surfaces(st().model);
        for (const k of ['PE::cV1', 'PE::cV14', 'PE::cV17']) expect(d[k], `page: ${k} chains into a parted scope`).toBe('?/?/?/?');
        neverMore(d, await surfaces(reopened(st().model)), 'rename T0::K to K2, chained');
        // (e) A scope is withheld in a model whose other rows do not read it (soak seed 60601): the solver's axioms hold
        // every scope, and the file finds them inconsistent where the page, without that scope's names, does not. The
        // SMT lane then proves and refutes nothing on this model, never an F where the file says inconsistent axioms.
        load(`package PF {
  part def Q0 { attribute M default = 11.0; attribute N default = 12.0; }
  part def D1 :> Q0 { attribute :>> N default = 13.0; attribute Zd1; bind Zd1 = M; }
  part def D2 :> D1 { attribute :>> M default = 14.0; attribute K2 :>> N default = 15.0; }
  part def D3 :> D2 { attribute :>> N default = 16.0; attribute Zd3; bind Zd3 = PF::D3::K2; }
  part def D4 :> D3;
  part def D5 :> D1 { attribute X :>> M default = 17.0; attribute K2 default = 18.0; }
  part u1 : Q0 : D4 { attribute :>> M = 21.0; attribute :>> N; attribute Z1 = 22.0; }
  constraint c4 { u1.N == 22.0 }
  constraint c8 { u1.Z1 == 20.0 }
}`);
        const kidOf = (owner: string, name: string) => st().model.children(byName(owner).id).find((c2) => c2.declaredName === name)!;
        st().reparent(kidOf('D1', 'Zd1').id, byName('Q0').id);
        st().updateElement(kidOf('D5', 'K2').id, { declaredName: 'Z1' });
        st().updateElement(
          st().model.children(byName('D4').id).find((c2) => c2.eClass === 'Subclassification')!.id,
          { target: [byName('Q0').id] },
        );
        const e = await surfaces(st().model);
        const eFile = await surfaces(reopened(st().model));
        for (const k of ['PF::c4', 'PF::c8']) {
          expect(cells(e[k])[3], `page: ${k} is not proved or refuted by the solver`).toBe('?');
          neverMore(e, eFile, 'seed 60601');
        }
        // A stale copy no member of its owner bears stays exactly as before: the file reads the end unresolved too.
        load(EC);
        st().bindType(byName('r').id, 'Z');
        expect(await surfaces(st().model)).toEqual(await surfaces(reopened(st().model)));
      });

      it('deleting the feature a definition-level bind ends on leaves no copy the page proves through', async () => {
        load(`package DB {
  part def P { attribute load default = 1.0; }
  part def Q { part p : P; }
  part def Q1 :> Q { bind p.load = 5.0; }
  part r0 : Q1;
  constraint c1 { r0.p.load == 5.0 }
  constraint c2 { r0.p.load == 1.0 }
}`);
        st().deleteElement(st().model.children(byName('Q').id).find((c) => c.declaredName === 'p')!.id);
        await pageIsFile('delete Q::p');
      });
    });

    // The settle runs on every route that edits the model, not only on a command of the editor: a call on the model on
    // screen (`window.sysml.model.update`, `.remove`), where no command opened a step. Not in a room: a peer's edit is
    // settled by its sender (the moves arrive as edits).
    describe('a raw call on the model on screen is settled, where it ends', () => {
      const T = `package P {
  part def Q { attribute M default = 1.0; }
  part def Q2 :> Q { attribute :>> M default = 2.0; }
  part t : Q2 { attribute :>> M; }
  constraint t1 { t.M == 1.0 }
  constraint t2 { t.M == 2.0 }
}`;
      it('model.update of a typing moves the `:>>` as a retype in the app does', async () => {
        load(T);
        expect(satisfied(st().model)).toEqual(['t2']);
        st().model.update(typingOf('t'), { target: [byName('Q').id] });
        expect(satisfied(st().model)).toEqual(['t1']);
        await pageIsFile('model.update typing');
      });

      it('model.remove of a type, and of the feature a binding copy redefines', async () => {
        load(T);
        st().model.remove(typingOf('t'));
        expect(satisfied(st().model)).toEqual(['t1']);
        await pageIsFile('model.remove typing');
        load(`package CP {
  part def P { attribute load default = 1.0; }
  part def Q { attribute L; part p : P; }
  part def Q2 :> Q { attribute :>> L = 50.0; }
  part def Q3 :> Q { attribute :>> L = 60.0; }
  part r : Q2, Q3 { bind p.load = L; }
  constraint r50 { r.p.load == 50.0 }
  constraint r60 { r.p.load == 60.0 }
  constraint r1 { r.p.load == 1.0 }
}`);
        st().model.remove(st().model.children(byName('Q3').id).find((c) => c.eClass === 'AttributeUsage')!.id);
        expect(satisfied(st().model)).toEqual(['r50']);
        await pageIsFile('model.remove Q3::L');
      });

      // The binding of references that follows an open or a library merge is the app's own work, not a call to settle:
      // it ran unsettled before the raw-call settle, and still does (no cost at boot, no move the author did not ask for).
      it('the merge of the library binds its references without a settle', async () => {
        const merge = lib.merge;
        lib.merge = (m) => {
          const typing = m.all().find((e) => e.eClass === 'FeatureTyping' && m.get(e.source![0]!)?.declaredName === 't');
          if (typing) m.update(typing.id, { target: [m.all().find((e) => e.declaredName === 'Q')!.id] });
        };
        try {
          await openText(T, 'sysml');
          await whenLibrarySettled();
          const t = st().model.all().find((e) => e.declaredName === 't')!;
          const typed = st().model.relationshipsFrom(t.id).find((r) => r.eClass === 'FeatureTyping')!;
          expect(st().model.get(typed.target![0]!)?.declaredName, 'the merge retargeted the typing').toBe('Q');
          const nested = st().model.children(t.id).find((c) => c.declaredName === undefined && c.eClass === 'AttributeUsage')!;
          const redef = st().model.children(nested.id).find((c) => c.eClass === 'Redefinition')!;
          expect(st().model.get(redef.target![0]!)?.ownerId, 'the redefinition was left where the text put it').toBe(byName('Q2').id);
        } finally {
          lib.merge = merge;
        }
      });

      it('settles the model the store holds whichever it is, and a settle is no edit to settle again', () => {
        load(T);
        const settled = st().model;
        const moves: number[] = [];
        const stop = settled.subscribe((events) => moves.push(events.length));
        settled.update(typingOf('t'), { target: [byName('Q').id] });
        stop();
        // The edit's own batch, then the settle's one batch: no cascade of settles.
        expect(moves.length).toBeLessThanOrEqual(3);
        expect(satisfied(settled)).toEqual(['t1']);
      });
    });

    // A rename that makes the name a nested `:>> b` is spelled by find two features (P3's own `b :>> a` beside the `b`
    // P3 inherits from P) leaves the answer to the ORDER of the owner's generals, which the page and its file do not share
    // (the typing is bound after the redefinition on the page, before it in the file): Save spells it by its path.
    it('a simple name the redefinition rule answers by the order of the generals is saved by its path (seed 5439)', async () => {
      load(`package G {
  part def P { attribute a default = 11.0; attribute b default = 12.0; }
  part def P2 :> P { attribute :>> a default = 13.0; }
  part def P3 :> P { attribute a3 redefines a default = 14.0; }
  part def H { part p : P3; attribute x default = 15.0; }
  part w0 : H { part :>> p { attribute :>> a; } }
}`);
      const a3 = byName('a3').id;
      st().model.update(a3, { declaredName: 'b' });
      const nested = st().model.children(byName('w0').id).find((c) => c.eClass === 'PartUsage')!.id;
      st().bindType(nested, 'P2');
      expect(serializeModel(st().model)).toContain('attribute :>> G::P3::b;');
      const redefinitions = (m: Model): string[] => targets(m).filter((t) => t.startsWith('G::w0::'));
      expect(redefinitions(st().model)).toEqual(redefinitions(reopened(st().model)));
      expect(redefinitions(st().model)).toEqual(['G::w0::«PartUsage»#0 -> G::P3#0:b']);
      // Where the name is no longer ambiguous, it is written as it always was.
      st().updateElement(a3, { declaredName: 'a3' });
      expect(serializeModel(st().model)).not.toContain('G::P3::b');
    });

    it('the same, when a typing is retargeted so that a name finds a part and an attribute (seed 5001)', () => {
      load(`package G {
  part def P { attribute a default = 11.0; attribute b default = 12.0; }
  part def P1 :> P { attribute :>> b default = 13.0; }
  part def H { part p : P; attribute x default = 14.0; }
  part def H1 :> H { part :>> p : P {  } }
  part w0 : H1 { part :>> p { attribute :>> b; } }
  part w1 : H { part :>> p { attribute :>> b = 15.0; } }
  part w2 : H { part :>> p { attribute :>> b; attribute :>> b; } }
}`);
      const m = st().model;
      const w2Nested = m.children(byName('w2').id).find((c) => c.eClass === 'PartUsage')!;
      const second = m.children(w2Nested.id).filter((c) => c.eClass === 'AttributeUsage')[1]!;
      // The steps of the property soak: a redefinition drawn to H's `x`, w1 deleted, P's `b` renamed `p`, H1 specialising P, w2's part typed H.
      m.update(m.children(second.id).find((c) => c.eClass === 'Redefinition')!.id, { target: [m.children(byName('H').id).find((c) => c.declaredName === 'x')!.id] });
      m.remove(byName('w1').id);
      m.update(m.children(byName('P').id).filter((c) => c.eClass === 'AttributeUsage')[1]!.id, { declaredName: 'p' });
      m.update(m.relationshipsFrom(byName('H1').id).find((r) => r.eClass === 'Subclassification')!.id, { target: [byName('P').id] });
      st().bindType(w2Nested.id, 'H');
      expect(targets(st().model)).toEqual(targets(reopened(st().model)));
    });

    // A redefinition pointed by the SDK at a feature no name in its scope reaches (one in a nested unnamed part, whose path goes
    // by the effective name of the part) cannot be read back: the file Save writes has none, so the page has none either.
    it('a redefinition retargeted to a feature of a nested unnamed part is dropped, as the saved file has none', () => {
      load(`package G {
  part def H { part p; part r; }
  part w1 : H { part :>> p { part p1; } }
  part w0 : H { part :>> r; }
}`);
      const m = st().model;
      const nested = m.children(byName('w0').id).find((c) => c.eClass === 'PartUsage')!;
      const edge = m.children(nested.id).find((c) => c.eClass === 'Redefinition')!;
      m.update(edge.id, { target: [byName('p1').id] });
      expect(targets(st().model)).toEqual(targets(reopened(st().model)));
      expect(targets(st().model).filter((t) => t.startsWith('G::w0::'))).toEqual([]);
    });

    // The path the text writes is dropped only where it steps through the unnamed part: a redefinition inside an unnamed
    // part that reaches a named usage below it by a path that starts below the unnamed part keeps its target.
    it('a retarget by a path that starts below an unnamed part keeps its redefinition', () => {
      load(`package G {
  part def H { part p; part t; }
  part w1 : H { part :>> p { part q { part s; } part :>> t; } }
}`);
      const m = st().model;
      const unnamed = m.children(byName('w1').id).find((c) => c.eClass === 'PartUsage')!;
      const edge = m.children(m.children(unnamed.id).find((c) => c.eClass === 'PartUsage' && c.declaredName === undefined)!.id).find((c) => c.eClass === 'Redefinition')!;
      m.update(edge.id, { target: [byName('s').id] });
      expect(targets(st().model)).toEqual(targets(reopened(st().model)));
      expect(targets(st().model).some((t) => t.endsWith('::q#0:s'))).toBe(true);
    });

    // A few hundred random edit sequences over small random redefinition models (the generator of the review's
    // differential: definitions that specialise one or two earlier, with unnamed and renamed redefinitions and a
    // merged `:>> a, b`; usages that redefine what they inherit). After EACH command the page's redefinitions are
    // those of the file it saves, and the command is one undo step that Undo and Redo walk exactly.
    describe('random edit sequences (property)', () => {
      /** A seeded generator (mulberry32). */
      const seeded = (seed: number): (() => number) => {
        let a = seed >>> 0;
        return () => {
          a = (a + 0x6d2b79f5) >>> 0;
          let t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      };
      const NAMES = ['M2', 'N2', 'K2', 'X'];
      /**
       * `bind` draws the bindings (`attribute Zb = 1.0; bind Zb = M;`) from a stream of their own, so the models the
       * other draws make are the ones they always were: a usage-body one makes the usage an implicit end copy of `M`,
       * and a definition-level one (`attribute Zd1; bind Zd1 = M;` in a part def) gives the definition a copy that every
       * usage of it, and every `:>>` the page re-resolves, has to leave aside.
       */
      function randomModel(rnd: () => number, bind?: () => number): string {
        const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
        const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
        let value = 10;
        const v = (): string => `${++value}.0`;
        const defs: Array<{ name: string; generals: string[]; features: string[] }> = [
          { name: 'Q0', generals: [], features: [`attribute M default = ${v()};`, `attribute N default = ${v()};`] },
        ];
        const visible: Record<string, Set<string>> = { Q0: new Set(['M', 'N']) };
        if (rnd() < 0.5) {
          defs.push({ name: 'T0', generals: [], features: [`attribute K default = ${v()};`] });
          visible.T0 = new Set(['K']);
        }
        const unionOf = (names: string[]): Set<string> => new Set(names.flatMap((g) => [...visible[g]!]));
        for (let i = 1, n = int(2, 5); i <= n; i++) {
          const name = `D${i}`;
          const earlier = defs.map((d) => d.name);
          const generals = [...earlier].sort(() => rnd() - 0.5).slice(0, rnd() < 0.6 ? 1 : 2);
          let seen = unionOf(generals);
          const used = new Set<string>();
          const features: string[] = [];
          for (let k = int(0, 2); k > 0; k--) {
            const choices = [...seen].filter((x) => !used.has(x)).sort();
            if (choices.length === 0) break;
            const x = pick(choices);
            const r = rnd();
            const fresh = NAMES.filter((y) => !seen.has(y) && !used.has(y));
            if (r < 0.55) {
              features.push(`attribute :>> ${x} default = ${v()};`);
              used.add(x);
            } else if (r < 0.8 && fresh.length > 0) {
              const y = pick(fresh);
              features.push(`attribute ${y} redefines ${x} default = ${v()};`);
              used.add(x).add(y);
              seen = new Set([...seen, y]);
            } else if (r < 0.9 && choices.length >= 2 && fresh.length > 0) {
              const [a, b] = [...choices].sort(() => rnd() - 0.5);
              const y = pick(fresh);
              features.push(`attribute ${y} :>> ${a}, ${b} default = ${v()};`);
              used.add(a!).add(b!).add(y);
              seen = new Set([...seen, y]);
            } else if (fresh.length > 0) {
              const y = pick(fresh);
              features.push(`attribute ${y} default = ${v()};`);
              used.add(y);
              seen = new Set([...seen, y]);
            }
          }
          if (bind !== undefined && bind() < 0.5) {
            const free = [...seen].filter((x) => !used.has(x)).sort();
            if (free.length > 0) features.push(`attribute Zd${i}; bind Zd${i} = ${free[Math.floor(bind() * free.length)]!};`);
          }
          visible[name] = seen;
          defs.push({ name, generals, features });
        }
        const usages: Array<{ name: string; generals: string[]; features: string[] }> = [];
        for (let j = 0, n = int(1, 3); j < n; j++) {
          const generals = defs.map((d) => d.name).sort(() => rnd() - 0.5).slice(0, rnd() < 0.7 ? 1 : 2);
          const seen = unionOf(generals);
          const used = new Set<string>();
          const features: string[] = [];
          for (let k = int(1, 3); k > 0; k--) {
            const choices = [...seen].filter((x) => !used.has(x)).sort();
            if (choices.length === 0) break;
            const x = pick(choices);
            const r = rnd();
            if (r < 0.35) features.push(`attribute :>> ${x};`);
            else if (r < 0.8) features.push(`attribute :>> ${x} = ${v()};`);
            else features.push(`attribute Z${k} = ${v()};`);
            used.add(x);
          }
          if (bind !== undefined && bind() < 0.6) {
            const free = [...seen].filter((x) => !used.has(x)).sort();
            if (free.length > 0) features.push(`attribute Zb = 1.0; bind Zb = ${free[Math.floor(bind() * free.length)]!};`);
          }
          usages.push({ name: `u${j}`, generals, features });
        }
        const decl = (kw: string, op: string, d: { name: string; generals: string[]; features: string[] }): string =>
          `  ${kw} ${d.name}${d.generals.length > 0 ? ` ${op} ${d.generals.join(', ')}` : ''} { ${d.features.join(' ')} }`;
        return [
          'package G {',
          ...defs.map((d) => decl('part def', ':>', d)),
          ...usages.map((u) => decl('part', ':', u)),
          '}',
        ].join('\n');
      }

      it('300 sequences of 4 commands: after each, the page holds the redefinitions its saved file holds', () => {
        // SYSPROSE_RT_SEQUENCES / _STEPS / _FIRST widen the search for a soak; the defaults are the gate's.
        const SEQUENCES = Number(process.env.SYSPROSE_RT_SEQUENCES ?? 300);
        const STEPS = Number(process.env.SYSPROSE_RT_STEPS ?? 4);
        const FIRST = Number(process.env.SYSPROSE_RT_FIRST ?? 0);
        const failures: string[] = [];
        let handChecks = 0;
        let deletes = 0;
        for (let seq = FIRST; seq < FIRST + SEQUENCES && failures.length < 3; seq++) {
          const rnd = seeded(seq * 7919 + 13);
          const pick = <T,>(xs: readonly T[]): T | undefined => xs[Math.floor(rnd() * xs.length)];
          let text = randomModel(rnd, seeded(seq * 104729 + 31));
          load(text);
          // A binding the file does not read back onto the copy the page made at the load (two bindings that name one copy
          // by different names, the file writes one of them) is a limit of the text, not of the edit: the sequence runs on
          // the model without the bindings.
          if (copiesApart(st().model, reopened(st().model)).length > 0) {
            text = randomModel(seeded(seq * 7919 + 13));
            load(text);
          }
          // A full settle of the model as the file made it moves no redefinition: the page starts from the file's.
          const fresh = settleRedefinitions(
            st().model,
            st().model.all().filter((e) => e.attrs.isLibrary !== true && !isRelationship(e.eClass)).map((e) => e.id),
          );
          if (fresh > 0) failures.push(`sequence ${seq}: a full settle of the freshly loaded model moved ${fresh} redefinition(s)\n${text}`);
          if (fresh > 0) continue;
          const log: string[] = [];
          for (let step = 0; step < STEPS; step++) {
            const m = st().model;
            const user = m.all().filter((e) => e.attrs.isLibrary !== true && e.attrs.implicit !== true);
            const defs = user.filter((e) => e.eClass === 'PartDefinition');
            const usages = user.filter((e) => e.eClass === 'PartUsage');
            const features = user.filter((e) => e.eClass === 'AttributeUsage');
            const typings = user.filter((e) => e.eClass === 'FeatureTyping' || e.eClass === 'Subclassification' || e.eClass === 'Specialization');
            const owners = [...defs, ...usages];
            const before = targets(m);
            const undos = st().undoStack.length;
            const kind = Math.floor(rnd() * 12);
            let did = '';
            let handText: string | null = null;
            let watchedSources: string[] = [];
            if (kind === 0 && usages.length > 0) {
              const u = pick(usages)!;
              const d = pick(defs)!;
              did = `bindType ${u.declaredName} ${d.declaredName}`;
              st().bindType(u.id, d.declaredName!);
            } else if (kind === 1 && typings.length > 0) {
              const t = pick(typings)!;
              // Not to a type that specialises the relationship's own source: a cycle of generals is a model error.
              const reaches = (from: string, to: string, seen = new Set<string>()): boolean =>
                from === to || (!seen.has(from) && (seen.add(from), m.typesOf(from).some((g) => reaches(g.id, to, seen))));
              const d = pick(defs.filter((x) => !reaches(x.id, t.source![0]!)));
              if (d === undefined) continue;
              did = `retarget ${place(m, t.id)} to ${d.declaredName}`;
              st().updateElement(t.id, { target: [d.id] });
            } else if (kind === 2 && typings.length > 0) {
              const t = pick(typings)!;
              did = `delete ${t.eClass} ${place(m, t.id)}`;
              st().deleteElement(t.id);
            } else if (kind === 3 && features.length > 0) {
              const f = pick(features)!;
              did = `delete ${place(m, f.id)}`;
              // The saved text with the feature's own line cut out, as an author would cut it: where that line is the
              // only one of its kind and nothing else in the text names the feature.
              const saved = serializeModel(m);
              const line = serializeElement(m, f.id, 0).trim();
              watchedSources = m
                .relationshipsTo(f.id)
                .filter((r) => r.eClass === 'Redefinition' && r.attrs.implicit !== true)
                .flatMap((r) => r.source ?? []);
              if (line !== '' && !line.includes('\n') && saved.split(`\n`).filter((l) => l.trim() === line).length === 1) {
                const withoutIt = saved.split('\n').filter((l) => l.trim() !== line).join('\n');
                if (f.declaredName === undefined || !new RegExp(`\\b${f.declaredName}\\b`).test(withoutIt)) handText = withoutIt;
              }
              deletes++;
              st().deleteElement(f.id);
            } else if (kind === 4 && features.length > 0 && owners.length > 0) {
              const f = pick(features)!;
              const o = pick(owners.filter((x) => x.id !== f.ownerId))!;
              did = `reparent ${place(m, f.id)} into ${o.declaredName}`;
              st().reparent(f.id, o.id);
            } else if (kind === 5 && features.length > 1 && owners.length > 0) {
              const fs = [...features].sort(() => rnd() - 0.5).slice(0, 2);
              const o = pick(owners)!;
              did = `reparentMany ${fs.map((f) => place(m, f.id)).join(' ')} into ${o.declaredName}`;
              st().reparentMany(fs.map((f) => f.id), o.id);
            } else if (kind === 6 && features.length > 0) {
              const f = pick(features)!;
              // A name some feature of the model bears already, most often: the collisions are there.
              const name = pick([...features.flatMap((x) => (x.declaredName === undefined ? [] : [x.declaredName])), 'M', 'N', 'K', ...NAMES])!;
              did = `rename ${place(m, f.id)} to ${name}`;
              st().updateElement(f.id, { declaredName: name });
            } else if (kind >= 10 && features.length > 0) {
              const f = pick(features)!;
              const name = pick([...features.flatMap((x) => (x.declaredName === undefined ? [] : [x.declaredName])), 'M', 'N', 'K', ...NAMES])!;
              did = `rename ${place(m, f.id)} to ${name}`;
              st().updateElement(f.id, { declaredName: name });
            } else if (kind === 7 && owners.length > 0) {
              const o = pick(owners)!;
              const name = pick([...features.flatMap((x) => (x.declaredName === undefined ? [] : [x.declaredName])), 'M', 'N', 'K', ...NAMES])!;
              did = `create ${name} in ${o.declaredName}`;
              st().createElement('AttributeUsage', o.id, name);
            } else if (kind === 8 && features.length > 0) {
              const f = pick(features)!;
              did = `duplicate ${place(m, f.id)}`;
              st().duplicateElement(f.id);
            } else if (kind === 9 && features.length > 0 && owners.length > 0) {
              const f = pick(features)!;
              const o = pick(owners)!;
              did = `paste ${place(m, f.id)} into ${o.declaredName}`;
              st().setSelection([f.id]);
              st().copySelection();
              st().pasteClipboard(o.id);
            }
            if (did === '') continue;
            log.push(did);
            const page = st().model;
            // Two features of one owner under one declared name cannot be told apart by any text that names them:
            // the saved file finds the first. Whatever follows is outside what a name can say. For an implicit end
            // copy the name is also the one an unnamed `:>> M` is known by (a feature renamed `M` beside it): the
            // mapper takes the first of the two there too.
            const bears = (c: ElementRecord): string | undefined =>
              c.declaredName ?? (copies(page).size > 0 ? effectiveNameOf(page, c) : undefined);
            if (page.all().some((e) => page.children(e.id).some((c, i, kids) => !isRelationship(c.eClass) && bears(c) !== undefined && kids.findIndex((o) => !isRelationship(o.eClass) && bears(o) === bears(c)) !== i))) break;
            const reread = reopened(page);
            // A copy the file does not make (its name is inherited by nothing now) stays where it was on the page, and
            // the page proves through it where the file reads an unresolved name: outside this oracle (TODO).
            const there = copies(reread);
            if ([...copies(page).keys()].some((k) => !there.has(k))) break;
            const after = targets(page);
            const file = targets(reread);
            const problems: string[] = [];
            if (after.join('\n') !== file.join('\n')) problems.push(`page ≠ file:\n${after.join('\n')}\n---\n${file.join('\n')}`);
            // The implicit end copies of the bindings too: the file makes them anew, on what their names find.
            const apart = copiesApart(page, reread);
            if (apart.length > 0) problems.push(`implicit end copies, page ≠ file:\n${apart.join('\n')}\nthe page's text:\n${serializeModel(page)}`);
            // The edit asked only what it could move (the lines its names are in): a full settle of the model finds
            // nothing left to move.
            const left = settleRedefinitions(
              page,
              page.all().filter((e) => e.attrs.isLibrary !== true && !isRelationship(e.eClass)).map((e) => e.id),
            );
            if (left > 0) problems.push(`a full settle of the page still moved ${left} redefinition(s)`);
            // And a delete lands the redefinitions that targeted the feature as the text without it reads them: not only
            // as the file this page saves does. Where a feature is known by a name of its own (`M2 redefines N`), a
            // sibling on its line may have kept a redefinition off a more specific feature that the delete frees: the
            // name the author wrote is not kept, and the TODO says so. Those models are outside this oracle.
            // An implicit end copy bears a name of its own whatever the text says, so only the redefinitions the text
            // writes are looked at: with them every model that has a binding would be outside the oracle.
            const nameKept = page.all().some((e) => {
              const source = e.eClass === 'Redefinition' && e.attrs.isLibrary !== true ? page.get((e.source ?? [])[0] ?? '') : undefined;
              return source !== undefined && source.attrs.implicit !== true && source.declaredName !== undefined;
            });
            if (handText !== null && !nameKept && parseModel(handText).diagnostics.length === 0) {
              const watched = watchedSources.map((id) => `${place(page, id)} -> `);
              const only = (xs: string[]): string => xs.filter((x) => watched.some((w) => x.startsWith(w))).join('\n');
              const hand = only(targets(parseModel(handText).model));
              if (watched.length > 0) handChecks++;
              if (hand !== only(after)) {
                problems.push(`page ≠ the text without it:\n${only(after)}\n---\n${hand}\nthe text without it:\n${handText}\nthe page's:\n${serializeModel(page)}`);
              }
            }
            if (st().undoStack.length > undos + 1) problems.push('more than one undo step');
            if (st().undoStack.length === undos + 1) {
              st().undo();
              if (targets(st().model).join('\n') !== before.join('\n')) problems.push('undo');
              st().redo();
              if (targets(st().model).join('\n') !== after.join('\n')) problems.push('redo');
            }
            if (problems.length > 0) {
              failures.push(`sequence ${seq} step ${step}: ${log.join(' ; ')}\n${text}\n${problems.join('\n')}`);
              break;
            }
          }
        }
        expect(failures).toEqual([]);
        // The second oracle ran: some deletes were compared with the text without the feature. How many a seed window
        // can compare is up to its models (most hold a named redefinition, which puts them outside it), so only the
        // gate's own window must have compared one; any other window must at least have drawn deletes.
        if (SEQUENCES >= 100) expect(deletes).toBeGreaterThan(0);
        if (FIRST === 0 && SEQUENCES === 300 && STEPS === 4) expect(handChecks).toBeGreaterThan(0);
      }, 600_000);
    });
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

  it('lists the same per-instance findings as the validator, and the generic row once (PI-5)', () => {
    // E's m1 shape: Q's p is read for Q's own instance (the generic row) and for each q's. The validator
    // reported the generic row a second time as a target-by-specialisation; the app never did.
    const model = parseModel(
      [
        'package H {',
        '  part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }',
        '  part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }',
        '  part q1 : Q { attribute :>> L = 50.0; }',
        '  part q2 : Q { attribute :>> L = 5.0; }',
        '}',
      ].join('\n'),
    ).model;
    useAppStore.setState({ model });
    st().runConstraintCheck();
    const cli = validationApi.validate(model).filter((d) => d.ruleId === 'constraint-by-instance' || d.ruleId === 'target-by-specialisation');
    expect(cli.filter((d) => d.ruleId === 'target-by-specialisation')).toEqual([]);
    const app = st().diagnostics.filter((d) => d.ruleId === 'constraint-check' && (d.instance !== undefined || d.instances !== undefined));
    const texts = (rows: Array<{ severity: string; message: string }>) => rows.map((d) => `${d.severity}: ${d.message}`).sort();
    expect(texts(app)).toEqual(texts(cli));
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
 * Per-instance presentation (F6): the Check re-anchors a context row that sits
 * on an implicit element (the anchor rule, H6a) — never leaving a row with no
 * source span to point at; the Solve words a context row `… in <context>` —
 * never "(at the boundary)" — and folds rows a binding reads once per instance
 * so a model with thousands of instance paths stays a short Problems list.
 */
describe('store — per-instance Check and Solve rows (F6)', () => {
  beforeEach(() => {
    useAppStore.setState({ model: new Model(), undoStack: [], redoStack: [], diagnostics: [] });
  });
  const load = (src: string): void => {
    useAppStore.setState({ model: parseModel(src).model, undoStack: [], redoStack: [], diagnostics: [] });
  };

  it('re-anchors an instance row that sits on an implicit element by the anchor rule (F7)', () => {
    // P's `c` read in Q's `p` is a shared-usage group: the generic row and the
    // violated instance `q::p`. The violated row's feature is the implicit
    // `Q::p::load`; the Check points instead at the line that makes q's p
    // differ (PI-2): q's `:>> L = 50.0`, which Q's binding carries into it.
    load(`package H2P {
    part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; constraint c { load <= 10.0 } }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
    part q : Q { attribute :>> L = 50.0; }
}`);
    st().runConstraintCheck();
    const rows = st().diagnostics.filter((d) => d.ruleId === 'constraint-check');
    // The relation's own row is unchanged.
    expect(rows.some((d) => d.message.startsWith('Constraint satisfied: load <= 10.0'))).toBe(true);
    // The violated instance row is not left on the implicit connector-end copy.
    const instanceRow = rows.find((d) => /constraint-check#\d+\.r\d+/.test(d.id) && d.instance === 'H2P::q::p');
    expect(instanceRow).toBeDefined();
    expect(instanceRow!.elementId).toBeDefined();
    expect(st().model.get(instanceRow!.elementId!)?.attrs.implicit).not.toBe(true);
    // The re-anchored element is q's redefinition, not the implicit end nor the shared usage Q::p.
    const anchor = st().model.get(instanceRow!.elementId!)!;
    expect(anchor.eClass).toBe('AttributeUsage');
    expect([st().model.qualifiedName(anchor.ownerId!), anchor.attrs.value]).toEqual(['H2P::q', 50]);
  });

  it('lists the violation of a usage-owned relation’s one other instance (PI-1)', () => {
    // q1's p is the only instance of Q::p besides Q's own (the relation's own
    // row): a group of one, which the Check listed nothing for.
    load(`package R17 {
    part def P { attribute load : ScalarValues::Real default = 1.0; }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P { constraint c2 { load <= 10.0 } } bind p.load = L; }
    part q1 : Q { attribute :>> L = 50.0; }
}`);
    st().runConstraintCheck();
    const rows = st().diagnostics.filter((d) => d.ruleId === 'constraint-check' && /\.r\d+$/.test(d.id));
    expect(rows.map((d) => [d.severity, d.instance, d.relation, d.instances])).toEqual([
      ['warning', 'R17::q1::p', 'R17::Q::p::c2', undefined],
    ]);
    // At q1's redefinition `:>> L = 50.0` (PI-2), not the shared usage Q::p.
    const anchor = st().model.get(rows[0]!.elementId!)!;
    expect([anchor.eClass, st().model.qualifiedName(anchor.ownerId!), anchor.attrs.value]).toEqual(['AttributeUsage', 'R17::q1', 50]);
  });

  it('words a context row `violated … in <context>`, with the relation as its anchor and no amount', () => {
    load(`package CV {
    part def P { attribute load : ScalarValues::Real default = 1.0; constraint c { load <= 10.0 } }
    part p1 : P { attribute :>> load = 50.0; }
    part p2 : P { attribute :>> load = 70.0; }
}`);
    st().solveParametric();
    const rows = st().diagnostics.filter((d) => d.id.startsWith('solve#viol#'));
    expect(rows.map((d) => d.message).sort()).toEqual([
      'violated inequality: load <= 10.0 in CV::p1',
      'violated inequality: load <= 10.0 in CV::p2',
    ]);
    for (const r of rows) {
      expect(r.message).not.toContain('(at the boundary)');
      expect(r.message).not.toMatch(/\(by /);
      expect(r.elementId).toBeDefined();
      expect(st().model.get(r.elementId!)?.attrs.implicit).not.toBe(true);
    }
  });

  it('names the producer each Problems row came from — Check rows `check`, Solve rows `solve` (H6b)', () => {
    load(`package HB {
    part def P { attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 - load; }
    part def Q { attribute L : ScalarValues::Real default = 1.0; part p : P; bind p.load = L; }
    part q : Q { attribute :>> L = 50.0; }
    constraint m2NegT { q.p.m2 <= 0.0 }
}`);
    st().runConstraintCheck();
    const checks = st().diagnostics.filter((d) => d.ruleId === 'constraint-check');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((d) => d.producer === 'check')).toBe(true);
    st().solveParametric();
    const solves = st().diagnostics.filter((d) => d.ruleId === 'solve');
    expect(solves.length).toBeGreaterThan(0);
    expect(solves.every((d) => d.producer === 'solve')).toBe(true);
  });

  it('folds thousands of instance rows into a bounded Solve view', () => {
    const levels: string[] = [
      'part def N0 { attribute x : ScalarValues::Real; assert constraint lo { x >= 0.0 } assert constraint hi { x <= 10.0 } attribute s : ScalarValues::Real = x; }',
    ];
    for (let i = 1; i <= 9; i++) {
      levels.push(`part def N${i} { part a : N${i - 1}; part b : N${i - 1}; attribute s : ScalarValues::Real = a.s + b.s; }`);
    }
    load(`package Perf9 {\n${levels.join('\n')}\npart top : N9; constraint cT { top.s <= 5120.0 }\n}`);
    st().solveParametric();
    const rows = st().diagnostics.filter((d) => d.ruleId === 'solve');
    // 1024 leaves each leave `x` and `s` free, and every level's `s` too: the
    // fold caps this at one row per feature, far below the unbounded ~4,600.
    expect(rows.length).toBeLessThanOrEqual(200);
    const foldedFree = rows.find((d) => d.id.startsWith('solve#free#') && d.message.includes('instances'));
    expect(foldedFree).toBeDefined();
    expect(foldedFree!.message).toMatch(/\d+ instances/);
  });

  // A-H2 (O2 S5): perf9b's Solve listed 1,568 rows, 1,533 of them one unjudged
  // instance each — every instance's A.9 sentence names that instance and its
  // own member paths, and the fold keyed on the sentence. It keys on the cause
  // (defaults-differ here) now, as C.2 folds per (relation, result, reason).
  it('folds the unjudged instance rows of one relation by their cause, each row in its own words', () => {
    const levels = (top: string, depth: number) => {
      const out = [
        'part def N0 { attribute x : ScalarValues::Real default = 1.0; assert constraint lo { x >= 0.0 } constraint hi { x <= 10.0 } }',
        'part def N1 { attribute L : ScalarValues::Real default = 2.0; part a : N0; part b : N0; bind a.x = L; }',
      ];
      for (let i = 2; i <= depth; i++) out.push(`part def N${i} { part a : N${i - 1}; part b : N${i - 1}; }`);
      return `package F {\n${out.join('\n')}\n${top}\n}`;
    };
    const unjudged = (expr: string) =>
      st().diagnostics.filter((d) => d.id.startsWith('solve#unknown#') && d.message.startsWith(`unjudged inequality: ${expr} in `));
    // Ten unjudged instances of each relation (a's x, whose default and L's differ, everywhere but top's a's a's).
    load(levels('part top : N3 { part :>> a { part :>> a { attribute :>> L = 50.0; } } }', 3));
    st().solveParametric();
    for (const expr of ['x >= 0.0', 'x <= 10.0']) {
      const rows = unjudged(expr);
      expect(rows.map((d) => d.message.replace(/ — .*/, ''))).toEqual([
        `unjudged inequality: ${expr} in F::N1::a, F::N2::a::a, F::N2::b::a, F::N3::a::a::a, F::N3::b::a::a, … and 5 more (10 contexts)`,
      ]);
      // The folded row's sentence is its first context's.
      expect(rows[0]!.message).toContain(' — x has no value in F::N1::a: `bind a.x = L` of F::N1 joins defaults that differ');
    }
    // Five or fewer are listed one by one, each with the sentence of the instance it names.
    load(levels('part top : N2 { part :>> a { attribute :>> L = 50.0; } }', 2));
    st().solveParametric();
    const rows = unjudged('x <= 10.0');
    expect(rows.map((d) => /^unjudged inequality: x <= 10\.0 in (\S+) — x has no value in (\S+):/.exec(d.message)!.slice(1))).toEqual([
      ['F::N1::a', 'F::N1::a'],
      ['F::N2::a::a', 'F::N2::a::a'],
      ['F::N2::b::a', 'F::N2::b::a'],
      ['F::top::b::a', 'F::top::b::a'],
    ]);
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

  /**
   * Review 2026-10-14, D-3: on the drone-swarm model one task of 0.2 to 0.4 s validated
   * the model and wrote its text after every edit. A recompute that has run 40 ms now lets
   * the page draw and goes on in the next task — validation a rule at a time, then the text,
   * then the results in one step — and is pending until it ends. A clock that runs 100 ms
   * a read makes every step end a task, as a large model does.
   */
  describe('a recompute over a large model, in tasks', () => {
    let clock = 0;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
    });
    afterEach(() => {
      vi.restoreAllMocks();
      // The clock above left the last recompute's time at seconds, and with it the next tests' quiet period and cap.
      st().createElement('PartDefinition', null, 'Reset');
      flushRecompute();
      vi.useRealTimers();
    });
    /** Run the timers until nothing is waiting, counting the tasks the recompute took after its first. */
    function runToTheEnd(): number {
      let tasks = 0;
      while (recomputePending() && tasks < 500) {
        vi.advanceTimersToNextTimer();
        tasks++;
      }
      return tasks;
    }

    it('validateSteps yields once for each rule and returns what validate returns, with the rule filters', () => {
      const m = new Model();
      const p = m.create('PartDefinition', { declaredName: 'P' });
      m.create('PartDefinition', { declaredName: 'P' }); // a duplicate name
      m.create('PartUsage', { declaredName: ' ', ownerId: p.id }); // a blank one
      expect(validationApi.validate(m).length, 'the model has findings to compare').toBeGreaterThan(0);
      for (const opts of [{}, { ruleIds: ['duplicate-name', 'blank-name'] }, { excludeRuleIds: ['duplicate-name'] }]) {
        const steps = validationApi.validateSteps(m, opts);
        let yielded = 0;
        let step = steps.next();
        while (!step.done) {
          yielded++;
          step = steps.next();
        }
        const ran = validationApi.RULES.filter(
          (r) => (opts.ruleIds === undefined || opts.ruleIds.includes(r.id)) && !(opts.excludeRuleIds ?? []).includes(r.id),
        ).length;
        expect(yielded).toBe(ran);
        expect(step.value).toEqual(validationApi.validate(m, opts));
      }
    });

    it('is pending between its tasks, shows nothing of the edit until its last, and then shows what validate and the text say', () => {
      st().createElement('PartDefinition', null, 'Sliced');
      expect(recomputePending()).toBe(true);
      vi.advanceTimersToNextTimer(); // the quiet period ends: the first task
      expect(recomputePending(), 'one task did not do it all').toBe(true);
      expect(st().textBuffer, 'the edit is not shown yet').not.toContain('Sliced');
      const tasks = runToTheEnd();
      expect(tasks, 'a task for each rule, and more').toBeGreaterThan(validationApi.RULES.length);
      expect(recomputePending()).toBe(false);
      expect(st().textBuffer).toContain('part def Sliced');
      expect(st().diagnostics).toEqual(validationApi.validate(st().model));
      expect(st().textDirty).toBe(false);
    });

    it('is ended by an edit, which makes the next recompute of the model as it is', () => {
      st().createElement('PartDefinition', null, 'First');
      vi.advanceTimersToNextTimer();
      vi.advanceTimersToNextTimer();
      expect(recomputePending()).toBe(true);
      st().createElement('PartDefinition', null, 'Second');
      runToTheEnd();
      expect(st().textBuffer).toContain('part def First');
      expect(st().textBuffer).toContain('part def Second');
      expect(st().diagnostics).toEqual(validationApi.validate(st().model));
    });

    it('gives the text and the results a task each once its task has run 10 ms, though under 40', () => {
      vi.mocked(performance.now).mockImplementation(() => (clock += 1)); // 27 rules: 27 ms
      const write = textApi.serializeUserModelSignals;
      vi.spyOn(textApi, 'serializeUserModelSignals').mockImplementation((...args) => {
        clock += 20; // the text: 20 ms
        return write(...args);
      });
      st().createElement('PartDefinition', null, 'Cut');
      vi.advanceTimersToNextTimer(); // the quiet period ends: the rules
      expect(recomputePending(), 'the rules did not take the text and the results with them').toBe(true);
      expect(st().textBuffer).not.toContain('Cut');
      expect(runToTheEnd(), 'the text, then the results').toBe(2);
      expect(st().textBuffer).toContain('part def Cut');
    });

    it('is not starved by edits made between its tasks: the recompute due at the burst’s deadline is one task, and edits cannot end it', () => {
      let edits = 0;
      st().createElement('PartDefinition', null, `Burst${edits++}`);
      for (let n = 0; recomputePending() && n < 200; n++) {
        vi.advanceTimersToNextTimer();
        if (n % 2 === 1 && recomputePending()) st().createElement('PartDefinition', null, `Burst${edits++}`);
      }
      expect(recomputePending(), 'a recompute ended').toBe(false);
      expect(edits, 'by the cap, with edits still arriving').toBeLessThan(20);
      expect(st().textBuffer).toContain(`part def Burst${edits - 1}`);
      expect(st().diagnostics).toEqual(validationApi.validate(st().model));
    });

    it('is finished by flushRecompute in the task that calls it, with the force flag the edit gave it', () => {
      useAppStore.setState({ textBuffer: 'typed, not applied', textDirty: true });
      st().createElement('PartDefinition', null, 'Flushed');
      vi.advanceTimersToNextTimer();
      expect(recomputePending()).toBe(true);
      expect(forcedRecomputePending(), 'a local edit forced it').toBe(true);
      flushRecompute();
      expect(recomputePending()).toBe(false);
      expect(st().textBuffer).toContain('part def Flushed');
      expect(st().textDirty).toBe(false);
    });

    it('leaves the text typed while it runs as it is, and its results do not replace the buffer', () => {
      st().createElement('PartDefinition', null, 'Peer');
      vi.advanceTimersToNextTimer();
      expect(recomputePending()).toBe(true);
      st().setTextBuffer('typed meanwhile');
      expect(forcedRecomputePending(), 'the keystrokes downgraded it').toBe(false);
      runToTheEnd();
      expect(st().textBuffer).toBe('typed meanwhile');
      expect(st().textDirty).toBe(true);
      expect(st().diagnostics).toEqual(validationApi.validate(st().model));
    });
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
  function spyAction<K extends 'applyText' | 'exportModel' | 'importModel' | 'saveProject'>(name: K) {
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

    it('Save keeps the boxes moved by hand with the copy in this browser — the file gets the text alone', async () => {
      const id = await attached();
      edit('Relay');
      useAppStore.setState({ activeView: 'general', diagramRootId: null, diagramPins: {} });
      await st().rebuildDiagram();
      const relay = st().model.all().find((e) => e.declaredName === 'Relay')!.id;
      st().pinNodePositions(new Map([[relay, { x: 640, y: 480 }]]));
      await runSave();
      expect(driveDirty(st())).toBe(false);
      expect(gateway.textOf(id)).toBe(withFinalNewline(st().textBuffer));
      expect(gateway.textOf(id)).not.toMatch(/640|480/);
      const kept = await new LocalStorageStore().loadProject('Swarm');
      expect(kept?.meta?.diagramPins).toEqual({ 'general|': { [relay]: { x: 640, y: 480 } } });
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

  /**
   * Typed text applied over a field's change (the field-change block below, `fieldOverTyped`): a save to
   * Google Drive applies it as the browser save does, and said nothing. It says so in the strip, after
   * the save's own notice, in every route that applies the text; the guard's Save, whose command replaces
   * the model next, does not promise one Undo.
   */
  describe('a save that applies typed text over a field’s change says so', () => {
    /** A part def made after the text was written is not in the typed text; the text typed over it, then a field's change: the text stays over the change. */
    async function typedOverChange(): Promise<string> {
      edit('Relay');
      const relay = st().model.all().find((e) => e.declaredName === 'Relay')!.id;
      st().setTextBuffer(st().textBuffer.replace('part def Relay;', 'part def Other;'));
      st().updateElement(relay, { declaredName: 'Kite' });
      flushRecompute();
      expect(st().textBuffer, 'the text stays over the change').toContain('part def Other;');
      expect(st().textDirty).toBe(true);
      return relay;
    }
    const note = (message: string) => ({ kind: 'info', message, retryable: false });
    const named = (name: string) => st().model.all().some((e) => e.declaredName === name);

    it('Save (Ctrl/Cmd+S) with the file unsaved: the file holds the text, the strip says it won, one Undo brings the change back', async () => {
      const id = await attached();
      await typedOverChange();
      await runSave();
      expect(gateway.textOf(id)).toContain('part def Other;');
      expect(named('Kite')).toBe(false);
      expect(drive().notice).toEqual(note(DRIVE_MESSAGES.typedTextAppliedOverChanges));
      st().undo();
      expect(named('Kite'), 'Undo brings the change back, as the note says').toBe(true);
      // The next save that holds the model takes the note down.
      await runSave();
      expect(drive().notice).toBeNull();
    });

    it('Save to Drive from the strip or the menu (the upload applies the text) says so too', async () => {
      const id = await attached();
      await typedOverChange();
      await st().driveSave();
      expect(gateway.textOf(id)).toContain('part def Other;');
      expect(drive().notice).toEqual(note(DRIVE_MESSAGES.typedTextAppliedOverChanges));
    });

    it('Save to Drive as… says so too', async () => {
      await attached();
      await typedOverChange();
      await st().driveSaveAs('Copy');
      expect(drive().notice).toEqual(note(DRIVE_MESSAGES.typedTextAppliedOverChanges));
    });

    it('keeps the save’s own notice, and adds the sentence to it', async () => {
      await attached();
      await typedOverChange();
      useAppStore.setState((s) => ({ drive: { ...s.drive, online: false } }));
      await runSave();
      expect(drive().notice?.kind).toBe('error');
      expect(drive().notice?.message).toContain(DRIVE_MESSAGES.offline);
      expect(drive().notice?.message).toContain(DRIVE_MESSAGES.typedTextAppliedOverChanges);
    });

    it('says nothing when the text was typed over no field’s change', async () => {
      const id = await attached();
      st().setTextBuffer(SWARM.replace('Drone', 'Glider'));
      await runSave();
      expect(gateway.textOf(id)).toContain('part def Glider;');
      expect(drive().notice).toBeNull();
    });

    it('the guard’s Save with the file unsaved: the command goes on, and the strip says it takes two Undos', async () => {
      const id = await attached();
      await typedOverChange();
      const run = vi.fn(() => st().newProject('NewModel'));
      st().driveGuard('New', 'dirty', run);
      await st().driveRunPending('save');
      expect(gateway.textOf(id)).toContain('part def Other;');
      expect(run).toHaveBeenCalledTimes(1);
      // New let the file go and said so (`closed`); the sentence is added to that notice, not put over it.
      expect(drive().notice).toEqual(
        note(`${DRIVE_MESSAGES.closed('Swarm.sysml')} ${DRIVE_MESSAGES.typedTextSavedOverChangesThenReplaced('New')}`),
      );
      expect(DRIVE_MESSAGES.typedTextSavedOverChangesThenReplaced('New')).toContain('two Undos');
      st().undo();
      expect(named('Kite'), 'one Undo has not brought the change back').toBe(false);
      st().undo();
      expect(named('Kite'), 'the second has').toBe(true);
    });

    it('the guard’s Save before Join room says the plain sentence: joining pushes no undo step, one Undo brings the change back', async () => {
      await attached();
      await typedOverChange();
      const run = vi.fn();
      st().driveGuard('Join room', 'dirty', run);
      await st().driveRunPending('save');
      expect(run).toHaveBeenCalledTimes(1);
      expect(drive().notice?.message).toContain(DRIVE_MESSAGES.typedTextAppliedOverChanges);
      expect(drive().notice?.message).not.toContain('two Undos');
      st().undo();
      expect(named('Kite'), 'one Undo has').toBe(true);
    });

    it('the guard’s Save that does not go through (the upload fails) says the plain sentence and the command waits', async () => {
      await attached();
      await typedOverChange();
      const run = vi.fn();
      st().driveGuard('New', 'dirty', run);
      gateway.failNext(500, { op: 'get' });
      await st().driveRunPending('save');
      expect(run).not.toHaveBeenCalled();
      expect(drive().notice?.kind).toBe('error');
      expect(drive().notice?.message).toContain(DRIVE_MESSAGES.typedTextAppliedOverChanges);
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
      // A box moved by hand on the model it replaces: not the file's, and with no Undo to bring it back.
      useAppStore.setState({ diagramPins: { 'general|': { someBox: { x: 40, y: 60 } } } });
      const meta = gateway.seed({ name: 'Swarm.sysml', text: canonical });
      await st().driveOpen({ id: meta.id }, 'recent');
      expect(rootNames()).toEqual(['Swarm']);
      expect(st().undoStack).toEqual([]);
      expect(st().redoStack).toEqual([]);
      expect(st().diagramPins, 'a fresh layout, and Undo starts over: the old boxes are gone').toEqual({});
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
      expect(leaveBeforeUnload(st(), new Event('beforeunload', { cancelable: true }))).toBe(true);
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
      expect(leaveBeforeUnload(st(), new Event('beforeunload', { cancelable: true }))).toBe(true);
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

    it('the Check panel’s commands name a linked model by its URL’s file name, the Drive file first', async () => {
      const linkedModel = { url: 'https://example.org/models/views-tour.sysml', source: null, status: 'loaded' as const, projectName: 'Untitled' };
      expect(checkFileName({ drive: { file: null }, projectName: 'Untitled', linkedModel })).toBe('views-tour.sysml');
      expect(checkFileName({ drive: { file: null }, projectName: 'Untitled', linkedModel: { ...linkedModel, status: 'failed' } })).toBe('Untitled.sysml');
      expect(checkFileName({ drive: { file: { name: 'Fleet.sysml' } }, projectName: 'Untitled', linkedModel })).toBe('Fleet.sysml');
      // Another model replaced the linked one (New renames the project): its name, not the link's.
      useAppStore.setState({ linkedModel: { ...linkedModel, projectName: st().projectName } });
      expect(checkFileName(st())).toBe('views-tour.sysml');
      st().newProject('Other');
      expect(checkFileName(st())).toBe('Other.sysml');
    });

    it('asks before leaving while the attached file has unsaved changes, and not once it is saved', async () => {
      const leaving = () => new Event('beforeunload', { cancelable: true });
      let e = leaving();
      expect(leaveBeforeUnload(st(), e)).toBe(false);
      expect(e.defaultPrevented, 'no file, nothing edited').toBe(false);
      await attached();
      e = leaving();
      expect(leaveBeforeUnload(st(), e)).toBe(false);
      expect(e.defaultPrevented, 'saved').toBe(false);
      edit();
      e = leaving();
      expect(leaveBeforeUnload(st(), e)).toBe(true);
      expect(e.defaultPrevented, 'unsaved changes').toBe(true);
      await st().driveSave();
      expect(leaveBeforeUnload(st(), leaving()), 'saved to Drive').toBe(false);
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
    // The page's keydown listener, as `App` installs it: a key typed into the
    // Text view's editor reaches the app through it.
    beforeEach(() => window.addEventListener('keydown', handlePageKey));
    afterEach(() => window.removeEventListener('keydown', handlePageKey));

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

    it('Ctrl/Cmd+S and Ctrl/Cmd+Shift+S typed in the Text view’s editor save — Drive gets what was typed — and every other key stays the editor’s', async () => {
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
     * Undo and Redo keep the open project's name. They derived it from the
     * model's first package, so after a package renamed in the app, or an
     * Undo of an apply, the next Save wrote another project. The steps that
     * replace the model (New, Open, Import, an apply of text) give back the
     * name the project had before them, and their Redo the name after.
     */
    it('Undo and Redo keep the open project’s name: a package renamed in the app, an apply of text, New', async () => {
      await model();
      useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
      await st().saveProject('Fleet');
      const pkg = st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id;

      st().updateElement(pkg, { declaredName: 'Drone' });
      flushRecompute();
      st().undo();
      expect(st().projectName, 'Undo of a rename').toBe('Fleet');
      st().redo();
      expect(st().projectName, 'Redo of a rename').toBe('Fleet');
      st().undo();

      // An apply names the project after its package; its Undo gives the name back, its Redo the new one.
      st().setTextBuffer(SWARM.replace('Swarm', 'Applied'));
      st().applyText();
      expect(st().projectName).toBe('Applied');
      st().undo();
      expect(st().projectName, 'Undo of an apply').toBe('Fleet');
      st().redo();
      expect(st().projectName, 'Redo of an apply').toBe('Applied');
      st().undo();

      // A Save that applies typed text keeps the name, and an Undo of a step after it too.
      st().setTextBuffer(SWARM.replace('part def Drone;', 'part def Drone;\n    part def Typed;'));
      await commandById('tb-save')!.run();
      expect(st().projectName).toBe('Fleet');
      edit('Relay');
      st().undo();
      st().undo();
      expect(st().projectName, 'Undo of the apply a Save made').toBe('Fleet');
      st().redo();
      expect(st().projectName).toBe('Fleet');

      // New gives its name, and its Undo the project's before it.
      st().newProject('Other');
      expect(st().projectName).toBe('Other');
      st().undo();
      expect(st().projectName, 'Undo of New').toBe('Fleet');
      st().redo();
      expect(st().projectName, 'Redo of New').toBe('Other');
    });

    /**
     * A switch of branch (and a merge, which ends in one) names the project
     * after the first package of the branch it loads, as an apply does, so its
     * Undo gives the name back too. What is saved never holds a name: the
     * snapshot's name is the Undo stack's alone.
     */
    it('Undo and Redo of a switch of branch give back the name; a save after them holds no name', async () => {
      await model();
      useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
      await st().saveProject('Fleet');
      st().refreshVersions();
      st().commitVersion('first');
      const main = st().currentBranchId;
      st().createBranchCmd('side');
      const side = st().currentBranchId;
      const pkg = st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id;
      st().updateElement(pkg, { declaredName: 'Other' });
      flushRecompute();
      st().commitVersion('side work');
      st().switchBranch(main);
      expect(st().projectName, 'main holds the first package').toBe('Swarm');
      st().switchBranch(side);
      expect(st().projectName, 'side holds the renamed package').toBe('Other');

      st().undo();
      expect(st().projectName, 'Undo of the switch to side').toBe('Swarm');
      st().redo();
      expect(st().projectName, 'Redo of the switch to side').toBe('Other');
      st().undo();
      await st().saveProject('Fleet');
      const saved = await createDefaultStore({ dbName: LEGACY_STORAGE_DB }).loadProject('Fleet');
      expect(saved, 'saved').not.toBeNull();
      expect(saved?.meta?.projectName, 'the saved project holds no snapshot name').toBeUndefined();
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
        // A peer's edit since the typing is no field's change: the apply drops it, and says nothing of it.
        peer.create('PartDefinition', { declaredName: 'PeerLate', ownerId: peer.roots()[0].id });
        const run = vi.fn();
        st().driveGuard('New', 'dirty', run);
        expect(drive().prompt).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
        await st().driveRunPending('save');
        expect(sorted(saved.at(-1)!)).toEqual(['Drone', 'Guarded', 'Typed']);
        expect(drive().notice, 'a peer’s edit is not a field’s change').toBeNull();
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        st().disconnectCollab();
        peerDoc.destroy();
        restore();
      }
    });

    /**
     * Export ▾ → SysML writes the model's text, and text typed in the Text
     * view and not applied was not in it: the file lacked what was on screen,
     * and the guide said to press Apply first. The export applies it first
     * now, as Save does — one Undo step, as Apply's — and over a syntax error
     * writes the model as it stands and says so, as Save does. A save's note
     * and an export's each go with the next save, or export, that holds the
     * text: the other one's copy still lacks it. A newer note of either kind
     * replaces the older.
     */
    it('Export ▾ → SysML applies what was typed in the Text view first, as Save does — one Undo step — and over a syntax error writes the model as it stands and says so', async () => {
      const BROKEN = SWARM.replace('part def Drone;', 'part def Drone;\n    blok bad;');
      const { restore } = recordingSave();
      const exports = spyAction('exportModel');
      const exported = () => exports.spy.mock.results.at(-1)?.value as string | undefined;
      // jsdom makes no object URLs: the store logs that it could not download.
      const noDownload = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await model();
        useAppStore.setState((s) => ({ projectName: 'Fleet', drive: { ...s.drive, configStatus: 'absent' } }));
        const depth = st().undoStack.length;

        // Typed and not applied: the menu's export applies it, then writes it.
        st().setTextBuffer(`package Swarm {\n  part def   Drone;\n part def Glider;}`);
        const text = runExportSysml();
        expect(parts(), 'applied').toEqual(['Drone', 'Glider']);
        expect(text).toContain('    part def Glider;\n');
        expect(st().textDirty).toBe(false);
        expect(st().undoStack.length, 'one undo step, as Apply').toBe(depth + 1);
        expect(st().projectName, 'the file is named after the open project').toBe('Fleet');
        expect(drive().notice).toBeNull();
        await whenLibrarySettled();
        expect(text, 'the Text view’s text').toBe(st().textBuffer);
        st().undo();
        expect(parts(), 'one Undo takes the apply back').toEqual(['Drone']);

        // The command palette's export, the same.
        st().setTextBuffer(SWARM.replace('Drone', 'Kite'));
        await commandById('tb-export-sysml')!.run();
        expect(parts()).toEqual(['Kite']);
        expect(exported()).toContain('part def Kite;');

        // A syntax error: the model as it stands, nothing applied, and the strip says so.
        const before = st().undoStack.length;
        st().setTextBuffer(BROKEN);
        expect(runExportSysml()).toBe(exportModel(st().model, 'sysml'));
        expect(exported()).not.toContain('blok');
        expect(parts()).toEqual(['Kite']);
        expect(st().textDirty, 'still "not yet applied"').toBe(true);
        expect(st().textBuffer).toBe(BROKEN);
        expect(st().undoStack.length, 'nothing applied').toBe(before);
        const exportNote = { kind: 'info', message: DRIVE_MESSAGES.typedTextNotExported(3), retryable: false };
        expect(drive().notice).toEqual(exportNote);
        expect(drive().notice?.message).toBe(
          'Exported without the text typed in the Text view: it has a syntax error at line 3. Fix it, then export again.',
        );

        // Fixed, and saved: the browser holds it, the exported file still does not.
        st().setTextBuffer(SWARM.replace('Drone', 'Vane'));
        await commandById('tb-save')!.run();
        expect(parts()).toEqual(['Vane']);
        expect(drive().notice, 'the export’s note stays').toEqual(exportNote);
        runExportSysml();
        expect(exported()).toContain('part def Vane;');
        expect(drive().notice, 'an export that holds the text takes it down').toBeNull();

        // And the other way round: a save's note outlasts an export that holds the text.
        st().setTextBuffer(BROKEN);
        await commandById('tb-save')!.run();
        expect(drive().notice?.message).toBe(DRIVE_MESSAGES.typedTextKeptBack(3));
        st().setTextBuffer(SWARM.replace('Drone', 'Rotor'));
        runExportSysml();
        expect(parts()).toEqual(['Rotor']);
        expect(drive().notice?.message, 'the save’s note stays').toBe(DRIVE_MESSAGES.typedTextKeptBack(3));
        await commandById('tb-save')!.run();
        expect(drive().notice).toBeNull();

        // A newer note of either kind replaces the older: a save that keeps the text back says so over
        // an export's note, and an export that keeps it back over a save's.
        st().setTextBuffer(BROKEN);
        runExportSysml();
        expect(drive().notice).toEqual(exportNote);
        await commandById('tb-save')!.run();
        expect(drive().notice?.message, 'the save’s note over the export’s').toBe(DRIVE_MESSAGES.typedTextKeptBack(3));
        runExportSysml();
        expect(drive().notice?.message, 'the export’s note over the save’s').toBe(DRIVE_MESSAGES.typedTextNotExported(3));

        // A notice standing for another reason stays as it is.
        const refused = { kind: 'error' as const, message: DRIVE_MESSAGES.browserSaveFailed, retryable: false };
        useAppStore.setState((s) => ({ drive: { ...s.drive, notice: refused } }));
        st().setTextBuffer(BROKEN);
        runExportSysml();
        expect(drive().notice).toBe(refused);

        // ...but the file lacks the typed text all the same: the export's note
        // is held, and goes up once the strip is free.
        st().driveDismiss();
        expect(drive().notice, 'the held export note goes up when the strip is free').toEqual(exportNote);
        st().driveDismiss();
        expect(drive().notice).toBeNull();

        // A held note is about the model exported: replacing it forgets the note.
        useAppStore.setState((s) => ({ drive: { ...s.drive, notice: refused } }));
        st().setTextBuffer(BROKEN);
        runExportSysml();
        st().newProject('Fresh');
        st().driveDismiss();
        expect(drive().notice, 'New forgot the held note').toBeNull();

        // An export that holds the text in the meantime takes the held note down.
        useAppStore.setState((s) => ({ drive: { ...s.drive, notice: refused } }));
        runExportSysml();
        st().setTextBuffer(SWARM.replace('Drone', 'Fin'));
        runExportSysml();
        st().driveDismiss();
        expect(drive().notice, 'superseded: nothing to say').toBeNull();
      } finally {
        noDownload.mockRestore();
        exports.restore();
        restore();
      }
    });

    /**
     * The note that an element went to the top level of the model rather
     * than into the standard library stands until it is dismissed, and a save
     * or an export that kept typed text back while it stood said nothing: the
     * strip went on showing the library sentence, and the user took the copy
     * for one holding what they typed. Either says so over it now; one that
     * kept nothing back leaves it.
     */
    it('a save or an export that keeps typed text back says so over the library note — one that keeps nothing back leaves it', async () => {
      const BROKEN = SWARM.replace('part def Drone;', 'part def Drone;\n    blok bad;');
      const { saved, restore } = recordingSave();
      const noDownload = vi.spyOn(console, 'error').mockImplementation(() => {});
      await model();
      useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
      const shelf = st().model.create('Package', { declaredName: 'Shelf', attrs: { isLibrary: true } }).id;
      const libraryNote = { kind: 'info', message: DRIVE_MESSAGES.notIntoLibrary('new'), retryable: false };
      try {
        st().createElement('PartDefinition', shelf, 'Spare');
        expect(drive().notice).toEqual(libraryNote);
        await commandById('tb-save')!.run();
        expect(saved.at(-1)).toEqual(['Drone', 'Spare']);
        expect(drive().notice, 'nothing kept back: the note stays').toEqual(libraryNote);
        runExportSysml();
        expect(drive().notice).toEqual(libraryNote);

        // Export over a syntax error: the typed text is not in the file, and the strip says so over the note.
        st().setTextBuffer(BROKEN);
        expect(runExportSysml()).not.toContain('blok');
        expect(st().textDirty, 'still "not yet applied"').toBe(true);
        expect(drive().notice).toEqual({ kind: 'info', message: DRIVE_MESSAGES.typedTextNotExported(3), retryable: false });

        // The note again, then Save over a syntax error: the same.
        st().driveDismiss();
        st().createElement('PartDefinition', shelf, 'Rotor');
        flushRecompute();
        expect(drive().notice).toEqual(libraryNote);
        st().setTextBuffer(BROKEN);
        await commandById('tb-save')!.run();
        expect(saved.at(-1)).toEqual(['Drone', 'Spare', 'Rotor']);
        expect(st().textDirty, 'still "not yet applied"').toBe(true);
        expect(drive().notice).toEqual({ kind: 'info', message: DRIVE_MESSAGES.typedTextKeptBack(3), retryable: false });
      } finally {
        if (st().model.has(shelf)) st().model.remove(shelf);
        noDownload.mockRestore();
        restore();
      }
    });

    /**
     * In a collaboration room Export ▾ → SysML keeps typed text back, as Save
     * does: applying it would replace the room's model for every peer. The
     * file holds the model as it stands, and the strip says so.
     */
    it('in a collaboration room, Export ▾ → SysML keeps typed text back, as Save does, and says so', async () => {
      const noDownload = vi.spyOn(console, 'error').mockImplementation(() => {});
      await model();
      useAppStore.setState((s) => ({ drive: { ...s.drive, configStatus: 'absent' } }));
      st().connectCollab('export-room');
      try {
        const depth = st().undoStack.length;
        st().setTextBuffer(SWARM.replace('part def Drone;', 'part def Drone;\n    part def Typed;'));
        expect(runExportSysml()).not.toContain('Typed');
        expect(parts()).toEqual(['Drone']);
        expect(st().textDirty, 'still "not yet applied"').toBe(true);
        expect(st().undoStack.length, 'nothing applied').toBe(depth);
        expect(drive().notice).toEqual({
          kind: 'info',
          message: DRIVE_MESSAGES.typedTextNotExportedInRoom,
          retryable: false,
        });

        // Apply text → model puts it over the room's model; the export then holds it, and the note goes.
        st().applyText();
        expect(runExportSysml()).toContain('part def Typed;');
        expect(drive().notice).toBeNull();
      } finally {
        st().disconnectCollab();
        noDownload.mockRestore();
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

  it('counts a hand arrangement as unsaved work: New, Open and Import ask about it, Save and Open mark it, Undo back reads saved', async () => {
    const box = (x: number) => ({ 'general|': { [rootId()]: { x, y: 20 } } });
    expect(unsaved(), 'New').toBe(false);
    useAppStore.setState({ diagramPins: box(10) });
    expect(unsaved(), 'a box moved by hand, the text as saved').toBe(true);
    const run = vi.fn();
    st().driveGuard('New', 'dirty', run);
    expect(run, 'New asks').not.toHaveBeenCalled();
    expect(prompt()).toEqual({ kind: 'guard', label: 'New', variant: 'browser' });
    await st().driveRunPending('keep');

    await st().saveProject('Swarm');
    expect(unsaved(), 'Save marks the arrangement').toBe(false);
    useAppStore.setState({ diagramPins: box(30) });
    expect(unsaved(), 'moved again').toBe(true);
    useAppStore.setState({ diagramPins: box(10) });
    expect(unsaved(), 'moved back to where Save left it').toBe(false);
    useAppStore.setState({ diagramPins: {} });
    expect(unsaved(), 'auto-layout cleared the boxes Save held').toBe(true);

    await st().loadProject('Swarm');
    expect(st().diagramPins, 'Open brings the saved boxes').toEqual(box(10));
    expect(unsaved(), 'Open marks them').toBe(false);
    useAppStore.setState({ diagramPins: box(50) });
    st().newProject('Fresh');
    expect(unsaved(), 'New: nothing to lose').toBe(false);
    await whenLibrarySettled();
    expect(unsaved(), 'and still once its library merged').toBe(false);
  });

  it('asks before the tab closes over unsaved text or boxes, with no Drive file attached', async () => {
    const leaving = () => new Event('beforeunload', { cancelable: true });
    const asks = () => {
      const e = leaving();
      const asked = leaveBeforeUnload(st(), e);
      expect(e.defaultPrevented, 'prevented exactly when it asked').toBe(asked);
      return asked;
    };
    const box = (x: number) => ({ 'general|': { [rootId()]: { x, y: 20 } } });
    expect(st().drive.file, 'no file').toBeNull();
    expect(asks(), 'a first visit that touched nothing').toBe(false);
    edit('Relay');
    expect(asks(), 'an edit nothing holds').toBe(true);
    st().undo();
    expect(asks(), 'Undo back to the saved model').toBe(false);
    st().setTextBuffer(st().textBuffer.replace('Swarm', 'Kite'));
    expect(asks(), 'text typed and not applied').toBe(true);
    st().setTextBuffer(st().textBuffer.replace('Kite', 'Swarm'));
    expect(asks(), 'typed back as it was').toBe(false);
    useAppStore.setState({ diagramPins: box(10) });
    expect(asks(), 'a box moved by hand').toBe(true);
    await st().saveProject('Swarm');
    expect(asks(), 'Save holds the text and the boxes').toBe(false);
    useAppStore.setState({ diagramPins: box(30) });
    expect(asks(), 'moved again').toBe(true);
    useAppStore.setState({ diagramPins: box(10) });
    expect(asks(), 'moved back to where Save left it').toBe(false);
    // A Versions commit holds the work for the session, not for the tab: the
    // repository goes with it.
    edit('Kite');
    st().commitVersion('held in memory');
    expect(unsaved(), 'a command that replaces the model: the commit holds it').toBe(false);
    expect(asks(), 'but the tab: the commit goes with it').toBe(true);
    await st().saveProject('Swarm');
    expect(asks(), 'Save holds it').toBe(false);
  });

  it('asks before the tab closes over a branch switch or a merge no browser save holds', async () => {
    const asks = () => askBeforeLeaving(new Event('beforeunload', { cancelable: true }));
    st().refreshVersions();
    st().commitVersion('first');
    expect(asks(), 'a commit of the model as Save left it').toBe(false);
    const main = st().currentBranchId;
    st().createBranchCmd('side');
    edit('Kite');
    st().commitVersion('side work');
    st().switchBranch(main);
    expect(asks(), 'a branch head that only the repository holds').toBe(true);
    await st().saveProject('Swarm');
    expect(asks(), 'Save').toBe(false);
    // A commit, then New: the committed model is replaced and still only in
    // the repository, so the tab keeps asking until Save.
    edit('Falcon');
    st().commitVersion('only copy');
    expect(asks(), 'a commit of a model no save holds').toBe(true);
    st().newProject('Next');
    expect(unsaved(), 'New runs without a question: the guard reads the commit as holding it').toBe(false);
    expect(asks(), 'New replaced the model the commit holds').toBe(true);
    await st().saveProject('Next');
    expect(asks(), 'Save').toBe(false);
    // The same with Open ▾ over a commit.
    edit('Osprey');
    st().commitVersion('only copy');
    await st().loadProject('Swarm');
    expect(asks(), 'Open replaced the model the commit holds').toBe(true);
    await st().saveProject('Swarm');
    expect(asks(), 'Save').toBe(false);
  });

  it('asks while an edit’s recompute is waiting, and while a save is being stored', async () => {
    const asks = () => askBeforeLeaving(new Event('beforeunload', { cancelable: true }));
    st().createElement('PartDefinition', rootId(), 'Relay');
    expect(browserDirty(st()), 'the Text view does not show the edit yet').toBe(false);
    expect(asks(), 'the edit is waiting').toBe(true);
    flushRecompute();
    expect(asks(), 'and once it has run').toBe(true);
    const saving = st().saveProject('Swarm');
    expect(asks(), 'the browser is still storing the save').toBe(true);
    await saving;
    expect(asks(), 'stored').toBe(false);
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
 * Boxes moved by hand on a diagram used to last the session: Save stored the
 * model alone, so Open laid every diagram out afresh. They are now kept with
 * the project in this browser's project store, beside the model, and never in
 * its text — the `.sysml` file, the Text view and a Google Drive file are the
 * model alone. Open puts them back; New and Import start from a fresh layout,
 * and their Undo puts the boxes back with the model they were arranged on.
 */
describe('boxes moved by hand — kept with the project in this browser, never in its text', () => {
  const SWARM = 'package Swarm {\n    part def Drone;\n    part def Relay;\n}\n';
  const idOf = (name: string) => st().model.all().find((e) => e.declaredName === name)!.id;
  const rootNames = () => st().model.roots().filter((r) => r.attrs.isLibrary !== true).map((r) => r.declaredName);
  /** The project as this browser's store holds it. */
  const stored = (name: string) => new LocalStorageStore().loadProject(name);

  /**
   * Where the diagram, laid out now, draws the box of `id` — once every
   * rebuild started meanwhile (a recompute, the library's refresh) has
   * published: only the latest one does.
   */
  async function boxAt(id: string): Promise<{ x: number; y: number }> {
    await whenLibrarySettled();
    flushRecompute();
    await st().rebuildDiagram();
    await vi.waitFor(() => expect(st().diagramLayoutPending).toBe(false));
    const node = st().diagram?.nodes.find((n) => n.id === id);
    expect(node?.position, `the diagram draws a box for ${id}`).toBeDefined();
    return node!.position!;
  }

  /** Drop the box of `id` at `to`, as the canvas reports a drop on empty canvas. */
  async function move(id: string, to: { x: number; y: number }): Promise<void> {
    await boxAt(id);
    st().pinNodePositions(new Map([[id, to]]));
  }

  beforeEach(async () => {
    await whenLibrarySettled();
    lib.merge = null;
    reset();
    useAppStore.setState({
      textBuffer: '',
      textDirty: false,
      diagnostics: [],
      serializeError: null,
      activeView: 'general',
      diagramRootId: null,
      diagramPins: {},
    });
    await openText(SWARM, 'sysml');
    useAppStore.setState({ undoStack: [], redoStack: [] });
  });

  it('Save keeps them beside the model in this browser, and Open puts them back where they were — per view and scope', async () => {
    const drone = idOf('Drone');
    const root = idOf('Swarm');
    const laid = await boxAt(drone);
    const dropped = { x: laid.x + 300, y: laid.y + 200 };
    const text = st().textBuffer;
    await move(drone, dropped);
    expect(await boxAt(drone), 'through a rebuild').toEqual(dropped);
    st().setDiagramRoot(root);
    await move(drone, { x: 7, y: 9 });
    flushRecompute();
    expect(st().textBuffer, 'a moved box is no edit of the text').toBe(text);

    await st().saveProject('Swarm');
    const record = await stored('Swarm');
    expect(record?.elements.some((e) => e.id === drone), 'the model').toBe(true);
    expect(record?.meta?.diagramPins, 'and the boxes beside it').toEqual({
      'general|': { [drone]: dropped },
      [`general|${root}`]: { [drone]: { x: 7, y: 9 } },
    });

    st().newProject('Other');
    await whenLibrarySettled();
    await st().loadProject('Swarm');
    expect(rootNames()).toEqual(['Swarm']);
    st().setDiagramRoot(null);
    expect(await boxAt(drone), 'where it was dropped').toEqual(dropped);
    st().setDiagramRoot(root);
    expect(await boxAt(drone), 'and in the diagram scoped to the package').toEqual({ x: 7, y: 9 });
    expect(st().textBuffer, 'the text holds none of it').toBe(text);
  });

  it('a project saved before they were kept opens as it did, laid out afresh — and a malformed record of them is skipped', async () => {
    const drone = idOf('Drone');
    // What Save stored until now: the model, and nothing beside it.
    const before = st().model.toJSON();
    expect(before.meta).toBeUndefined();
    await new LocalStorageStore().saveProject('Earlier', before);
    await move(drone, { x: 900, y: 900 });

    await st().loadProject('Earlier');
    expect(rootNames()).toEqual(['Swarm']);
    expect(st().diagramPins, 'the boxes of the model it replaced are not its').toEqual({});
    expect(await boxAt(drone)).not.toEqual({ x: 900, y: 900 });

    await new LocalStorageStore().saveProject('Odd', {
      ...before,
      meta: {
        diagramPins: {
          'general|': { [drone]: { x: 5, y: 6 }, ghost: { x: 'left', y: 1 }, gap: { x: null, y: 2 } },
          'tree|': 'not boxes',
          'sequence|': [],
        },
      },
    });
    await st().loadProject('Odd');
    expect(st().diagramPins).toEqual({ 'general|': { [drone]: { x: 5, y: 6 } } });
    await new LocalStorageStore().saveProject('Odder', { ...before, meta: { diagramPins: 'boxes' } });
    await st().loadProject('Odder');
    expect(rootNames()).toEqual(['Swarm']);
    expect(st().diagramPins).toEqual({});
  });

  it('New and Import start from a fresh layout, Open from the project’s — and Undo puts back the boxes of the model it brings back', async () => {
    const drone = idOf('Drone');
    const dropped = { x: 640, y: 480 };
    await move(drone, dropped);
    const pins = st().diagramPins;

    st().newProject('Fresh');
    expect(st().diagramPins).toEqual({});
    st().undo();
    expect(rootNames()).toEqual(['Swarm']);
    expect(st().diagramPins).toEqual(pins);
    expect(await boxAt(drone)).toEqual(dropped);
    st().redo();
    expect(rootNames()).toEqual(['Fresh']);
    expect(st().diagramPins, 'Redo takes them away again').toEqual({});
    st().undo();

    st().importModel(SWARM, 'sysml');
    expect(st().diagramPins).toEqual({});
    await whenLibrarySettled();
    st().undo();
    expect(st().diagramPins).toEqual(pins);
    expect(await boxAt(drone)).toEqual(dropped);

    await st().saveProject('Swarm');
    await move(drone, { x: 1, y: 2 });
    const moved = st().diagramPins;
    await st().loadProject('Swarm');
    expect(st().diagramPins, 'the project’s').toEqual(pins);
    await whenLibrarySettled();
    st().undo();
    expect(st().diagramPins, 'the ones Open replaced').toEqual(moved);
    st().redo();
    expect(st().diagramPins).toEqual(pins);

    // Moving a box is no Undo step, and an edit's Undo leaves the boxes be.
    st().createElement('PartDefinition', idOf('Swarm'), 'Kite');
    await move(drone, { x: 11, y: 12 });
    const now = st().diagramPins;
    st().undo();
    expect(st().model.all().some((e) => e.declaredName === 'Kite')).toBe(false);
    expect(st().diagramPins).toEqual(now);
  });

  it('an apply of text — the Text view’s, or the one Save makes of typed text — keeps each box with its element, by qualified name', async () => {
    const drone = idOf('Drone');
    await move(drone, { x: 312, y: 212 });
    await move(idOf('Relay'), { x: 40, y: 640 });
    st().setDiagramRoot(idOf('Swarm'));
    await move(drone, { x: 7, y: 9 });
    st().setDiagramRoot(null);
    const before = st().diagramPins;

    // Typed and not applied, then Save: the apply makes every element anew,
    // under a new id — the boxes stay where they were dropped.
    st().setTextBuffer(st().textBuffer.replace('part def Relay;', 'part def Relay;\n    part def Kite;'));
    await runSave();
    const droneNow = idOf('Drone');
    expect(droneNow, 'the apply made Drone anew').not.toBe(drone);
    expect(await boxAt(droneNow)).toEqual({ x: 312, y: 212 });
    expect(await boxAt(idOf('Relay'))).toEqual({ x: 40, y: 640 });
    const record = await stored('Swarm');
    expect(record?.elements.some((e) => e.id === droneNow), 'the model saved is the applied one').toBe(true);
    expect(record?.meta?.diagramPins, 'and the boxes beside it are under its ids').toEqual({
      'general|': { [droneNow]: { x: 312, y: 212 }, [idOf('Relay')]: { x: 40, y: 640 } },
      [`general|${idOf('Swarm')}`]: { [droneNow]: { x: 7, y: 9 } },
    });

    // Undo of the apply: the model it replaced, its ids, and their boxes.
    await whenLibrarySettled();
    st().undo();
    expect(idOf('Drone')).toBe(drone);
    expect(st().diagramPins).toEqual(before);
    expect(await boxAt(drone)).toEqual({ x: 312, y: 212 });
    st().redo();
    expect(idOf('Drone')).toBe(droneNow);
    expect(await boxAt(droneNow)).toEqual({ x: 312, y: 212 });

    st().newProject('Other');
    await whenLibrarySettled();
    await st().loadProject('Swarm');
    expect(await boxAt(droneNow), 'and Open puts them back').toEqual({ x: 312, y: 212 });

    // The Text view's Apply: a renamed element is another element, and lays
    // out afresh; text unlike the model keeps nothing.
    st().setTextBuffer(st().textBuffer.replace('part def Relay;', 'part def Mast;'));
    st().applyText();
    expect(st().diagramPins['general|']).toEqual({ [idOf('Drone')]: { x: 312, y: 212 } });
    expect(await boxAt(idOf('Drone'))).toEqual({ x: 312, y: 212 });
    expect(await boxAt(idOf('Mast'))).not.toEqual({ x: 40, y: 640 });
    st().setTextBuffer('package Other {\n    part def Drone;\n}\n');
    st().applyText();
    expect(st().diagramPins, 'Other::Drone is not Swarm::Drone').toEqual({});

    // Two elements of one name: the name tells neither apart, so neither box goes.
    st().setTextBuffer('package Twins {\n    part def Drone;\n    part def Drone;\n}\n');
    st().applyText();
    await whenLibrarySettled();
    const twin = st().model.all().find((e) => e.declaredName === 'Drone')!.id;
    await move(twin, { x: 5, y: 5 });
    st().setTextBuffer(st().textBuffer);
    st().applyText();
    expect(st().model.all().filter((e) => e.declaredName === 'Drone')).toHaveLength(2);
    expect(st().diagramPins).toEqual({});
  });

  it('a .sysml file opened as text starts from a fresh layout, as Import does, and the Undo step it leaves (Reload from Drive keeps it) puts the boxes back', async () => {
    const drone = idOf('Drone');
    await move(drone, { x: 900, y: 700 });
    const pins = st().diagramPins;

    await openText(SWARM, 'sysml');
    expect(st().diagramPins, 'not even for elements of the same names').toEqual({});
    await st().saveProject('Swarm');
    expect((await stored('Swarm'))?.meta?.diagramPins).toEqual({});
    st().undo();
    expect(idOf('Drone')).toBe(drone);
    expect(st().diagramPins).toEqual(pins);
    expect(await boxAt(drone)).toEqual({ x: 900, y: 700 });
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

/**
 * A field's change — a Properties box, a rename, a Requirements table cell —
 * made while the Text view holds text typed there and not applied. It used to
 * re-serialise the Text view over that text, with no note and no Undo. The
 * typed text is applied first when the elements the change names survive it,
 * under the ids they had, and the change goes in over it; otherwise it stays,
 * reading "not yet applied", as over an SDK edit.
 */
describe('a field’s change over text typed in the Text view and not applied', () => {
  const sdk = () => st().api;
  const named = (name: string) => st().model.all().some((e) => e.declaredName === name);
  const rootId = () => st().model.roots().find((r) => r.attrs.isLibrary !== true)!.id;

  /** A Swarm package holding `part def Relay`, its text in the Text view; Relay's id. */
  async function relayModel(): Promise<string> {
    await whenLibrarySettled();
    lib.merge = null;
    reset();
    useAppStore.setState({ model: sdk().model, textBuffer: '', textDirty: false, diagnostics: [], serializeError: null });
    st().newProject('Swarm');
    const relay = sdk().create('PartDefinition', { declaredName: 'Relay', ownerId: rootId() });
    flushRecompute();
    return relay.id;
  }

  afterEach(() => {
    useAppStore.setState({ drive: initialDriveState });
  });

  it('applies the typed text first when the element survives it — under its id — and the change goes in over it: both stand, two Undo steps', async () => {
    const relay = await relayModel();
    // With nothing typed, a box's keystrokes stay one coalesced recompute.
    const rebuild = st().rebuildDiagram;
    const rebuilt = vi.fn(async () => {});
    useAppStore.setState({ rebuildDiagram: rebuilt });
    try {
      for (const name of ['R', 'Re', 'Relay']) st().updateElement(relay, { declaredName: name });
      expect(rebuilt, 'no keystroke ran the last one’s recompute').not.toHaveBeenCalled();
    } finally {
      useAppStore.setState({ rebuildDiagram: rebuild });
    }
    flushRecompute();

    st().select(relay);
    st().setTextBuffer(st().textBuffer.replace('part def Relay;', 'part def Relay;\n    part def Typed;'));
    expect(st().textDirty).toBe(true);

    st().updateElement(relay, { declaredName: 'Kite' });
    expect(named('Typed'), 'the typed text is the model').toBe(true);
    expect(st().model.get(relay)?.declaredName, 'the change, on the element of the same id').toBe('Kite');
    expect(st().selectionId, 'Properties stays on it').toBe(relay);
    expect(st().projectName).toBe('Swarm');
    flushRecompute();
    expect(st().textDirty).toBe(false);
    expect(st().textBuffer).toMatch(/part def Kite;\s*part def Typed;/);

    st().undo();
    expect(named('Relay') && named('Typed'), 'the change’s step').toBe(true);
    st().undo();
    expect(named('Typed'), 'the apply’s step').toBe(false);
    st().redo();
    st().redo();

    // Ctrl/Cmd+S typed in a field: the box's change, then the save — which holds both.
    st().setTextBuffer(st().textBuffer.replace('part def Typed;', 'part def Typed;\n    part def Saved;'));
    st().updateElement(relay, { declaredName: 'Kite2' });
    await runSave();
    await st().loadProject('Swarm');
    expect(['Kite2', 'Typed', 'Saved'].every(named), 'the save holds the typed text and the change').toBe(true);
  });

  it('makes the Documentation box’s first keystroke a change over the typed text too', async () => {
    const relay = await relayModel();
    st().setTextBuffer(st().textBuffer.replace('part def Relay;', 'part def Relay;\n    part def Typed;'));
    const doc = st().createElement('Documentation', relay, undefined, { field: true });
    st().setAttr(doc, 'body', 'Relays the link.');
    expect(named('Typed')).toBe(true);
    expect(st().model.get(doc)?.ownerId).toBe(relay);
    flushRecompute();
    expect(st().textDirty).toBe(false);
    expect(st().textBuffer).toContain('Relays the link.');
    expect(st().textBuffer).toContain('part def Typed;');

    // The typed text gives the element its doc, which the live model has not:
    // the box, empty until its first keystroke, then shows that doc — no
    // second doc — and the keystroke is not written over the typed body.
    const typedDef = st().model.all().find((e) => e.declaredName === 'Typed')!.id;
    st().setTextBuffer(st().textBuffer.replace('part def Typed;', 'part def Typed {\n        doc /* typed */\n    }'));
    st().select(typedDef);
    const view = render(React.createElement(Properties));
    try {
      const box = () => view.getByTestId('prop-doc') as HTMLTextAreaElement;
      expect(box().value).toBe('');
      fireEvent.change(box(), { target: { value: 'N' } });
      await act(() => whenLibrarySettled());
      const docs = () => st().model.children(typedDef).filter((c) => c.eClass === 'Documentation');
      expect(named('Typed') && docs().map((d) => String(d.attrs.body).trim()), 'the typed body stands').toEqual(['typed']);
      expect(box().value.trim(), 'the box shows it').toBe('typed');
      fireEvent.change(box(), { target: { value: 'typed, then N' } });
      expect(docs().map((d) => d.attrs.body), 'the next keystroke edits that doc').toEqual(['typed, then N']);
      act(() => st().undo());
      expect(docs().map((d) => String(d.attrs.body).trim())).toEqual(['typed']);
    } finally {
      view.unmount();
    }
  });

  /**
   * The change runs again on the model the typed text made, so a name typed in
   * the field resolves there: a type only the typed text declares, and one of
   * the standard library, which that apply keeps standing (Apply's own merge of
   * it comes later, off the click).
   */
  it('resolves a name typed in the field on the model the typed text made — its own types and the library’s', async () => {
    await relayModel();
    const real = st().model.create('AttributeDefinition', { declaredName: 'Real', attrs: { isLibrary: true } });
    const r = sdk().create('PartUsage', { declaredName: 'r', ownerId: rootId() });
    const mass = sdk().create('AttributeUsage', { declaredName: 'mass', ownerId: rootId() });
    flushRecompute();
    st().setTextBuffer(st().textBuffer.replace('part def Relay;', 'part def Relay;\n    part def Typed;'));
    // The Type box: its keystrokes write the name, its Enter binds it.
    st().setAttr(r.id, 'type', 'Typed');
    st().bindType(r.id, 'Typed');
    expect(st().model.typesOf(r.id).map((t) => t.declaredName), 'typed by the typed text’s own type').toEqual(['Typed']);

    flushRecompute(); // as focusing the Text view does
    st().setTextBuffer(st().textBuffer.replace('part def Typed;', 'part def Typed;\n    part def More;'));
    st().setAttr(mass.id, 'type', 'Real');
    st().bindType(mass.id, 'Real');
    expect(named('More')).toBe(true);
    expect(st().model.typesOf(mass.id).map((t) => t.id), 'typed by the library’s').toEqual([real.id]);

    // The Subject box commits once, on leaving it: its type may be one only the typed text declares.
    const req = sdk().create('RequirementDefinition', { declaredName: 'Req', ownerId: rootId() });
    flushRecompute();
    st().setTextBuffer(st().textBuffer.replace('part def More;', 'part def More;\n    part def Craft;'));
    st().setSubject(req.id, 'c : Craft');
    const subject = st().model.children(req.id).find((c) => c.attrs.requirementRole === 'subject')!;
    expect(st().model.typesOf(subject.id).map((t) => t.declaredName)).toEqual(['Craft']);
  });

  /**
   * The library merge an apply starts lands after the typing began: it adds
   * the library and binds references, and the model is still the text the
   * typing began over — so a field's change still applies the typed text first.
   */
  it('applies the typed text first across a library merge that landed after the typing began', async () => {
    await relayModel();
    await whenLibrarySettled();
    let release = (): void => {};
    lib.holds.push(new Promise<void>((r) => (release = r)));
    st().applyText();
    await vi.waitFor(() => expect(lib.holds).toHaveLength(0));
    lib.merge = (m) => {
      if (!m.all().some((e) => e.attrs.isLibrary === true)) {
        m.create('Package', { declaredName: 'Lib', attrs: { isLibrary: true } });
      }
    };
    st().setTextBuffer(st().textBuffer.replace('part def Relay;', 'part def Relay;\n    part def Typed;'));
    const rev = st().model.rev;
    release();
    await whenLibrarySettled();
    expect(st().model.rev, 'the merge changed the model').toBeGreaterThan(rev);
    expect(st().textDirty, 'the typing stands').toBe(true);
    const relay = st().model.all().find((e) => e.declaredName === 'Relay')!.id;
    st().updateElement(relay, { declaredName: 'Kite' });
    expect(named('Typed') && named('Kite'), 'the typed text, then the change').toBe(true);
  });

  it('leaves the typed text standing when it cannot go first — a syntax error, an element it lacks, a model changed since the typing, a room', async () => {
    const cases: Array<[string, (text: string) => string]> = [
      ['a syntax error', (t) => t.replace('part def Relay;', 'part def Relay;\n    blok bad;')],
      ['Relay is not in it', (t) => t.replace('part def Relay;', 'part def Other;')],
    ];
    for (const [why, type] of cases) {
      const relay = await relayModel();
      const typed = type(st().textBuffer);
      st().setTextBuffer(typed);
      st().updateElement(relay, { declaredName: 'Kite' });
      expect(named('Kite'), `${why}: the change is in the model`).toBe(true);
      expect(forcedRecomputePending(), why).toBe(false);
      flushRecompute();
      expect(st().textBuffer, `${why}: the typed text stays`).toBe(typed);
      expect(st().textDirty, why).toBe(true);

      // The model has changed since the typing: applying the text now would put
      // it over that change — though the package the next one names is in it.
      st().updateElement(rootId(), { declaredShortName: 'S' });
      flushRecompute();
      expect(st().textBuffer, `${why}: the next change keeps it too`).toBe(typed);
      expect(named('Kite'), why).toBe(true);
    }

    // A field's change, then typing before its recompute ran: the typing is over the
    // text without the change, so the next change keeps the text rather than apply it.
    const relay = await relayModel();
    st().updateElement(relay, { declaredName: 'Kite' });
    const typed = st().textBuffer.replace('part def Relay;', 'part def Relay;\n    part def Typed;');
    st().setTextBuffer(typed);
    st().updateElement(rootId(), { declaredName: 'Fleet' });
    flushRecompute();
    expect(st().textBuffer).toBe(typed);
    expect(named('Kite') && named('Fleet'), 'both changes stand').toBe(true);

    // In a collaboration room an apply would reset the room's model for every peer.
    const kite = await relayModel();
    st().connectCollab('field-room');
    try {
      const inRoom = st().textBuffer.replace('part def Relay;', 'part def Relay;\n    part def Typed;');
      st().setTextBuffer(inRoom);
      st().updateElement(kite, { declaredName: 'Kite' });
      flushRecompute();
      expect(st().textBuffer, 'in a room').toBe(inRoom);
      expect(named('Typed')).toBe(false);
      expect(named('Kite')).toBe(true);
    } finally {
      st().disconnectCollab();
    }

    // A box or a cell left as it was is no change: nothing applied, and no Undo step.
    const same = await relayModel();
    const req = sdk().create('RequirementDefinition', { declaredName: 'Req', ownerId: rootId() });
    st().setAttr(req.id, 'text', 'Relays.');
    st().setSubject(req.id, 'r : Relay');
    flushRecompute();
    const untouched = st().textBuffer.replace('part def Relay;', 'part def Relay;\n    part def Typed;');
    st().setTextBuffer(untouched);
    const steps = st().undoStack.length;
    st().updateElement(same, { declaredName: 'Relay' });
    st().setAttr(req.id, 'text', 'Relays.');
    st().setSubject(req.id, 'r : Relay');
    flushRecompute();
    expect(st().textBuffer, 'left as it was').toBe(untouched);
    expect(st().textDirty).toBe(true);
    expect(st().undoStack.length, 'no Undo step').toBe(steps);
  });

  /**
   * The "kept" case above leaves the typed text over a model that has the
   * change: a later Save or Export ▾ → SysML applies it, and drops the change.
   * They say so — an info note, once; the text is not kept back for it — and
   * only for a field's change: an SDK edit, a peer's edit (the room test in the
   * Save block) and a faulted apply leave the text standing too, and say nothing.
   */
  describe('Save or Export applying it over the change', () => {
    const OTHER = (t: string) => t.replace('part def Relay;', 'part def Other;');
    const note = () => st().drive.notice;

    it('Save says so once, and the next save that holds the model takes the note down', async () => {
      const relay = await relayModel();
      const typed = OTHER(st().textBuffer);
      st().setTextBuffer(typed);
      st().updateElement(relay, { declaredName: 'Kite' });
      flushRecompute();
      expect(st().textBuffer, 'the text stays over the change').toBe(typed);

      await runSave();
      expect(named('Other'), 'the typed text is applied').toBe(true);
      expect(named('Kite'), 'the change is dropped').toBe(false);
      expect(note()).toEqual({ kind: 'info', message: DRIVE_MESSAGES.typedTextOverChanges, retryable: false });
      st().undo();
      expect(named('Kite'), 'Undo brings the change back, as the note says').toBe(true);

      await runSave();
      expect(note(), 'the save that holds the change takes the note down').toBeNull();
    });

    it('Export ▾ → SysML says so too, in its own words', async () => {
      const relay = await relayModel();
      st().setTextBuffer(OTHER(st().textBuffer));
      st().updateElement(relay, { declaredName: 'Kite' });
      flushRecompute();

      expect(runExportSysml()).toContain('part def Other;');
      expect(note()).toEqual({ kind: 'info', message: DRIVE_MESSAGES.typedTextExportedOverChanges, retryable: false });
      runExportSysml();
      expect(note(), 'an export that holds the model takes it down').toBeNull();
    });

    it('the guard’s Save applies it over the change and, once the command has replaced the model, says it takes two Undos', async () => {
      const relay = await relayModel();
      st().setTextBuffer(OTHER(st().textBuffer));
      st().updateElement(relay, { declaredName: 'Kite' });
      flushRecompute();
      const run = vi.fn(() => st().newProject('NewModel'));
      st().driveGuard('New', 'dirty', run);
      await st().driveRunPending('save');
      expect(run).toHaveBeenCalledTimes(1);
      // One Undo would bring back the model the command replaced, not the change: "Undo brings those changes back" would mislead.
      expect(note()).toEqual({ kind: 'info', message: DRIVE_MESSAGES.typedTextSavedOverChangesThenReplaced('New'), retryable: false });
      st().undo();
      expect(named('Kite'), 'the first Undo brings back the model').toBe(false);
      expect(named('Other')).toBe(true);
      st().undo();
      expect(named('Kite'), 'the second brings the change back').toBe(true);
    });

    it('says nothing over an SDK edit or a faulted apply, nor once the typed text was applied or replaced', async () => {
      // An SDK edit: the text stays, and Save applies it over the edit (one Undo brings the edit back).
      let relay = await relayModel();
      st().setTextBuffer(OTHER(st().textBuffer));
      sdk().update(relay, { declaredName: 'Kite' });
      flushRecompute();
      await runSave();
      expect(named('Other') && !named('Kite'), 'applied over the edit').toBe(true);
      expect(note(), 'an SDK edit is no field’s change').toBeNull();

      // A faulted apply: its text is the model's, not typed.
      await openText('package Swarm {\n    blok bad;\n}\n', 'sysml');
      expect(st().textDirty).toBe(true);
      await runSave();
      expect(note(), 'a faulted apply').toBeNull();

      // A change over typed text, then that text applied: the next typed text is not one a change was made over.
      relay = await relayModel();
      st().setTextBuffer(OTHER(st().textBuffer));
      st().updateElement(relay, { declaredName: 'Kite' });
      flushRecompute();
      st().applyText();
      st().setTextBuffer(st().textBuffer.replace('part def Other;', 'part def Other;\n    part def Later;'));
      await runSave();
      expect(named('Later'), 'applied').toBe(true);
      expect(note(), 'the earlier change was made over the text applied since').toBeNull();

      // ...or replaced by the model's own text: an edit in the app forces the recompute.
      relay = await relayModel();
      st().setTextBuffer(OTHER(st().textBuffer));
      st().updateElement(relay, { declaredName: 'Kite' });
      st().createElement('PartDefinition', rootId(), 'Edited');
      flushRecompute();
      expect(st().textDirty, 'the edit replaced the typed text').toBe(false);
      st().setTextBuffer(st().textBuffer.replace('part def Edited;', 'part def Edited;\n    part def Later;'));
      await runSave();
      expect(named('Later'), 'applied').toBe(true);
      expect(note()).toBeNull();
    });
  });
});

/**
 * What a check is judged under: whether the model on screen is the model a
 * file of it would hold. `reach` and `check-behaviour` report on what parsed
 * when a file does not load cleanly (exit 1 and 2), and the page must not say
 * `holds` over half a model. It is measured over the TEXTS a file can hold —
 * what Save writes and what Export ▾ SysML writes — and the validator's
 * errors, never read off Problems: Simulate, Solve and Check replace that.
 */
describe('the load health a check is judged under', () => {
  /** A holding cycle, and a package whose `part x : ;` the parser recovers into `part x;`. */
  const BROKEN_PART = 'package C { state def M { state a; state b; transition a then b; transition b then a; } }\npackage Broken { part x : ; }\n';
  /** A clean machine and a part whose value the parser cannot read: the serializer writes it back as it came. */
  const RAW_VALUE =
    'package C {\n  part def Ctl { state def M { state idle; state busy; transition idle then busy; transition busy then idle; } }\n  part def Pump { attribute rate : Real = 1 +; }\n}\n';
  const CLEAN =
    'package C {\n  part def Ctl { state def M { state idle; state busy; transition idle then busy; transition busy then idle; } }\n  part def Pump { attribute rate : Real = 2; }\n}\n';

  const parseErrors = (text: string) => parseModel(text).diagnostics.filter((d) => d.severity === 'error').length;
  const byName = (name: string) => st().model.all().find((e) => e.declaredName === name)!.id;
  const exported = () => exportModel(st().model, 'sysml');

  async function apply(text: string): Promise<void> {
    st().setTextBuffer(text);
    st().applyText();
    await whenLibrarySettled();
  }

  /** Apply `text` with its library merge held open; resolves once the merge is in flight, and gives the way to release it. */
  async function heldLoad(text: string): Promise<() => void> {
    let release = (): void => {};
    lib.holds.push(new Promise<void>((r) => (release = r)));
    useAppStore.setState({ textBuffer: text });
    st().applyText();
    await vi.waitFor(() => expect(lib.holds).toHaveLength(0));
    return release;
  }

  beforeEach(async () => {
    await whenLibrarySettled();
    lib.merge = null;
    reset();
    useAppStore.setState({ textBuffer: '', textDirty: false, diagnostics: [], serializeError: null });
  });

  it('a text with a syntax error: Save writes it back, Export writes the recovered model; Simulate does not clear it; an edit regenerates the text', async () => {
    await apply(BROKEN_PART);
    const h = loadHealth();
    expect(h.saved?.parseErrors, 'Save keeps the text a faulted apply was made from').toBeGreaterThan(0);
    expect(h.exported?.parseErrors, 'Export writes `part x;`, which parses').toBe(0);
    expect(h.exported?.parseErrors).toBe(parseErrors(exported()));
    expect(h.sameText).toBe(false);
    expect(h.errors).toBeGreaterThan(0);
    expect(h.unwritable).toBeNull();

    // Simulate replaces the Problems rows. A signal read off them would read 0 now.
    st().simulate();
    expect(st().diagnostics.some((d) => d.ruleId === 'parse'), 'Problems no longer holds the parse errors').toBe(false);
    expect(loadHealth().errors, 'the health is measured over the text').toBeGreaterThan(0);
    expect(loadHealth().saved?.parseErrors).toBe(h.saved?.parseErrors);

    // An edit regenerates the text, so Save and Export now write the same text, and it is what is measured.
    st().createElement('PartDefinition', null, 'Extra');
    const after = loadHealth();
    expect(after.sameText).toBe(true);
    expect(after.saved?.parseErrors).toBe(after.exported?.parseErrors);
    expect(after.errors).toBe(parseErrors(exported()) + after.validationErrors);
    expect(after.errors, '`part x;` parses').toBe(0);
  });

  it('a value the parser cannot read survives an edit: the regenerated text keeps it', async () => {
    await apply(RAW_VALUE);
    expect(loadHealth().errors).toBeGreaterThan(0);
    st().updateElement(byName('Pump'), { declaredName: 'PumpUnit' });
    const h = loadHealth();
    expect(h.sameText, 'the text was regenerated').toBe(true);
    expect(st().textBuffer).toContain('1 +');
    expect(parseErrors(st().textBuffer), 'and it does not parse').toBeGreaterThan(0);
    expect(h.saved?.parseErrors).toBeGreaterThan(0);
    expect(h.errors).toBe(h.saved!.parseErrors + h.validationErrors);
    expect(h.errors).toBeGreaterThan(0);
  });

  it('a value typed in Properties is stored raw: an unparseable expression is never clean', async () => {
    await apply(CLEAN);
    expect(loadHealth().errors, 'a clean model, to start from').toBe(0);
    for (const typed of ['1 +', '2 * (3', 'rate)']) {
      st().setAttr(byName('rate'), 'value', typed);
      const h = loadHealth();
      expect(h.errors, typed).toBeGreaterThan(0);
      expect(h.sameText, typed).toBe(true);
      expect(h.saved?.parseErrors, typed).toBe(parseErrors(exported()));
      st().setAttr(byName('rate'), 'value', '2');
      expect(loadHealth().errors, `${typed}, put right`).toBe(0);
    }
  });

  it('a model-JSON import carries the same raw value text', () => {
    const m = parseModel(CLEAN).model;
    const rate = m.all().find((e) => e.declaredName === 'rate')!;
    m.setAttrs(rate.id, { value: '1 +', valueText: undefined });
    st().importModel(JSON.stringify(m.toJSON()), 'model-json');
    const h = loadHealth();
    expect(h.errors).toBeGreaterThan(0);
    expect(h.saved?.parseErrors).toBeGreaterThan(0);
  });

  it('a model-JSON import of a clean model, and a sysml import of a broken one', () => {
    st().importModel(JSON.stringify(parseModel(CLEAN).model.toJSON()), 'model-json');
    expect(loadHealth().errors).toBe(0);
    st().importModel('package C { part def Pump { attribute rate : Real = 1 +; } }\n', 'sysml');
    expect(loadHealth().errors).toBeGreaterThan(0);
  });

  it('counts the validator’s errors on the user’s elements, and a clean text has none', async () => {
    await apply(CLEAN);
    const clean = loadHealth();
    expect(clean).toMatchObject({
      errors: 0,
      validationErrors: 0,
      validateThrew: false,
      unwritable: null,
      sameText: true,
    });
    // Each text was parsed, and parses to the model on screen.
    expect(clean.saved).toEqual({ parseErrors: 0, basis: 'parse', otherModel: false });
    expect(clean.exported).toEqual({ parseErrors: 0, basis: 'parse', otherModel: false });
    expect(clean.otherModel).toBe(false);

    await apply('package Two { part def D; part def D; }\n');
    const dup = loadHealth();
    expect(dup.validationErrors, 'a duplicate name is an error').toBeGreaterThan(0);
    expect(dup.saved?.parseErrors).toBe(0);
    expect(dup.errors).toBe(dup.validationErrors);
  });

  it('a model the serializer refuses is unwritable, and counts', () => {
    useAppStore.setState({ serializeError: 'the note body contains "*/"' });
    const h = loadHealth();
    expect(h.unwritable).toBe('the note body contains "*/"');
    expect(h.saved, 'no file holds it').toBeNull();
    expect(h.errors).toBeGreaterThanOrEqual(1);
  });

  it('a model whose export throws is unwritable too, with no exported text', () => {
    const id = st().createElement('PartDefinition', null, 'Engine');
    const doc = st().createElement('Documentation', id);
    st().setAttr(doc, 'body', 'a real note');
    st().regenerateText();
    // Straight onto the model, as the element-graph API or a model-JSON import reaches the serializer.
    st().model.setAttrs(doc, { body: `bad ${NOTE_BODY_TERMINATOR} part def Ghost; doc /*` });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = loadHealth();
    quiet.mockRestore();
    expect(h.exported).toBeNull();
    expect(h.unwritable).toContain(NOTE_BODY_TERMINATOR);
    expect(h.errors).toBeGreaterThanOrEqual(1);
  });

  it('parses each text no parse has measured, once: the applied text keeps its own parse, and the export text is parsed and kept', async () => {
    // Texts no other test applies, so the memo cannot already hold their export.
    const once = (n: number, end: string) =>
      `package Once${n} { state def M { state a; state b; transition a then b; transition b then a; } }\npackage Broken${n} { part x : ; }${end}`;
    const measure = vi.spyOn(textApi, 'measureTextHealth');
    try {
      // Save adds the one final newline a file ends in, so a text typed with none, or with two, is the same text to it.
      for (const [n, end] of [[1, '\n'], [2, ''], [3, '\n\n']] as const) {
        const text = once(n, end);
        st().setTextBuffer(text);
        st().applyText();
        await whenLibrarySettled();
        measure.mockClear();
        const h = loadHealth();
        // The buffer is the applied text, and the model stands as its parse: that parse is known from the apply.
        expect(h.saved?.parseErrors, `case ${n}`).toBeGreaterThan(0);
        // The export text is the recovered `part x;`, which no parse has seen: whatever the serializer saw as it
        // wrote it, it is parsed — once — before it counts as loading (review 2026-10-14, LH-1).
        expect(measure, `case ${n}: the export text is parsed`).toHaveBeenCalledTimes(1);
        expect(measure.mock.calls[0][0], `case ${n}: and only it`).not.toBe(text);
        expect(h.exported?.parseErrors, `case ${n}: the recovered export parses`).toBe(0);
        expect(h.sameText, `case ${n}: the applied text is not the recovered export`).toBe(false);
        expect(h.exported?.basis, `case ${n}`).toBe('parse');
        measure.mockClear();
        expect(loadHealth(), `case ${n}`).toEqual(h);
        expect(measure, `case ${n}: its counts are kept`).not.toHaveBeenCalled();
      }
    } finally {
      measure.mockRestore();
    }
  });

  it('validates the live model only when none ran at this revision', async () => {
    await apply(CLEAN);
    const validate = vi.spyOn(validationApi, 'validateSteps');
    const ofLive = () => validate.mock.calls.filter(([m]) => m === st().model).length;
    try {
      loadHealth();
      validate.mockClear();
      loadHealth();
      expect(ofLive(), 'the refresh after the merge validated this revision').toBe(0);
      st().createElement('PartDefinition', null, 'Extra');
      validate.mockClear();
      loadHealth();
      expect(ofLive(), 'the edit’s recompute validates; loadHealth reads that').toBe(1);
    } finally {
      validate.mockRestore();
    }
  });

  it('a file is judged on the model its text parses to: renaming a connected port leaves the connector one end short', async () => {
    const WIRED =
      'package P {\n  port def Pw;\n  part def A { port pwrOut : Pw; }\n  part def B { port pwrIn : Pw; }\n  part def S {\n    part a : A;\n    part b : B;\n    connection link connect a.pwrOut to b.pwrIn;\n  }\n}\n';
    await apply(WIRED);
    expect(loadHealth().errors, 'wired, to start from').toBe(0);
    st().updateElement(byName('pwrOut'), { declaredName: 'C' });
    await whenLibrarySettled();
    flushRecompute();
    // The live connector still holds its end as an element, so the live model is clean…
    const live = validationApi.validate(st().model).filter((d) => d.severity === 'error' && d.elementId !== undefined && !st().model.get(d.elementId)?.attrs.isLibrary);
    expect(live, 'the live model has no error').toHaveLength(0);
    // …and the serializer saw nothing wrong as it wrote the text, which says nothing either way…
    expect(serializeUserModelSignals(st().model).faults).toBe(0);
    // …but the text it is written as names `a.pwrOut`, which no longer exists.
    const reparsed = validationApi.validate(parseModel(st().textBuffer).model);
    expect(reparsed.some((d) => d.code === 'validation/connector-endpoints' || d.ruleId === 'connector-endpoints')).toBe(true);
    const h = loadHealth();
    expect(h.sameText).toBe(true);
    expect(h.saved?.parseErrors, 'it parses, with a warning').toBe(0);
    expect(h.validationErrors, 'the file fails validation').toBeGreaterThan(0);
    expect(h.errors).toBeGreaterThan(0);
    // Put right, it is clean again.
    st().updateElement(byName('C'), { declaredName: 'pwrOut' });
    await whenLibrarySettled();
    flushRecompute();
    expect(loadHealth().errors).toBe(0);
  });

  it('says a library merge is still running, so a number read now may be high', async () => {
    await whenLibrarySettled();
    expect(loadHealth().libraryPending, 'nothing is merging').toBe(false);
    const release = await heldLoad(CLEAN);
    try {
      expect(loadHealth().libraryPending, 'the apply’s merge is in flight').toBe(true);
    } finally {
      release();
    }
    await whenLibrarySettled();
    expect(loadHealth().libraryPending).toBe(false);
  });
});

/**
 * The load health never says a text loads that a terminal rejects (review
 * 2026-10-14: LH-1..LH-4, and B's C2). 679a5e5 let a serializer-side
 * certificate vouch for a text without parsing it; it read neither the fields
 * the serializer writes back verbatim nor a value that reads alone but not in
 * its place, so Reachability read `holds` over texts `reach` exits 1 on, and a
 * faulty line applied in the Text view was talked back down to 0 errors by the
 * serializer's own count. Each case is a probe from that review, judged against
 * a terminal's loader (`loadModelText`) over the same library the store merges —
 * the stub here, the real one where a case says so.
 */
describe('the load health never vouches for a text that does not load (review 2026-10-14)', () => {
  const reachSpec = CHECKS.find((c) => c.id === 'reach')!;
  const behaviourSpec = CHECKS.find((c) => c.id === 'check-behaviour')!;
  const byName = (name: string) => st().model.all().find((e) => e.declaredName === name && e.attrs.implicit !== true)!.id;

  async function apply(text: string): Promise<void> {
    st().setTextBuffer(text);
    st().applyText();
    await whenLibrarySettled();
  }

  /** What a terminal reports on `text`: `loadModelText`, the CLI's loader, over the library the store merges. */
  const terminal = async (text: string) => (await textApi.loadModelText(text, { fileName: 'x.sysml' })).report;
  const parseErrorsIn = (r: Awaited<ReturnType<typeof terminal>>) =>
    r.diagnostics.filter((d) => d.severity === 'error' && d.ruleId === 'parse').length;

  /** A palette check's verdict over the model as it stands, judged under `h`. */
  const verdict = (spec: typeof reachSpec, h: ReturnType<typeof loadHealth>, selected: string | null = null) =>
    runCheck(spec, {
      model: st().model,
      selectionId: selected,
      selectionName: selected === null ? null : st().model.qualifiedName(selected),
      isolated: false,
      fileName: 'x.sysml',
      loadHealth: h,
    }).verdict;

  /**
   * The line held: the texts a file of the model can hold (what Save writes and
   * what Export ▾ SysML writes), each loaded as a terminal loads it. A health of
   * 0 errors is a pair of texts that both load; a text that does not load — or a
   * model the serializer refuses to write, so no file holds it — leaves the health
   * above 0, and no check `holds` over it. Returns whether either happened.
   */
  async function holdsTheLine(what: string, machine: string | null = null): Promise<boolean> {
    flushRecompute();
    const h = loadHealth();
    const texts: string[] = [];
    let rejected = false;
    if (st().serializeError === null) texts.push(withFinalNewline(st().textBuffer));
    else rejected = true;
    try {
      texts.push(exportModel(st().model, 'sysml'));
    } catch {
      rejected = true;
    }
    if (rejected) expect(h.unwritable, `${what}: no file holds the model`).not.toBeNull();
    for (const text of texts) {
      const loaded = await textApi.loadModelText(text, { fileName: 'x.sysml' });
      const r = loaded.report;
      if (h.errors === 0) {
        expect(r.ok, `${what}: health 0, but a terminal rejects\n${text}`).toBe(true);
        // …and a file holding it is the model on screen: Reachability over its parse is the page's.
        const onFile = runCheck(reachSpec, { model: loaded.model!, selectionId: null, selectionName: null, isolated: false, fileName: 'x.sysml', loadHealth: h });
        expect(onFile.verdict, `${what}: health 0, but a terminal's Reachability over the file differs\n${text}`).toBe(verdict(reachSpec, h));
      }
      if (!r.ok) rejected = true;
    }
    if (rejected) {
      expect(h.errors, `${what}: a terminal rejects the text`).toBeGreaterThan(0);
      expect(verdict(reachSpec, h), `${what}: Reachability over a text a terminal rejects`).not.toBe('holds');
      if (machine !== null) {
        expect(verdict(behaviourSpec, h, byName(machine)), `${what}: Behaviour properties over it`).not.toBe('holds');
      }
    }
    return rejected;
  }

  beforeEach(async () => {
    await whenLibrarySettled();
    lib.merge = null;
    reset();
    useAppStore.setState({ textBuffer: '', textDirty: false, diagnostics: [], serializeError: null });
  });

  /* B's probes: a transition's free text, typed in Properties. */
  const TERM = 'package T {\n  state def M {\n    state a;\n    state b;\n    state final;\n    transition go first a accept go then b;\n    transition b then final;\n  }\n}\n';
  const CARRIER = 'package F {\n  state def M {\n    @SysproseVerification::PropertyPattern { attribute pattern = "cover"; attribute scope = "globally"; attribute p = "state final"; }\n    state a;\n    state b;\n    state final;\n    transition t1 first a then b;\n    transition t2 first b then final;\n  }\n}\n';
  const PLAIN = 'package G {\n  state def M {\n    state a;\n    state b;\n    state final;\n    transition t1 first a then b;\n    transition t2 first b then final;\n  }\n}\n';
  const TRANSITION_TEXT: Array<[string, string, string, string]> = [
    // S2: a triggered machine.
    [TERM, 'go', 'trigger', 'go now'],
    [TERM, 'go', 'trigger', 'go;'],
    [TERM, 'go', 'guard', 'x >'],
    [TERM, 'go', 'guard', 'true )'],
    [TERM, 'go', 'effect', 'do do'],
    [TERM, 'go', 'effect', '}'],
    // S3: a property carrier on a trigger-free machine that ends.
    [CARRIER, 't1', 'effect', '}'],
    [CARRIER, 't1', 'effect', 'do do'],
    [CARRIER, 't1', 'trigger', ''],
    [CARRIER, 't1', 'guard', 'true )'],
    // S4: the same machine with no carrier, where the certificate vouched and Reachability read `holds`.
    [PLAIN, 't1', 'effect', '}'],
    [PLAIN, 't1', 'effect', 'do do'],
    [PLAIN, 't1', 'guard', 'true )'],
    [PLAIN, 't1', 'trigger', 'go now'],
  ];
  it('counts what a guard, a trigger or an effect typed in Properties does to the text (B: S2, S3, S4)', { timeout: 60_000 }, async () => {
    let rejected = 0;
    for (const [text, name, key, value] of TRANSITION_TEXT) {
      reset();
      await apply(text);
      const what = `${text.slice(8, 9)}: ${key} = ${JSON.stringify(value)}`;
      expect(loadHealth().errors, `${what}: clean, to start from`).toBe(0);
      st().setAttr(byName(name), key, value);
      if (await holdsTheLine(what, 'M')) rejected++;
    }
    // B found every one but the empty trigger rejected; the empty trigger is written as no trigger at all.
    expect(rejected).toBeGreaterThanOrEqual(TRANSITION_TEXT.length - 1);
  });

  it('counts an effect of `}` with the full standard library merged, and Behaviour properties is not `holds` (B: S6)', async () => {
    const actual = await vi.importActual<typeof import('../../src/library/full-library')>('../../src/library/full-library');
    await actual.preloadFullLibrary();
    lib.merge = (m: Model) => actual.loadFullStandardLibrary(m);
    try {
      await apply(CARRIER);
      const machine = st().model.all().find((e) => e.declaredName === 'M' && e.attrs.isLibrary !== true)!.id;
      const h0 = loadHealth();
      expect(h0.errors, 'with the library, the carrier loads').toBe(0);
      expect(verdict(behaviourSpec, h0, machine)).toBe('holds');
      st().setAttr(byName('t1'), 'effect', '}');
      flushRecompute();
      const h = loadHealth();
      const r = await terminal(withFinalNewline(st().textBuffer));
      expect(r.ok, 'a terminal rejects `do }`').toBe(false);
      expect(h.errors).toBeGreaterThan(0);
      expect(h.saved?.parseErrors).toBe(parseErrorsIn(r));
      expect(verdict(behaviourSpec, h, machine)).toBe('undecided');
      expect(verdict(reachSpec, h)).not.toBe('holds');
    } finally {
      lib.merge = null;
    }
  }, 120_000);

  /* E's probes: every field the serializer writes back verbatim, and the routes a value reaches it by. */
  const BASE = `package C {
  part def Ctl {
    attribute x = 1;
    state def M { state idle; state busy; transition t1 first idle then busy; transition t2 first busy then idle; }
  }
  part def Pump { attribute rate = 2; }
  part def Sys { part p : Pump; part c : Ctl; }
  constraint def Lim { in attribute a; a <= 10 }
}
`;
  const viaApi = (name: string, attrs: Record<string, unknown>) => () => {
    st().model.setAttrs(byName(name), attrs as never);
    st().regenerateText();
  };
  /** A model-JSON file of BASE, edited as a file can be: by name, `edit` changes one element's record. */
  const viaJson = (name: string, edit: (el: { eClass: string; attrs: Record<string, unknown> }) => void) => () => {
    const j = parseModel(BASE).model.toJSON() as { elements: Array<{ declaredName?: string; eClass: string; attrs: Record<string, unknown> }> };
    edit(j.elements.find((e) => e.declaredName === name)!);
    st().importModel(JSON.stringify(j), 'model-json');
  };
  const E_PROBES: Array<[string, () => void]> = [
    ['guard typo (Properties)', () => st().setAttr(byName('t1'), 'guard', 'x >')],
    ['effect typo (Properties)', () => st().setAttr(byName('t1'), 'effect', 'action (')],
    ['trigger typo (Properties)', () => st().setAttr(byName('t1'), 'trigger', 'a b }')],
    ['a value that reads alone but adds a declaration in place (LH-3)', () => st().setAttr(byName('rate'), 'value', '2; attribute rate = 3')],
    ['a value that adds a part def', () => st().setAttr(byName('rate'), 'value', '2; part def Pump')],
    ['an object value (API)', viaApi('rate', { value: { a: 1 }, valueText: undefined })],
    ['an array value (API)', viaApi('rate', { value: [1, 2], valueText: undefined })],
    ['NaN (API)', viaApi('rate', { value: NaN, valueText: undefined })],
    ['a quoted value with a raw line break', () => st().setAttr(byName('rate'), 'value', '"a\nb"')],
    ['a name with a line break', () => st().updateElement(byName('Pump'), { declaredName: 'Pu\nmp' })],
    ['an empty name', () => st().updateElement(byName('Pump'), { declaredName: '' })],
    ['a multiplicity typo (Properties)', () => st().setAttr(byName('p'), 'multiplicity', '1..')],
    ['an expression typo (API)', viaApi('Lim', { expression: 'a <=' })],
    ['a metadata name with a space (API)', viaApi('Pump', { metadata: ['my meta'] })],
    ['a unit with a line break (API)', viaApi('rate', { unit: 'k\ng' })],
    ['an unknown eClass (model JSON)', viaJson('Pump', (el) => (el.eClass = 'Bogus'))],
    ['an object value (model JSON)', viaJson('rate', (el) => (el.attrs = { ...el.attrs, value: { a: 1 }, valueText: undefined }))],
    ['a guard typo (model JSON)', viaJson('t1', (el) => (el.attrs = { ...el.attrs, guard: 'x >' }))],
    ['an effect that adds elements (Properties)', () => st().setAttr(byName('t1'), 'effect', 'a then idle; state idle; transition x first busy')],
  ];
  it('counts every verbatim field and every route a value takes in, as a terminal does (E: LH-1, LH-3)', { timeout: 60_000 }, async () => {
    let rejected = 0;
    for (const [what, edit] of E_PROBES) {
      reset();
      await apply(BASE);
      edit();
      await whenLibrarySettled();
      if (await holdsTheLine(what)) rejected++;
    }
    expect(rejected, 'the probes are texts a terminal rejects').toBeGreaterThanOrEqual(14);
  });

  it('counts a user package flagged as library: the text leaves it out, and a terminal cannot resolve it (E: LH-3)', async () => {
    const m = parseModel(BASE.replace('part c : Ctl; }', 'part c : Ctl; part q : MyLib::Thing; }') + 'package MyLib { part def Thing; }\n').model;
    for (const el of m.all()) {
      if (el.declaredName === 'MyLib' || m.ancestors(el.id).some((a) => a.declaredName === 'MyLib')) m.setAttrs(el.id, { isLibrary: true });
    }
    st().importModel(JSON.stringify(m.toJSON()), 'model-json');
    await whenLibrarySettled();
    expect(await holdsTheLine('isLibrary package'), 'a terminal rejects the text').toBe(true);
  });

  it('keeps a faulty line applied in the Text view at its error, however often the serializer writes it back (LH-2)', async () => {
    await apply(BASE);
    st().regenerateText();
    flushRecompute();
    const typed = st().textBuffer.replace('transition t1 first idle then busy;', 'transition t1 first idle if x > then busy;');
    expect(typed).not.toBe(st().textBuffer);
    await apply(typed);
    flushRecompute();
    // The guard is kept as typed, so the serializer writes the very text back — and sees nothing wrong in it.
    expect(withFinalNewline(serializeUserModelSignals(st().model).text)).toBe(withFinalNewline(typed));
    expect(serializeUserModelSignals(st().model).faults).toBe(0);
    const r = await terminal(typed);
    expect(r.ok).toBe(false);
    const h = loadHealth();
    expect(h.saved?.parseErrors, 'the apply’s own parse').toBe(parseErrorsIn(r));
    expect(h.errors).toBeGreaterThan(0);
    // The serializer writes it again (a refresh, a regenerate): its word does not replace the parse.
    st().regenerateText();
    expect(loadHealth()).toEqual(h);
    expect(loadHealth()).toEqual(h);
  });

  it('keeps a fallback parse when loadHealth runs again: 5/4 stays 5/4 (LH-2)', async () => {
    const WIRED = `package P {
  port def Pw;
  part def A { port pwrOut : Pw; }
  part def B { port pwrIn : Pw; }
  part def S {
    part a : A;
    part b : B;
    connection link connect a.pwrOut to b.pwrIn;
  }
  part def Ctl { state def M { state idle; state busy; transition t1 first idle then busy; transition t2 first busy then idle; } }
}
`;
    await apply(WIRED);
    st().updateElement(byName('pwrOut'), { declaredName: 'C' });
    st().setAttr(byName('t1'), 'effect', 'action (');
    await whenLibrarySettled();
    flushRecompute();
    const r = await terminal(withFinalNewline(st().textBuffer));
    const [h1, h2, h3] = [loadHealth(), loadHealth(), loadHealth()];
    expect(h1.saved?.parseErrors).toBe(parseErrorsIn(r));
    expect(h1.saved?.parseErrors).toBeGreaterThan(0);
    expect(h1.errors).toBeGreaterThanOrEqual(r.summary.errors);
    expect(h2).toEqual(h1);
    expect(h3).toEqual(h1);
  });

  it('takes a value the grammar cannot read on its own as faulty without a parse, and says so; a signal that finds nothing is not taken as clean', async () => {
    const measure = vi.spyOn(textApi, 'measureTextHealth');
    try {
      await apply(BASE);
      st().setAttr(byName('rate'), 'value', '1 +');
      flushRecompute();
      measure.mockClear();
      const h = loadHealth();
      expect(measure, 'faulty already: nothing to parse').not.toHaveBeenCalled();
      expect(h.saved?.basis).toBe('signal');
      expect(h.errors).toBeGreaterThan(0);
      expect(h.saved?.parseErrors).toBe(1);
      const row = degradedRow('reach', h);
      expect(row.message).toContain('was not parsed');
      expect(verdict(reachSpec, h)).not.toBe('holds');

      // A guard typo the serializer cannot see: it found nothing, which is not "clean" — the text is parsed.
      st().setAttr(byName('rate'), 'value', '2');
      st().setAttr(byName('t1'), 'guard', 'x >');
      flushRecompute();
      expect(serializeUserModelSignals(st().model).faults).toBe(0);
      measure.mockClear();
      const g = loadHealth();
      expect(measure).toHaveBeenCalledTimes(1);
      expect(g.saved?.basis).toBe('parse');
      expect(g.errors).toBeGreaterThan(0);
    } finally {
      measure.mockRestore();
    }
  });

  it('leaves to the parse a value the text around it can complete or close, and agrees with a terminal over it', async () => {
    const PLACED: Array<[string, () => void]> = [
      // `1 +` before a body is read as `1 + { … }`: the documentation becomes an operand.
      ['`1 +` before a body', () => {
        const doc = st().createElement('Documentation', byName('rate'));
        st().setAttr(doc, 'body', 'the pump rate');
        st().setAttr(byName('rate'), 'value', '1 +');
      }],
      // A `}` closes the owner, and the rest reads as a declaration of its own.
      ['a value that closes its owner', () => st().setAttr(byName('rate'), 'value', '1 } part def Z { attribute q = 2')],
      // A unit is written after the value.
      ['`1 +` before a unit', () => {
        st().setAttr(byName('rate'), 'value', '1 +');
        st().model.setAttrs(byName('rate'), { unit: 'kg' });
        st().regenerateText();
      }],
    ];
    for (const [what, edit] of PLACED) {
      reset();
      await apply(BASE);
      edit();
      flushRecompute();
      expect(serializeUserModelSignals(st().model).faults, `${what}: nothing the signal can be sure of`).toBe(0);
      const h = loadHealth();
      expect(h.saved?.basis, what).toBe('parse');
      const r = await terminal(withFinalNewline(st().textBuffer));
      expect(h.saved?.parseErrors, what).toBe(parseErrorsIn(r));
      // Where a terminal loads it, it loads another model than the one on screen (the body an operand, the owner closed).
      expect(h.errors > 0, `${what}: a terminal rejects it, or it is a file of another model`).toBe(!r.ok || h.otherModel === true);
      if (r.ok) expect(h.otherModel, what).toBe(true);
      await holdsTheLine(what);
    }
  });

  it('counts a text that parses cleanly to another model: a value written back as typed that adds or closes a declaration', async () => {
    const PUMPED = PLAIN.replace('\n}\n', '\n  part def Pump { attribute rate = 2; }\n}\n');
    const INJECTED = [
      // Adds a machine beside the value (at 5c257a1 the health read 0 and Reachability `holds`).
      '2; state def Z { state a; state b; state c; transition first a then b; } attribute zz = 0',
      // Closes its owner first (S1 handed this to the parse, which reads it cleanly).
      '2; } state def Z { state a; state b; state c; transition first a then b; } part def Q { attribute zz = 0',
    ];
    for (const v of INJECTED) {
      reset();
      await apply(PUMPED);
      const h0 = loadHealth();
      expect(h0.errors).toBe(0);
      expect(verdict(reachSpec, h0)).toBe('holds');
      st().setAttr(byName('rate'), 'value', v);
      flushRecompute();
      const h = loadHealth();
      // A terminal loads the file cleanly, and walks a second machine with findings in it…
      const loaded = await textApi.loadModelText(withFinalNewline(st().textBuffer), { fileName: 'x.sysml' });
      expect(loaded.report.ok, v).toBe(true);
      const onFile = runCheck(reachSpec, { model: loaded.model!, selectionId: null, selectionName: null, isolated: false, fileName: 'x.sysml', loadHealth: h0 });
      expect(onFile.verdict, v).toBe('issues');
      // …so the file is not the model on screen, and nothing holds over it.
      expect(h.saved, v).toMatchObject({ parseErrors: 0, basis: 'parse', otherModel: true });
      expect(h.otherModel, v).toBe(true);
      expect(h.errors, v).toBe(1);
      expect(verdict(reachSpec, h), v).toBe('undecided');
      expect(runCheck(reachSpec, { model: st().model, selectionId: null, selectionName: null, isolated: false, fileName: 'x.sysml', loadHealth: h }).summary, v).toContain('the text a file of it holds reads as another model');
      const row = degradedRow('reach', h).message;
      expect(row, v).toContain('parses cleanly, but to a model other than the one on screen');
      // The file loads: no exit code is claimed for it.
      expect(row, v).not.toContain('exits 1');
      expect(degradedRow('check-behaviour', h).message, v).not.toContain('exits 2');
    }
  });

  it('reads the note Save writes for an end no name reaches as another model: the file lacks the statement', async () => {
    // `bind w = p.load` over an unnamed redefinition: the unnamed `:>> load` is the first member of its name, so Save
    // writes the statement. A rename that gives a member before it that name makes the end the second of `load`, which no
    // name reaches, and Save writes a note where `bind w = T::p::«AttributeUsage»;` (a text a terminal refuses) was
    // written (fence-editor2 S2; fence-save-name).
    reset();
    await apply(
      'package T { part def P { attribute load = 1.0; } part p : P { attribute lo; attribute :>> load = 50.0; } attribute w; bind w = p.load; }\n',
    );
    expect(st().textBuffer).toContain('bind w = p.load;');
    expect(st().textBuffer).not.toContain('Not saved');
    expect(loadHealth().otherModel).toBe(false);
    st().updateElement(byName('lo'), { declaredName: 'load' });
    flushRecompute();
    expect(st().textBuffer).toContain('// Not saved: a binding whose end no name reaches');
    expect(st().textBuffer).not.toContain('«');
    const h = loadHealth();
    expect(h.saved).toMatchObject({ parseErrors: 0, basis: 'parse', otherModel: true });
    expect(h.otherModel).toBe(true);
    expect(runCheck(reachSpec, { model: st().model, selectionId: null, selectionName: null, isolated: false, fileName: 'x.sysml', loadHealth: h }).summary).toContain('the text a file of it holds reads as another model');
  });

  it('saves the binding of a duplicated unnamed redefinition: the first of the two is the end the file reads (fence-save-name)', async () => {
    // `duplicate` of `attribute :>> load = 50.0` leaves two members of one owner under one name beside `bind w = p.load`;
    // the end is the first of them, which the next open reads, so Save writes the statement (it wrote a note, and the file
    // lost the binding, so the constraint below read 1.0 in the file and 50.0 on the page).
    reset();
    await apply(
      'package T { part def P { attribute load = 1.0; } part p : P { attribute :>> load = 50.0; } attribute w; bind w = p.load; }\n',
    );
    const unnamed = st().model.children(byName('p')).find((e) => e.eClass === 'AttributeUsage' && e.declaredName === undefined && e.attrs.implicit !== true)!;
    st().duplicateElement(unnamed.id);
    flushRecompute();
    expect(st().model.children(byName('p')).filter((e) => e.eClass === 'AttributeUsage' && e.attrs.implicit !== true)).toHaveLength(2);
    expect(st().textBuffer).toContain('bind w = p.load;');
    expect(st().textBuffer).not.toContain('Not saved');
    expect(loadHealth().otherModel).toBe(false);
    const loaded = await textApi.loadModelText(withFinalNewline(st().textBuffer), { fileName: 'x.sysml' });
    const end = loaded.model!.all().find((e) => e.eClass === 'BindingConnectorAsUsage')!;
    expect(loaded.model!.get((end.target ?? [])[0] ?? '')?.attrs.value, 'the file binds w to the first, the 50').toBe(50);
  });

  it('counts only a faulty line the lexer reads as code: one inside a comment, or after a line note, is left to the parse', async () => {
    const PUMP = 'package G {\n  part def Pump {\n    attribute r1 = 1;\n    attribute r2 = 2;\n    attribute r3 = 3;\n  }\n}\n';
    // A comment one value opens and another closes, around a faulty value: inside it, the value is no code.
    await apply(PUMP);
    st().setAttr(byName('r1'), 'value', '1 /*');
    st().setAttr(byName('r2'), 'value', '1 +');
    st().setAttr(byName('r3'), 'value', '*/');
    flushRecompute();
    expect(serializeUserModelSignals(st().model).faults, 'the comment holds the faulty line').toBe(0);
    let h = loadHealth();
    let r = await terminal(withFinalNewline(st().textBuffer));
    expect(h.saved).toMatchObject({ basis: 'parse', parseErrors: parseErrorsIn(r) });
    expect(h.errors === 0).toBe(r.ok);
    // A line note in the type before the value: the line reads `attribute r2 : Real`, which parses — to another model.
    reset();
    await apply(PUMP);
    st().setAttr(byName('r2'), 'type', 'Real // kg');
    st().setAttr(byName('r2'), 'value', '1 +');
    flushRecompute();
    expect(serializeUserModelSignals(st().model).faults, 'the note holds the value').toBe(0);
    h = loadHealth();
    r = await terminal(withFinalNewline(st().textBuffer));
    expect(r.ok, 'a terminal loads it').toBe(true);
    expect(h.saved).toMatchObject({ basis: 'parse', parseErrors: 0, otherModel: true });
    expect(degradedRow('reach', h).message, 'and no exit code is claimed for it').not.toContain('exits 1');
    // The faulty line written into a documentation comment as well as in its place: only the one in code counts.
    reset();
    await apply(PUMP);
    const doc = st().createElement('Documentation', byName('Pump'));
    st().setAttr(doc, 'body', 'was:\nattribute r2 = 1 +;\nnow fixed');
    st().setAttr(byName('r2'), 'value', '1 +');
    flushRecompute();
    expect(serializeUserModelSignals(st().model).text.match(/^\s*attribute r2 = 1 \+;$/gm)).toHaveLength(2);
    expect(serializeUserModelSignals(st().model).faults).toBe(1);
    h = loadHealth();
    expect(h.saved).toMatchObject({ basis: 'signal', parseErrors: 1 });
    expect((await terminal(withFinalNewline(st().textBuffer))).ok).toBe(false);
  });

  it('says which text a parse counted and which the serializer judged without one', async () => {
    const T = 'package G {\n  part def Pump {\n    attribute rate = 1 +;\n    frobnicate z;\n    frobnicate y;\n  }\n  state def M { state a; state b; transition t1 first a if x > then b; }\n}\n';
    await apply(T);
    flushRecompute();
    const h = loadHealth();
    const saved = await terminal(withFinalNewline(st().textBuffer));
    expect(h.sameText).toBe(false);
    // The applied text is the apply's own parse; the export holds the value the serializer can see is faulty.
    expect(h.saved).toMatchObject({ basis: 'parse', parseErrors: parseErrorsIn(saved) });
    expect(h.exported).toMatchObject({ basis: 'signal', parseErrors: 1 });
    const row = degradedRow('reach', h).message;
    expect(row).toContain(`which Save writes, has ${parseErrorsIn(saved)} syntax error(s)`);
    expect(row).toContain('the text Export ▾ SysML writes holds 1 value(s) written back as typed that the grammar cannot read where they stand');
    expect((await terminal(exportModel(st().model, 'sysml'))).ok).toBe(false);
  });

  it('says at the click which texts no parse has measured, and parses none of them on the page', async () => {
    const measure = vi.spyOn(textApi, 'measureTextHealth');
    try {
      await apply(BASE);
      st().setAttr(byName('t1'), 'effect', '}');
      flushRecompute();
      measure.mockClear();
      const now = loadHealthNow();
      expect(measure, 'no parse on the page at the click').not.toHaveBeenCalled();
      expect('known' in now).toBe(false);
      if ('known' in now) return;
      expect(now.unmeasured).toEqual([withFinalNewline(st().textBuffer)]);
      // Nobody could measure it (the worker failed): never clean, and the row says why.
      const unchecked = now.unchecked('the background worker stopped');
      expect(unchecked.errors).toBeGreaterThan(0);
      expect(unchecked.unchecked).toBe('the background worker stopped');
      // The text nobody measured is not reported as parsed with 0 errors.
      expect(unchecked.saved).toEqual({ parseErrors: 0, basis: 'unmeasured', otherModel: false });
      expect(degradedRow('reach', unchecked).message).toContain('could not be checked (the background worker stopped)');
      expect(verdict(reachSpec, unchecked)).not.toBe('holds');
      // Measured (here, as the worker would): finished, and kept, so the next click knows it at once.
      const counts = now.unmeasured.map((t) => textApi.measureTextHealth(t, () => {}));
      const h = now.finish(counts);
      expect(h.saved?.parseErrors).toBe(counts[0].parseErrors);
      expect(h.errors).toBeGreaterThan(0);
      const again = loadHealthNow();
      expect('known' in again && again.known).toEqual(h);
      // The serializer writing the same text again does not undo the parse.
      st().regenerateText();
      const third = loadHealthNow();
      expect('known' in third && third.known).toEqual(h);
    } finally {
      measure.mockRestore();
    }
  });

  /*
   * What a click may read of the load without holding the page (review 2026-10-14, D-3): on the
   * drone-swarm model, writing its text and validating it take most of a second, so where reading
   * the load would do either, the palette starts the run first and reads once its row is drawn.
   */
  it('says whether the load can be read without work on the page: never while an edit’s recompute waits, nor with the text or the validation behind the model', async () => {
    const write = vi.spyOn(textApi, 'serializeUserModelSignals');
    const validate = vi.spyOn(validationApi, 'validateSteps');
    const work = (): number => write.mock.calls.length + validate.mock.calls.length;
    try {
      await apply(BASE);
      flushRecompute();
      expect(loadHealthAtHand(), 'an applied text: written and validated').toBe(true);
      // At hand, the read only looks up: no text written, no validation.
      write.mockClear();
      validate.mockClear();
      loadHealthNow();
      expect(work()).toBe(0);

      // An edit: its recompute waits, and a read now would run it here.
      st().updateElement(byName('Pump'), { declaredName: 'Pump2' });
      expect(recomputePending()).toBe(true);
      expect(loadHealthAtHand()).toBe(false);
      flushRecompute();
      expect(loadHealthAtHand(), 'the recompute ran: the text written, the model validated').toBe(true);

      // A change no recompute follows (the model edited in place): its text and validation are behind it.
      st().model.rename(byName('Pump2'), 'Pump3');
      expect(recomputePending()).toBe(false);
      expect(loadHealthAtHand()).toBe(false);
      write.mockClear();
      validate.mockClear();
      loadHealthNow();
      expect(write, 'read anyway, the model is written once').toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalled();
      expect(loadHealthAtHand(), 'that read wrote and validated it').toBe(true);

      // Text typed in the Text view and not applied: Save's text is then the model's own, which is
      // written already, so the read writes nothing again.
      st().setTextBuffer(`${st().textBuffer}\n// typed, not applied\n`);
      expect(st().textDirty).toBe(true);
      expect(loadHealthAtHand()).toBe(true);
      write.mockClear();
      validate.mockClear();
      const typed = loadHealthNow();
      expect(work()).toBe(0);
      expect('known' in typed ? typed.known.sameText : typed.unmeasured.length === 1, 'Save and Export write one text').toBe(true);
    } finally {
      write.mockRestore();
      validate.mockRestore();
    }
  });

  /* The corpus, through the store: applied, written back, and loaded as a terminal loads it. */
  const corpus = (): Array<[string, string]> => {
    const dir = 'test/fixtures/verification/models';
    return [
      ...readdirSync(resolve(process.cwd(), dir))
        .filter((f) => f.endsWith('.sysml'))
        .sort()
        .map((f): [string, string] => [`${dir}/${f}`, readFileSync(resolve(process.cwd(), dir, f), 'utf8')]),
      ...readdirSync(resolve(process.cwd(), 'examples'))
        .filter((f) => f.endsWith('.sysml'))
        .sort()
        .map((f): [string, string] => [`examples/${f}`, readFileSync(resolve(process.cwd(), 'examples', f), 'utf8')]),
    ];
  };
  it('agrees with a terminal over the corpus: each text’s parse errors exactly, and 0 errors only where both texts load', async () => {
    const files = corpus();
    expect(files.length).toBeGreaterThan(70);
    let faulty = 0;
    for (const [file, text] of files) {
      reset();
      await apply(text);
      flushRecompute();
      const h = loadHealth();
      const saved = await terminal(withFinalNewline(st().textBuffer));
      expect(h.saved?.parseErrors, `${file}: the text Save writes`).toBe(parseErrorsIn(saved));
      if (!h.sameText) expect(h.exported?.parseErrors, `${file}: the text Export writes`).toBe(parseErrorsIn(await terminal(exportModel(st().model, 'sysml'))));
      // A model as written back is a file of itself: the parse of the export text writes that text again.
      if (h.exported?.parseErrors === 0) expect(h.exported.otherModel, `${file}: the text Export writes is a file of another model`).toBe(false);
      if (await holdsTheLine(file)) faulty++;
    }
    // The corpus is mostly clean models; the fixtures that test a typo are not.
    expect(faulty).toBeGreaterThan(0);
    expect(faulty).toBeLessThan(files.length);
  }, 120_000);

  /*
   * A mutation fuzz of every field the serializer writes back verbatim, on a model
   * Reachability reads `holds` over: each value set the way a person or a program
   * can set it (Properties, the explorer's rename, the API and model JSON). The
   * model names no library type, so nothing in it but the field fuzzed can make a
   * text fail: what 679a5e5's certificate vouched for without a parse.
   */
  const FUZZ = `package Fz {
  state def M {
    state s1;
    state s2;
    state final;
    transition t1 first s1 then s2;
    transition t2 first s2 then final;
  }
  part def Pump { attribute rate = 2; }
  constraint def Lim { in attribute lim; lim <= 10 }
  part def Sys { part p : Pump [1]; }
}
`;
  /** Values that close their owner or add a machine and parse cleanly: a file of another model. */
  const INJECTIONS = [
    '2; state def Z { state a; state b; state c; transition first a then b; } attribute zz = 0',
    '2; } state def Z { state a; state b; state c; transition first a then b; } part def Q { attribute zz = 0',
  ];
  const setIn = (name: string, key: string, value: string) => () => st().setAttr(byName(name), key, value);
  const setRaw = (name: string, attrs: Record<string, unknown>) => () => {
    st().model.setAttrs(byName(name), attrs as never);
    st().regenerateText();
  };
  const renamed = (name: string, to: string) => () => st().updateElement(byName(name), { declaredName: to });
  const FUZZ_CASES: Array<[string, () => void]> = [
    ...['}', 'do do', 'action (', 'a then s1; state s9; transition x first s2', '{', 'send'].map((v): [string, () => void] => [`effect ${JSON.stringify(v)}`, setIn('t1', 'effect', v)]),
    ...['true )', 'x >', '(', '"', 'x > 0 then s2'].map((v): [string, () => void] => [`guard ${JSON.stringify(v)}`, setIn('t1', 'guard', v)]),
    ...['go now', 'go;', 'a b }', 'after', '{'].map((v): [string, () => void] => [`trigger ${JSON.stringify(v)}`, setIn('t1', 'trigger', v)]),
    ...['2; attribute rate = 3', '1 +', '"a\nb"', '2 )', '2; part def Pump', '1 // c', '2 }', '"open', "'q", '2 [kg', ...INJECTIONS].map(
      (v): [string, () => void] => [`value ${JSON.stringify(v)}`, setIn('rate', 'value', v)],
    ),
    ...['Real // kg', 'Real; part def Z', 'Real }', 'Real = 3; attribute q'].map((v): [string, () => void] => [`type ${JSON.stringify(v)}`, setIn('rate', 'type', v)]),
    ...[{ a: 1 }, [1, 2], NaN, Infinity, true].map((v): [string, () => void] => [`value ${JSON.stringify(v) ?? String(v)} (API)`, setRaw('rate', { value: v, valueText: undefined })]),
    ...['lim <=', 'lim <= 10 }', 'lim <= 10; attribute q', ')'].map((v): [string, () => void] => [`expression ${JSON.stringify(v)} (API)`, setRaw('Lim', { expression: v })]),
    ...[['my meta'], ['X\nY'], ['A;B'], ['}']].map((v): [string, () => void] => [`metadata ${JSON.stringify(v)} (API)`, setRaw('Pump', { metadata: v })]),
    ...['k\ng', 'kg]', 'kg; part def Z'].map((v): [string, () => void] => [`unit ${JSON.stringify(v)} (API)`, setRaw('rate', { unit: v })]),
    ...['1..', '1 2', '1]', '*..*'].map((v): [string, () => void] => [`multiplicity ${JSON.stringify(v)}`, setIn('p', 'multiplicity', v)]),
    ...['sideways', 'in out'].map((v): [string, () => void] => [`direction ${JSON.stringify(v)} (API)`, setRaw('lim', { direction: v })]),
    ...['Pu\nmp', '', 'done', "a'b", 'part', 'Pump Two', 'Pump;'].map((v): [string, () => void] => [`name ${JSON.stringify(v)}`, renamed('Pump', v)]),
    ...['s\n2', 'state'].map((v): [string, () => void] => [`state name ${JSON.stringify(v)}`, renamed('s2', v)]),
  ];
  it('a mutation fuzz of every verbatim field: 0 errors only over texts a terminal loads as the model on screen, and Reachability never `holds` over one it rejects', async () => {
    await apply(FUZZ);
    const h0 = loadHealth();
    expect(h0.errors, 'the fuzz starts from a clean model').toBe(0);
    expect(verdict(reachSpec, h0), 'over which Reachability holds').toBe('holds');
    let rejected = 0;
    for (const [what, edit] of FUZZ_CASES) {
      reset();
      await apply(FUZZ);
      edit();
      await whenLibrarySettled();
      if (await holdsTheLine(what)) rejected++;
    }
    expect(rejected, 'the fuzz must make texts a terminal rejects, or it compares clean with clean').toBeGreaterThanOrEqual(30);
  }, 120_000);
});

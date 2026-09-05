import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Model } from '@core/index';

// The store kicks off an async standard-library merge at module load; stub it so
// the singleton model stays deterministic for these reducer tests (finding C12).
vi.mock('../../src/library/full-library', () => ({
  loadFullStandardLibrary: () => {},
  preloadFullLibrary: async () => {},
}));
vi.mock('../../src/library/standard-library', () => ({
  loadCuratedLibrary: () => {},
}));

import { useAppStore } from '../../src/ui/store';
import { parseModel, serializeModel } from '@text/index';
import {
  NOTE_BODY_TERMINATOR,
  getRequirementAttr,
  requirementShortId,
  statementKindOf,
} from '@semantics/index';

/** Reset the singleton store to a fresh, empty model before each test. */
function reset(): void {
  useAppStore.setState({
    model: new Model(),
    undoStack: [],
    redoStack: [],
    selectionId: null,
    selectionIds: [],
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
});

/**
 * The Properties panel's Kind selector and requirement-attributes block.
 *
 * `properties-all-fields.spec.ts` drives both in a real browser on a healthy
 * requirement. What it cannot reach is the row the writer REFUSES — a
 * requirement whose declaration did not parse — and that is where the control
 * was live, wrote nothing, and said nothing. It is pinned here because a faulted
 * declaration is a parse result, not something a click can produce in the app.
 *
 * Also Ctrl/Cmd+S typed into the panel's fields, which the page's listener
 * takes: the panel rendered is where a box that writes on leaving it, and a
 * facet box rebuilt around the value it wrote, can be held to the key.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { Model } from '@core/index';

vi.mock('../../src/library/full-library', () => ({
  loadFullStandardLibrary: () => {},
  preloadFullLibrary: async () => {},
}));
vi.mock('../../src/library/standard-library', () => ({
  loadCuratedLibrary: () => {},
}));

import { useAppStore } from '../../src/ui/store';
import { handlePageKey } from '../../src/ui/commands';
import { Properties } from '../../src/ui/panels/Properties';
import { parseModel } from '@text/index';
import {
  NOTE_BODY_TERMINATOR,
  getRequirementAttr,
  keywordsOnRecord,
  untaggedStatementKindLabel,
} from '@semantics/index';

/** Load `src`, select the element named `name`, and render the panel over it. */
function mount(src: string, name: string) {
  const { model } = parseModel(src);
  const el = model.all().find((e) => e.declaredName === name);
  expect(el, `no element named ${name}`).toBeDefined();
  useAppStore.setState({
    model,
    undoStack: [],
    redoStack: [],
    rev: 0,
    selectionId: el!.id,
    selectionIds: [el!.id],
  });
  return { view: render(React.createElement(Properties)), id: el!.id, model };
}

beforeEach(() => {
  useAppStore.setState({ model: new Model(), undoStack: [], redoStack: [], rev: 0 });
});

const FAULTED =
  `package P {\n` +
  `    requirement <R1> healthy { subject s; }\n` +
  `    wibble\n` +
  `    requirement <R2> faulted { subject t; }\n}`;

describe('Properties — the requirement attributes block', () => {
  it('is live on a requirement whose declaration parsed', () => {
    const { view } = mount(FAULTED, 'healthy');
    expect((view.getByTestId('prop-rm-status') as HTMLSelectElement).disabled).toBe(false);
    expect((view.getByTestId('prop-rm-rationale') as HTMLInputElement).disabled).toBe(false);
  });

  /**
   * `setRequirementAttr` throws for this element — the saved file re-emits the
   * requirement's own source verbatim, so a facet written here is gone on the
   * next save — and the store logs the throw to a console nobody has open. A
   * control the write will refuse belongs disabled, with the reason on it.
   */
  it('is disabled, with the reason on it, when the declaration did not parse', () => {
    const { view, model, id } = mount(FAULTED, 'faulted');
    expect(typeof model.require(id).attrs.unparsedText).toBe('string');
    const status = view.getByTestId('prop-rm-status') as HTMLSelectElement;
    expect(status.disabled).toBe(true);
    expect(status.title).toMatch(/could not be parsed/i);
    const rationale = view.getByTestId('prop-rm-rationale') as HTMLInputElement;
    expect(rationale.disabled).toBe(true);
    expect(rationale.title).toMatch(/could not be parsed/i);
    // The Kind selector already asks the same question its own way: a faulted
    // declaration has nowhere to put a keyword either, so it is not offered.
    expect(view.queryByTestId('prop-statement-kind')).toBeNull();
  });
});

/**
 * A residue carrier's subtree is re-emitted with it, verbatim: a requirement
 * NESTED in a faulted declaration has no residue of its own, so the element-only
 * guard offered it live controls and the next save dropped what they wrote.
 */
describe('Properties — a requirement nested inside a faulted declaration', () => {
  const NESTED =
    `package P {\n` +
    `    blok def Vehicle {\n` +
    `        requirement <R1> nested { subject s; }\n` +
    `    }\n` +
    `    requirement <R2> outside { subject t; }\n}`;

  it('disables the facet controls, with the reason on them', () => {
    const { view, model, id } = mount(NESTED, 'nested');
    expect(model.require(id).attrs.unparsedText).toBeUndefined();
    const status = view.getByTestId('prop-rm-status') as HTMLSelectElement;
    expect(status.disabled).toBe(true);
    expect(status.title).toMatch(/could not be parsed/i);
    expect((view.getByTestId('prop-rm-rationale') as HTMLInputElement).disabled).toBe(true);
    expect(view.queryByTestId('prop-statement-kind')).toBeNull();
  });

  // The id box is a facet like the others: its writer refuses an id that
  // would not reach the file, so the box is locked with the same reason.
  it('disables the id box, with the reason on it', () => {
    const { view } = mount(NESTED, 'nested');
    const box = view.getByTestId('prop-reqId') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.title).toMatch(/could not be parsed/i);
  });

  it('leaves the requirement outside the residue live', () => {
    const { view } = mount(NESTED, 'outside');
    expect((view.getByTestId('prop-rm-status') as HTMLSelectElement).disabled).toBe(false);
    expect((view.getByTestId('prop-reqId') as HTMLInputElement).disabled).toBe(false);
    expect(view.queryByTestId('prop-statement-kind')).not.toBeNull();
  });
});

/**
 * The id box wrote the legacy `attrs.reqId` alone, which the serializer only
 * falls back to: the box showed the new id and the file kept the old one.
 */
describe('Properties — the requirement id box', () => {
  it('shows the short name and writes the slot the file keeps', () => {
    const { view, model, id } = mount(`package P {\n    requirement <R1> maxMass;\n}`, 'maxMass');
    const box = view.getByTestId('prop-reqId') as HTMLInputElement;
    expect(box.value).toBe('R1');
    act(() => {
      fireEvent.change(box, { target: { value: 'R9' } });
    });
    expect(model.require(id).declaredShortName).toBe('R9');
    expect(model.require(id).attrs.reqId).toBeUndefined();
    expect((view.getByTestId('prop-reqId') as HTMLInputElement).value).toBe('R9');
  });

  /**
   * The generic "Short name" box wrote the same slot through `updateElement`,
   * which leaves the legacy `attrs.reqId` standing and cannot clear the slot,
   * so a requirement had two boxes for one field that disagreed after an edit.
   */
  it('is the only short-name control a requirement gets', () => {
    const { view } = mount(`package P {\n    requirement <R1> maxMass;\n}`, 'maxMass');
    expect(view.queryByTestId('prop-shortName')).toBeNull();
    expect(view.queryByTestId('prop-reqId')).not.toBeNull();
  });

  it('leaves the generic Short name box on everything that is not a requirement', () => {
    const { view } = mount(`package P {\n    part def <V1> Vehicle;\n}`, 'Vehicle');
    expect((view.getByTestId('prop-shortName') as HTMLInputElement).value).toBe('V1');
    expect(view.queryByTestId('prop-reqId')).toBeNull();
  });
});

describe('Properties — the Kind selector', () => {
  it('sits on the blank entry for an untagged requirement, labelled with what it reads as', () => {
    const { view } = mount(`package P {\n    requirement <R1> maxMass;\n}`, 'maxMass');
    const kind = view.getByTestId('prop-statement-kind') as HTMLSelectElement;
    expect(kind.value).toBe('');
    const blank = kind.querySelector('option[value=""]')!;
    expect(blank.textContent).toBe(untaggedStatementKindLabel('requirement'));
    // Two entries reading the same word would be indistinguishable to a reader
    // and to a test: the blank must never be spelled `requirement`.
    expect(
      [...kind.querySelectorAll('option')].filter((o) => o.textContent === 'requirement').length,
    ).toBe(1);
  });

  it('shows the written kind when there is one', () => {
    const { view } = mount(`package P {\n    #prose requirement <R1> aNote;\n}`, 'aNote');
    expect((view.getByTestId('prop-statement-kind') as HTMLSelectElement).value).toBe('prose');
  });

  it('offers the blank as plain `(untagged)` where the metaclass implies nothing', () => {
    const { view } = mount(`package P {\n    part p1;\n}`, 'p1');
    const kind = view.getByTestId('prop-statement-kind') as HTMLSelectElement;
    expect(kind.value).toBe('');
    expect(kind.querySelector('option[value=""]')!.textContent).toBe('(untagged)');
  });
});

/**
 * The two free-text boxes in the panel — Documentation and Requirement text —
 * are the other half of the same refusal. Both write straight into a note body,
 * and a note body has no escape for the characters that end it: a value
 * carrying them cannot be written back, so the panel must refuse the keystroke
 * and say so rather than store a value the next save cannot hold.
 */
describe('Properties — a note body the file cannot hold', () => {
  const INJECTION = `mass <= 25 kg ${NOTE_BODY_TERMINATOR} satisfy R1 by V; doc /*`;

  it('refuses a requirement statement carrying the note terminator, with the reason', () => {
    const { view, id } = mount(`package P {\n    requirement <R1> maxMass;\n}`, 'maxMass');
    const before = useAppStore.getState().model.require(id).attrs.text;
    fireEvent.change(view.getByTestId('prop-text'), { target: { value: INJECTION } });
    expect(useAppStore.getState().model.require(id).attrs.text, 'nothing was written').toBe(before);
    expect(view.getByTestId('prop-note-refusal').textContent).toMatch(/close the note/i);
  });

  it('refuses the same body in the Documentation box', () => {
    const { view, id } = mount(`package P {\n    part p1 {\n        doc /* fine */\n    }\n}`, 'p1');
    const model = useAppStore.getState().model;
    const doc = model.children(id).find((c) => c.eClass === 'Documentation')!;
    fireEvent.change(view.getByTestId('prop-doc'), { target: { value: INJECTION } });
    expect(useAppStore.getState().model.require(doc.id).attrs.body).toBe('fine');
    expect(view.getByTestId('prop-note-refusal').textContent).toMatch(/close the note/i);
  });

  it('writes an ordinary statement and takes the refusal back down', () => {
    const { view, id } = mount(`package P {\n    requirement <R1> maxMass;\n}`, 'maxMass');
    fireEvent.change(view.getByTestId('prop-text'), { target: { value: INJECTION } });
    expect(view.queryByTestId('prop-note-refusal')).not.toBeNull();
    fireEvent.change(view.getByTestId('prop-text'), { target: { value: 'under 25 kg' } });
    expect(useAppStore.getState().model.require(id).attrs.text).toBe('under 25 kg');
    expect(view.queryByTestId('prop-note-refusal')).toBeNull();
  });

  it('does not re-show the refusal when the element is selected again', () => {
    // The notice belongs to the attempt, not to the element. It was kept in
    // component state that nothing reset on a selection change, so looking at
    // another element and coming back put a red refusal under a box the author
    // had not touched since — a report of something that did not just happen.
    const { view, model } = mount(
      `package P {\n    requirement <R1> maxMass;\n    requirement <R2> other;\n}`,
      'maxMass',
    );
    fireEvent.change(view.getByTestId('prop-text'), { target: { value: INJECTION } });
    expect(view.queryByTestId('prop-note-refusal')).not.toBeNull();

    const first = useAppStore.getState().selectionId!;
    const second = model.all().find((e) => e.declaredName === 'other')!.id;
    act(() => {
      useAppStore.setState({ selectionId: second, selectionIds: [second] });
    });
    expect(view.queryByTestId('prop-note-refusal'), 'another element was never refused').toBeNull();

    act(() => {
      useAppStore.setState({ selectionId: first, selectionIds: [first] });
    });
    expect(view.queryByTestId('prop-note-refusal'), 'coming back is not another attempt').toBeNull();
  });
});

/**
 * The Documentation box makes its doc lazily, on the first key, through
 * `createElement`, and finds it again under the element on the next. Under an
 * element of the standard library `createElement` puts a new element at the
 * top level of the model instead — the text leaves the library out — so the
 * box never found its doc: each key made another top-level `doc` comment,
 * holding that one key, in the user's own text — an Undo step and the strip's
 * note with it — and the box stayed empty. The box is read-only there, with
 * the reason on it.
 */
describe('Properties — the Documentation box of an element in the standard library', () => {
  /** The user's package, and a library package holding a part definition — documented when `doc` is given. */
  function mountLibrary(doc?: string) {
    const { model } = parseModel('package Mine { part def Wing; }');
    const shelf = model.create('Package', { declaredName: 'Shelf', attrs: { isLibrary: true } }).id;
    const shelved = model.create('PartDefinition', { declaredName: 'Shelved', ownerId: shelf, attrs: { isLibrary: true } }).id;
    // No flag of its own, under a library root: in the library all the same.
    const stray = model.create('PartDefinition', { declaredName: 'Stray', ownerId: shelf }).id;
    if (doc !== undefined) model.create('Documentation', { ownerId: shelved, attrs: { body: doc, isLibrary: true } });
    useAppStore.setState({ model, undoStack: [], redoStack: [], rev: 0, selectionId: shelved, selectionIds: [shelved] });
    return { view: render(React.createElement(Properties)), model, shelved, stray };
  }
  const docs = () => useAppStore.getState().model.all().filter((e) => e.eClass === 'Documentation');
  /** Type `text` into the box one key at a time, as the browser's change events come. */
  const type = (box: () => HTMLTextAreaElement, text: string): void => {
    for (const key of text) fireEvent.change(box(), { target: { value: box().value + key } });
  };

  it('is read-only, with the reason on it, and typing into it makes nothing', () => {
    const { view, model } = mountLibrary();
    const box = () => view.getByTestId('prop-doc') as HTMLTextAreaElement;
    expect(box().readOnly).toBe(true);
    expect(box().title).toMatch(/standard library, which is not part of your model.s text/);
    const size = model.all().length;
    type(box, 'Wheel');
    expect(docs(), 'no doc, at the top level or anywhere').toEqual([]);
    expect(model.all().length).toBe(size);
    expect(useAppStore.getState().undoStack, 'no Undo step').toEqual([]);
    expect(useAppStore.getState().drive.notice, 'and nothing to say').toBeNull();
  });

  it('shows a library element’s own documentation, and leaves it as it is', () => {
    const { view } = mountLibrary('As the library has it.');
    const box = () => view.getByTestId('prop-doc') as HTMLTextAreaElement;
    expect(box().value).toBe('As the library has it.');
    expect(box().readOnly).toBe(true);
    type(box, '!');
    expect(docs().map((d) => d.attrs.body)).toEqual(['As the library has it.']);
  });

  it('is read-only on an element of nobody’s flag left under a library root too — and live on the user’s own', () => {
    const { view, model, stray } = mountLibrary();
    act(() => {
      useAppStore.setState({ selectionId: stray, selectionIds: [stray] });
    });
    const box = () => view.getByTestId('prop-doc') as HTMLTextAreaElement;
    expect(box().readOnly).toBe(true);

    const wing = model.all().find((e) => e.declaredName === 'Wing')!.id;
    act(() => {
      useAppStore.setState({ selectionId: wing, selectionIds: [wing] });
    });
    expect(box().readOnly).toBe(false);
    expect(box().title).toBe('');
    type(box, 'abc');
    expect(box().value).toBe('abc');
    expect(docs().map((d) => [d.ownerId, d.attrs.body]), 'one doc, under the element, holding every key').toEqual([[wing, 'abc']]);
  });
});

/**
 * Ctrl/Cmd+S typed into a Properties field is the app's Save, never the
 * browser's "Save page" dialog. The page's listener used to ignore every key
 * typed into a field, and forwarding the key alone would have saved without the
 * value on screen: the facet boxes, Tags and Subject write on Enter or on
 * leaving the box, not per keystroke. The box is committed first, as leaving it
 * does, then the project is saved, and the box has its focus back.
 */
describe('Properties — Ctrl/Cmd+S typed into a field', () => {
  const REQ = `package P {\n    requirement <R1> maxMass;\n}`;
  const saveProject = useAppStore.getState().saveProject;
  /** What each save in this browser held: the rationale facet and the tags of the selection. */
  let held: Array<{ rationale: string | undefined; tags: string[] }> = [];

  beforeEach(() => {
    // The page's keydown listener, as `App` installs it.
    window.addEventListener('keydown', handlePageKey);
    held = [];
    useAppStore.setState((s) => ({
      drive: { ...s.drive, configStatus: 'absent' },
      saveProject: async () => {
        const { model, selectionId } = useAppStore.getState();
        held.push({
          rationale: getRequirementAttr(model, selectionId!, 'rationale'),
          tags: keywordsOnRecord(model.require(selectionId!)).map((k) => k.written),
        });
      },
    }));
  });
  afterEach(() => {
    window.removeEventListener('keydown', handlePageKey);
    useAppStore.setState({ saveProject });
  });

  it('writes a requirement attribute typed and not yet written, then saves it — and the caret goes back into the box', async () => {
    const { view, model, id } = mount(REQ, 'maxMass');
    const box = view.getByTestId('prop-rm-rationale') as HTMLInputElement;
    box.focus();
    fireEvent.change(box, { target: { value: 'Road limit' } });
    box.setSelectionRange(4, 4);
    expect(getRequirementAttr(model, id, 'rationale'), 'written on leaving the box').toBeUndefined();
    const depth = useAppStore.getState().undoStack.length;

    expect(fireEvent.keyDown(box, { key: 's', ctrlKey: true }), 'default prevented').toBe(false);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(held[0]).toEqual({ rationale: 'Road limit', tags: [] });
    expect(useAppStore.getState().undoStack.length, 'one Undo step, as leaving the box takes').toBe(depth + 1);
    // The box is rebuilt around the value it wrote: the caret is in the new one, where it was.
    const again = view.getByTestId('prop-rm-rationale') as HTMLInputElement;
    expect(again).not.toBe(box);
    expect(document.activeElement).toBe(again);
    expect(again.value).toBe('Road limit');
    expect([again.selectionStart, again.selectionEnd]).toEqual([4, 4]);

    // Cmd+S with nothing new typed: saved again, nothing written.
    expect(fireEvent.keyDown(again, { key: 's', metaKey: true }), 'default prevented').toBe(false);
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(useAppStore.getState().undoStack.length).toBe(depth + 1);
    expect(document.activeElement).toBe(view.getByTestId('prop-rm-rationale'));
  });

  it('writes the tags typed and not yet applied, then saves them — the box keeps the focus', async () => {
    const { view } = mount(REQ, 'maxMass');
    const box = view.getByTestId('prop-tags') as HTMLInputElement;
    box.focus();
    fireEvent.change(box, { target: { value: '#Hazard' } });
    expect(fireEvent.keyDown(box, { key: 's', ctrlKey: true }), 'default prevented').toBe(false);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(held[0]!.tags).toEqual(['Hazard']);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe('#Hazard');
  });

  it('saves from a select or a read-only box without leaving it', async () => {
    const { view } = mount(REQ, 'maxMass');
    for (const testid of ['prop-rm-status', 'prop-eclass']) {
      const field = view.getByTestId(testid);
      field.focus();
      let left = 0;
      field.addEventListener('blur', () => left++);
      const saves = held.length;
      expect(fireEvent.keyDown(field, { key: 's', ctrlKey: true }), `${testid}: default prevented`).toBe(false);
      await vi.waitFor(() => expect(held).toHaveLength(saves + 1));
      expect(left, `${testid}: a select writes on change, a read-only box holds nothing typed`).toBe(0);
      expect(document.activeElement).toBe(field);
    }
  });

  it('leaves every other key typed into a field to the field — Ctrl/Cmd+Shift+S too, without Google Drive', () => {
    const { view, model, id } = mount(REQ, 'maxMass');
    const box = view.getByTestId('prop-rm-rationale') as HTMLInputElement;
    box.focus();
    fireEvent.change(box, { target: { value: 'Road limit' } });
    const before = { view: useAppStore.getState().activeView, depth: useAppStore.getState().undoStack.length };
    for (const init of [
      { key: 'z', ctrlKey: true },
      { key: 'y', ctrlKey: true },
      { key: 'd', ctrlKey: true },
      { key: 'Backspace' },
      { key: 'Delete' },
      { key: '3' },
      { key: 's' },
      { key: 'S', ctrlKey: true, shiftKey: true },
    ]) {
      expect(fireEvent.keyDown(box, init), JSON.stringify(init)).toBe(true);
    }
    expect(held, 'nothing saved').toEqual([]);
    expect(getRequirementAttr(model, id, 'rationale'), 'nothing written').toBeUndefined();
    expect(model.get(id), 'nothing deleted').toBeDefined();
    expect(useAppStore.getState().activeView).toBe(before.view);
    expect(useAppStore.getState().undoStack.length).toBe(before.depth);
    expect(document.activeElement).toBe(box);
  });
});

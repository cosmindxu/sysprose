/**
 * The Requirements panel's FACET CELLS — the Kind column and the nine
 * management attributes — driven through the real store.
 *
 * `test/unit/requirements-table.test.ts` covers the pure projection: which
 * columns exist, in what order, with which closed lists. Nothing covered the
 * ~110 lines of editing UI that turn that projection into writes, and both
 * defects this file now pins lived exactly there: a control that was live on a
 * row the writer refuses, and a Kind cell that could not express the state most
 * rows are in. The panel is rendered against the singleton store, so a cell
 * wired to the wrong column key or the wrong command fails here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { Model } from '@core/index';

// The store kicks off an async standard-library merge at module load; stub it so
// the singleton model stays deterministic (same reason as store.reducers.test).
vi.mock('../../src/library/full-library', () => ({
  loadFullStandardLibrary: () => {},
  preloadFullLibrary: async () => {},
}));
vi.mock('../../src/library/standard-library', () => ({
  loadCuratedLibrary: () => {},
}));

import { useAppStore } from '../../src/ui/store';
import { RequirementsTable } from '../../src/ui/panels/RequirementsTable';
import { parseModel, serializeModel } from '@text/index';
import {
  NOTE_BODY_TERMINATOR,
  getRequirementAttr,
  statementKindOf,
  untaggedStatementKindLabel,
  writtenStatementKind,
} from '@semantics/index';

const st = () => useAppStore.getState();

/** Load `src` into the store and render the panel over it. */
function mount(src: string) {
  const { model } = parseModel(src);
  useAppStore.setState({
    model,
    undoStack: [],
    redoStack: [],
    rev: 0,
    selectionId: null,
    selectionIds: [],
  });
  return render(React.createElement(RequirementsTable));
}

/** The cell of row `name` in column `key`, found through the rendered grid. */
function cell(view: ReturnType<typeof mount>, name: string, key: string): HTMLElement {
  const row = view
    .getAllByTestId('req-row')
    .find((r) => r.textContent?.includes(name) || rowName(r) === name);
  expect(row, `no row for ${name}`).toBeDefined();
  const found = row!.querySelector(`[data-testid="req-attr-cell"][data-col-key="${key}"]`);
  expect(found, `row ${name} has no ${key} cell`).toBeTruthy();
  return found as HTMLElement;
}

function rowName(row: HTMLElement): string {
  return row.querySelector('[data-col-key="name"]')?.textContent ?? '';
}

/** The element id of the row showing `name`. */
function idOf(view: ReturnType<typeof mount>, name: string): string {
  const row = view.getAllByTestId('req-row').find((r) => rowName(r).includes(name));
  expect(row, `no row for ${name}`).toBeDefined();
  return row!.getAttribute('data-element-id')!;
}

beforeEach(() => {
  useAppStore.setState({ model: new Model(), undoStack: [], redoStack: [], rev: 0 });
});

describe('Requirements panel — a closed-list facet cell', () => {
  const SRC = `package P {\n    requirement <R1> maxMass {\n        subject v;\n    }\n}`;

  it('writes the picked value through the undo-safe command', () => {
    const view = mount(SRC);
    const id = idOf(view, 'maxMass');
    const select = cell(view, 'maxMass', 'status').querySelector('select')!;
    fireEvent.change(select, { target: { value: 'done' } });
    expect(getRequirementAttr(st().model, id, 'status')).toBe('done');
    expect(st().undoStack.length).toBe(1);
    act(() => st().undo());
    expect(getRequirementAttr(st().model, id, 'status')).toBeUndefined();
  });

  it('offers exactly the values the write accepts, and a blank that clears', () => {
    const view = mount(SRC);
    const options = [...cell(view, 'maxMass', 'verdict').querySelectorAll('option')].map(
      (o) => o.getAttribute('value'),
    );
    expect(options).toEqual(['', 'pass', 'fail', 'inconclusive', 'error']);
  });
});

describe('Requirements panel — a free-text facet cell', () => {
  const SRC = `package P {\n    requirement <R1> maxMass {\n        subject v;\n    }\n}`;

  it('commits what was typed on blur', () => {
    const view = mount(SRC);
    const id = idOf(view, 'maxMass');
    fireEvent.click(cell(view, 'maxMass', 'rationale').querySelector('.req-attr-text')!);
    const input = cell(view, 'maxMass', 'rationale').querySelector('input')!;
    fireEvent.blur(input, { target: { value: '  weight budget  ' } });
    expect(getRequirementAttr(st().model, id, 'rationale')).toBe('weight budget');
  });

  /**
   * Opening a cell and leaving it alone must cost nothing. `pushUndo` clears the
   * redo stack, so a write of a value that did not move would silently throw the
   * user's redo history away — and the Properties control makes exactly this
   * comparison, so two controls doing one job have to agree.
   */
  it('spends no undo step when the value did not move', () => {
    const view = mount(SRC);
    const id = idOf(view, 'maxMass');
    fireEvent.click(cell(view, 'maxMass', 'owner').querySelector('.req-attr-text')!);
    fireEvent.blur(cell(view, 'maxMass', 'owner').querySelector('input')!, {
      target: { value: 'ada' },
    });
    expect(getRequirementAttr(st().model, id, 'owner')).toBe('ada');
    const stepsAfterFirst = st().undoStack.length;

    // Re-open the same cell and blur it without changing anything.
    fireEvent.click(cell(view, 'maxMass', 'owner').querySelector('.req-attr-text')!);
    fireEvent.blur(cell(view, 'maxMass', 'owner').querySelector('input')!, {
      target: { value: 'ada' },
    });
    expect(st().undoStack.length).toBe(stepsAfterFirst);
  });
});

describe('Requirements panel — the Kind cell', () => {
  const SRC =
    `package P {\n` +
    `    requirement <R1> maxMass {\n        subject v;\n    }\n` +
    `    #prose requirement <R2> aNote {\n        subject v;\n    }\n}`;

  it('shows the kind that is WRITTEN, so the untagged state is visible', () => {
    const view = mount(SRC);
    const untagged = cell(view, 'maxMass', 'statementKind').querySelector('select')!;
    const tagged = cell(view, 'aNote', 'statementKind').querySelector('select')!;
    expect(statementKindOf(st().model, idOf(view, 'maxMass'))).toBe('requirement');
    expect(untagged.value).toBe('');
    expect(tagged.value).toBe('prose');
  });

  /**
   * The blank entry of a Kind list is a real current state, not an empty slot,
   * so it is labelled with what the element reads as — and never with the bare
   * word `requirement`, which would put two entries in the list saying the same
   * word and meaning different things.
   */
  it('labels the blank entry the same way the Properties panel does', () => {
    const view = mount(SRC);
    const blank = cell(view, 'maxMass', 'statementKind').querySelector('option[value=""]')!;
    expect(blank.textContent).toBe(untaggedStatementKindLabel('requirement'));
    expect(blank.textContent).not.toBe('requirement');
    expect(blank.textContent).not.toBe('—');
  });

  it('tags and untags a row, and a prose row stays in the grid', () => {
    const view = mount(SRC);
    expect(view.getAllByTestId('req-row').length).toBe(2);
    const id = idOf(view, 'maxMass');
    fireEvent.change(cell(view, 'maxMass', 'statementKind').querySelector('select')!, {
      target: { value: 'prompt' },
    });
    expect(writtenStatementKind(st().model, id)).toBe('prompt');
    fireEvent.change(cell(view, 'maxMass', 'statementKind').querySelector('select')!, {
      target: { value: '' },
    });
    expect(writtenStatementKind(st().model, id)).toBeUndefined();
    expect(statementKindOf(st().model, id)).toBe('requirement');
  });
});

describe('Requirements panel — a requirement whose declaration did not parse', () => {
  // One stray token, which is an ordinary authoring fault: the requirement after
  // it keeps its own source in `attrs.unparsedText`, and the file re-emits that
  // source verbatim, so a facet written onto it would be gone on the next save.
  const SRC =
    `package P {\n` +
    `    requirement <R1> a { subject s; }\n` +
    `    wibble\n` +
    `    requirement <R2> faulted { subject t; }\n}`;

  it('keeps the row but disables its facet controls, with the reason on them', () => {
    const view = mount(SRC);
    const id = idOf(view, 'faulted');
    expect(typeof st().model.require(id).attrs.unparsedText).toBe('string');

    const status = cell(view, 'faulted', 'status').querySelector('select')!;
    expect(status.disabled).toBe(true);
    expect(status.title).toMatch(/could not be parsed/i);

    const kind = cell(view, 'faulted', 'statementKind').querySelector('select')!;
    expect(kind.disabled).toBe(true);

    const rationale = cell(view, 'faulted', 'rationale').querySelector('.req-attr-text')!;
    expect(rationale.getAttribute('title')).toMatch(/could not be parsed/i);
    fireEvent.click(rationale);
    expect(cell(view, 'faulted', 'rationale').querySelector('input')).toBeNull();
  });

  it('disables the facet cells of a requirement NESTED inside a faulted declaration', () => {
    const view = mount(
      `package P {\n    blok def V {\n        requirement <R1> nested { subject s; }\n    }\n}`,
    );
    const id = idOf(view, 'nested');
    expect(st().model.require(id).attrs.unparsedText).toBeUndefined();
    const status = cell(view, 'nested', 'status').querySelector('select')!;
    expect(status.disabled).toBe(true);
    expect(status.title).toMatch(/could not be parsed/i);
    expect(cell(view, 'nested', 'statementKind').querySelector('select')!.disabled).toBe(true);
  });

  it('leaves the healthy row on the same grid fully editable', () => {
    const view = mount(SRC);
    const selects = view
      .getAllByTestId('req-row')
      .map((r) => r.querySelector('[data-col-key="status"] select') as HTMLSelectElement);
    expect(selects.length).toBe(2);
    expect(selects.filter((s) => !s.disabled).length, 'exactly the unfaulted row').toBe(1);
  });
});

/**
 * The ID cell wrote `attrs.reqId` alone, which the serializer only falls back
 * to: the cell showed the new id, the Text tab kept the old one, and reopening
 * the file reverted the edit.
 */
describe('Requirements panel — the ID cell', () => {
  it('writes the slot the file keeps', () => {
    const view = mount(`package P {\n    requirement <R1> maxMass { subject s; }\n}`);
    const id = idOf(view, 'maxMass');
    const idCell = view
      .getAllByTestId('req-row')[0]!
      .querySelector('[data-col-key="reqId"]') as HTMLElement;
    expect(idCell.textContent).toContain('R1');
    fireEvent.click(idCell);
    act(() => {
      fireEvent.blur(view.getByTestId('req-cell-input'), { target: { value: 'R9' } });
    });
    expect(st().model.require(id).declaredShortName).toBe('R9');
    expect(st().model.require(id).attrs.reqId).toBeUndefined();
    expect(serializeModel(st().model)).toContain('<R9>');
    const shown = view
      .getAllByTestId('req-row')[0]!
      .querySelector('[data-col-key="reqId"]') as HTMLElement;
    expect(shown.textContent).toContain('R9');
  });

  const idCellOf = (view: ReturnType<typeof mount>, name: string): HTMLElement => {
    const row = view.getAllByTestId('req-row').find((r) => rowName(r).includes(name))!;
    return row.querySelector('[data-testid="req-cell"][data-col-key="reqId"]') as HTMLElement;
  };

  // The writer refuses an id that would not reach the file; a cell that opens
  // anyway lets the author type an edit the next save drops.
  it('is locked, with the reason, on a requirement NESTED inside a faulted declaration', () => {
    const view = mount(
      `package P {\n    blok def V {\n        requirement <R1> nested { subject s; }\n    }\n}`,
    );
    const idCell = idCellOf(view, 'nested');
    expect(idCell.getAttribute('title')).toMatch(/could not be parsed/i);
    fireEvent.click(idCell);
    expect(view.queryByTestId('req-cell-input')).toBeNull();
  });

  // The cell commits on blur whether or not a key was pressed; a blank `<''>`
  // id shows as '', and '' to the writer means "clear" — so the file lost its
  // `<''>` on a click-in-click-out.
  it('leaves a blank <\'\'> id in the file when opened and left alone', () => {
    const src = "package P {\n    requirement <''> r;\n}";
    const view = mount(src);
    const undoBefore = st().undoStack.length;
    fireEvent.click(idCellOf(view, 'r'));
    act(() => {
      fireEvent.blur(view.getByTestId('req-cell-input'), { target: { value: '' } });
    });
    expect(serializeModel(st().model)).toBe(src);
    expect(st().undoStack.length).toBe(undoBefore);
  });
});

describe('Requirements panel — a statement that could not be written back', () => {
  // The Text column is one of the two places a person types free text straight
  // into a note body. The characters that CLOSE that note have no escape in the
  // notation, so a value carrying them cannot be saved — it used to be, and the
  // tail of the value came back as declarations.
  const SRC = `package P {\n    requirement <R1> maxMass { subject s; }\n}`;

  it('refuses the write and says why, instead of storing text the file cannot hold', () => {
    const view = mount(SRC);
    const id = idOf(view, 'maxMass');
    const before = st().model.require(id).attrs.text;

    const cellEl = view
      .getAllByTestId('req-cell')
      .find((c) => c.getAttribute('data-col-key') === 'text')!;
    fireEvent.click(cellEl);
    const input = view.getByTestId('req-cell-input') as HTMLInputElement;
    act(() => {
      fireEvent.blur(input, {
        target: { value: `mass <= 25 kg ${NOTE_BODY_TERMINATOR} satisfy R1 by V; doc /*` },
      });
    });

    expect(st().model.require(id).attrs.text, 'nothing was written').toBe(before);
    expect(view.getByTestId('req-note-refusal').textContent).toMatch(/close the note/i);
  });

  it('accepts an ordinary statement, and clears the refusal with it', () => {
    const view = mount(SRC);
    const id = idOf(view, 'maxMass');
    const cellEl = view
      .getAllByTestId('req-cell')
      .find((c) => c.getAttribute('data-col-key') === 'text')!;
    fireEvent.click(cellEl);
    act(() => {
      fireEvent.blur(view.getByTestId('req-cell-input'), {
        target: { value: 'the mass shall be under 25 kg' },
      });
    });
    expect(st().model.require(id).attrs.text).toBe('the mass shall be under 25 kg');
    expect(view.queryByTestId('req-note-refusal')).toBeNull();
  });

  /**
   * The notice belongs to the attempt, not to the row.
   *
   * It used to be cleared only by an accepted write in the SAME column, so
   * editing the name, or pressing Escape out of the Text cell, left a red "the
   * file cannot hold this" under a cell whose contents nobody had objected to.
   * A refusal that outlives its cause is a false report.
   */
  function refuse(view: ReturnType<typeof mount>): void {
    const cellEl = view
      .getAllByTestId('req-cell')
      .find((c) => c.getAttribute('data-col-key') === 'text')!;
    fireEvent.click(cellEl);
    act(() => {
      fireEvent.blur(view.getByTestId('req-cell-input'), {
        target: { value: `a ${NOTE_BODY_TERMINATOR} b` },
      });
    });
    expect(view.getByTestId('req-note-refusal')).toBeTruthy();
  }

  it('takes the refusal back down when the row is edited elsewhere', () => {
    const view = mount(SRC);
    refuse(view);

    const nameCell = view
      .getAllByTestId('req-cell')
      .find((c) => c.getAttribute('data-col-key') === 'name')!;
    fireEvent.click(nameCell);
    act(() => {
      fireEvent.blur(view.getByTestId('req-cell-input'), { target: { value: 'maxWeight' } });
    });

    expect(view.queryByTestId('req-note-refusal'), 'nothing objected to the name').toBeNull();
  });

  it('takes the refusal back down when the edit is abandoned', () => {
    const view = mount(SRC);
    refuse(view);

    const cellEl = view
      .getAllByTestId('req-cell')
      .find((c) => c.getAttribute('data-col-key') === 'text')!;
    fireEvent.click(cellEl);
    act(() => {
      fireEvent.keyDown(view.getByTestId('req-cell-input'), { key: 'Escape' });
    });

    expect(view.queryByTestId('req-note-refusal'), 'the attempt was withdrawn').toBeNull();
  });
});

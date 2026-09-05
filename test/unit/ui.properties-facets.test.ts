/**
 * The Properties panel's Kind selector and requirement-attributes block.
 *
 * `properties-all-fields.spec.ts` drives both in a real browser on a healthy
 * requirement. What it cannot reach is the row the writer REFUSES — a
 * requirement whose declaration did not parse — and that is where the control
 * was live, wrote nothing, and said nothing. It is pinned here because a faulted
 * declaration is a parse result, not something a click can produce in the app.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
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
import { Properties } from '../../src/ui/panels/Properties';
import { parseModel } from '@text/index';
import { untaggedStatementKindLabel } from '@semantics/index';

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

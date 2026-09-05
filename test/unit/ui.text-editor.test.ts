/**
 * What the Text view says when the model cannot be written.
 *
 * The serializer refuses a model carrying something the notation has no
 * spelling for — a note body containing the sequence that ends a note, a
 * multiplicity containing the bracket that ends one. That refusal used to be
 * swallowed into the empty string, so this panel rendered an EMPTY document,
 * the status strip still read "in sync with model", and "Apply text → model"
 * was one click away from replacing the whole model with nothing.
 *
 * It is pinned here rather than in a browser spec because no click in the app
 * can produce such a model — the panels and the store refuse it. It arrives
 * through a model-JSON import or the element-graph API, which is exactly why
 * the Text view has to be honest about it.
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
import { TextEditor } from '../../src/ui/panels/TextEditor';

beforeEach(() => {
  useAppStore.setState({
    model: new Model(),
    undoStack: [],
    redoStack: [],
    rev: 0,
    textBuffer: 'package P {\n    part def A;\n}',
    textDirty: false,
    serializeError: null,
  });
});

describe('TextEditor — a model that cannot be written as text', () => {
  it('says the text is in sync only when it actually is', () => {
    const clean = render(React.createElement(TextEditor));
    expect(clean.container.querySelector('.text-editor-status')?.textContent).toBe(
      'in sync with model',
    );
    clean.unmount();

    useAppStore.setState({ serializeError: 'the note body contains "*/"' });
    const view = render(React.createElement(TextEditor));
    expect(
      view.container.querySelector('.text-editor-status')?.textContent,
      'an empty or stale document must not claim to be the model',
    ).not.toBe('in sync with model');
  });

  it('shows the reason and refuses the apply that would replace the model', () => {
    useAppStore.setState({ serializeError: 'the note body contains "*/"' });
    const view = render(React.createElement(TextEditor));

    expect(view.getByTestId('text-serialize-error').textContent).toContain('"*/"');
    expect(
      (view.getByTestId('text-apply') as HTMLButtonElement).disabled,
      'applying a text that is not the model would replace the model with it',
    ).toBe(true);
  });

  it('re-enables the apply once the author has edited the text', () => {
    useAppStore.setState({ serializeError: 'nope', textDirty: true });
    const view = render(React.createElement(TextEditor));
    expect(
      (view.getByTestId('text-apply') as HTMLButtonElement).disabled,
      'a text the author typed is their intent, and the way out of the state',
    ).toBe(false);
    expect(view.getByTestId('text-serialize-error'), 'the reason still stands').toBeTruthy();
  });

  it('keeps the buffer readable while it is refused', () => {
    useAppStore.setState({ serializeError: 'nope' });
    const view = render(React.createElement(TextEditor));
    expect((view.getByTestId('text-editor') as HTMLTextAreaElement).value).toContain('part def A');
  });
});

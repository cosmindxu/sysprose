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
import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { Model } from '@core/index';

vi.mock('../../src/library/full-library', () => ({
  loadFullStandardLibrary: () => {},
  preloadFullLibrary: async () => {},
}));
vi.mock('../../src/library/standard-library', () => ({
  loadCuratedLibrary: () => {},
}));

import { flushRecompute, forcedRecomputePending, useAppStore } from '../../src/ui/store';
import { TextEditor } from '../../src/ui/panels/TextEditor';
import { scheduleParserWarmUp, type WarmUpDeps } from '../../src/ui/parser-warmup';

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

describe('TextEditor — focusing it', () => {
  /**
   * An edit made a moment ago shows before the first key, so typing begins over
   * the model's text as it stands — but not over text typed and standing,
   * which that edit's recompute replaces and a key typed first still keeps.
   */
  it('runs a waiting edit’s refresh first, unless text typed there stands', () => {
    const view = render(React.createElement(TextEditor));
    const editor = () => view.getByTestId('text-editor');
    const st = () => useAppStore.getState();
    st().createElement('PartDefinition', null, 'Kite');
    expect(forcedRecomputePending()).toBe(true);
    fireEvent.focus(editor());
    expect(forcedRecomputePending()).toBe(false);
    expect(st().textBuffer).toContain('part def Kite;');

    st().setTextBuffer('package Typed;');
    st().createElement('PartDefinition', null, 'Kite2');
    expect(forcedRecomputePending()).toBe(true);
    fireEvent.focus(editor());
    expect(forcedRecomputePending()).toBe(true);
    expect(st().textBuffer).toBe('package Typed;');
    flushRecompute();
    view.unmount();
  });
});

describe('the parser is built before the first Apply', () => {
  /** A page whose idle callbacks and timers run when the test says so. */
  function fakePage(over: Partial<WarmUpDeps> = {}) {
    const queued: Array<() => void> = [];
    const attrs: Record<string, string> = {};
    let built = false;
    const calls = { builds: 0 };
    const deps: WarmUpDeps = {
      build: () => {
        calls.builds++;
        built = true;
      },
      isBuilt: () => built,
      requestIdleCallback: (cb) => void queued.push(cb),
      setTimeout: (cb) => void queued.push(cb),
      document: { documentElement: { setAttribute: (k, v) => void (attrs[k] = v) } },
      ...over,
    };
    return { deps, queued, attrs, calls };
  }

  it('builds it when the page is idle, once, and says so on the document', () => {
    const page = fakePage();
    scheduleParserWarmUp(page.deps);
    scheduleParserWarmUp(page.deps); // the Text view mounting again while the first waits
    expect(page.calls.builds, 'nothing is built before the page is idle').toBe(0);
    page.queued.forEach((run) => run());
    expect(page.calls.builds, 'the second finds it built').toBe(1);
    expect(page.attrs['data-parser-warm']).toBe('true');
    const queuedBefore = page.queued.length;
    scheduleParserWarmUp(page.deps); // built: nothing more to queue
    expect(page.queued).toHaveLength(queuedBefore);
  });

  it('falls back to a timer where there is no idle callback', () => {
    const page = fakePage({ requestIdleCallback: undefined });
    scheduleParserWarmUp(page.deps);
    expect(page.queued).toHaveLength(1);
    page.queued[0]!();
    expect(page.calls.builds).toBe(1);
  });

  it('leaves the page working when the build throws, and tries again at the next mount', () => {
    let fail = true;
    const page = fakePage();
    const build = page.deps.build;
    page.deps.build = () => {
      if (fail) throw new Error('no parser here');
      build();
    };
    scheduleParserWarmUp(page.deps);
    expect(() => page.queued[0]!()).not.toThrow();
    expect(page.attrs['data-parser-warm']).toBeUndefined();
    fail = false;
    scheduleParserWarmUp(page.deps);
    page.queued[1]!();
    expect(page.calls.builds).toBe(1);
    expect(page.attrs['data-parser-warm']).toBe('true');
  });

  it('is started by the Text view opening', async () => {
    document.documentElement.removeAttribute('data-parser-warm');
    const view = render(React.createElement(TextEditor));
    await vi.waitFor(() => expect(document.documentElement.getAttribute('data-parser-warm')).toBe('true'), {
      timeout: 60_000,
    });
    view.unmount();
  }, 70_000);
});

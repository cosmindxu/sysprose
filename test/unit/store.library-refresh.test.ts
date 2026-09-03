/**
 * The Problems panel must agree with the checker once the library settles.
 *
 * `applyText` publishes the parse findings synchronously and then merges the
 * standard library asynchronously. A reference only the library can resolve is
 * genuinely unresolved when the parse publishes it and resolved a few hundred
 * milliseconds later — and nothing took the row back, so the app showed a
 * permanent false "Unresolved reference" that `checkText` (which does retract)
 * never reported. This pins the retraction, and its negative control.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Model } from '@core/index';

// A one-element stand-in for the bundled library: enough for the binder to
// resolve `Widget`, without loading the multi-MB bundle into a unit test.
// The library load is asynchronous, and WHEN it lands relative to the store's
// debounced recompute is exactly what the staleness tests below turn on, so the
// delay is a knob.
const lib = vi.hoisted(() => ({ preloadDelayMs: 0 }));
vi.mock('../../src/library/full-library', () => ({
  preloadFullLibrary: async () => {
    if (lib.preloadDelayMs > 0) await new Promise((r) => setTimeout(r, lib.preloadDelayMs));
  },
  loadFullStandardLibrary: (model: Model) => {
    if (model.all().some((e) => e.attrs.isLibrary === true)) return;
    model.create('PartDefinition', { declaredName: 'Widget', attrs: { isLibrary: true } });
  },
}));
vi.mock('../../src/library/standard-library', () => ({
  loadCuratedLibrary: () => {},
}));

import { useAppStore } from '../../src/ui/store';

const st = () => useAppStore.getState();
const parseRows = () => st().diagnostics.filter((d) => d.ruleId === 'parse');

beforeEach(() => {
  lib.preloadDelayMs = 0;
  useAppStore.setState({ model: new Model(), undoStack: [], redoStack: [], diagnostics: [] });
});

describe('store — parse rows after the library merges', () => {
  it('drops the row for a reference the binder resolved', async () => {
    useAppStore.setState({ textBuffer: 'package P {\n    part w : Widget;\n}\n' });
    st().applyText();
    // True at parse time: nothing in the file declares `Widget`.
    expect(parseRows().map((d) => d.code)).toEqual(['ref/unresolved-specialization']);
    await vi.waitFor(() => {
      expect(parseRows()).toEqual([]);
    });
    const w = st().model.all().find((e) => e.declaredName === 'w')!;
    expect(w.attrs.typeRef).toBeUndefined();
  });

  it('keeps the row for a reference nothing resolves', async () => {
    useAppStore.setState({ textBuffer: 'package P {\n    part w : NoSuchType;\n}\n' });
    st().applyText();
    expect(parseRows().map((d) => d.code)).toEqual(['ref/unresolved-specialization']);
    // Give the async merge the same chance to settle, then assert it did NOT
    // take the warning back.
    await vi.waitFor(() => {
      expect(st().model.all().some((e) => e.attrs.isLibrary === true)).toBe(true);
    });
    expect(parseRows().map((d) => d.code)).toEqual(['ref/unresolved-specialization']);
  });
});

/**
 * The retained parse result belongs to ONE document. Every path that replaces
 * the live model without parsing the open text must forget it, or the refresh
 * that lands after the library settles rebuilds the panel from the previous
 * document — rows carrying the old file's line numbers, about text nobody has
 * open. The pre-C6 code could not do this: it kept the widened
 * `ruleId === 'parse'` rows, which the intervening recompute had already
 * cleared.
 */
describe('store — the retained parse result does not outlive its document', () => {
  it('a branch switch does not resurrect the previous text’s rows', async () => {
    useAppStore.setState({ textBuffer: 'package Clean {\n    part def Ok;\n}\n' });
    st().applyText();
    await vi.waitFor(() => {
      expect(st().model.all().some((e) => e.attrs.isLibrary === true)).toBe(true);
    });
    st().refreshVersions();
    st().commitVersion('clean snapshot');
    const branch = st().currentBranchId;

    // A different, BROKEN document is applied over it.
    useAppStore.setState({ textBuffer: 'package Broken {\n    part w : NoSuchType;\n}\n' });
    st().applyText();
    expect(parseRows().map((d) => d.code)).toEqual(['ref/unresolved-specialization']);

    // Back to the committed clean model — no parse happens, so the panel must
    // hold nothing from the broken text, then or after the library settles.
    st().switchBranch(branch);
    expect(parseRows()).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    await vi.waitFor(() => {
      expect(st().model.all().some((e) => e.attrs.isLibrary === true)).toBe(true);
    });
    expect(parseRows()).toEqual([]);
  });

  it('loading a project does not resurrect the previous text’s rows', async () => {
    useAppStore.setState({ textBuffer: 'package Clean {\n    part def Ok;\n}\n' });
    st().applyText();
    await st().saveProject('c6-clean');

    useAppStore.setState({ textBuffer: 'package Broken {\n    part w : NoSuchType;\n}\n' });
    st().applyText();
    expect(parseRows().map((d) => d.code)).toEqual(['ref/unresolved-specialization']);

    // `loadProject` leaves the stale rows standing until its debounced
    // recompute (as it always did); what must not happen is the LIBRARY
    // refresh putting them back afterwards — so make the load land AFTER the
    // recompute, which is the realistic order for a multi-MB bundle.
    lib.preloadDelayMs = 300;
    await st().loadProject('c6-clean');
    await vi.waitFor(() => {
      expect(parseRows()).toEqual([]);
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(parseRows()).toEqual([]);
  });
});

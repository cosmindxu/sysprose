/**
 * `loadModelText` — the headless loader that hands back the BOUND MODEL.
 *
 * WHY this file exists. `checkText` built a library-bound model, read its
 * diagnostics and threw the model away, so every reporting function in
 * `src/api/analytics.ts` was reachable only from the browser. The loader keeps
 * the model; `checkText` is now a wrapper over it. Two things therefore need
 * pinning: that what comes back is genuinely BOUND (a library type resolves —
 * an unbound model would silently report every `: Real` as unresolved), and
 * that the wrapper still answers exactly what it answered before.
 *
 * It also pins the display-name split: a source read from a pipe has no file
 * name, and warning that `<stdin>` has the wrong extension told the reader
 * nothing they could act on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadModelText } from '@text/load';
import { checkText } from '@text/check';

const TYPED = 'package P {\n    part def A {\n        attribute mass : Real;\n    }\n}\n';
const CLEAN = 'package P {\n    part def A;\n}\n';

describe('loadModelText — the bound model survives the check', () => {
  it('returns a model in which a standard-library type is resolved', async () => {
    const { model, report } = await loadModelText(TYPED, { fileName: 'm.sysml' });
    expect(report.ok, report.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    expect(model, 'a file that parses must come back with its model').toBeDefined();

    const mass = model!.all().find((e) => e.declaredName === 'mass');
    expect(mass, 'the attribute the source declares').toBeDefined();
    // Binding is what materialises the FeatureTyping: with no library pass the
    // type stays a string on `attrs` and nothing points at `Real`.
    const typings = model!
      .children(mass!.id)
      .filter((c) => c.eClass === 'FeatureTyping')
      .map((c) => model!.get((c.target ?? [])[0]))
      .filter((t) => t !== undefined);
    expect(typings.some((t) => t!.declaredName === 'Real' && t!.attrs.isLibrary === true)).toBe(
      true,
    );
  }, 60_000);

  it('returns the element→range side table alongside the model', async () => {
    const { model, ranges } = await loadModelText(TYPED, { library: 'none' });
    const a = model!.all().find((e) => e.declaredName === 'A');
    expect(ranges.get(a!.id)?.start.line).toBeGreaterThan(0);
  }, 60_000);

  it('reports the same thing `checkText` reports', async () => {
    const opts = { library: 'none' as const, fileName: 'm.sysml', strict: true };
    const { report } = await loadModelText(TYPED, opts);
    expect(report).toEqual(await checkText(TYPED, opts));
  }, 60_000);

  it('still hands back what survived a parse that failed', async () => {
    // The OTHER half of the `model?:` contract, and the half every reporting
    // command depends on: a file with a standing error still yields the part
    // error recovery salvaged, so `metrics`/`where-used` can run on a broken
    // file. Only the absent direction was pinned, so an edit that returned
    // `undefined` whenever `ok` is false would have gone unnoticed.
    const BROKEN = 'package P {\n    blok q : T;\n    part def A;\n}\n';
    const { model, report } = await loadModelText(BROKEN, {
      library: 'none',
      fileName: 'broken.sysml',
    });
    expect(report.ok).toBe(false);
    expect(report.summary.errors).toBeGreaterThan(0);
    expect(model, 'error recovery salvaged elements; the caller must get them').toBeDefined();
    expect(report.elements.count).toBeGreaterThan(0);
    expect(model!.all().some((e) => e.declaredName === 'A')).toBe(true);
  }, 60_000);

  it('binds the library into every model, not just the first', async () => {
    // Pins the COST note in load.ts: library binding is PER MODEL, not a
    // first-call cost that later loads inherit. If a future "optimisation"
    // bound only the first model in a process, the second would report every
    // library type as unresolved — silently, since nothing else looks.
    const first = await loadModelText(TYPED, { fileName: 'a.sysml' });
    const second = await loadModelText(TYPED, { fileName: 'b.sysml' });
    expect(first.model).not.toBe(second.model);
    for (const { model } of [first, second]) {
      expect(model!.all().some((e) => e.declaredName === 'Real' && e.attrs.isLibrary === true)).toBe(
        true,
      );
    }
  }, 60_000);

  it('has no model to give when the input is refused outright', async () => {
    // Fail direction: a caller that reports on the model must be forced to see
    // that there is none, rather than print "0 elements, nothing wrong".
    const { model, report } = await loadModelText('{"elements": []}', { library: 'none' });
    expect(model).toBeUndefined();
    expect(report.ok).toBe(false);
    expect(report.diagnostics.some((d) => d.code === 'import/not-text')).toBe(true);
  }, 60_000);
});

describe('a display name is not a file name', () => {
  it('does not warn about the extension of a piped source', async () => {
    const { report } = await loadModelText(CLEAN, { displayName: '<stdin>', library: 'none' });
    expect(report.diagnostics.some((d) => d.code === 'import/wrong-extension')).toBe(false);
    expect(report.fileName, 'the display name is still what the report is labelled with').toBe(
      '<stdin>',
    );
    expect(report.ok).toBe(true);
  }, 60_000);

  it('still warns when a real file name has an unrecognised extension', async () => {
    // The tripwire for the fix above: suppressing the warning for `<stdin>`
    // must not suppress it for `model.txt.bak`, which is the case the
    // catalogue entry and the L0-wrong-extension fixture exist for.
    const { report } = await loadModelText(CLEAN, { fileName: 'model.txt.bak', library: 'none' });
    expect(report.diagnostics.some((d) => d.code === 'import/wrong-extension')).toBe(true);
  }, 60_000);
});

/**
 * The SECOND hand-copy of the binding sequence.
 *
 * `loadModelText` replaced the copy that lived in `check.ts`, but the UI store's
 * `loadStandardLibraryAsync` still spells the same four calls out itself, and it
 * cannot call the loader: it binds an ALREADY-LIVE model (re-reading
 * `useAppStore.getState().model` after the await, on purpose) rather than
 * parsing text, and it has a curated-subset fallback the loader has not.
 * Extracting a shared helper is blocked on layering — `resolveConnectorFeatureChains`
 * lives in `@text`, so a `bindStandardLibrary` under `@library` would be the
 * first `library → text` import in the tree — so the two copies stay, and this
 * pins them to the same sequence instead. Drift here is a silent correctness
 * bug: the app and the CLI would disagree about what a model means.
 */
const BINDING_STEPS =
  /\b(preloadFullLibrary|loadFullStandardLibrary|resolveTypeReferences|resolveConnectorFeatureChains)\(/g;

function bindingSequence(file: string, from: string, to: string): string[] {
  const src = readFileSync(resolve(process.cwd(), file), 'utf8');
  const start = src.indexOf(from);
  expect(start, `${file} no longer contains ${JSON.stringify(from)}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start);
  expect(end, `${file} no longer contains ${JSON.stringify(to)}`).toBeGreaterThan(start);
  return [...src.slice(start, end).matchAll(BINDING_STEPS)].map((m) => m[1]);
}

describe('the loader and the UI store bind a model the same way', () => {
  it('runs the same four steps in the same order', () => {
    const loader = bindingSequence('src/text/load.ts', "if (library === 'full')", '// Parse warnings');
    const store = bindingSequence(
      'src/ui/store.ts',
      'async function loadStandardLibraryAsync',
      'refreshAfterLibraryLoad();',
    );
    expect(loader).toEqual([
      'preloadFullLibrary',
      'loadFullStandardLibrary',
      'resolveTypeReferences',
      'resolveConnectorFeatureChains',
    ]);
    expect(store, 'src/ui/store.ts drifted from src/text/load.ts').toEqual(loader);
  });
});

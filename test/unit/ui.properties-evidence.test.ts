/**
 * The Properties panel's Evidence block and Keywords list — the app's only two
 * windows onto the verification lane, and the only place it could show a
 * sentence no run produced.
 *
 * WHY A UNIT SUITE AND NOT AN E2E. Neither block can be reached by clicking:
 * the app's start model carries no evidence carrier, no `verdict` facet and no
 * `#keyword`, and nothing in the browser writes one — there is no solver in this
 * bundle. The state under test is what a TERMINAL run left in a file, so the
 * model has to be built the way a run builds it, through the real `verify` +
 * `attachEvidence` path ({@link buildVerdictBearingModel}, the same fixture the
 * interop probe pushes). `test/unit/ui.properties-facets.test.ts` is the shape
 * this follows.
 *
 * THE RULE EACH TEST PINS. The chip carries the record's CLAIM word — the finer
 * sentence, `holds-at-values` — and never the `verdict` facet, which is
 * three-valued and cannot tell a proof from a point evaluation. Printing the
 * facet where the claim belongs is exactly the upgrade the plan forbids, and it
 * is a one-word edit away at every moment, so it is asserted rather than trusted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { Model } from '@core/index';

vi.mock('../../src/library/full-library', () => ({
  loadFullStandardLibrary: () => {},
  preloadFullLibrary: async () => {},
}));
vi.mock('../../src/library/standard-library', () => ({
  loadCuratedLibrary: () => {},
}));

import { useAppStore, evidenceStatusAt, evidenceRowAt, proveInTerminalHint } from '../../src/ui/store';
import { Properties } from '../../src/ui/panels/Properties';
import { parseModel } from '@text/index';
import { keywordUsesOf } from '@api/index';
import { buildVerdictBearingModel } from '../../scripts/lib/verdict-fixture';

/** Put `model` in the store with `id` selected, and render the panel over it. */
function mount(model: Model, id: string, rev = 0) {
  useAppStore.setState({
    model,
    undoStack: [],
    redoStack: [],
    rev,
    selectionId: id,
    selectionIds: [id],
  });
  return render(React.createElement(Properties));
}

/** The requirement the fixture attaches its record to. */
function requirementId(model: Model): string {
  const el = model.all().find((e) => e.declaredName === 'MassLimit');
  expect(el, 'the verdict fixture no longer declares MassLimit').toBeDefined();
  return el!.id;
}

beforeEach(() => {
  useAppStore.setState({ model: new Model(), undoStack: [], redoStack: [], rev: 0 });
});

describe('Properties — the Evidence chip reads what a run left, and nothing more', () => {
  it('says `current`, with the record CLAIM word beside it — not the verdict facet', async () => {
    const { model } = await buildVerdictBearingModel();
    const id = requirementId(model);
    const row = evidenceRowAt(model, 0, id);
    expect(row, 'the fixture carries no evidence row').toBeDefined();
    expect(row!.status).toBe('current');

    const view = mount(model, id, 0);
    expect(view.getByTestId('prop-evidence-chip').textContent).toContain('current');
    expect(view.getByTestId('prop-evidence-chip').getAttribute('data-status')).toBe('current');

    const claim = view.getByTestId('prop-evidence-claim').textContent!.trim();
    // The finer sentence, verbatim from the record.
    expect(claim).toBe(row!.claim);
    expect(claim).toBe('holds-at-values');
    // …and NOT the facet. The two differ here on purpose: a `literal` run may
    // never earn `pass`, so its facet is `inconclusive`, and a chip printing the
    // facet would tell a reader less than the record does while looking official.
    expect(row!.claimedVerdict).toBe('inconclusive');
    expect(claim).not.toBe(row!.claimedVerdict);

    // Nothing is stale yet, so no slice is offered.
    expect(view.queryByTestId('prop-evidence-slice')).toBeNull();
  });

  it('says `stale`, with the slice to re-read, once the model moves under it', async () => {
    const { model } = await buildVerdictBearingModel();
    const id = requirementId(model);
    // Edit the design the record was taken over. The digest is over the whole
    // user model, so any real change invalidates it — which is the point.
    const mass = model.all().find((e) => e.declaredName === 'mass');
    expect(mass, 'the fixture no longer declares the mass attribute').toBeDefined();
    act(() => {
      model.update(mass!.id, { attrs: { ...mass!.attrs, value: 42 } });
    });

    const row = evidenceRowAt(model, 1, id);
    expect(row!.status).toBe('stale');
    const view = mount(model, id, 1);
    expect(view.getByTestId('prop-evidence-chip').textContent).toContain('stale');
    const slice = view.getByTestId('prop-evidence-slice').textContent!;
    expect(slice).toMatch(/re-read:/);
    expect(row!.slice.length).toBeGreaterThan(0);
    for (const hop of row!.slice) expect(slice).toContain(hop);
  });

  it('says `none` on an element no run ever recorded anything about', () => {
    const { model } = parseModel('package P {\n    part def Widget;\n}');
    const el = model.all().find((e) => e.declaredName === 'Widget')!;
    const view = mount(model, el.id, 0);
    const chip = view.getByTestId('prop-evidence-chip');
    expect(chip.getAttribute('data-status')).toBe('none');
    expect(chip.textContent).toContain('none');
    expect(view.queryByTestId('prop-evidence-claim')).toBeNull();
  });

  it('names the command that DECIDES, not the one that inventories', async () => {
    const { model } = await buildVerdictBearingModel();
    const view = mount(model, requirementId(model), 0);
    const hint = view.getByTestId('prop-evidence-terminal').textContent!;
    // `verify` is the only subcommand that reaches a verdict; `contracts`
    // prints the inventory and says so itself.
    expect(hint).toContain('sysprose -- verify');
    expect(hint).not.toContain('sysprose -- contracts');
    expect(hint).toMatch(/run it in a terminal/i);
  });
});

/**
 * The hint asks the host rather than assuming it, because the REASON changes:
 * on a page that is not cross-origin isolated the headers are the reason and a
 * reader can act on it; on one that is, the reason is that this plan ships no
 * in-browser engine. A hint giving the wrong reason sends somebody to fix a
 * header that was already set.
 */
describe('proveInTerminalHint — the reason it gives is the true one for the host', () => {
  const CMD = 'npm run sysprose -- verify f.sysml --engine smt';

  it('blames the missing isolation when the page is not isolated', () => {
    const g = globalThis as { crossOriginIsolated?: boolean };
    const before = g.crossOriginIsolated;
    g.crossOriginIsolated = false;
    try {
      const s = proveInTerminalHint(CMD);
      expect(s).toMatch(/not cross-origin isolated/i);
      expect(s).toContain(CMD);
    } finally {
      g.crossOriginIsolated = before;
    }
  });

  it('blames the build, not the headers, on a host that DOES isolate', () => {
    const g = globalThis as { crossOriginIsolated?: boolean };
    const before = g.crossOriginIsolated;
    g.crossOriginIsolated = true;
    try {
      const s = proveInTerminalHint(CMD);
      expect(s).toMatch(/ships no in-browser engine/i);
      expect(s).not.toMatch(/not cross-origin isolated/i);
      expect(s).toContain(CMD);
    } finally {
      g.crossOriginIsolated = before;
    }
  });
});

/**
 * The memo is keyed on the model as well as on `rev`, and this is why.
 *
 * `rev` is a counter on ONE store. Every panel harness in this directory resets
 * a freshly parsed model at `rev: 0`, and the store itself starts there, so a
 * memo keyed on the number alone hands the second model the first one's report —
 * the app showing a verdict it did not compute for the model on screen.
 */
describe('evidenceStatusAt — a revision number is not a model identity', () => {
  it('does not hand a second model the first model report', async () => {
    const { model } = await buildVerdictBearingModel();
    const first = evidenceStatusAt(model, 0);
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.current).toBe(1);

    const empty = evidenceStatusAt(new Model(), 0);
    expect(empty.rows.length, 'the empty model was served the other model report').toBe(0);
    expect(empty.current).toBe(0);
    expect(empty, 'the two models share one report object').not.toBe(first);

    // …and the first model still answers for itself afterwards.
    expect(evidenceStatusAt(model, 0).rows.length).toBe(first.rows.length);
  });

  it('still answers the same model twice at one revision from the memo', async () => {
    const { model } = await buildVerdictBearingModel();
    const a = evidenceStatusAt(model, 7);
    const b = evidenceStatusAt(model, 7);
    expect(b).toBe(a);
  });
});

describe('Properties — a #keyword is read the way the command reads it', () => {
  const SRC =
    `package P {\n` +
    `    metadata def <flag> Flag;\n` +
    `    #Flag part def Widget;\n` +
    `}`;

  it('prints the inventory own classification, not a second opinion', () => {
    const { model } = parseModel(SRC);
    const el = model.all().find((e) => e.declaredName === 'Widget')!;
    const uses = keywordUsesOf(model, el.id);
    expect(uses.length, 'the keyword fixture no longer carries a keyword').toBe(1);

    const view = mount(model, el.id, 0);
    const items = view.getAllByTestId('prop-keyword-item');
    expect(items.length).toBe(uses.length);
    expect(items[0].textContent).toContain('#Flag');

    // The panel and `contracts --keywords` must not classify one spelling two
    // ways: whatever the inventory resolved this to has to be what is shown.
    const reading = view.getByTestId('prop-keyword-reading').textContent!;
    expect(uses[0].resolvedTo, 'the fixture keyword no longer resolves').not.toBeNull();
    expect(reading).toContain(uses[0].resolvedTo!.qualifiedName);
  });

  it('offers no keyword block on an element carrying none', () => {
    const { model } = parseModel('package P {\n    part def Plain;\n}');
    const el = model.all().find((e) => e.declaredName === 'Plain')!;
    const view = mount(model, el.id, 0);
    expect(view.queryByTestId('prop-keywords')).toBeNull();
  });
});

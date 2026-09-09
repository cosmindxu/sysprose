/**
 * The Contracts panel — the rendered half of `buildContractsTable`.
 *
 * `test/unit/contracts-table.test.ts` pins the PROJECTION; this pins what a
 * reader actually sees, and the E2E cannot: `view-switching.spec.ts` asserts the
 * container mounts, and the app's start model states exactly one clause-less
 * contract, so a browser test never renders a clause line, a refusal, an
 * inherited-clause note, a keyword or the empty state at all. Every one of those
 * could be deleted with the whole gate green. They are rendered here instead,
 * over a parsed model, in the shape `ui.requirements-table.test.ts` uses.
 *
 * THE TWO SENTENCES THIS FILE EXISTS TO KEEP TRUE. A refused clause is shown
 * WITH its reason — a view that showed the clauses and hid the refusals would
 * let a reader believe a requirement was fully encoded when half its body had
 * been turned away at a unit gate — and the footer names a command that reaches
 * a verdict, which is `verify` and never the `contracts` command this view is a
 * projection of.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
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
import { ContractsTable } from '../../src/ui/panels/ContractsTable';
import { buildContractsTable } from '@diagram/index';
import { parseModel } from '@text/index';

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
  return { view: render(React.createElement(ContractsTable)), model };
}

const st = () => useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({ model: new Model(), undoStack: [], redoStack: [], rev: 0 });
});

const TWO = `package P {
    part def Sys { attribute mass; attribute endurance; }
    requirement <R1> MassLimit {
        subject u : Sys;
        assume constraint { u.endurance >= 0.0 }
        require constraint { u.mass <= 25.0 }
    }
    requirement Bare {
        subject u : Sys;
    }
}`;

describe('ContractsTable — one row per contract the report found', () => {
  it('renders exactly the rows the projection produced, with their ids and clauses', () => {
    const { view, model } = mount(TWO);
    const table = buildContractsTable(model);
    const rows = view.getAllByTestId('contract-row');
    expect(rows.length).toBe(table.rows.length);
    expect(rows.map((r) => r.getAttribute('data-element-id'))).toEqual(table.rows.map((r) => r.id));

    // The declared id is shown where the file declares one, and the em-dash
    // stands in where it does not — never a fabricated short name.
    const shortIds = view.getAllByTestId('contract-shortid').map((c) => c.textContent);
    expect(shortIds).toContain('R1');

    // Every clause body the projection carries is on screen, verbatim.
    const clauses = view.getAllByTestId('contract-clause').map((c) => c.textContent);
    for (const row of table.rows) {
      for (const c of [...row.assumptions, ...row.guarantees]) {
        expect(clauses.some((text) => text!.includes(c.expression))).toBe(true);
      }
    }
  });

  it('selects the element the row is about when the row is clicked', () => {
    const { view, model } = mount(TWO);
    const table = buildContractsTable(model);
    const row = view.getAllByTestId('contract-row')[0];
    fireEvent.click(row);
    expect(st().selectionId).toBe(table.rows[0].id);
  });

  it('summarises with the projection figures, not a second count', () => {
    const { view, model } = mount(TWO);
    const s = buildContractsTable(model).summary;
    const text = view.getByTestId('contracts-summary').textContent!;
    expect(text).toContain(`${s.contracts} contract(s)`);
    expect(text).toContain(`${s.subjects} subject(s)`);
    expect(text).toContain(`${s.assumptions} assumption(s)`);
    expect(text).toContain(`${s.guarantees} guarantee(s)`);
    expect(text).toContain(`${s.noFormalClause} with no formal clause`);
    expect(text).toContain(`${s.refused} relation(s)`);
    // The clause-less requirement is counted, not hidden.
    expect(s.noFormalClause).toBeGreaterThan(0);
  });
});

describe('ContractsTable — what it says about what it could not read', () => {
  const REFUSED = `package P {
    part def Sys { attribute label : String; attribute mass; }
    requirement r {
        subject u : Sys;
        assume constraint { u.mass >= 0.0 }
        require constraint { u.label == "ok" }
    }
}`;

  it('shows a refused clause with the gate reason beside it', () => {
    const { view, model } = mount(REFUSED);
    const table = buildContractsTable(model);
    const refused = table.rows.flatMap((r) => [...r.assumptions, ...r.guarantees]).filter((c) => !c.encodable);
    expect(refused.length, 'the fixture no longer refuses a clause').toBeGreaterThan(0);

    const shown = view.getAllByTestId('contract-refusal');
    expect(shown.length).toBe(refused.length);
    for (const c of refused) {
      expect(shown.some((n) => n.textContent!.includes(c.reason!))).toBe(true);
    }
    // The clause itself is still on screen: the refusal annotates it, it does
    // not replace it.
    const bodies = view.getAllByTestId('contract-clause').map((n) => n.textContent);
    for (const c of refused) expect(bodies.some((b) => b!.includes(c.expression))).toBe(true);
  });

  it('marks an encodable clause and a refused one differently in the DOM', () => {
    const { view } = mount(REFUSED);
    const flags = view.getAllByTestId('contract-clause').map((n) => n.getAttribute('data-encodable'));
    expect(flags).toContain('yes');
    expect(flags).toContain('no');
  });
});

describe('ContractsTable — the states nothing else renders', () => {
  it('says the model states no contract, rather than showing an empty grid', () => {
    const { view } = mount('package P {\n    part def A;\n}');
    expect(view.queryAllByTestId('contract-row').length).toBe(0);
    expect(view.getByTestId('contracts-empty').textContent).toMatch(/no requirement/i);
  });

  it('names where an inherited clause is filed', () => {
    const { view } = mount(`package P {
    part def Sys { attribute mass; }
    requirement def MassLimit {
        subject u : Sys;
        require constraint { u.mass <= 25.0 }
    }
    requirement r : MassLimit;
}`);
    const notes = view.getAllByTestId('contract-inherited').map((n) => n.textContent);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.join(' ')).toContain('MassLimit');
  });

  it('shows the #keywords written on a contract', () => {
    const { view } = mount(`package P {
    metadata def <flag> Flag;
    part def Sys { attribute mass; }
    #Flag requirement r {
        subject u : Sys;
        require constraint { u.mass <= 25.0 }
    }
}`);
    const kws = view.getAllByTestId('contract-keyword').map((n) => n.textContent!.trim());
    expect(kws).toContain('#Flag');
  });
});

describe('ContractsTable — the footer sends the reader somewhere that decides', () => {
  it('names `verify`, never the `contracts` command this view projects', () => {
    const { view } = mount(TWO);
    const footer = view.getByTestId('contracts-terminal').textContent!;
    expect(footer).toContain('sysprose -- verify');
    expect(
      footer,
      'the footer offers the inventory command as though it reached a verdict',
    ).not.toContain('sysprose -- contracts');
    expect(footer).toMatch(/run it in a terminal/i);
  });

  it('renders no verdict vocabulary anywhere on the page', () => {
    const { view } = mount(TWO);
    const text = view.container.textContent!.toLowerCase();
    for (const word of ['proved', 'refuted', 'holds-at-values']) {
      expect(text, `the panel prints the verdict word "${word}"`).not.toContain(word);
    }
  });
});

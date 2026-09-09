/**
 * buildContractsTable — the pure projection behind the Contracts view.
 *
 * The view is the app's door onto the question `sysprose -- contracts` answers,
 * and this file holds the two lines that make that door honest:
 *
 *  1. IT REPORTS, IT DOES NOT DECIDE. Every cell is something the model states
 *     or a gate refused; nothing in the model is a verdict, and the view says
 *     in its own words that the verdict is reached elsewhere, with the exact
 *     command. There is no solver in this bundle (z3 WASM needs
 *     `SharedArrayBuffer`, i.e. COOP/COEP headers GitHub Pages cannot set), so
 *     a cell that read like a result would be a sentence no code here can make
 *     true.
 *  2. ONE CENSUS, NOT TWO. The rows and the figures under them are projected
 *     from `contractReport` — the function the subcommand and the SDK call — so
 *     the view and the command cannot come to disagree about how many contracts
 *     a file has or how many subjects they are about. That agreement is
 *     asserted against the report itself rather than against remembered
 *     numbers.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Model } from '@core/index';
import { buildContractsTable, CONTRACT_COLUMNS, CONTRACTS_TERMINAL_COMMAND } from '@diagram/index';
import { contractReport } from '@api/index';
import { loadModelText } from '@text/load';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

async function load(text: string, name = 'probe.sysml'): Promise<Model> {
  const { model } = await loadModelText(text, { fileName: name });
  if (!model) throw new Error(`${name} produced no model`);
  return model;
}

describe('buildContractsTable over examples/uav-isr.sysml', () => {
  let model: Model;
  beforeAll(async () => {
    model = await load(read('examples/uav-isr.sysml'), 'examples/uav-isr.sysml');
  }, 60_000);

  it('has one row per contract, in the report’s order, named the way it names them', () => {
    const table = buildContractsTable(model);
    const report = contractReport(model);
    expect(table.rows.map((r) => r.qualifiedName)).toEqual(
      report.contracts.map((c) => c.qualifiedName),
    );
    expect(table.rows.map((r) => r.name)).toEqual([
      'EnduranceRequirement',
      'MassRequirement',
    ]);
  });

  it('shows the subject with the origin that put it there', () => {
    const table = buildContractsTable(model);
    for (const row of table.rows) {
      expect(row.subject).toBe('uav : AirVehicle');
      expect(row.subjectOrigin).toBe('declared');
    }
  });

  it('carries each clause body verbatim, with the gate’s own answer beside it', () => {
    const table = buildContractsTable(model);
    expect(table.rows.flatMap((r) => r.guarantees.map((g) => g.expression))).toEqual([
      'uav.endurance >= 45.0 [min]',
      'uav.mtow <= 25.0 [kg]',
    ]);
    for (const row of table.rows) {
      expect(row.assumptions).toEqual([]);
      expect(row.guarantees.every((g) => g.encodable)).toBe(true);
      expect(row.guarantees.every((g) => g.reason === null && g.refusal === null)).toBe(true);
      expect(row.guarantees.map((g) => g.role)).toEqual(['require']);
      expect(row.guarantees.map((g) => g.via)).toEqual(['requirement']);
      expect(row.fragment).toBe('qf-lra');
      expect(row.refused).toEqual([]);
    }
  });

  it('states an ID only where the file declares one — `attrs.id` is not a short name', () => {
    // The same pinned behaviour the requirements grid's empty ID column has and
    // the `refine` transcript quotes: `attribute id = "R-UAV-001";` is an
    // ordinary child attribute, so no contract in this example has a short id
    // and the view must not invent one.
    const table = buildContractsTable(model);
    expect(table.rows.map((r) => r.shortId)).toEqual(['', '']);
  });

  it('summarises with the report’s own figures, never with a second count', () => {
    const table = buildContractsTable(model);
    const report = contractReport(model);
    expect(table.summary).toEqual({
      contracts: report.total,
      subjects: report.subjects,
      noFormalClause: report.noFormalClause,
      assumptions: report.assumptions,
      guarantees: report.contracts.reduce((n, c) => n + c.guarantees.length, 0),
      refused: report.contracts.reduce((n, c) => n + c.unsupported.length, 0),
    });
    expect(table.summary.contracts).toBe(table.rows.length);
  });

  it('names a command that DECIDES, and reaches no verdict of its own', () => {
    const table = buildContractsTable(model);
    expect(table.terminal).toBe(CONTRACTS_TERMINAL_COMMAND);
    // The footer says no engine can run here and sends the reader to a
    // terminal, so the command it names has to be one that reaches a verdict.
    // `contracts` is not: it prints this same inventory and closes with "this
    // command says nothing about whether any of it holds", so naming it would
    // send a reader who wanted an answer back to the question. `verify` is the
    // only subcommand in this lane that decides anything.
    expect(table.terminal).toContain('sysprose -- verify');
    expect(
      table.terminal,
      'the view sends a reader wanting a verdict to the command that reaches none',
    ).not.toContain('sysprose -- contracts');
    // The engine is named too: `verify` with no engine is a different run.
    expect(table.terminal).toMatch(/--engine\s+\S+/);
    // The whole projection, as text: no verdict vocabulary anywhere in it.
    const serialised = JSON.stringify(table);
    for (const word of ['proved', 'refuted', 'pass', 'fail', 'holds-at-values']) {
      expect(serialised.toLowerCase(), `the table renders the verdict word "${word}"`).not.toContain(
        word,
      );
    }
    expect(table.columns).toBe(CONTRACT_COLUMNS);
    expect(CONTRACT_COLUMNS.map((c) => c.key)).toEqual([
      'id',
      'name',
      'subject',
      'assumptions',
      'guarantees',
      'refused',
      'fragment',
    ]);
  });
});

describe('buildContractsTable on the shapes a real requirement set is full of', () => {
  it('says where an inherited clause is filed rather than reading as empty', async () => {
    const model = await load(`package P {
    requirement def MassLimit {
        subject u : Sys;
        require constraint { u.mass <= 25.0 }
    }
    part def Sys { attribute mass; }
    requirement r : MassLimit;
}`);
    const table = buildContractsTable(model);
    const usage = table.rows.find((r) => r.qualifiedName === 'P::r');
    expect(usage, 'the usage has a row').toBeDefined();
    expect(usage!.assumptions).toEqual([]);
    expect(usage!.guarantees).toEqual([]);
    expect(usage!.inheritedFrom).toEqual(['P::MassLimit']);
    // …and the definition it inherits from owns the clause.
    const def = table.rows.find((r) => r.qualifiedName === 'P::MassLimit');
    expect(def!.guarantees.map((g) => g.expression)).toEqual(['u.mass <= 25.0']);
    expect(def!.inheritedFrom).toEqual([]);
  });

  it('shows a refused relation with the reason, rather than dropping it', async () => {
    const model = await load(`package P {
    part def Sys { attribute label : String; attribute mass; }
    requirement r {
        subject u : Sys;
        assume constraint { u.mass >= 0.0 }
        require constraint { u.label == "ok" }
    }
}`);
    const table = buildContractsTable(model);
    const row = table.rows.find((r) => r.qualifiedName === 'P::r')!;
    expect(row.assumptions.map((a) => a.role)).toEqual(['assume']);
    const refusedClauses = row.guarantees.filter((g) => !g.encodable);
    expect(
      refusedClauses.length + row.refused.length,
      'a relation the gates refused is reported, not dropped',
    ).toBeGreaterThan(0);
    expect(refusedClauses.map((c) => c.reason)).toEqual(['non-numeric-operand']);
    for (const clause of refusedClauses) {
      expect(clause.refusal, 'a refused clause carries the sentence a person reads').toBeTruthy();
    }
    expect(table.summary.refused).toBe(row.refused.length);
  });

  it('is empty, and says nothing, on a model that states no contract', async () => {
    const model = await load('package P { part def A; }');
    const table = buildContractsTable(model);
    expect(table.rows).toEqual([]);
    expect(table.summary.contracts).toBe(0);
    expect(table.summary.subjects).toBe(0);
  });
});

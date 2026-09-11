/**
 * buildContractsTable — project a {@link Model} into a
 * {@link ContractsTableModel} for the Contracts view.
 *
 * The sibling of {@link buildRequirementsTable}, and the app's door onto the
 * question `sysprose -- contracts` answers: what does each requirement ASSUME,
 * what does it GUARANTEE, and about which subject? A requirements grid says
 * what a requirement is *for*; this one says what it *states*, which is the
 * thing an engine is later asked to decide.
 *
 * IT DECIDES NOTHING, AND THAT IS NOT A GAP IN THE VIEW. There is no solver in
 * the browser in this plan — z3 WASM needs `SharedArrayBuffer`, which needs
 * COOP/COEP headers GitHub Pages cannot set — so the app reads what the model
 * states and names the terminal command that reaches a verdict
 * ({@link ContractsTableModel.terminal}), which is `verify` and NOT `contracts`:
 * `contracts` prints this same inventory in a terminal and says, in its own
 * footer, that it says nothing about whether any of it holds. Sending a reader
 * who wants a verdict to it would be sending them in a circle. A column that
 * showed `pass` here
 * would be a sentence no code in this bundle can make true, which is the one
 * thing the closing commit of the verification plan exists to prevent.
 *
 * ONE CENSUS, NOT TWO. The row set and every figure under it come from
 * `contractReport` — the same function the subcommand and the SDK call — rather
 * than from a second walk over the model. A view that counted subjects its own
 * way would eventually disagree with the command about how many there are, and
 * a reader would have no way to tell which number was about their file.
 *
 * PURE (no model mutation, no React), so it is unit-testable; the
 * `ContractsTable` panel calls it on every store revision to render live.
 */

import type { Model } from '@core/index';
import type { Contract, ContractClause } from '@semantics/contracts';
import { contractReport } from '@api/verification';
import type { ContractClauseCell, ContractRow, ContractsTableModel } from './types';

/**
 * The columns, in reading order: who is speaking, about what, under which
 * premise, promising what, and what could not be read.
 *
 * `Refused` is a column rather than a footnote because it is the number that
 * decides how much of the row an engine will ever see. A view that showed the
 * clauses and hid the refusals would let a reader believe a requirement was
 * fully encoded when half its body had been turned away at a unit gate.
 */
const COLUMNS: { key: string; label: string }[] = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Requirement' },
  { key: 'subject', label: 'Subject' },
  { key: 'assumptions', label: 'Assumes' },
  { key: 'guarantees', label: 'Guarantees' },
  { key: 'refused', label: 'Refused' },
  { key: 'fragment', label: 'Fragment' },
];

export const CONTRACT_COLUMNS = COLUMNS;

/**
 * The command that answers what this view will not.
 *
 * It is `verify`, not `contracts`. `contracts` is the command this view is a
 * projection OF — it prints the same inventory and closes with "this command
 * says nothing about whether any of it holds" — so naming it under a sentence
 * that begins "no in-browser engine could run here" would promise a verdict and
 * then hand the reader the same inventory again. `verify` is the only
 * subcommand that reaches one, and it is written out in full, with the engine
 * flag, because "run the verifier" is advice a reader cannot act on: a reader
 * who has to guess the invocation is being sent nowhere.
 */
export const CONTRACTS_TERMINAL_COMMAND = 'npm run sysprose -- verify <file.sysml> --engine smt';

/** One clause projected onto its cell — the gate's answer carried, not re-taken. */
function clauseCell(clause: ContractClause): ContractClauseCell {
  const refusal = clause.encodable === true ? null : clause.encodable;
  return {
    id: clause.id,
    role: clause.role,
    expression: clause.expression,
    via: clause.via,
    encodable: clause.encodable === true,
    reason: refusal ? refusal.reason : null,
    refusal: refusal ? refusal.detail : null,
    fragment: clause.fragment,
  };
}

/**
 * The subject, printed the way the contract states it and empty when it states
 * none.
 *
 * `— none` is deliberately NOT written here: an empty string is a cell the
 * renderer can style as absent, where a dash baked into the data would travel
 * into `--json` consumers as though the model had said it.
 */
function subjectLabel(contract: Contract): string {
  const subject = contract.subject;
  if (!subject) return '';
  return subject.typeRef ? `${subject.name} : ${subject.typeRef}` : subject.name;
}

export function buildContractsTable(model: Model): ContractsTableModel {
  const report = contractReport(model);
  const rows: ContractRow[] = report.contracts.map((contract) => ({
    id: contract.id,
    shortId: contract.shortId,
    name: contract.declaredName ?? '',
    qualifiedName: contract.qualifiedName,
    eClass: contract.eClass,
    subject: subjectLabel(contract),
    subjectOrigin: contract.subject ? contract.subject.origin : null,
    assumptions: contract.assumptions.map(clauseCell),
    guarantees: contract.guarantees.map(clauseCell),
    inheritedFrom: contract.clausesInheritedFrom.map((r) => r.qualifiedName),
    inheritedClauses: contract.inheritedClauses.length,
    refused: contract.unsupported.map((u) => ({
      expression: u.expression,
      reason: u.reason,
      detail: u.detail,
    })),
    fragment: contract.fragment,
    keywords: contract.keywords,
  }));

  return {
    columns: COLUMNS,
    rows,
    summary: {
      contracts: report.total,
      subjects: report.subjects,
      noFormalClause: report.noFormalClause,
      assumptions: report.assumptions,
      guarantees: report.contracts.reduce((n, c) => n + c.guarantees.length, 0),
      refused: report.contracts.reduce((n, c) => n + c.unsupported.length, 0),
    },
    terminal: CONTRACTS_TERMINAL_COMMAND,
  };
}

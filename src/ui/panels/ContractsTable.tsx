/**
 * ContractsTable — the Contracts view: what each requirement assumes and
 * guarantees, and about which subject.
 *
 * MODEL-BACKED, like the requirements grid: it reads the live {@link Model},
 * subscribes to `rev`, and re-derives its rows through
 * {@link buildContractsTable} on every mutation — ONCE per mutation, not once
 * per render, because the projection is memoised on `[model, rev]`. Selecting a
 * row changes `selectionId` and not `rev`, and re-walking every contract in the
 * file to repaint one highlighted row is a cost with nothing behind it; it is
 * also what would have made the README's "once per revision" a sentence the
 * code did not keep. Unlike that grid it is
 * READ-ONLY, and deliberately: a contract cell is the text of a clause, and the
 * place to edit a clause is the file (the Text tab) or the requirement body —
 * an editable projection of a body this view does not own is how two spellings
 * of one clause come to exist.
 *
 * AND IT REACHES NO VERDICT. There is no solver in the browser in this plan
 * (z3 WASM needs `SharedArrayBuffer`, i.e. COOP/COEP headers GitHub Pages
 * cannot set), so the view prints the exact terminal command that decides —
 * once, under the table — instead of a column a reader would read as a result.
 * `crossOriginIsolated` is asked rather than assumed: on a host that DOES send
 * those headers the sentence says so, because a hint that lies about why it is
 * there is worse than no hint.
 */

import { useMemo } from 'react';
import { buildContractsTable } from '@diagram/index';
import type { ContractClauseCell, ContractRow } from '@diagram/index';
import { useAppStore } from '../store';
import { proveInTerminalHint } from '../store';
import './panels.css';

/** What an empty cell shows — narrow, and never a word a reader could quote. */
const EMPTY = '—';

/** One clause line: the body, with the refusal beside it when a gate refused it. */
function ClauseLine({ clause }: { clause: ContractClauseCell }): JSX.Element {
  return (
    <div
      className="contract-clause"
      data-testid="contract-clause"
      data-role={clause.role}
      data-encodable={clause.encodable ? 'yes' : 'no'}
      title={clause.refusal ?? `${clause.fragment} · written on the ${clause.via}`}
    >
      <code>{clause.expression}</code>
      {!clause.encodable && (
        <span className="contract-refusal" data-testid="contract-refusal">
          {' '}
          — not encoded: {clause.reason}
        </span>
      )}
    </div>
  );
}

/** One contract row. */
function Row({
  row,
  selected,
  onSelect,
}: {
  row: ContractRow;
  selected: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <tr
      data-testid="contract-row"
      data-element-id={row.id}
      className={selected ? 'is-selected' : undefined}
      onClick={() => onSelect(row.id)}
    >
      <td data-testid="contract-shortid">{row.shortId || EMPTY}</td>
      <td>
        <span title={row.qualifiedName}>{row.name || row.qualifiedName}</span>
        {row.keywords.map((k) => (
          <span key={k} className="contract-keyword" data-testid="contract-keyword">
            {' '}
            #{k}
          </span>
        ))}
        {row.inheritedFrom.length > 0 && (
          <div className="contract-inherited" data-testid="contract-inherited">
            clauses filed on {row.inheritedFrom.join(', ')}
          </div>
        )}
      </td>
      <td data-testid="contract-subject">
        {row.subject || EMPTY}
        {row.subjectOrigin && <span className="contract-origin"> ({row.subjectOrigin})</span>}
      </td>
      <td data-testid="contract-assumes">
        {row.assumptions.length === 0
          ? EMPTY
          : row.assumptions.map((c) => <ClauseLine key={c.id} clause={c} />)}
      </td>
      <td data-testid="contract-guarantees">
        {row.guarantees.length === 0
          ? EMPTY
          : row.guarantees.map((c) => <ClauseLine key={c.id} clause={c} />)}
      </td>
      <td data-testid="contract-refused">{row.refused.length}</td>
      <td data-testid="contract-fragment">{row.fragment}</td>
    </tr>
  );
}

export function ContractsTable(): JSX.Element {
  // Re-render on every model mutation; read the live model directly.
  const rev = useAppStore((s) => s.rev);
  const model = useAppStore((s) => s.model);
  const selectionId = useAppStore((s) => s.selectionId);
  const select = useAppStore((s) => s.select);

  // Once per revision, not once per render: `selectionId` moves on every click.
  // `rev` is not "unnecessary": the `Model` is mutated IN PLACE, so its reference
  // is stable across edits and `rev` is the only dependency that moves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const table = useMemo(() => buildContractsTable(model), [model, rev]);
  const s = table.summary;

  return (
    <div className="contracts-table" data-testid="contracts-table">
      <table>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c.key} data-testid="contract-col-header" data-col-key={c.key}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <Row key={row.id} row={row} selected={row.id === selectionId} onSelect={select} />
          ))}
        </tbody>
      </table>
      {table.rows.length === 0 && (
        <div className="panel-empty" data-testid="contracts-empty">
          No requirement in this model states a contract yet.
        </div>
      )}
      {/* The census, measured off the rows the view is showing. */}
      <div className="contracts-summary" data-testid="contracts-summary">
        {s.contracts} contract(s) on {s.subjects} subject(s) — {s.assumptions} assumption(s),{' '}
        {s.guarantees} guarantee(s), {s.noFormalClause} with no formal clause, {s.refused} relation(s)
        not encoded.
      </div>
      {/* What this view will not do, and where it is done instead. */}
      <div className="contracts-terminal" data-testid="contracts-terminal">
        {proveInTerminalHint(table.terminal)}
      </div>
    </div>
  );
}

export default ContractsTable;

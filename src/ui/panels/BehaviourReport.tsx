/**
 * BehaviourReport — the terminal's own report, under a reach or check-behaviour
 * result, rendered line by line.
 *
 * The report is the CLI's text, one {@link ReportLine} per printed line. This
 * component renders those lines as TEXT NODES only — never `innerHTML` — and
 * adds just enough structure for an agent or a reader to act on: a machine
 * block (`checks-report-machine`) with a status, a property block
 * (`checks-report-property`) with its claim word, and a button on any line that
 * names an element, so clicking it selects that element.
 *
 * It imports no store. The selection action and whether an element still
 * exists come in as props, so it renders in a unit test against a plain model
 * without the app's loaders.
 */

import type { ReactNode } from 'react';
import type { StoredResult } from './checks-store';
import type { ReportLine } from '@semantics/mc/report-lines';

interface BehaviourReportProps {
  /** The check id — `reach` or `check-behaviour` — deciding machine vs property blocks. */
  checkId: string;
  /** The stored check result, with its `lines` and `walkOnlyKeys`. */
  stored: StoredResult;
  /** Does an element id still name a live element? Guards the selection button. */
  exists: (id: string) => boolean;
  /** Select an element the report names. */
  onSelect: (id: string) => void;
}

/** The line kinds that are a finding a reader acts on (warning/error rows). */
const FINDING_KINDS = new Set<ReportLine['kind']>([
  'undecided',
  'unreachable',
  'dead',
  'no-way-out',
  'trap',
  'choice',
]);

/** The reach `data-status` tokens and the chip that stands beside each. */
const STATUS_CHIP: ReadonlyArray<{ token: string; label: string }> = [
  { token: 'findings', label: 'findings' },
  { token: 'withheld', label: 'an answer withheld' },
  { token: 'walk-only', label: 'walk only' },
  { token: 'nothing-to-report', label: 'nothing to report' },
];

/** The six words, as the property line prints them, lower-cased back. */
function claimOf(line: ReportLine): string {
  return (line.text.trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/** The qualified name of a reach machine block, from its `machine` line. */
function machineNameOf(lines: readonly ReportLine[]): string {
  const machine = lines.find((l) => l.kind === 'machine');
  return machine !== undefined ? machine.text.trim().split(' [')[0] : '';
}

/** The `data-status` tokens of a reach machine block. */
function machineStatusOf(lines: readonly ReportLine[], walkOnlyKeys: ReadonlySet<string>): string {
  let findings = false;
  let withheld = false;
  let walkOnly = false;
  for (const l of lines) {
    if (l.withholds) withheld = true;
    if (l.rowKey !== null && walkOnlyKeys.has(l.rowKey)) walkOnly = true;
    else if (FINDING_KINDS.has(l.kind)) findings = true;
  }
  const tokens: string[] = [];
  if (findings) tokens.push('findings');
  if (withheld) tokens.push('withheld');
  if (walkOnly) tokens.push('walk-only');
  if (!findings && !withheld && !walkOnly) tokens.push('nothing-to-report');
  return tokens.join(' ');
}

/** One report line: text only, a button when it names an existing element (and is not a witness step). */
function lineNode(
  line: ReportLine,
  walkOnlyKeys: ReadonlySet<string>,
  exists: (id: string) => boolean,
  onSelect: (id: string) => void,
): ReactNode {
  const walkOnly = line.rowKey !== null && walkOnlyKeys.has(line.rowKey);
  const clickable = line.elementId !== null && line.kind !== 'witness-step' && exists(line.elementId);
  const body: ReactNode = clickable ? (
    <button type="button" onClick={() => onSelect(line.elementId as string)}>
      {line.text}
    </button>
  ) : (
    line.text
  );
  return (
    <div
      className="checks-report-line"
      data-kind={line.kind}
      data-code={line.code ?? undefined}
      data-withholds={line.withholds ? 'true' : 'false'}
      data-walk-only={walkOnly ? 'true' : undefined}
    >
      {body}
    </div>
  );
}

/** The whole report: the terminal's lines, grouped into machine or property blocks. */
export function BehaviourReport({ checkId, stored, exists, onSelect }: BehaviourReportProps): JSX.Element {
  const lines = stored.result.lines ?? [];
  const walkOnlyKeys = stored.result.walkOnlyKeys ?? new Set<string>();
  const walkOnlyRows = stored.result.rows.filter((r) => r.code === 'checks/walk-only');
  const walkOnlyByElement = new Map<string, string>();
  for (const row of walkOnlyRows) {
    if (row.elementId !== undefined) walkOnlyByElement.set(row.elementId, row.message);
  }
  let walkOnlyCursor = 0;

  const renderBlock = (block: number, blockLines: readonly ReportLine[]): ReactNode => {
    if (checkId === 'reach') {
      const name = machineNameOf(blockLines);
      const status = machineStatusOf(blockLines, walkOnlyKeys);
      const machineLine = blockLines.find((l) => l.kind === 'machine');
      const note = machineLine?.elementId != null ? walkOnlyByElement.get(machineLine.elementId) : undefined;
      return (
        <div className="checks-report-machine" data-machine={name} data-status={status}>
          <div className="checks-report-machine-head">
            <span className="checks-report-machine-name">{name}</span>
            {STATUS_CHIP.filter((c) => status.split(' ').includes(c.token)).map((c) => (
              <span key={c.token} className="checks-report-chip">
                {c.label}
              </span>
            ))}
          </div>
          {blockLines.map((l) => lineNode(l, walkOnlyKeys, exists, onSelect))}
          {note !== undefined && <div className="checks-report-note">{note}</div>}
        </div>
      );
    }
    // check-behaviour: one property block, with its claim word and demotion.
    const first = blockLines[0];
    const claim = first !== undefined ? claimOf(first) : '';
    const demoted = walkOnlyKeys.has(String(block));
    const note = demoted ? walkOnlyRows[walkOnlyCursor++]?.message : undefined;
    return (
      <div className="checks-report-property" data-claim={claim} data-walk-only={demoted ? 'true' : undefined}>
        <div className="checks-report-property-head">
          <span className="checks-report-chip">{claim.toUpperCase()}</span>
          {demoted && <span className="checks-report-chip">NOT COUNTED — WALK ONLY</span>}
        </div>
        {blockLines.map((l) => lineNode(l, walkOnlyKeys, exists, onSelect))}
        {demoted && note !== undefined && <div className="checks-report-note">{note}</div>}
      </div>
    );
  };

  const body: ReactNode[] = [];
  let current: { block: number; lines: ReportLine[] } | null = null;
  const flush = (): void => {
    if (current !== null) {
      body.push(renderBlock(current.block, current.lines));
      current = null;
    }
  };
  for (const line of lines) {
    if (line.block > 0) {
      if (current !== null && current.block === line.block) current.lines.push(line);
      else {
        flush();
        current = { block: line.block, lines: [line] };
      }
    } else {
      flush();
      body.push(lineNode(line, walkOnlyKeys, exists, onSelect));
    }
  }
  flush();

  return (
    <details open className="checks-report" data-testid="checks-report">
      <summary className="checks-report-title">The terminal's report — what {checkId} prints</summary>
      {body}
    </details>
  );
}

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
import { useBehaviourStore } from './behaviour-store';
import type { WitnessAt, WitnessView } from '../behaviour-checks';

interface BehaviourReportProps {
  /** The check id — `reach` or `check-behaviour` — deciding machine vs property blocks. */
  checkId: string;
  /** The stored check result, with its `lines` and `witnesses`. */
  stored: StoredResult;
  /** Does an element id still name a live element? Guards the selection button. */
  exists: (id: string) => boolean;
  /** Select an element the report names. */
  onSelect: (id: string) => void;
  /** The host's hook before a witness step opens (switches to the state view). */
  onStep?: (at: WitnessAt) => void;
}

/** The line kinds that are a finding a reader acts on (warning/error rows). */
const FINDING_KINDS = new Set<ReportLine['kind']>([
  'undecided',
  'unreachable',
  'dead',
  'no-way-out',
  'trap',
  'livelock',
  'choice',
]);

/** The reach `data-status` tokens and the chip that stands beside each. */
const STATUS_CHIP: ReadonlyArray<{ token: string; label: string }> = [
  { token: 'findings', label: 'findings' },
  { token: 'withheld', label: 'an answer withheld' },
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
function machineStatusOf(lines: readonly ReportLine[]): string {
  let findings = false;
  let withheld = false;
  for (const l of lines) {
    if (l.withholds) withheld = true;
    else if (FINDING_KINDS.has(l.kind)) findings = true;
  }
  const tokens: string[] = [];
  if (findings) tokens.push('findings');
  if (withheld) tokens.push('withheld');
  if (!findings && !withheld) tokens.push('nothing-to-report');
  return tokens.join(' ');
}

/** One report line: text only, a button when it names an existing element (and is not a witness step). */
function lineNode(
  line: ReportLine,
  exists: (id: string) => boolean,
  onSelect: (id: string) => void,
  key: string,
): ReactNode {
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
      key={key}
      className="checks-report-line"
      data-kind={line.kind}
      data-code={line.code ?? undefined}
      data-withholds={line.withholds ? 'true' : 'false'}
    >
      {body}
    </div>
  );
}

/** The whole report: the terminal's lines, grouped into machine or property blocks. */
export function BehaviourReport({ checkId, stored, exists, onSelect, onStep }: BehaviourReportProps): JSX.Element {
  const lines = stored.result.lines ?? [];

  // The witness stepper (step 6). The report reads the behaviour store directly
  // — it imports no `store.ts` — and the host switches the view through `onStep`.
  const openWitness = useBehaviourStore((s) => s.openWitness);
  const closeWitness = useBehaviourStore((s) => s.closeWitness);
  const witnessAt = useBehaviourStore((s) => s.witness);
  const witnesses = stored.result.witnesses ?? [];
  const viewOf = new Map<number, WitnessView>(witnesses.map((w) => [w.block, w]));

  /** Open the witness at one of its steps, never touching the selection. */
  const open = (view: WitnessView, index: number): void => {
    if (view.machineId === null) return;
    const at: WitnessAt = { resultAt: stored.at, machineId: view.machineId, block: view.block, step: index };
    onStep?.(at);
    openWitness(at);
  };

  const renderBlock = (block: number, blockLines: readonly ReportLine[]): ReactNode => {
    if (checkId === 'reach') {
      const name = machineNameOf(blockLines);
      const status = machineStatusOf(blockLines);
      return (
        <div key={`block-${block}`} className="checks-report-machine" data-machine={name} data-status={status}>
          <div className="checks-report-machine-head">
            <span className="checks-report-machine-name">{name}</span>
            {STATUS_CHIP.filter((c) => status.split(' ').includes(c.token)).map((c) => (
              <span key={c.token} className="checks-report-chip">
                {c.label}
              </span>
            ))}
          </div>
          {blockLines.map((l, i) => lineNode(l, exists, onSelect, `line-${i}`))}
        </div>
      );
    }
    // check-behaviour: one property block, with its claim word.
    const first = blockLines[0];
    const claim = first !== undefined ? claimOf(first) : '';
    const view = viewOf.get(block);
    const steppable = view !== undefined && view.machineId !== null;
    // The witness steps are buttons when the block has a drawable witness.
    const stepNode = (line: ReportLine, key: string): ReactNode => {
      if (steppable && view !== undefined) {
        return (
          <div
            key={key}
            className="checks-report-line"
            data-kind={line.kind}
            data-code={line.code ?? undefined}
            data-withholds={line.withholds ? 'true' : 'false'}
          >
            <button
              type="button"
              className="checks-witness-step"
              data-testid="checks-witness-step"
              data-step={line.step ?? 0}
              onClick={() => open(view, line.step ?? 0)}
            >
              {line.text}
            </button>
          </div>
        );
      }
      return lineNode(line, exists, onSelect, key);
    };
    const current = witnessAt !== null && witnessAt.block === block && witnessAt.resultAt === stored.at ? witnessAt.step : 0;
    const prev = (): void => open(view!, Math.max(0, current - 1));
    const next = (): void => open(view!, Math.min(view!.steps.length - 1, current + 1));
    return (
      <div key={`block-${block}`} className="checks-report-property" data-claim={claim}>
        <div className="checks-report-property-head">
          <span className="checks-report-chip">{claim.toUpperCase()}</span>
        </div>
        {blockLines.map((l, i) =>
          l.kind === 'witness-step' ? stepNode(l, `line-${i}`) : lineNode(l, exists, onSelect, `line-${i}`),
        )}
        {steppable && view !== undefined && (
          <div className="checks-witness-controls">
            <button type="button" className="checks-witness-prev" data-testid="checks-witness-prev" onClick={prev}>
              Prev
            </button>
            <button type="button" className="checks-witness-next" data-testid="checks-witness-next" onClick={next}>
              Next
            </button>
            <button type="button" className="checks-witness-close" data-testid="checks-witness-close" onClick={closeWitness}>
              Close
            </button>
          </div>
        )}
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
      body.push(lineNode(line, exists, onSelect, `head-${body.length}`));
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

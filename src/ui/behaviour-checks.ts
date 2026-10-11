/**
 * behaviour-checks — the two behaviour lanes as the palette runs them, and what
 * they mean in the page.
 *
 * The reach and check-behaviour palette rows are the CLI's answers, never an
 * app-invented verdict. `reachResult` and `behaviourResult` are pure over the
 * engine's reports plus the run-to-completion confirmation, so the unit tests
 * can pin them against the terminal's exact words; `reachCheck` and
 * `behaviourCheck` are the thin entries the registry calls, and only they touch
 * the engine. Everything here reads `@api` and `@core` for values, `./checks`
 * for types only, and no store (the load health is handed in).
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import { behaviourReport, reachReport, stateMachinesIn } from '@api/index';
import type { CheckContext, CheckResult, CheckRow } from './checks';
import { commandFileName } from './checks';
import {
  behaviourLines,
  behaviourMachineFor,
  libraryElementRefusal,
  reachLines,
  ELEMENT_REQUIRED_LEAD,
  NO_DEFAULT_MACHINE,
} from '@semantics/mc/report-lines';
import {
  confirmUnderRunToCompletion,
  walkOnlyDiagnostics,
  witnessRtcGap,
  type RtcConfirmation,
  type WitnessGap,
} from '@semantics/mc/rtc-gap';
import {
  exitCodeOf,
  propertiesOf,
  type BehaviourReport,
  type PropertyVerdict,
} from '@semantics/mc/patterns';
import { transitionLabel, type MachineReach, type ReachReport } from '@semantics/mc/explore';
import type { LoadHealth } from './store';

/* ────────────────────────────── reach, judged ───────────────────────────── */

/**
 * Does this machine decline to state at least one answer the walk would
 * otherwise print? The report's own withholding predicate: a machine withholds
 * when the walk was not exhaustive, when a list was suppressed, when it names
 * an unsupported construct or an undecided guard, when a no-way-out row was
 * withheld, or when the trap gate refused.
 */
export function withholds(m: MachineReach): boolean {
  return (
    !m.exhaustive ||
    m.suppressed ||
    m.unsupported.length > 0 ||
    m.undeterminedGuards.length > 0 ||
    m.deadlocksWithheld.length > 0 ||
    m.trapCensus.refusedByGate !== null
  );
}

/**
 * The user `StateUsage` / `ExhibitStateUsage` elements that are neither a
 * walked machine nor a descendant of one (N of A.1): a state the walk said
 * nothing about, because it belongs to no machine the walk covered.
 */
export function unwalkedStates(model: Model, r: ReachReport): ElementId[] {
  const walked = new Set<ElementId>();
  for (const m of r.machines) {
    walked.add(m.machine.id);
    for (const d of model.descendants(m.machine.id)) walked.add(d.id);
  }
  return model
    .all()
    .filter((el) => el.attrs.isLibrary !== true && (el.eClass === 'StateUsage' || el.eClass === 'ExhibitStateUsage'))
    .filter((el) => !walked.has(el.id))
    .map((el) => el.id);
}

/** The report's diagnostics, one row each, with the walk-only flag. */
function diagnosticRows(r: ReachReport, flags: readonly boolean[]): CheckRow[] {
  return r.diagnostics.map((d, i) => ({
    code: d.code ?? 'verification/internal',
    message: d.message,
    elementId: d.elementId,
    severity: d.severity,
    ...(flags[i] ? { walkOnly: true as const } : {}),
  }));
}

/**
 * The reach verdict, judged exactly as the CLI would: findings over
 * diagnostics the walk stands behind, `undecided` over anything withheld, and
 * `holds` only when every machine was walked to exhaustion with nothing
 * withheld and no finding. The load health demotes a pass, never promotes one.
 */
export function reachResult(
  r: ReachReport,
  model: Model,
  o: { fileName: string; health?: LoadHealth; confirmations: readonly RtcConfirmation[] },
): CheckResult {
  const M = r.machines.length;
  const K = r.machines.filter(withholds).length;
  const N = unwalkedStates(model, r);
  const flags = walkOnlyDiagnostics(r, o.confirmations);
  const walkOnlyKeys = new Set<string>();
  for (const c of o.confirmations) for (const k of c.unconfirmed) walkOnlyKeys.add(k);
  const F = r.diagnostics.filter((d, i) => (d.severity === 'error' || d.severity === 'warning') && !flags[i]).length;
  const W = r.diagnostics.filter((d, i) => (d.severity === 'error' || d.severity === 'warning') && flags[i]).length;
  const D = o.health === undefined || o.health.errors !== 0;

  const clauses: string[] = [];
  if (W > 0) clauses.push(`${W} more found by the walk only`);
  if (K > 0) clauses.push(`an answer withheld on ${K} of ${M} machine(s)`);
  if (N.length > 0) clauses.push(`${N.length} state(s) in no walked machine`);
  if (D) clauses.push('the model did not load cleanly');
  const clauseText = clauses.map((c) => `; ${c}`).join('');

  const lines = reachLines(r, { name: commandFileName(o.fileName) });
  const head = lines[0]?.text ?? '';
  const noMachine = (lines.find((l) => l.kind === 'empty')?.text ?? '').trim();

  const rows: CheckRow[] = [];
  // Row 1: a degraded model is reported as such, first.
  if (D && o.health !== undefined) rows.push(degradedRow('reach', o.health));
  // Row 2: one walk-only row per machine with unconfirmed rows.
  for (const c of o.confirmations) {
    if (c.unconfirmed.size === 0) continue;
    const m = r.machines.find((mm) => mm.machine.id === c.machineId);
    if (!m) continue;
    rows.push(walkOnlyRow(m.machine.id, m.machine.qualifiedName, c.unconfirmed.size));
  }
  // Row 3: one not-walked row per unwalked state.
  for (const id of N) {
    rows.push(notWalkedRow(model.qualifiedName(id) || id, id));
  }
  // Row 4: the report's diagnostics, one to one.
  rows.push(...diagnosticRows(r, flags));

  if (M === 0 && !D) {
    const summary = `${noMachine}${N.length > 0 ? `; ${N.length} state(s) belong to no walked machine` : ''}`;
    return { verdict: 'not-run', summary, rows, lines, walkOnlyKeys };
  }
  if (M === 0 && D) {
    const summary = `${noMachine} — the model did not load cleanly, so a machine may be missing from what parsed`;
    return { verdict: 'undecided', summary, rows, lines, walkOnlyKeys };
  }
  if (F > 0) {
    return { verdict: 'issues', summary: `${head} — ${F} finding(s)${clauseText}`, rows, lines, walkOnlyKeys };
  }
  if (W > 0 || K > 0 || N.length > 0 || D) {
    return {
      verdict: 'undecided',
      summary: `${head} — no finding${clauseText}: the Checks tab says which, and why`,
      rows,
      lines,
      walkOnlyKeys,
    };
  }
  return {
    verdict: 'holds',
    summary: `${head} — no finding and nothing withheld, under the bounds each machine prints`,
    rows,
    lines,
    walkOnlyKeys,
  };
}

/** The reach entry: the report, then the run-to-completion confirmation per machine. */
export function reachCheck(ctx: CheckContext, fileName: string): CheckResult {
  const r = reachReport(ctx.model);
  const confirmations = r.machines.map((m) => confirmUnderRunToCompletion(ctx.model, m));
  return reachResult(r, ctx.model, { fileName, health: ctx.loadHealth, confirmations });
}

/* ──────────────────────────── check-behaviour, judged ───────────────────── */

/** A machine carrying at least one property, by qualified name. */
function machinesWithProperties(model: Model): ElementRecord[] {
  return stateMachinesIn(model).filter((m) => propertiesOf(model, m.id).length > 0);
}

/**
 * The machine check-behaviour runs on, or the refusal and its pick rows.
 * Mirrors the terminal: `--element` names the machine, a library element is
 * refused, and a reference that holds several machines or none is refused by
 * name with the machines a person can pick.
 */
export type MachinePick =
  | { kind: 'machine'; id: ElementId; qualifiedName: string }
  | { kind: 'refused'; summary: string; rows: CheckRow[] };

function pickRow(model: Model, machine: ElementRecord): CheckRow {
  const qn = model.qualifiedName(machine.id) || machine.id;
  const n = propertiesOf(model, machine.id).length;
  return {
    code: 'checks/pick-machine',
    message: `${qn} — ${n} propert${n === 1 ? 'y' : 'ies'} in the file`,
    elementId: machine.id,
    severity: 'info',
  };
}

export function pickBehaviourMachine(model: Model, selectionId: string | null): MachinePick {
  const carriers = machinesWithProperties(model);
  const allMachines = stateMachinesIn(model);
  const defaultList = carriers.length > 0 ? carriers : allMachines;

  if (selectionId === null) {
    return {
      kind: 'refused',
      summary: `${ELEMENT_REQUIRED_LEAD}${NO_DEFAULT_MACHINE}`,
      rows: defaultList.map((m) => pickRow(model, m)),
    };
  }

  const el = model.get(selectionId);
  if (el !== undefined && el.attrs.isLibrary === true) {
    const qn = model.qualifiedName(selectionId) || selectionId;
    return {
      kind: 'refused',
      summary: libraryElementRefusal(qn),
      rows: defaultList.map((m) => pickRow(model, m)),
    };
  }

  const r = behaviourMachineFor(model, selectionId);
  if (r.ok) {
    const machine = r.machine;
    const qn = model.qualifiedName(machine.id) || machine.id;
    return { kind: 'machine', id: machine.id, qualifiedName: qn };
  }

  // Refused. The pick rows name what a person can narrow to: the one machine
  // that holds a state named by the selection, the several machines a
  // reference holds, or — when neither applies — every carrier (or machine).
  let list: ElementRecord[];
  if (r.holder !== null) {
    const holder = model.get(r.holder);
    list = holder !== undefined ? [holder] : [];
  } else if (r.candidates.length > 0) {
    list = r.candidates.map((id) => model.get(id)).filter((x): x is ElementRecord => x !== undefined);
  } else {
    list = defaultList;
  }
  return {
    kind: 'refused',
    summary: r.message,
    rows: list.map((m) => pickRow(model, m)),
  };
}

/** Re-count the six words after demoting each gap-flagged `fail`/`covered` to `inconclusive`. */
function demotedCounts(b: BehaviourReport, gaps: readonly (WitnessGap | null)[]): BehaviourReport['counts'] {
  const counts = { ...b.counts };
  b.properties.forEach((p, i) => {
    if (gaps[i] === null) return;
    if (p.claim === 'fail') counts.failed -= 1;
    if (p.claim === 'covered') counts.covered -= 1;
    counts.inconclusive += 1;
  });
  return counts;
}

/** One walk-only row for a property whose witness takes a run-to-completion gap. */
function walkOnlyPropertyRow(b: BehaviourReport, p: PropertyVerdict, gap: WitnessGap): CheckRow {
  const step = p.witness.find((s) => s.index === gap.step);
  const event = step?.event ?? '';
  const message =
    gap.lost || gap.completion === null
      ? `step ${gap.step} of its witness could not be replayed with the walk's own steps`
      : `${p.sentence}: step ${gap.step} of its witness takes \`${event}\` while ${transitionLabel(gap.completion)} is enabled — run-to-completion fires that transition first, so this run may not be one the profile admits. The terminal reports ${p.claim} and exits ${b.exitCode}; this page does not count it as decided.`;
  return { code: 'checks/walk-only', message, elementId: b.machine?.id, severity: 'info' };
}

/**
 * The verdict of check-behaviour: the exit code mapped, demoted by walk-only
 * witnesses, and `undecided` on a degraded model.
 */
export function behaviourResult(
  b: BehaviourReport,
  model: Model,
  o: { fileName: string; machineName: string; health?: LoadHealth },
): CheckResult {
  const D = o.health === undefined || o.health.errors !== 0;
  const machineId = b.machine?.id ?? null;
  const gaps: (WitnessGap | null)[] = b.properties.map((p) =>
    (p.claim === 'fail' || p.claim === 'covered') && machineId !== null
      ? witnessRtcGap(model, machineId, p.witness)
      : null,
  );
  const G = gaps.filter((g) => g !== null).length;
  const counts = demotedCounts(b, gaps);
  const n = b.properties.length;

  const code = D ? 2 : exitCodeOf(counts, n, false);
  const verdict = (['holds', 'issues', 'undecided'] as const)[code];

  const lines = behaviourLines(b, { name: commandFileName(o.fileName), machineName: o.machineName });
  const rows: CheckRow[] = [];
  if (D && o.health !== undefined) rows.push(degradedRow('check-behaviour', o.health));
  b.properties.forEach((p, i) => {
    const gap = gaps[i];
    if (gap !== null) rows.push(walkOnlyPropertyRow(b, p, gap));
  });
  rows.push(
    ...b.diagnostics.map((d) => ({
      code: d.code ?? 'verification/internal',
      message: d.message,
      elementId: d.elementId,
      severity: d.severity,
    })),
  );

  const walkOnlyKeys = new Set<string>();
  b.properties.forEach((_p, i) => {
    if (gaps[i] !== null) walkOnlyKeys.add(String(i + 1));
  });

  let summary = lines[0]?.text ?? '';
  if (G > 0) summary += ` — ${G} of them rest on a witness run-to-completion does not take, so they are not counted as decided`;
  if (D) summary += ` — the model did not load cleanly, so nothing is judged over it`;

  return { verdict, summary, rows, lines, walkOnlyKeys };
}

/** The check-behaviour entry: the machine pick, the report, the witness replays. */
export function behaviourCheck(ctx: CheckContext, fileName: string): CheckResult {
  const pick = pickBehaviourMachine(ctx.model, ctx.selectionId);
  if (pick.kind === 'refused') {
    return { verdict: 'not-run', summary: pick.summary, rows: pick.rows };
  }
  const b = behaviourReport(ctx.model, { machineId: pick.id });
  return behaviourResult(b, ctx.model, { fileName, machineName: pick.qualifiedName, health: ctx.loadHealth });
}

/* ───────────────────────────── the meta rows ─────────────────────────────── */

/**
 * The `checks/degraded` row, from the load health, for a command that exits 1
 * (reach) or 2 (check-behaviour).
 */
export function degradedRow(cmd: 'reach' | 'check-behaviour', health: LoadHealth): CheckRow {
  let text: string;
  if (health.unwritable !== null) {
    text = `The model cannot be written as text (${health.unwritable}), so no file holds it`;
  } else if (health.saved !== null && health.exported !== null && health.sameText && health.saved.parseErrors > 0) {
    text = `The model's text has ${health.saved.parseErrors} syntax error(s)`;
  } else if (health.saved !== null && health.exported !== null && !health.sameText) {
    text = `The text this model was applied from, which Save writes, has ${health.saved.parseErrors} syntax error(s); the text Export ▾ SysML writes has ${health.exported.parseErrors}`;
  } else {
    text = `The model's text has ${health.saved?.parseErrors ?? 0} syntax error(s)`;
  }
  if (health.validationErrors > 0) text += `; ${health.validationErrors} validation error(s) on your elements`;

  if (cmd === 'reach') {
    const which = health.unwritable !== null ? 'that text' : health.sameText ? 'the text Save writes' : 'either text';
    let tail = `. This is a report of what parsed; \`reach\` on a file holding ${which} exits 1`;
    if (
      health.unwritable === null &&
      !health.sameText &&
      health.exported !== null &&
      health.exported.parseErrors === 0 &&
      health.validationErrors === 0
    ) {
      tail += '; Export ▾ SysML writes the model as it stands, and that text parses';
    }
    text += tail;
  } else {
    text += `. Nothing is judged over half a model: \`check-behaviour\` on a file holding that text exits 2`;
  }
  return { code: 'checks/degraded', message: text, severity: 'warning' };
}

/** The `checks/walk-only` row, one per machine with unconfirmed rows. */
export function walkOnlyRow(elementId: string, qualifiedName: string, count: number): CheckRow {
  return {
    code: 'checks/walk-only',
    message: `\`${qualifiedName}\`: ${count} of its rows were found by this walk only — it takes events where a trigger-less transition is enabled, which run-to-completion does not, and a walk that does not (run here, under the same bounds) did not reach them. They are listed below and not counted as findings; whether a run reaches them is not decided here.`,
    elementId,
    severity: 'info',
  };
}

/** The `checks/not-walked` row, one per unwalked state. */
export function notWalkedRow(qualifiedName: string, elementId: string): CheckRow {
  return {
    code: 'checks/not-walked',
    message: `\`${qualifiedName}\` belongs to no state machine this walk covered, so nothing here is said about it.`,
    elementId,
    severity: 'info',
  };
}

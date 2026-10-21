/**
 * behaviour-checks — the two behaviour lanes as the palette runs them, and what
 * they mean in the page.
 *
 * The reach and check-behaviour palette rows are the CLI's answers, never an
 * app-invented verdict. `reachResult` and `behaviourResult` are pure over the
 * engine's reports, so the unit tests can pin them against the terminal's exact
 * words; `reachCheck` and `behaviourCheck` are the thin entries the registry
 * calls, and only they touch the engine. Everything here reads `@api` and
 * `@core` for values, `./checks` for types only, and no store (the load health
 * is handed in).
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import { behaviourReport, reachReport, stateMachinesIn } from '@api/index';
import type { CheckContext, CheckResult, CheckRow } from './checks';
import { commandFileName } from './checks';
import type { ViewKind } from '@diagram/index';
import {
  behaviourLines,
  behaviourMachineFor,
  libraryElementRefusal,
  reachLines,
  ELEMENT_REQUIRED_LEAD,
  NO_DEFAULT_MACHINE,
  type ReportLine,
} from '@semantics/mc/report-lines';
import {
  isLoneDefinition,
  loneCarriersIn,
  propertiesOf,
  traceLine,
  type BehaviourReport,
} from '@semantics/mc/patterns';
import type { MachineReach, ReachReport } from '@semantics/mc/explore';
import { regionDescendants } from '@semantics/mc/config';
import type { LoadHealth, TextLoad } from './store';
import type { StoredResult } from './panels/checks-store';

/* ────────────────────────────── reach, judged ───────────────────────────── */

/**
 * Does this machine decline to state at least one answer the walk would
 * otherwise print? The report's own withholding predicate: a machine withholds
 * when the walk was not exhaustive, when a list was suppressed, when it names
 * an unsupported construct or an undecided guard, when a no-way-out row or a
 * completion livelock was withheld, or when the trap gate refused.
 */
export function withholds(m: MachineReach): boolean {
  return (
    !m.exhaustive ||
    m.suppressed ||
    m.unsupported.length > 0 ||
    m.undeterminedGuards.length > 0 ||
    m.deadlocksWithheld.length > 0 ||
    m.livelocksWithheld.length > 0 ||
    m.trapCensus.refusedByGate !== null
  );
}

/**
 * The user `StateUsage` / `ExhibitStateUsage` elements that are neither a
 * walked machine nor a descendant of one (N of A.1): a state the walk said
 * nothing about, because it belongs to no machine the walk covered.
 */
export function unwalkedStates(model: Model, r: ReachReport, scopeId?: ElementId): ElementId[] {
  // A report scoped to an element says nothing of the states outside it, so none of them is "unwalked".
  const inScope = scopeId === undefined ? undefined : new Set<ElementId>([scopeId, ...model.descendants(scopeId).map((d) => d.id)]);
  const walked = new Set<ElementId>();
  for (const m of r.machines) {
    walked.add(m.machine.id);
    for (const d of regionDescendants(model, m.machine.id)) walked.add(d.id);
  }
  return model
    .all()
    .filter((el) => el.attrs.isLibrary !== true && (el.eClass === 'StateUsage' || el.eClass === 'ExhibitStateUsage'))
    .filter((el) => !walked.has(el.id) && (inScope === undefined || inScope.has(el.id)))
    .map((el) => el.id);
}

/** The report's diagnostics, one row each. */
function diagnosticRows(r: ReachReport): CheckRow[] {
  return r.diagnostics.map((d) => ({
    code: d.code ?? 'verification/internal',
    message: d.message,
    elementId: d.elementId,
    severity: d.severity,
  }));
}

/**
 * The reach verdict, judged as the CLI judges it: findings over the
 * diagnostics, `undecided` over anything withheld, and `holds` only when every
 * machine was walked to exhaustion with nothing withheld and no finding. The
 * load health demotes a pass, never promotes one: `holds` needs a health that
 * says every text a file of the model can hold was parsed and loads cleanly, as
 * a terminal loads it (`loadHealth`, `./store.ts`), so a text the CLI rejects,
 * or one whose load could not be checked, is never `holds`.
 */
export function reachResult(
  r: ReachReport,
  model: Model,
  o: { fileName: string; health?: LoadHealth; scopeId?: ElementId },
): CheckResult {
  const M = r.machines.length;
  const K = r.machines.filter(withholds).length;
  const N = unwalkedStates(model, r, o.scopeId);
  const F = r.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warning').length;
  const D = o.health === undefined || o.health.errors !== 0;

  const clauses: string[] = [];
  if (K > 0) clauses.push(`an answer withheld on ${K} of ${M} machine(s)`);
  if (N.length > 0) clauses.push(`${N.length} state(s) in no walked machine`);
  if (D) clauses.push(notClean(o.health));
  const clauseText = clauses.map((c) => `; ${c}`).join('');

  const lines = reachLines(r, {
    name: commandFileName(o.fileName),
    ...(o.scopeId !== undefined ? { scopeName: model.qualifiedName(o.scopeId) || o.scopeId } : {}),
  });
  const head = lines[0]?.text ?? '';
  const noMachine = (lines.find((l) => l.kind === 'empty')?.text ?? '').trim();

  const rows: CheckRow[] = [];
  // Row 1: a degraded model is reported as such, first.
  if (D && o.health !== undefined) rows.push(degradedRow('reach', o.health));
  // Row 2: one not-walked row per unwalked state.
  for (const id of N) {
    rows.push(notWalkedRow(model.qualifiedName(id) || id, id));
  }
  // Row 3: the report's diagnostics, one to one.
  rows.push(...diagnosticRows(r));

  // The per-state marks and the status-panel summary they feed (A.4), plus the
  // per-edge marks (S7: dead transitions, undecided guards).
  const { marks, edgeMarks, summary: markSummary } = reachMarks(model, r, o.scopeId);

  if (M === 0 && !D) {
    const summary = `${noMachine}${N.length > 0 ? `; ${N.length} state(s) belong to no walked machine` : ''}`;
    return { verdict: 'not-run', summary, rows, lines, marks, edgeMarks, markSummary };
  }
  if (M === 0 && D) {
    const summary = onlyOtherModel(o.health)
      ? `${noMachine} — ${notClean(o.health)}, which may hold a machine this one does not`
      : `${noMachine} — ${notClean(o.health)}, so a machine may be missing from what parsed`;
    return { verdict: 'undecided', summary, rows, lines, marks, edgeMarks, markSummary };
  }
  if (F > 0) {
    return { verdict: 'issues', summary: `${head} — ${F} finding(s)${clauseText}`, rows, lines, marks, edgeMarks, markSummary };
  }
  if (K > 0 || N.length > 0 || D) {
    return {
      verdict: 'undecided',
      summary: `${head} — no finding${clauseText}: the Checks tab says which, and why`,
      rows,
      lines,
      marks,
      edgeMarks,
      markSummary,
    };
  }
  return {
    verdict: 'holds',
    summary: `${head} — no finding and nothing withheld, under the bounds each machine prints`,
    rows,
    lines,
    marks,
    edgeMarks,
    markSummary,
  };
}

/** The reach entry: the report, judged; narrowed to `scopeId` and what it contains, as `--element` narrows it. */
export function reachCheck(ctx: CheckContext, fileName: string, scopeId?: ElementId): CheckResult {
  const r = reachReport(ctx.model, scopeId !== undefined ? { scopeId } : {});
  return reachResult(r, ctx.model, { fileName, health: ctx.loadHealth, scopeId });
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
 * name with the machines a person can pick. A LONE DEFINITION that carries a
 * property (`isLoneDefinition`, `@semantics/mc/patterns`) is no machine, but
 * named it reports what it carries as not checked, and nothing else does: so
 * `kind: 'machine'` may carry one, as `behaviourMachineFor` may return one, and
 * the pick rows list every such definition beside the machines.
 */
export type MachinePick =
  | { kind: 'machine'; id: ElementId; qualifiedName: string }
  | { kind: 'refused'; summary: string; rows: CheckRow[] };

function pickRow(model: Model, machine: ElementRecord): CheckRow {
  const qn = model.qualifiedName(machine.id) || machine.id;
  const n = propertiesOf(model, machine.id).length;
  const lone = isLoneDefinition(model, machine)
    ? `, on a \`state def\` that is no machine: selected, ${n === 1 ? 'it is' : 'they are'} reported as not checked`
    : '';
  return {
    code: 'checks/pick-machine',
    message: `${qn} — ${n} propert${n === 1 ? 'y' : 'ies'} in the file${lone}`,
    elementId: machine.id,
    severity: 'info',
  };
}

export function pickBehaviourMachine(model: Model, selectionId: string | null): MachinePick {
  const carriers = machinesWithProperties(model);
  const allMachines = stateMachinesIn(model);
  // The lone definitions that carry a property, after the machines: listed
  // with the machines only, they were the one carrier no pick row offered, and
  // nothing selected them but a person who knew to. They count as carriers, so
  // every machine is listed only when nothing in the file carries a property:
  // beside a lone carrier, a machine with none is a pick that decides nothing.
  const lones = loneCarriersIn(model);
  const defaultList = carriers.length + lones.length === 0 ? allMachines : [...carriers, ...lones];

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
  // that holds a state named by the selection (or the lone definition that
  // holds it and carries a property), the several machines and lone
  // definitions a reference holds (or, when the lone definition that holds the
  // selection carries nothing, the machines written inside it), or — when
  // neither applies — every machine and lone definition that carries a
  // property (every machine, when nothing does).
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

/**
 * The verdict of check-behaviour: the exit code mapped, and `undecided` on a
 * degraded model. The engine's walk obeys run-to-completion, so no witness
 * needs demoting.
 */
export function behaviourResult(
  b: BehaviourReport,
  model: Model,
  o: { fileName: string; machineName: string; health?: LoadHealth },
): CheckResult {
  const D = o.health === undefined || o.health.errors !== 0;

  const code = D ? 2 : b.exitCode;
  const verdict = (['holds', 'issues', 'undecided'] as const)[code];

  const lines = behaviourLines(b, { name: commandFileName(o.fileName), machineName: o.machineName });
  const rows: CheckRow[] = [];
  if (D && o.health !== undefined) rows.push(degradedRow('check-behaviour', o.health));
  rows.push(
    ...b.diagnostics.map((d) => ({
      code: d.code ?? 'verification/internal',
      message: d.message,
      elementId: d.elementId,
      severity: d.severity,
    })),
  );

  let summary = lines[0]?.text ?? '';
  if (D) summary += ` — ${notClean(o.health)}, so nothing is judged over it`;

  return { verdict, summary, rows, lines, witnesses: compactWitnesses(b, lines) };
}

/**
 * The check-behaviour entry: the machine pick, the report — and, on a lone
 * definition, a pick row for each machine written inside it. Its rows are
 * `not checked` and name those machines, which their own names check; the rows
 * give the person the selection that does, as the terminal's sentence gives
 * the `--element` that does.
 */
export function behaviourCheck(ctx: CheckContext, fileName: string): CheckResult {
  const pick = pickBehaviourMachine(ctx.model, ctx.selectionId);
  if (pick.kind === 'refused') {
    return { verdict: 'not-run', summary: pick.summary, rows: pick.rows };
  }
  const b = behaviourReport(ctx.model, { machineId: pick.id });
  const result = behaviourResult(b, ctx.model, { fileName, machineName: pick.qualifiedName, health: ctx.loadHealth });
  const picked = ctx.model.get(pick.id);
  if (picked === undefined || !isLoneDefinition(ctx.model, picked)) return result;
  const inside = stateMachinesIn(ctx.model, pick.id);
  return inside.length === 0 ? result : { ...result, rows: [...result.rows, ...inside.map((m) => pickRow(ctx.model, m))] };
}

/* ───────────────────────────── the meta rows ─────────────────────────────── */

/** The one thing wrong with the load is that a text of the model parses cleanly to another model ({@link LoadHealth.otherModel}). */
function onlyOtherModel(health: LoadHealth | undefined): boolean {
  return health?.otherModel === true && health.errors === 1;
}

/**
 * How a summary says the model is not taken as loading cleanly: it did not, a
 * file of it holds another model, or nobody could check whether it does.
 */
function notClean(health: LoadHealth | undefined): string {
  if (health?.unchecked != null) return 'whether the model loads cleanly could not be checked';
  if (onlyOtherModel(health)) return 'the text a file of it holds reads as another model';
  return 'the model did not load cleanly';
}

/** How the row says a text parses cleanly to another model than the one on screen ({@link LoadHealth.otherModel}). */
const OTHER_MODEL =
  'parses cleanly, but to a model other than the one on screen: written back from its parse it reads otherwise (a field written back as typed can close its owner, add a declaration or turn the rest of its line into a comment), so a terminal given a file holding it checks that other model';

/** What the row says of one text's syntax: a parse's count, or the faulty values the serializer found in a text it did not parse. */
function textFaults(t: TextLoad): string {
  return t.basis === 'signal'
    ? `holds ${t.parseErrors} value(s) written back as typed that the grammar cannot read where they stand, found as the text was written: it was not parsed, so this is not a terminal's count of syntax errors`
    : `has ${t.parseErrors} syntax error(s)`;
}

/**
 * Which text a terminal refuses, as the `reach` row names it: where the two texts
 * differ and validation found nothing, only the one with syntax errors — a file
 * holding the other loads, so it is not said to exit 1.
 */
function refusedText(health: LoadHealth): string {
  if (health.unwritable !== null) return 'that text';
  if (health.sameText) return 'the text Save writes';
  const { saved, exported } = health;
  if (health.validationErrors === 0 && saved !== null && exported !== null) {
    if (exported.parseErrors === 0) return 'the text Save writes';
    if (saved.parseErrors === 0) return 'the text Export ▾ SysML writes';
  }
  return 'either text';
}

/**
 * The `checks/degraded` row, from the load health, for a command that exits 1
 * (reach) or 2 (check-behaviour): what made the model not count as loading
 * cleanly — the load could not be checked, the model cannot be written, a text of
 * it does not parse or parses to another model, validation finds errors on the
 * user's elements, or validation itself failed. It says what a terminal does with
 * a file holding the text only where that follows from what was found.
 */
export function degradedRow(cmd: 'reach' | 'check-behaviour', health: LoadHealth): CheckRow {
  const row = (message: string): CheckRow => ({ code: 'checks/degraded', message, severity: 'warning' });
  if (health.unchecked != null) {
    // Nothing is known of the text, so nothing is said of what a terminal would do with it.
    const why = `Whether the model's text loads could not be checked (${health.unchecked}), so it is not taken as loading cleanly`;
    return row(
      cmd === 'reach'
        ? `${why}: this is a report of what parsed. Run the check again, or the command in a terminal`
        : `${why} and nothing is judged over it. Run the check again, or the command in a terminal`,
    );
  }
  const { saved, exported } = health;
  const clauses: string[] = [];
  // A terminal refuses a file holding the text: no file at all, a syntax error, or a validation error.
  let refused = false;
  if (health.unwritable !== null) {
    clauses.push(`The model cannot be written as text (${health.unwritable}), so no file holds it`);
    refused = true;
  } else if (saved !== null && exported !== null) {
    if (health.sameText) {
      if (saved.parseErrors > 0) clauses.push(`The model's text ${textFaults(saved)}`);
      else if (saved.otherModel === true) clauses.push(`The model's text ${OTHER_MODEL}`);
      refused = saved.parseErrors > 0;
    } else {
      if (saved.parseErrors + exported.parseErrors > 0) {
        clauses.push(`The text this model was applied from, which Save writes, ${textFaults(saved)}; the text Export ▾ SysML writes ${textFaults(exported)}`);
      }
      if (saved.otherModel === true) clauses.push(`the text Save writes ${OTHER_MODEL}`);
      if (exported.otherModel === true) clauses.push(`the text Export ▾ SysML writes ${OTHER_MODEL}`);
      refused = saved.parseErrors + exported.parseErrors > 0;
    }
  }
  if (health.validationErrors > 0) {
    clauses.push(clauses.length === 0 ? `Validation finds ${health.validationErrors} error(s) on your elements` : `${health.validationErrors} validation error(s) on your elements`);
    refused = true;
  }
  if (health.validateThrew) {
    if (clauses.length === 0) {
      // The one reason is the tool's own failure: no claim about what a terminal prints.
      return row(`Validation of the model failed with an internal error, so whether it loads cleanly is not known and nothing is judged over it. This is a tool defect, not a verdict on the model`);
    }
    clauses.push('validation of the model failed with an internal error, so what it would find is not known');
  }
  if (clauses.length === 0) clauses.push(`The model's text has ${saved?.parseErrors ?? 0} syntax error(s)`);
  let text = clauses.join('; ');
  text = text.charAt(0).toUpperCase() + text.slice(1);

  if (cmd === 'reach') {
    if (refused) {
      let tail = `. This is a report of what parsed; \`reach\` on a file holding ${refusedText(health)} exits 1`;
      if (
        health.unwritable === null &&
        !health.sameText &&
        exported !== null &&
        exported.parseErrors === 0 &&
        exported.otherModel !== true &&
        health.validationErrors === 0
      ) {
        tail += '; Export ▾ SysML writes the model as it stands, and that text parses';
      }
      text += tail;
    } else {
      // The file loads: what a terminal says of it is its walk of the other model, which is not this one's.
      text += '. This is a report of the model on screen, not of the model a file of it holds';
    }
  } else {
    text += refused
      ? `. Nothing is judged over half a model: \`check-behaviour\` on a file holding that text exits 2`
      : '. Nothing is judged over it: a file holding that text holds another model';
  }
  return row(text);
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

/* ──────────────────────────── the state-view marks ───────────────────────── */

/**
 * The one mark a node may carry, by the A.4 precedence. Precisely one word
 * each, so an agent branches on the class and a reader on the badge.
 */
export type ReachMark =
  | 'unreachable'
  | 'not-decided'
  | 'not-walked'
  | 'withheld'
  | 'no-way-out'
  | 'trap'
  | 'choice';

/** The marks in painting precedence: a node takes the first that applies (A.4). */
export const MARK_ORDER: readonly ReachMark[] = [
  'unreachable',
  'not-decided',
  'not-walked',
  'withheld',
  'no-way-out',
  'trap',
  'choice',
];

/** The badge word of each mark, as the CLI prints the row. */
export const MARK_WORD: Record<ReachMark, string> = {
  unreachable: 'unreachable',
  'not-decided': 'not decided',
  'not-walked': 'not walked',
  withheld: 'withheld',
  'no-way-out': 'no way out',
  trap: 'trap',
  choice: 'choice',
};

/** The node class of each mark, interned so two calls give the same string. */
const MARK_CLASS: Record<ReachMark, string> = {
  unreachable: 'rf-beh rf-beh-unreachable',
  'not-decided': 'rf-beh rf-beh-not-decided',
  'not-walked': 'rf-beh rf-beh-not-walked',
  withheld: 'rf-beh rf-beh-withheld',
  'no-way-out': 'rf-beh rf-beh-no-way-out',
  trap: 'rf-beh rf-beh-trap',
  choice: 'rf-beh rf-beh-choice',
};

/**
 * The one mark an EDGE may carry (S7): a transition the walk proved dead, or
 * one whose guard it could not decide. Both are rows in the Checks tab already;
 * this puts the word on the transition the row is about.
 */
export type EdgeMark = 'dead' | 'undecided';

/** The badge word of each edge mark, as the CLI prints the row. */
export const EDGE_MARK_WORD: Record<EdgeMark, string> = {
  dead: 'dead',
  undecided: 'undecided',
};

/** The edge class of each edge mark, interned so two calls give the same string. */
const EDGE_MARK_CLASS: Record<EdgeMark, string> = {
  dead: 'rf-beh-edge rf-beh-edge-dead',
  undecided: 'rf-beh-edge rf-beh-edge-undecided',
};

/** The witness node classes, interned so two calls give the same string. */
const WITNESS_AT_CLASS = 'rf-beh-witness-at';
const WITNESS_STACK_CLASS = 'rf-beh-witness-stack';
const WITNESS_SEEN_CLASS = 'rf-beh-witness-seen';

/**
 * What the status panel says about a reach run, apart from the marks
 * themselves: how many machines, how many of each mark, and the three withheld
 * counts (trap answer, not-decided machines, not-walked).
 */
export interface MarkSummary {
  /** Machines walked (`r.machines.length`). */
  machines: number;
  /** States marked, per mark word. */
  marked: Partial<Record<ReachMark, number>>;
  /** Transitions marked, per edge-mark word (S7). */
  edgeMarked: Partial<Record<EdgeMark, number>>;
  /** Machines whose trap answer was refused by the gate (a machine-level fact, never a state mark). */
  trapWithheld: number;
  /** Machines that are suppressed or unsupported: whether a state is reachable was not decided. */
  notDecidedOn: number;
  /** States marked `not walked`. */
  notWalked: number;
}

/**
 * The mark per state, by the A.4 precedence, plus the {@link MarkSummary} the
 * status panel reads. The walk obeys run-to-completion, so every deadlock and
 * choice row it published stands as a finding.
 */
export function reachMarks(
  model: Model,
  r: ReachReport,
  scopeId?: ElementId,
): {
  marks: Record<ElementId, ReachMark>;
  edgeMarks: Record<ElementId, EdgeMark>;
  summary: MarkSummary;
} {
  const marks: Record<ElementId, ReachMark> = {};
  const marked: Partial<Record<ReachMark, number>> = {};
  const edgeMarks: Record<ElementId, EdgeMark> = {};
  const edgeMarked: Partial<Record<EdgeMark, number>> = {};
  let trapWithheld = 0;
  let notDecidedOn = 0;

  // First mark wins: the A.4 precedence is the call order below.
  const put = (id: ElementId, mark: ReachMark): void => {
    if (marks[id] !== undefined) return;
    marks[id] = mark;
    marked[mark] = (marked[mark] ?? 0) + 1;
  };
  // The edge marks are disjoint: a dead transition is one the walk proved never
  // fires, and an undecided guard is one it could not decide — the second empties
  // the first's list (`m.transitions.dead` is published only on an exact walk).
  const putEdge = (id: ElementId, mark: EdgeMark): void => {
    if (edgeMarks[id] !== undefined) return;
    edgeMarks[id] = mark;
    edgeMarked[mark] = (edgeMarked[mark] ?? 0) + 1;
  };

  for (const m of r.machines) {
    if (m.trapCensus.refusedByGate !== null) trapWithheld += 1;
    if (m.suppressed || m.unsupported.length > 0) notDecidedOn += 1;

    // 1. `unreachable` — the published list only (empty when not exhaustive).
    for (const s of m.states.unreachable) put(s.id, 'unreachable');

    // 2. `not decided` — unreached descendants of a suppressed or unsupported machine.
    if (m.suppressed || m.unsupported.length > 0) {
      const reached = new Set(m.states.reachable.map((s) => s.id));
      for (const d of regionDescendants(model, m.machine.id)) {
        if (d.eClass !== 'StateUsage' && d.eClass !== 'ExhibitStateUsage') continue;
        if (reached.has(d.id)) continue;
        put(d.id, 'not-decided');
      }
    }

    // 4. `withheld` — the leaf of a `deadlocksWithheld` row.
    for (const d of m.deadlocksWithheld) put(d.leaf.id, 'withheld');

    // 5. `no way out` — a published deadlock.
    for (const d of m.deadlocks) put(d.leaf.id, 'no-way-out');

    // 6. `trap` — the states of every published trap, composites included.
    for (const t of m.traps) for (const s of t.states) put(s.id, 'trap');

    // 7. `choice` — a published nondeterministic choice.
    for (const n of m.nondeterminism) put(n.state.id, 'choice');

    // The edge marks (S7): a dead transition, or a guard the walk could not
    // decide, on the transition itself.
    for (const t of m.transitions.dead) putEdge(t.id, 'dead');
    for (const g of m.undeterminedGuards) putEdge(g.transition.id, 'undecided');
  }

  // 3. `not walked` — the N states of A.1, under no walked machine at all.
  const unwalked = unwalkedStates(model, r, scopeId);
  for (const id of unwalked) put(id, 'not-walked');

  return {
    marks,
    edgeMarks,
    summary: {
      machines: r.machines.length,
      marked,
      edgeMarked,
      trapWithheld,
      notDecidedOn,
      notWalked: marked['not-walked'] ?? 0,
    },
  };
}

/** `HH:MM` of a timestamp, in the user's own clock. */
function clock(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * The collapsed status line: the marks on the diagram, then the withheld
 * counts — a count is printed only when it is non-zero (A.6: never `0`).
 */
export function marksStatusLine(s: MarkSummary, at: number): string {
  const words = MARK_ORDER.filter((m) => (s.marked[m] ?? 0) > 0).map(
    (m) => `${s.marked[m]} ${MARK_WORD[m]}`,
  );
  // The edge marks read after the state marks, in their own words (S7).
  if ((s.edgeMarked.dead ?? 0) > 0) words.push(`${s.edgeMarked.dead} dead transition(s)`);
  if ((s.edgeMarked.undecided ?? 0) > 0) words.push(`${s.edgeMarked.undecided} undecided guard(s)`);
  const line = `Reachability, ${clock(at)} — ${words.length > 0 ? words.join(', ') : 'no state marked'}`;
  const clauses: string[] = [];
  if (s.trapWithheld > 0) clauses.push(`trap answer withheld on ${s.trapWithheld} of ${s.machines}`);
  if (s.notDecidedOn > 0) clauses.push(`not decided on ${s.notDecidedOn} machine(s)`);
  if (s.notWalked > 0) clauses.push(`${s.notWalked} not walked`);
  return clauses.length > 0 ? `${line} · ${clauses.join(' · ')}` : line;
}

/**
 * The expanded status text: what each mark means, plus one clause per withheld
 * count. The details toggle shows it; nothing here is ever folded away.
 */
export function marksStatusText(s: MarkSummary): string {
  const base =
    'Each mark except "not decided" and "not walked" names a row in the Checks tab; "not decided" marks the unreached states of a machine whose lists were withheld — that machine\u2019s SUPPRESSED or not-explored line says why — and "not walked" marks a state that belongs to no machine the walk covered. A `dead` or `undecided` edge mark names a row the same way, drawn on the transition itself: `dead` on a transition the walk proved never fires and `undecided` on one whose guard it could not evaluate. An unmarked state of a walked machine is one this walk reached — it obeys run-to-completion, so it takes no event while a trigger-less transition is due — but it explores both branches of a nondeterministic choice and advances no clock, so that is not a claim that a simulation run gets there.';
  const clauses: string[] = [];
  if (s.trapWithheld > 0) {
    clauses.push(
      `The trap answer was withheld on ${s.trapWithheld} of ${s.machines} machine(s) (the Checks tab says why): an unmarked state there has not been shown to lie outside a trap.`,
    );
  }
  if (s.notDecidedOn > 0) {
    clauses.push(`Whether a state is reachable was not decided on ${s.notDecidedOn} machine(s).`);
  }
  return clauses.length > 0 ? `${base} ${clauses.join(' ')}` : base;
}

/** What the status panel says once the model has changed under a run. */
export const STALE_MARKS_TEXT =
  'The model changed after this Reachability run, so nothing is marked — run it again from the palette.';

/**
 * What the status panel says while a witness is open (A.5): each step is a run
 * the run-to-completion replay admits, but it is the walk's run, never a
 * simulation. The sentence names no cause — the interpreter may take it, or it
 * may not, and this page is not claiming which.
 */
export const WITNESS_NOT_SIMULATION = (qn: string, k: number, n: number): string =>
  `Step ${k} of ${n} of a witness for \`${qn}\` from Behaviour properties. Each step is one run-to-completion allows — no event is taken while a trigger-less transition is enabled — but this is the run the checker's walk found, not a simulation: the Simulation tab runs the interpreter, which may never take it. Reachability marks and the simulation highlight are hidden until it is closed.`;

/* ──────────────────────────────── the witnesses ──────────────────────────── */

/** One step of a compact witness, as the canvas paints it. */
export interface WitnessStep {
  /** The `TraceStep` index: 0 is the opening configuration. */
  readonly index: number;
  /** The CLI's `traceLine` row, verbatim. */
  readonly text: string;
  readonly leafId: ElementId | null;
  readonly stackIds: ElementId[];
  readonly transitionId: ElementId | null;
}

/**
 * A property's witness, compacted for the stepper: the block it belongs to,
 * the machine it is about, and the steps. The engine's walk obeys
 * run-to-completion, so every witness it produced may be drawn and stepped.
 */
export interface WitnessView {
  readonly block: number;
  readonly machineId: ElementId | null;
  /** The property line, as the terminal prints it. */
  readonly header: string;
  readonly steps: readonly WitnessStep[];
}

/**
 * The witnesses of a check-behaviour run, one per property whose witness is
 * non-empty (step 6).
 *
 * The steps' texts are the CLI's `traceLine` rows — the same strings the report
 * prints — so a step's `text` and the report's `witness-step` line agree.
 */
export function compactWitnesses(
  b: BehaviourReport,
  lines: readonly ReportLine[],
): WitnessView[] {
  const machineId = b.machine?.id ?? null;
  const views: WitnessView[] = [];
  b.properties.forEach((p, i) => {
    if (p.witness.length === 0) return;
    const block = i + 1;
    const header = lines.find((l) => l.block === block && l.kind === 'property')?.text ?? '';
    const steps: WitnessStep[] = p.witness.map((s) => ({
      index: s.index,
      text: traceLine(s),
      leafId: s.leaf?.id ?? null,
      stackIds: s.stack.map((x) => x.id),
      transitionId: s.transition?.id ?? null,
    }));
    views.push({ block, machineId, header, steps });
  });
  return views;
}

/**
 * A witness the canvas is stepping through, named by the run it came from and
 * the step it is on (step 6; nothing opens one before then).
 */
export interface WitnessAt {
  resultAt: number;
  machineId: ElementId;
  block: number;
  step: number;
}

/**
 * The mark/witness classes for each node, and whether a witness is open.
 *
 * Marks paint only for a stored reach result at the current revision, in the
 * state view, not hidden, and with no witness open (I5). The class strings are
 * interned ({@link MARK_CLASS}), so two calls over the same input return the
 * same strings by reference — the value-stability that replaces an identity
 * test on the memoized nodes (H5-b).
 */
export function behaviourClassesOf(i: {
  reach?: StoredResult;
  beh?: StoredResult;
  rev: number;
  activeView: ViewKind;
  marksHidden: boolean;
  witness: WitnessAt | null;
  machineExists: (id: ElementId) => boolean;
}): {
  classes: ReadonlyMap<ElementId, string>;
  edgeClasses: ReadonlyMap<ElementId, string>;
  edgeMarks: ReadonlyMap<ElementId, EdgeMark>;
  witnessOpen: boolean;
} {
  const witness = i.witness;
  const beh = i.beh;
  const witnessOpen =
    witness !== null &&
    beh !== undefined &&
    beh.rev === i.rev &&
    beh.at === witness.resultAt &&
    i.machineExists(witness.machineId);

  // An open witness paints the walk's run: the step's leaf, its stack
  // ancestors, and the leaves already passed (A.5). It hides the marks, edges
  // included.
  if (witnessOpen && witness !== null && beh !== undefined) {
    const view = beh.result.witnesses?.find((v) => v.block === witness.block);
    if (view !== undefined) {
      const step = view.steps.find((s) => s.index === witness.step);
      if (step !== undefined) {
        const classes = new Map<ElementId, string>();
        // Earlier leaves first, so a later override wins where two share an id.
        for (const s of view.steps) {
          if (s.index < witness.step && s.leafId !== null && s.leafId !== step.leafId) {
            classes.set(s.leafId, WITNESS_SEEN_CLASS);
          }
        }
        for (const id of step.stackIds) {
          if (id !== step.leafId) classes.set(id, WITNESS_STACK_CLASS);
        }
        if (step.leafId !== null) classes.set(step.leafId, WITNESS_AT_CLASS);
        return { classes, edgeClasses: new Map(), edgeMarks: new Map(), witnessOpen };
      }
    }
    return { classes: new Map(), edgeClasses: new Map(), edgeMarks: new Map(), witnessOpen };
  }

  if (
    i.reach === undefined ||
    i.reach.rev !== i.rev ||
    i.activeView !== 'state' ||
    i.marksHidden
  ) {
    return { classes: new Map(), edgeClasses: new Map(), edgeMarks: new Map(), witnessOpen };
  }
  const classes = new Map<ElementId, string>();
  const marks = i.reach.result.marks ?? {};
  for (const [id, mark] of Object.entries(marks)) {
    const cls = MARK_CLASS[mark];
    if (cls !== undefined && i.machineExists(id)) classes.set(id, cls);
  }
  const edgeClasses = new Map<ElementId, string>();
  const edgeWords = new Map<ElementId, EdgeMark>();
  const storedEdgeMarks = i.reach.result.edgeMarks ?? {};
  for (const [id, mark] of Object.entries(storedEdgeMarks)) {
    const cls = EDGE_MARK_CLASS[mark];
    if (cls !== undefined && i.machineExists(id)) {
      edgeClasses.set(id, cls);
      edgeWords.set(id, mark);
    }
  }
  return { classes, edgeClasses, edgeMarks: edgeWords, witnessOpen };
}

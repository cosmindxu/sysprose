/**
 * checks — the verification commands, per view, as the palette offers them.
 *
 * One registry so three surfaces cannot drift: the palette's Checks section,
 * the Checks tab that lists results, and the command a person copies to run the
 * same thing in a terminal. Every entry names a real CLI subcommand
 * (`scripts/lib/sysprose-spec.ts`), and a unit test asserts that.
 *
 * Two engines:
 *  - `model` — a pure function over the loaded model (`src/api`), so it runs
 *    here, now, against exactly what is on screen. Most are a few milliseconds
 *    (measured on the drone-swarm model, `docs/TEST-REPORT.md` §2.15). The two
 *    that walk configuration graphs, `reach` and `check-behaviour`, are not
 *    guaranteed to be: a state machine of two dozen states with five composites
 *    among them takes the walk to its 10,000-configuration bound, a fifth of a
 *    second for `reach` and half a second for `check-behaviour`, and a larger
 *    one more. Those carry {@link CheckSpec.offThread}: the palette runs them in
 *    a worker (`panels/checks-runner.ts`) with the same function, so a result is
 *    the same wherever it was computed.
 *  - `solver` — needs z3, which needs a cross-origin-isolated page. When the
 *    page is not isolated the entry does not pretend: it reports `unavailable`
 *    with the reason and the exact terminal command. A check that cannot run
 *    must never read as one that passed (the Agent Diagnostics Contract's rule
 *    for this project: no silent pass).
 *
 * Some checks read the selection, and their command names it: `where-used` and
 * `check-behaviour` as `--element`, `bounds` as `--measure`. `contracts` and
 * `obligations` take an optional `--element` that narrows the report to an
 * element and what it contains; run here they narrow to the selection the same
 * way, so a result and its copied command cover the same elements, and where
 * the selection cannot scope them ({@link checkScope}) both cover the whole
 * model and the summary says so. Not yet the same: `check-behaviour` here
 * checks the selected machine or else the model's first, where its command
 * takes the one machine inside the selection or is refused; and `reach` covers
 * the whole model, as its command does, although that subcommand takes an
 * optional `--element` too.
 *
 * Every row carries a stable `code`, like every other finding in this project,
 * so automation branches on the code and never on the prose.
 */

import { isAnnotation, isControlNode, isRelationship, type Model } from '@core/index';
import type { ViewKind } from '@diagram/index';
import {
  modelMetrics,
  orphanReport,
  connectivityReport,
  requirementSatisfaction,
  whereUsed,
  reachReport,
  behaviourReport,
  stateMachinesIn,
  contractReport,
  obligationsReport,
  traceabilityMatrix,
} from '@api/index';

/** What a check says about the model when it has run. */
export type CheckVerdict = 'not-run' | 'running' | 'holds' | 'issues' | 'undecided' | 'unavailable' | 'stale';

/** One finding, shaped like every other finding in the app. */
export interface CheckRow {
  code: string;
  message: string;
  elementId?: string;
  severity: 'info' | 'warning' | 'error';
}

export interface CheckResult {
  verdict: CheckVerdict;
  /** One line a person reads first. */
  summary: string;
  rows: CheckRow[];
}

export interface CheckContext {
  model: Model;
  /** The selected element, when there is one — what `--element` would name. */
  selectionId: string | null;
  selectionName: string | null;
  /** Whether z3 can run on this page. */
  isolated: boolean;
  /** The model's file name, for the copyable command. */
  fileName: string;
}

export interface CheckSpec {
  /** Stable id, and the CLI subcommand it runs. */
  id: string;
  /** What a person wants to know, in their words. */
  question: string;
  /** Short label for the palette row. */
  label: string;
  engine: 'model' | 'solver';
  /** The views that offer it. */
  views: readonly ViewKind[];
  /** True when the check reads the selected element. */
  needsSelection?: boolean;
  /**
   * True when the check narrows to the selected element and what it contains,
   * as `--element` narrows it in a terminal, and covers the whole model — and
   * says so — when there is no selection to narrow to ({@link checkScope}).
   */
  scopedBySelection?: boolean;
  /**
   * True when the check walks a state machine's configuration graph, whose cost
   * grows with the machine and not with the model: the palette runs it in a
   * worker (a busy state, Cancel, a result tagged with the model it read), and
   * on this thread only where the page has no worker, or no state machine to
   * walk ({@link hasStateMachine}). `run` is the same function in both places,
   * so the two cannot disagree.
   */
  offThread?: boolean;
  /** The terminal command that runs the same check. */
  command(ctx: CheckContext): string;
  /** Runs it here; absent for solver checks, which the runner handles. */
  run?(ctx: CheckContext): CheckResult;
}

const GRAPHS: readonly ViewKind[] = ['general', 'interconnection', 'action', 'state', 'requirement', 'tree', 'parametric', 'case'];
const ALL_VIEWS: readonly ViewKind[] = [
  ...GRAPHS,
  'sequence',
  'geometry',
  'allocation',
  'grid',
  'requirements',
  'analysis',
  'planning',
  'regroup',
  'contracts',
];

/*
 * The names in a command. The commands below are pasted into whatever terminal
 * a person has — bash or zsh, and on Windows cmd.exe or PowerShell — and the
 * names in them are not this app's to choose: a Google Drive file is called
 * whatever its owner typed (`Swarm (copy).sysml`, or worse), and a qualified
 * name may hold quoted parts. No quoting protects a word in all of those
 * shells — cmd.exe reads `&` inside '…' as the end of a command, and a POSIX
 * `'\''` closes a PowerShell string — so a name goes into a command only when
 * it is a plain word that every one of them passes on as it is. Any other
 * name is left out: a file is named by a stand-in made of plain characters,
 * an element by the `<qualified name>` placeholder — always a command's last
 * words, where each of those shells refuses the `>` with nothing after it and
 * runs nothing — and {@link commandNote} says beside the command what each
 * stands for.
 */

/** A file name no shell reads as anything but itself: letters, digits, `_ . -`, not starting with `-` (an option) or `.`. */
const PLAIN_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** A qualified name of plain identifiers, `A::B::c` — `::` is a plain word in all those shells too. */
const PLAIN_QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/;

/** The placeholder a person replaces with an element's qualified name. */
export const QUALIFIED_NAME_PLACEHOLDER = '<qualified name>';

/**
 * The file name a command names: `fileName` itself when it is a plain word,
 * else a stand-in of plain characters — every other character an `_` — that
 * the person saves the file as (see {@link commandNote}).
 */
export function commandFileName(fileName: string): string {
  if (PLAIN_FILE.test(fileName)) return fileName;
  const stand = fileName.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[.-]/, '_');
  return stand === '' ? 'model.sysml' : stand;
}

/** Whether a qualified name can stand in a command as it is (see {@link commandFileName}). */
export function plainQualifiedName(name: string): boolean {
  return PLAIN_QUALIFIED.test(name);
}

const cli = (sub: string, ctx: CheckContext, extra = ''): string =>
  `npm run sysprose -- ${sub} ${commandFileName(ctx.fileName)}${extra ? ` ${extra}` : ''}`;

/** The selected element's qualified name when it is a plain word, else the placeholder a person fills in. */
const selected = (ctx: CheckContext): string =>
  ctx.selectionName && plainQualifiedName(ctx.selectionName) ? ctx.selectionName : QUALIFIED_NAME_PLACEHOLDER;

const element = (ctx: CheckContext): string => `--element ${selected(ctx)}`;

/**
 * What a check that narrows to the selection covers: the selected element and
 * what it contains — what `--element` names in a terminal — or the whole model,
 * with the reason, when there is nothing to narrow to.
 */
export type CheckScope = { kind: 'element'; id: string; name: string } | { kind: 'model'; why: string };

/**
 * The scope the selection gives a {@link CheckSpec.scopedBySelection} check.
 *
 * Two kinds of selection are no scope. The check covers the whole model
 * instead, its command names no element, and its summary says why:
 *  - A bundled library element. The terminal refuses one as `--element`
 *    (`verificationScope`, `scripts/sysprose.ts`), because every figure in
 *    these reports leaves the library out, and an inventory of zero contracts
 *    would read exactly like a model with none.
 *  - An element that can contain no contract or obligation: a comment, a
 *    textual representation, an import or another relationship, a control
 *    node. The app selects the model's first root on open, and in a file that
 *    starts with a header comment or an import that root is one of these.
 *    Scoped to it, a Run nobody narrowed would report zero of everything.
 */
export function checkScope(ctx: CheckContext): CheckScope {
  const el = ctx.selectionId !== null ? ctx.model.get(ctx.selectionId) : undefined;
  if (el === undefined) return { kind: 'model', why: 'nothing is selected' };
  const name = ctx.selectionName || el.id;
  if (el.attrs.isLibrary === true) {
    return { kind: 'model', why: `${name} is a bundled library element, and these figures leave the library out` };
  }
  if (isAnnotation(el.eClass) || isRelationship(el.eClass) || isControlNode(el.eClass)) {
    return { kind: 'model', why: `${name} contains no contract or obligation` };
  }
  return { kind: 'element', id: el.id, name };
}

/**
 * What of the selection a check's result depends on: the scope a
 * {@link CheckSpec.scopedBySelection} check covered, the element a
 * {@link CheckSpec.needsSelection} check read, and `undefined` for a check that
 * never reads the selection. The palette shows a result as `stale` once this
 * moves, because the command beside it then names another element.
 *
 * Every whole-model scope is one key, whatever its reason: it covers the same
 * elements and its command names none, so a result stays current while the
 * selection moves between them. The reason in its summary is the one at the
 * click (`docs/USER-GUIDE.md`, the palette's Checks row).
 */
export function selectionKey(spec: CheckSpec, ctx: CheckContext): string | undefined {
  if (spec.scopedBySelection === true) {
    const scope = checkScope(ctx);
    return scope.kind === 'element' ? `element ${scope.id}` : 'model';
  }
  if (spec.needsSelection === true) return ctx.selectionId ?? '';
  return undefined;
}

/** `--element` when the selection scopes the check; nothing — the terminal's whole-model default — when it does not. */
const scopeFlag = (ctx: CheckContext): string => (checkScope(ctx).kind === 'element' ? element(ctx) : '');

/** The words a scoped check's summary ends on: what it covered, so a result never reads wider or narrower than it is. */
const scopeWords = (scope: CheckScope): string =>
  scope.kind === 'element' ? `scoped to ${scope.name}` : `covers the whole model: ${scope.why}`;

/**
 * ` of N` after a scoped figure, N the whole model's: a count narrowed to one
 * package of several must never read as the model's total. Nothing when the
 * figure already is the whole model's.
 *
 * `scoped` is the figure just computed. When the scope is the one root there is,
 * it contains every element a person wrote and IS the whole model's figure, so
 * the second pass over the model is not made: the app selects that root on
 * open, so the first Run of `obligations` on the drone-swarm model was twice the
 * 25 ms one pass takes (`docs/TEST-REPORT.md` §2.15).
 */
const ofWhole = (scope: CheckScope, model: Model, scoped: number, whole: () => number): string => {
  if (scope.kind !== 'element') return '';
  const roots = model.roots().filter((r) => r.attrs.isLibrary !== true);
  return ` of ${roots.length === 1 && roots[0].id === scope.id ? scoped : whole()}`;
};

/** The same, as a row with a code, so automation reads the scope without parsing the summary. */
const scopeRow = (scope: CheckScope): CheckRow =>
  scope.kind === 'element'
    ? { code: 'checks/scoped', message: `${scopeWords(scope)} and what it contains`, elementId: scope.id, severity: 'info' }
    : { code: 'checks/whole-model', message: scopeWords(scope), severity: 'info' };

const holds = (summary: string, rows: CheckRow[] = []): CheckResult => ({ verdict: 'holds', summary, rows });
const issues = (summary: string, rows: CheckRow[]): CheckResult =>
  rows.length > 0 ? { verdict: 'issues', summary, rows } : holds(summary);

/** The registry. Order inside a view is the order the palette shows. */
export const CHECKS: readonly CheckSpec[] = [
  {
    id: 'stats',
    label: 'Model size',
    question: 'How big is this model, and what shape is it?',
    engine: 'model',
    views: ALL_VIEWS,
    command: (ctx) => cli('stats', ctx),
    run: (ctx) => {
      const m = modelMetrics(ctx.model);
      return holds(`${m.totalElements} elements, ${m.relationshipCount} relationships, depth ${m.maxDepth}`, [
        { code: 'stats/elements', message: `${m.nodeCount} elements, ${m.relationshipCount} relationships, ${m.rootCount} root(s)`, severity: 'info' },
        { code: 'stats/depth', message: `containment depth ${m.maxDepth}; ${m.diagramableCount} drawable elements`, severity: 'info' },
      ]);
    },
  },
  {
    id: 'orphans',
    label: 'Unconnected definitions',
    question: 'Is any definition connected to nothing at all?',
    engine: 'model',
    views: ALL_VIEWS,
    command: (ctx) => cli('orphans', ctx),
    run: (ctx) => {
      const r = orphanReport(ctx.model);
      return issues(
        `${r.orphans.length} of ${r.definitionsExamined} definitions touch nothing`,
        r.orphans.map((o) => ({ code: 'orphans/unconnected', message: `${o.declaredName ?? o.qualifiedName} is connected to nothing`, elementId: o.id, severity: 'warning' })),
      );
    },
  },
  {
    id: 'connectivity',
    label: 'Ports wired',
    question: 'Is every port wired to something?',
    engine: 'model',
    views: ['interconnection', 'general', 'allocation', 'geometry'],
    command: (ctx) => cli('connectivity', ctx),
    run: (ctx) => {
      const r = connectivityReport(ctx.model);
      return issues(
        `${r.connectedPortCount} of ${r.portCount} ports wired, ${r.connectionCount} connections`,
        r.unconnectedPorts.map((p) => ({ code: 'connectivity/unconnected-port', message: `port ${p.declaredName ?? p.qualifiedName} is wired to nothing`, elementId: p.id, severity: 'warning' })),
      );
    },
  },
  {
    id: 'requirements',
    label: 'Requirement coverage',
    question: 'Which requirements does nothing satisfy?',
    engine: 'model',
    views: ['requirement', 'requirements', 'case', 'contracts', 'general'],
    command: (ctx) => cli('requirements', ctx),
    run: (ctx) => {
      const r = requirementSatisfaction(ctx.model);
      const open = r.requirements.filter((q) => !q.satisfied);
      return issues(
        `${r.satisfied} of ${r.total} requirements satisfied (${Math.round(r.coverage * 100)}%)`,
        open.map((q) => ({ code: 'requirements/unsatisfied', message: `${q.requirement.declaredName ?? q.requirement.qualifiedName} is satisfied by nothing`, elementId: q.requirement.id, severity: 'warning' })),
      );
    },
  },
  {
    id: 'trace',
    label: 'Traceability',
    question: 'What traces to what, and what traces to nothing?',
    engine: 'model',
    views: ['allocation', 'requirement', 'requirements', 'tree', 'action'],
    command: (ctx) => cli('trace', ctx, '--relation allocate --from ActionUsage --to PartUsage'),
    run: (ctx) => {
      // What the CLI's `trace --relation allocate` reads: which behaviour each
      // component carries. Rows with no link are what a reader is looking for.
      const m = traceabilityMatrix(ctx.model, 'ActionUsage', 'PartUsage', 'Allocation');
      const linked = new Set(m.links.map((l) => l.from));
      const rows: CheckRow[] = m.rows
        .filter((r) => !linked.has(r.id))
        .map((r) => ({ code: 'trace/unallocated', message: `${r.declaredName ?? r.qualifiedName} is allocated to nothing`, elementId: r.id, severity: 'warning' }));
      return issues(`${m.links.length} allocation(s) over ${m.rows.length} action(s) and ${m.columns.length} part(s)`, rows);
    },
  },
  {
    id: 'where-used',
    label: 'Where used',
    question: 'Where is the selected element used?',
    engine: 'model',
    views: ALL_VIEWS,
    needsSelection: true,
    command: (ctx) => cli('where-used', ctx, element(ctx)),
    run: (ctx) => {
      if (!ctx.selectionId) return { verdict: 'not-run', summary: 'Select an element first — this check reads the selection.', rows: [] };
      const r = whereUsed(ctx.model, ctx.selectionId);
      return holds(
        `${ctx.selectionName ?? 'the selection'}: used by ${r.usedBy.length} element(s), ${r.references.length} reference(s)`,
        r.usedBy.slice(0, 50).map((u) => ({ code: 'where-used/used-by', message: `${u.declaredName ?? u.qualifiedName} (${u.eClass})`, elementId: u.id, severity: 'info' })),
      );
    },
  },
  {
    id: 'reach',
    label: 'Reachability',
    question: 'Can every state be reached, and does every transition fire?',
    engine: 'model',
    offThread: true,
    views: ['state', 'action', 'general'],
    command: (ctx) => cli('reach', ctx),
    run: (ctx) => {
      const r = reachReport(ctx.model);
      const rows: CheckRow[] = [];
      for (const m of r.machines) {
        for (const s of m.states.unreachable) rows.push({ code: 'verification/unreachable-state', message: `${m.machine.name ?? m.machine.id}: state ${s.name ?? s.id} is never reached`, elementId: s.id, severity: 'error' });
        for (const t of m.transitions.dead) rows.push({ code: 'verification/dead-transition', message: `${m.machine.name ?? m.machine.id}: a transition never fires`, elementId: t.id, severity: 'warning' });
      }
      if (r.machines.length === 0) return { verdict: 'not-run', summary: 'No state machine in this model.', rows: [] };
      const partial = r.machines.filter((m) => !m.exhaustive).length;
      if (rows.length === 0 && partial > 0)
        return { verdict: 'undecided', summary: `${partial} machine(s) hit a bound — nothing is claimed about them`, rows: r.machines.filter((m) => !m.exhaustive).map((m) => ({ code: 'verification/bound-hit', message: `${m.machine.name ?? m.machine.id}: ${m.qualification}`, elementId: m.machine.id, severity: 'info' })) };
      return issues(`${r.machines.length} machine(s), ${r.totals.unreachable} unreachable state(s), ${r.totals.dead} dead transition(s)`, rows);
    },
  },
  {
    id: 'check-behaviour',
    label: 'Behaviour properties',
    question: 'Do the properties this machine states hold on every run?',
    engine: 'model',
    offThread: true,
    views: ['state', 'action'],
    needsSelection: true,
    command: (ctx) => cli('check-behaviour', ctx, element(ctx)),
    run: (ctx) => {
      const machines = stateMachinesIn(ctx.model);
      if (machines.length === 0) return { verdict: 'not-run', summary: 'No state machine in this model.', rows: [] };
      const picked = machines.find((m) => m.id === ctx.selectionId) ?? machines[0];
      const r = behaviourReport(ctx.model, { machineId: picked.id });
      if (r.properties.length === 0)
        return { verdict: 'not-run', summary: `${picked.declaredName ?? picked.id} states no property to check.`, rows: [] };
      const rows: CheckRow[] = r.properties.map((p) => ({
        code: p.code ?? 'verification/property',
        message: `${p.sentence ?? 'property'} — ${p.claim}`,
        elementId: picked.id,
        severity: p.claim === 'fail' ? 'error' : p.claim === 'pass' ? 'info' : 'warning',
      }));
      const failed = r.properties.filter((p) => p.claim === 'fail').length;
      const undecided = r.properties.filter((p) => p.claim !== 'pass' && p.claim !== 'fail').length;
      if (failed > 0) return { verdict: 'issues', summary: `${failed} of ${r.properties.length} properties refuted on ${picked.declaredName ?? picked.id}`, rows };
      if (undecided > 0) return { verdict: 'undecided', summary: `${undecided} property(ies) could not be decided`, rows };
      return holds(`${r.properties.length} property(ies) hold on ${picked.declaredName ?? picked.id}`, rows);
    },
  },
  {
    id: 'contracts',
    label: 'Contracts',
    question: 'What does each component assume, and what does it guarantee?',
    engine: 'model',
    views: ['contracts', 'requirement', 'general'],
    scopedBySelection: true,
    command: (ctx) => cli('contracts', ctx, scopeFlag(ctx)),
    run: (ctx) => {
      const scope = checkScope(ctx);
      const r = contractReport(ctx.model, scope.kind === 'element' ? { scopeId: scope.id } : {});
      const of = ofWhole(scope, ctx.model, r.contracts.length, () => contractReport(ctx.model).contracts.length);
      return holds(`${r.contracts.length}${of} contract(s) — ${scopeWords(scope)}`, [
        scopeRow(scope),
        ...r.contracts.slice(0, 50).map((c): CheckRow => ({ code: 'contracts/contract', message: `${c.subject?.name ?? c.id}: ${c.assumptions.length} assumption(s), ${c.guarantees.length} guarantee(s)`, elementId: c.id, severity: 'info' })),
      ]);
    },
  },
  {
    id: 'obligations',
    label: 'Obligations',
    question: 'What must be proved, and what is assumed without proof?',
    engine: 'model',
    views: ['contracts', 'requirement'],
    scopedBySelection: true,
    command: (ctx) => cli('obligations', ctx, scopeFlag(ctx)),
    run: (ctx) => {
      const scope = checkScope(ctx);
      const r = obligationsReport(ctx.model, scope.kind === 'element' ? { scopeId: scope.id } : {});
      const of = ofWhole(scope, ctx.model, r.total, () => obligationsReport(ctx.model).total);
      return holds(
        `${r.total}${of} obligation(s): ${r.byRole.axiom} axiom, ${r.byRole.premise} premise, ${r.byRole.obligation} to prove — ${scopeWords(scope)}`,
        [scopeRow(scope)],
      );
    },
  },
  // Solver-backed: z3 in a worker, which needs a cross-origin-isolated page.
  {
    id: 'verify',
    label: 'Verify a case',
    question: 'Does the model satisfy the requirements a verification case names?',
    engine: 'solver',
    views: ['requirement', 'requirements', 'case', 'contracts'],
    command: (ctx) => cli('verify', ctx, '--engine smt --record evidence.json'),
  },
  {
    id: 'consistency',
    label: 'Consistency',
    question: 'Can these requirements all hold at once?',
    engine: 'solver',
    views: ['requirement', 'requirements', 'contracts', 'parametric'],
    command: (ctx) => cli('consistency', ctx),
  },
  {
    id: 'bounds',
    label: 'Bounds of a measure',
    question: 'What is the worst case this design allows for a measure?',
    engine: 'solver',
    views: ['parametric', 'requirements', 'grid'],
    needsSelection: true,
    command: (ctx) => cli('bounds', ctx, `--measure ${selected(ctx)}`),
  },
  {
    id: 'refine',
    label: 'Refinement',
    question: 'Do the parts together deliver what the whole promises?',
    engine: 'solver',
    views: ['contracts', 'interconnection'],
    command: (ctx) => cli('refine', ctx),
  },
  {
    id: 'fault-tree',
    label: 'Fault tree',
    question: 'Which combinations of component failures break the top requirement?',
    engine: 'solver',
    views: ['contracts'],
    command: (ctx) => cli('fault-tree', ctx),
  },
];

/**
 * What a person needs to know beside `spec`'s command when a name had to be
 * left out of it (see {@link commandFileName}): the name to save the file as,
 * and the element `<qualified name>` stands for — or, with nothing selected,
 * that it stands for an element still to choose. Null when the command names
 * them as they are.
 */
export function commandNote(spec: CheckSpec, ctx: CheckContext): string | null {
  const notes: string[] = [];
  const file = commandFileName(ctx.fileName);
  if (file !== ctx.fileName) {
    notes.push(
      `Save the file as ${file} to run this: its name, ${ctx.fileName}, has characters a terminal could read as commands.`,
    );
  }
  if (spec.needsSelection === true && ctx.selectionId === null) {
    notes.push(
      `${QUALIFIED_NAME_PLACEHOLDER} stands for the element this check reads, and nothing is selected: select it, or type its qualified name in.`,
    );
  }
  const namesSelection = spec.needsSelection === true || (spec.scopedBySelection === true && checkScope(ctx).kind === 'element');
  if (namesSelection && ctx.selectionName && !plainQualifiedName(ctx.selectionName)) {
    notes.push(
      `${QUALIFIED_NAME_PLACEHOLDER} stands for ${ctx.selectionName}, which has characters a terminal could read as commands: type it in, quoted the way your terminal quotes.`,
    );
  }
  return notes.length > 0 ? notes.join(' ') : null;
}

/**
 * Whether there is a state machine for a {@link CheckSpec.offThread} check to
 * walk. A model with none is answered by the check itself — "No state machine in
 * this model" — in the few milliseconds this scan takes, so the palette answers
 * it on the spot and starts no worker (and loads no second library) to say so.
 */
export const hasStateMachine = (model: Model): boolean => stateMachinesIn(model).length > 0;

/** The checks a view offers, in registry order. */
export function checksFor(view: ViewKind): CheckSpec[] {
  return CHECKS.filter((c) => c.views.includes(view));
}

/** Why a solver check cannot run here — the sentence the palette shows instead of a verdict. */
export const NOT_ISOLATED =
  'z3 needs a cross-origin-isolated page, which this one is not. Copy the command and run it in a terminal.';

/**
 * Runs one check. A `model` check runs here; a `solver` check reports
 * `unavailable` with the reason rather than a verdict it has not earned — its
 * rows are the command, and what that command left out (`commandNote`). A
 * thrown error becomes an `issues` row carrying the message — never a pass.
 */
export function runCheck(spec: CheckSpec, ctx: CheckContext): CheckResult {
  if (spec.engine === 'solver' || !spec.run) {
    const note = commandNote(spec, ctx);
    const rows: CheckRow[] = [{ code: 'checks/not-here', message: spec.command(ctx), severity: 'info' }];
    if (note !== null) rows.push({ code: 'checks/command-note', message: note, severity: 'info' });
    return { verdict: 'unavailable', summary: NOT_ISOLATED, rows };
  }
  try {
    return spec.run(ctx);
  } catch (err) {
    return {
      verdict: 'issues',
      summary: 'The check itself failed — this is a defect, not a verdict on the model.',
      rows: [{ code: 'checks/internal-error', message: err instanceof Error ? err.message : String(err), severity: 'error' }],
    };
  }
}

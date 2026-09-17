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
 *    here, now, against exactly what is on screen.
 *  - `solver` — needs z3, which needs a cross-origin-isolated page. When the
 *    page is not isolated the entry does not pretend: it reports `unavailable`
 *    with the reason and the exact terminal command. A check that cannot run
 *    must never read as one that passed (the Agent Diagnostics Contract's rule
 *    for this project: no silent pass).
 *
 * Every row carries a stable `code`, like every other finding in this project,
 * so automation branches on the code and never on the prose.
 */

import type { Model } from '@core/index';
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

const cli = (sub: string, ctx: CheckContext, extra = ''): string =>
  `npm run sysprose -- ${sub} ${ctx.fileName}${extra ? ` ${extra}` : ''}`;

const element = (ctx: CheckContext): string => (ctx.selectionName ? `--element ${ctx.selectionName}` : '--element <qualified name>');

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
    command: (ctx) => cli('contracts', ctx),
    run: (ctx) => {
      const r = contractReport(ctx.model);
      return holds(
        `${r.contracts.length} contract(s)`,
        r.contracts.slice(0, 50).map((c) => ({ code: 'contracts/contract', message: `${c.subject?.name ?? c.id}: ${c.assumptions.length} assumption(s), ${c.guarantees.length} guarantee(s)`, elementId: c.id, severity: 'info' })),
      );
    },
  },
  {
    id: 'obligations',
    label: 'Obligations',
    question: 'What must be proved, and what is assumed without proof?',
    engine: 'model',
    views: ['contracts', 'requirement'],
    command: (ctx) => cli('obligations', ctx),
    run: (ctx) => {
      const r = obligationsReport(ctx.model);
      return holds(`${r.total} obligation(s): ${r.byRole.axiom} axiom, ${r.byRole.premise} premise, ${r.byRole.obligation} to prove`);
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
    command: (ctx) => cli('bounds', ctx, `--measure ${ctx.selectionName ?? '<qualified name>'}`),
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

/** The checks a view offers, in registry order. */
export function checksFor(view: ViewKind): CheckSpec[] {
  return CHECKS.filter((c) => c.views.includes(view));
}

/** Why a solver check cannot run here — the sentence the palette shows instead of a verdict. */
export const NOT_ISOLATED =
  'z3 needs a cross-origin-isolated page, which this one is not. Copy the command and run it in a terminal.';

/**
 * Runs one check. A `model` check runs here; a `solver` check reports
 * `unavailable` with the reason rather than a verdict it has not earned. A
 * thrown error becomes an `issues` row carrying the message — never a pass.
 */
export function runCheck(spec: CheckSpec, ctx: CheckContext): CheckResult {
  if (spec.engine === 'solver' || !spec.run) {
    return { verdict: 'unavailable', summary: NOT_ISOLATED, rows: [{ code: 'checks/not-here', message: spec.command(ctx), severity: 'info' }] };
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

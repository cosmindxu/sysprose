/**
 * Pure analysis functions over a {@link Model}.
 *
 * Every function returns plain, JSON-serialisable data (no class instances, no
 * model references) so results can be rendered in tables, exported as JSON/CSV,
 * or shipped over the REST facade unchanged. These power the analytics surface in
 * plan §6: element counts, model metrics, requirement-satisfaction coverage,
 * traceability matrices, where-used / impact analysis, and connectivity checks.
 */

import {
  REQUIREMENT_KINDS,
  type ElementId,
  type ElementRecord,
  type Model,
  isControlNode,
  isRelationship,
  isTypingSpecialization,
} from '@core/index';
import {
  checkConstraints,
  checkConstraintsNumeric,
  runActionFlow,
  runStateMachine,
  simulateStateMachine,
  isSimulatable,
  discoverTriggers as simTriggers,
  solve,
  evaluateMoEs,
  type ConstraintCheck,
  type MeasureResult,
  type SimStep,
  type SimTrace,
} from '../semantics/index';
import { dimEqual, dimToString } from '@semantics/units';
import { dimensionalFacets, evaluateQuantity } from '@semantics/units-eval';

/** A compact, serialisable reference to an element. */
export interface ElementRef {
  id: string;
  eClass: string;
  declaredName?: string;
  qualifiedName: string;
}

function ref(model: Model, el: ElementRecord): ElementRef {
  return {
    id: el.id,
    eClass: el.eClass,
    declaredName: el.declaredName,
    qualifiedName: model.qualifiedName(el.id),
  };
}

/* ───────────────────────────── Counts & metrics ─────────────────────────── */

/**
 * Implicit features (usage-scoped connector endpoints materialized by the
 * feature-chain resolver, `attrs.implicit === true`) — and the elements they own
 * (e.g. their `Redefinition` to the type-owned prototype) — are re-derived
 * internals, not user-authored model content. They are excluded from
 * user-facing counts and metrics so a text-authored IBD does not inflate the
 * element census.
 */
const isCountable = (model: Model, el: ElementRecord): boolean =>
  el.attrs.implicit !== true &&
  !(el.ownerId != null && model.get(el.ownerId)?.attrs.implicit === true);

/** Number of elements per metaclass, e.g. `{ PartUsage: 3, Package: 1 }`. */
export function countByMetaclass(model: Model): Record<string, number> {
  const out: Record<string, number> = {};
  for (const el of model.all()) {
    if (!isCountable(model, el)) continue;
    out[el.eClass] = (out[el.eClass] ?? 0) + 1;
  }
  return out;
}

/** Aggregate model metrics. */
export interface ModelMetrics {
  totalElements: number;
  nodeCount: number;
  relationshipCount: number;
  rootCount: number;
  /** Maximum containment nesting depth (a single root counts as depth 1). */
  maxDepth: number;
  /** Count of diagram-able (non-relationship) elements. */
  diagramableCount: number;
  byMetaclass: Record<string, number>;
}

export function modelMetrics(model: Model): ModelMetrics {
  const all = model.all().filter((el) => isCountable(model, el));
  let nodeCount = 0;
  let relationshipCount = 0;
  let maxDepth = 0;
  for (const el of all) {
    if (isRelationship(el.eClass)) relationshipCount++;
    else nodeCount++;
    const depth = model.ancestors(el.id).length + 1;
    if (depth > maxDepth) maxDepth = depth;
  }
  return {
    totalElements: all.length,
    nodeCount,
    relationshipCount,
    rootCount: model.roots().length,
    maxDepth,
    diagramableCount: nodeCount,
    byMetaclass: countByMetaclass(model),
  };
}

/* ─────────────────────── Requirement satisfaction ───────────────────────── */

const SATISFY_KINDS = new Set(['Satisfy', 'SatisfyRequirementUsage']);

/** One requirement's satisfaction status. */
export interface RequirementStatus {
  requirement: ElementRef;
  satisfiers: ElementRef[];
  satisfied: boolean;
}

/** Per-requirement satisfaction plus an overall coverage ratio. */
export interface SatisfactionReport {
  requirements: RequirementStatus[];
  total: number;
  satisfied: number;
  /** satisfied / total (0 when there are no requirements). */
  coverage: number;
}

/**
 * For each requirement, the elements that satisfy it (via `Satisfy` edges whose
 * `target` is the requirement and whose `source` is the satisfier), and whether
 * it is covered. Overall `coverage` = satisfied / total.
 */
export function requirementSatisfaction(model: Model): SatisfactionReport {
  const reqs = model.ofKind(...REQUIREMENT_KINDS);
  const requirements: RequirementStatus[] = reqs.map((r) => {
    const satisfierIds = model
      .edgesTo(r.id)
      .filter((e) => SATISFY_KINDS.has(e.eClass))
      .flatMap((e) => e.source ?? []);
    const seen = new Set<string>();
    const satisfiers: ElementRef[] = [];
    for (const sid of satisfierIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const el = model.get(sid);
      if (el) satisfiers.push(ref(model, el));
    }
    return { requirement: ref(model, r), satisfiers, satisfied: satisfiers.length > 0 };
  });
  const satisfied = requirements.filter((r) => r.satisfied).length;
  return {
    requirements,
    total: requirements.length,
    satisfied,
    coverage: requirements.length === 0 ? 0 : satisfied / requirements.length,
  };
}

/* ───────────────────────── Traceability matrix ──────────────────────────── */

/** A 2D traceability matrix between two element kinds over one relationship kind. */
export interface TraceabilityMatrix {
  fromKind: string;
  toKind: string;
  relKind: string;
  rows: ElementRef[];
  columns: ElementRef[];
  /** `cells[i][j]` = true iff a `relKind` edge links rows[i] → columns[j]. */
  cells: boolean[][];
  /** Flattened list of the existing links. */
  links: Array<{ from: string; to: string; relationshipId: string }>;
}

/**
 * Build a from×to traceability matrix: rows are elements of `fromKind`, columns
 * are elements of `toKind`, and a cell is set when a `relKind` edge runs from the
 * row element (source) to the column element (target).
 */
export function traceabilityMatrix(
  model: Model,
  fromKind: string,
  toKind: string,
  relKind: string,
): TraceabilityMatrix {
  const rows = model.ofKind(fromKind);
  const columns = model.ofKind(toKind);
  const edges = model.all().filter((e) => e.eClass === relKind);
  const links: TraceabilityMatrix['links'] = [];
  const cells = rows.map((r) =>
    columns.map((c) => {
      const edge = edges.find(
        (e) => (e.source ?? []).includes(r.id) && (e.target ?? []).includes(c.id),
      );
      if (edge) {
        links.push({ from: r.id, to: c.id, relationshipId: edge.id });
        return true;
      }
      return false;
    }),
  );
  return {
    fromKind,
    toKind,
    relKind,
    rows: rows.map((r) => ref(model, r)),
    columns: columns.map((c) => ref(model, c)),
    cells,
    links,
  };
}

/* ─────────────────────────────── Where-used ─────────────────────────────── */

/** A single reference to the queried element. */
export interface UsageRef {
  /** The relationship/edge metaclass doing the referencing. */
  via: string;
  relationshipId: string;
  /** Whether the queried id sits on the `source` or `target` end of the edge. */
  role: 'source' | 'target';
  /** The element(s) at the opposite end(s) of the edge. */
  relatedElements: ElementRef[];
  /** True when `via` is a specialization-family relationship (typing/generalization). */
  isTyping: boolean;
}

/** Impact / where-used report for one element. */
export interface WhereUsedReport {
  element: ElementRef;
  references: UsageRef[];
  /** Distinct elements that reference the queried element (deduplicated). */
  usedBy: ElementRef[];
}

/**
 * Find everything that references `id` via typing or any relationship/edge — the
 * basis of impact analysis. For each edge touching `id`, reports the edge kind,
 * the role `id` plays, and the elements at the far end.
 */
export function whereUsed(model: Model, id: string): WhereUsedReport {
  const el = model.get(id);
  const element: ElementRef = el
    ? ref(model, el)
    : { id, eClass: '«unknown»', qualifiedName: '' };
  const references: UsageRef[] = [];
  const usedByMap = new Map<string, ElementRef>();

  for (const e of model.edgesOf(id)) {
    if (e.id === id) continue;
    const onSource = (e.source ?? []).includes(id);
    const role: 'source' | 'target' = onSource ? 'source' : 'target';
    const otherIds = (onSource ? e.target : e.source) ?? [];
    const relatedElements: ElementRef[] = [];
    for (const oid of otherIds) {
      if (oid === id) continue;
      const oe = model.get(oid);
      if (oe) {
        const r = ref(model, oe);
        relatedElements.push(r);
        usedByMap.set(oid, r);
      }
    }
    references.push({
      via: e.eClass,
      relationshipId: e.id,
      role,
      relatedElements,
      isTyping: isTypingSpecialization(e.eClass),
    });
  }
  return { element, references, usedBy: [...usedByMap.values()] };
}

/* ───────────────────────── Connectivity report ──────────────────────────── */

const CONNECTION_KINDS = new Set([
  'ConnectionUsage',
  'InterfaceUsage',
  'Connector',
  'BindingConnectorAsUsage',
  'Flow',
  'FlowUsage',
  'SuccessionFlow',
  'Allocation',
]);

/** Ports, connections, and which ports are left unconnected. */
export interface ConnectivityReport {
  portCount: number;
  connectionCount: number;
  connectedPortCount: number;
  unconnectedPorts: ElementRef[];
  connections: Array<{
    connection: ElementRef;
    source: string[];
    target: string[];
  }>;
}

/**
 * Inventory of ports (PortUsage) and connection-like edges, flagging ports not
 * referenced by any connection endpoint as unconnected.
 */
export function connectivityReport(model: Model): ConnectivityReport {
  const ports = model.ofKind('PortUsage');
  const connections = model
    .all()
    .filter(
      (e) => CONNECTION_KINDS.has(e.eClass) && ((e.source?.length ?? 0) + (e.target?.length ?? 0) > 0),
    );

  const connectedPortIds = new Set<string>();
  for (const c of connections) {
    for (const s of c.source ?? []) connectedPortIds.add(s);
    for (const t of c.target ?? []) connectedPortIds.add(t);
  }
  const unconnectedPorts = ports
    .filter((p) => !connectedPortIds.has(p.id))
    .map((p) => ref(model, p));

  return {
    portCount: ports.length,
    connectionCount: connections.length,
    connectedPortCount: ports.filter((p) => connectedPortIds.has(p.id)).length,
    unconnectedPorts,
    connections: connections.map((c) => ({
      connection: ref(model, c),
      source: [...(c.source ?? [])],
      target: [...(c.target ?? [])],
    })),
  };
}

/* ───────────────────────── Constraint report ────────────────────────────── */

/** One evaluated constraint/requirement, plus a navigable element reference. */
export interface ConstraintReportEntry extends ConstraintCheck {
  element: ElementRef;
}

/** Summary of constraint/requirement satisfaction across the model. */
export interface ConstraintReport {
  total: number;
  satisfied: number;
  violated: number;
  unknown: number;
  constraints: ConstraintReportEntry[];
}

/**
 * Evaluate every ConstraintUsage / RequirementUsage carrying a boolean
 * expression (via the semantics engine) and summarise the satisfied / violated
 * / unknown counts, alongside per-constraint detail with a navigable element
 * reference. JSON-serialisable for the REST facade and UI.
 */
export function constraintReport(model: Model): ConstraintReport {
  const checks = checkConstraints(model).filter((c) => model.get(c.id)?.attrs.isLibrary !== true);
  let satisfied = 0;
  let violated = 0;
  let unknown = 0;
  const constraints: ConstraintReportEntry[] = [];
  for (const c of checks) {
    if (c.result === 'satisfied') satisfied++;
    else if (c.result === 'violated') violated++;
    else unknown++;
    const el = model.get(c.id);
    constraints.push({
      ...c,
      element: el
        ? ref(model, el)
        : { id: c.id, eClass: '«unknown»', qualifiedName: '' },
    });
  }
  return { total: checks.length, satisfied, violated, unknown, constraints };
}

/* ─────────────────────────── Dimensional analysis ───────────────────────── */

/** Dimensional analysis of one quantity-valued feature. */
export interface UnitFeatureAnalysis {
  element: ElementRef;
  /** Numeric magnitude, or `null` when the feature has no evaluable value. */
  value: number | null;
  /** The unit the magnitude is expressed in, or `null` when none is set. */
  unit: string | null;
  /** Human-readable physical dimension (e.g. `M`, `L·T⁻¹`), or `null`. */
  dimension: string | null;
  /** The ISQ quantity kind the feature is typed by, or `null`. */
  quantityKind: string | null;
  /** False when the value's unit dimension conflicts with the quantity kind's. */
  consistent: boolean;
}

/** Model-wide dimensional-analysis report over quantity-valued features. */
export interface UnitReport {
  features: UnitFeatureAnalysis[];
  total: number;
  consistent: number;
  inconsistent: number;
}

/**
 * Analyse every quantity-valued feature (one carrying a unit and/or typed by an
 * ISQ quantity kind): its magnitude, unit, physical dimension, quantity kind,
 * and whether the value's unit dimension is consistent with the quantity kind.
 * Library content is excluded. JSON-serialisable for the REST facade and UI.
 */
export function unitReport(model: Model): UnitReport {
  const features: UnitFeatureAnalysis[] = [];
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    const facets = dimensionalFacets(model, el.id);
    // Only quantity-valued features: those carrying a unit or an ISQ kind.
    if (!facets.unit && !facets.kindDimension) continue;
    const q = evaluateQuantity(model, el.id);
    const consistent =
      !facets.unitDimension || !facets.kindDimension
        ? true
        : dimEqual(facets.unitDimension, facets.kindDimension);
    const dimension = q
      ? dimToString(q.dimension)
      : facets.kindDimension
        ? dimToString(facets.kindDimension)
        : null;
    features.push({
      element: ref(model, el),
      value: q ? q.magnitude : null,
      unit: facets.unit ?? null,
      dimension,
      quantityKind: facets.kindName ?? null,
      consistent,
    });
  }
  const inconsistent = features.filter((f) => !f.consistent).length;
  return {
    features,
    total: features.length,
    consistent: features.length - inconsistent,
    inconsistent,
  };
}

/* ───────────────────────────── Analysis report ──────────────────────────── */

/** One solved feature value, with a navigable element reference. */
export interface SolvedValue {
  element: ElementRef;
  value: number;
}

/**
 * Numeric-analysis report over the whole model: the solved parametric values,
 * the evaluated measures of effectiveness, and the solver's convergence. Plain
 * and JSON-serialisable for the REST facade and UI (`GET /analytics/analysis`
 * and the parametric "Solve" affordance).
 */
/** A numerically-violated equality/inequality constraint, with a navigable ref. */
export interface AnalysisViolation {
  element: ElementRef;
  /** Whether the violated relation is an equality or an inequality. */
  kind: 'equality' | 'inequality';
  /** The source text of the relation. */
  expression: string;
  /** The amount by which the constraint is violated. */
  amount: number;
}

export interface AnalysisReport {
  converged: boolean;
  iterations: number;
  residual: number;
  /** Solved numeric feature values (library content excluded). */
  values: SolvedValue[];
  /** Evaluated measures of effectiveness. */
  measures: MeasureResult[];
  /** True when every inequality constraint holds at the solved values. */
  feasible: boolean;
  /** The numerically-violated equality/inequality constraints. */
  violations: AnalysisViolation[];
}

/**
 * Solve the model's numeric constraint system, read off its measures of
 * effectiveness, and summarise convergence. Library content is excluded from
 * the reported values. JSON-serialisable for the REST facade and UI.
 */
export function analysisReport(model: Model): AnalysisReport {
  const solved = solve(model);
  const values: SolvedValue[] = [];
  for (const [id, value] of solved.values) {
    const el = model.get(id);
    if (!el || el.attrs.isLibrary === true) continue;
    values.push({ element: ref(model, el), value });
  }

  // Numeric feasibility: violated equalities/inequalities at the solved values.
  const numeric = checkConstraintsNumeric(model);
  const violations: AnalysisViolation[] = [];
  for (const c of numeric) {
    if (c.result !== 'violated') continue;
    const el = model.get(c.id);
    violations.push({
      element: el ? ref(model, el) : { id: c.id, eClass: '«unknown»', qualifiedName: '' },
      kind: c.kind,
      expression: c.raw,
      amount: c.amount,
    });
  }
  const feasible = !numeric.some((c) => c.kind === 'inequality' && c.result === 'violated');

  return {
    converged: solved.converged,
    iterations: solved.iterations,
    residual: solved.residual,
    values,
    measures: evaluateMoEs(model),
    feasible,
    violations,
  };
}

/* ───────────────────────────── Execution report ─────────────────────────── */

/** Metaclasses of the succession (control-flow) edges of an action body. */
const SUCCESSION_KINDS = new Set(['Succession', 'SuccessionFlow']);

/** A compact, serialisable step of a simulated action flow. */
export interface ExecutionStepSummary {
  id: string;
  name: string;
  kind: string;
  /** Guard of the succession fired to reach this node, when any. */
  guard?: string;
  /** Fork id when the node lies on a parallel branch. */
  parallelGroup?: string;
  /** Sub-behavior lifecycle marker for a composite/call action. */
  event?: 'enter' | 'exit';
  /** Composite/call recursion depth (0 at the top-level flow). */
  depth?: number;
  /** Effect note (assignment / accept / send / loop). */
  note?: string;
  /** Result-parameter values produced by an invoked sub-behavior (on `exit`). */
  produced?: Record<string, unknown>;
}

/** A runnable action flow plus a short trace summary from {@link runActionFlow}. */
export interface ActionFlowRun {
  action: ElementRef;
  nodeCount: number;
  successionCount: number;
  steps: ExecutionStepSummary[];
  edgesFired: number;
  complete: boolean;
  /**
   * The value store after execution (feature name → evaluated value), as a plain
   * JSON-serialisable object. Populated from assignments, loop variables and
   * literal seeds by {@link runActionFlow}.
   */
  valueStore: Record<string, unknown>;
  /** Total loop iterations executed across every While/For loop in the flow. */
  iterations: number;
  /**
   * Maximum composite/call recursion depth reached (0 when the flow has no
   * nested/invoked sub-behaviors).
   */
  depth: number;
}

/** A behavior (entry/do/exit action) performed during a state-machine run. */
export interface PerformedActionSummary {
  stateId: string;
  phase: 'entry' | 'do' | 'exit';
  actionId: string;
  name: string;
}

/** A runnable state machine plus a short trace summary from {@link runStateMachine}. */
export interface StateMachineRun {
  stateMachine: ElementRef;
  stateCount: number;
  transitionCount: number;
  /** Distinct trigger alphabet discovered on the machine's transitions, in order. */
  triggers: string[];
  /** State ids visited when driven with the discovered `triggers`. */
  visited: string[];
  finalState: string | null;
  firedCount: number;
  /** Entry/do/exit behaviors performed while running the machine, in order. */
  performed: PerformedActionSummary[];
  /** The value store after the run (feature name → value), JSON-serialisable. */
  valueStore: Record<string, unknown>;
  /** Active leaf states (one per concurrent region) after the run. */
  activeStates: string[];
  /** Discrete clock after a timed run (0 for untimed machines). */
  clock: number;
  /** Whether every region reached a final/complete state (and any join fired). */
  complete: boolean;
}

/** Runnable behaviors in the model, each with a short simulated trace. */
export interface ExecutionReport {
  actionFlows: ActionFlowRun[];
  stateMachines: StateMachineRun[];
}

/** Is `el` a node that participates in an action's control/object flow? */
function isFlowNode(el: ElementRecord): boolean {
  return isControlNode(el.eClass) || el.eClass === 'ActionUsage' || el.eClass.endsWith('ActionUsage');
}

/**
 * Enumerate the model's runnable behaviors and simulate each with the semantics
 * engine, returning a plain, JSON-serialisable summary (plan §6 execution
 * surface, powering the REST `GET /analytics/execution` route and the UI
 * "Simulate" affordance):
 *
 *  - **Action flows** — every non-library element that directly owns a
 *    Succession/SuccessionFlow edge is an action body; simulated with
 *    {@link runActionFlow} (topological token walk with fork/join + decision
 *    handling).
 *  - **State machines** — every non-library element that directly owns a
 *    TransitionUsage is a state machine; driven with {@link runStateMachine}
 *    against the distinct trigger alphabet discovered on its transitions (in
 *    declaration order), a deterministic "exercise every trigger" run.
 *
 * The two sets are disjoint in practice (action bodies use successions, state
 * machines use transitions). Library content is excluded.
 */
export function executionReport(model: Model): ExecutionReport {
  const actionFlows: ActionFlowRun[] = [];
  const stateMachines: StateMachineRun[] = [];

  for (const el of model.all()) {
    if (isRelationship(el.eClass) || el.attrs.isLibrary === true) continue;
    const children = model.children(el.id);

    // Action flow: directly owns ≥1 succession edge.
    if (children.some((c) => SUCCESSION_KINDS.has(c.eClass))) {
      const desc = model.descendants(el.id);
      const trace = runActionFlow(model, el.id);
      actionFlows.push({
        action: ref(model, el),
        nodeCount: desc.filter(isFlowNode).length,
        successionCount: desc.filter((d) => SUCCESSION_KINDS.has(d.eClass)).length,
        steps: trace.steps.map((s) => {
          const step: ExecutionStepSummary = { id: s.id, name: s.name, kind: s.kind };
          if (s.guard !== undefined) step.guard = s.guard;
          if (s.parallelGroup !== undefined) step.parallelGroup = s.parallelGroup;
          if (s.event !== undefined) step.event = s.event;
          if (s.depth !== undefined) step.depth = s.depth;
          if (s.note !== undefined) step.note = s.note;
          if (s.produced !== undefined) step.produced = s.produced;
          return step;
        }),
        edgesFired: trace.edgesFired.length,
        complete: trace.complete,
        valueStore: Object.fromEntries(trace.valueStore),
        iterations: trace.iterations,
        depth: trace.depth,
      });
    }

    // State machine: directly owns ≥1 transition.
    const transitions = children.filter((c) => c.eClass === 'TransitionUsage');
    if (transitions.length > 0) {
      const triggers = discoverTriggers(transitions);
      const result = runStateMachine(model, el.id, triggers);
      stateMachines.push({
        stateMachine: ref(model, el),
        stateCount: model.descendants(el.id).filter((d) => d.eClass === 'StateUsage').length,
        transitionCount: transitions.length,
        triggers,
        visited: result.visited,
        finalState: result.finalState,
        firedCount: result.fired.length,
        performed: result.performed.map((p) => ({
          stateId: p.stateId,
          phase: p.phase,
          actionId: p.actionId,
          name: p.name,
        })),
        valueStore: Object.fromEntries(result.valueStore),
        activeStates: result.activeStates,
        clock: result.clock ?? 0,
        complete: result.complete ?? result.finalState !== null,
      });
    }
  }

  return { actionFlows, stateMachines };
}

/** A time-stepped simulation of one state machine (JSON-serialisable). */
export interface SimulationReport {
  /** Whether a state machine was found and simulated. */
  ran: boolean;
  /** The simulated behavior + its time-series (present iff `ran`). */
  trace?: SimTrace;
  message: string;
}

/**
 * Run a default TIME-STEPPED simulation of one state machine and return its
 * serialisable time-series (powers a "Simulate over time" affordance + the REST
 * `GET /analytics/simulation` route). Target selection mirrors
 * {@link executionReport}: `behaviorId` if given, else the first non-library
 * element that directly owns a TransitionUsage. The auto-script exercises every
 * injectable trigger once (declaration order), then advances the clock past the
 * longest `after(n)` dwell so timed transitions fire. For interactive driving,
 * use the SDK `simulationSession`/`simulate` instead.
 */
export function simulationReport(model: Model, behaviorId?: ElementId): SimulationReport {
  let targetId = behaviorId;
  if (targetId === undefined) {
    // Same criterion as the SDK's isSimulatable (a transition ANYWHERE in the
    // subtree, so orthogonal machines with transitions inside regions qualify),
    // and prefer the OUTERMOST such machine (skip one nested in another).
    for (const el of model.all()) {
      if (isRelationship(el.eClass) || el.attrs.isLibrary === true) continue;
      if (!isSimulatable(model, el.id)) continue;
      if (model.ancestors(el.id).some((a) => isSimulatable(model, a.id))) continue;
      targetId = el.id;
      break;
    }
  }
  if (targetId === undefined || model.get(targetId) === undefined) {
    return { ran: false, message: 'No state machine to simulate.' };
  }

  // Use the SAME trigger discovery the trace reports, so the auto-script and the
  // returned `trace.triggers` cannot disagree.
  const triggers = simTriggers(model, targetId);
  const transitions = model.descendants(targetId).filter((d) => d.eClass === 'TransitionUsage');
  const hasTimed = transitions.some((t) => afterDwell(t) > 0 || /^\s*after\s*\(/.test(String(t.attrs.trigger ?? '')));
  const maxAfter = transitions.reduce((mx, t) => Math.max(mx, afterDwell(t)), 0);

  const script: SimStep[] = triggers.map((event) => ({ event }));
  if (hasTimed) script.push({ advance: Math.max(maxAfter, 1) });

  const trace = simulateStateMachine(model, targetId, script);
  return {
    ran: true,
    trace,
    message: `Simulated "${trace.behaviorName || targetId}" over ${trace.samples.length} samples.`,
  };
}

/** The dwell of an `after(n)` timed transition (`attrs.after` or `after(n)` trigger), else 0. */
function afterDwell(tr: ElementRecord): number {
  const a = tr.attrs.after;
  if (typeof a === 'number') return a;
  const t = tr.attrs.trigger;
  if (typeof t === 'string') {
    const m = /^\s*after\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)\s*$/.exec(t);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Distinct, non-empty transition triggers in declaration order. */
function discoverTriggers(transitions: ElementRecord[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of transitions) {
    const trig = t.attrs.trigger;
    if (typeof trig !== 'string' || trig.trim() === '') continue;
    if (seen.has(trig)) continue;
    seen.add(trig);
    out.push(trig);
  }
  return out;
}

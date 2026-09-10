/**
 * Behavioral / execution semantics over a {@link Model}, as pure functions.
 *
 * Implements the dynamic (token-flow) reading of the OMG KerML/SysML v2 behavior
 * kernel (see docs/02-omg-standard-reference.md — Behavior/Step/Succession,
 * control nodes, TransitionUsage) on top of the static semantics engine
 * (inheritance, the expression evaluator, and model-value evaluation):
 *
 *  - {@link runActionFlow} — simulate an action's control/object flow: order the
 *    contained ActionUsages and control nodes by their Succession edges
 *    (topological, cycle-safe), split at ForkNodes, synchronise at JoinNodes,
 *    pick the true-guard branch at DecisionNodes, and stop at a DoneNode.
 *  - {@link runStateMachine} — drive a state's TransitionUsages against a trigger
 *    sequence, firing the first enabled transition (trigger match + guard true)
 *    per trigger.
 *  - {@link propagateBindings} — force feature-value equality across
 *    BindingConnector / `bind` / equality connectors and propagate known literal
 *    values to a fixpoint over each equality component.
 *  - {@link evaluateModel} — evaluate feature values/expressions (including
 *    derived/dependent features and bound values) across the whole model and
 *    return a value map plus constraint results.
 *
 * Every function is deterministic, bounded, cycle-safe, and never mutates the
 * model. This is an ORIGINAL implementation of the standard's algorithms.
 */

import {
  type ElementId,
  type ElementRecord,
  type Model,
  isControlNode,
  isUsage,
} from '@core/index';
import { effectiveFeatures } from './inheritance';
import { parseExpr, evaluate } from './expr';
import { scopeFor, checkConstraints, type Scope, type ConstraintCheck } from './evaluate-model';
import { isBindingEdge, propagateValues } from './connectors';
// The step relation and the primitives it is built from. They were lifted out
// of this file so a checker can ask what is enabled without firing it (plan
// §3.8); the interpreter imports them back and takes the FIRST enabled
// transition, which is the tie-break it always had.
import {
  SUCCESSION_KINDS,
  advanceClock,
  afterDuration,
  applyAssignment,
  applyTransitionEffect,
  combinedScope,
  directStates,
  enabledTransitions,
  evalStr,
  guardHoldsStore,
  initialConfig,
  initialState,
  inlineAssign,
  isCompletion,
  isFinalState,
  isHistoryComposite,
  isHistoryPseudostate,
  isTruthy,
  leafOf,
  literalValueOf,
  regionTransitions,
  runStatePhase,
  seedStore,
  stepConfig,
  strAttr,
  triggerEquals,
  triggerLabelOf,
  type EnabledTransition,
  type MachineConfig,
  type StepEffects,
  type StepInput,
} from './mc/config';

/* ───────────────────────────── action flow ───────────────────────────── */

/** One visited node in an {@link ExecutionTrace}. */
export interface ExecutionStep {
  /** Element id of the action / control node. */
  id: ElementId;
  /** Declared name (empty string for anonymous nodes). */
  name: string;
  /** Metaclass name, e.g. 'ActionUsage', 'ForkNode', 'DecisionNode'. */
  kind: string;
  /**
   * Identifier of the parallel group this node belongs to (the id of the
   * ForkNode that spawned its branch), when the node lies on a fork/join
   * parallel region. Absent for purely sequential nodes.
   */
  parallelGroup?: string;
  /** Guard expression of the Succession that was fired to reach this node. */
  guard?: string;
  /**
   * Human-readable note about the effect this node had on the value store,
   * e.g. `i = 3`, `accept temperature`, `send cmd`, `loop ×5`. Absent for nodes
   * with no store effect.
   */
  note?: string;
  /**
   * Sub-behavior lifecycle marker for a COMPOSITE / CALL action: `enter` is
   * pushed just before a nested/invoked action's sub-flow executes and `exit`
   * just after. Absent for ordinary nodes. See {@link runActionFlow}.
   */
  event?: 'enter' | 'exit';
  /**
   * Nesting depth of the step: 0 for the top-level flow, +1 for each level of
   * composite/call recursion. Absent (treated as 0) for top-level steps.
   */
  depth?: number;
  /** The invoked/nested behavior id, on `enter`/`exit` marker steps. */
  subBehaviorId?: ElementId;
  /**
   * Result-parameter values produced by an invoked sub-behavior (parameter
   * name → value), attached to its `exit` marker step. See {@link runActionFlow}.
   */
  produced?: Record<string, unknown>;
}

/** Result of simulating an action's control flow. */
export interface ExecutionTrace {
  /** Visited nodes in execution (topological) order. */
  steps: ExecutionStep[];
  /** Ids of the Succession edges that fired, in the order they fired. */
  edgesFired: ElementId[];
  /** True when the flow reached a DoneNode (or ran to completion if none). */
  complete: boolean;
  /**
   * The evolving VALUE STORE after execution: feature name → current value.
   * Seeded from literal feature values, updated by AssignmentActionUsages, loop
   * variables and loop bodies.
   */
  valueStore: Map<string, unknown>;
  /**
   * The value store keyed by FEATURE ID (rather than name) — the object/item
   * store used for pin-directional data passing along Flow/ItemFlow/
   * SuccessionFlow edges. Populated additively alongside {@link valueStore};
   * pin (input/output feature) values delivered by item flows appear here.
   */
  valueById: Map<ElementId, unknown>;
  /** Total loop iterations executed across every While/For loop node. */
  iterations: number;
  /**
   * Maximum composite/call recursion depth reached during the walk (0 when the
   * flow contains no nested/invoked sub-behaviors).
   */
  depth: number;
}

/** Options for {@link runActionFlow}. */
export interface RunActionOptions {
  /**
   * Total step budget bounding the walk (and each loop). Guards against runaway
   * cyclic flows / non-terminating loops. Defaults to 10000.
   */
  maxSteps?: number;
  /** Initial value-store bindings (feature name → value), applied last. */
  store?: Map<string, unknown> | Record<string, unknown>;
  /**
   * Maximum composite/call recursion depth for nested/invoked sub-behaviors.
   * Bounds runaway recursion (and, with the cycle-safe visited set, mutual
   * recursion). Defaults to 32.
   */
  maxDepth?: number;
}

/** Is `el` a node that participates in an action's control/object flow? */
function isFlowNode(el: ElementRecord): boolean {
  return isControlNode(el.eClass) || el.eClass === 'ActionUsage' || el.eClass.endsWith('ActionUsage');
}

/**
 * Simulate the control flow of the action `actionId`: its contained
 * ActionUsages and control nodes ordered by Succession edges (topological
 * sort), with ForkNode parallel-branch tagging, JoinNode synchronisation, and
 * DecisionNode guard selection via the expression evaluator.
 *
 * Cycle-safe (a Succession cycle degrades to a stable leftover order) and
 * deterministic (ties broken by declaration order).
 */
export function runActionFlow(
  model: Model,
  actionId: ElementId,
  opts: RunActionOptions = {},
): ExecutionTrace {
  const action = model.get(actionId);
  const valueStore = new Map<string, unknown>();
  const valueById = new Map<ElementId, unknown>();
  if (!action) {
    return { steps: [], edgesFired: [], complete: false, valueStore, valueById, iterations: 0, depth: 0 };
  }

  const budget = Math.max(1, opts.maxSteps ?? 10000);
  const maxDepth = Math.max(0, opts.maxDepth ?? 32);

  // Seed the value store from literal feature values, then caller overrides.
  seedStore(model, action, valueStore, opts.store);
  seedStoreById(model, action, valueStore, valueById);

  const ctx: WalkContext = {
    model,
    valueStore,
    valueById,
    budget,
    maxDepth,
    stepCount: 0,
    iterations: 0,
    maxReachedDepth: 0,
    visited: new Set<ElementId>(),
  };

  const res = walkActionFlow(ctx, actionId, 0);
  return {
    steps: res.steps,
    edgesFired: res.edgesFired,
    complete: res.complete,
    valueStore,
    valueById,
    iterations: ctx.iterations,
    depth: ctx.maxReachedDepth,
  };
}

/** Shared mutable state threaded through a (possibly recursive) flow walk. */
interface WalkContext {
  model: Model;
  valueStore: Map<string, unknown>;
  valueById: Map<ElementId, unknown>;
  budget: number;
  maxDepth: number;
  stepCount: number;
  iterations: number;
  maxReachedDepth: number;
  /** Behavior ids currently on the composite/call recursion stack (cycle-safe). */
  visited: Set<ElementId>;
}

/** Result of walking one (sub-)flow. */
interface WalkResult {
  steps: ExecutionStep[];
  edgesFired: ElementId[];
  complete: boolean;
}

/**
 * Core token walk over the flow rooted at `actionId`, sharing the value store
 * and step/iteration budget in `ctx`. Recurses into COMPOSITE (nested sub-flow)
 * and CALL (PerformActionUsage / typed-ActionUsage) actions up to
 * `ctx.maxDepth`, recording enter/exit markers, and passes item-flow data
 * between pins. Used by {@link runActionFlow} at depth 0.
 */
function walkActionFlow(ctx: WalkContext, actionId: ElementId, depth: number): WalkResult {
  const { model, valueStore, valueById } = ctx;
  const action = model.get(actionId)!;
  if (depth > ctx.maxReachedDepth) ctx.maxReachedDepth = depth;

  // 1. Flow nodes (declaration order), EXCLUDING nodes nested inside a loop or
  //    inside a COMPOSITE sub-action (those execute internally on recursion).
  const allFlow = model.descendants(actionId).filter(isFlowNode);
  const loopNodes = allFlow.filter(isLoopNode);
  const compositeNodes = allFlow.filter((n) => n.id !== actionId && ownsSubFlow(model, n));
  const inside = new Set<ElementId>();
  for (const loop of loopNodes) for (const d of model.descendants(loop.id)) inside.add(d.id);
  for (const comp of compositeNodes) for (const d of model.descendants(comp.id)) inside.add(d.id);
  const nodeList = allFlow.filter((n) => !inside.has(n.id));
  const nodeIds = new Set(nodeList.map((n) => n.id));
  const declIndex = new Map<ElementId, number>();
  nodeList.forEach((n, i) => declIndex.set(n.id, i));

  // 2. Succession edges connecting those (top-level) nodes.
  const successions = model
    .descendants(actionId)
    .filter((e) => SUCCESSION_KINDS.has(e.eClass))
    .filter((e) => {
      const s = e.source?.[0];
      const t = e.target?.[0];
      return s !== undefined && t !== undefined && nodeIds.has(s) && nodeIds.has(t);
    });

  const outgoing = new Map<ElementId, ElementRecord[]>();
  const indeg = new Map<ElementId, number>();
  for (const id of nodeIds) {
    outgoing.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of successions) {
    const s = e.source![0];
    const t = e.target![0];
    outgoing.get(s)!.push(e);
    indeg.set(t, (indeg.get(t) ?? 0) + 1);
  }
  for (const list of outgoing.values()) {
    list.sort((a, b) => {
      const da = declIndex.get(a.target![0]) ?? 0;
      const db = declIndex.get(b.target![0]) ?? 0;
      return da - db || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }

  // 3. Parallel-group tagging (fork → branches up to the syncing join).
  const groupOf = computeParallelGroups(model, nodeList, outgoing, declIndex);

  // 4. Item/object flows internal to this action (pin-directional data passing).
  const flows = itemFlowsWithin(model, actionId, nodeIds);
  propagateFlows(model, flows, valueStore, valueById);

  // 5. Token walk.
  const scope = combinedScope(model, action);
  const arrived = new Map<ElementId, number>();
  const guardOf = new Map<ElementId, string>();
  const steps: ExecutionStep[] = [];
  const edgesFired: ElementId[] = [];
  let doneReached = false;

  const byDecl = (a: ElementId, b: ElementId): number =>
    (declIndex.get(a) ?? 0) - (declIndex.get(b) ?? 0);

  const active: ElementId[] = [];
  const initials = nodeList.filter((n) => n.eClass === 'InitialNode');
  if (initials.length) for (const n of initials) active.push(n.id);
  else for (const id of nodeIds) if ((indeg.get(id) ?? 0) === 0) active.push(id);

  while (active.length && ctx.stepCount < ctx.budget) {
    active.sort(byDecl);
    const id = active.shift()!;
    const el = model.get(id)!;
    ctx.stepCount++;

    const step: ExecutionStep = { id, name: el.declaredName ?? '', kind: el.eClass };
    if (depth > 0) step.depth = depth;
    const grp = groupOf.get(id);
    if (grp !== undefined) step.parallelGroup = grp;
    const g = guardOf.get(id);
    if (g !== undefined) step.guard = g;

    // Node effect against the value store (assignment / accept / send / loop).
    const eff = executeNode(model, el, valueStore, scope, ctx.budget - ctx.stepCount);
    ctx.iterations += eff.iterations;
    if (eff.note !== undefined) step.note = eff.note;
    steps.push(step);

    // COMPOSITE / CALL action: recurse into the sub-behavior (depth-bounded,
    // cycle-safe), wrapping its steps in enter/exit markers.
    const subId = subBehaviorOf(model, el);
    if (subId !== undefined && depth < ctx.maxDepth && !ctx.visited.has(subId)) {
      const subEl = model.get(subId)!;
      const enter: ExecutionStep = {
        id,
        name: el.declaredName ?? subEl.declaredName ?? '',
        kind: subEl.eClass,
        event: 'enter',
        depth: depth + 1,
        subBehaviorId: subId,
      };
      steps.push(enter);
      ctx.visited.add(subId);
      seedStoreById(model, subEl, valueStore, valueById);
      const sub = walkActionFlow(ctx, subId, depth + 1);
      ctx.visited.delete(subId);
      steps.push(...sub.steps);
      const produced = resultParamValues(model, subId, valueStore, valueById);
      const exit: ExecutionStep = {
        id,
        name: el.declaredName ?? subEl.declaredName ?? '',
        kind: subEl.eClass,
        event: 'exit',
        depth: depth + 1,
        subBehaviorId: subId,
      };
      if (Object.keys(produced).length > 0) exit.produced = produced;
      steps.push(exit);
    }

    // Deliver this node's freshly-produced pin values downstream.
    propagateFlows(model, flows, valueStore, valueById);

    if (el.eClass === 'DoneNode') {
      doneReached = true;
      active.length = 0; // terminate this (sub-)flow at a DoneNode
      break;
    }

    // Determine which outgoing edges fire.
    const outs = outgoing.get(id) ?? [];
    let firing: ElementRecord[];
    if (el.eClass === 'DecisionNode' || el.eClass === 'IfActionUsage') {
      let chosen = outs.find((e) => hasGuard(e) && guardHoldsStore(e, valueStore, scope));
      if (!chosen) chosen = outs.find((e) => !hasGuard(e)); // else / default branch
      firing = chosen ? [chosen] : [];
    } else {
      firing = outs;
    }

    for (const e of firing) {
      edgesFired.push(e.id);
      const t = e.target![0];
      const guardStr = typeof e.attrs.guard === 'string' ? e.attrs.guard : undefined;
      if (guardStr !== undefined && !guardOf.has(t)) guardOf.set(t, guardStr);
      const target = model.get(t)!;
      if (target.eClass === 'JoinNode') {
        arrived.set(t, (arrived.get(t) ?? 0) + 1);
        if ((arrived.get(t) ?? 0) >= (indeg.get(t) ?? 0)) active.push(t);
      } else {
        active.push(t);
      }
    }
  }

  const complete = doneReached || active.length === 0;
  return { steps, edgesFired, complete };
}

/* ─────────────────────── action-flow node effects ────────────────────── */

/** A node metaclass is a bounded loop (While/For). */
function isLoopNode(el: ElementRecord): boolean {
  return el.eClass === 'WhileLoopActionUsage' || el.eClass === 'ForLoopActionUsage';
}

/** Does a succession carry a (non-empty) guard? */
function hasGuard(edge: ElementRecord): boolean {
  const g = edge.attrs.guard;
  return typeof g === 'string' && g.trim() !== '';
}

/** Result of a single node's effect on the value store. */
interface NodeEffect {
  iterations: number;
  note?: string;
}

/**
 * Apply node `el`'s effect to the value `store`: AssignmentActionUsage updates
 * the store; Accept/Send actions are recorded; While/For loops iterate their
 * body against the store (bounded by `budget`). Returns iteration count + note.
 */
function executeNode(
  model: Model,
  el: ElementRecord,
  store: Map<string, unknown>,
  scope: Scope,
  budget: number,
): NodeEffect {
  switch (el.eClass) {
    case 'AssignmentActionUsage': {
      const note = applyAssignment(el, store, scope);
      return { iterations: 0, note };
    }
    case 'AcceptActionUsage': {
      const what = strAttr(el, 'payload') ?? strAttr(el, 'message') ?? el.declaredName ?? '';
      // Optionally bind the accepted payload into the store when a value given.
      // The parser stores a literal value as a number or boolean, not a string,
      // so read the attribute raw: `evalStr` passes non-strings through.
      const val = el.attrs.value ?? undefined;
      if (what && val !== undefined) {
        const v = evalStr(val, store, scope);
        if (v !== undefined) store.set(what, v);
      }
      return { iterations: 0, note: `accept ${what}`.trim() };
    }
    case 'SendActionUsage': {
      const what = strAttr(el, 'payload') ?? strAttr(el, 'message') ?? el.declaredName ?? '';
      return { iterations: 0, note: `send ${what}`.trim() };
    }
    case 'WhileLoopActionUsage':
    case 'ForLoopActionUsage': {
      const iters = runLoop(model, el, store, scope, budget);
      return { iterations: iters, note: `loop ×${iters}` };
    }
    default:
      return { iterations: 0 };
  }
}

/** Node metaclasses that act as a loop-body statement. */
function isBodyStatement(el: ElementRecord): boolean {
  return (
    el.eClass === 'AssignmentActionUsage' ||
    el.eClass === 'SendActionUsage' ||
    el.eClass === 'AcceptActionUsage' ||
    el.eClass === 'ActionUsage'
  );
}

/**
 * Run a While/For loop against the store, bounded by `budget` iterations. The
 * loop body is the loop node's inline `attrs.body` assignment (a `name = expr`
 * string) followed by its child body statements (in declaration order). For a
 * ForLoop the loop variable is written to the store before each iteration.
 */
function runLoop(
  model: Model,
  loop: ElementRecord,
  store: Map<string, unknown>,
  scope: Scope,
  budget: number,
): number {
  const cap = Math.max(0, Math.min(budget, 100000));
  const body = model.children(loop.id).filter(isBodyStatement);
  let iters = 0;

  if (loop.eClass === 'ForLoopActionUsage') {
    const varName = strAttr(loop, 'variable') ?? strAttr(loop, 'var') ?? 'i';
    const from = asNumber(evalStr(strAttr(loop, 'from') ?? '0', store, scope)) ?? 0;
    const to = asNumber(evalStr(strAttr(loop, 'to') ?? '', store, scope));
    const stepBy = asNumber(evalStr(strAttr(loop, 'step') ?? '1', store, scope)) ?? 1;
    if (to === undefined || stepBy === 0) return 0;
    for (
      let v = from;
      (stepBy > 0 ? v <= to : v >= to) && iters < cap;
      v += stepBy
    ) {
      store.set(varName, v);
      runLoopBody(loop, body, store, scope);
      iters++;
    }
    return iters;
  }

  // WhileLoopActionUsage
  const guard = strAttr(loop, 'guard') ?? strAttr(loop, 'while') ?? strAttr(loop, 'condition');
  while (iters < cap) {
    const cond = guard !== undefined ? evalStr(guard, store, scope) : false;
    if (cond !== true) break;
    runLoopBody(loop, body, store, scope);
    iters++;
  }
  return iters;
}

/** Execute one pass of a loop body: inline `attrs.body`, then child statements. */
function runLoopBody(
  loop: ElementRecord,
  body: ElementRecord[],
  store: Map<string, unknown>,
  scope: Scope,
): void {
  const inline = strAttr(loop, 'body');
  if (inline !== undefined) inlineAssign(inline, store, scope);
  for (const stmt of body) {
    if (stmt.eClass === 'AssignmentActionUsage') applyAssignment(stmt, store, scope);
  }
}

/**
 * Seed the FEATURE-ID value store (and, when absent, the by-name store) from
 * literal pin/feature values in `behavior`. Complements {@link seedStore} for
 * called sub-behaviors whose features are not descendants of the caller.
 */
function seedStoreById(
  model: Model,
  behavior: ElementRecord,
  store: Map<string, unknown>,
  valueById: Map<ElementId, unknown>,
): void {
  for (const f of model.descendants(behavior.id)) {
    if (!isUsage(f.eClass)) continue;
    const v = literalValueOf(f);
    if (v === undefined) continue;
    if (!valueById.has(f.id)) valueById.set(f.id, v);
    const name = f.declaredName;
    if (name && !store.has(name)) store.set(name, v);
  }
}

/* ─────────────── composite / call actions (sub-behaviors) ─────────────── */

/** ActionUsage-family metaclasses (a node that can host or invoke a behavior). */
function isActionNode(el: ElementRecord): boolean {
  return el.eClass === 'ActionUsage' || el.eClass.endsWith('ActionUsage');
}

/**
 * Does `node` own its OWN control/object sub-flow (nested Succession /
 * SuccessionFlow, control node, or loop among its descendants)? Such a node is a
 * COMPOSITE action whose sub-flow is executed recursively rather than flattened.
 */
function ownsSubFlow(model: Model, node: ElementRecord): boolean {
  if (!isActionNode(node)) return false;
  return model
    .descendants(node.id)
    .some((d) => SUCCESSION_KINDS.has(d.eClass) || isControlNode(d.eClass) || isLoopNode(d));
}

/**
 * The behavior a node executes as a sub-behavior, or `undefined` when it is a
 * plain leaf action. A COMPOSITE action returns its own id (its nested sub-flow
 * runs); a CALL action (PerformActionUsage, or an ActionUsage typed by / subset
 * of an ActionDefinition that owns a flow) returns the referenced behavior id.
 */
function subBehaviorOf(model: Model, node: ElementRecord): ElementId | undefined {
  if (!isActionNode(node)) return undefined;
  if (ownsSubFlow(model, node)) return node.id;
  const target = callTargetOf(model, node);
  if (target && ownsSubFlow(model, target)) return target.id;
  return undefined;
}

/** Resolve the action a CALL node references (typing / subsetting / attr id). */
function callTargetOf(model: Model, node: ElementRecord): ElementRecord | undefined {
  // Explicit attribute reference to the performed behavior.
  for (const key of ['performedAction', 'action', 'behavior', 'performed']) {
    const ref = node.attrs[key];
    if (typeof ref === 'string' && model.has(ref)) {
      const el = model.get(ref)!;
      if (isActionNode(el) || el.eClass === 'ActionDefinition') return el;
    }
  }
  // Typing / subsetting / redefinition targets that are actions.
  for (const t of model.typesOf(node.id)) {
    if (isActionNode(t) || t.eClass === 'ActionDefinition') return t;
  }
  return undefined;
}

/** Feature-direction of a pin/parameter (`in` / `out` / `inout` / `return`). */
function pinDirection(el: ElementRecord): string | undefined {
  const d = el.attrs.direction;
  return typeof d === 'string' ? d : undefined;
}

/** The out/return result parameters of an action (its produced pins). */
function resultParamsOf(model: Model, actionId: ElementId): ElementRecord[] {
  return model.children(actionId).filter((c) => {
    if (!isUsage(c.eClass)) return false;
    const d = pinDirection(c);
    return d === 'out' || d === 'inout' || d === 'return' || c.attrs.isResult === true;
  });
}

/** Snapshot the result-parameter values produced by a finished sub-behavior. */
function resultParamValues(
  model: Model,
  actionId: ElementId,
  store: Map<string, unknown>,
  valueById: Map<ElementId, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of resultParamsOf(model, actionId)) {
    let v: unknown;
    if (valueById.has(p.id)) v = valueById.get(p.id);
    else if (p.declaredName && store.has(p.declaredName)) v = store.get(p.declaredName);
    if (v !== undefined && p.declaredName) out[p.declaredName] = v;
  }
  return out;
}

/* ─────────────── object / item-flow data passing (pins) ──────────────── */

/** Metaclasses that carry item/object data along a flow. */
const ITEM_FLOW_EDGE_KINDS = new Set(['ItemFlow', 'Flow', 'FlowUsage', 'SuccessionFlow']);

/** A resolved item flow between two pins inside an action. */
interface FlowEdge {
  source: ElementId;
  target: ElementId;
}

/**
 * The item/object flows internal to `actionId` (descendant ItemFlow / Flow /
 * FlowUsage / SuccessionFlow, or a payload-carrying Succession) with resolved
 * source & target pin ids. `nodeIds` bounds the flows to this flow level.
 */
function itemFlowsWithin(
  model: Model,
  actionId: ElementId,
  _nodeIds: Set<ElementId>,
): FlowEdge[] {
  const out: FlowEdge[] = [];
  for (const e of model.descendants(actionId)) {
    const isFlow = ITEM_FLOW_EDGE_KINDS.has(e.eClass);
    const payloadSuccession = e.eClass === 'Succession' && e.attrs.payload !== undefined;
    if (!isFlow && !payloadSuccession) continue;
    const s = e.source?.[0];
    const t = e.target?.[0];
    if (s === undefined || t === undefined) continue;
    out.push({ source: s, target: t });
  }
  return out;
}

/**
 * Carry each item flow's source-pin value to its target pin, keyed by feature
 * id (and mirrored into the by-name store so downstream expressions can read
 * the input pin by name). Honors pin direction implicitly: a flow's `source`
 * end is an output, its `target` an input. Iterated to a bounded fixpoint.
 */
function propagateFlows(
  model: Model,
  flows: FlowEdge[],
  store: Map<string, unknown>,
  valueById: Map<ElementId, unknown>,
): void {
  if (flows.length === 0) return;
  let changed = true;
  let guard = flows.length + 4;
  while (changed && guard-- > 0) {
    changed = false;
    for (const flow of flows) {
      const sv = pinValue(model, flow.source, store, valueById);
      if (sv === undefined) continue;
      if (!valueById.has(flow.source)) valueById.set(flow.source, sv);
      if (valueById.get(flow.target) !== sv) {
        valueById.set(flow.target, sv);
        const tname = model.get(flow.target)?.declaredName;
        if (tname) store.set(tname, sv);
        changed = true;
      }
    }
  }
}

/** The current value of a pin: its id-store value, else its name-store value. */
function pinValue(
  model: Model,
  pinId: ElementId,
  store: Map<string, unknown>,
  valueById: Map<ElementId, unknown>,
): unknown {
  if (valueById.has(pinId)) return valueById.get(pinId);
  const name = model.get(pinId)?.declaredName;
  if (name && store.has(name)) return store.get(name);
  return undefined;
}

/** Coerce a value to a number, or `undefined` when it is not numeric. */
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Kahn topological sort; leftover (cycle) nodes appended in declaration order. */
function _topoOrder(
  nodeIds: Set<ElementId>,
  outgoing: Map<ElementId, ElementRecord[]>,
  indeg: Map<ElementId, number>,
  declIndex: Map<ElementId, number>,
): ElementId[] {
  const deg = new Map(indeg);
  const byDecl = (a: ElementId, b: ElementId): number =>
    (declIndex.get(a) ?? 0) - (declIndex.get(b) ?? 0);
  const ready = [...nodeIds].filter((id) => (deg.get(id) ?? 0) === 0).sort(byDecl);
  const order: ElementId[] = [];
  const done = new Set<ElementId>();
  while (ready.length) {
    ready.sort(byDecl);
    const id = ready.shift()!;
    if (done.has(id)) continue;
    done.add(id);
    order.push(id);
    for (const e of outgoing.get(id) ?? []) {
      const t = e.target![0];
      deg.set(t, (deg.get(t) ?? 0) - 1);
      if ((deg.get(t) ?? 0) <= 0 && !done.has(t)) ready.push(t);
    }
  }
  // Any node not reached (part of a cycle) — append deterministically.
  for (const id of [...nodeIds].sort(byDecl)) if (!done.has(id)) order.push(id);
  return order;
}

/**
 * Tag each node that lies on a parallel branch spawned by a ForkNode with that
 * fork's id, walking forward from the fork and stopping at any JoinNode.
 */
function computeParallelGroups(
  model: Model,
  nodeList: ElementRecord[],
  outgoing: Map<ElementId, ElementRecord[]>,
  declIndex: Map<ElementId, number>,
): Map<ElementId, string> {
  const groupOf = new Map<ElementId, string>();
  const forks = nodeList
    .filter((n) => n.eClass === 'ForkNode')
    .sort((a, b) => (declIndex.get(a.id) ?? 0) - (declIndex.get(b.id) ?? 0));
  for (const fork of forks) {
    const stack = (outgoing.get(fork.id) ?? []).map((e) => e.target![0]);
    const seen = new Set<ElementId>();
    while (stack.length) {
      const id = stack.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const el = model.get(id);
      if (!el) continue;
      if (el.eClass === 'JoinNode') continue; // sync point closes the region
      if (!groupOf.has(id)) groupOf.set(id, fork.id);
      for (const e of outgoing.get(id) ?? []) stack.push(e.target![0]);
    }
  }
  return groupOf;
}

/** A Succession guard holds when it is absent or evaluates to boolean true. */
function _guardHolds(edge: ElementRecord, scope: Scope): boolean {
  const g = edge.attrs.guard;
  if (typeof g !== 'string' || g.trim() === '') return true;
  try {
    const r = evaluate(parseExpr(g), scope);
    return 'value' in r && r.value === true;
  } catch {
    return false;
  }
}

/* ─────────────────────────── state machine ───────────────────────────── */

/** A single transition that fired during a {@link runStateMachine}. */
export interface StateFire {
  transitionId: ElementId;
  from: ElementId;
  to: ElementId;
  /** The trigger that caused the firing. */
  trigger: string;
}

/** A behavior (entry/do/exit action) performed while in a state. */
export interface PerformedAction {
  /** The state the behavior belongs to. */
  stateId: ElementId;
  /** When the behavior ran relative to the state's lifecycle. */
  phase: 'entry' | 'do' | 'exit';
  /** Element id of the performed ActionUsage. */
  actionId: ElementId;
  /** Declared name of the behavior (empty when anonymous). */
  name: string;
}

/**
 * A discrete clock advance in a timed run: pushes the machine's clock forward by
 * `advance` ticks, enabling any `after(n)` transitions whose dwell time is met.
 */
export interface TimedStep {
  advance: number;
}

/**
 * One driving step of {@link runStateMachine}: either a NAMED trigger (a plain
 * string) or a {@link TimedStep} time advance. `string[]` is assignable to
 * `StateStep[]`, so existing string-trigger callers are unaffected.
 */
export type StateStep = string | TimedStep;

/** Options for {@link runStateMachine}. */
export interface RunStateOptions {
  /** Initial value-store bindings (feature name → value), applied last. */
  store?: Map<string, unknown> | Record<string, unknown>;
  /** Bound on automatic completion-transition chasing per step. Default 64. */
  maxCompletion?: number;
}

/** Result of driving a state machine against a trigger sequence. */
export interface StateRunResult {
  /** State ids in the order visited, starting with the initial state. */
  visited: ElementId[];
  /** Transitions fired, in order. */
  fired: StateFire[];
  /** Entry/do/exit behaviors performed, in order. */
  performed: PerformedAction[];
  /** The value store after execution (transition/behavior effects applied). */
  valueStore: Map<string, unknown>;
  /** Currently-active states (one leaf per concurrent region). */
  activeStates: ElementId[];
  /**
   * The current state after all triggers are processed for a single-region
   * machine (or null / the first region's state for a parallel machine).
   */
  finalState: ElementId | null;
  /**
   * The discrete clock value after a TIMED run (0 for untimed runs). Advanced by
   * {@link TimedStep} steps; gates `after(n)` transitions. Additive field.
   */
  clock?: number;
  /**
   * True when every concurrent region reached a final/complete state (and any
   * orthogonal join transition fired). Additive field; `undefined` on the legacy
   * flat/parallel path where completeness is not tracked.
   */
  complete?: boolean;
  /**
   * True when the completion chase ran out of its `maxCompletion` budget with a
   * completion transition still enabled — the run stopped mid-chase rather than
   * at quiescence.
   *
   * WHY IT IS PUBLISHED. The chase used to exhaust its budget indistinguishably
   * from reaching quiescence: no flag, no return value, and a reader could not
   * tell a machine that settled from one that was cut off at 64 steps. Anything
   * that reports on a run has to be able to say which it was (plan §3.8), so the
   * budget state comes back out. Both interpreter paths set it; it is
   * `undefined` only for a container that holds no machine at all.
   */
  completionBudgetHit?: boolean;
}

/**
 * Drive the state machine rooted at `stateId` against `triggers`. Starts at the
 * initial state (an InitialNode's successor, else the first contained
 * StateUsage). For each trigger, fires the first enabled STEP EDGE (trigger
 * matches + guard true) leaving the current state, moving to its target.
 * Deterministic; bounded by `triggers.length`.
 *
 * A step edge is a `TransitionUsage` or a `Succession` between two states —
 * `STEP_EDGE_KINDS` in `./mc/config.ts`. The notation writes the same edge both
 * ways (`transition idle then active;` and `first active then done;`) and a
 * machine may mix them in one body; reading only the first spelling stopped
 * this interpreter at a state the model plainly leaves, and made every absence
 * `reach` published over such a machine a claim about an edge nothing followed.
 */
export function runStateMachine(
  model: Model,
  stateId: ElementId,
  triggers: StateStep[] = [],
  opts: RunStateOptions = {},
): StateRunResult {
  const container = model.get(stateId);
  const valueStore = new Map<string, unknown>();
  if (!container) {
    return { visited: [], fired: [], performed: [], valueStore, activeStates: [], finalState: null };
  }

  seedStore(model, container, valueStore, opts.store);
  const maxCompletion = Math.max(0, opts.maxCompletion ?? 64);
  const performed: PerformedAction[] = [];

  const parallel = isTruthy(container.attrs.parallel) || isTruthy(container.attrs.isParallel);

  // Route to the fuller HIERARCHICAL / TIMED interpreter when the machine has
  // nested composite states, a history pseudostate, an orthogonal join
  // transition, or the run carries timed steps. Otherwise use the (unchanged)
  // flat/simple-parallel path so existing behavior is preserved exactly.
  const timed = triggers.some(isTimedStep);
  if (timed || needsHierarchical(model, container, parallel)) {
    return runHierMachine(model, container, triggers, valueStore, performed, maxCompletion, parallel);
  }

  const stringTriggers = triggers.filter((t): t is string => typeof t === 'string');

  // Determine the concurrent regions. A state marked parallel runs each child
  // composite state as an independent region; otherwise the container is one
  // region.
  let regions: ElementRecord[];
  if (parallel) {
    regions = model
      .children(stateId)
      .filter(
        (c) => c.eClass === 'StateUsage' && model.descendants(c.id).some((d) => d.eClass === 'StateUsage'),
      );
    if (regions.length === 0) regions = [container];
  } else {
    regions = [container];
  }

  const visited: ElementId[] = [];
  const fired: StateFire[] = [];
  const finals: (ElementId | null)[] = [];
  let completionBudgetHit = false;
  for (const region of regions) {
    const res = runRegion(model, region.id, stringTriggers, valueStore, performed, maxCompletion);
    visited.push(...res.visited);
    fired.push(...res.fired);
    finals.push(res.finalState);
    if (res.completionBudgetHit) completionBudgetHit = true;
  }

  const activeStates = finals.filter((s): s is ElementId => s !== null);
  const finalState = parallel ? (finals[0] ?? null) : (finals[0] ?? null);
  return { visited, fired, performed, valueStore, activeStates, finalState, completionBudgetHit };
}

/** A driving step is a discrete-clock time advance rather than a named trigger. */
function isTimedStep(s: StateStep): s is TimedStep {
  return typeof s === 'object' && s !== null && typeof (s as TimedStep).advance === 'number';
}

/** Drive a single region against the trigger sequence, sharing the store. */
function runRegion(
  model: Model,
  regionId: ElementId,
  triggers: string[],
  store: Map<string, unknown>,
  performed: PerformedAction[],
  maxCompletion: number,
): { visited: ElementId[]; fired: StateFire[]; finalState: ElementId | null; completionBudgetHit: boolean } {
  const region = model.get(regionId)!;
  const desc = model.descendants(regionId);
  const states = desc.filter((e) => e.eClass === 'StateUsage');
  const declIndex = new Map<ElementId, number>();
  desc.forEach((e, i) => declIndex.set(e.id, i));

  // THE SAME LIST THE CHECKER READS, and not a second filter that agrees with
  // it today. This path used to build its own — `TransitionUsage` with both
  // endpoints, in descendant order — which is exactly what `regionTransitions`
  // returns, minus the succession edges it was missing. Two filters over one
  // relation is how the simulator and the explorer came to walk different
  // graphs while the differential between them stayed green: a differential
  // cannot see an edge BOTH readers ignore. The declaration-order sort is gone
  // with the duplicate because `model.descendants` already yields that order,
  // which is the order `declIndex` was built from.
  const transitions = regionTransitions(model, regionId);

  const scope = combinedScope(model, region);
  const visited: ElementId[] = [];
  const fired: StateFire[] = [];

  let completionBudgetHit = false;

  let current = initialState(model, regionId, states, desc, declIndex);
  if (!current) return { visited, fired, finalState: null, completionBudgetHit };
  visited.push(current);
  enterState(model, current, store, scope, performed);
  const opening = chaseCompletion(model, current, transitions, store, scope, performed, visited, fired, maxCompletion);
  current = opening.current;
  if (opening.exhausted) completionBudgetHit = true;

  for (const trigger of triggers) {
    const cur = current!;
    const t = transitions.find(
      (tr) =>
        tr.source![0] === cur &&
        triggerEquals(tr, trigger) &&
        guardHoldsStore(tr, store, scope),
    );
    if (!t) continue; // no enabled transition — stay put
    const to = t.target![0];
    exitState(model, cur, store, scope, performed);
    applyTransitionEffect(t, store, scope);
    fired.push({ transitionId: t.id, from: cur, to, trigger });
    current = to;
    visited.push(to);
    enterState(model, to, store, scope, performed);
    const chased = chaseCompletion(model, current, transitions, store, scope, performed, visited, fired, maxCompletion);
    current = chased.current;
    if (chased.exhausted) completionBudgetHit = true;
  }

  return { visited, fired, finalState: current, completionBudgetHit };
}

/**
 * Fire completion (trigger-less) transitions automatically after entering a
 * state, bounded by `budget`, applying entry/exit behaviors and effects — and
 * SAY whether it stopped at quiescence or ran out of budget.
 *
 * The budget state is returned for the same reason its hierarchical sibling
 * returns one (plan §3.8): a chase cut off mid-run left the machine somewhere
 * it would not have stopped, and a run that could not tell a reader which of
 * the two happened was reporting a bound as a fact.
 */
function chaseCompletion(
  model: Model,
  start: ElementId,
  transitions: readonly ElementRecord[],
  store: Map<string, unknown>,
  scope: Scope,
  performed: PerformedAction[],
  visited: ElementId[],
  fired: StateFire[],
  budget: number,
): { current: ElementId; exhausted: boolean } {
  let current = start;
  const enabled = (): ElementRecord | undefined =>
    transitions.find(
      (tr) => tr.source![0] === current && isCompletion(tr) && guardHoldsStore(tr, store, scope),
    );
  for (let i = 0; i < budget; i++) {
    const t = enabled();
    if (!t) return { current, exhausted: false };
    const to = t.target![0];
    exitState(model, current, store, scope, performed);
    applyTransitionEffect(t, store, scope);
    fired.push({ transitionId: t.id, from: current, to, trigger: '' });
    current = to;
    visited.push(to);
    enterState(model, to, store, scope, performed);
  }
  // Budget spent. Exhausted only if something was still enabled: a chase that
  // used its last step to reach quiescence did not run out of anything.
  return { current, exhausted: enabled() !== undefined };
}

/** Record + apply the entry then do behaviors of a state being entered. */
function enterState(
  model: Model,
  stateId: ElementId,
  store: Map<string, unknown>,
  scope: Scope,
  performed: PerformedAction[],
): void {
  runStatePhase(model, stateId, 'entry', store, scope, performed);
  runStatePhase(model, stateId, 'do', store, scope, performed);
}

/** Record + apply the exit behaviors of a state being left. */
function exitState(
  model: Model,
  stateId: ElementId,
  store: Map<string, unknown>,
  scope: Scope,
  performed: PerformedAction[],
): void {
  runStatePhase(model, stateId, 'exit', store, scope, performed);
}

/** A transition's trigger matches when equal, or it is a completion transition. */
function _triggerMatches(tr: ElementRecord, trigger: string): boolean {
  const t = tr.attrs.trigger;
  if (t === undefined || t === null || t === '') return true; // completion transition
  return typeof t === 'string' && t === trigger;
}

/* ───────────── hierarchical / orthogonal / timed state machines ────────── */

/** Container-level transitions (source is the container itself). */
function containerTransitions(model: Model, containerId: ElementId): ElementRecord[] {
  return model
    .descendants(containerId)
    .filter(
      (e) =>
        e.eClass === 'TransitionUsage' && e.source?.[0] === containerId && e.target?.[0] !== undefined,
    );
}

/** An orthogonal JOIN transition: a container-level completion/`join` edge. */
function isJoinTransition(tr: ElementRecord): boolean {
  return tr.attrs.kind === 'join' || isCompletion(tr);
}

/**
 * Does the machine rooted at `container` require the fuller HIERARCHICAL
 * interpreter — a nested composite state, a history pseudostate, or an
 * orthogonal join transition? (Timed runs route there separately.) A simple
 * flat or one-level-parallel machine returns false and uses the legacy path.
 */
function needsHierarchical(model: Model, container: ElementRecord, parallel: boolean): boolean {
  const regionIds = new Set<ElementId>();
  if (parallel) {
    for (const c of model.children(container.id)) {
      if (c.eClass === 'StateUsage' && directStates(model, c.id).length > 0) regionIds.add(c.id);
    }
  }
  for (const s of model.descendants(container.id)) {
    if (s.eClass !== 'StateUsage' || regionIds.has(s.id)) continue;
    if (directStates(model, s.id).length > 0) return true; // nested composite state
    if (isHistoryPseudostate(s) || isHistoryComposite(model, s.id)) return true;
  }
  if (model.descendants(container.id).some(isHistoryPseudostate)) return true;
  return containerTransitions(model, container.id).some(isJoinTransition);
}

/**
 * The fuller HIERARCHICAL / ORTHOGONAL / TIMED state-machine interpreter. Runs
 * each concurrent region as a stack of nested active states (composite entry
 * cascades outer→inner, exit inner→outer, history resumes the last substate),
 * advances a discrete clock for {@link TimedStep}s (firing enabled `after(n)`
 * transitions), and fires an orthogonal join transition only once every region
 * reaches a final state. Shares the value store; deterministic and bounded.
 */
function runHierMachine(
  model: Model,
  container: ElementRecord,
  steps: StateStep[],
  store: Map<string, unknown>,
  performed: PerformedAction[],
  maxCompletion: number,
  parallel: boolean,
): StateRunResult {
  const visited: ElementId[] = [];
  const fired: StateFire[] = [];
  const history = new Map<ElementId, ElementId>();
  const clockRef = { clock: 0 };

  let regionContainers: ElementRecord[];
  if (parallel) {
    regionContainers = model
      .children(container.id)
      .filter((c) => c.eClass === 'StateUsage' && directStates(model, c.id).length > 0);
    if (regionContainers.length === 0) regionContainers = [container];
  } else {
    regionContainers = [container];
  }

  const leaves: (ElementId | null)[] = [];
  const completes: boolean[] = [];
  let completionBudgetHit = false;
  for (const rc of regionContainers) {
    const r = runHierRegion(model, rc.id, steps, store, performed, visited, fired, history, clockRef, maxCompletion);
    leaves.push(r.leaf);
    completes.push(r.complete);
    if (r.completionBudgetHit) completionBudgetHit = true;
  }

  const activeStates = leaves.filter((s): s is ElementId => s !== null);
  let complete = completes.length > 0 && completes.every(Boolean);
  let finalState = leaves[0] ?? null;

  // Orthogonal JOIN: a container-level join/completion transition fires only
  // when every region has reached a final/complete state.
  if (parallel) {
    const join = containerTransitions(model, container.id).find(isJoinTransition);
    if (join) {
      if (complete) {
        const scope = combinedScope(model, container);
        const to = join.target![0];
        applyTransitionEffect(join, store, scope);
        fired.push({ transitionId: join.id, from: container.id, to, trigger: triggerLabelOf(join) });
        visited.push(to);
        enterState(model, to, store, scope, performed);
        finalState = to;
        complete = true;
      } else {
        complete = false;
      }
    }
  }

  return {
    visited,
    fired,
    performed,
    valueStore: store,
    activeStates,
    finalState,
    clock: clockRef.clock,
    complete,
    completionBudgetHit,
  };
}

/**
 * Drive a single hierarchical region (rooted at `containerId`) against the step
 * sequence. Returns the active leaf, whether the region reached a final state,
 * and whether the completion chase ever ran out of budget.
 *
 * THE FOUR CLOSURES ARE GONE. `fire`, `enterCascade`, `exitTo` and
 * `chaseHierCompletion` used to be mutable closures over this function's stack;
 * they are now `stepConfig` / `enabledTransitions` in `./mc/config.ts` and this
 * function is the DRIVING LOOP over them — it asks what is enabled and takes
 * `[0]`, which is the same first-enabled tie-break it always had (innermost
 * active state first, declaration order within a state). The point is that a
 * checker can now ask the same question and take a different answer, and
 * `test/unit/semantics.mc.differential.test.ts` holds the two to one relation.
 *
 * The run's arrays, store, clock and history map are still this function's to
 * append to: a configuration is a value, and what a step appended to the run
 * comes back beside it.
 */
function runHierRegion(
  model: Model,
  containerId: ElementId,
  steps: StateStep[],
  store: Map<string, unknown>,
  performed: PerformedAction[],
  visited: ElementId[],
  fired: StateFire[],
  history: Map<ElementId, ElementId>,
  clockRef: { clock: number },
  maxCompletion: number,
): { leaf: ElementId | null; complete: boolean; completionBudgetHit: boolean } {
  const COMPLETION: StepInput = { kind: 'completion' };
  const TIMEOUT: StepInput = { kind: 'timeout' };

  // The region starts from the RUN's store, clock and history, because regions
  // share all three: region 2 sees what region 1 wrote (`runStateMachine`
  // concatenates regions, it does not interleave them — the semantic profile
  // says so in those words).
  const opening = initialConfig(model, containerId, { store, clock: clockRef.clock, history });
  let cfg: MachineConfig = opening.config;
  let completionBudgetHit = false;

  /** Take a step: publish its effects into the run, and keep the new config. */
  const apply = (r: { config: MachineConfig; effects: StepEffects }): void => {
    cfg = r.config;
    visited.push(...r.effects.visited);
    fired.push(...r.effects.fired);
    performed.push(...r.effects.performed);
    // Written back rather than swapped: `valueStore` is the map the caller gets
    // and the next region reads, so it has to be the same object throughout.
    // Nothing in the step relation deletes a key, so setting is enough.
    for (const [k, v] of r.config.store) store.set(k, v);
    clockRef.clock = r.config.clock;
    for (const [k, v] of r.config.history) history.set(k, v);
  };

  /**
   * Fire completion (trigger-less) transitions until none is enabled — and SAY
   * whether it stopped because none was enabled or because the budget ran out.
   *
   * The budget state is the return value this closure did not use to have, and
   * the reason it now does is honesty downstream: a chase that stopped at 64
   * steps has left the machine mid-run, and a report that called the result
   * quiescent would be reporting a bound as a fact (plan §3.8).
   */
  const chaseHierCompletion = (): { fires: number; exhausted: boolean } => {
    let fires = 0;
    while (fires < maxCompletion) {
      const enabled = enabledTransitions(model, cfg, COMPLETION);
      if (enabled.length === 0) return { fires, exhausted: false };
      apply(stepConfig(model, cfg, enabled[0]));
      fires++;
    }
    // Budget spent. Exhausted only if something was still enabled: a chase that
    // used its last step to reach quiescence did not run out of anything.
    return { fires, exhausted: enabledTransitions(model, cfg, COMPLETION).length > 0 };
  };

  const fire = (choice: EnabledTransition): void => {
    apply(stepConfig(model, cfg, choice));
    if (chaseHierCompletion().exhausted) completionBudgetHit = true;
  };

  if (cfg.stack.length === 0) return { leaf: null, complete: false, completionBudgetHit: false };
  apply(opening);
  if (chaseHierCompletion().exhausted) completionBudgetHit = true;

  for (const step of steps) {
    if (isTimedStep(step)) {
      cfg = advanceClock(cfg, step.advance);
      clockRef.clock = cfg.clock;
      // Every `after(n)` whose dwell the advance met, innermost first, bounded
      // by the same budget the chase uses.
      for (let k = 0; k < maxCompletion; k++) {
        const enabled = enabledTransitions(model, cfg, TIMEOUT);
        if (enabled.length === 0) break;
        fire(enabled[0]);
      }
    } else {
      const enabled = enabledTransitions(model, cfg, { kind: 'trigger', trigger: step });
      if (enabled.length > 0) fire(enabled[0]);
    }
  }

  const leaf = leafOf(cfg);
  const complete = leaf !== null && isFinalState(model, leaf);
  return { leaf, complete, completionBudgetHit };
}

/* ─────────────────────────── binding propagation ─────────────────────── */

/**
 * Force feature-value equality across every binding connector
 * (BindingConnector / `bind` / equality connector), seed each equality
 * component with any known literal `attrs.value`, and propagate that value to
 * all members of the component (a fixpoint over the equality partition).
 * Features in an undetermined component are left out of the map.
 */
export function propagateBindings(model: Model): Map<ElementId, unknown> {
  const parent = new Map<ElementId, ElementId>();
  const order: ElementId[] = [];
  const ensure = (id: ElementId): void => {
    if (!parent.has(id)) {
      parent.set(id, id);
      order.push(id);
    }
  };
  const find = (x: ElementId): ElementId => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // path compression
    let c = x;
    while (parent.get(c) !== r) {
      const nxt = parent.get(c)!;
      parent.set(c, r);
      c = nxt;
    }
    return r;
  };
  const union = (a: ElementId, b: ElementId): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const el of model.all()) {
    if (!isBindingEdge(el)) continue;
    const s = el.source?.[0];
    const t = el.target?.[0];
    if (s === undefined || t === undefined) continue;
    ensure(s);
    ensure(t);
    union(s, t);
  }

  // Group members by their equality-component root (insertion order preserved).
  const byRoot = new Map<ElementId, ElementId[]>();
  for (const id of order) {
    const root = find(id);
    const list = byRoot.get(root);
    if (list) list.push(id);
    else byRoot.set(root, [id]);
  }

  const result = new Map<ElementId, unknown>();
  for (const members of byRoot.values()) {
    let seed: unknown;
    for (const id of members) {
      const v = literalValueOf(model.get(id));
      if (v !== undefined) {
        seed = v;
        break;
      }
    }
    if (seed === undefined) continue; // undetermined component — leave unknown
    for (const id of members) result.set(id, seed);
  }
  return result;
}

/* ─────────────────────────── model evaluation ────────────────────────── */

/** The result of a whole-model value + constraint evaluation. */
export interface ModelEvaluation {
  /** featureId → evaluated value (only features with a determined value). */
  values: Map<ElementId, unknown>;
  /** Constraint/requirement satisfaction results. */
  constraints: ConstraintCheck[];
}

/**
 * Evaluate feature values/expressions across the whole model — literals, bound
 * values (via {@link propagateBindings}) and derived/dependent expressions,
 * resolved to a fixpoint — and check every constraint/requirement.
 */
export function evaluateModel(model: Model): ModelEvaluation {
  const known = new Map<ElementId, unknown>();

  // 1. Seed with plain literal feature values.
  const features = model.nodes().filter((el) => isUsage(el.eClass));
  for (const f of features) {
    const v = literalValueOf(f);
    if (v !== undefined) known.set(f.id, v);
  }

  // 2. Overlay bound values (equality components propagate their seed value).
  for (const [id, v] of propagateBindings(model)) {
    if (!known.has(id)) known.set(id, v);
  }

  // 3. Fixpoint over expression-valued features (derived / dependent).
  const exprFeatures = features.filter((f) => isExpressionFeature(f) && !known.has(f.id));
  let changed = true;
  let guard = features.length + 2; // bound iteration count
  while (changed && guard-- > 0) {
    changed = false;
    for (const f of exprFeatures) {
      if (known.has(f.id)) continue;
      const raw = rawExpressionOf(f);
      if (raw === undefined) continue;
      const scope = valueScope(model, f.ownerId ?? f.id, known);
      try {
        const r = evaluate(parseExpr(raw), scope);
        if ('value' in r && r.value !== undefined) {
          known.set(f.id, r.value);
          changed = true;
        }
      } catch {
        /* leave undetermined */
      }
    }
  }

  return { values: known, constraints: checkConstraints(model) };
}

/* ─────────────────────────── model execution ─────────────────────────── */

/** A behavior that was run by {@link executeModel}, with its trace. */
export interface BehaviorTrace {
  /** Element id of the behavior (ActionDefinition/Usage or StateDefinition/Usage). */
  behaviorId: ElementId;
  /** Kind of behavior run. */
  kind: 'action' | 'state';
  /** Declared name of the behavior (empty when anonymous). */
  name: string;
  /** The action-flow result (present when `kind === 'action'`). */
  action?: ExecutionTrace;
  /** The state-machine result (present when `kind === 'state'`). */
  state?: StateRunResult;
}

/** Consolidated whole-model execution result. */
export interface ModelExecution {
  /** featureId → value, from full connector/binding propagation + expressions. */
  values: Map<ElementId, unknown>;
  /** Traces of every top-level behavior that was run. */
  traces: BehaviorTrace[];
  /** Constraint/requirement satisfaction results. */
  constraints: ConstraintCheck[];
}

/**
 * Execute the whole model: run every top-level behavior (action flow / state
 * machine), propagate connector & binding values ({@link propagateValues}) and
 * evaluate feature/expression values, and check all constraints. Returns a
 * consolidated `{ values, traces, constraints }`.
 */
export function executeModel(model: Model): ModelExecution {
  // Values: full connector/binding propagation overlaid with expression eval.
  const values = propagateValues(model);
  for (const [id, v] of evaluateModel(model).values) {
    if (!values.has(id)) values.set(id, v);
  }

  const traces: BehaviorTrace[] = [];
  for (const el of model.all()) {
    if (!isTopLevelBehavior(model, el)) continue;
    if ((el.eClass === 'ActionDefinition' || el.eClass === 'ActionUsage') && hasFlow(model, el)) {
      traces.push({
        behaviorId: el.id,
        kind: 'action',
        name: el.declaredName ?? '',
        action: runActionFlow(model, el.id),
      });
    } else if (
      (el.eClass === 'StateDefinition' || el.eClass === 'StateUsage') &&
      hasStateMachine(model, el)
    ) {
      traces.push({
        behaviorId: el.id,
        kind: 'state',
        name: el.declaredName ?? '',
        state: runStateMachine(model, el.id, []),
      });
    }
  }

  return { values, traces, constraints: checkConstraints(model) };
}

/* ─────────────────────── unified behavior execution ──────────────────── */

/** One step of a {@link BehaviorExecution} (action node or state lifecycle). */
export interface BehaviorStep {
  id: ElementId;
  name: string;
  kind: string;
  /** Effect note (assignment / accept / send / loop / state phase). */
  note?: string;
  /** Composite/call sub-behavior lifecycle marker (action kind). */
  event?: 'enter' | 'exit';
  /** Nesting depth (composite recursion, or nested-state depth). */
  depth?: number;
  /** State lifecycle phase, for performed behaviors (state kind). */
  phase?: 'entry' | 'do' | 'exit';
}

/**
 * The unified result of {@link executeBehavior} — a single shape covering both
 * action-flow and state-machine execution.
 */
export interface BehaviorExecution {
  /** Which interpreter ran. */
  kind: 'action' | 'state';
  /** Element id of the executed behavior. */
  behaviorId: ElementId;
  /** Declared name (empty when anonymous). */
  name: string;
  /** The step trace (nodes / sub-behavior markers, or visited states + phases). */
  steps: BehaviorStep[];
  /** The value store after execution (feature name → value). */
  valueStore: Map<string, unknown>;
  /** Active leaf states (state kind, one per concurrent region). */
  activeStates?: ElementId[];
  /** Final state after the run (state kind). */
  finalState?: ElementId | null;
  /** Discrete clock after a timed run (state kind). */
  clock?: number;
  /** Reached completion (a DoneNode / final states + join). */
  complete: boolean;
  /** The underlying action-flow trace (kind === 'action'). */
  action?: ExecutionTrace;
  /** The underlying state-machine result (kind === 'state'). */
  state?: StateRunResult;
}

/** Options for {@link executeBehavior}. */
export interface ExecuteBehaviorOptions extends RunActionOptions {
  /**
   * Driving steps for a state machine (named triggers and/or {@link TimedStep}
   * time advances). When omitted, the machine is exercised against the distinct
   * trigger alphabet discovered on its transitions.
   */
  triggers?: StateStep[];
  /** Completion-transition chasing bound (state kind). */
  maxCompletion?: number;
}

/**
 * Unified behavior entry point: dispatch `id` to the action-flow or
 * state-machine interpreter based on the element (a State* with transitions →
 * state machine; an Action* / composite with a flow → action flow) and return a
 * single {@link BehaviorExecution}. The fuller semantics apply throughout:
 * composite/call recursion and item-flow data passing for actions; hierarchical,
 * orthogonal and timed execution for state machines.
 */
export function executeBehavior(
  model: Model,
  id: ElementId,
  opts: ExecuteBehaviorOptions = {},
): BehaviorExecution {
  const el = model.get(id);
  if (!el) {
    return { kind: 'action', behaviorId: id, name: '', steps: [], valueStore: new Map(), complete: false };
  }

  const isStateEl = el.eClass === 'StateDefinition' || el.eClass === 'StateUsage';
  const isActionEl = el.eClass === 'ActionDefinition' || isActionNode(el);
  const stateLike = isStateEl && hasStateMachine(model, el);
  const actionLike = isActionEl && hasFlow(model, el);

  const runAsState = stateLike || (!actionLike && hasStateMachine(model, el));
  if (runAsState) {
    const triggers = opts.triggers ?? discoverMachineTriggers(model, id);
    const res = runStateMachine(model, id, triggers, {
      store: opts.store,
      maxCompletion: opts.maxCompletion,
    });
    const steps: BehaviorStep[] = [];
    res.visited.forEach((sid, i) => {
      steps.push({
        id: sid,
        name: model.get(sid)?.declaredName ?? '',
        kind: 'StateUsage',
        note: i === 0 ? 'initial' : 'enter',
      });
    });
    for (const p of res.performed) {
      steps.push({ id: p.actionId, name: p.name, kind: 'behavior', phase: p.phase, note: p.phase });
    }
    return {
      kind: 'state',
      behaviorId: id,
      name: el.declaredName ?? '',
      steps,
      valueStore: res.valueStore,
      activeStates: res.activeStates,
      finalState: res.finalState,
      clock: res.clock,
      complete: res.complete ?? res.finalState !== null,
      state: res,
    };
  }

  const trace = runActionFlow(model, id, opts);
  return {
    kind: 'action',
    behaviorId: id,
    name: el.declaredName ?? '',
    steps: trace.steps,
    valueStore: trace.valueStore,
    complete: trace.complete,
    action: trace,
  };
}

/** Distinct, non-empty transition triggers of a machine, in declaration order. */
function discoverMachineTriggers(model: Model, stateId: ElementId): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of model.descendants(stateId)) {
    if (e.eClass !== 'TransitionUsage') continue;
    const t = e.attrs.trigger;
    if (typeof t !== 'string' || t === '' || seen.has(t)) continue;
    if (afterDuration(e) !== undefined) continue; // timed transitions need clock steps
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** A behavior is top-level when it is not nested inside another behavior. */
function isTopLevelBehavior(model: Model, el: ElementRecord): boolean {
  const BEHAVIOR = new Set([
    'ActionDefinition',
    'ActionUsage',
    'StateDefinition',
    'StateUsage',
  ]);
  if (!BEHAVIOR.has(el.eClass)) return false;
  return !model.ancestors(el.id).some((a) => BEHAVIOR.has(a.eClass));
}

/** Does this action contain any control/flow structure worth simulating? */
function hasFlow(model: Model, el: ElementRecord): boolean {
  return model
    .descendants(el.id)
    .some((d) => SUCCESSION_KINDS.has(d.eClass) || isControlNode(d.eClass) || isLoopNode(d));
}

/** Does this state contain any transition worth simulating? */
function hasStateMachine(model: Model, el: ElementRecord): boolean {
  return model.descendants(el.id).some((d) => d.eClass === 'TransitionUsage');
}

/** Does this feature carry an expression (string) rather than a plain literal? */
function isExpressionFeature(f: ElementRecord): boolean {
  return rawExpressionOf(f) !== undefined;
}

/** The raw expression source of a feature (`attrs.value` string, else `expression`). */
function rawExpressionOf(f: ElementRecord): string | undefined {
  const raw = f.attrs.value !== undefined ? f.attrs.value : f.attrs.expression;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (s === '') return undefined;
  // A bare quoted string is a literal, not an expression to (re)evaluate.
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return undefined;
  }
  return s;
}

/**
 * A value {@link Scope} for `contextId` that prefers already-computed values in
 * `known` (looked up by feature id) and falls back to the static
 * {@link scopeFor} resolver for literal values.
 */
function valueScope(model: Model, contextId: ElementId, known: Map<ElementId, unknown>): Scope {
  const byName = new Map<string, unknown>();
  collectKnown(model, contextId, '', byName, known, new Set());
  const staticScope = scopeFor(model, contextId);
  return (name: string) => {
    if (byName.has(name)) return byName.get(name);
    return staticScope(name);
  };
}

function collectKnown(
  model: Model,
  ownerId: ElementId,
  prefix: string,
  byName: Map<string, unknown>,
  known: Map<ElementId, unknown>,
  visited: Set<string>,
): void {
  const guardKey = `${prefix} ${ownerId}`;
  if (visited.has(guardKey)) return;
  visited.add(guardKey);
  for (const feat of effectiveFeatures(model, ownerId)) {
    const name = feat.declaredName;
    if (!name) continue;
    const full = prefix ? `${prefix}.${name}` : name;
    if (known.has(feat.id)) {
      const v = known.get(feat.id);
      if (!byName.has(full)) byName.set(full, v);
      if (!byName.has(name)) byName.set(name, v);
    }
    for (const type of model.typesOf(feat.id)) {
      collectKnown(model, type.id, full, byName, known, visited);
    }
  }
}

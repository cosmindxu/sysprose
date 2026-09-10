/**
 * The state machine's ONE step relation, as a pure function over a
 * configuration (plan docs/04-formal-verification-plan.md §3.8).
 *
 * WHY THIS MODULE EXISTS. `runStateMachine` decides which transition fires by
 * walking mutable closures (`fire` / `enterCascade` / `exitTo` /
 * `chaseHierCompletion`) that write straight into the run's arrays. A checker
 * cannot reuse that: it has to ask "what is enabled here" without firing
 * anything, and it has to fire the SECOND enabled transition as easily as the
 * first. Re-implementing the semantics beside the interpreter is how a model
 * checker ends up deciding a machine the simulator never runs — the two would
 * agree on the day they were written and drift on every commit afterwards. So
 * the relation is lifted out once and BOTH consume it: `runHierRegion` calls
 * {@link enabledTransitions} and takes `[0]`, and `exploreMachine`
 * (`./explore.ts`) calls the same function and takes all of them.
 *
 * THE INVARIANT, and it is a test rather than a wish
 * (`test/unit/semantics.mc.differential.test.ts`): for every machine in the
 * execute suites and both shipped examples, `runStateMachine` equals the left
 * fold of {@link stepConfig} with `choice = enabledTransitions(...)[0]` —
 * visited, fired, performed, store and clock. If the interpreter grows a rule
 * this file does not have, that test goes red.
 *
 * PURITY. {@link stepConfig} never mutates its argument: the store, the stack,
 * the entry-time table and the history map are copied before anything is
 * applied, and the effects a step produced are returned beside the new
 * configuration rather than appended to a caller's array. The interpreter's own
 * arrays are appended to by `runHierRegion`, from the returned effects.
 *
 * WHAT LIVES HERE. The store/scope helpers and the state-machine primitives
 * moved out of `../execute.ts` with the relation, because the relation needs
 * them and a second copy of `guardHoldsStore` is a second semantics. `execute.ts`
 * imports them back; nothing in this module imports `execute.ts` at run time
 * (the two type imports below are erased), so there is no module cycle.
 */

import { type ElementId, type ElementRecord, type Model, isUsage } from '@core/index';
import { parseExpr, evaluate, type ExprNode } from '../expr';
import { scopeFor, type Scope } from '../evaluate-model';
// The ONE reader of an edge's payload in this codebase: `itemFlowsOf` uses it to
// decide that a `Succession` with an item is a succession flow, and the step
// relation uses it to decide that such an edge is not a step it can model. Two
// readings of "does this edge carry an item" would be two semantics.
import { payloadOf } from '../connectors';
// Type-only, and erased by `isolatedModules`: the two record shapes an
// interpreter run publishes are declared beside `runStateMachine` because they
// are its result type, and importing them as types keeps this module free of a
// run-time dependency on the interpreter it was lifted out of.
import type { PerformedAction, StateFire } from '../execute';

/* ─────────────────────── store, scope and effects ───────────────────────── */

/** Edge metaclasses that carry an action flow's control token. */
export const SUCCESSION_KINDS = new Set(['Succession', 'SuccessionFlow']);

/**
 * The edge metaclasses the state-machine step relation follows.
 *
 * WHY `Succession` IS HERE. The notation offers two spellings for one thing
 * between two states — `transition idle then active;` maps to a
 * `TransitionUsage`, and `first active then done;` maps to a `Succession`
 * (`src/text/langium/map-to-model.ts`) — and a machine may mix them in one
 * body. A relation built out of the first spelling alone put the second in no
 * configuration, in no transition census and in no report, while the walk still
 * called itself exhaustive: `done` was published unreachable and `active`
 * published as a state with no way out, over an edge nothing had followed. A
 * succession between two states carries neither trigger nor payload, so it is
 * read as what it is — a completion transition — and both readers of this
 * relation now see it.
 *
 * WHY `SuccessionFlow` IS NOT — and why a PAYLOAD, not a metaclass, is what
 * decides it. A succession flow carries an ITEM between two pins as well as the
 * control token, and this relation models no payload. Following it would be
 * inventing a semantics; ignoring it silently is the defect above. So it is
 * neither: `edgeCensus` (`./explore.ts`) accounts for it as an edge the walk
 * does not follow, and the machine is refused rather than walked. The same
 * reasoning applies to the SAME object written the other way round — this
 * codebase already reads a `Succession` carrying a payload as a succession flow
 * (`../connectors.ts`, `itemFlowsOf`) — so {@link regionTransitions} asks
 * `payloadOf`, and a metaclass test alone would have walked one of the two
 * spellings of an edge whose payload it cannot model.
 *
 * ONE SET, TWO READERS. `runRegion` in `../execute.ts` used to filter the
 * descendants itself; it now takes {@link regionTransitions} like everything
 * else, because two filters that must agree are two filters that will drift —
 * and drift here is invisible to a differential, which stays green while BOTH
 * drivers ignore the same edge.
 */
export const STEP_EDGE_KINDS: ReadonlySet<string> = new Set(['TransitionUsage', 'Succession']);

/**
 * Every metaclass that SEQUENCES BEHAVIOUR — the census's domain (`./explore.ts`).
 *
 * NOT "every element under the machine that carries endpoints", which is what
 * the census first read and which refused `state idle : Base;`. A model is full
 * of endpoint-carrying elements that are facts ABOUT states rather than steps
 * BETWEEN them — a `FeatureTyping`, a `Subsetting`, a `Redefinition`, a
 * `Disjoining`, a `connect`, an `allocate`, a `satisfy` — and the step relation
 * being blind to every one of them costs no absence claim, because none of them
 * ever carries the machine's control token. Refusing a machine for one of them
 * withholds the whole report over a relationship that was never a step.
 *
 * The teeth are on this side of the line instead: a member of THIS family that
 * the relation does not hold — a spelling it does not read, a payload it cannot
 * model, an endpoint it cannot resolve — is `unaccounted`, fails the census
 * test and refuses the machine. `test/unit/semantics.mc.reach.test.ts` pins the
 * classification against `ALL_METACLASSES`, so a metaclass added to the
 * metamodel later cannot join the model without someone deciding which side of
 * this line it falls on.
 */
export const CONTROL_EDGE_KINDS: ReadonlySet<string> = new Set([
  'TransitionUsage',
  'Succession',
  'SuccessionFlow',
  'TransitionFeature',
]);

/** A store-aware {@link Scope}: the store (by name) shadows the static scope. */
export function storeScope(store: ReadonlyMap<string, unknown>, scope: Scope): Scope {
  return (name: string) => (store.has(name) ? store.get(name) : scope(name));
}

/** Evaluate an expression string against the store, or `undefined` if unknown. */
export function evalStr(raw: unknown, store: ReadonlyMap<string, unknown>, scope: Scope): unknown {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (s === '') return undefined;
  try {
    const r = evaluate(parseExpr(s), storeScope(store, scope));
    return 'value' in r ? r.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a guard did against a store: it held, it failed, or the walk could not
 * say.
 *
 * WHY THREE AND NOT TWO. `evalStr` answers `undefined` both when the expression
 * throws and when a name in it has no value anywhere, so a boolean reading of it
 * makes "could not evaluate" and "evaluated to false" the same answer — and
 * `guardHoldsStore` takes the second reading. That is the right reading for
 * STEPPING (the interpreter has to pick something, and a guard it cannot decide
 * must not fire), and the wrong one for a REPORT: an absence published over an
 * undecided guard says the transition is never enabled when the honest answer is
 * that nothing here decided it. So the two readings are separated: the boolean
 * below still drives every step, and `'undetermined'` is what the report reads.
 *
 * WHERE THE LINE ACTUALLY FALLS, measured rather than assumed. `'fails'` means
 * the expression EVALUATED and the value was not `true` — `if mode` where `mode`
 * is `3` is decided, and inventing an undetermined row for it would fire this
 * gate on a model nothing in which is unknown. `'undetermined'` means the
 * expression yielded no value at all, and `evaluate` yields none in more cases
 * than an unresolved name: a non-boolean operand under `not`/`and`/`or`, a
 * mixed-type comparison, non-finite arithmetic (`src/semantics/expr.ts`). So
 * `not mode` over the SAME fully-valued `mode` is undetermined while `mode` is
 * decided — the defect there is a type error in the guard rather than a missing
 * value, and the row says so by naming no unresolved name. That is the
 * conservative direction (a guard the walk could not read is not a guard that is
 * false, whichever way it failed to read), but it is not the narrow
 * unresolved-name reading, and the hint a reader is given branches on which of
 * the two it was.
 */
export type GuardVerdict = 'holds' | 'fails' | 'undetermined';

/** The guard text of an edge, or `undefined` when it carries none. */
export function guardTextOf(edge: ElementRecord): string | undefined {
  const g = edge.attrs.guard;
  if (typeof g !== 'string' || g.trim() === '') return undefined;
  return g.trim();
}

/** Three-valued reading of a guard against the store — see {@link GuardVerdict}. */
export function guardVerdictStore(
  edge: ElementRecord,
  store: ReadonlyMap<string, unknown>,
  scope: Scope,
): GuardVerdict {
  const g = guardTextOf(edge);
  if (g === undefined) return 'holds'; // an absent guard is not a guard that failed
  const v = evalStr(g, store, scope);
  if (v === true) return 'holds';
  if (v === undefined) return 'undetermined';
  return 'fails';
}

/**
 * The names a guard reads and this store and scope give no value to.
 *
 * Read off the parsed expression rather than off the evaluator, because the
 * evaluator short-circuits: `false and x` is decided without ever asking about
 * `x`, and a report that named `x` there would send an author to fix a name
 * that decided nothing. Only called where the verdict is already
 * `'undetermined'`, so every name it returns is one that was actually needed.
 * An expression that does not parse names nothing — the guard is unreadable
 * rather than unresolved — and the empty list is the honest answer.
 */
export function unresolvedGuardNames(
  guard: string,
  store: ReadonlyMap<string, unknown>,
  scope: Scope,
): string[] {
  const resolve = storeScope(store, scope);
  let node;
  try {
    node = parseExpr(guard);
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'ref': {
        const name = n.path.join('.');
        if (resolve(name) === undefined && !seen.has(name)) {
          seen.add(name);
          out.push(name);
        }
        return;
      }
      case 'unary':
        walk(n.operand);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'if':
        walk(n.cond);
        walk(n.then);
        walk(n.else);
        return;
      default:
        return;
    }
  };
  walk(node);
  return out;
}

/**
 * A guard holds against the store when absent or evaluating to boolean true.
 *
 * The STEP relation's reading, unchanged: an undetermined guard does not fire.
 * What a report may say about one is {@link guardVerdictStore}'s answer.
 */
export function guardHoldsStore(
  edge: ElementRecord,
  store: ReadonlyMap<string, unknown>,
  scope: Scope,
): boolean {
  return guardVerdictStore(edge, store, scope) === 'holds';
}

/** Read a string-valued attribute, or `undefined`. */
export function strAttr(el: ElementRecord, key: string): string | undefined {
  const v = el.attrs[key];
  return typeof v === 'string' ? v : undefined;
}

/** Compact string form of a store value for trace notes. */
export function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  return String(v);
}

/** Loose truthiness for a boolean-ish attribute value. */
export function isTruthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

/**
 * Apply an AssignmentActionUsage to the store: `store[target] = eval(value)`.
 * The target name comes from `attrs.target` / `attrs.referent` / `attrs.feature`
 * / the declared name; the value expression from `attrs.value` / `attrs.expression`.
 * A parsed `assign x := -1;` stores the literal as a number, so the value is
 * read raw rather than through {@link strAttr}, which would skip it silently.
 */
export function applyAssignment(
  el: ElementRecord,
  store: Map<string, unknown>,
  scope: Scope,
): string | undefined {
  const target =
    strAttr(el, 'target') ?? strAttr(el, 'referent') ?? strAttr(el, 'feature') ?? el.declaredName;
  const raw = el.attrs.value ?? strAttr(el, 'expression');
  if (!target || raw === undefined) return undefined;
  const v = evalStr(raw, store, scope);
  if (v === undefined) return undefined;
  store.set(target, v);
  return `${target} = ${formatValue(v)}`;
}

/** Parse and apply a `name = expr` assignment string to the store. */
export function inlineAssign(text: string, store: Map<string, unknown>, scope: Scope): boolean {
  const idx = text.indexOf('=');
  if (idx <= 0 || text[idx + 1] === '=') return false; // no '=' or an '==' operator
  const lhs = text.slice(0, idx).trim().replace(/:$/, ''); // allow ':=' form
  const rhs = text.slice(idx + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(lhs)) return false;
  const v = evalStr(rhs, store, scope);
  if (v === undefined) return false;
  store.set(lhs, v);
  return true;
}

/** Owner scope merged with the element's own scope (owner takes priority). */
export function combinedScope(model: Model, el: ElementRecord): Scope {
  const own = scopeFor(model, el.id);
  const owner = el.ownerId != null ? scopeFor(model, el.ownerId) : undefined;
  return (name: string) => {
    const v = own(name);
    if (v !== undefined) return v;
    return owner ? owner(name) : undefined;
  };
}

/**
 * The region's scope and transition list, memoised on the model REVISION.
 *
 * `combinedScope` builds a name→feature map by walking every effective feature
 * in scope, and the interpreter pays for it once per region. The explorer asks
 * for it once per step of a walk that may run to ten thousand configurations,
 * which is the same computation ten thousand times over a model that did not
 * change. Keyed on `model.rev` — which the core bumps on every structural
 * change — so an edited model is recomputed rather than answered from a stale
 * cache.
 */
interface RegionCache {
  rev: number;
  scopes: Map<ElementId, Scope>;
  transitions: Map<ElementId, ElementRecord[]>;
}
const REGION_CACHE = new WeakMap<Model, RegionCache>();

function cacheFor(model: Model): RegionCache {
  const hit = REGION_CACHE.get(model);
  if (hit && hit.rev === model.rev) return hit;
  const fresh: RegionCache = { rev: model.rev, scopes: new Map(), transitions: new Map() };
  REGION_CACHE.set(model, fresh);
  return fresh;
}

/** The value scope a region's guards and effects are evaluated in. */
export function regionScope(model: Model, regionId: ElementId): Scope {
  const cache = cacheFor(model);
  const hit = cache.scopes.get(regionId);
  if (hit) return hit;
  const el = model.get(regionId);
  const scope: Scope = el ? combinedScope(model, el) : () => undefined;
  cache.scopes.set(regionId, scope);
  return scope;
}

/**
 * Every step edge inside a region that has both endpoints, in declaration
 * order — which is the order the first-enabled tie-break is taken in.
 *
 * {@link STEP_EDGE_KINDS}, not `TransitionUsage` alone: a succession between
 * two states is the same edge written the other way round, and a relation that
 * held only one of the two spellings made the walk publish absences about the
 * other. Edges whose source is not a state on the active stack — an
 * `InitialNode`'s opening edge, a `do` action's own control flow — are still in
 * this list and inert in it: {@link stepCandidates} offers only what leaves the
 * stack, and `walkableTransitions` (`./explore.ts`) censuses only the same.
 *
 * A PAYLOAD DISQUALIFIES AN EDGE whatever it is spelled as. `payloadOf` is the
 * same reader `itemFlowsOf` uses, so an edge this relation drops for carrying an
 * item is exactly an edge the flow machinery already calls an item flow; the
 * census then accounts for it as one the walk does not follow and the machine is
 * refused rather than walked over a token whose payload nothing here models.
 */
export function regionTransitions(model: Model, regionId: ElementId): readonly ElementRecord[] {
  const cache = cacheFor(model);
  const hit = cache.transitions.get(regionId);
  if (hit) return hit;
  const list = model
    .descendants(regionId)
    .filter(
      (e) =>
        STEP_EDGE_KINDS.has(e.eClass) &&
        e.source?.[0] !== undefined &&
        e.target?.[0] !== undefined &&
        payloadOf(e) === undefined,
    );
  cache.transitions.set(regionId, list);
  return list;
}

/**
 * The literal value of a feature (`attrs.value`), or `undefined` if none/expr.
 */
export function literalValueOf(feat: ElementRecord | undefined): unknown {
  if (!feat) return undefined;
  const raw = feat.attrs.value;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  // A self-contained literal expression (e.g. "5", "true") with no references.
  try {
    const r = evaluate(parseExpr(s), () => undefined);
    return 'value' in r ? r.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Seed the store from literal feature values in the behavior, then overrides.
 *
 * Here rather than in `../execute.ts` because it is the step relation's INITIAL
 * CONDITION: a walk that started from an empty store would evaluate the first
 * guard against a different world than the interpreter does, and the two would
 * diverge on the first `guard: 'ready'` in the corpus.
 */
export function seedStore(
  model: Model,
  behavior: ElementRecord,
  store: Map<string, unknown>,
  initial?: Map<string, unknown> | Record<string, unknown>,
): void {
  for (const f of model.descendants(behavior.id)) {
    if (!isUsage(f.eClass)) continue;
    const name = f.declaredName;
    if (!name || store.has(name)) continue;
    const v = literalValueOf(f);
    if (v !== undefined) store.set(name, v);
  }
  if (initial) {
    const entries = initial instanceof Map ? initial.entries() : Object.entries(initial);
    for (const [k, v] of entries) store.set(k, v);
  }
}

/* ──────────────────── state-machine reading primitives ──────────────────── */

/** A transition matches a fired trigger when its non-empty trigger equals it. */
export function triggerEquals(tr: ElementRecord, trigger: string): boolean {
  const t = tr.attrs.trigger;
  return typeof t === 'string' && t !== '' && t === trigger;
}

/** A completion transition carries no trigger. */
export function isCompletion(tr: ElementRecord): boolean {
  const t = tr.attrs.trigger;
  return t === undefined || t === null || t === '';
}

/** The dwell time of an `after(n)` timed transition, or `undefined`. */
export function afterDuration(tr: ElementRecord): number | undefined {
  const a = tr.attrs.after;
  if (typeof a === 'number') return a;
  const t = tr.attrs.trigger;
  if (typeof t === 'string') {
    const m = /^after\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)$/.exec(t.trim());
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** The trigger label of a transition (empty for completion transitions). */
export function triggerLabelOf(tr: ElementRecord): string {
  const t = tr.attrs.trigger;
  return typeof t === 'string' ? t : '';
}

/** Direct child StateUsages of a container (its states at one nesting level). */
export function directStates(model: Model, containerId: ElementId): ElementRecord[] {
  return model.children(containerId).filter((c) => c.eClass === 'StateUsage');
}

/** Is `el` a history pseudostate (resume-last marker)? */
export function isHistoryPseudostate(el: ElementRecord): boolean {
  return el.attrs.kind === 'history' || el.attrs.pseudostate === 'history';
}

/** A composite state that resumes its last-active substate on re-entry. */
export function isHistoryComposite(model: Model, stateId: ElementId): boolean {
  const s = model.get(stateId);
  if (!s) return false;
  if (s.attrs.history === true || s.attrs.kind === 'history') return true;
  return model.children(stateId).some(isHistoryPseudostate);
}

/** A final/complete state (a region completes when its leaf is final). */
export function isFinalState(model: Model, stateId: ElementId): boolean {
  const s = model.get(stateId);
  if (!s) return false;
  return s.attrs.kind === 'final' || s.attrs.isFinal === true || s.declaredName === 'final';
}

/** Resolve the initial state: an InitialNode's target, else the first StateUsage. */
export function initialState(
  model: Model,
  stateId: ElementId,
  states: ElementRecord[],
  desc: ElementRecord[],
  declIndex: Map<ElementId, number>,
): ElementId | null {
  const initialNode = desc.find((e) => e.eClass === 'InitialNode');
  if (initialNode) {
    const edge = model
      .edgesFrom(initialNode.id)
      .find((e) => SUCCESSION_KINDS.has(e.eClass) || e.eClass === 'TransitionUsage');
    const to = edge?.target?.[0];
    if (to && states.some((s) => s.id === to)) return to;
  }
  if (states.length) {
    return states
      .slice()
      .sort((a, b) => (declIndex.get(a.id) ?? 0) - (declIndex.get(b.id) ?? 0))[0].id;
  }
  return null;
}

/** The initial substate of a container (InitialNode target, else first state). */
export function initialSubstate(model: Model, containerId: ElementId): ElementId | null {
  const states = directStates(model, containerId);
  const desc = model.descendants(containerId);
  const declIndex = new Map<ElementId, number>();
  desc.forEach((e, i) => declIndex.set(e.id, i));
  return initialState(model, containerId, states, desc, declIndex);
}

/** Apply a behavior action's store effect (an assignment or `attrs.effect`). */
export function applyBehaviorEffect(
  el: ElementRecord,
  store: Map<string, unknown>,
  scope: Scope,
): void {
  const effect = strAttr(el, 'effect');
  if (effect !== undefined) inlineAssign(effect, store, scope);
  if (el.eClass === 'AssignmentActionUsage') applyAssignment(el, store, scope);
  else if (strAttr(el, 'target') !== undefined) applyAssignment(el, store, scope);
}

/** Apply a transition's effect (an `attrs.effect` assignment) to the store. */
export function applyTransitionEffect(
  tr: ElementRecord,
  store: Map<string, unknown>,
  scope: Scope,
): void {
  const effect = strAttr(tr, 'effect');
  if (effect !== undefined) inlineAssign(effect, store, scope);
}

/** Record and apply every behavior of a given phase (entry/do/exit). */
export function runStatePhase(
  model: Model,
  stateId: ElementId,
  phase: 'entry' | 'do' | 'exit',
  store: Map<string, unknown>,
  scope: Scope,
  performed: PerformedAction[],
): void {
  for (const a of model.children(stateId)) {
    if (a.attrs.stateSubaction !== phase) continue;
    performed.push({ stateId, phase, actionId: a.id, name: a.declaredName ?? '' });
    applyBehaviorEffect(a, store, scope);
  }
}

/* ──────────────────────────── the configuration ─────────────────────────── */

/** The default completion-chase budget, and the profile's `maxCompletion`. */
export const MAX_COMPLETION = 64;

/**
 * One configuration of a single region: everything the next step depends on.
 *
 * `stack` is the active state stack, outer→inner, so `stack[stack.length - 1]`
 * is the active leaf. `entryTime` is what an `after(n)` dwell is measured
 * against, and `history` is the shallow last-active-substate map a composite
 * state resumes through. Every field is read-only because a configuration is a
 * VALUE: the explorer keeps thousands of them alive at once and a shared
 * mutable store between two of them would silently merge two futures.
 */
export interface MachineConfig {
  /** The region this configuration belongs to (its transitions and scope). */
  readonly regionId: ElementId;
  /** Active state stack, outer→inner. Empty for a region with no initial state. */
  readonly stack: readonly ElementId[];
  /** The value store (feature name → value). */
  readonly store: ReadonlyMap<string, unknown>;
  /** The discrete clock. Advanced only by {@link advanceClock}. */
  readonly clock: number;
  /** Clock reading at which each state on the stack was entered. */
  readonly entryTime: ReadonlyMap<ElementId, number>;
  /** Composite parent → its last-active substate. */
  readonly history: ReadonlyMap<ElementId, ElementId>;
}

/** What is being offered to the machine when asking what is enabled. */
export type StepInput =
  /** Nothing is offered: only trigger-less (completion) transitions are enabled. */
  | { readonly kind: 'completion' }
  /** A named event, matched by {@link triggerEquals} (an exact string match). */
  | { readonly kind: 'trigger'; readonly trigger: string }
  /** The clock as it stands: `after(n)` transitions whose dwell is met. */
  | { readonly kind: 'timeout' };

/** One enabled transition, with the stack level it leaves and the label it fires under. */
export interface EnabledTransition {
  readonly transition: ElementRecord;
  /** Index in `config.stack` of the state the transition leaves. */
  readonly level: number;
  /** The label recorded on the fire — `''` for a completion transition. */
  readonly label: string;
}

/** What a step appended to the run: the interpreter's three output arrays. */
export interface StepEffects {
  readonly visited: readonly ElementId[];
  readonly fired: readonly StateFire[];
  readonly performed: readonly PerformedAction[];
}

/** A new configuration and what producing it appended to the run. */
export interface StepResult {
  readonly config: MachineConfig;
  readonly effects: StepEffects;
}

/** The mutable working copy a step is computed on, before it is frozen. */
interface Draft {
  stack: ElementId[];
  store: Map<string, unknown>;
  clock: number;
  entryTime: Map<ElementId, number>;
  history: Map<ElementId, ElementId>;
  visited: ElementId[];
  fired: StateFire[];
  performed: PerformedAction[];
}

function draftOf(cfg: MachineConfig): Draft {
  return {
    stack: [...cfg.stack],
    store: new Map(cfg.store),
    clock: cfg.clock,
    entryTime: new Map(cfg.entryTime),
    history: new Map(cfg.history),
    visited: [],
    fired: [],
    performed: [],
  };
}

function freeze(regionId: ElementId, d: Draft): StepResult {
  return {
    config: {
      regionId,
      stack: d.stack,
      store: d.store,
      clock: d.clock,
      entryTime: d.entryTime,
      history: d.history,
    },
    effects: { visited: d.visited, fired: d.fired, performed: d.performed },
  };
}

/**
 * Enter a state, cascading into its initial (or history-resumed) substate;
 * entry/do phases fire outer→inner. The interpreter's `enterCascade`.
 */
function enterCascade(model: Model, d: Draft, scope: Scope, stateId: ElementId): void {
  d.stack.push(stateId);
  d.entryTime.set(stateId, d.clock);
  d.visited.push(stateId);
  runStatePhase(model, stateId, 'entry', d.store, scope, d.performed);
  runStatePhase(model, stateId, 'do', d.store, scope, d.performed);
  const subs = directStates(model, stateId);
  if (subs.length === 0) return;
  let next: ElementId | null;
  const resumed = d.history.get(stateId);
  if (isHistoryComposite(model, stateId) && resumed !== undefined && subs.some((s) => s.id === resumed)) {
    next = resumed;
  } else {
    next = initialSubstate(model, stateId);
  }
  if (next) enterCascade(model, d, scope, next);
}

/**
 * Exit states from the leaf down to (but not below) `targetLen`; exit phases
 * fire inner→outer, and each composite parent records its last-active child.
 * The interpreter's `exitTo`.
 */
function exitTo(model: Model, d: Draft, scope: Scope, targetLen: number): void {
  while (d.stack.length > targetLen) {
    const leaf = d.stack.pop()!;
    runStatePhase(model, leaf, 'exit', d.store, scope, d.performed);
    const parent = d.stack[d.stack.length - 1];
    if (parent !== undefined) d.history.set(parent, leaf);
  }
}

/**
 * The region's opening configuration: enter the initial state and cascade into
 * it. NOT chased to quiescence — the completion chase is a sequence of steps
 * through {@link enabledTransitions}, and a caller that hid it inside the entry
 * would have a first configuration no `stepConfig` could have produced.
 *
 * A region with no state at all comes back with an empty `stack`, which is what
 * the interpreter reports as `leaf: null`.
 */
export function initialConfig(
  model: Model,
  regionId: ElementId,
  seed: {
    store?: ReadonlyMap<string, unknown>;
    clock?: number;
    history?: ReadonlyMap<ElementId, ElementId>;
  } = {},
): StepResult {
  const scope = regionScope(model, regionId);
  const d: Draft = {
    stack: [],
    store: new Map(seed.store ?? []),
    clock: seed.clock ?? 0,
    entryTime: new Map(),
    history: new Map(seed.history ?? []),
    visited: [],
    fired: [],
    performed: [],
  };
  const init = initialSubstate(model, regionId);
  if (init !== null) enterCascade(model, d, scope, init);
  return freeze(regionId, d);
}

/**
 * Push the clock forward. A pure sibling of the interpreter's
 * `clockRef.clock += Math.max(0, step.advance)`, kept out of
 * {@link stepConfig} because advancing time fires nothing on its own: what it
 * does is make `after(n)` transitions enabled, which the caller then asks for
 * with a `timeout` input.
 */
export function advanceClock(cfg: MachineConfig, advance: number): MachineConfig {
  return { ...cfg, clock: cfg.clock + Math.max(0, advance) };
}

/**
 * Every transition enabled in `cfg` under `input`, INNERMOST STATE FIRST and,
 * within one state, in declaration order.
 *
 * The order is the contract: `[0]` is the transition the interpreter fires, so
 * a caller that takes the head reproduces the simulation exactly and a caller
 * that takes the tail is exploring a branch the simulator silently discarded.
 * That is the whole reason this function returns a list rather than an option —
 * `verification/nondeterministic-choice` is `length > 1`.
 */
export function enabledTransitions(
  model: Model,
  cfg: MachineConfig,
  input: StepInput,
): EnabledTransition[] {
  // `resolveNames` left off: this is the interpreter's and the property
  // search's hot path — `checkProperty` calls it once per configuration per
  // input, up to `maxConfigs` times — and resolving the names of a guard whose
  // row nobody keeps re-parsed the expression and walked its AST at every one
  // of them. Measured at ~2.5x on a configuration with an undetermined guard.
  return stepCandidates(model, cfg, input).enabled;
}

/** A transition whose guard was offered at a configuration and decided nothing. */
export interface UndeterminedGuard {
  transition: ElementRecord;
  /** The guard text, as written. */
  guard: string;
  /**
   * Its level on the active stack, outer 0 → innermost last, and load-bearing
   * rather than decoration. An undetermined guard STRICTLY INNER of the
   * innermost level that was enabled may have been the transition the priority
   * rule would have picked, so the enabled set at the outer level is one this
   * walk saw only because an inner edge was withheld — see the
   * nondeterminism note in `./explore.ts`.
   */
  level: number;
  /**
   * The names it reads that nothing here gives a value to.
   *
   * EMPTY where the caller did not ask for them ({@link stepCandidates}'s
   * `resolveNames`), and empty where the guard yielded no value for a reason
   * that is not a missing name at all — a type error inside it. The two are
   * told apart by who is asking: only the walk asks, and it always asks.
   */
  unresolved: readonly string[];
}

/** What one offered input found: what fires, and what could not be decided. */
export interface StepCandidates {
  enabled: EnabledTransition[];
  undetermined: UndeterminedGuard[];
}

/**
 * {@link enabledTransitions}, and beside it the guards that decided nothing.
 *
 * ONE traversal and ONE {@link matches}, deliberately. The undetermined set has
 * to be read at exactly the configurations and inputs the walk actually offered
 * — a second pass over the transitions would be a second reading of when a
 * guard is consulted, and this module exists because a second reading of the
 * step relation drifts from the first. So the walk asks for both at once and
 * the interpreter keeps asking for the half it uses.
 *
 * `resolveNames` is a COST switch and not a second reading: which transitions
 * are undetermined is decided identically either way, and the flag only says
 * whether to spend a parse and an AST walk naming what each one could not read.
 * The walk wants the names (they are the whole content of the row an author
 * acts on); {@link enabledTransitions} throws the rows away and must not pay
 * for them.
 */
export function stepCandidates(
  model: Model,
  cfg: MachineConfig,
  input: StepInput,
  resolveNames = false,
): StepCandidates {
  const scope = regionScope(model, cfg.regionId);
  const all = regionTransitions(model, cfg.regionId);
  const enabled: EnabledTransition[] = [];
  const undetermined: UndeterminedGuard[] = [];
  for (let level = cfg.stack.length - 1; level >= 0; level--) {
    const sid = cfg.stack[level];
    for (const tr of all) {
      if (tr.source![0] !== sid) continue;
      const verdict = matches(model, cfg, tr, sid, input, scope);
      if (verdict === 'enabled') {
        enabled.push({ transition: tr, level, label: labelFor(tr, input) });
      } else if (verdict === 'undetermined') {
        const guard = guardTextOf(tr)!;
        undetermined.push({
          transition: tr,
          guard,
          level,
          unresolved: resolveNames ? unresolvedGuardNames(guard, cfg.store, scope) : [],
        });
      }
    }
  }
  return { enabled, undetermined };
}

/**
 * Does one transition match the offered input, guard included?
 *
 * `'disabled'` covers everything that is not about the guard — the wrong
 * trigger, a completion transition offered a trigger, a dwell not yet elapsed —
 * because none of those is a question this walk failed to answer. Only a guard
 * it could not evaluate is `'undetermined'`.
 */
function matches(
  model: Model,
  cfg: MachineConfig,
  tr: ElementRecord,
  sid: ElementId,
  input: StepInput,
  scope: Scope,
): 'enabled' | 'disabled' | 'undetermined' {
  if (input.kind === 'trigger') {
    if (!triggerEquals(tr, input.trigger)) return 'disabled';
  } else if (input.kind === 'completion') {
    if (!isCompletion(tr)) return 'disabled';
  } else {
    const n = afterDuration(tr);
    if (n === undefined) return 'disabled';
    if (cfg.clock - (cfg.entryTime.get(sid) ?? 0) < n) return 'disabled';
  }
  const verdict = guardVerdictStore(tr, cfg.store, scope);
  return verdict === 'holds' ? 'enabled' : verdict === 'fails' ? 'disabled' : 'undetermined';
}

/**
 * The label a fire is recorded under.
 *
 * A completion transition fires under `''` and a triggered one under the
 * trigger that was offered — never under a label invented for the report. A
 * timed transition is recorded under the label it carries (`after(5)`), which
 * is what the interpreter's `triggerLabelOf` writes.
 */
function labelFor(tr: ElementRecord, input: StepInput): string {
  if (input.kind === 'trigger') return input.trigger;
  if (input.kind === 'completion') return '';
  return triggerLabelOf(tr);
}

/**
 * Fire ONE transition and return the configuration it leads to, plus what the
 * firing appended to the run.
 *
 * `choice` must have come from {@link enabledTransitions} on THIS configuration:
 * the level it names is the stack index the exit cascade unwinds to, and a
 * choice from another configuration would exit the wrong states. A mismatch is
 * a programming error and is raised as one rather than silently firing
 * something else.
 *
 * The argument is never mutated: the stack, the store, the entry-time table and
 * the history map are all copied first.
 */
export function stepConfig(
  model: Model,
  cfg: MachineConfig,
  choice: EnabledTransition,
): StepResult {
  if (choice.level < 0 || choice.level >= cfg.stack.length) {
    throw new Error(
      `stepConfig: level ${choice.level} is not a state of this configuration (stack of ${cfg.stack.length})`,
    );
  }
  const from = choice.transition.source![0];
  if (from !== cfg.stack[choice.level]) {
    throw new Error(
      'stepConfig: the choice leaves a state this configuration is not in — it came from another configuration',
    );
  }
  const scope = regionScope(model, cfg.regionId);
  const d = draftOf(cfg);
  exitTo(model, d, scope, choice.level); // exit leaf..source inclusive (source sits at `level`)
  applyTransitionEffect(choice.transition, d.store, scope);
  const to = choice.transition.target![0];
  d.fired.push({ transitionId: choice.transition.id, from, to, trigger: choice.label });
  enterCascade(model, d, scope, to);
  return freeze(cfg.regionId, d);
}

/**
 * A process-local key for a configuration: two configurations with the same
 * hash have the same successors.
 *
 * NOT a digest anybody may publish. Element ids are fresh UUIDs on every load
 * (plan §1.1 D3), so this string is stable only inside one process — it is the
 * explorer's visited-set key and nothing else. Evidence digests canonicalise by
 * qualified name; this deliberately does not, because the walk that uses it
 * runs millions of times and a qualified-name lookup per state per step is the
 * explorer's whole budget.
 *
 * The history map is part of the key even though most machines never read it:
 * merging two configurations that resume DIFFERENT substates would under-report
 * what is reachable, and an over-fine key only costs configurations.
 */
export function hashConfig(cfg: MachineConfig): string {
  const store = [...cfg.store.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${JSON.stringify(v) ?? 'undefined'}`)
    .join(',');
  const history = [...cfg.history.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}>${v}`)
    .join(',');
  // Dwell rather than absolute entry time, and the absolute clock is NOT in the
  // key: what an `after(n)` transition reads is `clock - entryTime`, and no
  // guard can read the clock at all, so two configurations that differ only in
  // when the whole run started have the same successors and are one
  // configuration. Keeping the reading would cost nothing today — nothing in
  // `./explore.ts` calls {@link advanceClock} — and would make the visited set
  // over-fine, and the walk non-terminating, for the first caller that advances
  // it, which is what a timed `check-behaviour` is.
  const dwell = cfg.stack.map((s) => `${s}@${cfg.clock - (cfg.entryTime.get(s) ?? 0)}`).join('/');
  return `${cfg.regionId}|${cfg.stack.join('/')}|${dwell}|${store}|${history}`;
}

/** The active leaf of a configuration, or `null` for an empty region. */
export function leafOf(cfg: MachineConfig): ElementId | null {
  return cfg.stack.length > 0 ? cfg.stack[cfg.stack.length - 1] : null;
}

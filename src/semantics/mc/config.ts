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

import { type ElementId, type ElementRecord, type Model, isUsage, unquoteName } from '@core/index';
import { parseExpr, evaluate, readQuotedName, type ExprNode } from '../expr';
import { namesReadIn } from '../relations';
import { scopeFor, type Scope } from '../evaluate-model';
import { dim, dimEqual, unitByName, unitBySymbol } from '../units';
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
  const target = unquoteName(
    strAttr(el, 'target') ?? strAttr(el, 'referent') ?? strAttr(el, 'feature') ?? el.declaredName,
  );
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
  // The target is a plain identifier or ONE single-quoted unrestricted name (`'max load' = 5`).
  let target = lhs;
  if (lhs.startsWith("'")) {
    try {
      const q = readQuotedName(lhs, 0);
      if (q.end !== lhs.length) return false;
      target = q.name;
    } catch {
      return false;
    }
  } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(lhs)) return false;
  const v = evalStr(rhs, store, scope);
  if (v === undefined) return false;
  store.set(target, v);
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
 * The region's scope and its {@link MachineRegion}, memoised on the model
 * REVISION.
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
  regions: Map<ElementId, MachineRegion>;
  /** The regions read through their generals ({@link machineRegion} with `inherit`). */
  inherited: Map<ElementId, MachineRegion>;
  /** A redefining state → the state it redefines, when that holds members the redefining state inherits ({@link mergedFrom}). */
  merged: Map<ElementId, ElementRecord | null>;
  /** A machine's dwell reading ({@link dwellReading}), by its outermost state. */
  dwells: Map<ElementId, Map<ElementId, number | string>>;
}
const REGION_CACHE = new WeakMap<Model, RegionCache>();

function cacheFor(model: Model): RegionCache {
  const hit = REGION_CACHE.get(model);
  if (hit && hit.rev === model.rev) return hit;
  const fresh: RegionCache = { rev: model.rev, scopes: new Map(), regions: new Map(), inherited: new Map(), merged: new Map(), dwells: new Map() };
  REGION_CACHE.set(model, fresh);
  return fresh;
}

/** The value scope a region's guards and effects are evaluated in. */
export function regionScope(model: Model, regionId: ElementId): Scope {
  const cache = cacheFor(model);
  const hit = cache.scopes.get(regionId);
  if (hit) return hit;
  const el = model.get(regionId);
  const own: Scope = el ? combinedScope(model, el) : () => undefined;
  // A STATE read as a region (a region of a parallel state, a composite opened on its own) sees the features of the
  // states and the machine that hold it, as a guard written in it does (SysML v2 name resolution is lexical); the
  // owner's scope is the fallback, so a name the state itself declares still wins.
  const outer = el && el.eClass === 'StateUsage' && el.ownerId != null ? regionScope(model, el.ownerId) : undefined;
  const scope: Scope = outer ? (name: string) => own(name) ?? outer(name) : own;
  cache.scopes.set(regionId, scope);
  return scope;
}

/**
 * THE REGION OF A MACHINE, read once: the elements it is made of, the step edges
 * between them, and who is whose parent there.
 *
 * ONE VIEW, so the walk and the interpreter cannot read two regions. Until it
 * existed every reader of "what is in this machine" asked `model.descendants`
 * or `model.children` for itself, each with its own idea of where the machine
 * stops; the boundary at a nested `state def` is drawn once, in
 * {@link machineRegion}, and `regionDescendants`, `regionTransitions`,
 * `hierarchyPath`, `isRegionNode` and `initialSubstate` all read it through here. It is
 * memoised on the model revision (`cacheFor`), so a walk that asks ten thousand
 * times is answered from one build.
 *
 * `root` is the machine, or a composite state read as a region of its own
 * (`initialSubstate`). A machine specialising another one is not yet read
 * through its general: `bases` is empty and `inheritedFrom` answers nothing,
 * and with them empty the view is the lists the readers computed before it.
 * `refused` is set where the machine specialises something this walk does not
 * read, and the view is then the machine's own.
 */
export interface MachineRegion {
  readonly root: ElementId;
  /** The general machines whose region this one extends, nearest first. Empty unless a machine is read through its general. */
  readonly bases: readonly ElementId[];
  /** The ids of the elements a step may stand in or leave: `root` and every descendant that is not a nested `state def`. */
  readonly nodes: ReadonlySet<ElementId>;
  /** `model.descendants(root)` in declaration order, stopping BELOW a nested `state def` (which is itself in it). */
  readonly descendants: readonly ElementRecord[];
  /** Every step edge of the region that has both endpoints and no payload, in declaration order. */
  readonly transitions: readonly ElementRecord[];
  /** The `StateUsage`s written directly in `containerId`. */
  directStates(containerId: ElementId): readonly ElementRecord[];
  /** The owner of `id` within the region, or `null` for the root and for anything the region does not hold. */
  parentOf(id: ElementId): ElementId | null;
  /** The general machine that `id` was read from, if the region took it from one. */
  inheritedFrom(id: ElementId): ElementId | undefined;
  /** The steps a general machine writes that this region replaces with a redefining step of its own: not steps of it, and no crossing of its boundary. */
  readonly superseded?: ReadonlySet<ElementId>;
  /** Set when the region is one this walk does not read, with the sentence that says so. */
  readonly refused?: {
    why: 'redefined' | 'two-generals' | 'two-starts' | 'cycle';
    at: ElementId;
    sentence: string;
  };
}

/**
 * The region rooted at `regionId`, memoised on the model revision.
 *
 * A machine is read through its general machine ({@link inheritedRegion}), so
 * the walk and the interpreter see the one view; `inherit = false` reads only
 * what the machine itself holds, which is what a machine that is not read
 * through its general (a refused one, a nested state) falls back to.
 */
export function machineRegion(model: Model, regionId: ElementId, inherit = true): MachineRegion {
  return inherit ? inheritedRegion(model, regionId, []) : ownRegion(model, regionId);
}

function ownRegion(model: Model, regionId: ElementId): MachineRegion {
  const cache = cacheFor(model);
  const hit = cache.regions.get(regionId);
  if (hit) return hit;
  // The elements a region is made of: its descendants, but STOPPING at a nested
  // `state def`.
  //
  // A `state def` written inside another state machine is a machine of its own
  // (`stateMachinesIn`, `./explore.ts`), not a composite region of its parent: its
  // states and its transitions are the nested definition's, and the outer walk
  // neither reaches nor reports them. Descending into it here was how the outer
  // machine came to publish the nested definition's states `unreachable` and its
  // transitions `dead` — absences about a machine nobody walked — so the boundary
  // is drawn once, here, and every machine-scoped traversal reads it.
  //
  // The interpreter's flat path (`runRegion`, `../execute.ts`) reads it too, for
  // its start state as well as its transitions. It used to take its states and
  // its `initial` node from every descendant, so a nested definition declared
  // before the outer machine's own gave the simulator a start the walk never had.
  //
  // A composite state USAGE that owns transitions is unaffected: it is a region of
  // its parent and stays inside it, which is the distinction the metaclass draws
  // (`StateDefinition` vs `StateUsage`).
  //
  // It stops below an entry, do or exit action as well (`do action d { state z; }`): what such an action holds is the
  // action's own behaviour, performed while its state is active, and not a state of this machine. Read as one, `z`
  // was published unreachable by the walk and taken as the start by the simulator's flat path.
  const within = (top: ElementId) => (el: ElementRecord): boolean => {
    for (let p: ElementId | null = el.ownerId; p != null && p !== top; p = model.get(p)?.ownerId ?? null) {
      const owner = model.get(p);
      if (owner?.eClass === 'StateDefinition' || owner?.attrs.stateSubaction !== undefined) return false;
    }
    return true;
  };
  // A state that redefines one holding substates and steps holds them too, before its own (T-115, {@link mergedFrom}).
  const merged = mergedFrom(model, regionId);
  const descendants = [
    ...(merged === undefined ? [] : model.descendants(merged.id).filter(within(merged.id))),
    ...model.descendants(regionId).filter(within(regionId)),
  ];
  // The nested definition itself is IN `descendants` (the boundary stops below
  // it) and is not a node: it is a machine of its own, or a definition no walk
  // enters. The machine is a node of its own region.
  const held = new Set<ElementId>(descendants.map((e) => e.id));
  const nodes = new Set<ElementId>([regionId]);
  for (const el of descendants) if (el.eClass !== 'StateDefinition') nodes.add(el.id);
  // Every step edge inside a region that has both endpoints, in declaration
  // order — which is the order the first-enabled tie-break is taken in.
  //
  // {@link STEP_EDGE_KINDS}, not `TransitionUsage` alone: a succession between
  // two states is the same edge written the other way round, and a relation that
  // held only one of the two spellings made the walk publish absences about the
  // other. Edges whose source is not a state on the active stack — an
  // `InitialNode`'s opening edge, a `do` action's own control flow — are still in
  // this list and inert in it: {@link stepCandidates} offers only what leaves the
  // stack, and `walkableTransitions` (`./explore.ts`) censuses only the same.
  //
  // A PAYLOAD DISQUALIFIES AN EDGE whatever it is spelled as. `payloadOf` is the
  // same reader `itemFlowsOf` uses, so an edge this relation drops for carrying an
  // item is exactly an edge the flow machinery already calls an item flow; the
  // census then accounts for it as one the walk does not follow and the machine is
  // refused rather than walked over a token whose payload nothing here models.
  const transitions = descendants.filter(
    (e) =>
      STEP_EDGE_KINDS.has(e.eClass) &&
      e.source?.[0] !== undefined &&
      e.target?.[0] !== undefined &&
      payloadOf(e) === undefined,
  );
  const region: MachineRegion = {
    root: regionId,
    bases: [],
    nodes,
    descendants,
    transitions,
    directStates: (containerId) => directStates(model, containerId),
    parentOf: (id) => (held.has(id) ? (model.get(id)?.ownerId === merged?.id ? regionId : (model.get(id)?.ownerId ?? null)) : null),
    inheritedFrom: () => undefined,
  };
  cache.regions.set(regionId, region);
  return region;
}

/** A usage that is a machine of its own, not a composite state inside another machine. */
function isMachineRoot(model: Model, m: ElementRecord): boolean {
  for (let p: ElementId | null | undefined = m.ownerId; p != null; p = model.get(p)?.ownerId) {
    const o = model.get(p);
    if (o && o.attrs.isLibrary !== true && model.children(p).some((c) => c.eClass === 'TransitionUsage')) return false;
  }
  return true;
}

/**
 * Can a state `s` that a state redefines be merged into the redefining state? A redefining usage is a subsetting
 * usage and so inherits the features of what it redefines (SysML v2 Part 1 §7.6: "a redefining usage replaces the
 * redefined usage"; a subsetting usage "inherit[s] the features and structure" of the subsetted one). This view merges
 * only what it can read whole: `s` holds nothing but substates and steps between them (no entry, do, exit, attribute,
 * start or history marker, modifier or redefinition of its own).
 */
function mergeableBody(model: Model, s: ElementRecord): boolean {
  if (s.eClass !== 'StateUsage' || Object.keys(s.attrs).length > 0) return false;
  const kids = model.children(s.id);
  if (kids.length === 0) return false;
  if (!kids.every((c) => c.eClass === 'StateUsage' || c.eClass === 'TransitionUsage')) return false;
  return !model.descendants(s.id).some((d) => d.eClass === 'Redefinition');
}

/** The state `id` redefines, when {@link mergeableBody} says its members are the redefining state's too. */
function mergedFrom(model: Model, id: ElementId): ElementRecord | undefined {
  const cache = cacheFor(model);
  const hit = cache.merged.get(id);
  if (hit !== undefined) return hit ?? undefined;
  let out: ElementRecord | null = null;
  if (model.get(id)?.eClass === 'StateUsage') {
    const rels = model.relationshipsFrom(id).filter((r) => r.eClass === 'Redefinition');
    const to = rels.length === 1 ? rels[0].target?.[0] : undefined;
    const s = to === undefined ? undefined : model.get(to);
    if (s !== undefined && mergeableBody(model, s)) out = s;
  }
  cache.merged.set(id, out);
  return out ?? undefined;
}

/**
 * The machine usage `id` redefines, when `id` is a machine usage (not a state def) with exactly one redefinition whose
 * target is a non-library machine usage outside `id`. Undefined for anything else (a subsetting, two redefinitions, a
 * target that is a definition, a nested state of a machine: those keep the readings they had).
 */
function redefinedMachineUsage(model: Model, id: ElementId): ElementRecord | undefined {
  const m = model.get(id);
  if (m === undefined || (m.eClass !== 'StateUsage' && m.eClass !== 'ExhibitStateUsage')) return undefined;
  const rels = model.relationshipsFrom(id).filter((r) => r.eClass === 'Redefinition');
  const to = rels.length === 1 ? rels[0].target?.[0] : undefined;
  const t = to === undefined ? undefined : model.get(to);
  if (t === undefined || t.id === id || (t.eClass !== 'StateUsage' && t.eClass !== 'ExhibitStateUsage') || t.attrs.isLibrary === true) return undefined;
  for (let p: ElementId | null | undefined = t.ownerId; p != null; p = model.get(p)?.ownerId) if (p === id) return undefined;
  return t;
}

/** The longest chain of general machines read through; a longer one is refused as a `cycle`. */
const MAX_GENERAL_CHAIN = 8;

/**
 * A machine read through its general machine: the general's region (ids kept)
 * followed by the machine's own nodes and steps.
 *
 * The generals are the non-library `state def`s the machine specialises, or
 * that type a usage which owns a step of its own (a usage with no step is
 * reported through its definition and reads no general). Two or more are read
 * in declaration order when they share no id or declared name. `parentOf` a
 * general's root is the machine, `inheritedFrom` names the general for every
 * node it declares, `descendants` and `transitions` list the generals' first
 * (the first-enabled tie-break takes the inherited step before an own one),
 * `directStates` of the machine lists the inherited states before its own,
 * and the one start is the one `InitialNode` of the merged list. A redefinition
 * is read where it stands for what it redefines whole (T-115): `state :>> s;`
 * is `s`, a named `state r :>> s { … }` over an `s` with nothing of its own is
 * `r` in its place (the generals' steps over `s` read `r`), a transition that
 * redefines an inherited one replaces it. Where the shape is not one this view
 * reads, `refused` says which and the region is the machine's own: two
 * generals sharing a name, two starts, a cycle or a chain over
 * {@link MAX_GENERAL_CHAIN}, any other redefinition, or an own usage that takes
 * a name the general already holds.
 */
function inheritedRegion(model: Model, id: ElementId, chain: readonly ElementId[]): MachineRegion {
  const cache = cacheFor(model);
  const hit = cache.inherited.get(id);
  if (hit) return hit;
  const own = ownRegion(model, id);
  const m = model.get(id);
  const name = (e: ElementId): string => model.qualifiedName(e);
  const refuse = (why: NonNullable<MachineRegion['refused']>['why'], at: ElementId, sentence: string): MachineRegion => {
    const r: MachineRegion = { ...own, refused: { why, at, sentence } };
    if (chain.length === 0) cache.inherited.set(id, r);
    return r;
  };
  const generals: ElementRecord[] =
    m === undefined || (m.eClass !== 'StateDefinition' && m.eClass !== 'StateUsage' && m.eClass !== 'ExhibitStateUsage')
      ? []
      : model.typesOf(id).filter((g) => g.eClass === 'StateDefinition' && g.attrs.isLibrary !== true);
  // A machine USAGE that redefines another machine usage (`exhibit state s :>> Eng::s` in `Eng2 :> Eng`) is read
  // through the usage it redefines, like a `state def` through its general (Part 1 §7.13: a redefining usage
  // replaces the redefined one and keeps its members; the redefined usage is not an ancestor of this one).
  // (A state whose body `ownRegion` already merges from the state it redefines, {@link mergedFrom}, is not read twice.)
  const redefined = mergedFrom(model, id) === undefined ? redefinedMachineUsage(model, id) : undefined;
  if (redefined !== undefined && !generals.some((g) => g.id === redefined.id)) generals.push(redefined);
  const reads =
    generals.length > 0 &&
    (m!.eClass === 'StateDefinition' || ((own.transitions.length > 0 || redefined !== undefined) && isMachineRoot(model, m!)));
  if (!reads) {
    cache.inherited.set(id, own);
    return own;
  }
  // Every general is read through ITS own general (a cycle, or a chain too long, refuses the machine).
  const parts: Array<{ g: ElementId; b: MachineRegion; ids: Set<ElementId> }> = [];
  for (const gr of generals) {
    const g = gr.id;
    if (g === id || chain.includes(g)) {
      return refuse('cycle', id, `${name(id)} specialises a chain of general machines this walk does not read (a cycle, or longer than ${MAX_GENERAL_CHAIN})`);
    }
    const b = inheritedRegion(model, g, [...chain, id]);
    if (b.refused) return refuse(b.refused.why, b.refused.at, b.refused.sentence);
    // The chain is measured on the general's own view, which a cached answer carries, not on the path this call came down.
    if (b.bases.length >= MAX_GENERAL_CHAIN) {
      return refuse('cycle', id, `${name(id)} specialises a chain of general machines this walk does not read (a cycle, or longer than ${MAX_GENERAL_CHAIN})`);
    }
    parts.push({ g, b, ids: new Set<ElementId>([g, ...b.descendants.map((e) => e.id)]) });
  }
  // Two general machines are read one after the other, in declaration order, only when they share nothing and
  // declare no name twice: a state or step both hold under one name has no single meaning here.
  if (parts.length > 1) {
    const seenIds = new Set<ElementId>();
    const seenNames = new Map<string, ElementId>();
    for (const p of parts) {
      for (const x of p.ids) {
        if (seenIds.has(x)) {
          return refuse('two-generals', id, `${name(id)} has two general machines (${parts.map((q) => name(q.g)).join(' and ')}) that share ${name(x)}`);
        }
        seenIds.add(x);
      }
      for (const e of p.b.descendants) {
        if (!isUsage(e.eClass) || !e.declaredName) continue;
        const other = seenNames.get(e.declaredName);
        if (other !== undefined && !p.ids.has(other)) {
          return refuse('two-generals', id, `${name(id)} has two general machines (${parts.map((q) => name(q.g)).join(' and ')}) that both declare \`${e.declaredName}\``);
        }
        seenNames.set(e.declaredName, e.id);
      }
    }
  }
  const gids = parts.map((p) => p.g);
  const baseDesc = parts.flatMap((p) => p.b.descendants);
  const baseTrans = parts.flatMap((p) => p.b.transitions);
  const baseTransIds = new Set(baseTrans.map((t) => t.id));
  const rootStates = parts.flatMap((p) => p.b.directStates(p.g));
  const baseStates = new Set(rootStates.map((x) => x.id));
  const rootOwners = new Set<ElementId>(parts.flatMap((p) => [p.g, ...p.b.bases]));
  // What the machine redefines. SysML v2 gives a redefinition of an inherited member a meaning only where the
  // redefining one can stand for it whole, so each form is read where that is so and refused (`redefined`) otherwise:
  //  - `state :>> s;` (no body) is the state it redefines: a step that names it resolves to `s`;
  //  - `state r :>> s { … }` over an `s` that holds nothing of its own (no substate, entry, do or exit, no attribute)
  //    is `r` in the place of `s`: nothing of `s` is left to merge, so its replacement and its redefinition agree, and
  //    the steps the general writes over `s` read `r`. Over an `s` that holds something, the redefinition would inherit
  //    that and merge it with its own, which this view does not do;
  //  - a transition `t2 :>> t1` (the API only: the grammar has no redefining transition) replaces `t1` when it has both
  //    ends and states every attribute `t1` carries (trigger, guard, effect), with no payload or body on either.
  const alias = new Map<ElementId, ElementId>(); // `state :>> s;` → s
  const replaced = new Map<ElementId, ElementId>(); // s → the redefining state that holds a body
  const replacedTr = new Map<ElementId, ElementId>(); // t1 → t2
  const droppedOwn = new Set<ElementId>();
  const sentenceAt = (e: ElementRecord, why: string): string => `${name(e.id)} redefines a member of a general machine${why ? `: ${why}` : ''}`;
  for (const e of own.descendants) {
    const rels = model.relationshipsFrom(e.id).filter((r) => r.eClass === 'Redefinition');
    if (rels.length === 0) continue;
    const to = rels[0].target?.[0];
    if (e.ownerId !== id || rels.length !== 1 || to === undefined) return refuse('redefined', e.id, sentenceAt(e, 'not a direct member written in the machine, or redefining two'));
    const kids = model.children(e.id).filter((c) => c.eClass !== 'Redefinition');
    if (e.eClass === 'StateUsage' && baseStates.has(to)) {
      if (Object.keys(e.attrs).length > 0) return refuse('redefined', e.id, sentenceAt(e, 'it carries a modifier'));
      if (replaced.has(to) || (kids.length > 0 && [...alias.values()].includes(to))) return refuse('redefined', e.id, sentenceAt(e, 'the state is redefined twice'));
      if (kids.length === 0) {
        alias.set(e.id, to);
        droppedOwn.add(e.id);
      } else {
        const sEl = model.get(to)!;
        if (e.declaredName === undefined) return refuse('redefined', e.id, sentenceAt(e, 'a redefining state with a body must be named'));
        if (model.children(to).some((c) => c.eClass !== 'Redefinition') || Object.keys(sEl.attrs).length > 0) {
          // The redefining state inherits what the redefined one holds (Part 1 §7.6), merged with its own body. Read
          // when that is substates and steps only and no name is held twice; anything else is not read.
          if (!mergeableBody(model, sEl) || mergedFrom(model, e.id)?.id !== to) {
            return refuse('redefined', e.id, sentenceAt(e, `${name(to)} holds ${Object.keys(sEl.attrs).length > 0 ? 'a modifier' : 'something other than substates and steps between them (an entry, do or exit action, an attribute, a start, or a redefinition)'} that the redefinition inherits and this view does not merge`));
          }
          const held = new Set(model.children(to).filter((c) => c.declaredName !== undefined).map((c) => c.declaredName));
          const twice = kids.find((c) => c.declaredName !== undefined && held.has(c.declaredName));
          if (twice) return refuse('redefined', e.id, sentenceAt(e, `${twice.declaredName} is a name ${name(to)} already holds, which the redefining state inherits; a redefinition would have to say \`:>>\``));
        }
        replaced.set(to, e.id);
      }
      for (const c of model.children(e.id)) if (c.eClass === 'Redefinition') droppedOwn.add(c.id);
      droppedOwn.add(e.id); // re-added below for a replacement
      continue;
    }
    const t1 = model.get(to);
    if (e.eClass === 'TransitionUsage' && t1 !== undefined && t1.eClass === 'TransitionUsage' && baseTransIds.has(to) && t1.ownerId !== null && rootOwners.has(t1.ownerId)) {
      const bodied = (x: ElementRecord): boolean => model.children(x.id).some((c) => c.eClass !== 'Redefinition');
      if (
        e.source?.[0] === undefined || e.target?.[0] === undefined || payloadOf(e) !== undefined ||
        bodied(e) || bodied(t1) || replacedTr.has(to) ||
        Object.keys(t1.attrs).some((k) => !(k in e.attrs))
      ) {
        return refuse('redefined', e.id, sentenceAt(e, 'it does not state both ends and every trigger, guard and effect of the step it replaces'));
      }
      replacedTr.set(to, e.id);
      for (const c of model.children(e.id)) if (c.eClass === 'Redefinition') droppedOwn.add(c.id);
      continue;
    }
    return refuse('redefined', e.id, sentenceAt(e, ''));
  }
  // `droppedOwn` holds a plain alias and the relationships of a redefinition; a body redefinition stays.
  for (const r of replaced.values()) droppedOwn.delete(r);
  const movedIds = new Set<ElementId>();
  for (const r of replaced.values()) {
    movedIds.add(r);
    for (const d of model.descendants(r)) movedIds.add(d.id);
  }
  const aliasKids = (e: ElementRecord): boolean => {
    for (let p: ElementId | null = e.ownerId; p != null; p = model.get(p)?.ownerId ?? null) if (alias.has(p)) return true;
    return false;
  };
  const dropped = new Set<ElementId>(droppedOwn);
  for (const e of own.descendants) if (aliasKids(e)) dropped.add(e.id);
  const movedOwn = own.descendants.filter((e) => movedIds.has(e.id) && !dropped.has(e.id));
  const ownKept = own.descendants.filter((e) => !dropped.has(e.id) && !movedIds.has(e.id));
  // Own steps name the redefining state; a step that names the state it replaced reads a name this machine no longer holds.
  const rename = <T extends ElementRecord>(e: T, map: ReadonlyMap<ElementId, ElementId>): T => {
    if (![...(e.source ?? []), ...(e.target ?? [])].some((x) => map.has(x))) return e;
    return { ...e, source: e.source?.map((x) => map.get(x) ?? x), target: e.target?.map((x) => map.get(x) ?? x) } as T;
  };
  const named = [...ownKept, ...movedOwn].find((e) => [...(e.source ?? []), ...(e.target ?? [])].some((x) => replaced.has(x)));
  if (named) return refuse('redefined', named.id, `${name(named.id)} names a state that a state of this machine redefines`);
  const ownOut = ownKept.map((e) => rename(e, alias));
  const movedOut = movedOwn.map((e) => rename(e, alias));
  // The general's elements, the replaced state's place taken by its replacement and the replaced steps gone.
  const goneTr = new Set<ElementId>(replacedTr.keys());
  const baseOut: ElementRecord[] = [];
  const inS = new Set<ElementId>();
  for (const sId of replaced.keys()) for (const d of model.descendants(sId)) inS.add(d.id);
  for (const e of baseDesc) {
    if (goneTr.has(e.id) || (e.ownerId !== null && goneTr.has(e.ownerId))) continue;
    if (replaced.has(e.id)) {
      const r = replaced.get(e.id)!;
      const inR = new Set<ElementId>([r, ...model.descendants(r).map((d) => d.id)]);
      const mine = movedOut.filter((d) => inR.has(d.id));
      // What the replaced state holds comes first, then the replacing state's own (the flattened twin's order).
      baseOut.push(...mine.filter((d) => d.id === r), ...baseDesc.filter((d) => inS.has(d.id)).map((d) => rename(d, replaced)), ...mine.filter((d) => d.id !== r));
      continue;
    }
    if (inS.has(e.id)) continue;
    const touches = [...(e.source ?? []), ...(e.target ?? [])].some((x) => replaced.has(x));
    if (touches) {
      const ends = [...(e.source ?? []), ...(e.target ?? [])];
      if (!baseTransIds.has(e.id) || !ends.every((x) => model.get(x)?.eClass === 'StateUsage')) {
        return refuse('redefined', e.id, `${name(e.id)} names a state that a state of this machine redefines, other than as a step between states`);
      }
      baseOut.push(rename(e, replaced));
      continue;
    }
    baseOut.push(e);
  }
  const taken = new Set<string>();
  for (const e of baseOut) if (!movedIds.has(e.id) && isUsage(e.eClass) && e.declaredName) taken.add(e.declaredName);
  const clash = ownKept.find((e) => isUsage(e.eClass) && e.declaredName !== undefined && taken.has(e.declaredName));
  if (clash) return refuse('redefined', clash.id, `${name(clash.id)} takes a name its general machine already holds`);
  const descendants = [...baseOut, ...ownOut];
  if (descendants.filter((e) => e.eClass === 'InitialNode').length > 1) {
    return refuse('two-starts', id, `${name(id)} and its general machine each open at a start node of their own`);
  }
  const bases = parts.flatMap((p) => [p.g, ...p.b.bases]);
  const ownHeld = new Set<ElementId>([...ownOut, ...movedOut].map((e) => e.id));
  const transIds = new Set<ElementId>([
    ...baseTrans.filter((t) => !goneTr.has(t.id)).map((t) => t.id),
    ...own.transitions.filter((t) => !dropped.has(t.id)).map((t) => t.id),
  ]);
  const nodes = new Set<ElementId>();
  for (const p of parts) for (const n of p.b.nodes) if (!replaced.has(n)) nodes.add(n);
  for (const n of own.nodes) if (!dropped.has(n)) nodes.add(n);
  const replacers = new Set(replaced.values());
  const region: MachineRegion = {
    root: id,
    bases,
    superseded: goneTr,
    nodes,
    descendants,
    transitions: descendants.filter((e) => transIds.has(e.id)),
    directStates: (containerId) =>
      containerId === id
        ? [
            ...rootStates.map((x) => (replaced.has(x.id) ? own.descendants.find((d) => d.id === replaced.get(x.id))! : x)),
            ...own.directStates(id).filter((d) => !dropped.has(d.id) && !replacers.has(d.id)),
          ]
        : directStates(model, containerId),
    parentOf: (x) => {
      if (gids.includes(x)) return id;
      if (replaced.has(x)) return null;
      if (ownHeld.has(x)) return own.parentOf(x);
      const up = parts.map((p) => p.b.parentOf(x)).find((v) => v !== null) ?? null;
      return up !== null && replaced.has(up) ? replaced.get(up)! : up;
    },
    inheritedFrom: (x) => {
      if (ownHeld.has(x) || x === id) return undefined;
      const p = parts.find((q) => q.ids.has(x));
      return p ? (p.b.inheritedFrom(x) ?? p.g) : parts.length === 1 ? parts[0].g : undefined;
    },
  };
  if (chain.length === 0) cache.inherited.set(id, region);
  return region;
}

/**
 * The elements a region is made of: its descendants, stopping at a nested
 * `state def` ({@link machineRegion}). A fresh array, as it always was.
 */
export function regionDescendants(model: Model, regionId: ElementId): ElementRecord[] {
  return machineRegion(model, regionId).descendants.slice();
}

/**
 * Every step edge inside a region that has both endpoints, in declaration
 * order — which is the order the first-enabled tie-break is taken in
 * ({@link machineRegion}, which says what makes an edge a step).
 */
export function regionTransitions(model: Model, regionId: ElementId): readonly ElementRecord[] {
  return machineRegion(model, regionId).transitions;
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
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
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
 *
 * A STATE MACHINE IS SEEDED FROM ITS REGION ({@link machineRegion}), the same
 * elements the walk and the interpreter step over, and not from every
 * descendant: an attribute written in a nested `state def` is that machine's
 * own, and seeded here it took the name (first name wins) from the outer
 * machine's. `region` is the view to read, for a caller that holds one; an
 * action has no region and reads its descendants.
 */
export function seedStore(
  model: Model,
  behavior: ElementRecord,
  store: Map<string, unknown>,
  initial?: Map<string, unknown> | Record<string, unknown>,
  region?: Pick<MachineRegion, 'descendants'>,
): void {
  // A typed `exhibit state` is seeded from its region only where the region reads a general's states too.
  const viewed =
    behavior.eClass === 'ExhibitStateUsage' && machineRegion(model, behavior.id).bases.length > 0
      ? machineRegion(model, behavior.id).descendants
      : undefined;
  const seeded =
    region?.descendants ??
    viewed ??
    (behavior.eClass === 'StateDefinition' || behavior.eClass === 'StateUsage'
      ? machineRegion(model, behavior.id).descendants
      : model.descendants(behavior.id));
  for (const f of seeded) {
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

/**
 * The attributes a walk seeded from a DEFAULT value and a guard or atom reads.
 *
 * `attribute n : Integer default 0` is a start value a specialisation may
 * redefine, where `attribute n = 0` is not, and the walk seeds both the same
 * way ({@link seedStore}). A verdict that rests on the first is true of the
 * default and of nothing a redefinition chooses, so it carries a note naming
 * it: `n = 0 (default, redefinable)`. The note moves no verdict; it says what
 * the verdict holds for.
 *
 * "DEPENDS ON" IS "IS READ BY": a name some transition guard of the machine's
 * region reads, or one of `exprTexts` (the property's own atoms). That is an
 * upper bound — a guard that never decides anything still names its
 * attribute — which is the safe side for a disclosure. Only the feature
 * {@link seedStore} would seed from (the first with a literal value, in region
 * order) counts, so a `=` redefinition of a defaulted attribute is not noted.
 * Each name once, in first-read order.
 */
export function defaultsReadBy(
  model: Model,
  machineId: ElementId,
  exprTexts: readonly (string | undefined)[] = [],
): string[] {
  const machine = model.get(machineId);
  if (!machine) return [];
  const region = machineRegion(model, machineId);
  const texts: string[] = [];
  for (const tr of region.transitions) {
    const g = guardTextOf(tr);
    if (g !== undefined) texts.push(g);
  }
  for (const t of exprTexts) if (t !== undefined && t.trim() !== '') texts.push(t);
  const read: string[] = [];
  for (const t of texts) {
    try {
      for (const n of namesReadIn(parseExpr(t))) if (!read.includes(n)) read.push(n);
    } catch {
      // Not an expression (a `state X` atom, say): it reads no attribute.
    }
  }
  if (read.length === 0) return [];
  const seeded = new Map<string, ElementRecord>();
  for (const f of region.descendants) {
    if (!isUsage(f.eClass) || !f.declaredName || seeded.has(f.declaredName)) continue;
    if (literalValueOf(f) !== undefined) seeded.set(f.declaredName, f);
  }
  const notes: string[] = [];
  for (const n of read) {
    const f = seeded.get(n);
    if (f === undefined || f.attrs.defaultValue !== true) continue;
    const v = literalValueOf(f);
    notes.push(`${n} = ${typeof v === 'string' ? JSON.stringify(v) : String(v)} (default, redefinable)`);
  }
  return notes;
}

/* ──────────────────── state-machine reading primitives ──────────────────── */

/** A transition matches a fired trigger when its non-empty trigger equals it. */
export function triggerEquals(tr: ElementRecord, trigger: string): boolean {
  const t = tr.attrs.trigger;
  if (typeof t === 'string' && t !== '') return t === trigger;
  const tt = timeTriggerLabel(tr);
  return tt !== undefined && tt === trigger;
}

/** A completion transition carries no trigger. */
export function isCompletion(tr: ElementRecord): boolean {
  const t = tr.attrs.trigger;
  return (t === undefined || t === null || t === '') && timeTriggerLabel(tr) === undefined;
}

/**
 * The label a SysML v2 §7.18.3 time trigger (`accept after 5`, `accept after 5[min]`) is offered under:
 * `after 5`, `after 5[min]` — the text as written, so two different delays or units are two different events.
 * `undefined` for a transition that carries none. The walk has no clock, so it offers this label as a named
 * event at any time (a clock-free over-approximation, see the `time` field of the semantic profile); the
 * interpreter runs such a machine on an abstract discrete clock where the duration is a literal positive integer
 * ({@link dwellTicks}), and refuses it otherwise.
 */
export function timeTriggerLabel(tr: ElementRecord): string | undefined {
  const t = tr.attrs.timeTrigger;
  return typeof t === 'string' && t.trim() !== '' ? `after ${t.trim()}` : undefined;
}

/**
 * The one spelling of a dwell that reaches a label: `after(n)`, written as the
 * trigger. Shared by {@link afterDuration} and {@link isDwellLabel} so the two
 * readers of a dwell can never disagree on what one looks like.
 */
const AFTER_LABEL = /^after\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)$/;
/** A time-trigger label, `after 5` or `after 5[min]` ({@link timeTriggerLabel}). */
const TIME_TRIGGER_LABEL = /^after\s+[^\s(].*$/;

/** The dwell time of an `after(n)` timed transition, or `undefined`. */
export function afterDuration(tr: ElementRecord): number | undefined {
  const a = tr.attrs.after;
  if (typeof a === 'number') return a;
  const t = tr.attrs.trigger;
  if (typeof t === 'string') {
    const m = AFTER_LABEL.exec(t.trim());
    if (m) return Number(m[1]);
  }
  // A §7.18.3 time trigger: the delay as written, read only as a number where it is one (0 where it is an
  // expression). Nothing in the walk reads the number; it makes the transition a dwell for the gates.
  const tt = timeTriggerLabel(tr);
  if (tt !== undefined) {
    const n = Number.parseFloat(tt.slice('after'.length));
    return Number.isFinite(n) ? n : 0;
  }
  return undefined;
}

/** The outermost state (usage or definition) that holds an element: the machine its dwells are counted in. */
function machineRootOf(model: Model, el: ElementRecord): ElementId {
  let root = el.id;
  for (let o = el.ownerId; o != null; ) {
    const e = model.get(o);
    if (e === undefined || (e.eClass !== 'StateUsage' && e.eClass !== 'StateDefinition' && e.eClass !== 'ExhibitStateUsage')) break;
    root = e.id;
    o = e.ownerId;
  }
  return root;
}

/**
 * The text of a dwell's duration, or a refusal. A name (`accept after timeout`) is read as the literal the
 * attribute it names is bound to by `=` — never one given by `default` or `:=`, which stand against every assertion
 * and may be overridden; anything but a literal positive integer behind the name stays refused.
 */
function dwellText(model: Model, tr: ElementRecord): { text?: string; why?: string } {
  const raw = tr.attrs.timeTrigger;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  const t = raw.trim();
  const named = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\[[^\]]*\])?$/.exec(t);
  if (named === null) return { text: t };
  const hits: ElementRecord[] = [];
  for (let o = tr.ownerId; o != null && hits.length === 0; ) {
    for (const c of model.children(o)) if (c.eClass === 'AttributeUsage' && c.declaredName === named[1]) hits.push(c);
    o = model.get(o)?.ownerId ?? null;
  }
  if (hits.length !== 1) return { why: `\`${named[1]}\` does not name exactly one attribute` };
  const a = hits[0];
  if (a.attrs.value === undefined || a.attrs.initialValue === true || a.attrs.defaultValue === true) {
    return { why: `\`${named[1]}\` is not bound by \`=\` (a default or \`:=\` value may be overridden)` };
  }
  const v = String(a.attrs.value).trim();
  if (!/^[0-9]+$/.test(v)) return { why: `\`${named[1]}\` is bound to ${v}, not a literal whole number` };
  const unit = typeof a.attrs.unit === 'string' && a.attrs.unit !== '' ? a.attrs.unit : named[2]?.slice(1, -1);
  return { text: unit ? `${v}[${unit}]` : v };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * The dwell counts of one machine (SysML v2 §7.18.3), each a tick count or the reason it has none. Unitless dwells
 * keep the abstract reading (`after 5` is 5 ticks). Where they carry units, every dwell of the machine must carry a
 * time unit; each is scaled to the finest unit used and the counts divided by their gcd, so `1 [s]` against
 * `500 [ms]` is 2 ticks against 1. A mix of unitless and united dwells, a non-time or unknown unit, or a count that
 * is no whole number in the finest unit is refused with the reason, for the whole machine.
 */
function dwellReading(model: Model, rootId: ElementId): Map<ElementId, number | string> {
  const cache = cacheFor(model);
  const hit = cache.dwells.get(rootId);
  if (hit) return hit;
  const out = new Map<ElementId, number | string>();
  cache.dwells.set(rootId, out);
  const trs = model.descendants(rootId).filter((e) => afterDuration(e) !== undefined);
  const items = trs.map((tr) => {
    const dt = dwellText(model, tr);
    const tt = typeof tr.attrs.timeTrigger === 'string' && tr.attrs.timeTrigger.trim() !== '';
    if (dt.why !== undefined) return { tr, why: dt.why };
    if (!tt) {
      const n = afterDuration(tr);
      return n !== undefined && Number.isInteger(n) && n >= 1 ? { tr, n, unit: undefined as string | undefined } : { tr, why: 'its duration is not a literal positive integer' };
    }
    const m = /^([0-9]+)\s*(?:\[([^\]]*)\])?$/.exec(dt.text!);
    if (m === null) return { tr, why: 'its duration is not a literal positive integer' };
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1) return { tr, why: 'its duration is not a literal positive integer' };
    return { tr, n, unit: m[2]?.trim() };
  });
  for (const i of items) if ('why' in i && i.why !== undefined) out.set(i.tr.id, i.why);
  const ok = items.filter((i): i is { tr: ElementRecord; n: number; unit: string | undefined } => 'n' in i);
  const united = ok.filter((i) => i.unit !== undefined && i.unit !== '');
  const refuseAll = (why: string): void => {
    for (const i of ok) out.set(i.tr.id, why);
  };
  if (united.length === 0) {
    for (const i of ok) out.set(i.tr.id, i.n);
    return out;
  }
  if (united.length !== ok.length) {
    refuseAll('the dwells of this machine mix unitless and united durations, which share no unit to count in');
    return out;
  }
  const scaled: { tr: ElementRecord; si: number; unit: string }[] = [];
  for (const i of united) {
    const u = unitBySymbol(i.unit!) ?? unitByName(i.unit!);
    if (u === undefined) return refuseAll(`the duration unit \`${i.unit}\` is unknown`), out;
    if (!dimEqual(u.dimension, dim({ T: 1 }))) return refuseAll(`the duration unit \`${i.unit}\` is not a unit of time`), out;
    scaled.push({ tr: i.tr, si: i.n * u.factorToSI, unit: i.unit! });
  }
  if (new Set(united.map((i) => i.unit)).size === 1) {
    for (const i of united) out.set(i.tr.id, i.n);
    return out;
  }
  const finest = Math.min(...united.map((i) => unitBySymbol(i.unit!)?.factorToSI ?? unitByName(i.unit!)!.factorToSI));
  const counts = scaled.map((s) => s.si / finest);
  if (counts.some((c) => Math.abs(c - Math.round(c)) > 1e-9)) {
    refuseAll('the dwell durations are no whole numbers of the finest unit used');
    return out;
  }
  const ints = counts.map(Math.round);
  const g = ints.reduce(gcd);
  scaled.forEach((s, k) => out.set(s.tr.id, ints[k] / g));
  return out;
}

/**
 * The number of ticks of the abstract discrete clock a dwell waits (SysML v2 §7.18.3 `accept after n`), where the
 * duration is a literal positive integer, or a name bound by `=` to one, and `undefined` for everything else (an
 * expression, zero, a fraction, a transition that is no dwell, units that cannot be compared — see
 * {@link dwellReading}). The interpreter runs, and a witness replays through, only a dwell this reads: no real time
 * is modelled, a tick is one abstract step.
 */
export function dwellTicks(tr: ElementRecord, model: Model): number | undefined {
  if (afterDuration(tr) === undefined) return undefined;
  const r = dwellReading(model, machineRootOf(model, tr)).get(tr.id);
  return typeof r === 'number' ? r : undefined;
}

/** Why a dwell has no tick count, when the reason is one {@link dwellReading} names (units, a name), else `undefined`. */
export function dwellWhyNot(tr: ElementRecord, model: Model): string | undefined {
  const r = dwellReading(model, machineRootOf(model, tr)).get(tr.id);
  return typeof r === 'string' ? r : undefined;
}

/**
 * Is this alphabet label a dwell spelled as a trigger, rather than an event an
 * environment sends?
 *
 * A STRING predicate, for the one reader that holds the alphabet and not the
 * walk: `MachineReach` carries `bounds.alphabet` but not `timedLabels`, and the
 * text report has to say which triggers the environment sentence is about
 * without adding a field to a payload two suites pin key-for-key. On a model the
 * CLI can load the two readings coincide — `after(n)` is the only spelling of a
 * dwell the notation has and it is a parse error there (correction 22) — and on
 * a factory-built one the `after(n)` string IS the label `timedLabels` holds.
 */
export function isDwellLabel(label: string): boolean {
  return AFTER_LABEL.test(label.trim()) || TIME_TRIGGER_LABEL.test(label.trim());
}

/**
 * Why the dwells inside the regions of a parallel state cannot be run or walked, or `undefined` when they can
 * (SysML v2 §7.18.2, §7.18.3). A tick of the abstract discrete clock advances every active state's counter in every
 * region at once, and the dwells then enabled fire as an event offered to the regions does, in declaration order.
 * The walk offers a dwell as a named event at any time, to every region at once, so a dwell label that two regions
 * both carry would fire in both on one walk step while the clock can fire it in one region alone (the other was
 * entered later): that walk would miss a run, so that shape is refused. A dwell that is no literal positive integer
 * has no clocked reading and is refused as before. `regionTrs` are the transitions written inside `p`, `regionOf`
 * names the region (of `p`) holding a transition's source.
 */
export function regionDwellRefusal(
  model: Model,
  regionTrs: readonly ElementRecord[],
  regionOf: (tr: ElementRecord) => ElementId | undefined,
  pName: string,
): string | undefined {
  const dwells = regionTrs.filter((t) => afterDuration(t) !== undefined);
  if (dwells.length === 0) return undefined;
  const bad = dwells.find((t) => dwellTicks(t, model) === undefined);
  if (bad !== undefined) {
    const why = dwellWhyNot(bad, model);
    return `a region of its parallel state ${pName} has a timed (\`after\`) transition whose duration is not a literal positive integer, which the interpreter's abstract clock does not count${why ? ` (${why})` : ''}, so no verdict is given over it`;
  }
  const seen = new Map<string, ElementId | undefined>();
  for (const t of dwells) {
    const label = triggerLabelOf(t);
    const r = regionOf(t);
    if (seen.has(label) && seen.get(label) !== r) {
      return `two regions of its parallel state ${pName} carry the same dwell \`${label}\`, which a clock can fire in one region alone and an untimed walk would fire in both at once, so no verdict is given over it`;
    }
    seen.set(label, r);
  }
  return undefined;
}

/** The trigger label of a transition (empty for completion transitions). */
export function triggerLabelOf(tr: ElementRecord): string {
  const t = tr.attrs.trigger;
  if (typeof t === 'string' && t !== '') return t;
  return timeTriggerLabel(tr) ?? '';
}

/** Direct child StateUsages of a container (its states at one nesting level). */
export function directStates(model: Model, containerId: ElementId): ElementRecord[] {
  const own = model.children(containerId).filter((c) => c.eClass === 'StateUsage');
  const s = mergedFrom(model, containerId);
  return s === undefined ? own : [...model.children(s.id).filter((c) => c.eClass === 'StateUsage'), ...own];
}

/**
 * The regions of a parallel state: its child states, except a state the parallel state's own completion transition
 * names as its target — that is where a parallel machine root goes on once every region is final (the old orthogonal
 * join), not one more region running beside the others.
 */
export function parallelRegions(model: Model, pId: ElementId): ElementRecord[] {
  const view = machineRegion(model, pId);
  const joined = new Set(
    view.transitions.filter((t) => t.source?.[0] === pId && isCompletion(t) && t.target?.[0] !== undefined).map((t) => t.target![0]),
  );
  return view.directStates(pId).filter((s) => !joined.has(s.id));
}

/** Is the state a parallel state (the notation's `parallel` keyword, SysML v2 §7.18.2, or the API's `attrs.parallel`)? */
export function isParallelState(model: Model, stateId: ElementId): boolean {
  const el = model.get(stateId);
  return el !== undefined && (isTruthy(el.attrs.parallel) || isTruthy(el.attrs.isParallel));
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

/**
 * Does the active leaf END its container: a final state, or a `done` node (SysML v2 §7.18.3: `then done` ends the
 * containing state). Read by the completion rules ({@link stateCompleted}, {@link regionsAllFinal}) — NOT by
 * {@link isFinalState}, which stays the interpreter's `complete` / `finalState` predicate (a `DoneNode` is a
 * terminal node, not a final STATE; `explore.ts` `isTerminalNode` says why).
 */
export function endsContainer(model: Model, id: ElementId): boolean {
  return isFinalState(model, id) || model.get(id)?.eClass === 'DoneNode';
}

/**
 * Is a parallel state complete (SysML v2 §7.18.2): it has regions and every one is at a final state it owns — the
 * region's own top-level final, not a final nested inside a composite of the region. `stacks` is one active stack
 * per region. The interpreter and the explorer both ask THIS.
 */
export function regionsAllFinal(model: Model, regs: readonly (readonly ElementId[] | RegionShape)[]): boolean {
  return (
    regs.length > 0 &&
    regs.every((rg) => {
      const stack = Array.isArray(rg) ? (rg as readonly ElementId[]) : (rg as RegionShape).stack;
      if (stack.length === 1) return endsContainer(model, stack[0]);
      // A region that IS a parallel state (stack empty, its own regions below) is final when its regions are.
      const sub = Array.isArray(rg) ? undefined : (rg as RegionShape).sub;
      return stack.length === 0 && sub !== undefined && regionsAllFinal(model, sub);
    })
  );
}

/** What {@link regionsAllFinal} reads of a region: its stack, and the regions below it when the region is itself a parallel state. */
export interface RegionShape {
  readonly stack: readonly ElementId[];
  readonly sub?: readonly RegionShape[];
}

/** The {@link RegionShape}s of the regions of an active parallel state. */
export function regionShapes(p: ParConfig): RegionShape[] {
  return p.regs.map((rg) => ({ stack: rg.stack, ...(rg.par !== undefined && rg.stack.length === 0 ? { sub: regionShapes(rg.par) } : {}) }));
}

/**
 * Has the state at `level` of the active stack COMPLETED, for a trigger-less transition out of it (SysML v2 Part 1
 * §9.2.11.2.1: a transition without an accepter follows the completion of its source's performance, after its
 * middle — the do action AND the substates)? A simple state (the leaf) completes after its entry/do. A composite
 * (a state with an active substate below it on the stack) completes only when its active leaf is a final state
 * (`then done`), recursively; a parallel leaf only through the parallel state's own rule, and a composite holding an
 * active parallel state has no final leaf, so it does not complete until the parallel state exits. The parallel state
 * itself (the leaf with `cfg.par`) completes when every region is final.
 */
export function stateCompleted(model: Model, cfg: MachineConfig, level: number): boolean {
  const top = cfg.stack.length - 1;
  // Only a SUBSTATE holds a composite open: a node under the state that is not a state (an action `then s::work`
  // enters) is a subaction of its middle that this reading does not wait on — the state completes as it always did.
  if (level < top) return model.get(cfg.stack[level + 1])?.eClass !== 'StateUsage' || endsContainer(model, cfg.stack[top]);
  return cfg.par === undefined || regionsAllFinal(model, regionShapes(cfg.par));
}

/**
 * Resolve the initial state: an InitialNode's target, else the target of the entry succession
 * ({@link entryOpening}), else the first StateUsage.
 */
export function initialState(
  model: Model,
  stateId: ElementId,
  states: readonly ElementRecord[],
  desc: readonly ElementRecord[],
  declIndex: Map<ElementId, number>,
  owners: readonly ElementId[] = [stateId],
): ElementId | null {
  return regionStart(model, states, desc, declIndex, owners).state;
}

/** The start of a region and, when an entry succession named it, that succession. */
function regionStart(
  model: Model,
  states: readonly ElementRecord[],
  desc: readonly ElementRecord[],
  declIndex: Map<ElementId, number>,
  owners: readonly ElementId[],
): RegionStart {
  const initialNode = desc.find((e) => e.eClass === 'InitialNode');
  // An entry action with an edge leaving it says where the region opens (SysML v2 §7.18.2). When that is not the one
  // plain succession {@link entryOpening} reads — a second or a guarded successor, a target that is not a direct state,
  // an `initial` node beside it, entry successions on two owners — the start is NOT read at all: falling back to the
  // first declared state opened the run somewhere the text does not say.
  const withEntry = owners.filter((o) => entryControlEdges(model, o).length > 0);
  if (withEntry.length > 0) {
    const entryEdge = initialNode || withEntry.length > 1 ? undefined : entryOpening(model, withEntry[0], states);
    return entryEdge ? { state: entryEdge.target![0], entryEdge } : { state: null, unread: true };
  }
  if (initialNode) {
    const edge = model
      .edgesFrom(initialNode.id)
      .find((e) => SUCCESSION_KINDS.has(e.eClass) || e.eClass === 'TransitionUsage');
    const to = edge?.target?.[0];
    if (to && states.some((s) => s.id === to)) return { state: to };
  }
  if (states.length) {
    return {
      state: states.slice().sort((a, b) => (declIndex.get(a.id) ?? 0) - (declIndex.get(b.id) ?? 0))[0].id,
    };
  }
  return { state: null };
}

/** Where a region opens; `unread` when an entry action names a start this reading does not take (no start, then). */
interface RegionStart {
  state: ElementId | null;
  entryEdge?: ElementRecord;
  unread?: true;
}

/** The control edges ({@link CONTROL_EDGE_KINDS}) leaving any entry action written directly in `ownerId`. */
export function entryControlEdges(model: Model, ownerId: ElementId): ElementRecord[] {
  return model
    .children(ownerId)
    .filter((c) => c.attrs.stateSubaction === 'entry')
    .flatMap((c) => model.edgesFrom(c.id).filter((e) => CONTROL_EDGE_KINDS.has(e.eClass)));
}

/**
 * The succession that names where `ownerId` opens: SysML v2 §7.18.2 indicates the initial substate "by a succession
 * from the entry action to that state usage" — `entry; then off;`, or `entry action init; first init then off;`.
 *
 * Read only on the plain shape: `ownerId` has exactly ONE entry action, and exactly one edge leaves it, an unguarded
 * succession with no payload into one of `states` (edges outside {@link CONTROL_EDGE_KINDS}, such as the entry
 * action's typing, are not counted). Anything else — two entry actions, a second or a guarded
 * successor (`transition first init if c then off;`, a conditional start), a target that is not one of the region's
 * direct states — names no start here, and the edge is left for the explorer's edge census, which refuses the machine
 * over an edge it does not walk rather than opening it somewhere the text does not say.
 */
export function entryOpening(
  model: Model,
  ownerId: ElementId,
  states: readonly ElementRecord[],
): ElementRecord | undefined {
  const entries = model.children(ownerId).filter((c) => c.attrs.stateSubaction === 'entry');
  if (entries.length !== 1) return undefined;
  // Only the edges that carry the control token count: `entry action init : Init;` also has a typing edge.
  const edges = model.edgesFrom(entries[0].id).filter((e) => CONTROL_EDGE_KINDS.has(e.eClass));
  if (edges.length !== 1) return undefined;
  const edge = edges[0];
  if (!SUCCESSION_KINDS.has(edge.eClass) || payloadOf(edge) !== undefined) return undefined;
  if (edge.attrs.guard !== undefined || (edge.target ?? []).length !== 1) return undefined;
  // A DIRECT state of the owner: `then b::b2;` names a state below one, which a start cannot enter here.
  const to = edge.target![0];
  return model.get(to)?.ownerId === ownerId && states.some((s) => s.id === to) ? edge : undefined;
}

/**
 * The state a region opens in, read from the region's view: an InitialNode's
 * target, else the target of the region's entry succession (its root's, or a
 * general machine's it is read through), else the first of `states` in the
 * region's declaration order. The
 * one reader of a region's start — `initialSubstate` (the walk, over the
 * region's direct states) and the interpreter's flat path (over its states)
 * both ask it, so the two cannot read two starts.
 */
export function initialStateOf(
  model: Model,
  region: Pick<MachineRegion, 'root' | 'descendants'> & Partial<Pick<MachineRegion, 'bases'>>,
  states: readonly ElementRecord[],
): ElementId | null {
  return regionStartOf(model, region, states).state;
}

/**
 * The entry succession a region's start was read from, if it was read from one — the edge the explorer's census
 * accounts for as `opening`, because the start consumes it and no step fires it.
 */
export function entryOpeningOf(
  model: Model,
  region: Pick<MachineRegion, 'root' | 'descendants'> & Partial<Pick<MachineRegion, 'bases'>>,
  states: readonly ElementRecord[],
): ElementRecord | undefined {
  return regionStartOf(model, region, states).entryEdge;
}

/**
 * Whether the region's start is NOT read because of its entry action ({@link regionStart}): an entry action names a
 * start, and not in the one plain shape this reading takes, so the region opens nowhere rather than at a guess.
 */
export function entryStartUnreadOf(
  model: Model,
  region: Pick<MachineRegion, 'root' | 'descendants'> & Partial<Pick<MachineRegion, 'bases'>>,
  states: readonly ElementRecord[],
): boolean {
  return regionStartOf(model, region, states).unread === true;
}

function regionStartOf(
  model: Model,
  region: Pick<MachineRegion, 'root' | 'descendants'> & Partial<Pick<MachineRegion, 'bases'>>,
  states: readonly ElementRecord[],
): RegionStart {
  const desc = region.descendants;
  const declIndex = new Map<ElementId, number>();
  desc.forEach((e, i) => declIndex.set(e.id, i));
  return regionStart(model, states, desc, declIndex, [region.root, ...(region.bases ?? [])]);
}

/** The initial substate of a container (InitialNode target, else first state). */
export function initialSubstate(model: Model, containerId: ElementId): ElementId | null {
  const region = machineRegion(model, containerId);
  return initialStateOf(model, region, region.directStates(containerId));
}

/**
 * A state effect (an entry/do/exit assignment, or a transition's effect text) that this evaluator cannot apply: the
 * run or the walk that meets it is REFUSED with {@link EffectNotApplied.message}, never continued with the store
 * as if the effect had not been written.
 */
export class EffectNotApplied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectNotApplied';
  }
}

/** The assignments a behaviour owns (`entry assign x := 1;` / `entry action a { assign x := 1; }`), in declaration order. */
export function behaviourAssignments(model: Model, el: ElementRecord): ElementRecord[] {
  return model.children(el.id).filter((c) => c.eClass === 'AssignmentActionUsage');
}

/** Apply a behavior action's store effect (an assignment or `attrs.effect`), then the assignments it owns, in order. */
export function applyBehaviorEffect(
  model: Model,
  el: ElementRecord,
  store: Map<string, unknown>,
  scope: Scope,
): void {
  if (el.attrs.stateSubactionRef === true) {
    applyReferencedEffect(model, el, store, scope);
    return;
  }
  const effect = strAttr(el, 'effect');
  if (effect !== undefined && !inlineAssign(effect, store, scope) && isAssignmentText(effect)) {
    throw new EffectNotApplied(
      `the effect \`${effect}\` of \`${model.qualifiedName(el.id) || el.id}\` is an assignment this interpreter cannot evaluate when it runs ` +
        '(SysML v2 §7.18.2) — so no run or walk goes on past it with the store as if it had not been written.',
    );
  }
  if (el.eClass === 'AssignmentActionUsage') applyAssignment(el, store, scope);
  else if (strAttr(el, 'target') !== undefined) applyAssignment(el, store, scope);
  for (const a of behaviourAssignments(model, el)) {
    if (applyAssignment(a, store, scope) === undefined) {
      throw new EffectNotApplied(
        `\`${model.qualifiedName(a.id) || a.id}\` assigns a value this interpreter cannot evaluate here ` +
          '(SysML v2 §7.18.2) — so no run or walk goes on past it with the store as if it had not been written.',
      );
    }
  }
}

/**
 * A bare `entry X;` / `do X;` / `exit X;` (a reference, `attrs.stateSubactionRef`) performs the action X names: its
 * effect is X's own, exactly as if X's body were written in place. Only a body made of assignments (and `attrs.effect`)
 * is read; an X with anything else (a parameter, a nested action, an `if`, a specialization or a typing that brings
 * a body this reading does not see, a reference that does not resolve or loops) throws {@link EffectNotApplied}, so no
 * run or walk goes on with the store as if X had not run (SysML v2 §7.18.2).
 */
function applyReferencedEffect(model: Model, ref: ElementRecord, store: Map<string, unknown>, scope: Scope): void {
  const name = (e: ElementRecord): string => `\`${model.qualifiedName(e.id) || e.id}\``;
  const phase = String(ref.attrs.stateSubaction);
  const refuse = (x: ElementRecord | undefined, why: string): never => {
    throw new EffectNotApplied(
      `the ${phase} behaviour of ${name(model.get(ref.ownerId!) ?? ref)} names ${x ? name(x) : 'an action'}, ` +
        `which this interpreter cannot evaluate: ${why} (SysML v2 §7.18.2) — so no run or walk goes on past it ` +
        'with the store as if it had not run.',
    );
  };
  const subs = model.children(ref.id).filter((c) => c.eClass === 'Subsetting');
  const targets = subs.flatMap((c) => c.target ?? []);
  const x = targets.length === 1 && subs.length === 1 ? model.get(targets[0]) : undefined;
  if (!x) return refuse(undefined, 'the reference does not resolve to exactly one action');
  applyActionBody(model, x, store, scope, refuse);
}

/** Apply the body of action X (assignments and `attrs.effect` only); anything else is refused through `refuse`. */
function applyActionBody(
  model: Model,
  x: ElementRecord,
  store: Map<string, unknown>,
  scope: Scope,
  refuse: (x: ElementRecord | undefined, why: string) => never,
): void {
  const name = (e: ElementRecord): string => `\`${model.qualifiedName(e.id) || e.id}\``;
  if (x.attrs.stateSubactionRef === true || x.attrs.stateSubaction !== undefined) {
    return refuse(x, 'it is itself a state behaviour, so the reference would chain or loop');
  }
  for (const c of model.children(x.id)) {
    if (c.eClass === 'AssignmentActionUsage') continue;
    if (c.eClass === 'FeatureTyping') {
      for (const t of c.target ?? []) {
        const def = model.get(t);
        if (def?.attrs.isLibrary === true || t.startsWith('stdlib:')) continue;
        if (!def || model.children(def.id).length > 0 || strAttr(def, 'effect') !== undefined) {
          return refuse(x, `it is typed by ${def ? name(def) : 'a definition that does not resolve'}, whose body is not read`);
        }
      }
      continue;
    }
    return refuse(x, `its body holds ${c.eClass} ${name(c)}, not only assignments`);
  }
  const effect = strAttr(x, 'effect');
  if (effect !== undefined && !inlineAssign(effect, store, scope)) {
    return refuse(x, `its effect \`${effect}\` is not an assignment it can evaluate`);
  }
  if ((x.eClass === 'AssignmentActionUsage' || strAttr(x, 'target') !== undefined) && applyAssignment(x, store, scope) === undefined) {
    return refuse(x, 'its assignment has a value it cannot evaluate');
  }
  for (const a of behaviourAssignments(model, x)) {
    if (applyAssignment(a, store, scope) === undefined) {
      return refuse(x, `${name(a)} assigns a value it cannot evaluate`);
    }
  }
}

/**
 * Why a machine's state effects cannot be applied, or `undefined`: a dry run of every entry/do/exit assignment and
 * every transition effect written as an assignment (`n = 1`), in declaration order, over the store the machine opens
 * with. One that does not evaluate is named. The interpreter and the explorer both ask this before they start, so
 * neither shows a value from a store an unapplied effect left wrong; a run that meets a different failure later
 * throws {@link EffectNotApplied} and is refused the same way.
 */
export function stateEffectRefusal(model: Model, machineId: ElementId): string | undefined {
  const machine = model.get(machineId);
  if (!machine) return undefined;
  const view = machineRegion(model, machineId);
  const store = new Map<string, unknown>();
  seedStore(model, machine, store);
  const scope = regionScope(model, machineId);
  const name = (id: ElementId): string => `\`${model.qualifiedName(id) || id}\``;
  for (const el of [machine, ...view.descendants]) {
    if (el.id !== machineId && el.eClass === 'TransitionUsage') {
      const effect = strAttr(el, 'effect');
      if (effect !== undefined) {
        try {
          applyTransitionEffect(model, el, store, scope);
        } catch (e) {
          if (e instanceof EffectNotApplied) return e.message;
          throw e;
        }
      }
      continue;
    }
    for (const a of model.children(el.id)) {
      if (a.attrs.stateSubaction === undefined) continue;
      if (a.attrs.stateSubactionRef === true) {
        try {
          applyReferencedEffect(model, a, store, scope);
        } catch (e) {
          if (e instanceof EffectNotApplied) return e.message;
          throw e;
        }
        continue;
      }
      for (const asg of behaviourAssignments(model, a)) {
        if (applyAssignment(asg, store, scope) === undefined) {
          return `${name(asg.id)}, written in ${name(el.id)}'s ${String(a.attrs.stateSubaction)} behaviour, assigns a value this interpreter cannot evaluate (SysML v2 §7.18.2)`;
        }
      }
    }
  }
  return undefined;
}

/** Does an effect text read as one assignment (a lone `=`)? */
export const isAssignmentText = (t: string): boolean => /[^=!<>:]=(?!=)|[^=!<>]:=/.test(t);
const NAME_EFFECT = /^(?:[A-Za-z_][A-Za-z0-9_]*|'[^']*')(?:::(?:[A-Za-z_][A-Za-z0-9_]*|'[^']*'))*$/;

/** The actions a bare name denotes from `from`'s scope: the nearest enclosing namespace that has one, else a qualified name. */
export function actionsNamed(model: Model, from: ElementRecord, text: string): ElementRecord[] {
  const isAct = (e: ElementRecord): boolean => e.eClass === 'ActionUsage' || e.eClass === 'ActionDefinition';
  const simple = text.replace(/'/g, '');
  for (let o = from.ownerId != null ? model.get(from.ownerId) : undefined; o; o = o.ownerId != null ? model.get(o.ownerId) : undefined) {
    const hit = model.children(o.id).filter((c) => isAct(c) && c.declaredName === simple);
    if (hit.length > 0) return hit;
  }
  const q = model.resolveQualifiedName(simple);
  return q && isAct(q) ? [q] : [];
}

/** The single action a transition's effect text names, or undefined when the text is not a bare name. Throws when it names none/several. */
function namedEffectAction(model: Model, tr: ElementRecord, effect: string): ElementRecord | undefined {
  const text = effect.trim();
  if (!NAME_EFFECT.test(text)) return undefined;
  const hits = actionsNamed(model, tr, text);
  if (hits.length !== 1) {
    throw new EffectNotApplied(
      `the effect \`${text}\` of \`${model.qualifiedName(tr.id) || tr.id}\` names ${hits.length === 0 ? 'no action' : 'more than one action'} ` +
        'this interpreter can resolve (SysML v2 §7.18.3) — so no run or walk goes on past it with the store as if it had not run.',
    );
  }
  return hits[0];
}

/** Apply a transition's effect to the store: an assignment, or the single action it names. One that cannot be applied throws. */
export function applyTransitionEffect(
  model: Model,
  tr: ElementRecord,
  store: Map<string, unknown>,
  scope: Scope,
): void {
  const effect = strAttr(tr, 'effect');
  if (effect === undefined) return;
  const effectType = strAttr(tr, 'effectType');
  if (effectType !== undefined) {
    // `do action powerUp : PowerUp;` (SysML v2 §7.18.3, OnOff4/5): the effect is a NEW action usage typed by PowerUp,
    // so what it does is what PowerUp's body does. Read only when PowerUp is one definition with nothing in it (it
    // changes no value, as a typed entry action's empty definition is read); anything else is refused.
    const defs = actionsNamed(model, tr, effectType).filter((d) => d.eClass === 'ActionDefinition');
    if (defs.length !== 1 || model.children(defs[0].id).length > 0 || strAttr(defs[0], 'effect') !== undefined) {
      throw new EffectNotApplied(
        `the effect \`${effect} : ${effectType}\` of \`${model.qualifiedName(tr.id) || tr.id}\` is typed by ` +
          `${defs.length === 1 ? `\`${model.qualifiedName(defs[0].id)}\`, whose body is not read` : 'a definition this interpreter cannot resolve to one action definition'} ` +
          '(SysML v2 §7.18.3) — so no run or walk goes on past it with the store as if it had not run.',
      );
    }
    return;
  }
  // `do X` refers to the action X and performs it; `do action X` (and an effect set through the API) declares a NEW,
  // empty effect action named X, which changes no value (SysML v2 §7.18.3).
  const x = tr.attrs.effectRef === true ? namedEffectAction(model, tr, effect) : undefined;
  if (x === undefined && tr.attrs.effectRef !== true && NAME_EFFECT.test(effect.trim())) return;
  if (x) {
    const refuse = (y: ElementRecord | undefined, why: string): never => {
      throw new EffectNotApplied(
        `the effect of \`${model.qualifiedName(tr.id) || tr.id}\` performs \`${model.qualifiedName((y ?? x).id)}\`, which this interpreter cannot evaluate: ${why} ` +
          '(SysML v2 §7.18.3) — so no run or walk goes on past it with the store as if it had not run.',
      );
    };
    applyActionBody(model, x, store, scope, refuse);
    return;
  }
  if (inlineAssign(effect, store, scope)) return;
  if (isAssignmentText(effect)) {
    throw new EffectNotApplied(
      `the effect \`${effect}\` of \`${model.qualifiedName(tr.id) || tr.id}\` is an assignment this interpreter cannot evaluate when the transition fires ` +
        '(SysML v2 §7.18.3) — so no run or walk goes on past it with the store as if it had not been written.',
    );
  }
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
    applyBehaviorEffect(model, a, store, scope);
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
  /**
   * The concurrent regions of the parallel state that ends `stack` (SysML v2 §7.18.2), one active stack per region
   * in declaration order. Set only by `./parallel` (the interpreter keeps its own, in `runHierRegion`); absent on
   * every other configuration, so nothing that never meets a parallel state sees it.
   */
  readonly par?: ParConfig;
}

/** One region of an active parallel state: the region state and its own active stack. */
export interface ParRegion {
  readonly id: ElementId;
  readonly stack: readonly ElementId[];
  readonly entryTime: ReadonlyMap<ElementId, number>;
  /**
   * The regions of a parallel state this region's stack ends in (a parallel state inside a parallel state), or absent.
   * The regions form a TREE: declaration order is depth first — a region, then the regions of the parallel state it
   * ends in, then its next sibling.
   */
  readonly par?: ParConfig;
}

/** The regions of an active parallel state. */
export interface ParConfig {
  readonly id: ElementId;
  readonly regs: readonly ParRegion[];
}

/**
 * A step of the concurrent regions of a parallel state on one input: one entry per region, the transition it takes
 * or `null` where it stays, applied in declaration order, each region on the store the previous one left.
 */
export interface ParMacro {
  readonly picks: readonly (EnabledTransition | null)[];
  /** The order the regions are applied in (region indices); declaration order where absent. */
  readonly order?: readonly number[];
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
  /** Set on a step of the concurrent regions of a parallel state (`./parallel`): the per-region picks. */
  readonly macro?: ParMacro;
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
 * Enter ONE state: push it, start its dwell, and fire its entry and do phases.
 * No cascade — {@link enterCascade} adds that, and {@link stepConfig} enters a
 * target's enclosing states with this alone, because a step into a nested
 * state enters each of them on the way down to the state it names, not at
 * their own initial substates.
 */
function enterOne(model: Model, d: Draft, scope: Scope, stateId: ElementId): void {
  d.stack.push(stateId);
  d.entryTime.set(stateId, d.clock);
  d.visited.push(stateId);
  runStatePhase(model, stateId, 'entry', d.store, scope, d.performed);
  runStatePhase(model, stateId, 'do', d.store, scope, d.performed);
}

/**
 * Enter a state, cascading into its initial (or history-resumed) substate;
 * entry/do phases fire outer→inner. The interpreter's `enterCascade`.
 */
function enterCascade(model: Model, d: Draft, scope: Scope, stateId: ElementId): void {
  enterOne(model, d, scope, stateId);
  // A parallel state's substates are its concurrent regions (SysML v2 §7.18.2), not alternatives: there is no ONE
  // initial substate to cascade into. The interpreter enters the regions itself (`runHierRegion`); this stops here.
  if (isParallelState(model, stateId)) return;
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
 * The interpreter's `exitTo`. {@link stepConfig} passes the depth of the least
 * common ancestor of a transition's source and target, so a step out of a
 * composite exits the composite too.
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
      if (input.kind === 'completion' && !stateCompleted(model, cfg, level)) continue;
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
    // A time trigger counts the ticks its machine's dwell reading gives it (units scaled to one grain, dwellReading);
    // the after(n) spelling and a time trigger no reading counts keep their written number.
    const n = (tr.attrs.timeTrigger !== undefined ? dwellTicks(tr, model) : undefined) ?? afterDuration(tr);
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
 * The states a step stands in once it is in `id`, outermost first and ending
 * with `id` itself: `[s0, …, sk = id]`, where `s0` is written directly in the
 * region and each next one directly in the one before. It is the chain
 * {@link stepConfig} enters on its way down to a target, and the bottom of the
 * stack the step leaves behind.
 *
 * `null` where there is no such chain: `id` is the region itself, lies outside
 * it, or sits under an element between it and the region that is not a
 * `StateUsage` — a nested `state def`, which is a machine of its own
 * ({@link regionDescendants}), or an action. A step into such a target has no
 * least common ancestor to exit to. Across the machine's boundary
 * ({@link stepAcrossBoundary}), into the machine's root or into a node under an
 * action ({@link stepOutsideStates}), no reader takes it: the walk refuses a
 * machine that holds either (`./explore.ts`, `unsupportedConstructs`) and the
 * interpreter stops before the step (`docs/06` §8.14).
 */
export function hierarchyPath(model: Model, regionId: ElementId, id: ElementId, inherit = true): ElementId[] | null {
  if (id === regionId) return null;
  const region = machineRegion(model, regionId, inherit);
  const path: ElementId[] = [id];
  for (let p = region.parentOf(id); p !== regionId; p = region.parentOf(p)) {
    if (p == null) return null;
    // A general machine's root is this machine read through its general: no state of the path.
    if (region.bases.includes(p)) continue;
    if (model.get(p)?.eClass !== 'StateUsage') return null;
    path.push(p);
  }
  return path.reverse();
}

/**
 * Is `id` one of the nodes a machine's region is made of: the machine itself,
 * or an element of its region ({@link regionDescendants}) that is not a nested
 * `state def`, which is a machine of its own or a definition no walk enters.
 * An edge with an end that is not is a step across the machine's boundary
 * (`boundaryCrossings`, `./explore.ts`).
 */
export function isRegionNode(model: Model, machineId: ElementId, id: ElementId): boolean {
  return machineRegion(model, machineId).nodes.has(id);
}

/**
 * Is `edge` a step whose target sits in no chain of the machine's states, short
 * of a step across its boundary: a step into the machine's own root (`then M`
 * written in `state def M`), or into a node written under an element of its
 * region that is not a state (`then act::inner`, under an action)?
 *
 * Such a step has no least common ancestor to exit to ({@link hierarchyPath}
 * is `null`), and neither UML nor this tool's profile says what it exits and
 * enters: a UML transition targets a vertex of a region, and the machine
 * itself and a node of an action are neither. So nothing here reads it. The
 * walk refuses a machine that holds one (`step-outside-states`, `./explore.ts`)
 * and the interpreter refuses to take one (`runStateMachine`'s `refused`,
 * `../execute.ts`): ONE predicate, read by both, so the two refuse the same
 * steps (`docs/06` §8.12).
 */
export function stepOutsideStates(model: Model, machineId: ElementId, edge: ElementRecord): boolean {
  const from = edge.source?.[0];
  const to = edge.target?.[0];
  if (from === undefined || to === undefined) return false;
  return (
    isRegionNode(model, machineId, from) &&
    isRegionNode(model, machineId, to) &&
    hierarchyPath(model, machineId, to) === null
  );
}

/**
 * Is `edge` a step across the machine's boundary: an end of it sits outside the
 * nodes the machine's region is made of ({@link isRegionNode}) — in a nested
 * `state def`, which is a machine of its own or a definition no walk enters, in
 * another machine, or in the machine that holds a composite the interpreter runs
 * on its own?
 *
 * Each machine steps only by its own transitions, so what such a step exits and
 * enters is defined by nothing here. The walk refuses both machines it joins
 * (`machine-boundary`, `boundaryCrossings` in `./explore.ts`, whose test for an
 * end is this one) and the interpreter stops before taking it, like a step into
 * the root or under an action ({@link stepOutsideStates}): ONE predicate for the
 * interpreter's side, disjoint from that one, so the two together are the steps
 * the interpreter does not take (`docs/06` §8.14). Until then it took the step
 * the old way, exiting down to the source's level and entering the target alone.
 */
export function stepAcrossBoundary(model: Model, machineId: ElementId, edge: ElementRecord): boolean {
  const from = edge.source?.[0];
  const to = edge.target?.[0];
  if (from === undefined || to === undefined) return false;
  return !isRegionNode(model, machineId, from) || !isRegionNode(model, machineId, to);
}

/**
 * Where a {@link stepOutsideStates} edge leads, in the words both refusals
 * print: the machine's own root, or the element above its target that is not a
 * state.
 */
export function outsideStatesSentence(model: Model, machineId: ElementId, edge: ElementRecord): string {
  const qn = (id: ElementId): string => `\`${model.qualifiedName(id) || id}\``;
  const to = edge.target![0];
  if (to === machineId) return `into ${qn(to)}, the machine itself`;
  let above: ElementId | null = model.get(to)?.ownerId ?? null;
  while (above != null && above !== machineId && model.get(above)?.eClass === 'StateUsage') {
    above = model.get(above)?.ownerId ?? null;
  }
  const owner = above == null ? undefined : model.get(above);
  return owner === undefined || above === machineId
    ? `to ${qn(to)}`
    : `to ${qn(to)}, which is written in ${qn(owner.id)} (\`${owner.eClass}\`), not in a state`;
}

/**
 * Fire ONE transition and return the configuration it leads to, plus what the
 * firing appended to the run.
 *
 * A STEP EXITS TO THE LEAST COMMON ANCESTOR of its source and its target, as
 * UML reads a transition, and every transition is external: the source, the
 * states below it and those above it that do not also hold the target are
 * exited, innermost first from the active leaf; then the effect runs; then the
 * target's enclosing states that are not active are entered, outermost first,
 * and the target with its cascade into its initial substate. So a step out of a
 * composite exits the composite; a step to an ancestor, or from a composite into
 * one of its own substates, exits that state and re-enters it; and a
 * self-transition exits and re-enters its state — a composite restarts at its
 * initial substate. The step used to exit only down to the SOURCE's level and
 * enter the target on top of what was left, so `first b then Idle` from inside
 * `C0` left `[C0, Idle]`: `C0` still active, its transitions still enabled, a
 * `state C0` atom still holding, and one more state stacked per round trip
 * (`docs/06` §8.9, §8.10).
 *
 * A target with no chain of states ({@link hierarchyPath} is `null`) is stepped
 * as before: exit down to the source's level, enter the target on top. No
 * caller reaches it: a step across the machine's boundary
 * ({@link stepAcrossBoundary}), into the machine's own root or into a node under
 * an action ({@link stepOutsideStates}) is refused by the walk and stopped
 * before by the interpreter (`docs/06` §8.12, §8.14).
 *
 * `choice` must have come from {@link enabledTransitions} on THIS configuration:
 * the level it names is where the source sits on the stack, and a choice from
 * another configuration would exit the wrong states. A mismatch is a
 * programming error and is raised as one rather than silently firing something
 * else.
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
  const to = choice.transition.target![0];
  const path = hierarchyPath(model, cfg.regionId, to);
  // How many states stay active: the states above the source on the stack that
  // also hold the target. Never the source itself (`<= level`), nor the target
  // (`< path.length`): every transition is external.
  let keep = choice.level;
  if (path !== null) {
    keep = 0;
    const shared = Math.min(choice.level, path.length - 1);
    while (keep < shared && cfg.stack[keep] === path[keep]) keep++;
  }
  exitTo(model, d, scope, keep);
  applyTransitionEffect(model, choice.transition, d.store, scope);
  d.fired.push({ transitionId: choice.transition.id, from, to, trigger: choice.label });
  if (path !== null) for (let i = keep; i < path.length - 1; i++) enterOne(model, d, scope, path[i]);
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
 * The history map is in the key only where something reads it (`history`,
 * which the walks set from {@link resumesHistory}): merging two configurations
 * that resume DIFFERENT substates would under-report what is reachable. Where
 * no composite resumes, {@link enterCascade} never reads the map, so two
 * configurations that differ only in it have the same successors — and keeping
 * it split them by the last-active child of every composite a run had left,
 * multiplying a machine's configurations with its composites (five composites
 * of four substates, entered and left on events, reached the 10,000-configuration
 * bound; they are 21 configurations without it). The default keeps it, the
 * over-fine key, for a caller that does not know the machine.
 */
export function hashConfig(cfg: MachineConfig, history = true): string {
  const store = [...cfg.store.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${JSON.stringify(v) ?? 'undefined'}`)
    .join(',');
  const resumed = history
    ? [...cfg.history.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k, v]) => `${k}>${v}`)
        .join(',')
    : '';
  // Dwell rather than absolute entry time, and the absolute clock is NOT in the
  // key: what an `after(n)` transition reads is `clock - entryTime`, and no
  // guard can read the clock at all, so two configurations that differ only in
  // when the whole run started have the same successors and are one
  // configuration. Keeping the reading would cost nothing today — nothing in
  // `./explore.ts` calls {@link advanceClock} — and would make the visited set
  // over-fine, and the walk non-terminating, for the first caller that advances
  // it, which is what a timed `check-behaviour` is.
  const dwell = cfg.stack.map((s) => `${s}@${cfg.clock - (cfg.entryTime.get(s) ?? 0)}`).join('/');
  const parKey = (p: ParConfig): string =>
    p.regs.map((r) => `${r.id}=${r.stack.join('/')}${r.par === undefined ? '' : `{${parKey(r.par)}}`}`).join(';');
  const par = cfg.par === undefined ? '' : `|P:${parKey(cfg.par)}`;
  return `${cfg.regionId}|${cfg.stack.join('/')}|${dwell}|${store}|${resumed}${par}`;
}

/**
 * Does a run of this region ever read the history map — does a composite in it
 * resume its last-active substate? The test {@link enterCascade} applies, over
 * the region, plus a history pseudostate anywhere in it; `exploreMachine`
 * refuses such a machine (`history-state`), so for every machine it walks this
 * is false and {@link hashConfig} leaves the map out of the key.
 */
export function resumesHistory(model: Model, regionId: ElementId): boolean {
  const root = model.get(regionId);
  return [...(root ? [root] : []), ...regionDescendants(model, regionId)].some(
    (el) => isHistoryPseudostate(el) || (el.eClass === 'StateUsage' && isHistoryComposite(model, el.id)),
  );
}

/** The active leaf of a configuration, or `null` for an empty region. */
export function leafOf(cfg: MachineConfig): ElementId | null {
  return cfg.stack.length > 0 ? cfg.stack[cfg.stack.length - 1] : null;
}

/** Every state a configuration is in: its stack, and for each region of an active parallel state the region and its stack. */
export function activeStatesOf(cfg: MachineConfig): readonly ElementId[] {
  const under = (p: ParConfig): ElementId[] => p.regs.flatMap((r) => [r.id, ...r.stack, ...(r.par === undefined ? [] : under(r.par))]);
  if (cfg.par === undefined) return cfg.stack;
  return [...cfg.stack, ...under(cfg.par)];
}

/** The leaves a configuration is in: its own, or for an active parallel state each region's (the region itself if it holds no state). */
export function activeLeavesOf(cfg: MachineConfig): readonly ElementId[] {
  if (cfg.par === undefined) {
    const l = leafOf(cfg);
    return l === null ? [] : [l];
  }
  // A region that ends in a parallel state of its own contributes that state's leaves, not the parallel state.
  const leaves = (p: ParConfig): ElementId[] =>
    p.regs.flatMap((r) => (r.par !== undefined ? leaves(r.par) : [r.stack.length > 0 ? r.stack[r.stack.length - 1] : r.id]));
  return leaves(cfg.par);
}

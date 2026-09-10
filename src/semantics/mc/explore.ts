/**
 * Bounded explicit-state exploration of a state machine, and the `reach` report
 * built on it (plan docs/04-formal-verification-plan.md §3.8).
 *
 * WHAT THIS IS. A breadth-first walk of the configuration graph over the SAME
 * step relation the interpreter runs (`./config.ts`), taking every enabled
 * transition where `runStateMachine` takes the first. That is the whole
 * difference between the two, and it is what lets this module say something the
 * simulator cannot: which states no run reaches, which transitions no run
 * fires, where the simulator silently picked one of several enabled
 * transitions.
 *
 * THE ENGINE IS PURE TYPESCRIPT. There is no solver in this lane and none is
 * imported. What is decided here is decided by walking a FINITE abstraction to
 * exhaustion, and the moment a bound stops the walk, every claim that depends
 * on having seen the whole graph is SUPPRESSED rather than qualified into
 * something a reader might mistake for a finding.
 *
 * THE HONESTY RULE, stated once because everything below serves it. An
 * unreachable state and a dead transition are claims of ABSENCE — "no run ever
 * gets here" — and absence is exactly what a partial walk cannot establish. So
 * the two lists are published only when the walk was exhaustive, no
 * completion-chase budget was spent, every trigger the machine names was
 * actually offered, no unsupported construct was met, and every guard it
 * consulted DECIDED something. Otherwise they come back EMPTY with
 * `verification/bound-exhausted` on the report and the sentence that says the
 * lists are lower bounds and are not reported as findings.
 *
 * THE FIFTH CONDITION IS THE ONE A BOUND DOES NOT COVER. A guard over a feature
 * the model never values (`transition idle if mode == 3 then hazard;` with
 * `attribute mode : Integer;`) evaluates to nothing at all, and the step
 * relation reads "did not evaluate" as "did not fire" because it must pick
 * something. Nothing about that walk is partial — it saw the whole graph its
 * own step relation admits — so the four conditions above all hold and the
 * report published three absence findings about a question the tool never
 * decided. `undeterminedGuards` is that question carried to the surface, and
 * `verification/guard-undetermined` is the reader's reason the lists are short.
 *
 * The other direction is deliberately the loose one: the walk OVER-approximates
 * what is reachable, by offering every `after(n)` label as a named event rather
 * than advancing a clock. An over-approximation can only shrink the absence
 * claims, never invent one, which is the direction a finding may be wrong in.
 *
 * IT IS LOOSE ONLY WHERE THAT HOLDS. The walk branches on the declaration-order
 * TIE-BREAK — every transition enabled at the innermost active level, where the
 * interpreter takes the first — and on nothing else. It does NOT branch across
 * stack levels: the profile's priority rule says the innermost enabled level
 * wins, so a configuration reached by firing an outer transition while an inner
 * one was enabled is a configuration NO run of this semantics ever enters. The
 * absence lists would survive that (they only shrink), but `verification/deadlock`
 * and `verification/nondeterministic-choice` are claims about a configuration
 * being REACHED, and exploring extra configurations invents them. That is why
 * `exploreMachine` steps only the innermost level while still counting every
 * enabled transition as fired — `dead` means never ENABLED anywhere reachable,
 * which is the reading the finding's hint states.
 *
 * MUST NEVER, from §3.8: this module does not say "verified", does not say
 * "deadlock-free", and does not say "proved". It says what it explored, under
 * which bounds.
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import type { Diagnostic } from '@validation/types';
import {
  CONTROL_EDGE_KINDS,
  MAX_COMPLETION,
  hashConfig,
  initialConfig,
  isFinalState,
  isHistoryComposite,
  isHistoryPseudostate,
  isTruthy,
  leafOf,
  regionTransitions,
  seedStore,
  stepCandidates,
  stepConfig,
  triggerLabelOf,
  type EnabledTransition,
  type MachineConfig,
  type StepInput,
} from './config';
import { SEMANTIC_PROFILE, type ProfileField } from './profile';
// One definition of "may this absence be stated", read by this file and by
// `./patterns`, so the two cannot drift apart again.
import { publishabilityOf } from './publishable';
// The same reader the step relation uses to decide an edge carries an item, so
// the census can say WHY that edge is not in the relation in the relation's own
// terms rather than in a sentence of its own.
import { payloadOf } from '../connectors';

/* ─────────────────────────────── the codes ──────────────────────────────── */

/** A state no explored run ever entered. Only ever claimed on an exhaustive walk. */
export const UNREACHABLE_STATE_CODE = 'verification/unreachable-state';
/** A transition no explored run ever fired. Same condition, same reason. */
export const DEAD_TRANSITION_CODE = 'verification/dead-transition';
/** A reachable configuration with nothing enabled, in a state not marked final. */
export const DEADLOCK_CODE = 'verification/deadlock';
/** Two or more transitions enabled at once on one state: the simulator takes the first. */
export const NONDETERMINISTIC_CHOICE_CODE = 'verification/nondeterministic-choice';
/** A bound stopped the walk: the absence claims are suppressed, not qualified. */
export const BOUND_EXHAUSTED_CODE = 'verification/bound-exhausted';
/** A construct this engine does not explore. The machine is never called exhaustive. */
export const BEHAVIOUR_UNSUPPORTED_CODE = 'verification/behaviour-unsupported-construct';
/** A guard the walk consulted and could not evaluate: the absence lists are withheld. */
export const GUARD_UNDETERMINED_CODE = 'verification/guard-undetermined';

/** Every code this module can put in front of a reader, for the catalogue guard. */
export const BEHAVIOUR_CODES: ReadonlySet<string> = new Set([
  UNREACHABLE_STATE_CODE,
  DEAD_TRANSITION_CODE,
  DEADLOCK_CODE,
  NONDETERMINISTIC_CHOICE_CODE,
  BOUND_EXHAUSTED_CODE,
  BEHAVIOUR_UNSUPPORTED_CODE,
  GUARD_UNDETERMINED_CODE,
]);

/**
 * The five this engine raises as WARNINGS, and none of the seven as an error.
 *
 * The reading rule, not an omission. An error in this lane is reserved for a
 * refuted obligation, and `reach` refutes nothing. But the five below are
 * findings about a MACHINE — a state nothing reaches, a transition nothing
 * fires, a state nothing leaves, a choice the notation does not resolve, a
 * guard nothing in the model decides — and filing them as info would put them
 * beside "this construct is outside the fragment", which is the tool talking
 * about ITSELF. The remaining two do exactly that, and they are info.
 *
 * `verification/guard-undetermined` is a warning for the sharper reason that it
 * is the REASON the absence lists are short. A reader who sees an empty
 * unreachable list and an info line has been told good news; the thing that
 * withheld the lists has to sit at the same level as the findings it withheld.
 *
 * Exported for the same reason `VERIFICATION_ERROR_CODES` is: the catalogue
 * carries the severity too, and `test/unit/diagnostic-codes.test.ts` asserts
 * this set is exactly the `verification/*` entries the catalogue marks
 * `warning`. Edit either alone and that test goes red.
 */
export const BEHAVIOUR_WARNING_CODES: ReadonlySet<string> = new Set([
  UNREACHABLE_STATE_CODE,
  DEAD_TRANSITION_CODE,
  DEADLOCK_CODE,
  NONDETERMINISTIC_CHOICE_CODE,
  GUARD_UNDETERMINED_CODE,
]);

/* ────────────────────────────── the bounds ──────────────────────────────── */

/** Configurations explored before the walk gives up. */
export const DEFAULT_MAX_CONFIGS = 10_000;
/** Steps from the opening configuration before a branch is abandoned. */
export const DEFAULT_MAX_DEPTH = 200;

/** Which bound stopped the walk, if any. */
export type BoundHit = 'none' | 'configs' | 'depth' | 'completion';

/** The bounds a walk ran under, printed beside every figure it produced. */
export interface ExploreBounds {
  maxConfigs: number;
  maxDepth: number;
  maxCompletion: number;
  /** The events offered at every configuration: the triggers the machine names. */
  alphabet: readonly string[];
}

/** What a caller may set. */
export interface ExploreOptions {
  maxConfigs?: number;
  maxDepth?: number;
  maxCompletion?: number;
}

/* ───────────────────────────── the row shapes ───────────────────────────── */

/** An element as a report row: never bare ids, which are fresh on every load. */
export interface StateRef {
  id: ElementId;
  name: string;
  qualifiedName: string;
}

/** A transition as a report row, with the endpoints it connects. */
export interface TransitionRef {
  id: ElementId;
  name: string;
  qualifiedName: string;
  from: StateRef | null;
  to: StateRef | null;
  /**
   * The event it fires on, or `''` for a completion transition. Empty means
   * EMPTY: a report on a machine of trigger-less transitions must not print an
   * invented label, and `reach` on `FlightModes` is exactly that machine.
   */
  label: string;
}

/** One place the interpreter's declaration-order tie-break decided the run. */
export interface NondeterministicChoice {
  /** The state both transitions leave. */
  state: StateRef;
  /** The event they were enabled on: a trigger name, or `''` for completion. */
  event: string;
  /** Every transition enabled there, in the interpreter's own order. */
  enabled: readonly TransitionRef[];
  /** The one the simulator takes — `enabled[0]`, by declaration order. */
  taken: TransitionRef;
  /** The ones a simulation never takes. */
  notTaken: readonly TransitionRef[];
}

/** A reachable configuration nothing leaves. */
export interface DeadlockRow {
  /** The active leaf state. */
  leaf: StateRef;
  /** The active stack, outer→inner. */
  stack: readonly StateRef[];
  /** Steps from the opening configuration to the first walk that reached it. */
  steps: number;
}

/**
 * A transition whose guard the walk consulted and could not evaluate.
 *
 * NOT a guard that is false. A guard that reads a feature the model gives no
 * value to answers nothing at all, and the step relation reads nothing as "does
 * not fire" because it has to pick one. That reading is right for a run and
 * wrong for a report, so the fact is carried here and the report declines to
 * publish an absence over it.
 */
export interface UndeterminedGuardRow {
  transition: TransitionRef;
  /** The guard text, as the author wrote it. */
  guard: string;
  /** The names it reads that nothing in scope or in the store gives a value to. */
  unresolved: readonly string[];
}

/** A construct this engine will not explore, and what it does instead. */
export interface UnsupportedConstruct {
  /** A branchable name for the construct. */
  construct: string;
  /** One sentence a person can act on. */
  detail: string;
  elementId?: ElementId;
}

/** What one walk found. */
export interface ExploreResult {
  machineId: ElementId;
  bounds: ExploreBounds;
  /** Distinct configurations discovered, the opening one included. */
  configs: number;
  /** The deepest branch, in steps from the opening configuration. */
  depth: number;
  /**
   * Did the walk see the WHOLE configuration graph *its own step relation
   * admits*?
   *
   * ONE OF FIVE CONDITIONS, never the published verdict, and the distinction is
   * one word wide so it is stated here. This flag is `true` on a walk carrying
   * an undetermined guard — the walk really did finish — while
   * `MachineReach.exhaustive`, the figure a reader is shown, is `false` there.
   * Both consumers gate it: `reachOne` in this file, and `checkProperty` in
   * `./patterns.ts`. A third consumer that read this flag alone would print
   * `exhaustive` over a graph missing an edge nobody decided.
   */
  exhaustive: boolean;
  boundHit: BoundHit;
  /** Every state entered on some explored run. */
  reachable: ReadonlySet<ElementId>;
  /** Every transition fired on some explored run. */
  fired: ReadonlySet<ElementId>;
  /** The events actually offered — a bound can stop the walk before some are. */
  offered: ReadonlySet<string>;
  nondeterminism: readonly NondeterministicChoice[];
  deadlocks: readonly DeadlockRow[];
  unsupported: readonly UnsupportedConstruct[];
  /**
   * Every edge under the machine, each accounted for — see {@link edgeCensus}.
   *
   * Computed BEFORE the walk and published whether or not the walk ran, because
   * its `unaccounted` bucket is one of the reasons a walk does not run.
   */
  census: EdgeCensus;
  /**
   * Every transition whose guard was consulted and decided nothing, once each.
   *
   * A walk with one of these saw the whole graph its step relation admits and
   * still cannot say what is unreachable, because "the guard did not hold" was
   * never established — only "the guard did not evaluate".
   */
  undeterminedGuards: readonly UndeterminedGuardRow[];
}

/* ───────────────────────── refs and small readers ───────────────────────── */

function stateRef(model: Model, id: ElementId): StateRef {
  const el = model.get(id);
  return {
    id,
    name: el?.declaredName ?? '',
    qualifiedName: model.qualifiedName(id) || id,
  };
}

function transitionRef(model: Model, tr: ElementRecord): TransitionRef {
  const from = tr.source?.[0];
  const to = tr.target?.[0];
  return {
    id: tr.id,
    name: tr.declaredName ?? '',
    qualifiedName: model.qualifiedName(tr.id) || tr.id,
    from: from ? stateRef(model, from) : null,
    to: to ? stateRef(model, to) : null,
    label: triggerLabelOf(tr),
  };
}

/**
 * A transition as a person can read it: `autonomous -> failsafe`.
 *
 * NOT its qualified name. Transitions are usually anonymous, so every row of a
 * machine like `FlightModes` would print the same `…::«TransitionUsage»` and a
 * finding would read "the simulator takes X and never X". The endpoints are
 * what distinguishes them, and the trigger is appended only when there IS one —
 * a machine of completion transitions must never be shown a label it does not
 * have.
 */
export function transitionLabel(t: TransitionRef): string {
  const ends = `${t.from?.name ?? "?"} -> ${t.to?.name ?? "?"}`;
  const named = t.name ? `${t.name} (${ends})` : ends;
  return t.label ? `${named} on \`${t.label}\`` : named;
}

/**
 * The distinct events a machine names, in declaration order.
 *
 * `after(n)` spellings are INCLUDED, and that is a deliberate over-approximation
 * of time: the explorer advances no clock, so the only way an `after(n)`
 * transition is ever explored is by offering its label as a named event —
 * which is precisely what the interpreter does when it is driven with that
 * string. The alternative (never offering them) would make every state behind a
 * timed transition look unreachable, i.e. it would INVENT findings, which is
 * the failure direction this lane refuses.
 */
export function machineAlphabet(model: Model, machineId: ElementId): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tr of regionTransitions(model, machineId)) {
    const t = triggerLabelOf(tr);
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Every StateUsage inside the machine — the census the reachable set is read against. */
export function machineStates(model: Model, machineId: ElementId): ElementRecord[] {
  return model.descendants(machineId).filter((e) => e.eClass === 'StateUsage');
}

/**
 * Every node some configuration's stack can hold — read from the relation, not
 * from a metaclass.
 *
 * WHAT PUTS A NODE ON THE STACK, exactly. `initialConfig` (`./config.ts`) enters
 * `initialSubstate(machineId)` and cascades, which pushes `StateUsage`s; after
 * that, `stepConfig` pushes whatever the transition it fired TARGETS, whatever
 * that target's metaclass is. So the stack holds the machine's states, plus
 * everything the relation can land the walk on from one — a `decide` node
 * between two states, an action a transition enters. `stepCandidates` then
 * offers every relation edge leaving any stack member, so those nodes' outgoing
 * edges are walked as surely as a state's.
 *
 * WHY IT IS A CLOSURE AND NOT `eClass === 'StateUsage'`. That test was the old
 * reading, and it was wrong in both directions at once: it EXCLUDED the edges
 * leaving a `decide` node the walk demonstrably traverses (they were counted
 * `unaccounted` and refused the machine), and it INCLUDED an edge leaving the
 * machine ROOT, which `initialConfig` never pushes — so a `transition outer then
 * b` inside `state outer` was published `dead` on an exhaustive walk, a finding
 * the census invented rather than the walk finding it.
 *
 * The seed is {@link machineStates} and not the state HIERARCHY: a state nothing
 * enters is still a state whose outgoing edge the walk would offer if it got
 * there, and reporting that edge `dead` is a finding about the machine. Only the
 * structurally un-standable nodes are left out.
 */
function stackNodes(model: Model, machineId: ElementId): ReadonlySet<ElementId> {
  const on = new Set<ElementId>(machineStates(model, machineId).map((s) => s.id));
  const edges = regionTransitions(model, machineId);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of edges) {
      const from = e.source![0];
      const to = e.target![0];
      if (!on.has(from) || on.has(to)) continue;
      on.add(to);
      grew = true;
    }
  }
  return on;
}

/**
 * The transitions the walk could ever offer — the census `dead` is read against.
 *
 * NOT every edge in the relation. {@link enabledTransitions} offers an edge only
 * when its source is on the ACTIVE STACK, so an edge leaving a node no
 * configuration can stand on is structurally un-offerable, and counting it here
 * would put it in `dead` on every exhaustive walk — a finding invented by the
 * census rather than found by the walk, in a lane whose whole claim is that an
 * over-approximation can only SHRINK an absence claim. {@link stackNodes} is
 * what "can stand on" means, computed rather than guessed at from a metaclass.
 *
 * The one that matters in practice is the `initial start; transition start ->
 * idle;` edge every hand-written machine has. It is not un-fired: it is
 * CONSUMED, by `initialState` (`./config.ts`), which reads it to decide where
 * the machine opens and never fires it as a step. Excluding it from both
 * `total` and `dead` reports the machine as it runs — the states are still
 * counted, and `machineStates` already leaves the `InitialNode` itself out for
 * the same reason.
 */
export function walkableTransitions(model: Model, machineId: ElementId): readonly ElementRecord[] {
  const on = stackNodes(model, machineId);
  return regionTransitions(model, machineId).filter((t) => on.has(t.source![0]));
}

/* ───────────────────────────── the producer census ───────────────────────── */

/**
 * What became of one edge under a machine.
 *
 * `unaccounted` is the failure bucket and the whole point of the census: an edge
 * that could carry this machine's control token, that the walk can stand on an
 * end of, and that the relation does not hold. It is empty on every machine this
 * engine walks, because a row in it REFUSES the machine
 * ({@link unsupportedConstructs}) — so the bucket is a test failure and a
 * run-time refusal at once, never a silent shrinking of an absence list.
 */
export type EdgeAccount =
  | 'walked'
  | 'opening'
  | 'refused'
  | 'off-stack'
  | 'not-a-step'
  | 'unaccounted';

/** One edge under a machine, and the sentence that says what became of it. */
export interface EdgeCensusRow {
  id: ElementId;
  eClass: string;
  qualifiedName: string;
  account: EdgeAccount;
  /** Why it is in that bucket — one sentence, in the report's own words. */
  reason: string;
}

/** Every edge-bearing element under a machine, each in exactly one bucket. */
export interface EdgeCensus {
  /** Rows counted, which is `rows.length` and the sum of {@link counts}. */
  total: number;
  rows: readonly EdgeCensusRow[];
  counts: Readonly<Record<EdgeAccount, number>>;
  /** The rows in the failure bucket. Empty on every machine that is walked. */
  unaccounted: readonly EdgeCensusRow[];
}

/**
 * Every edge under the machine, accounted for as walked or refused with a code.
 *
 * WHY A CENSUS AND NOT ANOTHER MECHANISM. Four readers have now found four
 * distinct ways the relation the walk retains differs from the machine an
 * author wrote: dwell labels over-approximating, the cooperative environment
 * over-approximating, an undetermined guard under-approximating, and an edge
 * kind simply absent from the relation. Enumerating the mechanisms has failed
 * four times, and the fifth would be found the same way — by a reader, after a
 * report had already published an absence over it. So the question is inverted,
 * in the same spirit as the verification lane's relation census
 * (`test/integration/verification.differential.test.ts`): the edges are counted
 * WITHOUT asking the walk, and every one of them has to land in a bucket that
 * says what became of it. An edge the walk neither follows nor refuses lands in
 * `unaccounted`, which fails a test and refuses the machine.
 *
 * A census taken from the thing it audits could not see the thing it exists to
 * catch, so the domain is read off the model — every descendant carrying an
 * endpoint — and not off {@link regionTransitions}.
 *
 * THE BUCKETS, and why each is not `unaccounted`:
 *
 *  - `not-a-step` — the metaclass is outside {@link CONTROL_EDGE_KINDS}: it is a
 *    fact ABOUT the states, not a step BETWEEN them. `state idle : Base;` is a
 *    `FeatureTyping` between two elements, `state s5 :> s4;` a `Subsetting`,
 *    `connect a to b;` a `ConnectionUsage`, and none of them ever carries the
 *    control token — the relation being blind to them costs no absence claim.
 *    This bucket exists because the census's first reading did not have it and
 *    refused every machine whose states are typed, which is mainstream notation.
 *  - `walked` — in the step relation, leaving a node some configuration's stack
 *    can hold ({@link stackNodes}): every configuration standing there offers
 *    it. This bucket IS {@link walkableTransitions}, and the transition census
 *    the report prints.
 *  - `opening` — in the step relation, leaving an `InitialNode`: `initialState`
 *    (`./config.ts`) READS it to decide where the machine opens and no step
 *    ever fires it. It is deliberately out of the walkable total — counting an
 *    edge the walk cannot reach would report it dead on every exhaustive walk,
 *    a finding invented by the census rather than found by the walk.
 *  - `refused` — an {@link UnsupportedConstruct} already names it, so the
 *    machine is not walked at all and no absence is published over it.
 *  - `off-stack` — NEITHER end is a node the walk can stand on, computed as the
 *    {@link stackNodes} closure rather than read off a metaclass. A `do`
 *    action's own control flow is under the machine and is not an edge of it; an
 *    edge leaving the machine root is fired by `runHierMachine` outside the
 *    region relation, on a parallel machine this engine refuses before it
 *    starts. The metaclass reading this replaced was not merely imprecise, it
 *    was a hole: a `SuccessionFlow` between two ACTIONS the walk enters from a
 *    state fell through it into `off-stack` and the machine was published
 *    `exhaustive` over an edge nothing had followed — the very claim the census
 *    was built to make impossible.
 */
export function edgeCensus(model: Model, machineId: ElementId): EdgeCensus {
  const relation = new Set(regionTransitions(model, machineId).map((t) => t.id));
  const refusedIds = new Set(danglingTransitions(model, machineId).map((t) => t.id));
  const onStack = stackNodes(model, machineId);
  const rows: EdgeCensusRow[] = [];
  const nameOf = (id: ElementId | undefined): string =>
    id === undefined ? 'nothing' : `\`${model.qualifiedName(id) || id}\``;

  for (const el of model.descendants(machineId)) {
    const from = el.source?.[0];
    const to = el.target?.[0];
    if (from === undefined && to === undefined) continue; // not an edge at all
    const row = (account: EdgeAccount, reason: string): void => {
      rows.push({
        id: el.id,
        eClass: el.eClass,
        qualifiedName: model.qualifiedName(el.id) || el.id,
        account,
        reason,
      });
    };
    const sourceKind = from === undefined ? undefined : model.get(from)?.eClass;
    if (!CONTROL_EDGE_KINDS.has(el.eClass)) {
      row(
        'not-a-step',
        `\`${el.eClass}\` is not a metaclass that sequences behaviour — it states something ABOUT ` +
          'these elements rather than a step between them, so no run of this machine ever carries ' +
          'the control token along it and the relation is complete without it',
      );
    } else if (refusedIds.has(el.id)) {
      row(
        'refused',
        'it names no source or no target, so the walk refuses this machine by name rather than ' +
          'counting the edge dead on a technicality',
      );
    } else if (relation.has(el.id) && sourceKind === 'InitialNode') {
      row(
        'opening',
        '`initialState` reads it to decide where the machine opens; no step fires it, and counting ' +
          'it as walkable would report it dead on every exhaustive walk',
      );
    } else if (relation.has(el.id) && onStack.has(from!)) {
      row(
        'walked',
        `it is in the step relation and leaves ${nameOf(from)}, which a configuration's stack can ` +
          'hold, so every configuration standing there offers it',
      );
    } else if (from === machineId) {
      row(
        'off-stack',
        'it leaves the machine root, which `initialConfig` never pushes onto a stack — it opens the ' +
          'machine at the root\u2019s initial substate, so nothing this walk stands on is the root ' +
          'itself, and the interpreter fires such an edge only as the orthogonal join of a parallel ' +
          'machine, which is refused before this walk starts',
      );
    } else if (
      (from === undefined || !onStack.has(from)) &&
      (to === undefined || !onStack.has(to))
    ) {
      row(
        'off-stack',
        `neither ${nameOf(from)} nor ${nameOf(to)} is a node this walk can stand on — the stack is ` +
          'seeded from the machine\u2019s states and grows only along this relation — so no step of it ' +
          'could traverse this edge whatever the walk did',
      );
    } else {
      row(
        'unaccounted',
        `\`${el.eClass}\` carries a control token, this walk can stand on ${nameOf(
          onStack.has(from!) ? from : to,
        )}, and the step relation does not hold this edge` +
          (payloadOf(el) === undefined
            ? ''
            : `: it carries the payload \`${payloadOf(el)}\`, and this relation models no payload`),
      );
    }
  }

  const counts: Record<EdgeAccount, number> = {
    walked: 0,
    opening: 0,
    refused: 0,
    'off-stack': 0,
    'not-a-step': 0,
    unaccounted: 0,
  };
  for (const r of rows) counts[r.account]++;
  return {
    total: rows.length,
    rows,
    counts,
    unaccounted: rows.filter((r) => r.account === 'unaccounted'),
  };
}

/**
 * Step edges under the machine that do not name both of their ends.
 *
 * {@link CONTROL_EDGE_KINDS} and not `TransitionUsage` alone. `first busy then
 * nowhere;` is the same mistake as `transition busy then nowhere;` written the
 * other way round, and while this filter still said `TransitionUsage` the two
 * spellings got two different answers: the transition got
 * `transition-without-endpoints` and its `Give it both endpoints.`, and the
 * succession fell into `unaccounted` and was refused with a sentence telling its
 * author to write it as a succession, which is what they had written. Two
 * filters that must agree are two filters that will drift — the comment
 * `STEP_EDGE_KINDS` carries — and this was that drift, one function away.
 *
 * Read twice — once by {@link edgeCensus}, to put them in the `refused` bucket,
 * and once by {@link unsupportedConstructs}, which is what actually refuses
 * them — and defined once so the two cannot disagree about which edges those
 * are.
 */
function danglingTransitions(model: Model, machineId: ElementId): ElementRecord[] {
  return model
    .descendants(machineId)
    .filter(
      (e) =>
        CONTROL_EDGE_KINDS.has(e.eClass) &&
        (e.source?.[0] === undefined || e.target?.[0] === undefined),
    );
}

/**
 * The constructs this engine refuses, checked BEFORE the walk.
 *
 * The first three are §3.8's own list. `attrs.parallel` and `attrs.history` are
 * reachable only through the API — `sysml.langium` has no keyword for either —
 * so a machine using them was built by a program, and exploring it as though it
 * were an ordinary machine would report an interleaving this engine does not
 * perform and a history it does not resume. A transition missing an endpoint
 * cannot fire at all, and a walk that ignored it would count it dead on a
 * technicality rather than on a semantics.
 *
 * The fourth is not a construct anybody enumerated, and that is its point. It
 * is whatever the {@link edgeCensus} could not account for: an edge that
 * touches this machine's states and that the relation does not follow. §3.8's
 * list was written by reading the code, which is how an edge kind came to be
 * missing from it — so the last entry is generated FROM the model rather than
 * from a list, and a kind nobody thought about refuses the machine instead of
 * quietly shrinking its absence lists.
 */
function unsupportedConstructs(
  model: Model,
  machineId: ElementId,
  census: EdgeCensus,
): UnsupportedConstruct[] {
  const out: UnsupportedConstruct[] = [];
  const machine = model.get(machineId);
  if (machine && (isTruthy(machine.attrs.parallel) || isTruthy(machine.attrs.isParallel))) {
    out.push({
      construct: 'parallel-regions',
      detail:
        'the machine is marked parallel. The interpreter concatenates regions and this explorer ' +
        'does not interleave them, so no exhaustive answer about a parallel machine is available ' +
        'here; `attrs.parallel` has no keyword in sysml.langium and is set only through the API.',
      elementId: machineId,
    });
  }
  for (const el of [machine, ...model.descendants(machineId)]) {
    if (!el) continue;
    if (isHistoryPseudostate(el) || (el.eClass === 'StateUsage' && isHistoryComposite(model, el.id))) {
      out.push({
        construct: 'history-state',
        detail:
          'the machine resumes a last-active substate. What it resumes depends on how it was left, ' +
          'which this walk does not model as part of the event alphabet; `attrs.history` has no ' +
          'keyword in sysml.langium and is set only through the API.',
        elementId: el.id,
      });
      break;
    }
  }
  for (const tr of danglingTransitions(model, machineId)) {
    out.push({
      construct: 'transition-without-endpoints',
      detail:
        'a step edge names no source or no target, so no run can fire it and no walk can say ' +
        'whether it would have. Give it both endpoints.',
      elementId: tr.id,
    });
  }
  // The detail is the census ROW'S OWN sentence, not a fixed one. A single
  // hardcoded remedy told the author of `first busy then nowhere;` to write it
  // as a succession — which is what they had written — and the same words would
  // have been printed over every other way an edge can go unaccounted. What a
  // reader can act on is why THIS edge is not in the relation, so that is what
  // is printed.
  for (const row of census.unaccounted) {
    out.push({
      construct: 'edge-not-walked',
      detail:
        `\`${row.qualifiedName}\` is an edge of this machine the walk does not follow: ${row.reason}. ` +
        'The configuration graph is missing an edge the machine has, so no absence over it would be ' +
        'a claim about the machine as written.',
      elementId: row.id,
    });
  }
  return out;
}

/* ────────────────────────────── the walk ────────────────────────────────── */

interface Frontier {
  config: MachineConfig;
  depth: number;
  /** Consecutive completion steps taken to reach this configuration. */
  completionRun: number;
}

/*
 * A COMPLETION CYCLE IS NOT A BOUND HIT, and the distinction is worth stating
 * because the interpreter's `completionBudgetHit` looks like it says otherwise.
 *
 * They answer different questions. `runStateMachine` reports whether THAT RUN
 * was cut off mid-chase; on a machine whose completion transitions cycle
 * (`FlightModes` in `examples/uav-isr.sysml` is one — standby → manual →
 * autonomous → manual …) every run is cut off, and it says so. The walk reports
 * whether it saw the whole configuration GRAPH; a cycle re-enters configurations
 * it has already hashed, so nothing downstream of it is unexplored and the
 * absence lists are exact. The two are consistent, not contradictory: one is a
 * fact about a run, the other about a graph.
 *
 * What the counter below is for is the case where something IS unexplored — a
 * chain of more than `maxCompletion` distinct completion steps, whose far end no
 * interpreter run can reach, so the walk stops there and suppresses rather than
 * reporting states beyond it as unreachable. §3.8's own example of the condition
 * is that chain, and its own example of an exhaustive walk is `FlightModes`,
 * which cycles. `test/unit/semantics.mc.reach.test.ts` pins both readings side
 * by side so neither can drift into the other.
 */

/**
 * Explore the configuration graph of the machine rooted at `machineId`.
 *
 * Breadth-first, so the depth recorded against a configuration is the SHORTEST
 * walk to it, which is what makes the completion-run counter mean what it says:
 * the number of trigger-less steps the interpreter's own chase would have taken
 * in a row before reaching here. When that count reaches the chase budget, the
 * interpreter would have run out of it, and this walk says so rather than
 * pretending it settled.
 */
export function exploreMachine(
  model: Model,
  machineId: ElementId,
  opts: ExploreOptions = {},
): ExploreResult {
  const bounds: ExploreBounds = {
    maxConfigs: Math.max(1, opts.maxConfigs ?? DEFAULT_MAX_CONFIGS),
    maxDepth: Math.max(0, opts.maxDepth ?? DEFAULT_MAX_DEPTH),
    maxCompletion: Math.max(0, opts.maxCompletion ?? MAX_COMPLETION),
    alphabet: machineAlphabet(model, machineId),
  };
  const census = edgeCensus(model, machineId);
  const unsupported = unsupportedConstructs(model, machineId, census);
  const reachable = new Set<ElementId>();
  const fired = new Set<ElementId>();
  const offered = new Set<string>();
  const nondeterminism: NondeterministicChoice[] = [];
  const deadlocks: DeadlockRow[] = [];
  // ONE row per transition, not one per configuration it was consulted at: a
  // guard over an unvalued feature is undetermined at every configuration the
  // walk offers it, and a reader needs the transition once, not a row per state
  // of a store the guard does not depend on.
  const undeterminedGuards = new Map<ElementId, UndeterminedGuardRow>();

  // A construct this engine does not explore ends the answer here. Walking the
  // machine anyway and marking the result non-exhaustive would publish a
  // reachable set computed under semantics the report says it does not
  // implement — a figure worse than no figure.
  if (unsupported.length > 0) {
    return {
      machineId,
      bounds,
      configs: 0,
      depth: 0,
      exhaustive: false,
      boundHit: 'none',
      reachable,
      fired,
      offered,
      nondeterminism,
      deadlocks,
      unsupported,
      census,
      undeterminedGuards: [],
    };
  }

  const inputs: StepInput[] = [
    { kind: 'completion' },
    ...bounds.alphabet.map((trigger): StepInput => ({ kind: 'trigger', trigger })),
  ];

  // The same opening store the interpreter starts from: every literal feature
  // value inside the machine, by name. A walk that started from an empty store
  // would evaluate the first guard against a different world (`seedStore` is
  // what `runStateMachine` does before it enters anything).
  const seeded = new Map<string, unknown>();
  const machineEl = model.get(machineId);
  if (machineEl) seedStore(model, machineEl, seeded);
  const opening = initialConfig(model, machineId, { store: seeded });
  for (const v of opening.effects.visited) reachable.add(v);
  const seen = new Set<string>([hashConfig(opening.config)]);
  const queue: Frontier[] = [{ config: opening.config, depth: 0, completionRun: 0 }];
  let boundHit: BoundHit = 'none';
  let depth = 0;
  const nondetSeen = new Set<string>();
  const deadlockSeen = new Set<ElementId>();

  while (queue.length > 0) {
    const here = queue.shift()!;
    depth = Math.max(depth, here.depth);
    let anyEnabled = false;

    for (const input of inputs) {
      if (input.kind === 'trigger') offered.add(input.trigger);
      const { enabled, undetermined } = stepCandidates(model, here.config, input, true);
      // Recorded whether or not anything was enabled, and BEFORE the early
      // `continue` below: a configuration where the only outgoing edge is an
      // undetermined guard has nothing enabled, and it is exactly the one whose
      // deadlock row would otherwise be published over a question nothing
      // answered.
      for (const u of undetermined) {
        const seenRow = undeterminedGuards.get(u.transition.id);
        if (seenRow === undefined) {
          undeterminedGuards.set(u.transition.id, {
            transition: transitionRef(model, u.transition),
            guard: u.guard,
            unresolved: [...u.unresolved],
          });
        } else {
          // The same guard can be undetermined over DIFFERENT names at
          // different configurations (a store that gained one of them on the
          // way here), and the row names every name that was ever missing —
          // dropping the later ones would send an author to fix half of it.
          const union = new Set([...seenRow.unresolved, ...u.unresolved]);
          undeterminedGuards.set(u.transition.id, { ...seenRow, unresolved: [...union] });
        }
      }
      if (enabled.length === 0) continue;
      anyEnabled = true;
      // The interpreter fires `enabled[0]`, and the list is innermost level
      // first: a transition at an OUTER level is beaten by the priority rule
      // and fires in no run at all while an inner one is enabled. Every one of
      // them is still counted FIRED — `dead` means never enabled anywhere
      // reachable — but only the innermost level generates successors and only
      // it can hold a hidden choice, because a configuration reached by firing
      // a beaten transition is one no run enters, and a deadlock or an
      // ambiguity reported there is invented rather than found.
      const innermost = enabled[0].level;
      // AND NOT OVER A WITHHELD INNER EDGE. A hidden choice is an existential
      // claim, and at ONE level a withheld edge can only ever remove a
      // candidate from it — but `innermost` is read off the enabled list, so an
      // undetermined guard STRICTLY INSIDE it lowers the level this row is
      // recorded at and lets outer transitions the priority rule would have
      // beaten into the filter. Measured: `Outer -go-> O1`, `Outer -go-> O2`
      // and a guarded self-loop on a substate reports a choice at `Outer` when
      // the guard is unvalued and reports none when the same guard is decided
      // TRUE — a row manufactured by the withholding, which is the one thing
      // this lane may not do. Rows at or outside a level that is still fully
      // decided stand.
      const withheldInside = undetermined.some((u) => u.level > innermost);
      if (!withheldInside) {
        recordNondeterminism(
          model,
          here.config,
          input,
          enabled.filter((e) => e.level === innermost),
          nondetSeen,
          nondeterminism,
        );
      }

      for (const choice of enabled) {
        fired.add(choice.transition.id);
        if (choice.level !== innermost) continue;
        const next = stepConfig(model, here.config, choice);
        for (const v of next.effects.visited) reachable.add(v);
        const key = hashConfig(next.config);
        if (seen.has(key)) continue;

        const run = input.kind === 'completion' ? here.completionRun + 1 : 0;
        // `>`, not `>=`: the interpreter's chase fires `maxCompletion`
        // transitions and only THEN asks whether anything is still enabled, so
        // a configuration reached in exactly `maxCompletion` completion steps
        // is one it reaches cleanly. Refusing it would print "a completion
        // chain longer than the 64-step chase budget was found" about a chain
        // that is not longer than it.
        if (run > bounds.maxCompletion) {
          // The interpreter's chase would have spent its whole budget on this
          // chain without reaching quiescence. Recorded as a bound hit for the
          // same reason a configuration bound is: everything downstream of it
          // is unexplored.
          boundHit = 'completion';
          continue;
        }
        if (here.depth + 1 > bounds.maxDepth) {
          boundHit = 'depth';
          continue;
        }
        if (seen.size >= bounds.maxConfigs) {
          boundHit = 'configs';
          continue;
        }
        seen.add(key);
        queue.push({ config: next.config, depth: here.depth + 1, completionRun: run });
      }
    }

    if (!anyEnabled) recordDeadlock(model, here, deadlockSeen, deadlocks);
  }

  return {
    machineId,
    bounds,
    configs: seen.size,
    depth,
    exhaustive: boundHit === 'none',
    boundHit,
    reachable,
    fired,
    offered,
    nondeterminism,
    deadlocks,
    unsupported,
    census,
    undeterminedGuards: [...undeterminedGuards.values()],
  };
}

/**
 * Record a hidden choice — and only a REAL one.
 *
 * Two transitions leaving the SAME state on one event is a choice the notation
 * does not resolve: declaration order decides it, and declaration order is not
 * a semantics. Two transitions at DIFFERENT levels of the active stack is a
 * different thing entirely — the innermost wins, that is the profile's stated
 * priority rule, and reporting a stated rule as an ambiguity would bury the
 * real finding under noise. So the grouping is by state, and the caller has
 * already dropped every level the priority rule beats: a choice that does not
 * decide anything here is not a choice, and where the outer state IS the
 * innermost enabled level the walk reaches that configuration too and records
 * it there.
 */
function recordNondeterminism(
  model: Model,
  cfg: MachineConfig,
  input: StepInput,
  enabled: readonly EnabledTransition[],
  seen: Set<string>,
  out: NondeterministicChoice[],
): void {
  const byLevel = new Map<number, EnabledTransition[]>();
  for (const e of enabled) {
    const list = byLevel.get(e.level);
    if (list) list.push(e);
    else byLevel.set(e.level, [e]);
  }
  const event = input.kind === 'trigger' ? input.trigger : input.kind === 'completion' ? '' : 'after';
  for (const [level, list] of byLevel) {
    if (list.length < 2) continue;
    const stateId = cfg.stack[level];
    const key = `${stateId}|${event}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = list.map((e) => transitionRef(model, e.transition));
    out.push({
      state: stateRef(model, stateId),
      event,
      enabled: rows,
      taken: rows[0],
      notTaken: rows.slice(1),
    });
  }
}

/**
 * Is this leaf a place the machine is SUPPOSED to stop?
 *
 * Two spellings, and both have to be here. `state done { … }` with
 * `attrs.kind = 'final'` is what {@link isFinalState} reads, and it is the only
 * one an API-built machine has. But the ordinary, checker-clean way to end a
 * machine in the notation is the `done` keyword, which the mapper turns into a
 * `DoneNode` control node (`src/text/langium/map-to-model.ts`:124) carrying no
 * `kind` at all — so a machine written the normal way would have been reported
 * `verification/deadlock` at its own ending, with a hint telling the author to
 * mark final something that already is an ending.
 *
 * Read HERE rather than by widening `isFinalState`, deliberately: that function
 * is the interpreter's `complete` / `finalState` predicate, the differential
 * test pins it, and a `DoneNode` is not a final STATE — it is a terminal node
 * that happens to end the same run.
 */
function isTerminalNode(model: Model, id: ElementId): boolean {
  const el = model.get(id);
  if (!el) return false;
  return el.eClass === 'DoneNode' || el.attrs.kind === 'done';
}

/** A configuration nothing leaves, unless its leaf is where the machine ends. */
function recordDeadlock(
  model: Model,
  here: Frontier,
  seen: Set<ElementId>,
  out: DeadlockRow[],
): void {
  const leaf = leafOf(here.config);
  if (leaf === null) return;
  if (isFinalState(model, leaf)) return; // an ending, not a deadlock
  if (isTerminalNode(model, leaf)) return; // `done` — the same ending, spelled in the notation
  if (seen.has(leaf)) return;
  seen.add(leaf);
  out.push({
    leaf: stateRef(model, leaf),
    stack: here.config.stack.map((s) => stateRef(model, s)),
    steps: here.depth,
  });
}

/* ─────────────────────────────── the report ─────────────────────────────── */

/** One machine's answer. */
export interface MachineReach {
  machine: StateRef & { eClass: string };
  bounds: ExploreBounds;
  configs: number;
  depth: number;
  exhaustive: boolean;
  boundHit: BoundHit;
  /**
   * The sentence every figure below is true UNDER. Printed on every row that
   * claims an absence, because "unreachable" without its bounds is a claim this
   * engine cannot make.
   */
  qualification: string;
  states: {
    total: number;
    reachable: readonly StateRef[];
    /** EMPTY whenever the walk was not exhaustive — suppressed, never partial. */
    unreachable: readonly StateRef[];
  };
  transitions: {
    /** The {@link walkableTransitions} census, not every edge in the machine. */
    total: number;
    fired: number;
    /** EMPTY whenever the walk was not exhaustive, for the same reason. */
    dead: readonly TransitionRef[];
  };
  nondeterminism: readonly NondeterministicChoice[];
  /**
   * EMPTY whenever a guard was undetermined — a deadlock row is an absence
   * claim about ONE configuration's outgoing edges, and an edge the walk could
   * not decide is exactly what makes it wrong.
   */
  deadlocks: readonly DeadlockRow[];
  unsupported: readonly UnsupportedConstruct[];
  /**
   * Every edge under this machine, walked or refused — see {@link edgeCensus}.
   *
   * Published on `--json` and not in the text block, because it is the kill
   * MEASUREMENT for a whole class of defect rather than a finding a reader acts
   * on: what a reader acts on is the refusal an `unaccounted` row produces,
   * which is already a `verification/behaviour-unsupported-construct` row above.
   */
  census: EdgeCensus;
  /** The guards this walk consulted and could not evaluate. Never `false`. */
  undeterminedGuards: readonly UndeterminedGuardRow[];
  /** True when the two absence lists were withheld — by a bound, or by an undecided guard. */
  suppressed: boolean;
}

/** What `reach` publishes. */
export interface ReachReport {
  machines: readonly MachineReach[];
  /** The reading every figure holds under (plan §3.8). */
  profile: readonly ProfileField[];
  totals: {
    machines: number;
    /** Machines walked to exhaustion. */
    exhaustive: number;
    configs: number;
    unreachable: number;
    dead: number;
    nondeterministic: number;
    deadlocks: number;
  };
  diagnostics: Diagnostic[];
}

/** Options `reach` takes. */
export interface ReachOptions extends ExploreOptions {
  /** Only machines at or inside this element. */
  scopeId?: ElementId;
}

/**
 * The state machines of a model: every non-library element that directly owns a
 * TransitionUsage — plus any element marked parallel that CONTAINS one — and is
 * not itself inside another such element.
 *
 * The first half is the rule `executionReport` already uses, so the two
 * surfaces agree about what a machine is. The other two halves are this
 * command's own and both close a hole. A composite state that owns transitions
 * is a REGION of its parent machine, not a machine: reporting both would
 * explore the inner one twice and publish two reachable sets for one behaviour.
 * And a PARALLEL container usually owns no transition at all — its regions do —
 * so without the second clause a parallel machine would be reported as two
 * independent machines and walked as though the regions never interacted, which
 * is precisely the answer §3.8 says this engine must refuse to give.
 */
export function stateMachinesIn(model: Model, scopeId?: ElementId): ElementRecord[] {
  const owners = model.all().filter((el) => {
    if (el.attrs.isLibrary === true) return false;
    if (model.children(el.id).some((c) => c.eClass === 'TransitionUsage')) return true;
    return (
      (isTruthy(el.attrs.parallel) || isTruthy(el.attrs.isParallel)) &&
      model.descendants(el.id).some((d) => d.eClass === 'TransitionUsage')
    );
  });
  const ownerIds = new Set(owners.map((o) => o.id));
  const roots = owners.filter((el) => {
    let p: ElementId | null | undefined = el.ownerId;
    while (p != null) {
      if (ownerIds.has(p)) return false;
      p = model.get(p)?.ownerId;
    }
    return true;
  });
  if (scopeId === undefined) return roots;
  const inScope = new Set<ElementId>([scopeId, ...model.descendants(scopeId).map((d) => d.id)]);
  return roots.filter((r) => inScope.has(r.id));
}

/** `{maxConfigs …, maxDepth …, maxCompletion …, alphabet …}`, spelled out. */
function boundsSentence(b: ExploreBounds): string {
  const alphabet = b.alphabet.length === 0 ? 'no named trigger' : b.alphabet.join(', ');
  return `{maxConfigs ${b.maxConfigs}, maxDepth ${b.maxDepth}, maxCompletion ${b.maxCompletion}, alphabet ${alphabet}}`;
}

/** Why a walk stopped, in the words the report prints. */
function boundSentence(hit: BoundHit): string {
  switch (hit) {
    case 'configs':
      return 'the configuration bound was reached';
    case 'depth':
      return 'the depth bound was reached';
    case 'completion':
      return `a completion chain longer than the ${MAX_COMPLETION}-step chase budget was found`;
    default:
      return '';
  }
}

/**
 * Walk one machine and turn the walk into rows.
 *
 * The four conditions of §3.8 — exhaustive, no completion budget spent, every
 * named trigger offered, no unsupported construct — and the fifth this tool
 * learned the hard way, that every guard the walk consulted decided something,
 * are `publishabilityOf(walk).decreasingOk` in `./publishable`. THEY ARE NOT
 * COMPUTED HERE ANY MORE, and that is the repair: this function and
 * `checkProperty` each carried their own copy, each with a comment saying the
 * other must not be deleted alone, and they drifted apart anyway.
 */
function reachOne(model: Model, machine: ElementRecord, opts: ExploreOptions): MachineReach {
  const walk = exploreMachine(model, machine.id, opts);
  // The fifth condition, named on its own because it gates one MORE list than
  // the other four do. A guard the walk could not evaluate is not a guard that
  // is false, so nothing this walk saw establishes that a transition is never
  // enabled, that a state is never entered — or that a configuration has no way
  // out, which is the same absence read over one configuration's outgoing edges.
  const guardsDecided = walk.undeterminedGuards.length === 0;
  // THE CONJUNCTION ITSELF LIVES IN ONE PLACE NOW. It used to be written out
  // here and again in `checkProperty`, with a comment in each saying the other
  // must not be deleted alone — and the two DID drift apart for exactly one
  // commit. `decreasingOk` is those same four conjuncts, in the same order, over
  // the same walk; `guardsDecided` stays local because the deadlock row below
  // is gated on it ALONE and reads it separately.
  const publishable = publishabilityOf(walk).decreasingOk;

  const states = machineStates(model, machine.id);
  const transitions = walkableTransitions(model, machine.id);
  const reachable = states.filter((s) => walk.reachable.has(s.id)).map((s) => stateRef(model, s.id));
  const unreachable = publishable
    ? states.filter((s) => !walk.reachable.has(s.id)).map((s) => stateRef(model, s.id))
    : [];
  const dead = publishable
    ? transitions.filter((t) => !walk.fired.has(t.id)).map((t) => transitionRef(model, t))
    : [];

  // The word `exhaustive` appears in exactly one branch, and an undetermined
  // guard is not it: the walk finished, so "partial" would be false too, and
  // saying either would be the report answering a question it declined.
  const qualification = publishable
    ? `exhaustive under ${boundsSentence(walk.bounds)}`
    : walk.unsupported.length > 0
      ? `not explored — ${walk.unsupported.map((u) => u.construct).join(', ')}; no figure below is a claim of absence`
      : !guardsDecided
        ? // BOTH causes, when both are present. An undetermined guard is fixed
          // in the model and a bound is raised with `--max-configs`; a reader
          // shown only the first would raise nothing and wonder why the walk
          // stayed short after they valued the feature.
          `undetermined under ${boundsSentence(walk.bounds)} — ${walk.undeterminedGuards.length} guard(s) the walk could not evaluate${
            walk.boundHit === 'none' ? '' : `, and ${boundSentence(walk.boundHit)}`
          }; the unreachable, dead and no-way-out lists are WITHHELD and are NOT reported as findings`
        : `partial under ${boundsSentence(walk.bounds)} — ${
            walk.boundHit === 'none'
              ? 'a trigger the machine names was never offered'
              : boundSentence(walk.boundHit)
          }; the unreachable and dead lists are lower bounds and are NOT reported as findings`;

  return {
    machine: {
      id: machine.id,
      name: machine.declaredName ?? '',
      qualifiedName: model.qualifiedName(machine.id) || machine.id,
      eClass: machine.eClass,
    },
    bounds: walk.bounds,
    configs: walk.configs,
    depth: walk.depth,
    exhaustive: publishable,
    boundHit: walk.boundHit,
    qualification,
    states: { total: states.length, reachable, unreachable },
    transitions: { total: transitions.length, fired: walk.fired.size, dead },
    // PUBLISHED ON A PARTIAL WALK, and the asymmetry is deliberate. A hidden
    // choice is an EXISTENTIAL claim — two transitions were enabled at once in
    // a configuration this walk reached — and a BOUND cannot manufacture one:
    // it stops the walk enqueueing successors and takes nothing away from a
    // configuration already dequeued. The two absence claims run the other way,
    // which is why they are gated here and this is not.
    //
    // A WITHHELD EDGE IS NOT AS INNOCENT, and the narrow true statement is the
    // one to hold on to: removing a candidate at the SAME level can only shrink
    // a choice. Removing one at a STRICTLY INNER level moves which level the
    // choice is read at, and that CAN invent a row — so `exploreMachine`
    // declines to record one there, and what survives to here was found at a
    // level nothing inside was withheld from.
    census: walk.census,
    nondeterminism: walk.nondeterminism,
    // Gated on the guards ALONE, not on `publishable`. A deadlock row says one
    // configuration the walk REACHED had no enabled edge out, and a bound
    // cannot make that wrong — the walk evaluates every input at a
    // configuration it dequeues, and a bound only stops it enqueueing
    // successors. An undetermined guard CAN make it wrong: it is an edge out
    // that may have been enabled, and nothing here decided whether it was.
    deadlocks: guardsDecided ? walk.deadlocks : [],
    unsupported: walk.unsupported,
    undeterminedGuards: walk.undeterminedGuards,
    suppressed: !publishable,
  };
}

/**
 * Which states are reachable, which transitions are dead, and where did the
 * simulator hide a choice (plan §3.8).
 *
 * Reports; it does not judge. There is no verdict here and no exit code of its
 * own — a state nobody reaches is a fact about a machine, not a violated
 * requirement — which is why every row is a `verification/*` finding and none
 * of them is an error.
 */
export function reachReport(model: Model, opts: ReachOptions = {}): ReachReport {
  const { scopeId, ...explore } = opts;
  const machines = stateMachinesIn(model, scopeId).map((m) => reachOne(model, m, explore));
  const findings: Array<Omit<Diagnostic, 'id' | 'ruleId' | 'source'>> = [];

  for (const m of machines) {
    for (const u of m.unsupported) {
      findings.push({
        severity: 'info',
        message: `\`${m.machine.qualifiedName}\` is not explored: ${u.detail}`,
        ...(u.elementId ? { elementId: u.elementId } : {}),
        elementName: m.machine.qualifiedName,
        code: BEHAVIOUR_UNSUPPORTED_CODE,
        hint: 'Nothing below this line is a claim of absence: the machine was not walked, so no state is reported unreachable and no transition dead.',
      });
    }
    // BEFORE the absence rows, and never suppressed: this finding IS the reason
    // the lists below it are short, and a reader who meets an empty unreachable
    // list without it reads the shortness as good news.
    for (const g of m.undeterminedGuards) {
      const names =
        g.unresolved.length > 0
          ? `no value is in scope for ${g.unresolved.map((n) => `\`${n}\``).join(', ')}`
          : 'this walk could not read it as a value at all';
      findings.push({
        severity: 'warning',
        message:
          `the guard \`${g.guard}\` on transition \`${transitionLabel(g.transition)}\` could not be ` +
          `evaluated — ${names}. The walk did not decide whether it holds, so the unreachable, dead ` +
          'and no-way-out lists for this machine are withheld.',
        elementId: g.transition.id,
        elementName: g.transition.qualifiedName,
        code: GUARD_UNDETERMINED_CODE,
        // TWO DEFECTS, TWO HINTS. A guard with an unresolved name wants a value;
        // a guard that named nothing missing and still yielded nothing has a
        // type error inside it (`not mode` over an Integer `mode`, a mixed-type
        // comparison, a division by zero), and telling its author to give a
        // value to a feature that already has one sends them to look at the one
        // thing that is fine.
        hint:
          g.unresolved.length > 0
            ? 'Give the feature a value the walk can read — `attribute mode : Integer = 3;` — or drive the machine from a state that assigns it. This is NOT a claim that the guard is false: a guard nothing decided is not a guard that never holds, which is why no absence is reported over it.'
            : 'Every name in this guard resolves, so the guard did not evaluate to a value for some other reason — most often that it is not a predicate (`if mode` needs a comparison), that it compares two different kinds of value, or that its arithmetic is not finite. This is NOT a claim that the guard is false: a guard nothing decided is not a guard that never holds, which is why no absence is reported over it.',
      });
    }
    if (m.boundHit !== 'none') {
      findings.push({
        severity: 'info',
        message:
          `\`${m.machine.qualifiedName}\`: ${boundSentence(m.boundHit)} after ${m.configs} configuration(s) — ` +
          'partial. The unreachable and dead lists are lower bounds and are NOT reported as findings.',
        elementId: m.machine.id,
        elementName: m.machine.qualifiedName,
        code: BOUND_EXHAUSTED_CODE,
        hint: 'Raise the bound (`--max-configs N`) and re-run, or read the run as what it is: a partial walk. A bound is printed on every figure precisely so it can never be read as exhaustion.',
      });
    }
    for (const s of m.states.unreachable) {
      findings.push({
        severity: 'warning',
        message: `state \`${s.qualifiedName}\` is not entered on any explored run (${m.qualification}).`,
        elementId: s.id,
        elementName: s.qualifiedName,
        code: UNREACHABLE_STATE_CODE,
        hint: 'Either a transition into it is missing or its guard can never hold. The claim holds under the printed bounds and the alphabet beside them, and under no others.',
      });
    }
    for (const t of m.transitions.dead) {
      findings.push({
        severity: 'warning',
        message: `transition \`${transitionLabel(t)}\` is never enabled on any explored run (${m.qualification}).`,
        elementId: t.id,
        elementName: t.qualifiedName,
        code: DEAD_TRANSITION_CODE,
        hint: 'Its source is unreachable, or its guard never holds where it is. Note the reading: dead means never ENABLED anywhere reachable, so a transition an inner state’s priority always beats is enabled and is not reported here.',
      });
    }
    for (const d of m.deadlocks) {
      findings.push({
        severity: 'warning',
        message: `state \`${d.leaf.qualifiedName}\` has no enabled outgoing transition and is not marked final — reached in ${d.steps} step(s).`,
        elementId: d.leaf.id,
        elementName: d.leaf.qualifiedName,
        code: DEADLOCK_CODE,
        hint: 'Give it a way out, or mark it final if stopping there is the intent. This is a reading of THIS machine under the printed alphabet, never a statement that the system deadlocks.',
      });
    }
    for (const n of m.nondeterminism) {
      const on = n.event === '' ? 'as completion transitions (no trigger)' : `on \`${n.event}\``;
      findings.push({
        severity: 'warning',
        message:
          `\`${n.state.qualifiedName}\`: ${n.enabled.length} transitions are enabled at once ${on} — ` +
          `the simulator takes \`${transitionLabel(n.taken)}\` (declaration order) and never ` +
          `${n.notTaken.map((t) => `\`${transitionLabel(t)}\``).join(', ')}.`,
        elementId: n.state.id,
        elementName: n.state.qualifiedName,
        code: NONDETERMINISTIC_CHOICE_CODE,
        hint: 'Declaration order is not a semantics: give the transitions guards that cannot both hold, or different triggers. Until then one of them is unreachable in simulation while the model admits both.',
      });
    }
  }

  return {
    machines,
    profile: SEMANTIC_PROFILE,
    totals: {
      machines: machines.length,
      exhaustive: machines.filter((m) => m.exhaustive).length,
      configs: machines.reduce((n, m) => n + m.configs, 0),
      unreachable: machines.reduce((n, m) => n + m.states.unreachable.length, 0),
      dead: machines.reduce((n, m) => n + m.transitions.dead.length, 0),
      nondeterministic: machines.reduce((n, m) => n + m.nondeterminism.length, 0),
      deadlocks: machines.reduce((n, m) => n + m.deadlocks.length, 0),
    },
    diagnostics: findings.map((d, i) => ({
      id: `verification#${i}`,
      ruleId: 'verification',
      source: 'verification',
      ...d,
    })),
  };
}

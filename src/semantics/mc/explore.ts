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
 * the two lists are published only when the walk was exhaustive, every
 * trigger the machine names was actually offered, no unsupported construct was
 * met, and every guard it consulted DECIDED something. (The interpreter's
 * completion-chase budget is not among them: it is part of the semantics the
 * walk follows, not a bound that cuts it — see the note above
 * `exploreMachine`.) Otherwise they come back EMPTY with
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
 * than advancing a clock, and by sending every trigger the machine names at
 * each place a run takes an event, as no real environment need. An
 * over-approximation can only shrink the absence claims, never invent one,
 * which is the direction a finding may be wrong in.
 *
 * WHERE AN EVENT IS OFFERED IS NOT LOOSE. On a walk that finished, the walk
 * offers the alphabet exactly where it can decide that `runStateMachine` takes
 * its next event: at a configuration where no completion transition is due,
 * and at one where the interpreter's chase budget is spent with a completion
 * transition still due (the note above `exploreMachine`). Everywhere else the
 * interpreter chases before it takes any event, and the walk offers completion
 * alone. THE ONE PLACE IT CANNOT DECIDE, IT FAILS CLOSED: where nothing is due
 * but a completion transition whose guard is undecided, the interpreter reads
 * the guard as false and takes its next event, and the walk, which cannot tell
 * whether a run chases there or takes one, offers no trigger at all — so it
 * holds fewer runs than the interpreter makes, and the store clause
 * (`verification/guard-undetermined`) withholds every absence on that machine.
 * (A walk a bound stopped short decides less still: without the chase position
 * it takes no event where the budget would stop a chase its frontier hides —
 * and a partial walk publishes no absence either.) So on a walk that finished,
 * over guards it decided, every run the interpreter makes on a sequence of the
 * named triggers is a run of the walk, and an absence the walk publishes holds
 * of every such run: it is exact over that semantics, not over an approximation
 * of where events arrive. The runs the walk holds beyond the interpreter's are the
 * dwells above, the tie-break below and, on a machine that names no trigger,
 * the chase past the budget the note above `exploreMachine` lets it follow —
 * and those only shorten the absence lists. (The walk once offered every
 * trigger wherever it stood, a completion due or not: runs the profile forbids.
 * H1, `0c9d2bd`, confined it to the first of the two places and lost the runs
 * the budget lets through at the second, which published a false `unreachable`
 * and `dead` — review B's C1.)
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
 * enabled transition as not dead — `dead` means never ENABLED anywhere
 * reachable, which is the reading the finding's hint states. What it counts as
 * `fired` is narrower: the transitions a step of some explored run takes, so a
 * beaten one is neither dead nor fired.
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
  afterDuration,
  hashConfig,
  initialConfig,
  isFinalState,
  isHistoryComposite,
  isHistoryPseudostate,
  isTruthy,
  leafOf,
  outsideStatesSentence,
  regionDescendants,
  regionTransitions,
  resumesHistory,
  seedStore,
  stepCandidates,
  stepConfig,
  stepOutsideStates,
  triggerLabelOf,
  type EnabledTransition,
  type MachineConfig,
  type StepCandidates,
  type StepInput,
  type UndeterminedGuard,
} from './config';
import { SEMANTIC_PROFILE, type ProfileField } from './profile';
// One definition of "may this absence be stated", read by this file and by
// `./patterns`, so the two cannot drift apart again. `walkIsExact` is the OTHER
// predicate in that file — the gate for the increasing side — and it now gates
// exactly ONE published field, the trap list (register row A6): every other
// row this command prints keeps reading the decreasing conjunction, which is
// what keeps a machine carrying a dwell from losing a sound unreachable-state
// finding to a gate built for the claims that grow.
import {
  CLAUSE_SENTENCE,
  SIMULATOR_SENTENCE,
  publishabilityOf,
  walkIsExact,
  type Exactness,
  type FailedClause,
} from './publishable';
// The component arithmetic, over the relation the walk retained. It answers
// what it is asked about the graph it is given; whether the answer may be
// published at all is the gate's question and is asked first — `trapsOf` below
// is called only where the gate holds, and the census beside it is what a
// refused walk publishes instead.
import { acyclic, bottomComponents, tarjanComponents, type Components } from './scc';
// The same reader the step relation uses to decide an edge carries an item, so
// the census can say WHY that edge is not in the relation in the relation's own
// terms rather than in a sentence of its own.
import { payloadOf } from '../connectors';
// A step written in a specialisation or a typed usage over the states it
// inherits is a crossing like any other; the refusal names the inheritance,
// because its remedy is not the one for a nested definition.
import { generalizationsOf } from '../inheritance';

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
/** A set of reachable configurations no run leaves, that is not where the machine ends. */
export const UNRECOVERABLE_MODE_CODE = 'verification/unrecoverable-mode';
/**
 * A reachable cycle the interpreter's completion chase goes round without
 * coming to rest: only an event moves the run on (U1, plan O1 S4; see
 * {@link LivelockRow}).
 */
export const COMPLETION_LIVELOCK_CODE = 'verification/completion-livelock';

/** Every code this module can put in front of a reader, for the catalogue guard. */
export const BEHAVIOUR_CODES: ReadonlySet<string> = new Set([
  UNREACHABLE_STATE_CODE,
  DEAD_TRANSITION_CODE,
  DEADLOCK_CODE,
  NONDETERMINISTIC_CHOICE_CODE,
  BOUND_EXHAUSTED_CODE,
  BEHAVIOUR_UNSUPPORTED_CODE,
  GUARD_UNDETERMINED_CODE,
  UNRECOVERABLE_MODE_CODE,
  COMPLETION_LIVELOCK_CODE,
]);

/**
 * The seven this engine raises as WARNINGS, and none of the nine as an error.
 *
 * The reading rule, not an omission. An error in this lane is reserved for a
 * refuted obligation, and `reach` refutes nothing. But the seven below are
 * findings about a MACHINE — a state nothing reaches, a transition nothing
 * fires, a state nothing leaves, a set of configurations nothing leaves, a
 * cycle the chase never rests on, a choice the notation does not resolve, a
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
  UNRECOVERABLE_MODE_CODE,
  COMPLETION_LIVELOCK_CODE,
]);

/* ────────────────────────────── the bounds ──────────────────────────────── */

/** Configurations explored before the walk gives up. */
export const DEFAULT_MAX_CONFIGS = 10_000;
/**
 * Events from the opening configuration before a branch is abandoned — the
 * `maxDepth` every bounds sentence prints. An EVENT, not a step: a completion
 * step is not counted, because the chase budget already stops a chase after
 * `maxCompletion` of them (`docs/06` §8.12). So the `depth` a walk prints, its
 * steps with the completion steps among them, can be larger than this.
 */
export const DEFAULT_MAX_DEPTH = 200;

/**
 * Which bound stopped the walk, if any.
 *
 * `'completion'` is never on a walk `exploreMachine` returns: the chase budget
 * is followed, not cut (see the note above it). It is what the product search
 * in `./patterns` reports if, over a walk that hashed without the chase
 * position, it ever met a chase longer than the budget that a run could go on
 * from — a run it refuses rather than reports on. On a machine that names no
 * trigger and has no dwell, nothing follows a chase the budget stops, so the
 * search ends that run there instead.
 */
export type BoundHit = 'none' | 'configs' | 'depth' | 'completion';

/** The bounds a walk ran under, printed beside every figure it produced. */
export interface ExploreBounds {
  maxConfigs: number;
  /** Events, not steps, from the opening ({@link DEFAULT_MAX_DEPTH}). */
  maxDepth: number;
  maxCompletion: number;
  /**
   * The events offered wherever the walk can decide that the interpreter takes
   * its next event — where no completion transition is due, or where the chase
   * budget is spent (not where nothing is due but a completion guard it could
   * not decide: the header): the triggers the machine names.
   */
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

/**
 * A set of reachable configurations no run leaves — a bottom strongly-connected
 * component of the retained relation that is neither an ending, nor a single
 * configuration with no successor (already a deadlock row), nor the component
 * holding the opening (plan §3.2a).
 *
 * Published only where the walk is EXACT (register row A6): a missing edge
 * invents one of these, and a bound, an unsupported construct and an undecided
 * guard each remove edges the machine states, while a dwell and a named trigger
 * add edges no environment may supply — which is what makes the complement,
 * *no trap*, false in the other direction.
 */
export interface TrapRow {
  /** Configurations in the set. */
  configs: number;
  /**
   * The states those configurations stand in — the union of every member's
   * ACTIVE STACK, composites included, never the leaves alone. One state spans
   * many configurations, so a trap named by leaf would name the wrong thing on
   * any machine with a composite state.
   */
  states: readonly StateRef[];
  /**
   * The shortest path from the opening configuration into the set, as the leaf
   * of each configuration on it, the opening first. An EXISTENTIAL claim
   * (register row W2), and it rides on the trap row: it prints only where the
   * row does, so its effective gate is the row's.
   */
  entry: readonly StateRef[];
  /** `entry.length - 1`. */
  steps: number;
}

/**
 * A cycle the interpreter's completion chase goes round without coming to rest
 * — a completion livelock (U1; plan O1 S4; `docs/06` §8.8).
 *
 * WHAT IS CLAIMED, EXACTLY. A set of configurations the walk reached where a
 * trigger-less transition is due at every one, and where the one the
 * INTERPRETER fires — the first enabled at the innermost level, by declaration
 * order, the transition `runStateMachine`'s chase takes — leads to the next of
 * them, round and back. A chase that gets here therefore goes round until its
 * `maxCompletion` budget is spent, stops wherever the budget leaves it with a
 * trigger-less transition still due, and the run moves on only on an event:
 * under run-to-completion the machine never comes to rest here.
 *
 * DECIDED OVER THE INTERPRETER'S CHASE, NOT OVER EVERY BRANCH. A cycle of the
 * walk's relation that some OTHER enabled trigger-less transition could leave
 * is still one the chase goes round when declaration order keeps it on the
 * cycle — v9's `PA::SwarmMember::SwarmMemberModes` loops `Nominal ⇄
 * NavigationDegraded` on every run although `Nominal -> Isolated` is enabled
 * beside it — so the row names, in {@link LivelockRow.choices}, every state of
 * the cycle where that is so: the choice row says the simulator never takes the
 * other transition, and this row says that declaration order is what the chase
 * follows there. A set the chase leaves on its own — a guard that holds
 * somewhere on the way round, an effect that walks the store out of the loop —
 * is no cycle of configurations, and nothing is reported. Each configuration
 * has one chase successor, so two cycles never share a configuration; and the
 * cycles that go round the same transitions under different stores or
 * histories are ONE row ({@link LivelockRow.cycles}), so a cycle of states is
 * reported once however many valuations the walk met it under.
 *
 * An EXISTENTIAL claim about the way in (`entry`), and a claim about the chase
 * from there on that rests on every trigger-less transition out of the
 * cycle's configurations being decided — which is why a guard the walk could
 * not evaluate there withholds the row ({@link LivelockWithheldRow}). The way in
 * is a run the SIMULATOR makes wherever the walk holds one
 * ({@link LivelockRow.entryBy}), and the row says so where it does not.
 */
export interface LivelockRow {
  /** Configurations on the cycle (on the cycle `entry` leads into, where {@link cycles} folds several). */
  configs: number;
  /**
   * The states those configurations stand in — the union of their ACTIVE
   * STACKS, as a trap names its set — in the order the chase goes round, from
   * the configuration `entry` leads into.
   */
  states: readonly StateRef[];
  /** The trigger-less transition the interpreter fires at each configuration, in the same order. */
  transitions: readonly TransitionRef[];
  /**
   * The states of the cycle where another trigger-less transition is enabled
   * beside the one the interpreter fires, at the level it fires from: a choice
   * declaration order resolves onto the cycle, the other transition being one
   * the simulator never takes. Empty where nothing but the chase's own
   * transition is enabled.
   */
  choices: readonly StateRef[];
  /** The shortest way from the opening configuration to the cycle, as the leaf of each configuration, the opening first. */
  entry: readonly StateRef[];
  /** `entry.length - 1`. */
  steps: number;
  /**
   * Whose run `entry` is. `simulator`: every step of it is the one
   * `runStateMachine` takes — the first enabled transition for its input, never
   * a dwell — so `simulate` driven with its events enters the cycle, and the
   * chase still has the budget to go once round when it gets there. `walk`: the
   * walk holds no such run, and `entry` is its own shortest way in, which may
   * take a branch of a choice the simulator never takes ({@link branchAt}) —
   * so `simulate` may never enter the cycle, and the finding says so.
   */
  entryBy: 'simulator' | 'walk';
  /**
   * On a `walk` entry, the state where it first takes a step the simulator does
   * not take there; `null` on a `simulator` entry, and on a `walk` entry every
   * step of which is the simulator's but which reaches the cycle with too little
   * of the chase budget left to go round it.
   */
  branchAt: StateRef | null;
  /**
   * How many cycles of configurations this row stands for: cycles that go round
   * the same transitions and differ only in the store or history they carry
   * (an event that counts, before the chase starts, makes one per count). One
   * row, one finding, for all of them.
   */
  cycles: number;
}

/**
 * A cycle the chase goes round that is NOT reported, and the clause that
 * withholds it — never silently dropped, for the reason a withheld deadlock row
 * is printed (register row A0's `otherwise` cell).
 *
 * `store`: a guard the walk could not evaluate is a trigger-less transition out
 * of one of the cycle's configurations, so whether the interpreter's chase
 * fires it there — and leaves — was never decided. `time`: the transition the
 * chase fires at one of them is a dwell, which this walk takes without waiting
 * it out, so the interpreter may wait there rather than go round.
 */
export interface LivelockWithheldRow extends LivelockRow {
  clause: 'store' | 'time';
}

/**
 * What the component pass found and what was made of it, per machine — the
 * trap census (plan §3.2a *Census*, §5).
 *
 * THREE-VALUED WHERE THE EXACTNESS CENSUS IS, AND FOR THE SAME REASON. `sccs`
 * and `bottomSccs` are facts about the relation the walk RETAINED and stay
 * numbers on every walk. The four counts after them are answers about the
 * MACHINE — how many of its inescapable sets are endings, deadlocks, its own
 * core, or traps — and read `null` whenever the gate refused, because a bounded
 * walk must not publish *"3 exempted as deadlock"* about frontier nodes that
 * only look like sinks, and a walk missing a guarded edge must not publish
 * *"1 trap"* about a set the model states an escape from.
 */
export interface TrapCensus {
  /** Strongly connected components of the retained relation. */
  sccs: number;
  /** Those no edge leaves — trivial ones included. */
  bottomSccs: number;
  /** Bottom components that survived all three exemptions; `null` when refused. */
  trapsAfterExemptions: number | null;
  /** Bottom components made only of final states and `done` nodes. */
  exemptedAsEnding: number | null;
  /**
   * Single configurations with no successor, handed to the deadlock row. NOT
   * `deadlocks.length` in general: the deadlock rows are deduped by leaf and
   * withheld per configuration, so this can exceed the rows published.
   */
  exemptedAsDeadlock: number | null;
  /** The component holding the opening configuration — the reachable set itself. */
  exemptedAsCore: number | null;
  /** The clause the gate failed on, `null` exactly when the answers above are numbers. */
  refusedByGate: FailedClause;
  /**
   * The no-trap accounting, `--json` ONLY and never a text row: *no component
   * of this walk is inescapable beyond its endings — N ending, N deadlocked
   * configuration(s) and N whole-graph component were exempted, exhaustive
   * under {…}*. Written when the gate holds and no component qualifies; `null`
   * otherwise. It names what was exempted so that a deadlock row above it and
   * this sentence are two halves of one accounting rather than two answers.
   *
   * "DEADLOCKED CONFIGURATION(S)", NOT "DEADLOCK ROW(S)". The count is
   * `exemptedAsDeadlock`, which is per configuration, and the deadlock rows
   * are deduped by leaf — two configurations standing at one state with two
   * stores are two exemptions and one row — so a sentence that said "row(s)"
   * would name a figure the report beside it does not show.
   */
  sentence: string | null;
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
  /**
   * Every transition enabled at some configuration an explored run reaches —
   * what `dead` is read against: a transition the priority rule beats there,
   * or one due where the chase budget stops a chase, is in it.
   */
  enabled: ReadonlySet<ElementId>;
  /**
   * Every transition a step of some explored run takes: the part of
   * {@link enabled} the walk steps by, and what `reach` counts as `fired`. It
   * leaves out a transition the priority rule beats, and a completion
   * transition due where a chase stops: no run takes either.
   */
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
  /**
   * The successor relation the walk already computed, kept instead of discarded.
   *
   * `successors[i]` holds the node numbers of the configurations reachable from
   * configuration `i` in ONE innermost-level step — one entry per `stepConfig`
   * call the walk made from `i`, so a target reached under two different inputs
   * appears twice. That multiplicity is the honest figure: the memory cost of
   * this field is exactly one integer per step the walk took anyway.
   *
   * NO EDGE POINTS AT A CONFIGURATION A BOUND REFUSED. A target dropped at the
   * completion, depth or configuration gate is not a node, so it has no number
   * and nothing can name it; {@link ExploreResult.openFrontier} is how a reader
   * learns that such a target existed.
   *
   * AN EDGE INTO AN ALREADY-SEEN CONFIGURATION IS RECORDED AT THE REVISIT PRUNE,
   * BESIDE the edge into a newly admitted one: the relation is the UNION of the
   * two sites, and the prune is the half the field's honesty turns on. Recording
   * ONLY at the admission point retains the BFS SPANNING TREE — `nodes - 1`
   * edges, acyclic by construction on every machine in this repository — which
   * would make a component pass name a bottom component on
   * `examples/uav-isr.sysml` that does not exist: of the five edges on
   * `FlightModes`, the admission point supplies three (the tree) and the prune
   * supplies the two cycle-closing ones (`autonomous -> manual`,
   * `failsafe -> standby`).
   *
   * INTERNED TO INTEGERS, in BFS discovery order, which depends only on model
   * structure because {@link hashConfig} sorts store and history by name. The
   * hash itself never leaves the walk: element ids are fresh per load, so a
   * configuration hash means nothing outside one process and is published
   * nowhere.
   */
  successors: readonly (readonly number[])[];
  /**
   * The ACTIVE STACK per node number — not the leaf.
   *
   * One state spans many configurations, and a composite sits on the stack of
   * every configuration inside it, so `stack.includes(p)` is the correct target
   * predicate for a `state` atom. Retaining it is what lets a later reader ask
   * the question the atom kind asks rather than a hand-written approximation
   * of it.
   */
  configStates: readonly (readonly ElementId[])[];
  /**
   * The ACTIVE LEAF per node number — `leafOf(config)`, `null` where there is
   * none.
   *
   * NOT redundant with {@link ExploreResult.configStates}: a `state` atom is
   * read as `config.stack.includes(...)` and a `node` atom as
   * `leafOf(config) === ...`, and every StateUsage in the machine is admitted as
   * a node, composites included — so the two readings DIVERGE on any composite
   * state. Measured on one walk, one atom spelled two ways: `node degraded`
   * never holds and `state degraded` holds in one step. Retaining both arrays is
   * what keeps two readers from disagreeing about one atom.
   */
  configLeaves: readonly (ElementId | null)[];
  /**
   * This walk did not see the graph whole. Equals `!exhaustive`, asserted.
   *
   * NOT `boundHit !== 'none'`, which reads `false` on the unsupported-construct
   * early return above — `configs: 0, exhaustive: false, boundHit: 'none'` — and
   * would let a reader publish an absence over an EMPTY relation on the one
   * machine class this engine refuses to walk.
   */
  openFrontier: boolean;
  /**
   * Every walkable transition of this machine for which `afterDuration` is
   * defined — a numeric `attrs.after` OR an `after(n)` trigger string.
   *
   * THE TRANSITION SET, NOT AN ALPHABET SUBSET. A transition carrying only
   * `attrs.after` is a COMPLETION transition: it contributes no label at all, so
   * a version of this field scoped to alphabet contributors reads EMPTY on a
   * machine every edge of which is a dwell — which is the one machine the field
   * exists to catch. Non-empty means the walk offers a dwell at every
   * configuration and advances no clock, so every escape and every witness in it
   * may be an artefact of a wait the interpreter would never grant.
   */
  timedTransitions: ReadonlySet<ElementId>;
  /**
   * The dwell labels that reached {@link ExploreBounds.alphabet}. GATES NOTHING.
   *
   * Its only reader is the `alphabet` minus `timedLabels` subtraction that says
   * whether a non-empty alphabet is real triggers or all dwells — which decides
   * which of two sentences a withheld claim prints, and nothing else.
   *
   * SCOPED TO `regionTransitions`, NOT to the narrower `walkableTransitions`
   * that {@link ExploreResult.timedTransitions} ranges over, and the two domains
   * differ for a reason: `machineAlphabet` reads the region relation, so a dwell
   * leaving a node no configuration stands on still contributes its label to the
   * alphabet. Subtracting the walkable-scoped set would leave that label in the
   * difference and call it a named environment trigger.
   */
  timedLabels: ReadonlySet<string>;
  /**
   * Did this walk carry the chase position in the configurations it hashed?
   *
   * Where the interpreter's chase budget can stop a chase on this machine and
   * the position changes what a run does next: an event follows a stopped
   * chase on a machine that names a trigger, and a chain longer than the budget
   * hides states no run reaches (see the note above {@link exploreMachine}).
   * The product search in `./patterns` reads it, so the two walk one relation:
   * a search that hashed without the position on a machine this walk hashed
   * with it would miss the runs that take an event where a chase stopped.
   */
  chaseKeyed: boolean;
  /**
   * Configurations this walk reached where the chase budget was spent with a
   * completion transition still due — where the interpreter stops chasing and
   * takes the next event. Never more than 0 on a walk without the position.
   *
   * WHY THE EXACTNESS GATE READS IT. At such a configuration the relation holds
   * the edges the interpreter takes and NOT the completion transition the
   * machine states there: the budget, not the machine, decides it is not
   * fired. The decreasing claims are about the interpreter's runs and read
   * nothing here; a claim that a set is inescapable, or that every
   * configuration can get back to a state, would be read over a resting point
   * the machine's own transitions do not have (`walkIsExact`'s `budget`
   * clause, `./publishable`).
   */
  chaseStops: number;
  /**
   * On a walk WITHOUT the position over a machine that names no trigger, the
   * configurations (node numbers, ascending) where the budget stops the one
   * chase such a machine runs: the end of a `maxCompletion`-step path from the
   * opening with a completion transition still due. Empty on every other walk
   * — on a walk with the position the stops are in the relation itself and
   * {@link ExploreResult.chaseStops} counts them.
   *
   * WHY TWO CLAIMS READ IT AND THE GATE DOES NOT. Such a walk keeps the
   * relation the machine states, and over it every claim this lane publishes
   * is true of the interpreter's runs as well except the two read over where
   * a run ENDS: every run reaches it (the modality's `guaranteed`), and it can
   * be got back to from every configuration (`recovery`'s `recoverable`). A
   * run of the interpreter ends here, and nothing it does after is in it. The
   * relation follows the chase on, so each of those two is checked against
   * this list and withheld where the two readings part (`./patterns`); a trap
   * row, a `not recoverable` and every absence hold of both, and stand. So
   * does a `potential`, but the run it NAMES must be one too: a cycle or a sink
   * of the avoiding subgraph only where a path inside it gets there within the
   * budget, and otherwise the run the budget stops inside it (the modality's
   * `withinBudget`). Measured before this field existed, on two such machines: a 70-step
   * chain the walk reached the end of by a shorter tie-break branch printed
   * `every run? guaranteed` beside a `fail` whose declaration-order run the
   * budget stops at the 64th state, and a three-state cycle printed `recovery`
   * PASS for a state the interpreter's run never enters.
   */
  budgetStops: readonly number[];
  /**
   * The cycles the interpreter's completion chase goes round in this walk —
   * the producer of {@link LivelockRow}, as node numbers.
   *
   * Read off the walk the interpreter's way: at every configuration where a
   * trigger-less transition is due, the one `runStateMachine` fires (the first
   * enabled, innermost level first, by declaration order) and the
   * configuration it leads to. That is a function on configurations, so its
   * cycles are disjoint and each is found once. The CONFIGURATION, not the
   * node: the keyed walk numbers one configuration once per chase position,
   * and the chase's step from it is the same at every position. A configuration
   * whose chase step the walk never took — reached only where the budget stops
   * a chase (in the walk without the position: first reached with the budget
   * already spent), or whose target a bound refused — has none, and no cycle
   * runs through it: such a cycle is one the walk did not see whole, and none
   * is claimed.
   */
  chaseCycles: readonly ChaseCycle[];
}

/** One cycle of the interpreter's completion chase, as the walk numbered it ({@link ExploreResult.chaseCycles}). */
export interface ChaseCycle {
  /**
   * One node per configuration of the cycle — the first the walk numbered for
   * it — in the order the chase goes round, starting from the configuration
   * {@link entry} leads into.
   */
  order: readonly number[];
  /** The trigger-less transition the chase fires at each of them, in the same order. */
  via: readonly ElementId[];
  /** Every node standing at one of the cycle's configurations, ascending. */
  nodes: readonly number[];
  /** The first node the walk numbered for any of them: the cycle's place in discovery order. */
  first: number;
  /** A guard the walk could not evaluate is a trigger-less transition out of one of them. */
  undecided: boolean;
  /** The transition the chase fires at one of them is a dwell (`afterDuration` is defined). */
  timed: boolean;
  /**
   * The states, in cycle order, where another trigger-less transition is
   * enabled at the level the chase fires from — the choice it beats.
   */
  choices: readonly ElementId[];
  /**
   * The way in, as a node path from the opening (node 0) to a node of the
   * cycle: a run the simulator makes where the walk holds one, else the walk's
   * own shortest ({@link LivelockRow.entryBy}).
   */
  entry: readonly number[];
  entryBy: 'simulator' | 'walk';
  /** On a `walk` entry, the node it first leaves by a step the simulator does not take there; else `null`. */
  branchAt: number | null;
}

/* ───────────────────────── refs and small readers ───────────────────────── */

// A state named the way `reach` names one: never bare ids, which are fresh on
// every load.
export function stateRef(model: Model, id: ElementId): StateRef {
  const el = model.get(id);
  return {
    id,
    name: el?.declaredName ?? '',
    qualifiedName: model.qualifiedName(id) || id,
  };
}

export function transitionRef(model: Model, tr: ElementRecord): TransitionRef {
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
  return regionDescendants(model, machineId).filter((e) => e.eClass === 'StateUsage');
}

/**
 * Every node some configuration's stack can hold — read from the relation, not
 * from a metaclass.
 *
 * WHAT PUTS A NODE ON THE STACK, exactly. `initialConfig` (`./config.ts`) enters
 * `initialSubstate(machineId)` and cascades, which pushes `StateUsage`s; after
 * that, `stepConfig` pushes whatever the transition it fired TARGETS, whatever
 * that target's metaclass is, and before it the target's enclosing states it
 * enters on the way down (`hierarchyPath`, `docs/06` §8.10), which are
 * `StateUsage`s of the machine and so in the seed already. So the stack holds
 * the machine's states, plus everything the relation can land the walk on
 * from one — a `decide` node between two states, an action a transition
 * enters. `stepCandidates` then offers every relation edge leaving any stack
 * member, so those nodes' outgoing edges are walked as surely as a state's.
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
 *    can hold ({@link stackNodes}): the walk tries it wherever a configuration
 *    standing there is offered its input — a trigger only where a run takes its
 *    next event, which is not every configuration (the note above
 *    `exploreMachine`). This bucket IS {@link walkableTransitions}, and the
 *    transition census the report prints.
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
  const crossing = new Map(boundaryCrossings(model, machineId).map((c) => [c.edge.id, c] as const));
  const outside = new Set(stepsOutsideStates(model, machineId).map((t) => t.id));
  const onStack = stackNodes(model, machineId);
  const rows: EdgeCensusRow[] = [];
  const nameOf = (id: ElementId | undefined): string =>
    id === undefined ? 'nothing' : `\`${model.qualifiedName(id) || id}\``;

  for (const el of regionDescendants(model, machineId)) {
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
    } else if (crossing.has(el.id)) {
      // BEFORE `opening`: an opening edge into a nested definition's state would
      // open this machine somewhere its relation does not reach.
      const c = crossing.get(el.id)!;
      row(
        'refused',
        `it leads ${acrossSentence(model, c, inheritedAcross(model, machineId, c))}, so the walk ` +
          'refuses this machine by name rather than walking a step whose meaning is not defined here',
      );
    } else if (outside.has(el.id)) {
      row(
        'refused',
        `it leads ${outsideStatesSentence(model, machineId, el)}, so no chain of this machine’s ` +
          'states holds its target, the step has no least common ancestor to exit to, and the walk ' +
          'refuses this machine by name rather than walking a step whose meaning is not defined here',
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
          'hold, so the walk tries it wherever a configuration standing there is offered its input',
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
  // The far side of a crossing: an edge written OUTSIDE this region that joins
  // one of its states. The domain above is the region, so these are counted
  // here or nowhere, and an edge into this machine's states that no row
  // accounted for is the hole this census exists to close.
  for (const c of crossing.values()) {
    if (c.way !== 'foreign') continue;
    rows.push({
      id: c.edge.id,
      eClass: c.edge.eClass,
      qualifiedName: model.qualifiedName(c.edge.id) || c.edge.id,
      account: 'refused',
      reason:
        `it joins ${nameOf(c.edge.source?.[0])} to ${nameOf(c.edge.target?.[0])} and is ` +
        `${acrossSentence(model, c, inheritedAcross(model, machineId, c))}, so the walk refuses ` +
        'this machine by name rather than walking it as though the edge were not there',
    });
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
  return regionDescendants(model, machineId).filter(
    (e) =>
      CONTROL_EDGE_KINDS.has(e.eClass) &&
      (e.source?.[0] === undefined || e.target?.[0] === undefined),
  );
}

/**
 * Step edges the walk can take whose target sits in no chain of this machine's
 * states (`hierarchyPath`, `./config.ts`, is `null`), short of a boundary
 * crossing (which {@link boundaryCrossings} names): a step into the machine's
 * own root, or into a node written under an element that is not a state, such
 * as an action.
 *
 * A step exits to the least common ancestor of its source and its target and
 * enters the states that hold the target, outermost first (`stepConfig`,
 * `./config.ts`). These targets have no such states, and neither UML nor the
 * profile says what such a step exits and enters, so nothing here reads it: the
 * machine is refused, and the interpreter refuses to take the step
 * (`runStateMachine`'s `refused`). The predicate is `stepOutsideStates`
 * (`./config.ts`), the one the interpreter reads, so the two refuse the same
 * steps (`docs/06` §8.12).
 *
 * Read twice, like {@link danglingTransitions}: by {@link edgeCensus}, for the
 * `refused` bucket, and by {@link unsupportedConstructs}.
 */
function stepsOutsideStates(model: Model, machineId: ElementId): ElementRecord[] {
  return walkableTransitions(model, machineId).filter((t) => stepOutsideStates(model, machineId, t));
}

/** A step edge that joins this machine's states to states outside its region. */
interface BoundaryCrossing {
  edge: ElementRecord;
  /**
   * `into` — in this machine's relation, leading into a `state def` written
   * inside it (or to that definition itself); `out` — in this machine's
   * relation, leading out of its region; `foreign` — written OUTSIDE this
   * machine's region and joining one of its states to somewhere else.
   */
  way: 'into' | 'out' | 'foreign';
  /**
   * The element across the boundary, named in the refusal: the nested
   * definition (`into`), the machine whose region holds the far end (`out`,
   * `null` when none does), or the element the edge is written in (`foreign`).
   */
  other: ElementId | null;
}

/**
 * The step edges that join this machine's states to states outside its region,
 * from EITHER side: written in this machine and leading out of its region —
 * into a `state def` written inside it, or into another machine — or written
 * outside it and leading into or out of one of its states.
 *
 * Each machine steps by its own relation only (`regionTransitions`, which stops
 * at a nested `state def`, `./config`), and a nested `state def` is a machine of
 * its own (`stateMachinesIn`). So an edge across a region's boundary has no
 * meaning this engine defines, and no walk follows it as one. The outer walk of
 * `Nest2` entered `Inner::x` and found none of its transitions (`no way out
 * Inner::x`, although `Inner`'s own walk fires one there), and `Inner`'s walk
 * followed `yb` out to a state the outer walk had just published `unreachable`
 * (`unreachable b` beside `deadlock b … reached in 2 step(s)`).
 *
 * BOTH SIDES ARE REFUSED, not only the machine whose relation holds the edge.
 * Refusing that one alone left the far side walked as though the edge were not
 * there: with only `az` (written in `Outer`, leading into `Inner::z`), `Inner`
 * still published `unreachable z` and a `pass` for `absence z` while a run of
 * `Outer` ends in `Inner::z`; with only `yb`, `Outer` published `unreachable b`
 * the same way. The far side is found off the endpoint index, so an edge
 * written anywhere — in a nested definition, in another top-level machine, in
 * a package — that names one of this machine's states is one of them.
 *
 * An end AT a machine's root is not a crossing for that machine — entering a
 * machine at its root is starting it, which is what its walk does — but a
 * nested `state def` is not part of the outer machine's region, so `then
 * Inner` written in `Outer` crosses into it: the walk cascaded into `Inner`'s
 * initial state, where a run of `Outer` stays at `Inner` itself.
 *
 * The interpreter (`runRegion`, `../execute.ts`) reads the same relation and
 * takes such an edge where the walk would have: the run enters the far state
 * and stays there, since none of that state's transitions are in it. That
 * reading is not a verdict, and `docs/06` §8.6 says how the two stand.
 *
 * Read twice, like {@link danglingTransitions}: by {@link edgeCensus}, for the
 * `refused` bucket, and by {@link unsupportedConstructs}.
 */
function boundaryCrossings(model: Model, machineId: ElementId): BoundaryCrossing[] {
  const region = regionDescendants(model, machineId);
  const regionIds = new Set<ElementId>(region.map((d) => d.id));
  // The nodes this machine's region is made of. A nested `state def` is in
  // `regionDescendants` — the boundary stops BELOW it — but it is a machine of
  // its own, or a definition no walk enters, and not a node of this one.
  const own = new Set<ElementId>([machineId]);
  for (const d of region) if (d.eClass !== 'StateDefinition') own.add(d.id);
  let inside: ReadonlySet<ElementId> | undefined;
  const out: BoundaryCrossing[] = [];
  for (const edge of regionTransitions(model, machineId)) {
    for (const end of [edge.source![0], edge.target![0]]) {
      if (own.has(end)) continue;
      inside ??= new Set(model.descendants(machineId).map((d) => d.id));
      out.push(
        inside.has(end)
          ? { edge, way: 'into', other: outermostDefinitionAt(model, machineId, end) }
          : { edge, way: 'out', other: machineHolding(model, end) },
      );
      break;
    }
  }
  const foreign = new Set<ElementId>();
  for (const id of own) {
    if (id === machineId) continue;
    for (const edge of model.edgesOf(id)) {
      if (foreign.has(edge.id) || regionIds.has(edge.id)) continue;
      if (!CONTROL_EDGE_KINDS.has(edge.eClass) || edge.attrs.isLibrary === true) continue;
      if (edge.source?.[0] === undefined || edge.target?.[0] === undefined) continue;
      foreign.add(edge.id);
      out.push({ edge, way: 'foreign', other: edge.ownerId ?? null });
    }
  }
  return out;
}

/**
 * The `state def` written in the machine's region that holds `id` — the
 * boundary between the two — or `id` itself when it is that definition. `id` is
 * a descendant of the machine that its region does not hold, so there is one.
 */
function outermostDefinitionAt(model: Model, machineId: ElementId, id: ElementId): ElementId {
  let found = id;
  for (let p: ElementId | null = id; p != null && p !== machineId; p = model.get(p)?.ownerId ?? null) {
    if (model.get(p)?.eClass === 'StateDefinition') found = p;
  }
  return found;
}

/** The machine whose region holds `id` as one of its nodes, if any does. */
function machineHolding(model: Model, id: ElementId): ElementId | null {
  for (const m of stateMachinesIn(model)) {
    if (m.id === id) return m.id;
    const holds = regionDescendants(model, m.id).some((d) => d.id === id && d.eClass !== 'StateDefinition');
    if (holds) return m.id;
  }
  return null;
}

/**
 * The specialisation or typed usage on the far side of a crossing whose step
 * joins states one side INHERITS from the other, or `null`: for a `foreign`
 * edge, the element it is written in (or an owner of that) that specialises or
 * is typed by this machine; for an `out` edge, the machine holding the far end
 * when this machine specialises or is typed by it. `state def Derived :> Base
 * { transition bc first b accept more then c; }` is both: `bc` joins `Base`'s
 * `b` and `c`, and is written in `Derived`.
 */
function inheritedAcross(model: Model, machineId: ElementId, c: BoundaryCrossing): ElementId | null {
  const inherits = (sub: ElementId, general: ElementId): boolean =>
    generalizationsOf(model, sub).some((g) => g.id === general);
  if (c.way === 'out') return c.other !== null && inherits(machineId, c.other) ? c.other : null;
  if (c.way !== 'foreign') return null;
  for (let p: ElementId | null = c.edge.ownerId ?? null; p != null; p = model.get(p)?.ownerId ?? null) {
    if (inherits(p, machineId)) return p;
  }
  return null;
}

/**
 * What lies across the boundary, in the refusal's words: a nested definition
 * is "a machine of its own" only when it is one — a `state def` that owns no
 * transition is walked by nothing (`stateMachinesIn`), and calling it a machine
 * printed a second machine under a header that counted one.
 */
function acrossSentence(model: Model, c: BoundaryCrossing, inherited: ElementId | null = null): string {
  const qn = (id: ElementId): string => `\`${model.qualifiedName(id) || id}\``;
  const other = c.other === null ? undefined : model.get(c.other);
  switch (c.way) {
    case 'into':
      return (
        `into the nested \`state def\` ${qn(c.other!)}, ` +
        (other !== undefined && ownsMachine(model, other)
          ? 'a machine of its own that this walk does not enter'
          : 'a definition this walk stops at and no walk enters, since it owns no transition')
      );
    case 'out':
      if (other === undefined) return 'out of this machine, to an element no machine walks';
      if (inherited !== null) {
        return `out of this machine, into ${qn(other.id)}, a machine of its own whose states this one inherits`;
      }
      return model.descendants(other.id).some((d) => d.id === c.edge.ownerId)
        ? `out of this nested \`state def\`, into ${qn(other.id)}, the machine it is written in`
        : `out of this machine, into ${qn(other.id)}, a machine of its own`;
    case 'foreign':
      if (inherited !== null) {
        return `written outside this machine, in ${qn(inherited)}, which inherits its states`;
      }
      return `written outside this machine${other !== undefined ? `, in ${qn(other.id)}` : ''}`;
  }
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
 * `machine-boundary` is a step edge that joins this machine's states to states
 * outside its region ({@link boundaryCrossings}), from either side: written in
 * this machine and leading into a `state def` written inside it or out to
 * another machine, or written elsewhere and leading into or out of one of its
 * states. Each machine walks only its own transitions, so the step has no
 * meaning here, and neither side's walk is a claim about the model.
 *
 * `step-outside-states` is a step edge into the machine's own root, or into a
 * node written under an element that is not a state ({@link stepsOutsideStates}):
 * a step exits to the least common ancestor of its source and its target, and
 * such a target has no chain of states to exit to or to enter.
 *
 * The last is not a construct anybody enumerated, and that is its point. It
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
  for (const el of [machine, ...regionDescendants(model, machineId)]) {
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
  const qn = (id: ElementId): string => `\`${model.qualifiedName(id) || id}\``;
  for (const c of boundaryCrossings(model, machineId)) {
    const inherited = inheritedAcross(model, machineId, c);
    out.push({
      construct: 'machine-boundary',
      detail:
        `${qn(c.edge.id)} leads from ${qn(c.edge.source![0])} to ${qn(c.edge.target![0])}` +
        (c.way === 'foreign'
          ? ` and is ${acrossSentence(model, c, inherited)}, so this walk does not take it. `
          : `, ${acrossSentence(model, c, inherited)}. `) +
        // A specialisation's remedy is not a nested definition's: moving the
        // step into the machine whose states it joins would change THAT
        // machine, which the specialisation was written not to do.
        (inherited !== null
          ? 'A transition added over inherited states is not walked as part of either machine: each ' +
            'walks only the transitions written in its own region, and this engine does not put a ' +
            'specialisation or a typed usage together with the machine it inherits states from, so ' +
            'no walk of this machine is a claim about the two together. To have the steps walked, ' +
            'write the machine you mean out whole — its states and every transition it steps by — ' +
            'in one definition.'
          : 'Each machine steps only by its own transitions, so what a step across that boundary means ' +
            'is not defined here, and no walk of this machine is a claim about it as written. Keep each ' +
            'transition inside the machine whose states it joins, or write a nested definition as a ' +
            'composite state (`state Inner { … }`) to make its states part of the outer machine.'),
      elementId: c.edge.id,
    });
  }
  for (const tr of stepsOutsideStates(model, machineId)) {
    out.push({
      construct: 'step-outside-states',
      detail:
        `${qn(tr.id)} leads from ${qn(tr.source![0])} ${outsideStatesSentence(model, machineId, tr)}. ` +
        'A step exits to the least common ancestor of its source and its target and enters the states ' +
        'that hold the target, outermost first, so its target has to sit in a chain of this machine’s ' +
        'states; this one does not, so what the step exits and enters is not defined here, and no walk of ' +
        'this machine is a claim about it as written. The simulator does not take it either: a run that ' +
        'would stops at its source and says so. Target one of the machine’s states, or a node written ' +
        'directly in one of them.',
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
  /** Steps from the opening, completion steps included: the figure `depth` prints. */
  depth: number;
  /**
   * Events taken from the opening on the path this configuration was first
   * found by — what the depth bound counts ({@link DEFAULT_MAX_DEPTH}). A
   * completion step is not one: the chase budget bounds those after every event.
   */
  events: number;
  /**
   * Completion steps fired since the last event (or since the opening): how far
   * into its chase the interpreter is here. Read only where a completion
   * transition is due, which is the only place the chase budget decides
   * anything — and kept at 0 everywhere else.
   */
  completionRun: number;
  /**
   * This configuration's node number — its position in BFS discovery order.
   *
   * Carried on the queue rather than looked up, because the successor relation
   * is recorded from the DEQUEUED end: an edge is `succ[here.index].push(to)`,
   * and re-hashing `here.config` to find `here.index` would pay the walk's
   * single most expensive operation again per edge.
   */
  index: number;
}

/*
 * THE CHASE BUDGET IS PART OF THE SEMANTICS, NOT A BOUND.
 *
 * The interpreter chases trigger-less (completion) transitions after every
 * driving step, and stops after `maxCompletion` of them whether or not one is
 * still due (`chaseCompletion` / `chaseHierCompletion` in `../execute.ts`). It
 * then takes the NEXT EVENT wherever the chase stopped: a transition leaving
 * that configuration on that event fires, and a new chase starts with a fresh
 * budget. So a configuration where a completion transition is due is one of two
 * things to the interpreter, depending on how far into its chase it is: a
 * configuration it chases out of, or — at the budget — one it rests in and
 * offers the next event at.
 *
 * The walk used to read the budget as a bound instead. It counted the chase
 * along the path a configuration was FIRST found by, cut a chain longer than
 * the budget off as `boundHit: 'completion'`, and on a completion CYCLE never
 * met the budget at all — a cycle re-enters configurations already hashed — so
 * it never offered an event inside one. Two kinds of run the interpreter takes
 * were missing from it: an event taken where a chase stopped on a cycle
 * (`LiveTwo`: `s0 -go-> a`, `a ⇄ b` on completion, `a accept e then c`; the
 * interpreter on `[go, e]` ends in `c`, and the walk published `c` unreachable
 * and `ac` dead), and one taken where a long chain stopped short of its end —
 * where a shorter path to the same configuration had hidden the long one.
 * Absence lists, `pass` rows and `not-covered` rows were published over the
 * runs it was missing; that is the one direction of error this lane may not
 * have.
 *
 * WHAT THE WALK DOES NOW. Where the budget can stop a chase, the walk carries
 * the chase position in the configuration it hashes — `run` in
 * `0..maxCompletion`, beside every configuration where a completion transition
 * is due — so two arrivals at one configuration at two points of a chase are
 * two nodes, with the two futures the interpreter gives them:
 *
 *   - `run < maxCompletion`: the chase goes on, and only completion is offered;
 *   - `run === maxCompletion`: the chase stops here, as the interpreter's does,
 *     and the alphabet is offered exactly as `runStateMachine` takes the next
 *     event. The completion transitions due here are counted ENABLED — they
 *     are, at a configuration a run reaches, so they are not dead and this is
 *     not a deadlock — and none of them is fired;
 *   - an event restarts the chase at 0, and a configuration where nothing is
 *     due is hashed without a position, because nothing it does depends on it.
 *
 * Nothing is cut, so nothing is a bound: a state no run reaches within the
 * budget is unreachable, and the bounds line printed beside it names the
 * budget it holds under (`maxCompletion 64`).
 *
 * WHERE THE BUDGET CANNOT STOP A CHASE, THE POSITION IS LEFT OUT — the walk is
 * the one it always was, configuration for configuration, and every figure it
 * prints is the figure it always printed. It cannot stop one when no chase is
 * longer than the budget: no cycle of completion steps, and no path of more
 * than `maxCompletion` of them. The walk runs once without positions and asks
 * that of the completion edges it retained ({@link chaseBudgetDecides}); only
 * where it can stop one is the machine walked again with them.
 *
 * A MACHINE THAT NAMES NO TRIGGER KEEPS ITS WALK, AND IS STILL HELD TO THE
 * BUDGET. A chase stopped there is followed by nothing — there is no next event
 * to take — so where the first walk finished, the position would add no state a
 * run reaches and no transition it enables, and the walk keeps the relation the
 * machine states (it is walked with the position only where the first walk had
 * to cut a chain, whose far end no run reaches). But the budget still decides
 * where a run ENDS: every run of such a machine is the one chase from the
 * opening, stopped after `maxCompletion` steps wherever it is, while the
 * relation follows that chase round its cycle for ever, or down its chain to
 * the end. So the walk names where the budget stops it
 * ({@link ExploreResult.budgetStops}), and the two claims read over where a
 * run ends — every run reaches it, it can be got back to from everywhere — are
 * checked against those stops (`./patterns`). Both were published over this
 * relation unchecked once, by an exemption a review of this very change found
 * false on two such machines. `FlightModes` (`examples/uav-isr.sysml`) cycles
 * on completion alone: it keeps its four configurations and every row it
 * printed, and its `recovery` of `standby` is withheld, because the budget
 * stops a run of it in `autonomous`.
 */

/** The walks taken over one revision of one model, by machine and bounds. */
interface WalkCache {
  rev: number;
  walks: Map<string, ExploreResult>;
}
const WALK_CACHE = new WeakMap<Model, WalkCache>();

/**
 * Explore the configuration graph of the machine rooted at `machineId`.
 *
 * Breadth-first, so the depth recorded against a configuration is the SHORTEST
 * walk to it. Each configuration carries how far into its chase the
 * interpreter is there, and where the chase budget can stop a chase that
 * position is part of the configuration — see the note above.
 *
 * ONE WALK PER MACHINE, BOUNDS AND MODEL REVISION. The walk is a function of
 * those alone and its result is read-only, so a second caller over the same
 * revision gets the first one's walk — as `regionTransitions` and
 * `regionScope` (`./config`) are kept, by `model.rev`. `check-behaviour`
 * walks a machine for every property it decides and once more to file the
 * machine's completion livelocks (`behaviourReport`, `./patterns`); measured
 * on a 9,641-configuration machine with one property, that second walk took
 * the command from about 230 ms to about 540 ms (the branch review).
 */
export function exploreMachine(
  model: Model,
  machineId: ElementId,
  opts: ExploreOptions = {},
): ExploreResult {
  const key = [
    machineId,
    Math.max(1, opts.maxConfigs ?? DEFAULT_MAX_CONFIGS),
    Math.max(0, opts.maxDepth ?? DEFAULT_MAX_DEPTH),
    Math.max(0, opts.maxCompletion ?? MAX_COMPLETION),
  ].join('|');
  let cache = WALK_CACHE.get(model);
  if (cache === undefined || cache.rev !== model.rev) {
    cache = { rev: model.rev, walks: new Map() };
    WALK_CACHE.set(model, cache);
  }
  const hit = cache.walks.get(key);
  if (hit !== undefined) return hit;
  const walk = walkMachine(model, machineId, opts);
  cache.walks.set(key, walk);
  return walk;
}

/** {@link exploreMachine}, uncached. */
function walkMachine(model: Model, machineId: ElementId, opts: ExploreOptions): ExploreResult {
  const bounds: ExploreBounds = {
    maxConfigs: Math.max(1, opts.maxConfigs ?? DEFAULT_MAX_CONFIGS),
    maxDepth: Math.max(0, opts.maxDepth ?? DEFAULT_MAX_DEPTH),
    maxCompletion: Math.max(0, opts.maxCompletion ?? MAX_COMPLETION),
    alphabet: machineAlphabet(model, machineId),
  };
  const census = edgeCensus(model, machineId);
  const unsupported = unsupportedConstructs(model, machineId, census);
  // The dwell census, off the MODEL rather than off the walk, so it reads the
  // same on a machine this engine refuses to walk as on one it explores: a
  // transition is timed because of what it says, not because of what the walk
  // did with it. The set is the TRANSITIONS, and `timedLabels` is only what
  // reached the alphabet — a transition carrying a numeric `attrs.after` and no
  // trigger is a completion transition and contributes no label at all, which is
  // why the two are separate fields and why the gate reads the first.
  //
  // THE TWO FIELDS RANGE OVER DIFFERENT RELATIONS, ON PURPOSE, because each is
  // read against a different thing. `timedTransitions` is the gate's producer
  // and asks *does the walk offer a dwell at a configuration*, so it is scoped
  // to `walkableTransitions` — the edges a configuration's stack can hold.
  // `timedLabels` is only ever SUBTRACTED FROM `bounds.alphabet`, which
  // `machineAlphabet` computes over `regionTransitions`, so it is scoped to that
  // same relation: a subtraction whose two sides range over different domains
  // reports the difference as a named trigger. Measured on a machine every
  // trigger of which is a dwell and one of whose dwell edges leaves the machine
  // ROOT — `off-stack` in the census, so the machine is walked rather than
  // refused: with `timedLabels` scoped to the walkable set, `after(99)` survives
  // the subtraction and the exactness gate prints the ENVIRONMENT sentence,
  // *"nothing here establishes that an environment would supply them"*, about a
  // machine that names no environment trigger at all. The gate's verdict is the
  // same either way — this decides which sentence a withheld claim carries.
  const walkable = new Set(walkableTransitions(model, machineId).map((t) => t.id));
  const timedTransitions = new Set<ElementId>();
  const timedLabels = new Set<string>();
  for (const tr of regionTransitions(model, machineId)) {
    if (afterDuration(tr) === undefined) continue;
    if (walkable.has(tr.id)) timedTransitions.add(tr.id);
    const label = triggerLabelOf(tr);
    if (label !== '') timedLabels.add(label);
  }

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
      reachable: new Set(),
      enabled: new Set(),
      fired: new Set(),
      offered: new Set(),
      nondeterminism: [],
      deadlocks: [],
      unsupported,
      census,
      undeterminedGuards: [],
      // NOTHING WAS WALKED, so the relation is empty — and `openFrontier` is
      // `true` because `exhaustive` above is `false`, not because a bound was
      // hit. `boundHit` is `'none'` on this path, which is exactly why the field
      // is defined as the negation of `exhaustive` and never as a test on
      // `boundHit`.
      successors: [],
      configStates: [],
      configLeaves: [],
      openFrontier: true,
      timedTransitions,
      timedLabels,
      chaseKeyed: false,
      chaseStops: 0,
      budgetStops: [],
      chaseCycles: [],
    };
  }

  // Once without the chase position, which is every walk this engine has ever
  // published; again with it only where the budget can stop a chase AND
  // something can follow a stopped one: an event, on a machine that names a
  // trigger, or the states past a chain the first walk had to cut. A machine
  // that names no trigger otherwise keeps its walk, and the configurations
  // where the budget stops its one chase are named on it — see the note above.
  const plain = walkConfigurations(model, machineId, bounds, false);
  const budgetCanStop = chaseBudgetDecides(plain, bounds);
  const walked =
    budgetCanStop && (bounds.alphabet.length > 0 || plain.boundHit === 'completion')
      ? walkConfigurations(model, machineId, bounds, true)
      : plain;
  const budgetStops = !walked.chaseKeyed && budgetCanStop ? openingChaseStops(plain, bounds) : [];
  return {
    machineId,
    bounds,
    configs: walked.configs,
    depth: walked.depth,
    exhaustive: walked.exhaustive,
    boundHit: walked.boundHit,
    reachable: walked.reachable,
    enabled: walked.enabled,
    fired: walked.fired,
    offered: walked.offered,
    nondeterminism: walked.nondeterminism,
    deadlocks: walked.deadlocks,
    unsupported,
    census,
    undeterminedGuards: walked.undeterminedGuards,
    successors: walked.successors,
    configStates: walked.configStates,
    configLeaves: walked.configLeaves,
    openFrontier: !walked.exhaustive,
    timedTransitions,
    timedLabels,
    chaseKeyed: walked.chaseKeyed,
    chaseStops: walked.chaseStops,
    budgetStops,
    chaseCycles: walked.chaseCycles,
  };
}

/** What one walk of the configuration graph produced — the walk half of {@link ExploreResult}. */
interface Walked {
  configs: number;
  depth: number;
  exhaustive: boolean;
  boundHit: BoundHit;
  reachable: Set<ElementId>;
  enabled: Set<ElementId>;
  fired: Set<ElementId>;
  offered: Set<string>;
  nondeterminism: NondeterministicChoice[];
  deadlocks: DeadlockRow[];
  undeterminedGuards: UndeterminedGuardRow[];
  successors: number[][];
  configStates: (readonly ElementId[])[];
  configLeaves: (ElementId | null)[];
  /**
   * `completionSuccessors[i]`: the part of `successors[i]` reached by a
   * completion step. Read once, by {@link chaseBudgetDecides}, to ask whether
   * the budget can stop a chase on this machine.
   */
  completionSuccessors: number[][];
  chaseKeyed: boolean;
  chaseStops: number;
  chaseCycles: ChaseCycle[];
}

/**
 * One breadth-first walk of the configuration graph — without the chase
 * position (`keyed` false), which cuts a chase longer than the budget off as
 * `boundHit: 'completion'`, or with it, which follows the interpreter through
 * the budget and cuts nothing.
 */
function walkConfigurations(
  model: Model,
  machineId: ElementId,
  bounds: ExploreBounds,
  keyed: boolean,
): Walked {
  const COMPLETION: StepInput = { kind: 'completion' };
  const triggers: StepInput[] = bounds.alphabet.map((trigger): StepInput => ({ kind: 'trigger', trigger }));
  const inputs: StepInput[] = [COMPLETION, ...triggers];
  const reachable = new Set<ElementId>();
  // Enabled somewhere a run reaches (`dead` is the rest), and taken by a step
  // of some run (`reach`'s `fired`) — the second a part of the first.
  const everEnabled = new Set<ElementId>();
  const fired = new Set<ElementId>();
  const offered = new Set<string>();
  const nondeterminism: NondeterministicChoice[] = [];
  const deadlocks: DeadlockRow[] = [];
  // ONE row per transition, not one per configuration it was consulted at: a
  // guard over an unvalued feature is undetermined at every configuration the
  // walk offers it, and a reader needs the transition once, not a row per state
  // of a store the guard does not depend on.
  const undeterminedGuards = new Map<ElementId, UndeterminedGuardRow>();
  const recordUndetermined = (undetermined: readonly UndeterminedGuard[]): void => {
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
  };
  // What the completion input finds at a configuration, by its hash. The keyed
  // walk needs it BEFORE it admits a configuration — whether a completion
  // transition is due there decides whether the chase position is in the key —
  // and asks again when it dequeues one, so it is asked once per configuration.
  const completionCache = new Map<string, StepCandidates>();
  const completionAt = (config: MachineConfig, hash: string): StepCandidates => {
    let found = completionCache.get(hash);
    if (found === undefined) {
      found = stepCandidates(model, config, COMPLETION, true);
      completionCache.set(hash, found);
    }
    return found;
  };
  // The key a configuration is visited under: its hash, and in the keyed walk
  // the chase position too — but only where a completion transition is due,
  // the one place the position decides what happens next. Everywhere else it
  // would split one configuration into nodes with the same future.
  const keyOf = (config: MachineConfig, hash: string, run: number): { key: string; run: number } =>
    keyed && completionAt(config, hash).enabled.length > 0 ? { key: `${hash}#${run}`, run } : { key: hash, run: keyed ? 0 : run };
  // THE INTERPRETER'S CHASE, PER CONFIGURATION — what `chaseCycles` is read
  // from. Interned by hash and not by node: the keyed walk numbers one
  // configuration once per chase position, and the step the chase takes from
  // it is the same at every one of them. `nodeConfig` grows beside `succ`, at
  // the same two admission points.
  const configIndex = new Map<string, number>();
  const intern = (hash: string): number => {
    let c = configIndex.get(hash);
    if (c === undefined) {
      c = configIndex.size;
      configIndex.set(hash, c);
    }
    return c;
  };
  const nodeConfig: number[] = [];
  const chase: ChaseStep[] = [];
  const chaseUndecided = new Set<number>();
  // THE SIMULATOR'S OWN STEPS, for the livelock's way in: the edges of `succ`
  // made by the transition `runStateMachine` takes for that input — the first
  // enabled, never a dwell. A path of these is a run `simulate` makes when it
  // is driven with the path's events; a path through any other edge takes a
  // tie-break the simulator never takes. A flat edge list, not a row per node:
  // it is read only where a cycle was found, and a walk of a quarter of a
  // million configurations should not carry a quarter of a million arrays for
  // it. And the chase position each node was admitted at, which in the keyed
  // walk is exact wherever a trigger-less transition is due — so whether a
  // chase that gets to a node of a cycle still has the budget to go round it is
  // read off the node; it grows beside `succ`, at the admission point.
  const simFrom: number[] = [];
  const simTo: number[] = [];
  const nodeRun: number[] = [0];

  // The same opening store the interpreter starts from: every literal feature
  // value inside the machine, by name. A walk that started from an empty store
  // would evaluate the first guard against a different world (`seedStore` is
  // what `runStateMachine` does before it enters anything).
  const seeded = new Map<string, unknown>();
  const machineEl = model.get(machineId);
  if (machineEl) seedStore(model, machineEl, seeded);
  const opening = initialConfig(model, machineId, { store: seeded });
  for (const v of opening.effects.visited) reachable.add(v);
  // The history map is in the key only where a composite resumes from it.
  const history = resumesHistory(model, machineId);
  const openingHash = hashConfig(opening.config, history);
  // A MAP, not a set: the value is the configuration's node number, which is
  // what interns the hash away. `Map.size` is `Set.size`, so the configuration
  // bound below reads exactly as it did.
  const seen = new Map<string, number>([[keyOf(opening.config, openingHash, 0).key, 0]]);
  nodeConfig.push(intern(openingHash));
  // One row per node, grown at the admission point so `succ.length` and
  // `seen.size` stay equal.
  const succ: number[][] = [[]];
  const completionSucc: number[][] = [[]];
  const configStates: (readonly ElementId[])[] = [opening.config.stack];
  const configLeaves: (ElementId | null)[] = [leafOf(opening.config)];
  const queue: (Frontier & { hash: string })[] = [
    { config: opening.config, depth: 0, events: 0, completionRun: 0, index: 0, hash: openingHash },
  ];
  let boundHit: BoundHit = 'none';
  let depth = 0;
  let chaseStops = 0;
  const nondetSeen = new Set<string>();
  const deadlockSeen = new Set<ElementId>();

  while (queue.length > 0) {
    const here = queue.shift()!;
    depth = Math.max(depth, here.depth);
    let anyEnabled = false;

    // RUN-TO-COMPLETION IS THE PROFILE'S OWN RULE, SO THE WALK OBEYS IT. The
    // interpreter fires a trigger-less (completion) transition before it accepts
    // any event, so at a configuration where one is enabled — or where its guard
    // is undetermined, which fails closed — no event is offered here either.
    // Without this the walk takes runs the profile forbids, and its existential
    // answers (`fail`, `covered`, `no way out`, `choice`, an undecided guard)
    // can sit on a configuration no run reaches.
    //
    // UNTIL THE CHASE BUDGET IS SPENT. Where the keyed walk has followed a chase
    // `maxCompletion` steps to here and a completion transition is still due,
    // the interpreter stops chasing and takes the next event here, so the walk
    // offers the alphabet and no completion — see the note above.
    const completion = completionAt(here.config, here.hash);
    const due = completion.enabled.length > 0;
    const stopped = keyed && due && here.completionRun >= bounds.maxCompletion;
    // A trigger-less transition out of here that the walk could not decide:
    // whether the chase fires it, and leaves, is a question nothing answered.
    if (completion.undetermined.length > 0) chaseUndecided.add(nodeConfig[here.index]);
    if (stopped) {
      chaseStops++;
      // Enabled, at a configuration a run reaches: not dead, and not a
      // deadlock. Not fired either — not by this walk, and not by the
      // interpreter, whose budget is spent — so no successor is recorded and
      // `fired` does not get it.
      anyEnabled = true;
      for (const e of completion.enabled) everEnabled.add(e.transition.id);
      recordUndetermined(completion.undetermined);
    }
    const offeredInputs: StepInput[] = stopped
      ? triggers
      : due || completion.undetermined.length > 0
        ? [COMPLETION]
        : inputs;
    for (const input of offeredInputs) {
      if (input.kind === 'trigger') offered.add(input.trigger);
      const { enabled, undetermined } =
        input.kind === 'completion' ? completion : stepCandidates(model, here.config, input, true);
      // Recorded whether or not anything was enabled, and BEFORE the early
      // `continue` below: a configuration where the only outgoing edge is an
      // undetermined guard has nothing enabled, and it is exactly the one whose
      // deadlock row would otherwise be published over a question nothing
      // answered.
      recordUndetermined(undetermined);
      if (enabled.length === 0) continue;
      anyEnabled = true;
      // The interpreter fires `enabled[0]`, and the list is innermost level
      // first: a transition at an OUTER level is beaten by the priority rule
      // and fires in no run at all while an inner one is enabled. Every one of
      // them is still counted ENABLED — `dead` means never enabled anywhere
      // reachable — but only the innermost level generates successors, is
      // counted `fired`, and can hold a hidden choice, because a configuration
      // reached by firing a beaten transition is one no run enters, and a
      // deadlock or an ambiguity reported there is invented rather than found.
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

      // The transition the INTERPRETER's chase fires here — `enabled[0]`, the
      // one `runStateMachine` takes — and where it leads, recorded once per
      // configuration for `chaseCycles`. Beside it, whether declaration order
      // beat another trigger-less transition at the same level to it. And, for
      // every input, whether an edge is the simulator's own step
      // (`simFrom`/`simTo`).
      const pick = enabled[0];
      const simStep = afterDuration(pick.transition) === undefined;
      const recordSim = (choice: EnabledTransition, target: number): void => {
        if (choice !== pick || !simStep) return;
        simFrom.push(here.index);
        simTo.push(target);
      };
      const recordChase = (choice: EnabledTransition, target: number): void => {
        if (input.kind !== 'completion' || choice !== pick) return;
        // NOT FROM A CONFIGURATION THE BUDGET STOPS A CHASE AT. The keyed walk
        // offers no completion there (`stopped`); the walk without the
        // position — which a machine that names no trigger keeps — still
        // follows the chase one step past it, and that step is one the
        // interpreter never fires: its chase reached this configuration on its
        // last step and stopped. Recorded, it closed a cycle no run goes round
        // (a 64-state chain whose last state steps back to the one before it).
        if (here.completionRun >= bounds.maxCompletion) return;
        const from = nodeConfig[here.index];
        if (chase[from] !== undefined) return;
        chase[from] = {
          next: nodeConfig[target],
          via: choice.transition.id,
          timed: afterDuration(choice.transition) !== undefined,
          choice:
            enabled.filter((e) => e.level === innermost).length > 1 ? here.config.stack[innermost] : null,
        };
      };

      for (const choice of enabled) {
        everEnabled.add(choice.transition.id);
        if (choice.level !== innermost) continue;
        // TAKEN, so `fired` — unless it is the completion step one past the
        // budget, from a configuration a chase reaches on its last step. The
        // walk without the position still takes that step on a machine that
        // names no trigger (a 64-state chain whose last state steps back, which
        // `recordChase` leaves out for the same reason), and the interpreter
        // never does: its chase stops there. Every other step this loop takes
        // is one some run of the walk takes, the tie-break's and the dwells'
        // included, and a bound below that refuses its target refuses only
        // where the run goes next, not the step.
        if (input.kind !== 'completion' || here.completionRun < bounds.maxCompletion) {
          fired.add(choice.transition.id);
        }
        const next = stepConfig(model, here.config, choice);
        for (const v of next.effects.visited) reachable.add(v);
        const hash = hashConfig(next.config, history);
        const { key, run } = keyOf(next.config, hash, input.kind === 'completion' ? here.completionRun + 1 : 0);
        // THE REVISIT EDGE IS RECORDED HERE, BEFORE THE PRUNE, and then the
        // prune happens exactly as it always did. The admission point below
        // records the other half; this is the one line the retained relation's
        // honesty turns on, because recording ONLY there would keep the BFS
        // SPANNING TREE, which is acyclic by construction on every machine in
        // this repository, and the two edges this site contributes on
        // `FlightModes` are precisely the cycle-closing ones.
        const known = seen.get(key);
        if (known !== undefined) {
          succ[here.index].push(known);
          if (input.kind === 'completion') completionSucc[here.index].push(known);
          recordSim(choice, known);
          recordChase(choice, known);
          continue;
        }

        // The walk WITHOUT the chase position cannot follow a chase past the
        // budget — it does not know where the chase stops — so it stops there
        // and says so, and `chaseBudgetDecides` sends the machine to the walk
        // that can. `>`, not `>=`: the interpreter's chase fires `maxCompletion`
        // transitions and only THEN asks whether anything is still enabled, so
        // a configuration reached in exactly `maxCompletion` completion steps
        // is one it reaches cleanly. The keyed walk never gets here: at the
        // budget it offers events and no completion.
        if (!keyed && run > bounds.maxCompletion) {
          boundHit = 'completion';
          continue;
        }
        // THE DEPTH BOUND COUNTS EVENTS, not steps. A completion step is
        // bounded already — the chase budget stops a chase after
        // `maxCompletion` of them, and the walk without the position cuts one
        // longer above — so what can grow without end is the number of events a
        // run takes, and that is what `maxDepth` bounds. It counted every step
        // once, and a chase the budget stops costs `maxCompletion` of them: four
        // completion cycles stacked one behind another, each left on an event,
        // put the fourth event's target 260 steps out and past the bound,
        // though a run reaches it on four events (`docs/06` §8.12). The `depth`
        // this walk prints is still its steps.
        const events = here.events + (input.kind === 'completion' ? 0 : 1);
        if (events > bounds.maxDepth) {
          boundHit = 'depth';
          continue;
        }
        if (seen.size >= bounds.maxConfigs) {
          boundHit = 'configs';
          continue;
        }
        // AFTER the bound gates, so no edge points at a configuration a bound
        // refused: such a target is never given a number, and nothing in the
        // relation can name it.
        const to = seen.size;
        seen.set(key, to);
        nodeConfig.push(intern(hash));
        succ.push([]);
        completionSucc.push([]);
        nodeRun.push(run);
        succ[here.index].push(to);
        if (input.kind === 'completion') completionSucc[here.index].push(to);
        recordSim(choice, to);
        recordChase(choice, to);
        configStates.push(next.config.stack);
        configLeaves.push(leafOf(next.config));
        queue.push({
          config: next.config,
          depth: here.depth + 1,
          events,
          completionRun: run,
          index: to,
          hash,
        });
      }
    }

    if (!anyEnabled) recordDeadlock(model, here, deadlockSeen, deadlocks);
  }

  return {
    configs: seen.size,
    depth,
    exhaustive: boundHit === 'none',
    boundHit,
    reachable,
    enabled: everEnabled,
    fired,
    offered,
    nondeterminism,
    deadlocks,
    undeterminedGuards: [...undeterminedGuards.values()],
    successors: succ,
    configStates,
    configLeaves,
    completionSuccessors: completionSucc,
    chaseKeyed: keyed,
    chaseStops,
    chaseCycles: chaseCyclesOf(nodeConfig, chase, chaseUndecided, {
      successors: succ,
      simulator: { from: simFrom, to: simTo },
      position: (v, dist) => (keyed ? nodeRun[v] : dist),
      maxCompletion: bounds.maxCompletion,
    }),
  };
}

/** The step the interpreter's chase takes from one configuration (`walkConfigurations`). */
interface ChaseStep {
  /** The configuration it leads to, by its interned index. */
  next: number;
  /** The transition it fires. */
  via: ElementId;
  /** That transition is a dwell. */
  timed: boolean;
  /** The state where it beat another enabled trigger-less transition at its level, or `null`. */
  choice: ElementId | null;
}

/**
 * The cycles of the interpreter's chase over one walk's configurations
 * ({@link ExploreResult.chaseCycles}).
 *
 * The chase is a FUNCTION — at most one step per configuration — so following
 * it from each configuration not yet seen either runs into a configuration
 * already finished, stops where the walk recorded no step, or closes a cycle on
 * its own path; the three colours tell which. Iterative, because a machine is
 * free to be a chain of thousands of states. The cycles come back in the order
 * the walk first numbered one of their configurations, so the rows a report
 * prints are in discovery order like every other list it prints.
 *
 * THE WAY IN, ONCE FOR EVERY CYCLE. One breadth-first pass over the
 * simulator's steps and one over the walk's whole relation, from the opening,
 * and each cycle reads its own nodes off the two — never a pass per cycle,
 * which a store an event counts turns into thousands of cycles (two counters
 * to 60: 3,721 cycles over 245,586 configurations). A cycle's way in is the
 * simulator's shortest run to a node of it from which the chase still has the
 * budget to go once round; where the walk holds none, the walk's own shortest
 * path, and the node where it first takes a step the simulator does not take
 * there. Each cycle is rotated to start at the configuration its way in leads
 * into.
 */
function chaseCyclesOf(
  nodeConfig: readonly number[],
  chase: readonly (ChaseStep | undefined)[],
  undecided: ReadonlySet<number>,
  way: WayIn,
): ChaseCycle[] {
  const count = nodeConfig.reduce((n, c) => Math.max(n, c + 1), 0);
  const firstNode = new Int32Array(count).fill(-1);
  nodeConfig.forEach((c, v) => {
    if (firstNode[c] === -1) firstNode[c] = v;
  });
  const colour = new Uint8Array(count); // 0 unseen, 1 on the current path, 2 finished
  const found: number[][] = [];
  for (let start = 0; start < count; start++) {
    if (colour[start] !== 0) continue;
    const path: number[] = [];
    let c: number | undefined = start;
    while (c !== undefined && colour[c] === 0) {
      colour[c] = 1;
      path.push(c);
      c = chase[c]?.next;
    }
    if (c !== undefined && colour[c] === 1) found.push(path.slice(path.indexOf(c)));
    for (const p of path) colour[p] = 2;
  }
  if (found.length === 0) return [];

  // Each configuration's cycle, and so each cycle's nodes, in ONE pass.
  const cycleOf = new Int32Array(count).fill(-1);
  found.forEach((members, k) => {
    for (const c of members) cycleOf[c] = k;
  });
  const nodesOf: number[][] = found.map(() => []);
  nodeConfig.forEach((c, v) => {
    if (cycleOf[c] !== -1) nodesOf[cycleOf[c]].push(v);
  });
  const walkBfs = breadthFirstFromOpening(nodeConfig.length, (v, visit) => {
    for (const w of way.successors[v]) visit(w);
  });
  // The simulator's steps as adjacency, built here and only here: offsets into
  // one array of targets, by source node.
  const offset = new Int32Array(nodeConfig.length + 1);
  for (const v of way.simulator.from) offset[v + 1]++;
  for (let v = 0; v < nodeConfig.length; v++) offset[v + 1] += offset[v];
  const target = new Int32Array(way.simulator.to.length);
  const fill = offset.slice(0, nodeConfig.length);
  way.simulator.from.forEach((v, i) => {
    target[fill[v]++] = way.simulator.to[i];
  });
  const simStepTo = (v: number, w: number): boolean => {
    for (let i = offset[v]; i < offset[v + 1]; i++) if (target[i] === w) return true;
    return false;
  };
  const simBfs = breadthFirstFromOpening(nodeConfig.length, (v, visit) => {
    for (let i = offset[v]; i < offset[v + 1]; i++) visit(target[i]);
  });
  const trace = (parent: Int32Array, v: number): number[] => {
    const path: number[] = [];
    for (let u = v; u !== -1; u = parent[u]) path.push(u);
    return path.reverse();
  };

  const cycles = found.map((members, k): ChaseCycle => {
    const nodes = nodesOf[k];
    // A run the simulator makes: the node of the cycle its steps reach first
    // with the budget left to go once round from there.
    let sim = -1;
    for (const v of nodes) {
      if (simBfs.rank[v] === -1) continue;
      if (way.position(v, simBfs.dist[v]) + members.length > way.maxCompletion) continue;
      if (sim === -1 || simBfs.rank[v] < simBfs.rank[sim]) sim = v;
    }
    let entry: number[];
    let branchAt: number | null = null;
    if (sim !== -1) {
      entry = trace(simBfs.parent, sim);
    } else {
      let at = -1;
      for (const v of nodes) if (walkBfs.rank[v] !== -1 && (at === -1 || walkBfs.rank[v] < walkBfs.rank[at])) at = v;
      // Every node the walk numbered it reached from node 0 — so this is a
      // defect in the producer, as `entryPath`'s is.
      if (at === -1) throw new Error('a cycle of the chase is not reachable from the walk’s opening');
      entry = trace(walkBfs.parent, at);
      for (let i = 0; i + 1 < entry.length; i++) {
        if (!simStepTo(entry[i], entry[i + 1])) {
          branchAt = entry[i];
          break;
        }
      }
    }
    // Round in chase order, from the configuration the way in leads into.
    const at = members.indexOf(nodeConfig[entry[entry.length - 1]]);
    const round = [...members.slice(at), ...members.slice(0, at)];
    return {
      order: round.map((c) => firstNode[c]),
      via: round.map((c) => chase[c]!.via),
      nodes,
      first: round.reduce((n, c) => Math.min(n, firstNode[c]), Infinity),
      undecided: round.some((c) => undecided.has(c)),
      timed: round.some((c) => chase[c]!.timed),
      choices: round.map((c) => chase[c]!.choice).filter((s): s is ElementId => s !== null),
      entry,
      entryBy: sim !== -1 ? 'simulator' : 'walk',
      branchAt,
    };
  });
  return cycles.sort((a, b) => a.first - b.first);
}

/** What {@link chaseCyclesOf} reads a cycle's way in from. */
interface WayIn {
  /** The walk's successor relation. */
  successors: readonly (readonly number[])[];
  /** The edges of it the simulator's own steps make, as parallel source and target lists. */
  simulator: { from: readonly number[]; to: readonly number[] };
  /**
   * The chase position a run of the simulator is at when its steps reach node
   * `v`, `dist` of them from the opening: the node's own in the keyed walk,
   * which keys it; `dist` itself in the walk without it, which only a machine
   * that names no trigger keeps with a cycle in it — every run of such a
   * machine is the one chase from the opening, so each of its steps is a
   * chase step.
   */
  position: (v: number, dist: number) => number;
  maxCompletion: number;
}

/**
 * Breadth-first over one relation on `n` nodes from the opening (node 0): each
 * node's rank in the order it was reached (`-1`: never), its parent, and its
 * distance. The lowest-ranked node of a set is the one a breadth-first search
 * for the set would have stopped at — {@link entryPath}'s answer, for every set
 * at once.
 */
function breadthFirstFromOpening(
  n: number,
  successorsOf: (v: number, visit: (w: number) => void) => void,
): {
  rank: Int32Array;
  parent: Int32Array;
  dist: Int32Array;
} {
  const rank = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n).fill(-1);
  if (n === 0) return { rank, parent, dist };
  const queue = new Int32Array(n);
  let tail = 0;
  queue[tail++] = 0;
  rank[0] = 0;
  dist[0] = 0;
  for (let head = 0; head < tail; head++) {
    const v = queue[head];
    successorsOf(v, (w) => {
      if (rank[w] !== -1) return;
      rank[w] = tail;
      parent[w] = v;
      dist[w] = dist[v] + 1;
      queue[tail++] = w;
    });
  }
  return { rank, parent, dist };
}

/**
 * Can the interpreter's chase budget stop a chase on this machine — read off a
 * walk made WITHOUT the chase position?
 *
 * Yes where that walk met a chase longer than the budget and had to cut it
 * (`boundHit: 'completion'`). Otherwise yes exactly where the completion edges
 * it retained hold a cycle, or a path of more than `maxCompletion` of them:
 * every configuration that walk numbered is one some chase passes through, so
 * such a path is the tail of a chase the budget stops — on a cycle, every
 * chase that enters it — and a walk that took no event there was missing the
 * runs the interpreter takes after it.
 *
 * ON A MACHINE THAT NAMES NO TRIGGER TOO, where the answer goes to the two
 * claims about where a run ends rather than to a second walk. A stopped chase
 * there is followed by nothing, and an uncut walk already reached every
 * configuration the run passes through — but it also followed the chase past
 * the budget, so a run it holds ends round a cycle or at a chain's far end
 * instead of where the interpreter's does. `exploreMachine` keeps that walk and
 * names the stops on it ({@link openingChaseStops}).
 */
function chaseBudgetDecides(walk: Walked, bounds: ExploreBounds): boolean {
  if (walk.boundHit === 'completion') return true;
  // The longest completion path out of every node, iteratively, with the
  // usual three colours: a grey node met again closes a cycle. Iterative
  // because a machine is free to be a chain of thousands of states.
  const out = walk.completionSuccessors;
  const longest = new Int32Array(out.length);
  const colour = new Uint8Array(out.length); // 0 white, 1 grey, 2 black
  for (let root = 0; root < out.length; root++) {
    if (colour[root] !== 0 || out[root].length === 0) continue;
    const stack: Array<{ v: number; next: number }> = [{ v: root, next: 0 }];
    colour[root] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.next < out[top.v].length) {
        const w = out[top.v][top.next++];
        if (colour[w] === 1) return true; // a cycle of completion steps
        if (colour[w] === 0) {
          colour[w] = 1;
          stack.push({ v: w, next: 0 });
        }
        continue;
      }
      let best = 0;
      for (const w of out[top.v]) best = Math.max(best, longest[w] + 1);
      if (best > bounds.maxCompletion) return true;
      longest[top.v] = best;
      colour[top.v] = 2;
      stack.pop();
    }
  }
  return false;
}

/**
 * Where the budget stops the one chase a machine that names no trigger runs —
 * read off a walk made WITHOUT the chase position, which such a machine keeps
 * (the note above `exploreMachine`).
 *
 * With no event to take, every run of it is the chase from the opening, and
 * every step of the walk's relation is a completion step one tie-break or
 * another takes. So a run spends its budget exactly at the end of a path of
 * `maxCompletion` edges from the opening, and it stops there where a completion
 * transition is still due — where the walk recorded an edge out. Those
 * configurations, ascending: the ones the walk with the position would have
 * found stopped, without walking the machine a second time to find them.
 */
function openingChaseStops(walk: Walked, bounds: ExploreBounds): number[] {
  const ends = chaseEnds(walk.successors, bounds.maxCompletion, () => true);
  return ends.filter((v) => walk.completionSuccessors[v].length > 0);
}

/**
 * The configurations a path of exactly `steps` edges from the opening ends at,
 * stepping only through configurations `inside` admits (the opening included),
 * ascending. Layer by layer, so a cycle costs nothing extra: the answer is a
 * set per layer, never a set of paths.
 *
 * EXPORTED for one reader outside this file, the modality in `./patterns`: on a
 * machine that names no trigger, a run that keeps clear of a violation for
 * the whole of the chase budget is one such path inside the set of
 * configurations that keep clear of it, and the interpreter stops that run
 * before it violates anything.
 */
export function chaseEnds(
  successors: readonly (readonly number[])[],
  steps: number,
  inside: (node: number) => boolean,
): number[] {
  if (successors.length === 0 || !inside(0)) return [];
  let layer = new Uint8Array(successors.length);
  layer[0] = 1;
  for (let step = 0; step < steps; step++) {
    const next = new Uint8Array(successors.length);
    let any = false;
    for (let v = 0; v < successors.length; v++) {
      if (layer[v] === 0) continue;
      for (const w of successors[v]) {
        if (!inside(w)) continue;
        next[w] = 1;
        any = true;
      }
    }
    if (!any) return [];
    layer = next;
  }
  const out: number[] = [];
  for (let v = 0; v < successors.length; v++) if (layer[v] === 1) out.push(v);
  return out;
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

/**
 * May this deadlock row be published — asked of the configuration it is about?
 *
 * A deadlock row is an absence claim over ONE configuration's outgoing edges:
 * *nothing enabled here*. What can make it wrong is an edge out of THIS
 * configuration that the walk could not decide, and nothing else — a bound
 * cannot, because the walk evaluated every input at a configuration it
 * dequeued, and neither can an undecided guard in a region the row is not
 * standing in.
 *
 * OVER THE WHOLE STACK AND NOT OVER THE LEAF ALONE. `stepCandidates` offers
 * every edge leaving any member of the active stack, so a composite state's own
 * outgoing transition is an edge out of every configuration inside it — and a
 * leaf-only reading would publish *"no way out"* about a configuration whose way
 * out is a guard on its parent that decided nothing. The stack includes the
 * leaf, so this is the leaf reading plus the ancestors it has to cover to be
 * sound.
 *
 * IT IS CONSERVATIVE IN ONE DIRECTION, DELIBERATELY. `undeterminedGuards` is one
 * row per transition, not one per configuration the transition was consulted at,
 * so an edge that decided nothing somewhere else and would have decided here is
 * counted against this row too. That withholds a row this walk could have
 * stated; the other direction would state one it could not.
 */
function nothingUndecidedLeaves(
  row: DeadlockRow,
  undecidedExits: ReadonlySet<ElementId>,
): boolean {
  return row.stack.every((s) => !undecidedExits.has(s.id));
}

/**
 * What prints where a withheld deadlock row would have been (register row A0's
 * `otherwise` cell: *the row is withheld and the store sentence prints in its
 * place*).
 *
 * A WITHHELD ROW IS NOT A ROW THAT WAS NOT FOUND, and the difference is the
 * whole reason this line exists. The walk did reach a configuration it could
 * offer no edge out of; what it cannot say is that there is none, because one of
 * the edges it could not decide leaves that very configuration. Printing
 * nothing would leave a reader who fixes the guard surprised by a row that
 * appeared from nowhere — and would leave the report's own *the no-way-out list
 * is withheld* sentence with nothing to point at.
 *
 * The tail is `CLAUSE_SENTENCE.store` verbatim: the mechanism is the same one
 * the exactness gate names, so it is named in the same words even though this
 * row is gated on the per-configuration conjunct and not on that gate.
 */
export const DEADLOCK_WITHHELD_SENTENCE =
  `no enabled way out was found and none is reported: ${CLAUSE_SENTENCE.store}`;

/* ─────────────────────────────── the traps ──────────────────────────────── */

/**
 * The re-wording a trap's `entry` path would take if it were ever published
 * over a relation that is not the machine's (register row W2, plan §3.2a).
 *
 * WRITTEN NOW, PRINTED NOWHERE, AND ASSERTED SO. The entry path is a positive
 * claim — *this run exists* — and a walk that offers a dwell or a trigger the
 * environment may never supply can invent it. Where a positive witness
 * survives such a walk, the plan re-words it rather than suppressing it:
 * `` Entered in ${k} step(s) from `${s}` — on a run this WALK admits: step ${i}
 * fires `${label}` … ``. Today the trap row is suppressed whole with A6, so the
 * re-wording has nothing to attach to; it exists so that a per-claim relaxation
 * of the gate cannot be made silently — the sentence that relaxation would have
 * to print is already here, and `test/unit/semantics.mc.traps.test.ts` asserts
 * it reaches no output. The per-step check it would need — was this step taken
 * across a dwell or an undecided guard — has no producer yet: the retained
 * relation carries node numbers and no transition per edge.
 */
export const TRAP_ENTRY_WALK_ADMITS = 'on a run this WALK admits';

/**
 * What the text report prints in place of the trap list on the four clauses
 * that refuse a walk that FINISHED (plan §3.2a's verdict table, and the chase
 * budget's clause beside them).
 *
 * A bound and an unsupported construct print nothing here: the existing
 * SUPPRESSED and not-explored lines already say why every list is short. These
 * four are the clauses those lines do not cover — the walk saw the whole graph
 * its step relation admits, and that relation is still not the machine's.
 * Each is followed in the report by the standing sentence for its mechanism;
 * the budget's has none beyond itself, because no other line names it.
 */
export const TRAP_REFUSAL_SENTENCE: Record<'environment' | 'time' | 'store' | 'budget', string> = {
  environment:
    'inconclusive: this machine names triggers this walk offers wherever it can decide that the interpreter takes its next event, so an escape it found may be one the environment never supplies and no absence of an escape is claimed',
  time: 'inconclusive: this machine carries `after(n)` dwell transitions this walk takes without advancing a clock, so the escape relation is an over-approximation and no absence of an escape is claimed',
  // "an expression this walk could not evaluate" and not "an attribute with no
  // declared value": the store clause is the SHIPPED predicate, which also
  // refuses `not mode` over a fully valued `mode` (`trapguard-typed.sysml`),
  // and a sentence naming only the unvalued case would be false on that file.
  store:
    'inconclusive: a transition of this machine is guarded by an expression this walk could not evaluate — most often an attribute with no declared value — so this walk never offered an edge the model states and a set it calls inescapable may not be',
  budget:
    'inconclusive: the interpreter\u2019s chase budget stops a run of this machine with a completion transition still due, so where a run comes to rest is decided by the budget and not by the edges this walk follows, and no set is claimed inescapable and no absence of an escape is claimed',
};

/**
 * Each bottom component of the retained relation, sorted into the three
 * exemptions and the traps — ONE reading of the exemptions, for both the rows
 * and the census.
 *
 * THE ORDER IS `recordDeadlock`'S ORDER, and it is load-bearing. An ending is
 * tested FIRST: a `done` node has no successor, so a single-member test run
 * first would count every ending as a deadlock and the mission DAG would read
 * *1 deadlocked configuration(s)* about a machine that publishes none. The opening's
 * component is tested last because it is the widest: on a machine that is one
 * component, every configuration is in it, and testing it first would hide an
 * ending inside it — which is fine — but the counts are meant to name the
 * narrowest reason a component was exempted.
 *
 * A SELF-LOOPING SINGLETON IS A TRAP. It has a successor, so it is not a
 * deadlock row; if it is not an ending and not the opening, nothing leaves it
 * and the machine was not meant to stop there.
 *
 * EXPORTED for one reader outside this file: `recoveryRow` (`./patterns`,
 * §3.2b), whose *"Of these, N form a set nothing leaves"* clause counts the
 * cannot-reach configurations that sit inside a trap — read off THIS
 * classifier, with THIS exemption order, so that number can never disagree
 * with the `verification/unrecoverable-mode` row `reach` prints on the same
 * machine. `trapsOf` below returns rows without node indices, which is why the
 * classifier is the export and not the row producer. Not in the API barrel:
 * `reachReport` is the door.
 */
export function classifyBottoms(
  model: Model,
  walk: ExploreResult,
  comps: Components,
): { traps: (readonly number[])[]; ending: number; deadlock: number; core: number } {
  const out = { traps: [] as (readonly number[])[], ending: 0, deadlock: 0, core: 0 };
  for (const members of bottomComponents(walk.successors, comps)) {
    const isEnding = members.every((i) => {
      const leaf = walk.configLeaves[i];
      return leaf !== null && (isFinalState(model, leaf) || isTerminalNode(model, leaf));
    });
    if (isEnding) out.ending++; // an ending, not a trap — the same two predicates the deadlock row reads
    else if (members.length === 1 && walk.successors[members[0]].length === 0)
      out.deadlock++; // a configuration with no successor is `verification/deadlock`'s subject
    else if (members.includes(0))
      out.core++; // the reachable set itself: there is nowhere to be trapped FROM
    else out.traps.push(members);
  }
  return out;
}

/** The shortest node path from the opening into `target`, breadth-first over the relation. */
function entryPath(successors: readonly (readonly number[])[], target: ReadonlySet<number>): number[] {
  const parent = new Int32Array(successors.length).fill(-1);
  const seen = new Uint8Array(successors.length);
  const queue = [0];
  seen[0] = 1;
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    if (target.has(v)) {
      const path: number[] = [];
      for (let u = v; u !== -1; u = parent[u]) path.push(u);
      return path.reverse();
    }
    for (const w of successors[v]) {
      if (seen[w]) continue;
      seen[w] = 1;
      parent[w] = v;
      queue.push(w);
    }
  }
  // Every bottom component is reachable from node 0 by construction — the walk
  // numbered only what it reached — so this is a defect in the producer.
  throw new Error('a bottom component of the walk is not reachable from its opening');
}

/**
 * The trap rows of an EXACT walk. Called only where the gate holds — the
 * caller's ternary in `reachOne` is the gate, and it is what the reflection
 * suite pins.
 */
function trapsOf(model: Model, walk: ExploreResult, comps: Components): TrapRow[] {
  return classifyBottoms(model, walk, comps).traps.map((members) => {
    // The union of the active STACKS, in node order, once each — a composite
    // state on the stack of every configuration inside it is named once.
    const stack: ElementId[] = [];
    const seen = new Set<ElementId>();
    for (const i of members) {
      for (const s of walk.configStates[i]) {
        if (seen.has(s)) continue;
        seen.add(s);
        stack.push(s);
      }
    }
    const path = entryPath(walk.successors, new Set(members));
    const entry = path.map((i) => {
      const leaf = walk.configLeaves[i];
      const states = walk.configStates[i];
      return stateRef(model, leaf ?? states[states.length - 1]);
    });
    return {
      configs: members.length,
      states: stack.map((s) => stateRef(model, s)),
      entry,
      steps: path.length - 1,
    };
  });
}

/** The trap census, on every walk: the relation's facts always, the machine's answers only under the gate. */
function trapCensusOf(
  model: Model,
  walk: ExploreResult,
  comps: Components,
  traps: readonly TrapRow[],
  gate: Exactness,
): TrapCensus {
  const bottoms = bottomComponents(walk.successors, comps);
  if (!gate.walkIsExact) {
    return {
      sccs: comps.members.length,
      bottomSccs: bottoms.length,
      trapsAfterExemptions: null,
      exemptedAsEnding: null,
      exemptedAsDeadlock: null,
      exemptedAsCore: null,
      refusedByGate: gate.failedClause,
      sentence: null,
    };
  }
  const sorted = classifyBottoms(model, walk, comps);
  return {
    sccs: comps.members.length,
    bottomSccs: bottoms.length,
    trapsAfterExemptions: traps.length,
    exemptedAsEnding: sorted.ending,
    exemptedAsDeadlock: sorted.deadlock,
    exemptedAsCore: sorted.core,
    refusedByGate: null,
    // Asserts no component cardinality — the mission DAG is five components —
    // and names what was exempted, so the deadlock row above and this sentence
    // are one accounting. Only when no trap was found: a machine with a trap
    // row has its answer in the row.
    sentence:
      traps.length === 0
        ? `no component of this walk is inescapable beyond its endings — ${sorted.ending} ending, ` +
          `${sorted.deadlock} deadlocked configuration(s) and ${sorted.core} whole-graph component were exempted, ` +
          `exhaustive under ${boundsSentence(walk.bounds)}`
        : null,
  };
}

/* ───────────────────────────── the livelocks ────────────────────────────── */

/**
 * The completion livelocks of a walk, published and withheld ({@link
 * LivelockRow}, {@link LivelockWithheldRow}).
 *
 * NOT GATED ON A BOUND, AND NOT ON THE EXACTNESS GATE, for the reason the
 * deadlock row is not. Every step a row stands on is one the walk TOOK — the
 * chase's step out of each configuration of the cycle, recorded from a
 * configuration it dequeued — so a bound elsewhere takes nothing away from it,
 * and a cycle through a configuration whose step a bound refused is not found
 * at all. Nor does a named trigger, the environment clause, touch it: the claim
 * is that the run moves on ONLY on an event, which holds whatever events an
 * environment would send. What it does rest on is that each step is the
 * interpreter's: a guard the walk could not evaluate among the trigger-less
 * transitions out of a configuration of the cycle, or a dwell as the step the
 * chase takes, withholds it — with a `withheld` line in its place. The way in
 * is existential, and register row W7 (`./publishable`) is its wiring: a run
 * the simulator makes where the walk holds one, the walk's own — said so in
 * the finding — where it does not.
 *
 * EXPORTED for one reader outside this file: `behaviourReport` (`./patterns`),
 * which files the same rows on the machine it checks, in the same words
 * ({@link livelockFinding}). Not in the API barrel: `reachReport` is the door.
 */
export function livelocksOf(
  model: Model,
  walk: ExploreResult,
): { livelocks: LivelockRow[]; withheld: LivelockWithheldRow[] } {
  // ONE ROW PER CYCLE OF STATES. The cycles that go round the same transitions
  // and differ only in the store or history they carry — an event that counts
  // before the chase starts makes one per count — are one group, published or
  // withheld on the same clause, in the order the walk met the first of them.
  const groups = new Map<string, { clause: LivelockWithheldRow['clause'] | null; cycles: ChaseCycle[] }>();
  for (const cycle of walk.chaseCycles) {
    const clause = cycle.undecided ? 'store' : cycle.timed ? 'time' : null;
    const key = `${clause ?? ''}|${[...new Set(cycle.via)].sort().join(' ')}`;
    const group = groups.get(key);
    if (group) group.cycles.push(cycle);
    else groups.set(key, { clause, cycles: [cycle] });
  }
  const livelocks: LivelockRow[] = [];
  const withheld: LivelockWithheldRow[] = [];
  for (const { clause, cycles } of groups.values()) {
    // The row reads the cycle with the best way in: a run the simulator makes
    // before one only the walk makes, then the shortest, then the first met.
    const best = cycles.reduce((a, b) =>
      (b.entryBy === 'simulator' && a.entryBy === 'walk') || (b.entryBy === a.entryBy && b.entry.length < a.entry.length)
        ? b
        : a,
    );
    // The union of the active stacks, in chase order, once each — as a trap's.
    const states: ElementId[] = [];
    const seen = new Set<ElementId>();
    for (const i of best.order) {
      for (const s of walk.configStates[i]) {
        if (seen.has(s)) continue;
        seen.add(s);
        states.push(s);
      }
    }
    const leafRef = (i: number): StateRef => {
      const stack = walk.configStates[i];
      return stateRef(model, walk.configLeaves[i] ?? stack[stack.length - 1]);
    };
    const row: LivelockRow = {
      configs: best.order.length,
      states: states.map((s) => stateRef(model, s)),
      transitions: best.via.map((t) => transitionRef(model, model.get(t)!)),
      choices: [...new Set([best, ...cycles].flatMap((c) => c.choices))].map((s) => stateRef(model, s)),
      entry: best.entry.map(leafRef),
      steps: best.entry.length - 1,
      entryBy: best.entryBy,
      branchAt: best.branchAt === null ? null : leafRef(best.branchAt),
      cycles: cycles.length,
    };
    if (clause === null) livelocks.push(row);
    else withheld.push({ ...row, clause });
  }
  return { livelocks, withheld };
}

/**
 * The `verification/completion-livelock` finding for one row — ONE composer,
 * read by `reachReport` and by `behaviourReport` (`./patterns`), so the two
 * commands file a cycle in the same words.
 *
 * Every clause is read off the row and the machine's bounds, never off the
 * rest of the report. The way in is hedged where THIS row's way in is the
 * walk's and not the simulator's ({@link LivelockRow.entryBy}) — not wherever
 * the machine has a choice row: a choice row the walk withholds (an undecided
 * guard inside the choice's level) leaves a branch the walk still took, and a
 * choice elsewhere on the machine says nothing about this row's way in. On a
 * machine that names no trigger, nothing moves a stopped chase on, and the
 * finding says the run ends there rather than that an event moves it.
 */
export function livelockFinding(
  machine: { id: ElementId; qualifiedName: string },
  row: LivelockRow,
  bounds: ExploreBounds,
): Omit<Diagnostic, 'id' | 'ruleId' | 'source'> {
  const names = row.states.map((s) => s.name).join(', ');
  return {
    severity: 'warning',
    message:
      `\`${machine.qualifiedName}\`: completion livelock — the interpreter's chase goes round ` +
      `{${names}} without coming to rest: at each of these ${row.configs} configuration(s) the ` +
      'trigger-less transition it fires leads to the next, so a run that gets here goes round until ' +
      `its ${bounds.maxCompletion}-step chase budget is spent` +
      (bounds.alphabet.length === 0
        ? ' and ends there: the machine names no trigger, so no event moves it on.'
        : ' and moves on only on an event.') +
      ` Entered in ${row.steps} step(s) from \`${row.entry[0].name}\`.` +
      (row.cycles > 1
        ? ` The same states are gone round in ${row.cycles} cycles of configurations, which differ only in the store or history they carry; this one row stands for all of them.`
        : '') +
      (row.choices.length > 0
        ? ` At ${row.choices
            .map((s) => `\`${s.qualifiedName}\``)
            .join(', ')} another trigger-less transition is enabled beside the one the chase fires, and the simulator never takes it: declaration order decides there, and keeps the chase on the cycle.`
        : '') +
      (row.entryBy === 'walk'
        ? row.branchAt !== null
          ? ` The way in is a run of the walk, not one \`simulate\` makes: at \`${row.branchAt.qualifiedName}\` it takes a step the simulator does not take there, and the walk holds no run the simulator makes that goes round the cycle, so \`simulate\` may never enter it.`
          : ' The way in is a run of the walk, not one `simulate` makes: the simulator’s chase gets there with too little of its budget left to go round, and the walk holds no run the simulator makes that does.'
        : ''),
    elementId: row.states[0].id,
    elementName: row.states[0].qualifiedName,
    code: COMPLETION_LIVELOCK_CODE,
    hint: 'Give the machine somewhere to rest: put a trigger on a transition of the cycle, so the run waits there for that event, or a guard that is false where it should wait — a configuration with no trigger-less transition enabled is where a chase stops. This is a reading of ONE machine under the printed bounds: it says the interpreter’s chase does not settle here and the budget is what stops it, never that the system it models loops.',
  };
}

/**
 * What prints where a livelock row was withheld, per clause: the clause
 * sentence of the gate's register, so a withheld row is named in the words the
 * other withheld rows use.
 */
export function livelockWithheldSentence(clause: LivelockWithheldRow['clause']): string {
  return `the chase goes round these configuration(s) on trigger-less transitions and no livelock is reported: ${CLAUSE_SENTENCE[clause]}`;
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
    /**
     * How many a step of some explored run takes ({@link ExploreResult.fired}).
     * With `dead` it need not add up to `total`: a transition enabled where
     * no run takes it — beaten by the priority rule, or due where the chase
     * budget stops a chase — is neither.
     */
    fired: number;
    /** EMPTY whenever the walk was not exhaustive, for the same reason. */
    dead: readonly TransitionRef[];
  };
  nondeterminism: readonly NondeterministicChoice[];
  /**
   * The rows that MAY be stated — one per reached configuration with no enabled
   * edge out and no undecided one either.
   *
   * A deadlock row is an absence claim about ONE configuration's outgoing edges,
   * and an edge the walk could not decide is exactly what makes it wrong — so
   * the question is asked of the configuration each row is about rather than of
   * the whole walk (register row A0). What the question withheld is
   * {@link deadlocksWithheld}, and the two together are every row the walk
   * found: a reader who meets a short list here has the rest beside it and the
   * reason with them.
   */
  deadlocks: readonly DeadlockRow[];
  /**
   * The rows the undecided-guard conjunct withheld — never silently dropped.
   *
   * NON-EMPTY IS WHY THE SENTENCES ABOVE SAY WHAT THEY SAY. `qualification`, the
   * report's trailing line and the `verification/guard-undetermined` finding
   * each name the no-way-out list as withheld exactly when this array is
   * non-empty, and name only the unreachable and dead lists when it is not —
   * because after A0 a machine can publish one configuration's row while
   * another's is withheld, and a sentence that said *the no-way-out list is
   * WITHHELD* beside a published `no way out` row would be the report
   * contradicting itself about one machine.
   */
  deadlocksWithheld: readonly DeadlockRow[];
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
  /**
   * What the walk was, as numbers — the exactness census (plan §5).
   *
   * Published on `--json` and printed in no report row, for the same reason the
   * edge census is: it is the KILL MEASUREMENT for the features this lane is
   * about to build — *does any model anyone loads have a dwell, a named
   * trigger, an undecided guard, a cycle* — and not a finding anybody acts on.
   * What a reader acts on is the row the gate withheld, and the sentence beside
   * it.
   */
  exactness: ExactnessCensus;
  /**
   * The sets of configurations no run leaves that are not endings, not
   * deadlock rows and not the machine's own core (plan §3.2a).
   *
   * GATED ON `walkIsExact` — register row A6, polarity `increasing` — and NOT
   * on the `publishable` the two lists above read. The list's emptiness is the
   * claim *no trap*, which gets EASIER to state as edges are added, so the
   * over-approximating walk that keeps `unreachable` honest falsifies it; and
   * each row's *nothing leaves this set* is falsified by a MISSING edge, which
   * a bound and an undecided guard both produce. EMPTIED when the gate refuses,
   * never shortened; {@link trapCensus} says which clause refused.
   */
  traps: readonly TrapRow[];
  /** What the component pass found and what was made of it — `--json`, like the two censuses above. */
  trapCensus: TrapCensus;
  /**
   * The cycles the interpreter's completion chase goes round without coming to
   * rest ({@link LivelockRow}): one row, and one
   * `verification/completion-livelock` warning, per cycle.
   */
  livelocks: readonly LivelockRow[];
  /** The cycles found and withheld, each printed as a `withheld` line naming its clause. */
  livelocksWithheld: readonly LivelockWithheldRow[];
  /** The guards this walk consulted and could not evaluate. Never `false`. */
  undeterminedGuards: readonly UndeterminedGuardRow[];
  /** True when the two absence lists were withheld — by a bound, or by an undecided guard. */
  suppressed: boolean;
}

/**
 * The shape of the walk, recorded per machine so a later feature can be retired
 * on a number rather than on a memory (plan §5's census table, commit 3).
 *
 * Every field is a count or a boolean over a walk that already happened: no new
 * traversal, no new compute, and — deliberately — no new sentence. The four
 * clause figures are recorded beside the verdict they produce so that a reader
 * of a recorded run can tell WHICH clause a withheld claim failed on without
 * re-running anything.
 */
export interface ExactnessCensus {
  /**
   * Has the retained relation no cycle — `true`, `false`, or `null` when the
   * question was not answered.
   *
   * THREE-VALUED, AND THAT IS LOAD-BEARING. It reads `null` whenever the walk
   * is not exact, which is WIDER than *whenever a bound was hit*: an edge
   * behind a guard nothing decided is a cycle-closing edge the walk never had,
   * so a machine whose stated relation cycles can be walked into an acyclic
   * one — measured on `trapguard.sysml`'s two-state machine, which hits no
   * bound at all and whose relation is two nodes and the single edge between
   * them. A boolean here would publish `true` about a graph nobody built: on
   * the unsupported-construct walk the relation is empty and an empty relation
   * has no cycle. The release condition of any later feature that reads this
   * field counts only `acyclic === true` on a walk where the gate holds.
   */
  acyclic: boolean | null;
  /** `!exhaustive` — this walk did not see the graph whole. */
  openFrontier: boolean;
  /** Edges in the retained relation, counted with their multiplicity. */
  edges: number;
  /** Clause (b): walkable transitions this engine reads as a dwell. */
  timedTransitions: number;
  /** Gates nothing — the dwell labels that reached the alphabet (plan §3.P). */
  timedLabels: number;
  /** Clause (c): distinct events the machine names. */
  alphabet: number;
  /** Clause (d): transitions whose guard was consulted and decided nothing. */
  undeterminedGuards: number;
  /** The gate itself, over both halves. */
  walkIsExact: boolean;
  /** Which clause failed, `null` exactly when the gate holds. */
  failedClause: FailedClause;
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
    /** Trap rows published — zero on every refused machine, by construction. */
    traps: number;
    /** Completion-livelock rows published, one per cycle. */
    livelocks: number;
  };
  diagnostics: Diagnostic[];
}

/** Options `reach` takes. */
export interface ReachOptions extends ExploreOptions {
  /** Only machines at or inside this element. */
  scopeId?: ElementId;
}

/**
 * Does this element own a state machine — a non-library element that directly
 * owns a TransitionUsage, or one marked parallel that contains one? The first
 * half of {@link stateMachinesIn}, and what decides whether a nested `state
 * def` a crossing leads into is a machine of its own (`acrossSentence`) — and
 * whether the properties a nested one carries have a machine to be checked on
 * (`propertiesOf`, `./patterns`).
 */
export function ownsMachine(model: Model, el: ElementRecord): boolean {
  if (el.attrs.isLibrary === true) return false;
  if (model.children(el.id).some((c) => c.eClass === 'TransitionUsage')) return true;
  return (
    (isTruthy(el.attrs.parallel) || isTruthy(el.attrs.isParallel)) &&
    model.descendants(el.id).some((d) => d.eClass === 'TransitionUsage')
  );
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
  const owners = model.all().filter((el) => ownsMachine(model, el));
  const ownerIds = new Set(owners.map((o) => o.id));
  const roots = owners.filter((el) => {
    // A nested `state def` is a machine of its OWN, not a region of the owner it
    // sits in: the outer walk stops at it (`regionDescendants`, `./config`) and
    // this definition is walked by itself, so its states decide themselves
    // instead of being reported unreachable in the outer machine's walk.
    if (el.eClass === 'StateDefinition') return true;
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

/**
 * `{maxConfigs …, maxDepth …, maxCompletion …, alphabet …, store …}`, spelled
 * out — the sentence every figure in every lane is true UNDER.
 *
 * ONE COPY, AND IT IS EXPORTED FOR THAT REASON. `checkProperty` (`./patterns`)
 * carried a byte-identical second copy, each of which composed the string every
 * one of its own absence rows is qualified by; two copies of a sentence that
 * must move together is the same defect the publishability conjunction had, one
 * document down.
 *
 * THE STORE CLAUSE IS NEW HERE AND IT IS A DELIBERATE RE-RECORD: it moves every
 * qualification string this tool prints, which is why it could not land in the
 * commit whose whole gate was *"`reach`'s output did not move"*. It says what
 * `exhaustive under {…}` has always meant — the walk opens from the literal
 * values the model declares, and a guard over an attribute with no declared
 * value is read the way the interpreter reads it. It is a DISCLOSURE and not a
 * condition: it says LESS than the guard clause the walk already publishes,
 * which covers guards that decided nothing for reasons other than an unvalued
 * feature, and where the two differ it is the `verification/guard-undetermined`
 * row that a reader acts on.
 *
 * "READ AS FALSE" IS THE INTERPRETER'S READING, AND SINCE H1 NOT QUITE THE
 * WALK'S. At a TRIGGERED guard the two agree: the walk takes no edge there. At
 * a COMPLETION guard they part: where nothing else is due, the interpreter
 * reads the guard as false and takes its next event, and the walk offers no
 * trigger there at all (the header's WHERE AN EVENT IS OFFERED). Either way the
 * guard is undecided, the machine fails the store clause and every absence on
 * it is withheld with the row that names the guard, so no claim rests on the
 * clause's wording. It is left as it stands because it is printed in every
 * qualification on every machine, and rewording it re-records them all (O1,
 * review of S4).
 *
 * APPENDED AFTER THE ALPHABET CLAUSE, and the position is not a style choice:
 * the process-level campaign asserts a PREFIX of this sentence that stops before
 * `alphabet` and asserts the alphabet clause separately as a substring, so an
 * appended clause keeps both true while one inserted earlier reddens the first.
 */
export function boundsSentence(b: ExploreBounds): string {
  const alphabet = b.alphabet.length === 0 ? 'no named trigger' : b.alphabet.join(', ');
  return (
    `{maxConfigs ${b.maxConfigs}, maxDepth ${b.maxDepth}, maxCompletion ${b.maxCompletion}, ` +
    `alphabet ${alphabet}, store seeded from declared literal values — a guard over an ` +
    'attribute with no declared value is read as false}'
  );
}

/**
 * Why a walk stopped, in the words the report prints.
 *
 * `'completion'` never reaches it from `reach`: a walk `exploreMachine`
 * returns does not carry that bound (the note on {@link BoundHit}). The case is
 * kept so the sentence stays one sentence wherever the product search in
 * `./patterns`, which keeps its own copy of this switch, prints it.
 */
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
 * What a reader can do about the bound a row was refused on — the sentence
 * every such refusal closes with.
 *
 * ONLY THE CONFIGURATION BOUND IS A FLAG. Advising `--max-configs` after a
 * depth hit, or after a chase the budget stops, sends an agent round a loop
 * that cannot end: the row comes back the same at every `N`. Measured on four
 * completion cycles stacked one behind another, each left on an event, while
 * the depth bound counted steps: every stopped chase cost the walk
 * `maxCompletion + 1` of them, and the search's refusal was identical at
 * `--max-configs 100000` (the bound counts events since `docs/06` §8.12, and
 * that machine is decided). `'none'` keeps the
 * configuration advice — a row refused because a trigger was never offered is
 * its own item (the plan's M2), and this function does not decide it.
 */
export function boundAdvice(hit: BoundHit): string {
  switch (hit) {
    case 'depth':
      return 'No flag raises the depth bound, so a re-run will not decide this: read the row as what it is, an answer over a walk cut at that depth.';
    case 'completion':
      return 'No flag decides it: past that budget the interpreter takes no further completion step, and this search refuses a run that would rather than follow it there.';
    default:
      return 'Raise the bound (`--max-configs N`) and re-run.';
  }
}

/**
 * Walk one machine and turn the walk into rows.
 *
 * The conditions of §3.8 — exhaustive, every named trigger offered, no
 * unsupported construct — and the one this tool learned the hard way, that
 * every guard the walk consulted decided something, are
 * `publishabilityOf(walk).decreasingOk` in `./publishable`. (§3.8's fourth, no
 * completion budget spent, went when the walk began to follow the budget the
 * way the interpreter does instead of cutting at it.) THEY ARE NOT
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
  // THE INCREASING GATE, AND EXACTLY ONE ROW BELOW READS IT: the trap list.
  // `unreachable`, `dead`, the deadlock rows and the qualification all keep
  // reading the decreasing conjunction, which is what makes them
  // monotone-decreasing claims an over-approximating walk cannot invent.
  // Pointing any of them at this gate would empty a sound finding out of a
  // shipped command the first time a machine carried a dwell; pointing the
  // trap list at THEIR conjunction would publish "no trap" over a walk that
  // supplied the escape itself.
  const gate = walkIsExact(walk, walk.bounds);
  // One Tarjan pass, read by the acyclicity census and the trap question both.
  const comps = tarjanComponents(walk.successors);
  // Register row A6, applied here and nowhere else: the whole field, on the
  // whole gate, and on nothing narrower. `test/unit/semantics.mc.publishable.test.ts`
  // reads this line back off the source.
  const traps = gate.walkIsExact ? trapsOf(model, walk, comps) : [];
  const trapCensus = trapCensusOf(model, walk, comps, traps, gate);
  // Neither gate: each row stands on steps the walk took and withholds itself
  // where one of them is not the interpreter's (`livelocksOf`).
  const { livelocks, withheld: livelocksWithheld } = livelocksOf(model, walk);

  const states = machineStates(model, machine.id);
  const transitions = walkableTransitions(model, machine.id);
  // Where an undecided guard COULD have been an edge out, by the node that edge
  // leaves. Read off the walkable relation rather than off the deadlock row,
  // because the row carries states and the guard rows carry transitions, and
  // the question a deadlock row asks is about the edges of the configuration it
  // stands in.
  const undecided = new Set(walk.undeterminedGuards.map((g) => g.transition.id));
  const undecidedExits = new Set<ElementId>();
  for (const t of transitions) if (undecided.has(t.id)) undecidedExits.add(t.source![0]);
  // BOTH HALVES ARE KEPT, and that is what lets the sentences below be true.
  // The withheld half is not a residue nobody reads: it is what decides whether
  // the qualification, the trailing report line and the guard finding may say
  // *the no-way-out list is withheld* at all, and it is what the report prints
  // the store sentence against (A0's `otherwise` cell).
  const deadlocks = walk.deadlocks.filter((row) => nothingUndecidedLeaves(row, undecidedExits));
  const deadlocksWithheld = walk.deadlocks.filter(
    (row) => !nothingUndecidedLeaves(row, undecidedExits),
  );
  const reachable = states.filter((s) => walk.reachable.has(s.id)).map((s) => stateRef(model, s.id));
  const unreachable = publishable
    ? states.filter((s) => !walk.reachable.has(s.id)).map((s) => stateRef(model, s.id))
    : [];
  const dead = publishable
    ? transitions.filter((t) => !walk.enabled.has(t.id)).map((t) => transitionRef(model, t))
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
          // AND IT NAMES ONLY WHAT WAS WITHHELD. The unreachable and dead lists
          // are emptied walk-wise and always have been, so they are named
          // unconditionally; the no-way-out list is withheld per configuration
          // (A0), so it is named only when a row actually went. Naming it
          // unconditionally is how this line came to sit three lines above a
          // published `no way out` row saying that row was not reported.
          `undetermined under ${boundsSentence(walk.bounds)} — ${walk.undeterminedGuards.length} guard(s) the walk could not evaluate${
            walk.boundHit === 'none' ? '' : `, and ${boundSentence(walk.boundHit)}`
          }; the unreachable and dead lists are WITHHELD and are NOT reported as findings${
            deadlocksWithheld.length === 0
              ? ''
              : `, as is the no-way-out row for ${deadlocksWithheld.length} configuration(s) whose only ways out are guards this walk could not decide`
          }`
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
    exactness: {
      // The ONE field of this census that is not a plain count, and the reason
      // it is not a boolean is that the question it answers is about the
      // machine while the graph it is computed over is the walk's. Where the
      // two are the same relation — the gate — the answer stands; where they
      // are not, the honest answer is that nothing was decided, and a `false`
      // would be as wrong as a `true`.
      acyclic: gate.walkIsExact ? acyclic(walk.successors, comps) : null,
      openFrontier: walk.openFrontier,
      edges: walk.successors.reduce((n, targets) => n + targets.length, 0),
      timedTransitions: walk.timedTransitions.size,
      timedLabels: walk.timedLabels.size,
      alphabet: walk.bounds.alphabet.length,
      undeterminedGuards: walk.undeterminedGuards.length,
      walkIsExact: gate.walkIsExact,
      failedClause: gate.failedClause,
    },
    nondeterminism: walk.nondeterminism,
    // Gated on the guards ALONE, not on `publishable`. A deadlock row says one
    // configuration the walk REACHED had no enabled edge out, and a bound
    // cannot make that wrong — the walk evaluates every input at a
    // configuration it dequeues, and a bound only stops it enqueueing
    // successors. An undetermined guard CAN make it wrong: it is an edge out
    // that may have been enabled, and nothing here decided whether it was.
    //
    // AND IT IS NOW ASKED OF THE CONFIGURATION RATHER THAN OF THE WALK, which
    // is a strengthening of the row's AVAILABILITY and not a relaxation of its
    // gate. The two readings agree wherever every guard decided — the set of
    // undecided edges is empty there, so the filter below is `walk.deadlocks`
    // verbatim and every shipped row is byte-identical. They differ on one
    // shape, and the tree now carries it: a machine with an undecided guard in
    // one region and a real sink in another. The walk-wise reading empties the
    // whole array over it, losing a fact about the design — a configuration
    // whose leaf has no outgoing edge at all, about which no guard was ever
    // consulted — to a question asked somewhere else entirely.
    //
    // WHAT THE QUESTION WITHHELD TRAVELS WITH IT. A0's `otherwise` cell is *the
    // row is withheld and the store sentence prints in its place*, so the
    // withheld rows are carried out of here rather than filtered away: the
    // report prints one line per withheld configuration, and the sentences that
    // say which lists are withheld read this array to decide whether they may
    // name the no-way-out list at all.
    deadlocks,
    deadlocksWithheld,
    traps,
    trapCensus,
    livelocks,
    livelocksWithheld,
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
        // THE TAIL NAMES ONLY WHAT WAS WITHHELD, for the reason the
        // qualification does: the unreachable and dead lists go walk-wise, so
        // an undecided guard anywhere empties them; a no-way-out row goes only
        // where the undecided edge is one out of the configuration the row
        // stands in (A0). On a machine where none was, this finding used to say
        // a list was withheld that the report below it published.
        message:
          `the guard \`${g.guard}\` on transition \`${transitionLabel(g.transition)}\` could not be ` +
          `evaluated — ${names}. The walk did not decide whether it holds, so the unreachable and ` +
          `dead lists for this machine are withheld${
            m.deadlocksWithheld.length === 0
              ? ''
              : `, as is the no-way-out row for ${m.deadlocksWithheld.length} configuration(s) an undecided guard is an edge out of`
          }.`,
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
        hint:
          m.boundHit === 'depth'
            ? 'No flag raises the depth bound: read the run as what it is, a partial walk. A bound is printed on every figure precisely so it can never be read as exhaustion.'
            : 'Raise the bound (`--max-configs N`) and re-run, or read the run as what it is: a partial walk. A bound is printed on every figure precisely so it can never be read as exhaustion.',
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
    // After the deadlock rows — exemption 1 hands a single sink to them, so the
    // two never name one configuration — and before the choice rows, which the
    // simulator sentence below refers a reader to.
    for (const t of m.traps) {
      const members = t.states.map((s) => s.name).join(', ');
      findings.push({
        severity: 'warning',
        message:
          `trap — ${t.configs} configuration(s) form a set nothing leaves: {${members}}. ` +
          `Entered in ${t.steps} step(s) from \`${t.entry[0].name}\`.` +
          // §2.4(d): an increasing claim is about the MACHINE, and on a machine
          // with a choice point a reader who tries to reproduce the trap with
          // `simulate` may never see it. Said beside the row, not assumed.
          (m.nondeterminism.length > 0 ? ` ${SIMULATOR_SENTENCE}` : ''),
        elementId: t.states[0].id,
        elementName: t.states[0].qualifiedName,
        code: UNRECOVERABLE_MODE_CODE,
        hint: 'Give one state in the set a transition to a state outside it, or end the machine there with `done` if stopping is the intent. This is a reading of THIS machine over a walk whose relation is the one the model states — it says no run of this machine leaves the set, never anything about the system it models.',
      });
    }
    // After the traps, for the same reason they come where they do: the
    // choice rows below are what the livelock's own choice clause refers to.
    for (const l of m.livelocks) {
      findings.push(livelockFinding(m.machine, l, m.bounds));
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
      traps: machines.reduce((n, m) => n + m.traps.length, 0),
      livelocks: machines.reduce((n, m) => n + m.livelocks.length, 0),
    },
    diagnostics: findings.map((d, i) => ({
      id: `verification#${i}`,
      ruleId: 'verification',
      source: 'verification',
      ...d,
    })),
  };
}

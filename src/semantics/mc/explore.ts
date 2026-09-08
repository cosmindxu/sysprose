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
 * actually offered, and no unsupported construct was met. Otherwise they come
 * back EMPTY with `verification/bound-exhausted` on the report and the sentence
 * that says the lists are lower bounds and are not reported as findings.
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
  MAX_COMPLETION,
  enabledTransitions,
  hashConfig,
  initialConfig,
  isFinalState,
  isHistoryComposite,
  isHistoryPseudostate,
  isTruthy,
  leafOf,
  regionTransitions,
  seedStore,
  stepConfig,
  triggerLabelOf,
  type EnabledTransition,
  type MachineConfig,
  type StepInput,
} from './config';
import { SEMANTIC_PROFILE, type ProfileField } from './profile';

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

/** Every code this module can put in front of a reader, for the catalogue guard. */
export const BEHAVIOUR_CODES: ReadonlySet<string> = new Set([
  UNREACHABLE_STATE_CODE,
  DEAD_TRANSITION_CODE,
  DEADLOCK_CODE,
  NONDETERMINISTIC_CHOICE_CODE,
  BOUND_EXHAUSTED_CODE,
  BEHAVIOUR_UNSUPPORTED_CODE,
]);

/**
 * The four this engine raises as WARNINGS, and none of the six as an error.
 *
 * The reading rule, not an omission. An error in this lane is reserved for a
 * refuted obligation, and `reach` refutes nothing. But the four below are
 * findings about a MACHINE — a state nothing reaches, a transition nothing
 * fires, a state nothing leaves, a choice the notation does not resolve — and
 * filing them as info would put them beside "this construct is outside the
 * fragment", which is the tool talking about ITSELF. The remaining two do
 * exactly that, and they are info.
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
  /** Did the walk see the WHOLE configuration graph? */
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
 * The transitions the walk could ever offer — the census `dead` is read against.
 *
 * NOT every `TransitionUsage` in the machine. {@link enabledTransitions} offers
 * a transition only when its source is a state on the ACTIVE STACK, and the
 * stack holds `StateUsage`s: the cascade enters `initialSubstate`, which reads
 * `directStates`, which filters on that metaclass. So a transition leaving a
 * control node is structurally un-offerable, and counting it in the census
 * would put it in `dead` on every exhaustive walk — a finding invented by the
 * census rather than found by the walk, in a lane whose whole claim is that an
 * over-approximation can only SHRINK an absence claim.
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
  return regionTransitions(model, machineId).filter(
    (t) => model.get(t.source![0])?.eClass === 'StateUsage',
  );
}

/**
 * The constructs this engine refuses, checked BEFORE the walk.
 *
 * All three are §3.8's own list. `attrs.parallel` and `attrs.history` are
 * reachable only through the API — `sysml.langium` has no keyword for either —
 * so a machine using them was built by a program, and exploring it as though it
 * were an ordinary machine would report an interleaving this engine does not
 * perform and a history it does not resume. A transition missing an endpoint
 * cannot fire at all, and a walk that ignored it would count it dead on a
 * technicality rather than on a semantics.
 */
function unsupportedConstructs(model: Model, machineId: ElementId): UnsupportedConstruct[] {
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
  const dangling = model
    .descendants(machineId)
    .filter(
      (e) =>
        e.eClass === 'TransitionUsage' &&
        (e.source?.[0] === undefined || e.target?.[0] === undefined),
    );
  for (const tr of dangling) {
    out.push({
      construct: 'transition-without-endpoints',
      detail:
        'a transition names no source or no target, so no run can fire it and no walk can say ' +
        'whether it would have. Give it both endpoints.',
      elementId: tr.id,
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
  const unsupported = unsupportedConstructs(model, machineId);
  const reachable = new Set<ElementId>();
  const fired = new Set<ElementId>();
  const offered = new Set<string>();
  const nondeterminism: NondeterministicChoice[] = [];
  const deadlocks: DeadlockRow[] = [];

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
      const enabled = enabledTransitions(model, here.config, input);
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
      recordNondeterminism(
        model,
        here.config,
        input,
        enabled.filter((e) => e.level === innermost),
        nondetSeen,
        nondeterminism,
      );

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
  deadlocks: readonly DeadlockRow[];
  unsupported: readonly UnsupportedConstruct[];
  /** True when the two absence lists were withheld because a bound stopped the walk. */
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
 * The four conditions of §3.8 are computed here and nowhere else: exhaustive,
 * no completion budget spent, every named trigger offered, no unsupported
 * construct. All four, or the absence lists are empty.
 */
function reachOne(model: Model, machine: ElementRecord, opts: ExploreOptions): MachineReach {
  const walk = exploreMachine(model, machine.id, opts);
  // Third of §3.8's four conditions, and it is a DEFENSIVE one: `exploreMachine`
  // offers the whole alphabet at every configuration it dequeues, including the
  // opening one, so this holds by construction today and can only go false if
  // that changes — a walk that started filtering the inputs it offers would
  // silently narrow what "unreachable" means. Kept, and named, rather than
  // deleted: it costs one pass over a handful of strings and it is the only
  // thing standing between such a change and a shrunk claim printed as a full
  // one.
  const alphabetOffered = walk.bounds.alphabet.every((t) => walk.offered.has(t));
  const publishable =
    walk.exhaustive && alphabetOffered && walk.unsupported.length === 0;

  const states = machineStates(model, machine.id);
  const transitions = walkableTransitions(model, machine.id);
  const reachable = states.filter((s) => walk.reachable.has(s.id)).map((s) => stateRef(model, s.id));
  const unreachable = publishable
    ? states.filter((s) => !walk.reachable.has(s.id)).map((s) => stateRef(model, s.id))
    : [];
  const dead = publishable
    ? transitions.filter((t) => !walk.fired.has(t.id)).map((t) => transitionRef(model, t))
    : [];

  const qualification = publishable
    ? `exhaustive under ${boundsSentence(walk.bounds)}`
    : walk.unsupported.length > 0
      ? `not explored — ${walk.unsupported.map((u) => u.construct).join(', ')}; no figure below is a claim of absence`
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
    nondeterminism: walk.nondeterminism,
    deadlocks: walk.deadlocks,
    unsupported: walk.unsupported,
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

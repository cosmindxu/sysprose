/**
 * Time-stepped simulation of SysML v2 state machines.
 *
 * The `@semantics` layer already has a deterministic, run-to-completion state
 * machine interpreter ({@link runStateMachine}) that handles hierarchical,
 * orthogonal, history and `after(n)` timed machines. What it does NOT provide is
 * a STATEFUL, interactive stepper with a live clock, event injection and a
 * per-step time-series — which is what an actual simulation (and, later, an FMI
 * co-simulation master sharing one clock) needs.
 *
 * {@link SimulationSession} supplies exactly that, WITHOUT re-implementing state
 * machine semantics: it accumulates a driving script (named events + discrete
 * time advances) and, for each step, re-runs the tested interpreter over the
 * script-so-far, capturing an immutable {@link SimSample} (clock, active states,
 * value snapshot, transitions fired THIS step, live constraint status). Since
 * `runStateMachine` is deterministic and the script only grows by appending, each
 * region's fired subsequence only extends — but the interpreter concatenates the
 * regions' fired lists BY REGION, not chronologically, so the cumulative `fired`
 * is NOT positionally prefix-stable for orthogonal machines. The per-step delta is
 * therefore a MULTISET difference (by fire signature) of consecutive cumulative
 * lists, which is correct regardless of region grouping. This trades O(n²) re-runs
 * for correctness-by-delegation and zero semantic drift; traces are capped
 * (default 500 samples) to bound the cost.
 */

import { type ElementId, type Model } from '@core/index';
import { runStateMachine, type StateStep } from './execute';
import { evaluate, parseExpr } from './expr';
import { scopeFor } from './evaluate-model';
import { solve } from './solver';

/** A primitive simulation value (what a value snapshot / plot can carry). */
export type SimValue = number | boolean | string;

/** Live status of one constraint/requirement against the current sim values. */
export interface SimConstraintStatus {
  id: ElementId;
  name: string;
  expression: string;
  status: 'satisfied' | 'violated' | 'unknown';
}

/** A transition that fired during a single simulation step. */
export interface SimFire {
  id: ElementId;
  from: ElementId;
  to: ElementId;
  trigger: string;
}

/** An immutable snapshot of the machine at one point on the simulation timeline. */
export interface SimSample {
  /** 0-based sample index (0 = the initial sample before any driving step). */
  index: number;
  /** Cumulative discrete clock (sum of time advances so far). */
  clock: number;
  /** The event injected at this step (`null` for the initial sample / a pure advance). */
  event: string | null;
  /** Currently-active state ids (one leaf per concurrent region). */
  activeStates: ElementId[];
  /** Declared names of the active states (aligned with `activeStates`). */
  activeStateNames: string[];
  /** Snapshot of the value store (feature/variable name → primitive value). */
  values: Record<string, SimValue>;
  /** Transitions that fired DURING this step (delta since the previous sample). */
  fired: SimFire[];
  /** Live constraint/requirement status against this sample's values. */
  constraints: SimConstraintStatus[];
  /**
   * Parametric/derived values from solving the simulated context's constraint +
   * binding network with the machine's live values fixed (feature name → solved
   * number). Empty unless `solve` is enabled — Phase 3 parametrics in the loop.
   * Note: a feature carrying its own literal value is treated as an INPUT (held
   * at that value), not re-derived by a constraint.
   */
  solved: Record<string, number>;
  /** Whether the parametric solve converged this step (true when solve is off). */
  solvedOk: boolean;
  /** True when every concurrent region has reached a final/complete state. */
  complete: boolean;
}

/** One driving step: inject a named `event`, and/or `advance` the clock. */
export interface SimStep {
  event?: string;
  advance?: number;
}

/** A whole simulation run as a serialisable time-series. */
export interface SimTrace {
  behaviorId: ElementId;
  behaviorName: string;
  /** The injectable event alphabet discovered from the machine's transitions. */
  triggers: string[];
  samples: SimSample[];
  complete: boolean;
  /** Active states at the end of the run. */
  finalStates: ElementId[];
  /** True when the run hit the sample cap before the script finished. */
  truncated: boolean;
}

export interface SimOptions {
  /** Cap on trace length (default 500). */
  maxSamples?: number;
  /** Bound on automatic completion-transition chasing per step (default 64). */
  maxCompletion?: number;
  /** Initial value-store bindings (feature name → value), applied on every re-run. */
  initialStore?: Record<string, unknown>;
  /**
   * Solve the numeric parametric/constraint network each step, with the machine's
   * live values held constant, populating each sample's `solved` (Phase 3).
   */
  solve?: boolean;
}

const DEFAULT_MAX_SAMPLES = 500;

/**
 * A stateful, interactive simulator for one state machine. Drive it with
 * {@link inject}/{@link advance}/{@link step}; read {@link trace} for the
 * time-series or {@link toTrace} for a serialisable snapshot.
 */
export class SimulationSession {
  readonly behaviorId: ElementId;
  private readonly maxCompletion: number;
  private readonly maxSamples: number;
  private readonly initialStore?: Record<string, unknown>;
  private readonly withSolve: boolean;
  /** The parametric CONTEXT: the machine's owning part/system (else the machine). */
  private readonly contextId: ElementId;
  /** contextId + its descendant ids — the scope of the parametric solve + report. */
  private readonly contextIds: Set<ElementId>;
  /** Context feature name → its element id, for seeding the parametric solve. */
  private readonly nameToId: Map<string, ElementId>;
  private script: StateStep[] = [];
  private samples: SimSample[] = [];
  /** The previous sample's cumulative fired list (for a signature-based delta). */
  private prevFired: SimFire[] = [];

  constructor(
    private readonly model: Model,
    behaviorId: ElementId,
    opts: SimOptions = {},
  ) {
    this.behaviorId = behaviorId;
    this.maxCompletion = opts.maxCompletion ?? 64;
    this.maxSamples = Math.max(1, opts.maxSamples ?? DEFAULT_MAX_SAMPLES);
    this.initialStore = opts.initialStore;
    this.withSolve = opts.solve ?? false;
    // The parametric context is the machine's OWNING part/system (a nested state
    // machine mutates and is constrained through its owner's attributes); fall
    // back to the machine itself for a top-level machine.
    this.contextId = model.get(behaviorId)?.ownerId ?? behaviorId;
    this.contextIds = this.withSolve
      ? new Set([this.contextId, ...model.descendants(this.contextId).map((e) => e.id)])
      : new Set();
    this.nameToId = this.withSolve ? buildNameToId(model, this.contextId) : new Map();
    this.reset();
  }

  /** Clear the script and re-capture the initial sample. */
  reset(): SimSample {
    this.script = [];
    this.samples = [];
    this.prevFired = [];
    return this.capture(null);
  }

  /** Cumulative discrete clock. */
  get clock(): number {
    return sumAdvances(this.script);
  }

  /** The captured time-series so far (read-only). */
  get trace(): readonly SimSample[] {
    return this.samples;
  }

  /** The injectable event alphabet (named triggers, excluding timed `after(n)`). */
  get triggers(): string[] {
    return discoverTriggers(this.model, this.behaviorId);
  }

  /** Inject a named event, take one step, and return the new sample. */
  inject(event: string): SimSample {
    return this.step({ event });
  }

  /** Advance the clock by `dt` ticks, take one step, and return the new sample. */
  advance(dt = 1): SimSample {
    return this.step({ advance: dt });
  }

  /** Apply one driving step (event and/or time advance) and capture a sample. */
  step(s: SimStep): SimSample {
    // Enforce the sample cap uniformly (not only in run()): once reached, the
    // interactive drivers become no-ops returning the last captured sample.
    if (this.samples.length >= this.maxSamples) return this.samples[this.samples.length - 1];
    const event = s.event !== undefined && s.event !== '' ? s.event : null;
    if (event !== null) this.script.push(event);
    if (typeof s.advance === 'number' && s.advance > 0) this.script.push({ advance: s.advance });
    return this.capture(event);
  }

  /** Drive a whole script (batched), returning the serialisable trace. */
  run(script: SimStep[]): SimTrace {
    let truncated = false;
    for (const s of script) {
      if (this.samples.length >= this.maxSamples) {
        truncated = true;
        break;
      }
      this.step(s);
    }
    return this.toTrace(truncated);
  }

  /** A serialisable snapshot of the run so far. */
  toTrace(truncated = false): SimTrace {
    const last = this.samples[this.samples.length - 1];
    return {
      behaviorId: this.behaviorId,
      behaviorName: this.model.get(this.behaviorId)?.declaredName ?? '',
      triggers: this.triggers,
      samples: this.samples.slice(),
      complete: last?.complete ?? false,
      finalStates: last ? last.activeStates.slice() : [],
      truncated,
    };
  }

  /** Re-run the interpreter over the current script and capture a sample. */
  private capture(event: string | null): SimSample {
    const res = runStateMachine(this.model, this.behaviorId, this.script, {
      maxCompletion: this.maxCompletion,
      store: this.initialStore,
    });
    // runStateMachine drives each concurrent region through the WHOLE script
    // before the next, concatenating fired lists BY REGION — so the cumulative
    // `fired` is not positionally prefix-stable. Compute the per-step delta as a
    // multiset difference (by fire signature) against the previous cumulative.
    const cumulative: SimFire[] = res.fired.map((f) => ({
      id: f.transitionId,
      from: f.from,
      to: f.to,
      trigger: f.trigger,
    }));
    const fired = multisetDelta(this.prevFired, cumulative);
    this.prevFired = cumulative;

    const sample: SimSample = {
      index: this.samples.length,
      clock: sumAdvances(this.script),
      event,
      activeStates: res.activeStates.slice(),
      activeStateNames: res.activeStates.map((id) => this.model.get(id)?.declaredName ?? ''),
      values: snapshotValues(res.valueStore),
      fired,
      // The legacy flat/parallel path leaves `complete` undefined ("not tracked");
      // derive it from the active states rather than defaulting to false.
      complete: res.complete ?? allFinal(this.model, res.activeStates),
      // constraints filled in below (they overlay the parametric-solved values).
      constraints: [],
      solved: {},
      solvedOk: true,
    };
    if (this.withSolve) {
      const { solved, ok } = this.solveSample(res.valueStore);
      sample.solved = solved;
      sample.solvedOk = ok;
    }
    sample.constraints = checkConstraintsWithStore(
      this.model,
      this.behaviorId,
      res.valueStore,
      sample.solved,
    );
    this.samples.push(sample);
    return sample;
  }

  /**
   * Solve the model's numeric constraint + binding network with the machine's
   * CURRENT values held constant (overriding the static literals), returning the
   * determined feature values by name — the parametric/derived quantities for
   * this step (Phase 3). Library features are excluded; name collisions keep the
   * last determined value.
   */
  private solveSample(store: Map<string, unknown>): { solved: Record<string, number>; ok: boolean } {
    const fixed = new Map<ElementId, number>();
    for (const [name, v] of store) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const id = this.nameToId.get(name);
      if (id) fixed.set(id, v);
    }
    // Solve only the simulated CONTEXT's constraint network (scopeId), and report
    // only that context's features — so an unrelated part's same-named feature
    // can neither leak into `solved` nor collide with a real derived value.
    const result = solve(this.model, { fixed, scopeId: this.contextId });
    const out: Record<string, number> = {};
    for (const [id, val] of result.values) {
      if (!this.contextIds.has(id)) continue;
      const el = this.model.get(id);
      if (!el || el.attrs.isLibrary === true || !el.declaredName) continue;
      out[el.declaredName] = val;
    }
    return { solved: out, ok: result.converged };
  }
}

/**
 * Convenience: build a session and drive it with `script` in one call, returning
 * the serialisable time-series.
 */
export function simulateStateMachine(
  model: Model,
  behaviorId: ElementId,
  script: SimStep[] = [],
  opts: SimOptions = {},
): SimTrace {
  return new SimulationSession(model, behaviorId, opts).run(script);
}

/**
 * Is `id` a state machine that can be time-stepped (a StateUsage/StateDefinition
 * that contains at least one transition)?
 */
export function isSimulatable(model: Model, id: ElementId): boolean {
  const el = model.get(id);
  if (!el || (el.eClass !== 'StateUsage' && el.eClass !== 'StateDefinition')) return false;
  return model.descendants(id).some((e) => e.eClass === 'TransitionUsage');
}

/** The distinct named triggers of a machine's transitions (excludes timed `after`). */
export function discoverTriggers(model: Model, behaviorId: ElementId): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of model.descendants(behaviorId)) {
    if (e.eClass !== 'TransitionUsage') continue;
    const t = e.attrs.trigger;
    if (typeof t !== 'string' || t.trim() === '') continue;
    if (/^\s*after\s*\(/.test(t)) continue; // timed — driven by advance(), not injectable
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

/**
 * Map the behavior's feature declaredNames → element ids, so the parametric
 * solve can fix the machine's live (name-keyed) values by id. First name wins.
 */
function buildNameToId(model: Model, behaviorId: ElementId): Map<string, ElementId> {
  const map = new Map<string, ElementId>();
  const consider = (id: ElementId): void => {
    const el = model.get(id);
    if (el?.declaredName && !map.has(el.declaredName)) map.set(el.declaredName, id);
  };
  consider(behaviorId);
  for (const d of model.descendants(behaviorId)) consider(d.id);
  return map;
}

/** Sum the discrete time advances of a driving script. */
function sumAdvances(script: StateStep[]): number {
  let t = 0;
  for (const s of script) if (typeof s === 'object' && s !== null) t += s.advance;
  return t;
}

/** A stable signature for a fired transition (id + endpoints + trigger). */
function fireKey(f: SimFire): string {
  return `${f.id} ${f.from} ${f.to} ${f.trigger}`;
}

/**
 * The multiset difference `next − prev` (by fire signature): the fires present in
 * the new cumulative list beyond the previous one, in `next` order. Correct even
 * when the interpreter concatenates fired lists by region (so a new fire from an
 * earlier-processed region lands in the middle, not the tail).
 */
function multisetDelta(prev: SimFire[], next: SimFire[]): SimFire[] {
  const counts = new Map<string, number>();
  for (const f of prev) {
    const k = fireKey(f);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const delta: SimFire[] = [];
  for (const f of next) {
    const k = fireKey(f);
    const c = counts.get(k) ?? 0;
    if (c > 0) counts.set(k, c - 1); // matched an already-reported fire
    else delta.push(f);
  }
  return delta;
}

/** A final/complete state (mirrors execute.ts's own final-state predicate). */
function isFinalState(model: Model, stateId: ElementId): boolean {
  const s = model.get(stateId);
  if (!s) return false;
  return s.attrs.kind === 'final' || s.attrs.isFinal === true || s.declaredName === 'final';
}

/** True when there is ≥1 active state and every one is a final state. */
function allFinal(model: Model, states: ElementId[]): boolean {
  return states.length > 0 && states.every((id) => isFinalState(model, id));
}

/** Filter a value store down to plottable primitives. */
function snapshotValues(store: Map<string, unknown>): Record<string, SimValue> {
  const out: Record<string, SimValue> = {};
  for (const [k, v] of store) {
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Evaluate every constraint/requirement expression against the CURRENT simulation
 * value store (overlaying the static model scope), so constraint status reflects
 * the live run — not the model's declared literals.
 */
function checkConstraintsWithStore(
  model: Model,
  behaviorId: ElementId,
  store: Map<string, unknown>,
  solved: Record<string, number> = {},
): SimConstraintStatus[] {
  // Only the simulated behavior's OWN constraints (its subtree) see the live
  // store — a constraint elsewhere in the model must never be shadowed by this
  // machine's bare-name value store (which would corrupt a same-named feature).
  const inScope = new Set<ElementId>(model.descendants(behaviorId).map((e) => e.id));
  inScope.add(behaviorId);
  const out: SimConstraintStatus[] = [];
  for (const el of model.ofKind('ConstraintUsage', 'RequirementUsage')) {
    if (el.attrs.isLibrary === true) continue;
    if (!inScope.has(el.id)) continue;
    const expr = el.attrs.expression;
    if (typeof expr !== 'string' || expr.trim() === '') continue;
    const status = evalConstraint(model, el.id, el.ownerId, expr, store, solved);
    out.push({ id: el.id, name: el.declaredName ?? '', expression: expr, status });
  }
  return out;
}

function evalConstraint(
  model: Model,
  id: ElementId,
  ownerId: ElementId | null,
  expr: string,
  store: Map<string, unknown>,
  solved: Record<string, number>,
): SimConstraintStatus['status'] {
  let node;
  try {
    node = parseExpr(expr);
  } catch {
    return 'unknown';
  }
  const ownerScope = ownerId != null ? scopeFor(model, ownerId) : undefined;
  const selfScope = scopeFor(model, id);
  const scope = (name: string): unknown => {
    const fromOwner = ownerScope?.(name);
    const base = fromOwner !== undefined ? fromOwner : selfScope(name);
    // The live machine value overrides ONLY a name the constraint can already
    // resolve statically — this guard stops an unrelated same-named (bare) store
    // variable from leaking in.
    if (base !== undefined && store.has(name)) return store.get(name);
    // The parametric-SOLVED value is already scoped to the simulated context, so
    // it may legitimately supply a context feature that has no static literal
    // (e.g. a purely-derived `power`).
    if (Object.prototype.hasOwnProperty.call(solved, name)) return solved[name];
    return base;
  };
  const r = evaluate(node, scope);
  if ('unknown' in r) return 'unknown';
  if (r.value === true) return 'satisfied';
  if (r.value === false) return 'violated';
  return 'unknown';
}

/**
 * Run-to-completion confirmation: which of the walk's existential answers a run
 * the profile admits can actually reach.
 *
 * THE GAP, STATED ONCE. The profile says a fired transition is followed by
 * trigger-less (completion) transitions until none is enabled (`profile.ts`,
 * `run-to-completion`). The walk does not wait for that: at every configuration
 * it offers every trigger the machine names beside completion
 * (`exploreMachine`, `inputs`), including configurations where a completion
 * transition is enabled and the interpreter would have fired it first. That is
 * an OVER-approximation, and it is the right one for the universal answers —
 * `pass` of a safety pattern, `not-covered`, `vacuous`, `unreachable`, `dead`
 * only ever shrink under more runs, so a superset of runs keeps them sound.
 * The EXISTENTIAL answers run the other way. `fail`, `covered`, `no way out`,
 * `choice` and an undetermined guard each say "some run gets here", and a run
 * that takes a trigger step where a completion transition is enabled is not
 * one this profile admits. Measured: `cover state c` over `a_b` (completion)
 * beside `a accept e then c` reports `covered`, exit 0, while the interpreter —
 * over every event sequence of length six — only ever has `b` active.
 *
 * WHAT THIS MODULE DOES ABOUT IT, WITHOUT TOUCHING THE ENGINE OR THE CLI. It is
 * built only from the walk's own step functions (`./config`), so it cannot
 * read the step relation a second way:
 *
 *  - {@link witnessRtcGap} replays a `fail` or `covered` witness exactly and
 *    names the first trigger step taken while a completion transition was
 *    enabled or undetermined, or says the replay lost the step;
 *  - {@link confirmUnderRunToCompletion} walks the machine again, UNDER-
 *    approximately: it offers an event only where no completion transition is
 *    enabled or undetermined, and every other thing — the opening, the
 *    innermost-level rule, the three bounds — is the walk's. A deadlock, choice
 *    or undetermined-guard row it reaches is reached by a run the profile
 *    admits (modulo the tie-break among innermost completions, which the
 *    profile names as the semantics' own choice); a row it does not reach is
 *    unconfirmed;
 *  - {@link walkOnlyDiagnostics} projects the unconfirmed rows onto
 *    `reachReport`'s diagnostics, one flag each.
 *
 * AN UNCONFIRMED ROW IS NOT A REFUTED ROW. The terminal still prints it and the
 * engine still stands behind it as a statement about the walk; what this module
 * says is only that the run-to-completion walk did not reach it, so a surface
 * that counts findings must not count it. The CLI is unchanged.
 *
 * TWO CASES ARE CONSERVATIVE, AND SAY SO. This module never models the
 * interpreter accepting an event after a completion chase spends its budget,
 * and it withholds events while a completion guard is undetermined. A machine
 * with an always-enabled completion self-loop beside `a accept e then b` is
 * the first: the interpreter goes `a` -e-> `b`, `reach` reports `no way out b`,
 * and this module leaves that row unconfirmed. An undetermined completion guard
 * is the second: the interpreter proceeds, this module fails closed. Neither
 * counts a finding that is not there; both can leave a true one uncounted. So
 * "unconfirmed" means "the run-to-completion walk did not reach it", never
 * "run-to-completion forbids it".
 *
 * ITS LIFETIME. When the walk itself takes no event where a completion
 * transition is enabled or undetermined, the over-approximation this module
 * guards against is gone, and the module and every demotion that reads it are
 * deleted together (docs/06 §8.5).
 *
 * PURE. No DOM, no `node:`, no `src/api` import, no store.
 */

import type { ElementId, Model } from '@core/index';
import {
  hashConfig,
  initialConfig,
  leafOf,
  seedStore,
  stepCandidates,
  stepConfig,
  type MachineConfig,
  type StepInput,
} from './config';
import {
  BEHAVIOUR_UNSUPPORTED_CODE,
  BOUND_EXHAUSTED_CODE,
  DEAD_TRANSITION_CODE,
  DEADLOCK_CODE,
  GUARD_UNDETERMINED_CODE,
  NONDETERMINISTIC_CHOICE_CODE,
  UNREACHABLE_STATE_CODE,
  UNRECOVERABLE_MODE_CODE,
  transitionRef,
  type MachineReach,
  type ReachReport,
  type TransitionRef,
} from './explore';
import type { TraceStep } from './patterns';
import { rowKeyOf } from './report-lines';

/* ───────────────────────────── the confirmation ──────────────────────────── */

/** What the run-to-completion walk found of ONE machine's existential rows. */
export interface RtcConfirmation {
  readonly machineId: ElementId;
  /**
   * False when there was nothing to confirm: the machine names no trigger (the
   * walk then offers only completion, which IS run-to-completion) or it has no
   * deadlock, choice or undetermined-guard row. Nothing is unconfirmed then.
   */
  readonly ran: boolean;
  /**
   * Configurations this walk discovered. At most the walk's own on every model
   * measured, and exactly so unless the completion bound is hit: that bound counts
   * the run along the path a configuration was FIRST found by, and fewer edges
   * find them in another order.
   */
  readonly configs: number;
  /** A bound stopped this walk; the rows it had not reached by then are unconfirmed. */
  readonly boundHit: boolean;
  /**
   * The {@link rowKeyOf} of each deadlock, choice and undetermined-guard row of
   * this machine that this walk did not reach.
   */
  readonly unconfirmed: ReadonlySet<string>;
}

/** The keys of the machine's existential rows: the published ones, as `reach` prints them. */
function rowKeysOf(m: MachineReach): string[] {
  return [
    ...m.undeterminedGuards.map((g) => rowKeyOf('guard', g.transition.id)),
    ...m.deadlocks.map((d) => rowKeyOf('deadlock', d.leaf.id)),
    ...m.nondeterminism.map((n) => rowKeyOf('choice', n.state.id, n.event)),
  ];
}

const COMPLETION: StepInput = { kind: 'completion' };

/**
 * Walk the machine again, taking an event only where no completion transition
 * is enabled or undetermined, and say which of its rows that walk reached.
 *
 * SAME STEP RELATION, SAME BOUNDS, FEWER INPUTS. Everything but the offered
 * inputs is `exploreMachine`'s: the seeded opening, the innermost-level rule,
 * the order of the three gates, the machine's own printed bounds. So, while no
 * bound is hit, every configuration and edge taken here is one the walk takes.
 * Once a bound is hit that is not claimed: with fewer edges the configurations
 * are found in another order, so this walk may hold one the walk did not. The
 * soundness of a confirmed row does not rest on it. It rests on the run: a row
 * this walk reaches is reached by a run that never takes an event while a
 * completion transition is due.
 *
 * What is recorded is recorded at the OFFERED inputs only, the way the walk
 * records at all of them: a choice per level of two or more enabled transitions
 * (skipped over a withheld inner edge, as `exploreMachine` skips it), a
 * deadlock where nothing is enabled under any offered input, and a guard for
 * every transition undetermined under one.
 *
 * It never models the interpreter accepting an event after a chase spends its
 * completion budget, so it takes none there either: a row it confirms is
 * reached by a run the profile admits, and one it cannot confirm is not claimed.
 */
export function confirmUnderRunToCompletion(model: Model, m: MachineReach): RtcConfirmation {
  const machineId = m.machine.id;
  const keys = rowKeysOf(m);
  const { bounds } = m;
  if (bounds.alphabet.length === 0 || keys.length === 0) {
    return { machineId, ran: false, configs: 0, boundHit: false, unconfirmed: new Set() };
  }
  const triggers: StepInput[] = bounds.alphabet.map((trigger) => ({ kind: 'trigger', trigger }));

  const seeded = new Map<string, unknown>();
  const machineEl = model.get(machineId);
  if (machineEl) seedStore(model, machineEl, seeded);
  const opening = initialConfig(model, machineId, { store: seeded });
  interface Frontier {
    config: MachineConfig;
    depth: number;
    completionRun: number;
  }
  const seen = new Set<string>([hashConfig(opening.config)]);
  const queue: Frontier[] = [{ config: opening.config, depth: 0, completionRun: 0 }];
  const reached = new Set<string>();
  let boundHit = false;

  for (let head = 0; head < queue.length; head++) {
    const here = queue[head];
    const completion = stepCandidates(model, here.config, COMPLETION);
    // The one difference from the walk: an event is offered only where
    // run-to-completion would let it be taken.
    const inputs =
      completion.enabled.length > 0 || completion.undetermined.length > 0 ? [COMPLETION] : [COMPLETION, ...triggers];
    let anyEnabled = false;
    for (const input of inputs) {
      const { enabled, undetermined } = input === COMPLETION ? completion : stepCandidates(model, here.config, input);
      for (const u of undetermined) reached.add(rowKeyOf('guard', u.transition.id));
      if (enabled.length === 0) continue;
      anyEnabled = true;
      const innermost = enabled[0].level;
      // A choice is two or more transitions enabled at the innermost level, and
      // only where nothing strictly inside it was withheld (`exploreMachine`).
      if (!undetermined.some((u) => u.level > innermost) && enabled.filter((e) => e.level === innermost).length >= 2) {
        const event = input.kind === 'trigger' ? input.trigger : '';
        reached.add(rowKeyOf('choice', here.config.stack[innermost], event));
      }
      for (const choice of enabled) {
        if (choice.level !== innermost) continue;
        const next = stepConfig(model, here.config, choice);
        const key = hashConfig(next.config);
        if (seen.has(key)) continue;
        const run = input.kind === 'completion' ? here.completionRun + 1 : 0;
        // The walk's three gates, in its order and with its `>`.
        if (run > bounds.maxCompletion || here.depth + 1 > bounds.maxDepth || seen.size >= bounds.maxConfigs) {
          boundHit = true;
          continue;
        }
        seen.add(key);
        queue.push({ config: next.config, depth: here.depth + 1, completionRun: run });
      }
    }
    if (!anyEnabled) {
      const leaf = leafOf(here.config);
      if (leaf !== null) reached.add(rowKeyOf('deadlock', leaf));
    }
  }

  return {
    machineId,
    ran: true,
    configs: seen.size,
    boundHit,
    unconfirmed: new Set(keys.filter((k) => !reached.has(k))),
  };
}

/* ─────────────────────────── the diagnostics, flagged ────────────────────── */

/**
 * One flag per entry of `report.diagnostics`: true where the diagnostic is a
 * deadlock, choice or undetermined-guard row its machine's confirmation did not
 * reach. A machine with no confirmation in `cs` has no unconfirmed row.
 *
 * ALIGNED BY RECONSTRUCTION, AND CHECKED. `reachReport` emits per machine, in
 * this order: unsupported constructs, undetermined guards, the bound, the
 * unreachable states, the dead transitions, the deadlocks, the traps, the
 * choices. The flags are built in that order, and the code and element of each
 * are compared with the diagnostic at the same index. If the engine's order
 * moves the function throws rather than flag the wrong row: a finding
 * demoted by mistake, or one kept, is the one thing this module must not do.
 */
export function walkOnlyDiagnostics(r: ReachReport, cs: readonly RtcConfirmation[]): readonly boolean[] {
  const unconfirmedOf = new Map(cs.map((c) => [c.machineId, c.unconfirmed]));
  const none: ReadonlySet<string> = new Set();
  const flags: boolean[] = [];
  const emitted: Array<{ code: string; elementId: ElementId | undefined }> = [];
  for (const m of r.machines) {
    const unconfirmed = unconfirmedOf.get(m.machine.id) ?? none;
    const push = (code: string, elementId: ElementId | undefined, key: string | null): void => {
      emitted.push({ code, elementId });
      flags.push(key !== null && unconfirmed.has(key));
    };
    for (const u of m.unsupported) push(BEHAVIOUR_UNSUPPORTED_CODE, u.elementId, null);
    for (const g of m.undeterminedGuards) push(GUARD_UNDETERMINED_CODE, g.transition.id, rowKeyOf('guard', g.transition.id));
    if (m.boundHit !== 'none') push(BOUND_EXHAUSTED_CODE, m.machine.id, null);
    for (const s of m.states.unreachable) push(UNREACHABLE_STATE_CODE, s.id, null);
    for (const t of m.transitions.dead) push(DEAD_TRANSITION_CODE, t.id, null);
    for (const d of m.deadlocks) push(DEADLOCK_CODE, d.leaf.id, rowKeyOf('deadlock', d.leaf.id));
    for (const t of m.traps) push(UNRECOVERABLE_MODE_CODE, t.states[0].id, null);
    for (const n of m.nondeterminism) {
      push(NONDETERMINISTIC_CHOICE_CODE, n.state.id, rowKeyOf('choice', n.state.id, n.event));
    }
  }
  const aligned =
    emitted.length === r.diagnostics.length &&
    emitted.every((e, i) => e.code === r.diagnostics[i].code && (e.elementId || null) === (r.diagnostics[i].elementId || null));
  if (!aligned) {
    throw new Error("walkOnlyDiagnostics: the report's diagnostics are not in the order reachReport emits them");
  }
  return flags;
}

/* ─────────────────────────────── the witness replay ──────────────────────── */

/**
 * Where a witness leaves run-to-completion.
 *
 * `completion` is the trigger-less transition that was enabled (or undetermined)
 * when `step` took an event, so the interpreter would have fired it first; null
 * when the replay could not find the step at all (`lost`), which fails closed.
 */
export interface WitnessGap {
  /** The witness step (its `index`) that takes an event where a completion was due. */
  readonly step: number;
  readonly completion: TransitionRef | null;
  readonly lost: boolean;
}

/**
 * Replay a witness with the engine's own step functions and return the first
 * place it takes an event where a completion transition is enabled or
 * undetermined, or null when it takes none.
 *
 * The replay starts from the walk's opening and, for every step after the
 * opening, offers the step's own event (`''` is completion). A step with a
 * trigger is a gap if a completion transition is enabled in the replayed
 * configuration, or undetermined there — undetermined fails closed, because
 * nothing says the interpreter would not have fired it. The step's transition
 * is then looked up among the innermost-level candidates by id; a step the
 * replay cannot find is `lost`, never skipped. Guards are evaluated against the
 * replayed store, so a completion transition whose guard is false is no gap.
 */
export function witnessRtcGap(model: Model, machineId: ElementId, witness: readonly TraceStep[]): WitnessGap | null {
  const seeded = new Map<string, unknown>();
  const machineEl = model.get(machineId);
  if (machineEl) seedStore(model, machineEl, seeded);
  let config = initialConfig(model, machineId, { store: seeded }).config;
  for (let i = 1; i < witness.length; i++) {
    const step = witness[i];
    const input: StepInput = step.event === '' ? COMPLETION : { kind: 'trigger', trigger: step.event };
    if (input.kind === 'trigger') {
      const completion = stepCandidates(model, config, COMPLETION);
      const due = completion.enabled[0]?.transition ?? completion.undetermined[0]?.transition;
      if (due) return { step: step.index, completion: transitionRef(model, due), lost: false };
    }
    const { enabled } = stepCandidates(model, config, input);
    // Innermost level only, as the walk fires: a step that crosses the priority
    // rule is one no run of this semantics takes.
    const choice = enabled.find((e) => e.transition.id === step.transition?.id && e.level === enabled[0].level);
    if (!choice) return { step: step.index, completion: null, lost: true };
    config = stepConfig(model, config, choice).config;
  }
  return null;
}

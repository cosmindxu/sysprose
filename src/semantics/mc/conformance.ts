/**
 * Specialisation conformance (audit S5): does `state def X :> Y` preserve the traces of `Y`?
 *
 * SysML v2 Part 1 §7.6 (Specialization): a specialising definition inherits the features of its general and may
 * add its own, so a user of `Y` may expect an `X` to behave as a `Y` does. This reads that expectation off the two
 * machines' exhaustive walks and says what it found — never "refines", and never a claim about what `X` adds.
 *
 * THE CHECK. Every run of `Y` over the events `Y` names (the alphabet A) is a run `X` can follow: from the opening
 * configurations, each step of `Y` (an event of A, or a completion step) has a step of `X` under the same label that
 * stands in the same active states (compared by name: an inherited state keeps its name). It is trace inclusion by
 * the subset construction over `X`, so a failure comes with the shortest trace of `Y` that `X` cannot follow. The
 * events `X` adds are never offered (the walk is restricted to A: a step `X` takes on its own event is not a step of
 * `Y`), a rest of `Y` (no completion step due) is a rest of `X` too, and an event `Y` drops (no transition accepts it) is no step of `Y`, so `X` may take it up.
 *
 * WHAT STAYS UNSAID. Both walks must be exhaustive and whole: a cut walk, a guard nobody decided, a dwell offered
 * without a clock, a parallel state, a chase the budget stops or a construct the walk does not explore makes the row
 * `inconclusive` with the reason, never a pass. The comparison reads active states and event labels, not stores or
 * actions: a specialisation that changes only an effect is not detected, and the row's sentence says what it read.
 */
import type { ElementId, Model } from '@core/index';
import { machineRegion } from './config';
import { exploreMachine, type ExploreOptions, type ExploreResult } from './explore';

/** One step of the `Y` trace `X` cannot follow: the label offered and the active stack of `Y` after it. */
export interface ConformanceStep {
  /** The event offered, `''` for a completion step, `'-'` for the opening. */
  event: string;
  stack: readonly ElementId[];
  leaf: ElementId | null;
}

export type ConformanceOutcome =
  | { kind: 'none' }
  | { kind: 'pass'; general: ElementId; alphabet: readonly string[]; pairs: number; yConfigs: number; xConfigs: number }
  | { kind: 'fail'; general: ElementId; alphabet: readonly string[]; witness: readonly ConformanceStep[]; yWalk: ExploreResult; xWalk: ExploreResult }
  | { kind: 'inconclusive'; general: ElementId; alphabet: readonly string[]; reason: string; bound: boolean };

/** The most (Y configuration, X configuration set) pairs the search visits before it gives up. */
export const MAX_CONFORMANCE_PAIRS = 200_000;

const nameOf = (model: Model, id: ElementId): string => model.get(id)?.declaredName ?? id;

/** What a walk's configuration stands in, as names: equal for the same active states of two machines. */
function observation(model: Model, walk: ExploreResult, i: number): string {
  return walk.configStates[i].map((id) => nameOf(model, id)).join('/') + '|' + walk.configRegionLeaves[i].length;
}

/** Why a walk cannot stand as one side of the comparison, or `null`. */
function unfit(walk: ExploreResult): { reason: string; bound: boolean } | null {
  if (walk.unsupported.length > 0) {
    return { reason: `the walk does not explore it: ${walk.unsupported.map((u) => u.detail).join(' ')}`, bound: false };
  }
  if (!walk.exhaustive || walk.openFrontier) {
    return { reason: `its walk did not finish (${walk.boundHit === 'none' ? 'a bound was hit' : `bound hit: ${walk.boundHit}`})`, bound: true };
  }
  if (walk.undeterminedGuards.length > 0) {
    return { reason: `${walk.undeterminedGuards.length} guard(s) its walk could not evaluate left edges undecided`, bound: false };
  }
  if (walk.timedTransitions.size > 0) {
    return { reason: 'it carries a dwell its walk offers as an event without a clock', bound: false };
  }
  if (walk.chaseKeyed || walk.chaseStops > 0 || walk.budgetStops.length > 0) {
    return { reason: 'the interpreter’s chase budget can stop a chase in it, so its runs and the walk’s can part', bound: false };
  }
  if (walk.configRegionLeaves.some((l) => l.length > 1)) {
    return { reason: 'it holds a parallel state, whose regions this comparison does not follow', bound: false };
  }
  return null;
}

/**
 * Compare `machineId` with its nearest general machine. `none` when it has no general; otherwise a row that is one
 * of `pass`, `fail` (with the witness) and `inconclusive` (with the reason).
 */
export function checkConformance(model: Model, machineId: ElementId, opts: ExploreOptions = {}): ConformanceOutcome {
  const view = machineRegion(model, machineId);
  const general = view.bases[0];
  if (general === undefined) return { kind: 'none' };
  const stop = (reason: string, bound = false, alphabet: readonly string[] = []): ConformanceOutcome => ({
    kind: 'inconclusive',
    general,
    alphabet,
    reason: `no conformance claimed: ${reason}`,
    bound,
  });
  if (view.refused !== undefined) return stop(view.refused.sentence);
  if (machineRegion(model, general).refused !== undefined) return stop(machineRegion(model, general).refused!.sentence);
  const yw = exploreMachine(model, general, opts);
  const xw = exploreMachine(model, machineId, opts);
  const alphabet = yw.bounds.alphabet;
  for (const [who, w] of [
    ['the general machine', yw],
    ['the specialising machine', xw],
  ] as const) {
    const u = unfit(w);
    if (u !== null) return stop(`${who}: ${u.reason}`, u.bound, alphabet);
  }

  type Node = { y: number; xs: readonly number[]; parent: number; event: string };
  const nodes: Node[] = [{ y: 0, xs: [0], parent: -1, event: '-' }];
  const witnessOf = (at: number, extra?: { y: number; event: string }): ConformanceStep[] => {
    const chain: Array<{ y: number; event: string }> = [];
    for (let k = at; k >= 0; k = nodes[k].parent) chain.push({ y: nodes[k].y, event: nodes[k].event });
    chain.reverse();
    if (extra) chain.push(extra);
    return chain.map((c) => ({ event: c.event, stack: yw.configStates[c.y], leaf: yw.configLeaves[c.y] }));
  };
  if (observation(model, yw, 0) !== observation(model, xw, 0)) {
    return { kind: 'fail', general, alphabet, witness: witnessOf(0), yWalk: yw, xWalk: xw };
  }
  const visited = new Set<string>(['0|0']);
  for (let head = 0; head < nodes.length; head++) {
    if (nodes.length > MAX_CONFORMANCE_PAIRS) return stop(`the comparison visited more than ${MAX_CONFORMANCE_PAIRS} pairs`, true, alphabet);
    const { y, xs } = nodes[head];
    for (let k = 0; k < yw.successors[y].length; k++) {
      const ty = yw.successors[y][k];
      const label = yw.successorLabels[y][k];
      const want = observation(model, yw, ty);
      const next = new Set<number>();
      // Where the general comes to rest (no completion step is due), the specialising machine must too: a completion
      // it adds moves the run on where the general stays, which is a run of the general it cannot follow.
      const yRests = !yw.successorLabels[ty].includes('');
      const due = (x: number): boolean => xw.successorLabels[x].includes('');
      for (const x of xs) {
        for (let j = 0; j < xw.successors[x].length; j++) {
          if (xw.successorLabels[x][j] !== label) continue;
          const tx = xw.successors[x][j];
          if (observation(model, xw, tx) === want && !(yRests && due(tx))) next.add(tx);
        }
      }
      if (next.size === 0) {
        return { kind: 'fail', general, alphabet, witness: witnessOf(head, { y: ty, event: label }), yWalk: yw, xWalk: xw };
      }
      const sorted = [...next].sort((a, b) => a - b);
      const key = `${ty}|${sorted.join(',')}`;
      if (visited.has(key)) continue;
      visited.add(key);
      nodes.push({ y: ty, xs: sorted, parent: head, event: label });
    }
  }
  return { kind: 'pass', general, alphabet, pairs: nodes.length, yConfigs: yw.configs, xConfigs: xw.configs };
}

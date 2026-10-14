/**
 * What each check last said, and whether the model has moved since.
 *
 * Module-scoped, like the palette's armed tool: a check result is transient UI
 * state about the model, not part of it, and must never reach a saved project.
 * The model revision is recorded with the result, so a result from before an
 * edit is shown as `stale` rather than as a verdict on what is on screen now —
 * a check that no longer describes the model is worse than no check at all.
 * The part of the selection a check read (`selectionKey`) is recorded too, so
 * the palette never shows a result as current beside a command for another
 * element.
 *
 * A check running in a worker (`checks-runner.ts`) is recorded here as running
 * from the click until it settles, under a token the runner checks before it
 * lands a result: one that was cancelled, or whose run was replaced, finds its
 * token gone and is dropped. It runs in two phases: `load` while the worker
 * parses the model's text to know whether it loads, which the check is judged
 * over, then `walk` while the check itself runs. The `rev` and selection it ran
 * on are those of the click, not of the moment it lands, so an edit made
 * meanwhile shows it `stale`.
 *
 * `runs` moves when a check is STARTED, not when it lands: it brings the Checks
 * tab forward, and that belongs to the click. A tab that came forward when the
 * answer did would take the person out of whatever they went on to do while the
 * worker walked — the Text tab, with a cursor in it.
 */

import { create } from 'zustand';
import type { CheckResult, CheckVerdict } from '../checks';

export interface StoredResult {
  result: CheckResult;
  /** `useAppStore.rev` when it ran. */
  rev: number;
  /** `selectionKey` when it ran; absent for a check that does not read the selection. */
  selection?: string;
  /** Where it was worked out: a worker, or the page's own thread. */
  ranIn: RanIn;
  at: number;
}

export type RanIn = 'worker' | 'page';

/**
 * What a running check waits on: `load` — the model's text, parsed in the worker
 * to know whether it loads (the row reads `checking the load…`); `walk` — the
 * check itself (`running…`).
 */
export type RunPhase = 'load' | 'walk';

/** A check that has been started in a worker and has not settled. */
export interface RunningCheck {
  /** Identifies this run; a reply that does not carry the current one is dropped. */
  token: number;
  /** `useAppStore.rev` at the click. */
  rev: number;
  at: number;
  phase: RunPhase;
}

interface ChecksState {
  results: Record<string, StoredResult>;
  /** The checks running in a worker, by id. */
  running: Record<string, RunningCheck>;
  /** Increments on every run started, so the bottom panel can bring itself forward at the click. */
  runs: number;
  /** A run that was worked out on the page: it lands at once. */
  record(id: string, result: CheckResult, rev: number, selection?: string): void;
  /** A run started in a worker, in its first phase. */
  begin(id: string, token: number, rev: number, phase?: RunPhase): void;
  /** The load is known and the run `token` goes on to the check itself. */
  walking(id: string, token: number): void;
  /** A run ended with a result: it lands, and the check stops running. */
  land(id: string, result: CheckResult, rev: number, ranIn: RanIn, selection?: string): void;
  /** A run stopped without a result (cancelled): the check stops running, its last result stays. */
  stop(id: string): void;
  clear(): void;
}

/** `map` without `id`. */
function without<T>(map: Record<string, T>, id: string): Record<string, T> {
  const rest = { ...map };
  delete rest[id];
  return rest;
}

export const useChecksStore = create<ChecksState>((set) => ({
  results: {},
  running: {},
  runs: 0,
  record: (id, result, rev, selection) =>
    set((s) => ({
      results: { ...s.results, [id]: { result, rev, ...(selection !== undefined ? { selection } : {}), ranIn: 'page', at: Date.now() } },
      runs: s.runs + 1,
    })),
  begin: (id, token, rev, phase = 'walk') =>
    set((s) => ({ running: { ...s.running, [id]: { token, rev, at: Date.now(), phase } }, runs: s.runs + 1 })),
  walking: (id, token) =>
    set((s) => {
      const run = s.running[id];
      return run?.token === token ? { running: { ...s.running, [id]: { ...run, phase: 'walk' } } } : {};
    }),
  // `runs` is not moved here: it moved at the click, and the person may be elsewhere now.
  land: (id, result, rev, ranIn, selection) =>
    set((s) => ({
      results: { ...s.results, [id]: { result, rev, ...(selection !== undefined ? { selection } : {}), ranIn, at: Date.now() } },
      running: without(s.running, id),
    })),
  stop: (id) => set((s) => ({ running: without(s.running, id) })),
  // Results only: a run in a worker is not a result yet, and lands when it is.
  clear: () => set({ results: {}, runs: 0 }),
}));

/** The verdict a check shows while it runs, by what it waits on. */
export function runningVerdict(run: RunningCheck): CheckVerdict {
  return run.phase === 'load' ? 'checking' : 'running';
}

/**
 * The verdict to show: `stale` once the model has changed under it, or — when
 * `selection` is given — once the selection it read has moved. The palette
 * passes it: there a result sits beside the command for what is selected now.
 * The Checks tab does not: each of its results names what it covered, and a
 * click on one of its rows moves the selection.
 */
export function verdictOf(stored: StoredResult | undefined, rev: number, selection?: string): CheckVerdict {
  if (!stored) return 'not-run';
  if (stored.result.verdict === 'unavailable') return 'unavailable';
  if (stored.rev !== rev) return 'stale';
  if (selection !== undefined && stored.selection !== undefined && stored.selection !== selection) return 'stale';
  return stored.result.verdict;
}

/** How a verdict reads — text, never colour alone. */
export const VERDICT_LABEL: Record<CheckVerdict, string> = {
  'not-run': 'not run',
  checking: 'checking the load…',
  running: 'running…',
  holds: 'holds',
  issues: 'findings',
  undecided: 'undecided',
  unavailable: 'not here',
  stale: 'stale',
};

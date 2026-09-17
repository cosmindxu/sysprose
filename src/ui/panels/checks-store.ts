/**
 * What each check last said, and whether the model has moved since.
 *
 * Module-scoped, like the palette's armed tool: a check result is transient UI
 * state about the model, not part of it, and must never reach a saved project.
 * The model revision is recorded with the result, so a result from before an
 * edit is shown as `stale` rather than as a verdict on what is on screen now —
 * a check that no longer describes the model is worse than no check at all.
 */

import { create } from 'zustand';
import type { CheckResult, CheckVerdict } from '../checks';

export interface StoredResult {
  result: CheckResult;
  /** `useAppStore.rev` when it ran. */
  rev: number;
  at: number;
}

interface ChecksState {
  results: Record<string, StoredResult>;
  /** Increments on every run, so the bottom panel can bring itself forward. */
  runs: number;
  record(id: string, result: CheckResult, rev: number): void;
  clear(): void;
}

export const useChecksStore = create<ChecksState>((set) => ({
  results: {},
  runs: 0,
  record: (id, result, rev) =>
    set((s) => ({ results: { ...s.results, [id]: { result, rev, at: Date.now() } }, runs: s.runs + 1 })),
  clear: () => set({ results: {}, runs: 0 }),
}));

/** The verdict to show: `stale` once the model has changed under it. */
export function verdictOf(stored: StoredResult | undefined, rev: number): CheckVerdict {
  if (!stored) return 'not-run';
  if (stored.rev !== rev && stored.result.verdict !== 'unavailable') return 'stale';
  return stored.result.verdict;
}

/** How a verdict reads — text, never colour alone. */
export const VERDICT_LABEL: Record<CheckVerdict, string> = {
  'not-run': 'not run',
  running: 'running…',
  holds: 'holds',
  issues: 'findings',
  undecided: 'undecided',
  unavailable: 'not here',
  stale: 'stale',
};

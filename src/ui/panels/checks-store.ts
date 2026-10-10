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
 */

import { create } from 'zustand';
import type { CheckResult, CheckVerdict } from '../checks';

export interface StoredResult {
  result: CheckResult;
  /** `useAppStore.rev` when it ran. */
  rev: number;
  /** `selectionKey` when it ran; absent for a check that does not read the selection. */
  selection?: string;
  at: number;
}

interface ChecksState {
  results: Record<string, StoredResult>;
  /** Increments on every run, so the bottom panel can bring itself forward. */
  runs: number;
  record(id: string, result: CheckResult, rev: number, selection?: string): void;
  clear(): void;
}

export const useChecksStore = create<ChecksState>((set) => ({
  results: {},
  runs: 0,
  record: (id, result, rev, selection) =>
    set((s) => ({
      results: { ...s.results, [id]: { result, rev, ...(selection !== undefined ? { selection } : {}), at: Date.now() } },
      runs: s.runs + 1,
    })),
  clear: () => set({ results: {}, runs: 0 }),
}));

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
  running: 'running…',
  holds: 'holds',
  issues: 'findings',
  undecided: 'undecided',
  unavailable: 'not here',
  stale: 'stale',
};

/**
 * The timeout floor of a test that hands z3 a check, shared by the suites that
 * drive the solver outside `test/campaign/verification.test.ts` (which keeps
 * its own, richer record: it also names the bodies vitest stopped but that still
 * ran).
 *
 * The bridge presumes a module dead {@link DEAD_MODULE_MARGIN_MS} past a check's
 * budget (D5). A case or hook vitest stops sooner reads as a plain timeout and
 * leaves the death to a later case. The wrappers of `smt-z3.integration` and
 * `verification.differential` refuse a case timeout under the default floor when
 * it is declared, but they see neither a larger budget nor a hook. This helper
 * measures both: it notes each hook and case that handed z3 a check, with the
 * largest budget it handed (`z3BudgetWatch`) and the timeout it ran under, and
 * `shortOnes()` names those given less than {@link floorFor} that budget. A case that handed z3 a check without
 * being declared through the wrapper (a plain `it`, which vitest runs under its 5 s default) is named too
 * (`undeclared`): the record sees only what runs, so the guard that reads it needs the whole file to run.
 */
import { beforeAll as vitestBeforeAll, beforeEach } from 'vitest';
import {
  DEAD_MODULE_MARGIN_MS,
  DEFAULT_TIMEOUT_MS,
  z3BudgetWatch,
  z3CallCount,
} from '@semantics/smt/z3-bridge';

/** The least timeout a case that drives z3 may run under with the default budget: the death guard plus 5 s. */
export const SOLVER_CASE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS + DEAD_MODULE_MARGIN_MS + 5_000;

/** The least timeout for a case or hook that handed z3 a check of this budget (never below the default floor). */
export const floorFor = (budgetMs: number) => Math.max(SOLVER_CASE_TIMEOUT_MS, budgetMs + DEAD_MODULE_MARGIN_MS + 5_000);

/** Vitest's `hookTimeout` default, which a hook given no timeout runs under. */
export const HOOK_TIMEOUT_MS = 10_000;

interface Noted {
  name: string;
  timeout: number | undefined;
  /** The largest budget, in ms, a check the body handed z3 was given. */
  budget: number;
}

/** One record per test file: the hooks and cases noted so far, and the wrappers that note them. */
export function solverTimeoutFloor() {
  const hooks: Noted[] = [];
  const cases: Noted[] = [];
  const undeclared: string[] = [];
  // Every case of the file, whatever declared it: one that handed z3 a check and was not noted through `note` is named.
  beforeEach((ctx) => {
    const calls = z3CallCount();
    return () => {
      if (z3CallCount() !== calls && !cases.some((c) => c.name === ctx.task.name)) undeclared.push(ctx.task.name);
    };
  });

  /** Run a body, noting it when it handed z3 at least one check. */
  const noted = async <T>(into: Noted[], name: string, timeout: number | undefined, run: () => Promise<T> | T): Promise<T> => {
    const calls = z3CallCount();
    const stop = z3BudgetWatch();
    try {
      return await run();
    } finally {
      const budget = stop();
      if (z3CallCount() !== calls) into.push({ name, timeout, budget });
    }
  };

  return {
    /** `beforeAll`, noting the largest budget its body hands z3. */
    beforeAll(fn: Parameters<typeof vitestBeforeAll>[0], timeout?: number) {
      return vitestBeforeAll(async (suite) => noted(hooks, `a beforeAll in "${suite.name}"`, timeout, () => fn(suite)), timeout);
    },
    /** Run a case body (the wrapper that registers the case passes its own name and timeout), noting it. */
    note: <T>(name: string, timeout: number | undefined, run: () => Promise<T> | T) => noted(cases, name, timeout, run),
    /** The hooks and cases that handed z3 a check under a timeout below the floor for their budget. */
    shortOnes() {
      const line = (n: Noted, fallback: number | undefined) =>
        `${n.name} (${n.timeout ?? fallback ?? 'vitest’s 5 s default'} ms, needs ${floorFor(n.budget)} ms for a ${n.budget} ms budget)`;
      return {
        cases: cases.filter((c) => c.timeout === undefined || c.timeout < floorFor(c.budget)).map((c) => line(c, undefined)),
        hooks: hooks.filter((h) => (h.timeout ?? HOOK_TIMEOUT_MS) < floorFor(h.budget)).map((h) => line(h, HOOK_TIMEOUT_MS)),
        hookNames: hooks.map((h) => h.name),
        caseCount: cases.length,
        undeclared,
      };
    },
  };
}

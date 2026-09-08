/**
 * The semantic profile every behaviour report carries (plan §3.8).
 *
 * WHY A REPORT MUST NAME ITS PROFILE. `andre-2023` §2.6 makes the point this
 * module exists for: every published formalisation of state-machine semantics
 * differs on exactly these fields — when a completion transition fires, which
 * of two nested states wins, what history resumes, how regions interleave,
 * whether there is an event pool, what time is. A verdict about a machine is a
 * verdict UNDER a reading of those six, and a report that does not say which
 * reading it used is a verdict nobody can reproduce or contest.
 *
 * So the six fields are data rather than prose, each with the code that decides
 * it, and `reach` prints them beside every figure it publishes. The provenance
 * is a SYMBOL in `src/semantics/execute.ts` (or `./config.ts`, where the
 * relation now lives) rather than a line number, because line numbers rot in a
 * week and a symbol that stops existing is a symbol a test can catch — which is
 * what `test/unit/semantics.mc.reach.test.ts` does with it.
 *
 * This is a DESCRIPTION of what the interpreter does, never a specification of
 * what a state machine ought to do. Nothing here claims conformance with the
 * OMG's execution semantics, with PSSM, or with anybody else's reading.
 */

import { MAX_COMPLETION } from './config';

/** One field of the profile: what this tool does, and what decides it. */
export interface ProfileField {
  /** The field name a reader can compare against another tool's answer. */
  readonly field: string;
  /** What this tool actually does — one sentence, no hedging. */
  readonly reading: string;
  /** File and symbol that decides it, so the claim can be checked in the code. */
  readonly provenance: string;
}

/**
 * The six fields, in the order a reader needs them: what fires, which one wins,
 * what is remembered, how regions compose, what happens to an event nobody
 * wants, and what time is.
 */
export const SEMANTIC_PROFILE: readonly ProfileField[] = [
  {
    field: 'run-to-completion',
    reading:
      `a fired transition is followed by trigger-less (completion) transitions until none is ` +
      `enabled, bounded at ${MAX_COMPLETION} chase steps per driving step. The bound is a BUDGET, ` +
      `not a fixpoint: a chase that spends it stops mid-run and says so.`,
    provenance: 'src/semantics/execute.ts — chaseHierCompletion, RunStateOptions.maxCompletion',
  },
  {
    field: 'priority',
    reading:
      'innermost active substate first — the enabled transition leaving the deepest state on the ' +
      'active stack wins; within one state, declaration order. The explorer keeps the rule and ' +
      'branches only on the tie-break it does not decide: every transition enabled at that ' +
      'innermost level, never one an inner state beats.',
    provenance: 'src/semantics/mc/config.ts — enabledTransitions; src/semantics/mc/explore.ts — exploreMachine',
  },
  {
    field: 'history',
    reading:
      'shallow, and by parent map: leaving a composite state records its last-active child, and ' +
      're-entry resumes that child only where the composite is marked as a history state.',
    provenance: 'src/semantics/mc/config.ts — exitTo, isHistoryComposite',
  },
  {
    field: 'regions',
    reading:
      'the interpreter CONCATENATES: each region is driven through the whole step sequence in turn ' +
      'and the results are appended, so regions do not interleave. The explorer does not explore a ' +
      'parallel machine at all — `attrs.parallel` has no keyword in sysml.langium and is reachable ' +
      'only through the API — it reports verification/behaviour-unsupported-construct and is never ' +
      'exhaustive.',
    provenance: 'src/semantics/execute.ts — runHierMachine; src/semantics/mc/explore.ts — unsupportedConstructs',
  },
  {
    field: 'deferred events',
    reading:
      'none. There is no event pool: `triggerEquals` is an exact string match, and an event no ' +
      'enabled transition accepts is dropped at the step that offered it.',
    provenance: 'src/semantics/mc/config.ts — triggerEquals',
  },
  {
    field: 'time',
    reading:
      'discrete. `after(n)` is a dwell measured against an integer clock that only an explicit ' +
      'time step advances. The explorer advances no clock: it offers each `after(n)` label as a ' +
      'named event, which over-approximates time — a state reachable only after a dwell is treated ' +
      'as reachable, so the unreachable and dead lists stay lower bounds.',
    provenance: 'src/semantics/mc/config.ts — afterDuration, advanceClock',
  },
];

/** The profile as printable lines, longest field name padded. */
export function profileLines(indent = '  '): string[] {
  const width = Math.max(...SEMANTIC_PROFILE.map((f) => f.field.length));
  return SEMANTIC_PROFILE.map((f) => `${indent}${f.field.padEnd(width)}  ${f.reading}`);
}

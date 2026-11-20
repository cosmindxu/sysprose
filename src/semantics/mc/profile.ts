/**
 * The semantic profile every behaviour report carries (plan §3.8).
 *
 * WHY A REPORT MUST NAME ITS PROFILE. `andre-2023` §2.6 makes the point this
 * module exists for: every published formalisation of state-machine semantics
 * differs on exactly these fields — when a completion transition fires, which
 * of two nested states wins, what history resumes, how regions interleave,
 * whether there is an event pool, what time is. A verdict about a machine is a
 * verdict UNDER a reading of those, and a report that does not say which
 * reading it used is a verdict nobody can reproduce or contest. The seventh is
 * what a step exits and enters (`exits`): UML gives a transition three kinds
 * (internal, local, external) that read it three ways, this tool read it
 * another way until 2026-10-21 (`docs/06` §8.10), and that change moved
 * verdicts the other six fields did not show (`docs/06` §8.13).
 *
 * So the seven fields are data rather than prose, each with the code that decides
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
 * The seven fields, in the order a reader needs them: what fires, which one
 * wins, what a step leaves and enters, what is remembered, how regions compose,
 * what happens to an event nobody wants, and what time is.
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
    field: 'exits',
    reading:
      'to the least common ancestor of the source and the target, and every transition is external: ' +
      'the source and every active state below it are exited, then each state above the source that ' +
      'does not also hold the target, innermost first; the effect runs; then the states that hold the ' +
      'target and did not stay active are entered, outermost first, down to the target and its ' +
      'initial substate. So a step out of a composite leaves it, and a self-transition, a step to an ' +
      'ancestor, or a step from a composite into one of its own substates exits that state and enters ' +
      'it again. A step whose target sits in no chain ' +
      "of the machine's states — its own root, or a node under an action — has no such ancestor and " +
      'is taken by neither side: the explorer refuses the machine and the interpreter stops before ' +
      "the step. So is a step across the machine's boundary — into a nested `state def`, into " +
      'another machine, or out of one.',
    provenance: 'src/semantics/mc/config.ts — stepConfig, hierarchyPath, stepOutsideStates, stepAcrossBoundary',
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
      'a parallel STATE nested in an ordinary machine, and a parallel MACHINE ROOT (the machine itself marked ' +
      'parallel, whose child states are its regions), are performed concurrently (SysML v2 §7.18.2), by the ' +
      'interpreter and by the explorer alike: every region is entered at its own start, an event is offered to ' +
      'every region in declaration order, each region takes its own first-declared enabled transition (all of ' +
      'them are explored where several are enabled), a region with none stays, each region sees the store the ' +
      'previous one left, and leaving the parallel state exits every region. The order is FIXED, where the ' +
      'specification admits any interleaving, so the explorer refuses a parallel state whose regions are coupled ' +
      '(one writes an attribute another reads or writes) and does not give an exhaustive verdict over one order ' +
      'alone. A refusal in one region (a step the interpreter does not take) stops the whole run, as the regions are ' +
      'performed together, and a run is complete when every region stands at a final state. A parallel state is complete when every one of its regions stands at a final state of its own, and a trigger-less transition out of it (a parallel machine root: out of the machine, to one of its states) is then taken, after every region is exited, with its guard read at that moment; before then it is not taken. Also refused, with a ' +
      'reason: a parallel state in a parallel state or below a parallel machine root, a history state inside, a transition between ' +
      'regions, a step into a region, an entry action naming ' +
      'a start, an event taken both by a region and by a transition leaving the parallel state, and a timed ' +
      'transition in a region — all verification/behaviour-unsupported-construct, never exhaustive.',
    provenance:
      'src/semantics/execute.ts — runHierRegion, runHierMachine, nestedParallelRefusal; src/semantics/mc/parallel.ts — parallelRefusal, candidatesOf, advanceConfig',
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

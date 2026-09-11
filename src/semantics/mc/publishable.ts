/**
 * May this absence be stated? — one predicate for the decreasing side, one gate
 * for the increasing one, and the two registers of what this lane claims
 * (plan `docs/06-model-checking-implementation-plan.md` §2.3).
 *
 * WHY THIS FILE EXISTS. The rule that governs every absence claim used to live
 * twice: a local `const publishable` in `reachOne` (`./explore`) and a local
 * `const exhaustive` in `checkProperty` (`./patterns`), each carrying a comment
 * saying the other must not be deleted alone. They DID drift apart for exactly
 * one commit — `reach` withholding its lists over an undetermined guard while
 * `check-behaviour` printed `pass` over the same machine — and the repair was to
 * read the same fields off the same walk. Two readers were survivable; the
 * verification lane adds five more, so the conjunction is lifted here and both
 * shipped readers now call it. Nothing PUBLISHED reads the increasing side yet:
 * its gate is wired into a report in a later commit. Its two remaining
 * producers — `timedTransitions` and `timedLabels` — arrived with the commit
 * that retains the successor relation, so `ExploreResult` satisfies
 * {@link ExactnessWalk} structurally and `walkIsExact` is called on a real walk
 * in this tree's tests. That the gate itself still prints nothing is deliberate:
 * a refactor whose gate is *"not one published sentence moved"* only proves
 * something while nothing new consumes it.
 *
 * WHY THERE ARE TWO CONJUNCTIONS AND NOT ONE. Publishability is not one
 * property, and a single `ok` would have shipped a regression on behaviour that
 * already works. The claims `reach` and `check-behaviour` publish today —
 * a state nobody enters, a transition nobody fires, a `pass`, a `vacuous` — are
 * monotone-DECREASING in the edge relation: add an edge and each of those lists
 * can only shrink, so an engine that offers MORE edges than the machine grants
 * cannot invent one of them. They read {@link Publishability.decreasingOk},
 * which is their shipped conjunction and nothing more.
 *
 * The claims the lane is about to add run the other way. *"Nothing this walk
 * found is inescapable"*, *"every reachable configuration can get back to
 * `standby`"*, *"no fair cycle"* — each of those gets EASIER to state as edges
 * are added, so the same over-approximation that keeps the first set honest
 * falsifies the second. Those read {@link Exactness.walkIsExact}, which asks a
 * different question: is the relation this walk retained the relation the
 * machine states? Wiring an increasing claim to `decreasingOk`, or a witness to
 * a bound, is what {@link ABSENCE_CLAIMS} and {@link WITNESS_CLAIMS} turn from a
 * review comment into a red test.
 *
 * WHAT THE GATE DOES NOT COVER, AND WHERE THAT HALF IS ANSWERED. `walkIsExact`
 * asks *every edge the machine has was retained, and every edge retained is one
 * the machine has*. The second direction is answered OFF THE MODEL by
 * `edgeCensus` (`./explore`): an edge-bearing element nobody accounted for lands
 * in the census's `unaccounted` bucket, which refuses the machine outright — so
 * {@link Exactness.seenWhole} is already false and no absence is published over
 * it. That is why this file carries no clause for it, and why a sixth edge kind
 * costs no register row: the census catches it without having been told what to
 * look for. The three clauses below are the other direction, and they are all of
 * one kind — an edge that IS in the relation but whose AVAILABILITY at a
 * configuration the walk gets wrong.
 */

import type { ElementId } from '@core/index';
import type { BoundHit } from './explore';

/* ══════════════════════ the decreasing side ══════════════════════ */

/**
 * What {@link publishabilityOf} reads out of a walk.
 *
 * Structural rather than `ExploreResult`, for one reason: this predicate is
 * also handed the product-search result in `checkProperty`, and a test that
 * wants to exercise one clause should not have to fabricate thirteen fields.
 * Every `ExploreResult` satisfies it.
 */
export interface PublishabilityWalk {
  readonly exhaustive: boolean;
  readonly bounds: { readonly alphabet: readonly string[] };
  /** The events actually offered — a bound can stop the walk before some are. */
  readonly offered: ReadonlySet<string>;
  readonly unsupported: readonly unknown[];
  readonly undeterminedGuards: readonly unknown[];
}

/**
 * The five conditions a monotone-DECREASING absence claim is published under.
 *
 * There is deliberately no bare `ok`. A single boolean cannot express a
 * per-claim requirement, and the one that was drafted would have flipped
 * `publishable` false on any machine carrying a dwell transition — emptying a
 * sound `verification/unreachable-state` finding out of a shipped command and
 * printing *"a trigger the machine names was never offered"* on a walk that
 * offered every one of them.
 */
export interface Publishability {
  /** `walk.exhaustive` — the walk finished inside every bound. */
  readonly exhaustive: boolean;
  /**
   * Every named trigger was actually offered.
   *
   * DEFENSIVE, and both shipped readers keep it for the same reason:
   * `exploreMachine` offers the whole alphabet at every configuration it
   * dequeues, so this holds by construction today and can only go false if that
   * changes. A walk that started filtering the inputs it offers would silently
   * narrow what "unreachable" means.
   */
  readonly alphabetOffered: boolean;
  /** `walk.unsupported.length === 0` — no construct this engine refuses. */
  readonly supported: boolean;
  /**
   * `walk.undeterminedGuards.length === 0` — no transition guard was consulted
   * and left undecided.
   *
   * TRANSCRIBED AS THAT EXPRESSION AND NOTHING ELSE. *"No declared value for a
   * feature the guard reads"* is STRICTLY NARROWER: `'undetermined'` also covers
   * a non-boolean operand under `not`/`and`/`or`, a mixed-type comparison and
   * non-finite arithmetic, so `not mode` over a fully valued `mode` is
   * undetermined while `mode` itself is decided. A narrower copy would regress a
   * withholding that already ships, on a walk no model in this tree can yet
   * exhibit: `test/fixtures/verification/models/guard-undetermined.sysml`
   * (`c929278`) is the ONE corpus model carrying guards, and its undecided row
   * has a non-empty `unresolved`, so both readings agree on it. The model that
   * separates them — `not mode` over a fully valued `mode` — arrives with
   * commit 2's `trapguard-typed.sysml`; until then the only thing that tells the
   * two apart is the synthetic row in this module's own test.
   */
  readonly guardsDetermined: boolean;
  /**
   * `found.boundHit === 'none'`. PRODUCT SEARCH ONLY.
   *
   * On a walk-only claim no search ran, there is no `found`, and this field is
   * ABSENT — never `false`, which would print "bound exhausted" about a bound
   * nobody hit.
   */
  readonly searchComplete?: boolean;
  /**
   * The conjunction over the fields present. What a monotone-decreasing claim
   * asks for, and the only thing the claims that ship today read.
   */
  readonly decreasingOk: boolean;
  /**
   * Why publication is or is not allowed, in one line.
   *
   * UNREAD TODAY, AND NOT A TRANSCRIPTION OF ANY SHIPPED ROW. `reachOne` still
   * composes its own `qualification` from `boundsSentence`/`boundSentence`, and
   * its four branches do not share one template — the `exhaustive` branch
   * carries no reason tail at all and the unsupported branch carries no
   * `under <bounds>` — so a reader must not build a row out of this field
   * expecting it to reproduce one. It is the REASON half only, and it is
   * deliberately not wired here: the commit that wires it is the one that
   * collapses the two byte-identical copies of `boundsSentence`, and until then
   * a wiring would move a published sentence, which this commit may not do.
   */
  readonly sentence: string;
}

/** The decreasing conjunction, in one place, for every reader of it. */
export function publishabilityOf(
  walk: PublishabilityWalk,
  /**
   * The product search, when there was one. `checkProperty` passes its `found`;
   * a walk-only claim passes nothing and gets no `searchComplete` field.
   */
  search?: { readonly boundHit: BoundHit },
): Publishability {
  const exhaustive = walk.exhaustive;
  const alphabetOffered = walk.bounds.alphabet.every((t) => walk.offered.has(t));
  const supported = walk.unsupported.length === 0;
  const guardsDetermined = walk.undeterminedGuards.length === 0;
  const searchComplete = search === undefined ? undefined : search.boundHit === 'none';
  const decreasingOk =
    exhaustive && alphabetOffered && supported && guardsDetermined && (searchComplete ?? true);

  // The branch ORDER is the shipped one, read off `reachOne`'s qualification:
  // an unsupported construct outranks an undecided guard, which outranks a
  // bound, and the alphabet is only ever named when no bound was hit — a reader
  // shown "a trigger was never offered" after a bound would raise the wrong
  // thing.
  const sentence = !supported
    ? 'a construct this engine does not explore was found, so no figure below is a claim of absence'
    : !guardsDetermined
      ? 'a guard the walk consulted decided nothing, so an edge the model states may be missing'
      : !exhaustive
        ? 'the walk did not finish, so an absence list would be a lower bound'
        : searchComplete === false
          ? 'the product search did not finish, so no bad prefix having been found is not the absence of one'
          : !alphabetOffered
            ? 'a trigger the machine names was never offered'
            : 'the walk saw the whole configuration graph its own step relation admits';

  return {
    exhaustive,
    alphabetOffered,
    supported,
    guardsDetermined,
    ...(searchComplete === undefined ? {} : { searchComplete }),
    decreasingOk,
    sentence,
  };
}

/* ══════════════════════ the increasing side ══════════════════════ */

/**
 * Which clause of {@link Exactness} failed, for the `inconclusive` sentence.
 *
 * Exactly one is reported, in the order {@link walkIsExact} evaluates them, so
 * two machines that fail for two reasons never print the same sentence.
 */
export type FailedClause = 'bound' | 'unsupported' | 'environment' | 'time' | 'store' | null;

/**
 * What {@link walkIsExact} reads out of a walk.
 *
 * EVERY `ExploreResult` SATISFIES THIS. `timedTransitions` and `timedLabels`
 * ship with the commit that retains the successor relation, so
 * `walkIsExact(walk, walk.bounds)` on a real walk is a call this tree makes.
 * The argument stays STRUCTURAL for the same reason
 * {@link PublishabilityWalk}'s does: `checkProperty` (`./patterns`) hands the
 * predicate the PRODUCT-SEARCH result, which is not an `ExploreResult`, and a
 * test exercising one clause should not have to fabricate every other field.
 */
export interface ExactnessWalk extends PublishabilityWalk {
  readonly boundHit: BoundHit;
  /**
   * Every walkable transition of this machine for which `afterDuration` is
   * defined — a numeric `attrs.after` OR an `after(n)` trigger string.
   *
   * THE TRANSITION SET, NOT AN ALPHABET SUBSET, and the difference is the whole
   * of clause (b): a transition carrying only `attrs.after` is a completion
   * transition, contributes no label at all, and a clause scoped to alphabet
   * contributors reads empty on a machine every edge of which is a dwell.
   */
  readonly timedTransitions: ReadonlySet<ElementId>;
  /**
   * The dwell labels that reached the alphabet. GATES NOTHING. Its only reader
   * is the `alphabet ∖ timedLabels` subtraction that decides whether a non-empty
   * alphabet is real triggers or all dwells — so its producer must range over
   * the SAME relation the alphabet does (`regionTransitions`), which is a WIDER
   * one than {@link ExactnessWalk.timedTransitions}'. A producer scoped to the
   * narrower set leaves an off-stack dwell's label in the difference, and
   * {@link walkIsExact} then names the environment clause on a machine whose
   * every trigger is a dwell.
   */
  readonly timedLabels: ReadonlySet<string>;
}

/**
 * THE GATE FOR THE WHOLE INCREASING SIDE. One predicate, two named halves.
 *
 * Read {@link Exactness.walkIsExact} from an increasing absence claim; read
 * {@link Exactness.relationIsTheMachines} from an EXISTENTIAL witness — a bound
 * can hide such a witness and can never invent one; read `walkIsExact` again
 * from a MAXIMALITY witness (*this cycle has no exit*, *this run has no
 * successor*), which a bound and an undecided guard both manufacture. Nothing on
 * the increasing side reads anything else from this family, and the register's
 * `kind` column is what selects between the two readings.
 */
export interface Exactness {
  /**
   * The walk saw the graph whole: `exhaustive` ∧ `boundHit === 'none'` ∧ nothing
   * unsupported.
   *
   * Both conjuncts of the first are stated because neither implies the other:
   * the unsupported early return sets `exhaustive: false` with
   * `boundHit: 'none'`, and a bound sets `boundHit` before it continues. The
   * `unsupported` conjunct is also where the ELEMENT-SET half of exactness is
   * enforced — an `unaccounted` census row refuses the machine, so a missing
   * edge KIND falsifies this field without a clause of its own.
   */
  readonly seenWhole: boolean;
  /**
   * THE PROPERTY: every edge the machine has was retained, and every edge
   * retained is one the machine has. The three clauses below are how the second
   * direction is checked — not what it means — and they are all of one kind, an
   * edge that IS in the relation but whose availability at a configuration the
   * walk gets wrong:
   *
   *  • (b) no dwell — `timedTransitions` is empty. The walk offers the edge at
   *    every configuration and advances no clock, so a run that takes it is a
   *    run of no environment.
   *  • (c) no named trigger — `bounds.alphabet` is empty. This engine has no
   *    carrier for *which triggers can the environment actually supply*, so the
   *    only alphabet it can be exact over is the empty one.
   *  • (d) no undecided guard — `undeterminedGuards` is empty, read as the
   *    shipped predicate and not as a narrower "no declared value".
   */
  readonly relationIsTheMachines: boolean;
  /** Both halves. The name every register cell and verdict row reads. */
  readonly walkIsExact: boolean;
  /** Which clause failed. `null` exactly when {@link walkIsExact} holds. */
  readonly failedClause: FailedClause;
  /** The one-line reason, printed beside every claim this gate withholds. */
  readonly sentence: string;
}

/** What each failed clause says to a reader, once, so no two spell it alike. */
const CLAUSE_SENTENCE: Record<Exclude<FailedClause, null>, string> = {
  bound: 'the walk stopped at a bound, so an edge it never followed is missing from the relation',
  unsupported:
    'the walk did not run: a construct this engine does not explore was found, and an unexplored graph holds nothing',
  environment:
    'the walk offers every trigger the machine names at every configuration, and nothing here establishes that an environment would supply them',
  time: 'the walk offers every dwell transition at every configuration and advances no clock, so it holds an edge the interpreter would never take',
  store:
    'a guard the walk consulted decided nothing, so an edge the model states is absent from the relation',
};

/**
 * The residue's own sentence, because `'bound'` must not tell a lie.
 *
 * The residue is reported as `'bound'` — the union is five values and the plan
 * pins it there — but it is reached with `boundHit === 'none'`, and
 * `CLAUSE_SENTENCE.bound` would then say *"the walk stopped at a bound"* about a
 * walk that named none, sending a reader to `--max-configs` for a defect that is
 * not there. The clause NAME stays; the prose says what actually happened.
 */
const RESIDUAL_SENTENCE =
  'the walk did not finish and named no bound, so an edge it never followed may be missing from the relation';

/** The whole-graph sentence, for the one case where nothing failed. */
const EXACT_SENTENCE =
  'the walk saw the whole graph, and the relation it retained is the one this machine states';

/**
 * The first clause that failed, in the order {@link walkIsExact} states.
 *
 * Written as a table rather than a chain of ternaries so the ORDER is the
 * thing a reader checks: two machines that fail for two reasons must never
 * print the same sentence, and 'environment' before 'time' is the order the
 * modality's own row-precedence rule reads.
 */
function firstFailedClause(failed: {
  bound: boolean;
  unsupported: boolean;
  environment: boolean;
  time: boolean;
  store: boolean;
  residual: boolean;
}): FailedClause {
  if (failed.bound) return 'bound';
  if (failed.unsupported) return 'unsupported';
  if (failed.environment) return 'environment';
  if (failed.time) return 'time';
  if (failed.store) return 'store';
  if (failed.residual) return 'bound';
  return null;
}

/**
 * Is the relation this walk retained the relation the machine states?
 *
 * `bounds` is passed separately rather than read off `walk.bounds` because
 * `checkProperty` runs the walk under one bounds record and the product search
 * under another, and clause (c) is about the alphabet the CLAIM was made under.
 */
export function walkIsExact(
  walk: ExactnessWalk,
  bounds: { readonly alphabet: readonly string[] },
): Exactness {
  const seenWhole = walk.exhaustive && walk.boundHit === 'none' && walk.unsupported.length === 0;
  const noDwell = walk.timedTransitions.size === 0;
  const noTrigger = bounds.alphabet.length === 0;
  const guardsDetermined = walk.undeterminedGuards.length === 0;
  const relationIsTheMachines = noDwell && noTrigger && guardsDetermined;

  // THE ORDER IS LOAD-BEARING. `'environment'` comes FIRST of the three
  // relation clauses: an author whose machine names `abort` has something to do
  // about it, and the dwell sentence would send them to the wrong carrier. A
  // named trigger is one the alphabet holds and `timedLabels` does not — a
  // machine whose whole alphabet is `after(n)` spellings fails on time, not on
  // its environment.
  const namedTrigger = bounds.alphabet.some((t) => !walk.timedLabels.has(t));
  const failedClause: FailedClause = firstFailedClause({
    bound: !walk.exhaustive && walk.boundHit !== 'none',
    unsupported: walk.unsupported.length > 0,
    environment: namedTrigger,
    time: !noDwell || !noTrigger,
    store: !guardsDetermined,
    // The residue, named so this field can never read `null` while the gate
    // reads false: `seenWhole` fails with no bound named and no unsupported row
    // only if `exhaustive` and `boundHit` disagree. Today's `exploreMachine`
    // sets them together, and the day it does not, a walk that stopped short is
    // reported as one rather than as nothing.
    residual: !seenWhole,
  });

  return {
    seenWhole,
    relationIsTheMachines,
    walkIsExact: seenWhole && relationIsTheMachines,
    failedClause,
    sentence:
      failedClause === null
        ? EXACT_SENTENCE
        : failedClause === 'bound' && walk.boundHit === 'none'
          ? RESIDUAL_SENTENCE
          : CLAUSE_SENTENCE[failedClause],
  };
}

/* ══════════════════════ the two registers ══════════════════════ */

/** `A0`…`A15` for an absence row, `W1`…`W6` for a witness one. */
export type ClaimId = string;

/**
 * Which way the claim moves as edges are added to the relation.
 *
 * A closed enumeration wide enough for its own data. `mixed` is a row whose two
 * halves disagree — A0, decreasing in the over-approximating mechanisms and
 * increasing in the undecided-guard one; A8 and A10, decreasing in edges but
 * quantifying over the RUN set, which the cooperative environment changes; A13,
 * whose `no cut set` half and whose published cut sets run in opposite
 * directions. `not-a-walk` is a claim that is not about a configuration graph.
 */
export type Polarity = 'decreasing' | 'increasing' | 'mixed' | 'not-a-walk';

/**
 * What the producer reads out of this family, and it is one of exactly four
 * values.
 *
 * A per-mechanism conjunction here is a red test: the whole point of collapsing
 * five clause-sets into one gate is that the increasing side has ONE gate and no
 * menu. Everything that is not a member of this family goes in `alsoRequires`.
 */
export type WalkRequires = 'decreasingOk' | 'walkIsExact' | 'relationIsTheMachines' | null;

/** Where a claim is composed, when it is composed anywhere yet. */
export interface ProducerRef {
  /** Repository-relative path. */
  readonly file: string;
  /** A symbol declared in that file. */
  readonly symbol: string;
}

/** One row of {@link ABSENCE_CLAIMS}. */
export interface AbsenceClaim {
  readonly id: ClaimId;
  /** The sentence a reader would quote back at us. */
  readonly claim: string;
  /** The feature that publishes it. */
  readonly feature: string;
  readonly polarity: Polarity;
  /** The mechanism the polarity flips in. Free-form, and never empty. */
  readonly polarityNote: string;
  readonly walkRequires: WalkRequires;
  /**
   * Conjuncts that are NOT members of the walk-predicate family: acyclicity, a
   * fair continuation, solver digests, a non-empty dependency template.
   *
   * NO ENTRY HERE MAY NAME A MEMBER OF THE BOUND FAMILY — `seenWhole`,
   * `decreasingOk`, `searchComplete`. That is where a bound condition would
   * otherwise creep back onto a witness one conjunct at a time.
   */
  readonly alsoRequires: readonly string[];
  /** What is published instead when the gate does not hold. */
  readonly otherwise: string;
  /** `null` while the feature that composes the claim is not built. */
  readonly producedBy: ProducerRef | null;
}

/** One row of {@link WITNESS_CLAIMS}. */
export interface WitnessClaim extends AbsenceClaim {
  /**
   * An EXISTENTIAL witness says *this run exists*: a bound can hide it and can
   * never invent it, so the row reads `relationIsTheMachines` and names no
   * bound. A MAXIMALITY witness says *this cycle has no exit* or *this run has
   * no successor* — an absence wearing a witness's clothes, falsified by a
   * MISSING edge, which a bound and an undecided guard both produce — so it
   * reads the whole gate.
   */
  readonly kind: 'existential' | 'maximality';
  /**
   * May a per-step check stand in for {@link walkRequires}?
   *
   * The per-step alternative: no step of the witness was taken across a dwell
   * transition and no step crossed a transition in `undeterminedGuards`. It is a
   * per-TRACE check over the edges the trace used, not a walk-level one, and the
   * dwell half is tested as `afterDuration(step.transition) !== undefined` on
   * the step's transition id — never against the recorded label, which a
   * numeric-`attrs.after` step leaves empty.
   */
  readonly perStepAlternative: boolean;
  /**
   * The absence row this witness prints inside, or `null` when it stands alone.
   *
   * A rider prints only where its host publishes, so its effective gate is the
   * host's conjoined with its own; the column exists so a rider cannot name a
   * gate weaker than the family its host is in and have that pass unremarked.
   */
  readonly ridesOn: ClaimId | null;
}

const REACH_ONE: ProducerRef = { file: 'src/semantics/mc/explore.ts', symbol: 'reachOne' };
const CHECK_PROPERTY: ProducerRef = {
  file: 'src/semantics/mc/patterns.ts',
  symbol: 'checkProperty',
};

/**
 * Every claim in this lane whose truth is *"nothing of this kind exists"*.
 *
 * Data, so that a test can walk it. Adding a claim without a condition, wiring
 * an increasing claim to the decreasing conjunction, or letting a bound
 * condition back in as an `alsoRequires` conjunct is a red test in
 * `test/unit/semantics.mc.publishable.test.ts` rather than a review comment.
 */
export const ABSENCE_CLAIMS: readonly AbsenceClaim[] = [
  {
    id: 'A0',
    claim: 'state X has no enabled outgoing transition and is not marked final',
    feature: 'reach — `verification/deadlock` (ships today, gated today)',
    polarity: 'mixed',
    polarityNote:
      'decreasing in the over-approximating mechanisms, increasing in the undecided-guard one: a missing edge invents this row',
    walkRequires: 'decreasingOk',
    // THE ONE ESCAPE IN THE REGISTER, and it is legal by stating why: the
    // conjunct names the very mechanism the note identifies. The shipped gate is
    // walk-wise — one undetermined guard anywhere empties the whole array — and
    // the leaf-wise conjunct is added ON TOP of it, which is a strengthening of
    // the row's availability and not a relaxation of its gate.
    alsoRequires: [
      'no outgoing transition of the deadlocked leaf is in `walk.undeterminedGuards`',
    ],
    otherwise: 'the row is withheld and the store sentence prints in its place',
    producedBy: REACH_ONE,
  },
  {
    id: 'A1',
    claim: 'state X is not entered on any explored run',
    feature: 'reach (ships today)',
    polarity: 'decreasing',
    polarityNote: 'add edges and the unreachable list can only shrink',
    walkRequires: 'decreasingOk',
    alsoRequires: [],
    otherwise: 'list emptied',
    producedBy: REACH_ONE,
  },
  {
    id: 'A2',
    claim: 'transition T never fires',
    feature: 'reach (ships today)',
    polarity: 'decreasing',
    polarityNote: 'add edges and the dead-transition list can only shrink',
    walkRequires: 'decreasingOk',
    alsoRequires: [],
    otherwise: 'list emptied',
    producedBy: REACH_ONE,
  },
  {
    id: 'A3',
    claim: 'pass — holds on every reachable configuration',
    feature: 'check-behaviour (ships today)',
    polarity: 'decreasing',
    polarityNote: 'add edges and a bad prefix is easier to find, so the pass is harder to state',
    walkRequires: 'decreasingOk',
    alsoRequires: [],
    otherwise: 'inconclusive',
    producedBy: CHECK_PROPERTY,
  },
  {
    id: 'A4',
    claim: 'vacuous: no explored run opens the scope',
    feature: 'check-behaviour (ships today)',
    polarity: 'decreasing',
    polarityNote: 'add edges and a run that opens the scope is easier to find',
    walkRequires: 'decreasingOk',
    alsoRequires: [],
    otherwise: 'inconclusive',
    producedBy: CHECK_PROPERTY,
  },
  {
    id: 'A5',
    claim: 'not covered',
    feature: 'cover (§3.1)',
    polarity: 'decreasing',
    polarityNote: 'an extra edge can only turn it into `covered`',
    walkRequires: 'decreasingOk',
    // The seeded store is DISCLOSED by the bounds line in every lane and is not
    // a conjunct on this side: this claim's polarity is not flipped by a missing
    // edge.
    alsoRequires: [],
    otherwise: 'inconclusive, `verification/bound-exhausted`',
    producedBy: null,
  },
  {
    id: 'A6',
    claim: 'the trap list is complete, including "no trap"',
    feature: 'reach traps — bottom strongly-connected components (§3.2a)',
    polarity: 'increasing',
    polarityNote:
      '"nothing this walk found is inescapable" gets easier to state as edges are added, so the over-approximation falsifies it',
    walkRequires: 'walkIsExact',
    alsoRequires: [],
    otherwise: 'rows suppressed, never shortened, with the failed clause named',
    producedBy: null,
  },
  {
    id: 'A7',
    claim: '`recoverable`, and the cannot-reach count',
    feature: 'recovery — reverse reachability to a named state (§3.2b)',
    polarity: 'increasing',
    polarityNote: 'reaching a named state from everywhere gets easier as edges are added',
    walkRequires: 'walkIsExact',
    // NO product-search condition, and that is deliberate: `recovery` never
    // reaches `search`, so `Publishability.searchComplete` has no value on this
    // path. Reading it as `false` would print "bound exhausted" about a bound
    // nobody hit.
    alsoRequires: [],
    otherwise: 'inconclusive, naming the failed clause',
    producedBy: null,
  },
  {
    id: 'A8',
    claim: '`guaranteed` — every run violates',
    feature: 'the guaranteed / potential modality (§3.R)',
    polarity: 'mixed',
    polarityNote:
      'decreasing in edges, but a quantification over the run set, which the cooperative environment changes',
    walkRequires: 'walkIsExact',
    alsoRequires: [],
    otherwise: '`potential` or `not-decided`',
    producedBy: null,
  },
  {
    id: 'A9',
    claim: 'current within this proof’s scope',
    feature: 'staleness scoped to a proof core (§3.3b)',
    polarity: 'not-a-walk',
    polarityNote: 'a set of global solver facts, not a fact about any configuration graph',
    walkRequires: null,
    alsoRequires: [
      'core digest unmoved',
      'footprint membership unmoved',
      'axiom-set digest unmoved',
      'premise-row digest unmoved',
    ],
    otherwise: '`stale`, or the two-tier sentence',
    producedBy: null,
  },
  {
    id: 'A10',
    claim: 'holds on every maximal run',
    feature: 'liveness on an acyclic graph (§3.5a)',
    polarity: 'mixed',
    polarityNote:
      'decreasing in edges, but a quantification over the run set: on a latched machine, "nominal forever" is a run of the system and no run of the walk at all',
    walkRequires: 'walkIsExact',
    // A property of the SHAPE of the retained relation, not of its exactness,
    // which is why it sits here and not in the gate.
    alsoRequires: ['`acyclic === true`'],
    otherwise: 'today’s refusal, verbatim',
    producedBy: null,
  },
  {
    id: 'A11',
    claim: 'no fair cycle, and no finite maximal run avoids `p`',
    feature: 'a declared, checked fairness assumption and fair-SCC (§3.5b)',
    polarity: 'increasing',
    polarityNote: 'a `p`-avoiding fair cycle is easier to exhibit as edges are added',
    walkRequires: 'walkIsExact',
    alsoRequires: ['the fair-continuation condition', 'both run classes checked'],
    otherwise: 'inconclusive',
    producedBy: null,
  },
  {
    id: 'A12',
    // The label IS the sentence §3.6 permits, and the scope is part of it. Drop
    // the trailing clause and what remains is the form `claims.test.ts`
    // reserves: unqualified, it reads as a claim about the two machines
    // themselves rather than about the comparison this walk could actually
    // make, over the labels they share. Caught by the widened guard the first
    // time this register and that guard met — including on the comment that
    // first tried to explain it by spelling the banned form out.
    claim: 'no simulation relation exists over the common labels',
    feature: 'stutter-simulation between an abstract machine and its refinement (§3.6)',
    polarity: 'increasing',
    polarityNote: 'an extra edge in the child makes the search fail more easily',
    walkRequires: 'walkIsExact',
    alsoRequires: ['evaluated on BOTH walks, child and parent, and both must hold'],
    otherwise: 'inconclusive',
    producedBy: null,
  },
  {
    id: 'A13',
    claim: 'no cut set up to order N, and the cut sets it publishes',
    feature: 'behavioural fault tree by failure-mode injection (§3.8)',
    polarity: 'mixed',
    polarityNote: '`no cut set` decreasing, each published cut set increasing',
    walkRequires: 'walkIsExact',
    alsoRequires: ['evaluated on EVERY injected walk', 'every order-≤N query decided'],
    otherwise: 'inconclusive, never `no cut set`, and no cut set is published bare',
    producedBy: null,
  },
  {
    id: 'A14',
    claim: 'no cut set (contract lane)',
    feature: 'fault-tree over contracts (ships today)',
    polarity: 'not-a-walk',
    polarityNote: 'a set of solver answers over contracts, with no configuration graph in it',
    walkRequires: null,
    alsoRequires: ['baseline non-vacuous', 'every check decided'],
    otherwise: 'inconclusive: contract set vacuous',
    producedBy: { file: 'src/semantics/fault-tree.ts', symbol: 'groupDetail' },
  },
  {
    id: 'A15',
    claim: 'no in port fails condition 2',
    feature: 'the signature census, conditions 1 and 2 (§3.7b)',
    polarity: 'not-a-walk',
    polarityNote: 'structural: a fact about ports and dependency templates',
    walkRequires: null,
    alsoRequires: ['the census non-degenerate', 'a non-empty dependency template'],
    otherwise: 'the feature is not built',
    producedBy: null,
  },
];

/**
 * The second register: positive witnesses, because a refutation is a positive
 * claim too.
 *
 * A witness that stands on a walk whose relation is not the machine's is a run
 * of no system. The rows carry `kind` because two of the six are not
 * existential at all: a maximality witness is an absence wearing a witness's
 * clothes and reads the whole gate.
 */
export const WITNESS_CLAIMS: readonly WitnessClaim[] = [
  {
    id: 'W1',
    claim: 'the `covered` witness trace',
    feature: 'cover (§3.1)',
    kind: 'existential',
    polarity: 'increasing',
    polarityNote: 'a witness run gets easier to exhibit as edges are added',
    walkRequires: 'relationIsTheMachines',
    perStepAlternative: true,
    ridesOn: null,
    alsoRequires: ['`found.violation !== null`'],
    otherwise:
      'the walk-admits re-wording, never suppression — a bound can hide a witness and can never invent one',
    producedBy: null,
  },
  {
    id: 'W2',
    claim: 'a trap’s `entry` path',
    feature: 'reach traps (§3.2a)',
    kind: 'existential',
    polarity: 'increasing',
    polarityNote: 'an entry path gets easier to exhibit as edges are added',
    walkRequires: 'relationIsTheMachines',
    perStepAlternative: true,
    ridesOn: 'A6',
    alsoRequires: [],
    otherwise:
      'the row is already suppressed with A6; this clause is what stops a per-claim relaxation of the gate being made silently',
    producedBy: null,
  },
  {
    id: 'W3',
    claim: 'potential — the named avoiding cycle or full-relation sink',
    feature: 'the guaranteed / potential modality (§3.R)',
    kind: 'maximality',
    // The per-step alternative does NOT substitute here: the claim is that the
    // cycle or sink has no exit, and a missing edge is exactly what invents one.
    polarity: 'mixed',
    polarityNote:
      'the cycle is exhibited (increasing) but its having no exit is an absence (decreasing) — a missing edge invents it',
    walkRequires: 'walkIsExact',
    perStepAlternative: false,
    ridesOn: null,
    alsoRequires: ['a memoryless monitor', 'a configuration-valued atom'],
    otherwise: '`not decided`, with the reason split by §3.R’s `not decided` rows',
    producedBy: null,
  },
  {
    id: 'W4',
    claim: 'the refuting finite maximal run',
    feature: 'liveness on an acyclic graph (§3.5a)',
    kind: 'maximality',
    // The per-step alternative may substitute for the OVER-APPROXIMATING clauses
    // only — never for `seenWhole` and never for the store clause. A dwell or a
    // trigger the walk supplies can only ADD edges, which makes terminality
    // harder to claim; a bound and an undecided guard REMOVE them, which
    // manufactures it. The column is a boolean, so the partial substitution is
    // recorded here rather than as data, and `false` is the reading that cannot
    // publish something the alternative would not license.
    polarity: 'mixed',
    polarityNote:
      'the run is exhibited (increasing) but its having no successor is an absence (decreasing) — a bound-dropped configuration is indistinguishable from a terminal one',
    walkRequires: 'walkIsExact',
    perStepAlternative: false,
    ridesOn: null,
    alsoRequires: ['`acyclic === true`'],
    otherwise: 'today’s refusal, verbatim',
    producedBy: null,
  },
  {
    id: 'W5',
    claim: 'refuted under fairness — the lasso',
    feature: 'fair-SCC liveness (§3.5b)',
    kind: 'existential',
    polarity: 'increasing',
    polarityNote: 'a lasso gets easier to exhibit as edges are added',
    walkRequires: 'relationIsTheMachines',
    perStepAlternative: true,
    ridesOn: 'A11',
    alsoRequires: [],
    otherwise: 'inconclusive',
    producedBy: null,
  },
  {
    id: 'W6',
    claim: 'each published cut set',
    feature: 'behavioural fault tree (§3.8)',
    kind: 'existential',
    polarity: 'increasing',
    polarityNote: 'a cut set gets easier to exhibit as edges are added',
    walkRequires: 'relationIsTheMachines',
    perStepAlternative: true,
    ridesOn: 'A13',
    alsoRequires: [],
    otherwise:
      'inconclusive; A13’s gate holds the whole report first, so in practice no cut set is published and no `no cut set` is printed',
    producedBy: null,
  },
];

/**
 * The members of the bound family, by the name a register cell would use.
 *
 * A witness row that names one of these has had a bound condition re-added to
 * it, which is what makes a bounded run publishable as a decided one.
 */
export const BOUND_FAMILY: readonly string[] = ['seenWhole', 'decreasingOk', 'searchComplete'];

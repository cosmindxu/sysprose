/**
 * `fault-tree` — which combinations of contract failures break the top
 * requirement.
 *
 * THE CHARTER OF THIS FILE, IN ONE LINE: **a cut set is a solver decision about
 * the SAME obligation (3) `refine` states, taken with the guarantees of a fault
 * set withdrawn — and every absence this command prints carries the order it
 * was checked to.** Everything below is one of those two clauses made
 * mechanical:
 *
 *  - **A basic event is "sub-contract *i* not honoured".** A component that
 *    does not honour its contract promises NOTHING, so its normal form leaves
 *    the premise set entirely rather than being replaced by something weaker.
 *    A set *F* is a cut set exactly when `⋀_{i ∉ F} nf(C′ᵢ) ∧ γ ⊨ nf(C)` FAILS.
 *    That is `stewart-2021`'s fault injection into an AGREE contract and
 *    `bozzano-2014`'s basic event, and it is asked through the one seam
 *    {@link ./refinement} exposes ({@link faultInjectionTargets}) rather than
 *    through a second transcription of the normal form.
 *  - **A vacuous baseline is never "no cut set".** Obligation (3) can never
 *    FAIL from an unsatisfiable antecedent, so a contract set that cannot hold
 *    together survives every fault set — and a tool that enumerated over it
 *    would print "no cut set up to order 2" for an architecture that entails
 *    everything. Step (0) runs first and its `unsat` is
 *    `verification/contract-set-vacuous`, inconclusive, exit 2 (§3.9).
 *  - **An undecided order-1 check forbids the no-single-point claim.** "No
 *    single point of failure" is a statement about EVERY order-1 check having
 *    been decided, and one that timed out is not a component that was shown
 *    harmless. {@link FaultTreeGroup.singlePointOfFailure} is `null` in that
 *    case rather than `false`, so the sentence cannot be composed at all.
 *  - **Every absence carries its bound.** "No cut set up to order 2 — higher
 *    orders not explored" is the whole sentence, always: `⋀ C(n,k)` checks up
 *    to *k* say nothing about *k+1*, and §6's own register lists "no cut set up
 *    to order 2" among the bounded answers that are not proofs.
 *  - **This is contract-level FTA and it says so.** A state machine passed as
 *    `--element` is never answered with an empty cut-set list: an empty list
 *    over a machine reads as a behaviour with no failure mode. It gets a
 *    MEASURED answer instead ({@link machineAnswer}) — how many failure-mode
 *    flags and `#exceptional` states it carries, which is what a behavioural
 *    fault tree would inject and aim at — and exit 2, because nothing was
 *    enumerated. No verdict here may be read as a behavioural safety analysis.
 *
 * WHAT IS NOT HERE. No probabilities, no rates, no importance measures: the
 * model states none and a fault tree without them is a structural statement
 * about which contract failures suffice. No repair, no ordering, no time — this
 * is the propositional and numeric shape of refinement seen from the failure
 * side, exactly as {@link ./refinement} is from the design side.
 *
 * `rauzy-2019`'s point is the reason {@link FAULT_HYPOTHESIS_DEFINITION} exists
 * at all: the safety model and the design model stay separate and are
 * SYNCHRONISED by something written down, and the order bound is the one part
 * of this analysis that is an assumption rather than a computation. A
 * `@SysproseVerification::FaultHypothesis { attribute maxOrder = 2; }` carrier
 * puts it in the file, where a reviewer can argue with it.
 */

import { type ElementId, type ElementRecord, type Model } from '@core/index';
import { type ContractRef, type ContractSubject, type Fragment } from './contracts';
import { hasKeyword } from './keywords';
import { machineStates, stateMachinesIn } from './mc/explore';
import {
  faultInjectionTargets,
  CONTRACT_SET_VACUOUS_CODE,
  REFINEMENT_FAILED_CODE,
  REFINEMENT_UNDECIDED_CODE,
  type GammaEdge,
  type InjectionTarget,
  type RefusedClause,
  type UnencodedConnection,
} from './refinement';
import { type WitnessValue, type Z3Backend } from './smt/z3-bridge';
import {
  EXCEPTIONAL_DEFINITION,
  FAULT_HYPOTHESIS_DEFINITION,
  FAULT_HYPOTHESIS_QUALIFIED_NAME,
} from './verification-vocabulary';

/* ─────────────────────────────── the codes ───────────────────────────────── */

/**
 * One sub-contract whose failure alone breaks the top requirement.
 *
 * Its own code rather than {@link REFINEMENT_FAILED_CODE}, because it is a
 * different finding about a decomposition that may be perfectly correct: an
 * architecture whose obligation (3) is PROVED can still have four single points
 * of failure, and that is what this command exists to say. The severity is an
 * error and the run exits 1 for the same reason a refuted obligation does — it
 * is a decided fact about the model, not a limit of the tool.
 */
export const SINGLE_POINT_OF_FAILURE_CODE = 'verification/single-point-of-failure';

/**
 * Every code a `fault-tree` run can put on a row, for the exit-contract tables
 * to key on.
 *
 * ALL OF THEM, INCLUDING THE BORROWED ONES, and the completeness is the point:
 * this constant is named for what the command can FILE, so a table keyed on it
 * that was missing `verification/timeout` would document an exit contract whose
 * loudest 2 — an undecided order-1 check — has no code in the list. The first
 * four are the verdict codes (one of them this command's own); the rest are the
 * lane's shared undecided and absence codes, which the enumeration re-files
 * verbatim rather than re-spelling: an undecided check is the same fact
 * whichever command met it.
 */
export const FAULT_TREE_CODES: readonly string[] = [
  SINGLE_POINT_OF_FAILURE_CODE,
  CONTRACT_SET_VACUOUS_CODE,
  REFINEMENT_FAILED_CODE,
  REFINEMENT_UNDECIDED_CODE,
  'verification/timeout',
  'verification/not-evaluable',
  'verification/tool-absent',
  'verification/unsupported-expression',
];

/**
 * The order bound this command holds itself to when nothing else says.
 *
 * Two, per §3.9, and it is a BOUND rather than a limit of the method: the
 * enumeration costs `Σ C(n,k)` solver checks, which is why the count is
 * reported on every run and why the sentence "higher orders not explored"
 * travels with every absence.
 */
export const DEFAULT_MAX_ORDER = 2;

/**
 * The sentence every absence in this command carries.
 *
 * Composed HERE and nowhere else, for {@link ./refinement}'s reason: §6's own
 * register lists "no cut set up to order 2" beside "no violation within k" as a
 * bounded answer that is not a proof, and a second spelling of it in a renderer
 * is how the report and the documentation come to make two different claims
 * about one figure.
 */
export const ORDERS_NOT_EXPLORED_NOTE = 'higher orders not explored';

/** What this command is, printed on every report so no reader has to infer it. */
export const CONTRACT_LEVEL_NOTE =
  'this is contract-level fault-tree analysis over the refinement obligations, not a behavioural ' +
  'safety analysis: it says which contract failures break the top requirement, and nothing about ' +
  'ordering, time, rates or probabilities';

/* ─────────────────────────────── the shapes ──────────────────────────────── */

/** How a fault-tree run is aimed and bounded. */
export interface FaultTreeOptions {
  /** The solver. Absence is decided by the caller, never here. */
  backend: Z3Backend;
  /** Only the decomposition at this element: a system contract, or the part it is about. */
  elementId?: ElementId;
  /** The order bound. Overrides a `FaultHypothesis` carrier; defaults to {@link DEFAULT_MAX_ORDER}. */
  maxOrder?: number;
  /** The per-check budget in ms. Every check in this lane is bounded. */
  timeoutMs?: number;
}

/**
 * Where the order bound this group ran under came from.
 *
 * `carrier-unreadable` is the fourth because a bound's PROVENANCE is part of
 * the answer: a model that carries a `@SysproseVerification::FaultHypothesis`
 * whose `maxOrder` cell this tool could not read ran under the default, and a
 * report that said "from the default" over it would attribute the assumption to
 * nobody while the file states one. The bound is the same; the sentence is not.
 */
export type MaxOrderSource = 'flag' | 'carrier' | 'default' | 'carrier-unreadable';

/**
 * One basic event: a sub-contract, and whether it is a leaf.
 *
 * A sub-contract that heads a decomposition of its OWN is an INTERMEDIATE event
 * in `bozzano-2014`'s sense — its failure is not primitive, it is the top event
 * of the tree one level down — and this report says so rather than presenting a
 * whole subsystem as an atom. The expansion is the other group of the same run:
 * a three-level tree yields two groups, and the mid-level contract is a basic
 * event of the upper one and the top event of the lower one.
 */
export interface BasicEvent {
  contract: ContractRef;
  shortId: string;
  /** The part the sub-contract is satisfied by. */
  part: ContractRef | null;
  /** Does this sub-contract head a decomposition of its own in this run? */
  intermediate: boolean;
  /** The group its own cut sets are reported under, or `null` for a leaf. */
  expandsTo: string | null;
}

/** One cut set: the sub-contracts whose joint failure breaks the top event. */
export interface CutSet {
  order: number;
  /** The basic events, by qualified name, in the order the events are listed. */
  events: string[];
  /** The same, by short id where the requirement has one. */
  shortIds: string[];
  /**
   * Was this set shown to be MINIMAL — no proper subset of it is a cut set?
   *
   * `true` for every set found in a run where every smaller check was decided,
   * which is the ordinary case: the enumeration goes by increasing order and
   * prunes supersets of the sets it found, so a set that survives to be checked
   * has no cut set inside it. **`false` when a proper subset of it came back
   * UNDECIDED** — a subset nobody decided may itself be the cut set, and then
   * this set is a cut set whose minimality was never established. It is still
   * listed, because it is a real one; it is not called minimal, because nothing
   * showed that it is.
   */
  minimal: boolean;
  /** The sentence a person reads, witness included. */
  detail: string;
  /** The implementation the remaining contracts admit and the top requirement forbids. */
  witness: WitnessValue[];
}

/** One check the solver did not decide, with the fault set it was about. */
export interface UndecidedCheck {
  order: number;
  events: string[];
  code: string;
  detail: string;
}

/** What one fault tree came to. */
export type FaultTreeOutcome =
  /** Cut sets were found up to the order bound. */
  | 'cut-sets'
  /** Every check up to the order bound was decided and none of them failed. */
  | 'no-cut-set'
  /** Step (0): the contract set cannot hold together, so nothing was enumerated. */
  | 'vacuous'
  /** Obligation (3) fails with EVERY sub-contract honoured — there is no fault to inject. */
  | 'top-event-open'
  /** Something was not decided, and no absence may be claimed. */
  | 'inconclusive';

/** One top event, its basic events, and the cut sets over them. */
export interface FaultTreeGroup {
  /** The top event: the system contract of this decomposition. */
  top: ContractRef;
  shortId: string;
  subject: ContractSubject | null;
  /** The part the top contract is satisfied by. */
  part: ContractRef;
  /**
   * Does the top requirement carry `#exceptional`?
   *
   * Labelled and nothing more: §3.9 is explicit that the cut sets of an
   * exceptional top event are unchanged. The tag says the outcome is a failure
   * rather than an equally valid result, which is a fact about how a reader
   * should read the tree, not an input to the solver.
   */
  exceptional: boolean;
  events: BasicEvent[];
  /** The minimal cut sets, by increasing order. Supersets are pruned, never listed. */
  cutSets: CutSet[];
  /** Every check the solver did not decide, with the fault set it was about. */
  undecided: UndecidedCheck[];
  /**
   * Is there a sub-contract whose failure ALONE breaks the top event?
   *
   * `true` when an order-1 cut set was found, `false` when every order-1 check
   * came back decided and none failed, and **`null` when any order-1 check was
   * undecided** — the one state §3.9's MUST-NEVER list is about. A renderer
   * cannot compose the absence sentence out of `null`, which is the point.
   */
  singlePointOfFailure: boolean | null;
  /** The order this run enumerated to, and where that number came from. */
  maxOrder: number;
  maxOrderSource: MaxOrderSource;
  outcome: FaultTreeOutcome;
  /** The `verification/*` code, for a group that is not a clean enumeration. */
  code: string | null;
  /** The sentence a person reads. It always carries the order bound and the γ census. */
  detail: string;
  /** The unsat core of step (0), when step (0) answered unsat. */
  vacuityCore: string[];
  /** How many solver checks this group cost, step (0) and the baseline included. */
  checks: number;
  /** The equalities γ asserted, in the order they were read. */
  gamma: GammaEdge[];
  /** Connectors nothing read as an equality, each with the `bind` hint. */
  notEncoded: UnencodedConnection[];
  /** Relations of this group's contracts that nothing asserted. */
  refused: RefusedClause[];
  /** The plan's two-word fragment vocabulary, over the scripts this group ran. */
  fragment: Fragment;
  /** The `set-logic` the last script actually declared. `''` when none ran. */
  logic: string;
}

/** What one run came to. */
export interface FaultTreeResult {
  groups: FaultTreeGroup[];
  /** How many contracts the model states at all. */
  contracts: number;
  /** The γ census, over the whole run. */
  bindEqualities: number;
  itemFlows: number;
  connectionEqualities: number;
  notEncoded: UnencodedConnection[];
  refused: RefusedClause[];
  /** Total solver checks. */
  checks: number;
  /** The per-check budget every check ran under. */
  timeoutMs: number | undefined;
}

/* ───────────────────────── the two lanes stay apart ──────────────────────── */

/** The metaclasses a behavioural question is asked about rather than this one. */
const STATE_ECLASSES: ReadonlySet<string> = new Set([
  'StateUsage',
  'StateDefinition',
  'StateSubactionMembership',
]);

/** Is this element a state machine, i.e. the OTHER safety lane's subject? */
export function isBehaviouralElement(el: ElementRecord): boolean {
  return STATE_ECLASSES.has(el.eClass);
}

/**
 * The metadata definition a failure-mode flag is tagged with.
 *
 * The definition itself SHIPS IN THE VOCABULARY COMMIT, not here (plan §3.8:
 * `metadata def <failureMode> FailureMode;`, applied as a keyword on a Boolean
 * attribute of the machine — the store Boolean the guards read, marked as a
 * fault variable the analysis may set rather than a design parameter). Until
 * then only a model that declares its own definition by this name is counted,
 * and that is the point of counting through {@link hasKeyword} rather than by
 * spelling: `keywords.ts`'s rule is that a keyword naming no definition in
 * scope tags nothing, so a bare `#failureMode` written ahead of the vocabulary
 * reads 0 here for the same reason `contracts --keywords` reports it as naming
 * nothing. The census reads 0 on the shipped corpus for the RIGHT reason.
 */
export const FAILURE_MODE_DEFINITION = 'FailureMode';

/** What one machine carries of the two things a behavioural fault tree would need. */
export interface MachineFailureModes {
  /** Attributes under the machine tagged with {@link FAILURE_MODE_DEFINITION}. */
  failureModeFlags: number;
  /** States under the machine tagged `#exceptional` — the hazard a tree would aim at. */
  exceptionalStates: number;
}

/**
 * The answer a state machine passed as `--element` gets.
 *
 * MEASURED, NOT REFUSED, AND STILL NOT A TREE. This command injects failures
 * into the CONTRACTS a `satisfy` attaches to the parts of a system, and a
 * machine carries none — so there is nothing here to withdraw, and an empty
 * cut-set list would read as a machine with no failure mode. What a
 * behavioural lane would inject instead is a fault variable — a Boolean flag
 * the guards read — and what it would aim at is an `#exceptional` state; this
 * answer counts both, and the count is the gate the behavioural lane is held
 * behind (plan §3.8's release condition). A machine that carries neither is
 * the ordinary case in this repository, and the sentence says so with the
 * measured numbers rather than with a refusal.
 *
 * NO POINTER. The refusal this replaces once sent a reader to a flag that did
 * not exist, and the guard that finally caught it read the rendered refusal
 * back against the command table. A sentence that names no invocation cannot
 * go stale that way, and `check-behaviour` is documented where commands are.
 *
 * What may never happen is an empty cut-set list over a machine. "0 cut sets"
 * reads as "no combination of failures breaks this", which about a behaviour
 * this command never looked at is the loudest false statement it could make —
 * so the run that carries this answer enumerates nothing, claims no absence,
 * and is exit 2 under the row that names it.
 */
export interface MachineAnswer {
  /**
   * The machine the reader named — always one of {@link stateMachinesIn}'s
   * roots, because {@link machineRouteRefusal} turns anything else away before
   * an answer is composed, so this is the same element the census counted.
   */
  element: { id: ElementId; qualifiedName: string };
  failureModeFlags: number;
  exceptionalStates: number;
  /** The one sentence the run prints, with both numbers in it. */
  sentence: string;
}

/**
 * The file-wide census a behavioural fault tree is held behind (plan §2.5,
 * §3.8), taken on every run and published under `--json` only.
 *
 * The three named fields are the ones the plan reads the lane's release
 * against; `machines` is the denominator, because *0 machines with an
 * `#exceptional` state* means something different over 0 machines and over a
 * dozen. `hazardsUnreachableFromTheContractLane` is defined here rather than
 * computed as a difference: it is the number of `#exceptional` STATES across
 * every machine, and every one of them is unreachable from the contract lane
 * BY CONSTRUCTION — a fault-injection top event is a requirement satisfied by
 * a part, and a state is never one — so the name says what the number is a
 * count of rather than implying a subtraction this tool performed.
 */
export interface BehaviouralLaneCensus {
  /**
   * State machines the file states, the bundled library excluded — under
   * `reach`'s definition ({@link stateMachinesIn}): an element that DIRECTLY
   * owns a `TransitionUsage`, or a parallel container holding one, and is not
   * inside another such element. A `state def` whose states are joined only
   * by successions owns no transition and is NOT counted, exactly as `reach`
   * walks nothing over it; and a state INSIDE a machine is a region of it, not
   * a second machine. The route that answers a machine holds to the same
   * bound ({@link machineRootOf}), so one payload never calls an element a
   * machine that this figure did not count.
   */
  machines: number;
  machinesWithExceptionalStates: number;
  machinesWithFailureModeFlags: number;
  hazardsUnreachableFromTheContractLane: number;
}

/**
 * The census machine an element belongs to: the {@link stateMachinesIn} root
 * that is the element itself or one of its ancestors, or `null` when there is
 * none.
 *
 * ONE POPULATION FOR THE ROUTE AND THE CENSUS. `isBehaviouralElement` says
 * what a reader may point `--element` at (any state), and `stateMachinesIn`
 * says what the census counts (roots that own a transition); this is the seam
 * between them. Measured without it, a `--json` payload could carry a machine
 * answer beside `machines: 0` over `succession-only.sysml`, and a state named
 * INSIDE a machine was counted by its own descendants — so the `#exceptional`
 * hazard a reader named was answered with `0 \`#exceptional\` state(s)` about
 * itself. Both were false statements on the printed page.
 */
export function machineRootOf(model: Model, id: ElementId): ElementRecord | null {
  const roots = new Map(stateMachinesIn(model).map((m) => [m.id, m] as const));
  let cursor: ElementId | null | undefined = id;
  while (cursor != null) {
    const root = roots.get(cursor);
    if (root !== undefined) return root;
    cursor = model.get(cursor)?.ownerId;
  }
  return null;
}

/**
 * Why an element may NOT be answered as a machine, or `null` when it is one.
 *
 * REFUSED, NOT RE-TARGETED. A state inside a machine could be silently
 * resolved to the machine and answered about that — but the reader named the
 * state, and an answer about an element they did not name is its own honesty
 * problem; `check-behaviour` refuses the same input the same way. A state
 * definition that owns no transition is not one of this tool's machines at
 * all, and `reach` already says so in these words rather than walking it.
 * The sentence is composed once here so the command line (`UsageError`) and
 * the API (`VerifyOptionError`) cannot come to disagree about the reason.
 */
export function machineRouteRefusal(model: Model, id: ElementId): string | null {
  const named = model.qualifiedName(id) || id;
  const root = machineRootOf(model, id);
  if (root === null) {
    return (
      `\`${named}\` owns no transition, so it is not one of this tool's state machines: \`reach\` reads a ` +
      'machine as an element that owns a transition, this command measures the same machines ' +
      '`reach` walks, and a `state def` whose states are joined only by successions is walked by ' +
      'neither — there is nothing here to count and no contract to withdraw'
    );
  }
  if (root.id !== id) {
    return (
      `\`${named}\` is a state inside \`${model.qualifiedName(root.id) || root.id}\`, which is the machine ` +
      'this command measures — name the machine: an answer about one state would count only what ' +
      "is under it, and that is not the machine's failure modes"
    );
  }
  return null;
}

/**
 * Count what one machine carries; the two numbers every sentence above prints.
 *
 * Counts what is UNDER `machineId`: call it with a {@link stateMachinesIn}
 * root ({@link machineRootOf}), which is what {@link faultTreeReport} enforces
 * — over a leaf state it would count that state's descendants and read a
 * tagged leaf as carrying nothing.
 */
export function machineFailureModes(model: Model, machineId: ElementId): MachineFailureModes {
  const failureModeFlags = model
    .descendants(machineId)
    .filter((e) => e.eClass === 'AttributeUsage' && hasKeyword(model, e.id, FAILURE_MODE_DEFINITION))
    .length;
  const exceptionalStates = machineStates(model, machineId).filter((s) =>
    hasKeyword(model, s.id, EXCEPTIONAL_DEFINITION),
  ).length;
  return { failureModeFlags, exceptionalStates };
}

/** The measured answer for one machine — see {@link MachineAnswer}. */
export function machineAnswer(model: Model, machineId: ElementId): MachineAnswer {
  const qualifiedName = model.qualifiedName(machineId) || machineId;
  const { failureModeFlags, exceptionalStates } = machineFailureModes(model, machineId);
  const counts =
    `${failureModeFlags} failure-mode flag(s), ${exceptionalStates} \`#exceptional\` state(s)`;
  // TWO TAILS, BECAUSE ONE WOULD BE FALSE. "No fault variable to inject" is
  // the truth about every machine in this repository, and a lie about a model
  // that declared its own `FailureMode` definition and applied it — the
  // sentence must not tell that reader nothing was found when something was.
  // Both tails are clauses of the exit contract's 2 row (`FAULT_TREE_EXIT_CODES`:
  // "found none of", "found and does not inject"), so `--help` and the report
  // publish one reason for one exit code whichever tail is printed.
  const sentence =
    failureModeFlags === 0
      ? `\`${qualifiedName}\` is a state machine whose failure modes this command found none of: ` +
        `${counts} — the behavioural lane has no fault variable to inject here`
      : `\`${qualifiedName}\` is a state machine whose failure modes this command found and does not ` +
        `inject: ${counts} — no behavioural lane is built here, so nothing was injected and no ` +
        'absence is claimed';
  return { element: { id: machineId, qualifiedName }, failureModeFlags, exceptionalStates, sentence };
}

/** The census over every machine the file states — see {@link BehaviouralLaneCensus}. */
export function behaviouralLaneCensus(model: Model): BehaviouralLaneCensus {
  const census: BehaviouralLaneCensus = {
    machines: 0,
    machinesWithExceptionalStates: 0,
    machinesWithFailureModeFlags: 0,
    hazardsUnreachableFromTheContractLane: 0,
  };
  for (const machine of stateMachinesIn(model)) {
    const { failureModeFlags, exceptionalStates } = machineFailureModes(model, machine.id);
    census.machines += 1;
    if (exceptionalStates > 0) census.machinesWithExceptionalStates += 1;
    if (failureModeFlags > 0) census.machinesWithFailureModeFlags += 1;
    census.hazardsUnreachableFromTheContractLane += exceptionalStates;
  }
  return census;
}

/* ──────────────────────── the fault hypothesis carrier ───────────────────── */

/** Is this element a `@SysproseVerification::FaultHypothesis { … }` carrier? */
function isFaultHypothesisCarrier(el: ElementRecord): boolean {
  if (el.eClass !== 'MetadataUsage' || el.attrs.annotation !== true) return false;
  const type = el.attrs.type;
  return type === FAULT_HYPOTHESIS_QUALIFIED_NAME || type === FAULT_HYPOTHESIS_DEFINITION;
}

/**
 * Is this a `maxOrder` cell of a fault-hypothesis carrier?
 *
 * BOTH SPELLINGS, and the reason is that §3.9 writes the OTHER one. A metadata
 * body may be written `{ attribute maxOrder = 2; }` or `{ maxOrder = 2; }`, and
 * the parser stores the second as a keyword-less `ReferenceUsage` rather than
 * as an `AttributeUsage`. A reader who copies the carrier out of the plan — or
 * out of any SysML v2 annotation body, where the keyword-less form is the
 * ordinary one — must not have their order bound silently replaced by the
 * default: the bound is the one input of this analysis that is an ASSUMPTION,
 * and an assumption dropped without a word is the failure `rauzy-2019`'s sync
 * handle exists to prevent.
 */
function isMaxOrderCell(cell: ElementRecord): boolean {
  if (cell.declaredName !== 'maxOrder') return false;
  return (
    cell.eClass === 'AttributeUsage' ||
    (cell.eClass === 'ReferenceUsage' && cell.attrs.keywordless === true)
  );
}

/** The number a carrier cell holds, or `undefined` when it holds no whole number. */
function cellNumber(raw: unknown): number | undefined {
  const text =
    typeof raw === 'number'
      ? String(raw)
      : typeof raw === 'string'
        ? raw.replace(/^"|"$/g, '').trim()
        : '';
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/**
 * The order bound the MODEL pins, read off the top event or the part it is about.
 *
 * Both places, because both are where a reviewer would write it: the hypothesis
 * is about the top requirement's tree, and the part that satisfies it is the
 * subsystem the tree is drawn for. A carrier that names no readable `maxOrder`
 * is not guessed at — an order bound is an ASSUMPTION about how many
 * independent failures are considered credible, and inventing one from a
 * malformed cell would put a number nobody wrote onto every absence this
 * command prints — but it is not ignored either: `carrierSeen` travels back so
 * the run says "a `FaultHypothesis` is here and I could not read it" rather
 * than attributing the bound to a default over a file that states one.
 */
function pinnedMaxOrder(
  model: Model,
  target: InjectionTarget,
): { value: number | undefined; carrierSeen: boolean } {
  let carrierSeen = false;
  for (const holderId of [target.system.id, target.part.id]) {
    for (const carrier of model.children(holderId)) {
      if (!isFaultHypothesisCarrier(carrier)) continue;
      carrierSeen = true;
      for (const cell of model.children(carrier.id)) {
        if (!isMaxOrderCell(cell)) continue;
        const n = cellNumber(cell.attrs.value);
        if (n !== undefined) return { value: n, carrierSeen: true };
      }
    }
  }
  return { value: undefined, carrierSeen };
}

/**
 * The order bound one group runs under, and where the number came from.
 *
 * One function for both the deciding run and the census a solverless run takes,
 * so a report with no solver cannot state a different bound — or a different
 * PROVENANCE — from the one the same command would have enumerated to. The
 * clamp is here for the same reason: a fault set larger than the whole
 * decomposition is not a set of sub-contracts.
 */
function boundFor(
  model: Model,
  target: InjectionTarget,
  asked: number | undefined,
): { maxOrder: number; maxOrderSource: MaxOrderSource; asked: number } {
  const pinned = pinnedMaxOrder(model, target);
  const maxOrderSource: MaxOrderSource =
    asked !== undefined
      ? 'flag'
      : pinned.value !== undefined
        ? 'carrier'
        : pinned.carrierSeen
          ? 'carrier-unreadable'
          : 'default';
  const want = asked ?? pinned.value ?? DEFAULT_MAX_ORDER;
  return {
    maxOrder: Math.max(1, Math.min(want, target.components.length)),
    maxOrderSource,
    asked: want,
  };
}

/* ───────────────────────────── the enumeration ───────────────────────────── */

/** Every subset of `n` indices of size `k`, in lexicographic order. */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick: number[] = [];
  const walk = (start: number): void => {
    if (pick.length === k) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i < n; i += 1) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  if (k >= 0 && k <= n) walk(0);
  return out;
}

/**
 * Decide which combinations of contract failures break each top requirement.
 *
 * Asynchronous only because the solver is. Everything else is a pure function
 * of the model and the options — including the enumeration ORDER, which is
 * lexicographic over the components in model order so that two runs over one
 * file produce byte-identical JSON.
 */
export async function computeFaultTree(
  model: Model,
  opts: FaultTreeOptions,
): Promise<FaultTreeResult> {
  const census = faultInjectionTargets(model, {
    ...(opts.elementId !== undefined ? { elementId: opts.elementId } : {}),
  });
  const groups: FaultTreeGroup[] = [];
  let checks = 0;
  for (const target of census.targets) {
    const group = await judgeTarget(model, target, census.targets, opts);
    checks += group.checks;
    groups.push(group);
  }
  return {
    groups,
    contracts: census.contracts,
    bindEqualities: census.bindEqualities,
    itemFlows: census.itemFlows,
    connectionEqualities: census.connectionEqualities,
    notEncoded: census.notEncoded,
    refused: census.refused,
    checks,
    timeoutMs: opts.timeoutMs,
  };
}

/**
 * The census a run with NO SOLVER can still take, with every tree undecided.
 *
 * The same shape {@link computeFaultTree} returns, so the report above it does
 * not branch: every top event is `inconclusive` under the code the caller
 * names, the basic events and the γ census are real, and no cut set — and no
 * ABSENCE of one — is claimed. A tool-absent run that printed "0 cut sets"
 * would be the single failure this whole lane exists to make impossible.
 */
export function faultTreeCensus(
  model: Model,
  opts: { elementId?: ElementId; maxOrder?: number },
  undecided: { code: string; detail: string },
): FaultTreeResult {
  const census = faultInjectionTargets(model, {
    ...(opts.elementId !== undefined ? { elementId: opts.elementId } : {}),
  });
  const groups = census.targets.map((target) => {
    // THE BOUND THIS RUN WAS GIVEN, not the one the module defaults to. A
    // solverless run that printed "order bound 2, from the default" under
    // `--max-order 1` would attribute an assumption to a source the reader did
    // not use — about a run that enumerated to no bound at all.
    const bound = boundFor(model, target, opts.maxOrder);
    return {
      ...emptyGroup(model, target, census.targets, bound.maxOrder, bound.maxOrderSource),
      outcome: 'inconclusive' as FaultTreeOutcome,
      code: undecided.code,
      detail: `${undecided.detail}. ${target.census}`,
    };
  });
  return {
    groups,
    contracts: census.contracts,
    bindEqualities: census.bindEqualities,
    itemFlows: census.itemFlows,
    connectionEqualities: census.connectionEqualities,
    notEncoded: census.notEncoded,
    refused: census.refused,
    checks: 0,
    timeoutMs: undefined,
  };
}

/** The basic events of one decomposition, with the intermediate ones named. */
function eventsOf(target: InjectionTarget, all: readonly InjectionTarget[]): BasicEvent[] {
  return target.components.map((c) => {
    const below = all.find((t) => t.system.id === c.contract.id);
    return {
      contract: c.contract,
      shortId: c.shortId,
      part: c.part,
      intermediate: below !== undefined,
      expandsTo: below ? below.system.qualifiedName : null,
    };
  });
}

/** A group with no answer in it yet, in the shape every branch below returns. */
function emptyGroup(
  model: Model,
  target: InjectionTarget,
  all: readonly InjectionTarget[],
  maxOrder: number,
  maxOrderSource: MaxOrderSource,
): FaultTreeGroup {
  return {
    top: target.system,
    shortId: target.shortId,
    subject: target.subject,
    part: target.part,
    exceptional: hasKeyword(model, target.system.id, EXCEPTIONAL_DEFINITION),
    events: eventsOf(target, all),
    cutSets: [],
    undecided: [],
    singlePointOfFailure: null,
    maxOrder,
    maxOrderSource,
    outcome: 'inconclusive',
    code: REFINEMENT_UNDECIDED_CODE,
    detail: '',
    vacuityCore: [],
    checks: 0,
    gamma: target.gamma,
    notEncoded: target.notEncoded,
    refused: target.refused,
    fragment: 'qf-lra',
    logic: '',
  };
}

/**
 * Build the fault tree of one decomposition.
 *
 * THE ORDER IS THE CONTRACT, and it is the reason each of these three checks
 * comes before the enumeration rather than beside it:
 *
 *  1. **The stand-down.** A premise set smaller than the file's invents cut
 *     sets and can rule none out; {@link InjectionTarget.standDown} carries the
 *     three ways that happens.
 *  2. **Step (0).** An unsatisfiable antecedent survives every fault set, so an
 *     enumeration over it prints "no cut set" for a contract set that entails
 *     everything (§3.9). It is `vacuous`, exit 2, and no flag lowers it.
 *  3. **The baseline, order 0.** If obligation (3) already fails with every
 *     sub-contract honoured, the top event is open with no fault at all: the
 *     empty set is the cut set, and injecting failures into an architecture
 *     that does not refine would answer a question the reader should not be
 *     asking yet. That is `refine`'s finding, not this command's, and the row
 *     says so.
 */
async function judgeTarget(
  model: Model,
  target: InjectionTarget,
  all: readonly InjectionTarget[],
  opts: FaultTreeOptions,
): Promise<FaultTreeGroup> {
  // A fault set larger than the whole decomposition is not a set of
  // sub-contracts, so the bound a reader asked for is reported back CLAMPED
  // rather than silently enumerated to nothing.
  const { maxOrder, maxOrderSource, asked } = boundFor(model, target, opts.maxOrder);
  const events = target.components.length;
  const base = emptyGroup(model, target, all, maxOrder, maxOrderSource);
  const bound = `up to order ${maxOrder}${maxOrder < asked ? ` (asked for ${asked}; this decomposition has ${events} sub-contract(s))` : ''}`;
  const solverOpts = {
    backend: opts.backend,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };

  if (target.standDown !== null) {
    return {
      ...base,
      outcome: 'inconclusive',
      code: target.standDown.code,
      detail: `${target.standDown.detail}. No cut set is claimed and none is ruled out. ${target.census}`,
    };
  }

  // ── step (0): can the sub-contracts, the connections and A hold at all? ────
  let checks = 1;
  const zero = await target.baseline(solverOpts);
  if (zero.status === 'unsat') {
    return {
      ...base,
      checks,
      outcome: 'vacuous',
      code: CONTRACT_SET_VACUOUS_CODE,
      vacuityCore: [...zero.core],
      detail:
        'inconclusive: contract set vacuous — the sub-contracts, the connections and the top ' +
        'requirement’s assumption cannot hold together ' +
        `(core ${zero.core.length > 0 ? zero.core.join(', ') : 'the solver named none'}), so ` +
        'obligation (3) can never FAIL and no fault set could be a cut set. This is not "no cut ' +
        `set": nothing was enumerated. ${target.census}`,
    };
  }
  if (zero.status !== 'sat') {
    return {
      ...base,
      checks,
      outcome: 'inconclusive',
      code: zero.status === 'unknown' ? 'verification/timeout' : 'verification/not-evaluable',
      detail:
        (zero.status === 'unknown'
          ? `the solver was asked whether this contract set can hold together at all and did not answer ` +
            `(${zero.reason || 'unknown'} after ${zero.timeoutMs} ms)`
          : `the solver refused the script this tool produced: ${zero.reason}. That is a defect in this ` +
            'tool, not in the model') +
        `. No cut set is claimed and none is ruled out. ${target.census}`,
    };
  }

  // ── order 0: does the top event hold with every sub-contract honoured? ─────
  const baseline = await target.obligationThree(new Set(), solverOpts);
  checks += baseline.checks;
  if (baseline.status === 'fails') {
    return {
      ...base,
      checks,
      logic: baseline.logic,
      fragment: baseline.fragment,
      outcome: 'top-event-open',
      code: REFINEMENT_FAILED_CODE,
      detail:
        'the top event occurs with EVERY sub-contract honoured: obligation (3) is refuted before any ' +
        'fault is injected, so the empty set is a cut set and no enumeration was run. Fix the ' +
        'decomposition first — `refine --via composition` is the report about it — because a fault ' +
        `tree over an architecture that does not refine describes failures nothing has to cause. ${baseline.detail}. ${target.census}`,
    };
  }
  if (baseline.status === 'undecided') {
    return {
      ...base,
      checks,
      logic: baseline.logic,
      fragment: baseline.fragment,
      outcome: 'inconclusive',
      code: baseline.code ?? REFINEMENT_UNDECIDED_CODE,
      detail:
        `the top event was not decided with every sub-contract honoured (${baseline.detail}), so ` +
        'there is no baseline to inject faults against. No cut set is claimed and none is ruled ' +
        `out. ${target.census}`,
    };
  }

  // ── the enumeration: by increasing order, supersets pruned ────────────────
  const cutSets: CutSet[] = [];
  const undecided: UndecidedCheck[] = [];
  let logic = baseline.logic;
  let fragment = baseline.fragment;
  const names = target.components.map((c) => c.contract.qualifiedName);
  // THE SHORT NAME A CUT SET IS PRINTED UNDER, in the three spellings a
  // requirement can carry: `<R-PWR-001>` where the file writes one, the
  // declared name where it does not, and the qualified name as the last resort.
  // A cut set is read as a SET — `{battery, radio}` — and a set whose members
  // are three-segment qualified names is one a reader has to decode before they
  // can act on it.
  const shortIds = target.components.map(
    (c) => c.shortId || c.contract.declaredName || c.contract.qualifiedName,
  );
  const found: number[][] = [];
  // THE SETS NOBODY DECIDED, kept beside the ones that failed and for the
  // opposite reason. Pruning removes supersets of sets shown to be cut sets;
  // it cannot remove supersets of a set the solver did not answer about,
  // because that set may itself be the cut set inside them. So they are still
  // checked and still listed — they are real cut sets — but their MINIMALITY
  // was never established, and a row that said "minimal" over one would claim
  // a smaller set had been ruled out when nothing ruled it out.
  const undecidedSets: number[][] = [];
  for (let order = 1; order <= maxOrder; order += 1) {
    for (const subset of combinations(events, order)) {
      // MINIMALITY IS PRUNING, NOT FILTERING. A superset of a cut set is a cut
      // set for free — withdrawing more guarantees cannot restore an obligation
      // that already failed — so it is never checked and never listed. Checking
      // it would spend a solver call to learn nothing and would print a set
      // whose failure is already explained by a smaller one.
      if (found.some((cut) => cut.every((i) => subset.includes(i)))) continue;
      const dropped = new Set(subset.map((i) => target.components[i].contract.id));
      const r = await target.obligationThree(dropped, solverOpts);
      checks += r.checks;
      logic = r.logic;
      fragment = r.fragment;
      if (r.status === 'fails') {
        found.push(subset);
        const minimal = !undecidedSets.some(
          (u) => u.length < subset.length && u.every((i) => subset.includes(i)),
        );
        cutSets.push({
          order,
          events: subset.map((i) => names[i]),
          shortIds: subset.map((i) => shortIds[i]),
          minimal,
          // The WITNESS IS NOT SPELLED INTO THIS SENTENCE, and it is not an
          // omission: it travels beside it, in `witness`, so that a renderer
          // prints it once and a JSON consumer reads it as values rather than
          // as prose. What the sentence says is what the set MEANS.
          detail:
            `{${subset.map((i) => shortIds[i]).join(', ')}} is a cut set: with ` +
            `${order === 1 ? 'this guarantee' : 'these guarantees'} withdrawn the remaining ` +
            'sub-contracts and the connections admit an implementation the top requirement ' +
            'forbids — a counterexample this tool re-read and confirmed before printing it' +
            (minimal
              ? ''
              : '. MINIMALITY NOT ESTABLISHED: a proper subset of this set was not decided, and ' +
                'that subset may itself be the cut set'),
          witness: r.witness,
        });
      } else if (r.status === 'undecided') {
        undecidedSets.push(subset);
        undecided.push({
          order,
          events: subset.map((i) => names[i]),
          code: r.code ?? REFINEMENT_UNDECIDED_CODE,
          detail: `{${subset.map((i) => shortIds[i]).join(', ')}} was not decided: ${r.detail}`,
        });
      }
    }
  }

  const order1Undecided = undecided.some((u) => u.order === 1);
  const order1Cut = cutSets.some((c) => c.order === 1);
  // `null` rather than `false` the moment ONE order-1 check went undecided:
  // §3.9's MUST-NEVER is about exactly this sentence, and a boolean that
  // collapsed "shown harmless" into "not shown to be harmful" is how it gets
  // written by accident three renderers away.
  const singlePointOfFailure = order1Cut ? true : order1Undecided ? null : false;
  const outcome: FaultTreeOutcome =
    cutSets.length > 0 ? 'cut-sets' : undecided.length > 0 ? 'inconclusive' : 'no-cut-set';
  return {
    ...base,
    checks,
    logic,
    fragment,
    cutSets,
    undecided,
    singlePointOfFailure,
    outcome,
    code:
      outcome === 'cut-sets'
        ? order1Cut
          ? SINGLE_POINT_OF_FAILURE_CODE
          : null
        : outcome === 'inconclusive'
          ? (undecided[0]?.code ?? REFINEMENT_UNDECIDED_CODE)
          : null,
    detail: groupDetail({
      outcome,
      cutSets,
      undecided,
      events,
      bound,
      singlePointOfFailure,
      census: target.census,
      checks,
    }),
  };
}

/** The group's sentence, which always carries the order bound and the γ census. */
function groupDetail(input: {
  outcome: FaultTreeOutcome;
  cutSets: readonly CutSet[];
  undecided: readonly UndecidedCheck[];
  events: number;
  bound: string;
  singlePointOfFailure: boolean | null;
  census: string;
  checks: number;
}): string {
  const decided = input.undecided.length === 0;
  // THE WORD "MINIMAL" IS EARNED, NOT DECORATIVE. A set is called minimal when
  // every proper subset of it was decided and none of them was a cut set; a run
  // that left a subset undecided has not shown that, so the head sentence drops
  // the word and says how many rows it applies to. Otherwise the report would
  // print a set as irreducible while a smaller candidate sits unanswered two
  // lines below it.
  const notMinimal = input.cutSets.filter((c) => !c.minimal).length;
  const head =
    input.outcome === 'cut-sets'
      ? `${input.events} basic event(s); ${input.cutSets.length} ` +
        (notMinimal === 0
          ? 'minimal cut set(s) '
          : `cut set(s) (${notMinimal} of them NOT shown to be minimal — a proper subset was not decided) `) +
        `${input.bound}: ` +
        input.cutSets.map((c) => `{${c.shortIds.join(', ')}}`).join(', ')
      : input.outcome === 'inconclusive'
        ? `${input.events} basic event(s); no cut set was found ${input.bound} and ` +
          `${input.undecided.length} check(s) were NOT decided, so no absence is claimed`
        : `${input.events} basic event(s); no cut set ${input.bound} — ${ORDERS_NOT_EXPLORED_NOTE}`;
  const spof =
    input.singlePointOfFailure === true
      ? 'there is a single point of failure: a sub-contract whose failure alone breaks the top requirement'
      : input.singlePointOfFailure === false
        ? 'no single point of failure: every order-1 check was decided and none of them broke the top requirement'
        : 'nothing is claimed about single points of failure: an order-1 check was not decided, and a ' +
          'component that was not checked is not a component that was shown harmless';
  return (
    `${head}. ${spof}. ${input.checks} check(s), ${decided ? 'all decided' : `${input.undecided.length} undecided`}. ` +
    `${input.census}. ${CONTRACT_LEVEL_NOTE}`
  );
}

/**
 * `refine --via composition` — do the component contracts, together with the
 * equalities the model actually states, entail the system contract?
 *
 * THE CHARTER OF THIS FILE, IN ONE LINE: **the obligations are Cimatti's, in
 * NORMAL FORM, over a γ the tool's own value semantics already honour — and an
 * unsatisfiable antecedent is never printed as "refined".** Everything below is
 * one of those three clauses made mechanical:
 *
 *  - **Normal form is load-bearing, not a flourish.** `nf(C) = ¬A ∨ G`. With
 *    bare guarantees the static check is UNSOUND under mutual support: take
 *    A₁ = G₂ = p and A₂ = G₁ = p against a system contract ⟨true, p⟩. Both
 *    bare-guarantee obligations pass, and yet an implementation with `p` false
 *    satisfies each component contract and breaks the system guarantee.
 *    `cimatti-2015` reduces to normal form precisely for the refinement checks,
 *    and so does this. `cofer-2012`'s soundness argument rests on a temporal
 *    order a static check does not have, and is not borrowed here.
 *  - **Step (0) comes before every obligation.** `check(A ∧ ⋀ nf(C′) ∧ γ)`.
 *    Sub-contracts C₁ = ⟨true, x > 10⟩ and C₂ = ⟨true, x < 5⟩ over one bind
 *    class make the antecedent of obligation (3) unsatisfiable, so (3) holds
 *    VACUOUSLY — and without step (0) the tool prints "obligation (3) proved"
 *    for an architecture whose components cannot coexist and whose system
 *    guarantee is absurd. A vacuity is `verification/contract-set-vacuous`,
 *    inconclusive, exit 2, and no flag launders it.
 *  - **γ is what the model STATES and what this tool already computes.** It is
 *    the `bind` / `BindingConnector` equalities and the directional item flows
 *    `propagateValues` carries ("carry the source value forward to the target",
 *    {@link ./connectors}), encoded as `target = source`. A γ that diverged
 *    from `propagateValues` would break the whole lane's stated gate, because
 *    `checkConstraints`, the app and every existing report already honour those
 *    flows — and an unencoded flow produces exactly the false negative §3.6's
 *    worked example shows: "assumption of `flightComputer` not discharged:
 *    witness …voltage = 0" is what you get when a flow that DOES carry the
 *    voltage was not encoded.
 *  - **A bare `connection` is not an equality.** It is listed under
 *    {@link RefinementGroup.notEncoded} with the `bind` hint, never folded in
 *    silently. `--connections-as-equalities` opts into the OCRA reading, and
 *    when it is used the fact is printed on every verdict line. The refusal is
 *    a STRICTER reading than the one published path takes — `cristoforetti-2026`
 *    §4.1 translates `connect` and `bind` alike into OCRA ports and connections
 *    — and that counter-evidence is recorded rather than buried.
 *  - **Nothing here is temporal.** This is the propositional/numeric shape, not
 *    OCRA's temporal refinement. No verdict may mention ordering or time, and
 *    none of them does.
 *
 * WHAT A "SYSTEM" AND ITS "COMPONENTS" ARE, read off the model rather than
 * guessed. A contract is attached to a part by the standard's own `satisfy`
 * edge, which {@link Contract.satisfiedBy} already reads. A contract whose
 * satisfier P transitively OWNS the satisfiers of other contracts is a system
 * contract, and those others are its components — with the nearest such
 * enclosing part winning, so a three-level tree decomposes level by level
 * rather than flattening two levels into one obligation. A contract nothing
 * satisfies, and a part with no contract-bearing parts under it, form no group:
 * a refinement question needs both halves and inventing one would answer about
 * a decomposition the file does not state.
 *
 * WHY THE WORKLIST RATHER THAN THE CLAUSES. Every relation here comes from
 * {@link obligationsOf} — the same gatherer `verify` and `consistency` read —
 * so the three commands cannot disagree about which relations a gate refused or
 * whether one is judged in SI or in the magnitudes the file stores. The only
 * relations built here are γ's, and they are gated through the SAME
 * {@link gateRelation} a `bind` axiom goes through, with the `identity`
 * exemption a binding earns (it states that two features denote one quantity,
 * so it converts across an affine map rather than being refused on one).
 *
 * The backend is passed IN, exactly as {@link ./consistency} and
 * {@link ./engines/smt} take it: whether a solver exists is decided once, in
 * `src/api/verification.ts`, and an absent solver is `verification/tool-absent`
 * rather than a fallback to anything.
 */

import { type ElementId, type ElementRecord, type Model } from '@core/index';
import {
  bindingEquivalenceClasses,
  connectorEndsOf,
  isBindingEdge,
  isConnector,
  itemFlowsOf,
} from './connectors';
import {
  contractsOf,
  gateRelation,
  isUserModelElement,
  type Contract,
  type ContractRef,
  type ContractSubject,
  type ContractVariable,
  type Encodable,
  type Fragment,
  type Refusal,
  type RefusalReason,
  type VarSort,
} from './contracts';
import { evaluate, type ExprNode } from './expr';
import { obligationsOf, type Obligation } from './obligations';
import { NO_MARKERS } from './relations';
import {
  encodeRelation,
  encodeScript,
  encodeVariables,
  notTerm,
  type EncodeVariable,
  type EncodedRelation,
  type ScriptAssertion,
} from './smt/encode';
import { type CheckOutcome, type WitnessValue, type Z3Backend } from './smt/z3-bridge';
import { type DerivationMemo } from './units-eval';

/* ─────────────────────────────── the codes ───────────────────────────────── */

/** An obligation the solver refuted, with a witness. */
export const REFINEMENT_FAILED_CODE = 'verification/refinement-failed';

/**
 * A component assumption over a quantity NO connection reaches.
 *
 * The structural half of a refuted obligation (4), separated from
 * {@link REFINEMENT_FAILED_CODE} because the two have different fixes: an
 * assumption its siblings simply do not guarantee is a design problem, and one
 * over a feature no `bind` and no `flow` touches is a WIRING problem — the
 * model never said the two quantities are one.
 */
export const UNCONNECTED_ASSUMPTION_CODE = 'verification/unconnected-assumption';

/** An obligation nothing decided: a timeout, a refused clause, an empty question. */
export const REFINEMENT_UNDECIDED_CODE = 'verification/refinement-undecided';

/** Step (0): the sub-contracts, the connections and the system assumption collide. */
export const CONTRACT_SET_VACUOUS_CODE = 'verification/contract-set-vacuous';

/**
 * A `derive` or `refine` chain the file states that is NOT a refinement.
 *
 * Its own code rather than {@link REFINEMENT_FAILED_CODE}, because the fix is a
 * different one and the reader is a different person: a composition failure
 * says the parts do not add up, and this says the requirement somebody derived
 * asks for something its parent does not — either it assumes MORE than the
 * parent grants (so the derived set applies where the parent's guarantee is not
 * in force), or the children together do not entail what the parent promised.
 * Both are edits to a requirement, not to an architecture.
 */
export const DERIVATION_NOT_REFINEMENT_CODE = 'verification/derivation-not-refinement';

/** Every code this module can file, for the exit-contract tables to key on. */
export const REFINEMENT_CODES: readonly string[] = [
  REFINEMENT_FAILED_CODE,
  UNCONNECTED_ASSUMPTION_CODE,
  REFINEMENT_UNDECIDED_CODE,
  CONTRACT_SET_VACUOUS_CODE,
  DERIVATION_NOT_REFINEMENT_CODE,
];

/**
 * The hint a bare `connection` is listed under, composed HERE and nowhere else.
 *
 * §3.6 states it as a sentence a reader acts on, and a second spelling of it in
 * a renderer is how the report and the documentation come to say two different
 * things about the one refusal this command makes on purpose.
 */
export const CONNECTION_HINT =
  'a connection is not an equality; bind the attributes if they are one quantity.';

/**
 * The words every verdict line carries when the opt-in was used.
 *
 * §3.6 requires the fact to be printed on EVERY verdict line, not once in a
 * header, because a reader who scrolls to a row has been handed a different
 * claim: under the flag a bare `connect` was read as a value equality, which is
 * the OCRA reading and not this tool's default.
 */
export const CONNECTIONS_AS_EQUALITIES_NOTE =
  'bare `connect` edges were read as value equalities (`--connections-as-equalities`)';

/**
 * The metaclasses `connect` produces — the ONLY ones the opt-in may read.
 *
 * `CONNECTOR_KINDS` in {@link ./connectors} is wider on purpose: it is every
 * metaclass that carries two connected features, which is the set
 * `propagateValues` walks, and it holds `Allocation` and `InterfaceUsage`. The
 * opt-in is narrower than the walk because its own sentence
 * ({@link CONNECTIONS_AS_EQUALITIES_NOTE}) is about `connect`, §3.6's opt-in is
 * about `connect`, and `cristoforetti-2026` §4.1's counter-evidence is about
 * `connect`. Reading an `allocate` as `target == source` would state a value
 * equality no one wrote and print a sentence about `connect` edges over a file
 * that has none.
 */
const CONNECT_KINDS = new Set(['Connector', 'ConnectionUsage']);

/** Why an edge that is a connector but not a `connect` is refused even under the opt-in. */
function notAConnectHint(eClass: string): string {
  if (eClass === 'Allocation' || eClass === 'AllocationUsage') {
    return (
      'an allocation maps one element onto another for traceability and states nothing about their ' +
      'values, and it is not a bare `connect`, so `--connections-as-equalities` does not read it ' +
      'either; bind the attributes if they are one quantity.'
    );
  }
  if (eClass === 'InterfaceUsage' || eClass === 'InterfaceDefinition') {
    return (
      'an interface joins ports through connections of its own rather than equating two values, and ' +
      'it is not a bare `connect`, so `--connections-as-equalities` does not read it either; bind ' +
      'the attributes if they are one quantity.'
    );
  }
  return (
    `\`${eClass}\` is a connector but not a bare \`connect\`, and ` +
    '`--connections-as-equalities` reads only `connect`; bind the attributes if they are one quantity.'
  );
}

/* ──────────────────────────────── the shapes ─────────────────────────────── */

/** Which family of edges a refinement run reads. */
export type RefinementVia = 'composition' | 'derive' | 'refine' | 'all';

/**
 * The family ONE group was read from. `all` is a run, never a group.
 *
 * On the group rather than only on the run, because the two families answer
 * different questions over different edges and a reader handed a mixed run has
 * to be able to tell which of them a row is about: a composition group is about
 * the parts of a system, and a derivation group is about a requirement somebody
 * wrote down from another requirement.
 */
export type RefinementFamily = 'composition' | 'derive' | 'refine';

/** How a refinement run is narrowed, bounded and told what to encode. */
export interface RefinementOptions {
  /** The solver. Absence is decided by the caller, never here. */
  backend: Z3Backend;
  /** Only the decomposition at this element: a system contract, or the part it is about. */
  elementId?: ElementId;
  /** Which family of edges to read: composition, derivation, refinement, or all three. */
  via?: RefinementVia;
  /** Read a bare `connect` as a value equality — the OCRA reading, opt-in. */
  connectionsAsEqualities?: boolean;
  /** The per-check budget in ms. Every check in this lane is bounded. */
  timeoutMs?: number;
}

/** One relation nothing asserted, with the gate that refused it. */
export interface RefusedClause {
  id: ElementId;
  qualifiedName: string;
  expression: string;
  reason: RefusalReason;
  detail: string;
  /** The contract it belongs to, or `null` for a γ edge. */
  contract: string | null;
}

/** What one γ edge IS: an equality the model states, and which construct stated it. */
export type GammaKind = 'bind' | 'flow' | 'connection';

/** One equality γ asserts, named the way a verdict line names it. */
export interface GammaEdge {
  kind: GammaKind;
  id: ElementId;
  qualifiedName: string;
  /** `left == right`, in qualified names — the relation as it is asserted. */
  expression: string;
  left: string;
  right: string;
}

/**
 * A connector this run refused to read as an equality.
 *
 * Listed rather than dropped, and counted on every verdict line: a connection
 * that disappears from a refinement question reads as one that carried the
 * value it does not carry.
 */
export interface UnencodedConnection {
  id: ElementId;
  qualifiedName: string;
  eClass: string;
  /** The connected features, by qualified name. */
  ends: string[];
  /** The sentence §3.6 requires beside it. */
  hint: string;
}

/** Which of Cimatti's two obligations a row is. */
export type RefinementObligationKind = 'composition' | 'assumption';

/** What one obligation came to. */
export type ObligationOutcome =
  | 'proved'
  | 'refuted'
  | 'undecided'
  /** The component assumes nothing, so there is no (4) to discharge. */
  | 'no-assumption';

/** One of Cimatti's obligations, and what the solver made of it. */
export interface RefinementObligation {
  kind: RefinementObligationKind;
  /** The component obligation (4) is about; `null` for obligation (3). */
  component: ContractRef | null;
  /** The part that component's contract is satisfied by, when there is one. */
  part: ContractRef | null;
  outcome: ObligationOutcome;
  /** The `verification/*` code, for a row that is not `proved`. */
  code: string | null;
  /** The sentence a person reads. It always carries the γ census. */
  detail: string;
  /** The counterexample, for `refuted` and empty otherwise. */
  witness: WitnessValue[];
  /** Was every asserted relation re-read as true at that point, in process? */
  witnessConfirmed: boolean;
  /** How many solver checks this row cost. */
  checks: number;
}

/** What this command concluded about one decomposition. */
export type RefinementOutcome = 'refined' | 'not-refined' | 'vacuous' | 'inconclusive';

/** One system contract, its components, and what came of the obligations. */
export interface RefinementGroup {
  /** Which family of edges this group was read from. */
  via: RefinementFamily;
  /** The system contract C = ⟨A, G⟩ — or, `--via derive|refine`, the parent requirement. */
  system: ContractRef;
  /** The `<R-PWR-000>` short name of the system contract, or `''`. */
  shortId: string;
  subject: ContractSubject | null;
  /**
   * The part the system contract is satisfied by.
   *
   * `null` for a DERIVATION group, and that is not an omission: a `derive` edge
   * joins two requirements and says nothing about who satisfies either of them,
   * so naming a part there would attribute the answer to an architecture the
   * edge never mentioned.
   */
  part: ContractRef | null;
  /** The sub-contracts C′, each with the part that satisfies it. */
  components: Array<{ contract: ContractRef; shortId: string; part: ContractRef | null }>;
  outcome: RefinementOutcome;
  /** The `verification/*` code, for a group that is not `refined`. */
  code: string | null;
  /** The sentence a person reads. It always carries the γ census and the mode. */
  detail: string;
  obligations: RefinementObligation[];
  /** The equalities γ asserted, in the order they were read. */
  gamma: GammaEdge[];
  /** Connectors nothing read as an equality, each with the `bind` hint. */
  notEncoded: UnencodedConnection[];
  /** Relations of this group's contracts that nothing asserted. */
  refused: RefusedClause[];
  /** The unsat core of step (0), when step (0) answered unsat. */
  vacuityCore: string[];
  /** The plan's two-word fragment vocabulary, over the scripts this group ran. */
  fragment: Fragment;
  /** The `set-logic` the last script actually declared. `''` when none ran. */
  logic: string;
  /** How many solver checks this group cost, step (0) included. */
  checks: number;
}

/** What one run came to. */
export interface RefinementResult {
  groups: RefinementGroup[];
  via: RefinementVia;
  /** Was the OCRA reading of a bare `connect` opted into? */
  connectionsAsEqualities: boolean;
  /** How many `bind` equalities γ asserted, over the whole run. */
  bindEqualities: number;
  /** How many item flows γ asserted, over the whole run. */
  itemFlows: number;
  /** How many bare connections γ asserted, under the opt-in only. */
  connectionEqualities: number;
  /** Every connector nothing read as an equality, each listed ONCE. */
  notEncoded: UnencodedConnection[];
  /** Every relation nothing asserted, over the whole run, each listed ONCE. */
  refused: RefusedClause[];
  /** How many contracts were considered at all. */
  contracts: number;
  /**
   * `derive`/`refine` edges whose other end states no contract this lane reads.
   *
   * Counted so that "this model states no chain at all" is a sentence about the
   * file rather than about what this lane could group.
   */
  unreadEdges: number;
  /** Total solver checks. */
  checks: number;
  /** The per-check budget every check above ran under. */
  timeoutMs: number | undefined;
}

/* ────────────────────────── encoding one relation ────────────────────────── */

/**
 * The part of a worklist row this module encodes.
 *
 * A structural type rather than {@link Obligation} itself, because two of this
 * command's relations are not worklist rows at all: a γ item flow is a
 * synthetic `target == source` over two element ids, and it must go through the
 * SAME gates an author's `==` goes through or γ would assert something the
 * numeric surface refuses.
 */
interface RelationRow {
  id: ElementId;
  qualifiedName: string;
  expression: string;
  node: ExprNode | null;
  vars: ContractVariable[];
  sortPerVar: Record<string, VarSort>;
  scaled: boolean;
  encodable: Encodable;
}

/** One row, encoded under its own scale decision. */
interface EncodedRow {
  row: RelationRow;
  /** `undefined` when the row could not be encoded — the reason is beside it. */
  encoded?: EncodedRelation;
  vars: EncodeVariable[];
  refusal?: Refusal;
}

/** A worklist row as this module reads it. */
function rowOf(o: Obligation): RelationRow {
  return {
    id: o.element.id,
    qualifiedName: o.element.qualifiedName,
    expression: o.expression,
    node: o.node,
    vars: o.vars,
    sortPerVar: o.sortPerVar,
    scaled: o.scaled,
    encodable: o.encodable,
  };
}

/**
 * Encode one row under its OWN scale decision.
 *
 * The same three lines `judgeBySmt` and `checkConsistency` run, for the same
 * reason: a relation the gates left in raw magnitudes (`range = 5.0 [km]`
 * against a bare `<= 10.0`) is read in kilometres by every surface of this
 * tool, and an encoder that scaled it because it COULD would report
 * `5000 <= 10`. `row.scaled` is the gates' own answer and it is what is passed;
 * nothing here re-derives it.
 *
 * NOTHING IS FREED AND NOTHING IS PINNED. A refinement obligation is a claim
 * about every implementation the contracts admit, so the model's own feature
 * values are not axioms of it — Cimatti's (3) and (4) quantify over the
 * component behaviours, not over one design point. That is why no free set is
 * threaded through here and why `--free` has no meaning for this command.
 */
function encodeRow(row: RelationRow): EncodedRow {
  const vars = encodeVariables(row.vars, row.sortPerVar, { scaled: row.scaled });
  if (row.node === null || row.encodable !== true) {
    return {
      row,
      vars,
      refusal:
        row.encodable === true
          ? { reason: 'unparseable', detail: 'the relation has no readable body' }
          : row.encodable,
    };
  }
  const encoded = encodeRelation(row.node, vars);
  return encoded.ok ? { row, vars, encoded } : { row, vars, refusal: encoded.refusal };
}

/** `(and …)` over the terms that are actually there, or `null` for none. */
function conjunction(terms: readonly string[]): string | null {
  if (terms.length === 0) return null;
  if (terms.length === 1) return terms[0];
  return `(and ${terms.join(' ')})`;
}

/**
 * Everything one encoded row asserts: its relation, and the guards its encoding
 * added.
 *
 * A `≠ 0` guard is an ENCODING assumption rather than a fact the model states,
 * and it travels with the relation that obliged it — dropping the relation and
 * keeping its guard would assert something about a divisor nothing divides by.
 */
function termsOf(row: EncodedRow): string[] {
  if (!row.encoded) return [];
  return [row.encoded.term, ...row.encoded.sideConditions.map((s) => s.term)];
}

/** A refused row, in the shape the report lists it under. */
function refusalOf(row: EncodedRow, contract: string | null): RefusedClause {
  return {
    id: row.row.id,
    qualifiedName: row.row.qualifiedName,
    expression: row.row.expression,
    reason: row.refusal?.reason ?? 'unparseable',
    detail: row.refusal?.detail ?? 'the relation was not encoded',
    contract,
  };
}

/* ─────────────────────────── one contract, encoded ───────────────────────── */

/**
 * One contract in normal form, with everything a report has to say about it.
 *
 * `nf` is `null` for the truth: a contract with no encoded guarantee is
 * `¬A ∨ ⊤`, which is ⊤ whatever A says, and asserting it would put a tautology
 * into every script for nothing.
 */
interface EncodedContract {
  contract: Contract;
  part: ContractRef | null;
  assumptions: EncodedRow[];
  guarantees: EncodedRow[];
  refused: RefusedClause[];
  /** `nf(C) = ¬A ∨ G`, or `null` when it is ⊤. */
  nf: string | null;
  /** `A`, or `null` when the contract states no assumption at all. */
  antecedent: string | null;
  /** Did a gate refuse a clause of this contract? */
  hasRefusal: boolean;
  /**
   * Is some `assume` clause of this contract missing from `A`?
   *
   * True when a gate refused one, and true when the worklist produced no row
   * for one at all — the two are the same fact for every purpose here: `A` as
   * built is a PROPER SUBSET of the conjunction the file states, and every use
   * of this contract has to be told so. See {@link encodeContract} for why the
   * direction is fatal rather than merely conservative.
   */
  hasRefusedAssumption: boolean;
  vars: EncodeVariable[];
  nonlinear: boolean;
  syntacticNonlinear: boolean;
}

/**
 * Read one contract's clauses off the worklist and put it in normal form.
 *
 * A REFUSED CONJUNCT IS DROPPED AND REPORTED, and WHICH HALF OF THE CONTRACT it
 * came from decides whether that is safe — the two halves of `nf(C) = ¬A ∨ G`
 * do not move in the same direction, and reading them as if they did is how a
 * missing relation buys a proof:
 *
 *  - **A dropped conjunct of G weakens `nf(C)`.** `¬A ∨ (g₁ ∧ g₂)` entails
 *    `¬A ∨ g₁`, so as a PREMISE the smaller form is implied by the real one and
 *    a proof obtained under it is still a proof.
 *  - **A dropped conjunct of A STRENGTHENS `nf(C)`.** `¬(a₁ ∧ a₂)` is
 *    `¬a₁ ∨ ¬a₂`, and dropping `a₂` leaves `¬a₁`, which entails it rather than
 *    following from it. So `¬a₁ ∨ G` is STRONGER than the normal form the file
 *    states, and asserting it as a premise asserts an axiom the model does not
 *    contain. In the limit — every `assume` refused — `antecedent` is `null`
 *    and `nf` collapses to `G`, i.e. "this component promises its guarantee
 *    unconditionally", which is precisely what the file did NOT say.
 *
 * So {@link hasRefusedAssumption} is recorded here and is fatal downstream:
 * {@link judgeGroup} keeps such a contract OUT of the premise set (the only
 * sound premise for a normal form with an unknown conjunct of A is ⊤) and files
 * its own obligation (4) as undecided, which stands the whole group down.
 *
 * As a GOAL any refused conjunct is fatal in both halves — a weaker `nf(C)` is
 * easier to entail and a weaker `A_U` is easier to discharge — so a system
 * contract with any refused clause is never proved here, and neither is the
 * obligation (4) of a component whose `A_U` lost one. Both facts are on the
 * group, so a reader is never left to infer which of them they are holding.
 */
function encodeContract(
  contract: Contract,
  part: ContractRef | null,
  rows: ReadonlyMap<ElementId, EncodedRow[]>,
): EncodedContract {
  const clauses = rows.get(contract.id) ?? [];
  const assumptionIds = new Set(contract.assumptions.map((a) => a.id));
  const assumptions = clauses.filter((c) => assumptionIds.has(c.row.id));
  const guarantees = clauses.filter((c) => !assumptionIds.has(c.row.id));
  const refused: RefusedClause[] = [];
  for (const c of clauses) if (!c.encoded) refused.push(refusalOf(c, contract.qualifiedName));

  const antecedent = conjunction(assumptions.flatMap(termsOf));
  const consequent = conjunction(guarantees.flatMap(termsOf));
  const nf =
    consequent === null
      ? null
      : antecedent === null
        ? consequent
        : `(or ${notTerm(antecedent)} ${consequent})`;

  const vars: EncodeVariable[] = [];
  const seen = new Set<string>();
  for (const c of clauses) {
    for (const v of c.vars) {
      if (seen.has(v.qualifiedName)) continue;
      seen.add(v.qualifiedName);
      vars.push(v);
    }
  }
  return {
    contract,
    part,
    assumptions,
    guarantees,
    refused,
    nf,
    antecedent,
    hasRefusal: refused.length > 0,
    // Against the SOURCE clause count, not against `antecedent === null`: an
    // `assume` the worklist produced no row for at all is missing from `A` just
    // as surely as one a gate refused, and the difference is invisible here.
    hasRefusedAssumption:
      assumptions.filter((a) => a.encoded).length !== contract.assumptions.length,
    vars,
    nonlinear: clauses.some((c) => c.encoded?.nonlinear === true),
    syntacticNonlinear: clauses.some((c) => c.encoded?.syntacticNonlinear === true),
  };
}

/* ─────────────────────────────────── γ ───────────────────────────────────── */

/** One γ edge, encoded, with the reading a report prints beside it. */
interface EncodedGamma {
  edge: GammaEdge;
  row: EncodedRow;
}

/**
 * A synthetic equality over two features, gated exactly as a `bind` axiom is.
 *
 * `identity` is passed for the same reason `bindAxiom` passes it: an equality
 * that STATES two features denote one quantity converts across an affine map
 * rather than being refused on one, where an author's `==` — which publishes a
 * verdict — does not. A γ edge is the first kind, always.
 */
function equalityRow(
  model: Model,
  el: ElementRecord,
  left: ElementId,
  right: ElementId,
  memo: DerivationMemo,
): { row: RelationRow; left: string; right: string } | undefined {
  if (!model.has(left) || !model.has(right) || left === right) return undefined;
  const nameToId = new Map<string, ElementId>([
    ['__l', left],
    ['__r', right],
  ]);
  const node: ExprNode = {
    kind: 'binary',
    op: '==',
    left: { kind: 'ref', path: ['__l'] },
    right: { kind: 'ref', path: ['__r'] },
  };
  const leftName = model.qualifiedName(left);
  const rightName = model.qualifiedName(right);
  const expression = `${leftName} == ${rightName}`;
  const reading = gateRelation(model, node, nameToId, NO_MARKERS, false, memo, true, expression);
  return {
    row: {
      id: el.id,
      qualifiedName: model.qualifiedName(el.id),
      expression,
      node: reading.node,
      vars: reading.variables,
      sortPerVar: reading.sortPerVar,
      scaled: reading.scale !== undefined,
      encodable: reading.encodable,
    },
    left: leftName,
    right: rightName,
  };
}

/**
 * The γ edges one decomposition can reach, by shared symbols.
 *
 * The same closure `reachableAxioms` computes in {@link ./consistency}, and
 * sound for the same reason: an equality that shares no variable with a group's
 * contracts, directly or transitively, factorises — a satisfying assignment for
 * one can always be pasted onto a satisfying assignment for the other — so
 * carrying it changes neither satisfiability nor entailment. What it DOES change
 * is the census a reader is shown: "over 6 bind equalities" printed on a
 * decomposition that used one of them is a figure about the file rather than
 * about the answer, and this command's whole verdict turns on which equalities
 * were asserted.
 */
function reachableGamma(
  gamma: readonly EncodedGamma[],
  seeds: readonly string[],
): EncodedGamma[] {
  const reached = new Set<string>(seeds);
  const kept: EncodedGamma[] = [];
  const taken = new Set<EncodedGamma>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of gamma) {
      if (taken.has(g)) continue;
      const reads = g.row.encoded?.reads ?? [];
      if (!reads.some((r) => reached.has(r))) continue;
      taken.add(g);
      kept.push(g);
      for (const r of reads) reached.add(r);
      grew = true;
    }
  }
  return kept;
}

/** The γ one decomposition asserts, and the features it joins. */
interface GroupGamma {
  rows: EncodedGamma[];
  edges: GammaEdge[];
  /** Every feature an asserted equality of THIS group touches. */
  connected: Set<string>;
}

/** The γ edges these contracts reach, with the census that goes with them. */
function gammaFor(
  gamma: readonly EncodedGamma[],
  contracts: readonly EncodedContract[],
): GroupGamma {
  const seeds: string[] = [];
  for (const c of contracts) for (const v of c.vars) seeds.push(v.qualifiedName);
  const rows = reachableGamma(gamma, seeds);
  const connected = new Set<string>();
  for (const r of rows) for (const symbol of r.row.encoded?.reads ?? []) connected.add(symbol);
  return { rows, edges: rows.map((r) => r.edge), connected };
}

/** The whole connection assertion of a model, plus what it refused to read. */
interface Gamma {
  encoded: EncodedGamma[];
  notEncoded: UnencodedConnection[];
  refused: RefusedClause[];
  /** Every feature an ENCODED γ edge touches, by qualified name. */
  connected: Set<string>;
}

/**
 * Build γ: the `bind` equalities, the directional item flows, and — under the
 * opt-in only — the bare connections.
 *
 * THE BIND HALF IS TAKEN OFF THE WORKLIST rather than rebuilt. `obligationsOf`
 * already files one gated `axiom` row per binding edge, so reading them here is
 * what keeps γ and the axiom set of `verify` from ever disagreeing about which
 * equality a gate refused. {@link bindingEquivalenceClasses} is read beside
 * them for what the rows cannot answer — which features the model has joined
 * into ONE quantity, transitively — because that is the question
 * "is this assumption over something no connection reaches" is asked against,
 * and an edge list answers it only one hop at a time.
 *
 * THE FLOW HALF IS `target = source`, which is exactly step (b) of
 * {@link propagateValues}: "carry the source value forward to the target". A
 * flow is directional and this encoding is symmetric, and that is a deliberate
 * over-approximation of a value that has already arrived — the static question
 * this command answers has no ordering in it, so there is no moment at which
 * the target does not yet hold what the source sent.
 */
function buildGamma(
  model: Model,
  worklist: readonly Obligation[],
  connectionsAsEqualities: boolean,
): Gamma {
  const memo: DerivationMemo = new Map();
  const encoded: EncodedGamma[] = [];
  const refused: RefusedClause[] = [];
  const notEncoded: UnencodedConnection[] = [];
  const connected = new Set<string>();

  const take = (edge: GammaEdge, row: EncodedRow): void => {
    if (!row.encoded) {
      refused.push(refusalOf(row, null));
      return;
    }
    encoded.push({ edge, row });
    // From the symbols the encoding actually READ, not from the endpoint names
    // beside them: what discharges an assumption is the equality that was
    // asserted, and an endpoint an encoding never reached is not connected by it.
    for (const symbol of row.encoded.reads) connected.add(symbol);
  };

  // (a) `bind` / BindingConnector — off the worklist, already gated.
  const bindEdges = new Set<ElementId>();
  for (const o of worklist) {
    if (o.role !== 'axiom' || o.source !== 'bind') continue;
    bindEdges.add(o.element.id);
    const el = model.get(o.element.id);
    const ends = el ? connectorEndsOf(model, el.id) : [];
    const row = encodeRow(rowOf(o));
    take(
      {
        kind: 'bind',
        id: o.element.id,
        qualifiedName: o.element.qualifiedName,
        expression: o.expression,
        left: ends[0] !== undefined ? model.qualifiedName(ends[0]) : '',
        right: ends[1] !== undefined ? model.qualifiedName(ends[1]) : '',
      },
      row,
    );
  }
  // Every member of a binding class denotes one quantity, transitively, so the
  // whole class counts as connected once any of its edges encoded.
  for (const members of bindingEquivalenceClasses(model)) {
    const names = members.map((m) => model.qualifiedName(m));
    if (!names.some((n) => connected.has(n))) continue;
    for (const n of names) connected.add(n);
  }

  // (b) The item flows `propagateValues` carries, as `target = source`.
  const flowEdges = new Set<ElementId>();
  for (const flow of itemFlowsOf(model)) {
    const el = model.get(flow.id);
    if (!el || !isUserModelElement(model, el)) continue;
    flowEdges.add(flow.id);
    if (flow.source === undefined || flow.target === undefined) continue;
    const built = equalityRow(model, el, flow.target, flow.source, memo);
    if (!built) continue;
    take(
      {
        kind: 'flow',
        id: flow.id,
        qualifiedName: model.qualifiedName(flow.id),
        expression: built.row.expression,
        left: built.left,
        right: built.right,
      },
      encodeRow(built.row),
    );
  }

  // (c) Everything else that is a connector: a bare `connection`, which is NOT
  //     an equality unless the reader opted into the OCRA reading.
  for (const el of model.all()) {
    if (!isUserModelElement(model, el) || !isConnector(el)) continue;
    if (isBindingEdge(el) || bindEdges.has(el.id) || flowEdges.has(el.id)) continue;
    const ends = connectorEndsOf(model, el.id);
    const names = ends.map((e) => model.qualifiedName(e));
    // THE OPT-IN IS ABOUT `connect`, AND ONLY ABOUT `connect`. `CONNECTOR_KINDS`
    // is deliberately wider than that — it is the set of metaclasses that carry
    // two connected features, which is what `propagateValues` walks — and it
    // holds `Allocation` and `InterfaceUsage` too. Neither is a `connect`: an
    // allocation is a traceability mapping from one element onto another and an
    // interface joins ports through connections of its own, so reading either
    // as `target == source` would assert a value equality nobody wrote, under a
    // flag whose own sentence says "bare `connect` edges were read as value
    // equalities" — a false statement about a file that contains no `connect`.
    // §3.6's opt-in and `cristoforetti-2026` §4.1 are both about `connect`.
    if (!connectionsAsEqualities || !CONNECT_KINDS.has(el.eClass)) {
      notEncoded.push({
        id: el.id,
        qualifiedName: model.qualifiedName(el.id),
        eClass: el.eClass,
        ends: names,
        // The hint names WHAT WAS REFUSED, with or without the flag: "a
        // connection is not an equality" over an `allocate` describes something
        // the file does not contain, and the reader is left to guess which
        // edge the sentence is about.
        hint: CONNECT_KINDS.has(el.eClass) ? CONNECTION_HINT : notAConnectHint(el.eClass),
      });
      continue;
    }
    // The opt-in chains the ends: `connect a to b to c` is one quantity under
    // the OCRA reading, and a chain is what says so with n−1 equalities.
    let any = false;
    for (let i = 1; i < ends.length; i += 1) {
      const built = equalityRow(model, el, ends[i], ends[i - 1], memo);
      if (!built) continue;
      any = true;
      take(
        {
          kind: 'connection',
          id: el.id,
          qualifiedName: model.qualifiedName(el.id),
          expression: built.row.expression,
          left: built.left,
          right: built.right,
        },
        encodeRow(built.row),
      );
    }
    if (!any) {
      notEncoded.push({
        id: el.id,
        qualifiedName: model.qualifiedName(el.id),
        eClass: el.eClass,
        ends: names,
        hint: 'the connector names fewer than two features, so there is no equality to state.',
      });
    }
  }

  return { encoded, notEncoded, refused, connected };
}

/* ────────────────────────────── the grouping ─────────────────────────────── */

/** One system contract with the components the model says decompose it. */
interface Decomposition {
  system: Contract;
  systemPart: ElementRecord;
  components: Array<{ contract: Contract; part: ElementRecord }>;
  /**
   * Every part a contract is attached to, model-wide — the same set that
   * decided which system each component belongs to, kept so
   * {@link notEncodedFor} can attribute a connector by exactly that rule.
   */
  partIds: ReadonlySet<ElementId>;
}

/**
 * The part a contract is attached to, through the standard's own `satisfy`.
 *
 * The FIRST satisfier, and only when it is the reader's own element: a contract
 * satisfied by two parts is a contract about both, and picking one of them
 * would answer about a decomposition the file does not state — so a group is
 * formed from the first and the rest are visible in `contracts`, which is the
 * report that exists to show them.
 */
function satisfierOf(model: Model, contract: Contract): ElementRecord | undefined {
  for (const ref of contract.satisfiedBy) {
    const el = model.get(ref.id);
    if (el && isUserModelElement(model, el)) return el;
  }
  return undefined;
}

/**
 * Every usage typed by each definition, so the enclosing walk can cross a TYPE.
 *
 * Built once per run rather than asked per step, because {@link Model.typesOf}
 * is a forward edge and the walk needs the reverse one.
 */
function usagesByType(model: Model): Map<ElementId, ElementId[]> {
  const index = new Map<ElementId, ElementId[]>();
  for (const el of model.all()) {
    if (!isUserModelElement(model, el)) continue;
    for (const t of model.typesOf(el.id)) {
      const list = index.get(t.id);
      if (list) list.push(el.id);
      else index.set(t.id, [el.id]);
    }
  }
  return index;
}

/**
 * The elements that enclose `id`, nearest first, ACROSS TYPES as well as owners.
 *
 * CONTAINMENT ALONE IS NOT THE ENCLOSING RELATION A SysML v2 FILE WRITES.
 * `satisfy R by Sub::leaf` names a part usage whose *owner* is the part
 * DEFINITION `Sub`, and `Sub` is never a satisfier of anything; a walk that
 * only climbed `ownerId` would stop there and the contract on `leaf` would join
 * no decomposition at all — silently, with the run still exiting 0 over the
 * level above it. The model does say where `leaf` lives: `part sub : Sub`
 * types a usage by `Sub`, so every instance of `Sub` — every usage typed by it
 * — encloses `leaf`. So the walk takes both edges, breadth-first, and
 * "nearest" is by the number of hops rather than by owner depth alone.
 *
 * The breadth-first order matters when a definition is instantiated more than
 * once: each instantiation is an equally near enclosing part, and the caller
 * takes the first contract-bearing one it meets — see {@link satisfierOf} for
 * the same choice made about a contract satisfied by several parts.
 */
function enclosingChain(
  model: Model,
  id: ElementId,
  byType: ReadonlyMap<ElementId, readonly ElementId[]>,
): ElementId[] {
  const out: ElementId[] = [];
  const seen = new Set<ElementId>([id]);
  let frontier: ElementId[] = [id];
  // Bounded by the element count: every id enters `seen` at most once.
  while (frontier.length > 0) {
    const next: ElementId[] = [];
    for (const cur of frontier) {
      const owner = model.get(cur)?.ownerId ?? null;
      const hops: ElementId[] = owner != null ? [owner] : [];
      // A definition is enclosed by the usages that instantiate it.
      for (const u of byType.get(cur) ?? []) hops.push(u);
      for (const h of hops) {
        if (seen.has(h)) continue;
        seen.add(h);
        out.push(h);
        next.push(h);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Group the contracts into decompositions: a system, and the components under it.
 *
 * The rule is enclosure of the SATISFIERS — containment, and a part usage's own
 * type ({@link enclosingChain}) — and the nearest enclosing contract-bearing
 * part wins. A three-level tree — a system, its subsystem, and the subsystem's
 * parts — therefore yields two groups, each checked against the contracts one
 * level below it, which is what Cimatti's Theorem 1 is about. Flattening it
 * would ask whether the leaves entail the top directly, an obligation the model
 * never states and one whose failure would name the wrong level.
 */
function decompositionsOf(
  model: Model,
  contracts: readonly Contract[],
  elementId: ElementId | undefined,
): Decomposition[] {
  const satisfiers = new Map<string, ElementRecord>();
  for (const c of contracts) {
    const part = satisfierOf(model, c);
    if (part) satisfiers.set(c.id, part);
  }
  const byType = usagesByType(model);
  const partIds = new Set([...satisfiers.values()].map((p) => p.id));
  const out: Decomposition[] = [];
  for (const system of contracts) {
    const systemPart = satisfiers.get(system.id);
    if (!systemPart) continue;
    const components: Decomposition['components'] = [];
    for (const candidate of contracts) {
      if (candidate.id === system.id) continue;
      const part = satisfiers.get(candidate.id);
      if (!part || part.id === systemPart.id) continue;
      // The NEAREST contract-bearing enclosing part decides which system this
      // component belongs to; anything else flattens the tree.
      const chain = enclosingChain(model, part.id, byType);
      const nearest = chain.find((a) => partIds.has(a));
      if (nearest !== systemPart.id) continue;
      components.push({ contract: candidate, part });
    }
    if (components.length === 0) continue;
    if (
      elementId !== undefined &&
      elementId !== system.id &&
      elementId !== systemPart.id &&
      !components.some((c) => c.contract.id === elementId || c.part.id === elementId)
    ) {
      continue;
    }
    out.push({ system, systemPart, components, partIds });
  }
  return out;
}

/**
 * The connectors this decomposition — and not another one in the same file — is
 * about.
 *
 * γ IS TRIMMED PER GROUP AND SO IS ITS REFUSED HALF. A verdict line that
 * printed "1 connection(s) not encoded" over a decomposition that contains no
 * connector, and then named a connector belonging to a different one, is a
 * figure about the FILE dressed as a figure about the answer — the exact
 * failure the γ trim exists against, seen from the other side. The rule is the
 * one that assigned the components: a connector belongs to the group whose
 * system part is the NEAREST contract-bearing part enclosing it, and a
 * connector with no such part belongs to no group at all and is only ever
 * reported at run level.
 */
function notEncodedFor(
  model: Model,
  all: readonly UnencodedConnection[],
  decomposition: Decomposition,
  byType: ReadonlyMap<ElementId, readonly ElementId[]>,
): UnencodedConnection[] {
  return all.filter((c) => {
    const chain = enclosingChain(model, c.id, byType);
    return chain.find((a) => decomposition.partIds.has(a)) === decomposition.systemPart.id;
  });
}

/* ───────────────────────── derivation and refinement ─────────────────────── */

/**
 * One parent requirement and the requirements the file DERIVES from it (or that
 * REFINE it), read with the orientation the mapper actually stores.
 *
 * THE ORIENTATION IS MEASURED, NOT ASSUMED, and the two families store it the
 * opposite way round — which is the whole reason this is one function with a
 * `via` rather than two copies of one rule:
 *
 *  - `derive requirement D from R;` maps to `Derive` with **source = R** (the
 *    original) and **target = D** (the derived), so `Contract.derivedFrom` on
 *    `D` names `R`. The parent is what a child POINTS AT.
 *  - `refine requirement X by Y;` maps to `Refine` with **source = Y** (the
 *    element doing the refining) and **target = X**, uniform with `satisfy`
 *    (`mapRequirementRelation`: the referenced element is the source and the
 *    requirement is the target). So `Contract.refinedBy` on `X` names `Y`, and
 *    the parent is what a child IS POINTED AT BY.
 *
 * Getting that backwards would not fail loudly: it would check the mirror
 * obligations and report "refines" for a chain written the other way up, which
 * is why the corpus pins the reversed direction as a refutation.
 */
interface Derivation {
  via: 'derive' | 'refine';
  /** R — the requirement being refined toward. */
  parent: Contract;
  /** The D's — the requirements the file writes down from it. */
  children: Contract[];
}

/**
 * Group the contracts into derivation chains, one parent at a time.
 *
 * THE EDGES THIS LANE CANNOT READ ARE COUNTED, NOT DISCARDED. A
 * `derive requirement Child from rig;` names a part on its other end, so it
 * states no obligation over two contracts and produces no group — and a run
 * that reported only the groups would then tell a reader "this model states no
 * `derive` chain at all", which is false about a file that plainly writes one.
 * They come back beside the groups so the sentence can be true.
 */
function derivationsOf(
  contracts: readonly Contract[],
  elementId: ElementId | undefined,
  via: 'derive' | 'refine',
): { groups: Derivation[]; unread: number } {
  const byId = new Map<ElementId, Contract>(contracts.map((c) => [c.id, c]));
  const out: Derivation[] = [];
  let unread = 0;
  if (via === 'derive') {
    for (const candidate of contracts) {
      for (const ref of candidate.derivedFrom) {
        if (!byId.has(ref.id) || ref.id === candidate.id) unread += 1;
      }
    }
  }
  for (const parent of contracts) {
    const children: Contract[] = [];
    if (via === 'derive') {
      // Every contract that names THIS one as what it was derived from.
      for (const candidate of contracts) {
        if (candidate.id === parent.id) continue;
        if (candidate.derivedFrom.some((r) => r.id === parent.id)) children.push(candidate);
      }
    } else {
      for (const ref of parent.refinedBy) {
        const child = byId.get(ref.id);
        // A `refine … by` whose target is not a contract at all — a part, a
        // case — states no obligation this lane can check, and inventing one
        // from an element with no `assume`/`require` would answer about a
        // contract the file does not have.
        if (child && child.id !== parent.id) children.push(child);
        else unread += 1;
      }
    }
    if (children.length === 0) continue;
    if (
      elementId !== undefined &&
      elementId !== parent.id &&
      !children.some((c) => c.id === elementId)
    ) {
      continue;
    }
    out.push({ via, parent, children });
  }
  return { groups: out, unread };
}

/**
 * Judge one derivation chain: the derived set assumes no more, and together it
 * entails what the parent promised.
 *
 * THE TWO OBLIGATIONS, from §3.6, over the measured orientation:
 *
 *  - **assumption**, per derived requirement *D*: `A_R ∧ γ ⊨ A_D`. A derived
 *    requirement that assumes MORE than its parent applies in fewer situations
 *    than the parent's guarantee is claimed in, so discharging the parent by
 *    discharging the children would leave the gap unproved. This is the row the
 *    plan's own case pins: "a derived requirement with a stronger assumption
 *    does not refine, with a witness".
 *  - **composition**: `A_R ∧ ⋀ nf(C_D) ∧ γ ⊨ G_R`. The children, in normal
 *    form, entail the parent's guarantee. Normal form for the same reason as in
 *    a composition group — with bare guarantees the check is unsound under
 *    mutual support — and `nf(C_D) = ¬A_D ∨ G_D` is the form §3.6 writes as
 *    `nf(G_D)` in shorthand: the conjunct is the child CONTRACT's normal form,
 *    which is what makes the pair of obligations sound together.
 *
 * Step (0) runs first here too. A parent assumption that contradicts the
 * children's normal forms entails both obligations for free, and "derivation
 * refines" over a contradiction is the same false verdict §3.6's step (0)
 * exists to prevent one level down.
 */
async function judgeDerivation(input: {
  model: Model;
  derivation: Derivation;
  prepared: Prepared;
  connectionsAsEqualities: boolean;
  backend: Z3Backend;
  timeoutMs: number | undefined;
}): Promise<RefinementGroup> {
  const { derivation, prepared, connectionsAsEqualities } = input;
  const parent = encodeContract(derivation.parent, null, prepared.rows);
  const children = derivation.children.map((c) => encodeContract(c, null, prepared.rows));
  const groupGamma = gammaFor(prepared.gamma.encoded, [parent, ...children]);
  const gammaEdges = groupGamma.edges;
  // A DERIVATION IS NOT ABOUT WIRING. `notEncoded` is attributed to the
  // decomposition a connector sits in, and a `derive` edge sits in no
  // decomposition at all — so this group lists none rather than borrowing
  // another group's connectors to pad its census.
  const census = `${gammaSentence(gammaEdges, [], connectionsAsEqualities)} (a derivation chain, not a wiring question)`;
  const word = derivation.via === 'derive' ? 'derived' : 'refining';
  const refused = [
    ...parent.refused,
    ...children.flatMap((c) => c.refused),
    ...prepared.gamma.refused,
  ];

  const base = {
    via: derivation.via,
    system: contractRef(derivation.parent),
    shortId: derivation.parent.shortId,
    subject: derivation.parent.subject,
    part: null,
    components: derivation.children.map((c) => ({
      contract: contractRef(c),
      shortId: c.shortId,
      part: null,
    })),
    obligations: [] as RefinementObligation[],
    gamma: gammaEdges,
    notEncoded: [] as UnencodedConnection[],
    refused,
    vacuityCore: [] as string[],
    fragment: 'qf-lra' as Fragment,
    logic: '',
    checks: 0,
  };

  // A PARENT WITH A REFUSED CLAUSE IS NOT THE PARENT THE FILE STATES, in either
  // half: `G_R` is the goal of the composition obligation, where a dropped
  // conjunct weakens it, and `A_R` is asserted as a plain premise of both
  // obligations, where a dropped conjunct weakens the premise set and can
  // produce a REFUTATION the file does not deserve. One is a proof bought
  // cheaply and the other is a false alarm, so nothing is claimed either way.
  if (parent.hasRefusal || parent.nf === null) {
    return {
      ...base,
      outcome: 'inconclusive',
      code: REFINEMENT_UNDECIDED_CODE,
      detail:
        (parent.nf === null
          ? `\`${derivation.parent.qualifiedName}\` states no guarantee this lane encodes, so there is ` +
            `nothing for its ${word} requirement(s) to entail`
          : `a gate refused ${parent.refused.length} clause(s) of \`${derivation.parent.qualifiedName}\`, ` +
            `and neither half of a derivation obligation survives a missing conjunct — the goal would be ` +
            `weaker and the premise set would be too, so nothing is claimed ` +
            `(${parent.refused.map((r) => `${r.qualifiedName}: ${r.reason}`).join('; ')})`) +
        `. ${census}`,
    };
  }

  // A CHILD WHOSE `A_D` LOST A CONJUNCT IS NOT A PREMISE — and the test is the
  // one {@link judgeGroup} applies to a component, for the same reason and with
  // the same asymmetry. Reading it as "any refusal" instead cost a real
  // verdict: a child that lost a conjunct of its GUARANTEE has an `nf` that is
  // WEAKER than the file's ({@link encodeContract}: `¬A ∨ (g₁ ∧ g₂)` entails
  // `¬A ∨ g₁`), so asserting the smaller form proves obligation (2) from LESS
  // than the model states — sound, and merely harder. Withholding it instead
  // shrank the premise set below the file's and published a REFUTATION at exit
  // 1, with a confirmed witness at a design the withheld child forbids. A
  // refused `assume` is the other direction and is still fatal: `¬a₁` entails
  // `¬a₁ ∨ ¬a₂`, so the smaller form is an axiom the model does not contain.
  const withheld = children.filter((c) => c.hasRefusedAssumption);
  const premises = children
    .filter((c) => !c.hasRefusedAssumption)
    .map((c) => ({ contract: c, term: c.nf }))
    .filter((p): p is { contract: EncodedContract; term: string } => p.term !== null);
  const gammaAssertions: ScriptAssertion[] = groupGamma.rows.flatMap((g) =>
    termsOf(g.row).map((t) => ({ kind: 'axiom' as const, name: g.edge.qualifiedName, term: t })),
  );
  const parentAssume: ScriptAssertion[] =
    parent.antecedent !== null
      ? [
          {
            kind: 'premise' as const,
            name: `${derivation.parent.qualifiedName}::assume`,
            term: parent.antecedent,
          },
        ]
      : [];

  const variables = [
    ...parent.vars,
    ...children.flatMap((c) => c.vars),
    ...groupGamma.rows.flatMap((g) => g.row.vars),
  ];
  const nonlinear =
    parent.nonlinear ||
    children.some((c) => c.nonlinear) ||
    groupGamma.rows.some((g) => g.row.encoded?.nonlinear === true);
  const syntacticNonlinear =
    parent.syntacticNonlinear ||
    children.some((c) => c.syntacticNonlinear) ||
    groupGamma.rows.some((g) => g.row.encoded?.syntacticNonlinear === true);

  let checks = 0;
  let logic = '';
  let fragment: Fragment = 'qf-lra';
  const run = async (assertions: ScriptAssertion[]): Promise<CheckOutcome> => {
    const script = scriptOf(assertions, variables, { nonlinear, syntacticNonlinear });
    logic = script.logic;
    fragment = script.fragment;
    checks += 1;
    return input.backend.check(script.text, {
      timeoutMs: input.timeoutMs,
      variables: script.symbols,
    });
  };

  // ── step (0): can the parent assumption and the children hold together? ────
  const zero = await run([
    ...parentAssume,
    ...premises.map((p) => ({
      kind: 'premise' as const,
      name: p.contract.contract.qualifiedName,
      term: p.term,
    })),
    ...gammaAssertions,
  ]);
  if (zero.status === 'unsat') {
    return {
      ...base,
      checks,
      logic,
      fragment,
      outcome: 'vacuous',
      code: CONTRACT_SET_VACUOUS_CODE,
      vacuityCore: [...zero.core],
      detail:
        `vacuous: \`${derivation.parent.qualifiedName}\`’s assumption and the ${word} requirement(s) ` +
        `cannot hold together (core ${zero.core.length > 0 ? zero.core.join(', ') : 'the solver named none'}) — ` +
        `every obligation over them holds for nothing, so none is claimed. ${census}`,
    };
  }
  if (zero.status !== 'sat') {
    return {
      ...base,
      checks,
      logic,
      fragment,
      outcome: 'inconclusive',
      code: zero.status === 'unknown' ? 'verification/timeout' : 'verification/not-evaluable',
      detail:
        zero.status === 'unknown'
          ? `the solver was asked whether this chain can hold together at all and did not answer ` +
            `(${zero.reason || 'unknown'} after ${zero.timeoutMs} ms). Nothing is claimed. ${census}`
          : `the solver refused the script this tool produced: ${zero.reason}. That is a defect in this ` +
            `tool, not in the model. ${census}`,
    };
  }

  const obligations: RefinementObligation[] = [];

  // ── the assumption obligation, per derived requirement: A_R ∧ γ ⊨ A_D ──────
  for (const child of children) {
    // THE REFUSAL TEST READS THE `assume` HALF ONLY, exactly as obligation (4)
    // does in {@link judgeGroup}: `A_D` is the GOAL of this row, so a refused
    // `assume` leaves a goal weaker than the file's — easier to discharge, the
    // one direction in which a missing relation buys a verdict — while a
    // refused `require` leaves `A_D` untouched and this row answerable.
    if (child.hasRefusedAssumption) {
      obligations.push({
        kind: 'assumption',
        component: contractRef(child.contract),
        part: null,
        outcome: 'undecided',
        code: REFINEMENT_UNDECIDED_CODE,
        detail:
          `${child.contract.assumptions.length} \`assume\` clause(s) of \`${child.contract.qualifiedName}\` ` +
          `were stated and ${child.assumptions.filter((a) => a.encoded).length} of them encoded, so ` +
          `\`A_D\` as built is not the assumption the file states: dropping a conjunct of it weakens the ` +
          `goal of this row, and dropping one from its \`nf\` STRENGTHENS a premise of the composition ` +
          `row. Nothing is claimed about it and its normal form was not asserted. ${census}`,
        witness: [],
        witnessConfirmed: false,
        checks: 0,
      });
      continue;
    }
    if (child.antecedent === null) {
      obligations.push({
        kind: 'assumption',
        component: contractRef(child.contract),
        part: null,
        outcome: 'no-assumption',
        code: null,
        detail:
          `\`${child.contract.qualifiedName}\` assumes nothing, so it cannot assume more than ` +
          `\`${derivation.parent.qualifiedName}\` does and there is no obligation to discharge. ${census}`,
        witness: [],
        witnessConfirmed: false,
        checks: 0,
      });
      continue;
    }
    const before = checks;
    const outcome = await run([
      ...parentAssume,
      ...gammaAssertions,
      {
        kind: 'goal',
        name: `${child.contract.qualifiedName}::assume`,
        term: notTerm(child.antecedent),
      },
    ]);
    obligations.push(
      obligationRow({
        kind: 'assumption',
        component: contractRef(child.contract),
        part: null,
        outcome,
        checks: checks - before,
        census,
        proved:
          `\`${child.contract.qualifiedName}\` assumes no more than \`${derivation.parent.qualifiedName}\` ` +
          `does (negation unsat), ${census}`,
        refuted:
          `\`${child.contract.qualifiedName}\` assumes MORE than \`${derivation.parent.qualifiedName}\` ` +
          `grants, so it applies where the parent’s guarantee is not in force`,
        code: DERIVATION_NOT_REFINEMENT_CODE,
        confirm: (values) =>
          confirmCounterexample(values, {
            assumed: parent.assumptions,
            premises: [],
            gamma: groupGamma.rows.map((g) => g.row),
            goalFalse: { antecedentOnly: true, contract: child },
          }),
      }),
    );
  }

  // ── the composition obligation: A_R ∧ ⋀ nf(C_D) ∧ γ ⊨ G_R ─────────────────
  if (premises.length === 0) {
    obligations.push({
      kind: 'composition',
      component: null,
      part: null,
      outcome: 'undecided',
      code: REFINEMENT_UNDECIDED_CODE,
      detail:
        `no ${word} requirement of this chain contributes a normal form this lane may assert, so the ` +
        `antecedent is the parent’s assumption alone — and entailing a parent’s guarantee from its own ` +
        `assumption is a claim about that requirement, not about its derivation. ${census}`,
      witness: [],
      witnessConfirmed: false,
      checks: 0,
    });
  } else {
    const before = checks;
    const outcome = await run([
      ...parentAssume,
      ...premises.map((p) => ({
        kind: 'premise' as const,
        name: p.contract.contract.qualifiedName,
        term: p.term,
      })),
      ...gammaAssertions,
      {
        kind: 'goal',
        name: `${derivation.parent.qualifiedName}::require`,
        term: notTerm(conjunction(parent.guarantees.flatMap(termsOf)) ?? 'true'),
      },
    ]);
    obligations.push(
      obligationRow({
        kind: 'composition',
        component: null,
        part: null,
        outcome,
        checks: checks - before,
        census,
        proved:
          `the ${premises.length} ${word} requirement(s) together entail ` +
          `\`${derivation.parent.qualifiedName}\`’s guarantee (negation unsat), ${census} — in normal form ` +
          `\`nf(C) = ¬A ∨ G\`, so mutual support cannot buy the verdict`,
        refuted:
          `the ${word} requirement(s) do NOT entail \`${derivation.parent.qualifiedName}\`’s guarantee: ` +
          `a design satisfying every one of them breaks the requirement they were written from`,
        code: DERIVATION_NOT_REFINEMENT_CODE,
        confirm: (values) =>
          confirmCounterexample(values, {
            assumed: parent.assumptions,
            premises: premises.map((p) => p.contract),
            gamma: groupGamma.rows.map((g) => g.row),
            goalFalse: { guaranteeOnly: true, contract: parent },
          }),
      }),
    );
    // A REFUTATION IS NEVER PUBLISHED OVER A PREMISE SET SMALLER THAN THE
    // FILE'S. A child withheld above lost a conjunct of its `A_D`, so its real
    // normal form is one this run never asserted — and the very clause that was
    // dropped may exclude the design point just found. A PROOF under a smaller
    // premise set stays a proof (it used less than the file states); a
    // refutation does not, so this row is downgraded rather than the group
    // being stood down wholesale. The same asymmetry {@link ./engines/smt}
    // applies to a refused axiom in reach of a goal.
    const composition = obligations[obligations.length - 1];
    if (composition.outcome === 'refuted' && withheld.length > 0) {
      obligations[obligations.length - 1] = {
        ...composition,
        outcome: 'undecided',
        code: REFINEMENT_UNDECIDED_CODE,
        detail:
          `a design point breaking \`${derivation.parent.qualifiedName}\`’s guarantee was found under a ` +
          `PARTIAL premise set: ${withheld.length} ${word} requirement(s) ` +
          `(${withheld.map((c) => c.contract.qualifiedName).join(', ')}) had an \`assume\` clause a gate ` +
          `refused and were not asserted, and the very clause that was dropped may exclude this point. ` +
          `A proof under a partial premise set would still be sound; a refutation is not. ${census}`,
      };
    }
  }

  const outcome = outcomeOf(obligations);
  return {
    ...base,
    checks,
    logic,
    fragment,
    obligations,
    outcome,
    code: groupCodeOf(outcome, obligations),
    detail: derivationDetail(outcome, obligations, derivation, premises.length, census, refused),
  };
}

/** The derivation group's sentence, which always carries the census and the family. */
function derivationDetail(
  outcome: RefinementOutcome,
  obligations: readonly RefinementObligation[],
  derivation: Derivation,
  asserted: number,
  census: string,
  refused: readonly RefusedClause[],
): string {
  const discharged = obligations.filter((o) => o.outcome === 'proved').length;
  const open = obligations.filter((o) => o.outcome === 'refuted' || o.outcome === 'undecided').length;
  const family = derivation.via === 'derive' ? 'derivation' : 'refinement';
  const head =
    outcome === 'refined'
      ? `${family} refines: ${discharged} obligation(s) proved over ${asserted} of ${derivation.children.length} ${family === 'derivation' ? 'derived' : 'refining'} requirement(s), ${census}`
      : outcome === 'not-refined'
        ? `${family} does NOT refine: ${open} obligation(s) not discharged over ${derivation.children.length} ${family === 'derivation' ? 'derived' : 'refining'} requirement(s), ${census}`
        : `${family} not decided: ${open} obligation(s) undecided over ${derivation.children.length} ${family === 'derivation' ? 'derived' : 'refining'} requirement(s), ${census}`;
  return (
    `${head}. ` +
    (refused.length === 0
      ? '0 relations refused'
      : `${refused.length} relation(s) refused by a gate and not asserted (${refused
          .map((r) => `${r.qualifiedName}: ${r.reason}`)
          .join('; ')})`) +
    '. Nothing here is about ordering or time'
  );
}

/* ──────────────────────────────── the run ────────────────────────────────── */

/** Everything a run needs before a solver is involved. */
interface Prepared {
  contracts: Contract[];
  rows: Map<ElementId, EncodedRow[]>;
  gamma: Gamma;
  worklist: Obligation[];
  /** The reverse typing index {@link enclosingChain} walks, built once. */
  byType: Map<ElementId, ElementId[]>;
}

/**
 * The pure half of a run: read the worklist, encode every clause and build γ.
 *
 * Separated from the deciding half because BOTH halves are needed even when
 * there is no solver. A tool-absent run still has to say which decompositions
 * it did not decide and over how many equalities — "0 obligation(s) on 0
 * decomposition(s)" over a file full of component contracts is a census of
 * nothing dressed as a census of the model, and it is exactly how an absent
 * solver would read as a model with no architecture in it.
 */
function prepare(model: Model, connectionsAsEqualities: boolean): Prepared {
  const worklist = obligationsOf(model);
  const rows = new Map<ElementId, EncodedRow[]>();
  for (const o of worklist) {
    const id = o.requirement?.id;
    // A row whose role is `axiom` is context even inside a requirement body
    // (`assert constraint`), and the synthetic `no-formal-clause` row is not a
    // relation at all: neither is part of what a contract ASSUMES or PROMISES,
    // which is all normal form is built from.
    if (id === undefined || o.role === 'axiom' || o.source === 'none') continue;
    const encoded = encodeRow(rowOf(o));
    const list = rows.get(id);
    if (list) list.push(encoded);
    else rows.set(id, [encoded]);
  }
  return {
    contracts: contractsOf(model),
    rows,
    gamma: buildGamma(model, worklist, connectionsAsEqualities),
    worklist,
    byType: usagesByType(model),
  };
}

/** The reference shape every row of this report names an element by. */
function refOf(model: Model, el: ElementRecord): ContractRef {
  return {
    id: el.id,
    eClass: el.eClass,
    ...(el.declaredName !== undefined ? { declaredName: el.declaredName } : {}),
    qualifiedName: model.qualifiedName(el.id),
  };
}

/** A contract as this report names it. */
function contractRef(contract: Contract): ContractRef {
  return {
    id: contract.id,
    eClass: contract.eClass,
    ...(contract.declaredName !== undefined ? { declaredName: contract.declaredName } : {}),
    qualifiedName: contract.qualifiedName,
  };
}

/**
 * The families one `--via` asks for, in a fixed order so two runs print alike.
 *
 * `all` is a RUN and never a group: the three families read different edges and
 * answer different questions, so a run over all of them is three sets of groups
 * side by side, each row saying which family it came from — not one merged
 * answer that would have to be read differently depending on where it came from.
 */
function familiesOf(via: RefinementVia): RefinementFamily[] {
  return via === 'all' ? ['composition', 'derive', 'refine'] : [via];
}

/**
 * The census a run with NO SOLVER can still take, with every group undecided.
 *
 * The same shape {@link checkRefinement} returns, so the report above it does
 * not branch: every decomposition is `inconclusive` under the code the caller
 * names, the γ census is real, and nothing was decided — which is exit 2 by
 * {@link RefinementResult} carrying no `refined` group at all.
 */
export function refinementCensus(
  model: Model,
  opts: { elementId?: ElementId; via?: RefinementVia; connectionsAsEqualities?: boolean },
  undecided: { code: string; detail: string },
): RefinementResult {
  const connectionsAsEqualities = opts.connectionsAsEqualities === true;
  const via = opts.via ?? 'composition';
  const prepared = prepare(model, connectionsAsEqualities);
  const groups: RefinementGroup[] = [];
  let unreadEdges = 0;
  // THE FAMILY LOOP IS `familiesOf`, and it is the same loop {@link
  // checkRefinement} runs — deliberately, and not as a tidy-up. A census taken
  // family-by-family in one order and a run taken in another publish the same
  // groups in different places under `--via all`, so a reader comparing a
  // no-solver run against a solved one sees rows move for no reason.
  const derivations = familiesOf(via).flatMap((f) => {
    if (f === 'composition') return [];
    const found = derivationsOf(prepared.contracts, opts.elementId, f);
    unreadEdges += found.unread;
    return found.groups;
  });
  const decompositions = familiesOf(via).includes('composition')
    ? decompositionsOf(model, prepared.contracts, opts.elementId)
    : [];
  for (const family of familiesOf(via)) {
    if (family === 'composition') {
      for (const d of decompositions) groups.push(censusDecomposition(model, d, prepared, connectionsAsEqualities, undecided));
      continue;
    }
    for (const d of derivations.filter((x) => x.via === family)) {
      groups.push(censusDerivation(d, prepared, connectionsAsEqualities, undecided));
    }
  }
  return runResult(groups, {
    via: opts.via ?? 'composition',
    connectionsAsEqualities,
    gamma: prepared.gamma,
    contracts: prepared.contracts.length,
    unreadEdges,
    checks: 0,
    timeoutMs: undefined,
  });
}

/** One derivation chain as an undecided census row. */
function censusDerivation(
  d: Derivation,
  prepared: Prepared,
  connectionsAsEqualities: boolean,
  undecided: { code: string; detail: string },
): RefinementGroup {
  const parent = encodeContract(d.parent, null, prepared.rows);
  const children = d.children.map((c) => encodeContract(c, null, prepared.rows));
  const gamma = gammaFor(prepared.gamma.encoded, [parent, ...children]).edges;
  return {
    via: d.via,
    system: contractRef(d.parent),
    shortId: d.parent.shortId,
    subject: d.parent.subject,
    part: null,
    components: d.children.map((c) => ({
      contract: contractRef(c),
      shortId: c.shortId,
      part: null,
    })),
    outcome: 'inconclusive',
    code: undecided.code,
    detail: `${undecided.detail}. ${gammaSentence(gamma, [], connectionsAsEqualities)}`,
    obligations: [],
    gamma,
    notEncoded: [],
    refused: [
      ...parent.refused,
      ...children.flatMap((c) => c.refused),
      ...prepared.gamma.refused,
    ],
    vacuityCore: [],
    fragment: 'qf-lra',
    logic: '',
    checks: 0,
  };
}

/** One decomposition as an undecided census row. */
function censusDecomposition(
  model: Model,
  d: Decomposition,
  prepared: Prepared,
  connectionsAsEqualities: boolean,
  undecided: { code: string; detail: string },
): RefinementGroup {
  const encodedSystem = encodeContract(d.system, refOf(model, d.systemPart), prepared.rows);
  const encodedComponents = d.components.map((c) =>
    encodeContract(c.contract, refOf(model, c.part), prepared.rows),
  );
  const gamma = gammaFor(prepared.gamma.encoded, [encodedSystem, ...encodedComponents]).edges;
  const notEncoded = notEncodedFor(model, prepared.gamma.notEncoded, d, prepared.byType);
  return {
    via: 'composition',
    system: contractRef(d.system),
    shortId: d.system.shortId,
    subject: d.system.subject,
    part: refOf(model, d.systemPart),
    components: d.components.map((c) => ({
      contract: contractRef(c.contract),
      shortId: c.contract.shortId,
      part: refOf(model, c.part),
    })),
    outcome: 'inconclusive',
    code: undecided.code,
    detail: `${undecided.detail}. ${gammaSentence(gamma, notEncoded, connectionsAsEqualities)}`,
    obligations: [],
    gamma,
    notEncoded,
    refused: [
      ...encodedSystem.refused,
      ...encodedComponents.flatMap((c) => c.refused),
      ...prepared.gamma.refused,
    ],
    vacuityCore: [],
    fragment: 'qf-lra',
    logic: '',
    checks: 0,
  };
}

/** Assemble the run-level figures from the groups and the γ census. */
function runResult(
  groups: RefinementGroup[],
  ctx: {
    via: RefinementVia;
    connectionsAsEqualities: boolean;
    gamma: Gamma;
    contracts: number;
    unreadEdges: number;
    checks: number;
    timeoutMs: number | undefined;
  },
): RefinementResult {
  const kinds = ctx.gamma.encoded.map((g) => g.edge.kind);
  const refused: RefusedClause[] = [];
  const seen = new Set<ElementId>();
  for (const r of [...groups.flatMap((g) => g.refused), ...ctx.gamma.refused]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    refused.push(r);
  }
  return {
    groups,
    via: ctx.via,
    connectionsAsEqualities: ctx.connectionsAsEqualities,
    bindEqualities: kinds.filter((k) => k === 'bind').length,
    itemFlows: kinds.filter((k) => k === 'flow').length,
    connectionEqualities: kinds.filter((k) => k === 'connection').length,
    notEncoded: ctx.gamma.notEncoded,
    refused,
    contracts: ctx.contracts,
    unreadEdges: ctx.unreadEdges,
    checks: ctx.checks,
    timeoutMs: ctx.timeoutMs,
  };
}

/**
 * The γ census every verdict line in this command carries.
 *
 * §3.6's own verdict vocabulary is "over 4 sub-contracts, 6 bind equalities and
 * 2 item flows; 9 connections not encoded as equalities", and it is composed
 * HERE so a renderer cannot print half of it. The opt-in is named in the same
 * sentence, because a reader who cannot see it has been handed the OCRA reading
 * of their model under this tool's name.
 */
function gammaSentence(
  gamma: readonly GammaEdge[],
  notEncoded: readonly UnencodedConnection[],
  connectionsAsEqualities: boolean,
): string {
  const binds = gamma.filter((g) => g.kind === 'bind').length;
  const flows = gamma.filter((g) => g.kind === 'flow').length;
  const connections = gamma.filter((g) => g.kind === 'connection').length;
  return (
    `${binds} bind equalit${binds === 1 ? 'y' : 'ies'} and ${flows} item flow(s)` +
    (connectionsAsEqualities
      ? `, plus ${connections} connection equalit${connections === 1 ? 'y' : 'ies'} — ${CONNECTIONS_AS_EQUALITIES_NOTE}` +
        // The opt-in does NOT empty this list: it reads `connect`, and an
        // `allocate` or an interface stays refused under it. A verdict line
        // that hid the remainder would say the whole wiring had been read.
        (notEncoded.length > 0
          ? `; ${notEncoded.length} connector(s) still not encoded as equalities, because the opt-in reads \`connect\` only`
          : '')
      : `; ${notEncoded.length} connection(s) not encoded as equalities`)
  );
}

/**
 * Decide whether the component contracts entail the system contract.
 *
 * Asynchronous only because the solver is. Everything else is a pure function
 * of the model and the options.
 */
export async function checkRefinement(
  model: Model,
  opts: RefinementOptions,
): Promise<RefinementResult> {
  const connectionsAsEqualities = opts.connectionsAsEqualities === true;
  const via = opts.via ?? 'composition';
  const prepared = prepare(model, connectionsAsEqualities);
  const groups: RefinementGroup[] = [];
  let checks = 0;
  let unreadEdges = 0;
  for (const family of familiesOf(via)) {
    if (family === 'composition') {
      for (const d of decompositionsOf(model, prepared.contracts, opts.elementId)) {
        const group = await judgeGroup({
          model,
          decomposition: d,
          prepared,
          connectionsAsEqualities,
          backend: opts.backend,
          timeoutMs: opts.timeoutMs,
        });
        checks += group.checks;
        groups.push(group);
      }
      continue;
    }
    const found = derivationsOf(prepared.contracts, opts.elementId, family);
    unreadEdges += found.unread;
    for (const d of found.groups) {
      const group = await judgeDerivation({
        model,
        derivation: d,
        prepared,
        connectionsAsEqualities,
        backend: opts.backend,
        timeoutMs: opts.timeoutMs,
      });
      checks += group.checks;
      groups.push(group);
    }
  }
  return runResult(groups, {
    via,
    connectionsAsEqualities,
    gamma: prepared.gamma,
    contracts: prepared.contracts.length,
    unreadEdges,
    checks,
    timeoutMs: opts.timeoutMs,
  });
}

interface JudgeInput {
  model: Model;
  decomposition: Decomposition;
  prepared: Prepared;
  connectionsAsEqualities: boolean;
  backend: Z3Backend;
  timeoutMs: number | undefined;
}

/** One script, and the labels it gave each assertion. */
function scriptOf(
  assertions: readonly ScriptAssertion[],
  variables: readonly EncodeVariable[],
  flags: { nonlinear: boolean; syntacticNonlinear: boolean },
): { text: string; logic: string; fragment: Fragment; symbols: string[]; labels: string[] } {
  const seen = new Set<string>();
  const declared: EncodeVariable[] = [];
  for (const v of variables) {
    if (seen.has(v.qualifiedName)) continue;
    seen.add(v.qualifiedName);
    declared.push(v);
  }
  const script = encodeScript({
    variables: declared,
    assertions,
    nonlinear: flags.nonlinear,
    syntacticNonlinear: flags.syntacticNonlinear,
  });
  return {
    text: script.text,
    logic: script.logic,
    fragment: script.fragment,
    symbols: script.symbols,
    labels: script.labels,
  };
}

/**
 * Judge one decomposition: step (0), obligation (3), then obligation (4) per
 * component.
 *
 * THE ORDER IS THE CONTRACT. Step (0) runs first and its `unsat` stops
 * everything: an architecture whose sub-contracts, connections and system
 * assumption cannot hold together entails every obligation for free, and
 * printing "obligation (3) proved" over it is the exact failure §3.6 step (0)
 * exists to prevent. A group is `refined` only when step (0) answered `sat`,
 * obligation (3) was proved, and every component assumption was discharged —
 * "never say `refined` while any obligation is undecided" is the same rule, and
 * it is enforced by {@link outcomeOf} rather than by whoever reads the rows.
 */
async function judgeGroup(input: JudgeInput): Promise<RefinementGroup> {
  const { model, decomposition, prepared, connectionsAsEqualities } = input;
  const systemPartRef = refOf(model, decomposition.systemPart);
  const system = encodeContract(decomposition.system, systemPartRef, prepared.rows);
  const components = decomposition.components.map((c) =>
    encodeContract(c.contract, refOf(model, c.part), prepared.rows),
  );
  const groupGamma = gammaFor(prepared.gamma.encoded, [system, ...components]);
  const gammaEdges = groupGamma.edges;
  const notEncoded = notEncodedFor(
    model,
    prepared.gamma.notEncoded,
    decomposition,
    prepared.byType,
  );
  const census = gammaSentence(gammaEdges, notEncoded, connectionsAsEqualities);
  const refused = [
    ...system.refused,
    ...components.flatMap((c) => c.refused),
    ...prepared.gamma.refused,
  ];

  const base = {
    via: 'composition' as const,
    system: contractRef(decomposition.system),
    shortId: decomposition.system.shortId,
    subject: decomposition.system.subject,
    part: systemPartRef,
    components: decomposition.components.map((c) => ({
      contract: contractRef(c.contract),
      shortId: c.contract.shortId,
      part: refOf(model, c.part),
    })),
    obligations: [] as RefinementObligation[],
    gamma: gammaEdges,
    notEncoded,
    refused,
    vacuityCore: [] as string[],
    fragment: 'qf-lra' as Fragment,
    logic: '',
    checks: 0,
  };

  // A GOAL WITH A REFUSED CONJUNCT IS NOT THE GOAL THE FILE STATES. Dropping it
  // would weaken `nf(C)`, and a weaker goal is easier to entail — the one
  // direction in which a missing relation buys a verdict rather than costing
  // one. So the whole group stands down, with the refusal named.
  if (system.hasRefusal || system.nf === null) {
    return {
      ...base,
      outcome: 'inconclusive',
      code: REFINEMENT_UNDECIDED_CODE,
      detail:
        (system.nf === null
          ? `the system contract states no guarantee this lane encodes, so there is no \`nf(C)\` to entail: ` +
            `a refinement question needs something to refine TO`
          : `a gate refused ${system.refused.length} clause(s) of the system contract, and dropping a ` +
            `conjunct of \`nf(C)\` would weaken the very goal being proved — so nothing is claimed ` +
            `about this decomposition (${system.refused.map((r) => `${r.qualifiedName}: ${r.reason}`).join('; ')})`) +
        `. ${census}`,
    };
  }

  // A COMPONENT WHOSE `A` LOST A CONJUNCT IS NOT A PREMISE. Its `nf` as built
  // is STRONGER than the normal form the file states (`¬a₁` entails
  // `¬a₁ ∨ ¬a₂`, and with every `assume` gone it collapses to a bare `G`), so
  // asserting it would prove obligation (3) from an axiom the model does not
  // contain — the one direction in which a refused relation buys a verdict.
  // The only sound premise for a normal form with an unknown conjunct of A is
  // ⊤, which is to say: leave it out. Its own obligation (4) is filed undecided
  // below, so the group can never come back `refined` on the strength of the
  // siblings alone.
  const premises = components
    .filter((c) => !c.hasRefusedAssumption)
    .map((c) => ({ contract: c, term: c.nf }))
    .filter((p): p is { contract: EncodedContract; term: string } => p.term !== null);
  const gammaTerms = groupGamma.rows.map((g) => ({
    edge: g.edge,
    term: termsOf(g.row),
  }));

  // AN EMPTY PREMISE SET IS NOT A REFINEMENT. `⊤ ∧ γ ⊨ nf(C)` is a claim about
  // the system contract standing alone, and calling it "refined" would say the
  // components entail something they never mentioned.
  if (premises.length === 0) {
    return {
      ...base,
      outcome: 'inconclusive',
      code: REFINEMENT_UNDECIDED_CODE,
      detail:
        `no sub-contract of this decomposition contributes a normal form this lane may assert — ` +
        `${components.filter((c) => c.hasRefusedAssumption).length} of ${components.length} had an ` +
        `\`assume\` clause a gate refused, which is not a premise, and the rest state no guarantee ` +
        `this lane encodes. The antecedent of obligation (3) is therefore empty, and entailing a ` +
        `system contract from nothing is a claim about that contract alone and not about its ` +
        `decomposition. ${census}`,
    };
  }

  const variables = [
    ...system.vars,
    ...components.flatMap((c) => c.vars),
    ...groupGamma.rows.flatMap((g) => g.row.vars),
  ];
  const nonlinear =
    system.nonlinear ||
    components.some((c) => c.nonlinear) ||
    groupGamma.rows.some((g) => g.row.encoded?.nonlinear === true);
  const syntacticNonlinear =
    system.syntacticNonlinear ||
    components.some((c) => c.syntacticNonlinear) ||
    groupGamma.rows.some((g) => g.row.encoded?.syntacticNonlinear === true);

  const gammaAssertions: ScriptAssertion[] = gammaTerms.flatMap((g) =>
    g.term.map((t) => ({ kind: 'axiom' as const, name: g.edge.qualifiedName, term: t })),
  );
  const premiseAssertions = (skip?: EncodedContract): ScriptAssertion[] =>
    premises
      .filter((p) => p.contract !== skip)
      .map((p) => ({ kind: 'premise' as const, name: p.contract.contract.qualifiedName, term: p.term }));

  let checks = 0;
  let logic = '';
  let fragment: Fragment = 'qf-lra';
  const run = async (assertions: ScriptAssertion[]): Promise<CheckOutcome> => {
    const script = scriptOf(assertions, variables, { nonlinear, syntacticNonlinear });
    logic = script.logic;
    fragment = script.fragment;
    checks += 1;
    return input.backend.check(script.text, {
      timeoutMs: input.timeoutMs,
      variables: script.symbols,
    });
  };

  // ── step (0): can any implementation satisfy A ∧ ⋀ nf(C′) ∧ γ at all? ──────
  const zero = await run([
    ...(system.antecedent !== null
      ? [{ kind: 'premise' as const, name: `${decomposition.system.qualifiedName}::assume`, term: system.antecedent }]
      : []),
    ...premiseAssertions(),
    ...gammaAssertions,
  ]);
  if (zero.status === 'unsat') {
    return {
      ...base,
      checks,
      logic,
      fragment,
      outcome: 'vacuous',
      code: CONTRACT_SET_VACUOUS_CODE,
      vacuityCore: [...zero.core],
      detail:
        `vacuous: the sub-contracts, the connections and the system assumption cannot hold together ` +
        `(core ${zero.core.length > 0 ? zero.core.join(', ') : 'the solver named none'}) — every ` +
        `refinement obligation over them holds for nothing, so none is claimed. ${census}`,
    };
  }
  if (zero.status !== 'sat') {
    return {
      ...base,
      checks,
      logic,
      fragment,
      outcome: 'inconclusive',
      code: zero.status === 'unknown' ? 'verification/timeout' : 'verification/not-evaluable',
      detail:
        zero.status === 'unknown'
          ? `the solver was asked whether the sub-contracts, the connections and the system assumption ` +
            `can hold together and did not answer (${zero.reason || 'unknown'} after ${zero.timeoutMs} ms). ` +
            `Nothing is claimed: an obligation over an antecedent nobody has shown satisfiable is not a ` +
            `proof. ${census}`
          : `the solver refused the script this tool produced: ${zero.reason}. That is a defect in this ` +
            `tool, not in the model. ${census}`,
    };
  }

  const obligations: RefinementObligation[] = [];

  // ── obligation (3): ⋀ nf(C′) ∧ γ ⊨ nf(C) ─────────────────────────────────
  {
    const before = checks;
    const outcome = await run([
      ...premiseAssertions(),
      ...gammaAssertions,
      { kind: 'goal', name: `${decomposition.system.qualifiedName}::nf`, term: notTerm(system.nf) },
    ]);
    obligations.push(
      obligationRow({
        kind: 'composition',
        component: null,
        part: null,
        outcome,
        checks: checks - before,
        census,
        proved:
          `obligation (3) proved (negation unsat) over ${premises.length} sub-contract(s), ${census}` +
          ` — in normal form \`nf(C) = ¬A ∨ G\`, so mutual support cannot buy the verdict`,
        refuted:
          `obligation (3) refuted: the sub-contracts and the connections admit an implementation that ` +
          `breaks the system contract`,
        code: REFINEMENT_FAILED_CODE,
        confirm: (values) =>
          confirmCounterexample(values, {
            assumed: [],
            premises: premises.map((p) => p.contract),
            gamma: groupGamma.rows.map((g) => g.row),
            goalFalse: system,
          }),
      }),
    );
  }

  // ── obligation (4): A ∧ ⋀_{S′≠U} nf(C′) ∧ γ ⊨ A_U, per component ─────────
  for (const component of components) {
    // THE REFUSAL TEST COMES FIRST, and it reads the SOURCE clause count rather
    // than `antecedent === null`. A component all of whose `assume` clauses a
    // gate refused has a null antecedent too, and taking the branch below would
    // publish "this component promises its guarantee unconditionally" — a
    // sentence about a contract the file does not contain — and let the group
    // go green off it. `no-assumption` is only ever the truth when the contract
    // states no assumption at all.
    if (component.hasRefusedAssumption) {
      obligations.push({
        kind: 'assumption',
        component: contractRef(component.contract),
        part: component.part,
        outcome: 'undecided',
        code: REFINEMENT_UNDECIDED_CODE,
        detail:
          `${component.contract.assumptions.length} \`assume\` clause(s) of this component were stated ` +
          `and ${component.assumptions.filter((a) => a.encoded).length} of them encoded, so \`A_U\` as ` +
          `built is not the assumption the file states: dropping a conjunct of \`A_U\` weakens the goal ` +
          `of obligation (4), and dropping one from its \`nf\` STRENGTHENS a premise of obligation (3). ` +
          `Nothing is claimed about this component and its normal form was not asserted. ${census}`,
        witness: [],
        witnessConfirmed: false,
        checks: 0,
      });
      continue;
    }
    if (component.antecedent === null) {
      obligations.push({
        kind: 'assumption',
        component: contractRef(component.contract),
        part: component.part,
        outcome: 'no-assumption',
        code: null,
        detail:
          `no assumption to discharge: this component promises its guarantee unconditionally, so ` +
          `obligation (4) is empty for it. ${census}`,
        witness: [],
        witnessConfirmed: false,
        checks: 0,
      });
      continue;
    }
    const before = checks;
    const outcome = await run([
      ...(system.antecedent !== null
        ? [{ kind: 'premise' as const, name: `${decomposition.system.qualifiedName}::assume`, term: system.antecedent }]
        : []),
      ...premiseAssertions(component),
      ...gammaAssertions,
      {
        kind: 'goal',
        name: `${component.contract.qualifiedName}::assume`,
        term: notTerm(component.antecedent),
      },
    ]);
    const unreached = assumptionReach(
      component,
      groupGamma.connected,
      premises.map((p) => p.contract),
    );
    const name = component.part?.declaredName ?? component.contract.qualifiedName;
    obligations.push(
      obligationRow({
        kind: 'assumption',
        component: contractRef(component.contract),
        part: component.part,
        outcome,
        checks: checks - before,
        census,
        proved: `assumption of \`${name}\` discharged by its siblings and the connections (negation unsat), ${census}`,
        refuted:
          `assumption of \`${name}\` not discharged` +
          (unreached.length > 0
            ? `: nothing connects ${unreached.map((u) => `\`${u}\``).join(', ')} — a connection is not an ` +
              `equality unless the model binds it`
            : ': its siblings do not guarantee what it assumes'),
        code: unreached.length > 0 ? UNCONNECTED_ASSUMPTION_CODE : REFINEMENT_FAILED_CODE,
        confirm: (values) =>
          confirmCounterexample(values, {
            assumed: system.antecedent !== null ? system.assumptions : [],
            premises: premises.map((p) => p.contract).filter((c) => c !== component),
            gamma: groupGamma.rows.map((g) => g.row),
            goalFalse: { antecedentOnly: true, contract: component },
          }),
      }),
    );
  }

  const outcome = outcomeOf(obligations);
  return {
    ...base,
    checks,
    logic,
    fragment,
    obligations,
    outcome,
    code: groupCodeOf(outcome, obligations),
    detail: groupDetail(outcome, obligations, premises.length, census, refused),
  };
}

/**
 * The group's outcome, read off its rows and never off a count of the good ones.
 *
 * "Never say `refined` while any obligation is undecided" (§3.6's MUST-NEVER
 * list) is one line here rather than a rule a renderer has to remember, and the
 * order is the contract: a refutation outranks an undecided row, because it is
 * a decided finding about the model, and an undecided row outranks every proof.
 */
function outcomeOf(obligations: readonly RefinementObligation[]): RefinementOutcome {
  if (obligations.some((o) => o.outcome === 'refuted')) return 'not-refined';
  if (obligations.some((o) => o.outcome === 'undecided')) return 'inconclusive';
  return obligations.some((o) => o.outcome === 'proved') ? 'refined' : 'inconclusive';
}

/** The group's code: the first row that explains the outcome, or none. */
function groupCodeOf(
  outcome: RefinementOutcome,
  obligations: readonly RefinementObligation[],
): string | null {
  if (outcome === 'refined') return null;
  const wanted = outcome === 'not-refined' ? 'refuted' : 'undecided';
  return obligations.find((o) => o.outcome === wanted)?.code ?? REFINEMENT_UNDECIDED_CODE;
}

/** The group's sentence, which always carries the γ census and the refused count. */
function groupDetail(
  outcome: RefinementOutcome,
  obligations: readonly RefinementObligation[],
  subContracts: number,
  census: string,
  refused: readonly RefusedClause[],
): string {
  const discharged = obligations.filter((o) => o.outcome === 'proved').length;
  const open = obligations.filter((o) => o.outcome === 'refuted' || o.outcome === 'undecided').length;
  const head =
    outcome === 'refined'
      ? `refines: ${discharged} obligation(s) proved over ${subContracts} sub-contract(s), ${census}`
      : outcome === 'not-refined'
        ? `does NOT refine: ${open} obligation(s) not discharged over ${subContracts} sub-contract(s), ${census}`
        : `not decided: ${open} obligation(s) undecided over ${subContracts} sub-contract(s), ${census}`;
  return (
    `${head}. ` +
    (refused.length === 0
      ? '0 relations refused'
      : `${refused.length} relation(s) refused by a gate and not asserted (${refused
          .map((r) => `${r.qualifiedName}: ${r.reason}`)
          .join('; ')})`) +
    '. Nothing here is about ordering or time'
  );
}

/**
 * The variables a component's assumption reads that NOTHING in the group reaches.
 *
 * WHY THE SIBLINGS COUNT AND NOT ONLY γ. The two codes exist because their
 * fixes differ: `verification/unconnected-assumption` says "the model never
 * said these two quantities are one — bind them", and
 * `verification/refinement-failed` says "your siblings simply do not guarantee
 * what this one assumes". Deciding between them from γ alone files a pure
 * DESIGN failure — a sibling that constrains the very same symbol, but not
 * strongly enough — under a wiring hint no `bind` can act on, and the witness
 * printed beside it shows the symbol constrained. So a symbol a sibling's
 * normal form reads is reached, whether or not an equality joins it to
 * anything, and only a symbol nothing in the group mentions is unconnected.
 */
function assumptionReach(
  component: EncodedContract,
  connected: ReadonlySet<string>,
  siblings: readonly EncodedContract[],
): string[] {
  const reached = new Set<string>(connected);
  for (const s of siblings) {
    if (s === component) continue;
    for (const row of [...s.assumptions, ...s.guarantees]) {
      for (const symbol of row.encoded?.reads ?? []) reached.add(symbol);
    }
  }
  const out: string[] = [];
  for (const a of component.assumptions) {
    for (const v of a.vars) {
      if (reached.has(v.qualifiedName) || out.includes(v.qualifiedName)) continue;
      out.push(v.qualifiedName);
    }
  }
  return out;
}

/* ────────────────── one obligation row, and the witness gate ─────────────── */

/**
 * Turn one solver answer into a row.
 *
 * A `sat` is a COUNTEREXAMPLE, and it is re-read through this tool's own
 * evaluator before it is printed — the same gate `verify` and `consistency`
 * apply to a witness, for the same reason: it catches an encoding built wrong
 * (a flipped comparison, a mis-scaled factor, a numeral that is not the number
 * this tool holds) in the direction that matters. A counterexample this tool
 * cannot reproduce is `inconclusive: witness not confirmed`, never a refutation.
 */
function obligationRow(input: {
  kind: RefinementObligationKind;
  component: ContractRef | null;
  part: ContractRef | null;
  outcome: CheckOutcome;
  checks: number;
  census: string;
  proved: string;
  refuted: string;
  code: string;
  confirm: (values: ReadonlyMap<string, number | boolean>) => { ok: true } | { ok: false; why: string };
}): RefinementObligation {
  const shape = {
    kind: input.kind,
    component: input.component,
    part: input.part,
    checks: input.checks,
  };
  if (input.outcome.status === 'unsat') {
    return {
      ...shape,
      outcome: 'proved',
      code: null,
      detail: `${input.proved}. Nothing here is about ordering or time`,
      witness: [],
      witnessConfirmed: false,
    };
  }
  if (input.outcome.status !== 'sat') {
    return {
      ...shape,
      outcome: 'undecided',
      code: input.outcome.status === 'unknown' ? 'verification/timeout' : 'verification/not-evaluable',
      detail:
        input.outcome.status === 'unknown'
          ? `unknown after ${input.outcome.timeoutMs} ms (${input.outcome.reason || 'no reason given'}) — ` +
            `nothing is claimed either way. ${input.census}`
          : `the solver refused the script this tool produced: ${input.outcome.reason}. That is a defect ` +
            `in this tool, not in the model. ${input.census}`,
      witness: [],
      witnessConfirmed: false,
    };
  }
  const values = new Map<string, number | boolean>();
  for (const w of input.outcome.witness) if (w.value !== null) values.set(w.symbol, w.value);
  const confirmation = input.confirm(values);
  if (!confirmation.ok) {
    return {
      ...shape,
      outcome: 'undecided',
      code: 'verification/not-evaluable',
      detail:
        `a counterexample was found and this tool’s own evaluator would not confirm it: ` +
        `${confirmation.why}. A counterexample this tool cannot reproduce is not evidence that the ` +
        `obligation fails. ${input.census}`,
      witness: input.outcome.witness,
      witnessConfirmed: false,
    };
  }
  return {
    ...shape,
    outcome: 'refuted',
    code: input.code,
    detail:
      `${input.refuted}: witness ${witnessSentence(input.outcome.witness)} (stored magnitudes), ` +
      `re-read in process. ${input.census}. Nothing here is about ordering or time`,
    witness: input.outcome.witness,
    witnessConfirmed: true,
  };
}

/** The counterexample, in the magnitudes the file stores. */
function witnessSentence(witness: readonly WitnessValue[]): string {
  if (witness.length === 0) return '(no symbol was assigned)';
  return witness
    .map((w) => `${w.symbol} = ${typeof w.value === 'number' || typeof w.value === 'boolean' ? String(w.value) : w.term}`)
    .join(', ');
}

/** What a counterexample must reproduce for this tool to publish it. */
interface Counterexample {
  /**
   * Clauses asserted as a PLAIN conjunction — the system assumption `A`, which
   * obligation (4) asserts outright rather than in normal form.
   */
  assumed: readonly EncodedRow[];
  /** Contracts whose normal form was asserted as a premise. */
  premises: readonly EncodedContract[];
  /** The γ equalities. */
  gamma: readonly EncodedRow[];
  /**
   * The goal, negated: a whole contract's normal form (obligation 3), one
   * component's antecedent (obligation 4), or — on a derivation chain, where
   * the parent's assumption is asserted as a premise rather than folded into a
   * normal form — one contract's GUARANTEE alone.
   */
  goalFalse:
    | EncodedContract
    | { antecedentOnly: true; contract: EncodedContract }
    | { guaranteeOnly: true; contract: EncodedContract };
}

/**
 * Substitute the counterexample back through this tool's own evaluator.
 *
 * WHAT IS RE-READ IS WHAT WAS ASSERTED — every premise's normal form, every γ
 * equality, and the negated goal — because a point that does not satisfy the
 * premises is not a counterexample to anything. A relation this evaluator
 * cannot read at the point is NOT a confirmation: it comes back as a failure,
 * so "the point could not be checked" and "the point checks out" are never the
 * same answer. The one place that has to be careful about it is
 * {@link normalFormAt}: a solver assigns the symbols its answer needed and no
 * others, so a premise satisfied through `¬A` leaves `G`'s symbols unassigned,
 * and reading that as "unreadable" rather than as "already settled" would
 * reject the commonest genuine counterexample this command finds.
 */
function confirmCounterexample(
  values: ReadonlyMap<string, number | boolean>,
  what: Counterexample,
): { ok: true } | { ok: false; why: string } {
  for (const g of what.gamma) {
    const v = truthOf([g], values);
    if (typeof v === 'string') return { ok: false, why: v };
    if (!v) {
      return {
        ok: false,
        why: `this tool’s own evaluator makes the connection \`${g.row.expression}\` false at the point the solver chose`,
      };
    }
  }
  {
    const v = truthOf(what.assumed, values);
    if (typeof v === 'string') return { ok: false, why: v };
    if (!v) {
      return {
        ok: false,
        why: 'this tool’s own evaluator makes the system assumption false at the point the solver chose, so the point does not satisfy what was assumed',
      };
    }
  }
  for (const p of what.premises) {
    const v = normalFormAt(p, values);
    if (typeof v === 'string') return { ok: false, why: v };
    if (!v) {
      return {
        ok: false,
        why: `this tool’s own evaluator makes \`nf(${p.contract.shortId || p.contract.qualifiedName})\` false at the point the solver chose, so the point does not satisfy what was assumed`,
      };
    }
  }
  const goal =
    'antecedentOnly' in what.goalFalse
      ? truthOf(what.goalFalse.contract.assumptions, values)
      : 'guaranteeOnly' in what.goalFalse
        ? truthOf(what.goalFalse.contract.guarantees, values)
        : normalFormAt(what.goalFalse, values);
  if (typeof goal === 'string') return { ok: false, why: goal };
  if (goal) {
    return {
      ok: false,
      why: 'this tool’s own evaluator makes the obligation HOLD at the point the solver called a counterexample',
    };
  }
  return { ok: true };
}

/**
 * `nf(C) = ¬A ∨ G` evaluated at a point, or the reason it could not be.
 *
 * BOTH DISJUNCTS ARE TRIED BEFORE THE POINT IS CALLED UNREADABLE, and that is
 * not tidiness — it is what keeps the witness gate from rejecting the most
 * ordinary refutation this command finds. A solver's model assigns the symbols
 * its answer needed and no others, and a premise `¬A ∨ G` satisfied through
 * `¬A` needs nothing from `G`: the symbols of that guarantee are simply absent
 * from the model. Reading `G` first and returning "could not be re-read" would
 * then degrade every counterexample that falsifies a sibling's assumption —
 * the archetypal shape of a failed obligation (4) — to
 * `verification/not-evaluable`, a code `--allow-inconclusive` does not lower.
 * A disjunct that is TRUE settles the disjunction whatever the other one is, so
 * an unreadable half is only fatal when the readable half did not settle it.
 */
function normalFormAt(
  contract: EncodedContract,
  values: ReadonlyMap<string, number | boolean>,
): boolean | string {
  const guarantee = truthOf(contract.guarantees, values);
  if (guarantee === true) return true;
  const assumption = truthOf(contract.assumptions, values);
  if (assumption === false) return true;
  if (typeof guarantee === 'string') return guarantee;
  if (typeof assumption === 'string') return assumption;
  return false;
}

/** The conjunction of these rows at a point, or the reason one could not be read. */
function truthOf(
  rows: readonly EncodedRow[],
  values: ReadonlyMap<string, number | boolean>,
): boolean | string {
  let all = true;
  for (const row of rows) {
    const node = row.row.node;
    if (node === null) return `\`${row.row.expression}\` has no readable body`;
    const scope = (name: string): unknown => {
      const v = row.vars.find((x) => x.path === name || x.qualifiedName === name);
      if (!v) return undefined;
      const raw = values.get(v.qualifiedName);
      if (raw === undefined) return undefined;
      if (typeof raw === 'boolean') return raw;
      return raw * v.factor + v.offset;
    };
    const out = evaluate(node, scope);
    if (!('value' in out)) {
      return `\`${row.row.expression}\` could not be re-read at the point the solver chose`;
    }
    if (typeof out.value !== 'boolean') {
      return `this tool’s own evaluator makes \`${row.row.expression}\` ${String(out.value)} at the point the solver chose, not a truth value`;
    }
    if (!out.value) all = false;
  }
  return all;
}

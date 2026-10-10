/**
 * The worklist: what would have to be SHOWN, over which axioms, and which
 * relations the unit gates refuse.
 *
 * The charter of this module, in one line: **report storage state, never
 * truth.** Nothing here decides whether an obligation holds. `open`,
 * `no-formal-clause` and `not-encodable` are structural readings of the file;
 * `discharged` and `stale` are read back from an attached evidence record and
 * are therefore never produced until that record exists (commit 3 of the
 * verification plan). There is deliberately no `vacuous` row: vacuity is an SMT
 * decision, and a verdict word this module's declared engine cannot decide is
 * exactly the defect the plan exists to prevent.
 *
 * THE ROLE MAP, COMPLETE, because a role with two buckets is how a lane starts
 * answering one model two ways:
 *
 *  - `require`                → **obligation**  (what must be shown)
 *  - `assume`                 → **premise**     (what may be assumed while showing it)
 *  - `assert constraint`      → **axiom**
 *  - a feature value (`=`)    → **axiom**  — a binding in KerML, not a default
 *  - a `bind` / binding edge  → **axiom**
 *  - a plain `constraint c { … }`, with no role at all → **OBLIGATION**
 *  - a third-party `#precondition` / `#postcondition` on a PLAIN `constraint`,
 *    and **only** under `--from-keywords` → **premise** / **obligation**,
 *    filed as `source: 'keyword'` with the spelling on the row
 *
 * That last row is off by default, and is the only way anything outside this
 * map can move a relation: with the flag absent the worklist is exactly what it
 * was before any keyword was read. It can neither produce an axiom nor REMOVE
 * one — a keyword on a calculation leaves the calculation's defining equality
 * exactly where it was — see {@link keywordRole}.
 *
 * The plain-constraint row is the one worth stating twice. A plain constraint is what
 * `checkConstraints` JUDGES, so it must be what an SMT engine judges, or the
 * two surfaces cannot be compared at all. Filing it as an axiom would make one
 * false plain constraint turn the axiom check unsatisfiable and downgrade every
 * genuine violation in the run to inconclusive — exit 2 by default, and exit 0
 * under an unscoped `--allow-inconclusive`. So the axiom set is exactly feature
 * values, `bind` equalities and `assert constraint` bodies, and nothing else.
 *
 * A CALCULATION IS A DEFINITION, NOT A CLAIM. A `CalculationUsage` whose body
 * is a bare expression says what the calculation IS (`self == expr`), which is
 * an axiom; one whose body is a comparison is a claim like any other plain
 * constraint. The split is taken from the PARSED node, exactly where
 * `relationEquation` of {@link ./solver} takes it — a top-level comparison, or
 * else the joining equality — so both surfaces read the same relation out of
 * the same body. A string test would not: `if s.x > 0.0 then s.a else s.b` is a
 * value expression whose `>` belongs to the condition, and the first draft's
 * regex read it as a claim while the solver read it as a definition. Which SIDE
 * of a proof the relation then stands on is this module's role map, and there
 * the plan is explicit that an unroled body is what an engine must judge.
 *
 * WHAT IS DELIBERATELY NOT READ, recorded rather than hidden: a requirement
 * USAGE does not inherit its definition's clauses here. `contractsOf` reads
 * OWNED children, and the definition is itself a user element with a contract
 * of its own, so reading the inherited copy too would file one clause twice.
 * The subject IS followed through `effectiveFeatures` (commit 2b), because a
 * subject is stated once and answers for every usage. What such a usage is NOT
 * is a `no-formal-clause` row: `requirement massOk : MassLimit;` is the
 * idiomatic way to apply a requirement and is what a `satisfy` names, so
 * reporting it as "prose only, nothing to encode" would say something false
 * about the model and inflate the one figure `--missing` exists to measure.
 * `Contract.clausesInheritedFrom` names where the clause actually is.
 *
 * Pure and deterministic: nothing here reads or writes anything but its
 * arguments.
 */

import { type ElementId, type ElementRecord, type Model, isUsage } from '@core/index';
import { isBindingEdge } from './connectors';
import {
  claimedVerdictOf,
  contractsOf,
  gateRelation,
  isUserModelElement,
  readRelation,
  type Contract,
  type ContractRef,
  type ContractSubject,
  type ContractVariable,
  type Encodable,
  type Refusal,
  type RelationReading,
  type VarSort,
} from './contracts';
import {
  boundAboveSentence,
  boundHereSentence,
  contradictedBindingOf,
  defaultGivesWay,
  hasStatedValue,
  isAsserted,
  isParameterisedCalculation,
  relationNamesOf,
  sharedDefinitions,
  statedValueOf,
  usageOwnedRefusal,
} from './defining-equation';
import { DOUBLE_DIGITS, significantDigitsOf, type ExprNode } from './expr';
import { effectiveNameOf, effectiveQualifiedName, generalizationsOf } from './inheritance';
import { foreignKeyword, keywordsOnRecord, resolveKeyword } from './keywords';
import { NO_MARKERS, idScopeFor, parseRelationBody } from './relations';
import { getRequirementAttr } from './requirements';
import { isNonNormativeStatement } from './statement-kind';
import { type DerivationMemo } from './units-eval';

/** Which side of a proof a relation stands on. */
export type ObligationRole = 'axiom' | 'premise' | 'obligation';

/** How one relation was filed: the side it stands on, how it was written, and why. */
interface FiledRole {
  role: ObligationRole;
  source: ObligationSource;
  provenance?: { keyword: string; note: string };
}

/**
 * How the relation was written, which is what makes the role map checkable.
 *
 * Two rows share the `axiom` role for entirely different reasons — an author's
 * `assert constraint` and a feature value the notation reads as a binding — and
 * a report that showed only the role could not tell a reader which of them put
 * a fact into the proof context.
 */
export type ObligationSource =
  | 'require'
  | 'assume'
  | 'objective'
  | 'assert'
  | 'constraint'
  | 'calculation'
  | 'feature-value'
  | 'bind'
  | 'keyword'
  | 'none';

/**
 * What the tool HOLDS about this row — never what is true of it.
 *
 * `discharged` means an evidence record exists whose claim is `proved` and
 * whose model digest still matches; `stale` means one exists and it does not.
 * Neither can be produced before the evidence record ships, so this module
 * returns only the other three today, and says so rather than leaving a reader
 * to wonder why nothing is ever discharged.
 */
export type ObligationStatus =
  | 'open'
  | 'discharged'
  | 'stale'
  | 'no-formal-clause'
  | 'not-encodable';

/** A record of evidence attached to an obligation. Always empty until commit 3. */
export interface EvidenceRef {
  claim: string;
  engine: string;
  recordedAt: string;
}

/** One row of the worklist. */
export interface Obligation {
  /** The requirement or case the row belongs to, or `null` for a model-level axiom. */
  requirement: ContractRef | null;
  /** The `<R-UAV-001>` short name of that requirement, or `''`. */
  shortId: string;
  subject: ContractSubject | null;
  role: ObligationRole;
  /** How it was written — the half of the role map a reader can check. */
  source: ObligationSource;
  /** The clause, feature or edge this row IS. */
  element: ContractRef;
  /** The relation as written, or `''` when there is no formal clause at all. */
  expression: string;
  /** The relation with every `[unit]` literal lowered to SI, or `null`. */
  node: ExprNode | null;
  vars: ContractVariable[];
  sortPerVar: Record<string, VarSort>;
  /**
   * Did the gates grant this relation a `ScaleMap` — is it judged in coherent
   * SI, or verbatim in the magnitudes the file stores?
   *
   * PUBLISHED BECAUSE IT IS NOT DERIVABLE FROM THE ROW. `ContractVariable`
   * carries `siFactor` whatever the gates decided, so a consumer that scaled a
   * variable because it COULD would read `range = 5.0 [km]` against a bare
   * `<= 10.0` as `5000 <= 10` — a confident wrong verdict on a satisfied
   * constraint, and the exact reading the declared-unit contract exists to
   * forbid (`scaleOfRelation`, gate (c)). The SMT engine is the second consumer
   * of this worklist and it has to encode each relation the way the gates read
   * it; the numeric surface already does, through the same `ScaleMap` this flag
   * reports the presence of.
   *
   * `false` for a row with no relation at all, and for a LITERAL feature
   * value's axiom (`cap == 2.0` for `cap = 2.0 [GiB]`), which states the
   * stored magnitude and is read verbatim whatever the gates would grant it.
   */
  scaled: boolean;
  encodable: Encodable;
  nonlinear: boolean;
  verifiedBy: ContractRef[];
  /** The `verificationMethod` facet, when the requirement declares one. */
  method: string | null;
  evidence: EvidenceRef[];
  status: ObligationStatus;
  /**
   * A `verdict` facet the file CLAIMS, with no evidence record behind it. Read,
   * never believed: the report says "claimed pass, no evidence".
   */
  claimedVerdict?: string;
  /** Set only for a row a foreign keyword contributed (`--from-keywords`, commit 2d). */
  provenance?: { keyword: string; note: string };
  /**
   * The paths the relation reads that the validation surface reads no value
   * for in its context — `RelationReading.unread` of ./contracts. Absent when
   * there are none. An AXIOM that reads one is refused (see
   * {@link unreadAxiom}); a goal or a premise is encoded over a symbol of its
   * own for each.
   */
  unread?: string[];
  /** The features the {@link unread} values depend on, where the relation reads them (`RelationReading.unreadDeps`). */
  unreadDeps?: ElementId[];
  /**
   * The names a refused body reads that its own element declares while its
   * owner's scope answers them with another feature (`RelationReading.shadowed`).
   * An ASSUMPTION that is one is no premise a proof may stand on.
   */
  shadowed?: string[];
  /**
   * Set on a row that reads a relation, or a binding, of a definition IN A
   * CONTEXT that specialises it — not where it is written. `baseId` is the
   * relation (or the feature whose `=` value binds), `contextId` the context
   * it is read in; for a binding, `featureId` is the redefinition the binding
   * holds of. `element.id` is then `<baseId>@<contextId>` (no element of the
   * model), and `element.qualifiedName` `<the relation's> in <the context's>`.
   * For a requirement's clause, `requirementId` is the requirement, and
   * `requirement` the requirement as read in the context. See
   * {@link instanceRows} and {@link bindingRows}.
   *
   * `path` is set on a relation read for an INSTANCE with symbols of its own
   * ({@link instanceRelationRows}): `element.id` is then `<baseId>@<path>`,
   * `element.qualifiedName` `<the relation's> in <path>`, and `contextId` the
   * context the walk reads the instance's names in. On the VALUE an instance's
   * feature has there, `symbol` is the symbol the instance reads it by.
   */
  instance?: {
    baseId: ElementId;
    contextId: ElementId;
    featureId?: ElementId;
    requirementId?: ElementId;
    path?: string;
    symbol?: string;
  };
}

/**
 * The encodability of an AXIOM row that reads a name the validation surface
 * reads no value for in its context — refused, whatever the gates said.
 *
 * Such a name is encoded as a symbol of its own (`ContractVariable.symbol`),
 * shared by every relation of one context that reads it. An axiom over it
 * pins nothing in the model, but it pins what a goal or premise of the same
 * context reads: `assert constraint big { e >= 10.0 }` in `S :> P`, over P's
 * `e == x * 2.0` (6), made `constraint goal { e >= 9.0 }` PROVED — false at
 * the model's own value — where the model is in fact contradictory. And an
 * axiom that pins the symbol cannot be checked against the definition it
 * stands for: the contradiction vanished. Refused, the axiom is listed with
 * its reason, a proof cannot rest on it, and a refutation over what it reads
 * is not claimed under a partial context.
 */
function unreadAxiom(role: ObligationRole, encodable: Encodable, unread: readonly string[] | undefined): Encodable {
  if (role !== 'axiom' || encodable !== true || !unread || unread.length === 0) return encodable;
  return {
    reason: 'unread-definition',
    detail:
      `the axiom reads ${unread.map((n) => `\`${n}\``).join(', ')}, a value whose definition is written in another ` +
      'context, which this tool does not read here; asserted over a symbol of its own it would constrain ' +
      'nothing in the model and still pin what a goal of the same context reads, so it is not carried',
  };
}

/**
 * The encodability of a calculation's AXIOM when the calculation has a
 * parameter ({@link isParameterisedCalculation}) — refused, whatever the gates
 * said. Its body is the value of a call over arguments, read in the owner's
 * scope: `calc g { in y = 100.0; y }` beside `attribute y = 4.0` asserted `g ==
 * y`, so `g <= 10.0` was PROVED with g 100 — and `calc t : Scale { x * 5.0 }`
 * read the part's `x` for the `in x` Scale declares. The validation surface
 * reads no value for such a calculation, and the verification lane asserts
 * none: a proof cannot rest on it, and a refutation over it is not claimed
 * under a partial context.
 */
function parameterisedCalculation(encodable: Encodable): Encodable {
  if (encodable !== true) return encodable;
  return {
    reason: 'unread-definition',
    detail:
      'the calculation has a parameter, so its body is the value of a call over arguments, which this tool does ' +
      'not read as the calculation’s own value; asserted in its owner’s scope it would read the owner’s features ' +
      'for the parameters, so it is not carried',
  };
}

/**
 * The refusal a command that ASSERTS relations as facts — `consistency`,
 * `bounds`, `refine` — gives a row that reads a name the validation surface
 * reads no value for in its context (`Obligation.unread`), or `undefined`.
 *
 * Only `verify` may encode such a row, over a symbol of its own: it confirms
 * every counterexample at the model's values and blocks a proof that rests on
 * one, so the symbol can decide nothing the model contradicts. A command that
 * asserts the row has no such check, and the symbol is a free value the model
 * does not leave free — `p.e <= 1.0` over P's `e == x * 2.0` (6) was reported
 * CONSISTENT at the model's values. Refused, the row is listed with its reason
 * and the answer is undecided, as the chain it replaced was.
 */
export function unreadRowRefusal(row: Pick<Obligation, 'unread' | 'encodable'>): Refusal | undefined {
  if (row.encodable !== true || !row.unread || row.unread.length === 0) return undefined;
  return {
    reason: 'unread-definition',
    detail:
      `the relation reads ${row.unread.map((n) => `\`${n}\``).join(', ')}, a value whose definition is written in ` +
      'another context, which this tool does not read here; asserted over a symbol of its own it would be a ' +
      'free value the model does not leave free, so it is not asserted',
  };
}

/** How the worklist may be narrowed. */
export interface ObligationOptions {
  /** Restrict to relations at or under this element. */
  scopeId?: ElementId;
  /**
   * Only the rows this lane would NOT decide: `no-formal-clause` and
   * `not-encodable`. It is the "what would this lane not decide on your model?"
   * mode, and it needs no solver.
   */
  missing?: boolean;
  /**
   * Read a third-party `#precondition` / `#postcondition` as a clause role.
   *
   * OFF BY DEFAULT, and that default is the point: a vocabulary this tool did
   * not define may not change what a proof stands on unless somebody asked for
   * it in so many words. With the flag off, {@link obligationsOf} returns
   * exactly the worklist it returned before keywords existed — the keyword is
   * still read, still listed by `contracts --keywords`, and contributes
   * nothing. With it on, every row it moved carries
   * {@link Obligation.provenance} and the spelling that moved it.
   */
  fromKeywords?: boolean;
}

/** The metaclasses whose `attrs.expression` carries a relation body. */
const RELATION_KINDS = new Set(['ConstraintUsage', 'CalculationUsage']);

/** The metaclasses a requirement is written as. */
const REQUIREMENT_KINDS = new Set(['RequirementDefinition', 'RequirementUsage']);

/** A predicate selecting elements at or under `scopeId` (or everything when none). */
function scopeFilter(model: Model, scopeId?: ElementId): (el: ElementRecord) => boolean {
  if (!scopeId) return () => true;
  const ids = new Set<ElementId>([scopeId]);
  for (const d of model.descendants(scopeId)) ids.add(d.id);
  return (el) => ids.has(el.id) || (el.ownerId != null && ids.has(el.ownerId));
}

function ref(model: Model, el: ElementRecord): ContractRef {
  return {
    id: el.id,
    eClass: el.eClass,
    ...(el.declaredName !== undefined ? { declaredName: el.declaredName } : {}),
    qualifiedName: effectiveQualifiedName(model, el.id),
  };
}

/**
 * The reference a row read in `context` carries: `<id>@<context id>`,
 * `<qualified name> in <context's>` — a `satisfy R by x` named by its x.
 */
function instanceRef(model: Model, el: ElementRecord | ContractRef, context: ElementRecord): ContractRef {
  const base: ContractRef = 'attrs' in el ? ref(model, el) : el;
  const name = 'attrs' in el ? effectiveQualifiedName(model, el.id) : el.qualifiedName;
  return {
    ...base,
    id: `${el.id}@${context.id}`,
    qualifiedName: `${name} in ${sharedDefinitions(model).contextName(context.id)}`,
  };
}

/**
 * The role a relation plays, from the role the author gave the clause.
 *
 * `undefined` back means the element is not a relation this lane files at all —
 * an `actor`, `stakeholder` or `frame` clause names a party rather than stating
 * a numeric relation, and the empty `objective` container is a place to hang
 * clauses rather than a clause itself.
 */
function roleOf(
  el: ElementRecord,
  isComparison: boolean,
): FiledRole | undefined {
  const written = el.attrs.requirementRole;
  switch (written) {
    case 'require':
      return { role: 'obligation', source: 'require' };
    case 'assume':
      return { role: 'premise', source: 'assume' };
    case 'assert':
      return { role: 'axiom', source: 'assert' };
    case 'objective':
      // An objective with a body of its own states the check; one with none is
      // only the container its `assume`/`require` children hang on.
      return { role: 'obligation', source: 'objective' };
    case 'actor':
    case 'stakeholder':
    case 'frame':
    case 'subject':
      return undefined;
    default:
      // No role at all: a plain `constraint`, or a calculation. A calculation
      // whose body is a comparison is a claim; one that is a bare expression
      // defines what the calculation IS.
      if (el.eClass === 'CalculationUsage' && !isComparison) {
        return { role: 'axiom', source: 'calculation' };
      }
      return { role: 'obligation', source: 'constraint' };
  }
}

/**
 * The role a THIRD-PARTY keyword asks for, under `--from-keywords` only.
 *
 * Three rules make this safe to have at all, and all three are load-bearing:
 *
 *  1. **Only a plain `constraint` is open to a keyword reading**, which is what
 *     `source === 'constraint'` says: the relation carries no written clause
 *     role AND is not a calculation's defining body. The first half is the rule
 *     SysML v2 forces — a precondition is expressible three ways and a
 *     postcondition two, so a `#precondition require constraint { … }` is a file
 *     that already said what it meant, and a keyword that could overrule it
 *     would let somebody else's vocabulary reclassify the standard's own
 *     construct. The second half is the direction a first draft of this
 *     function missed, and it is the worse one: a `#postcondition calc gain { m
 *     + 1.0 }` has no written role either, so the guard on `requirementRole`
 *     alone let the keyword REPLACE `{axiom, calculation}` — deleting the
 *     joining equality `gain == m + 1.0` from the proof context and re-filing
 *     the bare term `m + 1.0`, a real-valued expression, as something to show.
 *     Every obligation mentioning `gain` was then over a free variable. Rule 3
 *     below forbids a keyword ADDING an axiom; this one forbids it REMOVING
 *     one, and a keyword vocabulary that can silently drop a definition out of
 *     the context is exactly the reading that cannot be undone by reading the
 *     file.
 *  2. **The row says where it came from.** `source` becomes `keyword` — not
 *     `assume`, which would claim the author wrote `assume` — and
 *     {@link Obligation.provenance} carries the spelling and the provenance
 *     sentence, which every renderer prints on the line. A keyword-derived
 *     premise or guarantee without the keyword on it is this lane passing off a
 *     foreign vocabulary as its own. When the spelling also NAMES a definition
 *     the model itself declares, the sentence says so, exactly as the inventory
 *     does: telling an author that their own `metadata def <precondition>` is
 *     "a third-party spelling" and nothing more would report their declaration
 *     as ignored.
 *  3. **Never an axiom.** `assume` is a premise, `require` is something to
 *     show; neither arm can produce an axiom. A keyword that could put a fact
 *     into the proof context without the author writing `assert` would change
 *     what every other obligation in the run is judged against.
 */
function keywordRole(model: Model, el: ElementRecord, written: FiledRole): FiledRole {
  if (written.source !== 'constraint') return written;
  for (const keyword of keywordsOnRecord(el)) {
    const alias = foreignKeyword(keyword);
    if (!alias || alias.reads.as !== 'clause-role') continue;
    const named = resolveKeyword(model, keyword);
    return {
      role: alias.reads.role === 'assume' ? 'premise' : 'obligation',
      source: 'keyword',
      provenance: {
        keyword: keyword.written,
        note: named
          ? `${alias.note}; it names ${model.qualifiedName(named.id)} here`
          : alias.note,
      },
    };
  }
  return written;
}

/**
 * Does this body's TOP operator make it a claim rather than a definition?
 *
 * Asked of the parsed node, never of the raw string. A string test cannot tell
 * a top-level comparison from one nested inside an expression, and it was
 * measured getting `calc c2 { if s.x > 0.0 ? s.a else s.b }` wrong: the `>`
 * belongs to the condition, so the body is a value expression and the
 * calculation is a definition, exactly as `relationEquation` of {@link
 * ./solver} reads it (`node.kind === 'if'` is not a comparison, so it takes the
 * `self == expr` branch). Two surfaces disagreeing about which relations exist
 * is the divergence this whole layer was lifted to prevent.
 */
function topIsComparison(raw: string): boolean {
  const body = parseRelationBody(raw);
  if (!body) return false;
  const node = body.node;
  return node.kind === 'binary' && COMPARISON_OPS.has(node.op);
}

/** The operators whose top-level presence makes a body a claim. */
const COMPARISON_OPS = new Set(['==', '=', '!=', '<', '<=', '>', '>=']);

/**
 * Is this relation written under something the author said binds nothing?
 *
 * `isNonNormativeStatement` answers about ONE element, and a clause carries no
 * keyword of its own: the `#prose` is written on the requirement that owns it.
 * So the owners are walked. Without this, a `#prose requirement def` would be
 * dropped from the inventory by `contractsOf` and its `require` body would
 * still enter the worklist — as an obligation belonging to no contract in that
 * inventory, which is the two surfaces of one commit disagreeing about one
 * model.
 */
function underNonNormativeStatement(model: Model, el: ElementRecord): boolean {
  for (let cur = el.ownerId; cur != null; ) {
    const owner = model.get(cur);
    if (!owner) return false;
    if (isNonNormativeStatement(model, owner.id)) return true;
    cur = owner.ownerId;
  }
  return false;
}

/** The requirement or case a clause belongs to, walking out through an objective. */
function owningContract(
  model: Model,
  el: ElementRecord,
  byId: ReadonlyMap<ElementId, Contract>,
): Contract | undefined {
  for (let cur = el.ownerId; cur != null; ) {
    const owner = model.get(cur);
    if (!owner) return undefined;
    const contract = byId.get(owner.id);
    if (contract) return contract;
    cur = owner.ownerId;
  }
  return undefined;
}

/** The status a reading earns, before any evidence exists to change it. */
function statusOf(encodable: Encodable): ObligationStatus {
  return encodable === true ? 'open' : 'not-encodable';
}

/**
 * Every obligation, premise and axiom in the user's own model.
 *
 * The order is the model's own: relations first, in declaration order, then the
 * feature values and the binding edges, then one `no-formal-clause` row per
 * requirement that carries no relation at all. That last group is what makes
 * the worklist COMPLETE over the requirement set: a requirement with prose and
 * no constraint body is the commonest thing a real requirement set is full of,
 * and omitting it would let `--missing` under-state exactly what it exists to
 * measure.
 */
export function obligationsOf(model: Model, opts: ObligationOptions = {}): Obligation[] {
  const inScope = scopeFilter(model, opts.scopeId);
  const memo: DerivationMemo = new Map();
  const contracts = contractsOf(model);
  const byId = new Map<ElementId, Contract>(contracts.map((c) => [c.id, c]));
  const out: Obligation[] = [];
  /** Requirements that contributed at least one relation, for the `no-formal-clause` sweep. */
  const withClause = new Set<ElementId>();
  /** Every relation read, as it was filed: what {@link satisfierRows} reads again at a satisfier. */
  const read = new Map<ElementId, FiledRelation>();

  for (const el of model.all()) {
    if (!isUserModelElement(model, el) || !inScope(el)) continue;
    if (!RELATION_KINDS.has(el.eClass)) continue;
    // A `#prose` / `#prompt` relation binds nothing — the author said so. The
    // tag may be on the clause or on the requirement that owns it, and both
    // readings have to agree with `contractsOf`, which drops the whole
    // requirement.
    if (isNonNormativeStatement(model, el.id) || underNonNormativeStatement(model, el)) continue;
    const raw = el.attrs.expression;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const asWritten = roleOf(el, topIsComparison(raw));
    if (!asWritten) continue;
    const filed = opts.fromKeywords ? keywordRole(model, el, asWritten) : asWritten;
    const reading = readRelation(
      model,
      el,
      raw,
      memo,
      // A calculation's bare body defines the calculation itself, so the
      // relation is the joining equality rather than the expression alone.
      filed.source === 'calculation' && el.declaredName ? el.declaredName : undefined,
    );
    const contract = owningContract(model, el, byId);
    if (contract) withClause.add(contract.id);
    const encodable =
      filed.source === 'calculation' && isParameterisedCalculation(model, el)
        ? parameterisedCalculation(reading.encodable)
        : usageOwnedGoal(
            model,
            el,
            filed.role,
            relationNamesOf(raw),
            unreadAxiom(filed.role, reading.encodable, reading.unread),
          );
    const instances = filed.source !== 'calculation' ? instanceRows(model, el, raw, filed, memo, contract) : undefined;
    if (filed.source !== 'calculation') read.set(el.id, { el, raw, filed, ...(contract ? { contract } : {}) });
    const sharedWith = instances?.shared[0];
    out.push({
      requirement: contract ? contractRef(contract) : null,
      shortId: contract?.shortId ?? '',
      subject: contract?.subject ?? null,
      role: filed.role,
      source: filed.source,
      element: ref(model, el),
      // The relation as read, which for a calculation is the joining equality
      // (`c1 == s.a + s.b`) rather than the value expression alone.
      expression: reading.expression,
      node: reading.node,
      vars: reading.variables,
      sortPerVar: reading.sortPerVar,
      scaled: reading.scale !== undefined,
      encodable: sharedWith ? sharedAtOwner(model, el, sharedWith, encodable) : encodable,
      nonlinear: reading.nonlinear,
      verifiedBy: contract?.verifiedBy ?? [],
      method: contract ? methodOf(model, contract.id) : null,
      evidence: [],
      status: statusOf(sharedWith ? sharedAtOwner(model, el, sharedWith, encodable) : encodable),
      ...claimed(model, contract),
      ...(filed.provenance ? { provenance: filed.provenance } : {}),
      ...readFields(reading),
    });
    if (instances) out.push(...instances.rows);
  }

  for (const el of model.all()) {
    if (!isUserModelElement(model, el) || !inScope(el)) continue;
    const row = featureValueAxiom(model, el, memo);
    if (row) out.push(row);
    out.push(...bindingRows(model, el, memo));
  }
  // A redefinition that states nothing — an implicit connector-end copy
  // included — reads the value it redefines in its own context.
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || !inScope(el)) continue;
    const row = redefinedValueAxiom(model, el, memo);
    if (row) out.push(row);
  }
  out.push(...clashRows(model, memo, inScope));

  for (const el of model.all()) {
    if (!isUserModelElement(model, el) || !inScope(el)) continue;
    if (!isBindingEdge(el)) continue;
    const row = bindAxiom(model, el, memo);
    if (row) out.push(row);
    out.push(...bindingInstanceRows(model, el, memo));
  }
  out.push(...satisfierRows(model, out, read, memo, inScope));
  out.push(...instanceRelationRows(model, out, memo));

  for (const contract of contracts) {
    if (withClause.has(contract.id)) continue;
    // A usage whose DEFINITION carries the clauses has a body; it simply does
    // not own it. Filing it as `no-formal-clause` would say something false
    // about the model ("prose only, nothing to encode" about a requirement with
    // a constraint) and would inflate `--missing`, which is the figure §6 calls
    // the deliverable that measures encodability. The clause is filed once, on
    // the definition's own row.
    if (contract.clausesInheritedFrom.length > 0) continue;
    if (opts.scopeId !== undefined && !inScope(model.require(contract.id))) continue;
    out.push({
      requirement: contractRef(contract),
      shortId: contract.shortId,
      subject: contract.subject,
      role: 'obligation',
      source: 'none',
      element: contractRef(contract),
      expression: '',
      node: null,
      vars: [],
      sortPerVar: {},
      scaled: false,
      encodable: {
        reason: 'no-formal-clause',
        detail: 'the requirement carries prose and no constraint body, so there is nothing to encode',
      },
      nonlinear: false,
      verifiedBy: contract.verifiedBy,
      method: methodOf(model, contract.id),
      evidence: [],
      status: 'no-formal-clause',
      ...claimed(model, contract),
    });
  }

  return opts.missing
    ? out.filter((o) => o.status === 'no-formal-clause' || o.status === 'not-encodable')
    : out;
}

/** A contract, as the reference every row carries. */
function contractRef(contract: Contract): ContractRef {
  return {
    id: contract.id,
    eClass: contract.eClass,
    ...(contract.declaredName !== undefined ? { declaredName: contract.declaredName } : {}),
    qualifiedName: contract.qualifiedName,
  };
}

/** The `verificationMethod` facet, when the requirement declares one. */
function methodOf(model: Model, id: ElementId): string | null {
  const el = model.get(id);
  if (!el || !REQUIREMENT_KINDS.has(el.eClass)) return null;
  return getRequirementAttr(model, id, 'verificationMethod') ?? null;
}

/** The `verdict` a file claims with nothing behind it, as a spreadable field. */
function claimed(
  model: Model,
  contract: Contract | undefined,
): { claimedVerdict?: string } {
  if (!contract) return {};
  const verdict = claimedVerdictOf(model, contract.id);
  return verdict === undefined ? {} : { claimedVerdict: verdict };
}

/**
 * A feature value read as an axiom.
 *
 * A `=` value is a BINDING in KerML, not a default, so it is a fact the proof
 * context carries. Two shapes reach this function and both are axioms: a
 * literal (`mtow = 18.5 [kg]`), whose axiom is the synthetic equality
 * `mtow == 18.5` in the magnitude the file stores ({@link literalAxiom}); and
 * an expression (`endurance = capacity * f / power`, or `total = (k * 2.0)
 * [GiB]` with its unit), whose axiom is the joining equality the numeric
 * surface already builds.
 *
 * A quoted string value is not a numeric axiom — the requirement-facet carrier
 * writes `attribute status = "open";`, and reading that as a relation would put
 * a requirement's metadata into a proof.
 *
 * NOR IS A METADATA VALUE, for the same reason: a feature of a metadata usage
 * or definition ANNOTATES an element (`@VerificationMethod { kind = (analyze,
 * test); }`, `metadata rk : Risk { :>> level = 3.0; }`) and states nothing
 * about the design. Read as an axiom it was worse than noise: `kind = (analyze,
 * test)` does not parse, so its refusal read nothing and its reach was unknown
 * — a relation that might matter to every requirement set — and `consistency
 * --with-values` stood every set of the file down over an annotation. No
 * relation body can name such a feature either (`p.rk.level` resolves to
 * nothing), so nothing a verdict reads is lost by leaving it out.
 */
function featureValueAxiom(
  model: Model,
  el: ElementRecord,
  memo: DerivationMemo,
): Obligation | undefined {
  const raw = el.attrs.value;
  const name = effectiveNameOf(model, el);
  if (name === undefined || name === '') return undefined;
  if (raw === undefined || raw === null) return undefined;
  if (RELATION_KINDS.has(el.eClass)) return undefined;
  if (underMetadata(model, el)) return undefined;
  // A `default` a binding overrides is no fact: the binding's axiom is.
  if (defaultGivesWay(model, el)) return undefined;

  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return literalAxiom(model, el, name, raw, memo);
  }
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (text === '') return undefined;
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    return undefined;
  }
  // `(k * 2.0) [GiB]` is `k * 2.0` in GiB: the unit beside the expression is
  // part of the value, as the evaluator and the solver lane read it.
  const reading = readRelation(model, el, text, memo, name, el);
  return {
    requirement: null,
    shortId: '',
    subject: null,
    role: 'axiom',
    source: 'feature-value',
    element: ref(model, el),
    expression: reading.expression,
    node: reading.node,
    vars: reading.variables,
    sortPerVar: reading.sortPerVar,
    scaled: reading.scale !== undefined,
    encodable: unreadAxiom('axiom', reading.encodable, reading.unread),
    nonlinear: reading.nonlinear,
    verifiedBy: [],
    method: null,
    evidence: [],
    status: statusOf(unreadAxiom('axiom', reading.encodable, reading.unread)),
    ...readFields(reading),
  };
}

/** The metaclasses whose features annotate an element rather than describe the design. */
const METADATA_KINDS = new Set(['MetadataUsage', 'MetadataDefinition']);

/** Is `el` owned, at any depth, by a metadata usage or definition? See {@link featureValueAxiom}. */
function underMetadata(model: Model, el: ElementRecord): boolean {
  for (let o = el.ownerId; o != null; ) {
    const owner = model.get(o);
    if (!owner) return false;
    if (METADATA_KINDS.has(owner.eClass)) return true;
    o = owner.ownerId;
  }
  return false;
}

/**
 * The element a row reads: the model's own for an ordinary row, and for one
 * read in a context ({@link Obligation.instance}) the relation it reads, with
 * that context as its owner — the scope every evaluator then reads it in.
 */
export function rowElement(model: Model, row: Pick<Obligation, 'element' | 'instance'>): ElementRecord | undefined {
  if (!row.instance) return model.get(row.element.id);
  const base = model.get(row.instance.baseId);
  return base ? { ...base, ownerId: row.instance.contextId } : undefined;
}

/** The fields a row takes from what its reading met: unread names, their inputs, shadowed names. */
function readFields(reading: RelationReading): Pick<Obligation, 'unread' | 'unreadDeps' | 'shadowed'> {
  return {
    ...(reading.unread ? { unread: reading.unread } : {}),
    ...(reading.unreadDeps && reading.unreadDeps.length > 0 ? { unreadDeps: reading.unreadDeps } : {}),
    ...(reading.shadowed ? { shadowed: reading.shadowed } : {}),
  };
}

/**
 * A definition's assert or plain constraint, read in every context that
 * specialises the definition and reads it DIFFERENTLY
 * ({@link DefiningEquations.changingContexts}): one row per such context,
 * the relation read with its owner's names replaced by the context's — the
 * same role, the same source, and the context's reading.
 *
 * SysML makes a constraint usage of P a feature of every P, so `P::cLoad` is
 * a claim about `p` too: proved at P's own values while `part p : P {
 * attribute :>> load = 50.0; }` (over a `default`) violates it was a false
 * proof, and an assert of P that `p` breaks — `assert constraint lim { load
 * <= 10.0 }` — made the axioms of the model inconsistent where every engine
 * still proved from them. Each instance is an obligation (a plain
 * constraint) or an axiom (an assert) of its own, so a refutation in `p`
 * stands beside P's own verdict, and a broken assert is a contradiction. A
 * model whose specialisations change nothing a relation reads has none.
 */
function instanceRows(
  model: Model,
  el: ElementRecord,
  raw: string,
  filed: FiledRole,
  memo: DerivationMemo,
  contract?: Contract,
  only?: readonly ElementRecord[],
): { rows: Obligation[]; shared: Array<{ context: ElementRecord; vars: ContractVariable[] }> } {
  const body = parseRelationBody(raw);
  if (!body) return { rows: [], shared: [] };
  const names = namesOf(body.node).filter((n) => !body.literals.has(n));
  const out: Obligation[] = [];
  const sharedOut: Array<{ context: ElementRecord; vars: ContractVariable[] }> = [];
  const definitions = sharedDefinitions(model);
  for (const context of only ?? definitions.readingContexts(el, names)) {
    // A context listed only because a binding member reads its own value there
    // (M7's q2) is read by no surface yet: its goal is refused in the sentence
    // the check gives it, and an assert adds no axiom there.
    const boundOnly = !only && definitions.readsBoundOnly(el, names, context.id);
    if (boundOnly && filed.role === 'axiom') continue;
    // Read for the context's own instance: a feature the relation owns (a
    // constraint's `attribute k`) is the context's, one per context, and not
    // the symbol the relation's own reading and every other context share.
    const instance = definitions.instanceNameOf(context.id);
    const reading = readRelation(model, { ...el, ownerId: context.id }, raw, memo, undefined, undefined, instance);
    const own = unreadAxiom(filed.role, reading.encodable, reading.unread);
    const shared = filed.role === 'axiom' && own === true ? sharedSymbolsOf(model, context, reading) : [];
    if (shared.length > 0) sharedOut.push({ context, vars: shared });
    const encodable: Encodable = boundOnly
      ? reading.encodable === true
        ? { reason: 'unread-definition', detail: boundHereSentence(definitions, context.id) }
        : reading.encodable
      : boundAbove(
          model,
          context,
          names,
          filed.role === 'axiom' ? sharedSymbolAxiom(model, context, reading, own) : reading.encodable,
        );
    out.push({
      // A requirement's clauses read in one context are a requirement of their
      // own there: its assumptions are the premises of its goals, never of
      // the requirement's own reading.
      requirement: contract ? instanceRef(model, contractRef(contract), context) : null,
      shortId: contract?.shortId ?? '',
      subject: contract?.subject ?? null,
      role: filed.role,
      source: filed.source,
      element: instanceRef(model, el, context),
      expression: reading.expression,
      node: reading.node,
      vars: reading.variables,
      sortPerVar: reading.sortPerVar,
      scaled: reading.scale !== undefined,
      encodable,
      nonlinear: reading.nonlinear,
      verifiedBy: [],
      method: null,
      evidence: [],
      status: statusOf(encodable),
      ...readFields(reading),
      instance: { baseId: el.id, contextId: context.id, ...(contract ? { requirementId: contract.id } : {}) },
    });
  }
  return { rows: out, shared: sharedOut };
}

/**
 * The encodability of a relation read in the usage `context` whose reading
 * there is not the same for every instance of the usage's owner — a binding
 * of the owner joins what it reads to another value in a context that
 * specialises the owner ({@link DefiningEquations.boundAbove}). Read in `Q::p`
 * for Q's own p, P's `load <= 10.0` was PROVED at Q's `L default = 1.0`,
 * which Q's `bind p.load = L` gives p's load — while q's p, whose L is 50,
 * breaks it, and no context names q's p. Refused, whatever the gates said.
 */
function boundAbove(model: Model, context: ElementRecord, names: readonly string[], encodable: Encodable): Encodable {
  if (encodable !== true) return encodable;
  const definitions = sharedDefinitions(model);
  const above = definitions.boundAbove(context.id, names);
  if (!above) return encodable;
  return { reason: 'unread-definition', detail: boundAboveSentence(definitions, context.id, above) };
}

/**
 * The encodability of a GOAL — a constraint, a `require`d clause or an
 * assumption — written in a usage that stands for several instances, one of
 * which a binding above it reads otherwise ({@link usageOwnedRefusal}):
 * refused, whatever the gates said. R17c's `part p : P { constraint c2 {
 * load <= 10.0 } }` in Q was PROVED at Q's own L, which Q's `bind p.load = L`
 * gives p's load, while q's p — L of 50 — breaks it. An asserted relation
 * keeps its axiom: read for the usage's generic instance, it is a weaker
 * assumption than the one every instance holds, and sound.
 */
function usageOwnedGoal(
  model: Model,
  el: ElementRecord,
  role: ObligationRole,
  names: readonly string[],
  encodable: Encodable,
): Encodable {
  if (encodable !== true || role === 'axiom') return encodable;
  const detail = usageOwnedRefusal(model, el, names);
  return detail ? { reason: 'unread-definition', detail } : encodable;
}

/** A relation as {@link obligationsOf} filed it: what {@link satisfierRows} reads again. */
interface FiledRelation {
  el: ElementRecord;
  raw: string;
  filed: FiledRole;
  contract?: Contract;
}

/**
 * A requirement's clauses read where its subject is BOUND — at the satisfier
 * of a `satisfy R by x` (KerML's SatisfyRequirementUsage, {@link
 * DefiningEquations.satisfaction}), and in a usage of R that binds its
 * subject by value (`requirement r1 : R { subject s = q1; }`) — when the
 * instance bound holds something R's generic subject does not, and no value
 * tells the two readings apart, so {@link DefiningEquations.readingContexts}
 * does not: only their symbols do.
 *
 * R's `s.x <= 0.0` over `subject s : P` is read at the generic P, whose x
 * nothing pins; at a satisfier `p1 { assert constraint { x >= 1.0 } }`, at a
 * `q1.p` whose Q asserts `p.x >= 1.0`, or at an x some relation of the model
 * reads (`assert constraint { p1.x >= 1.0 }`), it is read over p1's own x,
 * which the model constrains. Read only at P, `consistency` called a model
 * consistent whose satisfier cannot meet R. A subject bound to an instance
 * that holds exactly what the generic subject holds — typed by the subject's
 * type alone, saying nothing of its own, enclosed by no instance, read by
 * nothing else — reads R as the generic subject does under other names, and
 * adds no row.
 */
function satisfierRows(
  model: Model,
  rows: readonly Obligation[],
  read: ReadonlyMap<ElementId, FiledRelation>,
  memo: DerivationMemo,
  inScope: (el: ElementRecord) => boolean,
): Obligation[] {
  const definitions = sharedDefinitions(model);
  const out: Obligation[] = [];
  const own = new Map<ElementId, Obligation>();
  for (const r of rows) if (!r.instance) own.set(r.element.id, r);
  let reached: Set<string> | undefined;
  // Every symbol a row of the model reads, and every instance it reads through.
  const readThrough = (): Set<string> => {
    if (reached) return reached;
    reached = new Set();
    for (const r of rows) {
      for (const v of r.vars) {
        reached.add(v.qualifiedName);
        if (!v.instance) continue;
        reached.add(v.instance.path);
        for (const e of v.instance.enclosing) reached.add(e.instance);
      }
    }
    return reached;
  };
  const readsUnder = (instance: string): boolean => {
    for (const name of readThrough()) if (name === instance || name.startsWith(`${instance}::`)) return true;
    return false;
  };
  for (const context of model.all()) {
    if (context.eClass !== 'Satisfy' && context.eClass !== 'RequirementUsage') continue;
    if (!isUserModelElement(model, context) || !inScope(context)) continue;
    const subject = definitions.subjectInstance(context.id);
    if (!subject) continue;
    const members = model
      .children(subject.requirement.id)
      .map((c) => read.get(c.id))
      .filter((m): m is FiledRelation => m !== undefined);
    // None, or read there already for a value that differs.
    if (members.length === 0 || members.some((m) => readAt(rows, m.el.id, context.id))) continue;
    const type = definitions.subjectTypeOf(subject.requirement.id);
    const kinds = new Set([type?.id, ...(type ? generalizationsOf(model, type.id).map((g) => g.id) : [])]);
    const distinguished =
      definitions.saysOwn(subject.bound) ||
      generalizationsOf(model, subject.bound.id).some((g) => g.attrs.isLibrary !== true && !kinds.has(g.id)) ||
      subject.enclosing.some((e) => !/Package$/.test(model.get(e.reader)?.eClass ?? 'Package')) ||
      readsUnder(subject.instance);
    if (!distinguished) continue;
    const instance = definitions.instanceNameOf(context.id);
    const differs = members.some((m) => {
      const reading = readRelation(model, { ...m.el, ownerId: context.id }, m.raw, memo, undefined, undefined, instance);
      const generic = own.get(m.el.id);
      const symbols = (vars: readonly ContractVariable[]): string => vars.map((v) => v.qualifiedName).join(' ');
      return !generic || symbols(generic.vars) !== symbols(reading.variables);
    });
    if (!differs) continue;
    for (const m of members) out.push(...instanceRows(model, m.el, m.raw, m.filed, memo, m.contract, [context]).rows);
  }
  return out;
}

/** Is the relation `id` read in the context `contextId` among `rows` already? */
function readAt(rows: readonly Obligation[], id: ElementId, contextId: ElementId): boolean {
  return rows.some((r) => r.instance?.baseId === id && r.instance.contextId === contextId);
}

/**
 * The encodability of an AXIOM read in `context` — an assert of a definition
 * read in a context that specialises it, a binding read in a redefinition's
 * context — that reads a SHARED symbol no literal pins: a feature outside the
 * context's own tree (`P::x`, read in `part q : P` that does not redefine
 * `x`), which every instance of its owner reads as one symbol, and whose value
 * no literal states. Refused, whatever the gates said, with its variables kept
 * so every reach guard still meets it.
 *
 * The symbol stands for every P's `x` at once, so q's own fact over it pins
 * every P's: `assert constraint ax { x >= a }` read in q, where `a` is 100,
 * made `p.x >= 99.0` PROVED for a p whose `a` is 5, and two instances each
 * consistent on its own made the model's axioms inconsistent. A literal pins
 * its symbol to one value in every instance, so reading one is safe; a
 * symbol of the context's own is the context's alone. Until the verification
 * lane has a symbol per instance, a fact about one instance over a symbol all
 * of them share is not carried.
 */
function sharedSymbolAxiom(
  model: Model,
  context: ElementRecord,
  reading: RelationReading,
  encodable: Encodable,
): Encodable {
  if (encodable !== true) return encodable;
  const shared = sharedSymbolsOf(model, context, reading);
  if (shared.length === 0) return encodable;
  const contextName = sharedDefinitions(model).contextName(context.id);
  return {
    reason: 'unread-definition',
    detail:
      `the axiom is read in ${contextName}, and reads ${shared
        .map((v) => `\`${v.path}\` as ${v.qualifiedName}`)
        .join(', ')} — a symbol every instance of its owner shares, and no literal pins it; asserted, ` +
      `it would pin that feature in every instance by what holds in ${contextName} alone, so it is not carried`,
  };
}

/**
 * The variables of a reading in `context` that {@link sharedSymbolAxiom} would
 * not carry an axiom over: those read by the feature's OWN symbol, from
 * outside the context, where no value pins it in every instance. A variable
 * read through an instance of its own has the instance's symbol
 * ({@link ContractVariable.instance}) and shares it with no other.
 */
function sharedSymbolsOf(model: Model, context: ElementRecord, reading: RelationReading): ContractVariable[] {
  const definitions = sharedDefinitions(model);
  return reading.variables.filter((v) => {
    if (v.symbol !== undefined || v.instance !== undefined) return false;
    const f = model.get(v.featureId);
    if (!f) return true;
    if (within(model, f, context.id) || pinnedByLiteral(model, f)) return false;
    return !(f.ownerId != null && definitions.pinnedIn(f.ownerId, f));
  });
}

/**
 * The encodability of a definition's OWN assert, read at its own values, where
 * a context that specialises the definition reads it with other inputs over a
 * symbol both share ({@link sharedSymbolAxiom}) — refused the same way. The
 * symbol is every instance's: `x >= a` at P's `a` of 2, asserted over P's `x`,
 * pinned the x of a `p` whose `a` is 0 above 2, and `p.x >= 1.0` was PROVED
 * where p's own assert allows 0.
 */
function sharedAtOwner(
  model: Model,
  el: ElementRecord,
  shared: { context: ElementRecord; vars: ContractVariable[] },
  encodable: Encodable,
): Encodable {
  if (encodable !== true) return encodable;
  const contextName = sharedDefinitions(model).contextName(shared.context.id);
  const owner = el.ownerId != null ? effectiveQualifiedName(model, el.ownerId) : 'its owner';
  return {
    reason: 'unread-definition',
    detail:
      `the axiom reads ${shared.vars.map((v) => `\`${v.path}\` as ${v.qualifiedName}`).join(', ')} — a symbol ` +
      `every instance of ${owner} shares, and no literal pins it — and ${contextName} reads it with inputs of its ` +
      `own; asserted at ${owner}'s values it would pin that feature in ${contextName} too, so it is not carried`,
  };
}

/** Is `f` owned, at any depth, by `contextId`? */
function within(model: Model, f: ElementRecord, contextId: ElementId): boolean {
  const seen = new Set<ElementId>();
  for (let cur = f.ownerId; cur != null && !seen.has(cur); cur = model.get(cur)?.ownerId ?? null) {
    if (cur === contextId) return true;
    seen.add(cur);
  }
  return false;
}

/**
 * Does `f` state a literal — a number or a boolean — that pins its symbol in
 * every instance? Not a `default` a binding overrides, which pins nothing.
 */
function pinnedByLiteral(model: Model, f: ElementRecord): boolean {
  const v = f.attrs.value;
  return (typeof v === 'number' || typeof v === 'boolean') && !defaultGivesWay(model, f);
}

/**
 * The BINDING a redefinition's own value conflicts with, as an axiom of the
 * redefinition: `p::load == 1.0` beside `p::load == 50.0`, for `part p : P {
 * attribute :>> load = 50.0; }` over P's `attribute load = 1.0`
 * ({@link contradictedBindingOf}).
 *
 * A value written with `=` binds the feature in EVERY context that
 * specialises its owner, a redefinition's included — only `default` is
 * overridable — so the model states both values: where they differ the axiom
 * set is inconsistent, no engine may prove anything from it, and
 * `consistency` names the two rows that collide; where only an evaluation
 * could compare them, the solver decides. The binding's value is read in the
 * redefinition's own context, its name the redefinition, and a literal with
 * its unit (`1.0 [kg]` against a redefinition written in grams is the SAME
 * quantity once both are read in SI). Every other redefinition restates a
 * binding, overrides a default, or states nothing, and has no such row.
 */
function bindingRows(model: Model, el: ElementRecord, memo: DerivationMemo): Obligation[] {
  const conflict = contradictedBindingOf(model, el);
  const context = el.ownerId != null ? model.get(el.ownerId) : undefined;
  const name = effectiveNameOf(model, el);
  if (!conflict || !context || name === undefined) return [];
  const { binding } = conflict;
  const raw = binding.attrs.value;
  if (raw === undefined || raw === null) return [];
  const unit = typeof binding.attrs.unit === 'string' ? binding.attrs.unit.trim() : '';
  let reading: RelationReading;
  // A bare literal states the stored magnitude, verbatim, as the
  // redefinition's own {@link literalAxiom} does.
  let verbatim = false;
  if (typeof raw === 'number' && unit !== '') {
    // A literal WITH its unit, read in SI as an author's `[unit]` literal is:
    // `mass == 1.0 [kg]` meets the redefinition's stored grams.
    const text = `${typeof binding.attrs.valueText === 'string' ? binding.attrs.valueText : String(raw)} [${unit}]`;
    reading = literalEquality(model, name, el.id, text, memo);
  } else if (typeof raw === 'number' || typeof raw === 'boolean') {
    const text = longLexemeOf(raw, binding.attrs.valueText);
    const node: ExprNode = {
      kind: 'binary',
      op: '==',
      left: { kind: 'ref', path: [name] },
      right:
        typeof raw === 'boolean'
          ? { kind: 'bool', value: raw }
          : { kind: 'num', value: raw, ...(text !== undefined ? { text } : {}) },
    };
    const nameToId = new Map<string, ElementId>([[name, el.id]]);
    reading = gateRelation(model, node, nameToId, NO_MARKERS, false, memo, true, `${name} == ${text ?? String(raw)}`);
    verbatim = true;
  } else if (typeof raw === 'string' && raw.trim() !== '' && !/^(["']).*\1$/s.test(raw.trim())) {
    reading = readRelation(model, { ...el, ownerId: context.id }, raw.trim(), memo, name, binding);
  } else {
    return [];
  }
  const encodable = sharedSymbolAxiom(model, context, reading, unreadAxiom('axiom', reading.encodable, reading.unread));
  return [
    {
      requirement: null,
      shortId: '',
      subject: null,
      role: 'axiom',
      source: 'feature-value',
      element: instanceRef(model, binding, context),
      expression: reading.expression,
      node: reading.node,
      vars: reading.variables,
      sortPerVar: reading.sortPerVar,
      scaled: !verbatim && reading.scale !== undefined,
      encodable,
      nonlinear: reading.nonlinear,
      verifiedBy: [],
      method: null,
      evidence: [],
      status: statusOf(encodable),
      ...readFields(reading),
      instance: { baseId: binding.id, contextId: context.id, featureId: el.id },
    },
  ];
}

/**
 * Two LITERAL bindings a context inherits under one name and that differ
 * ({@link DefiningEquations.clash}, `decided`), as an axiom: the other
 * binding's value, read for the feature the name keeps there — `A::load ==
 * 7.0` beside A's own `A::load == 5.0`, for `part def C :> A, B`. Every C is
 * an A and a B, and the model states both values, so the axiom set is
 * inconsistent. Where only an evaluation could compare the two, no row is
 * filed: the kept feature's symbol is shared with every A, which a value read
 * in C must not pin, and the name reads no value in C on any surface.
 */
function clashRows(model: Model, memo: DerivationMemo, inScope: (el: ElementRecord) => boolean): Obligation[] {
  const out: Obligation[] = [];
  for (const { context, name, clash } of sharedDefinitions(model).contradictoryClashes()) {
    if (!clash.decided || !inScope(context)) continue;
    const raw = clash.otherValue.attrs.value;
    const unit = typeof clash.otherValue.attrs.unit === 'string' ? clash.otherValue.attrs.unit.trim() : '';
    const text =
      typeof raw === 'number'
        ? `${typeof clash.otherValue.attrs.valueText === 'string' ? clash.otherValue.attrs.valueText : String(raw)}${unit !== '' ? ` [${unit}]` : ''}`
        : String(raw);
    const reading = literalEquality(model, name, clash.keptValue.id, text, memo);
    const encodable = sharedSymbolAxiom(model, context, reading, reading.encodable);
    out.push({
      requirement: null,
      shortId: '',
      subject: null,
      role: 'axiom',
      source: 'feature-value',
      element: instanceRef(model, clash.otherValue, context),
      expression: reading.expression,
      node: reading.node,
      vars: reading.variables,
      sortPerVar: reading.sortPerVar,
      scaled: reading.scale !== undefined,
      encodable,
      nonlinear: reading.nonlinear,
      verifiedBy: [],
      method: null,
      evidence: [],
      status: statusOf(encodable),
      ...readFields(reading),
      instance: { baseId: clash.otherValue.id, contextId: context.id, featureId: clash.keptValue.id },
    });
  }
  return out;
}

/**
 * `name == <literal>` over the feature `featureId`, gated as an author's
 * relation is — a `[unit]` literal read in SI, the feature scaled to meet it —
 * and read by no scope: the literal reads no name, and the name is the
 * feature's whatever the scope around it would make of it.
 */
function literalEquality(
  model: Model,
  name: string,
  featureId: ElementId,
  literal: string,
  memo: DerivationMemo,
): RelationReading {
  const text = `${name} == ${literal}`;
  const body = parseRelationBody(text);
  const nameToId = new Map<string, ElementId>([[name, featureId]]);
  if (!body || (body.hadUnit && !body.resolved)) {
    // Gated over an unparseable side, the reading is refused with the gates' own reason.
    return gateRelation(model, { kind: 'ref', path: [`${name} == ${literal}`] }, nameToId, NO_MARKERS, false, memo, false, text);
  }
  return gateRelation(model, body.node, nameToId, body.literals, body.hadUnit, memo, false, text);
}

/** Every dotted path an expression names, once each. */
function namesOf(node: ExprNode): string[] {
  const out = new Set<string>();
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'ref':
        out.add(n.path.join('.'));
        return;
      case 'unary':
        walk(n.operand);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'if':
        walk(n.cond);
        walk(n.then);
        walk(n.else);
        return;
      default:
        return;
    }
  };
  walk(node);
  return [...out];
}

/**
 * The axiom a literal feature value states, in the magnitude the FILE STORES.
 *
 * `mtow = 18.5 [kg]` states `mtow == 18.5`, not `mtow == 18.5` converted into
 * something else, and `capacity = 640.0 [Wh]` states `capacity == 640`. The
 * variable denotes the stored magnitude everywhere in this lane — that is the
 * encoder's own charter, "one variable per feature, declared in its STORAGE
 * unit, read in SI" — and each relation lifts its reads by whatever ITS OWN
 * scale map grants ({@link Obligation.scaled}).
 *
 * IT USED TO CONVERT THE MAGNITUDE INTO SI, and that was wrong in a way nothing
 * could see until a solver read the worklist. The converted number met an
 * unscaled variable: `capacity == 2304000` beside `endurance ==
 * 3600·capacity · … ` — one symbol pinned twice, 3600 times apart. Every
 * obligation over the model became "axioms inconsistent", which is a proof
 * from a contradiction and therefore no proof at all.
 *
 * SO THE ROW IS ALWAYS VERBATIM ({@link Obligation.scaled} `false`): the stored
 * literal against the stored magnitude, whatever scale the gates would grant
 * an author's `==` of the same shape. For a dimensioned unit they grant none
 * — `f == <bare literal>` is gate (c)'s declared-unit contract — but a unit of
 * DIMENSION ONE with a factor (`B`, `GiB`, `Hart`, `nat`, `mm/m`) is no
 * dimension against the bare literal, the gates scale it as they scale every
 * relation with something to convert, and the scaled reading pinned `cap =
 * 2.0 [GiB]` to 2 bits: `(= (* 8589934592.0 |cap|) 2.0)`. The row states what
 * the file stores; it compares nothing, so no scale is its to take.
 */
function literalAxiom(
  model: Model,
  el: ElementRecord,
  name: string,
  raw: number | boolean,
  memo: DerivationMemo,
): Obligation {
  const value = raw;
  const nameToId = new Map<string, ElementId>(idScopeFor(model, el.id));
  nameToId.set(name, el.id);
  // The parser's lexeme, where the double does not determine it (`text` on a
  // `num` node of ./expr): `m = 0.30000000000000001 [kg]` is read by the SMT
  // encoder as the double it parsed to, exactly as the same numeral written
  // in a relation body is, and never as the `0.3` that double prints as.
  const text = longLexemeOf(value, el.attrs.valueText);
  const node: ExprNode = {
    kind: 'binary',
    op: '==',
    left: { kind: 'ref', path: [name] },
    right:
      typeof value === 'boolean'
        ? { kind: 'bool', value }
        : { kind: 'num', value, ...(text !== undefined ? { text } : {}) },
  };
  const written = `${name} == ${text ?? String(value)}`;
  const reading = gateRelation(model, node, nameToId, NO_MARKERS, false, memo, true, written);
  return {
    requirement: null,
    shortId: '',
    subject: null,
    role: 'axiom',
    source: 'feature-value',
    element: ref(model, el),
    expression: reading.expression,
    node: reading.node,
    vars: reading.variables,
    sortPerVar: reading.sortPerVar,
    // Verbatim, whatever the gates' scale map says: see above.
    scaled: false,
    encodable: reading.encodable,
    nonlinear: reading.nonlinear,
    verifiedBy: [],
    method: null,
    evidence: [],
    status: statusOf(reading.encodable),
  };
}

/**
 * The lexeme `valueText` of a literal `value`, where the double does not
 * determine it — more than {@link DOUBLE_DIGITS} significant digits — and
 * `undefined` otherwise ({@link literalAxiom}).
 */
function longLexemeOf(value: number | boolean, lexeme: unknown): string | undefined {
  return typeof value === 'number' &&
    typeof lexeme === 'string' &&
    Number(lexeme) === value &&
    significantDigitsOf(lexeme) > DOUBLE_DIGITS
    ? lexeme
    : undefined;
}

/**
 * The feature a binding end is read as: the end itself, or — for a
 * redefinition that states nothing, the implicit copy a `bind cap = cell.x`
 * creates of Cell's `x` — the feature whose value it reads
 * ({@link DefiningEquations.carrier}), the one symbol every relation over
 * `cell.x` already reads. Bound to the copy, the equality met no relation:
 * `refine` read CellReq's `c.x <= 1.0` on `Cell::x` and γ on `Pack::cell::x`,
 * and called a decomposition that holds "not refined".
 */
function carriedEnd(model: Model, id: ElementId | undefined): ElementId | undefined {
  const end = id !== undefined ? model.get(id) : undefined;
  if (!end || end.ownerId == null) return id;
  return sharedDefinitions(model).carrier(end.ownerId, end).id;
}

/**
 * A binding edge read as an axiom.
 *
 * A binding is not a predicate: it states that two features DENOTE THE SAME
 * QUANTITY and publishes no verdict anywhere, so — unlike an author's `==` —
 * it converts across an affine map rather than being refused on one. That is
 * the `identity` exemption `bindingEquation` of {@link ./solver} relies on, and
 * it is passed here for the same reason.
 */
function bindAxiom(
  model: Model,
  el: ElementRecord,
  memo: DerivationMemo,
): Obligation | undefined {
  const a = carriedEnd(model, el.source?.[0]);
  const b = carriedEnd(model, el.target?.[0]);
  if (a === undefined || b === undefined) return undefined;
  const left = model.get(a);
  const right = model.get(b);
  if (!left || !right) return undefined;
  const nameToId = new Map<string, ElementId>([
    ['__l', a],
    ['__r', b],
  ]);
  const node: ExprNode = {
    kind: 'binary',
    op: '==',
    left: { kind: 'ref', path: ['__l'] },
    right: { kind: 'ref', path: ['__r'] },
  };
  const expression = `${model.qualifiedName(a)} == ${model.qualifiedName(b)}`;
  const reading = gateRelation(model, node, nameToId, NO_MARKERS, false, memo, true, expression);
  return {
    requirement: null,
    shortId: '',
    subject: null,
    role: 'axiom',
    source: 'bind',
    element: ref(model, el),
    expression,
    node: reading.node,
    vars: reading.variables,
    sortPerVar: reading.sortPerVar,
    scaled: reading.scale !== undefined,
    encodable: reading.encodable,
    nonlinear: reading.nonlinear,
    verifiedBy: [],
    method: null,
    evidence: [],
    status: statusOf(reading.encodable),
  };
}

/**
 * A binding edge of a definition, read in every context that specialises the
 * definition and reads its two ends DIFFERENTLY ({@link
 * DefiningEquations.changingContexts}) — as {@link instanceRows} reads a
 * definition's assert there: `bind p.load = L` in Q, read in `q : Q {
 * attribute :>> L = 50.0; }`, is `q.p.load == q.L`. A binding holds in every
 * instance of its owner, as an assert does; read only where it is written,
 * the model whose q binds P's `load = 1.0` to 50 did not contradict itself,
 * and `q.p.m2 >= 0.0` was PROVED from it — the same model with `assert
 * constraint { p.load == L }` was inconsistent.
 */
function bindingInstanceRows(model: Model, el: ElementRecord, memo: DerivationMemo): Obligation[] {
  if (el.ownerId == null) return [];
  const left = pathBelow(model, el.source?.[0], el.ownerId);
  const right = pathBelow(model, el.target?.[0], el.ownerId);
  if (left === undefined || right === undefined) return [];
  const definitions = sharedDefinitions(model);
  const out: Obligation[] = [];
  for (const context of definitions.changingContexts(el, [left, right])) {
    // Listed only because a member reads its own value there: no axiom yet.
    if (definitions.readsBoundOnly(el, [left, right], context.id)) continue;
    const reading = readRelation(
      model,
      { ...el, ownerId: context.id },
      `${left} == ${right}`,
      memo,
      undefined,
      undefined,
      definitions.instanceNameOf(context.id),
    );
    const encodable = sharedSymbolAxiom(model, context, reading, reading.encodable);
    out.push({
      requirement: null,
      shortId: '',
      subject: null,
      role: 'axiom',
      source: 'bind',
      element: instanceRef(model, el, context),
      expression: reading.expression,
      node: reading.node,
      vars: reading.variables,
      sortPerVar: reading.sortPerVar,
      scaled: reading.scale !== undefined,
      encodable,
      nonlinear: reading.nonlinear,
      verifiedBy: [],
      method: null,
      evidence: [],
      status: statusOf(encodable),
      ...readFields(reading),
      instance: { baseId: el.id, contextId: context.id },
    });
  }
  return out;
}

/**
 * The value a feature that states NONE reads, as an axiom of the feature —
 * where it is a redefinition (an implicit connector-end copy included) of one
 * that does, read in its own context because that context changes what the
 * value reads ({@link DefiningEquations.valueRef}): `bind w2 = p.m2` binds
 * p's copy of P's `m2 = 10.0 - load`, which in a `p` whose `:>> load = 50.0`
 * overrides a `default` is `m2 == 10.0 - load` over p's load — −40, where the
 * copy was a symbol nothing pinned. Where the context changes nothing, the
 * copy reads the value it redefines by that feature's own symbol, and has no
 * row. `undefined` for every other feature.
 */
function redefinedValueAxiom(model: Model, el: ElementRecord, memo: DerivationMemo): Obligation | undefined {
  if (el.ownerId == null || !isUsage(el.eClass) || RELATION_KINDS.has(el.eClass)) return undefined;
  if (el.attrs.value !== undefined && el.attrs.value !== null) return undefined;
  if (hasStatedValue(model, el)) return undefined;
  const definitions = sharedDefinitions(model);
  const name = definitions.nameOf(el);
  const read = definitions.redefinedValueOf(el);
  if (name === undefined || !read) return undefined;
  const text = statedValueOf(model, read.target);
  if (typeof text !== 'string' || text.trim() === '' || /^(["']).*\1$/s.test(text.trim())) return undefined;
  // Read as the copy's own value: the copy is the feature the equality names.
  const reading = readRelation(model, { ...read.target, id: el.id, ownerId: el.ownerId }, text.trim(), memo, name, read.target);
  const encodable = unreadAxiom('axiom', reading.encodable, reading.unread);
  return {
    requirement: null,
    shortId: '',
    subject: null,
    role: 'axiom',
    source: 'feature-value',
    element: ref(model, el),
    expression: reading.expression,
    node: reading.node,
    vars: reading.variables,
    sortPerVar: reading.sortPerVar,
    scaled: reading.scale !== undefined,
    encodable,
    nonlinear: reading.nonlinear,
    verifiedBy: [],
    method: null,
    evidence: [],
    status: statusOf(encodable),
    ...readFields(reading),
    instance: { baseId: read.target.id, contextId: el.ownerId, featureId: el.id },
  };
}

/**
 * How many relations {@link instanceRelationRows} reads for instances before
 * it stops: a type that contains itself (`part def T { part sub : T; }`) has
 * an instance at every depth. Every row that reads an instance it did not
 * reach is refused, never left over a symbol nothing constrains.
 */
const MAX_INSTANCE_RELATIONS = 16384;

/**
 * The relations an INSTANCE with symbols of its own holds
 * ({@link ContractVariable.instance}): for each feature a row reads through an
 * instance, the value it has there (`R::p::m2 == 10.0 - R::p::load`), and
 * every assert, and every binding, its reader's types hold — and the types of
 * every instance enclosing it (Sys's `bind p.load = q.load` for `s.q.load`) —
 * read in the instance, over the instance's symbols, and so on for what those
 * read.
 *
 * KerML gives every instance of P its own `load` and its own `m2`, and a
 * relation of P holds of each. One symbol per feature made every instance
 * one: `g1.g == g2.g` was PROVED of two values nothing relates, two
 * instances each consistent on its own were "inconsistent" together, and a
 * derived value read where it is not was P's. A symbol per instance makes
 * them apart; THESE rows make each one what P says it is — without them an
 * instance would be a free value, and `consistency` would call a model whose
 * instance breaks P's assert consistent.
 */
function instanceRelationRows(model: Model, rows: readonly Obligation[], memo: DerivationMemo): Obligation[] {
  const definitions = sharedDefinitions(model);
  const out: Obligation[] = [];
  const done = new Set<string>();
  // A definition's assert already read in a context that reads it otherwise
  // (`instanceRows`) is that context's own reading: not read again.
  for (const r of rows) {
    if (r.instance && r.instance.path === undefined && r.instance.featureId === undefined) {
      done.add(`${r.instance.baseId} ${definitions.instanceNameOf(r.instance.contextId)}`);
    }
  }
  const pending: ContractVariable[] = [];
  const read = (vars: readonly ContractVariable[]): void => {
    for (const v of vars) if (v.instance) pending.push(v);
  };
  for (const r of rows) read(r.vars);
  let budget = MAX_INSTANCE_RELATIONS;
  const file = (row: Obligation | undefined): void => {
    if (!row) return;
    out.push(row);
    budget--;
    read(row.vars);
  };
  // Every assert and binding of `reader`'s types, read for the instance `path`.
  const hold = (path: string, reader: ElementId): void => {
    const heldKey = `held ${reader} ${path}`;
    if (done.has(heldKey)) return;
    done.add(heldKey);
    const context = model.get(reader);
    if (!context) return;
    for (const holder of [context, ...generalizationsOf(model, reader).filter((g) => g.attrs.isLibrary !== true)]) {
      // The holder's own instance reads its relations as its own rows do.
      if (path === definitions.instanceNameOf(holder.id)) continue;
      for (const c of model.children(holder.id)) {
        if (!isUserModelElement(model, c)) continue;
        const key = `${c.id} ${path}`;
        if (done.has(key)) continue;
        if (isAsserted(c) && typeof c.attrs.expression === 'string' && c.attrs.expression.trim() !== '') {
          done.add(key);
          file(instanceAssertRow(model, c, context, path, memo));
        } else if (isBindingEdge(c)) {
          done.add(key);
          file(instanceBindRow(model, c, holder, context, path, memo));
        }
      }
    }
  };
  while (pending.length > 0 && budget > 0) {
    const v = pending.shift()!;
    const { path, reader, enclosing } = v.instance!;
    const context = model.get(reader);
    const target = model.get(v.featureId);
    if (!context || !target) continue;
    const valueKey = `value ${v.qualifiedName}`;
    if (!done.has(valueKey)) {
      done.add(valueKey);
      file(instanceValueRow(model, target, context, path, memo, v.qualifiedName));
    }
    // The instances that enclose it hold what THEIR types state of it too:
    // Sys's `bind p.load = q.load` of `s.q.load`, P's `assert sub.x <= 10.0`
    // of `p.sub.x`. Read for the instance alone, it was a value nothing
    // constrained.
    for (const e of enclosing) hold(e.instance, e.reader);
    hold(path, reader);
  }
  if (pending.length > 0) {
    // The budget ran out: every row that reads an instance left unread is refused.
    const unread = new Set(pending.map((v) => v.instance!.path));
    for (const row of [...rows, ...out]) refuseUnreadInstances(row, unread);
  }
  return out;
}

/** The element reference and instance of a relation read for the instance `path`. */
function instanceElement(model: Model, el: ElementRecord, path: string): ContractRef {
  return {
    ...ref(model, el),
    id: `${el.id}@${path}`,
    qualifiedName: `${effectiveQualifiedName(model, el.id)} in ${path}`,
  };
}

/**
 * The value `target` has in the instance `path` (read in `context`), whose
 * symbol there is `symbol`: its own value expression, or the value it reads
 * as a redefinition that states none, read there — or `undefined` for a
 * feature with no value to read (a free value of the instance's own).
 */
function instanceValueRow(
  model: Model,
  target: ElementRecord,
  context: ElementRecord,
  path: string,
  memo: DerivationMemo,
  symbol: string,
): Obligation | undefined {
  const definitions = sharedDefinitions(model);
  const name = definitions.nameOf(target);
  if (name === undefined) return undefined;
  const d = definitions.denote(context.id).get(name);
  const read = d ? definitions.valueRef(d) : undefined;
  const source = read?.target ?? (hasStatedValue(model, target) ? target : undefined);
  if (!source) return undefined;
  if (source.eClass === 'CalculationUsage' && isParameterisedCalculation(model, source)) return undefined;
  const text = statedValueOf(model, source);
  if (typeof text !== 'string' || text.trim() === '' || /^(["']).*\1$/s.test(text.trim())) return undefined;
  const reading = readRelation(model, { ...source, id: target.id, ownerId: context.id }, text.trim(), memo, name, source, path);
  const encodable = unreadAxiom('axiom', reading.encodable, reading.unread);
  return {
    requirement: null,
    shortId: '',
    subject: null,
    role: 'axiom',
    source: 'feature-value',
    element: instanceElement(model, target, path),
    expression: reading.expression,
    node: reading.node,
    vars: reading.variables,
    sortPerVar: reading.sortPerVar,
    scaled: reading.scale !== undefined,
    encodable,
    nonlinear: reading.nonlinear,
    verifiedBy: [],
    method: null,
    evidence: [],
    status: statusOf(encodable),
    ...readFields(reading),
    instance: { baseId: source.id, contextId: context.id, featureId: target.id, path, symbol },
  };
}

/** An assert of `context`'s types, read for the instance `path` of `context`. */
function instanceAssertRow(
  model: Model,
  el: ElementRecord,
  context: ElementRecord,
  path: string,
  memo: DerivationMemo,
): Obligation {
  const reading = readRelation(model, { ...el, ownerId: context.id }, (el.attrs.expression as string).trim(), memo, undefined, undefined, path);
  const encodable = sharedSymbolAxiom(model, context, reading, unreadAxiom('axiom', reading.encodable, reading.unread));
  return {
    requirement: null,
    shortId: '',
    subject: null,
    role: 'axiom',
    source: 'assert',
    element: instanceElement(model, el, path),
    expression: reading.expression,
    node: reading.node,
    vars: reading.variables,
    sortPerVar: reading.sortPerVar,
    scaled: reading.scale !== undefined,
    encodable,
    nonlinear: reading.nonlinear,
    verifiedBy: [],
    method: null,
    evidence: [],
    status: statusOf(encodable),
    ...readFields(reading),
    instance: { baseId: el.id, contextId: context.id, path },
  };
}

/**
 * A binding edge `holder` (one of `context`'s types) owns, read for the
 * instance `path` of `context`: its two ends named as `holder` names them,
 * and read where `context` reads them. `undefined` for an edge whose ends are
 * not features below `holder`.
 */
function instanceBindRow(
  model: Model,
  el: ElementRecord,
  holder: ElementRecord,
  context: ElementRecord,
  path: string,
  memo: DerivationMemo,
): Obligation | undefined {
  const left = pathBelow(model, el.source?.[0], holder.id);
  const right = pathBelow(model, el.target?.[0], holder.id);
  if (left === undefined || right === undefined) return undefined;
  const reading = readRelation(model, { ...el, ownerId: context.id }, `${left} == ${right}`, memo, undefined, undefined, path);
  return {
    requirement: null,
    shortId: '',
    subject: null,
    role: 'axiom',
    source: 'bind',
    element: instanceElement(model, el, path),
    expression: reading.expression,
    node: reading.node,
    vars: reading.variables,
    sortPerVar: reading.sortPerVar,
    scaled: reading.scale !== undefined,
    encodable: reading.encodable,
    nonlinear: reading.nonlinear,
    verifiedBy: [],
    method: null,
    evidence: [],
    status: statusOf(reading.encodable),
    ...readFields(reading),
    instance: { baseId: el.id, contextId: context.id, path },
  };
}

/** The dotted path of feature `id` below `ownerId`, by effective names — `undefined` when it is not below it. */
function pathBelow(model: Model, id: ElementId | undefined, ownerId: ElementId): string | undefined {
  const segments: string[] = [];
  const seen = new Set<ElementId>();
  for (let cur = id !== undefined ? model.get(id) : undefined; cur; cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
    if (cur.id === ownerId) return segments.length > 0 ? segments.join('.') : undefined;
    if (seen.has(cur.id)) return undefined;
    seen.add(cur.id);
    const name = effectiveNameOf(model, cur);
    if (name === undefined) return undefined;
    segments.unshift(name);
  }
  return undefined;
}

/**
 * Refuse `row` when it reads an instance whose relations were not read
 * ({@link MAX_INSTANCE_RELATIONS}): over a symbol nothing constrains, a proof
 * would rest on less than the model states.
 */
function refuseUnreadInstances(row: Obligation, unread: ReadonlySet<string>): void {
  if (row.encodable !== true) return;
  const hit = row.vars.filter((v) => v.instance && unread.has(v.instance.path));
  if (hit.length === 0) return;
  row.encodable = {
    reason: 'unread-definition',
    detail:
      `the relation reads ${hit.map((v) => `\`${v.path}\``).join(', ')} in an instance nested deeper than this tool ` +
      `reads the relations of (more than ${MAX_INSTANCE_RELATIONS}), so what the model states of it is not carried`,
  };
  row.status = statusOf(row.encodable);
}

/* ─────────────────────────── the proof footprint ─────────────────────────── */

/**
 * Is this feature-value axiom the binding of a feature the caller released?
 *
 * HERE RATHER THAN IN AN ENGINE because three readers need it and one of them
 * may not import an engine. It is a question about an {@link Obligation} row and
 * a `--free` set, and nothing about SMT: `bounds` drops the same rows, the SMT
 * engine drops the same rows, and {@link footprintOf} has to drop the same rows
 * or the footprint it reports would name axioms the run did not carry. Two
 * readings of one `--free` is how one command would answer over a design space
 * another one bounded differently.
 */
export function isFreedValueAxiom(row: Obligation, free: ReadonlySet<string>): boolean {
  if (free.has(row.element.qualifiedName)) return true;
  // A binding read in a redefinition's context binds the REDEFINITION: freed with it.
  const bound = row.instance?.featureId ?? row.element.id;
  return row.vars.some((v) => free.has(v.qualifiedName) && v.featureId === bound);
}

/**
 * The largest literal exponent the encoder expands into a product.
 *
 * DUPLICATED FROM `src/semantics/smt/encode.ts` rather than imported, and the
 * two are held equal by the corpus equality test below: importing that module
 * here would put the whole SMT encoder — every script-writing line of it — into
 * the browser bundle through `src/ui/store.ts`, which is the cost §3.3b refuses
 * to pay.
 */
const MAX_SCOPE_EXPONENT = 32;

/** The two sorts a relation's terms carry, or a refusal. */
type TwinSort = 'Real' | 'Bool' | undefined;

/** The exponent as a literal number, or `undefined` — `x ^ -1` folds its sign. */
function literalExponentOf(node: ExprNode): number | undefined {
  if (node.kind === 'num') return node.value;
  if (node.kind === 'unary' && (node.op === '-' || node.op === '+')) {
    const inner = literalExponentOf(node.operand);
    if (inner === undefined) return undefined;
    return node.op === '-' ? -inner : inner;
  }
  return undefined;
}

/** The comparison operators, which take two numbers and give a proposition. */
const TWIN_COMPARISONS = new Set(['<', '<=', '>', '>=']);

/** The boolean connectives, which take two propositions and give one. */
const TWIN_CONNECTIVES = new Set(['and', 'or', 'xor', 'implies']);

/**
 * The qualified names one row's relation READS, as the encoder would name them.
 *
 * The encoder pushes a symbol for every `ref` that resolves against the row's
 * own variables, under either spelling — the dotted path the body writes
 * (`uav.endurance`) or the qualified name (`UAVSurveillance::AirVehicle::endurance`)
 * — and the qualified name is the symbol. This is that walk with no encoding:
 * no scale map, no SMT term, and therefore nothing that could pull an SMT
 * dependency into a caller that must stay synchronous and browser-safe.
 *
 * `undefined` back means THE ENCODER WOULD HAVE REFUSED THIS ROW, and a refused
 * axiom is carried by the read-closure rather than pruned by it — so the two
 * answers have to agree about WHICH rows are refused as well as about what the
 * rest of them read. Getting that wrong in the pruning direction is how the
 * twin under-reports a footprint: MEASURED, a first draft modelled only four of
 * the encoder's refusal paths (unresolved name, `str`, `null`, a non-finite
 * numeral) and pruned `assert constraint weird { trailer.mass }` — a body that
 * is an arithmetic term and not a proposition — from a closure the encoder
 * carried it in.
 *
 * SO IT TYPE-CHECKS THE BODY, in the encoder's own two sorts. Every refusal
 * `src/semantics/smt/encode.ts` makes is either a fact about the ROW (no body,
 * or the unit gates already refused it), a fact about a VARIABLE (a name no SMT
 * symbol can carry, a boolean carrying a unit scale, a scale factor that is not
 * finite and non-zero) or a SORT CLASH — and all three are readable off an
 * {@link Obligation} row, because `encodeVariables` derives each variable's
 * sort, factor and offset from `sortPerVar`, `siFactor`, `siOffset` and
 * `scaled`, which the row carries. What the twin does NOT do is produce a
 * term, a side condition, a nonlinearity reading or a refusal SENTENCE; it
 * answers one question — refused or reads-these — and the corpus test holds it
 * to the encoder's answer on every model the tree ships.
 */
function readsOf(row: Obligation): Set<string> | undefined {
  // `encodeRow`'s own two pre-checks, in its order: a row with no readable body
  // and a row the unit gates already refused never reach the relation walk.
  if (row.node === null || row.encodable !== true) return undefined;
  const bySpelling = new Map<string, ContractVariable>();
  for (const v of row.vars) {
    if (!bySpelling.has(v.path)) bySpelling.set(v.path, v);
    if (!bySpelling.has(v.qualifiedName)) bySpelling.set(v.qualifiedName, v);
  }
  const reads = new Set<string>();
  const sortOf = (v: ContractVariable): VarSort => row.sortPerVar[v.path] ?? 'Real';
  /** `si = value·factor + offset`, or the identity where the gates granted none. */
  const scaleOf = (v: ContractVariable): { factor: number; offset: number } =>
    row.scaled ? { factor: v.siFactor, offset: v.siOffset } : { factor: 1, offset: 0 };

  const walk = (n: ExprNode): TwinSort => {
    switch (n.kind) {
      // `numeral` refuses anything that is not a rational.
      case 'num':
        return Number.isFinite(n.value) ? 'Real' : undefined;
      case 'bool':
        return 'Bool';
      // Neither a string nor a `null` has a numeric or boolean encoding.
      case 'str':
      case 'null':
        return undefined;
      case 'ref': {
        const v = bySpelling.get(n.path.join('.'));
        // `unresolved-name`: the body names nothing the encoder has a symbol for.
        if (v === undefined) return undefined;
        // The SYMBOL the encoder writes — a name read where the validation
        // surface reads no value for it has one of its own (`v.symbol`).
        const symbol = v.symbol ?? v.qualifiedName;
        // `unparseable`: a qualified name carrying `|` or `\` cannot be quoted
        // as an SMT symbol.
        if (symbol.includes('|') || symbol.includes('\\')) return undefined;
        reads.add(symbol);
        const { factor, offset } = scaleOf(v);
        if (sortOf(v) === 'Bool') {
          // A boolean carrying a unit scale is not a reading this lane has.
          return factor !== 1 || offset !== 0 ? undefined : 'Bool';
        }
        // `unscalable`: a zero or non-finite factor would erase the variable
        // from the relation rather than scale it.
        if (!Number.isFinite(factor) || !Number.isFinite(offset) || factor === 0) return undefined;
        return 'Real';
      }
      case 'unary': {
        const operand = walk(n.operand);
        if (operand === undefined) return undefined;
        if (n.op === 'not') return operand === 'Bool' ? 'Bool' : undefined;
        return operand === 'Real' ? 'Real' : undefined;
      }
      case 'binary': {
        const op = n.op;
        // `%` and a non-literal or oversized exponent are refused BEFORE their
        // operands are walked, exactly as the encoder refuses them.
        if (op === '%') return undefined;
        if (op === '^') {
          const k = literalExponentOf(n.right);
          if (k === undefined || !Number.isInteger(k) || Math.abs(k) > MAX_SCOPE_EXPONENT) {
            return undefined;
          }
          return walk(n.left) === 'Real' ? 'Real' : undefined;
        }
        const left = walk(n.left);
        if (left === undefined) return undefined;
        const right = walk(n.right);
        if (right === undefined) return undefined;
        if (op === '+' || op === '-' || op === '*') {
          return left === 'Real' && right === 'Real' ? 'Real' : undefined;
        }
        if (op === '/') {
          if (left !== 'Real' || right !== 'Real') return undefined;
          // SMT-LIB leaves `x / 0` unspecified rather than undefined, so a
          // literal-zero divisor is refused rather than guarded.
          if (n.right.kind === 'num' && n.right.value === 0) return undefined;
          return 'Real';
        }
        if (TWIN_COMPARISONS.has(op)) {
          return left === 'Real' && right === 'Real' ? 'Bool' : undefined;
        }
        if (op === '==' || op === '=' || op === '!=') return left === right ? 'Bool' : undefined;
        if (TWIN_CONNECTIVES.has(op)) {
          return left === 'Bool' && right === 'Bool' ? 'Bool' : undefined;
        }
        return undefined;
      }
      case 'if': {
        const cond = walk(n.cond);
        if (cond !== 'Bool') return undefined;
        const then = walk(n.then);
        if (then === undefined) return undefined;
        const other = walk(n.else);
        if (other === undefined || other !== then) return undefined;
        return then;
      }
    }
  };

  // `encodeRelation`'s last gate: a body that encodes to an arithmetic term is
  // not a proposition, and there is nothing for a solver to decide about it.
  return walk(row.node) === 'Bool' ? reads : undefined;
}

/**
 * The axiom rows one obligation's proof can actually reach: its FOOTPRINT.
 *
 * THE MODEL-LEVEL TWIN of the SMT engine's own `relevantAxioms`. It is a
 * RE-IMPLEMENTATION and not a shared function — it has to model the encoder's
 * refusal discipline as well as its symbol walk, since a refused axiom is
 * carried by the closure rather than pruned by it — so the two are held equal
 * by a TEST rather than by construction: `test/campaign/verification.test.ts`
 * runs them against each other over every model the tree ships and requires set
 * equality, and the corpus carries a model whose axiom the encoder refuses on a
 * sort it cannot encode (`test/fixtures/verification/models/footprint-non-proposition.sysml`)
 * so the refusal half of the agreement is not taken on trust. Two things make
 * the twin necessary rather than redundant. `relevantAxioms` is typed over SMT-ENCODED rows, whose
 * type and constructor are both private to the engine, so a caller outside it
 * has nothing it could pass. And the callers that need this answer — the
 * staleness rule above all — run inside `ValidationRule.run`, which is
 * synchronous and reachable from the browser bundle through `src/ui/store.ts`;
 * routing them through the encoder would run half the verify pipeline on every
 * `npm run check` of any file carrying an evidence record, and would put the
 * SMT encoder in the bundle.
 *
 * WHAT THE CLOSURE IS. The symbols the goal reads, and the symbols its premises
 * read, and then every axiom that reads any symbol reached, transitively, until
 * nothing more is added. It is the encoder's own argument, unchanged: an axiom
 * sharing no symbol with the reached set factorises out of `A ∧ P ∧ ¬G`, so
 * dropping it changes neither satisfiability nor unsatisfiability.
 *
 * WHY THE PREMISES SEED IT AND ARE NEVER PRUNED: a premise that shares no
 * symbol with the goal can still be unsatisfiable against an axiom, which is
 * the vacuity this lane must not hide.
 *
 * WHAT IT IS NOT. It is not the unsat core — the core is a solver's choice,
 * measured to move with context warmth (`SmtJudgement.core`), and nothing
 * derived from it may be stored. The footprint is computed from the MODEL and
 * is a function of it alone, which is what makes a digest over it reproducible.
 */
export function footprintOf(
  model: Model,
  obligation: Obligation,
  opts: { rows?: readonly Obligation[]; free?: ReadonlySet<string> } = {},
): ReadonlySet<ElementId> {
  const rows = opts.rows ?? obligationsOf(model);
  const free = opts.free ?? new Set<string>();
  const axioms = axiomsOf(rows, free);
  const premises = premisesOf(obligation, rows);
  const reached = new Set<string>(readsOf(obligation) ?? []);
  for (const p of premises) for (const s of readsOf(p) ?? []) reached.add(s);
  const kept = new Set<ElementId>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of axioms) {
      if (kept.has(a.element.id)) continue;
      const reads = readsOf(a);
      // A refused axiom has no symbols to connect through; it is carried anyway,
      // so the "a refutation needs the whole context" rule can still see it.
      if (reads !== undefined && ![...reads].some((r) => reached.has(r))) continue;
      kept.add(a.element.id);
      for (const r of reads ?? []) reached.add(r);
      grew = true;
    }
  }
  return kept;
}

/** The premise rows filed under the same requirement as this obligation. */
export function premisesOf(
  obligation: Obligation,
  rows: readonly Obligation[],
): Obligation[] {
  if (obligation.requirement === null) return [];
  const id = obligation.requirement.id;
  return rows.filter((r) => r.role === 'premise' && r.requirement?.id === id);
}

/** The axiom rows a run encodes — STEP 0's inputs, in the worklist's own order. */
export function axiomsOf(
  rows: readonly Obligation[],
  free: ReadonlySet<string> = new Set<string>(),
): Obligation[] {
  return rows.filter(
    (r) => r.role === 'axiom' && !(r.source === 'feature-value' && isFreedValueAxiom(r, free)),
  );
}

/* ──────────────── what a relation nothing asserted can still reach ──────────────── */

/**
 * What one relation nothing asserted would have read — the question every guard
 * on the SAT side of this lane asks of it: can it change THIS answer?
 *
 * ONE ENTRY POINT, because four commands ask the question and each used to
 * answer it its own way. A dropped relation can exclude a satisfying point, a
 * counterexample, a design point at a bound or a step-(0) witness, so every
 * one of `verify` (a refutation, and the "assumptions satisfiable" a proof
 * stands on), `consistency` (the word `consistent`), `bounds` (a bound) and
 * `refine` (a refutation over γ) stands down where a refusal REACHES what it
 * answered over — and a reach taken four ways is four chances to under-read
 * it. MEASURED, each way it went wrong: compared by symbol only, a row over a
 * value this tool does not read here (`unread-definition`) is read by a
 * symbol of its own that no asserted relation shares, and `p.e <= 1.0` over
 * P's `e == x * 2.0` (6) left the maximum of `x` at 100 "exactly"; and taken
 * over one refused clause of a requirement `bounds` withheld WHOLE, `p.x <=
 * 5.0` beside a refused `p.z % 2.0 == 0.0` read "unbounded above", exit 0.
 *
 * So a refusal is compared by FEATURE and by SYMBOL, and a refusal whose reach
 * is UNKNOWN — a body that reads nothing this tool could name — reaches
 * everything, because the conservative reading of unknown is that it might
 * matter. A feature VALUE's reach is never unknown: it is at least its own
 * feature ({@link reachOfRow}).
 */
export interface RefusalReach {
  /** The features it reads, by element id — the real ones, never only a symbol. */
  features: readonly ElementId[];
  /** The symbols it would have been read by: each feature's qualified name and its own symbol. */
  symbols: readonly string[];
  /**
   * Features its answer depends on that it does not name — the inputs of a
   * value read where its definition is not written ({@link
   * Obligation.unreadDeps}, which the name-resolution pass feeds here, never
   * through a second reach of its own).
   */
  extraDeps?: readonly ElementId[];
}

/** What an answer stood on: the features and the symbols its ASSERTED relations read. */
export interface ReachedSet {
  features: ReadonlySet<ElementId>;
  symbols: ReadonlySet<string>;
}

/** Does this refusal reach what the answer stood on? Unknown reach always does. */
export function refusalReaches(reach: RefusalReach, reached: ReachedSet): boolean {
  const deps = reach.extraDeps ?? [];
  if (reach.features.length === 0 && reach.symbols.length === 0 && deps.length === 0) return true;
  return (
    reach.features.some((f) => reached.features.has(f)) ||
    deps.some((f) => reached.features.has(f)) ||
    reach.symbols.some((s) => reached.symbols.has(s))
  );
}

/**
 * The reach of a relation whose body reads `vars`: every feature by id, by its
 * qualified name, and by the symbol of its own it is read by where it has one.
 */
export function reachOf(vars: readonly ContractVariable[], symbols: Iterable<string> = []): RefusalReach {
  const out = new Set<string>(symbols);
  for (const v of vars) {
    out.add(v.qualifiedName);
    if (v.symbol !== undefined) out.add(v.symbol);
  }
  return { features: vars.map((v) => v.featureId), symbols: [...out] };
}

/**
 * The reach of one refused row of the worklist — {@link reachOf} its variables
 * — and, for a FEATURE VALUE, always its own feature beside them (an
 * instance's value: the symbol that instance reads it by).
 *
 * `f == E` refused can exclude no point of a question that does not read `f`:
 * `f` is free to equal `E`, whatever `E` reads. So its reach is never unknown,
 * even where its body reads nothing this tool can name — `attribute mode :
 * Mode = Mode::cruise;` or `xs = (1.0, 2.0)` is refused `unparseable`, and
 * read as reaching everything it took every proof of the file and every
 * `consistency --with-values` set down with it, over a feature none of them
 * read.
 */
export function reachOfRow(
  row: Pick<Obligation, 'vars' | 'source' | 'element' | 'instance' | 'unreadDeps'>,
  symbols: Iterable<string> = [],
): RefusalReach {
  // The inputs its unread values depend on, where it reads them
  // ({@link Obligation.unreadDeps}): the symbol it reads such a value by
  // meets nothing, and the features it is computed from are what it reaches.
  const deps = row.unreadDeps ?? [];
  const reach = { ...reachOf(row.vars, symbols), ...(deps.length > 0 ? { extraDeps: deps } : {}) };
  if (row.source !== 'feature-value') return reach;
  // The value an INSTANCE's feature has is that instance's: it reaches what
  // reads it by the instance's symbol, never every instance of the feature —
  // P's `total` refused for one `p` took the proof of another instance's down.
  const symbol = row.instance?.path !== undefined ? row.instance.symbol : undefined;
  if (symbol !== undefined) return { ...reach, symbols: [...new Set([...reach.symbols, symbol])] };
  // A value read in a context, or for an instance ({@link Obligation.instance}),
  // is the value of the feature it binds there; its row's id names no element.
  const own = row.instance?.featureId ?? row.element.id;
  return {
    ...reach,
    features: [...new Set([...reach.features, own])],
    symbols: [...new Set([...reach.symbols, ...(row.element.id === own ? [row.element.qualifiedName] : [])])],
  };
}

/**
 * What a set of asserted relations reads, as {@link refusalReaches} compares
 * it: every variable's feature, qualified name and symbol, and whatever
 * symbols the caller's encoding read beside them.
 */
export function reachedBy(
  relations: Iterable<{ vars: readonly ContractVariable[]; symbols?: Iterable<string> }>,
): ReachedSet {
  const features = new Set<ElementId>();
  const symbols = new Set<string>();
  for (const r of relations) {
    for (const v of r.vars) {
      features.add(v.featureId);
      symbols.add(v.qualifiedName);
      if (v.symbol !== undefined) symbols.add(v.symbol);
    }
    for (const s of r.symbols ?? []) symbols.add(s);
  }
  return { features, symbols };
}

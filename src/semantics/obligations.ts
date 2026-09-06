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
 *
 * That last row is the one worth stating twice. A plain constraint is what
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

import { type ElementId, type ElementRecord, type Model } from '@core/index';
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
  type VarSort,
} from './contracts';
import { type ExprNode } from './expr';
import { NO_MARKERS, idScopeFor, parseRelationBody, storageScaleOf } from './relations';
import { getRequirementAttr } from './requirements';
import { isNonNormativeStatement } from './statement-kind';
import { type DerivationMemo } from './units-eval';

/** Which side of a proof a relation stands on. */
export type ObligationRole = 'axiom' | 'premise' | 'obligation';

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
    qualifiedName: model.qualifiedName(el.id),
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
): { role: ObligationRole; source: ObligationSource } | undefined {
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
    const filed = roleOf(el, topIsComparison(raw));
    if (!filed) continue;
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
      encodable: reading.encodable,
      nonlinear: reading.nonlinear,
      verifiedBy: contract?.verifiedBy ?? [],
      method: contract ? methodOf(model, contract.id) : null,
      evidence: [],
      status: statusOf(reading.encodable),
      ...claimed(model, contract),
    });
  }

  for (const el of model.all()) {
    if (!isUserModelElement(model, el) || !inScope(el)) continue;
    const row = featureValueAxiom(model, el, memo);
    if (row) out.push(row);
  }

  for (const el of model.all()) {
    if (!isUserModelElement(model, el) || !inScope(el)) continue;
    if (!isBindingEdge(el)) continue;
    const row = bindAxiom(model, el, memo);
    if (row) out.push(row);
  }

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
 * `mtow == 18.5` with the magnitude expressed in SI so it meets a variable the
 * encoder scales to SI; and an expression (`endurance = capacity * f / power`),
 * whose axiom is the joining equality the numeric surface already builds.
 *
 * A quoted string value is not a numeric axiom — the requirement-facet carrier
 * writes `attribute status = "open";`, and reading that as a relation would put
 * a requirement's metadata into a proof.
 */
function featureValueAxiom(
  model: Model,
  el: ElementRecord,
  memo: DerivationMemo,
): Obligation | undefined {
  const raw = el.attrs.value;
  const name = el.declaredName;
  if (name === undefined || name === '') return undefined;
  if (raw === undefined || raw === null) return undefined;
  if (RELATION_KINDS.has(el.eClass)) return undefined;

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
  const reading = readRelation(model, el, text, memo, name);
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
    encodable: reading.encodable,
    nonlinear: reading.nonlinear,
    verifiedBy: [],
    method: null,
    evidence: [],
    status: statusOf(reading.encodable),
  };
}

/**
 * The axiom a literal feature value states, in SI.
 *
 * The magnitude is converted here and the variable is left in its storage unit,
 * which is the same split the numeric surface makes: values are STORED in the
 * feature's own unit and converted at the point of use through the relation's
 * scale map. An encoder that maps each variable to `factor·x + offset`
 * therefore meets an SI number on the other side of the equality, exactly as it
 * does for a `[unit]` literal lowered out of a body.
 */
function literalAxiom(
  model: Model,
  el: ElementRecord,
  name: string,
  raw: number | boolean,
  memo: DerivationMemo,
): Obligation {
  const scale = storageScaleOf(model, el.id, memo);
  const value =
    typeof raw === 'boolean' ? raw : raw * (scale?.factor ?? 1) + (scale?.offset ?? 0);
  const nameToId = new Map<string, ElementId>(idScopeFor(model, el.id));
  nameToId.set(name, el.id);
  const node: ExprNode = {
    kind: 'binary',
    op: '==',
    left: { kind: 'ref', path: [name] },
    right: typeof value === 'boolean' ? { kind: 'bool', value } : { kind: 'num', value },
  };
  const reading = gateRelation(model, node, nameToId, NO_MARKERS, false, memo, true, `${name} == ${String(value)}`);
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
    encodable: reading.encodable,
    nonlinear: reading.nonlinear,
    verifiedBy: [],
    method: null,
    evidence: [],
    status: statusOf(reading.encodable),
  };
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
  const a = el.source?.[0];
  const b = el.target?.[0];
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
    encodable: reading.encodable,
    nonlinear: reading.nonlinear,
    verifiedBy: [],
    method: null,
    evidence: [],
    status: statusOf(reading.encodable),
  };
}

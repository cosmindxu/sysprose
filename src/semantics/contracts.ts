/**
 * The contract inventory: what each requirement ASSUMES and GUARANTEES, on
 * which subject, honoured by which part.
 *
 * The charter of this module, in one line: **report structure, never truth.**
 * Nothing here evaluates a relation, and nothing here may say satisfied,
 * proved or consistent. A contract is a reading of what the author wrote — the
 * `assume` and `require` clauses of a requirement, the `objective` of a case,
 * and the four traceability orientations that say who honours it — plus the
 * one judgement this layer IS allowed to make: whether an engine standing
 * behind the unit gates could encode each relation, and in which fragment.
 *
 * WHY THE FRAGMENT IS COMPUTED HERE AND NOT IN THE ENCODER. `fragment` is
 * `qf-lra` only when every relation is linear AFTER literal substitution, and
 * literal substitution is a property of the MODEL (which feature values are
 * numbers) rather than of the solver. Freeing a feature that appears as a
 * divisor or inside a product promotes the obligation to `qf-nra`, which is why
 * the endurance obligation of `examples/uav-isr.sysml` is linear as the model
 * stands (`battery.capacity * usableEnergyFraction / cruisePower` is a product
 * of three literals) and nonlinear the moment `cruisePower` is released. A
 * command that reports the fragment before any solver exists is how a reader
 * learns that before waiting for one.
 *
 * WHY IT CALLS THE RELATION LAYER RATHER THAN RE-READING BODIES. Encodability
 * is the same gate the numeric surface applies, because it calls the same
 * functions: {@link parseRelationBody}, {@link relationScope},
 * {@link relationVarsOf}, {@link relationRefused}, {@link scaleOfRelation},
 * {@link storageScaleOf} and {@link substituteLiterals}, all lifted into
 * `./relations` for exactly this reason. A second reader with its own idea of
 * when a relation is refused would let two engines answer one model
 * differently — the failure the units work closed earlier this year.
 *
 * WHAT IT ADDS ON TOP OF THOSE GATES, and why the addition is a REFUSAL rather
 * than a silence: a collection-valued feature, a remainder and a variable
 * exponent are relations the numeric surface can still evaluate at a point but
 * that no quantifier-free encoding admits. They are listed with their reason,
 * never dropped — a relation that disappears from a worklist reads as one that
 * holds.
 *
 * Pure and deterministic: nothing here reads or writes anything but its
 * arguments.
 */

import { REQUIREMENT_KINDS, type ElementId, type ElementRecord, type Model } from '@core/index';
import { evaluate, type ExprNode } from './expr';
import { effectiveFeatures, generalizationsOf } from './inheritance';
import {
  parseRelationBody,
  relationRefused,
  relationScope,
  relationVarsOf,
  scaleOfRelation,
  storageScaleOf,
  substituteLiterals,
  type LoweredLiteral,
  type MarkerDimensions,
  type ScaleMap,
} from './relations';
import { getRequirementAttr, requirementShortId } from './requirements';
import { isNonNormativeStatement } from './statement-kind';
import { dimensionalFacets, type DerivationMemo } from './units-eval';

/* ────────────────────────── who owns a contract ──────────────────────────── */

/** The requirement metaclasses a contract can be read off. */
const REQUIREMENT_SET = new Set<string>(REQUIREMENT_KINDS);

/**
 * The case metaclasses whose `objective` clause is a contract on a behaviour.
 *
 * `Cases.sysml` gives every case an `objective obj : RequirementCheck[1]`, so
 * an objective carrying `assume` / `require` children is the standard's own
 * home for a behaviour's precondition and postcondition — which is why this
 * plan ships no `#precondition` keyword for something the specification already
 * names three ways.
 */
const CASE_KINDS = new Set([
  'CaseDefinition',
  'CaseUsage',
  'UseCaseDefinition',
  'UseCaseUsage',
  'VerificationCaseDefinition',
  'VerificationCaseUsage',
]);

/** The case metaclasses whose subject is BOUND rather than defaulted. */
const VERIFICATION_CASE_KINDS = new Set([
  'VerificationCaseDefinition',
  'VerificationCaseUsage',
]);

/**
 * Is `el` the user's own content?
 *
 * This is `isUserElement` of `src/api/analytics.ts`, spelled again because the
 * API layer imports the semantics layer and importing it back would close a
 * cycle through `src/semantics/index.ts`. A copied predicate is a predicate
 * that drifts, so `test/unit/api.verification.test.ts` compares the two element
 * by element over both shipped examples; if they ever disagree that case goes
 * red rather than one report quietly counting a different model than the rest.
 *
 * The stronger filter matters here: `constraintReport` drops library rows only,
 * while a contract inventory that kept re-derived usage-scoped copies would
 * report a requirement the reader cannot open in their own file.
 */
export const isUserModelElement = (model: Model, el: ElementRecord): boolean =>
  el.attrs.implicit !== true &&
  el.attrs.isLibrary !== true &&
  !(el.ownerId != null && model.get(el.ownerId)?.attrs.implicit === true);

/* ──────────────────────────────── shapes ─────────────────────────────────── */

/**
 * A compact reference to an element, structurally the `ElementRef` of
 * `src/api/analytics.ts` so a consumer can join a contract to any other report.
 */
export interface ContractRef {
  id: string;
  eClass: string;
  declaredName?: string;
  qualifiedName: string;
}

/**
 * The quantifier-free fragment a set of relations lives in.
 *
 * `temporal` is declared and never produced here: the temporal reader is
 * `property-draft`'s (§3.3) and the bounded behaviour engine's, and a clause
 * carrying a timing field cannot be written in a constraint body today. It is
 * named so the vocabulary is one vocabulary rather than two.
 */
export type Fragment = 'qf-lra' | 'qf-nra' | 'temporal' | 'unsupported';

/**
 * Why a relation cannot be handed to an engine, in a word an agent can branch
 * on. `no-formal-clause` is the one that is not about a body at all: it is a
 * requirement that has none, which is the commonest row a real requirement set
 * produces and the one `obligations --missing` exists to count.
 */
export type RefusalReason =
  | 'no-formal-clause'
  | 'unparseable'
  | 'unresolved-name'
  | 'unit-unresolved'
  | 'dimension-clash'
  | 'offset-arithmetic'
  | 'unscalable'
  | 'collection-valued'
  | 'unsupported-operator'
  | 'non-numeric-operand';

/** A refusal: the branchable reason, and the sentence a person reads. */
export interface Refusal {
  reason: RefusalReason;
  detail: string;
}

/** What an encodability question answers: yes, or no with a reason. */
export type Encodable = true | Refusal;

/** The sort a variable is encoded in. */
export type VarSort = 'Real' | 'Int' | 'Bool';

/**
 * How a variable enters the contract.
 *
 * `derived` wins over a direction because it says the model COMPUTES the value,
 * which is what an engine needs to know first; `input` / `output` come from the
 * port direction the specification puts on the feature or on the port it is
 * reached through. An `inout` end reads as an `input`: it can be written from
 * outside the subject, so the subject does not control it, and what a contract
 * needs to know about a variable is exactly that.
 */
export type VariableRole = 'input' | 'output' | 'parameter' | 'derived';

/** One feature a contract's relations read. */
export interface ContractVariable {
  /** The dotted path as the relation body writes it (`uav.endurance`). */
  path: string;
  featureId: string;
  qualifiedName: string;
  role: VariableRole;
  /** The declared unit, or `null` for a plain number or an SI-by-convention kind. */
  unit: string | null;
  /** The factor taking the stored magnitude into SI (`si = value·factor + offset`). */
  siFactor: number;
  /** The origin offset of the stored scale — non-zero only on °C / °F. */
  siOffset: number;
}

/** One `assume` or `require` clause, read but never judged. */
export interface ContractClause {
  id: string;
  qualifiedName: string;
  declaredName?: string;
  role: 'assume' | 'require';
  /** Where the author wrote it: on the requirement, or inside a case objective. */
  via: 'requirement' | 'objective';
  /** The body as written, before any lowering. */
  expression: string;
  /** The body with every `[unit]` literal lowered to SI, or `null` when unreadable. */
  node: ExprNode | null;
  variables: ContractVariable[];
  sortPerVar: Record<string, VarSort>;
  encodable: Encodable;
  nonlinear: boolean;
  fragment: Fragment;
}

/**
 * The subject a contract is about.
 *
 * `origin` is not decoration. A case with no subject of its own takes
 * `Case::result` by DEFAULT (`subject subj default Case::result;`), which an
 * author may override; a verification case takes `VerificationCase::subj` by
 * BINDING (`subject subj = VerificationCase::subj;`), which is an axiom rather
 * than a default. §3.2's own role map turns on that difference, so a reader who
 * is shown only a name cannot tell which of the two they have.
 */
export interface ContractSubject {
  name: string;
  typeRef: string | null;
  /**
   * The id of the element `typeRef` resolves to, when it resolves to one.
   *
   * It is what makes "N contract(s) on M subject(s)" countable. Two packages
   * may each declare a `part def Sys` and a `subject u : Sys`, and a census
   * keyed on the two display strings reports one subject where the model has
   * two — the headline then under-states the population it is about.
   */
  typeId: string | null;
  origin: 'declared' | 'inherited' | 'case-default' | 'case-bound';
}

/** One requirement (or case objective) read as a contract. */
export interface Contract {
  id: string;
  qualifiedName: string;
  /** The `<R-UAV-001>` short name, or `''`. */
  shortId: string;
  eClass: string;
  declaredName?: string;
  subject: ContractSubject | null;
  assumptions: ContractClause[];
  guarantees: ContractClause[];
  satisfiedBy: ContractRef[];
  derivedFrom: ContractRef[];
  refinedBy: ContractRef[];
  verifiedBy: ContractRef[];
  variables: ContractVariable[];
  fragment: Fragment;
  /**
   * Every relation a gate refused: the branchable `reason` an agent switches
   * on, and the `detail` sentence a person reads. Both, and under the same key
   * names {@link ContractClause.encodable} uses — one payload that spelled
   * `reason` two different ways would make the word mean two things.
   */
  unsupported: Array<{ expression: string; reason: RefusalReason; detail: string }>;
  /**
   * The definitions whose `assume` / `require` clauses this element inherits
   * but does not re-file.
   *
   * A `requirement r : MassLimit;` usage is the standard's ordinary way of
   * applying a requirement, and it owns no clause of its own. Its contract is
   * therefore empty — but it is NOT the "prose only, nothing to encode" that an
   * empty clause list otherwise means, and counting it as one would inflate the
   * very figure `obligations --missing` exists to measure. The clauses are
   * filed once, on the definition; this names where a reader will find them.
   */
  clausesInheritedFrom: ContractRef[];
  /** The `#keyword`s on the declaration, exactly as written. */
  keywords: string[];
}

/* ───────────────────────────── small helpers ─────────────────────────────── */

function ref(model: Model, el: ElementRecord): ContractRef {
  return {
    id: el.id,
    eClass: el.eClass,
    ...(el.declaredName !== undefined ? { declaredName: el.declaredName } : {}),
    qualifiedName: model.qualifiedName(el.id),
  };
}

/** The `#keyword`s written on a declaration, verbatim. */
function keywordsOnDeclaration(el: ElementRecord): string[] {
  const meta = el.attrs.metadata;
  return Array.isArray(meta) ? meta.map((m) => String(m)) : [];
}

/** Does this multiplicity admit more than one value? */
function admitsMany(multiplicity: unknown): boolean {
  if (typeof multiplicity !== 'string') return false;
  const text = multiplicity.trim();
  if (text === '') return false;
  const upper = text.includes('..') ? text.slice(text.indexOf('..') + 2).trim() : text;
  if (upper === '*') return true;
  const n = Number(upper);
  return Number.isFinite(n) && n > 1;
}

/**
 * The sort a feature is encoded in.
 *
 * Boolean and the integer kinds are read off the declared type's own
 * generalization closure; everything else is Real. Real is the CONSERVATIVE
 * answer, not a guess dressed up as one: a relation over the reals admits every
 * model a relation over the integers admits and more, so a proof obtained there
 * still covers the integer readings, while the reverse would not.
 */
function sortOf(model: Model, id: ElementId): VarSort {
  const el = model.get(id);
  if (!el) return 'Real';
  if (typeof el.attrs.value === 'boolean') return 'Bool';
  const names = new Set<string>();
  for (const t of model.typesOf(id)) {
    if (t.declaredName) names.add(t.declaredName);
    for (const g of generalizationsOf(model, t.id)) if (g.declaredName) names.add(g.declaredName);
  }
  const declared = el.attrs.type;
  if (typeof declared === 'string') {
    const tail = declared.includes('::') ? declared.slice(declared.lastIndexOf('::') + 2) : declared;
    names.add(tail);
  }
  if (names.has('Boolean')) return 'Bool';
  if (names.has('Integer') || names.has('Natural') || names.has('UnlimitedNatural')) return 'Int';
  return 'Real';
}

/**
 * Does this feature's value stand on its own as a literal?
 *
 * The same question `assignmentEquation` asks in `./solver` — "a self-contained
 * literal is a seed, not an equation" — asked here for the opposite purpose:
 * the fragment rule substitutes exactly these before it looks for a product of
 * two variables, so `battery.capacity * usableEnergyFraction / cruisePower`
 * is a constant rather than a nonlinearity.
 */
function hasLiteralValue(el: ElementRecord | undefined): boolean {
  if (!el) return false;
  const raw = el.attrs.value;
  if (typeof raw === 'number' || typeof raw === 'boolean') return true;
  if (typeof raw !== 'string') return false;
  const text = raw.trim();
  if (text === '') return false;
  const body = parseRelationBody(text);
  if (!body) return false;
  const folded = substituteLiterals(body.node, body.literals);
  return 'value' in evaluate(folded, () => undefined);
}

/**
 * The variable role: derived, then the port direction, then a plain parameter.
 *
 * The direction is looked for in two places, and the SECOND is the one that
 * actually answers for the canonical shape. An attribute written inside a
 * `port def` is owned by that DEFINITION, not by any port usage, so an owner
 * walk from the resolved feature reaches a `PortDefinition` and stops: the
 * `out` on `out port powerOut : PowerPort;` is never seen, and every
 * port-borne quantity would read `parameter`. What names the direction is the
 * PATH — `u.powerOut.voltage` says which port this reading of `voltage` came
 * through — so each proper prefix of the path is resolved and asked. The owner
 * walk is kept because it is what answers for a direction written on the
 * feature itself (`in attribute x : Real` on an action def).
 *
 * An `inout` end reads as an `input`: it can be written from outside the
 * subject, so the subject does not control it.
 */
function variableRole(
  model: Model,
  id: ElementId,
  path: string,
  nameToId: Map<string, ElementId>,
): VariableRole {
  const el = model.get(id);
  if (!el) return 'parameter';
  const raw = el.attrs.value;
  if (typeof raw === 'string' && raw.trim() !== '' && !hasLiteralValue(el)) return 'derived';
  for (let cur: ElementRecord | undefined = el; cur; cur = cur.ownerId != null ? model.get(cur.ownerId) : undefined) {
    const role = directionRole(cur.attrs.direction);
    if (role) return role;
    // Only the feature and the port it hangs on carry a direction; walking
    // further up would credit a part's own direction to every attribute in it.
    if (cur.eClass !== 'AttributeUsage' && cur.eClass !== 'ReferenceUsage') break;
  }
  // Nearest prefix first: `u.a.b.c` asks `u.a.b` before `u.a`, so the port the
  // value is read through wins over the part that owns the port.
  const segments = path.split('.');
  for (let i = segments.length - 1; i > 0; i--) {
    const owner = nameToId.get(segments.slice(0, i).join('.'));
    if (owner === undefined) continue;
    const role = directionRole(model.get(owner)?.attrs.direction);
    if (role) return role;
  }
  return 'parameter';
}

/** `in` / `inout` / `out` read as a variable role, or nothing. */
function directionRole(direction: unknown): VariableRole | undefined {
  if (direction === 'out') return 'output';
  if (direction === 'in' || direction === 'inout') return 'input';
  return undefined;
}

/* ───────────────────────── reading one relation ──────────────────────────── */

/** One relation body, read through the gates the numeric surface applies. */
export interface RelationReading {
  /** The body as written. */
  expression: string;
  /** The body with `[unit]` literals lowered to SI, or `null` when unreadable. */
  node: ExprNode | null;
  variables: ContractVariable[];
  sortPerVar: Record<string, VarSort>;
  /** The per-variable SI scaling, when the gates granted one. */
  scale: ScaleMap | undefined;
  encodable: Encodable;
  nonlinear: boolean;
  fragment: Fragment;
}

/** A reading that failed at `refusal`, carrying whatever was learned first. */
function refused(
  expression: string,
  refusal: Refusal,
  node: ExprNode | null = null,
  variables: ContractVariable[] = [],
  sortPerVar: Record<string, VarSort> = {},
): RelationReading {
  return {
    expression,
    node,
    variables,
    sortPerVar,
    scale: undefined,
    encodable: refusal,
    nonlinear: false,
    fragment: 'unsupported',
  };
}

/**
 * Read one relation body: parse it, resolve its names, apply every gate, and
 * report the fragment it lands in.
 *
 * `assignTo` names the feature a FEATURE VALUE belongs to, and it is not a
 * convenience. `assignmentEquation` of {@link ./solver} gates the JOINING
 * equality rather than the value expression alone, because `==` is itself in
 * the dimension-sensitive set and an equality is precisely where a plain `Real`
 * meets a dimensioned value. Gating the right-hand side on its own would let
 * `attribute n : Real = km;` through a gate the numeric surface applies.
 */
export function readRelation(
  model: Model,
  el: ElementRecord,
  raw: string,
  memo: DerivationMemo,
  assignTo?: string,
): RelationReading {
  // What the RELATION is, which for a feature value is the joining equality and
  // not the right-hand side alone. `endurance = capacity * f / power` states
  // `endurance == capacity * f / power`; an axiom row that printed only the
  // quotient would show something that is not a relation and would never name
  // the feature it defines, while the sibling literal row prints `mtow == 18.5`.
  // One field, one shape.
  const shown = assignTo !== undefined ? `${assignTo} == ${raw}` : raw;
  const body = parseRelationBody(raw);
  if (!body) {
    return refused(shown, {
      reason: 'unparseable',
      detail: `the body \`${raw}\` is not an expression this tool can read`,
    });
  }
  if (body.hadUnit && !body.resolved) {
    return refused(shown, {
      reason: 'unit-unresolved',
      detail:
        'a `[unit]` literal in the body names a unit nothing can convert, sits on an offset scale, or is written on something other than a literal, so the body cannot be read in SI',
    });
  }

  const nameToId = relationScope(model, el);
  let node = body.node;
  let identity = false;
  if (assignTo !== undefined) {
    nameToId.set(assignTo, el.id);
    node = { kind: 'binary', op: '==', left: { kind: 'ref', path: [assignTo] }, right: body.node };
    // A value that is a BARE REFERENCE states an identity of two physical
    // values rather than asking one, so it converts across an affine map — the
    // same exemption `assignmentEquation` makes for `attribute t3 = t1;`.
    identity = body.node.kind === 'ref' && !body.hadUnit;
  }
  return gateRelation(model, node, nameToId, body.literals, body.hadUnit, memo, identity, shown);
}

/**
 * Apply every gate to one already-parsed relation node.
 *
 * Split out from {@link readRelation} because two of this lane's relations are
 * not written as a body at all: a `bind` equality is a synthetic `a == b` over
 * two element ids, and a literal feature value is a synthetic `f == 18.5`. Both
 * must go through the SAME gates as an author's `==`, or the worklist would
 * hold an axiom the numeric surface refuses.
 *
 * The gate ORDER is the numeric surface's, and it matters. The dimensional
 * fault is asked first, because a relation comparing a length with a duration
 * is not a numeric relation at all; the offset fault second, because a °C value
 * may be ORDERED and may not be arithmetic on; the SI scaling last, because a
 * body whose literals are already in SI cannot be judged in raw magnitudes.
 * The two halves are separated by asking {@link relationRefused} twice — once
 * with `identity`, which exempts the offset half — so the reason printed is the
 * gate that actually refused rather than a guess between them.
 */
export function gateRelation(
  model: Model,
  node: ExprNode,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
  hadUnit: boolean,
  memo: DerivationMemo,
  identity: boolean,
  expression: string,
): RelationReading {
  const varIds = relationVarsOf(node, nameToId);
  const variables = variablesOf(model, node, nameToId, markers, memo);
  const sortPerVar: Record<string, VarSort> = {};
  for (const v of variables) sortPerVar[v.path] = sortOf(model, v.featureId);

  // A name nothing resolves is asked FIRST, because a body whose operands are
  // unknown is not a relation at all. `relationVarsOf` silently drops such a
  // path — it collects the ids a name maps to and an unmapped name maps to
  // none — so every gate below would then be satisfied VACUOUSLY and the
  // report would call `u.enduranse >= 45.0` encodable in QF_LRA with an empty
  // variable list, on a body the numeric surface already reports as
  // unevaluable. An encodable relation whose variables nobody can name is the
  // failure direction this lane exists to avoid.
  const unresolved = unresolvedNames(node, nameToId, markers);
  if (unresolved.length > 0) {
    return refused(
      expression,
      {
        reason: 'unresolved-name',
        detail: `\`${unresolved.join('`, `')}\` names nothing this tool can resolve in the scope of the relation, so there is no variable to encode`,
      },
      null,
      variables,
      sortPerVar,
    );
  }

  // The dimensional half of the gate, asked on its own so the reason is exact.
  if (relationRefused(model, node, varIds, nameToId, markers, memo, true)) {
    return refused(
      expression,
      {
        reason: 'dimension-clash',
        detail:
          'two operands that must share a dimension do not — no conversion relates them, so the comparison cannot be judged',
      },
      null,
      variables,
      sortPerVar,
    );
  }
  if (!identity && relationRefused(model, node, varIds, nameToId, markers, memo, false)) {
    return refused(
      expression,
      {
        reason: 'offset-arithmetic',
        detail:
          'the body does arithmetic on an offset temperature scale (°C/°F), where the origin does not cancel; such a value may be ordered and not added, subtracted or equated',
      },
      null,
      variables,
      sortPerVar,
    );
  }

  const collection = varIds.find((id) => admitsMany(model.get(id)?.attrs.multiplicity));
  if (collection !== undefined) {
    const name = model.get(collection)?.declaredName ?? model.qualifiedName(collection);
    return refused(
      expression,
      {
        reason: 'collection-valued',
        detail: `\`${name}\` admits more than one value; only single-valued scalar features are encoded`,
      },
      null,
      variables,
      sortPerVar,
    );
  }

  const operator = unsupportedOperator(node);
  if (operator) return refused(expression, operator, null, variables, sortPerVar);

  const scale = scaleOfRelation(model, varIds, [node], nameToId, hadUnit, markers, memo);
  if (hadUnit && !scale) {
    return refused(
      expression,
      {
        reason: 'unscalable',
        detail:
          'the body carries `[unit]` literals already lowered to SI, and the gates refuse to scale its variables, so the two sides cannot be read in one system of units',
      },
      null,
      variables,
      sortPerVar,
    );
  }

  const lowered = substituteLiterals(node, asLiteralMap(markers));
  const free = new Set(
    variables.filter((v) => !hasLiteralValue(model.get(v.featureId))).map((v) => v.path),
  );
  const nonlinear = isNonlinear(lowered, free);
  return {
    expression,
    node: lowered,
    variables,
    sortPerVar,
    scale,
    encodable: true,
    nonlinear,
    fragment: nonlinear ? 'qf-nra' : 'qf-lra',
  };
}

/** {@link substituteLiterals} takes a mutable map; the gates take a read-only one. */
function asLiteralMap(markers: MarkerDimensions): Map<string, LoweredLiteral> {
  return markers instanceof Map ? markers : new Map(markers);
}

/**
 * The variables of a relation, in the order the body first names them — one row
 * per distinct PATH, not per resolved feature id.
 *
 * The distinction is not pedantic, and it was measured. An attribute declared
 * in a `port def` is owned by that DEFINITION, so `u.powerIn.voltage` and
 * `u.powerOut.voltage` resolve to the same element: a list built per id reports
 * one row for two quantities and silently loses the other path. `relationScope`
 * and `relationVarsOf` keep the per-id reading, because the GATES are about the
 * feature (its unit, its scale, its multiplicity) — but a report whose stated
 * job is to name the variables a clause reads must name every one of them.
 */
function variablesOf(
  model: Model,
  node: ExprNode,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
  memo: DerivationMemo,
): ContractVariable[] {
  const out: ContractVariable[] = [];
  for (const path of pathsOf(node)) {
    // A lowered `[unit]` literal is a marker standing for a number, not a
    // variable the body reads.
    if (markers.has(path)) continue;
    const id = nameToId.get(path);
    if (id === undefined) continue;
    const scale = storageScaleOf(model, id, memo);
    const facets = dimensionalFacets(model, id);
    out.push({
      path,
      featureId: id,
      qualifiedName: model.qualifiedName(id),
      role: variableRole(model, id, path, nameToId),
      unit: facets.unit ?? null,
      siFactor: scale?.factor ?? 1,
      siOffset: scale?.offset ?? 0,
    });
  }
  return out;
}

/** Every dotted path an expression names, in first-seen order, deduplicated. */
function pathsOf(node: ExprNode): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'ref': {
        const path = n.path.join('.');
        if (!seen.has(path)) {
          seen.add(path);
          out.push(path);
        }
        return;
      }
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
  return out;
}

/**
 * The paths a relation names that neither the scope nor the lowering markers
 * account for — a misspelt feature, a name out of scope, a call this parser
 * read as a reference.
 */
function unresolvedNames(
  node: ExprNode,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
): string[] {
  return pathsOf(node).filter((path) => !nameToId.has(path) && !markers.has(path));
}

/**
 * An operator or operand no quantifier-free arithmetic encoding admits.
 *
 * These are refusals the numeric surface does not make, because it EVALUATES at
 * a point and this layer must hand a formula to a solver. `%` and a variable
 * exponent have no linear or polynomial reading; a string or `null` operand is
 * not arithmetic at all. Each is listed with its reason rather than dropped.
 */
function unsupportedOperator(node: ExprNode): Refusal | undefined {
  switch (node.kind) {
    case 'str':
      return {
        reason: 'non-numeric-operand',
        detail: `the body compares the string literal "${node.value}"; only numeric and boolean operands are encoded`,
      };
    case 'null':
      return {
        reason: 'non-numeric-operand',
        detail: 'the body reads `null`, which has no arithmetic encoding',
      };
    case 'unary':
      return unsupportedOperator(node.operand);
    case 'if':
      return (
        unsupportedOperator(node.cond) ??
        unsupportedOperator(node.then) ??
        unsupportedOperator(node.else)
      );
    case 'binary': {
      if (node.op === '%') {
        return {
          reason: 'unsupported-operator',
          detail: 'the remainder operator `%` has no encoding in this fragment',
        };
      }
      if (node.op === '^' && node.right.kind !== 'num') {
        return {
          reason: 'unsupported-operator',
          detail: 'the exponent is not a literal, and a variable exponent has no polynomial reading',
        };
      }
      return unsupportedOperator(node.left) ?? unsupportedOperator(node.right);
    }
    default:
      return undefined;
  }
}

/** Does this expression read a variable nothing has pinned to a literal? */
function readsFree(node: ExprNode, free: ReadonlySet<string>): boolean {
  switch (node.kind) {
    case 'ref':
      return free.has(node.path.join('.'));
    case 'unary':
      return readsFree(node.operand, free);
    case 'binary':
      return readsFree(node.left, free) || readsFree(node.right, free);
    case 'if':
      return (
        readsFree(node.cond, free) || readsFree(node.then, free) || readsFree(node.else, free)
      );
    default:
      return false;
  }
}

/**
 * Is this relation nonlinear once the model's own literals are substituted?
 *
 * A product of two free variables, a division BY a free variable and a power
 * other than 0 or 1 over a free base are the three shapes that leave linear
 * real arithmetic. Everything else — a literal coefficient, a division by a
 * literal, a sum of any length — stays in QF_LRA, which is the fragment the
 * flagship example's two guarantees land in as the model stands.
 */
function isNonlinear(node: ExprNode, free: ReadonlySet<string>): boolean {
  switch (node.kind) {
    case 'unary':
      return isNonlinear(node.operand, free);
    case 'if':
      return (
        isNonlinear(node.cond, free) ||
        isNonlinear(node.then, free) ||
        isNonlinear(node.else, free)
      );
    case 'binary': {
      if (isNonlinear(node.left, free) || isNonlinear(node.right, free)) return true;
      if (node.op === '*') return readsFree(node.left, free) && readsFree(node.right, free);
      if (node.op === '/') return readsFree(node.right, free);
      if (node.op === '^') {
        if (node.right.kind !== 'num') return true;
        return node.right.value !== 0 && node.right.value !== 1 && readsFree(node.left, free);
      }
      return false;
    }
    default:
      return false;
  }
}

/* ─────────────────────────── the inventory ───────────────────────────────── */

/** The clause metaclass a requirement body's `assume` / `require` maps to. */
const CLAUSE_KIND = 'ConstraintUsage';

/** Is this element an `assume` or `require` clause carrying a body? */
function clauseRole(el: ElementRecord): 'assume' | 'require' | undefined {
  if (el.eClass !== CLAUSE_KIND) return undefined;
  const role = el.attrs.requirementRole;
  if (role === 'assume' || role === 'require') return role;
  return undefined;
}

/** The `objective` clause of a case, if it has one of its own. */
function objectiveOf(model: Model, el: ElementRecord): ElementRecord | undefined {
  return model
    .children(el.id)
    .find((c) => c.eClass === CLAUSE_KIND && c.attrs.requirementRole === 'objective');
}

/**
 * The subject of a requirement: its own `subject` clause, else one inherited
 * through `effectiveFeatures`.
 *
 * The inherited path is what commit 2b opened: `requirement r : MassLimit;`
 * where the DEFINITION declares the subject is the standard's ordinary way of
 * stating it once, and a contract reader that could not follow it would report
 * a subject-less contract for the most idiomatic shape there is.
 */
function subjectOfRequirement(model: Model, el: ElementRecord): ContractSubject | null {
  const own = model.children(el.id).find((c) => c.attrs.requirementRole === 'subject');
  if (own) return subjectFrom(model, own, 'declared');
  const inherited = effectiveFeatures(model, el.id).find(
    (c) => c.attrs.requirementRole === 'subject',
  );
  if (inherited) return subjectFrom(model, inherited, 'inherited');
  return null;
}

/** Read a subject clause into `{name, typeRef, origin}`. */
function subjectFrom(
  model: Model,
  el: ElementRecord,
  origin: ContractSubject['origin'],
): ContractSubject {
  const typed = model.typesOf(el.id)[0];
  const declared = el.attrs.type ?? el.attrs.typeRef;
  const typeRef =
    typed?.declaredName ?? (typeof declared === 'string' && declared !== '' ? declared : null);
  return { name: el.declaredName ?? '', typeRef, typeId: typed?.id ?? null, origin };
}

/**
 * The subject of a case objective.
 *
 * A case that declares its own subject uses it. Otherwise the standard supplies
 * one, and WHICH way it supplies it is the difference §2.1 turns on:
 * `Cases.sysml` writes `subject subj default Case::result;` — a DEFAULT, which
 * an author may override — while `VerificationCases.sysml` writes
 * `subject subj = VerificationCase::subj;` — a BINDING, which is an axiom. The
 * report says which of the two it read rather than printing one name for both.
 */
function subjectOfCase(model: Model, el: ElementRecord): ContractSubject {
  const declared = subjectOfRequirement(model, el);
  if (declared) return declared;
  return VERIFICATION_CASE_KINDS.has(el.eClass)
    ? {
        name: 'subj',
        typeRef: 'VerificationCases::VerificationCase::subj',
        typeId: null,
        origin: 'case-bound',
      }
    : { name: 'result', typeRef: 'Cases::Case::result', typeId: null, origin: 'case-default' };
}

/** The relationship metaclasses each traceability orientation is written with. */
const SATISFY_KINDS = new Set(['Satisfy', 'SatisfyRequirementUsage']);

/** The sources of every relationship of `kinds` whose TARGET is `id`. */
function incoming(model: Model, id: ElementId, kinds: ReadonlySet<string>): ContractRef[] {
  const out: ContractRef[] = [];
  for (const rel of model.relationshipsTo(id)) {
    if (!kinds.has(rel.eClass)) continue;
    for (const src of rel.source ?? []) {
      const el = model.get(src);
      if (el) out.push(ref(model, el));
    }
  }
  return out;
}

/** Build one clause record from a clause element. */
function readClause(
  model: Model,
  el: ElementRecord,
  role: 'assume' | 'require',
  via: 'requirement' | 'objective',
  memo: DerivationMemo,
): ContractClause {
  const raw = typeof el.attrs.expression === 'string' ? el.attrs.expression : '';
  const reading = readRelation(model, el, raw, memo);
  return {
    id: el.id,
    qualifiedName: model.qualifiedName(el.id),
    ...(el.declaredName !== undefined ? { declaredName: el.declaredName } : {}),
    role,
    via,
    expression: raw,
    node: reading.node,
    variables: reading.variables,
    sortPerVar: reading.sortPerVar,
    encodable: reading.encodable,
    nonlinear: reading.nonlinear,
    fragment: reading.fragment,
  };
}

/** The clauses a requirement or a case objective carries, in document order. */
function clausesOf(
  model: Model,
  el: ElementRecord,
  memo: DerivationMemo,
): ContractClause[] {
  const out: ContractClause[] = [];
  const isCase = CASE_KINDS.has(el.eClass);
  const owner = isCase ? objectiveOf(model, el) : el;
  if (!owner) return out;
  const via: 'requirement' | 'objective' = isCase ? 'objective' : 'requirement';
  for (const child of model.children(owner.id)) {
    const role = clauseRole(child);
    if (role === undefined) continue;
    if (typeof child.attrs.expression !== 'string' || child.attrs.expression.trim() === '') continue;
    out.push(readClause(model, child, role, via, memo));
  }
  // An objective written as a bare body — `objective { alt > 0.0 }` — states the
  // check itself rather than naming a clause for it. It is the case's
  // guarantee, and dropping it would report an objective as empty when the
  // model is not.
  if (isCase && owner !== el) {
    const bare = owner.attrs.expression;
    if (typeof bare === 'string' && bare.trim() !== '') {
      out.push(readClause(model, owner, 'require', 'objective', memo));
    }
  }
  return out;
}

/**
 * The definitions an element inherits `assume` / `require` clauses from.
 *
 * Read for the one thing this module refuses to do with them: a usage does not
 * re-file its definition's clauses, because the definition is a user element
 * with a contract of its own and filing both would put one clause in the
 * worklist twice. What the usage MUST NOT be reported as is a requirement with
 * nothing to encode — `requirement massOk : MassLimit;` is the idiomatic way to
 * apply a requirement, it is what a `satisfy` names, and calling it prose-only
 * would inflate `--missing`, which is the figure that measures how much of a
 * model this lane cannot reach.
 */
function inheritedClauseOwners(model: Model, el: ElementRecord): ContractRef[] {
  const out: ContractRef[] = [];
  const seen = new Set<ElementId>();
  for (const feature of effectiveFeatures(model, el.id)) {
    if (feature.ownerId === el.id) continue;
    if (clauseRole(feature) === undefined) continue;
    if (typeof feature.attrs.expression !== 'string' || feature.attrs.expression.trim() === '') {
      continue;
    }
    const owner = feature.ownerId != null ? model.get(feature.ownerId) : undefined;
    if (!owner || seen.has(owner.id)) continue;
    seen.add(owner.id);
    out.push(ref(model, owner));
  }
  return out;
}

/** The weakest fragment that admits every clause of a contract. */
function rollUp(clauses: readonly ContractClause[]): Fragment {
  if (clauses.length === 0) return 'unsupported';
  if (clauses.some((c) => c.fragment === 'unsupported')) return 'unsupported';
  if (clauses.some((c) => c.fragment === 'temporal')) return 'temporal';
  return clauses.some((c) => c.fragment === 'qf-nra') ? 'qf-nra' : 'qf-lra';
}

/**
 * Every contract in the user's own model.
 *
 * A requirement always yields a contract, even with nothing in its body: a
 * requirement with prose and no constraint is the single most common thing a
 * real requirement set is full of, and reporting it as absent rather than as
 * `no formal clause` is how a worklist comes to under-state what it cannot
 * decide. A `#prose` or `#prompt` statement yields none — the author said it
 * binds nothing.
 *
 * A case yields a contract only when its `objective` actually carries a clause
 * or a body of its own, because an objective with nothing in it states nothing.
 */
export function contractsOf(model: Model): Contract[] {
  const memo: DerivationMemo = new Map();
  const out: Contract[] = [];
  for (const el of model.all()) {
    if (!isUserModelElement(model, el)) continue;
    const isRequirement = REQUIREMENT_SET.has(el.eClass);
    const isCase = CASE_KINDS.has(el.eClass);
    if (!isRequirement && !isCase) continue;
    if (isRequirement && isNonNormativeStatement(model, el.id)) continue;
    const clauses = clausesOf(model, el, memo);
    if (isCase && clauses.length === 0) continue;
    out.push(assemble(model, el, clauses, isCase));
  }
  return out;
}

/** Assemble one contract from its element and its clauses. */
function assemble(
  model: Model,
  el: ElementRecord,
  clauses: ContractClause[],
  isCase: boolean,
): Contract {
  const variables: ContractVariable[] = [];
  const seen = new Set<string>();
  for (const c of clauses) {
    for (const v of c.variables) {
      // Deduplicated by PATH, the way each clause's own list is: two ports of
      // one definition read the same element and are still two quantities.
      if (seen.has(v.path)) continue;
      seen.add(v.path);
      variables.push(v);
    }
  }
  return {
    id: el.id,
    qualifiedName: model.qualifiedName(el.id),
    shortId: REQUIREMENT_SET.has(el.eClass)
      ? requirementShortId(model, el.id)
      : (el.declaredShortName ?? ''),
    eClass: el.eClass,
    ...(el.declaredName !== undefined ? { declaredName: el.declaredName } : {}),
    subject: isCase ? subjectOfCase(model, el) : subjectOfRequirement(model, el),
    assumptions: clauses.filter((c) => c.role === 'assume'),
    guarantees: clauses.filter((c) => c.role === 'require'),
    satisfiedBy: incoming(model, el.id, SATISFY_KINDS),
    derivedFrom: incoming(model, el.id, new Set(['Derive'])),
    refinedBy: incoming(model, el.id, new Set(['Refine'])),
    verifiedBy: incoming(model, el.id, new Set(['Verify'])),
    variables,
    fragment: rollUp(clauses),
    unsupported: clauses
      .filter((c) => c.encodable !== true)
      .map((c) => ({
        expression: c.expression,
        reason: (c.encodable as Refusal).reason,
        detail: (c.encodable as Refusal).detail,
      })),
    clausesInheritedFrom: clauses.length === 0 ? inheritedClauseOwners(model, el) : [],
    keywords: keywordsOnDeclaration(el),
  };
}

/** The contract of one requirement or case, or `undefined` when it has none. */
export function contractOf(model: Model, id: ElementId): Contract | undefined {
  return contractsOf(model).find((c) => c.id === id);
}

/**
 * The verdict facet a requirement CLAIMS, with no evidence behind it.
 *
 * Read here rather than judged: a hand-written `verdict = "pass"` is a claim
 * the file makes, and the honest report of it is "claimed pass, no evidence"
 * until an evidence record exists to check it against.
 */
export function claimedVerdictOf(model: Model, id: ElementId): string | undefined {
  const el = model.get(id);
  if (!el || !REQUIREMENT_SET.has(el.eClass)) return undefined;
  return getRequirementAttr(model, id, 'verdict');
}

/**
 * Numeric constraint solver, measure-of-effectiveness (MoE) evaluation, and
 * gradient-free optimization over a {@link Model}.
 *
 * This layers a *numeric* analysis on top of the static semantics engine —
 * reusing the expression parser/evaluator ({@link ./expr}), connector/binding
 * value propagation ({@link ./connectors}.propagateValues) and the dimensional
 * engine ({@link ./units}) — so a parametric model's equations can be solved to
 * concrete numbers, its measures of effectiveness read off, and a design
 * variable swept to optimize an objective.
 *
 *  - {@link gatherConstraints} — collect the model's numeric relations as
 *    {@link Equation}s over feature ids: ConstraintUsage/CalculationUsage bodies
 *    of the form `lhs = rhs`, FeatureValue expression assignments
 *    (`feature = expr`), and BindingConnector equalities (`a = b`).
 *  - {@link solve} — seed known literal values, then drive every equation to a
 *    fixpoint by constraint propagation (orienting each equation to solve for its
 *    single remaining unknown) + binding propagation, finishing coupled/implicit
 *    residuals with a bounded finite-difference Newton (least-squares) step.
 *  - {@link evaluateMoEs} — identify measure-of-effectiveness features (owned by
 *    an AnalysisCase/VerificationCase, flagged `attrs.isMoe`, named
 *    MoE/measure/objective, or an analysis-case return parameter) and read their
 *    solved values (with unit/dimension).
 *  - {@link optimize} — coordinate-descent / golden-section optimization of an
 *    objective feature over bounded variables, re-solving the constraints at each
 *    trial.
 *
 * UNITS. A relation whose variables carry units is evaluated in SI: each
 * relation gets a per-variable affine map ({@link Equation.scale}) built behind
 * the gates in {@link scaleOfRelation}, `[unit]` literals in its body are
 * lowered to SI magnitudes, and a value solved FOR is converted back. Those
 * gates and the lowering live in {@link ./relations} — this module is one
 * CONSUMER of them, not their owner, so a second engine encodes from the same
 * scale map rather than from a second reading of the same rules. Solved
 * VALUES stay in each feature's own storage unit, so the published shape of
 * {@link SolveResult}, {@link SolveOptions.fixed} and
 * {@link OptimizeOptions.bounds} is unchanged. The unit-aware evaluator of
 * {@link ./units-eval} supplies the VERDICT in {@link checkConstraintsNumeric},
 * which is what keeps this surface and `checkConstraints` from answering the
 * same model differently.
 *
 * STATEMENT KINDS. A constraint the author tagged `#prose` or `#prompt` binds
 * nothing (`./statement-kind` {@link isNonNormativeStatement}), and this
 * surface honours that exactly as the validator, `constraintReport` and the
 * Simulate panel do: such a body is neither an equation nor an inequality
 * ({@link gatherConstraints}, {@link gatherInequalities}) and gets no row in
 * {@link checkConstraintsNumeric}. Before it did, a `#prose constraint pc
 * { mass <= 2000.0 }` was reported violated by the Solve run in the same
 * Problems panel the other three surfaces keep quiet in, made
 * `analysisReport.feasible` false on its account, and a tagged equality SOLVED
 * the feature it named. The exemption is asked with the same predicate, not
 * with `!isNormative`: a plain `constraint c { … }` carries no kind and is
 * judged exactly as it always was.
 *
 * Every function is deterministic and bounded. This is an ORIGINAL, clean-room
 * implementation (no third-party solver was copied).
 */

import { type ElementId, type ElementRecord, type Model, isUsage } from '@core/index';
import {
  evaluateDecided,
  statedRational,
  tieSentence,
  writtenRational,
  type ExactScope,
} from './exact';
import { parseExpr, evaluate, type ExprNode } from './expr';
import { isBindingEdge, propagateValues } from './connectors';
import {
  anchorFor,
  checkConstraints,
  checksByRow,
  evaluateFeatureValue,
  readRefusalOf,
  undecidedPartnersRead,
  unreadValuesOf,
  type ConstraintCheck,
} from './evaluate-model';
import {
  baseIdOf,
  defaultGivesWay,
  defaultGivesWayIn,
  defaultGivesWaySomewhere,
  statedAgainstBoundSomewhere,
  defaultStandsIn,
  enclosedBindingFrame,
  equatedPartsRefusal,
  givenWayThroughHead,
  contradictedDefinitionRefusal,
  hasEnclosedBindings,
  hasPastCapBindings,
  hasStatedValue,
  instanceGroups,
  isAsserted,
  isParameterisedCalculation,
  MAX_INSTANCE_RELATIONS,
  outsideBindingsOf,
  pastCapEnd,
  readsContradictedDefinition,
  relationNamesOf,
  shadowedNamesOf,
  shadowedSentence,
  sharedDefinitions,
  spelledIn,
  statedValueOf,
  typedAssertHolding,
  typedAssertNames,
  typedAssertsName,
  writesStandingDefault,
  usageOwnedRefusal,
  type InstanceAbstention,
  type InstanceReading,
} from './defining-equation';
import { effectiveNameOf, generalizationsOf, redefinedClosure } from './inheritance';
import { isNonNormativeStatement } from './statement-kind';
import {
  NO_MARKERS,
  lowerUnitLiterals,
  mergedScope,
  namesReadIn,
  parseRelationBody,
  relationRefused,
  relationScope,
  relationVarsOf,
  scaleOfRelation,
  substituteLiterals,
  withValueUnit,
  type LoweredBody,
  type MarkerDimensions,
  type ScaleMap,
} from './relations';
import {
  definitionDerivation,
  definitionsOf,
  featuresDefinedBy,
  derivationOf,
  derivedDimensionOf,
  declaredFacetsOf,
  dimensionalFacets,
  evaluateConstraintQuantityDetailed,
  evaluateQuantity,
  expressionValueUnitOf,
  isRefusalReason,
  isUnresolvedSentence,
  operandDerivation,
  valueUnitRefusal,
  type DerivationMemo,
  type Quantity,
} from './units-eval';
import {
  DIMENSIONLESS,
  dimEqual,
  dimToString,
  resolveUnit,
  siSymbolOf,
  type Dimension,
} from './units';

/**
 * Per-equation RELATIVE residual floor (finding M6): the fraction of an
 * equation's magnitude below which a residual is indistinguishable from
 * floating-point rounding noise (double eps ≈ 2.2e-16; this ~45× margin covers
 * accumulated rounding without masking real violations). A residual larger than
 * `RESIDUAL_FLOOR · scale` is a REAL constraint violation, so this is the
 * loosest a scale-relative convergence test may be: the `1e-6 · scale` first
 * attempt rubber-stamped genuinely-unsolved systems, and even `1e-12` was loose
 * enough that an equation with large CANCELLING subterms (e.g.
 * `x + 1e9 − 1e9 = 5`, whose `equationScale` is ~1e9) hid a real 1e−4 error
 * (Fable D1 follow-up). At 1e-14 the gate there is 1e−5, catching that error,
 * while a genuine `x·x = 1e16` solve (achievable residual ~10) still clears its
 * ~1e2 gate comfortably.
 */
const RESIDUAL_FLOOR = 1e-14;

/* ─────────────────────────────── types ───────────────────────────────── */

/**
 * A single numeric relation `lhs = rhs` over feature ids. `expr` is the residual
 * node `lhs − rhs` (zero when the relation holds); `vars` are the ids of the
 * features the relation constrains; `nameToId` resolves the (possibly dotted)
 * names used in `lhs`/`rhs` to those feature ids.
 */
export interface Equation {
  /** Feature ids this equation relates. */
  vars: ElementId[];
  /** Residual expression `lhs − rhs` (evaluates to 0 when satisfied). */
  expr: ExprNode;
  /** Left-hand side expression. */
  lhs: ExprNode;
  /** Right-hand side expression. */
  rhs: ExprNode;
  /** The source text of the relation. */
  raw: string;
  /** Resolver from a name used in the equation to the feature id it denotes. */
  nameToId: Map<string, ElementId>;
  /**
   * Per-variable affine map into SI (`UnitScale` of {@link ./relations}),
   * present only when the relation passed every scaling gate (see
   * {@link scaleOfRelation}). When set, the equation is READ in SI: every
   * value is `v · factor + offset` on the way in, and a value solved FOR is
   * converted back to its storage unit.
   */
  scale?: ScaleMap;
  /**
   * The features this relation is the DEFINITION of: an asserted equation the
   * shared rule ({@link definitionsOf}) picks for a feature that states no
   * value. Such a feature is solved from its definition and from no other
   * equality, so the value the solver finds is the one the validation surface
   * says the equation defines.
   */
  defines?: ElementId[];
  /**
   * The feature whose STATED value this relation is — a feature value
   * expression (`c3 = c2 / 4.0`) or a calculation's value body. Such a
   * feature is no design freedom: a definition that reads it is determined
   * through it ({@link closedByDefinitions}).
   */
  states?: ElementId;
  /**
   * An `assert`'s relation — the user's, or one an instance holds of its
   * types: never what fixes a `default` a binding made give way ({@link
   * givenWayDefaults}).
   */
  asserted?: true;
  /**
   * A package's binding on a definition's feature, read at one instance of it
   * (`bind P::load = M` at w's p2): the head the instance's slot joins to the
   * package's own feature. See {@link headBindingsCarrying}.
   */
  head?: true;
}

/** Options for {@link solve}. */
export interface SolveOptions {
  /** Residual tolerance for convergence (default 1e-9). */
  tol?: number;
  /** Maximum solver iterations (default 200). */
  maxIter?: number;
  /** Restrict the gathered equations to this element and its descendants. */
  scopeId?: ElementId;
  /**
   * Feature values held CONSTANT for this solve (used by {@link optimize} to fix
   * the trial design variables). Overrides any literal seed and is never
   * overwritten by propagation.
   *
   * Plain numbers in each feature's own STORAGE unit — its declared unit, else
   * the coherent SI unit of its quantity kind — exactly as before units
   * entered the solver. Unit conversion happens inside a relation, not on this
   * boundary, so no caller of this API had to change.
   */
  fixed?: Map<ElementId, number> | Record<ElementId, number>;
}

/** Result of {@link solve}. */
export interface SolveResult {
  /**
   * featureId → solved numeric value (only determined features), in the
   * feature's STORAGE unit: its declared unit when it has one, else the
   * coherent SI unit of its declared quantity kind. `5 [km] + 400 [m]` solves
   * to 5400 in a unit-less `LengthValue` and to 5.4 in one declaring `[km]`.
   * Never a value the solve stopped at without converging — off an equation
   * it solved, that point is no solution — nor is such a feature {@link free}.
   */
  values: Map<ElementId, number>;
  /** True when every gathered equation is determined and its residual < tol. */
  converged: boolean;
  /** Number of solver iterations performed. */
  iterations: number;
  /** The largest absolute residual across the determined equations. */
  residual: number;
  /**
   * The features the equations leave FREE — a design freedom no stated value
   * and no relation fixes. The solve stopped at one point along it; that point
   * is a choice, not an answer, so none of these is in {@link values}. Read
   * from the rank of the equations at that point, so it is LOCAL: each of two
   * isolated roots (`x * x == 4.0`) reads as determined.
   */
  free: ElementId[];
}

/** One evaluated measure of effectiveness. */
export interface MeasureResult {
  /** Element id of the measure feature. */
  id: ElementId;
  /** Declared name (empty when anonymous). */
  name: string;
  /** Solved numeric value, or `null` when it could not be determined. */
  value: number | null;
  /** The unit the value is expressed in, when known. */
  unit?: string;
  /** Human-readable physical dimension (e.g. `L·M·T⁻²`), when known. */
  dimension?: string;
}

/** The sense of an {@link optimize} objective. */
export type OptimizeSense = 'min' | 'max';

/** Options for {@link optimize}. */
export interface OptimizeOptions {
  /** Minimise (default) or maximise the objective. */
  sense?: OptimizeSense;
  /**
   * Inclusive `[lo, hi]` search bounds per variable id, in the variable's
   * STORAGE unit (see {@link SolveOptions.fixed}) — a `[km]` feature is bounded
   * in kilometres.
   */
  bounds?: Map<ElementId, [number, number]> | Record<ElementId, [number, number]>;
  /** Maximum coordinate-descent sweeps (default 40). */
  maxIter?: number;
  /** Convergence tolerance on the objective / variable step (default 1e-7). */
  tol?: number;
  /**
   * Respect the model's inequality constraints ({@link gatherInequalities}): a
   * large penalty is added for any violation so the returned optimum is feasible
   * (or as close to feasible as the bounds allow).
   */
  constraints?: boolean;
}

/** Result of {@link optimize}. */
export interface OptimizeResult {
  /** variableId → optimal value. */
  best: Map<ElementId, number>;
  /** The objective value at {@link best}. */
  value: number;
  /** The sense that was optimized. */
  sense: OptimizeSense;
  /**
   * Whether the optimum satisfies every model inequality (within tolerance). Only
   * populated when `opts.constraints` was set; `undefined` otherwise — and
   * whenever a bound has no value to be read at the optimum (over a feature
   * {@link free} there, or one nothing gives a value) and no bound is known to
   * be violated.
   */
  feasible?: boolean;
  /**
   * The features the equations leave free once the variables are fixed, when
   * the objective or a bound reads one. Read by the objective, or by a bound
   * at the start, the search is not run and `value` is NaN; read by a bound
   * only at the optimum, that bound is unjudged and {@link feasible} unset.
   */
  free?: ElementId[];
}

/* ──────────────────────── inequality / feasibility ───────────────────── */

/** A comparison operator that forms an inequality constraint. */
export type ComparisonOp = '<' | '<=' | '>' | '>=';

/**
 * A single inequality constraint normalised to the residual form `g(x) <= 0`
 * (so `a > b` is stored negated as `b − a <= 0`). {@link expr} is the residual
 * node `g`; the constraint holds when `g <= 0` and its violation amount is
 * `max(0, g)`.
 */
export interface Inequality {
  /** Feature ids this inequality relates. */
  vars: ElementId[];
  /** Residual expression `g` — the inequality holds iff `g <= 0`. */
  expr: ExprNode;
  /** The original comparison operator (before normalisation). */
  op: ComparisonOp;
  /** Element id of the constraint carrying the body. */
  id: ElementId;
  /** Declared name of the constraint (empty when anonymous). */
  name: string;
  /** The source text of the relation. */
  raw: string;
  /** Resolver from a name used in the inequality to the feature id it denotes. */
  nameToId: Map<string, ElementId>;
  /** SI scaling of the variables — see {@link Equation.scale}. */
  scale?: ScaleMap;
}

/** One violated constraint reported by {@link solveFeasible}. */
export interface ConstraintViolation {
  /** Element id of the violated constraint. */
  id: ElementId;
  /** Declared name (empty when anonymous). */
  name: string;
  /**
   * The amount by which the constraint is violated (> 0); NaN for a relation
   * with no residual — a connective, a `!=` — which is violated or not.
   */
  amount: number;
}

/** Result of {@link solveFeasible}. */
export interface FeasibilityResult {
  /**
   * featureId → value at the feasible (or best-effort) point: the values the
   * equations determine, and the point the search chose along each freedom.
   */
  values: Map<ElementId, number>;
  /**
   * True when every relation judged at {@link values} holds there: every
   * inequality, and every other constraint the numeric surface can judge (a
   * connective, a `!=`) within tolerance; every equality the search moved a
   * feature of; and every asserted equation, binding, feature value and plain
   * equation the solve took as a design equation. A plain equality check the
   * solve did not impose is not asked. False is NO witness found —
   * infeasibility only when {@link decided}.
   */
  feasible: boolean;
  /**
   * The violated inequalities (and other constraints) over values the
   * equations DETERMINE: those fail whatever the freedoms are. Empty when
   * {@link feasible}.
   */
  violations: ConstraintViolation[];
  /** Number of penalty-descent sweeps performed. */
  iterations: number;
  /**
   * Whether {@link feasible} is an ANSWER: true for a feasible point at which
   * every constraint in scope was judged, and for a violation over values the
   * equations determine at a point on the model's own equations. False when
   * the search over the design freedoms ({@link free}) stopped without a
   * witness — the search is local, so that says nothing about whether one
   * exists: no feasible choice found, which is not infeasibility — when the
   * point misses an equation of the model's own, and when a constraint could
   * not be judged there (an inequality with no residual, a relation over a
   * Boolean the numeric surface does not read): every relation judged may
   * hold, and the model's answer is still open.
   */
  decided: boolean;
  /** The design freedoms the search moved. */
  free: ElementId[];
  /**
   * Inequalities (and other constraints) over a design freedom still violated
   * where the search stopped: not shown to fail, because the search is local.
   */
  unresolved: ConstraintViolation[];
}

/** One numerically-evaluated equality/inequality for the Check surface. */
export interface NumericConstraintResult {
  /** Element id of the constraint. */
  id: ElementId;
  /** Declared name (empty when anonymous). */
  name: string;
  /** The source text of the relation. */
  raw: string;
  /**
   * The shape of the relation: an equality (`==`, a calculation body), an
   * ordering `inequality`, or `boolean` for a body that is neither — a logical
   * connective such as `a > 1.0 and b > 2.0`, which the unit-aware evaluator
   * judges but the scalar residual path has no slack for, or a `!=`, which
   * the scalar path judges as the negation of its equality and reports no
   * slack for either.
   */
  kind: 'equality' | 'inequality' | 'boolean';
  /** The comparison operator (inequalities only). */
  op?: ComparisonOp;
  /** Verdict at the solved values. */
  result: 'satisfied' | 'violated' | 'unknown';
  /**
   * Signed slack: for an inequality, `−g` (positive is margin to spare); for an
   * equality, the residual `lhs − rhs`. `null` when it could not be evaluated.
   * Expressed in {@link slackUnit} when the relation was judged dimensionally,
   * else in the raw magnitudes the model declares.
   */
  slack: number | null;
  /**
   * Violation magnitude — 0 when satisfied or unknown, and ALSO 0 for a STRICT
   * ordering violated exactly at its boundary (`mass < 25.0` at 25 kg), where
   * the violation is the tie itself and there is no magnitude to report. Read
   * {@link result}, never this number, to learn whether a relation holds.
   */
  amount: number;
  /**
   * The coherent SI unit {@link slack} and {@link amount} are expressed in —
   * set only for a relation judged dimensionally. Absent means the numbers are
   * raw declared-unit magnitudes (the unitless and bare-literal cases).
   */
  slackUnit?: string;
  /**
   * Why the relation is `unknown` — the unit-aware evaluator's sentence — or,
   * on a row the solve {@link imposed}, that it was imposed by the solve.
   */
  reason?: string;
  /**
   * Set on a `satisfied` PLAIN constraint (no `assert`) the solve itself took
   * as a design equation — it fixed a value no value the model states fixes,
   * from this relation (`constraint { a == 3.0 }` over a valueless `a`). It
   * holds because the solve made it hold, so the verdict is no check passed:
   * imposed by the solve. Absent on an asserted equation, which holds by
   * assertion, and on a relation over values the model states.
   */
  imposed?: true;
  /**
   * Set on a definition's relation read in a context that specialises the
   * definition (`id` is then `<baseId>@<contextId>`): the relation, and the
   * context it was read in — `instances` of `checkConstraints`. `path` is the
   * instance path a group row reads through (F7); for a context row without
   * one it is absent, and `contextId` names the context.
   */
  context?: { baseId: ElementId; contextId: ElementId; path?: string };
  /**
   * The element the anchor rule re-anchored this row to (F7); absent on a row
   * anchored at the relation itself. The app's Solve rows point at it, falling
   * back to `context.baseId`.
   */
  anchorId?: ElementId;
  /**
   * On an `unknown` {@link context} row that abstained (A.9): why, as a kind
   * (`SpecialisationInstance.cause` of ./evaluate-model) — the same for every
   * instance of a relation that abstains for one reason, where each row's
   * {@link reason} names its own instance. The app's Solve rows fold by it.
   */
  cause?: InstanceAbstention;
  /**
   * Set on a row that is a value the model states twice, not a relation
   * (`ConstraintCheck.conflict` of ./evaluate-model) — a binding connector's
   * two ends among them (`bind`), and asserted equations that give one feature
   * with no value two values (`equations`).
   */
  conflict?: 'binding' | 'clash' | 'bind' | 'equations';
}

/** Options for {@link solveFeasible}. */
export interface FeasibilityOptions extends SolveOptions {
  /** Maximum penalty-descent sweeps (default 60). */
  sweeps?: number;
}

/* ────────────────── dimensions for the reported slack ────────────────── */

/** The dimension a feature's magnitude is expressed in, when it has one. */
function featureDimension(model: Model, id: ElementId, memo: DerivationMemo): Dimension | undefined {
  const facets = declaredFacetsOf(model, id);
  return facets.unitDimension ?? facets.kindDimension ?? derivedDimensionOf(model, id, memo);
}

/* ──────────────────────── constraint gathering ───────────────────────── */

/** Metaclasses whose `attrs.expression` carries a numeric relation body. */
const RELATION_KINDS = new Set(['ConstraintUsage', 'CalculationUsage']);

/**
 * Collect the model's numeric relations as {@link Equation}s over feature ids:
 *
 *  1. **ConstraintUsage / CalculationUsage** bodies (`attrs.expression`) of the
 *     form `lhs = rhs` (a `==`/`=` equality, or a boolean equality constraint) —
 *     a CalculationUsage body that is a bare expression becomes `self = expr`.
 *  2. **FeatureValue assignments** — any feature whose `attrs.value` is an
 *     expression referencing other features becomes `feature = expr`.
 *  3. **BindingConnector equalities** — each binding/`bind` connector becomes
 *     `sourceEnd = targetEnd`.
 *
 * Variable names are resolved to feature ids via a scope built from each
 * relation's context (its owner's effective features). When `scopeId` is given,
 * only relations at or under that element are gathered.
 */
export function gatherConstraints(model: Model, scopeId?: ElementId): Equation[] {
  return gatherSystem(model, scopeId).eqs;
}

/** The equations of a model, and the features whose own value cannot be read. */
interface GatheredSystem {
  eqs: Equation[];
  unreadable: Set<ElementId>;
  /** The constraint or calculation usage each relation-body equation is the body of. */
  relationOf: Map<Equation, ElementRecord>;
  /**
   * The variables an ASSERTED relation reads that the solve gathers no
   * equation from — an inequality, a conjunction, a disjunction (`L == 50.0
   * and L >= 0.0`) — each with the asserts that read it: the model constrains
   * them in a form the solve does not read ({@link heldByUnreadAsserts}).
   */
  held: Map<ElementId, ElementId[]>;
}

/** Record that the asserted relation `by` reads the variable `v` ({@link GatheredSystem.held}). */
function holdVar(held: Map<ElementId, ElementId[]>, v: ElementId, by: ElementId): void {
  const list = held.get(v);
  if (!list) held.set(v, [by]);
  else if (!list.includes(by)) list.push(by);
}

/**
 * The variables the relation `el` reads — each path read through an instance
 * of its own keyed to that instance's variable ({@link keyedNames}),
 * `instance` re-rooting the reading for one of its owner's instances — whatever
 * the shape of its body: a conjunction's, a disjunction's or an inequality's
 * names, which no equation of the solve carries — and the names a body that
 * does not parse writes ({@link writtenNames}): the model carries the parse
 * diagnostic, and what the text names it constrains all the same.
 */
function relationReads(model: Model, el: ElementRecord, instance?: string): ElementId[] {
  const raw = el.attrs.expression;
  if (typeof raw !== 'string') return [];
  const node = parseRelationBody(raw)?.node ?? writtenNames(raw);
  if (!node) return [];
  const scope = relationScope(model, el);
  const keyed = keyedNames(model, el, node, scope, instance);
  return relationVarsOf(node, keyed?.nameToId ?? scope);
}

/** A string literal in a relation body, either quote (a backslash escapes the next character). */
const STRING_LITERAL_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;

/**
 * The names a relation body that does not parse writes (`M == max(L, 20.0)`,
 * `M == L ** 2.0`) — every dotted identifier in its text, a numeral's exponent
 * excluded — as one node that reads them all, or `undefined` for none. A name
 * that denotes no feature is read by nothing downstream, so a function's own
 * name costs nothing: the set errs wide, never narrow. What is read is the text
 * without its string literals and `[unit]` literals: the `m` in `M ** 2.0 ==
 * 4.0 [m]` is a metre, and read as the feature `m` it held that feature as one
 * the assert constrains.
 */
function writtenNames(raw: string): ExprNode | undefined {
  let node: ExprNode | undefined;
  const lowered = lowerUnitLiterals(raw.replace(STRING_LITERAL_RE, ' '));
  for (const text of new Set(lowered.text.match(/(?<![\w.])[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g) ?? [])) {
    if (lowered.literals.has(text)) continue;
    const ref: ExprNode = { kind: 'ref', path: text.split('.') };
    node = node ? { kind: 'binary', op: '+', left: node, right: ref } : ref;
  }
  return node;
}

/**
 * {@link gatherConstraints}, and the features whose OWN value the solver lane
 * cannot read: a feature value (or a calculation's value body) a gate refuses
 * — for its shape, or for what it reads ({@link readRefusalOf}, {@link
 * unreadValuesOf}): `total = p.e * 2.0` over a chain the validation surface
 * reads no value through, `m = e + 5.0` with a bare number against a derived
 * duration inside it.
 *
 * Such a feature states a value; it is no design freedom. Left a plain unknown
 * it was one anyway: `solveFeasible` drove `total` to −1 to satisfy `total <=
 * 2.5` and reported the model feasible, and a check that equates it with a
 * number fixed it by propagation. It is solved from nothing, freed by nothing,
 * and every relation over it is left without a residual.
 *
 * So is a valueless feature whose ASSERTED definition a gate refuses (`assert
 * constraint dm { margin == endurance - 0.5 }` in a usage, over an inherited
 * `endurance` only the definition's own equation defines): the model says what
 * it is, and nothing here reads it. Left out of this set, `solveFeasible` moved
 * `margin` to 1.0 to meet `margin >= 1.0` and called the model feasible, and a
 * plain `constraint { f == 100.0 }` fixed `f` — the check then satisfied and
 * `f <= 10.0` violated, the reverse of what the definition says.
 */
function gatherSystem(model: Model, scopeId?: ElementId): GatheredSystem {
  const inScope = scopeFilter(model, scopeId);
  const eqs: Equation[] = [];
  const unreadable = new Set<ElementId>();
  const relationOf = new Map<Equation, ElementRecord>();
  const held = new Map<ElementId, ElementId[]>();
  const memo: DerivationMemo = new Map();

  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (!inScope(el)) continue;

    // (1) Constraint / calculation relation bodies. A `#prose` / `#prompt`
    // relation is not an equation: the author said it binds nothing, and
    // solving a feature from it would give that feature a value no normative
    // statement in the model asked for.
    if (RELATION_KINDS.has(el.eClass)) {
      if (isNonNormativeStatement(model, el.id)) continue;
      // A calculation's value body refused is a value nothing reads; so is
      // what a refused asserted equation is the definition of.
      const eq = relationEquation(model, el, memo, false, () => {
        if (hasStatedValue(model, el) || isParameterisedCalculation(model, el)) unreadable.add(el.id);
        for (const { id } of featuresDefinedBy(model, el, memo)) unreadable.add(id);
      });
      // An assert the solve reads no equation from still constrains what it
      // reads ({@link heldByUnreadAsserts}).
      if (!eq && isAsserted(el)) for (const v of relationReads(model, el)) holdVar(held, v, el.id);
      if (!eq) continue;
      const defines = definitionsOf(model, el, memo);
      if (isAsserted(el)) {
        const body = parseRelationBody(String(el.attrs.expression));
        for (const key of body ? instanceKeysDefinedBy(model, body.node, eq) : []) {
          if (!defines.includes(key)) defines.push(key);
        }
      }
      if (defines.length > 0) eq.defines = defines;
      if (isAsserted(el)) eq.asserted = true;
      eqs.push(eq);
      relationOf.set(eq, el);
      continue;
    }

    // (2) Feature-value expression assignments (only genuine expressions).
    if (isUsage(el.eClass)) {
      // A value that conflicts with a binding it overrides is read by no
      // surface: no seed, no equation, nothing solved for it — nor one a
      // binding joins somewhere to another value written with `=` (A.5).
      const definitions = sharedDefinitions(model);
      if (el.attrs.value !== undefined && (definitions.contradiction(el) || statedAgainstBoundSomewhere(model, el))) {
        unreadable.add(el.id);
        continue;
      }
      // A feature an assert typed by an equation's definition may define — its
      // `default`, given way, or no value at all (`assert constraint e : Eq {
      // in a = L; }`) — is no design freedom: the model states what it is, and
      // nothing here reads the equation that does. Free, a plain `p.load ==
      // 5.0` was solved as a design equation over CD13's L, and Q's `p.m2 >=
      // 0.0` decided at that 5 where L is 50.
      if (typedAssertNames(model, el)) {
        unreadable.add(el.id);
        continue;
      }
      // A `default` a binding overrides is no value of the feature's: the
      // binding's equation solves it, as it solves a valueless one.
      if (defaultGivesWaySomewhere(model, el)) continue;
      const eq =
        assignmentEquation(model, el, memo, () => unreadable.add(el.id)) ??
        redefinedValueEquation(model, el, memo, () => unreadable.add(el.id));
      if (eq) eqs.push(eq);
    }
  }

  // (3) BindingConnector / bind / equality connectors — each end read as the
  // feature whose value it is ({@link carriedEnd}).
  const bound: Array<[ElementId, ElementId]> = [];
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (!isBindingEdge(el)) continue;
    if (!inScope(el)) continue;
    const s = carriedEnd(model, el.source?.[0]);
    const t = carriedEnd(model, el.target?.[0]);
    if (s === undefined || t === undefined) continue;
    eqs.push(bindingEquation(model, el.id, s, t, memo));
    bound.push([s, t]);
  }
  // A feature bound to one whose value cannot be read has that value, and so
  // none this lane reads either — never a free variable at the solve's
  // starting point (`bind w = q.len` to a copy whose `(k * 2.0) [km]` read in
  // q is refused made w 1, and `w >= 5999.0 [m]` violated).
  for (let grew = true; grew; ) {
    grew = false;
    for (const [a, b] of bound) {
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        if (!unreadable.has(from) || unreadable.has(to)) continue;
        const f = model.get(to);
        if (f && hasStatedValue(model, f)) continue;
        unreadable.add(to);
        grew = true;
      }
    }
  }

  // (4) What every instance read through a variable of its own holds — FIRST:
  // each is a fact of the model (a value, an assert, a binding of the
  // instance's types or of an instance enclosing it), and the propagation
  // sweep orients in this order, so a plain check never fixes an instance
  // variable a fact determines (`constraint { p.sub.x == 1.0 }` beside P's
  // `assert constraint { sub.x == 10.0 }` made p.sub.x 1).
  const instances = instanceSystem(model, scopeId);
  for (const id of instances.unreadable) unreadable.add(id);
  for (const [v, by] of instances.held) for (const id of by) holdVar(held, v, id);
  const all = [...instances.eqs, ...eqs];
  // An instance's variable of a feature an assert typed by an equation's
  // definition may define is no freedom either, however the instances reached
  // it — and nor is what the model states from one: what a value, a binding
  // or an asserted equation that reads one states or defines. CD10's `q.L`,
  // which Q's `bind p.load = L` joins to q's p's load, was oriented from that
  // load where the solve had left it at its starting guess, and `q.p.load ==
  // 50.0` refuted at 1; so was q's p's `:>> load = L` over the package's typed
  // assert on `q.L`, read as Q's one L.
  if (typedAssertsName(model)) {
    const typed = new Set<ElementId>();
    const mark = (vars: readonly ElementId[]): void => {
      for (const v of vars) {
        const f = model.get(baseIdOf(v));
        if (!f || !typedAssertNames(model, f)) continue;
        unreadable.add(v);
        typed.add(v);
      }
    };
    for (const eq of all) mark(eq.vars);
    for (const iq of gatherInequalities(model, scopeId)) mark(iq.vars);
    for (let grew = typed.size > 0; grew; ) {
      grew = false;
      for (const eq of all) {
        if (!eq.vars.some((v) => typed.has(v))) continue;
        for (const v of [...(eq.states !== undefined ? [eq.states] : []), ...(eq.defines ?? [])]) {
          if (typed.has(v)) continue;
          unreadable.add(v);
          typed.add(v);
          grew = true;
        }
      }
    }
  }
  pastCapUnreadable(model, all, unreadable, scopeId);
  const cut = headBindingsCarrying(model, all, relationOf);
  return { eqs: cut.size === 0 ? all : all.filter((eq) => !cut.has(eq)), unreadable, relationOf, held };
}

/**
 * The package-head bindings read at an instance ({@link Equation.head}) whose
 * slot holds a value an asserted equation gives a feature with no value that
 * the slot's binding component joins to defaults that give way
 * ({@link givenWayThroughHead}): E1E's `L == 5.0` in W, carried by W's `bind
 * p2.load = L` into w's p2's load, and by `bind P::load = M` on into M, which
 * `default = 9.0` and p4's `default = 7.0` leave without a value, and so into
 * every P's load. No assertion gives a default a value (decision 14 amended
 * 2026-10-22): the other surfaces read none at p3's load, and the numeric
 * solve read 5 there (`p3.load <= 6.0` T, `>= 6.0` F). The value stays where
 * the model's own equations put it (L, w's p2's load); it is carried no
 * further than the slot, and what the head joins stays without one.
 */
function headBindingsCarrying(model: Model, eqs: readonly Equation[], relationOf: ReadonlyMap<Equation, ElementRecord>): Set<Equation> {
  const out = new Set<Equation>();
  if (!eqs.some((eq) => eq.head === true)) return out;
  const carried = new Set<ElementId>();
  for (const eq of eqs) {
    const owner = eq.asserted === true ? (relationOf.get(eq)?.ownerId ?? READER_OF.get(eq)) : undefined;
    if (owner == null) continue;
    for (const [name, id] of eq.nameToId) if (givenWayThroughHead(model, owner, name) !== undefined) carried.add(id);
  }
  if (carried.size === 0) return out;
  // What the model's own equations tie to one: never a head, nor a check.
  const own = (eq: Equation): boolean => {
    const el = relationOf.get(eq);
    return eq.head !== true && !(el !== undefined && el.eClass === 'ConstraintUsage' && !isAsserted(el));
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const eq of eqs) {
      if (!own(eq) || !eq.vars.some((v) => carried.has(v))) continue;
      for (const v of eq.vars) if (!carried.has(v)) grew = !!carried.add(v);
    }
  }
  for (const eq of eqs) if (eq.head === true && eq.vars.some((v) => carried.has(v))) out.add(eq);
  return out;
}

/**
 * The variables of `eqs`, and of the inequalities in scope, a binding past a
 * cap holds ({@link pastCapEnd}) that nothing the model states determines —
 * added to `unreadable`. Such a feature has a value (its default, or the one
 * the capped binding gives where this tool does not read it), and no plain
 * check may fix it, nor the feasibility search move it: read as a design
 * freedom, CAPU4's `s.a.load == 9.0` (s a T1 beside T1's chain 33 usages
 * deep) was solved as a design equation, and `s.L <= 5.0` refuted at that 9,
 * where s's L and load are T1's default of 1; and `r2.L >= 5.0` over R's L
 * (R's nested Q used outside any R), which only that inequality reads, was
 * met by moving r2's L and decided feasible, where it is R's default of 1.
 * One the definitions alone determine over the stated values ({@link
 * closedByDefinitions}) stays solved: CAP1's Y, bound to the load T1's
 * binding gives X's 50 there.
 */
function pastCapUnreadable(model: Model, eqs: readonly Equation[], unreadable: Set<ElementId>, scopeId?: ElementId): void {
  if (!hasPastCapBindings(model)) return;
  const capped = new Set<ElementId>();
  const read = (vars: readonly ElementId[]): void => {
    for (const v of vars) if (!unreadable.has(v) && pastCapEnd(model, baseIdOf(v))) capped.add(v);
  };
  for (const eq of eqs) read(eq.vars);
  for (const iq of gatherInequalities(model, scopeId)) read(iq.vars);
  if (capped.size === 0) return;
  const stated = new Map<ElementId, number>();
  const memo: DerivationMemo = new Map();
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    const v = numericSeedOf(model, el, memo);
    if (v !== undefined) stated.set(el.id, v);
  }
  const closed = closedByDefinitions(eqs, definedFeatures(eqs, unreadable), (v) => stated.has(v), stated, unreadable, true);
  for (const v of capped) if (!stated.has(v) && !closed.has(v)) unreadable.add(v);
}

/**
 * The variables an asserted relation of `eqs` reads, valueless at `values`, of
 * a feature that writes a `default` no assertion replaces ({@link
 * writesStandingDefault}) where a binding makes that default give way — at the
 * variable's instance, or everywhere. Only the equation that DEFINES such a
 * variable (its binding's) or states its value may fix it — never the assert
 * or a check, and the feasibility search does not move it: where its binding
 * gives it no value (two defaults that differ, neither read) no relation is
 * judged over it (decision 14 amended 2026-10-22: no surface reads an
 * assertion's value into a default). Free to them, GA6's Q's L, which `bind
 * p.load = L` joins to P's `load default = 7.0`, was solved from Q's asserted
 * `L == 5.0`, and that assert read satisfied on the numeric surface alone. One
 * no assert reads is left as it was: a design freedom where nothing fixes it.
 */
function givenWayDefaults(model: Model, eqs: readonly Equation[], values: ReadonlyMap<ElementId, number>): Set<ElementId> {
  const out = new Set<ElementId>();
  for (const eq of eqs) {
    if (eq.asserted !== true) continue;
    for (const v of eq.vars) {
      if (values.has(v) || out.has(v)) continue;
      const f = model.get(baseIdOf(v));
      if (!f || !writesStandingDefault(model, f)) continue;
      // The default it reads through what it redefines too, as the frame walk asks ({@link buildInstanceSystem}):
      // U6's `impl-…@U6::q::pp::m`, the end copy `bind pp.m = k` makes of P's `m default = 1.0`, gives way only
      // through P's m, and free to the solve, Q's asserted `pp.m == 0.8` fixed it, and the binding carried 0.8 into
      // Q's `k default = 2.0` (`q.pp.m <= 1.5` satisfied where no value is read).
      const at = v.indexOf('@');
      const inst = at < 0 ? undefined : v.slice(at + 1);
      if ([f, ...redefinedClosure(model, f)].some((g) => (inst === undefined ? defaultGivesWaySomewhere(model, g) : defaultGivesWayIn(model, g, inst)))) {
        out.add(v);
      }
    }
  }
  return out;
}

/** A predicate selecting elements at/under `scopeId` (or everything when none). */
function scopeFilter(model: Model, scopeId?: ElementId): (el: ElementRecord) => boolean {
  if (!scopeId) return () => true;
  const ids = new Set<ElementId>([scopeId]);
  for (const d of model.descendants(scopeId)) ids.add(d.id);
  return (el) => ids.has(el.id) || (el.ownerId != null && ids.has(el.ownerId));
}

/**
 * Build an {@link Equation} from a ConstraintUsage / CalculationUsage body.
 *
 * `negation` reads a `!=` body as the `==` it negates, over the same operands
 * and through the same gates and scale, for {@link checkConstraintsNumeric} to
 * judge at the solved values. It is never gathered: a `!=` states no value to
 * solve for.
 */
function relationEquation(
  model: Model,
  el: ElementRecord,
  memo: DerivationMemo = new Map(),
  negation = false,
  onRefused?: () => void,
  instance?: string,
): Equation | undefined {
  const raw = el.attrs.expression;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;

  const body = parseRelationBody(raw);
  if (!body) return undefined; // malformed body — not a scalar equation
  // A `[unit]` literal nothing can convert leaves the relation unjudgeable: it
  // is dropped here (so no wrong number enters the solve) and reported
  // `unknown` by checkConstraintsNumeric rather than silently disappearing.
  if (body.hadUnit && !body.resolved) return undefined;
  const node = body.node;
  // A body that reads a name its own element declares, which the owner's scope
  // answers with another feature, is solved from by nothing (shadowedNamesOf).
  if (shadowedIn(model, el, node, body.literals)) {
    onRefused?.();
    return undefined;
  }

  const nameToId = relationScope(model, el);

  // `lhs = rhs` / `lhs == rhs`. A lone `=` is now a distinct operator (finding
  // L3); accept it here as an equation separator alongside `==`.
  if (node.kind === 'binary' && (node.op === '==' || node.op === '=' || (negation && node.op === '!='))) {
    return makeEquation(model, node.left, node.right, raw, nameToId, body, memo, false, el, true, onRefused, instance);
  }

  // Any other boolean comparison (<, <=, …) is an inequality, not an equation.
  if (node.kind === 'binary' && isComparison(node.op)) return undefined;

  // A CalculationUsage whose body is a bare value expression: `self = expr` —
  // a value like a feature's, asked what it reads as a feature value is. Not
  // one with a parameter, owned or from the `calc def` that types it: its
  // body is the value of a call, and read here it took the part's `x` for the
  // `in x` (`calc t : Scale { x * 5.0 }`, 15 where it is 500), as the
  // validation surface and the SMT engine no longer do
  // ({@link isParameterisedCalculation}).
  if (el.eClass === 'CalculationUsage' && el.declaredName) {
    if (isParameterisedCalculation(model, el)) {
      onRefused?.();
      return undefined;
    }
    const lhs: ExprNode = { kind: 'ref', path: [el.declaredName] };
    nameToId.set(el.declaredName, el.id);
    const eq = makeEquation(model, lhs, node, raw, nameToId, body, memo, false, el, false, onRefused, instance);
    if (eq && hasStatedValue(model, el)) eq.states = el.id;
    return eq;
  }

  return undefined;
}

/** Does a body read a name its own element declares, which its owner's scope answers with another feature? */
function shadowedIn(model: Model, el: ElementRecord, node: ExprNode, markers: MarkerDimensions): boolean {
  return shadowedNamesOf(model, el, namesReadIn(node).filter((n) => !markers.has(n))).length > 0;
}

/**
 * Build a `feature = expr` {@link Equation} from a feature's value expression.
 *
 * A value that is a BARE REFERENCE (`attribute t3 : TemperatureValue = t1`) is
 * an identity of two physical values, exactly as a `bind` is, so it converts
 * across an affine map rather than being refused: `t3` holds 293.15 K for a
 * `t1` of 20 °C. Anything ARITHMETIC (`t1 + 5.0`) stays a refusal — the scale's
 * origin does not cancel there, which is the `L4-temperature-difference` gap.
 */
function assignmentEquation(
  model: Model,
  el: ElementRecord,
  memo: DerivationMemo = new Map(),
  onRefused?: () => void,
): Equation | undefined {
  const raw = el.attrs.value;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (s === '') return undefined;
  // Quoted string literal — not a numeric expression. It is a value the model
  // STATES, though, and no design freedom: left a plain unknown, the solver
  // solved `a = "abc"` from `e == a * 2.0` (4.5 beside a check `e == 9.0`, or
  // whatever a least-squares step picked once the check no longer stood in for
  // the definition). Nothing reads it, so nothing is solved from it.
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    onRefused?.();
    return undefined;
  }

  // `= 2 * 3 [kg]` is an assignment whose VALUE carries a unit literal; without
  // lowering it the target would be an unknown for ever (parseExpr rejects `[`).
  const parsed = parseRelationBody(s);
  if (!parsed) return undefined;
  // `= (k * 2.0) [GiB]` is `k * 2.0` IN GiB, as the unit-aware evaluator reads
  // it ({@link withValueUnit}) — and a value whose unit that evaluator does not
  // put on a number, at the model's point or on any other path
  // ({@link valueUnitRefusal}: `= (cap * 2.0) [GiB]` relabels bits as GiB, and
  // so does `= (cap * k) [GiB]` for every `k`), is one nothing reads, here as
  // there: it is not solved from, nor seeded ({@link numericSeedOf}).
  const valueUnit = expressionValueUnitOf(el);
  if (valueUnit !== undefined && valueUnitRefusal(model, el.id, memo) !== undefined) {
    onRefused?.();
    return undefined;
  }
  const body = valueUnit !== undefined ? withValueUnit(parsed, valueUnit) : parsed;
  if (body.hadUnit && !body.resolved) return undefined;
  const node = body.node;
  // A self-contained literal (a bare number/boolean) is a seed, not an equation.
  const asLiteral = evaluate(substituteLiterals(node, body.literals), () => undefined);
  if ('value' in asLiteral) return undefined;

  const name = effectiveNameOf(model, el);
  if (!name) return undefined;
  if (shadowedIn(model, el, node, body.literals)) {
    onRefused?.();
    return undefined;
  }

  const nameToId = mergedScope(model, el.ownerId ?? undefined, el.id);
  nameToId.set(name, el.id); // the assignment target resolves to this feature
  const lhs: ExprNode = { kind: 'ref', path: [name] };
  const identity = node.kind === 'ref' && !body.hadUnit;
  const eq = makeEquation(model, lhs, node, s, nameToId, body, memo, identity, el, false, onRefused);
  if (eq) eq.states = el.id;
  return eq;
}

/**
 * Build a synthetic `a = b` equality {@link Equation} between two feature ids.
 *
 * A binding is not a predicate: it states that the two features DENOTE THE SAME
 * QUANTITY, and it publishes no verdict anywhere. So — unlike an author's `==`,
 * which {@link relationRefused} declines on an offset scale exactly as the
 * unit-aware evaluator does — a binding across an affine map is CONVERTED:
 * `bind a = measureT` with `a = 20 ['°C']` fills a kelvin-storage `measureT`
 * with 293.15, not 20. Copying the magnitude instead let the numeric surface
 * answer `measureT <= 273.15 [K]` "satisfied with 253.15 K of slack".
 */
function bindingEquation(
  model: Model,
  edgeId: ElementId,
  a: ElementId,
  b: ElementId,
  memo: DerivationMemo,
): Equation {
  const nameToId = new Map<string, ElementId>([
    ['__l', a],
    ['__r', b],
  ]);
  const lhs: ExprNode = { kind: 'ref', path: ['__l'] };
  const rhs: ExprNode = { kind: 'ref', path: ['__r'] };
  const vars = a === b ? [a] : [a, b];
  const eq: Equation = {
    vars,
    lhs,
    rhs,
    expr: { kind: 'binary', op: '-', left: lhs, right: rhs },
    raw: `${a} = ${b} (${edgeId})`,
    nameToId,
  };
  const scale = scaleOfRelation(model, vars, [eq.expr], nameToId, false, NO_MARKERS, memo);
  if (scale) eq.scale = scale;
  const defines = boundEnds(model, vars);
  if (defines.length > 0) eq.defines = defines;
  return eq;
}

/**
 * The ends a binding DEFINES: those that state no value of their own. A
 * binding is a fact of the model as an asserted equation is, never a check:
 * where it determines an end ({@link closedByDefinitions} — the other end
 * stated, defined, or held), no plain constraint may fix that end instead.
 * Left without one, `constraint { w == 18.0 }` was oriented ahead of `bind w
 * = m2` (bindings are gathered last), w was 18 beside an m2 of 9, the binding
 * broken at the solved point, and the check reported "satisfied — imposed by
 * the solve: no value the model states fixes w" where every other surface
 * read it violated. Both ends valueless and nothing else fixing either, the
 * binding determines neither, and a check fixes the freedom as before.
 */
function boundEnds(model: Model, vars: readonly ElementId[]): ElementId[] {
  return vars.filter((v) => {
    const f = model.get(baseIdOf(v));
    return f !== undefined && !hasStatedValue(model, f);
  });
}

/**
 * The instance variables an asserted equation `eq` pins by a side that is a
 * bare reference read through an instance of its own (`s.p.load` in `assert
 * constraint { s.p.load == 5.0 }`), whose feature states no value: it DEFINES
 * them, as an asserted equation over bare names defines the feature it names
 * ({@link definitionsOf}). Without them, `constraint { s.q.load == 1.0 }` was
 * oriented to fix `s.q.load` before `bind p.load = q.load` read the asserted
 * 5 across, and `s.q.load >= 4.0` was violated where the SMT engine proves it.
 */
function instanceKeysDefinedBy(model: Model, node: ExprNode, eq: Equation): ElementId[] {
  if (node.kind !== 'binary' || (node.op !== '==' && node.op !== '=')) return [];
  const out: ElementId[] = [];
  for (const side of [node.left, node.right]) {
    if (side.kind !== 'ref') continue;
    const key = eq.nameToId.get(side.path.join('.'));
    if (key === undefined || !key.includes('@') || out.includes(key)) continue;
    const f = model.get(baseIdOf(key));
    // Never one that writes a `default`, even one a binding made give way (decision 14 amended).
    if (f !== undefined && !hasStatedValue(model, f) && !writesStandingDefault(model, f)) out.push(key);
  }
  return out;
}

/**
 * Assemble an {@link Equation} record, extracting its variable ids.
 *
 * `readBy` is the element an author's relation body, a feature's value or a
 * calculation's value body belongs to: such an equation is also asked what
 * the validation surface refuses in what it READS ({@link readRefusalOf}) — a
 * bare number against a derived dimension, a point on an offset scale in
 * arithmetic, and, for a relation body (`operands`), an operand whose
 * derivation is refused — and whether it reads a name that surface reads no
 * value for here ({@link unreadValuesOf}); it is never solved from when it
 * would be refused. A binding is asked none of it. `onRefused` hears of a
 * refusal of any gate, for {@link gatherSystem}.
 */
function makeEquation(
  model: Model,
  lhs: ExprNode,
  rhs: ExprNode,
  raw: string,
  nameToId: Map<string, ElementId>,
  body: LoweredBody | undefined,
  memo: DerivationMemo,
  identity = false,
  readBy?: ElementRecord,
  operands = false,
  onRefused?: () => void,
  instance?: string,
): Equation | undefined {
  const markers: MarkerDimensions = body ? body.literals : NO_MARKERS;
  // The gates are judged on the node WITH its markers, so a lowered `[unit]`
  // literal still counts as dimensioned; the markers are only then folded into
  // the SI numbers the equation is evaluated with. The node handed to the gate
  // is the JOINING equality, not the two sides separately: `==` is itself in
  // the gate-(c) set, and an equality is precisely where a plain `Real` meets a
  // dimensioned value (`constraint { n == km }` must leave `n` at 5, not 5000).
  const joined: ExprNode = { kind: 'binary', op: '==', left: lhs, right: rhs };
  // The gates read the ids the body REFERENCES, never the whole scope — see
  // {@link relationVarsOf}, which both surfaces share for exactly that reason.
  const varIds = relationVarsOf(joined, nameToId);
  // Not a numeric equation at all — see {@link relationRefused}.
  if (relationRefused(model, joined, varIds, nameToId, markers, memo, identity)) {
    onRefused?.();
    return undefined;
  }
  // Refused for what it reads, as the validation surface refuses it — or
  // reading a name that surface reads no value for here: never solved from.
  if (readBy && readsRefused(model, readBy, joined, nameToId, markers, memo, operands, identity)) {
    onRefused?.();
    return undefined;
  }
  const scale = scaleOfRelation(model, varIds, [joined], nameToId, body?.hadUnit ?? false, markers, memo);
  // A body whose literals are already in SI cannot be judged in raw magnitudes.
  if (body?.hadUnit && !scale) {
    onRefused?.();
    return undefined;
  }
  const left = body ? substituteLiterals(lhs, body.literals) : lhs;
  const right = body ? substituteLiterals(rhs, body.literals) : rhs;
  // The gates read the features; the values are the instances' own.
  const keyed = readBy ? keyedNames(model, readBy, joined, nameToId, instance) : undefined;
  const names = keyed?.nameToId ?? nameToId;
  const eq: Equation = {
    vars: keyed ? relationVarsOf(joined, names) : varIds,
    lhs: left,
    rhs: right,
    expr: { kind: 'binary', op: '-', left, right },
    raw,
    nameToId: names,
  };
  const scaled = keyed ? rekeyed(scale, nameToId, names) : scale;
  if (scaled) eq.scale = scaled;
  if (keyed && keyed.instances.length > 0) INSTANCES.set(eq, keyed.instances);
  return eq;
}

/**
 * A path a relation reads through an instance of its own
 * (`DefiningEquations.instanceReadings`), and the variable the solver reads it
 * as: `<feature id>@<the instance's symbol>` — one per instance, apart from
 * the feature's own (its element id), so `p1.m2` and `p2.m2` are two values,
 * and p's `m2` is p's.
 */
interface InstanceVariable {
  key: ElementId;
  reading: InstanceReading;
}

/** The instance variables an equation or inequality reads, for {@link instanceSystem}. */
const INSTANCES = new WeakMap<Equation | Inequality, InstanceVariable[]>();

/** The definition whose instance an asserted equation was copied for ({@link instanceSystem}'s `hold`): the owner {@link headBindingsCarrying} reads for a copy. */
const READER_OF = new WeakMap<Equation, ElementId>();

/**
 * `nameToId` with every path `el` reads through an instance of its own keyed
 * to that instance's variable ({@link InstanceVariable}) — `instance`
 * re-roots the reading for one of `el`'s owner's instances — and the
 * instance variables, or `undefined` when there are none.
 */
function keyedNames(
  model: Model,
  el: ElementRecord,
  node: ExprNode,
  nameToId: ReadonlyMap<string, ElementId>,
  instance?: string,
): { nameToId: Map<string, ElementId>; instances: InstanceVariable[] } | undefined {
  const paths = [...new Set(namesReadIn(node))].filter((p) => nameToId.has(p));
  const readings = sharedDefinitions(model).instanceReadings(el, paths, instance);
  if (readings.size === 0) return undefined;
  const keyed = new Map(nameToId);
  const instances: InstanceVariable[] = [];
  for (const [path, reading] of readings) {
    const id = nameToId.get(path)!;
    const key = `${id}@${reading.symbol}`;
    keyed.set(path, key);
    instances.push({ key, reading });
  }
  return { nameToId: keyed, instances };
}

/** A scale map keyed by feature, extended to the instance variables `keyed` reads them as. */
function rekeyed(
  scale: ScaleMap | undefined,
  nameToId: Map<string, ElementId>,
  keyed: Map<string, ElementId>,
): ScaleMap | undefined {
  if (!scale) return scale;
  let out: ScaleMap | undefined;
  for (const [path, key] of keyed) {
    const id = nameToId.get(path);
    const s = id !== undefined ? scale.get(id) : undefined;
    if (id === undefined || key === id || !s) continue;
    out ??= new Map(scale);
    out.set(key, s);
  }
  return out ?? scale;
}

/**
 * The `feature = expr` equation of a feature that states NO value but reads
 * one as a redefinition — an implicit connector-end copy included — in a
 * context that changes what it reads, so it is read there
 * (`DefiningEquations.redefinedValueOf`): p's copy of P's `m2 = 10.0 - load`
 * that `bind w2 = p.m2` binds, in a `p` whose `:>> load = 50.0` overrides a
 * `default`, is −40, not a value the solve is free to pick.
 */
function redefinedValueEquation(
  model: Model,
  el: ElementRecord,
  memo: DerivationMemo,
  onRefused?: () => void,
): Equation | undefined {
  if (el.ownerId == null || el.attrs.value !== undefined) return undefined;
  const definitions = sharedDefinitions(model);
  const read = definitions.redefinedValueOf(el);
  const name = definitions.nameOf(el);
  if (!read || name === undefined) return undefined;
  const eq = valueEquation(model, el, read.target, model.get(el.ownerId), name, memo, onRefused);
  if (!eq) return undefined;
  // The copy declares no unit of its own: a value stored in one (`len =
  // (k * 2.0)` in km) is read into it only where the gates establish the
  // scale of both ends — never as a bare magnitude.
  const stored = read.target.attrs.unit;
  const dimension = featureDimension(model, read.target.id, memo);
  if (!eq.scale && ((typeof stored === 'string' && stored.trim() !== '') || (dimension && !dimEqual(dimension, DIMENSIONLESS)))) {
    onRefused?.();
    return undefined;
  }
  eq.states = el.id;
  eq.defines = [el.id];
  return eq;
}

/**
 * `feature = <source's value>`, read in `context` — the value of `feature`
 * where `source` states it, read over the context's names; `instance`
 * re-roots it for one of the context's instances. `undefined` where `source`
 * states nothing an equation reads (a literal is a seed, a string no number).
 */
function valueEquation(
  model: Model,
  feature: ElementRecord,
  source: ElementRecord,
  context: ElementRecord | undefined,
  name: string,
  memo: DerivationMemo,
  onRefused?: () => void,
  instance?: string,
): Equation | undefined {
  if (!context) return undefined;
  const raw = statedValueOf(model, source);
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (s === '' || /^(["']).*\1$/s.test(s)) return undefined;
  if (source.eClass === 'CalculationUsage' && isParameterisedCalculation(model, source)) {
    onRefused?.();
    return undefined;
  }
  // `(k * 2.0) [GiB]` is `k * 2.0` IN GiB, and a value whose unit the
  // unit-aware evaluator does not put on a number is read by nothing — read
  // here as {@link assignmentEquation} reads it where it is written, and
  // asked in `context`, where the value is read: P's `k` is a number, and a
  // `p` whose `:>> k = 1.0 [GiB]` overrides its `default` puts GiB on bits.
  const valueUnit = expressionValueUnitOf(source);
  if (valueUnit !== undefined && valueUnitRefusal(model, source.id, memo, undefined, context.id) !== undefined) {
    onRefused?.();
    return undefined;
  }
  // A value this lane cannot read is no value to start from: the feature is
  // unreadable, never a free variable at the solve's starting point.
  const parsed = parseRelationBody(s);
  const body = parsed && valueUnit !== undefined ? withValueUnit(parsed, valueUnit) : parsed;
  if (!body || (body.hadUnit && !body.resolved)) {
    onRefused?.();
    return undefined;
  }
  const readBy: ElementRecord = { ...source, id: feature.id, ownerId: context.id };
  if (shadowedIn(model, readBy, body.node, body.literals)) {
    onRefused?.();
    return undefined;
  }
  const nameToId = mergedScope(model, context.id, feature.id);
  nameToId.set(name, feature.id);
  const identity = body.node.kind === 'ref' && !body.hadUnit;
  const lhs: ExprNode = { kind: 'ref', path: [name] };
  return makeEquation(model, lhs, body.node, s, nameToId, body, memo, identity, readBy, false, onRefused, instance);
}

/**
 * The instance variable `feature@instance` of a `default` a binding holds per
 * FEATURE but which this one instance reads as its value (F8, A.4 Part 2):
 * the literal equation `feature@instance = <value>`, beside
 * {@link valueEquation}. `defaultStandsIn` names the standing default's
 * feature; a value carrying a unit is left out (the instance variable would
 * need the gates' scale map — a gap, never a false verdict).
 */
function instanceStandingDefaultEquation(
  model: Model,
  feature: ElementRecord,
  reading: InstanceReading,
  name: string,
): Equation | undefined {
  const source = defaultStandsIn(model, reading.symbol);
  if (!source) return undefined;
  const raw = source.attrs.value;
  if (typeof raw !== 'number') return undefined;
  if (expressionValueUnitOf(source) !== undefined) return undefined;
  const key = `${feature.id}@${reading.symbol}`;
  const lhs: ExprNode = { kind: 'ref', path: [name] };
  const rhs: ExprNode = { kind: 'num', value: raw };
  const eq: Equation = {
    vars: [key],
    lhs,
    rhs,
    expr: { kind: 'binary', op: '-', left: lhs, right: rhs },
    raw: `${name} = ${String(raw)} (${reading.symbol})`,
    nameToId: new Map<string, ElementId>([[name, key]]),
  };
  eq.states = key;
  eq.defines = [key];
  return eq;
}

const INSTANCE_SYSTEMS = new WeakMap<Model, Map<string, { rev: number; system: InstanceSystem }>>();

/** The relations of the instances read through variables of their own ({@link instanceSystem}). */
interface InstanceSystem {
  eqs: Equation[];
  ineqs: Inequality[];
  /** Instance variables whose relations were not read (past {@link MAX_INSTANCE_RELATIONS}): nothing is solved for them. */
  unreadable: Set<ElementId>;
  /**
   * Instance variables an assert of the instance's types reads in a form the
   * solve gathers no equation from, each with those asserts ({@link GatheredSystem.held}).
   */
  held: Map<ElementId, ElementId[]>;
}

/**
 * The relations every INSTANCE a relation reads through a variable of its own
 * ({@link InstanceVariable}) holds, as equations and inequalities over its
 * variables: the value each such feature has there (`m2@R::p1::m2 = 10.0 -
 * load@R::p1::load`), and every assert and binding its reader's types hold,
 * and the types of every instance enclosing it — and so on for what those
 * read. KerML gives every instance its own values,
 * and a relation of P holds of each: read over one variable per feature, two
 * instances were one and a value read where it is not was P's. Once per
 * model revision and scope.
 */
function instanceSystem(model: Model, scopeId?: ElementId): InstanceSystem {
  let byScope = INSTANCE_SYSTEMS.get(model);
  if (!byScope) {
    byScope = new Map();
    INSTANCE_SYSTEMS.set(model, byScope);
  }
  const hit = byScope.get(scopeId ?? '');
  if (hit && hit.rev === model.rev) return hit.system;
  const system = buildInstanceSystem(model, scopeId);
  byScope.set(scopeId ?? '', { rev: model.rev, system });
  return system;
}

function buildInstanceSystem(model: Model, scopeId?: ElementId): InstanceSystem {
  const inScope = scopeFilter(model, scopeId);
  const definitions = sharedDefinitions(model);
  const memo: DerivationMemo = new Map();
  const system: InstanceSystem = { eqs: [], ineqs: [], unreadable: new Set(), held: new Map() };
  const pending: InstanceVariable[] = [];
  const seen = new Set<string>();
  const seed = (el: ElementRecord, text: string, skipHeld = false): void => {
    const body = parseRelationBody(text);
    if (!body) return;
    const paths = [...new Set(namesReadIn(body.node))].filter((n) => !body.literals.has(n));
    for (const [, reading] of definitions.instanceReadings(el, paths)) {
      // A `default` that gives way at THIS instance — a held redefinition of it
      // falls through here (`held-redef`) — seeds no literal there.
      if (skipHeld && defaultGivesWayIn(model, reading.feature, reading.symbol)) continue;
      pending.push({ key: `${reading.feature.id}@${reading.symbol}`, reading });
    }
  };
  // The paths the model's own relations and values read through instances.
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || !inScope(el)) continue;
    if (RELATION_KINDS.has(el.eClass)) {
      if (isNonNormativeStatement(model, el.id)) continue;
      const raw = el.attrs.expression;
      if (typeof raw === 'string' && raw.trim() !== '') seed(el, raw);
      continue;
    }
    if (!isUsage(el.eClass)) continue;
    const raw = el.attrs.value;
    if (typeof raw === 'string' && raw.trim() !== '') {
      if (!defaultGivesWaySomewhere(model, el)) seed(el, raw, true);
      continue;
    }
    const read = definitions.redefinedValueOf(el);
    const text = read ? statedValueOf(model, read.target) : undefined;
    if (read && typeof text === 'string' && el.ownerId != null) seed({ ...read.target, id: el.id, ownerId: el.ownerId }, text);
  }
  if (pending.length === 0) return system;
  let budget = MAX_INSTANCE_RELATIONS;
  const enqueue = (rel: Equation | Inequality | undefined): void => {
    if (!rel) return;
    budget--;
    for (const v of INSTANCES.get(rel) ?? []) pending.push(v);
  };
  // Every assert and binding of `readerId`'s types, read for the instance `instance`.
  const hold = (instance: string, readerId: ElementId): void => {
    const held = `${readerId} ${instance}`;
    if (seen.has(held)) return;
    seen.add(held);
    const reader = model.get(readerId);
    if (!reader) return;
    for (const holder of [reader, ...generalizationsOf(model, reader.id).filter((g) => g.attrs.isLibrary !== true)]) {
      // The holder's own instance reads its relations as its own rows do.
      if (instance === definitions.instanceNameOf(holder.id)) continue;
      for (const c of model.children(holder.id)) {
        if (c.attrs.isLibrary === true) continue;
        if (isAsserted(c) && typeof c.attrs.expression === 'string' && c.attrs.expression.trim() !== '') {
          const read: ElementRecord = { ...c, ownerId: reader.id };
          const eq = relationEquation(model, read, memo, false, undefined, instance);
          if (eq) {
            eq.asserted = true;
            READER_OF.set(eq, reader.id);
            // An asserted equation defines, in the instance, the valueless
            // features it names: the instance's own, never a check's to fix.
            const body = parseRelationBody(String(c.attrs.expression));
            const defines = body ? instanceKeysDefinedBy(model, body.node, eq) : [];
            if (defines.length > 0) eq.defines = defines;
            system.eqs.push(eq);
            enqueue(eq);
          }
          const iq = eq ? undefined : relationInequality(model, read, memo, instance);
          if (iq) {
            iq.id = `${c.id}@${instance}`;
            system.ineqs.push(iq);
            enqueue(iq);
          }
          // One the solve reads no equation from — an inequality, a conjunction —
          // constrains the instance's variables all the same.
          if (!eq) for (const v of iq?.vars ?? relationReads(model, read, instance)) holdVar(system.held, v, c.id);
        } else if (isBindingEdge(c)) {
          enqueue(instanceBindingEquation(model, c, holder, reader, instance, memo, system));
        }
      }
      // A package's binding on the holder's features holds in each of its instances too (w4).
      for (const { binding, ends } of outsideBindingsOf(model, holder.id)) {
        enqueue(instanceBindingEquation(model, binding, holder, reader, instance, memo, system, ends));
      }
    }
  };
  while (pending.length > 0 && budget > 0) {
    const { key, reading } = pending.shift()!;
    const reader = model.get(reading.reader);
    const feature = model.get(baseIdOf(key));
    if (!reader || !feature) continue;
    if (!seen.has(key)) {
      seen.add(key);
      const name = definitions.nameOf(feature);
      const d = name !== undefined ? definitions.denote(reader.id).get(name) : undefined;
      const source = (d ? definitions.valueRef(d)?.target : undefined) ?? (hasStatedValue(model, feature) ? feature : undefined);
      // What an assert typed by an equation's definition may define, here too:
      // no freedom, solved from nothing ({@link typedAssertNames}).
      if (typedAssertHolding(model, source ?? feature) !== undefined) system.unreadable.add(key);
      // A `default` that gives way at THIS instance (`held-redef`): no value
      // equation fixes it — the binding that holds it does.
      if (source && name !== undefined && !defaultGivesWayIn(model, feature, reading.symbol)) {
        const eq = valueEquation(model, feature, source, reader, name, memo, () => system.unreadable.add(key), reading.instance);
        if (eq) {
          // The instance's value is what the model states of it — its
          // definition, which no check written above it may orient.
          eq.states = key;
          eq.defines = [key];
          system.eqs.push(eq);
          enqueue(eq);
        }
      }
      // A `default` a binding holds per FEATURE, which this instance's own
      // component reads as its value (F8, {@link defaultStandsIn}): the
      // instance variable is the literal there.
      if (name !== undefined) {
        const stand = instanceStandingDefaultEquation(model, feature, reading, name);
        if (stand) {
          system.eqs.push(stand);
          enqueue(stand);
        }
      }
    }
    // The instances that enclose it hold what their types state of it too
    // (Sys's `bind p.load = q.load` of `s.q.load`) — the frames above a usage
    // whose own walk read it, where a binding joins a feature of an enclosing
    // instance (E3, {@link hasEnclosedBindings}), or where a `default` it
    // reads gives way at THIS instance (its own, or one an end copy reads
    // through what it redefines): no value equation fixes it, and the binding
    // that holds it may be one an enclosing instance's type writes. HL's q2's
    // `part :>> p { assert constraint a1 { extra == 2.0 * load } }` reads p's
    // load from q2's p's own walk, with no frame above it, and Q's `bind p.load
    // = L` (q2's L of 5) was never solved: load was a freedom the solve fitted
    // to the assert, and a1, violated at 5 on the check, read satisfied here.
    const frames =
      reading.enclosing.length === 0 &&
      (hasEnclosedBindings(model) ||
        [feature, ...redefinedClosure(model, feature)].some((g) => defaultGivesWayIn(model, g, reading.symbol)))
        ? (definitions.framesAbove(reading.instance) ?? [])
        : reading.enclosing;
    for (const e of frames) hold(e.instance, e.reader);
    hold(reading.instance, reader.id);
  }
  // Past the budget, an instance variable left unread is solved from nothing.
  for (const { key } of pending) system.unreadable.add(key);
  return system;
}

/**
 * A binding edge `holder` (one of `reader`'s types) owns, read for the
 * instance `instance` of `reader`: `a = b` over the two ends' instance
 * variables, converted across an affine map as {@link bindingEquation}
 * converts one. `undefined` for an edge whose ends are not below `holder`.
 * A package's binding on `holder`'s features comes with its `ends`
 * ({@link outsideBindingsOf}): an end of no definition — the package's `L` —
 * is its own variable, one instance beside the instance's. One whose end is a
 * feature of an instance enclosing `holder` is read in that instance
 * ({@link enclosedBindingFrame}): `q.p.load = L` in r, for r's q.
 */
function instanceBindingEquation(
  model: Model,
  edge: ElementRecord,
  holder: ElementRecord,
  reader: ElementRecord,
  instance: string,
  memo: DerivationMemo,
  system: InstanceSystem,
  ends?: readonly [string | undefined, string | undefined],
): Equation | undefined {
  const definitions = sharedDefinitions(model);
  const plain = ends ?? [pathBelow(model, edge.source?.[0], holder.id), pathBelow(model, edge.target?.[0], holder.id)];
  // An end of an instance enclosing the holder (R's `L` for r's q): the
  // binding is read in that instance, over its own names (E3).
  const up = ends === undefined && (plain[0] === undefined) !== (plain[1] === undefined) ? enclosedBindingFrame(model, edge, holder, instance) : undefined;
  const at = (up !== undefined ? model.get(up.reader) : undefined) ?? reader;
  const inst = up !== undefined ? up.instance : instance;
  const below = up?.ends ?? plain;
  if (below[0] === undefined && below[1] === undefined) return undefined;
  if ((below[0] === undefined || below[1] === undefined) && ends === undefined) return undefined;
  // Read, never changed: the shared scope itself, not a copy of it.
  const scope = definitions.scope(at.id, 'all');
  // Each end as the reader spells it: q's `pp.load` where `part pp :>> p` renames Q's p (H5, E8).
  const end = (k: 0 | 1): [string, ElementId | undefined] => {
    const path = below[k];
    if (path !== undefined) {
      const spelled = spelledIn(definitions, at.id, path);
      return [spelled, scope.get(spelled)];
    }
    return [`__${k === 0 ? 'l' : 'r'}`, carriedEnd(model, (k === 0 ? edge.source : edge.target)?.[0])];
  };
  const [left, a] = end(0);
  const [right, b] = end(1);
  if (a === undefined || b === undefined) return undefined;
  const nameToId = new Map<string, ElementId>([
    [left, a],
    [right, b],
  ]);
  const lhs: ExprNode = { kind: 'ref', path: left.split('.') };
  const rhs: ExprNode = { kind: 'ref', path: right.split('.') };
  const expr: ExprNode = { kind: 'binary', op: '-', left: lhs, right: rhs };
  const keyed = keyedNames(model, { ...edge, ownerId: at.id }, { kind: 'binary', op: '==', left: lhs, right: rhs }, nameToId, inst);
  const names = keyed?.nameToId ?? nameToId;
  const vars = [...new Set([names.get(left)!, names.get(right)!])];
  const eq: Equation = { vars, lhs, rhs, expr, raw: `${left} = ${right} (${edge.id} in ${inst})`, nameToId: names };
  const scale = scaleOfRelation(model, a === b ? [a] : [a, b], [expr], nameToId, false, NO_MARKERS, memo);
  const scaled = keyed ? rekeyed(scale, nameToId, names) : scale;
  if (scaled) eq.scale = scaled;
  const defines = boundEnds(model, vars);
  if (defines.length > 0) eq.defines = defines;
  if (keyed && keyed.instances.length > 0) INSTANCES.set(eq, keyed.instances);
  if (ends !== undefined) eq.head = true;
  system.eqs.push(eq);
  return eq;
}

/**
 * The feature a binding end is read as: the end itself, or — for a
 * redefinition that states nothing, the implicit copy `bind w = p.load`
 * creates of P's `load` — the feature whose value it reads
 * (`DefiningEquations.carrier`), as every other surface reads it. Bound to
 * the copy, the binding met a variable nothing solved: 1, at the solve's
 * starting point, and `w >= 2.0` was violated here while the SMT engine
 * proved it; given the copy's value instead, the copy had no unit, and P's
 * `len default = 2.0 [km]` bound `wr` to 2 m.
 */
function carriedEnd(model: Model, id: ElementId | undefined): ElementId | undefined {
  const end = id !== undefined ? model.get(id) : undefined;
  if (!end || end.ownerId == null) return id;
  return sharedDefinitions(model).carrier(end.ownerId, end).id;
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
 * Is a relation refused for what it reads ({@link readRefusalOf}), or does it
 * read a name the validation surface reads no value for in its context
 * ({@link unreadValuesOf})? Either way the solver lane takes nothing from it:
 * the value such a name has here is one nothing in the model states.
 */
function readsRefused(
  model: Model,
  el: ElementRecord,
  node: ExprNode,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
  memo: DerivationMemo,
  operands = true,
  identity = false,
): boolean {
  const unread = unreadValuesOf(model, el, namesReadIn(node).filter((n) => !markers.has(n)), memo);
  return (
    unread.length > 0 || readRefusalOf(model, el, node, nameToId, markers, memo, { operands, identity, unread }) !== undefined
  );
}

/** A comparison operator produces a boolean, not a residual. */
function isComparison(op: string): boolean {
  return op === '<' || op === '<=' || op === '>' || op === '>=' || op === '!=';
}

/** An ordering comparison (the operators that form an inequality constraint). */
function isInequalityOp(op: string): op is ComparisonOp {
  return op === '<' || op === '<=' || op === '>' || op === '>=';
}

/**
 * Collect the model's inequality constraints as {@link Inequality}s: every
 * ConstraintUsage / CalculationUsage body whose top operator is an ordering
 * comparison (`<`, `<=`, `>`, `>=`), each normalised to the residual form
 * `g(x) <= 0` (a `>`/`>=` body is stored negated as `rhs − lhs`). Equalities are
 * left to {@link gatherConstraints}. When `scopeId` is given, only relations at
 * or under that element are gathered.
 */
export function gatherInequalities(model: Model, scopeId?: ElementId): Inequality[] {
  const inScope = scopeFilter(model, scopeId);
  const out: Inequality[] = [];
  const memo: DerivationMemo = new Map();
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (!inScope(el)) continue;
    if (!RELATION_KINDS.has(el.eClass)) continue;
    // Same exemption as {@link gatherConstraints}: a tagged relation
    // constrains nothing, so it cannot make the model infeasible.
    if (isNonNormativeStatement(model, el.id)) continue;
    const ineq = relationInequality(model, el, memo);
    if (ineq) out.push(ineq);
  }
  // What every instance read through a variable of its own holds.
  out.push(...instanceSystem(model, scopeId).ineqs);
  return out;
}

/** Build an {@link Inequality} from a ConstraintUsage / CalculationUsage body. */
function relationInequality(
  model: Model,
  el: ElementRecord,
  memo: DerivationMemo = new Map(),
  instance?: string,
): Inequality | undefined {
  const raw = el.attrs.expression;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;

  const body = parseRelationBody(raw);
  if (!body) return undefined;
  if (body.hadUnit && !body.resolved) return undefined;
  const node = body.node;
  if (node.kind !== 'binary' || !isInequalityOp(node.op)) return undefined;
  if (shadowedIn(model, el, node, body.literals)) return undefined;

  const nameToId = relationScope(model, el);
  const op = node.op;
  // Normalise to g <= 0: `a < b`/`a <= b` ⇒ g = a − b; `a > b`/`a >= b` ⇒ g = b − a.
  const forward = op === '<' || op === '<=';
  const g: ExprNode = {
    kind: 'binary',
    op: '-',
    left: forward ? node.left : node.right,
    right: forward ? node.right : node.left,
  };

  const varIds = relationVarsOf(node, nameToId);
  const markers: MarkerDimensions = body.literals;
  // Not a numeric inequality at all — see {@link relationRefused} — nor one
  // the validation surface refuses for what it reads ({@link readRefusalOf}).
  if (relationRefused(model, node, varIds, nameToId, markers, memo)) return undefined;
  if (readsRefused(model, el, node, nameToId, markers, memo)) return undefined;
  const scale = scaleOfRelation(model, varIds, [node], nameToId, body.hadUnit, markers, memo);
  if (body.hadUnit && !scale) return undefined;

  // The gates read the features; the values are the instances' own.
  const keyed = keyedNames(model, el, node, nameToId, instance);
  const names = keyed?.nameToId ?? nameToId;
  const ineq: Inequality = {
    vars: keyed ? relationVarsOf(node, names) : varIds,
    expr: substituteLiterals(g, body.literals),
    op,
    id: el.id,
    name: el.declaredName ?? '',
    raw,
    nameToId: names,
  };
  const scaled = keyed ? rekeyed(scale, nameToId, names) : scale;
  if (scaled) ineq.scale = scaled;
  if (keyed && keyed.instances.length > 0) INSTANCES.set(ineq, keyed.instances);
  return ineq;
}

/** Evaluate an inequality's residual `g` under `values` (undefined if unknown). */
function inequalityResidual(ineq: Inequality, values: Map<ElementId, number>): number | undefined {
  const scope = namesScope(ineq.nameToId, values, ineq.scale);
  const r = evaluate(ineq.expr, scope);
  if ('unknown' in r || typeof r.value !== 'number' || !Number.isFinite(r.value)) return undefined;
  return r.value;
}

/**
 * A name → value resolver reading `values` through a `nameToId` map, applying
 * the relation's SI scaling on the way out when it has one. Values are STORED
 * in their feature's own unit and only converted here, at the point of use, so
 * `SolveResult.values`, `SolveOptions.fixed` and `OptimizeOptions.bounds` keep
 * their published meaning (plain numbers in declared units).
 */
function namesScope(
  nameToId: ReadonlyMap<string, ElementId>,
  values: Map<ElementId, number>,
  scale?: ScaleMap,
): (name: string) => unknown {
  return (name: string) => {
    const id = nameToId.get(name);
    if (id === undefined || !values.has(id)) return undefined;
    const v = values.get(id) as number;
    const s = scale?.get(id);
    return s ? v * s.factor + s.offset : v;
  };
}

/* ─────────────────────────────── solve ───────────────────────────────── */

/** {@link solveCore} with nothing held fixed, once per model revision, scope and tolerances. */
const SOLVED = new WeakMap<Model, Map<string, { rev: number; core: SolveCore }>>();

/**
 * Solve the model's numeric constraint system.
 *
 * Seeds every feature carrying a literal numeric `attrs.value`, then iterates
 * constraint propagation — orienting each equation to solve for its single
 * remaining unknown, plus binding-connector value propagation
 * ({@link propagateValues}) — to a fixpoint. Any coupled/implicit residuals left
 * over are driven under `opts.tol` with a bounded finite-difference Newton
 * (least-squares) step. Deterministic.
 *
 * A feature the equations leave FREE ({@link SolveResult.free}) is not in
 * {@link SolveResult.values}: the point the solve stopped at along a design
 * freedom is a choice, not an answer, and nothing is judged at it.
 */
export function solve(model: Model, opts: SolveOptions = {}): SolveResult {
  const core = solveCore(model, opts);
  return {
    values: determinedValues(core),
    converged: core.converged,
    iterations: core.iterations,
    residual: core.residual,
    free: [...core.free],
  };
}

/** {@link solve} before the values the equations leave free are withheld. */
interface SolveCore {
  /** Every value the solve wrote, the ones along a design freedom included. */
  point: Map<ElementId, number>;
  /** The solved features the equations do not determine ({@link freeFeatures}). */
  free: Set<ElementId>;
  /**
   * The values the solve produced at a point that is NO solution: the
   * features linked, by the solve's own equations, to one of those equations
   * that the point misses ({@link unsettledFeatures}). Neither determined nor
   * free — the rank read there says nothing — so none is published and
   * nothing is judged at it.
   */
  unsettled: Set<ElementId>;
  /**
   * The features the solve took as GIVEN: what the model states or the caller
   * fixes, what a binding carries from either, what nothing here can read, and
   * what definitions — and stated value expressions — alone determine over
   * those. Every other value is one the solve produced.
   */
  given: Set<ElementId>;
  /** The constraint and calculation usages whose bodies are among the equations. */
  relations: Set<ElementId>;
  /**
   * The PLAIN constraints (no `assert`) the solve took as design equations: it
   * oriented one to fix a value, or drove one in a Newton step — and a plain
   * equation that holds only because one it took fixed what it reads
   * ({@link designReadings}). Each holds because the solve made it hold.
   */
  imposed: Set<ElementId>;
  /**
   * The features with no value that an assert constrains in a form the solve
   * reads no equation from, each with those asserts ({@link
   * heldByUnreadAsserts}): no design freedom for a check. Those the model's
   * own equations leave without a value ({@link SolveCore.point}) are never
   * solved for; a check over any of them is no equation of the solve's own.
   */
  held: Map<ElementId, ElementId[]>;
  /**
   * The values the solve produced from plain constraints that disagree, each
   * with those constraints ({@link designReadings}): which one holds there
   * turns on which the solve took first, so none is published and nothing is
   * judged at it.
   */
  contested: Map<ElementId, ElementId[]>;
  /**
   * Those of {@link SolveCore.contested} over which the equations have more than one root (a curved one, {@link
   * isCurved}, or a coupled product, {@link isJointlyCurved}) beside a plain constraint, which the solve withholds whether
   * the constraints disagree at the root it took or not: the root is no value the model states. `plain`: the curved
   * equation is itself a plain constraint, and so are the others it is beside ({@link SolveCore.contested} lists
   * them); `model`: one of the equations is the model's own (a stated value, an assert).
   */
  rival: Map<ElementId, 'plain' | 'model'>;
  /**
   * The values of a component with an equation of more than one root, each with the descriptions of those equations
   * (rival ones too): the root the solve took is what a lone curved plain constraint is imposed at, and a relation the
   * solve gathers no equation from (an inequality, a conjunction) is not judged at it.
   */
  curved: Map<ElementId, string[]>;
  converged: boolean;
  iterations: number;
  residual: number;
}

/**
 * A solve's {@link SolveCore.point} without the values along a design freedom,
 * nor those it stopped at without converging ({@link SolveCore.unsettled}), nor
 * those plain constraints that disagree gave it ({@link SolveCore.contested}).
 */
function determinedValues(core: SolveCore): Map<ElementId, number> {
  const out = new Map<ElementId, number>();
  for (const [id, v] of core.point) {
    if (!core.free.has(id) && !core.unsettled.has(id) && !core.contested.has(id)) out.set(id, v);
  }
  return out;
}

/** The values the plain solve — nothing fixed — gives the model under `opts`: its own point. */
function plainPoint(model: Model, opts: SolveOptions): Map<ElementId, number> {
  const { fixed: _fixed, ...plain } = opts;
  return determinedValues(solveCore(model, plain));
}

function solveCore(model: Model, opts: SolveOptions = {}): SolveCore {
  // Every surface asks the same solve of an unchanged model — the numeric
  // checks, the analysis report, feasibility — so it is solved once. Each
  // caller gets a point of its own; the sets are read, never written.
  if (opts.fixed !== undefined) return solveUncached(model, opts);
  let byKey = SOLVED.get(model);
  if (!byKey) {
    byKey = new Map();
    SOLVED.set(model, byKey);
  }
  const key = `${opts.scopeId ?? ''} ${opts.tol ?? ''} ${opts.maxIter ?? ''}`;
  let hit = byKey.get(key);
  if (!hit || hit.rev !== model.rev) {
    hit = { rev: model.rev, core: solveUncached(model, opts) };
    byKey.set(key, hit);
  }
  return { ...hit.core, point: new Map(hit.core.point) };
}

function solveUncached(model: Model, opts: SolveOptions): SolveCore {
  const tol = opts.tol ?? 1e-9;
  const maxIter = Math.max(1, opts.maxIter ?? 200);

  const values = new Map<ElementId, number>();
  const fixedIds = new Set<ElementId>();

  // Fixed overrides (held constant).
  if (opts.fixed) {
    const entries = opts.fixed instanceof Map ? opts.fixed.entries() : Object.entries(opts.fixed);
    for (const [id, v] of entries) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        values.set(id, v);
        fixedIds.add(id);
      }
    }
  }

  // Seed literal numeric feature values — over one derivation pass.
  const seeds: DerivationMemo = new Map();
  for (const el of model.all()) {
    if (values.has(el.id) || el.attrs.isLibrary === true) continue;
    const v = numericSeedOf(model, el, seeds);
    if (v !== undefined) values.set(el.id, v);
  }
  // What the model states, or the caller fixes, and below what a binding
  // carries from it: never a design freedom. ONLY these — a value the solve
  // reached by orienting an equation is not known for being reached: oriented
  // from a value along a freedom (`cost == mass * 3.0` over a free loop), it
  // moves with that value, and taken as known it was published and judged.
  const known = new Set<ElementId>(values.keys());

  const { eqs, unreadable, relationOf, held: readByAsserts } = gatherSystem(model, opts.scopeId);
  const defined = definedFeatures(eqs, unreadable);
  // A `default` a binding made give way is fixed by that binding alone, or
  // stays free: never solved from an assert or a check ({@link givenWayDefaults}).
  const givenWay = givenWayDefaults(model, eqs, values);
  // The definitions that BIND — those that alone determine what they define
  // ({@link closedByDefinitions}), over the values the model states: no check
  // orients what they define, nor a feature whose stated value expression
  // they determine. One that leaves a design freedom binds nothing, and a
  // check fixes the freedom by propagation, as it always did.
  const closed = closedByDefinitions(eqs, defined, (v) => values.has(v), values, unreadable, true);
  // A PLAIN constraint (no `assert`; a `require` or an `assume` among them) is
  // a check, never a fact of the model's: what it may fix is a design freedom.
  const isCheck = (eq: Equation): boolean => {
    const el = relationOf.get(eq);
    return el !== undefined && el.eClass === 'ConstraintUsage' && !isAsserted(el);
  };
  // A feature with no value that an assert constrains in a form the solve does
  // not read is no design freedom for a check either ({@link heldByUnreadAsserts}).
  const held = heldByUnreadAsserts(eqs, readByAsserts, isCheck, (v) => values.has(v) || closed.has(v) || unreadable.has(v));
  const binding = new Set<ElementId>([...unreadable, ...closed, ...givenWay, ...held.keys()]);
  // The model's own equations orient first, each sweep to their fixpoint, and a
  // check only what they leave: oriented in TEXT order beside them, the
  // requirement `s.d == 3.0E15` written above P's `d = a * b` was taken as a
  // design equation for d ("imposed by the solve") and below it judged
  // satisfied — a verdict that turned on where the requirement was written.
  const facts = eqs.filter((eq) => !isCheck(eq));
  const checks = eqs.filter(isCheck);
  // The equations the solve may drive and read a freedom off: never a check
  // over what an assert holds in a form it does not read.
  const own = held.size === 0 ? eqs : eqs.filter((eq) => !isCheck(eq) || !eq.vars.some((v) => held.has(v)));
  // Numeric binding-propagated values (seed additional equalities) — never a
  // value that contradicts a binding it overrides, which nothing here reads.
  const propagated = numericPropagation(model);
  const definitions = sharedDefinitions(model);
  for (const id of propagated.keys()) {
    const el = model.get(id);
    if (el && el.attrs.value !== undefined && (definitions.contradiction(el) || statedAgainstBoundSomewhere(model, el))) {
      propagated.delete(id);
    }
  }
  // The equations the solve fixed a value from — for which plain constraints
  // it IMPOSED rather than judged.
  const used = new Set<Equation>();
  // The values a fact of the model fixed (an asserted equation, a binding, a
  // definition) from values the model states or other facts fixed — however
  // the plain constraints are written: no design equation's, though the solve
  // produced them. A fact that reads a value a check fixed gives one that moves
  // with it, and is not among them ({@link designReadings}).
  const factFixed = new Set<ElementId>();
  // The values an equation found no root at: what it reads is the same, so is the answer. Every propagation pass asks again of every
  // equation with one unknown left, and a one-to-one equation that finds no root searches the line for one (203 samples and the
  // poles among them): in a chain that takes a pass to fix each link, that was once per link per equation.
  const missedAt = new Map<Equation, string>();
  // Fix the one unknown `eq` reads, where it may: whether it did.
  const orient = (eq: Equation): boolean => {
    const unknowns = eq.vars.filter((v) => !values.has(v));
    if (unknowns.length !== 1) return false;
    const u = unknowns[0];
    if (fixedIds.has(u) || !mayOrient(eq, u, binding)) return false;
    const reads = eq.vars.map((v) => values.get(v)).join(',');
    if (missedAt.get(eq) === reads) return false;
    const val = solveForSingle(eq, u, values, tol);
    if (val === undefined || !Number.isFinite(val)) {
      missedAt.set(eq, reads);
      return false;
    }
    values.set(u, val);
    used.add(eq);
    // A root of an equation with more than one is one of several: no value the model fixes ({@link designReadings}); that of an
    // equation one to one in it (`d / t`, `2.0 ^ y`) is the only.
    if (!isCheck(eq) && eq.vars.every((v) => v === u || known.has(v) || factFixed.has(v)) && !isCurved(eq, [u])) factFixed.add(u);
    return true;
  };
  // The facts to their fixpoint: after every check that fixes a value as well,
  // so a fact the check unblocks is read before the next check is — in the
  // text order of two checks, the one written first reached a value the fact
  // would have given (a requirement's `x + y == 10.0` beside the asserted `y ==
  // x * 2.0`) and the solve stopped off the model's own equation, or on the
  // checks that disagree, whichever came first.
  const orientFacts = (): boolean => {
    let any = false;
    for (let more = true; more; ) {
      more = false;
      for (const eq of facts) if (orient(eq)) more = any = true;
    }
    return any;
  };

  let iterations = 0;
  let progressing = true;

  while (iterations < maxIter && progressing) {
    progressing = false;

    // Propagation fixpoint: bindings + single-unknown equation orientation.
    let changed = true;
    while (changed && iterations < maxIter) {
      changed = false;
      iterations++;

      for (const [id, v] of propagated) {
        if (!values.has(id) && !fixedIds.has(id)) {
          values.set(id, v);
          known.add(id);
          changed = true;
        }
      }

      for (const eq of facts) if (orient(eq)) changed = true;
      if (!changed) {
        for (const eq of checks) {
          if (!orient(eq)) continue;
          changed = true;
          orientFacts();
        }
      }
      if (changed) progressing = true;
    }

    // Remaining coupled unknowns → one bounded Newton solve. A feature whose
    // own value cannot be read is no unknown to solve for. One an assert holds
    // in a form the solve does not read is solved from the model's own
    // equations alone: no check that reads it is driven.
    const unknowns = remainingUnknowns(eqs, values, fixedIds).filter((v) => !unreadable.has(v) && !givenWay.has(v));
    if (unknowns.length === 0) break;
    iterations++;
    const moved = newtonSolve(own, unknowns, values, fixedIds, tol, maxIter, defined, unreadable, used);
    if (moved) progressing = true;
    else break;
  }

  const { residual, determined, withinTol } = residualSummary(eqs, values, tol);
  const converged = determined && withinTol;
  // What the definitions alone determine over what the model states is given
  // as well — but it stays a column of the freedom analysis, its definitions
  // rows of it: whether they determine it is the question that analysis
  // answers, with the jump and the unreadable slope a definition can stop on
  // (`b == (if a >= 1.0 then a else a + 1.0)` beside `a == b`, at a = 1).
  const closedNow = closedByDefinitions(eqs, defined, (v) => known.has(v), values, unreadable, true);
  const given = new Set<ElementId>([...known, ...unreadable, ...closedNow]);
  const relations = new Set<ElementId>();
  const imposed = new Set<ElementId>();
  for (const [eq, el] of relationOf) {
    relations.add(el.id);
    if (used.has(eq) && el.eClass === 'ConstraintUsage' && !isAsserted(el)) imposed.add(el.id);
  }
  // Where the solve stopped OFF one of its own equations, what it produced
  // there is no solution, and the rank read at it is no answer either: the
  // freedom analysis reads the rest of the system alone.
  const stated = (v: ElementId): boolean => known.has(v) || unreadable.has(v);
  const unsettled = converged
    ? new Set<ElementId>()
    : unsettledFeatures(eqs, values, tol, stated, (eq) => {
        const el = relationOf.get(eq);
        return el === undefined || el.eClass !== 'ConstraintUsage' || isAsserted(el) || imposed.has(el.id);
      });
  // The rows in an order of their own, not the text's, where it could show: of two rows with the same entry in a column the
  // elimination takes the earlier, and a row that reads a free feature frees the one it pivots. `x * y == z` above `x ==
  // 1.0` and `x == 3.0` freed x; below them it did not. The model's own equations first, as they are oriented first, then
  // the plain constraints, fewest features first and then by the text of the relation.
  const rows = (list: readonly Equation[]): Equation[] => [
    ...list.filter((eq) => !isCheck(eq)),
    ...list
      .filter(isCheck)
      .sort((a, b) => a.vars.length - b.vars.length || (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0)),
  ];
  const free =
    unsettled.size === 0
      ? freeFeatures(rows(own), values, stated)
      : freeFeatures(
          rows(own.filter((eq) => !eq.vars.some((v) => unsettled.has(v)))),
          values,
          (v) => stated(v) || unsettled.has(v),
        );
  // The plain equations over what a design equation the solve took fixed: of
  // two that disagree, the one it took is the one written first, so none holds
  // there; of two that agree, the one written first was imposed and the other
  // judged satisfied, and the other way round — both are design equations.
  const { contested, rival, curved, agreeing } = designReadings(
    eqs,
    values,
    tol,
    (v) => given.has(v) || factFixed.has(v),
    (v) => free.has(v) || unsettled.has(v),
    // The features the definitions close that no value the model states or a fact fixes one to one gives.
    new Set([...closedNow].filter((v) => !known.has(v) && !unreadable.has(v) && !factFixed.has(v))),
    isCheck,
    used,
    relationOf,
    (eq) => {
      // By its name where it has one; the text of a stated value, or of an equation an instance holds, otherwise.
      const name = relationOf.get(eq)?.declaredName;
      if (name) return name;
      const feature = eq.states === undefined ? undefined : model.get(baseIdOf(eq.states))?.declaredName;
      return `\`${feature ? `${feature} = ${eq.raw}` : eq.raw}\``;
    },
  );
  for (const [eq, el] of relationOf) {
    if (imposed.has(el.id) && eq.vars.some((v) => contested.has(v))) imposed.delete(el.id);
    else if (agreeing.has(eq) && !eq.vars.some((v) => contested.has(v))) imposed.add(el.id);
  }
  return { point: values, free, unsettled, given, relations, imposed, held, contested, rival, curved, converged, iterations, residual };
}

/**
 * The variables of `eqs` with no value (`stopped` is false of them) that an
 * ASSERTED relation the solve reads no equation from constrains (`readBy`,
 * {@link GatheredSystem.held}) — an inequality, a conjunction, a disjunction —
 * and every one the model's own equations (a value, a binding, an asserted
 * equation: never a check, `isCheck`) link to one of those through variables
 * with no value, each with the asserts that hold it. None is a design freedom
 * for a check: the model says what it may be, and the solve does not read it,
 * so no check may fix it ({@link mayOrient}), nor a Newton step fit it to one —
 * the model's own equations alone solve it, or leave it free. Free to them,
 * `constraint t1 { p.L == 1.0 }` fixed p's L at 1 beside P's asserted `L ==
 * 50.0 and L >= 0.0`, and `p.L <= 10.0` read satisfied where L is 50 — and of
 * `t50` and `t60` the one written first was imposed and the other refuted.
 */
function heldByUnreadAsserts(
  eqs: readonly Equation[],
  readBy: ReadonlyMap<ElementId, ElementId[]>,
  isCheck: (eq: Equation) => boolean,
  stopped: (v: ElementId) => boolean,
): Map<ElementId, ElementId[]> {
  const out = new Map<ElementId, ElementId[]>();
  for (const [v, by] of readBy) if (!stopped(v)) out.set(v, [...by]);
  if (out.size === 0) return out;
  const factsOf = new Map<ElementId, Equation[]>();
  for (const eq of eqs) {
    if (isCheck(eq)) continue;
    for (const v of eq.vars) {
      const list = factsOf.get(v);
      if (list) list.push(eq);
      else factsOf.set(v, [eq]);
    }
  }
  const queue = [...out.keys()];
  while (queue.length > 0) {
    const v = queue.pop()!;
    const by = out.get(v)!;
    for (const eq of factsOf.get(v) ?? []) {
      for (const u of eq.vars) {
        if (stopped(u)) continue;
        const had = out.get(u);
        if (had === undefined) {
          out.set(u, [...by]);
          queue.push(u);
        } else {
          const more = by.filter((id) => !had.includes(id));
          if (more.length === 0) continue;
          had.push(...more);
          queue.push(u);
        }
      }
    }
  }
  return out;
}

/**
 * What a node varies as in one unknown: nothing (`const`), a constant multiple of it plus a constant (`affine`), a
 * one-to-one function of it that is not (`mono`: `2.0 / (x - 1.0)`, `2.0 ^ y`, one root at most when it is set equal to
 * something that does not vary with it: {@link equationShape} reads the two sides of an equation together), or neither
 * (`curved`: `x * x`, `1.0 / x + x`, an `if` over it — it may have more than one root: an over-approximation, `x ^ 3.0` has one real root). A constant over an affine function of it
 * (`2.0 / x`, a quotient by a value the other equations fix) is `mono`, wherever the equation is read.
 */
type Shape = 'const' | 'affine' | 'mono' | 'curved';

/**
 * The {@link Shape} of `node` in the features `unknown` picks out. With `joint`, those are several at once, and a
 * function of them that is not affine is curved however it is built: `mono` is a property of one feature.
 */
function shapeOver(
  node: ExprNode,
  nameToId: ReadonlyMap<string, ElementId>,
  unknown: (id: ElementId | undefined) => boolean,
  joint = false,
): Shape {
  switch (node.kind) {
    case 'ref':
      return unknown(nameToId.get(node.path.join('.'))) ? 'affine' : 'const';
    case 'unary': {
      const inner = shapeOver(node.operand, nameToId, unknown, joint);
      return node.op === 'not' && inner !== 'const' ? 'curved' : inner;
    }
    case 'binary': {
      const l = shapeOver(node.left, nameToId, unknown, joint);
      const r = shapeOver(node.right, nameToId, unknown, joint);
      if (l === 'curved' || r === 'curved') return 'curved';
      if (l === 'const' && r === 'const') return 'const';
      const flat = (s: Shape): boolean => s === 'const' || s === 'affine';
      switch (node.op) {
        case '+':
        case '-':
          return flat(l) && flat(r) ? 'affine' : l === 'const' || r === 'const' ? 'mono' : 'curved';
        case '*':
          return l === 'const' ? r : r === 'const' ? l : 'curved';
        case '/':
          return r === 'const' ? l : l === 'const' && r === 'affine' && !joint ? 'mono' : 'curved';
        case '^':
          // A positive base other than 1 raised to an affine function: one to one.
          return !joint && r === 'affine' && node.left.kind === 'num' && node.left.value > 0 && node.left.value !== 1
            ? 'mono'
            : 'curved';
        default:
          return 'curved';
      }
    }
    case 'if':
      return [node.cond, node.then, node.else].every((n) => shapeOver(n, nameToId, unknown, joint) === 'const')
        ? 'const'
        : 'curved';
    default:
      return 'const';
  }
}

/**
 * The {@link Shape} of the equation as ONE function, its two sides taken as `lhs - rhs`: not of each side alone. A one-to-one side
 * set equal to a side that varies with the same feature can cross it twice (`6.0 / y == 5.0 - y` at 2 and 3, `2.0 ^ y == y + 1.0`
 * at 0 and 1, `x == 6.0 / (x + 1.0)` at 2 and −3): only a side that does not vary with it keeps the one root.
 */
function equationShape(eq: Equation, unknown: (id: ElementId | undefined) => boolean, joint = false): Shape {
  return shapeOver({ kind: 'binary', op: '-', left: eq.lhs, right: eq.rhs }, eq.nameToId, unknown, joint);
}

/**
 * Is `eq` CURVED in one of its `unknowns` — not an affine function of it with the others held (`x * x`, `1.0 / x + x`,
 * `x ^ 2.0`, a `%` or an `if` over it)? Solved for that unknown it may have more than one root. A product of two
 * unknowns (`mass == density * volume`) is not: once the others are fixed it is affine in the one left
 * ({@link isJointlyCurved} asks it of the two together). Nor is a one-to-one function of it (`2.0 / x`, `v / t` with `v`
 * fixed by another equation, `2.0 ^ y`): it has one root at most, when the other side of the equation does not vary with the
 * same unknown (`x == 6.0 / (x + 1.0)` does: 2 and −3).
 */
function isCurved(eq: Equation, unknowns: readonly ElementId[]): boolean {
  return unknowns.some((u) => equationShape(eq, (id) => id === u) === 'curved');
}

/**
 * Is `eq` curved in its `unknowns` TAKEN TOGETHER — a product or quotient of two of them (`x * y == 4.0`), which is affine in
 * each with the other held? Solved together with another equation that links them (`x == y`) the pair has more than one
 * root: (2, 2) and (−2, −2).
 */
function isJointlyCurved(eq: Equation, unknowns: readonly ElementId[]): boolean {
  const set = new Set<ElementId>(unknowns);
  return equationShape(eq, (id) => id !== undefined && set.has(id), true) === 'curved';
}

/**
 * Which of the equations over the features `isOpen` can take more than one root ({@link designReadings}): `anyCurved`, whether
 * one of them is curved at all, and `rooted`, whether one of a component of them does.
 */
interface RootReader {
  openOf: (eq: Equation) => ElementId[];
  anyCurved: boolean;
  rooted: (eq: Equation, comp: readonly Equation[]) => boolean;
}

function rootReader(eqs: readonly Equation[], isOpen: (v: ElementId) => boolean): RootReader {
  // What each equation reads that is open, and whether it is curved in one of them, are found once: the closures below ask both of
  // every equation of the component once per curved equation they are asked about.
  const opens = new Map<Equation, ElementId[]>();
  const openOf = (eq: Equation): ElementId[] => {
    let open = opens.get(eq);
    if (open === undefined) opens.set(eq, (open = eq.vars.filter(isOpen)));
    return open;
  };
  // The equations curved in one unknown of theirs. One to one in it (`v == d / t`, `x / y == 3.0` over a `y` another
  // equation fixes, `x == 2.0 ^ y`) is not: it has the one root whatever it is set equal to.
  const curvedAt = new Map<Equation, Map<ElementId, boolean>>();
  const curvedIn = (eq: Equation, vars: readonly ElementId[]): boolean => {
    if (vars.length !== 1) return isCurved(eq, vars);
    let known = curvedAt.get(eq);
    if (known === undefined) curvedAt.set(eq, (known = new Map()));
    let c = known.get(vars[0]!);
    if (c === undefined) known.set(vars[0]!, (c = isCurved(eq, vars)));
    return c;
  };
  const single = new Map<Equation, boolean>();
  let anyCurved = false;
  for (const eq of eqs) {
    const vs = openOf(eq);
    if (vs.length === 0) continue;
    const c = curvedIn(eq, vs);
    single.set(eq, c);
    if (c || (vs.length > 1 && isJointlyCurved(eq, vs))) anyCurved = true;
  }
  // Can the solve take `eq` to a value with more than one root? Not by what the other equations fix one at a time, each
  // affine in the one left, whatever order the text gives them: `eq` is then affine in what it fixes (`z == x * x` over an
  // `x == 3.0`, `mass == density * volume` over the two it multiplies), or fixes nothing and holds (`x * y == 6.0`
  // beside `x == 2.0` and `y == 3.0`) — unless it is curved in a feature it may fix while the others it reads are fixed
  // without that one (`x * x == 4.0` beside `x == -2.0`: the root 2 when it is taken first). What they leave open it fixes
  // together: a root, curved in the one left, or a coupled pair (`x * y == 4.0` beside `x == y`).
  const fixedByOthers = (eq: Equation, comp: readonly Equation[], unavailable?: ElementId): Set<ElementId> => {
    const fixedBy = new Set<ElementId>();
    // A worklist, linear in the component whatever the order of its equations: one fixes a feature once it is the only one it
    // reads that is not fixed yet, and each feature fixed counts down the equations that read it.
    const readers = new Map<ElementId, Equation[]>();
    const waiting = new Map<Equation, number>();
    const ready: Equation[] = [];
    for (const o of comp) {
      if (o === eq) continue;
      const open = openOf(o);
      waiting.set(o, open.length);
      if (open.length === 1) ready.push(o);
      for (const v of open) {
        const list = readers.get(v);
        if (list) list.push(o);
        else readers.set(v, [o]);
      }
    }
    while (ready.length > 0) {
      const o = ready.pop()!;
      const u = openOf(o).find((v) => !fixedBy.has(v));
      if (u === undefined || u === unavailable || curvedIn(o, [u])) continue;
      fixedBy.add(u);
      for (const r of readers.get(u)!) {
        const left = waiting.get(r)! - 1;
        waiting.set(r, left);
        if (left === 1) ready.push(r);
      }
    }
    return fixedBy;
  };
  const rooted = (eq: Equation, comp: readonly Equation[]): boolean => {
    const vs = openOf(eq);
    if (single.get(eq) !== true && (vs.length < 2 || !isJointlyCurved(eq, vs))) return false;
    // Curved in a feature it may fix while every other it reads is fixed without it: taken first, it takes a root
    // (`x * x == 4.0` beside `x == -2.0`; `z == x * x` beside `z == 9.0` and `x == 3.0`). Not where the others are only
    // fixed through that feature (`b == a + (if a >= 1.0 then 0.0 else 1.0)` beside `a == b` and `a == 3.0`: b waits for a).
    for (const u of vs) {
      if (!curvedIn(eq, [u])) continue;
      const known = fixedByOthers(eq, comp, u);
      if (vs.every((v) => v === u || known.has(v))) return true;
    }
    const fixedBy = fixedByOthers(eq, comp);
    const left = vs.filter((v) => !fixedBy.has(v));
    if (left.length === 0) return false;
    if (!(left.length === 1 ? curvedIn(eq, left) : isJointlyCurved(eq, left))) return false;
    // Only where the equations over them can fix each of them, one apiece: `mass = density * volume` beside `mass ==
    // 100.0` leaves density and volume a freedom along the curve, not two roots (a matching of the features to the
    // equations that read them).
    const over = comp.filter((o) => openOf(o).some((v) => left.includes(v)));
    const taken = new Map<Equation, ElementId>();
    const place = (v: ElementId, seen: Set<Equation>): boolean => {
      for (const o of over) {
        if (seen.has(o) || !openOf(o).includes(v)) continue;
        seen.add(o);
        const held = taken.get(o);
        if (held === undefined || place(held, seen)) {
          taken.set(o, v);
          return true;
        }
      }
      return false;
    };
    return left.every((v) => place(v, new Set()));
  };
  return { openOf, anyCurved, rooted };
}

/**
 * The model's own equations of more than one root among those the DEFINITIONS close ({@link closedByDefinitions}), over the
 * features of them (`looped`) that no stated value gives, and every feature they leave to the root they take — in the
 * asserted `x == y * y + 1.0` and `y == 3.0 - x` (x = 2 or 5), a stated `x = y * y + 1.0` beside `y = 3.0 - x`, `x == y * y` beside
 * `y == x * x`. Closed, the Newton step found one of the roots and the features count as given, so no plain constraint
 * over them was ever read for the root: `x == 5.0` beside them read violated at x = 2 where (5, −2) meets every equation.
 * A feature the equations fix one at a time from the stated values and from each other is told apart first (a chain of
 * definitions, `d2 = d1 * d1` over `d1 = s * s`): one root whatever it is built of, and no part of a loop.
 */
function loopedRoots(
  eqs: readonly Equation[],
  values: ReadonlyMap<ElementId, number>,
  looped: ReadonlySet<ElementId>,
  isCheck: (eq: Equation) => boolean,
): { features: Set<ElementId>; equations: Set<Equation> } {
  const features = new Set<ElementId>();
  const equations = new Set<Equation>();
  const out = { features, equations };
  const isOpen = (v: ElementId): boolean => looped.has(v) && values.has(v);
  // The definitions alone: they read nothing but the stated values and each other (that is what closes them), so the rest of the
  // features they read are fixed. Another equation of the model's may read a feature a plain constraint gives, which is not.
  const facts = eqs.filter((eq) => !isCheck(eq) && ((eq.defines?.length ?? 0) > 0 || eq.states !== undefined) && eq.vars.some(isOpen));
  if (facts.length === 0) return out;
  const readers = new Map<ElementId, Equation[]>();
  const waiting = new Map<Equation, number>();
  const ready: Equation[] = [];
  for (const eq of facts) {
    const vs = eq.vars.filter(isOpen);
    waiting.set(eq, vs.length);
    if (vs.length === 1) ready.push(eq);
    for (const v of vs) {
      const list = readers.get(v);
      if (list) list.push(eq);
      else readers.set(v, [eq]);
    }
  }
  const settled = new Set<ElementId>();
  while (ready.length > 0) {
    const eq = ready.pop()!;
    const u = eq.vars.find((v) => isOpen(v) && !settled.has(v));
    if (u === undefined || isCurved(eq, [u])) continue;
    settled.add(u);
    for (const r of readers.get(u)!) {
      const left = waiting.get(r)! - 1;
      waiting.set(r, left);
      if (left === 1) ready.push(r);
    }
  }
  const reader = rootReader(facts, (v) => isOpen(v) && !settled.has(v));
  if (!reader.anyCurved) return out;
  const parent = new Map<ElementId, ElementId>();
  const find = (a: ElementId): ElementId => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (a !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  for (const eq of facts) {
    const vs = reader.openOf(eq);
    for (const v of vs) if (!parent.has(v)) parent.set(v, v);
    for (let i = 1; i < vs.length; i++) {
      const a = find(vs[0]!);
      const b = find(vs[i]!);
      if (a !== b) parent.set(a, b);
    }
  }
  const byRoot = new Map<ElementId, Equation[]>();
  for (const eq of facts) {
    const vs = reader.openOf(eq);
    if (vs.length === 0) continue;
    const root = find(vs[0]!);
    const list = byRoot.get(root);
    if (list) list.push(eq);
    else byRoot.set(root, [eq]);
  }
  for (const comp of byRoot.values()) {
    const rooted = comp.filter((eq) => reader.rooted(eq, comp));
    if (rooted.length === 0) continue;
    for (const eq of rooted) equations.add(eq);
    for (const eq of comp) for (const v of reader.openOf(eq)) features.add(v);
  }
  return out;
}

/**
 * What the plain equations (`isCheck`) read where a plain constraint the solve
 * took as a design equation (`used`) fixed the value: over the values the
 * solve PRODUCED (`fixed` and `loose` are false of them: no value the model
 * states, none its definitions determine or a fact of the model fixed from
 * those, no freedom, nothing it stopped at unconverged),
 * linked by the equations to a value such a constraint fixed — a DESIGN
 * component. Which of its plain equations is taken turns on which comes first,
 * in TEXT order, so:
 *  - `contested`: the values of a design component one of whose plain
 *    equations the solve did not take and the point misses, each with the
 *    plain equations taken and missed there. Of `t50 { p.L == 50.0 }` and `t60
 *    { p.L == 60.0 }` over a valueless L, written in that order t50 was imposed
 *    and t60 refuted, and the other way round t60 imposed and t50 refuted: none
 *    of those values is published, and nothing is judged at it.
 *  - `agreeing`: a plain equation of a design component the solve did not take
 *    that holds at the point — as much a design equation as the one it took:
 *    of `a { x == 3.0 }` and `b { x == 3.0 }` over a valueless x the one
 *    written first was imposed and the other judged satisfied.
 * A value a fact of the model fixes (an asserted equation, a binding), though
 * the solve produced it, is no design component's: a check over it is judged
 * (`assert constraint s { x + y == 10.0 }` with y stated: a plain `x == 9.0`
 * is violated, beside `w == x + 1.0` that the solve took). A fact that is
 * curved in the value it fixed (`assert constraint { x * x == 4.0 }`) fixes
 * none: its roots are the model's, the one the solve took is not.
 *
 * A component whose equations have more than one root reads no value at all
 * beside a plain constraint ({@link SolveCore.rival}), whether or not any was
 * left unused: the solve takes the root it finds, and the plain constraints
 * hold there or not by which equation it oriented first, or by which root.
 * Of `a { x * x == 4.0 }` and `b { x == -2.0 }` the root 2 when `a` is
 * written first, −2 when `b` is; of `c0 { x * x == 4.0 }`, `c1 { y == x + 1.0 }`
 * and `c2 { y <= 0.0 }` the root (2, 3), where (−2, −1) meets all three.
 * Whether the roots agree is not read: the component is withheld in every
 * order. The component is every feature the equations link — the plain
 * constraints' own variables, those the solve left free among them — and its
 * equations are every one that reads them: the model's own (a stated `s = x *
 * x`, an assert) as much as a plain constraint. One has more than one root
 * (`rooted`, in the body) when what the others fix one at a time, each affine in the
 * one left, leaves it curved in a feature it may then fix instead, or curved in
 * what it fixes with them together (`x * y == 4.0` beside `x == y`), those the
 * equations over them fix one apiece; `z == x * x` over `x == 3.0` has the one,
 * and `mass = density * volume` beside `mass == 100.0` a freedom. A loop of
 * definitions of more than one root, which {@link closedByDefinitions} binds at
 * the root found, is open to this reading as well ({@link loopedRoots}), and the
 * features other equations and plain constraints take from it with them. A lone curved plain constraint is imposed at
 * the root found, and a relation the solve gathers no equation from over its
 * value is not judged ({@link SolveCore.curved}). An equation one to one in the
 * feature it fixes (`v == d / t`, a quotient by a value another equation fixes
 * as in `x / y == 3.0` beside `y == 2.0` and `x == 6.0`, `2.0 ^ y`), with the
 * feature on one side of the equation only, has the one root and is no curved
 * one, plain or not ({@link equationShape}: `x == 6.0 / (x + 1.0)` is). What the
 * others fix is found in time linear in the component's size, for each equation
 * that may have more than one root, whatever that size.
 */
function designReadings(
  eqs: readonly Equation[],
  values: Map<ElementId, number>,
  tol: number,
  fixed: (v: ElementId) => boolean,
  loose: (v: ElementId) => boolean,
  looped: ReadonlySet<ElementId>,
  isCheck: (eq: Equation) => boolean,
  used: ReadonlySet<Equation>,
  relationOf: ReadonlyMap<Equation, ElementRecord>,
  describe: (eq: Equation) => string,
): {
  contested: Map<ElementId, ElementId[]>;
  rival: Map<ElementId, 'plain' | 'model'>;
  curved: Map<ElementId, string[]>;
  agreeing: Set<Equation>;
} {
  // What the definitions close and no stated value gives, in a loop with more than one root, is open as well: the root the
  // solve found there is one of several ({@link loopedRoots}).
  const seeded = loopedRoots(eqs, values, looped, isCheck);
  // The features the equations leave their value to: the produced and those left free or unsettled.
  const open = (v: ElementId): boolean => values.has(v) && (!fixed(v) || seeded.features.has(v));
  const produced = (v: ElementId): boolean => open(v) && !loose(v);
  const contested = new Map<ElementId, ElementId[]>();
  const rival = new Map<ElementId, 'plain' | 'model'>();
  const curved = new Map<ElementId, string[]>();
  const agreeing = new Set<Equation>();
  const none = { contested, rival, curved, agreeing };
  const unused: Equation[] = [];
  const touching = new Set<Equation>();
  let took = false;
  for (const eq of eqs) {
    if (!eq.vars.some(produced)) continue;
    touching.add(eq);
    if (!isCheck(eq)) continue;
    if (used.has(eq)) took = true;
    else if (eq.vars.every((v) => values.has(v))) unused.push(eq);
  }
  if (touching.size === 0) return none;
  const { openOf, anyCurved, rooted } = rootReader(eqs, open);
  if (!anyCurved && (!took || unused.length === 0)) return none;
  const parent = new Map<ElementId, ElementId>();
  const find = (a: ElementId): ElementId => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (a !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  const link = (vs: readonly ElementId[]): void => {
    for (const v of vs) if (!parent.has(v)) parent.set(v, v);
    for (let i = 1; i < vs.length; i++) {
      const a = find(vs[0]!);
      const b = find(vs[i]!);
      if (a !== b) parent.set(a, b);
    }
  };
  for (const eq of touching) link(openOf(eq));
  // An equation over features left free that links to one of them is as much the component's: `z * z == y` beside
  // `z == x * y`, where the root the solve found makes z and y free.
  const members = new Set<Equation>(touching);
  const rest = eqs.filter((eq) => !touching.has(eq) && eq.vars.some(open));
  for (let grew = rest.length > 0; grew; ) {
    grew = false;
    for (const eq of rest) {
      if (members.has(eq)) continue;
      const vs = openOf(eq);
      if (!vs.some((v) => parent.has(v))) continue;
      link(vs);
      members.add(eq);
      grew = true;
    }
  }
  const rootOf = (eq: Equation): ElementId => find(openOf(eq)[0]!);
  const byRoot = new Map<ElementId, Equation[]>();
  for (const eq of members) {
    const root = rootOf(eq);
    const list = byRoot.get(root);
    if (list) list.push(eq);
    else byRoot.set(root, [eq]);
  }
  // The design components: those a plain constraint the solve took fixes a value of.
  const design = new Set<ElementId>();
  for (const eq of used) if (isCheck(eq) && eq.vars.some(produced)) design.add(rootOf(eq));
  const rivalRoots = new Map<ElementId, 'plain' | 'model'>();
  const curvedRoots = new Map<ElementId, Equation[]>();
  const plainRoots = new Map<ElementId, Equation[]>();
  for (const [root, comp] of byRoot) {
    if (!comp.some((eq) => eq.vars.some(produced))) continue;
    // Beside another plain constraint: the one that is curved is not its own other.
    const plain = comp.filter((eq) => isCheck(eq) && (used.has(eq) || eq.vars.every((v) => values.has(v))));
    plainRoots.set(root, plain);
    // A curved plain constraint (`x * x`: not one to one in a feature it fixes) beside another, with one left unused by a design
    // equation the solve took, was withheld before the model's own equations and the rest were read: it still is.
    const asBefore =
      design.has(root) &&
      plain.length >= 2 &&
      plain.some((eq) => unused.includes(eq)) &&
      plain.some((eq) => touching.has(eq) && isCurved(eq, eq.vars.filter(produced)));
    const roots = comp.filter((eq) => seeded.equations.has(eq) || rooted(eq, comp));
    if (roots.length === 0 && !asBefore) continue;
    if (roots.length > 0) curvedRoots.set(root, roots);
    const model = roots.some((eq) => !isCheck(eq));
    if (model ? plain.length >= 1 : plain.length >= 2) rivalRoots.set(root, model ? 'model' : 'plain');
  }
  const missed = new Set<Equation>();
  const roots = new Set<ElementId>();
  for (const eq of unused) {
    const root = rootOf(eq);
    if (!design.has(root) || rivalRoots.has(root)) continue;
    const r = residualOf(eq, values);
    if (r !== undefined && Math.abs(r) <= convergenceGate(eq, values, tol) && nearRoot(eq, values, r)) {
      agreeing.add(eq);
    } else {
      missed.add(eq);
      roots.add(root);
    }
  }
  if (roots.size === 0 && rivalRoots.size === 0 && curvedRoots.size === 0) return none;
  // Per component, the plain constraints over it that the solve took, missed or found agreeing — each one the
  // component's whichever of them was written first: the ones a sentence names.
  const idsOf = (list: readonly Equation[]): ElementId[] => {
    const out: ElementId[] = [];
    for (const eq of list) {
      const id = relationOf.get(eq)?.id;
      if (id !== undefined && !out.includes(id)) out.push(id);
    }
    return out;
  };
  const named = new Map<ElementId, ElementId[]>();
  for (const eq of eqs) {
    const el = relationOf.get(eq);
    if (!el || !isCheck(eq) || !(used.has(eq) || missed.has(eq) || agreeing.has(eq)) || !eq.vars.some(produced)) continue;
    const root = rootOf(eq);
    if (!roots.has(root)) continue;
    const list = named.get(root) ?? [];
    if (!list.includes(el.id)) list.push(el.id);
    named.set(root, list);
  }
  const descriptions = new Map<ElementId, string[]>();
  for (const v of parent.keys()) {
    const root = find(v);
    const kind = rivalRoots.get(root);
    if (kind !== undefined) {
      contested.set(v, idsOf(kind === 'plain' ? plainRoots.get(root)! : []));
      rival.set(v, kind);
    } else if (roots.has(root)) {
      contested.set(v, named.get(root) ?? []);
    }
    const manyRoots = curvedRoots.get(root);
    if (manyRoots === undefined || (kind === undefined && !produced(v))) continue;
    let described = descriptions.get(root);
    if (described === undefined) descriptions.set(root, (described = [...new Set(manyRoots.map(describe))].sort()));
    curved.set(v, described);
  }
  return { contested, rival, curved, agreeing };
}

/**
 * The values the solve PRODUCED at a point that misses one of its own
 * equations — an asserted one, a binding, a feature's value, an instance's,
 * and a plain one it took as a design equation (`own`): every feature linked
 * to such an equation through the solve's own equations, over the features it
 * produced (the model's stated values, `stated`, link nothing). A Newton step
 * that diverged (`x / (1.0 + x * x) == 0.4 + y` beside `y == 0.001 * x -
 * 0.001 * x` sent x to −106760, both missed by 0.2) left x and y there, and every relation over
 * them was judged violated at that point — `x >= 0.0` among them, which x = 2
 * meets with both equations. A plain check the solve did not impose is judged
 * there, not solved: missed, it settles nothing either way.
 */
function unsettledFeatures(
  eqs: readonly Equation[],
  values: Map<ElementId, number>,
  tol: number,
  stated: (v: ElementId) => boolean,
  own: (eq: Equation) => boolean,
): Set<ElementId> {
  const parent = new Map<ElementId, ElementId>();
  const find = (a: ElementId): ElementId => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (a !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  const missed: ElementId[] = [];
  for (const eq of eqs) {
    if (!own(eq)) continue;
    const vs = eq.vars.filter((v) => values.has(v) && !stated(v));
    for (const v of vs) if (!parent.has(v)) parent.set(v, v);
    for (let i = 1; i < vs.length; i++) {
      const a = find(vs[0]!);
      const b = find(vs[i]!);
      if (a !== b) parent.set(a, b);
    }
    if (vs.length === 0 || !eq.vars.every((v) => values.has(v))) continue;
    const r = residualOf(eq, values);
    if (r === undefined || !(Math.abs(r) <= convergenceGate(eq, values, tol)) || !nearRoot(eq, values, r)) missed.push(vs[0]!);
  }
  if (missed.length === 0) return new Set();
  const roots = new Set(missed.map(find));
  const out = new Set<ElementId>();
  for (const v of parent.keys()) if (roots.has(find(v))) out.add(v);
  return out;
}

/** A pivot below this fraction of its (row- and column-scaled) row is no pivot. */
const RANK_TOL = 1e-7;

/**
 * One-sided slopes of a relation in one feature that differ by more than this
 * fraction of the steeper one: the residual JUMPS, or kinks, inside the probe,
 * and the slope read across it is no slope ({@link freeFeatures}, {@link
 * determines}).
 */
const JUMP_TOL = 0.5;

/**
 * The solved features the equations leave FREE: those a direction in the null
 * space of the Jacobian of every evaluable gathered equation — over the solved
 * features that are not `fixed` (stated, held, or bound to a stated value) —
 * moves. Any value along such a direction solves the same equations, so the
 * one the solve stopped at is a choice and no answer: it is never published,
 * and nothing is judged at it. A feature with a value that no evaluable
 * equation reads is free as well, and so is one whose reduced row READS a free
 * one, however small the dependence: that is read from the features the row's
 * equations read, never from the size of an entry.
 *
 * A row is LEFT OUT where its slope cannot be read, and where its two
 * one-sided slopes disagree ({@link JUMP_TOL}): an `if`, a `%` or a truncation
 * stopped exactly on its step reads a central difference of the step's
 * height over the probe's width, a pivot that fixes nothing — `r == (if x >=
 * 1.0 then 1.0 else 0.0)` solved at x = 1 then "determined" x, and `x <= 1.5`
 * was satisfied at a point every x above 1 solves as well. Leaving a row out
 * only frees features, never fixes one.
 *
 * The rank is LOCAL: two isolated roots (`x * x == 4.0`) each read as
 * determined, and the solve's is judged.
 */
function freeFeatures(
  eqs: readonly Equation[],
  values: ReadonlyMap<ElementId, number>,
  fixed: (v: ElementId) => boolean,
): Set<ElementId> {
  const out = new Set<ElementId>();
  const cols: ElementId[] = [];
  const colIdx = new Map<ElementId, number>();
  const rows: Array<{ eq: Equation; r0: number }> = [];
  const point = new Map(values);
  for (const eq of eqs) {
    if (!eq.vars.every((v) => values.has(v))) continue;
    const r0 = residualOf(eq, point);
    if (r0 === undefined || !Number.isFinite(r0)) continue;
    rows.push({ eq, r0 });
    for (const v of eq.vars) {
      if (fixed(v) || colIdx.has(v)) continue;
      colIdx.set(v, cols.length);
      cols.push(v);
    }
  }
  for (const eq of eqs) for (const v of eq.vars) if (values.has(v) && !fixed(v) && !colIdx.has(v)) out.add(v);
  if (cols.length === 0) return out;

  // A column's scale — and its probe, a millionth of it — is the feature's
  // own magnitude where a relation reads it in SI, and `|x| + 1` elsewhere:
  // `|x| + 1` is a probe three hundred times a nanometre-scale x, across which
  // the curvature of `x * x` read as a jump. One scale per COLUMN, whatever
  // the row: scaled row by row, two redundant rows could read as independent.
  const inSI = new Set<ElementId>();
  for (const { eq } of rows) for (const v of eq.vars) if (eq.scale?.has(v)) inSI.add(v);
  const scaleOf = (v: ElementId, x: number): number => (inSI.has(v) ? Math.abs(x) || 1 : Math.abs(x) + 1);

  // Each row: its slopes by column (the columns it does not read are 0), the
  // largest of them, and the columns it reads STRUCTURALLY — its equation's own.
  const J: JacobianRow[] = [];
  for (const { eq, r0 } of rows) {
    const row = new Map<number, number>();
    const slopes: Slope[] = [];
    let readable = true;
    for (const v of eq.vars) {
      const j = colIdx.get(v);
      if (j === undefined) continue;
      const x = point.get(v)!;
      const s = scaleOf(v, x);
      const h = 1e-6 * s;
      point.set(v, x + h);
      const a = residualOf(eq, point);
      point.set(v, x - h);
      const b = residualOf(eq, point);
      point.set(v, x);
      if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
        readable = false;
        break;
      }
      // Both one-sided slopes, in the column's scale: their mean is the
      // central difference, their gap is what says the residual jumps.
      const forward = ((a - r0) / h) * s;
      const backward = ((r0 - b) / h) * s;
      const d = (forward + backward) / 2;
      row.set(j, d);
      const steep = Math.max(Math.abs(forward), Math.abs(backward));
      slopes.push({ d, split: Math.abs(forward - backward), steep });
    }
    // A relation whose slope cannot be read — or jumps inside the probe —
    // fixes nothing this analysis can vouch for: its features are as free as
    // the other rows leave them. Each column is judged against its OWN
    // one-sided slopes: against the row's steepest, a co-variable of 5e6
    // (`y == z + (if x >= 1.0 then 1.0 else 0.0)`) hid the unit step in x. A
    // column whose slopes are negligible beside the row's steepest is no pivot
    // of it either way, and its curvature (`x * x` at x = 0, slopes ∓h) is no
    // jump.
    if (!readable || jumps(slopes)) continue;
    let mx = 0;
    for (const d of row.values()) mx = Math.max(mx, Math.abs(d));
    if (mx === 0) continue;
    J.push({
      slopes: row,
      mx,
      reads: new Set(eq.vars.map((v) => colIdx.get(v)).filter((j): j is number => j !== undefined)),
    });
  }
  const n = cols.length;
  const { pivots, reads } = sparseReduce(J, n) ?? denseReduce(J, n);
  // Reduced: a pivot feature is free when its row reads a free column — read
  // from what the row reads, never from the size of its reduced entry. A
  // feature of a few hundred kilometres moved by an offset in millimetres
  // (`range == base + offset`) reads it at 1e-8 of the row, under any pivot
  // tolerance, and in nanometres not at all: `range` was published as
  // determined, and `range >= 100.5 [km]` refuted, although an offset of
  // 500 m meets it.
  const isPivot = new Set(pivots);
  const freeCols: number[] = [];
  for (let c = 0; c < n; c++) if (!isPivot.has(c)) freeCols.push(c);
  for (const f of freeCols) out.add(cols[f]!);
  pivots.forEach((c, i) => {
    if (freeCols.some((f) => reads[i]!.has(f))) out.add(cols[c]!);
  });
  return out;
}

/** A row of {@link freeFeatures}' Jacobian, before it is scaled to its largest entry. */
interface JacobianRow {
  /** The row's nonzero-or-read slopes by column; a column absent is 0. */
  slopes: ReadonlyMap<number, number>;
  /** The largest |slope| of the row (NaN when one is NaN), never 0. */
  mx: number;
  /** The columns the row's equation reads. */
  reads: ReadonlySet<number>;
}

/**
 * Gauss-Jordan elimination of {@link freeFeatures}' Jacobian, each row scaled
 * to its largest entry: the pivot columns in order, and for the pivot row of
 * each the columns it reads STRUCTURALLY — its equation's own, and those of
 * every pivot row it was reduced by. The pivot of a column is the row at or
 * past the current one with the strictly largest |entry|, the earliest on a
 * tie; a pivot of {@link RANK_TOL} or less is none.
 */
function denseReduce(rows: readonly JacobianRow[], n: number): { pivots: number[]; reads: Array<Set<number>> } {
  const J: number[][] = [];
  const S: Array<Set<number>> = [];
  for (const { slopes, mx, reads } of rows) {
    const row = new Array<number>(n).fill(0);
    for (const [j, d] of slopes) row[j] = d;
    J.push(row.map((e) => e / mx));
    S.push(new Set(reads));
  }
  const pivots: number[] = [];
  let r = 0;
  for (let c = 0; c < n && r < J.length; c++) {
    let p = r;
    for (let i = r + 1; i < J.length; i++) if (Math.abs(J[i]![c]!) > Math.abs(J[p]![c]!)) p = i;
    if (Math.abs(J[p]![c]!) <= RANK_TOL) continue;
    [J[r], J[p]] = [J[p]!, J[r]!];
    [S[r], S[p]] = [S[p]!, S[r]!];
    const piv = J[r]![c]!;
    for (let k = c; k < n; k++) J[r]![k]! /= piv;
    for (let i = 0; i < J.length; i++) {
      if (i === r) continue;
      const f = J[i]![c]!;
      // A row that reads the pivot's column reads, through it, every column
      // the pivot row reads — whatever its entry there, which a slope the
      // probe cannot resolve (`1e-30 * c`) reads as exactly 0.
      if (f === 0 && !S[i]!.has(c)) continue;
      if (f !== 0) for (let k = c; k < n; k++) J[i]![k]! -= f * J[r]![k]!;
      for (const k of S[r]!) S[i]!.add(k);
    }
    pivots.push(c);
    r++;
  }
  return { pivots, reads: S.slice(0, pivots.length) };
}

/**
 * {@link denseReduce} over SPARSE rows — its pivots and reads exactly, at a
 * cost in the entries the rows hold rather than rows × columns (1.3 of 2.5 s
 * of a 4098-row numeric check, dense). While every entry is finite the two
 * agree bit for bit: every nonzero entry sees the same operations in the same
 * order, and an entry the dense loop holds as 0 only ever becomes a signed
 * zero there (`x − f·0`, `0 / piv`), which no comparison tells from 0 and the
 * sparse rows hold as absent. A non-finite entry is where they could part (`f
 * · 0` is NaN for an infinite `f`), so on the first one this answers
 * `undefined`, and the caller runs {@link denseReduce}.
 */
function sparseReduce(
  rows: readonly JacobianRow[],
  n: number,
): { pivots: number[]; reads: Array<Set<number>> } | undefined {
  interface Row {
    e: Map<number, number>;
    S: Set<number>;
  }
  const R: Row[] = [];
  for (const { slopes, mx, reads } of rows) {
    if (!Number.isFinite(mx)) return undefined;
    const e = new Map<number, number>();
    for (const [j, d] of slopes) {
      const y = d / mx;
      if (y !== 0) e.set(j, y);
    }
    R.push({ e, S: new Set(reads) });
  }
  // Each row's position; per column, the rows holding a nonzero entry there
  // and the rows that read it structurally (a superset: an entry is only ever
  // made where the row reads, or comes to read, its column).
  const pos = new Map<Row, number>();
  R.forEach((row, i) => pos.set(row, i));
  const nonzero = new Map<number, Set<Row>>();
  const readers = new Map<number, Set<Row>>();
  const enroll = (m: Map<number, Set<Row>>, c: number, row: Row): void => {
    const set = m.get(c);
    if (set) set.add(row);
    else m.set(c, new Set([row]));
  };
  for (const row of R) {
    for (const c of row.e.keys()) enroll(nonzero, c, row);
    for (const c of row.S) enroll(readers, c, row);
  }
  let finite = true;
  const put = (row: Row, k: number, v: number): void => {
    if (!Number.isFinite(v)) finite = false;
    if (v !== 0) {
      if (!row.e.has(k)) enroll(nonzero, k, row);
      row.e.set(k, v);
    } else if (row.e.delete(k)) nonzero.get(k)!.delete(row);
  };
  const pivots: number[] = [];
  const pivotRows: Row[] = [];
  let r = 0;
  for (let c = 0; c < n && r < R.length; c++) {
    // The dense scan from row r: a strictly larger |entry| wins, the earliest
    // row on a tie.
    let p = r;
    let best = Math.abs(R[r]!.e.get(c) ?? 0);
    for (const row of nonzero.get(c) ?? []) {
      const i = pos.get(row)!;
      if (i <= r) continue;
      const a = Math.abs(row.e.get(c)!);
      if (a > best || (a === best && i < p)) {
        best = a;
        p = i;
      }
    }
    if (best <= RANK_TOL) continue;
    const prow = R[p]!;
    const moved = R[r]!;
    R[r] = prow;
    R[p] = moved;
    pos.set(prow, r);
    pos.set(moved, p);
    const piv = prow.e.get(c)!;
    for (const k of [...prow.e.keys()]) if (k >= c) put(prow, k, prow.e.get(k)! / piv);
    const update: Array<[number, number]> = [];
    for (const [k, v] of prow.e) if (k >= c) update.push([k, v]);
    for (const row of [...(readers.get(c) ?? [])]) {
      if (row === prow) continue;
      const f = row.e.get(c) ?? 0;
      if (f !== 0) for (const [k, v] of update) put(row, k, (row.e.get(k) ?? 0) - f * v);
      for (const k of prow.S) {
        if (row.S.has(k)) continue;
        row.S.add(k);
        enroll(readers, k, row);
      }
    }
    if (!finite) return undefined;
    pivots.push(c);
    pivotRows.push(prow);
    r++;
  }
  return { pivots, reads: pivotRows.map((row) => row.S) };
}

/**
 * The features some gathered equation is the definition of ({@link
 * Equation.defines}), and those whose own value the solver lane cannot read
 * ({@link gatherSystem}), which nothing defines.
 */
function definedFeatures(eqs: readonly Equation[], unreadable: ReadonlySet<ElementId> = new Set()): Set<ElementId> {
  const out = new Set<ElementId>(unreadable);
  for (const eq of eqs) for (const id of eq.defines ?? []) out.add(id);
  return out;
}

/**
 * May `eq` fix `u` by propagation? Not when `u` has a definition among the
 * gathered equations that binds it (`defined`: one the definitions alone
 * determine, {@link closedByDefinitions}) and `eq` is not it: the propagation
 * sweep orients each equation in MODEL order, and a check written above the
 * definition (`e == 1.0 [h]`) otherwise fixed the feature the definition says
 * is 3544.62 s. Nor when `u` states a value the solver lane cannot read: a
 * check never stands in for a definition that is refused. A feature whose
 * stated value expression binds it is fixed by that equation alone (`states`).
 */
function mayOrient(eq: Equation, u: ElementId, defined: ReadonlySet<ElementId>): boolean {
  return !defined.has(u) || (eq.defines?.includes(u) ?? false) || eq.states === u;
}

/** Distinct still-unknown, non-fixed feature ids appearing in the equations. */
function remainingUnknowns(
  eqs: Equation[],
  values: Map<ElementId, number>,
  fixedIds: Set<ElementId>,
): ElementId[] {
  const out: ElementId[] = [];
  const seen = new Set<ElementId>();
  for (const eq of eqs) {
    for (const v of eq.vars) {
      if (values.has(v) || fixedIds.has(v) || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Largest ABSOLUTE residual across fully-determined equations (for the reported
 * `residual` field), whether all equations are determined, and whether every
 * one is within tolerance judged PER-EQUATION-RELATIVELY (finding M6). A
 * large-magnitude equation like `x·x = 1e16` cannot drive its absolute residual
 * below `1e-6` (machine epsilon at that scale is ~1), yet is fully solved; we
 * gate convergence on `|residual| ≤ gate · scale`, where `scale` is that one
 * equation's own side magnitude — so a large equation is judged leniently
 * without loosening the gate for a small equation beside it.
 */
function residualSummary(
  eqs: Equation[],
  values: Map<ElementId, number>,
  tol: number,
): { residual: number; determined: boolean; withinTol: boolean } {
  let residual = 0;
  let determined = true;
  let withinTol = true;
  // Absolute gate (unchanged for normal-scale equations) PLUS a per-equation
  // relative term at the floating-point noise floor for large-magnitude
  // equations. The relative term only exceeds the absolute floor once
  // `scale > 1e6`, so every normal-scale system keeps its exact prior behaviour;
  // and being pinned to the noise floor (not `1e-6·scale`) it does NOT accept a
  // genuinely-violated constraint whose residual merely looks small beside a
  // huge additive offset (finding M6 follow-up).
  for (const eq of eqs) {
    if (eq.vars.some((v) => !values.has(v))) {
      determined = false;
      continue;
    }
    const r = residualOf(eq, values);
    if (r === undefined) {
      determined = false;
      continue;
    }
    residual = Math.max(residual, Math.abs(r));
    if (Math.abs(r) > convergenceGate(eq, values, tol) || !nearRoot(eq, values, r)) withinTol = false;
  }
  return { residual, determined, withinTol };
}

/**
 * The residual a relation must get under to count as solved.
 *
 * For a relation in raw magnitudes this is the historical `max(tol, 1e-6)` plus
 * the per-equation noise floor. For a SCALED relation both ABSOLUTE terms are
 * dropped and the gate is purely relative to the equation's own SI magnitude:
 * once the residual is an SI quantity, "1e-6" — or the caller's 1e-9 — is a
 * metre-or-second-sized absolute number that means nothing in particular. It
 * made `5 [ns] == 3 [ns]` (residual 2e-9 s) VACUOUSLY converge while the
 * unit-aware verdict called it violated; and at the other end it declared a
 * millisecond-scale system converged at a residual four orders of magnitude
 * ABOVE what the unit-aware evaluator's own relative tolerance accepts, so the
 * header said "converged" and the row said "violated" on the same model. A
 * relative gate answers both, and is what the inner Newton/bisection loops are
 * now driven to (see {@link acceptanceOf}).
 */
function convergenceGate(eq: Equation, values: Map<ElementId, number>, tol: number): number {
  const floor = RESIDUAL_FLOOR * equationScale(eq, values);
  return eq.scale ? floor : Math.max(Math.max(tol, 1e-6), floor);
}

/**
 * The residual a relation must get under to HOLD at a witness ({@link
 * solveFeasible}): its {@link convergenceGate}, but no wider than the
 * rounding its own evaluation can make there ({@link roundingOf}). The
 * convergence gate takes its scale from the largest SUBEXPRESSION, the measure
 * where large terms cancel (`x * x - 1e16`); in a quotient the large term is a
 * denominator, and `x / (1.0 + x * x) == 0.6 + y` at x = −1e22 had a gate of
 * 1e30: the search drifted along the plateau there, missed the equation by
 * 0.3, and a model no point satisfies was reported a verified feasible one.
 */
function witnessGate(eq: Equation, values: Map<ElementId, number>, feasTol: number): number {
  const gate = convergenceGate(eq, values, feasTol);
  const scope = idScope(eq, values);
  const l = roundingOf(eq.lhs, scope);
  const r = roundingOf(eq.rhs, scope);
  if (l === undefined || r === undefined) return gate;
  // Generous: a sixty-fourfold margin over the bound, so a residual the solve
  // drives to its own floor is never read as a miss.
  const noise = 64 * (l.err + r.err + Number.EPSILON * Math.abs(l.value - r.value));
  return Math.min(gate, eq.scale ? noise : Math.max(feasTol, 1e-6, noise));
}

/**
 * How far, as a fraction of the size of the values it reads, a point may be from a root of an equation to first order (|residual| over
 * the length of the slope) for a residual under the gate to be that root's ({@link nearRoot}).
 */
const ROOT_DISTANCE = 1e-8;

/**
 * Is the residual `r` of `eq` at `values`, under the gate the caller judges it by, a root's? Only where the equation is steep enough
 * there: a flat one is under the gate a long way from its root (`1.0 / x == 0.000001` at 999773: 2e-10, the root 227 away), and one
 * that tends to its asymptote where it has none (`2.0 ^ x == 0.0` at −31, `6.0 / (x + 1.0) == 0.0` at 3e21) is small on a plateau.
 * The distance to a root to first order, |r| over the length of the slope in what the equation reads, is held to {@link ROOT_DISTANCE}
 * of the size of those values. A residual within the rounding of its own evaluation is a root, and so is one of 0 unless the
 * equation holds a quotient or a power and nothing moves it (a plateau: `2.0 ^ x` underflows to 0 at −1100). A slope that cannot be
 * read (a pole a step away) leaves the verdict to the gate.
 */
function nearRoot(eq: Equation, values: Map<ElementId, number>, r: number): boolean {
  const plateau = quotientOrPower(eq);
  if (r === 0 && !plateau) return true;
  const scope = idScope(eq, values);
  const l = roundingOf(eq.lhs, scope);
  const q = roundingOf(eq.rhs, scope);
  if (r !== 0 && l !== undefined && q !== undefined && Math.abs(r) <= 64 * (l.err + q.err + Number.EPSILON * Math.abs(l.value - q.value))) {
    return true;
  }
  const at = (move: (v: ElementId, x: number) => number): number | undefined => {
    const moved = eq.vars.map((v) => [v, values.get(v)] as const);
    try {
      for (const [v, x] of moved) if (x !== undefined && Number.isFinite(x)) values.set(v, move(v, x));
      return residualOf(eq, values);
    } finally {
      for (const [v, x] of moved) if (x !== undefined) values.set(v, x);
    }
  };
  const step = (x: number): number => 1e-6 * (Math.abs(x) + 1);
  let slope = 0;
  let size = 0;
  for (const v of eq.vars) {
    const x = values.get(v);
    if (x === undefined || !Number.isFinite(x)) continue;
    size = Math.max(size, Math.abs(x));
    const rh = at((u, y) => (u === v ? y + step(y) : y));
    if (rh === undefined) return true;
    slope += ((rh - r) / step(x)) ** 2;
  }
  if (r === 0) {
    // No one feature moves it; nor do all together (`x * y / z == 0.0` at x = y = 0 is a root, and moved together they leave 0).
    const all = at((_, y) => y + step(y));
    return slope > 0 || all === undefined || all !== 0;
  }
  return Math.abs(r) / Math.sqrt(slope) <= ROOT_DISTANCE * (eq.scale ? size : size + 1);
}

const QUOTIENT_OR_POWER = new WeakMap<Equation, boolean>();
/** Does `eq` hold a quotient or a power, the shapes that go flat towards an asymptote? */
function quotientOrPower(eq: Equation): boolean {
  let out = QUOTIENT_OR_POWER.get(eq);
  if (out === undefined) {
    out = false;
    forEachOp(eq.lhs, (n) => (out = out || n.op === '/' || n.op === '^'));
    forEachOp(eq.rhs, (n) => (out = out || n.op === '/' || n.op === '^'));
    QUOTIENT_OR_POWER.set(eq, out);
  }
  return out;
}

function forEachOp(node: ExprNode, f: (n: Extract<ExprNode, { kind: 'binary' }>) => void): void {
  switch (node.kind) {
    case 'binary':
      f(node);
      forEachOp(node.left, f);
      forEachOp(node.right, f);
      break;
    case 'unary':
      forEachOp(node.operand, f);
      break;
    case 'if':
      forEachOp(node.cond, f);
      forEachOp(node.then, f);
      forEachOp(node.else, f);
      break;
    default:
  }
}

/**
 * Does `eq` divide, at `values`, by something within `gate` of 0? With `moved`, only by one that reads a feature in it: a witness the
 * search moved to a divisor that small is none, `x / y == 3.0` beside `y == 0.0` and `x == 0.0` was met at 1e-16 and 3e-16, a quotient
 * of rounding where 0/0 satisfies nothing; a literal or a stated divisor, however small, is the model's own scale. Without it, only
 * where the equation has no residual all the same (a divisor of exactly 0 beside a feature with no value: a guarded `if` that does not
 * divide is not one).
 */
function dividesByNearZero(eq: Equation, values: Map<ElementId, number>, gate: number, moved?: ReadonlySet<ElementId>): boolean {
  if (moved === undefined && residualOf(eq, values) !== undefined) return false;
  const scope = idScope(eq, values);
  const reads = (n: ExprNode): boolean =>
    n.kind === 'ref'
      ? moved!.has(eq.nameToId.get(n.path.join('.'))!)
      : n.kind === 'unary'
        ? reads(n.operand)
        : n.kind === 'binary'
          ? reads(n.left) || reads(n.right)
          : n.kind === 'if'
            ? reads(n.cond) || reads(n.then) || reads(n.else)
            : false;
  let near = false;
  const visit = (n: Extract<ExprNode, { kind: 'binary' }>): void => {
    if (near || n.op !== '/' || (moved !== undefined && !reads(n.right))) return;
    const d = evaluate(n.right, scope);
    if ('value' in d && typeof d.value === 'number' && Math.abs(d.value) <= gate) near = true;
  };
  forEachOp(eq.lhs, visit);
  forEachOp(eq.rhs, visit);
  return near;
}

/**
 * The value of `node` under `scope`, with a bound on the rounding error of
 * evaluating it in binary64 (a running error analysis: each operand's error
 * carried through the operation, plus the operation's own rounding); every
 * read value is taken as rounded once. `undefined` where no bound is read — a
 * `%`, a quotient whose divisor is within its own error of 0, a power of a
 * non-positive base, a non-number.
 */
function roundingOf(node: ExprNode, scope: (name: string) => unknown): { value: number; err: number } | undefined {
  const eps = Number.EPSILON;
  const leaf = (v: unknown): { value: number; err: number } | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? { value: v, err: eps * Math.abs(v) } : undefined;
  switch (node.kind) {
    case 'num':
      return leaf(node.value);
    case 'ref': {
      const r = evaluate(node, scope);
      return 'value' in r ? leaf(r.value) : undefined;
    }
    case 'unary': {
      if (node.op === 'not') return undefined;
      const a = roundingOf(node.operand, scope);
      return a && { value: node.op === '-' ? -a.value : a.value, err: a.err };
    }
    case 'if': {
      const c = evaluate(node.cond, scope);
      if (!('value' in c) || typeof c.value !== 'boolean') return undefined;
      return roundingOf(c.value ? node.then : node.else, scope);
    }
    case 'binary': {
      const a = roundingOf(node.left, scope);
      const b = roundingOf(node.right, scope);
      if (!a || !b) return undefined;
      let value: number;
      let err: number;
      switch (node.op) {
        case '+':
        case '-':
          value = node.op === '+' ? a.value + b.value : a.value - b.value;
          err = a.err + b.err;
          break;
        case '*':
          value = a.value * b.value;
          err = Math.abs(a.value) * b.err + Math.abs(b.value) * a.err + a.err * b.err;
          break;
        case '/':
          if (!(Math.abs(b.value) > b.err)) return undefined;
          value = a.value / b.value;
          err = (a.err + Math.abs(value) * b.err) / (Math.abs(b.value) - b.err);
          break;
        case '^':
          if (!(a.value > 0)) return undefined;
          value = a.value ** b.value;
          err = Math.abs(value) * (Math.abs(b.value) * (a.err / a.value) + Math.abs(Math.log(a.value)) * b.err);
          break;
        default:
          return undefined;
      }
      if (!Number.isFinite(value) || !Number.isFinite(err)) return undefined;
      return { value, err: err + eps * Math.abs(value) };
    }
    default:
      return undefined;
  }
}

/**
 * The characteristic magnitude of an equation under `values`, floored at 1 for
 * a relation in RAW magnitudes so those keep an absolute gate (making the
 * relative test a no-op there). Used to normalise the convergence residual
 * per-equation (M6).
 *
 * A SCALED equation is NOT floored at 1: its magnitudes are SI, so a
 * millisecond or nanometre system genuinely has a characteristic magnitude far
 * below 1, and flooring there is what turned a relative gate back into an
 * absolute one — accepting a root with a 1e-4 relative error as solved.
 *
 * It is the largest magnitude over ALL evaluated SUBEXPRESSIONS of both sides —
 * not just the two top-level sides — so it is FORM-INVARIANT: `x*x = 1e16` and
 * the algebraically identical `x*x - 1e16 = 0` both yield 1e16 (the latter's
 * sides collapse to ~0 at the root, but its `1e16`/`x*x` subterms do not). This
 * keeps the outer gate consistent with `solveScalar`'s `fScale` (probed away
 * from the root), which the naive max-of-sides did not (Fable D1).
 */
function equationScale(eq: Equation, values: Map<ElementId, number>): number {
  const s = magnitudeScale([eq.lhs, eq.rhs], idScope(eq, values), eq.scale ? 0 : 1);
  // Nothing determined (or an all-zero equation): fall back to the absolute
  // reading rather than a gate of exactly 0, which nothing could ever clear.
  return s > 0 ? s : 1;
}

/** {@link equationScale} over an arbitrary set of expression roots. */
function magnitudeScale(
  roots: ExprNode[],
  scope: (name: string) => unknown,
  floor = 1,
): number {
  let max = floor;
  const visit = (node: ExprNode): void => {
    const r = evaluate(node, scope);
    if ('value' in r && typeof r.value === 'number' && Number.isFinite(r.value)) {
      max = Math.max(max, Math.abs(r.value));
    }
    switch (node.kind) {
      case 'unary':
        visit(node.operand);
        break;
      case 'binary':
        visit(node.left);
        visit(node.right);
        break;
      case 'if':
        visit(node.cond);
        visit(node.then);
        visit(node.else);
        break;
    }
  };
  for (const root of roots) visit(root);
  return max;
}

/**
 * The tolerance an inequality's residual `g` is judged against.
 *
 * For a relation in raw magnitudes this is the historical absolute `feasTol`
 * (`max(tol, 1e-6)`). A SCALED relation gets the SAME tolerance made RELATIVE
 * to its own SI magnitude — `feasTol · scale`, not a noise floor. The
 * distinction matters in both directions: at nanosecond scale the absolute
 * 1e-6 accepts a violation a thousand times the model's own numbers, while at
 * second scale a noise-floor gate (1e-14, or even the caller's 1e-9) is far
 * tighter than the line searches that produce the values being judged — merely
 * giving an ordinary model units then flipped `solveFeasible`/`optimize` from
 * feasible to infeasible on a 4e-7 overshoot they had always tolerated.
 */
function inequalityGate(
  iq: Inequality,
  values: Map<ElementId, number>,
  feasTol: number,
): number {
  if (!iq.scale) return feasTol;
  const scope = namesScope(iq.nameToId, values, iq.scale);
  const scale = magnitudeScale([iq.expr], scope, 0);
  return scale > 0 ? feasTol * scale : feasTol;
}

/**
 * Does the residual `g` VIOLATE this ordering, at values the model does not
 * state — `true`, `false`, or `undefined` for a question the values cannot
 * answer? The one place that owns the rule, for every surface that publishes
 * a verdict about an inequality over SOLVED or SEARCHED values:
 * {@link checkConstraintsNumeric}'s scalar fallback, {@link collectViolations}
 * (so {@link solveFeasible}) and {@link optimize}'s feasibility check. An
 * inequality over values the model states, at the model's own point, is read
 * by none of them: its verdict is the validation surface's, decided by the
 * decimals written (the tie rule of ./exact — `mass < 25.0` at 25 kg is false
 * there, and `x <= 0.2999999` at 0.3 is false, where an absolute 1e-6 called
 * it feasible).
 *
 * A solved value is known to the solve's tolerance `gate` and no closer. A
 * non-strict ordering holds within it and is violated only past it (`g >
 * gate`), as `compareQ` reads the same values at that tolerance — the solve's
 * own claim. A STRICT one turns on the very difference the tolerance hides:
 * violated past it, holding short of it (`g < −gate`), and UNDECIDED within
 * it, never read either way — `x < 0.1` at a solved 0.0999999966…, which is
 * true, and `x < 0.1000005` at a solved 0.1, which the SMT engine proves, were
 * both violated when the band read the two sides as equal. `searched` is the
 * exception: a value the feasibility search MOVED toward a bound — itself or
 * through the equations it moved — approaches it and stands for the points
 * just inside, so both are judged `g > gate`, and a violation over what the
 * search moved is unresolved, never decided, anyway.
 */
function inequalityViolated(op: ComparisonOp, g: number, gate: number, searched: boolean): boolean | undefined {
  if (g > gate) return true;
  if (searched || (op !== '<' && op !== '>') || g < -gate) return false;
  return undefined;
}

/**
 * The validation surface's verdict on every inequality whose operands are ALL
 * values the model states, that the caller neither fixed nor moved, and that
 * stand where the model's own solve puts them — read once per run. For those
 * the feasibility flag cannot read its own residual: the verdict exists, and
 * a residual within the solver's tolerance of a bound the decimals miss (`x =
 * 0.3` against `x <= 0.2999999`) is a violation the flag would contradict.
 *
 * That verdict is one of the model's point. A value stated as an expression
 * over a feature the caller fixed or the search moved (`y = x * 2.0`, `x`
 * fixed to 1) stands elsewhere, and judged at the model's `x = 9.0` it made
 * `y <= 5.0` a violation at `y = 2`. So where the point is not the model's own
 * — `modelPoint` given, the plain solve's values — an operand must have the
 * same value at `point` as there, or the inequality is read at the point, by
 * its residual.
 */
function statedVerdicts(
  model: Model,
  ineqs: readonly Inequality[],
  held: (id: ElementId) => boolean,
  point: ReadonlyMap<ElementId, number>,
  modelPoint: ReadonlyMap<ElementId, number> | undefined,
  sweep: () => readonly ConstraintCheck[] = () => checkConstraints(model),
): Map<ElementId, ConstraintCheck['result']> {
  const out = new Map<ElementId, ConstraintCheck['result']>();
  const memo: DerivationMemo = new Map();
  const atModel = (v: ElementId): boolean => modelPoint === undefined || sharedValue(v, point, modelPoint);
  const stated = ineqs.filter((iq) =>
    iq.vars.every((v) => !held(v) && atModel(v) && statedByModel(model, v, memo)),
  );
  if (stated.length === 0) return out;
  const checks = checksByRow(sweep());
  for (const iq of stated) {
    const c = checks.get(iq.id);
    if (c) out.set(iq.id, c.result);
  }
  return out;
}

/**
 * Why a comparison over a solved value is undecided ({@link
 * inequalityViolated}): its sides lie within the solve's tolerance of one
 * another — the sentence `tieSentence` of ./exact says for a pair of sides,
 * said of the residual between them.
 */
function solvedTieSentence(residual: number, tol: number): string {
  return (
    `its two sides differ by ${Math.abs(residual)}, within the solve's tolerance (${tol}), and an operand ` +
    'is a value the solve produced, known only to that tolerance — the comparison turns on a difference ' +
    'the solve does not know, so it is undecided rather than read either way'
  );
}

/** Does `v` have a value at `point`, and the same one at `modelPoint`? */
function sharedValue(
  v: ElementId,
  point: ReadonlyMap<ElementId, number>,
  modelPoint: ReadonlyMap<ElementId, number>,
): boolean {
  const p = point.get(v);
  return p !== undefined && p === modelPoint.get(v);
}

/** Numeric-only view of {@link propagateValues}. */
function numericPropagation(model: Model): Map<ElementId, number> {
  const out = new Map<ElementId, number>();
  for (const [id, v] of propagateValues(model)) {
    if (typeof v === 'number' && Number.isFinite(v)) out.set(id, v);
  }
  return out;
}

/**
 * `read()` with the entries `keys` of `values` free to be overwritten, then
 * put back exactly as they were (absent stays absent): a probe that sets the
 * few keys it moves instead of cloning the whole map once per finite-difference
 * evaluation. The map is not retained, and an exception cannot leave it changed.
 */
function probing<T>(values: Map<ElementId, number>, keys: Iterable<ElementId>, read: () => T): T {
  const saved = new Map<ElementId, number | undefined>();
  for (const k of keys) if (!saved.has(k)) saved.set(k, values.get(k));
  try {
    return read();
  } finally {
    for (const [k, prev] of saved) {
      if (prev === undefined) values.delete(k);
      else values.set(k, prev);
    }
  }
}

/** The residual `lhs − rhs` of an equation under `values`, or undefined. */
function residualOf(eq: Equation, values: Map<ElementId, number>): number | undefined {
  const scope = idScope(eq, values);
  const l = evaluate(eq.lhs, scope);
  const r = evaluate(eq.rhs, scope);
  if ('unknown' in l || 'unknown' in r) return undefined;
  if (typeof l.value !== 'number' || typeof r.value !== 'number') return undefined;
  return l.value - r.value;
}

/** A name → value scope for an equation, reading `values` through `nameToId`. */
function idScope(eq: Equation, values: Map<ElementId, number>): (name: string) => unknown {
  return namesScope(eq.nameToId, values, eq.scale);
}

/**
 * Solve an equation for its single unknown `u`. Prefers direct orientation
 * (`u = rhs` / `lhs = u` when the other side is fully known); otherwise falls
 * back to a 1-D finite-difference Newton with a bisection safety net.
 */
function solveForSingle(
  eq: Equation,
  u: ElementId,
  values: Map<ElementId, number>,
  tol: number,
): number | undefined {
  const scopeNoU = idScope(eq, values); // u is absent from values ⇒ unknown
  // A scaled equation is READ in SI, so a value read straight off the other
  // side arrives in SI and must be converted back into `u`'s storage unit
  // before it is stored (5 km + 400 m = 5400 m, stored as 5.4 in a [km]
  // feature). The root-finding path needs no conversion: it probes `u` THROUGH
  // the scaled scope, so its answer is already in storage units.
  const s = eq.scale?.get(u);
  const toStorage = (si: number): number => (s ? (si - s.offset) / s.factor : si);

  if (isRefTo(eq.lhs, eq, u)) {
    const r = evaluate(eq.rhs, scopeNoU);
    if ('value' in r && typeof r.value === 'number') return toStorage(r.value);
  }
  if (isRefTo(eq.rhs, eq, u)) {
    const l = evaluate(eq.lhs, scopeNoU);
    if ('value' in l && typeof l.value === 'number') return toStorage(l.value);
  }
  return solveScalar(eq, u, values, tol);
}

/** Is `node` a bare reference resolving (via the equation's scope) to `u`? */
function isRefTo(node: ExprNode, eq: Equation, u: ElementId): boolean {
  return node.kind === 'ref' && eq.nameToId.get(node.path.join('.')) === u;
}

/** 1-D root-find of the equation residual in `u`: Newton then bisection. */
function solveScalar(
  eq: Equation,
  u: ElementId,
  values: Map<ElementId, number>,
  tol: number,
): number | undefined {
  const f = (t: number): number | undefined => {
    const prev = values.get(u);
    values.set(u, t);
    try {
      return residualOf(eq, values);
    } finally {
      if (prev === undefined) values.delete(u);
      else values.set(u, prev);
    }
  };

  // Per-equation residual scale (finding M6). The residual acceptance test was
  // ABSOLUTE (`|f| <= tol`), which a large-magnitude equation such as
  // `x*x = 1e6` can never reach near its root (there `|f| ≈ 2·x·δ`), so it only
  // ever terminated on the step test — losing accuracy. We accept on a residual
  // relative to THIS equation's own characteristic magnitude, probed at 0 and
  // the seed. Crucially the scale is PER-EQUATION (not the subsystem-wide max
  // that the reverted c8b9155 used and that stalled small unknowns beside a
  // large sibling), and it only LOOSENS acceptance for large equations — for a
  // unit-scale equation `fScale` is 1, so behaviour is byte-identical to before.
  const seed = values.get(u) ?? 1;
  const probeMag = (t: number): number => {
    const v = f(t);
    return v !== undefined && Number.isFinite(v) ? Math.abs(v) : 0;
  };
  // A SCALED equation is measured against its own SI magnitude, with no floor
  // of 1: a millisecond system's residuals live at 1e-6 and an absolute `tol`
  // of 1e-9 stops the iteration four decimal places short of the root — which
  // the unit-aware verdict (relative 1e-9) then calls violated. `equationScale`
  // is used rather than the probes at 0 and the seed because the seed of an
  // undetermined unknown is 1, which says nothing about a 1e-3-scale model.
  const scaled = eq.scale !== undefined;
  const fScale = scaled
    ? equationScale(eq, values)
    : Math.max(probeMag(0), probeMag(seed), 1);
  // Accept on residual once it reaches the equation's floating-point NOISE FLOOR
  // (~RESIDUAL_FLOOR·scale — a few thousand ULPs), never the far-looser tol·scale:
  // the latter would rubber-stamp an unsolved residual that merely looks small
  // beside a large side. For unit-scale equations this collapses to `|f| <= tol`,
  // exactly the original absolute test.
  const accept = (fv: number): boolean =>
    Math.abs(fv) <= (scaled ? RESIDUAL_FLOOR * fScale : Math.max(tol, RESIDUAL_FLOOR * fScale));
  // The step test, and the finite-difference probe, are likewise relative for a
  // scaled equation: `|t| + 1` and `1e-6·(|t| + 1)` are absolute constants that
  // swamp a nanometre-scale unknown entirely (probing 1e-6 m around a 1e-9 m
  // root measures the wrong derivative by a factor of 300).
  const stepGate = (t: number): number => (scaled ? tol * Math.abs(t) : tol * (Math.abs(t) + 1));
  const probeStep = (t: number): number =>
    1e-6 * (scaled ? Math.abs(t) || Math.abs(seed) || 1 : Math.abs(t) + 1);

  // One to one in `u` (an equation read as ONE function, {@link equationShape}): it has the one root whenever it has one, so a root
  // found anywhere is THE root, and the search below does not stop at the first thing that goes wrong on the way from the seed.
  const mono = equationShape(eq, (id) => id === u) === 'mono';

  // A one-to-one equation's Newton point must also meet the gate the CALLER judges the root against ({@link convergenceGate}, its scale
  // taken at the point): `accept` takes its scale at the seed, where an exponential can be huge (`10.0 ^ (2.0 * x + 8.0) == 1.0`
  // from x = 1 is 1e10, a floor of 1e-4 where the root's own gate is 1e-6), and a root stopped at 6.6e-6 read 'did not converge'.
  const settled = (t: number, fv: number): boolean => {
    if (!accept(fv)) return false;
    if (!mono) return true;
    const prev = values.get(u);
    values.set(u, t);
    try {
      return Math.abs(fv) <= convergenceGate(eq, values, tol);
    } finally {
      if (prev === undefined) values.delete(u);
      else values.set(u, prev);
    }
  };

  // Newton with finite-difference derivative.
  let t = seed;
  for (let i = 0; i < 60; i++) {
    const f0 = f(t);
    if (f0 === undefined) break;
    const done = settled(t, f0);
    if (done && !mono) return t;
    const h = probeStep(t);
    const f1 = f(t + h);
    if (f1 === undefined) break;
    const deriv = (f1 - f0) / h;
    // A one-to-one equation under the gate is a root only if the Newton step from there is itself under the step gate. A flat one is under
    // the gate far from its root (`1.0 / x == 0.000001` at 999773, residual 2e-10: the step is 227), and one that tends to its asymptote
    // is under it where it has none (`2.0 ^ x == 0.0` at −31: the step stays 1.44): on, to the root or to no root, never stopped there.
    if (done && Math.abs(deriv) >= 1e-14 && (f0 === 0 || Math.abs(f0 / deriv) <= stepGate(t))) return t;
    if (Math.abs(deriv) < 1e-14) break;
    const next = t - f0 / deriv;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - t) <= stepGate(t)) {
      // A step that small is a root only if the residual is falling for real: `6.0 - 3.0 / (x + 1.0) == 3.0` from x = 1 steps
      // beside the pole x = −1 (residual 1.5 -> 1.5e6) and the steps there are tiny, with the root at 0 not found; and
      // `1.0 / (x + 1.0) + 10.0 == 11.0` steps 9e-12 at the pole's flank, the residual 199999.2732 -> 199999.2731 (a finite-difference
      // slope that straddles the pole), so 'no larger' is not progress: it must be halved, or the point settled.
      const fn = mono ? f(next) : 0;
      if (fn === undefined || (!settled(next, fn) && Math.abs(fn) >= 0.5 * Math.abs(f0))) break;
      return next;
    }
    t = next;
  }

  // Bisection over an expanding bracket around 0.
  const bracketed = (): number | undefined => {
    let a = -1;
    let b = 1;
    let fa = f(a);
    let fb = f(b);
    for (let k = 0; k < 60 && !(fa !== undefined && fb !== undefined && fa * fb < 0); k++) {
      a *= 2;
      b *= 2;
      fa = f(a);
      fb = f(b);
    }
    if (fa === undefined || fb === undefined || fa * fb >= 0) return undefined;
    // A sign change closed on may be a POLE (`24.0 / (x - 4.0) == 3.0` over [-8, 8]), not a root: the residual there is far larger than
    // at the ends of the bracket it started from, where at a root it has fallen to the floor. Returned, the pole was the value of `x`
    // beside `y == 4.0` — and written after `x == 3.0 * y` that equation gave 12 first: a verdict that turned on the order of the text.
    return bisect(a, b, fa, Math.max(Math.abs(fa), Math.abs(fb)), mono);
  };
  // `tight`: close on the root to the last digit, not on the width `tol` and a residual under the floor. A sign change between two
  // samples of the one-to-one search is read for its ROOT, and a quotient's root beside its pole is steep (`1.0 / x == 100.0`,
  // residual 7e-6 at 1e-9 from x = 0.01): a point closed on at the width `tol` is rejected by the gate the caller judges it by, and a
  // flat one (`0.5 / (8.0 * x) == -0.0000000625`, slope 6e-14) is under the floor 1.6% away from its root, which was returned.
  const bisect = (a: number, b: number, fa: number, ends: number, tight = false): number | undefined => {
    for (let k = 0; k < 200; k++) {
      const m = (a + b) / 2;
      const fm = f(m);
      if (fm === undefined) return undefined;
      if (tight ? fm === 0 : accept(fm)) return m;
      if (tight ? m === a || m === b || (b - a) / 2 <= Math.abs(m) * 1e-16 : (b - a) / 2 <= (scaled ? stepGate(m) : tol)) {
        return Math.abs(fm) <= ends ? m : undefined;
      }
      if (fa * fm < 0) b = m;
      else {
        a = m;
        fa = fm;
      }
    }
    return (a + b) / 2;
  };
  const found = bracketed();
  if (found !== undefined || !mono) return found;

  // One to one, and Newton and the bracket around 0 both missed it: a root across a POLE from the seed (`6.0 - 3.0 / (x + 1.0) ==
  // 3.0`, root 0, pole −1) is on neither side the seed reaches, and the ends of every bracket around 0 have the sign of the
  // asymptote. Whether the model pins x first or not, it is the same root: the sign changes between samples at 0 and ±2^k are
  // each closed on, a pole among them rejected as above, and a sample the equation has no value at (the pole itself) splits the
  // samples into two runs, each side of it looked at apart. Only a sign change is a root: a sample whose residual is small
  // because the function tends to its asymptote there (`2.0 ^ x == 0.0` at −2^60) is none. No sign change, no root found: an
  // abstention, never a value.
  const xs = [0];
  for (let k = -40; k <= 60; k++) xs.push(2 ** k, -(2 ** k));
  xs.sort((p, q) => p - q);
  let prev: [number, number] | undefined;
  const closeOn = (a: number, fa: number, b: number, fb: number): number | undefined =>
    fa * fb < 0 ? bisect(a, b, fa, Math.min(Math.abs(fa), Math.abs(fb)), true) : undefined;
  const side = (x: number): number => 1e-6 * (Math.abs(x) + 1);
  for (const x of xs) {
    const v = f(x);
    if (v === undefined) {
      const lo = f(x - side(x));
      const root = prev !== undefined && lo !== undefined ? closeOn(prev[0], prev[1], x - side(x), lo) : undefined;
      if (root !== undefined) return root;
      const hi = f(x + side(x));
      prev = hi === undefined ? undefined : [x + side(x), hi];
      continue;
    }
    // A residual of exactly 0 is a root where it changes sign (the root at the sample), not where it is 0 on both sides.
    if (v === 0) {
      const lo = f(x - side(x));
      const hi = f(x + side(x));
      if (lo !== undefined && hi !== undefined && lo * hi < 0) return x;
    }
    const root = prev !== undefined ? closeOn(prev[0], prev[1], x, v) : undefined;
    if (root !== undefined) return root;
    prev = [x, v];
  }
  return undefined;
}

/**
 * Drive a coupled subsystem to a fixpoint with a bounded finite-difference
 * Newton step, solving the (possibly over-determined) linearised system by
 * least squares (regularised normal equations). Writes the found values back
 * and returns whether anything moved; `used` collects the equations the step
 * drove when it did.
 *
 * An equation with no finite residual where a step STARTS is left out of that
 * step ({@link newtonStep}), and only of that one: over a pole at the guess
 * (`y == 1.0 / (x - 1.0)` from x = 1) it has a residual once the step has
 * moved off it. Left out for good, it was never solved: the point reached
 * without it was published as determined, and the equation judged violated
 * although the system has a solution. While one has a residual where the last
 * step stopped, it is taken back in and the step run again.
 */
function newtonSolve(
  eqs: Equation[],
  unknowns: ElementId[],
  values: Map<ElementId, number>,
  fixedIds: Set<ElementId>,
  tol: number,
  maxIter: number,
  defined: ReadonlySet<ElementId> = new Set(),
  unreadable: ReadonlySet<ElementId> = new Set(),
  used?: Set<Equation>,
): boolean {
  let moved = false;
  for (let round = 0; round < 4; round++) {
    const step = newtonStep(eqs, unknowns, values, fixedIds, tol, maxIter, defined, unreadable, used);
    moved ||= step.moved;
    const waiting = step.left.some(
      (eq) => eq.vars.every((v) => values.has(v)) && Number.isFinite(residualOf(eq, values)),
    );
    if (!step.moved || !waiting) break;
  }
  return moved;
}

/**
 * One {@link newtonSolve} step: whether it moved anything, and the equations
 * it `left` out for having no finite residual where it started.
 */
function newtonStep(
  eqs: Equation[],
  unknowns: ElementId[],
  values: Map<ElementId, number>,
  fixedIds: Set<ElementId>,
  tol: number,
  maxIter: number,
  defined: ReadonlySet<ElementId> = new Set(),
  unreadable: ReadonlySet<ElementId> = new Set(),
  used?: Set<Equation>,
): { moved: boolean; left: Equation[] } {
  const unknownSet = new Set(unknowns);
  // Equations whose every variable is either known or one of our unknowns —
  // but not an equation that is no definition and reads an unknown the
  // definitions alone determine ({@link closedByDefinitions}): a plain
  // `constraint { mass == 130.0 }` beside the asserted loop `mass == dry +
  // fuel`, `fuel == mass * 0.2` (with `dry` stated) pulled the least-squares
  // step to mass 128.8, where every relation read violated. The definitions
  // solve the loop; the check is then judged against what they give. Where
  // they do NOT determine it — the loop reads a design freedom (`dry` with no
  // value), a chain from a free root, a redundant pair — the check is what
  // fixes it, and left out it was solved at an arbitrary least-squares point.
  // A stated value expression they determine is one of them, its own
  // equation the definition it is.
  const closed = closedByDefinitions(eqs, defined, (v) => values.has(v) && !unknownSet.has(v), values, unreadable, true);
  const x = unknowns.map((id) => values.get(id) ?? 1);
  // An equation with no finite residual at the starting point (one over a
  // part, a string, a Boolean's `== true`, a division by zero there) is no
  // equation this step can drive: kept in, it ended the step on its first
  // iteration and every unknown was written back at its guess of 1.
  const start = new Map(values);
  unknowns.forEach((id, i) => start.set(id, x[i]!));
  const eligible = eqs.filter(
    (eq) =>
      eq.vars.every((v) => values.has(v) || unknownSet.has(v)) &&
      ((eq.defines?.length ?? 0) > 0 ||
        (eq.states !== undefined && closed.has(eq.states)) ||
        !eq.vars.some((v) => unknownSet.has(v) && closed.has(v))),
  );
  const active: Equation[] = [];
  const left: Equation[] = [];
  for (const eq of eligible) (Number.isFinite(residualOf(eq, start)) ? active : left).push(eq);
  if (active.length === 0) return { moved: false, left };
  // An unknown no active equation reads is not moved by this step, and is not
  // given the guess either: a check that reads it may still fix it by
  // propagation (`mass + z == 130.0` beside a loop the definitions close).
  const driven = new Set<ElementId>();
  for (const eq of active) for (const v of eq.vars) if (unknownSet.has(v)) driven.add(v);

  let moved = false;
  if (unknowns.some((u) => u.includes('@'))) {
    // Instance variables: their definitions are substituted, not solved for.
    moved = substitutedNewton(active, unknowns.filter((u) => driven.has(u)), values, fixedIds, tol, maxIter);
  } else {
    const residuals = (xv: number[]): number[] | undefined =>
      probing(values, unknowns, () => {
        unknowns.forEach((id, i) => values.set(id, xv[i]!));
        const out: number[] = [];
        for (const eq of active) {
          const r = residualOf(eq, values);
          if (r === undefined) return undefined;
          out.push(r);
        }
        return out;
      });
    if (newtonCore(active, x, values, residuals, tol, maxIter).aborted) return { moved: false, left };
    // Only what an active equation drives is written back, and the step is
    // progress only when it MOVED something: "converged" without a move — the
    // unknowns already at a root — said progress to the outer loop, which then
    // ran the same step again until its iteration budget was spent.
    unknowns.forEach((id, i) => {
      if (fixedIds.has(id) || !driven.has(id) || !Number.isFinite(x[i])) return;
      const prev = values.get(id);
      if (prev === undefined || Math.abs(prev - x[i]) > 1e-15) moved = true;
      values.set(id, x[i]);
    });
  }
  if (moved && used) for (const eq of active) if (eq.vars.some((v) => driven.has(v))) used.add(eq);
  return { moved, left };
}

/**
 * The bounded least-squares Newton of {@link newtonStep}, over the unknowns
 * `x` (moved in place) and the residuals of `active` at them. `aborted` when a
 * probe or a step could not be read — nothing found is then written back.
 */
function newtonCore(
  active: readonly Equation[],
  x: number[],
  values: Map<ElementId, number>,
  residuals: (xv: number[]) => number[] | undefined,
  tol: number,
  maxIter: number,
): { aborted: boolean } {
  const n = x.length;
  // Per-equation residual acceptance scale (finding M6 — coupled-systems arm).
  // The scalar solver already scales to the equation's own magnitude; the
  // multi-dimensional Newton must do the same, or a large-magnitude equation
  // in the subsystem never clears the absolute `tol` gate.
  const eqScales = active.map((eq) => equationScale(eq, values));
  // A subsystem holding a SCALED equation is judged and stepped RELATIVE to its
  // own SI magnitudes, exactly as `solveScalar` is: an absolute `tol` of 1e-9
  // against a nanometre-scale system is a step larger than the answer, so the
  // first Newton step "converges" it four orders of magnitude away from the
  // root, and the finite-difference probe measures the wrong derivative.
  const anyScaled = active.some((eq) => eq.scale !== undefined);
  const accepts = (F: number[]): boolean =>
    F.every((fv, i) =>
      Math.abs(fv) <= (anyScaled ? RESIDUAL_FLOOR * eqScales[i] : Math.max(tol, RESIDUAL_FLOOR * eqScales[i])),
    );
  /** The magnitude the step test and the probe are relative to (1 when unscaled). */
  const xScale = (): number => {
    if (!anyScaled) return 1;
    let mx = 0;
    for (const v of x) mx = Math.max(mx, Math.abs(v));
    return mx || 1;
  };

  const budget = Math.min(maxIter, 100);
  let stepped = false;
  for (let iter = 0; iter < budget; iter++) {
    const F = residuals(x);
    if (!F) break;
    // Convergence: each equation within its own noise floor or the user's tol.
    if (accepts(F)) break;

    // Finite-difference Jacobian J[m][n].
    const m = F.length;
    const J: number[][] = F.map(() => new Array(n).fill(0));
    const probeBase = xScale();
    // Column scale: the magnitude each unknown is measured in. It is 1 for a
    // system in raw magnitudes (so the arithmetic below is unchanged there) and
    // the unknown's own size for a SCALED one, which is what makes the
    // linearised system dimensionless.
    const colScale = x.map((v) => (anyScaled ? Math.abs(v) || probeBase : 1));
    for (let j = 0; j < n; j++) {
      const h = 1e-6 * (anyScaled ? colScale[j] : Math.abs(x[j]) + 1);
      const xp = x.slice();
      xp[j] += h;
      const Fp = residuals(xp);
      if (!Fp) return { aborted: true };
      for (let i = 0; i < m; i++) J[i][j] = (Fp[i] - F[i]) / h;
    }

    // Row scale: each equation's own largest sensitivity. WHY both scalings:
    // a subsystem in SI mixes `x*x == k*y` (residual ~1e-17 m², gradient ~1e-7)
    // with `y == x + k` (residual ~1e-9 m, gradient 1), and the least-squares
    // step is then decided almost entirely by the second equation while the
    // regularisation λ swamps the first — the solve stalls 25× away from the
    // root and reports it as an answer. Equilibrating rows and columns makes
    // JᵀJ an O(1) matrix again, so λ is the tiny regularisation it is meant to
    // be. For an unscaled system every factor here is exactly 1.
    const rowScale = J.map((row) => {
      if (!anyScaled) return 1;
      let mx = 0;
      for (let j = 0; j < n; j++) mx = Math.max(mx, Math.abs(row[j] * colScale[j]));
      return mx > 0 ? mx : 1;
    });
    const Js = J.map((row, i) => row.map((v, j) => (v * colScale[j]) / rowScale[i]));
    const Fs = F.map((v, i) => v / rowScale[i]);

    // Normal equations: (JᵀJ + λI) Δ = −Jᵀ F.
    const JtJ: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const JtF: number[] = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += Js[i][a] * Js[i][b];
        JtJ[a][b] = s;
      }
      JtJ[a][a] += 1e-12; // tiny regularisation
      let s = 0;
      for (let i = 0; i < m; i++) s += Js[i][a] * Fs[i];
      JtF[a] = -s;
    }

    const delta = solveLinear(JtJ, JtF);
    if (!delta) break;
    let step = 0;
    for (let j = 0; j < n; j++) {
      const d = delta[j] * colScale[j];
      if (!Number.isFinite(d)) return { aborted: true };
      x[j] += d;
      step = Math.max(step, Math.abs(d));
      stepped = true;
    }
    if (step <= tol * xScale()) break;
  }

  // A point a step reached under the gate the caller judges it by ({@link convergenceGate}) is a root's only where the equations that go
  // flat towards an asymptote are steep enough there ({@link nearRoot}): `y == 2.0 ^ x` beside `y == 0.0` was met at x = −23 (residual
  // 1e-7, the step under `tol`) and written back as a root.
  if (stepped && active.some(quotientOrPower)) {
    const F = residuals(x);
    if (F?.every((fv, i) => Math.abs(fv) <= (anyScaled ? RESIDUAL_FLOOR * eqScales[i]! : Math.max(tol, 1e-6, RESIDUAL_FLOOR * eqScales[i]!)))) {
      const slope = F.map(() => 0);
      for (let j = 0; j < n; j++) {
        const h = 1e-6 * (anyScaled ? Math.abs(x[j]) || xScale() : Math.abs(x[j]) + 1);
        const xp = x.slice();
        xp[j] += h;
        const Fp = residuals(xp);
        if (!Fp) return { aborted: false };
        for (let i = 0; i < F.length; i++) slope[i] += ((Fp[i] - F[i]) / h) ** 2;
      }
      const size = anyScaled ? xScale() : xScale() + Math.max(0, ...x.map(Math.abs));
      const flat = F.some((fv, i) =>
        quotientOrPower(active[i]) && (fv === 0 ? slope[i] === 0 : Math.abs(fv) > ROOT_DISTANCE * size * Math.sqrt(slope[i])),
      );
      if (flat) return { aborted: true };
    }
  }

  return { aborted: false };
}

/**
 * {@link newtonStep} where INSTANCE variables are among the unknowns (one per
 * instance a relation reads through, ./defining-equation's
 * `DefiningEquations.instanceReadings`). An instance variable an equation
 * DEFINES — its value read in the instance, an asserted equation read there —
 * is computed from that definition, in dependency order, at every trial
 * point, and is no unknown of the Newton step; what is left is solved one
 * connected component at a time. One dense step over every instance value of
 * a deep instance tree (2124 unknowns for a depth-9 tree) took a minute; the
 * definitions alone determine those values once their free inputs are given.
 */
function substitutedNewton(
  active: readonly Equation[],
  unknowns: readonly ElementId[],
  values: Map<ElementId, number>,
  fixedIds: ReadonlySet<ElementId>,
  tol: number,
  maxIter: number,
): boolean {
  const unknownSet = new Set(unknowns);
  // The unknowns a single active equation defines or states the value of,
  // and the definitions they read of each other.
  const defining = new Map<ElementId, Equation>();
  for (const eq of active) {
    const u = eq.defines?.length === 1 ? eq.defines[0]! : eq.defines === undefined ? eq.states : undefined;
    if (u === undefined || !unknownSet.has(u) || fixedIds.has(u) || defining.has(u)) continue;
    defining.set(u, eq);
  }
  // Dependency order (Kahn): a definition after those it reads; one on a
  // loop stays an unknown, and its equation a residual.
  const readers = new Map<ElementId, ElementId[]>();
  const pending = new Map<ElementId, number>();
  for (const [u, eq] of defining) {
    const deps = new Set(eq.vars.filter((v) => v !== u && defining.has(v)));
    pending.set(u, deps.size);
    for (const v of deps) {
      const list = readers.get(v);
      if (list) list.push(u);
      else readers.set(v, [u]);
    }
  }
  const order: ElementId[] = [];
  const queue = [...defining.keys()].filter((u) => pending.get(u) === 0);
  while (queue.length > 0) {
    const u = queue.shift()!;
    order.push(u);
    for (const r of readers.get(u) ?? []) {
      const left = pending.get(r)! - 1;
      pending.set(r, left);
      if (left === 0) queue.push(r);
    }
  }
  const substituted = new Set(order);
  const definitions = new Set(order.map((u) => defining.get(u)!));
  const free = unknowns.filter((u) => !substituted.has(u));
  const residualEqs = active.filter((eq) => !definitions.has(eq));
  const substitute = (trial: Map<ElementId, number>, which: readonly ElementId[] = order): boolean => {
    for (const u of which) {
      trial.delete(u);
      const v = solveForSingle(defining.get(u)!, u, trial, tol);
      if (v === undefined || !Number.isFinite(v)) return false;
      trial.set(u, v);
    }
    return true;
  };

  // The free unknowns each substituted variable reads, through the
  // definitions it reads.
  const freeSet = new Set(free);
  const reads = new Map<ElementId, Set<ElementId>>();
  for (const u of order) {
    const out = new Set<ElementId>();
    for (const v of defining.get(u)!.vars) {
      if (v === u) continue;
      if (freeSet.has(v)) out.add(v);
      else for (const w of reads.get(v) ?? []) out.add(w);
    }
    reads.set(u, out);
  }
  const freeOf = (eq: Equation): Set<ElementId> => {
    const out = new Set<ElementId>();
    for (const v of eq.vars) {
      if (freeSet.has(v)) out.add(v);
      else for (const w of reads.get(v) ?? []) out.add(w);
    }
    return out;
  };
  // Connected components of the residual equations over the free unknowns.
  const parent = new Map<ElementId, ElementId>(free.map((u) => [u, u]));
  const find = (a: ElementId): ElementId => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (a !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  const touches = residualEqs.map(freeOf);
  for (const vs of touches) {
    const [first, ...rest] = [...vs];
    for (const v of rest) {
      const a = find(first!);
      const b = find(v);
      if (a !== b) parent.set(a, b);
    }
  }
  const components = new Map<ElementId, { vars: ElementId[]; eqs: Equation[] }>();
  residualEqs.forEach((eq, i) => {
    const first = touches[i]!.values().next().value;
    if (first === undefined) return;
    const root = find(first);
    let c = components.get(root);
    if (!c) {
      c = { vars: [], eqs: [] };
      components.set(root, c);
    }
    c.eqs.push(eq);
  });
  for (const u of free) components.get(find(u))?.vars.push(u);

  const x = new Map<ElementId, number>(free.map((u) => [u, values.get(u) ?? 1]));
  const scratch = new Map(values);
  const rank = new Map(order.map((u, i) => [u, i]));
  for (const c of components.values()) {
    // The substituted variables the component's equations read, through the
    // definitions they read, in dependency order.
    const needed = new Set<ElementId>();
    const stack = c.eqs.flatMap((eq) => eq.vars.filter((v) => substituted.has(v)));
    while (stack.length > 0) {
      const u = stack.pop()!;
      if (needed.has(u)) continue;
      needed.add(u);
      for (const v of defining.get(u)!.vars) if (v !== u && substituted.has(v) && !needed.has(v)) stack.push(v);
    }
    const which = [...needed].sort((a, b) => rank.get(a)! - rank.get(b)!);
    const xc = c.vars.map((u) => x.get(u)!);
    // `substitute` deletes and re-adds its keys, which would reorder `values`
    // itself, so the probes work on one copy of it (`values` is not written
    // until the loop is done) and put back what they touch.
    const residuals = (xv: number[]): number[] | undefined =>
      probing(scratch, [...x.keys(), ...which], () => {
        for (const [u, v] of x) scratch.set(u, v);
        c.vars.forEach((u, i) => scratch.set(u, xv[i]!));
        if (!substitute(scratch, which)) return undefined;
        const out: number[] = [];
        for (const eq of c.eqs) {
          const r = residualOf(eq, scratch);
          if (r === undefined) return undefined;
          out.push(r);
        }
        return out;
      });
    if (newtonCore(c.eqs, xc, values, residuals, tol, maxIter).aborted) return false;
    c.vars.forEach((u, i) => x.set(u, xc[i]!));
  }

  const trial = new Map(values);
  for (const [u, v] of x) trial.set(u, v);
  const solved = substitute(trial);
  let moved = false;
  const write = (id: ElementId, v: number | undefined): void => {
    if (fixedIds.has(id) || v === undefined || !Number.isFinite(v)) return;
    const prev = values.get(id);
    if (prev === undefined || Math.abs(prev - v) > 1e-15) moved = true;
    values.set(id, v);
  };
  for (const [u, v] of x) write(u, v);
  if (solved) for (const u of order) write(u, trial.get(u));
  // Progress only when something MOVED, as {@link newtonStep} reports it.
  return moved;
}

/**
 * The defined features (`defined`, {@link definedFeatures}) the DEFINITIONS
 * ALONE determine: those of a component of the definition equations — linked
 * by the variables they share that are not `given` — every variable of which
 * is defined, and whose definitions have a full-rank Jacobian in those
 * variables at `values` (1 where a variable has none). Those, and only those,
 * a plain check may not move: it is judged against what the definitions give.
 * A feature whose own value the solver lane cannot read (`unreadable`) is no
 * variable of a component: the model states it, so it is fixed there — read
 * or not — and a definition over it determines what it defines, valueless.
 *
 * A definition that stops on its own is no answer to which features it fixes.
 * Stopped for a free input — `dry` in `mass == fuel + dry` with no value, a
 * free capacity read through `battery.capacity`, an input a binding holds, a
 * chain past the nest cap from a free root — or redundant (`power == voltage *
 * current` beside `current == power / voltage`), the definitions leave a
 * design freedom, and a check (`mass == 130.0`) is what fixes it. Treated as
 * binding, the check was left out of the solve, the solve stopped at an
 * arbitrary least-squares point (mass 1.19, a 1.005 J battery), and a
 * satisfiable check was reported violated and a feasible design infeasible —
 * where the validation surface and the SMT engine claimed nothing.
 *
 * `withStated` returns the features of such a component whose STATED value
 * expression determines them as well (`y = x * 2.0` over an asserted `x`):
 * what a plain check may not orient either. Left out, `constraint { y == 7.0
 * }` fixed y at 7 beside the stated 6 — the solver published 7, the check
 * read 6, and `w == y + 1.0` over a valueless `w` imposed w = 8, so `w <=
 * 7.5` was violated where w = 7 meets it.
 */
function closedByDefinitions(
  eqs: readonly Equation[],
  defined: ReadonlySet<ElementId>,
  given: (v: ElementId) => boolean,
  values: ReadonlyMap<ElementId, number>,
  unreadable: ReadonlySet<ElementId> = new Set(),
  withStated = false,
): Set<ElementId> {
  const fixed = (v: ElementId): boolean => given(v) || unreadable.has(v);
  const parent = new Map<ElementId, ElementId>();
  const find = (a: ElementId): ElementId => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (a !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  // A feature's stated value determines it as a definition does, so its
  // equation joins the component, and the feature is no freedom in it — and
  // with `withStated` it is returned beside the definitions' features.
  const definitions = eqs.filter((eq) => (eq.defines?.length ?? 0) > 0 || eq.states !== undefined);
  const stated = new Set<ElementId>();
  for (const eq of definitions) if (eq.states !== undefined) stated.add(eq.states);
  const determined = (v: ElementId): boolean => defined.has(v) || stated.has(v);
  for (const eq of definitions) {
    const vs = eq.vars.filter((v) => !fixed(v));
    for (const v of vs) if (!parent.has(v)) parent.set(v, v);
    for (let i = 1; i < vs.length; i++) {
      const a = find(vs[0]!);
      const b = find(vs[i]!);
      if (a !== b) parent.set(a, b);
    }
  }
  const members = new Map<ElementId, ElementId[]>();
  for (const v of parent.keys()) {
    const root = find(v);
    const list = members.get(root);
    if (list) list.push(v);
    else members.set(root, [v]);
  }
  // Each definition's component, in `definitions` order: the one every
  // variable it does not fix is in (they were joined above), so the one of
  // its first — grouped in one pass, where filtering the definitions per
  // component was quadratic (1.9 of 3.5 s of a 600-binding solve).
  const ownOf = new Map<ElementId, Equation[]>();
  for (const eq of definitions) {
    const v = eq.vars.find((x) => !fixed(x));
    if (v === undefined) continue;
    const root = find(v);
    const list = ownOf.get(root);
    if (list) list.push(eq);
    else ownOf.set(root, [eq]);
  }
  const out = new Set<ElementId>();
  for (const [root, vars] of members) {
    if (!vars.every(determined)) continue;
    const own = ownOf.get(root) ?? [];
    if (!determines(own, vars, values)) continue;
    for (const v of vars) if (defined.has(v) || (withStated && stated.has(v))) out.add(v);
  }
  return out;
}

/** A relation's slope in one feature, and how its two one-sided slopes split. */
interface Slope {
  /** The central difference. */
  d: number;
  /** |forward − backward|. */
  split: number;
  /** The steeper of the two one-sided slopes. */
  steep: number;
}

/**
 * Does a relation JUMP inside the probe — split its one-sided slopes
 * ({@link JUMP_TOL}) in a feature whose slope is not negligible beside its
 * steepest? Judged per feature, against that feature's own slopes.
 */
function jumps(slopes: readonly Slope[]): boolean {
  const steepest = Math.max(0, ...slopes.map((s) => s.steep));
  return slopes.some((s) => s.steep > RANK_TOL * steepest && s.split > JUMP_TOL * s.steep);
}

/**
 * Do `eqs` determine `vars` — is their Jacobian in `vars` of full column rank
 * at `values` (1 for a variable with none)? A variable only one remaining
 * equation reads is solved by that equation last — its column has one entry —
 * so the pair is peeled off first, where that entry is not zero; a chain of
 * definitions peels away whole, and only a LOOP is left to measure. That core
 * is measured by central differences, each row scaled to its own largest
 * entry; a pivot below 1e-7 of that is no pivot. An equation that cannot be
 * evaluated there leaves the question undecided, and the definitions are then
 * taken to determine what they define, as before.
 *
 * A definition whose residual JUMPS inside the probe in one of the variables
 * ({@link JUMP_TOL}) determines nothing: stopped on an `if`'s or a `%`'s step,
 * its central difference is the step's height over the probe's width, a pivot
 * that fixes nothing — `b == a + (if a >= 1.0 then 0.0 else 1.0)` beside `a ==
 * b`, stopped at a = 1, bound `a` there, though every a past 1 solves both.
 */
function determines(eqs: readonly Equation[], vars: readonly ElementId[], values: ReadonlyMap<ElementId, number>): boolean {
  if (eqs.length < vars.length) return false;
  // The point holds what these equations read — the ids their expressions
  // reference — and `vars`: all a residual below ever looks up. A copy of
  // every value per component was quadratic in a model of many components.
  const point = new Map<ElementId, number>();
  const take = (id: ElementId): void => {
    if (values.has(id)) point.set(id, values.get(id)!);
  };
  for (const eq of eqs) {
    for (const id of relationVarsOf(eq.lhs, eq.nameToId)) take(id);
    for (const id of relationVarsOf(eq.rhs, eq.nameToId)) take(id);
  }
  for (const v of vars) take(v);
  for (const v of vars) if (!point.has(v)) point.set(v, 1);
  /**
   * ∂eq/∂v at the point, by central differences, with the gap between its two
   * one-sided slopes and the steeper of them; `undefined` where it cannot be
   * read.
   */
  const partial = (eq: Equation, v: ElementId): Slope | undefined => {
    const x = point.get(v)!;
    const h = 1e-6 * (Math.abs(x) + 1);
    const r0 = residualOf(eq, point);
    point.set(v, x + h);
    const a = residualOf(eq, point);
    point.set(v, x - h);
    const b = residualOf(eq, point);
    point.set(v, x);
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    const d = (a - b) / (2 * h);
    if (r0 === undefined || !Number.isFinite(r0)) return { d, split: 0, steep: Math.abs(d) };
    const forward = (a - r0) / h;
    const backward = (r0 - b) / h;
    return { d, split: Math.abs(forward - backward), steep: Math.max(Math.abs(forward), Math.abs(backward)) };
  };

  // Peel: a variable one remaining equation reads, with that equation.
  const rows = new Set<Equation>(eqs);
  const cols = new Set<ElementId>(vars);
  const readers = new Map<ElementId, Set<Equation>>();
  for (const v of vars) readers.set(v, new Set());
  for (const eq of eqs) for (const v of eq.vars) readers.get(v)?.add(eq);
  const queue = vars.filter((v) => readers.get(v)!.size === 1);
  while (queue.length > 0) {
    const v = queue.pop()!;
    if (!cols.has(v)) continue;
    const only = [...readers.get(v)!];
    if (only.length !== 1) continue;
    const eq = only[0]!;
    const d = partial(eq, v);
    if (d === undefined) return true;
    const own = eq.vars.filter((u) => cols.has(u)).map((u) => partial(eq, u));
    const scale = Math.max(...own.map((p) => Math.abs(p?.d ?? 0)));
    if (!(Math.abs(d.d) > 1e-7 * scale)) return false;
    if (jumps(own.filter((p): p is Slope => p !== undefined))) return false;
    rows.delete(eq);
    cols.delete(v);
    for (const u of eq.vars) {
      const r = readers.get(u);
      if (!r || !cols.has(u)) continue;
      r.delete(eq);
      if (r.size === 1) queue.push(u);
    }
  }
  if (cols.size === 0) return true;
  const core = [...cols];
  const left = [...rows];
  if (left.length < core.length) return false;

  // The loop left over: its Jacobian, row-scaled, and its rank.
  const J: number[][] = [];
  for (const eq of left) {
    const row: number[] = [];
    const slopes: Slope[] = [];
    for (const v of core) {
      const d = partial(eq, v);
      if (d === undefined) return true;
      row.push(d.d);
      slopes.push(d);
    }
    if (jumps(slopes)) return false;
    const mx = Math.max(...row.map(Math.abs));
    J.push(mx > 0 ? row.map((x) => x / mx) : row);
  }
  let rank = 0;
  for (let col = 0; col < core.length && rank < J.length; col++) {
    let pivot = rank;
    for (let r = rank + 1; r < J.length; r++) if (Math.abs(J[r]![col]!) > Math.abs(J[pivot]![col]!)) pivot = r;
    if (Math.abs(J[pivot]![col]!) <= 1e-7) continue;
    [J[rank], J[pivot]] = [J[pivot]!, J[rank]!];
    for (let r = rank + 1; r < J.length; r++) {
      const f = J[r]![col]! / J[rank]![col]!;
      for (let c = col; c < core.length; c++) J[r]![c]! -= f * J[rank]![c]!;
    }
    rank++;
  }
  return rank === core.length;
}

/** Dense linear solve `A x = b` by Gaussian elimination with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-15) return undefined;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x;
}

/**
 * The seed numeric value of a feature (a literal number/quantity), or undefined.
 * A caller seeding many features shares one `memo` across the calls, as every
 * derivation pass does: a value written `(expr) [unit]` is read through the
 * unit-aware evaluator ({@link liftedSeedOf}), and a fresh memo per feature
 * re-read the whole model once per feature.
 */
function numericSeedOf(model: Model, feat: ElementRecord, memo: DerivationMemo = new Map()): number | undefined {
  // A value that contradicts a binding it overrides is not the feature's: the
  // model states both, and the solve reads neither — so too one a binding
  // joins somewhere to another value written with `=` (A.5, d1plain).
  if (feat.attrs.value !== undefined && sharedDefinitions(model).contradiction(feat)) return undefined;
  if (statedAgainstBoundSomewhere(model, feat)) return undefined;
  // Nor is a `default` a binding overrides: the binding gives it its value
  // (per feature, or perchance a held redefinition falls through somewhere).
  if (defaultGivesWaySomewhere(model, feat)) return undefined;
  const raw = feat.attrs.value;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (s === '') return undefined;
  if (expressionValueUnitOf(feat) !== undefined) return liftedSeedOf(model, feat, s, memo);
  try {
    const r = evaluate(parseExpr(s), () => undefined);
    // A determined numeric literal (no references) is a seed; an expression is not.
    if ('value' in r && typeof r.value === 'number' && Number.isFinite(r.value)) return r.value;
    return undefined;
  } catch {
    // Parse failed because of a `[unit]` literal. A SELF-CONTAINED one such as
    // `= 2 * 3 [kg]` is a seed, not an equation — `assignmentEquation` hands it
    // back for exactly that reason — so it has to be read here or the feature
    // is unknown for ever (and every feature computed from it with it).
    const seed = loweredSeedOf(model, feat, s);
    if (seed !== undefined) return seed;
    // Anything else (`1500 [kg]` in the GUI's own storage unit, a bracket on a
    // non-literal) still goes through the quantity engine.
    const q = evaluateQuantity(model, feat.id);
    return q && Number.isFinite(q.magnitude) ? q.magnitude : undefined;
  }
}

/**
 * The seed of a SELF-CONTAINED value written `(expr) [unit]`: the number `expr`
 * in that unit, which is the feature's storage unit — the magnitude the
 * unit-aware evaluator gives it (`applyUnit` of ./units-eval) — and none where
 * that evaluator refuses it, as {@link assignmentEquation} refuses it. Read as
 * a stored literal with SI inside (`(6.0 [GiB] / 2.0 [GiB]) [GiB]` as 3 bit,
 * `(6.0 [km] / 2.0 [m]) [km]` as 3 km), it was not the value every other
 * surface reads.
 */
function liftedSeedOf(model: Model, feat: ElementRecord, raw: string, memo: DerivationMemo): number | undefined {
  const body = parseRelationBody(raw);
  if (!body || (body.hadUnit && !body.resolved)) return undefined;
  // An expression over other features is an equation, not a seed.
  if (!('value' in evaluate(substituteLiterals(body.node, body.literals), () => undefined))) return undefined;
  if (valueUnitRefusal(model, feat.id, memo) !== undefined) return undefined;
  const own = operandDerivation(model, feat.id, memo)?.derivation.q;
  return own !== undefined && Number.isFinite(own.magnitude) ? own.magnitude : undefined;
}

/**
 * The seed of a value expression whose `[unit]` literals fold to a number —
 * read in the feature's STORAGE unit, because that is the unit every solved
 * value is published in. `= 2 * 3 [t]` on a unit-less `MassValue` seeds 6000
 * (kilograms), and the same text on a feature declaring `[t]` seeds 6.
 */
function loweredSeedOf(model: Model, feat: ElementRecord, raw: string): number | undefined {
  const body = parseRelationBody(raw);
  if (!body || !body.hadUnit || !body.resolved) return undefined;
  const r = evaluate(substituteLiterals(body.node, body.literals), () => undefined);
  if (!('value' in r) || typeof r.value !== 'number' || !Number.isFinite(r.value)) return undefined;
  const facets = dimensionalFacets(model, feat.id);
  if (facets.unit === undefined) return r.value; // SI by convention
  const u = resolveUnit(facets.unit);
  if (!u) return undefined; // a unit nothing can convert — no confident seed
  return (r.value - (u.offsetSI ?? 0)) / u.factorToSI;
}

/* ─────────────────────────────── MoEs ────────────────────────────────── */

/** Case metaclasses whose owned measures are treated as MoEs. */
const CASE_KINDS = new Set([
  'AnalysisCaseUsage',
  'AnalysisCaseDefinition',
  'VerificationCaseUsage',
  'VerificationCaseDefinition',
]);

/** Names that heuristically mark a feature as a measure of effectiveness. */
const MOE_NAME_RE = /moe|measure|objective/i;

/**
 * Evaluate the model's measures of effectiveness against a {@link solve} of the
 * whole model.
 *
 * A feature is treated as a MoE when it is flagged `attrs.isMoe`, its name
 * contains `MoE`/`measure`/`objective`, it carries a `role` of `objective`, or it
 * is a value/parameter feature owned by an AnalysisCase/VerificationCase (the
 * documented return-parameter/objective heuristic). Each is read from the solved
 * values (falling back to its own literal/expression value), with its unit and
 * physical dimension where the quantity engine can derive them. A measure the
 * equations leave free ({@link SolveResult.free}) is `null`: the point the
 * solve stopped at along a freedom is no value of it. So is a value two asserted
 * equations give two values, or one tied to such a feature
 * ({@link readsContradictedDefinition}): the first equation written is no value
 * the model states, and it turned on the order of the text.
 */
export function evaluateMoEs(model: Model): MeasureResult[] {
  const solved = solve(model);
  const unitBlind = unitBlindIds(model);
  const out: MeasureResult[] = [];
  const seen = new Set<ElementId>();
  const seeds: DerivationMemo = new Map();

  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || seen.has(el.id)) continue;
    if (!isMoeFeature(model, el)) continue;
    seen.add(el.id);

    // A value two asserted equations give two values, or one tied to it, is read from no equation: not the solve's,
    // nor `evaluateFeatureValue`'s or `evaluateQuantity`'s, which derive the first one written. A value written
    // reads none, so its seed stands.
    const contradicted = readsContradictedDefinition(model, el.id);
    let value: number | undefined = contradicted ? undefined : solved.values.get(el.id);
    // WHERE the number came from decides whether it may be labelled: only the
    // solver reads a value unit-awarely. The fallbacks below are raw magnitudes.
    const fromSolver = value !== undefined;
    if (value === undefined) value = numericSeedOf(model, el, seeds);
    if (value === undefined && !contradicted) {
      const r = evaluateFeatureValue(model, el.id);
      if ('value' in r && typeof r.value === 'number' && Number.isFinite(r.value)) value = r.value;
    }

    const q = contradicted ? undefined : evaluateQuantity(model, el.id);
    const res: MeasureResult = {
      id: el.id,
      name: el.declaredName ?? '',
      value: value === undefined ? null : value,
    };
    // The value is in the feature's STORAGE unit — its declared unit, else the
    // coherent SI unit of its kind. The label must say which, or a solved
    // `5400` beside a silent label reads as 5400 kilometres.
    //
    // The coherent-SI FALLBACK is claimed only for a value the solver reached
    // unit-awarely, which is TWO conditions. A relation the gates refused to
    // scale is arithmetic over raw magnitudes — `totalMeasure == leg1 + leg2`
    // with `leg1` in an unknown unit yields 405, which is neither 405 metres
    // nor anything else — and stamping `m` on that number is the very
    // contradiction this label exists to remove; `unitBlindIds` catches those.
    // But a relation the gates REFUSE outright is dropped from the equation
    // set, which is also how it leaves that set's sight: the number then comes
    // from the seed/expression fallbacks below, in whatever unit the author
    // wrote, and a 20 °C magnitude was published as `20 [K]`. So a value the
    // solver did not itself produce is never labelled either.
    const facets = declaredFacetsOf(model, el.id);
    const dimension = q?.dimension ?? facets.unitDimension ?? facets.kindDimension;
    const inSI = !unitBlind.has(el.id) && (fromSolver || value === undefined);
    const unit =
      q?.unit ?? facets.unit ?? (dimension && inSI ? siSymbolOf(dimension) : undefined);
    if (unit) res.unit = unit;
    if (dimension) res.dimension = dimToString(dimension);
    out.push(res);
  }
  return out;
}

/**
 * Features whose solved magnitude is NOT in their storage unit: those a
 * relation the gates refused to scale can write to, where at least one variable
 * carries a dimension. Everything else — a seed, a converted binding, a scaled
 * relation, a purely dimensionless system — leaves values in storage units.
 *
 * It sees only relations that SURVIVED {@link gatherConstraints}: a relation
 * refused outright is dropped from that set, and the feature it would have
 * written is then filled by a fallback instead. {@link evaluateMoEs} covers
 * that half by labelling only values the solver itself produced — the two
 * conditions together, never this one alone.
 */
function unitBlindIds(model: Model): Set<ElementId> {
  const memo: DerivationMemo = new Map();
  const out = new Set<ElementId>();
  for (const eq of gatherConstraints(model)) {
    if (eq.scale) continue;
    const dimensioned = (id: ElementId): boolean => {
      const d = featureDimension(model, baseIdOf(id), memo);
      return d !== undefined && !dimEqual(d, DIMENSIONLESS);
    };
    if (!eq.vars.some(dimensioned)) continue;
    for (const id of eq.vars) out.add(id);
  }
  return out;
}

/** Does `el` qualify as a measure-of-effectiveness feature? */
function isMoeFeature(model: Model, el: ElementRecord): boolean {
  if (el.attrs.isMoe === true) return true;
  const role = typeof el.attrs.role === 'string' ? el.attrs.role : '';
  if (role === 'objective') return true;
  if (typeof el.declaredName === 'string' && MOE_NAME_RE.test(el.declaredName)) return true;

  // A value/parameter feature owned (directly or transitively) by an analysis /
  // verification case — the return-parameter / objective heuristic.
  if (!isUsage(el.eClass)) return false;
  const hasValue = el.attrs.value !== undefined;
  const isParam = el.attrs.direction !== undefined; // in/out/return parameter
  if (!hasValue && !isParam) return false;
  return model.ancestors(el.id).some((a) => CASE_KINDS.has(a.eClass));
}

/* ────────────────────────────── optimize ─────────────────────────────── */

/** The golden ratio conjugate, for golden-section search. */
const INV_PHI = (Math.sqrt(5) - 1) / 2;

/**
 * Gradient-free optimization of the objective feature `objectiveId` over the
 * bounded design variables `variableIds`.
 *
 * Coordinate descent: each sweep line-searches every variable within its bounds
 * with a golden-section minimiser, re-solving the whole constraint system
 * ({@link solve}, holding the trial variables fixed) at each evaluation and
 * reading the objective off the solved values. `sense: 'max'` maximises by
 * minimising the negated objective. Deterministic and bounded.
 */
export function optimize(
  model: Model,
  objectiveId: ElementId,
  variableIds: ElementId[],
  opts: OptimizeOptions = {},
): OptimizeResult {
  const sense: OptimizeSense = opts.sense ?? 'min';
  const maxIter = Math.max(1, opts.maxIter ?? 40);
  const tol = opts.tol ?? 1e-7;
  const sign = sense === 'max' ? -1 : 1;
  const bounds = normalizeBounds(opts.bounds);
  const ineqs = opts.constraints ? gatherInequalities(model) : [];

  const best = new Map<ElementId, number>();
  const seeds: DerivationMemo = new Map();
  for (const id of variableIds) {
    const [lo, hi] = bounds.get(id) ?? [0, 1];
    const seed = numericSeedOf(model, model.get(id) ?? ({ attrs: {} } as ElementRecord), seeds);
    best.set(id, seed !== undefined && seed >= lo && seed <= hi ? seed : (lo + hi) / 2);
  }

  /** Sign-adjusted objective + inequality penalty for an assignment. */
  const scoreOf = (assign: Map<ElementId, number>): number => {
    const core = solveCore(model, { fixed: assign });
    // An objective the solve stopped at without converging has no value at
    // this point — never the model's own, read in its place below.
    if (core.unsettled.has(objectiveId)) return Number.POSITIVE_INFINITY;
    const at = determinedValues(core);
    let v = at.get(objectiveId);
    if (v === undefined || !Number.isFinite(v)) {
      const r = evaluateFeatureValue(model, objectiveId);
      v = 'value' in r && typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : undefined;
    }
    if (v === undefined) return Number.POSITIVE_INFINITY;
    let penalty = 0;
    for (const iq of ineqs) {
      const g = inequalityResidual(iq, at);
      if (g !== undefined && g > 0) penalty += g * g;
    }
    return sign * v + INEQ_PENALTY_WEIGHT * penalty;
  };

  /** The score when `id` is set to `t` on top of `best`. */
  const scoreWith = (id: ElementId, t: number): number => {
    const assign = new Map(best);
    assign.set(id, t);
    return scoreOf(assign);
  };

  // A freedom the variables do not fix makes the objective — or a penalised
  // bound — a value of the point the solve stops at, not of the design: no
  // search over it means anything. `total == a + b` maximised over `a` alone
  // scored the `b` a least-squares step happened to leave.
  const probe = solveCore(model, { fixed: best });
  const loose = [...probe.free].some((id) => id === objectiveId || ineqs.some((iq) => iq.vars.includes(id)));
  if (loose) return { best, value: Number.NaN, sense, free: [...probe.free] };

  let bestScore = scoreOf(best);

  for (let sweep = 0; sweep < maxIter; sweep++) {
    let improved = false;
    for (const id of variableIds) {
      const [lo, hi] = bounds.get(id) ?? [0, 1];
      const { x, fx } = goldenMin((t) => scoreWith(id, t), lo, hi, tol);
      if (fx < bestScore - tol * (Math.abs(bestScore) + 1)) {
        best.set(id, x);
        bestScore = fx;
        improved = true;
      }
    }
    if (!improved) break;
  }

  const value = objectiveValue(model, objectiveId, best) ?? Number.NaN;
  const result: OptimizeResult = { best, value, sense };
  if (opts.constraints) {
    const fin = solveCore(model, { fixed: best });
    const at = determinedValues(fin);
    const feasTol = Math.max(tol, 1e-6);
    const moved = new Set(variableIds);
    // The model's own point: a value the optimum does not share with it is
    // one the search placed, itself or through the equations it moved.
    const own = plainPoint(model, {});
    const placed = (v: ElementId): boolean => moved.has(v) || !sharedValue(v, at, own);
    const stated = statedVerdicts(model, ineqs, (v) => moved.has(v), at, own);
    let violated = false;
    let unjudged = false;
    let readsFree = false;
    for (const iq of ineqs) {
      const g = inequalityResidual(iq, at);
      const verdict = stated.get(iq.id);
      // A bound over stated values is the validation surface's verdict: an
      // unknown there is a bound not judged.
      if (verdict !== undefined) {
        if (verdict === 'violated') violated = true;
        else if (verdict === 'unknown') unjudged = true;
      } else if (g === undefined) {
        // A bound with no value to be read at the optimum — over a feature the
        // equations leave free there, or one nothing gives a value — is not
        // judged, so no proof that it holds: two contradictory bounds over a
        // valueless `z` no equation reads read as a feasible optimum.
        unjudged = true;
        readsFree ||= iq.vars.some((v) => fin.free.has(v));
      } else {
        // A bound the search drove its point against — `y < 5.0` over `y = 2 *
        // x` as `x` is maximised — is met by the points just inside it.
        const v = inequalityViolated(iq.op, g, inequalityGate(iq, at, feasTol), iq.vars.some(placed));
        if (v === undefined) unjudged = true;
        else violated ||= v;
      }
    }
    if (violated || !unjudged) result.feasible = !violated;
    else if (readsFree) result.free = [...fin.free];
  }
  return result;
}

/** Penalty weight for inequality violations in constrained {@link optimize}. */
const INEQ_PENALTY_WEIGHT = 1e6;

/** Evaluate the objective feature under a fixed variable assignment. */
function objectiveValue(
  model: Model,
  objectiveId: ElementId,
  fixed: Map<ElementId, number>,
): number | undefined {
  const core = solveCore(model, { fixed });
  // One the solve stopped at without converging has none there.
  if (core.unsettled.has(objectiveId)) return undefined;
  const v = determinedValues(core).get(objectiveId);
  if (v !== undefined && Number.isFinite(v)) return v;
  // Objective not part of the solved system — evaluate its own value directly.
  const r = evaluateFeatureValue(model, objectiveId);
  if ('value' in r && typeof r.value === 'number' && Number.isFinite(r.value)) return r.value;
  return undefined;
}

/** Golden-section minimiser of a unimodal `f` on `[lo, hi]`. */
function goldenMin(
  f: (t: number) => number,
  lo: number,
  hi: number,
  tol: number,
): { x: number; fx: number } {
  let a = lo;
  let b = hi;
  if (b < a) [a, b] = [b, a];
  let c = b - INV_PHI * (b - a);
  let d = a + INV_PHI * (b - a);
  let fc = f(c);
  let fd = f(d);
  const eps = tol * (Math.abs(hi - lo) + 1);
  for (let i = 0; i < 100 && b - a > eps; i++) {
    if (fc <= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - INV_PHI * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + INV_PHI * (b - a);
      fd = f(d);
    }
  }
  const x = (a + b) / 2;
  // Compare the interior best against the endpoints (guards monotone objectives).
  const candidates: Array<[number, number]> = [
    [x, f(x)],
    [lo, f(lo)],
    [hi, f(hi)],
  ];
  candidates.sort((p, q) => p[1] - q[1]);
  return { x: candidates[0][0], fx: candidates[0][1] };
}

/** Normalise the bounds option to a `Map<id, [lo, hi]>`. */
function normalizeBounds(
  bounds: OptimizeOptions['bounds'],
): Map<ElementId, [number, number]> {
  if (!bounds) return new Map();
  if (bounds instanceof Map) return bounds;
  return new Map(Object.entries(bounds) as Array<[ElementId, [number, number]]>);
}

/* ─────────────────────────── feasibility ─────────────────────────────── */

/**
 * Find variable values satisfying the model's EQUALITIES ({@link gatherConstraints})
 * and INEQUALITIES ({@link gatherInequalities}).
 *
 * Seeds from a plain {@link solve}, then minimises the penalty objective
 * `Σ(equality residual)² + Σ max(0, gᵢ)²` over the *free* variables — the ones the
 * equalities do not already pin down — by gradient-free coordinate descent (a
 * convex 1-D line search per coordinate). Every value the plain solve
 * DETERMINES (not only seeds and single-unknown targets: a coupled pair as
 * well) is held at its solved value — where that solve stopped on its
 * equations — so a genuinely infeasible system reports the true violation
 * rather than splitting the difference. The point the descent stops at is
 * driven back onto the equalities it bent, and is a witness only where they,
 * and the model's own equations, hold there ({@link witnessGate}); the
 * constraints neither gatherer reads are judged there as the numeric surface
 * judges them ({@link checkConstraintsNumeric}).
 *
 * Reports each violated inequality's amount and whether all hold, and whether
 * that is an answer ({@link FeasibilityResult.decided}): a violation over the
 * freedoms where the search stopped is {@link FeasibilityResult.unresolved},
 * never a violation. Deterministic and bounded.
 */
export function solveFeasible(model: Model, opts: FeasibilityOptions = {}): FeasibilityResult {
  return feasibleFrom(model, opts, solveCore(model, opts));
}

/**
 * {@link solveFeasible} over the plain solve `base`. With `start`, the descent begins at those values of the freedoms rather
 * than at the plain solve's: the second attempt it makes when the first neither found a witness nor decided anything, over a
 * component of more than one root ({@link flatRoots}).
 */
function feasibleFrom(
  model: Model,
  opts: FeasibilityOptions,
  base: SolveCore,
  start?: ReadonlyMap<ElementId, number>,
): FeasibilityResult {
  const tol = opts.tol ?? 1e-9;
  const feasTol = Math.max(tol, 1e-6);
  const { eqs, unreadable, relationOf } = gatherSystem(model, opts.scopeId);
  const ineqs = gatherInequalities(model, opts.scopeId);

  const values = new Map(base.point);

  // Fixed overrides (held constant).
  const fixedIds = new Set<ElementId>();
  if (opts.fixed) {
    const entries = opts.fixed instanceof Map ? opts.fixed.entries() : Object.entries(opts.fixed);
    for (const [id, v] of entries) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        values.set(id, v);
        fixedIds.add(id);
      }
    }
  }

  // Literal-seeded variables (design inputs) are pinned.
  const seededIds = new Set<ElementId>();
  const seeds: DerivationMemo = new Map();
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (numericSeedOf(model, el, seeds) !== undefined) seededIds.add(el.id);
  }
  // The features the definitions alone determine, at the plain solve's values
  // ({@link closedByDefinitions}): held there. A defined feature they leave
  // open is a design freedom like any other.
  const designInput = (v: ElementId): boolean => seededIds.has(v) || fixedIds.has(v);
  const closed = closedByDefinitions(eqs, definedFeatures(eqs, unreadable), designInput, values, unreadable);
  const pinned = pinnedVariables(eqs, seededIds, fixedIds, unreadable, values, closed);
  // Every value the plain solve DETERMINED is held there: the equations fix
  // it, and moving it only bends them (a coupled pair moved off its solution
  // to meet a bound was reported feasible). The search moves the freedoms.
  // Only where that solve stopped ON its equations: Newton left off them
  // (diverged to x = −106760, two equations missed by 0.2) determined nothing,
  // and held there its point was reported infeasible against `x >= 0.0`, which
  // x = 2 meets with both.
  // Nor is a value it stopped at OFF an equation it solved ({@link
  // SolveCore.unsettled}), wherever the others lie: an instance's `load = L`
  // the solve could not read left q's p's m2 at 9 beside equations within
  // tolerance, and held there it decided `q.p.m2 <= 0.0` violated, where q's
  // L of 50 gives −40.
  // Nor one plain constraints that disagree gave it ({@link SolveCore.contested}), nor a root of equations that have more
  // than one ({@link SolveCore.curved}): `x * x == 4.0` held at 2 broke `x <= 0.0`, which −2 meets with it.
  const settled = (id: ElementId): boolean =>
    !base.free.has(id) && !base.unsettled.has(id) && !base.contested.has(id) && !base.curved.has(id);
  if (residualSummary(eqs, base.point, tol).withinTol) {
    for (const id of base.point.keys()) if (settled(id)) pinned.add(id);
  }
  // A value the equations leave FREE is never held, whatever single equation
  // pinned it: one stopped on an `if`'s step (`r == (if x >= 1.0 then 1.0
  // else 0.0)`, at x = 1) was held there, and `x >= 2.0` decided infeasible.
  // Nor one the solve did not settle, nor one it took from a check that another disagrees with, nor a root of many.
  for (const id of [...base.free, ...base.unsettled, ...base.contested.keys(), ...base.curved.keys()]) if (!fixedIds.has(id)) pinned.delete(id);

  // Free variables: everything in an equality/inequality the equalities don't
  // pin — but never a feature whose stated value the solver lane cannot read
  // ({@link gatherSystem}), nor one an asserted equation DEFINES that the
  // plain solve could not give a value (its definition loops through, or reads,
  // something nothing fixes): the model says what it is, it has no value to
  // move, and the relations over it have no residual. Freed, `e == a * 2.0`
  // over a string-valued `a` was moved to 7 to split `e == 9.0` and `e <= 5.0`.
  // One the definitions leave open (a loop over a design freedom) is free, and
  // so is one the equations leave free though its definitions read as closing
  // it — stopped on a step, or on a slope that cannot be read.
  const defined = new Set<ElementId>([...unreadable, ...givenWayDefaults(model, eqs, values)]);
  for (const id of closed) if (settled(id)) defined.add(id);
  const freeSet = new Set<ElementId>();
  for (const iq of ineqs) for (const v of iq.vars) if (!pinned.has(v) && !defined.has(v)) freeSet.add(v);
  for (const eq of eqs) for (const v of eq.vars) if (!pinned.has(v) && !defined.has(v)) freeSet.add(v);
  const freeVars = [...freeSet];
  for (const id of freeVars) if (!values.has(id)) values.set(id, 0);
  if (start !== undefined) for (const [id, v] of start) if (freeSet.has(id)) values.set(id, v);

  const sweeps = Math.max(1, opts.sweeps ?? opts.maxIter ?? 60);
  // The penalty is a sum of squared violations, so drive it below feasTol² to
  // guarantee every individual violation is under the (linear) feasibility
  // tolerance. Stall detection uses a RELATIVE reduction so a genuinely
  // infeasible plateau stops while a still-improving descent continues.
  const target = feasTol * feasTol;
  let iterations = 0;
  let prevP = penaltyOf(eqs, ineqs, values);
  const line = freeVars.length > 0 ? linePenalty(eqs, ineqs, values) : undefined;
  for (let s = 0; s < sweeps && line !== undefined; s++) {
    iterations++;
    line.refresh();
    for (const id of freeVars) {
      const c = values.get(id) ?? 0;
      const x = convexLineMin((t) => line.along(id, t), c, tol);
      values.set(id, x);
      line.settle(id);
    }
    const P = penaltyOf(eqs, ineqs, values);
    const improved = prevP - P;
    prevP = P;
    if (P <= target) break; // feasible to tolerance
    if (improved <= 1e-4 * P) break; // stalled (plateau / genuine infeasibility)
  }

  // The equalities are a penalty in the search, so the point it stops at
  // bends them: driven back onto them over the freedoms before anything is
  // judged, and a point that still misses one is no witness.
  const moved = new Set(freeVars);
  const touched = eqs.filter((eq) => eq.vars.some((v) => moved.has(v)));
  if (touched.length > 0) {
    const held = new Set<ElementId>([...values.keys()].filter((v) => !moved.has(v)));
    const reads = freeVars.filter((v) => touched.some((eq) => eq.vars.includes(v)));
    newtonSolve(touched, reads, values, held, tol, 200, definedFeatures(eqs, unreadable), unreadable);
  }
  const bent = touched.some((eq) => {
    const r = eq.vars.every((v) => values.has(v)) ? residualOf(eq, values) : undefined;
    return r === undefined || Math.abs(r) > witnessGate(eq, values, feasTol) || !nearRoot(eq, values, r) || dividesByNearZero(eq, values, feasTol, moved);
  });
  // The model's own equations — an asserted one, a binding, a feature's value
  // — and every plain one the solve took as a design equation hold at a
  // witness, whatever the search moved: two asserted values of one feature
  // (`a == 3.0`, `a == 5.0`), or `x * x == -4.0`, which no Newton step meets,
  // left the plain solve off them, and the point it stopped at was reported a
  // verified feasible one. A plain check the solve did not impose is judged,
  // not imposed: one the definitions contradict leaves feasibility to the
  // inequalities.
  const missed = eqs.some((eq) => {
    const rel = relationOf.get(eq);
    if (rel !== undefined && !isAsserted(rel) && !base.imposed.has(rel.id)) return false;
    if (!eq.vars.every((v) => values.has(v))) return false;
    const r = residualOf(eq, values);
    return r !== undefined && !(Math.abs(r) <= witnessGate(eq, values, feasTol) && nearRoot(eq, values, r) && !dividesByNearZero(eq, values, feasTol, moved));
  });
  // Nor is there one where an equation, plain or not, divides by 0 beside a feature the point has no value for (`x / y == 3.0` beside
  // `y == 0.0`), or reads one the equalities fix and the solve found no root for (`2.0 ^ x == 0.0`): held, with nothing to hold it at.
  const divides =
    eqs.some((eq) => dividesByNearZero(eq, values, 0)) || eqs.some((eq) => quotientOrPower(eq) && eq.vars.some((v) => pinned.has(v) && !values.has(v)));
  // Infeasibility is DECIDED only by a violation over values the equations
  // determine; one over a freedom the search did not resolve is a search that
  // stopped, not a design that cannot exist — listed apart, never as a violation.
  const overFreedom = (vars: readonly ElementId[]): boolean => vars.some((x) => moved.has(x));
  // An inequality over values the model states, none of them fixed or moved,
  // is the validation surface's verdict ({@link statedVerdicts}): one sweep of
  // it for the run, shared with the context rows below.
  let swept: ConstraintCheck[] | undefined;
  const sweep = (): ConstraintCheck[] => (swept ??= checkConstraints(model));
  // With values `fixed`, the point is not the model's own: that is the plain
  // solve's. (Without, a value the search does not move is the plain solve's.)
  const own = fixedIds.size > 0 ? plainPoint(model, opts) : undefined;
  const statedIneqs = statedVerdicts(model, ineqs, (v) => moved.has(v) || fixedIds.has(v), values, own, sweep);
  // The point as a solve of its own, for the numeric surface to read there.
  const atPoint = (): SolveCore => ({
    point: values,
    free: new Set(),
    unsettled: new Set(),
    given: new Set(values.keys()),
    relations: new Set(),
    imposed: new Set(),
    held: new Map(),
    contested: new Map(),
    rival: new Map(),
    curved: new Map(),
    converged: true,
    iterations,
    residual: 0,
  });
  // An inequality over a value the caller FIXED, that reads nothing the
  // search moved, is read at the point as the numeric surface reads it there
  // ({@link pointReading}): the fixed value and the literals the model states
  // are decimals, decided exactly. Its residual's band is the solve's
  // tolerance, and read by it, `x <= 0.99999999999` held at x fixed to 1.
  const verdicts = new Map(statedIneqs);
  const atFixed = new Set(
    ineqs
      .filter(
        (iq) =>
          !statedIneqs.has(iq.id) &&
          !overFreedom(iq.vars) &&
          iq.vars.some((v) => fixedIds.has(v)) &&
          model.get(iq.id) !== undefined,
      )
      .map((iq) => iq.id),
  );
  if (atFixed.size > 0) {
    for (const row of numericRows(model, atPoint(), feasTol, atFixed, own, fixedIds)) verdicts.set(row.id, row.result);
  }
  const collected = collectViolations(ineqs, values, feasTol, verdicts, (iq) => overFreedom(iq.vars));
  const varsOf = (v: ConstraintViolation): ElementId[] => ineqs.find((iq) => iq.id === v.id)?.vars ?? [];
  const violations = collected.violations.filter((v) => !overFreedom(varsOf(v)));
  const unresolved = collected.violations.filter((v) => overFreedom(varsOf(v)));
  // An inequality with no residual at the point is not judged there, nor is a
  // relation neither gatherer reads — a connective (`x >= 10.0 and x <= 5.0`),
  // a `!=`, an asserted equation or a bound refused for what it reads — unless
  // judged here, at the point, as the numeric surface judges it: violated over
  // a stated `x = 7.0`, it was reported feasible beside that surface's and the
  // validation surface's `violated`. Either left unjudged leaves the answer
  // open.
  let unjudged =
    collected.unjudged || ineqs.some((iq) => !verdicts.has(iq.id) && inequalityResidual(iq, values) === undefined);
  const others = unreadRelations(model, opts.scopeId, ineqs, relationOf);
  if (others.size > 0) {
    for (const row of numericRows(model, atPoint(), feasTol, others, own, fixedIds)) {
      if (row.result === 'unknown') unjudged = true;
      if (row.result !== 'violated') continue;
      const el = model.get(row.id)!;
      const body = parseRelationBody(String(el.attrs.expression));
      const vars = body ? relationVarsOf(body.node, relationKeys(model, el)) : [];
      // A connective or a `!=` has no residual: violated, by no amount.
      const amount = row.amount > 0 ? row.amount : Number.NaN;
      (overFreedom(vars) ? unresolved : violations).push({ id: row.id, name: row.name, amount });
    }
  }
  // A definition's constraint read in a context that breaks it, and a value
  // the model states twice ({@link contextRows}), are what the model states:
  // no freedom of the search repairs either. Violated, either decides
  // infeasibility, wherever the search stopped; unjudged, the answer is open.
  // But the first is judged by the validation surface at the values the model
  // STATES, and with any of them `fixed` to another it is a verdict of another
  // point, whichever it was: `y >= 10.0` of P read in a `p` whose x the caller
  // fixed to 10 was "violated" at p's stated 3, decided infeasible — and
  // "satisfied" at a stated 30 where the fixed 1 breaks it, decided feasible.
  // Unjudged there. Only a value stated twice conflicts at every point.
  const held = fixedIds.size > 0;
  let stated = false;
  for (const r of contextVerdicts(model, opts.scopeId, held, sweep())) {
    if (held && r.conflict === undefined) unjudged = true;
    else if (r.result === 'unknown') unjudged = true;
    else if (r.result === 'violated') {
      violations.push({ id: r.id, name: r.name, amount: Number.NaN });
      stated = true;
    }
  }
  const feasible = violations.length === 0 && unresolved.length === 0 && !bent && !missed && !divides;
  const decided = feasible ? !unjudged : (violations.length > 0 && !missed && !divides) || stated;
  // A descent is local, and the roots of an equation of more than one root are apart: begun at the one the plain solve took (x = 2 for
  // `c0 { x * x == 4.0 }` written above `c1 { x == -2.0 }`) it stalls beside the plain equation, and the model is feasible all the same.
  // Where it neither found a witness nor decided anything, it is made again from where the equations that are not curved put those
  // values ({@link flatRoots}): the same point in either order of the text for `x == -2.0` beside `x * x == 4.0`. A witness found there
  // is one all the same: every gate above is run again. Where those equations leave the values open the search is as local as before.
  if (start === undefined && !feasible && !decided) {
    const again = flatRoots(eqs, new Set(freeVars.filter((v) => base.curved.has(v))), base.point, tol, unreadable);
    if (again !== undefined) {
      const second = feasibleFrom(model, opts, base, again);
      if (second.feasible && second.decided) return second;
    }
  }
  return { values, feasible, violations, unresolved, iterations, decided, free: freeVars };
}

/**
 * Where the equations over `over` — the freedoms of a component of more than one root ({@link SolveCore.curved}) — that are NOT
 * curved in them put those values, the rest held at `point`: `x == -2.0` beside `x * x == 4.0`, `y == x + 1.0` beside it. The
 * values that differ from `point`, or `undefined` where there are none: no such equation, or the point it moves nothing.
 */
function flatRoots(
  eqs: readonly Equation[],
  over: ReadonlySet<ElementId>,
  point: ReadonlyMap<ElementId, number>,
  tol: number,
  unreadable: ReadonlySet<ElementId>,
): Map<ElementId, number> | undefined {
  if (over.size === 0) return undefined;
  const flat = eqs.filter((eq) => {
    const vs = eq.vars.filter((v) => over.has(v));
    return vs.length > 0 && !isCurved(eq, vs) && !(vs.length > 1 && isJointlyCurved(eq, vs));
  });
  const unknowns = [...over].filter((v) => flat.some((eq) => eq.vars.includes(v)));
  if (unknowns.length === 0) return undefined;
  const at = new Map(point);
  const held = new Set<ElementId>([...at.keys()].filter((v) => !unknowns.includes(v)));
  newtonSolve([...flat], unknowns, at, held, tol, 200, definedFeatures(eqs, unreadable), unreadable);
  const out = new Map<ElementId, number>();
  for (const v of unknowns) {
    const x = at.get(v);
    if (x !== undefined && Number.isFinite(x) && x !== point.get(v)) out.set(v, x);
  }
  return out.size > 0 ? out : undefined;
}

/**
 * The constraints in scope neither {@link gatherSystem} nor {@link
 * gatherInequalities} reads — a connective, a `!=`, an asserted equation or a
 * bound refused for what it reads — for {@link solveFeasible} to judge at its
 * point. A PLAIN equality left out of the equations is not among them: it is
 * a check feasibility does not answer, as one the definitions contradict is
 * not.
 */
function unreadRelations(
  model: Model,
  scopeId: ElementId | undefined,
  ineqs: readonly Inequality[],
  relationOf: ReadonlyMap<Equation, ElementRecord>,
): Set<ElementId> {
  const read = new Set<ElementId>(ineqs.map((iq) => iq.id));
  for (const el of relationOf.values()) read.add(el.id);
  const inScope = scopeFilter(model, scopeId);
  const out = new Set<ElementId>();
  for (const el of model.all()) {
    if (el.eClass !== 'ConstraintUsage' || el.attrs.isLibrary === true || read.has(el.id) || !inScope(el)) continue;
    const raw = el.attrs.expression;
    if (typeof raw !== 'string' || raw.trim() === '' || isNonNormativeStatement(model, el.id)) continue;
    const node = parseRelationBody(raw)?.node;
    if (!isAsserted(el) && node?.kind === 'binary' && (node.op === '==' || node.op === '=')) continue;
    out.add(el.id);
  }
  return out;
}

/**
 * The variables the equalities uniquely determine: seeds/fixed to start, every
 * feature an asserted definition defines that the plain solve gave a value
 * (`values`), then any equality with exactly one still-undetermined variable
 * pins that variable (mirroring {@link solve}'s single-unknown propagation, a
 * feature's definition included) to a fixpoint.
 */
function pinnedVariables(
  eqs: Equation[],
  seededIds: Set<ElementId>,
  fixedIds: Set<ElementId>,
  unreadable: ReadonlySet<ElementId> = new Set(),
  values: ReadonlyMap<ElementId, number> = new Map(),
  closed: ReadonlySet<ElementId> = new Set(),
): Set<ElementId> {
  const pinned = new Set<ElementId>([...seededIds, ...fixedIds]);
  // Only a binding definition keeps a check from pinning what it defines.
  const defined = new Set<ElementId>([...unreadable, ...closed]);
  // A feature an asserted definition DEFINES is determined by the equalities
  // even where no single one of them orients it — a loop the plain solve
  // closed as a system (`mass == dry + fuel`, `fuel == mass * 0.2`): held at
  // that value, so an infeasible bound reports its true violation rather than
  // a compromise with a plain check (`mass == 130.0`) that bent the definitions.
  // Only where the definitions alone determine it (`closed`): a loop over a
  // design freedom holds nothing at the point the plain solve stopped at.
  for (const eq of eqs) for (const id of eq.defines ?? []) if (values.has(id) && closed.has(id)) pinned.add(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const eq of eqs) {
      const free = eq.vars.filter((v) => !pinned.has(v));
      if (free.length === 1 && mayOrient(eq, free[0], defined)) {
        pinned.add(free[0]);
        changed = true;
      }
    }
  }
  return pinned;
}

/** The penalty `Σ(equality residual)² + Σ max(0, gᵢ)²` at `values`. */
function penaltyOf(
  eqs: Equation[],
  ineqs: Inequality[],
  values: Map<ElementId, number>,
): number {
  let p = 0;
  for (const eq of eqs) {
    const r = residualOf(eq, values);
    if (r !== undefined) p += r * r;
  }
  for (const iq of ineqs) {
    const g = inequalityResidual(iq, values);
    if (g !== undefined && g > 0) p += g * g;
  }
  return p;
}

/**
 * {@link penaltyOf} for a search that moves ONE variable at a time
 * ({@link solveFeasible}'s coordinate descent): `along(id, t)` sets `id` to
 * `t` in `values` and returns the penalty there, re-evaluating only the terms
 * that read `id` — found from the names their expressions reference, which
 * are all `evaluate` ever looks up — and `settle(id)` keeps the terms at the
 * value `id` was left at. Every other term is the one cached at the last
 * `refresh()` or `settle()`.
 *
 * The sum is folded in penaltyOf's own order (equations, then inequalities;
 * a term with no residual adds 0, which leaves a sum ≥ +0 unchanged), from the
 * cached partial sums up to the first term `id` changes: every value returned
 * is bit-identical to `penaltyOf(eqs, ineqs, values)` at the same point. One
 * re-evaluation of every term per call, as before, made a depth-8 instance
 * tree (375 equations, 565 freedoms) take 48 s; this one 0.3 s.
 *
 * It caches nothing beyond the search it serves: the terms live in the
 * returned closure and are read from `values` alone.
 */
function linePenalty(
  eqs: readonly Equation[],
  ineqs: readonly Inequality[],
  values: Map<ElementId, number>,
): { refresh: () => void; along: (id: ElementId, t: number) => number; settle: (id: ElementId) => void } {
  const nE = eqs.length;
  const n = nE + ineqs.length;
  const termAt = (k: number): number => {
    if (k < nE) {
      const r = residualOf(eqs[k]!, values);
      return r !== undefined ? r * r : 0;
    }
    const g = inequalityResidual(ineqs[k - nE]!, values);
    return g !== undefined && g > 0 ? g * g : 0;
  };
  // The terms each variable is read by, in ascending order.
  const readers = new Map<ElementId, number[]>();
  for (let k = 0; k < n; k++) {
    const ids =
      k < nE
        ? new Set([...relationVarsOf(eqs[k]!.lhs, eqs[k]!.nameToId), ...relationVarsOf(eqs[k]!.rhs, eqs[k]!.nameToId)])
        : relationVarsOf(ineqs[k - nE]!.expr, ineqs[k - nE]!.nameToId);
    for (const id of ids) {
      const list = readers.get(id);
      if (list) list.push(k);
      else readers.set(id, [k]);
    }
  }
  const terms = new Float64Array(n);
  // prefix[k] = terms[0] + … + terms[k], added left to right.
  const prefix = new Float64Array(n);
  const refold = (from: number): void => {
    let p = from > 0 ? prefix[from - 1]! : 0;
    for (let k = from; k < n; k++) {
      p += terms[k]!;
      prefix[k] = p;
    }
  };
  const NONE: number[] = [];
  return {
    refresh: () => {
      for (let k = 0; k < n; k++) terms[k] = termAt(k);
      refold(0);
    },
    along: (id, t) => {
      values.set(id, t);
      const ks = readers.get(id) ?? NONE;
      const first = ks.length > 0 ? ks[0]! : n;
      let p = first > 0 ? prefix[first - 1]! : 0;
      let i = 0;
      for (let k = first; k < n; k++) {
        if (i < ks.length && ks[i] === k) {
          p += termAt(k);
          i++;
        } else p += terms[k]!;
      }
      return p;
    },
    settle: (id) => {
      const ks = readers.get(id) ?? NONE;
      if (ks.length === 0) return;
      for (const k of ks) terms[k] = termAt(k);
      refold(ks[0]!);
    },
  };
}

/**
 * The violated inequalities at `values`, plus the largest violation amount —
 * and whether one went unjudged: undecided by the validation surface, or a
 * strict ordering within the tolerance of a solved value. `stated` is the
 * validation surface's verdict on the inequalities over values the model
 * states ({@link statedVerdicts}); `searched` says which the search moved.
 */
function collectViolations(
  ineqs: Inequality[],
  values: Map<ElementId, number>,
  feasTol: number,
  stated: ReadonlyMap<ElementId, ConstraintCheck['result']> = new Map(),
  searched: (iq: Inequality) => boolean = () => true,
): { violations: ConstraintViolation[]; maxViolation: number; feasible: boolean; unjudged: boolean } {
  const violations: ConstraintViolation[] = [];
  let maxViolation = 0;
  let feasible = true;
  let unjudged = false;
  for (const iq of ineqs) {
    const g = inequalityResidual(iq, values);
    const verdict = stated.get(iq.id);
    if (verdict !== undefined) {
      if (verdict === 'unknown') unjudged = true;
      if (verdict !== 'violated') continue;
      const amount = g === undefined ? Number.NaN : Math.max(0, g);
      if (amount > maxViolation) maxViolation = amount;
      violations.push({ id: iq.id, name: iq.name, amount });
      feasible = false;
      continue;
    }
    if (g === undefined) continue;
    const amount = Math.max(0, g);
    if (amount > maxViolation) maxViolation = amount;
    // A scaled inequality is judged against its own SI scale — the same 1e-6
    // made relative — not an absolute 1e-6 a nanosecond-scale system would
    // clear vacuously. A strict ordering within it is undecided unless the
    // search moved it there: see {@link inequalityViolated}.
    const violated = inequalityViolated(iq.op, g, inequalityGate(iq, values, feasTol), searched(iq));
    if (violated === undefined) unjudged = true;
    else if (violated) {
      violations.push({ id: iq.id, name: iq.name, amount });
      feasible = false;
    }
  }
  return { violations, maxViolation, feasible, unjudged };
}

/**
 * Minimise a convex 1-D function `f` around `c`. Expands a symmetric window
 * until it brackets the minimum (both endpoints ≥ the centre), then refines with
 * a golden-section search to absolute tolerance `tol`.
 */
function convexLineMin(f: (t: number) => number, c: number, tol: number): number {
  let w = Math.max(1, Math.abs(c) * 0.5);
  const fc = f(c);
  let lo = c - w;
  let hi = c + w;
  for (let k = 0; k < 60; k++) {
    lo = c - w;
    hi = c + w;
    if (fc <= f(lo) && fc <= f(hi)) break;
    w *= 2;
  }
  return goldenAbs(f, lo, hi, Math.max(tol, 1e-12));
}

/** Golden-section minimiser of `f` on `[lo, hi]` to absolute width `tol`. */
function goldenAbs(f: (t: number) => number, lo: number, hi: number, tol: number): number {
  let a = lo;
  let b = hi;
  let c = b - INV_PHI * (b - a);
  let d = a + INV_PHI * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 200 && b - a > tol; i++) {
    if (fc <= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - INV_PHI * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + INV_PHI * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

/* ─────────────────────── numeric constraint check ────────────────────── */

/**
 * Evaluate every model equality and inequality (ConstraintUsage / CalculationUsage
 * bodies) at the solved values and classify each as satisfied / violated / unknown
 * — the numeric counterpart of {@link checkConstraints} for the Check / Problems
 * surface. Equalities report the residual `lhs − rhs`; inequalities report the
 * slack `−g` and the violation amount `max(0, g)`.
 *
 * The VERDICT comes from the unit-aware evaluator first (as it does in
 * {@link checkConstraints}), so the two surfaces cannot answer the same model
 * differently; the numeric residual supplies the slack and the amount, and is
 * the verdict only where the unit-aware answer is ignorance rather than a
 * refusal. A relation neither engine can judge is reported `unknown` with the
 * reason — never omitted, because a constraint that silently disappears from
 * this list reads as one that holds.
 */
export function checkConstraintsNumeric(
  model: Model,
  opts: SolveOptions = {},
): NumericConstraintResult[] {
  const own = opts.fixed !== undefined ? plainPoint(model, opts) : undefined;
  const core = solveCore(model, opts);
  return numericRows(model, core, Math.max(opts.tol ?? 1e-9, 1e-6), undefined, own, fixedKeysOf(opts, core.point));
}

/** The keys a caller holds at a finite value ({@link SolveOptions.fixed}) — those the point has. */
function fixedKeysOf(opts: SolveOptions, point: ReadonlyMap<ElementId, number>): Set<ElementId> {
  const out = new Set<ElementId>();
  if (!opts.fixed) return out;
  const entries = opts.fixed instanceof Map ? opts.fixed.entries() : Object.entries(opts.fixed);
  for (const [id, v] of entries) if (typeof v === 'number' && Number.isFinite(v) && point.has(id)) out.add(id);
  return out;
}

/**
 * {@link checkConstraintsNumeric} at `core` — a solve, or a point that is none
 * ({@link solveFeasible}'s witness) — over `only` the relations asked about
 * when given. `modelPoint` is the model's own point (the plain solve's
 * values) when `core` holds some value fixed and so is not it, and `fixed`
 * the keys it holds there.
 */
function numericRows(
  model: Model,
  core: SolveCore,
  tol: number,
  only?: ReadonlySet<ElementId>,
  modelPoint?: ReadonlyMap<ElementId, number>,
  fixed: ReadonlySet<ElementId> = new Set(),
): NumericConstraintResult[] {
  // What the solve DETERMINED: a value along a design freedom is no value to
  // judge at — the unit-aware fallback and the residuals read only these.
  const values = determinedValues(core);
  const memo: DerivationMemo = new Map();
  const out: NumericConstraintResult[] = [];
  // At a point that is not the model's own, the features whose value there is
  // not the model's — held fixed, or moved by what is — by feature.
  const movedBases = new Set<ElementId>();
  if (modelPoint !== undefined) {
    for (const k of new Set([...values.keys(), ...modelPoint.keys()])) {
      if (!sharedValue(k, values, modelPoint)) movedBases.add(baseIdOf(k));
    }
    for (const k of fixed) movedBases.add(baseIdOf(k));
  }
  // The validation surface's own sentence for a relation, read once and only
  // when a row needs it: a relation over a name that surface reads no value
  // for is undecided here exactly where it is undecided there, and says why
  // in the same words.
  let swept: ConstraintCheck[] | undefined;
  const sweep = (): ConstraintCheck[] => (swept ??= checkConstraints(model));
  let checks: Map<ElementId, string> | undefined;
  const checkSentence = (id: ElementId): string | undefined => {
    checks ??= new Map(sweep().map((c) => [c.id, c.message.replace(/^Could not evaluate: /, '')]));
    return checks.get(id);
  };
  let verdicts: Map<ElementId, ConstraintCheck> | undefined;
  const checkVerdictOf = (id: ElementId): ConstraintCheck | undefined => {
    verdicts ??= new Map(sweep().map((c) => [c.id, c]));
    return verdicts.get(id);
  };
  // The relations a usage owns whose group F7 expands per instance: their own
  // row is the usage's generic reading, not the refusal (F1) the other
  // surfaces kept before F7.
  let ownedExpanded: Set<ElementId> | undefined;
  const ownedGroupExpanded = (el: ElementRecord): boolean => {
    if (ownedExpanded === undefined) {
      ownedExpanded = new Set();
      for (const g of instanceGroups(model)) {
        const rel = model.get(g.relationId);
        if (g.expanded && rel && g.usageId === rel.ownerId) ownedExpanded.add(g.relationId);
      }
    }
    return ownedExpanded.has(el.id);
  };

  for (const el of model.all()) {
    if (only && !only.has(el.id)) continue;
    if (el.attrs.isLibrary === true) continue;
    if (!RELATION_KINDS.has(el.eClass)) continue;
    // A `#prose` / `#prompt` relation has no verdict to report — the other
    // three surfaces are silent about it, and `analysisReport` lists every
    // `violated` row here as a warning in the same Problems panel.
    if (isNonNormativeStatement(model, el.id)) continue;
    const raw = el.attrs.expression;
    if (typeof raw !== 'string' || raw.trim() === '') continue;

    // Parse for SHAPE only — a `[unit]` literal is lowered so a body like
    // `mass <= 2000 [kg]` is recognised as the inequality it is instead of
    // throwing and vanishing from this list.
    //
    // A body the scalar parser cannot read, or whose shape carries no residual
    // (`a > 1.0 and b > 2.0`), still gets a ROW: the unit-aware evaluator reads
    // both, and a constraint that silently disappears from this list reads as
    // one that holds. Only the slack columns stay empty.
    const body = parseRelationBody(raw);
    const node = body?.node;
    const isIneq = node?.kind === 'binary' && isInequalityOp(node.op);
    const isEq = node?.kind === 'binary' && (node.op === '==' || node.op === '=');
    // `a != b` is judged as the NEGATION of `a == b` over the same operands:
    // the same gates, the same scale, the same residual and tolerance, so it
    // is violated exactly where that equality would hold. Without it a bare
    // literal the unit-aware evaluator leaves to the fallback (`limit :
    // MassValue = 25.0` against `limit != 25.0`) had no residual and was
    // `unknown` here, while the validation surface read it violated and the
    // SMT engine refuted it. It is checked at the solved values, never solved
    // for, and a calculation whose body is a `!=` stays out of the equation
    // set as it always was.
    const isNe = node?.kind === 'binary' && node.op === '!=';
    const isCalcBody =
      body !== undefined && el.eClass === 'CalculationUsage' && !!el.declaredName && !isNe;
    const scalar = isIneq || isEq || isCalcBody;

    const iq = isIneq ? relationInequality(model, el, memo) : undefined;
    const eq = isNe
      ? relationEquation(model, el, memo, true)
      : scalar && !isIneq
        ? relationEquation(model, el, memo)
        : undefined;
    const scale = iq?.scale ?? eq?.scale;

    // What the validation surface refuses in what the relation READS — an
    // operand whose derivation it refuses, a point on an offset scale in
    // arithmetic, a bare number against a derived dimension (gate (e)) — and
    // the names it reads no value for in this context. An author's relation is
    // asked all of it; a calculation's value body is asked what a feature's
    // value is, as `self = expr`. The gatherers left every refused relation
    // out, so it has no residual here.
    const calcValue = isCalcBody && !isEq && !isIneq;
    // Read, never changed — so the variables below are keyed over it rather
    // than over another copy of the same scope.
    const scope: ReadonlyMap<string, ElementId> = relationScope(model, el);
    const unread =
      body !== undefined ? unreadValuesOf(model, el, namesReadIn(body.node).filter((n) => !body.literals.has(n)), memo) : [];
    let read: ReturnType<typeof readRefusalOf>;
    if (body !== undefined && calcValue && el.declaredName) {
      const joined: ExprNode = { kind: 'binary', op: '==', left: { kind: 'ref', path: [el.declaredName] }, right: body.node };
      const own = new Map(scope).set(el.declaredName, el.id);
      const identity = body.node.kind === 'ref' && !body.hadUnit;
      read = readRefusalOf(model, el, joined, own, body.literals, memo, { operands: false, identity, unread });
    } else if (body !== undefined) {
      read = readRefusalOf(model, el, body.node, scope, body.literals, memo, { unread });
    }

    // The validation surface's scalar path reads exactly what the MODEL states;
    // a value only this solver determined it does not read at all. So a
    // relation over values the model states — a value, or an asserted
    // definition — is read here as that surface reads it: its ties decided by
    // the decimals written (the tie rule of ./exact), with no tolerance of the
    // solver's. A relation over a solved unknown keeps the solver's own
    // tolerance, within which an equality and a non-strict ordering hold — `x
    // * 3.0 == 0.3`, which fixed `x` at 0.09999999999999999, was read exactly
    // and reported violated by the very equation it was solved from — and a
    // strict ordering or a `!=` is undecided: the solve does not know which
    // side of the other its value lies on.
    //
    // The variables the solve gives values to: an instance's own where the
    // relation reads one through it.
    const keys = body !== undefined ? relationKeys(model, el, scope) : scope;
    const solvedNames = namesScope(keys, values);
    // Does every variable the relation reads stand where the model's own
    // solve puts it? Always, at that solve.
    const atModelPoint = (): boolean =>
      modelPoint === undefined ||
      (body !== undefined && relationVarsOf(body.node, keys).every((id) => sharedValue(id, values, modelPoint)));
    const solvedScope = solvedQuantityScope(model, el, values, memo, unread, body !== undefined ? keys : undefined);
    // Where one does not — the caller holds a value fixed, and the relation
    // reads it or a value stated through it — the relation is read at the
    // point, every name the point moved at the value it has there: read at
    // the model's own values, `y != 18.0` over `y = x * 2.0` was violated at x
    // fixed to 1, where y is 2, and that point decided infeasible
    // ({@link pointReading}).
    const at =
      modelPoint !== undefined && body !== undefined
        ? pointReading(model, el, body, keys, values, modelPoint, fixed, movedBases, solvedScope, memo)
        : undefined;
    const moved = at !== undefined && (at.bound || at.stale.length > 0);
    const stated =
      !moved && body !== undefined && relationVarsOf(body.node, scope).every((id) => statedByModel(model, id, memo));
    // Does the relation read a value the solve produced — known to its
    // tolerance only (decision 11), where a value the model states or the
    // caller fixes is read exactly?
    const searched = at !== undefined && moved ? at.produced : !stated;

    // The unit-aware evaluator judges FIRST, exactly as `checkConstraints`
    // does, with the solved values as a last-resort scope so a name only the
    // solver determined (an unknown driven by an equality) still resolves —
    // except a name the validation surface reads no value for here — and,
    // at a point that is not the model's own, as the scope every name the
    // point moved reads. Its absolute tolerance is the caller's only where
    // that number is meaningful — raw magnitudes of solved values. In SI,
    // "1e-6" is a metre-or-second-sized constant with no relation to the
    // model's scale, so a dimensional comparison is left to the evaluator's
    // own relative tolerance.
    const detailed = evaluateConstraintQuantityDetailed(model, el, {
      fallback: solvedScope,
      ...(at !== undefined && moved ? { bind: at.bind } : {}),
      absTol: scale || !searched ? 0 : tol,
      searched,
      memo,
    });

    const residual = isIneq
      ? iq
        ? inequalityResidual(iq, values)
        : undefined
      : eq
        ? residualOf(eq, values)
        : undefined;

    const row: NumericConstraintResult = {
      id: el.id,
      name: el.declaredName ?? '',
      raw,
      kind: isIneq ? 'inequality' : scalar ? 'equality' : 'boolean',
      result: 'unknown',
      slack: null,
      amount: 0,
    };
    if (iq) row.op = iq.op;
    // A body read by no surface (shadowedNamesOf): unknown, in the one sentence.
    const shadowed =
      body !== undefined ? shadowedNamesOf(model, el, namesReadIn(body.node).filter((n) => !body.literals.has(n))) : [];
    if (shadowed.length > 0) {
      row.reason = shadowedSentence(model, el, shadowed);
      out.push(row);
      continue;
    }
    // A relation written in a usage that stands for instances a binding above
    // it reads otherwise (usageOwnedRefusal): no verdict for any one of them,
    // in the sentence the other surfaces give — the solve reads the usage's
    // generic instance alone, and q's p, whose load the binding sets, breaks
    // what Q's own p meets. An expanded group (F7) reads the generic row here
    // and the instances in {@link contextRows}.
    const shared = ownedGroupExpanded(el) ? undefined : usageOwnedRefusal(model, el, relationNamesOf(raw));
    if (shared) {
      row.reason = shared;
      out.push(row);
      continue;
    }
    // A name read at the model's value where the point moved what it reads.
    if (at !== undefined && at.stale.length > 0) {
      row.reason = staleSentence(at.stale);
      out.push(row);
      continue;
    }

    // A `!=` reads its equality's residual for the verdict alone: the margin
    // by which two values differ is no slack a reader could act on.
    if (residual !== undefined && !isNe) {
      row.slack = isIneq ? -residual : residual;
      row.amount = isIneq ? Math.max(0, residual) : Math.abs(residual);
      const unit = scale ? slackUnitOf(model, detailed.dimension, iq ?? eq, memo) : undefined;
      if (unit) row.slackUnit = unit;
    }

    // A relation the validation surface refuses for what it reads is refused
    // here whatever the unit-aware evaluator made of it — that evaluator may
    // have decided an `and`/`or` without reading the refused operand, and
    // the validation surface refuses such a body whole, as the verification
    // engines must. A name it reads NO value for is different: the evaluator
    // here does not read it either (`solvedQuantityScope` leaves it out), so a
    // verdict it reached stands.
    // A connective (`and`, `or`, `not`, …) has no residual. Where the
    // unit-aware evaluator leaves it to the bare-literal contract — `not
    // (limit == 25.0)` over a kinded `limit = 25.0` — the validation surface
    // reads the whole body by its scalar fallback, in raw magnitudes, and so
    // does this one, over the solved values: it was `unknown` here while
    // that surface found it violated and both verification engines refuted
    // it. Only there: a body with a `[unit]` literal has no scalar reading on
    // either surface, and every other unknown stays the reason it is.
    // Where a relation over stated values is read here otherwise than by the
    // unit-aware evaluator's verdict — a tie it cannot decide over a value an
    // asserted definition fixes (this surface reads the solved number, the
    // validation surface the definition's exact derivation), a connective or
    // an ordering left to the bare-literal contract — the validation
    // surface's own verdict is this one: the same values, decided the same
    // way, and a tie it abstains on is one this surface abstains on. Where it
    // reads no verdict for another reason (a value it does not read, which
    // this surface solved), the solved values are read below at the solve's
    // tolerance. It is no relation of that surface's when it is a
    // calculation's. Nor is it this point's verdict where a value the
    // relation reads stands elsewhere than the model puts it — over a
    // feature held fixed, or one stated through it.
    const settledOf = (): ConstraintCheck | undefined => {
      const c = stated && !read && atModelPoint() ? checkVerdictOf(el.id) : undefined;
      return c && (c.result !== 'unknown' || c.tie === true || detailed.reason === 'tie') ? c : undefined;
    };
    const connective =
      stated &&
      !read &&
      body !== undefined &&
      !body.hadUnit &&
      !isIneq &&
      !scalar &&
      !isNe &&
      detailed.reason === 'dimension';
    const contract =
      connective && settledOf() === undefined
        ? evaluateDecided(body.node, (name) => (unread.includes(name) ? undefined : solvedNames(name)), undefined, {
            absTol: tol,
            searched: true,
          })
        : undefined;
    // The features this relation reads that the equations leave free.
    const readsFree =
      body !== undefined
        ? (iq?.vars ?? eq?.vars ?? relationVarsOf(body.node, keys)).filter((id) => core.free.has(id))
        : [];
    // And those it stopped at without converging ({@link SolveCore.unsettled}).
    const readsUnsettled =
      body !== undefined && core.unsettled.size > 0
        ? (iq?.vars ?? eq?.vars ?? relationVarsOf(body.node, keys)).filter((id) => core.unsettled.has(id))
        : [];
    // Those an assert holds in a form the solve does not read, and those plain
    // constraints that disagree gave a value ({@link SolveCore.held}, {@link SolveCore.contested}).
    const readsHeld =
      body !== undefined && core.held.size > 0
        ? (iq?.vars ?? eq?.vars ?? relationVarsOf(body.node, keys)).filter((id) => core.held.has(id) && !core.point.has(id))
        : [];
    const readsContested =
      body !== undefined && core.contested.size > 0
        ? (iq?.vars ?? eq?.vars ?? relationVarsOf(body.node, keys)).filter((id) => core.contested.has(id))
        : [];
    // And a relation the solve gathers no equation from (an inequality, a conjunction, a `!=`) over a value whose
    // equations have more than one root: the root the solve took is not the only one it holds at.
    const readsCurved =
      body !== undefined && core.curved.size > 0 && !core.relations.has(el.id)
        ? (iq?.vars ?? eq?.vars ?? relationVarsOf(body.node, keys)).filter((id) => core.curved.has(id) && !core.contested.has(id))
        : [];
    // A value no equation of the solve may give — an assert holds it in a form the solve does not read — or one plain
    // constraints that disagree gave it, whichever the solve took first, or one whose equations have more than one
    // root: no point the solve reached answers a relation over it.
    const withhold = (): void => {
      row.slack = null;
      row.amount = 0;
      delete row.slackUnit;
      if (readsHeld.length > 0) {
        row.reason = heldSentence(model, readsHeld, readsHeld.flatMap((id) => core.held.get(id) ?? []));
        return;
      }
      // One sentence for the strongest cause among the values it reads, with only the equations of those.
      const kindOf = (id: ElementId): 'model' | 'plain' | undefined => core.rival.get(id) ?? (core.curved.has(id) ? 'model' : undefined);
      const ids = [...readsContested, ...readsCurved];
      const kind = ids.some((id) => kindOf(id) === 'model') ? 'model' : ids.some((id) => kindOf(id) === 'plain') ? 'plain' : undefined;
      const of = ids.filter((id) => kindOf(id) === kind);
      row.reason =
        kind === 'model'
          ? rootsSentence(model, of, of.flatMap((id) => core.curved.get(id) ?? []))
          : contestedSentence(model, of, of.flatMap((id) => core.contested.get(id) ?? []), kind === 'plain');
    };
    if (readsCurved.length > 0 && !read && !isRefusalReason(detailed.reason)) {
      // The solved value is one of the roots the equations leave: the unit-aware verdict at it is not asked.
      withhold();
    } else if (
      detailed.verdict === 'violated' &&
      !read &&
      scale &&
      searched &&
      isEq &&
      eq !== undefined &&
      residual !== undefined &&
      core.relations.has(el.id) &&
      Math.abs(residual) <= convergenceGate(eq, values, tol) &&
      nearRoot(eq, values, residual)
    ) {
      // A root the solve met to its tolerance, read by the unit-aware compare with no tolerance of its own (absTol 0 in a model with
      // quantities): `x / k == 0.0` at the 1.2e-32 the solve took is exact-unequal to 0, a rounding and no violation. Not judged.
      row.slack = null;
      row.amount = 0;
      delete row.slackUnit;
      row.reason = `the solve took this equation to its tolerance (residual ${residual.toExponential(1)}), and the exact comparison at a solved value cannot tell a rounding from a violation`;
    } else if (detailed.verdict !== 'unknown' && !read) {
      row.result = detailed.verdict;
      if (row.result === 'satisfied') row.amount = 0;
    } else if (
      (detailed.reason === 'tie' ||
        connective ||
        ((residual !== undefined ||
          (iq?.vars ?? []).some((v) => String(v).includes('@'))) &&
          !isRefusalReason(detailed.reason))) &&
      settledOf() !== undefined
    ) {
      const settled = settledOf()!;
      row.result = settled.result;
      if (row.result !== 'violated') row.amount = 0;
      if (row.result === 'unknown') {
        row.slack = null;
        delete row.slackUnit;
        row.reason = settled.message.replace(/^Could not evaluate: /, '');
      }
    } else if (readsUnsettled.length > 0 && !read && !isRefusalReason(detailed.reason)) {
      // A value the solve stopped at without converging is no solution: a
      // relation over it is not judged there — violated at x = −106760, `x
      // >= 0.0` was reported broken where x = 2 meets every equation.
      row.slack = null;
      row.amount = 0;
      delete row.slackUnit;
      row.reason = unsettledSentence(model, readsUnsettled);
    } else if ((readsHeld.length > 0 || readsContested.length > 0) && !read && !isRefusalReason(detailed.reason)) {
      withhold();
    } else if (contract && 'value' in contract && typeof contract.value === 'boolean') {
      row.result = contract.value ? 'satisfied' : 'violated';
    } else if (contract && 'tie' in contract && contract.tie !== undefined) {
      // A comparison in it the solved values cannot decide.
      row.reason = tieSentence(contract.tie);
    } else if (
      readsFree.length > 0 &&
      !read &&
      !isRefusalReason(detailed.reason) &&
      !(calcValue && isParameterisedCalculation(model, el))
    ) {
      // An equation of the solve's own holds at EVERY point of the freedom
      // when it holds at the one the solve stopped at — the freedom is a
      // direction that moves none of them; nothing else read over a free
      // feature is decided by that point.
      // A check that reads what an assert holds was no equation of the solve's ({@link heldByUnreadAsserts}).
      const ownEquation =
        core.relations.has(el.id) &&
        !(el.eClass === 'ConstraintUsage' && !isAsserted(el) && (eq?.vars ?? []).some((v) => core.held.has(v)));
      const atPoint = eq && !isNe && (isEq || isCalcBody) && ownEquation ? residualOf(eq, core.point) : undefined;
      if (atPoint !== undefined && Math.abs(atPoint) <= convergenceGate(eq!, core.point, tol) && nearRoot(eq!, core.point, atPoint)) {
        row.result = 'satisfied';
        row.slack = atPoint;
        row.amount = 0;
      } else {
        row.result = 'unknown';
        row.slack = null;
        row.amount = 0;
        delete row.slackUnit;
        row.reason = freedomSentence(model, readsFree);
      }
    } else if (residual === undefined || read || isRefusalReason(detailed.reason)) {
      // A refusal (an offset scale, a dimension-mismatched derivation, a
      // clash of two different dimensions) is a REASONED unknown: falling back
      // to the raw magnitudes here would answer the very question the
      // unit-aware engine declined, and confidently. For a clash there is not
      // even a residual worth reading — gate (c) declines to SCALE such a
      // relation, so `5 [km] >= 3000 [s]` residuals as 5 − 3000, a subtraction
      // of unrelated magnitudes. Everything not in the refusal set (a name out
      // of scope, an unparseable body, a bare literal beside a dimensioned
      // value — the `dimension` reason) is ignorance the scalar path may still
      // answer, which is what keeps the declared-unit contract intact — unless
      // the validation surface refuses what the relation reads, which the row
      // then says in that surface's own sentence, asked after the unit-aware
      // refusals, as it is asked there.
      row.result = 'unknown';
      row.slack = null;
      row.amount = 0;
      delete row.slackUnit;
      // An operand refused where the validation surface BINDS it — a feature
      // an asserted equation defines — is refused there before the unit-aware
      // evaluator runs; every other refusal of what the relation reads is met
      // after the unit-aware refusals. A verdict that turned on a name that
      // surface reads no value for is undecided in its words.
      const own = read?.byDefinition || !isRefusalReason(detailed.reason);
      // A value a binding past a cap holds, which nothing stated fixes ({@link
      // pastCapUnreadable}): the validation surface's sentence names the cap.
      const capped =
        body !== undefined &&
        hasPastCapBindings(model) &&
        relationVarsOf(body.node, keys).some((id) => !values.has(id) && pastCapEnd(model, baseIdOf(id)));
      // A calculation with a parameter states no value to judge its body against.
      const reason =
        calcValue && isParameterisedCalculation(model, el)
          ? `${el.declaredName} has a parameter, so its body is the value of a call over arguments and no value of its own`
          : own
            ? (read?.detail ??
              (unread.length > 0 || capped ? (checkSentence(el.id) ?? detailed.detail) : detailed.detail))
            : detailed.detail;
      if (reason) row.reason = reason;
    } else {
      // The scalar fallback over SOLVED values, in raw magnitudes, where the
      // unit-aware evaluator returned ignorance rather than an answer or a
      // refusal (a relation over stated values took the validation surface's
      // verdict above, where it has one). The solve's own tolerance reads it,
      // by the tie rule {@link inequalityViolated} owns for every surface that
      // publishes an inequality verdict: within it an equality and a
      // non-strict ordering hold, and a strict ordering or a `!=`, which turn
      // on the difference the tolerance hides, are undecided. A calculation's
      // value body is read the same way: its residual is the solver's own
      // round trip, not a question the validation surface asks.
      //
      // At a point that moved the relation's names, over values the caller
      // fixed and the model states alone, there is no solve's tolerance to
      // read them by: the decimals decide, as the validation surface decides
      // them, and a tie they cannot is undecided.
      const exactly =
        at !== undefined && moved && !searched && body !== undefined
          ? evaluateDecided(body.node, solvedNames, at.exact)
          : undefined;
      const violated =
        exactly !== undefined
          ? 'value' in exactly && typeof exactly.value === 'boolean'
            ? !exactly.value
            : undefined
          : isIneq && iq !== undefined
            ? inequalityViolated(iq.op, residual, tol, false)
            : isIneq
              ? residual > tol
              : isNe
                ? Math.abs(residual) <= tol
                  ? undefined
                  : false
                : Math.abs(residual) > tol;
      if (violated === undefined) {
        row.slack = null;
        row.amount = 0;
        delete row.slackUnit;
        row.reason =
          exactly === undefined
            ? solvedTieSentence(residual, tol)
            : 'tie' in exactly && exactly.tie !== undefined
              ? tieSentence(exactly.tie)
              : (detailed.detail ?? solvedTieSentence(residual, tol));
      } else {
        row.result = violated ? 'violated' : 'satisfied';
        if (!violated) row.amount = 0;
      }
    }
    // A PLAIN constraint the solve took as a design equation holds because
    // the solve made it hold: said so, for a `satisfied` that is no check.
    if (row.result === 'satisfied' && core.imposed.has(el.id)) {
      row.imposed = true;
      row.reason = imposedSentence(model, (eq?.vars ?? []).filter((id) => !core.given.has(id)));
    }
    out.push(row);
  }
  // The rows that are no relation written in one place, for the whole sweep
  // only. A definition's relation read in a context is the validation
  // surface's verdict at the values the model STATES: at a point holding one
  // fixed to another it is a verdict of another point — P's `load <= 10.0`
  // read in a `p` whose load is fixed to 5 was violated at p's stated 50 — and
  // is not judged here, as {@link solveFeasible} leaves it unjudged. A value
  // the model states twice conflicts at every point.
  if (!only) {
    for (const r of contextRows(model, sweep())) {
      if (modelPoint !== undefined && r.conflict === undefined && r.result !== 'unknown') {
        r.result = 'unknown';
        r.amount = 0;
        r.reason =
          'read in its context at the values the model states, and this point holds a value fixed to another, ' +
          'so that verdict is not this point\'s';
      }
      out.push(r);
    }
  }
  // A part-valued binding no end of which stands for the other may carry a
  // value (equatedPartsRefusal): no row that may read one is judged, as the
  // validation surface judges none. A row already unknown keeps its sentence, unless that sentence only
  // says a name it reads has no value in scope: a partner of an unread valued part has none because the
  // binding carries one this tool does not read, which is the cause the other surfaces name.
  for (const r of out) {
    const unresolved =
      r.result === 'unknown' && r.cause === undefined && r.context === undefined && isUnresolvedSentence(r.reason ?? '');
    if (r.conflict !== undefined || (r.result === 'unknown' && !unresolved)) continue;
    const equated = equatedPartsRefusal(model, r.context?.baseId ?? r.id, r.raw, r.context);
    if (equated === undefined) continue;
    // Only where the validation surface names the binding itself: a typo, or a feature declared without a
    // value, read through the equated part is the user's defect there and stays so here.
    if (unresolved && checkSentence(r.id) !== equated) continue;
    r.result = 'unknown';
    r.slack = null;
    r.amount = 0;
    r.reason = equated;
    delete r.cause;
  }
  // A relation over a name that two defaults a binding joins leave valueless (GA6's Q's `L == 5.0`): the row is as
  // unknown as it was, but says what the validation surface says — the binding, and that its defaults differ —
  // where "L has no value in scope" named neither.
  for (const r of out) {
    if (
      r.conflict !== undefined || r.result !== 'unknown' || r.cause !== undefined || r.context !== undefined ||
      !isUnresolvedSentence(r.reason ?? '')
    ) continue;
    const said = checkVerdictOf(r.id)?.result === 'unknown' ? checkSentence(r.id) : undefined;
    if (said !== undefined && said.includes(' joins defaults that differ or are not constants ')) r.reason = said;
  }
  // A feature with no value that two asserted equations give two values (contradictedDefinitionRefusal): no
  // decided row that may read it, or a value tied to it, is judged, as the validation surface judges none — the
  // solve takes one equation as its design equation, and the point it reaches holds the first written. A row
  // already unknown keeps its sentence — except one that says the solve did not converge: the pair is why, and the
  // other surfaces say so.
  for (const r of out) {
    if (r.conflict !== undefined || (r.result === 'unknown' && !(r.reason ?? '').startsWith(UNSETTLED_HEAD))) continue;
    const contradicted = contradictedDefinitionRefusal(model, r.context?.baseId ?? r.id, r.raw, r.context);
    if (contradicted === undefined) continue;
    r.result = 'unknown';
    r.slack = null;
    r.amount = 0;
    r.reason = contradicted;
    delete r.cause;
    delete r.imposed;
  }
  // A relation over a `default` an asserted equation sets equal to another
  // (undecidedPartnersRead, U7): neither has a value, so the point the solve
  // chose for it judges nothing, as the validation surface judges nothing.
  for (const r of out) {
    if (r.conflict !== undefined || r.result === 'unknown' || r.imposed === true || r.context !== undefined) continue;
    const el = model.get(r.id);
    if (!el || undecidedPartnersRead(model, el, relationNamesOf(r.raw), memo).length === 0) continue;
    r.result = 'unknown';
    r.slack = null;
    r.amount = 0;
    r.reason =
      (checkVerdictOf(r.id)?.result === 'unknown' ? checkSentence(r.id) : undefined) ??
      'it reads a `default` an asserted equation sets equal to another: both give way, so it has no value';
    delete r.cause;
  }
  return out;
}

/** `a`, `a and b`, `a, b and c` — the declared names of `ids`, an instance's variable by its symbol. */
function nameList(model: Model, ids: readonly ElementId[]): string {
  const names = ids.map((id) =>
    id.includes('@') ? id.slice(id.indexOf('@') + 1) : (model.get(id)?.declaredName ?? id),
  );
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Why a relation over a design freedom is not judged — in the validation
 * surface's register: the features, and that nothing fixes them.
 */
function freedomSentence(model: Model, ids: readonly ElementId[]): string {
  const one = ids.length === 1;
  return (
    `${nameList(model, ids)} ${one ? 'is' : 'are'} left free by the equations — no value states ` +
    `${one ? 'it' : 'them'} and no relation fixes ${one ? 'it' : 'them'} — so the ` +
    'point the solver stopped at is one choice among many, and this relation is not judged at it'
  );
}

/** The head of {@link unsettledSentence}. */
const UNSETTLED_HEAD = 'the solve did not converge:';

/**
 * Why a relation over a value the solve stopped at without converging is not
 * judged ({@link SolveCore.unsettled}) — in the register of {@link freedomSentence}.
 */
function unsettledSentence(model: Model, ids: readonly ElementId[]): string {
  const one = ids.length === 1;
  return (
    `${UNSETTLED_HEAD} ${nameList(model, ids)} ${one ? 'is' : 'are'} where it stopped, at a point ` +
    'that misses an equation of the model it solved, so that point is no solution and this relation is not ' +
    'judged at it'
  );
}

/**
 * The names of the relations `ids` of one kind (`noun`: an `assert`, a
 * `constraint`), each once, sorted: a sentence lists them alike whatever the
 * order of the text. Those with no name of their own are counted, never listed
 * by the qualified name the model gives an unnamed usage (`«ConstraintUsage»`).
 */
function relationNameList(model: Model, ids: readonly ElementId[], noun: string): string {
  const named = new Set<string>();
  let unnamed = 0;
  for (const id of new Set(ids)) {
    const name = model.get(id)?.declaredName;
    if (name) named.add(name);
    else unnamed++;
  }
  const names = [...named].sort();
  if (unnamed === 1) names.push(`an unnamed ${noun}`);
  else if (unnamed > 1) names.push(`${unnamed} unnamed ${noun}s`);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Why a relation over a feature an assert holds in a form the solve does not
 * read is not judged ({@link SolveCore.held}) — in the register of {@link freedomSentence}.
 */
function heldSentence(model: Model, ids: readonly ElementId[], asserts: readonly ElementId[]): string {
  const one = ids.length === 1;
  // One entry per named assert and the form it takes; the unnamed ones are
  // counted by form, never listed by the qualified name of an unnamed usage.
  const named = new Set<string>();
  const unnamed = new Map<string, number>();
  const distinct = new Set(asserts);
  for (const id of distinct) {
    const el = model.get(id);
    const node = parseRelationBody(String(el?.attrs.expression ?? ''))?.node;
    const op = node?.kind === 'binary' ? node.op : undefined;
    const shape =
      op === 'and'
        ? 'a conjunction'
        : op === 'or' || op === 'xor'
          ? 'a disjunction'
          : op === 'implies'
            ? 'an implication'
            : op !== undefined && isInequalityOp(op)
              ? 'an inequality'
              : op === '!='
                ? 'a `!=`'
                : 'an equation it cannot read';
    if (el?.declaredName) named.add(`${el.declaredName}, ${shape}`);
    else unnamed.set(shape, (unnamed.get(shape) ?? 0) + 1);
  }
  const each = [
    ...[...named].sort(),
    ...[...unnamed].map(([shape, n]) => `${n === 1 ? 'an unnamed assert' : `${n} unnamed asserts`}, ${shape}`).sort(),
  ];
  return (
    `${nameList(model, ids)} ${one ? 'has' : 'have'} no value, and ${distinct.size > 1 ? 'asserts constrain' : 'an assert constrains'} ` +
    `${one ? 'it' : 'them'} in a form the numeric solve does not read (${each.join('; ')}), so ${one ? 'it is' : 'they are'} ` +
    `no design freedom: no plain constraint is solved for ${one ? 'it' : 'them'}, and this relation is not judged`
  );
}

/**
 * Why a relation over a value plain constraints that disagree gave is not
 * judged ({@link SolveCore.contested}) — in the register of {@link freedomSentence}.
 * `rival`: one of them has more than one root ({@link SolveCore.rival}), so
 * they need not disagree, and the sentence says what is true of the pair
 * whichever way round it is written.
 */
function contestedSentence(model: Model, ids: readonly ElementId[], checks: readonly ElementId[], rival: boolean): string {
  const list = relationNameList(model, checks, 'constraint');
  return rival
    ? `no value the model states fixes ${nameList(model, ids)}, only plain constraints, one of them that may have more than one root ` +
        `(${list}): which root the solve took, and so whether the others hold, would turn on which constraint it took first as ` +
        'its design equation, so none does, and this relation is not judged'
    : `no value the model states fixes ${nameList(model, ids)}, only plain constraints that disagree ` +
        `(${list}): which of them holds would turn on the one the solve took first as its ` +
        'design equation, so none does, and this relation is not judged';
}

/**
 * Why a relation over a value whose equations have more than one root, one of them the model's own (a stated value, an
 * assert) or nothing to be imposed beside, is not judged ({@link SolveCore.curved}): `roots` describes those equations.
 */
function rootsSentence(model: Model, ids: readonly ElementId[], roots: readonly string[]): string {
  const list = [...new Set(roots)].sort();
  const names = list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return (
    `no value the model states fixes ${nameList(model, ids)}, and the equations over ${ids.length === 1 ? 'it' : 'them'} may leave more than ` +
    `one root (${names}): which root the solve took is no value the model states, and whether this relation holds turns on it, ` +
    'so none is read, and this relation is not judged'
  );
}

/**
 * Why a plain constraint the solve took as a design equation is `satisfied`
 * ({@link NumericConstraintResult.imposed}): the features it fixed, and that
 * nothing the model states fixes them.
 */
function imposedSentence(model: Model, ids: readonly ElementId[]): string {
  const fixes = ids.length === 0 ? '' : ` fixes ${nameList(model, ids)}`;
  return (
    `imposed by the solve: no value the model states${fixes}, so the solve took this constraint as a ` +
    'design equation and made it hold — satisfied by construction, not a check the design passes'
  );
}

/**
 * The rows of {@link checkConstraintsNumeric} that are no relation the model
 * writes in one place — read off the validation surface's own sweep, so the
 * two surfaces give each the one verdict:
 *  - a definition's constraint or assert read in a context that specialises
 *    the definition and reads it differently (`instances` of
 *    `checkConstraints`, `<id>@<context id>`): SysML makes it a feature of
 *    every instance, so `P::cLoad` proved at P's values said nothing of a `p`
 *    whose `load` breaks it, and an assert `p` breaks was `feasible`;
 *  - a value the model states twice (`conflict`): a redefinition against a
 *    binding it overrides, or two bindings one context inherits under one
 *    name — `violated` where two literals differ, else `unknown`.
 * No slack: the solver reads no value per context. `checks` is the sweep.
 */
function contextRows(model: Model, checks: readonly ConstraintCheck[]): NumericConstraintResult[] {
  const out: NumericConstraintResult[] = [];
  const reason = (message: string): string => message.replace(/^(Could not evaluate|Constraint violated): /, '');
  for (const c of checks) {
    if (c.conflict) {
      out.push({
        id: c.id,
        name: '',
        raw: c.expression,
        kind: 'equality',
        result: c.result,
        slack: null,
        amount: 0,
        conflict: c.conflict,
        ...(c.result !== 'satisfied' ? { reason: reason(c.message) } : {}),
      });
      continue;
    }
    const instances = (c.instances ?? []).filter((i) => i.detail !== undefined);
    if (instances.length === 0) continue;
    const node = parseRelationBody(c.expression)?.node;
    const op = node?.kind === 'binary' && isInequalityOp(node.op) ? node.op : undefined;
    const kind: NumericConstraintResult['kind'] = op
      ? 'inequality'
      : node?.kind === 'binary' && (node.op === '==' || node.op === '=')
        ? 'equality'
        : 'boolean';
    const name = model.get(c.id)?.declaredName ?? '';
    for (const i of instances) {
      out.push({
        id: i.instance !== undefined ? `${c.id}@${i.instance}` : `${c.id}@${i.contextId}`,
        name,
        raw: c.expression,
        kind,
        ...(op ? { op: op as ComparisonOp } : {}),
        result: i.result,
        slack: null,
        amount: 0,
        context: { baseId: c.id, contextId: i.contextId, ...(i.instance !== undefined ? { path: i.instance } : {}) },
        ...(i.instance !== undefined || i.via === true ? { anchorId: anchorFor(model, c, i) } : {}),
        ...(i.result !== 'satisfied' ? { reason: reason(i.detail ?? i.message) } : {}),
        ...(i.result === 'unknown' && i.cause !== undefined ? { cause: i.cause } : {}),
      });
    }
  }
  return out;
}

/**
 * The relations {@link solveFeasible} cannot see in the inequalities it moves
 * features against — a definition's constraint read in a context that breaks
 * it, a value the model states twice ({@link contextRows}) — that are not
 * `satisfied` on the validation surface: `violated` or `unknown` there (`all`:
 * the satisfied ones too). No freedom of the solve can repair either: the
 * context's own values, or the two bindings, are what the model states.
 */
function contextVerdicts(
  model: Model,
  scopeId?: ElementId,
  all = false,
  checks: readonly ConstraintCheck[] = checkConstraints(model),
): NumericConstraintResult[] {
  const inScope = scopeFilter(model, scopeId);
  return contextRows(model, checks)
    .filter((r) => all || r.result !== 'satisfied')
    .filter((r) => {
      const anchor = model.get(r.context?.baseId ?? r.id) ?? model.get(r.id.split('@')[1] ?? '');
      return anchor === undefined || inScope(anchor);
    });
}

/**
 * Does the model STATE this feature's value — as a value of its own, or
 * through an asserted equation that defines it — rather than leave it to the
 * solver? The validation surface reads the first two and not the third.
 */
function statedByModel(model: Model, id: ElementId, memo: DerivationMemo): boolean {
  const el = model.get(id);
  if (!el) return false;
  if (hasStatedValue(model, el)) return true;
  const d = definitionDerivation(model, id, memo);
  return d !== undefined && (d.q !== undefined || d.b !== undefined);
}

/**
 * The coherent SI unit a scaled relation's slack/amount are expressed in — the
 * dimension the COMPARISON was made in (`640 [Wh] / 650 [W] >= 45 [min]`
 * compares durations, not energies), which the unit-aware evaluator reports;
 * failing that, the first dimensioned variable of the relation.
 */
function slackUnitOf(
  model: Model,
  compared: Dimension | undefined,
  rel: Equation | Inequality | undefined,
  memo: DerivationMemo,
): string | undefined {
  if (compared) return siSymbolOf(compared);
  if (!rel) return undefined;
  for (const key of rel.vars) {
    const d = featureDimension(model, baseIdOf(key), memo);
    if (d && !dimEqual(d, DIMENSIONLESS)) return siSymbolOf(d);
  }
  return undefined;
}

/**
 * A relation's name → variable map: its scope ({@link relationScope}), each
 * path read through an instance of its own keyed to that instance's variable
 * ({@link keyedNames}) — the variables the solve gives values to.
 */
function relationKeys(
  model: Model,
  el: ElementRecord,
  scope: ReadonlyMap<string, ElementId> = relationScope(model, el),
): ReadonlyMap<string, ElementId> {
  const raw = el.attrs.expression;
  const body = typeof raw === 'string' ? parseRelationBody(raw) : undefined;
  return (body && keyedNames(model, el, body.node, scope)?.nameToId) ?? scope;
}

/** How a relation reads its names at a point that is not the model's own ({@link pointReading}). */
interface PointReading {
  /** Each name the point moved, at the value it has there: one the caller fixed with its exact reading. */
  bind: (name: string) => Quantity | undefined;
  /** Does the point move a name the relation reads? */
  bound: boolean;
  /**
   * Does the relation read a value the solve produced there — moved, not
   * fixed, or one the model leaves to the solve — known only to the solve's
   * tolerance (decision 11)?
   */
  produced: boolean;
  /**
   * The names the point gives no value, whose value the model states over
   * what the point moved: read, it would be the model's own point's.
   */
  stale: string[];
  /** The exact reading of a name the caller fixed, or that states a literal the point keeps. */
  exact: ExactScope;
}

/**
 * How the relation `el` reads each of its names at `values`, a point that is
 * not the model's own (`modelPoint`): a name whose value the point keeps reads
 * the model's own, as there; one the point moved reads the value it has
 * there; and one the point holds `fixed` reads the decimal the caller gave,
 * exactly, as a value the model states is read. Read as a value the solve
 * produced, a fixed `x` of 1 met `x <= 0.99999999999` within the solve's
 * tolerance — decision 11's leniency, which is the solve's alone — and `x ==
 * 1.00000000001` held.
 *
 * A name the point gives no value — a Boolean, a string, a value the solver
 * does not read — is the model's own, which is no value of this point where
 * the model states it over a feature the point moved (`ok = x > 5.0`, `x`
 * fixed to 1 where the model's is 9): `stale`, and the relation is not judged.
 */
function pointReading(
  model: Model,
  el: ElementRecord,
  body: LoweredBody & { node: ExprNode },
  keys: ReadonlyMap<string, ElementId>,
  values: ReadonlyMap<ElementId, number>,
  modelPoint: ReadonlyMap<ElementId, number>,
  fixed: ReadonlySet<ElementId>,
  movedBases: ReadonlySet<ElementId>,
  solved: (name: string) => Quantity | undefined,
  memo: DerivationMemo,
): PointReading {
  const definitions = sharedDefinitions(model);
  const moved = new Set<string>();
  const stale: string[] = [];
  let produced = false;
  for (const name of new Set(namesReadIn(body.node))) {
    if (body.literals.has(name)) continue;
    const key = keys.get(name);
    if (key === undefined) continue;
    if (values.has(key) && !sharedValue(key, values, modelPoint)) {
      // Moved: read at the point, or at no value — never the model's.
      if (solved(name) === undefined) stale.push(name);
      else moved.add(name);
      if (!fixed.has(key)) produced = true;
    } else if (values.has(key)) {
      if (!statedByModel(model, baseIdOf(key), memo)) produced = true;
    } else {
      const f = model.get(baseIdOf(key));
      const context = el.ownerId ?? f?.ownerId;
      if (
        f !== undefined &&
        (movedBases.has(f.id) ||
          (context != null && definitions.dependencies(context, f).some((d) => movedBases.has(d))))
      ) {
        stale.push(name);
      }
    }
  }
  return {
    bind: (name) => {
      if (!moved.has(name)) return undefined;
      const q = solved(name);
      const key = keys.get(name)!;
      if (q === undefined || !fixed.has(key)) return q;
      const exact = writtenRational(values.get(key)!);
      return exact ? { ...q, exact } : q;
    },
    bound: moved.size > 0,
    produced,
    stale,
    exact: (name) => {
      const key = keys.get(name);
      const v = key !== undefined ? values.get(key) : undefined;
      if (key === undefined || v === undefined) return undefined;
      if (fixed.has(key)) return writtenRational(v);
      if (!sharedValue(key, values, modelPoint)) return undefined;
      const f = model.get(key);
      const raw = f?.attrs.value;
      return f && typeof raw === 'number' && raw === v && !defaultGivesWay(model, f)
        ? statedRational(raw, f.attrs.valueText)
        : undefined;
    },
  };
}

/**
 * Why a relation is not judged at a point that moved what a name it reads
 * reads, where the point gives that name no value ({@link pointReading}).
 */
function staleSentence(names: readonly string[]): string {
  const one = names.length === 1;
  const list = one ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return (
    `${list} ${one ? 'has' : 'have'} no value at this point, and the model's own reads what this point ` +
    'holds elsewhere — a value held fixed, or one it moves — so it is no value of this point, and this ' +
    'relation is not judged at it'
  );
}

/**
 * A last-resort quantity scope over the SOLVED values: the magnitude the solver
 * determined, read in the feature's storage unit (its declared unit, else the
 * coherent SI unit of its kind). It answers only the names the model's own
 * quantity scopes cannot — a feature with no value of its own that an equality
 * pins down — so a reasoned refusal is never overridden by it. `unread` are
 * feature chains the validation surface reads no value through, which it does
 * not answer either.
 */
function solvedQuantityScope(
  model: Model,
  el: ElementRecord,
  values: Map<ElementId, number>,
  memo: DerivationMemo,
  unread: readonly string[] = [],
  keys?: ReadonlyMap<string, ElementId>,
): (name: string) => Quantity | undefined {
  const nameToId = keys ?? relationKeys(model, el);
  return (name: string) => {
    if (unread.includes(name)) return undefined;
    const key = nameToId.get(name);
    if (key === undefined) return undefined;
    const v = values.get(key);
    if (v === undefined || !Number.isFinite(v)) return undefined;
    const id = baseIdOf(key);
    // The unit the solved magnitude is stored in ({@link storageScaleOf}).
    const facets = declaredFacetsOf(model, id);
    const derived = derivationOf(model, id, memo);
    const dimension = facets.unitDimension ?? facets.kindDimension ?? derived?.derived ?? DIMENSIONLESS;
    const q: Quantity = { magnitude: v, dimension };
    if (facets.unit) {
      q.unit = facets.unit;
      if (resolveUnit(facets.unit)?.offsetSI) q.absolute = true;
    } else if (derived?.q?.convertedFrom !== undefined) {
      // A value in SI that its derivation converted out of a dimension-one
      // unit (`x == cap * 2.0`, bits) is that quantity here too, as the
      // validation surface reads it, and takes no `[unit]` there or here.
      q.convertedFrom = derived.q.convertedFrom;
    }
    return q;
  };
}

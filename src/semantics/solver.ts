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
import { parseExpr, evaluate, type ExprNode } from './expr';
import { isBindingEdge, propagateValues } from './connectors';
import { checkConstraints, evaluateFeatureValue, readRefusalOf, unreadValuesOf } from './evaluate-model';
import { hasStatedValue, isParameterisedCalculation } from './defining-equation';
import { isNonNormativeStatement } from './statement-kind';
import {
  NO_MARKERS,
  idScopeFor,
  mergeMaps,
  namesReadIn,
  parseRelationBody,
  relationRefused,
  relationScope,
  relationVarsOf,
  scaleOfRelation,
  substituteLiterals,
  type LoweredBody,
  type MarkerDimensions,
  type ScaleMap,
} from './relations';
import {
  definitionDerivation,
  definitionsOf,
  featuresDefinedBy,
  derivedDimensionOf,
  dimensionalFacets,
  evaluateConstraintQuantityDetailed,
  evaluateQuantity,
  isRefusalReason,
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
   */
  values: Map<ElementId, number>;
  /** True when every gathered equation is determined and its residual < tol. */
  converged: boolean;
  /** Number of solver iterations performed. */
  iterations: number;
  /** The largest absolute residual across the determined equations. */
  residual: number;
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
   * populated when `opts.constraints` was set; `undefined` otherwise.
   */
  feasible?: boolean;
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
  /** The amount by which the constraint is violated (always > 0). */
  amount: number;
}

/** Result of {@link solveFeasible}. */
export interface FeasibilityResult {
  /** featureId → value at the feasible (or best-effort) point. */
  values: Map<ElementId, number>;
  /** True when every inequality holds within tolerance at {@link values}. */
  feasible: boolean;
  /** The violated inequalities (empty when {@link feasible}). */
  violations: ConstraintViolation[];
  /** Number of penalty-descent sweeps performed. */
  iterations: number;
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
  /** Why the relation is `unknown` — the unit-aware evaluator's sentence. */
  reason?: string;
}

/** Options for {@link solveFeasible}. */
export interface FeasibilityOptions extends SolveOptions {
  /** Maximum penalty-descent sweeps (default 60). */
  sweeps?: number;
}

/* ────────────────── dimensions for the reported slack ────────────────── */

/** The dimension a feature's magnitude is expressed in, when it has one. */
function featureDimension(model: Model, id: ElementId, memo: DerivationMemo): Dimension | undefined {
  const facets = dimensionalFacets(model, id);
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
      if (!eq) continue;
      const defines = definitionsOf(model, el, memo);
      if (defines.length > 0) eq.defines = defines;
      eqs.push(eq);
      continue;
    }

    // (2) Feature-value expression assignments (only genuine expressions).
    if (isUsage(el.eClass)) {
      const eq = assignmentEquation(model, el, memo, () => unreadable.add(el.id));
      if (eq) eqs.push(eq);
    }
  }

  // (3) BindingConnector / bind / equality connectors.
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (!isBindingEdge(el)) continue;
    if (!inScope(el)) continue;
    const s = el.source?.[0];
    const t = el.target?.[0];
    if (s === undefined || t === undefined) continue;
    eqs.push(bindingEquation(model, el.id, s, t, memo));
  }

  return { eqs, unreadable };
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

  const nameToId = relationScope(model, el);

  // `lhs = rhs` / `lhs == rhs`. A lone `=` is now a distinct operator (finding
  // L3); accept it here as an equation separator alongside `==`.
  if (node.kind === 'binary' && (node.op === '==' || node.op === '=' || (negation && node.op === '!='))) {
    return makeEquation(model, node.left, node.right, raw, nameToId, body, memo, false, el, true, onRefused);
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
    const eq = makeEquation(model, lhs, node, raw, nameToId, body, memo, false, el, false, onRefused);
    if (eq && hasStatedValue(model, el)) eq.states = el.id;
    return eq;
  }

  return undefined;
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
  const body = parseRelationBody(s);
  if (!body) return undefined;
  if (body.hadUnit && !body.resolved) return undefined;
  const node = body.node;
  // A self-contained literal (a bare number/boolean) is a seed, not an equation.
  const asLiteral = evaluate(substituteLiterals(node, body.literals), () => undefined);
  if ('value' in asLiteral) return undefined;

  const name = el.declaredName;
  if (!name) return undefined;

  const nameToId = mergeMaps(
    el.ownerId != null ? idScopeFor(model, el.ownerId) : new Map(),
    idScopeFor(model, el.id),
  );
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
  return eq;
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
  const eq: Equation = {
    vars: varIds,
    lhs: left,
    rhs: right,
    expr: { kind: 'binary', op: '-', left, right },
    raw,
    nameToId,
  };
  if (scale) eq.scale = scale;
  return eq;
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
  return out;
}

/** Build an {@link Inequality} from a ConstraintUsage / CalculationUsage body. */
function relationInequality(
  model: Model,
  el: ElementRecord,
  memo: DerivationMemo = new Map(),
): Inequality | undefined {
  const raw = el.attrs.expression;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;

  const body = parseRelationBody(raw);
  if (!body) return undefined;
  if (body.hadUnit && !body.resolved) return undefined;
  const node = body.node;
  if (node.kind !== 'binary' || !isInequalityOp(node.op)) return undefined;

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

  const ineq: Inequality = {
    vars: varIds,
    expr: substituteLiterals(g, body.literals),
    op,
    id: el.id,
    name: el.declaredName ?? '',
    raw,
    nameToId,
  };
  if (scale) ineq.scale = scale;
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
  nameToId: Map<string, ElementId>,
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

/**
 * Solve the model's numeric constraint system.
 *
 * Seeds every feature carrying a literal numeric `attrs.value`, then iterates
 * constraint propagation — orienting each equation to solve for its single
 * remaining unknown, plus binding-connector value propagation
 * ({@link propagateValues}) — to a fixpoint. Any coupled/implicit residuals left
 * over are driven under `opts.tol` with a bounded finite-difference Newton
 * (least-squares) step. Deterministic.
 */
export function solve(model: Model, opts: SolveOptions = {}): SolveResult {
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

  // Seed literal numeric feature values.
  for (const el of model.all()) {
    if (values.has(el.id) || el.attrs.isLibrary === true) continue;
    const v = numericSeedOf(model, el);
    if (v !== undefined) values.set(el.id, v);
  }

  const { eqs, unreadable } = gatherSystem(model, opts.scopeId);
  const defined = definedFeatures(eqs, unreadable);
  // The definitions that BIND — those that alone determine what they define
  // ({@link closedByDefinitions}), over the values the model states: no check
  // orients what they define. One that leaves a design freedom binds nothing,
  // and a check fixes the freedom by propagation, as it always did.
  const binding = new Set<ElementId>([
    ...unreadable,
    ...closedByDefinitions(eqs, defined, (v) => values.has(v), values, unreadable),
  ]);
  // Numeric binding-propagated values (seed additional equalities).
  const propagated = numericPropagation(model);

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
          changed = true;
        }
      }

      for (const eq of eqs) {
        const unknowns = eq.vars.filter((v) => !values.has(v));
        if (unknowns.length !== 1) continue;
        const u = unknowns[0];
        if (fixedIds.has(u) || !mayOrient(eq, u, binding)) continue;
        const val = solveForSingle(eq, u, values, tol);
        if (val !== undefined && Number.isFinite(val)) {
          values.set(u, val);
          changed = true;
        }
      }
      if (changed) progressing = true;
    }

    // Remaining coupled unknowns → one bounded Newton solve. A feature whose
    // own value cannot be read is no unknown to solve for.
    const unknowns = remainingUnknowns(eqs, values, fixedIds).filter((v) => !unreadable.has(v));
    if (unknowns.length === 0) break;
    iterations++;
    const moved = newtonSolve(eqs, unknowns, values, fixedIds, tol, maxIter, defined, unreadable);
    if (moved) progressing = true;
    else break;
  }

  const { residual, determined, withinTol } = residualSummary(eqs, values, tol);
  const converged = determined && withinTol;
  return { values, converged, iterations, residual };
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
 * check never stands in for a definition that is refused.
 */
function mayOrient(eq: Equation, u: ElementId, defined: ReadonlySet<ElementId>): boolean {
  return !defined.has(u) || (eq.defines?.includes(u) ?? false);
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
    if (Math.abs(r) > convergenceGate(eq, values, tol)) withinTol = false;
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
 * Does the residual `g` VIOLATE this ordering? The one place that owns the
 * rule, for every surface that publishes a verdict about an inequality:
 * {@link checkConstraintsNumeric}'s scalar fallback, {@link collectViolations}
 * (so {@link solveFeasible}) and {@link optimize}'s feasibility check.
 *
 * `exact` says the verdict is being read from RAW MAGNITUDES because the
 * unit-aware evaluator declined — the one path on which this side and the
 * validation surface answer from the same numbers. There a STRICT ordering has
 * no slack at its boundary: `mass < 25.0` at 25 kg is FALSE, exactly as
 * `evaluate` in ./expr reads it, and the ±1e-6 that `<=` needs to absorb a
 * solved value's float noise turned it into `satisfied`. Any residual in
 * (0, gate] went the same way, not only an exact tie.
 *
 * Everywhere the unit-aware evaluator DOES answer, its reading governs and the
 * gate stays tolerant — `compareQ` counts operands within its tolerance as
 * equal for every operator, so `mass < 25.0 [kg]` at 25 kg is satisfied, and a
 * feasibility check that read that tie exactly would contradict the very
 * verdict the check surface publishes.
 */
function inequalityViolated(op: ComparisonOp, g: number, gate: number, exact: boolean): boolean {
  if (exact && (op === '<' || op === '>')) return g >= 0;
  return g > gate;
}

/**
 * The inequalities whose verdict {@link checkConstraintsNumeric} reads from raw
 * magnitudes — the unit-aware evaluator returning ignorance (not a REFUSAL,
 * which is reported `unknown` and judged by no one). Only a STRICT ordering can
 * be read differently for it, so only those are asked.
 *
 * This repeats the evaluator call `checkConstraintsNumeric` makes, once per
 * strict ordering, so that feasibility and that surface cannot disagree about
 * which rule a relation is read under.
 */
function exactlyReadIneqs(
  model: Model,
  ineqs: Inequality[],
  values: Map<ElementId, number>,
  feasTol: number,
): Set<ElementId> {
  const out = new Set<ElementId>();
  const memo: DerivationMemo = new Map();
  for (const iq of ineqs) {
    if (iq.op !== '<' && iq.op !== '>') continue;
    const el = model.get(iq.id);
    if (!el) continue;
    const detailed = evaluateConstraintQuantityDetailed(model, el, {
      fallback: solvedQuantityScope(model, el, values, memo),
      absTol: iq.scale ? 0 : feasTol,
      memo,
    });
    if (detailed.verdict === 'unknown' && !isRefusalReason(detailed.reason)) out.add(iq.id);
  }
  return out;
}

/** Numeric-only view of {@link propagateValues}. */
function numericPropagation(model: Model): Map<ElementId, number> {
  const out = new Map<ElementId, number>();
  for (const [id, v] of propagateValues(model)) {
    if (typeof v === 'number' && Number.isFinite(v)) out.set(id, v);
  }
  return out;
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
    const trial = new Map(values);
    trial.set(u, t);
    return residualOf(eq, trial);
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

  // Newton with finite-difference derivative.
  let t = seed;
  for (let i = 0; i < 60; i++) {
    const f0 = f(t);
    if (f0 === undefined) break;
    if (accept(f0)) return t;
    const h = probeStep(t);
    const f1 = f(t + h);
    if (f1 === undefined) break;
    const deriv = (f1 - f0) / h;
    if (Math.abs(deriv) < 1e-14) break;
    const next = t - f0 / deriv;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - t) <= stepGate(t)) return next;
    t = next;
  }

  // Bisection over an expanding bracket around 0.
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
  for (let k = 0; k < 200; k++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (fm === undefined) return undefined;
    if (accept(fm) || (b - a) / 2 <= (scaled ? stepGate(m) : tol)) return m;
    if (fa * fm < 0) {
      b = m;
      fb = fm;
    } else {
      a = m;
      fa = fm;
    }
  }
  return (a + b) / 2;
}

/**
 * Drive a coupled subsystem to a fixpoint with a bounded finite-difference
 * Newton step, solving the (possibly over-determined) linearised system by
 * least squares (regularised normal equations). Writes the found values back
 * and returns whether anything moved.
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
): boolean {
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
  const closed = closedByDefinitions(eqs, defined, (v) => values.has(v) && !unknownSet.has(v), values, unreadable);
  const active = eqs.filter(
    (eq) =>
      eq.vars.every((v) => values.has(v) || unknownSet.has(v)) &&
      ((eq.defines?.length ?? 0) > 0 || !eq.vars.some((v) => unknownSet.has(v) && closed.has(v))),
  );
  if (active.length === 0) return false;

  const n = unknowns.length;
  const x = unknowns.map((id) => values.get(id) ?? 1);

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

  const residuals = (xv: number[]): number[] | undefined => {
    const trial = new Map(values);
    unknowns.forEach((id, i) => trial.set(id, xv[i]));
    const out: number[] = [];
    for (const eq of active) {
      const r = residualOf(eq, trial);
      if (r === undefined) return undefined;
      out.push(r);
    }
    return out;
  };

  const budget = Math.min(maxIter, 100);
  let converged = false;
  for (let iter = 0; iter < budget; iter++) {
    const F = residuals(x);
    if (!F) break;
    // Convergence: each equation within its own noise floor or the user's tol.
    if (accepts(F)) {
      converged = true;
      break;
    }

    // Finite-difference Jacobian J[m][n].
    const m = active.length;
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
      if (!Fp) return false;
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
      if (!Number.isFinite(d)) return false;
      x[j] += d;
      step = Math.max(step, Math.abs(d));
    }
    if (step <= tol * xScale()) {
      const last = residuals(x);
      converged = last !== undefined && accepts(last);
      break;
    }
  }

  let moved = false;
  unknowns.forEach((id, i) => {
    if (fixedIds.has(id) || !Number.isFinite(x[i])) return;
    const prev = values.get(id);
    if (prev === undefined || Math.abs(prev - x[i]) > 1e-15) moved = true;
    values.set(id, x[i]);
  });
  return moved || converged;
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
 */
function closedByDefinitions(
  eqs: readonly Equation[],
  defined: ReadonlySet<ElementId>,
  given: (v: ElementId) => boolean,
  values: ReadonlyMap<ElementId, number>,
  unreadable: ReadonlySet<ElementId> = new Set(),
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
  // equation joins the component, and the feature is no freedom in it — but
  // only the definitions' features are returned: a stated value binds
  // nothing a check could not fix before.
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
  const out = new Set<ElementId>();
  for (const [root, vars] of members) {
    if (!vars.every(determined)) continue;
    const own = definitions.filter((eq) => eq.vars.some((v) => !fixed(v) && find(v) === root));
    if (determines(own, vars, values)) for (const v of vars) if (defined.has(v)) out.add(v);
  }
  return out;
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
 */
function determines(eqs: readonly Equation[], vars: readonly ElementId[], values: ReadonlyMap<ElementId, number>): boolean {
  if (eqs.length < vars.length) return false;
  const point = new Map(values);
  for (const v of vars) if (!point.has(v)) point.set(v, 1);
  /** ∂eq/∂v at the point, by central differences; `undefined` where it cannot be read. */
  const partial = (eq: Equation, v: ElementId): number | undefined => {
    const x = point.get(v)!;
    const h = 1e-6 * (Math.abs(x) + 1);
    point.set(v, x + h);
    const a = residualOf(eq, point);
    point.set(v, x - h);
    const b = residualOf(eq, point);
    point.set(v, x);
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    return (a - b) / (2 * h);
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
    const scale = Math.max(...eq.vars.filter((u) => cols.has(u)).map((u) => Math.abs(partial(eq, u) ?? 0)));
    if (!(Math.abs(d) > 1e-7 * scale)) return false;
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
    for (const v of core) {
      const d = partial(eq, v);
      if (d === undefined) return true;
      row.push(d);
    }
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

/** The seed numeric value of a feature (a literal number/quantity), or undefined. */
function numericSeedOf(model: Model, feat: ElementRecord): number | undefined {
  const raw = feat.attrs.value;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (s === '') return undefined;
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
 * physical dimension where the quantity engine can derive them.
 */
export function evaluateMoEs(model: Model): MeasureResult[] {
  const solved = solve(model);
  const unitBlind = unitBlindIds(model);
  const out: MeasureResult[] = [];
  const seen = new Set<ElementId>();

  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || seen.has(el.id)) continue;
    if (!isMoeFeature(model, el)) continue;
    seen.add(el.id);

    let value: number | undefined = solved.values.get(el.id);
    // WHERE the number came from decides whether it may be labelled: only the
    // solver reads a value unit-awarely. The fallbacks below are raw magnitudes.
    const fromSolver = value !== undefined;
    if (value === undefined) value = numericSeedOf(model, el);
    if (value === undefined) {
      const r = evaluateFeatureValue(model, el.id);
      if ('value' in r && typeof r.value === 'number' && Number.isFinite(r.value)) value = r.value;
    }

    const q = evaluateQuantity(model, el.id);
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
    const facets = dimensionalFacets(model, el.id);
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
      const d = featureDimension(model, id, memo);
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
  for (const id of variableIds) {
    const [lo, hi] = bounds.get(id) ?? [0, 1];
    const seed = numericSeedOf(model, model.get(id) ?? ({ attrs: {} } as ElementRecord));
    best.set(id, seed !== undefined && seed >= lo && seed <= hi ? seed : (lo + hi) / 2);
  }

  /** Sign-adjusted objective + inequality penalty for an assignment. */
  const scoreOf = (assign: Map<ElementId, number>): number => {
    const res = solve(model, { fixed: assign });
    let v = res.values.get(objectiveId);
    if (v === undefined || !Number.isFinite(v)) {
      const r = evaluateFeatureValue(model, objectiveId);
      v = 'value' in r && typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : undefined;
    }
    if (v === undefined) return Number.POSITIVE_INFINITY;
    let penalty = 0;
    for (const iq of ineqs) {
      const g = inequalityResidual(iq, res.values);
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
    const res = solve(model, { fixed: best });
    const feasTol = Math.max(tol, 1e-6);
    const exact = exactlyReadIneqs(model, ineqs, res.values, feasTol);
    result.feasible = ineqs.every((iq) => {
      const g = inequalityResidual(iq, res.values);
      if (g === undefined) return true;
      return !inequalityViolated(iq.op, g, inequalityGate(iq, res.values, feasTol), exact.has(iq.id));
    });
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
  const res = solve(model, { fixed });
  const v = res.values.get(objectiveId);
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
 * convex 1-D line search per coordinate). Variables uniquely determined by the
 * equalities (seeds and single-unknown targets) are held at their solved values so
 * a genuinely infeasible system reports the true violation rather than splitting the
 * difference. Reports each violated inequality's amount and whether all hold.
 * Deterministic and bounded.
 */
export function solveFeasible(model: Model, opts: FeasibilityOptions = {}): FeasibilityResult {
  const tol = opts.tol ?? 1e-9;
  const feasTol = Math.max(tol, 1e-6);
  const { eqs, unreadable } = gatherSystem(model, opts.scopeId);
  const ineqs = gatherInequalities(model, opts.scopeId);

  const base = solve(model, opts);
  const values = new Map(base.values);

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
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true) continue;
    if (numericSeedOf(model, el) !== undefined) seededIds.add(el.id);
  }
  // The features the definitions alone determine, at the plain solve's values
  // ({@link closedByDefinitions}): held there. A defined feature they leave
  // open is a design freedom like any other.
  const designInput = (v: ElementId): boolean => seededIds.has(v) || fixedIds.has(v);
  const closed = closedByDefinitions(eqs, definedFeatures(eqs, unreadable), designInput, values, unreadable);
  const pinned = pinnedVariables(eqs, seededIds, fixedIds, unreadable, values, closed);

  // Free variables: everything in an equality/inequality the equalities don't
  // pin — but never a feature whose stated value the solver lane cannot read
  // ({@link gatherSystem}), nor one an asserted equation DEFINES that the
  // plain solve could not give a value (its definition loops through, or reads,
  // something nothing fixes): the model says what it is, it has no value to
  // move, and the relations over it have no residual. Freed, `e == a * 2.0`
  // over a string-valued `a` was moved to 7 to split `e == 9.0` and `e <= 5.0`.
  // One the definitions leave open (a loop over a design freedom) is free.
  const defined = new Set<ElementId>([...unreadable, ...closed]);
  const freeSet = new Set<ElementId>();
  for (const iq of ineqs) for (const v of iq.vars) if (!pinned.has(v) && !defined.has(v)) freeSet.add(v);
  for (const eq of eqs) for (const v of eq.vars) if (!pinned.has(v) && !defined.has(v)) freeSet.add(v);
  const freeVars = [...freeSet];
  for (const id of freeVars) if (!values.has(id)) values.set(id, 0);

  const sweeps = Math.max(1, opts.sweeps ?? opts.maxIter ?? 60);
  // The penalty is a sum of squared violations, so drive it below feasTol² to
  // guarantee every individual violation is under the (linear) feasibility
  // tolerance. Stall detection uses a RELATIVE reduction so a genuinely
  // infeasible plateau stops while a still-improving descent continues.
  const target = feasTol * feasTol;
  let iterations = 0;
  let prevP = penaltyOf(eqs, ineqs, values);
  for (let s = 0; s < sweeps && freeVars.length > 0; s++) {
    iterations++;
    for (const id of freeVars) {
      const c = values.get(id) ?? 0;
      const x = convexLineMin((t) => {
        values.set(id, t);
        return penaltyOf(eqs, ineqs, values);
      }, c, tol);
      values.set(id, x);
    }
    const P = penaltyOf(eqs, ineqs, values);
    const improved = prevP - P;
    prevP = P;
    if (P <= target) break; // feasible to tolerance
    if (improved <= 1e-4 * P) break; // stalled (plateau / genuine infeasibility)
  }

  const exact = exactlyReadIneqs(model, ineqs, values, feasTol);
  const { violations, feasible } = collectViolations(ineqs, values, feasTol, exact);
  return { values, feasible, violations, iterations };
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

/** The violated inequalities at `values`, plus the largest violation amount. */
function collectViolations(
  ineqs: Inequality[],
  values: Map<ElementId, number>,
  feasTol: number,
  exact: ReadonlySet<ElementId> = new Set(),
): { violations: ConstraintViolation[]; maxViolation: number; feasible: boolean } {
  const violations: ConstraintViolation[] = [];
  let maxViolation = 0;
  let feasible = true;
  for (const iq of ineqs) {
    const g = inequalityResidual(iq, values);
    if (g === undefined) continue;
    const amount = Math.max(0, g);
    if (amount > maxViolation) maxViolation = amount;
    // A scaled inequality is judged against its own SI scale — the same 1e-6
    // made relative — not an absolute 1e-6 a nanosecond-scale system would
    // clear vacuously. A strict ordering read from raw magnitudes is judged at
    // its boundary instead: see {@link inequalityViolated}.
    if (inequalityViolated(iq.op, g, inequalityGate(iq, values, feasTol), exact.has(iq.id))) {
      violations.push({ id: iq.id, name: iq.name, amount });
      feasible = false;
    }
  }
  return { violations, maxViolation, feasible };
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
  const solved = solve(model, opts);
  const values = solved.values;
  const tol = Math.max(opts.tol ?? 1e-9, 1e-6);
  const memo: DerivationMemo = new Map();
  const out: NumericConstraintResult[] = [];
  // The validation surface's own sentence for a relation, read once and only
  // when a row needs it: a relation over a name that surface reads no value
  // for is undecided here exactly where it is undecided there, and says why
  // in the same words.
  let checks: Map<ElementId, string> | undefined;
  const checkSentence = (id: ElementId): string | undefined => {
    checks ??= new Map(checkConstraints(model).map((c) => [c.id, c.message.replace(/^Could not evaluate: /, '')]));
    return checks.get(id);
  };

  for (const el of model.all()) {
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
    const scope = relationScope(model, el);
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

    // The unit-aware evaluator judges FIRST, exactly as `checkConstraints`
    // does, with the solved values as a last-resort scope so a name only the
    // solver determined (an unknown driven by an equality) still resolves —
    // except a name the validation surface reads no value for here.
    // Its absolute tolerance is the caller's only where that number is
    // meaningful — raw magnitudes. In SI, "1e-6" is a metre-or-second-sized
    // constant with no relation to the model's scale, so a dimensional
    // comparison is left to the evaluator's own relative tolerance.
    const detailed = evaluateConstraintQuantityDetailed(model, el, {
      fallback: solvedQuantityScope(model, el, values, memo, unread),
      absTol: scale ? 0 : tol,
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
    // The validation surface's scalar path reads exactly what the MODEL states;
    // a value only this solver determined it does not read at all. So the
    // exact readings below are its readings only where every operand is one
    // the model states — a value, or an asserted definition — and a relation
    // over a solved unknown keeps the solver's own tolerance: `x * 3.0 ==
    // 0.3`, which fixed `x` at 0.09999999999999999, was read exactly and
    // reported violated by the very equation it was solved from.
    const stated = body !== undefined && relationVarsOf(body.node, scope).every((id) => statedByModel(model, id, memo));
    const connective =
      stated &&
      !read &&
      body !== undefined &&
      !body.hadUnit &&
      !isIneq &&
      !scalar &&
      !isNe &&
      detailed.reason === 'dimension';
    const solvedNames = namesScope(scope, values);
    const contract = connective
      ? evaluate(body.node, (name) => (unread.includes(name) ? undefined : solvedNames(name)))
      : undefined;
    if (detailed.verdict !== 'unknown' && !read) {
      row.result = detailed.verdict;
      if (row.result === 'satisfied') row.amount = 0;
    } else if (contract && 'value' in contract && typeof contract.value === 'boolean') {
      row.result = contract.value ? 'satisfied' : 'violated';
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
      // A calculation with a parameter states no value to judge its body against.
      const reason =
        calcValue && isParameterisedCalculation(model, el)
          ? `${el.declaredName} has a parameter, so its body is the value of a call over arguments and no value of its own`
          : own
            ? (read?.detail ?? (unread.length > 0 ? (checkSentence(el.id) ?? detailed.detail) : detailed.detail))
            : detailed.detail;
      if (reason) row.reason = reason;
    } else {
      // The scalar fallback must read the OPERATOR exactly as the validation
      // surface's scalar fallback does (`evaluate` in ./expr), because this is
      // the one path on which both surfaces answer from the same raw
      // magnitudes. {@link inequalityViolated} owns that rule for every surface
      // that publishes an inequality verdict; this branch IS its `exact` case,
      // reached only when the unit-aware evaluator returned ignorance rather
      // than an answer or a refusal. An author's `==` is read exactly too —
      // `limit == 25.0000001` over a kinded `limit = 25.0` is false there, and
      // an absolute 1e-6 called it satisfied — and a `!=` is violated exactly
      // where its equality holds. A calculation's value body keeps the plain
      // tolerance: its residual is the solver's own round trip, not a question
      // the validation surface asks.
      const violated =
        isIneq && iq !== undefined
          ? inequalityViolated(iq.op, residual, tol, true)
          : isIneq
            ? residual > tol
            : isNe
              ? stated
                ? residual === 0
                : Math.abs(residual) <= tol
              : isEq && stated
                ? residual !== 0
                : Math.abs(residual) > tol;
      row.result = violated ? 'violated' : 'satisfied';
      if (!violated) row.amount = 0;
    }
    out.push(row);
  }
  return out;
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
  for (const id of rel.vars) {
    const d = featureDimension(model, id, memo);
    if (d && !dimEqual(d, DIMENSIONLESS)) return siSymbolOf(d);
  }
  return undefined;
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
): (name: string) => Quantity | undefined {
  const nameToId = relationScope(model, el);
  return (name: string) => {
    if (unread.includes(name)) return undefined;
    const id = nameToId.get(name);
    if (id === undefined) return undefined;
    const v = values.get(id);
    if (v === undefined || !Number.isFinite(v)) return undefined;
    const facets = dimensionalFacets(model, id);
    const dimension =
      facets.unitDimension ?? facets.kindDimension ?? derivedDimensionOf(model, id, memo) ?? DIMENSIONLESS;
    const q: Quantity = { magnitude: v, dimension };
    if (facets.unit) {
      q.unit = facets.unit;
      if (resolveUnit(facets.unit)?.offsetSI) q.absolute = true;
    }
    return q;
  };
}

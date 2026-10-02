/**
 * Model-level evaluation: build value scopes from a model's feature tree,
 * evaluate feature values, and check constraint/requirement satisfaction.
 *
 *  - {@link scopeFor} — a resolver mapping feature names and dotted feature
 *    chains (from a context's effective features and their typed sub-features)
 *    to their known literal values.
 *  - {@link evaluateFeatureValue} — evaluate a feature's `attrs.value` /
 *    `attrs.expression` against its owner scope.
 *  - {@link checkConstraints} — parse and evaluate every ConstraintUsage /
 *    RequirementUsage that carries a boolean expression, classifying each as
 *    satisfied / violated / unknown, and reading one that names a valueless
 *    measure through the features that specialise it, once per context.
 */

import { type ElementId, type ElementRecord, type Model } from '@core/index';
import { effectiveFeatures } from './inheritance';
import { evaluate, parseExpr, type EvalResult, type ExprNode } from './expr';
import { DIMENSIONLESS, UNIT_REGISTRY, dimEqual, dimToString, type Dimension } from './units';
import {
  describeReason,
  dimensionClaimDetail,
  equationDerivation,
  evaluateConstraintQuantityDetailed,
  isRefusalReason,
  quantityKindOf,
  quantityRefsIn,
  type ConstraintQuantityOptions,
  type ConstraintQuantityResult,
  type DerivationMemo,
  type FeatureDerivation,
  type Quantity,
} from './units-eval';

/** A resolver from a (possibly dotted) name to a known value, or `undefined`. */
export type Scope = (name: string) => unknown;

/**
 * Build a value {@link Scope} for `contextId`. The scope maps every feature
 * reachable from the context (its effective features and, recursively, the
 * effective features of each feature's declared types) to its known literal
 * value — under both its dotted chain (`subject.mass`) and, as a convenience,
 * its bare name (`mass`, first occurrence wins).
 */
export function scopeFor(model: Model, contextId: ElementId): Scope {
  return scopeWith(model, contextId, new Set());
}

/**
 * A scope whose lookups are LAZY: names map to feature ids, and a feature's
 * value is computed on demand — through its OWN owner scope when it is an
 * expression — with `inFlight` guarding against a derivation cycle.
 *
 * The previous scope stored values eagerly via a scope-less literal evaluation,
 * so an expression-valued attribute (`enduranceMin = capacity / power * 60.0`)
 * evaluated to unknown and was silently OMITTED from the scope: a constraint
 * that referenced it reported "a referenced value is unknown" while the solver
 * computed it fine. `evaluateFeatureValue` already did the right thing; it was
 * never consulted from here.
 */
function scopeWith(model: Model, contextId: ElementId, inFlight: Set<ElementId>): Scope {
  const ids = featureIdsFor(model, contextId);
  return (name: string) => {
    const id = ids.get(name);
    if (id !== undefined) return valueOfFeature(model, id, inFlight);
    return valueDefinedByEquation(model, contextId, name, inFlight);
  };
}

/**
 * The value of a feature that STATES none but is fixed by an equation beside
 * it: `attribute est; assert constraint { est == a * b / c }` gives `est` the
 * value of the right-hand side. This is the CV-17 shape — an estimate that is
 * arithmetic over the layer's own values rather than a literal — and until
 * now the evaluator did not read it: the constraint reported "a referenced
 * value is unknown", the feature had no value anywhere in the app, and the
 * number it fixes was only ever computed outside the tool.
 *
 * Only a direct feature of `contextId` (a bare name, not a dotted chain), and
 * only an ASSERTED equation owned by the same context whose one side is that
 * bare name: the defining equation of a feature is written where the feature
 * is, and it is a fact the model states, not a check (see {@link isAsserted}).
 * The feature goes on `inFlight` while its other side is evaluated, so
 * `x == y + 1` beside `y == x - 1` answers `undefined`, not a hang.
 */
function valueDefinedByEquation(
  model: Model,
  contextId: ElementId,
  name: string,
  inFlight: Set<ElementId>,
): unknown {
  if (name.includes('.')) return undefined;
  const feature = effectiveFeatures(model, contextId).find(
    (f) => f.declaredName === name && (f.attrs.value === undefined || f.attrs.value === null),
  );
  if (!feature || inFlight.has(feature.id)) return undefined;
  const equation = definingEquationFor(model, contextId, name);
  if (!equation) return undefined;
  inFlight.add(feature.id);
  let value: unknown;
  try {
    const r = evaluate(equation.definition, scopeWith(model, contextId, inFlight));
    value = 'value' in r && (typeof r.value === 'number' || typeof r.value === 'boolean') ? r.value : undefined;
  } catch {
    return undefined;
  } finally {
    inFlight.delete(feature.id);
  }
  if (typeof value !== 'number') return value;
  // The equation must also hold as QUANTITIES, with the feature read as that
  // number in its declared kind: `t == d` across a duration and a length is a
  // dimension clash, `dT == t1` on an offset scale is refused — neither fills
  // its feature with a raw magnitude, because the refusal is the answer.
  const kind = quantityKindOf(model, feature.id);
  const asQuantity = { magnitude: value, dimension: kind.dimension ?? DIMENSIONLESS };
  const judged = evaluateConstraintQuantityDetailed(model, equation.constraint, {
    fallback: (ref) => (ref === name ? asQuantity : undefined),
  });
  return isRefusalReason(judged.reason) ? undefined : value;
}

/** An asserted equation `name == <expr>` (either way round) among the constraints `ownerId` owns. */
function definingEquationFor(
  model: Model,
  ownerId: ElementId,
  name: string,
): { constraint: ElementRecord; definition: ExprNode } | undefined {
  for (const c of model.children(ownerId)) {
    if (!isAsserted(c)) continue;
    const side = definedSide(c, name);
    if (side) return { constraint: c, definition: side };
  }
  return undefined;
}

/**
 * Is `el` an `assert constraint` — the one constraint whose equation may
 * DEFINE a value? An assert states a fact about the model; a `require` or
 * `assume` clause, and a plain `constraint` usage, are checks of values the
 * model gives elsewhere. Reading those as definitions too made a brief's test
 * condition, `require constraint { jammedFraction == 0.5 }` on a measure that
 * carries no value by design, report "defines jammedFraction = 0.5" — a value
 * the model never stated — while the budget beside it (`<= 12`) read "has no
 * value anywhere". The verification lane already files the roles this way
 * (`assert` an axiom, `require` an obligation: `roleOf` in obligations.ts),
 * so the literal reading now agrees with it. The mapper records the clause
 * keyword on `attrs.requirementRole`, wherever the clause is written.
 */
function isAsserted(el: ElementRecord): boolean {
  return el.eClass === 'ConstraintUsage' && el.attrs.requirementRole === 'assert';
}

/**
 * When `constraint` reads `name == <expr>` or `<expr> == name`, the `<expr>`
 * side; else `undefined`. `=` is the same equation in the solver's spelling.
 */
function definedSide(constraint: ElementRecord, name: string): ExprNode | undefined {
  const expr = constraint.attrs.expression;
  if (typeof expr !== 'string') return undefined;
  let node: ExprNode;
  try {
    node = parseExpr(expr);
  } catch {
    return undefined;
  }
  if (node.kind !== 'binary' || (node.op !== '==' && node.op !== '=')) return undefined;
  const isName = (n: ExprNode): boolean => n.kind === 'ref' && n.path.length === 1 && n.path[0] === name;
  if (isName(node.left)) return node.right;
  if (isName(node.right)) return node.left;
  return undefined;
}

/**
 * The feature an asserted equation defines — its bare name, when the
 * constraint is an `assert constraint` reading `name == <expr>` and `name` is
 * a valueless feature of the constraint's owner — or `undefined` for any other
 * constraint, a `require`d equation of the same shape included.
 */
export function definedFeatureOf(model: Model, constraint: ElementRecord): ElementRecord | undefined {
  if (constraint.ownerId == null || !isAsserted(constraint)) return undefined;
  const expr = constraint.attrs.expression;
  if (typeof expr !== 'string') return undefined;
  let node: ExprNode;
  try {
    node = parseExpr(expr);
  } catch {
    return undefined;
  }
  if (node.kind !== 'binary' || (node.op !== '==' && node.op !== '=')) return undefined;
  for (const side of [node.left, node.right]) {
    if (side.kind !== 'ref' || side.path.length !== 1) continue;
    const name = side.path[0]!;
    const feature = effectiveFeatures(model, constraint.ownerId).find(
      (f) => f.declaredName === name && (f.attrs.value === undefined || f.attrs.value === null),
    );
    if (feature) return feature;
  }
  return undefined;
}

/**
 * The name → feature-id map a scope rooted at `contextId` resolves through:
 * every valued feature reachable from the context, under its dotted chain and
 * its bare name (first occurrence wins). Exposed so a caller can ask WHICH
 * feature a name denotes before deciding how to compare it.
 */
export function featureIdsFor(model: Model, contextId: ElementId): Map<string, ElementId> {
  const ids = new Map<string, ElementId>();
  collectIds(model, contextId, '', ids, new Set(), new Set());
  return ids;
}

function collectIds(
  model: Model,
  ownerId: ElementId,
  prefix: string,
  ids: Map<string, ElementId>,
  visited: Set<string>,
  onPath: Set<ElementId>,
): void {
  // TWO guards, because they answer different questions. `onPath` is the CYCLE
  // guard and must be keyed on the owner ALONE: a feature whose type is one of
  // its own owners (`item def Person { timeslice asPresident : Person; }`)
  // generates an unbounded name tower `asPresident.asPresident…`, and a key
  // that carries the prefix never repeats, so it cannot see the cycle — it
  // recursed until the stack died. `visited` is only a work bound for a
  // diamond reached twice at the SAME prefix, so it keeps the prefix in its
  // key: two sibling features of one type (`part a : T; part b : T;`) are
  // different scopes and both must be walked.
  if (onPath.has(ownerId)) return;
  const guardKey = `${prefix} ${ownerId}`;
  if (visited.has(guardKey)) return;
  visited.add(guardKey);
  onPath.add(ownerId);

  for (const feat of effectiveFeatures(model, ownerId)) {
    const name = feat.declaredName;
    if (!name) continue;
    const full = prefix ? `${prefix}.${name}` : name;
    if (feat.attrs.value !== undefined && feat.attrs.value !== null) {
      if (!ids.has(full)) ids.set(full, feat.id);
      if (!ids.has(name)) ids.set(name, feat.id); // bare-name convenience
    }
    // Expose nested features via the feature's declared type(s).
    for (const type of model.typesOf(feat.id)) {
      collectIds(model, type.id, full, ids, visited, onPath);
    }
  }

  onPath.delete(ownerId);
}

/**
 * The value of one feature: a literal directly, an expression through the
 * feature's owner scope. A cycle (`a = b + 1; b = a + 1`) yields `undefined`
 * rather than a hang — the conservative answer.
 */
function valueOfFeature(model: Model, id: ElementId, inFlight: Set<ElementId>): unknown {
  const feat = model.get(id);
  if (!feat) return undefined;
  const raw = feat.attrs.value;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  if (inFlight.has(id)) return undefined;
  inFlight.add(id);
  try {
    const inner = feat.ownerId != null ? scopeWith(model, feat.ownerId, inFlight) : () => undefined;
    const r = evaluate(parseExpr(s), inner);
    return 'value' in r ? r.value : undefined;
  } catch {
    return undefined;
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Evaluate a feature's value expression (`attrs.value`, else `attrs.expression`)
 * against a scope built from its owner. Returns `{ unknown: true }` when there
 * is nothing to evaluate or a referenced name is unresolved.
 */
export function evaluateFeatureValue(model: Model, featureId: ElementId): EvalResult {
  const el = model.get(featureId);
  if (!el) return { unknown: true };
  const raw = el.attrs.value !== undefined ? el.attrs.value : el.attrs.expression;
  if (raw === undefined || raw === null) {
    // No value of its own: the equation beside it may fix one (CV-17).
    if (el.declaredName && el.ownerId != null) {
      const v = scopeFor(model, el.ownerId)(el.declaredName);
      if (v !== undefined) return { value: v };
    }
    return { unknown: true };
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return { value: raw };
  if (typeof raw !== 'string') return { unknown: true };
  const scope = scopeFor(model, el.ownerId ?? featureId);
  try {
    return evaluate(parseExpr(raw), scope);
  } catch {
    return { unknown: true };
  }
}


/** A single constraint-check outcome. */
export interface ConstraintCheck {
  /** Element id of the constraint/requirement carrying the expression. */
  id: ElementId;
  /** Owner element id (the subject/requirement context), if any. */
  ownerId: ElementId | null;
  /** The boolean expression source that was evaluated. */
  expression: string;
  result: 'satisfied' | 'violated' | 'unknown';
  message: string;
  /**
   * The body read once per context through the features that specialise a
   * measure it names — set only when the measure has no value where the
   * constraint is written and something specialises it. `result` stays the
   * constraint's own answer (`unknown`): the instances are readings of it
   * elsewhere, and two contexts may disagree. See {@link SpecialisationInstance}.
   */
  instances?: SpecialisationInstance[];
}

/**
 * One reading of a target through the features that specialise the measure it
 * names, in one context.
 *
 * The shape is a brief's: `package Common { attribute m : Real; require
 * constraint t { m >= 0.9 } }` states the target on an abstract measure that
 * carries no value by design, and each layer gives its own estimate as a
 * feature that subsets or redefines it (`package LA { attribute m :>
 * Common::m = 0.78; }`). Every value of `LA::m` is a value of `Common::m`, so
 * an estimate that misses the target is a real miss — but `LA` and `PA` may
 * disagree, so no single value is invented for `Common`: the target is read
 * once per context, and the constraint's own verdict stays unknown.
 */
export interface SpecialisationInstance {
  /** The namespace the specialiser is written in (`LA`, `PA`): the instance's context. */
  contextId: ElementId;
  /** The context's name, as the messages print it. */
  context: string;
  /**
   * The feature the instance is anchored at: the specialiser of the first
   * measure the body names (a context that specialises none of them is never
   * an instance).
   */
  featureId: ElementId;
  /** The anchor's fully qualified name. */
  qualifiedName: string;
  /** The anchor's value, when it has one that could be read. */
  value?: number | boolean | string;
  /** Each measure the body names, and the feature that stands for it in this context. */
  bindings: SpecialisationBinding[];
  result: 'satisfied' | 'violated' | 'unknown';
  /**
   * The finding, worded for the specialiser it is anchored at —
   * `LA::m = 0.78 misses Common::t (m >= 0.9)` — and shared by the validator
   * and the app's Check, so both say the same thing.
   */
  message: string;
}

/** One measure of a {@link SpecialisationInstance}, bound to its specialiser. */
export interface SpecialisationBinding {
  /** The bare name the body reads. */
  name: string;
  featureId: ElementId;
  qualifiedName: string;
  value?: number | boolean | string;
  /** The unit the value is written in, when it carries one. */
  unit?: string;
}

/**
 * Evaluate every ConstraintUsage / RequirementUsage that carries a boolean
 * expression (`attrs.expression`, e.g. from a `require { … }` clause) against a
 * scope built from its subject context (its owner, then itself), classifying
 * each as satisfied / violated / unknown.
 *
 * A constraint left unknown because it names a measure with no value where it
 * is written is also read through the features that specialise that measure,
 * once per context — see {@link SpecialisationInstance}.
 */
export function checkConstraints(model: Model): ConstraintCheck[] {
  const out: ConstraintCheck[] = [];
  // One derivation cache for the sweep; every constraint reads the same features.
  const memo: DerivationMemo = new Map();
  for (const el of model.ofKind('ConstraintUsage', 'RequirementUsage')) {
    const expr = el.attrs.expression;
    if (typeof expr !== 'string' || expr.trim() === '') continue;

    const judged = judgeConstraint(model, el, expr, memo);
    const check: ConstraintCheck = {
      id: el.id,
      ownerId: el.ownerId,
      expression: expr,
      result: judged.result,
      message: judged.message,
    };
    if (judged.gap) readThroughSpecialisers(model, el, expr, check, memo);
    out.push(check);
  }
  return out;
}

/** A name a target is read through: the specialiser standing for a measure. */
interface Bound {
  featureId: ElementId;
  /** The scalar value, as the scalar scope would answer it. */
  value: unknown;
  /** The same value as a quantity, for the unit-aware path (absent for a boolean). */
  quantity?: Quantity;
  /**
   * The derivation a defining equation gives the feature (CV-17), which its
   * own derivation record cannot carry: it states no value to derive.
   */
  derivation?: FeatureDerivation;
}

/** What one pass of the pipeline made of a constraint. */
interface Judgement {
  result: 'satisfied' | 'violated' | 'unknown';
  message: string;
  /**
   * True when the answer is unknown only because a referenced value is
   * missing — not a refusal, not a parse failure — so reading the body
   * through a specialiser of the missing measure may answer it.
   */
  gap: boolean;
}

/**
 * The one pipeline every constraint is judged by — unit-aware first, then the
 * refusals, then the scalar path — with `bindings` naming the features that
 * stand for some of its names (a target read through a specialiser). A target
 * read in another context is judged by exactly the rules its own context
 * would be: a second, scalar-only evaluator here would hand a dimensioned
 * specialiser the raw-magnitude verdict the refusals exist to prevent.
 *
 * The same holds for a feature fixed by an asserted equation in the
 * constraint's OWN context: it is bound exactly as a specialiser is (see
 * {@link equationBindings}), so `e >= 45.0` beside `assert constraint { e ==
 * capacity / power }` is not the unit-blind 0.98 < 45 the scalar scope alone
 * answered, while the same estimate read from another package was refused.
 */
function judgeConstraint(
  model: Model,
  el: ElementRecord,
  expr: string,
  memo: DerivationMemo,
  bindings?: ReadonlyMap<string, Bound>,
): Judgement {
  const local = equationBindings(model, el, expr, memo, bindings);
  if ('reason' in local) return { result: 'unknown', message: `Could not evaluate: ${local.reason}`, gap: false };
  // The equation a feature is bound FROM is not judged against that binding:
  // a kind relabels a dimensionless derivation (`endurance : DurationValue`
  // over unitless Real inputs is 3544.62 s), and the unit-aware `==` of that
  // with the dimensionless side it came from is a definite false — the
  // definition reported violated by its own reading. It is judged as it
  // always was; the binding only says, below, what it defines.
  const judgeWith = new Map([...(bindings ?? []), ...local.bindings]);
  if (local.self !== undefined) judgeWith.delete(local.self);
  const all = judgeWith.size === 0 ? bindings : judgeWith;
  const judged = judgeBound(model, el, expr, memo, all);
  // An equation that fixes a valueless feature is not a check that passed
  // but a definition that was read: say what it fixed the feature to — as
  // the quantity the equation derives, so `640 [Wh] / 650 [W]` reads 3544.62 s,
  // not the 0.984615 that is hours to no one. A reading through a specialiser
  // is a check of the target, never a definition.
  if (judged.result !== 'satisfied' || bindings) return judged;
  const defines = definitionMessage(model, el, local.bindings);
  return defines ? { ...judged, message: defines } : judged;
}

/** The pipeline of {@link judgeConstraint} over one set of bindings. */
function judgeBound(
  model: Model,
  el: ElementRecord,
  expr: string,
  memo: DerivationMemo,
  bindings?: ReadonlyMap<string, Bound>,
): Judgement {
  const uaOpts: ConstraintQuantityOptions = bindings
    ? { memo, bind: (name) => bindings.get(name)?.quantity }
    : { memo };

  let node;
  try {
    node = parseExpr(expr);
  } catch (e) {
    // The scalar grammar rejects unit literals (`2000 [kg]`); retry with the
    // unit-aware evaluator before giving up. When the text does carry a
    // bracket, the unit-aware reason is the real one — "Unexpected character
    // '['" told the author the intended syntax was illegal.
    const ua = unitAwareVerdict(model, el, expr, uaOpts);
    if ('gap' in ua) return ua;
    if (!expr.includes('[') || ua.detail === undefined) {
      return { result: 'unknown', message: `Could not parse expression: ${(e as Error).message}`, gap: false };
    }
    if (ua.reason === 'parse') {
      // Both parsers refused, but the bracket is not the fault: the body
      // mixes a legal unit literal with syntax neither grammar has (a call
      // such as `DurationOf(x) <= 48 [h]`, an index, a string).
      return {
        result: 'unknown',
        message:
          'Could not evaluate: the body combines a unit literal with syntax the unit-aware evaluator does not ' +
          `support (a call, an index or a string literal) — the \`[unit]\` itself is legal; ${ua.detail}`,
        gap: false,
      };
    }
    return { result: 'unknown', message: `Could not evaluate: ${ua.detail}`, gap: ua.reason === 'unresolved' };
  }

  // UNIT-AWARE FIRST, scalar as the fallback. The scalar evaluator is
  // unit-blind: it compares raw magnitudes, so `640 [Wh]` against `650 [W]`
  // and `45 [min]` produced a confident, WRONG verdict, and the unit-aware
  // evaluator was only consulted once the scalar one had already failed.
  // Unit-aware goes first now; but it answers `unknown` for a dimensioned
  // feature compared with a bare literal (`mtow [kg] <= 25.0` — a unit
  // literal in the body, `<= 25.0 [kg]`, now parses and reaches it verbatim,
  // yet a bare literal is still what most bodies spell), so the scalar path
  // remains the fallback for exactly those, not a hard switch.
  const ua = unitAwareVerdict(model, el, expr, uaOpts);
  if ('gap' in ua) return ua;
  // A reasoned refusal is not a gap the scalar path may fill: arithmetic on
  // an offset scale (`dT == t2 - t1` in °C), a derived feature whose
  // dimension disagrees with its type, and a comparison of two genuinely
  // different dimensions (`d [m] >= t [s]` — `dimension-clash`) all read as
  // plausible raw magnitudes there, and that is precisely the wrong answer
  // being refused. `dimension` is deliberately NOT a refusal: it is the same
  // predicate with a DIMENSIONLESS side (`mtow [kg] <= 25.0`), the
  // bare-literal contract, where reading the literal in the feature's
  // declared unit is what the author meant — that is the fallback below.
  // The membership test lives in units-eval, beside the reasons themselves.
  if (isRefusalReason(ua.reason)) {
    return { result: 'unknown', message: `Could not evaluate: ${ua.detail}`, gap: false };
  }

  // The bare-literal contract holds for a LITERAL-valued feature: its
  // declared unit is the unit the literal is read in. It does not hold for a
  // DERIVED feature — `endurance = capacity * fraction / power` is 2835.7 s
  // or 0.7877 Wh/W depending on who reads it, and the scalar path reads raw
  // magnitudes — so a derived dimensioned feature is never compared as a
  // bare number: answer unknown and name the repair.
  const refusal = derivedBareLiteralRefusal(model, el, node, memo, bindings);
  if (refusal) return { result: 'unknown', message: refusal, gap: false };

  // Scope from the owner (subject context) merged with the constraint itself.
  const own = combinedScope(model, el);
  const scope: Scope = bindings
    ? (name) => {
        const bound = bindings.get(name);
        return bound !== undefined ? bound.value : own(name);
      }
    : own;
  const r = evaluate(node, scope);
  if ('unknown' in r) {
    return { result: 'unknown', message: `Could not evaluate: ${unknownCause(model, el, node, scope)}`, gap: true };
  }
  if (r.value === true) return { result: 'satisfied', message: 'Constraint satisfied', gap: false };
  if (r.value === false) return { result: 'violated', message: `Constraint violated: ${expr}`, gap: false };
  return { result: 'unknown', message: 'Expression did not evaluate to a boolean', gap: false };
}

/**
 * "Constraint satisfied: defines e = 3544.62 [s]" for an asserted equation
 * that fixes a valueless feature of its owner, or `undefined` for any other
 * constraint. The value is the feature's binding — the quantity the equation
 * derives, shown as {@link displayOf} shows an estimate. Where a stated value
 * of the same name answers the scope first, so nothing was bound, it prints
 * what the scope answers, as it always did.
 */
function definitionMessage(model: Model, el: ElementRecord, local: ReadonlyMap<string, Bound>): string | undefined {
  const defined = definedFeatureOf(model, el);
  const name = defined?.declaredName;
  if (!name) return undefined;
  const bound = local.get(name);
  if (bound) {
    const shown = displayOf(bound);
    if (typeof shown.value !== 'number') return undefined;
    return `Constraint satisfied: defines ${name} = ${shown.value}${shown.unit ? ` [${shown.unit}]` : ''}`;
  }
  const value = combinedScope(model, el)(name);
  return typeof value === 'number' ? `Constraint satisfied: defines ${name} = ${Number(value.toPrecision(6))}` : undefined;
}

/* ─────────────── A feature fixed by an asserted equation in the constraint's own context ─────────────── */

/** An asserted equation that fixes a valueless feature, and where it is written. */
interface EquationSite {
  contextId: ElementId;
  feature: ElementRecord;
  equation: { constraint: ElementRecord; definition: ExprNode };
}

/**
 * The bindings for the bare names a body reads that the scalar scope answers
 * through {@link valueDefinedByEquation} — a feature that states no value but
 * is fixed by an asserted equation in the constraint's own context — each read
 * by {@link readSpecialiser}, the reading a specialiser fixed the same way gets
 * when the target is in another package. Names `taken` by a specialiser are
 * left to it.
 *
 * The scalar scope reads such a feature unit-blind (`e == capacity / power`
 * over 640 Wh and 650 W is 0.9846) and the unit-aware scope does not read it at
 * all, so before this a constraint beside the equation compared the raw
 * magnitude — `e >= 45.0` violated, `e >= 45.0 [min]` unknown — where the same
 * estimate read through a specialiser was refused and judged respectively.
 *
 * A refusal, and a dimensioned value with no quantity, are the answer (the
 * `reason`); a feature whose equation yields no value at all is left unbound,
 * so the body stays the gap it was and a target is still read through the
 * features that specialise its measure. `self` is the name bound from `el`
 * itself — the feature `el` is the defining equation of.
 */
function equationBindings(
  model: Model,
  el: ElementRecord,
  expr: string,
  memo: DerivationMemo,
  taken?: ReadonlyMap<string, Bound>,
): { bindings: Map<string, Bound>; self?: string } | { reason: string } {
  const bindings = new Map<string, Bound>();
  let self: string | undefined;
  for (const name of bareNamesIn(expr)) {
    if (taken?.has(name)) continue;
    const site = equationSiteOf(model, el, name);
    if (!site) continue;
    const read = readSpecialiser(model, site.feature, name, memo, site);
    if ('bound' in read) {
      bindings.set(name, read.bound);
      if (site.equation.constraint.id === el.id) self = name;
    } else if (!read.valueless) return { reason: read.reason };
  }
  return { bindings, self };
}

/**
 * The equation the scalar scope would read `name` through, mirroring
 * {@link combinedScope}: the owner's scope first, then the constraint's own,
 * and in each a stated value of that name (anywhere {@link featureIdsFor}
 * reaches) before an equation — `undefined` when one answers it first.
 */
function equationSiteOf(model: Model, el: ElementRecord, name: string): EquationSite | undefined {
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  for (let i = 0; i < contexts.length; i++) {
    const contextId = contexts[i]!;
    const feature = effectiveFeatures(model, contextId).find((f) => f.declaredName === name && !hasValue(f));
    const equation = feature ? definingEquationFor(model, contextId, name) : undefined;
    if (!feature || !equation) continue;
    // The scope-building walk runs only for a name an equation could answer.
    const shadowed = contexts.slice(0, i + 1).some((c) => featureIdsFor(model, c).has(name));
    return shadowed ? undefined : { contextId, feature, equation };
  }
  return undefined;
}

/* ─────────────── Why a feature chain a body reads has no value ─────────────── */

/**
 * The reason a body the scalar scope could not evaluate is unknown: when
 * every name it lacks is a dotted feature chain that ends at a feature
 * declared without a value, one {@link chainCause} per chain; otherwise the
 * generic sentence. A requirement on a configuration item reads its subject's
 * features (`coordination.areaUnderWatchFraction >= 0.9` over `subject
 * coordination : MemberCoordinationSoftware`), and "a referenced value is
 * unknown" named neither the value nor where it is missing.
 */
function unknownCause(model: Model, el: ElementRecord, node: ExprNode, scope: Scope): string {
  const lacking = [...new Set(referencedNames(node))].filter((n) => scope(n) === undefined);
  const causes = lacking.map((n) => (n.includes('.') ? chainCause(model, el, n) : undefined));
  return causes.length > 0 && causes.every((c) => c !== undefined)
    ? causes.join('; ')
    : 'a referenced value is unknown';
}

/**
 * `coordination.areaUnderWatchFraction has no value:
 * MemberCoordinationSoftware::areaUnderWatchFraction is declared without one
 * and nothing specialises it` — the chain resolved through each feature's
 * declared type, as the scope walks it, to the feature it ends at; or
 * `undefined` when the chain does not resolve or ends at a feature that states
 * a value (a value that could not be evaluated is another fault).
 *
 * What it adds, as applies: an equation of the defining shape beside the
 * feature that is not asserted (it checks, it does not define); an asserted
 * one, and the features that specialise it, which a chain does not read — it
 * reads the feature its subject's type declares.
 */
function chainCause(model: Model, el: ElementRecord, chain: string): string | undefined {
  const [head, ...rest] = chain.split('.');
  let feature: ElementRecord | undefined;
  for (const contextId of [el.ownerId, el.id]) {
    if (contextId == null) continue;
    feature = effectiveFeatures(model, contextId).find((f) => f.declaredName === head);
    if (feature) break;
  }
  let via: ElementId | undefined;
  for (const segment of rest) {
    if (!feature) return undefined;
    let next: ElementRecord | undefined;
    for (const type of model.typesOf(feature.id)) {
      next = effectiveFeatures(model, type.id).find((f) => f.declaredName === segment);
      if (next) {
        via = type.id;
        break;
      }
    }
    feature = next;
  }
  const name = feature?.declaredName;
  if (!feature || !name || rest.length === 0 || hasValue(feature)) return undefined;
  const sites = [...new Set([via, feature.ownerId].filter((c): c is ElementId => c != null))];
  const asserted = sites.some((c) => definingEquationFor(model, c, name) !== undefined);
  const checked = !asserted && sites.some((c) => hasUnassertedEquation(model, c, name));
  const specialisers = [...specialisersOf(model, feature).byContext.values()].flat();
  const clauses = [
    `${shortName(model, feature)} is declared without one`,
    ...(checked ? ['has no asserted equation'] : []),
    ...(asserted ? ['its asserted equation is not read through a feature chain'] : []),
    specialisers.length === 0
      ? 'nothing specialises it'
      : `what specialises it (${specialisers.map((f) => shortName(model, f, name)).join(', ')}) is not read through a feature chain`,
  ];
  return `${chain} has no value: ${listed(clauses)}`;
}

/** `a and b`, `a, b, and c`. */
function listed(items: string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * Is `name` the defined side of an equation among the constraints `ownerId`
 * owns that is NOT asserted — a `require`d, assumed or plain `x == <expr>`?
 * That is a check of a value given elsewhere, not a definition (see
 * {@link isAsserted}); a message that says the feature has no value names it,
 * so an author who meant the equation as the definition sees why it is not one.
 */
function hasUnassertedEquation(model: Model, ownerId: ElementId, name: string): boolean {
  return model
    .children(ownerId)
    .some(
      (c) =>
        (c.eClass === 'ConstraintUsage' || c.eClass === 'RequirementUsage') &&
        !isAsserted(c) &&
        definedSide(c, name) !== undefined,
    );
}

/**
 * The unit-aware evaluator's definitive verdict as a {@link Judgement}, or
 * the detailed inconclusive result for the caller to classify.
 */
function unitAwareVerdict(
  model: Model,
  el: ElementRecord,
  expr: string,
  opts: ConstraintQuantityOptions,
): Judgement | ConstraintQuantityResult {
  const ua = evaluateConstraintQuantityDetailed(model, el, opts);
  if (ua.verdict === 'satisfied') return { result: 'satisfied', message: 'Constraint satisfied', gap: false };
  if (ua.verdict === 'violated') return { result: 'violated', message: `Constraint violated: ${expr}`, gap: false };
  return ua;
}

/* ─────────────── A target read through the features that specialise its measure ─────────────── */

/** A measure a body names, as the constraint's own context declares it. */
interface Measure {
  name: string;
  feature: ElementRecord;
}

/** Every feature that specialises one measure, transitively, grouped by context. */
interface Specialisers {
  byContext: Map<ElementId | null, ElementRecord[]>;
  /** Specialiser id → the features it directly subsets or redefines (within the walk). */
  parents: Map<ElementId, Set<ElementId>>;
}

/**
 * Read an unknown constraint through the features that specialise the
 * measures it names, once per context, and say on `check` why its own answer
 * is unknown. See {@link SpecialisationInstance} for the shape this serves.
 *
 * A measure is a bare name the body reads that denotes a VALUELESS feature of
 * the constraint's owner, with no value the scope can find for it (a defining
 * equation beside it already answers it). Its specialisers are the features
 * that subset or redefine it, transitively (`PA::m :>> LA::m :> Common::m`),
 * each in the context — the namespace — it is written in. Per context:
 *  - one chain of specialisers (`b :> a :> Common::m`, both in `LA`) gives
 *    the deepest that states a value or has a defining equation;
 *  - two that are not on one chain (`PA::m` and `PA::n`, both `:> Common::m`)
 *    are not one estimate, and the context's instance is unknown, naming both;
 *  - a context that specialises some of the body's measures but not all is
 *    unknown, naming what it lacks, rather than half-read.
 * A name that already has a value where the constraint is written is read as
 * that value — unless the context specialises it with a value of its own (a
 * usage redefining its definition's default), which is then the one that
 * counts there.
 */
function readThroughSpecialisers(
  model: Model,
  el: ElementRecord,
  expr: string,
  check: ConstraintCheck,
  memo: DerivationMemo,
): void {
  if (el.ownerId == null) return;
  const names = bareNamesIn(expr);
  if (names.length === 0) return;
  const scope = combinedScope(model, el);
  const owned = effectiveFeatures(model, el.ownerId);
  const missing: Measure[] = [];
  const valued: Measure[] = [];
  for (const name of names) {
    if (scope(name) === undefined) {
      const feature = owned.find((f) => f.declaredName === name && !hasValue(f));
      if (feature) missing.push({ name, feature });
    } else {
      const feature = owned.find((f) => f.declaredName === name && hasValue(f));
      if (feature) valued.push({ name, feature });
    }
  }
  if (missing.length === 0) return;

  const walks = new Map<string, Specialisers>();
  for (const m of [...missing, ...valued]) walks.set(m.name, specialisersOf(model, m.feature));

  // Contexts in the order the walk met them, from the measures with no value
  // only: a context that merely overrides a valued name has nothing to answer.
  const contexts: (ElementId | null)[] = [];
  for (const m of missing) {
    for (const ctx of walks.get(m.name)!.byContext.keys()) if (!contexts.includes(ctx)) contexts.push(ctx);
  }

  // The constraint's own message says WHY it is unknown, and where it was read
  // instead. A measure whose only equation beside it is `require`d (or plain)
  // says it has no asserted one: that is the equation an author reads as the
  // definition, and only an assert is one. Beside an asserted equation that
  // yields no value (its inputs have none) the clause would be false.
  const target = targetName(model, el);
  const why = missing.map((m) => {
    const walk = walks.get(m.name)!;
    const checked =
      definingEquationFor(model, el.ownerId!, m.name) === undefined &&
      hasUnassertedEquation(model, el.ownerId!, m.name);
    if (walk.byContext.size === 0) {
      return checked
        ? `${m.name} has no value anywhere, no asserted equation, and nothing specialises it`
        : `${m.name} has no value anywhere and nothing specialises it`;
    }
    const shown: string[] = [];
    for (const cands of walk.byContext.values()) {
      const pick = chooseSpecialiser(model, cands, walk);
      for (const f of 'ambiguous' in pick ? pick.ambiguous : [pick.feature]) shown.push(shortName(model, f, m.name));
    }
    const here = checked ? 'has no value here and no asserted equation' : 'has no value here';
    return `${m.name} ${here}; evaluated per specialisation: ${shown.join(', ')}`;
  });
  // A feature chain the body also lacks keeps its own cause beside them.
  why.push(...chainCausesIn(model, el, expr, scope));
  check.message = `Could not evaluate: ${why.join('; ')}`;
  if (contexts.length === 0) return;

  const instances: SpecialisationInstance[] = [];
  for (const ctx of contexts) {
    const contextName = ctx != null ? nameOf(model.get(ctx)) : '(top level)';
    const bindings = new Map<string, Bound>();
    const shown: SpecialisationBinding[] = [];
    let anchor: ElementRecord | undefined;
    let reason: string | undefined;

    for (const m of missing) {
      const cands = walks.get(m.name)!.byContext.get(ctx);
      if (!cands) {
        reason ??= `${contextName} does not specialise ${m.name}`;
        continue;
      }
      const pick = chooseSpecialiser(model, cands, walks.get(m.name)!);
      anchor ??= 'ambiguous' in pick ? pick.ambiguous[0] : pick.feature;
      if ('ambiguous' in pick) {
        reason ??=
          `${pick.ambiguous.length} features in ${contextName} specialise ${m.name} ` +
          `(${pick.ambiguous.map((f) => shortName(model, f, m.name)).join(', ')}); no one of them is the estimate`;
        continue;
      }
      const read = readSpecialiser(model, pick.feature, m.name, memo);
      const binding: SpecialisationBinding = {
        name: m.name,
        featureId: pick.feature.id,
        qualifiedName: model.qualifiedName(pick.feature.id),
      };
      if ('bound' in read) {
        Object.assign(binding, displayOf(read.bound));
        bindings.set(m.name, read.bound);
      } else {
        reason ??= read.reason;
      }
      shown.push(binding);
    }

    // A valued name the context overrides with a value of its own reads as that.
    for (const m of valued) {
      const cands = walks.get(m.name)!.byContext.get(ctx);
      if (!cands) continue;
      const pick = chooseSpecialiser(model, cands, walks.get(m.name)!);
      if ('ambiguous' in pick) {
        reason ??=
          `${pick.ambiguous.length} features in ${contextName} specialise ${m.name} ` +
          `(${pick.ambiguous.map((f) => shortName(model, f, m.name)).join(', ')}); no one of them is the estimate`;
        continue;
      }
      const read = readSpecialiser(model, pick.feature, m.name, memo);
      if ('bound' in read) bindings.set(m.name, read.bound);
      else if (read.refused) reason ??= read.reason;
    }

    if (!anchor) continue; // unreachable: the context came from a measure's walk
    const judged: Judgement = reason
      ? { result: 'unknown', message: reason, gap: false }
      : judgeConstraint(model, el, expr, memo, bindings);
    const value = shown.find((b) => b.featureId === anchor!.id)?.value;
    const instance: SpecialisationInstance = {
      contextId: ctx ?? anchor.id,
      context: contextName,
      featureId: anchor.id,
      qualifiedName: model.qualifiedName(anchor.id),
      bindings: shown,
      result: judged.result,
      message: instanceMessage(model, judged, shown, contextName, target, expr),
    };
    if (value !== undefined) instance.value = value;
    instances.push(instance);
  }
  if (instances.length > 0) check.instances = instances;
}

/** The finding an instance reports, worded for the specialiser it is anchored at. */
function instanceMessage(
  model: Model,
  judged: Judgement,
  shown: SpecialisationBinding[],
  contextName: string,
  target: string,
  expr: string,
): string {
  if (judged.result !== 'unknown') {
    const values = shown
      .map((b) => `${shortName(model, model.get(b.featureId), b.name)} = ${b.value ?? '?'}${b.unit ? ` [${b.unit}]` : ''}`)
      .join(', ');
    return `${values} ${judged.result === 'violated' ? 'misses' : 'meets'} ${target} (${expr})`;
  }
  const why = judged.message.replace(/^Could not evaluate: /, '');
  return `${target} (${expr}) could not be evaluated for ${contextName}: ${why}`;
}

/**
 * Every feature that subsets or redefines `measure`, transitively, grouped by
 * the namespace it is written in. `source` is the specialiser on both
 * relationships; a cycle (`a :> b`, `b :> a`) is walked once; library
 * features are never a user's estimate.
 */
function specialisersOf(model: Model, measure: ElementRecord): Specialisers {
  const byContext = new Map<ElementId | null, ElementRecord[]>();
  const parents = new Map<ElementId, Set<ElementId>>();
  const queue: ElementId[] = [measure.id];
  while (queue.length > 0) {
    const general = queue.shift()!;
    for (const r of model.relationshipsTo(general)) {
      if (r.eClass !== 'Subsetting' && r.eClass !== 'Redefinition') continue;
      for (const s of r.source ?? []) {
        const specific = model.get(s);
        if (!specific || specific.attrs.isLibrary === true) continue;
        const seen = parents.get(s);
        if (seen) {
          seen.add(general);
          continue;
        }
        if (s === measure.id) continue;
        parents.set(s, new Set([general]));
        const list = byContext.get(specific.ownerId);
        if (list) list.push(specific);
        else byContext.set(specific.ownerId, [specific]);
        queue.push(s);
      }
    }
  }
  return { byContext, parents };
}

/**
 * The specialiser that stands for a measure in one context: of a chain, the
 * deepest that states a value or has a defining equation (else the deepest,
 * which then reads as "no value"); of two that are not on one chain, neither.
 */
function chooseSpecialiser(
  model: Model,
  candidates: ElementRecord[],
  walk: Specialisers,
): { feature: ElementRecord } | { ambiguous: ElementRecord[] } {
  if (candidates.length === 1) return { feature: candidates[0]! };
  // Ordered by the specialisation relation itself, not by distance from the
  // measure: `a :> Common::m, b` beside `b :> Common::m` puts both one step
  // from it, and a distance sort then left them in declaration order — the
  // verdict flipped when the two lines were swapped. A feature's rank is how
  // many of the others it specialises; on one chain the ranks are distinct.
  const rank = new Map(
    candidates.map((f) => [f.id, candidates.filter((g) => g !== f && specialises(f.id, g.id, walk.parents)).length]),
  );
  const sorted = [...candidates].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  for (let i = 1; i < sorted.length; i++) {
    if (!specialises(sorted[i]!.id, sorted[i - 1]!.id, walk.parents)) return { ambiguous: sorted };
  }
  const defined = sorted.filter((f) => hasValue(f) || hasDefiningEquation(model, f));
  return { feature: defined[defined.length - 1] ?? sorted[sorted.length - 1]! };
}

/** Does `specific` reach `general` over the walk's parent links? */
function specialises(specific: ElementId, general: ElementId, parents: Map<ElementId, Set<ElementId>>): boolean {
  const seen = new Set<ElementId>();
  const stack = [specific];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === general) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const p of parents.get(id) ?? []) stack.push(p);
  }
  return false;
}

/**
 * A specialiser's value, as both pipelines read it: the scalar value its own
 * context gives it (a literal, an expression, or the equation beside it —
 * CV-17), and the same value as a quantity: a value's derivation, or the
 * equation's defining side read by the unit-aware evaluator. A derivation it
 * refuses (a dimension that disagrees with the declared type, an offset
 * scale) is refused here too, and a dimensioned feature with no quantity is
 * not compared — neither is ever read as a raw magnitude.
 *
 * `local` reads a feature fixed by an asserted equation in a constraint's own
 * context ({@link equationBindings}) by the same rules: the equation is the one
 * the scalar scope reads there, and the messages name the feature as the body
 * does, as they name a value-expression feature in that context.
 * `valueless` marks the one outcome that is not a reason to refuse: there is
 * no value to read at all.
 */
function readSpecialiser(
  model: Model,
  feature: ElementRecord,
  measure: string,
  memo: DerivationMemo,
  local?: EquationSite,
): { bound: Bound } | { reason: string; refused: boolean; valueless: boolean } {
  const name = local ? measure : shortName(model, feature, measure);
  // A feature fixed by an equation beside it states no value to derive: its
  // quantity is the equation's defining side, read by the unit-aware evaluator.
  const equation =
    local?.equation ??
    (!hasValue(feature) && feature.ownerId != null && feature.declaredName
      ? definingEquationFor(model, feature.ownerId, feature.declaredName)
      : undefined);
  const expression = equation?.constraint.attrs.expression;
  const byEquation =
    typeof expression === 'string'
      ? equationDerivation(model, feature.id, expression, memo, local?.contextId)
      : undefined;
  const d = byEquation ?? dimensionClaimDetail(model, feature.id, memo);
  if (isRefusalReason(d.reason)) {
    const detail =
      d.reason === 'mismatch' || d.reason === 'offset'
        ? describeReason(d.reason, name)
        : `"${name}" cannot be derived: ${describeReason(d.reason!, d.detail)}`;
    return { reason: detail, refused: true, valueless: false };
  }
  let value: unknown;
  if (local) {
    value = valueDefinedByEquation(model, local.contextId, measure, new Set());
  } else {
    const ev = evaluateFeatureValue(model, feature.id);
    value = 'value' in ev ? ev.value : undefined;
  }
  if (value === undefined || value === null) {
    // Only an ASSERTED equation defines (see `isAsserted`), so that is what
    // the message says is missing: "no defining equation", beside a
    // `require`d `x == …`, read as if the tool had not seen the equation.
    return {
      reason:
        hasValue(feature) || equation !== undefined
          ? `${name} has no value that could be evaluated`
          : `${name} has no value and no asserted equation`,
      refused: false,
      valueless: true,
    };
  }
  // Without a quantity the scalar stands in for one only when it IS one: a
  // dimensionless number. Labelling the unit-blind scalar of a dimensioned
  // derivation with its kind read `640 [Wh] / 650 [W]` as 0.98 s, a confident
  // miss of `>= 45.0 [min]` by a value of 59 min; and bound as a bare scalar
  // it still missed `>= 45.0`. A dimensioned feature whose value could not be
  // read as a quantity is not compared at all.
  let quantity = d.q;
  if (!quantity && typeof value === 'number') {
    const kind = quantityKindOf(model, feature.id);
    if (kind.dimension && !dimEqual(kind.dimension, DIMENSIONLESS)) {
      const why = d.reason ? `: ${describeReason(d.reason, d.detail)}` : '';
      return {
        reason:
          `${name} (${kind.name ?? dimToString(kind.dimension)}) has no value that could be read as a ` +
          `quantity${why}, and its raw number is not compared`,
        refused: false,
        valueless: false,
      };
    }
    quantity = { magnitude: value, dimension: DIMENSIONLESS };
  }
  return {
    bound: {
      featureId: feature.id,
      value,
      ...(quantity ? { quantity } : {}),
      ...(byEquation?.q ? { derivation: byEquation } : {}),
    },
  };
}

function hasValue(f: ElementRecord): boolean {
  return f.attrs.value !== undefined && f.attrs.value !== null;
}

function hasDefiningEquation(model: Model, f: ElementRecord): boolean {
  return f.ownerId != null && !!f.declaredName && definingEquationFor(model, f.ownerId, f.declaredName) !== undefined;
}

/** The bare (undotted) names a body reads, once each, in source order. */
function bareNamesIn(expr: string): string[] {
  return namesIn(expr).filter((n) => !n.includes('.'));
}

/** Every name a body reads, once each, in source order — through either grammar. */
function namesIn(expr: string): string[] {
  let refs: string[] | undefined;
  try {
    refs = referencedNames(parseExpr(expr));
  } catch {
    refs = quantityRefsIn(expr);
  }
  return [...new Set(refs ?? [])];
}

/** The {@link chainCause} of each feature chain a body reads that `scope` has no value for, where one can be named. */
function chainCausesIn(model: Model, el: ElementRecord, expr: string, scope: Scope): string[] {
  return namesIn(expr)
    .filter((n) => n.includes('.') && scope(n) === undefined)
    .map((n) => chainCause(model, el, n))
    .filter((c): c is string => c !== undefined);
}

/** `Common::t`, or "a constraint in Common" for an unnamed one. */
function targetName(model: Model, el: ElementRecord): string {
  const owner = el.ownerId != null ? model.get(el.ownerId) : undefined;
  const ownerName = nameOf(owner);
  const own = el.declaredName ?? el.declaredShortName;
  return own ? `${ownerName}::${own}` : `a constraint in ${ownerName}`;
}

/**
 * `LA::m` — the context's name and the feature's, as the findings print it.
 * An unnamed redefinition (`attribute :>> mass = 5`) is named by the measure
 * it redefines, as the notation means it to be.
 */
function shortName(model: Model, f: ElementRecord | undefined, measure?: string): string {
  if (!f) return '?';
  const own = f.declaredName ?? f.declaredShortName ?? measure ?? nameOf(f);
  const owner = f.ownerId != null ? model.get(f.ownerId) : undefined;
  return owner ? `${nameOf(owner)}::${own}` : own;
}

function nameOf(el: ElementRecord | undefined): string {
  if (!el) return '?';
  return el.declaredName ?? el.declaredShortName ?? `«${el.eClass}»`;
}

/**
 * A bound value as an instance reports it, to six significant figures. A
 * dimensioned quantity is shown as it was COMPARED — in its own unit, or in
 * the coherent SI unit when it carries none (a derivation): the scalar
 * `0.9846` of `640 [Wh] / 650 [W]` is hours to no one, and printed beside
 * `>= 45.0 [min]` it read as a miss of a target it meets.
 */
function displayOf(b: Bound): { value?: number | boolean | string; unit?: string } {
  const round = (n: number): number => (Number.isFinite(n) ? Number(n.toPrecision(6)) : n);
  const q = b.quantity;
  if (q && !dimEqual(q.dimension, DIMENSIONLESS)) {
    if (q.unit) return { value: round(q.magnitude), unit: q.unit };
    const [unit] = unitsOfDimension(q.dimension);
    return unit && unit !== 'unit' ? { value: round(q.magnitude), unit } : { value: round(q.magnitude) };
  }
  const v = b.value;
  if (typeof v === 'number') return { value: round(v) };
  if (typeof v === 'boolean' || typeof v === 'string') return { value: v };
  return {};
}

/**
 * The refusal message when `node` reads an expression-valued feature whose
 * derivation carries a physical dimension — or `undefined` when the scalar
 * fallback may run. The repair depends on what the feature claims: a feature
 * TYPED by a kind is compared against a unit literal of that dimension (the
 * example uses the body's own literal with the registry's units of the
 * dimension, `45.0 [s]` or `45.0 [min]`); an UNTYPED one (`r2 = mtow / 25.0`)
 * is usually meant as a ratio whose inlined constant lost its unit, so the
 * honest repair is `mtow / 25.0 [kg]`, not a mass literal on the other side.
 */
function derivedBareLiteralRefusal(
  model: Model,
  el: ElementRecord,
  node: ExprNode,
  memo: DerivationMemo,
  bindings?: ReadonlyMap<string, Bound>,
): string | undefined {
  const ownerIds = el.ownerId != null ? featureIdsFor(model, el.ownerId) : undefined;
  const selfIds = featureIdsFor(model, el.id);
  for (const name of referencedNames(node)) {
    // A name read through a specialiser is that feature here: its derivation
    // is the one a bare literal would be compared against.
    const bound = bindings?.get(name);
    const id = bound?.featureId ?? ownerIds?.get(name) ?? selfIds.get(name);
    if (id === undefined) continue;
    const derivation = bound?.derivation ?? dimensionClaimDetail(model, id, memo);
    const d = derivation.derived;
    if (!d || dimEqual(d, DIMENSIONLESS)) continue;
    const literal = firstNumericLiteral(node) ?? '45.0';
    const units = unitsOfDimension(d);
    const examples = units.map((u) => `\`${literal} [${u}]\``).join(' or ');
    const head =
      `Could not evaluate: "${name}" is derived from dimensioned quantities (${dimToString(d)}) and cannot be ` +
      'compared as a bare number; ';
    if (derivation.typeName === undefined) {
      return (
        head +
        'if it is meant as a pure ratio, give the inlined constant its unit so the dimensions cancel ' +
        `(\`… / 25.0 [${units[0]}]\`); otherwise type it by the ISQ kind of dimension ${dimToString(d)} ` +
        `and compare against a unit literal, e.g. ${examples}`
      );
    }
    return head + `compare against a unit literal of dimension ${dimToString(d)}, e.g. ${examples}`;
  }
  return undefined;
}

/** Every dotted reference in an expression tree, in source order. */
function referencedNames(node: ExprNode): string[] {
  switch (node.kind) {
    case 'ref':
      return [node.path.join('.')];
    case 'unary':
      return referencedNames(node.operand);
    case 'binary':
      return [...referencedNames(node.left), ...referencedNames(node.right)];
    case 'if':
      return [...referencedNames(node.cond), ...referencedNames(node.then), ...referencedNames(node.else)];
    default:
      return [];
  }
}

/** The first numeric literal in an expression tree, rendered as written-ish. */
function firstNumericLiteral(node: ExprNode): string | undefined {
  switch (node.kind) {
    case 'num':
      return Number.isInteger(node.value) ? `${node.value}.0` : String(node.value);
    case 'unary':
      return firstNumericLiteral(node.operand);
    case 'binary':
      return firstNumericLiteral(node.left) ?? firstNumericLiteral(node.right);
    case 'if':
      return firstNumericLiteral(node.cond) ?? firstNumericLiteral(node.then) ?? firstNumericLiteral(node.else);
    default:
      return undefined;
  }
}

/**
 * Up to three registry unit symbols of a dimension, the coherent SI one first
 * (`s`, `min`, `h` for T; `kg`, `g`, `lb` for M), offset scales excluded; `unit`
 * when the registry has none.
 */
function unitsOfDimension(d: Dimension): string[] {
  const all = UNIT_REGISTRY.filter((x) => !x.offsetSI && dimEqual(x.dimension, d));
  const coherent = all.filter((x) => x.factorToSI === 1);
  const others = all.filter((x) => x.factorToSI !== 1);
  const symbols = [...coherent, ...others].map((x) => x.symbol);
  const unique = symbols.filter((s, i) => symbols.indexOf(s) === i).slice(0, 3);
  return unique.length > 0 ? unique : ['unit'];
}

/** Merge the owner scope and the element's own scope (owner takes priority). */
function combinedScope(model: Model, el: ElementRecord): Scope {
  const ownerScope = el.ownerId != null ? scopeFor(model, el.ownerId) : undefined;
  const selfScope = scopeFor(model, el.id);
  return (name: string) => {
    if (ownerScope) {
      const v = ownerScope(name);
      if (v !== undefined) return v;
    }
    return selfScope(name);
  };
}

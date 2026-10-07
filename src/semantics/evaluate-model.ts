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
import {
  DefiningEquations,
  GUARD_CONTACT,
  MAX_DERIVATION_DEPTH,
  chooseDefinition,
  definedSide,
  definingEquationFor,
  definitionKey,
  definitionsInFlight,
  instanceKey,
  clashSentence,
  contradictionSentence,
  bindingEndPath,
  defaultGivesWay,
  hasStatedValue,
  isAsserted,
  isBindingConnector,
  isCalculationValue,
  mergeContact,
  namesDefinedBy,
  isCall,
  isDerivedValue,
  returnTo,
  shadowedEquation,
  shadowedNamesOf,
  shadowedSentence,
  sharedDefinitions,
  statedValueOf,
  type Contact,
  type DefiningEquation,
  type InFlight,
  type NameClash,
} from './defining-equation';
import { effectiveFeatures, effectiveNameOf, effectiveQualifiedName, redefinedClosure } from './inheritance';
import { evaluateDecided, statedRational, tieSentence, type ExactScope, type Rational } from './exact';
import { parseExpr, type EvalResult, type ExprNode } from './expr';
import {
  NO_MARKERS,
  bareLiteralRefusal,
  derivedBareLiteral,
  derivedOperand,
  namesReadIn,
  absoluteOperandFault,
  offsetFaultIn,
  operandRefusal,
  parseRelationBody,
  relationVarsOf,
  unitsOfDimension,
  valueFaultOf,
  type MarkerDimensions,
} from './relations';
import { DIMENSIONLESS, dimEqual, dimToString } from './units';
import {
  boundDerivation,
  definitionDerivation,
  describeReason,
  equationDerivation,
  siValue,
  dimensionClaimDetail,
  dimensionalFacets,
  evaluateConstraintQuantityDetailed,
  isRefusalReason,
  quantityKindOf,
  quantityRefsIn,
  refusalSentence,
  siExact,
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
 *
 * The scope is one evaluation pass ({@link ScalarPass}): what its lookups
 * settle, it keeps for the lookups after them, and for no other scope.
 */
export function scopeFor(model: Model, contextId: ElementId): Scope {
  return scopeWith(model, contextId, newPass(model));
}

/**
 * One scalar evaluation pass — one {@link checkConstraints} sweep, one
 * {@link evaluateFeatureValue}, one {@link scopeFor} scope — and what it has
 * settled. A feature's value is derived through its OWN owner scope, and a
 * defining equation through its context's, so without a memo every lookup
 * re-derived its operands along every reference PATH: a fan-out of equations
 * (`f_i == f_{i-1} + f_{i-2}`) took 47 s at 22 links, and checkConstraints on
 * a 200-link loop 105 s. A pass never outlives its caller — the app re-checks
 * the model on every edit, and a cache that survived one would answer for a
 * model that no longer exists.
 *
 * An answer is settled only when it is a fact about the model: one that met
 * the derivation stack ({@link Contact} — a loop, an equation read back, a
 * depth limit) depends on what else was being derived when it was asked, and
 * is derived again where it is asked again.
 */
interface ScalarPass {
  model: Model;
  /** Settled answers: a value expression's by its feature id, a definition's by {@link definitionKey}. */
  answers: Map<string, ScalarAnswer>;
  inFlight: InFlight;
  /** The defining equations and the names of every scope the pass reads ({@link DefiningEquations.scope}). */
  definitions: DefiningEquations;
  /** The unit-aware derivations of the same pass. */
  memo: DerivationMemo;
  /** The names of the model's derived values ({@link derivedNames}), built on first use. */
  calculations?: Set<string>;
  /** {@link derivedElsewhere}'s answer per relation, reading context and name (`null` for none), built on first use. */
  elsewhere?: Map<string, ElementRecord | null>;
}

function newPass(model: Model): ScalarPass {
  return {
    model,
    answers: new Map(),
    inFlight: new Map(),
    definitions: sharedDefinitions(model),
    memo: new Map(),
  };
}

/** What the scalar scope answers for one feature. */
interface ScalarAnswer {
  value: unknown;
  /**
   * A number's exact reading: the decimals written, carried through exact
   * arithmetic (`evaluateDecided` of ./exact) — what a comparison over it is
   * decided by. Absent where it has none.
   */
  exact?: Rational;
  /**
   * How many defining equations it reads through, nested — itself included
   * when it is one — as the unit-aware derivation counts them.
   */
  depth: number;
  /** How it met the derivation stack, when it did: it is then never settled. */
  contact?: Contact;
  /** With no value: how its lack of one met the stack (the `cause` {@link chooseDefinition} reads). */
  cause?: Contact;
  /**
   * True when it has no value because its defining equations nest more than
   * {@link MAX_DERIVATION_DEPTH} deep: the cap the unit-aware derivation
   * answers `depth` at. The scalar path used to read on past it, so a chain
   * the unit-aware path refused was still compared — as a raw number.
   */
  deep?: boolean;
}

const NO_ANSWER: ScalarAnswer = { value: undefined, depth: 0 };

/**
 * What a derivation's scope met: the deepest nest of definitions under what it
 * read, its contact, and the contact of the inputs that had no value.
 */
interface ScalarReads {
  depth: number;
  contact?: Contact;
  cause?: Contact;
  deep?: boolean;
}

function note(reads: ScalarReads, a: ScalarAnswer): void {
  reads.depth = Math.max(reads.depth, a.depth);
  reads.contact = mergeContact(reads.contact, a.contact);
  if (a.value === undefined) reads.cause = mergeContact(reads.cause, a.cause);
  if (a.deep) reads.deep = true;
}

/** The answer of a value expression (or of anything that reads definitions without being one) over `reads`. */
function settled(value: unknown, reads: ScalarReads, exact?: Rational): ScalarAnswer {
  return {
    value,
    ...(exact !== undefined && typeof value === 'number' ? { exact } : {}),
    depth: reads.depth,
    ...(reads.contact ? { contact: reads.contact } : {}),
    ...(value === undefined && reads.cause ? { cause: reads.cause } : {}),
    ...(value === undefined && reads.deep ? { deep: true } : {}),
  };
}

/** No value, because the derivation came back to a feature in flight: `contact` is also the cause. */
function cameBackTo(contact: Contact): ScalarAnswer {
  return { ...NO_ANSWER, contact, cause: contact };
}

/**
 * A scope whose lookups are LAZY: names map to feature ids, and a feature's
 * value is computed on demand — through its OWN owner scope when it is an
 * expression — with the pass's stack guarding against a derivation cycle.
 * Given `reads`, it is a derivation's scope, and records what its lookups met.
 *
 * The previous scope stored values eagerly via a scope-less literal evaluation,
 * so an expression-valued attribute (`enduranceMin = capacity / power * 60.0`)
 * evaluated to unknown and was silently OMITTED from the scope: a constraint
 * that referenced it reported "a referenced value is unknown" while the solver
 * computed it fine. `evaluateFeatureValue` already did the right thing; it was
 * never consulted from here.
 */
function scopeWith(model: Model, contextId: ElementId, pass: ScalarPass, reads?: ScalarReads): Scope {
  return (name: string) => {
    const a = answerFor(model, contextId, name, pass);
    if (a && reads) note(reads, a);
    return a?.value;
  };
}

/**
 * {@link scopeWith}, with the exact reading of each number it answers
 * ({@link ScalarAnswer.exact}) beside it: the answer a name's value came
 * from is the one its exact reading is taken from, asked once.
 */
function decidedScopeWith(
  model: Model,
  contextId: ElementId,
  pass: ScalarPass,
  reads?: ScalarReads,
): { value: Scope; exact: ExactScope } {
  const answered = new Map<string, ScalarAnswer | undefined>();
  const answer = (name: string): ScalarAnswer | undefined => {
    if (answered.has(name)) return answered.get(name);
    const a = answerFor(model, contextId, name, pass);
    answered.set(name, a);
    if (a && reads) note(reads, a);
    return a;
  };
  return { value: (name) => answer(name)?.value, exact: (name) => answer(name)?.exact };
}

/**
 * The scope's answer for `name` in `contextId`: a stated value first — read
 * in the context that changes what it reads, where one does
 * ({@link DefiningEquations.readAt}) — then the equation that fixes it.
 */
function answerFor(model: Model, contextId: ElementId, name: string, pass: ScalarPass): ScalarAnswer | undefined {
  const id = idsIn(pass, contextId).get(name);
  if (id !== undefined) return valueOfFeature(model, id, pass, pass.definitions.readAt(contextId, name));
  return (
    valueDefinedByEquation(model, contextId, name, pass) ??
    valueBoundTo(model, contextId, name, pass) ??
    valueThroughChain(model, contextId, name, pass)
  );
}

/**
 * The value the asserted definition of the feature a dotted chain ends at
 * gives it, read where that definition is written — when the chain reads the
 * feature its type declares and changes nothing the definition reads — and
 * else in the usage the chain reads it through, over that usage's names
 * ({@link DefiningEquations.chainDefinition}): `p.e`, over `part p : P` and
 * P's `assert constraint { e == a * b }`, is P's e, and p's own where p
 * redefines `a`. The solver lane solves that feature from that equation; this
 * scope did not read it at all, so every relation over `p.e` was undecided
 * here and decided there. `undefined` for any other name.
 */
function valueThroughChain(model: Model, contextId: ElementId, name: string, pass: ScalarPass): ScalarAnswer | undefined {
  const end = pass.definitions.chainDefinition([contextId], name);
  if (!end) return undefined;
  const own = pass.definitions.nameOf(end.feature)!;
  // Read in the usage that changes what the definition reads: its own value there.
  if (end.at !== end.site) return defineIn(model, end.at, end.feature, own, pass.definitions.of(end.site, own), pass, true);
  return valueDefinedByEquation(model, end.site, own, pass);
}

/**
 * The value of a feature that states none and has no defining equation, but
 * which a BINDING holds to a derived value ({@link boundDerivation}): `x` in
 * `attribute x; bind x = e;`, read as the quantity `e` derives, in coherent SI.
 * The solver lane always solved it from the binding; this scope did not read
 * it at all. `undefined` for any other name.
 */
function valueBoundTo(model: Model, contextId: ElementId, name: string, pass: ScalarPass): ScalarAnswer | undefined {
  const d = boundOf(model, contextId, name, pass)?.derivation;
  if (!d) return undefined;
  const value = d.q ? siValue(d.q) : d.b;
  const exact = d.q ? siExact(d.q) : undefined;
  return value === undefined ? undefined : { value, ...(exact ? { exact } : {}), depth: d.depth ?? 0 };
}

/** The valueless, undefined feature `name` denotes in `contextId`, and the derivation a binding gives it. */
function boundOf(
  model: Model,
  contextId: ElementId,
  name: string,
  pass: ScalarPass,
): { feature: ElementRecord; derivation: FeatureDerivation } | undefined {
  if (name.includes('.')) return undefined;
  const feature = pass.definitions.feature(contextId, name);
  if (!feature || pass.definitions.of(contextId, name).length > 0) return undefined;
  const derivation = boundDerivation(model, feature.id, pass.memo);
  return derivation ? { feature, derivation } : undefined;
}

function idsIn(pass: ScalarPass, contextId: ElementId): ReadonlyMap<string, ElementId> {
  return pass.definitions.scope(contextId, 'value');
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
 * A definition the context INHERITS is read where it is written, when the
 * context changes nothing it reads, and in the context, over its own names,
 * when it does ({@link DefiningEquations.definitionReadIn}).
 * Of several, the one {@link chooseDefinition} picks — the rule the unit-aware
 * derivation reads too. The feature goes on the stack while its other side is
 * evaluated, so `x == y + 1` beside `y == x - 1` answers no value, not a hang;
 * and past {@link MAX_DERIVATION_DEPTH} nested definitions it answers none
 * either (`deep`), as the unit-aware derivation answers `depth` there.
 * `undefined` when no equation may define `name` in `contextId` at all.
 */
function valueDefinedByEquation(
  model: Model,
  contextId: ElementId,
  name: string,
  pass: ScalarPass,
): ScalarAnswer | undefined {
  if (name.includes('.')) return undefined;
  const feature = pass.definitions.feature(contextId, name);
  if (!feature) return undefined;
  const candidates = pass.definitions.of(contextId, name);
  if (candidates.length === 0) {
    const read = pass.definitions.definitionReadIn(contextId, name);
    if (!read) return undefined;
    // Where the context changes what the definition reads, it is read here,
    // over the context's own names: the definition holds of every instance.
    if (read.at !== read.site) {
      return defineIn(model, read.at, feature, name, pass.definitions.of(read.site, name), pass, true);
    }
    return valueDefinedByEquation(model, read.site, name, pass);
  }
  return defineIn(model, contextId, feature, name, candidates, pass);
}

/**
 * The value `candidates` — asserted equations that may define `feature` — give
 * it, read in `contextId`. `instance` marks a definition written elsewhere and
 * read here, for this context's own value of the feature: it is in flight
 * under a key of its own ({@link instanceKey}), apart from the value the
 * feature has where the definition is written.
 */
function defineIn(
  model: Model,
  contextId: ElementId,
  feature: ElementRecord,
  name: string,
  candidates: readonly DefiningEquation[],
  pass: ScalarPass,
  instance = false,
): ScalarAnswer {
  if (candidates.length === 0) return NO_ANSWER;
  const flight = instance ? instanceKey(feature.id, contextId) : feature.id;
  if (pass.inFlight.has(flight)) return cameBackTo(returnTo(pass.inFlight, flight));
  const key = definitionKey(feature.id, contextId);
  const hit = pass.answers.get(key);
  if (hit) return hit;
  const answer = defineScalar(model, contextId, feature, name, candidates, pass, flight);
  if (!answer.contact) pass.answers.set(key, answer);
  return answer;
}

function defineScalar(
  model: Model,
  contextId: ElementId,
  feature: ElementRecord,
  name: string,
  candidates: readonly DefiningEquation[],
  pass: ScalarPass,
  flight: ElementId = feature.id,
): ScalarAnswer {
  // The unit-aware derivation's guard, at the same count: past the cap at
  // once, before the nest below is measured, and never settled.
  if (definitionsInFlight(pass.inFlight) >= MAX_DERIVATION_DEPTH) {
    return { value: undefined, depth: MAX_DERIVATION_DEPTH + 1, contact: GUARD_CONTACT, deep: true };
  }
  const { chosen, contact, cause } = chooseDefinition(
    pass.inFlight,
    flight,
    candidates,
    (equation) => byEquation(model, contextId, feature, name, equation, pass),
    (a) => ({ answered: a.value !== undefined, deep: a.deep === true, contact: a.contact, cause: a.cause }),
  );
  // What every candidate tried met, the chosen one's included.
  const met = { ...(contact ? { contact } : {}), ...(cause ? { cause } : {}) };
  // Every candidate only read an equation back: no definition here.
  if (!chosen) return { ...NO_ANSWER, ...met };
  return { ...chosen, ...met };
}

/** The value one defining equation gives `feature`, with the feature in flight through it. */
function byEquation(
  model: Model,
  contextId: ElementId,
  feature: ElementRecord,
  name: string,
  equation: DefiningEquation,
  pass: ScalarPass,
): ScalarAnswer {
  // A refused definition (shadowedEquation): no value, as the unit-aware derivation refuses it.
  if (shadowedEquation(model, equation).length > 0) return NO_ANSWER;
  if (equation.literals.size > 0) {
    // A `[unit]` literal has no scalar reading — the scalar scope is
    // unit-blind — so the value is the quantity the equation derives, in
    // coherent SI: `e == 640.0 [Wh] / power` is 3544.62 s, not a raw number
    // nobody wrote. A refusal there is the answer here too.
    const d = equationDerivation(model, feature.id, equation.constraint.attrs.expression as string, pass.memo, contextId);
    const depth = d.depth ?? 1;
    if (d.reason === 'depth') return { value: undefined, depth, deep: true };
    const v = d.q ? siValue(d.q) : d.b;
    const exact = d.q ? siExact(d.q) : undefined;
    return { value: v, ...(exact ? { exact } : {}), depth, ...(d.contact ? { contact: d.contact } : {}) };
  }
  const reads: ScalarReads = { depth: 0 };
  let value: unknown;
  let exact: Rational | undefined;
  try {
    const scope = decidedScopeWith(model, contextId, pass, reads);
    const r = evaluateDecided(equation.definition, scope.value, scope.exact);
    value = 'value' in r && (typeof r.value === 'number' || typeof r.value === 'boolean') ? r.value : undefined;
    exact = 'value' in r ? r.exact : undefined;
  } catch {
    // The engine's own stack ran out: as much a depth limit as the guard.
    return { ...NO_ANSWER, contact: mergeContact(reads.contact, GUARD_CONTACT) };
  }
  const depth = reads.depth + 1;
  const met = reads.contact ? { contact: reads.contact } : {};
  if (depth > MAX_DERIVATION_DEPTH) return { value: undefined, depth, deep: true, ...met };
  if (typeof value !== 'number') {
    return { value, depth, ...met, ...(value === undefined && reads.cause ? { cause: reads.cause } : {}) };
  }
  // The equation must also hold as QUANTITIES, with the feature read as that
  // number in its declared kind: `t == d` across a duration and a length is a
  // dimension clash, `dT == t1` on an offset scale is refused — neither fills
  // its feature with a raw magnitude, because the refusal is the answer.
  // Only a refusal of the QUANTITIES answers here: whether the equation's two
  // sides meet at this value is no question, since the value is its side's.
  const kind = quantityKindOf(model, feature.id);
  const asQuantity: Quantity = {
    magnitude: value,
    dimension: kind.dimension ?? DIMENSIONLESS,
    ...(exact ? { exact } : {}),
  };
  const judged = evaluateConstraintQuantityDetailed(model, equation.constraint, {
    fallback: (ref) => (ref === name ? asQuantity : undefined),
    memo: pass.memo,
  });
  const refused = isRefusalReason(judged.reason) && judged.reason !== 'tie';
  return refused ? { value: undefined, depth, ...met } : { value, ...(exact ? { exact } : {}), depth, ...met };
}

/**
 * The feature an asserted equation defines — its bare name, when the
 * constraint is an `assert constraint` reading `name == <expr>` and `name` is
 * a valueless feature of the constraint's owner — or `undefined` for any other
 * constraint, a `require`d equation of the same shape included.
 */
export function definedFeatureOf(model: Model, constraint: ElementRecord): ElementRecord | undefined {
  if (constraint.ownerId == null || !isAsserted(constraint)) return undefined;
  // The equation as every reader of definitions parses it — a `[unit]`
  // literal included (`e == 640.0 [Wh] / power`).
  for (const name of namesDefinedBy(constraint)) {
    const feature = effectiveFeatures(model, constraint.ownerId).find(
      (f) => effectiveNameOf(model, f) === name && !hasStatedValue(model, f),
    );
    if (feature) return feature;
  }
  return undefined;
}

/**
 * The name → feature-id map a scope rooted at `contextId` resolves through:
 * every feature reachable from the context whose stated value is read there,
 * under its dotted chain and — by the rule of the one walk every scope shares
 * ({@link DefiningEquations.scope}) — its bare name. Exposed so a caller can
 * ask WHICH feature a name denotes before deciding how to compare it.
 */
export function featureIdsFor(
  model: Model,
  contextId: ElementId,
  definitions: DefiningEquations = sharedDefinitions(model),
): Map<string, ElementId> {
  return new Map(definitions.scope(contextId, 'value'));
}

/** A literal number a feature states, with its exact reading (`statedRational` of ./exact). */
function literalAnswer(value: number, f: ElementRecord): ScalarAnswer {
  const exact = statedRational(value, f.attrs.valueText);
  return { value, ...(exact ? { exact } : {}), depth: 0 };
}

/**
 * The value of one feature: a literal directly, an expression through the
 * feature's owner scope — or, given `at`, through the scope of the context
 * that changes what it reads, as that context's own value
 * ({@link DefiningEquations.readAt}). A cycle (`a = b + 1; b = a + 1`) yields
 * `undefined` rather than a hang — the conservative answer.
 */
function valueOfFeature(model: Model, id: ElementId, pass: ScalarPass, at?: ElementId): ScalarAnswer {
  const feat = model.get(id);
  if (!feat) return NO_ANSWER;
  // A value that contradicts a binding it redefines is not the feature's: the
  // model states both, and neither is read (the unit-aware path refuses it).
  if (pass.definitions.contradiction(feat)) return NO_ANSWER;
  const raw = statedValueOf(model, feat);
  if (raw === undefined || raw === null) {
    // A redefinition that states nothing, in a context that changes what the
    // value it redefines reads: that value, read there.
    const inherited = at === undefined ? pass.definitions.redefinedValueOf(feat) : undefined;
    return inherited ? valueOfFeature(model, inherited.target.id, pass, inherited.at) : NO_ANSWER;
  }
  if (typeof raw === 'number') return literalAnswer(raw, feat);
  if (typeof raw === 'boolean') return { value: raw, depth: 0 };
  if (typeof raw !== 'string') return NO_ANSWER;
  const s = raw.trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return { value: s.slice(1, -1), depth: 0 };
  }
  const key = at !== undefined ? instanceKey(id, at) : id;
  if (pass.inFlight.has(key)) return cameBackTo(returnTo(pass.inFlight, key));
  const hit = pass.answers.get(key);
  if (hit) return hit;
  let node: ExprNode | undefined;
  try {
    node = parseExpr(s);
  } catch {
    // A unit literal (`a + 0.5 [m]`) is no scalar expression, and has no
    // scalar value. Its names are read all the same, for what they meet — a
    // feature read back into its own derivation, a chain past the cap — as
    // the unit-aware derivation meets it there: an equation over this feature
    // then fails for the same reason on both paths, and where no other gives
    // a value, both answer with the same failure.
  }
  const refs = node ? undefined : quantityRefsIn(s);
  if (!node && !refs) {
    pass.answers.set(key, NO_ANSWER);
    return NO_ANSWER;
  }
  // A value expression reading a name the feature declares itself, which its
  // owner's scope — or the scope it is read in — answers with another feature:
  // no value (shadowedNamesOf).
  const reading = at !== undefined ? { ...feat, ownerId: at } : feat;
  if (shadowedNamesOf(model, reading, node ? referencedNames(node) : refs!).length > 0) {
    pass.answers.set(key, NO_ANSWER);
    return NO_ANSWER;
  }
  const reads: ScalarReads = { depth: 0 };
  let answer: ScalarAnswer;
  pass.inFlight.set(key, undefined);
  try {
    const where = at ?? feat.ownerId;
    const inner = where != null ? decidedScopeWith(model, where, pass, reads) : undefined;
    if (node) {
      const r = evaluateDecided(node, inner?.value ?? (() => undefined), inner?.exact);
      answer = 'value' in r ? settled(r.value, reads, r.exact) : settled(undefined, reads);
    } else {
      for (const ref of refs!) inner?.value(ref);
      answer = settled(undefined, reads);
    }
  } catch {
    // The engine's own stack ran out: a depth limit, never settled.
    answer = { ...NO_ANSWER, contact: mergeContact(reads.contact, GUARD_CONTACT) };
  } finally {
    pass.inFlight.delete(key);
  }
  if (!answer.contact) pass.answers.set(key, answer);
  return answer;
}

/**
 * Evaluate a feature's value expression (`attrs.value`, else `attrs.expression`)
 * against a scope built from its owner. Returns `{ unknown: true }` when there
 * is nothing to evaluate or a referenced name is unresolved.
 */
export function evaluateFeatureValue(model: Model, featureId: ElementId): EvalResult {
  const a = featureAnswer(model, featureId, newPass(model));
  return a.value !== undefined ? { value: a.value } : { unknown: true };
}

/** {@link evaluateFeatureValue} within a pass, as the scalar scope's answer. */
function featureAnswer(model: Model, featureId: ElementId, pass: ScalarPass): ScalarAnswer {
  const el = model.get(featureId);
  if (!el) return NO_ANSWER;
  if (pass.definitions.contradiction(el)) return NO_ANSWER;
  // A default a binding overrides is no value of the feature's (statedValueOf).
  const raw = defaultGivesWay(model, el)
    ? undefined
    : el.attrs.value !== undefined
      ? el.attrs.value
      : el.attrs.expression;
  if (raw === undefined || raw === null) {
    // No value of its own: the equation beside it may fix one (CV-17).
    const own = pass.definitions.nameOf(el);
    if (own && el.ownerId != null) return answerFor(model, el.ownerId, own, pass) ?? NO_ANSWER;
    return NO_ANSWER;
  }
  if (typeof raw === 'number') return literalAnswer(raw, el);
  if (typeof raw === 'boolean') return { value: raw, depth: 0 };
  if (typeof raw !== 'string') return NO_ANSWER;
  const reads: ScalarReads = { depth: 0 };
  try {
    const scope = decidedScopeWith(model, el.ownerId ?? featureId, pass, reads);
    const r = evaluateDecided(parseExpr(raw), scope.value, scope.exact);
    return 'value' in r ? settled(r.value, reads, r.exact) : settled(undefined, reads);
  } catch {
    return NO_ANSWER;
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
  /**
   * Set on a check that is no relation of the model's but a value it states
   * twice ({@link contradictions}): `binding` for a redefinition whose value
   * conflicts with a binding it overrides, `clash` for two bindings a context
   * inherits under one name, `bind` for a binding connector whose two ends
   * the model states different values for ({@link bindingConflicts}). Its
   * `id` is the redefinition's, `<the other feature's id>@<the context's
   * id>`, or the connector's — `<its id>@<the context's id>` in a context
   * that specialises its owner.
   */
  conflict?: 'binding' | 'clash' | 'bind';
  /**
   * Set on an `unknown` that is a comparison whose two sides are equal within
   * the evaluators' tolerance and that no exact reading decides (the tie rule
   * of ./exact): another reading of the same values may not decide it either,
   * and the numeric surface abstains with it.
   */
  tie?: true;
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
  /**
   * For a reading in a context that specialises the constraint's owner
   * ({@link readInContexts}): the pipeline's own sentence — what a check of the
   * constraint in that context says (`Constraint violated: …`, `Could not
   * evaluate: …`), as the verification lane reads it.
   */
  detail?: string;
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
  // One pass for the sweep — its derivations, scalar and unit-aware, are
  // settled once; every constraint reads the same features.
  const pass = newPass(model);
  for (const el of model.ofKind('ConstraintUsage', 'RequirementUsage')) {
    const expr = el.attrs.expression;
    if (typeof expr !== 'string' || expr.trim() === '') continue;

    const judged = judgeConstraint(model, el, expr, pass);
    const check: ConstraintCheck = {
      id: el.id,
      ownerId: el.ownerId,
      expression: expr,
      result: judged.result,
      message: judged.message,
      ...(judged.tie ? { tie: true as const } : {}),
    };
    if (judged.gap) readThroughSpecialisers(model, el, expr, check, pass);
    readInContexts(model, el, expr, check, pass);
    out.push(check);
  }
  out.push(...contradictions(model, pass));
  out.push(...bindingConflicts(model, pass));
  return out;
}

/**
 * The checks of a sweep by the id a worklist row carries: a constraint's own
 * by its element id, and its reading in a context ({@link readInContexts}) by
 * `<id>@<context id>` — the id of the worklist row that reads it there
 * (`Obligation.instance` of ./obligations). What the literal and SMT engines
 * look a row's numeric reading up in.
 */
export function checksByRow(checks: readonly ConstraintCheck[]): Map<ElementId, ConstraintCheck> {
  const out = new Map<ElementId, ConstraintCheck>();
  for (const c of checks) {
    out.set(c.id, c);
    for (const i of c.instances ?? []) {
      out.set(`${c.id}@${i.contextId}`, {
        id: `${c.id}@${i.contextId}`,
        ownerId: i.contextId,
        expression: c.expression,
        result: i.result,
        message: i.detail ?? i.message,
      });
    }
  }
  return out;
}

/**
 * One check per redefinition whose value conflicts with a BINDING it
 * overrides ({@link DefiningEquations.contradiction}), anchored at the
 * redefinition, in the sentence every surface refuses its value with: its
 * `id` is the redefinition's, its `expression` the binding as it holds there
 * (`load == 1.0`). `violated` where two literal values are decided to differ
 * — the validation surface reports it with every other violated check, and
 * the verification lane, which carries both values as axioms, finds them
 * inconsistent — and `unknown` where only an evaluation could compare them
 * (`:>> load = 50.0` over `load = 2.0 * k`): the two may meet, and the
 * verification lane decides.
 */
function contradictions(model: Model, pass: ScalarPass): ConstraintCheck[] {
  const out: ConstraintCheck[] = [];
  for (const f of model.all()) {
    if (f.attrs.isLibrary === true || f.attrs.value === undefined || f.attrs.value === null) continue;
    const conflict = pass.definitions.contradiction(f);
    const name = pass.definitions.nameOf(f);
    if (!conflict || name === undefined) continue;
    const { binding } = conflict;
    const unit = typeof binding.attrs.unit === 'string' && binding.attrs.unit !== '' ? ` [${binding.attrs.unit}]` : '';
    const sentence = contradictionSentence(model, f, conflict);
    out.push({
      id: f.id,
      ownerId: f.ownerId,
      expression: `${name} == ${String(binding.attrs.valueText ?? binding.attrs.value).trim()}${unit}`,
      result: conflict.decided ? 'violated' : 'unknown',
      message: conflict.decided ? `Constraint violated: ${sentence}` : `Could not evaluate: ${sentence}`,
      conflict: 'binding',
    });
  }
  // Two bindings a context inherits under one name (`part def C :> A, B`):
  // one check, at the most general context it arises in, anchored there.
  for (const { context, name, clash } of pass.definitions.contradictoryClashes()) {
    const v = clash.otherValue;
    const unit = typeof v.attrs.unit === 'string' && v.attrs.unit !== '' ? ` [${v.attrs.unit}]` : '';
    const sentence = clashSentence(model, context.id, clash);
    out.push({
      id: `${clash.other.id}@${context.id}`,
      ownerId: context.id,
      expression: `${name} == ${String(v.attrs.valueText ?? v.attrs.value).trim()}${unit}`,
      result: clash.decided ? 'violated' : 'unknown',
      message: clash.decided ? `Constraint violated: ${sentence}` : `Could not evaluate: ${sentence}`,
      conflict: 'clash',
    });
  }
  return out;
}

/**
 * One check per binding connector whose two ends, read in a context the
 * binding holds in — where it is written, and every context that specialises
 * its owner and reads an end differently ({@link
 * DefiningEquations.changingContexts}), as a definition's assert is read
 * there — are values the model states that are decided to DIFFER: `bind
 * p.load = L` in Q over P's `load = 1.0`, read in `q : Q { attribute :>> L =
 * 50.0; }`. A binding holds in every instance, and a value written with `=` is
 * a binding too (strict KerML), so the model states both values: `violated`,
 * anchored at the connector (`<its id>@<the context's id>` in a context), in
 * the expression the binding is there (`p.load == L`). Read nowhere but by
 * the verification lane, which found the axioms inconsistent, the binding was
 * dropped silently on this surface and the numeric one, and the model
 * feasible. Judged by the one pipeline ({@link judgeConstraint}); an end with
 * no value there — a valueless feature, or a `default` the binding overrides
 * ({@link defaultGivesWay}) — leaves nothing to contradict, and no check.
 */
function bindingConflicts(model: Model, pass: ScalarPass): ConstraintCheck[] {
  const out: ConstraintCheck[] = [];
  for (const b of model.all()) {
    if (b.attrs.isLibrary === true || b.ownerId == null || !isBindingConnector(b)) continue;
    const owner = model.get(b.ownerId);
    const left = bindingEndPath(model, b.source?.[0], b.ownerId);
    const right = bindingEndPath(model, b.target?.[0], b.ownerId);
    if (!owner || left === undefined || right === undefined || left === right) continue;
    const expr = `${left} == ${right}`;
    for (const x of [owner, ...pass.definitions.changingContexts(b, [left, right])]) {
      const reading: ElementRecord = {
        ...b,
        eClass: 'ConstraintUsage',
        ownerId: x.id,
        attrs: { ...b.attrs, expression: expr },
      };
      if (judgeConstraint(model, reading, expr, pass).result !== 'violated') continue;
      const where = pass.definitions.contextName(x.id);
      const holder = effectiveQualifiedName(model, owner.id);
      const sentence =
        `${x.id === owner.id ? holder : `${holder}'s binding, read in ${where},`} binds ${left} to ${right} ` +
        `(\`bind ${left} = ${right}\`), and the model states different values for the two there — a binding ` +
        'holds in every instance, as a value written with `=` does, so the model states both values';
      out.push({
        id: x.id === owner.id ? b.id : `${b.id}@${x.id}`,
        ownerId: x.id,
        expression: expr,
        result: 'violated',
        message: `Constraint violated: ${sentence}`,
        conflict: 'bind',
      });
    }
  }
  return out;
}


/**
 * Read a definition's constraint in every context that specialises the
 * definition and reads it differently ({@link DefiningEquations.changingContexts}):
 * one {@link SpecialisationInstance} per context, judged by the one pipeline
 * with the constraint's owner's names replaced by the context's. SysML makes a
 * constraint of P a feature of every P, so P's own verdict at P's values says
 * nothing of `part p : P { attribute :>> load = 50.0; }` over a `default`, and
 * `light : D { :>> k = 0.1 }` read `lim = 10.0 * k` as D's 20. A clause of a
 * requirement is read so in every context that binds its subject — `satisfy R
 * by p`, `requirement r : R { subject s = p; }` — at p's values, not at those
 * of the subject's type.
 */
function readInContexts(model: Model, el: ElementRecord, expr: string, check: ConstraintCheck, pass: ScalarPass): void {
  if (el.ownerId == null) return;
  const names = namesIn(expr);
  const contexts = pass.definitions.readingContexts(el, names);
  if (contexts.length === 0) return;
  const owner = el.ownerId;
  const ownIds = pass.definitions.scope(owner, 'all');
  const ownValues = idsIn(pass, owner);
  const target = targetName(model, el);
  const instances = check.instances ?? [];
  for (const x of contexts) {
    const reading: ElementRecord = { ...el, ownerId: x.id };
    const judged = judgeConstraint(model, reading, expr, pass);
    const ids = pass.definitions.scope(x.id, 'all');
    const scope = combinedScope(model, reading, pass);
    // What the context reads differently: the measures with no value where the
    // constraint is written, else every name it reads through another feature
    // — or reads IN the context, as the context's own value (`readAt`).
    const own = (n: string): boolean => pass.definitions.readAt(x.id, n) !== undefined;
    const changed = names.filter((n) => ids.get(n) !== undefined && (ids.get(n) !== ownIds.get(n) || own(n)));
    const missing = changed.filter((n) => !ownValues.has(n));
    // A value read in the context is shown beside a missing measure: it is why
    // the context reads the body otherwise.
    const read = missing.length > 0 ? [...missing, ...changed.filter((n) => own(n) && !missing.includes(n))] : changed;
    const shown: SpecialisationBinding[] = read.map((n) => {
      const featureId = ids.get(n)!;
      const value = scope(n);
      return {
        name: n,
        featureId,
        // A value read in the context is the context's own: named by it.
        qualifiedName: own(n)
          ? `${pass.definitions.contextName(x.id)}::${n}`
          : effectiveQualifiedName(model, featureId),
        ...(typeof value === 'number'
          ? { value: Number(value.toPrecision(6)) }
          : typeof value === 'boolean' || typeof value === 'string'
            ? { value }
            : {}),
      };
    });
    const satisfied = pass.definitions.satisfaction(x.id);
    const contextName = effectiveNameOf(model, satisfied?.satisfier ?? x) ?? nameOf(satisfied?.satisfier ?? x);
    instances.push({
      contextId: x.id,
      context: contextName,
      featureId: shown[0]?.featureId ?? x.id,
      qualifiedName: effectiveQualifiedName(model, shown[0]?.featureId ?? x.id),
      ...(shown[0]?.value !== undefined ? { value: shown[0].value } : {}),
      bindings: shown,
      result: judged.result,
      message: instanceMessage(model, judged, shown, contextName, target, expr),
      detail: judged.message,
    });
  }
  if (instances.length > 0) check.instances = instances;
}

/** A name a target is read through: the specialiser standing for a measure. */
interface Bound {
  featureId: ElementId;
  /** The scalar value, as the scalar scope would answer it. */
  value: unknown;
  /** That value's exact reading, when it has one ({@link ScalarAnswer.exact}). */
  exact?: Rational;
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
  /** Set on an `unknown` that is a tie no exact reading decides ({@link ConstraintCheck.tie}). */
  tie?: true;
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
  pass: ScalarPass,
  bindings?: ReadonlyMap<string, Bound>,
): Judgement {
  // A body that reads a name its own element declares, which the owner's scope
  // answers with another feature, is read by no surface (shadowedNamesOf).
  const shadowed = shadowedNamesOf(model, el, namesIn(expr));
  if (shadowed.length > 0) {
    return { result: 'unknown', message: `Could not evaluate: ${shadowedSentence(model, el, shadowed)}`, gap: false };
  }
  const local = equationBindings(model, el, expr, pass, bindings);
  if ('reason' in local) return { result: 'unknown', message: `Could not evaluate: ${local.reason}`, gap: false };
  // The equation a feature is bound FROM is judged against that binding too,
  // as every other check is. A kind relabels a dimensionless derivation
  // (`endurance : DurationValue` over unitless Real inputs is 3544.62 s), and
  // its `==` with the dimensionless side it came from is the bare-literal
  // contract, which the scalar path below reads in the declared unit. Leaving
  // the defined name unbound instead made a CHAIN's equation (`e == capacity2
  // / power`, `capacity2` itself fixed by one) an `unresolved` the bare-literal
  // refusal then read as a bare number: the definition refused by its input.
  const all = local.bindings.size === 0 ? bindings : new Map([...(bindings ?? []), ...local.bindings]);
  const judged = judgeBound(model, el, expr, pass, all);
  // An equation that fixes a valueless feature is not a check that passed
  // but a definition that was read: say what it fixed the feature to — as
  // the quantity the equation derives, so `640 [Wh] / 650 [W]` reads 3544.62 s,
  // not the 0.984615 that is hours to no one. A reading through a specialiser
  // is a check of the target, never a definition.
  if (judged.result !== 'satisfied' || bindings) return judged;
  const defines = definitionMessage(model, el, local.bindings, pass);
  return defines ? { ...judged, message: defines } : judged;
}

/** The pipeline of {@link judgeConstraint} over one set of bindings. */
function judgeBound(
  model: Model,
  el: ElementRecord,
  expr: string,
  pass: ScalarPass,
  bindings?: ReadonlyMap<string, Bound>,
): Judgement {
  const { memo } = pass;
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
    if ('gap' in ua) {
      const lowered = parseRelationBody(expr);
      const unread = lowered?.resolved && unreadRefusal(model, el, lowered.node, pass, bindings, lowered.literals);
      return unread ? { result: 'unknown', message: unread, gap: false } : ua;
    }
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
    // Gate (e) holds on a body with `[unit]` literals as on any other — `e >=
    // 45.0 and e <= 1.0 [h]` compares a derived duration with a bare number —
    // and is asked where the scalar branch below asks it: after the refusals.
    // A literal whose unit could not be lowered is no bare number, and is left
    // to the reason above, as the solver lane leaves it.
    const lowered = isRefusalReason(ua.reason) ? undefined : parseRelationBody(expr);
    const refusal =
      lowered?.resolved && derivedBareLiteralRefusal(model, el, lowered.node, pass, bindings, lowered.literals);
    if (refusal) return { result: 'unknown', message: refusal, gap: false };
    if (ua.reason === 'unresolved') {
      // A name it lacks is a feature chain: say why, as the scalar branch below
      // says it of the same chain in a body without a `[unit]` — one reason
      // for one chain, which the solver lane refuses it by too.
      const own = combinedAnswer(model, el, pass);
      const scope: Scope = (name) => {
        const bound = bindings?.get(name);
        return bound !== undefined ? bound.value : own(name)?.value;
      };
      const chains = chainCauses(model, el, namesIn(expr), scope, pass);
      if (chains) return { result: 'unknown', message: `Could not evaluate: ${chains}`, gap: true };
    }
    return {
      result: 'unknown',
      message: `Could not evaluate: ${ua.detail}`,
      gap: ua.reason === 'unresolved',
      ...(ua.reason === 'tie' ? { tie: true as const } : {}),
    };
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
  if ('gap' in ua) {
    const unread = unreadRefusal(model, el, node, pass, bindings);
    return unread ? { result: 'unknown', message: unread, gap: false } : ua;
  }
  // A reasoned refusal is not a gap the scalar path may fill: arithmetic on
  // an offset scale (`dT == t2 - t1` in °C), a derived feature whose
  // dimension disagrees with its type, and a comparison of two genuinely
  // different dimensions (`d [m] >= t [s]` — `dimension-clash`) all read as
  // plausible raw magnitudes there, and that is precisely the wrong answer
  // being refused. `dimension` is deliberately NOT a refusal: it is the same
  // predicate with a DIMENSIONLESS side (`mtow [kg] <= 25.0`), the
  // bare-literal contract, where reading the literal in the feature's
  // declared unit is what the author meant — that is the fallback below.
  // Definitions nested past the cap (`depth`) are refused too: the scalar
  // path below has no value past it either, and once read on to the raw
  // number of a dimensioned chain. The membership test lives in units-eval,
  // beside the reasons themselves.
  if (isRefusalReason(ua.reason)) {
    return {
      result: 'unknown',
      message: `Could not evaluate: ${ua.detail}`,
      gap: false,
      ...(ua.reason === 'tie' ? { tie: true as const } : {}),
    };
  }

  // The bare-literal contract holds for a LITERAL-valued feature: its
  // declared unit is the unit the literal is read in. It does not hold for a
  // DERIVED feature — `endurance = capacity * fraction / power` is 2835.7 s
  // or 0.7877 Wh/W depending on who reads it, and the scalar path reads raw
  // magnitudes — so a derived dimensioned feature is never compared as a
  // bare number: answer unknown and name the repair. That is gate (e), the
  // rule every surface refuses such a body by.
  const refusal = derivedBareLiteralRefusal(model, el, node, pass, bindings);
  if (refusal) return { result: 'unknown', message: refusal, gap: false };

  // Scope from the owner (subject context) merged with the constraint itself.
  const combined = combinedAnswer(model, el, pass);
  const answered = new Map<string, ScalarAnswer | undefined>();
  const own = (name: string): ScalarAnswer | undefined => {
    if (!answered.has(name)) answered.set(name, combined(name));
    return answered.get(name);
  };
  const scope: Scope = (name) => {
    const bound = bindings?.get(name);
    return bound !== undefined ? bound.value : own(name)?.value;
  };
  // Each number with its exact reading, so a tie is decided by the decimals
  // written, as the unit-aware path decides it (the tie rule of ./exact):
  // `mass < 25.0` at 25 kg is violated, `x + 0.2 > 0.3` at 0.1 too.
  const exact: ExactScope = (name) => {
    const bound = bindings?.get(name);
    return bound !== undefined ? bound.exact : own(name)?.exact;
  };
  const r = evaluateDecided(node, scope, exact);
  if ('unknown' in r && r.tie) {
    return { result: 'unknown', message: `Could not evaluate: ${tieSentence(r.tie)}`, gap: false, tie: true };
  }
  if ('unknown' in r) {
    // A value past the depth cap is refused, as the unit-aware path refuses
    // it: not a gap a specialiser may fill.
    const deep = tooDeep(node, scope, own);
    if (deep) return { result: 'unknown', message: `Could not evaluate: ${deep}`, gap: false };
    return {
      result: 'unknown',
      message: `Could not evaluate: ${unknownCause(model, el, referencedNames(node), scope, pass)}`,
      gap: true,
    };
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
function definitionMessage(
  model: Model,
  el: ElementRecord,
  local: ReadonlyMap<string, Bound>,
  pass: ScalarPass,
): string | undefined {
  const defined = definedFeatureOf(model, el);
  const name = defined ? pass.definitions.nameOf(defined) : undefined;
  if (!name) return undefined;
  const bound = local.get(name);
  if (bound) {
    const shown = displayOf(bound);
    if (typeof shown.value !== 'number') return undefined;
    return `Constraint satisfied: defines ${name} = ${shown.value}${shown.unit ? ` [${shown.unit}]` : ''}`;
  }
  const value = combinedAnswer(model, el, pass)(name)?.value;
  return typeof value === 'number' ? `Constraint satisfied: defines ${name} = ${Number(value.toPrecision(6))}` : undefined;
}

/* ─────────────── A feature fixed by an asserted equation in the constraint's own context ─────────────── */

/**
 * A valueless feature an asserted equation may fix, and the context the
 * equation is read in — where it is written, unless `site` says that is
 * elsewhere: a definition written in `site` and read in `contextId`, over
 * the names there, because the context changes what it reads.
 */
interface EquationSite {
  contextId: ElementId;
  feature: ElementRecord;
  site?: ElementId;
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
 * features that specialise its measure.
 */
function equationBindings(
  model: Model,
  el: ElementRecord,
  expr: string,
  pass: ScalarPass,
  taken?: ReadonlyMap<string, Bound>,
): { bindings: Map<string, Bound> } | { reason: string } {
  const bindings = new Map<string, Bound>();
  for (const name of bareNamesIn(expr)) {
    if (taken?.has(name)) continue;
    const site = equationSiteOf(model, el, name, pass);
    if (!site) {
      // No equation: a binding may hold it to a derived value, read the same way.
      const held = boundSiteOf(model, el, name, pass);
      if (!held) continue;
      const refusal = refusalSentence(held.derivation, name, false);
      if (refusal) return { reason: refusal };
      const value = held.derivation.q ? siValue(held.derivation.q) : held.derivation.b;
      if (value === undefined) continue;
      const exact = held.derivation.q ? siExact(held.derivation.q) : undefined;
      bindings.set(name, {
        featureId: held.feature.id,
        value,
        ...(exact ? { exact } : {}),
        ...(held.derivation.q ? { quantity: held.derivation.q } : {}),
        derivation: held.derivation,
      });
      continue;
    }
    const read = readSpecialiser(model, site.feature, name, pass, site);
    if ('bound' in read) bindings.set(name, read.bound);
    else if (!read.valueless) return { reason: read.reason };
  }
  // A chain to a feature its asserted definition fixes, where the chain reads
  // it ({@link valueThroughChain}): bound the same way, from where it is defined.
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  for (const name of namesIn(expr)) {
    if (!name.includes('.') || taken?.has(name)) continue;
    const end = pass.definitions.chainDefinition(contexts, name);
    if (!end) continue;
    const read = readSpecialiser(model, end.feature, name, pass, {
      contextId: end.at,
      feature: end.feature,
      ...(end.at !== end.site ? { site: end.site } : {}),
    });
    if ('bound' in read) bindings.set(name, read.bound);
    else if (!read.valueless) return { reason: read.reason };
  }
  return { bindings };
}

/**
 * {@link boundOf} for a name a body reads, in the contexts the scalar scope
 * reads it in — `undefined` where a stated value of that name answers first.
 */
function boundSiteOf(
  model: Model,
  el: ElementRecord,
  name: string,
  pass: ScalarPass,
): { feature: ElementRecord; derivation: FeatureDerivation } | undefined {
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  for (let i = 0; i < contexts.length; i++) {
    const held = boundOf(model, contexts[i]!, name, pass);
    if (!held) continue;
    return contexts.slice(0, i + 1).some((c) => idsIn(pass, c).has(name)) ? undefined : held;
  }
  return undefined;
}

/**
 * The equation the scalar scope would read `name` through, mirroring
 * {@link combinedScope}: the owner's scope first, then the constraint's own,
 * and in each a stated value of that name (anywhere {@link featureIdsFor}
 * reaches) before an equation — `undefined` when one answers it first. A
 * definition the context inherits is read where it is written when the
 * context changes nothing it reads, and in the context, over its own names,
 * when it does ({@link DefiningEquations.definitionReadIn}).
 */
function equationSiteOf(model: Model, el: ElementRecord, name: string, pass: ScalarPass): EquationSite | undefined {
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  for (let i = 0; i < contexts.length; i++) {
    const contextId = contexts[i]!;
    const feature = pass.definitions.feature(contextId, name);
    if (!feature) continue;
    const read =
      pass.definitions.of(contextId, name).length > 0
        ? { site: contextId, at: contextId }
        : pass.definitions.definitionReadIn(contextId, name);
    if (read === undefined) continue;
    const shadowed = contexts.slice(0, i + 1).some((c) => idsIn(pass, c).has(name));
    if (shadowed) return undefined;
    return { contextId: read.at, feature, ...(read.at !== read.site ? { site: read.site } : {}) };
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
function unknownCause(
  model: Model,
  el: ElementRecord,
  names: readonly string[],
  scope: Scope,
  pass: ScalarPass = newPass(model),
): string {
  return chainCauses(model, el, names, scope, pass) ?? 'a referenced value is unknown';
}

/**
 * One {@link chainCause} per name `scope` lacks, joined — when every name it
 * lacks is a feature chain with one — else `undefined`.
 */
function chainCauses(
  model: Model,
  el: ElementRecord,
  names: readonly string[],
  scope: Scope,
  pass: ScalarPass = newPass(model),
): string | undefined {
  const lacking = [...new Set(names)].filter((n) => scope(n) === undefined);
  // A calculation read outside its owner has its own reason, chain or not.
  const causes = lacking.map(
    (n) =>
      clashCause(model, el, n, pass) ??
      contradictionCause(model, el, n, pass) ??
      (n.includes('.') ? chainCause(model, el, n, pass) : undefined) ??
      calculationCause(model, el, n, pass),
  );
  return causes.length > 0 && causes.every((c) => c !== undefined) ? causes.join('; ') : undefined;
}

/**
 * The names a relation reads whose value the validation surface reads NOWHERE
 * in the relation's context, although the solver lane would read one there —
 * or `[]`. `names` are the names the body reads, `[unit]` literals excluded.
 *
 * What is left of them is a value no context reads as its own: a name two
 * inherited values collide under ({@link clashOf}), a chain into a
 * calculation with a parameter ({@link callOnChain}), and — where this
 * surface finds no reading of it at all — a chain to, or an inherited, value
 * only an asserted equation defines, or a derived value.
 *
 * A value written in one context and read in another that changes what it
 * reads (`p.e`, over P's `e == capacity / power` and a `p : P { :>> capacity
 * = 1300 }`; `e` in `S :> P { :>> capacity = 320 [Wh] }`) used to be one of
 * them, read as nothing on every surface (Stage 1) — and before that as P's,
 * a false proof. It is that context's own value now, read there over its
 * names ({@link DefiningEquations.valueRef},
 * {@link DefiningEquations.definitionReadIn},
 * {@link DefiningEquations.chainDefinition}), by every surface, and by a
 * symbol of its own on the verification lane. A name left here refuses no
 * relation on its own: a verdict that does not depend on it stands
 * (`flag > 0.0 or c.load <= 1.0`), and one that does is undecided — on every
 * surface, in this surface's sentence.
 */
export function unreadValuesOf(
  model: Model,
  el: ElementRecord,
  names: readonly string[],
  memo?: DerivationMemo,
): string[] {
  const out: string[] = [];
  const pass = passFor(model, memo);
  for (const name of new Set(names)) {
    if (clashOf(el, name, pass)) {
      out.push(name);
      continue;
    }
    if (name.includes('.')) {
      if (callOnChain(model, el, name, pass)) {
        out.push(name);
        continue;
      }
      const end = chainEnd(model, el, name, pass);
      if (end?.asserted && !end.read) {
        out.push(name);
        continue;
      }
    } else if (inheritedDefinition(model, el, name, pass)) {
      out.push(name);
      continue;
    }
    if (derivedElsewhere(model, el, name, pass)) out.push(name);
  }
  return out;
}

/**
 * The features the values {@link unreadValuesOf} named depend on, as resolved
 * where `el` reads them: for each name, the inputs of the value it denotes
 * ({@link DefiningEquations.dependencies}) in the context it is read through —
 * the usage a chain reads it through, else the relation's own context. A
 * command that reaches relations by the features they read reaches a refused
 * relation over an unread value through these: `assert constraint cap { p.e <=
 * 1.0 }` over P's `e == x * 2.0`, read through a `p : P2` that changes `x`,
 * reaches the requirement on `q.p.x` — P2's x — although its own symbol for
 * `p.e` meets nothing.
 */
export function unreadDependenciesOf(
  model: Model,
  el: ElementRecord,
  names: readonly string[],
  memo?: DerivationMemo,
): ElementId[] {
  const pass = passFor(model, memo);
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  const out = new Set<ElementId>();
  for (const name of new Set(names)) {
    let feature: ElementRecord | undefined;
    let reader: ElementId | undefined;
    if (name.includes('.')) {
      const end = pass.definitions.chain(contexts, name);
      feature = end?.feature;
      reader = end?.usage?.id;
    } else {
      for (const c of contexts) {
        feature = pass.definitions.byName(c).get(name);
        if (feature) {
          reader = c;
          break;
        }
      }
    }
    if (!feature || reader === undefined) continue;
    out.add(feature.id);
    for (const id of pass.definitions.dependencies(reader, feature)) out.add(id);
  }
  return [...out];
}

/**
 * The calculation WITH A PARAMETER a feature chain reads a feature of
 * (`g.r`, over `calc g { in y = 100.0; return r = y; }`), or `undefined`. Its
 * features are the values of a call — a default nothing invokes, the result
 * of one — so no surface reads them, as none reads the calculation's own
 * value ({@link isParameterisedCalculation}): the chain is an unread name,
 * never a value read off the parameter's default.
 */
function callOnChain(model: Model, el: ElementRecord, name: string, pass: ScalarPass): ElementRecord | undefined {
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  const segments = name.split('.');
  for (let i = 1; i < segments.length; i++) {
    const link = pass.definitions.chain(contexts, segments.slice(0, i).join('.'))?.feature;
    if (!link) return undefined;
    if (isCall(model, link)) return link;
  }
  return undefined;
}

/**
 * A DERIVED value — an attribute's value expression or a calculation's body
 * ({@link isDerivedValue}) — that a relation reads where this surface reads
 * no value for it: by a bare name of one the relation's context INHERITS
 * (`m2` in `part p : P`, over P's `attribute m2 = 10.0 - load`), or through a
 * feature chain (`p.m2`) — or `undefined`. The scope reads every such value,
 * where it is written or, in a context that changes what it reads (`:>> load
 * = 50.0` over a `default`), in that context over its names
 * ({@link DefiningEquations.valueRef}); what is left is a value the scope
 * does not map at all. A redefinition that states nothing stands for the
 * value it redefines (`attribute :>> m2;`).
 *
 * Asked of every name an unknown row reads, twice (for the row's unread names
 * and for its sentence), so it is answered once per relation and name.
 */
function derivedElsewhere(
  model: Model,
  el: ElementRecord,
  name: string,
  pass: ScalarPass,
): ElementRecord | undefined {
  // Most names are no derived value's: answered from one sweep of the model.
  if (!derivedNames(pass).has(name.slice(name.lastIndexOf('.') + 1))) return undefined;
  pass.elsewhere ??= new Map();
  const key = `${el.id} ${el.ownerId ?? ''} ${name}`;
  const hit = pass.elsewhere.get(key);
  if (hit !== undefined) return hit ?? undefined;
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  // The value first — a walk of the context's own features — and the scope's
  // names only for a name that is one: most names are not.
  let derived: ElementRecord | undefined;
  if (name.includes('.')) {
    const end = pass.definitions.chain(contexts, name)?.feature;
    derived = end ? derivedValueBehind(model, end) : undefined;
  } else {
    for (const c of contexts) {
      const f = pass.definitions.byName(c).get(name);
      if (!f) continue;
      const behind = derivedValueBehind(model, f);
      derived = behind && behind.ownerId !== c ? behind : undefined;
      break;
    }
  }
  const answer = !derived || contexts.some((c) => idsIn(pass, c).has(name)) ? undefined : derived;
  pass.elsewhere.set(key, answer ?? null);
  return answer;
}

/**
 * The derived value `f` reads: its own ({@link isDerivedValue}), or — for a
 * redefinition that states nothing — the one it redefines; `undefined` for
 * any other feature.
 */
function derivedValueBehind(model: Model, f: ElementRecord): ElementRecord | undefined {
  if (isDerivedValue(model, f)) return f;
  if (hasStatedValue(model, f)) return undefined;
  const g = redefinedClosure(model, f).find((h) => hasStatedValue(model, h));
  return g && isDerivedValue(model, g) ? g : undefined;
}

/** The effective names of the model's derived values ({@link isDerivedValue}), once per pass. */
function derivedNames(pass: ScalarPass): Set<string> {
  if (!pass.calculations) {
    pass.calculations = new Set();
    for (const el of pass.model.all()) {
      if (el.attrs.isLibrary === true) continue;
      if (el.attrs.value === undefined && el.eClass !== 'CalculationUsage') continue;
      const n = pass.definitions.nameOf(el);
      if (n && isDerivedValue(pass.model, el)) pass.calculations.add(n);
    }
  }
  return pass.calculations;
}

/** Why this surface reads no value for {@link derivedElsewhere}'s value, or `undefined`. */
function calculationCause(model: Model, el: ElementRecord, name: string, pass: ScalarPass): string | undefined {
  const call = name.includes('.') ? callOnChain(model, el, name, pass) : undefined;
  if (call) {
    return (
      `${name} has no value here: ${shortName(model, call)} is a calculation with a parameter, so its features are ` +
      'the values of a call, which this tool does not read'
    );
  }
  const derived = derivedElsewhere(model, el, name, pass);
  if (!derived || derived.ownerId == null) return undefined;
  const where = name.includes('.')
    ? 'through a feature chain that redefines what it reads'
    : `in ${nameOf(el.ownerId != null ? model.get(el.ownerId) : undefined)}, which redefines what it reads`;
  if (derived.eClass === 'CalculationUsage' && isCalculationValue(model, derived)) {
    return (
      `${name} has no value here: ${shortName(model, derived)} is a calculation of ${nameOf(model.get(derived.ownerId))}, ` +
      `and its body is read there only — not ${where}`
    );
  }
  return (
    `${name} has no value here: ${shortName(model, derived)} = ${String(derived.attrs.value).trim()} is written in ` +
    `${nameOf(model.get(derived.ownerId))}, and is read there only — not ${where}`
  );
}

/**
 * The two values a name `el` reads collides under where it is read
 * ({@link DefiningEquations.clash}) — `c.load` in `part c : C` over `part def
 * C :> A, B` — with the context the name is read in, or `undefined`.
 */
function clashOf(
  el: ElementRecord,
  name: string,
  pass: ScalarPass,
): { contextId: ElementId; clash: NameClash } | undefined {
  for (const c of [el.ownerId, el.id]) {
    if (c == null) continue;
    const d = pass.definitions.denote(c).get(name);
    if (!d) continue;
    const clash = pass.definitions.clash(d.reader, d.feature);
    return clash ? { contextId: d.reader, clash } : undefined;
  }
  return undefined;
}

/** Why a name a body reads has no value because two inherited values collide under it ({@link clashOf}). */
function clashCause(model: Model, el: ElementRecord, name: string, pass: ScalarPass): string | undefined {
  const hit = clashOf(el, name, pass);
  return hit ? `${name} has no value: ${clashSentence(model, hit.contextId, hit.clash)}` : undefined;
}

/**
 * Why a name a body reads has no value because the feature it denotes states
 * one that contradicts a BINDING it redefines ({@link
 * DefiningEquations.contradiction}) — `p.load has no value: p::load = 50.0
 * contradicts P::load = 1.0, …` — or `undefined`.
 */
function contradictionCause(model: Model, el: ElementRecord, name: string, pass: ScalarPass): string | undefined {
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  for (const c of contexts) {
    const id = idsIn(pass, c).get(name);
    if (id === undefined) continue;
    const f = model.get(id);
    const binding = f ? pass.definitions.contradiction(f) : undefined;
    return f && binding ? `${name} has no value: ${contradictionSentence(model, f, binding)}` : undefined;
  }
  return undefined;
}

/**
 * The features of `ids` the MODEL gives no value: none stated (a value whose
 * text only the unit-aware evaluator reads counts as one), no asserted
 * equation that answers one, no binding to a derived value — or `[]`.
 *
 * What lets a verification engine tell "undecided only because it reads a name
 * this tool does not read here" ({@link unreadValuesOf}) from a relation that
 * also reads a value the model never states (`p.e <= x`, `x` declared with
 * none): the second is a defect in the model, and is never filed as a limit
 * of the tool. Asked of the feature the relation READS, not of the name: the
 * scalar scope's bare-name convenience answers `x` with another part's `x`.
 */
export function featuresWithoutValue(model: Model, ids: readonly ElementId[]): ElementId[] {
  const memo: DerivationMemo = new Map();
  return [...new Set(ids)].filter((id) => {
    const f = model.get(id);
    if (!f) return true;
    if (hasStatedValue(model, f)) return false;
    const d = definitionDerivation(model, id, memo) ?? boundDerivation(model, id, memo);
    return d === undefined || (d.q === undefined && d.b === undefined);
  });
}

/**
 * A scalar pass for a caller that holds a {@link DerivationMemo} — one sweep
 * of the solver lane or the gates — kept for as long as that memo lives, so
 * the scopes it reads are built once per sweep rather than once per relation.
 */
function passFor(model: Model, memo: DerivationMemo | undefined): ScalarPass {
  if (!memo) return newPass(model);
  const hit = PASSES.get(memo);
  if (hit && hit.model === model) return hit;
  const pass = { ...newPass(model), memo };
  PASSES.set(memo, pass);
  return pass;
}

const PASSES = new WeakMap<DerivationMemo, ScalarPass>();

/**
 * The feature a BARE name of a relation denotes when it is a feature its
 * context inherits, states no value, and has an asserted definition only where
 * it is declared — one this surface does not read in the relation's context,
 * which redefines what it reads (see {@link unreadValuesOf}; where it changes
 * nothing, {@link equationSiteOf} reads it) — or `undefined`.
 */
function inheritedDefinition(
  model: Model,
  el: ElementRecord,
  name: string,
  pass: ScalarPass,
): ElementRecord | undefined {
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  // A stated value of that name, or an equation this surface reads, answers it.
  if (contexts.some((c) => idsIn(pass, c).has(name))) return undefined;
  if (equationSiteOf(model, el, name, pass)) return undefined;
  let feature: ElementRecord | undefined;
  for (const c of contexts) {
    feature = pass.definitions.feature(c, name);
    if (feature) break;
  }
  if (!feature || feature.ownerId == null || contexts.includes(feature.ownerId)) return undefined;
  return pass.definitions.of(feature.ownerId, name).length > 0 ? feature : undefined;
}

/**
 * Why this surface reads no value for an inherited feature with an asserted
 * definition elsewhere ({@link inheritedDefinition}): `e has no value here:
 * P::e is declared without one, its asserted equation in P is not read in S,
 * which redefines what it reads, and nothing specialises it`. `undefined` for
 * any other name.
 */
function inheritedCause(model: Model, el: ElementRecord, name: string, pass: ScalarPass): string | undefined {
  const feature = inheritedDefinition(model, el, name, pass);
  if (!feature || feature.ownerId == null || el.ownerId == null) return undefined;
  const specialisers = [...specialisersOf(model, feature).byContext.values()].flat();
  const clauses = [
    `${shortName(model, feature)} is declared without one`,
    `its asserted equation in ${nameOf(model.get(feature.ownerId))} is not read in ${nameOf(model.get(el.ownerId))}, ` +
      'which redefines what it reads',
    specialisers.length === 0
      ? 'nothing specialises it'
      : `what specialises it (${specialisers.map((f) => shortName(model, f, name)).join(', ')}) is not read here`,
  ];
  return `${name} has no value here: ${listed(clauses)}`;
}

/** Why the validation surface would not read what a relation reads, as {@link readRefusalOf} names it. */
export interface ReadRefusal {
  /**
   * `offset`: an operand is a point on an offset scale used in arithmetic, or
   * its derivation does arithmetic on one; `derivation`: an operand's
   * derivation is refused for another reason ({@link refusalSentence});
   * `derived-bare-literal`: gate (e), in the body or inside an operand's value.
   */
  reason: 'offset' | 'derivation' | 'derived-bare-literal';
  /** The sentence this surface gives the same relation. */
  detail: string;
  /**
   * For an operand's refusal: it is a feature an asserted equation defines,
   * which this surface refuses where it BINDS it — before any verdict.
   */
  byDefinition?: boolean;
}

/** How {@link readRefusalOf} reads a relation. */
export interface ReadOptions {
  /**
   * Ask whether an operand's own derivation is refused — `false` for a
   * feature's value, which the solver lane keeps solving (default `true`).
   */
  operands?: boolean;
  /** The relation states an identity of two values (`attribute t3 = t1`). */
  identity?: boolean;
  /** The names it reads that this surface reads no value for, when the caller has them. */
  unread?: readonly string[];
}

/**
 * What the solver lane and the verification engines ask of a relation before
 * judging it, so that they refuse what this surface refuses, for the same
 * reason and in the same sentence — the refusals that are about what the
 * relation READS rather than about its own shape (which `relationRefused`
 * and the scaling gates of ./relations decide): an operand whose derivation
 * this surface refuses, an operand that is a point on an offset scale used in
 * arithmetic, and a bare number against a derived dimension ({@link
 * derivedBareLiteral}, gate (e)). In that order, the order this surface meets
 * them in: the binding of an operand first, then the unit-aware evaluator,
 * then gate (e). `operands: false` leaves out the first, for a feature's
 * value: the solver lane keeps solving a value whose derivation is refused (it
 * has always read it raw, and every relation that reads it is refused).
 *
 * A name this surface reads no value for ({@link unreadValuesOf}) is no
 * operand of any of them — it is read as nothing, and refuses no relation on
 * its own. `unread` is that list when the caller has it.
 */
export function readRefusalOf(
  model: Model,
  el: ElementRecord,
  node: ExprNode,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
  memo: DerivationMemo,
  opts: ReadOptions = {},
): ReadRefusal | undefined {
  const { operands = true, identity = false } = opts;
  const names = namesReadIn(node).filter((n) => !markers.has(n));
  const skip = new Set(opts.unread ?? unreadValuesOf(model, el, names, memo));
  // A chain this surface reads the definition of where it ends is judged as
  // that feature's own name is ({@link valueThroughChain}).
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  const { definitions } = passFor(model, memo);
  const chains = new Set(names.filter((n) => n.includes('.') && definitions.chainDefinition(contexts, n) !== undefined));
  const refused = operands ? operandRefusal(model, node, nameToId, markers, memo, skip, chains) : undefined;
  if (refused) {
    return {
      reason: refused.reason === 'offset' ? 'offset' : 'derivation',
      detail: refused.detail,
      byDefinition: refused.byDefinition,
    };
  }
  // An IDENTITY (`attribute t2 = t1`) states that two points are one, and
  // converts across the scale as a binding does ({@link relationRefused}).
  const offset = identity ? undefined : absoluteOperandFault(model, node, nameToId, markers, memo, skip);
  if (offset) return { reason: 'offset', detail: describeReason('offset', offset) };
  const bare = derivedBareLiteral(model, node, relationVarsOf(node, nameToId), nameToId, markers, memo, skip, chains);
  if (bare) return { reason: 'derived-bare-literal', detail: bare };
  return undefined;
}

/**
 * `"x70" cannot be derived: its defining equations nest more than 64 deep` for
 * each name a body lacks because its definitions nest past the cap — the
 * sentence the unit-aware path refuses the same chain with — or `undefined`
 * when no name is lacking for that reason.
 */
function tooDeep(node: ExprNode, scope: Scope, answer: (name: string) => ScalarAnswer | undefined): string | undefined {
  const deep = [...new Set(referencedNames(node))].filter((n) => scope(n) === undefined && answer(n)?.deep);
  return deep.length > 0 ? deep.map((n) => `"${n}" cannot be derived: ${describeReason('depth')}`).join('; ') : undefined;
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
function chainCause(model: Model, el: ElementRecord, chain: string, pass: ScalarPass = newPass(model)): string | undefined {
  const end = chainEnd(model, el, chain, pass);
  if (!end) return undefined;
  const { feature, name, sites, asserted, read } = end;
  const checked = !asserted && sites.some((c) => hasUnassertedEquation(model, c, name));
  const specialisers = [...specialisersOf(model, feature).byContext.values()].flat();
  const clauses = [
    `${shortName(model, feature)} is declared without one`,
    ...(checked ? ['has no asserted equation'] : []),
    ...(asserted
      ? [
          read
            ? 'its asserted equation, read through the chain, gives it none'
            : 'its asserted equation is not read through a feature chain that redefines what it reads',
        ]
      : []),
    specialisers.length === 0
      ? 'nothing specialises it'
      : `what specialises it (${specialisers.map((f) => shortName(model, f, name)).join(', ')}) is not read through a feature chain`,
  ];
  return `${chain} has no value: ${listed(clauses)}`;
}

/**
 * The feature a chain ends at when it resolves, through each feature's
 * declared type, to one declared without a value — the contexts an equation
 * beside it may be written in, whether an asserted one is, and whether the
 * chain reads that definition ({@link DefiningEquations.chainDefinition}) — or
 * `undefined`.
 */
function chainEnd(
  model: Model,
  el: ElementRecord,
  chain: string,
  pass: ScalarPass,
): { feature: ElementRecord; name: string; sites: ElementId[]; asserted: boolean; read: boolean } | undefined {
  if (!chain.includes('.')) return undefined;
  const contexts = [el.ownerId, el.id].filter((c): c is ElementId => c != null);
  const end = pass.definitions.chain(contexts, chain);
  const feature = end?.feature;
  const name = feature ? pass.definitions.nameOf(feature) : undefined;
  if (!end || !feature || !name || hasValue(model, feature)) return undefined;
  const sites = [...new Set([end.via, feature.ownerId].filter((c): c is ElementId => c != null))];
  const asserted = sites.some((c) => pass.definitions.of(c, name).length > 0);
  const read = asserted && pass.definitions.chainDefinition(contexts, chain) !== undefined;
  return { feature, name, sites, asserted, read };
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
  pass: ScalarPass,
): void {
  if (el.ownerId == null) return;
  const names = bareNamesIn(expr);
  if (names.length === 0) return;
  const scope = combinedScope(model, el, pass);
  const owned = effectiveFeatures(model, el.ownerId);
  const missing: Measure[] = [];
  const valued: Measure[] = [];
  for (const name of names) {
    if (scope(name) === undefined) {
      const feature = owned.find((f) => pass.definitions.nameOf(f) === name && !hasValue(model, f));
      if (feature) missing.push({ name, feature });
    } else {
      const feature = owned.find((f) => pass.definitions.nameOf(f) === name && hasValue(model, f));
      if (feature) valued.push({ name, feature });
    }
  }
  if (missing.length === 0) return;

  const walks = new Map<string, Specialisers>();
  for (const m of [...missing, ...valued]) walks.set(m.name, specialisersOf(model, m.feature));

  // Contexts in the order the walk met them, from the measures with no value
  // only: a context that merely overrides a valued name has nothing to answer.
  // A context that SPECIALISES the constraint's owner (`part light : D`)
  // reads the constraint whole, every name in its own scope
  // ({@link readInContexts}); here are the others — the namespaces a layered
  // brief states its estimates in.
  const specialising = new Set(
    pass.definitions.specialisersOf(el.ownerId).map((x) => x.id),
  );
  const contexts: (ElementId | null)[] = [];
  for (const m of missing) {
    for (const ctx of walks.get(m.name)!.byContext.keys()) {
      if (!contexts.includes(ctx) && !(ctx != null && specialising.has(ctx))) contexts.push(ctx);
    }
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
      // A feature this context inherits with its definition where it is
      // declared: that equation is not read here, and saying "no value
      // anywhere" of a feature an equation defines was false.
      const inherited = inheritedCause(model, el, m.name, pass);
      if (inherited) return inherited;
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
  why.push(...chainCausesIn(model, el, expr, scope, pass));
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
      const read = readSpecialiser(model, pick.feature, m.name, pass);
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
      const read = readSpecialiser(model, pick.feature, m.name, pass);
      if ('bound' in read) bindings.set(m.name, read.bound);
      else if (read.refused) reason ??= read.reason;
    }

    if (!anchor) continue; // unreachable: the context came from a measure's walk
    const judged: Judgement = reason
      ? { result: 'unknown', message: reason, gap: false }
      : judgeConstraint(model, el, expr, pass, bindings);
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
    // A value read in a context is named by the context it is read in.
    const label = (b: SpecialisationBinding): string =>
      b.qualifiedName === effectiveQualifiedName(model, b.featureId)
        ? shortName(model, model.get(b.featureId), b.name)
        : b.qualifiedName.split('::').slice(-2).join('::');
    const values = shown.map((b) => `${label(b)} = ${b.value ?? '?'}${b.unit ? ` [${b.unit}]` : ''}`).join(', ');
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
  const defined = sorted.filter((f) => hasValue(model, f) || hasDefiningEquation(model, f));
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
  pass: ScalarPass,
  local?: EquationSite,
): { bound: Bound } | { reason: string; refused: boolean; valueless: boolean } {
  const name = local ? measure : shortName(model, feature, measure);
  // A feature fixed by an equation beside it states no value to derive: its
  // quantity is the equation's defining side, read by the unit-aware evaluator
  // — of several, the one the shared rule picks, as the scalar scope does.
  const context =
    local?.contextId ?? (!hasValue(model, feature) && pass.definitions.nameOf(feature) ? feature.ownerId : undefined);
  const byEquation = context != null ? definitionDerivation(model, feature.id, pass.memo, context, local?.site) : undefined;
  const d = byEquation ?? dimensionClaimDetail(model, feature.id, pass.memo);
  // A loop has no value on either path (the scalar scope's guard answers
  // nothing too), so it is refused here, naming the loop, rather than read
  // as a feature that merely has no value; definitions nested past the cap
  // are refused on both paths alike (`depth` is a refusal). A mismatch is the
  // feature's own only when its claim says so, and offset arithmetic only
  // when no sentence came up with it: one met further down a chain is an
  // input's, and the sentence composed there names it. The sentence is the
  // one the solver lane refuses the same operand with (`refusalSentence`).
  const refusal = refusalSentence(d, name, true);
  if (refusal) return { reason: refusal, refused: true, valueless: false };
  // A value with a bare number against a derived dimension inside it — gate
  // (e) where the value is written — has no magnitude any surface reads.
  const inner = valueFaultOf(model, feature.id, pass.memo);
  if (inner) return { reason: `"${name}" cannot be derived: ${inner}`, refused: true, valueless: false };
  const scalar = local
    ? (valueDefinedByEquation(model, local.contextId, pass.definitions.nameOf(feature) ?? measure, pass) ?? NO_ANSWER)
    : featureAnswer(model, feature.id, pass);
  // The scalar path honours the same cap: a chain the unit-aware evaluator
  // could not read (a scalar-only link) is not read on past it there either.
  if (scalar.deep) {
    return { reason: `"${name}" cannot be derived: ${describeReason('depth')}`, refused: true, valueless: false };
  }
  const value = scalar.value;
  if (value === undefined || value === null) {
    // Only an ASSERTED equation defines (see `isAsserted`), so that is what
    // the message says is missing: "no defining equation", beside a
    // `require`d `x == …`, read as if the tool had not seen the equation.
    return {
      reason:
        hasValue(model, feature) || byEquation !== undefined
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
      const why = d.reason ? `: ${d.message ?? describeReason(d.reason, d.detail)}` : '';
      return {
        reason:
          `${name} (${kind.name ?? dimToString(kind.dimension)}) has no value that could be read as a ` +
          `quantity${why}, and its raw number is not compared`,
        refused: false,
        valueless: false,
      };
    }
    quantity = { magnitude: value, dimension: DIMENSIONLESS, ...(scalar.exact ? { exact: scalar.exact } : {}) };
  }
  return {
    bound: {
      featureId: feature.id,
      value,
      ...(scalar.exact ? { exact: scalar.exact } : {}),
      ...(quantity ? { quantity } : {}),
      ...(byEquation?.q ? { derivation: byEquation } : {}),
    },
  };
}

function hasValue(model: Model, f: ElementRecord): boolean {
  return hasStatedValue(model, f);
}

function hasDefiningEquation(model: Model, f: ElementRecord): boolean {
  const name = effectiveNameOf(model, f);
  return f.ownerId != null && !!name && definingEquationFor(model, f.ownerId, name) !== undefined;
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
function chainCausesIn(model: Model, el: ElementRecord, expr: string, scope: Scope, pass: ScalarPass): string[] {
  return namesIn(expr)
    .filter((n) => n.includes('.') && scope(n) === undefined)
    .map((n) => chainCause(model, el, n, pass))
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
  const own = f.declaredName ?? f.declaredShortName ?? measure ?? effectiveNameOf(model, f) ?? nameOf(f);
  const owner = f.ownerId != null ? model.get(f.ownerId) : undefined;
  return owner ? `${effectiveNameOf(model, owner) ?? nameOf(owner)}::${own}` : own;
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
 * Gate (e) as the validation surface reads a body — {@link bareLiteralRefusal}
 * over the features this pass binds its names to, a specialiser standing for
 * a measure or a feature an equation fixes included — as the refusal message,
 * or `undefined` when the scalar fallback may run. The rule, what counts as a
 * derived operand ({@link derivedOperand}), what a value with a bare number
 * against a derived dimension inside it is ({@link valueFaultOf}) and the
 * sentence are the solver lane's, so the numeric surface, the literal engine
 * and the SMT engine refuse exactly these bodies, for the same reason; only
 * the binding of names to features is this surface's own. `markers` are the
 * body's lowered `[unit]` literals, when it carries any.
 */
function derivedBareLiteralRefusal(
  model: Model,
  el: ElementRecord,
  node: ExprNode,
  pass: ScalarPass,
  bindings?: ReadonlyMap<string, Bound>,
  markers: MarkerDimensions = NO_MARKERS,
): string | undefined {
  const ownerIds = el.ownerId != null ? idsIn(pass, el.ownerId) : undefined;
  const selfIds = idsIn(pass, el.id);
  // A name read through a specialiser is that feature here: its derivation
  // is the one a bare literal would be compared against.
  const readOf = (name: string): { id: ElementId; q?: Quantity; derivation: FeatureDerivation } | undefined => {
    const bound = bindings?.get(name);
    const id = bound?.featureId ?? ownerIds?.get(name) ?? selfIds.get(name);
    if (id === undefined) return undefined;
    const derivation = bound?.derivation ?? dimensionClaimDetail(model, id, pass.memo);
    return { id, q: bound ? bound.quantity : derivation.q, derivation };
  };
  const refusal = bareLiteralRefusal(
    node,
    (path) => {
      const lowered = markers.get(path);
      if (lowered) return lowered.dimension;
      const read = readOf(path);
      return read?.q?.dimension ?? read?.derivation.derived ?? DIMENSIONLESS;
    },
    (path) => {
      if (markers.has(path)) return undefined;
      const read = readOf(path);
      if (!read) return undefined;
      const derived = derivedOperand(dimensionalFacets(model, read.id).unit, read.derivation);
      const valueFault = valueFaultOf(model, read.id, pass.memo);
      return { ...(derived ? { derived } : {}), ...(valueFault ? { valueFault } : {}) };
    },
  );
  return refusal && `Could not evaluate: ${refusal}`;
}

/**
 * A refusal in a part of a body that a VERDICT did not read, as the refusal
 * message — or `undefined`.
 *
 * `and` and `or` decide without their second operand: `e >= 45.0 [min] or e <=
 * 60.0` is true from its first, and the bare `60.0` against the derived `e`
 * never reached the unit-aware evaluator. The numeric surface and the
 * verification engines ask what a relation reads of the whole relation
 * ({@link readRefusalOf}) — an SMT encoding has no operand it may leave
 * unread — so this surface does too: an operand whose derivation it refuses
 * (one an equation defines is refused where it is bound, before any verdict),
 * a point on an offset scale in arithmetic, and gate (e) ({@link
 * derivedBareLiteralRefusal}), in that order, each in the sentence it gives
 * where it does read them.
 *
 * A name this surface reads NO value for here ({@link unreadValuesOf}) is not
 * among them: the engines read it as a symbol nothing pins, so a verdict
 * decided without it — `flag > 0.0 or p.e <= 1.0` — stands on every surface.
 */
function unreadRefusal(
  model: Model,
  el: ElementRecord,
  node: ExprNode,
  pass: ScalarPass,
  bindings?: ReadonlyMap<string, Bound>,
  markers: MarkerDimensions = NO_MARKERS,
): string | undefined {
  const names = [...new Set(referencedNames(node))].filter((n) => !markers.has(n));
  const idOf = (name: string): ElementId | undefined =>
    (el.ownerId != null ? idsIn(pass, el.ownerId).get(name) : undefined) ?? idsIn(pass, el.id).get(name);
  for (const name of names) {
    if (bindings?.has(name)) continue;
    const id = idOf(name);
    const refused = id !== undefined ? refusalSentence(dimensionClaimDetail(model, id, pass.memo), name, false) : undefined;
    if (refused) return `Could not evaluate: ${refused}`;
  }
  // A point on an offset scale in arithmetic, where the unit-aware evaluator
  // did not reach it (`flag > 0.0 or t2 == 20.0`, `t2` an identity of a °C
  // value): the solver lane refuses that body whole, in this sentence.
  const units = new Map<string, string>();
  const point = offsetFaultIn(node, (name) => {
    if (markers.has(name)) return false;
    const id = bindings?.get(name)?.featureId ?? idOf(name);
    const q = bindings?.get(name)?.quantity ?? (id !== undefined ? dimensionClaimDetail(model, id, pass.memo).q : undefined);
    if (!q?.absolute) return false;
    units.set(name, q.unit ?? name);
    return true;
  });
  if (point !== undefined) return `Could not evaluate: ${describeReason('offset', units.get(point))}`;
  return derivedBareLiteralRefusal(model, el, node, pass, bindings, markers);
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

/** Merge the owner scope and the element's own scope (owner takes priority). */
function combinedScope(model: Model, el: ElementRecord, pass: ScalarPass): Scope {
  const answer = combinedAnswer(model, el, pass);
  return (name: string) => answer(name)?.value;
}

/** {@link combinedScope}, as the scalar scope's answers: the owner's when it has a value, else the element's own. */
function combinedAnswer(model: Model, el: ElementRecord, pass: ScalarPass): (name: string) => ScalarAnswer | undefined {
  return (name: string) => {
    const fromOwner = el.ownerId != null ? answerFor(model, el.ownerId, name, pass) : undefined;
    if (fromOwner?.value !== undefined) return fromOwner;
    const fromSelf = answerFor(model, el.id, name, pass);
    return fromSelf?.value !== undefined ? fromSelf : (fromOwner ?? fromSelf);
  };
}

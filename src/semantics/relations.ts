/**
 * The relation layer: how a constraint body becomes a numeric relation, and the
 * dimensional gates that decide whether it may be judged at all.
 *
 * The charter of this module, in one line: **encode after the gates; report
 * what the gates refuse.** Every consumer — the numeric solver of
 * {@link ./solver}, and any second engine standing behind the same gates —
 * lowers a body with {@link parseRelationBody}, resolves its names with
 * {@link relationScope}, asks {@link relationRefused} whether the body is a
 * numeric relation at all, and asks {@link scaleOfRelation} how (or whether) it
 * may be read in SI. A relation a gate refuses is REPORTED with its reason and
 * never judged; a relation no gate refuses is encoded from the same scale map
 * every other consumer would build, so two engines cannot answer one model
 * differently by disagreeing about units.
 *
 * These functions lived inside {@link ./solver} while it was their only caller.
 * They are lifted here unchanged — same gate order, same memoisation
 * ({@link DerivationMemo} is threaded in by the caller, never created here) —
 * so that "encodability is the same gate the numeric surface applies" is true
 * because it calls the same functions, not because two implementations were
 * written to agree.
 *
 * {@link Dimension} and {@link INDETERMINATE} are exported alongside
 * {@link OperandDimension} so a caller can destructure the result of
 * {@link nodeDimension} without reaching into {@link ./units}.
 *
 * Pure and deterministic: nothing here reads or writes anything but its
 * arguments.
 */

import { type ElementId, type ElementRecord, type Model } from '@core/index';
import { definedSideOf, hasStatedValue, sharedDefinitions, statedValueOf } from './defining-equation';
import { type ExprNode } from './expr';
import {
  derivationOf,
  derivedDimensionOf,
  dimensionClaim,
  dimensionalFacets,
  operandDerivation,
  refusalSentence,
  type DerivationMemo,
  type FeatureDerivation,
  type QReason,
} from './units-eval';
import {
  DIMENSIONLESS,
  UNIT_REGISTRY,
  dimEqual,
  dimToString,
  divideDim,
  multiplyDim,
  powDim,
  resolveUnit,
  type Dimension,
} from './units';
import { parseRelationBody, type MarkerDimensions } from './unit-literals';

/** Re-exported so a caller can name the two halves of an {@link OperandDimension}. */
export type { Dimension };

/* ─────────────────────────── unit scaling ────────────────────────────── */

/**
 * The affine map taking a feature's STORED magnitude into SI:
 * `si = value · factor + offset`. `factor` is 1 for a feature that declares a
 * quantity kind but no unit (SI by convention) and for a plain dimensionless
 * number (which is its own SI value).
 */
export interface UnitScale {
  factor: number;
  offset: number;
  /**
   * The physical dimension the feature's magnitude carries — `DIMENSIONLESS`
   * for a plain number. It is the DIMENSION, not a boolean "is dimensioned",
   * because gate (c) has to tell a length from a duration: comparing two
   * operands that are merely both dimensioned is exactly the mismatch the
   * unit-aware evaluator refuses.
   */
  dimension: Dimension;
}

/** featureId → its {@link UnitScale}, for the variables of one relation. */
export type ScaleMap = Map<ElementId, UnitScale>;

/** A dimensionless multiplier: its own SI value. */
const PLAIN_SCALE: UnitScale = { factor: 1, offset: 0, dimension: DIMENSIONLESS };

/** Does this scale carry a physical dimension at all? */
function isDimensioned(s: UnitScale): boolean {
  return !dimEqual(s.dimension, DIMENSIONLESS);
}

/**
 * Is there anything to CONVERT on this scale — a dimension, a factor, or an
 * origin?
 *
 * Asking `isDimensioned` alone missed the units that are deliberately
 * DIMENSION ONE and still carry a factor: the ISO 80000-13 information units
 * (byte and octet 8, hartley log₂10, nat 1/ln2, and every binary prefix — KiB
 * 8192). `2 [B] == need [bit]` then stayed verbatim and solved `need` to 2
 * where the model says 16, while the row published "violated by 0".
 */
function isScaled(s: UnitScale): boolean {
  return isDimensioned(s) || s.factor !== 1 || s.offset !== 0;
}

/** Is this feature's magnitude read on an offset (affine) scale — °C, °F? */
function isAbsoluteScale(s: UnitScale | undefined): boolean {
  return s !== undefined && s.offset !== 0;
}

/**
 * The storage-unit scale of one feature, or `undefined` when the solver must
 * refuse to scale the relation it appears in.
 *
 * The storage unit is the feature's DECLARED unit; failing that, the coherent
 * SI unit of its declared ISQ kind (or of the dimension its value expression
 * — a calculation's value body included — the asserted equation that defines
 * it, or the derived value a binding holds it to, derives to — {@link
 * derivedDimensionOf}) — "SI by convention", the same reading the unit-aware
 * evaluator gives a unit-less kinded feature; failing that, the value is a
 * plain number.
 * An unresolvable unit is a refusal, never a silent factor of 1 (the
 * `unknown-unit` rule warns about exactly that spelling).
 */
export function storageScaleOf(model: Model, id: ElementId, memo: DerivationMemo): UnitScale | undefined {
  const facets = dimensionalFacets(model, id);
  if (facets.unit !== undefined) {
    const u = resolveUnit(facets.unit);
    if (!u) return undefined; // gate (a): a unit nothing can convert
    return { factor: u.factorToSI, offset: u.offsetSI ?? 0, dimension: u.dimension };
  }
  const kind = facets.kindDimension ?? derivedDimensionOf(model, id, memo);
  if (kind) return { factor: 1, offset: 0, dimension: kind };
  return PLAIN_SCALE;
}

/** Operators whose two operands must share a dimension (the gate-(c) set). */
const DIMENSION_SENSITIVE = new Set(['==', '=', '!=', '<', '<=', '>', '>=', '+', '-']);

/**
 * Decide whether a relation may be judged in SI, and with what per-variable
 * scaling. Returns `undefined` to leave the relation in raw magnitudes — the
 * behaviour every unitless model has always had.
 *
 * The gates, each of which exists because scaling past it produces a CONFIDENT
 * WRONG number rather than a merely unhelpful one:
 *
 *  (a) every variable resolves to a storage scale — a known unit, a declared
 *      ISQ kind, a derived dimension, or a plain number;
 *  (b) a variable on an offset (affine) scale is scaled like any other, because
 *      the affine map is MONOTONE and so an ORDERING may be judged in kelvin —
 *      which is what `compareQ` already does on the other surface. What may not
 *      be judged is arithmetic on such a variable (°C differences and
 *      equalities are not offset-invariant); that is a REFUSAL, and
 *      {@link relationRefused} drops the whole relation rather than leaving it
 *      here to be read in raw magnitudes;
 *  (c) the two operands of every comparison, `==`, `+` and `-` carry the SAME
 *      dimension. That covers two distinct wrongs with one predicate. A
 *      DIMENSIONLESS operand meeting a dimensioned one is the declared-unit
 *      contract: `range = 5.0 [km]` against `<= 10.0` reads the literal in
 *      kilometres on both surfaces, and SI-scaling it would turn a satisfied
 *      constraint into `5000 <= 10`. Two DIFFERENT dimensions meeting
 *      (`v.d >= v.t`, a length against a duration) is a question no scaling can
 *      answer — the unit-aware evaluator refuses it, so scaling it here would
 *      publish a confident SI verdict against a refusal. Operands under `*` and
 *      `/` combine dimensions instead of having to match, so a bare literal
 *      there is a multiplier and never blocks scaling. The contract needs a
 *      DECLARED unit to read the literal in, and a dimension that comes only
 *      from a derivation has none: that relation is refused outright, by gate
 *      (e) ({@link derivedBareLiteral});
 *  (d) no variable's value expression `dimensionClaim`s a `mismatch` — a `Real`
 *      hand-converted with `* 60.0` derives to a duration while claiming to be
 *      a number, and scaling it would report 170 141 s (the factor-60 hazard
 *      the validation surface already refuses).
 *
 * A relation whose body carries `[unit]` LITERALS is dimensional by force
 * (`forced`): its literals are already lowered to SI, so leaving its variables
 * unscaled would compare kilograms with grams. Such a relation is dropped from
 * the equation set when a gate refuses it, and reported `unknown` — never
 * judged — on the check surface.
 */
export function scaleOfRelation(
  model: Model,
  vars: ElementId[],
  nodes: ExprNode[],
  nameToId: Map<string, ElementId>,
  forced: boolean,
  markers: MarkerDimensions,
  memo: DerivationMemo,
): ScaleMap | undefined {
  const scale: ScaleMap = new Map();
  let anyScaled = forced;
  for (const id of vars) {
    const s = storageScaleOf(model, id, memo);
    if (!s) return undefined; // (a)
    if (dimensionClaim(model, id, memo) === 'mismatch') return undefined; // (d)
    scale.set(id, s);
    if (isScaled(s)) anyScaled = true; // (b) an origin counts as much as a factor
  }
  if (!anyScaled) return undefined; // nothing to convert — stay verbatim
  for (const node of nodes) {
    if (nodeDimension(node, scale, nameToId, markers) === INDETERMINATE) return undefined; // (c)
  }
  return scale;
}

export type { MarkerDimensions };

/**
 * Does this relation body contain a dimensional fault the unit-aware evaluator
 * REFUSES — two different, both-dimensioned operands where they had to match
 * (`d [m] >= t [s]`), or a dimensioned exponent?
 *
 * Such a relation is not a numeric relation at all, so it is dropped from the
 * equation/inequality sets rather than merely left unscaled. Gate (c) only
 * declines to SI-SCALE it, which keeps its residual in the relation set — and
 * `solveFeasible`/`optimize` read that residual directly, with no unit-aware
 * verdict in front of them the way `checkConstraintsNumeric` of
 * {@link ./solver} has. That published `feasible: false` with a violation of
 * 2995 (5 km − 3000 s, a subtraction of unrelated magnitudes) for a relation
 * `analysisReport` reports as an unknown, and drove a free LENGTH to −1 metre
 * to satisfy a bound in SECONDS.
 *
 * A DIMENSIONLESS operand is NOT a clash: `range = 5 [km]` against `<= 10.0`
 * is the declared-unit contract, and `n : Real; n == km` is how the solver
 * learns `n` — both stay in the set, exactly as gate (c) leaves them unscaled.
 */
function hasDimensionalFault(
  node: ExprNode,
  scale: ScaleMap,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
): boolean {
  const dim = (n: ExprNode): OperandDimension => nodeDimension(n, scale, nameToId, markers);
  switch (node.kind) {
    case 'unary':
      return hasDimensionalFault(node.operand, scale, nameToId, markers);
    case 'if':
      return (
        hasDimensionalFault(node.cond, scale, nameToId, markers) ||
        hasDimensionalFault(node.then, scale, nameToId, markers) ||
        hasDimensionalFault(node.else, scale, nameToId, markers)
      );
    case 'binary': {
      if (
        hasDimensionalFault(node.left, scale, nameToId, markers) ||
        hasDimensionalFault(node.right, scale, nameToId, markers)
      ) {
        return true;
      }
      const l = dim(node.left);
      const r = dim(node.right);
      if (l === INDETERMINATE || r === INDETERMINATE) return false; // not decidable here
      if (node.op === '^') return !dimEqual(r, DIMENSIONLESS);
      if (!DIMENSION_SENSITIVE.has(node.op)) return false;
      if (dimEqual(l, DIMENSIONLESS) || dimEqual(r, DIMENSIONLESS)) return false;
      return !dimEqual(l, r);
    }
    default:
      return false;
  }
}

/** The operators an ABSOLUTE (offset-scale) operand may appear directly under. */
const ORDERING_OPS = new Set(['<', '<=', '>', '>=']);
/** The operators that combine two BOOLEANS, under which an ordering may sit. */
const BOOLEAN_OPS = new Set(['and', 'or', 'xor', 'implies']);

/** The first name an expression reads that `isPoint` says is a point on an offset scale. */
function firstPointIn(node: ExprNode, isPoint: (path: string) => boolean): string | undefined {
  switch (node.kind) {
    case 'ref': {
      const path = node.path.join('.');
      return isPoint(path) ? path : undefined;
    }
    case 'unary':
      return firstPointIn(node.operand, isPoint);
    case 'binary':
      return firstPointIn(node.left, isPoint) ?? firstPointIn(node.right, isPoint);
    case 'if':
      return firstPointIn(node.cond, isPoint) ?? firstPointIn(node.then, isPoint) ?? firstPointIn(node.else, isPoint);
    default:
      return undefined;
  }
}

/**
 * Does this relation body do ARITHMETIC on an offset (affine) scale — the fault
 * the unit-aware evaluator answers `offset` to?
 *
 * A °C value may be ORDERED (the affine map is monotone: `t2 >= 300 [K]` is a
 * real question with a real answer, and `compareQ` answers it), so a bare
 * reference to an absolute directly under `<`, `<=`, `>`, `>=` is fine.
 * Anywhere else — `+`, `-`, `*`, `/`, `==`, `!=`, an exponent, a negation, even
 * one step deeper under an ordering (`temp - ambient <= 5.0`) — the scale's
 * origin does not cancel and no reading of the magnitudes is the author's.
 *
 * Refusing here (rather than merely declining to SI-scale, which is what
 * gate (b) used to do) is what keeps the relation OUT of the equation and
 * inequality sets: `solveFeasible` and `optimize` read those residuals with no
 * unit-aware verdict in front of them, so a °C relation left in raw magnitudes
 * reported `100 >= 350` — infeasible for 100 °C against 350 K, which holds.
 * It also let an author's `dT == t1` PIN a kelvin-storage feature at 20 from a
 * question the unit-aware evaluator declines to answer at all. (An IDENTITY is
 * the deliberate exception: a BINDING, or a feature value that is a bare
 * reference, states that two values are the same rather than asking whether
 * they are, so it converts across the affine map — see `identity` in
 * {@link relationRefused} and `bindingEquation` of {@link ./solver}, which
 * bypasses this entirely.)
 */
function hasOffsetFault(
  node: ExprNode,
  scale: ScaleMap,
  nameToId: Map<string, ElementId>,
): boolean {
  return offsetFaultIn(node, (path) => isAbsoluteScale(scale.get(nameToId.get(path) ?? ''))) !== undefined;
}

/**
 * The first name read where an offset scale's origin does not cancel —
 * {@link hasOffsetFault}'s rule over any reading of which names are POINTS on
 * such a scale — or `undefined`.
 */
export function offsetFaultIn(node: ExprNode, isPoint: (path: string) => boolean): string | undefined {
  switch (node.kind) {
    case 'binary': {
      if (ORDERING_OPS.has(node.op)) {
        const side = (n: ExprNode): string | undefined => (n.kind === 'ref' ? undefined : firstPointIn(n, isPoint));
        return side(node.left) ?? side(node.right);
      }
      if (BOOLEAN_OPS.has(node.op)) return offsetFaultIn(node.left, isPoint) ?? offsetFaultIn(node.right, isPoint);
      return firstPointIn(node, isPoint);
    }
    case 'unary':
      return node.op === 'not' ? offsetFaultIn(node.operand, isPoint) : firstPointIn(node, isPoint);
    case 'if':
      return (
        offsetFaultIn(node.cond, isPoint) ?? firstPointIn(node.then, isPoint) ?? firstPointIn(node.else, isPoint)
      );
    default:
      return firstPointIn(node, isPoint);
  }
}

/**
 * The unit of the first operand that is a POINT on an offset scale read where
 * its origin does not cancel, though the scale map does not say so — or
 * `undefined`. That operand is a value that is an IDENTITY of a °C feature
 * (`t2 = t1`): the solver lane stores it in kelvin, so gate (b) reads it as an
 * amount, while the unit-aware evaluator reads the point it is and refuses
 * `t2 == 20.0` as offset arithmetic before it asks gate (e). The validation
 * surface named the offset, the verification engines `derived-bare-literal`;
 * both now name the offset, in the unit-aware evaluator's sentence. Names in
 * `skip` are read as nothing ({@link operandRefusal}).
 */
export function absoluteOperandFault(
  model: Model,
  node: ExprNode,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
  memo: DerivationMemo,
  skip: ReadonlySet<string> = NO_NAMES,
): string | undefined {
  const units = new Map<string, string>();
  const path = offsetFaultIn(node, (p) => {
    if (markers.has(p) || skip.has(p)) return false;
    const id = nameToId.get(p);
    const q = id !== undefined ? operandDerivation(model, id, memo)?.derivation.q : undefined;
    if (!q?.absolute) return false;
    units.set(p, q.unit ?? p);
    return true;
  });
  return path === undefined ? undefined : units.get(path);
}

/**
 * {@link hasDimensionalFault} and {@link hasOffsetFault} over one relation
 * body, scaled by its own vars — the two faults that make a body no numeric
 * relation at all, so it is dropped from the relation set rather than judged.
 *
 * `identity` exempts the offset half for a relation that STATES an identity of
 * two physical values rather than asking one — a binding, or a feature value
 * that is a bare reference (`attribute t3 : TemperatureValue = t1`). Such a
 * relation publishes no verdict anywhere, so there is no question to decline;
 * refusing it instead made the feature vanish from `SolveResult.values` with
 * nothing saying why, while the same identity written `bind` converted.
 *
 * Gate (e) is asked on its own ({@link derivedBareLiteral}), with the other
 * refusals of what a relation READS: each is a refusal with its own reason,
 * and the validation surface's sentence for it (`readRefusalOf` in
 * ./evaluate-model).
 */
export function relationRefused(
  model: Model,
  node: ExprNode,
  vars: ElementId[],
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
  memo: DerivationMemo,
  identity = false,
): boolean {
  const scale: ScaleMap = new Map();
  for (const id of vars) {
    const s = storageScaleOf(model, id, memo);
    if (s) scale.set(id, s);
  }
  if (hasDimensionalFault(node, scale, nameToId, markers)) return true;
  return !identity && hasOffsetFault(node, scale, nameToId);
}

/* ──────────── gate (e): a bare number against a derived dimension ──────────── */

/**
 * What gate (e) knows of an operand whose dimension comes ONLY from a
 * derivation — a value expression, or the asserted equations that define it,
 * with no declared unit and no declared ISQ kind.
 */
export interface DerivedOperand {
  /** The dimension the derivation gives it. */
  dimension: Dimension;
  /**
   * The type it is declared with, when it has one: the repair the refusal
   * names differs, because an UNTYPED operand is usually a ratio whose inlined
   * constant lost its unit.
   */
  typeName?: string;
}

/** Gate (e)'s finding: the operand a bare number met, as the body names it. */
export interface DerivedBareLiteral extends DerivedOperand {
  /** The name as the body writes it (`e`, `uav.endurance`). */
  name: string;
  /** The body's first numeric literal, for the repair's example (`45.0`). */
  literal: string;
}

/**
 * THE rule of what gate (e) calls a derived operand, on every surface: the
 * {@link DerivedOperand} a feature is, given its declared unit and the
 * derivation its magnitude comes from — or `undefined` when a unit is
 * declared (the bare literal is read in it), when there is no derivation (a
 * literal, kinded or not, keeps the declared-unit contract), when the
 * derivation is dimensionless (a kind over unitless inputs relabels it, as it
 * does a literal), or when it disagrees with the feature's type (that is the
 * `mismatch` refusal's, which every surface asks first).
 *
 * What decides is whether the VALUE is derived from dimensioned quantities, not
 * whether the feature declares a kind: `e : DurationValue = capacity / power`
 * is as much a derivation as `e = capacity / power`, and the scalar fallback of
 * the validation surface reads it unit-blind (0.98) either way, so the solver
 * lane — which read the literal in the kind's SI unit — compared 3544.6 s with
 * 45 and proved what the validation surface refused. The validation surface
 * passes the derivation it binds a name to; the solver lane, its own
 * ({@link derivedOperandOf}).
 */
export function derivedOperand(unit: string | undefined, d: FeatureDerivation | undefined): DerivedOperand | undefined {
  if (unit !== undefined) return undefined;
  if (!d?.derived || dimEqual(d.derived, DIMENSIONLESS) || d.claim === 'mismatch') return undefined;
  return { dimension: d.derived, ...(d.typeName !== undefined ? { typeName: d.typeName } : {}) };
}

/** {@link derivedOperand} of a feature as the solver lane reads it. */
function derivedOperandOf(model: Model, id: ElementId, memo: DerivationMemo): DerivedOperand | undefined {
  return derivedOperand(dimensionalFacets(model, id).unit, derivationOf(model, id, memo));
}

/** What gate (e) knows of one name a body reads, on whichever surface reads it. */
export interface OperandFacts {
  /** Its dimension comes only from a derivation: a bare number may not meet it. */
  derived?: DerivedOperand;
  /**
   * Why its own value has no magnitude any surface reads — a bare number
   * against a derived dimension where that value is written ({@link valueFaultOf}).
   */
  valueFault?: string;
}

/**
 * GATE (e): does this relation body compare a BARE number with an operand
 * whose dimension comes only from a derivation — or read an operand whose own
 * value does? The sentence it is refused with, or `undefined`.
 *
 * Gate (c) reads a dimensionless operand meeting a dimensioned one as the
 * declared-unit contract: the literal is in the feature's declared (or
 * storage) unit. A dimension that comes only from a derivation has no
 * declared unit to read it in. `attribute e = capacity / power` over 640 Wh
 * and 650 W is 3544.6 s on the solver lane, and `e >= 45.0` compared that with
 * 45 — proved — where an author who meant minutes would have `e <= 60.0`
 * refuted; fixed by an asserted equation instead, `e` was the raw quotient
 * 0.98 (hours) there, and `e <= 60.0` was proved. The validation surface
 * refused all of them. One rule now, here: the relation is REFUSED, with the
 * sentence {@link bareLiteralRefusal} composes, by `checkConstraints`, the
 * literal engine, the numeric surface and the SMT engine alike.
 *
 * Asked at every operator of the gate-(c) set — `==`, `!=`, the orderings,
 * `+` and `-`: one side dimensionless, the other dimensioned and reading a
 * derived operand ({@link derivedOperand}, kinded or not; a chain of
 * definitions is one). A `[unit]` literal is dimensioned, so `e >= 45.0 [min]`
 * is judged; a literal, kinded or not, keeps the contract.
 *
 * A feature chain that ends at a feature stating no value is read as nothing
 * here: the validation surface reads no such chain (its scope holds valued
 * features only), so it can meet no bare number there either — nor can a name
 * in `unreadNames`, which that surface reads no value for in the relation's
 * context (`unreadValuesOf` in ./evaluate-model). A chain in `chains` is the
 * exception: that surface reads the definition of the feature it ends at
 * there (`chainDefinition` of ./defining-equation), and judges it as it judges the
 * feature's own name.
 *
 * An author's relation body asks it, and so does a value — a feature's, or a
 * calculation's body: `m = e + 5.0` is 5.98 to the scalar scope and 3549.6 to
 * the solver, so it is neither solved nor axiomatised from. A binding states
 * that two values are one, and does not.
 */
export function derivedBareLiteral(
  model: Model,
  node: ExprNode,
  vars: ElementId[],
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
  memo: DerivationMemo,
  unreadNames: ReadonlySet<string> = NO_NAMES,
  chains: ReadonlySet<string> = NO_NAMES,
): string | undefined {
  const scale: ScaleMap = new Map();
  const facts = new Map<ElementId, OperandFacts>();
  for (const id of vars) {
    const s = storageScaleOf(model, id, memo);
    if (s) scale.set(id, s);
    const derived = derivedOperandOf(model, id, memo);
    const valueFault = valueFaultOf(model, id, memo);
    if (derived || valueFault) {
      facts.set(id, { ...(derived ? { derived } : {}), ...(valueFault ? { valueFault } : {}) });
    }
  }
  if (facts.size === 0) return undefined;
  const unread = (path: string): boolean => {
    if (unreadNames.has(path)) return true;
    if (!path.includes('.') || chains.has(path)) return false;
    const id = nameToId.get(path);
    const f = id !== undefined ? model.get(id) : undefined;
    return f !== undefined && !hasStatedValue(model, f);
  };
  const dimensionOf = refDimensionIn(scale, nameToId, markers);
  return bareLiteralRefusal(
    node,
    (path) => (unread(path) ? DIMENSIONLESS : dimensionOf(path)),
    (path) => {
      if (markers.has(path) || unread(path)) return undefined;
      const id = nameToId.get(path);
      return id === undefined ? undefined : facts.get(id);
    },
  );
}

/**
 * Gate (e) over any reading of the names a body reads: `refDimension` is the
 * dimension a name carries, `operandOf` its {@link OperandFacts}. The solver
 * lane reads the names through a relation's scale map ({@link
 * derivedBareLiteral}); the validation surface through the features it binds
 * them to, which may be a specialiser standing for a measure — one rule over
 * one dimensional arithmetic either way.
 *
 * A bare number meeting a derived operand in the body is named first (the
 * first such operand, in source order); failing that, the first operand whose
 * own value has no magnitude, as `"m" cannot be derived: …` — the shape the
 * unit-aware evaluator gives a link of a chain that fails.
 */
export function bareLiteralRefusal(
  node: ExprNode,
  refDimension: (path: string) => Dimension,
  operandOf: (path: string) => OperandFacts | undefined,
): string | undefined {
  const found = faultIn(node, refDimension, (path) => operandOf(path)?.derived);
  if (found) {
    return derivedBareLiteralReason({
      ...found.operand,
      name: found.name,
      literal: firstNumericLiteral(node) ?? '45.0',
    });
  }
  for (const path of new Set(namesReadIn(node))) {
    const inner = operandOf(path)?.valueFault;
    if (inner) return `"${path}" cannot be derived: ${inner}`;
  }
  return undefined;
}

/**
 * Why a feature's own value has no magnitude any surface reads: its value
 * expression — or, for a feature that states none, the defining side of the
 * asserted equation that defines it — compares or adds a bare number with an
 * operand whose dimension only a derivation gives (gate (e) where the value
 * is written), or reads a feature whose value does. The sentence, or
 * `undefined`.
 *
 * `attribute m = e + 5.0` over a derived `e` (3544.6 s) is 5.98 to the scalar
 * scope, which reads `e` unit-blind as 0.98, and 3549.6 to the solver, which
 * reads it in SI: two magnitudes, and `m <= 10.0` was satisfied on the one
 * surface and violated on the other. Neither is the author's; a relation that
 * reads `m` is refused instead, on every surface, naming the operand inside.
 *
 * Only a derivation the unit-aware evaluator could not read for a bare number
 * meeting a dimension (`dimension`) is looked into, so a unitless model asks
 * nothing here. Settled once per {@link DerivationMemo}.
 */
export function valueFaultOf(model: Model, id: ElementId, memo: DerivationMemo): string | undefined {
  let settled = VALUE_FAULTS.get(memo);
  if (!settled) {
    settled = new Map();
    VALUE_FAULTS.set(memo, settled);
  }
  if (settled.has(id)) return settled.get(id) ?? undefined;
  // In flight: a value read back into itself is a loop, refused as one.
  settled.set(id, null);
  const found = valueFaultUncached(model, id, memo);
  settled.set(id, found ?? null);
  return found;
}

const VALUE_FAULTS = new WeakMap<DerivationMemo, Map<ElementId, string | null>>();

function valueFaultUncached(model: Model, id: ElementId, memo: DerivationMemo): string | undefined {
  const reading = operandDerivation(model, id, memo);
  if (reading?.derivation.reason !== 'dimension') return undefined;
  const value = valueBodyOf(model, id, reading.derivation);
  if (!value) return undefined;
  const vars = relationVarsOf(value.node, value.nameToId);
  return derivedBareLiteral(model, value.node, vars, value.nameToId, value.markers, memo);
}

/**
 * The expression a feature's magnitude is derived from, with the names it
 * reads: its value expression in its owner's scope, or the defining side of
 * the asserted equation the derivation was read through, in the scope that
 * equation is written in.
 */
function valueBodyOf(
  model: Model,
  id: ElementId,
  derivation: FeatureDerivation,
): { node: ExprNode; nameToId: Map<string, ElementId>; markers: MarkerDimensions } | undefined {
  const el = model.get(id);
  if (!el) return undefined;
  const raw = statedValueOf(model, el);
  if (typeof raw === 'string') {
    const body = parseRelationBody(raw.trim());
    if (!body || (body.hadUnit && !body.resolved)) return undefined;
    const nameToId = mergeMaps(
      el.ownerId != null ? idScopeFor(model, el.ownerId) : new Map<string, ElementId>(),
      idScopeFor(model, el.id),
    );
    return { node: body.node, nameToId, markers: body.literals };
  }
  const constraint = derivation.definedBy !== undefined ? model.get(derivation.definedBy) : undefined;
  const side = constraint && el.declaredName ? definedSideOf(constraint, el.declaredName) : undefined;
  if (!constraint || !side) return undefined;
  return { node: side.node, nameToId: relationScope(model, constraint), markers: side.literals };
}

/**
 * The sentence a relation is refused with because an operand it reads has a
 * derivation the validation surface REFUSES — a dimension that disagrees with
 * the feature's type, a `[unit]` applied to a value that already carries a
 * dimension, offset arithmetic, definitions nested past the cap, or (for a
 * feature an equation defines) a loop — or `undefined`. The first such
 * operand, in source order, as the body names it.
 *
 * The validation surface refuses such a relation where it reads the operand:
 * the unit-aware evaluator answers the refusal for a value expression, and the
 * binding of a feature an equation defines carries it. The solver lane only
 * withheld SI scaling (gate (d)) and kept the relation in raw magnitudes, so
 * `e : Real = capacity / power` against `<= 60.0` was PROVED by the SMT
 * engine from 0.98 — and `e : DurationValue [min] = capacity / power`, whose
 * `[min]` meets a duration, was proved in minutes. It is refused there now,
 * with {@link refusalSentence}. A feature chain to a feature that states no
 * value, and a name in `unread`, are left alone: the validation surface reads
 * no definition there at all — except a chain in `chains`, whose definition
 * it reads where the chain ends (`chainDefinition` of ./defining-equation).
 *
 * A LOOP and a nest past the cap are no such refusal. They are limits of how
 * the validation surface reads one definition at a time, not faults in the
 * value, and the solver lane solves the system as a whole.
 */
export function operandRefusal(
  model: Model,
  node: ExprNode,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
  memo: DerivationMemo,
  unread: ReadonlySet<string> = NO_NAMES,
  chains: ReadonlySet<string> = NO_NAMES,
): { reason: QReason; detail: string; byDefinition: boolean } | undefined {
  for (const path of new Set(namesReadIn(node))) {
    if (markers.has(path) || unread.has(path)) continue;
    const id = nameToId.get(path);
    if (id === undefined) continue;
    const reading = operandDerivation(model, id, memo);
    if (!reading || (reading.byDefinition && path.includes('.') && !chains.has(path))) continue;
    // A loop, and definitions nested past the cap, are limits of how the
    // validation surface reads ONE definition at a time — not a fault in the
    // value. The solver lane solves such a system as a whole (`mass == dry +
    // fuel` beside `fuel == mass * 0.2` is 125 and 25), and refusing every
    // relation over it left a unitless coupled system with no values at all.
    if (reading.derivation.reason === 'cycle' || reading.derivation.reason === 'depth') continue;
    const detail = refusalSentence(reading.derivation, path, reading.byDefinition);
    if (detail) return { reason: reading.derivation.reason!, detail, byDefinition: reading.byDefinition };
  }
  return undefined;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** Every name an expression reads, in source order (repeats included). */
export function namesReadIn(node: ExprNode): string[] {
  switch (node.kind) {
    case 'ref':
      return [node.path.join('.')];
    case 'unary':
      return namesReadIn(node.operand);
    case 'binary':
      return [...namesReadIn(node.left), ...namesReadIn(node.right)];
    case 'if':
      return [...namesReadIn(node.cond), ...namesReadIn(node.then), ...namesReadIn(node.else)];
    default:
      return [];
  }
}

/** A derived operand, and the name the body reads it by. */
interface DerivedRead {
  name: string;
  operand: DerivedOperand;
}

function faultIn(
  node: ExprNode,
  refDimension: (path: string) => Dimension,
  derivedOf: (path: string) => DerivedOperand | undefined,
): DerivedRead | undefined {
  switch (node.kind) {
    case 'unary':
      return faultIn(node.operand, refDimension, derivedOf);
    case 'if':
      return (
        faultIn(node.cond, refDimension, derivedOf) ??
        faultIn(node.then, refDimension, derivedOf) ??
        faultIn(node.else, refDimension, derivedOf)
      );
    case 'binary': {
      if (DIMENSION_SENSITIVE.has(node.op)) {
        const l = dimensionUnder(node.left, refDimension);
        const r = dimensionUnder(node.right, refDimension);
        if (l !== INDETERMINATE && r !== INDETERMINATE) {
          const bareLeft = dimEqual(l, DIMENSIONLESS);
          if (bareLeft !== dimEqual(r, DIMENSIONLESS)) {
            const found = derivedReadIn(bareLeft ? node.right : node.left, derivedOf);
            if (found) return found;
          }
        }
      }
      return faultIn(node.left, refDimension, derivedOf) ?? faultIn(node.right, refDimension, derivedOf);
    }
    default:
      return undefined;
  }
}

/** The first derived operand an expression reads, in source order. */
function derivedReadIn(
  node: ExprNode,
  derivedOf: (path: string) => DerivedOperand | undefined,
): DerivedRead | undefined {
  switch (node.kind) {
    case 'ref': {
      const name = node.path.join('.');
      const operand = derivedOf(name);
      return operand ? { name, operand } : undefined;
    }
    case 'unary':
      return derivedReadIn(node.operand, derivedOf);
    case 'binary':
      return derivedReadIn(node.left, derivedOf) ?? derivedReadIn(node.right, derivedOf);
    case 'if':
      return (
        derivedReadIn(node.cond, derivedOf) ??
        derivedReadIn(node.then, derivedOf) ??
        derivedReadIn(node.else, derivedOf)
      );
    default:
      return undefined;
  }
}

/**
 * The sentence gate (e) refuses with, without the "Could not evaluate: " the
 * validation surface puts before it. The repair depends on what the operand
 * claims: a TYPED one is compared against a unit literal of its dimension
 * (the example uses the body's own literal with the registry's units of the
 * dimension, `45.0 [s]` or `45.0 [min]`); an UNTYPED one (`r2 = mtow / 25.0`)
 * is usually meant as a ratio whose inlined constant lost its unit, so the
 * honest repair is `mtow / 25.0 [kg]`, not a mass literal on the other side.
 */
export function derivedBareLiteralReason(f: DerivedBareLiteral): string {
  const d = f.dimension;
  const units = unitsOfDimension(d);
  const examples = units.map((u) => `\`${f.literal} [${u}]\``).join(' or ');
  const head =
    `"${f.name}" is derived from dimensioned quantities (${dimToString(d)}) and cannot be ` +
    'compared as a bare number; ';
  if (f.typeName === undefined) {
    return (
      head +
      'if it is meant as a pure ratio, give the inlined constant its unit so the dimensions cancel ' +
      `(\`… / 25.0 [${units[0]}]\`); otherwise type it by the ISQ kind of dimension ${dimToString(d)} ` +
      `and compare against a unit literal, e.g. ${examples}`
    );
  }
  return head + `compare against a unit literal of dimension ${dimToString(d)}, e.g. ${examples}`;
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
export function unitsOfDimension(d: Dimension): string[] {
  const all = UNIT_REGISTRY.filter((x) => !x.offsetSI && dimEqual(x.dimension, d));
  const coherent = all.filter((x) => x.factorToSI === 1);
  const others = all.filter((x) => x.factorToSI !== 1);
  const symbols = [...coherent, ...others].map((x) => x.symbol);
  const unique = symbols.filter((s, i) => symbols.indexOf(s) === i).slice(0, 3);
  return unique.length > 0 ? unique : ['unit'];
}

/**
 * A dimension no dimensional arithmetic can pin down — either because two
 * operands that must match do not (the gate-(c) refusal), or because the
 * expression shape says nothing about dimensions (a variable exponent). Both
 * are refusals: scaling past either publishes a confident SI number for a
 * question the unit-aware evaluator declines to answer.
 */
export const INDETERMINATE = 'indeterminate';
export type OperandDimension = Dimension | typeof INDETERMINATE;

/**
 * The dimension an expression carries under a relation's scale map, or
 * {@link INDETERMINATE}. This IS gate (c): the mismatch cases return
 * `INDETERMINATE` and propagate it to the root, so `scaleOfRelation` refuses
 * the whole relation.
 *
 * An unresolved name reads as dimensionless — it makes the relation's residual
 * `undefined` anyway, so it can only ever cost a scaling, never buy a wrong one.
 */
export function nodeDimension(
  node: ExprNode,
  scale: ScaleMap,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
): OperandDimension {
  return dimensionUnder(node, refDimensionIn(scale, nameToId, markers));
}

/** The dimension each name of a relation reads carries under its scale map: {@link nodeDimension}'s reading of a `ref`. */
function refDimensionIn(
  scale: ScaleMap,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
): (path: string) => Dimension {
  return (path) => {
    const lowered = markers.get(path);
    if (lowered) return lowered.dimension; // a lowered `[unit]` literal
    const id = nameToId.get(path);
    if (id === undefined) return DIMENSIONLESS;
    return scale.get(id)?.dimension ?? DIMENSIONLESS;
  };
}

/**
 * {@link nodeDimension} over any reading of the names an expression reads —
 * so gate (e) asks one dimensional arithmetic whichever surface supplies the
 * names ({@link bareLiteralRefusal}).
 */
function dimensionUnder(node: ExprNode, refDimension: (path: string) => Dimension): OperandDimension {
  switch (node.kind) {
    case 'ref':
      return refDimension(node.path.join('.'));
    case 'unary': {
      const inner = dimensionUnder(node.operand, refDimension);
      // `not` yields a truth value — but of an operand that may itself be
      // the mismatch: `not (limit == 500.0)` over `limit [g] = 500.0` is the
      // declared-unit contract inside, and scaling it read 0.5 kg against 500
      // and PROVED what the validation surface finds violated.
      if (node.op === 'not') return inner === INDETERMINATE ? INDETERMINATE : DIMENSIONLESS;
      return inner;
    }
    case 'binary':
      return binaryDimension(node, refDimension);
    case 'if': {
      const c = dimensionUnder(node.cond, refDimension);
      const t = dimensionUnder(node.then, refDimension);
      const e = dimensionUnder(node.else, refDimension);
      if (c === INDETERMINATE || t === INDETERMINATE || e === INDETERMINATE) return INDETERMINATE;
      return dimEqual(t, e) ? t : INDETERMINATE;
    }
    default:
      return DIMENSIONLESS; // a numeric/boolean/string/null literal
  }
}

/** {@link nodeDimension} for a binary node — where the gate-(c) set is applied. */
function binaryDimension(
  node: Extract<ExprNode, { kind: 'binary' }>,
  refDimension: (path: string) => Dimension,
): OperandDimension {
  const l = dimensionUnder(node.left, refDimension);
  const r = dimensionUnder(node.right, refDimension);
  if (l === INDETERMINATE || r === INDETERMINATE) return INDETERMINATE;
  switch (node.op) {
    case '*':
      return multiplyDim(l, r);
    case '/':
      return divideDim(l, r);
    case '%':
      return l; // a remainder keeps the dividend's dimension
    case '^': {
      // Only a literal exponent has a dimensional meaning; a variable one is
      // knowable only at a value, which is not what a gate may depend on.
      if (node.right.kind === 'num') return powDim(l, node.right.value);
      return dimEqual(l, DIMENSIONLESS) ? DIMENSIONLESS : INDETERMINATE;
    }
    case 'and':
    case 'or':
    case 'xor':
    case 'implies':
      return DIMENSIONLESS;
    default:
      // The gate-(c) set: the two operands must carry the SAME dimension.
      // A comparison yields a truth value (dimensionless); `+`/`-` yield the
      // shared dimension of their operands.
      if (!DIMENSION_SENSITIVE.has(node.op)) return DIMENSIONLESS;
      if (!dimEqual(l, r)) return INDETERMINATE;
      return node.op === '+' || node.op === '-' ? l : DIMENSIONLESS;
  }
}

/* ───────────────────── `[unit]` literals in a body ───────────────────── */

// The lowering lives in ./unit-literals, which imports nothing of this module,
// so the defining-equation reader can parse a body the way every relation is
// parsed without an import cycle. Re-exported here, where its callers find it.
export {
  NO_MARKERS,
  lowerUnitLiterals,
  parseRelationBody,
  substituteLiterals,
  withValueUnit,
  type LoweredBody,
  type LoweredLiteral,
} from './unit-literals';

/**
 * The variables of one relation body: the feature ids its expression actually
 * REFERENCES, resolved through `nameToId`, in first-seen order.
 *
 * This is the third argument of {@link relationRefused} and {@link
 * scaleOfRelation}, and it is lifted with them because the gates are not
 * indifferent to how it is built. Gates (a) and (d) of {@link scaleOfRelation}
 * iterate over it, so a caller that passed the whole SCOPE instead — every id
 * `nameToId` can reach, siblings the relation never names included — would let
 * an unrelated `weird : Real = 3 [furlong]` refuse a scale the numeric surface
 * grants. `relationInequality` would then read `body.hadUnit && !scale` and
 * drop the relation, so the second engine would report not-encodable exactly
 * where the numeric surface encodes: the two-engine divergence §5's
 * differential gate exists to catch, arrived at through the argument rather
 * than through the gate.
 *
 * So the construction is published with the gates it feeds, and both surfaces
 * of {@link ./solver} call it rather than keeping a private copy.
 */
export function relationVarsOf(node: ExprNode, nameToId: Map<string, ElementId>): ElementId[] {
  const out = new Set<ElementId>();
  collectVarIds(node, nameToId, out);
  return [...out];
}

/** Collect the feature ids referenced by an expression, via `nameToId`. */
function collectVarIds(node: ExprNode, nameToId: Map<string, ElementId>, out: Set<ElementId>): void {
  switch (node.kind) {
    case 'ref': {
      const id = nameToId.get(node.path.join('.'));
      if (id !== undefined) out.add(id);
      return;
    }
    case 'unary':
      collectVarIds(node.operand, nameToId, out);
      return;
    case 'binary':
      collectVarIds(node.left, nameToId, out);
      collectVarIds(node.right, nameToId, out);
      return;
    case 'if':
      collectVarIds(node.cond, nameToId, out);
      collectVarIds(node.then, nameToId, out);
      collectVarIds(node.else, nameToId, out);
      return;
    default:
      return;
  }
}

/** Name→id scope for a relation: its owner (subject) merged with itself. */
export function relationScope(model: Model, el: ElementRecord): Map<string, ElementId> {
  const owner = el.ownerId != null ? idScopeFor(model, el.ownerId) : new Map<string, ElementId>();
  const self = idScopeFor(model, el.id);
  return mergeMaps(owner, self);
}

/**
 * Build a name → feature-id resolver rooted at `contextId`, mirroring
 * {@link scopeFor} but mapping to ids: every feature reachable from the
 * context under its dotted chain, and under its bare name by the rule of the
 * one walk every scope shares ({@link DefiningEquations.scope}) — the scalar
 * and quantity scopes walk the same features and differ only in mapping a
 * name whose value they do not read. A fresh map: the caller may change it.
 */
export function idScopeFor(model: Model, contextId: ElementId): Map<string, ElementId> {
  return new Map(sharedDefinitions(model).scope(contextId, 'all'));
}

/** Merge id-scope maps; earlier maps win on key collisions. */
export function mergeMaps(...maps: Map<string, ElementId>[]): Map<string, ElementId> {
  const out = new Map<string, ElementId>();
  for (const m of maps) for (const [k, v] of m) if (!out.has(k)) out.set(k, v);
  return out;
}

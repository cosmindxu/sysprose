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
import { parseExpr, type ExprNode } from './expr';
import { effectiveFeatures } from './inheritance';
import {
  derivedDimensionOf,
  dimensionClaim,
  dimensionalFacets,
  type DerivationMemo,
} from './units-eval';
import {
  DIMENSIONLESS,
  dimEqual,
  divideDim,
  multiplyDim,
  powDim,
  resolveUnit,
  type Dimension,
} from './units';

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
 * derives to) — "SI by convention", the same reading the unit-aware evaluator
 * gives a unit-less kinded feature; failing that, the value is a plain number.
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
 *      there is a multiplier and never blocks scaling;
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

/** Marker name → the `[unit]` literal it stands for (magnitude and dimension). */
export type MarkerDimensions = ReadonlyMap<string, LoweredLiteral>;

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

/** Does this expression read any variable stored on an offset scale? */
function readsAbsolute(node: ExprNode, scale: ScaleMap, nameToId: Map<string, ElementId>): boolean {
  switch (node.kind) {
    case 'ref':
      return isAbsoluteScale(scale.get(nameToId.get(node.path.join('.')) ?? ''));
    case 'unary':
      return readsAbsolute(node.operand, scale, nameToId);
    case 'binary':
      return (
        readsAbsolute(node.left, scale, nameToId) || readsAbsolute(node.right, scale, nameToId)
      );
    case 'if':
      return (
        readsAbsolute(node.cond, scale, nameToId) ||
        readsAbsolute(node.then, scale, nameToId) ||
        readsAbsolute(node.else, scale, nameToId)
      );
    default:
      return false;
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
  switch (node.kind) {
    case 'binary': {
      if (ORDERING_OPS.has(node.op)) {
        const side = (n: ExprNode): boolean =>
          n.kind === 'ref' ? false : readsAbsolute(n, scale, nameToId);
        return side(node.left) || side(node.right);
      }
      if (BOOLEAN_OPS.has(node.op)) {
        return (
          hasOffsetFault(node.left, scale, nameToId) ||
          hasOffsetFault(node.right, scale, nameToId)
        );
      }
      return readsAbsolute(node, scale, nameToId);
    }
    case 'unary':
      return node.op === 'not'
        ? hasOffsetFault(node.operand, scale, nameToId)
        : readsAbsolute(node, scale, nameToId);
    case 'if':
      return (
        hasOffsetFault(node.cond, scale, nameToId) ||
        readsAbsolute(node.then, scale, nameToId) ||
        readsAbsolute(node.else, scale, nameToId)
      );
    default:
      return readsAbsolute(node, scale, nameToId);
  }
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
  switch (node.kind) {
    case 'ref': {
      const path = node.path.join('.');
      const lowered = markers.get(path);
      if (lowered) return lowered.dimension; // a lowered `[unit]` literal
      const id = nameToId.get(path);
      if (id === undefined) return DIMENSIONLESS;
      return scale.get(id)?.dimension ?? DIMENSIONLESS;
    }
    case 'unary':
      return node.op === 'not'
        ? DIMENSIONLESS
        : nodeDimension(node.operand, scale, nameToId, markers);
    case 'binary':
      return binaryDimension(node, scale, nameToId, markers);
    case 'if': {
      const c = nodeDimension(node.cond, scale, nameToId, markers);
      const t = nodeDimension(node.then, scale, nameToId, markers);
      const e = nodeDimension(node.else, scale, nameToId, markers);
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
  scale: ScaleMap,
  nameToId: Map<string, ElementId>,
  markers: MarkerDimensions,
): OperandDimension {
  const l = nodeDimension(node.left, scale, nameToId, markers);
  const r = nodeDimension(node.right, scale, nameToId, markers);
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

/**
 * A relation body with every `N [unit]` literal replaced by a marker name, plus
 * the SI magnitude each marker stands for.
 *
 * WHY a rewrite: {@link parseExpr} rejects `[` (deliberately — the GUI stores a
 * raw `1500 [kg]` string in a feature value and the solver seeds it through the
 * quantity engine), so a body like `mass <= 2000 [kg]` used to throw and
 * VANISH from the numeric surface. Folding the literal to its SI magnitude
 * before parsing keeps the body judged; the marker (rather than the number
 * itself) is what lets gate (c) still tell a dimensioned literal from a bare
 * one.
 */
/** The SI magnitude and dimension a lowering marker stands for. */
export interface LoweredLiteral {
  si: number;
  dimension: Dimension;
}

export interface LoweredBody {
  /** The body text, parseable by {@link parseExpr}. */
  text: string;
  /**
   * Marker name → the SI magnitude of the literal it replaced AND the dimension
   * that literal carried. The dimension is what lets gate (c) refuse
   * `v.mass <= 2000.0 [s]`: without it a lowered literal is just "dimensioned",
   * and a mass compared with a duration folds to a bare SI number and is judged
   * confidently — where the unit-aware evaluator answers `unknown`.
   */
  literals: Map<string, LoweredLiteral>;
  /** The body carried at least one `[unit]` literal. */
  hadUnit: boolean;
  /** Every `[unit]` literal was folded (false ⇒ the body cannot be judged). */
  resolved: boolean;
}

/**
 * A numeric literal followed by a `[unit]`, with the character before it
 * captured so a digit inside a NAME is not mistaken for a literal. (A
 * lookbehind would read better and is not used: the browser bundle targets
 * engines that predate it.)
 */
const UNIT_LITERAL_RE =
  /(^|[^A-Za-z0-9_.])((?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*\[([^\]]*)\]/g;
/** Any bracket group (used to spot a unit on a non-literal operand). */
const ANY_BRACKET_RE = /\[[^\]]*\]/;

export function lowerUnitLiterals(raw: string): LoweredBody {
  const literals = new Map<string, LoweredLiteral>();
  let hadUnit = false;
  let resolved = true;
  let n = 0;
  // A prefix the source cannot contain, so a marker can never shadow a real
  // feature name (`__uq0` is a legal SysML name, however unlikely).
  let prefix = '__uq';
  while (raw.includes(prefix)) prefix += 'q';
  let text = raw.replace(UNIT_LITERAL_RE, (_m, before: string, magnitude: string, unit: string) => {
    hadUnit = true;
    const u = resolveUnit(unit.trim());
    // An offset scale cannot be folded to a magnitude (10 °C is not 10 K), and
    // an unknown unit must not silently become a bare number.
    if (!u || u.offsetSI) {
      resolved = false;
      return `${before}${magnitude}`;
    }
    const name = `${prefix}${n++}`;
    literals.set(name, { si: Number(magnitude) * u.factorToSI, dimension: u.dimension });
    return `${before}${name}`;
  });
  if (ANY_BRACKET_RE.test(text)) {
    // A `[unit]` on something other than a literal — `(a + b) [m]`. The shape
    // is kept parseable so the relation can still be REPORTED, but nothing
    // about it may be judged.
    hadUnit = true;
    resolved = false;
    text = text.replace(new RegExp(ANY_BRACKET_RE.source, 'g'), ' ');
  }
  return { text, literals, hadUnit, resolved };
}

/** Replace the lowering markers with the SI magnitudes they stand for. */
export function substituteLiterals(node: ExprNode, literals: Map<string, LoweredLiteral>): ExprNode {
  switch (node.kind) {
    case 'ref': {
      const v = literals.get(node.path.join('.'));
      return v === undefined ? node : { kind: 'num', value: v.si };
    }
    case 'unary':
      return { ...node, operand: substituteLiterals(node.operand, literals) };
    case 'binary':
      return {
        ...node,
        left: substituteLiterals(node.left, literals),
        right: substituteLiterals(node.right, literals),
      };
    case 'if':
      return {
        ...node,
        cond: substituteLiterals(node.cond, literals),
        then: substituteLiterals(node.then, literals),
        else: substituteLiterals(node.else, literals),
      };
    default:
      return node;
  }
}

/** Parse a relation body, folding any `[unit]` literal into SI. */
export function parseRelationBody(raw: string): (LoweredBody & { node: ExprNode }) | undefined {
  const lowered = lowerUnitLiterals(raw);
  try {
    return { ...lowered, node: parseExpr(lowered.text) };
  } catch {
    return undefined;
  }
}

/** No `[unit]` literals were lowered in this relation. */
export const NO_MARKERS: MarkerDimensions = new Map<string, LoweredLiteral>();

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
 * {@link scopeFor} but mapping to ids: every effective feature reachable from the
 * context is exposed under both its dotted chain and its bare name.
 */
export function idScopeFor(model: Model, contextId: ElementId): Map<string, ElementId> {
  const map = new Map<string, ElementId>();
  collectIds(model, contextId, '', map, new Set());
  return map;
}

function collectIds(
  model: Model,
  ownerId: ElementId,
  prefix: string,
  map: Map<string, ElementId>,
  visited: Set<string>,
): void {
  const guardKey = `${prefix} ${ownerId}`;
  if (visited.has(guardKey)) return;
  visited.add(guardKey);

  for (const feat of effectiveFeatures(model, ownerId)) {
    const name = feat.declaredName;
    if (!name) continue;
    const full = prefix ? `${prefix}.${name}` : name;
    if (!map.has(full)) map.set(full, feat.id);
    if (!map.has(name)) map.set(name, feat.id);
    for (const type of model.typesOf(feat.id)) {
      collectIds(model, type.id, full, map, visited);
    }
  }
}

/** Merge id-scope maps; earlier maps win on key collisions. */
export function mergeMaps(...maps: Map<string, ElementId>[]): Map<string, ElementId> {
  const out = new Map<string, ElementId>();
  for (const m of maps) for (const [k, v] of m) if (!out.has(k)) out.set(k, v);
  return out;
}

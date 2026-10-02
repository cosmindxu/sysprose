/**
 * `[unit]` literals in a relation body: lowered to SI magnitudes before the
 * body is parsed, and folded back afterwards.
 *
 * Split out of {@link ./relations} so that the reader of defining equations
 * ({@link ./defining-equation}) parses a body exactly as every relation is
 * parsed — `e == 640.0 [Wh] / power` is the same equation to the validation
 * surface, the solver lane and the verification engines — without importing
 * the gates, which import it. Nothing here reads a model.
 */

import { parseExpr, type ExprNode } from './expr';
import { resolveUnit, type Dimension, type FactorTerm } from './units';

/** Marker name → the `[unit]` literal it stands for (magnitude and dimension). */
export type MarkerDimensions = ReadonlyMap<string, LoweredLiteral>;

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
  /**
   * The magnitude and the unit exactly as the AUTHOR wrote them (`45.0`, `min`).
   *
   * Carried because one consumer has to print the body back to a PERSON rather
   * than hand it to a solver: `property-check`'s back-translation (§3.3). It
   * renders the lowered tree, where this marker stands for its SI magnitude, and
   * a rendering that printed `2700` for `45.0 [min]` would show a number that is
   * in neither the file nor the author's head. Two fields rather than one
   * pre-joined string, so a renderer chooses its own spelling — `45.0 [min]` in
   * a clause, `45.0 min` in a sentence — without taking a substring apart.
   * Nothing that JUDGES a relation reads either: they are display text, never an
   * input to a gate.
   */
  magnitude: string;
  unit: string;
  /**
   * The unit's factor to SI (`0.001` for a gram), so a reader that holds exact
   * numbers — the SMT encoder — reads the literal as the author's decimal
   * times the same factor it reads a stored magnitude through, rather than as
   * the double `si` rounded to.
   */
  factor: number;
  /**
   * What `factor` is the product of, for a COMPOSED unit (`ft^3`, `g/cm^3`,
   * `ng` — `Unit.factorTerms` of ./units), so that exact reader multiplies the
   * parts' exact factors rather than reading the double their product rounds to.
   */
  factorTerms?: ReadonlyArray<FactorTerm>;
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
    literals.set(name, {
      si: Number(magnitude) * u.factorToSI,
      dimension: u.dimension,
      magnitude,
      unit: unit.trim(),
      factor: u.factorToSI,
      ...(u.factorTerms !== undefined ? { factorTerms: u.factorTerms } : {}),
    });
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
      // The number every evaluator reads is the SI double; `literal` keeps what
      // the author wrote beside it, for the one reader that holds exact numbers.
      if (v === undefined) return node;
      const terms = v.factorTerms !== undefined ? { factorTerms: v.factorTerms } : {};
      return { kind: 'num', value: v.si, literal: { magnitude: v.magnitude, factor: v.factor, ...terms } };
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

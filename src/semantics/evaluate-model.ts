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
 *    satisfied / violated / unknown.
 */

import { type ElementId, type ElementRecord, type Model } from '@core/index';
import { effectiveFeatures } from './inheritance';
import { evaluate, parseExpr, type EvalResult, type ExprNode } from './expr';
import { DIMENSIONLESS, UNIT_REGISTRY, dimEqual, dimToString, type Dimension } from './units';
import {
  dimensionClaimDetail,
  evaluateConstraintQuantityDetailed,
  isRefusalReason,
  type ConstraintQuantityResult,
  type DerivationMemo,
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
    return id === undefined ? undefined : valueOfFeature(model, id, inFlight);
  };
}

/**
 * The name → feature-id map a scope rooted at `contextId` resolves through:
 * every valued feature reachable from the context, under its dotted chain and
 * its bare name (first occurrence wins). Exposed so a caller can ask WHICH
 * feature a name denotes before deciding how to compare it.
 */
export function featureIdsFor(model: Model, contextId: ElementId): Map<string, ElementId> {
  const ids = new Map<string, ElementId>();
  collectIds(model, contextId, '', ids, new Set());
  return ids;
}

function collectIds(
  model: Model,
  ownerId: ElementId,
  prefix: string,
  ids: Map<string, ElementId>,
  visited: Set<string>,
): void {
  const guardKey = `${prefix} ${ownerId}`;
  if (visited.has(guardKey)) return;
  visited.add(guardKey);

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
      collectIds(model, type.id, full, ids, visited);
    }
  }
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
  if (raw === undefined || raw === null) return { unknown: true };
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
}

/**
 * Evaluate every ConstraintUsage / RequirementUsage that carries a boolean
 * expression (`attrs.expression`, e.g. from a `require { … }` clause) against a
 * scope built from its subject context (its owner, then itself), classifying
 * each as satisfied / violated / unknown.
 */
export function checkConstraints(model: Model): ConstraintCheck[] {
  const out: ConstraintCheck[] = [];
  // One derivation cache for the sweep; every constraint reads the same features.
  const memo: DerivationMemo = new Map();
  for (const el of model.ofKind('ConstraintUsage', 'RequirementUsage')) {
    const expr = el.attrs.expression;
    if (typeof expr !== 'string' || expr.trim() === '') continue;

    const check: ConstraintCheck = {
      id: el.id,
      ownerId: el.ownerId,
      expression: expr,
      result: 'unknown',
      message: '',
    };

    let node;
    try {
      node = parseExpr(expr);
    } catch (e) {
      // The scalar grammar rejects unit literals (`2000 [kg]`); retry with the
      // unit-aware evaluator before giving up. When the text does carry a
      // bracket, the unit-aware reason is the real one — "Unexpected character
      // '['" told the author the intended syntax was illegal.
      const ua = applyUnitAware(check, model, el, expr, memo);
      if (ua !== true) {
        check.result = 'unknown';
        if (!expr.includes('[') || ua.detail === undefined) {
          check.message = `Could not parse expression: ${(e as Error).message}`;
        } else if (ua.reason === 'parse') {
          // Both parsers refused, but the bracket is not the fault: the body
          // mixes a legal unit literal with syntax neither grammar has (a call
          // such as `DurationOf(x) <= 48 [h]`, an index, a string).
          check.message =
            'Could not evaluate: the body combines a unit literal with syntax the unit-aware evaluator does not ' +
            `support (a call, an index or a string literal) — the \`[unit]\` itself is legal; ${ua.detail}`;
        } else {
          check.message = `Could not evaluate: ${ua.detail}`;
        }
      }
      out.push(check);
      continue;
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
    const ua = applyUnitAware(check, model, el, expr, memo);
    if (ua === true) {
      out.push(check);
      continue;
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
    // The membership test lives in units-eval, beside the reasons themselves.
    if (isRefusalReason(ua.reason)) {
      check.result = 'unknown';
      check.message = `Could not evaluate: ${ua.detail}`;
      out.push(check);
      continue;
    }

    // The bare-literal contract holds for a LITERAL-valued feature: its
    // declared unit is the unit the literal is read in. It does not hold for a
    // DERIVED feature — `endurance = capacity * fraction / power` is 2835.7 s
    // or 0.7877 Wh/W depending on who reads it, and the scalar path reads raw
    // magnitudes — so a derived dimensioned feature is never compared as a
    // bare number: answer unknown and name the repair.
    const refusal = derivedBareLiteralRefusal(model, el, node, memo);
    if (refusal) {
      check.result = 'unknown';
      check.message = refusal;
      out.push(check);
      continue;
    }

    // Scope from the owner (subject context) merged with the constraint itself.
    const scope = combinedScope(model, el);
    const r = evaluate(node, scope);
    if ('unknown' in r) {
      check.result = 'unknown';
      check.message = 'Could not evaluate: a referenced value is unknown';
    } else if (r.value === true) {
      check.result = 'satisfied';
      check.message = 'Constraint satisfied';
    } else if (r.value === false) {
      check.result = 'violated';
      check.message = `Constraint violated: ${expr}`;
    } else {
      check.result = 'unknown';
      check.message = 'Expression did not evaluate to a boolean';
    }
    out.push(check);
  }
  return out;
}

/**
 * Try to classify a constraint with the unit-aware evaluator, writing the
 * outcome onto `check`. Returns `true` when it produced a definitive
 * satisfied/violated verdict, else the detailed inconclusive result.
 */
function applyUnitAware(
  check: ConstraintCheck,
  model: Model,
  el: ElementRecord,
  expr: string,
  memo: DerivationMemo,
): true | ConstraintQuantityResult {
  const ua = evaluateConstraintQuantityDetailed(model, el, { memo });
  if (ua.verdict === 'satisfied') {
    check.result = 'satisfied';
    check.message = 'Constraint satisfied';
    return true;
  }
  if (ua.verdict === 'violated') {
    check.result = 'violated';
    check.message = `Constraint violated: ${expr}`;
    return true;
  }
  return ua;
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
): string | undefined {
  const ownerIds = el.ownerId != null ? featureIdsFor(model, el.ownerId) : undefined;
  const selfIds = featureIdsFor(model, el.id);
  for (const name of referencedNames(node)) {
    const id = ownerIds?.get(name) ?? selfIds.get(name);
    if (id === undefined) continue;
    const derivation = dimensionClaimDetail(model, id, memo);
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

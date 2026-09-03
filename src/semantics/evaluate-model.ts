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
import { evaluate, parseExpr, type EvalResult } from './expr';
import { evaluateConstraintQuantity } from './units-eval';

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
  const ids = new Map<string, ElementId>();
  collectIds(model, contextId, '', ids, new Set());
  return (name: string) => {
    const id = ids.get(name);
    return id === undefined ? undefined : valueOfFeature(model, id, inFlight);
  };
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
      // unit-aware evaluator before giving up.
      if (!applyUnitAware(check, model, el, expr)) {
        check.result = 'unknown';
        check.message = `Could not parse expression: ${(e as Error).message}`;
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
    if (applyUnitAware(check, model, el, expr)) {
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
 * satisfied/violated verdict, `false` when it too was inconclusive.
 */
function applyUnitAware(
  check: ConstraintCheck,
  model: Model,
  el: ElementRecord,
  expr: string,
): boolean {
  const ua = evaluateConstraintQuantity(model, el);
  if (ua === 'satisfied') {
    check.result = 'satisfied';
    check.message = 'Constraint satisfied';
    return true;
  }
  if (ua === 'violated') {
    check.result = 'violated';
    check.message = `Constraint violated: ${expr}`;
    return true;
  }
  return false;
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

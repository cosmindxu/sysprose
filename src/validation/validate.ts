/**
 * The top-level model checker: run all (or a selected subset of) rules and
 * return diagnostics sorted by severity, then element, then rule.
 */

import type { Model } from '@core/index';
import type { Diagnostic } from './types';
import { SEVERITY_ORDER } from './types';
import { RULES } from './rules';

/** Options controlling which rules run. */
export interface ValidateOptions {
  /** Restrict validation to these rule ids (defaults to all rules). */
  ruleIds?: string[];
  /** Skip these rule ids (applied after {@link ruleIds}). */
  excludeRuleIds?: string[];
}

/**
 * Validate `model`, returning a stable, severity-sorted diagnostics list.
 *
 * Sort order: severity (error→warning→info), then `elementId`, then `ruleId`,
 * then diagnostic `id` — fully deterministic for snapshot-friendly output.
 */
export function validate(model: Model, opts: ValidateOptions = {}): Diagnostic[] {
  const steps = validateSteps(model, opts);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * {@link validate} in steps: yields after each rule has run, and returns the
 * list. The page's recompute drives it between frames on a large model, so that
 * no one task holds the page for the whole model's validation; `validate` drives
 * it to the end, so the two always return the same list.
 */
export function* validateSteps(model: Model, opts: ValidateOptions = {}): Generator<void, Diagnostic[]> {
  const include = opts.ruleIds ? new Set(opts.ruleIds) : undefined;
  const exclude = opts.excludeRuleIds ? new Set(opts.excludeRuleIds) : undefined;

  const rules = RULES.filter(
    (r) => (!include || include.has(r.id)) && !(exclude && exclude.has(r.id)),
  );

  // Implicit (connector feature-chain) features are not source text — they are
  // re-derived on every parse and duplicate the prototype they redefine. Any
  // diagnostic they attract (e.g. port-direction) already fires on that visible
  // prototype, so surfacing it again would point the user at a phantom element
  // absent from the Text view. Drop diagnostics anchored on an implicit element.
  const found: Diagnostic[] = [];
  for (const r of rules) {
    for (const d of r.run(model)) found.push(d); // not push(...): a rule may return very many
    yield;
  }
  const diagnostics = found.filter((d) => {
    if (!d.elementId) return true;
    return model.get(d.elementId)?.attrs.implicit !== true;
  });

  diagnostics.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.elementId ?? '').localeCompare(b.elementId ?? '') ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.id.localeCompare(b.id),
  );

  return diagnostics;
}

/** Convenience: true when `model` has no error-severity diagnostics. */
export function isValid(model: Model, opts?: ValidateOptions): boolean {
  return !validate(model, opts).some((d) => d.severity === 'error');
}

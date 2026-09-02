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
  const diagnostics = rules
    .flatMap((r) => r.run(model))
    .filter((d) => {
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

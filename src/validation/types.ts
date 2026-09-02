/**
 * Shared types for the validation engine.
 *
 * These shapes are part of the cross-module CONTRACT (docs/03 §4): the UI's
 * diagnostics panel, the text editor's problem markers and any automation that
 * lints a model all consume {@link Diagnostic} exactly as declared here. Do not
 * change field names/types without updating the contract.
 */

import type { Model } from '@core/index';

/** Diagnostic severities, ordered most→least severe for sorting. */
export type Severity = 'error' | 'warning' | 'info';

/**
 * A single validation finding. `elementId` points at the offending element so
 * the UI can navigate/select it; it is omitted only for model-global findings.
 */
export interface Diagnostic {
  /** Stable, unique id for this diagnostic (`<ruleId>#<n>`). */
  id: string;
  /** Id of the {@link ValidationRule} that produced this finding. */
  ruleId: string;
  /** Severity of the finding. */
  severity: Severity;
  /** Human-readable description of the problem. */
  message: string;
  /** Offending element id (absent for whole-model findings). */
  elementId?: string;
}

/**
 * A model-checking rule. `run` is pure: it inspects the model and returns zero
 * or more diagnostics. Rules MUST NOT mutate the model.
 */
export interface ValidationRule {
  /** Stable, kebab-case rule identifier (also used as a diagnostic prefix). */
  id: string;
  /** One-line human description of what the rule checks. */
  description: string;
  /** Default severity emitted by the rule (informational metadata). */
  severity: Severity;
  /** Inspect the model and return findings (no mutation). */
  run(model: Model): Diagnostic[];
}

/** Numeric rank used to sort diagnostics by severity (lower = more severe). */
export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

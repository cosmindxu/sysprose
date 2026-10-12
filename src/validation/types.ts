/**
 * Shared types for the validation engine.
 *
 * These shapes are part of the cross-module CONTRACT (docs/03 §4): the UI's
 * diagnostics panel, the text editor's problem markers and any automation that
 * lints a model all consume {@link Diagnostic} exactly as declared here. Do not
 * change field names/types without updating the contract.
 *
 * The optional fields below form the **Agent Diagnostics Contract** (ADC,
 * `docs/AGENT-AUTHORING-CAMPAIGN.md`): the machine-readable half that lets an AI
 * agent authoring `.sysml` text locate and repair its own mistakes. They are
 * OPTIONAL by design — a model-only finding has no source text to point at —
 * but every diagnostic derived from parsing text carries `code` and `range`.
 */

import type { Model } from '@core/index';
import type { InstanceCounts } from '@semantics/evaluate-model';

/** Diagnostic severities, ordered most→least severe for sorting. */
export type Severity = 'error' | 'warning' | 'info';

/** A point in a source text: 1-based line/column, 0-based byte offset. */
export interface Pos {
  line: number;
  column: number;
  offset: number;
}

/** A half-open span of source text (`start` inclusive, `end` exclusive). */
export interface TextRange {
  start: Pos;
  end: Pos;
}

/**
 * Which stage produced a diagnostic. Lets a consumer filter (an agent fixing
 * syntax cares about `lexer`/`parser`; one fixing semantics cares about
 * `validation`) without parsing the `code` string.
 *
 * `verification` is the ONE source the formal-verification lane adds, and it
 * covers all of it: the contract inventory, the obligation worklist and
 * everything that comes after them. A lane split across four sources would let
 * a consumer filter three of them and silently miss the fourth, which is the
 * exact failure this type exists to prevent — and the prefix agrees with it,
 * so `source === 'verification'` and `code.startsWith('verification/')` select
 * the same rows.
 *
 * `checks` is the app's OWN source, and the one that is not derived from source
 * text at all: a `checks/*` row is the palette's status for a check — its
 * result, its scope, whether it could run — so it carries a code and NO
 * `range`, and the Agent Diagnostics Contract's range rule is narrowed for this
 * source alone. It is a `DiagnosticSource` all the same, because automation
 * reads its rows off the same report as every other finding.
 */
export type DiagnosticSource =
  | 'lexer'
  | 'parser'
  | 'mapper'
  | 'validation'
  | 'verification'
  | 'checks'
  | 'import'
  | 'simulate'
  | 'solve'
  | 'constraint-check'
  | 'fmi-import';

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

  /* ── Agent Diagnostics Contract (all optional; see docs/DIAGNOSTIC-CODES.md) ── */

  /** Stable catalogue id, e.g. `parse/mismatched-token`, `validation/duplicate-name`. */
  code?: string;
  /** Where in the SOURCE TEXT the problem is. Present for text-derived findings. */
  range?: TextRange;
  /** Qualified name of `elementId`, so a report is readable without the model. */
  elementName?: string;
  /** Tokens that would have been legal at `range.start` (parser errors). */
  expected?: string[];
  /** The offending token/text actually found there. */
  found?: string;
  /** One-line, actionable repair suggestion. */
  hint?: string;
  /** Producing stage. */
  source?: DiagnosticSource;
  /**
   * Which Problems-tab producer filed this row: the Check button
   * (`constraint-check`, the validator's constraint rules via
   * {@link useAppStore.runConstraintCheck}) or the Solve button (`solve`,
   * {@link useAppStore.solve}). The Problems tab labels rows by it (H6b).
   */
  producer?: 'check' | 'solve';

  /* ── per-instance findings (see C.2/C.3 and DIAGNOSTIC-CODES.md) ── */

  /** On a roll-up finding: how the relation's instances split, with the first few violated paths. */
  instances?: InstanceCounts & { listed: string[] };
  /** On a single-instance finding: the instance it names. */
  instance?: string;
  /** The relation a per-instance finding is about (its qualified name). */
  relation?: string;
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

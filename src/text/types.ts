/**
 * Shared textual-notation parse contract (architecture plan §4).
 *
 * Extracted from the former hand-written `parser.ts` so the contract survives
 * that file's removal. The LIVE parser is `langium/map-to-model.ts`
 * (`astToModel`, exported as `parseModel` from this module's barrel); these
 * types describe its result shape.
 *
 * `ParseDiagnostic` is a structural subset of the validation {@link Diagnostic}
 * (same field names and meanings) so a parse finding can be widened into one
 * without translation — see `src/text/check.ts` and the Agent Diagnostics
 * Contract in `docs/AGENT-AUTHORING-CAMPAIGN.md`.
 */

import type { Model, ElementId } from '@core/index';
import type { DiagnosticSource, TextRange } from '@validation/types';

/**
 * A parse diagnostic with 1-based source position.
 *
 * `line`/`column` are the START of {@link range} and are kept as top-level
 * fields for backward compatibility with every existing consumer.
 */
export interface ParseDiagnostic {
  message: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';

  /* ── Agent Diagnostics Contract ── */

  /** Stable catalogue id, e.g. `parse/mismatched-token` (docs/DIAGNOSTIC-CODES.md). */
  code?: string;
  /** Full span of the offending text. `range.start` matches `line`/`column`. */
  range?: TextRange;
  /** Tokens that would have been legal here (parser errors). */
  expected?: string[];
  /** The offending token text actually found. */
  found?: string;
  /** One-line, actionable repair suggestion. */
  hint?: string;
  /** Producing stage: `lexer`, `parser` or `mapper`. */
  source?: DiagnosticSource;
}

/** The result of `parseModel` (text → model + diagnostics). */
export interface ParseResult {
  model: Model;
  diagnostics: ParseDiagnostic[];
  /**
   * Source span of each element the parse created, keyed by element id.
   *
   * Deliberately a SIDE TABLE rather than a field on `ElementRecord`: ranges
   * are a property of one particular source text, not of the model, and must
   * never reach persistence or the element-graph interchange format. Used to
   * give validation findings a text position (`src/text/check.ts`) and, in the
   * UI, to jump from a problem row to the offending line.
   */
  ranges: Map<ElementId, TextRange>;
  /**
   * "Unresolved reference" warnings that the LIBRARY BINDER may later resolve,
   * paired with the element and attribute still holding the unresolved name.
   *
   * A forward type reference is unresolved at parse time and resolved after the
   * binder runs, so its warning must be retractable — see
   * `retractResolvedSpecializationWarnings`.
   */
  deferredSpecializationWarnings: Array<{
    diagnostic: ParseDiagnostic;
    elementId: ElementId;
    attr: string;
    /**
     * The name that must still be in `attr` for the warning to stand. Set for
     * attributes that can hold SEVERAL unresolved names (`specializes`), where
     * "the attribute is gone" is too coarse a test; omitted for single slots
     * that a second unresolved reference could overwrite.
     */
    ref?: string;
  }>;
}

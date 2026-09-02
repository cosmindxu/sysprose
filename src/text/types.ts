/**
 * Shared textual-notation parse contract (architecture plan §4).
 *
 * Extracted from the former hand-written `parser.ts` so the contract survives
 * that file's removal. The LIVE parser is `langium/map-to-model.ts`
 * (`astToModel`, exported as `parseModel` from this module's barrel); these
 * types describe its result shape.
 */

import type { Model } from '@core/index';

/** A parse diagnostic with 1-based source position. */
export interface ParseDiagnostic {
  message: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
}

/** The result of `parseModel` (text → model + diagnostics). */
export interface ParseResult {
  model: Model;
  diagnostics: ParseDiagnostic[];
}

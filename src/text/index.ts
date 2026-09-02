/**
 * Public surface of the textual-notation module.
 *
 * Provides bidirectional conversion between SysML v2 textual notation and the
 * core {@link Model}: {@link parseModel} (text → model + diagnostics) and
 * {@link serializeModel}/{@link serializeElement} (model → re-parseable text).
 *
 * The {@link parseModel} entry point is backed by the Langium grammar + the
 * AST->Model mapper (`langium/map-to-model.ts`); it is also exported explicitly
 * as {@link parseModelLangium}. (The original hand-written recursive-descent
 * parser and its legacy copy were removed — they were dead code, superseded by
 * the Langium parser and imported by nothing at runtime.)
 */

// Parser: Langium grammar + AST->Model mapper.
export { astToModel as parseModel } from './langium/map-to-model';
export { astToModel as parseModelLangium } from './langium/map-to-model';

// Post-type-binding connector endpoint pass: call AFTER resolveTypeReferences
// so chains through library-bound types resolve too (see the UI store).
export { resolveConnectorFeatureChains } from './langium/map-to-model';

// Shared result/diagnostic contract.
export type { ParseResult, ParseDiagnostic } from './types';

export { serializeModel, serializeElement } from './serializer';
export { lex } from './lexer';
export type { Token, TokenKind } from './lexer';

// Convenience aliases matching the architecture-plan §4 short names.
export { astToModel as parse } from './langium/map-to-model';
export { serializeModel as serialize } from './serializer';

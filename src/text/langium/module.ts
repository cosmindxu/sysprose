/**
 * Langium service wiring for the experimental SysML v2 textual parser.
 *
 * Authored originally for this project (standard Langium dependency-injection
 * boilerplate). Langium is MIT-licensed. The grammar it drives
 * (`sysml.langium`) is a clean-room transcription-free implementation of the
 * OMG SysML v2 / KerML textual notation — see docs/LICENSES.md.
 *
 * We build only the *core* (non-LSP) services with an empty file system, which
 * is all that is needed to tokenize + parse a source string into an AST. The
 * {@link parseDocument} helper is the entry point consumed by the AST->Model
 * mapper: it returns the parsed AST root together with the raw lexer/parser
 * errors so callers can gate on a fully error-free parse.
 */

import {
  EmptyFileSystem,
  inject,
  type LangiumCoreServices,
  type LangiumSharedCoreServices,
  type Module,
  type PartialLangiumCoreServices,
  createDefaultCoreModule,
  createDefaultSharedCoreModule,
} from 'langium';
import { SysMLGeneratedModule, SysMLGeneratedSharedModule } from './generated/module.js';
import type { Namespace } from './generated/ast.js';

/**
 * Custom, language-specific service overrides. Empty for now — the generated
 * defaults cover lexing and parsing, which is all the textual migration needs.
 */
export type SysmlAddedServices = Record<string, never>;

/** The full service type available for the `sysml` language. */
export type SysmlServices = LangiumCoreServices & SysmlAddedServices;

/** Language-specific module (custom overrides layered on the generated ones). */
export const SysmlModule: Module<
  SysmlServices,
  PartialLangiumCoreServices & SysmlAddedServices
> = {};

/**
 * Create the shared + language services for SysML using an empty (in-memory)
 * file system. Returns the language services used to obtain the parser.
 */
export function createSysmlServices(context = EmptyFileSystem): {
  shared: LangiumSharedCoreServices;
  Sysml: SysmlServices;
} {
  const shared = inject(
    createDefaultSharedCoreModule(context),
    SysMLGeneratedSharedModule,
  );
  const Sysml = inject(
    createDefaultCoreModule({ shared }),
    SysMLGeneratedModule,
    SysmlModule,
  );
  shared.ServiceRegistry.register(Sysml);
  return { shared, Sysml };
}

/** Result of {@link parseDocument}: the AST root plus raw parse diagnostics. */
export interface SysmlParseResult {
  /** The parsed root namespace (may be partial if `parserErrors` is non-empty). */
  ast: Namespace;
  lexerErrors: ReturnType<SysmlServices['parser']['LangiumParser']['parse']>['lexerErrors'];
  parserErrors: ReturnType<SysmlServices['parser']['LangiumParser']['parse']>['parserErrors'];
}

/** Cached services (creating them is comparatively expensive). */
let cachedServices: ReturnType<typeof createSysmlServices> | undefined;

/**
 * Tokenize + parse `text` into a SysML AST. Pure syntactic parse: no linking,
 * scoping or validation is performed here (name resolution against the model
 * happens in the AST->Model mapper). `lexerErrors`/`parserErrors` are the
 * Chevrotain diagnostics the acceptance gate checks for a clean parse.
 */
export function parseDocument(text: string): SysmlParseResult {
  cachedServices ??= createSysmlServices();
  const parser = cachedServices.Sysml.parser.LangiumParser;
  const result = parser.parse<Namespace>(text);
  return {
    ast: result.value,
    lexerErrors: result.lexerErrors,
    parserErrors: result.parserErrors,
  };
}

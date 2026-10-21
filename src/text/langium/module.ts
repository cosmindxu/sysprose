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

/** Whether the parser itself has been built (see {@link warmParser}). */
let parserBuilt = false;

/**
 * Build the parser now, so the first {@link parseDocument} does not pay for it.
 * The services come back at once; the parser is built the first time something
 * asks for it, and building it runs Chevrotain's lookahead analysis — about
 * 1.3 s in a browser and 99% of what a first parse costs (the next ones take
 * milliseconds). A page that calls this at idle moves that wait off the click
 * on "Apply text → model" (`src/ui/parser-warmup.ts`).
 */
export function warmParser(): void {
  cachedServices ??= createSysmlServices();
  void cachedServices.Sysml.parser.LangiumParser;
  parserBuilt = true;
}

/** Whether the parser is built: a parse now costs milliseconds, not the construction. */
export function parserIsWarm(): boolean {
  return parserBuilt;
}

/**
 * Tokenize + parse `text` into a SysML AST. Pure syntactic parse: no linking,
 * scoping or validation is performed here (name resolution against the model
 * happens in the AST->Model mapper). `lexerErrors`/`parserErrors` are the
 * Chevrotain diagnostics the acceptance gate checks for a clean parse.
 */
export function parseDocument(text: string): SysmlParseResult {
  cachedServices ??= createSysmlServices();
  const parser = cachedServices.Sysml.parser.LangiumParser;
  parserBuilt = true;
  const result = parser.parse<Namespace>(text);
  return {
    ast: result.value,
    lexerErrors: result.lexerErrors,
    parserErrors: result.parserErrors,
  };
}

/**
 * The offsets at which the parser's own lexer starts a token it hands the
 * parser (whitespace and `//` notes are not handed over) when it reads `text`:
 * the places it reads as code. An offset inside a string, a quoted name or a
 * `/* … *\/` comment is not one, whichever field of the text opened it.
 */
export function tokenStarts(text: string): Set<number> {
  cachedServices ??= createSysmlServices();
  const { tokens } = cachedServices.Sysml.parser.Lexer.tokenize(text);
  return new Set(tokens.map((t) => t.startOffset));
}

/**
 * The keyword reader — one place that knows what a `#keyword` is, what it
 * names, and which spellings belong to somebody else.
 *
 * WHY IT IS ITS OWN MODULE. Reading prefix metadata used to be three lines
 * copied into `statement-kind.ts` and `contracts.ts`: `attrs.metadata` mapped
 * to strings. Three readers is how a tool ends up reading a qualified keyword
 * in one report and not in the next. This module is the single reader, and the
 * two callers above consume it.
 *
 * WHAT A KEYWORD IS, IN THE NOTATION. SysML v2 §7.27.4 defines the
 * user-defined keyword as the (short) name of a `metadata def`, written after a
 * `#` in front of a declaration; §7.27.1 says such a definition "simply acts as
 * a user-defined syntactic tag on the annotated element". The token is stored
 * EXACTLY as written — `#exceptional`, `#SysproseVerification::exceptional` and
 * the quoted `#'requirement'` are three spellings the parser keeps verbatim —
 * so every reading here cuts the token into segments and unquotes the last one
 * before comparing anything.
 *
 * THREE ANSWERS, KEPT SEPARATE ON PURPOSE, because collapsing any two of them
 * is how a tool starts treating a vocabulary it did not define as its own:
 *
 *  1. {@link keywordsOf} — what is WRITTEN. Verbatim, no interpretation.
 *  2. {@link resolveKeyword} — what it NAMES, resolved against the
 *     `MetadataDefinition`s in scope by the same full-name resolution every
 *     other reference in this tool goes through. A keyword that names nothing
 *     resolves to `undefined`, and that is a reportable fact rather than an
 *     error: metadata is unvalidated here, and a misspelt `#prosee` has always
 *     been silently no tag at all.
 *  3. {@link foreignKeyword} — what a THIRD-PARTY spelling would be read as,
 *     out of {@link FOREIGN_KEYWORD_ALIASES}.
 *
 * THE LINE THIS MODULE HOLDS. An alias hit is never an answer to (1) or (2). No
 * function here rewrites a written keyword into a Sysprose one, and
 * {@link hasKeyword} — the predicate a downstream engine asks — answers only
 * from real resolution, so `#Exception` is *not* `#exceptional` to anything
 * that asks whether the model used the shipped vocabulary. What the alias table
 * buys is that a foreign file can still be READ: a caller that wants the
 * foreign reading has to ask for it by name, and every such caller carries the
 * {@link ForeignKeywordAlias.note} onto the line it prints, so no keyword-derived
 * row can appear without the spelling that produced it.
 *
 * Pure: reading a model never writes to it.
 */

import {
  findLibraryType,
  splitQualified,
  unquoteName,
  type ElementId,
  type ElementRecord,
  type Model,
} from '@core/index';
import { resolveFullName } from './bind';
import {
  EXCEPTIONAL_QUALIFIED_KEYWORD,
  SYSPROSE_VERIFICATION_PACKAGE,
} from './verification-vocabulary';

/* ────────────────────────────── what is written ────────────────────────── */

/** One prefix keyword, as written, with the element it was written on. */
export interface Keyword {
  /** The token exactly as it appears after the `#` — qualification and quotes included. */
  written: string;
  /** Its last segment, unquoted: the name a `metadata def` would answer to. */
  name: string;
  /** The qualifying segments before that name, unquoted; empty for a bare keyword. */
  qualifier: string[];
  /** The element carrying it. */
  elementId: ElementId;
}

/**
 * The prefix keywords on one element, in the order they were written.
 *
 * The generalisation of the module-private readers this replaces. It answers
 * about an ELEMENT rather than a record so that a caller holding an id does not
 * have to fetch first, and so the two callers that used to read
 * `attrs.metadata` themselves now cannot disagree about what the attribute
 * holds: a missing attribute, a non-array value and an array of non-strings all
 * mean "no keyword", and they mean it in one place.
 */
export function keywordsOf(model: Model, id: ElementId): Keyword[] {
  const el = model.get(id);
  return el ? keywordsOnRecord(el) : [];
}

/** {@link keywordsOf} for a record already in hand. */
export function keywordsOnRecord(el: ElementRecord): Keyword[] {
  const meta = el.attrs.metadata;
  if (!Array.isArray(meta)) return [];
  return meta.map((raw) => {
    const written = String(raw);
    const segments = splitQualified(written).map((s) => unquoteName(s) ?? '');
    return {
      written,
      name: segments[segments.length - 1] ?? '',
      qualifier: segments.slice(0, -1),
      elementId: el.id,
    };
  });
}

/* ─────────────────────────────── what it names ──────────────────────────── */

/**
 * The `metadata def` a keyword names, or `undefined` when it names none.
 *
 * Resolution is {@link resolveFullName} — KerML full name resolution, the same
 * walk that binds every type reference in this tool — restricted to
 * `MetadataDefinition`, then the bundled library as the namespace of last
 * resort. Both halves matter: the first is why `#exceptional` resolves inside
 * the package that declares it and inside one that imports it, and NOT in a
 * sibling package that does neither (which is the specification's answer, not a
 * limitation); the second is why the library's own `#derive` resolves at all.
 *
 * The scope is the annotated element's OWNER, because that is the namespace the
 * annotated declaration is written in.
 */
export function resolveKeyword(
  model: Model,
  keyword: Keyword | string,
  scopeId?: ElementId | null,
): ElementRecord | undefined {
  const kw = typeof keyword === 'string' ? parseKeyword(keyword) : keyword;
  if (kw.name === '') return undefined;
  const scope =
    scopeId !== undefined ? scopeId : (model.get(kw.elementId)?.ownerId ?? null);
  // The token AS WRITTEN, quotes and all: `resolveFullName` cuts it with
  // `refSegments`, which keeps a quoted segment whole. Re-joining the unquoted
  // segments here instead shattered the one shape quoting exists for — a
  // `#'a.b'` is ONE name, and the rejoined `a.b` was re-split into `a` and `b`
  // and "resolved" to a definition that answers to neither. Reporting a keyword
  // as resolved when no `MetadataDefinition` in scope carries that name is the
  // one thing §3.12 says this reader must never do.
  const hit = resolveFullName(model, kw.written, scope, { accept: isMetadataDefinition });
  if (hit) return hit;
  // The bundled library is the namespace of last resort, exactly as it is for a
  // type reference: `findLibraryType` is what answers `#derive` and `#moe`,
  // which are the standard library's own keywords and would otherwise be
  // reported as naming nothing. Its index is keyed on UNQUOTED simple names, so
  // this half takes the rejoined form — `#'derive'` has to find `derive`.
  const unquoted = [...kw.qualifier, kw.name].join('::');
  const fromLibrary = findLibraryType(model, unquoted);
  return fromLibrary && isMetadataDefinition(fromLibrary) ? fromLibrary : undefined;
}

/** A keyword written as a bare string, with no element behind it. */
function parseKeyword(written: string): Keyword {
  const segments = splitQualified(written).map((s) => unquoteName(s) ?? '');
  return {
    written,
    name: segments[segments.length - 1] ?? '',
    qualifier: segments.slice(0, -1),
    elementId: '',
  };
}

function isMetadataDefinition(el: ElementRecord): boolean {
  return el.eClass === 'MetadataDefinition';
}

/**
 * Does `id` carry a keyword that RESOLVES to the metadata definition `definition`?
 *
 * The predicate an engine asks before acting on a tag, and it is deliberately
 * strict on both sides. It never consults {@link FOREIGN_KEYWORD_ALIASES}: a
 * third-party `#Exception` is not `#exceptional`, and an engine that could not
 * tell the two apart would let a vocabulary this tool did not define change
 * what it decides. And it never string-matches: a keyword that names no
 * definition in scope is a keyword that tags nothing, which is the same answer
 * the notation gives.
 *
 * `definition` may be the definition's declared name, its short name (the
 * keyword spelling) or its qualified name — the three ways a caller has of
 * naming the thing it shipped.
 */
export function hasKeyword(model: Model, id: ElementId, definition: string): boolean {
  const wanted = definition.trim();
  if (wanted === '') return false;
  for (const keyword of keywordsOf(model, id)) {
    const def = resolveKeyword(model, keyword);
    if (!def) continue;
    if (
      def.declaredName === wanted ||
      def.declaredShortName === wanted ||
      model.qualifiedName(def.id) === wanted
    ) {
      return true;
    }
  }
  return false;
}

/* ──────────────────────── somebody else's vocabulary ────────────────────── */

/** What a third-party spelling is read AS. */
export type ForeignReading =
  /** A Sysprose keyword: the same tag, spelled the way another tool spells it. */
  | { as: 'keyword'; keyword: string; definition: string }
  /**
   * A clause role: the relation it tags enters the worklist as a premise
   * (`assume`) or as something to show (`require`) — and ONLY under
   * `obligations --from-keywords`, which is off by default.
   */
  | { as: 'clause-role'; role: 'assume' | 'require' };

/** One entry of the foreign-alias table. */
export interface ForeignKeywordAlias {
  /** The third-party spelling, as it is written after the `#`. */
  spelling: string;
  /** What this tool reads it as. */
  reads: ForeignReading;
  /**
   * The provenance sentence. Printed on EVERY line that used the keyword —
   * that is the rule, not a suggestion: a keyword-derived row without the
   * spelling that produced it is this tool passing off somebody else's
   * vocabulary as its own.
   */
  note: string;
}

/**
 * The third-party spellings this tool recognises, and what it reads them as.
 *
 * Read-only, small, and deliberately not extensible at run time. It exists so
 * that a model annotated with another tool's vocabulary is LEGIBLE — the
 * inventory can say what it thinks the file meant — and not so that such a
 * model is silently treated as if it had used the shipped one. Every reading
 * here is opt-in at the command line, carries {@link ForeignKeywordAlias.note}
 * onto the line that used it, and raises `verification/foreign-keyword`.
 *
 * `#Observable` is deliberately absent: the facet is HELD (see
 * {@link ./verification-vocabulary}), and an alias for a keyword this tool does
 * not ship would read as a commitment it has not made. It lands in the
 * inventory as "names nothing", which is exactly what it does.
 *
 * Keyed on the spelling as written, case-sensitively, because `#Exception` and
 * `#exception` are two files' conventions rather than one — both are listed.
 */
export const FOREIGN_KEYWORD_ALIASES: ReadonlyMap<string, ForeignKeywordAlias> = new Map(
  (
    [
      {
        spelling: 'Exception',
        reads: {
          as: 'keyword',
          keyword: EXCEPTIONAL_QUALIFIED_KEYWORD,
          definition: SYSPROSE_VERIFICATION_PACKAGE,
        },
        note: `a third-party spelling read as \`${EXCEPTIONAL_QUALIFIED_KEYWORD}\` — not SysML v2, not a Sysprose keyword`,
      },
      {
        spelling: 'exception',
        reads: {
          as: 'keyword',
          keyword: EXCEPTIONAL_QUALIFIED_KEYWORD,
          definition: SYSPROSE_VERIFICATION_PACKAGE,
        },
        note: `a third-party spelling read as \`${EXCEPTIONAL_QUALIFIED_KEYWORD}\` — not SysML v2, not a Sysprose keyword`,
      },
      {
        spelling: 'precondition',
        reads: { as: 'clause-role', role: 'assume' },
        note: 'a third-party spelling read as an `assume` clause — SysML v2 expresses this three ways (`assume constraint`, a case `objective`, a transition `guard`), so no keyword is shipped for it',
      },
      {
        spelling: 'postcondition',
        reads: { as: 'clause-role', role: 'require' },
        note: 'a third-party spelling read as a `require` clause — SysML v2 expresses this as `require constraint`, and on a case the objective\'s subject already resolves to the case result, so no keyword is shipped for it',
      },
    ] as const satisfies readonly ForeignKeywordAlias[]
  ).map((alias) => [alias.spelling, alias]),
);

/**
 * The alias for a keyword, or `undefined` when the spelling is nobody's but the
 * author's.
 *
 * Matched on the LAST segment: a file that writes `#TheirTool::Exception` is
 * naming its own tool's definition, and the spelling it chose is still the one
 * this table knows.
 */
export function foreignKeyword(keyword: Keyword | string): ForeignKeywordAlias | undefined {
  const name = typeof keyword === 'string' ? parseKeyword(keyword).name : keyword.name;
  return FOREIGN_KEYWORD_ALIASES.get(name);
}

/**
 * The packages whose definitions are this tool's OWN vocabulary.
 *
 * Named here rather than imported, because `statement-kind.ts` consumes this
 * module and importing its constant back would close a cycle.
 * `test/unit/semantics.keywords.test.ts` compares this set against
 * `STATEMENT_KIND_PACKAGE` and `SYSPROSE_VERIFICATION_PACKAGE` so the copy
 * cannot drift away from the two modules that declare them.
 */
export const SYSPROSE_KEYWORD_PACKAGES: ReadonlySet<string> = new Set([
  SYSPROSE_VERIFICATION_PACKAGE,
  'SysproseStatements',
]);

/**
 * Is this the vocabulary Sysprose ships?
 *
 * Asked of the RESOLVED definition rather than of the spelling, so a model that
 * declares its own `metadata def <exceptional>` in its own package is reported
 * as using its own vocabulary — which is what it is doing.
 */
export function isSysproseVocabulary(model: Model, definition: ElementRecord): boolean {
  const [root] = splitQualified(model.qualifiedName(definition.id));
  return root !== undefined && SYSPROSE_KEYWORD_PACKAGES.has(root);
}

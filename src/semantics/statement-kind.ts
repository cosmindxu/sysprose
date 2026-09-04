/**
 * Statement kinds — what a statement in a model is FOR.
 *
 * Three values, and they are Sysprose's own:
 *
 *  - `requirement` — a normative statement, the only kind with contractual
 *    value; it is what coverage, satisfaction and the requirement rules are
 *    about.
 *  - `prose` — an explanation written for a human reader. It binds nothing.
 *  - `prompt` — guidance for an AI agent doing modelling or verification work,
 *    read in the context of the element it hangs on.
 *
 * WHY A VOCABULARY OF OUR OWN. The published SysML v2 specification has no
 * enumeration of statement kinds. Its one requirement-related "kind",
 * `RequirementConstraintKind = assumption | requirement`, classifies a
 * MEMBERSHIP (`assume` / `require`) inside a requirement body, not a statement;
 * and the shipped library classifies requirements by SUBCLASSIFICATION
 * (`FunctionalRequirementCheck`, `PerformanceRequirementCheck`, …), not by an
 * attribute. Nothing there separates an explanation from a rule, or names
 * guidance meant for a machine reader. So these three values are an extension,
 * and this file says so rather than dressing them up as something they are not.
 *
 * WHAT IS BORROWED IS THE MECHANISM, NOT THE VOCABULARY. SysML v2 §7.27.1 says
 * a metadata usage exists to "add tool-specific information to a model that can
 * be relevant to the function of various kinds of tooling", and that a metadata
 * definition with no nested features "simply acts as a user-defined syntactic
 * tag on the annotated element". §7.27.4 defines the user-defined keyword — the
 * (short) name of a metadata definition written after a `#`. The standard's own
 * library uses exactly this shape for `<derive>` in RequirementDerivation. So a
 * kind is carried as `#prose` / `#prompt` / `#'requirement'` in front of a
 * declaration, over the three metadata definitions in
 * {@link STATEMENT_KIND_LIBRARY}. No notation is invented, no grammar changed:
 * prefix metadata already parses and round-trips here.
 *
 * WHY `'requirement'` IS QUOTED. `requirement` is a hard keyword in the
 * notation, so a bare `#requirement` does not parse — the notation's own escape
 * for a name that collides with a keyword is the single-quoted *unrestricted
 * name*, `#'requirement'`. The parser stores the token as written, quotes
 * included, which is why reading a keyword goes through {@link unquoteName}.
 *
 * WHAT THIS MODULE DOES NOT DO — three gaps, named rather than hidden.
 *
 *  1. Nothing binds a `#keyword` to the definition it names: metadata is
 *     unvalidated in this tool today, so a misspelt `#prosee` is silently no
 *     kind at all rather than an error.
 *  2. Only the `#keyword` prefix is read. The same metadata mechanism has a
 *     second, longer notation — the annotating usage `@prose about p1;`, which
 *     this tool parses and round-trips — and {@link statementKindOf} does NOT
 *     see it, for the annotated element or for the annotation itself. Reading it
 *     means resolving the names in `about` against scope, which is a resolver
 *     pass this module does not run; until it does, a kind written that way is
 *     invisible here. `test/unit/semantics.statement-kind.test.ts` pins that as
 *     a fact so it cannot change unnoticed.
 *  3. A kind classifies an ELEMENT, not each statement inside it. A `doc` body
 *     cannot be tagged separately from the requirement that owns it.
 *
 * {@link statementKindOf} therefore answers from the keyword alone, then from
 * the metaclass, and reading never writes.
 */

import {
  isControlNode,
  isRelationship,
  isRequirement,
  splitQualified,
  unquoteName,
  type ElementId,
  type ElementRecord,
  type Model,
} from '@core/index';

/* ──────────────────────────── The vocabulary ──────────────────────────── */

/** The three statement kinds, most binding first. */
export const STATEMENT_KINDS = ['requirement', 'prose', 'prompt'] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

const STATEMENT_KIND_SET = new Set<string>(STATEMENT_KINDS);

/** True for one of the three statement-kind values. */
export function isStatementKind(value: unknown): value is StatementKind {
  return typeof value === 'string' && STATEMENT_KIND_SET.has(value);
}

/** The package the shipped metadata definitions live in. */
export const STATEMENT_KIND_PACKAGE = 'SysproseStatements';

/** The metadata definition that carries each kind. */
export const STATEMENT_KIND_DEFINITIONS: Record<StatementKind, string> = {
  requirement: 'RequirementStatement',
  prose: 'ProseStatement',
  prompt: 'PromptStatement',
};

/**
 * How each keyword is SPELLED after the `#`. Only `requirement` needs quoting;
 * see the module header.
 */
export const STATEMENT_KIND_KEYWORD: Record<StatementKind, string> = {
  requirement: "'requirement'",
  prose: 'prose',
  prompt: 'prompt',
};

/**
 * The shipped definitions, as text. A model that wants the keywords to name
 * something declares this package (or imports it); the text is written in the
 * serializer's own canonical shape so that pasting it into a file and saving
 * gives the bytes back unchanged.
 */
export const STATEMENT_KIND_LIBRARY = `package ${STATEMENT_KIND_PACKAGE} {
    doc /* Statement kinds are a Sysprose extension, carried as user-defined keywords over metadata definitions (SysML v2 7.27.1, 7.27.4). Writing #'requirement', #prose or #prompt in front of a declaration says what the statement is for. */
    metadata def <${STATEMENT_KIND_KEYWORD.requirement}> ${STATEMENT_KIND_DEFINITIONS.requirement};
    metadata def <${STATEMENT_KIND_KEYWORD.prose}> ${STATEMENT_KIND_DEFINITIONS.prose};
    metadata def <${STATEMENT_KIND_KEYWORD.prompt}> ${STATEMENT_KIND_DEFINITIONS.prompt};
}`;

/* ────────────────────────────── Reading ───────────────────────────────── */

/**
 * The statement kind a prefix-metadata token names, or undefined for any other
 * keyword (`#Safety` is a tag, not a kind).
 *
 * A keyword may be written qualified (`#SysproseStatements::prose`) and the
 * `requirement` one is quoted, so the token is cut into segments and its last
 * one unquoted before it is compared.
 */
export function statementKindOfKeyword(keyword: string): StatementKind | undefined {
  const segments = splitQualified(keyword);
  const last = unquoteName(segments[segments.length - 1] ?? '');
  return isStatementKind(last) ? last : undefined;
}

/** The prefix-metadata keywords on an element, as written. */
function keywordsOf(el: ElementRecord): string[] {
  const meta = el.attrs.metadata;
  return Array.isArray(meta) ? meta.map((m) => String(m)) : [];
}

/**
 * The kind of the statement `id` makes, or undefined when it makes none.
 *
 * The keyword is the answer whenever there is one — an author who writes
 * `#prose requirement r1` means it, and the whole point of the vocabulary is
 * that a requirement-shaped element can be non-normative. Failing that, two
 * fallbacks say what the metaclass already implies: a requirement IS a
 * requirement, and a documentation or a comment IS prose. Everything else — a
 * part, a package, an action — makes no statement, and gets undefined rather
 * than a default, so a caller can tell "not classified" from "classified as a
 * requirement".
 *
 * Pure: reading a model never writes to it.
 */
export function statementKindOf(model: Model, id: ElementId): StatementKind | undefined {
  const el = model.get(id);
  if (!el) return undefined;
  for (const keyword of keywordsOf(el)) {
    const kind = statementKindOfKeyword(keyword);
    if (kind) return kind;
  }
  if (isRequirement(el.eClass)) return 'requirement';
  if (el.eClass === 'Documentation' || el.eClass === 'Comment') return 'prose';
  return undefined;
}

/* ────────────────────────────── Writing ───────────────────────────────── */

/**
 * True when THIS element's textual form has somewhere to put the keyword.
 *
 * Prefix metadata belongs to a DECLARATION — a package, a definition, a usage —
 * and only the serializer's generic `header()` path writes one. Everything the
 * serializer routes to a dedicated statement form instead (`serializer.ts`,
 * `serializeElement`'s dispatch) has no slot for a keyword in the notation, and
 * the parser agrees: `#prompt connect a to b;`, `#prompt import X::*;`,
 * `#prompt satisfy r by p;` and `#prose low = 0.25;` are all mismatched-token
 * errors. A keyword written on one of those would either vanish on the next save
 * or be emitted into a file this tool can no longer read.
 *
 * THE QUESTION IS NOT ONE A METACLASS CAN ANSWER. The serializer dispatches on
 * attributes and endpoints as much as on `eClass`: the same `ConnectionUsage`
 * carries a keyword as `connection c : C;` and refuses one as `connect a to b;`,
 * and a plain `ActionUsage` becomes `perform a;` the moment it carries
 * `actionKind`. So this predicate takes the ELEMENT, and mirrors that dispatch
 * branch for branch. Mirroring can drift, which is why the corpus test in
 * `test/unit/semantics.statement-kind.test.ts` writes a kind on every element of
 * both shipped examples that this predicate accepts and fails unless every one
 * of them survives a save and a re-parse.
 *
 * A refusal is not always the end of the story: a `doc` and a `comment` still
 * READ as prose through the fallbacks in {@link statementKindOf}. But a
 * `connect`, a `perform` or a transition can carry no kind at all today, and
 * saying so out loud beats writing one that disappears.
 */
export function canCarryStatementKind(el: ElementRecord): boolean {
  // No textual declaration at all: an implicit connector endpoint serializes to
  // the empty string, and a faulted declaration re-emits its original source
  // verbatim. A keyword on either is written nowhere.
  if (el.attrs.implicit === true) return false;
  const unparsed = el.attrs.unparsedText;
  if (typeof unparsed === 'string' && unparsed.trim() !== '') return false;

  // Annotating statements (`doc`, `comment`, `rep`, `@Meta`), every relationship
  // statement (`satisfy`, `import`, `alias`, `redefinition`, …) and the control
  // nodes (`fork`, `join`, …). A MetadataUsage is refused only in its ANNOTATING
  // form (`@Meta about x;`): the declaration form (`metadata m : MD;`) is an
  // ordinary header and takes a keyword like any other.
  if (
    el.eClass === 'Documentation' ||
    el.eClass === 'Comment' ||
    el.eClass === 'TextualRepresentation'
  )
    return false;
  if (el.eClass === 'MetadataUsage' && el.attrs.annotation === true) return false;
  if (isRelationship(el.eClass) || isControlNode(el.eClass)) return false;
  if (el.eClass === 'Disjoining') return false;

  // Endpoint-bearing usages: `connect a to b`, `flow a to b`, `bind a = b`,
  // `transition first s1 then s2`. The same metaclasses WITHOUT endpoints are
  // plain features (`connection c : C;`) and keep their header.
  if (
    (el.eClass === 'ConnectionUsage' ||
      el.eClass === 'FlowUsage' ||
      el.eClass === 'Connector' ||
      el.eClass === 'Flow') &&
    hasEndpoints(el)
  )
    return false;
  if (el.eClass === 'BindingConnectorAsUsage') return false;
  if (el.eClass === 'TransitionUsage' || el.eClass === 'TransitionFeature') return false;

  // Statement forms the serializer picks by attribute: `perform`/`accept`/`send`/
  // `assign`/`include`/`exhibit`, the loops and `if`, `return`, a requirement's
  // `subject`/`assume`/`require` clause, and a state's `entry`/`do`/`exit`.
  if (el.attrs.actionKind !== undefined) return false;
  if (el.eClass === 'WhileLoopActionUsage' || el.eClass === 'ForLoopActionUsage') return false;
  if (el.eClass === 'IfActionUsage') return false;
  if (el.attrs.featureRole === 'return') return false;
  if (el.attrs.requirementRole !== undefined) return false;
  if (el.attrs.stateSubaction !== undefined) return false;

  // An enum literal (`low = 0.25;`) is a ReferenceUsage declared with no
  // keyword. This one DOES reach `header()`, which would happily emit
  // `#prose low = 0.25;` — and that file no longer parses, because the
  // keyword-less literal form has no prefix-metadata slot in the grammar. It is
  // the one shape where a silent loss would have been the better failure.
  if (el.eClass === 'ReferenceUsage' && el.attrs.keywordless === true) return false;

  return true;
}

/**
 * Endpoints, the way the serializer counts them (`serializer.ts` `hasEndpoints`)
 * — a connector may carry them as resolved ids or as unresolved reference text.
 */
function hasEndpoints(el: ElementRecord): boolean {
  return (
    (el.source?.length ?? 0) > 0 ||
    (el.target?.length ?? 0) > 0 ||
    typeof el.attrs.sourceRef === 'string' ||
    typeof el.attrs.targetRef === 'string'
  );
}

/**
 * Give `id` a statement kind, replacing the one it had.
 *
 * The keyword is written in place of the kind it replaces so an existing
 * declaration order is kept, other keywords (`#Safety`) are left alone, and a
 * second kind keyword — which a hand-written file may carry — is removed rather
 * than left to contradict the first.
 *
 * @returns the element written to.
 * @throws when the element does not exist, the kind is not one of the three, or
 *   the element's notation has nowhere to carry a keyword — a silent no-op
 *   there would look like a save that lost the kind.
 */
export function setStatementKind(
  model: Model,
  id: ElementId,
  kind: StatementKind,
): ElementRecord {
  if (!isStatementKind(kind)) {
    throw new Error(
      `setStatementKind: "${String(kind)}" is not a statement kind (${STATEMENT_KINDS.join(', ')})`,
    );
  }
  const el = model.get(id);
  if (!el) throw new Error(`setStatementKind: no such element ${id}`);
  if (!canCarryStatementKind(el)) {
    throw new Error(
      `setStatementKind: a ${el.eClass} cannot carry a statement-kind keyword — its notation has no place to write one`,
    );
  }

  const keyword = STATEMENT_KIND_KEYWORD[kind];
  const next: string[] = [];
  let written = false;
  for (const existing of keywordsOf(el)) {
    if (!statementKindOfKeyword(existing)) {
      next.push(existing);
    } else if (!written) {
      next.push(keyword);
      written = true;
    }
  }
  if (!written) next.push(keyword);
  return model.setAttrs(id, { metadata: next });
}

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
  const written = writtenStatementKind(model, id);
  if (written) return written;
  const el = model.get(id);
  if (!el) return undefined;
  if (isRequirement(el.eClass)) return 'requirement';
  if (el.eClass === 'Documentation' || el.eClass === 'Comment') return 'prose';
  return undefined;
}

/**
 * The kind a keyword on `id` actually WRITES, with no metaclass fallback.
 *
 * {@link statementKindOf} answers what a statement IS, which is the question
 * every reader has. An EDITOR has the other one: what does this element
 * actually carry? The two differ on an untagged requirement — it READS as
 * `requirement` and holds no keyword at all — and a control driven by the first
 * cannot tell those states apart, so "take the tag off" looks like a no-op that
 * changed nothing and "tag it explicitly" fires no change event because the
 * value was already showing. A control needs this one; a rule wants the other.
 *
 * Pure: reading a model never writes to it.
 */
export function writtenStatementKind(model: Model, id: ElementId): StatementKind | undefined {
  const el = model.get(id);
  if (!el) return undefined;
  for (const keyword of keywordsOf(el)) {
    const kind = statementKindOfKeyword(keyword);
    if (kind) return kind;
  }
  return undefined;
}

/**
 * True when `id` is tagged with a kind that binds nothing — an explanation or
 * guidance for an agent, written in requirement or constraint shape.
 *
 * NOT the negation of "is normative". A plain `constraint c { … }` has no
 * statement kind at all: it is a rule about the machine, and it is checked
 * exactly as it always was. Only an author who SAID `#prose` or `#prompt` buys
 * the exemption, which is what keeps every model written before statement kinds
 * existed checked the way it was.
 */
export function isNonNormativeStatement(model: Model, id: ElementId): boolean {
  const kind = statementKindOf(model, id);
  return kind === 'prose' || kind === 'prompt';
}

/**
 * What a Kind control calls the state "no keyword is written here".
 *
 * It is a real, reachable state — most elements are in it — so the blank entry
 * of a Kind selector is not an empty slot but the current value, and it says
 * what the element then reads as. The word `requirement` alone would be wrong
 * there: the list would hold two entries reading the same word and meaning
 * different things (untagged, versus tagged `#'requirement'` on purpose), and a
 * click on either would look identical.
 *
 * ONE function, used by every Kind control there is, because a label that
 * differs between the Properties panel and the requirements grid is two
 * different promises about the same state.
 */
export function untaggedStatementKindLabel(effective: StatementKind | undefined): string {
  return effective ? `(untagged — reads as ${effective})` : '(untagged)';
}

/* ────────────────────────────── Writing ───────────────────────────────── */

/**
 * True when what is written onto `id` reaches the saved file at all.
 *
 * Two things make the serializer write something OTHER than an element's own
 * text. An implicit element (a connector endpoint materialised by the resolver)
 * serializes to the empty string and is filtered out of its owner's body. A
 * faulted declaration keeps its original source in `attrs.unparsedText`, and
 * the serializer re-emits that text verbatim and NOTHING else — its subtree
 * included, so a body is not written twice. Either way, everything UNDER such
 * an element is written from the residue or not at all: a descendant has no
 * residue of its own, and a test of the element alone says yes to it while the
 * next save drops whatever was written there.
 *
 * So this walks the owners. It is the question every writer of a facet or a
 * keyword has to ask first, and the one the element-only guards used to answer
 * one level short: a requirement nested in `blok def Vehicle { … }` took a
 * status, showed it, and lost it on save with nothing said.
 */
export function reachesTheFile(model: Model, id: ElementId): boolean {
  const el = model.get(id);
  if (!el) return false;
  if (!hasOwnTextualDeclaration(el)) return false;
  return model.ancestors(id).every(hasOwnTextualDeclaration);
}

/** The element-only half of {@link reachesTheFile}: this record's own text is what gets saved. */
function hasOwnTextualDeclaration(el: ElementRecord): boolean {
  if (el.attrs.implicit === true) return false;
  const unparsed = el.attrs.unparsedText;
  return !(typeof unparsed === 'string' && unparsed.trim() !== '');
}

/**
 * True when `id`'s textual form has somewhere to put the keyword — and that
 * form is what the file will hold.
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
export function canCarryStatementKind(model: Model, id: ElementId): boolean {
  const el = model.get(id);
  if (!el) return false;
  // No textual declaration of its own, or none that reaches the file: an
  // implicit connector endpoint serializes to the empty string, a faulted
  // declaration re-emits its original source verbatim — and so does everything
  // under either. A keyword written there is written nowhere.
  if (!reachesTheFile(model, id)) return false;

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
  // `disjoint A from B;` — the ONE statement form in the serializer's dispatch
  // chain that `isRelationship` does not cover (`Disjoining` is catalogued as a
  // node). It goes to `disjoiningLine`, which has no prefix-metadata slot, so
  // without this line a keyword on it is accepted and gone on the next save.
  // `ALL_STATEMENT_FORMS` in the test carries the form so the corpus invariant
  // sees it.
  if (el.eClass === 'Disjoining') return false;

  // Endpoint-bearing USAGES: `connect a to b`, `flow a to b`, `bind a = b`,
  // `transition first s1 then s2`. The same two metaclasses WITHOUT endpoints
  // are plain features (`connection c : C;`, `flow f : T;`) and keep their
  // header. Their KerML-layer cousins `Connector` and `Flow`, and
  // `TransitionFeature`, take the same dedicated lines in the serializer, but
  // they are relationships in the catalogue and `isRelationship` above has
  // already refused them, with or without endpoints — so they are not tested
  // again here.
  if ((el.eClass === 'ConnectionUsage' || el.eClass === 'FlowUsage') && hasEndpoints(el))
    return false;
  if (el.eClass === 'BindingConnectorAsUsage') return false;
  if (el.eClass === 'TransitionUsage') return false;

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
  if (!reachesTheFile(model, id)) {
    throw new Error(
      `setStatementKind: a ${el.eClass} whose declaration, or an enclosing one, could not be parsed cannot carry a statement-kind keyword — the saved file re-emits that source verbatim, and the keyword would be lost`,
    );
  }
  if (!canCarryStatementKind(model, id)) {
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

/**
 * Take the statement kind off `id`, leaving every other keyword where it was.
 *
 * The counterpart of {@link setStatementKind}, and the only way back to "this
 * element makes no statement of its own": an element with no kind keyword falls
 * back to what its metaclass says, which for a part or a package is nothing at
 * all. The `metadata` attribute is REMOVED rather than left as an empty array,
 * because the serializer's prefix loop and the round-trip both read presence,
 * and an empty list is a difference the saved file cannot express.
 *
 * @returns the element, or undefined when it does not exist. Clearing a kind
 *   that was never written is a no-op, not an error — a caller clearing a
 *   default has done nothing wrong.
 */
export function clearStatementKind(model: Model, id: ElementId): ElementRecord | undefined {
  const el = model.get(id);
  if (!el) return undefined;
  const meta = el.attrs.metadata;
  if (!Array.isArray(meta)) return el;
  const kept = meta.map((m) => String(m)).filter((m) => !statementKindOfKeyword(m));
  if (kept.length === meta.length) return el;
  return model.setAttrs(id, { metadata: kept.length > 0 ? kept : undefined });
}

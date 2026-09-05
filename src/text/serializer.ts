/**
 * Serializer: {@link Model} → SysML v2 textual notation.
 *
 * Output is designed to be **re-parseable** by {@link parseModel}: keywords come
 * from {@link TEXTUAL_KEYWORD}, specialization operators from
 * {@link SPECIALIZATION_OPERATOR}, and cross-references are emitted as the
 * shortest scope-relative path that {@link parseModel} resolves back to the same
 * element (falling back to a fully-qualified `::` name when the target is not a
 * descendant of the reference's owning scope).
 *
 * Containment is rendered as nested `{ … }` bodies; a feature's specialization
 * relationships (typing/subsetting/redefinition) are rendered inline on its
 * declaration line, while endpoint-bearing usages (connections, transitions,
 * satisfy/allocate, successions) are rendered as their own statements.
 */

import {
  Model,
  TEXTUAL_KEYWORD,
  isControlNode,
  isMembership,
  isRequirement,
  isSpecialization,
  type ElementId,
  type ElementRecord,
} from '@core/index';
import { resolveFullName, resolveRedefinedFeature } from '@semantics/bind';
import { UnwritableNoteBodyError, isWritableNoteBody } from '@semantics/notes';

const INDENT = '    ';

/**
 * Canonical declaration-prefix modifier order (KerML feature declaration).
 * Emitting flags in this fixed order makes serialization deterministic
 * regardless of how `attrs` was built — fixes review finding L1, whose output
 * order depended on `Object.keys` insertion order. Any additional `is*` flag not
 * listed here is still emitted (sorted, after these) so no modifier is dropped.
 */
const MODIFIER_ORDER: readonly string[] = [
  'isAbstract', 'isVariation', 'isReadonly', 'isDerived', 'isComposite',
  'isPortion', 'isIndividual', 'isVariant', 'isStandard', 'isRef', 'isConst',
  'isConstant', 'isVar', 'isMember', 'isSnapshot', 'isTimeslice', 'isEvent',
  'isEnd', 'isNonunique', 'isOrdered',
];
const MODIFIER_ORDER_SET = new Set<string>(MODIFIER_ORDER);

/** Serialize an entire model to text (roots in declaration order). */
export function serializeModel(model: Model): string {
  return model
    .roots()
    .map((r) => serializeElement(model, r.id, 0))
    .join('\n\n');
}

/** Serialize a single element (and its body) at the given indentation depth. */
export function serializeElement(model: Model, id: ElementId, indent = 0): string {
  const el = model.require(id);
  const pad = INDENT.repeat(indent);

  // Implicit features (usage-scoped connector endpoints materialized by the
  // feature-chain resolver) have no textual declaration — they are re-derived on
  // parse and only referenced by the connector's path. `bodyMembers` already
  // filters them out of container bodies; this guards a DIRECT call on one so it
  // never leaks a spurious declaration.
  if (el.attrs.implicit === true) return '';

  // A FAULTED SAVE STAYS HONEST. When a declaration could not be parsed, the
  // mapper keeps its original source on the element (`unparsedText`): either
  // the residue of a syntax fault or a grammar-legal keyword this tool models
  // no metaclass for. Emitting that text verbatim — and NOTHING else, its
  // subtree included, so a body is not written twice — means the saved file
  // reproduces its own fault on re-parse. The alternative was silent laundering:
  // `blok def Vehicle;` came back as a clean `Vehicle;` and the corruption
  // became undetectable.
  const unparsed = el.attrs.unparsedText;
  if (typeof unparsed === 'string' && unparsed.trim() !== '') {
    return unparsed
      .split('\n')
      .map((line, i) => (i === 0 ? `${pad}${line}` : line))
      .join('\n');
  }

  // Annotations.
  if (el.eClass === 'Documentation') {
    const name = el.declaredName !== undefined ? ` ${quoteName(el.declaredName)}` : '';
    return `${pad}doc${name} /* ${noteBody(el, 'body')} */`;
  }
  if (el.eClass === 'Comment') {
    // Grammar order: `comment (name)? ('about' A, B)? ('locale' STRING)? /* … */`.
    // The name goes through the same quoting rule as every other declared name
    // because the grammar's `Name` is only `ID | UNRESTRICTED_NAME | SoftKeyword`:
    // a name that is a HARD keyword (`part`, `comment`) or is not a plain
    // identifier (`my note`) does not parse back as a name at all — it becomes a
    // mismatched token and the rest of the line is swept into recovery. (Soft
    // keywords like `about` and `locale` are in `Name`, so Chevrotain resolves
    // those toward the name on its own; they are quoted only because
    // `RESERVED_WORDS` does not distinguish the two, which costs nothing.)
    //
    // The guards below test for PRESENCE, not truth: an empty locale is a
    // language tag the author wrote, and an empty name is a name the validator
    // reports as blank. Dropping either on save would launder the file exactly
    // the way the missing name/about/locale did.
    const parts = ['comment'];
    if (el.declaredName !== undefined) parts.push(quoteName(el.declaredName));
    const about = el.attrs.about;
    if (Array.isArray(about) && about.length) parts.push('about', about.map(String).join(', '));
    const locale = el.attrs.locale;
    if (typeof locale === 'string') parts.push('locale', quoteString(locale));
    parts.push(`/* ${noteBody(el, 'body')} */`);
    return `${pad}${parts.join(' ')}`;
  }
  if (el.eClass === 'TextualRepresentation') {
    const lang = el.attrs.language;
    if (typeof lang === 'string' && lang.length) {
      const repName =
        el.declaredName !== undefined ? `rep ${quoteName(el.declaredName)} ` : '';
      return `${pad}${repName}language ${quoteString(lang)} /* ${noteBody(el, 'body')} */`;
    }
    return `${pad}/* ${noteBody(el, 'body')} */`;
  }

  // Imports.
  if (el.eClass === 'NamespaceImport' || el.eClass === 'MembershipImport') {
    const iv = el.attrs.visibility;
    const ivis = iv === 'public' || iv === 'private' || iv === 'protected' ? `${iv} ` : '';
    const filters = Array.isArray(el.attrs.filters)
      ? el.attrs.filters.map((f) => `[${String(f)}]`).join('')
      : '';
    return `${pad}${ivis}import ${attrStr(el, 'importedName')}${filters};`;
  }

  // Endpoint-bearing statements. Connection/flow USAGES that carry no endpoints
  // (e.g. `flow f : T;`, `connection c : C;`) are plain features — they fall
  // through to the generic path (keyword `flow`/`connection`); routing them to
  // the connect/from…to statement forms would emit `connect  to ;` / `from  to`.
  if ((el.eClass === 'ConnectionUsage' || el.eClass === 'Connector') && hasEndpoints(el))
    return connectionLine(model, el, pad);
  if (el.eClass === 'Satisfy') return satisfyLine(model, el, pad);
  if (el.eClass === 'Verify') return verifyLine(model, el, pad);
  if (el.eClass === 'Refine') return refineLine(model, el, pad);
  if (el.eClass === 'Trace') return traceLine(model, el, pad);
  if (el.eClass === 'Derive') return deriveLine(model, el, pad);
  if (el.eClass === 'Allocation') return allocateLine(model, el, pad);
  if (el.eClass === 'Succession' || el.eClass === 'SuccessionFlow') return successionLine(model, el, pad);
  if (el.eClass === 'TransitionUsage' || el.eClass === 'TransitionFeature')
    return transitionLine(model, el, pad);
  if (el.eClass === 'Dependency') return dependencyLine(model, el, pad);
  if ((el.eClass === 'Flow' || el.eClass === 'FlowUsage') && hasEndpoints(el))
    return flowLine(model, el, pad);
  if (el.eClass === 'BindingConnectorAsUsage') return bindLine(model, el, indent);
  if (el.eClass === 'Disjoining') return disjoiningLine(model, el, pad);
  if (el.eClass === 'Membership') return aliasLine(model, el, indent);
  // Specialization-family relationship that cannot be inlined on its source's
  // declaration line (unresolved endpoint, or source ≠ owner): emit the KerML
  // relationship-statement form (`redefinition b :>> a;`) that re-parses to the
  // same element. Previously these fell through to the generic path — a
  // root-level dangling `subset a subsets b;` serialized as the bare eClass
  // `Subsetting;`, which re-parsed as a ReferenceUsage NAMED "Subsetting".
  if (isSpecialization(el.eClass)) return relationshipStmtLine(model, el, pad);
  if (isControlNode(el.eClass)) return controlNodeLine(el, pad);

  // Dedicated H17 statement forms (attribute- or eClass-dispatched). Each emits
  // the surface syntax the Langium grammar parses back into the same element;
  // these kinds otherwise fall through to the generic path, which would emit
  // their raw eClass (e.g. `AcceptActionUsage`) as a keyword — unparseable.
  if (el.attrs.actionKind !== undefined) return behaviorLine(model, el, indent);
  if (el.eClass === 'WhileLoopActionUsage' || el.eClass === 'ForLoopActionUsage')
    return loopLine(model, el, indent);
  if (el.eClass === 'IfActionUsage') return ifLine(model, el, indent);
  if (el.attrs.featureRole === 'return') return returnLine(model, el, indent);
  if (el.attrs.requirementRole !== undefined) return requirementClauseLine(model, el, indent);
  if (el.attrs.stateSubaction !== undefined) return stateBehaviorLine(model, el, indent);
  if (el.eClass === 'MetadataUsage' && el.attrs.annotation === true)
    return annotationLine(model, el, indent);

  // Generic node: header + optional body.
  return nodeWithBody(model, el, indent);
}

/* ────────────────────────────── headers ───────────────────────────────── */

function keywordOf(el: ElementRecord): string {
  return TEXTUAL_KEYWORD[el.eClass] ?? el.eClass;
}

/**
 * Quote a declared name that is not a bare identifier so it survives round-trip
 * (the inverse of the mapper's `unquoteName`). A name with spaces/specials or a
 * reserved literal like `true` would otherwise reparse as multiple elements or a
 * keyword. Plain identifiers pass through unchanged.
 */
const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Every reserved word in sysml.langium: Langium lexes each as a token that
// outranks ID, so an identifier-shaped name equal to any of these must be
// quoted or it reparses as a keyword. Quoting is always safe (all name
// positions accept the unrestricted `'…'` form).
const RESERVED_WORDS = new Set<string>([
  'about', 'abstract', 'accept', 'action', 'actor', 'alias', 'all', 'allocate',
  'allocation', 'analysis', 'and', 'as', 'assert', 'assign', 'assoc', 'association',
  'assume', 'attribute', 'behavior', 'bind', 'binding', 'bool', 'by', 'calc', 'case',
  'chains', 'class', 'classifier', 'comment', 'composite', 'concern', 'conjugates',
  'connect', 'connection', 'connector', 'const', 'constant', 'constraint', 'crosses',
  'datatype', 'decide', 'def', 'default', 'defined', 'dependency', 'derive', 'derived',
  'differences', 'disjoint', 'do', 'doc', 'else', 'end', 'entry', 'enum', 'event',
  'exhibit', 'exit', 'expr', 'false', 'feature', 'featured', 'filter', 'first', 'flow',
  'for', 'fork', 'frame', 'from', 'function', 'hastype', 'if', 'implies', 'import',
  'in', 'include', 'individual', 'initial', 'inout', 'interaction', 'interface', 'intersects',
  'inv', 'inverse', 'istype', 'item', 'join', 'language', 'library', 'locale', 'loop',
  'member', 'merge', 'message', 'meta', 'metaclass', 'metadata', 'multiplicity',
  'namespace', 'new', 'nonunique', 'not', 'null', 'objective', 'occurrence', 'of', 'or',
  'ordered', 'out', 'package', 'part', 'perform', 'port', 'portion', 'predicate',
  'private', 'protected', 'public', 'readonly', 'redefines', 'redefinition', 'ref',
  'references', 'refine', 'render', 'rendering', 'rep', 'require', 'requirement', 'return',
  'satisfy', 'send', 'snapshot', 'specializes', 'stakeholder', 'standard', 'state',
  'step', 'struct', 'subclassifier', 'subject', 'subset', 'subsets', 'subtype',
  'succession', 'terminate', 'then', 'timeslice', 'to', 'trace', 'transition', 'true', 'type',
  'typed', 'typing', 'unions', 'until', 'use', 'var', 'variant', 'variation',
  'verification', 'verify', 'via', 'view', 'viewpoint', 'while', 'xor',
]);
function quoteName(name: string): string {
  if (PLAIN_IDENT.test(name) && !RESERVED_WORDS.has(name)) return name;
  return `'${name.replace(/([\\'])/g, '\\$1')}'`;
}

/**
 * Write a value as a grammar STRING (`"…"`).
 *
 * Every caller here has a value that came back OUT of a STRING terminal, so it
 * may already contain the characters that terminal is delimited by. The
 * terminal is `/"(\\.|[^"\\])*"/`, so a bare `"` or `\` inside the value ends
 * the string early or eats the next character; `language "a\"b"` used to save
 * as `language "a"b"` and the re-parse died on `lexer/unterminated-string`,
 * losing the rest of the file to recovery. `JSON.stringify` escapes exactly
 * what that terminal escapes — `"`, `\` and the control characters, which the
 * grammar reads back through the same `\\.` branch — so the value survives the
 * round trip byte for byte.
 */
function quoteString(value: string): string {
  return JSON.stringify(value);
}

function nameOf(el: ElementRecord): string {
  const n = el.declaredName ?? el.declaredShortName;
  return n !== undefined ? quoteName(n) : '';
}

/** Build the declaration header (keyword, modifiers, name, specializations…). */
function header(model: Model, el: ElementRecord): string {
  const parts: string[] = [];

  // Declaration prefixes in grammar order (Definition rule): succession marker,
  // prefix metadata, visibility, then direction / modifier flags, then keyword.

  // Succession-chain marker (`first` / `then`).
  parts.push(...successionPrefix(el));

  // Prefix metadata annotations (`#Safety`).
  const meta = el.attrs.metadata;
  if (Array.isArray(meta)) for (const m of meta) parts.push(`#${String(m)}`);

  // Visibility keyword (`public` / `private` / `protected`).
  const vis = el.attrs.visibility;
  if (vis === 'public' || vis === 'private' || vis === 'protected') parts.push(String(vis));

  // Direction prefix (ports / directed features).
  const dir = el.attrs.direction;
  if (dir === 'in' || dir === 'out' || dir === 'inout') parts.push(String(dir));

  // Modifier flags (isAbstract → abstract, …) in a fixed canonical order so the
  // output is deterministic (fixes L1). Any additional is*-flag is emitted
  // afterwards, sorted, so none is ever dropped.
  for (const k of MODIFIER_ORDER) {
    // A ReferenceUsage's keyword is already `ref`; don't also emit the isRef flag
    // (would produce `ref ref x`, which reparses to the same element but ugly).
    if (k === 'isRef' && el.eClass === 'ReferenceUsage') continue;
    if (el.attrs[k] === true) parts.push(k.slice(2).toLowerCase());
  }
  for (const k of Object.keys(el.attrs).sort()) {
    if (k.startsWith('is') && k.length > 2 && el.attrs[k] === true && !MODIFIER_ORDER_SET.has(k)) {
      parts.push(k.slice(2).toLowerCase());
    }
  }

  // Keyword-less ReferenceUsage provenance (F5 residual): an enum literal
  // (`low = 0.25;`) was declared without the `ref` keyword; re-emit it
  // keyword-less so the reparse does not add a spurious isRef flag.
  if (!(el.eClass === 'ReferenceUsage' && el.attrs.keywordless === true)) {
    parts.push(keywordOf(el));
  }

  // Short name <…> — requirements carry their id here.
  //
  // The element's OWN short name wins. Every reader prefers it
  // (`semantics/requirements.ts` requirementShortId), so a writer that
  // preferred the legacy `attrs.reqId` made the two disagree: an edited
  // `declaredShortName` displayed as the new id, saved as the old one and
  // reverted on the next open. Nothing produced today sets the two to different
  // values — the mapper writes both from the same token, the factory writes
  // only `reqId` — so the legacy key stays as the fallback that keeps those
  // models emitting their id.
  //
  // The element's own short name is tested for PRESENCE: `<''>` is a blank id
  // the validator reports, and dropping it on save would erase the evidence for
  // that error (finding grammar-text-3). The legacy FALLBACK keeps its
  // truthiness test — `attrs.reqId` is written by the Properties panel, which
  // clears the field to `''`, and an emptied box means "no id here", not "an id
  // that is blank".
  const legacyId = isRequirement(el.eClass) ? el.attrs.reqId : undefined;
  const short =
    el.declaredShortName ??
    (typeof legacyId === 'string' && legacyId !== '' ? legacyId : undefined);
  if (short !== undefined) parts.push(`<${quoteName(short)}>`);

  // Presence, not truth, for the declared name as well — and at every sibling
  // site below. `part def ''` is a name the validator reports as blank; a save
  // that dropped the quotes turned that error into an OK file and left behind a
  // `split-declaration` warning that told the reader something false.
  // `quoteName('')` already emits `''`.
  if (el.declaredName !== undefined) parts.push(quoteName(el.declaredName));

  // Inline specializations.
  parts.push(...specializationFragments(model, el));

  // Multiplicity.
  const mult = multiplicityLexeme(el);
  if (mult !== undefined) parts.push(`[${mult}]`);

  // Feature modifiers (`ordered` / `nonunique`) — emitted AFTER the name, in the
  // declaration-tail spec section (grammar FeatureModifier in DeclSpecs). As a
  // leading prefix these would instead parse as is*-flags, so position matters.
  const mods = el.attrs.modifiers;
  if (Array.isArray(mods)) for (const m of mods) parts.push(String(m));

  // DeclMiddle clauses on a generic definition (grammar order: via, of, to,
  // value, ctrl). `sendTarget`/`ofPayload`/`via` here are the definition-path
  // variants (behaviour statements carry their own via/target via behaviorLine).
  if (typeof el.attrs.via === 'string') parts.push('via', el.attrs.via);
  if (typeof el.attrs.ofPayload === 'string') parts.push('of', el.attrs.ofPayload);
  if (typeof el.attrs.sendTarget === 'string') parts.push('to', el.attrs.sendTarget);

  // Feature value. `:=` marks an initial (default) value; `=` a bound one.
  // A trailing `attrs.unit` (e.g. `[kg]`) is emitted after the value.
  if (el.attrs.value !== undefined) {
    const clause: string[] = [
      el.attrs.initialValue === true ? ':=' : '=',
      valueLexeme(el),
    ];
    if (typeof el.attrs.unit === 'string' && el.attrs.unit !== '') clause.push(`[${unitLexeme(el.attrs.unit)}]`);
    parts.push(...clause);
  }

  // Inline control clause (grammar DeclMiddle ctrl): `… while c` / `… for x in c`.
  if (typeof el.attrs.loopKind === 'string') parts.push(...loopClause(el));

  return parts.join(' ');
}

/** The last segment of a qualified reference (`ScalarValues::Real` → `Real`). */
function lastSegment(ref: string): string {
  const i = ref.lastIndexOf('::');
  return i === -1 ? ref : ref.slice(i + 2);
}

/**
 * Is this reference unprintable — an anonymous element (`«PartDefinition»`) or a
 * target that is no longer in the model (empty name)?
 *
 * Emitting either produces text that does not mean what the model means: `«…»`
 * is not valid notation and re-parses as a wrongly-named element, and an empty
 * reference serializes as `: ''`. Both are worse than omitting the fragment.
 */
function unprintableRef(ref: string): boolean {
  return ref === '' || ref.includes('«') || ref.includes("''");
}

/** Inline `: Type`, `:> Super`, `:>> redef`, `::> ref` fragments. */
function specializationFragments(model: Model, el: ElementRecord): string[] {
  const out: string[] = [];

  // Attribute typing stored as a plain string. A conjugated type keeps its `~`.
  const conj = el.attrs.conjugated === true ? '~' : '';
  const displayType =
    typeof el.attrs.type === 'string'
      ? el.attrs.type
      : typeof el.attrs.typeRef === 'string'
        ? el.attrs.typeRef
        : undefined;
  if (displayType !== undefined) out.push(`: ${conj}${displayType}`);

  // Unresolved specialization references kept on attrs (conjugated → `~`).
  pushRefList(out, ':>', el.attrs.specializes, conj);
  pushRefList(out, ':>>', el.attrs.redefines, conj);
  pushRefList(out, '::>', el.attrs.references, conj);

  // Resolved specialization relationships whose SOURCE is this feature. The
  // source check guards against inlining a child specialization sourced
  // elsewhere (e.g. an F4-upgraded statement whose source is still dangling) —
  // that would falsely read as `<owner> :> target`.
  for (const rel of model.children(el.id)) {
    if (!isSpecialization(rel.eClass)) continue;
    if ((rel.source ?? [])[0] !== el.id) continue;
    const targetId = (rel.target ?? [])[0];
    if (!targetId) continue;
    // The re-parse of an inlined `:>>` uses the redefinition rule and excludes
    // the redefining feature; every other operator uses full resolution with
    // the same exclusion the mapper applies.
    const ref = refTo(model, targetId, el.ownerId, specResolver(model, rel.eClass, el.id));
    const op = operatorFor(rel.eClass);
    // Do not restate a typing the display string already expresses. After the
    // library binder runs, an attribute carries BOTH `attrs.type = 'Real'` and a
    // FeatureTyping to `ScalarValues::Real`; emitting both produced
    // `attribute mass : Real : ScalarValues::Real`, which is not what anyone
    // wrote. The authored display string wins: it is what the user typed, and
    // the binder deterministically rebuilds the relationship from it.
    if (op === ':' && displayType !== undefined && lastSegment(ref) === lastSegment(displayType)) {
      continue;
    }
    // Never emit an anonymous or dangling target — see `unprintableRef`.
    if (unprintableRef(ref)) continue;
    out.push(`${op} ${conj}${ref}`);
  }
  return out;
}

function pushRefList(out: string[], op: string, v: unknown, conj = ''): void {
  if (Array.isArray(v)) for (const r of v) out.push(`${op} ${conj}${String(r)}`);
}

function operatorFor(eClass: string): string {
  switch (eClass) {
    case 'FeatureTyping':
      return ':';
    case 'Redefinition':
      return ':>>';
    case 'ReferenceSubsetting':
      return '::>';
    case 'Subclassification':
    case 'Subsetting':
    case 'Specialization':
    default:
      return ':>';
  }
}

/* ────────────────────────────── bodies ────────────────────────────────── */

function nodeWithBody(model: Model, el: ElementRecord, indent: number): string {
  return renderWithBody(model, el, indent, header(model, el));
}

/**
 * Render `<head>;` or `<head> { …body… }` for an element whose declaration head
 * is already built. Body = optional requirement doc + constraint/calculation
 * expression + nested members. Shared by the generic path and the dedicated
 * H17 statement forms below.
 */
function renderWithBody(
  model: Model,
  el: ElementRecord,
  indent: number,
  head: string,
): string {
  const pad = INDENT.repeat(indent);
  const lines: string[] = [];

  // Requirement description → doc comment.
  if (isRequirement(el.eClass) && typeof el.attrs.text === 'string' && el.attrs.text.length) {
    lines.push(`${INDENT.repeat(indent + 1)}doc /* ${noteBody(el, 'text')} */`);
  }

  for (const child of bodyMembers(model, el)) {
    // Skip members that serialize to nothing (implicit features, or a
    // specialization relationship with no statement form / anonymous endpoint) —
    // otherwise the empty string would spuriously force an empty `{ }` body.
    const s = serializeElement(model, child.id, indent + 1);
    if (s !== '') lines.push(s);
  }

  // Constraint/calculation expression body — emitted LAST because the grammar
  // Body is `'{' members* expr? '}'` (a trailing expression must follow the
  // members, else the reparse fails). Emitted even when members are present.
  const expr = el.attrs.expression;
  if (typeof expr === 'string' && expr.length) {
    lines.push(`${INDENT.repeat(indent + 1)}${expr}`);
  }

  if (lines.length === 0) return `${pad}${head};`;
  return `${pad}${head} {\n${lines.join('\n')}\n${pad}}`;
}

/* ─────────────────── dedicated H17 statement forms ─────────────────────── */

/** Leading `first` / `then` succession marker. */
function successionPrefix(el: ElementRecord): string[] {
  const s = el.attrs.succession;
  return s === 'first' || s === 'then' ? [String(s)] : [];
}

/** `[m..n]` multiplicity fragment, if present. */
function multFragment(el: ElementRecord): string[] {
  const m = multiplicityLexeme(el);
  return m === undefined ? [] : [`[${m}]`];
}

/**
 * Content that stops being multiplicity content once it is written: `]` (or an
 * unmatched `[`) ends the bracket, a line break ends the line, and `/*` or the
 * note terminator opens or closes a note across it. Everything after such a
 * character is read back as model structure — the note-body defect in a second
 * field, and this one is reachable from the Properties multiplicity box, which
 * writes whatever is typed straight into `attrs.multiplicity`.
 */
const UNWRITABLE_MULTIPLICITY_RE = /[[\]\n\r]|\/\*|\*\//;

/**
 * Thrown when a multiplicity cannot be written back inside its brackets.
 *
 * Loud, not quiet, for the reason the whole file follows: dropping the value
 * would produce a file that parses cleanly and says something the model does
 * not. The Problems panel always names the element as well — every value this
 * refuses is also reported by `validation/malformed-multiplicity`, since none
 * of these characters can occur in a well-formed bound or in the bare
 * identifier that rule exempts as a trailing unit.
 */
export class UnwritableMultiplicityError extends Error {
  constructor(
    /** Element whose multiplicity could not be written. */
    readonly elementId: string,
    /** The value that could not be written. */
    readonly value: string,
  ) {
    super(
      `Cannot serialize ${elementId}: its multiplicity "${value}" would close the ` +
        'brackets it is written into, and the rest would be read back as model structure.',
    );
    this.name = 'UnwritableMultiplicityError';
  }
}

/**
 * The multiplicity to write, or `undefined` when there is none.
 *
 * The serializer's question is whether the value can be WRITTEN BACK, never
 * whether it is well formed — that is `validation/malformed-multiplicity`'s
 * question, and a serializer that answered it too dropped the bound on save, so
 * the error the checker had just reported was gone from the saved file: one
 * error in, zero out. It also cost bounds that were never in doubt, because a
 * `MultTerm` may be a QUALIFIED NAME and a name may be written unrestricted
 * (`['my bound']`, `['größe']`).
 *
 * The sentinel that started finding grammar-text-2 is not caught here and
 * cannot be: `undefined` IS a legal `MultTerm`, so no shape check can tell it
 * from a name someone meant. That fix belongs in the mapper, which knows the
 * bound was never read.
 */
function multiplicityLexeme(el: ElementRecord): string | undefined {
  const m = el.attrs.multiplicity;
  if (typeof m !== 'string' || m === '') return undefined;
  if (UNWRITABLE_MULTIPLICITY_RE.test(m)) throw new UnwritableMultiplicityError(el.id, m);
  return m;
}

/** `:=` / `=` feature-value clause, if present. */
function valueClause(el: ElementRecord): string[] {
  if (el.attrs.value === undefined) return [];
  const parts: string[] = [el.attrs.initialValue === true ? ':=' : '=', valueLexeme(el)];
  // Value unit stored in `attrs.unit` (`= 1500 [kg]`); never conflated with
  // the multiplicity bracket (finding D1/H11).
  if (typeof el.attrs.unit === 'string' && el.attrs.unit !== '') parts.push(`[${unitLexeme(el.attrs.unit)}]`);
  return parts;
}

/**
 * A bare name, number, or a `#( i )` index — one operand of a unit expression
 * the grammar reads without quotes. Reserved words are excluded because the
 * expression grammar lexes them as keywords (`in`).
 */
const UNIT_OPERAND = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)(?:(?:::|\.)(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+))*(?:#\([0-9]+\))?$/;

/**
 * The notation for a unit stored in `attrs.unit`, i.e. the operand of the
 * bracket expression `value [unit]`. `attrs.unit` holds the unit UNQUOTED
 * (`m/s`, `SI::watt hour`, `m²`), because quotes are the notation's escape
 * rather than part of the unit. A unit the expression grammar reads as it is
 * — a name, a qualified name, or an ASCII unit expression over `*`, `/`, `^`
 * (`m/s`, `W*h`, `m^2`, `Mbit/s`) — is emitted bare; anything else (a reserved
 * word, a space, a non-ASCII symbol) is quoted per `::`-segment as an
 * unrestricted name, which the grammar reads back to the same unit
 * (`['in']`, `['W⋅h']`, `['m²']`, `[SI::'watt hour']`). Emitting the raw
 * string would produce notation the parser rejects — `[SI::watt hour]` — and
 * a saved model that cannot be read back.
 */
function unitLexeme(unit: string): string {
  const operands = unit.split(/[*/^]/);
  const bare = operands.every(
    (op) =>
      UNIT_OPERAND.test(op) &&
      op.split(/::|\.|#/).every((seg) => !RESERVED_WORDS.has(seg)),
  );
  if (bare) return unit;
  return unit.split('::').map((seg) => quoteName(seg)).join('::');
}

/** accept / send / assign / perform / exhibit / include / terminate action. */
function behaviorLine(model: Model, el: ElementRecord, indent: number): string {
  const parts = [...successionPrefix(el), String(el.attrs.actionKind)];
  if (el.declaredShortName !== undefined) parts.push(`<${quoteName(el.declaredShortName)}>`);
  if (el.declaredName !== undefined) parts.push(quoteName(el.declaredName));
  parts.push(...specializationFragments(model, el), ...multFragment(el));
  if (typeof el.attrs.via === 'string') parts.push('via', el.attrs.via);
  if (typeof el.attrs.actionTarget === 'string') parts.push('to', el.attrs.actionTarget);
  parts.push(...valueClause(el));
  return renderWithBody(model, el, indent, parts.join(' '));
}

/** while/until/for/loop clause fragments — shared by loopLine and inline ctrl. */
function loopClause(el: ElementRecord): string[] {
  const kind = String(el.attrs.loopKind);
  const cond = typeof el.attrs.condition === 'string' ? el.attrs.condition : '';
  const coll = typeof el.attrs.collection === 'string' ? el.attrs.collection : '';
  if (kind === 'while' || kind === 'until') return [kind, cond];
  if (kind === 'for') {
    const out = ['for'];
    if (typeof el.attrs.loopVar === 'string') out.push(el.attrs.loopVar);
    if (typeof el.attrs.loopVarType === 'string') out.push(':', el.attrs.loopVarType);
    out.push('in', coll);
    return out;
  }
  return ['loop'];
}

/** `while c`, `until c`, `for x : T in coll`, `loop` (standalone statement). */
function loopLine(model: Model, el: ElementRecord, indent: number): string {
  return renderWithBody(model, el, indent, [...successionPrefix(el), ...loopClause(el)].join(' '));
}

/** `if c { … }` / `if c target;`, optional `else { … }` / `else target`. */
function ifLine(model: Model, el: ElementRecord, indent: number): string {
  const pad = INDENT.repeat(indent);
  const cond = typeof el.attrs.condition === 'string' ? el.attrs.condition : '';
  const head = [...successionPrefix(el), 'if', cond].join(' ');

  const thenTarget = el.attrs.thenTarget;
  const elseTarget = el.attrs.elseTarget;
  const elseIsTarget = typeof elseTarget === 'string';
  const elseIsBody = el.attrs.hasElse === true && !elseIsTarget;

  // The grammar merges then-body and else-body members onto the one element, so
  // the then/else split is not recoverable (documented limitation) — but the
  // element SET is. When the then-branch is a bare target, any members must be
  // the else-body (grammar: target XOR then-body), so they go in the else block.
  const members = bodyMembers(model, el)
    .map((c) => serializeElement(model, c.id, indent + 1))
    .filter((s) => s !== '');
  const memberBlock = members.length ? ` {\n${members.join('\n')}\n${pad}}` : ' { }';

  let thenPart: string;
  let elsePart: string;
  let lastIsTarget: boolean;
  if (typeof thenTarget === 'string') {
    thenPart = ` ${thenTarget}`;
    if (elseIsTarget) {
      elsePart = ` else ${elseTarget}`;
      lastIsTarget = true;
    } else if (members.length || elseIsBody) {
      elsePart = ` else${memberBlock}`;
      lastIsTarget = false;
    } else {
      elsePart = '';
      lastIsTarget = true;
    }
  } else {
    thenPart = memberBlock;
    if (elseIsTarget) {
      elsePart = ` else ${elseTarget}`;
      lastIsTarget = true;
    } else if (elseIsBody) {
      elsePart = ' else { }';
      lastIsTarget = false;
    } else {
      elsePart = '';
      lastIsTarget = false;
    }
  }
  return `${pad}${head}${thenPart}${elsePart}${lastIsTarget ? ';' : ''}`;
}

/** `return name (= value)?`. */
function returnLine(model: Model, el: ElementRecord, indent: number): string {
  const parts = ['return'];
  if (el.declaredName !== undefined) parts.push(quoteName(el.declaredName));
  parts.push(...specializationFragments(model, el), ...multFragment(el), ...valueClause(el));
  return renderWithBody(model, el, indent, parts.join(' '));
}

/** Requirement clause: `subject`, `require`, `assume`, `objective`, … */
function requirementClauseLine(model: Model, el: ElementRecord, indent: number): string {
  const parts = [String(el.attrs.requirementRole)];
  if (el.declaredName !== undefined) parts.push(quoteName(el.declaredName));
  parts.push(...specializationFragments(model, el), ...multFragment(el), ...valueClause(el));
  return renderWithBody(model, el, indent, parts.join(' '));
}

/** State behaviour: `entry` / `do` / `exit` (optionally named). */
function stateBehaviorLine(model: Model, el: ElementRecord, indent: number): string {
  const parts = [String(el.attrs.stateSubaction)];
  if (el.declaredName !== undefined) parts.push(quoteName(el.declaredName));
  parts.push(...specializationFragments(model, el), ...multFragment(el), ...valueClause(el));
  return renderWithBody(model, el, indent, parts.join(' '));
}

/** `@Type` metadata annotation, with optional `about A, B` and body. */
function annotationLine(model: Model, el: ElementRecord, indent: number): string {
  const parts = [`@${attrStr(el, 'type')}`];
  const about = el.attrs.about;
  if (Array.isArray(about) && about.length) parts.push('about', about.map(String).join(', '));
  return renderWithBody(model, el, indent, parts.join(' '));
}

/**
 * Whether a specialization relationship is rendered INLINE on `parent`'s
 * declaration line by {@link specializationFragments} (which requires the
 * relationship's source to be the parent and its target to be resolved). Kept
 * in exact sync with that function's guards so a relationship is emitted
 * exactly once: inline when possible, else as a relationship statement.
 */
function isInlinedSpecialization(parent: ElementRecord, rel: ElementRecord): boolean {
  return (rel.source ?? [])[0] === parent.id && (rel.target ?? [])[0] !== undefined;
}

/** Children to render as body members (excludes inlined relationships). */
function bodyMembers(model: Model, el: ElementRecord): ElementRecord[] {
  return model.children(el.id).filter((c) => {
    if (isSpecialization(c.eClass)) return !isInlinedSpecialization(el, c);
    // Implicit (chain-materialized) features are not source text: they are
    // re-derived from `connect a.p to b.p` endpoints on every parse, so
    // emitting them as standalone declarations would duplicate them.
    if (c.attrs.implicit === true) return false;
    // `Membership` (an alias) is rendered as its own `alias … for …;` statement;
    // the implicit containment memberships (Owning/Feature/Variant) are not text.
    if (isMembership(c.eClass) && c.eClass !== 'Membership') return false;
    if (c.eClass === 'FeatureValue') return false;
    return true;
  });
}

/* ───────────────────────── endpoint statements ────────────────────────── */

function endpoint(model: Model, el: ElementRecord, which: 'source' | 'target'): string {
  const id = (el[which] ?? [])[0];
  if (id) return refTo(model, id, el.ownerId);
  const refAttr = which === 'source' ? el.attrs.sourceRef : el.attrs.targetRef;
  return typeof refAttr === 'string' ? refAttr : '';
}

/** Whether a connection/flow carries any endpoint (resolved id or unresolved ref). */
function hasEndpoints(el: ElementRecord): boolean {
  return (
    (el.source?.length ?? 0) > 0 ||
    (el.target?.length ?? 0) > 0 ||
    typeof el.attrs.sourceRef === 'string' ||
    typeof el.attrs.targetRef === 'string'
  );
}

function connectionLine(model: Model, el: ElementRecord, pad: string): string {
  const src = endpoint(model, el, 'source');
  const tgt = endpoint(model, el, 'target');
  const prefix =
    el.declaredName !== undefined ? `connection ${quoteName(el.declaredName)} ` : '';
  return `${pad}${prefix}connect ${src} to ${tgt};`;
}

/** All endpoint texts on one side (resolved paths, or a single textual-ref fallback). */
function endpointList(model: Model, el: ElementRecord, which: 'source' | 'target'): string[] {
  const ids = el[which] ?? [];
  if (ids.length > 0) return ids.map((id) => refTo(model, id, el.ownerId));
  const refAttr = which === 'source' ? el.attrs.sourceRef : el.attrs.targetRef;
  return typeof refAttr === 'string' && refAttr ? [refAttr] : [];
}

/**
 * Requirement cross-relationship statement(s) — `<vis>? <keyword> <req> <prep>
 * <elem>;` — mirroring the `satisfy R by X` form: the requirement is the TARGET
 * endpoint and the related element the SOURCE endpoint (factory.satisfy
 * convention). Emits ONE statement per (target, source) pair so a multi-endpoint
 * relationship round-trips fully instead of losing all but the first; preserves
 * `visibility`; an unresolved endpoint falls back to its textual ref, and a pair
 * whose endpoint is empty or resolves to an ANONYMOUS element (`«…»`) is skipped
 * rather than emitted as unparseable text.
 */
function requirementRelLine(
  model: Model,
  el: ElementRecord,
  pad: string,
  keyword: string,
  prep: string,
): string {
  const vis = el.attrs.visibility;
  const visPrefix = vis === 'public' || vis === 'private' || vis === 'protected' ? `${vis} ` : '';
  const reqs = endpointList(model, el, 'target');
  const elems = endpointList(model, el, 'source');
  const lines: string[] = [];
  for (const req of reqs) {
    for (const elem of elems) {
      if (!req || !elem || req.includes('«') || elem.includes('«')) continue;
      lines.push(`${pad}${visPrefix}${keyword} ${req} ${prep} ${elem};`);
    }
  }
  return lines.join('\n');
}

function satisfyLine(model: Model, el: ElementRecord, pad: string): string {
  return requirementRelLine(model, el, pad, 'satisfy', 'by');
}

function verifyLine(model: Model, el: ElementRecord, pad: string): string {
  return requirementRelLine(model, el, pad, 'verify', 'by');
}

function refineLine(model: Model, el: ElementRecord, pad: string): string {
  return requirementRelLine(model, el, pad, 'refine', 'by');
}

function traceLine(model: Model, el: ElementRecord, pad: string): string {
  return requirementRelLine(model, el, pad, 'trace', 'to');
}

function deriveLine(model: Model, el: ElementRecord, pad: string): string {
  return requirementRelLine(model, el, pad, 'derive', 'from');
}

function allocateLine(model: Model, el: ElementRecord, pad: string): string {
  return `${pad}allocate ${endpoint(model, el, 'source')} to ${endpoint(model, el, 'target')};`;
}

function successionLine(model: Model, el: ElementRecord, pad: string): string {
  return `${pad}succession first ${endpoint(model, el, 'source')} then ${endpoint(model, el, 'target')};`;
}

function dependencyLine(model: Model, el: ElementRecord, pad: string): string {
  // Multiple clients/suppliers are stored as attr lists (the mapper keeps them
  // only when >1); a single one lives on the source/target endpoint.
  const clients = Array.isArray(el.attrs.clients)
    ? el.attrs.clients.map(String).join(', ')
    : endpoint(model, el, 'source');
  const suppliers = Array.isArray(el.attrs.suppliers)
    ? el.attrs.suppliers.map(String).join(', ')
    : endpoint(model, el, 'target');
  const id: string[] = [];
  if (el.declaredShortName !== undefined) id.push(`<${quoteName(el.declaredShortName)}>`);
  if (el.declaredName !== undefined) id.push(quoteName(el.declaredName));
  const named = id.length ? `${id.join(' ')} from ` : '';
  return `${pad}dependency ${named}${clients} to ${suppliers};`;
}

function flowLine(model: Model, el: ElementRecord, pad: string): string {
  // A flow is a `from … to …` usage; the optional `of <payload>` precedes it.
  // (Without `from`/`to` the parser would not rebuild a Flow relationship.)
  const named = el.declaredName !== undefined ? ` ${quoteName(el.declaredName)}` : '';
  const payload = typeof el.attrs.payload === 'string' ? ` of ${el.attrs.payload}` : '';
  return `${pad}flow${named}${payload} from ${endpoint(model, el, 'source')} to ${endpoint(model, el, 'target')};`;
}

function bindLine(model: Model, el: ElementRecord, indent: number): string {
  const src = endpoint(model, el, 'source');
  const tgt = endpoint(model, el, 'target');
  const payload = typeof el.attrs.ofPayload === 'string' ? el.attrs.ofPayload : '';
  // The plain `bind` form requires a source and cannot carry a payload.
  if (src && !payload) {
    const head = tgt ? `bind ${src} = ${tgt}` : `bind ${src}`;
    return renderWithBody(model, el, indent, head);
  }
  // The `binding` form makes every operand optional and supports `of <payload>`.
  const seg = [`binding`];
  if (src) seg.push(src);
  if (payload) seg.push(`of ${payload}`);
  if (tgt) seg.push(`= ${tgt}`);
  return renderWithBody(model, el, indent, seg.join(' '));
}

function disjoiningLine(model: Model, el: ElementRecord, pad: string): string {
  return `${pad}disjoint ${endpoint(model, el, 'source')} from ${endpoint(model, el, 'target')};`;
}

/**
 * KerML relationship-statement keyword + operator for each specialization-family
 * metaclass the parser can build from a `RelationshipStmt` (`subset A subsets
 * B;`, `redefinition r redefines x;`, …). Re-parsing `<kind> <src> <op> <tgt>;`
 * reproduces the same metaclass: the mapper classifies by the OPERATOR (plus
 * whether a resolved source is a definition — Subsetting vs Subclassification).
 */
const RELATIONSHIP_STMT_FORM: Record<string, { kind: string; op: string }> = {
  Subsetting: { kind: 'subset', op: ':>' },
  Subclassification: { kind: 'subtype', op: ':>' },
  Specialization: { kind: 'subtype', op: ':>' },
  Redefinition: { kind: 'redefinition', op: ':>>' },
  FeatureTyping: { kind: 'typing', op: ':' },
  ReferenceSubsetting: { kind: 'subset', op: '::>' },
};

/**
 * A specialization-family relationship that is NOT inlined on its source's
 * declaration line (unresolved source or target, or source ≠ owner): emit the
 * relationship-statement form. Endpoints fall back to their textual
 * `sourceRef`/`targetRef` when unresolved; a relationship with a missing or
 * anonymous (`«…»`) endpoint — or a kind with no statement form (Conjugation)
 * — is skipped rather than emitted as unparseable text (previous behaviour:
 * silently dropped or, at root level, emitted as a bare eClass).
 */
function relationshipStmtLine(model: Model, el: ElementRecord, pad: string): string {
  const form = RELATIONSHIP_STMT_FORM[el.eClass];
  if (!form) return '';
  const src = endpoint(model, el, 'source');
  const tgt = endpoint(model, el, 'target');
  if (!src || !tgt || src.includes('«') || tgt.includes('«')) return '';
  return `${pad}${form.kind} ${src} ${form.op} ${tgt};`;
}

/** `alias N for Target;` — a named Membership (resolved target or `aliasFor` ref). */
function aliasLine(model: Model, el: ElementRecord, indent: number): string {
  const vis = el.attrs.visibility;
  const visPrefix = vis === 'public' || vis === 'private' || vis === 'protected' ? `${vis} ` : '';
  const short =
    el.declaredShortName !== undefined ? `<${quoteName(el.declaredShortName)}> ` : '';
  const name = el.declaredName !== undefined ? `${quoteName(el.declaredName)} ` : '';
  const tid = (el.target ?? [])[0];
  const target = tid
    ? refTo(model, tid, el.ownerId)
    : typeof el.attrs.aliasFor === 'string'
      ? el.attrs.aliasFor
      : '';
  const head = `${visPrefix}alias ${short}${name}for ${target}`;
  return renderWithBody(model, el, indent, head);
}

function transitionLine(model: Model, el: ElementRecord, pad: string): string {
  const parts = ['transition'];
  if (el.declaredName !== undefined) parts.push(quoteName(el.declaredName));
  parts.push('first', endpoint(model, el, 'source'));
  if (typeof el.attrs.trigger === 'string' && el.attrs.trigger) parts.push('accept', el.attrs.trigger);
  if (typeof el.attrs.guard === 'string' && el.attrs.guard) parts.push(`if ${el.attrs.guard}`);
  if (typeof el.attrs.effect === 'string' && el.attrs.effect) parts.push('do', el.attrs.effect);
  parts.push('then', endpoint(model, el, 'target'));
  return `${pad}${parts.join(' ')};`;
}

function controlNodeLine(el: ElementRecord, pad: string): string {
  const kw: Record<string, string> = {
    ForkNode: 'fork',
    JoinNode: 'join',
    MergeNode: 'merge',
    DecisionNode: 'decide',
    InitialNode: 'initial',
    DoneNode: 'done',
  };
  const word = kw[el.eClass] ?? el.eClass;
  return `${pad}${word}${
    el.declaredName !== undefined ? ` ${quoteName(el.declaredName)}` : ''
  };`;
}

/* ─────────────────────────── reference paths ──────────────────────────── */

/**
 * How a caller says "this is the rule my reference will be re-parsed under".
 * Given the candidate spelling and the scope it will be read from, it answers
 * the element that spelling denotes — or undefined.
 */
type RefResolver = (simple: string, scopeOwnerId: ElementId | null) => ElementRecord | undefined;

/**
 * The resolver for one specialization-family relationship, mirroring
 * `Mapper.resolveSpecTarget` exactly — that symmetry IS the round-trip
 * guarantee, so the two must be changed together.
 */
function specResolver(model: Model, relClass: string, sourceId: ElementId): RefResolver {
  return relClass === 'Redefinition'
    ? (simple, scope) => resolveRedefinedFeature(model, simple, sourceId, scope)
    : (simple, scope) => resolveFullName(model, simple, scope, { exclude: sourceId });
}

/**
 * Render a reference to `targetId` usable from `scopeOwnerId`, preferring the
 * SHORTEST form that still denotes the same element from that scope:
 *
 *  1. the simple name, when resolving it from this scope finds the same element
 *     (KerML resolves outward through enclosing namespaces, so a sibling of an
 *     ancestor is reachable by its bare name);
 *  2. the dotted relative path, when the target is a descendant of the scope;
 *  3. the fully-qualified `::` name.
 *
 * Step 1 exists because the alternative is noise: a feature typed by a
 * definition declared beside its owner would otherwise serialize as
 * `port fuelIn : VehicleModel::FuelPort` when the author wrote `: FuelPort`.
 * Both re-parse to the same model, but only one of them is what anyone wrote.
 *
 * Step 1 asks THE RESOLVER, not a private owned-only walk. The two used to
 * disagree: the walk knew nothing of inherited or imported members, so a
 * feature typed through `import Lib::*;` re-emitted as `part w : Lib::Widget;`
 * and one redefining an inherited feature as `part b :>> P::D::a;` — qualified
 * paths nobody wrote, for names that resolve perfectly well on their own.
 *
 * WHICH resolver is the caller's business, because "the simple name is enough"
 * only means "re-parsing it binds the same element" if the test uses the rule
 * the RE-PARSE will use. A `:>>` re-parses under KerML §8.2.3.5.1 (the generals
 * of the owning type first, the redefining feature excluded), and that answers
 * differently from full resolution: with `E :> D2, D3` where `D2 :> D` and both
 * `D` and `D3` own an `a`, full resolution says `D3::a` and the redefinition
 * rule says `D::a` — so emitting the simple name silently RETARGETED the
 * Redefinition on the next load. The caller passes `resolve`; the default is
 * plain full resolution, which is the rule for every other reference.
 */
function refTo(
  model: Model,
  targetId: ElementId,
  scopeOwnerId: ElementId | null,
  resolve?: RefResolver,
): string {
  const answer = resolve ?? ((simple: string, scope: ElementId | null) =>
    resolveFullName(model, simple, scope));
  const target = model.get(targetId);
  const simple = target ? nameOf(target) : undefined;
  if (simple && !simple.startsWith('«') && answer(simple, scopeOwnerId)?.id === targetId) {
    return simple;
  }
  const rel = relativePath(model, targetId, scopeOwnerId);
  if (rel) return rel;
  return qualifiedRef(model, targetId);
}

function relativePath(
  model: Model,
  targetId: ElementId,
  scope: ElementId | null,
): string | undefined {
  const names: string[] = [];
  let cur: ElementRecord | undefined = model.get(targetId);
  const guard = new Set<ElementId>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    const nm = nameOf(cur);
    if (!nm) return undefined; // anonymous ancestor — cannot path through it
    names.unshift(nm);
    if (cur.ownerId === scope) return names.join('.');
    if (cur.ownerId === null) break;
    cur = model.get(cur.ownerId);
  }
  return undefined;
}

function qualifiedRef(model: Model, targetId: ElementId): string {
  const qn = model.qualifiedName(targetId);
  // F2 residual: quote each ::-segment so a package named 'my pkg' round-trips
  // ('my pkg'::Target) instead of emitting an unparseable raw path.
  return qn.split('::').map((seg) => (seg.startsWith('«') ? seg : quoteName(seg))).join('::');
}

/* ──────────────────────────────── values ──────────────────────────────── */

/**
 * The text to emit for a feature value: the author's own lexeme when the model
 * still carries it AND it still denotes the current number.
 *
 * `attrs.valueText` is written by the parser beside a numeric `attrs.value`
 * (`1500.0`, `1e3`). Any later change to the value — the Properties panel, the
 * SDK, a collaborator — makes the lexeme stale; the `Number(t) === v` guard is
 * what makes that safe, not any discipline at the write sites.
 */
function valueLexeme(el: ElementRecord): string {
  const v = el.attrs.value;
  const t = el.attrs.valueText;
  if (typeof v === 'number' && typeof t === 'string' && t !== '' && Number(t) === v) return t;
  return formatValue(v);
}

function formatValue(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  // Objects/arrays (allowed by AttrValue) must not degrade to "[object Object]";
  // emit valid JSON so the value survives round-trip.
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function attrStr(el: ElementRecord, key: string): string {
  const v = el.attrs[key];
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * The text of a note body, or a THROW when it has none that can be written.
 *
 * This is emitted with no escaping at all, into a terminal that has no escape
 * for its own terminator (see `semantics/notes.ts`, which also records the one
 * other verbatim-written string — a value expression — that this does not
 * cover). A body carrying it closes the note early and everything
 * after it is re-read as declarations — silently, because the corrupted file
 * parses. Refusing to produce the file is the honest answer: the write
 * boundaries refuse such a value and `validation/unwritable-note-body` reports a
 * model that already holds one, so reaching this throw means both were bypassed.
 */
function noteBody(el: ElementRecord, key: 'body' | 'text'): string {
  const text = attrStr(el, key);
  if (!isWritableNoteBody(text)) throw new UnwritableNoteBodyError(el.id, key);
  return text;
}

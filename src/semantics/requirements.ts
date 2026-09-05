/**
 * Requirements management — the facets a requirement carries besides its text.
 *
 * A requirement in a real programme is not only a sentence. It has a lifecycle
 * status, a verification verdict and method, a risk, a priority, a criticality,
 * a rationale, a source it came from and an owner who answers for it. This
 * module is where those live, together with the two things every consumer needs
 * from a requirement first — its ID and its statement.
 *
 * WHERE EACH THING IS KEPT, AND WHY THERE.
 *
 *  - The ID is the element's own `declaredShortName`, the `<R1>` in
 *    `requirement <R1> maxMass`. The notation already has a slot for it, so
 *    using anything else means inventing an identity beside the one the file
 *    carries.
 *  - The STATEMENT is the body of an owned `Documentation` (or `Comment`)
 *    child — an element, addressable and editable like any other, rather than a
 *    string hidden on its owner.
 *  - The FACETS live under ONE owned metadata usage named
 *    {@link RM_METADATA_NAME}, each as an owned attribute holding a string
 *    value: `metadata RequirementMetadata { attribute status = "open"; }`.
 *
 * WHAT THAT CARRIER LINE MEANS, AND DOES NOT. `RequirementMetadata` there names
 * no definition this tool declares — metadata is unbound here, exactly as it is
 * for the `#keyword`s in `statement-kind.ts`, so the carrier is a tag whose
 * meaning lives in this module rather than in the model. The notation's own
 * grammar reads the identifier after `metadata` as the DEFINITION being typed by
 * (`MetadataUsageDeclaration`), while this tool's parser reads it as a name; the
 * two disagree about what the line says, and neither of them resolves it to
 * anything. {@link getRequirementMetadata} therefore accepts both spellings on
 * READ — the bare `metadata RequirementMetadata { … }` this module writes and
 * the typed `metadata rm : RequirementMetadata { … }` a person may hand-write —
 * and never the ANNOTATING form `@RequirementMetadata { … }`, which points at
 * some other element rather than owning facets for this one.
 *
 * WHY THE FACETS ARE ATTRIBUTES AND NOT A BAG ON THE CARRIER. The paused work
 * this module recovers put the nine keys in the metadata usage's own `attrs`,
 * which is faster to write and reads the same — but the serializer has no
 * notation for an arbitrary attribute bag, so such a carrier saves as
 * `metadata RequirementMetadata;` and every facet is gone the next time the
 * file is opened. An owned attribute with a value is ordinary notation: it
 * saves, re-parses and reads back byte for byte, which the round-trip
 * assertion in `test/unit/semantics.requirements.test.ts` pins. A value is
 * written as a quoted string literal — the same lexeme-with-quotes shape the
 * parser stores for `= "open"` — so a rationale containing a space, a quote or
 * a backslash cannot break the file it is saved into.
 *
 * TWO SHAPES COEXIST, AND READING KNOWS BOTH. Models saved before this — and
 * everything `ModelFactory.requirement` still writes today — keep the ID in
 * `attrs.reqId` and the statement in `attrs.text`. {@link requirementShortId}
 * and {@link requirementStatement} prefer the native slot and fall back to the
 * legacy one. The fallback is READ-ONLY: nothing here writes those keys again,
 * and nothing migrates a saved model behind the author's back. The serializer
 * has the same preference — it emits `declaredShortName` and falls back to
 * `attrs.reqId` — because a writer that preferred the other one made an edited
 * id display as the new value, save as the old one, and revert on reopen.
 *
 * THE LEGACY SLOT IS NOT ONLY HISTORICAL. Every save-and-reopen produces it:
 * the mapper's requirement special case folds a requirement's `doc` body into
 * `attrs.text` and creates no `Documentation` element at all, and re-derives
 * `attrs.reqId` from the short name it just read. So a requirement built
 * natively in memory reads through its Documentation child, and the same
 * requirement read back from the file it was saved to reads through the
 * fallback. Two consequences a caller has to know: `requirementDoc` is
 * undefined for anything that came from a `.sysml` file, and a requirement
 * written with more than one `doc` keeps only the LAST body — the earlier ones
 * are dropped on the next save, and {@link requirementStatement} reports the
 * survivor rather than the first.
 *
 * THE TENTH KEY IS NOT STORED HERE. `statementKind` — whether a statement is
 * normative, an explanation, or guidance for an agent — is carried as a
 * user-defined keyword on the declaration itself (`src/semantics/statement-kind.ts`),
 * because that is what round-trips and what the rest of the tool reads. It
 * appears in {@link RM_ATTR_KEYS} so one editor can offer all ten facets in one
 * list, and reads and writes of it are forwarded to that module rather than
 * copied into a second place where the two could disagree.
 *
 * WHAT IS NOT CHECKED. Validation happens on the way IN, never on what a file
 * already holds: nothing rules on a hand-written carrier, so `attribute stauts
 * = "open";` is simply not a facet, and `attribute status = "bogus";` reads
 * back as `bogus` although no writer here would have accepted it. A file
 * carrying TWO `RequirementMetadata` carriers is another such edge — the first
 * one wins every read and takes every write, and the second's values stay in
 * the file saying something else. A validation rule for either would be the
 * honest fix; until there is one, they are recorded here.
 *
 * The enumerated value lists mirror the ones the standard library defines
 * (`StatusKind`, `VerdictKind`, `RiskLevel`, `VerificationMethodKind`);
 * `priority` and the free-text keys are this tool's own.
 */

import { isRequirement, type ElementId, type ElementRecord, type Model } from '@core/index';
import {
  STATEMENT_KINDS,
  clearStatementKind,
  isStatementKind,
  setStatementKind,
  statementKindOf,
  statementKindOfKeyword,
} from './statement-kind';

/* ─────────────────────────── Enum value lists ─────────────────────────── */

/** Requirement lifecycle status (library `StatusKind`). */
export const STATUS_KIND_VALUES = ['open', 'tbd', 'tbr', 'tbc', 'done', 'closed'] as const;
/** Verification verdict (library `VerdictKind`). */
export const VERDICT_KIND_VALUES = ['pass', 'fail', 'inconclusive', 'error'] as const;
/** Risk level (library `RiskLevel`). */
export const RISK_LEVEL_VALUES = ['low', 'medium', 'high'] as const;
/** Verification method (library `VerificationMethodKind`). */
export const VERIFICATION_METHOD_VALUES = ['inspect', 'analyze', 'demo', 'test'] as const;
/** Priority — an ordinal of this tool's own, not one the standard defines. */
export const PRIORITY_VALUES = ['low', 'medium', 'high', 'critical'] as const;

export type StatusKind = (typeof STATUS_KIND_VALUES)[number];
export type VerdictKind = (typeof VERDICT_KIND_VALUES)[number];
export type RiskLevel = (typeof RISK_LEVEL_VALUES)[number];
export type VerificationMethod = (typeof VERIFICATION_METHOD_VALUES)[number];
export type Priority = (typeof PRIORITY_VALUES)[number];

/* ─────────────────────────── The attribute keys ───────────────────────── */

/**
 * The editable facets of a requirement, in the order an editor should offer
 * them. Nine are stored on the metadata carrier; `statementKind` is the tenth
 * and is carried by the keyword on the declaration (see the module header).
 */
export const RM_ATTR_KEYS = [
  'status',
  'verdict',
  'risk',
  'priority',
  'criticality',
  'rationale',
  'source',
  'owner',
  'verificationMethod',
  'statementKind',
] as const;
export type RmAttrKey = (typeof RM_ATTR_KEYS)[number];

/**
 * The keys with a closed value list, and what it is. A key absent from here
 * takes any text.
 *
 * `priority` is in this table on purpose: the paused work declared its values
 * and then left the key out of the validated set, so a typo went in silently
 * and every reader of the column had to cope with a value no writer had
 * checked.
 */
export const RM_ENUM_VALUES: Partial<Record<RmAttrKey, readonly string[]>> = {
  status: STATUS_KIND_VALUES,
  verdict: VERDICT_KIND_VALUES,
  risk: RISK_LEVEL_VALUES,
  priority: PRIORITY_VALUES,
  verificationMethod: VERIFICATION_METHOD_VALUES,
  statementKind: STATEMENT_KINDS,
};

const RM_ATTR_KEY_SET = new Set<string>(RM_ATTR_KEYS);

/** The keys held on the metadata carrier — every key but the kind. */
const RM_STORED_KEYS = RM_ATTR_KEYS.filter((k) => k !== 'statementKind');

/** The declared name of the owned metadata usage that carries the facets. */
export const RM_METADATA_NAME = 'RequirementMetadata';

/* ─────────────────────── Identity and statement ───────────────────────── */

/**
 * The requirement's ID — its `declaredShortName`, falling back to the legacy
 * `attrs.reqId`, and `''` when it has neither. The element's own `id` remains
 * the true identity; this is the one a person reads and cites.
 */
export function requirementShortId(model: Model, id: ElementId): string {
  const el = model.get(id);
  if (!el) return '';
  if (el.declaredShortName) return el.declaredShortName;
  const legacy = el.attrs.reqId;
  return typeof legacy === 'string' ? legacy : '';
}

/**
 * The requirement's statement — the body of its owned documentation child,
 * falling back to the legacy `attrs.text`, and `''` when it has neither.
 */
export function requirementStatement(model: Model, id: ElementId): string {
  const doc = requirementDoc(model, id);
  if (doc && typeof doc.attrs.body === 'string') return doc.attrs.body;
  const legacy = model.get(id)?.attrs.text;
  return typeof legacy === 'string' ? legacy : '';
}

/**
 * The owned child that holds the statement, if there is one. A `Comment` counts
 * as well as a `Documentation`: both carry authored prose in `attrs.body`, and
 * a requirement written with either should read the same.
 */
export function requirementDoc(model: Model, id: ElementId): ElementRecord | undefined {
  return model.children(id).find((c) => c.eClass === 'Documentation' || c.eClass === 'Comment');
}

/* ───────────────────────────── The facets ─────────────────────────────── */

/**
 * The owned metadata usage carrying the facets, if the requirement has one.
 *
 * Both declaration spellings count — the bare `metadata RequirementMetadata`
 * this module writes, which the parser stores as a NAME, and the typed
 * `metadata rm : RequirementMetadata`, which it stores as `attrs.typeRef` — so
 * a hand-written carrier is read whichever way its author spelled it.
 *
 * An ANNOTATING usage is not a carrier: `@RequirementMetadata { … }` on a
 * requirement is a MetadataUsage child too, but it annotates something rather
 * than owning this requirement's facets, and reading its attributes as facets
 * would let an annotation quietly override the real carrier. The name test
 * already excludes it today — the mapper puts an annotation's definition in
 * `attrs.type`, which is neither slot read here — so the `annotation` clause is
 * a second lock rather than the only one, and it is written out because a
 * change in how annotations are mapped should not be able to turn one into a
 * carrier silently. The test puts an annotation beside a real carrier and
 * checks which one answers.
 */
export function getRequirementMetadata(model: Model, id: ElementId): ElementRecord | undefined {
  return model
    .children(id)
    .find(
      (c) =>
        c.eClass === 'MetadataUsage' &&
        c.attrs.annotation !== true &&
        (c.declaredName === RM_METADATA_NAME || c.attrs.typeRef === RM_METADATA_NAME),
    );
}

/**
 * The owned attribute holding one key's value, if it is set.
 *
 * The metaclass is part of the match, not decoration: a hand-written carrier
 * may own a child of some other kind under a facet's name — `part status;`, or
 * a documentation named `status` — and matching that child would write the
 * value into an element whose notation has no place for it, so the facet would
 * read back in memory and be missing from the saved file. Refusing it here
 * means the write creates the attribute this module expects, beside whatever
 * else is there.
 */
function cellFor(model: Model, carrier: ElementRecord, key: RmAttrKey): ElementRecord | undefined {
  return model
    .children(carrier.id)
    .find((c) => c.eClass === 'AttributeUsage' && c.declaredName === key);
}

/**
 * The text a stored value denotes.
 *
 * A value written by {@link setRequirementAttr} is a quoted string literal, the
 * shape the parser hands back for `= "open"`; a hand-written file may instead
 * carry a bare name (`= open`) or a number, and those read as themselves rather
 * than being refused.
 */
function valueText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return String(raw);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // A malformed literal is still text a person wrote; show it unquoted
      // rather than dropping the value.
    }
    return raw.slice(1, -1);
  }
  return raw;
}

/** How a value is written into the model: as the literal the notation reads. */
function valueLiteral(value: string): string {
  return JSON.stringify(value);
}

/**
 * One facet's value, or undefined when it is not set.
 *
 * `statementKind` is answered by the keyword on the declaration, which has a
 * fallback of its own: a requirement with no keyword reads as `requirement`.
 */
export function getRequirementAttr(
  model: Model,
  id: ElementId,
  key: RmAttrKey,
): string | undefined {
  if (key === 'statementKind') return statementKindOf(model, id);
  const carrier = getRequirementMetadata(model, id);
  if (!carrier) return undefined;
  return valueText(cellFor(model, carrier, key)?.attrs.value);
}

/**
 * Every facet that has a value, as a plain object. A requirement with nothing
 * set still reports its `statementKind`, because a statement always is one kind
 * of thing or another.
 */
export function getRequirementAttrs(
  model: Model,
  id: ElementId,
): Partial<Record<RmAttrKey, string>> {
  const out: Partial<Record<RmAttrKey, string>> = {};
  const carrier = getRequirementMetadata(model, id);
  if (carrier) {
    for (const key of RM_STORED_KEYS) {
      const v = valueText(cellFor(model, carrier, key)?.attrs.value);
      if (v !== undefined) out[key] = v;
    }
  }
  const kind = statementKindOf(model, id);
  if (kind) out.statementKind = kind;
  return out;
}

/**
 * Whether a key is actually WRITTEN on this requirement.
 *
 * Not the same question as {@link getRequirementAttr}, which answers a
 * `statementKind` from the metaclass for a requirement nobody has tagged. This
 * one is about the file: it is true only when there is a cell on the carrier,
 * or a kind keyword on the declaration. The store command uses it to tell a
 * clear that removes something from a clear that would change nothing.
 */
export function hasRequirementAttr(model: Model, id: ElementId, key: RmAttrKey): boolean {
  const el = model.get(id);
  if (!el) return false;
  if (key === 'statementKind') {
    const meta = el.attrs.metadata;
    return Array.isArray(meta) && meta.some((m) => statementKindOfKeyword(String(m)) !== undefined);
  }
  const carrier = getRequirementMetadata(model, id);
  return carrier !== undefined && cellFor(model, carrier, key) !== undefined;
}

/**
 * True when this element's own text is what gets saved, so something written
 * onto it reaches the file.
 *
 * A faulted declaration keeps its original source in `attrs.unparsedText`, and
 * the serializer re-emits that text verbatim and NOTHING else, its subtree
 * included; an implicit element serializes to the empty string. Either way a
 * facet carrier created underneath reads back perfectly in memory and is gone
 * from the next saved file — the same silent loss the storage shape was chosen
 * to avoid. `canCarryStatementKind` refuses these elements for the same reason,
 * and this mirrors its first block rather than importing it, because the rest
 * of that predicate answers a different question (where a KEYWORD may go).
 *
 * EXPORTED so an editor can ask BEFORE it offers the control. `setRequirementAttr`
 * throws here, the store logs the throw and puts its snapshot back, and a panel
 * that never asked the question therefore showed a live drop-down that snapped
 * back with nothing written and nothing said. A control the write will refuse
 * belongs disabled, with the reason on it.
 */
export function carriesItsOwnText(el: ElementRecord): boolean {
  if (el.attrs.implicit === true) return false;
  const unparsed = el.attrs.unparsedText;
  return !(typeof unparsed === 'string' && unparsed.trim() !== '');
}

/**
 * Why a facet write is refused, in words for the person holding the mouse.
 *
 * The throw {@link setRequirementAttr} raises is written for a developer
 * reading a stack trace. Every editor that disables a control because
 * {@link carriesItsOwnText} said no needs the other version, and it lives here,
 * once, so the requirements grid and the Properties panel cannot come to give
 * two different accounts of the same refusal.
 */
export const FAULTED_DECLARATION_REFUSAL =
  'This requirement\u2019s declaration could not be parsed, so the file re-emits its own source and a ' +
  'facet written here would be lost on the next save. Fix the declaration in the Text tab first.';

/**
 * Set one facet of a requirement, or clear it with an empty value.
 *
 * Validation happens BEFORE anything is written, so a refused write leaves the
 * model exactly as it was — which is what lets the store command roll its undo
 * snapshot straight back off the stack.
 *
 * Clearing REMOVES the key rather than writing an empty string: the paused work
 * wrote `''`, so a cleared status read back as a value that was not a status,
 * and every consumer had to know that `''` and "unset" meant the same thing.
 * The carrier goes with the last key it held, so a cleared requirement leaves
 * no empty `metadata RequirementMetadata;` behind in the saved file.
 *
 * @returns the element the value was written to — the metadata carrier for a
 *   stored key, the requirement itself for `statementKind` — or undefined when
 *   a clear left nothing behind.
 * @throws when `id` is not a requirement, `key` is not one of the facets, the
 *   value is not one the key allows, or the requirement's own declaration
 *   could not be parsed — a facet written under a faulted declaration would be
 *   dropped by the very next save, and saying so beats losing it quietly.
 */
export function setRequirementAttr(
  model: Model,
  id: ElementId,
  key: RmAttrKey,
  value: string | null | undefined,
): ElementRecord | undefined {
  const el = model.get(id);
  if (!el || !isRequirement(el.eClass)) {
    throw new Error(`setRequirementAttr: ${id} is not a requirement`);
  }
  if (!RM_ATTR_KEY_SET.has(key)) {
    throw new Error(
      `setRequirementAttr: unknown requirement attribute "${key}" (${RM_ATTR_KEYS.join(', ')})`,
    );
  }
  if (!carriesItsOwnText(el)) {
    throw new Error(
      `setRequirementAttr: a ${el.eClass} whose declaration could not be parsed cannot carry facets — the saved file re-emits its own source, and the value would be lost`,
    );
  }
  const clearing = value === undefined || value === null || value === '';
  const allowed = RM_ENUM_VALUES[key];
  if (!clearing && allowed && !allowed.includes(value)) {
    throw new Error(
      `setRequirementAttr: invalid ${key} "${value}" (allowed: ${allowed.join(', ')})`,
    );
  }

  if (key === 'statementKind') {
    if (clearing) return clearStatementKind(model, id);
    // `allowed` above has already refused anything else; the narrowing is for
    // the type system, and the throw is the honest answer if it ever changes.
    if (!isStatementKind(value)) throw new Error(`setRequirementAttr: invalid statementKind`);
    return setStatementKind(model, id, value);
  }

  const carrier = getRequirementMetadata(model, id);
  if (clearing) {
    if (!carrier) return undefined;
    const cell = cellFor(model, carrier, key);
    if (cell) model.remove(cell.id);
    if (model.children(carrier.id).length === 0) {
      model.remove(carrier.id);
      return undefined;
    }
    return carrier;
  }

  const target =
    carrier ?? model.create('MetadataUsage', { declaredName: RM_METADATA_NAME, ownerId: id });
  const cell =
    cellFor(model, target, key) ??
    model.create('AttributeUsage', { declaredName: key, ownerId: target.id });
  // `valueText` is the parser's lexeme for a NUMBER it read; a facet is text, so
  // any lexeme left from an earlier value would contradict the new one.
  model.setAttrs(cell.id, { value: valueLiteral(value), valueText: undefined });
  return target;
}

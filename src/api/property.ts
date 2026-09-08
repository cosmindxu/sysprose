/**
 * Property authoring under gates: `propertyDraft` and `propertyCheck`
 * (plan docs/04-formal-verification-plan.md §3.3).
 *
 * THE CHARTER OF THIS FILE, IN ONE LINE: **the tool supplies the dictionary,
 * the template and the gates; the agent supplies the meaning, and the tool
 * never claims to have checked it.** `danso-2026` sets the bar this answers —
 * syntax is easy, semantics is hard — so every report this module produces
 * carries {@link MEANING_NOTICE}, verbatim, and nothing here may ever say that a
 * clause is the formalisation the prose beside it asked for.
 *
 * Four decisions carry the file.
 *
 *  1. **Gate 0 REFUSES; it does not accept-with-a-gap.** A clause whose `scope`,
 *     `condition` or `timing` field is outside the encodable fragment is
 *     temporal, and nothing downstream — not the literal engine, not z3, not the
 *     explorer of commit 13 — can decide it. "Accepted, but the temporal part
 *     was ignored" is the sentence that would put an undecidable clause into a
 *     file with a tick beside it, so it does not exist. `mavridou-2026` is
 *     explicit that only three of the six FRETish fields are mandatory and that
 *     an omitted `timing` reads as *eventually*, a liveness claim no in-process
 *     engine in phases 0–3 discharges; that is why the other three ship as
 *     commented guidance rather than as fields to fill in.
 *  2. **The four judging gates are gates the rest of the tool already applies.**
 *     Gate 1 is `parseRelationBody`; gate 3 is
 *     `evaluateConstraintQuantityDetailed` and then `readRelation` — the same
 *     unit gates the numeric surface and the SMT encoder stand behind; gate 4 is
 *     the same `encodeRelation` / `loadZ3` pair the engine uses. A private
 *     re-implementation of any of them would let `property-check` accept a
 *     clause `verify` then refuses, which is the one thing this command exists
 *     to prevent.
 *  3. **Gate 3 runs over `model.clone()`.** The transient constraint has to be
 *     OWNED by the requirement for its scope to be the subject's, and owning it
 *     means writing into a model. The caller's model is never written to — not
 *     transiently, and not with a `finally` that removes it again, because a
 *     throw in between would leave somebody's model carrying an element they
 *     never authored.
 *  4. **Gate 4 is SYNTACTIC non-triviality, and the limit is on every report.**
 *     The clause is checked satisfiable and its negation satisfiable **with no
 *     axioms asserted at all**, so `uav.mtow <= 25.0 [kg]` passes even though the
 *     model pins `mtow = 18.5 [kg]`. A clause the model's own literals already
 *     satisfy is not caught here — that is `verify`'s tautology check and the
 *     vacuity report — and §6's limits register records it. Every report says so
 *     in words, because a gate whose scope a reader has to infer is a gate that
 *     will be read as stronger than it ran.
 *
 * Pure with respect to its arguments: nothing here writes to the model it was
 * given, and nothing writes to a file. The tool tells, the agent edits.
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import type { TextRange } from '@validation/types';
import { promptsFor, type ApplicablePrompt } from './analytics';
import {
  clauseHostOf,
  contractOf,
  readRelation,
  type ContractRef,
  type ContractSubject,
  type RelationReading,
} from '../semantics/contracts';
import { featureIdsFor } from '../semantics/evaluate-model';
import type { ExprNode } from '../semantics/expr';
import { parseRelationBody, type LoweredLiteral } from '../semantics/relations';
import { requirementShortId, requirementStatement } from '../semantics/requirements';
import { isNonNormativeStatement } from '../semantics/statement-kind';
import { encodeRelation, encodeScript, encodeVariablesOf, notTerm } from '../semantics/smt/encode';
import { DEFAULT_TIMEOUT_MS, loadZ3 } from '../semantics/smt/z3-bridge';
import { dimToString } from '../semantics/units';
import {
  dimensionClaimDetail,
  dimensionalFacets,
  evaluateConstraintQuantityDetailed,
  isRefusalReason,
  type DerivationMemo,
  type DimensionClaim,
} from '../semantics/units-eval';

/* ────────────────────────────── the vocabulary ──────────────────────────── */

/**
 * The `verification/*` code each gate raises, keyed by the gate it belongs to.
 *
 * A RECORD rather than five loose constants because every consumer wants the
 * pair — the gate and the code it produced — and a reader of `report.code` who
 * has to grep to learn which gate it came from is a reader who will guess.
 * `unsupported` is the one code this module does not own: a body that does not
 * parse, a collection-valued feature, a remainder, a variable exponent and
 * arithmetic on an offset scale are all already `verification/unsupported-
 * expression`, whose catalogue entry names exactly those refusals, and a second
 * code per gate would give a reader two dictionary entries for one fact.
 */
export const PROPERTY_CODES = {
  /** Gate 0: a FRETish field this lane's engines cannot read. */
  temporal: 'verification/temporal-field-unencodable',
  /** Gate 1, and any other gate whose refusal the catalogue already names. */
  unsupported: 'verification/unsupported-expression',
  /** Gate 2: a name the subject's own scope does not offer. */
  unresolved: 'verification/unresolved-name-in-property',
  /** Gate 3: two operands that must share a dimension and do not. */
  dimension: 'verification/dimension-clash-in-property',
  /** Gate 4: valid on its own, or unsatisfiable on its own. */
  trivial: 'verification/trivial-property',
  /** Gate 4, not run: no solver, or a check that came back undecided. */
  unchecked: 'verification/nontriviality-unchecked',
} as const;

/**
 * The same codes as a set, for the catalogue guard.
 *
 * `./verification` folds it into `VERIFICATION_CODES`, which
 * `test/unit/diagnostic-codes.test.ts` reads: a code a reader is shown is a code
 * the catalogue explains, whichever module raises it.
 */
export const PROPERTY_CODE_SET: ReadonlySet<string> = new Set<string>(
  Object.values(PROPERTY_CODES),
);

/**
 * The sentence every report carries, verbatim.
 *
 * §3.3 fixes it rather than leaving it to each surface, because a disclaimer
 * paraphrased per renderer is a disclaimer a reader learns to skip. Both
 * subcommands print it as their last line and both payloads publish it.
 */
export const MEANING_NOTICE = 'meaning is not checked; read the back-translation.';

/**
 * The limit gate 4 does NOT close, printed on every report.
 *
 * §6's register carries it and §3.3 states it in the same words: gate 4 asserts
 * no axioms, so a clause the model's own literals already satisfy is non-trivial
 * *on its own* and passes. A reader who took "non-trivial" to mean "says
 * something about this design" would have read a stronger gate than the one that
 * ran.
 */
export const GATE_4_LIMIT =
  'gate 4 is syntactic non-triviality: the clause is checked satisfiable and its negation ' +
  'satisfiable with NO axioms asserted, so a clause the model’s own feature values already ' +
  'satisfy passes it — `uav.mtow <= 25.0 [kg]` is accepted over a model that pins ' +
  '`mtow = 18.5 [kg]`. `verify`’s tautology check and the vacuity report are what decide that; ' +
  'the limit is recorded in the §6 limits register.';

/** The second limit, and the one a reader is likeliest to forget. */
export const MEANING_LIMIT =
  'nothing here reads the requirement’s prose: the gates decide whether a clause is well formed, ' +
  'in scope, dimensionally sound and non-trivial, and never whether it says what the prose asked ' +
  'for. That judgement is the author’s, which is what the back-translation is printed for.';

/** Both limits, in the order a report prints them. */
export const PROPERTY_LIMITS: readonly string[] = [GATE_4_LIMIT, MEANING_LIMIT];

/* ───────────────────────────── FRETish fields ───────────────────────────── */

/** The three FRETish fields `mavridou-2026` makes mandatory. */
export const MANDATORY_FIELDS = ['component', 'shall', 'response'] as const;

/**
 * The three FRETish fields this lane cannot encode.
 *
 * They are emitted as commented guidance by {@link propertyDraft} and refused by
 * gate 0 of {@link propertyCheck} — two halves of one decision, so an author who
 * ignored the guidance meets the same words in the refusal.
 */
export const TEMPORAL_FIELDS = ['scope', 'condition', 'timing'] as const;

/** Every FRETish field name this module reads. */
export type FretishField = (typeof MANDATORY_FIELDS)[number] | (typeof TEMPORAL_FIELDS)[number];

const FIELD_NAMES: ReadonlySet<string> = new Set<string>([...MANDATORY_FIELDS, ...TEMPORAL_FIELDS]);

/**
 * The one spelling of each temporal field that is NOT a temporal claim.
 *
 * `scope = global` is the absence of a scope and `timing = always` is the
 * invariant reading a static engine already has, so writing either states
 * nothing the gates do not assume; a clause carrying one is accepted rather than
 * refused for having spelled out its own default. Everything else — including
 * FRETish's own `timing` default, *eventually*, which is liveness — is refused,
 * and `condition` has no such spelling at all: a condition says WHEN a response
 * is owed, and that is a claim about time however it is written.
 */
const STATIC_READING: Record<(typeof TEMPORAL_FIELDS)[number], string | null> = {
  scope: 'global',
  condition: null,
  timing: 'always',
};

/** The fragment marker §3.3 puts on each temporal field. One string, quoted twice. */
export const TEMPORAL_FRAGMENT =
  'fragment: temporal — not encodable by any in-process engine; export-only (§3.11)';

/** Why each temporal field is guidance rather than a field to fill in. */
const TEMPORAL_REASON: Record<(typeof TEMPORAL_FIELDS)[number], string> = {
  scope:
    'a scope other than `global` names an interval of an execution — `after`, `before`, `in`, ' +
    '`only in` — and nothing in phases 0–3 of this plan walks an execution to decide one. Restate ' +
    'the clause globally, or export it (§3.11)',
  condition:
    'a condition is the trigger half of a FRETish sentence: it says WHEN the response is owed, ' +
    'which is a claim about time rather than about the values a design admits. Fold it into the ' +
    'requirement as an `assume constraint`, or export it (§3.11)',
  timing:
    'an omitted `timing` reads as *eventually*, which is liveness, and no in-process engine here ' +
    'discharges a liveness claim; writing one down does not make it decidable. Leave it unwritten ' +
    '— or write `always`, the invariant reading — or export it (§3.11)',
};

/* ───────────────────────────── report shapes ────────────────────────────── */

/** How one gate ended. `not-run` is never a pass — see gate 4. */
export type GateStatus = 'passed' | 'refused' | 'not-run';

/** The three words a clause leaves this module with. */
export type PropertyOutcome = 'accepted' | 'accepted-with-gap' | 'refused';

/** One gate: its number, its name, how it ended, and the sentence a person acts on. */
export interface GateResult {
  /** 0 for the fragment gate, 1–4 for the judging gates, in the order they run. */
  gate: number;
  name: string;
  status: GateStatus;
  detail: string;
}

/** One FRETish field, as `property-draft` emits it. */
export interface FretishFieldRow {
  field: FretishField;
  /** One of the three `mavridou-2026` requires. */
  mandatory: boolean;
  /** Can any in-process engine here decide a clause that uses it? */
  encodable: boolean;
  /** What the draft fills in — the subject, `shall`, the response skeleton — or `''`. */
  text: string;
  /** The fragment marker and the reason, for a field that is not encodable. */
  note: string;
}

/** One legal name in the subject's scope, with everything a clause needs to use it. */
export interface DictionaryEntry {
  /** The name a clause writes — always through the subject (`uav.endurance`). */
  name: string;
  /** The element's qualified name, which is what an SMT symbol is keyed on. */
  qualifiedName: string;
  /** The declared type as written (`ISQ::MassValue`, `Real`), or `null`. */
  type: string | null;
  /** The declared unit symbol, or `null` — a derived feature has none of its own. */
  unit: string | null;
  /** The physical dimension, rendered (`M`, `T`, `L²·M·T⁻³`), or `null`. */
  dimension: string | null;
  /** What the value CLAIMS about that dimension — see `dimensionClaim`. */
  claim: DimensionClaim;
  /** The value as the file writes it, or `null` when it has none. */
  value: string | null;
  /** May this name stand in an arithmetic comparison? */
  numeric: boolean;
}

/** What `property-draft` hands an agent. */
export interface PropertyDraftReport {
  requirement: ContractRef;
  /** The `<R-UAV-001>` short id, or `''`. */
  shortId: string;
  /** The requirement's own prose — what the clause has to mean. */
  statement: string;
  subject: ContractSubject | null;
  /** All six FRETish fields: the three that are filled in, then the three that are not. */
  fields: FretishFieldRow[];
  /** Every legal name in the subject's scope, nearest first. */
  dictionary: DictionaryEntry[];
  /** Every `#prompt` reaching the requirement or its subject type, verbatim. */
  prompts: ApplicablePrompt[];
  /** Clause shapes built from the dictionary; each passes this module's own gates. */
  examples: string[];
  /** The skeleton as text: six commented fields and a live line carrying `<bound>`. */
  skeleton: string;
  /** The clauses the requirement already carries, so a draft does not duplicate one. */
  existing: Array<{ role: 'assume' | 'require'; expression: string }>;
  /** {@link PROPERTY_LIMITS}. */
  limits: readonly string[];
  /** {@link MEANING_NOTICE}. */
  notice: string;
}

/** What `property-check` hands an agent. */
export interface PropertyCheckReport {
  requirement: ContractRef;
  shortId: string;
  subject: ContractSubject | null;
  /** The clause exactly as the caller wrote it. */
  clause: string;
  /** The response half — what is left once the FRETish fields are read off. */
  body: string;
  /** The FRETish fields the caller wrote, in the order they were written. */
  fields: Array<{ field: FretishField; value: string }>;
  outcome: PropertyOutcome;
  /** The gate that refused, or `null` when nothing did. */
  refusedAt: number | null;
  /** The refusal's code, the gap's code, or `null` when the clause was accepted outright. */
  code: string | null;
  /** The sentence behind {@link PropertyCheckReport.outcome}. */
  detail: string;
  /** Nearest names the author may have meant — gate 2's suggestions. */
  expected: string[];
  /** All five gates, always, in order. */
  gates: GateResult[];
  /** The names the clause reads, with what each resolved to. */
  reads: Array<{ name: string; qualifiedName: string }>;
  /** Structured English for the clause, or `null` when it did not parse. */
  backTranslation: string | null;
  /** A zero-width span inside the requirement body, or `null`. */
  range: TextRange | null;
  /** The line that would go there, or `null`. */
  insertion: string | null;
  /** The indentation that line would carry. */
  indent: string;
  /** Why there is no range, when there is none. */
  rangeNote: string;
  /** What answered gate 4: the solver's own version, or the absence. */
  solver: { version: string | null; detail: string };
  /** {@link PROPERTY_LIMITS}. */
  limits: readonly string[];
  /** {@link MEANING_NOTICE}. */
  notice: string;
}

/** What a caller may hand {@link propertyCheck} beyond the model and the clause. */
export interface PropertyOptions {
  /**
   * The element→source-span table `loadModelText` returns.
   *
   * Optional because the in-process API is usable without a file: a caller that
   * built the model programmatically has no spans, and gets `range: null` with
   * the reason rather than a position invented out of nothing.
   */
  ranges?: ReadonlyMap<ElementId, TextRange>;
  /**
   * The source text those spans are offsets into.
   *
   * Only the INDENTATION needs it; the position itself comes from the spans. A
   * caller with spans and no text still gets a range, with four spaces assumed.
   */
  sourceText?: string;
  /** The per-check budget for gate 4, in ms. Defaults to the bridge's. */
  timeoutMs?: number;
}

/**
 * A `REF` that names something no clause can be drafted or checked for.
 *
 * A problem with what was ASKED, not a finding about the model, so it is thrown
 * rather than reported: `scripts/sysprose.ts` re-raises it as its own
 * `UsageError` and the reader gets one sentence and no stack. The same shape
 * `VerifyOptionError` uses, for the same reason.
 */
export class PropertyRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyRefError';
  }
}

/* ─────────────────────────── the data dictionary ────────────────────────── */

/**
 * Every legal name a clause on this requirement may write, with its facets.
 *
 * NAMES ARE ALWAYS WRITTEN THROUGH THE SUBJECT, and that is the whole reason
 * this is not `featureIdsFor` handed straight out. That collector also exposes
 * every feature under its BARE name as a convenience — `mass` as well as
 * `uav.battery.mass` — which is right for evaluating a body somebody already
 * wrote and wrong for telling an agent what to write: the shipped UAV example
 * has two features called `mass`, first occurrence wins, and a dictionary
 * offering the bare name would be offering a silent coin toss. So the dictionary
 * carries the dotted form alone, gate 2 accepts the dotted form alone, and a
 * bare name is refused with the dotted one as the suggestion.
 * `examples/contract-authoring-prompts.sysml` says the same thing in the file:
 * name the subject.
 */
function dictionaryFor(
  model: Model,
  requirementId: ElementId,
  subject: ContractSubject | null,
): DictionaryEntry[] {
  const prefix = subject?.name ? `${subject.name}.` : null;
  const memo: DerivationMemo = new Map();
  const out: DictionaryEntry[] = [];
  for (const [name, id] of featureIdsFor(model, requirementId)) {
    // With a subject, only the names reached THROUGH it. Without one there is
    // nothing to qualify by, so every dotted path is offered and the bare
    // convenience names are still dropped: a bare name in a scope with no
    // subject is as ambiguous as one with a subject.
    if (prefix ? !name.startsWith(prefix) : !name.includes('.')) continue;
    const el = model.get(id);
    if (!el) continue;
    const facets = dimensionalFacets(model, id);
    const derivation = dimensionClaimDetail(model, id, memo);
    const dimension = facets.kindDimension ?? facets.unitDimension ?? derivation.derived;
    out.push({
      name,
      qualifiedName: model.qualifiedName(id),
      type: typeof el.attrs.type === 'string' ? el.attrs.type : null,
      unit: facets.unit ?? null,
      dimension: dimension ? dimToString(dimension) : null,
      claim: derivation.claim,
      value: valueAsWritten(el),
      // `mismatch` is a feature the quantity scopes EXCLUDE, and `unknown` is
      // one nothing could evaluate; either way a clause that compared it would
      // be refused at gate 3, so the dictionary says so before it is written.
      numeric: derivation.claim === 'literal' || derivation.claim === 'consistent',
    });
  }
  // Shortest path first, then alphabetically: the subject's own attributes are
  // what a clause names most often, and a dictionary that opened with a port's
  // data rate three hops down would bury them.
  return out.sort(
    (a, b) => a.name.split('.').length - b.name.split('.').length || a.name.localeCompare(b.name),
  );
}

/** A feature's value as the file writes it — the author's digits, not a re-render. */
function valueAsWritten(el: ElementRecord): string | null {
  const raw = el.attrs.value;
  if (raw === undefined || raw === null) return null;
  if (typeof el.attrs.valueText === 'string') return el.attrs.valueText;
  return typeof raw === 'string' ? raw : String(raw);
}

/* ─────────────────────────────── the draft ──────────────────────────────── */

/**
 * The six FRETish fields: three filled in, three marked and explained.
 *
 * The temporal three are emitted for EVERY draft, whether or not the prose looks
 * temporal. A field that appeared only when the tool thought it was needed would
 * teach an agent that its absence means "not applicable here", which is the one
 * reading it must not have — absence of a field is absence of a claim — and the
 * gate that refuses one later has to have been announced first.
 */
function fieldRows(component: string, response: string): FretishFieldRow[] {
  const mandatory = (field: FretishField, text: string): FretishFieldRow => ({
    field,
    mandatory: true,
    encodable: true,
    text,
    note: '',
  });
  return [
    mandatory('component', component),
    mandatory('shall', 'shall'),
    mandatory('response', response),
    ...TEMPORAL_FIELDS.map(
      (field): FretishFieldRow => ({
        field,
        mandatory: false,
        encodable: false,
        text: '',
        note: `${TEMPORAL_FRAGMENT} — ${TEMPORAL_REASON[field]}`,
      }),
    ),
  ];
}

/**
 * Clause shapes built from the dictionary, each of which passes this module's
 * own gates.
 *
 * The bound is the feature's OWN value, and that is a deliberate compromise with
 * one honest consequence. A placeholder (`uav.mtow >= <bound> [kg]`) would not
 * parse, so an example carrying one could not be checked and the suite could not
 * hold the examples to the gates — which is the assertion that stops this
 * function from emitting a shape `property-check` would refuse. So the examples
 * are real clauses, and they are TEMPLATES rather than requirements: an example
 * that repeats the design's current value states nothing about the design, which
 * is exactly what gate 4's limit above says it cannot catch. Only features with
 * a numeric literal are used, because those are the ones whose shape an author
 * can edit without meeting a refusal on the first try.
 *
 * A feature with no unit still gets an example — `uav.usableEnergyFraction >= 0.8`
 * passes every gate, and a model whose features are plain `Real` (which
 * `examples/vehicle.sysml` is) would otherwise get no examples at all and no
 * sentence saying why the block vanished.
 */
function exampleShapes(dictionary: readonly DictionaryEntry[]): string[] {
  const out: string[] = [];
  for (const entry of dictionary) {
    if (out.length >= 3) break;
    if (!entry.numeric || entry.value === null) continue;
    if (!/^-?\d+(\.\d+)?$/.test(entry.value)) continue;
    out.push(`${entry.name} >= ${entry.value}${entry.unit === null ? '' : ` [${entry.unit}]`}`);
  }
  return out;
}

/**
 * Which quantity the drafted `response` points at.
 *
 * The one field of the skeleton that is supposed to come FROM THE MODEL, so
 * taking whatever sorted first was wrong in a way a reader notices immediately: a
 * requirement about take-off mass was handed `uav.cruisePower >= <bound> [W]`.
 * Three passes, cheapest evidence first — a name an existing `require`/`assume`
 * clause on this very requirement already reads; else one whose last segment the
 * prose says out loud; else the first numeric name in the dictionary, which is
 * what there is when nothing else points anywhere.
 *
 * It is a HINT and never a claim: nothing here reads the prose for meaning, and
 * the skeleton carries `<bound>` precisely because the tool does not know what
 * the requirement asks of the quantity it guessed.
 */
function responseSeed(
  dictionary: readonly DictionaryEntry[],
  existing: readonly { expression: string }[],
  statement: string,
): DictionaryEntry | undefined {
  const numeric = dictionary.filter((e) => e.numeric);
  const written = new Set(
    existing
      .map((c) => c.expression)
      .join(' ')
      .match(NAME_TOKEN) ?? [],
  );
  const byClause = numeric.find((e) => written.has(e.name));
  if (byClause) return byClause;
  const words = new Set((statement.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []));
  const lastSegment = (n: string): string => n.slice(n.lastIndexOf('.') + 1).toLowerCase();
  const byProse = numeric.find((e) => words.has(lastSegment(e.name)));
  return byProse ?? numeric[0] ?? dictionary[0];
}

/** A dotted name as an expression writes it. */
const NAME_TOKEN = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;

/**
 * The FRETish skeleton — a template to fill in, not a block to paste unedited.
 *
 * The six fields are SysML line comments so they can STAY in the file as the
 * record of what was and was not encoded, and the author deletes what they do not
 * need rather than reformatting around them. The last line is the live one, and
 * it carries `<bound>`: it does NOT parse until that placeholder is replaced,
 * which is deliberate — a skeleton whose last line parsed as written would be a
 * clause stating the design's current value, and this function's whole job is to
 * hand over a shape rather than a claim. `examples` is where the clauses that do
 * parse live.
 */
function skeletonText(fields: readonly FretishFieldRow[], response: string): string {
  return [
    ...fields
      .filter((f) => f.mandatory)
      .map((f) => (f.field === 'shall' ? '// shall' : `// ${f.field}: ${f.text}`)),
    // The MARKER only, not the whole reason: the reason is on the field row,
    // where a reader who wants it can read it, and a skeleton whose three
    // commented lines run to four hundred characters is one nobody pastes.
    ...fields.filter((f) => !f.mandatory).map((f) => `// ${f.field}: ${TEMPORAL_FRAGMENT}`),
    `require constraint { ${response} }`,
  ].join('\n');
}

/**
 * The encodable skeleton, drafted from the requirement and its subject.
 *
 * `propertyDraft` decides nothing and checks nothing: it is the dictionary, the
 * template and the guidance an agent needs BEFORE it writes a clause, plus every
 * `#prompt` the engineer wrote that reaches this requirement. The gates are
 * {@link propertyCheck}'s.
 */
export function propertyDraft(model: Model, requirementId: ElementId): PropertyDraftReport {
  const contract = contractOf(model, requirementId);
  if (!contract) throw new PropertyRefError(refRefusal(model, requirementId));
  const subject = contract.subject;
  const dictionary = dictionaryFor(model, requirementId, subject);
  const component = subject?.name || contract.declaredName || contract.qualifiedName;
  const existing = [
    ...contract.assumptions.map((c) => ({ role: 'assume' as const, expression: c.expression })),
    ...contract.guarantees.map((c) => ({ role: 'require' as const, expression: c.expression })),
  ];
  const statement = requirementStatement(model, requirementId);
  const first = responseSeed(dictionary, existing, statement);
  const response = first
    ? `${first.name} >= <bound>${first.unit ? ` [${first.unit}]` : ''}`
    : '<a relation over the subject’s features>';
  const fields = fieldRows(component, response);
  return {
    requirement: refOf(contract),
    shortId: requirementShortId(model, requirementId),
    statement,
    subject,
    fields,
    dictionary,
    // Through the subject as well as through the requirement: guidance written
    // on the part definition a requirement is ABOUT is guidance about writing a
    // clause over it, and an agent handed only the requirement's own prompts
    // would never see it. Deduplicated by prompt id, nearest first, which is the
    // order `promptsFor` already returns.
    prompts: promptsThrough(model, requirementId, subject),
    examples: exampleShapes(dictionary),
    skeleton: skeletonText(fields, response),
    existing,
    limits: PROPERTY_LIMITS,
    notice: MEANING_NOTICE,
  };
}

/** The `#prompt`s reaching the requirement, then the ones reaching its subject. */
function promptsThrough(
  model: Model,
  requirementId: ElementId,
  subject: ContractSubject | null,
): ApplicablePrompt[] {
  const out = promptsFor(model, requirementId).prompts.slice();
  const seen = new Set(out.map((p) => p.prompt.id));
  for (const id of [subject?.typeId, subjectFeatureId(model, requirementId, subject)]) {
    if (id == null) continue;
    for (const p of promptsFor(model, id).prompts) {
      if (seen.has(p.prompt.id)) continue;
      seen.add(p.prompt.id);
      out.push(p);
    }
  }
  return out;
}

/** The subject FEATURE itself (`subject uav : AirVehicle`), when there is one. */
function subjectFeatureId(
  model: Model,
  requirementId: ElementId,
  subject: ContractSubject | null,
): ElementId | undefined {
  if (!subject?.name) return undefined;
  return model.children(requirementId).find((c) => c.declaredName === subject.name)?.id;
}

/** A contract's element reference, in the shape every other report publishes. */
function refOf(contract: {
  id: string;
  eClass: string;
  declaredName?: string;
  qualifiedName: string;
}): ContractRef {
  return {
    id: contract.id,
    eClass: contract.eClass,
    ...(contract.declaredName !== undefined ? { declaredName: contract.declaredName } : {}),
    qualifiedName: contract.qualifiedName,
  };
}

/**
 * Why a `REF` cannot be drafted or checked, in one sentence naming what it is.
 *
 * The `#prose` / `#prompt` case is separated out because it is not a mistake:
 * the author SAID that statement binds nothing, `contractsOf` honours the tag,
 * and a reader told "not a requirement" about something their file plainly
 * declares as one would go looking for a defect that is not there.
 */
function refRefusal(model: Model, id: ElementId): string {
  const el = model.get(id);
  if (!el) return `no element with id \`${id}\` — pass an id, a qualified name or a short id`;
  const name = model.qualifiedName(id) || id;
  if (isNonNormativeStatement(model, id)) {
    return (
      `\`${name}\` is tagged as a non-normative statement (\`#prose\` or \`#prompt\`), so it ` +
      'states no contract and there is no clause to draft for it. Drop the tag if it is meant to ' +
      'bind something.'
    );
  }
  return (
    `\`${name}\` is a ${el.eClass}, not a requirement or a case with an objective; a property ` +
    'clause is drafted for something that states a contract. Run `contracts <file>` for the ones ' +
    'this model has.'
  );
}

/* ────────────────────────── reading a FRETish clause ────────────────────── */

/** The FRETish fields a caller wrote, and whatever is left as the response. */
interface ParsedClause {
  fields: Array<{ field: FretishField; value: string }>;
  body: string;
}

/**
 * Split `scope = after; uav.endurance >= 45.0 [min]` into fields and a body.
 *
 * BOTH SPELLINGS OF THE SEPARATOR ARE READ, `scope: after` and `scope = after`,
 * because {@link skeletonText} emits the colon and a loop whose two halves
 * disagreed about their own mini-syntax would take the draft's own output back
 * and refuse it at gate 1 for not being arithmetic — losing the gate-0 sentence
 * that names the field, which is the whole reason gate 0 exists. A segment merely
 * CONTAINING a separator is not a field — `uav.mtow = 25.0 [kg]` is a relation,
 * and reading it as a field named `uav.mtow` would swallow the clause — so the
 * name has to be one of the six, unqualified. Several non-field segments are
 * re-joined with `;` rather than dropped, so a body carrying one is refused by
 * gate 1 as the unparseable text it is instead of being silently truncated.
 */
function parseClause(clause: string): ParsedClause {
  const fields: Array<{ field: FretishField; value: string }> = [];
  const rest: string[] = [];
  for (const segment of clause.split(';')) {
    if (segment.trim() === '') continue;
    if (/^\s*shall\s*$/i.test(segment)) {
      fields.push({ field: 'shall', value: 'shall' });
      continue;
    }
    const m = /^\s*([A-Za-z]+)\s*[:=]\s*([\s\S]*)$/.exec(segment);
    const name = m?.[1].toLowerCase();
    if (m && name !== undefined && FIELD_NAMES.has(name)) {
      fields.push({ field: name as FretishField, value: m[2].trim() });
      // `response = …` IS the body, so it is both a field and the text to check.
      if (name === 'response') rest.push(m[2].trim());
      continue;
    }
    rest.push(segment.trim());
  }
  return { fields, body: rest.join('; ').trim() };
}

/* ──────────────────────────── back-translation ──────────────────────────── */

const COMPARISON_ENGLISH: Readonly<Record<string, string>> = {
  '<': 'is less than',
  '<=': 'is at most',
  '>': 'is greater than',
  '>=': 'is at least',
  '==': 'equals',
  '=': 'equals',
  '!=': 'differs from',
};

const ARITHMETIC_ENGLISH: Readonly<Record<string, string>> = {
  '+': 'plus',
  '-': 'minus',
  '*': 'times',
  '/': 'divided by',
  '%': 'modulo',
  '^': 'raised to the power of',
};

/**
 * The AST as structured English.
 *
 * `cosler-2023`'s sub-translation traceability is the point: the reader is shown,
 * in words, the formula the tool would hand a solver, so a clause that parses and
 * says the wrong thing is visible BEFORE it is proved. It is the only defence
 * this tool has against a plausible-but-wrong formalisation, which is why every
 * report carries it and why nothing in this module claims the clause and the
 * prose agree.
 *
 * Every arithmetic operand of a comparison is parenthesised, whatever its
 * precedence: `uav.mtow is at most (uav.battery.mass plus 3)` reads as one
 * quantity, where the same sentence without brackets reads as a comparison
 * against `uav.battery.mass` with a stray `plus 3` after it — and a
 * back-translation that can be misread is worse than none, because it is the
 * thing standing in for the formula.
 *
 * `literals` maps a lowering marker back to what the author wrote: translating
 * the LOWERED node alone would print `2700` for `45.0 [min]`, a number in neither
 * the file nor the author's head.
 */
export function backTranslate(
  node: ExprNode,
  literals: ReadonlyMap<string, LoweredLiteral>,
): string {
  const clause = (n: ExprNode): string => {
    if (n.kind === 'unary' && n.op === 'not') return `it is not the case that ${clause(n.operand)}`;
    if (n.kind === 'binary') {
      const english = COMPARISON_ENGLISH[n.op];
      if (english !== undefined) return `${operand(n.left)} ${english} ${operand(n.right)}`;
      if (n.op === 'and') return `${clause(n.left)}, and ${clause(n.right)}`;
      if (n.op === 'or') return `${clause(n.left)}, or ${clause(n.right)}`;
      if (n.op === 'xor') return `${clause(n.left)}, or ${clause(n.right)}, but not both`;
      if (n.op === 'implies') return `if ${clause(n.left)}, then ${clause(n.right)}`;
    }
    if (n.kind === 'if') {
      return `${clause(n.then)} if ${clause(n.cond)}, and otherwise ${clause(n.else)}`;
    }
    return operand(n);
  };
  /** A comparison's side: bracketed when it is arithmetic, bare when it is a name. */
  const operand = (n: ExprNode): string =>
    n.kind === 'binary' && ARITHMETIC_ENGLISH[n.op] !== undefined ? `(${term(n)})` : term(n);
  const term = (n: ExprNode): string => {
    switch (n.kind) {
      case 'num':
        return String(n.value);
      case 'str':
        return `"${n.value}"`;
      case 'bool':
        return n.value ? 'true' : 'false';
      case 'null':
        return 'null';
      case 'ref': {
        const path = n.path.join('.');
        const literal = literals.get(path);
        return literal ? `${literal.magnitude} ${literal.unit}` : path;
      }
      case 'unary':
        return n.op === 'not'
          ? clause(n)
          : n.op === '-'
            ? `the negation of ${operand(n.operand)}`
            : term(n.operand);
      case 'if':
        return clause(n);
      case 'binary': {
        const english = ARITHMETIC_ENGLISH[n.op];
        if (english === undefined) return clause(n);
        return `${operand(n.left)} ${english} ${operand(n.right)}`;
      }
    }
  };
  return clause(node);
}

/* ─────────────────────────── the insertion range ────────────────────────── */

/** Where the clause would go, and the indentation it would carry. */
interface Insertion {
  range: TextRange | null;
  indent: string;
  note: string;
}

/** A range with no place to point at, and the sentence saying why. */
const noInsertion = (note: string): Insertion => ({ range: null, indent: '    ', note });

/**
 * A zero-width span at the start of the closing-brace line of the body that HOLDS
 * the clauses.
 *
 * Three decisions, each of which was a silent misplacement before it was one.
 *
 *  1. **The span is the CLAUSE HOST's, not the requirement's.** For a case that
 *     is the `objective`, because `clausesOf` reads a case's clauses out of its
 *     objective and a clause anchored on the case's own closing brace lands
 *     outside `objective { … }` — where it parses, binds nothing, and is absent
 *     from the contract with no diagnostic. `clauseHostOf` is the one place that
 *     mapping lives.
 *  2. **Computed from the host's OWN span rather than from its last clause's,**
 *     because a requirement with no clause has no last clause and is exactly the
 *     case an author is drafting for. The closing brace is the anchor: the line
 *     before it is the last line of the body, whatever the body holds.
 *  3. **The anchor is CLAMPED into the body.** When the whole declaration is
 *     written on one line, the closing brace's line START is the declaration's
 *     own line start, which is BEFORE the body and usually before the element —
 *     so the unclamped answer puts the clause in the enclosing package, where it
 *     still parses. A one-line requirement therefore gets the position just
 *     inside its closing brace instead, with a space for an indent.
 */
function insertionFor(model: Model, requirementId: ElementId, opts: PropertyOptions): Insertion {
  const hostId = clauseHostOf(model, requirementId);
  if (hostId === undefined) {
    return noInsertion(
      'no range: this is a case whose `objective` has no body of its own, so there is nothing ' +
        'inside it to point at. Give the case an `objective { … }` — that is where a clause on a ' +
        'case goes.',
    );
  }
  const range = opts.ranges?.get(hostId);
  if (!range) {
    return noInsertion(
      opts.ranges === undefined
        ? 'no range: this call was given no source spans, so there is no text to point into. Pass ' +
            'the `ranges` a `loadModelText` returns, or place the clause yourself — the last line ' +
            'of the requirement body is where it goes.'
        : 'no range: the spans this call was given carry no entry for the body that holds this ' +
            'contract’s clauses, so this tool cannot say where inside it the clause goes.',
    );
  }
  const source = opts.sourceText;
  if (source === undefined) {
    // Spans without text: the POSITION is still exact — it is the line the span
    // ends on — and only the indentation has to be assumed. Unless the span ends
    // on the line it started on, in which case that line is the DECLARATION and
    // pointing at its start would point outside the element; without the text
    // there is no closing brace to find, so this call gets the reason instead.
    const offset = range.end.offset - range.end.column + 1;
    if (offset <= range.start.offset) return noInsertion(ONE_LINE_TEXTLESS);
    const pos = { line: range.end.line, column: 1, offset };
    return {
      range: { start: pos, end: pos },
      indent: '    ',
      note: 'the indentation is assumed (four spaces): this call was given spans but no source text',
    };
  }
  const slice = source.slice(range.start.offset, range.end.offset);
  const close = slice.lastIndexOf('}');
  if (close === -1) {
    // Two different facts, and they take different repairs: a declaration that
    // never opened a brace has no body to put anything in, while one that opened
    // a brace the span does not close is a span that no longer matches the text.
    return noInsertion(
      slice.includes('{')
        ? 'no range: the span opens a brace it never closes, so this tool cannot say where the ' +
            'body ends. The file may have been edited since it was loaded.'
        : 'no range: this requirement has no body — its declaration ends without `{ … }`, so ' +
            'there is nowhere inside it to write a clause. Give it a body, or put the clause on ' +
            'the definition it applies.',
    );
  }
  const closeOffset = range.start.offset + close;
  const lineStart = source.lastIndexOf('\n', closeOffset - 1) + 1;
  if (lineStart <= range.start.offset) {
    // The brace shares its line with the declaration: there is no body line, so
    // the clause goes just inside the brace, on that line.
    const pos = { line: lineAt(source, closeOffset), column: columnAt(source, closeOffset), offset: closeOffset };
    return {
      range: { start: pos, end: pos },
      indent: ' ',
      note:
        'this requirement is written on one line, so it has no body line to insert before: the ' +
        'clause goes just inside its closing brace, on the same line, with a single space in ' +
        'front of it rather than an indent.',
    };
  }
  const braceIndent = /^[ \t]*/.exec(source.slice(lineStart, closeOffset))?.[0] ?? '';
  // The body's own indentation when there is a body, and the brace's plus four
  // spaces when there is not. Copying what is there is what keeps a file looking
  // hand-written after a tool has told somebody where to type.
  const indent = indentOfBody(source, range.start.offset, lineStart) ?? `${braceIndent}    `;
  const pos = { line: lineAt(source, lineStart), column: 1, offset: lineStart };
  return { range: { start: pos, end: pos }, indent, note: '' };
}

/** The one-line case with no text to find the brace in. */
const ONE_LINE_TEXTLESS =
  'no range: this requirement’s span begins and ends on one line, so it has no body line to ' +
  'insert before, and this call was given no source text to find its closing brace in. Pass the ' +
  '`sourceText` those spans are offsets into, or write the clause inside the braces yourself.';

/** The indentation of the last non-blank line of a body, or `undefined` if empty. */
function indentOfBody(source: string, from: number, to: number): string | undefined {
  const lines = source.slice(from, to).split('\n');
  // The first line holds the declaration itself (`requirement def R {`), so it is
  // never the body's indentation.
  for (let i = lines.length - 1; i >= 1; i -= 1) {
    if (lines[i].trim() === '') continue;
    return /^[ \t]*/.exec(lines[i])?.[0] ?? '';
  }
  return undefined;
}

/** The 1-based line number an offset sits on. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

/** The 1-based column an offset sits at. */
function columnAt(source: string, offset: number): number {
  return offset - (source.lastIndexOf('\n', offset - 1) + 1) + 1;
}

/* ────────────────────────────── gate plumbing ───────────────────────────── */

const GATE_NAMES = [
  'encodable fragment',
  'parses',
  'resolves in the subject scope',
  'dimensionally consistent',
  'non-trivial on its own',
] as const;

/** The five gate rows, with everything past `rows.length` marked not run. */
function fillGates(rows: GateResult[]): GateResult[] {
  return GATE_NAMES.map(
    (name, gate) =>
      rows[gate] ?? {
        gate,
        name,
        status: 'not-run' as const,
        detail: 'not run: an earlier gate refused the clause',
      },
  );
}

/** A gate row that passed. */
const passed = (gate: number, detail: string): GateResult => ({
  gate,
  name: GATE_NAMES[gate],
  status: 'passed',
  detail,
});

/** Nearest names by edit distance, for the sentence refusing an unresolved one. */
function nearest(name: string, candidates: readonly string[]): string[] {
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const scored = candidates
    .map((candidate) => ({
      candidate,
      // A name whose LAST segment matches a dictionary entry's is the commonest
      // mistake by a wide margin (`endurance` for `uav.endurance`), so it
      // outranks anything the edit distance finds.
      d: candidate.endsWith(`.${bare}`) ? 0 : distance(name, candidate),
    }))
    .sort((a, b) => a.d - b.d || a.candidate.localeCompare(b.candidate));
  return scored
    .filter((s) => s.d <= Math.max(3, Math.ceil(name.length / 2)))
    .slice(0, 3)
    .map((s) => s.candidate);
}

/** Levenshtein distance, two rows rather than a matrix. */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Every dotted path an expression names, in first-seen order. */
function pathsOf(node: ExprNode): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'ref': {
        const path = n.path.join('.');
        if (!seen.has(path)) {
          seen.add(path);
          out.push(path);
        }
        return;
      }
      case 'unary':
        walk(n.operand);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'if':
        walk(n.cond);
        walk(n.then);
        walk(n.else);
        return;
      default:
        return;
    }
  };
  walk(node);
  return out;
}

/* ──────────────────────────────── the check ─────────────────────────────── */

/**
 * The clause, put through gate 0 and the four judging gates.
 *
 * Nothing is written back: the report says whether the clause would be accepted
 * and where it would go, and the agent is what edits the file. See the file
 * header for why gate 3 runs over a clone and what gate 4 does and does not
 * establish.
 */
export async function propertyCheck(
  model: Model,
  requirementId: ElementId,
  clause: string,
  opts: PropertyOptions = {},
): Promise<PropertyCheckReport> {
  const contract = contractOf(model, requirementId);
  if (!contract) throw new PropertyRefError(refRefusal(model, requirementId));
  const subject = contract.subject;
  const component = subject?.name || contract.declaredName || contract.qualifiedName;
  const parsed = parseClause(clause);

  /** Everything a report carries whatever the gates decided. */
  const base = {
    requirement: refOf(contract),
    shortId: requirementShortId(model, requirementId),
    subject,
    clause,
    body: parsed.body,
    fields: parsed.fields,
    limits: PROPERTY_LIMITS,
    notice: MEANING_NOTICE,
  };
  /** A refusal: the gate that stopped it, and nothing placed in the file. */
  const refuse = (
    rows: GateResult[],
    code: string,
    detail: string,
    extra: Partial<PropertyCheckReport> = {},
  ): PropertyCheckReport => ({
    ...base,
    outcome: 'refused',
    refusedAt: rows.length - 1,
    code,
    detail,
    expected: [],
    gates: fillGates([
      ...rows.slice(0, -1),
      { gate: rows.length - 1, name: GATE_NAMES[rows.length - 1], status: 'refused', detail },
    ]),
    reads: [],
    backTranslation: null,
    range: null,
    insertion: null,
    indent: '    ',
    rangeNote: 'no range: the clause was refused, and a refused clause is not placed.',
    solver: { version: null, detail: 'gate 4 was not reached' },
    ...extra,
  });

  /* ── gate 0: the encodable fragment ────────────────────────────────────── */
  const temporal = parsed.fields.find((f) => {
    if (f.field !== 'scope' && f.field !== 'condition' && f.field !== 'timing') return false;
    const allowed = STATIC_READING[f.field];
    return allowed === null || f.value.toLowerCase() !== allowed;
  });
  if (temporal) {
    const field = temporal.field as (typeof TEMPORAL_FIELDS)[number];
    return refuse(
      [{ gate: 0, name: GATE_NAMES[0], status: 'refused', detail: '' }],
      PROPERTY_CODES.temporal,
      `refused at gate 0: \`${field} = ${temporal.value}\` is temporal — ${TEMPORAL_FRAGMENT}; ` +
        `${TEMPORAL_REASON[field]}`,
    );
  }
  const written = parsed.fields.map((f) => f.field);
  const gates: GateResult[] = [
    passed(
      0,
      written.length === 0
        ? 'in the encodable fragment: no temporal field is written, so the clause reads as an ' +
          'invariant over the values the model admits'
        : `in the encodable fragment: ${written.join(', ')} written, none of them temporal`,
    ),
  ];

  /* ── gate 1: it parses ─────────────────────────────────────────────────── */
  if (parsed.body === '') {
    return refuse(
      [...gates, blank(1)],
      PROPERTY_CODES.unsupported,
      'refused at gate 1: the clause states no response — there is nothing to parse',
    );
  }
  const body = parseRelationBody(parsed.body);
  if (!body) {
    return refuse(
      [...gates, blank(1)],
      PROPERTY_CODES.unsupported,
      `refused at gate 1: \`${parsed.body}\` is not an expression this tool can read`,
    );
  }
  if (body.hadUnit && !body.resolved) {
    return refuse(
      [...gates, blank(1)],
      PROPERTY_CODES.unsupported,
      'refused at gate 1: a `[unit]` literal in the clause names a unit nothing can convert, sits ' +
        'on an offset scale, or is written on something other than a literal, so the clause ' +
        'cannot be read in one system of units',
    );
  }
  gates.push(passed(1, 'parses as a quantifier-free relation'));
  const english = `${component} shall satisfy: ${backTranslate(body.node, body.literals)}`;

  /* ── gate 2: every name resolves in the subject scope ──────────────────── */
  const dictionary = dictionaryFor(model, requirementId, subject);
  const legal = new Map(dictionary.map((d) => [d.name, d]));
  const names = pathsOf(body.node).filter((p) => !body.literals.has(p));
  const unresolved = names.filter((p) => !legal.has(p));
  if (unresolved.length > 0) {
    const suggested = unresolved.flatMap((n) => nearest(n, [...legal.keys()]));
    const expected = suggested.filter((s, i) => suggested.indexOf(s) === i).slice(0, 3);
    return refuse(
      [...gates, blank(2)],
      PROPERTY_CODES.unresolved,
      `refused at gate 2: \`${unresolved.join('`, `')}\` ` +
        `${unresolved.length === 1 ? 'does' : 'do'} not resolve in the scope of \`${component}\`` +
        (expected.length > 0 ? ` — did you mean \`${expected.join('` or `')}\`?` : '.') +
        ' A property clause names its features through the subject; run `property-draft` for the ' +
        'dictionary of every legal name.',
      { expected, backTranslation: english },
    );
  }
  const reads = names.map((name) => ({
    name,
    qualifiedName: legal.get(name)?.qualifiedName ?? name,
  }));
  gates.push(
    passed(2, `resolves ${names.length}/${names.length} name(s) in the scope of \`${component}\``),
  );

  /* ── gate 3: the unit gates agree ──────────────────────────────────────── */
  // On a CLONE, owned by the requirement so the scope is the subject's — see the
  // file header for why the caller's model is never written to.
  const scratch = model.clone();
  if (!scratch.get(requirementId)) {
    throw new PropertyRefError(
      `\`${base.requirement.qualifiedName}\` did not survive the clone this check runs over; ` +
        'this is a tool defect, not something the clause did',
    );
  }
  const transient = scratch.create('ConstraintUsage', {
    ownerId: requirementId,
    attrs: { expression: parsed.body },
  });
  const quantity = evaluateConstraintQuantityDetailed(scratch, transient);
  if (quantity.verdict === 'unknown' && isRefusalReason(quantity.reason)) {
    const clash = quantity.reason === 'dimension-clash' || quantity.reason === 'dimension-fault';
    return refuse(
      [...gates, blank(3)],
      clash ? PROPERTY_CODES.dimension : PROPERTY_CODES.unsupported,
      `refused at gate 3: ${quantity.detail ?? 'the operands do not agree dimensionally'}`,
      { reads, backTranslation: english },
    );
  }
  // The same reading the SMT engine encodes, through the same gates: a clause
  // this accepted and `readRelation` refused would be one `verify` then refuses.
  const reading = readRelation(scratch, transient, parsed.body, new Map());
  if (reading.encodable !== true) {
    const clash = reading.encodable.reason === 'dimension-clash';
    return refuse(
      [...gates, blank(3)],
      clash ? PROPERTY_CODES.dimension : PROPERTY_CODES.unsupported,
      `refused at gate 3 (${reading.encodable.reason}): ${reading.encodable.detail}`,
      { reads, backTranslation: english },
    );
  }
  gates.push(
    passed(
      3,
      'dimensionally consistent under the same unit gates the numeric surface applies; the ' +
        `relation is in ${reading.fragment === 'qf-nra' ? 'QF_NRA' : 'QF_LRA'}`,
    ),
  );

  /* ── gate 4: syntactic non-triviality ──────────────────────────────────── */
  const gate4 = await nonTriviality(reading, base.shortId || base.requirement.qualifiedName, opts);
  if (gate4.row.status === 'refused') {
    return refuse([...gates, gate4.row], gate4.code ?? PROPERTY_CODES.trivial, gate4.row.detail, {
      reads,
      backTranslation: english,
      solver: gate4.solver,
    });
  }
  gates.push(gate4.row);
  const where = insertionFor(model, requirementId, opts);
  return {
    ...base,
    outcome: gate4.row.status === 'passed' ? 'accepted' : 'accepted-with-gap',
    refusedAt: null,
    code: gate4.code,
    detail:
      gate4.row.status === 'passed'
        ? `accepted: parses, resolves ${names.length}/${names.length} name(s), dimensionally ` +
          'consistent, non-trivial on its own'
        : gate4.row.detail,
    expected: [],
    gates: fillGates(gates),
    reads,
    backTranslation: english,
    range: where.range,
    insertion: `require constraint { ${parsed.body} }`,
    indent: where.indent,
    rangeNote: where.note,
    solver: gate4.solver,
    limits: PROPERTY_LIMITS,
    notice: MEANING_NOTICE,
  };
}

/** A placeholder row for the gate about to be filled in by {@link refuse}. */
const blank = (gate: number): GateResult => ({
  gate,
  name: GATE_NAMES[gate],
  status: 'refused',
  detail: '',
});

/** Gate 4's outcome, the code that goes with it, and what answered it. */
interface Gate4 {
  row: GateResult;
  code: string | null;
  solver: { version: string | null; detail: string };
}

/**
 * Clause satisfiable and negation satisfiable, under z3, with no axioms.
 *
 * Two checks rather than one because they refuse different clauses: a clause
 * nothing satisfies (`x > 1 and x < 0`) is as useless as one everything
 * satisfies (`x <= x`), and only the second is what a reader thinks of as
 * "trivial". Both are `verification/trivial-property` with the direction named,
 * because the repair differs.
 *
 * With no solver the gate is `not-run` and the clause is `accepted-with-gap`. It
 * is NOT a pass: an unchecked gate that printed "accepted" would be a missing
 * tool producing a green answer, which is the failure this whole lane is written
 * against.
 */
async function nonTriviality(
  reading: RelationReading,
  label: string,
  opts: PropertyOptions,
): Promise<Gate4> {
  const free = new Set(reading.variables.map((v) => v.path));
  const variables = encodeVariablesOf(reading, free);
  const encoded = reading.node === null ? null : encodeRelation(reading.node, variables);
  if (encoded === null || !encoded.ok) {
    return {
      row: {
        gate: 4,
        name: GATE_NAMES[4],
        status: 'refused',
        detail:
          encoded === null
            ? 'refused at gate 4: the clause has no encodable reading'
            : `refused at gate 4 (${encoded.refusal.reason}): ${encoded.refusal.detail}`,
      },
      code: PROPERTY_CODES.unsupported,
      solver: { version: null, detail: 'the clause never reached a solver' },
    };
  }
  const z3 = await loadZ3();
  if (z3.absent) {
    return {
      row: {
        gate: 4,
        name: GATE_NAMES[4],
        status: 'not-run',
        detail: `accepted with a gap: non-triviality not checked (z3 absent) — ${z3.reason}`,
      },
      code: PROPERTY_CODES.unchecked,
      solver: { version: null, detail: z3.reason },
    };
  }
  const solver = { version: z3.version, detail: `${z3.fullVersion} (WASM), seed ${z3.seed}` };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const script = (term: string): string =>
    encodeScript({
      variables,
      assertions: [{ kind: 'goal', name: label, term }],
      nonlinear: encoded.nonlinear,
      syntacticNonlinear: encoded.syntacticNonlinear,
      cores: false,
    }).text;

  const positive = await z3.check(script(encoded.term), { timeoutMs });
  if (positive.status === 'unsat') {
    return {
      row: {
        gate: 4,
        name: GATE_NAMES[4],
        status: 'refused',
        detail:
          'refused at gate 4: the clause is unsatisfiable on its own — no assignment of the ' +
          'features it reads makes it true, with no axiom asserted, so it can never be ' +
          'discharged. Check the relation’s direction and its bounds.',
      },
      code: PROPERTY_CODES.trivial,
      solver,
    };
  }
  if (positive.status !== 'sat') {
    return { row: undecided(positive.status, positive.reason, timeoutMs, 'the clause'), code: PROPERTY_CODES.unchecked, solver };
  }
  const negated = await z3.check(script(notTerm(encoded.term)), { timeoutMs });
  if (negated.status === 'unsat') {
    return {
      row: {
        gate: 4,
        name: GATE_NAMES[4],
        status: 'refused',
        detail:
          'refused at gate 4: the clause is valid on its own — every assignment of the features ' +
          'it reads makes it true, with no axiom asserted, so proving it would say nothing about ' +
          'this design. State a bound the design has to meet.',
      },
      code: PROPERTY_CODES.trivial,
      solver,
    };
  }
  if (negated.status !== 'sat') {
    return { row: undecided(negated.status, negated.reason, timeoutMs, 'its negation'), code: PROPERTY_CODES.unchecked, solver };
  }
  return {
    row: passed(
      4,
      'non-trivial on its own: the clause and its negation are both satisfiable with no axioms ' +
        'asserted',
    ),
    code: null,
    solver,
  };
}

/** A gate-4 check that came back undecided, which is a gap and never a pass. */
function undecided(status: string, reason: string, timeoutMs: number, which: string): GateResult {
  return {
    gate: 4,
    name: GATE_NAMES[4],
    status: 'not-run',
    detail:
      `accepted with a gap: non-triviality not checked — the solver answered \`${status}\` on ` +
      `${which} within ${timeoutMs} ms${reason ? ` (${reason})` : ''}`,
  };
}

/**
 * The verification lane's reporting surface: `contractReport`,
 * `obligationsReport` — and `verifyModel`, which is the one that judges.
 *
 * THE CHARTER OF THIS LANE, IN ONE LINE: **encode after the gates; report what
 * the gates refuse.** It is the same sentence that heads
 * `src/semantics/relations.ts`, restated here because this file is the door
 * every consumer comes through and the invariant has to be legible at the door.
 * What follows from it, and what nothing in this lane may break:
 *
 *  - **The two REPORT commands report STRUCTURE, never truth.** They may say how
 *    many contracts there are, on how many subjects, and which fragment each
 *    relation lands in. They may never say satisfied, proved, consistent, or
 *    anything about whether a requirement holds. There is no solver behind
 *    them: `verify` is a separate command, with a separate exit contract, and
 *    it is the only function here that reaches a verdict.
 *  - **A relation a gate refuses is LISTED with its reason, never omitted.**
 *    A relation that disappears from a worklist reads as one that holds, which
 *    is the failure direction this whole lane exists to avoid. Every refusal
 *    carries a branchable `reason` and a sentence a person can act on.
 *  - **An empty inventory is stated, never rendered as zero problems.** A model
 *    with requirements and no contracts is a finding about the reader's model
 *    or about this tool, and either way they have to be told.
 *  - **`discharged` and `stale` on a WORKLIST row are read back from an evidence
 *    record**, never computed by `obligationsReport`. `verifyModel` is what
 *    produces the record; reading it back into the worklist is a later commit,
 *    so `obligationsOf` still returns neither.
 *  - **One diagnostic source and one prefix for the whole lane**:
 *    `verification/*`, under the single `DiagnosticSource` `'verification'`.
 *    Four sources for one lane would let a consumer filter three of them and
 *    miss the fourth.
 *
 * The reports are the siblings of `constraintReport` (`./analytics`) in SHAPE —
 * plain, JSON-serialisable data with a navigable reference per row — and
 * deliberately not in LOCATION: `constraintReport` evaluates and these do not,
 * and a reader who found them in the same module would reasonably assume they
 * answer the same kind of question.
 */

import type { ElementId, Model } from '@core/index';
import type { Diagnostic } from '@validation/types';
import {
  contractsOf,
  isUserModelElement,
  type Contract,
  type ContractRef,
  type ContractSubject,
  type Refusal,
} from '../semantics/contracts';
import {
  foreignKeyword,
  isSysproseVocabulary,
  keywordsOnRecord,
  resolveKeyword,
} from '../semantics/keywords';
import {
  isNonNormativeStatement,
  statementKindOfKeyword,
  STATEMENT_KIND_PACKAGE,
} from '../semantics/statement-kind';
import {
  obligationsOf,
  type Obligation,
  type ObligationOptions,
  type ObligationStatus,
} from '../semantics/obligations';
import {
  judgeLiterally,
  type LiteralOutcome,
  type PremiseReading,
  type ValueBinding,
} from '../semantics/engines/literal';
import {
  modelVersionOf,
  obligationDigest,
  recordEvidence,
  verdictFor,
  type EvidenceBound,
  type EvidenceClaim,
  type EvidenceRecord,
  type EvidenceVerdict,
  type ModelVersion,
} from './evidence';

/* ─────────────────────────── the contract report ─────────────────────────── */

/** How the inventory may be narrowed. */
export interface ContractReportOptions {
  /** Restrict to contracts at or under this element. */
  scopeId?: ElementId;
  /**
   * Also inventory the `#keyword` vocabulary the file carries.
   *
   * Off by default, and the two codes it produces —
   * `verification/foreign-keyword` and `verification/keyword-names-nothing` —
   * are produced HERE and nowhere else. `npm run check` does not judge a
   * keyword: the 24 validation rules, the checker's exit contract and the
   * fixture corpus are untouched by anything in this option, which is what
   * makes reading somebody else's vocabulary free of consequence.
   */
  keywords?: boolean;
}

/**
 * Is this contract at or under the scope the caller asked for?
 *
 * Scoping is CONTAINMENT, the same reading `--element` has everywhere else in
 * this tool: a reference naming a package answers for the requirements inside
 * it, and one naming a requirement answers for that requirement.
 */
function inScope(model: Model, scopeId?: ElementId): (id: ElementId) => boolean {
  if (!scopeId) return () => true;
  const ids = new Set<ElementId>([scopeId]);
  for (const d of model.descendants(scopeId)) ids.add(d.id);
  return (id) => ids.has(id);
}

/** The inventory, with the figures a reader needs to know what it left out. */
export interface ContractReport {
  contracts: Contract[];
  /** How many contracts were found. */
  total: number;
  /** How many distinct subjects they are about. */
  subjects: number;
  /** How many contracts carry no clause at all — the `no formal clause` rows. */
  noFormalClause: number;
  /** Guarantees by fragment. The three add up to the guarantee count. */
  guaranteesQfLra: number;
  guaranteesQfNra: number;
  guaranteesUnsupported: number;
  /** How many assumptions the whole inventory carries. */
  assumptions: number;
  /** How many requirement-shaped statements were dropped as `#prose` / `#prompt`. */
  nonNormativeExcluded: number;
  /** Bundled standard-library requirements left out of every figure above. */
  libraryExcluded: number;
  /** Re-derived (usage-scoped) copies left out. */
  implicitExcluded: number;
  /**
   * Every `#keyword` in scope with what it resolves to — empty unless
   * {@link ContractReportOptions.keywords} asked for it.
   *
   * An INVENTORY. Nothing in it changes a contract, a clause or an obligation:
   * a reader who sees `#Exception` here has been told what this tool would make
   * of it, not what it made of it.
   */
  keywords: KeywordUse[];
  /**
   * Was the inventory asked for? A consumer needs to tell "no keyword in this
   * model" from "nobody asked", and an empty array says both.
   */
  keywordsAsked: boolean;
  /** What this lane noticed on the way past — always `source: 'verification'`. */
  diagnostics: Diagnostic[];
}

/* ────────────────────────── the keyword inventory ────────────────────────── */

/** Whose vocabulary a keyword belongs to. */
export type KeywordOrigin =
  /** A definition Sysprose ships: `SysproseVerification`, `SysproseStatements`. */
  | 'sysprose'
  /** A third-party spelling this tool recognises through the alias table. */
  | 'foreign'
  /** Something else that really resolves — the model's own, or the library's. */
  | 'other'
  /** It names no `metadata def` in scope. */
  | 'unresolved';

/** One use of one keyword, with what it resolves to. */
export interface KeywordUse {
  /** The keyword exactly as written after the `#`. */
  keyword: string;
  /** The element it is written on. */
  element: ContractRef;
  /** The `metadata def` it names, or `null` when it names none. */
  resolvedTo: {
    id: ElementId;
    qualifiedName: string;
    declaredName?: string;
    /** The short name, which is the keyword spelling the definition declares. */
    shortName?: string;
  } | null;
  origin: KeywordOrigin;
  /**
   * For a third-party spelling: what this tool would read it as, and the
   * provenance sentence that must be printed wherever that reading is used.
   * `null` for every other origin.
   */
  foreign: { readAs: string; note: string } | null;
  /**
   * For a Sysprose keyword recognised by its SPELLING rather than by
   * resolution: the package whose `metadata def` would bind it. `null`
   * otherwise, including for a Sysprose keyword that does resolve.
   *
   * `#prose` and `#prompt` are the reason this field exists. A statement kind
   * is read from the spelling alone — `statement-kind.ts` says so in its own
   * header, the guide tells authors the tag "works whether or not the
   * definitions are in your file", and every rule in the tool honours that — so
   * a file written exactly as documented declares no `SysproseStatements`
   * package and the keyword resolves to nothing. Classifying that as
   * `unresolved` put `verification/keyword-names-nothing` against `#prose` in
   * the same report whose census line said one statement had been left out
   * BECAUSE of it, and sent the reader hunting for a misspelling in a tag the
   * tool had acted on.
   */
  readBySpelling: { package: string } | null;
}

/**
 * Every keyword in scope, in the model's own order.
 *
 * Classified into exactly ONE origin per use, because a row that was both
 * "third-party" and "names nothing" would ask the reader to decide which of the
 * two this tool acted on. The alias table wins that tie: for `#Exception` the
 * tool DOES know what the file meant, and saying only that it names nothing
 * would hide the reading that `obligations --from-keywords` and (later)
 * `check-behaviour --from-keywords` would act on.
 *
 * Resolution wins over the shipped vocabulary in the other direction: a model
 * that declares its own `metadata def <exceptional>` in its own package is
 * reported as using its own, because it is. A foreign SPELLING that also
 * resolves keeps both facts — the origin says the spelling is one this tool
 * acts on, `resolvedTo` says what the model itself named — and the renderer
 * prints both, because dropping the second would tell a reader their own
 * definition had been ignored.
 *
 * The last arm before `unresolved` is the statement-kind vocabulary, and it is
 * there because this tool reads `#prose` / `#prompt` / `#'requirement'` from the
 * SPELLING and always has: they classify a statement whether or not
 * `SysproseStatements` is in the file, which is what keeps every model written
 * before that package existed classified the way it was. A keyword the tool
 * acts on is not a keyword that "names nothing", so it is `sysprose` with
 * {@link KeywordUse.readBySpelling} saying how it was recognised — and it
 * raises no `verification/keyword-names-nothing`.
 */
function keywordUses(model: Model, scoped: (id: ElementId) => boolean): KeywordUse[] {
  const out: KeywordUse[] = [];
  for (const el of model.all()) {
    if (!isUserModelElement(model, el) || !scoped(el.id)) continue;
    for (const keyword of keywordsOnRecord(el)) {
      const def = resolveKeyword(model, keyword);
      const alias = foreignKeyword(keyword);
      // Only when nothing resolved: a model that declares its own
      // `metadata def <prose>` is using its own vocabulary, and `resolvedTo`
      // has to be free to say so.
      const bySpelling =
        !alias && !def && statementKindOfKeyword(keyword.written) !== undefined;
      const origin: KeywordOrigin = alias
        ? 'foreign'
        : def
          ? isSysproseVocabulary(model, def)
            ? 'sysprose'
            : 'other'
          : bySpelling
            ? 'sysprose'
            : 'unresolved';
      out.push({
        keyword: keyword.written,
        element: {
          id: el.id,
          eClass: el.eClass,
          ...(el.declaredName !== undefined ? { declaredName: el.declaredName } : {}),
          qualifiedName: model.qualifiedName(el.id),
        },
        resolvedTo: def
          ? {
              id: def.id,
              qualifiedName: model.qualifiedName(def.id),
              ...(def.declaredName !== undefined ? { declaredName: def.declaredName } : {}),
              ...(def.declaredShortName !== undefined
                ? { shortName: def.declaredShortName }
                : {}),
            }
          : null,
        origin,
        foreign: alias
          ? {
              readAs:
                alias.reads.as === 'keyword'
                  ? `\`${alias.reads.keyword}\``
                  : // `an assume clause`, but `a require clause`: the string is
                    // read inside a sentence, and the article is chosen on the
                    // word rather than on the backtick in front of it.
                    `${alias.reads.role === 'assume' ? 'an' : 'a'} \`${alias.reads.role}\` clause`,
              note: alias.note,
            }
          : null,
        readBySpelling: bySpelling ? { package: STATEMENT_KIND_PACKAGE } : null,
      });
    }
  }
  return out;
}

/**
 * Every contract in the user's model, with the census of what was excluded.
 *
 * The exclusion figures are not decoration: every other report in this
 * repository states its own, because a number that silently drops a population
 * is a number nobody can check. Here they answer the two questions a reader of
 * an empty inventory asks first — was my requirement dropped as library
 * content, and was it dropped because somebody tagged it `#prose`?
 */
export function contractReport(model: Model, opts: ContractReportOptions = {}): ContractReport {
  const scoped = inScope(model, opts.scopeId);
  const keywords = opts.keywords === true ? keywordUses(model, scoped) : [];
  const contracts = contractsOf(model).filter((c) => scoped(c.id));
  const guarantees = contracts.flatMap((c) => c.guarantees);
  const subjects = new Set(
    contracts
      .map((c) => (c.subject ? subjectKey(c.subject) : null))
      .filter((s): s is string => s !== null),
  );
  // Scoped like everything else in the report. A census taken over the whole
  // model beside a listing taken over one package answers two questions in one
  // block, and a reader has no way to tell which of the two a line belongs to.
  const requirementShaped = model
    .all()
    .filter(
      (el) =>
        (el.eClass === 'RequirementDefinition' || el.eClass === 'RequirementUsage') &&
        scoped(el.id),
    );
  return {
    contracts,
    total: contracts.length,
    subjects: subjects.size,
    // A usage that inherits its definition's clauses HAS a body; it does not
    // own one. Counting it here would say "prose only" about a requirement with
    // a constraint.
    noFormalClause: contracts.filter(
      (c) => c.assumptions.length + c.guarantees.length === 0 && c.clausesInheritedFrom.length === 0,
    ).length,
    guaranteesQfLra: guarantees.filter((g) => g.fragment === 'qf-lra').length,
    guaranteesQfNra: guarantees.filter((g) => g.fragment === 'qf-nra').length,
    guaranteesUnsupported: guarantees.filter((g) => g.encodable !== true).length,
    assumptions: contracts.reduce((n, c) => n + c.assumptions.length, 0),
    nonNormativeExcluded: requirementShaped.filter(
      (el) => isUserModelElement(model, el) && isNonNormativeStatement(model, el.id),
    ).length,
    libraryExcluded: requirementShaped.filter((el) => el.attrs.isLibrary === true).length,
    implicitExcluded: requirementShaped.filter(
      (el) => el.attrs.isLibrary !== true && !isUserModelElement(model, el),
    ).length,
    keywords,
    keywordsAsked: opts.keywords === true,
    diagnostics: numbered([
      ...verificationFindings(model, contracts, scoped),
      ...keywordFindings(keywords),
    ]),
  };
}

/**
 * The key two contracts share when they are about the SAME subject.
 *
 * On the resolved type's element id rather than on its printed name: two
 * packages may each declare a `part def Sys`, and a census keyed on
 * `"u"` + `Sys` reports one subject where the model has two. The separator is
 * the NUL escape `\0` rather than a literal NUL byte, which would make this
 * file BINARY to git and to grep. The display strings
 * are the fallback for a subject the standard supplies (`Case::result`), which
 * resolves to no element in the user's file.
 */
function subjectKey(subject: ContractSubject): string {
  return `${subject.name}\0${subject.typeId ?? subject.typeRef ?? ''}`;
}

/* ────────────────────────── the obligation report ────────────────────────── */

/** The worklist, with the histogram `--missing` prints. */
export interface ObligationReport {
  obligations: Obligation[];
  total: number;
  byRole: { axiom: number; premise: number; obligation: number };
  byStatus: Record<ObligationStatus, number>;
  /** The rows this lane would not decide: `no-formal-clause` + `not-encodable`. */
  missing: number;
  /** How many refused relations there are, by the gate that refused them. */
  refusedByReason: Record<string, number>;
  /** Whether the worklist was narrowed to the `--missing` rows. */
  missingOnly: boolean;
  /**
   * Whether a third-party `#precondition` / `#postcondition` was allowed to
   * file a row. Off by default, published so a consumer reading the worklist
   * back can tell which of the two worklists it is holding.
   */
  fromKeywords: boolean;
  /**
   * How many rows a keyword actually filed — over the WHOLE worklist in scope,
   * like `total`, `byRole` and `byStatus`, and unlike the possibly narrowed
   * {@link obligations} listing.
   *
   * Published rather than left to the caller because the caller got it wrong:
   * counting the listing under `--missing` printed "0 row(s) filed by a
   * keyword" on a report whose own histogram counted the premise that keyword
   * filed and whose own diagnostic named it. One report contradicting itself in
   * three lines is worse than not printing the figure at all.
   */
  filedByKeyword: number;
  diagnostics: Diagnostic[];
}

/**
 * The worklist over a model, or over one element of it.
 *
 * `missing` counts the rows this lane would NOT decide even with every solver
 * installed, and it is the figure §6 calls the deliverable that measures
 * encodability. It is reported whether or not the caller asked for the narrowed
 * listing, so a reader who did not pass `--missing` still learns how much of
 * their model is out of reach.
 */
export function obligationsReport(model: Model, opts: ObligationOptions = {}): ObligationReport {
  const scoped = inScope(model, opts.scopeId);
  const obligations = obligationsOf(model, opts);
  // The histogram is over the WHOLE worklist in scope, never over the narrowed
  // listing: a `--missing` run that reported "2 of 2 missing" would be true of
  // its own filter and false of the model.
  const all = opts.missing ? obligationsOf(model, { ...opts, missing: false }) : obligations;
  const byStatus: Record<ObligationStatus, number> = {
    open: 0,
    discharged: 0,
    stale: 0,
    'no-formal-clause': 0,
    'not-encodable': 0,
  };
  for (const o of all) byStatus[o.status]++;
  const refusedByReason: Record<string, number> = {};
  for (const o of all) {
    if (o.encodable === true) continue;
    const reason = (o.encodable as Refusal).reason;
    refusedByReason[reason] = (refusedByReason[reason] ?? 0) + 1;
  }
  return {
    obligations,
    total: all.length,
    byRole: {
      axiom: all.filter((o) => o.role === 'axiom').length,
      premise: all.filter((o) => o.role === 'premise').length,
      obligation: all.filter((o) => o.role === 'obligation').length,
    },
    byStatus,
    missing: byStatus['no-formal-clause'] + byStatus['not-encodable'],
    refusedByReason,
    missingOnly: opts.missing === true,
    fromKeywords: opts.fromKeywords === true,
    filedByKeyword: all.filter((o) => o.provenance).length,
    diagnostics: numbered([
      ...verificationFindings(model, contractsOf(model).filter((c) => scoped(c.id)), scoped),
      // Only the keywords that actually MOVED a row. `contracts --keywords` is
      // the inventory; a worklist reports the vocabulary it acted on, and
      // saying nothing here would be this lane letting a foreign spelling
      // change what must be shown in silence.
      ...contributingKeywordFindings(all),
    ]),
  };
}

/* ─────────────────────────────── diagnostics ─────────────────────────────── */

/** A finding before it is given its place in the lane's one numbering. */
type Finding = Omit<Diagnostic, 'id' | 'ruleId' | 'source'>;

/**
 * One numbering and one source for whatever produced the findings.
 *
 * Two producers that each numbered from zero would publish two `verification#0`
 * rows in one report, and a consumer keying on the id would silently keep one
 * of them.
 */
function numbered(findings: readonly Finding[]): Diagnostic[] {
  return findings.map((d, i) => ({
    id: `verification#${i}`,
    ruleId: 'verification',
    source: 'verification',
    ...d,
  }));
}

/**
 * What the inventory noticed: a third-party spelling, and a keyword that names
 * nothing.
 *
 * Both INFO, and neither is a defect in the model. A foreign keyword is a file
 * written for another tool, which is the case this reader exists for; a keyword
 * that names nothing may be a misspelling, or a vocabulary the file simply
 * never imports. Emitted only when the inventory was asked for, so a keyword
 * can never change what `npm run check` says about a file.
 */
function keywordFindings(uses: readonly KeywordUse[]): Finding[] {
  const out: Finding[] = [];
  for (const use of uses) {
    if (use.origin === 'foreign' && use.foreign) {
      out.push({
        severity: 'info',
        message: `\`#${use.keyword}\` on ${use.element.qualifiedName} is ${use.foreign.note}.`,
        elementId: use.element.id,
        elementName: use.element.qualifiedName,
        code: 'verification/foreign-keyword',
        hint: `It is read as ${use.foreign.readAs} only where a command asks for it (\`obligations --from-keywords\`); this row is an inventory and changes no obligation.`,
      });
    } else if (use.origin === 'unresolved') {
      out.push({
        severity: 'info',
        message: `\`#${use.keyword}\` on ${use.element.qualifiedName} resolves to no metadata definition in scope.`,
        elementId: use.element.id,
        elementName: use.element.qualifiedName,
        code: 'verification/keyword-names-nothing',
        hint: 'Declare or import the `metadata def` the keyword names — `import SysproseVerification::*;` for the one this tool ships — or correct the spelling. The keyword is kept in the file either way, and `npm run check` does not judge it.',
      });
    }
  }
  return out;
}

/**
 * The keywords that actually filed a row, for the worklist that let them.
 *
 * Keyed on the rows rather than on the model, because that is the claim being
 * made: not "this file carries a foreign keyword" (the inventory's job) but
 * "this foreign keyword moved this relation into the worklist". One finding per
 * contributing row, so a reader can match each of them to a line above it.
 */
function contributingKeywordFindings(rows: readonly Obligation[]): Finding[] {
  const out: Finding[] = [];
  for (const row of rows) {
    if (!row.provenance) continue;
    out.push({
      severity: 'info',
      message: `\`#${row.provenance.keyword}\` on ${row.element.qualifiedName} filed this ${row.role} — it is ${row.provenance.note}.`,
      elementId: row.element.id,
      elementName: row.element.qualifiedName,
      code: 'verification/foreign-keyword',
      hint: 'Drop `--from-keywords` and the row goes back to what the notation says it is; write the standard construct (`assume constraint` / `require constraint`) and no keyword is needed at all.',
    });
  }
  return out;
}


/** The metaclasses that own a body the standard admits `assume`/`require` in. */
const CLAUSE_HOSTS = new Set([
  'RequirementDefinition',
  'RequirementUsage',
  'CaseDefinition',
  'CaseUsage',
  'UseCaseDefinition',
  'UseCaseUsage',
  'VerificationCaseDefinition',
  'VerificationCaseUsage',
]);

/**
 * What this lane noticed, as diagnostics nothing writes back into the file.
 *
 * All three are INFO. None of them is a defect in the model: an unsupported
 * expression is a limit of this tool, a contract with no guarantee may be a
 * requirement still being written, and a clause in an action body is notation
 * Sysprose accepts that the standard's `ActionBodyItem` does not admit. They
 * are reported so a reader is never left to infer any of the three from a
 * silence, and they carry `source: 'verification'` so a consumer can filter the
 * whole lane without parsing the code string.
 *
 * `scoped` is the SAME predicate the report's figures use. A finding about an
 * element outside `--element` is a finding about a model the reader did not
 * ask about, printed under a heading that says the report was narrowed.
 */
function verificationFindings(
  model: Model,
  contracts: readonly Contract[],
  scoped: (id: ElementId) => boolean,
): Finding[] {
  const out: Finding[] = [];
  const add = (d: Finding): void => {
    out.push(d);
  };

  for (const contract of contracts) {
    for (const clause of [...contract.assumptions, ...contract.guarantees]) {
      if (clause.encodable === true) continue;
      const refusal = clause.encodable;
      add({
        severity: 'info',
        message: `\`${clause.expression}\` is outside the fragment this lane encodes: ${refusal.detail}.`,
        elementId: clause.id,
        elementName: clause.qualifiedName,
        code: 'verification/unsupported-expression',
        hint: `The relation is listed with its reason rather than dropped; nothing is claimed about it. Rewrite it inside the fragment, or expect \`${refusal.reason}\` in the \`obligations --missing\` histogram.`,
      });
    }
    if (contract.assumptions.length > 0 && contract.guarantees.length === 0) {
      add({
        severity: 'info',
        message: `"${contract.declaredName ?? contract.qualifiedName}" assumes ${contract.assumptions.length} thing(s) and guarantees nothing, so there is nothing to show.`,
        elementId: contract.id,
        elementName: contract.qualifiedName,
        code: 'verification/contract-no-guarantee',
        hint: 'Add a `require constraint { … }` clause stating what the requirement guarantees, or read the assumptions as context rather than as an obligation.',
      });
    }
  }

  for (const el of model.all()) {
    if (!isUserModelElement(model, el) || !scoped(el.id)) continue;
    if (el.eClass !== 'ConstraintUsage') continue;
    const role = el.attrs.requirementRole;
    if (role !== 'assume' && role !== 'require') continue;
    const owner = el.ownerId != null ? model.get(el.ownerId) : undefined;
    if (!owner) continue;
    // A clause inside a case objective is where the standard puts it; a clause
    // on a requirement is its home. Anywhere else — an action body being the
    // case that actually parses today — the notation is this tool's, not the
    // specification's.
    if (CLAUSE_HOSTS.has(owner.eClass)) continue;
    if (owner.eClass === 'ConstraintUsage' && owner.attrs.requirementRole === 'objective') continue;
    add({
      severity: 'info',
      message: `\`${role} constraint\` is written in the body of ${withArticle(readableHost(owner.eClass))}, which Sysprose accepts and the standard's \`ActionBodyItem\` does not admit.`,
      elementId: el.id,
      elementName: model.qualifiedName(el.id),
      code: 'verification/nonstandard-clause-location',
      hint: 'The standard writes a behaviour precondition as `assert constraint precondition { … }`, as a `guard` on the incoming transition, or as a requirement whose `subject` is the behaviour; `contracts` reads all three.',
    });
  }

  return out;
}

/** `a part def`, but `an action def` — the message is a sentence a person reads. */
function withArticle(noun: string): string {
  return `${'aeiou'.includes(noun[0]?.toLowerCase() ?? '') ? 'an' : 'a'} ${noun}`;
}

/** The metaclass, in the words the notation writes it with. */
function readableHost(eClass: string): string {
  switch (eClass) {
    case 'ActionDefinition':
      return 'action def';
    case 'ActionUsage':
      return 'action';
    case 'StateDefinition':
      return 'state def';
    case 'StateUsage':
      return 'state';
    case 'PartDefinition':
      return 'part def';
    case 'PartUsage':
      return 'part';
    default:
      return eClass;
  }
}

/* ══════════════════════════════ verify ═══════════════════════════════════ */

/**
 * `verify` — the only function in this module that reaches a verdict.
 *
 * READ THE EXIT CONTRACT FIRST (`VERIFY_EXIT_CODES` in
 * `scripts/lib/sysprose-spec.ts`, and §2 of the plan). It is the third
 * exit-code contract in this repository and it does not resemble the other two:
 * **1 means refuted**, not "the model did not load cleanly", and **every
 * inconclusive is 2**. A consumer that branched on `sysprose`'s reporting
 * contract here would read a refutation as a parse failure.
 *
 * THE FOUR RULES THIS FUNCTION EXISTS TO ENFORCE, each of which was won at some
 * cost and none of which may be relaxed by a later engine:
 *
 *  1. **A missing solver is never a green build.** `--engine auto` resolves to
 *     `smt` when a backend loads and otherwise emits `verification/tool-absent`
 *     for every obligation ⇒ inconclusive ⇒ exit 2. It NEVER falls back to the
 *     literal engine. A point evaluation is only ever green when it was asked
 *     for by name.
 *  2. **`--allow-inconclusive` is scoped over CODES, not over prose.** It lowers
 *     2 → 0 for {@link ALLOW_INCONCLUSIVE_CODES} and nothing else: never
 *     `tool-absent`, never `vacuous`, never `design-admitted`, and never over a
 *     violation — exit 1 beats it.
 *  3. **The verdict facet is written for two claims only.** `proved` ⇒ `pass`,
 *     `refuted` ⇒ `fail`; everything else writes `inconclusive` and puts the
 *     finer claim in the record. `discharged` is a different question from
 *     `verdict`, and the two are separate fields here for exactly that reason:
 *     under `--engine literal` a `holds-at-values` row IS discharged (the
 *     reader asked for a point evaluation) and its facet is still `inconclusive`.
 *  4. **Vacuity is inconclusive, always, and no flag launders it.** It is this
 *     plan's one declared deviation from the standard's
 *     `allTrue(assumptions) implies allTrue(constraints)` reading (§6, §8.4.17),
 *     recorded in `docs/CONFORMANCE.md`, and it exits 2 with and without
 *     `--allow-inconclusive`.
 */

/** Which engine decides. `auto` picks `smt` when a backend loads, else nothing. */
export type VerifyEngine = 'literal' | 'smt';
export type VerifyEngineOption = 'auto' | VerifyEngine;

/** How a run may be narrowed, and what it is allowed to forgive. */
export interface VerifyOptions {
  /** Default `auto`, which never silently downgrades to `literal`. */
  engine?: VerifyEngineOption;
  /**
   * Feature values to release, by qualified name — an SMT-engine option.
   *
   * The literal engine evaluates AT the model's values, so there is nothing for
   * it to free: asking is a programming error and throws rather than being
   * accepted and ignored. `--free` is also two-sided by rule (§3.4): a freed
   * feature unbounded on either side yields `inconclusive`, never `refuted`.
   */
  free?: readonly string[];
  /** Lower 2 → 0 for the undecided codes only. Never for a violation. */
  allowInconclusive?: boolean;
  /** Restrict to obligations at or under this element. */
  scopeId?: ElementId;
  /** The file's bytes, so the record binds the text as well as the graph. */
  sourceText?: string;
  /** The command a reader could re-run, recorded in every record. */
  producedBy?: string;
}

/**
 * The inconclusive codes `--allow-inconclusive` may lower to 0.
 *
 * Stated as a SET of codes rather than as a sentence, so every gate in the plan
 * can be read against it mechanically. `verification/timeout` is not emitted
 * until the SMT engine lands; it is listed now because the flag's scope is part
 * of the exit contract and a scope that grew quietly with each new engine would
 * be no scope at all.
 */
export const ALLOW_INCONCLUSIVE_CODES: ReadonlySet<string> = new Set([
  'verification/timeout',
  'verification/unsupported-construct',
]);

/** What one obligation came to, and everything a reader needs to argue with it. */
export interface ObligationVerdict {
  requirement: ContractRef | null;
  shortId: string;
  clause: ContractRef;
  expression: string;
  /** The canonical identity of the relation — never an element id. */
  obligationDigest: string;
  claim: EvidenceClaim;
  /** The FACET: `pass` only for `proved`, `fail` only for `refuted`. */
  verdict: EvidenceVerdict;
  /** Does this row count as discharged UNDER THE ENGINE THAT WAS ASKED FOR? */
  discharged: boolean;
  /** The `verification/*` code, for any row that is not decided. */
  code: string | null;
  /** Was this row's contribution to the exit code lowered by `--allow-inconclusive`? */
  forgiven: boolean;
  detail: string;
  /** The assumptions, evaluated before the guarantee. */
  premises: PremiseReading[];
  /**
   * The point, scope or bound the claim holds within.
   *
   * For a point evaluation its `si` slot carries the two magnitudes the
   * comparison was actually made on. That is not decoration: a DERIVED feature
   * stores whatever its own equation produced (uav.endurance stores 0.7877 —
   * hours — beside a requirement written in `[min]`), so a witness read on its
   * own reads as refuting the claim it stands under. The SI pair is the only
   * place a reader can see 2835.7 s against 2700 s and agree with the verdict.
   */
  bound: EvidenceBound;
  /** The model's own values for the features the relation reads. */
  bindings: ValueBinding[];
}

/** What a run came to, with the arithmetic behind its exit code. */
export interface VerifyReport {
  /** What the caller asked for. */
  engineAsked: VerifyEngineOption;
  /** What it resolved to. `auto` resolves to `smt`, never to `literal`. */
  engine: VerifyEngine;
  /** True when the resolved engine could not run at all — every row is `tool-absent`. */
  toolAbsent: boolean;
  results: ObligationVerdict[];
  /** Discharged non-vacuously by the engine that was asked for. */
  discharged: number;
  /** Refuted with every feature at its model value. Nothing else is exit 1. */
  violated: number;
  /** Everything undecided, including vacuous and tool-absent. */
  inconclusive: number;
  /** Refutations obtained under `--free`: a design the model admits, exit 2. */
  designAdmitted: number;
  /** How many inconclusive rows `--allow-inconclusive` lowered. */
  forgiven: number;
  /** How many rows were vacuous — the figure the deviation register is about. */
  vacuous: number;
  exitCode: 0 | 1 | 2;
  allowInconclusive: boolean;
  free: string[];
  modelVersion: ModelVersion;
  /** One record per obligation, ready to write with `--record`. */
  records: EvidenceRecord[];
  diagnostics: Diagnostic[];
}

/** The claim each engine accepts as a discharge. Nothing else counts. */
const DISCHARGES: Record<VerifyEngine, ReadonlySet<EvidenceClaim>> = {
  // A point evaluation is green only because the reader named it.
  literal: new Set<EvidenceClaim>(['holds-at-values']),
  smt: new Set<EvidenceClaim>(['proved']),
};

/** What the literal engine's outcome is called, and under which code. */
const LITERAL_CLAIM: Record<LiteralOutcome, { claim: EvidenceClaim; code: string | null }> = {
  'holds-at-values': { claim: 'holds-at-values', code: null },
  refuted: { claim: 'refuted', code: null },
  // Vacuity is its own claim, not a flavour of inconclusive: the exit contract
  // treats it as undecided, and the register treats it as a declared deviation.
  vacuous: { claim: 'vacuous', code: 'verification/vacuous-pass' },
  // The values do not determine the answer. NOT forgivable — this is precisely
  // the case §1's warning is about, where a constraint that quietly disappears
  // reads as one that holds.
  'not-evaluable': { claim: 'inconclusive', code: 'verification/not-evaluable' },
  // The construct is outside the fragment this lane encodes at all. Forgivable,
  // because it says nothing about whether the requirement holds.
  unsupported: { claim: 'inconclusive', code: 'verification/unsupported-construct' },
};

/**
 * Every `verification/*` code this lane can put in front of a reader.
 *
 * Derived rather than retyped, and exported so the catalogue guard can assert
 * that each one has an entry in `docs/DIAGNOSTIC-CODES.md`. The lane states its
 * contracts over code STRINGS — the scope of `--allow-inconclusive` above is a
 * set of them, and `verify --help` tells the reader to look them up — so a code
 * the catalogue cannot explain is a contract stated in a vocabulary the reader
 * has no dictionary for. `verification/timeout` was exactly that for a while.
 */
export const VERIFICATION_CODES: ReadonlySet<string> = new Set<string>([
  ...ALLOW_INCONCLUSIVE_CODES,
  ...Object.values(LITERAL_CLAIM)
    .map((v) => v.code)
    .filter((c): c is string => c !== null),
  'verification/tool-absent',
  'verification/design-admitted',
]);

/**
 * Is a z3 backend AND an engine to drive it present in this build?
 *
 * Two absences, one honest answer. Since commit 4 of the verification plan
 * `z3-solver` IS an optional dependency and this probe finds it — and the SMT
 * engine that would drive it is still a later commit, so `--engine auto` still
 * reports `verification/tool-absent` for every obligation. That was the point of
 * making the probe real rather than a hard-coded `null`: the reason this refuses
 * is now the missing ENGINE, and {@link toolAbsentDetail} says so instead of
 * blaming a solver that is installed. The honest-absence path is exercised on
 * every push by the plan's §5 CI job with `SYSPROSE_NO_Z3=1`, which this reads
 * exactly as `src/semantics/smt/z3-bridge.ts` does.
 *
 * The specifier is held in a variable and marked `@vite-ignore` so the bundler
 * does not try to resolve a package that is not there; the browser never gets
 * this far in any case (§6 non-goal 9 — no in-browser solver in this plan).
 */
async function loadZ3(): Promise<Z3Probe> {
  const off =
    typeof process !== 'undefined' &&
    process.env?.SYSPROSE_NO_Z3 !== undefined &&
    process.env.SYSPROSE_NO_Z3 !== '' &&
    process.env.SYSPROSE_NO_Z3 !== '0';
  // Switched off is not the same as missing, and the row says which. The whole
  // L8 corpus runs under this switch on a machine that HAS the package, so
  // collapsing the two would make the tool print a false statement about the
  // machine — and pin it, byte for byte, in a golden.
  if (off) return { backendPresent: false, disabled: true };
  if (typeof process === 'undefined') return { backendPresent: false, disabled: false };
  try {
    const spec = 'z3-solver';
    await import(/* @vite-ignore */ spec);
    return { backendPresent: true, disabled: false };
  } catch {
    return { backendPresent: false, disabled: false };
  }
}

/** What the probe found: a backend, a switched-off one, or nothing installed. */
interface Z3Probe {
  backendPresent: boolean;
  /** True when `SYSPROSE_NO_Z3` forced the absence — see {@link loadZ3}. */
  disabled: boolean;
}

/**
 * The sentence a `tool-absent` row prints, which names what is actually missing.
 *
 * Three cases, because there are three: an engine that does not ship yet, a
 * solver switched off in this environment, and a solver nobody installed. The
 * middle one used to print the third one's sentence, which was false on every
 * machine that has the optional dependency — including the one the corpus runs
 * on. `src/semantics/smt/z3-bridge.ts` draws the same distinction in its own
 * `Z3Absent.disabled`.
 */
function toolAbsentDetail(probe: Z3Probe): string {
  if (probe.backendPresent) {
    return (
      'solver absent — the z3 backend is installed but this build carries no SMT engine to drive it ' +
      '(docs/04-formal-verification-plan.md, commit 5); run `--engine literal` for a point evaluation at the model’s values'
    );
  }
  if (probe.disabled) {
    return (
      'solver absent — the solver is switched off by SYSPROSE_NO_Z3 in this environment, so nothing ' +
      'can decide this obligation; unset it, or run `--engine literal` for a point evaluation at the ' +
      'model’s values, which is not a proof'
    );
  }
  return (
    'solver absent — `z3-solver` is not installed, so nothing can decide this obligation; ' +
    'run `--engine literal` for a point evaluation at the model’s values, which is not a proof'
  );
}

/**
 * Verify every obligation in the model, and say by what.
 *
 * Asynchronous because resolving `auto` means asking whether a solver can be
 * loaded, and that is a dynamic import. Everything after that answer is pure.
 */
export async function verifyModel(model: Model, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const engineAsked: VerifyEngineOption = opts.engine ?? 'auto';
  const free = [...(opts.free ?? [])];
  const allowInconclusive = opts.allowInconclusive === true;
  if (engineAsked === 'literal' && free.length > 0) {
    // A programming error, not a finding about the model: the literal engine
    // evaluates AT the values, so a freed feature has no value to evaluate.
    // Accepting the flag and ignoring it would print a verdict under a bound
    // the record then claimed was in force.
    throw new Error(
      '`free` is an SMT-engine option: the literal engine evaluates at the model’s own values, ' +
        'so there is nothing for it to release. Ask for `--engine smt`, or drop `--free`.',
    );
  }

  const rows = obligationsOf(model, opts.scopeId !== undefined ? { scopeId: opts.scopeId } : {});
  const modelVersion = modelVersionOf(model, opts.sourceText);
  const probe: Z3Probe =
    engineAsked === 'literal' ? { backendPresent: false, disabled: false } : await loadZ3();
  const engine: VerifyEngine = engineAsked === 'literal' ? 'literal' : 'smt';
  // `auto` resolves to `smt` and stops there. There is no third arm, and adding
  // one that fell back to `literal` would make a green build mean "no solver".
  const toolAbsent = engine === 'smt';

  const results: ObligationVerdict[] = toolAbsent
    ? rows
        .filter((row) => row.role === 'obligation')
        .map((row) =>
          toVerdict(row, {
            claim: 'inconclusive',
            code: 'verification/tool-absent',
            detail: toolAbsentDetail(probe),
            premises: [],
            bindings: [],
            bound: { kind: 'none', detail: 'nothing was run, so nothing is claimed' },
            engine,
            allowInconclusive,
          }),
        )
    : judgeLiterally(model, rows).map(({ row, judgement }) => {
        const { claim, code } = LITERAL_CLAIM[judgement.outcome];
        return toVerdict(row, {
          claim,
          code,
          detail: judgement.detail,
          premises: judgement.premises,
          bindings: judgement.bindings,
          bound: boundOf(judgement),
          engine,
          allowInconclusive,
        });
      });

  const discharged = results.filter((r) => r.discharged).length;
  const violated = results.filter((r) => r.claim === 'refuted').length;
  const designAdmitted = results.filter((r) => r.claim === 'design-admitted').length;
  const vacuous = results.filter((r) => r.claim === 'vacuous').length;
  const inconclusive = results.length - discharged - violated;
  const forgiven = results.filter((r) => r.forgiven).length;

  return {
    engineAsked,
    engine,
    toolAbsent,
    results,
    discharged,
    violated,
    inconclusive,
    designAdmitted,
    forgiven,
    vacuous,
    exitCode: exitCodeOf(results, toolAbsent),
    allowInconclusive,
    free,
    modelVersion,
    records: recordEvidence({
      rows: results.map((r) => ({
        obligation: {
          requirement: r.requirement?.qualifiedName ?? null,
          shortId: r.shortId,
          clause: r.clause.qualifiedName,
          obligationDigest: r.obligationDigest,
          expression: r.expression,
        },
        claim: r.claim,
        engine,
        bound: r.bound,
        ...(r.bindings.length > 0
          ? { witness: { kind: 'model-values' as const, values: r.bindings } }
          : {}),
        ...(r.code !== null ? { code: r.code } : {}),
        detail: r.detail,
      })),
      modelVersion,
      producedBy: opts.producedBy ?? `sysprose verify --engine ${engineAsked}`,
      flags: {
        engine: engineAsked,
        free,
        allowInconclusive,
      },
    }),
    diagnostics: numbered(results.filter((r) => r.code !== null).map(verdictFinding)),
  };
}

/**
 * The bound a point evaluation holds within, WITH the two SI magnitudes.
 *
 * The engine already computes them — they were reaching only the `refuted`
 * sentence and were dead for every `holds-at-values` row, the report and the
 * record. They belong here because a witness value alone can be read against
 * the relation it supports: `uav.endurance` STORES 0.7877 (the hours its own
 * equation produced, with no declared unit) beside a requirement written
 * `>= 45.0 [min]`, and a record carrying only that number reads as a
 * refutation. `2835.69 vs 2700 in T` is the pair the comparison was made on.
 */
function boundOf(judgement: {
  bindings: readonly ValueBinding[];
  lhsSI?: number;
  rhsSI?: number;
  dimension?: string;
}): EvidenceBound {
  const si =
    judgement.lhsSI !== undefined && judgement.rhsSI !== undefined
      ? {
          lhs: judgement.lhsSI,
          rhs: judgement.rhsSI,
          ...(judgement.dimension !== undefined ? { dimension: judgement.dimension } : {}),
        }
      : undefined;
  return {
    kind: 'model-values',
    detail:
      `the model’s own feature values, ${judgement.bindings.length} of them; 0 free variables` +
      (si !== undefined
        ? `; compared as ${si.lhs} vs ${si.rhs}${si.dimension !== undefined ? ` in ${si.dimension}` : ''}, coherent SI`
        : ''),
    ...(si !== undefined ? { si } : {}),
  };
}

/** One judged row, with the two derived answers the exit contract turns on. */
function toVerdict(
  row: Obligation,
  input: {
    claim: EvidenceClaim;
    code: string | null;
    detail: string;
    premises: PremiseReading[];
    bindings: ValueBinding[];
    bound: EvidenceBound;
    engine: VerifyEngine;
    allowInconclusive: boolean;
  },
): ObligationVerdict {
  const discharged = DISCHARGES[input.engine].has(input.claim);
  return {
    requirement: row.requirement,
    shortId: row.shortId,
    clause: row.element,
    expression: row.expression,
    obligationDigest: obligationDigest(row),
    claim: input.claim,
    verdict: verdictFor(input.claim),
    discharged,
    code: input.code,
    forgiven:
      input.allowInconclusive && input.code !== null && ALLOW_INCONCLUSIVE_CODES.has(input.code),
    detail: input.detail,
    premises: input.premises,
    bound: input.bound,
    bindings: input.bindings,
  };
}

/**
 * The exit code.
 *
 * TWO TESTS COME BEFORE THE ROWS, and both are about the shape of the run
 * rather than about any obligation in it. They are first because `exitCodeOf`
 * once read the rows alone, and a run with NO rows fell through to `return 0`:
 * `--engine auto` with no solver over a model that states no requirement
 * printed "no solver ran … this run is exit 2" and exited **0**. That is the
 * exact sentence {@link VERIFY_EXIT_CODES} exists to make impossible — "no
 * solver installed, nothing to report, exit 0" is indistinguishable from a
 * proof — and every rule below it is an implication that holds vacuously over
 * an empty row set.
 *
 *  1. **The engine never ran ⇒ 2.** Nothing was discharged *by the engine that
 *     was asked for*, whatever the rows say, because there was no engine.
 *  2. **Nothing to verify ⇒ 2.** Exit 0 means "every obligation discharged",
 *     and a model that states none has not been shown anything. A build that
 *     went green because every requirement was deleted is the failure this lane
 *     exists to prevent; the report's own sentence says which of the two
 *     happened.
 *
 * Then the order of the three row tests IS the contract: a violation outranks
 * every forgiveness, a design the model admits is never a violation, and an
 * inconclusive nobody forgave is 2. Reading it in any other order is how a
 * refutation ends up forgiven by a flag scoped to undecided obligations.
 */
function exitCodeOf(results: readonly ObligationVerdict[], toolAbsent: boolean): 0 | 1 | 2 {
  if (toolAbsent) return 2;
  if (results.length === 0) return 2;
  if (results.some((r) => r.claim === 'refuted')) return 1;
  if (results.some((r) => r.claim === 'design-admitted')) return 2;
  if (results.some((r) => !r.discharged && !r.forgiven)) return 2;
  return 0;
}

/** One row's code, as a diagnostic the whole lane files under one source. */
function verdictFinding(r: ObligationVerdict): Finding {
  return {
    severity: 'info',
    message: `${r.requirement?.qualifiedName ?? r.clause.qualifiedName}: ${r.detail}`,
    elementId: r.clause.id,
    elementName: r.clause.qualifiedName,
    code: r.code as string,
    hint:
      r.forgiven
        ? 'This row was forgiven by `--allow-inconclusive`, which lowers exactly the undecided codes and nothing else; the claim itself is unchanged and the record still says `inconclusive`.'
        : 'The obligation is not discharged. Run `npm run sysprose -- obligations <file>` to see what it stands on, and read `docs/DIAGNOSTIC-CODES.md` for what this code means.',
  };
}

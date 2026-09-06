/**
 * The verification lane's reporting surface: `contractReport` and
 * `obligationsReport`.
 *
 * THE CHARTER OF THIS LANE, IN ONE LINE: **encode after the gates; report what
 * the gates refuse.** It is the same sentence that heads
 * `src/semantics/relations.ts`, restated here because this file is the door
 * every consumer comes through and the invariant has to be legible at the door.
 * What follows from it, and what nothing in this lane may break:
 *
 *  - **These two commands report STRUCTURE, never truth.** They may say how
 *    many contracts there are, on how many subjects, and which fragment each
 *    relation lands in. They may never say satisfied, proved, consistent, or
 *    anything about whether a requirement holds. There is no solver behind
 *    them and there will not be one: `verify` is a separate command with a
 *    separate exit contract.
 *  - **A relation a gate refuses is LISTED with its reason, never omitted.**
 *    A relation that disappears from a worklist reads as one that holds, which
 *    is the failure direction this whole lane exists to avoid. Every refusal
 *    carries a branchable `reason` and a sentence a person can act on.
 *  - **An empty inventory is stated, never rendered as zero problems.** A model
 *    with requirements and no contracts is a finding about the reader's model
 *    or about this tool, and either way they have to be told.
 *  - **`discharged` and `stale` are read back from an evidence record**, never
 *    computed here. Until that record ships there is no way for these reports
 *    to produce either, and they do not.
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

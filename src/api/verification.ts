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
  type ContractSubject,
  type Refusal,
} from '../semantics/contracts';
import { isNonNormativeStatement } from '../semantics/statement-kind';
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
  /** What this lane noticed on the way past — always `source: 'verification'`. */
  diagnostics: Diagnostic[];
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
    diagnostics: verificationDiagnostics(model, contracts, scoped),
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
    diagnostics: verificationDiagnostics(
      model,
      contractsOf(model).filter((c) => scoped(c.id)),
      scoped,
    ),
  };
}

/* ─────────────────────────────── diagnostics ─────────────────────────────── */

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
function verificationDiagnostics(
  model: Model,
  contracts: readonly Contract[],
  scoped: (id: ElementId) => boolean,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  let n = 0;
  const add = (d: Omit<Diagnostic, 'id' | 'ruleId' | 'source'>): void => {
    out.push({
      id: `verification#${n++}`,
      ruleId: 'verification',
      source: 'verification',
      ...d,
    });
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

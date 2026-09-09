#!/usr/bin/env tsx
/**
 * `sysprose` — report on a model from the command line.
 *
 * WHY. Every reporting function in this repo — the size and shape of a model,
 * which requirements are covered, what traces to what, which ports are wired,
 * what a change reaches, what nothing uses, what guidance applies where — is a
 * pure, tested, exported function, and until now every one of them was
 * reachable only from the browser or from a JavaScript console. `npm run check`
 * could tell you a file was VALID; nothing could tell you what was IN it. This
 * is that half of the tool, as one command with subcommands, each a thin shell
 * over the exported function that computes the answer, so a figure read in a
 * terminal and the same figure computed from that import cannot differ. Several
 * of the app's views answer the same QUESTION by drawing their own projection
 * instead of calling the reporting function (Allocation, Interconnection,
 * Properties -> Used by), so those figures are not promised to match — see the
 * capability table in `README.md`.
 *
 *   npm run sysprose -- stats examples/uav-isr.sysml
 *   npm run sysprose -- requirements examples/uav-isr.sysml --json
 *   npm run sysprose -- where-used examples/uav-isr.sysml --element AirVehicle --depth 2
 *   npm run sysprose -- prompts model.sysml --element Engine
 *   cat model.sysml | npm run sysprose -- orphans -
 *
 * Exit codes are the contract, and there are TWO of them here — see
 * `EXIT_CODES` and `VERIFY_EXIT_CODES` in `./lib/sysprose-spec`, which every
 * help text and the generated reference are renderings of. Each subcommand
 * declares which one it obeys (`CommandSpec.exitContract`).
 *
 * For a subcommand that REPORTS, the contract is `sysml-check`'s:
 *   0  the model loaded cleanly and the report is of all of it
 *   1  the model did NOT load cleanly — the report is of what parsed, and a
 *      `degraded` banner on stderr says so
 *   2  usage or I/O problem — nothing was reported
 *
 * Note what 1 does NOT mean there. Those subcommands report; they do not judge.
 * `orphans` finding four unused definitions is an answer, not a failure, so it
 * exits 0 — the exit code is about whether the model under the report is the
 * whole model, which is the only thing an automation can act on generically.
 *
 * For a subcommand that JUDGES — `verify` — 1 means the obligation was
 * **refuted** with every feature at its model value, and every inconclusive
 * (including an absent solver) is 2, as is a degraded model: a verdict over
 * half a model is not a verdict. The two contracts are opposites at 1, which is
 * why every judging run also publishes a top-level `verdict` block under
 * `--json` rather than leaving a consumer to guess which contract it is reading.
 *
 * The report goes to stdout and everything about the FILE goes to stderr, for
 * every exit code: a file that parsed with warnings still had something wrong
 * with it, and a reader who is never told is a reader confidently analysing a
 * file the tool did not recognise.
 *
 * FAIL DIRECTION. Three refusals, each replacing an answer that would read as
 * true: a model that PARSED and produced no elements exits 2 rather than
 * reporting an empty success (a typo'd path and an empty model must not look
 * alike — a file that did not parse is exit 1, because it is broken rather
 * than empty); an element reference that matches several elements exits 2 with
 * the candidates rather than reporting on the first one; and an unexpected
 * internal failure exits 2 from the `main()` wrapper rather than falling
 * through to 0. `--from` / `--to` are refused the same way when they name a
 * metaclass the model has none of, because the alternative is an empty matrix
 * and exit 0.
 *
 * `--kind` is deliberately NOT one of those refusals. It is checked against the
 * closed list of statement kinds before the file is read, so it cannot be a
 * typo the way a metaclass name can; past that, "no statement of this kind" is
 * a true answer about the model rather than a question that could not be
 * asked, and the report says how many of how many rows it is showing so an
 * empty one cannot be read as an empty model.
 *
 * TWO LIBRARY FLAGS, because they are two knobs. `--no-library` skips BINDING:
 * it changes the model — library types report as unresolved — and it is the
 * same flag, with the same meaning, as `npm run check`'s. `--include-library`
 * changes REPORTING: the bundled library is bound and then listed as well as
 * the reader's own model. Only `elements` can honour the second one; the
 * analysis reports exclude the library by construction and each states its own
 * `libraryExcluded` figure, so the flag is rejected there rather than accepted
 * and quietly ignored.
 *
 * See docs/DIAGNOSTIC-CODES.md for what a diagnostic `code` means.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElementRecord, Model } from '../src/core/index';
import Ajv from 'ajv';
import {
  attachEvidence,
  connectivityReport,
  consistencyReport,
  contractReport,
  countUnfollowedTypings,
  detachEvidence,
  evidenceStatus,
  impactClosure,
  isUserElement,
  modelMetrics,
  obligationsReport,
  orphanReport,
  refinementReport,
  profileLines,
  promptsFor,
  propertyCheck,
  propertyDraft,
  PropertyRefError,
  READING,
  reachReport,
  behaviourReport,
  stateMachinesIn,
  traceLine,
  transitionLabel,
  requirementSatisfaction,
  traceabilityMatrix,
  verdictFor,
  verifyModel,
  witnessNumber,
  type AttachReport,
  type ConsistencyGroup,
  type ConsistencyReport,
  type DetachReport,
  type ElementRef,
  type EvidenceRecord,
  type EvidenceStatusReport,
  type KeywordUse,
  type DictionaryEntry,
  type GateResult,
  type ObligationVerdict,
  type PropertyCheckReport,
  type RefinementReport,
  type PropertyDraftReport,
  type BehaviourReport,
  type MachineReach,
  type PropertyVerdict,
  type ReachReport,
  type VerificationCaseVerdict,
  type VerifyEngineOption,
  VerifyOptionError,
  type VerifyReport,
} from '../src/api/index';
import {
  isStatementKind,
  resolveFullName,
  runVerificationCases,
  statementKindOf,
  verificationCasesOf,
  writeVerdict,
  type Contract,
  type ContractClause,
  type ContractSubject,
  type JudgedObligation,
  type Obligation,
  type Refusal,
  type RefinementGroup,
  type RefinementVia,
  type StatementKind,
  type WriteVerdictReport,
} from '../src/semantics/index';
// Deep imports rather than `../src/diagram/index`: the diagram barrel pulls the
// layout engine in with it, and neither of these two builders needs it.
import { buildGrid } from '../src/diagram/grid';
import { buildRequirementsTable } from '../src/diagram/requirements-table';
import { loadModelText, type CheckReport } from '../src/text/load';
import type { TextRange } from '../src/validation/types';
import { serializeElement } from '../src/text/serializer';
import { flagGiven, flagValue, isArgError, parseArgs, type ParsedArgs } from './lib/args';
import { runMain } from './lib/exit';
import {
  COMMANDS,
  DEFAULT_MAX_CONFIGS,
  STATEMENT_KIND_FLAG_VALUES,
  TRACE_PRESETS,
  findCommand,
  flagsFor,
  renderCommandUsage,
  renderTopUsage,
  type CommandSpec,
} from './lib/sysprose-spec';

/**
 * A problem with what was ASKED, not with the model: exit 2, nothing reported.
 *
 * `showUsage` separates the two kinds. A malformed command line is answered
 * with the subcommand's help, because the reader needs the grammar; a
 * reference that resolves to nothing (or to six things) is answered with the
 * candidates, because the reader needs the model.
 */
class UsageError extends Error {
  readonly showUsage: boolean;
  constructor(message: string, showUsage = false) {
    super(message);
    this.showUsage = showUsage;
  }
}

/** One subcommand's answer, in both renderings, from one computation. */
interface Report {
  /** The value published under the subcommand's payload key. */
  json: unknown;
  /** The human rendering, without a trailing newline. */
  text: string;
  /**
   * The run of a subcommand that JUDGES, for {@link judge} to turn into an exit
   * code and a top-level `verdict` block.
   *
   * Absent for every `exitContract: 'report'` subcommand and present for every
   * `'verify'` one, so a consumer reading a `--json` body with no `verdict`
   * beside it can be certain nothing was judged.
   */
  verify?: VerifyReport;
  /**
   * The run of the OTHER subcommand that judges.
   *
   * A second field rather than a widened first one: the two answer different
   * questions and publish different figures, and a `verdict` block that had to
   * be read differently depending on which command produced it would be a
   * block nobody could parse without knowing. What they share — and all an
   * automation needs — is `verdict.exitCode`.
   */
  consistency?: ConsistencyReport;
  /**
   * The run of the THIRD subcommand that judges.
   *
   * A third field for the same reason `consistency` is a second one: the three
   * publish different figures — obligations, requirement sets, decompositions —
   * and one `verdict` block that had to be read differently depending on which
   * command produced it would be a block nobody could parse without knowing.
   * What they share, and all an automation needs, is `verdict.exitCode`.
   */
  refinement?: RefinementReport;
  /**
   * The run of the FOURTH subcommand that judges.
   *
   * A fourth field for the same reason there is a third: the four publish
   * different figures — obligations, requirement sets, decompositions, and now
   * properties over a state machine — and one `verdict` block that had to be
   * read differently depending on which command produced it would be a block
   * nobody could parse without knowing. What they share, and all an automation
   * needs, is `verdict.exitCode`.
   */
  behaviour?: BehaviourReport;
}

/** The four figures the verify exit contract is computed from, and the answer. */
interface Verdict {
  discharged: number;
  violated: number;
  inconclusive: number;
  designAdmitted: number;
  exitCode: number;
}

/** The same block for `consistency`, whose figures are requirement SETS. */
interface ConsistencyVerdict {
  consistent: number;
  inconsistent: number;
  inconclusive: number;
  exitCode: number;
}

/** The same block for `refine`, whose figures are DECOMPOSITIONS. */
interface RefinementVerdict {
  refined: number;
  notRefined: number;
  vacuous: number;
  inconclusive: number;
  exitCode: number;
}

/** The same block for `check-behaviour`, whose figures are PROPERTIES. */
interface BehaviourVerdict {
  passed: number;
  failed: number;
  vacuous: number;
  inconclusive: number;
  exitCode: number;
}

/**
 * The exit code of a judging run, degradation included.
 *
 * ONE PLACE, because the rule that a degraded model is exit 2 lives nowhere
 * else. `verifyModel` computes the code from the obligations, which is all it
 * can see; whether the model under those obligations was the whole model is a
 * fact about the FILE, and it belongs here beside the `degraded` banner. A
 * verdict over half a model is not a verdict, so degradation outranks
 * everything — including a clean sweep of discharges, which is exactly the
 * combination that would otherwise print a green build over a file that did not
 * parse.
 */
function judge(report: VerifyReport, degraded: boolean): Verdict {
  return {
    discharged: report.discharged,
    violated: report.violated,
    inconclusive: report.inconclusive,
    designAdmitted: report.designAdmitted,
    exitCode: degraded ? 2 : report.exitCode,
  };
}

/**
 * The exit code of a consistency run, degradation included.
 *
 * The same rule and the same reason as {@link judge}: whether the model under
 * the answer was the whole model is a fact about the FILE, it lives here beside
 * the `degraded` banner, and it outranks everything — a requirement set called
 * satisfiable over half a model is not an answer about that model.
 */
function judgeConsistency(report: ConsistencyReport, degraded: boolean): ConsistencyVerdict {
  return {
    consistent: report.consistent,
    inconsistent: report.inconsistent,
    inconclusive: report.inconclusive,
    exitCode: degraded ? 2 : report.exitCode,
  };
}

/**
 * The exit code of a refinement run, degradation included.
 *
 * The same rule and the same reason as {@link judge}: whether the model under
 * the answer was the whole model is a fact about the FILE, and an architecture
 * called refined over half a model is not an answer about that model.
 */
function judgeRefinement(report: RefinementReport, degraded: boolean): RefinementVerdict {
  return {
    refined: report.refined,
    notRefined: report.notRefined,
    vacuous: report.vacuous,
    inconclusive: report.inconclusive,
    exitCode: degraded ? 2 : report.exitCode,
  };
}

/**
 * The exit code of a behaviour run, degradation included.
 *
 * The same rule and the same reason as {@link judge}: whether the model under
 * the answer was the whole model is a fact about the FILE, and a safety
 * property called held over half a machine is not an answer about that machine.
 */
function judgeBehaviour(report: BehaviourReport, degraded: boolean): BehaviourVerdict {
  return {
    passed: report.counts.passed,
    failed: report.counts.failed,
    vacuous: report.counts.vacuous,
    inconclusive: report.counts.inconclusive,
    exitCode: degraded ? 2 : report.exitCode,
  };
}

/* ────────────────────────────── small helpers ───────────────────────────── */

/** Best short label for an element reference. */
function label(ref: ElementRef): string {
  return ref.declaredName ?? (ref.qualifiedName || ref.id);
}

/** Qualified name, falling back to the id for an element that has none. */
function qname(model: Model, id: string): string {
  return model.qualifiedName(id) || id;
}

/** `  key   value` blocks, aligned on the longest key. */
function aligned(pairs: Array<[string, string | number]>, indent = '  '): string[] {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${indent}${k.padEnd(width)}   ${String(v)}`);
}

/** A bullet list, or a single line saying there is nothing in it. */
function listOrNone(heading: string, items: string[], none: string, indent = '  '): string[] {
  if (items.length === 0) return [`${indent}${none}`];
  return [`${indent}${heading}`, ...items.map((i) => `${indent}  ${i}`)];
}

/* ─────────────────────── element reference resolution ───────────────────── */

/**
 * Resolve what the reader typed after `--element` to one element.
 *
 * Three steps, narrowing: an exact id (what a previous `--json` run printed),
 * then the language's own name resolution (which is what makes a qualified name
 * work), then a unique suffix match on the qualified name (which is what makes
 * a bare `AirVehicle` work in a file that declares it inside a package).
 *
 * Only the last step needs filtering, and it needs it badly: `powerIn` matches
 * 10 elements in the shipped UAV example, 5 of which are the tool's own
 * usage-scoped copies. Offering all 10 asks the reader to choose between ids
 * that are not in their file. The first two steps are deliberately NOT
 * filtered — an exact id or a fully-resolved name is unambiguous, and asking
 * where a library type is used is a fair question.
 */
function resolveElementRef(model: Model, ref: string): ElementRecord {
  const byId = model.get(ref);
  if (byId) return byId;

  const byName = resolveFullName(model, ref, null);
  if (byName) return byName;

  const candidates = model.all().filter((el) => {
    if (!isUserElement(model, el)) return false;
    const qn = model.qualifiedName(el.id);
    return qn === ref || qn.endsWith(`::${ref}`) || el.declaredShortName === ref;
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new UsageError(
      `no element matches \`${ref}\` — pass an id or a qualified name, or run \`elements\` to see what is there`,
    );
  }
  throw new UsageError(
    [
      `\`${ref}\` is ambiguous — ${candidates.length} elements match:`,
      ...candidates.map((c) => `    ${qname(model, c.id)} [${c.eClass}]`),
      '  name one of them; a qualified name always resolves.',
    ].join('\n'),
  );
}

/* ─────────────────────────────── subcommands ────────────────────────────── */

function reportStats(model: Model, name: string): Report {
  const m = modelMetrics(model);
  const census = Object.entries(m.byMetaclass).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const text = [
    `${name}: ${m.totalElements} element(s) — ${m.nodeCount} node(s), ${m.relationshipCount} relationship(s), ` +
      `${m.rootCount} root(s), max depth ${m.maxDepth}`,
    ...aligned([['library elements', m.libraryElements]]),
    '  (the library is bound alongside the model and left out of every figure above)',
    '  by metaclass',
    ...aligned(
      census.map(([k, v]) => [k, v] as [string, number]),
      '    ',
    ),
  ].join('\n');
  return { json: m, text };
}

function reportElements(model: Model, name: string, includeLibrary: boolean): Report {
  const grid = buildGrid(model, { excludeLibrary: !includeLibrary });
  // `buildGrid`'s only filter is the library, and the app's Grid view wants it
  // that way. A command answering "what is IN it" must not stop there: 14 of
  // the 94 rows it returns for the shipped UAV example are the tool's own
  // usage-scoped connector endpoints (`impl-…` ids), so the listing claimed 29
  // PortUsages for a model that `stats` — and every other subcommand, which all
  // go through `isUserElement` — says has 15. Those rows are not in the
  // reader's file and cannot be edited there, so a listing that ADDS them is
  // not a listing of their model.
  const kept = grid.rows.filter((r) => {
    const el = model.get(r.id);
    if (!el) return false;
    return isUserElement(model, el) || (includeLibrary && el.attrs.isLibrary === true);
  });
  const implicitExcluded = grid.rows.length - kept.length;
  const rows = kept.map((r) => ({
    id: r.id,
    qualifiedName: qname(model, r.id),
    name: r.cells.name,
    metaclass: r.cells.metaclass,
    type: r.cells.type,
    multiplicity: r.cells.multiplicity,
    value: r.cells.value,
    redefines: r.cells.redefines,
    doc: r.cells.doc,
  }));
  // Padding is capped: one 90-character library name must not indent every
  // other line off the right of the terminal.
  const width = Math.min(60, Math.max(0, ...rows.map((r) => r.qualifiedName.length)));
  const text = [
    `${name}: ${rows.length} element(s)` + (includeLibrary ? ' (bundled library included)' : ''),
    '  relationships and documentation are reported through the elements they attach to',
    `  ${implicitExcluded} re-derived element(s) (usage-scoped connector endpoints) left out`,
    ...rows.map((r) => {
      const tail = [r.type ? `: ${r.type}` : '', r.value ? ` = ${r.value}` : ''].join('');
      return `  ${r.qualifiedName.padEnd(width)}  ${r.metaclass}${tail}`;
    }),
  ].join('\n');
  return { json: rows, text };
}

/**
 * The kind `--kind` names, or a refusal. Shared with {@link precheckArgs} so a
 * mistyped kind is rejected before a second of parsing and library binding.
 *
 * `undefined` is "every kind", which is the default: a reader who has not heard
 * of statement kinds must not have to learn about them to see their own
 * statements.
 */
function requirementsKind(args: ParsedArgs): StatementKind | undefined {
  const raw = flagValue(args, 'kind');
  if (raw === undefined) return undefined;
  if (!isStatementKind(raw)) {
    throw new UsageError(
      `unknown --kind \`${raw}\` — one of ${STATEMENT_KIND_FLAG_VALUES.join(', ')}`,
      true,
    );
  }
  return raw;
}

/**
 * What a non-normative row is doing in a coverage report, in the reader's words.
 *
 * Named rather than inlined because it is the whole labelling contract: a row
 * that is not counted has to say both WHAT it is and that it is not counted, or
 * a reader adds it to the divisor themselves.
 */
const NON_NORMATIVE_NOTE: Record<'prose' | 'prompt', string> = {
  prose: 'prose: an explanation for the reader, not counted',
  prompt: 'prompt: guidance for an agent, not counted',
};

function reportRequirements(model: Model, name: string, args: ParsedArgs): Report {
  const kindFilter = requirementsKind(args);
  const sat = requirementSatisfaction(model);
  const table = buildRequirementsTable(model);
  const status = new Map(sat.requirements.map((r) => [r.requirement.id, r]));

  // EVERY requirement-shaped statement the reader wrote, whatever kind it is —
  // not just the ones the ratio counts. Listing only the counted ones made the
  // `N statement(s) tagged prose or prompt` line unfollowable: the reader was
  // told a statement had left the divisor and given no way to find out which.
  // The ratio is still over the normative ones alone, so each row says which it
  // is and the exclusion lines below say how many are in neither.
  //
  // Re-derived copies stay out. `buildRequirementsTable` filters only the
  // library, so a usage-scoped copy of a requirement is a row there; it is not
  // in the reader's file, cannot be edited there, and is already counted under
  // the report's own `implicitExcluded`.
  const rows = table.rows
    .filter((r) => {
      const el = model.get(r.id);
      return el !== undefined && isUserElement(model, el);
    })
    .map((r) => {
      const st = status.get(r.id);
      return {
        id: r.id,
        number: r.number,
        reqId: r.reqId,
        name: r.name || qname(model, r.id),
        metaclass: r.eClass,
        // The kind it READS as, which for an untagged requirement is
        // `requirement` off the metaclass — the same answer coverage used.
        kind: statementKindOf(model, r.id),
        text: r.text,
        // `null`, not `false`, on a statement nothing is supposed to satisfy.
        // `false` is a claim about a requirement — that it has a gap — and a
        // consumer counting gaps would count every explanation in the model.
        satisfied: st ? st.satisfied : null,
        // The VERDICT is withheld on a non-normative row; the EDGES are not.
        // `requirementSatisfaction` has no status for a prose row, so falling
        // back to an empty list would have reported `satisfiedBy: []` on a
        // statement the model really does carry a `satisfy` onto — an absence
        // the reader can measure, and on exactly one of the five reference
        // columns, while the four below it named the same element. The row's
        // own column is the same edge set from the same walk, so it answers
        // here and all five columns come from one source.
        satisfiedBy: st ? st.satisfiers.map(label) : r.refs.satisfiedBy.map((x) => x.label),
        verifiedBy: r.refs.verifiedBy.map((x) => x.label),
        refinedBy: r.refs.refinedBy.map((x) => x.label),
        tracedTo: r.refs.tracedTo.map((x) => x.label),
        derivedFrom: r.refs.derivedFrom.map((x) => x.label),
      };
    });
  // Anything the ratio counts that the table did not emit. The two populations
  // agree today; a row missing from the list while sitting in the divisor is
  // exactly the arithmetic nobody can check, so the safety net stays.
  const rowIds = new Set(rows.map((r) => r.id));
  for (const st of sat.requirements) {
    if (rowIds.has(st.requirement.id)) continue;
    rows.push({
      id: st.requirement.id,
      number: '',
      reqId: '',
      name: label(st.requirement),
      metaclass: st.requirement.eClass,
      kind: statementKindOf(model, st.requirement.id),
      text: '',
      satisfied: st.satisfied,
      satisfiedBy: st.satisfiers.map(label),
      verifiedBy: [],
      refinedBy: [],
      tracedTo: [],
      derivedFrom: [],
    });
  }
  const shown = kindFilter === undefined ? rows : rows.filter((r) => r.kind === kindFilter);

  const payload = {
    total: sat.total,
    satisfied: sat.satisfied,
    coverage: sat.coverage,
    libraryExcluded: sat.libraryExcluded,
    implicitExcluded: sat.implicitExcluded,
    nonNormativeExcluded: sat.nonNormativeExcluded,
    // What was ASKED for, so a consumer reading a payload out of a file knows
    // whether `rows` is the whole listing or one kind of it.
    kind: kindFilter ?? null,
    rows: shown,
  };
  const pct = sat.total === 0 ? 0 : Math.round(sat.coverage * 100);
  const text = [
    // The ratio is a fact about the MODEL, so it is the same headline under
    // every filter. Only the listing narrows.
    `${name}: ${sat.satisfied} of ${sat.total} requirement(s) satisfied (${pct}%)`,
    ...(kindFilter !== undefined
      ? [`  showing ${shown.length} of ${rows.length} statement(s) — kind ${kindFilter}`]
      : []),
    ...(shown.length === 0
      ? [
          kindFilter === undefined
            ? '  no requirements in this model'
            : `  none of them is ${kindFilter}`,
        ]
      : []),
    ...shown.map((r) => {
      const id = r.reqId ? ` (${r.reqId})` : '';
      const number = r.number ? `${r.number}  ` : '';
      // The mark IS the kind for a requirement: a checkbox only means anything
      // about a statement something can satisfy. Spelling `requirement` on
      // every line as well would be a word on every line of the overwhelmingly
      // common all-requirements model, read past by everyone.
      if (r.kind === 'prose' || r.kind === 'prompt') {
        return `  [-] ${number}${r.name}${id} — ${NON_NORMATIVE_NOTE[r.kind]}`;
      }
      const by = r.satisfied ? `satisfied by ${r.satisfiedBy.join(', ')}` : 'nothing satisfies it';
      return `  ${r.satisfied ? '[x]' : '[ ]'} ${number}${r.name}${id} — ${by}`;
    }),
    `  ${sat.libraryExcluded} bundled library requirement(s) and ${sat.implicitExcluded} re-derived copy/copies are not counted`,
    // Only when there IS one. The exclusion line above is on every report
    // because the library is always there to exclude; a non-normative statement
    // is not, and a permanent `0 prose or prompt` line would teach every reader
    // of every model a vocabulary most of them never use. When one does appear,
    // the ratio moved and this says why.
    ...(sat.nonNormativeExcluded > 0
      ? [
          `  ${sat.nonNormativeExcluded} statement(s) tagged prose or prompt are not requirements and are not counted`,
        ]
      : []),
    // Said only to a reader who asked for a non-normative kind, because they are
    // the one who can mistake this for a listing of every such statement in the
    // model. It is not: the population here is what a requirements table holds,
    // and a `#prose` package or a `#prompt` part definition is not in it.
    ...(kindFilter === 'prose' || kindFilter === 'prompt'
      ? [
          `  requirement-shaped statements only — a ${kindFilter} written on a part or a package is not here`,
          '  `prompts --element REF` is the one that answers what guidance applies to an element',
        ]
      : []),
  ].join('\n');
  return { json: payload, text };
}

/**
 * The row and column metaclasses a relationship family actually links.
 *
 * Read off the model rather than fixed per preset. `satisfy` joins a
 * `PartUsage` to a `RequirementDefinition` in the shipped UAV example and a
 * `PartUsage` to a `RequirementUsage` in a model that declares its requirements
 * as usages; a preset that hard-coded either pair would report an empty matrix
 * for the other shape, and an empty matrix is indistinguishable from "nothing
 * is traced". `--from` / `--to` override it for the axis a reader wants to see
 * whether anything reaches at all.
 */
function traceAxes(
  model: Model,
  relKinds: readonly string[],
): { fromKinds: string[]; toKinds: string[] } {
  const edges = model.all().filter((el) => relKinds.includes(el.eClass) && isUserElement(model, el));
  const kindsOn = (end: 'source' | 'target'): string[] => {
    const seen: string[] = [];
    for (const e of edges) {
      for (const id of e[end] ?? []) {
        const k = model.get(id)?.eClass;
        if (k && !seen.includes(k)) seen.push(k);
      }
    }
    return seen;
  };
  return { fromKinds: kindsOn('source'), toKinds: kindsOn('target') };
}

/**
 * The relationship family `--relation` names, or a refusal.
 *
 * Shared with {@link precheckArgs} so an unknown name is rejected before the
 * model is read rather than after a second of parsing and library binding.
 */
function traceRelation(args: ParsedArgs): { relation: string; relKinds: readonly string[] } {
  const relation = flagValue(args, 'relation') ?? 'satisfy';
  const relKinds = TRACE_PRESETS.get(relation);
  if (!relKinds) {
    throw new UsageError(
      `unknown --relation \`${relation}\` — one of ${[...TRACE_PRESETS.keys()].join(', ')}`,
      true,
    );
  }
  return { relation, relKinds };
}

function reportTrace(model: Model, name: string, args: ParsedArgs): Report {
  const { relation, relKinds } = traceRelation(args);
  const derived = traceAxes(model, relKinds);
  const from = flagValue(args, 'from');
  const to = flagValue(args, 'to');

  // An override naming a metaclass the model does not hold is refused, not
  // honoured. Honouring it produces an empty matrix and exit 0 — the exact
  // shape this command derives its axes to avoid, and indistinguishable from
  // the honest "nothing of this kind is traced" answer, so a typo (`PartUsages`
  // for `PartUsage`) would read as a finding about the model.
  const derivedAxes =
    derived.fromKinds.length === 0 || derived.toKinds.length === 0
      ? `this model has no ${relKinds.join('/')} relationship at all`
      : `${relation} here links ${derived.fromKinds.join(', ')} to ${derived.toKinds.join(', ')}`;
  for (const [flag, kind] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (kind !== undefined && model.ofKind(kind).length === 0) {
      throw new UsageError(
        `--${flag} names a metaclass this model has none of (\`${kind}\`) — ${derivedAxes}`,
        true,
      );
    }
  }

  const fromKinds = from ? [from] : derived.fromKinds;
  const toKinds = to ? [to] : derived.toKinds;

  const rows = new Map<string, ElementRef>();
  const columns = new Map<string, ElementRef>();
  const links = new Map<string, { from: string; to: string; relationshipId: string }>();
  for (const f of fromKinds) {
    for (const t of toKinds) {
      for (const rel of relKinds) {
        const m = traceabilityMatrix(model, f, t, rel);
        for (const r of m.rows) rows.set(r.id, r);
        for (const c of m.columns) columns.set(c.id, c);
        for (const l of m.links) links.set(`${l.relationshipId}|${l.from}|${l.to}`, l);
      }
    }
  }
  const rowList = [...rows.values()];
  const columnList = [...columns.values()];
  const linked = new Set([...links.values()].map((l) => `${l.from}|${l.to}`));

  // Counted over the UNION of the axis kinds, once per element: a candidate
  // that sits on both axes (a parts × parts view) is one element the reader
  // cannot see, and summing the parts of a merged matrix would report two
  // library parts in a model that has one.
  const candidates = new Map<string, ElementRecord>();
  for (const kind of new Set([...fromKinds, ...toKinds])) {
    for (const el of model.ofKind(kind)) candidates.set(el.id, el);
  }
  const pool = [...candidates.values()];
  const libraryExcluded = pool.filter((el) => el.attrs.isLibrary === true).length;
  const implicitExcluded = pool.filter(
    (el) => el.attrs.isLibrary !== true && !isUserElement(model, el),
  ).length;
  // Over the AXES, not the pool: a library or implicit candidate is already
  // named by its own counter above, and a figure that double-counts is one the
  // reader cannot check against the rows in front of them. `--from K --to K`
  // puts the same elements on both axes, so the union is de-duplicated — by the
  // API's own counter, not a copy of it, so this line and
  // `traceabilityMatrix(...).unresolvedTypings` cannot drift apart.
  const unresolvedTypings = countUnfollowedTypings(model, [...rows.keys(), ...columns.keys()]);

  const unlinkedRows = rowList
    .filter((r) => !columnList.some((c) => linked.has(`${r.id}|${c.id}`)))
    .map(label);
  const unlinkedColumns = columnList
    .filter((c) => !rowList.some((r) => linked.has(`${r.id}|${c.id}`)))
    .map(label);

  const payload = {
    relation,
    relationshipKinds: [...relKinds],
    fromKinds,
    toKinds,
    rows: rowList,
    columns: columnList,
    cells: rowList.map((r) => columnList.map((c) => linked.has(`${r.id}|${c.id}`))),
    links: [...links.values()].map((l) => ({
      ...l,
      fromName: qname(model, l.from),
      toName: qname(model, l.to),
    })),
    unlinkedRows,
    unlinkedColumns,
    libraryExcluded,
    implicitExcluded,
    unresolvedTypings,
  };

  const axes =
    fromKinds.length === 0 || toKinds.length === 0
      ? `no ${relKinds.join('/')} relationship in this model`
      : `${fromKinds.join(', ')} -> ${toKinds.join(', ')} via ${relKinds.join(', ')}`;
  const text = [
    `${name}: ${relation} — ${payload.links.length} link(s) across ${rowList.length} row(s) x ${columnList.length} column(s)`,
    `  axes: ${axes}`,
    ...listOrNone(
      'links',
      payload.links.map((l) => `${l.fromName} -> ${l.toName}`),
      'no links',
    ),
    ...(unlinkedColumns.length > 0
      ? [`  nothing links to: ${unlinkedColumns.join(', ')}`]
      : []),
    ...(unlinkedRows.length > 0 ? [`  links to nothing: ${unlinkedRows.join(', ')}`] : []),
    `  ${libraryExcluded} library and ${implicitExcluded} re-derived candidate(s) left out of the axes; ` +
      `${unresolvedTypings} declared type(s) this walk cannot follow`,
  ].join('\n');
  return { json: payload, text };
}

function reportConnectivity(model: Model, name: string): Report {
  const c = connectivityReport(model);
  const text = [
    `${name}: ${c.portCount} port(s), ${c.connectionCount} connection(s), ${c.connectedPortCount} connected, ` +
      `${c.unconnectedPorts.length} unconnected`,
    ...listOrNone(
      'connections',
      c.connections.map(
        (x) =>
          `${label(x.connection)}: ${x.sourcePorts.map((id) => qname(model, id)).join(', ')} -> ` +
          `${x.targetPorts.map((id) => qname(model, id)).join(', ')}`,
      ),
      'no connections',
    ),
    ...listOrNone(
      'unconnected ports',
      c.unconnectedPorts.map((p) => p.qualifiedName || p.id),
      'every declared port is wired',
    ),
    ...(c.unconnectedPortUsages.length > 0
      ? [
          '  unconnected port usages (a port is dangling per usage, not per declaration)',
          ...c.unconnectedPortUsages.map(
            (o) => `    ${o.part.qualifiedName || label(o.part)} :: ${label(o.port)}`,
          ),
        ]
      : []),
    `  ${c.implicitResolved} endpoint(s) lifted onto the port they redefine; ` +
      `${c.libraryExcluded} library and ${c.implicitExcluded} re-derived candidate(s) excluded`,
  ].join('\n');
  return { json: c, text };
}

/** The element `where-used` was asked about, or a refusal. Shared with the precheck. */
function whereUsedRef(args: ParsedArgs): string {
  const ref = flagValue(args, 'element');
  if (ref === undefined) {
    throw new UsageError('where-used needs --element <id|qualified name|unique name>', true);
  }
  return ref;
}

/** How many hops `where-used` was asked to walk, or a refusal. Shared with the precheck. */
function whereUsedDepth(args: ParsedArgs): number {
  const raw = flagValue(args, 'depth') ?? '1';
  const depth = Number(raw);
  if (!Number.isInteger(depth) || depth < 1) {
    throw new UsageError(`--depth must be a whole number of hops, 1 or more (got \`${raw}\`)`, true);
  }
  return depth;
}

function reportWhereUsed(model: Model, name: string, args: ParsedArgs): Report {
  const ref = whereUsedRef(args);
  const depth = whereUsedDepth(args);
  const el = resolveElementRef(model, ref);
  const report = impactClosure(model, el.id, depth);
  const payload = { ...report, requestedDepth: depth };
  const text = [
    `${name}: ${qname(model, el.id)} — ${report.impacted.length} element(s) impacted, ` +
      `${report.depth} hop(s) out of ${depth} asked for`,
    ...(report.impacted.length === 0
      ? ['  nothing references it']
      : report.impacted.map(
          (i) =>
            `  ${i.depth}  ${i.element.qualifiedName || i.element.id}` +
            `  via ${i.via} from ${label(i.from)}`,
        )),
    report.truncated
      ? `  truncated: one more hop has somewhere to go — raise --depth`
      : '  complete: nothing further to reach',
    `  ${report.libraryExcluded} library element(s) dropped from the walk; ` +
      `${report.implicitExcluded} re-derived element(s) crossed but not reported; ` +
      `${report.unresolvedTypings} declared type(s) this walk cannot follow`,
  ].join('\n');
  return { json: payload, text };
}

/** The element `prompts` was asked about, or a refusal. Shared with the precheck. */
function promptsRef(args: ParsedArgs): string {
  const ref = flagValue(args, 'element');
  if (ref === undefined) {
    throw new UsageError('prompts needs --element <id|qualified name|unique name>', true);
  }
  return ref;
}

/**
 * A prompt's words, indented under the line that says where they came from.
 *
 * Printed in full rather than truncated to a line: guidance is the payload of
 * this report, and a report that shows the first 80 characters of an
 * instruction is a report an agent has to go and read the file to use. Blank
 * lines are dropped so a `doc` body written with paragraph breaks does not
 * scatter the listing.
 *
 * A prompt with NO words is the one case worth spelling out. It is a tag
 * somebody wrote and never filled in, and a blank line under it reads as
 * guidance that was collected and lost rather than guidance that was never
 * written.
 */
function promptTextLines(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return ['      (tagged as a prompt, but carries no words)'];
  return lines.map((l) => `      ${l}`);
}

function reportPrompts(model: Model, name: string, args: ParsedArgs): Report {
  const el = resolveElementRef(model, promptsRef(args));
  const report = promptsFor(model, el.id);
  const text = [
    `${name}: ${qname(model, el.id)} — ${report.prompts.length} prompt(s) apply`,
    ...(report.prompts.length === 0
      ? ['  no guidance is written on it, on what it is, or on where either sits']
      : report.prompts.flatMap((p) => [
          `  ${p.distance}  ${p.via.padEnd(5)}  ${p.prompt.qualifiedName || label(p.prompt)}` +
            // At distance 0 the prompt hangs on the element in the heading, so
            // repeating it there would be a column of the same name.
            (p.distance === 0 ? '' : ` via ${p.attachedTo.qualifiedName || label(p.attachedTo)}`),
          ...promptTextLines(p.text),
        ])),
    // A legend for a list, so only when there is a list. Under "no guidance is
    // written on it" it read as a promise about rows that are not there.
    ...(report.prompts.length > 0
      ? // The walk's third path is the owners of TYPES, so "everything under
        // it" was a rule the rows above it broke: a part typed from another
        // package is reported that package's guidance without sitting in it.
        ['  nearest first; guidance reaches an element from what it is, where it sits, and where what it is sits']
      : []),
    `  ${report.libraryExcluded} library element(s) dropped from the walk; ` +
      `${report.implicitExcluded} re-derived element(s) crossed but not reported; ` +
      `${report.unresolvedTypings} declared type(s) this walk cannot follow`,
  ].join('\n');
  return { json: report, text };
}

/* ─────────────────────── the verification lane ──────────────────────────── */

/**
 * The element a verification subcommand was scoped to, or `undefined`.
 *
 * `--element` is OPTIONAL on both rows — the default is the whole model — so a
 * missing flag is an answer rather than a refusal. What is refused is a
 * reference naming BUNDLED LIBRARY content: the library's own requirements are
 * not the reader's, every figure in these reports excludes them by
 * construction, and scoping to one would print an inventory of zero contracts
 * that reads exactly like a model with none.
 */
function verificationScope(model: Model, args: ParsedArgs): ElementRecord | undefined {
  const ref = flagValue(args, 'element');
  if (ref === undefined) return undefined;
  const el = resolveElementRef(model, ref);
  if (el.attrs.isLibrary === true) {
    throw new UsageError(
      `\`${ref}\` is a bundled standard-library element — this report is of your model, and every figure in it excludes the library`,
    );
  }
  return el;
}

/** How a fragment is written for a person. */
const FRAGMENT_LABEL: Record<string, string> = {
  'qf-lra': 'QF_LRA — linear real arithmetic',
  'qf-nra': 'QF_NRA — nonlinear, may time out',
  temporal: 'temporal — export only',
  unsupported: 'not encodable',
};

/** `uav : AirVehicle (declared)`, or the sentence for a contract with no subject. */
function subjectLine(subject: ContractSubject | null): string {
  if (!subject) return 'no subject declared, inherited or bound';
  const typed = subject.typeRef ? ` : ${subject.typeRef}` : '';
  return `${subject.name || '(unnamed)'}${typed} (${subject.origin})`;
}

/** One clause, with the fragment it lands in or the gate that refused it. */
function clauseLines(clause: ContractClause): string[] {
  const head = `    ${clause.role.padEnd(7)} ${clause.expression}`;
  if (clause.encodable === true) {
    return [`${head}  [${FRAGMENT_LABEL[clause.fragment]}]`];
  }
  const refusal: Refusal = clause.encodable;
  return [head, `      not encodable (${refusal.reason}): ${refusal.detail}`];
}

/**
 * What a contract with no clause of its own is, which is two different things.
 *
 * `requirement massOk : MassLimit;` inherits a `require constraint` from its
 * definition and owns none — it is not prose, and saying so would be false
 * about a requirement that a `satisfy` names and that this tool can encode.
 * A requirement that really carries only words is the other case, and it is the
 * commonest row a real requirement set produces.
 */
function emptyClauseLine(contract: Contract): string {
  if (contract.clausesInheritedFrom.length === 0) {
    return '    no formal clause: prose only, nothing to encode';
  }
  const where = contract.clausesInheritedFrom.map((d) => d.qualifiedName || label(d)).join(', ');
  return `    no clause of its own: the clauses are on its definition ${where}`;
}

/** The traceability edges a contract carries, each named by its own keyword. */
function edgeLines(contract: Contract): string[] {
  const rows: Array<[string, string[]]> = [
    ['satisfy', contract.satisfiedBy.map(label)],
    ['verify', contract.verifiedBy.map(label)],
    ['derive from', contract.derivedFrom.map(label)],
    ['refine by', contract.refinedBy.map(label)],
  ];
  const shown = rows.filter(([, names]) => names.length > 0);
  if (shown.length === 0) return ['    no satisfy, verify, derive or refine statement names it'];
  return shown.map(([kw, names]) => `    ${kw} ${names.join(', ')}`);
}

/**
 * One keyword, said the way §3.12 of the plan says it may be said.
 *
 * Four sentences, one per origin, and none of them may be collapsed into
 * another: "third-party spelling" and "names nothing" are different facts about
 * a file, and a reader who is told only the second goes looking for a
 * misspelling in a keyword this tool understood perfectly well. The word
 * `standard` appears nowhere, because none of these keywords is: the shipped
 * one is a Sysprose extension over a mechanism the specification defines, and
 * the foreign ones are somebody else's.
 */
function keywordLine(use: KeywordUse): string {
  const on = `on ${use.element.qualifiedName}`;
  switch (use.origin) {
    case 'sysprose':
      // A statement kind is read from the spelling, so it is a Sysprose keyword
      // in a file that declares no Sysprose package. Saying "→ " and nothing
      // after it, or worse "names nothing", would send a reader looking for a
      // misspelling in a tag this tool acted on.
      return use.resolvedTo
        ? `    sysprose vocabulary: #${use.keyword} ${on} → ${use.resolvedTo.qualifiedName}`
        : `    sysprose vocabulary: #${use.keyword} ${on} — read from the spelling;` +
            ` declare or import ${use.readBySpelling?.package ?? ''} to bind it`;
    case 'foreign':
      return (
        `    third-party spelling: #${use.keyword} read as ${use.foreign?.readAs ?? ''} ${on}` +
        ' — not SysML v2, not a Sysprose keyword' +
        // A foreign SPELLING that also names something in this model is two
        // facts, and printing one of them would tell a reader their own
        // definition was ignored.
        (use.resolvedTo ? `; it names ${use.resolvedTo.qualifiedName} here` : '')
      );
    case 'other':
      return `    other vocabulary: #${use.keyword} ${on} → ${use.resolvedTo?.qualifiedName ?? ''}`;
    default:
      return `    names nothing: #${use.keyword} ${on} resolves to no metadata definition in scope`;
  }
}

/**
 * The inventory block, or the sentence that says the file carries no keyword.
 *
 * The heading counts USES and distinct SPELLINGS separately: one `#exceptional`
 * on forty elements and forty different keywords are the same number under one
 * count and nothing alike to a reader deciding whether they are looking at a
 * vocabulary or at a typo.
 */
function keywordBlock(uses: readonly KeywordUse[]): string[] {
  const distinct = new Set(uses.map((u) => u.keyword)).size;
  return [
    `  keywords: ${uses.length} use(s) of ${distinct} distinct keyword(s) — an inventory; nothing here changes an obligation`,
    ...(uses.length === 0
      ? ['    this model carries no #keyword at all']
      : uses.map(keywordLine)),
  ];
}

function reportContracts(model: Model, name: string, args: ParsedArgs): Report {
  const scope = verificationScope(model, args);
  const keywords = flagGiven(args, 'keywords');
  const r = contractReport(model, {
    ...(scope ? { scopeId: scope.id } : {}),
    ...(keywords ? { keywords: true } : {}),
  });
  const guarantees = r.guaranteesQfLra + r.guaranteesQfNra + r.guaranteesUnsupported;
  // Counted inside the scope, like every other figure in this report: "no
  // contract was read, although this model declares 3 requirement-shaped
  // statement(s)" printed under `scoped to P::Sys` would be a sentence about a
  // population the listing above it was never about.
  const scopeIds = scope
    ? new Set<string>([scope.id, ...model.descendants(scope.id).map((d) => d.id)])
    : undefined;
  const requirementsInModel = model
    .all()
    .filter(
      (el) =>
        isUserElement(model, el) &&
        (el.eClass === 'RequirementDefinition' || el.eClass === 'RequirementUsage') &&
        (scopeIds === undefined || scopeIds.has(el.id)),
    ).length;
  const text = [
    `${name}: ${r.total} contract(s) on ${r.subjects} subject(s); ` +
      `${r.guaranteesQfLra} guarantee(s) in QF_LRA, ${r.guaranteesQfNra} in QF_NRA, ` +
      `${r.guaranteesUnsupported} unsupported`,
    ...(scope ? [`  scoped to ${qname(model, scope.id)}`] : []),
    // The line that keeps the command honest: it reports what is written, and
    // a reader must never take a row here for a verdict.
    '  an inventory of what is written — this command says nothing about whether any of it holds',
    ...(r.total === 0
      ? [
          requirementsInModel > 0
            ? `  no contract was read, although this model declares ${requirementsInModel} requirement-shaped statement(s) — see the exclusions below`
            : '  this model declares no requirement and no case objective',
        ]
      : []),
    ...r.contracts.flatMap((c) => [
      `  ${c.qualifiedName}${c.shortId ? ` (${c.shortId})` : ''}  [${c.eClass}]`,
      `    subject ${subjectLine(c.subject)}`,
      ...(c.assumptions.length + c.guarantees.length === 0
        ? [emptyClauseLine(c)]
        : [...c.assumptions, ...c.guarantees].flatMap(clauseLines)),
      ...edgeLines(c),
      ...(c.variables.length > 0
        ? [
            `    variables ${c.variables
              .map(
                (v) =>
                  `${v.path} (${v.role}${v.unit ? `, ${v.unit}` : ''}${
                    v.siFactor === 1 && v.siOffset === 0 ? '' : `, SI ×${v.siFactor}`
                  })`,
              )
              .join(', ')}`,
          ]
        : []),
      ...(c.keywords.length > 0 ? [`    keywords ${c.keywords.map((k) => `#${k}`).join(' ')}`] : []),
    ]),
    `  ${guarantees} guarantee(s) and ${r.assumptions} assumption(s) in total; ` +
      `${r.noFormalClause} contract(s) carry no formal clause`,
    `  ${r.nonNormativeExcluded} statement(s) tagged prose or prompt left out; ` +
      `${r.libraryExcluded} bundled library requirement(s) and ` +
      `${r.implicitExcluded} re-derived copy/copies excluded`,
    ...(r.keywordsAsked ? keywordBlock(r.keywords) : []),
    ...r.diagnostics.map((d) => `  ${d.code}  ${d.message}`),
  ].join('\n');
  return { json: r, text };
}

/** One worklist row: what it is, what it says, and whether it can be encoded. */
function obligationLines(o: Obligation): string[] {
  const id = o.shortId ? `${o.shortId}  ` : '';
  const what = o.expression === '' ? '(no constraint body)' : o.expression;
  const head = `  ${o.role.padEnd(10)} ${o.source.padEnd(13)} ${id}${what}`;
  const tail: string[] = [];
  if (o.encodable === true) {
    tail.push(
      `      encodable (${o.nonlinear ? 'nonlinear — NRA, may time out' : 'linear real arithmetic'})`,
    );
  } else {
    const refusal: Refusal = o.encodable;
    tail.push(`      not encodable: ${refusal.detail}`);
  }
  if (o.claimedVerdict !== undefined) {
    tail.push(`      claimed ${o.claimedVerdict}, no evidence`);
  }
  // The rule, not a nicety: a row a keyword filed prints the keyword that filed
  // it. A premise that appeared because somebody else's vocabulary said so, and
  // does not say so, is this lane letting a vocabulary it did not define change
  // what a proof stands on.
  if (o.provenance) {
    tail.push(`      from #${o.provenance.keyword} — ${o.provenance.note}`);
  }
  return [head, ...tail];
}

function reportObligations(model: Model, name: string, args: ParsedArgs): Report {
  const scope = verificationScope(model, args);
  const missing = flagGiven(args, 'missing');
  const fromKeywords = flagGiven(args, 'from-keywords');
  const r = obligationsReport(model, {
    ...(scope ? { scopeId: scope.id } : {}),
    ...(missing ? { missing: true } : {}),
    ...(fromKeywords ? { fromKeywords: true } : {}),
  });
  // `no-formal-clause` is not a gate refusal: nothing refused the body, there
  // is no body. It is counted with the refusals in the payload because it IS a
  // `RefusalReason`, and printed on its own line because a reader who sees it
  // under "refused by gate" goes looking for the gate.
  const refusals = Object.entries(r.refusedByReason)
    .filter(([reason]) => reason !== 'no-formal-clause')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const noFormalClause = r.refusedByReason['no-formal-clause'] ?? 0;
  const text = [
    `${name}: ${r.byRole.obligation} to show, ${r.byRole.premise} premise(s), ` +
      `${r.byRole.axiom} axiom(s) — ${r.total} row(s)`,
    ...(scope ? [`  scoped to ${qname(model, scope.id)}`] : []),
    // Storage state, never truth: this is the sentence the whole command hangs
    // on, and the parenthesis is why nothing is ever discharged today.
    '  what is stored, never what is true — nothing is discharged here because no evidence record exists yet',
    ...(r.fromKeywords
      ? [
          // `filedByKeyword`, never a count over `r.obligations`: under
          // `--missing` that listing is narrowed while every other figure on
          // this header is over the whole worklist, and the two together said
          // "0 row(s) filed by a keyword" three lines above a diagnostic naming
          // the keyword that filed one.
          `  reading third-party #precondition / #postcondition as clause roles — ` +
            `${r.filedByKeyword} row(s) filed by a keyword, each naming it`,
        ]
      : []),
    `  open ${r.byStatus.open} · no formal clause ${r.byStatus['no-formal-clause']} · ` +
      `not encodable ${r.byStatus['not-encodable']}`,
    ...(missing
      ? [
          `  showing the ${r.missing} row(s) this lane would not decide, of ${r.total}`,
          ...(r.missing === 0
            ? ['  every relation in this model is encodable, and every requirement has a body']
            : []),
        ]
      : []),
    ...(r.obligations.length === 0 && !missing
      ? ['  this model states no relation at all']
      : r.obligations.flatMap(obligationLines)),
    ...(refusals.length > 0
      ? [
          '  refused by gate:',
          ...refusals.map(([reason, n]) => `    ${reason.padEnd(22)} ${n}`),
        ]
      : ['  0 relation(s) refused by a gate']),
    ...(noFormalClause > 0
      ? [`  ${noFormalClause} requirement(s) carry no formal clause — no gate refused them`]
      : []),
    ...r.diagnostics.map((d) => `  ${d.code}  ${d.message}`),
  ].join('\n');
  return { json: r, text };
}

/* ────────────────────── property draft / property check ─────────────────── */

/**
 * `--element REF` on the two property subcommands, which REQUIRE it.
 *
 * Unlike `contracts` and `obligations`, whose default is the whole model, there
 * is no such thing as drafting a clause for every requirement at once: the
 * skeleton, the dictionary and the insertion point are all about one
 * requirement. A missing flag is therefore a usage error rather than a default,
 * and it is raised before the file is read — the same rule `prompts --element`
 * obeys, for the same reason.
 */
function propertyRef(args: ParsedArgs): string {
  const ref = flagValue(args, 'element');
  if (ref === undefined) {
    throw new UsageError('`--element REF` names the requirement to draft a clause for');
  }
  return ref;
}

/** The requirement a property subcommand is about, refusing a library element. */
function propertyElement(model: Model, args: ParsedArgs): ElementRecord {
  const ref = propertyRef(args);
  const el = resolveElementRef(model, ref);
  if (el.attrs.isLibrary === true) {
    throw new UsageError(
      `\`${ref}\` is a bundled standard-library element — a clause is drafted for a requirement in your own model`,
    );
  }
  return el;
}

/** `--clause TEXT`, which is the whole command: a run without it has nothing to judge. */
function propertyClause(args: ParsedArgs): string {
  const clause = flagValue(args, 'clause');
  if (clause === undefined || clause.trim() === '') {
    throw new UsageError('`--clause TEXT` is the clause to judge; there is nothing to check without it');
  }
  return clause;
}

/** One dictionary row, aligned so a reader can scan the units column. */
function dictionaryLine(entry: DictionaryEntry, width: number): string {
  const facets = [
    entry.type ?? '(untyped)',
    entry.unit !== null ? `[${entry.unit}]` : entry.dimension !== null ? '(no unit of its own)' : '',
    entry.dimension !== null ? `dim ${entry.dimension}` : '',
    `claim ${entry.claim}`,
    entry.value !== null ? `= ${entry.value}` : '(no value)',
    entry.numeric ? '' : '— not comparable as a number',
  ].filter((f) => f !== '');
  return `    ${entry.name.padEnd(width)}  ${facets.join('  ')}`;
}

function reportPropertyDraft(model: Model, name: string, args: ParsedArgs): Report {
  const el = propertyElement(model, args);
  let r: PropertyDraftReport;
  try {
    r = propertyDraft(model, el.id);
  } catch (err) {
    if (err instanceof PropertyRefError) throw new UsageError(err.message);
    throw err;
  }
  const width = Math.min(44, Math.max(8, ...r.dictionary.map((d) => d.name.length)));
  const text = [
    `${name}: ${r.requirement.qualifiedName}${r.shortId ? ` <${r.shortId}>` : ''} — the encodable skeleton`,
    `  subject   ${subjectLine(r.subject)}`,
    ...(r.statement !== ''
      ? ['  what the requirement says', ...promptTextLines(r.statement)]
      : ['  the requirement carries no prose — there is nothing for a clause to mean']),
    '  FRETish fields — three mandatory, three this tool cannot encode',
    ...r.fields.map((f) =>
      f.mandatory
        ? `    ${f.field.padEnd(10)} ${f.text}`
        : `    ${f.field.padEnd(10)} ${f.note}`,
    ),
    `  data dictionary — ${r.dictionary.length} legal name(s), always written through the subject`,
    ...(r.dictionary.length === 0
      ? ['    no valued feature is reachable from the subject: there is nothing to write a clause over']
      : r.dictionary.map((d) => dictionaryLine(d, width))),
    ...(r.existing.length > 0
      ? [
          `  clauses already on this requirement — ${r.existing.length}`,
          ...r.existing.map((c) => `    ${c.role} { ${c.expression} }`),
        ]
      : ['  this requirement carries no clause yet']),
    ...(r.prompts.length === 0
      ? ['  no #prompt reaches this requirement or its subject']
      : [
          `  authoring guidance — ${r.prompts.length} #prompt(s), verbatim`,
          ...r.prompts.flatMap((p) => [
            `    ${p.via.padEnd(6)} ${p.prompt.qualifiedName || label(p.prompt)}`,
            ...promptTextLines(p.text),
          ]),
        ]),
    ...(r.examples.length > 0
      ? [
          '  example clauses — shapes to edit, not bounds to keep',
          ...r.examples.map((e) => `    ${e}`),
        ]
      : []),
    '  skeleton',
    ...r.skeleton.split('\n').map((l) => `    ${l}`),
    '  limits',
    ...r.limits.map((l) => `    ${l}`),
    `  ${r.notice}`,
  ].join('\n');
  return { json: r, text };
}

/** One gate row: `gate 2  resolves in the subject scope  passed  …`. */
function gateLine(gate: GateResult): string {
  return `    gate ${gate.gate}  ${gate.name.padEnd(30)} ${gate.status.padEnd(8)} ${gate.detail}`;
}

/**
 * The one report that needs the SOURCE SPANS as well as the model.
 *
 * `ranges` comes from the same `loadModelText` call the model did, threaded
 * through `buildReport` rather than stashed in a module variable: the insertion
 * point is a fact about the text this run read, and a global holding "the last
 * file loaded" is how a second caller in one process gets a position into
 * somebody else's file.
 */
async function reportPropertyCheck(
  model: Model,
  name: string,
  args: ParsedArgs,
  text: string,
  ranges: ReadonlyMap<string, TextRange>,
): Promise<Report> {
  const el = propertyElement(model, args);
  const clause = propertyClause(args);
  let r: PropertyCheckReport;
  try {
    r = await propertyCheck(model, el.id, clause, { ranges, sourceText: text });
  } catch (err) {
    if (err instanceof PropertyRefError) throw new UsageError(err.message);
    throw err;
  }
  const head =
    r.outcome === 'refused'
      ? `refused at gate ${r.refusedAt}`
      : r.outcome === 'accepted-with-gap'
        ? 'accepted with a gap'
        : 'accepted';
  const body = [
    `${name}: ${r.requirement.qualifiedName}${r.shortId ? ` <${r.shortId}>` : ''} — ${head}`,
    `  clause    ${r.clause}`,
    ...(r.body !== r.clause ? [`  response  ${r.body}`] : []),
    ...(r.code !== null ? [`  ${r.code}`] : []),
    `  ${r.detail}`,
    '  gates',
    ...r.gates.map(gateLine),
    ...(r.reads.length > 0
      ? [
          `  reads ${r.reads.length} name(s)`,
          ...r.reads.map((x) => `    ${x.name} → ${x.qualifiedName}`),
        ]
      : []),
    ...(r.expected.length > 0 ? [`  did you mean: ${r.expected.join(', ')}`] : []),
    ...(r.backTranslation !== null
      ? ['  back-translation', `    ${r.backTranslation}`]
      : ['  no back-translation: the clause did not parse']),
    ...(r.insertion !== null
      ? [
          '  where it goes',
          r.range !== null
            ? `    line ${r.range.start.line}, column ${r.range.start.column}` +
              `${r.rangeNote !== '' ? ` — ${r.rangeNote}` : ''}`
            : `    ${r.rangeNote}`,
          `    ${r.indent}${r.insertion}`,
        ]
      : []),
    `  gate 4 answered by: ${r.solver.detail}`,
    '  limits',
    ...r.limits.map((l) => `    ${l}`),
    `  ${r.notice}`,
  ].join('\n');
  return { json: r, text: body };
}

/* ─────────────────────────────── verify ─────────────────────────────────── */

/** The three engine names, checked before the file is read. */
const ENGINES: readonly VerifyEngineOption[] = ['auto', 'literal', 'smt'];

/** `--engine`, refused rather than defaulted when it is not one of the three. */
function verifyEngine(args: ParsedArgs): VerifyEngineOption {
  const raw = flagValue(args, 'engine');
  if (raw === undefined) return 'auto';
  const found = ENGINES.find((e) => e === raw);
  if (!found) {
    throw new UsageError(`unknown --engine: ${raw} — one of ${ENGINES.join(', ')}`, true);
  }
  return found;
}

/**
 * `--free`, and the one combination that is refused outright.
 *
 * The literal engine evaluates AT the model's values, so a freed feature has no
 * value for it to read. Accepting the flag and ignoring it would print
 * `holds-at-values` under a bound the evidence record then claimed was in
 * force — a verdict about a design space nobody explored. It is refused with
 * exit 2, in the same spirit as `--include-library` on a report that cannot
 * honour it.
 */
function verifyFree(args: ParsedArgs, engine: VerifyEngineOption): string[] {
  const raw = flagValue(args, 'free');
  if (raw === undefined || raw.trim() === '') return [];
  const free = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (free.length > 0 && engine === 'literal') {
    throw new UsageError(
      '--free is an SMT-engine option: `--engine literal` evaluates at the model’s own values, so ' +
        'there is nothing for it to release. Ask for `--engine smt`, or drop --free.',
    );
  }
  return free;
}

/**
 * `--timeout MS`, refused rather than repaired when it is not a budget.
 *
 * No check in this lane is unbounded and there is no spelling for one, so a
 * `--timeout 0` or a `--timeout forever` is a usage error rather than a value
 * quietly replaced by the default: a reader who asked for a budget the tool did
 * not honour would read every `unknown` under a bound that was never in force.
 */
function verifyTimeout(args: ParsedArgs): number | undefined {
  const raw = flagValue(args, 'timeout');
  if (raw === undefined || raw.trim() === '') return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new UsageError(
      `--timeout must be a positive number of milliseconds; got ${raw}. Every check in this lane ` +
        'is bounded, so there is no spelling for "no timeout".',
    );
  }
  return ms;
}

/**
 * `--case REF`, resolved through the resolver every other `REF` flag uses.
 *
 * TWO REFUSALS, both exit 2, and both replacing an answer that would read as
 * true. A `REF` naming something that is not a verification case is refused BY
 * NAME rather than reported as a run with no case — the reader named an element
 * and this tool would otherwise judge the whole model and print a header that
 * never mentioned the word `case`. And a model with no verification case at all
 * says so, rather than reporting the requirements as though the case had been
 * checked. `resolveElementRef` supplies the third refusal — an ambiguous name
 * prints every match and picks none.
 */
function verifyCase(model: Model, args: ParsedArgs): ElementRecord | undefined {
  const ref = flagValue(args, 'case');
  if (ref === undefined || ref.trim() === '') return undefined;
  const el = resolveElementRef(model, ref.trim());
  if (!VERIFICATION_CASE_ECLASSES.has(el.eClass)) {
    const cases = verificationCasesOf(model);
    throw new UsageError(
      `--case \`${ref.trim()}\` resolves to ${qname(model, el.id)}, a ${el.eClass}, which is not a ` +
        'verification case: only a `verification def` or a `verification` usage carries a method ' +
        'and a verdict. ' +
        (cases.length === 0
          ? 'This model declares no verification case at all.'
          : `Cases in this model: ${cases.map((c) => qname(model, c.id)).join(', ')}.`),
    );
  }
  return el;
}

/** The two metaclasses `--case` accepts, spelled where the refusal is written. */
const VERIFICATION_CASE_ECLASSES: ReadonlySet<string> = new Set([
  'VerificationCaseDefinition',
  'VerificationCaseUsage',
]);

/** One verification case, as a person reads it. */
function caseLines(c: VerificationCaseVerdict): string[] {
  const id = c.shortId ? ` (${c.shortId})` : '';
  const method =
    c.method.declared.length > 0 || c.method.unrecognised.length > 0
      ? [...c.method.declared, ...c.method.unrecognised].join(', ')
      : 'none declared — judged on the analyze part';
  return [
    `  ${c.case.qualifiedName}${id}  verdict ${c.verdict}`,
    `    method: ${method}`,
    `    ${c.detail}`,
    ...(c.code !== null ? [`    ${c.code}`] : []),
    // WHICH SPELLING FOUND IT, on every row. `verify R by V;` declares an edge a
    // traceability matrix can see and `objective { verify R; }` declares none,
    // so a reader comparing this report with `trace --relation verify` has to be
    // told which rows that matrix could have shown them.
    ...c.verifies.map(
      (v) =>
        `    verifies ${v.requirement.qualifiedName} — via ${v.via === 'relationship' ? '`verify … by`' : '`objective { verify … }`'}`,
    ),
    ...c.dangling.map((d) => `    verifies nothing: ${d.reason}`),
    // The facet word is NOT the verdict word, and the difference is worth a
    // line: a point evaluation is a green run and may not be written into the
    // file as `pass`.
    ...(c.facet !== c.verdict
      ? [
          `    the file may record \`${c.facet}\`, not \`${c.verdict}\`: a verdict facet says \`pass\` only for a proof`,
        ]
      : []),
    ...c.changed.map(
      (ch) =>
        `    ${ch.requirement}: the file says \`${ch.claimed}\`, this run computes \`${ch.computed}\`` +
        (ch.overstates ? ' — the file claims more than this run showed' : ''),
    ),
  ];
}

/** One judged obligation, as a person reads it. */
function verdictLines(v: ObligationVerdict): string[] {
  const id = v.shortId ? ` (${v.shortId})` : '';
  const where = v.requirement?.qualifiedName ?? v.clause.qualifiedName;
  const what = v.expression === '' ? '(no constraint body)' : v.expression;
  return [
    `  ${where}${id}  ${what}`,
    `    ${v.claim}: ${v.detail}`,
    ...(v.code !== null ? [`    ${v.code}${v.forgiven ? ' — forgiven by --allow-inconclusive' : ''}`] : []),
    // A tautology is still proved and is still worth saying out loud: `x == x`
    // holds of every model, so it is evidence about arithmetic rather than
    // about this design.
    ...(v.tautology ? ['    tautology: true of every model, so it says nothing about this one'] : []),
    // The solver's own witness, in the magnitudes the file stores — for the two
    // claims it is the ARGUMENT for. A proof also carries one (step 2's
    // non-vacuity model), and printing every symbol of it under every proved
    // row buries the two rows where a reader has to check a number in twelve
    // exact rationals they cannot act on; the record keeps it either way.
    ...(v.witness.length > 0 && (v.claim === 'refuted' || v.claim === 'design-admitted')
      ? [`    witness: ${v.witness.map((w) => `${w.symbol} = ${w.term}`).join(', ')} (stored magnitudes)`]
      : []),
    // The assumptions are printed whether or not they mattered: a pass that
    // stands on three assumptions is a different claim from an unconditional
    // one, and a reader who is shown only the second cannot tell them apart.
    ...v.premises.map((p) => `    assuming \`${p.expression}\` — ${p.holds} at these values`),
    `    bound: ${v.bound.detail}`,
    `    digest ${v.obligationDigest}`,
  ];
}

/**
 * `verify` — the subcommand that judges, and the only one whose exit code is a
 * verdict.
 *
 * The header states the ENGINE first and the counts second, because the counts
 * mean different things under different engines: `2 discharged` under
 * `--engine literal` means "both hold at the values the file states", which is
 * not a proof and is labelled as one point of the design space on every row.
 */
async function reportVerify(
  model: Model,
  name: string,
  text: string,
  args: ParsedArgs,
  degraded: boolean,
): Promise<Report> {
  const engine = verifyEngine(args);
  const free = verifyFree(args, engine);
  const record = flagValue(args, 'record');
  if (record !== undefined && degraded) {
    // §3.10: the evidence write path refuses a degraded model at all. A record
    // is the DURABLE artefact — it outlives the process status that was the
    // only honest signal here — and one written over half a model would say
    // `holds-at-values` about a file the same run's stderr calls unreadable,
    // with a `modelVersion.graph` taken over the SALVAGED model, so a consumer
    // re-checking it against the same broken file would find it current. This
    // follows the `--include-library` precedent: a flag a run cannot honour is
    // refused, never accepted and quietly reinterpreted.
    throw new UsageError(
      `--record refuses a model that did not load cleanly: ${name} is degraded, and an evidence ` +
        'record over half a model is a durable claim about a file nobody could read. Fix the ' +
        'findings above, or drop --record and read the verdict on stdout.',
    );
  }
  const timeoutMs = verifyTimeout(args);
  const strictVacuity = flagGiven(args, 'strict-vacuity');
  const only = verifyCase(model, args);
  // A `--free` spelling this model cannot honour is a problem with what was
  // ASKED, and it is re-raised as one. `verifyModel` refuses it from the API's
  // side (an in-process caller needs the refusal too), and without this arm it
  // reached the terminal as `sysprose: internal error:` over four stack frames
  // — the same shape `--out` naming a directory used to have, and the same
  // reading it gave a person: the tool is broken, rather than the argument is.
  let r: VerifyReport;
  try {
    r = await verifyModel(model, {
      engine,
      free,
      allowInconclusive: flagGiven(args, 'allow-inconclusive'),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(strictVacuity ? { strictVacuity: true } : {}),
      ...(only !== undefined ? { caseId: only.id } : {}),
      sourceText: text,
      // The command a reader can re-run to get this record — INCLUDING the
      // flags that changed what was shown. `--free` above all: a proof under a
      // released feature value is a different claim, and a `producedBy` that
      // dropped it would print a command whose output is not the record beside
      // it.
      producedBy:
        `npm run sysprose -- verify ${name} --engine ${engine}` +
        // `--case` belongs in the reproducible command for the same reason
        // `--free` does: it changes WHICH obligations the records are about, so
        // a `producedBy` that dropped it would print a command whose output is
        // a different set of records from the ones beside it.
        (only !== undefined ? ` --case ${qname(model, only.id)}` : '') +
        free.map((f) => ` --free ${f}`).join('') +
        (timeoutMs !== undefined ? ` --timeout ${timeoutMs}` : '') +
        (strictVacuity ? ' --strict-vacuity' : ''),
    });
  } catch (err) {
    if (err instanceof VerifyOptionError) throw new UsageError(err.message);
    throw err;
  }

  if (record !== undefined) {
    try {
      mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, `${JSON.stringify(r.records, null, 2)}\n`);
    } catch (err) {
      throw new UsageError(
        `cannot write ${record}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const rendered = [
    // The INCONCLUSIVE count leads (§2). A reader scanning one line must see
    // the undecided figure before the green one: `2 discharged, 0 refuted, 1
    // inconclusive` reads as a pass with a footnote, and the footnote is the
    // part that decides the exit code.
    `${name}: ${r.inconclusive} inconclusive, ${r.discharged} discharged, ${r.violated} refuted` +
      `${r.designAdmitted > 0 ? `, ${r.designAdmitted} design-admitted` : ''}` +
      ` — engine ${r.engine}${r.engineAsked !== r.engine ? ` (asked for ${r.engineAsked})` : ''}`,
    // The sentence that keeps the whole command honest, and it is engine-shaped:
    // a point evaluation may never be read as a proof, and a run with no engine
    // may never be read as a clean one. The exit code in it is READ OFF the
    // report rather than typed: the sentence used to hard-code "exit 2" while
    // `exitCodeOf` could still return 0 over an empty row set, so a run printed
    // one number and exited with another.
    // Three engines' worth of sentence, because there are three states and the
    // reader has to be able to tell them apart from the first line: a point
    // evaluation, a solver that ran, and no solver at all. The middle one is
    // new in commit 5 and is the only one under which `proved` may appear.
    r.engine === 'literal'
      ? '  a point evaluation at the model’s own values — `holds-at-values`, never `proved`'
      : r.toolAbsent
        ? `  no solver ran: every obligation below is reported as undecided, and this run is exit ${r.exitCode}`
        : `  negation-unsat under a satisfiable axiom set — \`proved\` means exactly that, at ${r.timeoutMs ?? 0} ms per check` +
          (r.free.length > 0
            ? `, with ${r.free.join(', ')} released: a refutation under \`--free\` is a design the model admits, not a violation of it`
            : ', with every feature value bound as the model states it'),
    ...(r.allowInconclusive
      ? [
          `  --allow-inconclusive forgave ${r.forgiven} of ${r.inconclusive} inconclusive row(s) — ` +
            'it lowers the undecided codes only, never an absent solver, a vacuous obligation or a violation',
        ]
      : []),
    ...(r.vacuous > 0
      ? [
          `  ${r.vacuous} obligation(s) vacuous — discharged by an antecedent that does not hold; ` +
            'this tool reports that as undecided, which is a declared deviation (docs/CONFORMANCE.md)' +
            (r.strictVacuity
              ? '; --strict-vacuity raises each of them to `verification/vacuous-property`, an error, and changes no exit code'
              : ''),
        ]
      : []),
    ...(r.results.length === 0
      ? [
          only !== undefined
            ? `  ${qname(model, only.id)} judged no obligation — a case that checked nothing has not ` +
              'passed, which is exit 2'
            : '  this model states no obligation at all — there was nothing to verify, ' +
              'which is exit 2: exit 0 means every obligation was discharged, and none was',
        ]
      : r.results.flatMap(verdictLines)),
    // The cases LAST, under the obligations they stand on, because a case
    // verdict is a roll-up of rows the reader has just read. A model that
    // declares none prints nothing here rather than a zero: "0 verification
    // cases" and "the cases all passed" are different facts and the second is
    // the one a blank line must not be read as.
    ...(r.cases.cases.length > 0
      ? [
          `  ${r.cases.cases.length} verification case(s): ${r.cases.passed} pass, ${r.cases.failed} fail, ` +
            `${r.cases.inconclusive} inconclusive` +
            (r.cases.notPerformed > 0
              ? `, of which ${r.cases.notPerformed} not judged at all — this tool performs analysis only`
              : ''),
          ...r.cases.cases.flatMap(caseLines),
        ]
      : []),
    `  model ${r.modelVersion.graph}`,
    `  ${r.modelVersion.sysprose.name} ${r.modelVersion.sysprose.version}` +
      `${r.modelVersion.sysprose.git ? ` (git ${r.modelVersion.sysprose.git.slice(0, 12)})` : ' (no git commit — none was found, and none is invented)'}` +
      ` · standard library ${r.modelVersion.library} element(s)`,
    ...(record !== undefined ? [`  ${r.records.length} evidence record(s) written to ${record}`] : []),
    ...r.diagnostics.map((d) => `  ${d.code}  ${d.message}`),
  ].join('\n');
  return { json: r, text: rendered, verify: r };
}

/* ────────────────────────────── consistency ─────────────────────────────── */

/**
 * `--max-core N`, refused rather than repaired when it is not a budget.
 *
 * The same shape as `--timeout`: a bound the tool did not honour would let a
 * reader believe a deletion loop ran when it did not, and "a conflicting
 * subset" and "a minimal conflicting subset" are different claims about a
 * model. A budget of zero is a spelling for "never minimise", which is what
 * omitting `--minimize` already says, so it is a usage error rather than a
 * silent no-op.
 */
function consistencyMaxCore(args: ParsedArgs): number | undefined {
  const raw = flagValue(args, 'max-core');
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(
      `--max-core must be a positive whole number of core members; got ${raw}. It is the deletion ` +
        'loop’s budget — one solver check per member — and a budget the tool did not honour would ' +
        'let a core read as minimal when nothing reduced it.',
    );
  }
  return n;
}

/**
 * The subject a run was narrowed to, or `undefined`.
 *
 * A library element is refused for the same reason `--element` refuses one:
 * the bundled library's requirements are not the reader's, this report is of
 * their model, and narrowing to one would answer about a requirement set they
 * cannot edit.
 */
function consistencySubject(model: Model, args: ParsedArgs): ElementRecord | undefined {
  const ref = flagValue(args, 'subject');
  if (ref === undefined) return undefined;
  const el = resolveElementRef(model, ref);
  if (el.attrs.isLibrary === true) {
    throw new UsageError(
      `\`${ref}\` is a bundled standard-library element — this report is of your model, and every figure in it excludes the library`,
    );
  }
  return el;
}

/** One requirement set, as a person reads it. */
function consistencyLines(group: ConsistencyGroup): string[] {
  const where =
    group.subject?.typeQualifiedName ?? group.subject?.typeRef ?? 'no declared subject';
  return [
    `  subject ${where}${group.subject ? ` (as \`${group.subject.name}\`)` : ''} — ${group.outcome}`,
    `    ${group.detail}`,
    ...(group.code !== null ? [`    ${group.code}`] : []),
    // The subset, one member per line, each named the two ways the report
    // names it: by the requirement a reader knows it by, and by the qualified
    // name of the relation itself. A core printed as one comma-joined string
    // is a core nobody reads past the third member.
    ...(group.core.length > 0
      ? [
          `    ${group.coreLabel}, ${group.core.length} member(s):`,
          ...group.core.map(
            (m) =>
              `      ${m.requirement?.shortId || m.requirement?.qualifiedName || m.qualifiedName}  ` +
              `${m.expression || '(no relation body)'}  [${m.kind}: ${m.qualifiedName}]`,
          ),
        ]
      : []),
    // The design point as a NUMBER: z3 answers in exact rationals and prints
    // them as `(/ 37.0 2.0)`, and a witness a reader has to divide by hand is
    // a witness they do not read. The exact term is on the payload.
    ...(group.witness.length > 0
      ? [
          `    witness: ${group.witness.map((w) => `${w.symbol} = ${witnessNumber(w)}`).join(', ')} (stored magnitudes)`,
        ]
      : []),
    ...group.unengageable.map(
      (u) =>
        `    ${u.shortId || u.qualifiedName}  applies at no point this set admits — ` +
        `assume ${u.assumptions.map((a) => `\`${a}\``).join(' and ')}`,
    ),
    ...group.requirements.map(
      (r) =>
        `    ${r.shortId || r.qualifiedName}  ${r.asserted} relation(s) asserted, ${r.refused} refused` +
        (r.asserted + r.refused === 0 ? ' — prose only, nothing to encode' : ''),
    ),
  ];
}

/**
 * `consistency` — the second subcommand that judges, and the one whose exit 1
 * is about a requirement SET rather than about one obligation.
 *
 * The header states the MODE first, because every figure under it means
 * something different in the other one: with the file's literal values released
 * the answer is about the requirement set, and under `--with-values` it is
 * about the requirement set together with the design point the file states.
 * A reader who cannot see which of the two they are holding has been given a
 * verdict they cannot use.
 */
async function reportConsistency(
  model: Model,
  name: string,
  text: string,
  args: ParsedArgs,
): Promise<Report> {
  const subject = consistencySubject(model, args);
  const maxCore = consistencyMaxCore(args);
  const withValues = flagGiven(args, 'with-values');
  const minimize = flagGiven(args, 'minimize');
  const r = await consistencyReport(model, {
    ...(subject ? { subjectId: subject.id } : {}),
    ...(withValues ? { withValues: true } : {}),
    ...(minimize ? { minimize: true } : {}),
    ...(maxCore !== undefined ? { maxCore } : {}),
    allowInconclusive: flagGiven(args, 'allow-inconclusive'),
    sourceText: text,
  });

  // A SUBJECT THAT SELECTED NOTHING IS A USAGE ERROR, not a statement about the
  // model. The run-wide sentence below says the file states no requirement set
  // at all, and printing that because a `--subject` matched none of them would
  // be a false claim about the reader's file in the one place they went looking
  // for a true one.
  if (subject !== undefined && r.groups.length === 0) {
    throw new UsageError(
      `\`${qname(model, subject.id)}\` is not the subject of any requirement in this file, and no ` +
        'requirement is written about a type it conforms to — so there is no requirement set to ' +
        'answer about. Name the subject’s TYPE (a type answers for its subtypes), or run without ' +
        '`--subject` to see every set this file states.',
    );
  }

  const rendered = [
    // The two undecided-or-failing figures lead, for the reason §2 gives for
    // `verify`: a line that opened with the green number reads as a pass with a
    // footnote, and the footnote is what decides the exit code.
    `${name}: ${r.inconsistent} inconsistent, ${r.inconclusive} inconclusive, ${r.consistent} consistent` +
      ` — ${r.requirements} requirement(s) on ${r.groups.length} subject(s)`,
    r.toolAbsent
      ? `  no solver ran: satisfiability is not a question the model’s own values can answer, so there is ` +
        `no point-evaluation engine to fall back to and this run is exit ${r.exitCode}`
      : withValues
        ? '  asked at the model’s own values (`--with-values`): the answer is about this requirement set ' +
          'TOGETHER WITH the design point the file states, which is the weaker of the two questions'
        : `  asked with every literal feature value released (${r.released.length} of them): a consistency ` +
          'question about a requirement set is not answered by the values that happen to be in the file — ' +
          '`--with-values` asks the other one',
    // THE READING, on the run as well as on every verdict line. "Consistent"
    // under `assume ⇒ require` and under `assume ∧ require` are different
    // claims about a model, and this is the one the shipped library states —
    // the same one `verify` reads the same file under.
    `  ${READING}, as \`Requirements::RequirementCheck\` states it — mode- and phase-conditional ` +
      'requirements are not in conflict merely because their assumptions cannot both hold',
    ...(r.unengageable > 0
      ? [
          `  ${r.unengageable} requirement(s) apply at no point their own set admits — satisfied for ` +
            'free by an assumption the rest of the set rules out. A set that holds only because a ' +
            'requirement in it never applies is undecided, not consistent: vacuity is inconclusive ' +
            'here as it is under `verify`, and no flag lowers it',
        ]
      : []),
    ...(r.refused > 0
      ? [
          `  ${r.refused} relation(s) refused by a gate and not asserted — an inconsistency found without ` +
            'them is still an inconsistency, and a set called consistent without them may be excluded by ' +
            'the very relation that was refused',
        ]
      : []),
    ...(r.noFormalClause > 0
      ? [`  ${r.noFormalClause} requirement(s) carry prose and no relation — no gate refused them`]
      : []),
    ...(r.allowInconclusive
      ? [
          `  --allow-inconclusive forgave ${r.forgiven} of ${r.inconclusive} undecided set(s) — it lowers ` +
            'the undecided codes only, never an absent solver, never an inconsistency, and never a run in ' +
            'which nothing at all was decided',
        ]
      : []),
    ...(r.groups.length === 0
      ? [
          '  this model states no requirement set at all — there was nothing to answer, which is ' +
            'exit 2: exit 0 means every requirement set was shown satisfiable, and none was',
        ]
      : r.groups.flatMap(consistencyLines)),
    ...(r.groups.length > 0 && r.consistent + r.inconsistent === 0
      ? [
          '  nothing was decided: exit 0 says every requirement set was shown satisfiable, and none ' +
            'of these was, so this run is exit 2 with `--allow-inconclusive` and without it',
        ]
      : []),
    ...(r.toolAbsent
      ? []
      : [`  ${r.checks} solver check(s) at ${r.timeoutMs ?? 0} ms each`]),
    `  model ${r.modelVersion.graph}`,
    ...r.diagnostics.map((d) => `  ${d.code}  ${d.message}`),
  ].join('\n');
  return { json: r, text: rendered, consistency: r };
}

/* ──────────────────────────────── refine ────────────────────────────────── */

/** The `--via` families this build actually answers. */
const VIA_ANSWERED: readonly RefinementVia[] = ['composition'];

/** Every `--via` family the plan names, answered or not. */
const VIA_VALUES: readonly RefinementVia[] = ['composition', 'derive', 'refine', 'all'];

/**
 * `--via KIND`, refused rather than silently answered as something else.
 *
 * `derive`, `refine` and `all` are named by the plan and are a later commit's
 * work. A run that accepted one and reported over the composition edges anyway
 * would answer a question nobody asked, and one that accepted it and reported
 * nothing would say the model states no derivation — a false claim about the
 * reader's file. Both are worse than a usage error, so this is a usage error.
 */
function refineVia(args: ParsedArgs): RefinementVia | undefined {
  const raw = flagValue(args, 'via');
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  if ((VIA_ANSWERED as readonly string[]).includes(value)) return value as RefinementVia;
  if ((VIA_VALUES as readonly string[]).includes(value)) {
    throw new UsageError(
      `\`--via ${value}\` is not answered by this build: only \`composition\` is. Derivation and ` +
        'refinement edges are a later commit of the verification plan, and reporting nothing over ' +
        'them would read as a model that states none.',
    );
  }
  throw new UsageError(
    `--via must be one of ${VIA_VALUES.join(', ')}; got \`${raw}\`. This build answers ` +
      `${VIA_ANSWERED.join(', ')}.`,
  );
}

/**
 * The decomposition a run was narrowed to, or `undefined`.
 *
 * A library element is refused for the same reason `--element` refuses one
 * everywhere else in this command: the bundled library's contracts are not the
 * reader's, and narrowing to one would answer about an architecture they cannot
 * edit.
 */
function refineElement(model: Model, args: ParsedArgs): ElementRecord | undefined {
  return verificationScope(model, args);
}

/** One decomposition, as a person reads it. */
function refinementLines(group: RefinementGroup): string[] {
  return [
    `  ${group.shortId || group.system.qualifiedName} on \`${group.part.qualifiedName}\` — ${group.outcome}`,
    `    ${group.detail}`,
    ...(group.code !== null ? [`    ${group.code}`] : []),
    `    ${group.components.length} sub-contract(s): ${group.components
      .map((c) => `${c.shortId || c.contract.qualifiedName} on \`${c.part.qualifiedName}\``)
      .join(', ')}`,
    // Each obligation on its own line, named by which of Cimatti's two it is
    // and by the component it is about: a decomposition whose rows were folded
    // into one sentence is a decomposition a reader cannot act on.
    ...group.obligations.map(
      (o) =>
        `      ${o.kind === 'composition' ? 'obligation (3)' : `obligation (4) ${o.component?.qualifiedName ?? ''}`}` +
        `  ${o.outcome}${o.code !== null ? ` [${o.code}]` : ''}`,
    ),
    ...group.obligations
      .filter((o) => o.witness.length > 0)
      .map(
        (o) =>
          `      witness: ${o.witness.map((w) => `${w.symbol} = ${witnessNumber(w)}`).join(', ')} (stored magnitudes)`,
      ),
    // The equalities γ actually asserted, so a reader can see WHICH statements
    // of their model joined the quantities the obligations turned on.
    ...(group.gamma.length > 0
      ? [
          `    γ, ${group.gamma.length} equalit${group.gamma.length === 1 ? 'y' : 'ies'}:`,
          ...group.gamma.map((g) => `      ${g.kind}  ${g.expression}`),
        ]
      : ['    γ asserted no equality at all']),
    ...(group.notEncoded.length > 0
      ? [
          `    ${group.notEncoded.length} connection(s) not encoded as equalities:`,
          ...group.notEncoded.map((c) => `      ${c.qualifiedName}  ${c.hint}`),
        ]
      : []),
  ];
}

/**
 * `refine` — the third subcommand that judges, and the one whose exit 1 is
 * about an ARCHITECTURE rather than about one obligation or one requirement set.
 *
 * The header states what γ was built from first, because every verdict under it
 * means something different otherwise: the same model wired with `bind` and
 * wired with bare `connect` produces the same contracts and different answers,
 * and a reader who cannot see which equalities were asserted has been given a
 * verdict they cannot use.
 */
async function reportRefinement(
  model: Model,
  name: string,
  text: string,
  args: ParsedArgs,
): Promise<Report> {
  const element = refineElement(model, args);
  const via = refineVia(args);
  const connectionsAsEqualities = flagGiven(args, 'connections-as-equalities');
  const r = await refinementReport(model, {
    ...(element ? { elementId: element.id } : {}),
    ...(via !== undefined ? { via } : {}),
    ...(connectionsAsEqualities ? { connectionsAsEqualities: true } : {}),
    allowInconclusive: flagGiven(args, 'allow-inconclusive'),
    sourceText: text,
  });

  // AN `--element` THAT SELECTED NOTHING IS A USAGE ERROR, not a statement
  // about the model — the same rule `consistency --subject` obeys, for the same
  // reason: the run-wide sentence below says the file states no decomposition
  // at all, and printing that because a REF matched none of them would be a
  // false claim about the reader's file.
  if (element !== undefined && r.groups.length === 0) {
    throw new UsageError(
      `\`${qname(model, element.id)}\` names no decomposition in this file: no requirement is ` +
        'satisfied by a part that owns another contract-bearing part here. A decomposition needs ' +
        'both halves — `satisfy R by sys;` on the whole and `satisfy R2 by sys.part;` on a part — ' +
        'so name one of those, or run without `--element` to see every decomposition this file states.',
    );
  }

  const rendered = [
    // The two undecided-or-failing figures lead, for the reason §2 gives for
    // `verify`: a line that opened with the green number reads as a pass with a
    // footnote, and the footnote is what decides the exit code.
    `${name}: ${r.notRefined} not refined, ${r.vacuous} vacuous, ${r.inconclusive} inconclusive, ` +
      `${r.refined} refined — ${r.groups.length} decomposition(s) over ${r.contracts} contract(s)`,
    r.toolAbsent
      ? `  no solver ran: a refinement obligation is a claim about every implementation the contracts ` +
        `admit, so the model’s own values cannot answer it and there is nothing to fall back to — ` +
        `this run is exit ${r.exitCode}`
      : `  obligations are Cimatti’s Theorem 1 in normal form (\`nf(C) = ¬A ∨ G\`), preceded by the ` +
        'satisfiability precondition step (0): bare guarantees are unsound under mutual support, and ' +
        'an unsatisfiable antecedent entails everything',
    `  γ, the connection assertion: ${r.bindEqualities} bind equalit${r.bindEqualities === 1 ? 'y' : 'ies'}, ` +
      `${r.itemFlows} item flow(s)` +
      (r.connectionsAsEqualities
        ? `, ${r.connectionEqualities} connection equalit${r.connectionEqualities === 1 ? 'y' : 'ies'} — ` +
          '`--connections-as-equalities` read bare `connect` edges as value equalities, which is the ' +
          'OCRA reading and not this tool’s default'
        : `; ${r.notEncoded} connection(s) NOT encoded — a connection is not an equality; bind the ` +
          'attributes if they are one quantity'),
    ...(r.refused > 0
      ? [
          `  ${r.refused} relation(s) refused by a gate and not asserted — a refused conjunct of a ` +
            'system contract stands its whole decomposition down as undecided, and a refused `assume` ' +
            'conjunct keeps a component out of the premise set, because dropping either one would ' +
            'buy the verdict rather than cost it',
        ]
      : []),
    ...(r.allowInconclusive
      ? [
          `  --allow-inconclusive forgave ${r.forgiven} of ${r.inconclusive} undecided decomposition(s) — ` +
            'it lowers the undecided codes only, never an absent solver, never a vacuous contract set, ' +
            'and never a refuted obligation',
        ]
      : []),
    ...(r.groups.length === 0
      ? [
          '  this model states no decomposition at all — no requirement is satisfied by a part that ' +
            'owns another contract-bearing part, so there was nothing to answer, which is exit 2',
        ]
      : r.groups.flatMap(refinementLines)),
    ...(r.groups.length > 0 && r.refined + r.notRefined === 0
      ? [
          '  nothing was decided: exit 0 says every decomposition was shown to refine, and none of ' +
            'these was, so this run is exit 2 with `--allow-inconclusive` and without it',
        ]
      : []),
    ...(r.toolAbsent ? [] : [`  ${r.checks} solver check(s) at ${r.timeoutMs ?? 0} ms each`]),
    '  this is the propositional and numeric shape of refinement, not a temporal one: nothing here ' +
      'is claimed about ordering or time',
    `  model ${r.modelVersion.graph}`,
    ...r.diagnostics.map((d) => `  ${d.code}  ${d.message}`),
  ].join('\n');
  return { json: r, text: rendered, refinement: r };
}

/* ─────────────────────────────── evidence ───────────────────────────────── */

/**
 * The model as text — the reader's own roots, never the bundled library.
 *
 * `serializeModel` writes every root, and after a `--library full` load that is
 * 38 000 library elements ahead of the reader's twelve. The app's Text view has
 * had the same filter since it shipped (`userRootIds` in `src/ui/store.ts`);
 * this is the terminal's copy of it, and it is the reason `evidence-attach`
 * can write its output back over the file it read.
 */
function modelText(model: Model): string {
  return model
    .rootIds()
    .filter((id) => model.get(id)?.attrs.isLibrary !== true)
    .map((id) => serializeElement(model, id, 0))
    .join('\n\n');
}

/**
 * The records named by `--from`, validated before anything is written.
 *
 * VALIDATED, NOT TRUSTED. The file is JSON somebody can edit, and a record is
 * about to become a durable claim inside a model — so it is checked against
 * `docs/schemas/evidence-record.schema.json`, the same schema the L8 corpus
 * checks `verify --record` output against, and the whole attach is refused if
 * any record fails. Half an attach is worse than none: the file would then
 * carry evidence for some obligations and not others, with nothing saying which.
 */
function loadRecords(path: string): EvidenceRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `${path} is not JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        'It should be the array `verify --record PATH` wrote.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError(
      `${path} holds ${parsed === null ? 'null' : typeof parsed}, not an array of records — ` +
        '`verify --record PATH` writes one record per obligation, as a JSON array.',
    );
  }
  // Resolved from THIS FILE, not from `process.cwd()`. The schema is a repo
  // asset rather than something the caller named, and a bare relative path
  // would make `evidence-attach` work only when the process happened to start
  // at the package root — which `npm run sysprose --` always does and a direct
  // `tsx scripts/sysprose.ts` from anywhere else does not. The short spelling
  // is kept for the message, because that is the path a reader would look up.
  const schemaPath = 'docs/schemas/evidence-record.schema.json';
  const schemaFile = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', schemaPath);
  let validate: ReturnType<Ajv['compile']>;
  try {
    validate = new Ajv({ allErrors: true, strict: false }).compile(
      JSON.parse(readFileSync(schemaFile, 'utf8')) as object,
    );
  } catch (err) {
    throw new UsageError(
      `cannot read ${schemaPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const problems: string[] = [];
  parsed.forEach((record, i) => {
    if (!validate(record)) {
      for (const e of validate.errors ?? []) {
        problems.push(`  record ${i}${e.instancePath}: ${e.message ?? 'is invalid'}`);
      }
      return;
    }
    // THE ONE RULE THE SCHEMA CANNOT STATE. `verdict` and `claim` are two
    // enumerations the schema checks independently, so a record reading
    // `{"claim":"holds-at-values","verdict":"pass"}` is valid JSON against it
    // and is nonetheless a laundered claim: `pass` is written for `proved`
    // alone. `attachEvidence` derives the verdict it writes and would silently
    // correct this one, but silence is the wrong answer to a file that says
    // something untrue — the reader has a record file to fix, and is told so.
    const r = record as EvidenceRecord;
    const derived = verdictFor(r.claim);
    if (r.verdict !== derived) {
      problems.push(
        `  record ${i}/verdict: says \`${r.verdict}\` over the claim \`${r.claim}\`, which is ` +
          `\`${derived}\` — \`pass\` is written for \`proved\` alone and \`fail\` for \`refuted\``,
      );
    }
  });
  if (problems.length > 0) {
    throw new UsageError(
      `${path} does not hold evidence records this tool wrote:\n${problems.slice(0, 10).join('\n')}` +
        (problems.length > 10 ? `\n  … ${problems.length - 10} more` : '') +
        `\nEvery record is checked against ${schemaPath}, and nothing is written unless all of them pass.`,
    );
  }
  return parsed as EvidenceRecord[];
}

/** `--from`, which `evidence-attach` cannot do without. */
function attachFrom(args: ParsedArgs): string {
  const from = flagValue(args, 'from');
  if (from === undefined || from === '') {
    throw new UsageError(
      '--from PATH is required: it names the JSON array `verify --record PATH` wrote. ' +
        'There is no default, because a run that attached nothing would report a file it had not changed.',
      true,
    );
  }
  return from;
}

/**
 * A model that did not load cleanly is never written back.
 *
 * The same refusal `verify --record` makes and for a stronger reason: `--record`
 * writes a claim BESIDE the file, and this writes the FILE. A degraded load
 * salvaged what it could parse, so serializing it back is a lossy rewrite of
 * somebody's source with the unreadable parts re-emitted verbatim and
 * everything the mapper dropped simply gone.
 */
function refuseDegradedWrite(cmd: string, name: string, degraded: boolean): void {
  if (!degraded) return;
  throw new UsageError(
    `${cmd} refuses a model that did not load cleanly: ${name} is degraded, and writing it back ` +
      'would replace your source with what this tool managed to salvage. Fix the findings above first.',
  );
}

function reportEvidenceStatus(model: Model, name: string): Report {
  const r: EvidenceStatusReport = evidenceStatus(model);
  const text = [
    `${name}: ${r.stale} stale, ${r.current} current, ${r.unrecorded} unrecorded` +
      `${r.overstated > 0 ? `, ${r.overstated} overstated` : ''} — model ${r.graph}`,
    // The sentence that keeps this command honest. A record says what an engine
    // claimed; it never says more than that, and the display may not either.
    '  a record is shown with the claim it was made under — `holds-at-values` is never shown as `proved`',
    ...(r.rows.length === 0
      ? ['  nothing in this file states a verdict or carries a record']
      : r.rows.map(
          (row) =>
            `  ${row.shortId !== '' ? `<${row.shortId}> ` : ''}${row.qualifiedName}  ${row.status}` +
            `${row.code !== undefined ? `  ${row.code}` : ''}\n      ${row.detail}` +
            (row.slice.length > 0 ? `\n      slice: ${row.slice.join(', ')}` : ''),
        )),
  ].join('\n');
  return { json: r, text };
}

/**
 * One case's contribution to an attach, in the payload as well as on stderr.
 *
 * `attachEvidence` reports what the RECORDS did; this reports what the CASE
 * layer did on top of them, and the two together are what the written file
 * says. Published rather than left on stderr because a machine consumer reads
 * stdout: a payload whose `changes` were empty for a facet the case layer had
 * just moved would be a report of a file that does not exist.
 */
interface CaseVerdictWrite {
  case: string;
  verdict: 'pass' | 'fail' | 'inconclusive';
  written: WriteVerdictReport['written'];
  changes: WriteVerdictReport['changes'];
  skipped: WriteVerdictReport['skipped'];
  methodWritten: boolean;
}

/**
 * The rows a record file states, in the shape the case layer reads.
 *
 * A record carries QUALIFIED NAMES and never element ids (D3 — ids are fresh on
 * every load), so the elements are looked up by name in the model that was just
 * written; a record naming something this file does not have is dropped here
 * exactly as `attachEvidence` skipped it. `discharged` is reconstructed from the
 * claim AND the engine that made it, because the two disagree on one word:
 * `holds-at-values` is a discharge under `--engine literal`, which was asked for
 * by name, and is not one under `--engine smt`.
 */
function judgedFromRecords(model: Model, records: readonly EvidenceRecord[]): JudgedObligation[] {
  const byName = new Map<string, ElementRecord>();
  for (const el of model.all()) {
    const qn = qname(model, el.id);
    if (qn !== '' && !byName.has(qn)) byName.set(qn, el);
  }
  const rows: JudgedObligation[] = [];
  for (const record of records) {
    const requirement = record.obligation.requirement;
    if (requirement === null || requirement === '') continue;
    const req = byName.get(requirement);
    const clause = byName.get(record.obligation.clause);
    if (!req || !clause) continue;
    rows.push({
      requirement: { id: req.id, qualifiedName: requirement },
      shortId: record.obligation.shortId,
      clause: { id: clause.id, qualifiedName: record.obligation.clause },
      expression: record.obligation.expression,
      claim: record.claim,
      discharged:
        record.claim === 'proved' ||
        (record.engine === 'literal' && record.claim === 'holds-at-values'),
      code: record.code ?? null,
      detail: record.detail,
    });
  }
  return rows;
}

/**
 * The CASE half of an attach: the verdict facet a case reaches, and the one
 * standard annotation this lane writes.
 *
 * WHY IT LIVES HERE AND NOT IN `attachEvidence`. A record is about one
 * OBLIGATION; a case verdict is about a set of them, and the set is stated in
 * the model rather than in the record file. So the records are re-read as the
 * rows they are, the case layer rolls them up exactly as `verify` did, and
 * {@link writeVerdict} writes what follows — the facet on each requirement the
 * case verifies, and `@VerificationCases::VerificationMethod { kind = analyze; }`
 * on a case that declared no method, so the file says which method the verdict
 * was reached under rather than leaving a reader to assume it.
 *
 * TWO CASES ARE SKIPPED, and both refusals are the plan's. A case the method
 * gate did not judge gets nothing written for it at all — that is what the gate
 * is for. And a case carrying `verification/no-property` gets nothing either: it
 * verifies requirements this run said nothing about, and writing `inconclusive`
 * over them would replace evidence with the absence of it.
 *
 * Every facet this MOVES is printed, on stderr, beside the ones the record
 * attach moved: a verdict that changes silently is the one thing this lane may
 * never do.
 */
function writeCaseVerdicts(model: Model, records: readonly EvidenceRecord[]): CaseVerdictWrite[] {
  const out: CaseVerdictWrite[] = [];
  const judged = judgedFromRecords(model, records);
  if (judged.length === 0) return out;
  for (const c of runVerificationCases(model, { judged }).cases) {
    if (!c.judged || c.code !== null) continue;
    const w = writeVerdict(model, c);
    out.push({
      case: c.case.qualifiedName,
      verdict: c.facet,
      written: w.written,
      changes: w.changes,
      skipped: w.skipped,
      methodWritten: w.methodWritten,
    });
    // EVERY REQUIREMENT WRITTEN IS NAMED, not only the ones whose facet moved.
    // A facet written onto a requirement that carried none is still this tool
    // putting a verdict in somebody's file, and the count alone does not say
    // which requirement it landed on.
    for (const written of w.written) {
      process.stderr.write(
        `sysprose evidence-attach: ${written.requirement} — verdict ${written.verdict} ` +
          `written from ${c.case.qualifiedName}\n`,
      );
    }
    for (const change of w.changes) {
      process.stderr.write(
        `sysprose evidence-attach: ${change.requirement} — verdict ${change.claimed} → ` +
          `${change.computed} from ${c.case.qualifiedName}` +
          `${change.overstates ? ' — the file claimed more than this run showed' : ''}\n`,
      );
    }
    for (const s of w.skipped) {
      process.stderr.write(
        `sysprose evidence-attach: ${c.case.qualifiedName} — no verdict written on ${s.requirement}: ${s.reason}\n`,
      );
    }
    if (w.methodWritten) {
      process.stderr.write(
        `sysprose evidence-attach: ${c.case.qualifiedName} declared no method — wrote the standard ` +
          '`@VerificationCases::VerificationMethod { kind = analyze; }`, which is the method this verdict was reached under\n',
      );
    }
    if (w.written.length > 0) {
      process.stderr.write(
        `sysprose evidence-attach: ${c.case.qualifiedName} verdict ${c.facet} — ` +
          `${w.written.length} requirement facet(s) written from the case\n`,
      );
    }
  }
  return out;
}

/**
 * Write the records into the model and hand back the model as text.
 *
 * THE REPORT OF AN ATTACH IS THE FILE IT PRODUCED, which is why `text` is the
 * serialized model rather than a summary: `--out model.sysml` then does the one
 * thing a reader wants, and the summary — what was attached, what was already
 * there, and every verdict that MOVED — goes to stderr beside it. The verdict
 * changes are on stderr AS WELL AS in the payload for the reason the plan
 * states: a `fail` replaced by a `pass` may never happen quietly, and stderr is
 * the stream a person sees even when stdout is being piped into a file.
 */
function reportEvidenceAttach(
  model: Model,
  name: string,
  args: ParsedArgs,
  degraded: boolean,
): Report {
  refuseDegradedWrite('evidence-attach', name, degraded);
  const from = attachFrom(args);
  const records = loadRecords(from);
  let r: AttachReport;
  try {
    r = attachEvidence(model, records);
  } catch (err) {
    // A library element, or a faulted declaration. Both are answers about what
    // was ASKED — the record names an element evidence cannot live on — and
    // reaching the top-level handler would print `internal error` over a stack
    // trace, which tells the reader the tool is broken when their record is
    // aimed at the wrong file.
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  for (const c of r.changes) {
    process.stderr.write(
      `sysprose evidence-attach: ${c.element} ${c.clause} — verdict ${c.from} → ${c.to} ` +
        `(claim ${c.fromClaim} → ${c.toClaim})` +
        `${c.launders ? ' — a refutation is being replaced by a pass' : ''}\n`,
    );
  }
  for (const s of r.skipped) {
    process.stderr.write(`sysprose evidence-attach: skipped ${s.clause} — ${s.reason}\n`);
  }
  process.stderr.write(
    `sysprose evidence-attach: ${r.attached} record(s) attached to ${r.elements.length} element(s), ` +
      `${r.unchanged} already present, ${r.skipped.length} skipped; ` +
      `${r.verdicts.length} verdict facet(s) written\n`,
  );
  // AFTER the records are in, because the case verdict is a roll-up of the rows
  // they state and a model that declares no verification case is left exactly
  // as `attachEvidence` left it.
  const caseVerdicts = writeCaseVerdicts(model, records);
  // THE PAYLOAD SAYS WHAT THE FILE SAYS. `attachEvidence`'s own report knows
  // nothing about cases, so a `--json` body carrying it alone would state a
  // verdict the artefact beside it does not contain — and would report an empty
  // `changes` array for a facet the case layer had just moved. A machine
  // consumer reads stdout and never sees stderr.
  return { json: { ...r, caseVerdicts }, text: modelText(model) };
}

function reportEvidenceDetach(
  model: Model,
  name: string,
  degraded: boolean,
): Report {
  refuseDegradedWrite('evidence-detach', name, degraded);
  const r: DetachReport = detachEvidence(model);
  process.stderr.write(
    `sysprose evidence-detach: ${r.removed} carrier(s) removed from ${r.elements.length} element(s), ` +
      `${r.verdictsCleared.length} verdict facet(s) cleared with them` +
      (r.methodAnnotationsRemoved.length > 0
        ? `, and the tool-written \`@VerificationCases::VerificationMethod { kind = analyze; }\` off ` +
          `${r.methodAnnotationsRemoved.join(', ')}`
        : '') +
      '\n',
  );
  return { json: r, text: modelText(model) };
}

function reportOrphans(model: Model, name: string): Report {
  const r = orphanReport(model);
  const text = [
    `${name}: ${r.orphans.length} of ${r.definitionsExamined} definition(s) unused`,
    ...(r.orphans.length === 0
      ? ['  every definition is used somewhere in this model']
      : r.orphans.map((o) => `  ${o.qualifiedName || label(o)} [${o.eClass}]`)),
    `  ${r.packagesSkipped} package(s) skipped as namespaces; ` +
      `${r.libraryExcluded} library and ${r.implicitExcluded} re-derived definition(s) excluded`,
    '  an unused definition is valid — this is an inventory, not a diagnostic',
  ].join('\n');
  return { json: r, text };
}

/* ────────────────────────────── reach ──────────────────────────────────── */

/**
 * `--max-configs N`, refused before the file is read.
 *
 * A bound that is not a bound is an answer about the command line, and the
 * refusal matters more here than for most flags: every absence this command
 * reports is true only under the bounds it printed, so a bound the tool
 * silently replaced with a default would make the printed qualification a lie.
 */
function reachMaxConfigs(args: ParsedArgs): number | undefined {
  const raw = flagValue(args, 'max-configs');
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(
      `--max-configs must be a positive whole number of configurations; got ${raw}. ` +
        `It is the walk\u2019s budget (default ${DEFAULT_MAX_CONFIGS}), and every figure this command ` +
        'prints is true only under the bounds printed beside it.',
    );
  }
  return n;
}

/**
 * The machine (or machines) to walk.
 *
 * A `REF` that holds no state machine is refused BY NAME rather than answered
 * with an empty report: "0 machines, nothing to say" is indistinguishable from
 * a model whose machines this command failed to find, and the reader would have
 * no way to tell which they were looking at. That refusal is for the FLAG. A
 * file with no machine at all is not a usage error and does not exit 2: nothing
 * was misused and nothing failed to load, the answer is simply "no machine
 * here", and `reach` is a `report` command — `evidence-status` prints "nothing
 * in this file states a verdict" and exits 0 on the same shape. Exiting 2 would
 * also break a `set -e` walk over a directory of models on the two shipped
 * examples that declare no machine.
 */
function reachScope(model: Model, args: ParsedArgs): ElementRecord | undefined {
  const scope = verificationScope(model, args);
  if (scope === undefined) return scope;
  if (stateMachinesIn(model, scope.id).length === 0) {
    // Name the machine that CONTAINS the element when there is one: the
    // commonest mistake is naming a state rather than the machine it is in.
    const holder = stateMachinesIn(model).find((m) =>
      model.descendants(m.id).some((d) => d.id === scope.id),
    );
    throw new UsageError(
      `\`${qname(model, scope.id)}\` holds no state machine` +
        (holder ? ` — it is inside \`${qname(model, holder.id)}\`, which is one` : ''),
    );
  }
  return scope;
}

/** One machine's block: the figures, then the rows that qualify them. */
function machineLines(m: MachineReach): string[] {
  const out: string[] = [
    `  ${m.machine.qualifiedName} [${m.machine.eClass}]`,
    `    ${m.configs} configuration(s) explored, depth ${m.depth} \u2014 ${m.qualification}`,
    `    ${m.states.reachable.length} of ${m.states.total} state(s) reachable; ` +
      `${m.transitions.fired} of ${m.transitions.total} transition(s) fired, ${m.transitions.dead.length} dead`,
  ];
  for (const u of m.unsupported) out.push(`    not explored: ${u.construct} \u2014 ${u.detail}`);
  for (const s of m.states.unreachable) out.push(`    unreachable  ${s.qualifiedName}`);
  for (const t of m.transitions.dead) out.push(`    dead         ${transitionLabel(t)}`);
  for (const d of m.deadlocks) {
    out.push(`    no way out   ${d.leaf.qualifiedName} \u2014 reached in ${d.steps} step(s), not marked final`);
  }
  for (const n of m.nondeterminism) {
    const on = n.event === '' ? 'as completion transitions (no trigger)' : `on \`${n.event}\``;
    out.push(
      `    choice       ${n.state.qualifiedName}: ${n.enabled.length} enabled ${on}; ` +
        `the simulator takes ${transitionLabel(n.taken)}, never ` +
        `${n.notTaken.map(transitionLabel).join(', ')}`,
    );
  }
  if (m.suppressed) {
    out.push(
      '    the unreachable and dead lists are SUPPRESSED: a walk that did not finish cannot say what it never reached',
    );
  }
  return out;
}

function reportReach(model: Model, name: string, args: ParsedArgs): Report {
  const scope = reachScope(model, args);
  const maxConfigs = reachMaxConfigs(args);
  const r: ReachReport = reachReport(model, {
    ...(scope ? { scopeId: scope.id } : {}),
    ...(maxConfigs !== undefined ? { maxConfigs } : {}),
  });
  const text = [
    `${name}: ${r.totals.machines} state machine(s), ${r.totals.exhaustive} walked to exhaustion; ` +
      `${r.totals.configs} configuration(s) explored`,
    ...(scope ? [`  scoped to ${qname(model, scope.id)}`] : []),
    // The sentence that keeps the command inside its remit: it decides the
    // finite abstraction it walked, and nothing beyond it.
    '  a bounded walk of what the interpreter would do \u2014 every figure below holds under the bounds printed beside it',
    // Said in words rather than left as a bare zero: a reader who asked for a
    // walk and got no rows needs to know the file has nothing to walk, not
    // wonder whether the command failed to find it.
    ...(r.machines.length === 0
      ? ['  this file declares no element that owns a transition, so there is no configuration graph to walk']
      : []),
    ...r.machines.flatMap(machineLines),
    '  semantic profile (the reading every figure above holds under):',
    ...profileLines('    '),
    ...r.diagnostics.map((d) => `  ${d.code}  ${d.message}`),
  ].join('\n');
  return { json: r, text };
}

/* ─────────────────────────── check-behaviour ────────────────────────────── */

/**
 * `--element REF`, which this command cannot do without.
 *
 * `reach` defaults to every machine in the file and this one has no default at
 * all, and the difference is not an oversight: `reach` REPORTS on machines, so
 * "all of them" is a coherent answer, while a property is a CLAIM about one
 * machine. A run that checked every property in the file against every machine
 * in it would answer a question nobody asked and would report failures against
 * machines the property was never about.
 */
function behaviourElement(args: ParsedArgs): string {
  const ref = flagValue(args, 'element');
  if (ref === undefined || ref === '') {
    throw new UsageError(
      '--element REF is required: it names the state machine the property is about. ' +
        'There is no default — a property is a claim about one machine, and checking every ' +
        'property in the file against every machine in it would report failures against machines ' +
        'the property was never about.',
      true,
    );
  }
  return ref;
}

/** The machine to check, refused BY NAME when the reference holds none. */
function behaviourMachine(model: Model, args: ParsedArgs): ElementRecord {
  behaviourElement(args);
  const scope = verificationScope(model, args)!;
  const machines = stateMachinesIn(model, scope.id);
  if (machines.length === 0) {
    const holder = stateMachinesIn(model).find((m) =>
      model.descendants(m.id).some((d) => d.id === scope.id),
    );
    throw new UsageError(
      `\`${qname(model, scope.id)}\` holds no state machine` +
        (holder ? ` — it is inside \`${qname(model, holder.id)}\`, which is one` : ''),
    );
  }
  if (machines.length > 1) {
    // Refused rather than answered over all of them, for `behaviourElement`'s
    // reason: a verdict is about one machine, and a `REF` that holds several is
    // a reference the reader has to narrow.
    throw new UsageError(
      [
        `\`${qname(model, scope.id)}\` holds ${machines.length} state machines:`,
        ...machines.map((m) => `    ${qname(model, m.id)} [${m.eClass}]`),
        '  name one of them — a property is a claim about one machine.',
      ].join('\n'),
    );
  }
  return machines[0];
}

/** One property's block: the verdict, then the trace that stands behind it. */
function propertyLines(v: PropertyVerdict): string[] {
  const from = v.property.source === 'flag' ? '--pattern' : `@PropertyPattern on ${v.property.carrier}`;
  const out: string[] = [
    `  ${v.claim.toUpperCase().padEnd(12)} ${v.sentence}`,
    `    from ${from}`,
    `    ${v.detail}`,
  ];
  if (v.code !== null) out.push(`    ${v.code}`);
  if (v.claim !== 'inconclusive' || v.configs > 0) {
    out.push(`    ${v.configs} product state(s) explored — ${v.qualification}`);
  }
  if (v.witness.length > 0) {
    out.push('    witness — a run this semantics admits:');
    for (const step of v.witness) out.push(`      ${traceLine(step)}`);
  }
  return out;
}

function reportCheckBehaviour(model: Model, name: string, args: ParsedArgs): Report {
  const machine = behaviourMachine(model, args);
  const maxConfigs = reachMaxConfigs(args);
  const pattern = flagValue(args, 'pattern');
  const r: BehaviourReport = behaviourReport(model, {
    machineId: machine.id,
    ...(pattern !== undefined ? { pattern } : {}),
    ...(maxConfigs !== undefined ? { maxConfigs } : {}),
    strictVacuity: flagGiven(args, 'strict-vacuity'),
  });
  const text = [
    `${name}: ${qname(model, machine.id)} — ${r.properties.length} propert${r.properties.length === 1 ? 'y' : 'ies'}: ` +
      `${r.counts.passed} pass, ${r.counts.failed} fail, ${r.counts.vacuous} vacuous, ` +
      `${r.counts.inconclusive} inconclusive`,
    // The two sentences that keep the command inside its remit: what a pass is
    // a claim about, and what this engine does not decide at all. It reaches
    // four words and no others — and the three louder ones a reader might
    // expect are not among them, which is said by their absence and by the
    // claims guard rather than by naming them here.
    '  a pass is a claim about every configuration this walk reached, under the bounds printed beside it, and about nothing outside them: pass, fail, vacuous, inconclusive are the four words this command reaches',
    '  liveness (`existence`, `response`) is NOT decided here: a bad-prefix search finds no bad prefix for either, so both report inconclusive',
    ...(r.properties.length === 0
      ? [
          '  this machine states no property and none was given: nothing was decided, which is exit 2 — a run that checked nothing has not passed',
          '  write one with `--pattern "pattern=absence, scope=globally, p=state failsafe"`, or carry it in the model as `@SysproseVerification::PropertyPattern { attribute pattern = "absence"; … }`',
        ]
      : []),
    ...r.properties.flatMap(propertyLines),
    '  semantic profile (the reading every verdict above holds under):',
    ...profileLines('    '),
    ...(r.strictVacuity
      ? ['  --strict-vacuity: every vacuous row above is also an error below; the exit code is the same with the flag and without it']
      : []),
    ...r.diagnostics.map((d) => `  ${d.severity} ${d.code}  ${d.message}`),
  ].join('\n');
  return { json: r, text, behaviour: r };
}

/* ──────────────────────────────── dispatch ──────────────────────────────── */

/**
 * Async because FOUR subcommands are: `verify`, `consistency` and `refine`
 * resolve their engine by asking whether a solver backend can be imported,
 * which is a dynamic import, and `property-check`'s gate 4 asks the same
 * question. Every other arm stays synchronous and is awaited for free.
 */
async function buildReport(
  cmd: CommandSpec,
  model: Model,
  name: string,
  text: string,
  args: ParsedArgs,
  /** Did the file load cleanly? Only `verify` reads it — see the `--record` refusal. */
  degraded: boolean,
  /** Element→source-span table. Only `property-check` reads it, for the insertion point. */
  ranges: ReadonlyMap<string, TextRange>,
): Promise<Report> {
  switch (cmd.name) {
    case 'stats':
      return reportStats(model, name);
    case 'elements':
      return reportElements(model, name, flagGiven(args, 'include-library'));
    case 'requirements':
      return reportRequirements(model, name, args);
    case 'trace':
      return reportTrace(model, name, args);
    case 'connectivity':
      return reportConnectivity(model, name);
    case 'where-used':
      return reportWhereUsed(model, name, args);
    case 'orphans':
      return reportOrphans(model, name);
    case 'prompts':
      return reportPrompts(model, name, args);
    case 'contracts':
      return reportContracts(model, name, args);
    case 'obligations':
      return reportObligations(model, name, args);
    case 'property-draft':
      return reportPropertyDraft(model, name, args);
    case 'property-check':
      return reportPropertyCheck(model, name, args, text, ranges);
    case 'verify':
      return reportVerify(model, name, text, args, degraded);
    case 'consistency':
      return reportConsistency(model, name, text, args);
    case 'refine':
      return reportRefinement(model, name, text, args);
    case 'evidence-status':
      return reportEvidenceStatus(model, name);
    case 'evidence-attach':
      return reportEvidenceAttach(model, name, args, degraded);
    case 'evidence-detach':
      return reportEvidenceDetach(model, name, degraded);
    case 'reach':
      return reportReach(model, name, args);
    case 'check-behaviour':
      return reportCheckBehaviour(model, name, args);
    default:
      // Unreachable while COMMANDS and this switch agree; exiting 2 rather than
      // reporting nothing is the honest answer if they ever do not.
      throw new UsageError(`\`${cmd.name}\` is declared but not implemented`);
  }
}

/**
 * Everything about the command line that can be judged without the model.
 *
 * Run before the file is read, because loading a model costs a second of
 * parsing and standard-library binding and a mistyped `--relation` should not
 * cost that. The checks themselves are not duplicated: these are the same
 * helpers the report functions call.
 */
function precheckArgs(cmd: CommandSpec, args: ParsedArgs): void {
  switch (cmd.name) {
    case 'trace':
      traceRelation(args);
      return;
    case 'requirements':
      requirementsKind(args);
      return;
    case 'where-used':
      whereUsedRef(args);
      whereUsedDepth(args);
      return;
    case 'prompts':
      promptsRef(args);
      return;
    case 'property-draft':
      // `--element` is the whole command on both rows, and `--clause` is half of
      // the second: a run missing either would parse a model and bind the
      // library before saying it had nothing to do.
      propertyRef(args);
      return;
    case 'property-check':
      propertyRef(args);
      propertyClause(args);
      return;
    case 'verify':
      // Both before the file is read: a mistyped engine name, and `--free` on
      // the engine that cannot honour it, are answers about the command line.
      verifyFree(args, verifyEngine(args));
      return;
    case 'consistency':
      // A budget that is not one is an answer about the command line, and
      // loading a model to say so costs a second of parsing and binding.
      consistencyMaxCore(args);
      return;
    case 'refine':
      // A `--via` this build does not answer is an answer about the command
      // line too, and it is the one a reader is most likely to type: the plan
      // names four families and this build answers one.
      refineVia(args);
      return;
    case 'evidence-attach':
      // `--from` is the whole command; a run without it would parse a model,
      // bind the library and then say it had nothing to attach.
      attachFrom(args);
      return;
    case 'reach':
      // A bound that is not a bound is an answer about the command line, and
      // loading a model to say so costs a second of parsing and binding.
      reachMaxConfigs(args);
      return;
    case 'check-behaviour':
      // Both before the file is read: a missing `--element` is the whole
      // command, and a bound that is not a bound is an answer about the command
      // line. The `--pattern` spelling is NOT checked here — a property that
      // cannot be read is reported as an inconclusive ROW, so the reader sees
      // it beside the carriers it was checked with rather than instead of them.
      behaviourElement(args);
      reachMaxConfigs(args);
      return;
    default:
      return;
  }
}

/** One diagnostic in the checker's own `file:line:col: severity code  message` form. */
function diagnosticLine(name: string, d: CheckReport['diagnostics'][number]): string {
  const at = d.range ? `${d.range.start.line}:${d.range.start.column}` : '-';
  return `${name}:${at}: ${d.severity} ${d.code ?? d.ruleId}  ${d.message}`;
}

/**
 * The subcommands whose report is a MODEL rather than a reading of one.
 *
 * Named as a set rather than tested inline because two places depend on it and
 * a third will: the in-place-write refusal below, and the `--out` note beside
 * it. Everything else here answers a question about a file and leaves the file
 * exactly as it found it.
 */
const WRITES_A_MODEL: ReadonlySet<string> = new Set(['evidence-attach', 'evidence-detach']);

/** How many diagnostics are printed before the rest are counted instead. */
const MAX_DIAGNOSTICS = 20;

/**
 * Put what the checker found about the FILE on stderr, whatever the exit code.
 *
 * Diagnostics used to be printed on two branches only — nothing loaded, and the
 * model loaded degraded — so a finding that left `report.ok` true never reached
 * the reader at all. `import/wrong-extension` is the live case: analysing
 * `model.txtt` reported a clean, confident set of figures and never said the
 * file was not recognised as textual notation, while `npm run check` on the
 * same file said so plainly. A report is of a file, and what is wrong with the
 * file belongs beside it.
 */
function writeDiagnostics(cmd: CommandSpec, name: string, report: CheckReport): void {
  if (report.diagnostics.length === 0) return;
  for (const d of report.diagnostics.slice(0, MAX_DIAGNOSTICS)) {
    process.stderr.write(`${diagnosticLine(name, d)}\n`);
  }
  const hidden = report.diagnostics.length - MAX_DIAGNOSTICS;
  if (hidden > 0) {
    process.stderr.write(`  … ${hidden} more — run \`npm run check\` for all of them\n`);
  }
  const { errors, warnings, infos } = report.summary;
  process.stderr.write(
    `sysprose ${cmd.name}: ${name} — ${errors} error(s), ${warnings} warning(s), ${infos} info(s)\n`,
  );
}

/** Report a usage refusal on stderr and hand back its exit code. */
function writeUsageError(cmd: CommandSpec, err: UsageError): number {
  process.stderr.write(
    `sysprose ${cmd.name}: ${err.message}\n${err.showUsage ? `\n${renderCommandUsage(cmd)}\n` : ''}`,
  );
  return 2;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    process.stderr.write(`sysprose: no subcommand\n\n${renderTopUsage()}\n`);
    return 2;
  }
  if (argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(`${renderTopUsage()}\n`);
    return 0;
  }
  if (argv[0].startsWith('-') && argv[0] !== '-') {
    process.stderr.write(`sysprose: unknown option: ${argv[0]}\n\n${renderTopUsage()}\n`);
    return 2;
  }

  const cmd = findCommand(argv[0]);
  if (!cmd) {
    process.stderr.write(
      `sysprose: unknown subcommand: ${argv[0]} — one of ${COMMANDS.map((c) => c.name).join(', ')}\n\n${renderTopUsage()}\n`,
    );
    return 2;
  }

  const parsed = parseArgs(argv.slice(1), flagsFor(cmd));
  if (isArgError(parsed)) {
    process.stderr.write(`sysprose ${cmd.name}: ${parsed.error}\n\n${renderCommandUsage(cmd)}\n`);
    return 2;
  }
  // Help is read off the PARSED flags rather than scanned for in the raw argv,
  // so it obeys the grammar the rest of the command line obeys: after `--` a
  // `-h` is a positional, and `--element --help` is a missing value. A raw scan
  // answered both with the help text and exit 0 — a malformed command line
  // reported as a success, which is what the missing-value check exists to stop.
  if (flagGiven(parsed, 'help')) {
    process.stdout.write(`${renderCommandUsage(cmd)}\n`);
    return 0;
  }
  if (parsed.positionals.length === 0) {
    process.stderr.write(`sysprose ${cmd.name}: no input file\n\n${renderCommandUsage(cmd)}\n`);
    return 2;
  }
  if (parsed.positionals.length > 1) {
    // One model per run, deliberately: files are separate namespaces here (see
    // `npm run check`), so two files are two models and one report over both
    // would be a number that is true of neither.
    process.stderr.write(
      `sysprose ${cmd.name}: expected one file, got ${parsed.positionals.length}\n\n${renderCommandUsage(cmd)}\n`,
    );
    return 2;
  }

  try {
    precheckArgs(cmd, parsed);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    return writeUsageError(cmd, err);
  }

  const file = parsed.positionals[0];
  const name = file === '-' ? '<stdin>' : file;
  let text: string;
  try {
    text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(
      `sysprose ${cmd.name}: cannot read ${name}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const { model, report, ranges } = await loadModelText(text, {
    library: flagGiven(parsed, 'no-library') ? 'none' : 'full',
    // Piped input has no file name, so it is labelled rather than named — the
    // extension test is about a file the reader could rename.
    ...(file === '-' ? { displayName: '<stdin>' } : { fileName: file }),
  });

  writeDiagnostics(cmd, name, report);

  if (!model) {
    process.stderr.write(`sysprose ${cmd.name}: nothing loaded from ${name} — no report\n`);
    return 2;
  }
  const degraded = !report.ok;
  if (!degraded && model.all().filter((el) => isUserElement(model, el)).length === 0) {
    // "0 elements, everything is fine" is the answer a mistyped path deserves
    // least: it is indistinguishable from a real report on a real model.
    //
    // Only for a file that PARSED, though. A file that failed to parse and
    // salvaged nothing is a broken file, not an empty one, and reporting it as
    // "no elements" threw away every diagnostic that said why — the reader was
    // told their model was empty when it was unreadable. That case is the
    // degraded exit below, with the findings above it.
    process.stderr.write(
      `sysprose ${cmd.name}: no elements in ${name} — nothing to report\n`,
    );
    return 2;
  }

  let built: Report;
  try {
    built = await buildReport(cmd, model, name, text, parsed, degraded, ranges);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    return writeUsageError(cmd, err);
  }

  // Computed once, here, because it is what the process exits with AND what the
  // `--json` body publishes: a payload whose `verdict.exitCode` disagreed with
  // the process's own status is the one thing an automation cannot recover from.
  const verdict:
    | Verdict
    | ConsistencyVerdict
    | RefinementVerdict
    | BehaviourVerdict
    | undefined = built.verify
    ? judge(built.verify, degraded)
    : built.consistency
      ? judgeConsistency(built.consistency, degraded)
      : built.refinement
        ? judgeRefinement(built.refinement, degraded)
        : built.behaviour
          ? judgeBehaviour(built.behaviour, degraded)
          : undefined;

  const body = flagGiven(parsed, 'json')
    ? JSON.stringify(
        {
          ok: report.ok,
          file: name,
          ...(degraded
            ? {
                degraded: {
                  errors: report.summary.errors,
                  warnings: report.summary.warnings,
                  diagnostics: report.diagnostics,
                },
              }
            : {}),
          // Top level, beside `ok` and `file`, for every judging subcommand: an
          // automation reads the verdict without knowing which payload key this
          // subcommand publishes under or how its report is shaped.
          ...(verdict ? { verdict } : {}),
          [cmd.payloadKey]: built.json,
        },
        null,
        2,
      )
    : built.text;

  const out = flagValue(parsed, 'out');
  if (out !== undefined) {
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${body}\n`);
    } catch (err) {
      // A path that cannot be written is a problem with what was asked, and it
      // reads as one. Letting it reach the top-level handler reported `internal
      // error` with a stack trace, which tells the reader the tool is broken
      // when their `--out` argument names a directory.
      process.stderr.write(
        `sysprose ${cmd.name}: cannot write ${out}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
    process.stdout.write(`Wrote ${out}\n`);
  } else {
    process.stdout.write(`${body}\n`);
    // THE INPUT PATH IS NEVER WRITTEN UNLESS IT WAS NAMED. `evidence-attach`
    // and `evidence-detach` are the only subcommands whose report IS a new
    // version of the model, so they are the only ones a reader could expect to
    // edit the file in place — and in place is exactly what a tool must not do
    // by default with somebody's source. The updated model went to stdout; the
    // way to write it back is to say so, and `--out <the same path>` is
    // accepted for precisely that.
    if (WRITES_A_MODEL.has(cmd.name)) {
      process.stderr.write(
        `sysprose ${cmd.name}: ${name} was NOT changed — the updated model is on stdout. ` +
          `Pass \`--out ${name === '<stdin>' ? 'PATH' : name}\` to write it.\n`,
      );
    }
  }

  if (degraded) {
    // The banner is on stderr and the report is on stdout, so a pipeline gets
    // the report and a person gets the warning that it is of a part. The
    // findings themselves are already above it, printed for every exit code.
    process.stderr.write(
      `sysprose ${cmd.name}: degraded — ${name} did not load cleanly ` +
        `(${report.summary.errors} error(s), ${report.summary.warnings} warning(s)); ` +
        `${verdict ? 'nothing is judged over half a model' : 'reporting on what parsed'}\n`,
    );
  }
  // A judging subcommand exits with its verdict — 1 for refuted, 2 for any
  // inconclusive or a degraded model — and NOT with the reporting contract's 1,
  // which means something else entirely (`VERIFY_EXIT_CODES`).
  if (verdict) return verdict.exitCode;
  return degraded ? 1 : 0;
}

runMain('sysprose', main);

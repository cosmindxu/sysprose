/**
 * What `sysprose` can be asked, declared once.
 *
 * WHY IT IS DATA. The subcommands, their flags and the one-line answer to
 * "what does this one tell me" are read by three consumers: the dispatcher
 * (which parses and dispatches on them), `--help` (which renders them), and the
 * command reference in the documentation (which is generated from them). Three
 * hand-written copies of a command table is how a tool ends up with a flag
 * nobody documents and a documented flag that no longer exists, so there is one
 * table and the other two are renderings of it.
 *
 * This module is deliberately side-effect free — no imports of the model, no
 * `main()` — so a documentation generator can import it without running a
 * command.
 */

import { renderFlag, type FlagSpec } from './args';

/**
 * The `--max-core` default, spelled here rather than imported.
 *
 * This module is imported by the documentation generator and by three doc
 * guards, and it is deliberately free of model imports so none of them pulls
 * the core graph in to render a help line — the same reason
 * {@link STATEMENT_KIND_FLAG_VALUES} is a copy. The price of the copy is
 * drift, so it is not left to good intentions: `test/unit/cli-reference.test.ts`
 * compares this against `DEFAULT_MAX_CORE` in `src/semantics/consistency.ts`
 * and fails if the two move apart.
 */
export const DEFAULT_MAX_CORE = 8;

/** The exit-code contract, stated once and quoted into every help text. */
export const EXIT_CODES = `Exit codes: 0 clean · 1 the model did not load cleanly (the report is of what parsed) · 2 usage/IO error`;

/**
 * `npm run check`'s exit-code contract, which is a DIFFERENT contract.
 *
 * `sysprose` reports and does not judge, so its 1 is about whether the model
 * under the report is the whole model. `check` judges, so its 1 is about the
 * findings: a file that parsed perfectly and broke one validation rule loaded
 * cleanly and still exits 1. The two were once documented as one contract, and
 * a reader who branched on it would have treated a duplicate-name error as a
 * parse failure. Stated here, next to the other, so the difference is visible
 * to whoever edits either — `scripts/sysml-check.ts`'s `--help` and
 * `docs/CLI-REFERENCE.md` are both renderings of this string.
 */
export const CHECK_EXIT_CODES = `Exit codes: 0 clean · 1 at least one file has findings (errors, or warnings with --strict) · 2 usage/IO error`;

/**
 * The contract of the two subcommands that WRITE the model back, which has no 1.
 *
 * Under {@link EXIT_CODES} a 1 says "the model did not load cleanly — the
 * report is of what parsed", and that sentence is unreachable for a subcommand
 * that refuses a degraded model outright: `evidence-attach` and
 * `evidence-detach` both open with `refuseDegradedWrite`, which raises a usage
 * error, which is a **2**. Documenting them under the reporting contract
 * promised a partial answer they will never give — the whole point of the
 * refusal is that a lossy rewrite of somebody's source is worse than no answer
 * — so they declare their own contract and it says what actually happens.
 */
export const WRITE_EXIT_CODES = `Exit codes: 0 written · 2 usage/IO error, or a model that did not load cleanly — a degraded model is refused rather than partially rewritten, so there is no exit 1`;

/**
 * `verify`'s exit-code contract, which is a THIRD contract, and the one most
 * likely to be misread.
 *
 * The other two agree about what 1 means at least in KIND: something is wrong
 * with the file. Here **1 means the requirement was refuted** — the model
 * loaded perfectly, every value is exactly what the author wrote, and the
 * obligation is false at those values. A pipeline branching on `sysprose`'s
 * reporting contract would read that as a parse failure and a `check` reader
 * would read it as a validation finding; it is neither.
 *
 * TWO SUBCOMMANDS OBEY IT, and they judge different things. `verify` asks
 * whether each obligation HOLDS of the design the file describes;
 * `consistency` asks whether the requirements could be met by any design at
 * all. Both reach a decided negative — a refuted obligation, a requirement set
 * nothing can satisfy — and both report it as **1**, because it is a finding
 * about the model rather than a limit of the tool. A contract that named only
 * one of the two would leave the other's loudest verdict documented as
 * something else.
 *
 * The other half a reader must not have to infer: **every inconclusive is 2**,
 * and that includes an absent solver. A missing tool can never produce a green
 * build, because the alternative — "no solver installed, nothing to report,
 * exit 0" — is indistinguishable from a proof and is the single failure this
 * whole lane exists to make impossible. **Nor may an EMPTY run be green**, for
 * the same reason and by the same reading: exit 0 says every obligation was
 * discharged, so a model that states none has been shown nothing, and a build
 * that went green because every requirement was deleted is exactly the silence
 * this contract is written against. `--allow-inconclusive` lowers 2 → 0 for
 * exactly two codes (`verification/timeout` and
 * `verification/unsupported-construct`, the ones that are merely UNDECIDED); it
 * never lowers `verification/tool-absent`, `verification/vacuous-pass` or
 * `verification/design-admitted`, and exit 1 always beats it.
 *
 * Stated here beside the other two so the difference is visible to whoever
 * edits any of them, and quoted by `renderCommandUsage` and the reference
 * generator through {@link exitCodesFor} rather than retyped — the drift test
 * in `test/unit/cli-reference.test.ts` asserts that every `exitContract:
 * 'verify'` command quotes this string and that no `'report'` command does.
 */
export const VERIFY_EXIT_CODES = `Exit codes: 0 every obligation discharged non-vacuously by the engine that was asked for — or every requirement set shown satisfiable — and there was at least one of them to decide · 1 at least one obligation refuted with every feature at its model value, or one requirement set nothing can satisfy · 2 usage/IO error, a degraded model, a model that states nothing to decide at all, or ANY inconclusive — a timeout, an unsupported construct, a relation not evaluable at the model's values, a vacuous obligation, an absent solver, or a refutation obtained under --free, which is a design the model admits rather than a violation of it`;

/** Flags every subcommand accepts. */
export const COMMON_FLAGS: readonly FlagSpec[] = [
  {
    name: 'json',
    kind: 'boolean',
    doc: 'Machine-readable report on stdout: {ok, file, <report>}',
  },
  {
    name: 'out',
    kind: 'value',
    metavar: 'PATH',
    doc: 'Write the report to PATH instead of printing it',
  },
  {
    name: 'no-library',
    kind: 'boolean',
    doc: 'Skip standard-library BINDING (faster; library types report as unresolved)',
  },
  { name: 'help', short: 'h', kind: 'boolean', doc: 'Help for this subcommand' },
];

/**
 * The relationship families `trace` can tabulate.
 *
 * A preset names the RELATIONSHIP kinds only. The row and column metaclasses
 * are read off the model — see the axis derivation in `scripts/sysprose.ts` —
 * because a hard-coded pair would be wrong for half the models that use it:
 * `satisfy` links a `PartUsage` to a `RequirementDefinition` in the shipped UAV
 * example and a `PartUsage` to a `RequirementUsage` in a model that declares
 * its requirements as usages, and a matrix that silently reports zero rows for
 * the second shape is worse than no command at all.
 */
export const TRACE_PRESETS: ReadonlyMap<string, readonly string[]> = new Map([
  ['satisfy', ['Satisfy', 'SatisfyRequirementUsage']],
  ['allocate', ['Allocation', 'AllocationUsage']],
  ['verify', ['Verify']],
  ['refine', ['Refine']],
  ['derive', ['Derive']],
  ['trace', ['Trace']],
]);

/**
 * The statement kinds `requirements --kind` accepts.
 *
 * Spelled out here rather than imported from `@semantics/statement-kind`,
 * because this module is imported by a documentation generator and by three
 * doc-guard tests, and pulling the model in to render a help line would give
 * every one of them the whole core graph. The price of the copy is drift, so it
 * is not left to good intentions: `test/unit/cli-reference.test.ts` compares
 * this list against `STATEMENT_KINDS` and fails if a fourth kind is added to
 * the vocabulary and not offered here.
 */
export const STATEMENT_KIND_FLAG_VALUES: readonly string[] = ['requirement', 'prose', 'prompt'];

/**
 * Which exit-code contract a subcommand obeys.
 *
 * `report` is {@link EXIT_CODES}: the subcommand reports and does not judge, so
 * its 1 is about whether the model under the report is the whole model.
 * `verify` is {@link VERIFY_EXIT_CODES}: the subcommand judges, so its 1 means
 * REFUTED. Declared per row rather than assumed for the section, because the
 * generated reference used to print one paragraph for the whole `sysprose`
 * section — and under it `verify` would have been documented with 1 meaning the
 * exact opposite of what it means.
 */
export type ExitContract = 'report' | 'verify' | 'write';

/** One subcommand. */
export interface CommandSpec {
  name: string;
  /** The reader's question, not the function's name. */
  question: string;
  /** What computes the answer, so the guide and the code cite one source. */
  backedBy: string;
  /** Key the `--json` payload is published under, beside `ok` and `file`. */
  payloadKey: string;
  /** Which of the two exit-code contracts this subcommand obeys. */
  exitContract: ExitContract;
  /** Flags beyond {@link COMMON_FLAGS}. */
  flags: readonly FlagSpec[];
}

/** The exit-code sentence a subcommand's own help and reference must quote. */
export function exitCodesFor(cmd: CommandSpec): string {
  if (cmd.exitContract === 'verify') return VERIFY_EXIT_CODES;
  if (cmd.exitContract === 'write') return WRITE_EXIT_CODES;
  return EXIT_CODES;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'stats',
    question: 'How big is this model, and what shape is it?',
    backedBy: 'modelMetrics + countByMetaclass (src/api/analytics.ts)',
    payloadKey: 'stats',
    exitContract: 'report',
    flags: [],
  },
  {
    name: 'elements',
    question: 'What is in it?',
    backedBy: 'buildGrid (src/diagram/grid.ts)',
    payloadKey: 'elements',
    exitContract: 'report',
    flags: [
      {
        name: 'include-library',
        kind: 'boolean',
        doc: 'List bundled standard-library elements too (tens of thousands of rows)',
      },
    ],
  },
  {
    name: 'requirements',
    question: 'Are my requirements covered, and by what?',
    backedBy:
      'requirementSatisfaction (src/api/analytics.ts) + buildRequirementsTable (src/diagram/requirements-table.ts)',
    payloadKey: 'requirements',
    exitContract: 'report',
    flags: [
      {
        name: 'kind',
        kind: 'value',
        metavar: 'KIND',
        fallback: 'every kind, each non-normative row labelled',
        doc: `Show only statements of this kind: ${STATEMENT_KIND_FLAG_VALUES.join(' | ')}`,
      },
    ],
  },
  {
    name: 'trace',
    question: 'What satisfies, allocates, verifies, refines, derives or traces what?',
    backedBy: 'traceabilityMatrix (src/api/analytics.ts)',
    payloadKey: 'trace',
    exitContract: 'report',
    flags: [
      {
        name: 'relation',
        kind: 'value',
        metavar: 'NAME',
        fallback: 'satisfy',
        doc: `Relationship family: ${[...TRACE_PRESETS.keys()].join(' | ')}`,
      },
      {
        name: 'from',
        kind: 'value',
        metavar: 'KIND',
        doc: 'Row metaclass (default: the kinds this relation actually links from)',
      },
      {
        name: 'to',
        kind: 'value',
        metavar: 'KIND',
        doc: 'Column metaclass (default: the kinds this relation actually links to)',
      },
    ],
  },
  {
    name: 'connectivity',
    question: 'Which ports are wired, and which are left dangling?',
    backedBy: 'connectivityReport (src/api/analytics.ts)',
    payloadKey: 'connectivity',
    exitContract: 'report',
    flags: [],
  },
  {
    name: 'where-used',
    question: 'What breaks if I change this element?',
    backedBy: 'impactClosure (src/api/analytics.ts)',
    payloadKey: 'whereUsed',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
      {
        name: 'depth',
        kind: 'value',
        metavar: 'N',
        fallback: '1',
        doc: 'How many reference hops to walk',
      },
    ],
  },
  {
    name: 'orphans',
    question: 'What did I declare and never use?',
    backedBy: 'orphanReport (src/api/analytics.ts)',
    payloadKey: 'orphans',
    exitContract: 'report',
    flags: [],
  },
  {
    name: 'prompts',
    question: 'What guidance applies to the element I am working on?',
    backedBy: 'promptsFor (src/api/analytics.ts)',
    payloadKey: 'prompts',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        // Deliberately the same words as `where-used`'s: it is the same
        // resolution, and two spellings of one grammar is how a reader learns
        // that the second command wants something else.
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
    ],
  },
  {
    name: 'contracts',
    question: 'What does each requirement assume and guarantee, on which subject, honoured by which part?',
    backedBy: 'contractReport (src/api/verification.ts)',
    payloadKey: 'contracts',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        fallback: 'every contract in the model',
        // The same words as `where-used`'s and `prompts`': it is the same
        // resolution, and two spellings of one grammar is how a reader learns
        // that the second command wants something else.
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
      {
        name: 'keywords',
        kind: 'boolean',
        doc: 'Also inventory every `#keyword` in the file with what it resolves to — an inventory, which changes no obligation',
      },
    ],
  },
  {
    name: 'obligations',
    question: 'What must be shown, over which axioms, and what do the unit gates refuse?',
    backedBy: 'obligationsReport (src/api/verification.ts)',
    payloadKey: 'obligations',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        fallback: 'the whole model',
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
      {
        name: 'missing',
        kind: 'boolean',
        doc: 'Only the rows this lane would not decide: no formal clause, and not encodable',
      },
      {
        name: 'from-keywords',
        kind: 'boolean',
        fallback: 'a keyword files nothing',
        doc: "Let a third-party `#precondition` / `#postcondition` file a premise or an obligation; each such row prints the spelling that filed it",
      },
    ],
  },
  // The two that stand BEFORE the engines rather than behind them: an agent
  // writes a clause with the first and has it refused by the second, and neither
  // of them decides anything about the model. They report — a refused clause is
  // an answer about a string the caller passed, not a finding about the file —
  // so both carry `exitContract: 'report'` and the verdict is in the payload's
  // `outcome` and `refusedAt`, never in the exit code. Under the reporting
  // contract 1 means "the model did not load cleanly", and §2 reserves the
  // judging contract's 1 for a refuted obligation and nothing else.
  {
    name: 'property-draft',
    question: 'How do I write a clause this tool will accept, over which names?',
    backedBy: 'propertyDraft (src/api/property.ts)',
    payloadKey: 'propertyDraft',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        // The same words as `where-used`'s, `prompts`' and `contracts`': it is
        // the same resolution, and two spellings of one grammar is how a reader
        // learns that the second command wants something else.
        doc: 'The element: an id, a qualified name, or a name unique in the model',
      },
    ],
  },
  {
    name: 'property-check',
    question: 'Would this clause pass the gates, and what does it actually say?',
    backedBy: 'propertyCheck (src/api/property.ts)',
    payloadKey: 'propertyCheck',
    exitContract: 'report',
    flags: [
      {
        name: 'element',
        kind: 'value',
        metavar: 'REF',
        doc: 'The requirement the clause is for: an id, a qualified name, or a name unique in the model',
      },
      {
        name: 'clause',
        kind: 'value',
        metavar: 'TEXT',
        doc: "The clause to judge: a constraint body (`uav.mtow <= 25.0 [kg]`), optionally preceded by FRETish fields written `field: value;` or `field = value;` — the spelling `property-draft`'s skeleton emits, and the other one. A `scope` other than global, a `condition`, or a `timing` other than always is refused at gate 0 — no in-process engine here decides a temporal claim",
      },
    ],
  },
  // The first subcommand in this table that JUDGES. Everything above reports,
  // and every one of them carries `exitContract: 'report'` for that reason; this
  // one carries `'verify'`, and its 1 means refuted.
  {
    name: 'verify',
    question: 'Does each obligation hold, by which engine, and under what bound?',
    backedBy: 'verifyModel (src/api/verification.ts)',
    payloadKey: 'verify',
    exitContract: 'verify',
    flags: [
      {
        name: 'case',
        kind: 'value',
        metavar: 'REF',
        fallback: 'every obligation in the model, with every verification case reported beside them',
        doc: 'Judge ONE verification case: the report is narrowed to the obligations of the requirements it verifies, and its verdict decides the run. The model is still judged whole, so the axioms those obligations stand on are all still in force. A case whose `@VerificationMethod { kind = …; }` has no `analyze` in it is NOT judged — `verification/method-not-performed`, exit 2, never exit 1',
      },
      {
        name: 'engine',
        kind: 'value',
        metavar: 'NAME',
        fallback: 'auto',
        doc: "Which engine decides: auto | literal | smt. `auto` resolves to `smt` when a solver backend loads and otherwise reports every obligation as `verification/tool-absent` — it never falls back to `literal`, because a point evaluation is green only when asked for by name",
      },
      {
        name: 'free',
        kind: 'value',
        metavar: 'F',
        fallback: 'none — every feature value is a binding the proof carries',
        doc: 'Release a feature value (qualified name) so the engine may vary it; a refutation obtained this way is `design-admitted`, not a violation. An SMT-engine option: the literal engine evaluates AT the values and refuses it',
      },
      {
        name: 'record',
        kind: 'value',
        metavar: 'PATH',
        doc: 'Write the evidence records to PATH: one per obligation, each naming the claim, the engine, the tool version, the bound and the canonical model digest',
      },
      {
        name: 'allow-inconclusive',
        kind: 'boolean',
        doc: 'Lower exit 2 to 0 for the UNDECIDED codes only — verification/timeout and verification/unsupported-construct. Never for an absent solver, a vacuous obligation or a design-admitted one, and never over a refutation',
      },
      {
        name: 'timeout',
        kind: 'value',
        metavar: 'MS',
        fallback: '5000 ms per check',
        doc: 'The per-check budget in milliseconds — an SMT-engine option. No check is unbounded and there is no spelling for "no timeout"; a solver that runs out of time reports verification/timeout, which says nothing about whether the requirement holds',
      },
      {
        name: 'strict-vacuity',
        kind: 'boolean',
        doc: 'Raise a vacuous obligation from an info line to verification/vacuous-property, an error. It does NOT change the exit code: vacuity is inconclusive and exits 2 with the flag and without it',
      },
    ],
  },
  // The second subcommand that judges, and it judges a DIFFERENT question:
  // `verify` asks whether the requirements hold of the design in the file,
  // this asks whether they could be met by any design at all. The two disagree
  // by construction on a file whose values break a requirement — that one is
  // refuted and its requirement set is perfectly satisfiable — so they are two
  // commands rather than a flag on one.
  {
    name: 'consistency',
    question: 'Can all the requirements on this subject hold at once — and if not, which conflict?',
    backedBy: 'consistencyReport (src/api/verification.ts)',
    payloadKey: 'consistency',
    exitContract: 'verify',
    flags: [
      {
        name: 'subject',
        kind: 'value',
        metavar: 'REF',
        fallback: 'every subject the model states a requirement about',
        doc: 'The subject: an id, a qualified name, or a name unique in the model — a type, or the part usage the file writes after `subject`, which is narrowed through its declared type. A type answers for its subtypes, because a requirement on a `Vehicle` is a requirement on every air vehicle. A REF that is the subject of nothing is refused by name rather than reported as a file with no requirements',
      },
      {
        name: 'with-values',
        kind: 'boolean',
        doc: 'Ask the weaker question: can the requirements hold together AT THE VALUES THE FILE STATES? By default every feature carrying a literal value is released and only the structural axioms are kept, because a consistency question about a requirement set must not be answered by the values that happen to be in the file. Every verdict line names the mode it was computed in',
      },
      {
        name: 'minimize',
        kind: 'boolean',
        doc: 'Reduce the conflicting subset by deletion, one member per check, until every member is needed. Only a loop that RAN TO COMPLETION earns the word "minimal"; without it, and after any timeout, the report says "a conflicting subset"',
      },
      {
        name: 'max-core',
        kind: 'value',
        metavar: 'N',
        fallback: `${DEFAULT_MAX_CORE} members`,
        doc: 'The deletion loop\u2019s budget, in core members — minimising costs one solver check per member. A core larger than N is reported in full and left unreduced, and the line says the budget was why',
      },
      {
        name: 'allow-inconclusive',
        kind: 'boolean',
        doc: 'Lower exit 2 to 0 for the UNDECIDED codes only — verification/timeout and verification/unsupported-construct. Never for an absent solver, never over an inconsistency, and never over a run in which nothing at all was decided',
      },
    ],
  },
  // The three that read and write the FILE rather than reporting on it. None of
  // them JUDGES — the judging was done by `verify`, once, and a verdict is not
  // re-decided by being written down — but the two that write the file back
  // obey a contract of their own: they refuse a degraded model outright, so
  // their exit 1 ("the report is of what parsed") does not exist.
  {
    name: 'evidence-status',
    question: 'What was shown, by which tool, over which model — and is it still valid?',
    backedBy: 'evidenceStatus (src/api/evidence.ts)',
    payloadKey: 'evidenceStatus',
    exitContract: 'report',
    flags: [],
  },
  {
    name: 'evidence-attach',
    question: 'Write the records of a verify run into the file, as annotations on what they are about',
    backedBy: 'attachEvidence (src/api/evidence.ts)',
    payloadKey: 'evidenceAttach',
    exitContract: 'write',
    flags: [
      {
        name: 'from',
        kind: 'value',
        metavar: 'PATH',
        doc: 'The records to attach: the JSON array `verify --record PATH` wrote. Each is validated against docs/schemas/evidence-record.schema.json before anything is written, so a hand-edited file is refused rather than half-attached',
      },
    ],
  },
  {
    name: 'evidence-detach',
    question: 'Take every evidence record back off the file, and the verdict facets with them',
    backedBy: 'detachEvidence (src/api/evidence.ts)',
    payloadKey: 'evidenceDetach',
    exitContract: 'write',
    flags: [],
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Every flag a subcommand accepts: its own, then the shared ones. */
export function flagsFor(cmd: CommandSpec): FlagSpec[] {
  return [...cmd.flags, ...COMMON_FLAGS];
}

/** `--help` with no subcommand: what the tool is and what it can be asked. */
export function renderTopUsage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const judging = COMMANDS.filter((c) => c.exitContract === 'verify');
  return [
    'sysprose — report on a SysML v2–style model from the command line',
    '',
    'Usage:',
    '  npm run sysprose -- <subcommand> <file.sysml|-> [options]',
    '  cat model.sysml | npm run sysprose -- stats -',
    '',
    'Subcommands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.question}`),
    '',
    'Options (every subcommand):',
    ...COMMON_FLAGS.map((f) => renderFlag(f)),
    '',
    'Run `npm run sysprose -- <subcommand> --help` for the flags of one subcommand.',
    '',
    // The top-level text names the contract MOST subcommands obey and then says
    // which ones do not, rather than printing one contract over a table that
    // holds two. Under a single blanket sentence, `verify`'s exit 1 — refuted —
    // would be documented as "the model did not load cleanly", its exact
    // opposite.
    EXIT_CODES,
    ...(judging.length > 0
      ? [
          // Written as a sentence rather than as a joined list, because there
          // is more than one judging subcommand now and "`verify`,
          // `consistency` judges" is not English. A reader who cannot parse the
          // line cannot act on the one thing it says.
          `  …for every subcommand that REPORTS. ${listOf(judging.map((c) => `\`${c.name}\``))} ` +
            (judging.length === 1
              ? 'judges and has its own contract: run its `--help`.'
              : 'judge and have their own contract: run their `--help`.'),
        ]
      : []),
  ].join('\n');
}

/**
 * `a`, `a and b`, `a, b and c` — a list a person reads inside a sentence.
 *
 * EXPORTED so `scripts/gen-cli-reference.ts` renders the same sentence the
 * same way. It had its own comma-joined copy, which read "`verify`,
 * `consistency` judges" the day a second judging subcommand shipped — the one
 * place a reader who has not run the tool yet meets the exit contract.
 */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `--help` for one subcommand. */
export function renderCommandUsage(cmd: CommandSpec): string {
  const flags = flagsFor(cmd);
  const width = Math.max(...flags.map((f) => f.name.length + (f.short ? 4 : 0) + (f.kind === 'value' ? (f.metavar ?? 'VALUE').length + 1 : 0))) + 2;
  return [
    `sysprose ${cmd.name} — ${cmd.question}`,
    '',
    'Usage:',
    `  npm run sysprose -- ${cmd.name} <file.sysml|-> [options]`,
    '',
    'Options:',
    ...flags.map((f) => renderFlag(f, width)),
    '',
    `Computed by: ${cmd.backedBy}`,
    `JSON payload key: ${cmd.payloadKey}`,
    '',
    // Per SUBCOMMAND, from its own declared contract. A single interpolation of
    // `EXIT_CODES` here would tell a `verify` reader that exit 1 means the model
    // did not load cleanly, when it means the requirement was refuted.
    exitCodesFor(cmd),
  ].join('\n');
}

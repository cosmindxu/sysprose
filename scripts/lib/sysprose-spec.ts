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
export const VERIFY_EXIT_CODES = `Exit codes: 0 every obligation discharged non-vacuously by the engine that was asked for, and there was at least one to discharge · 1 at least one obligation refuted with every feature at its model value · 2 usage/IO error, a degraded model, a model that states no obligation at all, or ANY inconclusive — a timeout, an unsupported construct, a relation not evaluable at the model's values, a vacuous obligation, an absent solver, or a refutation obtained under --free, which is a design the model admits rather than a violation of it`;

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
export type ExitContract = 'report' | 'verify';

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
  return cmd.exitContract === 'verify' ? VERIFY_EXIT_CODES : EXIT_CODES;
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
    ],
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
          `  …for every subcommand that REPORTS. ${judging.map((c) => `\`${c.name}\``).join(', ')} ` +
            'judges and has its own contract: run its `--help`.',
        ]
      : []),
  ].join('\n');
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

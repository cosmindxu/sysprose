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

/** One subcommand. */
export interface CommandSpec {
  name: string;
  /** The reader's question, not the function's name. */
  question: string;
  /** What computes the answer, so the guide and the code cite one source. */
  backedBy: string;
  /** Key the `--json` payload is published under, beside `ok` and `file`. */
  payloadKey: string;
  /** Flags beyond {@link COMMON_FLAGS}. */
  flags: readonly FlagSpec[];
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'stats',
    question: 'How big is this model, and what shape is it?',
    backedBy: 'modelMetrics + countByMetaclass (src/api/analytics.ts)',
    payloadKey: 'stats',
    flags: [],
  },
  {
    name: 'elements',
    question: 'What is in it?',
    backedBy: 'buildGrid (src/diagram/grid.ts)',
    payloadKey: 'elements',
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
    flags: [],
  },
  {
    name: 'trace',
    question: 'What satisfies, allocates, verifies, refines, derives or traces what?',
    backedBy: 'traceabilityMatrix (src/api/analytics.ts)',
    payloadKey: 'trace',
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
    flags: [],
  },
  {
    name: 'where-used',
    question: 'What breaks if I change this element?',
    backedBy: 'impactClosure (src/api/analytics.ts)',
    payloadKey: 'whereUsed',
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
    EXIT_CODES,
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
    EXIT_CODES,
  ].join('\n');
}

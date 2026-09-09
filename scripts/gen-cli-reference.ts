#!/usr/bin/env tsx
/**
 * Generate `docs/CLI-REFERENCE.md` from `scripts/lib/sysprose-spec.ts`.
 *
 * The command table in that module is the single source of truth: the
 * dispatcher parses it, `--help` renders it, and this script renders it for a
 * reader who has not run the command yet. `test/unit/cli-reference.test.ts`
 * fails when the committed document differs from what this renders, so
 * regenerating is not optional after adding a subcommand or a flag — which is
 * the point. A flag that exists and is undocumented, and a documented flag that
 * no longer exists, are the two ways a command and its reference stop
 * describing the same tool, and neither can survive a green suite here.
 *
 * The renderer is exported and the write is guarded by an is-this-the-entry-
 * point check: the drift test imports {@link renderCliReference} to compare it
 * against the file on disk, and an import that quietly rewrote that file would
 * make the test pass by destroying the evidence.
 *
 * Run: npm run commands
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlagSpec } from './lib/args';
import {
  BEHAVIOUR_EXIT_CODES,
  CHECK_EXIT_CODES,
  COMMANDS,
  COMMON_FLAGS,
  EXIT_CODES,
  BOUNDS_EXIT_CODES,
  FAULT_TREE_EXIT_CODES,
  REFINE_EXIT_CODES,
  TRACE_PRESETS,
  WRITE_EXIT_CODES,
  exitCodesFor,
  listOf,
  type CommandSpec,
} from './lib/sysprose-spec';

/**
 * One Markdown table cell.
 *
 * A `doc` line written for a terminal is not safe in a table: `--relation`'s
 * lists its presets separated by `|`, which ends the cell, and `--json`'s
 * describes the payload as `{ok, file, <report>}`, whose `<report>` a Markdown
 * renderer reads as an HTML tag and drops. Both are the spec's words and must
 * reach the page as written.
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `--flag VALUE` as the reference writes it, in code ticks. */
function flagName(f: FlagSpec): string {
  const alias = f.short ? `\`-${f.short}\`, ` : '';
  return `${alias}\`--${f.name}${f.kind === 'value' ? ` ${f.metavar ?? 'VALUE'}` : ''}\``;
}

/**
 * A flag's default, in code ticks only when it is a VALUE.
 *
 * Most defaults are literals a reader could type back at the flag (`satisfy`,
 * `1`), and ticks say so. `--kind`'s is a sentence — "every kind, each
 * non-normative row labelled" — and in the same ticks it read as a value the
 * flag would accept. Ticks are the claim "this is what you would pass"; a
 * fallback with a space in it is not making that claim.
 */
function fallbackCell(f: FlagSpec): string {
  if (!f.fallback) return '—';
  return f.fallback.includes(' ') ? cell(f.fallback) : `\`${f.fallback}\``;
}

/** One row per flag: how it is written, what it does, what it does otherwise. */
function flagTable(flags: readonly FlagSpec[]): string {
  return [
    '| Flag | What it does | Default |',
    '|---|---|---|',
    ...flags.map((f) => `| ${flagName(f)} | ${cell(f.doc)} | ${fallbackCell(f)} |`),
  ].join('\n');
}

/**
 * One subcommand: the question it answers, how to run it, its flags — and **its
 * own exit-code contract**.
 *
 * That last part is not decoration. This document used to state the exit codes
 * ONCE for the whole `sysprose` section, which was true while every subcommand
 * reported. `verify` judges: its exit 1 means *refuted*, the exact opposite of
 * "the model did not load cleanly", and a reader who took the section paragraph
 * as the contract would branch on it backwards. The paragraph is now rendered
 * per subcommand from `cmd.exitContract`, and `test/unit/cli-reference.test.ts`
 * asserts that each contract lands only in the sections that declare it.
 */
function commandSection(cmd: CommandSpec): string {
  const own = cmd.flags.length > 0 ? flagTable(cmd.flags) : '_No flags of its own._';
  return [
    `### \`${cmd.name}\``,
    '',
    `**${cmd.question}**`,
    '',
    '```bash',
    `npm run sysprose -- ${cmd.name} <file.sysml|-> [options]`,
    '```',
    '',
    own,
    '',
    `Computed by \`${cmd.backedBy}\`. With \`--json\` the answer is published under \`${cmd.payloadKey}\`, beside \`ok\` and \`file\`.`,
    '',
    `${exitCodesFor(cmd).replace('Exit codes: ', '**Exit codes.** ')}.`,
  ].join('\n');
}

/** The whole document, as a string, from the spec and nothing else. */
export function renderCliReference(): string {
  const presets = [...TRACE_PRESETS.entries()]
    .map(([name, kinds]) => `| \`${name}\` | ${kinds.map((k) => `\`${k}\``).join(', ')} |`)
    .join('\n');
  const reporting = COMMANDS.filter((c) => c.exitContract === 'report');
  const judging = COMMANDS.filter((c) => c.exitContract === 'verify');
  // `refine` judges too, and its 1 is a decided negative in the same sense —
  // but about an ARCHITECTURE rather than about the file's values, which is why
  // it carries its own contract instead of `verify`'s. See REFINE_EXIT_CODES.
  const refining = COMMANDS.filter((c) => c.exitContract === 'refine');
  // `bounds` DECIDES without judging: it reports the tightest value the axioms
  // admit, and a number is not a violation — so its contract is the only one in
  // this table with no exit 1 to misread.
  const bounding = COMMANDS.filter((c) => c.exitContract === 'bounds');
  const writing = COMMANDS.filter((c) => c.exitContract === 'write');
  // And the behaviour lane's judging half, which carries a contract of its own
  // for `refine`'s reason: `verify`'s paragraph names a `--free`, a `--timeout`
  // and an absent solver, and there is no solver in that lane at all.
  const behaving = COMMANDS.filter((c) => c.exitContract === 'behaviour');
  // And the safety lane's own, whose 1 is about a COMBINATION of contract
  // failures rather than about one obligation: a decomposition that refines can
  // still have a single point of failure, which is the whole reason that
  // command exists. See FAULT_TREE_EXIT_CODES.
  const injecting = COMMANDS.filter((c) => c.exitContract === 'fault-tree');
  // COUNTED, NOT SPELLED. This paragraph said "there are five of them" while
  // the table declared six, because the number was a word somebody typed once
  // and every new contract since has been added without it. It is a fact about
  // the table, so it is read off the table.
  const contracts = new Set(COMMANDS.map((c) => c.exitContract)).size;

  return `<!-- GENERATED by scripts/gen-cli-reference.ts — do not edit by hand.
     Edit scripts/lib/sysprose-spec.ts and run \`npm run commands\`. -->

# Command reference

Two commands read a \`.sysml\` file from a terminal. [\`npm run check\`](#npm-run-check)
says whether the file is **sound**; \`npm run sysprose\` says what is **in** it.
Each subcommand is a thin shell over the exported function named in its
\`Backed by\` line, so a figure read here and the same figure computed from that
import cannot differ. The app answers the same QUESTIONS, but several of its
views draw their own projection rather than call the reporting function — the
[user guide](USER-GUIDE.md) and the README's capability table mark which, and
say how the two can differ.

For what the answers mean — and for the app the commands mirror — read the
[user guide](USER-GUIDE.md). For what a diagnostic \`code\` means, read the
[diagnostic-code catalogue](DIAGNOSTIC-CODES.md).

## \`npm run sysprose\`

\`\`\`bash
npm run sysprose -- <subcommand> <file.sysml|-> [options]
cat model.sysml | npm run sysprose -- stats -
npm run sysprose -- --help                 # the subcommand list
npm run sysprose -- <subcommand> --help    # the flags of one subcommand
\`\`\`

**The exit-code contract is per subcommand, and there are ${contracts} of them.** Most
subcommands *report*: ${reporting.map((c) => `\`${c.name}\``).join(', ')} — for those,
${EXIT_CODES.replace('Exit codes: ', '')}. ${listOf(judging.map((c) => `\`${c.name}\``))}
${judging.length === 1 ? '*judges*' : '*judge*'}, and ${judging.length === 1 ? 'its' : 'their'} 1 means a **decided negative** — an
obligation refuted with every feature at its model value, or one requirement set
nothing can satisfy. ${listOf(refining.map((c) => `\`${c.name}\``))} ${refining.length === 1 ? 'judges an *architecture*' : 'judge an *architecture*'} and ${refining.length === 1 ? 'carries' : 'carry'} a contract of
${refining.length === 1 ? 'its' : 'their'} own, because a refinement obligation reads no feature value and there is
no \`--free\` for it: ${REFINE_EXIT_CODES.replace('Exit codes: ', '')}.
${listOf(bounding.map((c) => `\`${c.name}\``))} ${bounding.length === 1 ? 'DECIDES' : 'DECIDE'} without judging — ${bounding.length === 1 ? 'it reports' : 'they report'} the tightest value
the model's axioms admit, and a number is not a violation — so ${bounding.length === 1 ? 'its contract has' : 'their contract has'} no exit 1
in it at all: ${BOUNDS_EXIT_CODES.replace('Exit codes: ', '')}.
${listOf(writing.map((c) => `\`${c.name}\``))} ${writing.length === 1 ? '*writes*' : '*write*'} the
file back, and ${writing.length === 1 ? 'it has' : 'they have'} no exit 1 at all:
${WRITE_EXIT_CODES.replace('Exit codes: ', '')}.
${listOf(behaving.map((c) => `\`${c.name}\``))} ${behaving.length === 1 ? 'judges a *machine*' : 'judge a *machine*'} and ${behaving.length === 1 ? 'carries' : 'carry'} another,
because there is no solver in that lane and no \`--free\` for it either:
${BEHAVIOUR_EXIT_CODES.replace('Exit codes: ', '')}.
${listOf(injecting.map((c) => `\`${c.name}\``))} ${injecting.length === 1 ? 'judges an *architecture from the failure side*' : 'judge an *architecture from the failure side*'} and ${injecting.length === 1 ? 'carries' : 'carry'} the last of them,
because ${injecting.length === 1 ? 'its' : 'their'} 1 is a combination of contract failures rather than one refuted
obligation — a decomposition that refines can still have a single point of
failure: ${FAULT_TREE_EXIT_CODES.replace('Exit codes: ', '')}. Each section below states its own
contract in full, and every section states which of the ${contracts} it obeys.

Under the reporting contract, exit **1** is about the *model*, not the report:
those subcommands report and do not judge, so finding four unused definitions is
an answer and exits 0. A model that did not load cleanly still produces a
report — of what error recovery salvaged — with a \`degraded\` banner on stderr
saying so. Under the judging contract a degraded model is exit **2**: a verdict
over half a model is not a verdict.

**stdout carries the report; stderr carries everything about the file**, for
every exit code, so a pipeline gets the data and a person gets the warnings.

Two refusals, each replacing an answer that would read as true: a file that
parsed and produced no elements exits 2 rather than reporting an empty success,
and an element reference matching several elements exits 2 with the candidates
rather than reporting on the first one.

### The subcommands

| Subcommand | Question it answers | \`--json\` key | Exit contract |
|---|---|---|---|
${COMMANDS.map((c) => `| [\`${c.name}\`](#${c.name}) | ${cell(c.question)} | \`${c.payloadKey}\` | ${c.exitContract === 'verify' || c.exitContract === 'refine' || c.exitContract === 'behaviour' || c.exitContract === 'fault-tree' ? 'judges' : c.exitContract === 'bounds' ? 'decides' : c.exitContract === 'write' ? 'writes' : 'reports'} |`).join('\n')}

### Options every subcommand takes

${flagTable(COMMON_FLAGS)}

**\`--no-library\` and \`--include-library\` are two different knobs.**
\`--no-library\` skips *binding*: it changes the model, and library types then
report as unresolved. \`--include-library\` changes *reporting*: the library is
bound and then listed alongside your model. Only \`elements\` can honour the
second one — every other report excludes the library by construction and states
its own excluded count — so it is refused elsewhere rather than accepted and
quietly ignored.

## Subcommands in detail

${COMMANDS.map(commandSection).join('\n\n')}

### \`trace\` relationship presets

A preset names the **relationship** kinds only. The row and column metaclasses
are read off the model's own edges, because \`satisfy\` links a \`PartUsage\` to a
\`RequirementDefinition\` in one model and to a \`RequirementUsage\` in the next,
and a matrix that silently reports zero rows for the second shape is worse than
no command at all. \`--from\` / \`--to\` override the derived axes; an override
naming a metaclass the model has none of is refused rather than honoured into an
empty matrix.

| \`--relation\` | Relationship metaclasses tabulated |
|---|---|
${presets}

## \`npm run check\`

\`\`\`bash
npm run check -- <file.sysml> [more files…] [options]
cat model.sysml | npm run check -- -
\`\`\`

| Flag | What it does |
|---|---|
| \`--json\` | Machine-readable report on stdout: \`{ok, files: [...]}\` — \`files\`, plural, because \`check\` takes several |
| \`--strict\` | Treat warnings as failures (affects \`ok\` and the exit code) |
| \`--no-library\` | Skip standard-library binding (faster; library types such as \`Real\` then report as unresolved) |
| \`--ranges\` | Include the element→source-range table |
| \`-h\`, \`--help\` | This text |

**${CHECK_EXIT_CODES}** — and this is NOT \`sysprose\`'s contract. \`check\`
*judges*: a file that parsed perfectly and broke one validation rule loaded
cleanly and still exits 1. \`sysprose\` *reports*, so its exit 1 is about the
model, not the findings.

Parses each file, binds the bundled standard library, and runs the validation
rules; \`-\` reads stdin, as with \`sysprose\`. Every finding
carries a stable \`code\`, a source \`range\` (line, column and offset, start and
end) and a one-line \`hint\`; parser errors also carry \`expected\` and \`found\`.
Branch on \`code\`, never on \`message\` — see
[\`DIAGNOSTIC-CODES.md\`](DIAGNOSTIC-CODES.md).

---

*${COMMANDS.length} subcommands. Generated from \`scripts/lib/sysprose-spec.ts\`.*
`;
}

/**
 * Only write when this file was RUN. Imported — which the drift test does — it
 * must not touch the document it is being compared against.
 */
const runAsScript =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (runAsScript) {
  const out = resolve(process.cwd(), 'docs/CLI-REFERENCE.md');
  writeFileSync(out, renderCliReference());
  process.stdout.write(`Wrote ${out} — ${COMMANDS.length} subcommands.\n`);
}

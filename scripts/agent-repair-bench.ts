#!/usr/bin/env tsx
/**
 * The agent bench — the measurement the campaign exists for, in two suites.
 *
 * The fixture goldens prove the tool SAYS the right thing. The L6 invariants
 * prove every finding is machine-actionable in shape. Neither proves the thing
 * that actually matters: that a model reading only the tool's output can DO the
 * work. Each suite measures one half of that directly.
 *
 * **`--suite repair`** (the default). For each fixture: hand a model the flawed
 * `input.sysml` and the JSON report, ask for a corrected file, check the result,
 * and repeat up to `--rounds` times. Record rounds-to-clean per case and a pass
 * rate over the corpus.
 *
 * **`--suite verification`** (plan §3.3). For each requirement in the shipped
 * examples: hand a model the requirement's PROSE and the `property-draft`
 * payload — the data dictionary, the FRETish skeleton, the fields the tool
 * cannot encode, and the `#prompt` guidance the engineer wrote — ask for one
 * clause, and put it through `propertyCheck`. A refusal goes back to the model
 * with the gate that produced it, up to `--rounds` times. Record clauses
 * accepted, rounds-to-accepted, and which gate refused the ones that never were.
 *
 * WHAT THE SECOND SUITE DOES NOT MEASURE, and cannot: whether the accepted
 * clause is the formalisation the prose asked for. Nothing in this tool reads
 * prose, `property-check` says so on every report, and a bench that scored
 * meaning would be scoring its own opinion of it. What it measures is narrower
 * and still worth having — how much of the gate surface an agent clears from the
 * draft alone — and the per-gate refusal histogram is the deliverable: a gate
 * that refuses most first attempts is a gate whose draft output is not saying
 * enough.
 *
 * The agent is given NO hint about which case it is, no expected answer, and no
 * commentary — only what a real agent would have: the tool's own output. That is
 * the point; anything else measures the prompt.
 *
 *   npm run bench                      # every fixture, 3 rounds, `claude -p`
 *   npm run bench -- --rounds 2 --only L2
 *   npm run bench -- --suite verification
 *   npm run bench -- --model sonnet --out docs/campaign-runs/2026-09-02.md
 *
 * Requires a `claude` CLI on PATH. Without one it exits 2 and changes nothing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkText, type CheckReport } from '../src/text/check';
import { loadModelText } from '../src/text/load';
import { propertyCheck, propertyDraft, type PropertyCheckReport } from '../src/api/index';
import { contractsOf } from '../src/semantics/index';
import type { Model } from '../src/core/index';
import type { TextRange } from '../src/validation/types';

const FIXTURES = resolve(process.cwd(), 'test/fixtures/agent-authoring');
const EXAMPLES = resolve(process.cwd(), 'examples');

/** Which measurement this run is. */
type Suite = 'repair' | 'verification';

export const SUITES: readonly Suite[] = ['repair', 'verification'];

/** A mistake in what was ASKED: one sentence to stderr, exit 2, no stack. */
export class BenchUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchUsageError';
  }
}

export interface Options {
  suite: Suite;
  rounds: number;
  only?: string;
  model?: string;
  out?: string;
  timeoutMs: number;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = { suite: 'repair', rounds: 3, timeoutMs: 180_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rounds') o.rounds = Number(argv[++i]);
    else if (a === '--only') o.only = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--suite') {
      const raw = argv[++i];
      // Refused rather than defaulted: a misspelt suite name that silently ran
      // the other one would publish a table headed with a measurement nobody
      // took.
      if (!SUITES.includes(raw as Suite)) {
        throw new BenchUsageError(
          `--suite must be one of ${SUITES.join(', ')}, not \`${raw}\``,
        );
      }
      o.suite = raw as Suite;
    }
  }
  return o;
}

/** The only thing the agent is told. Deliberately spare. */
function prompt(source: string, report: CheckReport): string {
  const findings = report.diagnostics.map((d) => ({
    code: d.code,
    severity: d.severity,
    message: d.message,
    line: d.range?.start.line,
    column: d.range?.start.column,
    expected: d.expected,
    found: d.found,
    hint: d.hint,
  }));
  return [
    'You are repairing a SysML v2 textual-notation file.',
    '',
    'THE FILE:',
    '```',
    source.replace(/\n$/, ''),
    '```',
    '',
    'WHAT THE TOOL REPORTS ABOUT IT:',
    '```json',
    JSON.stringify(findings, null, 2),
    '```',
    '',
    'Return the CORRECTED file and nothing else: no explanation, no commentary,',
    'no markdown fence. Change as little as possible — fix only what is reported.',
  ].join('\n');
}

/** Strip a markdown fence if the model wrapped its answer in one. */
function unfence(s: string): string {
  const m = /^\s*```(?:sysml|text)?\n([\s\S]*?)\n```\s*$/.exec(s.trim());
  return (m ? m[1] : s).trim() + '\n';
}

function askModel(text: string, opts: Options): string {
  const args = ['-p', ...(opts.model ? ['--model', opts.model] : [])];
  return unfence(
    execFileSync('claude', args, {
      input: text,
      encoding: 'utf8',
      timeout: opts.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}

interface CaseResult {
  name: string;
  level: string;
  startErrors: number;
  rounds: number | null; // null = never reached clean
  finalErrors: number;
  minimal: boolean | null; // did it touch only what was reported?
  note?: string;
}

/**
 * Did the repair stay close to the original, or rewrite the file?
 *
 * Counted in CHANGED LINES rather than as a ratio: a ratio punishes a
 * three-line fixture for a one-line fix. A repair is minimal when it touched no
 * more lines than there were findings to act on, plus one for slack.
 */
function isMinimal(before: string, after: string, findings: number): boolean {
  const a = before.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const b = after.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const kept = new Set(a);
  const added = b.filter((l) => !kept.has(l)).length;
  const seen = new Set(b);
  const removed = a.filter((l) => !seen.has(l)).length;
  return Math.max(added, removed) <= findings + 1;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  try {
    execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  } catch {
    process.stderr.write(
      'agent-repair-bench: no `claude` CLI on PATH — nothing measured.\n' +
        'This bench deliberately fails loudly rather than reporting a vacuous pass.\n',
    );
    return 2;
  }
  return opts.suite === 'verification' ? verificationSuite(opts) : repairSuite(opts);
}

/** The original measurement: can a model repair a file from the report alone? */
async function repairSuite(opts: Options): Promise<number> {
  const names = readdirSync(FIXTURES)
    .filter((n) => !n.startsWith('.'))
    .filter((n) => (opts.only ? n.startsWith(opts.only) : true))
    .sort();

  const results: CaseResult[] = [];
  for (const name of names) {
    const dir = join(FIXTURES, name);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { level: string };
    const original = readFileSync(join(dir, 'input.sysml'), 'utf8');
    let source = original;
    let report = await checkText(source, { library: 'full', fileName: `${name}.sysml` });
    const startErrors = report.summary.errors;

    if (startErrors === 0) {
      results.push({
        name,
        level: meta.level,
        startErrors: 0,
        rounds: 0,
        finalErrors: 0,
        minimal: null,
        note: 'no errors to repair',
      });
      process.stdout.write(`· ${name}: already clean\n`);
      continue;
    }

    let solved: number | null = null;
    for (let round = 1; round <= opts.rounds; round++) {
      let answer: string;
      try {
        answer = askModel(prompt(source, report), opts);
      } catch (err) {
        results.push({
          name,
          level: meta.level,
          startErrors,
          rounds: null,
          finalErrors: report.summary.errors,
          minimal: null,
          note: `model call failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`,
        });
        break;
      }
      source = answer;
      report = await checkText(source, { library: 'full', fileName: `${name}.sysml` });
      if (report.summary.errors === 0) {
        solved = round;
        break;
      }
    }
    if (results.at(-1)?.name === name) continue; // model-call failure already recorded

    results.push({
      name,
      level: meta.level,
      startErrors,
      rounds: solved,
      finalErrors: report.summary.errors,
      minimal: isMinimal(original, source, startErrors),
    });
    process.stdout.write(
      solved === null
        ? `✗ ${name}: still ${report.summary.errors} error(s) after ${opts.rounds} round(s)\n`
        : `✓ ${name}: clean in ${solved} round(s)${results.at(-1)?.minimal ? '' : ' (rewrote the file)'}\n`,
    );
  }

  const repairable = results.filter((r) => r.startErrors > 0);
  const solved = repairable.filter((r) => r.rounds !== null);
  const firstTry = repairable.filter((r) => r.rounds === 1);
  const lines = [
    `# Agent repair bench — ${names.length} fixtures`,
    '',
    `Model: ${opts.model ?? 'default'} · max ${opts.rounds} round(s) per case.`,
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Fixtures with errors to repair | ${repairable.length} |`,
    `| Repaired to a clean check | ${solved.length} |`,
    `| Repaired on the first round | ${firstTry.length} |`,
    `| Never repaired | ${repairable.length - solved.length} |`,
    `| Repaired with a minimal edit | ${solved.filter((r) => r.minimal).length} |`,
    '',
    '| Case | Level | Errors | Rounds | Minimal |',
    '|---|---|---:|---:|---|',
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.level} | ${r.startErrors} | ${r.rounds ?? '—'} | ${r.minimal === null ? '—' : r.minimal ? 'yes' : 'no'} |${r.note ? ` ${r.note}` : ''}`,
    ),
    '',
    `Repair rate: **${repairable.length === 0 ? 'n/a' : Math.round((solved.length / repairable.length) * 100)}%**.`,
  ].join('\n');

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${lines}\n`);
    process.stdout.write(`\nWrote ${opts.out}\n`);
  } else {
    process.stdout.write(`\n${lines}\n`);
  }
  return solved.length === repairable.length ? 0 : 1;
}

/* ───────────────────── the verification suite (plan §3.3) ────────────────── */

/**
 * One requirement the second suite asks a model to write a clause for.
 *
 * The MODEL travels with the case, and that is not an optimisation. Element ids
 * are fresh UUIDs on every load, so a case that carried only an id and let the
 * suite reload the file would hand `propertyDraft` an id from a model that no
 * longer exists — which is a throw on the first case and a bench that measures
 * nothing. One load, one id space, and the `ranges`/`text` the insertion point is
 * computed from come from that same load.
 */
export interface PropertyCase {
  file: string;
  requirementId: string;
  name: string;
  statement: string;
  model: Model;
  ranges: ReadonlyMap<string, TextRange>;
  text: string;
}

/** One case's outcome: accepted in N rounds, or refused with the gate that did it. */
interface PropertyResult {
  name: string;
  file: string;
  rounds: number | null;
  clause: string;
  outcome: string;
  /** The gate that refused the LAST attempt, `null` when none did. */
  refusedAt: number | null;
  code: string | null;
  note?: string;
}

/**
 * Everything the agent is told, and nothing else.
 *
 * The prose, the dictionary, the skeleton, the fields the tool cannot encode and
 * the `#prompt` guidance — which is exactly what `property-draft` prints, so a
 * gap in this prompt is a gap in the command rather than in the bench. On a
 * later round the previous clause and the gate that refused it are added, and
 * nothing else: a hint about the expected answer would measure the hint.
 */
function propertyPrompt(c: PropertyCase, draft: unknown, previous?: PropertyCheckReport): string {
  return [
    'You are writing ONE formal clause for a SysML v2 requirement.',
    '',
    'THE REQUIREMENT, IN PROSE:',
    c.statement === '' ? '(the requirement carries no prose)' : c.statement,
    '',
    'WHAT THE TOOL WILL ACCEPT (its own draft output — dictionary, skeleton, guidance):',
    '```json',
    JSON.stringify(draft, null, 2),
    '```',
    ...(previous
      ? [
          '',
          'YOUR PREVIOUS ATTEMPT AND WHY IT WAS REFUSED:',
          '```json',
          JSON.stringify(
            {
              clause: previous.clause,
              refusedAt: previous.refusedAt,
              code: previous.code,
              detail: previous.detail,
              expected: previous.expected,
            },
            null,
            2,
          ),
          '```',
        ]
      : []),
    '',
    'Return the constraint body and NOTHING else: no `require`, no braces, no',
    'explanation, no markdown fence. One relation, over the names in the',
    'dictionary, written through the subject.',
  ].join('\n');
}

/** Every requirement in the shipped examples that states a contract. */
export async function propertyCases(only?: string): Promise<PropertyCase[]> {
  const out: PropertyCase[] = [];
  for (const file of readdirSync(EXAMPLES).filter((n) => n.endsWith('.sysml')).sort()) {
    const text = readFileSync(join(EXAMPLES, file), 'utf8');
    const { model, ranges } = await loadModelText(text, { fileName: `examples/${file}` });
    if (!model) continue;
    for (const contract of contractsOf(model)) {
      const name = contract.declaredName ?? contract.qualifiedName;
      if (only && !name.startsWith(only)) continue;
      out.push({
        file,
        requirementId: contract.id,
        name,
        statement: propertyDraft(model, contract.id).statement,
        model,
        ranges,
        text,
      });
    }
  }
  return out;
}

/**
 * The second measurement: can a model write a clause the gates ACCEPT, from the
 * draft alone?
 *
 * Every case is asked of the model {@link propertyCases} loaded it from — see
 * there for why re-reading the file here would break the run outright.
 */
async function verificationSuite(opts: Options): Promise<number> {
  const cases = await propertyCases(opts.only);
  const results: PropertyResult[] = [];
  for (const c of cases) {
    const model = c.model;
    const draft = propertyDraft(model, c.requirementId);
    let last: PropertyCheckReport | undefined;
    let accepted: number | null = null;
    let failure: string | undefined;
    for (let round = 1; round <= opts.rounds; round++) {
      let clause: string;
      try {
        clause = askModel(propertyPrompt(c, draft, last), opts).trim();
      } catch (err) {
        failure = `model call failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`;
        break;
      }
      last = await propertyCheck(model, c.requirementId, clause, {
        ranges: c.ranges,
        sourceText: c.text,
      });
      if (last.outcome !== 'refused') {
        accepted = round;
        break;
      }
    }
    results.push({
      name: c.name,
      file: c.file,
      rounds: accepted,
      clause: last?.clause ?? '',
      outcome: last?.outcome ?? 'not attempted',
      refusedAt: last?.refusedAt ?? null,
      code: last?.code ?? null,
      ...(failure !== undefined ? { note: failure } : {}),
    });
    process.stdout.write(
      accepted === null
        ? `✗ ${c.name}: refused at gate ${last?.refusedAt ?? '—'} after ${opts.rounds} round(s)\n`
        : `✓ ${c.name}: ${last?.outcome} in ${accepted} round(s)\n`,
    );
  }

  const acceptedCases = results.filter((r) => r.rounds !== null);
  const gates = new Map<number, number>();
  for (const r of results) {
    if (r.refusedAt === null) continue;
    gates.set(r.refusedAt, (gates.get(r.refusedAt) ?? 0) + 1);
  }
  const lines = [
    `# Agent property bench — ${results.length} requirement(s) in examples/`,
    '',
    `Model: ${opts.model ?? 'default'} · max ${opts.rounds} round(s) per case.`,
    '',
    'What this measures: whether a model can write a clause the GATES accept, from',
    '`property-draft` alone. It does not measure whether the clause is the',
    'formalisation the prose asked for — nothing in this tool reads prose, and a',
    'bench that scored meaning would be scoring its own opinion of it.',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Requirements asked | ${results.length} |`,
    `| Clause accepted | ${acceptedCases.length} |`,
    `| Accepted on the first round | ${results.filter((r) => r.rounds === 1).length} |`,
    `| Never accepted | ${results.length - acceptedCases.length} |`,
    '',
    ...(gates.size > 0
      ? [
          '| Gate that refused the last attempt | Cases |',
          '|---|---:|',
          ...[...gates.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([gate, n]) => `| gate ${gate} | ${n} |`),
          '',
        ]
      : []),
    '| Case | File | Rounds | Outcome | Clause |',
    '|---|---|---:|---|---|',
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.file} | ${r.rounds ?? '—'} | ${r.outcome}${r.code ? ` (${r.code})` : ''} | \`${r.clause}\` |${r.note ? ` ${r.note}` : ''}`,
    ),
    '',
    `Acceptance rate: **${results.length === 0 ? 'n/a' : Math.round((acceptedCases.length / results.length) * 100)}%**.`,
  ].join('\n');

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${lines}\n`);
    process.stdout.write(`\nWrote ${opts.out}\n`);
  } else {
    process.stdout.write(`\n${lines}\n`);
  }
  return acceptedCases.length === results.length ? 0 : 1;
}

/**
 * Only when this file was RUN.
 *
 * The same guard `scripts/gen-cli-reference.ts` uses, for the same reason: the
 * suite that keeps this bench honest imports `parseArgs` and `propertyCases`, and
 * an import that spent a `claude` call as a side effect would be untestable by
 * construction — which is how the whole `--suite verification` half shipped with
 * no test at all.
 */
const runAsScript =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (runAsScript) {
  main().then(
    (c) => process.exit(c),
    (e: unknown) => {
      // One sentence for a usage error — a misspelt `--suite` is a mistake in
      // what was asked, not a defect to hand somebody a stack trace about.
      const usage = e instanceof Error && e.name === 'BenchUsageError';
      process.stderr.write(
        `agent-repair-bench: ${usage ? (e as Error).message : e instanceof Error ? e.stack : String(e)}\n`,
      );
      process.exit(2);
    },
  );
}

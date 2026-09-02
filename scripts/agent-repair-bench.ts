#!/usr/bin/env tsx
/**
 * The repair bench — the measurement the campaign exists for.
 *
 * The fixture goldens prove the tool SAYS the right thing. The L6 invariants
 * prove every finding is machine-actionable in shape. Neither proves the thing
 * that actually matters: that a model reading only the report can REPAIR the
 * file. This measures that directly.
 *
 * For each fixture: hand a model the flawed `input.sysml` and the JSON report,
 * ask for a corrected file, check the result, and repeat up to `--rounds` times.
 * Record rounds-to-clean per case and a pass rate over the corpus.
 *
 * The agent is given NO hint about which fixture it is, no `fixed.sysml`, and no
 * commentary — only what a real agent would have: its own broken file and the
 * tool's output. That is the point; anything else measures the prompt.
 *
 *   npm run bench                      # every fixture, 3 rounds, `claude -p`
 *   npm run bench -- --rounds 2 --only L2
 *   npm run bench -- --model sonnet --out docs/campaign-runs/2026-09-02.md
 *
 * Requires a `claude` CLI on PATH. Without one it exits 2 and changes nothing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { checkText, type CheckReport } from '../src/text/check';

const FIXTURES = resolve(process.cwd(), 'test/fixtures/agent-authoring');

interface Options {
  rounds: number;
  only?: string;
  model?: string;
  out?: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { rounds: 3, timeoutMs: 180_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rounds') o.rounds = Number(argv[++i]);
    else if (a === '--only') o.only = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]) * 1000;
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

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    process.stderr.write(`agent-repair-bench: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(2);
  },
);

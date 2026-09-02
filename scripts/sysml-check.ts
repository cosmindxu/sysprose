#!/usr/bin/env tsx
/**
 * `sysml-check` — check `.sysml` files from the command line.
 *
 * The primary channel for an AI agent authoring models as text: write a file,
 * run this, read the JSON, fix the file, repeat. No browser, no server.
 *
 *   npm run check -- examples/vehicle.sysml
 *   npm run check -- model.sysml --json
 *   cat model.sysml | npm run check -- -
 *
 * Exit codes are the contract:
 *   0  every file checked clean
 *   1  at least one file has errors (or warnings, with --strict)
 *   2  usage or I/O problem — nothing was checked
 *
 * See docs/AGENT-AUTHORING-CAMPAIGN.md for the agent loop and
 * docs/DIAGNOSTIC-CODES.md for what each `code` means.
 */

import { readFileSync } from 'node:fs';
import { checkText, type CheckReport } from '../src/text/check';

const USAGE = `sysml-check — check SysML v2 textual notation

Usage:
  npm run check -- <file.sysml> [more files…] [options]
  cat model.sysml | npm run check -- -

Options:
  --json          Machine-readable report on stdout (the agent-facing format)
  --strict        Treat warnings as failures (affects "ok" and the exit code)
  --no-library    Skip standard-library binding (faster; library types
                  such as Real then report as unresolved)
  --ranges        Include the element→source-range table (implies richer --json)
  -h, --help      This text

Exit codes: 0 clean · 1 findings · 2 usage/IO error`;

interface Options {
  files: string[];
  json: boolean;
  strict: boolean;
  library: 'full' | 'none';
  ranges: boolean;
}

function parseArgs(argv: string[]): Options | { error: string } {
  const opts: Options = { files: [], json: false, strict: false, library: 'full', ranges: false };
  for (const a of argv) {
    switch (a) {
      case '--json':
        opts.json = true;
        break;
      case '--strict':
        opts.strict = true;
        break;
      case '--no-library':
        opts.library = 'none';
        break;
      case '--ranges':
        opts.ranges = true;
        break;
      default:
        if (a.startsWith('-') && a !== '-') return { error: `unknown option: ${a}` };
        opts.files.push(a);
    }
  }
  if (opts.files.length === 0) return { error: 'no input files' };
  return opts;
}

/** Read one input; `-` means stdin. */
function read(file: string): string {
  return file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
}

/** Human-readable rendering: one `file:line:col: severity code message` per finding. */
function renderText(report: CheckReport): string {
  const name = report.fileName ?? '<stdin>';
  const lines: string[] = [];
  for (const d of report.diagnostics) {
    const at = d.range ? `${d.range.start.line}:${d.range.start.column}` : '-';
    lines.push(`${name}:${at}: ${d.severity} ${d.code ?? d.ruleId}  ${d.message}`);
    if (d.expected && d.expected.length > 0) {
      lines.push(`    expected: ${d.expected.join(' | ')}${d.found ? `   found: ${d.found}` : ''}`);
    }
    if (d.hint) lines.push(`    hint: ${d.hint}`);
  }
  const { errors, warnings, infos } = report.summary;
  lines.push(
    `${name}: ${report.ok ? 'OK' : 'FAILED'} — ${errors} error(s), ${warnings} warning(s), ${infos} info(s); ` +
      `${report.elements.count} element(s)${report.elements.roots.length > 0 ? `, roots: ${report.elements.roots.join(', ')}` : ''}`,
  );
  return lines.join('\n');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`sysml-check: ${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }

  const reports: CheckReport[] = [];
  for (const file of parsed.files) {
    let text: string;
    try {
      text = read(file);
    } catch (err) {
      process.stderr.write(
        `sysml-check: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
    reports.push(
      await checkText(text, {
        library: parsed.library,
        strict: parsed.strict,
        includeRanges: parsed.ranges,
        fileName: file === '-' ? '<stdin>' : file,
      }),
    );
  }

  const ok = reports.every((r) => r.ok);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ ok, files: reports }, null, 2)}\n`);
  } else {
    process.stdout.write(`${reports.map(renderText).join('\n\n')}\n`);
  }
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Never exit 0 on an unexpected failure: a silent pass is the one outcome
    // that would let a broken model through.
    process.stderr.write(`sysml-check: internal error: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  },
);

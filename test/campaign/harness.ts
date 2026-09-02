/**
 * Shared harness for the agent authoring testing campaign
 * (`docs/AGENT-AUTHORING-CAMPAIGN.md`).
 *
 * The campaign asks one question of every fixture: **if an AI agent wrote this
 * flawed `.sysml` file, does the tool tell it enough to fix the file?** Each
 * case is a directory holding the flawed `input.sysml`, a golden `expected.json`
 * describing the diagnostics an agent needs, optionally a `fixed.sysml` showing
 * what a correct repair looks like, and `meta.json` for level/title/notes.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Diagnostic } from '@validation/types';
import type { CheckReport } from '@text/check';

export const FIXTURE_ROOT = resolve(process.cwd(), 'test/fixtures/agent-authoring');

/** One expected diagnostic. Fields left out are not asserted. */
export interface ExpectedDiagnostic {
  /** Catalogue code — always asserted exactly. */
  code: string;
  severity?: 'error' | 'warning' | 'info';
  /** 1-based line; `'*'` accepts any line (use only where position is genuinely undefined). */
  line?: number | '*';
  column?: number | '*';
  /** Exact string, or `/regex/` to match the message loosely. */
  message?: string;
  /** Every listed token must appear in the actual `expected` array. */
  expected?: string[];
  found?: string;
  /** Substring that must appear in the rendered hint. */
  hintIncludes?: string;
}

/** The golden file for one case. */
export interface Golden {
  level: string;
  title: string;
  /**
   * The tool's output is currently INADEQUATE for this case and the golden
   * records the inadequacy rather than blessing it. The runner asserts the
   * shortfall still exists and fails loudly if it is fixed, so the fix is
   * noticed and the fixture promoted.
   */
  expectFail?: { reason: string };
  /** Non-obvious background, carried into the docs. */
  note?: string;
  /** `ok` the report must have. */
  ok: boolean;
  /** Diagnostics that MUST be present (multiset; extra warnings are tolerated). */
  diagnostics: ExpectedDiagnostic[];
  invariants?: {
    /** Upper bound on error count — bounds cascades from one real mistake. */
    maxErrors?: number;
    /** Root declarations that must survive error recovery. */
    rootsSurvive?: string[];
    /** Minimum number of the agent's own elements that must survive. */
    minElements?: number;
    /** Fail if any warning is not listed in `diagnostics`. */
    strictWarnings?: boolean;
  };
}

export interface CampaignCase {
  name: string;
  dir: string;
  input: string;
  fixed?: string;
  golden: Golden;
}

/** Load every fixture case, sorted by name so runs are deterministic. */
export function loadCases(): CampaignCase[] {
  return readdirSync(FIXTURE_ROOT)
    .filter((n) => !n.startsWith('.'))
    .sort()
    .map((name) => {
      const dir = join(FIXTURE_ROOT, name);
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as {
        level: string;
        title: string;
        note?: string;
      };
      const goldenPath = join(dir, 'expected.json');
      const golden: Golden = existsSync(goldenPath)
        ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as Golden)
        : { ...meta, ok: false, diagnostics: [] };
      const fixedPath = join(dir, 'fixed.sysml');
      return {
        name,
        dir,
        input: readFileSync(join(dir, 'input.sysml'), 'utf8'),
        ...(existsSync(fixedPath) ? { fixed: readFileSync(fixedPath, 'utf8') } : {}),
        golden,
      };
    });
}

/** Does an actual diagnostic satisfy an expectation? */
export function matches(exp: ExpectedDiagnostic, d: Diagnostic): boolean {
  if (d.code !== exp.code) return false;
  if (exp.severity && d.severity !== exp.severity) return false;
  if (exp.line !== undefined && exp.line !== '*' && d.range?.start.line !== exp.line) return false;
  if (exp.column !== undefined && exp.column !== '*' && d.range?.start.column !== exp.column) {
    return false;
  }
  if (exp.message !== undefined) {
    const m = exp.message;
    if (m.startsWith('/') && m.endsWith('/')) {
      if (!new RegExp(m.slice(1, -1)).test(d.message)) return false;
    } else if (d.message !== m) return false;
  }
  if (exp.found !== undefined && d.found !== exp.found) return false;
  if (exp.expected !== undefined) {
    const actual = d.expected ?? [];
    if (!exp.expected.every((t) => actual.includes(t))) return false;
  }
  if (exp.hintIncludes !== undefined && !(d.hint ?? '').includes(exp.hintIncludes)) return false;
  return true;
}

/**
 * Compare a report against a golden. Returns the reasons it failed, empty when
 * it passed — a list rather than a boolean so a failure message can say
 * everything that is wrong at once.
 */
export function goldenFailures(golden: Golden, report: CheckReport): string[] {
  const problems: string[] = [];
  if (report.ok !== golden.ok) {
    problems.push(`ok: expected ${golden.ok}, got ${report.ok}`);
  }
  const unmatched = [...report.diagnostics];
  for (const exp of golden.diagnostics) {
    const i = unmatched.findIndex((d) => matches(exp, d));
    if (i === -1) problems.push(`missing diagnostic: ${JSON.stringify(exp)}`);
    else unmatched.splice(i, 1);
  }
  const inv = golden.invariants ?? {};
  if (inv.maxErrors !== undefined && report.summary.errors > inv.maxErrors) {
    problems.push(`too many errors: ${report.summary.errors} > maxErrors ${inv.maxErrors}`);
  }
  if (inv.minElements !== undefined && report.elements.count < inv.minElements) {
    problems.push(`too few elements survived: ${report.elements.count} < ${inv.minElements}`);
  }
  for (const r of inv.rootsSurvive ?? []) {
    if (!report.elements.roots.includes(r)) {
      problems.push(`root '${r}' did not survive (roots: ${report.elements.roots.join(', ')})`);
    }
  }
  if (inv.strictWarnings) {
    for (const d of unmatched.filter((x) => x.severity === 'warning')) {
      problems.push(`unexpected warning: ${d.code} ${d.message}`);
    }
  }
  return problems;
}

/** Render a report as the golden it would need — printed on failure. */
export function asGolden(golden: Golden, report: CheckReport): string {
  return JSON.stringify(
    {
      level: golden.level,
      title: golden.title,
      ...(golden.note ? { note: golden.note } : {}),
      ...(golden.expectFail ? { expectFail: golden.expectFail } : {}),
      ok: report.ok,
      diagnostics: report.diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        ...(d.range ? { line: d.range.start.line, column: d.range.start.column } : {}),
        ...(d.found !== undefined ? { found: d.found } : {}),
        ...(d.expected ? { expected: d.expected } : {}),
      })),
      invariants: {
        maxErrors: report.summary.errors,
        ...(report.elements.roots.length > 0 ? { rootsSurvive: report.elements.roots } : {}),
        minElements: report.elements.count,
      },
    },
    null,
    2,
  );
}

/** Bootstrap/refresh a golden from an actual report (CAMPAIGN_UPDATE=1 only). */
export function writeGolden(c: CampaignCase, report: CheckReport): void {
  writeFileSync(join(c.dir, 'expected.json'), `${asGolden(c.golden, report)}\n`);
}

/** Is golden regeneration enabled? Never true in CI. */
export const UPDATING = process.env.CAMPAIGN_UPDATE === '1';

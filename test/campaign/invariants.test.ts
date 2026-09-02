/**
 * Level L6 — feedback SUFFICIENCY, asserted across the whole fixture corpus.
 *
 * The per-fixture goldens check that the RIGHT diagnostic appears. These check
 * something harder and more valuable: that every diagnostic the tool emits is
 * USABLE by an agent that cannot see the screen. A finding with no position, no
 * stable code, or no indication of what is wrong is noise, however accurate.
 *
 * These are properties, not examples, so a new fixture is covered the moment it
 * is added — and a regression in diagnostic quality fails here even if every
 * golden still matches.
 */
import { describe, it, expect } from 'vitest';
import { checkText } from '@text/check';
import { isKnownCode } from '@text/index';
import { loadCases } from './harness';
import type { CheckReport } from '@text/check';
import type { Diagnostic } from '@validation/types';

const cases = loadCases();

/** Check every fixture once and reuse the reports across the assertions. */
const reports = new Map<string, { report: CheckReport; input: string }>();
async function allReports(): Promise<Map<string, { report: CheckReport; input: string }>> {
  if (reports.size === 0) {
    for (const c of cases) {
      reports.set(c.name, {
        report: await checkText(c.input, { library: 'full', fileName: `${c.name}.sysml` }),
        input: c.input,
      });
    }
  }
  return reports;
}

/** Every diagnostic across the corpus, tagged with the case it came from. */
async function everyDiagnostic(): Promise<Array<{ case: string; d: Diagnostic; input: string }>> {
  const out: Array<{ case: string; d: Diagnostic; input: string }> = [];
  for (const [name, { report, input }] of await allReports()) {
    for (const d of report.diagnostics) out.push({ case: name, d, input });
  }
  return out;
}

const show = (bad: Array<{ case: string; d: Diagnostic }>): string =>
  bad.map((b) => `  ${b.case}: ${b.d.code ?? '(no code)'} — ${b.d.message.slice(0, 90)}`).join('\n');

describe('L6 — every diagnostic is machine-actionable', () => {
  it('carries a code from the catalogue', async () => {
    const bad = (await everyDiagnostic()).filter(
      (x) => x.d.code === undefined || !isKnownCode(x.d.code),
    );
    expect(bad, `diagnostics with a missing/unknown code:\n${show(bad)}`).toEqual([]);
  });

  it('carries a source stage', async () => {
    const bad = (await everyDiagnostic()).filter((x) => x.d.source === undefined);
    expect(bad, `diagnostics with no source:\n${show(bad)}`).toEqual([]);
  });

  it('carries a non-empty hint', async () => {
    const bad = (await everyDiagnostic()).filter((x) => !x.d.hint || x.d.hint.trim() === '');
    expect(bad, `diagnostics with no hint:\n${show(bad)}`).toEqual([]);
  });

  it('gives every parse, lexer and mapper finding a source range', async () => {
    const bad = (await everyDiagnostic()).filter(
      (x) =>
        (x.d.source === 'parser' || x.d.source === 'lexer' || x.d.source === 'mapper') &&
        x.d.range === undefined,
    );
    expect(bad, `text-derived diagnostics with no range:\n${show(bad)}`).toEqual([]);
  });

  it('reports only positions that exist in the file', async () => {
    const bad = (await everyDiagnostic()).filter(({ d, input }) => {
      if (!d.range) return false;
      const lines = input.replace(/\r\n/g, '\n').split('\n');
      const { line, column, offset } = d.range.start;
      return (
        !Number.isFinite(line) ||
        !Number.isFinite(column) ||
        !Number.isFinite(offset) ||
        line < 1 ||
        column < 1 ||
        offset < 0 ||
        line > Math.max(lines.length, 1) ||
        offset > input.length
      );
    });
    expect(bad, `diagnostics pointing outside the file:\n${show(bad)}`).toEqual([]);
  });

  it('never reports an end before its start', async () => {
    const bad = (await everyDiagnostic()).filter(
      (x) => x.d.range !== undefined && x.d.range.end.offset < x.d.range.start.offset,
    );
    expect(bad, `inverted ranges:\n${show(bad)}`).toEqual([]);
  });

  it('names the offending token or element on every error', async () => {
    // An error the agent cannot attribute to anything concrete is unactionable.
    const bad = (await everyDiagnostic()).filter(
      (x) =>
        x.d.severity === 'error' &&
        x.d.source !== 'import' &&
        !x.d.found &&
        !x.d.elementName &&
        !x.d.elementId,
    );
    expect(bad, `errors naming neither a token nor an element:\n${show(bad)}`).toEqual([]);
  });

  it('gives every parser error either an expected-token list or a hint naming the fix', async () => {
    const bad = (await everyDiagnostic()).filter(
      (x) =>
        x.d.source === 'parser' &&
        (x.d.expected === undefined || x.d.expected.length === 0) &&
        !x.d.hint,
    );
    expect(bad, `parser errors with no repair information:\n${show(bad)}`).toEqual([]);
  });
});

describe('L6 — the checker itself is trustworthy', () => {
  it('never crashes: no fixture produces an internal error', async () => {
    const bad = (await everyDiagnostic()).filter((x) => x.d.code === 'import/internal-error');
    expect(bad, `the checker threw on these inputs:\n${show(bad)}`).toEqual([]);
  });

  it('reports ok exactly when there are no errors', async () => {
    for (const [name, { report }] of await allReports()) {
      expect(report.ok, `${name}: ok disagrees with the error count`).toBe(
        report.summary.errors === 0,
      );
    }
  });

  it('is deterministic: the same input twice gives the same diagnostics', async () => {
    for (const c of cases.slice(0, 8)) {
      const a = await checkText(c.input, { library: 'full', fileName: `${c.name}.sysml` });
      const b = await checkText(c.input, { library: 'full', fileName: `${c.name}.sysml` });
      expect(
        b.diagnostics.map((d) => `${d.code}@${d.range?.start.line}`),
        `${c.name} is not deterministic`,
      ).toEqual(a.diagnostics.map((d) => `${d.code}@${d.range?.start.line}`));
    }
  });
});

describe('L6 — a documented repair actually repairs', () => {
  it('every fixed.sysml checks clean', async () => {
    const broken: string[] = [];
    for (const c of cases.filter((x) => x.fixed !== undefined)) {
      const r = await checkText(c.fixed as string, { library: 'full' });
      if (r.summary.errors > 0) broken.push(`${c.name}: ${r.summary.errors} error(s)`);
    }
    expect(broken, `documented repairs that do not check clean:\n${broken.join('\n')}`).toEqual([]);
  });
});

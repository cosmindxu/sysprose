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
import { diagnosticCode, isKnownCode, parseModel, serializeModel } from '@text/index';
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

  /**
   * The catalogue tells an agent which STAGE produced a code, and the agent
   * branches on that ("a parser error means the text is malformed; a mapper
   * error means it parsed but means nothing here"). Nothing used to check the
   * two agreed: `parse/unknown-keyword` was declared `mapper` and emitted
   * `parser` for months, because it was emitted from BOTH stages.
   */
  it('emits every code from the stage its catalogue entry declares', async () => {
    const bad = (await everyDiagnostic()).filter(({ d }) => {
      const entry = d.code === undefined ? undefined : diagnosticCode(d.code);
      return entry !== undefined && d.source !== undefined && d.source !== entry.source;
    });
    expect(
      bad,
      `codes emitted from a stage their catalogue entry does not declare:\n${bad
        .map((b) => `  ${b.case}: ${b.d.code} emitted as '${b.d.source}', catalogue says '${diagnosticCode(b.d.code as string)?.source}'`)
        .join('\n')}`,
    ).toEqual([]);
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

/**
 * L6 — SAVING a flawed file does not launder it clean.
 *
 * The checker's report is only worth what the file is worth afterwards. Two
 * defects turned one error on the way IN into zero on the way OUT: a blank
 * declared name (`part def ''`) was collapsed to "anonymous" by every
 * serializer path but `comment`, and an unreadable multiplicity (`[]`) was
 * written back as the literal token `[undefined]` — legal notation naming a
 * phantom feature. In both cases `check` said FAILED, the user pressed save,
 * and `check` then said OK about a file that had lost the very thing it was
 * complaining about.
 *
 * The property does not yet hold corpus-wide — thirteen cases still re-parse
 * clean after a save, because error RECOVERY, not the serializer, is what
 * dropped their fault (the campaign ledger lists them under Known limitations).
 * So this is a named list: every case whose fault survives the round trip
 * today, asserted case by case, which is a ratchet — a change that starts
 * laundering any of them fails here.
 */
describe('L6 — an error cannot become OK by saving', () => {
  /**
   * Cases whose error survives parse → serialize → check.
   *
   * `L0-json-as-sysml` is in the list: its first save keeps an error, even
   * though it is the one file in the corpus that is not IDEMPOTENT — the save
   * leaves a bare `;`, which re-checks as `parse/not-all-input-parsed`, and a
   * SECOND save yields the empty string. That residue is recorded in the
   * campaign ledger under Known limitations; what this invariant asks of it is
   * the same thing it asks of every other case, and the answer is yes.
   */
  const SAVE_KEEPS_THE_ERROR = [
    'L0-json-as-sysml',
    'L1-illegal-char',
    'L2-two-independent-errors',
    'L2-unclosed-paren',
    'L2-unknown-keyword',
    'L2-unknown-keyword-no-def',
    'L2-unsupported-kerml-keyword',
    'L3-unresolved-connection-end',
    'L3-unresolved-redefinition',
    'L3-unresolved-specialization',
    'L3-unresolved-type',
    'L4-blank-name',
    'L4-duplicate-name',
    'L4-specialization-cycle',
    'L5-alias-body-after-fault',
    'L5-nested-fault-rehomes-inner',
    'L5-note-braces-after-fault',
    'L5-recovery-keeps-siblings',
    'L5-relationship-after-fault',
  ];

  it.each(SAVE_KEEPS_THE_ERROR)('%s still fails after being saved', async (name) => {
    const c = cases.find((x) => x.name === name);
    expect(c, `no fixture named ${name}`).toBeDefined();
    const before = await checkText(c!.input, { library: 'full', fileName: `${name}.sysml` });
    expect(before.summary.errors, `${name} is expected to fail on the way in`).toBeGreaterThan(0);

    const saved = serializeModel(parseModel(c!.input).model);
    const after = await checkText(saved, { library: 'full', fileName: `${name}.sysml` });
    expect(
      after.summary.errors,
      `saving ${name} laundered its error away:\n${saved}`,
    ).toBeGreaterThan(0);
  });
});

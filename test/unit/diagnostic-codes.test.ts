/**
 * The diagnostic-code catalogue and its documentation must not drift.
 *
 * `docs/DIAGNOSTIC-CODES.md` is what an AI agent reads to understand a `code`
 * it received. A code that exists but is undocumented is a dead end for the
 * agent; a documented code that no longer exists is a lie. Both fail here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DIAGNOSTIC_CODES, diagnosticCode, isKnownCode, renderHint } from '@text/index';

const DOC = readFileSync(resolve(process.cwd(), 'docs/DIAGNOSTIC-CODES.md'), 'utf8');
const documented = new Set([...DOC.matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]));

describe('diagnostic-code catalogue', () => {
  it('documents every code it defines', () => {
    const missing = DIAGNOSTIC_CODES.map((c) => c.code).filter((c) => !documented.has(c));
    expect(
      missing,
      `codes missing from docs/DIAGNOSTIC-CODES.md — run \`npm run codes\`:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('defines every code it documents', () => {
    const stale = [...documented].filter((c) => !isKnownCode(c));
    expect(stale, `documented codes that no longer exist:\n${stale.join('\n')}`).toEqual([]);
  });

  it('gives every code a family, a severity, a trigger and a hint', () => {
    for (const c of DIAGNOSTIC_CODES) {
      expect(c.code, `${c.code} must be <family>/<slug>`).toMatch(/^[a-z]+\/[a-z-]+$/);
      expect(['error', 'warning', 'info']).toContain(c.severity);
      expect(c.when.length, `${c.code} has no trigger description`).toBeGreaterThan(10);
      expect(c.hint.length, `${c.code} has no hint`).toBeGreaterThan(10);
    }
  });

  it('has no duplicate codes', () => {
    const seen = DIAGNOSTIC_CODES.map((c) => c.code);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('renders hints with substitutions and leaves no placeholders behind', () => {
    for (const c of DIAGNOSTIC_CODES) {
      const rendered = renderHint(c.code, { found: 'X', expected: [';'] });
      expect(rendered, `${c.code} rendered empty`).toBeTruthy();
      expect(rendered, `${c.code} leaked a placeholder`).not.toMatch(/\{(found|expected)\}/);
    }
  });

  it('renders a readable hint when there is nothing to substitute', () => {
    // An empty substitution must not leave doubled spaces or a dangling space
    // before punctuation — the agent reads this string directly.
    for (const c of DIAGNOSTIC_CODES) {
      const rendered = renderHint(c.code) as string;
      expect(rendered, `${c.code}: doubled space`).not.toMatch(/ {2}/);
      expect(rendered, `${c.code}: space before punctuation`).not.toMatch(/ [.,](\s|$)/);
    }
  });

  it('looks a code up and reports unknown ones as unknown', () => {
    expect(diagnosticCode('parse/mismatched-token')?.source).toBe('parser');
    expect(diagnosticCode('nope/not-a-code')).toBeUndefined();
    expect(isKnownCode('nope/not-a-code')).toBe(false);
  });
});

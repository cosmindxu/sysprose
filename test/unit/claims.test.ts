/**
 * Trademark & claim guard — the machine-checkable half of the project rules in
 * `CLAUDE.md` §"Naming, trademarks and claims".
 *
 * Sysprose implements a SysML v2–style notation and an OMG-API-shaped element
 * graph, but it has never been conformance-tested or certified by the OMG or
 * anyone else. Two habits follow, and this suite enforces both across the whole
 * repository so they cannot rot back in through a stray doc edit:
 *
 *   1. The product is never called conformant / compliant / certified.
 *   2. No OMG, SysML or KerML logo or brand asset is referenced.
 *
 * What is still allowed, deliberately:
 *   - NEGATED statements ("not certified", "never conformance-tested") — those
 *     are the disclaimers we want to keep.
 *   - The bare words "conformance"/"conformance-tested" (docs/CONFORMANCE.md,
 *     test/conformance/, "conformance scorecard") — naming the topic is not a
 *     claim to have passed it.
 *   - Descriptive statements about THIRD PARTIES ("the OMG pilot", "a conformant
 *     tool must preserve X") — those describe the spec or someone else's server.
 *
 * These rules stand only while the tool is uncertified. If Sysprose is ever
 * genuinely certified, this suite is what you delete — see CLAUDE.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

/** Directories never scanned: build output, deps, third-party text, tool reports. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'test-results',
  'playwright-report',
  'release',
  '.vite',
]);

/**
 * Files exempt by path, with the reason.
 * - `src/library/std/**` — EPL-2.0 licence + notice text we may not edit.
 * - the two survey docs — they describe OTHER tools and the standard itself,
 *   where "SysON leads OMG/SysML v2 compliance" is a fact about someone else.
 * - this file, and `CLAUDE.md` — the rule itself has to quote the banned forms
 *   verbatim in order to define them.
 */
const SKIP_FILES = (rel: string): boolean =>
  rel.startsWith(`src${sep}library${sep}std${sep}`) ||
  rel === join('docs', '01-state-of-the-art.md') ||
  rel === join('docs', '02-omg-standard-reference.md') ||
  // The verification plan quotes every banned form verbatim in order to ban it:
  // its MUST-NEVER list IS the list of sentences this guard exists to catch.
  rel === join('docs', '04-formal-verification-plan.md') ||
  rel === join('test', 'unit', 'claims.test.ts') ||
  rel === 'CLAUDE.md' ||
  rel === 'package-lock.json';

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|html|css|svg|webmanifest|yml|yaml|sh|langium)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (TEXT_EXT.test(name) || name === 'Dockerfile' || name === 'LICENSE' || name === 'NOTICE') {
      const rel = relative(ROOT, abs);
      if (!SKIP_FILES(rel)) out.push(rel);
    }
  }
  return out;
}

const FILES = walk(ROOT);

interface Hit {
  file: string;
  line: number;
  text: string;
}

const NEGATION = /\b(not|never|no|non|without|isn't|aren't|nor|neither)\b/i;

/**
 * Is this match defused by a negation? Either just before it ("we are NOT
 * conformant") or inside the matched span itself ("it is *not* a certified …",
 * where the match starts at "it is" and swallows the negation).
 */
function negated(before: string, matched: string): boolean {
  return new RegExp(`${NEGATION.source}[\\s\\S]{0,40}$`, 'i').test(before) || NEGATION.test(matched);
}

/** Scan every file for `pattern`, returning un-negated hits. */
function scan(pattern: RegExp, allow: RegExp[] = []): Hit[] {
  const hits: Hit[] = [];
  for (const file of FILES) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const lines = src.split('\n');
    lines.forEach((text, i) => {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        // Look back across the previous line too — claims wrap.
        const before = (lines[i - 1] ?? '') + ' ' + text.slice(0, m.index);
        if (negated(before, m[0])) continue;
        if (allow.some((a) => a.test(text) || a.test((lines[i - 1] ?? '') + ' ' + text))) continue;
        hits.push({ file, line: i + 1, text: text.trim().slice(0, 160) });
      }
    });
  }
  return hits;
}

const show = (hits: Hit[]): string =>
  hits.map((h) => `\n  ${h.file}:${h.line}  ${h.text}`).join('');

describe('the product is never called conformant, compliant or certified', () => {
  it('has no "<standard>-conformant" / "fully compliant" style claim', () => {
    // "OMG-conformant", "spec conformant", "SysML v2 compliant", "fully conformant",
    // "100 % conformant", "standard-compliant", …
    const hits = scan(
      /\b(omg|sysml(?:\s*v?2)?|kerml|spec(?:ification)?|standard|fully|100\s*%)[-\s]*(conformant|compliant)\b/i,
      [
        // A statement about what the SPEC requires of any tool, not about ours.
        /\bconformant (tool|server|implementation|pilot)s? (must|serves|would|may)\b/i,
        /\bto a conformant\b/i,
      ],
    );
    expect(hits, `un-negated conformance claim:${show(hits)}`).toEqual([]);
  });

  it('never says the tool itself is conformant, compliant or certified', () => {
    const hits = scan(
      /\b(sysprose|this tool|the tool|the modeler|our (own )?(server|implementation|tool)|we|it)\b[^.\n]{0,60}\b(is|are|being|remains?)\b[^.\n]{0,25}\b(conformant|compliant|certified)\b/i,
    );
    expect(hits, `first-person conformance claim:${show(hits)}`).toEqual([]);
  });

  it('never claims certification anywhere', () => {
    const hits = scan(/\bcertifi(ed|cation)\b/i, [
      // Naming the ABSENCE of certification is the disclaimer we want.
      /self-assessment, not certification/i,
      /candidate/i,
    ]);
    expect(hits, `certification claim:${show(hits)}`).toEqual([]);
  });
});

describe('no OMG / SysML / KerML brand assets are referenced', () => {
  it('references no standard-body logo or brand image', () => {
    const hits = scan(/\b(omg|sysml|kerml)[-_\s]?(logo|logotype|wordmark|brandmark|trademark[-_]?asset)\b/i);
    expect(hits, `brand asset reference:${show(hits)}`).toEqual([]);
  });

  it('embeds no image fetched from a standard body', () => {
    const hits = scan(/(src|href)\s*=\s*["'][^"']*\b(omg\.org|sysml\.org|omgsysml\.org)\b[^"']*\.(png|jpe?g|svg|gif|webp)/i);
    expect(hits, `remote brand image:${show(hits)}`).toEqual([]);
  });
});

describe('the disclaimers that make the above honest are present', () => {
  it('README carries the candidate-status + trademark + non-affiliation statement', () => {
    // Collapse wrapping — these sentences span source lines.
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
    expect(readme).toMatch(/candidate implementation/i);
    expect(readme).toMatch(/registered trademark of the Object Management Group/i);
    expect(readme).toMatch(/not affiliated with, sponsored by, or endorsed by/i);
  });

  it('the conformance scorecard opens by saying it is a self-assessment', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'CONFORMANCE.md'), 'utf8').replace(/\s+/g, ' ');
    expect(doc.slice(0, 1200)).toMatch(/self-assessment, not certification/i);
  });
});

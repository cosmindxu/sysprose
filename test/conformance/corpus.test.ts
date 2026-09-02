/**
 * OPTIONAL corpus conformance: parse a handful of REAL SysML v2 normative
 * library files with {@link parseModel} and assert they parse cleanly into a
 * non-empty, dangling-free model.
 *
 * The corpus lives OUTSIDE the repository (a local checkout of the OMG
 * `sysml.library`) and is READ ONLY AS TEST INPUT — never copied or committed
 * (see the project LICENSING rules). When the corpus directory is absent, this
 * suite skips gracefully rather than failing, so it is safe on machines without
 * the checkout.
 *
 * Default (jsdom) vitest environment: no HTTP, so no `// @vitest-environment
 * node` pragma is needed.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Model } from '@core/index';
import { parseModel } from '@text/index';

/**
 * Root of the (uncommitted) real corpus checkout. Override with
 * `SYSML_CORPUS_ROOT`; defaults to `~/.stdlib-src/sysml.library`.
 */
const CORPUS_ROOT =
  process.env.SYSML_CORPUS_ROOT ?? path.join(os.homedir(), '.stdlib-src', 'sysml.library');

/**
 * Files known to lie within our textual parser's supported grammar subset
 * (verified to parse with 0 errors). Relative to {@link CORPUS_ROOT}. We assert
 * on a fixed set for determinism rather than crawling the whole tree.
 */
const CORPUS_FILES = [
  'Systems Library/Requirements.sysml',
  'Systems Library/Items.sysml',
  'Systems Library/Actions.sysml',
  'Domain Libraries/Quantities and Units/ISQBase.sysml',
  'Domain Libraries/Quantities and Units/SI.sysml',
];

/** Endpoint references pointing at ids absent from the model. */
function danglingEndpoints(m: Model): string[] {
  const ids = new Set(m.all().map((el) => el.id));
  const bad: string[] = [];
  for (const el of m.all()) {
    for (const s of el.source ?? []) if (!ids.has(s)) bad.push(`${el.eClass}#${el.id} src ${s}`);
    for (const t of el.target ?? []) if (!ids.has(t)) bad.push(`${el.eClass}#${el.id} tgt ${t}`);
  }
  return bad;
}

const corpusPresent = fs.existsSync(CORPUS_ROOT);

describe('conformance — real OMG library corpus (read-only, uncommitted)', () => {
  // Document availability; individual tests self-skip when absent.
  if (!corpusPresent) {
    it(`corpus directory ${CORPUS_ROOT} not present — corpus tests skipped`, () => {});
    return;
  }

  const available = CORPUS_FILES.filter((rel) => fs.existsSync(path.join(CORPUS_ROOT, rel)));

  it('at least one known corpus file is available', () => {
    expect(available.length).toBeGreaterThan(0);
  });

  for (const rel of available) {
    describe(rel, () => {
      const text = fs.readFileSync(path.join(CORPUS_ROOT, rel), 'utf8');
      const { model, diagnostics } = parseModel(text);
      const errors = diagnostics.filter((d) => d.severity === 'error');

      it('parses with 0 errors', () => {
        expect(errors, JSON.stringify(errors.slice(0, 5))).toEqual([]);
      });

      it('produces a non-empty model', () => {
        expect(model.size).toBeGreaterThan(0);
      });

      it('is dangling-free (all endpoints resolve in-model)', () => {
        expect(danglingEndpoints(model)).toEqual([]);
      });
    });
  }
});

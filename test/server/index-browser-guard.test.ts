// @vitest-environment node
/**
 * Guard: the browser bundle must never pull in `express` or any server code.
 *
 * The browser app is serverless. `express` (and everything under `src/server`)
 * is a Node-only concern; if any module in the browser import graph referenced
 * it, `vite build` would try to bundle `express` into the client. Rather than
 * walk the import graph, we assert the invariant statically across the whole
 * `src` tree: **no file outside `src/server` may import `express` or reach into
 * `src/server`.** `src/main.tsx` and everything under `src/ui` are covered by
 * this because they live outside `src/server`.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const SERVER_DIR = join(SRC, 'server');

/** Recursively collect .ts/.tsx files under `dir`. */
function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Extract the module specifiers of static/dynamic imports and re-exports. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bimport\b[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\b[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

function reachesServer(spec: string): boolean {
  return (
    spec === 'express' ||
    spec.startsWith('express/') ||
    spec.startsWith('@server') ||
    /(^|\/)server(\/|$)/.test(spec)
  );
}

describe('browser bundle stays free of express/server code', () => {
  const files = collect(SRC).filter((f) => !f.startsWith(SERVER_DIR));

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no file outside src/server imports express or src/server', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        if (reachesServer(spec)) offenders.push(`${relative(SRC, file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/main.tsx and src/ui/* specifically do not import express/server', () => {
    const browserFiles = files.filter(
      (f) => f === join(SRC, 'main.tsx') || f.startsWith(join(SRC, 'ui')),
    );
    expect(browserFiles.length).toBeGreaterThan(0);
    for (const file of browserFiles) {
      const specs = importSpecifiers(readFileSync(file, 'utf8'));
      expect(specs.some(reachesServer), `${relative(SRC, file)} must not reach server`).toBe(false);
    }
  });
});

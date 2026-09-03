/**
 * Grammar-coverage harness for the Langium SysML v2 / KerML textual grammar.
 *
 * Parses EVERY `.kerml` / `.sysml` file under the OMG SysML-v2-Release standard
 * library with our own Langium services (src/text/langium) and reports, per
 * file and overall, the PARSE-SUCCESS rate = fraction of files that tokenize +
 * parse with ZERO lexer/parser errors.
 *
 * The standard library (EPL-2.0) is used ONLY as a PARSE CORPUS to MEASURE
 * grammar coverage — it is never copied into the repo or committed. If the
 * corpus is absent it is (shallow) cloned from the public release repo.
 *
 * `--all` widens the corpus from the normative `sysml.library` to every
 * `.kerml` / `.sysml` under the release checkout (`sysml/src` training and
 * validation models, `kerml/src`) plus this repo's `examples/`. That wider set
 * exercises constructs the library itself never spells (a unit literal inside a
 * constraint body, for one), so it is the honest measure of a grammar change
 * whose target is authored text rather than the library.
 *
 * Usage:  npx tsx scripts/grammar-coverage.ts [--verbose] [--errors] [--all]
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { parseDocument } from '../src/text/langium/module';

// Override with SYSML_STDLIB_ROOT; defaults to ~/.stdlib-src (a local checkout of RELEASE_REPO).
const STDLIB_ROOT = process.env.SYSML_STDLIB_ROOT ?? join(homedir(), '.stdlib-src');
const CORPUS_DIR = join(STDLIB_ROOT, 'sysml.library');
const RELEASE_REPO = 'https://github.com/Systems-Modeling/SysML-v2-Release';

const VERBOSE = process.argv.includes('--verbose');
const SHOW_ERRORS = process.argv.includes('--errors');
const ALL = process.argv.includes('--all');

/** Corpus roots for `--all`: the release tree's model sources plus this repo's examples. */
const ALL_ROOTS = [
  CORPUS_DIR,
  join(STDLIB_ROOT, 'sysml', 'src'),
  join(STDLIB_ROOT, 'kerml', 'src'),
  join(process.cwd(), 'examples'),
];

function ensureCorpus(): void {
  if (existsSync(CORPUS_DIR)) return;
   
  console.error(`Corpus missing at ${CORPUS_DIR}; cloning ${RELEASE_REPO} …`);
  execSync(`git clone --depth 1 ${RELEASE_REPO} "${STDLIB_ROOT}"`, { stdio: 'inherit' });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.kerml') || p.endsWith('.sysml')) out.push(p);
  }
  return out;
}

interface FileResult {
  file: string;
  ok: boolean;
  lexerErrors: number;
  parserErrors: number;
  firstError?: string;
}

function parseFile(path: string): FileResult {
  const text = readFileSync(path, 'utf8');
  const { lexerErrors, parserErrors } = parseDocument(text);
  const ok = lexerErrors.length === 0 && parserErrors.length === 0;
  const firstError =
    lexerErrors[0]?.message ??
    (parserErrors[0]
      ? `${parserErrors[0].message} @ ${parserErrors[0].token?.startLine}:${parserErrors[0].token?.startColumn}`
      : undefined);
  return { file: path, ok, lexerErrors: lexerErrors.length, parserErrors: parserErrors.length, firstError };
}

function main(): void {
  ensureCorpus();
  const roots = ALL ? ALL_ROOTS.filter((r) => existsSync(r)) : [CORPUS_DIR];
  const files = roots.flatMap((r) => walk(r)).sort();
  if (files.length === 0) {
     
    console.error('No .kerml/.sysml files found in corpus.');
    process.exit(1);
  }

  const results = files.map(parseFile);
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  const rel = (p: string) => {
    const root = roots.find((r) => p.startsWith(r + '/')) ?? CORPUS_DIR;
    return p.slice(root.length + 1);
  };

  if (VERBOSE) {
    for (const r of results) {
       
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${rel(r.file)}`);
    }
     
    console.log('');
  }

  if (failed.length && (VERBOSE || SHOW_ERRORS)) {
     
    console.log('── failing files (first error) ─────────────────────────────');
    for (const r of failed) {
       
      console.log(`  ${rel(r.file)}  [lex ${r.lexerErrors} / parse ${r.parserErrors}]  ${r.firstError ?? ''}`);
    }
     
    console.log('');
  }

  const pct = ((passed.length / results.length) * 100).toFixed(1);
   
  console.log('── grammar coverage (parse-success = 0 errors) ─────────────');
   
  console.log(`  files:   ${results.length}`);
   
  console.log(`  passed:  ${passed.length}`);
   
  console.log(`  failed:  ${failed.length}`);
   
  console.log(`  SUCCESS: ${pct}%`);
}

main();

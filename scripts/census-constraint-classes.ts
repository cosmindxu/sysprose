#!/usr/bin/env tsx
/**
 * Constraint-class census: sort everything the SMT lane sends to z3, or refuses to, into the classes the
 * constraint-classes plan proposes, and count it over the published examples, the verdict-corpus models,
 * the agent-authoring inputs and the v9 model. An INVENTORY: it prints nothing a Sysprose command prints and
 * moves no verdict. The logic is in `scripts/lib/class-census.ts`.
 *
 * Run: npm run census:classes -- [options] [FILE...]
 *
 *   --verdicts           run `verify --engine smt` (z3) on every model and join its verdicts to the rows
 *   --probes             read the differential test's PROBES table statically and count it by class
 *   --script-hashes      print one `sha256` line per row script and per proof script instead of the census
 *   --corpus manifest.tsv  read the models of a gate manifest (first column = a file in `corpus/` beside it)
 *   --shard K/N          read only every N-th model, from the K-th (0-based); pair with --json and --merge
 *   --merge              the FILEs are `--json` censuses: add them and print the result
 *   --time               print the wall time of each phase to stderr
 *   --json               print the census as JSON
 *   --check              run the census twice in separate processes and test its own invariants
 *
 * With FILEs, only those are read (corpus `files`). Exit 0 on success, 1 when a `--check` invariant fails,
 * 2 on a usage error or an absent solver.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelText } from '../src/text/load';
import { verifyModel } from '../src/api/verification';
import { loadZ3 } from '../src/semantics/smt/z3-bridge';
import { flagGiven, flagValue, isArgError, parseArgs, type FlagSpec } from './lib/args';
import { runMain } from './lib/exit';
import { isMainModule } from './lib/is-main';
import {
  censusModel,
  censusProbe,
  extractProbes,
  invariantsHold,
  mergeCensus,
  newCensus,
  renderCensus,
  type Census,
  type ProbeCensus,
} from './lib/class-census';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_SOURCE = join(ROOT, 'test/integration/verification.differential.test.ts');

const FLAGS: readonly FlagSpec[] = [
  { name: 'verdicts', kind: 'boolean', doc: 'Run `verify --engine smt` (z3) and join its verdicts to the rows.' },
  { name: 'probes', kind: 'boolean', doc: 'Count the differential test’s PROBES table by class (read statically).' },
  { name: 'script-hashes', kind: 'boolean', doc: 'Print a hash line per row script and per proof script.' },
  { name: 'corpus', kind: 'value', metavar: 'MANIFEST', doc: 'Read the models of a gate manifest.tsv instead of the default corpora (`none`: no models, for --probes alone).' },
  { name: 'shard', kind: 'value', metavar: 'K/N', doc: 'Read every N-th model from the K-th.' },
  { name: 'merge', kind: 'boolean', doc: 'The FILEs are --json censuses to add.' },
  { name: 'time', kind: 'boolean', doc: 'Print the wall time of each phase to stderr.' },
  { name: 'json', kind: 'boolean', doc: 'Print the census as JSON.' },
  { name: 'check', kind: 'boolean', doc: 'Run twice in two processes and test the invariants.' },
];

interface Item {
  corpus: string;
  name: string;
  path: string;
}

const listDir = (dir: string, ext: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : []);

/** The models of the default corpora, or of a manifest, or the files given. */
export function corpusItems(manifest: string | undefined, files: readonly string[]): Item[] {
  if (files.length > 0) return files.map((f) => ({ corpus: 'files', name: relative(ROOT, resolve(f)), path: resolve(f) }));
  if (manifest === 'none') return [];
  if (manifest !== undefined) {
    const dir = join(dirname(resolve(manifest)), 'corpus');
    return readFileSync(manifest, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.split('\t')[0]!)
      .sort()
      .map((id) => ({ corpus: 'gate', name: id, path: join(dir, id) }));
  }
  const at = (corpus: string, dir: string, ext: string): Item[] =>
    listDir(join(ROOT, dir), ext).map((f) => ({ corpus, name: `${dir}/${f}`, path: join(ROOT, dir, f) }));
  const agent = readdirSync(join(ROOT, 'test/fixtures/agent-authoring'))
    .sort()
    .filter((d) => existsSync(join(ROOT, 'test/fixtures/agent-authoring', d, 'input.sysml')))
    .map((d) => ({ corpus: 'agent', name: `test/fixtures/agent-authoring/${d}/input.sysml`, path: join(ROOT, 'test/fixtures/agent-authoring', d, 'input.sysml') }));
  return [
    ...at('examples', 'examples', '.sysml'),
    ...at('l8', 'test/fixtures/verification/models', '.sysml'),
    ...agent,
    { corpus: 'v9', name: 'test/fixtures/drone-swarm-v9.sysml.txt', path: join(ROOT, 'test/fixtures/drone-swarm-v9.sysml.txt') },
  ];
}

export interface CollectOptions {
  verdicts: boolean;
  probes: boolean;
  shard?: { k: number; n: number };
  time?: boolean;
}

/** Read every item, classify it, and add it up. Also returns the script-hash lines. */
export async function collect(items: readonly Item[], opts: CollectOptions): Promise<{ census: Census; hashes: string[] }> {
  const census = newCensus(opts.verdicts);
  const hashes: string[] = [];
  let loadMs = 0;
  let classMs = 0;
  let z3Ms = 0;
  for (const [i, item] of items.entries()) {
    if (opts.shard && i % opts.shard.n !== opts.shard.k) continue;
    const m = (census.models[item.corpus] ??= { read: 0, loaded: 0, failed: 0 });
    m.read += 1;
    const t1 = Date.now();
    const text = readFileSync(item.path, 'utf8');
    const { model } = await loadModelText(text, { library: 'full', fileName: basename(item.path).replace(/\.txt$/, '') });
    loadMs += Date.now() - t1;
    if (!model) {
      m.failed += 1;
      continue;
    }
    m.loaded += 1;
    let verdicts;
    if (opts.verdicts) {
      const t2 = Date.now();
      try {
        verdicts = (await verifyModel(model, { engine: 'smt' })).results;
      } catch (e) {
        (census.notes['verify threw'] ??= []).push(`${item.name}: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`);
        census.checks['verify threw'] = (census.checks['verify threw'] ?? 0) + 1;
      }
      z3Ms += Date.now() - t2;
    }
    const t3 = Date.now();
    hashes.push(...censusModel(census, { corpus: item.corpus, name: item.name, model, ...(verdicts ? { verdicts } : {}) }).script);
    classMs += Date.now() - t3;
  }
  if (opts.time) process.stderr.write(`time load ${loadMs} ms, classify ${classMs} ms, z3 ${z3Ms} ms\n`);
  if (opts.probes) {
    const t4 = Date.now();
    const { entries, interpolated, spreads, total } = extractProbes(readFileSync(PROBE_SOURCE, 'utf8'));
    const p: ProbeCensus = { total, extracted: entries.length, interpolated, spreads: spreads.length, pinnedRows: 0, unmatched: 0, byCell: {}, failed: [] };
    for (const [i, e] of entries.entries()) {
      if (opts.shard && i % opts.shard.n !== opts.shard.k) continue;
      const pm = (census.models.probes ??= { read: 0, loaded: 0, failed: 0 });
      pm.read += 1;
      const { model } = await loadModelText(e.text, { library: 'full', fileName: `${e.name}.sysml` });
      if (!model) {
        p.failed.push(e.name);
        pm.failed += 1;
        continue;
      }
      pm.loaded += 1;
      censusProbe(p, e, model);
      let verdicts;
      if (opts.verdicts) {
        try {
          verdicts = (await verifyModel(model, { engine: 'smt' })).results;
        } catch (err) {
          (census.notes['verify threw'] ??= []).push(`probe:${e.name}: ${String(err instanceof Error ? err.message : err).split('\n')[0]}`);
          census.checks['verify threw'] = (census.checks['verify threw'] ?? 0) + 1;
        }
      }
      hashes.push(...censusModel(census, { corpus: 'probes', name: `probe:${e.name}`, model, ...(verdicts ? { verdicts } : {}) }).script);
    }
    census.probes = p;
    if (opts.time) process.stderr.write(`time probes ${Date.now() - t4} ms\n`);
  }
  return { census, hashes };
}

/** JSON with every key sorted, so equal censuses are equal bytes. */
export function canonical(c: Census): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(c), null, 1) + '\n';
}

async function check(argv: readonly string[]): Promise<number> {
  const run = (): string => {
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, '--json', ...argv], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`census run failed: ${r.stderr.slice(0, 400)}`);
    return r.stdout;
  };
  const a = run();
  const b = run();
  const census = JSON.parse(a) as Census;
  const git = spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' });
  const lines: string[] = [];
  const results: Array<[boolean, string]> = [
    [a === b, 'two processes give byte-equal output'],
    [invariantsHold(census), 'every row has one shape or fence and (but for a no-clause row) one reading; per-model totals equal obligationsOf; each shape maps to one logic; the footprint equals encodedFootprint'],
    [git.status === 0 && git.stdout.trim() === '', 'no uncommitted change under src/'],
  ];
  for (const [ok, what] of results) lines.push(`${ok ? 'ok    ' : 'FAILS '} ${what}`);
  process.stdout.write(lines.join('\n') + '\n');
  return results.every(([ok]) => ok) ? 0 : 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS);
  if (isArgError(args)) {
    process.stderr.write(`census-constraint-classes: ${args.error}\n`);
    return 2;
  }
  const given = (n: string): boolean => flagGiven(args, n);
  if (given('check')) {
    const rest = process.argv.slice(2).filter((x) => x !== '--check');
    return check(rest);
  }
  if (given('merge')) {
    const merged = args.positionals.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Census).reduce((a, b) => mergeCensus(a, b));
    process.stdout.write(given('json') ? canonical(merged) : renderCensus(merged));
    return 0;
  }
  const shardText = flagValue(args, 'shard');
  const shard = shardText === undefined ? undefined : { k: Number(shardText.split('/')[0]), n: Number(shardText.split('/')[1]) };
  if (shard && !(Number.isInteger(shard.k) && Number.isInteger(shard.n) && shard.n > 0 && shard.k >= 0 && shard.k < shard.n)) {
    process.stderr.write('census-constraint-classes: --shard wants K/N with 0 <= K < N\n');
    return 2;
  }
  if (given('verdicts')) {
    const z3 = await loadZ3();
    if (z3.absent) {
      process.stderr.write(`census-constraint-classes: --verdicts needs the solver: ${z3.reason}\n`);
      return 2;
    }
  }
  const items = corpusItems(flagValue(args, 'corpus'), args.positionals);
  const { census, hashes } = await collect(items, {
    verdicts: given('verdicts'),
    probes: given('probes'),
    ...(shard ? { shard } : {}),
    time: given('time'),
  });
  if (given('script-hashes')) {
    process.stdout.write([...hashes].sort().join('\n') + '\n');
    return 0;
  }
  process.stdout.write(given('json') ? canonical(census) : renderCensus(census));
  return 0;
}

if (isMainModule(import.meta.url)) runMain('census-constraint-classes', main);

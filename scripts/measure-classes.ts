#!/usr/bin/env tsx
/**
 * Measure the facts the constraint-class rubric reads and write them to `src/semantics/smt/class-facts.ts`
 * (a generated file: the first line says so). Nothing here runs a solver: the facts are counted from what the
 * repository holds (the corpus models, the L8 goldens, the differential table, the register's own test
 * pointers) and the open defects of `docs/constraint-class-defects.json`. The z3 release is read from
 * `node_modules`, not from a loaded solver.
 *
 * Run: npm run measure:classes -- [options]
 *
 *   --check     recount and compare to the committed file: exit 1 if the file is not what a recount writes
 *   --stdout    print the module instead of writing it
 *   --shard K/N read only every N-th probe of the differential table (for a partial look; never written)
 *   --time      print the wall time of each phase to stderr
 *
 * Exit 0 on success, 1 when `--check` finds a difference, 2 on a usage error.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagGiven, flagValue, isArgError, parseArgs, type FlagSpec } from './lib/args';
import { runMain } from './lib/exit';
import { isMainModule } from './lib/is-main';
import { computeFacts, renderFactsModule } from './lib/class-facts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'src/semantics/smt/class-facts.ts';

const FLAGS: readonly FlagSpec[] = [
  { name: 'check', kind: 'boolean', doc: 'Recount and compare to the committed file; exit 1 on a difference.' },
  { name: 'stdout', kind: 'boolean', doc: 'Print the module instead of writing it.' },
  { name: 'shard', kind: 'value', metavar: 'K/N', doc: 'Read every N-th probe of the table from the K-th (a partial look; never written).' },
  { name: 'time', kind: 'boolean', doc: 'Print the wall time of each phase to stderr.' },
];

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS);
  if (isArgError(args)) {
    process.stderr.write(`measure-classes: ${args.error}\n`);
    return 2;
  }
  const shardText = flagValue(args, 'shard');
  const shard = shardText === undefined ? undefined : { k: Number(shardText.split('/')[0]), n: Number(shardText.split('/')[1]) };
  if (shard && !(Number.isInteger(shard.k) && Number.isInteger(shard.n) && shard.n > 0 && shard.k >= 0 && shard.k < shard.n)) {
    process.stderr.write('measure-classes: --shard wants K/N with 0 <= K < N\n');
    return 2;
  }
  const t0 = Date.now();
  const live = await computeFacts({ root: ROOT, full: true, table: true, ...(shard ? { shard } : {}) });
  if (flagGiven(args, 'time')) process.stderr.write(`time measure ${Date.now() - t0} ms\n`);
  for (const n of [...live.notes, ...live.unmatchedGoldens]) process.stderr.write(`measure-classes: ${n}\n`);
  const text = renderFactsModule(live.facts);
  if (flagGiven(args, 'stdout')) {
    process.stdout.write(text);
    return 0;
  }
  if (shard) {
    process.stderr.write('measure-classes: a --shard measure is partial and is not written\n');
    return 2;
  }
  const path = join(ROOT, TARGET);
  if (flagGiven(args, 'check')) {
    const same = readFileSync(path, 'utf8') === text;
    process.stdout.write(same ? `ok     ${TARGET} is what a recount writes\n` : `FAILS  ${TARGET} is not what a recount writes: run npm run measure:classes\n`);
    return same ? 0 : 1;
  }
  writeFileSync(path, text);
  process.stdout.write(`wrote ${TARGET}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) runMain('measure-classes', main);

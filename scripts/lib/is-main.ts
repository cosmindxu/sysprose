/**
 * "Was this file RUN, or was it imported?" — one answer, for every script here
 * that has to be both a program and a module.
 *
 * WHY IT IS SHARED, AND WHY IT COMPARES REAL PATHS. Three scripts carry this
 * guard: `gen-cli-reference.ts` (imported by the drift test, which must not let
 * it rewrite the document it is comparing against), `agent-repair-bench.ts`
 * (imported by its own suite, which must not spend a `claude` call as a side
 * effect) and `sysprose.ts` (imported by the L7 campaign suite, which must not
 * run the command with the test runner's argv). All three wrote it the same
 * way — `resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))`
 * — and all three were wrong in the same way: the ESM loader hands back a
 * module URL with every symlink already resolved, while `process.argv[1]` is
 * the path as it was TYPED. So an invocation through a symlinked directory
 *
 *   ln -s /work/sysprose /tmp/link
 *   npx tsx /tmp/link/scripts/sysprose.ts stats model.sysml
 *
 * compared `/tmp/link/scripts/sysprose.ts` against `/work/sysprose/scripts/…`,
 * decided the file had been imported, ran nothing, printed nothing and exited
 * 0 — a silent pass on a path whose exit contract is 2, which is the one
 * outcome `scripts/lib/exit.ts` says must be impossible. Resolving the SYMLINK
 * on both sides is what makes the two comparable, so that is what this does.
 *
 * `realpathSync` throws when the path does not exist — an embedder that sets no
 * `argv[1]`, a deleted script mid-run — and a guard is not the place to fail a
 * run, so a throw falls back to plain resolution: no worse than what the three
 * scripts did before, and only on a path where nothing can be realpathed.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A path with its symlinks resolved, or merely absolute if that is not possible. */
function realOrAbsolute(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

/**
 * True when the module identified by `metaUrl` is the file node was told to
 * run. Call it as `isMainModule(import.meta.url)`.
 */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return realOrAbsolute(entry) === realOrAbsolute(fileURLToPath(metaUrl));
}

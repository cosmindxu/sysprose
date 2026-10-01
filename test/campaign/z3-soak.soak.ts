// @vitest-environment node
/**
 * Defect D5's cause, soaked against the real solver.
 *
 * `z3-solver` frees every Solver, Model and term from a `FinalizationRegistry`
 * whose callbacks run on the main thread, and the shipped libz3 is built
 * single-threaded: a free that lands while a check runs on its worker thread
 * corrupts the heap the check is using, and the module dies a few hundred
 * checks later (`memory access out of bounds`, `corrupted its heap`, the
 * `hashtable.h:445` assertion CI saw). The bridge holds those callbacks back
 * while a check is in flight and runs them once it has settled; the death
 * suite pins that contract on a fake. This drives the real module through
 * ~200 checks and asks three things of it: nothing died, the deferral was
 * actually exercised (callbacks DID arrive under a check and were held), and
 * z3's own heap stayed bounded — a bridge that stopped freeing passes the
 * first two and climbs past 180 MB here. (That the held callbacks run once
 * the check settles is the death suite's case; on this small model the terms
 * they free weigh half a megabyte, so the heap cannot tell.)
 *
 * What this does NOT show is that the fix holds: three runs of it with the
 * deferral switched off were clean too, failing only the "exercised"
 * assertion. That evidence is the multi-process reproduction under load.
 *
 * COLLECTIONS IN BURSTS, NOT ON A TIMER. A forced `gc()` every few
 * milliseconds frees a handful of objects at a time, and an investigation run
 * shaped like that never crashed even with no guard at all — so it would prove
 * nothing. One `gc()` every ~15 checks, issued just before a report starts,
 * leaves a batch of callbacks to arrive while that report's first check runs,
 * which is the shape that killed the unguarded processes.
 *
 * OPT-IN, AND NOT A SKIP. Run it as `npm run soak:z3`: `SYSPROSE_SOAK=1` is
 * what makes `vitest.config.ts` collect a `*.soak.ts` at all, and
 * `NODE_OPTIONS=--expose-gc` reaches vitest's forked workers, so the case can
 * call `gc()` itself. A default run never sees this file — a skipped case
 * there would leave no green run with nothing skipped for
 * `docs/TEST-SUMMARY.md` to record, and the documents quoting that run are
 * held to it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boundsReport, verifyModel } from '@api/index';
import {
  loadZ3,
  resetZ3Cache,
  z3DeathCount,
  z3DeferredFinalizerCount,
  z3Internals,
} from '@semantics/smt/z3-bridge';
import { loadModelText } from '@text/load';

/** The bounds checks to run, counted exactly; each round adds a verify run on top. */
const CHECKS = 200;
/** Checks between two forced collections — a burst, not a drizzle. */
const GC_EVERY = 15;
/**
 * z3's own allocation figure must stay under this, read after every round.
 *
 * Set from THIS fixture's measurements, not from a larger model's: here the
 * peak is 8.6 MB with frees running, and 184.6 MB over the same 204 checks
 * with both the held callbacks and the explicit releases switched off — so the
 * 300 MB a larger model would suggest could never trip on the leak it guards
 * against. Seven times the healthy peak, a third of the leak.
 */
const HEAP_LIMIT_MB = 64;
/** The nonlinear fixture the campaign's bounds block uses. */
const UAV = 'test/fixtures/verification/models/bounds-uav.sysml';

/** z3's estimate of what it has allocated, in MB, read between checks — never under one. */
function z3HeapMb(): number {
  const internals = z3Internals() as
    | { z3: { Z3?: { get_estimated_alloc_size?: () => bigint | number } } }
    | undefined;
  const Z3 = internals?.z3.Z3;
  if (typeof Z3?.get_estimated_alloc_size !== 'function') {
    throw new Error('no loaded module exposes Z3.get_estimated_alloc_size(); the heap bound cannot be read');
  }
  return Number(Z3.get_estimated_alloc_size()) / 2 ** 20;
}

describe('D5 soak — no finalizer frees under a running check', () => {
  it(
    'runs ~200 bounds checks and a verify per round over a nonlinear model, with GC in bursts',
    async () => {
      const gc = (globalThis as { gc?: () => void }).gc;
      if (typeof gc !== 'function') {
        throw new Error('the soak needs --expose-gc: run it as `npm run soak:z3`');
      }
      // A process-wide trap arrives here, never through a promise: the worker's
      // error is rethrown on the main thread, and an unguarded run dies of it.
      const traps: unknown[] = [];
      const onTrap = (err: unknown) => {
        traps.push(err);
      };
      process.on('uncaughtException', onTrap);
      try {
        // A fresh module, so every figure below is this soak's own.
        resetZ3Cache({ terminate: true });
        const load = await loadZ3();
        if (load.absent) throw new Error(`SYSPROSE_SOAK=1 asks for the real solver: ${load.reason}`);
        const deathsBefore = z3DeathCount();
        const deferredBefore = z3DeferredFinalizerCount();

        const source = readFileSync(resolve(process.cwd(), UAV), 'utf8');
        const { model } = await loadModelText(source, { fileName: UAV });
        if (!model) throw new Error(`${UAV} produced no model`);

        let checks = 0;
        let lastGc = 0;
        let collections = 0;
        let rounds = 0;
        let peakMb = z3HeapMb();
        let first: string | undefined;
        const started = Date.now();
        while (checks < CHECKS) {
          if (checks - lastGc >= GC_EVERY) {
            gc();
            collections += 1;
            lastGc = checks;
          }
          // Nonlinear: a division by a released feature, so νZ answers a bound
          // it cannot certify — the arithmetic the deaths were seen in.
          const nonlinear = await boundsReport(model, {
            measure: 'uav.endurance',
            sense: 'both',
            free: ['BoundsUav::BatteryPack::capacity'],
            sourceText: source,
          });
          const linear = await boundsReport(model, {
            measure: 'uav.mtow',
            sense: 'both',
            free: ['uav.payload'],
            sourceText: source,
          });
          const verified = await verifyModel(model, { sourceText: source });
          checks += nonlinear.checks + linear.checks;
          rounds += 1;
          peakMb = Math.max(peakMb, z3HeapMb());

          // Every round must answer as the first did: a heap the solver shares
          // with a stray free answers wrong before it answers nothing.
          const answers = JSON.stringify([
            nonlinear.bounds.map((b) => [b.sense, b.outcome, b.value]),
            linear.bounds.map((b) => [b.sense, b.outcome, b.value]),
            verified.exitCode,
            verified.results.map((r) => r.verdict),
          ]);
          first ??= answers;
          expect(answers, `round ${rounds} answered differently from round 1`).toBe(first);
        }

        const deferred = z3DeferredFinalizerCount() - deferredBefore;
        console.log(
          `[D5] soak: ${checks} bounds checks + ${rounds} verify runs in ${rounds} rounds, ` +
            `${collections} forced collections, ${deferred} finalizer callbacks held under a check, ` +
            `z3 heap peak ${peakMb.toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s`,
        );

        // The answers themselves, once: the nonlinear bound is never an optimum,
        // the linear one carries the payload range through to the total.
        expect(first).toContain('bound-without-optimality');
        expect(first).toContain('[["min","optimum",14.5],["max","optimum",18.5]]');

        expect(traps, 'a WASM trap reached the process').toEqual([]);
        expect(z3DeathCount(), 'a module died under the soak').toBe(deathsBefore);
        expect(deferred, 'no callback arrived under a check: the deferral was never exercised').toBeGreaterThan(0);
        expect(peakMb, 'z3’s heap grew past the bound: held frees are not being run').toBeLessThan(HEAP_LIMIT_MB);
      } finally {
        process.off('uncaughtException', onTrap);
      }
    },
    600_000,
  );
});

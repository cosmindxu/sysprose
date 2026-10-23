// @vitest-environment node
/**
 * Defect D5's cause, soaked against the real solver.
 *
 * `z3-solver` 5.2 freed every Solver, Model and term from a
 * `FinalizationRegistry` whose callbacks run on the main thread, and the
 * shipped libz3 is built single-threaded: a free that landed while a check ran
 * on its worker thread corrupted the heap the check was using, and the module
 * died a few hundred checks later (`memory access out of bounds`, `corrupted
 * its heap`, the `hashtable.h:445` assertion CI saw), or answered wrongly
 * first. 5.3.1 queues those frees (z3 PR #11001) and the bridge no longer
 * guards them; the death suite pins what the bridge still does on a fake. This
 * drives the real module through ~200 checks and asks three things of it:
 * nothing died, every round answered as the first did, and z3's own heap stayed
 * bounded — a bridge that stopped freeing passes the first two and climbs past
 * 180 MB here.
 *
 * COLLECTIONS IN BURSTS, NOT ON A TIMER. A forced `gc()` every few
 * milliseconds frees a handful of objects at a time, and a run shaped like
 * that never crashed even on the unfixed 5.2.0 — so it would prove nothing.
 * One `gc()` every ~15 checks, issued just before a report starts, leaves a
 * batch of callbacks to arrive while that report's first check runs, which is
 * the shape that killed the unguarded processes.
 *
 * THE LOAD CASE. Only a heavy model meets the race (the fixture below frees
 * ~50 objects a call; v9 ~300). `SYSPROSE_SOAK_MODEL=<file.sysml>` and
 * `SYSPROSE_SOAK_MEASURES=<qualified measure>,…` add a second case that runs
 * `SYSPROSE_SOAK_ITERATIONS` (default 25) iterations of a bounds report per
 * measure (plain and `freeAll`), a SMT verify and a `consistency
 * --with-values` on that model, a collection before each. It is skipped
 * without them.
 *
 * THE CONTROL, WHICH THIS FILE ALONE DOES NOT SHOW. Alone, on one quiet
 * process, even 5.2.0 passes this (it did, with every guard off, three times):
 * the race needs load. The evidence is this run beside others: five of these
 * (`SYSPROSE_SOAK_CHECKS=1000`, in five shells at once) with twelve busy loops
 * (`node -e 'for(;;){}'`) beside them, on 5.3.1, against the same on 5.2.0
 * (`npm install --no-save z3-solver@5.2.0`, which the bridge then refuses —
 * set the `async_cancel` check aside in a scratch copy to see the race).
 * Measured 2026-10-23 on the v9 model, 154 checks per iteration: 5.2.0 with the
 * bridge's old guards off, 5 of 5 processes failed within 8 iterations (three
 * module deaths at iteration 2, the others traps and changed answers, one an
 * out-of-memory abort); 5.3.1 with the same guards off, 5 x 25 iterations and
 * 1.2 million finalizer callbacks under checks per process, no trap, no death,
 * no changed answer. Re-run both when `z3-solver` moves.
 *
 * THE EXACT INVOCATION (repeat per process, five at once): `SYSPROSE_SOAK=1
 * NODE_OPTIONS=--expose-gc SYSPROSE_SOAK_CHECKS=1000 SYSPROSE_SOAK_ITERATIONS=25
 * SYSPROSE_SOAK_MODEL=test/fixtures/drone-swarm-v9.sysml.txt
 * SYSPROSE_SOAK_MEASURES=SurveillanceDroneSwarm::LA::areaUnderWatchFraction,SurveillanceDroneSwarm::PA::areaUnderWatchFraction,SurveillanceDroneSwarm::LA::coverageUnderMeshJammingFraction,SurveillanceDroneSwarm::PA::coverageLossAfterMemberLossFraction
 * npx vitest run test/campaign/z3-soak.soak.ts`, beside twelve `node -e
 * 'for(;;){}'` loops. A plain `npm run soak:z3` skips the load case.
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
import { boundsReport, consistencyReport, verifyModel } from '@api/index';
import {
  loadZ3,
  resetZ3Cache,
  z3DeathCount,
  z3Internals,
} from '@semantics/smt/z3-bridge';
import { loadModelText } from '@text/load';

/**
 * The bounds checks to run, counted exactly; each round adds a verify run on top.
 * `SYSPROSE_SOAK_CHECKS` raises it for a run beside other processes (see the
 * header), where 200 checks are too few to meet the race.
 */
const CHECKS = Number(process.env.SYSPROSE_SOAK_CHECKS) > 0 ? Number(process.env.SYSPROSE_SOAK_CHECKS) : 200;
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

        console.log(
          `[D5] soak: ${checks} bounds checks + ${rounds} verify runs in ${rounds} rounds, ` +
            `${collections} forced collections, ` +
            `z3 heap peak ${peakMb.toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s`,
        );

        // The answers themselves, once: the nonlinear bound is never an optimum,
        // the linear one carries the payload range through to the total.
        expect(first).toContain('bound-without-optimality');
        expect(first).toContain('[["min","optimum",14.5],["max","optimum",18.5]]');

        expect(traps, 'a WASM trap reached the process').toEqual([]);
        expect(z3DeathCount(), 'a module died under the soak').toBe(deathsBefore);
        expect(peakMb, 'z3’s heap grew past the bound: frees are not being run').toBeLessThan(HEAP_LIMIT_MB);
      } finally {
        process.off('uncaughtException', onTrap);
      }
    },
    600_000,
  );

  it.skipIf(!process.env.SYSPROSE_SOAK_MODEL)(
    'runs bounds, verify and consistency on a heavy model, a collection before each report',
    async () => {
      const gc = (globalThis as { gc?: () => void }).gc;
      if (typeof gc !== 'function') {
        throw new Error('the soak needs --expose-gc: run it as `npm run soak:z3`');
      }
      const file = resolve(process.cwd(), process.env.SYSPROSE_SOAK_MODEL ?? '');
      const measures = (process.env.SYSPROSE_SOAK_MEASURES ?? '').split(',').filter((m) => m !== '');
      if (measures.length === 0) throw new Error('SYSPROSE_SOAK_MEASURES names no measure to bound');
      const iterations = Number(process.env.SYSPROSE_SOAK_ITERATIONS) > 0 ? Number(process.env.SYSPROSE_SOAK_ITERATIONS) : 25;
      const traps: unknown[] = [];
      const onTrap = (err: unknown) => {
        traps.push(err);
      };
      process.on('uncaughtException', onTrap);
      try {
        resetZ3Cache({ terminate: true });
        const load = await loadZ3();
        if (load.absent) throw new Error(`SYSPROSE_SOAK=1 asks for the real solver: ${load.reason}`);
        const deathsBefore = z3DeathCount();
        const source = readFileSync(file, 'utf8');
        const { model } = await loadModelText(source, { fileName: file });
        if (!model) throw new Error(`${file} produced no model`);
        let first: string | undefined;
        for (let it = 1; it <= iterations; it += 1) {
          const got: unknown[] = [];
          for (const measure of measures) {
            for (const freeAll of [false, true]) {
              gc();
              const r = await boundsReport(model, { measure, sense: 'both', ...(freeAll ? { freeAll: true } : {}), sourceText: source });
              got.push(r.bounds.map((b) => [b.sense, b.outcome, b.value]));
            }
          }
          gc();
          const verified = await verifyModel(model, { engine: 'smt', sourceText: source });
          got.push([verified.exitCode, verified.results.map((x) => x.verdict)]);
          gc();
          const consistent = await consistencyReport(model, { withValues: true, allowInconclusive: false, sourceText: source });
          got.push(consistent.groups.map((g) => g.outcome));
          const answers = JSON.stringify(got);
          first ??= answers;
          expect(answers, `iteration ${it} answered differently from iteration 1`).toBe(first);
        }
        expect(traps, 'a WASM trap reached the process').toEqual([]);
        expect(z3DeathCount(), 'a module died under the soak').toBe(deathsBefore);
      } finally {
        process.off('uncaughtException', onTrap);
      }
    },
    3_000_000,
  );
});

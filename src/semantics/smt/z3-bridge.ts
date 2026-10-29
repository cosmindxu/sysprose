/**
 * The z3 seam: one dynamic import, one place that says "no solver", and no
 * unbounded check anywhere.
 *
 * THE CHARTER OF THIS FILE, IN ONE LINE: **an absent solver is an ANSWER, not
 * an import error.** `z3-solver` is an OPTIONAL dependency — the WASM asset is
 * tens of megabytes, a browser page can run it only when cross-origin isolated
 * (§6 non-goal 9: `SharedArrayBuffer` needs COOP/COEP headers GitHub Pages
 * cannot set, so the hosted site has none; the local dev and preview servers
 * send them and serve z3 to the page, `vite.config.ts`), and a clone that
 * skipped optional dependencies must still typecheck, build, and run every
 * suite. So the package is reached through a dynamic import behind a
 * variable specifier, its absence is reported as {@link Z3Absent} with a
 * sentence a person can act on, and NOTHING here throws because a package is
 * missing.
 *
 * Six rules this module exists to hold, each of which is a way the lane could
 * have gone quietly green (or, the last one, quietly dead):
 *
 *  - **`SYSPROSE_NO_Z3=1` forces the absent path.** The honest-absence route is
 *    the single most likely thing in this lane to rot into a silent green, and
 *    a machine that HAS z3 cannot exercise it by accident. The switch makes it
 *    testable here and runnable in CI (§5), and it is read on every call rather
 *    than once at module load, so a suite can set it around one case.
 *  - **Every check is bounded.** {@link Z3Backend.check} refuses a non-finite,
 *    zero or negative budget and defaults to {@link DEFAULT_TIMEOUT_MS}. z3
 *    answers `unknown` with `reasonUnknown() === 'timeout'` when the budget is
 *    spent, and that is reported as `unknown` WITH the bound — never retried
 *    with a weaker encoding, never rounded up to `unsat` (§6, "Nonlinearity").
 *  - **A script z3 REFUSES is an `error`, never an `unknown`.** z3 rejects a
 *    malformed script and a `(set-logic QF_LRA)` carrying nonlinear arithmetic
 *    by throwing out of `fromString`. Folding that into `unknown` would turn an
 *    ENCODER DEFECT into an ordinary inconclusive row that
 *    `--allow-inconclusive` may forgive. It is its own status, and the caller
 *    is told what z3 said.
 *  - **The seed is fixed.** `random_seed` is pinned to {@link RANDOM_SEED} on
 *    every solver, so a determinism failure in a suite is a real one and not a
 *    seed (§6, the worker-parallelism row).
 *  - **A dead module is discarded, never reused.** z3's WASM build can die
 *    under a check (defect D5, measured on CI: an `ASSERTION VIOLATION` inside
 *    `check_sat`, the check's pthread gone, z3 calling `exit()`), and once it
 *    has, the check's promise never settles and every later call on the same
 *    module traps. {@link isZ3ModuleDeath} names those shapes; a check that
 *    shows one, or that has not settled {@link DEAD_MODULE_MARGIN_MS} past its
 *    own budget, throws {@link Z3ModuleDeadError}, drops the cached module and
 *    terminates its worker threads, so the NEXT {@link loadZ3} pays `init()`
 *    again instead of handing out the corpse. It is a THROW and not a fourth
 *    `error` outcome on purpose: `error` means "z3 refused the script this tool
 *    produced", and a runtime that stopped existing is not a defect in the
 *    script — folding it in would print that sentence over the wrong fact.
 *    The abandoned call is cancelled with the threads (`async_cancel`, the
 *    module's own hook): its promise rejects, so the caller is not left
 *    waiting, and the 600 s keep-alive timer the call left behind is cleared,
 *    so the process can end. `z3-solver` 5.2 kept ONE lock for the whole
 *    process and no such hook, and this file gave the lock back by hand and
 *    ended the command itself; 5.3.1 has a lock per module and the hook.
 *  - **No z3 call on the main thread overlaps a check.** This is what killed
 *    the module in D5, found later and reproduced. The shipped `z3-solver`
 *    WASM is a libz3 built `--single-threaded` — no allocator in it takes a
 *    lock — driven from pthreads: `check()` runs on a worker thread while the
 *    main thread stays free. And `z3-solver` 5.2 freed every Solver, Optimize,
 *    Model and term wrapper from a `FinalizationRegistry` whose callbacks are
 *    bare `*_dec_ref` calls, which V8 runs on the main thread when it collects
 *    the last checks' objects: traced, every one of them ran while the NEXT
 *    check was on its thread. The two threads then corrupt the heap they
 *    share, and later the solver or a free dereferences garbage (`memory
 *    access out of bounds`, `corrupted its heap`, the `hashtable.h:445`
 *    assertion), or an answer is simply wrong. Under load (five processes of
 *    154 checks an iteration on the v9 model beside twelve busy loops) all five
 *    unguarded 5.2.0 processes failed within eight iterations. Fixed upstream
 *    (https://github.com/Z3Prover/z3/issues/10999, released in 5.3.1): the
 *    library queues the frees a collection asks for and runs them on its next
 *    API call, defers the others until the async call settles, and keeps the
 *    lock per module. The same load on 5.3.1 with every guard this file used
 *    to carry switched off ran 5 x 25 iterations (over a million finalizer
 *    callbacks landing under checks per process) with no trap, death or
 *    changed answer. So the finalizer deferral, the lock release and the
 *    command's own ending are gone, and a `z3-solver` without the fix is
 *    refused ({@link initialise}) rather than trusted. What stays is what the
 *    library still documents as unsafe: a SYNCHRONOUS z3 call on the main
 *    thread under a running check. A check holds its module from `new
 *    Solver()` to its last read ({@link enter} / {@link leave}), and checks on
 *    one module queue rather than overlap ({@link serially}). The solver,
 *    optimiser and model are still released explicitly, so the heavy frees
 *    happen between checks and z3's heap stays flat.
 *
 * WHY SMT-LIB2 TEXT RATHER THAN THE `Context` OBJECT API. The encoder
 * ({@link ./encode}) builds a SCRIPT, and this bridge asserts it with
 * `Solver.fromString`. That keeps the encoder pure and free of any dependency
 * on a package that may not be installed — its whole suite runs with no solver
 * present — makes "two encodes of the same model are byte-equal" a statement
 * about an artefact a person can read, and makes the eventual
 * `export --format smt2` the same bytes the in-process solver saw rather than a
 * second rendering of them.
 *
 * The version is CAPTURED rather than assumed: `z3-solver`'s package version
 * and the z3 build it wraps are different numbers, and a verdict line that
 * names a solver has to name the one that ran.
 */

import { termRational, type Rational } from '../exact';

/** The per-check budget, in milliseconds. No check is ever unbounded. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The fixed `random_seed`.
 *
 * Zero is not special to z3; what matters is that it does not move. A suite
 * that compares two runs — the same script twice, or the same suite under two
 * worker pools — is asserting determinism, and an unpinned seed would make that
 * assertion about luck.
 */
export const RANDOM_SEED = 0;

/** No backend, and the sentence saying why. Never an exception. */
export interface Z3Absent {
  readonly absent: true;
  /** What is missing and what the reader can do about it. */
  readonly reason: string;
  /** True when {@link SYSPROSE_NO_Z3} forced this, not a missing package. */
  readonly disabled: boolean;
}

/** A loaded solver, with everything a verdict line has to name. */
export interface Z3Backend {
  readonly absent: false;
  /** z3's release, e.g. `5.3.1` — what a verdict sentence names. Never empty. */
  readonly version: string;
  /** z3's long form, e.g. `5.3.1.0 <commit> z3-5.3.1` — evidence-record metadata, not a sentence. */
  readonly fullVersion: string;
  /** The seed every solver in this process is pinned to. */
  readonly seed: number;
  /** How long `init()` took, in ms — measured once, on the first load. */
  readonly initMs: number;
  /** Run one bounded check over an SMT-LIB2 script. */
  check(script: string, opts?: CheckOptions): Promise<CheckOutcome>;
  /**
   * Run one bounded OPTIMISATION over an SMT-LIB2 script that ends in a single
   * `(maximize …)` or `(minimize …)`.
   *
   * A separate entry point rather than a flag on {@link check}, because what
   * comes back is a different thing: `νZ` answers with a BOUND — possibly
   * infinite, possibly a supremum nothing attains — and a caller that read that
   * as a `sat` witness would print a design point where the model admits none.
   *
   * ONE OBJECTIVE PER SCRIPT, and the reason is measured rather than assumed:
   * z3 optimises several objectives LEXICOGRAPHICALLY by default, so a script
   * carrying `(minimize x)` and `(maximize x)` answers `1` for both on
   * `1 ≤ x ≤ 5` — the maximisation runs under the minimum already fixed. A
   * `--sense both` run is therefore two scripts and two calls, never one.
   */
  optimize(script: string, sense: OptimizeSense, opts?: CheckOptions): Promise<OptimizeOutcome>;
}

/** Which direction an objective is pushed in. */
export type OptimizeSense = 'min' | 'max';

/**
 * The bound z3 proved, in the three parts νZ actually reports it in.
 *
 * `getUpperAsVector` / `getLowerAsVector` return `[infinity, rational,
 * epsilon]`, and all three matter to a verdict line that must not overstate
 * itself:
 *
 *  - `infinite ≠ 0` is **unbounded** in the direction asked for — there is no
 *    optimum and printing the rational part (which is 0) as one would state a
 *    number the model never admits.
 *  - `epsilon ≠ 0` is a supremum or infimum the model APPROACHES and never
 *    attains: `x < 5` has no maximum, and z3 says so as `5 + (−1)·ε`. It is an
 *    exact bound and it is not a value the design can take, and those are two
 *    different sentences.
 *  - otherwise the rational part is the optimum, attained.
 */
export interface ObjectiveBound {
  /** z3's own rendering — `oo`, `5`, `(+ 5.0 (* (- 1.0) epsilon))`. The exact answer. */
  term: string;
  /** The infinity coefficient: `+1` unbounded above, `−1` unbounded below, `0` finite. */
  infinite: number;
  /** The finite part as a JS number, or `null` when it is not one. */
  value: number | null;
  /** The epsilon coefficient: non-zero for a bound that is approached, never reached. */
  epsilon: number;
}

/** What one bounded optimisation came to. */
export interface OptimizeOutcome {
  status: CheckStatus;
  /** z3's `reasonUnknown()`, or the message it refused the script with. `''` otherwise. */
  reason: string;
  timedOut: boolean;
  timeoutMs: number;
  elapsedMs: number;
  /** The bound, for `sat`. `null` for every other status. */
  bound: ObjectiveBound | null;
  /** The point z3 stopped at, for `sat`. Empty otherwise. */
  witness: WitnessValue[];
  /** {@link CheckOutcome.completion}: the rest of that point, for a re-read only. */
  completion: WitnessValue[];
}

/** What {@link loadZ3} answers: a backend, or an absence with a reason. */
export type Z3Load = Z3Backend | Z3Absent;

/** The environment switch that forces the absent path on a machine that has z3. */
export const SYSPROSE_NO_Z3 = 'SYSPROSE_NO_Z3';

/** How one check may be bounded and read. */
export interface CheckOptions {
  /** The budget in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}; must be finite and positive. */
  timeoutMs?: number;
  /**
   * The symbols a `sat` witness should carry, in the caller's order.
   *
   * Omit it and every 0-arity constant in z3's model is returned, INCLUDING the
   * Boolean constants a `:named` assertion introduces. A caller that knows its
   * variables should say so; the encoder's script names them.
   */
  variables?: readonly string[];
  /**
   * `false` where the caller reads the status, the reason and the core of a
   * `sat` answer and never its model: the model is READ as every check reads
   * it — each entry fetched, the completion's evaluations made — and nothing
   * of it is printed, so `witness` and `completion` come back empty.
   *
   * Only the printing is skipped. Which entries a check fetches moves what the
   * shared context answers later ({@link witnessOf}); the printing moves
   * nothing, and on a model-wide check it is most of the check's cost — the
   * `:named` labels of every script the context has asserted, each printed at
   * its whole formula: 1.4 of 1.7 s of one such check on a model of 4098
   * instance rows.
   */
  witness?: boolean;
}

/**
 * What one check came to.
 *
 * `error` is a fourth status on purpose — see the charter. It is never a
 * verdict about a model.
 */
export type CheckStatus = 'sat' | 'unsat' | 'unknown' | 'error';

/** One value of a `sat` witness, as z3 wrote it and as a number when it is one. */
export interface WitnessValue {
  /** The declared symbol — a qualified name, never an element id. */
  symbol: string;
  /** z3's own rendering, e.g. `(/ 11.0 4.0)`. The exact answer. */
  term: string;
  /**
   * The same value as a JS number, or `null` when it is not numeric.
   *
   * Lossy BY CONSTRUCTION — `(/ 1.0 3.0)` has no binary64 — which is why
   * {@link term} is kept beside it and is what an evidence record should carry.
   */
  value: number | boolean | null;
}

/** The result of one bounded check. */
export interface CheckOutcome {
  status: CheckStatus;
  /** z3's `reasonUnknown()`, or the message it refused the script with. `''` otherwise. */
  reason: string;
  /** True only for `unknown` whose reason is a spent budget. */
  timedOut: boolean;
  /** The budget the check ran under, in ms — printed beside every `unknown`. */
  timeoutMs: number;
  /** Wall clock for this check alone, excluding `init()`. */
  elapsedMs: number;
  /** The model, for `sat`. Empty otherwise. */
  witness: WitnessValue[];
  /**
   * Every constant the script declares that {@link witness} does not carry, at
   * the value z3's model gives it COMPLETED, for `sat`. Empty otherwise.
   *
   * FOR A RE-READ, NEVER FOR PRINT ({@link rereadPoint}). z3's model is
   * partial: a constant whose value no assertion turns on is left out of it —
   * `w` in `(=> w (<= x 20.0))` once `x = 0` makes the implication true — and
   * WHICH ones it leaves out depends on the context's history, which every
   * check in a process shares (see {@link cached}). A re-read over the bare
   * model found the premise `w == true` unreadable and filed a point z3 had
   * found as not-evaluable, so a verdict turned on whatever unrelated script
   * ran before it. Measured on v9: in a fresh process three consistency
   * subjects were `inconclusive` for exactly that reason, and a change to
   * OTHER subjects' scripts moved two of them to `consistent` and a third
   * subject the other way, their own scripts byte-identical. z3 leaves a
   * constant out only where the assertions hold whatever its value, so the
   * completed point satisfies the script as the model does — and every
   * re-reader still checks it for itself. The printed witness stays z3's own
   * model, the one a reader gets back by running the script.
   */
  completion: WitnessValue[];
  /** The `:named` labels of an UNSAT core, for `unsat`. Empty otherwise. */
  core: string[];
}

/**
 * Is the solver switched off by the environment, and what does that say?
 *
 * The reading matches `src/api/verification.ts`'s probe exactly — set,
 * non-empty and not `0` — because two readings of one switch is one switch too
 * many, and the CI job that asserts exit 2 under it (§5) must mean the same
 * thing as the suite that asserts an absent backend.
 */
export function z3Disabled(): boolean {
  if (typeof process === 'undefined') return false;
  const raw = process.env?.[SYSPROSE_NO_Z3];
  return raw !== undefined && raw !== '' && raw !== '0';
}

/**
 * The initialised module AND its one context, kept across calls.
 *
 * `init()` costs ~100 ms, which is the reason the module is cached. The CONTEXT
 * is cached for a different and sharper reason: every `z3.Context(…)` allocates
 * inside the WASM heap and nothing in the JS API releases it, so a context per
 * check grows the heap by roughly 9 MB every time — measured here as 185 MB
 * after init and 2 GB after 400 checks. The call counts this lane is being
 * built for (a fault tree's Σ C(n,k) checks, an explorer defaulting to 10 000
 * configurations, a differential gate over 81 fixtures) would exhaust memory
 * rather than answer. One context, a fresh `Solver` per check: the solver is
 * what carries the assertions, so no assertion outlives its script either way.
 */
let cached: CachedModule | undefined;

/**
 * The `init()` in progress, so a second {@link loadZ3} during it awaits the
 * first rather than initialising a second module beside it.
 */
let pending: Promise<CachedModule> | undefined;

/**
 * One initialised module: the API, its one context, the figures a verdict line
 * names, and the state that keeps its main-thread calls off its checks.
 *
 * The exclusion state lives HERE and not at module scope, because a module the
 * bridge has given up on can still have a check outstanding: a trap leaves its
 * promise unsettled until the {@link DEAD_MODULE_MARGIN_MS} guard fires, and a
 * process-wide counter would hold the fresh module's first check up behind it.
 */
interface CachedModule {
  z3: Z3Api;
  ctx: Z3Context;
  initMs: number;
  /**
   * The version strings, read once at init: even these are z3 calls, and a
   * `loadZ3()` made while another caller's check runs must not make one.
   */
  version: string;
  fullVersion: string;
  /** Checks between {@link enter} and {@link leave} on this module: 0 or 1. */
  inFlight: number;
  /** Found dead or terminated: nothing more is released into it. */
  dead: boolean;
  /** The last check queued on this module ({@link serially}); never rejects. */
  tail: Promise<unknown>;
}

/**
 * How many times a module has been found dead in this process.
 *
 * A COUNTER rather than a flag, because the observer that cares — a suite
 * deciding whether the red it just saw was the solver dying — runs after the
 * cache has already been dropped and possibly after a fresh module was loaded;
 * a flag {@link loadZ3} clears would be invisible to it. Monotonic, never reset.
 */
let deaths = 0;

/**
 * How many checks and optimisations this process has handed to a module.
 *
 * Counted once the budget is accepted, so a call refused for its budget is not
 * one, and a call on a module later found dead is. FOR SUITES: the campaign
 * reads it around each case to tell a case that drove z3 from one that did not,
 * which reading the case cannot do — most cases reach the solver through an
 * engine. Counts and nothing else. Monotonic, never reset.
 */
let calls = 0;

/**
 * The windows {@link z3BudgetWatch} has open: each keeps the largest budget a
 * check or optimisation was handed while it was open. Empty outside a suite.
 */
const budgetWatches = new Set<{ largest: number }>();

/** Count a call whose budget was accepted, and show that budget to every open watch. */
function countCall(timeoutMs: number): void {
  calls += 1;
  for (const w of budgetWatches) if (timeoutMs > w.largest) w.largest = timeoutMs;
}

/**
 * The slice of `z3-solver` this bridge uses.
 *
 * Declared structurally rather than imported: the package is optional, so a
 * `import type { … } from 'z3-solver'` would make `tsc` fail on a clone that
 * does not have it. Every member here is exercised by the suite, so a version
 * that moved the API would fail loudly rather than be typed into agreement.
 */
interface Z3Api {
  getVersionString(): string;
  getFullVersion(): string;
  setParam(name: string, value: string | number | boolean): void;
  Context(name: string): Z3Context;
  /**
   * The emscripten module behind the API, as `init()` spreads it in. Only its
   * thread pool and its `async_cancel` are touched, and only to stop the
   * workers of a module this bridge has given up on and reject the call they
   * were running; every member is optional because the shape is the package's
   * internals, not its contract. `async_cancel` is also the mark of a
   * `z3-solver` with the finalizer fix ({@link initialise}).
   */
  em?: { PThread?: { terminateAllThreads?: () => void }; async_cancel?: (reason?: Error) => void };
}
interface Z3Context {
  Solver: new () => Z3Solver;
  Optimize: new () => Z3Optimize;
  /**
   * The three sorts the encoder declares, for completing a model
   * ({@link completionOf}). Optional because the death suite's fake has none;
   * a context without them completes nothing.
   */
  Real?: { const(name: string): Z3Term };
  Int?: { const(name: string): Z3Term };
  Bool?: { const(name: string): Z3Term };
}
/** A term, as far as this bridge handles one: built, evaluated and printed. */
interface Z3Term {
  toString(): string;
}
/**
 * `release()` is optional on the three objects below because the death suite's
 * fake predates it; the real `z3-solver` has it on all three.
 */
interface Z3Optimize {
  set(key: string, value: string | number | boolean): void;
  fromString(script: string): void;
  check(): Promise<'sat' | 'unsat' | 'unknown'>;
  model(): Z3Model;
  /** `[infinity, rational, epsilon]` — see {@link ObjectiveBound}. */
  getUpperAsVector(index: number): Iterable<{ toString(): string }>;
  getLowerAsVector(index: number): Iterable<{ toString(): string }>;
  getUpper(index: number): { toString(): string };
  getLower(index: number): { toString(): string };
  reasonUnknown(): string;
  release?(): void;
}
interface Z3Solver {
  set(key: string, value: string | number | boolean): void;
  fromString(script: string): void;
  check(): Promise<'sat' | 'unsat' | 'unknown'>;
  model(): Z3Model;
  unsatCore(): Iterable<{ toString(): string }>;
  reasonUnknown(): string;
  release?(): void;
}
interface Z3Model extends Iterable<Z3Decl> {
  get(decl: Z3Decl): { toString(): string };
  /** With `modelCompletion` true, a constant the model leaves out gets a value. Optional: the fake has none. */
  eval?(term: Z3Term, modelCompletion: boolean): Z3Term;
  release?(): void;
}
interface Z3Decl {
  name(): { toString(): string };
}

/**
 * Load a z3 backend, or say why there is none.
 *
 * Never throws, never rejects. The two absences are told apart because they
 * mean different things to a reader: `SYSPROSE_NO_Z3=1` is a deliberate switch
 * (a CI job, a suite pinning the honest-absence path) and a missing package is
 * an installation a person can fix.
 */
export async function loadZ3(): Promise<Z3Load> {
  if (z3Disabled()) {
    return {
      absent: true,
      disabled: true,
      reason:
        `the solver is switched off by ${SYSPROSE_NO_Z3} in this environment; ` +
        'unset it to load `z3-solver`',
    };
  }
  if (typeof process === 'undefined' && !pageIsolated()) {
    // A browser page that is not cross-origin isolated (the hosted site, which
    // is static and gets no COOP/COEP headers): z3 WASM needs
    // `SharedArrayBuffer`, so there is no solver here. The app's own affordance
    // is "prove in the terminal". An isolated page (the local dev and preview
    // servers) goes on and loads z3 from them, below.
    return {
      absent: true,
      disabled: false,
      reason:
        'there is no solver in this page (z3 WASM needs SharedArrayBuffer, i.e. a cross-origin-isolated ' +
        'page, and this one is not); run the proof in the terminal',
    };
  }
  let entry = cached;
  if (!entry) {
    try {
      pending ??= initialise().finally(() => {
        pending = undefined;
      });
      entry = await pending;
    } catch (err) {
      if (err instanceof Z3TooOldError) {
        return {
          absent: true,
          disabled: false,
          reason:
            typeof process === 'undefined'
              ? `${err.message}, or run the proof in the terminal`
              : `${err.message}, or use \`--engine literal\` for a point evaluation at the model’s values, which is not a proof`,
        };
      }
      if (typeof process === 'undefined') {
        return {
          absent: true,
          disabled: false,
          reason:
            `z3 did not start in this page: ${messageOf(err)}. The local server serves it from the ` +
            '`z3-solver` package, which is OPTIONAL: run `npm install z3-solver`, or run the proof in the terminal',
        };
      }
      return {
        absent: true,
        disabled: false,
        reason:
          '`z3-solver` is not installed (it is an OPTIONAL dependency, and the WASM asset is tens ' +
          `of megabytes): ${messageOf(err)}. Run \`npm install z3-solver\` to install it, or use ` +
          '`--engine literal` for a point evaluation at the model’s values, which is not a proof',
      };
    }
  }

  return {
    absent: false,
    version: entry.version,
    fullVersion: entry.fullVersion,
    seed: RANDOM_SEED,
    initMs: entry.initMs,
    // Bound to THIS module, not to whatever is cached at call time: a backend
    // handed out before a death keeps pointing at the module it was made on,
    // and its next call is what reports that module dead.
    check: (script, opts) => runCheck(entry, script, opts),
    optimize: (script, sense, opts) => runOptimize(entry, script, sense, opts),
  };
}

/** The installed `z3-solver` is older than the release that fixed defect D5. */
class Z3TooOldError extends Error {
  constructor(spec: string) {
    super(
      `the installed \`${spec}\` predates the release that fixed defect D5 (5.3.0; this tool is ` +
        'checked on 5.3.1): its finalizers free under a running check and corrupt the solver’s heap, ' +
        `which can answer wrongly before it dies. Run \`npm install ${spec}@^5.3.1\``,
    );
    this.name = 'Z3TooOldError';
  }
}

/**
 * Import and initialise `z3-solver`, cache the module, and hand it back.
 *
 * Any throw is the caller's "not installed" answer, except {@link Z3TooOldError}:
 * a `z3-solver` without `async_cancel` on its module is older than the fix
 * (finalizers no longer free under a running check), so it is refused, with
 * the sentence that says what to install, rather than trusted.
 */
async function initialise(): Promise<CachedModule> {
  // The specifier is held in a variable and marked `@vite-ignore` so the
  // bundler neither resolves nor bundles a package the browser may not
  // have; `vite.config.ts` marks it external for the same reason. It is used
  // twice on purpose: a constant used once is inlined back into the `import()`
  // by the minifier, and `refuse-bundled-z3` then refuses the build.
  const spec = 'z3-solver';
  const mod =
    typeof process === 'undefined'
      ? await importPageZ3()
      : ((await import(/* @vite-ignore */ spec)) as { init: () => Promise<Z3Api> });
  const t0 = now();
  const z3 = await mod.init();
  const initMs = now() - t0;
  if (typeof z3.em?.async_cancel !== 'function') {
    z3.em?.PThread?.terminateAllThreads?.();
    throw new Z3TooOldError(spec);
  }
  // Process-wide, and set once: the per-solver `random_seed` below pins the
  // SMT core, this pins the modules that read the global namespace.
  z3.setParam('smt.random_seed', RANDOM_SEED);
  const entry: CachedModule = {
    z3,
    ctx: z3.Context('sysprose'),
    initMs,
    version: z3.getVersionString(),
    fullVersion: z3.getFullVersion(),
    inFlight: 0,
    dead: false,
    tail: Promise.resolve(),
  };
  cached = entry;
  return entry;
}

/** Whether this page can run z3: cross-origin isolated, so `SharedArrayBuffer` and WASM threads exist. */
function pageIsolated(): boolean {
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/**
 * z3 in an isolated page: the local server's `/z3/` (`vite.config.ts`
 * `localZ3`). `z3-built.js` is a classic script, loaded by a tag because
 * Emscripten finds its WASM and starts its worker threads from the tag's `src`,
 * and it leaves `initZ3` on the page; `browser.mjs` is the package's browser
 * entry, which reads it.
 */
async function importPageZ3(): Promise<{ init: () => Promise<Z3Api> }> {
  const base = new URL('z3/', document.baseURI).href;
  if ((globalThis as { initZ3?: unknown }).initZ3 === undefined) {
    await new Promise<void>((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = `${base}z3-built.js`;
      tag.onload = () => resolve();
      tag.onerror = () => reject(new Error(`${tag.src} did not load`));
      document.head.append(tag);
    });
  }
  return (await import(/* @vite-ignore */ `${base}browser.mjs`)) as { init: () => Promise<Z3Api> };
}

/**
 * Forget the initialised module, so the next {@link loadZ3} pays `init()` again.
 *
 * Exists for two reasons, both of them suites. The init cost is a registered
 * figure (§6), and a measurement taken after another suite in the same worker
 * already initialised z3 would report zero. And a campaign that drives one
 * context through a hundred checks can start each block on a fresh module,
 * which bounds what any one context has accumulated (defect D5).
 *
 * Forgetting is PURE by default: a backend handed out earlier keeps working on
 * the module it was made on, whose worker threads stay up (measured: +44 MB
 * RSS per forgotten module). `terminate: true` stops those workers as well
 * (+14 MB instead) and is only for a caller that holds no such backend.
 *
 * A call the terminated module had in flight is cancelled with its threads
 * ({@link terminateThreads}), so it rejects, and is counted a death, at once.
 */
export function resetZ3Cache(opts: { terminate?: boolean } = {}): void {
  const entry = cached;
  cached = undefined;
  if (entry && opts.terminate === true) {
    discard(entry);
    terminateThreads(entry);
  }
}

/** How many modules this process has found dead. See {@link deaths}. */
export function z3DeathCount(): number {
  return deaths;
}

/** How many checks and optimisations this process has handed to a module. See {@link calls}. */
export function z3CallCount(): number {
  return calls;
}

/**
 * Open a window on the budgets handed to a module, and get back the function
 * that closes it and returns the largest budget, in ms, a check or optimisation
 * was handed meanwhile (0 when none was; a call without `timeoutMs` counts as
 * {@link DEFAULT_TIMEOUT_MS}, the budget it ran under).
 *
 * FOR SUITES, like {@link z3CallCount}: the campaign holds a case that hands z3
 * a check to that check's budget plus {@link DEAD_MODULE_MARGIN_MS} plus 5 s,
 * and only the case's own timeout is known to the case. A window, not a
 * counter, because the largest value of a window cannot be read off a
 * monotonic one; windows may overlap, and each sees every call made while it
 * was open. The returned function may be called once.
 */
export function z3BudgetWatch(): () => number {
  const watch = { largest: 0 };
  budgetWatches.add(watch);
  return () => {
    budgetWatches.delete(watch);
    return watch.largest;
  };
}

/**
 * The cached module's API and context, or `undefined` when none is loaded.
 *
 * FOR SUITES ONLY — the soak reads z3's own heap figure through it, between
 * awaited calls. A z3 call made through it while a check is in flight is the
 * race the charter's last rule forbids.
 */
export function z3Internals(): { z3: Z3Api; ctx: Z3Context } | undefined {
  return cached ? { z3: cached.z3, ctx: cached.ctx } : undefined;
}

/**
 * How far past its own budget a check may run before the module is presumed
 * dead, in milliseconds.
 *
 * z3 enforces `timeout` from a timer thread that sets a cancel flag the search
 * polls, so an answer normally lands within a few hundred milliseconds of the
 * budget. A promise that has not settled 30 s after it is the other thing
 * (D5): the pthread running the check is gone and nothing will ever resolve
 * it. The margin is a flat 30 s rather than a multiple of the budget so that a
 * 400 ms probe and a 30 s fault-tree check are judged by the same overshoot,
 * and it sits above the 20 s the bounded-check suite allows a 400 ms budget.
 */
export const DEAD_MODULE_MARGIN_MS = 30_000;

/**
 * The bridge's one exception: the WASM module died under a call.
 *
 * Thrown, not returned — see the charter's fifth rule. The message starts with
 * a fixed phrase so a log can be grepped for it, names the shape z3 died in,
 * and says what happens next, because the reader of a CI log has to tell this
 * from a defect in the model or in this tool.
 */
export class Z3ModuleDeadError extends Error {
  /** The shape as it was seen: the trap's message, or the hang sentence. */
  readonly shape: string;
  constructor(shape: string) {
    super(
      `z3 WASM module died (defect D5): ${shape}. The module was discarded and its worker ` +
        'threads stopped; the next loadZ3() initialises a fresh one',
    );
    this.name = 'Z3ModuleDeadError';
    this.shape = shape;
  }
}

/** What {@link terminateThreads} rejects an abandoned call with. */
const THREADS_TERMINATED = 'Z3 threads were terminated';

/**
 * The shapes a dead emscripten module speaks in, measured from the CI trace
 * of defect D5 and from `z3-solver`'s own async wrapper.
 *
 * The check thread died with `getWasmTableEntry(...) is not a function`, the
 * timer thread with `null function or function signature mismatch`, z3's
 * `exit()` unwound the JS stack with the bare string `unwind`, and every call
 * after that trapped (`memory access out of bounds`, `WebAssembly.Table.get():
 * invalid index …`). `async_call` keeps ONE pending-call slot, so once a call
 * has been abandoned the wrapper itself refuses the next one with "you can't
 * execute multiple async functions at the same time" — that sentence is a
 * death too, of the module rather than of the call. Since 5.3.1 an abort
 * (`Z3 module aborted: …`) or a stop of the threads under a call rejects it
 * (`Z3 threads were terminated`, this file's own {@link THREADS_TERMINATED}),
 * where the call used to hang; those two are a death as well.
 */
const DEATH_SIGNATURES: readonly RegExp[] = [
  /\bAborted\(/,
  /null function or function signature mismatch/,
  /getWasmTableEntry/,
  /memory access out of bounds/,
  /WebAssembly\.Table\.get\(\)/,
  /table index is out of bounds/,
  /can't execute multiple async functions at the same time/,
  /^unwind$/,
  /^Z3 module aborted: /,
  new RegExp(`^${THREADS_TERMINATED}$`),
];

/**
 * Is this thrown thing a dead module, as opposed to something z3 SAID?
 *
 * A `WebAssembly.RuntimeError` is a trap, after which the module's C++ state
 * is undefined; emscripten's `ExitStatus` is `exit()` having run; the rest are
 * matched by message. A refusal z3 states in words — "unknown constant",
 * "unsupported" — is none of these and stays an ordinary `error` outcome.
 */
export function isZ3ModuleDeath(err: unknown): boolean {
  if (typeof err === 'string') return DEATH_SIGNATURES.some((re) => re.test(err));
  if (typeof err !== 'object' || err === null) return false;
  if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) return true;
  if ((err as { name?: unknown }).name === 'ExitStatus') return true;
  const message = messageOf(err);
  return DEATH_SIGNATURES.some((re) => re.test(message));
}

/** The internal token for "the budget and the margin passed and nothing settled". */
class HangSignal extends Error {
  constructor(timeoutMs: number) {
    super(
      `the check did not answer within its ${timeoutMs} ms budget plus the ` +
        `${DEAD_MODULE_MARGIN_MS} ms margin; the thread running it is presumed gone`,
    );
    this.name = 'HangSignal';
  }
}

/**
 * Await a solver promise, or give up when the module is presumed dead.
 *
 * The timer is cleared the moment the promise settles, so a live CLI process
 * is never held open by it. A promise that settles AFTER the guard fired is
 * simply dropped: the module it came from has already been discarded.
 */
function settleOrDie<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HangSignal(timeoutMs)), timeoutMs + DEAD_MODULE_MARGIN_MS);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

/**
 * Turn a death seen on `entry` into the exception, having discarded the module.
 *
 * Anything that is not a death is rethrown untouched, so a bad budget or a
 * caller's own error keeps its original stack.
 */
function classify(entry: CachedModule, err: unknown): never {
  if (!(err instanceof HangSignal) && !isZ3ModuleDeath(err)) throw err;
  deaths += 1;
  discard(entry);
  if (cached === entry) cached = undefined;
  terminateThreads(entry);
  throw new Z3ModuleDeadError(err instanceof HangSignal ? err.message : messageOf(err));
}

/**
 * Refuse a call that reaches a module already discarded, before z3 is touched.
 *
 * A backend handed out before a death keeps pointing at its module, and a call
 * queued behind the one that died only gets its turn after the discard. After a
 * real death the heap is untrusted, so an answer from it could be false: it is
 * refused, not run. Not counted again — the module's death was, once.
 */
function refuseDiscarded(entry: CachedModule): void {
  if (entry.dead) {
    throw new Z3ModuleDeadError('the module was discarded before this call reached it; nothing was run on it');
  }
}

/** Mark a module dead: nothing more is released into it. */
function discard(entry: CachedModule): void {
  entry.dead = true;
}

/**
 * Stop a module's worker threads and cancel the call they were running, best
 * effort: a dead module may refuse even this.
 *
 * `async_cancel` is `z3-solver`'s own `killThreads` second half: it rejects the
 * pending call, so whoever awaits it is released, and clears the ref'd 600 s
 * keep-alive timer every off-thread call leaves, which nothing else clears for
 * a call whose thread died and which kept `sysprose` up for ten minutes after
 * its verdict. Run after the threads are stopped, as there.
 */
function terminateThreads(entry: CachedModule): void {
  try {
    entry.z3.em?.PThread?.terminateAllThreads?.();
  } catch {
    // The module is already past helping; nothing to report and nowhere to.
  }
  // Its own try: a stop that threw must not leave the keep-alive timer running.
  try {
    entry.z3.em?.async_cancel?.(new Error(THREADS_TERMINATED));
  } catch {
    // As above.
  }
}

/**
 * One bounded check, with a fresh SOLVER so no assertion outlives its script.
 *
 * The solver is fresh; the context is not, and that asymmetry is the point —
 * see {@link cached}. Assertions live on the solver, so a new one per check is
 * the whole isolation this needs; a new context per check would only add ~9 MB
 * of WASM heap that is never given back.
 */
async function runCheck(
  entry: CachedModule,
  script: string,
  opts: CheckOptions = {},
): Promise<CheckOutcome> {
  // A bad budget is the caller's error and keeps its own stack: it is refused
  // before the module is touched, so it can never be mistaken for a death.
  const timeoutMs = boundOf(opts.timeoutMs);
  countCall(timeoutMs);
  return serially(entry, async () => {
    refuseDiscarded(entry);
    try {
      return await checkOn(entry, script, timeoutMs, opts.variables, opts.witness !== false);
    } catch (err) {
      return classify(entry, err);
    }
  });
}

/**
 * {@link runCheck}'s body, with every trap of a dead module allowed to escape.
 *
 * The whole body is the module's exclusive region, not just the `await`:
 * `new Solver()`, `set` and `fromString` are main-thread z3 calls as well, and
 * `z3-solver`'s own mutex serialises only the check itself.
 */
async function checkOn(
  entry: CachedModule,
  script: string,
  timeoutMs: number,
  variables: readonly string[] | undefined,
  print = true,
): Promise<CheckOutcome> {
  enter(entry);
  let settled = false;
  let made: Z3Solver | undefined;
  try {
    const empty = { witness: [] as WitnessValue[], completion: [] as WitnessValue[], core: [] as string[], timeoutMs };
    const solver = new entry.ctx.Solver();
    made = solver;
    solver.set('timeout', timeoutMs);
    solver.set('random_seed', RANDOM_SEED);

    try {
      solver.fromString(script);
    } catch (err) {
      // The script itself was refused — a malformed term, an undeclared symbol,
      // or a `set-logic` the assertions do not fit. That is a defect in what this
      // tool produced, and it is reported as one. A trap is not a refusal.
      if (isZ3ModuleDeath(err)) throw err;
      // z3 answered in words and nothing ran on its thread: as settled as a check.
      settled = true;
      return { ...empty, status: 'error', reason: messageOf(err), timedOut: false, elapsedMs: 0 };
    }

    const t0 = now();
    let status: 'sat' | 'unsat' | 'unknown';
    try {
      status = await settleOrDie(solver.check(), timeoutMs);
    } catch (err) {
      if (err instanceof HangSignal || isZ3ModuleDeath(err)) throw err;
      settled = true;
      return {
        ...empty,
        status: 'error',
        reason: messageOf(err),
        timedOut: false,
        elapsedMs: now() - t0,
      };
    }
    settled = true;
    const elapsedMs = now() - t0;

    if (status === 'sat') {
      return {
        ...empty,
        status,
        reason: '',
        timedOut: false,
        elapsedMs,
        ...witnessOf(solver, variables, entry.ctx, script, print),
      };
    }
    if (status === 'unsat') {
      return { ...empty, status, reason: '', timedOut: false, elapsedMs, core: coreOf(solver) };
    }
    const reason = safe(() => solver.reasonUnknown(), 'unknown');
    return { ...empty, status, reason, timedOut: reason === 'timeout', elapsedMs };
  } catch (err) {
    // A trap after the answer — the model's release, in `witnessOf` — is a
    // death all the same: nothing more may be freed into the module.
    if (isZ3ModuleDeath(err)) settled = false;
    throw err;
  } finally {
    leave(entry, settled, made);
  }
}

/**
 * Run `fn` once every check queued on `entry` before it has finished.
 *
 * Per module, not per process: a module the bridge gave up on may still hold an
 * orphaned check until its {@link DEAD_MODULE_MARGIN_MS} guard fires, and the
 * fresh module's checks must not wait behind it. Two modules do not share a
 * heap, so their checks cannot race each other.
 */
function serially<T>(entry: CachedModule, fn: () => Promise<T>): Promise<T> {
  const turn = entry.tail.then(fn);
  entry.tail = turn.catch(() => undefined);
  return turn;
}

/**
 * Open the module's exclusive region, before the first z3 call of a check.
 *
 * {@link serially} makes an overlap impossible through {@link Z3Backend}; this
 * is the assertion that keeps it so. It throws BEFORE z3 is touched, so it is
 * a plain error and never read as a death — `z3-solver`'s own refusal of a
 * second async call is one of the {@link DEATH_SIGNATURES}.
 */
function enter(entry: CachedModule): void {
  if (entry.inFlight > 0) {
    throw new Error(
      'z3 checks must not overlap: a second check was started on a module while one was in ' +
        'flight, and a main-thread z3 call under a running check corrupts its heap (defect D5)',
    );
  }
  entry.inFlight += 1;
}

/**
 * Close the region: release what the check made.
 *
 * Only when the check SETTLED, on a module not already discarded. On the death
 * path the module is about to be discarded, and its heap is either corrupt (a
 * trap) or still in use by a thread that never answered (a hang): a free into
 * it is the very race the region exists to prevent — the main-thread
 * `~context` traps the investigation saw were exactly that. A release that
 * traps marks the module dead; its throw goes on to {@link classify}.
 */
function leave(entry: CachedModule, settled: boolean, made: { release?(): void } | undefined): void {
  const clean = settled && !entry.dead;
  try {
    if (clean) safeRelease(made);
  } catch (err) {
    discard(entry);
    throw err;
  } finally {
    entry.inFlight -= 1;
  }
}

/**
 * Free a solver, optimiser or model now, between checks, rather than whenever
 * V8 collects it — usually under the next check, where z3-solver queues the
 * free and runs it later. Explicit, the heavy frees happen here and the
 * heap stays flat.
 *
 * Best effort for a refusal: a fake without `release`, or one that says no in
 * words, leaves the outcome already read untouched and the finalizer frees the
 * object instead. A TRAP is not a refusal: it is a `*_dec_ref` into a heap that
 * is already corrupt — the race this file exists to prevent, seen — so it is
 * rethrown, to be counted a death and the module discarded. Swallowed, the
 * module would stay cached and the next check would run on it; before the
 * release was explicit, the same free trapped from a finalizer, loudly.
 */
function safeRelease(obj: { release?(): void } | undefined): void {
  try {
    obj?.release?.();
  } catch (err) {
    if (isZ3ModuleDeath(err)) throw err;
    // Otherwise nothing to report and nowhere to: the answer was read before this ran.
  }
}

/**
 * One bounded optimisation, with a fresh `Optimize` so no objective outlives
 * its script.
 *
 * The same asymmetry {@link runCheck} runs under — a fresh optimiser, the
 * cached context — and for the same measured reason (see {@link cached}).
 *
 * WHAT IS READ BACK, AND FROM WHICH SIDE. A maximisation's answer is its UPPER
 * bound and a minimisation's is its LOWER one; reading the other side of the
 * pair reports the value the search started from rather than the one it proved.
 * The vector form is read rather than the term, because the three coefficients
 * are the difference between "unbounded", "approached and never attained" and
 * "attained" — three different verdict sentences that all render as one string.
 */
async function runOptimize(
  entry: CachedModule,
  script: string,
  sense: OptimizeSense,
  opts: CheckOptions = {},
): Promise<OptimizeOutcome> {
  const timeoutMs = boundOf(opts.timeoutMs);
  countCall(timeoutMs);
  return serially(entry, async () => {
    refuseDiscarded(entry);
    try {
      return await optimizeOn(entry, script, sense, timeoutMs, opts.variables);
    } catch (err) {
      return classify(entry, err);
    }
  });
}

/**
 * {@link runOptimize}'s body, with every trap of a dead module allowed to
 * escape — the module's exclusive region, as {@link checkOn}'s is.
 */
async function optimizeOn(
  entry: CachedModule,
  script: string,
  sense: OptimizeSense,
  timeoutMs: number,
  variables: readonly string[] | undefined,
): Promise<OptimizeOutcome> {
  enter(entry);
  let settled = false;
  let made: Z3Optimize | undefined;
  try {
    const empty = { bound: null, witness: [] as WitnessValue[], completion: [] as WitnessValue[], timeoutMs };
    const opt = new entry.ctx.Optimize();
    made = opt;
    opt.set('timeout', timeoutMs);
    opt.set('random_seed', RANDOM_SEED);

    try {
      opt.fromString(script);
    } catch (err) {
      // The same reading as `check`'s: a script z3 REFUSES is a defect in what
      // this tool produced — an objective over a symbol nothing declared, most
      // likely — and never an undecided answer about the model.
      if (isZ3ModuleDeath(err)) throw err;
      settled = true;
      return { ...empty, status: 'error', reason: messageOf(err), timedOut: false, elapsedMs: 0 };
    }

    const t0 = now();
    let status: 'sat' | 'unsat' | 'unknown';
    try {
      status = await settleOrDie(opt.check(), timeoutMs);
    } catch (err) {
      if (err instanceof HangSignal || isZ3ModuleDeath(err)) throw err;
      settled = true;
      return { ...empty, status: 'error', reason: messageOf(err), timedOut: false, elapsedMs: now() - t0 };
    }
    settled = true;
    const elapsedMs = now() - t0;

    if (status !== 'sat') {
      const reason = status === 'unknown' ? safe(() => opt.reasonUnknown(), 'unknown') : '';
      return { ...empty, status, reason, timedOut: reason === 'timeout', elapsedMs };
    }
    // The bound and then the witness, both read before `leave` releases `opt`.
    return {
      ...empty,
      status,
      reason: '',
      timedOut: false,
      elapsedMs,
      bound: boundOfObjective(opt, sense),
      ...witnessOf(opt, variables, entry.ctx, script),
    };
  } catch (err) {
    // As in `checkOn`: a trap out of the model's release ends the module here.
    if (isZ3ModuleDeath(err)) settled = false;
    throw err;
  } finally {
    leave(entry, settled, made);
  }
}

/** The proved bound of objective 0, from the side the sense asked for. */
function boundOfObjective(opt: Z3Optimize, sense: OptimizeSense): ObjectiveBound | null {
  const parts = safe(
    () =>
      [...(sense === 'max' ? opt.getUpperAsVector(0) : opt.getLowerAsVector(0))].map((p) =>
        p.toString(),
      ),
    [] as string[],
  );
  const term = safe(
    () => (sense === 'max' ? opt.getUpper(0) : opt.getLower(0)).toString(),
    parts.join(' '),
  );
  if (parts.length !== 3) return null;
  const asNumber = (s: string): number => {
    const v = rationalToNumber(s);
    return typeof v === 'number' ? v : 0;
  };
  const rational = rationalToNumber(parts[1]);
  return {
    term,
    infinite: asNumber(parts[0]),
    value: typeof rational === 'number' ? rational : null,
    epsilon: asNumber(parts[2]),
  };
}

/** The budget, refused rather than silently repaired when it is not one. */
function boundOf(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `a check budget must be a finite positive number of milliseconds; got ${String(ms)}. ` +
        'No check in this lane is unbounded, so there is no spelling for "no timeout".',
    );
  }
  return Math.ceil(ms);
}

/**
 * The model, as `symbol → value`, in the caller's order when it named one —
 * and, apart from it, the rest of the script's declarations at the values the
 * model completes them to ({@link CheckOutcome.completion}).
 *
 * Typed on the one method it uses rather than on `Z3Solver`, because the
 * optimiser answers with a model too and a second copy of this function is how
 * the two surfaces would come to filter their witnesses differently.
 *
 * `print` false ({@link CheckOptions.witness}): the model is read exactly as
 * below — every entry fetched, the completion evaluated — and nothing is
 * printed; both lists come back empty.
 */
function witnessOf(
  solver: { model(): Z3Model },
  wanted: readonly string[] | undefined,
  ctx: Z3Context,
  script: string,
  print = true,
): { witness: WitnessValue[]; completion: WitnessValue[] } {
  const found = new Map<string, string>();
  const declared = declaredConstants(script);
  // With the caller's list, nothing below reads `found` beyond its symbols and
  // the script's declarations: the rest of the model goes unprinted. Among it
  // are the `:named` labels of every script the shared context has asserted,
  // each valued at its whole formula — six thousand of them, 0.7 s of
  // printing, for a check whose script declares one symbol.
  //
  // Every entry is still READ (`m.get`), printed or not: the shared context's
  // later answers depend on which of its terms a wrapper holds and when it is
  // let go. A first version of this skipped the read of the labels as well, and
  // moved the order of later unsat cores — the element a core finding names —
  // on eight models of the differential corpus; skipping only the printing
  // moved nothing.
  const needed = wanted !== undefined ? new Set<string>([...wanted, ...declared.map((d) => d.symbol)]) : undefined;
  // Unprinted, an entry is only KNOWN to be assigned: the completion asks no more.
  const assigned = new Set<string>();
  let completed = new Map<string, string>();
  // The one holder of the model: released here, once read, on every path. A
  // trap out of that release escapes, to be counted a death (`safeRelease`).
  let model: Z3Model | undefined;
  try {
    let m: Z3Model;
    try {
      m = solver.model();
      model = m;
      for (const decl of m) {
        const name = decl.name().toString();
        const value = m.get(decl);
        if (!print) assigned.add(name);
        else if (needed === undefined || needed.has(name)) found.set(name, value.toString());
      }
    } catch {
      return { witness: [], completion: [] };
    }
    // Read while the model is still held: `eval` is a call into it.
    completed = completionOf(m, ctx, declared, print ? found : assigned, print);
  } finally {
    safeRelease(model);
  }
  if (!print) return { witness: [], completion: [] };
  const symbols = wanted ?? [...found.keys()].sort();
  const witness: WitnessValue[] = [];
  for (const symbol of symbols) {
    const term = found.get(symbol);
    if (term === undefined) continue;
    witness.push({ symbol, term, value: valueOf(term) });
  }
  const printed = new Set(witness.map((w) => w.symbol));
  const completion: WitnessValue[] = [];
  for (const { symbol } of declared) {
    if (printed.has(symbol)) continue;
    // A declared constant the model DOES assign and the caller's list left
    // out is the model's own value; only the ones the model omits are completed.
    const term = found.get(symbol) ?? completed.get(symbol);
    if (term === undefined) continue;
    completion.push({ symbol, term, value: valueOf(term) });
  }
  return { witness, completion };
}

/**
 * The script's declarations z3's model leaves out, each at the value the model
 * gives it with model completion on — `0` for a number, `false` for a Boolean.
 *
 * A constant z3 will not evaluate stays out, and its re-read fails as it did
 * before this existed: unread, never confirmed. A TRAP is not a refusal and is
 * rethrown, to be counted a death — `eval` is a call into the module like any
 * other. `print` false makes every evaluation and prints none of them: each
 * completed constant maps to `''`.
 */
function completionOf(
  model: Z3Model,
  ctx: Z3Context,
  declared: ReadonlyArray<{ symbol: string; sort: 'Real' | 'Int' | 'Bool' }>,
  assigned: { has(symbol: string): boolean },
  print = true,
): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof model.eval !== 'function') return out;
  for (const { symbol, sort } of declared) {
    if (assigned.has(symbol) || out.has(symbol)) continue;
    const make = ctx[sort];
    if (make === undefined) continue;
    try {
      const value = model.eval(make.const(symbol), true);
      out.set(symbol, print ? value.toString() : '');
    } catch (err) {
      if (isZ3ModuleDeath(err)) throw err;
    }
  }
  return out;
}

/**
 * The 0-arity constants a script declares, in declaration order: the
 * encoder's `(declare-fun |Pkg::a| () Real)`, and `declare-const` too, quoted
 * or bare. The symbol comes back without its pipes, as z3 names it in a model.
 */
function declaredConstants(script: string): Array<{ symbol: string; sort: 'Real' | 'Int' | 'Bool' }> {
  const out: Array<{ symbol: string; sort: 'Real' | 'Int' | 'Bool' }> = [];
  const declaration =
    /\(\s*(?:declare-fun\s+(\|[^|\\]*\||[^\s()|]+)\s+\(\s*\)|declare-const\s+(\|[^|\\]*\||[^\s()|]+))\s+(Real|Int|Bool)\s*\)/g;
  for (const m of script.matchAll(declaration)) {
    out.push({ symbol: stripPipes(m[1] ?? m[2]), sort: m[3] as 'Real' | 'Int' | 'Bool' });
  }
  return out;
}

/**
 * The point a re-read reads: the witness and its {@link CheckOutcome.completion},
 * as `symbol → value`, with — `exact` — the rational each number IS
 * (`termRational` of ../exact), which a re-read decides a comparison by
 * (`rereadRelation` of ../exact): the double is z3's answer rounded. A value
 * with no number or truth-value reading (an algebraic root) is left out, and
 * the row that reads it is unread.
 *
 * Every gate that re-reads a `sat` answer through this tool's own evaluator
 * reads THIS, and none prints it: what a verdict line shows is the witness.
 */
export function rereadPoint(outcome: {
  witness: readonly WitnessValue[];
  completion: readonly WitnessValue[];
}): Map<string, number | boolean> & { exact: ReadonlyMap<string, Rational> } {
  const values = new Map<string, number | boolean>();
  const exact = new Map<string, Rational>();
  for (const w of [...outcome.witness, ...outcome.completion]) {
    if (w.value === null) continue;
    values.set(w.symbol, w.value);
    const r = typeof w.value === 'number' ? termRational(w.term) : undefined;
    if (r) exact.set(w.symbol, r);
  }
  return Object.assign(values, { exact });
}

/** The `:named` labels of the UNSAT core, in z3's order. */
function coreOf(solver: Z3Solver): string[] {
  try {
    return [...solver.unsatCore()].map((c) => stripPipes(c.toString()));
  } catch {
    return [];
  }
}

/**
 * A core as the SET it is, sorted. z3 returns the labels in an order that
 * flips between runs on the same tree (finalizer and GC timing), so a core
 * that is printed or stored goes through here first: the same model then
 * prints the same sentence on every run. (`engines/smt.ts` keeps its own
 * private copy of this one-liner.)
 */
export function sortedCore(core: readonly string[]): string[] {
  return [...core].sort();
}

/** `|a::b|` → `a::b`. A quoted SMT symbol is the same symbol. */
function stripPipes(s: string): string {
  return s.startsWith('|') && s.endsWith('|') ? s.slice(1, -1) : s;
}

/**
 * z3's rendering of a value as a JS number or boolean, or `null`.
 *
 * z3 writes an exact rational (`(/ 11.0 4.0)`), a decimal, an integer, a
 * negation (`(- 3.0)`), or `true`/`false`. The division is where a value can
 * leave binary64, which is why the caller keeps the term beside the number.
 */
export function rationalToNumber(term: string): number | boolean | null {
  const t = term.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  const neg = /^\(-\s+([\s\S]+)\)$/.exec(t);
  if (neg) {
    const inner = rationalToNumber(neg[1]);
    return typeof inner === 'number' ? -inner : null;
  }
  const div = /^\(\/\s+([^\s()]+)\s+([^\s()]+)\)$/.exec(t);
  if (div) {
    const a = Number(div[1]);
    const b = Number(div[2]);
    return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null;
  }
  // A root of an irrational algebraic number prints as `(root-obj …)`, which
  // has no decimal reading at all: `null` is the honest answer.
  if (t.startsWith('(')) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** {@link rationalToNumber}, named for the field it fills. */
function valueOf(term: string): number | boolean | null {
  return rationalToNumber(term);
}

/** A monotonic-enough clock that works in Node and in a worker. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** The message of a thrown thing, whatever it is. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Call `fn`, or fall back — used where z3 may refuse a query about its own state. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

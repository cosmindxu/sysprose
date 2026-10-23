/**
 * The bridge over a DEAD module: defect D5, simulated deterministically.
 *
 * On CI (run 35036623980, commit `fae0b0e`, no solver code touched) z3's WASM
 * build tripped `ASSERTION VIOLATION src/util/hashtable.h:445` inside
 * `check_sat`; the pthread running the check died with `getWasmTableEntry(...)
 * is not a function`, its timeout timer thread with `null function or function
 * signature mismatch`, and z3 called `exit()`. The check's promise never
 * settled — `z3-solver`'s `async_call` keeps ONE pending slot — so that case
 * timed out at 120 s, and every later case on the same cached module failed in
 * under a second: `memory access out of bounds`, `WebAssembly.Table.get():
 * invalid index …`, the bare string `unwind`. Sixty-one reds from one event.
 *
 * The real thing cannot be provoked on demand (three local runs and three
 * provocation runs of the campaign file were green), so the module is FAKED
 * here: `vi.mock('z3-solver')` hands the bridge an `init()` whose solver dies
 * in each shape the trace showed, plus the one the async wrapper adds. What is
 * asserted is the bridge's contract for a death — the call THROWS
 * {@link Z3ModuleDeadError} (never a fourth `error` outcome, which would print
 * "the solver refused the script this tool produced" over the wrong fact), the
 * cached module is dropped so the next {@link loadZ3} pays `init()` again, the
 * dead module's workers are stopped, and {@link z3DeathCount} advances — and
 * the NEGATIVE control: a refusal z3 states in words is still `status:
 * 'error'` and drops nothing. Without that control the classifier could be
 * widened until every refusal re-initialised the solver and nobody would see.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEAD_MODULE_MARGIN_MS,
  DEFAULT_TIMEOUT_MS,
  Z3ModuleDeadError,
  isZ3ModuleDeath,
  loadZ3,
  resetZ3Cache,
  z3BudgetWatch,
  z3DeathCount,
} from '@semantics/smt/z3-bridge';

type Status = 'sat' | 'unsat' | 'unknown';

/** The three objects the bridge releases explicitly. */
type Kind = 'solver' | 'optimize' | 'model';

/** What the fake solver does on each call; every hook is optional. */
interface Behaviour {
  construct?: () => void;
  set?: () => void;
  fromString?: (script: string) => void;
  check?: () => Promise<Status>;
  /** Runs inside every `release()`, after it is recorded; may throw. */
  release?: (kind: Kind) => void;
  /** Build objects with no `release` member at all — the fake as it was before. */
  noRelease?: boolean;
  /** Make `init()` reject, as a broken install would. */
  initFails?: boolean;
  /** Build a module with no `async_cancel`: a `z3-solver` older than the finalizer fix. */
  predatesFix?: boolean;
  /** Make `async_cancel` throw, as a module past helping may. */
  cancelThrows?: boolean;
  /** Make `terminateAllThreads` throw, as a module past helping may. */
  stopThrows?: boolean;
}

/** The fake module's counters, read by the cases below. */
const fake = {
  behaviour: {} as Behaviour,
  inits: 0,
  terminated: 0,
  /** Solvers and optimisers built, and checks started on them. */
  constructed: 0,
  checksStarted: 0,
  /** Every `release()`, by kind, in call order. */
  released: [] as Kind[],
  /** What `async_cancel` was called with, in call order. */
  cancelled: [] as unknown[],
  /** 'stop' and 'cancel' in the order the bridge made them: the threads go first. */
  order: [] as string[],
  /** The reject of every check started, so `async_cancel` can reject the one still pending. */
  rejects: [] as Array<(reason: unknown) => void>,
};

vi.mock('z3-solver', () => ({
  init: async () => {
    fake.inits += 1;
    if (fake.behaviour.initFails) throw new Error('fake init failed');
    const releasable = <O extends object>(kind: Kind, o: O): O =>
      fake.behaviour.noRelease
        ? o
        : Object.assign(o, {
            release() {
              fake.released.push(kind);
              fake.behaviour.release?.(kind);
            },
          });
    const model = () =>
      releasable('model', { *[Symbol.iterator]() {}, get: () => ({ toString: () => '' }) });
    const solver = (kind: 'solver' | 'optimize') => {
      fake.constructed += 1;
      const o = releasable(kind, {
        set() {
          fake.behaviour.set?.();
        },
        fromString(script: string) {
          fake.behaviour.fromString?.(script);
        },
        check(): Promise<Status> {
          fake.checksStarted += 1;
          const answered = fake.behaviour.check ? fake.behaviour.check() : Promise.resolve<Status>('sat');
          // As `z3-solver` 5.3's `async_cancel` rejects the call still pending on its module.
          return new Promise<Status>((resolve, reject) => {
            fake.rejects.push(reject);
            answered.then(resolve, reject);
          });
        },
        model,
        unsatCore: () => [],
        reasonUnknown: () => 'unknown',
        getUpperAsVector: () => ['0', '1', '0'],
        getLowerAsVector: () => ['0', '1', '0'],
        getUpper: () => ({ toString: () => '1' }),
        getLower: () => ({ toString: () => '1' }),
      });
      return o;
    };
    class Solver {
      constructor() {
        fake.behaviour.construct?.();
        return solver('solver');
      }
    }
    class Optimize {
      constructor() {
        fake.behaviour.construct?.();
        return solver('optimize');
      }
    }
    return {
      getVersionString: () => '0.0.0-fake',
      getFullVersion: () => 'Z3 0.0.0-fake',
      setParam: () => {},
      Context: () => ({ Solver, Optimize }),
      em: {
        PThread: {
          terminateAllThreads: () => {
            fake.terminated += 1;
            fake.order.push('stop');
            if (fake.behaviour.stopThrows) throw new Error('module past helping');
          },
        },
        ...(fake.behaviour.predatesFix
          ? {}
          : {
              async_cancel: (reason: unknown) => {
                if (fake.behaviour.cancelThrows) throw new Error('module past helping');
                fake.order.push('cancel');
                fake.cancelled.push(reason);
                for (const reject of fake.rejects.splice(0)) reject(reason);
              },
            }),
      },
    };
  },
}));

const SCRIPT = '(declare-const x Real)\n(assert (> x 1.0))\n(check-sat)';

/** Load, and refuse to go on if the fake was not what answered. */
async function backend() {
  const z3 = await loadZ3();
  expect(z3.absent, z3.absent ? z3.reason : '').toBe(false);
  if (z3.absent) throw new Error('unreachable');
  expect(z3.version).toBe('0.0.0-fake');
  return z3;
}

/** One turn of the event loop: every pending microtask has run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Wait, a bounded number of turns, until `cond` holds. */
async function until(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i += 1) await tick();
  expect(cond(), what).toBe(true);
}

/** Make every fake check stay on its "thread" until the case answers it. */
function holdChecks(): (status: Status) => void {
  let answer!: (status: Status) => void;
  const answered = new Promise<Status>((resolve) => {
    answer = resolve;
  });
  fake.behaviour.check = () => answered;
  return answer;
}

let envBefore: string | undefined;
beforeEach(() => {
  envBefore = process.env.SYSPROSE_NO_Z3;
  delete process.env.SYSPROSE_NO_Z3;
  fake.behaviour = {};
  fake.inits = 0;
  fake.terminated = 0;
  fake.constructed = 0;
  fake.checksStarted = 0;
  fake.released = [];
  fake.cancelled = [];
  fake.order = [];
  fake.rejects = [];
  resetZ3Cache();
});
afterEach(() => {
  if (envBefore === undefined) delete process.env.SYSPROSE_NO_Z3;
  else process.env.SYSPROSE_NO_Z3 = envBefore;
  vi.useRealTimers();
  resetZ3Cache();
});

describe('a module that dies under a check', () => {
  it('throws Z3ModuleDeadError, drops the cache, and the next loadZ3 pays init again', async () => {
    const deaths = z3DeathCount();
    fake.behaviour.check = () =>
      Promise.reject(new WebAssembly.RuntimeError('null function or function signature mismatch'));
    const z3 = await backend();
    expect(fake.inits).toBe(1);

    const failure = await z3.check(SCRIPT).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Z3ModuleDeadError);
    const message = (failure as Error).message;
    expect(message).toMatch(/^z3 WASM module died \(defect D5\)/);
    expect(message).toContain('null function or function signature mismatch');
    expect(message).toContain('the next loadZ3() initialises a fresh one');
    expect(z3DeathCount()).toBe(deaths + 1);
    expect(fake.terminated, 'the dead module’s workers are stopped').toBe(1);

    // The corpse is not handed out again: a fresh init, and it answers.
    fake.behaviour = {};
    const again = await backend();
    expect(fake.inits, 'loadZ3 after a death pays init again').toBe(2);
    expect((await again.check(SCRIPT)).status).toBe('sat');
    expect(z3DeathCount(), 'a working check is not a death').toBe(deaths + 1);
  });

  it('a backend made before the death still reports the death, not a stale answer', async () => {
    fake.behaviour.check = () => Promise.reject(new WebAssembly.RuntimeError('memory access out of bounds'));
    const old = await backend();
    await expect(old.check(SCRIPT)).rejects.toBeInstanceOf(Z3ModuleDeadError);
    fake.behaviour = {};
    await backend(); // a fresh module is now cached …
    expect(fake.inits).toBe(2);
    // … but the old backend is still bound to the module it was made on, and that
    // module would ANSWER: it is refused before z3 is touched, for the heap of a
    // module that died is not to be trusted with a verdict.
    const deaths = z3DeathCount();
    const built = fake.constructed;
    const started = fake.checksStarted;
    const refusal = await old.check(SCRIPT).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(Z3ModuleDeadError);
    expect((refusal as Error).message).toContain('nothing was run on it');
    await expect(old.optimize(`${SCRIPT}\n(maximize x)`, 'max')).rejects.toBeInstanceOf(Z3ModuleDeadError);
    expect(fake.constructed, 'no solver is built on a discarded module').toBe(built);
    expect(fake.checksStarted).toBe(started);
    expect(z3DeathCount(), 'the module’s death was counted once, not again per refusal').toBe(deaths);
  });

  it('a call queued behind the one that dies never builds a solver', async () => {
    // The first check dies; any later one the module were allowed to run would ANSWER.
    fake.behaviour.check = () =>
      fake.checksStarted === 1
        ? Promise.reject(new WebAssembly.RuntimeError('memory access out of bounds'))
        : Promise.resolve<Status>('sat');
    const z3 = await backend();
    const first = z3.check(SCRIPT);
    const second = z3.check(SCRIPT);
    const third = z3.optimize(`${SCRIPT}\n(maximize x)`, 'max');
    await expect(first).rejects.toBeInstanceOf(Z3ModuleDeadError);
    await expect(second).rejects.toBeInstanceOf(Z3ModuleDeadError);
    await expect(third).rejects.toBeInstanceOf(Z3ModuleDeadError);
    expect(fake.constructed, 'only the first call built a solver').toBe(1);
    expect(fake.checksStarted).toBe(1);
  });

  it.each([
    ['the check thread’s trap', { construct: undefined, thrown: new TypeError('getWasmTableEntry(...) is not a function') }],
    [
      'the funcref table after exit()',
      { thrown: new RangeError('WebAssembly.Table.get(): invalid index 20912129 into funcref table of size 23781') },
    ],
    ['emscripten’s exit unwinding the stack', { thrown: 'unwind' }],
    ['emscripten’s abort', { thrown: new WebAssembly.RuntimeError('Aborted(native code called abort())') }],
    ['emscripten’s ExitStatus token', { thrown: Object.assign(new Error('Program terminated with exit(1)'), { name: 'ExitStatus' }) }],
  ])('a trap thrown synchronously from the solver constructor — %s — is a death too', async (_what, { thrown }) => {
    // These are the shapes the CI trace showed OUTSIDE `solver.check()`: in
    // `new Solver()` and `solver.set()`, which the old bridge never caught.
    const deaths = z3DeathCount();
    fake.behaviour.construct = () => {
      throw thrown;
    };
    const z3 = await backend();
    await expect(z3.check(SCRIPT)).rejects.toBeInstanceOf(Z3ModuleDeadError);
    expect(z3DeathCount()).toBe(deaths + 1);
    fake.behaviour = {};
    await backend();
    expect(fake.inits).toBe(2);
  });

  it('a trap out of `set` or `fromString` is a death, not a refused script', async () => {
    const deaths = z3DeathCount();
    fake.behaviour.fromString = () => {
      throw new WebAssembly.RuntimeError('memory access out of bounds');
    };
    const z3 = await backend();
    await expect(z3.check(SCRIPT)).rejects.toBeInstanceOf(Z3ModuleDeadError);
    fake.behaviour = { set: () => { throw new WebAssembly.RuntimeError('unreachable'); } };
    const next = await backend();
    await expect(next.check(SCRIPT)).rejects.toBeInstanceOf(Z3ModuleDeadError);
    expect(z3DeathCount()).toBe(deaths + 2);
    expect(fake.inits).toBe(2);
  });

  it('the optimiser dies the same way', async () => {
    const deaths = z3DeathCount();
    fake.behaviour.check = () => Promise.reject(new WebAssembly.RuntimeError('null function or function signature mismatch'));
    const z3 = await backend();
    await expect(z3.optimize(`${SCRIPT}\n(maximize x)`, 'max')).rejects.toBeInstanceOf(Z3ModuleDeadError);
    expect(z3DeathCount()).toBe(deaths + 1);
    fake.behaviour = {};
    expect((await (await backend()).optimize(`${SCRIPT}\n(maximize x)`, 'max')).status).toBe('sat');
    expect(fake.inits).toBe(2);
  });
});

describe('a check that never settles', () => {
  it('is presumed dead one margin past its budget, and not a moment before', async () => {
    vi.useFakeTimers();
    const deaths = z3DeathCount();
    fake.behaviour.check = () => new Promise<Status>(() => {});
    const z3 = await backend();
    let settled: unknown = 'pending';
    const p = z3.check(SCRIPT, { timeoutMs: 1000 }).then(
      (r) => (settled = r),
      (err: unknown) => (settled = err),
    );
    await vi.advanceTimersByTimeAsync(1000 + DEAD_MODULE_MARGIN_MS - 1);
    expect(settled, 'still waiting inside budget + margin').toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBeInstanceOf(Z3ModuleDeadError);
    expect((settled as Error).message).toContain('did not answer within its 1000 ms budget');
    expect(z3DeathCount()).toBe(deaths + 1);
    expect(fake.terminated).toBe(1);
    fake.behaviour = {};
    await backend();
    expect(fake.inits, 'the hung module is not reused').toBe(2);
  });

  it('a check that answers clears its guard: no timer is left running', async () => {
    vi.useFakeTimers();
    const z3 = await backend();
    expect((await z3.check(SCRIPT)).status).toBe('sat');
    expect(vi.getTimerCount(), 'the dead-module guard was cleared').toBe(0);
  });
});

describe('the negative control: what z3 SAYS is never a death', () => {
  it('a refused script is still `error`, and the module is kept', async () => {
    const deaths = z3DeathCount();
    fake.behaviour.fromString = () => {
      throw new Error('line 1 column 5: unknown constant foo');
    };
    const z3 = await backend();
    const r = await z3.check(SCRIPT);
    expect(r.status).toBe('error');
    expect(r.reason).toBe('line 1 column 5: unknown constant foo');
    fake.behaviour = {};
    await backend();
    expect(fake.inits, 'no re-init for a refusal').toBe(1);
    expect(z3DeathCount()).toBe(deaths);
    expect(fake.terminated).toBe(0);
  });

  it('a check rejecting in words is still `error`, and the module is kept', async () => {
    const deaths = z3DeathCount();
    fake.behaviour.check = () => Promise.reject(new Error('solver exception: unsupported logic'));
    const z3 = await backend();
    const r = await z3.check(SCRIPT);
    expect(r.status).toBe('error');
    expect(r.reason).toBe('solver exception: unsupported logic');
    const o = await z3.optimize(`${SCRIPT}\n(maximize x)`, 'max');
    expect(o.status).toBe('error');
    await backend();
    expect(fake.inits).toBe(1);
    expect(z3DeathCount()).toBe(deaths);
  });

  it('a bad budget is the caller’s error, thrown before the module is touched', async () => {
    const deaths = z3DeathCount();
    const z3 = await backend();
    await expect(z3.check(SCRIPT, { timeoutMs: 0 })).rejects.toThrow(/finite positive number/);
    expect(z3DeathCount()).toBe(deaths);
  });

  it('reports the largest budget handed to a module while a window was open', async () => {
    const z3 = await backend();
    await z3.check(SCRIPT, { timeoutMs: 90_000 }); // before the window: not seen

    const outer = z3BudgetWatch();
    await z3.check(SCRIPT, { timeoutMs: 30_000 });
    const inner = z3BudgetWatch();
    await z3.check(SCRIPT); // no budget given: it ran under the default
    const optimizeAlone = z3BudgetWatch();
    await z3.optimize(`${SCRIPT}\n(maximize x)`, 'max', { timeoutMs: 20_000 });
    expect(optimizeAlone(), 'an optimisation shows its budget to a window too').toBe(20_000);
    await expect(z3.check(SCRIPT, { timeoutMs: 0 })).rejects.toThrow(/finite positive number/);
    await z3.check(SCRIPT, { timeoutMs: 600_000 });
    expect(inner(), 'the window opened later sees its own calls').toBe(600_000);
    expect(outer(), 'the window opened earlier sees every call after it opened').toBe(600_000);

    const quiet = z3BudgetWatch();
    expect(quiet(), 'a window with no call is 0').toBe(0);
    const dflt = z3BudgetWatch();
    await z3.check(SCRIPT);
    expect(dflt(), 'an unbudgeted check counts as the default').toBe(DEFAULT_TIMEOUT_MS);
    const refused = z3BudgetWatch();
    // Infinity is refused and would beat any window's 0 were it counted; 0 and -1 could not.
    await expect(z3.check(SCRIPT, { timeoutMs: Infinity })).rejects.toThrow(/finite positive number/);
    await expect(z3.optimize(`${SCRIPT}\n(maximize x)`, 'max', { timeoutMs: Infinity })).rejects.toThrow(/finite positive number/);
    expect(refused(), 'a refused budget was never handed to a module').toBe(0);
  });

  it.each<[string, unknown, boolean]>([
    ['a WebAssembly trap', new WebAssembly.RuntimeError('unreachable'), true],
    ['the funcref-table RangeError', new RangeError('WebAssembly.Table.get(): invalid index 3 into funcref table of size 2'), true],
    ['the bare unwind string', 'unwind', true],
    ['the async wrapper’s stuck slot', new Error("you can't execute multiple async functions at the same time"), true],
    ['an abort that rejected the pending call (5.3.1)', new Error('Z3 module aborted: memory access out of bounds'), true],
    ['a stop of the threads that rejected the pending call', new Error('Z3 threads were terminated'), true],
    ['a z3 refusal', new Error('line 3 column 9: unknown constant mtow'), false],
    ['an ordinary sentence that mentions a terminated thread', new Error('the Z3 threads were terminated early by the user'), false],
    ['an ordinary sentence containing "unwind"', new Error('could not unwind the derivation'), false],
    ['a nonlinear refusal', new Error('logic does not support nonlinear arithmetic'), false],
    ['nothing at all', undefined, false],
    ['a number', 42, false],
  ])('isZ3ModuleDeath: %s → %s', (_what, err, expected) => {
    expect(isZ3ModuleDeath(err)).toBe(expected);
  });
});

describe('resetZ3Cache keeps its contract', () => {
  it('forgets without stopping workers by default, and stops them on request', async () => {
    await backend();
    resetZ3Cache();
    expect(fake.terminated, 'a plain reset leaves a backend made earlier working').toBe(0);
    await backend();
    expect(fake.inits).toBe(2);
    resetZ3Cache({ terminate: true });
    expect(fake.terminated).toBe(1);
    resetZ3Cache({ terminate: true });
    expect(fake.terminated, 'nothing cached, nothing to stop').toBe(1);
  });
});

/**
 * The cause of D5, found later: `z3-solver` 5.2 freed every object from a
 * `FinalizationRegistry` whose callbacks ran on the main thread, and the
 * shipped libz3 is single-threaded — a free that landed while a check ran on
 * its worker thread corrupted the heap the check was using. 5.3.1 queues those
 * frees (the real module's soak and the load reproduction are the evidence),
 * but still documents a SYNCHRONOUS z3 call on the main thread under a running
 * check as unsafe: so a check holds its module from `new Solver()` to its last
 * read, and the next one waits.
 */
describe('a check holds its module', () => {
  it('a second check waits for the first: no solver is built while one is in flight', async () => {
    const z3 = await backend();
    const answer = holdChecks();
    const first = z3.check(SCRIPT);
    await until('the first check is on its thread', () => fake.checksStarted === 1);
    const second = z3.optimize(`${SCRIPT}\n(maximize x)`, 'max');
    const third = z3.check(SCRIPT);
    await tick();
    await tick();
    expect(fake.constructed, 'a solver was built under a running check').toBe(1);
    answer('sat');
    expect((await first).status).toBe('sat');
    expect((await second).status).toBe('sat');
    expect((await third).status).toBe('sat');
    expect(fake.constructed).toBe(3);
  });

  it('a death releases nothing into the dead module', async () => {
    const deaths = z3DeathCount();
    const z3 = await backend();
    await z3.check(SCRIPT);
    fake.released = [];
    fake.behaviour.check = () => Promise.reject(new WebAssembly.RuntimeError('memory access out of bounds'));
    await expect(z3.check(SCRIPT)).rejects.toBeInstanceOf(Z3ModuleDeadError);
    expect(z3DeathCount()).toBe(deaths + 1);
    expect(fake.released, 'the dying check’s solver was released into the dead module').toEqual([]);
  });

  it('a `z3-solver` without the fix is refused, with what to install, and its workers are stopped', async () => {
    fake.behaviour.predatesFix = true;
    const z3 = await loadZ3();
    expect(z3.absent).toBe(true);
    if (z3.absent) {
      expect(z3.disabled).toBe(false);
      expect(z3.reason).toContain('npm install z3-solver@^5.3.1');
      expect(z3.reason).toContain('defect D5');
    }
    expect(fake.terminated, 'the refused module’s workers were left running').toBe(1);
    fake.behaviour = {};
    await backend();
    expect(fake.inits, 'a refused module is not cached').toBe(2);
  });

  it('a failed init is an absence naming the cause, and is not cached', async () => {
    fake.behaviour.initFails = true;
    const z3 = await loadZ3();
    expect(z3.absent).toBe(true);
    if (z3.absent) expect(z3.reason).toContain('fake init failed');
    fake.behaviour = {};
    await backend();
    expect(fake.inits).toBe(2);
  });
});

describe('the solver, the optimiser and the model are released between checks', () => {
  it('once per check on the solver and its model, once per optimisation, and on a refusal', async () => {
    const z3 = await backend();
    expect((await z3.check(SCRIPT)).status).toBe('sat');
    expect(fake.released, 'the model is read, then the solver let go').toEqual(['model', 'solver']);

    fake.released = [];
    fake.behaviour.check = () => Promise.resolve('unsat');
    await z3.check(SCRIPT);
    expect(fake.released, 'an unsat check reads no model').toEqual(['solver']);

    fake.released = [];
    fake.behaviour = {};
    await z3.optimize(`${SCRIPT}\n(maximize x)`, 'max');
    expect(fake.released, 'the bound and the witness are read before the optimiser goes').toEqual([
      'model',
      'optimize',
    ]);

    fake.released = [];
    fake.behaviour.fromString = () => {
      throw new Error('line 1 column 5: unknown constant foo');
    };
    expect((await z3.check(SCRIPT)).status).toBe('error');
    expect(fake.released, 'a refused script’s solver is released too').toEqual(['solver']);
  });

  it('a release() that throws changes no outcome', async () => {
    const deaths = z3DeathCount();
    fake.behaviour.release = () => {
      throw new Error('release refused');
    };
    const z3 = await backend();
    const r = await z3.check(SCRIPT);
    expect(r.status).toBe('sat');
    const o = await z3.optimize(`${SCRIPT}\n(maximize x)`, 'max');
    expect(o.status).toBe('sat');
    expect(o.bound?.value).toBe(1);
    expect(fake.released).toEqual(['model', 'solver', 'model', 'optimize']);
    expect(z3DeathCount()).toBe(deaths);
  });

  it('a release() that TRAPS is the module dying, and the next load is fresh', async () => {
    // A free into a corrupted heap is D5 itself. Before the release was
    // explicit it trapped from a finalizer, loudly; swallowed here, the module
    // would stay cached and the next check would run on it.
    const variants: Array<[Kind, 'check' | 'optimize']> = [
      ['solver', 'check'],
      ['model', 'check'],
      ['optimize', 'optimize'],
      ['model', 'optimize'],
    ];
    for (const [kind, call] of variants) {
      const what = `a trap out of the ${kind}'s release() in ${call}()`;
      fake.behaviour = {};
      const deaths = z3DeathCount();
      const terminated = fake.terminated;
      const z3 = await backend();
      const inits = fake.inits;
      await z3.check(SCRIPT);
      const answer = holdChecks();
      const started = fake.checksStarted;
      const p = (call === 'check' ? z3.check(SCRIPT) : z3.optimize(`${SCRIPT}\n(maximize x)`, 'max')).then(
        () => null,
        (err: unknown) => err,
      );
      await until('the check is on its thread', () => fake.checksStarted === started + 1);
      fake.released = [];
      fake.behaviour.release = (k) => {
        if (k === kind) throw new WebAssembly.RuntimeError('memory access out of bounds');
      };
      answer('sat');
      const failure = await p;
      expect(failure, what).toBeInstanceOf(Z3ModuleDeadError);
      expect((failure as Error).message, what).toContain('memory access out of bounds');
      expect(z3DeathCount(), what).toBe(deaths + 1);
      expect(fake.terminated, what).toBe(terminated + 1);
      // The model is released first; once it trapped, the solver is not.
      expect(fake.released, what).toEqual(kind === 'model' ? ['model'] : ['model', kind]);
      fake.behaviour = {};
      await backend();
      expect(fake.inits, `${what}: the module was reused`).toBe(inits + 1);
    }
  });

  it('objects with no release() at all — the fake as it was — answer as before', async () => {
    fake.behaviour.noRelease = true;
    const z3 = await backend();
    expect((await z3.check(SCRIPT)).status).toBe('sat');
    expect((await z3.optimize(`${SCRIPT}\n(maximize x)`, 'max')).status).toBe('sat');
    expect(fake.released).toEqual([]);
  });
});

/**
 * What the bridge does with a call it abandons. Before 5.3.1 `z3-solver` ran
 * every check of every module under ONE process-wide lock and had no way to
 * end a call whose thread was gone, so the bridge gave the lock back by hand
 * and `sysprose` ended itself after a death. Now each module has its own lock
 * and `async_cancel`, the second half of `killThreads`, rejects the pending
 * call and clears its keep-alive timer: the bridge stops the threads and then
 * cancels, and nothing else is needed. The fake rejects the check it holds
 * when `async_cancel` runs, as the real module does.
 */
describe('a module the bridge gives up on has its pending call cancelled', () => {
  it('a terminate with a check in flight cancels it after the threads stop: a death, at once', async () => {
    const deaths = z3DeathCount();
    fake.behaviour.check = () => new Promise<Status>(() => {});
    const z3 = await backend();
    const p = z3.check(SCRIPT, { timeoutMs: 60_000 }).then(
      () => null,
      (err: unknown) => err,
    );
    await until('the check is on its thread', () => fake.checksStarted === 1);
    resetZ3Cache({ terminate: true });
    expect(fake.terminated).toBe(1);
    expect(fake.cancelled.map(String)).toEqual(['Error: Z3 threads were terminated']);
    expect(fake.order, 'the call is cancelled only once the threads running it are stopped').toEqual(['stop', 'cancel']);
    const failure = await p;
    expect(failure, 'the abandoned check printed as an `error` outcome or never settled').toBeInstanceOf(
      Z3ModuleDeadError,
    );
    expect((failure as Error).message).toContain('Z3 threads were terminated');
    expect(z3DeathCount()).toBe(deaths + 1);
    fake.behaviour = {};
    await backend();
    expect(fake.inits, 'the terminated module is not reused').toBe(2);
  });

  it('a death cancels the call it found abandoned, once the threads are stopped', async () => {
    vi.useFakeTimers();
    fake.behaviour.check = () => new Promise<Status>(() => {});
    const z3 = await backend();
    const p = z3.check(SCRIPT, { timeoutMs: 1000 }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(1000 + DEAD_MODULE_MARGIN_MS);
    expect(await p).toBeInstanceOf(Z3ModuleDeadError);
    expect(fake.terminated).toBe(1);
    expect(fake.cancelled).toHaveLength(1);
  });

  it('a plain reset cancels nothing: a backend made earlier still owns its module', async () => {
    const answer = holdChecks();
    const z3 = await backend();
    const p = z3.check(SCRIPT);
    await until('the check is on its thread', () => fake.checksStarted === 1);
    resetZ3Cache();
    expect(fake.cancelled).toEqual([]);
    answer('sat');
    expect((await p).status).toBe('sat');
  });

  it('a module that refuses to be cancelled is still discarded', async () => {
    fake.behaviour.cancelThrows = true;
    fake.behaviour.check = () => Promise.reject(new WebAssembly.RuntimeError('memory access out of bounds'));
    const z3 = await backend();
    await expect(z3.check(SCRIPT)).rejects.toBeInstanceOf(Z3ModuleDeadError);
    expect(fake.terminated).toBe(1);
    fake.behaviour = {};
    await backend();
    expect(fake.inits).toBe(2);
  });

  it('a stop of the threads that throws does not skip the cancel: the keep-alive timer is cleared', async () => {
    fake.behaviour.stopThrows = true;
    fake.behaviour.check = () => Promise.reject(new WebAssembly.RuntimeError('memory access out of bounds'));
    const z3 = await backend();
    await expect(z3.check(SCRIPT)).rejects.toBeInstanceOf(Z3ModuleDeadError);
    expect(fake.terminated).toBe(1);
    expect(fake.cancelled).toHaveLength(1);
  });
});

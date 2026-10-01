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
import { createRequire } from 'node:module';
import {
  DEAD_MODULE_MARGIN_MS,
  Z3ModuleDeadError,
  isZ3ModuleDeath,
  loadZ3,
  resetZ3Cache,
  z3DeathCount,
  z3DeferredFinalizerCount,
} from '@semantics/smt/z3-bridge';

type Status = 'sat' | 'unsat' | 'unknown';

/** The slice of `async-mutex`'s `Mutex` the fake and the cases use. */
interface Mutex {
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T>;
  isLocked(): boolean;
}

/**
 * `async-mutex`'s `Mutex`, from the copy `z3-solver` itself loads — the one the
 * bridge watches — or `undefined` on a clone without the optional dependency.
 */
const MutexClass = ((): (new () => Mutex) | undefined => {
  try {
    const z3Main = createRequire(import.meta.url).resolve('z3-solver');
    return (createRequire(z3Main)('async-mutex') as { Mutex: new () => Mutex }).Mutex;
  } catch {
    return undefined;
  }
})();

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
  /** Make `init()` reject after it built its registry, as a broken install would. */
  initFails?: boolean;
  /** Make every finalizer callback trap, as a free into a corrupted heap does. */
  freeTraps?: boolean;
}

/** The fake module's counters, read by the cases below. */
const fake = {
  behaviour: {} as Behaviour,
  inits: 0,
  terminated: 0,
  /** Solvers and optimisers built, checks started on them, and checks that got the lock. */
  constructed: 0,
  checksStarted: 0,
  checksRun: 0,
  /**
   * The fake's PROCESS-WIDE lock, as `z3-solver`'s: one for every module of a
   * case, taken around every check (high-level.js keeps one `asyncMutex` at
   * module scope). `undefined` where `async-mutex` is not installed.
   */
  mutex: undefined as Mutex | undefined,
  /** Every `release()`, by kind, in call order. */
  released: [] as Kind[],
  /** What each `release()` got back from `unregister` — false is a finalizer still armed. */
  unregistered: [] as boolean[],
  /** The finalizer callbacks that reached the fake z3, by the id of the object freed. */
  freed: [] as number[],
  /** The callback `z3-solver` registered for each solver and optimiser, by id. */
  held: [] as Array<() => void>,
  /** Strong references, so a real collection cannot fire a callback mid-case. */
  objects: [] as object[],
  /** The registry `init()` built, and the constructor it found on `globalThis`. */
  registry: undefined as unknown,
  registryCtorInInit: undefined as unknown,
};

vi.mock('z3-solver', () => ({
  init: async () => {
    fake.inits += 1;
    // `z3-solver` builds its one registry here, in `createApi`, with this
    // callback: the held value is a closure that calls `*_dec_ref`.
    fake.registryCtorInInit = globalThis.FinalizationRegistry;
    const registry = new FinalizationRegistry<() => void>((held) => held());
    fake.registry = registry;
    if (fake.behaviour.initFails) throw new Error('fake init failed after building its registry');
    const freed = fake.freed;
    const releasable = <O extends object>(kind: Kind, o: O): O =>
      fake.behaviour.noRelease
        ? o
        : Object.assign(o, {
            release() {
              fake.released.push(kind);
              if (kind !== 'model') fake.unregistered.push(registry.unregister(o));
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
          const run = () => {
            fake.checksRun += 1;
            return fake.behaviour.check ? fake.behaviour.check() : Promise.resolve<Status>('sat');
          };
          return fake.mutex ? fake.mutex.runExclusive(run) : run();
        },
        model,
        unsatCore: () => [],
        reasonUnknown: () => 'unknown',
        getUpperAsVector: () => ['0', '1', '0'],
        getLowerAsVector: () => ['0', '1', '0'],
        getUpper: () => ({ toString: () => '1' }),
        getLower: () => ({ toString: () => '1' }),
      });
      const id = fake.held.length;
      const held = () => {
        if (fake.behaviour.freeTraps) throw new WebAssembly.RuntimeError('memory access out of bounds');
        freed.push(id);
      };
      fake.held.push(held);
      fake.objects.push(o);
      registry.register(o, held, o);
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
          },
        },
      },
    };
  },
}));

const SCRIPT = '(declare-const x Real)\n(assert (> x 1.0))\n(check-sat)';

/** The registry constructor before any load swapped it — what every load must leave behind. */
const ORIGINAL_FR = globalThis.FinalizationRegistry;

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

/**
 * Deliver a finalizer callback as V8 would, through the registry `z3-solver`
 * built — which must be the bridge's deferring subclass, or nothing gates it.
 */
function fire(held: () => void): void {
  const registry = fake.registry as { fire?: (h: () => void) => void } | undefined;
  if (typeof registry?.fire !== 'function') {
    throw new Error('z3-solver’s registry is not the bridge’s deferring one: nothing gates its callbacks');
  }
  registry.fire(held);
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
  fake.checksRun = 0;
  fake.mutex = MutexClass ? new MutexClass() : undefined;
  fake.released = [];
  fake.unregistered = [];
  fake.freed = [];
  fake.held = [];
  fake.objects = [];
  fake.registry = undefined;
  fake.registryCtorInInit = undefined;
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
    // … but the old backend is still bound to the module it was made on, and
    // the async wrapper's stuck slot is what it meets there.
    fake.behaviour.check = () =>
      Promise.reject(
        new Error("you can't execute multiple async functions at the same time; let the previous one finish first"),
      );
    await expect(old.check(SCRIPT)).rejects.toBeInstanceOf(Z3ModuleDeadError);
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

  it.each<[string, unknown, boolean]>([
    ['a WebAssembly trap', new WebAssembly.RuntimeError('unreachable'), true],
    ['the funcref-table RangeError', new RangeError('WebAssembly.Table.get(): invalid index 3 into funcref table of size 2'), true],
    ['the bare unwind string', 'unwind', true],
    ['the async wrapper’s stuck slot', new Error("you can't execute multiple async functions at the same time"), true],
    ['a z3 refusal', new Error('line 3 column 9: unknown constant mtow'), false],
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
 * The cause of D5, found later: `z3-solver` frees every object from a
 * `FinalizationRegistry` whose callbacks run on the main thread, and the
 * shipped libz3 is single-threaded — a free that lands while a check runs on
 * its worker thread corrupts the heap the check is using. The bridge builds
 * that registry through a subclass that holds a callback back while its module
 * has a check in flight. The fake's `init()` builds its registry exactly where
 * `z3-solver`'s does, and `fire` delivers a callback the way V8 would.
 */
describe('finalizers never run under a check', () => {
  it('z3-solver’s registry is built through the bridge’s subclass, and the global is restored', async () => {
    await backend();
    expect(fake.registryCtorInInit, 'the registry was built with the plain constructor').not.toBe(ORIGINAL_FR);
    expect(fake.registry).toBeInstanceOf(ORIGINAL_FR);
    expect(globalThis.FinalizationRegistry, 'the subclass was left on globalThis').toBe(ORIGINAL_FR);
  });

  it('the global is restored when init() rejects, and the absence names the cause', async () => {
    fake.behaviour.initFails = true;
    const z3 = await loadZ3();
    expect(z3.absent).toBe(true);
    if (z3.absent) expect(z3.reason).toContain('fake init failed');
    expect(fake.registryCtorInInit).not.toBe(ORIGINAL_FR);
    expect(globalThis.FinalizationRegistry).toBe(ORIGINAL_FR);
    fake.behaviour = {};
    await backend();
    expect(fake.inits, 'a failed init is not cached').toBe(2);
  });

  it('two loads at once initialise one module, and leave the global as it was', async () => {
    const [a, b] = await Promise.all([loadZ3(), loadZ3()]);
    expect(a.absent || b.absent).toBe(false);
    expect(fake.inits).toBe(1);
    expect(globalThis.FinalizationRegistry).toBe(ORIGINAL_FR);
  });

  it('a callback that arrives during a check reaches z3 only after the check settles', async () => {
    const z3 = await backend();
    expect((await z3.check(SCRIPT)).status).toBe('sat');
    const before = z3DeferredFinalizerCount();
    const answer = holdChecks();
    const p = z3.check(SCRIPT);
    await until('the second check is on its thread', () => fake.checksStarted === 2);
    fire(fake.held[0]);
    expect(fake.freed, 'a dec_ref ran on the main thread under a running check').toEqual([]);
    expect(z3DeferredFinalizerCount()).toBe(before + 1);
    answer('unsat');
    expect((await p).status).toBe('unsat');
    expect(fake.freed, 'the held callback ran once the check settled').toEqual([0]);
  });

  it('a callback that arrives with nothing in flight runs at once', async () => {
    const z3 = await backend();
    await z3.check(SCRIPT);
    const before = z3DeferredFinalizerCount();
    fire(fake.held[0]);
    expect(fake.freed).toEqual([0]);
    expect(z3DeferredFinalizerCount()).toBe(before);
  });

  it('the optimiser holds its module the same way', async () => {
    const z3 = await backend();
    await z3.check(SCRIPT);
    const answer = holdChecks();
    const p = z3.optimize(`${SCRIPT}\n(maximize x)`, 'max');
    await until('the optimisation is on its thread', () => fake.checksStarted === 2);
    fire(fake.held[0]);
    expect(fake.freed).toEqual([]);
    answer('sat');
    expect((await p).bound?.value).toBe(1);
    expect(fake.freed).toEqual([0]);
  });

  it('a death drops what was held: nothing is freed or released into the dead module', async () => {
    // The flush must not run on this path: the queued frees would land in a
    // heap the trap just showed to be corrupt — how three investigation runs
    // died on the main thread, inside z3's own context destructor.
    const deaths = z3DeathCount();
    const z3 = await backend();
    await z3.check(SCRIPT);
    fake.released = [];
    let trap!: (err: unknown) => void;
    fake.behaviour.check = () =>
      new Promise<Status>((_, reject) => {
        trap = reject;
      });
    const p = z3.check(SCRIPT).then(
      () => null,
      (err: unknown) => err,
    );
    await until('the check is on its thread', () => fake.checksStarted === 2);
    fire(fake.held[0]);
    trap(new WebAssembly.RuntimeError('memory access out of bounds'));
    expect(await p).toBeInstanceOf(Z3ModuleDeadError);
    expect(z3DeathCount()).toBe(deaths + 1);
    expect(fake.freed, 'a held dec_ref ran into the dead module').toEqual([]);
    expect(fake.released, 'the dying check’s solver was released into the dead module').toEqual([]);
    fire(fake.held[1]);
    expect(fake.freed, 'a later callback for the dead module ran').toEqual([]);
  });

  it('a held callback that traps when it runs is the module dying, and is reported as one', async () => {
    const deaths = z3DeathCount();
    const z3 = await backend();
    await z3.check(SCRIPT);
    const answer = holdChecks();
    const p = z3.check(SCRIPT).then(
      () => null,
      (err: unknown) => err,
    );
    await until('the check is on its thread', () => fake.checksStarted === 2);
    fire(fake.held[0]);
    fake.behaviour.freeTraps = true;
    answer('sat');
    const failure = await p;
    expect(failure).toBeInstanceOf(Z3ModuleDeadError);
    expect((failure as Error).message).toContain('memory access out of bounds');
    expect(z3DeathCount()).toBe(deaths + 1);
    expect(fake.terminated).toBe(1);
    fake.behaviour = {};
    await backend();
    expect(fake.inits, 'the module whose free trapped is not reused').toBe(2);
  });

  it('a plain reset keeps a module’s held callbacks and runs them; `terminate: true` drops them', async () => {
    // Plain: a backend made earlier keeps working on the old module, so its
    // frees must still happen — held until its check settles, as ever.
    let z3 = await backend();
    await z3.check(SCRIPT);
    let answer = holdChecks();
    let p = z3.check(SCRIPT);
    await until('the check is on its thread', () => fake.checksStarted === 2);
    fire(fake.held[0]);
    resetZ3Cache();
    answer('sat');
    expect((await p).status).toBe('sat');
    expect(fake.freed).toEqual([0]);

    // Terminate: the module goes, and what it held goes with it, unrun.
    fake.behaviour = {};
    z3 = await backend();
    await z3.check(SCRIPT);
    answer = holdChecks();
    p = z3.check(SCRIPT);
    await until('the check is on its thread', () => fake.checksStarted === 4);
    fire(fake.held[2]);
    resetZ3Cache({ terminate: true });
    answer('sat');
    await p;
    fire(fake.held[3]);
    expect(fake.freed, 'a terminated module’s callbacks ran').toEqual([0]);
  });

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
    // `release()` unregisters through the subclass, so no finalizer stays armed for a freed object.
    expect(fake.unregistered).toEqual([true, true, true, true]);
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

  it('a release() that TRAPS is the module dying: nothing held runs into it, and the next load is fresh', async () => {
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
      const earlier = fake.held[fake.held.length - 1];
      const answer = holdChecks();
      const started = fake.checksStarted;
      const p = (call === 'check' ? z3.check(SCRIPT) : z3.optimize(`${SCRIPT}\n(maximize x)`, 'max')).then(
        () => null,
        (err: unknown) => err,
      );
      await until('the check is on its thread', () => fake.checksStarted === started + 1);
      fire(earlier);
      const freed = [...fake.freed];
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
      expect(fake.freed, `${what}: a held dec_ref ran into the dead module`).toEqual(freed);
      // The model is released first; once it trapped, the solver is not.
      expect(fake.released, what).toEqual(kind === 'model' ? ['model'] : ['model', kind]);
      fire(fake.held[fake.held.length - 1]);
      expect(fake.freed, `${what}: a later callback ran into the dead module`).toEqual(freed);
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
 * `z3-solver` runs every `check()` of every module under ONE module-level async
 * mutex. A check abandoned on a module that is gone never settles, so it would
 * hold that lock for good and the fresh module's first check would wait on it
 * into its own budget plus the margin — a second, false death. The bridge gives
 * the lock back when it discards a module whose check holds it, and only then.
 * The fake takes its own process-wide `async-mutex` lock around each check,
 * exactly as `z3-solver` does, and the bridge's watch records it.
 */
describe('z3-solver’s process-wide lock is given back by a module that will never answer', () => {
  /** The fake's lock, or a skip where `async-mutex` is not installed. */
  function lock(ctx: { skip: () => void }): Mutex {
    if (!fake.mutex) {
      ctx.skip();
      throw new Error('unreachable');
    }
    return fake.mutex;
  }

  it('a terminate with a check in flight releases it, and a fresh module answers at once', async (ctx) => {
    const mutex = lock(ctx);
    const deaths = z3DeathCount();
    const old = await backend();
    const answerOld = holdChecks();
    const orphan = old.check(SCRIPT).then(
      (r) => r.status,
      (err: unknown) => err,
    );
    await until('the old module’s check holds the lock', () => fake.checksRun === 1 && mutex.isLocked());
    resetZ3Cache({ terminate: true });
    expect(mutex.isLocked(), 'the terminated module’s check still holds the process-wide lock').toBe(false);

    // The fresh module's check gets the lock at once, and the orphan answering
    // later must not take it away from that check: its releaser works once.
    const answerFresh = holdChecks();
    const fresh = (await backend()).check(SCRIPT);
    await until('the fresh module’s check got the lock', () => fake.checksRun === 2);
    answerOld('sat');
    await tick();
    expect(mutex.isLocked(), 'the orphan’s late release freed the fresh check’s lock').toBe(true);
    answerFresh('unsat');
    expect((await fresh).status).toBe('unsat');
    expect(mutex.isLocked()).toBe(false);
    expect(z3DeathCount()).toBe(deaths);
    void orphan;
  });

  it('a hang-shaped death releases it, and the fresh module answers rather than dying too', async (ctx) => {
    const mutex = lock(ctx);
    vi.useFakeTimers();
    const deaths = z3DeathCount();
    fake.behaviour.check = () => new Promise<Status>(() => {});
    const z3 = await backend();
    const p = z3.check(SCRIPT, { timeoutMs: 1000 }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mutex.isLocked()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000 + DEAD_MODULE_MARGIN_MS);
    expect(await p).toBeInstanceOf(Z3ModuleDeadError);
    expect(z3DeathCount()).toBe(deaths + 1);
    expect(mutex.isLocked(), 'the dead module’s check still holds the process-wide lock').toBe(false);
    fake.behaviour = {};
    const r = (await backend()).check(SCRIPT, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect((await r).status).toBe('sat');
    expect(z3DeathCount(), 'the fresh module was counted dead behind the old lock').toBe(deaths + 1);
  });

  it('a plain reset keeps it: the earlier backend’s check still owns the lock and finishes', async (ctx) => {
    const mutex = lock(ctx);
    const old = await backend();
    const answer = holdChecks();
    const first = old.check(SCRIPT);
    await until('the check holds the lock', () => fake.checksRun === 1);
    resetZ3Cache();
    expect(mutex.isLocked(), 'a plain reset released a lock a working module holds').toBe(true);
    const second = (await backend()).check(SCRIPT);
    await until('the fresh module’s check is waiting', () => fake.checksStarted === 2);
    expect(fake.checksRun, 'the fresh check ran beside the old one').toBe(1);
    answer('sat');
    expect((await first).status).toBe('sat');
    expect((await second).status).toBe('sat');
    expect(fake.checksRun).toBe(2);
  });

  it('a check still waiting for the lock when its module is discarded never runs, and passes the lock on', async (ctx) => {
    const mutex = lock(ctx);
    const deaths = z3DeathCount();
    const old = await backend();
    resetZ3Cache();
    const waiting = await backend();
    const answer = holdChecks();
    const first = old.check(SCRIPT);
    await until('the old module’s check holds the lock', () => fake.checksRun === 1);
    const second = waiting.check(SCRIPT).then(
      () => null,
      (err: unknown) => err,
    );
    await until('the second check is queued on the lock', () => fake.checksStarted === 2);
    resetZ3Cache({ terminate: true }); // the module whose check holds nothing yet
    expect(mutex.isLocked(), 'a module released a lock its check did not hold').toBe(true);
    answer('sat');
    expect((await first).status).toBe('sat');
    const failure = await second;
    expect(failure).toBeInstanceOf(Z3ModuleDeadError);
    expect((failure as Error).message).toContain('discarded while its check waited');
    expect(fake.checksRun, 'a check ran on a terminated module').toBe(1);
    expect(mutex.isLocked(), 'the discarded module’s check took the lock and kept it').toBe(false);
    expect(z3DeathCount()).toBe(deaths + 1);
  });

  it('a terminate with nothing in flight releases nothing, even while ANOTHER module holds the lock', async (ctx) => {
    const mutex = lock(ctx);
    const old = await backend();
    resetZ3Cache();
    // The fresh module checks first, so it too has seen the lock — and then sits idle.
    expect((await (await backend()).check(SCRIPT)).status).toBe('sat');
    const answer = holdChecks();
    const first = old.check(SCRIPT);
    await until('the old module’s check holds the lock', () => fake.checksRun === 2);
    resetZ3Cache({ terminate: true }); // the idle fresh module, not the one checking
    expect(mutex.isLocked(), 'an idle module released a lock another module’s check holds').toBe(true);
    answer('sat');
    expect((await first).status).toBe('sat');
    expect(mutex.isLocked()).toBe(false);
  });
});

/**
 * `sysprose`'s own ending after a death. The abandoned call leaves a ref'd
 * 600 s keep-alive in `z3-built.js` that nothing will clear, so a run with a
 * death ends itself once its output has drained — and a run without one is
 * left to end the ordinary way. Run on fresh module instances, so the
 * process-wide death counter starts at zero and the death is a real one,
 * counted by the same bridge `scripts/sysprose.ts` imports.
 */
describe('the `sysprose` command ends itself after a death, and only then', () => {
  it('ends with the command’s own code once stdout and stderr drain; a run with no death is left alone', async () => {
    vi.resetModules();
    const bridge = await import('@semantics/smt/z3-bridge');
    const { lingersAfterZ3Death } = await import('../../scripts/sysprose');
    const { runMain } = await import('../../scripts/lib/exit');
    // What had been written out by the time the process was ended, per exit.
    let drained = false;
    const drainedAtExit: boolean[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      drainedAtExit.push(drained);
    }) as never);
    const listeners = process.stdout.listeners('error');
    const exitCode = process.exitCode;
    try {
      expect(bridge.z3DeathCount()).toBe(0);
      expect(lingersAfterZ3Death(), 'a run with no death ends itself').toBe(false);
      runMain('sysprose', async () => 0, { lingers: lingersAfterZ3Death });
      await until('the command returned', () => process.exitCode === 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(exit, 'a run with no death was ended early').not.toHaveBeenCalled();

      fake.behaviour.check = () => Promise.reject(new WebAssembly.RuntimeError('memory access out of bounds'));
      const z3 = await bridge.loadZ3();
      if (z3.absent) throw new Error(z3.reason);
      await expect(z3.check(SCRIPT)).rejects.toBeInstanceOf(bridge.Z3ModuleDeadError);
      expect(bridge.z3DeathCount()).toBe(1);
      expect(lingersAfterZ3Death(), 'a run with a death is left to the keep-alive').toBe(true);

      const write = process.stderr.write.bind(process.stderr);
      runMain('sysprose', async () => {
        // The report's last line, written while the command is still running.
        write('', () => {
          drained = true;
        });
        return 2;
      }, { lingers: lingersAfterZ3Death });
      await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
      expect(drainedAtExit, 'the process ended before its output was out').toEqual([true]);
      expect(exit, 'the exit overrode the command’s code').toHaveBeenCalledWith();
      expect(process.exitCode).toBe(2);
    } finally {
      for (const l of process.stdout.listeners('error')) {
        if (!listeners.includes(l)) process.stdout.removeListener('error', l as (err: Error) => void);
      }
      process.exitCode = exitCode;
      exit.mockRestore();
    }
  });
});

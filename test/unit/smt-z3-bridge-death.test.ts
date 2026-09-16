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
  Z3ModuleDeadError,
  isZ3ModuleDeath,
  loadZ3,
  resetZ3Cache,
  z3DeathCount,
} from '@semantics/smt/z3-bridge';

type Status = 'sat' | 'unsat' | 'unknown';

/** What the fake solver does on each call; every hook is optional. */
interface Behaviour {
  construct?: () => void;
  set?: () => void;
  fromString?: (script: string) => void;
  check?: () => Promise<Status>;
}

/** The fake module's counters, read by the cases below. */
const fake = { behaviour: {} as Behaviour, inits: 0, terminated: 0 };

vi.mock('z3-solver', () => ({
  init: async () => {
    fake.inits += 1;
    const solver = () => ({
      set() {
        fake.behaviour.set?.();
      },
      fromString(script: string) {
        fake.behaviour.fromString?.(script);
      },
      check(): Promise<Status> {
        return fake.behaviour.check ? fake.behaviour.check() : Promise.resolve('sat');
      },
      model() {
        return { *[Symbol.iterator]() {}, get: () => ({ toString: () => '' }) };
      },
      unsatCore: () => [],
      reasonUnknown: () => 'unknown',
      getUpperAsVector: () => ['0', '1', '0'],
      getLowerAsVector: () => ['0', '1', '0'],
      getUpper: () => ({ toString: () => '1' }),
      getLower: () => ({ toString: () => '1' }),
    });
    class Solver {
      constructor() {
        fake.behaviour.construct?.();
        return solver();
      }
    }
    return {
      getVersionString: () => '0.0.0-fake',
      getFullVersion: () => 'Z3 0.0.0-fake',
      setParam: () => {},
      Context: () => ({ Solver, Optimize: Solver }),
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

/** Load, and refuse to go on if the fake was not what answered. */
async function backend() {
  const z3 = await loadZ3();
  expect(z3.absent, z3.absent ? z3.reason : '').toBe(false);
  if (z3.absent) throw new Error('unreachable');
  expect(z3.version).toBe('0.0.0-fake');
  return z3;
}

let envBefore: string | undefined;
beforeEach(() => {
  envBefore = process.env.SYSPROSE_NO_Z3;
  delete process.env.SYSPROSE_NO_Z3;
  fake.behaviour = {};
  fake.inits = 0;
  fake.terminated = 0;
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

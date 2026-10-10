/**
 * checks-runner — what happens when a person clicks Run on a palette check.
 *
 * Most checks answer in a few milliseconds and are run on the spot. The two that
 * walk a state machine (`CheckSpec.offThread`) are not guaranteed to: the walk
 * is bounded by configurations, not by time, and a machine of two dozen states
 * with several composites among them takes seconds' worth of the page. Those go
 * to a worker (`../checks-worker.ts`), so the page stays usable, with the three
 * things a wait asks for:
 *  - a busy state: the check is `running` in the store from the click until it
 *    settles, and the palette says so;
 *  - cancellation: a synchronous walk cannot be interrupted, so Cancel ends the
 *    worker — the run ends, and the next one starts a new worker (which loads
 *    the library again; the price of an ended walk);
 *  - no stale result: a run is recorded against the model revision and the
 *    selection of the click, so an edit made while it ran shows it `stale`,
 *    exactly as one made after it; and a run that was cancelled finds its token
 *    gone and lands nothing.
 *
 * ONE WORKER, ONE RUN AT A TIME. Each worker holds a copy of the standard library
 * (38,000 elements), so two would cost twice that for nothing a person can see:
 * a second check started while one runs waits its turn, `running` like the
 * first. A worker nobody has used for a minute is ended, and its memory with it.
 *
 * A WORKER IS NOT STARTED FOR AN ANSWER THAT NEEDS NO WALK. Starting one costs a
 * quarter of a second and a second copy of the library; a model with no state
 * machine is told so on the spot ({@link hasStateMachine}).
 *
 * AN ANSWER NO WORKER GIVES IS NOT LOST. A page with no workers (and every unit
 * test), a worker that fails to start or dies, a reply that says it could not
 * run, a worker that says nothing for a minute ({@link WATCHDOG_MS}): each ends
 * in the check running here, on the page's thread, which is what every check
 * did before. The answer is the same function's either way
 * (`../checks-offthread.ts`), so the fallback costs time and nothing else — the
 * time being the page held for the walk, which the row's "stays usable" is not
 * true of while it lasts.
 */

import { hasStateMachine, runCheck, selectionKey, type CheckContext, type CheckResult, type CheckSpec } from '../checks';
import { libraryKey, NO_REQUEST, userPart, type CheckReply, type CheckRequest } from '../checks-offthread';
import { useChecksStore, type RanIn } from './checks-store';

/** The part of a Worker this module uses, so a test can stand one in. */
export interface CheckWorker {
  postMessage(message: CheckRequest): void;
  terminate(): void;
  onmessage: ((event: { data: CheckReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
}

export type CheckWorkerFactory = () => CheckWorker;

/** How long an idle worker is kept: long enough for a second look, short enough to give back its memory. */
export const IDLE_MS = 60_000;

/**
 * How long a run may go without a reply before the page runs the check itself. A
 * walk is bounded by configurations (the longest measured, `docs/TEST-REPORT.md`
 * §2.15, took a second), so this is for a worker that has stopped answering — a
 * library download that stalls, a process killed without an `error` — and
 * nothing a walk reaches. Without it the row would say `running…` for good, and
 * every walk queued behind it would wait too.
 */
export const WATCHDOG_MS = 60_000;

/** The browser's worker, or null where the page has none. */
function browserFactory(): CheckWorkerFactory | null {
  if (typeof Worker === 'undefined') return null;
  return () => new Worker(new URL('../checks-worker.ts', import.meta.url), { type: 'module' }) as unknown as CheckWorker;
}

let override: CheckWorkerFactory | null | undefined;

/**
 * Stand in a worker for tests: a factory, `null` for a page with none, or
 * `undefined` to go back to the browser's.
 */
export function setCheckWorkerFactory(factory: CheckWorkerFactory | null | undefined): void {
  override = factory;
}

const factory = (): CheckWorkerFactory | null => (override === undefined ? browserFactory() : override);

interface Job {
  /** Identifies the run: the store holds the same token while it is wanted. */
  token: number;
  spec: CheckSpec;
  ctx: CheckContext;
  /** `useAppStore.rev` at the click. */
  rev: number;
  /** What of the selection the check reads, at the click. */
  selection: string | undefined;
}

let nextToken = 1;
const queue: Job[] = [];
let active: Job | null = null;
let worker: CheckWorker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;

function stopWatchdog(): void {
  if (watchdog !== null) clearTimeout(watchdog);
  watchdog = null;
}

function endWorker(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  stopWatchdog();
  const w = worker;
  worker = null;
  if (w === null) return;
  w.onmessage = null;
  w.onerror = null;
  w.onmessageerror = null;
  w.terminate();
}

function armIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = worker === null ? null : setTimeout(() => (active === null && queue.length === 0 ? endWorker() : undefined), IDLE_MS);
}

/** The run is over with a result, recorded as worked out `ranIn` there, and the next one starts. */
function settle(job: Job, result: CheckResult, ranIn: RanIn): void {
  if (active === job) active = null;
  stopWatchdog();
  const store = useChecksStore.getState();
  // Wanted still? A Cancel, or a run begun since, took the token away.
  if (store.running[job.spec.id]?.token === job.token) store.land(job.spec.id, result, job.rev, ranIn, job.selection);
  armIdle();
  pump();
}

/**
 * The worker cannot give this run an answer: give it here. `runCheck` reports a
 * failure of the check as a result, so this has an answer to record either way.
 */
function runHere(job: Job): void {
  endWorker();
  settle(job, runCheck(job.spec, job.ctx), 'page');
}

function onReply(from: CheckWorker, reply: CheckReply): void {
  // A reply that cannot name its request (`NO_REQUEST`) can only be for the one being waited for.
  if (from !== worker || active === null || (reply.id !== active.token && reply.id !== NO_REQUEST)) return;
  if (reply.ok) settle(active, reply.result, 'worker');
  else runHere(active);
}

function pump(): void {
  if (active !== null || queue.length === 0) return;
  const job = queue.shift() as Job;
  active = job;
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  try {
    if (worker === null) {
      const make = factory();
      if (make === null) throw new Error('no worker on this page');
      const w = make();
      w.onmessage = (event) => onReply(w, event.data);
      w.onerror = () => {
        if (w === worker && active !== null) runHere(active);
      };
      w.onmessageerror = w.onerror;
      worker = w;
    }
    const { ctx } = job;
    worker.postMessage({
      id: job.token,
      check: job.spec.id,
      model: userPart(ctx.model),
      library: libraryKey(ctx.model),
      selectionId: ctx.selectionId,
      selectionName: ctx.selectionName,
      isolated: ctx.isolated,
      fileName: ctx.fileName,
    });
    stopWatchdog();
    watchdog = setTimeout(() => (active === job ? runHere(job) : undefined), WATCHDOG_MS);
  } catch {
    runHere(job);
  }
}

/**
 * Run a check for the palette and record what it says. A check that is
 * {@link CheckSpec.offThread} goes to the worker where the page has one and there
 * is a state machine to walk, and is `running` until it settles; every other
 * check runs here, now. Starting a check that is already running does nothing.
 */
export function runChecked(spec: CheckSpec, ctx: CheckContext, rev: number): void {
  const store = useChecksStore.getState();
  const selection = selectionKey(spec, ctx);
  if (spec.offThread !== true || factory() === null || !hasStateMachine(ctx.model)) {
    store.record(spec.id, runCheck(spec, ctx), rev, selection);
    return;
  }
  if (store.running[spec.id] !== undefined) return;
  const job: Job = { token: nextToken++, spec, ctx, rev, selection };
  store.begin(spec.id, job.token, rev);
  queue.push(job);
  pump();
}

/**
 * Stop a running check. One waiting its turn leaves the queue; one in the worker
 * ends the worker, since a walk cannot be asked to stop. The check keeps the
 * result it had before — a cancelled run decided nothing, and says nothing.
 */
export function cancelChecked(id: string): void {
  const store = useChecksStore.getState();
  if (store.running[id] === undefined) return;
  store.stop(id);
  const waiting = queue.findIndex((j) => j.spec.id === id);
  if (waiting >= 0) queue.splice(waiting, 1);
  if (active !== null && active.spec.id === id) {
    active = null;
    endWorker();
    pump();
  }
}

/** Forget every run and end the worker — for tests, between cases. */
export function resetCheckRunner(): void {
  queue.length = 0;
  active = null;
  endWorker();
  useChecksStore.setState({ running: {} });
}

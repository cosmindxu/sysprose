/**
 * checks-runner — what happens when a person clicks Run on a palette check.
 *
 * Most checks answer in a few milliseconds and are run on the spot. The two that
 * walk a state machine (`CheckSpec.offThread`) are not guaranteed to: the walk
 * is bounded by configurations, not by time, and a machine of two dozen states
 * with several composites among them takes up to about a second of the page. Those go
 * to a worker (`../checks-worker.ts`), so the page stays usable, with the three
 * things a wait asks for:
 *  - a busy state: the check is `running` in the store from the click until it
 *    settles, and the palette says so;
 *  - cancellation: a synchronous walk cannot be interrupted, so Cancel ends the
 *    worker — the run ends, and the next one starts a new worker (which loads
 *    the library again; the price of an ended walk);
 *  - no stale result: a run is recorded against the model revision and the
 *    selection it started from (the click's; the revision is read a frame later
 *    for a run begun before it reads the page, below), so an edit made while it
 *    ran shows it `stale`, exactly as one made after it; and a run that was
 *    cancelled finds its token gone and lands nothing.
 *
 * ONE WORKER, ONE RUN AT A TIME. Each worker holds a copy of the standard library
 * (38,000 elements), so two would cost twice that for nothing a person can see:
 * a second check started while one runs waits its turn, `running` like the
 * first. A worker nobody has used for a minute is ended, and its memory with it.
 *
 * A WORKER IS NOT STARTED FOR AN ANSWER THAT NEEDS NO WALK. Starting one costs a
 * quarter of a second and a second copy of the library; a model with no state
 * machine is told so on the spot ({@link hasStateMachine}) — once its load is
 * known (below): a text no parse has measured is the one thing such a model
 * still sends a worker.
 *
 * A SOLVER CHECK RUNS IN THE PAGE, NOT THE WORKER. On an isolated page (the local
 * servers', `vite.config.ts`) `verify`, `consistency`, `refine`, `bounds` and
 * `fault-tree` run through `z3-bridge` ({@link runSolverCheck}): z3's own check
 * runs on its threads, so the page stays usable while it checks (the encoding
 * before it runs on the page's thread, and has not been measured on a model the
 * size of the drone swarm's), and the row is `running` from the click like a
 * walk, with Cancel. z3 cannot be asked to stop, so Cancel drops the answer and
 * not the check, which ends at its own time budget; a walk queued behind it does
 * not wait on it. On a page that is not isolated the check is answered at once as
 * `not here`.
 *
 * AN ANSWER NO WORKER GIVES IS NOT LOST. A page with no workers (and every unit
 * test), a worker that fails to start or dies, a reply that says it could not
 * run, a worker that says nothing for a minute ({@link WATCHDOG_MS}): each ends
 * in the check running here, on the page's thread, which is what every check
 * did before. The answer is the same function's either way
 * (`../checks-offthread.ts`), so the fallback costs time and nothing else — the
 * time being the page held for the walk, which the row's "stays usable" is not
 * true of while it lasts.
 *
 * A LIBRARY THE WORKER DECLINED IS NOT ASKED ABOUT TWICE. A worker that says the
 * page's library is not its own (`libraryMismatch`) will say so again for every
 * run against that library, so the runs after the first go straight to the page
 * and start no worker: each would pay for a start, a load and a reply, then the
 * walk. The page's library changing (it finishes loading, a project from another
 * build is opened) lifts it. A worker that could not LOAD the library at all
 * (offline, the data not cached: `libraryUnavailable`) is remembered for the
 * session the same way, for every library, since the next worker would fail as
 * it did: later runs go to the page at once, and a load still to measure is taken
 * as not checked (review 2026-10-14 D-11).
 *
 * THE LOAD FIRST, IN THE WORKER. The two walks are judged over the load health:
 * whether each text a file of the model can hold loads cleanly, which only a parse
 * can say (`loadHealthNow`, `../store.ts`). A text no parse has measured yet — one
 * the serializer wrote, after an edit or of a file just opened (its Export text is
 * seldom the file's) — goes to the worker first, and the run is
 * `checking the load…` until the counts come back; then the check runs, in the
 * worker or here as above, judged over them. The page is not held for the parse. A
 * check never runs ahead of its load: it waits, because a verdict over a load
 * nobody has checked could only be `undecided`. Where the worker cannot measure
 * the texts — it fails, stops, cannot load the library or says nothing for a
 * minute — the load is NOT CHECKED, which is never clean, and the check runs over
 * that: the page measures nothing, so a worker that is dead or late costs the
 * page no parse, and the row says the load could not be checked (a page with no
 * worker at all measures the texts itself, as it always did, and takes the load as
 * not checked only where no standard library has loaded here either). The texts
 * measured are kept by the page, so a check run again over a model not changed
 * since has its load at once.
 *
 * WHAT IS WALKED IS THE MODEL THE RUN STARTED FROM: the click's, or, for a run
 * begun before it reads the page (below), the model a frame after the click. The
 * load is that start's texts, so the walk is of that start's model: a run whose
 * walk is not sent at once (it waits for its load, or for a run ahead of it)
 * copies the model's user part as it starts (`userPart`, about 10 ms on the
 * drone-swarm model), and an edit made meanwhile is not walked under a load
 * measured before it. Either way the result lands against the revision the run
 * started at, so such an edit shows it `stale`.
 *
 * THE CLICK HOLDS THE PAGE FOR NOTHING THAT GROWS WITH THE MODEL. What it reads of
 * the load is looked up; the parse is the worker's (above). Where reading it would
 * cost the page — an edit's recompute still waiting, which validates the model and
 * writes its text — the run begins first and reads once its row is drawn
 * ({@link runCheckedOnceDrawn}): the page does the edit's work after showing
 * `checking the load…`, not before. An E2E guard holds the drone-swarm model to it:
 * with the edit's recompute done, no task of the page over 200 ms from the click
 * to the answer; with it still waiting, a click that leaves it waiting and holds
 * the page under 50 ms, the row under way at once, and a frame drawn before the
 * edit's work.
 */

import { checkThrew, hasStateMachine, runCheck, runSolverCheck, selectionKey, type CheckContext, type CheckResult, type CheckSpec } from '../checks';
import type { Model, SerializedModel } from '@core/index';
import {
  libraryKey,
  NO_REQUEST,
  userPart,
  type CheckReply,
  type CheckRequest,
  type HealthReply,
  type HealthRequest,
} from '../checks-offthread';
import type { LoadHealthNow, PendingLoadHealth } from '../store';
import { useChecksStore, type RanIn } from './checks-store';

/** The part of a Worker this module uses, so a test can stand one in. */
export interface CheckWorker {
  postMessage(message: CheckRequest | HealthRequest): void;
  terminate(): void;
  onmessage: ((event: { data: CheckReply | HealthReply }) => void) | null;
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
  /** `useAppStore.rev` at the click, or, for a run begun before it reads the page ({@link runCheckedOnceDrawn}), at that read. */
  rev: number;
  /** What of the selection the check reads, at the click. */
  selection: string | undefined;
  /** {@link libraryKey} of the page's model when the run was sent to the worker. */
  library?: string;
  /**
   * The user part of the model to walk in the worker, as the run started
   * ({@link userPart}, copied when the send waits); null when there is no state
   * machine to walk, and the check is answered here.
   */
  part: SerializedModel | null;
  /** The load health still to be measured in the worker, before the check can run; gone once it is known (`ctx.loadHealth`). */
  load?: PendingLoadHealth;
}

let nextToken = 1;
const queue: Job[] = [];
let active: Job | null = null;
let worker: CheckWorker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;
/** {@link libraryKey} of the library a worker declined: runs against it go to the page. */
let declined: string | null = null;
/** A worker could not load the standard library: no later run asks one (D-11). */
let libraryFailed = false;
/** Why a load still to measure is taken as not checked once {@link libraryFailed}. */
const LIBRARY_FAILED = 'a background worker could not load the standard library earlier in this session';

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
  answerHere(job);
}

/** The run's answer, worked out in the page: a solver check on an isolated page goes through z3, any other check runs at once. */
function answerHere(job: Job): void {
  if (job.spec.engine === 'solver' && job.ctx.isolated) {
    // z3 runs on its own threads, with no watchdog: the queue is handed on at once, so a walk waiting behind this check
    // does not wait on z3. A Cancel takes the token away, and the answer that comes later is dropped (z3 cannot be stopped).
    if (active === job) active = null;
    stopWatchdog();
    armIdle();
    pump();
    void runSolverCheck(job.spec, job.ctx).then((result) => {
      const store = useChecksStore.getState();
      if (store.running[job.spec.id]?.token === job.token) store.land(job.spec.id, result, job.rev, 'page', job.selection);
    });
  } else settle(job, runCheck(job.spec, job.ctx), 'page');
}

/**
 * The worker could not measure the run's texts (`why`): the load is taken as not
 * checked (`PendingLoadHealth.unchecked`), and the check runs here over that —
 * never over a load it did not have, and with no parse on the page.
 */
function loadUnchecked(job: Job, load: PendingLoadHealth, why: string): void {
  job.load = undefined;
  job.ctx = { ...job.ctx, loadHealth: load.unchecked(why) };
  runHere(job);
}

/** The worker failed the run it was on (`why`): in the load phase the load ends as not checked; either way the check runs here. */
function workerFailed(job: Job, why: string): void {
  if (job.load !== undefined) loadUnchecked(job, job.load, why);
  else runHere(job);
}

/** The worker, started if there is none; throws where the page has none, or one cannot be started. */
function ensureWorker(): CheckWorker {
  if (worker !== null) return worker;
  const make = factory();
  if (make === null) throw new Error('no worker on this page');
  const w = make();
  w.onmessage = (event) => onReply(w, event.data);
  w.onerror = () => {
    if (w === worker && active !== null) workerFailed(active, 'the background worker stopped');
  };
  w.onmessageerror = () => {
    if (w === worker && active !== null) workerFailed(active, 'the background worker could not read its answer');
  };
  worker = w;
  return w;
}

/** A minute for the worker to answer `job`, from now. */
function armWatchdog(job: Job): void {
  stopWatchdog();
  watchdog = setTimeout(() => (active === job ? workerFailed(job, 'the background worker said nothing for a minute') : undefined), WATCHDOG_MS);
}

function onReply(from: CheckWorker, reply: CheckReply | HealthReply): void {
  // A reply that cannot name its request (`NO_REQUEST`) can only be for the one being waited for.
  if (from !== worker || active === null || (reply.id !== active.token && reply.id !== NO_REQUEST)) return;
  const job = active;
  if (!reply.ok && reply.libraryUnavailable === true) libraryFailed = true;
  if (job.load !== undefined) {
    const load = job.load;
    stopWatchdog();
    if (!reply.ok) loadUnchecked(job, load, `the background worker could not check it (${reply.message})`);
    else if (!('texts' in reply) || reply.texts.length !== load.unmeasured.length) {
      loadUnchecked(job, load, 'the background worker answered something other than the texts asked about');
    } else {
      job.load = undefined;
      job.ctx = { ...job.ctx, loadHealth: load.finish(reply.texts) };
      useChecksStore.getState().walking(job.spec.id, job.token);
      walk(job);
    }
    return;
  }
  if (reply.ok && 'result' in reply) settle(job, reply.result, 'worker');
  else {
    if (!reply.ok && 'libraryMismatch' in reply && reply.libraryMismatch === true && job.library !== undefined) declined = job.library;
    runHere(job);
  }
}

function pump(): void {
  if (active !== null || queue.length === 0) return;
  const job = queue.shift() as Job;
  active = job;
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  if (job.load !== undefined) measureLoad(job, job.load);
  else walk(job);
}

/** The run's first phase: the texts the page could not judge go to the worker, to be parsed as a terminal parses them. */
function measureLoad(job: Job, load: PendingLoadHealth): void {
  try {
    ensureWorker().postMessage({ id: job.token, kind: 'health', texts: [...load.unmeasured] });
  } catch (err) {
    // No worker after all (one could not be started, or take the texts): a worker that is dead answers 'not checked'.
    loadUnchecked(job, load, `a background worker could not be started (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  armWatchdog(job);
}

/** The check itself, its load known: in the worker when it walks a state machine there, else here. */
function walk(job: Job): void {
  const { ctx, part } = job;
  if (part === null) {
    // Nothing to walk (a model with no state machine, or a solver check), or nothing that needs the worker: answered here.
    answerHere(job);
    return;
  }
  const library = libraryKey(ctx.model);
  if (library === declined || libraryFailed) {
    // A worker has said this page's library is not its own, or that it cannot load one: do not start one to be told again.
    settle(job, runCheck(job.spec, ctx), 'page');
    return;
  }
  try {
    const w = ensureWorker();
    job.library = library;
    w.postMessage({
      id: job.token,
      check: job.spec.id,
      model: part,
      library,
      selectionId: ctx.selectionId,
      selectionName: ctx.selectionName,
      isolated: ctx.isolated,
      fileName: ctx.fileName,
      // A `readsLoadHealth` check is judged over it; it travels with the request
      // so the worker's run reads the health the page read, not undefined.
      loadHealth: ctx.loadHealth,
    });
  } catch {
    runHere(job);
    return;
  }
  armWatchdog(job);
}

/**
 * Run a check for the palette and record what it says. A check that is
 * {@link CheckSpec.offThread} goes to the worker where the page has one and there
 * is a state machine to walk, and is `running` until it settles; every other
 * check runs here, now. Starting a check that is already running does nothing.
 *
 * `health`, for a check judged over the load health, is what the page knew of
 * it at the click (`loadHealthNow`): known, and the check goes as above; or
 * texts still to parse, and the run is `checking the load…` while the worker
 * parses them, then goes on — whatever the check, and whether or not there is a
 * machine to walk. A page with no worker parses them here first. The model a
 * walk is sent is the click's, copied when the send waits.
 */
export function runChecked(spec: CheckSpec, ctx: CheckContext, rev: number, health?: LoadHealthNow): void {
  if (useChecksStore.getState().running[spec.id] !== undefined) return;
  launch(spec, ctx, rev, health);
}

/** What a run reads of the page as it starts, in one turn (I8): the model, the store's revision, and the load health of a check judged over it. */
export interface RunStart {
  readonly model: Model;
  readonly rev: number;
  readonly health?: LoadHealthNow;
}

/**
 * How long a run started with {@link runCheckedOnceDrawn} waits for a frame
 * before it reads the page anyway: a page in a background tab draws none.
 */
export const FRAME_WAIT_MS = 250;

/** Call `fn` once, in a task of its own after the page's next frame — or after {@link FRAME_WAIT_MS} where no frame comes. */
function afterFrame(fn: () => void): void {
  let done = false;
  const go = (): void => {
    if (done) return;
    done = true;
    fn();
  };
  // A timer set from a frame callback fires after that frame is drawn.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, FRAME_WAIT_MS);
}

/**
 * {@link runChecked}, for a run whose start would hold the page: reading the load
 * health is not at hand (`loadHealthAtHand`, `../store.ts`) — an edit's
 * recompute is still waiting, which validates the model and writes its text,
 * up to about 0.6 s on the drone-swarm model. The run begins at once, reading
 * `checking the load…`, and `read` is called once the row has been drawn, so the
 * click itself does not hold the page and the person sees the run under way
 * before the page does that work. What `read` returns — the model, its revision
 * and the load health, read in one turn — is what the run is of: an edit made in
 * the frame between the click and the read is part of it. A run cancelled before
 * then reads nothing. One whose read or start throws lands as a check that threw
 * does (`checks/internal-error`, against the click's revision): begun at the
 * click with no job behind it yet, it would otherwise read `checking the load…`
 * until cancelled, since no reply and no watchdog would end it.
 */
export function runCheckedOnceDrawn(spec: CheckSpec, ctx: CheckContext, rev: number, read: () => RunStart): void {
  const store = useChecksStore.getState();
  if (store.running[spec.id] !== undefined) return;
  const selection = selectionKey(spec, ctx);
  const token = nextToken++;
  store.begin(spec.id, token, rev, 'load');
  afterFrame(() => {
    // Cancelled since, or another run of it begun: this one is no longer wanted.
    if (useChecksStore.getState().running[spec.id]?.token !== token) return;
    try {
      const start = read();
      launch(spec, { ...ctx, model: start.model }, start.rev, start.health, token);
    } catch (err) {
      console.error('a palette check could not start', err);
      const now = useChecksStore.getState();
      if (now.running[spec.id]?.token === token) now.land(spec.id, checkThrew(err), rev, 'page', selection);
    }
  });
}

/**
 * Start a run over what it read: the body of {@link runChecked}. `begun` is the
 * token of a run already begun in the store ({@link runCheckedOnceDrawn}); it is
 * carried on, and one answered on the spot lands rather than being recorded anew.
 */
function launch(spec: CheckSpec, ctx: CheckContext, rev: number, health: LoadHealthNow | undefined, begun?: number): void {
  const store = useChecksStore.getState();
  const selection = selectionKey(spec, ctx);
  let c = ctx;
  let load: PendingLoadHealth | undefined;
  // A solver check on a page that cannot run it is answered `not here`, judged over nothing.
  if (health !== undefined && !(spec.engine === 'solver' && !ctx.isolated)) {
    if ('known' in health) c = { ...ctx, loadHealth: health.known };
    else if (factory() === null) c = { ...ctx, loadHealth: health.here() };
    else if (libraryFailed) c = { ...ctx, loadHealth: health.unchecked(LIBRARY_FAILED) };
    else load = health;
  }
  // The load health known: the solver check runs now. Still to measure: it queues like a walk, its first phase the load.
  if (spec.engine === 'solver' && c.isolated && load === undefined) {
    const token = begun ?? nextToken++;
    if (begun === undefined) store.begin(spec.id, token, rev, 'walk');
    else store.walking(spec.id, token);
    void runSolverCheck(spec, c).then((result) => {
      // Wanted still? A Cancel, or a run begun since, took the token away.
      const now = useChecksStore.getState();
      if (now.running[spec.id]?.token === token) now.land(spec.id, result, rev, 'page', selection);
    });
    return;
  }
  const walks = spec.offThread === true && hasStateMachine(c.model);
  if (load === undefined && (!walks || factory() === null || libraryFailed)) {
    const result = runCheck(spec, c);
    if (begun === undefined) store.record(spec.id, result, rev, selection);
    else store.land(spec.id, result, rev, 'page', selection);
    return;
  }
  // The records are the model's own (`userPart`), and edits change them in place:
  // a send that waits (for the load, or for the run ahead) takes a copy now.
  const waits = load !== undefined || active !== null;
  const part = !walks ? null : waits ? structuredClone(userPart(c.model)) : userPart(c.model);
  const job: Job = { token: begun ?? nextToken++, spec, ctx: c, rev, selection, part, ...(load !== undefined ? { load } : {}) };
  if (begun === undefined) store.begin(spec.id, job.token, rev, load !== undefined ? 'load' : 'walk');
  else if (load === undefined) store.walking(spec.id, job.token);
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
  declined = null;
  libraryFailed = false;
  endWorker();
  useChecksStore.setState({ running: {} });
}

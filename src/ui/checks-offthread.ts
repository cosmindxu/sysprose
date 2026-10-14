/**
 * checks-offthread — what a worker needs to run a check, with no worker in it.
 *
 * A check that walks a state machine can hold the page for as long as the walk
 * takes (`CheckSpec.offThread`, `docs/TEST-REPORT.md` §2.15). The worker
 * (`./checks-worker.ts`) is a few lines of messaging around {@link CheckHost};
 * everything that decides an answer is here, so a unit test runs the very same
 * code the browser does, and compares it with the check run on the page's own
 * thread.
 *
 * THE ANSWER IS THE SAME FUNCTION'S. {@link CheckHost.handle} rebuilds the
 * model the page had and calls `runCheck`, the call the palette makes on the
 * page's thread — it does not re-implement a check, so a check cannot say one
 * thing here and another there. Rebuilding is the only place they could part,
 * and that is what the unit test pins.
 *
 * WHAT TRAVELS. The worker keeps a model of its own with the standard library in
 * it, loaded once from the same data the page loads; a request carries only the
 * user's part of the model (`userPart`), the part the person wrote. The library
 * is 38,000 elements and a request would otherwise copy them all to move a few
 * thousand. Library element ids come from the bundled data, so the references
 * a user element holds into the library mean the same thing in both models.
 *
 * ONLY WHEN THE LIBRARY IS THE SAME ONE. The page's model may hold another: the
 * curated subset after a failed fetch, a library that came inside a saved
 * project from another build, or none yet in the first moments after open. A
 * reference a user element holds into that library resolves differently in a
 * worker that holds the bundled one, so a request carries {@link libraryKey} of
 * the page's, and a worker whose own differs answers that it cannot — which the
 * page answers by running the check itself, on the library it has, and by not
 * asking a worker again about that library: it would be told the same, after
 * the cost of a start and a load.
 *
 * THE LOAD IS CHECKED HERE TOO. A check judged over the load health
 * (`CheckSpec.readsLoadHealth`) needs each text a file of the model can hold
 * parsed and validated as a terminal loads it, and written back from its parse
 * to tell whether it holds the model on screen — a parse that held the page for
 * seconds at the click on the drone-swarm model. So the page sends the texts it
 * cannot judge yet ({@link HealthRequest}) and {@link CheckHost.measure} parses
 * them with the standard library this worker holds, the one a terminal loads
 * (`measureTextHealth`, `src/text/health.ts`), keeping the last few answers by
 * text. Which library the PAGE holds does not enter into it: a text is parsed
 * afresh, as a terminal parses it.
 */

import { FORMAT_VERSION, Model, type ElementRecord, type SerializedModel } from '@core/index';
import { loadFullStandardLibrary } from '@library/full-library';
import { measureTextHealth, type MeasuredText } from '@text/health';
import { CHECKS, runCheck, type CheckResult } from './checks';
import type { LoadHealth } from './store';

/** One run, as it crosses to the worker. */
export interface CheckRequest {
  /** The runner's token, echoed in the reply so a reply is matched to the run that asked. */
  id: number;
  /** The registry id of the check. */
  check: string;
  /** The model the page had, without the library. */
  model: SerializedModel;
  /** {@link libraryKey} of the model the page had: which library its references point into. */
  library: string;
  selectionId: string | null;
  selectionName: string | null;
  isolated: boolean;
  fileName: string;
  /**
   * The load health the page judged the run under, for a `readsLoadHealth` check
   * ({@link CheckSpec.readsLoadHealth}). Carried across so an off-thread walk
   * judges the same health the page would, rather than reading it undefined and
   * failing closed.
   */
  loadHealth?: LoadHealth;
}

/**
 * The texts the page could not judge, to be parsed and validated as a terminal
 * loads them (`measureTextHealth`): what Save writes and, where it differs, what
 * Export ▾ SysML writes.
 */
export interface HealthRequest {
  /** The runner's token, echoed in the reply. */
  id: number;
  kind: 'health';
  texts: string[];
}

/** What comes back for a {@link HealthRequest}: a count for each text, in its order, or why there is none. */
export type HealthReply =
  | { id: number; ok: true; texts: MeasuredText[] }
  | { id: number; ok: false; message: string };

/** A {@link HealthRequest}, told apart from a {@link CheckRequest} by its `kind`. */
export function isHealthRequest(req: CheckRequest | HealthRequest): req is HealthRequest {
  return (req as Partial<HealthRequest>).kind === 'health';
}

/**
 * The id of a reply to a request the worker could not read, which has none to
 * echo. Requests go one at a time, so it can only be the one being waited for;
 * the runner's tokens start at 1.
 */
export const NO_REQUEST = 0;

/**
 * What comes back: the result, or why there is none. `libraryMismatch` marks the
 * one reason that holds for every later request about the same library: the
 * worker's own is not the page's.
 */
export type CheckReply =
  | { id: number; ok: true; result: CheckResult }
  | { id: number; ok: false; message: string; libraryMismatch?: true };

const isLibraryElement = (el: ElementRecord): boolean => el.attrs.isLibrary === true;

/**
 * The part of a model a person wrote: what a request carries.
 *
 * NOT COPIED HERE. The records are the model's own, and `postMessage` copies
 * them as it sends (two milliseconds for the 3,800 elements of the drone-swarm
 * model); `Model.toJSONWhere` copies each one first, which the send then copies
 * again, and costs several times as much on the page's thread for nothing the
 * worker can tell. The send is the snapshot: it is taken before `postMessage`
 * returns, so an edit made while the worker runs changes nothing it reads. A
 * run whose send waits — for its load, or for a run ahead of it — copies this at
 * the click instead (`panels/checks-runner.ts`), since an edit changes the
 * records in place.
 */
export function userPart(model: Model): SerializedModel {
  const rootIds = model.rootIds().filter((id) => {
    const root = model.get(id);
    return root !== undefined && !isLibraryElement(root);
  });
  return {
    formatVersion: FORMAT_VERSION,
    elements: model.all().filter((el) => !isLibraryElement(el)),
    rootIds,
  };
}

/**
 * Which library a model holds, as a short string two models share only when they
 * hold the same one: how many library elements, and a hash of the ids of the
 * library's roots (the packages it is made of). The count tells the curated
 * subset from the bundle, and none from either; the roots tell one bundle from
 * another of the same size.
 */
export function libraryKey(model: Model): string {
  let count = 0;
  for (const el of model.all()) if (isLibraryElement(el)) count++;
  const roots = model
    .rootIds()
    .filter((id) => model.get(id)?.attrs.isLibrary === true)
    .sort()
    .join('\n');
  // FNV-1a over the UTF-16 code units: a key, not a defence.
  let h = 0x811c9dc5;
  for (let i = 0; i < roots.length; i++) h = Math.imul(h ^ roots.charCodeAt(i), 0x01000193) >>> 0;
  return `${count}:${h.toString(36)}`;
}

/**
 * Merge the standard library into the worker's own model — the data already read
 * (the worker awaits `preloadFullLibrary` first; Node has it from disk).
 *
 * The page does three things when it merges the library: load it, bind the type
 * references of the model it now holds (`resolveTypeReferences`) and chain the
 * connector ends through them (`resolveConnectorFeatureChains`). Only the first
 * is done here. The other two act on what a person wrote, which arrives already
 * bound, and on a library-only model they change nothing — a unit test pins that
 * the library comes out the same. (A text the worker measures is parsed afresh,
 * and `measureTextHealth` binds that parse with all three, as a terminal does.)
 */
export function mergeLibrary(model: Model): void {
  loadFullStandardLibrary(model);
}

/** How many texts' counts a {@link CheckHost} keeps: those of the model now, and before the last edit. */
const MEASURED_KEPT = 4;

/**
 * The worker's side of a run. One per worker; it holds the library-bearing model
 * between requests, and loads the library the first time one needs it.
 */
export class CheckHost {
  private model: Model | null = null;
  private loading: Promise<Model> | null = null;
  /** {@link libraryKey} of the library this host holds. */
  private held = '';
  /** The texts measured last, by text, the newest last: a check run again over a model not changed since needs no parse. */
  private readonly measured = new Map<string, MeasuredText>();

  /**
   * @param loadLibrary merges the standard library into a fresh model, as the
   * page does at start: in the browser it fetches the data first (a promise),
   * in Node it reads it from disk.
   */
  constructor(private readonly loadLibrary: (model: Model) => void | Promise<void>) {}

  private base(): Promise<Model> {
    if (this.model !== null) return Promise.resolve(this.model);
    // One load, however many requests arrive while it runs.
    this.loading ??= (async () => {
      const model = new Model();
      await this.loadLibrary(model);
      this.held = libraryKey(model);
      this.model = model;
      return model;
    })();
    return this.loading.catch((err) => {
      // A failed load is not kept: the next request tries again.
      this.loading = null;
      throw err;
    });
  }

  /** Runs the check a request names on the model it carries. Never throws. */
  async handle(req: CheckRequest): Promise<CheckReply> {
    try {
      const spec = CHECKS.find((c) => c.id === req.check);
      if (spec === undefined) return { id: req.id, ok: false, message: `no check named ${req.check}` };
      const model = await this.base();
      if (req.library !== this.held) {
        // Not an error in the check: the page's references point into a library this worker does not hold.
        return { id: req.id, ok: false, message: 'the standard library the page holds is not the one this worker holds', libraryMismatch: true };
      }
      // Everything but the library is replaced by what the request carries.
      model.resetPreserving(req.model, isLibraryElement);
      const result = runCheck(spec, {
        model,
        selectionId: req.selectionId,
        selectionName: req.selectionName,
        isolated: req.isolated,
        fileName: req.fileName,
        loadHealth: req.loadHealth,
      });
      return { id: req.id, ok: true, result };
    } catch (err) {
      return { id: req.id, ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Parses and validates each text a request carries, as a terminal loads it.
   * Never throws: a library that could not be loaded — so a text could not be
   * validated as a terminal validates it — is a reply with no counts, which the
   * page takes as a load nobody could check.
   */
  async measure(req: HealthRequest): Promise<HealthReply> {
    try {
      // The standard library this worker holds, loaded once: its data is what each text's own parse is merged with.
      await this.base();
      return { id: req.id, ok: true, texts: req.texts.map((text) => this.measureText(text)) };
    } catch (err) {
      return { id: req.id, ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** One text's counts: kept from an earlier request, or measured now and kept. */
  private measureText(text: string): MeasuredText {
    const known = this.measured.get(text) ?? measureTextHealth(text, mergeLibrary);
    this.measured.delete(text);
    this.measured.set(text, known);
    for (const old of this.measured.keys()) {
      if (this.measured.size <= MEASURED_KEPT) break;
      this.measured.delete(old);
    }
    return known;
  }
}

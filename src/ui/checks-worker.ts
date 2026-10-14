/**
 * Browser only: the worker the palette runs a state-machine check in, so a walk
 * that takes a good part of a second leaves the page usable (`CheckSpec.offThread`). The page
 * starts it from `./panels/checks-runner.ts`; every decision is in
 * `./checks-offthread.ts`, and this file only carries messages.
 *
 * The runner sends one request at a time and waits for its reply, so requests
 * never overlap here: a check to run ({@link CheckHost.handle}), or the texts
 * whose load a check is judged over, to parse ({@link CheckHost.measure}). A
 * reply is sent whatever happens: neither throws, and a request the worker
 * cannot answer (or read) comes back as `ok: false` — which the page answers by
 * running the check itself, or, for the texts, by taking the load as not checked.
 */

import { preloadFullLibrary } from '@library/full-library';
import {
  CheckHost,
  isHealthRequest,
  mergeLibrary,
  NO_REQUEST,
  type CheckReply,
  type CheckRequest,
  type HealthReply,
  type HealthRequest,
} from './checks-offthread';

/** The part of a dedicated worker's global scope this file touches. */
interface WorkerScope {
  onmessage: ((event: { data: CheckRequest | HealthRequest }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: CheckReply | HealthReply): void;
}
const scope = self as unknown as WorkerScope;

const host = new CheckHost(async (model) => {
  // The data is a file the browser fetches; the merge itself is the page's own steps.
  await preloadFullLibrary();
  mergeLibrary(model);
});

const failed = (id: number, err: unknown): CheckReply => ({ id, ok: false, message: err instanceof Error ? err.message : String(err) });

scope.onmessage = (event) => {
  const req = event.data;
  // Neither answer throws; a reply the browser cannot send is the one thing left that can.
  const answer: Promise<CheckReply | HealthReply> = isHealthRequest(req) ? host.measure(req) : host.handle(req);
  answer.then((reply) => scope.postMessage(reply)).catch((err: unknown) => scope.postMessage(failed(req.id, err)));
};

// A request the browser could not read has no id to answer under: the page takes it for the run it waits on.
scope.onmessageerror = () => scope.postMessage(failed(NO_REQUEST, 'the request could not be read'));

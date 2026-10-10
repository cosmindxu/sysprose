/**
 * Browser only: the worker the palette runs a state-machine check in, so a walk
 * that takes a second leaves the page usable (`CheckSpec.offThread`). The page
 * starts it from `./panels/checks-runner.ts`; every decision is in
 * `./checks-offthread.ts`, and this file only carries messages.
 *
 * The runner sends one request at a time and waits for its reply, so requests
 * never overlap here. A reply is sent whatever happens: {@link CheckHost.handle}
 * does not throw, and a request the worker cannot answer (or read) comes back as
 * `ok: false`, which the page answers by running the check itself.
 */

import { preloadFullLibrary } from '@library/full-library';
import { CheckHost, mergeLibrary, NO_REQUEST, type CheckReply, type CheckRequest } from './checks-offthread';

/** The part of a dedicated worker's global scope this file touches. */
interface WorkerScope {
  onmessage: ((event: { data: CheckRequest }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: CheckReply): void;
}
const scope = self as unknown as WorkerScope;

const host = new CheckHost(async (model) => {
  // The data is a file the browser fetches; the merge itself is the page's own steps.
  await preloadFullLibrary();
  mergeLibrary(model);
});

const failed = (id: number, err: unknown): CheckReply => ({ id, ok: false, message: err instanceof Error ? err.message : String(err) });

scope.onmessage = (event) => {
  const { id } = event.data;
  // `handle` does not throw; a reply the browser cannot send is the one thing left that can.
  host
    .handle(event.data)
    .then((reply) => scope.postMessage(reply))
    .catch((err: unknown) => scope.postMessage(failed(id, err)));
};

// A request the browser could not read has no id to answer under: the page takes it for the run it waits on.
scope.onmessageerror = () => scope.postMessage(failed(NO_REQUEST, 'the request could not be read'));

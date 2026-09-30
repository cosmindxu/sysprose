/**
 * Browser only: run the diagram layout (ELK) in a Web Worker, so laying out a
 * large diagram — seconds for a whole model — never freezes the page. The
 * worker script ships as its own asset; the in-process build stays the
 * fallback (see `setElkFactory` in src/diagram/layout.ts).
 */

import ElkApi from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { ELK as ElkInstance } from 'elkjs/lib/elk-api';
import { setElkFactory } from '@diagram/layout';

/** Route diagram layout through a worker where the browser allows one. */
export function installWorkerLayout(): void {
  if (typeof Worker === 'undefined') return;
  setElkFactory(() => new (ElkApi as unknown as new (o: { workerUrl: string }) => ElkInstance)({ workerUrl: elkWorkerUrl }));
}

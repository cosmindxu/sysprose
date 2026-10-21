/**
 * Browser only: build the SysML parser while the page is idle once the Text view
 * is open, so the first "Apply text → model" click does not wait for it. Building
 * the parser is Chevrotain's lookahead analysis, about 1.3 s of the page's thread
 * that no configuration shortens (`docs/UI-ROADMAP.md` P3); done at the click, it
 * was the whole of the first Apply.
 *
 * WHY NOT A WORKER. The parser cannot be handed across: a worker that parsed
 * would have to build its own and send every parse's model back, and the
 * callers that parse on the page — `applyText`, and the `typedTextFirst` of a
 * field's change, which applies the typed text before the change goes in — do
 * so synchronously and cannot wait for a reply. They keep the page's parser;
 * this only builds it before they ask. The wait is moved, not removed.
 *
 * WHY NOT AT LOAD. The build holds the page for its whole length, and at load it
 * landed before the first diagram was drawn: the diagram came up at 2.2 s to 2.6 s instead of
 * 0.9 s to 1.0 s (measured on this machine), for every session, though most never open the Text
 * view. Text typed, and so every Apply, starts there: the build begins once the
 * view is mounted, and only for a session that has one. Opening the tab now holds the page for
 * about 1.4 s, once; the time from the tab to an applied model is unchanged.
 *
 * `data-parser-warm` on the document element says it is built, for the E2E
 * spec that must not have the build land inside its measurement.
 */

import { parserIsWarm, warmParser } from '@text/langium/module';

/** How long the browser may leave the page busy before the build goes ahead anyway, in ms. */
const IDLE_TIMEOUT_MS = 1000;
/** Where there is no idle callback (Safari): the build waits this long after the call, in ms. */
const FALLBACK_DELAY_MS = 300;

/** The part of the browser's global scope, and of this module's own steps, that a test stands in for. */
export interface WarmUpDeps {
  build: () => void;
  isBuilt: () => boolean;
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => unknown;
  setTimeout: (callback: () => void, ms: number) => unknown;
  document?: { documentElement?: { setAttribute(name: string, value: string): void } };
}

const inBrowser = (): WarmUpDeps => ({
  build: warmParser,
  isBuilt: parserIsWarm,
  requestIdleCallback: globalThis.requestIdleCallback?.bind(globalThis),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  document: globalThis.document,
});

/**
 * Schedule the parser's build for when the page is idle. Nothing to do once it is built; a Text
 * view that mounts again before the first build runs queues another, which finds it built.
 */
export function scheduleParserWarmUp(deps: WarmUpDeps = inBrowser()): void {
  const markBuilt = (): void => deps.document?.documentElement?.setAttribute('data-parser-warm', 'true');
  if (deps.isBuilt()) return markBuilt();
  const run = (): void => {
    try {
      if (!deps.isBuilt()) deps.build();
      markBuilt();
    } catch {
      // Best effort: a parse that finds no parser built builds it, as before.
    }
  };
  if (typeof deps.requestIdleCallback === 'function') deps.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
  else deps.setTimeout(run, FALLBACK_DELAY_MS);
}

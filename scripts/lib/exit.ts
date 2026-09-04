/**
 * How a script in `scripts/` ends: one shared ending for every CLI here.
 *
 * WHY IT IS SHARED. Both command-line entry points used to close with
 * `main().then((code) => process.exit(code), …)`, and that idiom silently
 * truncates their own output. `process.exit` tears the process down without
 * draining a pending `process.stdout.write`, and a write to a PIPE is
 * asynchronous the moment it exceeds the pipe buffer — so
 *
 *   npm run sysprose -- elements big.sysml --json | jq
 *
 * delivered a 64 KiB PREFIX of the report and still exited 0: unparseable JSON
 * reported as a clean run. Redirecting the same command to a file was fine,
 * because a file write is synchronous, which is why it survived every test.
 * Setting `process.exitCode` and returning instead lets the event loop finish
 * the write before the process ends — the report and the exit code then always
 * describe the same thing. Fixing it in one place is deliberate: the defect
 * arrived by copying the idiom, so the idiom is what had to change.
 *
 * The broken-pipe guard is the other half. Once the process no longer exits
 * early, a consumer that stops reading (`… | head -1`) closes the pipe under a
 * write in flight, and Node's default for that is an unhandled `error` event —
 * a stack trace printed over the output the reader asked for, plus a non-zero
 * exit. Hanging up early is the reader's choice, not a failure of the report,
 * so `EPIPE` ends the run quietly with whatever code the command had reached.
 */

/** Anything Node throws from a stream carries an optional `code`. */
type StreamError = Error & { code?: string };

/**
 * Run `main`, then end: its number becomes the exit code, an unexpected
 * rejection becomes exit 2 with a stack on stderr, and `EPIPE` on stdout ends
 * the run quietly.
 *
 * `name` prefixes the internal-error line, matching the `name: message` shape
 * every other diagnostic these commands print.
 */
export function runMain(name: string, main: () => Promise<number>): void {
  process.stdout.on('error', (err: StreamError) => {
    if (err.code !== 'EPIPE') throw err;
    // Nothing is left to flush — the pipe is gone — so exiting here is safe.
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  });

  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // Never exit 0 on an unexpected failure: a silent pass is the one outcome
      // that must be impossible — it would report a model nobody analysed.
      process.stderr.write(
        `${name}: internal error: ${err instanceof Error ? err.stack : String(err)}\n`,
      );
      process.exitCode = 2;
    },
  );
}

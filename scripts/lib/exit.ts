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
 *
 * The one run that does end itself is one that left something behind holding
 * the event loop open with nothing left to do ({@link Ending.lingers}), and it
 * does so only once stdout and stderr have drained — so the 64 KiB prefix
 * above cannot come back through it.
 */

/** Anything Node throws from a stream carries an optional `code`. */
type StreamError = Error & { code?: string };

/** What a command may tell {@link runMain} about how its process has to end. */
export interface Ending {
  /**
   * Asked once the command has returned, either way: did the run leave
   * something behind that holds the process open with no work left in it?
   * Then the process ends itself once its output has drained, with the code
   * the command reached. Absent, or false, it ends the ordinary way.
   */
  lingers?: () => boolean;
}

/**
 * Run `main`, then end: its number becomes the exit code, an unexpected
 * rejection becomes exit 2 with a stack on stderr, and `EPIPE` on stdout ends
 * the run quietly.
 *
 * `name` prefixes the internal-error line, matching the `name: message` shape
 * every other diagnostic these commands print.
 */
export function runMain(name: string, main: () => Promise<number>, ending: Ending = {}): void {
  process.stdout.on('error', (err: StreamError) => {
    if (err.code !== 'EPIPE') throw err;
    // Nothing is left to flush — the pipe is gone — so exiting here is safe.
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  });

  main()
    .then(
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
    )
    .then(() => {
      if (ending.lingers?.() !== true) return;
      // A write's callback runs once it and every write before it are out, so
      // the exit below cannot cut a report short; `process.exit()` with no
      // argument keeps the `exitCode` set above.
      process.stdout.write('', () => process.stderr.write('', () => process.exit()));
    });
}

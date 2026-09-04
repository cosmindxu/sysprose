/**
 * The argument grammar the `sysprose` commands share.
 *
 * WHY. There were three argument parsers in `scripts/` and no two agreed.
 * `sysml-check` switches on whole tokens, so `--out report.md` cannot be
 * expressed at all; `agent-repair-bench` reads a value with `argv[++i]` and
 * never checks that there was one, so a trailing `--rounds` silently becomes
 * `NaN` and the run reports a number nobody asked for; `grammar-coverage` scans
 * for three literals with `includes`. A suite of subcommands needs ONE grammar
 * before it needs a fourth variant, and the parser has to be declarative
 * because the `--help` text and the command reference are both rendered from
 * the same specs — a flag that exists but is undocumented is how a CLI and its
 * documentation stop describing the same tool.
 *
 * FAIL DIRECTION. Every ambiguity is an error, never a guess: an unknown
 * `-`-prefixed token is rejected rather than passed through as a file name (a
 * mistyped `--jsonn` that is read as an input path is a run that reports on
 * nothing), and a value flag with no value is rejected rather than read as
 * `undefined`. The one `-`-prefixed token that is NOT an option is `-` itself,
 * which every command in this repo already reads as "stdin".
 */

/** One flag a command accepts. Rendered into `--help` as well as parsed. */
export interface FlagSpec {
  /** Long name without the leading `--`. */
  name: string;
  /** Optional single-letter alias, without the leading `-`. */
  short?: string;
  /** `value` flags take an argument; `boolean` flags are present or absent. */
  kind: 'boolean' | 'value';
  /** Metavariable shown in the help text for a value flag, e.g. `PATH`. */
  metavar?: string;
  /** One line, in the second person — this is what the user guide will quote. */
  doc: string;
  /** What the command does when the flag is absent (shown in help). */
  fallback?: string;
}

/** A successful parse: the flags that were given, and everything else in order. */
export interface ParsedArgs {
  /** Non-option tokens, in the order they appeared (`-` included). */
  positionals: string[];
  /** Present flags: `true` for a boolean, the string for a value flag. */
  flags: Map<string, string | true>;
}

/** A rejected parse. Carried rather than thrown so the caller decides the exit. */
export interface ArgError {
  error: string;
}

export function isArgError(x: ParsedArgs | ArgError): x is ArgError {
  return 'error' in x;
}

/** Was this boolean (or value) flag given at all? */
export function flagGiven(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

/** The value of a value flag, or `undefined` when it was not given. */
export function flagValue(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

/**
 * Parse `argv` against `specs`.
 *
 * Accepts `--flag`, `--flag value`, `--flag=value` and short `-f` aliases;
 * `--` ends the options and makes every later token a positional. Repeating a
 * value flag keeps the last value, which is what a shell user expects from a
 * command they are editing in place.
 */
export function parseArgs(
  argv: readonly string[],
  specs: readonly FlagSpec[],
): ParsedArgs | ArgError {
  const byName = new Map<string, FlagSpec>();
  for (const s of specs) {
    byName.set(`--${s.name}`, s);
    if (s.short) byName.set(`-${s.short}`, s);
  }

  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let optionsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (optionsEnded || token === '-' || !token.startsWith('-')) {
      // `-` is stdin, not an option, and it is the only exception.
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }

    const eq = token.indexOf('=');
    const key = eq === -1 ? token : token.slice(0, eq);
    const spec = byName.get(key);
    if (!spec) return { error: `unknown option: ${key}` };

    if (spec.kind === 'boolean') {
      if (eq !== -1) return { error: `--${spec.name} takes no value` };
      flags.set(spec.name, true);
      continue;
    }

    if (eq !== -1) {
      const inline = token.slice(eq + 1);
      if (inline === '') return { error: `missing value for --${spec.name}` };
      flags.set(spec.name, inline);
      continue;
    }
    const next = argv[i + 1];
    // A following option is a missing value, not a value: `--depth --json`
    // asked for a depth of `--json`, and reading it as one is the `NaN` bug
    // this parser exists to make impossible.
    if (next === undefined || (next.startsWith('-') && next !== '-')) {
      return { error: `missing value for --${spec.name}` };
    }
    flags.set(spec.name, next);
    i++;
  }

  return { positionals, flags };
}

/** Render one flag as a help line: `  --name VALUE   doc (default: …)`. */
export function renderFlag(spec: FlagSpec, width = 18): string {
  const alias = spec.short ? `-${spec.short}, ` : '';
  const head = `${alias}--${spec.name}${spec.kind === 'value' ? ` ${spec.metavar ?? 'VALUE'}` : ''}`;
  const tail = spec.fallback ? `${spec.doc} (default: ${spec.fallback})` : spec.doc;
  return `  ${head.padEnd(width)}  ${tail}`;
}

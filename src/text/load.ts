/**
 * `loadModelText` — turn source text into a BOUND, validated model, headlessly.
 *
 * WHY. The five steps that make a usable model out of text — parse, preload the
 * library asset, merge the library, resolve type references, resolve connector
 * feature chains — were written out by hand in two places: `check.ts` (which
 * built the model, read its diagnostics and then dropped it on the floor) and
 * the UI store's `loadStandardLibraryAsync`. Everything that REPORTS on a model
 * — metrics, requirement coverage, traceability, where-used — is a pure
 * exported function that needs a model to be handed one, so with no headless
 * loader every one of them was reachable only from the browser. This is that
 * loader: the same pipeline, once, returning the model as well as the report.
 *
 * `checkText` is now a wrapper that keeps only the report, so the Agent
 * Diagnostics Contract it publishes is unchanged.
 *
 * FAIL DIRECTION. Like `checkText`, this never throws: an internal failure
 * becomes an `import/internal-error` finding with `ok: false`. It also declines
 * to invent a model it does not have — see {@link LoadResult.model} — because
 * "0 elements, nothing to report" is the wrong answer to give about a file that
 * never loaded.
 *
 * COST — two different costs, and it matters which is which. Measured on
 * `examples/uav-isr.sysml` (2026-09-04, three loads in one process):
 *
 *   - ONCE PER PROCESS, ~1.2 s: constructing the Langium parser inside the
 *     first `parseModel`. It is paid whatever `library` is set to — the first
 *     load takes ~1.24 s with `library: 'none'` and ~1.45 s with `'full'` —
 *     so it is a cost of parsing at all, not of the library.
 *   - PER MODEL, ~60-100 ms: merging the library into THIS model and binding
 *     it (`loadFullStandardLibrary` ~50-80 ms, `resolveTypeReferences`
 *     ~10-20 ms, connector chains ~3 ms). It is NOT amortised: every model
 *     gets its own copy of the library and pays for it. Warm loads run ~23 ms
 *     with `library: 'none'` against ~120 ms with `'full'`.
 *
 * `preloadFullLibrary()` does not amortise anything in Node: it is a no-op
 * there (`full-library.ts:124-129`), because the bundle was already read
 * synchronously at module load. It is awaited because the browser needs it.
 *
 * `library: 'none'` skips the per-model cost but reports every library type as
 * unresolved. Each loaded model carries its own ~38.8k-element copy of the
 * library, so a caller holding many models at once holds many copies — load
 * and release them one at a time.
 */

import type { ElementId, Model } from '@core/index';
import type { Diagnostic, Severity, TextRange } from '@validation/types';
import { validate } from '@validation/index';
import {
  parseModel,
  resolveConnectorFeatureChains,
  retractResolvedSpecializationWarnings,
} from './index';
import type { ParseDiagnostic } from './types';
import { renderHint } from './langium/diagnostic-codes';

/** Options for {@link loadModelText} (and so for `checkText`). */
export interface LoadOptions {
  /**
   * Bind against the bundled OMG standard library before validating.
   * `'full'` (default) matches what the app does; `'none'` is faster but
   * reports library types (`Real`, `Integer`, …) as unresolved.
   */
  library?: 'full' | 'none';
  /**
   * Name of the FILE the text came from. Echoed in the report and checked for
   * a textual-notation extension.
   */
  fileName?: string;
  /**
   * Label to report the source under when it did NOT come from a file — piped
   * stdin, an editor buffer, a string an agent built in memory.
   *
   * Separate from {@link fileName} because only a real file name can have a
   * wrong extension: passing `<stdin>` as the file name made every piped run
   * emit `import/wrong-extension` (and fail `--strict`) over a file that does
   * not exist. When both are given, this is what the report is labelled with
   * and `fileName` is still what the extension test reads.
   */
  displayName?: string;
  /** Treat warnings as failures in `ok`. Default false. */
  strict?: boolean;
  /** Include the element→range side table in the report. Default false. */
  includeRanges?: boolean;
}

/** What normalisation the checker applied before parsing. */
export interface Normalization {
  /** A UTF-8 BOM was stripped. */
  bomStripped: boolean;
  /** CRLF line endings were converted to LF (positions are in the LF text). */
  crlfNormalized: boolean;
  /** The source contains tab characters (columns may not match your editor). */
  tabs: boolean;
}

/** The machine-readable result of checking one source text. */
export interface CheckReport {
  /** No `error` findings (and, with `strict`, no warnings either). */
  ok: boolean;
  /** Echoed from {@link LoadOptions.displayName}, else {@link LoadOptions.fileName}. */
  fileName?: string;
  /** Always `sysml-text` — reserved for future input formats. */
  format: 'sysml-text';
  normalization: Normalization;
  /** Every finding, sorted by position then severity. */
  diagnostics: Diagnostic[];
  summary: { errors: number; warnings: number; infos: number };
  /**
   * What actually parsed. `count` excludes standard-library elements, so it is
   * the agent's own model; `roots` names the top-level declarations, which is
   * the quickest way to see that a file was truncated by error recovery.
   */
  elements: { count: number; roots: string[] };
  /** Element→source-span table (only when `includeRanges`). */
  ranges?: Record<ElementId, TextRange>;
}

/** What {@link loadModelText} hands back. */
export interface LoadResult {
  /**
   * The bound model — ABSENT when nothing was parsed: the input was refused as
   * not-text, or the pipeline itself failed. A caller that reports on the model
   * has to branch on that rather than analyse an empty one, because "0
   * elements, nothing to report" and "the file did not load" are different
   * answers and only one of them is honest.
   *
   * Present whenever the source parsed, INCLUDING when it parsed with errors:
   * error recovery yields a partial model, and reporting on the part that
   * survived is often exactly what the reader wants.
   */
  model?: Model;
  /** The same report `checkText` returns. */
  report: CheckReport;
  /**
   * Source span of each element the parse created (empty when there is no
   * model). Unlike {@link CheckReport.ranges} this is always populated, since
   * a caller holding the model is the one that needs to point back at the text.
   */
  ranges: Map<ElementId, TextRange>;
}

const UTF8_BOM = '﻿';

/** Strip a BOM and normalise line endings, recording what changed. */
function normalize(text: string): { text: string; normalization: Normalization } {
  const bomStripped = text.startsWith(UTF8_BOM);
  let out = bomStripped ? text.slice(UTF8_BOM.length) : text;
  const crlfNormalized = out.includes('\r\n');
  if (crlfNormalized) out = out.replace(/\r\n/g, '\n');
  return { text: out, normalization: { bomStripped, crlfNormalized, tabs: out.includes('\t') } };
}

/** Widen a parse diagnostic into the validation Diagnostic shape. */
function widen(d: ParseDiagnostic, i: number): Diagnostic {
  return {
    id: `parse#${i}`,
    ruleId: 'parse',
    severity: d.severity,
    message: d.message,
    ...(d.code ? { code: d.code } : {}),
    ...(d.range ? { range: d.range } : {}),
    ...(d.expected ? { expected: d.expected } : {}),
    ...(d.found ? { found: d.found } : {}),
    ...(d.hint ? { hint: d.hint } : {}),
    source: d.source ?? 'parser',
  };
}

/** Sort key: position first (that is how a reader works through a file). */
function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return [...list].sort((a, b) => {
    const al = a.range?.start.line ?? Number.MAX_SAFE_INTEGER;
    const bl = b.range?.start.line ?? Number.MAX_SAFE_INTEGER;
    if (al !== bl) return al - bl;
    const ac = a.range?.start.column ?? 0;
    const bc = b.range?.start.column ?? 0;
    if (ac !== bc) return ac - bc;
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    return (a.code ?? a.ruleId).localeCompare(b.code ?? b.ruleId);
  });
}

/** A diagnostic the checker itself raises (bad input, internal failure). */
function selfDiagnostic(code: string, message: string, severity: Severity = 'error'): Diagnostic {
  return {
    id: code,
    ruleId: 'import',
    severity,
    message,
    code,
    source: 'import',
    hint: renderHint(code),
  };
}

/** Recognised textual-notation extensions. */
const TEXT_EXTENSIONS = ['.sysml', '.kerml', '.txt'];

/**
 * Parse, bind and validate one source text, keeping the model.
 *
 * Never throws. The `report` is exactly what `checkText` returns for the same
 * arguments; `model` is the bound model that produced it.
 */
export async function loadModelText(
  text: string,
  opts: LoadOptions = {},
): Promise<LoadResult> {
  const {
    library = 'full',
    fileName,
    displayName,
    strict = false,
    includeRanges = false,
  } = opts;
  const reportedName = displayName ?? fileName;
  const { text: src, normalization } = normalize(text);
  const diagnostics: Diagnostic[] = [];

  if (normalization.bomStripped) {
    diagnostics.push(selfDiagnostic('import/bom-stripped', 'UTF-8 BOM stripped before parsing.', 'info'));
  }
  if (normalization.crlfNormalized) {
    diagnostics.push(
      selfDiagnostic(
        'import/crlf-normalized',
        'CRLF line endings normalised to LF; reported positions are in the normalised text.',
        'info',
      ),
    );
  }
  // Only a real FILE name can have a wrong extension; a display name such as
  // `<stdin>` names no file, so there is nothing for the reader to rename.
  if (fileName !== undefined) {
    const lower = fileName.toLowerCase();
    if (!TEXT_EXTENSIONS.some((e) => lower.endsWith(e))) {
      diagnostics.push(
        selfDiagnostic(
          'import/wrong-extension',
          `'${fileName}' is not a recognised textual-notation file name (expected ${TEXT_EXTENSIONS.join(', ')}); parsed as SysML text anyway.`,
          'warning',
        ),
      );
    }
  }

  // JSON offered as text: refuse rather than emit a wall of parse errors that
  // tell the agent nothing about the real mistake.
  if (src.trimStart().startsWith('{')) {
    diagnostics.push(
      selfDiagnostic(
        'import/not-text',
        'Content looks like JSON, not SysML textual notation (it starts with "{").',
      ),
    );
    return {
      report: report(diagnostics, { count: 0, roots: [] }, normalization, reportedName, strict, undefined),
      ranges: new Map(),
    };
  }

  try {
    const parsed = parseModel(src);
    const model = parsed.model;
    const userIds = new Set(model.all().map((el) => el.id));

    if (library === 'full') {
      const { preloadFullLibrary, loadFullStandardLibrary } = await import('../library/full-library');
      const { resolveTypeReferences } = await import('../library/resolve');
      await preloadFullLibrary();
      loadFullStandardLibrary(model);
      resolveTypeReferences(model);
      resolveConnectorFeatureChains(model);
    }

    // Parse warnings are published AFTER binding, so a forward reference the
    // binder resolved does not leave a stale "Unresolved reference" behind. A
    // name that is genuinely unresolvable keeps its warning.
    const parseDiags =
      library === 'full' ? retractResolvedSpecializationWarnings(model, parsed) : parsed.diagnostics;
    for (const [i, d] of parseDiags.entries()) diagnostics.push(widen(d, i));

    // Validation findings, restricted to the agent's own elements: the bundled
    // library is not theirs to fix, and a wall of library findings would bury
    // the ones they can act on.
    for (const d of validate(model)) {
      if (d.elementId !== undefined && !userIds.has(d.elementId)) continue;
      const range = d.elementId !== undefined ? parsed.ranges.get(d.elementId) : undefined;
      const el = d.elementId !== undefined ? model.get(d.elementId) : undefined;
      const code = d.code ?? `validation/${d.ruleId}`;
      const hint = d.hint ?? renderHint(code);
      diagnostics.push({
        ...d,
        code,
        source: d.source ?? 'validation',
        ...(range ? { range } : {}),
        ...(el?.declaredName ? { elementName: el.declaredName } : {}),
        ...(hint ? { hint } : {}),
      });
    }

    const roots = model
      .rootIds()
      .filter((id) => userIds.has(id))
      .map((id) => model.get(id)?.declaredName ?? `«${model.get(id)?.eClass ?? 'unknown'}»`);

    const ranges = includeRanges
      ? Object.fromEntries([...parsed.ranges].filter(([id]) => userIds.has(id)))
      : undefined;

    return {
      model,
      report: report(
        diagnostics,
        { count: userIds.size, roots },
        normalization,
        reportedName,
        strict,
        ranges,
      ),
      ranges: parsed.ranges,
    };
  } catch (err) {
    diagnostics.push(
      selfDiagnostic(
        'import/internal-error',
        `The checker failed on this input: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return {
      report: report(diagnostics, { count: 0, roots: [] }, normalization, reportedName, strict, undefined),
      ranges: new Map(),
    };
  }
}

function report(
  diagnostics: Diagnostic[],
  elements: { count: number; roots: string[] },
  normalization: Normalization,
  fileName: string | undefined,
  strict: boolean,
  ranges: Record<ElementId, TextRange> | undefined,
): CheckReport {
  const sorted = sortDiagnostics(diagnostics);
  const errors = sorted.filter((d) => d.severity === 'error').length;
  const warnings = sorted.filter((d) => d.severity === 'warning').length;
  const infos = sorted.filter((d) => d.severity === 'info').length;
  return {
    ok: errors === 0 && (!strict || warnings === 0),
    ...(fileName !== undefined ? { fileName } : {}),
    format: 'sysml-text',
    normalization,
    diagnostics: sorted,
    summary: { errors, warnings, infos },
    elements,
    ...(ranges ? { ranges } : {}),
  };
}

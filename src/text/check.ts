/**
 * `checkText` — the headless "is this `.sysml` file any good, and if not why"
 * entry point. The core of the Agent Diagnostics Contract
 * (`docs/AGENT-AUTHORING-CAMPAIGN.md`).
 *
 * WHY. Before this existed, the only way to get errors out of the tool was to
 * drive the browser: open the Text tab, paste, click Apply, read the Problems
 * panel, and regex line/column out of an English sentence. An AI agent
 * authoring models as text needs one function that takes a string and returns
 * every finding with a stable code and an exact source span. That is this.
 *
 * WHAT IT COMBINES. Three stages that were only ever wired together inside the
 * UI store: parse (`parseModel`), standard-library binding
 * (`loadFullStandardLibrary` + `resolveTypeReferences` + the connector
 * feature-chain pass) and model validation (`validate`). Skipping the library
 * stage would report every `: Real` as an unresolved type, so it is the
 * DEFAULT; `library: 'none'` exists for speed in tests that do not need it.
 *
 * FAIL DIRECTION. `checkText` never throws. An internal failure is reported as
 * an `import/internal-error` diagnostic with `ok: false`, because a checker
 * that crashes silently would let a broken model through as "clean" — the
 * conservative verdict is the one that costs least when wrong.
 */

import type { ElementId } from '@core/index';
import type { Diagnostic, Severity, TextRange } from '@validation/types';
import { validate } from '@validation/index';
import {
  parseModel,
  resolveConnectorFeatureChains,
  retractResolvedSpecializationWarnings,
} from './index';
import type { ParseDiagnostic } from './types';
import { renderHint } from './langium/diagnostic-codes';

/** Options for {@link checkText}. */
export interface CheckOptions {
  /**
   * Bind against the bundled OMG standard library before validating.
   * `'full'` (default) matches what the app does; `'none'` is faster but
   * reports library types (`Real`, `Integer`, …) as unresolved.
   */
  library?: 'full' | 'none';
  /** File name to report back (also drives the extension warning). */
  fileName?: string;
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
  /** Echoed from {@link CheckOptions.fileName}. */
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
 * Check a source text and report everything wrong with it.
 *
 * Never throws. Resolves to a {@link CheckReport} whose `ok` is the single
 * boolean an automation should branch on.
 */
export async function checkText(text: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const { library = 'full', fileName, strict = false, includeRanges = false } = opts;
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
    return report(diagnostics, { count: 0, roots: [] }, normalization, fileName, strict, undefined);
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

    return report(
      diagnostics,
      { count: userIds.size, roots },
      normalization,
      fileName,
      strict,
      ranges,
    );
  } catch (err) {
    diagnostics.push(
      selfDiagnostic(
        'import/internal-error',
        `The checker failed on this input: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return report(diagnostics, { count: 0, roots: [] }, normalization, fileName, strict, undefined);
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

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
 * WHERE THE WORK LIVES NOW. All three stages moved to `./load.ts`, which keeps
 * the bound model as well as the report so that headless ANALYSIS (metrics,
 * requirement coverage, traceability, where-used) has a model to work on. This
 * file is the projection of that result onto the report alone — the contract
 * agents and the CLI were already written against, unchanged.
 *
 * FAIL DIRECTION. `checkText` never throws. An internal failure is reported as
 * an `import/internal-error` diagnostic with `ok: false`, because a checker
 * that crashes silently would let a broken model through as "clean" — the
 * conservative verdict is the one that costs least when wrong.
 */

import { loadModelText, type CheckReport, type LoadOptions } from './load';

/**
 * Options for {@link checkText} — the loader's options, since checking is
 * loading and then discarding the model.
 */
export type CheckOptions = LoadOptions;

export type { CheckReport, Normalization, LoadOptions, LoadResult } from './load';

/**
 * Check a source text and report everything wrong with it.
 *
 * Never throws. Resolves to a `CheckReport` whose `ok` is the single boolean an
 * automation should branch on. Use {@link loadModelText} instead when you also
 * want the model the report is about.
 */
export async function checkText(text: string, opts: CheckOptions = {}): Promise<CheckReport> {
  return (await loadModelText(text, opts)).report;
}

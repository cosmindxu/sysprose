# Sysprose — project rules

Pure-browser system modeler with an AI-agent focus: models are developed as textual
definitions, and the app is exercised by agents driving it in a browser.

## Naming, trademarks and claims

**These rules hold for as long as Sysprose is not certified.** They are not style
preferences — they keep the project's public statements true. See "If the tool is ever
certified" below for what lifts them.

Sysprose implements a **SysML v2–style textual notation** and an **OMG-API-shaped
element graph**. It has **never been conformance-tested or certified** by the OMG or
anyone else. Therefore:

1. **Never call the product conformant, compliant or certified.** Not "OMG-conformant
   server", not "spec-conformant client", not "SysML v2 compliant". Say **spec-shaped**,
   **OMG-shaped**, **OMG-API-shaped**, or "written from the published specification".
   Negated forms are fine and wanted: "not certified", "never conformance-tested".
2. **Never use an OMG, SysML or KerML logo, wordmark or brand asset**, and never embed
   an image from `omg.org`. The tool ships its own icon (`public/icon.svg`).
3. **Keep the disclaimers.** The README's "Name and standards status" section, the
   standards-status paragraph in `docs/LICENSES.md`, and the self-assessment banner
   atop `docs/CONFORMANCE.md` are load-bearing. Do not trim them.
4. **The conformance scorecard is a self-assessment.** `docs/CONFORMANCE.md` measures
   this project against the published specs *as this project reads them*. It is
   evidence, never a conformance claim.

### What these rules do NOT forbid

- **Describing what the tool implements.** "Reads and writes SysML v2 textual notation"
  is descriptive use of the standard's name, and is correct and necessary.
- **The `.sysml` file extension**, and `.kerml` if ever added. These are the interchange
  extensions the specification and every other SysML v2 tool use. A private extension
  would break interchange and help nobody. A file extension is a format identifier,
  not a brand.
- **The names KerML, OMG, "API & Services", the element-graph shape** in prose and docs.
- **Internal identifiers**: `window.sysml`, `SysmlApiServer`, `SYSML_API_TOKEN`,
  `SYSMLV2_PILOT_URL`. Not public-facing brand use.
- **Statements about third parties**: "the OMG pilot server", "a conformant tool must
  preserve identity". These describe the spec
  or someone else's product.
- **The two survey documents** (`docs/01-state-of-the-art.md`,
  `docs/02-omg-standard-reference.md`) — they are about the standard and other vendors'
  tools, and are exempt from the scan.

### How this is enforced

- `test/unit/claims.test.ts` scans the whole repository each `npm test`: it fails on an
  un-negated conformance/compliance/certification claim, on any brand-asset reference,
  and if the README or conformance-doc disclaimers go missing. It is mutation-tested —
  four planted violations were confirmed caught.
- `test/unit/branding.test.ts` fails if `index.html`, `public/manifest.webmanifest` or
  `package.json` drift from `src/branding.ts`, and if the product name ever contains
  "sysml" again.

### If the tool is ever certified

Nothing here is permanent. On real certification: update the README and
`docs/LICENSES.md` statements, remove the self-assessment banner, and delete
`test/unit/claims.test.ts`. Until that day the guard stays.

## Product identity

`src/branding.ts` is the single source of truth for the product name, short name, slug,
generator id and element-graph schema URN. Anything rendering or serialising the name
imports from it. The static assets that cannot import TypeScript are held in step by the
branding test.

`LEGACY_STORAGE_DB` is deliberately still `'sysmlv2-modeler'` — it is the IndexedDB
database name, and changing it orphans every project a user has already saved. A
migration is a separate, opt-in change.

## Diagnostics for agents

Sysprose's users include AI agents that author models as text and can only act on
what the tool reports. The **Agent Diagnostics Contract**
(`docs/AGENT-TEXT-CAMPAIGN.md`) therefore binds every finding derived from source
text:

1. **Every such finding carries a `code` and a `range`.** The code comes from
   `src/text/langium/diagnostic-codes.ts` and is stable; the range is where in the
   file the problem is. Automation branches on `code`, never on `message`.
2. **A new parser, mapper or validation error site must add a catalogue entry**
   and regenerate the reference with `npm run codes`.
   `test/unit/diagnostic-codes.test.ts` fails otherwise, in both directions.
3. **Never let a check fail silently.** `checkText` reports an internal failure as
   an `import/internal-error` with `ok: false`; the CLI exits non-zero on an
   unexpected error. A silent pass is the one outcome that lets a broken model
   through.
4. **`npm run campaign` must stay green.** A fixture whose golden carries
   `expectFail` records a shortfall the tool has not fixed yet; if it starts
   passing, the runner fails so the fixture gets promoted rather than drifting.

## Layout and workflow

- Canonical remote: `github.com/cosmindxu/sysprose`. Commit as the GitHub noreply
  identity (repo-local `user.email`), never a personal address.
- Maintainer's machine (VirtualBox guest): the checkout is `~/sysprose` on the guest
  filesystem (the vboxsf share is too slow for `node_modules`); `/media/sf_Projects/Sysprose`
  is a read-only mirror written by `scripts/sync-to-share.sh` — never edit or build there.
- Always run E2E with an explicit `--config=<checkout>/playwright.config.ts` so a stray
  `vite preview` elsewhere cannot hijack the run.
- `vite`'s dev server does not work on the share; use `npm run build && npm run preview`.

## Validation gate — run before every commit

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint src/ test/ scripts/
npm test                 # vitest: unit + integration + conformance + server + interop
npm run build            # production build
npx playwright test --config="$PWD/playwright.config.ts"
npm run campaign         # agent text-authoring campaign (part of `npm test`)
```

`docs/TEST-SUMMARY.md` is generated (`npm run test:report && npm run report`). It is
git-tracked but routinely stale — keep it out of unrelated commits, or refresh it in its
own chore commit.

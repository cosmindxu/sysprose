# Sysprose

**Another system modeler** — models as prose, tested by agents in the browser. Sysprose is a
pure-browser modeling tool: author systems graphically *and* as textual definitions, validate,
analyze, simulate and automate, all client-side with **no backend required**. It exposes a
programmable **API for data analysis and automation**, with an in-browser TypeScript SDK and an
OMG SysML v2 *API & Services*–shaped query facade.

[![Sysprose showing a UAV surveillance model: the interconnection diagram of the air vehicle above the SysML v2 textual source that produced it](docs/images/sysprose-uav.png)](https://cosmindxu.github.io/sysprose/)

<p align="center"><em>An ISR unmanned air system modelled in Sysprose — the interconnection view
of the air vehicle, scoped to it, above the definition that produces it
(<a href="examples/uav-isr.sysml"><code>examples/uav-isr.sysml</code></a>; the editor shows the
serializer's normalised form of the source).
<strong><a href="https://cosmindxu.github.io/sysprose/">Try it in your browser →</a></strong></em></p>

> **AI-agent focus.** Two things make the tool agent-friendly: models are developed as *textual
> definitions* an agent can write and diff like code, and the whole app is exercised through the
> browser, so an agent can drive and test it end-to-end with a browser-automation harness (see
> the Playwright suite in `test/e2e/`).

> An academic modeling tool targeting the core authoring experience of modern MBSE
> tools, built on the OMG SysML v2 / KerML standard (adopted 2025).

**New here?** [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) is written for an engineer who has been
handed the tool and has an afternoon: the first ten minutes with the example above, the notation
you actually type, what each view answers, the one button that can lose your work, and what the
tool does and does not keep for you.

## Highlights

- **Standards-native model** — the in-memory model mirrors the OMG API element-graph (flat `@id`/`@type`, relationships reified as first-class elements), so it round-trips losslessly.
- **Graphical + textual** — multiple diagram views (General/BDD, Interconnection/IBD, Action, State, Requirement, Tree) kept in sync with the SysML v2 textual notation.
- **Validation** — a rule engine flags naming, typing, multiplicity, containment and traceability issues.
- **API-first** — query the model with OMG-shaped constraint trees, compute analytics (metrics, requirement-satisfaction coverage, traceability, where-used), and script automations.
- **Local-first** — projects persist in the browser (IndexedDB/localStorage); import/export `.sysml`, model JSON, and OMG element-graph JSON.

## Name and standards status

Sysprose implements a **SysML v2–style textual notation** and an **OMG-API-shaped element
graph**, and it is a **candidate implementation only**: it is *not* a certified or conformance-
tested SysML v2 tool, and it does not claim conformance to any OMG specification. **SysML® is a
registered trademark of the Object Management Group, Inc.** This project is not affiliated with,
sponsored by, or endorsed by the OMG. Where the documentation says "SysML v2" it refers to the
*language and API shape being implemented*, never to a certification of this tool.

## For AI agents

Sysprose is built to be driven by an agent that authors models as **textual
definitions** and repairs them from the tool's own feedback.

```bash
npm run check -- model.sysml --json     # exit 0 clean · 1 findings · 2 usage/IO
npm run sysprose -- stats model.sysml --json   # and what is IN it (see below)
```

Every finding carries a **stable code**, an exact **source range** (line, column
and offset, start and end), and a one-line **hint** naming the repair; parser
errors also carry `expected` and `found`. Branch on `code`, never on `message`.

```jsonc
{
  "code": "validation/duplicate-name",
  "severity": "error",
  "range": { "start": { "line": 3, "column": 5, "offset": 32 }, "end": { … } },
  "elementName": "A",
  "hint": "Rename one of them, or move it to a different owner. Sibling names must be unique."
}
```

The loop is: write the file, check it, go to `range.start`, apply `hint`, repeat
until `ok`. In TypeScript, `checkText(source)` from `@text/index` does the same
thing in-process and never throws.

- [`docs/DIAGNOSTIC-CODES.md`](docs/DIAGNOSTIC-CODES.md) — every code, what
  triggers it, and the repair it suggests.
- [`docs/AGENT-AUTHORING-CAMPAIGN.md`](docs/AGENT-AUTHORING-CAMPAIGN.md) — the test
  campaign that keeps this feedback good enough to act on, and the open defects
  it has found.

## What it can do, and where

Every question below has **one answer, computed in one place**, reachable through three doors: a
control in the app, a subcommand in a terminal, an import in a script. The terminal column and
the in-process column are the *same function* — each subcommand is a thin shell over the import
named beside it — so a figure printed by a command and the same figure computed in your own
script cannot disagree. The app answers the same *question*; on the unmarked rows it runs that
same function, and a **†** marks a row where it draws its own projection instead, where the two
figures may legitimately differ. Each control is named by the `data-testid` a test drives it by,
with the function that control runs.

| Capability | In the app | From a terminal | In process |
|---|---|---|---|
| Is this file sound? | **Validate** (`tb-validate` → `safeValidate`) † | `npm run check -- model.sysml` | `checkText` — `src/text/check.ts` |
| How big is it, and what shape? | API Console → **Metrics** (`api-metrics` → `modelMetrics`) | `npm run sysprose -- stats model.sysml` | `modelMetrics`, `countByMetaclass` — `src/api/analytics.ts` |
| What is in it? | **Grid** view (`tb-view-grid` → `buildGrid`) | `npm run sysprose -- elements model.sysml` | `buildGrid` — `src/diagram/grid.ts` |
| Are the requirements covered, and by what? | **Requirements** view (`tb-view-requirements` → `buildRequirementsTable`) | `npm run sysprose -- requirements model.sysml` | `requirementSatisfaction` — `src/api/analytics.ts`; `buildRequirementsTable` — `src/diagram/requirements-table.ts` |
| What satisfies, allocates or verifies what? | **Allocation** view (`tb-view-allocation` → `buildAllocationMatrix`) † | `npm run sysprose -- trace model.sysml --relation satisfy` | `traceabilityMatrix` — `src/api/analytics.ts` |
| Which ports are wired, and which dangle? | **Interconnection** view (`tb-view-interconnection` → `buildInterconnection`) † | `npm run sysprose -- connectivity model.sysml` | `connectivityReport` — `src/api/analytics.ts` |
| What breaks if I change this element? | Properties → *Used by* (`prop-used-by` → `whereUsed`), *Impact graph* (`prop-impact` → `neighboursOf`) † | `npm run sysprose -- where-used model.sysml --element X` | `impactClosure` — `src/api/analytics.ts` |
| What did I declare and never use? | — no view yet | `npm run sysprose -- orphans model.sysml` | `orphanReport` — `src/api/analytics.ts` |

**† Where the app runs something else, and why its figure can differ.** **Validate** re-runs the
rule engine over the model already open in the editor (`safeValidate`, `src/ui/store.ts`); `check`
parses a file first and then applies those same rules. The **Allocation** view tabulates only the
elements that take part in a link (`buildAllocationMatrix`, `src/diagram/matrix.ts`), where `trace`
tabulates every element of the row and column kinds and so also tells you what links to nothing.
The **Interconnection** view *draws* ports and connections (`buildInterconnection`,
`src/diagram/build.ts`) and computes no connectivity report at all. Properties → *Used by* lists
everything that references the selection, library and re-derived copies included (`whereUsed`,
`src/api/analytics.ts`), where `where-used` drops the library, walks out to the `--depth` you ask
for and says what it left out; the *Impact graph* draws one hop in each direction from its own
walk (`neighboursOf`, `src/ui/panels/ImpactGraph.tsx`). `connectivity`, `orphans` and the
depth-walking `impactClosure` have no control in the app at all — they are the terminal's and the
SDK's alone.

Every subcommand takes `-` for stdin and `--json` for `{ok, file, <report>}`, and every report is
about *your* file: the bundled standard library and the tool's own re-derived elements are
excluded, and each report says how many it left out — `stats` counts the library, `elements` the
re-derived copies, the rest both. Loading the model headlessly is `loadModelText`
(`src/text/load.ts`): the same five steps the app performs — parse, preload the library asset,
merge it, resolve type references, resolve connector chains — collected in one place. The app
still runs its own copy of them (`loadStandardLibraryAsync`, `src/ui/store.ts`), merging the
library in the background after your edit rather than binding it up front. Flags and exit codes:
[`docs/CLI-REFERENCE.md`](docs/CLI-REFERENCE.md), generated from the table the command parses.
What each control and view is *for*: [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md).

## Architecture

See [`docs/03-architecture-and-plan.md`](docs/03-architecture-and-plan.md). Layered, dependency-acyclic TypeScript modules:

| Module | Path | Responsibility |
|--------|------|----------------|
| Core | `src/core` | Metamodel + `Model` graph (CRUD, traversal, events, JSON) |
| Text | `src/text` | SysML v2 textual notation parser + serializer |
| Validation | `src/validation` | Rule-based model checker |
| API | `src/api` | In-browser SDK + OMG Query facade + analytics |
| Diagram | `src/diagram` | Model→diagram mapping, elkjs auto-layout, React Flow renderers |
| Persistence | `src/persistence` | Project store + import/export |
| UI | `src/ui` | React app: explorer, canvas, palette, properties, text editor |

## Reference docs

- [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) — the guide: the views, the notation, the hazards, and what is kept.
- [`docs/CLI-REFERENCE.md`](docs/CLI-REFERENCE.md) — every subcommand and flag of `check` and `sysprose` (generated).
- [`docs/DIAGNOSTIC-CODES.md`](docs/DIAGNOSTIC-CODES.md) — every diagnostic code, its trigger and its repair hint (generated).
- [`docs/AGENT-AUTHORING-CAMPAIGN.md`](docs/AGENT-AUTHORING-CAMPAIGN.md) — the agent-authoring test campaign and the defects it has found.
- [`docs/01-state-of-the-art.md`](docs/01-state-of-the-art.md) — survey of existing SysML v2 tools.
- [`docs/02-omg-standard-reference.md`](docs/02-omg-standard-reference.md) — OMG SysML v2 / KerML / API & Services implementer reference.
- [`docs/03-architecture-and-plan.md`](docs/03-architecture-and-plan.md) — architecture & build plan.
- [`docs/TEST-SUMMARY.md`](docs/TEST-SUMMARY.md) — per-file pass/fail/skip counts from a real run (generated by `npm run report`).
- [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md) — hand-written narrative feature-coverage report; it is dated, and `docs/CONFORMANCE.md` carries the current figures.
- [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) — what has been measured against the standard, and what has not.
- [`docs/FEATURE-PARITY.md`](docs/FEATURE-PARITY.md) — what the tool does and does not have, against the tools it is compared with.
- [`docs/UI-ROADMAP.md`](docs/UI-ROADMAP.md) — the user-interface work, done and outstanding.
- [`docs/LICENSES.md`](docs/LICENSES.md) — third-party licences, including the bundled OMG standard library.

## Develop

> Node 22. The optional corpus-conformance tests read a local checkout of the OMG `sysml.library` from `~/.stdlib-src` (override with `SYSML_CORPUS_ROOT`) and skip when it is absent.
>
> Maintainer note: if your checkout sits on a VirtualBox shared folder, keep `node_modules` on the guest filesystem and use `vite build` + `vite preview` — vboxsf breaks the dev server's file-watching.

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest unit/integration
npm run build && npm run preview   # serve the app at :4173
npm run test:e2e       # Playwright E2E (after preview is up)
npm run report         # regenerate docs/TEST-SUMMARY.md
npm run campaign       # the agent authoring testing campaign
npm run codes          # regenerate docs/DIAGNOSTIC-CODES.md from the catalogue
npm run commands       # regenerate docs/CLI-REFERENCE.md from the command table
npm run check -- <file.sysml> [--json]   # check a file from the command line
npm run sysprose -- <subcommand> <file.sysml|-> [--json]   # report on a model
                       # stats · elements · requirements · trace
                       # connectivity · where-used · orphans
                       # `npm run sysprose -- --help` lists them
```

## Deploy

Sysprose is a pure static SPA — no backend needed. `vite.config.ts` uses `base: './'`, so the build runs on any host path.

- **GitHub Pages:** enable Pages (Settings → Pages → GitHub Actions); `.github/workflows/deploy-pages.yml` builds and deploys on push to `main`.
- **Any static host:** `npm run build` → serve `dist/` (Netlify, S3, nginx, `python -m http.server`, …).
- **Optional OMG API server (REST + OSLC):** `npm run serve`, or containerized:
  ```bash
  docker build -t sysprose-api . && docker run -p 5178:5178 sysprose-api   # OpenAPI at :5178/openapi.json
  ```
  Auth is **off by default** (local-first, bind loopback). Before exposing it, set `SYSML_API_TOKEN=<secret>` to require `Authorization: Bearer <secret>` on every request (`GET /health` stays open); a strict `Content-Security-Policy` is always sent, and `CORS_ORIGINS` restricts the browser allowlist.
- **Optional collaboration relay (real-time editing via Yjs):** `npm run collab` starts a WebSocket relay (default `ws://127.0.0.1:1234`). It binds loopback-only by default (`HOST`); set an Origin allowlist with `COLLAB_ALLOW_ORIGIN`, a shared secret with `COLLAB_TOKEN=<secret>` (clients then connect with `?token=<secret>`), and bound load with `COLLAB_MAX_ROOMS` (default 512) / `COLLAB_MAX_CONNS_PER_ROOM` (default 256) before exposing it.

## License

MIT — except the bundled OMG standard library under `src/library/std/` (EPL-2.0, attributed; see `docs/LICENSES.md`).

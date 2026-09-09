# Sysprose

**Another system modeler** — models as prose, tested by agents in the browser. Sysprose is a
pure-browser modeling tool: author systems graphically *and* as textual definitions, validate,
**verify**, analyze, simulate and automate, all client-side with **no backend required**.
Validation asks whether the model is *well formed*; verification asks whether what the model
*says* is true — and refuses to answer, out loud and with a reason, when it cannot. It exposes a
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
- **Formal verification, from a terminal** — read every requirement as the assume/guarantee pair its own `assume` and `require` clauses state, decide it with an SMT solver or say honestly that nothing decided it, find the subset of a requirement set that conflicts, check whether the parts deliver what the whole promised, walk a state machine exhaustively rather than one run at a time, and write the verdict back into the file, where it goes stale the moment the design changes.
- **API-first** — query the model with OMG-shaped constraint trees, compute analytics (metrics, requirement-satisfaction coverage, traceability, where-used), and script automations.
- **Local-first** — projects persist in the browser (IndexedDB/localStorage); import/export `.sysml`, model JSON, and OMG element-graph JSON.
- **A kind for every statement** — one keyword says whether a statement binds (`#'requirement'`), explains (`#prose`) or is guidance for an agent (`#prompt`); coverage counts the first, and the guidance is collectable for whatever it applies to.

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

A model can also tell you what each of its statements is **for**. One keyword in
front of a declaration — `#'requirement'`, `#prose` or `#prompt` — separates a
statement that binds from an explanation that does not, and from guidance
written for you rather than for a reader. Coverage counts requirements alone and
says what it left out; the requirement rules pass over the other two; and

```bash
npm run sysprose -- prompts model.sysml --element X --json
```

collects the guidance that applies to one element — what is written on it, on
what it is, and on where either sits, nearest first, each with its provenance
and its words. The three values are this project's own; the way they are written
is the specification's own user-defined keyword over a metadata definition
(§7.27.1, §7.27.4), so nothing about the notation is invented. How to write one:
[`docs/USER-GUIDE.md` §7](docs/USER-GUIDE.md#7-three-kinds-of-statement).

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
| What guidance applies to this element? | — no view yet | `npm run sysprose -- prompts model.sysml --element X` | `promptsFor` — `src/api/analytics.ts` |
| What does each requirement assume and guarantee, and on which subject? | **Contracts** view (`tb-view-contracts` → `buildContractsTable`) † | `npm run sysprose -- contracts model.sysml` | `contractReport` — `src/api/verification.ts` |
| What must be shown, over which axioms, and what do the gates refuse? | — no view yet | `npm run sysprose -- obligations model.sysml` | `obligationsReport` — `src/api/verification.ts` |
| How do I write a clause this tool will accept, over which names? | — no view yet | `npm run sysprose -- property-draft model.sysml --element X` | `propertyDraft` — `src/api/property.ts` |
| Would this clause pass the gates, and what does it actually say? | — no view yet | `npm run sysprose -- property-check model.sysml --element X --clause 'u.mass <= 25.0 [kg]'` | `propertyCheck` — `src/api/property.ts` |
| Does each obligation hold, by which engine, and under what bound? | — no view yet | `npm run sysprose -- verify model.sysml --engine literal` | `verifyModel` — `src/api/verification.ts` |
| Can all the requirements on this subject hold at once, and if not, which conflict? | — no view yet | `npm run sysprose -- consistency model.sysml` | `consistencyReport` — `src/api/verification.ts` |
| Do the component contracts entail the system contract, and is every component assumption discharged? | — no view yet | `npm run sysprose -- refine model.sysml --via composition` | `refinementReport` — `src/api/verification.ts` |
| What is the tightest value this measure can take under the model's axioms? | — no view yet | `npm run sysprose -- bounds model.sysml --measure uav.mtow` | `boundsReport` — `src/api/verification.ts` |
| Which combinations of contract failures break the top requirement? | — no view yet | `npm run sysprose -- fault-tree model.sysml --max-order 2` | `faultTreeReport` — `src/api/verification.ts` |
| What was shown, by which tool, over which model — and does it still hold? | **Requirements** view → *Evidence* column (`tb-view-requirements` → `buildRequirementsTable`) † | `npm run sysprose -- evidence-status model.sysml` | `evidenceStatus` — `src/api/evidence.ts` |
| Write the verdicts of a run into the file, as annotations on what they are about | — no view yet | `npm run sysprose -- evidence-attach model.sysml --from evidence.json` | `attachEvidence` — `src/api/evidence.ts` |
| Take every record back off the file, and the verdict facets with them | — no view yet | `npm run sysprose -- evidence-detach model.sysml` | `detachEvidence` — `src/api/evidence.ts` |
| Which states are reachable, which transitions are dead, where did the simulator hide a choice? | — no view yet | `npm run sysprose -- reach model.sysml` | `reachReport` — `src/semantics/mc/explore.ts` |
| Does this safety pattern hold on every reachable configuration? | — no view yet | `npm run sysprose -- check-behaviour model.sysml --element FlightModes --pattern 'pattern=absence, scope=globally, p=state failsafe'` | `behaviourReport` — `src/semantics/mc/patterns.ts` |

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
walk (`neighboursOf`, `src/ui/panels/ImpactGraph.tsx`). The **Requirements** view *reads* the
evidence a run left behind and shows it as one read-only column
(`buildRequirementsTable`, `src/diagram/requirements-table.ts`, which asks `evidenceStatus` once
per revision): `current` / `stale` / `unrecorded`, with the record's claim word beside it and the
requirement's slice in the tooltip, where `evidence-status` prints every row with its digest, its
slice and its `verification/*` code. Nothing in the app writes a verdict.
The **Contracts** view *projects* the same inventory through
`buildContractsTable` (`src/diagram/contracts-table.ts`), which asks `contractReport` once per
revision and keeps the rows and the census it returns, where `contracts` also prints the keyword
inventory, the exclusion counts and the `verification/*` reasons behind every refusal — and,
unlike the view, can be asked about one element. `connectivity`, `orphans`, `prompts`,
`obligations`, `verify`, `evidence-attach`, `evidence-detach` and the depth-walking
`impactClosure` have no control in the
app at all — they are the terminal's and the SDK's alone. There is no solver in the browser
(`SharedArrayBuffer` needs COOP/COEP headers GitHub Pages cannot set), so no view reaches a
verdict: the two that read this lane show what a run left behind and print the command that
produces one.

**Somebody else's `#keyword` vocabulary is read, kept and never acted on by accident.** A prefix
keyword is the notation's own extension point (SysML v2 §7.27.1, §7.27.4); Sysprose stores every
one exactly as written and hands it back unchanged on save, whoever's tool it was written for.
`contracts --keywords` inventories them with what each resolves to — its own vocabulary, a
third-party spelling named as such, or a keyword that names no `metadata def` in scope — and
changes nothing. The one door through which a foreign spelling may reach a worklist is
`obligations --from-keywords`, which is off by default, reads a keyword only on a plain
`constraint` — never over a clause role you wrote, and never over a `calc`, whose body is the
definitional axiom the rest of the worklist stands on — and prints the keyword on every row it
files. Sysprose ships exactly one keyword of its own, `#exceptional`, over a `metadata def` you
paste into your file: it is a Sysprose extension, not standard vocabulary, and
[`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) §7 records why it is the only one of four candidates
that ships.

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

## Formal verification, from a terminal

A requirement in this notation already states a contract: its `assume` clauses are the premise,
its `require` clauses the promise, and `subject` says who both are about. The verification lane
reads that pair and decides it — or says, with a code and a reason, that it did not. It is the
largest capability in the tool, it lives in the terminal and in the SDK, and the app reads what
it left behind rather than reaching a verdict of its own.

One real run, over the shipped example, with the solver installed:

```console
$ npm run sysprose -- verify examples/uav-isr.sysml --engine smt
examples/uav-isr.sysml: 0 inconclusive, 2 discharged, 0 refuted — engine smt
  negation-unsat under a satisfiable axiom set — `proved` means exactly that, at 5000 ms per check, with every feature value bound as the model states it
  UAVSurveillanceSystem::EnduranceRequirement  uav.endurance >= 45.0 [min]
    proved: A ∧ P ∧ ¬G unsat, QF_NRA, 4 fixed / 0 free, timeout 5000 ms; assumptions satisfiable
    bound: every feature at the value the model binds it to; 4 symbol(s), 0 free; compared as 2835.6923076923076 vs 2700 in T, coherent SI; decided by z3 Z3 5.1.0.0, seed 0
    digest sha256:e4618d6fd278f0b61d3cfb371ee1c3ec8fad02a0cf2ad962e1a34179c845490e
  UAVSurveillanceSystem::MassRequirement  uav.mtow <= 25.0 [kg]
    proved: A ∧ P ∧ ¬G unsat, QF_LRA, 1 fixed / 0 free, timeout 5000 ms; assumptions satisfiable
    bound: every feature at the value the model binds it to; 1 symbol(s), 0 free; compared as 18.5 vs 25 in M, coherent SI; decided by z3 Z3 5.1.0.0, seed 0
    digest sha256:24296a7c6a06b2e66207cc2c3f3dac028f58123a199b55cbf7842f45ef02d545
  model sha256:4b48f0ed02c1e05425881beb3b29f0cce8f3a7cff55605eb12759174ba31e9a2
  sysprose 0.1.0 (git …) · standard library 38761 element(s)
```

That is a real run of this repository, copied out of the terminal; only the commit sha in the
provenance line is elided, because it changes with every commit and nothing about the verdict
depends on it.

Read the shape rather than the numbers. Every line carries its own warrant: which question was
asked (`A ∧ P ∧ ¬G unsat`), in which fragment, over how many symbols and how many of them were
freed, under what timeout, by which solver build — and the digest of the obligation, so the same
answer can be recognised again after an edit. The same lane also asks whether a requirement set
can hold at once and names the subset that conflicts (`consistency`), whether the parts deliver
what the whole promised (`refine`), how tight a measure can get (`bounds`), which combinations of
contract failures break the top requirement (`fault-tree`), which configurations a state machine
can reach and whether a safety pattern survives all of them (`reach`, `check-behaviour`), and it
writes verdicts back into the file as annotations that go stale when the design moves
(`evidence-attach`, `evidence-status`). All of them are among the **22 subcommands** listed in the
Develop block below, and every flag is in
[`docs/CLI-REFERENCE.md`](docs/CLI-REFERENCE.md).

**What it will not print, and where it goes red.**

- **`proved` means one thing** — the negation of the goal is unsatisfiable under an axiom set that
  is itself satisfiable, non-vacuously. Never from a point evaluation, never from a bounded walk,
  never from a solver that was not there. `--engine literal` evaluates at the values you wrote and
  says `holds-at-values`, which is a different sentence.
- **A missing solver turns the build red, not green.** With no z3 available, `--engine auto` and
  `--engine smt` report `verification/tool-absent` on every obligation and exit **2** —
  inconclusive — and `--allow-inconclusive` does not lower it: that flag reaches only timeouts and
  unsupported constructs. This is the path most likely to rot into a silent pass, so CI runs it on
  every push with the solver switched off and asserts the exit code.
- **A requirement discharged by a false assumption is `vacuous`, not a pass** — a declared
  deviation from the specification's own `RequirementCheck` semantics, recorded as one in
  [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) §8.
- **No liveness, no reactive synthesis, no in-browser solver, no kernel-checked proof.** z3 is trusted
  as a solver; nothing here is machine-checked in a proof kernel. The limits are listed, each with
  what it costs you, in [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) §9 and
  [`docs/04-formal-verification-plan.md`](docs/04-formal-verification-plan.md) §6.

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
- [`docs/04-formal-verification-plan.md`](docs/04-formal-verification-plan.md) — the formal-verification lane: what each tool decides, what it may never say, and the commit order that builds it.
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
                       # connectivity · where-used · orphans · prompts
                       # contracts · obligations · property-draft
                       # property-check · verify · consistency · refine
                       # bounds · fault-tree · evidence-status
                       # evidence-attach · evidence-detach
                       # reach · check-behaviour
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

# Sysprose — Feature-Parity Matrix vs. Modern Tools

*Generated: 2026-07-03*

This document places the pure-browser SysML v2 modeling tool side-by-side with the
two reference classes of modern SysML tool: the **incumbent commercial desktop
modeler** (SysML v1 today with a v2 track) and the **OMG-aligned open-source web
modeler**. Each row is a capability that a modern SysML modeling tool
is expected to provide. The **This tool** column is a candid **Yes / Partial /
—** self-assessment, and the final column cites the **actual test(s)** that
exercise it (unit `U`, integration `I`, conformance `C`, server `S`, interop `X`,
end-to-end `E`). Test names match `test/**` and the verdict tables in
`docs/TEST-REPORT.md`.

Legend — **Yes**: capability present and (for us) test-covered; **Partial**: a
representative subset is present / a facet is missing; **—**: not implemented.

---

## 1. Modeling workspace & navigation

| Capability | Commercial desktop tool | Open-source web tool | **This tool** | Covered by test(s) |
|---|---|---|---|---|
| Model explorer / containment tree | Yes | Yes | **Yes** | `E explorer-crud`, `E explorer-interactions` (expand/collapse, create, rename, delete-cascade, reparent); `U core.model` (containment index) |
| Multi-view workspace / view tabs | Yes | Yes | **Yes** | `E view-switching` (all 12 `tb-view-*`); `E diagram-create-connect` |
| Per-metaclass tree type icons | Yes | Yes | **Yes** | `iconFor()` renders a category glyph per row (Explorer.tsx); `E gui-navigation` asserts `.tree-icon` |
| Explorer search / filter + hide-library + focus + breadcrumb | Yes | Yes | **Yes** | `E gui-explorer` (search + count, library toggle, ◎ focus/scope-to-subtree), `E gui-navigation` (breadcrumb path); selection-reveal keeps the two parallel trees in sync |
| Element search / query navigation | Yes | Yes | **Yes** (via API console) | `E api-console2` (query → tabulated rows), `U api.query`/`api.query2` |

## 2. Graphical diagrams (view kinds)

| Capability | Commercial desktop tool | Open-source web tool | **This tool** | Covered by test(s) |
|---|---|---|---|---|
| BDD / General (definitions view) | Yes | Yes | **Yes** | `U diagram.build`; `I pipeline.diagram`; `E view-switching` (`view-general`), `E palette-per-view` (general) |
| IBD / Interconnection | Yes | Yes | **Yes** | `U diagram.build` (nested parts, boundary ports, connections); `E diagram-create-connect`, `E palette-per-view` (interconnection) |
| Activity / Action flow | Yes | Yes | **Yes** | `U diagram.build` (actions + control nodes + successions); `E view-switching` (`view-action`), `E palette-per-view` (action) |
| State machine | Yes | Yes | **Yes** | `U diagram.build` (states + labelled transitions); `E view-switching` (`view-state`), `E palette-per-view` (state) |
| Sequence | Yes | Partial | **Yes** | `U diagram.sequence` (lifelines/messages/scoping); `E view-switching` (`view-sequence` → `sequence-view` SVG) |
| Requirement | Yes | Yes | **Yes** | `U diagram.build` (req + satisfier + satisfy edge); `E view-switching` (`view-requirement`), `E palette-per-view` (requirement) |
| Parametric | Yes | Partial | **Yes** | `U diagram.parametric` (constraint nodes, params, `bind` edges); `E view-switching` (`view-parametric`), `E palette-per-view` (parametric); `E solve` (`tb-solve` numeric solve + MoE results in Problems) |
| Use-case / Case | Yes | Yes | **Yes** | `U diagram.case`; `E diagram-views3` (`21-view-case`), `E palette-per-view` (case) |
| Package / Tree | Yes | Yes | **Yes** | `U diagram.build`; `I pipeline.diagram`; `E view-switching` (`view-tree`), `E palette-per-view` (tree) |
| Allocation (matrix) | Yes | Partial | **Yes** | `U diagram.matrix` (rows×cols from Allocation/Satisfy); `E view-switching` (`view-allocation` → `matrix-view`) |
| Grid / table view | Yes | Yes | **Yes** | `U diagram.grid`; `E diagram-views3` (`grid-view` rows/headers + row-select) |
| Geometry / spatial | Yes (3D/geometry module) | Partial | **Yes** | `U diagram.geometry3d` (pure `buildGeometryScene`: shapes from `attrs.shape`/library-shape typing, explicit vs. deterministic-3D-grid positions, sizes, colours, containment `parentId`, library exclusion, bounds); `E geometry3d` (real Three.js/WebGL `<canvas>` render + raycast click, 0 console errors); `E view-switching`/`E diagram-views2` (`view-geometry` → `geometry-3d`). Real 3D WebGL view (Three.js, lazily code-split into a separate chunk) — was a 2D placement projection |
| Diagram auto-layout | Yes | Yes | **Yes** | `U diagram.layout`/`diagram.layout2`; `I pipeline.diagram` (all graph views); `E toolbar-lifecycle` (`tb-layout`) |
| Graphical model-interchange (standard file format) | Yes (native) | Yes (native) | **Partial** | OMG has not standardized a graphical interchange format for v2, but the modeler exports every laid-out diagram as a de-facto vector interchange: **SVG** (`tb-export-svg` → pure `svgFromDiagram` over the store's laid-out graph — each node in its SysML shape + «keyword»/name, each edge clipped to the shape borders with per-kind markers) and **PNG** (`tb-export-png`, browser canvas rasterisation of that SVG); `U diagram.svg-export` |

## 3. Authoring gestures

| Capability | Commercial desktop tool | Open-source web tool | **This tool** | Covered by test(s) |
|---|---|---|---|---|
| Palette-based element creation (per view) | Yes | Yes | **Yes** | `E palette-per-view` (node tool creates PartUsage/ActionUsage/StateUsage/RequirementUsage/ConstraintUsage/UseCaseUsage/Package across 9 views) |
| Connection drawing (click-to-connect) | Yes | Yes | **Yes** | `E palette-per-view` (edge tool wires Specialization/ConnectionUsage/Succession/TransitionUsage/Satisfy/BindingConnector/Include); `E diagram-edges` (edges render) |
| Tree context create / delete | Yes | Yes | **Yes** | `E explorer-crud`, `E explorer-interactions` (`tree-add`, `tree-delete`, metaclass picker) |
| Drag-drop tree reparent | Yes | Yes | **Yes** | `E explorer-interactions` (HTML5 dragstart/dragover/drop reparents in the model); `U core.model` (cycle-guard) |
| Manual node move (drag on canvas) | Yes | Yes | **Yes** | `E diagram-node-drag` (mouse drag persists position via `onNodeDragStop`) |
| Inline rename (dblclick, Enter/Escape) | Yes | Yes | **Yes** | `E explorer-interactions` (dblclick→Enter commits; Escape cancels); `E text-sync` |
| Properties / specification editing | Yes | Yes | **Yes** | `E properties-all-fields` (name, shortName, type, value, multiplicity, direction, reqId, text, trigger, guard, effect, doc); `E properties` |
| Undo / redo | Yes | Yes | **Yes** | `E undo-redo`; `E keyboard-shortcuts` (Ctrl/⌘+Z, +Y, +Shift+Z) |
| Keyboard shortcuts | Yes | Yes | **Partial** | Undo/redo/save wired (`E keyboard-shortcuts`, `src/ui/commands.ts`); no rich accelerator set (delete/copy/paste chords) |
| Real-time multi-user collaboration | Partial (server product) | Yes (live web sessions) | **Yes** | Yjs CRDT co-editing + live presence: `E collab` (two browser contexts, same room, auto-connect → element created in one converges into the other's model + Explorer, and a remote selection lights up a peer-coloured highlight; roster shows ≥2 participants, 0 console errors); `U collab.binding` (deterministic Model↔Y.Doc CRDT convergence: add/update/remove/reparent/attrs, offline-then-merge). Open rooms (academic use, no auth); browser client = `WebsocketProvider` + `y-indexeddb` + awareness, relayed by the Node-only `npm run collab` server |

## 4. Textual notation

| Capability | Commercial desktop tool | Open-source web tool | **This tool** | Covered by test(s) |
|---|---|---|---|---|
| Textual SysML v2 notation editor | Partial | Yes | **Yes** | `E text-sync`, `E panels-problems-text` (`text-editor`, `text-apply`, dirty status) |
| Text → model parse | Partial | Yes | **Yes** | `E panels-problems-text` (Apply adds `part def Gearbox`); `U langium.grammar`, `U text.parser` |
| Model → text serialize (live regen) | Partial | Yes | **Yes** | `E text-sync`, `E panels-problems-text` (rename regenerates text); `U text.roundtrip` |
| Bidirectional sync + round-trip stability | Partial | Yes | **Yes** | `I pipeline.roundtrip`; `C roundtrip` (all standard models); `C corpus` (100% real-corpus parse, 0-error) |
| Grammar coverage vs. OMG BNF | n/a | Substantial | **Substantial** | `scripts/grammar-coverage.ts` (94/94, 100% of corpus); Langium default parser |

## 5. Analysis, validation & execution

| Capability | Commercial desktop tool | Open-source web tool | **This tool** | Covered by test(s) |
|---|---|---|---|---|
| Model validation + navigable diagnostics | Yes | Yes | **Yes** | `E validation`, `E panels-problems-text` (Validate → `problem-row` → selects element); `U validation.rules` (15 rules, 33 cases) |
| Constraint / requirement checking | Yes | Partial | **Yes** | `E simulate-check` / `E toolbar-lifecycle` (`tb-check` → constraint-check rows); `U semantics.constraints` |
| Behavioral simulation / execution | Yes (simulation toolkit) | Partial | **Yes (fuller)** | Deepened token-flow engine: composite/call sub-behaviors (recursive, depth-bounded, enter/exit + result params), object/item-flow data passing between pins, hierarchical state machines (composite entry/exit cascade, history resume), orthogonal regions with completion join, and timed `after(n)` transitions on a discrete clock; unified `executeBehavior`. Now driven from an **interactive simulation panel** (step / play-pause / seek a trace, inject events, live active-state highlight on the state diagram, plus a per-sample value plot). `E simulate`, `E execution`, `E gui-simulation` (`tb-simulate` composite trace + produced data + stepper UI), `E simulate-check`; `U simulate`, `U semantics.execute`/`execute-full`/`execution-full`; `I execution.integration`, `I semantics-exec.integration` |
| Parametric / equation solving | Yes | Partial | **Yes** | Numeric constraint solver + MoE evaluation + optimization, now with **inequality + feasibility** constraints (`U semantics.solver`, `U semantics.solver-ineq`, `I analysis.integration`, `E solve` — `tb-solve` solves the chain, propagates bindings, converges coupled systems, evaluates MoEs, optimizes over bounded variables **subject to inequality constraints**, and reports **feasibility + violated constraints**); `gatherInequalities` normalises comparison bodies (`<`,`<=`,`>`,`>=`) to `g(x)<=0`, `solveFeasible` finds a penalty-minimising feasible point, `checkConstraintsNumeric` flags violations for the Check/Problems surface; the solver is **unit-aware** — relations are scaled to SI behind four gates that compare DIMENSIONS (so a length against a duration is refused, not answered), values stay in their declared unit, slack carries its SI unit, a scaled relation is solved and judged relative to its own SI magnitude, and a body's `[unit]` literals are lowered instead of dropped, so a relation either agrees with the validation surface or is reported `unknown` on both (`U semantics.solver-units` — a **unit-aware, number-level agreement suite**: solved values, slack + unit, convergence, feasibility; `I uav-example` runs the shipped example through both surfaces); constraint evaluation + report (`U semantics.expr`, `U semantics.constraints`) |
| Unit / quantity / dimensional analysis | Yes | Partial | **Yes** | `E properties-all-fields` (`prop-dimension`, `prop-unit-convert` kg→t = 1.5); `U semantics.units`, `I units.integration` |

## 6. Libraries, data & interoperability

| Capability | Commercial desktop tool | Open-source web tool | **This tool** | Covered by test(s) |
|---|---|---|---|---|
| Standard model libraries (KerML/ISQ/SI…) | Yes | Yes | **Yes (full)** | `U library.load`, `I full-library.load`/`full-library.resolve` (38,761 elements / 98 packages) |
| Import `.sysml` textual | Partial | Yes | **Yes** | `E import-export` (import replaces model); `U persistence.io` |
| Export `.sysml` textual | Partial | Yes | **Yes** | `E toolbar-lifecycle`, `E import-export` (`tb-export-sysml` → `package VehicleModel`) |
| Native model JSON import/export | Yes (project files) | Yes | **Yes** | `E toolbar-lifecycle` (`tb-export-json` + import round-trip); `U persistence.io` |
| OMG element-graph JSON (API interchange) | Yes (API) | Yes (API) | **Yes** | `E toolbar-lifecycle` (`tb-export-api-json`); `U persistence.io` (idempotent, OMG shape); `C roundtrip` |
| JSON-Schema validation of interchange | Partial | Partial | **Yes** | `C` scorecard (`docs/CONFORMANCE.md`): `api-json` validates against OMG element-graph schema |
| FMI 3.0 interop + co-simulation ([fmi-standard.org](https://fmi-standard.org/)) | Yes (with physics FMUs) | — | **Yes (browser-native subset)** | Export a block → FMI 3.0 `modelDescription.xml` / STORED `.fmu` (`E gui-fmi-export`, `U fmi-export`); import an external engine's modelDescription/`.fmu` → SysML block (`E gui-fmi-import`, `U fmi-import`); a fixed-step Jacobi **co-simulation master** couples FMU instances on one clock — a SysML block runs as an FMU via the parametric solver, alongside analytic FMUs, with a WASM fmi3 FMU as the documented plug-in point (`U fmi-cosim`, 21 cases). No native/physics FMU execution (a browser can't run a `.fmu`'s native binary) |

## 7. API, services & versioning

| Capability | Commercial desktop tool | Open-source web tool | **This tool** | Covered by test(s) |
|---|---|---|---|---|
| Programmable API / automation SDK | Yes (Open API/macros) | Yes (Java services) | **Yes** | `E api-console`/`api-console2` (`window.sysml` live SDK); `U api.sdk`; `I persist-api.sdk` |
| In-app data-analysis console | Partial | Partial | **Yes** | `E api-console2` (`api-query`/`api-run`, `api-metrics`, `api-satisfaction`, `api-whereused`) |
| Query language (operators, paging, orderBy) | Yes | Yes | **Yes** | `U api.query`/`api.query2` (operators, `matches`, cursor/offset paging, orderBy) |
| REST API server (OMG API & Services) | Yes (pilot) | Yes | **Yes** | `S api-server` (live HTTP/Express); `C api-contract` (10/10 endpoints vs OpenAPI 3.1.1) |
| OpenAPI contract conformance | Partial | Partial | **Yes** | `C api-contract` (22 checks) |
| OSLC PSM (catalog / query / shapes) | Yes (plugins) | Partial | **Yes** | `U api.oslc`; `S oslc-rdf`/`oslc-shapes`; `C oslc-conformance` (Turtle/RDF-XML/JSON-LD + ResourceShape) |
| Interop with OMG pilot reference API | Yes | Yes | **Partial** | `X self-roundtrip` (self round-trip over HTTP); live pilot read 300 elements + write a `Package` (`docs/CONFORMANCE.md` §6). Representative, not full-model migration |
| Versioning: projects/branches/tags/commits | Partial (server product) | Partial | **Yes** | `U api.versioning`, `U api.rest2` (branches/tags/commits/history); `E api-console2` (commit advances head, lists ids) |
| Commit diff | Yes | Partial | **Yes** | `U api.versioning` (added/removed/changed) |
| 3-way merge / branch merge | Yes | Partial | **Yes** | In-UI Versions tab drives the engine: `E merge` (commit → branch → divergent edit → conflicting edit → merge with `theirs` produces a merge commit + reports the per-element conflict; `manual` reports conflicts and produces no commit); `U api.versioning` (3-way merge over common ancestor, `ours`/`theirs`/`manual`, change-change/change-remove conflicts) |
| Concurrent-writer serialization | Yes (server) | Yes (server) | **Yes** | `S concurrency`/`concurrency-full` |

## 8. Deployment posture (context)

| Capability | Commercial desktop tool | Open-source web tool | **This tool** | Notes |
|---|---|---|---|---|
| Runs fully in-browser, offline, static-hostable | — (desktop) | — (server-backed) | **Yes** | Entire engine/API/persistence is client-side; E2E runs against a static `vite preview` build with no app server |
| Optional networked REST/OSLC server | Yes | Yes | **Yes** | `src/server` Express adapter, exercised under `test/server` |

---

## Summary — where we stand vs. the modern tools

**At parity (Yes, test-covered):** model explorer with full CRUD + drag-reparent;
**12 diagram view kinds** with auto-layout; palette element creation and
click-to-connect across 9 views; manual node drag; properties/specification
editing of every field; undo/redo; textual notation with live bidirectional sync
(Langium, 100% corpus parse); 22-rule validation with navigable diagnostics;
constraint checking, behavioral (action + state) simulation driven from an
**interactive stepper/playback panel** (step, play-pause, seek, inject events,
live active-state highlight + value plot), a **numeric
parametric constraint solver** with measure-of-effectiveness evaluation,
inequality + feasibility constraints, and constrained gradient-free
optimization (`tb-solve`), and an **FMI 3.0 interface** (export/import
modelDescription/`.fmu` + an in-browser fixed-step co-simulation master);
**full** standard
libraries (38.8k elements) with unit/dimensional conversion; `.sysml` / model-JSON
/ OMG element-graph import & export; a programmable SDK + in-app analytics
console; a **networked REST server** validated against OpenAPI 3.1 plus an **OSLC**
PSM; and Git-like project/branch/tag/commit versioning with diff **and an in-UI
3-way branch merge** (Versions tab: commit, branch, switch, and merge with
`ours`/`theirs`/`manual` conflict resolution); and **real-time multi-user
collaboration** (Yjs CRDT co-editing + live presence: a `Collaborate` toolbar
control joins an open room, mirrors the live model through a Y.Doc, and shows
remote peers with per-peer colours + remote-selection highlights — `E collab`
two-context convergence, `U collab.binding` deterministic CRDT merge). On
**offline, static-hostable, pure-browser** deployment we **exceed** both
reference tools (the commercial one is desktop; the open-source one is server-backed).

**Partial (candid):** the geometry view is now a real interactive 3D WebGL scene
(Three.js: orbit/zoom, per-part solids, raycast selection), though it renders
primitive solids (box/sphere/cylinder) from model attributes/shape typings rather
than full CAD B-rep geometry (commercial tools integrate a richer CAD kernel); keyboard
shortcuts cover undo/redo/save only; behavioral execution now covers composite/call actions,
object/item-flow data passing, and hierarchical/orthogonal/timed state machines
(a fuller subset, still not a whole commercial simulation toolkit); FMI co-simulation
is present as a **fixed-step Jacobi master** over the parametric solver and analytic
FMUs, but cannot execute a real `.fmu`'s native/physics binary in the browser —
that plugs in only via a WASM-compiled fmi3 FMU behind the `Fmi3Instance` interface;
pilot-API interop is a **representative** exchange
(read 300 real elements + write a `Package`), not a full-model migration.

**Not implemented (—):** a *standardized* **graphical diagram-interchange** file
format (none exists for OMG v2) — though diagrams now export as de-facto **SVG**
and **PNG** vector/raster interchange (`tb-export-svg`/`tb-export-png`). Real-time multi-user collaboration — previously
the headline gap — is now **implemented** (Yjs CRDT + live presence, open rooms
for academic use). The remaining gap is the honest one, mirrored in
`docs/TEST-REPORT.md` §6.

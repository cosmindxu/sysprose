# Sysprose — Architecture & Implementation Plan

*A pure-browser SysML v2 modeling tool with an API for data analysis and automation.*

Status: **active** · Derived from `01-state-of-the-art.md` + `02-omg-standard-reference.md` and their build implications.

---

## 1. Vision & constraints

Build an **academic SysML v2 modeling tool that runs entirely inside a browser window** (no mandatory server), offering the core authoring experience of modern tools (MagicDraw/Cameo, Eclipse SysON, Rhapsody) — a model explorer, graphical diagrams, a synchronized textual notation editor, properties editing, validation, and project save/load — **plus a programmable API** for data analysis and automation.

**Hard constraints**

1. **Pure browser.** Everything (model engine, parser, layout, persistence, API) runs client-side. Static-hostable; works offline.
2. **Standards-native.** The in-memory model mirrors the OMG **SysML v2 API & Services** element-graph (flat `@id`/`@type`, relationships reified as first-class elements). This makes the model losslessly interchangeable and the REST facade a thin projection.
3. **API-first.** A data-analysis/automation API is a first-class deliverable, not an afterthought: an in-browser TypeScript SDK **and** an OMG-API-shaped Query facade.
4. **Testable.** Every module is unit-testable headlessly (Node/jsdom); user interactions are covered by Playwright E2E. A test report enumerates feature coverage.

**Pragmatic deviations from the "production" research recommendation** (documented so the production path is clear):

| Concern | Production path (research) | This build's choice | Why |
|---|---|---|---|
| Textual DSL | Langium LSP in a Web Worker + Monaco | **Hand-written tokenizer + recursive-descent parser/serializer** (pure TS), editor = textarea/Monaco-lite | Fully headless-testable, zero worker/LSP integration risk, total control over the subset. Langium is the documented upgrade. |
| Persistence | Dexie + OPFS + SQLite-Wasm | **Pluggable store**: in-memory + `localStorage` + optional IndexedDB | Same interface; IndexedDB is enough for the model sizes in scope and testable under jsdom/fake-indexeddb. |
| REST API | OpenAPI server mounted via Service Worker | **In-process OMG-API-shaped facade** (same resource model & Query semantics) + optional Node/Express adapter | The Query/SDK logic is identical and pure; a real HTTP surface is a thin wrapper added without touching core logic. |
| Diagram engine | React Flow **or** Sprotty/GLSP | **React Flow (@xyflow/react)** + custom SysML nodes/edges | MIT, pure client, custom rendering, good DX; layout via elkjs. |

---

## 2. Architecture overview

Layered, dependency-acyclic. Arrows = "depends on".

```
                     ┌─────────────────────────────────────────────┐
                     │                    ui/                        │  React app: explorer, canvas,
                     │  (React + zustand + React Flow + editor)      │  palette, properties, text editor
                     └───────────────┬───────────────┬──────────────┘
                                     │               │
              ┌──────────────────────┼───────────────┼───────────────────────┐
              ▼                      ▼               ▼                         ▼
       ┌────────────┐        ┌─────────────┐  ┌──────────────┐        ┌───────────────┐
       │  diagram/  │        │   api/      │  │ validation/  │        │ persistence/  │
       │ (ELK +     │        │ (SDK +      │  │ (rule engine)│        │ (store +      │
       │  RF maps)  │        │  Query +    │  │              │        │  import/exp)  │
       │            │        │  analytics) │  │              │        │               │
       └─────┬──────┘        └──────┬──────┘  └──────┬───────┘        └──────┬────────┘
             │                      │                │                       │
             └──────────┬──────────┴────────┬───────┴───────────┬───────────┘
                        ▼                    ▼                   ▼
                 ┌─────────────┐      ┌─────────────────────────────┐
                 │   text/     │      │            core/             │
                 │ (parser +   │─────▶│ metamodel · Model graph ·    │
                 │  serializer)│      │ factory · ids                │
                 └─────────────┘      └─────────────────────────────┘
```

**`core/` is the contract** (already implemented): `ElementRecord` (uniform node/relationship), `Model` (CRUD, containment index, change events, JSON round-trip), `ModelFactory`, metaclass catalogues & predicates, textual keyword maps. Every other module imports from `@core`.

---

## 3. Tech stack

- **Language/build:** TypeScript 5.7, Vite 6, ES2022.
- **UI:** React 18, `zustand` for app state, custom CSS (no heavy UI kit).
- **Diagramming:** `@xyflow/react` (React Flow) with custom node/edge components.
- **Auto-layout:** `elkjs` (layered + ports + nesting). Runs async (worker in prod; main-thread-safe API in this build).
- **Textual notation:** hand-written lexer/parser/serializer (`src/text`).
- **Persistence:** `localStorage` + IndexedDB behind a `ProjectStore` interface.
- **API:** in-browser SDK + OMG-API Query facade (`src/api`).
- **Testing:** Vitest (+ jsdom, Testing Library) for unit/integration; Playwright for E2E; custom report generator.

---

## 4. Module map & ownership (fan-out boundaries)

Each module is a **directory one subagent owns**, depending only on `@core` (+ siblings via their public `index.ts`). This minimizes merge conflicts during parallel development.

| # | Module | Path | Public surface | Depends on |
|---|--------|------|----------------|-----------|
| C | Core (done) | `src/core` | `Model`, `ModelFactory`, metamodel | — |
| T | Textual notation | `src/text` | `parse(src): ParseResult`, `serialize(model): string`, `serializeElement` | core |
| P | Persistence | `src/persistence` | `ProjectStore`, `exportModel`, `importModel`, `download`/`openFile` | core, text |
| V | Validation | `src/validation` | `validate(model): Diagnostic[]`, rule registry | core |
| A | API / SDK | `src/api` | `ModelApi`, `QueryEngine`, `analytics`, OMG REST facade | core |
| D | Diagram | `src/diagram` | `buildDiagram(model, viewKind)`, `layout()`, RF node/edge types | core |
| U | UI | `src/ui` | `App`, panels, commands | all above |

**Stable inter-module contracts** (defined up-front so agents don't block each other):

```ts
// text
interface ParseDiagnostic { message: string; line: number; column: number; severity: 'error'|'warning'; }
interface ParseResult { model: Model; diagnostics: ParseDiagnostic[]; }

// validation
interface Diagnostic { id: string; ruleId: string; severity: 'error'|'warning'|'info';
  message: string; elementId?: string; }

// diagram
type ViewKind = 'general'|'interconnection'|'action'|'state'|'requirement'|'tree';
interface DiagramNode { id: string; elementId: string; kind: string; label: string;
  data: Record<string, unknown>; position?: {x:number;y:number}; size?: {w:number;h:number};
  parentId?: string; ports?: {id:string;side:string;label:string}[]; }
interface DiagramEdge { id: string; elementId?: string; source: string; target: string;
  kind: string; label?: string; }
interface DiagramGraph { nodes: DiagramNode[]; edges: DiagramEdge[]; viewKind: ViewKind; }

// api
interface QueryResult { commitId: string; elements: ElementRecord[]; total: number; }
```

---

## 5. Feature scope, mapped to modern-tool capabilities

**Authoring (parity targets: MagicDraw/SysON)**

- Project: new, open, save, import, export (`.sysml`, model JSON, OMG element-graph JSON).
- Model explorer tree: hierarchical containment, create/rename/delete, drag-reparent, type icons.
- Element creation via **palette** per diagram + via tree context menu.
- **Properties panel**: edit name, multiplicity, direction, type, value, documentation, redefinition.
- **Graphical diagrams** (create/edit, auto-layout, manual move):
  - **General View** (≈ BDD): definitions/usages, «keyword» headers, attribute/port compartments, composition (filled ◆), reference (open ◇), specialization (△), feature typing.
  - **Interconnection View** (≈ IBD): nested parts, ports on boundaries, connections.
  - **Action Flow**: actions, control nodes (start/fork/join/decision/merge/done), successions.
  - **State Transition**: states, transitions with trigger/guard/effect.
  - **Requirement View**: requirements, satisfy/derive/refine, containment.
- **Textual editor** synchronized bidirectionally with the model (parse on edit, serialize on model change).
- **Validation**: on-demand + live; diagnostics list with navigation to element.
- Undo/redo; multi-view tabs.

**API / data-analysis & automation (differentiator)**

- In-browser **SDK** (`window.sysml`): navigate projects→commits→elements, mutate via commits, traverse the graph.
- **Query engine** (OMG-API-shaped): constraint trees (by type/name/attribute), select projection, scoping to a commit, pagination.
- **Analytics**: element counts by metaclass, model metrics, requirement-satisfaction coverage, traceability matrices, impact/where-used, connection/port checks.
- **Automation**: scriptable batch operations; export query results as JSON/CSV; an in-app **API console**.
- **REST facade**: OMG-shaped resource shapes (Project/Commit/Element/Query) callable in-process (and via optional Node adapter).

**Out of scope for this build** (documented as future): real-time CRDT collaboration, full standard library import, Sequence/Geometry/Parametric views, OSLC, multi-user server.

> **Addendum (post-plan scope expansion).** Every item listed above as "future"
> has since been **implemented** as the project matured from a proof-of-concept
> into an academic modeling tool. These modules were added *after* this plan and
> are not retro-fitted into the sections above; they carry their own contracts,
> path aliases, and tests:
>
> | Added module | Path | Covers |
> |---|---|---|
> | Real-time collaboration (Yjs CRDT) | `src/collab/`, `scripts/collab-server.ts` | multi-user editing, offline merge |
> | Full standard-library import | `src/library/` | ~38 k-element OMG KerML/SysML library, lazily merged |
> | Sequence / Geometry (3D) / Parametric views | `src/diagram/`, `src/semantics/` | additional diagram kinds + a numeric MoE/constraint solver |
> | OSLC-RM + REST server | `src/server/`, `src/interop/` | OMG API & Services + OSLC PSM, optional Node deployment |
>
> Rationale and per-module review are in `docs/architecture/` (the multi-agent
> review set). The security posture of the two *networked* additions (the collab
> relay and the REST server) is hardened per that review: both bind loopback by
> default and gate access (see their module headers).

---

## 6. API design (the analysis/automation surface)

Two surfaces over one implementation:

1. **`ModelApi` (TS SDK)** — ergonomic in-browser facade:
   `getProject()`, `commit(changes)`, `getElement(id)`, `elementsOfType(t)`, `query(q)`, `traverse(id, rel)`, `analytics.*`. Exposed on `globalThis.sysml` for console/automation.
2. **OMG REST facade** — `QueryEngine` + resource serializers producing OMG-API JSON. Endpoints mirrored as in-process callables (`apiFetch('/projects/:id/commits/:c/elements')`) and trivially mountable on Express.

**Query model** (faithful subset): `CompositeConstraint{and|or|not, operands}` / `PrimitiveConstraint{property, operator, value}`, optional `select` projection, evaluated against a commit, returning `Element[]` with pagination.

---

## 7. Testing strategy

- **Unit/integration (Vitest):** core, text (parse↔serialize round-trips), persistence (store + import/export round-trips), validation (rule pos/neg), api (SDK + query + analytics), diagram (model→graph mapping; layout shape).
- **Component (Testing Library):** panels, tree, properties render & interaction.
- **E2E (Playwright, headless Chromium):** every **user–tool interaction** scripted against the running app: create project → add parts → type them → draw connection → edit properties → switch to text and back → add requirement + satisfy → validate → run a query → export. Screenshots captured per scenario.
- **Test report (`docs/TEST-REPORT.md`):** feature-coverage matrix (feature/interaction → test → result), pass/fail counts, artifacts, and traceability back to this scope.

---

## 8. Build sequence (fan-out)

1. **Wave 1 (parallel):** `text`, `validation`, `api`, `diagram` — all depend only on `@core`; isolated dirs.
2. **Wave 1.5:** `persistence` (depends on core+text).
3. **Wave 2:** `ui` — integrates every module into the running app.
4. **Wave 3 (parallel):** unit/integration tests per module + Playwright E2E.
5. **Wave 4:** assemble `TEST-REPORT.md`; fix any failures; final verification.

Each wave is a `Workflow` fan-out; integration points are the public `index.ts` of each module and the contracts in §4.

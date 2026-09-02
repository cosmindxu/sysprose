# 05 — Data Flow & Model Shape

This page describes how data moves through the modeler: the in-memory
metamodel, the parse↔serialize round-trip, the mutation pipeline that keeps
the views in sync, and the import/export projections.

## In-memory metamodel

```mermaid
erDiagram
    Model ||--o{ ElementRecord : "contains (flat id map)"
    ElementRecord ||--o{ AttrValue : "attrs"
    ElementRecord }o--o{ ElementRecord : "source[] / target[] (edges)"
    ElementRecord }o--o{ ElementRecord : "ownerId (containment)"

    ElementRecord {
        string id PK
        string eClass "metaclass e.g. PartUsage"
        string name "declaredName"
        string ownerId "containment parent id"
        Record attrs "key to value bag"
        stringArray source "edge endpoint ids"
        stringArray target "edge endpoint ids"
    }
    AttrValue {
        scalar scalar
        Array array
        Record nested
    }
```

- **Uniform shape.** Every node and every relationship is an `ElementRecord`
  (`src/core/metamodel.ts`). Relationships are *reified* as first-class
  elements with `source`/`target` id arrays, not as pointers.
- **Flat id map.** `Model.elements: Map<string, ElementRecord>`; containment
  is encoded via `ownerId`, not via nested objects.
- **OMG element-graph alignment.** The shape mirrors the OMG SysML v2 API
  element-graph (`@id`/`@type`/`owningRelationship`), so the JSON form
  round-trips losslessly *at the data-model level* (textual round-trip has
  known gaps — see `08 §A`).

## Parse ↔ Serialize round-trip

```mermaid
flowchart LR
    subgraph In["Input"]
        sysml[".sysml text"]
    end

    subgraph Parse["text/ (live: Langium)"]
        lex["lex (src/text/lexer.ts)"]
        grammar["Langium grammar\n(sysml.langium)"]
        ast["generated AST"]
        mapper["astToModel\n(map-to-model.ts)"]
    end

    subgraph Core["core/"]
        model["Model (ElementRecord graph)"]
    end

    subgraph Ser["text/serializer.ts"]
        serialize["serializeModel"]
    end

    sysml --> lex
    sysml --> grammar
    grammar --> ast
    lex --> mapper
    ast --> mapper
    mapper --> model
    model --> serialize
    serialize -->|".sysml text"| out[".sysml text"]
```

- **Live parser:** Langium grammar → generated AST → `astToModel` mapper,
  exported as `parseModel` (`src/text/index.ts:18`).
- **Forward / cross-scope refs** get a second resolution pass:
  `Mapper.resolveDeferredRefs()` (`src/text/langium/map-to-model.ts`), run once at
  the end of the forward-order build, re-resolves endpoint (`sourceRef`/`targetRef`),
  `aliasFor`, and node-level specialization-array refs whose targets were declared
  later or in a sibling scope. It deliberately EXCLUDES `typeRef`/`attrs.type`,
  which stay the responsibility of `resolveTypeReferences` (`src/library/resolve.ts`).
- **Serializer:** `serializeModel` walks the containment tree and emits
  indented SysML v2 textual notation.
- **Round-trip fidelity is NOT byte-exact** (the serializer reformats), but the
  forms this doc once listed as dropped now round-trip: `:=` (initial value);
  a trailing constraint/calc `attrs.expression` (emitted after the body members);
  `#metadata` prefixes and `@`-annotations (`MetadataUsage`); import `filters`;
  `visibility`; and `ordered`/`nonunique` modifiers, plus non-identifier name
  quoting. Remaining known gaps are in `08 §A` (e.g. `InitialNode`/`DoneNode`
  still emit no valid keyword).

## Mutation pipeline (the "afterMutation" fan-out)

This is the hottest path in the app and the source of the most severe
performance findings (`08 §B`/`§D`).

```mermaid
flowchart TB
    trigger["User edit OR remote CRDT apply"]
    op["Model mutation:\ncreate / update / setAttr /\nreparent / connect / delete"]
    pushUndo["pushUndo()\nmodel.toJSON() deep clone"]
    afterMut["afterMutation()"]
    validate["safeValidate(model)\n17 rules, full scan"]
    serialize["safeSerialize(model)\nfull text regeneration"]
    bump["rev++"]
    rebuild["rebuildDiagram() [async, awaited microtask]"]
    build["buildDiagram(model, view)\nfull projection"]
    layout["layoutDiagram [elkjs, SYNCHRONOUS]\nmain-thread blocking"]
    apply["React Flow nodes/edges applied"]
    listeners[" zustand subscribers\n(Explorer, TextEditor, panels)"]

    trigger --> op
    op --> pushUndo
    op --> afterMut
    afterMut --> validate
    afterMut --> serialize
    afterMut --> bump
    afterMut --> rebuild
    rebuild --> build
    build --> layout
    layout --> apply
    bump --> listeners
    validate -->|diagnostics| listeners
    serialize -->|textBuffer| listeners

    classDef hot fill:#ffcdd2,stroke:#b71c1c
    class validate,serialize,layout,pushUndo hot
```

- **Debounced diagram rebuild.** `afterMutation` (`src/ui/store.ts:569-578`) runs
  `safeValidate` + `safeSerialize` synchronously per mutation, then coalesces the
  diagram rebuild behind an 80 ms debounce (`REBUILD_DEBOUNCE_MS`/`scheduleRebuild`,
  `src/ui/store.ts:544-552`) so a burst of edits triggers one ELK layout. A single
  `setAttr` (e.g. typing in Properties) still re-validates and re-serializes the
  whole model.
- **ELK is the synchronous bundled build** (`src/diagram/layout.ts:15`), so the
  `await` only defers a microtask; the layout CPU is on the main thread.
- **`pushUndo` retains up to 50 full deep clones** (`UNDO_LIMIT = 50`) → memory
  wall on large models.
- **Caches are not invalidated.** `semantics/resolve-names.ts` and
  `featuring.ts` keep `WeakMap<Model, Map>` caches across mutations → stale
  results after renames (a correctness bug, `08 §F`).

## Text-edit pipeline (the other direction)

```mermaid
sequenceDiagram
    actor U as User
    participant TE as TextEditor
    participant S as useAppStore
    participant P as parseModel (Langium)
    participant M as Model
    participant V as safeValidate
    participant X as safeSerialize

    U->>TE: type (keystroke)
    TE->>S: setTextBuffer (no parse)
    U->>TE: click Apply
    TE->>S: applyText(buffer)
    S->>P: parseModel(buffer)
    P-->>S: { model, diagnostics }
    S->>M: replace elements
    S->>V: validate(model)
    S->>X: serialize(model) → textBuffer
    Note over S: afterMutation() → rev++, rebuildDiagram()
```

- Typing does **not** parse — only the explicit "Apply" does (`src/ui/store.ts:918-941`).
- `parseModel` is whole-document; there is **no incremental parsing**.

## Persistence & import/export projections

```mermaid
flowchart LR
    subgraph Model["Model (in-memory)"]
        el["ElementRecord graph"]
    end

    subgraph Formats["Formats (persistence/io.ts)"]
        sysml[".sysml text\nparseModel/serializeModel"]
        mjson["model-json\ntoJSON/fromJSON"]
        ajson["api-json (OMG element-graph)\nflat @id/@type"]
    end

    subgraph Backends["ProjectStore (persistence/store.ts)"]
        mem["InMemoryStore"]
        ls["LocalStorageStore\n(synchronous, ~5MB)"]
        idb["IndexedDBStore\n(default, async)"]
    end

    el <--> sysml
    el <--> mjson
    el <--> ajson

    mjson --> mem
    mjson --> ls
    mjson --> idb
```

- `importModel` accepts any of the three formats; `exportModel` emits any.
- `createDefaultStore` prefers IndexedDB, falls back to localStorage, then
  in-memory.
- `JSON.parse` on import is wrapped (`parseJson`, `persistence/io.ts`) so a
  malformed/truncated file throws a clear `ImportError`, not an uncaught
  `SyntaxError`; the parsed value is then structurally checked
  (`isSerializedModel`/`isApiGraph` require an `elements` array) but not against
  the full element-graph schema (`08 §C`).

## Collaboration data flow

```mermaid
flowchart TB
    subgraph Local["Browser A"]
        la["Model"]
        lb["bindModelToDoc\n(model-doc.ts)"]
        ld["Y.Doc (elements/metadata maps)"]
        lw["y-websocket provider"]
    end

    relay[("Collab Relay\n(scripts/collab-server.ts)")]

    subgraph Remote["Browser B"]
        rd["Y.Doc"]
        rb["bindModelToDoc"]
        ra["Model"]
    end

    la <--> lb
    lb <--> ld
    ld <--> lw
    lw <-->|WebSocket| relay
    relay <-->|WebSocket| rd2["y-websocket"]
    rd2 <--> rd
    rd <--> rb
    rb <--> ra
```

- The `Model` ↔ `Y.Doc` binding (`src/collab/model-doc.ts`) two-way-syncs
  element maps and translates `ChangeEvent`s into CRDT updates and vice-versa.
- The relay is a pure relay — it holds per-room docs and broadcasts. It has
  **no authentication** and binds loopback (`127.0.0.1`) by default (`HOST`), but
  it now enforces an Origin allowlist (`COLLAB_ALLOW_ORIGIN`), a 10 MiB
  `maxPayload`, and room/connection caps (`COLLAB_MAX_ROOMS` 512 /
  `COLLAB_MAX_CONNS_PER_ROOM` 256), refusing excess with WS 1013 (finding M4).

## Analytics / Query / REST flow

```mermaid
flowchart LR
    subgraph Engine["In-process engine"]
        sdk["ModelApi\n(api/sdk.ts)"]
        q["evaluateQuery\n(api/query.ts)"]
        an["analytics\n(api/analytics.ts)"]
        rest["SysmlApiServer\n(api/rest.ts)"]
        oslc["OslcServer\n(api/oslc.ts)"]
    end

    sdk --> Model
    q --> Model
    an --> Model
    rest --> Model
    oslc --> Model
    an --> Semantics

    browser["window.sysml\n(in-process call)"]
    http["HTTP client"]
    browser --> sdk
    browser --> q
    browser --> an
    http -->|"apiFetch(method,path,body)"| rest
    http -->|"oslcFetch(method,path)"| oslc
```

- `window.sysml` calls the engine in-process; the Express server is a thin
  translation layer over the same `SysmlApiServer` / `OslcServer` facades.
- `analytics` and `query` both consult `semantics` (units, evaluation,
  conformance) — the undeclared dependency edge shown in `04`.
- **Inbound REST bodies are validated (finding H1).** Every mutating handler in
  `api/rest.ts` checks `req.body` against an ajv schema (`api/request-schemas.ts`)
  and returns `400` on a malformed body; the Express layer (`server/app.ts`) wraps
  each `apiFetch` in try/catch → `500` (never a hung request), and a non-string
  query `property` path no longer throws (`getProperty`, `api/query.ts`).

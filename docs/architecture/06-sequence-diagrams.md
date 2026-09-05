# 06 — Sequence Diagrams

Key runtime sequences. All are grounded in the as-built code; line references
point to the implementation.

## 1. App bootstrap

```mermaid
sequenceDiagram
    participant B as Browser
    participant Main as main.tsx
    participant S as useAppStore
    participant Lib as library/
    participant Collab as collab/
    participant RF as React Flow

    B->>Main: load index.html + bundle
    Main->>S: create store (zustand)
    S->>S: buildSampleModel() → initial Model
    S->>S: new ModelApi(model), new SysmlApiServer(model)
    S->>S: safeValidate + textView (initial)
    S->>Lib: loadStandardLibraryAsync(model) [fire-and-forget]
    Main->>RF: <App/> render
    Note over S: on library ready → rev++ → re-validate, re-serialize
    Note over S: if URL has ?room= → connect() to relay (opt-in)
```

## 2. Graphical edit → diagram rebuild (hot path)

```mermaid
sequenceDiagram
    actor U as User
    participant P as Properties panel
    participant S as useAppStore
    participant M as Model
    participant V as validation/
    participant T as text/serializer
    participant D as diagram/
    participant ELK as elkjs (sync)
    participant RF as React Flow

    U->>P: edit field, onBlur
    P->>S: setAttr(id, key, value)
    S->>S: pushUndo() → model.toJSON() [deep clone, retained ≤50]
    S->>M: setAttr → emits ChangeEvent
    S->>S: afterMutation()
    par synchronous fan-out
        S->>V: validate(model) [24 rules, full scan]
        S->>T: serialize(model) [full regeneration]
        S->>S: rev++
    and
        S->>D: rebuildDiagram()
        D->>D: buildDiagram(model, view)
        D->>ELK: await layout(root) [main-thread CPU]
        ELK-->>D: positioned graph
        D-->>S: diagram = {nodes, edges}
    end
    S-->>RF: store update
    RF->>RF: re-render all nodes/edges [no React.memo]
```

**Why this matters:** every keystroke-equivalent edit triggers a full
validation pass, a full text regeneration, and a synchronous ELK layout of the
entire graph. There is no debounce. Documented in `08 §B`/`§D`.

## 3. Text edit → model (apply)

```mermaid
sequenceDiagram
    actor U as User
    participant TE as TextEditor
    participant S as useAppStore
    participant P as parseModel (Langium)
    participant M as Model

    U->>TE: type (per keystroke)
    TE->>S: setTextBuffer (NO parse)
    Note over TE,S: textDirty = true, rev-guard prevents overwrite while dirty
    U->>TE: click Apply
    TE->>S: applyText(buffer)
    S->>P: parseModel(buffer) [whole document]
    P-->>S: { model, diagnostics }
    S->>M: replace elements from parsed model
    S->>S: afterMutation() [same fan-out as seq. 2]
    Note over S: textDirty = false → buffer regenerated from model
```

## 4. Remote CRDT apply (collab)

```mermaid
sequenceDiagram
    participant Peer as Remote browser
    participant R as Collab Relay
    participant Y as Y.Doc (local)
    participant B as bindModelToDoc
    participant M as Model
    participant S as useAppStore

    Peer->>R: Y update (binary)
    R->>Y: broadcast update
    Y->>B: YjsChange (elements map)
    B->>B: reconcile → diff attrs per element
    B->>M: model.setAttrs(id, patch) [per changed element]
    M-->>B: ChangeEvent
    B->>S: model change listener → bump rev
    S->>S: afterMutation() [same fan-out as seq. 2]
    Note over S: ELK layout re-runs for the whole graph on every remote edit
```

## 5. REST query (optional server)

```mermaid
sequenceDiagram
    actor C as HTTP client
    participant E as Express app
    participant Q as writeQueues
    participant API as SysmlApiServer
    participant QE as evaluateQuery
    participant M as Model

    C->>E: POST /api/projects/:p/commits/:c/query-results { constraint, select, page }
    E->>E: choose handler (basePath mount)
    alt mutating verb (POST/PUT/DELETE)
        E->>Q: enqueueWrite(projectKey, task)
        Q-->>Q: serialize per-project
    end
    E->>API: apiFetch(POST, rel, body)
    API->>QE: evaluateQuery(commitModel, q)
    QE->>M: scan elements vs constraint tree
    Note over QE: 'matches' operator compiles new RegExp(value) — ReDoS risk (08 §H)
    QE-->>API: { elements, total, nextCursor }
    API-->>E: { status, body }
    E-->>C: 200 + ETag + JSON
```

## 6. Commit with optimistic concurrency

```mermaid
sequenceDiagram
    actor C as Client
    participant E as Express app
    participant Pre as checkCommitPrecondition
    participant API as SysmlApiServer
    participant VCS as ProjectRepository

    C->>E: POST /api/projects/:p/commits  If-Match: <baseHead>
    E->>E: writeQueues.enqueue(projectKey)
    E->>Pre: checkCommitPrecondition(api, req)
    Pre->>API: GET branch head
    alt head !== expected
        Pre-->>E: { 409 Conflict, expected, currentHead }
        E-->>C: 409
    else head matches (or no precondition)
        E->>API: apiFetch(POST, rel, body)
        API->>VCS: commitCreate → advance branch head
        API-->>E: { 201, Commit body }
        E->>E: setETag(res, body) → ETag: <newHead>
        E-->>C: 201 + ETag
    end
```

## 7. Import file

```mermaid
sequenceDiagram
    actor U as User
    participant T as Toolbar
    participant F as persistence/file.ts
    participant IO as persistence/io.ts
    participant P as parseModel
    participant M as Model
    participant S as useAppStore

    U->>T: click Open
    T->>F: openTextFile()
    F-->>T: { name, text }
    T->>S: importProject(name, text)
    S->>IO: importModel(text, fmt?)
    alt fmt = sysml
        IO->>P: parseModel(text)
    else fmt = model-json / api-json
        IO->>IO: JSON.parse(text) [NO try/catch — 08 §C]
    end
    IO-->>S: model
    S->>M: replace elements
    S->>S: afterMutation()
```

## 8. Disconnect collab / teardown

```mermaid
sequenceDiagram
    participant U as User
    participant S as useAppStore
    participant B as bindModelToDoc
    participant P as y-websocket provider
    participant A as awareness
    participant D as Y.Doc

    U->>S: disconnectCollab()
    S->>B: unbindModelToDoc() [remove model listener]
    S->>A: awareness.off(...)
    S->>P: provider.disconnect()
    S->>P: provider.destroy()
    S->>B: binding.destroy()
    S->>D: doc.destroy()
    Note over S: React effects add/remove listeners symmetrically (verified clean — 08 §F)
```

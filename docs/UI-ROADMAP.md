# UI Improvement Roadmap

A living plan for Sysprose's user interface. It records what has
shipped, what's next, and a backlog of ideas — grouped by theme. Each item is
sized (S/M/L) and, where shipped, links to its commit + E2E coverage.

Working method (unchanged): every UI change goes through **implement → independent
Fable adversarial review → validate (tsc · vitest · build · E2E) → screenshot →
commit**, and refreshes `docs/TEST-REPORT.md` counts.

> **Status:** the feature items below are implemented. Canvas drag-to-reparent
> (+ multi), per-element PageRank centrality, roving menu tab-order, and the shared
> toolbar↔canvas menu behavior all shipped in `9ba0b62` (each Fable-reviewed with
> all confirmed findings fixed). Still open: two measured performance items from
> the profiling round, **P1** for a piece with nested boxes (the compound-layout
> option is now off for a flat piece, but a nested piece still pays for it) and
> **P3** (Apply's parse is still on the page's thread; its first click no longer
> builds the parser, which opening the Text view does while the page is idle), and
> **Electron/Tauri** (a hard environmental blocker: no Windows
> cross-build here). **P2** (the solver's per-probe clone of its value map) is
> fixed. Community-detection **per element** stays deferred as low-value optional
> depth.

---

## ✅ Shipped

### Explorer / navigation
- **Hide standard library by default** + toggle — the tree shows the user model, not 38k library rows. `953b51d`, `E gui-explorer`.
- **Search / filter** (matches + ancestor path, count badge). `953b51d`.
- **Selection reveal** — selecting anywhere auto-expands + scrolls the Explorer to it (keeps the two parallel trees in sync). `953b51d`.
- **Resizable + collapsible side panels** (splitter + rail). `953b51d`.
- **Focus / scope-to-subtree** (◎ per row, "Show all"). `a38a55e`.
- **Type icons + indent guides**; keyword → tooltip. `3b2b522`.
- **Breadcrumb** of the selection's containment path (clickable). `3b2b522`.
- **Cross-tree hover link** (Explorer ↔ Requirements). `3b2b522`.

### Toolbar
- **Two-tier layout** — command row + a category-grouped, wrapping view switcher; killed the ~33-button horizontal scroll. `870f19c`, `E gui-toolbar`.
- **Export ▾ menu** (collapsed the 5 export buttons). `870f19c`.
- **Context-aware tools** — Auto-layout / Diagram SVG-PNG disabled off graph views (prevents stale-diagram export). `f11e777`.

### Palette (per-diagram tools)
- **Per-metaclass tool glyphs**, **Escape-cancel** and **armed-tool hint**. `bfdd5b3`, `E gui-palette`.
- **A palette on every view**, in three sections: **Tools** (what to draw — a table or analysis view draws nothing, so it has no Tools section), **Edit** (Rename · Duplicate · Delete over the selection) and **Checks** (the verification commands that fit the view, each with Run and Copy command). It replaces the earlier palette that was hidden on the non-graph views. `2486d72`, `E palette-checks`, `E palette-per-view`, `U checks-registry`.

### Canvas
- **Mini-toolbar** — Fit · Fit-to-selection · Snap-to-grid · Auto-layout. `91e20e1`, `E gui-canvas`.
- **Node context menu** (right-click) — Rename · Add child · Zoom to · Delete; viewport-clamped. `0d9e0ce`, `E gui-context-menu`.
- **Edge context menu** (right-click) — Delete a relationship/connection; structural edges guarded as non-interactive. `b56e5ff`.
- **Pane context menu** (right-click empty canvas) — Add a top-level element / Fit view; completes the node·edge·pane family (shared `useContextMenuChrome`). `E gui-context-menu`.

### Diagram layout
- **Compound layout only where a piece has nested boxes** (the flat half of P1 of the 2026-09-08 profile) — `elk.hierarchyHandling: 'INCLUDE_CHILDREN'` had been set on every view. `layoutOptionsFor(viewKind, nested)` now sets it only for a connected piece that contains nested boxes and uses `SEPARATE_CHILDREN` for every other piece (`layoutOptionsFor`, and `toElkTree` which computes `nested` per piece, `src/diagram/layout.ts`). On 950 flat nodes that took 569 ms down to 342 ms (1.7×). It does nothing for a piece that nests: that case, the profile's 83×, is **still open** — see P1 under Performance. `214b3c5`, `U diagram.layout2` (asserts the option for a flat and for a nested call, not its timing).

### Keyboard
- **Richer shortcuts** — `Delete`/`Backspace` removes the selection (React Flow's own delete disabled so model + diagram stay in sync), digits `1–6` switch primary views, `/` focuses Explorer search; input-guard extended to `<select>`. `E gui-keyboard`.

### What-if
- **Named scenarios (Regroup)** — save the current bundle assignment as a named snapshot (persisted to `localStorage`, durable across reloads), reload it, and diff two scenarios (which parts moved between bundles). Pure `diffScenarios`. `U scenarios`, `U store.reducers`, `E gui-scenarios`.

### Diagram styling
- **Per-view notation legend** — a collapsible top-left overlay lists the relationship-notation families actually present in the active view (composition ◆, reference ◇, specialization ▷, flow ▸, connection, containment ⊕, dependency ▹), each with a line sample + glyph in its real edge colour; driven by the current diagram's edge kinds. `E gui-legend`.

### Analysis
- **Impact graph** — a collapsible radial SVG in Properties of the selection's 1-hop reference neighbourhood: focus at centre, neighbours on a ring, directed edges for fan-in (→ centre) vs fan-out (→ neighbour), click-to-navigate. Backed by `edgesOf`; refreshes on mutation; `"+N more"` when > 12. `E gui-impact`.
- **"Used by" (where-used) overlay** — the Properties panel lists the distinct elements that reference the selection (via any relationship / typing), each a click-to-navigate link; impact analysis at a glance. Backed by `whereUsed()`. `E gui-whereused`.
- **Degree / coupling metrics** — a compact Metrics block in Properties: direct children, total descendants, references-out (fan-out), referenced-by (fan-in). Cheap per-element (no whole-graph analysis needed). `E gui-whereused`.

### Theme
- **Dark theme** — a toolbar toggle (☾/☀) flips `data-theme` on `<html>` (persisted; defaults to the OS preference via an inline no-FOUC script). All chrome tokens + a set of diagram tokens (`--node-*`, `--canvas-grid`, semantic `--dgm-*` hues) get dark values; nodes/edges/sequence/grid read them (type-tints via `color-mix`, semantic hues lightened for dark), React Flow controls/minimap themed. `E gui-theme`.

### Platform / distribution
- **PWA (installable, offline)** — a web manifest (standalone, themed, icon) + a build-time-generated, **content-versioned** service worker (inline `pwaServiceWorker` Vite plugin) that **atomically precaches the boot shell** (index.html + entry + static vendor chunks + CSS) and network-first-caches the rest at runtime; installs + works offline, transparent while online, and purges the old cache on every redeploy. `E gui-pwa`.
- **CI static deploy** — `.github/workflows/ci.yml` runs the full gate (typecheck · vitest · build · Playwright E2E) on every push/PR, and fails when `docs/TEST-SUMMARY.md` is not the summary of that vitest run; `deploy-pages.yml` builds and publishes `dist/` to GitHub Pages on `main` (the relative base makes the Pages subpath work). *(Runs on GitHub; validated locally as well-formed.)*

### Accessibility / polish
- **Reduced-motion** — a global `prefers-reduced-motion` CSS reset (zeroes transitions/animations/scroll-behavior) + the diagram fit animations gated to 0ms. `E gui-a11y`.
- **Focus-visible rings** — a consistent, token-driven keyboard focus ring on every interactive control (`:focus-visible` only, so no mouse-click outline noise). `E gui-a11y`.
- **Arrow-key tree navigation** — the Explorer tree is focusable (`role="tree"`); ↑/↓ move the selection through the visible rows, → expands / descends, ← collapses / ascends (a click focuses the tree so keys work after it). `E gui-tree-keys`.
- **Context menus close when the canvas moves** — wheel-zoom and a drag-pan (the pan's mousedown, seen in the capture phase because d3-zoom stops it) dismiss the fixed-position menu (scoped to the React Flow canvas so an unrelated panel scroll — e.g. the Explorer selection-reveal — can't self-close it). Shared `useContextMenuChrome`. `E gui-context-menu`.
- **Context-menu icons** — each item carries a leading glyph (✎ Rename · ＋ Add · ⧉ Copy · ⎘ Duplicate · ⊙ Zoom · ✕ Delete …), fixed-width so labels align (`aria-hidden`).

### Diagram editing
- **Multi-select + bulk actions** — ⌘/Ctrl/Shift-click extends the selection set on the canvas and in the tree (a primary `selectionId` + a `selectionIds` set kept in sync); bulk `Delete` / `Ctrl+D`, and "Delete N" / "Duplicate N" context-menu items, act on the whole set in one undo step. `U store.reducers`, `E gui-multiselect`.
- **Box-select** — Shift+drag a rectangle on the canvas selects every enclosed node into the multi-selection (React Flow's box-select synced to the store via `onSelectionChange`, loop-guarded). `U store.reducers` (setSelection), `E gui-boxselect`.
- **Edge endpoint reconnection** — drag a relationship edge's end onto another node to re-target its `source`/`target` (undoable). Only element-level relationship edges are reconnectable; structural containment + port-routed connections stay fixed so a drag can't collapse a port connection onto its owner. Pure `reconnectEndpoint` helper, unit-tested (`U reconnect`).
- **Duplicate (deep-clone)** — `Ctrl/⌘+D` or the node context menu clones the selection + its whole subtree as a sibling. Internal `source`/`target` references rewire to the clones; external references are preserved; the root gets a unique `"… copy"` name (one undo step). Pure `duplicateSubtree` helper, unit-tested (`U duplicate`); `E gui-context-menu` / `E gui-keyboard`.
- **Copy / paste across owners** — `Ctrl/⌘+C` copies the selected subtrees to a detached clipboard; `Ctrl/⌘+V` or the "Paste into" menu materializes them under a new owner with fresh ids (internal refs rewired to the clones, external refs kept iff still live, unique root name). Pure `collectSubtrees` / `pasteSubtrees` helpers (`U paste`); `E gui-copypaste`.
- **Canvas drag-to-reparent (+ multi)** — drag a node (or a whole multi-selection) and drop it onto another node to re-own it (mirrors the Explorer's drop-to-reparent). Targeting is pointer-based (control nodes excluded); the dragged set is React Flow's own `nodes` reduced to subtree roots (so a parent+descendant drag moves the subtree whole, never flattens it); a valid drop target is highlighted mid-drag. Rejects self / cycle / ancestor-of-dragged / no-op drops; applies the set in one undo step. Pure `resolveReparentTarget` + `subtreeRoots` (`U reparent-target`), `reparentMany` (`U store.reducers`); `E gui-reparent`.

### Analysis
- **Per-element PageRank centrality** — a "Centrality" row in the Properties Metrics block shows the selection's whole-graph PageRank score + rank (`0.0123 · #k of N`), reusing the Analysis view's `pageRank` and its exact endpoint-based node/edge partition (endpoint-bearing usages count as edges; implicit / annotation / library elements excluded). Pure `elementCentrality`; `E gui-whereused`.

### Accessibility / polish (menus)
- **Roving tab-order + shared menu behavior** — one `useRovingMenu` hook drives the canvas context menus and the toolbar dropdowns identically: opening focuses the first item, ↑/↓/Home/End rove, only the focused item is a Tab stop (re-seated on item mount/unmount via a `MutationObserver`), Tab out closes the menu, and focus is restored to the opener on close. Canvas menus are labelled groups (`data-menuitem`) so their hybrid `select`/`input` children stay ARIA-valid; the toolbar dropdown keeps proper `role=menu`/`menuitem`. `E gui-menu-keys`.

---

## ⚡ Performance — measured, and the Rust question answered

A profiling round (2026-09-08, six subsystems) asked what should be reimplemented in
Rust/WebAssembly to improve the user's experience and memory use. **The answer is: nothing yet.**
Four of six subsystems returned *do-not-port*, and the two largest user-visible costs are
JavaScript defects a port would have inherited unchanged. Ordered by measured value.

### P1 — `elk.hierarchyHandling: 'INCLUDE_CHILDREN'` is applied to every view — fixed for flat pieces; for nested ones the time is accepted (decided 2026-10-23)

The single worst measured defect in the tool. The option makes ELK route edges across the node
hierarchy, and it was set unconditionally for all fourteen view kinds. Measured with `elkjs` in this
repo, one nested graph, everything else identical:

| Graph | With the option | Without | Ratio |
|---|---:|---:|---:|
| 300 leaf nodes in 30 parents, degree 2 | **13 781 ms** | 165 ms | **83x** |
| 950 flat nodes, degree 1 (no nesting) | 569 ms | 342 ms | 1.7x |

The cost appears **only when nodes actually have children** — in the profile's reading, every
structural view of a SysML model, because parts contain parts. A flat graph barely notices, which is
why this had gone unseen. The profile's fix: set the option only when the projected graph has at
least one nested node.

**Shipped (`214b3c5`), the flat half.** `layoutOptionsFor(viewKind, nested)` sets the option for a
connected piece that contains nested boxes and `SEPARATE_CHILDREN` for every other piece
(`toElkTree` computes `nested`, `src/diagram/layout.ts`). `U diagram.layout2` asserts the option for
a flat and for a nested call, not its timing. That is the 1.7× row, and it leaves a piece that
nests exactly as it was.

**Still open at `5943654`, and at `aac38fd` (measured below): a piece that nests.** `toElkTree` passes `nested = true` for any piece
with one nested box, and that keeps `INCLUDE_CHILDREN`. Measured through `layoutDiagram` on the
`interconnection` view, 30 parents of 10 children each and two edges per leaf (330 nodes): 11 113 ms
as it stands (14 s on a loaded machine), 171 ms with `SEPARATE_CHILDREN` forced (65×); the raw ELK
options for the profile's own graph give 12 003 ms against 164 ms. ELK runs in a Web Worker
(`src/ui/elk-worker.ts`), so the page does not freeze, but the diagram appears no sooner. On the
drone-swarm v9 model of mbse-workflow (42 584 elements, one run each) the option is not the dominant
cost: the General view takes 5 035 ms against 4 469 ms forced, `interconnection` 550 against 486,
and `tree` 44 184 against 42 411. Whether to drop the option for nested pieces (trading the layout of
edges that cross a parent's border for time), or to bound the compound layout, is not decided; it
is tracked in `TODO.md` (*Decide what the layout does with a piece that nests*) and awaits a user
decision.

**Measured again at `aac38fd` (2026-10-21), forced `SEPARATE_CHILDREN` against the shipped option,
through `layoutDiagram`.** Crossings and "through" are counted on what the canvas draws: an edge
ELK did not route is drawn as a straight line between the centres of its boxes (`svg-export.ts`),
and "unrouted" counts those edges. Each time is the faster of two warm runs, taken in the order
forced, shipped, forced, shipped (the first run of a process is slower, which flattered the
forced option in a first pass), on a loaded machine (load average about 15); the synthetic rows
are two or three processes.

| Piece | Nodes / edges | `INCLUDE_CHILDREN` (shipped) | `SEPARATE_CHILDREN` forced | Time ratio |
|---|---|---|---|---|
| the entry's own graph: 30 parents × 10 leaves, two edges per leaf to `leaf[(i*7+d*13) % 300]` (576 of 600 edges cross a parent's border) | 330 / 600 | 42 574 ms (45 141 cold); 24 135 crossings; 0 through; 0 unrouted | 613 ms (1 380 cold); 23 748 crossings; 576 through; 576 unrouted | 69× (33× cold) |
| a structured variant: 30 parents × 10 leaves, two edges per leaf (inside the parent, and to the next parent) | 330 / 600 | 2 035–2 135 ms; 386 crossings; 0 through; 0 unrouted | 366–467 ms; 464 crossings (+20 %); 10 through; 300 unrouted | 4.6–5.8× |
| 30 `Cell` parts of 10 leaves in one `system`, one connector per leaf to the next cell (SysML text, `interconnection` view) | 331 / 300 | 559 ms; 0 crossings | 315 ms; 742 crossings; 300 through; 300 unrouted | 1.8× |
| drone-swarm v9, `interconnection`, whole model | 172 / 42 | 926 ms; 0 crossings | 942 ms; 2 crossings; 2 unrouted | none |
| drone-swarm v9, `interconnection`, `SwarmMember` and `MissionComputerNode` | 6 / 0, 5 / 0 | 13 and 8 ms | 13 and 8 ms | none |
| drone-swarm v9, General: whole model, `Kinds`, `Common`, `OA`, `SA`, `LA`, `PA`, `EPBS` | 853 / 949 down to 33 / 0 | no nested box, so the option is already `SEPARATE_CHILDREN` and the two runs are the same layout (crossings 3 993, 0, 29, 18, 0, 0, 3, 0) | same | none |
| the six `examples/` models, `interconnection` (whole, and each part with two or more parts; 9 views) | 3–14 / 0–9 | 8–78 ms; 0 crossings; 0 through; 0 unrouted | 8–95 ms; the same | none |

The profile's 11 s for the 330-node case **is** reproduced on the entry's own graph (the N0
reviewer's `synth.mts`): the shipped option takes 43–45 s here (load average 20 to 29), the forced
option 0.6–1.4 s. The structured variant in the
second row, where most edges stay inside a parent, costs about 2 s shipped and is only 4.6–5.8×
faster forced. So the time criterion of the rule set (at least 10× on the 330-node case) **is met**
on the entry's graph. The change is refused for another reason: `SEPARATE_CHILDREN` lays out each
parent's interior alone and does **not route an edge that crosses a parent's border**. Every such
edge (576 of 576 on the entry's graph, 300 of 300 in the `Cell` row) comes back without a route and
is drawn straight, across other boxes, and on the v9 `interconnection` view, the one real model
where the option matters, the crossings go from 0 to 2 with 2 edges unrouted. The rule set was "at
least 10× on the 330-node case, crossings up by at most 10 % on every measured real model, and no
overlap or line through a box"; the real-model and line-through conditions fail. So **no layout
code changed**: a nested piece keeps `INCLUDE_CHILDREN`, and `U diagram.layout2` now pins the
option through `layoutDiagram` (a flat call and a nested call), not only through
`layoutOptionsFor`. What stays open is to bound the compound layout (lay each parent's interior
out on its own, then route the edges that cross a border ourselves); dropping the option is not a
free change.

### P2 — the solver cloned its whole value map per probe — fixed (`src/semantics/solver.ts`: `solveScalar`, `newtonStep`, `substitutedNewton`)

`const trial = new Map(values)` sat inside the residual closure that every finite-difference probe
calls (`solver.ts:2520`, `:2706` and `:2979` at `5943654`), so a solve cloned the entire map once
per probe. The profiling round counted about 50 000 clones for one solve of the example shipped
then. That count was **not reproduced** at `5943654` (and was not at `aac38fd`): the defect was
code-level, not a measured cost on any model since.

**Fixed.** The scalar root-find (`solveScalar`) and the coupled Newton step (`newtonStep`) set the
keys a probe moves in the working map, read the residual and restore them in a `finally`
(`probing`, and the same three lines inline for the one key of the scalar case): a key that was
absent is absent again, one that was present holds its old value, and the map is not retained. The
instance-variable step (`substitutedNewton`) substitutes definitions, which deletes and re-adds
keys and would reorder the caller's map, so it probes one copy made per call and puts back what each
probe touches. No behaviour change: the verdict differential and the v9 gate are identical.

Counting `new Map(<Map>)` calls during `solve` and `solveFeasible` on a freshly loaded model
(`aac38fd`, before, then after):

| model | `solve` before | `solve` after | `solveFeasible` before / after |
|---|---|---|---|
| `contract-authoring-prompts` | 3 | 3 | 5 / 5 |
| `uav-isr` | 5 | 5 | 8 / 8 |
| `uav-isr-verification` | 510 | 9 | 12 / 12 |
| `uav-power-budget` | 20 | 20 | 30 / 30 |
| `vehicle` | 3 | 3 | 5 / 5 |
| `views-tour` | 257 | 7 | 9 / 9 |
| drone-swarm v9 (42 584 elements) | 3 082 | 81 | 132 / 132 |

`solveFeasible` is unchanged on these models: none of its copies was a probe's (it ran after
`solve` here, on the same model, so it started from the cached base point). The copies left are not
probes: the ones the equations are built from (`keyedNames`, `valueEquation`, `assignmentEquation`,
`relationEquation`), one start point per Newton step (`newtonStep`), `freeFeatures`, the cache-hit
copy in `solveCore`, and two per `substitutedNewton` call. The wall time was tens of milliseconds
on every one of these (v9 `solve` 83 ms before, 59 ms after, one run each on a loaded machine), so
what is gained is the removed per-probe allocation, not a speed-up anyone sees at these sizes.

`semantics.solver.test.ts` pins it: a scalar root and a coupled system take at most 6 copies (17 and
39 before), a tree of instances takes no more copies when it needs Jacobian probes than when it
needs none, and an unknown left unset by a failed root-find, or read by a check alone, is not left
in the map at a probe's value.

### P3 — the first "Apply text → model" click blocks the main thread for ~1.28 s — the build now runs when the Text view opens (S5); Apply's parse stays on the page

Not parsing — **parser construction**. Chevrotain's ALL(\*) lookahead analysis
(`performSelfAnalysis`) costs 1 387 ms in the browser and 1 102 ms of it is one function,
`containsPath`. Subsequent applies are 4–9 ms. A profiler tested whether configuration fixes it:
`maxLookahead: 3` fails the grammar outright with an ambiguity, and 5 and 8 do not finish in 150 s —
so ALL(\*) is the cheapest option Chevrotain offers this grammar, not a misconfiguration. **Fix:**
build the parser in a Web Worker. Measured boundary cost to move a parse result across: 1.2 ms.
Still open at `5943654`: there is no parser worker (the dedicated workers are ELK's layout and the
palette's checks), and in Node the first parse of a one-line model takes 1.2 s and the next 2 ms.
Since branch `load-health` (2026-10-14) the checks worker builds the parser too, and parses each
text a palette check's load health needs there; Apply's parse is still on the page.

**What was done (branch `ui-perf-backlog`, S5): the build is warmed, the parse is not moved.**
Opening the Text view schedules `warmParser` (`src/text/langium/module.ts`) for when the page is
idle (`src/ui/parser-warmup.ts`, from `TextEditor`), so a click on Apply, Save's apply of the typed
text (`store.drive.ts`), and the `typedTextFirst` of a field's change (which applies the typed text
before the change goes in) find the parser built. They keep parsing on the page, synchronously, as
before.
Measured in Chromium (headless, a loaded 16-core machine, a three-line package, the click timed in
the page from `click()` to its return, seven runs before and eight after):

| | first Apply | second Apply |
|---|---|---|
| before | 1 277 – 1 392 ms (a long task of 1.4 – 1.6 s) | 4 – 5 ms |
| after (the Text view open for 3 s, or the click made as soon as the fill returned) | 11 – 21 ms | 3 – 7 ms |

The build is not removed: it is one stretch of about 1.3 s on the page's thread, now right after
the Text view opens (a click made within that stretch waits for the rest of it, as it did before).
Opening the Text tab now holds the page for about 1.4 s, once per session. The time from opening the
tab to an applied model is unchanged (about 2.5 s before, 2.6 s after, with real typing and a mouse
click). What changes is that the Apply click itself answers at once.

Two other moments were measured and not taken. At load: the build ran before the first diagram was
drawn, and the diagram came up at 2.2 – 2.6 s instead of 0.9 – 1.0 s, for every session, most
of which never open the Text view. At the click on Apply only: the status quo. A worker cannot take
the build off the thread without taking the parse with it: the parser cannot be handed across, so
the page would need an Apply that waits for a worker's reply.

**Not done: the parse in a worker.** `applyText` and `typedTextFirst` are synchronous, and
the second must stay so (its caller goes on with the change the moment it returns). Moving Apply's
parse into the worker needs an Apply that is in flight: the buffer edited while it parses, Undo and
the carried ids across the wait, the reply's model rebuilt on the page (`ParseResult` holds a
`Model`, a range table and deferred warnings), and a page-thread fallback where the worker is
unavailable. That is its own change, and it would not make the first Apply faster than the warm-up
does; it would let a very large text not hold the page while it parses. Still open for the cases
where the parse is the cost, not the build.

### P4 — an edit's recompute was one task of 0.2 to 0.4 s on the drone-swarm model — now a task for each rule, the text, and the results (`recomputeSteps`, `src/ui/store.ts`)

After every edit the page validates the whole model (27 rules), writes its text and builds the
diagram. Measured in Chromium (headless, the `drone-swarm-v9` model of the palette-checks guard, the
State view, six renames through `window.sysml`, the page's long tasks timed from each edit), on a
16-core machine at a load average of about 13: the recompute was one task of 207 – 393 ms after the
first, 100 – 600 ms after the edit. Inside it (the same build, timed in the page): validation
123 – 216 ms, writing the text 42 – 87 ms, the sync part of the diagram build 18 – 35 ms (the layout
is another task, of about 100 ms, and not part of this). In node, warm, no rule is more
than 47 ms (`constraint-violation`); the other 26 are 12 ms and under, so validation is spread over the
rules, and no one rule or one part of the model is the cost.

**What was done:** the recompute is a generator, and a task that has run 40 ms (`RECOMPUTE_SLICE_MS`)
lets the page draw and goes on in the next one. Validation steps once per rule (`validateSteps`,
which `validate` drives to its end, so the lists are the same); the text is a step; the results are
set, and the diagram build started, in the last. The text and the last step cannot be divided, so
each begins a task of its own once the task before it has run 10 ms (`RECOMPUTE_CUT_MS`); the task
is then not up to 40 ms plus the step. On a model whose recompute takes under 10 ms it is still one
task, as before. The recompute stays pending (`recomputePending`, `forcedRecomputePending`)
until its last step, so the guards that read them (a save, the unsaved prompt, the tab-close prompt)
are unchanged; `flushRecompute` runs the rest of it at once; an edit ends the one under way, and the
next is made of the model as it is. A burst is still bounded by its cap
(`RECOMPUTE_MAX_WAIT_MS`, or four times the last recompute): an edit that ends a recompute keeps its
burst's deadline, and the recompute that reaches the deadline runs in one task, as it did before,
which an edit cannot end; without that, edits arriving faster than a recompute's wall time (several
tasks, with draws between) would end every one of them and the diagnostics, diagram and text would
not refresh for as long as the typing lasted. So the 200 ms bound is of an edit alone; under a
sustained burst one task of the recompute is the whole of it, at the cap. Nothing is validated incrementally: the same 27 rules run over the
whole model, and no finding can depend on what an edit was thought to leave alone.

| | the recompute's longest task | the longest task of an edit and its recompute |
|---|---|---|
| before, load about 13 | 207 – 393 ms | 207 – 393 ms |
| after, load about 4 | 54 – 93 ms | 54 – 93 ms (six edits) |
| after, 14 busy loops on 16 cores | 129 – 149 ms; 230 ms on the session's first edit (cold code) | 238 ms on the session's first edit, 71 – 109 ms on the rest |

At a load average of 25 on the 16 cores (other work on the machine, eight edits): the recompute's
tasks 127 – 188 ms, 233 ms on the session's first edit; the edit's own 86 – 208 ms. The two steps that
cannot be divided are the text (100 – 180 ms there) and the last step (the results set and the diagram
build begun: 90 – 156 ms), about 2.5 times their size at a load of 4.

`palette-checks.spec.ts` (the drone-swarm guard, step 4: an edit after three others) pins it at
200 ms, times the load average per core when that is over 1 and up to 1.5 (above that the step is not
asserted: 400 ms is the size of the unsliced task), since the times are wall-clock; without
the slicing it reads 353 ms under the busy loops. The session's first edit, with the code cold, can
still be over 200 ms on a loaded machine; it is not in the guard.

**Not done:** the text is one step of 40 – 130 ms (the serializer writes one root in one pass, and
the model has one), and the longest rule one of 47 ms in node: a model whose text takes over 200 ms to
write would still hold the page that long. Writing it in a worker means sending the model to the
worker for each edit, which costs about what the write does.

### What the profiling ruled OUT, with the arithmetic

- **The model graph** — crossing 38 902 elements to WebAssembly costs ~100 ms against ~127 ms for
  the *entire* traversal API. There is no break-even.
- **Binding the standard library** — 1.6 s of a cold load, but 99.6 % of the elements are the
  bundled library and a warm load is 267 ms. This is a caching and indexing problem, and a Rust
  rewrite would cache exactly as well as an index does.
- **Parsing throughput** — already 150 000 tokens/s parsing and 830 000 tokens/s lexing in the
  browser. Faulted input parses *faster* than clean input, because the parser bails early.
- **The solver encoder** — most of a `verify --engine smt` run is z3, which is already native
  WebAssembly.
- **Threads** — GitHub Pages cannot set COOP/COEP, so on the hosted site `crossOriginIsolated` is false (the local servers send them, for z3) and threaded
  WebAssembly is unavailable. Any "Rust for parallelism" argument does not apply to the shipped app.

**One Rust candidate stays open**, unmerged and unscheduled: a layered layout engine behind
`layoutDiagram`, where the boundary cost is 0.05 % of the work. Its bar is ≥3x against a baseline
without the nested-layout cost of P1 (the option off, or the compound layout fixed), not against the
11 to 14 s a nested piece takes today — a 3x win over a defect is not a win.

## 🔜 Next — diagram editing (near-term)

| Item | Size | Notes |
|---|---|---|
| **Multi-reparent** | M | ✅ **shipped** — canvas drag-to-reparent works for a single node and for a whole multi-selection (subtree-root-reduced, one undo step). See Diagram editing above. |

## 🟡 Medium — navigation & analysis intelligence

| Item | Size | Notes |
|---|---|---|
| **Richer keyboard shortcuts** | S | ✅ shipped — Delete/Backspace, Ctrl+D duplicate, Ctrl+C/V copy-paste, digit view-switch hotkeys, `/` focus-search (on top of undo/redo/save). |
| **Metrics overlay** | M | ✅ where-used + degree/coupling + **per-element PageRank centrality** shipped in Properties. Remaining (optional): community-detection per element (whole-graph — already in the Analysis view). |

## 🟢 Platform / distribution

| Item | Size | Notes |
|---|---|---|
| **Electron / Tauri desktop** | L | A native `.exe` window; must be built on Windows (can't cross-compile in this Linux env). Documented as an environmental blocker. |

## 🎨 Polish / accessibility

| Item | Size | Notes |
|---|---|---|
| **Keyboard navigation** | M | ✅ focus-visible rings + arrow-key tree navigation + **roving tab-order through the menus** (`useRovingMenu`) shipped. |
| **Context-menu polish** | S | ✅ close-on-canvas-move + item icons + **shared toolbar↔canvas menu behavior** (`useRovingMenu`: roving/focus-lifecycle/ARIA) shipped; node/edge/pane menus share `useContextMenuChrome`. (Dismiss-logic dedup between the anchored dropdown and fixed canvas menus is a deliberate, low-value deferral.) |

---

## Known limitations (tracked, not yet scheduled)
- Regroup: a *deep-inside → fully-outside* crossing across ≥2 **new** bundle levels is delegated at every level (fixed) — but the general nested-composite delegation for arbitrary depth is only as deep as the reachable configs; see `docs/architecture/04-dependency-graph.md`.
- Explorer local UI state (focus/filter/showLibrary) resets when the panel is collapsed (the Explorer unmounts). Acceptable; would need lifting to the store to persist.
- Edge reconnection re-targets through the model → full rebuild (matching the app's `onConnect` pattern), so the dragged edge briefly snaps back before the relaid diagram shows the new endpoint. Cosmetic; final state is correct. It also does no endpoint-type validation (a free-form modeler choice — validation surfaces incompatible links); self-loops are allowed.

*This roadmap is maintained alongside the code — update it as items ship.*

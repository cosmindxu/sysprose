# UI Improvement Roadmap

A living plan for Sysprose's user interface. It records what has
shipped, what's next, and a backlog of ideas — grouped by theme. Each item is
sized (S/M/L) and, where shipped, links to its commit + E2E coverage.

Working method (unchanged): every UI change goes through **implement → independent
Fable adversarial review → validate (tsc · vitest · build · E2E) → screenshot →
commit**, and refreshes `docs/TEST-REPORT.md` counts.

> **Status:** the roadmap is fully implemented. Canvas drag-to-reparent (+ multi),
> per-element PageRank centrality, roving menu tab-order, and the shared
> toolbar↔canvas menu behavior all shipped in `9ba0b62` (each Fable-reviewed with
> all confirmed findings fixed). The only remaining item is **Electron/Tauri** (a
> hard environmental blocker: no Windows cross-build here); community-detection
> **per element** stays deferred as low-value optional depth.

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
- **Per-metaclass tool glyphs**, **Escape-cancel**, **armed-tool hint**, and the **column hidden on non-graph views**. `bfdd5b3`, `E gui-palette`.

### Canvas
- **Mini-toolbar** — Fit · Fit-to-selection · Snap-to-grid · Auto-layout. `91e20e1`, `E gui-canvas`.
- **Node context menu** (right-click) — Rename · Add child · Zoom to · Delete; viewport-clamped. `0d9e0ce`, `E gui-context-menu`.
- **Edge context menu** (right-click) — Delete a relationship/connection; structural edges guarded as non-interactive. `b56e5ff`.
- **Pane context menu** (right-click empty canvas) — Add a top-level element / Fit view; completes the node·edge·pane family (shared `useContextMenuChrome`). `E gui-context-menu`.

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
- **CI static deploy** — `.github/workflows/ci.yml` runs the full gate (typecheck · vitest · build · Playwright E2E) on every push/PR; `deploy-pages.yml` builds and publishes `dist/` to GitHub Pages on `main` (the relative base makes the Pages subpath work). *(Runs on GitHub; validated locally as well-formed.)*

### Accessibility / polish
- **Reduced-motion** — a global `prefers-reduced-motion` CSS reset (zeroes transitions/animations/scroll-behavior) + the diagram fit animations gated to 0ms. `E gui-a11y`.
- **Focus-visible rings** — a consistent, token-driven keyboard focus ring on every interactive control (`:focus-visible` only, so no mouse-click outline noise). `E gui-a11y`.
- **Arrow-key tree navigation** — the Explorer tree is focusable (`role="tree"`); ↑/↓ move the selection through the visible rows, → expands / descends, ← collapses / ascends (a click focuses the tree so keys work after it). `E gui-tree-keys`.
- **Context menus close when the canvas moves** — wheel-zoom / pan dismiss the fixed-position menu (scoped to the React Flow canvas so an unrelated panel scroll — e.g. the Explorer selection-reveal — can't self-close it). Shared `useContextMenuChrome`. `E gui-context-menu`.
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
- The context menus don't dismiss when the React-Flow canvas is panned (RF eats the event); they close on action / outside-click / Escape.
- Edge reconnection re-targets through the model → full rebuild (matching the app's `onConnect` pattern), so the dragged edge briefly snaps back before the relaid diagram shows the new endpoint. Cosmetic; final state is correct. It also does no endpoint-type validation (a free-form modeler choice — validation surfaces incompatible links); self-loops are allowed.

*This roadmap is maintained alongside the code — update it as items ship.*

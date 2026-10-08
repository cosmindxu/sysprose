# To do

Next actions: concrete, small, actionable. Big features belong in [`ROADMAP.md`](ROADMAP.md). Items
that need decisions after research belong in [`RESEARCH.md`](RESEARCH.md).

- [ ] **Run the palette's solver checks in the page, not only in a terminal.** `verify`,
      `consistency`, `refine`, `bounds` and `fault-tree` are in the registry (`src/ui/checks.ts`)
      but report `not here` with a copyable command, because z3 needs a cross-origin-isolated
      page and this one is not. Decide how to get isolation (COOP/COEP headers from the dev and
      preview servers, and whatever the static host allows), then let the registry's `solver`
      entries run through `z3-bridge` when `crossOriginIsolated` is true. A check that cannot run
      must keep saying so rather than passing. Isolation has a cost the decision must weigh:
      `COOP: same-origin` + `COEP: require-corp` break the optional Google Drive feature's sign-in
      popup and its `docs.google.com` Picker iframe, so in-browser z3 and Google sign-in constrain
      each other.
- [ ] **Scope the palette's checks to the selection where the CLI takes `--element`.**
      `where-used` and `check-behaviour` read the selection today; `contracts`, `obligations` and
      `bounds` take `--element`/`--measure` at the terminal and run whole-model here. Either pass
      the selection through or say in the row that the result covers the whole model.
- [ ] **Let a check run off the main thread when it is slow.** Every `model` check is synchronous
      today, which is right for the sample model (each is well under a frame) but not for a large
      one: `reach` and `check-behaviour` walk configuration graphs. Measure first, then move the
      walkers into the worker the solver lane already uses.
- [ ] **Keep the toolbar's `More` menu honest as commands are added.** The overflow order lives in
      `COLLAPSE_ORDER` (`src/ui/panels/Toolbar.tsx`) and the guard is one e2e assertion that
      nothing collapses at the Playwright viewport. A new command added ahead of that list without
      a widths check would push Validate or Check into the menu and break every spec that clicks
      them.
- [ ] **Say on screen when the palette column is put away.** The collapsed strip is a 24 px
      chevron with a tooltip; a first-time reader who collapses it has no label telling them what
      it hides.
- [ ] **Stop `docs/TEST-SUMMARY.md` from drifting.** Add a CI step that runs
      `npx tsx scripts/gen-test-report.ts --from <the gate's vitest JSON>` and then
      `git diff --exit-code docs/TEST-SUMMARY.md`. Today the documents are checked against each other,
      but the suite total is only as current as the last manual regeneration.
- [ ] **Close the known gap in the z3-death handling (D5).** A z3 hang inside a plain `it(` that keeps
      vitest's 5 s default timeout is killed before the 35 s death guard fires. That case reads as a
      timeout, and the `[D5]` line lands on the next case. Give every solver-driving plain `it(` in
      `test/campaign/verification.test.ts` an explicit timeout of at least 40 s.
- [ ] **Give register row W2's per-step alternative a producer.** `ExploreResult.successors` stores
      no transition id per edge, so the trap entry path can never use the per-step wording
      (`TRAP_ENTRY_WALK_ADMITS` exists and is asserted unprinted). Retain the transition id beside each
      successor and wire the alternative.
- [ ] **Decide how the app shows inherited contract clauses.** The Contracts view shows an inherited
      clause as `N more clause(s) inherited from X`, while `contracts` in the terminal prints its body
      marked `(inherited)`. Either show the body in the app, or record the difference as deliberate
      in `docs/USER-GUIDE.md`.
- [ ] **Label the layer columns of a partitioned General view.** When a view spans a model's
      top-level packages, the layout keeps them as left-to-right columns
      (`assignPackagePartitions`, `src/diagram/build.ts`), but nothing on the canvas names the
      columns. Draw a header per column (the package name, above its x-range) so the reading
      order is visible, not only felt.
- [ ] **Keep hand-placed boxes with the saved project.** `diagramPins` (`src/ui/store.ts`) holds
      the boxes a user moved, per view and scope, for the session only; Save/Open drop them.
      Persist them beside the model in the project store (never in the `.sysml` text).
- [ ] **Leave the standard library out of Export ▾ → SysML.** `exportModel(model, 'sysml')` →
      `serializeModel` maps `model.roots()` with no `isLibrary` filter, so the exported text carries
      the merged standard library (~1.28 MB with the full one) after the user's packages. The Text
      view and Save to Drive serialize the user roots only (`userRootIds`); the export should too,
      and the guide's §8 note then goes.
- [ ] **Guard unsaved work on New, Open and Import, not only Drive's.** The three replace the model
      without asking (one Undo restores it); the strip asks first only when an attached Google Drive
      file has unsaved changes (`driveGuard`). A general guard needs to know what the browser
      project last saved, which the store does not record today.
- [ ] **Ask before a branch switch, a merge or a room join drops unsaved Drive changes.** Switching
      or merging a branch in the Versions tab (`BottomPanel.tsx` → `switchBranch`,
      `mergeBranchesCmd`) and joining a collaboration room (`Collaborate.tsx` → `connectCollab`)
      detach an attached Google Drive file without the strip's question, unsaved changes and all;
      only **Save to Drive as…** then keeps them, in a new file. Wrap the three call sites in
      `driveGuard('…', 'dirty', …)` as New, Open and Import are, and drop the guide's §8.1 sentence
      that names them as the commands that do not ask.
- [ ] **Apply typed text before the toolbar's Save.** Save and `Ctrl/⌘+S` outside the Text view's
      editor store the model without applying text typed in the Text view and not yet applied;
      `Ctrl/⌘+S` inside the editor applies it first (`applyTypedTextToSave`: not a text with a
      parse error, whose recovery is not what is on screen), and so does every save to Drive.
- [ ] **Refresh the text buffer after an SDK edit.** Outside a collaboration room,
      `window.sysml.update` changes the model without regenerating `textBuffer` (the store
      subscribes to the model only inside `connectCollab`), so the Text view goes stale and an
      attached Drive file never reads as unsaved: Save to Drive and `Ctrl/⌘+Shift+S` send nothing,
      while Save and `Ctrl/⌘+S` still store the edit in the browser.
- [ ] **Cut the crossings of one-layer General views with hub requirements.** Scoped to the
      drone-swarm model's `OA`, the General view still has ~110 crossings, most of them long
      `«trace»` / `«satisfy»` lines converging on a few hubs (`memberA` takes ~20). Try routing
      those dependency kinds as merged hyperedges of their own, or placing hubs by barycentre.

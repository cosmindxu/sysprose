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
- [ ] **Keep plain `Membership` elements through an api-json round trip.** `fromApiGraph`
      (`src/persistence/io.ts`) skips every element whose `@type` is in `OWNERSHIP_MEMBERSHIPS`,
      `Membership` included, as if it were the wire's reified ownership; the full library's 268
      genuine `Membership` elements are dropped (38,761 elements exported, 38,493 imported back).
      Tell the reified memberships (`om-<child id>`) from the model's own.
- [ ] **Never put a user element inside a library root.** `createElement` (owner falls back to
      the selection), `reparent` and `reparentMany` take a library element as owner, e.g. with the
      Explorer's library toggle on. Such an element has no `isLibrary` flag but sits under a library
      root, so the Text view, Save to Drive and Export ▾ → SysML all leave it out, while model
      JSON keeps it. Nor does an edit to it read unsaved — what is saved is compared as text — so
      New, Open ▾ and Import drop it without asking, though a Save in this browser would have kept
      it. Refuse a library owner, or fall back to the root.
- [ ] **Apply typed text before Export ▾ → SysML, or say it is left out.** Save and `Ctrl/⌘+S`
      apply text typed in the Text view and not yet applied first (`applyTypedTextToSave`; over a
      parse error, or in a collaboration room, a save in this browser alone keeps it back and the
      strip says so), as every save to Drive does (`payloadNow`). Export ▾ → SysML still writes the
      model without it (the guide's §8 and §8.1 say to press Apply first). Either apply it the same
      way — an export would then change the model and spend an Undo step — or say in the menu that
      the typed text is not in the file.
- [ ] **Decide what `Ctrl/⌘+S` does in a field other than the Text view's editor.** The page's
      handler ignores keys typed into an input, a select or another textarea, so `Ctrl/⌘+S` in a
      Properties field or the Explorer search opens the browser's "Save page" dialog. Forwarding
      it would save without the field's uncommitted value (Properties writes on Enter or blur):
      commit the field first, or leave the key to the browser and say so in Appendix B.
- [ ] **Cut the crossings of one-layer General views with hub requirements.** Scoped to the
      drone-swarm model's `OA`, the General view still has ~110 crossings, most of them long
      `«trace»` / `«satisfy»` lines converging on a few hubs (`memberA` takes ~20). Try routing
      those dependency kinds as merged hyperedges of their own, or placing hubs by barycentre.

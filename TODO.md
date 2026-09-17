# To do

Next actions: concrete, small, actionable. Big features belong in [`ROADMAP.md`](ROADMAP.md). Items
that need decisions after research belong in [`RESEARCH.md`](RESEARCH.md).

- [ ] **Run the palette's solver checks in the page, not only in a terminal.** `verify`,
      `consistency`, `refine`, `bounds` and `fault-tree` are in the registry (`src/ui/checks.ts`)
      but report `not here` with a copyable command, because z3 needs a cross-origin-isolated
      page and this one is not. Decide how to get isolation (COOP/COEP headers from the dev and
      preview servers, and whatever the static host allows), then let the registry's `solver`
      entries run through `z3-bridge` when `crossOriginIsolated` is true. A check that cannot run
      must keep saying so rather than passing.
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

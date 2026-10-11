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
- [ ] **Let the palette's `check-behaviour` check the machine its command names.** Run here, it
      checks the selected machine, or the model's first machine when the selection is not one;
      `check-behaviour --element X` takes the one machine inside `X`, and refuses a state inside a
      machine (naming that machine) or an `X` that holds several. On the drone-swarm v9 model,
      selecting `PA::SwarmMember::SwarmMemberModes::Nominal` makes the palette answer about
      `OA::SwarmMemberModes` while the copied command is refused. Pick the machine as
      `behaviourMachine` (`scripts/sysprose.ts`) does, and name it by qualified name in the summary
      (v9 has four machines called `SwarmMemberModes`).
- [ ] **Scope the palette's `reach` to the selection, as its optional `--element` does.** It covers
      the whole model here, and so does its command, but its summary does not say so. Give it what
      `contracts` and `obligations` have (`scopedBySelection`, `checkScope`, a `checks/scoped` or
      `checks/whole-model` row, `src/ui/checks.ts`), with `reachReport` narrowed the way
      `reachScope` (`scripts/sysprose.ts`) narrows it.
- [ ] **Name a linked model's file in the palette's commands.** Opened through `?model=`,
      `examples/views-tour.sysml` shows "Opened views-tour.sysml from its link", but every copied
      command names `Untitled.sysml`: `checkFileName` (`src/ui/store.drive.ts`) falls back to the
      project name, `deriveProjectName` (`src/ui/store.ts`) takes it from the first root, and that
      root is the file's unnamed header comment. Name a linked model after its URL's file name, or
      skip roots that are not namespaces when deriving the project name.
- [ ] **Credit the palette's checks in the user guide's terminal table.** In `docs/USER-GUIDE.md`,
      "The same answers from a terminal" puts "—" in the *In the app* column for `orphans`,
      `obligations`, `fault-tree` and `reach`, and its † note says `connectivity`, `orphans` and
      `obligations` exist only in the terminal and the SDK. The palette's Checks section runs all
      of them (`src/ui/checks.ts`). Name the palette check in that column and drop those names
      from the note.
- [ ] **Stop a composite state's last-active child from multiplying the configurations a walk keeps.**
      `hashConfig` (`src/semantics/mc/config.ts`) puts the history map into the visited-set key, and
      `exitTo` records the last-active child of every composite it leaves, so the configurations of a
      machine multiply with its composites: five composites of 3 to 4 substates (24 states) reach
      `reach`'s 10,000-configuration bound (`docs/TEST-REPORT.md` §2.15), where a flat machine of 24
      states has 24. Only a history composite ever reads the map (`enterCascade`), and `exploreMachine`
      refuses those machines (`history-state`, unsupported), so for every machine it walks the map is
      dead state in the key. Leave it out of the key when the machine has no history composite and see
      what moves: every `configs` figure and `after N configuration(s)` sentence of a machine with
      composites (goldens in `test/unit/semantics.mc.*` and `test/campaign`, the user guide's reach
      sections), and the machines that now finish inside the bound and so publish their unreachable and
      dead lists where they said *undecided*. Tried once, with the map left out of the key and nothing
      else changed: the flight controller of §2.15 walks 19 configurations in 3 ms and `reach` decides;
      a generated machine of five composites whose every substate also exits to a top state still
      reaches the bound, so something else multiplies there and wants finding. The palette's worker
      (`src/ui/checks-worker.ts`) already keeps such a walk off the page; this removes the walk.
      Fixtures to re-make and figures to re-measure when it lands, since they rely on a machine that
      still hits the bound: `test/unit/checks-registry.test.ts` (*give a machine at the walk's
      bound…* asserts `reach` is `undecided` on five composites), `test/e2e/palette-checks.spec.ts`
      (*a state-machine check runs in a worker…* waits for `undecided`, *hit a bound* and
      `verification/bound-hit` on `heavyMachine(6, 4)`, and sets its longest frame gap against the
      same walk on a page with no worker, which says something only while that walk holds the
      page for a good fraction of a second), and the §2.15 timings of `docs/TEST-REPORT.md`.
- [ ] **Keep the toolbar's `More` menu honest as commands are added.** The overflow order lives in
      `COLLAPSE_ORDER` (`src/ui/panels/Toolbar.tsx`) and the guard is one e2e assertion that
      nothing collapses at the Playwright viewport. A new command added ahead of that list without
      a widths check would push Validate or Check into the menu and break every spec that clicks
      them.
- [ ] **Decide what a palette put away does with an armed tool.** Collapsing the column hides the
      "Placing X" hint, but the tool stays armed until Escape or Cancel, so the next canvas click
      places an element the screen no longer announces. Either name the armed tool on the put-away
      strip (`palette-collapsed-label`) or disarm on collapse.
- [ ] **Keep the keyboard focus when the Explorer or Properties column is put away or brought
      back.** The palette now hands the focus to the control that replaces the one pressed
      (`Palette.tsx`, `refocus`); the two side panels (`src/ui/App.tsx`) swap their trees the same
      way and leave the focus on `<body>`.
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
- [ ] **Keep a layered General view's column headers on screen while panning down a column.** A
      header (`src/ui/panels/ColumnHeaders.tsx`) is drawn once, above the top of its piece, so in
      the drone-swarm model's whole General view (columns about 19,000 px tall) it is off screen
      at every zoom where the boxes read. Pin it to the canvas's top edge while its piece runs
      beneath it, clamped to the piece; decide how it then stays clear of the boxes under it. A box
      moved by hand is not kept clear of a header either: it can be dropped into a band, and after
      a re-layout its pin keeps its old coordinates (`applyPins`, `src/ui/store.ts`) while the
      headers move with the new layout.
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
- [ ] **Cut the crossings the hub-led layout leaves in the drone-swarm v9 `OA` General view.**
      The view has 31 crossings in the app's readability count (46 in the layout's own count,
      `countCrossings`), down from 71 and 88 in those two counts, with the two members drawn as
      hubs. Of the 46, 26 are two `«allocate»` lines crossing, 9 an `«allocate»` and a `«satisfy»`,
      7 an `«allocate»` and a `«typed-by»`: the two members' activities share one definition per
      step, so the two fans interleave. Try ordering the activities of the two fans by their
      shared definition (barycentre), or letting only one member lead.
- [ ] **Give tied centrality scores one rank.** Properties shows `Centrality … #N of 1373`
      (`elementCentrality`, `src/diagram/centrality.ts`). It orders equal scores by element id, and
      ids are random UUIDs (`newId`, `src/core/ids.ts`), so a tied element's rank changes with
      every load: the drone-swarm v9 root package (score 0.0004) read #973, #852, #1188 and #1067
      in four loads of the same file, so tutorial stills that show a tied element's rank differ
      from one recording to the next. Give tied scores the best rank they share (competition
      ranking), or show *tied*, or break the tie by qualified name, which a load does not change.

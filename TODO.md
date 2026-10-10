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
- [ ] **Say on screen when the palette column is put away.** The collapsed strip is a 24 px
      chevron with a tooltip; a first-time reader who collapses it has no label telling them what
      it hides.
- [ ] **Hold z3's timeout floor where the D5 guard cannot see.** The last case of
      `test/campaign/verification.test.ts` holds every case that hands z3 a check to 40 s: the death
      guard for the DEFAULT 5 s budget, plus 5 s. A check given a larger budget needs that budget plus
      35 s, and nothing holds a case to it (today "an undecided check spends the 2 even when the same
      tree found cut sets" passes 30 s under a 120 s timeout, which is enough). Hooks are not guarded
      (vitest's `hookTimeout` is 10 s; the two that reach z3 now are given 240 s and 600 s). Have the
      bridge report the largest budget handed to it while a case ran, and read the counter around the
      hooks that load z3.
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
- [ ] **Count a hand arrangement as unsaved work.** `browserDirty` (`src/ui/store.drive.ts`)
      compares text only, so boxes moved by hand since the last Save or Open never read unsaved:
      New, Open, Import, a Drive open and closing the tab let them go without a question. Undo
      brings them back after New, Open and Import, but a Drive open clears Undo, so there an
      arrangement never saved is lost for good, and Reload from Drive followed by Save stores
      none in its place. Keep the pins Save and Open mark beside `savedText`, and let
      `browserDirty` compare them too, so the existing question covers it. Or keep Undo, or the
      pins, across a Drive open of a model whose element names match.
- [ ] **Give back the library aliases an older api-json Import dropped.** Until fixes2 S5 an
      api-json Import lost the full library's 268 `alias` `Membership` elements, and a browser
      project saved after one still lacks them. `loadFullStandardLibrary`
      (`src/library/full-library.ts`) returns early once a model holds any library element, so
      they never come back and names reached through them stay unresolved. Let the merge add the
      library ids such a model is missing, or tell the user that New and a fresh Import repair it.
- [ ] **Read OMG's other owning memberships as containment in an api-json Import.**
      `fromApiGraph` (`src/persistence/io.ts`) takes ownership from `OwningMembership` and
      `FeatureMembership` only. A graph written by another tool can own a member through a subtype
      (`ParameterMembership`, `ReturnParameterMembership`, `EndFeatureMembership`,
      `ResultExpressionMembership`, …): that membership is kept as an element in its namespace,
      and its member lands at the top level of the model. Sysprose's own export never writes them.
- [ ] **Keep the other writers out of the standard library too.** `connect` (a line drawn from
      a library box in a diagram scoped to the library) and `bindType` (the Type field on a
      library usage) put a new user element — the relationship, the typing — under the library
      element they act on, where the Text view, Save to Drive and Export ▾ → SysML leave it out.
      `createElement`, `reparent`, `reparentMany`, `pasteClipboard` and the SDK's `create` /
      `reparent` send such an element to the top level of the model with a note (`userOwner`);
      give these the same, or refuse with a note.
- [ ] **Keep library elements in the standard library.** The mirror of the item above:
      `reparent` and `reparentMany` move a library element under one of the user's — a library
      row dragged onto a user row in the Explorer (library toggle on) — and the Text view then
      writes it into the user's package (`library part def Shelved;`), while the library no longer
      has it. Refuse such a move with a note, or move a copy.
- [ ] **Give the focus somewhere safe when a rename closes on `Enter`.** `Enter` in the
      Explorer's rename (`tree-rename`), the context menu's (`node-ctx-rename-input`) or a
      Requirements table cell (`req-cell-input`, `req-attr-input`) commits and closes the box,
      and the focus falls to the page (to the canvas node, for the context menu): the next
      `Backspace` deletes the selection — the element just renamed, with its subtree — and a
      digit switches the view. Undo brings it back. `Ctrl/⌘+S` in those boxes already leaves the
      focus on Save (`focusSave`, `src/ui/commands.ts`); do the same after `Enter`, or return
      it to the row, guarded.
- [ ] **Show the strip's note beside its status row, not in place of it.** With Google Drive
      configured, any `info` notice — a save or an export that kept typed text back, an element
      sent to the top level of the model — outranks the rows for a save waiting on a sign-in
      (`expired`), a file in the trash or read-only (`gone`, `readonly`), unsaved changes
      (`dirty`) and being offline (`driveStripStatus`, `src/ui/panels/DriveStrip.tsx`), until it
      is hidden or Undone: the row that says the file lacks the model is not shown. In the other
      direction `sayWhatWasKept` puts nothing up while an unrelated notice stands (a Drive error,
      `<name> closed`), so an export that kept typed text back leaves the file lacking it
      unsaid. Render the note on a line of its own under the row, and hold the export's until
      the strip is free.
- [ ] **Keep text typed in the Text view when a field's change is applied.** An edit in the app
      re-serialises the Text view over text typed there and not applied (`recomputeNow` with
      `forceText`, `src/ui/store.ts`), so a Properties box left — or `Ctrl/⌘+S` typed in it —
      while the Text view reads *modified — not yet applied* drops that text with no note and
      no Undo. Appendix B says so. Apply the typed text first when the element ids survive it,
      or leave it standing, as an SDK edit or a collaborator's does.
- [ ] **Cut the crossings of one-layer General views with hub requirements.** Scoped to the
      drone-swarm model's `OA`, the General view still has ~110 crossings, most of them long
      `«trace»` / `«satisfy»` lines converging on a few hubs (`memberA` takes ~20). Try routing
      those dependency kinds as merged hyperedges of their own, or placing hubs by barycentre.

# To do

Next actions: concrete, small, actionable. Big features belong in [`ROADMAP.md`](ROADMAP.md). Items
that need decisions after research belong in [`RESEARCH.md`](RESEARCH.md).

Entries tagged `[review 2026-10-14 …]` come from the read-only review of Sysprose 5943654 on that date,
and each id is the finding's own in the review's plan: `A-…` is from the per-instance soundness review
(A), `M2` from the behaviour review (B; its other ids closed with `behaviour-sound`), `C-F…` from the
speed review (C), `D-…` from the app and merges review (D), and `PI-` and `EV-` from the decisions batch
and per-instance reporting review (E). The `E<n>` ids and `X2` are rows of the open-items inventory (F),
not of reviewer E; its two further rows are written `F-U1` and `F-C2` here, so that they do not read as
a decision or as another reviewer's id. A model an entry writes out as `package … { … }` is complete and
loads as written; the review file an entry names (`A/probes/…`, `E/pi/…`) is what it was copied from, in
the review's artifact folder, which is not in this repository. Entries tagged `[O1 …]` record what the
merged branch `behaviour-sound` (the plan's O1) left open, by step. An entry that waits on the
maintainer says `awaits user decision U<n>` and names the question.

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
      Awaits user decision U14: whether in-page z3 is worth that cost, and which hosts get the
      headers.
- [ ] **Hold z3's timeout floor where the D5 guard cannot see.** The last case of
      `test/campaign/verification.test.ts` holds every case that hands z3 a check to 40 s: the death
      guard for the DEFAULT 5 s budget, plus 5 s. A check given a larger budget needs that budget plus
      35 s, and nothing holds a case to it (today "an undecided check spends the 2 even when the same
      tree found cut sets" passes 30 s under a 120 s timeout, which is enough). Hooks are not guarded
      (vitest's `hookTimeout` is 10 s; the two that reach z3 now are given 240 s and 600 s). Have the
      bridge report the largest budget handed to it while a case ran, and read the counter around the
      hooks that load z3.
- [ ] **Give the `sysprose` exit test an explicit timeout.** `test/unit/smt-z3-bridge-death.test.ts`
      (*ends with the command's own code once stdout and stderr drain…*, :871) imports
      `scripts/sysprose` and keeps vitest's 5 s default. The review saw it time out locally at
      5943654 while CI passes; run alone on 2026-10-14 it took 2.7 s, so the cost of that import
      depends on the load. It is the shape of the D5 gap, a case whose own cost can outlast the
      default. Give it an explicit timeout of at least 30 s. Done when the case carries one.
      [review 2026-10-14 X2]
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
      "The same answers from a terminal" (:679-725) puts "—" in the *In the app* column for
      `orphans`, `obligations`, `fault-tree` and `reach`, has no row for `check-behaviour`, and its
      † note says `connectivity`, `orphans` and `obligations` exist only in the terminal and the
      SDK. The palette's Checks section has a check for each of them (`src/ui/checks.ts`;
      `fault-tree` answers `not here` with its command). The README's table was corrected in
      0475db6, so the two now disagree. Name the palette check in that column, add the
      `check-behaviour` row, and drop those names from the note.
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
- [ ] **Decide what a palette put away does with an armed tool.** Collapsing the column hides the
      "Placing X" hint, but the tool stays armed until Escape or Cancel, so the next canvas click
      places an element the screen no longer announces. Either name the armed tool on the put-away
      strip (`palette-collapsed-label`) or disarm on collapse.
      Awaits user decision U14: which of the two.
- [ ] **Keep the keyboard focus when the Explorer or Properties column is put away or brought
      back.** The palette now hands the focus to the control that replaces the one pressed
      (`Palette.tsx`, `refocus`); the two side panels (`src/ui/App.tsx`) swap their trees the same
      way and leave the focus on `<body>`.
- [ ] **Give register row W2's per-step alternative a producer.** `ExploreResult.successors` stores
      no transition id per edge, so the trap entry path can never use the per-step wording
      (`TRAP_ENTRY_WALK_ADMITS` exists and is asserted unprinted). Retain the transition id beside each
      successor and wire the alternative.
      Awaits user decision U14 (relax A6 per claim).
- [ ] **Decide how the app shows inherited contract clauses.** The Contracts view shows an inherited
      clause as `N more clause(s) inherited from X`, while `contracts` in the terminal prints its body
      marked `(inherited)`. Either show the body in the app, or record the difference as deliberate
      in `docs/USER-GUIDE.md`.
      Awaits user decision U14: which of the two.
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
- [ ] **Keep a layered General view's column headers on screen while panning down a column.** A
      header (`src/ui/panels/ColumnHeaders.tsx`) is drawn once, above the top of its piece, so in
      the drone-swarm model's whole General view (columns about 19,000 px tall) it is off screen
      at every zoom where the boxes read. Pin it to the canvas's top edge while its piece runs
      beneath it, clamped to the piece; decide how it then stays clear of the boxes under it. A box
      moved by hand is not kept clear of a header either: it can be dropped into a band, and after
      a re-layout its pin keeps its old coordinates (`applyPins`, `src/ui/store.ts`) while the
      headers move with the new layout.
      At the whole drone-swarm v9 Fit (1400×900, zoom about 0.021) the label text of the five main
      headers is about 5.5 px on screen and that of the other sixteen about 1 px:
      `src/diagram/column-headers.ts` sizes the band as the smaller of `COLUMN_HEADER_MAX_H` (640)
      and 4% of the piece's width and the label at most 55% of the band, while
      `docs/USER-GUIDE.md:349-351` says the label "still reads when the whole model is fitted".
      Size the band and label from the fit zoom, or draw labels in screen space, or correct the
      guide, and add a v9-sized guard (the E2E uses a 9-box model).
      [review 2026-10-14 D-7] Awaits user decision U14: how a header clears the boxes under it, and
      whether headers must read at Fit.
- [ ] **Cut the crossings the hub-led layout leaves in the drone-swarm v9 `OA` General view.** The
      view has 46 crossings in the layout's own count (`countCrossings`,
      `src/diagram/layout.ts:531`), down from 88 before the hub-led layout; `memberA` and `memberB`
      (14 allocations each) and `dutyController` (3) are drawn as hubs. d60cd5d measured 31
      crossings, down from 71, in the app with real text widths; that figure was not re-measured at
      5943654. Of the 46, re-counted at 5943654: 26 are two «allocate» lines crossing, 9 an
      «allocate» and a «satisfy», 7 an «allocate» and a «typed-by», 4 two «typed-by» lines: the two
      members' activities share one definition per step, so the two fans interleave. SA and LA are
      at 0. Try ordering the activities of the two fans by their shared definition (barycentre), or
      letting only one member lead. Done when the OA count is below 46 with no overlap or line
      through a box introduced.
- [ ] **Decide what the layout does with a piece that nests (P1).** `layoutOptionsFor(viewKind,
      nested)` (`src/diagram/layout.ts:105`) sets `elk.hierarchyHandling: 'INCLUDE_CHILDREN'` for a
      piece that has a nested box and `SEPARATE_CHILDREN` for every other piece (`214b3c5`;
      `toElkTree` computes `nested`, `:417`), so only the flat case was fixed. Through
      `layoutDiagram` on the `interconnection` view, 30 parents of 10 children and two edges per
      leaf (330 nodes) take 11 113 ms at 5943654 against 171 ms with `SEPARATE_CHILDREN` forced
      (65x); a reviewer's run on a loaded machine read 26 924 ms against 299 ms. ELK runs in a Web
      Worker (`src/ui/elk-worker.ts`), so the page does not freeze, but the diagram appears no
      sooner. On the drone-swarm v9 the option is not the dominant cost (General 5 035 ms against
      4 469 ms forced, `interconnection` 550 against 486, `tree` 44 184 against 42 411; one run
      each). Either drop the option for nested pieces, which trades the layout of edges that cross a
      parent's border for time, or bound the compound layout. Done when that case lays out within
      a time the decision names, measured through `layoutDiagram` (`U diagram.layout2` asserts the
      option for a flat and a nested call, not the time). `docs/UI-ROADMAP.md` P1 has the table.
      Awaits a user decision, not yet numbered in the plan: drop the option for nested pieces, or
      bound the compound layout.
- [ ] **Settle whether a drag-pan closes a canvas context menu, and delete the sentence that is
      wrong.** `docs/UI-ROADMAP.md` says both that wheel-zoom and pan dismiss the fixed-position
      menu (Shipped, *Context menus close when the canvas moves*) and that the menus do not
      dismiss when the canvas is panned (Known limitations). `E gui-context-menu` drives a wheel
      only. `useContextMenuChrome` (`src/ui/panels/useContextMenuChrome.ts`) closes on a canvas
      wheel, on Escape and on a window `mousedown` outside the menu, and its comment calls a pan a
      pane mousedown "already handled by `onDown`"; but d3-zoom's `mousedowned` stops the
      propagation of the mousedown it takes for a pan, so `onDown` may never see it. Open a node's
      context menu in the built app, drag the pane, and see whether the menu is gone. Then delete
      the wrong sentence in the roadmap (and fix the hook's comment if that is the wrong one) and
      add the pan to `gui-context-menu`. Done when the two sentences agree and the spec drives a
      pan.
- [ ] **Give tied centrality scores one rank.** Properties shows `Centrality … #N of 1373`
      (`elementCentrality`, `src/diagram/centrality.ts`). It orders equal scores by element id, and
      ids are random UUIDs (`newId`, `src/core/ids.ts`), so a tied element's rank changes with
      every load: the drone-swarm v9 root package (score 0.0004) read #973, #852, #1188 and #1067
      in four loads of the same file, so tutorial stills that show a tied element's rank differ
      from one recording to the next. Give tied scores the best rank they share (competition
      ranking), or show *tied*, or break the tie by qualified name, which a load does not change.
      Awaits user decision U14: competition rank, *tied*, or a qualified-name tie-break.

## Per-instance readings — follow-ups and known-false rows

Opened by the per-instance readings feature (ROADMAP item removed at step F9). What follows is what
its four surfaces (the check, the literal engine, the numeric surface and the SMT engine) still
abstain on or read false in the four-surface table
(`test/integration/verification.differential.test.ts`): six rows pinned `KNOWN_FALSE`, seventeen
`I7_ALLOWED` entries (the per-instance branch removed one and added seven for its refute-r1d and
sh7 probes), and the abstentions the entries below name. The false verdicts the review of
2026-10-14 found in the per-instance code itself follow under their own headings.

- [ ] **Let an asserted equation override a `default`, on every surface (H5).** Every surface treats
      an assert over a default as a contradiction today. For `package HL { attribute L :
      ScalarValues::Real default = 2.0; assert constraint qa { L == 5.0 } constraint c { L <= 3.0 }
      }` the check reports `Constraint violated: L == 5.0`, the literal engine decides `c` at 2
      and SMT reports the axioms unsatisfiable; an enclosing assert (`package HE { part def P {
      attribute x : ScalarValues::Real default = 2.0; constraint c { x <= 10.0 } } part def Q {
      part p : P; } part q1 : Q { assert constraint tie { p.x == 50.0 } } constraint top {
      q1.p.x <= 10.0 } }`) does the same, and the enclosing-assert abstention (`enclosingAssertOn`,
      `src/semantics/evaluate-model.ts:318`) keeps the per-instance read of it from deciding. The
      decision of 2026-10-12 is that an asserted equation that defines a feature stands over its
      `default`, local and enclosing, as a binding does; it is recorded only in the workflow repo's
      session handoff, while the per-instance plan still says the opposite. The first attempt
      (075b306, reverted by ab965c7) broke the solver-units chain cases because of one block in
      `quantityScopeFor` (`src/semantics/units-eval.ts`) that derived inside a constraint body scope
      and for value-less features, so a 70-long chain went past `MAX_DERIVATION_DEPTH` (64) and read
      `unknown`; without its `|| !hasStatedValue(…)` clause solver-units was 131/131 and the
      differential stayed green except eight I3 rows, each back at its earlier value. The redo, one
      gated step each, solver and SMT changed in the same step as the check: (1) a cached
      `assertHeld` index on `model.rev` feeds `defaultGivesWay`, `defaultGivesWayIn` and
      `defaultGivesWaySomewhere` (`src/semantics/defining-equation.ts:2710`), looked up through the
      owner's type closure and the redefinition closure so an inherited assert counts, with no
      `quantityScopeFor` block; (2) dotted defined names (`p.x == 3.0`), including the caller-side
      "names an equation fixes"; (3) an `assertHeldIn` instance set so an enclosing override splits
      the instance on the solver (`solver.ts:1184`, `:1262`), in SMT's instance value row
      (`obligations.ts:1881`) and in the frame walk (SMT's clash is structural: `x` is one variable
      with no instance), narrowing `enclosingAssertOn` to inequality-only asserts, undecided
      partners and two values. Done when R1 `P::c in q1::p` reads F/F/F/F (ref F, now T), `top1`
      F/F/F/F, `q1::tie` T/-/T/-, and `P::c`, `in Q::p`, `in q2::p` T/T/T/T; the eleven
      `I7_ALLOWED` entries that name refute-r1, refute-r1d or sh7 are deleted; a 70-long
      chain of defaults each overridden by a local assert is green beside the three solver-units
      chain cases; and no row of a self-contradictory model (N2, R8, GA5B, GA6) is newly decided.
      [review 2026-10-14 E1] Awaits user decisions U4 (is the 2026-10-12 decision binding), U5 (an
      inequality assert over a default: does the default stand?), U6 (the ref changes above) and U7
      (a usage's `:>> L default = 9` under an inherited `assert L == 5` reads 5; `assert p.x == L`
      with defaults on both sides abstains).
- [ ] **Read a package-level or definition-feature binding, and a redefined bound usage (`w4`, R13,
      R13b).** A `bind` written at package level or between two definition features (probe `w4`) is
      left unread per instance, so the value it carries never decides a row (`W4::c2` reads ?/?/?/?
      with no ref; the intended ref is F), and the connector is outside the per-instance frame walk.
      The same family: `part pp :>> p` redefining a bound usage (`R13` and `R13b`, ?/?/?/? beside
      refs T and F). 075b306 (reverted by ab965c7) had `featureAtPath` and `boundSourceIn` read it
      and reached R13/R13b T/T/T/? and F/F/F/? and W4 `c2` F/F/F/?, missing the SMT row. Reuse those
      two and add the SMT side. Done when `W4::c2` reads F/F/F/F and R13/R13b read T/T/T/T and
      F/F/F/F. [review 2026-10-14 E2, E8] Builds on the H5 entry above; awaits user decision U6 for
      W4's ref.
- [ ] **Resolve a name through the writing element's lexical scope (`h2p0`, `h2c0`, EnclW rows).** A
      name not found in the feature scope reads unknown: in `package Lex { attribute K = 7.0; part
      def A { attribute x = K; constraint c { x == 7.0 } } }` `verify --engine literal` says `c` is
      not evaluable, and so is the qualified `x = Lex2::K` and a nested definition reading its
      enclosing definition's `y`. The two per-instance probes `h2p0` and `h2c0` and the
      enclosing-definition control rows (EnclW1 ×3, EnclW3 ×3, EnclW5 `ctlA`, EnclW4 `rc`) abstain
      for this reason. Fix: resolve a name not found in the context's feature scope through the
      writing element's owning namespaces; a package feature is one instance, an enclosing
      definition's feature is read in the enclosing instance, and a generic read abstains where a
      specialiser changes the value; handle both `= L` and `assert { p.x == L }`. Done when those
      ten rows decide on all four surfaces. [review 2026-10-14 E3] Builds on the H5 entry (the
      instance machinery).
- [ ] **Decide the nonlinear and implicit shapes (classes D and E).** `b4c`, `n4`–`n6` and
      `s2-usage-assert-leak` abstain because their value is nonlinear or implicit (n4's
      `x * x == -1.0` admits no model), and the inequality-only asserts (B2 `g1`, S2 `y1`) leave no
      value to read; none of this is the H5 question. Either an exact solve (z3 NRA) later, or a
      permanent abstention with this item dropped; reading the solver's binary64 values in the check
      would break soundness decision 3. Done when the maintainer has chosen and the rows are pinned
      with that reason. [review 2026-10-14 E4] Awaits user decision U8 (keep classes D and E
      abstaining for good and drop the item, or schedule an NRA solve).
- [ ] **Make the implicit end copy of a usage-body binding redefine the most specific inherited
      feature (`h2-bodyspec`).** Four rows are false on all four surfaces and pinned `KNOWN_FALSE`
      (`verification.differential.test.ts:5015`): `h2-bodyspec-plain` m2NegT and m2PosF,
      `h2-bodyspec-rev` lT and lF. Probe (`h2-bodyspec-plain`): `package H2BP { part def P {
      attribute load default = 1.0; attribute m2 = 10.0 - load; } part def Q { attribute L :
      ScalarValues::Real; part p : P; } part def Q2 :> Q { attribute :>> L = 50.0; } part q : Q2 {
      bind p.load = L; } constraint m2NegT { q.p.m2 <= 0.0 } constraint m2PosF { q.p.m2 >= 0.0 }
      }` (re-run at 5943654: `verify` refutes `m2NegT` at 9 on the literal and SMT engines): the
      copy `q::L` redefines `Q::L`, not `Q2::L` (`ensureImplicitFeature`,
      `src/text/langium/map-to-model.ts:440-476`, handed the declaring feature by the head-name loop
      at `:562-576`), so every surface reads the general value or none and P's default stands
      (m2NegT reads F/F/F/F where it is T). Fix: make the copy redefine the most specific inherited
      feature (compare `findTypeFeature`, `:423`, which does this for the segments of a chain), or
      refuse such a binding on every surface. Done when the four rows leave `KNOWN_FALSE`.
      [review 2026-10-14 E5] Awaits user decision U10 (fix the mapper, or refuse the binding on all
      four surfaces).
- [ ] **Settle `d1plain`: a plain value against a bound end.** Two rows, `D1P::at30` and `D1P::atL`,
      are pinned `KNOWN_FALSE` and `I7_ALLOWED`. Probe: `package D1P { part def P { attribute load
      default = 1.0; attribute m2 = 10.0 - load; } part def Q { attribute L = 50.0; part p : P; bind
      p.load = L; } part q : Q { part :>> p { attribute :>> load = 30.0; } } constraint at30 {
      q.p.m2 >= -20.0 } constraint atL { q.p.m2 <= -40.0 } }`: `q` states `load` twice (30 against
      the bound 50), the check, literal and numeric surfaces decide T/F where the ref is `?` (re-run
      at 5943654: the literal engine holds `at30` and refutes `atL`), and SMT reports
      `inconsistent-axioms`. Either all three abstain
      (`two-values`, both rows leave `KNOWN_FALSE` and `I7_ALLOWED`), or today's reading stays and
      the ref becomes decided. Done when the rows leave both lists. [review 2026-10-14 E6] Awaits
      user decision U11 (abstain, or keep today's reading and decide the ref).
- [ ] **Read a context row whose bound partner is a derived value that differs per context.** Three
      rows are refused by the "reads it alike" guard and abstain (?/?/?/?, ref F):
      `M7::Q::c in M7::q2`, `FanS2::QB::cq in FanS2::Q2` and `EnclW4::R::rc in EnclW4::r`. Fix: read
      the context row at the context's own instance (`instanceNameOf(context)`) through the
      per-instance read (rebase, then the binding's value in that instance) instead of refusing.
      Done when the three rows read F on all four surfaces. [review 2026-10-14 E7]
- [ ] **Let SMT confirm the witness of the ten rows it abstains on beside a decided verdict.** SMT
      answers "witness not confirmed" (the same-point gate,
      `src/semantics/engines/smt.ts:1785-1812`) on u-m2 (`m2NegT`, `m2PosF`: T/T/T/? and F/F/F/?),
      EnclW5 (`negT`, `posF`), GlobW10 ×2, fx4 ×2, D1 `gDerF` and C1 `gF`. Fix: instance value rows
      for unit-typed derived values (u-m2), usage-body frames (EnclW5) and package-derived G
      (GlobW10) in `instanceValueRow` (`src/semantics/obligations.ts:1881`); make the confirm step
      compare the same feature (`q::s`, not `P::s`; D1, C1); encode `%` over a constant divisor as
      `x = d·k + r` with integer k in QF_LIRA (fx4). Done when those ten rows read the decided
      verdict on SMT too. [review 2026-10-14 E9]
- [ ] **Read bindings deeper than 32 usages (optional).** A context more than `MAX_BINDING_SEGMENTS`
      (32, `src/semantics/defining-equation.ts:2001`) usages below where its binding is written is
      not read, so the check and the literal engine abstain on `chain33` and `chainPkg33` (four
      rows; `DP33::negT` reads ?/?/T/T and `posF` ?/?/F/?). Sound, only weaker than it could be.
      Raise the cap or make the instance walk iterative. Done when those rows decide on all four
      surfaces. [review 2026-10-14 E10]
- [ ] **Pin R18's refs null, citing decision 8.** The parameterised calculation `Twice(K)` is
      refused on every surface (permanent, soundness decision 8), so `R18::m2NegT` and `R18::m2PosF`
      read ?/?/?/? beside refs T and F (`verification.differential.test.ts:4412-4413`). Set the refs
      to null and cite the decision on the rows. Done when the two rows pin null refs with that
      comment. [review 2026-10-14 E11]

## Per-instance soundness — review 2026-10-14

From the soundness review of F3–F8 and 3e3b0ff (Sysprose 5943654 against 7277a97). The branch
`per-instance-sound` (merged by `4ac2fff`) closed A-C1, A-C2, A-C3, A-H1 (the direct reads), A-H3
and A-H4, PI-1, and the correctness half of A-H2: instances now read where they stand, abstain where
they cannot, and the four-surface table pins A1–A9, A4, CAP1, X-shapes and the units shapes at their
true values. What follows is what that branch and the review of it left open; entries tagged
`[O2 …]` come from its steps and reviews.

- [ ] **Read through a part-valued binding.** `bind pp = top.a`, where `a` is a part, equates the
      two parts, so `pp.load` is what `top.a.load` is. No surface reads through it, and all four
      agree on the wrong value (since 5943654; found by the review of the O2 S3 step). Probe
      (`ppshallow`): `package PPS { part def T0 { attribute load : ScalarValues::Real default =
      1.0; } part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; bind
      a.load = L; } part top : T1 { attribute :>> L = 50.0; } part pp : T0; bind pp = top.a;
      constraint pT { pp.load >= 40.0 } constraint pF { pp.load <= 5.0 } }`: `sysml-check` and
      `verify` read `pT` violated (1 vs 40) and `pF` held, where `pp.load` is 50, so `pT` holds and
      `pF` is violated; `capp` is the same shape past the 32-usage cap. Fix: follow a part-valued
      binding in `boundSourceIn` and the connector components, or abstain on it on every surface,
      and pin both probes in the four-surface table. Done when `pT` reads T and `pF` F on all four
      surfaces (or both abstain with a stated reason), and `sysml-check --strict` agrees with
      `verify`. [O2 S3]
- [ ] **Read an own row and an inherited assert past an enclosing assert.** Two shapes of the H5
      entry above stay open after the per-instance branch: (1) an own row on the unit-aware path
      (`R1M` `top2`/`top4`, `R1B6` `top4`/`top6`) and `H1C` `top1` past the package's assert are
      decided from the default where the enclosing assert fixes the value; (2) an assert inherited
      from the instance's type (`h1f`, `h1f2`: `Q2 :> Q { assert constraint ... }`) is not seen by
      `enclosingAssertOn`, because the type definition's own frame is read as before. Both are
      pre-existing and part of the enclosing rule (`h5`, step 3). [O2 S3]
- [ ] **Say what a capped binding does to "did not converge".** A model with a binding past the
      32-usage or 4,096-context cap (`cap1`, `cap2`, `m5`) now reads `did not converge` in the
      app's Solve header (it read `converged` before, beside a false verdict), because the values
      held past the cap are not read and the solve counts them as undetermined; the rows themselves
      carry the cap sentence. The user guide's convergence bullet says relations over unread
      values are unjudged "with the reason *the solve did not converge*". Either stop counting
      held-past-cap values against convergence or say in the guide that a capped binding reports it
      and its rows name the cap. [O2 S3]
- [ ] **Meet the per-instance targets on a cold check.** After an edit, `big-bind-1200`'s check takes
      1.3 s against the 1 s target (`7277a97`: 0.73 s), `tree10`'s warm check is about twice
      `7277a97`'s (16 against 7–8 ms) and `big-bind-600` is 560 ms cold; the warm figures meet every
      target. About 0.2 s of `big-bind-1200`'s cold check is `componentConnectors` filtering every
      user binding connector once per component (index it by connector end), and `abstainedRead`
      adds about 30 ms warm on `big-bind-600` (restricting it to models that assert something
      changes no row on the 1,289 review models). Done when `big-bind-1200` is under 1 s cold, or the
      target is restated on the warm figure with the reason. [O2 S5, review 2026-10-14 A-H2]
- [ ] **Contain the last throw paths and decide P5.** The throw paths in `groupGoalRows`
      (`src/semantics/obligations.ts`) and `instanceGroups` are not contained as
      `bindingConflicts` and `boundInInstanceQ` now are (a throw becomes one `internal` refusal), so
      a throwing read there still ends the whole check (A.2.9). The planted bug P5 (literals counted
      in `readsOtherwise`) is an equivalent mutant: no test can turn red on it until H5 is decided,
      so give it a pin after `h5`. [O2 S6, review 2026-10-14 A-H4]
- [ ] **Keep a definition-owned relation read through a binding from reading `OK`.** `n02` (a relation
      owned by a definition and read through a binding) is silent where it should be read or
      refused: `sysml-check --strict` says `OK` with no row for it. Pre-existing. [O2 S6]
- [ ] **Say the same thing about a bare literal in the note and the row.** After a carried value is
      read in the filled feature's declared unit, the `U3` note still reads `refuted … (5 vs 10 in
      M, coherent SI)` beside a verdict the unit reading reached; the literal and SMT notes of a
      carried value also lack the `(x vs y in M, coherent SI)` clause and print the end copy with
      unit null, and the value-source clause prints a converted value without its unit (`load =
      5`). Pre-existing for `U3`; the rest is display only, with A-M2. [O2 S6]
- [ ] **Read per-instance bindings by path, not by feature.** The detection of a binding into a
      redefiner matches by feature, so a binding into another part typed alike can form an extra
      group. The extra group's rows are read correctly, so this costs rows, not verdicts. [O2 S4]
- [ ] **Compare the SMT same-point gate in SI.** The gate (`src/semantics/engines/smt.ts:1785-1812`)
      compares the witness in its own unit with the check's SI value (`read.exact`), so IU1 `rF` (in
      the out-of-tree corpus; the `IU1` model of `verification.differential.test.ts:5246` has `rT`
      only, `r.total` = 4 GiB) fails with "not the model's point (4/1 vs 34359738368/1)" and SMT
      goes F → ?: a weakening the corpus gate never named. Compare in SI. Done when IU1 `rF` reads F
      on SMT again. [review 2026-10-14 A-M1]
- [ ] **Print the value beside a decided group verdict.** Witnesses carry no value next to a decided
      verdict: the A2 group rows print `load=null`, A9 the same, and A7 `top` prints
      `q2.p.extra=null` (`modelBindings`, `src/semantics/engines/literal.ts:460`; `collectReads`,
      `evaluate-model.ts:1832`), though the F2 addendum required them; abstaining group rows print
      the usage's generic witness values, and the violated-instance finding's anchor and value clause
      sit at the shared usage (`cr-s4/gap/g-a4r2`, `cr-s4/single/s-calcF`, `cr-s4/own/o-refF`,
      A7 `s-a4`, which names `load = 1` where the differing value is `extra = 20`). Fill them from
      `check.reads`. Done when A2, A9 and A7 print their values. [review 2026-10-14 A-M2; O2 S3, S4]
- [ ] **Key the per-instance memo on the instance and the position.** The memo key at
      `src/semantics/evaluate-model.ts:673` drops `at` when `inst` is set. No collision was found,
      so it is latent. Key on (id, inst, at). Done when a test reads two names that differ only in
      `at` under one `inst`. [review 2026-10-14 A-L2]

## Per-instance reporting and evidence — review 2026-10-14

From the review of the decisions batch and the per-instance reporting (Sysprose 5943654 against
7277a97). `validation/constraint-by-instance` is the finding an instance group's violated reading
becomes; the evidence entries are the `sysprose-evidence/2` facet (05e45a4).

- [ ] **Anchor a violated-instance finding at the line that differs.**
      `SpecialisationInstance.anchorId` (`src/semantics/evaluate-model.ts`) is read by
      `anchorFor` (`:1102`), which the Solve row calls (`src/semantics/solver.ts:4780`), but nothing
      in `src/` assigns it, so a finding points at the shared usage's feature instead of the
      instance's differing redefinition, while the hint says "the line the finding points at". Probe
      (m1, the review's `E/pi/m1.sysml`): `package H { part def P { attribute load default = 1.0;
      constraint c { load <= 10.0 } } part def Q { attribute L default = 1.0; part p : P; bind
      p.load = L; } }` and eight usages `part qN : Q { attribute :>> L = 50.0; }` (N = 1 to 8): all
      the violated-instance findings sit at `part p : P` in `Q` (`3:64` when the package, `P` and
      `Q` each take a line), none at a `:>> L` (re-run at 5943654; the single-instance finding of `4ac2fff` anchors the same way).
      Fix: set `anchorId` to the differing redefinition or stated member when the group row is built. Done when m1's findings anchor at each usage's `:>> L`
      line. [review 2026-10-14 PI-2]
- [ ] **Route a binding-carried context read to `constraint-by-instance`.** The per-instance plan
      sends a context read that goes through a binding (h2c, k2, M7) to
      `validation/constraint-by-instance`. Those reads do not get the `via` flag (`via` is set only
      where `boundAbove` finds a binding above the context, `src/semantics/evaluate-model.ts:1397`),
      so they pass the filter of `target-by-specialisation` (`src/validation/rules.ts:1028`:
      `via !== true && instance === undefined`) and are reported with that code, anchored at the
      definition feature. mbse-workflow treats `target-by-specialisation` as REPORTED_ONLY ("do not
      change an estimate to meet it"), the guidance the plan's H3 rejected. Probe (h2c, the
      review's `E/pi/h2c.sysml` without its second usage): `package H2C { part def P { attribute
      load default = 1.0; attribute m2 = 10.0 - load; } part def Q { attribute L default = 1.0; part
      p : P; bind p.load = L; constraint c { p.m2 >= 0.0 } } part q : Q { attribute :>> L = 50.0; }
      }`: `sysml-check` prints `validation/target-by-specialisation q::p.m2 = -40 misses Q::c` and
      no `constraint-by-instance` (re-run at 5943654). Fix: mark any
      binding-carried context read as an instance reading, and re-check mbse-workflow's code notes
      against the new routing. Done when h2c, k2 and M7 emit `constraint-by-instance`.
      [review 2026-10-14 PI-3]
- [ ] **Roll up per (relation, usage), fold past twenty, and skip the generic row.**
      `instanceRollup` makes one roll-up per relation, so "50 instances of Big::Q0::p" spans 25
      usages and the more-than-20-usage fold never happens [PI-4]; `target-by-specialisation` also
      fires on the generic (definition's own) rows (`src/validation/rules.ts:1028` filters `via` and
      `instance` but not `generic`), so findings are duplicated and the CLI disagrees with the app,
      which filters them [PI-5]; big-bind-600 gets 7 findings where 6 are expected [A-L1]. Fix:
      group by usage, then fold, and add `&& i.generic !== true`. Done when big-bind-600 gives 6
      findings and `m1` the same findings from the CLI and the app.
      [review 2026-10-14 PI-4, PI-5, A-L1]
- [ ] **State an unknown's cause and the cap, match the message texts, and quote paths.** The
      roll-up never says why an instance could not be read, though its hint promises it (no bound
      feature has a value, defaults differ, an enclosing assert constrains it, too many instances)
      [PI-6]; a group over `MAX_INSTANCE_READS` (4096, `defining-equation.ts:2984`) gets no finding
      and no `unread` count [PI-7]; the texts drift from the plan's wording: no source value or
      bind, an empty `listed: ` (A2's `sysml-check` prints `…; listed: `), and unquoted paths that
      clash with ` in ` or `@` (`A@B::x`) [PI-11]; and the fold in `foldTargetRows`
      (`src/validation/rules.ts:1057`) groups by result only, not by result and cause [PI-12]. Done
      when a finding names its cause, an over-cap group reports it in `unread`, the texts match the
      catalogue word for word, and a path holding ` in ` or `@` is quoted.
      [review 2026-10-14 PI-6, PI-7, PI-11, PI-12]
- [ ] **Fold the `verify` text and name the relation in its footer.** `verdictResultLines`
      (`scripts/sysprose.ts:1997`) keys its fold on `obligationDigest`, which is unique per row, so
      it never folds: `verify --engine literal` on m1 prints all 8 refuted rows (re-run at 5943654)
      [PI-8]. The footer fold (`:523`) names an instance where it should name the relation [PI-9].
      Key on the base id (before `@`) and name the relation. Done when m1 prints five rows and one
      line counting the rest, and the footer names the relation. [review 2026-10-14 PI-8, PI-9]
- [ ] **Make the Problems tab label's producer split show, or remove it (H6b).**
      `src/ui/panels/BottomPanel.tsx:632-639` labels the Problems tab `Problems (N check · M solve)`
      when both producers filed rows, but Check and Solve each replace `diagnostics` wholesale
      (`src/ui/store.ts:3169`, `:3257`) and validation rows carry no `producer`, so the label can
      never show. The per-instance plan deferred H6b because of the tutorial videos; 3e3b0ff shipped
      it with a per-row producer chip on v9's screen. Either count every row by producer, or remove
      the dead branch (the chips stay). Done when the label either shows on a model with both or is
      gone. [review 2026-10-14 PI-10] Awaits user decision U13 (count every row, or remove the
      label).
- [ ] **Take the minimum over a requirement's per-reading records when writing its case verdict.**
      `evidence-attach` writes the case verdict after attaching (`scripts/sysprose.ts:3347`,
      `writeCaseVerdicts`), but `judgedFromRecords` (`:3203`) looks the requirement up by name and
      cannot find the `R in X` name a per-instance relation carries, and `writeVerdict`
      (`src/semantics/verify.ts:864`) takes the case's verdict from the records it does find. Probe
      (h5): a requirement `LoadReq` verified by `VC` over two readings, p1 with load 50 (refuted)
      and p2 proved: `verify --engine smt --record`, then `evidence-attach` prints
      `H::LoadReq — verdict fail → pass from H::VC` and writes `verdict = "pass"` over a live
      refuted v2 carrier; every re-attach flips it again (`evidence-status` flags it as
      `verdict-overstates-evidence`). Fix: map `instance.requirement` back and take the minimum over
      the per-reading records, or have `writeVerdict` take the worse of the two. Done when the h5
      probe ends `fail` after attach and stays `fail` on every re-attach, with v9's records, attach
      output and status unchanged (83 records, 49 attached, 34 skipped). [review 2026-10-14 EV-1]
- [ ] **Write `instance` into `verify --record` and stop splitting names at the last ` in `.**
      `verify --record` never writes `sysprose-evidence/2` (the branch at `src/api/evidence.ts:1356`
      is dead; all three records on h5 are `…/1`), so v2 exists only after `evidence-attach`
      upgrades a record [EV-5]. Attach then recovers the reading by splitting
      `requirement in reading` at the last ` in ` (`targetOfRecord`, `evidence.ts:1889-1912`):
      `H::p in 1` is skipped with the false reason "record was produced against a different file"
      and the facet reads `pass` with the refuted reading left out of the minimum [EV-2]; and the
      split accepts any element and any reading, so a v1 `H::P in H::p1` attaches to the part def
      `H::P` and `LoadReq in H::nowhere` attaches and fails `LoadReq`, clearable only by detach
      [EV-3]. Fix: pass `instance` from the `verifyModel` rows into the record
      (`src/api/verification.ts:1446`), stop splitting for v2 records, and for v1 records require
      `isRequirement(target)` and a reading that resolves. Done when `verify --record` writes `…/2`
      with the facet, `H::p in 1` attaches to its requirement, and a v1 record on a part def is
      skipped with its reason. [review 2026-10-14 EV-2, EV-3, EV-5]
- [ ] **Attach a refuted reading of `massR : LoadReq` to the requirement the `satisfy` names.** A
      refuted reading of a requirement usage typed by a requirement definition lands on the
      definition `LoadReq`, while `massR` gets nothing (`src/semantics/obligations.ts:390-397`,
      `:968`). Attach it to the requirement the `satisfy` names, or document the fold. Done when the
      refuted reading of `massR : LoadReq` is attached to `massR`. [review 2026-10-14 EV-4]
- [ ] **Close the evidence record's loose ends: an empty reading, an unchecked requirement, a
      usage.** The schema accepts `instance.reading: ""`
      (`docs/schemas/evidence-record.schema.json`, the `instance` facet), and an empty key collides
      with the own row ("fail → pass") [EV-6]; nothing cross-checks `instance.requirement` against
      `obligation.requirement`, and a shared-usage reading records the usage, not the instance
      (`obligations.ts:1063`) [EV-7]. Add `minLength: 1`, cross-check the two fields and record the
      instance path. Done when an empty reading fails the schema and a mismatched pair is refused.
      [review 2026-10-14 EV-6, EV-7]

## Load health and the model the checks read — review 2026-10-14

From the review of the load-health certificate (679a5e5) and of the checks worker (the ux merge).
The load health no longer vouches for a text it has not parsed (branch `load-health` S1: each
text is parsed, validated and written back in the checks worker, so a text that parses to
another model is told apart too), and the worker rebuilds the page's model after a reparent
(S2: Save, Undo and Redo, the Model JSON and OMG API JSON exports, a push to an OMG API server
and the worker's copy list each owner's children in the order the model holds them, and a drag
lists the page's own model in that order). A check's click no longer holds the page for work
that grows with the model (S3, guarded on the drone-swarm v9 model). What remains is the cost of
an edit itself on v9, which S3 measured, the order between elements of different owners, and a
collaboration room's child order.

- [ ] **Cut what an edit costs the page on the drone-swarm v9 model.** Each edit's recompute
      (`recomputeNow`, `src/ui/store.ts`) validates the whole model and writes its text on the
      page's thread before the diagram is rebuilt: one task, after every edit, whether or not a
      check is run, of 0.14 to 0.63 s on v9 in a browser, the longer the more loaded the machine
      (load averages from about 4 to about 20; in node, validation about 0.35 s and the text 0.15
      to 0.3 s). A palette check's click no longer runs it ahead of time (branch `load-health` S3: the
      run begins first and reads the load once its row is drawn, `runCheckedOnceDrawn`), but the
      page still stops for it after each edit, and the `E palette-checks` guard on v9 leaves that
      task out as the edit's. Fix: validate only what an edit can change, write the text in a
      worker, or both, measured on v9 first. Done when an edit on v9 leaves no task over 200 ms on
      the page with the machine loaded, measured as that guard measures a click. [review
      2026-10-14 D-3, measured on the `load-health` S3 tree]
- [ ] **List the elements of different owners in the order the text gives them.** The page and
      every copy of its model (the checks worker's, Undo's, Save's) now list each owner's children
      in the order the owner holds them, but elements of different owners stay in the order they
      were added, by a load, a creation or a drag (`Model.adoptSerialOrder` and `inSerialOrder`,
      `src/core/model.ts`), while a terminal over the saved text reads them from top to bottom. So
      the two can disagree on whatever goes by the model's order across owners: the order of
      `reach` and `check-behaviour` rows, and a choice of the first of several, such as the first
      transition out of an `initial` when the transitions have different owners. Probe:
      `package P { package Q1 { state def M1 { state a; state b; state dead1; transition t1 first
      a then b; } } package Q2 { state def M2 { state x; state y; state dead2; transition t2 first
      x then y; } } }`; drag `Q1` out of `P` and back in: the Text view lists `Q2` first, and
      `reach` on the saved text reports M2's rows first, while the page and the worker report M1's
      first (measured on the `load-health` S2 tree). No drag is needed: a machine `M0` created in
      `Q1` after the load is reported after M2 on the page and in the worker, and before it by the
      terminal. Fix: list the user's part in containment
      pre-order after each edit, at a measured cost on the drone-swarm model (a load is not in
      pre-order: 1,030 of its 3,823 user elements would move), or order the rows by the text.
      Done when the probe's page, worker and terminal rows come in one order. [review 2026-10-14
      D-1, the S2 review]
- [ ] **Keep each owner's child order in a collaboration room.** A room keeps the model's
      elements in a `Y.Map` (`src/collab/model-doc.ts`), and a peer rebuilds the model from it in
      ways that lose the order an owner holds its children in. `reconcileModelFromDoc` creates the
      elements it is sent last to first, so a batch of new elements in one peer (one transaction,
      or a reset: Apply, Import, Undo, Redo) reaches the others reversed: three parts `a, b, c`
      made in one transaction read `c, b, a` on the other peer, and a reset to `x, y, z` reads
      `z, y, x`. And a peer that joins loads the model in the map's key order
      (`serializeFromDoc`), where a drag changed only the element's owner: after `toA` of
      `start, A, B, toA, toB` is dragged out of its machine and back in, the room holds
      `start, A, B, toB, toA` and a peer that joins then holds `start, A, B, toA, toB`, and walks
      `toA` out of `start` first. Its Text view differs, and a composite with no `initial` can enter
      another state. A peer present at a drag takes it in as a move, and lists its model as the
      mover does (`load-health` S2). Fix: create in the map's order, and carry the child order in
      the document (an order key per element, or a `Y.Array` of child ids per owner). Done when a
      test shows every peer's children in the mover's order after a batch, a reset and a drag
      followed by a join (measured on the `load-health` S2 tree). [review 2026-10-14 D-2, the S2
      review]

## Behaviour checks and the palette's checks lane — review 2026-10-14

From the reviews of the behaviour lane (reach and check-behaviour in the palette) and of the ux
merge. The branch `behaviour-sound` (merged by `e0d8040`) closed the completion budget, the nested
`state def`, the method text and the completion livelock (C1, H2, C3, H1, M3, M1, U1); the entries
tagged `[O1 …]` are what its steps and reviews left open.

- [ ] **Give "no trigger is ever offered" and the budget-withheld `recovery` their own codes.** Since
      `e0d8040` v9's `PA::SwarmMember::SwarmMemberStates` rows read PASS and the `--max-configs`
      advice is gone (`docs/06-model-checking-implementation-plan.md` §8.5), but the codes are still
      borrowed: where only the "alphabet not offered" clause fails, the search files
      `verification/bound-exhausted` although no bound was hit, and a `recovery` the chase budget
      withholds (`check-behaviour examples/uav-isr.sysml --element FlightModes --pattern
      'pattern=recovery, scope=globally, p=state standby'`, exit 2) is filed under
      `verification/behaviour-unsupported-construct`, which the catalogue describes as a construct
      the engine does not explore. Fix: a code and sentence of its own for each (catalogue entries
      and `npm run codes`). Done when both print their own code. [review 2026-10-14 M2; O1 S2]
- [ ] **Count what fires in reach's "N of M transition(s) fired".** The count includes a completion
      transition that is enabled only where the chase budget stops a chase (`chain65`'s edge into
      `c66`, printed beside `unreachable c66`), as it already includes transitions beaten by
      priority: it counts enabled transitions under a label that says fired (`docs/06` §8.7).
      Fix: count the transitions some run fires, or say enabled. [O1 S2, S4]
- [ ] **Searches the walk still refuses.** (1) On a machine that names no trigger, the property
      search runs without the chase position, so a counting monitor round a completion cycle
      (`bounded-existence` of a state at most 40 times round a two-state cycle) is refused as
      inconclusive rather than decided. (2) On walks that carry the chase position, the depth bound
      counts chase steps, not event steps, so four stacked completion cycles stay inconclusive; the
      printed `maxDepth` would change meaning with the fix. [O1 S2]
- [ ] **Walk a step written over inherited states.** Since `e0d8040` a control edge written outside a
      machine's region that touches one of its states refuses the machine (`machine-boundary`,
      `docs/06` §8.6). A specialisation that adds a step over inherited states (`package W2 { state
      def Base { state a; state b; state c; transition ab first a accept go then b; } state def
      Derived :> Base { transition bc first b accept more then c; } }`), or a typed usage that does,
      therefore refuses both `Base` and `Derived`, where `5943654` walked `Base` alone. Fail-closed by
      design. Fix: a reading that walks the two together. [O1 S3]
- [ ] **Report a property no machine checks.** A property carried by a top-level `state def` that owns
      no transition is checked by nothing and reported by nothing (a nested one is reported as not
      checked since `e0d8040`). [O1 S4]
- [ ] **What the livelock rows still lack.** (1) `check-behaviour` files no row for a livelock it
      withholds; a row needs a catalogue code of its own. (2) A cycle of substates is a cycle of
      configurations only once the composite has recorded its history, so the way in of
      `{comp, i1, i2}` reads "entered in 2 step(s)" although its states are entered at step 1; this
      closes with the entry on the history map in `hashConfig`'s key (above). (3) Not probed: the
      `covered`/`fail` witness note may key on the machine's published choice rows, so a witness
      through a branch whose choice row is withheld (the hidden-choice shape) may carry no simulator
      sentence; the witness still replays. (4) `reach` is about 20% slower than at `5943654` on a
      9,641-configuration machine (about 240 to 290 ms), from the livelock pass (`docs/06` §8.8).
      [O1 S5, branch review]
- [ ] **Wording O1 left.** (1) The store clause says a completion guard the walk cannot decide is
      "read as false": that is the interpreter's reading, while the walk fails closed there
      (`explore.ts`, `docs/06` §8.7). (2) A machine refused for two crossings prints
      `machine-boundary, machine-boundary`, as several dangling transitions already repeat their
      construct. (3) The replay's departure message prints `transitionLabel` with nested backticks
      (`ai (a -> Inner) on `e``). (4) The `verification/witness-not-replayed` hint sends the reader to
      the Simulation tab, which cannot follow a tie-break branch. [O1 S3, S4, branch review]

## Solver and speed — review 2026-10-14

From the review of the speed2 branch (66704a8, 79f7350, merged by 607e783): no verdict, code, exit
code or value changed, and the claimed gains reproduce. These three are what it left.

- [ ] **Sort the unsat core before printing it in `bounds` and `refine`.**
      `src/semantics/bounds.ts:883` (and the stored `vacuityCore`, `:908`) and
      `src/semantics/refinement.ts:1400`, `:2206` print z3's core in the order z3 returns it, which
      flips between runs on the same tree (z3 GC timing); `smt.ts` sorts its cores (`sortedCore`).
      `src/semantics/fault-tree.ts:850` prints its core the same way (whether those cores arrive
      sorted was not checked). Probe: `r15-renamed-redef` printed one order in one differential run
      and the other in 3 of 3 reruns. Done when it prints the same core on 5 reruns.
      [review 2026-10-14 C-F3]
- [ ] **Record the provenance of reused `bounds` rows, or keep the option internal.** `checkBounds`
      and `prepareBounds` (exported at `src/semantics/index.ts:277-278`) reuse a caller's `rows`
      when `rowsRev === model.rev` (`src/semantics/bounds.ts:517`) and check nothing else, so rows
      from `obligationsOf(m, { scopeId })`, or from another model at an equal revision, give a bound
      over the wrong axiom set without a word. The JSDoc states the contract and the one internal
      caller (`boundsReport`) is correct. Record the model and options in a WeakMap keyed by the
      rows array, or keep the option internal. Done when a test passing mismatched rows gets a
      refusal or a recompute. [review 2026-10-14 C-F4]
- [ ] **Cache `READINGS` from the second read on (optional).** The readings cache (`READINGS`,
      `src/semantics/contracts.ts:663-691`) builds a JSON key and `structuredClone`s on every read,
      so v9 `obligationsOf` is 1.039× slower than at 3ab826a (paired range 1.008–1.070 over 7 pairs,
      about +2 ms) and `refineAll` 1.023×. Cache from the second read of a key on, or use a cheaper
      clone. Done when v9 `obligationsOf` is no slower than at 3ab826a, paired.
      [review 2026-10-14 C-F5]

## Docs, tutorials and what waits on others — review 2026-10-14

User guide and tutorials that are wrong, and what waits on something outside the code.

- [ ] **Re-record tutorials 1, 3, 4 and 5 and correct the caption that is false.** The workflow
      repo's tutorials were recorded on Sysprose 8581721; the site pins 5943654, where the hub-led
      layout (d60cd5d) and the column-header band (ea0d807) changed the views they show.
      `docs/tutorials/scenarios/3-oa.json:48` and `3-oa.vtt:16` say memberA's 14 activities are "on
      its left"; the live OA view draws all 14 to the right of the hub. Videos 1 and 4 also say
      "left to right" (`1-start-here.json:187`, `4-sa.json:36`) and video 1 "Fit shrinks them to
      specks" (`:108`). The same words stand in `3-oa.json:39` ("read left to right") and
      `5-la.json:39` ("left to right"), which the review did not flag: OA and LA are hub-led views
      too, so read them against the new stills and change them if they no longer hold. Videos 2, 6
      and 7 are unaffected. Fix `3-oa.json` cue 3 first, build at the pin and copy the v9 model
      into `dist/model`, record 1, 3, 4 and 5 with `scripts/record-tutorial.mjs`, review a contact
      sheet of every still (the header band, the hub-led OA, SA and LA, the `check` producer chip
      in video 5), run `make-page.py` and check the live site. Done when the four videos and their
      captions match the app at the pin. [review 2026-10-14 D-6] Awaits user decision U9
      (re-record at the pin bump after the behaviour fix, or once after H5).
- [ ] **Revisit `validation/constraint-by-instance` after one workflow run on a model with instance
      groups.** The rule (`src/validation/rules.ts:1096`, the 27th) is non-blocking, with a
      `CODE_NOTES` entry in the workflow repo (`src/spec/codes.ts:96`); that was judged without a
      run on a model that has instance groups, and the drone-swarm v9 has none (its `sysml-check`
      output holds 49 diagnostics, none `constraint-by-instance`). Done when one workflow run on a
      model with instance groups has shown whether the rule should block, and the note and the
      severity say so. Waits for such a model. [review 2026-10-14 E15]
- [ ] **Move to the z3 release that fixes the finalizer race.** The WASM finalizer race behind the
      intermittent z3 deaths (z3 issue #10999, fixed by PR #11001, merged upstream on 2026-10-02 as
      55eb9fa) is in no release: the npm `z3-solver` latest is still 5.2.0 (`package.json` `^5.2.0`;
      checked 2026-10-14). When it is released: bump it, adapt `src/semantics/smt/z3-bridge.ts` (the
      deferring registry, the `runExclusive` wrapper, `releaseHeldMutex`, the CLI exit), keep the
      dead-module discard and the serial calls, and soak it under load against an unfixed control
      (`npm run soak:z3`). Done when the bump is merged with the soak green and the control still
      showing the race. [review 2026-10-14 F-U1] Awaits user decision U15 (bump at once with the soak
      as the gate, or wait for independent confirmation: the upstream PR was never run on a real
      WASM build).
- [ ] **Switch Google Drive on for the model site and run its manual test.** The feature is built
      and published dormant: a deployment without a `drive.json` next to `index.html` shows no Drive
      control (`src/persistence/drive/config.ts`, `README.md`). It needs, from the maintainer, a
      Google Cloud project with the Drive and Picker APIs, the consent screen (External, Testing,
      two test users), the `drive.file` scope, a Web OAuth client whose origins are the site,
      `localhost:4173` and `localhost`, and a restricted API key (about 30 minutes); then, from the
      agent, the committed `site/drive.json` and the privacy page's client id in the workflow repo
      (its `docs/site.md` has the console checklist) and the 13-step manual test with its fix-ups
      (messages, CSP hosts, the resource-key header). Done when the manual test passes on the live
      site. [review 2026-10-14 F-C2] Awaits user decision U16 (do the Google setup when
      convenient).

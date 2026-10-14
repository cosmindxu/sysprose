# To do

Next actions: concrete, small, actionable. Big features belong in [`ROADMAP.md`](ROADMAP.md). Items
that need decisions after research belong in [`RESEARCH.md`](RESEARCH.md).

Entries tagged `[review 2026-10-14 …]` come from the read-only review of Sysprose 5943654 on that
date, and each id is the finding's own in the review's plan: `A-…` is from the per-instance
soundness review (A), `C1`, `C3`, `H1`, `H2`, `M1`, `M2`, `M3` and `L1` from the behaviour review
(B), `C-F…` from the speed review (C), `D-…` from the app and merges review (D), and `LH-`, `PI-`,
`EV-` and `CK-` from the decisions batch and per-instance reporting review (E). The `E<n>` ids and
`X2` are rows of the open-items inventory (F), not of reviewer E; its two further rows are written
`F-U1` and `F-C2` here, so that they do not read as a decision or as another reviewer's id. A model an entry writes
out as `package … { … }` is complete and loads as written; the review file an entry names
(`A/probes/…`, `E/pi/…`) is what it was copied from, in the review's artifact folder, which is not
in this repository. An entry that waits on the maintainer says `awaits user decision U<n>` and
names the question.

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
(`test/integration/verification.differential.test.ts`): six rows pinned `KNOWN_FALSE`, eleven
`I7_ALLOWED` entries, and the abstentions the entries below name. The false verdicts the review of
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
      F/F/F/F, `q1::tie` T/-/T/-, and `P::c`, `in Q::p`, `in q2::p` T/T/T/T; the five refute-r1
      `I7_ALLOWED` entries (`verification.differential.test.ts:5064-5068`) are deleted; a 70-long
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
      `src/text/langium/map-to-model.ts:447-483`, handed the declaring feature by the head-name loop
      at `:610-624`), so every surface reads the general value or none and P's default stands
      (m2NegT reads F/F/F/F where it is T). Fix: make the copy redefine the most specific inherited
      feature (compare `findTypeFeature`, `:430`, which does this for the segments of a chain), or
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

From the soundness review of F3–F8 and 3e3b0ff (Sysprose 5943654 against 7277a97). The four surfaces
now agree on false verdicts that 7277a97 abstained on, so no cross-check catches them, and neither
the out-of-tree corpus gate, the M-generator nor the in-repo table sees them. Fail closed first,
then read.

- [ ] **Read each instance of a group in the element that denotes it, and abstain where that cannot
      be done.** `groupInstanceRows` (`src/semantics/evaluate-model.ts:1473`, `:1502`) and
      `groupGoalRows` (`src/semantics/obligations.ts:1049`) read every instance through the shared
      usage's generic features (`ownerId: usage.id`), so an instance's own redefinition, specialised
      type or nested override is ignored. Probe (A2, the review's
      `A/probes/a2-redef-in-instance-noL.sysml`): `package A2 { part def P { attribute load default
      = 1.0; attribute extra default = 0.0; constraint c { load + extra <= 10.0 } } part def Q {
      attribute L default = 1.0; part p : P; bind p.load = L; } part q1 : Q { attribute :>> L = 2.0;
      } part q2 : Q { part :>> p { attribute :>> extra = 20.0; } } }`. The second usage, `q1`, is
      what makes `p` a group of instances (without it `q2::p` is the only one, no group row exists
      and `verify` refutes `P::c in A2::q2::p` once, correctly). With it, `P::c in A2::q2::p` reads T
      on all four surfaces where it is F (1 + 20 > 10); `verify` prints that row twice, discharged
      and refuted, and `sysml-check` prints "holds in 3" (re-run at 5943654). The same for a
      specialised type (`part def Q2 :> Q { part :>> p : P2 }`, P2 `extra = 20`), a nested
      `r2.q.p` and a usage-owned relation. The guard meant to stop this, `'not-enumerated'`, is
      declared (`defining-equation.ts:2936`) and counted
      (`evaluate-model.ts:1133`) but never produced [A-H3]. Fix, in two steps: first abstain
      (`not-enumerated`) whenever any name the relation reads resolves at instance I to a different
      feature or source than at the shared usage, which restores 7277a97's `?`; then read each
      instance in the most specific element that denotes it, with every SMT symbol I's own. Done
      when the shapes above are pinned in the four-surface table and the M-generator, read their
      true value, and no row reads both proved and refuted. [review 2026-10-14 A-C1, A-H3]
- [ ] **Hold the redefined feature's default at an instance wherever a held implicit end copy
      redefines it.** `holdDefault` (`src/semantics/defining-equation.ts:2665-2684`) adds the
      instance to `heldIn` only when the end copy itself writes a default (`:2683`), so a held copy
      with no default leaves the redefined feature's default standing at the instance and SMT's
      axiom for it contradicts the binding: soundness decision 10 (a binding overrides a default in
      its context, on every surface) is broken. Probe (A4, the review's
      `A/probes/a4-second-binding.sysml`): the A2 model, `q1` included, with `q2` replaced by `part
      q2 : Q { attribute E = 20.0; bind p.extra = E; }` in package `A4`: `P::c in A4::q2::p` reads
      T/T/T/X where it is F (1 + 20 > 10), and the own row `A4::P::c` went from T×4 to T/T/T/X, a
      new I7 case (re-run at 5943654: `verify --engine literal` discharges all four rows and
      `--engine smt` answers `inconsistent-axioms` on all four). Fix: hold the default at the
      instance whenever an implicit end copy is held, even if it writes none (a valueless copy that
      redefines a feature an asserted equation defines, GA6's `p.load`, must keep reading the
      assert), and stop the instance value row asserting a default a binding overrides there. Done
      when A4 reads F/F/F/F on the group row and T×4 on the own row. [review 2026-10-14 A-C2]
- [ ] **Treat a capped binding's whole connector component as past the cap.** `boundSourceIn`
      (`src/semantics/defining-equation.ts:3165`; its cap test `:3205`), `defaultStandsIn` (`:3311`)
      and `holdEnds` (`:2475`; caps recorded `:2553`, `:2559`) treat only the capped pair as
      past-cap, so a capped binding's value that reaches a feature through a second, uncapped
      binding is read as that feature's default. Present at 7277a97 as well. Probe (CAP1, the
      review's `A/probes/cap1-per-binding.sysml`), a generated chain in `package CAP`: `part def T0 {
      attribute load : ScalarValues::Real default = 1.0; attribute m2 : ScalarValues::Real = 10.0 -
      load; }`, `part def T1 { attribute L : ScalarValues::Real default = 1.0; part a : T0; bind
      a.load = L; }`, `part def Tn { part a : T(n-1); }` for n = 2 to 33, `part top : T33;`, then
      `attribute X : ScalarValues::Real = 50.0; bind top.a.….L = X;` (32 times `.a`, so the binding
      is written 33 usages deep) and `attribute Y : ScalarValues::Real default = 1.0; bind Y =
      top.a.….load;` (33 times `.a`) with `constraint yT { Y >= 40.0 }` and `constraint yF { Y <=
      5.0 }`. Y is 50 through the capped binding, but `yT` reads F/F/F/X where it is T, and `yF`
      reads T/T/T/X where it is F (re-run at 5943654). Fix: past-cap reaches the whole global connector component, also through
      `redefinedClosure`: `holdEnds` holds every default in it, and `boundSourceIn`,
      `defaultStandsIn` and `boundPartnerSafe` abstain. Done when CAP1 is pinned beside `r4cap` and
      the P4 probe and abstains on all four surfaces. [review 2026-10-14 A-C3]
- [ ] **Pass instance I's frames, not the usage's, to `enclosingAssertOn`.** `answerFor`
      (`src/semantics/evaluate-model.ts:316-318`) asks `enclosingAssertOn` with
      `denote(contextId).enclosing`, the shared usage's frames. Probe: R1 (q1 asserts
      `p.x == 50.0`): `P::c in R1::q1::p` reads T/T/T/X while the own row `top1`, the same quantity
      at the same instance, abstains with `enclosing-assert`; if the assert wins the value is F (3 +
      50 > 10). The I7 allowlist was widened to accept it
      (`verification.differential.test.ts:5067`). Fix: give group rows I's enclosing frames and
      delete that allowlist entry. Done when the entry is gone and the row abstains or reads F
      consistently with `top1`. [review 2026-10-14 A-H1] Overlaps the H5 entry.
- [ ] **Index the per-instance machinery so the check meets its performance targets.**
      `instanceGroups` (`src/semantics/defining-equation.ts:3400`) and `instancesOfDefinition`
      (`:3359`) are uncached (the plan's `INSTANCE_GROUPS` per (model, rev) does not exist),
      `boundSourceIn` (`:3165`) scans every reading per symbol, and `componentConnectors` (`:3092`)
      walks `model.all()` per call. Measured at 5943654: paired in-process against 7277a97,
      big-bind-600 (the `big-bind-N` builder of `test/unit/semantics.solver.test.ts:182`) went 721 →
      35,934 ms (target 700), tree10 41 → 22,008 ms, perf9b 34 → 5,251 ms (target 300),
      big-bind-1200 takes 90.9 s (target 1 s); the CLI `sysml-check` takes 13.2 s on big-bind-600
      and 6.5 s on perf9b; perf9b's Problems tab holds 1,568 Solve rows (cap 200). The app runs this
      check on every edit. Fix: cache `instanceGroups` per (model, rev), build the package-denote
      index once, index readings by instance prefix for `boundSourceIn`, and memoise `classified`
      and the connectors per (root, component). Done when, measured paired on an idle machine,
      big-bind-600 ≤ 700 ms, big-bind-1200 ≤ 1 s, tree10 ≤ 2× main, perf9b ≤ 300 ms and perf9b's
      Solve rows ≤ 200 (the per-instance plan's targets, which F3–F9 never re-measured).
      [review 2026-10-14 A-H2, E14]
- [ ] **Add the tests the per-instance steps skipped.** The per-instance plan lists eighteen
      planted bugs (P1 to P18), each a one-line breakage that some test must turn red. Runs of
      2026-10-14 found these green: P17 (the containment try/catch removed) leaves the
      evaluate-model, solver and rules suites green, because no throwing-stub test exists; there is
      no containment test (a throwing read becomes one abstention row) for `groupInstanceRows` or
      `enclosingAssertOn`; P6 (units `instances` on by default, planted at `units-eval.ts:2618` as
      `!== false`) leaves the differential's per-instance block green, since D1 `gBindF`'s numeric
      `?` is a tolerance tie, not this guard; P9 (the SMT value gate disabled, a forged point) is
      caught only by two I3 pins, with no forged-check SMT test; the out-of-tree corpus gate has no
      expect files past F2, so movement is reported, never pinned. Four were not run: P5 (literals
      counted in `readsOtherwise`; the M-generator's literal members must go red), P7 (an aggregate
      verdict on the generic row; h2p's literal row must stop reading `refuted (1 vs 10)`), P10
      (group instance rows by verdict; the S1 counts must go red) and P14 (the coverage guard
      skipped; a generated frame-cap group must keep its generic row refused with
      `decided=false`), which cannot be planted until `not-enumerated` exists. Add the `vi.mock`
      throwing stub, the two containment tests, a probe sensitive to P6, the forged-point SMT test
      and the expect files, and run P5, P7, P10 and P14. Done when every planted bug turns a test
      red. [review 2026-10-14 A-H4]
- [ ] **Compare the SMT same-point gate in SI.** The gate (`src/semantics/engines/smt.ts:1785-1812`)
      compares the witness in its own unit with the check's SI value (`read.exact`), so IU1 `rF` (in
      the out-of-tree corpus; the `IU1` model of `verification.differential.test.ts:5246` has `rT`
      only, `r.total` = 4 GiB) fails with "not the model's point (4/1 vs 34359738368/1)" and SMT
      goes F → ?: a weakening the corpus gate never named. Compare in SI. Done when IU1 `rF` reads F
      on SMT again. [review 2026-10-14 A-M1]
- [ ] **Print the value beside a decided group verdict.** Witnesses carry no value next to a decided
      verdict: the A2 group rows print `load=null`, A9 the same, and A7 `top` prints
      `q2.p.extra=null` (`modelBindings`, `src/semantics/engines/literal.ts:460`; `collectReads`,
      `evaluate-model.ts:1832`), though the F2 addendum required them. Fill them from `check.reads`.
      Done when A2, A9 and A7 print their values. [review 2026-10-14 A-M2]
- [ ] **Key the per-instance memo on the instance and the position.** The memo key at
      `src/semantics/evaluate-model.ts:673` drops `at` when `inst` is set. No collision was found,
      so it is latent. Key on (id, inst, at). Done when a test reads two names that differ only in
      `at` under one `inst`. [review 2026-10-14 A-L2]

## Per-instance reporting and evidence — review 2026-10-14

From the review of the decisions batch and the per-instance reporting (Sysprose 5943654 against
7277a97). `validation/constraint-by-instance` is the finding an instance group's violated reading
becomes; the evidence entries are the `sysprose-evidence/2` facet (05e45a4).

- [ ] **Report a decided violation in a single-instance group.** `instanceRollup`
      (`src/semantics/evaluate-model.ts:1152`) emits findings only when `group.length >= 2`
      (`:1168`), so a relation owned by a usage and read in one instance drops its violation. Probe
      (r17, the review's `E/pi/r17.sysml`): `package R17 { part def P { attribute load default =
      1.0; } part def Q { attribute L default = 1.0; part p : P { constraint c2 { load <= 10.0 } }
      bind p.load = L; } part q1 : Q { attribute :>> L = 50.0; } }`: `sysml-check --strict` prints
      `OK — 0 error(s), 0 warning(s), 0 info(s)` and exits 0 while `verify --engine literal` refutes
      `R17::Q::p::c2 in R17::q1::p` (load 50 > 10) and exits 1 (re-run at 5943654; 7277a97 at least
      printed an info). mbse-workflow can never block on it. Fix: count the own row in the group, or
      emit the violated-instance finding whatever the group size. Done when that probe exits 1 under
      `sysml-check --strict` and is pinned, and a standing check ≡ verify sweep over the
      four-surface table finds no row that `verify` refutes while `sysml-check` is silent.
      [review 2026-10-14 PI-1]
- [ ] **Anchor a violated-instance finding at the line that differs.**
      `SpecialisationInstance.anchorId` (`src/semantics/evaluate-model.ts:954`) is read by
      `anchorFor` (`:1102`), which the Solve row calls (`src/semantics/solver.ts:4780`), but nothing
      in `src/` assigns it, so a finding points at the shared usage's feature instead of the
      instance's differing redefinition, while the hint says "the line the finding points at". Probe
      (m1, the review's `E/pi/m1.sysml`): `package H { part def P { attribute load default = 1.0;
      constraint c { load <= 10.0 } } part def Q { attribute L default = 1.0; part p : P; bind
      p.load = L; } }` and eight usages `part qN : Q { attribute :>> L = 50.0; }` (N = 1 to 8): all
      the violated-instance findings sit at `part p : P` in `Q` (`3:64` when the package, `P` and
      `Q` each take a line), none at a `:>> L` (re-run at 5943654). Fix: set `anchorId` to the differing redefinition or stated
      member when the group row is built. Done when m1's findings anchor at each usage's `:>> L`
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
      `src/ui/panels/BottomPanel.tsx:626-633` labels the Problems tab `Problems (N check · M solve)`
      when both producers filed rows, but Check and Solve each replace `diagnostics` wholesale
      (`src/ui/store.ts:3095`, `:3183`) and validation rows carry no `producer`, so the label can
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
The Reachability row says `holds` only over a text the terminal also accepts, so the first entry is
the one that can show a false pass.

- [ ] **Never let the load health vouch for a text that does not load.** `loadHealth`
      (`src/ui/store.ts:4231`) trusts a serializer-side signal (`serializeUserModelSignals`,
      `src/text/health.ts:163`) and skips the parse of a text it calls reference-faithful
      (`textHealthOf`, `store.ts:4214`). The signal's `parseErrorsOf` (`health.ts:87-103`) checks
      only references and the `value` text, so a typo in a guard, trigger, effect, expression or
      metadata, a non-string value, a raw newline in a quoted value and a name or unit holding a
      newline all read as 0 errors; `valueTextParses` (`health.ts:106-120`) accepts a value such as
      `2; attribute rate = 3` that parses alone while the whole text gets two validation errors; and
      a user-referenced package flagged `isLibrary` is vouched for [LH-1, LH-3]. `rememberText`
      (`store.ts:955-961`) also lets the signal's count overwrite a parsed one, so a faulty line
      applied in the Text view goes from 1 error to 0 and a fallback parse is undone by the next
      `loadHealth()` (5/4 becomes 1/0); Drive and file opens take the same path [LH-2]. Probe: on
      `state a; state b; state final; transition t1 first a then b; transition t2 first b then
      final;` set the effect of `t1` to `}` in Properties: health reports 0 errors and Reachability
      reads `holds`, while the saved text makes `reach` exit 1. Fix, either way recording whether a
      memo entry came from a parse or from the signal and never letting a signal replace a parse:
      (a) always parse: parse each distinct text once, memoised by text, in the checks worker so
      the page does not stall, and let the signal skip validation only; or (b) keep the parse-free
      certificate and make it re-read every verbatim field in its grammatical slot, refuse a name
      or unit holding a newline, count non-string values and require exactly one `__value`
      element. Done when a differential test over the corpus plus a mutation fuzz of every verbatim
      field shows that whenever the app's health says 0, `parse(text)` plus validation says 0, and
      Reachability never says `holds` over a text the CLI rejects.
      [review 2026-10-14 LH-1, LH-2, LH-3] Awaits user decision U3 ((a) parse every distinct text,
      in the worker, or (b) keep the parse-free certificate and make it cover every verbatim field).
- [ ] **Correct what is said about the load-health signal and the `checks/degraded` row.** The
      679a5e5 message says the signal "can only make loadHealth parse more, never less", and the
      workflow repo's session handoff repeats it; `health.ts:79-86` documents `parseErrorsOf` as the
      parse errors of the emitted text, and neither holds for the fields listed above [LH-4]. The
      catalogue `when` of `checks/degraded` (`src/text/langium/diagnostic-codes.ts:935`) says the
      Save text does not parse or the loaded and exported texts differ; the code fires on any
      `health.errors`, validation errors and a thrown validation included (a file with two duplicate
      names and no syntax error exits 1 "degraded (2 error(s))"), and a thrown validation says "0
      syntax error(s)" [CK-1]. Reword both, give `validateThrew` its own message and regenerate with
      `npm run codes`. Done when the texts match what the code does. Ships with the load-health
      entry above. [review 2026-10-14 LH-4, CK-1]
- [ ] **Emit containment in pre-order wherever a model is serialised.** `Model.reparent` appends the
      child to its new owner (`src/core/model.ts:430-432`) while `rebuildIndex` (`:519-534`) groups
      children by insertion order, so `toJSON` and `toJSONWhere` (`:562-571`) emit them out of
      containment order. The checks worker's `userPart` (`src/ui/checks-offthread.ts:91-101`), Save
      in this browser (`store.ts:3418`) and every Undo snapshot (`store.ts:1822`, `:3814`, `:3837`)
      rebuild a model whose children are reordered, and an initial-less composite state takes its
      first child as its initial one (`initialState`, `src/semantics/mc/config.ts:563-566` at
      5943654). Probe: a machine with `initial start`, a composite `Work { Prep; Run }` with no
      `initial`, and the property `absence globally "state Spare"`; drag the older state `Spare`
      into `Work` in the Explorer: the page's check-behaviour reads `holds` (1 pass) and the
      worker's `issues` (1 fail), `reach` gives 3 configurations and 2 findings on the page against
      2 and 4 in the worker, and Save then reopen, or any Undo, rewrites the Text view from
      `state B; state C; state A;` to `state A; state B; state C;`. Fix: emit user elements in containment pre-order (a DFS over the
      children from the user roots) in `toJSON`, `toJSONWhere` and `userPart`. Done when tests show
      that after a reparent the worker matches the page (verdict, configurations, findings), Save
      then reopen keeps the order and an initial-less composite's initial state, and Undo after a
      reparent restores the text byte for byte. [review 2026-10-14 D-1, D-2]
- [ ] **Keep `loadHealth` off the page thread at a palette check click.** `onRun`
      (`src/ui/panels/Palette.tsx:377-383`) calls `loadHealth()` on the page's thread at the click,
      before `runChecked` begins the run, so there is no "running…" feedback during it. On the
      drone-swarm v9 model after an edit it costs about 3.2 s (serialize 280–390 ms, parse 1.5 s,
      library merge 390 ms, validate 670 ms, live validate 340 ms in node); the cheap path of
      679a5e5 never applies to v9, because `displayTypesFaithful` (`src/text/health.ts:147`) refuses
      its 76 `@SysproseVerification::PropertyPattern` usages (that vocabulary package is not in the
      model), which is every model `check-behaviour` has properties for. Fix, by the answer to the
      load-health entry's decision: under (a), take the health work off the click path; under (b),
      accept the built-in vocabularies in `displayTypesFaithful`; either way call `begin()` before
      `loadHealth()`. Done when an E2E guard on v9 shows no long task over 200 ms on the page thread
      after an edit and a palette check click. [review 2026-10-14 D-3] Awaits user decision U3 (the
      load-health entry above). Measured in node, not in a browser.

## Behaviour checks and the palette's checks lane — review 2026-10-14

From the reviews of the behaviour lane (reach and check-behaviour in the palette) and of the ux
merge. The first four entries are the walk's and the interpreter's own: the branch
`behaviour-sound` is closing the first three, and the fourth if the maintainer agrees (U1); its
merge removes what it closes.

- [ ] **Model the interpreter's 64-step completion budget in the walk and the search.**
      `runStateMachine` (`src/semantics/execute.ts`) follows an event with trigger-less
      (completion) steps for at most 64; a chase that spends the budget stops where it is and the
      next event is taken from there (`completionBudgetHit`). Since `0c9d2bd` the walk offers no
      event at a configuration where a completion transition is enabled
      (`src/semantics/mc/explore.ts:1103-1105`) and the property search does the same
      (`patterns.ts:1161-1163`), and the chase counter is set when a configuration is first found
      (`explore.ts:1179`, `:1192`), so a revisit never trips it. On a cycle of completions, or a
      chain longer than the budget, the walk misses runs the interpreter takes: `unreachable`,
      `dead`, a safety PASS and `not-covered` can be false, and the comment at `explore.ts:941`
      ("a completion cycle is not a bound hit") argues the wrong way [C1]. Separately, the search
      tests the monitor for a violation (`patterns.ts:1201`) before it applies the chase-budget gate
      (`:1218`), so a `cover` prints COVERED, with a witness, for a state the interpreter never
      enters [H2].
      Probes, each re-run at 5943654. (1) `package LiveTwo { state def M { state s0; state a;
      state b; state c; transition go first s0 accept go then a; transition ab first a then b;
      transition ba first b then a; transition ac first a accept e then c; } }`: `reach` exits 0
      with `unreachable LiveTwo::M::c` and `dead ac (a -> c) on e`, and `check-behaviour --element
      LiveTwo::M --pattern 'pattern=absence, scope=globally, p=state c'` prints PASS, while the
      interpreter on `[go, e]` ends in `c` (`completionBudgetHit`). (2) A generated chain: states
      `s0`, `c1`…`c70` and `z`, `go first s0 accept go then c1`, `t<n> first c<n> then c<n+1>` for
      n = 1…69, `jump first s0 accept jump then c30` (it reaches `c30` with the counter at 0, so the
      walk's counter never passes 64) and `esc first c65 accept e then z`: `check-behaviour
      --pattern 'pattern=absence, scope=globally, p=state z'` prints PASS and exits 0, `reach` says
      `unreachable z`, and the interpreter on `[go, e]` ends in `z`. (3) The same chain without
      `z`, `jump` and `esc`: `--pattern 'pattern=cover, scope=globally, p=state c66'` prints
      COVERED with a 66-step witness and exits 0, while the interpreter ends at `c65` on `go`
      followed by anything. (4) The drone-swarm v9 `PA::SwarmMember::SwarmMemberModes`: `reach`
      reports `dead admissionFails (Nominal -> Quarantined) on peerVerdict`, and the interpreter on
      `[peerVerdict]` fires it and ends in `Quarantined`. That verdict is on the published site
      (it pins 5943654) and in the v9 audit's `reach.json`.
      Fix: a configuration reached by completion steps carries its chase position, `0` to the
      budget, in the visited key; where the budget is spent with a completion still enabled the
      interpreter stops, so the walk offers the alphabet there, as `runStateMachine` takes the next
      event, and firing an event restarts the position at 0. That replaces the cut on
      `run > maxCompletion`, since the budget is part of the semantics and not a bound. In
      `patterns.ts` the monitor's violation test moves behind the chase-budget gate. Whichever way,
      every published witness replays through `runStateMachine` to the same state sequence, or the
      row is withheld as inconclusive with its own code. If the exact model grows the state count
      past the existing `maxConfigs` defaults on the corpus, offering the alphabet at every
      configuration of a completion cycle is the over-approximation to fall back on (absences stay
      sound; every existential answer must then replay): awaits user decision U2. Done when the
      four probes read as the interpreter does (`c` reachable and `ac` fired; `z` reachable,
      `esc` live and the absence of `z` FAIL with a witness that replays; `c66` not covered and
      exit not 0; `admissionFails` fired), a unit test drives the interpreter over the test corpus
      and the examples to depth 3 with a run cap and finds it never does what `reach` or
      `check-behaviour` calls impossible, and a sweep replays every corpus witness.
      [review 2026-10-14 C1, H2]
- [ ] **Say what a nested `state def` means, and make the checks and the simulator agree.**
      Since `0475db6` a nested `state def` is a machine of its own (`explore.ts:1789`) and
      `regionTransitions` stops at it (`src/semantics/mc/config.ts:373`, `:400`), a step relation
      the simulator shares. (1) A transition that crosses a nested definition's border has no
      defined meaning, and `reach` decides it anyway and contradicts itself [H1]:
      `package Nest2 { state def Outer { state a; state b; transition ax first a accept e then
      Inner::x; state def Inner { state x; state y; transition xy first x accept go then y;
      transition yb first y accept back then Outer::b; } } }` prints `unreachable Nest2::Outer::b`
      beside `verification/deadlock` for `Nest2::Outer::b`, and for `Nest2::Outer::Inner::x`, which
      has `xy`; the interpreter on `[e, go, back]` stops at `x`. (2) `behaviourMachineFor`
      (`src/semantics/mc/report-lines.ts:466`) refuses a scope that holds more than one machine, and
      an `Outer` that holds a nested definition now holds two [C3]: on `package Nest6 { state def
      Outer { state a; state b; transition ab first a accept e then b; state def Inner { state x;
      state y; transition xy first x accept go then y; } } }`, `check-behaviour --element
      Nest6::Outer --pattern 'pattern=absence, scope=globally, p=state b'` says "`Nest6::Outer`
      holds 2 state machines" and exits 2, however `Outer` is named, so `Outer` can never be
      checked; the review saw the app's pick row refuse `Outer` again when clicked. (3) `runRegion`
      (`src/semantics/execute.ts:983`) reads `model.descendants`, not `regionDescendants`, so when
      the nested definition is declared first (`package Nest3 { state def Outer { state def Inner {
      state x; state y; transition xy first x accept go then y; } state a; state b; transition ab
      first a accept e then b; } }`) the interpreter on `[e]` is in `Inner::x`, never in `a` or
      `b`, and the witness stepper replays against that simulator [M3]. Fix: `behaviourMachineFor`
      returns the scope when it is itself a machine root; a transition that crosses a nested
      definition's border is reported as `verification/behaviour-unsupported-construct` and the
      machine is withheld (which also ends the contradiction in (1)), with its relation to the
      simulator stated in `docs/06-model-checking-implementation-plan.md`; `runRegion` reads
      `regionDescendants`. Done when `Nest2` prints no `unreachable` or `deadlock` over the crossing,
      the `Nest6` command checks `Outer`, the interpreter on `Nest3` starts in `a`, and the app's
      pick row for `Outer` runs (an E2E on the behaviour palette spec). [review 2026-10-14 H1, C3, M3]
- [ ] **Reword the method text that still says the walk offers every trigger at every
      configuration.** Since `0c9d2bd` the walk and the search offer no event where a completion is
      due, so these are false: the `reach` line "this machine names triggers this walk offers at
      every configuration" printed on every machine that names triggers
      (`src/semantics/mc/explore.ts:1431`), the witness warrant "the environment offered every
      trigger this machine names at every configuration" (`publishable.ts:316`, `:354`, and the
      dwell sentence at `:383`), `patterns.ts:1969`, the header comment at `explore.ts:39-42` (the
      walk "OVER-approximates"), and the "cooperative environment" item 2 of
      `docs/06-model-checking-implementation-plan.md`. Say "at every configuration where no
      trigger-less transition is due", in the words of the completion-budget entry's fix, which
      changes the semantics again. Probe: `npm run sysprose -- reach` on any machine that names a
      trigger prints the stale line. Done when no printed text, comment or document sentence about
      what the environment offers disagrees with what the walk does. Ships with the
      completion-budget entry above. [review 2026-10-14 M1]
- [ ] **Say when a cycle of trigger-less transitions never comes to rest.** Under run-to-completion
      such a cycle spends the interpreter's 64 chase steps on every event, and `reach` is silent:
      `package Loop { state def M { state a; state b; transition ab first a then b; transition ba
      first b then a; } }` exits 0 with "0 dead". The review counts 10 of the drone-swarm v9's 17
      machines that hit the budget on every run (LA: FleetConfiguration, SwarmMember Modes and
      States, GroundStation Modes and States; PA: FleetConfiguration, SwarmMember Modes and States,
      GroundStationNode Modes and States), where an author probably meant a trigger. Report a
      reachable cycle of trigger-less transitions as `verification/completion-livelock` (a
      warning) naming the cycle, with a catalogue entry and `npm run codes`; on v9 it adds 10
      findings. Done when `Loop` and the ten v9 machines print it. [review 2026-10-14 C1]
      Awaits user decision U1: whether `reach` reports it, and, apart from that,
      whether v9's mode and state machines get triggers through the workflow.

- [ ] **Give "no trigger is ever offered" its own code and sentence.** When every state of a machine
      has a completion, the property search finds no configuration that offers an event, and
      `src/semantics/mc/patterns.ts:1590-1602` (at 5943654) reports `verification/bound-exhausted`
      with "Raise the bound (`--max-configs N`) and re-run" although no bound was hit; raising it
      changes nothing, so an agent that branches on the code loops. Probe: v9
      `PA::SwarmMember::SwarmMemberStates` (every state has a completion): its two true PASS rows
      (the interpreter agrees: `Recalled -> Landed` is a completion) read INCONCLUSIVE with that
      advice. Fix: a code and sentence of its own for the case where only the "alphabet not offered"
      clause failed, without the raise-the-bound advice (a catalogue entry and `npm run codes`).
      Done when the non-bound case prints its own code with no `--max-configs` advice and v9's two
      rows read PASS again. [review 2026-10-14 M2]
- [ ] **Correct the checks lane's comments that the code contradicts.** `src/ui/checks.ts:26-36`
      says "Not yet the same: `check-behaviour` here checks the selected machine or else the model's
      first"; that has been false since 2add5b3 (`pickBehaviourMachine`,
      `src/ui/behaviour-checks.ts:194`, calls the CLI's own `behaviourMachineFor`), while its remark
      about `reach` stays true [D-8]. `src/ui/checks-offthread.ts:88-90` says "The send is the
      snapshot", but for a queued job `userPart(ctx.model)` runs when the job starts
      (`src/ui/panels/checks-runner.ts:196`), not at the click: an edit made after the click is
      carried with the click-time health. `rev` protects it (the result lands at rev 5 and reads
      `stale` at rev 6), so only the comment is wrong; take the snapshot in `runChecked` at the
      click or fix the comment [L1]. Done when both comments say what the code does.
      [review 2026-10-14 D-8, L1]
- [ ] **Keep the witness stepper's Close reachable while a check runs.** A running check hides the
      Checks tab's previous result (`src/ui/panels/BottomPanel.tsx:91-93`), and with it the witness
      stepper's Prev, Next and Close (`src/ui/panels/BehaviourReport.tsx:194`, the only Close),
      while the canvas keeps painting the open witness (`src/ui/panels/DiagramCanvas.tsx:166-172`)
      until the new result lands, up to the 60 s watchdog. Keep the stepper row, or close the
      witness on `begin`. Done when a test shows the witness can be closed while a check runs.
      [review 2026-10-14 D-9]
- [ ] **Make the worker's library identity depend on the library's content.** `libraryKey`
      (`src/ui/checks-offthread.ts:110-122`) is the library element count plus a hash of the root
      ids, so a page library of the same shape and different content (the Properties name field can
      rename a library element; a same-shape bundle from another build) counts as the same and the
      worker answers over its pristine copy [D-10]. And only `libraryMismatch` is remembered
      (`src/ui/panels/checks-runner.ts:157-165`): a worker whose library fetch fails (offline,
      `stdlib.json` not cached) is restarted on every Run, then falls back to the page [D-11].
      Include a content hash or a build id in the key, and remember load failures for the session.
      Done when a test renames a library element and the worker declines, and a failed library load
      starts no second worker. [review 2026-10-14 D-10, D-11]
- [ ] **Stroke the SVG export's column-header band as the screen does.** The export
      (`src/diagram/svg-export.ts`) strokes all four sides of the band where the screen draws only a
      bottom rule. Cosmetic. Done when the export's band matches the screen's.
      [review 2026-10-14 D-12]

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

- [ ] **Pin the user guide's `src/ui/store.ts` citations to symbols.** Twenty-four `store.ts` line
      ranges in `docs/USER-GUIDE.md` (lines 456-458, 582-585, 2945, 3289-3291, 3541-3542) point at
      the wrong code at 5943654: the diagram scope cited as `311-324` is `318-331`; d476d66
      re-pointed line 2945 by +48 where +279 is right (the four buttons run from `runValidation` at
      3002 to the end of `solveParametric` at 3184, an SDK edit is 1914-1994).
      `test/unit/user-guide.test.ts` checks that a cited range exists, not what is in it, so every
      edit to `store.ts` stales them again. Re-point the 24 and add a test that fails when a cited
      `store.ts` range no longer contains the symbol the sentence names. Done when the test is green
      and fails on a shifted range. [review 2026-10-14 D-4]
- [ ] **Re-point the guide's `analytics.ts` citation for `feasible`.** `docs/USER-GUIDE.md:2947`
      cites `src/api/analytics.ts:1215-1290` for `feasible`; that range now holds `orphanReport`
      (`:1233`) and the start of the `PortOccurrence` and `ConnectivityReport` types (`:1278`,
      `:1286`), and `feasible` is at `analytics.ts:2408` (the `AnalysisReport` field) and `:2473`
      (where it is computed). Re-point the range. The previous entry's test is for `store.ts` ranges
      only, so this citation needs a pin of its own, or that test widened to every cited `src/`
      range that names a symbol. Done when the cited range holds `feasible`.
      [review 2026-10-14 D-13]
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

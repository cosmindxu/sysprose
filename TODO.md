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
- [ ] **Ask before the tab closes over a hand arrangement not saved.** `browserDirty` now counts boxes
      moved by hand (`savedPins`), so New, Open, Import, a branch switch and a Drive open ask first;
      `beforeunload` still asks only for a Drive-attached file, so closing the tab lets an arrangement
      (and a typed-but-unsaved edit of a model with no Drive file) go without a question. Done when
      closing the tab over unsaved text or boxes asks, with a test, or the maintainer decides it
      should not.
- [ ] **Give the focus somewhere safe when a rename closes on `Escape`.** `Enter` now leaves the
      focus on Save (`commitAndFocusSave`); `Escape` in the Explorer's rename (`tree-rename`), the
      context menu's (`node-ctx-rename-input`) or a Requirements table cell (`req-cell-input`,
      `req-attr-input`) closes the box without committing and the focus still falls to the page, so
      the next `Backspace` deletes the selection. Do the same refocus without the commit, or return
      it to the row, guarded. Done when `Escape` in each box leaves a following `Backspace` harmless,
      with a test beside the `Enter` one.
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

## Per-instance readings — follow-ups and known-false rows

Opened by the per-instance readings feature (ROADMAP item removed at step F9). What follows is what
its four surfaces (the check, the literal engine, the numeric surface and the SMT engine) still
abstain on or read false in the four-surface table
(`test/integration/verification.differential.test.ts`). The branch `h5` (merged by `755352c`) made
an asserted equation override a `default` on every surface, read definition-feature and part-valued
bindings, deleted the eleven `I7_ALLOWED` entries of the old clash, and pinned what it left open:
`KNOWN_FALSE` and `I7_ALLOWED` entries tagged `no step yet` are the residuals below. The false
verdicts the review of 2026-10-14 found in the per-instance code itself follow under their own
headings.

- [ ] **Read an enclosing equation through a binding or a reference.** Five shapes of the H5 rule fail
      closed to the reading before it, or still read false, and are pinned (`KNOWN_FALSE`, "no step
      yet"): (1) RB3 and SF: an enclosing assert over a default that a binding carries is not read
      through the binding's end (RB3: q's `L default = 4.0` bound to `q.p.x`, the package asserts
      `q.p.x == 3.0`; `top` and `top2` read F/F/F/X where they are T); (2) RF and RF2: an assert
      through a reference, or through a part redefined with a value, reads as before the rule
      (`top` T/T/T/X where decision 14 gives F); (3) LE: `P::c`, `P::c in Q::p` and `top` read T
      beside SMT's X on a self-contradictory model; (4) PIN2: an equation whose other side is valued
      only in usages (`assert L == M`, M valued in a usage) reads T where `p.L` is 7; (5) H5B: an
      assert in an instance's own element over an inherited default still abstains as
      `not-enumerated`. Done when each pinned row reads its true value on all four surfaces or
      abstains with its own sentence, and the `no step yet` entries are gone. [O5 S2, review]
- [ ] **Finish the part-valued and attribute-valued bindings.** The part-valued binding
      (`bind pp = top.a`) is read, but: `ppval` (`part pp : T0 = top.a`, a value on a composite
      part) reads F/T on all four surfaces; `v8ref` (`ref part pp : T0 = top.a` in a definition) is
      resolved in the definition, not the instance; `r8attr` (`bind q = top.pos` between structured
      attributes) reads `qT` F and `qF` T; a ref, subject or satisfy that lands on an equated part
      makes the binding unread, so rows abstain where following it would decide; and `bounds
      --measure pp.load` (`boundsReport`, `src/api/verification.ts`) prints a decided bound through
      an unread part binding (3 `exactly`, the truth is 50). The refusal sentence says "a defect in
      the relation" and `verify` exits 2 on what is a tool limit: give it its own reason. All pinned
      in `KNOWN_FALSE`. [O5 S4, review]
- [ ] **Close the rows F's section 2.8 listed and the abstentions it did not.** GA7 `pl` reads
      F/F/?/F (the numeric `?` comes from `derivedElsewhere` / `derivedValueBehind` reading P's
      derived default behind the end copy; target F/F/F/F); GA6 `qa` reads T/-/?/- (target
      T/-/T/-); GA6 `pa` and GA12 `pa`/`qa` moved from a numeric T to `?` and gained or lost rows
      (invariant (h) against F's section 2.8: needs the maintainer's ruling); a package-level
      definition-feature bind files no per-instance `#bind` row on the check and the numeric
      surface, so `sysml-check` abstains where SMT decides (`W4o::c4`); under a fixed slot the
      check and literal engine abstain where the true answer is decided (X3, X6, X10, W4d); the
      numeric surface still imposes the first equation over a free partner (Q4, decision 7); SMT
      abstains on renamed paths (`q.pp.x`); the bare-name analogue of the RB clash (the assert in
      p's own body, `rbloc2`) reads T/T/F/X with no allowlist entry; an assert in a specialisation
      of the default's owner and a per-type orientation (`rh`, `rh2`) read as before. X11's
      value-source clause still names `through X11::Q's bind` (`readsClause`). [O5, review]

- [ ] **Finish what `table-rows` left of E3, E6 and E9.** The branch (merged by `0a69bcf`) closed E5
      (the mapper's end copy) and E7 (the context row at its own instance), made `d1plain` abstain
      (A.5), and moved eight of E3's ten rows and eight of E9's ten. Still open, pinned in
      `KNOWN_FALSE` / `I7_ALLOWED` as "no step yet": (1) E3 `h2p0` (`P::c in Q::p`) and `h2c0`
      (`Q::c`) read ?/?/?/? beside ref T: they need a per-instance read of a non-uniform enclosing
      attribute, plus the new `in q::p` and `in q` rows (F); (2) E6 `D1E`, the expression-valued
      pair (`load = 30.0` against `L = 2.0 * K`), and `m7y`, read as before; (3) E9 `Fx4` `c` and
      `c2` (`%` over a constant divisor) stay T/T/T/?: encoding `%` in QF_LIRA means a new
      standard-refused construct across about twelve differential tests, `smt-encode`, the campaign,
      five fixtures, the unsupported-construct catalogue and the docs; and `P5G` stays in
      `SAME_POINT_DEMOTED`; (4) the E9 entry's diagnosis of `u-m2` was wrong (gate (e) refused the
      binding's context row); and gate (e) does not see the dimension a binding gives an untyped
      feature, so the check reads it unit-blind (50000 g) where numeric, SMT and bounds read SI (50)
      (`UB6 q::big`, `UB4 cX/dX`: I1 clashes since before the branch, not pinned). [O6]
- [ ] **Read a name by the scope the surfaces use, and the shapes the lexical rule leaves.** Pinned
      "no step yet": (1) a bare name is read as the one feature nested below the context that
      answers it before the lexical name (`NX1`, `NX3`, `NX4`); (2) a body inherited from a general
      type is read in the context's own scope (`DY1`: q's own `L` answers the `load = L` Q's p
      writes; false on three surfaces since before the branch); (3) an end copy under two general
      types that each redefine its head (`MI1`, `MI2`); (4) an enclosed binding has no `#bind` row
      and no SMT axiom where its usage is redefined (`EB4`, `EB5`); (5) a context that sets the
      bound partner's input by an asserted equation, or redefines the bound feature under a new
      name, gets no `c in q2` row on any surface (`R22B`, `R27F`, `R38`); (6) the SMT engine does not
      read a unit-typed package binding (`W4u`); (7) a name reached through an import or alias, a
      qualified `Lex::K` and a non-attribute lexical feature are left unread; (8) typed asserts are
      ignored by the engines (`CD1`). [O6 S1-S4, reviews]
- [ ] **Read bindings deeper than 32 usages (optional).** A context more than `MAX_BINDING_SEGMENTS`
      (32, `src/semantics/defining-equation.ts:2001`) usages below where its binding is written is
      not read, so the check and the literal engine abstain on `chain33` and `chainPkg33` (four
      rows; `DP33::negT` reads ?/?/T/T and `posF` ?/?/F/?). Sound, only weaker than it could be.
      Raise the cap or make the instance walk iterative. Done when those rows decide on all four
      surfaces. [review 2026-10-14 E10]

## Per-instance soundness — review 2026-10-14

From the soundness review of F3–F8 and 3e3b0ff (Sysprose 5943654 against 7277a97). The branch
`per-instance-sound` (merged by `4ac2fff`) closed A-C1, A-C2, A-C3, A-H1 (the direct reads), A-H3
and A-H4, PI-1, and the correctness half of A-H2: instances now read where they stand, abstain where
they cannot, and the four-surface table pins A1–A9, A4, CAP1, X-shapes and the units shapes at their
true values. What follows is what that branch and the review of it left open; entries tagged
`[O2 …]` come from its steps and reviews.

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
- [ ] **Name the differing value in a violated-instance finding.** Witnesses now carry their values
      (`engine-small`, merged by `318283c`), but the finding's value clause still names the first
      bound read: `g-a4r2` prints `load = 2` where `extra = 20` differs, and `s-a4` names no value.
      Pick the read whose value breaks the relation (with the anchor entry above). Narrow the `U3`
      note entry above to its note half: the carried-value clauses are done. [N1 S2, review]
- [ ] **Finish the wording and evidence residuals of `reporting-small`.** The branch (merged by
      `794c038`) rolled findings up and folded them, stated causes and the cap, folded and named the
      `verify` text and footer, removed the dead H6b label, and closed EV-4, EV-6 and EV-7's
      cross-checks. Left: (1) the `under` filter misses renamed redefinitions (probe `e5`), and
      `big-bind-600`'s cold check is 17% slower than before the routing change (577 to 675 ms);
      (2) the evidence record does not record the instance path of a shared-usage reading
      (`satisfy LoadReq by Sys::p` records only the own row); `verify` prints a moved reading as
      `H::LoadReq in H::p1` where the record says `H::massR in H::p1`; a case that verifies both
      the definition and the usage counts the one moved reading twice; the move fires for a
      requirement-def specialisation too; an earlier build's `LoadReq in p1` record is skipped with
      a sentence that says the model never reads it, which is not quite true; (3) paths in the
      binding-carried context rows and the unfolded `target-by-specialisation` rows are still
      unquoted (the witness tests pin the text), the fold lines name the relation unquoted, the
      frame-cap count is a lower bound ("at least N") and counts print raw beside the capped
      sentences, and a footer fold over a requirement's per-subject rows names the clause's
      synthetic name, not the requirement. [N3 S1-S4, reviews]
- [ ] **Exit a transition to the least common ancestor of its source and target.** `stepConfig`
      (`src/semantics/mc/config.ts`) exits only to the source's level (`exitTo(choice.level)`) and
      enters the target on top, as `runStateMachine` does, so a step from a substate to a state outside
      its composite leaves the composite active (`[C0, Idle]`). A `state C0` atom then holds at
      `Idle`, and a property can be refuted by a run that holds only because `C0` was never exited:
      on `Idle -go-> C0`, `C0 { a -x-> b; b -back-> Idle }`, absence of `state C0` after `back` is
      FAIL (`verification/refuted`, exit 1) at `Idle`, where UML's reading holds (`38c8d0b` does the
      same). Each round trip also stacks one more state: one composite of two substates reaches the
      depth bound and every reach list is withheld; five of four reach the configuration bound
      (`docs/06` §8.9). UML exits to the least common ancestor. A fix changes `simulate` and every
      verdict on such a machine; none in the gate corpus or v9 (`nest2-into` is refused). Fixtures
      that rely on it: `heavyMachine` (`palette-checks.spec.ts`) and `hierarchical(…, exits)`
      (`checks-registry.test.ts`). Opus class: it changes semantics and a false verdict exists now.
      [O7 S1]
- [ ] **Say when Save or Export drops field changes made over older typed text.** In the "kept" case of
      `typedTextFirst` (the element is not in the typed text, or the model changed since the typing) a
      later Save or Export applies the typed text over the newer model and so drops the field changes
      made since, without a note. Give it an info note, or keep the text back; it needs a message
      design, and the stale-`typedFrom` test would also fire on the SDK, peer and faulted-apply paths.
      Also: a field's change over typed text parses on the page (P3). [O7 S2, review]
- [ ] **Anchor at the value that breaks the relation, and once per cause.** Since `f27d99b` a
      violated-instance finding is anchored at the instance's own differing line, but (1) when a
      binding carries two values into an instance the anchor follows the first read's source, not
      the one that breaks the relation (`q2 : Q { attribute :>> L = 2.0; attribute E = 20.0; bind
      p.extra = E; }` under `load + extra <= 10.0` points at `:>> L = 2.0`, where `E = 20.0` causes
      the miss), so the hint "change the value the binding carries" sends an agent to a line that
      cannot clear it; (2) a violation inherited from a definition's usage (`part def R { part q :
      Q { attribute :>> L = 50.0; } } part r1 : R; part r2 : R;`) is one finding at `R::q::p` and
      one at each `part rN : R`, for one cause; (3) an anchor at an unnamed redefinition (`attribute
      :>> L = 50.0`) has no `elementName`, because `src/text/load.ts` takes `declaredName` only.
      Pick the source whose value is the difference, fold the per-`rN` findings into the one at the
      stated member, and name the redefinition. [O4 S2, review] See also the A-M2 entry (per-instance
      soundness section).
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
      withholds; a row needs a catalogue code of its own. (2) Closed by `d1aa330` (the history map
      left the key). (3) Not probed: the `covered`/`fail` witness note may key on the machine's published choice rows, so a witness
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

- [ ] **Cache `READINGS` from the second read on (optional).** The readings cache (`READINGS`,
      `src/semantics/contracts.ts:663-691`) builds a JSON key and `structuredClone`s on every read,
      so v9 `obligationsOf` is 1.039× slower than at 3ab826a (paired range 1.008–1.070 over 7 pairs,
      about +2 ms) and `refineAll` 1.023×. Cache from the second read of a key on, or use a cheaper
      clone. Done when v9 `obligationsOf` is no slower than at 3ab826a, paired. `engine-small` cached
      from the second read of a key on and is faster than `98d3595`, but measures 1.08× `3ab826a`
      paired (the cache costs about 1 ms; the rest comes from other merged changes): keep open, or
      accept as a residual. [review 2026-10-14 C-F5; N1 S4]

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

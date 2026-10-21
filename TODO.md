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

- [ ] **Run the palette's solver checks in the page on the hosted site too (optional).** Since N6 S4
      the dev and preview servers send `Cross-Origin-Opener-Policy: same-origin` and
      `Cross-Origin-Embedder-Policy: require-corp` (`SYSPROSE_NO_ISOLATION=1` turns them off for
      local Google Drive testing), and the palette's five solver checks run z3 in the page there and
      land in the Checks tab. The GitHub Pages site cannot send the headers and decision U14 ruled
      out a service worker, so on it they keep `not here` with the copyable command. Done only by
      moving the model site to a host that sends the headers, which would break the Google Drive
      sign-in popup and Picker iframe there too. Awaits user decision U14 (host): whether in-page z3
      on the hosted site is worth that cost. [N6 S4]
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
- [ ] **Stop an in-page solver check from stalling or tearing the page.** N6 S4 runs the five solver
      checks in the page behind a queue and a mutex. Left: Cancel drops the answer but cannot stop
      z3, so the check ends at its own time budget and a Run started meanwhile queues behind it; a
      model edit during a run can give a torn read across awaits (the result lands against the
      click's revision and shows stale; documented, not snapshotted); a z3 module that dies in the
      page (the finalizer race, or a hang) keeps the bundled async-mutex held until the page is
      reloaded, because the mutex watcher is not wired into the esbuild-bundled entry; an in-page
      check keeps no evidence record (`verify --record` is terminal-only); the encoding cost
      (`obligationsOf`, script building, `resolveFreeFeatures`) runs on the page thread and is not
      measured on v9, with no long-task guard over solver checks; the `bounds` check's degraded path
      has no test of its own; and the isolated E2E fails if the run sets `SYSPROSE_NO_ISOLATION=1`.
      [N6 S4, review]
- [ ] **Move the first Apply's parse off the page (P3, the rest).** N6 S5 builds the Chevrotain
      parser while the page is idle after the Text view opens, so the first Apply no longer pays the
      ~1.3 s build; the parse itself is still on the page and synchronous (`applyText`,
      `typedTextFirst`). Left: a worker parse needs an Apply that is in flight (the buffer edited
      during the parse, Undo and carried ids across the wait, the `ParseResult` rebuilt on the page,
      a page fallback); callers that parse before the Text view has been opened still pay the build
      at their click (opening a `.sysml` file, and the Drive guard's `typedTextFault` before the
      Text view mounted), and would need a second trigger such as the Open menu; and the warm-up is
      best-effort, covered only by a unit test with injected dependencies, with no E2E that the
      stall happens once. [N6 S5, `docs/UI-ROADMAP.md` P3]
- [ ] **Make the frozen column-header strip read at the whole v9 Fit.** Since N6 S1 a layered
      General view's column headers are a frozen strip along the canvas top, clipped to each column
      and clamped to its piece, with the label at a legible size at any zoom, and Fit keeps the
      first row of boxes clear of it. Left: at the whole drone-swarm v9 Fit (1400×900, zoom about
      0.021) 16 of the 21 headers (those over the pieces below the first row) are not in the strip,
      because their bands are about 1 px tall and their columns 8–17 px wide on screen, and a column
      under 28 px wide has no strip label; the strip floats about 56 px below the canvas top (under
      the toolbar), so on a deep pan boxes show above the header that names them; when two pieces
      are closer than about 22 px minus the band and gap on screen, the next piece's cell can
      overlap the leaving one for a few px of scroll; and the E2E uses a generated tall-column
      model, not the v9-sized one. Done when every header of the v9 Fit is findable (a strip row per
      piece, or a hover label) and a guard holds it. [review 2026-10-14 D-7, N6 S1]
- [ ] **Decide what the layout does with a piece that nests (P1, U19).** `layoutOptionsFor(viewKind,
      nested)` (`src/diagram/layout.ts`) sets `elk.hierarchyHandling: 'INCLUDE_CHILDREN'` for a
      piece that has a nested box and `SEPARATE_CHILDREN` for every other piece. N6 S2 measured both
      through `layoutDiagram` at `aac38fd` (the table is in `docs/UI-ROADMAP.md` P1): the profile's
      11 s reproduces on the entry's own 330-node graph (43–45 s shipped on a loaded machine,
      0.6–1.4 s forced, 69×), so the time rule is met there, but forcing `SEPARATE_CHILDREN` lays
      each parent's interior out alone and does not route an edge that crosses a parent's border
      (576 of that graph's 600 edges are drawn as straight lines through boxes); on a structured
      variant it is only 4.6–5.8× faster with 20% more crossings and 300 unrouted edges, and on the
      real v9 views it changes nothing. So no layout code changed. What stays open is to bound the
      compound layout: lay each parent's interior out on its own, then route the border-crossing
      edges ourselves. Done when the 330-node case lays out within a time the decision names,
      measured through `layoutDiagram`, with no unrouted edge and no more crossings than the shipped
      option on the structured variant. Awaits a user decision, not yet numbered in the plan: bound
      the compound layout, or accept the time. [N6 S2]

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

- [ ] **Read an asserted equation through a binding's end.** An equation that decision 14 makes stand
      over a `default` carried by a binding component (only defaults) abstains on every surface with
      `unread-binding`, wherever the binding or the assert is written (O9 S2). Probes: RB3 and RB4
      (the package assert over Q's binding; RB4's q2 abstains too); RB5, RB5C, RB5D, RB5F (Q's
      `p.x == 50.0` over a binding in q1, in q1's p, in the package, or in W; truth K = 50); RBS1,
      RBS2, RBS5 (the assert in a specialisation, beside the binding in the package, or in a usage;
      truth L = 3, top T); PJ (P's framed `L == M` over q's `bind p.L = K`; truth 7). Reading these
      needs the component's value taken from the equation (`classified` / `endValue`), and the
      numeric and SMT lanes dropping the component's default at that instance; the SMT still keeps
      that default axiom, so PJ's `P::c` reads X (I7) and RB5 with a relation on P reads
      inconsistent axioms. [O9 S2]
- [ ] **Read an asserted equation through a reference or a valued part.** RF, RF2 and RF3: the rows
      through Q's `r`, q's `r` and `p1` abstain; under decision 14, `p1.x` and `q.r.x` are 50. P's
      own `c` (and RF3's `p0`) stays T beside the SMT's inconsistent axioms (I7), because the SMT
      reads Q's `r.x` as P's generic x. Reading these needs the referenced instance's symbol filed
      with q's frame, and an SMT instance split. [O9 S2]
- [ ] **Read a local equation over usage values that read names or bindings.** P's `L == M` is read
      per instance only where every usage that values M gives a literal (or a `default`, U7). Every
      reading of L abstains, P's own and p's literal frame included, when a usage gives M an
      expression over other names (PIN5's `:>> M = K`), or a binding joins M to a value (PA's `bind
      p2.M = K`, PA4's `bind M = K` in p2, PA2, and PA0 with no literal frame); the binding's own
      `#bind` row abstains too. Fix: an independence check of the frame's value, as `valued` does in
      the owner, and a reading of the bound value per instance. [O9 S2]
- [ ] **Read a framed equation in units.** P's `L == M` with P5's or p's `:>> M = 7.0 [kg]`: the check
      and the literal engine abstain (`"L" has no value in scope`). `P::qa`'s generic row went from
      T/-/T/- at aac38fd to ?/-/T/- since O9 S2; the context rows the review fixes add read ?/?/?/T
      (cT) and ?/?/?/? (cF), and the package rows ?/?/T/T and ?/?/F/?. None is false; readings are
      lost. Shapes: the M-generator files `dt_frame_{usage,spec,deep}_kg`. [O9 review]
- [ ] **Taint the instance an unread asserted equation reaches, not the definition's feature.** Three
      refusals (through a reference or valued part, the bound-partner refusal, and the unsure /
      framed refusal) taint a definition's feature and its redefiners (`P::x`, `P::load`, `P::L`),
      so true rows of every other instance abstain: h5bD and h5bL (`P::c`, `P::c in Q::p` and `in
      q1::p` were T/T/T/X and are now ?/?/?/?; in h5bL, q2's L is a plain 5), RB4's q2, PIN5's
      `P::c` and p's rows, PA's `P::c`. Sound, only weaker. An instance-only taint must still reach
      the binding partners: q2's L through Q's `bind p.load = L`. [O9 S2, review]
- [ ] **Contain the remaining new instance-index calls.** `equatedParts`'s call to `enclosingAsserts`
      (`unreadAsserts`) and the `readAt` filter in `readFeatures` (`enclosingAsserts`,
      `assertHeldInSome`) are not contained, so a throw there still ends the check (loudly) rather
      than one row; it now drops the half-built `EQUATED_PARTS` entry first, so a later call at the
      same revision rebuilds the index and abstains as a clean run does. The calls in
      `contextsUncached` are contained. No throwing-stub test: the calls are internal to
      `defining-equation.ts`, and the module-level `vi.mock` stub cannot reach them; a test needs an
      injectable seam (A.2.9). [O9 S2, review]
- [ ] **Finish H5B: an element's own equation over a default.** An element's own asserted equation
      over a `default` still abstains as `not-enumerated` when the enclosing rule does not file it
      because the other side has no value (`extra == M`), and when the default is also held by the
      local rule (q7's `:>> extra default = 7.0` plus `extra == 2.0`, or the element's type's own
      assert). The wording of those refusals is a separate entry. [O9 S2]
- [ ] **File per-instance rows for a `satisfy` a definition writes.** `part def W { part p1 : T0;
      satisfy RF by p1; } part w : W { part :>> p1 { attribute :>> load = 50.0; } }` files no row
      for w, so `verify` exits 0 and `sysml-check --strict` passes while w breaks RF (sd0, sd1, g8
      in `bindings-residual-scratch/rv/p`). The same holds for a requirement usage in a definition
      whose subject is bound to a plain part (sbj0). A satisfier reached through a reference, an
      equated part or a subject, and a valueless `ref` an instance rebinds (F1, F3), abstain
      (`unread-binding`). File per-instance rows for a satisfaction, as for a constraint written in
      a definition, or abstain on every satisfaction a specialised definition writes. A false pass.
      [O9 S1, review]
- [ ] **Read a definition's relation through a reference or a renamed redefinition an instance
      rebinds.** `part def W { ref part top : T1; ref part pp : T0 = top.a; constraint pF { pp.load
      <= 5.0 } } part w : W { ref part :>> top = t50; }` (v8x, v8x2), the direct `top.a.load` (v8xd)
      and `part top2 redefines top {...}` (v8n) file no row for w: W's `pF` holds while w's 50 breaks
      it. A part rebound by a value this tool does not read through (`part :>> top = t50`) files the
      row and abstains (h5-valinst, h5-bndinst, h5-refinst). A false pass. [O9 S1, review]
- [ ] **Name the instance a finding is about.** `p50::r2.load = 50 misses P::c` (rv/p/g7, where the
      row is read for pb), `p1::r2.load` for q2's p (g3), and at aac38fd `p2::r1.load` (rr1): the
      message names the target of the last link, not the instance the row is read for
      (`pb::r2.load`, `q2::p::r2.load`), so an agent edits the wrong element (the PI-2 class).
      [O9 S1, review]
- [ ] **Say a tool limit is a tool limit.** `unread-definition` refusals print "This is a defect in
      the relation", and verify files the per-instance `not-enumerated` abstention of H5Q7's shape
      (`attribute :>> extra default = 7.0; assert constraint { extra == 20.0 }` in the instance's
      own element) under `unread-definition`. A relation over a value the model states but this
      tool does not read is a limit of the tool, as `unread-binding` is (`engines/literal.ts`, the
      not-evaluable branch for gate refusals; `engines/smt.ts`, the refusal outcome): give it the
      tool-limit sentence through `refusalTail`; the exit code stays 2. And where an unread valued
      part's partner is read (sbv: `top.a.load` beside `part pp : T0 = top.a` and `bind pp.load =
      seven`), the numeric surface abstains with `"top.a.load" has no value in scope`, not the
      binding's sentence: its `equatedPartsRefusal` pass in `solver.ts` skips a row that is already
      unknown. Wording only; every surface abstains. [O9 S1, review]
- [ ] **Read what two steps of standing-for, a call, or a second subject would decide.** All sound,
      all weaker: (1) a shared-usage (group) row read through two steps of standing-for (a reference
      to a reference, or to an equated part, written in the usage's definition) abstains with "this
      tool cannot tell what its ... stands for there" (`subjectScope` gives such a reading no
      scope, and `crossingReadsOtherwise` cannot re-resolve it; one step is read, h5-refgrp); (2) a
      part, or an attribute of a structured type, valued with an expression that is not a path (a
      call: `part pp : T0 = Same(top.a)`, `attribute q : V = Same(top.pos)`) abstains on every row
      that may read through it (h5-ppcall, h5-r8expr), which needs the calc's result evaluated as
      a part or a structured value; (3) a `satisfy R by p1` beside `requirement r1 : R { subject s
      = p1; }`, where both subjects stand for one instance: r1's literal and SMT rows abstain with
      "the numeric surface never gathered this relation" (SAT2). [O9 S1]
- [ ] **Abstain on a self-contradictory model, or keep the pin.** LE (`P::c` and `P::c in Q::p`) and
      K1T (`P::c in K1T::q3::p`, which abstained at aac38fd and which `readAt` now decides) read
      T/T/T/X: true where they are read (x is 3 there), beside a whole-model contradiction the SMT
      reports. Ruled at the merge: a permanent `I7_ALLOWED` pin with the LE wording, as for R8. The
      alternative is to abstain on every row of a model the enclosing rule finds contradictory (or
      where an element's assert gives the feature two values anywhere in the group). Optional.
      [O9 S2, ruling]
- [ ] **Name an unnamed nested redefinition's context row alike on every surface.** A context that
      is an unnamed redefinition is named `... in q::«PartUsage»` by the check and numeric surfaces
      and `... in q::r` / `q::p` by the literal and SMT engines (RF, RF2, RF3, CI1; the new
      `dt_*_deep` files), and a model like RB5 with a relation on P gets two check rows named `P::c
      in q1::p` (a specialiser reading and the group's enclosing-assert row), which makes the
      four-surface harness throw (pre-existing at aac38fd). Every such row abstains or agrees.
      Low. [O9 S2, review]
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
- [ ] **List what a load binds later in the order a terminal binds it, on the page and on every peer of
      a room.** After an edit the page lists the user's declarations in the order the text gives them
      (`Model.adoptSerialOrder`, `src/core/model.ts`), and each owner's children come in one order on
      every peer of a room (`src/collab/model-doc.ts`). But a typing, specialisation, redefinition or
      implicit feature keeps its place among the others: one made in the app (Properties' Type field, a
      line drawn with the palette) is listed after every one the model had; one whose element a drag
      puts elsewhere in the text, or that a project, model JSON or branch stored in another order,
      stays where it was. A terminal over the saved text binds them in the order their declarations
      come. In a room, a peer that joins lists them in the order the room's document lists its keys,
      and a peer present after a reset (Apply, Import, Undo, Redo) keeps them where it had them. So a
      check that goes by them (`where-used` over a definition) can list its rows in another order than
      a terminal, and than another peer. Probes: (a) `package X { part def D { attribute a = 1;
      constraint c { a <= 0 } } part u1; part u2 : D; }`, type `u1` as `D` in Properties: the page
      gives u2, u1 and a terminal u1, u2; (b) `package X { part def D {...} package A { part u1 : D; }
      package B { part u2 : D; } }`, drag A out and back in: the page gives [u1, u2] and a terminal
      [u2, u1], and the same after the stored project is reopened (the same at 87e8c0f). Fix: list
      them in the order the parser's binding pass makes them (`:>`-family first, then `:` typings, then
      connector chains, each in the order of their declarations), measured to leave every load where it
      is, or order such rows by the text; carry that order in the room's document too. Done when the
      probes' page, terminal and peer rows come in one order. [review 2026-10-14 D-1, collab-order]
- [ ] **Resolve two peers' moves that hold two elements in each other.** In a collaboration room, two
      peers who at the same moment each move one of two elements into the other (`X` into `Y` on one
      peer, `Y` into `X` on the other) leave the room's document holding `X` under `Y` and `Y` under
      `X`. Each peer refuses the move that would close the cycle (`Model.reparent`,
      `reconcileModelFromDoc` in `src/collab/model-doc.ts`): one holds `X` under `Y` with `Y` at the top
      level, the other `Y` under `X` with `X` at the top level. A page that joins as the app joins
      (`connectCollab`: its own model bound to a new document, then the room synced in) holds the pair
      as one of the two does. A model bound to a document that already holds the room (the API's
      `bindModelToDoc`, through `serializeFromDoc`) holds each under the other, reachable from no root:
      neither shows in its tree, and its text drops both and all they hold. Moving either element
      again does not end it: the peer that refused keeps its own reading, because its own edit is never
      taken back in from the document. An Apply, Import, Undo or Redo by any peer brings every peer to
      that peer's tree (USER-GUIDE section 9 states it). Fix: break such a cycle the same way on every
      peer and on a join, for instance by putting the member with the lowest id at the top level. Done
      when both peers, a page that joins and a model bound to the room's document hold the pair alike,
      both in the tree. [collab-order S2]
- [ ] **Keep the collaboration relay up on a model with the full library.** `scripts/collab-server.ts`
      caps a message at 10 MiB and sets no `error` handler on a socket, so a larger message kills the
      relay process (`RangeError: Max payload size exceeded`, an unhandled `error` event) and drops
      every room on it. A peer's first message carries the whole document, standard library included.
      For the drone-swarm v9 model that is 10,769,168 bytes at 87e8c0f and 10,845,744 bytes with the
      places `collab-order` adds; a probe on a scratch port confirmed that a v9 room kills the relay.
      The app's sample model with the library is 9,799,148 bytes, about 686 KB under the cap, which is
      why the children of the library's owners get no place until one of them moves. Fix: on a socket
      error close only the offending connection, and keep the standard library out of the room's
      document (every peer loads it), or raise the cap, or split the message. Done when a room over v9
      syncs between two pages (E2E). USER-GUIDE section 9 states the limit. Pre-existing. [collab-order
      S2]
- [ ] **Make a reset in a collaboration room cost what it changes (optional, measure first).** An Undo,
      Redo, Apply or Import in a room clears the room's document and writes every element again,
      library included. On v9 with its library, the editing peer's reseed plus one other peer's
      reconcile take about 28 to 30 s in node on a quiet machine (80 to 100 s at load 30 to 35), at
      87e8c0f and at `collab-order` alike. The whole document goes as one message, which runs into the
      relay cap above. Fix: write only what the reset changed (a diff of the snapshot against the
      document), with the library kept out. Pre-existing. [collab-order S2]
- [ ] **Save a binding to an unnamed redefinition under a name a terminal can read.** Save writes a
      binding whose end is an anonymous redefinition by a placeholder name: for the verdict-corpus
      model `07f3a4f30d1d-d4-usage-redef-default-bound`, `part p : P { attribute :>> load default =
      30.0; } bind p.load = L;` is saved as `bind D4::Q::p::«AttributeUsage» = L;`, which a terminal
      reads back as `Connector ... has 1 endpoint(s)`. In `r14-bind` and `r14-bind-dflt` the constraint
      over it then abstains for another reason ("w has no value anywhere" instead of "cannot be
      derived: ... contradicts ..."), and `k4a-contra-units-same-number` shows the same pattern. The
      page and a terminal over the original text agree, and every verdict seen abstains, so no false
      verdict was found. Pre-existing at 87e8c0f. [collab-order S1]

## Behaviour checks and the palette's checks lane — review 2026-10-14

From the reviews of the behaviour lane (reach and check-behaviour in the palette) and of the ux
merge. The branch `behaviour-sound` (merged by `e0d8040`) closed the completion budget, the nested
`state def`, the method text and the completion livelock (C1, H2, C3, H1, M3, M1, U1); the entries
tagged `[O1 …]` are what its steps and reviews left open.

- [ ] **Walk a step written over inherited states.** Since `e0d8040` a control edge written outside a
      machine's region that touches one of its states refuses the machine (`machine-boundary`,
      `docs/06` §8.6). A specialisation that adds a step over inherited states (`package W2 { state
      def Base { state a; state b; state c; transition ab first a accept go then b; } state def
      Derived :> Base { transition bc first b accept more then c; } }`), or a typed usage that does,
      therefore refuses both `Base` and `Derived`, where `5943654` walked `Base` alone. Fail-closed by
      design. Fix: a reading that walks the two together. [O1 S3]
- [ ] **Compare the stack in the witness replay, not only the leaf (optional).** `replayWitness`
      (`src/semantics/mc/patterns.ts`) compares each step's resting leaf. The interpreter does not
      expose its stack: `activeStates` is the final leaves, and `visited` records what a step enters,
      never what it exits, so a stack rebuilt from them cannot catch a state the walk keeps and the
      interpreter left. Fix: `runHierRegion` records each fire's active stack (an optional
      `StateFire.stack`, which moves `executionReport`'s payload), and the replay compares it with
      the trace's `stack`. The differential CASES' three flat-path machines catch such a split
      today. [O8 S1, review; behaviour-rest S2]
- [ ] **Decide a count past the budget where a trigger-less dwell follows (optional).** Since
      `behaviour-rest` S1 a search on a machine that names no trigger ends each run where the chase
      budget stops it (`budgetEndsRun`, `src/semantics/mc/patterns.ts`; docs/06 §8.12). The
      exception is a walkable trigger-less transition that carries a numeric `attrs.after` (set only
      through the API): a clock advance fires it where the chase stopped and the chase goes on (on
      `a ⇄ b` with `a -> b` such a dwell, one advance of 5 takes the run into `b` 65 times), so the
      search still refuses the step past the budget (`completion`, inconclusive). Done when such a
      search carries the chase position and offers the clock advance where a chase stops, or the
      refusal is documented as permanent. [behaviour-rest S1]
- [ ] **Say in the bounds sentence that `maxDepth` counts events (optional).** Since `behaviour-rest`
      S1 the depth bound counts the events a run takes from the opening, not its steps
      (`DEFAULT_MAX_DEPTH`, docs/06 §8.12), while the `depth` figure beside it still counts steps,
      so `reach` can print `depth 260` beside `maxDepth 200` (four stacked completion cycles). The
      guide and the code say so; the printed bounds sentence does not. Rewording it (for example
      `maxDepth 200 events`) re-records every qualification string in every report and pin, so it
      is its own step, with the corpus diff named. [behaviour-rest S1]
- [ ] **Name every region's refusal on a parallel machine (optional).** Since `behaviour-rest` S1 a
      step into the machine's root or under an action stops only the region it came in on a
      parallel machine (`attrs.parallel`, API only; `refusedStepSentence`, `SimRefusal.stopsRun`),
      and `StateRunResult.refused` names the first region's refusal only, so a second region that
      also stopped is not named. The walk refuses every parallel machine (`parallel-regions`), so
      no verdict stands on it. Done when `refused` lists every region's refusal, or the parallel
      interpreter interleaves its regions. [behaviour-rest S1]
- [ ] **Name the holder in reach's refusal (optional, low).** `reach --element P::Lone::b` (a state
      in a lone `state def`) and `reach --element P::Outer::Mach::Inner2::x` (a state of a
      transition-less definition inside a machine) still print only "... holds no state machine";
      `check-behaviour` names the lone definition or the machine since `behaviour-rest` S2 and its
      review fixes (`behaviourNoMachine`, `report-lines.ts`). [behaviour-rest S2, review]
- [ ] **A state def used as a state's type is not lone (optional).** `isLoneDefinition`
      (`patterns.ts`) reads only ownership, so `state def Modes` typed by `state m2 : Modes` inside
      machine `M` is offered as a lone carrier and its properties reported as not checked. It fails
      closed (a refusal or a `not checked` row, exit 2). Decide whether a typed use places it in
      `M`. [behaviour-rest S2, review probe]
- [ ] **Take a step across a machine's boundary alike in the walk and the simulator.** The simulator
      takes a step across a machine's boundary (`machine-boundary`, docs/06 §8.6) while the walk
      refuses it, and a composite run on its own in `executionReport` takes a step out of itself
      into its holding machine's root the old way. Both readings predate `behaviour-rest`; decide
      whether the simulator refuses them as it now refuses the step into a root. Low.
      [behaviour-rest S1, observation]
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

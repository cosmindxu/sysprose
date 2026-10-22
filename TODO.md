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
- [ ] **Hold the same timeout floor on the hooks of the differential table.** The budget-aware guard
      `ui-small` S5 added covers `test/campaign/verification.test.ts`. The two `beforeAll` hooks of
      `test/integration/verification.differential.test.ts` (600_000 and 1_800_000 ms) drive z3 across
      the whole corpus, and the `withZ3` wrappers of that file and of `smt-z3.integration` refuse only
      a timeout under 40 s at declaration time; neither file has a counter-backed last case. A shared
      helper over `z3BudgetWatch()` would cover them. [ui-small S5, review]
- [ ] **Decide whether a collaboration room's copy counts as saved for the tab's close question
      (optional).** Since `ui-small` S1 the tab asks before closing over text or boxes not saved
      (`askBeforeLeaving`, `leaveUnsaved`). In a collaboration room a peer's edit makes the text read
      unsaved while the relay and y-indexeddb hold the room's copy, so every collaborator gets the
      question on close. It only errs toward asking. Decide whether the room's copy counts as saved.
      [ui-small S1, review]
- [ ] **Give the focus somewhere safe when the Requirements table's reference picker closes.** Since
      `ui-small` S2 `Escape` in the Explorer's rename, the context menu's and a Requirements cell
      leaves the focus on Save (`cancelAndFocusSave`, `src/ui/commands.ts`). `Escape` in the picker
      (`req-ref-picker`) and `Enter` on a candidate close it with the focus dropped to the page, and a
      pick selects the requirement row, so the next `Backspace` deletes the requirement just linked.
      Route the keydown paths (not the blur, which cancels) through `cancelAndFocusSave` /
      `commitAndFocusSave`. Check the Regroup view's bundle-label and port-name boxes
      (`RegroupView.tsx`, the Enter and Escape handlers that call `blur()`), which from code reading
      also leave the focus on the page. Done when `Escape` and `Enter` in the picker leave a following
      `Backspace` harmless, with a test. [ui-small S2, review]
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
bindings, deleted the eleven `I7_ALLOWED` entries of the old clash, and pinned what it left open.
Since per-instance-rest (merged by `ca4992c`), `KNOWN_FALSE` is empty (it held 20 rows at 3c54ae0),
so the plan's "Done means" item is met, and no allowlist entry is tagged `no step yet`. The
residuals are the entries below. The false verdicts the review of 2026-10-14 found in the
per-instance code itself follow under their own headings.

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
- [ ] **Finish H5B: an element's own equation over a default.** An element's own asserted equation
      over a `default` still abstains as `not-enumerated` when the enclosing rule does not file it
      because the other side has no value (`extra == M`), and when the default is also held by the
      local rule (q7's `:>> extra default = 7.0` plus `extra == 2.0`, or the element's type's own
      assert). The wording of those refusals is a separate entry. [O9 S2]
- [ ] **Read a satisfaction, a subject or a reference a definition writes in each instance of it.**
      Since per-instance-rest S1 these are read at the values of the element they are written in,
      and each of their rows abstains (`unread-binding`, naming the instance) where an instance of
      that element reads them otherwise: a `satisfy` written in a definition or in a usage another
      specialises, whether R reads the satisfier through its subject or through a feature of its own
      (sd0, sd1, SM1, SM6); a requirement usage there whose subject a value binds (sbj0, SM3, SM2)
      and any read of that subject from outside (`w.q.s.load`, SBO, SBN); a reference a nested usage
      values with a feature around it, and every value, binding or redefinition read through it
      (cown2, RC7, RC7B, RC7C, X17NB, X17K's `q2.p.r.x`); and a reference redefinition that states
      no value of the valued one it redefines (`ref part :>> r;`, VR1, COWN7: the walk reads a fresh
      instance of its type); and the copy a binding's end written in an instance makes of a valued
      reference (RBB4K: w's `bind m = pp.load` over W's `ref part pp : T0 = top.a`, under w's `ref
      part :>> top = t50`). The walk read that copy as a fresh T0, so `w.m <= 5.0` read 1 on all
      four surfaces at 3c54ae0; since the review fixes it abstains, as a valueless `ref part :>>
      pp;` does. `bounds` refuses a measure read through any of them. G8, F1 and F3 keep their O9
      sentence and belong here too. Sound, only weaker: W's own true rows abstain as well (refout's
      `W::sub::pT`/`pF`, 24 M-generator rows in `sr_refout`, `sd_refoutm` and `sd_refoutb`), because
      they stand for every instance. Reading them needs one of: a row per instance; the path read in
      each instance as `landsElsewhere` reads a relation W writes, named per instance on the literal
      and SMT surfaces; or the walk resolving such a value in its own instance of the element around
      it (as `instanceStep` already does for a value below its element, cown3), and a valueless
      reference redefinition read at the redefined value, or the walk reading such a copy as what
      the reference it copies names. Done when sd0, sbj0, SM1, cown2, RC7, VR1 and RBB4K read F for
      w on all four surfaces. [per-instance-rest S1]
- [ ] **Read a subsetting usage in an instance that redefines what it subsets.** `part def W { part
      p1 : T0; part p2 :> p1; constraint c { p2.load <= 5.0 } }` with `part w : W { part :>> p1 {
      attribute :>> load = 50.0; } }`: every w's p2 is one of w's p1s (load 50), but the walk reads
      w's p2 as W's own, a fresh T0 (1). So `W::c` files no row for w, and `constraint k { w.p2.load
      <= 5.0 }` reads T/T/T/T. A `satisfy RF by p2` written in W files no row for w either, and
      `verify` exits 0 (sa7, sa3 in per-instance-rest-scratch/branch-review/p; SA5's W-level reading
      is F). Read p2 through what the instance's p1 is, or put a usage that subsets a feature an
      instance redefines into `satisfierTaint`'s narrowing (and `satisfierOtherwise` for a
      satisfier) so that its rows abstain. Done when sa7's k and `W::c in w`, and sa3's satisfaction
      in w, read F or abstain on all four surfaces. A false pass. [per-instance-rest review]
- [ ] **Resolve an unnamed `:>> x` in a usage to the most specific inherited feature.** The mapper
      resolves `attribute :>> M;` in `part s : Q2` to Q's M, not to Q2's `:>> M default = 2.0` that
      redefines it. So s's M reads Q's 1, and `s.M == 2.0` is refuted on all four surfaces (MI7,
      true T). Likewise `part r : Q2 { attribute :>> L; bind p.load = L; }` over Q2's `L = 50.0`
      reads P's default 1 for r's p's load (MI6's `r50` F/F/F/F, true T). U10 (O6 S2) made the
      implicit end copy redefine the most specific inherited feature; an explicit unnamed
      redefinition needs the same where the redefinition target is resolved (src/core or the text
      mapper), gated on the verdict differential and a v9 capture. Identical at 7565eb2.
      [per-instance-rest S3 finish]
- [ ] **Read a group's row through a reference its usage writes, now the walk reads it per
      instance.** cown3's `W::sub::c in w::sub` abstains (`not-enumerated`: "this tool resolves what
      a reference stands for only where its value is written"), while since per-instance-rest S1 the
      walk reads W's sub's `ref part r : T0 = x`, reached as `w.sub.r`, in w's sub (cown3's k reads
      F). The coverage guard (`instanceReadsOtherwise`) could read the row in that instance instead.
      Sound, only weaker. [per-instance-rest S1]
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
      Also the obligations lane's own catch in `groupGoalRows` (a per-instance reading that throws
      inside the tool): it files the goal under `unread-definition` with `failedReadingSentence`, so
      `refusalTail` closes it with "This is a defect in the relation". That blames the user's
      relation for a failure of the tool; USER-GUIDE says only that "the goal row is refused in that
      sentence". Give it a tail that says the tool failed. [per-instance-rest review]
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
- [ ] **Close the F section 2.8 rows still open, and the other end of an asserted equation's
      binding.** (1) GA6 `qa` reads T/-/?/- (target T/-/T/-; the numeric surface does not converge
      on that self-contradictory model). GA6 `pa` and GA12 `pa`/`qa` moved from a numeric T to `?`
      and gained or lost rows; that needs the maintainer's ruling under invariant (h). (2) A
      package-level definition-feature bind files no per-instance `#bind` row on the check and the
      numeric surface, so `sysml-check` abstains where SMT decides (`W4o::c4` ?/?/?/X). (3) Under a
      fixed slot the check and the literal engine abstain where the true answer is decided: X3
      `c3T`/`cMT`, X6 `c2T` and X10 `c3T`/`cq2T` read ?/?/?/T (the SMT engine decides them; pinned
      as W4X3 and W4X6), W4d `c2F` ?/?/F/?, `c2T` ?/?/T/T. (4) The numeric surface still imposes the
      first equation over a free partner (Q4L `eq` ?/-/T/-, decision 7: the label stays); its
      abstention on `c`/`d` says 'L is left free … no relation fixes it', not a sentence of its own.
      (5) SMT abstains on renamed paths (`q.pp.x`). (6) Where a binding joins an element's asserted
      equation to a value written with `=` that it does not give, the equation's end is not read on
      the check and the literal engine since per-instance-rest S2, but the other end still is, at
      its own value: RBL2L's `topL { q.L <= 3.5 }` and `q::lq` F/F/F/X, GV1's `pl` T/T/T/X, GW's `pl
      in q2` T/T/T/? (q2's own `load = 2.0` against Q's `L == 5.0` over L's default). Abstain on
      that end too, as A.5 does for both ends of d1plain. (7) The numeric surface reads one of the
      two for `q.p.x` itself: the binding's 4 where p's own assert writes 3 (RBL2 `top`, RBL4 `t1`
      ?/?/F/X), P's 3 where P writes it (RBB `top`, RBC `qc`/`dc`/`top` ?/?/T/X), all pinned in
      I7_ALLOWED. GW's generic `pl` lost its SMT refutation to a context a gate refuses (F/F/F/?, F
      before; sound). Closed by per-instance-rest S2: GA7 `pl` (F/F/F/F); rbloc2's T-against-F;
      RBB/RBC (an equation P writes, read at the instance a chain reads); RBL4 (an assert in an
      instance's own redefinition of p); rh and rh2 (pinned, own sentences); X11's value-source
      clause; the Q4 and RH2 'no value anywhere' sentences; BW4/BW5 (a chain to a default a binding
      holds names the binding). [O5, review, per-instance-rest S2]

- [ ] **Finish what `table-rows` left of E3 and E9, and the numeric surface's reading of an
      evaluated pair.** (1) E3 `h2p0` (`P::c in Q::p`) and `h2c0` (`Q::c`) read ?/?/?/? beside ref
      T; the check and the literal engine give a sentence of their own, but h2c0's numeric surface
      says only 'the solve did not converge'. They need a per-instance read of a non-uniform
      enclosing attribute, plus the new `in q::p` and `in q` rows (F). (2) E6 is closed on the check
      and the literal engine by per-instance-rest S2: a pair of `=` values only an evaluation
      compares is evaluated exactly where the binding's valued members are read (one value where
      they meet, two where they differ, an abstention of its own where it decides neither). The
      numeric surface still drops both values of such a pair for every instance
      (`statedAgainstBoundSomewhere`, per feature), where they meet too: bc2-ctx-derived's `k`
      T/T/?/T (T/T/T/T at 3c54ae0), and 466 rows on consistent models of the S2 review's 1260-model
      family (e.g. `G360::q::qc` T/T/?/T). It also says only '"load" has no value in scope', not the
      A.5 sentence (D1P, D1E, M7Y, bc2). Read the pair per instance there, or carry the sentence
      through `claimOnly`. (3) E9 `Fx4` `c` and `c2` (`%` over a constant divisor) stay T/T/T/?:
      encoding `%` in QF_LIRA means a new standard-refused construct across about twelve
      differential tests, `smt-encode`, the campaign, five fixtures, the unsupported-construct
      catalogue and the docs. `P5G` stays in `SAME_POINT_DEMOTED`. (4) Where a bare number meets a
      quantity a binding carries into a feature that declares no unit or kind, the check and the
      literal engine abstain since S2, but the numeric surface and the SMT engine still read SI (UB4
      `cX` ?/?/T/T, `dX` ?/?/F/?; UB6 `bT`/`cT` pinned in I7_ALLOWED). Gate (e) on all four surfaces
      is the remaining step (optional). [O6, per-instance-rest S2]
- [ ] **Read the name-scope shapes S3 left abstaining.** per-instance-rest S3 reads NX1/NX3/NX4 as
      KerML resolves them. It files R22B's and R27F's `c in q2` (F, `constraint-by-instance`) and
      R38's (`constraint-by-instance` info at q2's `ld :>> load`, since 1a8f9ca). It holds
      EB4/EB5/W4u's usages to their bindings (SMT inconsistent axioms), and gives an enclosed
      binding its `#bind` row, quoted as written. Still abstaining where KerML gives a value, each
      pinned in the four-surface table:
      (1) DY1: a context that declares a name a body of its general reads through the general's
      owners (q's `part :>> p { attribute L = 50.0; }` beside Q's p `:>> load = L`) reads the name
      nowhere, its own bodies included. Read each body by the scope of the element that writes it.
      (2) R38: a renamed redefinition of a bound end (`attribute ld :>> load`) is read through no
      binding, so `c in q2` abstains, in a sentence naming the renaming, where it is F.
      (3) MI2 (and MI4): one `=` and one `default` under one name from two general types (Q2's `L =
      50.0`, Q3's `L default = 60.0`, on the usage itself or through a general) are read nowhere,
      though L is 50; read the `=` value. Since 1a8f9ca the same holds for two values that AGREE
      under a usage's binding copy or a valueless `:>> L;` (ME6's `part s : Q2, Q3 { bind p.load =
      L; }` over both `L = 50.0`; ME9's `part def S :> Q2, Q3`; md_*_same and md_*_samedef). Before,
      they read P's default 1 on every surface; now the agreeing pair is a `same` clash, the default
      gives way, and s's L and p's load abstain. Read the agreed value through the copy. ME9's own,
      Q, Q2 and Q3 rows read T/T/T/? beside the two refused instance axioms of m2. MI1, MI1D and MI3
      (two different `=` values) are a contradiction, rightly read nowhere, with the `#clash` filed.
      (4) An assert typed by a constraint definition is read by no surface. Its own row is filed
      nowhere, so a contradiction it makes with a value written with `=`, or with an untyped
      asserted equation over the same default (which keeps its reading), is silent. Where its
      definition's body holds an equation, every default it names gives way BY FEATURE in every
      instance. That covers CD1, CD13, cd2-cd9 and cd21-cd23. Since 1a8f9ca it also covers a body
      name read through a parameter (TP1's `x.load == 50.0` over `in x = p`, TP5's `bind x = p`: p's
      load; where the rest names nothing there, every feature below p) and the parameter values of a
      constraint usage the assert specialises (TP2's `assert constraint ea :> e0;`). Q's own rows
      abstain for an assert written in `part q : Q`, and every P's for one naming `p.load`. Every
      valueless feature it names, with what the model states from it, is no design freedom to the
      numeric surface. Read the definition's body with the parameters' values, per instance.
      (5) A name reached through an import or an alias, a qualified `Lex::K` and a non-attribute
      lexical feature are still left unread.
      (6) Wording only (every row abstains):
      - EB4's r2 row, read through the package, says "a binding" and does not point at the `#bind`
      finding (`componentConnectors` finds no enclosed binding from that root).
      - EB4's `c in R::q::p` quotes "`bind q.p.load = L` of EB4::R", a form not in the text (written
      `bind p.load = L` in R::q).
      - MI1's numeric sentence says L "is left free … no value states it" where two values do.
      - CD1's `c` and `topF` numeric sentence says "the solve did not converge … a point that misses
      an equation" for a value a typed assert makes unreadable.
      - CDQ's `t2` check sentence ("… gives way to `assert constraint e : Eq` in CDQ::q … and is not
      read by this tool, has no asserted equation, and nothing specialises it") contradicts itself,
      and TP1's ("… is not read by this tool and nothing specialises it") runs on the same way.
      - ME9's `P::c in S::p` says only "a referenced value is unknown", not the agreeing clash.
      Probes: per-instance-rest-scratch/branch-review2/p (cd1, cdq, eb4) and branch-review/p (tp1,
      me9).
      (7) A value W writes that names a part by the name an instance's renamed redefinition replaces
      (RB10: W's `m = pp.load` over `ref part pp : T0 = top.a`, w's `part top2 redefines top {
      attribute :>> L = 50.0; }`). `top.a` resolves nothing in w, so `W::pF in w` abstains on all
      four surfaces ("a referenced value is unknown"), and `w.m` read from outside reads ?/?/F/? as
      at 3c54ae0.
      [per-instance-rest S1, S3, review]
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
- [ ] **Say the same thing about a bare literal in the note and the row.** After a carried value is
      read in the filled feature's declared unit, the `U3` note still reads `refuted … (5 vs 10 in
      M, coherent SI)` beside a verdict the unit reading reached; the literal and SMT notes of a
      carried value also lack the `(x vs y in M, coherent SI)` clause and print the end copy with
      unit null, and the value-source clause prints a converted value without its unit (`load =
      5`). Pre-existing for `U3`; the rest is display only, with A-M2. [O2 S6]
- [ ] **Match a binding into an instance by path through a value too (optional, low).** Since
      per-instance-rest S3 a binding written in an instance makes its usage a group only where it
      reaches a path the relation reads. What a value the relation reads reads is still matched by
      feature: `m = t.extra * 2.0` beside q2's `bind p.s.extra = E` (BA7) forms an extra group of
      rows read alike. That costs rows, never a verdict. [O2 S4, per-instance-rest S3]
- [ ] **Contain a throw in a relation's own context walk.** Since per-instance-rest S3 these become
      `internal` refusals: a throw while `instanceGroups` groups a usage, in a `groupGoalRows` row,
      or while `equatedParts` lists the asserted equations no surface reads (tested through
      `instanceIndexSeam`). A throw in `DefiningEquations.readingContexts` still ends the check;
      `instanceGroups`, `readInContexts` and the obligations lane's `instanceRows` all ask it. A
      failed asserts listing is kept for the revision, so every row abstains until the next edit,
      even after a transient throw. [per-instance-rest S3, A.2.9]
- [ ] **Decide whether an untyped asserted conjunction defines its equation's feature.** `attribute
      L default = 1.0; assert constraint { L == 50.0 and L >= 0.0 }`: decision 14 makes the bare
      equation `L == 50.0` the definition of L over its default, but the untyped rule reads the
      default of a conjunction that holds an equation and reports the assert violated (cl F/F/F/X in
      `rv-s3fit/p/cd2.sysml`'s U). If decision 14 covers conjunctions, that F is a false verdict on
      all four surfaces; if it does not, the default stands as for an inequality (U5). The typed
      rule already abstains on such a conjunction (CD23), which is weaker under either reading and
      never false. Awaits the maintainer's ruling on decision 14; until then the F stays and is
      pinned. [per-instance-rest S3]
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
- [ ] **Say when a Save applies typed text over a field's change in the two cases that stay silent.**
      The in-browser Save, the offline Save and Export say so since `ui-small` S3 (`fieldOverTyped`,
      `over-changes`). (1) A Save to an attached Google Drive file with unsaved changes (`runSave`
      then `driveSave`, `payloadNow`) applies the text over a change `typedTextFirst` kept back and the
      strip says nothing: it needs a Drive-strip message that survives the save's own notice. (2) The
      guard's Save (`saveBeforeReplacing`, the Save and continue of New, Open, Import, Switch branch,
      Merge or Join room) does the same and says nothing, because the guarded command replaces the
      model next: it needs a sentence that does not promise one Undo (it takes two). [ui-small S3]
- [ ] **Keep the project's name across an undo of an apply.** `undo` and `redo` (`src/ui/store.ts`)
      re-derive `projectName` from the first package (`deriveProjectName`). After a package rename,
      or after an Undo of a Save's apply, the next Save writes another project and can overwrite a
      saved project of that name. Probe: New('NewModel'), rename the package to Drone, Save, then
      typed text, a field change, Save, Undo, Save leaves the open project holding the text-only
      version and writes the other project. The S3 note now invites the Undo. Optional one-line fix:
      keep `projectName` across undo and redo of an apply. [ui-small S3, review]
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
- [ ] **Divide the text step and the edit's own task on the drone-swarm v9 model.** Since `ui-small` S4
      an edit's recompute yields to the page between its steps (`recomputeSteps`), but three tasks
      stay whole. The serializer (`serializeUserModelSignals`, `src/text`) writes the one root in a
      single pass: 40 to 90 ms at load about 4, up to about 180 ms at load 25. The edit's own task
      (the undo snapshot `model.toJSONWhere` plus the SDK update) takes 54 to 109 ms warm, up to about
      296 ms at load 25, and 238 ms on the session's first edit when cold. The last step (the results
      set plus the synchronous `buildDiagram`) takes 90 to 156 ms at load 25. Fix: a step-wise
      serializer, or moving the undo snapshot and the diagram build apart. Not done by design:
      incremental validation (unsound for cross-element rules) and the text in a worker (a model
      transfer per edit costs about what the write does). Done when no task of an edit and its
      recompute is over 200 ms at load 25. The `palette-checks` step 4 bound (200 ms) has a thin
      margin on slower CI cores: if the first CI run is red, make the assertion relative. [ui-small
      S4, review 2026-10-14 D-3]
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
      Also weigh the rows filed since per-instance-rest that report `target-by-specialisation`
      (report-only). (1) An instance that rebinds a reference whose value a binding of the
      referenced part carries (V8X, RB9: 50 from t50's L through T1's `bind a.load = L`), and the
      same read through a binding or past 16 values (RBB1, RBB2, RBD16N: `w::m = 50 misses W::pF`);
      the same binding-carried read through a part redefinition reports `constraint-by-instance`
      (V8XC's q), as does a renamed end (R38). (2) A `satisfy` context whose satisfier's value a
      binding of the definition carries from the instance's own member (NC4: sys's K through W's
      `bind p1.load = K`; pre-existing for NC4P at 3c54ae0). The NC4 unit test no longer pins the
      code. [per-instance-rest S1, review]
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

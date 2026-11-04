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

- [ ] **Exercise a z3 death in a real browser.** The USER-GUIDE says a z3 that dies mid-session ends
      that Run with a `checks/internal-error` row and the next Run starts a fresh z3, 'not yet
      exercised in a real browser'; the bridge's `onAbort` rejection of a worker-thread trap is
      covered only by the fake, and the page-side hang is unverified. Add an E2E (or a manual probe
      recorded in UI-ROADMAP) that kills the module in the page and runs again. The old N6 S4 clause
      that a hang keeps the async mutex held until reload is gone (the lock is per module now). Also
      make the soak repeatable from the repository: the header of `test/campaign/z3-soak.soak.ts`
      carries the invocation. [z3-bump, review]
- [ ] **Narrow the literal engine's contradiction reach to the instance the violated assert reads.**
      Since S1, table rows with a decided ref abstain on the literal engine as they do on SMT
      (T/X/T/X). An assert in one instance reads the symbol shared by every instance it does not
      tell apart: refute-r1 P::c and q2's p, R1D, Sh7, H1C, H1F2, R1U, Q4B, PIN2/3/5, PA, PA4,
      PL2/5T/6/7, HQ, HQ2, SFW, N4T, N5, H5B, T4D::c5, SP2::kq and R27F::Q::c. A sum also ties a
      sibling (CVSIB::tb). Narrowing needs the SMT instance split (plan section 1.5). Done when
      those rows read their ref on the literal engine and no contradicted row reads decided.
      More probes (contradictory-models): in `bound-vc-inst` k2 (q2's L = 5) and kr (R's M = 3),
      `bound-vc-spec` VCS::k (`Q2 :> Q { :>> L = 5.0 }`, T/X/T/? with SMT undecided) and
      `h5-rb5-ineq` RB5I::top2 (T/T/T/X) the literal engine reads the same feature in another
      instance as one value with the violated one, though the relation's own instance meets the
      assert. A pair or a violated binding in one instance also makes the literal engine, and the
      SMT engine file-wide, inconclusive on relations about another, consistent instance:
      review-2026-10-14/wave3-probes/contradictory-models/g5.sysml (`part a : P` consistent, `part b
      : P { assert constraint ck { K == 60.0 } }`: `a.L == 50.0` is `?` on the check and X on the
      literal engine and SMT), g4.sysml (p3 consistent, t3 `?`/X) and a1.sysml (q2's `L = 5.0` meets
      the assert, yet k2 is X). The numeric surface says 'the solve did not converge' for the paired
      equations instead of naming the contradiction. All sound, none false. [contradictory-models
      S1, S3, review]
- [ ] **File a row, and say so in contracts, for a requirement whose only body is an assert.**
      contracts no longer says "prose only" for R1::R, R1::r and RU::r: it names the asserted body
      as a fact of the model, not a clause (wording-pass S1; USER-GUIDE status-column paragraph
      reworded). R1::r already files a no-formal-clause row on obligations and verify, with a
      sentence naming the assert. Still open: the definition R1::R and a requirement usage whose
      only body is its own assert (RU::r: `requirement r { subject s : P = x; assert constraint ca {
      s.L == 50.0 } }`) file no requirement row, because obligations.ts adds the asserting owner to
      withClause (:619/:655). Filing one makes `verify` exit 2 where a model whose other obligations
      all discharge exits 0 today, and the origin is marked UNCLEAR: it is a policy decision (is an
      assert-only requirement a requirement with no formal clause, like a prose-only one?), so it
      awaits the maintainer. [wording-pass S1]
- [ ] **Narrow the abstention over two disagreeing asserted equations (optional).**
      contradicted-value S2 leaves undecided every reading of the feature, in every instance, and
      every value an asserted relation reads beside it (`contradictedTaint` taints by feature): one
      equation in P and one in `part p : P { … }` leave p2 : P's L, which P's equation alone
      defines, undecided (`q5-f1`'s `u50`); `assert constraint { L + N >= K }` leaves K's stated
      value undecided; and a pair found in P (`L == a * 2.0`, a = 30, beside `L == 50.0`) stays
      undecided in a usage whose `:>> a = 25.0` makes the two agree. It also abstains where it
      cannot compare: a bare `L == 50.0` beside `L == 50.0 [kg]` (`q5-unitagree`, T on all four
      surfaces at f1f5ca5), and a side over a name a binding joins. Sound, but readings are lost.
      Taint only the instance where they meet, keeping the feature-wide taint where they meet in the
      feature's owner; read a bare literal in the feature's declared unit. [contradicted-value S2]
      The FMI `start` and the Solve measure value inherit this breadth (text-order S2): `part def P { attribute load; assert constraint c1 { load == 1.0 } }` with `part def Q { part p : P { attribute :>> load; assert constraint c50 { load == 50.0 } } }` takes P::load's start from 1 to the type default 0 (marked in the variable's description) while only an instance elsewhere contradicts it (also r8-redef-novalue-assert-dflt, S4_N_PP, S4_N_PU). A literal written beside a contradicted pair keeps its start in both orders (`attribute L : Real = 5.0;` beside `L == 50.0` and `L == 60.0`); decision 14's removal in wave 3b settles whether an asserted equation overrides a written value for an export. [text-order S2]
      A pair on the two ends of a binding (contradictory-models S3) taints both features in every
      instance, as a pair on one feature does: in `part def P { attribute L; attribute K; bind L =
      K; assert constraint cl { L == 50.0 } } part p : P { assert constraint ck { K == 60.0 } } part
      p2 : P;` p2.L, which only P's equation defines, reads ?
      (review-2026-10-14/wave3-probes/contradictory-models/c6-use.sysml). The same holds for a pair
      filed at P beside the larger set at a specialisation P2 (G2). [contradictory-models S3]
- [ ] **Read a usage that subsets a feature an instance reads otherwise in that instance.** Since
      subsetting-pass, every row read through W's `part p2 :> p1;` abstains wherever any context of
      W reads p1 otherwise (`subsettingOtherwise`, `subsettingTaint` in
      src/semantics/defining-equation.ts). So does every row read in such a usage (`T1::tc in W::p2`
      for `part p2 : T1 :> p1;`), and the own row of a relation nested in its type
      (`subsettingAround`: TC8's `T1::sub::tc`, for every T1's sub). The taint is on the usage, not
      on the instance, so true rows abstain too: W's own rows (sa7's `W::c`, T at W's values); a
      sibling `w0 : W` that changes nothing (`w0.p2.load <= 5.0` ?/?/?/? on all four surfaces, its
      sentence naming w); an instance that changes only a feature of p1 that nothing reads through
      p2 (V7: `part :>> p1 { attribute :>> tag = 9.0; }`); TC8R's `T1::sub::tc` (`v >= 5.0`, F at
      T1's own values at 84fb971) for T1's own sub; a package's `satisfy RF by v.p2` for a `v : W`
      that changes nothing (O2); a requirement's own row where only a `satisfy` context that
      abstains for its own reason lists the subsetted feature (RQ4); R's own row standing for
      package `satisfy R by p50` / `by p1` over R's `part q :> s;`, which file no row of their own
      (SA3S, RE3); `refine` and `fault-tree`, which go from decided to inconclusive (RFN: `satisfy
      Top by w` reads `s.p2.load` beside W's `satisfy RF by p2`; 84fb971 gave `refined` with exit 0,
      and `{RF}` as a single point of failure with a confirmed witness and exit 1, both true; both
      now exit 2, because the unread-binding refusal reaches those lanes); and, since the asserted
      step, the first link of every other name of an asserted relation that reads through any
      satisfierTaint element (AE3: a package's `w.x == w.p2.load` taints w, so `w.p1.load`, true F,
      abstains; AE4: W's `p1.load == p2.load` taints W's p1). Reading them needs the walk to read a
      subsetting usage in an instance as one of that instance's subsetted feature (as it re-roots a
      bound subject), keeping its own features, with a value both state read as two values; and the
      asserted step to taint the defined feature rather than its first link where that feature is
      not a shared definition feature. Done when sa7's `W::c` reads T, `W::c in w` F, `k` F and
      `w0.p2.load` T, and TC8's `T1::sub::tc` reads T for T1's own sub and F for w's p2's. Sound,
      only weaker. [subsetting-pass S1, branch review]
- [ ] **Report a model that contradicts itself through a subsetting usage.** Take W's `assert
      constraint a { p2.load <= 5.0 }` over `part p2 :> p1;` beside w's `part :>> p1 { attribute :>>
      load = 50.0; }`. Every w's p2 is one of w's p1s, so the model contradicts itself. Since
      subsetting-pass, `a`'s row abstains (it read T), but the SMT axiom still reads W's own p2 (1).
      So other rows are decided (v11: `w.x <= 5.0` T, `w.x >= 5.0` F) where decision 1 says the
      axioms are inconsistent, and nothing reports the contradiction. The model with `assert
      constraint a { p2.load >= 40.0 }` holds for its only instance w (50) (AI, in
      subsetting-pass-scratch/wbr/ai.sysml). There the check abstains on `a` (?/-/?/-) and strict is
      OK, while SMT reads W's own p2 (1) and reports inconsistent-axioms on every row (`k`, `k2`
      T/T/T/X): an X the check no longer explains. [subsetting-pass S1, branch review]
- [ ] **Spell a chained subsetting target as written in the subsetting sentence.** The Subsetting
      now keeps the path as written (`attrs.chain`), the sentence says "subsets `q.p1`" and Save
      writes `q.p1`. Left: the instance test still runs in Q for `part p2 :> q.p1;`, not in W with
      the path `q.p1`, so it over-abstains where only an unrelated Q instance changes p1; running it
      in W is a verdict-moving step (generator with a hand oracle first). Only a path with a `.` is
      kept; `Q::p1` is not. [subsetting-pass S1 review]
- [ ] **Run the palette's solver checks in the page on the hosted site too (optional).** Since N6 S4
      the dev and preview servers send `Cross-Origin-Opener-Policy: same-origin` and
      `Cross-Origin-Embedder-Policy: require-corp` (`SYSPROSE_NO_ISOLATION=1` turns them off for
      local Google Drive testing), and the palette's five solver checks run z3 in the page there and
      land in the Checks tab. The GitHub Pages site cannot send the headers and decision U14 ruled
      out a service worker, so on it they keep `not here` with the copyable command. Done only by
      moving the model site to a host that sends the headers, which would break the Google Drive
      sign-in popup and Picker iframe there too. Awaits user decision U14 (host): whether in-page z3
      on the hosted site is worth that cost. [N6 S4]
      DECIDED 2026-10-23 (U14): decide after Drive (U16); until then the hosted site keeps `not
      here` with the copyable command.
- [ ] **Stop an in-page solver check from stalling or tearing the page.** N6 S4 runs the five solver
      checks in the page behind a queue and a mutex. Left: Cancel drops the answer but cannot stop
      z3, so the check ends at its own time budget and a Run started meanwhile queues behind it; a
      model edit during a run can give a torn read across awaits (the result lands against the
      click's revision and shows stale; documented, not snapshotted); a z3 module that dies in the
      page is unverified in a real browser (the lock is per module since z3 5.3.1); an in-page
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

## Per-instance readings — follow-ups and known-false rows

Opened by the per-instance readings feature (ROADMAP item removed at step F9). What follows is what
its four surfaces (the check, the literal engine, the numeric surface and the SMT engine) still
abstain on or read false in the four-surface table
(`test/integration/verification.differential.test.ts`). The branch `h5` (merged by `755352c`) made
an asserted equation override a `default` on every surface, read definition-feature and part-valued
bindings, deleted the eleven `I7_ALLOWED` entries of the old clash, and pinned what it left open.
Since per-instance-rest (merged by `ca4992c`), `KNOWN_FALSE` was empty (it held 20 rows at 3c54ae0), and
redefinition-target (merged by 64d149d) pinned six rows in it again, tagged `NO STEP`, for a feature that
redefines two features of one line (MU, MUR), and fence-readings (merged by 9ddd2c2) withdrew them: it is empty. Since
default-stands (decision 14 amended 2026-10-22) a `default` stands against every assertion; only a
feature without a value is defined by an asserted equation. The residuals are the entries below. The
false verdicts the review of 2026-10-14 found in the per-instance code itself follow under their own
headings.

- [ ] **Read a local equation where a binding gives its other side a value (PA, PA4, PA2, PA0).**
      Awaits a ruling. Unchanged on e2d104d: `P::qa in p2` reads ?/-/?/- (ref F), P's own `qa` reads
      T/-/?/- (the numeric surface abstains over the bound M), `top2` reads T/X/T/X, and the `#bind`
      row F/-/F/-. Reading qa at p2 as F takes M as the binding's 9, while the `#bind` row F takes M
      as the equation's 2. The model states both (A.5, U11: all abstain), so deciding it files two F
      rows that claim two values for M. Rule either that the ref of `qa in p2` is ? (A.5, a pin
      change), or that a binding's `=` value is M's value there and the equation a check. Probe:
      reads-pass-scratch/pa4.sysml. [O9 S2, default-stands S2, reads-pass]
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
- [ ] **Name an unnamed nested redefinition's context row alike on every surface.** A context that
      is an unnamed redefinition is filed by element id (`... in q::«PartUsage»`) on the check and
      numeric surfaces and by instance path (`q::p`, `q::r`) on the literal and SMT engines (RF,
      RF3, CI1, the dt_*_deep files). The four-surface harness therefore keys them as two rows, each
      abstaining or agreeing, so a unified name needs the check's context rows to carry the instance
      path (their ids, anchors and the numeric `context.contextId` change) and a re-pin of about 40
      table rows. Low. The RB5 duplicate (two check rows `P::c in q1::p`) is fixed in naming-pass S1
      (h5-rb5p). [O9 S2, naming-pass S1]
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
      Since default-stands S2: item (1) closes (GA6 `qa` and `pa in Q::p` and GA12 `qa in q` read
      ?/-/?/- with ref '?'; GA6/GA12 `pa` and GA12 `qa` read T/-/T/- with ref T); item (6)'s GW
      example is obsolete: `pl in q2` reads T/T/T/X, ref null.

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
      Since default-stands S2: item (4)'s '(which keeps its reading)' is obsolete: an untyped
      asserted equation over a default is checked against it, and the lexical reading also reads a
      default an assert names as its value (LP1, SLD, SLO, SLP).
- [ ] **Read the equation an asserted conjunction gives on the numeric surface (optional).** Since
      text-order S1 a valueless feature that an asserted `L == 50.0 and L >= 0.0` constrains is no
      design freedom, so the numeric surface reads `t50 { p.L == 50.0 }` unknown, which SMT proves,
      and t1, t60 unknown, both F. The check and the literal engine abstain too. Reading the
      conjunction's equation part as L's definition would decide them. Pinned: order-s1n-and,
      -s1kn-and, -s2enc-and, -s2spec-and, -s2use-and and their -rev twins. [text-order S1]
- [ ] **Solve the plain equations of a design component jointly over all roots (optional).** Since
      text-order the curved-root rule withholds `x * x == 4.0` beside `x == 2.0` in both orders
      where one root agrees (it read t/t before); a finer rule would solve the plain equations
      together over every root and keep the agreeing one. Sound as is, only weaker. [text-order S1
      review]
- [ ] **Remove the last order dependences of the numeric solve (after numeric-curved).** The guide
      says 'bar four cases'. Each abstains in one text order and reads a value in the other, never a
      different verdict: (a) the digits of a value: a pin written to ten digits (`x ==
      0.000003000000001` beside `2.0 / (7.0 * x) - 95238.0952 == 0.0`) reads t/t equation-first and
      ?/? pin-first (review-2026-10-14/wave3-probes/numeric-curved/fix3-pm/D1, D2), and a value
      taken through an affine link by finite differences, accurate to about 3e-11 (fix3-pg/G4 reads
      ?, G3 and G5..G8 read t); (b) a zero divisor at the Newton start (`c0 { x / y == 3.0 }`, `c2 {
      w / y == x }`, `c1 { x >= 0.0 }`: qa0..qa5 in review-2026-10-14/wave3-probes/text-order/); (c)
      two asserted equations sharing a root, written in a usage (`a0 { x == 6.0 / (x + 1.0) }`, `a1
      { x == -3.0 }`: G8101x099); (d) `y == y` beside `y == 0.5`. Fix: polish the affine Newton step
      or judge agreement both ways (a); start the root-find away from a zero divisor (b).
      [numeric-curved]
- [ ] **Abstentions left in the numeric solver (rollup; sound, only weaker).** Each reads unknown
      where an answer exists; none gives a wrong answer. (1) designReadings withholds the whole
      component a curved equation links, where only what its root reaches need be withheld (`z` of
      `dz { z == 5000000.0 * q }`, `s == 4.0` over a stated `s = x * x`, every feature of a loop of
      definitions with more than one root). (2) A lone curved equation is still published at the
      root found (`x * x == 4.0` alone: the FMI start, a measure of effectiveness). (3) A relation
      over a multi-root component that holds, or fails, at every root reads unknown (E4, n5-damped,
      y4); `solveFeasible` reads undecided where it was infeasible and the analysis report's
      `feasible` should then read undecided. (4) The freedom analysis's row order among the model's
      own equations (G33x067, CV10). (5) A coupled affine subsystem beside a square is not seen as
      fixing its features (`c0 { a + b == 4.0 }`, `c1 { a - b == 0.0 }`, `q { z == a * a }`, `k { z
      >= 5.0 }` read all ?, b635385 read k F; a ring `x{i+1} == 0.5 * x{i} + 1.0` beside `z{i} ==
      x{i} * x{i}`). (6) An odd power is read as curved (`x ^ 3.0 == 8.0` beside `x >= 0.0` and `x
      <= 1.0` reads ?/?, b635385 read T and F). (7) A root in the same gap as its pole between two
      of 0 and +-2^k is not found (`1.0 / (x - 5.0) == 2.0`: 175 of 744 sweep equations). (8)
      `solveFeasible` starts its descent at one root of a curved equation: `x * x == 4.0` beside `x
      <= 0.0` reads undecided in every order though x = -2 is feasible (CV1, F11x005). (9) A curved
      plain constraint beside another left unused is withheld (`x / y == 3.0` beside `y == 2.0` and
      `x == 6.0`). (10) Cost: `fixedByOthers` is rebuilt per curved equation, quadratic per
      component (about 1.2x b635385 on a chain of 400 with a curved leaf per member), and
      `optimize()` re-solves without a cache. (11) A fenced head carry (fence-numeric): numeric
      reads an assert's slot at the assert's own value where the check and the literal engine
      abstain on the slot (E1Q `c2T`, `fix`: pinned `stand-gw-e1-slot` with null refs; probe
      fence-numeric-scratch/p/path0.sysml); for a valued L through a package head (V2/V4/V5) numeric
      and SMT read p3.load and M at the written 5 where the check and the literal engine abstain, a
      surface disagreement that may be a model solution (probes fence-numeric-scratch/rev/v2.sysml,
      v4, v5; a sound fence needs `contracts.ts`); the numeric abstention uses the generic left-free
      sentence, not one naming the head binding as the SMT lane does. (12) An FMI parameter or input
      whose stated value the tool cannot evaluate (`Bb = A + 1.0` over a valueless A, `1.0 / 0.0`)
      is held free (NaN) with the note 'the model states none this tool reads' (probe
      fence-numeric-scratch/review/fmi2.mts, cases `expr` and `big`). Probes:
      review-2026-10-14/wave3-probes/numeric-curved/ (lens1-r5, worklist-probes, nc-rereview2-p1,
      sweeps/), review-2026-10-14/wave3-probes/text-order/. [numeric-curved; fence-numeric]
      fence-numeric2: (a) double roots read ? where base read t (`x * x == 0.0`, `(x - 3.0) ^ 2.0 ==
      0.0`); (b) a tautology held exactly 0 or 1 by a quotient or power reads ? (`0.0 / x == 0.0`,
      `x ^ 0.0 == 1.0`) and solveFeasible goes d1f1 to d0f0; (c) two stated values further apart
      than 1e-8 of their size but closer than the 1e-6 gate read ? on both rows (`x == 1.0000001`
      beside `x == 1.0`); (d) a guarded divisor refuses the witness even when the branch is not
      taken; (e) dividesByNearZero is absolute in SI, so a free divisor below 1e-6 loses its witness
      (`x / y == 3.0`, y in [1e-7, 2e-7]); (f) a lone no-root equation reads ? and solveFeasible
      undecided (was decided-infeasible through a false premise; 168 generator models). Probes:
      fence-numeric2-scratch/review/. [fence-numeric2] fence-numeric3: (g) a legitimate root reached
      through a quotient or power that the solve resolves only to about 3e-8 relative or worse reads
      unknown where base read imposed (the joint correction exceeds 1e-8 of the size), e.g. `v0 ==
      1.0 / x` chained ten links by `* 2.0` to a sink of 2.0 (root x = 512), the same chain to sink
      0.002, chains of 20 to 60 links, and a 100-link chain to sink 2.0; fix: polish the Newton
      point before the joint test; no 637-corpus or v9 model is affected. A component of more than
      120 linked equations that holds a quotient or a power is not judged together and reads unknown
      for that component throughout, even at a true root; for a chain of that size that has a root
      the solve reports `converged false` (the app shows 'Solve: did not converge') while every row
      still reads imposed and solveFeasible is feasible; the USER-GUIDE sentence is the only place
      it is described, and no corpus or v9 model is hit. Item (f) also covers the chain shapes.
      Probes: fence-numeric3-scratch/rchain10-2.0.sysml, rchain10-0.002.sysml, rchain20-2.0.sysml,
      rchain30-2.0.sysml, chain100-2.sysml, chain150-0.sysml (no root), review/big-chain-130.sysml.
       fence-numeric4: (a) a bind end under an unread scope (an `order` scope) withholds that end
      and everything joined to it by bindings, even where an end has a value elsewhere; only an end
      with no stated value of its own is made unreadable, and a valued end keeps its own seed
      (fence-numeric4-scratch/models2/n2-keq-fwd.sysml, F correct). (b) The withheld set joins by
      raw end ids, so a binding written at package level through a differently spelled copy of the
      same end is not joined to the component and could keep a decided reading; no probe found one
      (models3 pkg rows are all ?). (c) A feature that states a value with `=` and is bound into an
      unread scope keeps its own seed and reads the same on the check, literal and numeric lanes; a
      binding to a valued feature joined to another end still reads a decided T beside a
      contradictory file reading (probes rev/m/valk-eq-fwd.sysml, rev/m6/dfl-L2-fwd.sysml). It is
      consistent across the lanes and not new. [fence-numeric3; fence-numeric4]
      numeric2-pass: (h) a package head's pair whose side is an expression or a `default` (`L = 2.0
      * K`), whose end is deeper than one segment below the definition, or whose instance sits in a
      definition that redefines the head (not a usage), files no binding row and is read as before
      (probes numeric2-pass-scratch/gen2 D56-D58, t5/hc3.sysml); (i) a package head whose binding
      sits in a third package that spells neither end (Defs/Vals/Bind; `package Bind { import
      Defs::*; import Vals::*; bind P::load = L; }`, probe numeric2-review-scratch/nb/h.sysml) files
      no head-conflict row, so c4 reads the instance's own value (holds-at-values on the literal
      engine, proved on SMT, sysml-check silent), identical to 514f547 and not widened, the proper
      reading staying open with fence-pkgbind; (j) the literal engine answers X on any relation over
      a value a reported package-head conflict joins, as it does for every other violated binding
      (probe t5/hc1.sysml). [numeric2-pass]
- [ ] **Read `assert not constraint c { ... }` as the negation.**
      Since numeric2 S1 a negated clause (also `require not`, `assume not`) whose body is one
      expression is read as the plain clause over `not (body)` on every surface, the same clause
      `assert constraint c { not (...) }` writes, and the save writes it back as `assert not
      constraint c { body }` (the element keeps `negated`; pinned neg-assert-h1/-rev, h2/-rev,
      family; hand oracle 280 models x both text orders: 0 wrong decided cells, 0 differences from
      the workaround spelling). Still refused with `mapper/negated-assert-unread` (the load
      degrades, the checks abstain, the save keeps the text): a negated clause that names a
      constraint with no body (`assert not constraint c;`), one that specialises a constraint
      (`assert not constraint c :> K { ... }`), `assert not requirement r { ... }`, one whose body
      holds members (`assert not constraint c { attribute y = 2.0; load > y }`; pinned neg-assert-
      refused), and one whose body holds a comment or `doc` member (`assert not constraint c { /*
      note */ load > 10.0 }`). Done when those are read: the negation of a typed or named constraint
      needs that constraint's body judged under `not`, and a members body needs the members in the
      negated scope. [contradictory-models S1 review; fence-assert-not; numeric2 S1]
- [ ] **File a violated row for the contradiction SMT reports in UB6 and W4o, so the literal engine
      can seed from it.**
      Since numeric2 S1 the check files the binding's row at an instance whose own `=` constant
      differs from the one a package's binding on a definition's feature joins it to (W4o's p4:
      `headBindingConflicts`), so the literal engine marks W4o::c5 inconclusive (T/X/?/X; pinned
      w4-plain, w4-unit, head-conflict*). What is left is unit-blind-assert UB6::cT: q's asserted
      `p.load >= 1000.0` reads the 50 kg a binding carries into an untyped load as 50 in SI, where
      it fails, and the check abstains on that pair by design (a bare number has no unit to compare
      in), so it can file no violated row; the literal engine's T on cT is right (K is 25 kg
      wherever it is read) and SMT's X is its SI reading. Done when the maintainer rules the row
      permanent (recommended: a violated row would claim a comparison the check refuses to make) or
      the check reads the pair. [contradictory-models S3; numeric2 S1]
- [ ] **Read two asserted equations on the two ends of a binding that reaches an end through a part
      only where they meet (the scope decision).** fence-readings S2 made the two readings abstain
      together on every surface, so the entry's first done-when holds and is pinned
      (`bind-through-part`, `u50`). What is left is precision only: the taint
      (equatedTaint/spreadTaint) is per feature on all four lanes (check, literal, numeric and SMT),
      so a `part p2 : P` beside the meeting instance, and every other P, stay undecided on `L ==
      50.0` once such a binding exists. Taint only the instance where the two equations meet (q's p
      and q's M) instead. That is a change across the four lanes, far over the 120-line fence, and
      needs no user decision to stay fenced. Probes:
      review-2026-10-14/wave3-probes/contradictory-models/c6-nested-swap.sysml,
      review-2026-10-14/wave3-probes/fence-readings/s2/bq.sysml. Done when only the meeting instance
      abstains. [contradictory-models S3; fence-readings S2; fence-numeric4]
- [ ] **Give the specialisers of a usage-owned group one canonical order (optional).** The
      group-order fence of fence-readings S1 is a stable sort by usage-ancestor count in
      `contextsUncached`; `specialisersOf` itself and the context-key dedup have no canonical order,
      so two contexts with equal nesting and the same reading key still file the first by text
      order. Low: both rows read the same today. Probe:
      review-2026-10-14/wave3-probes/text-order/65a411ed2025-e5-renamed.rev.sysml. Pins:
      e5-renamed-rev, e5-renamed-silent, e5-renamed. [fence-readings S1] Tried 2026-11-02
      (subsetting-pass S1): a tie-break by qualified name in `contextsUncached` (listed contexts
      given back in text order) is NOT sound. It moved the `DM3-diamond-own-redef` probe: the rows
      `P::c in DM3::Q2::«PartUsage»`, `Q::p` and `q1::p` appeared or went, and `DM3::P::c in
      DM3::Q3::p` read T on the literal and SMT lanes where the truth is F (a new false verdict). An
      unnamed context (`part :>> p : P2`) has no usable name key; a canonical key would have to be
      the effective name plus the reading, with DM2 to DM4 and the e5-renamed probes re-run. Probe:
      test/integration/verification.differential.test.ts DM3-diamond-own-redef. Witness of the order
      dependence on base: `part qb : Q2; part qa : Q2; part def Q2 :> Q { attribute :>> K = 25.0; }`
      lists `qb` where `Q2` is listed when Q2 is written first.
- [ ] **Abstentions left in the readings (rollup; sound, only weaker).** Each reads unknown where an
      answer exists; none gives a wrong answer. (1) The subsetting component fence is per usage, not
      per instance: the usage an instance redefines itself (w.p1 beside `p2 :> p1`), every instance
      of what the component's usages are features of, and a package subsetter's subsetted usage
      abstain even where the reading would be right (pins sub-rv1-diamond k2, sub-sa7 k1, the two
      satisfy rows of sat-nested-nq3; corpus model e1-subset); a sound per-instance skip needs
      per-context answers. (2) A bridge, chain-target or package fence fires on any member that
      states a value, at any depth, or whose type states one, even where the values agree. (3) A
      line of parts, a merged line and a twice-stated feature fence every name they reach (dependent
      attributes included); `Y :>> X` beside any statement of X abstains in both orders; the nested
      content of a twice-stated part abstains even where identical; `:>> M, N = 6.0` over a general
      type's `X :>> M, N` abstains though the values agree
      (review-2026-10-14/wave3-probes/fence-readings/p/m4.sysml, rows uM and uN). (4) The ends of
      every type of a connection that connects features abstain, whatever the connected feature
      states (pin conn-end-redefined). (5) A satisfy written outside its definition is not resolved
      through the owning namespaces: NQ1, NQ2, NQ5, NQ7 abstain instead of filing w's F row as NQ3
      does (widen the mapper's sourceChain to `::` paths and resolve in writtenSatisfier,
      satisfierOtherwiseOf and the satisfy-context listing;
      review-2026-10-14/wave3-probes/fence-readings/s2/nq1.sysml, nq2, nq5, nq7). (6) A subsetted
      feature is read as the union of its own value and its subsetter's when p1's upper bound is 1,
      abstaining when it is unstated or above 1 (needs a multiplicity ruling; also settles
      e1-subset; review-2026-10-14/wave3-probes/fence-readings/s2/rv1.sysml, rev/rv-spec.sysml,
      rev/rv-q.sysml). (7) A feature that redefines two features of one line is not modelled as ONE
      feature (its two written values as a contradiction, or as one value: a decision on what the
      tool reads; review-2026-10-14/wave3-probes/fence-readings/s2/mu.sysml, mur.sysml, mu1.sysml).
      (8) An own-sibling redefinition is not read as one hard validation error
      (review-2026-10-14/wave3-probes/fence-readings/s2/os-a.sysml); models that contain one still
      decide cells, the model being invalid and flagged. (9) Bindings: Q's own generic row (P::a2 in
      Q::p, no value anywhere) and an instance nothing gives a value (q3) stay ?/-/?/-; a derived
      chain deeper than four values, or whose names the context does not denote, is not listed as
      bound-valued and its row is not filed (wave3-probes/contradictory-models/bound-vc-derived
      family, i5.sysml, i4.sysml); every binding read through an instance of a definition owning a
      capped end (past 48 usages since instance-pass) is past the cap and abstains on the check and literal engine, including bindings
      the capped one does not reach in the reversed text (text-order/cap1r.sysml, cap2r.sysml). (10)
      Rows read through a subsetter whose subsetted usage an instance reads otherwise abstain
      together with the subsetted usage's rows
      (review-2026-10-14/wave3-probes/fence-readings/p/v1.sysml, v2.sysml); the component fence
      ignores multiplicity; a chain taint does not reach a subsetter declared deeper in a
      specialisation the model never instantiates. (11) Order only, sound either way: the SMT lane's
      `?` versus `X` letters on contradictory merged lines and `T` versus `?` on generic requirement
      rows; the row key of a constraint read in a specialisation context flips with member order
      ('in W3' or 'in v', same ?/?/?/? cell;
      review-2026-10-14/wave3-probes/fence-readings/p2/o1.sysml); the tie sentence lists the
      equations in written order (review-2026-10-14/wave3-probes/fence-readings/p2/t2.sysml); `part
      p1 :> p1` terminates and abstains but raises no specialization-cycle diagnostic, unlike p1 :>
      p2 :> p1 (review-2026-10-14/wave3-probes/fence-readings/p2/cy3.sysml). Probes:
      review-2026-10-14/wave3-probes/fence-readings/. [fence-readings]
      fence-loader: a name two or more levels below a user feature that goes through a library
      feature's members, past the first route, is no longer registered, and the bare names of
      library features can become admitted (nested count 2 to 1; 18 names on views-tour, all read
      unknown because the library states no value); past 10,000 owners of one context
      (MAX_NAME_WALK_OWNERS) the names below it read unknown with the sentence 'the names below
      <ctx> are not all read'. v9 enters at most 542 owners, the examples 59. [fence-loader]
      reads2-pass (an asserted bare bound on a unitless Real over a give-way default is carried on
      the SMT lane; `bounds`, `consistency` and `refine` carry it too): (12) an asserted inequality
      over such a default that is not a bare bound stays refused: a sum or multi-name inequality (`L
      + N >= K`), a bound with a `[unit]` or on a unit-bearing feature, an Integer or restricted-
      domain sort, a conjunction (`load >= 0.0 and load <= 10.0`); the unit, Integer and conjunction
      shapes keep the generic sentence 'no assertion gives a default a value' rather than one naming
      the move (reads2-pass-scratch/h217/h2.sysml, gen217/models shapes 'int' and 'unit'); (13) a
      usage that redefines the default itself (`part q : Q { attribute :>> L default = 9.0; }`)
      beside bounds abstains where the hand oracle could prove (20 cells: reads2-pass-
      scratch/gen217b/models/m45f.sysml, m46f.sysml, m52f.sysml); (14) bounds linked through a
      derived relation are refused whole, including a lower and an upper bound in the same component
      of a linked group (B5, B7: review-scratch/pr/b5.sysml, b7.sysml; pinned stand-gw-ineq-derived,
      -derived2); (15) a scoped worklist (`obligationsOf` with scopeId, the Checks 'Obligations'
      listing) may carry a bound the whole model refuses as meeting (review-scratch/scope.mts;
      sound, the partner is no axiom there); (16) a usage that subsets a feature an instance reads
      otherwise (TODO 241, skipped: the per-usage taint `subsettingsOtherwise`, `spreadOtherwise`,
      `satisfierTaint` feeds about eight readers; probes sub-sa7, sub-sa3, sub-sa5, sub-def-sa7d,
      sub-tc8 and the AE3 shape `w.x == w.p2.load` in a package). 249 (an asserted conjunction as an
      equation) stays open and skipped: it needs conjunct splitting at about ten call sites over
      four lanes. [reads2-pass; numeric2-pass]
- [ ] **Abstentions left in the negated assert (rollup; sound, only weaker).** (a) A model with
      `assert not requirement`, a negated clause that names a constraint with no body, one that
      specialises a constraint, or one whose body holds members, a comment or a `doc` member
      degrades as a whole, not only the dependent rows (a negated clause with a one-expression body
      is read since numeric2 S1, see 'Read `assert not constraint c { ... }`'); (b) `assert not
      satisfy R by s;` parses as the bare clause `assert not` plus a plain `satisfy R by s;`: the
      error is raised but the satisfy edge is read plain and the sentence names the clause (`not
      satisfy` and `satisfy not` stay generic parse errors); (c) members declared inside a refused
      body are not mapped (kept verbatim in the save), and `assert not x > 1.0;` swallows `x` as the
      clause's name, giving a `validation/duplicate-name` finding beside the new error; (d) a caller
      that runs the engines on a model whose load report it ignores sees the clause dropped from the
      axiom set; (e) a degraded `contracts` / `obligations` report shows a requirement whose only
      clause was refused as having no formal clause. [fence-assert-not; numeric2-pass]
- [ ] **Stop the SMT engine reading inconsistent axioms on a model that does not contradict
      itself.** One symbol per feature across the usages of one definition: `part def P { attribute
      L; attribute K; bind L = K; } part a : P { assert constraint ea { L == 50.0 } } part b : P {
      assert constraint eb { K == 60.0 } }` reads `verification/inconsistent-axioms` though neither
      instance contradicts itself (the literal engine discharges, the numeric surface does not
      converge; review-2026-10-14/wave3-probes/contradictory-models/c6a.sysml). And a chain a
      specialisation masks: `part def P { L; K; bind K = L; assert constraint cl { L == 50.0 } }
      part def P2 :> P { attribute K; attribute N; bind N = K; assert constraint cn { N == 70.0 } }
      part p : P2;` (P2's K masks P's without `:>>`, so N is joined to P2's K and not to L): the
      check and the literal engine decide p.L == 50.0 and p.N == 70.0 T, correctly, and SMT reads
      the axioms inconsistent (T/T/T/X;
      review-2026-10-14/wave3-probes/contradictory-models/g8.sysml). No false T or F, only a false
      inconsistent-axioms claim; unchanged from the base and in the USER-GUIDE limits. Done when SMT
      keys a symbol by instance, or the shapes are pinned in I7_ALLOWED with this reason.
      [contradictory-models S3, review]
- [ ] **Keep a redefinition on the more specific feature when an edit dissolves the join that kept
      it off it.** A redefinition kept off a more specific feature by a join an edit dissolves stays
      on the base feature, written by its path; the same names written by hand land on the more
      specific one, so page and file differ. Cases: a sibling renamed away from the name a `:>> M`
      is known by, a typing changed, a sibling on the redefinition's line deleted, a named redefiner
      (`M2 redefines N`) whose blocking sibling is deleted, and an explicit `:>> M2` that a feature
      renamed into `M2` moves to Q::M (Save writes it as `:>> M`; the hand reading of that collision
      itself depends on text order). Needs the name the author wrote kept on the Redefinition edge
      so an edit re-resolves it. An unnamed `:>> K2` over a named redefiner is also saved as the
      farthest base name (`:>> N`), as prescribed: 105 of 400 random models change text, targets
      identical. A redefinition whose target has no printable name left is dropped on settle
      (deliberate; decide whether to keep the edge and abstain with a reason sentence instead). Rows
      redef-target-renamed-away(-rev)(-q). Seen by the property oracle: sequences 184 and 5068 of
      the store.reducers generator. [redefinition-target S2]
- [ ] **Settle an implicit end copy through its whole life: a rename onto a taken name, the mapper's
      text order, a peer's edit.** fence-editor settles a copy on a retype, a delete, a rename of
      the feature it redefines, undo and redo, and on the raw routes (REST commits, the store's
      model listener). What stays: (c) a rename that gives the copy a name another feature of its
      owner bears parts the copy (stale) and the page abstains where the reopened file decides (D1:
      page ?/?/?/?, file F and T; review-2026-10-14/wave3-probes/fence-editor/d.test.ts); (d) the
      mapper lands a definition-level or usage-level end copy on the feature the name finds when the
      mapper reaches it, so the copy stood on another copy (D1's `bind` copy) past an override that
      redefines the same base (D2's `:>> N default = 15.0`, which meets no copy) in the text orders
      where that copy is made first; fence-copy leaves such a binding unread at load
      (attrs.partedEnd, scope withheld on all four surfaces, the existing parted-binding sentence)
      when the copy hides any override of the name (a `default`, `=`, expression, typed, named,
      assert or bound override, every chain connector, and a name bound to a feature of a fenced
      scope); the reading itself (the copy on the NEAREST N, 15 in every order) is not made, see
      'Land an implicit end copy on the nearest override, whatever the text order'; an edit that
      retargets or renames recomputes the mark (markStaleBindings), and an edit that creates the
      shape by another route than a rename (a new `:>>` feature added in D2) is probed only through
      the K-to-N rename; (e) a peer's edit in a room is not settled by the receiver (the sender's
      settle arrives as edits; not exercised with two live clients). Done when each reads as the
      reopened file does. [fence-editor] fence-editor2: item (c) now withholds every name of the
      binding's owner on all four surfaces (a rename onto a taken name), and the SMT lane proves and
      refutes nothing on a model that holds a withheld scope; the page still cannot decide rows the
      file decides. [fence-editor2] [fence-copy]
- [ ] **Abstentions left in the editor (rollup; sound, only weaker).** (1) After a retype that parts
      a copy under an unrelated binding, the page abstains where the file decides ('page ?F file
      FF': seeds 106, 123, 527 of the 1000-sequence window). (2) A stale copy still resolves as a
      name on the page, so a constraint naming it (`r0.L` after `Q::L` is renamed away) is read by
      the numeric lane as imposed (t) where the file reads the name as unresolved (?); a
      definition-level `bind p.load = L` after `Q::L` is deleted reads ? on the numeric lane where
      the file decides (F), a binding with a stale end being set aside (both pinned in
      test/unit/store.reducers.test.ts, 'the readings that differ from the file stay abstentions,
      not verdicts'; probes review-2026-10-14/wave3-probes/fence-editor/zzprobe3.test.ts, 'RN rename
      L->Zz' and 'debris delete Q::L'). (3) Two bindings in one usage that reach one copy by
      different names (`bind Zb = M; bind Zc = N2;` in the D4/D3 diamond) are saved under the
      first-created name for both: page equals file, the second spelling is not kept. (4) A head the
      edit made land elsewhere is dropped and the copy goes by its own name; a name cannot be
      cleared from the Properties Name or Short name box, which put the name back (the clear belongs
      to an SDK setter in the style of Model.setShortName); a draft typed and not committed is
      dropped if the selection changes with no blur (programmatic only). (5) A stale copy raises no
      Problems entry on the page until the file is reopened (the file reports 2 x
      ref/unresolved-reference and error:connector-endpoints). (6) Latent, not reproduced: a command
      that calls pushUndo and exits with no change leaves editOpen true; a raw model call made after
      is queued in editEvents, and the next beginEdit drops it unsettled (src/ui/store.ts
      watchModel, beginEdit); fix: endEdit() where a command returns without a mutation. Probes:
      review-2026-10-14/wave3-probes/fence-editor/a.test.ts, d.test.ts, e.test.ts. [fence-editor]
      fence-editor2: (7) a parsed `part p : A { bind A::x = y; }` is a parted holder, so `--engine
      literal` no longer decides on the CLI (mark the end where the editor moves it, not by
      structure; probe rev/m/m5.sysml); (8) after a retype or rename the page abstains on every name
      of the binding's owner where the file decides some (402 cells of the 216-model generator); (9)
      rows over a withheld scope are inconclusive without the check lane's own sentence; (10) a
      requirement pair (satisfy, verify, refine, trace, derive) or a redefinition-family statement
      with an anonymous end is skipped silently on Save, and Apply of the Text view's text after a
      `// Not saved:` statement drops it; (11) the generator had no units. Residual page-F/file-X
      pairs (seeds 70041, 70338, 70349, 70478, 70555) are identical at the base. [fence-editor2]
      fence-redefs: (12) the page abstains over an owner of two features under one name, and over an
      owner of a redefinition edge the file does not keep (not inherited, another kind, a cycle),
      where the reopened file decides: 12.7% of the steps and 8.5% of the decided cells of the
      adversarial soak, 0 of the 637 corpus models; a rename or create that gives a feature
      another's name withholds the whole owner scope and compares nothing with the file, so it is
      conservative on a retarget the file keeps; a precise twin fence (a relationship pointing at
      the non-first twin) and an edge fence by place would read more; a retarget onto a library
      feature is treated as inherited; (13) on a hand-edited page a row that reads a withheld name
      still gets the SMT sentence 'unresolved-name ...' where the check lane gives the true cause;
      (14) `bind.ts` `redefinitionIsKept` re-implements the serializer's spelling
      (`effectiveNameOf`, `effectiveQualifiedName`): re-run the edge property
      (scratchpad/rev-redefs/zzedge.test.ts) when the serializer changes; 51 of 5222 steps differ
      page against file in the edge, 5 with the owner not flagged, no row difference in 820
      constraint replays. fence-save-name: (15) page `FF`/file `??` rows seqs 44248 and 40746
      (identical on base, no note in the saved text) and about 390 per window 'page ?? / file
      decides' rows; probe fence-save-name-scratch/soak/mine-4*.log, generator
      fence-save-name-scratch/zzb.test.ts; a stale-copy probe: seed 32180 (RV_RAW=1 RV_FIRST=32180
      RV_SEQ=1 RV_STEPS=5) and soak seq 42267 (page TT, file ?F on c6). [fence-redefs;
      fence-save-name]
- [ ] **Take the dangling-edge scan out of `Model.remove` (core cost).**
      Model.remove finds dangling edges through a referrer index kept by create, update and remove
      (misc-pass), in the old scan's order and with the walk repeated while an edge listed before an
      edge that goes was passed over; 300 one-at-a-time removes on 13k elements went from 100 ms to
      3 ms. The first remove after the index is dropped (reset, resetPreserving, adoptSerialOrder
      when the order changed, fromJSON) costs more than the old scan, since the index is built then:
      on the v9 model 26 to 34 ms against 9 to 15 ms, later removes 0.01 ms against 5 ms, and
      removing a definition with 30,000 incoming typings 227 ms against 52 ms; a trade-off, not a
      wrong answer. Left: (a) a removal that moves a Redefinition still asks relationshipsFrom, so
      the per-revision edge index is rebuilt each time (250 chain-member removals 62 ms at 13k
      elements); an incrementally kept source/target index in element order would end it, and would
      also be the place to fix a later dangling edge if one is found; (b) a 300-deep chain with two
      named siblings parses at 1.16 to 1.30x of 84fb971; skipping joinsTwo's reach walk was tried
      and gives no measurable gain (12 parses each, 0.40 to 0.45 s both ways), so the ratio is not
      from that walk; (c) a retype on a usage of 1500 :>> settles in 343 to 453 ms. Done when (a)
      holds with the order unchanged and (b) and (c) have a measured cause. [redefinition-target S2,
      S3; misc-pass]
- [ ] **Widen the random edit generator of the store property test (optional).**
      store.reducers.test.ts draws bind in definitions and usages, a user retarget of a redefinition
      (updateElement on the edge, to another feature of a general of its owner and not onto one a
      sibling already redefines; its own random stream, 190 retargets in the 300x4 gate window), and
      counts the sequences that fell back to the binding-free model (0 in the gate window, asserted
      below a quarter). Still to add: nested `part :>> p { attribute :>> load; }`, standalone
      `redefinition` statements, the SDK edits, the duplicate-name stop as a counted outcome; a
      verdict oracle (a copy bound to a valueless Zb plus `u.Zb == v` constraints, definite check
      and numeric contradictions between page and reopened file); the hand-text oracle is thin (1
      comparison in the 300x4 gate window); compare the four-surface verdicts in a subset of the
      sequences. Finding of the new draw (no wrong answer, the page equals the file):
      SYSPROSE_RT_FIRST=1700 SYSPROSE_RT_SEQUENCES=1400 SYSPROSE_RT_STEPS=6 fails at seq 2264 step 5
      ('a full settle of the page still moved 1 redefinition(s)') after a user retarget and a
      rename; retargeting onto a feature a sibling already redefines is excluded from the generator
      and is outside the oracle, like two features of an owner on one line. Soak seeds 1120 and 1618
      are the known pre-existing ones (rollup 'fence-copy2' item 12). [redefinition-target S2, re-
      review; misc-pass]
## Per-instance soundness — review 2026-10-14

From the soundness review of F3–F8 and 3e3b0ff (Sysprose 5943654 against 7277a97). The branch
`per-instance-sound` (merged by `4ac2fff`) closed A-C1, A-C2, A-C3, A-H1 (the direct reads), A-H3
and A-H4, PI-1, and the correctness half of A-H2: instances now read where they stand, abstain where
they cannot, and the four-surface table pins A1–A9, A4, CAP1, X-shapes and the units shapes at their
true values. What follows is what that branch and the review of it left open; entries tagged
`[O2 …]` come from its steps and reviews.

- [ ] **Match a binding into an instance by path through a value too (optional, low).** Since
      per-instance-rest S3 a binding written in an instance makes its usage a group only where it
      reaches a path the relation reads. What a value the relation reads reads is still matched by
      feature: `m = t.extra * 2.0` beside q2's `bind p.s.extra = E` (BA7) forms an extra group of
      rows read alike. That costs rows, never a verdict. Probe:
      scratch/naming-pass-scratch/ba7.sysml. Skipped on 2026-11-02 (naming-pass): a safe fix needs
      path-resolved dependencies through references, bound subjects and derived values, and a wrong
      exclusion would drop a per-instance reading. [O2 S4, per-instance-rest S3]
- [ ] **Read a `default` that an assert in an enclosing scope names, instead of abstaining (A.2.4
      lexical rule).** Since defaults2-pass an enclosing assert that names a feature stating a value
      of its own (a default or =, no binding end and no binding-held default) is read at that value
      and the assert is checked against it, as for = (statesStandingValue; refute-r1, r1u, r1d, h1c,
      q4b, sfh, stand-enc-*). Still abstaining (enclosing-assert): an assert naming a feature a
      binding gives its value, such as A2E p.load >= 0.5 over Q's bind p.load = L; a feature with no
      value; a name the assert reaches only by prefix. Done when the first reads the binding's value
      (the RB5 route, valuedByBinding) and the assert is checked against it, each row pinned against
      its = twin. Probes: defaults2-pass-scratch/p6/se-none.sysml, differential A2E-enclosing-assert
      and stand-enc-bound. The dead enclosing-owner code of the sibling entry 'Remove the
      decision-14 default machinery' was left untouched. [default-stands S1, defaults2-pass]
- [ ] **Remove the decision-14 default machinery, or ship the held tag (analysis Q2).**
      `replaceableDefaults` (always empty) gates code that is now unreachable: the local rule
      (`assertHeldIndex`), the enclosing rule's owner loop (`enclosingAsserts`), the binding route's
      replaceable branch in `heldDefaults`, the guard's `assertedDefault`, `assertDefinitionsAt`,
      `unreadAsserts` from the owner loop, `givenWayCause`'s untyped branch, and `assertedAnswer`
      over defaults. Remove it unless the soft tag ships. Keep `standingUnderInstance` (the RB5
      abstention) and the head-slot read (`headSlots` / `definedAgainstHead`): they serve the
      amended rule. Planted bug P5 sits in the dead code and is an equivalent mutant again: move it
      or retire it. [default-stands S1] Name the dead user-facing strings so they go with it:
      evaluate-model.ts near :4109 ('which gives way to an asserted equation') and :4836 ('(an
      asserted equation overrides a default)'), and defining-equation.ts near :6764 and :6797
      ('under decision 14 the equation stands over ...').
- [ ] **Read `bind L = L0` over a valueless L as `L = L0` is read, so H2f decides as H2.** The
      maintainer decided that H2f reads as H2 (analysis G2; KerML 8.4.4.11 makes `L = L0` and `bind
      L = L0` one construct). Since default-stands S1, H2f reads as its own `=` twin and never reads
      the assert's 50 into L0 (u1 T/T/T/X). But its L rows abstain (ca ?/-/F/-, t1 ?/?/?/X, t50
      ?/?/F/X) where H2 decides (ca F/-/F/-, t1 T/T/T/X, t50 F/F/F/X). The cause: H2's `L = L0`
      gives L a value, so the assert is checked against L0's 1; H2f's L is valueless, so the assert
      defines it and the binding gives it a second value. Five places decide that the assert defines
      L and must change together: (1) the binding component classification (endValue, heldDefaults'
      defined branch, classified, agreedValued); (2) the check's valueDefinedByEquation and
      definedAgainstHere; (3) the #bind conflict row in bindingConflicts; (4) the numeric solver's
      design equation for the assert; (5) the literal engine's contradictedDefinitions. Changing (1)
      alone read L as 50 and gave a false verdict (ca T, t50 T, t1 F), so it was reverted. Done when
      the five readers give a valueless end bound to a valued feature that feature's value, with an
      oracle over order swaps, instances, default and = twins, and the #bind row gone. Probes:
      defaults2-pass-scratch/p2/h2f.sysml and p5/. [default-stands S1, G2, defaults2-pass]
- [ ] **File a definition's context row under one name whatever the declaration order.** Since
      instance-pass a relation of P read in P2 :> P is filed P::ca in P2 whichever of P2 and its one
      package-level usage p is written first (sort tie-break in contextsUncached; no verdict moves,
      only worklist order and the filing name). Left: the same relation read in a usage written
      inside a definition or a usage (part def Q { part p : P2; }) is still filed under Q::p or P2
      by text order. Giving the definition priority there loses the instance rows of
      binding-conflict shapes (P2 states load = v with = and Q binds p.load = L) and only the P2 row
      survives. File it under P2 only with those rows kept. The M-generator's RENAMED pairs (27) and
      the H3/H6/S3-spec cells live outside this repo; the in-repo differential table needed no
      re-pin. [default-stands S2, instance-pass]
- [ ] **Show `:=` (an initial value, not a binding) and the value's unit in `elements` and the grid;
      the workflow readers then read them (optional).** Sysprose now prints `:=` and the unit (the
      grid value cell is `[default] [:=] value [unit]`: `:= 4`, `default := 3`, `7 [kg]`; `elements
      --json` `value` is the cell). The mbse-workflow reader `elements()` in
      `src/sysprose/inprocess.ts` (line 256) strips only a leading `default `, so before its
      SYSPROSE_REF moves past this change it must also read a leading `:= ` and a trailing ` [unit]`
      (a value like `:= 4` or `7 [kg]` is no bare number to it); after a pin bump every `:=` or
      unit-carrying value reaches its consumers as a non-number. 28 of 149 published example and
      fixture files change in the value column only (for example uav-isr mass `1.2 [kg]`); the v9
      gate captures no `elements` row, so 'v9 identical' does not cover it. Do not move SYSPROSE_REF
      in either workflow repo past this branch until `elements()` reads both, and add a Grid-view
      check to the tutorial re-record decision. Coordinator, cross-repo; Sonnet. [subsetting-pass
      S1]
- [ ] **Parse a declaration whose user-defined keyword stands without a reserved keyword.** SysML
      7.27.4 (sysml.txt:10327-10334) allows it for semantic metadata (`#situation def Failure;`,
      `#situation batteryLow;`); BNF ExtendedDefinition and ExtendedUsage (kebnf:1695-1701) admit it
      for any metadata, so `#k :>> L = 3;` is a usage redefining L, tagged k. The grammar rejects
      all three today (mismatched-token / unknown-keyword). It matters only if a tag such as
      `#provisional` ships, and then it must be read in every `@`, `#` and `about` form.
      [small-defaults S2]
- [ ] **Read a bare `metadata T;` as typed by T.** Per BNF `MetadataUsageDeclaration`, `metadata T;`
      and `metadata T {...}` are an unnamed usage typed by T. This tool reads `metadata N {...}` as
      a usage NAMED N with no type (requirements.ts RM_METADATA_NAME, the verification tests and the
      fixture L8-evidence-stale rely on it). Changing it means moving the RequirementMetadata
      carrier to a spelling that survives; a design choice, Opus. [small-defaults S2]
- [ ] **Read an annotation's `about` targets (attach a carrier to the element it names).** Every
      consumer takes a carrier from its owner. Until then a carrier written with `about` is refused
      with `mapper/carrier-about-unread` (PropertyPattern, Evidence, FaultHypothesis,
      VerificationMethod, RequirementMetadata, and an `about` annotation whose `kind` names a
      method; both spellings, including `about` naming the owner itself). When it lands, lift that
      blanket refusal. A keyword annotation's `about` targets are raw qualified names no consumer
      resolves. [small-defaults S2, review]
- [ ] **Resolve a metadata body redefinition (optional, low).** A body redefinition in an annotation
      typed by a metadata definition of the file now resolves (`@T about X { ref :>> approved =
      true; }`; T and what it specialises are added in `redefinitionGenerals`; `kindCells` follows
      the Redefinition). A feature the metadata definition binds with `=` and an annotation
      redefines with another value now files validation/constraint-violation (warning) plus an F row
      `MD::«MetadataUsage»::«AttributeUsage»#binding`, the same rule as for ordinary usages ("a
      redefinition may override only a `default`"); before, it filed only
      ref/unresolved-specialization (probe subsetting-pass-scratch/wbr/md1.sysml; no false answer
      found). Left: an annotation typed by a LIBRARY metadata definition
      (`@VerificationCases::VerificationMethod { attribute :>> kind = test; }`) keeps its textual
      `redefines` and files `ref/unresolved-specialization`, as a library-typed usage does (`part y
      : ISQ::MassValue { attribute :>> num }`): the library merges after the mapper resolves. Done
      when the library binder resolves the cell too and every reader of `attrs.redefines` text
      (kindCells reads both now) keeps working. [parse-and-show S1; subsetting-pass S1]
- [ ] **Ask FailureMode by its qualified name when it ships.** `machineFailureModes`
      (src/semantics/fault-tree.ts) counts a model's own FailureMode through `hasKeyword(..., {
      anyPackage: true })` because the definition is not in SysproseVerification yet. When the
      vocabulary commit ships it, add FAILURE_MODE_QUALIFIED_NAME, ask for it and drop the option;
      the campaign test then declares the definition in SysproseVerification and its "model's own
      definition is counted" sentence changes. [small-defaults S3]
- [ ] **Report an ambiguous keyword as ambiguous (optional).** `statement-kind.ts` reads `#prose`
      and `#prompt` from the spelling alone, so a foreign `<prose>` is still read as a statement
      kind: needs its own decision. (The two-imports ambiguity of a bare keyword is reported:
      `verification/keyword-ambiguous`, origin `ambiguous`, and `hasKeyword` reads it as no tag in
      either import order; `obligations --from-keywords` names nothing for it in either order; a
      qualified keyword is not asked, and only the nearest scope with imports is.) Left: an
      ambiguous foreign-aliased keyword (a bare #precondition two imports answer to) is not reported
      as ambiguous: `contracts --keywords` files it as `foreign` and never raises
      verification/keyword-ambiguous, and fault-tree.ts counts via hasKeyword, so an ambiguous
      #failureMode or #exceptional makes 'found none of' read as a plain absence. Probe:
      subsetting-pass-scratch/wbr/kw2.sysml via `scripts/sysprose.ts contracts --keywords`.
      [small-defaults S3; subsetting-pass S1]
- [ ] **Hold: an opt-in tag that lets an assertion adjust a written number (for example
      `#provisional`).** DECIDED to hold (analysis Q2): a soft value is written as a value until a
      model needs the tag, as `#Observable` was held
      (`src/semantics/verification-vocabulary.ts:17-21`). If built: metadata cannot change a model's
      meaning in the standard (KerML 7.4.13), so a tool without the tag reads the value as hard; it
      must (M1-M5) gate both index builders and the binding route, be inherited by a redefinition
      that does not repeat it with an explicit opt-out (Q6 = inherited), be identified by its
      package (ask `hasKeyword` for its qualified name, as `#exceptional` is since small-defaults
      S3), and be read in every `@`, `#` and `about` form. v9 and the six Sysprose examples use no
      `default`. Opus; about 45M. [soft-hard analysis Q2, Q3, Q6]
- [ ] **Finish the evidence and scope residuals of `reporting-small`.** (1) `obligations --element`
      (and the app's scoped checks) filters by the relation's own element only (`scopeFilter` in
      `obligations.ts`), so a relation read per instance in the scoped element lists none of its
      rows: `--element E5::q2` on the e5-renamed probe (`part q2 : Q { part p2 :>> p; ... }`) shows
      0 rows although `P::c in E5::q2::p2` is violated; decide whether the scope should include the
      rows read in a context under the scoped element. big-bind-600's cold check is 17% slower than
      before the routing change (577 to 675 ms; the cold-check branch measures it). (2) The evidence
      record does not record the instance path of a shared-usage reading (`satisfy LoadReq by
      Sys::p` records only the own row), and `verify` prints a moved reading as `H::LoadReq in
      H::p1` where the record says `H::massR in H::p1`. [reporting-residuals S2]'. The quoting,
      footer-name, double-count, requirement-def specialisation, earlier-build sentence, frame-cap
      and raw-count items are done or were fixed by earlier reviewers
- [ ] **Fold the per-instance findings of a cause a definition states by a derived value, or beside
      another read.** naming-pass S1 anchors a violated instance whose one breaking read is a
      derived value reached through a binding (M7: q2's `:>> K = 25.0` under Q's `L = 2.0 * K`) at
      the single number-literal member the instance's own elements state of what the value reads,
      only where no other number it reads is a redefinition outside the instance's own elements (a
      shared default is fine). With two such members (M7b), or a redefined one stated in a
      specialised definition (m7j), the finding stays at the part; that is fenced, not open. Still
      open: (a) a derived value read with no via, as the unit-aware read of PB's `m2 = 10.0 - load`
      (`breakingRead` abstains on si reads, so the finding stays anchored at the part); (b) folding
      the instances of a definition that share a derived line (equal inputs) into one finding at
      that line; (c) a default, a unit or `sides`, and a sixth distinct set, as before. Probes: PB
      and M7 in test/unit/semantics.evaluate-model.test.ts. [reporting-residuals S1, review,
      naming-pass S1]
- [ ] **Name the breaking value in a unit-bearing violated instance.** `breakingRead` leaves
      `breaks` unset (the finding names the first bound read, as before) when any read carries a
      unit, an SI figure or sides, or when no single read, put back to the relation's own context
      value, makes the relation hold (both needed, or the relation is already violated there). It is
      decided on the scalar scope only, and for the first 5 violated rows of a group or 20 contexts.
- [ ] **Name and anchor a value the instance redefines, which no read carries.** Done for a group
      row whose instance's own element (`readIn`) redefines a plain number literal that breaks the
      relation (redef-breaks2 / G5: `extra = 20.0` is named and anchored). Still open: a context row
      that is no group (no `readIn`); a redefined value that is derived or carries a unit (G5c
      shape); and a row with no read at all, which a target-by-specialisation finding reports with
      no instance anchor (probe scratch/naming-pass-scratch/nb12.sysml). [PI-2 S1, naming-pass S1]
- [ ] **Divide the text step and the edit's own task on the drone-swarm v9 model.** Since `ui-small`
      S4 an edit's recompute yields to the page between its steps (`recomputeSteps`), but three
      tasks stay whole. The serializer (`serializeUserModelSignals`, `src/text`) writes the one root
      in a single pass: 40 to 90 ms at load about 4, up to about 180 ms at load 25. The edit's own
      task (the undo snapshot `model.toJSONWhere` plus the SDK update) takes 54 to 109 ms warm, up
      to about 296 ms at load 25, and 238 ms on the session's first edit when cold. The last step
      (the results set plus the synchronous `buildDiagram`) takes 90 to 156 ms at load 25. Fix: a
      step-wise serializer, or moving the undo snapshot and the diagram build apart. Not done by
      design: incremental validation (unsound for cross-element rules) and the text in a worker (a
      model transfer per edit costs about what the write does). Done when no task of an edit and its
      recompute is over 200 ms at load 25. The `palette-checks` step 4 bound (200 ms) has a thin
      margin on slower CI cores: if the first CI run is red, make the assertion relative. [ui-small
      S4, review 2026-10-14 D-3]
- [ ] **List what a load binds later in the order a terminal binds it, on the page and on every peer
      of a room.** Done by fence-coremodel, fence-order and core-pass: where-used, the impact
      closure, SDK traverse, REST relationships, the impact graph and the specialisers a finding
      names list in text order, and so do Properties' Types and Specializations lists, a table's
      Type cell, the diagram's subject grouping and the 3D shape inference (Model.typesInBindOrder
      and Model.specializationsFrom: the colon-greater family, then typings, then redefinitions).
      These lists use a fixed order that does not depend on the order the relationships were made in
      (the order where-used uses); it is not the terminal's `typesOf` listing, and no single sort
      key matches the terminal's raw listing (s1-spec lists the typing before the redefinition, a
      def-body `:>> p : P2` the reverse). What stays: (1) Model.typesOf, which the readings walk,
      still lists in the order the model lists the relationships, so a typing made in the app beside
      a subsetting or redefinition reads in another order than in a terminal. The order scope in
      bind.ts unreadScopes fences the shapes where the order decides a name, so no cell has been
      seen to differ (140 generated models). typesOf stays unsorted pending a user decision: sorting
      it changed a pinned abstention into a decided reading
      (test/unit/semantics.evaluate-model.test.ts 'abstains where no one element stands for an
      instance...', around line 6856, model `part def Q2 :> Q { part :>> p : P2; }` with `P2 :> P {
      attribute :>> extra = 9.5 }`: generic and G::q2::p went from unknown to violated, which is the
      KerML reading since P2::extra redefines P::extra, but it widens a verdict; decide the
      abstention, or keep it). Other consumers read `typesOf()[0]` the same way:
      consistency.ts:1211, conformance.ts:77 and contracts.ts:1393. (2) The walks of ofKind
      Redefinition/Subsetting/FeatureTyping/Subclassification are shown not to depend on the walk
      order (bind.ts 264 was order dependent and is fixed; units-eval reads only within-family text
      order; the defining-equation walks and the rest: 179 corpus models under two perturbations, 0
      differences). The FMI `declaredTypeName` (src/interop/fmi/model-description.ts) was a
      page-versus-file difference (an attribute whose typing is made by an edit beside a subsetting:
      Float64 on the page, Int64 after Save and reopen; probe core-pass-scratch/rv/p3.mts); it now
      takes the first FeatureTyping target and is fixed. validate() ordering across loads is the
      separate entry 'Abstentions left in the order of listings'. Done when typesOf lists alike on
      the page and in a terminal, which waits for the decision in (1). [core-pass]
- [ ] **Save the unnamed end by a name, instead of leaving it out (a loud note today; sound, only
      weaker).** Rechecked read-only on a683620 (2026-11-02): 240 neighbour cases lost or moved no
      statement and every end Save cannot name gets the `// Not saved:` note, so the page and the
      saved file no longer disagree; only the full fix below is left. History: fence-save-name: Save writes a binding, connection, flow or interface end through
      an unnamed redefinition by its effective name where it is the FIRST member of its owner that
      goes by the name (the chain resolver's rule, `childNamed`), so a `duplicate` of `:>> M`, an
      unnamed redefinition before a named member of its name and an unnamed head of a path are saved
      and reopen on the same feature. An allocation, succession, transition, dependency, disjoining
      or alias end keeps the one-answering-member rule (the file reads the named member first).
      Still written as `// Not saved: a <word> whose end no name reaches (...)`, and the file
      reopens without the statement: an end that is not the first of its name for a chain kind (a
      rename, `duplicate`, reparent or retarget made an earlier member bear the name), two members
      for the others, and a redefined feature with no name. No text makes that state, only an edit.
      Closed: (a) and (b) by fence-text; by fence-order, the earlier-member case for requirement
      relationship ends (satisfy, verify, refine, trace, derive) and for inline specialization
      targets (typing, `:>`, `::>`, a redefinition spelled by a path), which now get the `// Not
      saved:` note too; and (c), the write-back refusal in scripts/sysprose.ts `modelText`, which is
      exported and tested. Still open, wrong answer: only the full fix, giving the end redefinition
      a declared name on Save, or reordering so the end is first, instead of the note; also a
      redefinition spelled by a simple name that lands elsewhere keeps the healing route
      (`settleRedefinitions`) as before. Probes: wave3-probes/fence-order/gen3.mts, req.mts,
      inl.mts; fence-text-scratch/review/dup3.mts, sk.mts; fence-editor2-scratch/s2/probes/p1.sysml.
      [fence-editor S2; fence-editor2; fence-save-name; fence-text; fence-order]
- [ ] **Z3 constraint classes: classes-3 (rollup, plan
      ~/.claude/plans/z3-constraint-classes.md).** classes-1 merged the census and
      `src/semantics/smt/shape.ts`; classes-2 merged the classifier, pinned.ts, the maturity
      function, the generated facts and the census `--check --strict`, and records the class of
      every z3 call internally (nothing prints). Still to do: classes-3 (printing the class line in
      verify text/JSON and the other z3 commands, only cells that have corpus rows; the 55
      fence-only no-clause rows carry no ninth reading; a row with zero symbols is `ground`).
      classes-3 waits for the wrong-answer count at or below 15. [classes-1, classes-2]

- [ ] **z3 νZ answers a script over an Integer and a Real feature with a bound that a feasible point
      lies beyond (the wrong answer is fenced; the full reading is left, sound, only weaker).** The
      original defect: `bounds` on a model that declares both an Integer and a
      Real feature published 'min x = infimum 3/4, never attained' where x = 0 is feasible, 'max x =
      supremum 0' where x = 1 is, and (no strict comparison needed) 'max x = 1 + epsilon' where 2 is
      attained. fence-bounds: such a script keeps an optimum only when two plain checks confirm it,
      and withholds an infimum, a supremum and `oo` as inconclusive with
      verification/optimality-not-established. The full reading (a sound encoding or an own
      optimiser for mixed scripts) is not done. Probes: fence-bounds-scratch/p/mix2.sysml and
      mix3.sysml (`npm run sysprose -- bounds <f> --measure p.x --sense both`); battery
      fence-bounds-scratch/gen/genmix.py seeds 1-3. [sweep 2026-10-31; fence-bounds]
- [ ] **Abstentions left in bounds and consistency (rollup; sound, only weaker).** (1) Mixed Integer
      and Real bounds: an infimum, a supremum or `oo` is withheld even when correct (14 to 49 per
      300 cells in the battery were decided on base and abstain now, some of them right); probe
      fence-bounds-scratch/gen/s2.cases.json. (2) A relation that reads a feature typed Natural,
      Positive or UnlimitedNatural is refused in the z3 lane, so bounds, consistency, verify and
      refine abstain on it even where a literal pins the feature (`k : Natural = 3` with `x <= k *
      2.0` used to give max 6); probe fence-bounds-scratch/gen/f5.cases.json; the full reading
      carries n >= 0 / n >= 1 as an axiom in encodeScript, without disturbing consistency's
      owners/core mapping and the `axiom` census. (3) `verify` on a freed Natural says 'relation
      cannot be read (non-numeric-operand)' where it said verification/free-variable-unbounded
      (abstention to abstention). (4) Retyping an Integer to Natural leaves a recorded refutation
      'current' although the tool now abstains on it: `restricted` is not in scopeRowDigest
      (src/api/evidence.ts). (5) The `bounds` exit-code sentence (scripts/lib/sysprose-spec.ts
      BOUNDS_EXIT_CODES) does not list the two new not-decided kinds. [sweep 2026-10-31;
      fence-bounds]
- [ ] **Abstentions left in the collaboration room (rollup; sound, only weaker).** (a) A library
      element dragged within the library is now that page's own view and is not shared; nothing is
      lost, since the library is read-only for the user (test/unit/collab.binding.test.ts 'the
      standard library stays out of the room's document'). (b) A room document an earlier build
      wrote still holds its library until a reset clears it, so a returning peer's first message
      from such a room stays about 10 MB. (c) A page that joins a room before its own library has
      merged takes the room's non-stdlib library-flagged elements and then skips the bundled library
      for good (src/library/full-library.ts:207-212; the joiner holds 1 library element against
      38,762 on the first peer; library typings read as unresolved, the conservative direction); the
      fix is for the loader to look for any `stdlib:`-prefixed element instead of any isLibrary one.
      (d) The SDK doc comment on `delete` (src/api/sdk.ts) does not mention that `cascade:false` now
      moves the kept children. [fence-roomlib; fence-coremodel]
- [ ] **Z3 constraint classes: wording and basis defects the class register records (rollup).** The
      class register (`docs/constraint-class-defects.json`) caps the maturity of the cells these
      touch; each is a sentence or a basis that is wrong or misleading today, pinned by goldens so a
      fix moves them on purpose: (1) `x ^ -1` is refused as "the exponent is not a literal"
      (`contracts.ts` tests the unary minus as a non-number); (2) `sum(...)`, `->forall(...)` and
      `Mode::x` print "a defect in the relation" (`expr.ts` has no call, quantifier or `::` node),
      and an enum comparison is `unparseable` (`verification/not-evaluable`, not forgivable) where
      docs/04 and the USER-GUIDE call it `unsupported-construct`; (3) a String-typed feature gets
      sort Real (`contracts.ts:485-502`), so a comparison of two strings is one of two reals nothing
      pins; (4) `bound.detail` says "decided by z3 5.3.1" on rows the numeric surface decided (`s.a
      == s.b`, "bus" vs "car"); (5) the `vacuous` detail names the premises where the unsat core
      names the goal's `side:` guard (division in the goal); (6) to probe, not a defect: the
      engine's `pinnedSymbols` pins a self-referencing equation (`x == x * y` pins x) and pins the
      right-hand defined feature of `assert constraint qa { L == M }` (8 probes h5-pin*), and
      whether either changes a `partialAntecedent` answer is unverified. [classes-2 S4]
- [ ] **Z3 constraint classes: abstentions left (rollup; sound, only weaker).** pinnedSymbolsOf
      leaves `L == M` unpinned (probes h5-pin2, h5-pin3, h5-pin5, h5-pinj, h5-pinl2, h5-pinl6,
      h5-pl5t, h5-pl7 in test/integration/verification.differential.test.ts); a defining row or
      assert read in an instance (element id `feature@path`) pins nothing, as in the engine, so such
      nonlinear sites read /free; the differential table reads 710 of its probes, and the
      `...standing(...)` (28), `...exchanged(...)` (16), `...ordered(...)` (4), a `reduce` spread
      and 12 interpolated probes are not read, so tableAgree/tableProbes under-count (lower levels
      only); a `--free` golden credits no nonlinear cell; the gate-layer pins of fence/unparseable,
      fence/unit-unresolved and fence/unscalable have no test, so those three read `unpinned`;
      text-as-real, bind-equality, per-instance, inherited-context and asserted-fact have no decided
      golden row, so they read `experimental`; the tool-absent census groups (consistencyCensus,
      refinementCensus, faultTreeCensus) and the early returns of checkBounds carry a statement with
      no script, or none, instead of the static classes with basis none; gate 4 has no statement
      when the clause is refused at the encoder or z3 is absent; a stood-down requirement's encoded
      sibling rows and a withheld refine component's encoded rows are not listed; the group
      statements for refine, fault-tree and consistency use basis solver whenever any outcome was
      decided, not per script; a scope:'run' statement lists the refused axioms of the whole run
      under `fenced` as partial context; the engine's pinnedSymbols self-reference over-pin (m9)
      stays 'to probe'; the generated doc prints each probe-pinned limit (m1, m4, m6, m7, m8) as
      'Observed once on a hand-written probe model' until CC-46 lands; the strict census step costs
      about 12 CPU-minutes (31 min wall at load 50), so a cheaper strict (one census process, or the
      recount alone) is a follow-up if the per-commit gate is too slow. [classes-2]
- [ ] **Abstentions left in seeds against an unread bound end (rollup; sound, only weaker).** (1) A
      feature that writes a value and is bound to an end under an unread scope reads ? even when
      every candidate end gives way to it or is valueless (with the end under `order`, k = 5.0 beside
      `q :>> a default = 16.0` and P2's `a default = 13.0` was right at base and is ? now; 648 + 438
      such cells in 44 + 30 of 1100 generated models); reading them would mean enumerating the
      candidate ends of the unread scope. (2) The fence covers every unread-scope kind (`order`,
      `twins`, `redefinition`); on the twins model SMT went from `inconsistent-axioms` to
      `not-evaluable`. (3) A usage-level `:>> k = 7.0` over a bound `k = 5.0` keeps its own binding
      F row; `u.k == 5.0` / `== 7.0` now read ? with the unread-end sentence instead of the
      binding-conflict sentence. (4) `bounds --measure u.k` (dotted path of a fenced feature) exits 2
      with `internal error: VerifyOptionError: --measure names nothing in this model: u.k` and a
      stack trace, where the qualified `RS::U::k` reads inconclusive [verification/not-evaluable]:
      map the unread-path error to the not-evaluable row (scripts/sysprose.ts bounds, boundsReport,
      src/api/verification.ts ~2700; probe fence-seed-scratch/review/b1.sysml). (5) Sweep coverage
      for the next round: the generator reads the seed only from package-level constraints; add a
      bare-name constraint inside the definition, the usage body and a subtype, and a nested part
      with a same-named attribute (probes fence-seed-scratch/review/n1.sysml to n10.sysml).
      Not generated: a unit on k, a bound end three or more redefinitions deep, a `calc` body read.
      [fence-seed]

- [ ] **Abstentions left in quoted names in expressions (rollup; sound, only weaker).** A quoted name
      is now a name reference on every lane and in the edit path; a feature whose declared name
      holds a dot is no longer registered under its dotted key. Left: (a) a quoted name that itself
      holds `.` or `:` is refused and every surface abstains (probe fix-quoted-scratch/dot.sysml);
      (b) `bareTie` (defining-equation.ts ~6861) and `NAME_TOKEN` (src/api/property.ts ~532) read
      plain identifiers only, so a quoted tie `'K x' == 'L x'` counts as a taint source (more
      abstention), and property.ts ~491 drafts a skeleton clause with the unquoted name
      (`max load >= 5`), which does not parse (probe rv/d1.sysml); (c) a check-behaviour atom
      `p=state 'deg A'` is answered INCONCLUSIVE "not read" where `state deg A` works (probe
      rv/bh/s1.sysml); (d) on the unit-aware path the info message for a refused quoted name starts
      with "a call, an index or a string literal" and gives the real cause only after a semicolon;
      (e) a `//` comment holding an apostrophe inside an expression now reads "Unterminated quoted
      name at N" where it read "Unterminated string literal" (both unknown; probe rv/cm.sysml);
      (f) `bounds --measure` and `--free` take the printed unquoted qualified name but not a
      spelling with quote marks (probe fix-quoted-scratch/bnd.mts); (g) a `::`-qualified reference
      inside an expression is unread, quoted or bare; (h) the default `bounds` measure and the
      instance labels follow name order, so a bare and a quoted-renamed model differ there (7
      corpus models); about 407 of the 637 corpus models were not run through the quoted-rename
      harness (fix-quoted-scratch/mm). [fix-quoted]

- [ ] **Abstentions left under the genericity audit of 2026-11-02 (rollup; sound, only weaker).**
      Metamorphic audit over the 637-model corpus (rename: 636 transformed; reorder: 634; wrap and
      instance: 637; identity run byte-identical; no decided verdict changed except the quoted-name
      entry above). (1) Order: which of two contexts of one constraint abstains depends on source
      order (r16-subject-dflt: `requirement r : R { subject s = p }` beside `satisfy R by p`; both
      are refuted by the model's meaning, each order decides one and abstains on the other); the
      numeric `solveFeasible` of brief-targets-by-layer flips from decided feasible to undecided when
      the members are reversed (propagation order; iteration counts move 2 to 3); the one code
      reported for a group with two causes (refinement-sibling-shortfall) follows source order; the
      per-instance rows are capped at the first 256 in source order. (2) Instance: a package-level
      `assert constraint px { h.p.x == 3.0 }` that imposes a value through a part-def instance
      (`part def H { part p : P; } part h : H;`) is not imposed, so `h.p.y == 7.0` reads ? where the
      same model with `part h { part p : P; }` reads violated; `bind w = hold_p.p.load` through a
      part-def instance is not followed (r14: w = 50 lost). (3) Label-only differences: group and
      instance labels, evidence footprint digests of anonymous binding connectors, the order of two
      names in a reason string. (4) Measures are chosen by NAME: `MOE_NAME_RE = /moe|measure|objective/i`
      in src/semantics/solver.ts, so renaming `totalObjective` drops its analysis-report measure
      row (not a verdict cell; a documented heuristic, to be replaced by an explicit marker).
      Probes: scratchpad genericity/{rename,reorder,wrap-and-instance}/ (harness batch.sh,
      harness.sh, compare.py; repros in the reports). [genericity audit]

- [ ] **Abstentions left (parallel machines and Simulate) (rollup; sound, only weaker).** (1) On a
      parallel machine where one region refuses and the others simply come to rest without refusing,
      `stopsRun`, `atRest` and `complete` stay false even after more ticks, so Play runs on to the
      sample cap (probe parser-pass-scratch/review/probe4.mts); no verdict is involved. (2) 162,
      195 and 280 were closed by a documented decision (docs/06 section 8.16 and the USER-GUIDE),
      not by code: the completion refusal for a count past the budget is permanent, the livelock
      pass cost (about 20%, 240 to 290 ms on the 9,641-configuration model) is accepted, and the
      Simulate trace stopping at a composite step's holding machine is the intended behaviour;
      re-add the entry with its original title to reverse one. [parser-pass]
      (3) 251, 173, 245, 170 and 191 were closed on 2026-11-03 under the standing instruction to
      continue, three by a delegated decision and two by measurement, and can be reversed by
      re-adding the entry with its original title: 251 (a satisfied requirement's require/assume
      clauses are goals; behaviour kept and documented), 173 (a room's copy counts as saved for the
      tab's close question while a peer is connected and the text is not dirty), 245 (a reference
      subsetting `::>` that declares no type is not read as a feature of what it subsets; the limit
      is stated as the tool's, reason unread-binding); 170 (a reset on v9 costs about 0.85 s now,
      the premise of 28 to 30 s is gone) and 191 (cold big-bind-1200 is 0.50 to 0.59 s; after an
      edit tree10 costs 2.3 to 2.4 times 7277a97, 3,070 per-instance rows against 2: a change would
      have to cut instanceSitesOf, readingContextsOf and the per-context name walk without changing
      a reading). A name read through an untyped `ref part p2 ::> p1;` stays unread on every surface
      (probes decisions-pass-scratch/p/ref2.sysml, nref.sysml). [decisions-pass, cost-pass]
      (4) Rulings of the 2026-11 merge of misc-pass, numeric2-pass and reads2-pass, closed by a
      documented decision and reversible by re-adding the entry with its original title; to confirm:
      'Contain a throw in a relation's own context walk' (183) closed as permanent (the throw is
      contained since instance-pass; a failed asserts listing abstains until the next edit, see the
      per-instance rollup item 3); 'Seed the literal engine from the check's other violated binding
      rows' (264) closed on evidence of absence (78 neighbours of r14, mapper-mi1, mi1d and mi3 in
      both text orders plus 7 added shapes: no row decided beside a violated binding or clash row;
      the 10-model test in semantics.evaluate-model.test.ts fails if one ever is); 'File a violated
      row for the contradiction SMT reports in UB6 and W4o' (263) stays narrowed to UB6, pending a
      ruling that UB6 is permanent. 217 closed (done for a bare bound on a unitless Real) and 219
      closed as obsolete (x6n proves both instances on 514f547). [merge-c10]
      (5) Rulings of the 2026-11-04 round 9 (small-pass found nothing closable by code), closed by a
      documented decision and reversible by re-adding the entry with its original title; to confirm:
      'Give the own-sibling finding its own validation rule' (238) closed with `redefinition-own-sibling`
      staying a warning (a warning exits 0 and mbse-workflow never routes it to repair; the corpus and
      v9 have 0 hits; raising it to an error is a one-line severity change plus the catalogue, the
      USER-GUIDE and the test expectations; probe small-pass-scratch/a.sysml); 'Say why a default
      stood on the rows `standingDefaultSentence` still does not reach' (277) closed because no
      reachable row is known (probes G1-G12 of wording-pass; a specialiser context may override the
      names the sentence would speak about, so saying it there could be false); re-add it if a
      reachable group row turns up. [round 9]

- [ ] **Abstentions left in the order of listings (rollup; sound, only weaker).** (1) validate()
      lists its diagnostics ordered by element id, so a page, a terminal and a peer list the same
      findings in different orders (probe wave3-probes/fence-order/gen.mts with the `.sort()`
      removed, 150 seeds, 59 cells; fence-order-scratch/gen-unsorted.mts and vo.mts). It is sorted
      but not stable across loads, not a wrong answer, and pre-existing; a stable order would need a
      text-order sort key in validate.ts. (2) `typesOf` order decides a name between a redefined
      feature and its typing (the Q2/P2 model, test/unit/semantics.evaluate-model.test.ts around
      line 6856); the pinned abstention stays until the user decides it; core-pass added no new
      abstention. [fence-order review; core-pass]
- [ ] **Abstentions left in the editor's copies (rollup; sound, only weaker).** fence-copy: (1) an
      implicit copy hiding an override: the forward member order of a nearest-N chain (D1 and D3
      bind N, D2 overrides, 54 of 120 gen2 models and 3 of 160 gen1 models), a diamond or clash of
      defaults with a definition-level bind, and a usage-level bind over a chain of default
      overrides now read ?/?/?/? where the base read a decided value (162 of them wrong, the rest
      right by luck); the reversed order reads correctly (the counts are from the first report and
      exclude the `=` forms the later fence adds); probes fence-copy-scratch/gen2/h2_*.sysml,
      gen1/g1_*.sysml, t/a1.sysml, t/a3.sysml, sweep-dry/editor/repro/w1.sysml and w3.sysml. (2) A
      part usage that has its own `:>> N = 20.0` beside a `bind` in its body reads ? where the base
      decided correctly (fence-copy-review/p/k11-usage-override.sysml: c15 F and c20 T at base); the
      fence cannot tell it from the diamond without reading usage-level overrides separately. (3)
      mapper-me9 `part def S :> Q2, Q3 { bind p.load = L; }` where both lines write the same 50.0
      with `=` is a fenced scope, and its two instance rows (P::c in S::p, P::c in s::p) are no
      longer listed; the agreeing-values case could be read. (4) The whole-model SMT lane abstains
      on a model that holds a withheld scope, so one fenced bind loses every SMT proof, not only the
      rows that name the scope; a per-scope SMT withholding would be a separate change in
      src/semantics/smt. fence-copy2: (5) a stale copy beside a live feature of the same name in a
      type the copy's owner specialises (D1's `N` stale after `Subclassification D1 -> Q0` is
      deleted, with D3 `:> D1, Q0` and `K2 :>> N`) now parts the usage's copy and withholds the
      usage's whole scope, so the page reads ?/?/?/? where the file decides F/F/F/F, and unrelated
      names of that usage (`u1.Zb == 1.0`) are withheld with it; 204 of the 420 cells it withdrew
      were right by agreement with the file; probes fence-copy2-scratch/probes-saved/gen.test.ts
      (cases both-bx-D1-f-e2, both-bo-Q0-f-e4) and gen-fin.json. (6) The numeric lane still reads
      `t` (imposed) through a stale name the file leaves unresolved (the rename-away shape; never T
      or F), generator 2 case def-n-f-s0. (7) A rename asks the owners of a feature's redefiners
      only when they are not already specialisers of its owner, so the cost for the ordinary case is
      unchanged. (8) A live-aware endCopyFeature (a lookup that skips stale copies in
      resolveInherited and findTypeFeature) would let the page decide where it now abstains; it
      needs a bind.ts change to childNamed, which the page's other readers share, so it is over the
      40-line fence. subsetting-pass: (9) a rename of the feature an implicit end copy redefines,
      and back (N to M and N), leaves its binding parted, so the page abstains where the saved file
      decides 15 (test/unit/store.reducers.test.ts, 'a copy lands on the nearest override…', the
      `weaker` step). (10) A diamond (`D3 :> D1, D2`) and a clash (`D3 :> D2, D2b`) of overrides
      under an end copy stay fenced on every surface (pins copy-nearest-diamond,
      copy-nearest-clash). (11) 'A stale copy two types up hides the feature the file binds': the
      page now decides F on three lanes and abstains on the SMT lane where the file decides F/F/F/F
      (test/unit/store.reducers.test.ts). (12) Six editor-soak seeds fail pre-existing, identically
      on add25f6: `SYSPROSE_RT_FIRST=<n> SYSPROSE_RT_SEQUENCES=1 SYSPROSE_RT_STEPS=6` at n = 1120,
      1618, 4318, 4992, 5045 and 6751 ('a full settle of the freshly loaded model moved 1
      redefinition(s)'). [fence-copy; fence-copy2]
- [ ] **Abstentions left (wording and refusals) (rollup; sound, only weaker).** (1) `bounds
      --measure` lists an instance-qualified `::` path (A7::q2::p::extra, N::Q0::p::load) under
      'Readable here' but accepts only the dotted instance spelling (q2.p.extra): a
      readable-list/accept mismatch, loud exit 2, never a wrong answer. Probe: `npx tsx
      scripts/sysprose.ts bounds review-2026-10-14/A/probes/a7-body-binding-default.sysml --measure
      A7::q2::p::extra`. (2) A violated group row (F7) where a default stood and a violated
      specialiser-context row have no 'why' sentence (no reachable shape found; wording only; see
      'Say why a default stood on the rows `standingDefaultSentence` still does not reach.'). (3) An
      assert-only requirement files no requirement row (policy; see 'File a row, and say so in
      contracts, for a requirement whose only body is an assert.'). [wording-pass]
- [ ] **Abstentions left (defaults) (rollup; sound, only weaker).** (a) Agreeing valued members are
      read only as exact constants, so a name-reading side such as `L == K * 2.0` against `M = 3.0`,
      and a package head (#), still read two-values (probes defaults-pass-scratch/m218b, m218). (b)
      A context row `P::c in W::q::p` reads unknown beside the satisfied instance row when load has
      no value, and the differential harness throws two check rows on it, so probes need a default
      on load (defaults-pass-scratch/x6a.sysml, pre-existing). (c) Rows `P::c in W::q::p` are absent
      when the definitions are written W, Q, P with a default on load
      (defaults-pass-scratch/m218/G009-eqT.sysml; same on base, probably the existing 'File a
      definition's context row under one name' entry). (d) The typed-inequality hold is by feature,
      so a `P::L` held by a typed assert in one instance also holds p2's L where the assert sits in
      a usage only (weaker, never false; test/integration/verification.differential.test.ts
      'typed-ineq-*' rows, scratch review/m7/T1..T10). A typed assert whose parameter is bound with
      `bind x = L` is NOT an abstention left: it is held (fixed in the review of 'Hold a feature an
      assert typed by an inequality-only constraint definition constrains'). (e) An enclosing assert
      naming a binding-carried feature (A2E q2 p.load >= 0.5 over bind p.load = L;
      defaults2-pass-scratch/p6/se-none.sysml, differential A2E-enclosing-assert and
      stand-enc-bound), an enclosing assert on a valueless feature, and = plus a redefinition of
      that = under an enclosing assert (stays unknown through the existing #bind contradiction;
      gen211 models G60, G72, G96) still abstain. (f) Literal X on generic rows of a file whose
      instance contradicts a default under an enclosing assert
      (defaults2-pass-scratch/review/m2/with/MM10.sysml, MM88.sysml; 9 cells in 2 of 240 probe
      models; sound). [defaults-pass, defaults2-pass]
- [ ] **Abstentions left (per-instance binding chains and context walks) (rollup; sound, only
      weaker).** (1) A binding chain deeper than 48 usages (chain49/chainPkg49 and the cap rows at
      depth 49): the check and literal engines abstain; on chainPkg49 posF the SMT surface also
      abstains ('?/?/F/?'), and numeric reads it (probe instance-pass-scratch/gen221/g66-new.jsonl).
      (2) A usage-body binding chain at depth n=33..~46 (the CHAIN shape of
      semantics.evaluate-model.test.ts ~8777, review/enc66.mts): the check and literal engines
      decide, with values correct against a hand oracle, while SMT abstains from about n=34..40
      because obligations.ts MAX_NESTED_BINDING_DEPTH stays 32 (independent of MAX_BINDING_SEGMENTS,
      48); before the cap raise all three abstained from n=32. (3) A failed asserts listing stays
      failed for the revision; ruled permanent in misc-pass (it abstains; a retry inside a revision
      would mix caches built while the listing failed with a later complete one; reopen only if a
      throw is seen to be transient). (4) A
      relation whose own context walk throws gets no per-instance rows at all; one internal row
      stands for its other contexts (test semantics.evaluate-model.test.ts, 'own context walk';
      probes instance-pass-scratch/gen221). (5) The 193 anchor abstains and the finding stays at the
      instance's own usage: when a derived value reads a redefinition outside the instance's own
      elements beside the instance's own input (m7j), or when the instance states two numbers a
      derived value reads (M7b); also a derived value read with no via (PB), a redefined value that
      is derived or carries a unit (G5c), a context row that is no group, and a row with no read at
      all (probes scratch/naming-pass-scratch/pb.sysml, nb12.sysml). (6) A reference valued with
      another reference inside a nested usage with a binding into the last one (`ref r = q`, `ref q
      = x`, bind sub.x.load = K) still abstains (reads-pass-scratch/g179b shape twoRefs; already the
      'two steps of standing-for' entry); a reference valued with a feature AROUND the instance that
      a binding reaches into (X17's `r = s`) still abstains (g179b/g179c enclosing); a part valued
      with a package part under an assert that reads a feature with NO value, or that mixes a valued
      and a valueless feature, still abstains (g206 xform none); a part valued with a package part
      whose types the partner lacks (`p : P2`, other : P) still abstains
      (reads-pass-scratch/man/b.sysml); a reference read to depth one is fenced, but a name through
      two chained references, `bind sub.r = o2` where r is a reference valued by an
      attribute-structured part, and a part-valued binding whose reference lives in a library part
      are unprobed (reads-pass-scratch/review/p/miss2). (7) A package-level end's redefinedClosure
      still differs by text order when several definitions each own a chain bind and the end is
      below the 48 cap: closure differs below the cap, no verdict moves. The cappedDefs fence covers
      only ends past the cap. Probes: ep-review/fuzz.mts and ep-review/genm.py with out/mnew
      (150-model fuzz: 25 closure differences on editor-pass, 0 with NOKI=1). [instance-pass,
      naming-pass, reads-pass, editor-pass]
- [ ] **Abstentions left (keywords and metadata annotations) (rollup; sound, only weaker).** (1) A
      bare-keyword ambiguity is asked in the nearest scope with imports only, a qualified
      `#Pkg::name` is never asked, and an alias or inherited member is not enumerated
      (src/semantics/keywords.ts ambiguousKeyword). (2) An ambiguous foreign-aliased keyword is
      filed `foreign` by `contracts --keywords` and never raises verification/keyword-ambiguous (see
      'Report an ambiguous keyword as ambiguous (optional).'). (3) A library-typed annotation's body
      redefinition stays textual (probe subsetting-pass-scratch/s2/md4.mts; see 'Resolve a metadata
      body redefinition (optional, low).'). [subsetting-pass]
- [ ] **Abstentions left in renames and name clashes (rollup; sound, only weaker).** fence-rename:
      (1) names unrelated to the clash inside a flagged scope are withheld along with it (e.g.
      `w.p.x`, or an unrelated `a = 15.0` beside a clash on `b`), because the fence is the whole
      owner scope, as for twins; a per-name NameClash via DefiningEquations.clashesIn would keep
      them (probes fence-rename-scratch/gen/g007.sysml, gen2/h000.sysml). (2) The SMT lane proves
      and refutes nothing anywhere on a model that holds an `order` scope. (3) Equal-name pairs
      where one feature carries content of its own and neither stands for another name are not
      fenced (existing clash and diamond handling covers them, DM2, DN2), nor is the pair where one
      states a value and the other holds nested content (no probe); two plain values of one name
      from unrelated generals are left to the name clash. (4) DefiningEquations.clashesOf skips a
      pair when the other's value source lies in the kept one's redefinedClosure, so a valueless
      same-name redefiner beside a valued one clashes in one order and not the other
      (gen2/h005.sysml); a symmetric comparison would be the proper fix, the `order` scope withholds
      it. (5) Four battery models show label differences only, #binding or #clash (m31_001, m31_086,
      m77_028, m77_082). (6) Cost: unreadScopes on the 160-level lattice is 3.3 s under load against
      17 ms at f39e88a; children() calls per unreadScopes grow quadratically with depth on a chain
      (1678 at depth 30, 6043 at 60, pre-existing); no guard test exists for unreadScopes cost.
      [fence-rename]
- [ ] **Abstentions left in Save of an end (rollup; sound, only weaker).** fence-text: the end is no
      longer written by a name where the next load would read another member, so the statement is
      saved as a `// Not saved:` note instead. Shapes: a named end behind an earlier member of its
      name (chain statements: any earlier member that goes by the name, including an unnamed `:>>`;
      others: an earlier member declared by it), and a lone unnamed redefinition for allocation,
      succession, transition, dependency and alias (probes fence-text-scratch/gen.mts and b2.mts;
      pinned in test/unit/text.roundtrip.test.ts, NAMED_BEHIND and the non-chain lone-unnamed
      loops). fence-order: Save leaves out, with the `// Not saved:` note, a
      requirement-relationship end or an inline specialization target that is the 2nd or later
      member of its name in its owner, where a renaming or reordering would save it (probe
      wave3-probes/fence-order/gen3.mts, 144 of 240 neighbours). [fence-text; fence-order]
- [ ] **Abstentions left in the order of listings (rollup; sound, only weaker).** (1) validate()
      lists its diagnostics ordered by element id, so a page, a terminal and a peer list the same
      findings in different orders (probe wave3-probes/fence-order/gen.mts with the `.sort()`
      removed, 150 seeds, 59 cells; fence-order-scratch/gen-unsorted.mts and vo.mts). It is sorted
      but not stable across loads, not a wrong answer, and pre-existing; a stable order would need a
      text-order sort key in validate.ts. [fence-order review]
## Behaviour checks and the palette's checks lane — review 2026-10-14

From the reviews of the behaviour lane (reach and check-behaviour in the palette) and of the ux
merge. The branch `behaviour-sound` (merged by `e0d8040`) closed the completion budget, the nested
`state def`, the method text and the completion livelock (C1, H2, C3, H1, M3, M1, U1); the entries
tagged `[O1 …]` are what its steps and reviews left open.
      (8) A bind written in a package other than the one that declares the instance (nested,
      sibling, outer, `Lib::top.L`), on a package-level feature joined by that package's own
      binding, or on a definition head (`bind T1::L = XX` beside T1's `bind load = L`) was ignored
      by the check, literal and numeric lanes (the default was read: a true constraint read
      violated). Fenced by fence-pkgbind: the default gives way to the bind and the check and
      literal engines abstain with their own sentence (cap kind `package`); the numeric and SMT
      surfaces decide what they can read. Cost, all sound abstentions: the unbound second instance
      of the same definition (`top2 : T1`) abstains too; a direct feature bound across the
      package abstains where it read correctly before; rows right only because the default and the
      true reading agree now abstain; the SMT lane abstains on an F row where the witness gate
      demotes. The proper reading (joining the instance's own context to the definition's
      binding) stays open. Probes: ep-review/v/s3.sysml, s7.sysml, s11.sysml, s12.sysml and
      fence-pkgbind-scratch/gen4/pkgbind-*.sysml. [editor-pass review; fence-pkgbind]

- [ ] **Walk a step written over inherited states.** A control edge written outside a machine's
      region that touches one of its states refuses both machines (`machine-boundary`, `docs/06`
      §8.6, §8.14): `state def Derived :> Base { transition bc first b accept more then c; }` and
      `exhibit state m : Modes { transition ... }` refuse `Base`/`Modes` and the specialisation.
      Kept on purpose: the interpreter reads a machine's own region only, so a run of `Derived` has
      no state and a run of `Base` never takes `bc`, and a joint walk would claim runs no simulator
      takes. Done when `regionDescendants` and `regionTransitions` of a specialisation or typed
      usage list the inherited states and transitions for the walk AND the interpreter together
      (ids, `hierarchyPath`, atoms, the edge census, what a redefined state or transition means, the
      properties a base carries, the names a report prints), with the witness replay green over
      them. [behaviour-small S1]
- [ ] **Revisit `validation/constraint-by-instance` after one workflow run on a model with instance
      groups.** The rule (`src/validation/rules.ts:1118`, the 27th) is non-blocking, with a
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

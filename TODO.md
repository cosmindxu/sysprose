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

- [ ] **Narrow the literal engine's contradiction reach to the instance the violated assert
      reads.** Since instance2-pass S4 (literal-reach) the literal engine reads a contradiction (a
      violated assert, a violated binding, a pair that meets in a usage) in the instances it is read
      in, and in every one an axiom of its component carries it to (a package's `bind q1.p.x =
      q3.p.x`). These rows read their ref (T/T/T/X): q2's p in refute-r1, R1D, H1C, H1F2, R1U, Q4B,
      SEV and SEP; q1's p in H5B and HLX; PIN3's t4, PIN5's t0, SP2's and SP2N's kq, RB4's and RBB's
      top2, G340's ctlA, g5's ta; Q5F1's and BU's p2 rows. Still abstaining, all sound: a
      definition's own row, and one read for a usage a definition holds, which stand for the
      violated instance (P::c and Q::p of R1, R1D, H1C, H1F2, R1U, Q4B and H5B; PIN2/3/5, PA, PA4,
      PL2/5T/6/7, HQ, HQ2, SFW, N4T, N5, R27F's Q::c; Sh7's T1::a and T2::b::a; VCS::k through Q's
      p); a reading in the same top-level instance as the violated one (w.qb beside w's `part :>> qa
      { assert … }`); an assert whose own generic row the check reads `?`, which seeds every
      instance (bound-vc-inst k2/kr, a1's k2); a pair met in a definition through a part
      (bind-through-part, -two-parts, -inherited-part: BQ/B2/BS u50 read X); an equation of two
      contradicted sets; every row of a model where an instance may stand for another (a reference,
      a subject, a part binding, a subsetting, a `satisfy`, a part valued with another); a sum that
      ties a sibling (CVSIB::tb); an assert the worklist leaves unencoded because of an operator (`x
      % 4.0 >= 2.5`) or reads only in part, which leaves the whole file undecided on the literal
      engine although SMT decides (the `unread-assert` fence; probe v2-refused-axiom-inst-ok); `x ==
      L` with L an unplaceable outer name (lex-lr1 Q::c, topT, topF read `?`). Done when those read
      their ref or are ruled permanent. Ruled permanent 2026-11-05 (the rollup 'Abstentions left (parallel machines and Simulate)' item (6)): SMT reporting `inconsistent-axioms` file-wide (g5, g4, a1, k2 on SMT) in a model that contradicts itself (decision 1). The
      numeric surface's whole-model solve still meets the pair and does not converge; since instance3-pass S3 its sentence names the pair.
      [contradictory-models S1, S3, review; instance2-pass S4]
- [ ] **File a row, and say so in contracts, for a requirement whose only body is an assert.**
      Ruling made 2026-11-05 (maintainer): file a requirement row whose verdict is the assert's own,
      so contracts and obligations agree on the clause count. contracts no longer says "prose only"
      for R1::R, R1::r and RU::r: it names the asserted body as a fact of the model, not a clause
      (wording-pass S1; USER-GUIDE status-column paragraph reworded). R1::r already files a
      no-formal-clause row on obligations and verify, with a sentence naming the assert. Left to
      build: the definition R1::R and a requirement usage whose only body is its own assert (RU::r:
      `requirement r { subject s : P = x; assert constraint ca { s.L == 50.0 } }`) file no
      requirement row, because obligations.ts adds the asserting owner to withClause (:619/:655);
      file one with the assert's verdict (`verify` then exits 2 where such a model exits 0 today),
      make contracts and obligations agree on the clause count, fix `emptyClauseLine`
      (scripts/sysprose.ts) and the USER-GUIDE paragraph. [wording-pass S1]
- [ ] **Narrow the abstention over two disagreeing asserted equations (optional).** Since
      instance2-pass S2 (contradicted-pair-meet), a pair that meets in a usage taints that instance
      alone, and a usage that subsets or redefines it: one equation in P and one in `part p : P { …
      }` leave p2 : P's L read at P's equation on the check (`q5-f1`'s `u50`, c6-use's `p2.L`: T,
      and F with the two values exchanged). The literal engine now decides these too (Q5F1::u50
      T/T/?/X; BU::u50 and BU::v50 the same). The numeric surface's whole-model solve still meets the pair and does not converge there; since instance3-pass S3 its sentence names the pair, and also on the through-part siblings
      (BQ::u50, B2::u50 and v50, BS::u50: T/X/?/X, where the literal engine reads X). Still
      abstaining, sound but readings lost: a pair that meets in the feature's owner (P, or a
      specialisation: G2's P2), read in a usage whose `:>> a = 25.0` makes the two agree; two usages
      that each contradict P (every P's L abstains again); a value the pair reaches through a dotted
      name or a relation outside the instance (P's `bind s.M = L`, `attribute M = p.L`, a package's
      `bind w2 = p2.L`), which taints every instance; a P nested in the contradicted instance
      (`p.inner.L`); a side over a name a binding joins; a definition's own rows over a usage
      it holds, and a value over a dotted name (`Z = p.L` in Q), which stay undecided in every
      instance of a pair that meets in a usage.
      [contradicted-value S2]
      The FMI `start` and the Solve measure value inherit this breadth (text-order S2): `part def P { attribute load; assert constraint c1 { load == 1.0 } }` with `part def Q { part p : P { attribute :>> load; assert constraint c50 { load == 50.0 } } }` takes P::load's start from 1 to the type default 0 (marked in the variable's description) while only an instance elsewhere contradicts it (also r8-redef-novalue-assert-dflt, S4_N_PP, S4_N_PU). A literal written beside a contradicted pair keeps its start in both orders (`attribute L : Real = 5.0;` beside `L == 50.0` and `L == 60.0`); decision 14's removal in wave 3b settles whether an asserted equation overrides a written value for an export. [text-order S2]
      A pair on the two ends of a binding met in a usage (c6-use) now reads p2.L; one filed at P
      beside the larger set at a specialisation P2 (G2) still taints every P. [contradictory-models
      S3]
      Ruled permanent 2026-11-05 (the rollup 'Abstentions left (parallel machines and Simulate)'
      item (6)): a pair made to agree by a usage's `:>>` (the pair that meets in the owner), and the
      breadth of FMI `start` (readsContradictedDefinition stays feature-wide). Left: the
      shapes above. Since instance3-pass S3 a bare number beside a quantity of the feature's kind
      is one value in the kind's coherent SI unit (q5-unitagree-ab T/T/T/T; -ba T/?/T/?: written
      second, the bare equation is refused on the literal and SMT engines, derived-bare-literal). A
      feature that declares a unit other than its kind's coherent SI one (`L : MassValue [g]`) is
      defined by no bare equation on the check, literal or numeric surfaces (`declared-unit`); the
      SMT engine reads it in the declared unit.
- [ ] **Read a usage that subsets a feature an instance reads otherwise in that instance.** Since
      instance3-pass S2, a usage that is the subsetted feature again is read below in each context
      that redefines it, as one of that context's p1s (rerootedSubsettings and subsettedIn in
      src/semantics/defining-equation.ts). Such a usage has p1's kind and type, says nothing of its
      own, is neither a ref nor an attribute, has nothing else redefining or subsetting either, and
      no binding end or asserted equation names it. Results: sa7 `W::c` T, `W::c in w` F, k and k1
      F, w0.p2.load T; V7, SA7D, SA7B and NQ3 decided; bounds of w.p2.load is 50. Still abstaining
      (sound, readings lost): a reading of p2 itself (sa3's `satisfy RF by p2`, a package's
      `satisfy RF by w.p2` / `v.p2` (O2), a subject's or reference's value `= p2`); TC8's
      T1::sub::tc (a T1 that adds features is not p1 again, and no lane files a row for w's p2's
      sub); RFN refine and fault-tree still inconclusive (they need the per-instance satisfy read,
      176's satisfy half); `::>`, nested (SA7N), chained (SA7C), attribute (SA7A) and sibling
      subsetters; a binding end or asserted equation naming p2 (VB, AX, PX, AE3, AE4; the design's
      asserted-step change was not done); a context that reads p1 otherwise without redefining it
      (RQ4's satisfy context, SA3S and RE3's `q :> s`, a binding from above). Brief done-when items
      not met: TC8 T1::sub::tc (T for T1's own sub, F for w's p2's), RFN refine `refined` with exit 0
      and fault-tree `{RF}` with exit 1. [subsetting-pass S1, branch review; instance3-pass S2]
- [ ] **Report a model that contradicts itself through a subsetting usage.** Since instance3-pass S1
      an `assert` read through a usage that subsets a feature an instance reads otherwise is read
      again in each such instance, the usage re-rooted onto that feature: W's `assert constraint a {
      p2.load <= 5.0 }` over `part p2 :> p1;` beside w's `part :>> p1 { attribute :>> load = 50.0;
      }` files `W::a in w` (F on the check and the numeric surface, `sysml-check --strict` fails)
      and an axiom of its own, so the SMT engine reports inconsistent-axioms on every row (v11:
      `w.x <= 5.0` T/T/T/X); where it holds in w every row is decided (V11H). Only where that is
      the usage's value: the assert written in the element both are features of, naming the usage at
      the head of a dotted name, the usage subsetting that one feature and saying nothing of its
      own, nothing else redefining or subsetting either. Since S2, beside a usage read below as p1
      again, W's own row of the assert reads W's values (V11 `W::a` T/-/T/-; AI's `W::a` F/-/F/-,
      which strict reports), `W::a in w` stays F (AI: T/-/T/-) and SMT stays X (AI's k, k2
      T/T/T/X). S1's reread applies now only to the shapes the walk does not re-root (`part p2 : T1
      :> p1;`, an equation over p2). Left, sound: every other shape makes the SMT engine decide no
      row of the file (`not-evaluable`), the check abstaining as before: an assert reading the usage
      through a value or an asserted equation (`y == p2.load`, AX), a package assert through
      `w.p2.load` (PX), a `::>`, an instance that binds the subsetted feature (`bind p1.load = K`),
      an assert of the usage's type (T1's `tc` under `part p2 : T1 :> p1;`, STC), a chain or a usage
      with two supers, a quoted name an asserted equation spells, a multiplicity beyond one value
      (p1 or its redefinition `[2]`, p2 `[0..1]`, p2 with a multiplicity other than `[1]`), and a
      subsetting usage that says something of its own where an instance reads what it subsets
      otherwise (SV2's two loads; also where the other value is a `default` that gives way: SE's RF
      row, T/T/T/?). [instance3-pass S1, S2]
- [ ] **Spell a chained subsetting target as written in the subsetting sentence.** The Subsetting
      now keeps the path as written (`attrs.chain`), the sentence says "subsets `q.p1`" and Save
      writes `q.p1`. Left: the instance test still runs in Q for `part p2 :> q.p1;`, not in W with
      the path `q.p1`, so it over-abstains where only an unrelated Q instance changes p1; running it
      in W is a verdict-moving step (generator with a hand oracle first). Only a path with a `.` is
      kept; `Q::p1` is not. [subsetting-pass S1 review] Do it only with a pin-bump evidence re-mint: keeping `Q::p1` in attrs.chain moved v9's model-graph digest on 12 of 25 surfaces with no verdict move (text-pass-scratch/gate-S1-with-qualified-chain/v9.log).
- [ ] **Stop an in-page solver check from stalling or tearing the page.** N6 S4 runs the five
      solver checks in the page behind a queue and a mutex. Left: Cancel drops the answer but
      cannot stop z3, so the check ends at its own time budget and a Run started meanwhile queues
      behind it; a model edit during a run can give a torn read across awaits (the result lands
      against the click's revision and shows stale; documented, not snapshotted); an in-page check
      keeps no evidence record (`verify --record` is terminal-only); the encoding cost
      (`obligationsOf`, script building, `resolveFreeFeatures`) runs on the page thread, is not
      measured on v9, and has no long-task guard over solver checks. Cancel and the long-task
      guard each need a bridge or measurement change, more than 150 sound lines. [N6 S4, review,
      ui-pass S1]
- [ ] **Move the first Apply's parse off the page (P3, the rest).** N6 S5 builds the Chevrotain
      parser while the page is idle after the Text view opens, so the first Apply no longer pays the
      ~1.3 s build; the parse itself stays on the page and synchronous (`applyText`,
      `typedTextFirst`). Ruled permanent 2026-11-05 (the rollup 'Abstentions left (parallel machines
      and Simulate)' item (6)): moving the parse into a worker (the gain is 4-9 ms warm against five
      new ways for the page to differ from its text) and the parser build itself. Left: callers that
      parse before the Text view has been opened still pay the build at their click (opening a
      `.sysml` file, and the Drive guard's `typedTextFault` before the Text view mounted); the
      warm-up needs a second trigger on the Open menu, the file chooser and the text buffer paths,
      and it is best-effort, covered only by a unit test with injected dependencies, with no E2E
      that the stall happens once. [N6 S5, `docs/UI-ROADMAP.md` P3]
- [ ] **Make the frozen column-header strip read at the whole v9 Fit.** since N6 S1 a layered
      General view's column headers are a frozen strip along the canvas top. Since ui-pass S1 a
      column that no header or strip cell names at the zoom (whole v9 Fit, 1400x900, zoom about
      0.021, 16 of the 21 headers: bands about 1 px tall, columns 8 to 17 px wide) is named by a
      label that follows the pointer over it (`column-hover`; unit guard and an E2E on the real v9
      model). Left: the strip floats about 56 px below the canvas top (under the toolbar), so on a
      deep pan boxes show above the header that names them; when two pieces are closer than about
      22 px minus the band and gap on screen the next piece's cell can overlap the leaving one for
      a few px of scroll; the pointer label is mouse-only; the tutorial recordings that show that
      Fit with a resting pointer (videos 1 and 4 at least) may now carry a stray label: check the
      contact sheets of the next re-record or park the pointer outside the canvas. [review
      2026-10-14 D-7, N6 S1, ui-pass S1]

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
      Ruling made 2026-11-05 (maintainer): `qa in p2` reads UNKNOWN (A.5); P's own `qa` row stays as
      it is (checked sound, 'defines M = 2', the same convention as PIN3/PIN5); PA2 and PA0 are not
      pinned probes. Left to build, two pin changes and one sentence: change the ref of `qa in p2`
      from F to ? on h5-pina and h5-pina4, and add the USER-GUIDE sentence that says so. Probe:
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
      Ruled permanent 2026-11-05 (the rollup 'Abstentions left (parallel machines and Simulate)'
      item (6)): a call as a part's value (h5-ppcall, h5-r8expr; 219 item 2), the T side of a
      definition's own row (only F can be lifted; a finite list of instances cannot prove 'every
      W'), chains past the cap or cyclic ones, groups past the instance cap, a type-narrowing
      redefinition with its own value. The rest above stays open.
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
      Ruled permanent 2026-11-05 (the rollup 'Abstentions left (parallel machines and Simulate)'
      item (6)): (2), a call as a part's value; (1) and (3) stay open.
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
      numeric surface. Since names-pass its own row abstains (?/-/?/- naming the definition), and
      the literal and SMT surfaces abstain on every row of that model. Left: read the definition's
      body with the parameters' values, per instance (design 5(e)2 recommends ruling this
      permanent; the maintainer's ruling is pending).
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
- [ ] **Remove the last order dependences of the numeric solve (after numeric-curved).** The
      guide says 'bar two cases'. Each abstains in one text order and reads a value in the other,
      never a different verdict: (a) the digits of a value: a pin written to ten digits (`x ==
      0.000003000000001` beside `2.0 / (7.0 * x) - 95238.0952 == 0.0`) reads t/t equation-first and
      ?/? pin-first (review-2026-10-14/wave3-probes/numeric-curved/fix3-pm/D1, D2), a value taken
      through an affine link by finite differences, accurate to about 3e-11 (fix3-pg/G4 reads ?, G3
      and G5..G8 read t), and `y / 2.0 == 0.0` is solved to 2.9e-11 beside `z * y == 0.0`
      (solver2-pass-scratch/s5/A6x086, A5x092, A5x240). Fix: polish the affine Newton step or judge
      agreement both ways. [numeric-curved; solver2-pass S1, S3, S5]
- [ ] **Abstentions left in the numeric solver (rollup; sound, only weaker).** Each reads unknown
      where an answer exists; none gives a wrong answer. (1) designReadings withholds the whole
      component a curved equation links, where only what its root reaches need be withheld (`z` of
      `dz { z == 5000000.0 * q }`, `s == 4.0` over a stated `s = x * x`, every feature of a loop
      of definitions with more than one root), where the non-curved equations do not fix the
      component. (2) A lone curved equation is still published at the
      root found (`x * x == 4.0` alone: the FMI start, a measure of effectiveness). (3) A relation
      over a multi-root component that holds, or fails, at every root reads unknown (E4, n5-damped,
      y4); `solveFeasible` reads undecided where it was infeasible and the analysis report's
      `feasible` should then read undecided. (4) The freedom analysis's row order among the model's
      own equations (G33x067, CV10). (6) An odd power is read as curved (`x ^ 3.0 == 8.0` beside
      `x >= 0.0` and `x
      <= 1.0` reads ?/?, b635385 read T and F). (7) A root in the same gap as its pole between two
      of 0 and +-2^k is not found unless Newton reaches it from one of the fixed starts it is run
      again from (`1.0 / (x - 5.0) == 2.0`; `3.0 / (x + 1.5) == 10.0` is reached from -1). (8)
      `solveFeasible` starts its descent at one root of a curved equation: `x * x == 4.0` beside `x
      <= 0.0` reads undecided in every order though x = -2 is feasible (CV1, F11x005). (9) A curved
      plain constraint beside another left unused is withheld where the other equations do not fix
      the point alone (`x / y == 3.0` beside `y == 2.0` and
      `x == 6.0`). (10) Cost: `fixedByOthers` is rebuilt per curved equation, quadratic per
      component (about 1.2x b635385 on a chain of 400 with a curved leaf per member), and
      `optimize()` re-solves without a cache. (11) V2/V4/V5 (a valued L through a package head, fixedHead): entailed; the check and literal
      half to design-readings SLOT1 (probes fence-numeric-scratch/rev/v2.sysml, v4, v5). E1Q is
      fenced by a5 F3 (pin stand-gw-e1-slot ?/?/?/?). (12) An FMI parameter or input
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
      taken (the `if ... ? ... else ...` spelling now parses on all four surfaces (a5-std S2), so the fd probe can be written in either form; N3 reads it); (e) dividesByNearZero is absolute in SI, so a free divisor below 1e-6 loses its witness
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
      (probe t5/hc1.sysml).
      solver2-pass: (k) a tautology's own row over a feature nothing fixes reads numeric `?`
      (`assert
      constraint t0 { x - x == 0.0 }` alone; solver2-pass-scratch gen G1x004); (l) a curved equation
      that does not read its unknown at the model's values (`x * x * w0 == 0.0` at a stated w0 of 0)
      abstains, in one text order only in a contradictory model (gen G2x085, G2x089, G2x012); (m) an
      identity whose side divides by a feature, takes a remainder or raises to a non-literal power
      (`y
      / z == y / z`) is still gathered and abstains (probes solver2-pass-scratch/f3.sysml,
      f14.sysml,
      h1-h5.sysml); (n) a sum like `2.0 [m] == 2000.0 [mm]` or a numeral past 15 digits is not taken
      as the same polynomial; (o) a quotient set to 0 beside another over the same divisor (`b / u
      ==
      0.0`, `w / q == 0.0` beside `w / q == y`) reads imposed or T in one text order and `?` in the
      other (solver2-pass-scratch/s3/Q1x113f.sysml, Q1x113r.sysml, Q2x083f.sysml, Q2x190f.sysml);
      (p)
      a plain quotient over an asserted zero divisor (`A z == 0.0` beside `r / z == q`) reads `?` in
      one order and T in the other (s3/Q2x156f.sysml, Q2x156r.sysml); (q) an affine core past 32
      features or with a coefficient that is a feature's value (`k * x`) is read as before; (r) the
      286(a) digits cases (s5/A6x086f, A5x092f, A5x240f); (s) a definition's own row reads `t` where an
      instance's facts refute it (adv/genpin: `P::ck` ?/?/F/? before P-pin, ?/?/t/? after; definition
      rows only): the F side is liftable by reading an instance's refuting F onto its
      definition's row.
      [numeric2-pass; solver2-pass; closing-readings P-pin]
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
      abstain even where the reading would be right (pin sub-rv1-diamond k2; corpus model e1-subset; since instance3-pass S2 sub-sa7 k1 reads F/F/F/F and nq3's rows F/-/F/- and -/F/-/F); a sound per-instance skip needs
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
      the SMT lane; `bounds`, `consistency` and `refine` carry it too): (12) an asserted inequality over such a default that is not a bare bound stays refused: a sum or multi-name inequality (`L + N >= K`) under the generic sentence, and a bound with a `[unit]` or on a unit-bearing feature or a restricted-domain sort under a sentence of its own (a5 K3 carries Integer bounds, refusing a pair that leaves one whole number, and files a conjunction read in a context as its conjuncts; probes a5-k3-unit, gen_k3 shape unit); (13) a
      usage that redefines the default itself (`part q : Q { attribute :>> L default = 9.0; }`)
      beside bounds abstains where the hand oracle could prove (20 cells: reads2-pass-
      scratch/gen217b/models/m45f.sysml, m46f.sysml, m52f.sysml); (14) bounds linked through a
      derived relation are refused whole, including a lower and an upper bound in the same component
      of a linked group (B5, B7: review-scratch/pr/b5.sysml, b7.sysml; pinned stand-gw-ineq-derived,
      -derived2); (15) a scoped worklist (`obligationsOf` with scopeId, the Checks 'Obligations'
      listing) may carry a bound the whole model refuses as meeting (review-scratch/scope.mts;
      sound, the partner is no axiom there); (16) a usage that subsets a feature an instance reads
      otherwise, narrowed by instance3-pass S2 to the shapes still fenced (TC8, AE3, SA3, O2, RQ4, SA3S, RE3, RFN, and the `::>`, nested, chained, attribute and sibling subsetters) plus a name an asserted equation spells with a quote and a multiplicity beyond one value (sub-sa7 and sub-def-sa7d now read) (TODO 241, skipped: the per-usage taint `subsettingsOtherwise`, `spreadOtherwise`,
      `satisfierTaint` feeds about eight readers; probes sub-sa7, sub-sa3, sub-sa5, sub-def-sa7d,
      sub-tc8 and the AE3 shape `w.x == w.p2.load` in a package). (17) solver2-pass S2: since a5 K1 the check reads a conjunction as false where a conjunct is false before a gate-refused one (probe solver2-pass-scratch/s2/x25c.sysml, split twin x25s.sysml; the K1 line (18) below lists what stays weaker); `refused and false` stays a
      refusal while `false and refused` is false (KerML control order; a5 F6: an unknown is
      absorbed only where it is a value the model does not give); a conjunction typed by a constraint definition is not split, by design; since a5 K2 an asserted conjunction a gate refuses whole is filed as its conjuncts and gathers its conjunct inequalities (bra2 = bra2s), but a clause instanceRows reads per context, one that mixes a [unit] literal and a bare number, a conjunct inequality over stated or fixed values whose clause the check does not hold, and the literal engine's read of a refused conjunct stay as weak as the whole conjunction (a5-conj K2 probes k153, k287). (18) a5 K1 (sound but weaker): a conjunction a gate refuses still abstains where (a) a refused or ill-typed conjunct comes before the first false one (`refused and false`, P under F6), (b) the body is right-nested (`a and (b and c)`: conjunctsOf does not cut it), or (c) the surface is numeric (S1 `p.L <= 5.0 [kg] and p.E >= 1.0`, shortCircuit andBare F/F/?/F: the solver refuses the whole relation by gate (e)); K2/K3 or solver-order may lift (c). Exit move: a file whose conjunction is false before a gate-refused conjunct now exits 1 (refuted) instead of 2, because literal and SMT follow the check's violated (pinned: shortCircuit::andBare; bounds-refused-axiom.sysml capB). (19) a5 K2 (sound but weaker): K2 reads as its split twin only an asserted conjunction filed at the model level or through instanceRelationRows, and is never stronger than the twin. It stays weaker where (a) a clause whose relation instanceRows reads per context, or that has shared rows, is filed whole; (b) a body writes a [unit] literal beside a bare number (mixesUnitRegimes, by design); (c) feasibility leaves a conjunct inequality over stated or caller-fixed values to its clause's whole row unless the check reads that clause held (`x <= 3.0 and y >= 1.0 and mode != "manual"` with x valueless, k153); (d) the literal engine reads a refused conjunct as held only where the check holds its whole clause (k287 pkg g3: T/?/T/T against the twin's T/T/T/T); (e) instance conjunctions are not counted as covered in solveFeasible; (f) v2-refused-axiom-inst-ok reads inconclusive/inconsistent-axioms because the def-level row of `a` is violated at P's default while the instance row holds under p's override (narrowing the sentence to the instance reading, the row `a in p`, would let `g` be proved). (20) a5 K3 (sound but weaker): an asserted bound written in a `[unit]`, or on a feature with a unit or a scale, over a give-way default is still not carried; it gives its own sentence ('it is a bound in a unit, which is not compared here with the bounds on the features the binding joins it to'); a bound on Natural, Positive or UnlimitedNatural names the type's floor; carrying these would mean comparing SI magnitudes across a binding's component (generator 'unit' shape: 30 cells the oracle could decide abstain). (21) a5 S1 (sound but weaker): `true == 1.0` is F on the check, literal and SMT surfaces (a Boolean is never a number) but stays not-quantity unknown on the numeric surface; v9 Solve reads 19 numeric rows over 12 usages (12 withinOperatingEnvelope == true rows, 7 conjunction rows) as satisfied instead of unknown. (22) a5 S2 (sound but weaker): Langium cuts a constraint body at the first syntax-error token, so `x > 2.0 ? 1.0 else 2.0` (no `if`) is read as `x > 2.0` and decided, with the load degraded and reported as 'none is a verdict' (existing recovery-honesty behaviour; fencing it would mark the truncated row's body unparseable). (23) a5 S4 (sound but weaker): a `require` or `assume` clause typed by a constraint definition (`requirement def R { require constraint rq : K; }`) files no row yet and the requirement still reads 'carries prose and no constraint body' (TY2); a plain typed usage inside a part def files only its generic row and per-instance rows (`part car : Car`) are not enumerated; a plain constraint typed by a constraint definition exits 2 on `verify` (literal and SMT) where it exited 0, `--allow-inconclusive` does not forgive it, and `consistency` on a requirement set holding one moves from consistent to inconclusive (exit 2); `consistency` prints that refusal with an empty expression ("`` was not asserted: `nl` is typed by ...", cosmetic, as the A4 typed-assert refusal already does).
      [reads2-pass; numeric2-pass;
      solver2-pass]
- [ ] **Abstentions left in the negated assert (rollup; sound, only weaker).** (a) A model with
      `assert not requirement`, a negated clause that names a constraint with no body, one that
      specialises a constraint, or one whose body holds members and no expression or a member
      other than a comment, a `doc` or an attribute with a `=` value or none degrades as a whole,
      not only the dependent rows (a one-expression body is read since numeric2 S1, beside
      comment, `doc` and attribute members since solver2 S4); (c) members declared inside a refused
      body (the shapes of (a)) are not mapped (kept verbatim in the save); and `assert not x >
      1.0;` swallows `x` as the
      clause's name, giving a `validation/duplicate-name` finding beside the new error; (d) a caller
      that runs the engines on a model whose load report it ignores sees the clause dropped from the
      axiom set; (e) a degraded `contracts` / `obligations` report shows a requirement whose only
      clause was refused as having no formal clause. (f) in a negated clause, an attribute member
      with `:=`, a prefix (e.g. `in`), a subsetting or redefinition, a multiplicity or a body of
      its own, a `rep language` member, and annotations are refused (probe
      solver2-pass-scratch/s4/gen Z187-Z199). (g) The parse-error forms `not satisfy R by s0;` and
      `satisfy not R by s0;` behave as on base: the load is degraded and verify exits 2, but the
      save is not faithful (`not satisfy R by s0;` saves as `satisfy R by s0;` followed by a stray
      `not`; `assert satisfy R by s0;` saves as `assert constraint; satisfy R by s0;`, which re-reads
      the same); no verdict changes. (h) `negatedSatisfyOf` pairs a bare `assert not` with the next
      `Satisfy` sibling, comments allowed between, without checking that the two are adjacent in the
      text: a broken `assert not` followed by a comment and an unrelated `satisfy` lines later
      swallows that satisfy into the refused clause, and the message names the wrong statement
      (an abstention, not a false verdict). [fence-assert-not; numeric2-pass; solver2-pass; a5-fences F2]
- [ ] **Stop the SMT engine reading inconsistent axioms on a model that does not contradict
      itself.** A general's body re-read by name where a specialisation declares a name anew
      without `:>>` (KerML 7.3.2.1 forbids it) is fenced on every surface since g8-fence: no surface
      reads the name in that context, nor a value a binding joins to it, each in a sentence naming
      both features. The SMT engine refuses the general's rows there with their variables kept
      (G-mask, G-pair-b), and a pair of asserted equations met only by name (G8C) is filed `?`, not
      violated (G-pair-a). g8 reads T/T/?/?, G8B/G8A tl ?/?/?/?, G8C `#equations` ?/-/?/- and t70
      ?/?/?/?. Since P-pin an equation written in a usage or a specialising definition no longer
      pins a definition feature's shared symbol (C6A-C6F as measured; LK/LD/LN `P::ck` ?/?/t/?).
      Left: report the shape (G-diag, H1 = (d1)); C6D `ta` ?/?/T/T. [contradictory-models S3,
      closing-readings P-pin, g8-fence]
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
      constraint replays. [fence-redefs]
- [ ] **Widen the random edit generator of the store property test (optional).**
      store.reducers.test.ts now draws bind in definitions and usages and a user retarget of a
      redefinition (its own random stream, onto another feature of a general of its owner, never
      onto one a sibling already redefines); it counts the sequences that fell back to the
      binding-free model (0 in the 300x4 gate window) and the sequences that stop outside the
      oracle (123 same-name stops, 1 lost-copy stop, asserted below half of the sequences); on
      every 20th sequence it compares the four-surface verdicts of the page and of its reopened
      file (up to three `uN.x == 11.0` equations per usage, 9 to 11 comparisons per window). Still
      to add: nested `part :>> p { attribute :>> load; }` (needs part features in the generated
      definitions); standalone `redefinition` statements; the SDK edits; a verdict oracle that
      plants values (a copy bound to a valueless Zb plus `u.Zb == v` constraints); the hand-text
      oracle is thin (1 comparison in the gate window). Finding, no wrong answer, the page equals
      the file: SYSPROSE_RT_FIRST=1700 SYSPROSE_RT_SEQUENCES=1400 SYSPROSE_RT_STEPS=6 fails at seq
      2264 step 5 ('a full settle of the page still moved 1 redefinition(s)') after a user
      retarget and a rename; retargeting onto a feature a sibling already redefines is outside the
      generator and the oracle. Soak seeds 1120 and 1618 are the known pre-existing ones (rollup
      'fence-copy2' item 12). [redefinition-target S2, re-review; misc-pass; ui-pass S1]
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
      over defaults. The tag is ruled out (190 closed by decision 2026-11-05), so only the removal remains. Keep `standingUnderInstance` (the RB5
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
- [ ] **Read an annotation's `about` targets (attach a carrier to the element it names).** Every
      consumer takes a carrier from its owner. Until then a carrier written with `about` is refused
      with `mapper/carrier-about-unread` (PropertyPattern, Evidence, FaultHypothesis,
      VerificationMethod, RequirementMetadata, and an `about` annotation whose `kind` names a
      method; both spellings, including `about` naming the owner itself). When it lands, lift that
      blanket refusal. A keyword annotation's `about` targets are raw qualified names no consumer
      resolves. [small-defaults S2, review]
- [ ] **Resolve a dotted path to a package-level usage from inside a usage body.** A dotted path
      to a package's usage (`q2.p.x` in q1's `assert` or `constraint`) now resolves on all four
      surfaces [names-pass S1]. Still unread (abstains, `unresolved-name`): (1) a path through an
      enclosing USAGE rather than a package; (2) a package path whose value an instance on it
      changes (the solver's instanceReadings does not key lexical paths; reading it gave a false
      numeric F in R17 c2, so it is fenced and pinned 'lexical-instance'). [instance2-pass S4;
      names-pass S1]
- [ ] **Ask FailureMode by its qualified name when it ships.** `machineFailureModes`
      (src/semantics/fault-tree.ts) counts a model's own FailureMode through `hasKeyword(..., {
      anyPackage: true })` because the definition is not in SysproseVerification yet. When the
      vocabulary commit ships it, add FAILURE_MODE_QUALIFIED_NAME, ask for it and drop the option;
      the campaign test then declares the definition in SysproseVerification and its "model's own
      definition is counted" sentence changes. [small-defaults S3] Kept held 2026-11-05 until the SysproseVerification vocabulary commit ships (blocked on that commit, not on a decision).
- [ ] **Finish the evidence and scope residuals of `reporting-small`.** (1) DECIDED by the
      conservative reading (ui-pass S1, reversible): `obligations --element` lists the relations
      the scoped element owns or contains, the USER-GUIDE Checks row says so, and the empty scoped
      report says "this scope holds no relation" / "this scope holds no requirement and no case
      objective". Still open there: big-bind-600 cold check is 17% slower than before the routing
      change (577 to 675 ms); measurement only, to be taken on an idle machine. (2) `satisfy
      LoadReq by Sys::p` (a path through a shared usage, naming a feature of Sys from outside it)
      reads as a `not-evaluable` row, and its v2 record names `S::LoadReq in S::Sys::p`, not the
      instances `q1::p` and `q2::p` (probe small2-pass-scratch/shared.sysml); recording instance
      paths needs the per-instance read in src/semantics/evaluate-model.ts. `verify` prints a moved
      reading as `H::LoadReq in H::p1` where the record says `H::massR in H::p1`: DECIDED by the
      conservative reading as intended and documented in the USER-GUIDE (the report names the
      clause owner, the record the requirement the `satisfy` names), reversible.
      [reporting-residuals S2; ui-pass S1; small2-pass S1]
- [ ] **Fold the per-instance findings of a cause a definition states by a derived value, or beside
      another read.** naming-pass S1 anchors a violated instance whose one breaking read is a
      derived value reached through a binding (M7: q2's `:>> K = 25.0` under Q's `L = 2.0 * K`) at
      the single number-literal member the instance's own elements state of what the value reads,
      only where no other number it reads is a redefinition outside the instance's own elements (a
      shared default is fine). With two such members (M7b), or a redefined one stated in a
      specialised definition (m7j), the finding stays at the part; that is fenced, not open. Since
      findings-pass S4 a no-via derived read (PB's `m2 = 10.0 - load`) is anchored at r1's/r2's
      `:>> K`, only where every name the derived line reads is bound and the line is a declaration
      outside the instance's own elements (PBu and PBr stay at the part). Since S5, instances that
      share a derived line fold into one finding at that line, when the one input left is a
      redefinition on a shared definition frame. Still open: the 'beside another read' part, and a
      default, a unit or `sides`, and a sixth distinct set, as before. Probes: PB and M7 in
      test/unit/semantics.evaluate-model.test.ts. [reporting-residuals S1, review, naming-pass S1;
      findings-pass S4, S5]
- [ ] **Name the breaking value in a unit-bearing violated instance.** `breakingRead` now puts a
      unit-bearing read back in the unit-aware reading that judged it (findings-pass S1,
      `quantityBreak`). It still leaves `breaks` unset, so the first bound read is named, when (a)
      no single read mends the relation (both needed, or already violated in its own context;
      permanent), (b) the 5-per-group or 20-per-context cap is passed (permanent), (c) the verdict
      came from the scalar path with a unit on a read, so there is no re-quote (open), or (d) the
      row's reading was shared by `readAlike`, whose rebuilt judgement carries no re-quote (open).
      [findings-pass S1]
- [ ] **Name and anchor a value the instance redefines, which no read carries.** Done for a group
      row whose instance's own element (`readIn`) redefines a plain number literal that breaks the
      relation (redef-breaks2 / G5: `extra = 20.0` is named and anchored). Since findings-pass:
      context rows are covered (S2, B1); a derived redefinition (G5c, quoted as `(= 5.0 * K)`) and
      a unit-bearing literal one (GUR) are named and anchored (S3); a no-read target row is
      anchored at its redefinition (nb12), or at its context element where the shown feature is a
      line a definition shares (the P2 shape; S6). Left, sound (the finding names less, never
      wrong): a derived redefinition that carries a unit, such as `= 5.0 * K [kg]`, is not named,
      because its written quantity is not compared; a derived value whose text reads a name that a
      read lists is left to the read (G5d); a no-read target row whose shared-definition feature is
      not what breaks it is anchored at its context element, not at the own redefinition that
      breaks it (nb5 points at `part :>> p : P2`, not at `:>> extra = 12.0`; its message still lists
      the shared value first); the context sentence of a context row prefixes the name with the
      redefining part's name, not the instance's (G5d prints `p::p.extra = 20 misses Q::c2`).
      [PI-2 S1, naming-pass S1; findings-pass S2, S3, S6]
- [ ] **Divide the text step and the edit's own task on the drone-swarm v9 model.** Since `ui-small`
      S4 an edit's recompute yields to the page between its steps (`recomputeSteps`), but three
      tasks stay whole. The serializer (`serializeUserModelSignals`, `src/text`) writes the one root
      in a single pass: 40 to 90 ms at load about 4, up to about 180 ms at load 25. The edit's own
      task (the undo snapshot `model.toJSONWhere` plus the SDK update) takes 54 to 109 ms warm, up
      to about 296 ms at load 25. The last step (the results set plus the synchronous
      `buildDiagram`) takes 90 to 156 ms at load 25. Left: a step-wise serializer, an idle-time undo
      snapshot, and the diagram build as a separate task. Ruled permanent 2026-11-05 (the rollup
      'Abstentions left (parallel machines and Simulate)' item (6)): incremental validation (unsound
      for cross-element rules), a worker serializer (a model transfer per edit costs about what the
      write does), and the cold first edit (238 ms). Done when no task of an edit and its recompute
      is over 200 ms at load 25. The `palette-checks` step 4 bound (200 ms) has a thin margin on
      slower CI cores: if the first CI run is red, make the assertion relative. [ui-small S4, review
      2026-10-14 D-3]
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

- [ ] **Abstentions left in bounds and consistency (rollup; sound, only weaker).** (1) Mixed
      Integer and Real bounds: since solver2-pass S6 a bound is established over an integer branch
      (Integer features fixed at a feasible point, νZ over the pure-Real rest, one plain check
      beyond the value); still withheld when the branch cap is reached (16 witnesses: a Real
      measure unbounded only through an unbounded Integer, e.g. `x - 2.0 * y > 0.0` min x, and an
      Integer measure with no bound) or the encoder cannot fix an integer symbol (read other than
      through `to_real`, or a script with a string literal); probe
      solver2-pass-scratch/s6/gen/u.cases.json. (2) A relation that reads a feature typed Natural,
      Positive or UnlimitedNatural is refused in the z3 lane, so bounds, consistency, verify and
      refine abstain on it even where a literal pins the feature (`k : Natural = 3` with `x <= k *
      2.0` used to give max 6); probe fence-bounds-scratch/gen/f5.cases.json; the full reading
      carries n >= 0 / n >= 1 as an axiom in encodeScript, without disturbing consistency's
      owners/core mapping and the `axiom` census. (3) `verify` on a freed Natural says 'relation
      cannot be read (non-numeric-operand)' where it said verification/free-variable-unbounded
      (abstention to abstention). (4) The `bounds` exit-code sentence (scripts/lib/sysprose-spec.ts
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
      docs/04 and the USER-GUIDE call it `unsupported-construct`; (3) `bound.detail` says "decided by z3 5.3.1" on rows the numeric surface decided (`s.a
      == s.b`, "bus" vs "car"); (4) to probe, not a defect: the
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
      (5) Names (names-pass): a dotted path through an enclosing usage is unread; check's
      quantityScope is not routed via lexicalPackageOf, so a unit-bearing lexical path abstains on
      check; an assert typed by a constraint definition with no body makes the literal and SMT
      surfaces abstain file-wide; a plain constraint typed by a constraint definition files a ?/?/?/? row since a5 S4 (reading it with the parameters' values is TY1/TY2, by position). [names-pass]
      (6) Subsetting (instance3-pass): p2 `[0..1]` or `[0..*]` reads as present in S1's reread rows of
      an assert: `W::a in w` F and SMT X where p2 may be empty; this is the engine's existing stance
      for optional parts, a limit of multiplicity reading. A usage with a multiplicity other than
      `[1]`, or a subsetted feature that may hold more than one value, stays unre-rooted, so its
      rows keep abstaining. The SMT fence is file-wide, not per component, and its two-values test
      also fences a value whose partner is a `default` that gives way (SE's RF own row, T/T/T/T to
      T/T/T/?). The `consistency` and `bounds` commands read the worklist but not
      `subsettingUnread`; not probed for a contradiction through structural axioms only. The
      catalogue entry for `verification/not-evaluable` does not yet mention the new SMT sentence
      (USER-GUIDE does). Numeric: `declared-unit` shapes abstain on three surfaces instead of being
      read in the declared unit (needs a decision on a bare equation over a multiplicity-unit
      feature); `sameKind` is conservative (a redefinition with no typing of its own, a declared
      coherent unit `[kg]`, a kind reached only through a specialisation stay undecided); the
      numeric sentence names only `differs` sets, an `undecided` set keeps 'did not converge'. The
      differential test's 1 h beforeAll hook timeout is fragile under heavy load (3095 to 7151 s
      seen). [instance3-pass]
      (7) Name-declared-anew rows (pin-265): the numeric surface does not carry a general's binding
      onto a redefinition's own symbol (the reason for the `redefinesBoundOwner` fence), so
      self-contradictory models of the RBL4/SRS shape keep their base numeric reading;
      asserted-constraint rows of a specialisation are filed under an order-dependent instance name
      (gen-ppin: 65 rows, also on base); C6D ta stays ?/?/T/T on the check and the literal engine;
      the key of G8R's `#equations` row depends on text order (`P::L in P2#equations` vs `P2::N in
      P2#equations`; the twins are pinned separately). `redefinesBoundOwner` scans every binding per
      uncached call (time big-bind-600 and perf9b; memoise per (site, f.id) if slow), and
      `hiddenEndSentence` matches only an end's first dotted segment, so a hidden name deeper in a
      path (`a.K` where `a`'s type re-declares K without `:>>`) is not fenced (same shape as
      G8A/G8B; with the g8-fence branch). The USER-GUIDE sentence on G8 names only the binding: an
      assert of P's re-read in P2 can still be decided on every surface, the SMT engine included.
      [pin-265 S1, S2, review]
      (8) g8-fence: the check and numeric fence covers the whole context, so the context's own
      relations over the hidden name abstain too (measured on gen-mask: 56 cells on the check and
      150 on the numeric surface where both readings agree, g8 numeric kl/kn among them); the SMT
      lane covers only the general's rows. `hiddenReadOf` matches only an end's first dotted segment
      (`a.K` deeper in a path is not fenced). The check still decides p.K where only the by-name
      reading contradicts, which the refined oracle allows. A numeric T on an assert's own row over
      free names (G8A `P::pe`) has no hand oracle (its reference is null). One pinned row is
      missing: a specialising requirement that redeclares its subject (`subject s = p` is no longer
      fenced since the fence leaves out requirementRole; both text orders, to show no verdict
      widens). `redefinesBoundOwner` is not memoised (no cost shown). [g8-fence]
      (9) a5-fences: `headStandsAgainstAt` reads only asserted relations the package owns directly:
      an assert inside P, or inside an instance, that contradicts a standing slot value is not
      walked and is read as before; a non-constant standing value (`default = 2.0 * K`) is treated
      as undecided, so the row abstains; an assert or standing value with a unit is never 'holds
      exactly', so it abstains; the plan's `decide` fallback for head stands is not wired (no
      BoundPair path exists for a redefinition outside the reading). In imp3 the per-instance rows
      `H::ax in h`, `RQ in h` and `RQ in <<Satisfy>>` are no longer listed at all (the plan
      predicted -/U/-/U and ?/-/?/-); the bare rows abstain and are pinned, so no surface decides
      anything on these clauses (an abstention, not a wrong answer). Test-strength gap:
      nobody checked that canonicalJson keeps undefined-valued keys (the `restricted` key is added
      only when present, so every existing scope digest is unchanged). [a5-fences F0, FP1, F1]
      (10) a5-fences2: HDF per-instance rows (F3): the per-instance F0 fence also leaves instance rows
      unknown where M is written with `=` and the assert is a violated check (GH110 `cP in p1`, F to
      ?); the `defaults-differ` sentence for GH129 lists the members and not the redefinitions'
      defaults; the USER-GUIDE policy for a non-bare assert over a definition's own default (GH45)
      differs from F0's contradiction reading for instance defaults, and the check abstains there.
      F6 (and/or/implies/xor control order): an ill-typed operand's check sentence is still the
      generic 'a referenced value is unknown' (`(b + 1.0 > 2.0) or true`), not a type sentence; in
      expr.ts and exact.ts a scope miss concatenated with a string (`(x + "s" > 1) and false`) is
      still absorbed to F (units-eval does not read strings, F5 refuses String features at the
      gate); an `unresolved` next to a Boolean under ==, = or != stays absorbable (pinned `(w ==
      true) and false` F/F/F/F). F4a: the SMT gate refuses every written negative exponent, so `y ^
      -1` reads 'the exponent is not a literal' and the conditional negative-power guard in
      `power` is unreachable from text; the guard's '<left>' prints the operand's SMT text (no
      source printer). F4: `vacuous` still says 'the premises are unsatisfiable' in two cases
      where the axioms and premises are satisfiable: (a) an `assume` fixes the divisor at 0 and the
      goal's guard contradicts it (gen pf0, 140 rows); (b) z3 returns a non-minimal core holding an
      unrelated premise label (gen a0p, 28 of 140 rows); a remedy is one more check of the axioms
      plus the goal's guards alone, which would change the plan's decision 9 / F.1 rule. F5:
      relations over String now abstain (U) on SMT where the check reads satisfied, including mixes
      where z3 previously proved the non-String disjunct (48 generator rows); recovering them needs
      String encoding; the `bound.detail` example `s.a == s.b` is refused at the gate, so clause (4)
      of the wording rollup needs another example for W1; CC-42b's String refutation has basis
      point-evaluation. FP2: a5-imp3's row 'IMP3::RQ::<<ConstraintUsage>> in IMP3::h' reads -/X/-/X
      (inconsistent-axioms: the asserted ax is false at h under Table 6) and the RQ root row
      ?/?/?/X, undecided not wrong. [a5-fences2 F3, F6, F4a, F4, F5, FP2]
      (11) Head fixers compared only as `=` constants (a5-fences3 GH2). A package head whose slot two
      things fix outside the component (an instance's `:>> m = 7.0`, another definition's binding at
      an instance slot, an asserted equation on a slot) is read only where every fixer is one exact
      constant. A binding fixer counts as one only where its component, read in that root, agrees on
      one value written with `=`. An asserted equation, a `default`, or values that differ per
      instance count as differing, so numeric abstains where the model may still entail M. The check
      abstains on every fixed head (the fixedHead sentence) even where the fixers agree, while
      numeric and SMT read the entailed value (`a5-gh2-same` cM ?/?/T/T). A disagreement in the sound
      direction, not a false verdict. The HDF family is closed: gen-head, gen-f3 and gen-f3b read 0
      WRONG in both text orders (rows a5-gh2, a5-gh2r, a5-gh2-same). [a5-fences3 GH2]

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
      reachable group row turns up; 'File a violated row for the contradiction SMT reports in UB6
      and W4o' (263) closed with UB6 ruled permanent (the check abstains on that pair by design: a bare
      number has no unit to compare in, so a violated row would claim a comparison it refuses to make;
      the literal engine's T on UB6::cT is right and SMT's X is its SI reading; W4o was fixed by
      numeric2 S1). [round 9]
      (6) Closed by decision 2026-11-05 (maintainer: "all of them"; all reversible), the shapes
      below ruled permanent (abstention kept by decision; reverse one by re-adding it to its entry):
      (a) 228 'Narrow the literal engine's contradiction reach...': the SMT surface reading
      `inconsistent-axioms` file-wide in a model that contradicts itself (decision 1); the other
      residual shapes stay open. (b) 176 'Read a satisfaction, a subject or a reference a definition
      writes in each instance of it.': a call as a part's value (h5-ppcall, h5-r8expr; 219 item 2),
      the T side of a definition's own row (only F can be lifted; a finite list of instances cannot
      prove 'every W'), chains past the cap or cyclic ones, groups past the instance cap, a
      type-narrowing redefinition with its own value; the buildable rest stays open. (c) 219 'Read
      what two steps of standing-for, a call, or a second subject would decide.': a call as a part's
      value; the rest stays open. (d) 233 'Narrow the abstention over two disagreeing asserted
      equations (optional).': a pair made to agree by a usage's `:>>` (the pair that meets in the
      owner), and the breadth of FMI `start` (readsContradictedDefinition stays feature-wide); the
      the declared-unit shapes stay open (instance3-pass S3). (e) 255 'Solve the plain equations of a design component
      jointly over all roots (optional).': the general all-roots solve; entry closed. (f) 262 'Read
      `assert not constraint c { ... }` as the negation.': the refused shapes (a bodiless clause, a
      specialising one, `assert not requirement`, and a members body holding a nested clause, part,
      calc or `default` member); entry closed. (g) 'Move the first Apply's parse off the page (P3,
      the rest).': moving the parse into a worker (the gain is 4-9 ms warm against five new ways for
      the page to differ from its text) and the parser build itself; the entry stays for the warm-up
      on the Open menu, file chooser and text buffer paths. (h) 'Divide the text step and the edit's
      own task on the drone-swarm v9 model.': incremental validation, a worker serializer, the cold
      first edit (238 ms); the entry stays for the step-wise serializer, the idle-time undo snapshot
      and a separate diagram task. (i) 'Stop an in-page solver check from stalling or tearing the
      page.': Cancel cannot stop z3 until a safe interrupt is proven, and an in-page evidence
      record; the entry stays for the revision-check fix.
      (j) 190 'Hold: an opt-in tag that lets an assertion adjust a written number (for example
      `#provisional`).': the tag will not ship; entry closed (reversible; a model that needs a soft value
      reopens it).
      (k) 199 'Parse a declaration whose user-defined keyword stands without a reserved keyword.': the
      grammar keeps rejecting these forms with its current error; entry closed (reversible; reopen if a
      tag ever ships; the text-pass branch may still change the parser, the coordinator reconciles).
      (l) 5 'Run the palette's solver checks in the page on the hosted site too (optional).': the
      hosted site keeps `not here` with the copyable command and in-page z3 stays on the dev and
      preview servers; entry closed (reversible; a host that sends the isolation headers reopens it).
      [decision 2026-11-05]

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
      with `=` is a fenced scope; its two instance rows (P::c in S::p, P::c in s::p) are listed and
      read ?/?/?/? in the scope's sentence (ends-fence S0); the agreeing-values case could be read
      (names-pass S3, design-name-reads.md:108). (4) The whole-model SMT lane abstains
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
      (test/unit/store.reducers.test.ts). ends-fence: (12) S4's pins leave page-? / file-decides cells
      in seed 4318 (c1, c2), 32180 (c4, c6), 42267 (c1-c3, c5-c7) and 1618's parted copy, owned by
      S9/S8; the stale-copy order fence also withholds a stale copy's specialisers where the file
      decides, until S8 makes stale copies invisible to readers. (13) Held (unread) instances:
      `evaluate-model.ts` tags a boundAbove abstention 'past-cap', so a multi-instance roll-up
      names 'more instances than the tool reads' for such a generic row (t7); in the diamond cause,
      usage and nested holders keep their live-site row ('a referenced value is unknown') rather
      than the scope sentence; the SMT surface on held instances is pinned only by the three
      differential probes, not by the 144-model generator. When one group lists an instance as held
      and a later group lists the same instance as live, the cross-group dedupe keeps the held row
      and drops the live one (sound, weaker). A group with held instances and no live site is
      refused as not-enumerated with the held sentence (review fix). [fence-copy; fence-copy2;
      ends-fence S0, S4]
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
      (2) (closed by a5-std S3: MAX_NESTED_BINDING_DEPTH is 48; a usage-body chain is decided up to 49 usages and refused at 50 with the 'more than 48 bindings below the first' sentence; the nested walk is bounded at 2,048 instances (MAX_NESTED_BINDING_PATHS) as well as depth 48, and a definition cycle that branches past that is not carried, its rows abstaining with the 'not carried' sentence, though a deeper reading would be sound; a chain of 50 or more usages is still refused by the proof, and the check and literal stay `?` for a path past 48 segments, rows at n=48 and 49 reading `?/?/T/T`, pinned as a5-chain49.) (3) A failed asserts listing stays
      failed for the revision; ruled permanent in misc-pass (it abstains; a retry inside a revision
      would mix caches built while the listing failed with a later complete one; reopen only if a
      throw is seen to be transient). (4) A
      relation whose own context walk throws gets no per-instance rows at all; one internal row
      stands for its other contexts (test semantics.evaluate-model.test.ts, 'own context walk';
      probes instance-pass-scratch/gen221). (5) The 193 anchor abstains and the finding stays at the
      instance's own usage: when a derived value reads a redefinition outside the instance's own
      elements beside the instance's own input (m7j), or when the instance states two numbers a
      derived value reads (M7b); also a no-via derived read whose expression reads an unbound name
      (PBu), whose bound source abstains, or whose derived line is a redefinition outside the
      instance's own elements (PBr); and, since findings-pass, these sound-but-weaker shapes: scalar-path
      rows with unit-bearing reads and `readAlike`-shared rows fall back to the first read, never a
      wrong name; a derived redefinition in a unit is not named; no fold when a derived value reads
      more than one input that nothing redefines, or when the shared line is a plain declaration
      rather than a redefinition; a context row (no group) gets the shared anchor id but is never
      folded; the 5-per-group and 20-per-context caps still apply; a no-read target row whose
      shared feature is not what breaks it is anchored at its context element (nb5; probes
      scratch/naming-pass-scratch/pb.sysml, nb12.sysml). (6) A reference valued with
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
      (150-model fuzz: 25 closure differences on editor-pass, 0 with NOKI=1).
      (8) instance2-pass (per-instance reads): a pair met in two usages widens to every instance; a
      dotted name or a non-local relation that reaches the pair widens to every instance; a P nested
      inside the contradicted instance; a pair met in a definition P2 still taints p2 : P; `bind
      a.p.L = M` taints every A's p (within is the innermost link); a binding written in `Q2 :> Q`
      taints every Q's p through the lifted copy; any reference, value, binding, subsetting, satisfy
      or alias naming the part keeps every P's L undecided; a package binding on a sibling's end
      (`bind w2 = p2.L`) widens p2's copy of L to everywhere; readsContradictedDefinition (FMI
      start, MoE, literal printing, refinement) stays feature-wide. Probes under
      instance2-pass-scratch/{s2,s3,s4}/gen*. [instance-pass,
      naming-pass, reads-pass, editor-pass, instance2-pass]
- [ ] **Abstentions left (keywords and metadata annotations) (rollup; sound, only weaker).** (1) A
      bare-keyword ambiguity is asked in the nearest scope with imports only, a qualified `#Pkg::name`
      is never asked, and an alias or inherited member is not enumerated (src/semantics/keywords.ts
      ambiguousKeyword). (2) A library-typed USAGE keeps its body `:>>` textual with
      ref/unresolved-specialization (`part y : ISQ::MassValue { attribute :>> num = 1; }`); only an
      annotation typed by a library metadata definition is bound by the library binder. (3) A
      definition a user-defined keyword alone leads (`#situation def Failure;`) is refused
      (mapper/extended-definition) rather than read as a plain Definition. (4) A semantic metadata
      baseType is not read for a tag on a keyword-less usage, as for a keyword-led one. (5) A
      keyword-less enum literal still cannot carry a statement kind (canCarryStatementKind refuses
      it) although `#prose low = 0.25;` now parses back and round-trips. (6) fault-tree --json
      carries ambiguous and uncounted `#failureMode` tag counts only in the sentence string, not as
      structured fields. (7) The prefix-order shapes `abstract #k def X` and `ref #k x` stay parse
      errors. (8) The keyword inventory prints "third-party spelling: #precondition read as an assume
      clause" on a non-constraint element although obligations --from-keywords files constraints
      only. Decided in text-pass, reversible: a bare `metadata T {…}` is read as typed by T (named
      reading), and statement kinds are read by spelling even against a model's own `metadata def
      <prose>`; both documented in USER-GUIDE as intended. [text-pass]
- [ ] **Abstentions left in laundering shapes (rollup; weaker, soundness-adjacent).** A save still
      launders these recovery shapes into text that checks clean (130 of the 410 faulted neighbours
      in the generator probe; also listed as Known limitations in docs/AGENT-AUTHORING-CAMPAIGN.md):
      bare `def X;`, `public def X;`, `in def X;`, `#k [2] = 3;`, bare `[2] :> y;`, `#k [2] :> y;`,
      `#k abstract def X;`, `abstract def }` and `#k abstract def }` (the `;` is missing and a brace
      closes the statement, so it saves `abstract ref;`), `abstract def X }` (also moves `X` to the
      end of the package), `#k abstract [2] :> y;` (a modifier between the tag and the
      multiplicity), `end def;` and `individual def;`. `in def X;` could reuse the prefix mark if
      the recorded-usage test also accepted a PortUsage that carries only a direction; not widened.
      In a body with several faulted statements only the FIRST is marked (`abstract def X; abstract
      def Y; abstract def Z;` saves the first kept and the others as `abstract ref; Y;`), and a
      fault at file level is not marked. A prefix-only usage that follows an earlier residue keeps
      the earlier word but drops its own `def` (as on base): sound but weaker. A `;` inside a
      multi-line string or an unterminated string still stops the scan at the line end, as in
      bracePairs. The ordering shape `abstract #k def X` and `ref #k x` stays as stated above. The
      app keeps back a text with a syntax error, so only the API/SDK path (L6) reaches these.
      Probes small2-pass-scratch/gen1.mts, gen1-mine2.json (rows with e1>0 and e2==0);
      text-pass-scratch/review/rt.mts. [text-pass; small2-pass S1]
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

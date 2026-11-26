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
      sub); RFN refine and fault-tree still inconclusive (they need the per-instance satisfy read, RULED
      PERMANENT 2026-11-16 — see the genericity-audit rollup (1) — so they stay inconclusive); `::>`, nested (SA7N), chained (SA7C), attribute (SA7A) and sibling
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
      (sd0, sd1, SM1, SM6; a path that would resolve outward is read there, once, never outward —
      PA3); a requirement usage there whose subject a value binds (sbj0, SM3, SM2)
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
      "the check never gathered this relation" (SAT2). [O9 S1]
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
      binding.** (3) Under a fixed slot (a package's `bind P::load = M` over a slot instances fix), where two fixers state different literals (S2V: p2's 5 against the other's) the check and the literal engine still abstain and the two differing fixers' #bind F row is not read (S2V `c3T`/`cMT` ?/?/?/X; SLOT-BIND, plan step 28); the W4d half and the rows where every fixer states one literal read since SLOT1 and SLOT2 (W4v, W4X1, W4X3, W4X6, W4d); a pinned fence: an instance stating both ends of the pair with different literals reads ?/?/?/X (W4db, SMT finds the axioms inconsistent, as W4o). (5) The numeric surface and SMT abstain on an enclosing assert read through a renamed redefinition (RNV `q.pp.x`: top and topF now read T/T/T/T and F/F/F/F since closing-readings RN-1/RN-2, so this clause is closed but for `q.p.x`, the old name from outside, which stays ? under H3; RNV2 at depth 2 reads T/?/?/?). Two renamers of one name (`part e :>> p; part pp :>> p;`) no longer answer it (rn1-shared: it read e's 60 where pp's x is 50). [closing-readings RN-1, RN-2] (6) Where a binding joins an element's asserted
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
      Since default-stands S2: item (6)'s GW example is obsolete: `pl in q2` reads T/T/T/X, ref null.
      Rollup (sound but weaker, closing-readings): (RN-0) the old name of a renamed feature is read from outside on check, literal and SMT: after `part q : Q { part pp :>> p; }`, `q.p.x == 60.0` is decided at pp's value where q's pp has a single value, though p is not a member of q (H3: keep `?`; the 284 single-renamer gen-rn cells that read decided and correct are pinned in 16 differential rows, an open coordinator decision against the RN-1 oracle 'old name from outside gives ?'); with two un-renamed redefiners the numeric surface reads the q-level comparison as `?` in one text order and decided (correct) in the other, the renamed twin in both. (RN-F) a row's literal and SMT readings still depend on unrelated packages in the same file (literal abstains beside an unreadable assert elsewhere; SMT gives file-wide X beside a self-contradicting package or two same-named attributes): abstentions and X only; check and numeric rows have been file-independent since RN-F. (RN-2) 40 of 480 gen-rn g cells abstain where a conjunct of a respelled assert could read (buildInstanceSystem respells `whole`, not the assertConjuncts parts; a sound abstention; e.g. F/?/F/? against F/F/F/F). A general's assert over a feature two renamers share is read by neither renamer (fence in reachingUncached, row rn1-shared-general). [closing-readings RN-0, RN-F, RN-1, RN-2]

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
      and TP1's runs on the same way — CLOSED 2026-11-17 by a5-words W7: where an asserted relation
      reads the name without defining it the sites use the A.2 sentence, so the sentence no longer
      denies the reader it names.
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
      0.0`); (b) CLOSED 2026-11-17 by a5-numeric N2: a tautology's row now reads T where the divisor
      or base is an exactly nonzero stated or asserted value (pins a5-n2-q-lit/-stated/-fixed and
      the solved-for and remainder literal shapes; `0.0 / x == 0.0` and `x ^ 0.0 == 1.0` decide),
      while a free divisor or base, a binary64-only cancellation and an unvalued tautology stay `?`
      (the nk1 `ky` control); (c) two stated values further apart
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
      for that component throughout, even at a true root; CLOSED 2026-11-17 by a5-words W5: the
      rows the cap withholds now name the cap ("a group of more than 120 equations linked through
      their features is not judged together, and … is in it"), the head stays `converged false`,
      and a row beside the group that reads only stated values keeps its imposed sentence; the
      USER-GUIDE parenthetical that claimed a rooted chain "still reads imposed" is corrected at
      merge. No corpus or v9 model is hit. Item (f) also covers the chain shapes.
      Probes: fence-numeric3-scratch/rchain10-2.0.sysml, rchain10-0.002.sysml, rchain20-2.0.sysml,
      rchain30-2.0.sysml, chain100-2.sysml, chain150-0.sysml (no root), review/big-chain-130.sysml.
       fence-numeric4: (a) CLOSED 2026-11-16 by a5-heads2 HD2: a bind end under an unread scope
      (an `order` scope) now enumerates its candidate ends, so a valued end keeps its own seed and
      n2-keq `cA`/`cB` decide (T/T/T and F/F/F on check/literal/numeric; the SMT lane stays `?` by
      withheldCauses, the accepted conservative policy; pins a5-hd2-keq/-rev). (b) The withheld set joins by
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
      (probes numeric2-pass-scratch/gen2 D56-D58, t5/hc3.sysml); (i) a package head whose binding sits in a third package that spells neither end (Defs/Vals/Bind; `package Bind { import Defs::*; import Vals::*; bind P::load = L; }`, probe numeric2-review-scratch/nb/h.sysml) files its violated #bind row since a5 HD3: SMT reads the axioms inconsistent and c4 reads T/X/?/X (it read T/T/T/T before); c5 and cL stay ? because Vals::L is a qualified reference that none of the surfaces read (PA), the proper reading staying open with fence-pkgbind; (j) the literal engine answers X on any relation over
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
      features or with a coefficient that is a feature's value (`k * x`) is read as before; (r) a definition's own row reads `t` where an
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
      per-context answers. (2) A bridge, chain-target or package fence fires on any member that states a value, at any depth, or whose type states one, even where the values agree; since a5 LN2 agreeing statements of one feature (the same number in the same unit, or defaults of the same type) read as one statement, and values in different units still abstain. (3) Since a5 LN1 and LN2 an attribute that a context states several ways (`X :>> M, N`, a redefinition of the line or of one target, `Y :>> X`, a twice-stated `:>> x`) is read as one feature with the one value its most specific statement gives, under every name of it and in what is derived from it, and `:>> M, N = 6.0` over a general type's `X :>> M, N` reads (m4 rows uM and uN read T; review-2026-10-14/wave3-probes/fence-readings/p/m4.sysml). Still fenced on every name they reach (dependent attributes included): a line of parts (`part X :>> M, N;` with `s.X.x`, `s.M.x`, `s.N.x`), values written in different units (`5.0 [kg]` beside `5000.0 [g]`), a line where no one statement gives the value (`:>> M = 1.0` beside `:>> N = 2.0`, two firm values that differ, two defaults of types neither of which specialises the other, a value that is not a number), and the nested content of a twice-stated part, even where identical. (4) The ends of
      every type of a connection that connects features abstain, whatever the connected feature
      states (pin conn-end-redefined). (5) Since a5 PA3 a satisfy written outside its definition
      resolves through the owning namespaces, and NQ1, NQ2, NQ5, NQ7 file w's F row as NQ3 does —
      a path spelled plain or `Pkg::w.p1` (the mapper's sourceChain takes `::` paths, and
      writtenSatisfier, satisfierOtherwiseOf and the satisfy-context listing resolve outward); a
      path whose first name two places expose (two imports, an import and a member, a recursive
      import) is refused, never read by the loader's import-order pick, and one written in a
      definition keeps its old reading, once, never outward (probes sat-nested-pa3-def and
      sat-nested-pa3-amb-*;
      review-2026-10-14/wave3-probes/fence-readings/s2/nq1.sysml, nq2, nq5, nq7). (6) A subsetted
      feature is CLOSED 2026-11-17 by a5-heads2 HD6: the union `p1 = q` is read as q only where both
      effective multiplicities are exactly [1..1] (SysML 7.6.3, decision 13) — rv1 decides, rvq0 and
      the [0..*]/[2] grid stay `?` (pins a5-hd6-rv1/-rvq/-spec and revs; also settles e1-subset;
      review-2026-10-14/wave3-probes/fence-readings/s2/rv1.sysml, rev/rv-spec.sysml, rev/rv-q.sysml).
      (7) mu sM1, sN1, sN2 stay ?/?/?/X by design; a #clash F row files the two-values contradiction; a firm value beside a more specific default on the line's other name reads none (LN3) (review-2026-10-14/wave3-probes/fence-readings/s2/mu.sysml, mur.sysml, mu1.sysml).
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
      ignores multiplicity EXCEPT the [1..1] subsetter rule HD6 reads; a chain taint does not reach
      a subsetter declared deeper in a
      specialisation the model never instantiates. (11) Order only, sound either way: the SMT lane's
      `?` versus `X` letters on contradictory merged lines and `T` versus `?` on generic requirement
      rows; the row key of a constraint read in a specialisation context flips with member order
      ('in W3' or 'in v', same ?/?/?/? cell;
      review-2026-10-14/wave3-probes/fence-readings/p2/o1.sysml); the tie sentence lists the
      equations in written order (review-2026-10-14/wave3-probes/fence-readings/p2/t2.sysml); `part
      p1 :> p1` now raises `validation/specialization-cycle` (a self-`:>` names its own element;
      CLOSED 2026-11-17 by a5-words W5), as `p1 :> p2 :> p1` already did
      (review-2026-10-14/wave3-probes/fence-readings/p2/cy3.sysml). Probes:
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
      beside bounds still abstains where the hand oracle could prove (20 cells: m45f/m46f/m52f
      `g0`-`g2` read ?/?/?/?, hand T/T/T, T/T/T, T/T/F) — RULED OPEN 2026-11-16: the only rule that
      decides them moves the pinned A-H1 shape (`H::q2::p` ?->satisfied), PJ and the instanceRollup
      expectation (the two shapes differ only in which end of `bind p.load = L` the usage
      redefines), so it needs a dated ruling of its own (evidence: a5-heads2-scratch/hd2/report.md
      §3); (14) CLOSED 2026-11-16 by a5-heads2 HD2: bounds linked through a derived relation are
      carried and compared through it (stand-gw-ineq-derived/-derived2: g1, g2 now decide T, g3
      stays ?); (15) a scoped worklist (`obligationsOf` with scopeId, the Checks 'Obligations'
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
      1.0;` no longer swallows `x` as the clause's name (CLOSED 2026-11-17 by a5-words W4: no
      `validation/duplicate-name` beside the clause error);
      that runs the engines on a model whose load report it ignores sees the clause dropped from the
      (e) CLOSED 2026-11-17 by a5-words W4: a degraded `contracts` / `obligations` report says the
      requirement's only clause was refused (the skipped expression-less clause is carried and
      named), not that it has no formal clause. (f) in a negated clause, an attribute member with
      `:=`, a prefix (e.g. `in`), a subsetting or redefinition, a multiplicity or a body of its own
      are refused; a `rep language` member and annotations are mapped since 2026-11-17 (a5-words
      W4; unnamed `rep` only; probe solver2-pass-scratch/s4/gen Z187-Z199).
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
- [ ] **Split the reading key by the value a sibling binding carries (SIB2, noted 2026-11-16 by the
      a5-heads2 HD4 branch review).** Sibling usages that read through one holder merge
      value-insensitively: `in Q::p1` ?/?/?/X files, no `in Q::p2` row, each binding's own #bind
      pair row still reporting its pair (not a regression: HEAD swallowed both relation rows in the
      P-first order; the HD4 branch keeps p1's row and both #bind pairs). A later probe-first step:
      each distinct sibling reading files its own row when its binding carries a different value.
      Probes: a5-heads2-scratch SIB2/SIB2S, review-probes. Also re-filed here (2026-11-16, the right
      half of the deleted 'File a definition's context row under one name' entry): the M-generator's
      RENAMED pairs (27) and the H3/H6/S3-spec cells live outside this repo — when HD6/H3 re-pin the
      differential table, only the in-repo cells re-pin; the out-of-repo pairs stay as recorded.
      [a5-heads2 HD4 review]
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
- [x] **Save the unnamed end by a name, instead of leaving it out (a loud note today; sound, only
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
      CLOSED 2026-11-21 (sm-saveend; user ruling "close as ruled"): Save writes a lone unnamed redefinition reached by a transition,
      succession, allocation, dependency or alias end under the name it already goes by (`state s1 :>> s1;`), verified by re-parsing
      (text.save-end-names). Ruled permanent limit, the loud `// Not saved:` note kept (never a wrong save): a named end behind an earlier
      member of its name, two or more unnamed `:>> M`, an unnamed one beside a named member of its name, and 2nd+ requirement-relationship
      or inline-specialization ends — any faithful text needs a member reordered or renamed, which changes the model (in a state machine,
      the declaration-order tie-break). Reopen by re-adding the item with its original title.
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
      solver2-pass-scratch/s6/gen/u.cases.json. (2) CLOSED 2026-11-17 by a5-words W1: the `bounds`
      exit-code sentence (scripts/lib/sysprose-spec.ts BOUNDS_EXIT_CODES) now names both kinds it
      withheld — the integer-branch cap reached over mixed Integer and Real, and a feature typed by
      a domain below the integers this lane does not carry.
      Since a5-encode E1 the type floors of Natural and Positive are carried as `type:`-labelled
      axioms in encodeScript (a pinned Natural/Positive now decides where the floor is Int-sound;
      consistency maps the label to its declaration and the `axiom` census does not count it); a
      free UnlimitedNatural and a stated non-integer value still refuse byte-identically, so the
      former (2)/(3) are closed. [sweep 2026-10-31; fence-bounds; a5-encode E1]
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
      (`contracts.ts` tests the unary minus as a non-number); (2) CLOSED 2026-11-17 by a5-words W1:
      `bound.detail` appends the z3 sentence only where a z3 call decided the outcome (proved and
      design-admitted), so a refuted row the numeric re-read published no longer claims it; the
      D-bound-detail defect is deleted and the class facts regenerated; (3) to probe, not a defect: the
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
- [ ] **Abstentions left in seeds against an unread bound end (rollup; sound, only weaker).** (1)
      CLOSED 2026-11-16 by a5-heads2 HD2: the candidate ends of an unread scope are enumerated, so a
      feature that writes a value and is bound to an end under an unread scope reads the seed where
      every candidate gives way or is valueless (b1 lim/lim2 decide; pins a5-hd2-lim/-rev; the 648 +
      438 cells of 44 + 30 of the 1100 generated models). (2) The fence covers every unread-scope kind (`order`,
      `twins`, `redefinition`); on the twins model SMT went from `inconsistent-axioms` to
      `not-evaluable`. (3) A usage-level `:>> k = 7.0` over a bound `k = 5.0` keeps its own binding
      F row; `u.k == 5.0` / `== 7.0` now read ? with the unread-end sentence instead of the
      (4) CLOSED 2026-11-17 by a5-words W2: `bounds --measure u.k` (a dotted path of a fenced
      feature) now gives the not-evaluable row instead of the "names nothing" refusal with a stack
      trace; `--measure`/`--free` resolve a dotted path and quoted spellings (see (f) below).
      definition, the usage body and a subtype, a nested part with a same-named attribute, the R1
      channels, a unit on k and a deep binding chain — rebuilt out of tree, 120 models x 2 orders,
      0 WRONG / 0 decided->different-decided / 0 order mismatches. Still not generated: a bound end
      three or more redefinitions deep, a `calc` body read. [fence-seed]

- [ ] **Abstentions left in quoted names in expressions (rollup; sound, only weaker).** A quoted name
      is now a name reference on every lane and in the edit path; a feature whose declared name
      holds a dot is read by its quoted spelling (since a5 PA5 a quoted name holding `.` or `:` is a
      name like any other, and `a.b` stays the path a then b; probe dot.sysml reads T/T/T/T). Left:
      (b) `bareTie` (defining-equation.ts ~6861) and `NAME_TOKEN` (src/api/property.ts ~532) read
      plain identifiers only, so a quoted tie `'K x' == 'L x'` counts as a taint source (more
      abstention), and property.ts ~491 drafts a skeleton clause with the unquoted name
      (`max load >= 5`), which does not parse (probe rv/d1.sysml); (c) a check-behaviour atom
      `p=state 'deg A'` is answered INCONCLUSIVE "not read" where `state deg A` works (probe
      rv/bh/s1.sysml); (d) on the unit-aware path an info message for a body it cannot read starts with
      "a call, an index or a string literal" and gives the real cause only after a semicolon;
      (e) a `//` comment holding an apostrophe inside an expression now reads "Unterminated quoted
      name at N" where it read "Unterminated string literal" (both unknown; probe rv/cm.sysml);
      (f) CLOSED 2026-11-17 by a5-words W2: `bounds --measure` and `--free` take a quoted spelling
      (`QS::P::'K x'`, `QD::P::'a.b'`) as their unquoted forms do, and `quoteName` is exported for
      the property draft (probe fix-quoted-scratch/bnd.mts);
      inside an expression is unread, quoted or bare; (h) the default `bounds` measure and the
      instance labels follow name order, so a bare and a quoted-renamed model differ there (7
      corpus models); about 407 of the 637 corpus models were not run through the quoted-rename
      harness (fix-quoted-scratch/mm). [fix-quoted]
      (c) CLOSED 2026-11-21 (sm-qatom): a check-behaviour atom reads a quoted state, node, transition or trigger name as the name it
      quotes (`state 'deg A'` = `state deg A` = `state P::M::'deg A'`), pinned in semantics.mc.quoted-atom.test.ts.

- [ ] **Abstentions left under the genericity audit of 2026-11-02 (rollup; sound, only weaker).**
      Metamorphic audit over the 637-model corpus (rename: 636 transformed; reorder: 634; wrap and
      instance: 637; identity run byte-identical; no decided verdict changed except the quoted-name
      entry above). (1) Order: RULED PERMANENT 2026-11-16 (reversible; reverse by re-adding to its entry): the
      per-instance satisfy read is not within the tool's reach — probed on r16-subject-dflt (the
      default twin decides R's row F/F/-/F and abstains on the satisfy's row) and r16-subject (the
      no-default twin files its contradiction + SMT X), whose rows do not move with R's row in
      either member order and would lose a reading if forced; the four-surface letters of both
      twins in both orders are pinned (a5-hd2-r16*, not STAND_ALIKE) and the satisfy path stays as
      it is (a5-heads2 HD2; reports a5-heads2-scratch/hd2/report.md §7); the twin corpus models are
      gate-tools/corpus/…-r16-subject-dflt.sysml and …-r16-subject.sysml; the numeric `solveFeasible` of brief-targets-by-layer flips from decided feasible to undecided when
      the members are reversed (propagation order; iteration counts move 2 to 3); the one code
      reported for a group with two causes (refinement-sibling-shortfall) follows source order; the
      per-instance rows are capped at the first 256 in source order. (2) Instance: since a5 PA2 a
      package-level `assert constraint px { h.p.x == 3.0 }` that imposes a value through a part-def
      instance (`part def H { part p : P; } part h : H;`) is imposed, and `h.p.y == 7.0` reads
      violated as it does with the inline twin; `bind w = hold_p.p.load` through a part-def instance
      is still not followed (r14: w = 50 lost). (3) Label-only differences: group and
      instance labels, evidence footprint digests of anonymous binding connectors, the order of two
      names in a reason string. (4) Measures are chosen by NAME: `MOE_NAME_RE = /moe|measure|objective/i`
      in src/semantics/solver.ts, so renaming `totalObjective` drops its analysis-report measure
      row (not a verdict cell; a documented heuristic, to be replaced by an explicit marker).
      Probes: scratchpad genericity/{rename,reorder,wrap-and-instance}/ (harness batch.sh,
      harness.sh, compare.py; repros in the reports). [genericity audit]
      (5) Names (names-pass): since a5 PA1 a dotted path through an enclosing one-instance usage is
      read, and the check's quantityScope goes via lexicalPackageOf, so a unit-bearing lexical path
      reads (g5f `k` T/T/T/T, `kf` F/F/F/F); an assert typed by a constraint definition with no body
      still makes the literal and SMT surfaces abstain file-wide, and a plain constraint typed by a
      constraint definition files a ?/?/?/? row since a5 S4 (reading it with the parameters' values
      is TY1/TY2, by position). [names-pass; a5 PA1]
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

- [x] **Abstentions left (parallel machines and Simulate) (rollup; sound, only weaker).** (1) On a
      parallel machine where one region refuses and the others simply come to rest without refusing,
      `stopsRun`, `atRest` and `complete` stay false even after more ticks, so Play runs on to the
      sample cap (probe parser-pass-scratch/review/probe4.mts); no verdict is involved. (2) 162,
      195 and 280 were closed by a documented decision (docs/06 section 8.16 and the USER-GUIDE),
      not by code: the completion refusal for a count past the budget is permanent, the livelock
      pass cost (about 20%, 240 to 290 ms on the 9,641-configuration model) is accepted, and the
      Simulate trace stopping at a composite step's holding machine is the intended behaviour;
      re-add the entry with its original title to reverse one. [parser-pass]
      Rulings 2026-11-11: B-redef read only a bare `state :>> b;` of a general machine; stopped at a redefiner with a body, a transition `:>>` and two general machines.
      (1) FIXED 2026-11-20 (sm-parroot): a refusal in any region of a parallel machine stops the whole run (`stopsRun`, `atRest`), pinned in simulate.test.ts.
      CLOSED 2026-11-21 (state-machine goal): (1) fixed (sm-parroot); (2) closed by its documented decisions; the 2026-11-11 B-redef ruling
      is superseded by T-115 (closed 2026-11-21). The rest of this rollup — (3) to (6), decisions in other areas awaiting confirmation — moved
      unchanged to the item "Decisions to confirm (2026-11 rollup, moved from the parallel-machines rollup)".

- [ ] **Decisions to confirm (2026-11 rollup, moved from the parallel-machines rollup).** Moved verbatim on 2026-11-21 from
      "Abstentions left (parallel machines and Simulate)", whose state-machine parts are closed; none of these is state-machine work.
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
- [ ] **Abstentions left (defaults) (rollup; sound, only weaker).** (a) CLOSED 2026-11-16 by a5-heads2
      HD1 (step 1cedde4, review c149114): a name-reading side such as `L == K * 2.0` against
      `M = 3.0`, and the m218 package-head shape (`bind P::load = M` with `:>> load = 3.0`), now
      decide exactly as the constant twins do (pins a5-hd1-nrs/-head/-va; the lost probes are
      reconstructed in a5-heads2-scratch/hd1-draft/). NOT closed: the `=`-valued definition-feature
      head variant (P's `attribute load : Real = 2.0` beside `M = K * 2.0`) still reads ?/?/?/?
      byte-identically to base (weaker, never false) — filed under the pkgbind/HD3 family. (b)
      A context row `P::c in W::q::p` reads unknown beside the satisfied instance row when load has
      no value, and the differential harness throws two check rows on it, so probes need a default
      on load (defaults-pass-scratch/x6a.sysml, pre-existing). (c) CLOSED 2026-11-16 by a5-heads2
      HD4 (branch commits 81885e3/8dc71f2, merged): a definition's context row is filed under the
      definition whatever the declaration order, and a binding-carried reading (`P::ca in Q::p` —
      'load is not read in Q::p' + the #bind pair) is kept beside it on all four surfaces. The
      shape that flips on base is the recorded variation: the specialiser states `load = v` with
      `=` beside a bind in Q, `q1 : Q` and `w : W` (pinned a5-hd4-wqp/-rev; the old probe
      defaults-pass-scratch/m218/G009-eqT.sysml is lost — see a5-heads2-scratch/hd4-report-notes.md);
      with plain defaults only the filing NAME flips (q-direct, p2-default), also fixed. (d) CLOSED 2026-11-16 by a5-heads2 HD5 (step 6d4ce65, review f7271b6): the typed-inequality hold
      is placed by the instance the assert's value is read in (and below it), not by feature, so a
      sibling instance that reads the feature otherwise is freed (pins a5-hd5-hold/-dot/-bind/
      -body/-special/-two and their revs); a reading through a part a definition holds (a value
      whose path runs through a definition-level usage) stays feature-wide — fail closed — and the
      guide states that exception. A typed assert whose parameter is bound with
      `bind x = L` is NOT an abstention left: it is held (fixed in the review of 'Hold a feature an
      assert typed by an inequality-only constraint definition constrains'). (e) An enclosing assert
      naming a binding-carried feature (A2E q2 p.load >= 0.5 over bind p.load = L;
      defaults2-pass-scratch/p6/se-none.sysml, differential A2E-enclosing-assert and
      stand-enc-bound), an enclosing assert on a valueless feature, and = plus a redefinition of
      that = under an enclosing assert (stays unknown through the existing #bind contradiction;
      gen211 models G60, G72, G96) still abstain. Ruled permanent 2026-11-15 (reversible; reverse
      by re-adding to its entry): the enclosing-assert abstention over a binding-carried value
      stands — the exemption fix worked (A2E q2 F/F/F/F, stand-enc-bound T/T/T/T) but broke three
      pinned decisions that state the rule deliberately ('…and abstains on a bound one (211)',
      'reads a binding into the instance over its type's assert… (RB, BND)', 'abstains under an
      enclosing assert, and files every instance once'); do not re-attempt without changing those
      tests' intent. The valueless-feature and = plus a redefinition halves stay with the ruling
      (stop rule → P). (f) Literal X on generic rows of a file whose
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
- [x] **Abstentions left in Save of an end (rollup; sound, only weaker).** fence-text: the end is no
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
      CLOSED 2026-11-21 (sm-saveend; user ruling "close as ruled"): Save writes a lone unnamed redefinition reached by a transition,
      succession, allocation, dependency or alias end under the name it already goes by (`state s1 :>> s1;`), verified by re-parsing
      (text.save-end-names). Ruled permanent limit, the loud `// Not saved:` note kept (never a wrong save): a named end behind an earlier
      member of its name, two or more unnamed `:>> M`, an unnamed one beside a named member of its name, and 2nd+ requirement-relationship
      or inline-specialization ends — any faithful text needs a member reordered or renamed, which changes the model (in a state machine,
      the declaration-order tie-break). Reopen by re-adding the item with its original title.
- [ ] **Abstentions left in the order of listings (rollup; sound, only weaker).** (1) validate()
      lists its diagnostics ordered by element id, so a page, a terminal and a peer list the same
      findings in different orders (probe wave3-probes/fence-order/gen.mts with the `.sort()`
      removed, 150 seeds, 59 cells; fence-order-scratch/gen-unsorted.mts and vo.mts). It is sorted
      but not stable across loads, not a wrong answer, and pre-existing; a stable order would need a
      text-order sort key in validate.ts. [fence-order review]
- [x] **Coverage universe: fold the API/OSLC PSMs and the 17 rendered views into the matrix.**
      `docs/CONFORMANCE.md` §3–4 already test the API and OSLC PSMs, and the E2E suite renders all
      17 views, but `coverage-universe.json` lists the 7 API service groups and the 11 view kinds as
      `unmeasured`. Map each group/kind to its existing test, set its state (`decided`/`rendered`)
      with the evidence link, and keep the percentages honest: an API group is `decided` only where
      a test asserts its contract, a view kind `rendered` only where an E2E spec asserts its panels.
      Done: the 18 rows are measured with evidence, the page's "unmeasured" count drops by 18, and
      the two headers are recomputed. [coverage-universe; CU-1]
      CLOSED 2026-11-18 by a5-cu CU1 (merge 928adb7): 17 rows measured (6 API groups `decided`, 11
      view kinds `rendered`, each with its test as evidence); `API:other` (§5.7 POST /transform and
      /validate) stays `unmeasured` because this build ships neither and no test asserts them, so
      the 18th row is not measured here. Measured 39→56, unmeasured 40→23, FALSE 0.

- [ ] **Coverage universe: measure the read/determine column for the textual areas the corpus uses.**
      The 14 textual constructs are `parsed` (corpus parse conformance) but their semantic read is
      unmeasured — only the constraint lane has a decision column. For each area, pick one corpus
      model (or write a small pinned probe) that exercises it, run the four surfaces
      (`sysml-check`, literal, numeric, SMT) and record whether the construct reaches a row and its
      sentence, with the probe file as evidence. Start with parts/attributes, ports, interfaces,
      states, requirements and allocation; leave actions/occurrences/metadata until their surfaces
      exist. Done: each `TXT` row carries `read` or `partial` with a probe, and the "read" claim is
      no longer parse-only. [coverage-universe; CU-2]

- [ ] **Coverage universe: the normative clause list, not the illustrative doc tables.**
      Phase 1 derived its rows from `docs/02-omg-standard-reference.md` (which is an engineering
      summary — its §2.2 table yielded 22 of the 26 metaclass rows, and §3.2 is a snippet catalog).
      Build the real universe: KerML §8–9 clauses, SysML v2 textual §7 clauses, graphical clauses
      and the API/services clauses, each with a stable id (`KERML:Element`, `TXT:constraint-usage`,
      `GRAPH:interconnection`, `API:commits`), the clause number, and the construct text. Keep the
      existing rows as aliases so the matrix does not jump. Done: every area has clause-numbered
      rows, a coverage script regenerates them, and the extraction gaps are closed.
      [coverage-universe; CU-3]

- [ ] **Coverage universe: probe the KerML kernel rows.** The 22 KerML metaclasses are what every
      semantic read stands on (classification, featuring, type intersection, membership/imports,
      specialization). No per-metaclass state exists. For each, write a minimal pinned model where
      the construct must matter (a classification/featuring/type-intersection case, an import, a
      specialization chain) and record what the tool reads/determines on the four surfaces; a
      construct the tool ignores is `unread` with that evidence. Done: the KERML rows carry states
      (or an explicit "no probe possible yet" note), and any `unread` finding is filed as its own
      item. [coverage-universe; CU-4]

- [ ] **Coverage universe: scope ruling for analysis cases, trade studies and optimisation.**
      SysML v2 leaves analysis cases, trade studies and optimisation to analysis procedures, not to
      decidable checks, so they cannot become covered rows in the same sense. Write the scope ruling
      (in/out, why, what would be measured if they are out) into the coverage page and the plan;
      then add the `verify`/`refine` lane's documented claims (`docs/CONFORMANCE.md` §8, the
      declared deviation and the verdict slot) as rows with their own states. Done: the page lists
      the declined scope with the reason and the `verify`/`refine` rows are measured or explicitly
      deferred. [coverage-universe; CU-5]

- [ ] **Coverage universe: per-area wrong-statement counts beside the coverage.** A high coverage
      percentage must not hide a bad area. Add, per area, the count of open wrong-statement
      findings whose rows touch that area (the dashboard's FALSE tier and the class register's
      "rows against" are the inputs), show it beside each area's row count, and keep soundness out
      of the percentage. Done: each area row shows its false count; the coverage page states the
      per-area rule. [coverage-universe; CU-6]

- [ ] **Coverage universe: a CI drift gate.** The coverage datasets are regenerated by
      `refresh.py` but nothing asserts they do not regress. Add a check (like the docs-counts
      guards) that regenerates `coverage.py` output and fails when an area loses a measured row, a
      row's state drops (decided→partial→refused), the unmeasured count rises without a reason, or
      the false count rises. Run it in the gate and record the numbers in TEST-REPORT like the class
      facts. Done: the guard is green on the current tree and fails on a planted regression.
      [coverage-universe; CU-7]

- [ ] **Coverage universe: state the weighting policy.** The two headers mix corpus usage (TXT) and
      counted rows (CON). Write the policy down and report at least two variants (equal-weight and
      corpus/generator-weighted) so no single percentage hides the choice; keep the generators'
      model space (the 1 100-model sweeps) as the weight source where it exists. Done: the page
      shows both variants and names the weights per row. [coverage-universe; CU-8]

- [ ] **Coverage universe: trends and evidence links.** The coverage page is a snapshot with no
      history and only partial evidence links. Add a per-merge trend (like the timeline: measured
      rows, decided classes, false count) and a link from every row to its probe/test/corpus file.
      Done: the page has a small trend chart and every measured row links its evidence.
      [coverage-universe; CU-9]

- [ ] **Coverage universe: declined scope, spec version pinning and ownership.** Record the OMG
      spec revision the universe is built against (the 2025 adoption and the reference OpenAPI
      version in `docs/02`), the areas deliberately declined (see CU-5), and who refreshes the
      universe when the spec or the docs' tables change. Done: the coverage page's meta block names
      the spec version, the declined areas and the refresh procedure; the handover carries the same.
      [coverage-universe; CU-10]

- [x] **Read a typed or asserted body's dotted, derived and per-instance values (TY1 follow-up).**
      TY1 stopped under its STOP RULE (b): the positional pairing works (`tp1` F/F/F/F, `tp2`, `tp3`,
      `tpr` refused with the positional sentence, `XS2` byte-identical), but nineteen pinned
      `name-cd*`/`name-tp*` rows stay `?` because the typed equation never reaches the feature-level
      dotted/derived/per-instance machinery: `equationsOf`/`equationsByName` index the substituted
      equation under the usage, but `enclosingAsserts`/`assertDefinitionsAt` (empty
      `replaceableDefaults`, decision 14 amended), `feature()`/`chainDefinition` for dotted names and
      the instance builder's `assertsOf` do not read it; a generic `q.L` is not instantiated per
      instance; and the given-way sentence ("whose equation this tool does not read") would be FALSE
      once the body is read. The decisive control is an UNTYPED defining assert over the same shape
      (`dv1.sysml`), which already refuses the same rows per instance; so this is a derivation gap,
      not a TY1 bug. Fix the derivation and the three sentence sites (`givenWayCause`,
      `typedAssertText`, `declaredWithout`) in one change; then re-run TY1's body-reading half on top
      of the saved TY1 partial (`a5-typed-ty1-scratch/ty1-partial.diff`, 742 lines) and re-pin the
      named families. Done: the named rows reach their refs (or a recorded, sound `?` with a true
      sentence), the given-way sentence no longer claims an unread equation, the 637-model
      differential stays exactly "631 identical, 6 differ" with the six ids, v9 has no DIFFERS, and
      the branch gate is green. [typed-usage; TY1 follow-up; a5-typed TY1]
      PART CLOSED 2026-11-18 by a5-typed TY1A (merge d055229): typed and asserted bodies are read at
      feature level and the three sentence sites are lane-qualified (the "does not read" sentence
      remains only for a genuine refusal). Ruling 2026-11-18: the step's sound letters widen beyond
      the nineteen named rows to `mask-param MP::tc/MP::tx` literal `?→T` and `MP::V::holds` `?→T`
      (`name-cd-eq` is within `name-cd*`), because the file-wide abstention could not be kept
      without restoring the false "body not read" claim. TY1's body-reading half is delivered by
      TY1A itself (it applied the saved TY1 partial and extended it; no re-run is owed). Nine named
      rows stay a sound `?` with a true sentence, as the step permits (CD4::Q::cl, CD5::Q::cl,
      CD6::P::c, CD8::Q::cl-in-q, CD8::Q::e-in-q, CD8::topL check, CD9::Q::c, CD9::Q::cl,
      CD9::topF). The literal and SMT obligation stays TY2's half. TY2 follow-up: TY1A's SAME_POINT_DEMOTED move
      lowers the `lra` class from differential-tested to tested (knownFalse 0→2, tableDisagree +2);
      it is a recorded measurement change, not a regression.

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
      demotes. Since a5 HD3 a package head bind written in a package that imports, or is nested in, the package that declares the instance's definition (a plain import, a membership import, a recursive `import Defs::**` or a qualified end) is read: pkgbind-head-nested decides on the numeric and SMT surfaces (ldF/ldM ?/?/F/?, ldT ?/?/T/T), and a head bind in a third package files its violated #bind row; a bind whose other end names a feature that two imports expose is unresolvable and withholds the head's own value (withheldJoins, reading ?/?/?/?); the usage-end `bind top.L = XX` cases still abstain. The proper reading (joining the instance's own context to the definition's binding) stays open for those. Probes: ep-review/v/s3.sysml, s7.sysml, s11.sysml, s12.sysml and
      fence-pkgbind-scratch/gen4/pkgbind-*.sysml. [editor-pass review; fence-pkgbind]

- [x] **T-115: Walk a redefined state or transition of a general machine, or a machine with two generals.** Since B-walk a `state def Derived :> Base` with one general machine, and a typed `exhibit state m : Modes {…}` with steps of its own, are walked and run over the general's region plus their own steps: one view, `machineRegion`, read by the walk and the interpreter; inherited steps first; Base is walked alone; a typed usage with no steps is reported through its definition. A bare `state :>> b;` or `state r :>> b;` is read as the state it redefines. Still `machine-boundary`: a state redefinition with a body, a transition redefinition, an attribute `:>>`, a step that names a redefining state, two general machines, two start nodes, a cycle of generals. [behaviour-small S1; behaviour-walk B-inherit, B-walk, B-redef]
      PART DONE 2026-11-20 (sm-t115, sm-tredef): the walk and the interpreter read, through one `machineRegion` view, a plain `state :>> s;` (it is s), a body
      redefinition `state r :>> s {…}` over an EMPTY s (r takes its place), a transition redefinition (t2 replaces t1; it must state both ends and every
      attribute t1 carries), and two generals that share no id and no declared name — each equal to its hand-flattened twin on reach and on 20 random runs.
      The textual `transition t2 :>> t1 first …;` (and `redefines`) now parses; any other specialization tail on a transition is refused.
      STILL machine-boundary, with a stated reason: a redefinition over a state that holds something of its own (the spec merges the two; this view does
      not), an unnamed redefinition with a body, a nested redefinition, an attribute `:>>`, a state redefined twice with a body, a step naming a replaced
      state, generals that collide, a cycle, a chain over eight, two start nodes. A redefinition that targets a non-transition is not diagnosed.
      MORE 2026-11-20 (sm-t115b): a body redefinition `state r :>> s {…}` over an `s` that holds only substates and steps between them MERGES the two
      (SysML v2 Part 1 §7.3: a redefining usage replaces the redefined one and inherits its features; inherited and owned names must be distinct),
      equal to its hand-flattened twin on 40 random cases. STILL refused with a reason: an `s` holding entry/do/exit, attributes, a start or
      history; a name held by both; a nested `:>>`; a redefinition of a redefinition.
      CLOSED 2026-11-21 (user ruling "close as ruled"): what SysML v2 Part 1 settles is read (plain and body redefinitions, merge over substates and
      steps, transition redefinition, two non-colliding generals); the shapes the spec text does not settle stay machine-boundary refusals with
      their reasons (a redefined state holding entry/do/exit or attributes, a nested `:>>`, a redefinition of a redefinition, colliding generals,
      cycles, two starts). Reopen by re-adding the item with its original title.
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

- [x] **Parallel states per SysML v2 (§7.18.2, §8.4.14) — MANDATORY: the tool must conform to the spec.**
      Today `sysml.langium` has no `parallel` keyword (spec grammar `isParallel ?= 'parallel'`): in
      `state def Modes parallel { state nav {…} state comms {…} }` the word `parallel` becomes the
      definition's name (`P::Ctl::parallel::nav`), `Modes` is lost, no diagnostic is raised, and
      `reach` prints "2 state machine(s), 2 walked to exhaustion" — the same output as the file without
      `parallel`. The explorer's refusal (`explore.ts` `unsupportedConstructs`, `parallel-regions`) is
      reachable only through the API, and the interpreter CONCATENATES regions instead of performing
      them concurrently. The spec: a parallel state's substates "are performed concurrently"; a
      non-parallel state's substates are `exclusiveStates` (exactly one active after entry); no
      transition may go between the substates of a parallel state (§7.18.3).
      Two stages, both required. (1) FENCE, first (wrong statements today): parse `parallel` into
      `isParallel`, keep the definition's name, and refuse parallel machines with
      `verification/behaviour-unsupported-construct` and no exhaustive claim. (2) CONFORM: perform the
      substates of a parallel state concurrently in the interpreter and explore every interleaving the
      spec admits in the explorer (so `reach`/`check-behaviour` decide parallel machines), validate the
      no-transition-between-concurrent-substates rule, and update the semantic profile's `regions`
      field from "concatenated" to the spec reading. Probes: the spec's `VehicleStates parallel`
      example (§7.18.2) and a two-region machine whose regions are coupled by a guard. Done: both
      stages merged, the probes decided per the spec, the profile no longer declares a departure on
      regions, and the 637-model differential reads exactly "631 identical, 6 differ" (or every move
      ruled). [mc-vs-bib 2026-11-18; wrong statement; spec conformance mandatory 2026-11-19]
      STAGE 1 DONE 2026-11-19 (a spec-par PS1, merge pending push): `parallel` parses into
      `isParallel`, the definition keeps its name, a parallel machine (also one nested in an
      ordinary machine) is refused with `verification/behaviour-unsupported-construct` from text
      (`reach` "0 walked", `check-behaviour` inconclusive, exit 2), the keyword round-trips, and
      `validation/transition-in-parallel-state` rejects a transition between a parallel state's
      substates (§7.18.2). Ruling 2026-11-19: the 637-model differential reads "630 identical, 7
      differ" — the seventh is `d45dcfa21d53-health-effect.sysml`, a parse-error model whose error
      message now lists `parallel` among the expected tokens (message and `expected` array only:
      same codes, ranges, verdict, exit 2); accepted as the direct consequence of the keyword.
      STAGE 1b DONE 2026-11-19 (spec-par-ps2): `exhibit state es parallel { … }` and `state <M> parallel { … }`
      keep their name/short name and body and are refused as parallel machines (the short-name case is
      read from the text shape in the mapper, because a grammar-only fix made Langium log an ALL(*)
      ambiguity); `exhibit action|use case … parallel` is no longer read as a parallel exhibit state.
      STILL OPEN: stage 2 (concurrent semantics and an interleaving explorer, profile `regions`
      field); the rest of §7.18.3 (`validateStateDefinitionParallelSubactions` /
      `validateStateUsageParallelSubactions`: a parallel state's own substates have no transitions in
      or out); nested parallel states still run as exclusive in the simulator (only the explorer
      refuses them); `exhibit action ea parallel {…}` / `exhibit use case u parallel {…}` /
      `perform action p parallel {…}` are now an error (`parse/parallel-not-on-state`, fence-comment
      2026-11-19; the body is still kept under a usage named `parallel`, only the diagnostic is new).
      STAGE 2 PART DONE 2026-11-20: (interpreter, sm-par2) a parallel state NESTED in an ordinary machine runs its regions concurrently — entered whole,
      every event offered to every region in declaration order, a region with no enabled transition stays, a leaving transition exits all regions; the
      fixed region order is a stated choice (a coupling test pins both orders). (explorer, sm-par3) the same machines are explored: one active leaf per
      region, the explorer agrees with the interpreter on every event sequence up to a bound (semantics.mc.parallel.test.ts); the profile `regions` field
      now says so. Refused with a stated reason in both: a parallel state inside a parallel state, a completion transition out of a parallel state,
      history inside one, a transition between regions or out of a region, a region whose start is unread, an entry action naming a start. The explorer
      also refuses COUPLED regions (one writes an attribute another reads or writes: a token-level scan, over-refuses) and an event taken by both a region
      and a leaving transition. STILL OPEN: a parallel machine ROOT (`state def M parallel {…}` — the interpreter still runs its regions one after
      another over the whole script, the explorer refuses it); exploring every ordering of coupled regions instead of refusing; a completion transition
      out of a parallel state; witnesses on parallel machines (withheld: `fail`/`covered` rows come out inconclusive); the Play-path abstention (one region
      refuses, the others come to rest: Play runs to the sample cap).
      ROOT DONE 2026-11-20 (sm-parroot): a parallel machine ROOT runs and is explored as a parallel state (all regions entered at once, every event
      offered to every region in declaration order); the run is complete when every region is final; a refusal in any region stops the whole run
      (Play no longer runs to the sample cap). A join/completion transition out of a parallel root is now REFUSED (it used to fire once every region
      was final) — weaker, not wrong. REVIEW FIXES (sm-fixrev): coupling is now followed through a referenced action and a transition effect naming
      an action; a region's timed transition is refused by the interpreter as by the explorer. STILL OPEN: exploring every ordering of coupled
      regions instead of refusing; a completion/join transition out of a parallel state or root; witnesses on parallel machines (withheld);
      a parallel state inside a parallel state; history inside one.
      MORE DONE 2026-11-20: (sm-parcomp) a parallel state / root whose every region is final takes its completion transition (interpreter and walk alike;
      the root join fires again). (sm-orders) COUPLED regions are explored in EVERY order (at most 4 regions; more refused with its reason), so the
      walk is a superset of the interpreter's fixed-order runs; a state read as a region sees the attributes of the states and machine around it
      (lexical scope), so a guard there is decided. STILL OPEN: witnesses on parallel machines (withheld), a parallel state inside a parallel
      state, history inside one.
      MORE 2026-11-20 (sm-parpar): a parallel state inside a region (of a parallel state or a parallel root) is performed and explored — regions form a
      tree, an event is offered depth-first in declaration order, nested completion and exit inner-first (semantics.parallel-deep). STILL OPEN:
      a region that is itself a parallel state, history inside a parallel state, witnesses on parallel machines.
      MORE 2026-11-20: (sm-witness) witnesses on parallel machines are replayed through the interpreter and published when they replay step for step;
      a path that needs a non-declaration region order stays withheld with its reason. (sm-chase) one completion timing. STILL OPEN: a region that
      is itself a parallel state, history inside a parallel state.
      MORE 2026-11-21 (sm-parhist): a region that is itself a parallel state is performed and explored (its substates are its regions).
      History inside a parallel state stays refused — the explorer refuses history everywhere, and history has no SysML v2 textual
      notation (API only). Nothing in the parallel semantics remains open beyond that ruled refusal.
      CLOSED 2026-11-21: stage 1 and stage 2 are done (see the notes above); history inside a parallel state is a ruled refusal (user ruling
      "close as ruled": history has no SysML v2 textual notation, is reachable only through the API, and the explorer refuses it everywhere).
      Reopen by re-adding the item with its original title.

- [x] **The long form reads `accept E [g]` as a guard; SysML v2 reads `[g]` as the payload's multiplicity.** `transition t first a accept E [g]
      then b;` is read today with the guard `g` (UML-style). SysML v2 §7.18.3 writes a guard `if g`, and §7.17.8 makes `[g]` after the payload
      name a multiplicity. Conforming would turn every such guard into a multiplicity (a dropped guard), so the decision is the user's: fence it
      (refuse with a hint to write `if g`) or keep it as a documented departure. [review 2026-11-20]
      CLOSED 2026-11-21 (sm-gfence), user ruling "fence it": `accept E [g]` is refused (`mapper/state-form-unread`) with the hint to write
      `if g`, in the long form and the shorthand; never read as a guard or a multiplicity. No corpus, fixture or example model used it.

- [x] **Unify when a region's completion transitions are chased.** The interpreter chases a region's completions right after that region
      steps, before the next region sees the event; the explorer chases after the whole event. With coupled regions a path differs (the
      walk reaches the interpreter's states by other paths, probed 2026-11-20) and no missing state was found, but agreement is not proved. Done:
      one timing in both, or a proof that the reachable sets agree, with a differential pin. [sm-parpar review]
      CLOSED 2026-11-20 (sm-chase): one timing in both — an event is offered to every region, THEN completions are chased (regions in declaration
      order, nested first); the walk's reachable set equals the interpreter's union over region orders (semantics.parallel-chase).

- [x] **A completion transition out of a composite state fired at once (wrong answer, on main before 2026-11-20).** `transition cz first c then z;`
      out of a composite `c` was taken on entering `c`, so the walk published `c`'s substates unreachable. SysML v2 Part 1 §9.2.11.2.1: a
      transition without an accepter follows the completion of its source's performance, substates included. CLOSED (sm-compcomp): one rule in the
      shared step relation (`stateCompleted`, config.ts) — a composite completes when its active leaf ends it (a final state or `done`,
      `endsContainer`), a parallel state when every region does. Corpus: only DeadlockGuarded::Nested::Modes moved (its `sub2` is now a decided
      dead end).

- [x] **v9: three transitions out of `OA::SwarmMemberModes::Nominal` fire on the same event.** Since `accept p : T` reads T as the trigger
      (2026-11-20, §7.17.8), `accept positioningLostNotice : Common::ConditionNotice` and its siblings are all enabled by any `ConditionNotice`, so `reach`
      reports a nondeterministic choice there (13 instead of 12). The payload NAME does not filter; the model needs a distinct item def per notice,
      or a guard on the payload. A model change in mbse-workflow-public, not a tool change.
      CLOSED 2026-11-21 (mbse-workflow-public 499c9e5, private 1791926), user ruling "distinct item defs": nine item defs specialise
      ConditionNotice and each transition accepts its own; reach is back to main's 12 nondeterminism findings.

- [x] **Review 2026-11-20: three wrong answers in the state-machine verification code.** (1) regions coupled through a referenced `entry X;` action
      were explored as exhaustive over one region order; (2) a transition effect naming an action (`do action bump`) was dropped, so the walk
      published a reachable state as unreachable (on main since before 2026-11-19); (3) an assignment effect that failed when its transition fired
      was skipped (also on main). CLOSED (sm-fixrev): each is fixed or refused with its reason and pinned in semantics.review-fixes.test.ts; also
      a region's timed transition is refused by the interpreter. Left: a transition effect with no `=` that is not a name is still ignored; the
      effect-name lookup does not follow imports (it refuses instead).
      CORRECTION 2026-11-20: finding (2) read `do action bump` as a reference; per §7.18.3 (OnOff4) `do action X` DECLARES a new, empty effect action, so
      main's reading of that form was right. Only `do X` refers to the action X and performs it (attrs.effectRef). The over-reading refused 9 of
      v9's 17 machines in an ungated tree and was caught by the behaviour differential before any merge.

- [x] **Transition effects cannot be written inside a nested state.** `entry assign x := 1;` / `do assign …;` / `do send X to Y;` in a state body are refused
      (`mapper/state-form-unread`) and the `assign` inside `entry action w { … }` is not applied by the interpreter, so a transition effect on a nested
      (parallel) region can only be set through the API; the region-coupling case of the parallel work is therefore tested through the API only. Done: the
      spec forms read, the interpreter applies them on entry/exit and on a transition, and a text test pins a coupled-region machine. [sm-par2 2026-11-20]
      CLOSED 2026-11-20 (sm-effects, sm-fixrev): `entry|do|exit assign x := e;` reads as the long form `entry action { assign x := e; }`, a transition's
      `do assign x := e` as its effect; the interpreter and the walk apply them alike (entry/exit of each region of a parallel state included), and an
      effect that cannot be evaluated — at the opening dry run or when it fires — refuses the run and the walk with its reason. `do send` stays refused.
      A text test pins a coupled-region machine (the explorer refuses it, the interpreter gives both declaration orders).

- [x] **A referenced entry action's effect, and a reference start succession.** With `entry X;` read as a reference ([x] item above): (1) a referenced
      action's effect is not applied when the state is entered (`applyBehaviorEffect` reads only the element itself; a declared entry body was not followed
      either); (2) `entry init; … transition first init then s` binds `first init` to the referenced action when `init` exists, and the start-reading code does
      not follow a reference entry's own name; neither was probed in the app. Done: both are decided per the spec or refused with a stated reason, with a
      pin each. [sm-entryref 2026-11-20]
      CLOSED 2026-11-20 (sm-refeff): `entry|do|exit X;` applies X's own assignments (walk and interpreter alike); an X with anything but assignments, a
      parameter, a typing that brings a body, or a reference that does not resolve or loops refuses with a reason. The succession written after the
      reference entry (`entry X; then s;` / `first X then s;`) is the start; a `transition` from the action's name is refused with a specific reason.

- [x] **The spec's own state-machine example does not parse: `entry; then off;` is an error.** SysML v2
      Part 1 §7.18.3's `state def OnOff1 { entry; then off; state off; state on; transition off_on
      first off then on; transition on_off first on then off; }`, verbatim, gives
      `error parse/dangling-then` ("'then off' has nothing to follow") plus a `split-declaration`
      warning on `entry;`, and `stats` reports 0 relationships. The entry-then succession is how the
      spec names a machine's initial state. Done: the §7.18 examples (OnOff1, OnOff2, VehicleStates)
      parse with no diagnostics, the initial state is read as the entry succession's target, and a
      test pins each example verbatim. [mc-vs-bib 2026-11-19; spec conformance mandatory]
      PART DONE 2026-11-19 (spec-par-ps2) — `entry; then X;` only; OnOff2 still needs the forms listed in the next item (`accept after`); the item closes with that one. Delivered: OnOff1, the Exercising example and
      VehicleStates parse with no diagnostics; a bare `then X` after an entry action is a succession
      from that action, and the machine starts at X (explorer and simulator) when the state has one
      entry action with one unguarded, payload-free succession into one of its own substates; every
      other edge leaving an entry action refuses the machine (never an exhaustive claim) and the
      simulator does not start (`Not started: …`); an entry/do/exit action's type, multiplicity and
      body are kept; `do`/`entry`/`exit` bodies are kept out of the machine's states.
      PROGRESS 2026-11-20 (sm-forms, sm-shorthand, time-trigger): `accept after 5[min]` parses as a time trigger (the interpreter and the walk refuse it: no clock), the guarded entry succession `entry; if c then off;` and the target-transition shorthand `state off; accept E then on;` read as the spec says, `entry action initial;` and `abstract exhibit state x;` parse. STILL OPEN: no spec text is available locally, so the OnOff examples are written from the notation and memory and are not yet pinned verbatim; fetch the spec text and pin each example.
      CLOSED 2026-11-20 (sm-specpins): every §7.18.2-7.18.4 example is pinned VERBATIM from the spec (SysML v2 Part 1, local corpus
      SystemsPerspectiveBib/03 omg-sysml-2.0-part1-2026) in test/unit/text.spec-7-18.test.ts: each loads with no diagnostic or is refused with a stated
      one, and is run and walked (or refused with its reason). `then done` (OnOff6) now reaches the containing state's final node.

- [x] **Say that the PSSM Clause 9 oracle was not built, or build a scored subset.** `docs/04` cites
      `omg-pssm-1.0-2019` Clause 9 as "a UML/fUML oracle for the conformance scorecard" for
      `reach`/`check-behaviour`; nothing in `src/` or `test/` uses it (one comment in
      `src/semantics/mc/profile.ts`). Done: CONFORMANCE §8.5 states that the departure from PSSM is
      declared field by field and not measured, or a subset of the Clause 9 tests is run and scored.
      [mc-vs-bib 2026-11-18; A]
      CLOSED 2026-11-20 (sm-docs): CONFORMANCE §8.5 states that the departure from PSSM is declared field by field in the profile and is not measured; no Clause 9 test is run or scored.

- [x] **Correct the two non-goals that send properties to an export that does not exist.** `docs/04`
      non-goals 1 and 3 send "anything unbounded" to "z3 k-induction or an SMV export" and real-time
      patterns to "export-only"; no SMV/nuXmv/OCRA export ships (only the opt-in OCRA reading of a
      bare `connect`), and the `cristoforetti-2026` path planned in phase 5 was not built. Done: the
      non-goals and CONFORMANCE say these properties are refused (`inconclusive`), with no external
      route today; building the export stays a separate decision. [mc-vs-bib 2026-11-18; B]
      CLOSED 2026-11-20 (sm-docs): docs/04 non-goals 1 and 3 and CONFORMANCE say those properties are refused (`inconclusive`) with no external route today; building an export stays a separate decision.

- [x] **State that machines are walked one at a time.** The behaviour profile and the non-goals do not
      say that no composition of state machines (synchronous or asynchronous) is checked; the corpus
      treats it as central (`graics-2020`, `cristoforetti-2026`, `basu-2011`). Done: a profile field
      or a non-goal says so, with the sentence pinned. [mc-vs-bib 2026-11-18; C]
      CLOSED 2026-11-20 (sm-docs): docs/04 non-goal 10 and CONFORMANCE say no composition of state machines (synchronous or asynchronous) is checked.

- [x] **Read the corpus against model-checking candidates 6–8 before building any of them.** `docs/05`
      and `docs/06` cite no SystemsPerspectiveBib document. Before stutter-simulation (6), signature
      consistency (7) or the behavioural fault tree (8) is built, read `bittner-2015`, `stewart-2021`,
      `joshi-2006` (8), `dealfaro-henzinger-2001` (6, 7) and `peres-ghazel-2023` (6) against them and
      record agreements and conflicts in `docs/05`. Done: `docs/05` carries the reading per candidate.
      [mc-vs-bib 2026-11-18; D]
      CLOSED 2026-11-20 (sm-corpus): docs/05 carries a corpus reading under candidates 6, 7 and 8 (agreements, conflicts, pages read) and §5 lists what was not read (peres-ghazel-2023 has no extractable text; stewart-2021 and joshi-2006 are mostly unread).

- [x] **Fix `docs/05`'s reason for rejecting realizability.** It rejects realizability with synthesis
      ("synthesis produces an implementation"); realizability *checking* (`katis-2022`,
      `larraz-tinelli-2022`) returns a verdict, not an implementation. The reason that holds is
      `docs/04` non-goal 5 (only static contracts are decided). Done: `docs/05` §4 gives that reason.
      [mc-vs-bib 2026-11-18; E]
      CLOSED 2026-11-20 (sm-docs): docs/05 §4 gives docs/04 non-goal 5 (only static contracts are decided) as the reason.

- [x] **More SysML v2 §7.18 state forms do not parse (spec conformance is mandatory).** After
      `entry; then X;` these spec forms still fail or are misread: `accept after 5[min]` (a time trigger,
      OnOff2–OnOff6), the target-transition shorthand (`state off; accept … then on;`, OnOff5/6),
      `entry action initial` (`initial` is a keyword here), guarded entry successions (`if c then off;`),
      `entry assign …;` / `do send … to X;` (mis-split into a duplicate-name error and a parse error),
      `exhibit A::B :> C;` (parse error) and `abstract exhibit state x;` (splits off a bare
      ReferenceUsage). Probe each against the spec text (Part 1 §7.18.2–7.18.4); fence a silent
      misread first. Done: every §7.18 example parses with no diagnostic or is refused with a stated
      reason, each pinned verbatim by a test. [spec-par-ps2 2026-11-19; spec conformance mandatory]
      PROGRESS 2026-11-20: parsed — guarded entry succession, `entry action initial;`, `abstract exhibit state x;`, the target-transition shorthand (`accept`/`if` after a state, source = the preceding state), `accept after`. Refused with `mapper/state-form-unread` and a stated reason — `entry assign …;` / `do send …;`, `exhibit A::B :> C;`, a shorthand with nothing to leave. STILL OPEN: reading those three instead of refusing, a `[g]` guard written right after the accept name in the shorthand (read as a multiplicity, refused), and the verbatim pins (no spec text locally).
      PROGRESS 2026-11-20 (sm-specpins, sm-done): the guard/accepter order is free, a typed and `;`-ended effect parses, `action x terminate;`,
      `exhibit state x references Y;`, `accept p : T` (T is the trigger, p the payload name — no longer dropped), `then done`. STILL refused with a
      stated reason: `do send …` (no send semantics), `exhibit A::B :> C;`, a `[g]` guard right after the accept name in the shorthand.
      MORE 2026-11-20 (sm-forms2): `exhibit A::B :> C;` reads per §7.18.4 (a nameless exhibit state usage of A::B subsetting C). STILL refused, by
      decision: `do send …` (a send to the machine's own port can trigger its own accepter, and the walk has no event pool), and the shorthand's
      `accept E [g]` (in SysML v2 `[g]` after the payload is its multiplicity; see the item on the long form's `[g]` guard).
      CLOSED 2026-11-21: every §7.18 form is read, or refused by a ruled decision with its reason (user ruling "close as ruled"): `do send …`
      (a send to the machine's own port would need an event pool across machines, docs/04 non-goal 10), UML's `[g]` guard (fenced above).
      Reopen by re-adding the item with its original title.

- [x] **`entry X;` / `do X;` / `exit X;` must read as a reference to an existing action, as the spec
      says, not as a declaration of a new one.** Today they declare a new action (the serializer writes a
      named one as `entry action x` to keep the two apart) and existing round-trip tests pin the
      declaration reading (`entry init; … transition first init …`). Done: the spec reading is
      implemented, the tests that pinned the declaration reading are replaced and every model that
      relied on it still gets the same verdict (check the corpus). [spec-par-ps2 2026-11-19; spec
      conformance mandatory]
      CLOSED 2026-11-20 (sm-entryref): a bare `entry|do|exit X;` is a reference to an existing action; with no such action it keeps the declaration reading and warns (`mapper/state-ref-unresolved`); the serializer writes a reference as `entry X;` and a declaration as `entry action x`. The 856 models of the corpus, fixtures and examples load with identical diagnostics (none uses the bare form). Open caveats are the new item "A referenced entry action's effect and a reference start succession".

- [x] **A comment just before a body silently drops the body.** `state x /* c */ { state a; }` (and
      `state <M1> parallel /* } */ { … }`) parse with `ok: true` and no diagnostic; the body is lost,
      identically on main before spec-par-ps2. A wrong statement: fence first. Done: the body is kept or
      a diagnostic names the loss, with the probes pinned. [spec-par-ps2 2026-11-19; wrong statement]
      CLOSED 2026-11-19 (fence-comment): a `/* … */` between a declaration's name and its `{` body
      (`state def M /* c */ { … }`, after a specialization, holding a `{` or `}`) is moved to the hidden
      channel, so the body is kept; free-standing comments and `doc`/`comment`/`rep`/`language` bodies are
      untouched. A comment before `;` was already a loud `parse/mismatched-token` and stays one (hiding it
      changed what the load-health check's texts parse to — caught by the full gate).

- [x] **The app's step-by-step Simulation Play path, for a machine whose entry start is not read.**
      `runStateMachine` now returns no run with `Not started: …`, but the UI's Play path builds its start
      through `initialConfig`, which for an unread start gives an empty configuration with no sentence
      (not probed in the app); and a composite state entered mid-run whose entry start is unread rests at
      the composite with no substate (the explorer refuses that machine). Done: both say why they did
      not start, with an E2E or unit pin. [spec-par-ps2 2026-11-19]
      CLOSED 2026-11-20 (sm-play): the Simulation panel shows a "Not started" line with the interpreter's sentence for an unread start and for a composite whose entry start is unread; runStateMachine refuses such a machine up front (pinned in semantics.play-start.test.ts).


## Interfaces — functional, logical and physical exchanges (if-compat follow-ups)

The order of work: logical compatibility (if-compat: port conformance §7.12.1, end conformance
KerML §7.4.6, flow ends §7.16, port typing §7.12.2, named connector ends §8.2.2.13), then the
allocation of exchanges across layers, then the views, then the formal methods. Arcadia's rules are
read from Voirin, *Conception architecturale des systèmes … Arcadia* (2018), §19.6–19.12, §20.2–20.5
and §21.4–21.11.

- [ ] **Map a keyword-less directed feature to a ReferenceUsage.** `in x : T;` with no keyword is a
      directed reference feature in SysML v2 (BNF `DefaultReferenceUsage`, §8.2.2.6): an action's
      parameter, an item of a port definition. The mapper makes it a `PortUsage` (map-to-model.ts,
      "Keyword-less feature"), so every rule and view reads an action's parameters as ports. if-param
      marks it `keywordless` so that port-typing skips it and a port definition's `out x : T;` counts as
      a directed feature; the metaclass itself is still the departure. Changing it reaches the flow
      ends, connectivity, the diagrams and the FMI import, which all read `PortUsage`. [if-param]
- [ ] **Map `perform x;` with a reference to the performed action.** `part ops { perform command; }`
      reaches the model as a `PerformActionUsage` named `command` with no relationship to the action
      (SysML v2 §7.17: the performed action is the usage's referenced feature, a ReferenceSubsetting).
      `exchange-allocation` resolves the name from the performer's scope until it is mapped; every
      other reader of `perform` sees a fresh action. [xalloc]
- [ ] **Exchange allocation — the views.** `exchange-allocation` judges the allocations a model
      writes (Arcadia §19.10–19.11, §20.4, §21.9); `exchange-unallocated` flags a flow between
      functions on two components that no connection carries, in a scope that allocates flows (§20.4);
      `function-port-allocation` judges `allocate fn.p to comp.q` (§20.3). The ICD
      table is `sysprose icd` (one row per connection). The Interconnection overlay is done
      (src/ui/icd-overlay.ts: connections coloured by ICD status, flows on hover). A function parameter with no port realisation at all is deliberately not judged (conn-lists, N2): neither SysML v2 nor Arcadia §20.3 as the rule reads it requires every parameter to be allocated, so a missing allocation is no finding; there is no refusal message to improve, the rule is silent unless `allocate fn.p to comp.q` is written.
      [xalloc]
- [ ] **Cross multiplicity on the other connector forms.** `connect [m] a to [n] b` is stored
      (`sourceCrossMult`/`targetCrossMult`), written back and checked (`connector-end-multiplicity`,
      §7.13.2). Now also read (conn-forms): the two-end list form `connect ([1] hub ::> x, [0..*] y ::> z)`, `end [m] part x
      references y` bodies of exactly two ends, and the spec's `end [0..2] part device` form (stored as `endCrossMult`).
      Done (conn-lists): a connection body of three or more `end … references` ends is read end by end (each cross
      multiplicity against its own part and the definition end; the unwritten-multiplicity case against the product of the
      other ends' upper bounds), and a definition end's inherited multiplicity is checked when the other end has several
      instances (`part a : W [5]` on `[0..2]` against `[2]` others). Done (conn-nary): the list form of three or more ends
      `connect ([m] a, b ::> x, c)` maps each end to an owned end feature (reference subsetting + `endCrossMult`, `naryList`
      kept for the writer), is checked end by end and round-trips; a bare statement `connect (a, b, c)` takes no multiplicity.
      Still open: pairwise port compatibility
      of an n-ary connection (§7.12.1 speaks of two ends; `connection-compatibility` abstains), and a post-name
      multiplicity on a usage body end (the end's own, not read). [if-compat]
[if-compat]
- [x] **Compare the undirected features and the nested ports of two connected ports.** Done: `portMismatches`
      descends into nested ports (depth 6, pair cycle guard, conjugation composed along the path) and checks
      undirected attribute/item features by name and conforming definition. Parts and references are compared too
      (bd-shapes); other undirected kinds are not. [if-compat]
- [x] **Store the direction of an implicit feature copy under a conjugated port as seen through
      it.** Settled by routing: every reader goes through `effectiveDirection`, which reverses a copy
      reached through a conjugated port (tested through `~P`); the stored attribute stays as written. [if-compat]
- [ ] **Bring `port-typing` models to the spec, then decide its severity.** v9 types 80 declared
      ports by item definitions (`in port taskingIn : TaskingOrder;`); the mbse-workflow authoring
      steps should write a port definition with directed items and type ports by it (and `~` on
      the other side). Kept a warning until then. [if-compat]
- [ ] **Allocate exchanges across layers, and check the allocations.** `allocate <flow> to
      <interface or connection>` and `allocate <interface> to <connection>`, with Arcadia's
      consistency rules: a flow between functions allocated to two different parts is carried by
      exactly one exchange between those parts (Voirin §20.4) or a path of them (§20.5) with
      conforming items (§21.9); each logical exchange is carried by a physical link or path
      between the nodes hosting its ends (§19.11–19.12); nothing carried twice or by nothing. v9
      writes the carrying only in doc comments ("the radio path that carries the peer link").
- [ ] **An interface table (ICD) and the Interconnection view.** Per pair of parts: the
      interface, its ends, the items each way, and the functional, logical and physical exchange
      it belongs to; a `sysprose interfaces` command; interface type, end names and `~` on the
      Interconnection view's edges, with mismatched edges marked by the rules above.
- [ ] **Formal methods per kind of exchange.** Logical: interface protocol compatibility as
      interface automata (de Alfaro & Henzinger 2001) over the two parts' state machines and the
      items their shared port carries (no unspecified reception, no deadlock), and assume–guarantee
      contracts on interface definitions (Benveniste et al. 2015); physical: capacity budgets per
      link through the SMT engine and link degradation fed to the fault tree; across: units and
      quantity kinds along flows and bindings.


- [ ] **Liveness (`existence`, `response`) is decided only over a whole graph with no completion
      livelock and no chase-budget cut.** Branch `sm-live` lifts docs/04 non-goal 4 for walks the
      engine calls exhaustive (a lasso search, no fairness, a live environment). Where the product
      graph holds a cycle of trigger-less transitions, or the interpreter's chase budget cuts a run
      the search would go on with, AND something is owed somewhere, the row stays inconclusive: the
      specification's infinite run and the interpreter's budget-ended run can part, and neither
      verdict is safe. A tighter rule (decide the pass when no budget-ended run can end owed)
      would decide more machines with a completion cycle. Also open: the `default` note reads
      guards and the property's atoms only, not an attribute an effect copies into one a guard
      reads; a `fail` over a lasso carries `modality: null` (no some-run/every-run sentence for a
      liveness refutation); the publishability register's rows A10, A11, W4 and W5 (liveness on an
      acyclic graph, fair-SCC) still describe the earlier plan and name no producer.
- Variability (var-cfg): per-configuration constraint and requirement evaluation reads only `point.attribute` with a stated number or Boolean on the chosen variant (or the point), plus an unqualified owner attribute; deeper chains, `assume` clauses, string/enum values, and per-instance values under a multiplicity stay UNDECIDED, never a pass. Not done: the `redundant-constraint` warning of V3. Requirement `satisfy` is read at the owner or at a complete valid configuration usage only.
- Variability (var-fence): the per-configuration connection check re-reads only a connector end that is a feature owned directly by the point (`eng.p`); an end nested deeper under a variant (`eng.sub.p`), flows, and requirement/constraint checks per configuration are still superset-only (audit rows 17, 19; steps V4, V6). `variation-variant-not-specializing` skips a variant with an unresolved type and a reference-form variant.
- BD2/BD4 follow-ups: promote multiplicity-conformance and binding-conformance from warning to error (user ruling: later); subset-type-conformance (BD3) and connector end multiplicity (BD5) are separate items.
- State machines (sm-par): DONE 2026-11-24 (sm-atoms): `check-behaviour` reads Boolean formulas mixing `state` leaves with expression leaves over the attributes (`state Armed and n > 3`), three-valued (an undecidable leaf is inconclusive, never false); a trigger / transition / node leaf is still refused (`verification/unknown-atom`); `recovery` withholds a formula that reads the store. The `reach` `events` line also reads parallel machines per distinct set of region leaves (info only). Open: no `--strict-events` switch (nothing consumes the reading as a finding); the parallel reading stops at 200 distinct region configurations and says so; it does not yet follow `(state a) (n+1)`-style unparenthesised mixes beyond the `and`/`or` split.
- bd-struct2 follow-ups: the six wave-2 rules (subset-type-conformance, disjoint-sum-exceeds, enum-value-not-member, value-multiplicity-mismatch, specialization-kind-incompatible, unresolved-value-chain) are warnings; promote to errors later (user ruling). Done (bd-shapes): BD3 reads the typing a redefined feature gives the subsetter, BD11 reads quoted and `::` names, BD8 reads arithmetic of literals as one scalar, BD9 reads usage-level subsetting/redefinition, port conformance compares undirected part and reference features. Not read: disjoint through `variation` variants (BD6: variants are alternatives of which one is chosen, §8.4.2.3, not value-disjoint subsets, so no sum reading is sound), a value that is a non-literal expression (BD8), a subsetter's type inherited only through another subsetting (the subsetter has the intersection of the types; no finding is sound).
- State machines (sm-spec): `check-behaviour --conformance` is opt-in, so a specialising machine is checked only when asked (a default row would move every specialiser's report and the v9 capture; the choice is the coordinator's); it compares active states and event labels, not stores or actions, and a specialisation that only changes an effect is not seen; a specialisation of a parallel, dwelling or cut machine is `inconclusive`. A time trigger (`accept after 5`) is offered as an event at any time: safety passes hold, `existence`/`response` are inconclusive on any machine with a dwell (also the factory-built `after(n)`, which could pass before), and the interpreter still refuses to run such a machine (no clock for the unit).

- Variability V6 (state machines per configuration): a machine a variant brings is walked once and reported per configuration; a variant that adds states/transitions outside a machine of its own, redefines one, or is a variant of a variation state is read on the superset only (info). Done (var-sm2): a variant's whole-machine redefinition and a variation state's chosen variant are walked per configuration (the latter on a copy with the other variants removed, at most 16 distinct choices). Done (var-sm3): a variant whose machine redefines the point's machine and adds states/transitions to it or redefines one of its transitions is walked per configuration on a copy with the additions merged (whole-machine and in-machine variants of one point mix; at most 16 groups). Done (var-sm4): a variant redefining a state of the owner's machine (members merged into it), redefinitions nested at any depth, and variants of different points redefining the same machine (overlaid per configuration; a clash on the same member is a conflict reading, nothing claimed). Done (var-sm5): an entry/do/exit action a variant brings to a state that has one of the kind replaces it when the variant's action redefines it (the successions leaving the replaced action go too), else it is a conflict reading for the configurations selecting the variant (the entryAction/doAction/exitAction features are [0..1]; the spec does not say how two read, so nothing is picked; do and exit do not change reachability but the clash is still reported); a transition naming a state the variant redefines is resolved to the redefined state; two variants redefining the same state merge when they claim no member in common (a state redefinition merges members and no longer claims the state); a variant redefining a machine the point's type only inherits was already read. Done (sm-inherit I1/I2): a machine usage that redefines an inherited machine usage (`exhibit state s :>> Eng::s` in `Eng2 :> Eng`) is read through the usage it redefines like a `state def` through its general (`inheritedRegion`, config.ts), so the walk sees inherited plus own members and a dead state in either part is decided on the effective machine; the variant overlay (`mergeOf`) reads the members the redefining machine inherits as its members, so a variant redefining one of them is walked per configuration. A variant whose machine redefines the point's machine now keeps the members it redefines (it was read as a whole replacement before; the V6 tests for it were rewritten). Open, no sound reading: a redefining usage with no step of its own is not a machine of the walk (`stateMachinesIn`), so a variant redefining it stays superset-only; a variant of a variation state redefining a member of the variation state (I3) stays superset-only: the walk puts the variation state's own members beside its variants as sibling substates, while the spec's variation state is not an active state and says nothing this view can take about what its non-variant members mean at runtime, so expanding them into the variant needs a decision on that reading first; a redefinition target outside the variant's own specialization chain is ill-formed and keeps its info. SM audit rows 13/15/16 re-probed on var-sm4: row 15 (cross-region and qualified atoms) and row 16 (parallel witness replay) now decide on p4; row 13 (time triggers) is walked as an over-approximation, residual: a cover/witness through a dwell is inconclusive (witness-not-replayed) by design, the interpreter has no clock.
- [x] **`part [1] x` drops its multiplicity.** Not SysML (§8.2.2.6.2 UsageDeclaration puts the name first); the parser took it and dropped the count. Now refused as `mapper/pre-name-multiplicity` (load error, checks abstain). [conn-forms review]
- [x] **A connection written only with end bodies gets "has 0 endpoint(s)".** Fixed: `connector-endpoints` counts owned ends that reference a part. `connection c { end part a references x; end part b references y; }` (no `connect`) is a legal binary connection (§8.2.2.13); the endpoint-count warning should read its end bodies. [conn-forms review]
- bd-vals (wave 7): BD8 reads values the evaluator decides (single-segment name of a feature of exact multiplicity or decided value, arithmetic over single values, sequences of decided parts, call of a calculation whose result states exactly [n]); chains, ranged or unstated counts, conditionals, arrows and ranges stay silent. B9: port conformance compares every usage kind a port may own (metadata and behaviour steps excluded). B6: disjoint-sum-exceeds no longer sums alternatives (variants of one variation point); a sum that needs variants is an info naming them. Open: B6 does not enumerate configurations (V4), so it cannot say the named selection is valid under the family constraints, nor report the exact configuration list. V3: the fence now also covers subsetting, reference subsetting and redefinition of a variation def/usage by a variation usage; a variation usage specializing a non-variation definition that itself specializes a variation definition is not read.

- bd-fam (wave 8): BD6 reads the family constraints through the V4 enumeration (configurationsSelecting): excluded selection silent, forced selection warning, partial info listing the configurations (up to 10); cut/unread family keeps the old info. Per configuration only the clique of the reported sum is judged (another clique present in a configuration that does not select the needed variants is not counted: sound, may under-report). V3 indirect case (variation usage specializing a plain definition that specializes a variation definition) is LEGAL per l.17210: the constraint reads only the usage's own ownedSpecialization targets, not transitive ones; test added, no fence.

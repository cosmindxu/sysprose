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
- [ ] **File a row, and say so in contracts, for a requirement whose only body is an assert.** A
      requirement def with an assert-only body (R1::R), and a requirement usage that writes its own
      assert (requirement r { subject s : P = x; assert constraint ca { s.L == 50.0 } }), file no
      requirement row on obligations or verify. obligations.ts adds the owner to withClause, and the
      no-formal-clause sweep skips it. contracts' emptyClauseLine (scripts/sysprose.ts:1322-1324)
      prints 'no formal clause: prose only, nothing to encode' for R1::R, R1::r and RU::r.
      noFormalClauseDetail already names the asserts. When this closes, re-word the USER-GUIDE
      status-column paragraph to match.
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
- [ ] **Read apart an undecided asserted-equation pair whose side is read in another element than
      the one that writes it.** contradictedApart (src/semantics/evaluate-model.ts) judges a side
      the unit-aware and scalar readings do not read (for example one over a bound name) only where
      the equation is read in the element that writes it (site.at === owner). Otherwise the pair
      stays info and `--strict` passes. A side over a value another pair leaves undecided also reads
      nothing, by design. No probe was written for the first case.
- [ ] **Give the own-sibling finding its own validation rule.** The Problems panel
      (`src/ui/panels/BottomPanel.tsx:221`) labels the row `redefinition-conformance` while the CLI
      prints `validation/redefinition-own-sibling`, and `excludeRuleIds:
      ['redefinition-conformance']` also drops it. Add the rule `redefinition-own-sibling` so ruleId
      and code match, and update the pinned rule counts in the same commit: docs/FEATURE-PARITY.md
      lines 80 and 134 (27 to 28), docs/UI-ROADMAP.md, docs/USER-GUIDE.md near :703,
      docs/architecture/05-data-flow.md and 06-sequence-diagrams.md, the `src/ui/store.ts` RECOMPUTE
      comment, the rule count in docs/AGENT-AUTHORING-CAMPAIGN.md, and the pins in
      validation.rules.test.ts and docs-counts. Optional, with it: raise the finding from warning to
      error, as `validation/duplicate-name` is (a warning exits 0 and mbse-workflow never routes it
      to repair; the corpus and v9 have 0 hits). [small-wording S1]
- [ ] **`bounds`: map `VerifyOptionError` to a usage refusal.** `bounds --measure <name that
      resolves to nothing>` prints `sysprose: internal error: VerifyOptionError ...` with four stack
      frames (exit 2, also on a clean model); `verify` maps it to a `UsageError`
      (`scripts/sysprose.ts`, near `reportVerify`'s mapping). Map it the same way and assert
      `not.toContain("internal error")` in the existing `--measure` test in
      `test/campaign/cli.sysprose.test.ts`. [small-wording S3, review]
- [ ] **Mark a degraded load in the non-judging subcommands that print verdict-like lines
      (optional).** `evidence-status` and its kind print such lines on a degraded load and get no
      `degraded` header; small-wording S3 covered only the judging report's `pass` lines.
      [small-wording S3]
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
- [ ] **Spell a chained subsetting target as written in the subsetting sentence.** For W's `part p2
      :> q.p1;`, the mapper records the Subsetting with target `Q::p1` and no chain (unlike a
      Satisfy's `sourceChain`). So the sentence says "subsets `p1` … through SC::Q's own `p1`, never
      as one of what `p1` is in SC::w::q", which is accurate but does not spell `q.p1`. Recording
      the chain on the Subsetting in the mapper (src/text) would let it. It would also let the
      instance test run in W with the path `q.p1` rather than in Q, which over-abstains where only
      an unrelated Q instance changes p1. [subsetting-pass S1 review]
- [ ] **Read a reference subsetting (`::>`) as a feature of what it subsets, or say the limit is the
      tool's in every surface; follow it in `spreadTaint` too.**
- [ ] **Name a bounds measure by the path asked.** `bounds --measure w.p2.load` names the measure
      `SA7::T0::load` (the definition's shared feature) in its sentences, not `w.p2.load`. 84fb971
      printed "max `SA7::T0::load` = 1 exactly" with exit 0; since subsetting-pass the run is
      correctly refused (exit 2), but the refusal sentence still names T0::load. [subsetting-pass
      branch review]
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
- [ ] **Hold the same timeout floor on the hooks of the differential table.** The budget-aware guard
      `ui-small` S5 added covers `test/campaign/verification.test.ts`. The two `beforeAll` hooks of
      `test/integration/verification.differential.test.ts` (600_000 and 1_800_000 ms) drive z3
      across the whole corpus, and the `withZ3` wrappers of that file and of `smt-z3.integration`
      refuse only a timeout under 40 s at declaration time; neither file has a counter-backed last
      case. A shared helper over `z3BudgetWatch()` would cover them. [ui-small S5, review]
- [ ] **Decide whether a collaboration room's copy counts as saved for the tab's close question
      (optional).** Since `ui-small` S1 the tab asks before closing over text or boxes not saved
      (`askBeforeLeaving`, `leaveUnsaved`). In a collaboration room a peer's edit makes the text
      read unsaved while the relay and y-indexeddb hold the room's copy, so every collaborator gets
      the question on close. It only errs toward asking. Decide whether the room's copy counts as
      saved. [ui-small S1, review]
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

- [ ] **Read another part's own rows past an assert read through a part valued with it (RF2).**
      Unchanged on dca0014. `P::c in other` and `top` read ?/?/?/?, and `Q::tie in q` reads ?/-/?/-.
      RF and RF3 read T/T/T/X, and their tie F. [O9 S2, default-stands S2]
- [ ] **Read a local equation where a binding gives its other side a value (PA, PA4, PA2, PA0).**
      Unchanged on dca0014. `P::qa in p2` reads ?/-/?/- (ref F). P's own `qa` reads T/-/?/- (the
      numeric surface abstains over the bound M). `top2` reads T/T/T/X and the `#bind` row F/-/F/-.
      [O9 S2, default-stands S2]
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
- [ ] **Read a group's row through a reference its usage writes, now the walk reads it per
      instance.** cown3's `W::sub::c in w::sub` abstains (`not-enumerated`: "this tool resolves what
      a reference stands for only where its value is written"), while since per-instance-rest S1 the
      walk reads W's sub's `ref part r : T0 = x`, reached as `w.sub.r`, in w's sub (cown3's k reads
      F). The coverage guard (`instanceReadsOtherwise`) could read the row in that instance instead.
      Sound, only weaker. [per-instance-rest S1]
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
- [ ] **Read bindings deeper than 32 usages (optional).** A context more than `MAX_BINDING_SEGMENTS`
      (32, `src/semantics/defining-equation.ts:2001`) usages below where its binding is written is
      not read, so the check and the literal engine abstain on `chain33` and `chainPkg33` (four
      rows; `DP33::negT` reads ?/?/T/T and `posF` ?/?/F/?). Sound, only weaker than it could be.
      Raise the cap or make the instance walk iterative. Done when those rows decide on all four
      surfaces. [review 2026-10-14 E10]
- [ ] **Read the equation an asserted conjunction gives on the numeric surface (optional).** Since
      text-order S1 a valueless feature that an asserted `L == 50.0 and L >= 0.0` constrains is no
      design freedom, so the numeric surface reads `t50 { p.L == 50.0 }` unknown, which SMT proves,
      and t1, t60 unknown, both F. The check and the literal engine abstain too. Reading the
      conjunction's equation part as L's definition would decide them. Pinned: order-s1n-and,
      -s1kn-and, -s2enc-and, -s2spec-and, -s2use-and and their -rev twins. [text-order S1]
- [ ] **Hold a feature an assert typed by an inequality-only constraint definition constrains.**
      `assert constraint ca : Cd { in x = L; }` with `Cd = x >= 0.0 and x <= 100.0` is neither
      collected as held (the usage carries no expression, so the numeric solve reads nothing from
      it) nor named by `typedAssertNames` (typedAssertHolding keeps only definitions that hold an
      equation). Two plain checks beside it abstain through the contested rule (t1, t2 unknown); a
      lone `t1 { p.L == 1.0 }` is still imposed as a design equation, as at 84fb971. Fix: read the
      typed assert's definition body, with the `in x = L` binding, in relationReads or in the
      assertHeld index. Probe: review-2026-10-14/wave3-probes/text-order/g1.sysml (G1). [text-order
      S1 review]
- [ ] **Judge a lone plain check beside a satisfied requirement's require/assume.** A requirement
      clause is a goal in this tool (USER-GUIDE: clauses are goals), not an assert, so a lone plain
      check beside it is still taken as a design equation (RQK: `t1` and the requirement's own
      constraint both read imposed, k satisfied). The multi-check order cases are closed by the
      contested rule; this one does not turn on the order. Decide whether a satisfied requirement's
      clause is a fact for the design-equation choice. Probe:
      review-2026-10-14/wave3-probes/text-order/reqk.sysml. [text-order S1 review]
- [ ] **Route the three direct readers of `evaluateFeatureValue` left through
      `readsContradictedDefinition`.** `objectiveValue` and the `optimize` `scoreOf` fallback in
      solver.ts and the String-valued stated read in refinement.ts (~l.2882) still return the first
      equation written for a contradicted feature. No probe reaches the optimize fallback (11 shapes
      return NaN or the stated value on 84fb971 and on text-order: the solve marks the objective
      unsettled first), so this is unverified, not known false. [text-order S2 review]
- [ ] **Solve the plain equations of a design component jointly over all roots (optional).** Since
      text-order the curved-root rule withholds `x * x == 4.0` beside `x == 2.0` in both orders
      where one root agrees (it read t/t before); a finer rule would solve the plain equations
      together over every root and keep the agreeing one. Sound as is, only weaker. [text-order S1
      review]
- [ ] **Do not hold a unit symbol as a feature (optional).** `writtenNames` (the regex over an
      unparsed asserted body) reads `[m]` in `M ** 2.0 == 4.0 [m]` as the feature `m`, so
      `constraint t1 { p.m == 3.0 }` goes from t to ?. Sound, only weaker. Run the regex over
      `lowerUnitLiterals(raw).text` or strip `[...]` and string literals first. Probe:
      review-2026-10-14/wave3-probes/text-order/U3.sysml. The quotient half of this entry is closed
      by numeric-curved: an equation one to one in the feature it fixes is single-root; what stays
      withheld is a curved plain constraint beside another left unused, listed in the rollup
      'Abstentions left in the numeric solver'. [text-order re-review; numeric-curved S2]
- [ ] **Stop the numeric surface reading an equation with no root, or a flat one, as solved
      (pre-existing, wrong answer).** Identical at b635385. (1) A one-to-one equation set to a value
      it never reaches reads t at a far point: `2.0 ^ x == 0.0` beside `x <= 0.0` reads a t, b T at
      x = -30.74, and `6.0 / (x + 1.0) == 0.0` beside `x >= 0.0` reads ?/? but `solveFeasible`
      answers feasible, decided, with the witness x about 3e21
      (review-2026-10-14/wave3-probes/numeric-curved/lens1-r5/N1..N6). (2) An exponential set equal
      to its asymptote reads t at |f| < 1e-9 (`5.0 == 1.5 ^ (5.0 * x - 10.0) + 3.0 + 2.0`). (3) `1.0
      / x == 0.000001` beside `x >= 999999.0` reads k F and `solveFeasible` infeasible
      (review-2026-10-14/wave3-probes/numeric-curved/p12, R1 and R2): the absolute 1e-9 accept of a
      flat function in the Newton path. (4) A flat equation beside a wrong pin reads both t when the
      pin is within the gate. (5) `x / y == 3.0` with `y == 0.0` and `x == 0.0` gives
      `solveFeasible` a witness near 1e-16 though 0/0 satisfies nothing
      (review-2026-10-14/wave3-probes/numeric-curved/zero-over-zero-p1.sysml). Fix: withhold or
      reject a root-find that ends beyond the equation's tolerance only because the function tends
      to its asymptote (`witnessGate` does so for `x / (1.0 + x * x) == 0.6 + y`), and refuse a
      witness at which a divisor is within tolerance of zero. [numeric-curved]
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
- [ ] **Read Q's assert at an instance whose binding joins the asserted path to defaults that differ
      (RB5E).** `part q1 : Q { attribute K default = 9.0; attribute J default = 8.0; bind p.x = K;
      bind p.x = J; }` under Q's `assert constraint tie { p.x == 50.0 }` gives q1's p.x no value to
      read (`defaults-differ`), so `Q::tie` is not read in q1 and every reading of the pair abstains
      (`unread-binding`, `standingUnderInstance`); the model may contradict itself unreported.
      Pinned as `h5-rb5-differ`
      (review-2026-10-14/wave3-probes/contradictory-models/h5-rb5-differ.sysml). Done when the
      assert is filed in q1 with the cause, or the two defaults are read. [contradictory-models S1]
- [ ] **Read `assert not constraint c { ... }` as the negation.** `part def P { attribute load :
      Real = 50.0; assert not constraint c { load > 10.0 } }` reads T on all four surfaces, but `c`
      holds at load = 50, so the negated assert is violated; the instance row of P::c in a
      binding-carried instance reads T the same way. A silent pass of a model that contradicts
      itself, identical at the base. Probes
      review-2026-10-14/wave3-probes/contradictory-models/h1.sysml, h2.sysml. Done when the negated
      assert is checked, or the form is refused with its own finding. [contradictory-models S1
      review]
- [ ] **File a violated row for the contradiction SMT reports in UB6 and W4o, so the literal engine
      can seed from it.** Since contradictory-models S3 the literal engine marks the rows over the
      values a binding the check reports violated joins inconclusive. Two rows still decide on the
      literal engine beside SMT X because the check files no violated row for their contradiction:
      unit-blind-assert UB6::cT (q's asserted p.load >= 1000.0 reads the 50 kg a binding carries
      into an untyped load as 50 in SI) and w4-plain W4o::c5 (p4's own load = 7.0 against the
      package's bind P::load = L: no binding finding reports a package head's pair; the USER-GUIDE
      says so). Done when the check files the row and the literal engine marks both inconclusive, or
      the rows are ruled permanent. [contradictory-models S3]
- [ ] **Seed the literal engine from the check's other violated binding rows (optional).** Only bind
      rows (conflict "bind", a connector) seed the literal engine's contradictions. The check's
      binding rows (a redefinition's value against the binding it overrides: r14) and clash rows
      (two bindings a context inherits: mapper-mi1, mi1d, mi3) do not. Every row of those four
      probes abstains on the literal engine today, so no false verdict is known. Seed them if a
      model decides a row beside one. [contradictory-models S3]
- [ ] **Read two asserted equations on the two ends of a binding that reaches an end through a part
      only where they meet (the scope decision).** fence-readings S2 made the two readings abstain
      together on every surface, so the entry's first done-when holds. The residual is the scope:
      taint only the instance where the two equations meet (q's p and q's M), so that a `part p2 :
      P` beside it, and every other P, keep reading `L == 50.0`; today P's L is undecided in every P
      once such a binding exists (pinned as `u50` in bind-through-part). Probes:
      review-2026-10-14/wave3-probes/contradictory-models/c6-nested-swap.sysml,
      review-2026-10-14/wave3-probes/fence-readings/s2/bq.sysml. Done when only the meeting instance
      abstains. [contradictory-models S3; fence-readings S2]
- [ ] **Stop `loadModelText` running out of memory on a usage that subsets a library feature, beside
      an instance and a constraint (pre-existing crash).** `package C { part def W { part p3 subsets
      Parts::parts; } part w : W; constraint k { 1.0 <= 5.0 } }`
      (review-2026-10-14/wave3-probes/fence-readings/oom/c.sysml; the first form, `part p3 :>
      Parts::parts` with `constraint k1 { w.p1.load <= 5.0 }`, is
      review-2026-10-14/wave3-probes/fence-readings/p/u1.sysml) dies with 'FATAL ERROR: Ineffective
      mark-compacts near heap limit' under `NODE_OPTIONS=--max-old-space-size=700 timeout 90 npx tsx
      scripts/sysml-check.ts --strict c.sysml`; at the default heap it runs about 2.6 minutes (about
      3.3 GB) and prints nothing. The definition alone, or with an instance and no constraint,
      loads, and so does `item i :> p1` or `attribute a :> p1.load` in place of the library
      subsetting. Identical at 5d9e806. Cause not isolated: an unbounded walk over the library
      subsetting once an instance and a constraint exist. Fix: bound the walk, or treat an
      unresolved library subsetting as an abstention, and stop resolving a dotted chain through the
      library feature's members. Done when the probe loads and checks in seconds. [fence-readings
      review]
- [ ] **Resolve a package-level chain end the same in either text order (loader).** The fence of
      fence-readings S1 only withdraws the false verdict past the 32-usage cap: cap1r and cap2r read
      ?/?/T/T and ?/?/F/?, as the forward text does. The root cause stays: bind.ts
      `mostSpecificRedefining` / `endCopyProto` and the mapper resolve a package `bind Y =
      top.a.….a.load` before T1's `bind a.load = L` has its end copy, so the chain end redefines
      only T0::load when the bind is written first. Resolve package-level chain ends after every
      definition's own end copies exist. Done when the loader's redefinedClosure of that end is the
      same in both orders (a unit test on the closure) and the reversed corpus models pin the same
      cells for the same reason. Probes: review-2026-10-14/wave3-probes/text-order/cap1r.sysml,
      cap2r.sysml, cap1f.sysml, cap2f.sysml. Pins: cap1rev, cap2, cap2rev. [fence-readings S1]
- [ ] **Give the specialisers of a usage-owned group one canonical order (optional).** The
      group-order fence of fence-readings S1 is a stable sort by usage-ancestor count in
      `contextsUncached`; `specialisersOf` itself and the context-key dedup have no canonical order,
      so two contexts with equal nesting and the same reading key still file the first by text
      order. Low: both rows read the same today. Probe:
      review-2026-10-14/wave3-probes/text-order/65a411ed2025-e5-renamed.rev.sysml. Pins:
      e5-renamed-rev, e5-renamed-silent, e5-renamed. [fence-readings S1]
- [ ] **Bound the subsetting walk on dense layered diamonds and on a full DAG (cost;
      pre-existing).** Layered graphs where every usage subsets all eight of the layer above: 7x7
      12.9 s CPU, 8x8 52.6 s (5d9e806 49.8 s), 10x5 34 s, 8x10 (80 usages, 576 subsetting edges) not
      finished after 7 CPU-minutes; a full DAG `part u_i :> u_1, ..., u_(i-1) [1]`: n=22 about 11 s,
      n=26 99-105 s (174-192 s with a redefinition), n=30 over 4 minutes. Chains of 150-300, zigzags
      and cycles stay at 5-8 s. The fixpoint of fence-readings is cheap; the super-linear step is in
      the per-instance walk or `contextsOf`. Unchanged by fence-readings. Probes:
      review-2026-10-14/wave3-probes/fence-readings/cost/grid{4x5,5x6,6x6,7x7,8x8,10x5,8x10}.sysml
      and review-2026-10-14/wave3-probes/fence-readings/repro/R14-dense-subsetting-cost.sysml (n=22;
      generate larger n). Done when 8x8 and n=26 finish in seconds. [fence-readings final review]
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
      capped end is past the cap and abstains on the check and literal engine, including bindings
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
- [ ] **Name an unnamed redefinition by its effective name in the numeric surface sentences.**
      `nameList` (solver.ts) prints the raw element id for `attribute :>> L;` ("fixes 12ac9de4-…",
      "did not converge: f4bded69-… is where it stopped"); use `effectiveNameOf` or
      `effectiveQualifiedName`. Wording only. [redefinition-target S1]
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
      page ?/?/?/?, file F and T; review-2026-10-14/wave3-probes/fence-editor/d.test.ts); (d) where
      the mapper lands a definition's copy by text order, page and file may differ; (e) a peer's
      edit in a room is not settled by the receiver (the sender's settle arrives as edits; not
      exercised with two live clients). Done when each reads as the reopened file does.
      [fence-editor]
- [ ] **Make two features of one owner under one name, and a hand-retargeted redefinition,
      page-equals-file.** fence-editor fixed the order-dependent simple name (seed 5439) and the
      path through an unnamed part (seed 5001). What stays: (1) two features of ONE owner under one
      name (the saved file finds the first); (2) a Redefinition edge retargeted by hand (SDK,
      `updateElement`) to a feature its owner does not inherit, to a feature of another kind, or to
      one that makes a cycle leaves page and file redefinitions apart. A sound fence needs a stable
      identity between page and reparsed file (compare by place), more than 40 lines. Probes:
      `RC_FIRST=<seed> RC_SEQ=1 RC_STEPS=5` with
      review-2026-10-14/wave3-probes/fence-editor/zzprop.test.ts copied to test/unit/zzprop.test.ts,
      on seeds 165, 317, 400, 1327, 1406, 7220, 7430, 7436. [fence-editor S2]
- [ ] **Withhold the rows of a parted binding so the page does not read what the reopened file calls
      contradictory (page FF, file ??; wrong answer).** After a retype or rename that parts an
      implicit end copy (stale), the page still reads a literal row that the file, opened again,
      calls contradictory (`bind Zb = Z1` joins two values): page FF, file ??. Soak seeds 333, 1115
      and 3034 (RV_STEPS=5/5/6; review-2026-10-14/wave3-probes/fence-editor/b.body.ts run through
      b.test.ts). A parted binding is set aside rather than made unreadable. Fix: have
      `markStaleBindings` withhold the rows of both ends. Done when the three seeds read ?? on the
      page. [fence-editor review]
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
- [ ] **Stop a deleted Redefinition cycle member leaving a self-redefinition (low).** A cycle a -> b
      -> a: deleting a leaves `b :>> b` (the saved text `attribute b :>> b;` reads Unresolved
      reference). Fix: in `Model.survivingTargets` treat a found target equal to the redefining
      feature as no survivor. A cycle is already an invalid model. Probe:
      review-2026-10-14/wave3-probes/redefinition-target/probe-selfred.test.ts. [redefinition-target
      re-review]
- [ ] **Take the dangling-edge scan out of `Model.remove` (core cost).** `Model.remove` scans every
      element for dangling edges, so a settle that drops many redefinitions one remove at a time
      costs O(N) each: deleting a base attribute that 300 redefinitions end in costs about 0.9 s on
      a 12.7k-element model. Find the dangling edges through the edge indexes, keeping the removal
      and event order. Also: a 300-deep chain with two named siblings per definition parses at 1.16
      to 1.30x of 84fb971 (`chainsib300`; skip `joinsTwo`'s reach walk when no sibling redefines
      anything), and a retype on a usage of 1500 `:>>` settles in 343 to 453 ms.
      [redefinition-target S2, S3]
- [ ] **Widen the random edit generator of the store property test (optional).**
      `store.reducers.test.ts` draws `bind` in definitions and usages since the re-review fixes.
      Still to add: nested `part :>> p { attribute :>> load; }`, standalone `redefinition`
      statements, a user retarget of a redefinition (Properties, `updateElement` on the edge), the
      SDK edits, and the duplicate-name stop; a verdict oracle (a copy bound to a valueless Zb plus
      `u.Zb == v` constraints, definite check and numeric contradictions between page and reopened
      file) and a count of the sequences that fell back to the binding-free model; the hand-text
      oracle is thin (1 comparison in the 300 x 4 gate window); compare the four-surface verdicts in
      a subset of the sequences. [redefinition-target S2, re-review]
## Per-instance soundness — review 2026-10-14

From the soundness review of F3–F8 and 3e3b0ff (Sysprose 5943654 against 7277a97). The branch
`per-instance-sound` (merged by `4ac2fff`) closed A-C1, A-C2, A-C3, A-H1 (the direct reads), A-H3
and A-H4, PI-1, and the correctness half of A-H2: instances now read where they stand, abstain where
they cannot, and the four-surface table pins A1–A9, A4, CAP1, X-shapes and the units shapes at their
true values. What follows is what that branch and the review of it left open; entries tagged
`[O2 …]` come from its steps and reviews.

- [ ] **Make the per-instance check cheaper after an edit, and bring tree10 back under 2x.**
      cold-check S1 finds the connectors that join a component by connector end (358e0b7). Paired on
      f3004c6 (median, min-max, load <=6): big-bind-1200 cold 1.95 s (1.77-7.95, n=9) to 1.77 s
      (1.63-1.84, n=7); big-bind-600 cold 0.82 to 0.78 s, within the spread; perf9b and tree10 cold
      unchanged. The cold target of 1 s is NOT met and the entry is not closed on the warm figure,
      because tree10 misses its warm target. big-bind-1200 cold, three-way on this machine: 4ac2fff
      (O2 merge) 1.48 s (1.37-1.58, n=7), f3004c6 1.95 s, cold-check S1 1.77 s, output identical;
      about 0.5 s of the cold figure came in after O2, cause not isolated. tree10 warm, four-way,
      alternating, n=8: 7277a97 9 ms (9-10), 4ac2fff 16 (15-17), f3004c6 35 (34-37), cold-check S1
      36 (33-38): about 4x 7277a97 against the <= 2x target (tree10 output changed after O2). The
      absolute warm targets hold: big-bind-1200 0.55 s (target 1 s), big-bind-600 0.27 s (700 ms),
      perf9b 0.15 s (300 ms). Where the cold time goes: the per-instance reading itself
      (groupInstanceRows, instanceGroups and bindingConflicts re-asking each row's names, about 1.7
      s of 1,201 rows) and abstainedRead (about 0.15 to 0.2 s of big-bind-1200 cold). abstainedRead
      cannot be restricted to models that assert something: with that restriction the test "a bound
      read that throws is the read's abstention, not a depth limit (valueBoundInInstance, P17)" (T1
      has no assert) turns from unknown to satisfied, a read failure dropped (probe:
      cold-check-scratch/review-s1/mut-assert; vitest fails at
      semantics.evaluate-model.test.ts:6521). A specialiser's lexical two-values, a bound source's
      past-cap / defaults-differ and an internal throw are further possible no-assert abstentions,
      not shown. Done when a model-level test proves that no abstention can arise or the per-row
      answers are shared with collectReads, big-bind-1200 is under 1 s cold and tree10 is within 2x
      7277a97 warm, or each is restated with a measured reason. [cold-check S1, O2 S5, review
      2026-10-14 A-H2]
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
- [ ] **Say why a default stood on the rows `standingDefaultSentence` still does not reach.** The
      check's instance row and a default reached through a binding now say it (`carriedDefaultOf`,
      save-and-wording S3). Still bare: the rows `groupInstanceRows` (F7 groups) and
      `readThroughSpecialisers` (specialiser measures) print, the numeric surface's violated rows
      (H2E: `NUM tie (ctx) violated | p.load == L`), and the carried-default sentence (RB3), which
      has no redefinition spelling, only "write the analysis as the value of q::L". Optional, low.
      [save-and-wording S3]
- [ ] **Print the two defaults' values in the abstention for two defaults a binding joins (GA6).**
      `bind p.load = L` joins P's `load default = 7.0` and Q's `L default = 5.0`. The sentence now
      says the binding joins defaults that differ or are not constants (`p.load`, `L`), on the
      numeric surface as on the check, but names the member paths, not the values (7.0, 5.0).
      Printing them is a change to `abstentionSentence` in `defining-equation.ts`; the numeric
      surface repeats the check's sentence, so one change fixes both. Optional, low.
      [save-and-wording S3]
- [ ] **Read a `default` that an assert in an enclosing scope names, instead of abstaining (A.2.4
      lexical rule).** `assertAbove` / `enclosingAssertOn` still make a constraint over a `default`
      abstain when an assert in an enclosing scope names that default. Since decision 14 was amended
      no assertion changes a default, so this abstention is now only conservative: read the default,
      and check the assert against it as for a value written with `=`. Pin each row against its `=`
      twin. [default-stands S1]
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
      defines it and the binding gives it a second value. Read a binding from a valueless end to a
      valued feature as giving that end the value, as `=` does. Then H2f decides as H2 on all four
      surfaces, and its `=` twin as H2's; pin all four with I14. [default-stands S1, G2]
- [ ] **Carry an asserted inequality over a `default` a binding makes give way with no value, on the
      SMT lane.** Since default-stands S1, `gateRelation` refuses every asserted relation over such
      a default (`givenWayUnvalued`), inequalities included. perf9b (per-instance/rv) goes from 2 to
      768 refused obligations: 766 `N0::lo` (`x >= 0.0`) axioms are `unread-definition`. GI's gT
      `q.p.load >= -1.0` loses its SMT proof (?/?/?/T at 414ba14, ?/?/?/? now; probe
      default-stands-scratch/brv/p/gi.sysml). It was kept on purpose: `L >= 5.0 and L <= 5.0` fixes
      the symbol as `L == 5.0` does. A fix carries only an asserted relation that cannot fix the
      symbol (no pair of bounds that meet), and names those moves. [default-stands review]
- [ ] **Read a binding component whose valued members agree.** In X6, W's `bind q.p.load = M` (M =
      3.0) sits beside Q's asserted `L == 3.0`. `X6::P::c in X6::W::q::p` and `in X6::w::q::p` read
      ?/?/?/X ('joins two values the model states (q.p.load, q.L, M)') although the two values
      agree. The fix: compare the valued members exactly in `boundSourceIn` before abstaining, as
      `definedAgainstBoundIn` does, then re-pin stand-x6 and drop the 'known gap' clause from
      USER-GUIDE ('even where the two values agree, as here'). Probe:
      default-stands-scratch/fin/np/x6.sysml. [default-stands review]
- [ ] **Encode a definition's binding in each usage's instance.** In x6n (X6 without Q's assert),
      the SMT engine proves `X6N::P::c in X6N::W::q::p` but finds a counterexample for `in
      X6N::w::q::p`. The witness gate then demotes it to 'witness not confirmed', because the
      numeric surface reads 3. It is safe, but a reading is lost. Identical at 414ba14. Probe:
      default-stands-scratch/branch-review/p4/x6n.sysml. [default-stands review]
- [ ] **File a definition's context row under one name whatever the declaration order.** A relation
      of P read in a specialisation P2 :> P whose one usage is p is filed `P::ca in P2` when P2 is
      written first, and `P::ca in p` when p is, with the same verdict. This shows in H3, H6 and the
      24 S3 spec cells of the soft-hard analysis with their members reversed (the M-generator prints
      them RENAMED, 27 pairs). File the row under P2 wherever it is declared. [default-stands S2]
- [ ] **Show `:=` (an initial value, not a binding) and the value's unit in `elements` and the grid;
      the workflow readers then read them (optional).** Today `init := 4.0` prints `= 4`, `softInit
      default := 3.0` prints `default 3`, and `= 7 [kg]` prints `= 7`. These predate small-defaults
      S1. Sonnet, budget. [small-defaults S1]
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
- [ ] **Resolve a metadata body redefinition (optional, low).** In `@T about X { ref :>> approved =
      true; }`, `@T { ref :>> x }` and the keyword form the redefined name is looked up with no
      typing for the annotation (the MetadataUsage has only the string `attrs.type`, no
      FeatureTyping), so the standard's own `ref :>> approved` example files
      `ref/unresolved-specialization` warnings. Resolving it against the metadata definition T (add
      T to `redefinitionGenerals` in `src/semantics/bind.ts`) makes the cell lose its textual
      `attrs.redefines`, which `kindCells` in `src/semantics/verify.ts` (and `holdsMethodKind` in
      the mapper) read for `attribute :>> kind = test` in a VerificationMethod carrier (pinned by
      test/campaign/verification.test.ts:2410): do the resolution only together with making
      `kindCells` (and any other reader of a cell's `attrs.redefines` text) follow the Redefinition
      relationship, and gate on the verdict differential. [parse-and-show S1]
- [ ] **Parse a short name and the `@` spelling in the named metadata annotation (optional, low).**
      `metadata <sn> N : T about A;` and `@N : T about A;` (BNF MetadataUsage with Identification,
      kebnf:1666-1676) still fail with `parse/no-viable-alt`; `metadata N : T about A;`, `public
      metadata T about A;` and `public @T about A;` parse since parse-and-show S1. [parse-and-show
      S1]
- [ ] **Ask FailureMode by its qualified name when it ships.** `machineFailureModes`
      (src/semantics/fault-tree.ts) counts a model's own FailureMode through `hasKeyword(..., {
      anyPackage: true })` because the definition is not in SysproseVerification yet. When the
      vocabulary commit ships it, add FAILURE_MODE_QUALIFIED_NAME, ask for it and drop the option;
      the campaign test then declares the definition in SysproseVerification and its "model's own
      definition is counted" sentence changes. [small-defaults S3]
- [ ] **Report an ambiguous keyword as ambiguous (optional).** When two imported definitions answer
      to a keyword (a bare `#exceptional` with both VendorHints and SysproseVerification imported)
      it resolves to the first import in `resolveFullName`, so `contracts --keywords` and the
      fault-tree label depend on import order; the rule fails safe (no label). Report it as
      ambiguous. Also `statement-kind.ts` reads `#prose` and `#prompt` from the spelling alone, so a
      foreign `<prose>` is still read as a statement kind: needs its own decision. [small-defaults
      S3]
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
      another read.** S1 folds a violated group row into its lead only when its one read comes from
      a plain number literal that a definition's usage states, and putting that read back to the
      relation's own value mends the relation (`breakingRead`, asked once per distinct set of reads,
      for the first five distinct sets of a group). A row whose value is derived (`L = 2.0 * K`, PB
      in the PI-2 test), a default, one the line does not mend, one with a unit or `sides`, or a
      sixth distinct reading in a group keeps its own finding, anchored at the part. Several reads
      fold too when `breakingRead` names the shared read. Fix: anchor those at the shared member the
      value comes from, or at the instance's own line that changes it. Probes: R2/R3 in e4-deep-spec
      for the folded shape. [reporting-residuals S1, review]
- [ ] **Name the breaking value in a unit-bearing violated instance.** `breakingRead` leaves
      `breaks` unset (the finding names the first bound read, as before) when any read carries a
      unit, an SI figure or sides, or when no single read, put back to the relation's own context
      value, makes the relation hold (both needed, or the relation is already violated there). It is
      decided on the scalar scope only, and for the first 5 violated rows of a group or 20 contexts.
- [ ] **Name and anchor a value the instance redefines, which no read carries.** a value the
      instance's own element redefines is not among the reads, so a finding never names or anchors
      at it. In redef-breaks2 (q2 has `attribute :>> L = 2.0;` plus `part :>> p { attribute :>>
      extra = 20.0; }` under `load + extra <= 10.0`) the finding points at `:>> L = 2.0` and names
      `load = 2`, though putting load back to 1 still misses (1 + 20 > 10) and `extra = 20.0` breaks
      it. Pinned in the PI-2 S1 test (G5) as the current, honest behaviour.
- [ ] **Say when a Save applies typed text over a field's change in the two cases that stay
      silent.** The in-browser Save, the offline Save and Export say so since `ui-small` S3
      (`fieldOverTyped`, `over-changes`). (1) A Save to an attached Google Drive file with unsaved
      changes (`runSave` then `driveSave`, `payloadNow`) applies the text over a change
      `typedTextFirst` kept back and the strip says nothing: it needs a Drive-strip message that
      survives the save's own notice. (2) The guard's Save (`saveBeforeReplacing`, the Save and
      continue of New, Open, Import, Switch branch, Merge or Join room) does the same and says
      nothing, because the guarded command replaces the model next: it needs a sentence that does
      not promise one Undo (it takes two). [ui-small S3]
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
      of a room.** After an edit the page lists the user's declarations in the order the text gives
      them (`Model.adoptSerialOrder`, `src/core/model.ts`), and each owner's children come in one
      order on every peer of a room (`src/collab/model-doc.ts`). But a typing, specialisation,
      redefinition or implicit feature keeps its place among the others: one made in the app
      (Properties' Type field, a line drawn with the palette) is listed after every one the model
      had; one whose element a drag puts elsewhere in the text, or that a project, model JSON or
      branch stored in another order, stays where it was. A terminal over the saved text binds them
      in the order their declarations come. In a room, a peer that joins lists them in the order the
      room's document lists its keys, and a peer present after a reset (Apply, Import, Undo, Redo)
      keeps them where it had them. So a check that goes by them (`where-used` over a definition)
      can list its rows in another order than a terminal, and than another peer. Probes: (a)
      `package X { part def D { attribute a = 1; constraint c { a <= 0 } } part u1; part u2 : D; }`,
      type `u1` as `D` in Properties: the page gives u2, u1 and a terminal u1, u2; (b) `package X {
      part def D {...} package A { part u1 : D; } package B { part u2 : D; } }`, drag A out and back
      in: the page gives [u1, u2] and a terminal [u2, u1], and the same after the stored project is
      reopened (the same at 87e8c0f). Fix: list them in the order the parser's binding pass makes
      them (`:>`-family first, then `:` typings, then connector chains, each in the order of their
      declarations), measured to leave every load where it is, or order such rows by the text; carry
      that order in the room's document too. Done when the probes' page, terminal and peer rows come
      in one order. [review 2026-10-14 D-1, collab-order]
- [ ] **Make a reset in a collaboration room cost what it changes (optional, measure first).** An
      Undo, Redo, Apply or Import in a room clears the room's document and writes every element
      again, library included. On v9 with its library, the editing peer's reseed plus one other
      peer's reconcile take about 28 to 30 s in node on a quiet machine (80 to 100 s at load 30 to
      35), at 87e8c0f and at `collab-order` alike. The whole document goes as one message, which
      runs into the relay's message cap (64 MiB since collab-ui S2). Fix: write only what the reset changed (a diff of the snapshot
      against the document), with the library kept out. Pre-existing. [collab-order S2]
- [ ] **Keep the standard library out of a collaboration room's document.** Every peer's first
      message and every reset carries the whole library (about 10.8 MB on the drone-swarm v9 model),
      and the relay takes at most 64 MiB in one message (`scripts/collab-server.ts` MAX_PAYLOAD,
      USER-GUIDE section 9), so a model several times the size of v9 still cannot be shared. Fix:
      leave the library elements out of the room's document (every peer loads it) or split the
      message. Done when the first message of a v9 room carries under 1 MB of library. [collab-ui
      S2]
- [ ] **Make peers converge after concurrent removals in a collaboration room (pre-existing).**
      Three peers that move and remove elements at random points and then exchange their updates end
      with different trees in about 7 sequences of 100 (33 of 500 on collab-ui, 42 of 500 at
      227d10c); a cycle is not involved, a removal that reaches one peer before or after a move into
      the removed owner is. Moves, creates, resets and renames alone converge (0 of 2000). Probe:
      `ONLY=fuzz.probe.ts N=500 OPS=mr vitest run --config vitest.scratch.config.ts` in
      `scratchpad/collab-ui-scratch` (copy in
      `~/Work/sysprose-soundness-artifacts/review-2026-10-14/wave3-probes/collab-ui/`). Wrong-answer
      class: peers show different models. [collab-ui review]
- [ ] **Save an end that no name reaches.** Save writes a binding whose end is an unnamed
      redefinition by its effective name (`bind p.load = L;`, `p.a.load`), but where no name reaches
      the end it still writes the `«eClass»` placeholder, which a terminal cannot read back
      (`unexpected character` on `«` and `»`) and the binding end is lost: two unnamed members of
      one owner that answer to the same effective name, an unnamed redefinition beside a named
      member of the same name, an unnamed redefinition as the head segment of the path, a redefined
      feature with no name. Loud, not a false verdict. Probe: `package T { part def P { attribute
      load : ScalarValues::Real default = 1.0; } part p : P { attribute :>> load = 50.0; attribute
      load : ScalarValues::Real; } attribute w : ScalarValues::Real; bind w = p.load; }` is saved as
      `bind w = T::p::«AttributeUsage»;`. Refuse or skip the binding with a stated reason, or give
      the redefinition a declared name on Save (`refTo` and `effectiveSegment` in
      `src/text/serializer.ts`). Also optional: now that an unnamed `:>> x` resolves to the most
      specific inherited feature, `refTo` could verify the effective path with `resolveFullName`
      instead of the one-answering-member rule. [save-and-wording S1]
- [ ] **Contain the own-row `standingDefaultSentence` call like the instance-row one (optional,
      low).** `readInContexts` wraps the sentence in a try/catch that yields no sentence (the
      sentence is wording and must not cost the row); the call on a constraint's own row (`standing
      = standingDefaultSentence(model, el)` in `evaluate-model.ts`) is not wrapped. No reachable
      throw was found. [save-and-wording review]

## Behaviour checks and the palette's checks lane — review 2026-10-14

From the reviews of the behaviour lane (reach and check-behaviour in the palette) and of the ux
merge. The branch `behaviour-sound` (merged by `e0d8040`) closed the completion budget, the nested
`state def`, the method text and the completion livelock (C1, H2, C3, H1, M3, M1, U1); the entries
tagged `[O1 …]` are what its steps and reviews left open.

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
- [ ] **Decide a count past the budget where a trigger-less dwell follows (optional).** Since
      `behaviour-rest` S1 a search on a machine that names no trigger ends each run where the chase
      budget stops it (`budgetEndsRun`, `src/semantics/mc/patterns.ts`; docs/06 §8.12). The
      exception is a walkable trigger-less transition that carries a numeric `attrs.after` (set only
      through the API): a clock advance fires it where the chase stopped and the chase goes on (on
      `a ⇄ b` with `a -> b` such a dwell, one advance of 5 takes the run into `b` 65 times), so the
      search still refuses the step past the budget (`completion`, inconclusive). Done when such a
      search carries the chase position and offers the clock advance where a chase stops, or the
      refusal is documented as permanent. [behaviour-rest S1]
- [ ] **Say in the bounds sentence that `maxDepth` counts events (optional).** Since
      `behaviour-rest` S1 the depth bound counts the events a run takes from the opening, not its
      steps (`DEFAULT_MAX_DEPTH`, docs/06 §8.12), while the `depth` figure beside it still counts
      steps, so `reach` can print `depth 260` beside `maxDepth 200` (four stacked completion
      cycles). The guide and the code say so; the printed bounds sentence does not. Rewording it
      (for example `maxDepth 200 events`) re-records every qualification string in every report and
      pin, so it is its own step, with the corpus diff named. [behaviour-rest S1]
- [ ] **Name every region's refusal on a parallel machine (optional).** `StateRunResult.refused`
      names the first region's refusal only. Listing the others needs `refusedStepSentence`
      reworded, because "the machine's other regions run on" is false once every region has refused;
      it also needs `SimRefusal.stopsRun` (true only for a non-parallel machine today) to read all
      the regions, so Play stops when every region has stopped. Done when `refused` lists every
      region's refusal, with a sentence and `stopsRun` that read all the regions, or the parallel
      interpreter interleaves its regions. No verdict stands on it, since the walk refuses every
      parallel machine. [behaviour-rest S1; behaviour-small S2]
- [ ] **Let the Simulate trace of a composite run on its own step out into its holding machine
      (optional, low).** Since behaviour-small S1 the Simulate button's trace of a composite run on
      its own stops at a step that leaves the composite for a state of the machine that holds it (it
      used to enter that state on top of the composite); the explorer and the holding machine's own
      run take the same step as an ordinary step (the `exits` row of the semantic profile does not
      say it, `docs/06` §8.14 does). No corpus, example or v9 model has such a step. Decide whether
      the Simulate trace should follow the holding machine there. [behaviour-small S1]
- [ ] **Livelock-pass cost.** `reach` is about 20% slower than at `5943654` on a 9,641-configuration
      machine (about 240 to 290 ms) from the livelock pass (`docs/06` §8.8); measure paired on an
      idle machine and decide whether to accept it. [reporting-residuals S3]

## Solver and speed — review 2026-10-14

From the review of the speed2 branch (66704a8, 79f7350, merged by 607e783): no verdict, code, exit
code or value changed, and the claimed gains reproduce. These three are what it left.

- [ ] **Skip the READINGS key until a second read is possible (optional, low).** On v9
      `obligationsOf` makes 78 `readRelation` reads through the cache (`src/semantics/contracts.ts`
      near `:678`, `:710-741`) with 0 hits: the JSON key and the Map get and set cost about 0.6 ms
      (about 1.5%) per pass and gain nothing there. A cheaper key, or no key until a second read can
      happen, would recover it; it is below what paired process timing resolves, so cold-check S2
      did not attempt it. [cold-check S2, C-F5]

## Docs, tutorials and what waits on others — review 2026-10-14

User guide and tutorials that are wrong, and what waits on something outside the code.

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

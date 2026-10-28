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

- [ ] **Decide the z3 version string in verdict lines.** z3 5.3.1 reports its full version as
      `5.3.1.0 ac9156f97cb44e56472e1c841f7a2beb1e976b24 z3-5.3.1` (5.2.0 said `Z3 5.1.0.0`), so
      every SMT verdict line, evidence record and `decided by z3 ...` text now carries the 40-hex
      commit (`src/semantics/engines/smt.ts` near :1617, `src/api/property.ts` near :1339). Decide
      whether to shorten it (for example `z3 5.3.1.0`) or keep the commit as provenance, re-pin any
      golden that quotes it, and update README lines 243 and 247 (`decided by z3 Z3 5.1.0.0, seed
      0`). Done when decided and the text is stable. [z3-bump]
      DECIDED 2026-10-24 (D2): sentences say `decided by z3 5.3.1, seed 0`; the full string with the
      commit stays in the evidence record's metadata; README's two quotes follow. Wave 3 run 5.
- [ ] **Exercise a z3 death in a real browser.** The USER-GUIDE says a z3 that dies mid-session ends
      that Run with a `checks/internal-error` row and the next Run starts a fresh z3, 'not yet
      exercised in a real browser'; the bridge's `onAbort` rejection of a worker-thread trap is
      covered only by the fake, and the page-side hang is unverified. Add an E2E (or a manual probe
      recorded in UI-ROADMAP) that kills the module in the page and runs again. The old N6 S4 clause
      that a hang keeps the async mutex held until reload is gone (the lock is per module now). Also
      make the soak repeatable from the repository: the header of `test/campaign/z3-soak.soak.ts`
      carries the invocation. [z3-bump, review]
- [ ] **Decide whether a binding the check reports violated contradicts, for the literal engine, the
      values it joins.** Q4 covers asserts only, so the literal engine still decides these rows
      beside SMT X. Re-derived after the seed fix, these files have no violated assert, only a
      violated binding row (the contradiction of decision 1): AM and AMD ctlF and ctlT; M2a ctlA,
      negT and posF; M7Y::Q::c (d1plain-own); EB4::P::c and EB4::P::c in Q::p; EB5::P::c, in Q::p
      and in R::q::p; FanS2::QB::cq; SG2F::u1; SW4B::c3; SRU::kL1; RBB::P::c and RBB::top2;
      RBL4::t2; T4E c5, cF and cT in both spellings; X3F::P::c; X5::P::c and X5::P::c in Q::p;
      X6::P::c and X6::P::c in Q::p. Two more rows have no violated row on the check at all, yet SMT
      reports X: UB6::cT (unit-blind assert) and W4o::c5 (w4-plain). BND and T4C/T4D are no longer
      on this list. Seeding from violated bind axiom rows would be a few lines in contradictionsOf.
      DECIDED 2026-10-24 (D1): yes, as an assertion since Q4: the literal engine marks the
      obligations over the values a violated binding joins inconclusive (exit 2) and names the
      binding; `check` keeps deciding beside it. Wave 3 run 4 S3.
- [ ] **File the assert of a bound feature's type for an instance whose binding sits in an enclosing
      instance (GI, next to RB5).** Model: part s2 : S { bind q.g = K; } with G's assert constraint
      ca { g <= 10.0 } and K = 50. The worklist files ca only for S::q and s1::q, so the SMT engine
      proves GI::t2 and GI::tk (T/X/T/T, cv-gi), while the check reports ca violated in s2::q. The
      literal engine fails closed there since S1. Done when SMT reads cv-gi's rows
      inconsistent-axioms and the literal engine places the contradiction instead of reaching every
      relation.
- [ ] **Narrow the literal engine's contradiction reach to the instance the violated assert reads.**
      Since S1, table rows with a decided ref abstain on the literal engine as they do on SMT
      (T/X/T/X). An assert in one instance reads the symbol shared by every instance it does not
      tell apart: refute-r1 P::c and q2's p, R1D, Sh7, H1C, H1F2, R1U, Q4B, PIN2/3/5, PA, PA4,
      PL2/5T/6/7, HQ, HQ2, SFW, N4T, N5, H5B, T4D::c5, SP2::kq and R27F::Q::c. A sum also ties a
      sibling (CVSIB::tb). Narrowing needs the SMT instance split (plan section 1.5). Done when
      those rows read their ref on the literal engine and no contradicted row reads decided.
- [ ] **File a row, and say so in contracts, for a requirement whose only body is an assert.** A
      requirement def with an assert-only body (R1::R), and a requirement usage that writes its own
      assert (requirement r { subject s : P = x; assert constraint ca { s.L == 50.0 } }), file no
      requirement row on obligations or verify. obligations.ts adds the owner to withClause, and the
      no-formal-clause sweep skips it. contracts' emptyClauseLine (scripts/sysprose.ts:1322-1324)
      prints 'no formal clause: prose only, nothing to encode' for R1::R, R1::r and RU::r.
      noFormalClauseDetail already names the asserts. When this closes, re-word the USER-GUIDE
      status-column paragraph to match.
- [ ] **Read two asserted equations on the two ends of one binding as one feature's two values.**
      Since contradicted-value S2, two asserted equations that give one feature with no value two
      values leave every reading of it undecided (`contradictedDefinitions` in
      defining-equation.ts), but two on the two ends of one binding are not read as one: in `part
      def P { attribute L; attribute K; bind L = K; assert constraint cl { L == 50.0 } assert
      constraint ck { K == 60.0 } }` with `part p : P`, the check reports the `#bind` row violated,
      yet `t50 { p.L == 50.0 }` reads T/T/?/X and `k50 { p.K == 50.0 }` F/F/?/X, the literal engine
      exits 1, and the two swap with the values (the SMT engine's axioms are inconsistent; the same
      at f1f5ca5). Fix: where a binding joins two features of one element, compare the equations of
      both as one feature's (`joinedTo`), or have a bind conflict decided from two asserted
      equations seed `contradictedTaint` with both ends; pin it with its twin in the four-surface
      table. [contradicted-value S2 review, probe rv-s2-correct/v/bnd2-ab.sysml]
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
- [ ] **Read a definition's assert in an instance whose binding gives the value it reads.** Probe
      contradicted-value-scratch/fix/p/vc.sysml: `part def P { attribute load : Real; assert
      constraint a2 { load <= 10.0 } }`, `part def Q { attribute L : Real = 50.0; part p : P; bind
      p.load = L; }`, `part q : Q`, `constraint k { q.L >= 0.0 }`. check files only an info for
      P::a2 ('evaluated per specialisation: p::load'), so nothing reads a2 violated in q's p. The
      literal engine says k holds-at-values ('unconditional', exit 0) and SMT proves it (exit 0), on
      a model that contradicts itself (50 > 10). The four surfaces read T/T/T/T, the same as at
      f1f5ca5.
- [ ] **Read apart an undecided asserted-equation pair whose side is read in another element than
      the one that writes it.** contradictedApart (src/semantics/evaluate-model.ts) judges a side
      the unit-aware and scalar readings do not read (for example one over a bound name) only where
      the equation is read in the element that writes it (site.at === owner). Otherwise the pair
      stays info and `--strict` passes. A side over a value another pair leaves undecided also reads
      nothing, by design. No probe was written for the first case.
- [ ] **Say the pair's sentence on the numeric surface.** On the numeric surface a pair's own
      equation rows keep 'the solve did not converge: L is where it stopped ...' rather than the
      pair's sentence (`numericRows` in solver.ts); the guide was reworded instead. Optional, low.
      [contradicted-value review]
- [ ] **Abstain over a feature an own-sibling redefinition values (Opus, moves verdicts).**
      `validation/redefinition-own-sibling` reports `part def Battery { attribute mass default =
      1.2; attribute :>> mass = 0.8; }`, but the surfaces still read it. (a) default + value: check,
      literal and numeric read b.mass = 0.8 (`heavy` refuted, `light` held) while SMT answers
      inconsistent-axioms; (b) value + value: every surface already abstains, with a check conflict
      row; (c) a valueless redefinition over a default: all four read the default; (d) a valueless
      declared feature with a valued redefinition: all four read the redefinition's value. In (c)
      and (d) the four agree, so no cross-check can catch it. Make check, literal and numeric
      abstain with their own sentence wherever an own-sibling redefinition values the feature read,
      and pin every shape in `verification.differential.test.ts`. Identical at 2218b84.
      [small-wording S1, review]
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
- [ ] **Read the subsetted feature where an instance redefines a usage that subsets it.** RV1: `part
      def W { part p1 : T0[1]; part p2 :> p1 [1]; constraint c { p1.load <= 5.0 } }` with `part w :
      W { part :>> p2 { attribute :>> load = 50.0; } }`. w's p2 is its only p1, so `w.p1.load <=
      5.0` is false, but it reads T/T/T/T; W::c reads T, the reversed `k1R` reads F/F/F/F, and
      strict reports a false violation. This was already so at 84fb971 (probe
      subsetting-pass-scratch/wbr/rv1.sysml). Taint p1 where an instance reads a usage that subsets
      it otherwise and p1's upper multiplicity is 1, or abstain. This needs a multiplicity ruling,
      which also bears on corpus model e1-subset (`part q9 :> q { attribute :>> L = 50.0; }`).
      [subsetting-pass branch review]
- [ ] **Resolve a satisfier path written in a nested package through the owning namespaces.** NQ1
      (`satisfy RF by NQ1::w.p1;`) and NQ2 (`satisfy RF by w.p1;`), each in `package Inner`, file no
      row. The mapper resolves the source to `W::p1` with chain `w.p1`. RF's own row (T) stands for
      the satisfy, and `verify --engine smt` exits 0 although w's p1.load is 50 (true F). The same
      satisfy written in the top package (NQ3) files an F row. This is unrelated to subsetting and
      was already so at 84fb971 (probes in subsetting-pass-scratch/wbr/nq1.sysml, nq2.sysml,
      nq3.sysml). Resolve the path, or file the row and abstain. [subsetting-pass branch review]
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
- [ ] **Give the focus somewhere safe when the Requirements table's reference picker closes.** Since
      `ui-small` S2 `Escape` in the Explorer's rename, the context menu's and a Requirements cell
      leaves the focus on Save (`cancelAndFocusSave`, `src/ui/commands.ts`). `Escape` in the picker
      (`req-ref-picker`) and `Enter` on a candidate close it with the focus dropped to the page, and
      a pick selects the requirement row, so the next `Backspace` deletes the requirement just
      linked. Route the keydown paths (not the blur, which cancels) through `cancelAndFocusSave` /
      `commitAndFocusSave`. Check the Regroup view's bundle-label and port-name boxes
      (`RegroupView.tsx`, the Enter and Escape handlers that call `blur()`), which from code reading
      also leave the focus on the page. Done when `Escape` and `Enter` in the picker leave a
      following `Backspace` harmless, with a test. [ui-small S2, review]
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
Since per-instance-rest (merged by `ca4992c`), `KNOWN_FALSE` is empty (it held 20 rows at 3c54ae0),
so the plan's "Done means" item is met, and no allowlist entry is tagged `no step yet`. Since
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
- [ ] **Say the tool limit exactly for a shadowed body.** The shadowed-parameter tail of an
      `unread-definition` refusal is neutral since reporting-residuals S2, but the refusal head for
      a shadowed body still reads "the relation reads a value this tool does not read", which is
      imprecise for a valueless parameter. Wording in `src/semantics/engines/literal.ts`, not a
      reading change. [reporting-residuals review]
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
- [ ] **Read a binding past the 32-usage cap whatever the order of the text.** The corpus models
      cap1-per-binding and cap2-per-binding-valueless (gate-tools corpus a75dc2b9f417,
      20544bc6c8f2), written with the members of the package and of every part definition in the
      reverse order, read `yT { Y >= 40.0 }` F/F/F/X, `negT` F/F/F/X and `yF { Y <= 5.0 }` T/T/T/X,
      where X's 50 reaches Y and top's load through T1's binding at the chain's end (written in
      order: ?/?/T/T, ?/?/T/T, ?/?/F/?). A false verdict on the check, the literal engine and the
      numeric surface that turns on the text order, in the past-cap reading in defining-equation.ts;
      the same at 84fb971. Pin both with their reversed twins in the four-surface table. Probes:
      review-2026-10-14/wave3-probes/text-order/cap1r.sysml and cap2r.sysml (forward: cap1f, cap2f).
      [text-order S1]
- [ ] **File a usage-owned group's context rows whatever the declaration order.** e5-renamed (corpus
      65a411ed2025) with its members reversed files no `E5::P::c in E5::Q::p` and no `E5::P::c in
      E5::q::p` row on any surface (T/T/T/T written in order); the same at 84fb971. Probe:
      review-2026-10-14/wave3-probes/text-order/65a411ed2025-e5-renamed.rev.sysml. [text-order S1
      measurement]
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
- [ ] **Tie K to a contradicted L through a bare-name equation `K == L` (`contradictedTaint`,
      defining-equation.ts).** `attribute L; attribute measureK; L == 50.0 and L == 60.0` in either
      order, `assert constraint x { K == L }`, a `part p : P` and `constraint kk { p.K >= 55.0 }`:
      `contradictedTaint` does not tie K to the contradicted L, so K's FMI start and its measure
      value are 50 or 60 by the order of the two equations, and `kk` reads F/X/F/X in one order and
      T/X/T/X in the other on the check and the numeric surface. A local tied by `T == L` keeps the
      same order-dependent start; `K == L + 0.0`, `K == 2.0 * L` and `bind K = L` are withheld
      correctly. Not caused by text-order; add its twin to the four-surface table with the fix and
      drop the USER-GUIDE limit sentence ('`K == L`, a bare name on each side, is not read as tying
      K') when it closes. Probes: review-2026-10-14/wave3-probes/text-order/tie-ab.sysml,
      tie-ba.sysml. [text-order S2]
- [ ] **Route the three direct readers of `evaluateFeatureValue` left through
      `readsContradictedDefinition`.** `objectiveValue` and the `optimize` `scoreOf` fallback in
      solver.ts and the String-valued stated read in refinement.ts (~l.2882) still return the first
      equation written for a contradicted feature. No probe reaches the optimize fallback (11 shapes
      return NaN or the stated value on 84fb971 and on text-order: the solve marks the objective
      unsettled first), so this is unverified, not known false. [text-order S2 review]
- [ ] **Do not seed a valueless parameter's FMI start into a co-simulation as a fixed 0
      (optional).** `seedInputs` in src/interop/fmi/cosim.ts still seeds a parameter or input whose
      start is the type default as a fixed override into `solve`, so outputs are computed from an
      invented 0; text-order S2 stopped it only for a withheld contradicted start
      (`FmiVariable.startWithheld`). The same flag could mark a valueless parameter. [text-order S2]
- [ ] **Solve the plain equations of a design component jointly over all roots (optional).** Since
      text-order the curved-root rule withholds `x * x == 4.0` beside `x == 2.0` in both orders
      where one root agrees (it read t/t before); a finer rule would solve the plain equations
      together over every root and keep the agreeing one. Sound as is, only weaker. [text-order S1
      review]
- [ ] **Withhold the value of a curved component that has no unused equation.** The numeric surface
      decides F on a consistent model when a curved system leaves no equation unused: `c0 { p.x *
      p.x == 4.0 }`, `c1 { p.y == p.x + 1.0 }`, `c2 { p.y <= 0.0 }` read c0 t, c1 t, c2 F in every
      order, yet x = -2, y = -1 satisfies all three; likewise a product system (`p.x * p.y == 4.0`,
      `p.x == p.y`, `p.x <= 0.0`: c2 F, though (-2, -2) satisfies them) and an asserted curved
      equation (`assert { x * x == 4.0 }` beside plain `p.x == -2.0`: b F). Not order-dependent and
      identical at 84fb971; designReadings returns early on `!took || unused.length === 0` before
      the rival rule applies. Apply the rival rule there too (a component with a curved equation,
      plain or model, beside another plain equation, or an inequality judged over it, reads no
      value), count a coupled product system as curved, and correct the USER-GUIDE sentence 'A
      component with a curved plain equation beside another plain equation reads no value at all'
      until it does. Opus class (a false verdict on a consistent model). Probes:
      review-2026-10-14/wave3-probes/text-order/C11out_0.sysml, V8out_0.sysml, AA1_0.sysml.
      [text-order re-review]
- [ ] **Take the second root a model equation gives into the curved-root rule.** `designReadings`
      looks for a curved equation among the PLAIN ones only. A stated `attribute s = x * x` or an
      asserted `s == x * x` beside plain `c0 { p.s == 4.0 }`, `c1 { p.x == -2.0 }` reads c0, c1 ?/?
      ('only plain constraints that disagree (c0 and c1)', false: they agree at x = -2) when c0 is
      written first and t/t when c1 is, where 84fb971 read t/t in both orders. Likewise a curved
      plain equation whose component reaches a disagreeing pair through a product (`c0 { p.x == -2.0
      }`, `c1 { p.z == p.x * p.y }`, `c2 { p.z * p.z == p.y }`, `c3 { p.x == 5.0 }`: c2 ?/?/t/? when
      c0 precedes c3, ? in the other order). Compute `curved` over every equation of the component
      that reads a produced value, model equations included, and union every plain equation's
      variables into the component once any of them is produced; pin W, Y and M5 in every order.
      Sound (an abstention in one order, imposed in the other), but the guide's 'no design equation
      turns on the order of the text' holds only bar these. Probes:
      review-2026-10-14/wave3-probes/text-order/W_0.sysml, W_1, Y_0, Y_1, M5out_0.sysml,
      M5out_3.sysml, F7x130_0.sysml, F7x130_1.sysml. [text-order re-review]
- [ ] **Do not withhold a quotient by a value another plain equation fixes, and do not hold a unit
      symbol as a feature (optional).** `isCurved` treats `x / y == 3.0` beside `y == 2.0` and `x ==
      6.0` (and the density form `m / v == d`) as curved, withholding rows 271df65 read t; and
      `writtenNames` (the regex over an unparsed asserted body) reads `[m]` in `M ** 2.0 == 4.0 [m]`
      as the feature `m`, so `constraint t1 { p.m == 3.0 }` goes from t to ?. Both sound, only
      weaker. Treat `const / affine-in-u` as single-root, and run the regex over
      `lowerUnitLiterals(raw).text` or strip `[...]` and string literals first. Probes:
      review-2026-10-14/wave3-probes/text-order/G5out_0.sysml, U3.sysml. [text-order re-review]
- [ ] **Make `solveFeasible` treat a rival curved pair as a freedom in both orders (optional).** `c0
      { p.x * p.x == 4.0 }` above `c1 { p.x == -2.0 }` gives {decided: false}, the other way round
      {decided: true, feasible: true} (the model is feasible); the campaign doc says such a value is
      searched as a freedom by `solveFeasible`. Not false. Probes:
      review-2026-10-14/wave3-probes/text-order/C1out_0.sysml, C1out_1.sysml. [text-order re-review]

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
- [ ] **Say why on an instance row, and through a binding, when a violated assert leaves a default
      standing.** `standingDefaultSentence` is printed only on `check`'s message for a violated
      `assert` that is an equation naming the `default`'s feature alone on one side, in the assert's
      own element, where no binding makes that default give way. Two cases print no reason. An
      instance row: h2e-ancestor-assert-eq's `q::L = 50 misses Q::tie (p.load == L)` never says that
      P::load's `default = 1.0` stood. And a default the assert reaches only through a binding
      (RB3's tie). The instance row needs the instance's own reading: naming Q::L's `default = 1.0`
      where q writes `L = 50.0` would mislead. [default-stands S1]
- [ ] **Read an assert in the binding's type at an instance whose binding joins the asserted path to
      a value (RB5).** No surface reads Q's `assert constraint tie { p.x == 50.0 }` for an instance
      whose own binding joins p.x to a value: `part q1 : Q { bind p.x = K; }`, q1's `part :>> p {
      bind x = K; }`, the package's `bind q1.p.x = K`, or a definition's around q1 (RB5F). With K's
      `default = 9.0`, every reading of the pair now abstains (`standingUnderInstance` in
      defining-equation.ts, `unread-binding`): verify exits 2 and check prints 4 infos. With `K =
      9.0` the model, which contradicts itself, passes silently on every surface (check OK, literal
      and SMT exit 0). File `Q::tie in q1` as violated on the check and the numeric surface, and as
      an axiom for SMT so its axioms read inconsistent. Then read K's 9 again under the default and
      drop the abstention. [default-stands S1] Q's own `tie` row abstains too: it reads ?/-/?/- in
      RB5, RB5C, RB5D and RB5F (ref T), because p.x has no value in Q and the assert defines it (the
      last case of the closed 'Taint the instance ...' entry).
- [ ] **Word the abstention for two defaults a binding joins in one instance (GA6).** `bind p.load =
      L` joins P's `load default = 7.0` and Q's `L default = 5.0`. Reading neither is correct (two
      defaults that differ), but the row of Q's asserted `L == 5.0` abstains with 'L has no value
      anywhere and nothing specialises it', which names neither the binding nor the two defaults.
      Say instead that the binding joins two defaults that differ (7.0, 5.0), so neither is read.
      [default-stands S1]
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
- [ ] **SMT decides beside a violated top-level binding (G340, ref null).** In G340, `bind
      r.q.p.load = r.q.L` reads F/-/F/-: load stands at 1.0, and L = 50 from Q's assert at K = 25.
      Yet SMT decides (negT F, posF T) rather than reporting inconsistent axioms, as it does for
      h2e's enclosing assert. The `=` twin reads the same on 414ba14, so this is the existing `=`
      behaviour, not a change made here. Check whether the binding should be an SMT axiom.
      [default-stands S1] Two more cases: (1) the `=` twin of h5-m3t (`L = 1.0`): the check reports
      `P2::a2 in Q3::p` violated, yet SMT proves `k`, and the literal engine and SMT both exit 0;
      with `default`, SMT exits 2. (Since contradicted-value S1 the literal engine exits 2 on case
      (1); only the SMT T remains.) (2) The M-generator's `g_assert_*_encl_d{1,2}_pd1_*` and
      `g_assert_*_pkg_d2_*` (12 files) read F/F/F/F with SMT `refuted` on a self-contradictory
      model; the other 68 placements read X.
- [ ] **Carry no asserted value through a package head's slot into a `default` that gave way to
      another default (E1).** `bind P::load = M` (M `default = 9.0`) beside `part p4 : P { attribute
      :>> load default = 7.0; }`: the two defaults differ, so M gives way (decision 10). Add
      `attribute L; assert constraint fix { L == 5.0 }; bind p2.load = L;` and `constraint c3T {
      p3.load <= 6.0 }`. c3T then reads ?/?/?/T: the check, literal and numeric surfaces abstain,
      but SMT proves it from L's 5, carried through p2's slot into M and on to p3's load. M has no
      value, and no assertion should give it one. `definedAgainstHead` skips a head whose component
      holds only defaults that give way. Make that head's slot abstain, or refuse the axiom on the
      verification lane, as `gateRelation` does for a default named directly. It holds on the
      implementer's tree too, so it is not a regression. Probe:
      default-stands-scratch/fin/np/edge1.sysml. [default-stands S1 review]
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
- [ ] **Parse the rest of the `about` forms.** `metadata T about A, B { ... }` parses since
      small-defaults S2. Still failing: the named and typed form from SysML 7.27.2, `metadata
      securityDesignAnnotation : SecurityRelated about SecurityRequirements, SecurityDesign;`
      (sysml.txt:10180-10181; parse/no-viable-alt), and the visibility-prefixed `public metadata T
      about A;` and `public @T about A;` (BNF MemberPrefix with AnnotatingElement, kebnf:74-78,
      130-136, 180-183). [small-defaults S2]
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
      true; }` and the keyword form the redefined name is looked up with no typing for the
      annotation, so the standard's own `ref :>> approved` example files
      `ref/unresolved-specialization` warnings. Resolve `:>> name` against the metadata definition T
      the annotation names (old behaviour of the `@` form). [small-defaults S2]
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
- [ ] **Keep the project's name across an undo of an apply.** `undo` and `redo` (`src/ui/store.ts`)
      re-derive `projectName` from the first package (`deriveProjectName`). After a package rename,
      or after an Undo of a Save's apply, the next Save writes another project and can overwrite a
      saved project of that name. Probe: New('NewModel'), rename the package to Drone, Save, then
      typed text, a field change, Save, Undo, Save leaves the open project holding the text-only
      version and writes the other project. The S3 note now invites the Undo. Optional one-line fix:
      keep `projectName` across undo and redo of an apply. [ui-small S3, review]
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
- [ ] **Resolve two peers' moves that hold two elements in each other.** In a collaboration room,
      two peers who at the same moment each move one of two elements into the other (`X` into `Y` on
      one peer, `Y` into `X` on the other) leave the room's document holding `X` under `Y` and `Y`
      under `X`. Each peer refuses the move that would close the cycle (`Model.reparent`,
      `reconcileModelFromDoc` in `src/collab/model-doc.ts`): one holds `X` under `Y` with `Y` at the
      top level, the other `Y` under `X` with `X` at the top level. A page that joins as the app
      joins (`connectCollab`: its own model bound to a new document, then the room synced in) holds
      the pair as one of the two does. A model bound to a document that already holds the room (the
      API's `bindModelToDoc`, through `serializeFromDoc`) holds each under the other, reachable from
      no root: neither shows in its tree, and its text drops both and all they hold. Moving either
      element again does not end it: the peer that refused keeps its own reading, because its own
      edit is never taken back in from the document. An Apply, Import, Undo or Redo by any peer
      brings every peer to that peer's tree (USER-GUIDE section 9 states it). Fix: break such a
      cycle the same way on every peer and on a join, for instance by putting the member with the
      lowest id at the top level. Done when both peers, a page that joins and a model bound to the
      room's document hold the pair alike, both in the tree. [collab-order S2]
- [ ] **Keep the collaboration relay up on a model with the full library.**
      `scripts/collab-server.ts` caps a message at 10 MiB and sets no `error` handler on a socket,
      so a larger message kills the relay process (`RangeError: Max payload size exceeded`, an
      unhandled `error` event) and drops every room on it. A peer's first message carries the whole
      document, standard library included. For the drone-swarm v9 model that is 10,769,168 bytes at
      87e8c0f and 10,845,744 bytes with the places `collab-order` adds; a probe on a scratch port
      confirmed that a v9 room kills the relay. The app's sample model with the library is 9,799,148
      bytes, about 686 KB under the cap, which is why the children of the library's owners get no
      place until one of them moves. Fix: on a socket error close only the offending connection, and
      keep the standard library out of the room's document (every peer loads it), or raise the cap,
      or split the message. Done when a room over v9 syncs between two pages (E2E). USER-GUIDE
      section 9 states the limit. Pre-existing. [collab-order S2]
- [ ] **Make a reset in a collaboration room cost what it changes (optional, measure first).** An
      Undo, Redo, Apply or Import in a room clears the room's document and writes every element
      again, library included. On v9 with its library, the editing peer's reseed plus one other
      peer's reconcile take about 28 to 30 s in node on a quiet machine (80 to 100 s at load 30 to
      35), at 87e8c0f and at `collab-order` alike. The whole document goes as one message, which
      runs into the relay cap above. Fix: write only what the reset changed (a diff of the snapshot
      against the document), with the library kept out. Pre-existing. [collab-order S2]
- [ ] **Save a binding to an unnamed redefinition under a name a terminal can read.** Save writes a
      binding whose end is an anonymous redefinition by a placeholder name: for the verdict-corpus
      model `07f3a4f30d1d-d4-usage-redef-default-bound`, `part p : P { attribute :>> load default =
      30.0; } bind p.load = L;` is saved as `bind D4::Q::p::«AttributeUsage» = L;`, which a terminal
      reads back as `Connector ... has 1 endpoint(s)`. In `r14-bind` and `r14-bind-dflt` the
      constraint over it then abstains for another reason ("w has no value anywhere" instead of
      "cannot be derived: ... contradicts ..."), and `k4a-contra-units-same-number` shows the same
      pattern. The page and a terminal over the original text agree, and every verdict seen
      abstains, so no false verdict was found. Pre-existing at 87e8c0f. [collab-order S1]

## Behaviour checks and the palette's checks lane — review 2026-10-14

From the reviews of the behaviour lane (reach and check-behaviour in the palette) and of the ux
merge. The branch `behaviour-sound` (merged by `e0d8040`) closed the completion budget, the nested
`state def`, the method text and the completion livelock (C1, H2, C3, H1, M3, M1, U1); the entries
tagged `[O1 …]` are what its steps and reviews left open.

- [ ] **Walk a step written over inherited states.** Since `e0d8040` a control edge written outside
      a machine's region that touches one of its states refuses the machine (`machine-boundary`,
      `docs/06` §8.6). A specialisation that adds a step over inherited states (`package W2 { state
      def Base { state a; state b; state c; transition ab first a accept go then b; } state def
      Derived :> Base { transition bc first b accept more then c; } }`), or a typed usage that does,
      therefore refuses both `Base` and `Derived`, where `5943654` walked `Base` alone. Fail-closed
      by design. Fix: a reading that walks the two together. [O1 S3]
- [ ] **Compare the stack in the witness replay, not only the leaf (optional).** `replayWitness`
      (`src/semantics/mc/patterns.ts`) compares each step's resting leaf. The interpreter does not
      expose its stack: `activeStates` is the final leaves, and `visited` records what a step
      enters, never what it exits, so a stack rebuilt from them cannot catch a state the walk keeps
      and the interpreter left. Fix: `runHierRegion` records each fire's active stack (an optional
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
- [ ] **Say in the bounds sentence that `maxDepth` counts events (optional).** Since
      `behaviour-rest` S1 the depth bound counts the events a run takes from the opening, not its
      steps (`DEFAULT_MAX_DEPTH`, docs/06 §8.12), while the `depth` figure beside it still counts
      steps, so `reach` can print `depth 260` beside `maxDepth 200` (four stacked completion
      cycles). The guide and the code say so; the printed bounds sentence does not. Rewording it
      (for example `maxDepth 200 events`) re-records every qualification string in every report and
      pin, so it is its own step, with the corpus diff named. [behaviour-rest S1]
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

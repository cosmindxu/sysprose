# Model checking, read against this tool — what transposes and what does not

**What this document is.** An assessment of an eleven-volume model-checking and formal-verification
library against the capability this repository actually ships, written to answer one question: which
ideas in that literature can become features here, and which famous ones cannot. It proposes; it
records no implemented behaviour. Everything in [`docs/04-formal-verification-plan.md`](04-formal-verification-plan.md)
is the plan that shipped; this is the candidate list for whatever comes after it.

**How to read it.** Every citation carries the **book** page and the **PDF** page, because the two
differ in most of these scans. Every claim about this tool cites a file that was read or a command
that was run against the tree. §5 lists what was *not* verified on the page, and names the two
conclusions that are inferences rather than statements any of these books makes — those are excluded
from the reasoning and must stay labelled wherever they are reused.

**Where the corpus is.** The eleven PDFs are a local library outside this repository and are not
redistributable; nothing here reproduces more than a short attributed quotation from any of them.

**Status.** Nothing below is scheduled. The two top candidates share one engine change; the rest are
independent. Each carries a stated cost and, deliberately, *the measurement that would kill it* — the
observation on a real model that would make the feature not worth building.

---

**Scope.** `/home/xcos/downloaded_books/Formal Verification and Model Checking` — eleven PDFs. Tables of contents extracted for all eleven (`mutool show … outline` where a bookmark tree exists; `pdftotext` where it does not), then depth only where a chapter touched something Sysprose could do. Every book citation below carries the **book** page with the **PDF** page beside it, and I opened every page I cite. Claims about Sysprose cite a file I read or a command I ran against `/home/xcos/sysprose`. Nothing in the repository was edited.

---

## 1. Verdict

**Most of this set does not transpose, and the reason is structural rather than a matter of effort.** The library is overwhelmingly about three things Sysprose does not have: state spaces of 10⁶ to 10²⁰ (the entire symbolic/BDD/SAT/abstraction literature), *asynchronous concurrency with interleaved independent actions* (partial-order reduction, parameterized systems, most of the Handbook), and *programs* — Java, C, IMP, RTL (the KeY book, Concrete Semantics, Huth & Ryan ch 4, the whole VLSI half of Seligman & Schubert). Sysprose walks four configurations on its flagship example, its interpreter concatenates regions rather than interleaving them, and it has no program to verify. Roughly two-thirds of the pages here are answers to problems this tool does not have.

**What does transpose is smaller than expected and better than expected.** It falls into three groups. First, a **class of property the tool cannot currently express at all** — existential/branching-time questions ("can it reach this?", "can it always get back?"), which are decidable on the graph Sysprose already builds and which two independent traditions in this set identify as first-order checks. Second, a **specification discipline** — behavioural subtyping, contract framing/footprints, and signature-versus-body consistency — which is about what a *specification* must satisfy, not about what an engine must compute, and which therefore survives the change of subject matter intact. Third, a small number of **honesty and reporting principles** that this set states better than the tool's own documentation does, chiefly the guaranteed-versus-potential modality and the cover-property discipline.

Concretely: eight candidates below, of which the top two share one engine change of about a day's work and close a blind spot I demonstrated on a five-state machine. Nine topics are rejected with reasons. One famous idea — symmetry reduction — turns out not to be in this library at all.

---

## 2. Ranked candidates

Candidates 1, 2 and 5 share a single prerequisite: `exploreMachine` (`src/semantics/mc/explore.ts`) must retain the successor relation it already computes. Today it keeps only a `Set<string>` of configuration hashes and `continue`s on a revisit (:511-512) without recording the edge. Recording it before the prune, plus one Tarjan pass, is the whole change; memory is bounded by `maxConfigs × (1 + |alphabet|)` edges — four edges on the shipped example. The cost is stated once here and not re-charged per candidate.

---

### 1. `cover` — an existential reachability property with a witness

**The idea and its source.** Seligman & Schubert, *Formal Verification: An Essential Toolkit for Modern VLSI Design* (2nd ed.), ch 5 "Wiggling the design", **book pp.138-139 (PDF 159-160)**. Tip 5.14: *"Begin any FPV effort by creating a set of reasonable cover properties on your model, representing typical and interesting activity."* And on the same page: *"A common mistake people make at this stage is to start by trying to prove the assertions, with cover properties as a secondary consideration. But if the assertions are proven at this stage, what does it really tell us? Since a proven assertion doesn't generate any waveform, it would be hard to decide whether our FPV environment is effectively exercising the design."* Ch 9 "Vacuity issues", **book p.289 (PDF 310)**: *"one important technique we use to sanity-check our formal environments is proving cover properties. These show that under our current set of assumptions and settings, we are able to replicate interesting behaviors in our design."*

The formal shape is Baier & Katoen §6.6 "Counterexamples and Witnesses", **book pp.373-374 (PDF 392-393)**: *"a sufficiently long prefix of a path π with π ⊨ φ is a **witness** of the CTL path formula ∃φ."* The written form is Huth & Ryan §3.4.3, **book p.215 (PDF 231)**: `EF (started ∧ ¬ready)` — "It is possible to get to a state where started holds, but ready doesn't."

The class has a name. Handbook of Model Checking ch 2 §2.3.2, Fig. 4, **book p.45 (PDF 57)** gives the Manna–Pnueli temporal hierarchy — Safety `□β`, **Guarantee `◇β`**, Obligation, Recurrence `□◇β`, Persistence `◇□γ`, Reactivity — and states the duality this candidate rests on: *"The complement of every Safety property is a Guarantee property and vice versa."* `cover` is the Guarantee class: not finitely refutable, which is why the bad-prefix engine correctly refuses it, and finitely **witnessable**, which is why the same engine can confirm it.

**The engineering question.** Can this design ever get into the state I care about? And its dual: did my safety property pass because the machine cannot get anywhere interesting?

**Why it is a gap, not a rename.** `check-behaviour` ships six patterns and **all six are assertions** (`src/semantics/mc/patterns.ts`:132-172). A positive reachability intent — "the design shall be able to enter `failsafe`" — can today only be written as `absence (state failsafe)` and read backwards: the desired outcome is `verification/refuted`, exit 1, a red build for a correct design. I ran it; it fails with a three-step witness. The witness is right and the polarity is wrong. Dwyer's `existence` is the infinite-trace version and is refused as liveness, so the catalogue has no slot for the question.

**Mapping.** A third `PatternClass` (`'guarantee'`, beside `'safety'` and `'liveness'`) and one entry in `PATTERNS`. Same five scopes, same five atoms — `state` / `node` / `trigger` / `fires` / expression (`src/semantics/mc/atoms.ts`:58) — same `@SysproseVerification::PropertyPattern` §7.27 metadata carrier. No new syntax and no new vocabulary in user files.

**Engine.** In-process TypeScript. The product BFS already carries `ProductNode.parent` (`patterns.ts`:805) and reconstructs the shortest path with `traceOf` (:1008); only the acceptance predicate flips. No solver.

**Verdict vocabulary.** MAY say: `covered — witness trace of 3 step(s), a run this semantics admits`; `not covered under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet …}`; `inconclusive: bound exhausted — the not-covered claim is not made`.

**MUST NEVER say:** "reachable" unqualified when the witness consumed a trigger. The walk offers every trigger in the alphabet at every configuration (`explore.ts`:457-460), so a cover witness is a claim about a *maximally cooperative environment* and the line must carry that sentence. Never "not covered" on a non-exhaustive walk — that is an absence claim and must be suppressed exactly as the unreachable list is. Never "verified". And it must not default to exit 1: a missing behaviour is not a violated requirement. Exit 2 with `verification/not-covered`, plus an opt-in `--cover-required` for teams that want it red.

**Honest cost.** One pattern class, one acceptance flip, one diagnostic code, one exit-contract row. The real cost is documentation: `DIAGNOSTIC-CODES.md`, the generated `CLI-REFERENCE.md`, `USER-GUIDE.md`, `CONFORMANCE.md` §8.5 and `FEATURE-PARITY.md` all pin the "four of six decided" split, and the doc-drift guards fail loudly until each moves.

**The measurement that kills it.** Run it on the first real model. If ≥80 % of the covers a user writes are `state X` × `globally`, `reach`'s reachable-state list already answers them and this is a rename — drop it and print the witness path in `reach`. The cases that justify a separate command are covers over an **expression** atom, over `fires T`, or under a `between` / `after-until` scope, none of which `reach` reports.

---

### 2. `AG EF P` — "can it always get back?", by strongly-connected components

**The idea and its sources — two, from unrelated traditions.**

Huth & Ryan §3.4.3, **book p.215 (PDF 231)**, among the canonical CTL patterns: *"From any state it is possible to get to a restart state: `AG (EF restart)`."* The section is explicit that this class is branching-time and has no LTL equivalent. Cost: Baier & Katoen **Theorem 6.30, book p.355 (PDF 374)** — CTL model checking is `O((N+K)·|Φ|)`, linear in the transition system.

Independently, and without any temporal logic, Stanley & Laski, *Software Verification and Analysis* §5.6, **book p.118 (PDF 104)**:

> "The flowgraph is **connected** iff every node lies on some program path. In other words, if the program is connected then for every node in the graph, **(1) the node is reachable and (2) there is a path from the node to the exit node E**. It is obvious that if the graph is not connected then there exists a potential control anomaly in the program. Thus, **if condition (1) is violated for some node, the node can never be executed; if condition (2) is violated**, program exit is never reached if the node is reached on some computation."

**Sysprose ships condition (1) and not condition (2).** `reach`'s unreachable-state list is condition (1). Nothing in the tool computes condition (2). Two traditions forty years and one subject-matter apart name the same pair as a single well-formedness check, and the tool implements half of it.

**The engineering question.** Once the system enters degraded / failsafe / maintenance, can it always get back to a nominal mode? Which reachable configurations form a trap?

**Demonstrated, not hypothesised.** I wrote a five-state machine in which `failsafe → failsafeHold → failsafe` is an absorbing two-cycle with no route back to `standby`. `reach` reports: *"5 configuration(s) explored, depth 4 — exhaustive … 5 of 5 state(s) reachable; 6 of 6 transition(s) fired, 0 dead"*, one pre-existing nondeterminism row, and **no finding**. No deadlock (every configuration has a successor), no dead transition, no unreachable state. `universality (state standby)` exits 1, but it does so on every machine that ever leaves `standby`, so it distinguishes nothing. An unrecoverable failsafe is precisely the defect a systems engineer buys a mode-machine checker to find.

**Mapping.** Two new outputs on `reach` — the **bottom SCCs** of the configuration graph and which configurations reach each — plus a `recovery` pattern on the existing carrier: `pattern=recovery, scope=globally, p=state standby`. `p` is read by the same `readAtom`. SysML machines have no unique exit node, so Stanley & Laski's "reach `E`" becomes "reach the designated recovery state" — reverse reachability from a state the engineer names.

**Engine.** In-process TypeScript: the retained successor relation plus one Tarjan pass. Stanley & Laski's own recipe (§7.2, **book p.146**) is the transitive closure `A⁺` with a membership test per node; Tarjan is the linear-time equivalent.

**Verdict vocabulary.** MAY say: `recoverable: standby is reachable from every reachable configuration (exhaustive under {…})`; `not recoverable: 2 configuration(s) form a trap — {failsafe, failsafeHold} — from which standby is unreachable; entry witness of 3 step(s)`; `inconclusive: bound exhausted`.

**MUST NEVER say:** "the system can always recover" — escaping a trap may need a trigger the real environment never offers, so this is a claim about the machine under a cooperative environment. Never a recoverability claim on a non-exhaustive walk: it is an absence claim in disguise (absence of an escape path) and the four publishability conditions in `explore.ts` govern it. Never "livelock", never "deadlock-free".

**Honest cost.** One commit. The adjacency retention is the only change to `exploreMachine`, and `reach`'s existing golden output is its own differential test — it must not move.

**The measurement that kills it.** Build the BSCC report over every model the user has. On `examples/uav-isr.sysml` the whole FlightModes graph is a single SCC (`standby → manual → autonomous → failsafe → standby`), so it returns "recoverable" and finds nothing — that is a pass, not evidence. If three consecutive real models are either one SCC or a DAG into final states, drop it: the feature earns its place only on machines with a degraded mode that is *meant* to be exitable.

---

### Rider to 1 and 2 — the guaranteed / potential modality

Same engine, small enough not to rank separately, and it improves an existing verdict rather than adding one.

**Source.** Stanley & Laski §7.1, **book p.144 (PDF 129)**: *"programmers want to know the rationale behind a warning about an anomaly. In particular, they want to know whether the anomaly is **guaranteed** (i.e., occurring on every execution) or **potential**, occurring on some executions only. That, however, is rarely offered by the supporting tool … Consequently, **anomalies whose reason is hard to understand tend to be ignored.**"* The book then prescribes different report shapes per modality (**book p.150**): a *potential* anomaly gets **two contrasting paths**, one that hits it and one that does not; a *guaranteed* one gets a declarative sentence.

**The gap.** Sysprose's `fail` means *there exists a run* — a potential violation, evidenced by one witness. Whether **every** run violates is a stronger, separately decidable fact on the stored graph, and on `FlightModes` the two differ: `absence(failsafe)` fails on some runs while the declaration-order tie-break means a simulation never reaches `failsafe` at all.

**Refuses:** never report `guaranteed` from a non-exhaustive walk (it is a universal claim); never downgrade an existing `fail` — the modality annotates it, it does not replace it.

---

### 3. `verify --why` — the axioms a proof actually used, and staleness scoped to them

**The idea and its source.** Seligman & Schubert ch 9, "Implicit or unstated assumptions" and "Proven memory controller that failed simulation", **book pp.290-291 (PDF 311-312)**. The worked case: a memory-controller block whose properties were "fully verified" only after an assumption was added that the address bus would not change during an operation — an assumption false of the neighbouring unit, *"rendering some of the initial FPV proofs invalid."* The chapter's conclusion, **book p.291**: *"Whenever using assumptions in FV, you should always have a good understanding of how their correctness is verified, whether through FV on an adjacent unit, extensive simulation, or careful manual review."* You cannot review the assumptions a proof leaned on if the tool never says which they were.

The same object has a name on the specification side: the KeY book calls it a **footprint** — "a set of locations on which the result of a query depends at most" — and formalises it as a dependency proof obligation (§9.3.2, **book p.321**). KeY's argument against the negative formulation transposes exactly (§9.3.1, **book p.320**): a specification that says what must *not* change "may also not be open to extensions of the program because a specification cannot possibly talk about memory entities which are only to be included in an extension."

**The engineering question.** Which of this model's twelve axioms carried this proof, and which edits can invalidate it? (`obligations --missing` on `examples/uav-isr.sysml` reports "0 premise(s), **12 axiom(s)**", so the answer is legible at this scale.)

**Mapping.** Nothing new in the model. The SMT script already emits `(set-option :produce-unsat-cores true)` and `(assert (! … :named |kind:name|))` for every assertion, labelled by qualified name (`src/semantics/smt/encode.ts`:898, :923). The backend already returns `core: string[]` on `unsat` and reads it back with `coreOf` (`src/semantics/smt/z3-bridge.ts`:205, :549). The verify path already **has that value in hand** — `negation.core` at `src/semantics/engines/smt.ts`:733 — and discards it.

**Engine.** z3, already the `--engine smt` dependency.

**Verdict vocabulary.** MAY say: `proved (negation unsat, QF_LRA) using 3 of 12 axioms: uav.battery.capacity, uav.usableEnergyFraction, uav.cruisePower`; `the set z3 returned is sufficient, not minimal — an axiom listed here may not have been needed`. Staleness becomes `current — no axiom in this proof's core changed` / `stale — battery.capacity is in this proof's core and moved`.

**MUST NEVER say:** "minimal core" without a deletion loop — the rule `consistency` already enforces through `--minimize`. And never say an edit *cannot* affect the claim on the core alone: UNSAT of a subset survives, so the negation stays unsat, but step 2's satisfiable-assumptions precondition (`engines/smt.ts`:768-800) can be broken by an edit to a non-core axiom, turning `proved` into `vacuous`. The honest rule is *"the negation is still unsat; non-vacuity re-checked in one solver call."*

**Why it matters beyond display.** `validation/stale-evidence` digests the whole user model and admits it in its own message (`src/validation/rules.ts`:1288-1291): *"the digest is over the whole model, so this tool cannot say which of them moved."* Every unrelated edit invalidates every proof. A core digest lets evidence survive edits that provably cannot affect it, and names the ones that can. Note the design axis, which this book set frames twice: KeY makes the footprint *declared* (an `accessible` clause the author writes and the tool discharges); this makes it *computed*. Computed is cheaper and needs no new vocabulary.

**Honest cost.** The `--why` display is ~20 lines. The staleness change is the work: two digests must coexist, and `EvidenceRecord` gains a field validated against `docs/schemas/evidence-record.schema.json` — a compatibility commitment.

**The measurement that kills it.** On the first real requirement set, count how often a recorded proof is invalidated by an edit **outside** its core. If the whole-model digest and the core digest go stale together in >90 % of edits, keep the display and drop the second digest.

---

### 4. Specification inheritance — a specialized requirement must carry its parent's clauses

**The idea and its source.** Ahrendt et al., *The KeY Book*, §7.4.5 "Inheritance of Specifications", **book p.218 (PDF 244)**, phrased as contract refinement — which is why it is the right citation for a tool that already implements contract refinement:

> "a class C′ is a behavioral subtype of a super class C, if for every method m implemented in both C and C′ … every specification case for C::m is also a specification case for C′::m, and that **the contract of C::m is refined by the contract of C′::m**."

§9.1.1 gives the reason it matters: modular reasoning may only assume the *static* type's contract ("supertype abstraction"), and *"Behavioral subtyping is essential to sound supertype abstraction."* The mechanism is stated in Huisman & Wijs §7.5, **book p.186 (PDF 193)**: *"Function specifications are also inherited … every class that extends another class has to respect the specifications of this class … **Any additional specification of the subclass is implicitly combined (with `also`) with the specifications from the superclass.**"*

**The engineering question.** `requirement def StrictMassLimit :> MassLimit` — when I `satisfy` the child, what am I obliged to?

**Measured, on a twenty-line file.** `contracts` reports `StrictMassLimit` with **one** guarantee (its own `v.topSpeed <= 60 [m/s]`), does not list the inherited `v.mass <= 1500 [kg]`, and does not flag the inheritance at all — `clausesInheritedFrom` is populated only on the branch `clauses.length === 0 ? inheritedClauseOwners(…) : []` (`src/semantics/contracts.ts`:1085). With `mass = 1600 [kg]`, `verify --engine literal` prints:

```
SpecInherit::StrictMassLimit  v.topSpeed <= 60.0 [m/s]
  holds-at-values: holds at the model's values (no assumptions — the pass is unconditional at these values)
```

The parent is separately refuted in the same run, so the run is not silently green. The defect is narrower and real: the verdict *named after the child* reports on a subset of the child, and nothing says which subset. The de-duplication itself is defensible for the worklist — `inheritedClauseOwners`'s docstring gives the reason — but the per-contract verdict line inherits the omission without disclosing it.

**Mapping.** `effectiveFeatures(model, id)` (`src/semantics/inheritance.ts`:63) already returns inherited clause features with redefinition-by-name masking — the KerML rule, implemented and tested. Reading clauses through it instead of `model.children` is the change, plus `origin: 'inherited'` on `ContractClause` (the `origin` union at `contracts.ts`:233 already carries the word). The second half is `refine --via specialize`: parent assumption ⊨ child assumption, child guarantees ⊨ parent guarantees — the two obligations `--via derive|refine` already computes (`src/semantics/refinement.ts`:1112), over `Subclassification`/`Specialization` edges instead of `Derive`/`Refine`.

**Engine.** In-process TypeScript for the inventory; z3 for the subtyping obligation.

**Verdict vocabulary.** MAY say: `2 guarantee(s): 1 declared, 1 inherited from MassLimit`; `specialization refines: the child assumes no more and guarantees at least as much`; `not a refinement: StrictMassLimit redefines MassLimit's guarantee and weakens it — witness v.mass = 1600 kg`.

**MUST NEVER:** fold an inherited clause in silently — a reader who wrote one clause and is shown two must see where the second came from. Never treat a same-named child clause as *adding* to the parent's: `effectiveFeatures` masks by name, that masking **is** redefinition, and a redefinition that weakens is the violation to report, not to hide. And never say "behavioural subtype", even on a pass — KeY, **book p.220 (PDF 246)**: *"Respecting inherited specifications is a good practice, but it does not guarantee behavioral subtyping per se."* Passing the two obligations is necessary, not sufficient.

**Honest cost.** Low code, **high blast radius**. Changing what `contractsOf` returns moves `contracts`, `obligations`, `verify`, `consistency`, `refine` and `fault-tree` at once, plus every golden fixture — the same class of change as the plan's own D1.

**The measurement that kills it.** Count `requirement def X :> Y` in real models; the shipped examples contain none. If specialization of requirement definitions is rare, this is a correctness fix with no user, and the cheap version is a diagnostic — `verification/inherited-clause-not-read`, naming the parent — rather than a semantics change.

---

### 5. Liveness under a declared, checked fairness assumption — by fair-SCC

**Sources.** Baier & Katoen Def. 3.43 (**book p.130**), §3.5.2 (**book p.137**), Example 3.52 *Circuit Fairness* (**book p.139**), Theorem 3.55 and Example 3.56 (**book pp.140-141**), §6.5 Algorithm 18 (**book p.370**), Algorithm 19 (**book p.372**), Theorems 6.42-6.43 (**book p.373**). §4.4.2 nested depth-first search (**book pp.203-217**) is cited as the technique **not** to import. Full reasoning in §3 below.

**The engineering question.** "Every commanded mode change is eventually entered"; "every fault is eventually followed by a safe state" — the two questions `check-behaviour` answers `inconclusive` today.

**Mapping.** A `@SysproseVerification::FairnessAssumption` carrier on the state definition naming a set of transitions (choice fairness) and a set of triggers (environment justice), with `strength = "strong" | "weak"`. The transition set has a ready default: the transitions already named in `verification/nondeterministic-choice` rows.

**Engine.** In-process TypeScript: the retained graph, Tarjan, then Algorithm 19's recursion, whose depth is the number of fairness constraints (typically 1-3).

**Verdict vocabulary.** MAY say: `holds on every maximal run — the configuration graph is acyclic, so no fairness assumption was needed`; `holds under fairness {strong: autonomous -> failsafe; weak: triggers abort, resume}`; `refuted: lasso standby → manual → (autonomous → manual)^ω, 2-step cycle`; `inconclusive: the declared fairness assumption has no fair continuation from configuration #3, so it may also change the safety verdicts`.

**MUST NEVER:** print a liveness verdict without the fairness assumption on the same line — `docs/CONFORMANCE.md` §8.5 already promises this. Never use the word *realizable* for the fair-continuation check: Baier & Katoen's sense (a fair execution exists from every reachable state) collides with reactive realizability, which Sysprose's claims guard reserves. Never apply a fairness assumption to a safety pattern's verdict without re-checking the four safety patterns under it and reporting any change.

**Honest cost.** The largest behaviour-lane item: a carrier (a compatibility commitment), a new verdict class, `CheckFair`, and the fair-continuation precondition. Two commits, plus an acyclic / cyclic / unfair-lasso fixture trio.

**The measurement that kills it.** Ship the acyclic half first and instrument it. If most machines carrying a liveness question turn out acyclic, the fairness machinery has no customer. If most are cyclic *and* the assumption a user would write is always "everything is strongly fair", the assumption carries no information and the honest answer remains `inconclusive`.

---

### 6. Stutter-simulation between an abstract machine and its refinement

**The idea and its source.** Baier & Katoen ch 7. The two-model use is the chapter's *primary* framing, **book p.449 (PDF 468)**: *"Implementation relations are predominantly used for comparing two models of the same system. Given a transition system TS that acts as an abstract system specification, and a more detailed system model TS′, implementation relations allow checking whether TS′ is a correct implementation (or: refinement) of TS."* The recipe is a named subsection — **§7.3.5 "Equivalence Checking of Transition Systems", book p.493 (PDF 512)**: compute the quotient of the disjoint composite `TS₁ ⊕ TS₂`, then check `C ∩ I₁ ≠ ∅ iff C ∩ I₂ ≠ ∅` for every equivalence class.

The reason to build *this* rather than trace inclusion is on the facing page: **Theorem 7.46, book p.494 (PDF 513)** — checking trace equivalence is **PSPACE-complete**, in both the finite-trace and infinite-trace forms — while Corollary 7.45 gives bisimulation equivalence as `O((|S₁|+|S₂|)·|AP| + (M₁+M₂)·log(|S₁|+|S₂|))`. For the one-way refinement question the relevant relation is simulation, whose order computes in **O(M·|S|)** with the refined algorithm (**book p.524**), not the naive cubic bound.

**The engineering question.** I have a system-level mode machine and a subsystem machine that is supposed to implement it. Does the detailed one do only what the abstract one allows?

**Mapping.** The `Refine` relationship between two `StateDefinition`s as the carrier. Both halves parse today: I wrote `state def Detailed :> Abstract` with `refine Abstract by Detailed;` and `reach` walked both ("2 state machine(s), 2 walked to exhaustion"). `refinement.ts` already reads the `Refine` edge and documents its **measured** orientation (:1070-1090), so parent/child is not a guess. Atoms provide the labelling — `state X` on both sides.

**Engine.** In-process TypeScript. `|S|` in the tens; the bound must still be printed and enforced.

**Verdict vocabulary.** MAY say: `Detailed is simulated by Abstract — simulation relation of 7 pairs, over graphs of 3 and 2 configurations, both exhaustive`; `no simulation relation exists: the pair (Detailed::warmup, Abstract::idle) fails — warmup → active has no matching step`; `inconclusive: Abstract was not walked to exhaustion`.

**MUST NEVER:** say "equivalent" — simulation is a pre-order and equivalence is a different check. Never say "`Detailed` does not implement `Abstract`" from a failed search: the book calls the method *sound but incomplete for trace inclusion*, so the only honest sentence names the pair that broke it. Never a verdict when either walk was non-exhaustive.

**Honest cost.** A genuinely new algorithm plus one new relationship reading. Two commits — the highest-value item here that needs real new machinery rather than a re-use.

**The measurement that kills it — and it still stands.** Does any real model contain two state machines related by `refine` or `:>`? The shipped examples contain none; I had to write one. If the answer is no across the user's own models, this is a feature for a modelling style nobody here practises, and it waits until it has a customer.

---

### 7. Signature consistency — the four conditions between declared ports and actual dependency

**The idea and its source.** Stanley & Laski §7.4-7.5. The **Dependency Template** (**book p.154**): *"a binary relation DT from the set EXP of exported parameters to the set IMP of imported parameters. A pair (Y X) is in DT if and only if the imported parameter X **may be used** in P to obtain the final value of the exported parameter Y."* Then the four **Consistency Conditions**, **book pp.158-159 (PDF 144)**:

> "1. **Every exported parameter depends on at least one imported parameter** … ∀n : Exp • ∃w:Imp • n DT w.
> 2. **Every imported parameter is used to compute at least one exported parameter** … ∀w: Imp • ∃v: Exp • v DT w.
> 3. **No exported parameter depends on an OUT parameter** …
> 4. **No OUT parameter can be used before being defined in the procedure**, i.e., cannot be live at the entry to the procedure."

Industrial corroboration that this is a high-yield check: Seligman & Schubert ch 7, **book pp.211-212 (PDF 232-233)** — *"connectivity is now one of the most widely used and productive FPV apps"*, because *"there are too many ways to use those 'correct-by-construction' tools incorrectly or to introduce errors through late manual changes."*

**The engineering question.** Every consumer in the ISR example takes `powerIn`. Is every one actually reached from `battery.powerOut` — and, harder, does every declared input actually influence some output?

**What is and is not there.** `connectivityReport` (`src/api/analytics.ts`:1433) is a **port inventory**: it counts user ports, lifts implicit endpoints, and flags ports no connection endpoint reaches (15 ports, 14 connected, 1 dangling on the UAV example). It answers "is anything unwired". It cannot answer condition 2 — a port can be wired and still influence nothing.

**Mapping.** Transposed to a part with `in` and `out` ports: conditions 1 and 2 are immediately meaningful, and neither is expressible today. `connectorEndsOf`, `bindingEquivalenceClasses`, `itemFlowsOf` and `propagateValues` (`src/semantics/connectors.ts`) already compute the value-flow relation the dependency template needs. Note the design axis this book states explicitly (**book pp.153-154**): SPARK requires an engineer-written `DERIVES` annotation and checks it; STAD *derives* the template and needs no annotation. Sysprose should be on the STAD side — derive it, ship no new vocabulary.

**Engine.** In-process TypeScript. Reachability plus a dependency relation over the connector graph. No solver.

**Verdict vocabulary.** MAY say: `9 of 9 declared connections realised; uav.battery.powerOut → uav.gimbal.powerIn reached in 1 hop`; `condition 2 violated: in port radio.videoIn influences no out port of DataLink`; `structural only — a connect is not a guarantee that anything is transported`.

**MUST NEVER** call this verification, and never say which side is wrong. The triage rule is the book's, **book p.159**: *"if the above conditions are indeed violated, perhaps the code is correct and only the signature should be adjusted accordingly."* So the finding says *the declaration and the structure disagree* — never that either is wrong. It must also never read a bare `connect` as a value equality; that is `refine`'s standing refusal and this must not contradict it.

**Honest cost.** Small — the graph machinery exists. Conditions 3 and 4 have no clean SysML analogue (there is no `OUT`-parameter liveness notion), so ship 1 and 2 and say that 3 and 4 were not transposed.

**The measurement that kills it.** If real models declare no `in` port that fails condition 2, the check reduces to `connectivity`'s dangling-port list, which already ships.

---

### 8. Behavioural fault tree by failure-mode injection

**The idea and its source.** Bertoli, Bozzano & Cimatti, "A Symbolic Model Checking Framework for Safety Analysis, Diagnosis, and Synthesis", MoChArt LNCS 4428, **book pp.5-9 (PDF 12-16)**. Definition 2, **book p.6 (PDF 13)**:

> "A cut set is formally defined via CTL as follows. **Definition 2 (Cut set).** … We say that FC is a cut set of TLE … if `M ⊨ EF ( ⋀_{f∈FC} f ∧ ⋀_{f∈(F\FC)} ¬f ∧ TLE )`"

A cut set is an `EF` query — the Guarantee class, i.e. candidate 1's engine, run once per fault configuration. The paper also supplies the construction (**book pp.8-9**): *model extension* takes a nominal model plus a fault specification and mechanically produces an extended model with `p^FM` (the failure-mode variable), `p^Failed` and `p^Ext`. Its architectural principle is one Sysprose already holds (**book p.8**): *"it is important to have a **complete decoupling between the system model and the fault model**."*

**The engineering question.** Which combinations of component failure modes drive this machine into the hazard state — at the behavioural level, not the contract level?

**Mapping.** The shipped `fault-tree` injects **contract** failures and refuses a `StateUsage` outright. This is its behavioural sibling: failure-mode flags on the machine, then cut sets as cover queries over the extended configuration graph, minimality by increasing order with superset pruning — the enumeration discipline `computeFaultTree` already implements.

**Engine.** In-process TypeScript, downstream of candidate 1.

**Verdict vocabulary.** MAY say: `3 failure modes; minimal cut sets up to order 2: {navFail}, {radioFail, gpsFail}; 7 queries, all decided`; `no cut set up to order 2 — higher orders not explored`.

**MUST NEVER:** omit the two limits the paper itself states. Cut sets are computed under a **permanence assumption** — once failed, always failed (condition (1), **book p.6**) — and *"the temporal relationships between failures may be important, e.g. a certain top level event may require f1 to occur before f2"* (**book p.8**), which a plain `EF` query does not capture. Both print on the verdict line alongside the order bound.

**Honest cost.** Ranked last for two reasons. It has no engine until candidate 1 exists, and unlike everything else here it needs **new model vocabulary**: `#exceptional` marks a failure *outcome*, not a failure *mode variable*, and a failure-mode annotation the tool writes into user files is a compatibility commitment.

**The measurement that kills it.** If the contract-level `fault-tree` already answers the safety questions users actually ask, a second lane with its own vocabulary is not worth the commitment. The trigger to build it is a real model whose hazard is a *mode* rather than a broken contract.

---

## 3. The two live questions, answered

### Liveness — a qualified yes, third in the queue, and not by NDFS

**Fairness is well defined for this machine, and the books say so directly.** Baier & Katoen's Definition 3.43 (**book p.130 / PDF 149**) defines unconditional, strong and weak fairness over **a set of actions**, not over a set of processes. Nothing in the definition needs a scheduler. §3.5.2's rule of thumb (**book p.137**) — *"concurrency = interleaving (i.e., nondeterminism) + fairness"* — tells you by contraposition that where there is no interleaving, the fairness you need is not process fairness. The book then gives exactly this tool's case: **Example 3.52, "Circuit Fairness" (book p.139 / PDF 158)** — a *sequential* circuit, no concurrency at all, whose environment supplies inputs by nondeterminism: *"It may be necessary to impose fairness assumptions **on the environment** in order to be able to verify liveness properties."*

**So for a SysML v2 machine whose regions the interpreter concatenates, fairness means two things and only two, and both have carriers already in the tool.**

1. **Choice fairness.** The only nondeterminism the explorer introduces is the declaration-order tie-break — it branches on "every transition enabled at the innermost active level, where the interpreter takes the first" (`explore.ts`:496-508). Strong fairness over that set means a transition infinitely often enabled at a choice point is infinitely often taken. Sysprose already computes and names those choice points as `verification/nondeterministic-choice`, one row per `(configuration, input)` with two or more enabled at the innermost level. The assumption has a ready-made domain.
2. **Environment fairness.** `exploreMachine` offers `{completion} ∪ machineAlphabet` at **every** configuration (:457-460) — a maximally permissive, entirely unfair environment. For any triggered machine there is always a run in which the needed trigger is never offered, so without justice on the input alphabet essentially every `response` has a trivial counterexample and the answer is worthless.

**The right algorithm is not nested depth-first search.** §4.4.2 (**book pp.203-217**) presents NDFS as the on-the-fly, memory-frugal way to find an accepting lasso in a product you cannot afford to store. Sysprose stores the whole graph: `reach` on the shipped example explores **4 configurations**. The algorithm that fits is §6.5's — **Algorithm 18 (book p.370)** computes the SCCs of the state graph and tests each non-trivial SCC for a fair cycle with **Algorithm 19, `CheckFair` (book p.372)**; **Theorem 6.42 (book p.373)** gives `O((N+K)·k)` under strong fairness with k constraints and **Theorem 6.43** gives `O((N+K)·|Φ|·k)` for CTL model checking with fairness. Importing NDFS would import the memory optimisation without the memory problem.

**Three conditions, one of which is a genuine trap.**

- The graph is not stored today — the prerequisite shared with candidates 1 and 2.
- **On an acyclic reachable graph no fairness assumption is needed at all.** Every run is finite, so `existence` and `response` are plain finite-path properties the existing exhaustive walk decides. A mission-sequence machine is in this class. Report acyclicity, decide the two patterns outright, and say *"no fairness assumption was needed: every run of this machine terminates."* Ship this half first.
- **A fairness assumption can silently break the safety verdicts.** Theorem 3.55, *"Realizable Fairness is Irrelevant for Safety Properties"* (**book p.140 / PDF 159**), holds only for assumptions with a fair continuation from every reachable state; Example 3.56 (**book p.141**) shows a non-conforming assumption changing the verdict on "never a". The tool must therefore check that condition before using the assumption — which is the same SCC pass, so it is free.

**The order this argues for:** (a) acyclic case, no fairness, decided outright; (b) cyclic case with a declared, checked fairness assumption, then fair-SCC; (c) never a liveness verdict without the assumption printed. And build it *after* candidates 1 and 2, both because it rides on their engine and because the corpus itself puts safety first — Handbook ch 2 §2.3.2, **book p.43**: *"Algorithmically, safety is much easier to check than liveness and this is the most prevalent form of specification"*, and *"As we are interested in violations of safety, we may restrict attention to finite paths and hence to reachability of violations"* — which is `check-behaviour`'s architecture described in the Handbook's own words.

### Abstraction, CEGAR, POR, symbolic representation — no, none of them

**Partial-order reduction: not applicable, and separately unaffordable.**

Applicability, from the chapter's own preamble (Baier & Katoen ch 8, **book p.597 / PDF 616**): *"As partial order reduction is most effective for concurrent systems that are 'loosely' coupled, it is implicitly assumed that TS models an **asynchronous concurrent system** where processes interact… **In a synchronous setting where concurrent processes evolve in a lockstep fashion, each global transition involves all processes and thus cannot be considered as independent.**"* POR reduces the number of orderings of interleaved independent actions. Sysprose's semantic profile records that the interpreter **concatenates** regions and that the explorer does not walk a parallel machine at all — `attrs.parallel` raises `verification/behaviour-unsupported-construct` and the walk is never exhaustive (`src/semantics/mc/profile.ts`). There are no interleavings, therefore no orderings to reduce.

Cost, independently: **Theorem 8.25, book p.628 (PDF 647)** — *"checking (A2) is as hard as checking a reachability property in the full transition system TS."* The book's escape is static over-approximation on program graphs, and its stated justification is exactly the premise that fails here (**book p.633 / PDF 652**): *"As the size of program graphs is relatively small compared to their underlying transition system, the cost of analyzing the program graphs for checking (A2.1) and (A2.2) is negligible compared to the analysis of their transition systems."* In Sysprose the state machine (4-5 states) and its configuration graph (4-5 configurations) are **the same size**. The gap between syntax and state space that makes POR affordable does not exist.

And it would not help the properties proposed here anyway: branching-time POR forces **(A5) Branching condition: if ample(s) ≠ Act(s), then |ample(s)| = 1** (**book p.652 / PDF 671**). Candidates 2 and 8 are branching-time.

**Symbolic / BDD representation: five orders of magnitude inside the explicit-state envelope.** Measured: `reach` on `examples/uav-isr.sysml` explores **4 configurations**; the trap machine, 5; and a machine I wrote deliberately with a counter attribute and an `assign` effect produced **2**. The configuration graph in this engine is control-dominated. *This rejection is my inference, not a book claim* — see §5.

**CEGAR: rejected, but not for the reason one might reach for first.** The non-termination caveat does **not** apply here: Handbook ch 13 §13.5.1.1, **book p.406 (PDF 408)** — *"Refinement is applied iteratively until a real counterexample is found, or the property is verified. **If the concrete model is finite, then the refinement procedure is guaranteed to terminate.**"* Sysprose's graphs are finite; CEGAR would terminate. The rejection rests on the premise of abstraction itself, ch 13 §13.4.1, **book p.399 (PDF 401)**: *"in practice such a model is usually too large to fit into memory and therefore **is not produced**. Abstract models are constructed directly from some high-level description of the system."* Sysprose *produces* the concrete model, in milliseconds, four configurations of it. There is nothing to abstract from that is not already smaller than the abstraction machinery. Huisman & Wijs confirm the target audience (§6.5.4, **book p.150 / PDF 158**): abstraction-refinement *"really gained a lot of interest when people realised it could be used to model check **software**"* — SLAM, BLAST, Windows device drivers.

**The one conditional exception, with its trigger.** k-induction or bounded model checking (Handbook ch 10) becomes the right answer the day a real model produces a configuration graph the walk cannot exhaust — i.e. the day `verification/bound-exhausted` fires on a model that matters. **The measurement:** instrument `reach` to record `boundHit` per machine across every model run for a month. If it stays `'none'`, the Checkpoint-D decision stays closed. Note also that this would not buy a proof cheaply: the completeness threshold that would upgrade "no violation within k" to "proved" is, per ch 10 §10.6.1, as hard to compute as the model-checking problem itself — which is exactly why `certificate-import`'s existing rule (a `-bmc` run imports as "no violation within k", never as proved) is right.

**Symmetry reduction** is addressed in §4 — it is not in this library.

---

## 4. Read but rejected

**Nested depth-first search** (Baier & Katoen §4.4.2, **book pp.203-217**). The right answer to liveness *when you cannot store the product*. Sysprose stores four configurations. Rejected as an algorithm choice, not as a topic — the fair-SCC algorithm of §6.5 is cheaper to implement and more informative, since it names the fair cycle.

**Partial-order reduction** (Baier & Katoen ch 8; Handbook ch 6). Rejected on three independent grounds, all above: no interleaving to reduce; sound ample-set computation costs a reachability check over the graph POR exists to avoid; the program-graph-versus-state-space size gap that funds the static workaround does not exist here.

**BDDs and symbolic model checking** (Baier & Katoen §6.7; Huth & Ryan ch 6; Handbook chs 7-8). Rejected on measured scale.

**Bounded model checking, k-induction, interpolation, IC3/PDR** (Handbook chs 10, 14). Rejected *conditionally*, with the trigger stated above.

**CEGAR and predicate abstraction** (Handbook chs 13, 15; Huisman & Wijs §6.5). Rejected on the premise of abstraction, not on termination.

**Symmetry reduction — not in this library.** Handbook ch 21 contains **one Related-Work paragraph** on it (**book p.721**): no permutation groups, no orbit relation, no quotient structure, no n! factor, no cost accounting. Nor is it covered elsewhere in the eleven books — the Handbook has no symmetry chapter, Baier & Katoen never treat it (every "symmetr\*" hit is Boolean symmetric functions or "by symmetry" in a proof), and Huisman & Wijs give one further-reading pointer. The substantive reason it would not apply — SysML models replicate *structure*, not *behaviour*; there is one machine, not n copies — is mine, unsupported by a citation from this set. Ch 21 likewise gives no cutoff definition and no cutoff theorems.

**Bisimulation *quotienting*** (Baier & Katoen §§7.1-7.3). Rejected as a state-space reduction — nothing needs reducing. Adopted in its *other* use, comparing two systems (§7.3.5, §7.6), as candidate 6. The one topic here that is both rejected and adopted, depending on which of its two purposes you take.

**Timed automata and TCTL** (Baier & Katoen ch 9; Handbook ch 29). Rejected in-process. `after(n)` is a discrete dwell the explorer does not even advance — it offers each label as an event, an over-approximation the profile declares. Dense time is a different semantics with a different tool.

**Probabilistic model checking, Markov chains, MDPs, PCTL** (Baier & Katoen ch 10; Handbook ch 28). Rejected: the model states no rates. `fault-tree` is deliberately structural for the same reason.

**μ-calculus, parity games, reactive synthesis** (Handbook chs 26, 27; MoChArt LNCS 4428's parity-game paper). Rejected: synthesis produces an implementation, and Sysprose is a tool in which a human writes the model. Realizability is a declared non-goal and the word is reserved.

**Deductive program verification as a lane** (the KeY book; Nipkow & Klein chs 7-12; Huth & Ryan ch 4). Rejected: there is no program — no Java, no IMP, no Hoare triple, nothing to compute a weakest precondition over. What transposes is not the proving but the *specification discipline*, which is candidate 4 and the footprint half of candidate 3.

**Runtime annotation checking and monitoring** (Huisman & Wijs §6.2, ch 9). Rejected: Sysprose has no running system. The argument for evaluating a specification against concrete values before proving is already answered by `--engine literal`, whose discipline is "holds at the model's values, never *proved*".

**SystemVerilog Assertions, symbolic trajectory evaluation, RTL equivalence verification** (Seligman & Schubert chs 3, 8; Handbook chs 24, 25). Rejected: RTL-specific. SVA sequences, clocking and `disable iff` have no SysML v2 counterpart. FEV's *idea* survives as candidate 6; its subject matter does not.

**Directed / heuristic model checking, pattern databases, planning as model checking** (MoChArt LNCS 5348's survey and companions). Rejected on the sharpest possible grounds: these find bugs faster and produce shorter counterexamples in enormous spaces. Sysprose's product search is already breadth-first and therefore already returns the **shortest** witness by construction (`patterns.ts`:846). The survey concedes the framing itself — it calls directed model checking a *"bug-hunting"* / *"bug-finding paradigm"*, and notes that *"For a complete verification every state has to be looked at"*; its pruning variants sacrifice completeness outright.

**Compositional reasoning / assume-guarantee for temporal contracts** (Handbook ch 12). Partly rejected: the *static* obligations already ship in `refine`, on Cimatti's normal form. The temporal version needs an ordering a static check does not have — and the chapter states the exact hazard, **book p.347 (PDF 350)**: *"Soundness arguments for circular rules typically rely on mutual induction over an appropriate well-founded domain, such as the length of finite computations… In particular, **circular rules that are sound for safety properties may not be sound for liveness properties.**"* That is precisely why the plan refuses to borrow AGREE's soundness argument, now with a citation. Automated assumption generation by L\* is rejected outright: it needs a teacher Sysprose does not have, and the permissiveness check is NP-hard.

**Model checking of procedural and concurrent programs, data-flow analysis, security protocols, process algebra** (Handbook chs 16, 17, 18, 22, 32). Rejected: different artefact, different language.

**Alloy-style bounded structural analysis** (Huth & Ryan §2.7, "Micromodels of software"). Rejected reluctantly. The small-scope hypothesis would let Sysprose ask "do these multiplicities and connection constraints admit any instance at all?" — a real modelling question. But it needs a relational bounded solver over multiplicities, and the SMT lane refuses multiplicity > 1 by design. That is a new engine, not a feature.

**Boulanger, *Formal Methods — Industrial Use from Model to the Code***. Read at table-of-contents depth plus one verified section. Its transposable content is process — proof-obligation counts as a project metric, requirement-to-proof traceability, EN 50128 assessment evidence — and Sysprose's evidence lane already occupies that ground. One thing worth knowing before anyone reaches for it: **this library contains no cost-of-formal-methods data**. Boulanger gives 115,000 lines of B → 27,800 proof obligations for METEOR, but no ratio of automatic to interactive discharge, no person-month figures, no currency comparison and no proof-versus-testing cost figure. If you ever want to justify the verification lane economically, these eleven books will not supply the numbers.

**Two further negatives worth recording.** Handbook ch 23, "Transfer of Model Checking to Industrial Practice", **never mentions vacuity** (zero occurrences) and never compares property-writing cost against checker runtime. Handbook ch 19, "Combining Model Checking and Testing", contains **no trap-property or negated-specification test generation**; it covers concolic execution, and "coverage" there means state-space coverage.

**And one negative about the shipped catalogue itself.** The Dwyer/Corbett/Avrunin specification-patterns paper — the source of `check-behaviour`'s six patterns and five scopes — **is cited nowhere in the Handbook** and the catalogue appears in none of the eleven books. The Handbook index has no "specification pattern" entry; its Dwyer/Avrunin/Corbett hits are to unrelated papers. This library therefore cannot validate, extend or contest that catalogue. What it *does* supply is the taxonomy underneath it — Handbook ch 2 Fig. 4, **book p.45** — which is more useful, because it says which class a pattern falls into and therefore what an engine can decide about it. If the four-of-six split in `CONFORMANCE.md` §8.5 ever needs a citation stronger than the catalogue's own paper, Fig. 4 is it.

---

## 5. Not verified — do not rely on

Everything asserted above I read on the page. These I did not, and they are excluded from the reasoning:

1. **The Seligman & Schubert bounded-proof depth rule.** Reported to me as: a bounded proof is reportable when its depth is ≥ 2× the longest cover-property trace, with ch 11 suggesting 2-3×. If it holds it is directly useful for how `check-behaviour` and `reach` report a bound — a principled number instead of a defaulted one. **Verify before use.**
2. **Baier & Katoen Remark 7.3, book p.453** — reported as advising that two models with different vocabularies be compared over "the set of common atomic propositions". This would settle candidate 6's state-correspondence question more cleanly than the `StateMap` carrier I sketched. Plausible and worth checking; not confirmed by me.
3. **Handbook ch 7 book p.203** — optimal BDD variable ordering NP-hard, exact algorithms `O(n·3ⁿ)`, practical to about n = 25; and **ch 8 book pp.219, 229** — explicit-state reported to top out at 10³-10⁶ reachable states versus 10²⁰ BDD-based. These are the figures behind my scale argument. They are consistent with everything I did read, but I did not open those pages.
4. **Baier & Katoen book p.524** — the refined `O(M·|S|)` simulation-order algorithm quoted in candidate 6's cost line.
5. **Stanley & Laski book p.154 (Dependency Template) and book pp.153-154 (the SPARK `DERIVES` contrast)**, and the detection algorithm at **book p.146**. The four Consistency Conditions and the triage sentence at **book pp.158-159** I verified directly; these supporting passages I did not.

**Two conclusions in this report are inferences, not statements any of the eleven books makes**, and should be labelled as such wherever they are reused: *"liveness is cheap at this scale"* (derived from Theorem 6.42/6.43's linearity plus my measured configuration counts) and *"explicit-state beats symbolic below N states"* (no book in the set states a break-even or a switch-over threshold; every conditional statement about BDDs is conditioned on **BDD size**, never on state count).

**One corpus defect.** The Stanley & Laski PDF in this folder is **missing its entire Introduction chapter** (book pp.1-22) along with the part-divider pages; later cross-references into it are unrecoverable from this copy.
# Research

Items that need **decisions and further refinement after deeper research** before they can become a
plan. Each one names the question, why it is not built, the decisions it needs, the sources to read, and
the measurement that would release it.

Where to put new work: [`TODO.md`](TODO.md) holds next actions that are concrete, small and actionable.
[`ROADMAP.md`](ROADMAP.md) holds big features that need a refined plan. **This file** holds items that
need decisions after research.

Items R1 to R5 below are verification checks that the model-checking plan
([`docs/06-model-checking-implementation-plan.md`](docs/06-model-checking-implementation-plan.md))
**held**: it built a check only once a model in this repository would exercise it. §8.1 of that plan
records each hold with the census value measured at `510793c`. The page references come from
[`docs/05-model-checking-literature.md`](docs/05-model-checking-literature.md).

R6 is of another kind: a question about simulation over time, raised by a modelling run on
2026-10-15. It has no plan yet.

## The decision that comes first

**Is a purpose-built example model enough to release a held check?** The rule so far required a real
model, meaning the shipped examples plus the test corpus, so that no check prints verdicts that no
test shows to be right. That rule suits checks which need rare modelling constructs. It undersells
liveness, which real models need often, although the samples here happen not to. Possible answers:

- keep the rule;
- accept a new example written for the check, provided it models a real system;
- release per item.

Every item below depends on this answer.

---

## R1. Liveness: "something good eventually happens" (plan commits 16, 17, 18)

**Question.** Do `existence` and `response` hold, first on machines without cycles, then on machines
with cycles under a declared fairness assumption? `check-behaviour` refuses both patterns today and
reports them as inconclusive with a reason.

**Why it is not built.** Commit 16 decides liveness on an acyclic reachable graph, where every run is
finite and no fairness is needed. It is gated on `reach --json` `exactness.acyclic === true` on a walk
where `walkIsExact` holds. That reads `false` on all three shipped machines. Commits 17 (the
`FairnessAssumption` carrier) and 18 (fair components, plus the safety re-check under an assumption)
depend on 16.

**Decisions needed.**

- Whether to ship the acyclic half first (plan §3.5a) against a new mission-sequence example, since no
  shipped machine is acyclic.
- What an author can write as a fairness assumption that carries information. Transitions are
  anonymous, so an assumption cannot name one. The plan addresses the **choice point's state** and a
  **trigger** instead. `bounds.alphabet` is empty on every machine in the tree, so environment
  justice has no domain exactly where it is needed.
- Which strengths to offer (unconditional, strong, weak), and which is the default.
- How to re-check safety verdicts under an assumption. The theorem that fairness cannot change a safety
  verdict holds only for assumptions that leave a fair continuation from every reachable state; an
  assumption without that property can silently change one.
- Where the assumption is printed. The rule is never a liveness verdict without the assumption on
  the same line (`docs/CONFORMANCE.md` §8.5 already promises this).

**Research.** Baier & Katoen:

- Def. 3.43 (fairness over a set of actions), book p.130.
- §3.5.2 and Example 3.52, pp.137–139.
- Theorem 3.55 and Example 3.56 (fairness and safety properties), pp.140–141.
- §6.5, Algorithms 18–19 (fair SCC), pp.370–373.

The literature review rejects nested depth-first search: it is the on-the-fly method for a graph that
cannot be stored, and this walk stores its graph.

**Released by.** For 16: a model with an acyclic machine, an exact walk and a liveness question. For
17–18: a model with a cyclic machine, a liveness question, and an assumption an author can write that
carries information.

**Plan.** `docs/06` §3.5a and §3.5b.

---

## R2. Contract refinement through inheritance, `refine --via specialize` (plan commit 13)

**Question.** Is `requirement def X :> Y` a contract refinement? That is, does the parent's assumption
entail the child's, and do the child's guarantees entail the parent's?

**Why it is not built.** It is gated on commit 12's census, `contracts --json` `clauseInheritance`.
No contract inherits a clause, by Subclassification or by FeatureTyping, on any of the six examples
or in the corpus.

**Decisions needed.**

- A weakening can only be detected if a child can **redefine a named clause**. Does the notation, as
  authors use it, support named clause redefinition? If not, the check can never refute anything on
  the shipped idiom.
- Whether a pair of anonymous clauses is ever judged, or always reported as `not evaluated`.
- No verdict may be computed over clauses marked `origin: 'inherited'`: folding the parent's
  guarantees into the child makes the obligation true by construction.
- The phrase "behavioural subtype" is banned.
- Whether R2 and R4 share one flag value (`--via specialize`) that dispatches on the metaclass of the
  two ends, as the plan proposes.

**Research.** Ahrendt et al., *The KeY Book*, §7.4.5 "Inheritance of Specifications", book p.218, and
§9.1.1 (supertype abstraction). Huisman & Wijs §7.5, book p.186.

**Released by.** `contractsWithInheritedClauses ≥ 1` by Subclassification, with `namedClausesMasked ≥ 1`,
on a real model.

**Plan.** `docs/06` §3.4b.

---

## R3. Port-signature consistency, conditions 1 and 2 (plan commit 15)

**Question.** Does every `in` port of a part influence some `out` port, and does every `out` port
depend on some `in` port?

**Why it is not built.** It is gated on commit 14's census, `connectivity --signature --json`
`census.signature`. That reads `partsWithBoundaryPortsAndInternalParts 0` on `uav-isr`. Across the
examples the only candidate is degenerate: `Vehicle` has one `in` port, two internal parts and no
`out` port.

**Decisions needed.**

- Which dependency relation to read. The conditions are about a relation *inside* one part, while the
  connector graph composes relations *across* part boundaries. What dependency can be derived from a
  part that declares no behaviour?
- Whether a part without internal behaviour is out of scope, or read through its sub-parts'
  connections.
- The output is a lint, never "verification", and never names which side is wrong. The source's own
  triage rule is that the code may be right and the specification wrong.

**Research.** Stanley & Laski §7.4–7.5: the Dependency Template, book p.154, and the triage rule,
book p.159.

**Released by.** `partsWithBoundaryPortsAndInternalParts ≥ 1` **and** a non-empty dependency template
derivable from that part.

**Plan.** `docs/06` §3.7b.

---

## R4. Refinement between two state machines, by stutter-simulation (plan commits 19, 20)

**Question.** Does a detailed machine do only what an abstract machine allows? The relation checked
is simulation, not bisimulation and not trace inclusion.

**Why it is not built.** It is gated on a census of pairs of state machines related by `Refine` or
`Subclassification`. A text search of every `.sysml` file in the tree finds no such pair: zero
`state def X :> Y`, and the one `refine` relates two requirements. **Commit 19, the model reader
that would count these pairs, was planned to ship regardless and was never built.** That is a gap,
not a measured hold. Commit 20 depends on it.

**Decisions needed.**

- Which relationship means "this machine refines that one": `refine`, `:>`, or both.
- How the two machines' states are matched, meaning which atomic propositions a simulation relation
  must preserve.
- Stuttering: how internal steps of the detailed machine are allowed.
- Simulation is a pre-order, so "equivalent" is never printed. A failed search does not prove that
  the detailed machine fails to implement the abstract one.
- Whether this shares `--via specialize` with R2.

**Research.** Baier & Katoen ch. 7. Book p.449 frames implementation relations as comparisons of two
models of one system. Theorem 7.46 (p.494) shows trace equivalence is PSPACE-complete, which is why
simulation is the check to build.

**Released by.** The commit-19 reader reports at least one related pair of machines on a real model.

**Plan.** `docs/06` §3.6.

---

## R5. Behavioural fault trees by failure-mode injection (plan commits 22, 23)

**Question.** Which combinations of component failure modes drive a **state machine** into a hazard
state? This is the behavioural level. Today's `fault-tree` works at the contract level only.

**Why it is not built.** It is gated on commit 21's census, `fault-tree --json`
`faultTree.behaviouralLane`. It reads zero failure-mode flags and zero `#exceptional` states across
every machine in the corpus; the machine count is pinned in `test/campaign/verification.test.ts`.
`fault-tree` answers a machine with those measured zeros, and exits 2.

**Decisions needed.**

- What a failure mode is in the notation: the `#failureMode` vocabulary of commit 22, a boolean
  attribute that guards read, or something else. `FAILURE_MODE_DEFINITION` currently lives in
  `src/semantics/fault-tree.ts` and belongs in the verification vocabulary.
- How to build the extended model: the source's model extension, which adds one failure-mode variable
  per mode to a nominal model, versus seeding the store the walk already reads (the plan's choice).
- How a hazard is named: an `#exceptional` state, or a state the author passes on the command line.
- How cut sets are enumerated. Each cut set is a `cover` (`EF`) query, run once per fault
  configuration, so the query count grows with the order bound.

**Research.** Bertoli, Bozzano & Cimatti, "A Symbolic Model Checking Framework for Safety Analysis,
Diagnosis, and Synthesis", MoChArt, LNCS 4428, pp.5–9.

**Released by.** A real model whose hazard is a **mode** rather than a broken contract: a machine with
an `#exceptional` state that a contract-level fault tree cannot reach.

**Plan.** `docs/06` §3.8.

---

## R6. Time-based simulation from parametric constraints (no plan yet)

**Question.** Should a parametric diagram (constraint usages and the binds between value
properties) also drive a simulation **over time**, and not only be judged at one point? If so, what
does an author write to say that a value changes in time, which engine runs it, and how is the result
judged against a requirement?

**Why it is not built.** Every surface that reads parametrics today is static:

- the literal engine checks the relations at the model's own values;
- the SMT engine (`verify --engine smt`, z3) proves or refutes them over the free variables;
- `bounds` and the app's Solve find a range or one solved point.

Time appears in two other places only:

- Simulate runs state machines as discrete events. The interpreter's timed runs advance a discrete
  clock and fire `after(n)` transitions (`src/semantics/execute.ts`).
- FMI is an interface:
  - Export → FMU writes a co-simulation interface skeleton with no behaviour inside
    (`src/interop/fmi/export.ts`), and Import FMI adds a block read from a `modelDescription.xml`.
  - A fixed-step Jacobi co-simulation master (`CoSimMaster`, `src/interop/fmi/cosim.ts`) can be called
    from code but not from the app.
  - A SysML block takes part in it by re-solving its parametric equations at every step from the
    inputs it holds (`sysmlBlockInstance`). Its outputs are therefore an algebraic function of its
    inputs, with no state of its own; state can only come from another participant, such as an
    in-TS stepping component (`analyticFmu`).

The case that raised the question is mbse-workflow's drone-swarm v9 model. Its coverage equation is
an average over the duty cycle, and evaluates to 0.78 against the 0.9 the brief asks for. A
two-hour time-based simulation built outside the model watched 0.54 of its sectors, and its watch fell
to zero whenever the whole fleet recharged at once. No static relation states that effect.

**Decisions needed.**

- **Which kind of time first.** The options are:
  - continuous: derivatives, an ODE or DAE, integrated;
  - discrete-time: difference equations per step;
  - discrete-event: state machines with time triggers, which the interpreter already has.

  The duty cycle above is mostly discrete events: launch, transit, watch, return, battery swap.
- **Notation.** How an author marks a value as state, gives its derivative or next-step value and its
  initial value, and names the independent time. The candidates are:
  - a metadata convention in the spirit of SysPhS;
  - a library calculation such as `der`;
  - SysML v2 occurrences with time slices and snapshots.

  To clarify: whether any part of the SysML v2 libraries defines a derivative with solver semantics.
- **Engine.** A built-in fixed-step integrator in the co-simulation master, an export to Modelica or
  to a WebAssembly-compiled FMU, or an external tool.
- **Causality.** Parametric equations are acausal. The numeric solver solves a static system. A
  dynamic one needs causalisation (sorting, index reduction) or a DAE solver.
- **How a run is judged.** A requirement such as "at least 0.9 under watch at every moment" read as
  a monitor over the simulated trace. The property patterns of `check-behaviour` (globally, after,
  between) are candidates. A simulation is evidence about the runs it made, never a proof, and its
  verdict must say so.
- **Bounded proofs over time.** Whether to unroll a discretised model over N steps for z3 (bounded
  model checking), so that "never below X within N steps" is proved or gets a counterexample run.
  This would sit between a single-point check and a simulation.
- **Where it shows.** A CLI command (`simulate --until`), a panel in the app, and an evidence record.

**Research.**

- OMG SysPhS, the SysML v1 extension for physical interaction and signal-flow simulation, and its
  mappings of constraint blocks to Modelica and Simulink.
- SysML v2 and KerML: time slices and snapshots of occurrences, the Time library, analysis cases.
- FMI 3.0: co-simulation and model exchange.
- SysML v2 to FMI/SSP co-simulation, three works on generating the simulation structure from the
  model (read their abstracts only so far; the PDFs are not yet held):
  - Zimmermann, Manoury & Lindow (Fraunhofer IPK), "SysML v2 for Automated Co-simulation from
    Systems Architecture Models", Proceedings of CSER 2024, Springer, pp. 35–46, DOI
    10.1007/978-3-031-62554-1_4. Closed access.
  - Kramsu, "Integration of SysML V2, FMI, and PyFMI for Enhanced System Simulation", Master's
    thesis, University of Oulu, 2024, URN:NBN:fi:oulu-202409125823 (CC BY 4.0).
  - Banagar, Kramsu, Könnö & Andwari, "Connecting systems engineering and domain expertise through
    a toolchain: A simulation-integrated MBSE approach", Journal of Systems and Software 232,
    112671, DOI 10.1016/j.jss.2025.112671 (CC BY 4.0).

  What to take from them: how a SysML v2 block's parametric equations and connections become an
  FMU network and a simulation (SSD/SSP) description, and where the dynamics live.
- The Modelica Language Specification: DAE semantics, causalisation, events.
- Cellier & Kofman, *Continuous System Simulation* (2006): integration methods and DAE index
  reduction.
- Biere et al., "Symbolic Model Checking without BDDs" (TACAS 1999), for bounded model checking.
- Gao, Kong & Clarke, dReal/dReach (δ-complete SMT over nonlinear ODEs), for bounded proofs with
  continuous dynamics.

**Released by.**

- A measurement first: the v9 duty cycle written as per-drone state machines with `after`
  triggers, run by the interpreter alone, reproduces the outside simulation's 0.54 within a stated
  tolerance. This shows whether the discrete-event path already answers the case.
- Then a decision on the notation and the engine for continuous dynamics, if a model needs them.

**Plan.** None yet; this item needs its own plan document.

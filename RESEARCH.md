# Research

Items that need **decisions and further refinement after deeper research** before they can become a
plan. Each one names the question, why it is not built, the decisions it needs, the sources to read, and
the measurement that would release it.

Where to put new work: [`TODO.md`](TODO.md) holds next actions that are concrete, small and actionable.
[`ROADMAP.md`](ROADMAP.md) holds big features that need a refined plan. **This file** holds items that
need decisions after research.

All five items below are verification checks that the model-checking plan
([`docs/06-model-checking-implementation-plan.md`](docs/06-model-checking-implementation-plan.md))
**held**: it built a check only once a model in this repository would exercise it. §8.1 of that plan
records each hold with the census value measured at `510793c`. The page references come from
[`docs/05-model-checking-literature.md`](docs/05-model-checking-literature.md).

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

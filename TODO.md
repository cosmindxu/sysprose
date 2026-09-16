# To do

Next actions: concrete, small, actionable. Big features belong in [`ROADMAP.md`](ROADMAP.md). Items
that need decisions after research belong in [`RESEARCH.md`](RESEARCH.md).

- [ ] **Stop `docs/TEST-SUMMARY.md` from drifting.** Add a CI step that runs
      `npx tsx scripts/gen-test-report.ts --from <the gate's vitest JSON>` and then
      `git diff --exit-code docs/TEST-SUMMARY.md`. Today the documents are checked against each other,
      but the suite total is only as current as the last manual regeneration.
- [ ] **Close the known gap in the z3-death handling (D5).** A z3 hang inside a plain `it(` that keeps
      vitest's 5 s default timeout is killed before the 35 s death guard fires. That case reads as a
      timeout, and the `[D5]` line lands on the next case. Give every solver-driving plain `it(` in
      `test/campaign/verification.test.ts` an explicit timeout of at least 40 s.
- [ ] **Give register row W2's per-step alternative a producer.** `ExploreResult.successors` stores
      no transition id per edge, so the trap entry path can never use the per-step wording
      (`TRAP_ENTRY_WALK_ADMITS` exists and is asserted unprinted). Retain the transition id beside each
      successor and wire the alternative.
- [ ] **Decide how the app shows inherited contract clauses.** The Contracts view shows an inherited
      clause as `N more clause(s) inherited from X`, while `contracts` in the terminal prints its body
      marked `(inherited)`. Either show the body in the app, or record the difference as deliberate
      in `docs/USER-GUIDE.md`.

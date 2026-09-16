package DeadlockGuarded {
    /*
     * An undecided guard in one part of a machine, and a real sink in another.
     *
     * This is the one shape on which a walk-wise reading of the guard gate and
     * a configuration-wise one give different answers, and no other model in
     * this tree has it.
     *
     * `holding` has exactly one way out and it is behind `if resetOk`, which
     * nothing values: the walk consults that guard, decides nothing, and offers
     * no edge — so the configuration standing at `holding` looks like one
     * nothing leaves, and it is not. That row must be withheld.
     *
     * `done` has no outgoing transition at all. No guard was consulted to
     * establish it, none could have been, and nothing anywhere else in the
     * machine can make the answer wrong. That row is a fact about the design and
     * survives.
     *
     * Under the shipped walk-wise gate one undetermined guard anywhere empties
     * the whole array, so `done`'s row was lost with `holding`'s. The two
     * completion transitions leaving `nominal` are what puts both leaves in one
     * walk; the hidden-choice row they raise is the ordinary finding for a
     * declaration-order tie-break and is part of what this fixture reports.
     */
    part def Ctrl {
        attribute resetOk : Boolean;
        state def Modes {
            state nominal;
            state holding;
            state done;
            transition nominal then holding;
            transition nominal then done;
            transition holding if resetOk then nominal;
        }
    }

    /*
     * The same question one level in, where the leaf is not the whole answer.
     *
     * The undecided guard is on the edge leaving the COMPOSITE `degraded`, and
     * the configuration that looks like a dead end stands at `sub2` inside it.
     * The step relation offers every edge leaving any member of the active
     * stack, so `degraded -> nominal` is a way out of that configuration — and
     * a reading that asked only about the LEAF would find `sub2` carrying no
     * undecided edge and publish a row about a configuration whose way out the
     * model states and the walk could not decide.
     */
    part def Nested {
        attribute resetOk : Boolean;
        state def Modes {
            state nominal;
            state degraded {
                state sub1;
                state sub2;
                transition sub1 then sub2;
            }
            transition nominal then degraded;
            transition degraded if resetOk then nominal;
        }
    }
}

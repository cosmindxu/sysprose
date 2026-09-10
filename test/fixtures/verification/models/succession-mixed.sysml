package SuccMix {
    /*
     * A machine wired with BOTH edge kinds the notation offers between states,
     * and the control that shows the succession is really being walked.
     *
     * `Ctrl` writes `first active then done;` in plain sight. The walk used to
     * follow `TransitionUsage` and nothing else, so the succession was not in
     * the step relation, was not in the transition census, and was not in any
     * configuration — and the report still called itself `exhaustive` while
     * publishing `done` unreachable and `active` a state with no way out. Two
     * absence claims about an edge the walk did not follow, over a model that
     * parses clean and raises nothing of its own.
     *
     * `Loop` is the control that a succession is walked rather than merely
     * counted: its succession closes a cycle, so if it were still ignored the
     * machine would deadlock at `active` — and if it is walked, both states are
     * reachable, both edges fire and nothing is absent. `Ctrl` keeps its
     * no-way-out row at `done`, because `done` genuinely has no outgoing edge
     * of either kind and is not marked final: that row is the walk reporting
     * the machine it now sees whole, not the machine it could not see.
     */
    part def Ctrl {
        state def Modes {
            state idle;
            state active;
            state done;
            transition idle then active;
            first active then done;
        }
    }

    part def Loop {
        state def Modes {
            state idle;
            state active;
            transition idle then active;
            first active then idle;
        }
    }
}

package TrapProbe {
    /*
     * A set of configurations nothing leaves, reached in three steps, with no
     * guard and no trigger anywhere in it.
     *
     * `failsafe` and `failsafeHold` cycle between themselves and neither has an
     * edge to anything else, so the pair is a bottom component of the retained
     * relation: every run that arrives there stays there. `alpha` and `beta`
     * cycle too, but `beta` also leaves for `failsafe`, so that pair is a
     * component and NOT a bottom one — which is the distinction a component
     * pass has to get right and the reason this file carries two cycles rather
     * than one.
     *
     * Nothing returns to `standby`, so the count of configurations that cannot
     * reach it is FOUR while the bottom component holds TWO. The two numbers
     * answer two different questions and this machine is where they differ.
     *
     * Completion-driven throughout, on purpose: the walk's relation is the
     * machine's relation here — no dwell, no named trigger, no guard — so the
     * exactness gate holds and anything read off this graph is read off the
     * graph the model states.
     */
    part def Probe {
        state def Modes {
            state standby;
            state alpha;
            state beta;
            state failsafe;
            state failsafeHold;
            transition standby then alpha;
            transition alpha then beta;
            transition beta then alpha;
            transition beta then failsafe;
            transition failsafe then failsafeHold;
            transition failsafeHold then failsafe;
        }
    }
}

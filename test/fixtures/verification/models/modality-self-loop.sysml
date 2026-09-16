package Sink {
    /*
     * The sink-scoping fixture: a self-loop the violating state never leaves.
     *
     * `nominal -> hazard`, `hazard -> hazard`. Against `absence (state hazard)`
     * the only non-violating configuration is `nominal`, and INSIDE the
     * non-violating subgraph `nominal` has no successor at all — its one edge
     * leads out of it. A reading that tests for a sink there answers
     * `potential — some run avoids it`, while every maximal run of this
     * machine is `nominal -> hazard -> hazard -> …` and every one violates. A
     * sink is a sink in the FULL retained relation or it is not a sink, and
     * this is the machine that says so.
     */
    part def Plant {
        state def Modes {
            state nominal;
            state hazard;
            transition nominal then hazard;
            transition hazard then hazard;
        }
    }
}

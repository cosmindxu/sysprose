package CycleBehindViolation {
    /*
     * A cycle every run reaches only by passing THROUGH the violation.
     *
     * `boot -> fault -> recoverA <-> recoverB`. Against `absence (state fault)`
     * the non-violating subgraph holds the cycle `recoverA -> recoverB ->
     * recoverA`, and a reading that asks only *is there a cycle among the
     * non-violating configurations* answers `potential`, naming a cycle no
     * violation-avoiding run ever reaches — a sentence about a specific run
     * that does not exist. Reachability has to be taken from the opening
     * WITHIN the non-violating subgraph, and from `boot` the only step leads
     * into `fault`: every run violates, and the answer is `guaranteed`.
     */
    part def Controller {
        state def Modes {
            state boot;
            state fault;
            state recoverA;
            state recoverB;
            transition boot then fault;
            transition fault then recoverA;
            transition recoverA then recoverB;
            transition recoverB then recoverA;
        }
    }
}

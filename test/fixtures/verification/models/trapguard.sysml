package TrapGuard {
    /*
     * A guard nothing values, on the edge that leaves a trap.
     *
     * `Trap` cycles between `degradedA` and `degradedB` and has exactly one way
     * back to `nominal`, behind `if resetOk` — and `resetOk` has no declared
     * value, so the walk consults that guard and decides nothing. The edge is
     * therefore absent from the retained relation while the model states it,
     * which is the whole of the exactness gate's store clause: a walk that
     * finished inside every bound, over a relation that is missing an edge.
     *
     * `TwoState` is the same defect at the smallest size that shows it — one
     * cycle, one undecided way out — and it is the machine an acyclicity census
     * would get wrong, because the edge it never saw is the one that closes the
     * cycle.
     *
     * The literal variants live beside this file (`trapguard-true.sysml`,
     * `trapguard-false.sysml`): the point of the trio is that the undetermined
     * list tracks DECIDEDNESS and not the presence of a guard.
     */
    part def Trap {
        attribute resetOk : Boolean;
        state def Modes {
            state nominal;
            state degradedA;
            state degradedB;
            transition nominal then degradedA;
            transition degradedA then degradedB;
            transition degradedB then degradedA;
            transition degradedA if resetOk then nominal;
        }
    }

    part def TwoState {
        attribute resetOk : Boolean;
        state def Modes {
            state nominal;
            state degraded;
            transition nominal then degraded;
            transition degraded if resetOk then nominal;
        }
    }
}

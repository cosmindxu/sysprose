package TrapGuardFalse {
    /*
     * `trapguard.sysml` with the escape guard DECIDED, and failing.
     *
     * The escape edge is absent from the relation here too — but it is absent
     * because the model says so, not because the walk could not tell. That is
     * the difference `undeterminedGuards` is there to record, and it is empty
     * on this file as it is on `trapguard-true.sysml`.
     */
    part def Trap {
        attribute resetOk : Boolean = false;
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
        attribute resetOk : Boolean = false;
        state def Modes {
            state nominal;
            state degraded;
            transition nominal then degraded;
            transition degraded if resetOk then nominal;
        }
    }
}

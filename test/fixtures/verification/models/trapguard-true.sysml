package TrapGuardTrue {
    /*
     * `trapguard.sysml` with the escape guard DECIDED, and holding.
     *
     * The walk takes `degradedA -> nominal`, so the relation is the one the
     * model states, nothing is withheld, and `undeterminedGuards` is empty —
     * which is what makes the trio a test of decidedness rather than of the
     * mere presence of a guard.
     */
    part def Trap {
        attribute resetOk : Boolean = true;
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
        attribute resetOk : Boolean = true;
        state def Modes {
            state nominal;
            state degraded;
            transition nominal then degraded;
            transition degraded if resetOk then nominal;
        }
    }
}

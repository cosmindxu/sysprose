package TrapGuardTyped {
    /*
     * A FULLY VALUED feature, and a guard over it that still decides nothing.
     *
     * `mode` is an Integer with a declared value, so *"no declared value for a
     * feature the guard reads"* — the narrow reading of the store clause — is
     * satisfied here and reads the walk as exact. The shipped predicate does
     * not: `not mode` applies a boolean operator to a number, which
     * `guardVerdictStore` reports as `'undetermined'` with an EMPTY
     * `unresolved` list. This is the one model in the tree that tells the two
     * readings apart, and without it the store clause is untested in the
     * direction it can go wrong.
     */
    part def Trap {
        attribute mode : Integer = 3;
        state def Modes {
            state nominal;
            state degradedA;
            state degradedB;
            transition nominal then degradedA;
            transition degradedA then degradedB;
            transition degradedB then degradedA;
            transition degradedA if not mode then nominal;
        }
    }
}

package RecoveryComposite {
    /*
     * One atom, two readings, and the machine on which they part.
     *
     * `degraded` is a composite state: while the machine is in `sub1` or
     * `sub2`, `degraded` is on the active STACK and is the active LEAF of
     * nothing. So `state degraded` holds at every configuration inside it and
     * `node degraded` holds at none — which is how `atomHolds` reads the two
     * kinds, and the reading `recovery` must take from it rather than from a
     * predicate of its own. Read both through the stack, `recovery p = node
     * degraded` would see two target configurations and print `recoverable`
     * at exit 0 while `absence p = node degraded` PASSES on the same walk —
     * one command disagreeing with itself about one atom. Read through
     * `atomHolds`'s selection, the target set is empty and the row is the
     * refutation it should be.
     *
     * Completion-driven, no guard, no trigger: the walk's relation is the
     * machine's, so the gate holds and the two readings are decided rather
     * than withheld.
     */
    part def Ctrl {
        state def Modes {
            state nominal;
            state degraded {
                state sub1;
                state sub2;
                transition sub1 then sub2;
            }
            transition nominal then degraded;
        }
    }
}

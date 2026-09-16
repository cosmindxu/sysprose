package CompositeTrap {
    /*
     * A set of configurations nothing leaves, standing INSIDE a composite
     * state.
     *
     * `degraded` holds `sub1` and `sub2`, which cycle between themselves, and
     * nothing leaves `degraded` itself. The walk's bottom component is the
     * `sub1 -> sub2 -> sub1` cycle — two configurations — and the active stack
     * of each is `degraded / subN`, so the trap's `states` is the union of the
     * STACKS, `{degraded, sub2, sub1}` in node order, entered in two steps
     * from `nominal`. A reading that named the trap by its leaves alone would
     * print `{sub1, sub2}` and never mention the composite the run is stuck
     * in. On every flat fixture the two readings coincide; this file is where
     * they differ.
     *
     * Completion-driven, with no guard and no trigger, so the exactness gate
     * holds and the row is published.
     */
    part def Plant {
        state def Modes {
            state nominal;
            state degraded {
                state sub1;
                state sub2;
                transition sub1 then sub2;
                transition sub2 then sub1;
            }
            transition nominal then degraded;
        }
    }
}

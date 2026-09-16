package CoverProbe {
    /*
     * The polarity defect `cover` exists to fix, reachable half.
     *
     * `failsafe` IS entered by a run of this semantics: `idle` completes into
     * `armed`, and `abort` takes `armed` into `failsafe`. The only spelling the
     * catalogue offered for "can this design reach failsafe?" was `absence of
     * state failsafe`, which REFUTES here — exit 1, `verification/refuted`, an
     * error — about a design that does exactly what its author wanted. The
     * same intent written as `pattern=cover` is `covered`, exit 0, with the
     * same two-step run printed as the witness. Its sealed twin is
     * `cover-sealed.sysml`.
     */
    part def Reachable {
        state def Modes {
            state idle;
            state armed;
            state failsafe;
            transition idle then armed;
            transition armed accept abort then failsafe;
        }
    }
}

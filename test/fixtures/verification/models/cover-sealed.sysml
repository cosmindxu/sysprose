package CoverProbe {
    /*
     * The polarity defect `cover` exists to fix, sealed half.
     *
     * Nothing enters `failsafe`: the only edge out of `armed` is gone. `absence
     * of state failsafe` PASSES here — exit 0 — about a design whose safety
     * behaviour cannot be reached at all, which is the half of the defect a
     * reader acts on. `pattern=cover` reads it `not covered`: a decided
     * absence, exit 2 — and exit 1 only under `--cover-required`, because a
     * missing behaviour is not a violated requirement. Its reachable twin is
     * `cover-reachable.sysml`.
     */
    part def Sealed {
        state def Modes {
            state idle;
            state armed;
            state failsafe;
            transition idle then armed;
        }
    }
}

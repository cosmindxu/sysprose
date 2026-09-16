package Sink {
    /*
     * Two states, one edge, and a configuration nothing leaves that is NOT an
     * ending.
     *
     * `b` has no outgoing transition and is not marked final, so `reach`
     * reports it as `verification/deadlock` — a configuration with no enabled
     * way out. It is also, to a component pass, a bottom component of size one.
     * The same fact may not be reported twice under two codes, so the trap
     * question hands this component to the deadlock row and reports no trap:
     * one finding, and a no-trap accounting that NAMES the deadlock it
     * exempted rather than contradicting the row above it.
     */
    part def Ctrl {
        state def Modes {
            state a;
            state b;
            transition a then b;
        }
    }
}

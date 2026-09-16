package AvoidingSink {
    /*
     * A real way around the violation that ends rather than cycles.
     *
     * `start -> alarm` and `start -> parked`, with `parked` terminal. Against
     * `absence (state alarm)` the run `start -> parked` stops without ever
     * entering `alarm`, so the violation is `potential` — and the run that
     * avoids it is a SINK of the full relation, not a cycle, which is the one
     * shape of an avoiding run the cycle test alone cannot see. Two completion
     * transitions leave `start`, so the interpreter's declaration-order
     * tie-break takes the first and never parks: the verdict is about the
     * machine, and the simulator sentence beside it says so.
     */
    part def Vehicle {
        state def Modes {
            state start;
            state alarm;
            state parked;
            transition start then alarm;
            transition start then parked;
        }
    }
}

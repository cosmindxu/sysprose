package GuardProbe {
    /*
     * A guard the walk cannot evaluate, and the two controls that stop the fix
     * from over-firing.
     *
     * `Ctrl` gives `mode` no value at all. The model does not say `mode != 3`;
     * it says NOTHING about `mode`, so `if mode == 3` is a question this tool
     * does not decide — and before the gate landed, the walk read "did not
     * evaluate" as "did not fire" and published three absence findings under the
     * word `exhaustive`.
     *
     * `Decided` and `Fires` are the same machine with a value: 4 makes the guard
     * genuinely false (the absence findings are correct and must still be
     * printed), 3 makes it hold (the transition fires and nothing is absent).
     * Both are here so a change that withheld an absence over a guard the walk
     * DID decide fails as loudly as the defect this file reproduces.
     */
    part def Ctrl {
        attribute mode : Integer;
        state def Modes {
            state idle;
            state hazard;
            transition idle if mode == 3 then hazard;
        }
    }

    part def Decided {
        attribute mode : Integer = 4;
        state def Modes {
            state idle;
            state hazard;
            transition idle if mode == 3 then hazard;
        }
    }

    part def Fires {
        attribute mode : Integer = 3;
        state def Modes {
            state idle;
            state hazard;
            transition idle if mode == 3 then hazard;
        }
    }
}

// States and transitions. Reconstructed from the recorded CU-2 shape (a state machine owned by
// a part). That shape files no row; extended here with a state-definition
// attribute and a ceiling requirement so the partial read is visible: the
// attribute reaches a row, the transition graph does not (the model-checking
// lane owns it), so the area is `partial`.
package ProbeStates {
    part def Vehicle {
        state def Modes {
            attribute load : Real = 3.0;
            state off;
            state moving;
            transition off then moving;
        }

        state modes : Modes;
        attribute limit : Real = 5.0;
    }

    part vehicle : Vehicle;

    requirement def LoadCeiling {
        subject v : Vehicle;
        require constraint { v.modes.load <= v.limit }
    }

    satisfy LoadCeiling by vehicle;
}

// Calculations and constraints. Reconstructed from the recorded CU-2 shape (a typed constraint
// definition bound to the design's part and asserted); unchanged from that
// shape. The assert is read over its parameter: `read`.
package ProbeCalculations {
    part def Vehicle {
        attribute mass : Real = 1500.0;
    }

    part vehicle : Vehicle;

    constraint def MassCeiling {
        in v : Vehicle;
        v.mass <= 2000.0
    }

    assert constraint MassOk : MassCeiling {
        in v = vehicle;
    }
}

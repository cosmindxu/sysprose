// Ports and direction. Reconstructed from the recorded CU-2 shape (an `out` port on an Engine,
// read through the part); unchanged from that shape. The port usage and its
// member attribute reach the row, but `out` is structural and no surface reads
// it, so the area is `partial`.
package ProbePorts {
    port def FuelPort {
        attribute flowRate : Real = 12.0;
    }

    part def Engine {
        out port fuelOut : FuelPort;
    }

    part engine : Engine;

    requirement def FlowCeiling {
        subject e : Engine;
        require constraint { e.fuelOut.flowRate <= 15.0 }
    }

    satisfy FlowCeiling by engine;
}

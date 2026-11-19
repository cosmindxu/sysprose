// Parts and attributes. Reconstructed from the lost probe shape recorded at
// a recorded CU-2 shape (Vehicle.mass + a ceiling
// requirement); unchanged from that shape. The row reads `v.mass`, so both
// shapes reach a decision row: `read`.
package ProbePartsAttributes {
    part def Vehicle {
        attribute mass : Real = 1500.0;
    }

    part vehicle : Vehicle;

    requirement def MassCeiling {
        subject v : Vehicle;
        require constraint { v.mass <= 2000.0 }
    }

    satisfy MassCeiling by vehicle;
}

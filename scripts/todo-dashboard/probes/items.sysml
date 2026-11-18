// Items. Reconstructed from the recorded CU-2 shape (an item usage owned by a part, read
// through the part); unchanged from that shape. The row reads `v.fuel.mass`:
// `read`.
package ProbeItems {
    item def Fuel {
        attribute mass : Real = 2.0;
    }

    part def Vehicle {
        item fuel : Fuel;
    }

    part vehicle : Vehicle;

    requirement def FuelCeiling {
        subject v : Vehicle;
        require constraint { v.fuel.mass <= 5.0 }
    }

    satisfy FuelCeiling by vehicle;
}

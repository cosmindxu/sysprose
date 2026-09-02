package P {
    port def FuelPort;
    part def Vehicle {
        attribute mass : Real = 1500.0
        in port fuelIn : FuelPort;
    }
}

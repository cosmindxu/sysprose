package P {
    part def Engine;
    port def FuelPort;
    part def Vehicle {
        port fuelIn : FuelPort;
        part engine : Engine;
    }
}

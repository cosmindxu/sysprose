package P {
    part def Vehicle {
        port fuelIn : FuelPort;
        part engine : Engine;
    }
    part def Engine;
    port def FuelPort;
}

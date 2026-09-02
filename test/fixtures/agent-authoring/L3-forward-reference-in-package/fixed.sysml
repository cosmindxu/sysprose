package P {
    part def Engine;
    port def FuelPort;
    part def Vehicle {
        in port fuelIn : FuelPort;
        part engine : Engine;
    }
}

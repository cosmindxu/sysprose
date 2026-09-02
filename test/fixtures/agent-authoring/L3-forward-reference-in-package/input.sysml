package P {
    part def Vehicle {
        in port fuelIn : FuelPort;
        part engine : Engine;
    }
    part def Engine;
    port def FuelPort;
}

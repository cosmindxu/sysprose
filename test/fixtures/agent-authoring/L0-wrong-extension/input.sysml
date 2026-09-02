package VehicleModel {
    port def FuelPort {
        attribute flowRate : Real;
    }
    part def Vehicle {
        attribute mass : Real = 1500.0;
        port fuelIn : FuelPort;
    }
}

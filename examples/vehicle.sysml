package VehicleModel {

    part def Vehicle {
        attribute mass : Real = 1500.0;
        attribute maxSpeed : Real = 220.0;
        in port fuelIn : FuelPort;
        part engine : Engine;
        part transmission : Transmission;
    }

    part def Engine {
        attribute power : Real = 150.0;
        out port fuelOut : FuelPort;
        out port driveOut : TorquePort;
    }

    part def Transmission {
        in port driveIn : TorquePort;
        attribute gears : Integer = 6;
    }

    port def FuelPort {
        attribute flowRate : Real;
    }

    port def TorquePort {
        attribute torque : Real;
    }

    part vehicle : Vehicle {
        connection fuelLine connect engine.fuelOut to fuelIn;
        connection driveline connect engine.driveOut to transmission.driveIn;
    }

    action def Drive {
        action start;
        action accelerate;
        action cruise;
        action stop;
        first start then accelerate;
        then cruise;
        then stop;
    }

    state def VehicleStates {
        state off;
        state idling;
        state moving;
        transition off -> idling;
        transition idling -> moving;
        transition moving -> idling;
        transition idling -> off;
    }

    requirement def MassRequirement {
        attribute id = "R-001";
        doc /* The vehicle total mass shall not exceed 2000 kg. */
        subject vehicle : Vehicle;
        require constraint { vehicle.mass <= 2000.0 }
    }

    satisfy MassRequirement by vehicle;
}

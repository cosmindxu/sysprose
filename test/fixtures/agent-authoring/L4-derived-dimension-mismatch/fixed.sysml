package P {
    part def BatteryPack {
        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
    }
    part def AirVehicle {
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        // A duration: 640 Wh / 650 W = 3544 s; the comparison converts to minutes.
        attribute endurance : ISQ::DurationValue = battery.capacity / cruisePower;
        part battery : BatteryPack;
    }
    part uav : AirVehicle;
    requirement def Endurance {
        subject uav : AirVehicle;
        require constraint { uav.endurance >= 45.0 [min] }
    }
}

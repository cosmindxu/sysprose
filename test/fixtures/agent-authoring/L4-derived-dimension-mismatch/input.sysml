package P {
    part def BatteryPack {
        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
    }
    part def AirVehicle {
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        // Minutes by hand: the engine derives seconds, the author means minutes.
        attribute enduranceMin : Real = battery.capacity / cruisePower * 60.0;
        part battery : BatteryPack;
    }
    part uav : AirVehicle;
    requirement def Endurance {
        subject uav : AirVehicle;
        require constraint { uav.enduranceMin >= 45.0 [min] }
    }
}

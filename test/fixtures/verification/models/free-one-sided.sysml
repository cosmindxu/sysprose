package OneSidedFree {
    part def BatteryPack {
        attribute capacity : ISQ::EnergyValue = 640.0 [W*h];
    }
    part def AirVehicle {
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        attribute usableEnergyFraction : ScalarValues::Real = 0.8;
        attribute endurance : ISQ::DurationValue = battery.capacity * usableEnergyFraction / cruisePower;
        part battery : BatteryPack;
    }
    part uav : AirVehicle;
    requirement def EnduranceRequirement {
        doc /* One-sided: the premise says how much power the vehicle may draw
             * and nothing at all about how little. Freeing `cruisePower` under
             * it lets a solver answer with a NEGATIVE power, which the tool's
             * own evaluator confirms arithmetically and no design admits. */
        subject uav : AirVehicle;
        assume constraint { uav.cruisePower <= 600.0 [W] }
        require constraint { uav.endurance >= 45.0 [min] }
    }
    satisfy EnduranceRequirement by uav;
}

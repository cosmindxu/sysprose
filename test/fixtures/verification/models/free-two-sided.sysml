package TwoSidedFree {
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
        doc /* Two-sided: the premise confines the freed power from BOTH ends,
             * which is what makes a verdict available at all. Endurance falls
             * as power rises, so the worst case in [100 W, 600 W] is 600 W —
             * 640 Wh x 0.8 / 600 W = 51.2 min, still over the 45 min asked
             * for — and the requirement holds across the whole released
             * domain rather than at one point of it. */
        subject uav : AirVehicle;
        assume constraint { uav.cruisePower >= 100.0 [W] and uav.cruisePower <= 600.0 [W] }
        require constraint { uav.endurance >= 45.0 [min] }
    }
    satisfy EnduranceRequirement by uav;
}

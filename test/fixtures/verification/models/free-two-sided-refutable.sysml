package AdmittedByDesign {
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
        doc /* Two-sided and REFUTABLE: releasing the power up to 900 W puts
             * 640 Wh x 0.8 / 900 W = 34.1 min inside the released domain, under
             * the 45 min asked for. The counterexample is a design the model
             * ADMITS once the binding is released — not a violation of the
             * model, which binds the power to 650 W. */
        subject uav : AirVehicle;
        assume constraint { uav.cruisePower >= 100.0 [W] and uav.cruisePower <= 900.0 [W] }
        require constraint { uav.endurance >= 45.0 [min] }
    }
    satisfy EnduranceRequirement by uav;
}

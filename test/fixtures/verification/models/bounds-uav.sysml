package BoundsUav {

    doc /* A mass and energy budget with two ranges stated as AXIOMS and one
         * requirement that is not one, so `bounds` can be asked the four
         * questions it answers differently: a linear measure inside a
         * two-sided range, a measure nothing bounds once its values are
         * released, the same measure with the `require` body folded in, and a
         * nonlinear one where an optimum cannot be certified. */

    part def BatteryPack {
        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
    }

    part def AirVehicle {
        attribute emptyMass : ISQ::MassValue = 12.5 [kg];
        attribute payload : ISQ::MassValue = 6.0 [kg];
        // Linear in the two masses: the shape a solver can certify an optimum for.
        attribute mtow : ISQ::MassValue = emptyMass + payload;
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        attribute usableEnergyFraction : Real = 0.8;
        // A division by a feature: nonlinear in the bytes z3 sees, whatever is
        // pinned, which is why no optimum over it is ever certified.
        attribute endurance : ISQ::DurationValue = battery.capacity * usableEnergyFraction / cruisePower;

        part battery : BatteryPack;

        // AXIOMS, not requirements: the standard's own way to state a range as
        // a fact about the design rather than as something to be shown.
        assert constraint payloadRange { payload >= 2.0 [kg] and payload <= 6.0 [kg] }
        assert constraint packSize { battery.capacity >= 500.0 [Wh] and battery.capacity <= 700.0 [Wh] }
    }

    part uav : AirVehicle;

    requirement def MassRequirement {
        attribute id = "R-BND-001";
        doc /* Maximum take-off mass shall stay within the 25 kg class boundary. */
        subject uav : AirVehicle;
        require constraint { uav.mtow <= 25.0 [kg] }
    }

    satisfy MassRequirement by uav;
}

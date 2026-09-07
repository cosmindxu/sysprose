package ConsistencySubtype {
    doc /* A two-level subject hierarchy, which is where a run-level figure
         * built by concatenating the groups goes wrong.
         *
         * A requirement about a `Vehicle` is a requirement about every air
         * vehicle, so `RiseLimit` and `ProseOnly` are members of BOTH groups.
         * One relation refused and one requirement with no relation at all must
         * still be reported as ONE of each over the run — the refused count is
         * the figure the word "consistent" is not allowed to travel without —
         * and `--subject AirVehicle` must find the requirements its supertype
         * states even though no contract names `AirVehicle` at all. */

    part def Vehicle {
        attribute mass : ISQ::MassValue = 18.5 [kg];
        attribute t1 : ISQ::TemperatureValue = 20.0 ['°C'];
        attribute t2 : ISQ::TemperatureValue = 30.0 ['°C'];
        attribute maxRise : ISQ::TemperatureValue = 15.0 ['°C'];
    }
    part def AirVehicle :> Vehicle;
    part uav : AirVehicle;

    requirement def <'R-RISE'> RiseLimit {
        subject v : Vehicle;
        require constraint riseLimit { v.t2 - v.t1 <= v.maxRise }
    }

    requirement def <'R-PROSE'> ProseOnly {
        doc /* The vehicle shall be pleasant to operate. */
        subject v : Vehicle;
    }

    requirement def <'R-VMASS'> MassFloor {
        subject v : Vehicle;
        require constraint massFloor { v.mass >= 1.0 [kg] }
    }

    requirement def <'R-AMASS'> AirMassCeiling {
        subject a : AirVehicle;
        require constraint airMassCeiling { a.mass <= 25.0 [kg] }
    }

    satisfy AirMassCeiling by uav;
}

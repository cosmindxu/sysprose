package ConsistencyModes {
    doc /* The whole reason a requirement is read as `assume ⇒ require` rather
         * than as `assume ∧ require`: two requirements guarded by mutually
         * exclusive modes.
         *
         * They are NOT in conflict. No single design point is ever required to
         * meet both guarantees, because no design point is ever in both modes.
         * Read as a conjunction they come back as a conflicting subset naming
         * two guarantees that never have to hold together — a false alarm on
         * one of the commonest patterns in systems engineering, which is what
         * this model exists to keep out.
         *
         * Both requirements are individually ENGAGEABLE — each mode is
         * reachable — so this set is consistent and exits 0. */

    part def AirVehicle {
        attribute mode : ScalarValues::Real = 1.0;
        attribute mtow : ISQ::MassValue = 18.5 [kg];
    }
    part uav : AirVehicle;

    requirement def <'R-CRUISE'> CruiseMass {
        subject uav : AirVehicle;
        assume constraint cruiseMode { uav.mode == 1.0 }
        require constraint cruiseCeiling { uav.mtow <= 25.0 [kg] }
    }

    requirement def <'R-FERRY'> FerryMass {
        subject uav : AirVehicle;
        assume constraint ferryMode { uav.mode == 2.0 }
        require constraint ferryFloor { uav.mtow >= 30.0 [kg] }
    }

    satisfy CruiseMass by uav;
    satisfy FerryMass by uav;
}

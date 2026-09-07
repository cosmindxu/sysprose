package ConsistencyConflict {
    part def AirVehicle {
        attribute mtow : ISQ::MassValue = 18.5 [kg];
    }
    part uav : AirVehicle;

    requirement def <'R-UAV-002'> MassCeiling {
        subject uav : AirVehicle;
        require constraint mtowCeiling { uav.mtow <= 25.0 [kg] }
    }

    requirement def <'R-UAV-004'> MassFloor {
        subject uav : AirVehicle;
        require constraint mtowFloor { uav.mtow >= 30.0 [kg] }
    }

    satisfy MassCeiling by uav;
    satisfy MassFloor by uav;
}

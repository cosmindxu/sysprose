package P {
    part def UAV {
        attribute mtow : ISQ::MassValue = 18.5 [kg];
    }
    part uav : UAV;
    requirement def MassLimit {
        subject uav : UAV;
        require constraint { uav.mtow <= 25.0 [kg] }
    }
}

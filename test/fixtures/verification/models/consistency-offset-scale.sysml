package ConsistencyOffsetScale {
    part def Probe {
        attribute mass : ISQ::MassValue = 2.0 [kg];
        attribute t1 : ISQ::TemperatureValue = 20.0 ['°C'];
        attribute t2 : ISQ::TemperatureValue = 30.0 ['°C'];
        attribute maxRise : ISQ::TemperatureValue = 15.0 ['°C'];
    }
    part probe : Probe;

    requirement def MassCeiling {
        subject probe : Probe;
        require constraint massCeiling { probe.mass <= 1.0 [kg] }
    }

    requirement def MassFloor {
        subject probe : Probe;
        require constraint massFloor { probe.mass >= 5.0 [kg] }
    }

    requirement def RiseLimit {
        subject probe : Probe;
        require constraint riseLimit { probe.t2 - probe.t1 <= probe.maxRise }
    }

    satisfy MassCeiling by probe;
    satisfy MassFloor by probe;
    satisfy RiseLimit by probe;
}

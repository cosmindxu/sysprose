package P {
    part def Sensor {
        attribute t1 : ISQ::TemperatureValue = 293.15 [K];
        attribute t2 : ISQ::TemperatureValue = 303.15 [K];
        attribute maxRise : ISQ::TemperatureValue = 15.0 [K];
    }
    part s : Sensor;
    requirement def Rise {
        subject s : Sensor;
        require constraint { s.t2 - s.t1 <= s.maxRise }
    }
}

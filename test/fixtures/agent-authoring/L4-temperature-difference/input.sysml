package P {
    part def Sensor {
        attribute t1 : ISQ::TemperatureValue = 20.0 ['°C'];
        attribute t2 : ISQ::TemperatureValue = 30.0 ['°C'];
        attribute maxRise : ISQ::TemperatureValue = 15.0 ['°C'];
    }
    part s : Sensor;
    requirement def Rise {
        subject s : Sensor;
        require constraint { s.t2 - s.t1 <= s.maxRise }
    }
}

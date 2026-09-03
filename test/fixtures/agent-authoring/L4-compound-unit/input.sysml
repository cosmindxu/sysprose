package P {
    part def Airframe {
        attribute cruise : ISQ::SpeedValue = 25.0 [m/s];
        attribute climb : ISQ::AccelerationValue = 9.81 [m/s^2];
        attribute capacity : ISQ::EnergyValue = 640.0 ['W⋅h'];
        attribute reserve : ISQ::EnergyValue = 120.0 [SI::'watt hour'];
        attribute wing : ISQ::AreaValue = 1.5 ['m²'];
    }
}

package P {
    part def Load {
        attribute mass : ISQ::MassValue = 18.5 [SI::kg];
        attribute span : ISQ::LengthValue = 2.4 [SI::metre];
        attribute payload : ISQ::MassValue = 40.0 [USCustomaryUnits::pound];
        attribute cruise : ISQ::SpeedValue = 25.0 [SI::'metre per second'];
        attribute descent : ISQ::SpeedValue = 3.0 [m/SI::s];
    }
}

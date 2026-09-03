package P {
    part def Crate {
        attribute mass : ISQ::MassValue = 18.5 [kg];
        attribute massLimit : ISQ::MassValue = 25.0 [kg];
    }
    part crate : Crate;
    requirement def WithinMassLimit {
        subject crate : Crate;
        require constraint { crate.mass <= crate.massLimit }
    }
}

package P {
    part def Crate {
        attribute mass : ISQ::MassValue = 18.5 [kg];
        attribute massLimit : ISQ::LengthValue = 25.0 [m];
    }
    part crate : Crate;
    requirement def WithinMassLimit {
        subject crate : Crate;
        require constraint { crate.mass <= crate.massLimit }
    }
}

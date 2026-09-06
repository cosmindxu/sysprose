package InconsistentAxioms {
    part def Airframe {
        attribute mtow : ISQ::MassValue = 18.5 [kg];
    }
    part airframe : Airframe;
    requirement def MassLimit {
        doc /* Unprovable here — not because it is false, but because the
             * context it would be proved from contradicts itself. An `assert`
             * clause is a FACT the model states, and this one cannot hold
             * beside the value the same feature is bound to. */
        subject airframe : Airframe;
        assert constraint { airframe.mtow >= 30.0 [kg] }
        require constraint { airframe.mtow <= 25.0 [kg] }
    }
    satisfy MassLimit by airframe;
}

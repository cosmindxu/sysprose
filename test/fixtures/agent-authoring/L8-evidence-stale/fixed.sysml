package EvidenceStale {
    part def Airframe {
        attribute mass : ISQ::MassValue = 19.5 [kg];
    }
    part airframe : Airframe;
    requirement def MassLimit {
        doc /* The airframe shall stay within the 25 kg limit. */
        subject airframe : Airframe;
        require constraint {
            airframe.mass <= 25.0 [kg]
        }
    }
    satisfy MassLimit by airframe;
}

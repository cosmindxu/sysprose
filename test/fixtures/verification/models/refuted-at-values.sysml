package OverMass {
    part def Chassis {
        attribute mass : ISQ::MassValue = 3000.0 [kg];
    }
    part chassis : Chassis;
    requirement def MassLimit {
        doc /* The chassis shall stay within the 2000 kg limit. */
        subject chassis : Chassis;
        require constraint { chassis.mass <= 2000.0 [kg] }
    }
    satisfy MassLimit by chassis;
}

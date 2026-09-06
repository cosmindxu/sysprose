package DimClash {
    part def Chassis {
        attribute mass : ISQ::MassValue = 1500.0 [kg];
    }
    part chassis : Chassis;
    requirement def MassLimit {
        doc /* The chassis shall stay within the limit. */
        subject chassis : Chassis;
        require constraint { chassis.mass <= 2000.0 [m] }
    }
    satisfy MassLimit by chassis;
}

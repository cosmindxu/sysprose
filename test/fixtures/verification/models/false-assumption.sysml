package FalseAssumption {
    part def Tank {
        attribute mass : ISQ::MassValue = 40.0 [kg];
    }
    part tank : Tank;
    requirement def TankMassLimit {
        doc /* Guarded by a premise the model itself makes false. */
        subject tank : Tank;
        assume constraint { false }
        require constraint { tank.mass <= 50.0 [kg] }
    }
    satisfy TankMassLimit by tank;
}

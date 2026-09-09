package DerivationRefineChain {

    doc /* A `refine` chain, which the mapper stores the other way round from a
         * `derive` one: `refine requirement X by Y` makes Y the source and X
         * the target, so X is the requirement being refined and Y is the one
         * doing the refining. */

    part def Aircraft {
        attribute speed : ISQ::SpeedValue = 20.0 [m/s];
    }

    part craft : Aircraft;

    requirement def SpeedEnvelope {
        attribute id = "R-ENV-000";
        subject craft : Aircraft;
        require constraint { craft.speed <= 30.0 [m/s] }
    }

    requirement def CruiseSpeed {
        attribute id = "R-ENV-001";
        subject craft : Aircraft;
        require constraint { craft.speed <= 25.0 [m/s] }
    }

    refine requirement SpeedEnvelope by CruiseSpeed;
}

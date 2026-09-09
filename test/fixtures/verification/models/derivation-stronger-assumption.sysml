package DerivationStrongerAssumption {

    doc /* A derived requirement that assumes MORE than the requirement it was
         * derived from. It applies in fewer situations than the parent's
         * guarantee is claimed in, so the chain is not a refinement — and the
         * counterexample is a speed the parent covers and the child does not.
         *
         * The values satisfy everything the file states; a derivation
         * obligation does not read them, which is the whole difference between
         * "holds of this design" and "holds of every implementation the
         * requirements admit". */

    part def Vehicle {
        attribute mass : ISQ::MassValue = 1200.0 [kg];
        attribute speed : ISQ::SpeedValue = 8.0 [m/s];
    }

    part car : Vehicle;

    requirement def MassBudget {
        attribute id = "R-TOP-001";
        subject car : Vehicle;
        assume constraint { car.speed <= 30.0 [m/s] }
        require constraint { car.mass <= 1800.0 [kg] }
    }

    requirement def BodyMass {
        attribute id = "R-DER-001";
        subject car : Vehicle;
        assume constraint { car.speed <= 10.0 [m/s] }
        require constraint { car.mass <= 1500.0 [kg] }
    }

    derive requirement BodyMass from MassBudget;
}

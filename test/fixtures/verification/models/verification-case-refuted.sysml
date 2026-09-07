package VerificationCaseRefuted {

    doc /* A verification case over a requirement the model refutes: 3000 kg
         * against a 2000 kg limit, with the case declaring `analyze` so the
         * method gate lets it through. The case verdict is `fail`, which is the
         * one thing in this lane that is exit 1, and the row under it carries
         * the witness the refutation was read at. */

    part def Chassis {
        attribute mass : ISQ::MassValue = 3000.0 [kg];
    }

    part chassis : Chassis;

    requirement def MassLimit {
        attribute id = "R-MASS";
        subject chassis : Chassis;
        require constraint { chassis.mass <= 2000.0 [kg] }
    }

    verification massAnalysis {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod {
            attribute kind = analyze;
        }
        objective {
            verify MassLimit;
        }
    }

    satisfy MassLimit by chassis;
}

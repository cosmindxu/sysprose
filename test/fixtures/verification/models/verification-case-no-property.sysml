package VerificationCaseNoProperty {

    doc /* Three cases with nothing to check, in the three shapes that answer
         * differently. `emptyCase` names no requirement at all and `partWatch`
         * points its `verify` at a part rather than at a requirement: both are
         * `verification/no-property`, because a case that checked nothing has
         * not passed. `proseWatch` is the near miss — it names a real
         * requirement, and that requirement carries prose and no constraint
         * body, so the obligations lane raises the row and reports it as
         * `verification/unsupported-construct`; the case is judged and
         * inconclusive rather than propertyless, because there WAS a property
         * to look for and looking for it is what failed. All three declare
         * `analyze`, so nothing here is a method problem. */

    part def Chassis {
        attribute mass : ISQ::MassValue = 18.5 [kg];
    }

    part chassis : Chassis;

    requirement def Appearance {
        attribute id = "R-LOOK";
        doc /* The chassis shall present a finished appearance. */
        subject chassis : Chassis;
    }

    verification proseWatch {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod {
            attribute kind = analyze;
        }
        objective {
            verify Appearance;
        }
    }

    verification partWatch {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod {
            attribute kind = analyze;
        }
        objective {
            verify chassis;
        }
    }

    verification emptyCase {
        subject chassis : Chassis;
        @VerificationCases::VerificationMethod {
            attribute kind = analyze;
        }
    }

    satisfy Appearance by chassis;
}

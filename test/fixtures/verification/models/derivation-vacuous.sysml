package DerivationVacuous {

    doc /* STEP (0), ONE LEVEL DOWN. The parent applies only below 5 kg and the
         * derived requirement demands at least 10 kg, so the antecedent of both
         * derivation obligations is unsatisfiable — and a contradiction entails
         * every obligation over it. "Derivation refines" here would be a verdict
         * about nothing, which is the sentence §3.6's step (0) exists to
         * prevent: this chain is `verification/contract-set-vacuous`, exit 2,
         * and no flag lowers it. */

    part def Rig { attribute m : ISQ::MassValue = 3.0 [kg]; }

    part rig : Rig;

    requirement def Parent {
        attribute id = "R-DV-000";
        subject rig : Rig;
        assume constraint { rig.m <= 5.0 [kg] }
        require constraint { rig.m <= 25.0 [kg] }
    }

    requirement def Child {
        attribute id = "R-DV-001";
        subject rig : Rig;
        require constraint { rig.m >= 10.0 [kg] }
    }

    derive requirement Child from Parent;
}

package DerivationConjoins {

    doc /* Two derived requirements that conjoin to imply the one they were
         * derived from: neither bound alone entails the total, and the two
         * together do. The same file read the other way up does not. */

    part def Rig {
        attribute massBody : ISQ::MassValue = 16.0 [kg];
        attribute massPack : ISQ::MassValue = 6.0 [kg];
    }

    part rig : Rig;

    requirement def TotalMass {
        attribute id = "R-RIG-000";
        subject rig : Rig;
        require constraint { rig.massBody + rig.massPack <= 25.0 [kg] }
    }

    requirement def BodyMass {
        attribute id = "R-RIG-001";
        subject rig : Rig;
        require constraint { rig.massBody <= 18.0 [kg] }
    }

    requirement def PackMass {
        attribute id = "R-RIG-002";
        subject rig : Rig;
        require constraint { rig.massPack <= 7.0 [kg] }
    }

    derive requirement BodyMass from TotalMass;
    derive requirement PackMass from TotalMass;
}

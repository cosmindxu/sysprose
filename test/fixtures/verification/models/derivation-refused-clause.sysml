package DerivationRefusedClause {

    doc /* A CLAUSE A GATE REFUSED, ON A DERIVED REQUIREMENT — the two halves of
         * `nf(C_D)` again, and they do not move in the same direction.
         *
         *  - As shipped, `PackMass` states a second `require` this lane cannot
         *    encode (a string comparison). A dropped conjunct of `G` makes
         *    `nf(C_D) = ¬A ∨ G` WEAKER, and a weaker premise is implied by the
         *    real one — so asserting it proves the composition obligation from
         *    LESS than the file states, which is sound and merely harder. The
         *    chain refines, and the refusal is listed on the row.
         *
         *  - The L8 case rewrites that clause as an `assume` and the answer
         *    changes: a dropped conjunct of `A` STRENGTHENS `nf(C_D)`, and with
         *    the only `assume` gone it collapses to a bare `G` — the axiom
         *    "this requirement holds unconditionally", which this file does not
         *    state. So the child is kept OUT of the premise set, files its own
         *    undecided row, and the composition row over the remaining premise
         *    alone is never published as a REFUTATION: the very clause that was
         *    dropped may exclude the design point it found.
         *
         * Withholding the child in BOTH directions was the defect this file
         * pins: it turned a chain that refines into exit 1 with a confirmed
         * witness at `massPack = 8`, a design `PackMass` forbids. */

    part def Rig {
        attribute massBody : ISQ::MassValue = 16.0 [kg];
        attribute massPack : ISQ::MassValue = 6.0 [kg];
        attribute mode : String = "auto";
    }

    part rig : Rig;

    requirement def TotalMass {
        attribute id = "R-DRC-000";
        subject rig : Rig;
        require constraint { rig.massBody + rig.massPack <= 25.0 [kg] }
    }

    requirement def BodyMass {
        attribute id = "R-DRC-001";
        subject rig : Rig;
        require constraint { rig.massBody <= 18.0 [kg] }
    }

    requirement def PackMass {
        attribute id = "R-DRC-002";
        subject rig : Rig;
        // The clause that closes the budget — encodable.
        require constraint { rig.massPack <= 7.0 [kg] }
        // A SECOND clause of the SAME requirement the lane refuses.
        require constraint { rig.mode == "auto" }
    }

    derive requirement BodyMass from TotalMass;
    derive requirement PackMass from TotalMass;
}

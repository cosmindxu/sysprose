package RefinementContradictorySiblings {

    doc /* The vacuity case, and the reason step (0) runs before every
         * obligation: C₁ = ⟨true, x > 10⟩ and C₂ = ⟨true, x < 5⟩ over ONE bind
         * class, against a system contract ⟨true, x > 1000000⟩.
         *
         * The antecedent of obligation (3) — `nf(C₁) ∧ nf(C₂) ∧ γ` — is
         * unsatisfiable, so (3) holds vacuously and a checker without step (0)
         * prints "obligation (3) proved" for an architecture whose components
         * cannot coexist and whose system guarantee is absurd. This one reports
         * `verification/contract-set-vacuous`, exit 2, and never `refined`.
         *
         * The two levels hold the SAME value so the binding is satisfied at the
         * design point: the contradiction this case is about is between the
         * CONTRACTS, not between the model's own facts. */

    part def HighSide {
        attribute level : Real = 12.0;
    }

    part def LowSide {
        attribute level : Real = 12.0;
    }

    part def Rack {
        part high : HighSide;
        part low : LowSide;
        bind HighSide::level = LowSide::level;
    }

    requirement def RackLevel {
        attribute id = "R-CS-000";
        subject sys : Rack;
        require constraint { sys.high.level > 1000000.0 }
    }

    requirement def HighLevel {
        attribute id = "R-CS-001";
        subject h : HighSide;
        require constraint { h.level > 10.0 }
    }

    requirement def LowLevel {
        attribute id = "R-CS-002";
        subject l : LowSide;
        require constraint { l.level < 5.0 }
    }

    satisfy RackLevel by Rack;
    satisfy HighLevel by Rack::high;
    satisfy LowLevel by Rack::low;
}

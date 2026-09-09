package BoundsRefusedAxiom {

    doc /* AN AXIOM A GATE REFUSED IS AN AXIOM THE BOUND WAS NOT COMPUTED OVER,
         * and whether that matters depends entirely on whether the objective can
         * REACH it. Two tanks, sharing nothing:
         *
         *  - `TankA::level` is bounded by `capA` alone, and the only refusal in
         *    the file reads neither of its symbols. That refusal factorises — an
         *    assignment satisfying it can always be pasted onto one satisfying
         *    A's own closure — so it cannot move the bound, and the row is
         *    decided with the refusal merely listed.
         *
         *  - `TankB::depth` is bounded by `capB`, which is the refused one. The
         *    bound over what is left is LOOSER than the model's, and publishing
         *    it as "the tightest value" — or, once the value axiom is released,
         *    as "unbounded above" over a file that plainly states a 9 m ceiling
         *    — is the sentence §3.7 forbids. That row is stood down. */

    part def TankA {
        attribute level : ISQ::LengthValue = 1.0 [m];
        assert constraint capA { level <= 3.0 [m] }
    }

    part def TankB {
        attribute mode : String = "auto";
        attribute depth : ISQ::LengthValue = 1.0 [m];
        // Refused: one operand is a string, so the whole conjunction — the 9 m
        // ceiling included — is not asserted.
        assert constraint capB { depth <= 9.0 [m] and mode == "auto" }
    }

    part a : TankA;
    part b : TankB;
}

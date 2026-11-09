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
         *  - `TankB::depth` is bounded by `capB`, whose second conjunct is the
         *    refused one, and it reads `depth`. The bound over what is left is
         *    LOOSER than the model's (the 3 m ceiling of the manual mode is
         *    gone), and publishing it as "the tightest value" is the sentence
         *    §3.7 forbids. That row is stood down. */

    part def TankA {
        attribute level : ISQ::LengthValue = 1.0 [m];
        assert constraint capA { level <= 3.0 [m] }
    }

    part def TankB {
        attribute mode : String = "auto";
        attribute depth : ISQ::LengthValue = 1.0 [m];
        // Read as its two conjuncts (a5 K2): the 9 m ceiling is asserted, and the
        // second is refused — one operand is a string — though it reads `depth`.
        assert constraint capB { depth <= 9.0 [m] and (mode == "auto" or depth <= 3.0 [m]) }
    }

    part a : TankA;
    part b : TankB;
}

package ThreeReasons {

    doc /* Three sufficient reasons for one requirement, so the unsat core has
         * to CHOOSE — and the fixture is about which one it chooses.
         *
         * `mtow` is bound at 18.5 kg and capped twice, at 20 and at 22, and the
         * requirement asks for 25. Any one of the three facts settles it. The
         * core z3 returns names `mtowCapB` — the WEAKEST of the three — and does
         * not name the model's own value at all, which is the measurement this
         * file exists to keep: an axiom absent from a core may still carry the
         * claim, and the tool must never print a core as "the axioms this proof
         * depends on".
         *
         * The declaration order of the two caps was swapped and the pick did not
         * move, so it is not an ordering artefact. */

    part def Airframe {
        attribute mtow : ISQ::MassValue = 18.5 [kg];
    }

    part airframe : Airframe;

    requirement def MassLimit {
        attribute id = "R-3R-001";
        doc /* Provable three ways over: from the value, from either cap. */
        subject airframe : Airframe;
        assert constraint mtowCapA { airframe.mtow <= 20.0 [kg] }
        assert constraint mtowCapB { airframe.mtow <= 22.0 [kg] }
        require constraint { airframe.mtow <= 25.0 [kg] }
    }

    satisfy MassLimit by airframe;
}

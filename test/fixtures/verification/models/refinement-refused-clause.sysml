package RefinementRefusedClause {

    doc /* A CLAUSE A GATE REFUSED, ON BOTH SIDES OF THE OBLIGATION.
         *
         * `refine` drops a relation it cannot encode and says so, and whether
         * that is safe depends entirely on WHERE the relation sat. This file
         * states the two places, one decomposition each, so the two directions
         * are known answers rather than an argument:
         *
         *  - `SystemSideTop` states a guarantee this lane cannot encode (a
         *    remainder). It is the GOAL of obligation (3), and a goal that lost
         *    a conjunct is weaker, hence easier to entail — so the whole
         *    decomposition stands down as `verification/refinement-undecided`
         *    and no obligation over it is claimed.
         *
         *  - `ComponentSideMotor` states an `assume` this lane cannot encode.
         *    Its normal form `nf(C′) = ¬A ∨ G` is a PREMISE, and dropping a
         *    conjunct of `A` STRENGTHENS it: `¬(a₁ ∧ a₂)` is `¬a₁ ∨ ¬a₂`, and
         *    with the only `assume` gone the normal form collapses to a bare
         *    `G` — the axiom "this component promises its guarantee
         *    unconditionally", which this file does not state. Read that way,
         *    obligation (3) is provable from the bus alone and the run exits 0
         *    on an axiom nobody wrote. So the contract is kept OUT of the
         *    premise set and its own obligation (4) is undecided, which stands
         *    the group down.
         *
         * The two rigs are typed by four separate definitions on purpose: a
         * constraint body reaches a quantity through the TYPE of each part, so
         * sharing one would put both decompositions on one symbol. */

    part def BusA { attribute volts : Real = 24.0; }
    part def MotorA { attribute volts : Real = 24.0; attribute cycles : Real = 4.0; }

    part def SystemSideRig {
        part bus : BusA;
        part motor : MotorA;
    }

    requirement def SystemSideTop {
        attribute id = "R-RC-000";
        doc /* The second clause is the refused one: `%` has no encoding in this
             * fragment, and this contract is the GOAL. */
        subject sys : SystemSideRig;
        require constraint { sys.bus.volts >= 20.0 }
        require constraint { sys.motor.cycles % 2.0 == 0.0 }
    }

    requirement def SystemSideBus {
        attribute id = "R-RC-001";
        subject b : BusA;
        require constraint { b.volts >= 22.0 }
    }

    requirement def SystemSideMotor {
        attribute id = "R-RC-002";
        subject m : MotorA;
        require constraint { m.cycles >= 0.0 }
    }

    part def BusB { attribute volts : Real = 24.0; }
    part def MotorB { attribute volts : Real = 24.0; attribute cycles : Real = 4.0; }

    part def ComponentSideRig {
        part bus : BusB;
        part motor : MotorB;
    }

    requirement def ComponentSideTop {
        attribute id = "R-RC-003";
        doc /* Provable from the bus contract alone — which is the point: the
             * motor's refused `assume` is the ONLY thing standing this
             * decomposition down, so a build that read it as unconditional
             * would report `refined` and exit 0. */
        subject sys : ComponentSideRig;
        require constraint { sys.bus.volts >= 20.0 }
    }

    requirement def ComponentSideBus {
        attribute id = "R-RC-004";
        subject b : BusB;
        require constraint { b.volts >= 22.0 }
    }

    requirement def ComponentSideMotor {
        attribute id = "R-RC-005";
        doc /* Its only `assume` is a remainder, which no gate here encodes. */
        subject m : MotorB;
        assume constraint { m.cycles % 2.0 == 0.0 }
        require constraint { m.volts >= 22.0 }
    }

    satisfy SystemSideTop by SystemSideRig;
    satisfy SystemSideBus by SystemSideRig::bus;
    satisfy SystemSideMotor by SystemSideRig::motor;

    satisfy ComponentSideTop by ComponentSideRig;
    satisfy ComponentSideBus by ComponentSideRig::bus;
    satisfy ComponentSideMotor by ComponentSideRig::motor;
}

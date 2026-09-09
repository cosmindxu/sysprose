package BoundsAssume {

    doc /* AN `assume` IS NOT AN AXIOM EITHER, and the two halves of that rule
         * are both stated here.
         *
         * `HeavyPayload` applies only where the payload is at least 5 kg. Its
         * `assume` is requirement CONTEXT — the guard the requirement holds
         * under — and not a fact about the design, so it constrains no bound
         * this command takes: `max emptyMass --free all` is unbounded, because
         * nothing outside a requirement bounds it.
         *
         * Under `--with-requirements` the requirement is folded in as the
         * implication the shipped library says it IS, `assume ⇒ require`, and
         * the antecedent is what makes the answer 23 rather than 20: a design
         * carrying 2 kg escapes `HeavyPayload` entirely and is held only by the
         * 25 kg total. A build that folded the `assume` into the AXIOM set, or
         * that asserted the guarantee without its antecedent, would answer 20 —
         * a tighter bound than the file states, which is the direction that
         * cannot be forgiven. */

    part def AirVehicle {
        attribute emptyMass : ISQ::MassValue = 12.5 [kg];
        attribute payload : ISQ::MassValue = 6.0 [kg];
        attribute mtow : ISQ::MassValue = emptyMass + payload;

        assert constraint payloadRange { payload >= 2.0 [kg] and payload <= 6.0 [kg] }
    }

    part uav : AirVehicle;

    requirement def MassRequirement {
        attribute id = "R-BA-001";
        doc /* Unconditional: the class boundary holds for every design. */
        subject uav : AirVehicle;
        require constraint { uav.mtow <= 25.0 [kg] }
    }

    requirement def HeavyPayload {
        attribute id = "R-BA-002";
        doc /* Conditional: a structural limit that applies only under a heavy
             * payload, and says nothing at all about a light one. */
        subject uav : AirVehicle;
        assume constraint { uav.payload >= 5.0 [kg] }
        require constraint { uav.emptyMass <= 20.0 [kg] }
    }

    satisfy MassRequirement by uav;
    satisfy HeavyPayload by uav;
}

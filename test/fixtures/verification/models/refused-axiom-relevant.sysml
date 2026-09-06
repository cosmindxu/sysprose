package RefusedAxiomRelevant {
    part def Bus {
        attribute seats : ScalarValues::Integer = 30;
        attribute mass : ISQ::MassValue = 3000.0 [kg];
        doc /* `massPerSeat` is refused by the gates AND reads `mass`, which is
             * the very symbol the requirement below constrains. A relation the
             * proof context dropped may be the one that excludes the witness,
             * so the counterexample is reported as undecided with the refused
             * relation named — never as a violation. */
        attribute massPerSeat : ISQ::MassValue = mass % seats;
    }
    part bus : Bus;
    requirement def MassLimit {
        doc /* The bus shall stay within the 2000 kg limit. */
        subject bus : Bus;
        require constraint { bus.mass <= 2000.0 [kg] }
    }
    satisfy MassLimit by bus;
}

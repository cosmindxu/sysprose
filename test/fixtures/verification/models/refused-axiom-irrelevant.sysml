package RefusedAxiomIrrelevant {
    part def Bus {
        attribute seats : ScalarValues::Integer = 30;
        doc /* `parity` is refused by the gates — `%` has no encoding in this
             * fragment — and it shares no symbol with the requirement below.
             * A refusal that cannot possibly exclude the counterexample must
             * not suppress it: reading the RUN-level refused set here made one
             * unencodable feature value anywhere in a file downgrade every
             * refutation in it to inconclusive. */
        attribute parity : ScalarValues::Integer = seats % 2;
        attribute mass : ISQ::MassValue = 3000.0 [kg];
    }
    part bus : Bus;
    requirement def MassLimit {
        doc /* The bus shall stay within the 2000 kg limit. */
        subject bus : Bus;
        require constraint { bus.mass <= 2000.0 [kg] }
    }
    satisfy MassLimit by bus;
}

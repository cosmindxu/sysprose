package OddSeating {
    part def Bus {
        doc /* Thirteen seats: the sibling of `gate-refused-but-true`, and the
             * half that was missing. `%` has no encoding in this fragment, so
             * the SMT gates refuse the relation — but the numeric surface
             * evaluates it perfectly well and reads it FALSE, and a
             * requirement that is false at the values the model states is a
             * violation whichever engine reads it. Reported `unsupported`, it
             * sat inside `--allow-inconclusive`'s scope and made the DEFAULT
             * invocation exit 0 over it. */
        attribute seats : ScalarValues::Integer = 13;
    }
    part bus : Bus;
    requirement def EvenSeats {
        doc /* The bus shall seat an even number of passengers. */
        subject bus : Bus;
        require constraint { bus.seats % 2 == 0 }
    }
    satisfy EvenSeats by bus;
}

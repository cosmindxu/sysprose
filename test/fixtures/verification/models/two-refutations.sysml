package TwoRefutations {
    part def Bus {
        attribute seats : ScalarValues::Integer = 30;
        attribute mass : ISQ::MassValue = 3000.0 [kg];
    }
    part bus : Bus;
    // A plain `constraint` states a claim with no clause role, so it is an
    // OBLIGATION and not an axiom. That distinction is the whole case: an
    // engine that read a false claim as a fact would report the axiom set
    // inconsistent and decide nothing, which is a run that proves nothing and
    // says nothing about the two things that are actually wrong here.
    constraint enoughSeats { bus.seats >= 40 }
    requirement def MassLimit {
        doc /* The bus shall stay within the 2000 kg limit. */
        subject bus : Bus;
        require constraint { bus.mass <= 2000.0 [kg] }
    }
    satisfy MassLimit by bus;
}

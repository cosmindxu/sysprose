package EvenSeating {
    part def Bus {
        attribute seats : ScalarValues::Integer = 12;
    }
    part bus : Bus;
    requirement def EvenSeats {
        doc /* The bus shall seat an even number of passengers. */
        subject bus : Bus;
        require constraint { bus.seats % 2 == 0 }
    }
    satisfy EvenSeats by bus;
}

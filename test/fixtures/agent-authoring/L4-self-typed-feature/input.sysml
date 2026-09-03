package P {
    item def Person {
        attribute age : ScalarValues::Natural;
        timeslice asPresident : Person;
    }

    item def Country {
        ref p : Person;
    }

    item def US :> Country {
        ref q :>> p {
            assert constraint { age >= 35 }
        }
    }
}

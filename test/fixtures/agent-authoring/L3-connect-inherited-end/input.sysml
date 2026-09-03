package P {
    part x;
    part def Base {
        part x;
    }
    part def Car :> Base {
        part a;
        connect a to x;
    }
}

package P {
    part def Base {
        part w;
    }
    part def Car :> Base {
        part w :>> w;
    }
}

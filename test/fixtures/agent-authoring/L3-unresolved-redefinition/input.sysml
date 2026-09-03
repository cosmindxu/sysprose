package P {
    part def Base {
        part wheel;
    }
    part def Car :> Base {
        part w2 :>> w;
    }
}

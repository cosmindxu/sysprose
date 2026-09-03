package P {
    part def Base {
        part def W;
    }
    part def Car :> Base {
        part w1 : W;
    }
    part def W;
}

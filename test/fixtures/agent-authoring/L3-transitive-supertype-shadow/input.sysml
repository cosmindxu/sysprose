package P {
    part def W;
    part def Base :> Grand;
    part def Car :> Base {
        part w1 : W;
    }
    part def Grand {
        part def W;
    }
}

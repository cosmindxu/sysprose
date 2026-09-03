package P {
    part def Base {
        part def Inner;
    }
    part def D :> Base {
        part def Sub :> Inner;
    }
}

package P {
    part def Base {
        part def Inner;
    }
    part def Derived :> Base {
        part i : Inner;
    }
}

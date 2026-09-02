package P {
    port def PowerPort;
    port def DataPort;
    part def A { out port pwr : PowerPort; }
    part def B { in port data : DataPort; in port pwrIn : PowerPort; }
    part def Sys {
        part a : A;
        part b : B;
        connection c connect a.pwr to b.pwrIn;
    }
    part s : Sys;
}

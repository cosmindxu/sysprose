package P {
    port def Pt;
    part def A { port p : Pt; }
    part a : A;
    part b : A;
    connection c connect a.p to b.p;
}

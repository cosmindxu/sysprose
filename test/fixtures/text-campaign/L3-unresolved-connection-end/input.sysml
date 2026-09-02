package P {
    port def Pt;
    part def A { port p : Pt; }
    part a : A;
    connection c connect a.p to nope.missing;
}

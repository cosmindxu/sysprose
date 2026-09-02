package P {
    port def Pt;
    part def A { out port o : Pt; }
    part def B { out port o2 : Pt; in port i : Pt; }
    part def Sys {
        part a : A;
        part b : B;
        connection c connect a.o to b.i;
    }
    part s : Sys;
}

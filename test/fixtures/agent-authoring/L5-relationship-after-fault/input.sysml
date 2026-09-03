package Q {
    part def W;
}

package P {
    blok bad;
    import Q::*;
    part a;
    subset b subsets a;
    part b : W;
}

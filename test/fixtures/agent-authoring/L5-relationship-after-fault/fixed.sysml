package Q {
    part def W;
}

package P {
    part bad;
    import Q::*;
    part a;
    subset b subsets a;
    part b : W;
}

package Lib {
    part x;
    part y;
}

package P {
    import Lib::*;
    connect x to y;
}

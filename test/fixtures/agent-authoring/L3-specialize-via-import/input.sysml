package Lib {
    part def Widget;
}
package Use {
    import Lib::*;
    part def W2 :> Widget;
}

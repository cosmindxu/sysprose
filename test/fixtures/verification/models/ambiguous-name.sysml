package AmbiguousName {
    doc /* Two features called `mass`, in two definitions. `idScopeFor`'s bare
         * name entry is FIRST-WINS by design — the resolution a relation body
         * gets — so `--free mass` silently released whichever the model walk
         * reached first, and the verdict was printed under a bound that named
         * one feature while the other stayed pinned. `--free` documents itself
         * as taking "a feature name unique in scope", and uniqueness is a
         * promise the resolver has to be able to CHECK. */
    part def Wing {
        attribute mass : ISQ::MassValue = 3.0 [kg];
    }
    part def Fuselage {
        attribute mass : ISQ::MassValue = 4.0 [kg];
    }
    part wing : Wing;
    part fuselage : Fuselage;
    requirement def WingMassLimit {
        doc /* The wing shall stay within 10 kg. */
        subject wing : Wing;
        require constraint { wing.mass <= 10.0 [kg] }
    }
    requirement def FuselageMassLimit {
        doc /* The fuselage shall stay within 10 kg. */
        subject fuselage : Fuselage;
        require constraint { fuselage.mass <= 10.0 [kg] }
    }
    satisfy WingMassLimit by wing;
    satisfy FuselageMassLimit by fuselage;
}

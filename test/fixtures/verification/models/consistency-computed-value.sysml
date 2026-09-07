package ConsistencyComputedValue {
    doc /* A stated value that is not a bare numeral.
         *
         * The mapper keeps `= 10.0` as a number and every other value
         * expression as verbatim source text, so `= 2.0 * 5.0` and `= -(30.0)`
         * arrive in a different shape from the number they state. Releasing on
         * the STORAGE FORM would pin these two and release the plain numeral,
         * and this requirement set — which any design satisfies once `k` is
         * free — would come back inconsistent, an error and exit 1, purely
         * because of how the value was spelled.
         *
         * Both features are closed: they read nothing but themselves, so both
         * are stated values and both are released. */

    part def Craft {
        attribute k : ScalarValues::Real = 2.0 * 5.0;
        attribute j : ScalarValues::Real = -(30.0);
    }
    part craft : Craft;

    requirement def <'R-K1'> KFloor {
        subject craft : Craft;
        require constraint kFloor { craft.k >= 20.0 }
    }

    requirement def <'R-K2'> KCeiling {
        subject craft : Craft;
        require constraint kCeiling { craft.k <= 100.0 }
    }

    requirement def <'R-J1'> JFloor {
        subject craft : Craft;
        require constraint jFloor { craft.j >= 0.0 }
    }

    satisfy KFloor by craft;
    satisfy KCeiling by craft;
    satisfy JFloor by craft;
}

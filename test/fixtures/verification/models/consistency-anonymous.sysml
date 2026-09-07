package ConsistencyAnonymous {
    doc /* Two anonymous clauses of ONE requirement, which is how most of this
         * corpus is written and the shape in which a core can name nothing.
         *
         * An anonymous `require constraint` has no name of its own, so both
         * members of this conflicting subset render as
         * `R-ANON::«ConstraintUsage»` and the one sentence that must name the
         * subset would print the same name twice. The relation itself is what
         * separates them. */

    part def Craft {
        attribute mass : ISQ::MassValue = 18.5 [kg];
    }
    part craft : Craft;

    requirement def <'R-ANON'> MassBand {
        subject craft : Craft;
        require constraint { craft.mass <= 25.0 [kg] }
        require constraint { craft.mass >= 30.0 [kg] }
    }

    satisfy MassBand by craft;
}

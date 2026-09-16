package MissionDag {
    /*
     * A straight line with no way back: every run ends where it ends.
     *
     * `takeoff -> cruise -> landed`, completion-driven, no guard, no trigger,
     * no cycle. Against `absence (state landed)` the violation is not one run
     * among several — it is where every run goes — and the modality has to
     * say `guaranteed` here rather than hedge. `landed` has no way out, so it
     * is also a reachable configuration nothing leaves, which is a fact about
     * the machine and not a defect in the fixture.
     */
    part def Mission {
        state def Modes {
            state takeoff;
            state cruise;
            state landed;
            transition takeoff then cruise;
            transition cruise then landed;
        }
    }
}

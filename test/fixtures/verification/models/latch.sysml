package Latch {
    /*
     * The one machine in this tree that names an event.
     *
     * Every other model here is made of completion transitions, so
     * `bounds.alphabet` is `[]` everywhere and the exactness gate's
     * named-trigger clause is satisfied by accident rather than by test. This
     * file makes it a measurement: `unlatch` is a trigger the walk offers at
     * every configuration and nothing in this engine establishes that an
     * environment would ever supply it, which is exactly what that clause
     * refuses to publish an increasing claim over.
     */
    part def Latch {
        state def Modes {
            state nominal;
            state locked;
            transition nominal then locked;
            transition locked accept unlatch then nominal;
        }
    }
}

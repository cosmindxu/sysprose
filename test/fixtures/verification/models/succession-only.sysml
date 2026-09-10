package SuccOnly {
    /*
     * The machine that owns NO `TransitionUsage` at all, and the honest answer
     * it has always been given.
     *
     * `stateMachinesIn` reads "an element that directly owns a TransitionUsage",
     * so this state definition is not one of this tool's machines: `reach`
     * reports that the file declares no such element and walks nothing. That is
     * an answer about what was looked for, not an absence claim about a graph —
     * no state is called unreachable here, no edge dead, and the word
     * `exhaustive` is never printed. It is kept as a fixture because widening
     * the step relation to follow successions must not quietly change it into a
     * machine that IS walked without the machine census, the analytics surface
     * and the documented reading of `reach` moving with it.
     */
    part def Ctrl {
        state def Modes {
            state idle;
            state active;
            first idle then active;
        }
    }
}

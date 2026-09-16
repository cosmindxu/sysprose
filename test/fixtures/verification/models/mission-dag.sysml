package MissionDag {
    /*
     * A chain into an ending, and nothing else.
     *
     * Four states in a line, and the last of them steps into `done` — the
     * notation's own way to end a machine, which the mapper reads as a terminal
     * control node. Every configuration here is its own component, and the one
     * nothing leaves is the ending: a set of configurations nothing leaves is
     * only a finding when the machine was not MEANT to stop there, so the
     * bottom component this walk finds is exempted as an ending and no trap is
     * reported.
     *
     * The `done` node is the only ending, and it is spelled as a control node
     * and not as a state, deliberately: the ending exemption reads the node
     * kind, and a STATE named `done` is a state like any other.
     */
    part def Mission {
        state def Phases {
            state preflight;
            state climb;
            state cruise;
            state landed;
            done finished;
            transition preflight then climb;
            transition climb then cruise;
            transition cruise then landed;
            transition landed then finished;
        }
    }
}

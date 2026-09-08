package RefinementSiblingShortfall {

    doc /* THE TWO WAYS AN ASSUMPTION GOES UNDISCHARGED, side by side, because
         * their fixes are different and the codes must not be swapped.
         *
         *  - `NodeAssumes` wants 10 and its sibling `NodePromises` guarantees
         *    1, over the very same quantity. Nothing is missing from the wiring
         *    — the two contracts already talk about one symbol — so no `bind`
         *    can repair it: it is `verification/refinement-failed`, "its
         *    siblings do not guarantee what it assumes". Deciding this from γ
         *    alone would file a pure DESIGN shortfall under a wiring hint, with
         *    a witness printed beside it showing the quantity constrained.
         *  - `LoneAssumes` wants something no contract in the group and no
         *    equality mentions at all. That IS the wiring problem, and it is
         *    `verification/unconnected-assumption`.
         *
         * THE WITNESS GATE IS ALSO PINNED HERE, on the shape that used to defeat
         * it. When the solver refutes `NodeAssumes`'s obligation (4) it may
         * satisfy `LoneAssumes`'s premise `¬A ∨ G` through `¬A` alone, and then
         * assigns nothing to the symbols of that `G`. A gate that read the
         * guarantee first and called the point unreadable would degrade a
         * genuine refutation to `verification/not-evaluable` — a code
         * `--allow-inconclusive` does not lower — and the command's headline
         * finding would vanish.
         *
         * `a` and `b` are both typed `Node` on purpose: a constraint body
         * reaches a quantity through the TYPE of each part, so the two
         * contracts are about one symbol without any connector saying so. That
         * is the only way this file states a shared quantity, and it is the
         * behaviour `docs/CONFORMANCE.md` §8.3c already pins. */

    part def Node { attribute level : Real = 5.0; }
    part def Isolated { attribute spare : Real = 5.0; attribute delivered : Real = 5.0; }

    part def Rig {
        part a : Node;
        part b : Node;
        part lone : Isolated;
    }

    requirement def RigTop {
        attribute id = "R-SS-000";
        subject s : Rig;
        require constraint { s.a.level >= 0.0 }
    }

    requirement def NodeAssumes {
        attribute id = "R-SS-001";
        doc /* Assumes 10 of a quantity its sibling bounds at 1: a shortfall,
             * not a missing wire. */
        subject n : Node;
        assume constraint { n.level >= 10.0 }
        require constraint { n.level >= 0.0 }
    }

    requirement def NodePromises {
        attribute id = "R-SS-002";
        subject m : Node;
        require constraint { m.level >= 1.0 }
    }

    requirement def LoneAssumes {
        attribute id = "R-SS-003";
        doc /* Assumes a quantity nothing else in the decomposition mentions,
             * and no equality reaches: that is the wiring problem. */
        subject l : Isolated;
        assume constraint { l.spare >= 10.0 }
        require constraint { l.delivered >= 0.0 }
    }

    satisfy RigTop by Rig;
    satisfy NodeAssumes by Rig::a;
    satisfy NodePromises by Rig::b;
    satisfy LoneAssumes by Rig::lone;
}

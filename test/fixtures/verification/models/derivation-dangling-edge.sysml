package DerivationDanglingEdge {

    doc /* A `derive` EDGE WHOSE OTHER END IS A PART. It states no obligation
         * over two contracts, so this lane forms no chain from it — and a run
         * that reported only its chains would then tell the reader "this model
         * states no `derive` chain at all", which is false about a file that
         * plainly writes one. The edge is COUNTED instead, so the sentence can
         * be true. */

    part def Rig { attribute m : ISQ::MassValue = 1.0 [kg]; }

    part rig : Rig;

    requirement def Child {
        attribute id = "R-DDE-001";
        subject rig : Rig;
        require constraint { rig.m <= 2.0 [kg] }
    }

    derive requirement Child from rig;
}

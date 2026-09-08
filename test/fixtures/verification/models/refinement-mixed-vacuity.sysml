package RefinementMixedVacuity {

    doc /* Two decompositions in one file: one that refines, and one whose
         * sub-contracts cannot hold together.
         *
         * It exists because a vacuity beside a proof is where the exit contract
         * is easiest to get wrong. A vacuous decomposition is NOT an
         * `inconclusive` one in this report's arithmetic — it has its own count
         * — so an exit rule that only subtracted the forgiven inconclusives
         * from the undecided total would return 0 here, laundering the vacuity
         * behind the refinement beside it. §2's rule is one claim word and one
         * exit code: a vacuity is exit 2, always, and no flag lowers it. */

    part def Supply {
        attribute level : Real = 12.0;
    }

    part def Sink {
        attribute level : Real = 12.0;
    }

    part def GoodRig {
        part supply : Supply;
        part sink : Sink;
        bind Supply::level = Sink::level;
    }

    requirement def GoodTop {
        attribute id = "R-MX-000";
        subject sys : GoodRig;
        require constraint { sys.sink.level >= 1.0 }
    }

    requirement def GoodSupply {
        attribute id = "R-MX-001";
        subject s : Supply;
        require constraint { s.level >= 10.0 }
    }

    requirement def GoodSink {
        attribute id = "R-MX-002";
        subject k : Sink;
        require constraint { k.level >= 2.0 }
    }

    part def HighSide {
        attribute level : Real = 12.0;
    }

    part def LowSide {
        attribute level : Real = 12.0;
    }

    part def BadRig {
        part high : HighSide;
        part low : LowSide;
        bind HighSide::level = LowSide::level;
    }

    requirement def BadTop {
        attribute id = "R-MX-003";
        subject sys : BadRig;
        require constraint { sys.high.level > 1000000.0 }
    }

    requirement def BadHigh {
        attribute id = "R-MX-004";
        subject h : HighSide;
        require constraint { h.level > 10.0 }
    }

    requirement def BadLow {
        attribute id = "R-MX-005";
        subject l : LowSide;
        require constraint { l.level < 5.0 }
    }

    satisfy GoodTop by GoodRig;
    satisfy GoodSupply by GoodRig::supply;
    satisfy GoodSink by GoodRig::sink;

    satisfy BadTop by BadRig;
    satisfy BadHigh by BadRig::high;
    satisfy BadLow by BadRig::low;
}

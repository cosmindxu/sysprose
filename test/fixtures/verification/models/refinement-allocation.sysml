package RefinementAllocation {

    doc /* AN `allocate` IS NOT A `connect`, AND THE OPT-IN READS ONLY `connect`.
         *
         * The connector walk this lane shares with value propagation is
         * deliberately wide: it is every metaclass that carries two connected
         * features, and `Allocation` is one of them. `--connections-as-equalities`
         * is not wide: it opts into the OCRA reading of a BARE `connect`, and
         * its own sentence — printed on every verdict line under the flag —
         * says so. An allocation maps one element onto another for
         * traceability and states nothing about their values, so reading it as
         * `target == source` would assert an equality nobody wrote and then
         * print a sentence about `connect` edges over a file that contains
         * none.
         *
         * So this decomposition does NOT refine, with the flag or without it,
         * and the allocation is listed under `notEncoded` either way — with a
         * hint that names what it actually is. */

    part def Supply { attribute volts : Real = 24.0; }
    part def Load { attribute volts : Real = 3.0; attribute draw : Real = 12.0; }

    part def Rig {
        part supply : Supply;
        part load : Load;

        allocate Supply::volts to Load::volts;
    }

    requirement def RigTop {
        attribute id = "R-AL-000";
        subject sys : Rig;
        require constraint { sys.load.draw <= 15.0 }
    }

    requirement def SupplyOutput {
        attribute id = "R-AL-001";
        subject s : Supply;
        require constraint { s.volts >= 22.0 }
    }

    requirement def LoadDraw {
        attribute id = "R-AL-002";
        doc /* Its assumption would be discharged if the allocation were an
             * equality. It is not one, so it is not. */
        subject l : Load;
        assume constraint { l.volts >= 20.0 }
        require constraint { l.draw <= 15.0 }
    }

    satisfy RigTop by Rig;
    satisfy SupplyOutput by Rig::supply;
    satisfy LoadDraw by Rig::load;
}

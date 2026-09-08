package RefinementBareConnection {

    doc /* The same shape as `examples/uav-power-budget.sysml`, wired with a
         * bare `connect` instead of a `bind` or a `flow`.
         *
         * A connection states that two features are joined; it does not state
         * that they hold one value. So γ encodes ZERO equalities here, the
         * connection is listed under `notEncoded` with the hint, the load's
         * assumption is discharged by nothing, and the run is a refutation
         * rather than a silent pass. `--connections-as-equalities` opts into the
         * OCRA reading — `cristoforetti-2026` §4.1 maps `connect` and `bind`
         * alike — and under it the same model refines, with the fact printed on
         * every verdict line. */

    part def Source {
        attribute outputVoltage : ISQ::ElectricPotentialValue = 24.0 [V];
        attribute availablePower : ISQ::PowerValue = 720.0 [W];
    }

    part def Load {
        attribute supplyVoltage : ISQ::ElectricPotentialValue = 24.0 [V];
        attribute draw : ISQ::PowerValue = 12.0 [W];
    }

    part def Rig {
        part source : Source;
        part load : Load;
        connection supply connect Source::outputVoltage to Load::supplyVoltage;
    }

    requirement def RigBudget {
        attribute id = "R-BC-000";
        subject sys : Rig;
        require constraint { sys.load.draw <= sys.source.availablePower }
    }

    requirement def SourceSupply {
        attribute id = "R-BC-001";
        subject s : Source;
        require constraint { s.outputVoltage >= 22.0 [V] }
        require constraint { s.availablePower >= 700.0 [W] }
    }

    requirement def LoadDraw {
        attribute id = "R-BC-002";
        subject l : Load;
        assume constraint { l.supplyVoltage >= 20.0 [V] }
        require constraint { l.draw <= 15.0 [W] }
    }

    satisfy RigBudget by Rig;
    satisfy SourceSupply by Rig::source;
    satisfy LoadDraw by Rig::load;
}

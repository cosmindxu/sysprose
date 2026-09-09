package FaultTreeRedundant {

    doc /* A DECOMPOSITION WITH ONE SINGLE POINT OF FAILURE AND ONE REDUNDANT
         * PAIR, so that a cut-set enumeration has both answers to give about
         * the same model.
         *
         * The top requirement asks for two things: a bus voltage the avionics
         * can run on, and enough stored energy for the mission. Three of the
         * four sub-contracts bear on one of those, and the fourth bears on
         * neither:
         *
         *   - `BatteryCapacity` alone guarantees the energy, so withdrawing it
         *     alone breaks the top requirement: **{BatteryCapacity} is an order-1
         *     cut set — a single point of failure.**
         *   - `PrimaryOutput` and `BackupOutput` guarantee the SAME quantity —
         *     the bus voltage, through the two `bind` edges that say the three
         *     features denote one quantity — so withdrawing either one leaves
         *     the other holding the requirement up. **{PrimaryOutput,
         *     BackupOutput} is an order-2 cut set**, and neither half of it is
         *     a cut set on its own. That is what redundancy looks like from the
         *     failure side.
         *   - `RadioDraw` bounds the radio's draw, which the top requirement
         *     never mentions. Withdrawing it changes nothing: **{RadioDraw} is
         *     not a cut set**, and the report says so by leaving it out of a
         *     list that is complete up to the order it was checked to.
         *
         * WHY THE PARTS HAVE A DEFINITION EACH. A constraint body reaches a
         * nested quantity through the TYPE of each part, so a `bind` that names
         * a definition's feature is what puts γ and the contracts in one
         * vocabulary — sound exactly while each definition is instantiated
         * once, which is why the two supplies are two definitions rather than
         * two usages of one. `examples/uav-power-budget.sysml` states the same
         * rule at length.
         *
         * NOTHING HERE STATES A FAULT RATE, A PROBABILITY OR AN ORDERING. A
         * contract-level fault tree says which contract failures suffice to
         * break the top requirement; how likely they are, and in what order
         * they would happen, is not in this model and is not in the answer. */

    part def Bus {
        attribute voltage : ISQ::ElectricPotentialValue = 24.0 [V];
    }

    part def PrimarySupply {
        attribute outVoltage : ISQ::ElectricPotentialValue = 24.0 [V];
    }

    part def BackupSupply {
        attribute outVoltage : ISQ::ElectricPotentialValue = 24.0 [V];
    }

    part def BatteryPack {
        attribute usableEnergy : ISQ::EnergyValue = 320.0 [Wh];
    }

    part def DataLink {
        attribute supplyVoltage : ISQ::ElectricPotentialValue = 24.0 [V];
        attribute draw : ISQ::PowerValue = 35.0 [W];
    }

    part def Avionics {
        part bus : Bus;
        part primary : PrimarySupply;
        part backup : BackupSupply;
        part battery : BatteryPack;
        part radio : DataLink;

        // The three statements that make the bus voltage one quantity. Both
        // supplies feed the same bus, which is what makes them redundant rather
        // than merely similar.
        bind Bus::voltage = PrimarySupply::outVoltage;
        bind Bus::voltage = BackupSupply::outVoltage;
        bind Bus::voltage = DataLink::supplyVoltage;
    }

    requirement def MissionPower {
        attribute id = "R-FT-000";
        doc /* The top event: the bus carries a voltage the avionics can run on,
             * and the battery holds the mission's energy. */
        subject sys : Avionics;
        require constraint { sys.bus.voltage >= 20.0 [V] }
        require constraint { sys.battery.usableEnergy >= 300.0 [Wh] }
    }

    requirement def PrimaryOutput {
        attribute id = "R-FT-001";
        subject p : PrimarySupply;
        require constraint { p.outVoltage >= 24.0 [V] }
    }

    requirement def BackupOutput {
        attribute id = "R-FT-002";
        doc /* The same guarantee as the primary's, over the same bound quantity
             * — which is why neither supply is a single point of failure and
             * the two of them together are a cut set. */
        subject b : BackupSupply;
        require constraint { b.outVoltage >= 24.0 [V] }
    }

    requirement def BatteryCapacity {
        attribute id = "R-FT-003";
        doc /* Nothing else guarantees the energy, so this contract failing
             * alone breaks the top requirement. */
        subject s : BatteryPack;
        require constraint { s.usableEnergy >= 320.0 [Wh] }
    }

    requirement def RadioDraw {
        attribute id = "R-FT-004";
        doc /* A sub-contract the top requirement does not depend on. It is a
             * basic event all the same — it is one of the contracts this
             * decomposition states — and the enumeration finds it harmless. */
        subject r : DataLink;
        assume constraint { r.supplyVoltage >= 20.0 [V] }
        require constraint { r.draw <= 40.0 [W] }
    }

    satisfy MissionPower by Avionics;
    satisfy PrimaryOutput by Avionics::primary;
    satisfy BackupOutput by Avionics::backup;
    satisfy BatteryCapacity by Avionics::battery;
    satisfy RadioDraw by Avionics::radio;
}

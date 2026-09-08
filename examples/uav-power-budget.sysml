package UAVPowerBudget {

    doc /* The electrical power budget of the ISR air vehicle, written as a
         * CONTRACT DECOMPOSITION: one system contract on the power system, four
         * component contracts on the parts that satisfy it, and the wiring that
         * says which quantities are one quantity.
         *
         * It is the model `npm run sysprose -- refine --via composition` is
         * about. The system promises that the loads fit inside what the pack can
         * deliver; the battery promises a bus voltage and an available power;
         * each load assumes a bus voltage and promises a draw. Cimatti's
         * obligation (3) — the component contracts, together with the
         * connection assertion, entail the system contract — is provable here
         * because 15 + 600 + 40 W fits inside 700 W, and obligation (4) — every
         * component assumption is discharged by its siblings — is provable
         * because the battery's 22 V reaches all three loads.
         *
         * THE WIRING IS `bind` AND `flow`, NOT BARE `connect`, and that is the
         * point of the example rather than a stylistic choice. A `bind` states
         * that two features denote ONE quantity, and an item flow carries the
         * source's value to the target — which is what `propagateValues` in
         * `src/semantics/connectors.ts` already does with them, and therefore
         * what the connection assertion γ may assert without diverging from the
         * tool's own value semantics. A bare `connection` states that two parts
         * are joined and says nothing about any value, so it is listed under
         * `notEncoded` with the hint "bind the attributes if they are one
         * quantity" and contributes no equality. `motorCommand` below is exactly
         * that case, kept so the report has one to list.
         *
         * WHY THE BINDS NAME THE DEFINITIONS. A constraint body reaches a nested
         * quantity through the TYPE of each part (`sys.battery.outputVoltage`
         * resolves to `BatteryPack::outputVoltage`), while a connector endpoint
         * written as `battery.outputVoltage` resolves to a usage-scoped copy
         * that keeps `connect a.p to b.p` from collapsing into a self-edge. The
         * two spellings therefore denote different elements, and an equality
         * over the second would join nothing the contracts talk about. Naming
         * the definition's feature is what puts γ and the contracts in one
         * vocabulary, and it is sound HERE because each definition is
         * instantiated exactly once in this system — a second `DataLink` would
         * make the bind say more than the model means.
         *
         * The values are a design point: 12 + 560 + 35 = 607 W against 720 W
         * available, at 24 V. They are what `verify` and `check` judge; the
         * refinement obligations do not read them at all, because a refinement
         * is a claim about every implementation the contracts admit rather than
         * about one design. */

    part def BatteryPack {
        doc /* The pack, seen through its bus terminals. */
        attribute outputVoltage : ISQ::ElectricPotentialValue = 24.0 [V];
        attribute availablePower : ISQ::PowerValue = 720.0 [W];
    }

    part def FlightController {
        attribute supplyVoltage : ISQ::ElectricPotentialValue = 24.0 [V];
        attribute draw : ISQ::PowerValue = 12.0 [W];
    }

    part def PropulsionUnit {
        attribute supplyVoltage : ISQ::ElectricPotentialValue = 24.0 [V];
        attribute draw : ISQ::PowerValue = 560.0 [W];
    }

    part def DataLink {
        attribute supplyVoltage : ISQ::ElectricPotentialValue = 24.0 [V];
        attribute draw : ISQ::PowerValue = 35.0 [W];
    }

    part def PowerSystem {
        doc /* The four parts, and the three statements that make their bus
             * voltages one quantity: two bindings and one item flow. */
        part battery : BatteryPack;
        part flightComputer : FlightController;
        part propulsion : PropulsionUnit;
        part radio : DataLink;

        bind BatteryPack::outputVoltage = FlightController::supplyVoltage;
        bind BatteryPack::outputVoltage = PropulsionUnit::supplyVoltage;
        flow busSupply from BatteryPack::outputVoltage to DataLink::supplyVoltage;

        // A bare connection: the flight computer commands the propulsion unit.
        // It joins two parts and states nothing about a value, so `refine` lists
        // it under `notEncoded` rather than reading it as an equality.
        connection motorCommand connect flightComputer to propulsion;
    }

    requirement def PowerBudget {
        attribute id = "R-PWR-000";
        doc /* The three loads together shall stay inside the power the pack can
             * deliver. This is the system contract the decomposition refines. */
        subject sys : PowerSystem;
        require constraint { sys.flightComputer.draw + sys.propulsion.draw + sys.radio.draw <= sys.battery.availablePower }
    }

    requirement def BatterySupply {
        attribute id = "R-PWR-001";
        doc /* What the pack promises the bus, unconditionally. */
        subject b : BatteryPack;
        require constraint { b.outputVoltage >= 22.0 [V] }
        require constraint { b.availablePower >= 700.0 [W] }
    }

    requirement def ComputerDraw {
        attribute id = "R-PWR-002";
        doc /* What the flight controller draws, given a bus it can run on. */
        subject fc : FlightController;
        assume constraint { fc.supplyVoltage >= 20.0 [V] }
        require constraint { fc.draw <= 15.0 [W] }
    }

    requirement def PropulsionDraw {
        attribute id = "R-PWR-003";
        subject p : PropulsionUnit;
        assume constraint { p.supplyVoltage >= 20.0 [V] }
        require constraint { p.draw <= 600.0 [W] }
    }

    requirement def RadioDraw {
        attribute id = "R-PWR-004";
        doc /* The radio's bus voltage arrives over the item flow rather than a
             * binding, which is why its assumption is discharged without the
             * `--connections-as-equalities` opt-in. */
        subject r : DataLink;
        assume constraint { r.supplyVoltage >= 20.0 [V] }
        require constraint { r.draw <= 40.0 [W] }
    }

    satisfy PowerBudget by PowerSystem;
    satisfy BatterySupply by PowerSystem::battery;
    satisfy ComputerDraw by PowerSystem::flightComputer;
    satisfy PropulsionDraw by PowerSystem::propulsion;
    satisfy RadioDraw by PowerSystem::radio;
}

package RefinementThreeLevel {

    doc /* A THREE-LEVEL TREE WRITTEN THE WAY SysML v2 WRITES ONE, and the
         * reason the enclosing walk crosses a TYPE and not only an owner.
         *
         * `satisfy CellCharge by Pack::cell` names a part usage whose OWNER is
         * the part definition `Pack`, and `Pack` is never the satisfier of
         * anything. A walk that climbed `ownerId` alone would stop there, the
         * two leaf contracts would join no decomposition at all, and the run
         * would still exit 0 over the level above them — an unchecked
         * decomposition hidden behind a proved one. `part pack : Pack` is what
         * the model says about where `cell` lives, so every usage typed by
         * `Pack` encloses it, and the tree decomposes level by level:
         *
         *   VehicleBudget (Vehicle)      ← PackBudget
         *   PackBudget    (Vehicle::pack) ← CellCharge, HeaterCharge
         *
         * The two bare connections are here for the OTHER half of the same
         * question. γ is trimmed per decomposition and so is its refused half:
         * `mount` is wiring of the vehicle level and `cellTie` of the pack
         * level, so each verdict line counts and names its own — a group that
         * printed the file's total would report a figure about the file dressed
         * as a figure about the answer. */

    part def Cell { attribute charge : Real = 90.0; }
    part def Heater { attribute charge : Real = 90.0; }
    part def Chassis { attribute mass : Real = 10.0; }

    part def Pack {
        part cell : Cell;
        part heater : Heater;

        // The pack level's own wiring: a bare connection, and therefore not an
        // equality. It belongs to the PackBudget decomposition and to no other.
        connection cellTie connect cell to heater;
    }

    part def Vehicle {
        part pack : Pack;
        part chassis : Chassis;

        // The vehicle level's wiring, one level up from `cellTie`.
        connection mount connect pack to chassis;
    }

    requirement def VehicleBudget {
        attribute id = "R-3L-000";
        subject v : Vehicle;
        require constraint { v.pack.cell.charge >= 50.0 }
    }

    requirement def PackBudget {
        attribute id = "R-3L-001";
        doc /* Both a component (of the vehicle) and a system (of the cell and
             * the heater) — which is what "level by level" means. */
        subject p : Pack;
        require constraint { p.cell.charge >= 60.0 }
    }

    requirement def CellCharge {
        attribute id = "R-3L-002";
        subject c : Cell;
        require constraint { c.charge >= 70.0 }
    }

    requirement def HeaterCharge {
        attribute id = "R-3L-003";
        subject h : Heater;
        require constraint { h.charge >= 70.0 }
    }

    satisfy VehicleBudget by Vehicle;
    satisfy PackBudget by Vehicle::pack;
    satisfy CellCharge by Pack::cell;
    satisfy HeaterCharge by Pack::heater;
}

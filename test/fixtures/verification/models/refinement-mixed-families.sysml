package RefinementMixedFamilies {

    doc /* ONE FILE THAT STATES BOTH FAMILIES, so `--via all` has two kinds of
         * group to publish and their ORDER is observable. `all` is a run and
         * never a group: the families read different edges and answer different
         * questions, so the run is two sets of groups side by side, each row
         * naming the one it came from. A census taken with no solver and a run
         * taken with one must publish them in the SAME order — otherwise a
         * reader comparing the two sees rows move for no reason their model
         * explains. */

    part def Cell { attribute v : ISQ::MassValue = 1.0 [kg]; }

    part def Pack {
        attribute total : ISQ::MassValue = 2.0 [kg];
        part a : Cell;
    }

    part pack : Pack;

    requirement def PackMass {
        attribute id = "R-MF-000";
        subject pack : Pack;
        require constraint { pack.total <= 5.0 [kg] }
    }

    requirement def CellMass {
        attribute id = "R-MF-001";
        subject cell : Cell;
        require constraint { cell.v <= 1.0 [kg] }
    }

    requirement def SubMass {
        attribute id = "R-MF-002";
        subject pack : Pack;
        require constraint { pack.total <= 4.0 [kg] }
    }

    satisfy PackMass by pack;
    satisfy CellMass by pack.a;
    derive requirement SubMass from PackMass;
}

package ConsistencyUnengageable {
    doc /* What the implication reading costs, and where it is paid.
         *
         * `⋀ (A ⇒ G)` is satisfiable by falsifying every antecedent, so a set
         * can hold for the only reason nobody wants: none of its requirements
         * ever applies. Two shapes of that are here, and both are found by the
         * per-requirement engagement check rather than by the main one.
         *
         * `AirVehicle`: an assumption that contradicts itself, so the
         * requirement applies nowhere on its own terms.
         *
         * `GroundStation`: two requirements under the SAME assumption whose
         * guarantees collide. Their assumption CAN hold — nothing is wrong with
         * `phase == 1` — but not beside both guarantees, so the set is
         * satisfiable only at `phase != 1`, where neither requirement says
         * anything. This is the conflict a conjunction reading would have
         * caught, and it is still caught here. */

    part def AirVehicle {
        attribute mode : ScalarValues::Real = 1.0;
        attribute mtow : ISQ::MassValue = 18.5 [kg];
    }
    part uav : AirVehicle;

    requirement def <'R-NEVER'> NeverApplies {
        subject uav : AirVehicle;
        assume constraint impossibleMode { uav.mode > 5.0 and uav.mode < 2.0 }
        require constraint neverFloor { uav.mtow >= 900.0 [kg] }
    }

    part def GroundStation {
        attribute phase : ScalarValues::Real = 1.0;
        attribute powerDraw : ISQ::PowerValue = 400.0 [W];
    }
    part gcs : GroundStation;

    requirement def <'R-GCS-1'> DeployedCeiling {
        subject gcs : GroundStation;
        assume constraint deployedPhase { gcs.phase == 1.0 }
        require constraint drawCeiling { gcs.powerDraw <= 300.0 [W] }
    }

    requirement def <'R-GCS-2'> DeployedFloor {
        subject gcs : GroundStation;
        assume constraint deployedPhaseToo { gcs.phase == 1.0 }
        require constraint drawFloor { gcs.powerDraw >= 500.0 [W] }
    }

    satisfy NeverApplies by uav;
    satisfy DeployedCeiling by gcs;
    satisfy DeployedFloor by gcs;
}

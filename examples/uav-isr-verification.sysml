package UAVSurveillanceVerification {

    doc /* The verification half of the ISR air system in `uav-isr.sysml`: three
         * requirements, and the three verification cases that answer for them.
         *
         * It exists to show the METHOD GATE. `VerificationCases::
         * VerificationMethod` carries `kind : VerificationMethodKind [1..*]`, so
         * a case says how it is answered — by analysis, by test, by
         * demonstration, by inspection — and Sysprose performs analysis and
         * nothing else. So `enduranceAnalysis` gets a computed verdict,
         * `massBench` gets none at all (`verification/method-not-performed`,
         * exit 2, never exit 1 — an unjudged case is not a refutation), and
         * `linkQualification`, which declares both, is judged on the analyze
         * part and reports the test part as not performed.
         *
         * It also shows both spellings of "this case verifies that
         * requirement": `objective { verify R; }` inside the case, and
         * `verify R by <case>;` at member level. Only the second declares a
         * relationship with both endpoints, so only the second appears in
         * `sysprose -- trace --relation verify`; both are read here. */

    part def BatteryPack {
        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
        attribute mass : ISQ::MassValue = 3.4 [kg];
    }

    part def DataLink {
        attribute range : ISQ::LengthValue = 25.0 [km];
    }

    part def AirVehicle {
        attribute mtow : ISQ::MassValue = 18.5 [kg];
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        attribute usableEnergyFraction : Real = 0.8;
        // 640 Wh x 0.8 / 650 W = 0.7877 h = 47.3 min. The requirement's `[min]`
        // literal converts; nothing is hand-converted here.
        attribute endurance : ISQ::DurationValue = battery.capacity * usableEnergyFraction / cruisePower;

        part battery : BatteryPack;
        part radio : DataLink;
    }

    part uav : AirVehicle;

    requirement def EnduranceRequirement {
        attribute id = "R-UAV-V01";
        doc /* The air vehicle shall sustain at least 45 minutes of surveillance
             * flight on a single battery pack. */
        subject uav : AirVehicle;
        require constraint { uav.endurance >= 45.0 [min] }
    }

    requirement def MassRequirement {
        attribute id = "R-UAV-V02";
        doc /* Maximum take-off mass shall stay within the 25 kg class boundary. */
        subject uav : AirVehicle;
        require constraint { uav.mtow <= 25.0 [kg] }
    }

    requirement def RangeRequirement {
        attribute id = "R-UAV-V03";
        doc /* The command and video link shall reach at least 20 km. */
        subject uav : AirVehicle;
        require constraint { uav.radio.range >= 20.0 [km] }
    }

    // ANALYSIS. The one method this tool performs, so this case is judged: its
    // objective names the requirement, and the verdict is the roll-up of that
    // requirement's obligation rows.
    verification enduranceAnalysis {
        doc /* Endurance is settled by computing it from the pack energy, the
             * usable fraction and cruise power — an analysis, not a flight. */
        subject uav : AirVehicle;
        @VerificationCases::VerificationMethod {
            attribute kind = analyze;
        }
        objective {
            verify EnduranceRequirement;
        }
    }

    // TEST. Mass is settled by weighing the aircraft, which this tool cannot
    // do. It reports `verification/method-not-performed` and gives NO verdict:
    // exit 2 with and without `--allow-inconclusive`, and never exit 1.
    verification massBench {
        doc /* Take-off mass is settled on a bench scale with the flight battery
             * and payload fitted. Nothing about that is an analysis. */
        subject uav : AirVehicle;
        @VerificationCases::VerificationMethod {
            attribute kind = test;
        }
    }

    // BOTH. A range figure is analysed from the link budget and then confirmed
    // on a range test. The case is judged on the analyze part and says plainly
    // that the test part was not performed.
    verification linkQualification {
        doc /* Link range is analysed from the budget and confirmed by a flight
             * test; this tool answers for the first half only. */
        subject uav : AirVehicle;
        @VerificationCases::VerificationMethod {
            attribute kind = (analyze, test);
        }
        objective {
            verify RangeRequirement;
        }
    }

    // The member-level spelling, which is the one a traceability matrix can see.
    verify MassRequirement by massBench;

    satisfy EnduranceRequirement by uav;
    satisfy MassRequirement by uav;
    satisfy RangeRequirement by uav;
}

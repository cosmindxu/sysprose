// The shape of a layered brief, trimmed from a drone-swarm model: every
// target is stated once in Common on an abstract measure (#MoE) that carries no
// value by design, and each layer gives its own estimate (#Estimate) as a
// feature that subsets the measure — a literal, or fixed by an equation beside
// it (CV-17). LA and PA disagree on two of them. The ten #Budget measures are
// specialised by nothing. checkConstraints answers each Common target unknown
// and reads it once per layer through that layer's estimate.
package BriefTargets {
    private import Kinds::*;
    package Kinds {
        metadata def MoE; metadata def Estimate; metadata def Budget; metadata def Placeholder;
    }
    package Common {
        #MoE attribute areaUnderWatchFraction : ScalarValues::Real;
        require constraint areaUnderWatchTarget {
            areaUnderWatchFraction >= 0.9
        }
        #MoE attribute coverageLossAfterMemberLossFraction : ScalarValues::Real;
        require constraint coverageLossAfterMemberLossTarget {
            coverageLossAfterMemberLossFraction <= 0.25
        }
        #MoE #Placeholder attribute coverageUnderMeshJammingFraction : ScalarValues::Real;
        require constraint coverageUnderMeshJammingTarget {
            coverageUnderMeshJammingFraction >= 0.75
        }
        #MoE #Placeholder attribute reportAgeAtOperationsCentreSeconds : ScalarValues::Real;
        require constraint reportAgeAtOperationsCentreTarget {
            reportAgeAtOperationsCentreSeconds <= 60.0
        }
        #MoE #Placeholder attribute positionErrorWithoutSatelliteMetres : ScalarValues::Real;
        require constraint positionErrorWithoutSatelliteTarget {
            positionErrorWithoutSatelliteMetres <= 50.0
        }
        #MoE #Placeholder attribute reportHoldWhileCutOffMinutes : ScalarValues::Real;
        require constraint reportHoldWhileCutOffTarget {
            reportHoldWhileCutOffMinutes >= 30.0
        }
        #MoE #Placeholder attribute missedDetectionFraction : ScalarValues::Real;
        require constraint missedDetectionTarget {
            missedDetectionFraction <= 0.10
        }
        #MoE #Placeholder attribute falseAlarmsPerHour : ScalarValues::Real;
        require constraint falseAlarmsPerHourTarget {
            falseAlarmsPerHour <= 2.0
        }
        #MoE #Placeholder attribute alertsReachingOperatorPerHour : ScalarValues::Real;
        require constraint alertsReachingOperatorTarget {
            alertsReachingOperatorPerHour <= 20.0
        }
        #MoE #Placeholder attribute acknowledgedReportsThatMatterFraction : ScalarValues::Real;
        require constraint acknowledgedReportsThatMatterTarget {
            acknowledgedReportsThatMatterFraction >= 0.8
        }
        #MoE #Placeholder attribute onboardClassificationCostUsdPerMember : ScalarValues::Real;
        require constraint onboardClassificationCostTarget {
            onboardClassificationCostUsdPerMember <= 300.0
        }
        #MoE attribute unattendedWatchDurationHours : ScalarValues::Real;
        require constraint unattendedWatchDurationTarget {
            unattendedWatchDurationHours >= 12.0
        }
        // Budgets: what the brief fixes. Nothing specialises them.
        #Budget attribute fleetSizeMembers : ScalarValues::Integer;
        require constraint fleetSizeBudget {
            fleetSizeMembers <= 12
        }
        #Budget attribute memberEnduranceMinutes : ScalarValues::Real;
        require constraint memberEnduranceBudget {
            memberEnduranceMinutes <= 40.0
        }
        #Budget attribute groundTurnaroundMinutes : ScalarValues::Real;
        require constraint groundTurnaroundBudget {
            groundTurnaroundMinutes >= 20.0
        }
        #Budget attribute cruiseSpeedMetresPerSecond : ScalarValues::Real;
        require constraint cruiseSpeedBudget {
            cruiseSpeedMetresPerSecond <= 18.0
        }
        #Budget attribute instantaneousFootprintSquareKilometres : ScalarValues::Real;
        require constraint instantaneousFootprintBudget {
            instantaneousFootprintSquareKilometres <= 3.0
        }
        #Budget attribute areaOfInterestSquareKilometres : ScalarValues::Real;
        require constraint areaOfInterestBudget {
            areaOfInterestSquareKilometres <= 25.0
        }
        #Budget #Placeholder attribute operatorSecondsPerAlert : ScalarValues::Real;
        require constraint operatorSecondsPerAlertBudget {
            operatorSecondsPerAlert >= 30.0
        }
        #Budget #Placeholder attribute trackStaleAfterSeconds : ScalarValues::Real;
        require constraint trackStaleAfterBudget {
            trackStaleAfterSeconds <= 120.0
        }
        #Budget #Placeholder attribute satellitePositioningOutageMinutes : ScalarValues::Real;
        require constraint satellitePositioningOutageBudget {
            satellitePositioningOutageMinutes >= 10.0
        }
        #Budget #Placeholder attribute meshLinksJammedFraction : ScalarValues::Real;
        require constraint meshLinksJammedBudget {
            meshLinksJammedFraction >= 0.5
        }
    }
    package LA {
        #Estimate attribute areaUnderWatchFraction :> Common::areaUnderWatchFraction;
        #Estimate attribute coverageLossAfterMemberLossFraction :> Common::coverageLossAfterMemberLossFraction;
        #Estimate attribute coverageUnderMeshJammingFraction :> Common::coverageUnderMeshJammingFraction = 0.58;
        #Estimate attribute reportAgeAtOperationsCentreSeconds :> Common::reportAgeAtOperationsCentreSeconds = 40;
        #Estimate attribute positionErrorWithoutSatelliteMetres :> Common::positionErrorWithoutSatelliteMetres = 80;
        #Estimate attribute reportHoldWhileCutOffMinutes :> Common::reportHoldWhileCutOffMinutes = 40;
        #Estimate attribute missedDetectionFraction :> Common::missedDetectionFraction = 0.12;
        #Estimate attribute falseAlarmsPerHour :> Common::falseAlarmsPerHour = 3;
        #Estimate attribute alertsReachingOperatorPerHour :> Common::alertsReachingOperatorPerHour = 24;
        #Estimate attribute acknowledgedReportsThatMatterFraction :> Common::acknowledgedReportsThatMatterFraction = 0.7;
        #Estimate attribute onboardClassificationCostUsdPerMember :> Common::onboardClassificationCostUsdPerMember = 350;
        #Estimate attribute unattendedWatchDurationHours :> Common::unattendedWatchDurationHours = 0.7;
        attribute fleetMemberCount = 12;
        attribute memberFlightMinutes = 40;
        attribute memberTurnaroundMinutes = 20;
        attribute sectorTransitMinutes = 7.41;
        attribute memberCoverageFraction = 0.12;
        assert constraint { areaUnderWatchFraction == fleetMemberCount * ((memberFlightMinutes - sectorTransitMinutes) / (memberFlightMinutes + memberTurnaroundMinutes)) * memberCoverageFraction }
        assert constraint { coverageLossAfterMemberLossFraction == memberCoverageFraction / areaUnderWatchFraction }
    }
    package PA {
        attribute fleetMemberCount = 12;
        attribute memberFlightMinutes = 40;
        attribute memberTurnaroundMinutes = 20;
        attribute memberCruiseMetresPerSecond = 18;
        attribute sectorReachMetres = 4000;
        attribute memberTransitMinutes = 7.41;
        attribute memberFootprintSquareKilometres = 3.0;
        attribute areaOfInterestSquareKilometres = 25;
        attribute memberCoverageFraction = 0.12;
        assert constraint { areaUnderWatchFraction == fleetMemberCount * ((memberFlightMinutes - memberTransitMinutes) / (memberFlightMinutes + memberTurnaroundMinutes)) * memberCoverageFraction }
        assert constraint { coverageLossAfterMemberLossFraction == memberCoverageFraction / areaUnderWatchFraction }
        attribute operatorSecondsPerAlert = 30;
        attribute alertCapPerHour = 20;
        attribute trackStaleAfterSeconds = 120;
        attribute reportStoreCapacityReports = 2000;
        attribute peakReportsPerMemberPerMinute = 6;
        attribute acceleratorModuleCostUsd = 230;
        attribute modelMemoryCostUsd = 60;
        attribute reportStoreFlashCostUsd = 30;
        attribute identityElementCostUsd = 30;
        #Estimate attribute areaUnderWatchFraction :> Common::areaUnderWatchFraction;
        #Estimate attribute coverageLossAfterMemberLossFraction :> Common::coverageLossAfterMemberLossFraction;
        #Estimate attribute coverageUnderMeshJammingFraction :> Common::coverageUnderMeshJammingFraction = 0.68;
        #Estimate attribute reportAgeAtOperationsCentreSeconds :> Common::reportAgeAtOperationsCentreSeconds = 40;
        #Estimate attribute positionErrorWithoutSatelliteMetres :> Common::positionErrorWithoutSatelliteMetres = 80;
        #Estimate attribute reportHoldWhileCutOffMinutes :> Common::reportHoldWhileCutOffMinutes = 40;
        #Estimate attribute missedDetectionFraction :> Common::missedDetectionFraction = 0.12;
        #Estimate attribute falseAlarmsPerHour :> Common::falseAlarmsPerHour = 3;
        #Estimate attribute alertsReachingOperatorPerHour :> Common::alertsReachingOperatorPerHour;
        assert constraint { alertsReachingOperatorPerHour == alertCapPerHour }
        #Estimate attribute acknowledgedReportsThatMatterFraction :> Common::acknowledgedReportsThatMatterFraction = 0.75;
        #Estimate attribute onboardClassificationCostUsdPerMember :> Common::onboardClassificationCostUsdPerMember;
        assert constraint { onboardClassificationCostUsdPerMember == acceleratorModuleCostUsd + modelMemoryCostUsd + reportStoreFlashCostUsd + identityElementCostUsd }
        #Estimate attribute unattendedWatchDurationHours :> Common::unattendedWatchDurationHours = 0.66;
    }
}

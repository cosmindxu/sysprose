/*
 * views-tour.sysml — one small model that populates every view Sysprose draws.
 *
 * It exists to answer "what do I write to get this diagram?". Each section is
 * labelled with the view it feeds, and the counts in docs/USER-GUIDE.md §4 are
 * measured from this file. A drone and its ground station are the subject only
 * because they give every view something honest to show.
 *
 * Five views are NOT React Flow graphs and have their own builders — Sequence
 * (`buildSequence`), Grid (`buildGrid`), Requirements (`buildRequirementsTable`),
 * Allocation (`buildAllocationMatrix`) and Analysis (`buildGraphAnalysis`). Asking
 * `buildDiagram` for one of those returns an empty projection ON PURPOSE.
 */
package DroneDemo {

    // ---- structure: general, tree, interconnection ----
    port def Telemetry { attribute rate : ISQ::FrequencyValue; }

    part def GroundStation { out port link : Telemetry; }

    part def Drone {
        in port link : Telemetry;
        attribute mass : ISQ::MassValue = 18.5 [SI::kg];
        attribute power : ISQ::PowerValue = 650 [SI::W];
        attribute endurance : ISQ::DurationValue = 47.3 [SI::min];
        part battery : Battery;
    }

    part def Battery { attribute capacity : ISQ::EnergyValue = 640 [SI::'W*h']; }

    part station : GroundStation;
    part drone : Drone;
    connect station.link to drone.link;

    // ---- behaviour: action view + sequence view ----
    action def Survey;
    action def Transmit;

    action takeoff : Survey;
    action stream : Transmit;
    flow from takeoff to stream;
    succession first takeoff then stream;

    // ---- state view ----
    state def FlightModes {
        state standby;
        state flying;
        transition standby -> flying;
        transition flying -> standby;
    }

    // ---- parametric view ----
    constraint def EnduranceRule { in cap : ISQ::EnergyValue; in p : ISQ::PowerValue; }
    assert constraint enduranceHolds : EnduranceRule { in cap = drone.battery.capacity; in p = drone.power; }

    // ---- requirements view + requirement view + allocation ----
    requirement <R1> MassLimit {
        subject d : Drone;
        require constraint { d.mass <= 25.0 [SI::kg] }
    }
    requirement <R2> EnduranceFloor {
        subject d : Drone;
        require constraint { d.endurance >= 45.0 [SI::min] }
    }
    satisfy R1 by drone;
    satisfy R2 by drone;

    // ---- case view + analysis ----
    verification def MassAnalysis {
        subject d : Drone;
        objective { verify R1; }
    }
    verify R1 by drone;

    // ---- allocation view ----
    part def Processor;
    part cpu : Processor;
    allocate stream to cpu;

    // ---- analysis view ----
    analysis def MassRollup {
        subject d : Drone;
        return total : ISQ::MassValue;
    }
}

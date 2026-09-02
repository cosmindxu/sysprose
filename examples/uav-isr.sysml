package UAVSurveillanceSystem {

    doc /* A small ISR (intelligence, surveillance, reconnaissance) unmanned air
         * system: airframe subsystems wired through power, data and RF ports,
         * with its mission behaviour, flight modes and endurance requirement. */

    port def PowerPort {
        attribute voltage : ISQ::ElectricPotentialValue;
    }

    port def DataPort {
        // Data rate stays a plain Real: the unit registry has no information
        // dimension yet (bit, byte, bit/s), so it cannot be a quantity kind.
        attribute rateMbps : Real;
    }

    port def RFPort {
        attribute frequency : ISQ::FrequencyValue;
    }

    part def BatteryPack {
        attribute capacity : ISQ::EnergyValue = 640.0 [Wh];
        attribute mass : ISQ::MassValue = 3.4 [kg];
        out port powerOut : PowerPort;
    }

    part def FlightController {
        attribute loopRate : ISQ::FrequencyValue = 400.0 [Hz];
        in port powerIn : PowerPort;
        in port navIn : DataPort;
        out port motorOut : DataPort;
        in port linkIn : DataPort;
    }

    part def NavigationSensors {
        attribute updateRate : ISQ::FrequencyValue = 200.0 [Hz];
        in port powerIn : PowerPort;
        out port navOut : DataPort;
    }

    part def PropulsionUnit {
        attribute maxThrust : ISQ::ForceValue = 42.0 [N];
        in port powerIn : PowerPort;
        in port commandIn : DataPort;
    }

    part def PayloadGimbal {
        attribute mass : ISQ::MassValue = 1.2 [kg];
        in port powerIn : PowerPort;
        out port videoOut : DataPort;
    }

    part def DataLink {
        attribute range : ISQ::LengthValue = 25.0 [km];
        in port powerIn : PowerPort;
        in port videoIn : DataPort;
        out port commandOut : DataPort;
        inout port antenna : RFPort;
    }

    part def AirVehicle {
        doc /* Fixed-wing, catapult-launched, electric, with a single pusher
             * propulsion unit. Thrust is sized for cruise and climb, NOT for
             * hover: at 18.5 kg the airframe weighs 181 N and the propulsion
             * unit delivers 42 N, a thrust-to-weight of 0.23. That is ample
             * for a fixed wing and impossible for a multirotor, so the
             * configuration is stated rather than left to be inferred. */
        attribute mtow : ISQ::MassValue = 18.5 [kg];
        attribute cruisePower : ISQ::PowerValue = 650.0 [W];
        // A pure ratio; DimensionOneValue would also do, Real reads better here.
        attribute usableEnergyFraction : Real = 0.8;
        // Derived: minutes of flight the usable pack energy buys at cruise power.
        // 640 Wh x 0.8 / 650 W x 60 = 47.3 min. Referenced by the requirement.
        attribute enduranceMin : Real = battery.capacity * usableEnergyFraction / cruisePower * 60.0;

        part battery : BatteryPack;
        part flightComputer : FlightController;
        part navigation : NavigationSensors;
        part propulsion : PropulsionUnit;
        part gimbal : PayloadGimbal;
        part radio : DataLink;

        connection powerToComputer connect battery.powerOut to flightComputer.powerIn;
        connection powerToNav connect battery.powerOut to navigation.powerIn;
        connection powerToProp connect battery.powerOut to propulsion.powerIn;
        connection powerToGimbal connect battery.powerOut to gimbal.powerIn;
        connection powerToRadio connect battery.powerOut to radio.powerIn;
        connection navFix connect navigation.navOut to flightComputer.navIn;
        connection motorCommand connect flightComputer.motorOut to propulsion.commandIn;
        connection videoDownlink connect gimbal.videoOut to radio.videoIn;
        connection uplinkCommand connect radio.commandOut to flightComputer.linkIn;
    }

    part uav : AirVehicle;

    action def FlyMission {
        action takeoff;
        action transitToArea;
        action surveilTarget;
        action returnToBase;
        action land;
        first takeoff then transitToArea;
        then surveilTarget;
        then returnToBase;
        then land;
    }

    state def FlightModes {
        state standby;
        state manual;
        state autonomous;
        state failsafe;
        transition standby -> manual;
        transition manual -> autonomous;
        transition autonomous -> manual;
        transition autonomous -> failsafe;
        transition failsafe -> standby;
    }

    requirement def EnduranceRequirement {
        attribute id = "R-UAV-001";
        doc /* The air vehicle shall sustain at least 45 minutes of surveillance
             * flight on a single battery pack. Checked against the usable
             * energy of the pack at cruise power, via the derived enduranceMin. */
        subject uav : AirVehicle;
        require constraint { uav.enduranceMin >= 45.0 }
    }

    requirement def MassRequirement {
        attribute id = "R-UAV-002";
        doc /* Maximum take-off mass shall stay within the 25 kg class boundary
             * that separates the light category from heavier certification. */
        subject uav : AirVehicle;
        require constraint { uav.mtow <= 25.0 }
    }

    satisfy EnduranceRequirement by uav;
    satisfy MassRequirement by uav;
}

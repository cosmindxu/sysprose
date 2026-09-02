package UAVSurveillanceSystem {

    doc /* A small ISR (intelligence, surveillance, reconnaissance) unmanned air
         * system: airframe subsystems wired through power, data and RF ports,
         * with its mission behaviour, flight modes and endurance requirement. */

    port def PowerPort {
        attribute voltage : Real;
    }

    port def DataPort {
        attribute rateMbps : Real;
    }

    port def RFPort {
        attribute frequencyGHz : Real;
    }

    part def BatteryPack {
        attribute capacityWh : Real = 640.0;
        attribute mass : Real = 3.4;
        out port powerOut : PowerPort;
    }

    part def FlightController {
        attribute loopRateHz : Real = 400.0;
        in port powerIn : PowerPort;
        in port navIn : DataPort;
        out port motorOut : DataPort;
        in port linkIn : DataPort;
    }

    part def NavigationSensors {
        attribute updateRateHz : Real = 200.0;
        in port powerIn : PowerPort;
        out port navOut : DataPort;
    }

    part def PropulsionUnit {
        attribute maxThrustN : Real = 42.0;
        in port powerIn : PowerPort;
        in port commandIn : DataPort;
    }

    part def PayloadGimbal {
        attribute mass : Real = 1.2;
        in port powerIn : PowerPort;
        out port videoOut : DataPort;
    }

    part def DataLink {
        attribute rangeKm : Real = 25.0;
        in port powerIn : PowerPort;
        in port videoIn : DataPort;
        out port commandOut : DataPort;
        inout port antenna : RFPort;
    }

    part def AirVehicle {
        attribute mtowKg : Real = 18.5;

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
             * flight on a single battery pack. */
        subject uav : AirVehicle;
        require constraint { uav.mtowKg <= 25.0 }
    }

    satisfy EnduranceRequirement by uav;
}

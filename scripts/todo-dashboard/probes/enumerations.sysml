// Enumerations. An enum literal in a relation is refused by the gate (the
// unresolved-name sentence below), so no decision row reads the enumeration:
// `partial`.
package Enumerations {
    enum def Mode {
        enum on;
        enum off;
    }

    part def Device {
        attribute mode : Mode = Mode::on;
        attribute mass : Real = 1.0;
    }

    part device : Device;

    requirement def ModeIsOn {
        subject d : Device;
        require constraint { d.mode == Mode::on }
    }

    satisfy ModeIsOn by device;
}

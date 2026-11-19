// Requirements. Reconstructed from the recorded CU-2 shape (a requirement usage with a
// subject and a ceiling constraint); unchanged from that shape. The subject's
// constraint files an obligation on all four surfaces: `read`.
package ProbeRequirements {
    part def Vehicle {
        attribute mass : Real = 1500.0;
    }

    part vehicle : Vehicle;

    requirement massCeiling {
        subject v : Vehicle;
        require constraint { v.mass <= 2000.0 }
    }

    satisfy massCeiling by vehicle;
}

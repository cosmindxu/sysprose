// Allocation. Reconstructed from the recorded CU-2 shape (Supply::volts allocated to
// Load::volts), extended with LoadVolts to show the allocation is NOT read:
// the load's own 3.0 is refuted against 20.0 rather than taking the supply's
// 24.0, so no decision surface reads the allocation. The area is `partial`.
package ProbeAllocation {
    part def Supply {
        attribute volts : Real = 24.0;
    }

    part def Load {
        attribute volts : Real = 3.0;
    }

    part def Rig {
        part supply : Supply;
        part load : Load;
        allocate Supply::volts to Load::volts;
    }

    part rig : Rig;

    requirement def RigTop {
        subject sys : Rig;
        require constraint { sys.load.volts <= 5.0 }
    }

    requirement def LoadVolts {
        subject l : Load;
        require constraint { l.volts >= 20.0 }
    }

    satisfy RigTop by rig;
    satisfy LoadVolts by rig.load;
}

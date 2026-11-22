// A two-point vehicle family (after SysML v2 Annex A.12): an engine and a
// transmission, a selection constraint pairing them, and two configurations.
// `sysprose variability` reads this file in the called-and-spawned bridge.
package VariabilityFamily {
    part def Engine;
    part def Engine4Cyl :> Engine;
    part def Engine6Cyl :> Engine;
    part def Transmission;
    part def Automatic :> Transmission;
    part def Manual :> Transmission;

    part def VehicleFamily {
        variation part engine : Engine {
            variant part e4 : Engine4Cyl;
            variant part e6 : Engine6Cyl;
        }
        variation part transmission : Transmission {
            variant part auto : Automatic;
            variant part manual : Manual;
        }
        assert constraint selectionConstraint {
            (engine == engine::e4 and transmission == transmission::manual) or
            (engine == engine::e6 and transmission == transmission::auto)
        }
    }

    part city : VehicleFamily {
        part :>> engine = engine::e4;
        part :>> transmission = transmission::manual;
    }
    part touring : VehicleFamily {
        part :>> engine = engine::e6;
        part :>> transmission = transmission::auto;
    }
}

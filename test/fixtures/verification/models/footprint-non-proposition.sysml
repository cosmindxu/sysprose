// A model whose axiom set holds a relation that is an ARITHMETIC TERM rather
// than a proposition, so the SMT encoder refuses it and the read-closure
// carries it instead of pruning it.
//
// It exists for the footprint twin. `footprintOf` computes the encoder's own
// relevance walk without an encoder, and a refused axiom is CARRIED by that
// walk — it shares no symbol with anything, so nothing can connect through it,
// and the conservative reading of "this relation was not understood" is that it
// might still matter. A twin that modelled only the refusals it could see
// syntactically read `weird` as reading `Trailer::mass`, found no shared symbol
// with the mass proof, and pruned a row the encoder kept: a footprint that
// under-reports what the proof stood on.
//
// `trailer` shares no feature with `vehicle` on purpose. If the two were
// connected the closure would carry `weird` for a reason that has nothing to do
// with the refusal, and the case would pass whether or not the twin agreed.
package NonProposition {
    part def Trailer {
        attribute mass : ISQ::MassValue = 300.0 [kg];
    }
    part def Vehicle {
        attribute mass : ISQ::MassValue = 1500.0 [kg];
    }
    part trailer : Trailer;
    part vehicle : Vehicle;

    assert constraint weird {
        trailer.mass
    }

    requirement def MassLimit {
        doc /* The vehicle shall stay within the 2 t limit. */
        subject v : Vehicle;
        require constraint {
            v.mass <= 2000.0 [kg]
        }
    }
    satisfy MassLimit by vehicle;
}

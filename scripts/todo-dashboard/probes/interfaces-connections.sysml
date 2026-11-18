// Interfaces and connections. Reconstructed from the recorded CU-2 shape (two ports joined by a
// `connection`); unchanged from that shape. The row reads the source port's
// member value; the connection itself files no row — a bare connect is an
// equality only under `--connections-as-equalities` — so the area is `partial`.
package ProbeInterfaces {
    port def Link {
        attribute rate : Real = 3.0;
    }

    part def Source {
        out port tx : Link;
    }

    part def Sink {
        in port rx : Link;
    }

    part def Assembly {
        part source : Source;
        part sink : Sink;
        connection wiring connect source.tx to sink.rx;
    }

    part assembly : Assembly;

    requirement def RateBound {
        subject a : Assembly;
        require constraint { a.source.tx.rate <= 10.0 }
    }

    satisfy RateBound by assembly;
}

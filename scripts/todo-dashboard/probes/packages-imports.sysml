// Packages and imports. `Use` imports `Base::*`, and the row resolves `a.w.size`
// through `Widget` only because the import puts it in scope, so the import is on
// the row's read path: `read`.
package Base {
    part def Widget {
        attribute size : Real = 2.0;
    }
}

package Use {
    import Base::*;

    part def Assembly {
        part w : Widget;
        attribute limit : Real = 3.0;
    }

    part asm : Assembly;

    requirement def SizeLimit {
        subject a : Assembly;
        require constraint { a.w.size <= a.limit }
    }

    satisfy SizeLimit by asm;
}

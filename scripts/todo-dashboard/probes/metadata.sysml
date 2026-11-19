// Metadata. A `@Metadata` annotation is an annotation; the row reads the part's
// own attributes, not the metadata usage, so the area is `partial`.
package Metadata {
    metadata def Safety {
        attribute level : Integer = 3;
    }

    part def System {
        attribute mass : Real = 10.0;
        attribute limit : Real = 20.0;
    }

    @Safety { level = 3; }
    part system : System;

    requirement def MassLimit {
        subject s : System;
        require constraint { s.mass <= s.limit }
    }

    satisfy MassLimit by system;
}

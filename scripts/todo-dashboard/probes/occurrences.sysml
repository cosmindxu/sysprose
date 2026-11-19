// Occurrences. An occurrence definition owns attributes and the occurrence
// usage is a feature, so the row reads `t.duration`: `read`.
package Occurrences {
    occurrence def Trip {
        attribute duration : Real = 30.0;
        attribute limit : Real = 60.0;
    }

    occurrence trip : Trip;

    requirement def DurationLimit {
        subject t : Trip;
        require constraint { t.duration <= t.limit }
    }

    satisfy DurationLimit by trip;
}

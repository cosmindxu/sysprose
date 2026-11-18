// Actions and control nodes. A control-node-bearing action definition owns an
// attribute, and the row reads `x.rate`; the control nodes (first/then) are not
// read by the four decision surfaces, so the area is `partial`.
package Actions {
    action def Process {
        attribute rate : Real = 5.0;
        attribute limit : Real = 10.0;
        action step1;
        action step2;
        first step1 then step2;
    }

    action p : Process;

    requirement def RateLimit {
        subject x : Process;
        require constraint { x.rate <= x.limit }
    }

    satisfy RateLimit by p;
}

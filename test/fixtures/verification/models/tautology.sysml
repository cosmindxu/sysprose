package Tautology {
    part def Panel {
        attribute area : ISQ::AreaValue = 2.5 [m^2];
    }
    part panel : Panel;
    requirement def AreaIdentity {
        doc /* True of every model there is, so it says nothing about this one.
             * `proved`, and flagged as a tautology. */
        subject panel : Panel;
        require constraint { panel.area == panel.area }
    }
    satisfy AreaIdentity by panel;
}

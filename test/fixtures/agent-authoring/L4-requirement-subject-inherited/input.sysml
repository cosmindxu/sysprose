package P {
    part def Vehicle;
    part v : Vehicle;
    requirement def MassLimit {
        doc /* The vehicle mass shall be bounded. */
        subject v : Vehicle;
    }
    requirement massLimit : MassLimit;
}

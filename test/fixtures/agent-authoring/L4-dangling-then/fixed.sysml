package P {
    action def Mission {
        action takeoff;
        action survey;
        first takeoff then survey;
    }
}

package P {
    part def Downlink {
        attribute dataRate : ISQ::BinaryDigitRateValue = 100.0 [Mbit/s];
        attribute buffer : ISQ::StorageCapacityValue = 64.0 [MiB];
        attribute bad : ISQ::BinaryDigitRateValue = 5.0 [kbit/s];
    }
}

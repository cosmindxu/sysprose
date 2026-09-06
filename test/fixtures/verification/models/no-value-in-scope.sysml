package NoValue {
    part def Motor {
        attribute torque : ISQ::TorqueValue;
    }
    part motor : Motor;
    requirement def TorqueLimit {
        doc /* Nothing in the model gives the torque a value. */
        subject motor : Motor;
        require constraint { motor.torque <= 10.0 [N*m] }
    }
    satisfy TorqueLimit by motor;
}

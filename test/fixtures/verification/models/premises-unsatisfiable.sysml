package PremisesUnsatisfiable {
    part def Pump {
        attribute flow : ISQ::VolumeFlowRateValue = 2.0 [L/min];
    }
    part pump : Pump;
    requirement def FlowCeiling {
        doc /* The premise asks for a flow the model's own value cannot reach,
             * so nothing at all satisfies the antecedent: the guarantee is
             * discharged for free and says nothing about the design. */
        subject pump : Pump;
        assume constraint { pump.flow >= 3.0 [L/min] }
        require constraint { pump.flow <= 10.0 [L/min] }
    }
    satisfy FlowCeiling by pump;
}

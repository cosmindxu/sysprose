package Spec {
  part def Transmission; part def ManualTransmission :> Transmission; part def AutomaticTransmission :> Transmission;
  variation part def TransmissionChoices :> Transmission {
      variant part manual : ManualTransmission;
      variant part automatic : AutomaticTransmission;
  }
}

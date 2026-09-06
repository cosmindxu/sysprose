package ProseOnly {
    part def Cabin {
        attribute seats : Integer = 4;
    }
    part cabin : Cabin;
    requirement def ComfortRequirement {
        doc /* The cabin shall be comfortable for a four-hour journey. */
        subject cabin : Cabin;
    }
    satisfy ComfortRequirement by cabin;
}

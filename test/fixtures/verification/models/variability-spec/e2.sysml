package Spec {
  part def Engine; part def FourCylinderEngine :> Engine; part def SixCylinderEngine :> Engine;
  // These are non-variant usages.
  part smallEngine : FourCylinderEngine;
  part bigEngine : SixCylinderEngine;
  part def Vehicle {
      variation part engine : Engine {
          variant smallEngine;
          variant bigEngine;
      }
  }
}

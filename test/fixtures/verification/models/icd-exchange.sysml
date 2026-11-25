package IcdExchange {
    item def Cmd; item def Report;
    port def CmdPort { out item cmd : Cmd; }
    port def ReportPort { out item report : Report; }
    action def Command { out cmd : Cmd; }
    action def Execute { in cmd : Cmd; out report : Report; }
    action def Show { in report : Report; }
    part def Ground { out port cmdOut : CmdPort; in port reportIn : ~ReportPort; }
    part def Drone { in port cmdIn : ~CmdPort; out port reportOut : ReportPort; }
    part sys {
        action command : Command; action execute : Execute; action show : Show;
        flow cmdFlow of Cmd from command.cmd to execute.cmd;
        flow reportFlow of Report from execute.report to show.report;
        part ground : Ground; part drone : Drone; part other : Ground;
        allocate command to ground; allocate show to ground; allocate execute to drone;
        connection cmdLink connect ground.cmdOut to drone.cmdIn;
        connection reportLink connect drone.reportOut to ground.reportIn;
        connection otherLink connect other.cmdOut to drone.cmdIn;
        allocate cmdFlow to cmdLink;
    }
}

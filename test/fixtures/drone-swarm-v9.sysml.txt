package SurveillanceDroneSwarm {
    doc /* SurveillanceDroneSwarm — layered model.
           Mission: The SurveillanceDroneSwarm holds continuous watch over a tasked area of up to 25 km² and turns what happens there into acknowledged, triaged detection reports at the operations centre, inside the airspace clearance, weather, radio interference and satellite-positioning outages the environment imposes, using twelve battery-swapped drones, a mesh radio between them, a ground station and an intermittent link to the operations centre.
           Function: SurveillanceDroneSwarm moves the tasked area from unwatched and unreported to continuously watched and reported to the operations centre.
           One package per perspective; references point upward only. */
    private import Kinds::*;
    package Kinds {
        doc /* User-defined keywords (CV-02): layer, structural role, mode and lifecycle tags.
               Every `#Tag` used anywhere in this model is declared here. */
        metadata def OA; metadata def SA; metadata def LA; metadata def PA; metadata def EPBS;
        metadata def Mission; metadata def Capability; metadata def Chain; metadata def Actor;
        metadata def Logical; metadata def Behaviour; metadata def Node;
        metadata def Mode; metadata def State;
        metadata def Hazard; metadata def Accepted; metadata def Rule; metadata def MoE; metadata def Estimate; metadata def Variant;
        metadata def Member; metadata def Coordination; metadata def C2; metadata def Configuration;
        metadata def Imposed; metadata def Standard; metadata def Customer;
        metadata def CI_CSCI; metadata def CI_HWCI; metadata def CI_COTS; metadata def CI_TBD;
        // asked for by the brief
        metadata def Budget; metadata def Placeholder;
    }
    package Common {
        doc /* Definitions every layer of SurveillanceDroneSwarm shares: the items that flow between a drone, its peers, the ground station, the operations centre and the environment; the ports and interfaces those flows cross; and one #MoE attribute per measure of effectiveness, each held to its target by a require constraint where the brief states one. Nothing happens here — no parts, no behaviour, no state machines: those belong to a layer. */

        // ---------------------------------------------------------------
        // Value-level attribute definitions
        // ---------------------------------------------------------------

        attribute def TimeStamp {
            doc /* A point in time, used wherever a report, a track or a coordination message has to be placed in time. */
            attribute secondsSinceEpoch : ScalarValues::Real {
                doc /* Seconds since the mission epoch the whole swarm shares. */
            }
        }

        attribute def GeoPosition {
            doc /* Where something is: the position a report places an object at, and the position a drone believes it holds. */
            attribute latitudeDegrees : ScalarValues::Real {
                doc /* Latitude in degrees. */
            }
            attribute longitudeDegrees : ScalarValues::Real {
                doc /* Longitude in degrees. */
            }
            attribute altitudeMetres : ScalarValues::Real {
                doc /* Height above the reference surface in metres. */
            }
            attribute estimatedErrorMetres : ScalarValues::Real {
                doc /* How far out the position may be — the figure that grows while satellite positioning is unavailable. */
            }
        }

        attribute def Identifier {
            doc /* A name something in the model is known by across drones, the ground station and the operations centre. */
            attribute label : ScalarValues::String {
                doc /* The identifying text itself. */
            }
        }

        attribute def MemberId :> Identifier {
            doc /* Which drone of the twelve is meant. */
        }

        attribute def SensorId :> Identifier {
            doc /* Which sensor on a drone is meant, so a degraded sensor's reports can be found again. */
        }

        attribute def TrackId :> Identifier {
            doc /* The one identity the swarm reports for an object it is watching. */
        }

        attribute def SectorId :> Identifier {
            doc /* Which sector of the tasked area is meant. */
        }

        attribute def ReportKey :> Identifier {
            doc /* The key a detection report is acknowledged and recorded under; it is carried beside a report rather than inside it, because the brief fixes the report's fields exactly. */
        }

        attribute def ConfidenceLevel :> ScalarValues::Real {
            doc /* How sure a classification is, between 0 and 1, compared against the reporting threshold in force. */
        }

        attribute def ReportingThreshold :> ConfidenceLevel {
            doc /* The least confidence a classification needs before it becomes a report; below it the answer is Unknown. */
        }

        attribute def ClassifierVersion {
            doc /* Which build of the classifier produced a class, so mixed versions across the fleet are visible. */
            attribute versionTag : ScalarValues::String {
                doc /* The released version name. */
            }
            attribute buildHash : ScalarValues::String {
                doc /* The exact build the drone runs, so two drones claiming one version can still be told apart. */
            }
        }

        attribute def MissionWindow {
            doc /* The span of time a tasking is valid over. */
            attribute startTime : TimeStamp {
                doc /* When the watch is to begin. */
            }
            attribute endTime : TimeStamp {
                doc /* When the watch may end. */
            }
        }

        attribute def SectorDefinition {
            doc /* One sector of the tasked area: what a drone is assigned to watch. */
            attribute sectorId : SectorId {
                doc /* Which sector this is. */
            }
            attribute areaSquareKilometres : ScalarValues::Real {
                doc /* How much area the sector holds, against the 3.0 km² a drone keeps under watch at once. */
            }
            attribute centre : GeoPosition {
                doc /* The point a drone transits to in order to watch this sector. */
            }
        }

        attribute def GeofenceBoundary {
            doc /* The edge of the cleared airspace, as a drone carries it. */
            attribute boundaryVertices : ScalarValues::String {
                doc /* The vertices of the cleared volume in the form the drone holds them. */
            }
            attribute ceilingMetres : ScalarValues::Real {
                doc /* The upper limit of the cleared volume. */
            }
        }

        enum def ObjectClass {
            doc /* The classes a detection may be reported as. Unknown is a first-class answer, not a failure: a detection that cannot be classified with enough confidence is reported Unknown rather than forced into a class. */
            enum Unknown;
            enum Person;
            enum GroundVehicle;
            enum Vessel;
            enum Aircraft;
            enum Animal;
        }

        // ---------------------------------------------------------------
        // Items the brief fixes the fields of
        // ---------------------------------------------------------------

        item def DetectionReport {
            doc /* What a drone reports when it detects and classifies a moving object. The brief lists these fields, and these are exactly the fields it carries. */
            attribute position : GeoPosition {
                doc /* Where the detected object was, as the reporting drone knew its own position at the time. */
            }
            attribute time : TimeStamp {
                doc /* When the detection was made. */
            }
            attribute objectClass : ObjectClass {
                doc /* One of the known classes, or Unknown when the classification did not reach the reporting threshold. */
            }
            attribute confidence : ConfidenceLevel {
                doc /* How sure the classification is, compared against the reporting threshold in force. */
            }
            attribute sensorId : SensorId {
                doc /* Which sensor the detection came from, so a degraded sensor's reports can be found. */
            }
            attribute memberId : MemberId {
                doc /* Which drone reported it. */
            }
            attribute classifierVersion : ClassifierVersion {
                doc /* The classifier version that produced the class, so mixed versions across the fleet are visible. */
            }
            attribute ageSeconds : ScalarValues::Real {
                doc /* How long ago the detection was made, at the moment the report is read — the figure the 60-second placeholder is measured against. */
            }
        }

        item def Track {
            doc /* One object the swarm is watching, held as a single identity across correlation between drones and handover between sectors. The brief lists these fields, and these are exactly the fields it carries. */
            attribute trackId : TrackId {
                doc /* The one identity the swarm reports for an object. */
            }
            attribute lastSeenTime : TimeStamp {
                doc /* When anything last saw the object on this track. */
            }
            attribute stale : ScalarValues::Boolean {
                doc /* Set once nothing has been seen for the stale threshold — 120 seconds, a placeholder awaiting the customer's number. */
            }
        }

        // ---------------------------------------------------------------
        // Items that cross the link to the operations centre
        // ---------------------------------------------------------------

        item def SurveillanceTasking {
            doc /* What the operations centre tasks the swarm with: the area, its sectors and the mission window. */
            attribute taskingId : Identifier {
                doc /* Which tasking this is, so a later one supersedes an earlier one unambiguously. */
            }
            attribute areaSquareKilometres : ScalarValues::Real {
                doc /* How large the tasked area is, up to 25 km². */
            }
            attribute sectors : SectorDefinition[1..*] {
                doc /* The sectors the area is divided into; at any moment at least one drone watches each. */
            }
            attribute window : MissionWindow {
                doc /* The mission window the watch is to be held over. */
            }
            attribute issuedAt : TimeStamp {
                doc /* When the operations centre issued the tasking. */
            }
        }

        item def SupervisoryCommand {
            doc /* What the operator commands without flying a drone: priorities, a sector to look at more closely, and the rule for what to report. */
            attribute priorityOrder : ScalarValues::String {
                doc /* What the operator wants attended to first. */
            }
            attribute focusSector : SectorId {
                doc /* A sector to look at more closely than the rest. */
            }
            attribute reportingThreshold : ReportingThreshold {
                doc /* The least confidence a classification needs before it becomes a report. */
            }
            attribute issuedAt : TimeStamp {
                doc /* When the command was issued, so the threshold in force at any report is known. */
            }
        }

        item def RecallOrder {
            doc /* An order to recall and land, for the whole swarm or one drone, issuable at any time; once it is received the drone does not watch again until it has landed. */
            attribute wholeSwarm : ScalarValues::Boolean {
                doc /* True when the whole swarm is recalled, false when one drone is. */
            }
            attribute targetMember : MemberId {
                doc /* Which drone is recalled when the order is not for the whole swarm. */
            }
            attribute recoveryPoint : GeoPosition {
                doc /* Where the recalled drone is to land. */
            }
            attribute issuedAt : TimeStamp {
                doc /* When the recall was issued. */
            }
        }

        item def ReportAcknowledgement {
            doc /* The operations centre's confirmation of a detection report, so nothing is lost in a link gap and an unacknowledged report is held and re-sent. */
            attribute reportKey : ReportKey {
                doc /* Which report is being acknowledged. */
            }
            attribute acknowledgedBy : ScalarValues::String {
                doc /* Who at the operations centre acknowledged it — the name the decision record keeps. */
            }
            attribute acknowledgedAt : TimeStamp {
                doc /* When it was acknowledged. */
            }
        }

        item def TriagedAlert {
            doc /* A report as it reaches the operator after triage: ranked by how likely it is to matter, with duplicates merged, so the alert rate stays inside what one operator can judge. */
            attribute reportKey : ReportKey {
                doc /* Which report this alert stands for. */
            }
            attribute priorityRank : ScalarValues::Integer {
                doc /* Where this alert sits in the order presented to the operator; 1 is first. */
            }
            attribute mergedReportCount : ScalarValues::Integer {
                doc /* How many duplicate reports were merged into this one alert. */
            }
            attribute raisedAt : TimeStamp {
                doc /* When the alert was put in front of the operator. */
            }
            item summarisedReport : DetectionReport {
                doc /* The report the alert presents, carried whole so the operator judges what the drone actually said. */
            }
        }

        item def DecisionRecord {
            doc /* What is kept for every report so that a classification can be accounted for afterwards: the frames it came from, the classifier version, the reporting threshold in force, and who acknowledged it. */
            attribute reportKey : ReportKey {
                doc /* Which report this record is about. */
            }
            attribute frameReferences : ScalarValues::String[1..*] {
                doc /* The frames the detection came from, identified so they can be retrieved. */
            }
            attribute classifierVersion : ClassifierVersion {
                doc /* The classifier version that produced the class. */
            }
            attribute thresholdInForce : ReportingThreshold {
                doc /* The reporting threshold that was in force when the report was raised. */
            }
            attribute acknowledgedBy : ScalarValues::String {
                doc /* Who acknowledged the report at the operations centre. */
            }
            attribute recordedAt : TimeStamp {
                doc /* When the record was written. */
            }
        }

        item def MemberStatus {
            doc /* What one drone says about itself: where it is, what it is doing, how long it can stay up, and what about it is degraded. */
            attribute memberId : MemberId {
                doc /* Which drone this is about. */
            }
            attribute position : GeoPosition {
                doc /* Where the drone believes it is, with the error it believes that position carries. */
            }
            attribute assignedSector : SectorId {
                doc /* Which sector it is watching, or is transiting to. */
            }
            attribute activity : ScalarValues::String {
                doc /* What it is doing: watching, transiting, recharging, landed, returning. */
            }
            attribute enduranceRemainingMinutes : ScalarValues::Real {
                doc /* How much of the 40 minutes is left, including the transit home. */
            }
            attribute classifierVersion : ClassifierVersion {
                doc /* Which classifier version this drone runs, so mixed versions across the fleet are visible. */
            }
            attribute navigationDegraded : ScalarValues::Boolean {
                doc /* True while the drone has no satellite positioning. */
            }
            attribute sensingDegraded : ScalarValues::Boolean {
                doc /* True while the drone's sensors cannot be trusted as they are. */
            }
            attribute isolated : ScalarValues::Boolean {
                doc /* True while the drone is cut off from the other drones. */
            }
            attribute quarantined : ScalarValues::Boolean {
                doc /* True while the drone has failed admission and takes no part in coordination. */
            }
            attribute heldReportCount : ScalarValues::Integer {
                doc /* How many reports the drone is holding because the link is down. */
            }
            attribute reportedAt : TimeStamp {
                doc /* When the drone said this. */
            }
        }

        item def SwarmStatusPicture {
            doc /* The picture one operator supervises the whole swarm from: where every drone is, what it is doing, how much coverage there is and what is degraded. */
            attribute coverageFraction : ScalarValues::Real {
                doc /* The share of the tasked area under watch at the moment the picture was compiled. */
            }
            attribute airborneCount : ScalarValues::Integer {
                doc /* How many of the twelve are in the air. */
            }
            attribute degradedCount : ScalarValues::Integer {
                doc /* How many are degraded in navigation, sensing, isolation or quarantine. */
            }
            attribute meshDegraded : ScalarValues::Boolean {
                doc /* True while a share of the links between drones is jammed. */
            }
            attribute compiledAt : TimeStamp {
                doc /* When the picture was compiled, so the operator knows how old it is. */
            }
            item memberStates : MemberStatus[0..*] {
                doc /* What each drone last said about itself. */
            }
        }

        // ---------------------------------------------------------------
        // Items the drones exchange with each other over the mesh
        // ---------------------------------------------------------------

        item def CoordinationMessage {
            doc /* Anything one drone sends another over the mesh. Everything the members settle between themselves specialises this, so one mesh port carries all of it. */
            attribute senderId : MemberId {
                doc /* Which drone sent it. */
            }
            attribute sentAt : TimeStamp {
                doc /* When it was sent. */
            }
            attribute sequenceNumber : ScalarValues::Integer {
                doc /* Where it sits in the sender's stream, so loss over a jammed mesh is visible. */
            }
        }

        item def SectorHandover :> CoordinationMessage {
            doc /* A drone leaving to recharge hands its sector to one arriving, without a gap in coverage. */
            attribute sector : SectorId {
                doc /* Which sector changes hands. */
            }
            attribute relinquishingMember : MemberId {
                doc /* The drone giving the sector up. */
            }
            attribute assumingMember : MemberId {
                doc /* The drone taking the sector on. */
            }
            attribute effectiveAt : TimeStamp {
                doc /* When the handover takes effect, so neither drone leaves before the other arrives. */
            }
        }

        item def RechargeRotationProposal :> CoordinationMessage {
            doc /* Who goes to recharge next, so that the airborne share never falls below what the sectors need. */
            attribute proposedMember : MemberId {
                doc /* The drone proposed to go next. */
            }
            attribute proposedDepartureTime : TimeStamp {
                doc /* When it would leave its sector. */
            }
            attribute airborneShareAfter : ScalarValues::Real {
                doc /* The share of the fleet still airborne if this rotation is taken. */
            }
        }

        item def CoverageRedistributionPlan :> CoordinationMessage {
            doc /* When a drone is lost, how the remaining ones re-spread over the sectors so that the loss of coverage is bounded. */
            attribute lostMember : MemberId {
                doc /* The drone that has been lost. */
            }
            attribute sectorAssignments : ScalarValues::String {
                doc /* Which drone takes which sector under the new spread. */
            }
            attribute expectedCoverageFraction : ScalarValues::Real {
                doc /* The coverage the plan expects to hold, against the bound on how much may drop. */
            }
        }

        item def DeconflictionAdvisory :> CoordinationMessage {
            doc /* How two drones keep apart in the air and at the recharge point. */
            attribute conflictingMember : MemberId {
                doc /* The other drone in the conflict. */
            }
            attribute separationMetres : ScalarValues::Real {
                doc /* How far apart they are now. */
            }
            attribute avoidanceManoeuvre : ScalarValues::String {
                doc /* What the receiving drone is asked to do to keep the separation. */
            }
        }

        item def RelayedTraffic :> CoordinationMessage {
            doc /* A drone out of range of the ground station passes its reports and status through a neighbour. */
            attribute originMember : MemberId {
                doc /* The drone whose traffic this is. */
            }
            attribute hopCount : ScalarValues::Integer {
                doc /* How many drones the traffic has already passed through — what the report age at the operations centre grows with. */
            }
            item relayedReports : DetectionReport[0..*] {
                doc /* The reports being passed on. */
            }
            item relayedStatus : MemberStatus[0..1] {
                doc /* The status being passed on. */
            }
        }

        item def TrackCorrelationHint :> CoordinationMessage {
            doc /* What one drone tells another so that two drones seeing the same object report one track, not two. */
            attribute candidateTrackId : TrackId {
                doc /* The track the sender believes the other drone's object is the same as. */
            }
            attribute matchConfidence : ConfidenceLevel {
                doc /* How sure the sender is that the two are the same object. */
            }
            item observedTrack : Track {
                doc /* The track as the sender holds it. */
            }
        }

        item def TrackHandover :> CoordinationMessage {
            doc /* When an object moves from one sector to the next, the drone watching the next sector takes over the track without losing it. */
            attribute fromSector : SectorId {
                doc /* The sector the object is leaving. */
            }
            attribute toSector : SectorId {
                doc /* The sector the object is entering. */
            }
            attribute assumingMember : MemberId {
                doc /* The drone taking the track on. */
            }
            item handedTrack : Track {
                doc /* The track being handed over, so its identity survives the crossing. */
            }
        }

        item def AdmissionExchange :> CoordinationMessage {
            doc /* A drone joins the coordination only after the others have authenticated it; one that fails is quarantined and takes no part until it has been readmitted. */
            attribute candidateMember : MemberId {
                doc /* The drone asking to join. */
            }
            attribute challengeNonce : ScalarValues::String {
                doc /* The challenge the others put to it. */
            }
            attribute credentialToken : ScalarValues::String {
                doc /* The answer the candidate gives, which the others check. */
            }
            attribute admitted : ScalarValues::Boolean {
                doc /* True when the candidate is admitted, false when it is quarantined. */
            }
        }

        // ---------------------------------------------------------------
        // Items that cross the boundary to the rest of the environment
        // ---------------------------------------------------------------

        item def AirspaceClearance {
            doc /* What the airspace authority grants and withdraws: when and where anything may fly. */
            attribute clearanceId : Identifier {
                doc /* Which clearance this is. */
            }
            attribute boundary : GeofenceBoundary {
                doc /* The volume that is cleared. */
            }
            attribute validFrom : TimeStamp {
                doc /* When the clearance begins. */
            }
            attribute validUntil : TimeStamp {
                doc /* When the clearance ends, after which nothing watches until it has landed. */
            }
            attribute issuedBy : ScalarValues::String {
                doc /* Which authority issued it. */
            }
        }

        item def SensorObservation {
            doc /* What a drone's sensors give it of the scene: the frames detection and classification are made from, and that the decision record refers back to. */
            attribute frameId : Identifier {
                doc /* Which frame this is, so a decision record can name it. */
            }
            attribute capturedAt : TimeStamp {
                doc /* When the frame was captured. */
            }
            attribute sensorId : SensorId {
                doc /* Which sensor captured it. */
            }
            attribute sceneQuality : ScalarValues::Real {
                doc /* How well the scene can be told apart in this frame, as lighting, weather and misleading paint or shapes degrade it. */
            }
        }

        item def GroundServicingRequest {
            doc /* A drone asking the ground crew for the turnaround that puts it back in the air: batteries swapped, not charged in place. */
            attribute memberId : MemberId {
                doc /* Which drone is asking. */
            }
            attribute requestedAt : TimeStamp {
                doc /* When it asked. */
            }
            attribute recoveryPoint : GeoPosition {
                doc /* Where it is landing to be serviced. */
            }
            attribute batterySwapRequired : ScalarValues::Boolean {
                doc /* True for the ordinary 20-minute swap; false when the drone is landing for another reason. */
            }
        }

        item def GroundServicingConfirmation {
            doc /* The ground crew's answer: the drone is serviced and how much flying it has. */
            attribute memberId : MemberId {
                doc /* Which drone was serviced. */
            }
            attribute servicedAt : TimeStamp {
                doc /* When the turnaround finished. */
            }
            attribute enduranceAvailableMinutes : ScalarValues::Real {
                doc /* How many minutes of flight the fitted battery gives. */
            }
        }

        // ---------------------------------------------------------------
        // Port definitions
        // ---------------------------------------------------------------

        port def MeshPort {
            doc /* What one drone exchanges with a peer over the mesh radio. It carries everything the members settle between themselves and does not depend on the link to the operations centre. */
            out item update : CoordinationMessage {
                doc /* A coordination message to a peer; the peer receives it through the conjugate of this port. */
            }
        }

        port def MemberGroundPort {
            doc /* What one drone exchanges with the ground station over the intermittent radio link. */
            out item report : DetectionReport {
                doc /* A detection report on its way to the operations centre. */
            }
            out item memberStatus : MemberStatus {
                doc /* Where the drone is, what it is doing and what about it is degraded. */
            }
            in item tasking : SurveillanceTasking {
                doc /* The area, its sectors and the mission window. */
            }
            in item supervisoryCommand : SupervisoryCommand {
                doc /* Priorities, a focus sector and the reporting threshold. */
            }
            in item recall : RecallOrder {
                doc /* The order to recall and land. */
            }
            in item acknowledgement : ReportAcknowledgement {
                doc /* Confirmation that a report arrived, so a held report can be released. */
            }
        }

        port def OperationsCentrePort {
            doc /* What the ground station exchanges with the operations centre: everything the operator gives the swarm and everything the swarm puts in front of the operator. */
            out item alert : TriagedAlert {
                doc /* A triaged alert, ranked and with duplicates merged. */
            }
            out item picture : SwarmStatusPicture {
                doc /* The status picture one operator supervises the whole swarm from. */
            }
            out item record : DecisionRecord {
                doc /* The decision record kept for a report. */
            }
            out item reportedTrack : Track {
                doc /* One track per object, for merging with the fixed camera network's tracks at the operations centre. */
            }
            in item tasking : SurveillanceTasking {
                doc /* The tasking the operations centre gives. */
            }
            in item supervisoryCommand : SupervisoryCommand {
                doc /* The supervisory command the operator gives. */
            }
            in item recall : RecallOrder {
                doc /* The recall the operator may issue at any time. */
            }
            in item acknowledgement : ReportAcknowledgement {
                doc /* The operations centre's acknowledgement of a report. */
            }
        }

        port def AirspaceClearancePort {
            doc /* Where the cleared airspace enters the system: what the airspace authority grants and withdraws. */
            in item clearance : AirspaceClearance {
                doc /* The clearance in force, which bounds when and where anything may fly. */
            }
        }

        port def SceneObservationPort {
            doc /* Where the watched scene enters a drone: the frames its sensors give it. */
            in item observation : SensorObservation {
                doc /* A frame of the scene, with how well it can be told apart. */
            }
        }

        port def GroundServicingPort {
            doc /* Where a drone meets the ground crew for the battery swap that puts it back in the air. */
            out item servicingRequest : GroundServicingRequest {
                doc /* The drone asking for a turnaround. */
            }
            in item servicingConfirmation : GroundServicingConfirmation {
                doc /* The crew's answer, with the endurance the fitted battery gives. */
            }
        }

        // ---------------------------------------------------------------
        // Interface definitions
        // ---------------------------------------------------------------

        interface def MeshInterface {
            doc /* Joins two drones over the mesh radio. This is the bearer coordination survives on when the ground link drops. */
            end sender : MeshPort {
                doc /* The drone sending the coordination message. */
            }
            end receiver : ~MeshPort {
                doc /* The peer drone receiving it. */
            }
        }

        interface def GroundLinkInterface {
            doc /* Joins a drone to the ground station over the radio link that is not always available; the swarm has to keep working through a gap and reconcile afterwards. */
            end airborneEnd : MemberGroundPort {
                doc /* The drone's end of the link. */
            }
            end groundEnd : ~MemberGroundPort {
                doc /* The ground station's end of the link. */
            }
        }

        interface def OperationsCentreInterface {
            doc /* Joins the ground station to the operations centre, where the operator tasks, commands, recalls, watches and acknowledges. */
            end stationEnd : OperationsCentrePort {
                doc /* The ground station's end. */
            }
            end centreEnd : ~OperationsCentrePort {
                doc /* The operations centre's end. */
            }
        }

        interface def AirspaceAuthorityInterface {
            doc /* Joins the system to the airspace authority whose clearance constrains when and where anything may fly. */
            end systemEnd : AirspaceClearancePort {
                doc /* The system's end, which receives the clearance. */
            }
            end authorityEnd : ~AirspaceClearancePort {
                doc /* The authority's end, which issues and withdraws it. */
            }
        }

        interface def SceneObservationInterface {
            doc /* Joins a drone's sensing to the watched scene, whatever lighting, weather and misleading paint or shapes do to it. */
            end sensingEnd : SceneObservationPort {
                doc /* The drone's end, which takes the frames. */
            }
            end sceneEnd : ~SceneObservationPort {
                doc /* The scene's end, which yields them. */
            }
        }

        interface def GroundServicingInterface {
            doc /* Joins a landed drone to the ground crew for the roughly 20-minute battery swap. */
            end memberEnd : GroundServicingPort {
                doc /* The drone's end. */
            }
            end crewEnd : ~GroundServicingPort {
                doc /* The ground crew's end. */
            }
        }

        // ---------------------------------------------------------------
        // Measures of effectiveness — scored between the two architectures
        // ---------------------------------------------------------------

        #MoE attribute areaUnderWatchFraction : ScalarValues::Real {
            doc /* The share of the tasked area under watch at any moment. The brief states at least 0.9. It follows arithmetically from how many drones are airborne and the 3.0 km² each keeps under watch, so it separates the two architectures by how well each keeps sectors filled while members rotate to recharge. */
        }
        require constraint areaUnderWatchTarget {
            doc /* At any moment at least 0.9 of the area must be under watch. */
            areaUnderWatchFraction >= 0.9
        }

        #MoE attribute coverageLossAfterMemberLossFraction : ScalarValues::Real {
            doc /* The share of coverage lost when one drone is lost, before the swarm re-spreads. The brief states no more than 0.25; how quickly redistribution is agreed is where ground-held and member-held coordination differ most. */
        }
        require constraint coverageLossAfterMemberLossTarget {
            doc /* When one drone is lost, no more than 0.25 of the coverage may drop before the swarm re-spreads. */
            coverageLossAfterMemberLossFraction <= 0.25
        }

        #MoE #Placeholder attribute coverageUnderMeshJammingFraction : ScalarValues::Real {
            doc /* The share of the area still under watch with half the links between drones jammed. 0.75 is a placeholder awaiting the customer's number: a design meeting it has met a placeholder, nothing more. */
        }
        require constraint coverageUnderMeshJammingTarget {
            doc /* With half the links between drones jammed, at least 0.75 of the area must stay under watch — placeholder. */
            coverageUnderMeshJammingFraction >= 0.75
        }

        #MoE #Placeholder attribute reportAgeAtOperationsCentreSeconds : ScalarValues::Real {
            doc /* How old a report is when it reaches the operations centre with the link up. 60 seconds is a placeholder awaiting the customer's number; relay hop count and where triage runs drive it. */
        }
        require constraint reportAgeAtOperationsCentreTarget {
            doc /* With the link up, a report is no older than 60 seconds when it reaches the operations centre — placeholder. */
            reportAgeAtOperationsCentreSeconds <= 60.0
        }

        #MoE #Placeholder attribute positionErrorWithoutSatelliteMetres : ScalarValues::Real {
            doc /* A drone's position error after ten minutes without satellite positioning, navigating by camera against stored maps. 50 m is a placeholder awaiting the customer's number; it decides whether reports place objects where they are. */
        }
        require constraint positionErrorWithoutSatelliteTarget {
            doc /* After 10 minutes without satellite positioning, a drone's position error must stay within 50 m — placeholder. */
            positionErrorWithoutSatelliteMetres <= 50.0
        }

        #MoE #Placeholder attribute reportHoldWhileCutOffMinutes : ScalarValues::Real {
            doc /* How long a drone holds its reports while cut off from the operations centre without losing any. 30 minutes is a placeholder awaiting the customer's number. */
        }
        require constraint reportHoldWhileCutOffTarget {
            doc /* While cut off, a drone holds its reports for at least 30 minutes and loses none — placeholder. */
            reportHoldWhileCutOffMinutes >= 30.0
        }

        #MoE #Placeholder attribute missedDetectionFraction : ScalarValues::Real {
            doc /* The share of real objects that go undetected. 0.10 is a placeholder awaiting the customer's number, and it trades against the reporting threshold and the false-alarm rate. */
        }
        require constraint missedDetectionTarget {
            doc /* No more than 0.10 of real objects may go undetected — placeholder. */
            missedDetectionFraction <= 0.10
        }

        #MoE #Placeholder attribute falseAlarmsPerHour : ScalarValues::Real {
            doc /* False alarms reaching the operator each hour. 2 per hour is a placeholder awaiting the customer's number, and it is the other side of the missed-detection trade. */
        }
        require constraint falseAlarmsPerHourTarget {
            doc /* No more than 2 false alarms per hour may reach the operator — placeholder. */
            falseAlarmsPerHour <= 2.0
        }

        #MoE #Placeholder attribute alertsReachingOperatorPerHour : ScalarValues::Real {
            doc /* How many alerts reach the operator each hour after triage. 20 per hour is a placeholder awaiting the customer's number, and it is what triage is scored on against operator overload. */
        }
        require constraint alertsReachingOperatorTarget {
            doc /* No more alerts may reach the operator than the 20 per hour they can judge — placeholder. */
            alertsReachingOperatorPerHour <= 20.0
        }

        #MoE #Placeholder attribute acknowledgedReportsThatMatterFraction : ScalarValues::Real {
            doc /* The share of reports the operator acknowledges that turn out to matter. 0.8 is a placeholder awaiting the customer's number; it measures whether triage ranks the right things first. */
        }
        require constraint acknowledgedReportsThatMatterTarget {
            doc /* At least 0.8 of the reports the operator acknowledges must turn out to matter — placeholder. */
            acknowledgedReportsThatMatterFraction >= 0.8
        }

        #MoE #Placeholder attribute onboardClassificationCostUsdPerMember : ScalarValues::Real {
            doc /* What the on-board computing for classification costs per drone. 300 USD is a placeholder awaiting the customer's number; it decides how much classification can sit on the member rather than the ground. */
        }
        require constraint onboardClassificationCostTarget {
            doc /* The on-board computing for classification may cost no more than 300 USD per drone — placeholder. */
            onboardClassificationCostUsdPerMember <= 300.0
        }

        #MoE attribute unattendedWatchDurationHours : ScalarValues::Real {
            doc /* How long the swarm holds the watch before it needs people. The brief asks for this but states no number, so it has no target and no require constraint: the customer's figure is awaited. Each layer still estimates it and reports the estimate; nothing is met or missed against it until that figure comes. */
        }

        // ---------------------------------------------------------------
        // Budgets — what the brief fixes. Declared, never scored.
        // ---------------------------------------------------------------

        #Budget attribute fleetSizeMembers : ScalarValues::Integer {
            doc /* Twelve drones is the fleet the design has to work with; the brief fixes it. */
        }
        require constraint fleetSizeBudget {
            doc /* We can field 12 drones. */
            fleetSizeMembers <= 12
        }

        #Budget attribute memberEnduranceMinutes : ScalarValues::Real {
            doc /* Each drone flies about 40 minutes, and the transit out and back is spent from the same 40 minutes as the watching. Read together with the 18 m/s cruise speed below, this says whether a member reaches its sector and returns inside its endurance. */
        }
        require constraint memberEnduranceBudget {
            doc /* No design may assume more than the 40 minutes of flight a drone has. */
            memberEnduranceMinutes <= 40.0
        }

        #Budget attribute groundTurnaroundMinutes : ScalarValues::Real {
            doc /* About 20 minutes on the ground, because the batteries are swapped, not charged in place; the airborne share follows from this and the endurance. */
        }
        require constraint groundTurnaroundBudget {
            doc /* No design may assume a turnaround shorter than the 20 minutes the battery swap takes. */
            groundTurnaroundMinutes >= 20.0
        }

        #Budget attribute cruiseSpeedMetresPerSecond : ScalarValues::Real {
            doc /* A drone cruises at about 18 m/s between its recharge point and its sector. The brief fixes it; without it nothing can say whether a member reaches its station and returns inside the 40-minute endurance over an area several kilometres across. */
        }
        require constraint cruiseSpeedBudget {
            doc /* No design may assume a cruise faster than 18 m/s. */
            cruiseSpeedMetresPerSecond <= 18.0
        }

        #Budget attribute instantaneousFootprintSquareKilometres : ScalarValues::Real {
            doc /* About 3.0 km² under watch at once from watch altitude; this is what makes the coverage figure arithmetic rather than a hope. */
        }
        require constraint instantaneousFootprintBudget {
            doc /* No design may assume more than 3.0 km² under watch from one drone at once. */
            instantaneousFootprintSquareKilometres <= 3.0
        }

        #Budget attribute areaOfInterestSquareKilometres : ScalarValues::Real {
            doc /* The area of interest is up to 25 km², divided into sectors; the brief fixes it as the size the design must cover. */
        }
        require constraint areaOfInterestBudget {
            doc /* The tasked area is up to 25 km². */
            areaOfInterestSquareKilometres <= 25.0
        }

        #Budget #Placeholder attribute operatorSecondsPerAlert : ScalarValues::Real {
            doc /* The operator needs at least 30 seconds for each alert. The brief fixes this as the time an operator has — a placeholder awaiting the customer's number — so it is declared and never scored. */
        }
        require constraint operatorSecondsPerAlertBudget {
            doc /* The operator needs at least 30 seconds to judge each alert — placeholder. */
            operatorSecondsPerAlert >= 30.0
        }

        #Budget #Placeholder attribute trackStaleAfterSeconds : ScalarValues::Real {
            doc /* A track is marked stale once nothing has been seen for 120 seconds. The brief fixes this threshold and marks it a placeholder awaiting the customer's number. */
        }
        require constraint trackStaleAfterBudget {
            doc /* A track's stale flag is set no later than 120 seconds after anything last saw the object — placeholder. */
            trackStaleAfterSeconds <= 120.0
        }

        #Budget #Placeholder attribute satellitePositioningOutageMinutes : ScalarValues::Real {
            doc /* The ten minutes without satellite positioning the position-error measure is taken over. It is a test condition from the same placeholder statement as the 50 m figure, not something to be better at. */
        }
        require constraint satellitePositioningOutageBudget {
            doc /* The position-error measure is taken after 10 minutes without satellite positioning: the test condition, held equal, not a floor — placeholder. */
            satellitePositioningOutageMinutes == 10.0
        }

        #Budget #Placeholder attribute meshLinksJammedFraction : ScalarValues::Real {
            doc /* The half of the links between drones jammed that the jammed-coverage measure is taken under. It is a test condition from the same placeholder statement as the 0.75 figure. */
        }
        require constraint meshLinksJammedBudget {
            doc /* The jammed-coverage measure is taken with half the links between drones jammed: the test condition, held equal, not a floor — placeholder. */
            meshLinksJammedFraction == 0.5
        }
        // ── shared definitions asked for by OA ──
        item def SectorHandoverProposal { doc /* A drone's proposal to hand a sector, with the watch it carries, to a neighbour. */ }
        item def RechargeRotationSlot { doc /* A drone's place in the recharge rotation: when it leaves and who takes over. */ }
        item def CoverageAssignment { doc /* A share of the tasked area assigned to a drone when coverage is re-spread. */ }
        item def FlightIntent { doc /* A drone's announced flight path and altitude, exchanged to deconflict flight. */ }
        item def TaskingOrder { doc /* Tasking given by the duty controller: the area of interest, its sectors and the mission window. */ }
        item def PriorityDirective { doc /* Supervisory command: priorities, a sector to look at more closely, and the reporting threshold. */ }
        item def RecallDirective { doc /* An order to recall and land the whole swarm or one drone. */ }
        item def ReportReceipt { doc /* The operations centre's acknowledgement of one detection report. */ }
        item def ConditionNotice { doc /* A notice that a condition has changed: positioning, sensing, contact, or mesh jamming. */ }
        // ── shared definitions asked for by SA ──
        item def MovingObjectsInArea { doc /* The objects moving through the tasked area that the swarm must detect, classify and place in time and space. */ }
        item def TriagedAlerts { doc /* Detection reports ranked so that what is most likely to matter reaches the operator first, with duplicates merged. */ }
        item def DecisionRecords { doc /* For every report: the frames it came from, the classifier version, the reporting threshold in force and who acknowledged it. */ }
        item def DroneArrival { doc /* A drone arriving on the ground at the recharge point or the recovery point, to be serviced or recovered by ground crew. */ }
        item def DroneServiced { doc /* A drone handed back to the swarm by ground crew after a battery swap or a recovery. */ }
        item def PositioningStatus { doc /* Whether satellite positioning is available to a drone, so it can tell when it must navigate by camera against stored maps. */ }
        item def SensorHealthStatus { doc /* Whether a drone's sensors can be trusted, so reports from a degraded sensor can be marked as such. */ }
        item def MeshLinkStatus { doc /* The state of a drone's links to the other drones over the mesh: contact lost or regained, and the share of links jammed. */ }
        item def WeatherCondition { doc /* Wind, lighting and weather as sensed on board; above moderate wind the swarm lands. */ }
        // ── shared definitions asked for by LA ──
        item def CoordinationDirective { doc /* A directive from the coordinator to a drone: sector assignment, handover, rotation, redistribution, deconfliction, launch, release, or an admission verdict. */ attribute directiveKind { doc /* Which kind of directive this is. */ } attribute memberId { doc /* The drone the directive is for. */ } attribute sectorId { doc /* The sector the directive concerns, where it has one. */ } attribute effectiveTime { doc /* When the directive takes effect. */ } }
        item def DirectiveAck { doc /* A drone's acknowledgement of one coordination directive. */ attribute memberId { doc /* The drone acknowledging. */ } attribute directiveKind { doc /* The kind of directive acknowledged. */ } attribute ackTime { doc /* When the drone acknowledged. */ } }
        item def AdmissionRequest { doc /* What a drone offers to be admitted to coordination. */ attribute memberId { doc /* Identity the drone claims. */ } attribute classifierVersion { doc /* The classifier version the drone runs. */ } attribute credential { doc /* Proof that the drone is one of the twelve. */ } }
        item def MemberSituationNotice { doc /* A notice of a change in a drone's or the mesh's situation that triggers a transition: positioning lost or back, sensing degraded or restored, contact lost or back, jamming, wind above moderate. */ attribute memberId { doc /* The drone concerned, or empty for the mesh as a whole. */ } attribute situation { doc /* What changed. */ } }
    }
    package OA {
        doc /* Operational analysis: how the tasked area is watched and reported today, without any system named. The entities, what each does, what they exchange, and the operational modes. */

        // ---------- Entities ----------

        #Actor part def DutyController {
            doc /* Operations-centre operator who tasks the swarm, issues supervisory command and recall, and today does sector assignment, handover, re-spread, deconfliction and relay by hand. */
        }
        part dutyController : DutyController {
            doc /* The one operator who supervises the whole swarm. */
        }

        #Actor part def OperationsCentreAnalyst {
            doc /* Judges the alerts that arrive, acknowledges each detection report and merges swarm tracks with the fixed camera network's tracks. */
        }
        part operationsCentreAnalyst : OperationsCentreAnalyst {
            doc /* The analyst at the operations centre. */
        }

        #Actor part def AirspaceAuthority {
            doc /* Grants and withdraws the clearance that says when and where anything may fly. */
        }
        part airspaceAuthority : AirspaceAuthority {
            doc /* The authority whose clearance bounds every flight. */
        }

        #Actor part def GroundCrew {
            doc /* Services drones between sorties, swapping batteries at the recharge point in about 20 minutes, and recovers drones that return on their own. */
        }
        part groundCrew : GroundCrew {
            doc /* The crew at the recharge point and the recovery point. */
        }

        #Actor part def FixedCameraNetworkOperator {
            doc /* Keeps the existing fixed camera network and its own tracks in service. */
        }
        part fixedCameraNetworkOperator : FixedCameraNetworkOperator {
            doc /* The operator of the fixed camera network. */
        }

        #Member part def SwarmMember {
            doc /* One of the twelve identical small drones: about 40 minutes of flight, about 18 m/s cruise, about 3.0 km2 under watch at a time, battery swapped on the ground. Declared once; every member is a usage of it. */
        }

        part watchAsset : SwarmMember [12] {
            doc /* The operational entity that holds the watch over the tasked area: the population of twelve identical drones. */
        }
        part memberA : SwarmMember {
            doc /* First representative of the twelve-drone population watchAsset; not an extra drone. */
        }
        part memberB : SwarmMember {
            doc /* Second representative of the twelve-drone population watchAsset; not an extra drone. */
        }

        #Node part def GroundStationNode {
            doc /* The station that tasks and watches the swarm and shows its status picture. */
        }
        part groundStation : GroundStationNode {
            doc /* The ground station used today. */
        }

        #Node part def MeshRadio {
            doc /* The radio mesh carrying coordination traffic between drones; it does not depend on the link to the operations centre. */
        }
        part meshRadioBetweenDrones : MeshRadio {
            doc /* The mesh radio that carries the traffic between drones. */
        }

        #Node part def GroundLinkRadio {
            doc /* The intermittently available radio link carrying tasking, command, reports, status and acknowledgements to and from the operations centre. */
        }
        part groundLinkToOperationsCentre : GroundLinkRadio {
            doc /* The intermittent link to the operations centre. */
        }

        #Node part def RechargePoint {
            doc /* Where batteries are swapped, not charged in place; about 20 minutes of turnaround. */
        }
        part batterySwapAtRechargePoint : RechargePoint {
            doc /* The recharge point where ground crew swap batteries. */
        }

        #Node part def RecoveryPoint {
            doc /* The point a drone that has lost contact with the swarm returns to on its own rather than becoming a hazard. */
        }
        part recoveryPoint : RecoveryPoint {
            doc /* The recovery point for drones that return on their own. */
        }

        #Node part def FixedCameraNetwork {
            doc /* The existing camera network; it stays and keeps its own tracks, which swarm reports must be mergeable with. */
        }
        part fixedCameraNetwork : FixedCameraNetwork {
            doc /* The existing fixed camera network. */
        }

        // ---------- Coordination between members ----------

        #Coordination action def HandOverSector {
            doc /* A drone hands its sector to a neighbour when it leaves to recharge, so the sector stays watched. */
            out port handoverOut;
            in port handoverIn;
        }
        #Coordination action def RotateRecharge {
            doc /* Members agree who leaves to recharge and who takes the place, so the rotation never empties a sector. */
            out port rotationOut;
            in port rotationIn;
        }
        #Coordination action def RedistributeCoverage {
            doc /* Members re-spread over the area when one is lost or leaves, so the share of area under watch stays high. */
            out port coverageOut;
            in port coverageIn;
        }
        #Coordination action def DeconflictFlight {
            doc /* Members announce flight intent to each other so that two drones do not occupy the same airspace. */
            out port intentOut;
            in port intentIn;
        }
        #Coordination action def RelayReportsThroughNeighbour {
            doc /* A member that cannot reach the operations centre sends its reports through a neighbour that can. */
            out port relayOut;
            in port relayIn;
        }
        #Coordination action def CorrelateTracks {
            doc /* Members agree that tracks seen by different drones are the same object, giving one track per object. */
            out port correlationOut;
            in port correlationIn;
        }
        #Coordination action def HandOverTrack {
            doc /* A track is handed to the drone that watches the sector the object moves into. */
            out port trackHandoverOut;
            in port trackHandoverIn;
        }
        #Coordination action def AdmitMember {
            doc /* A drone is checked before it takes part in coordination; one that fails takes no part until readmitted. */
            out port admissionOut;
            in port admissionIn;
        }

        // ---------- Command and control ----------

        #C2 action def TaskSurveillanceArea {
            doc /* The duty controller tasks the swarm with the area of interest, its sectors and the mission window. */
            out port taskingOut;
        }
        #C2 action def CommandSupervisoryPriorities {
            doc /* The duty controller gives priorities, a sector to look at more closely and the reporting threshold. */
            out port priorityOut;
        }
        #C2 action def RecallAndLand {
            doc /* An order to recall and land the whole swarm or one drone, issuable at any time. */
            out port recallOut;
        }
        #C2 action def PresentStatusPicture {
            doc /* Shows where every drone is, what it is doing, how much of the area is under watch and what is degraded. */
            in port statusIn;
        }
        #C2 action def AcknowledgeDetectionReport {
            doc /* The operations centre confirms each detection report, so nothing is lost in a link gap. */
            in port reportIn;
            out port receiptOut;
        }

        // ---------- Other operational activities ----------

        action def DetectAndClassifyObject {
            doc /* A drone detects a moving object in its sector and classifies it, saying Unknown when confidence is short of the reporting threshold. */
            out port detectionOut;
        }
        action def DeliverDetectionReport {
            doc /* A drone delivers a report with position and time to the operations centre, holds it while cut off, and clears it on acknowledgement. */
            in port detectionIn;
            out port reportOut;
            in port receiptIn;
        }
        action def ApplySupervisoryDirectives {
            doc /* A drone takes up the tasking, priorities and recall given by the duty controller, and lands on recall. */
            in port taskingIn;
            in port priorityIn;
            in port recallIn;
        }
        action def ReportMemberStatus {
            doc /* A drone reports its position, activity and degradations for the status picture. */
            out port statusOut;
        }
        action def ReportTrackPicture {
            doc /* A drone reports the tracks it holds so the analyst can merge them with the camera network's tracks. */
            out port trackPictureOut;
        }
        action def ReturnToRecoveryPoint {
            doc /* A drone that has lost contact with the swarm returns to the recovery point on its own. */
        }
        action def SwapBattery {
            doc /* Ground crew swap a landed drone's battery at the recharge point, about 20 minutes. */
        }
        action def RecoverReturnedDrone {
            doc /* Ground crew recover a drone that returned to the recovery point on its own. */
        }
        action def GrantAirspaceClearance {
            doc /* The airspace authority grants or withdraws the clearance that bounds when and where anything may fly. */
        }
        action def ProvideCameraTracks {
            doc /* The fixed camera network provides its own tracks. */
            out port cameraTrackOut;
        }
        action def MergeSwarmTracks {
            doc /* The analyst merges swarm tracks with the camera network's tracks, one track per object. */
            in port swarmTrackIn;
            in port cameraTrackIn;
        }

        // ---------- Activity usages, written here and allocated to the entity that performs them ----------

        action issueTasking : TaskSurveillanceArea { doc /* Duty controller's tasking activity. */ }
        action issuePriorities : CommandSupervisoryPriorities { doc /* Duty controller's supervisory-command activity. */ }
        action issueRecall : RecallAndLand { doc /* Duty controller's recall activity. */ }
        action presentStatus : PresentStatusPicture { doc /* Ground station's status presentation. */ }
        action acknowledgeReports : AcknowledgeDetectionReport { doc /* Analyst's acknowledgement activity. */ }
        action mergeTracks : MergeSwarmTracks { doc /* Analyst's track merge. */ }
        action provideCameraTracks : ProvideCameraTracks { doc /* Camera network's own track output. */ }
        action swapBatteryAct : SwapBattery { doc /* Ground crew battery swap. */ }
        action recoverDroneAct : RecoverReturnedDrone { doc /* Ground crew recovery of a returned drone. */ }
        action grantClearanceAct : GrantAirspaceClearance { doc /* Airspace authority clearance. */ }

        allocate issueTasking to dutyController;
        allocate issuePriorities to dutyController;
        allocate issueRecall to dutyController;
        allocate presentStatus to groundStation;
        allocate acknowledgeReports to operationsCentreAnalyst;
        allocate mergeTracks to operationsCentreAnalyst;
        allocate provideCameraTracks to fixedCameraNetwork;
        allocate swapBatteryAct to groundCrew;
        allocate recoverDroneAct to groundCrew;
        allocate grantClearanceAct to airspaceAuthority;

        // memberA
        action alphaHandOverSector : HandOverSector { doc /* memberA hands over its sector. */ }
        action alphaRotateRecharge : RotateRecharge { doc /* memberA takes part in the recharge rotation. */ }
        action alphaRedistributeCoverage : RedistributeCoverage { doc /* memberA re-spreads coverage. */ }
        action alphaDeconflictFlight : DeconflictFlight { doc /* memberA deconflicts its flight. */ }
        action alphaRelayReports : RelayReportsThroughNeighbour { doc /* memberA relays reports through a neighbour. */ }
        action alphaCorrelateTracks : CorrelateTracks { doc /* memberA correlates tracks with neighbours. */ }
        action alphaHandOverTrack : HandOverTrack { doc /* memberA hands a track over. */ }
        action alphaAdmitMember : AdmitMember { doc /* memberA takes part in member admission. */ }
        action alphaDetect : DetectAndClassifyObject { doc /* memberA detects and classifies. */ }
        action alphaDeliver : DeliverDetectionReport { doc /* memberA delivers and holds reports. */ }
        action alphaDirectives : ApplySupervisoryDirectives { doc /* memberA takes up directives. */ }
        action alphaStatus : ReportMemberStatus { doc /* memberA reports its status. */ }
        action alphaTrackPicture : ReportTrackPicture { doc /* memberA reports its tracks. */ }
        action alphaReturn : ReturnToRecoveryPoint { doc /* memberA returns to the recovery point when cut off. */ }

        allocate alphaHandOverSector to memberA;
        allocate alphaRotateRecharge to memberA;
        allocate alphaRedistributeCoverage to memberA;
        allocate alphaDeconflictFlight to memberA;
        allocate alphaRelayReports to memberA;
        allocate alphaCorrelateTracks to memberA;
        allocate alphaHandOverTrack to memberA;
        allocate alphaAdmitMember to memberA;
        allocate alphaDetect to memberA;
        allocate alphaDeliver to memberA;
        allocate alphaDirectives to memberA;
        allocate alphaStatus to memberA;
        allocate alphaTrackPicture to memberA;
        allocate alphaReturn to memberA;

        // memberB
        action bravoHandOverSector : HandOverSector { doc /* memberB hands over its sector. */ }
        action bravoRotateRecharge : RotateRecharge { doc /* memberB takes part in the recharge rotation. */ }
        action bravoRedistributeCoverage : RedistributeCoverage { doc /* memberB re-spreads coverage. */ }
        action bravoDeconflictFlight : DeconflictFlight { doc /* memberB deconflicts its flight. */ }
        action bravoRelayReports : RelayReportsThroughNeighbour { doc /* memberB relays reports through a neighbour. */ }
        action bravoCorrelateTracks : CorrelateTracks { doc /* memberB correlates tracks with neighbours. */ }
        action bravoHandOverTrack : HandOverTrack { doc /* memberB hands a track over. */ }
        action bravoAdmitMember : AdmitMember { doc /* memberB takes part in member admission. */ }
        action bravoDetect : DetectAndClassifyObject { doc /* memberB detects and classifies. */ }
        action bravoDeliver : DeliverDetectionReport { doc /* memberB delivers and holds reports. */ }
        action bravoDirectives : ApplySupervisoryDirectives { doc /* memberB takes up directives. */ }
        action bravoStatus : ReportMemberStatus { doc /* memberB reports its status. */ }
        action bravoTrackPicture : ReportTrackPicture { doc /* memberB reports its tracks. */ }
        action bravoReturn : ReturnToRecoveryPoint { doc /* memberB returns to the recovery point when cut off. */ }

        allocate bravoHandOverSector to memberB;
        allocate bravoRotateRecharge to memberB;
        allocate bravoRedistributeCoverage to memberB;
        allocate bravoDeconflictFlight to memberB;
        allocate bravoRelayReports to memberB;
        allocate bravoCorrelateTracks to memberB;
        allocate bravoHandOverTrack to memberB;
        allocate bravoAdmitMember to memberB;
        allocate bravoDetect to memberB;
        allocate bravoDeliver to memberB;
        allocate bravoDirectives to memberB;
        allocate bravoStatus to memberB;
        allocate bravoTrackPicture to memberB;
        allocate bravoReturn to memberB;

        // ---------- What members exchange with each other (over the mesh) ----------

        flow handOverSectorAtoB of Common::SectorHandoverProposal from alphaHandOverSector.handoverOut to bravoHandOverSector.handoverIn { doc /* memberA proposes a sector handover to memberB. */ }
        flow handOverSectorBtoA of Common::SectorHandoverProposal from bravoHandOverSector.handoverOut to alphaHandOverSector.handoverIn { doc /* memberB proposes a sector handover to memberA. */ }
        flow rotateRechargeAtoB of Common::RechargeRotationSlot from alphaRotateRecharge.rotationOut to bravoRotateRecharge.rotationIn { doc /* memberA tells memberB its place in the recharge rotation. */ }
        flow rotateRechargeBtoA of Common::RechargeRotationSlot from bravoRotateRecharge.rotationOut to alphaRotateRecharge.rotationIn { doc /* memberB tells memberA its place in the recharge rotation. */ }
        flow redistributeCoverageAtoB of Common::CoverageAssignment from alphaRedistributeCoverage.coverageOut to bravoRedistributeCoverage.coverageIn { doc /* memberA sends its share of coverage to memberB. */ }
        flow redistributeCoverageBtoA of Common::CoverageAssignment from bravoRedistributeCoverage.coverageOut to alphaRedistributeCoverage.coverageIn { doc /* memberB sends its share of coverage to memberA. */ }
        flow deconflictFlightAtoB of Common::FlightIntent from alphaDeconflictFlight.intentOut to bravoDeconflictFlight.intentIn { doc /* memberA announces flight intent to memberB. */ }
        flow deconflictFlightBtoA of Common::FlightIntent from bravoDeconflictFlight.intentOut to alphaDeconflictFlight.intentIn { doc /* memberB announces flight intent to memberA. */ }
        flow relayReportsAtoB of Common::DetectionReport from alphaRelayReports.relayOut to bravoRelayReports.relayIn { doc /* memberA passes a report to memberB to carry onward. */ }
        flow relayReportsBtoA of Common::DetectionReport from bravoRelayReports.relayOut to alphaRelayReports.relayIn { doc /* memberB passes a report to memberA to carry onward. */ }
        flow correlateTracksAtoB of Common::Track from alphaCorrelateTracks.correlationOut to bravoCorrelateTracks.correlationIn { doc /* memberA shares a track for correlation. */ }
        flow correlateTracksBtoA of Common::Track from bravoCorrelateTracks.correlationOut to alphaCorrelateTracks.correlationIn { doc /* memberB shares a track for correlation. */ }
        flow handOverTrackAtoB of Common::Track from alphaHandOverTrack.trackHandoverOut to bravoHandOverTrack.trackHandoverIn { doc /* memberA hands a track to memberB. */ }
        flow handOverTrackBtoA of Common::Track from bravoHandOverTrack.trackHandoverOut to alphaHandOverTrack.trackHandoverIn { doc /* memberB hands a track to memberA. */ }
        flow admitMemberAtoB of Common::AdmissionExchange from alphaAdmitMember.admissionOut to bravoAdmitMember.admissionIn { doc /* memberA exchanges admission evidence with memberB. */ }
        flow admitMemberBtoA of Common::AdmissionExchange from bravoAdmitMember.admissionOut to alphaAdmitMember.admissionIn { doc /* memberB exchanges admission evidence with memberA. */ }

        // ---------- Detection, reporting and acknowledgement ----------

        flow detectionAlpha of Common::DetectionReport from alphaDetect.detectionOut to alphaDeliver.detectionIn { doc /* memberA passes a classified detection to its delivery. */ }
        flow detectionBravo of Common::DetectionReport from bravoDetect.detectionOut to bravoDeliver.detectionIn { doc /* memberB passes a classified detection to its delivery. */ }
        flow reportFromAlpha of Common::DetectionReport from alphaDeliver.reportOut to acknowledgeReports.reportIn { doc /* memberA's report reaches the operations centre over the ground link. */ }
        flow reportFromBravo of Common::DetectionReport from bravoDeliver.reportOut to acknowledgeReports.reportIn { doc /* memberB's report reaches the operations centre over the ground link. */ }
        flow receiptToAlpha of Common::ReportReceipt from acknowledgeReports.receiptOut to alphaDeliver.receiptIn { doc /* The acknowledgement returns to memberA. */ }
        flow receiptToBravo of Common::ReportReceipt from acknowledgeReports.receiptOut to bravoDeliver.receiptIn { doc /* The acknowledgement returns to memberB. */ }

        // ---------- Status and tracks ----------

        flow statusFromAlpha of Common::MemberStatus from alphaStatus.statusOut to presentStatus.statusIn { doc /* memberA's status feeds the status picture. */ }
        flow statusFromBravo of Common::MemberStatus from bravoStatus.statusOut to presentStatus.statusIn { doc /* memberB's status feeds the status picture. */ }
        flow trackPictureFromAlpha of Common::Track from alphaTrackPicture.trackPictureOut to mergeTracks.swarmTrackIn { doc /* memberA's tracks go to the analyst for merging. */ }
        flow trackPictureFromBravo of Common::Track from bravoTrackPicture.trackPictureOut to mergeTracks.swarmTrackIn { doc /* memberB's tracks go to the analyst for merging. */ }
        flow cameraTracksToMerge of Common::Track from provideCameraTracks.cameraTrackOut to mergeTracks.cameraTrackIn { doc /* The camera network's own tracks go to the analyst for merging. */ }

        // ---------- Command from the duty controller ----------

        flow taskingToAlpha of Common::TaskingOrder from issueTasking.taskingOut to alphaDirectives.taskingIn { doc /* Tasking reaches memberA. */ }
        flow taskingToBravo of Common::TaskingOrder from issueTasking.taskingOut to bravoDirectives.taskingIn { doc /* Tasking reaches memberB. */ }
        flow prioritiesToAlpha of Common::PriorityDirective from issuePriorities.priorityOut to alphaDirectives.priorityIn { doc /* Priorities and the reporting threshold reach memberA. */ }
        flow prioritiesToBravo of Common::PriorityDirective from issuePriorities.priorityOut to bravoDirectives.priorityIn { doc /* Priorities and the reporting threshold reach memberB. */ }
        flow recallToAlpha of Common::RecallDirective from issueRecall.recallOut to alphaDirectives.recallIn { doc /* A recall order reaches memberA. */ }
        flow recallToBravo of Common::RecallDirective from issueRecall.recallOut to bravoDirectives.recallIn { doc /* A recall order reaches memberB. */ }

        // ---------- Capabilities and mission ----------

        #Mission use case def WatchTheTaskedArea {
            doc /* Hold continuous watch over a tasked area of up to 25 km2 and turn what happens there into acknowledged, triaged detection reports at the operations centre, inside airspace clearance, weather, radio interference and satellite-positioning outages. */
            subject holder : SwarmMember;
        }

        #Capability use case def ContinuousSectorWatch {
            doc /* Hold continuous surveillance: at any moment at least one drone watches each sector, as members leave to recharge and rejoin. */
            subject holder : SwarmMember;
        }
        #Capability use case def MovingObjectDetectionAndClassification {
            doc /* Detect moving objects, classify them well enough to say whether they matter, and say Unknown rather than force a class below the reporting threshold. */
            subject holder : SwarmMember;
        }
        #Capability use case def ReportDeliveryAndReconciliation {
            doc /* Deliver each report with position and time, keep detecting and holding reports while cut off, and reconcile with none lost once the link is back. */
            subject holder : SwarmMember;
        }
        #Capability use case def SwarmSelfCoordination {
            doc /* Settle sector handover, recharge rotation, coverage redistribution, deconfliction, link relay, track correlation, track handover and member admission between the drones over the mesh. */
            subject holder : SwarmMember;
        }
        #Capability use case def OperatorSupervisionOfTheSwarm {
            doc /* Let one operator task, command, recall and watch the whole swarm rather than fly each drone, and acknowledge each report. */
            subject holder : DutyController;
        }
        #Capability use case def AlertTriage {
            doc /* Triage reports before they reach the operator, most likely to matter first and duplicates merged, so the alert rate stays inside what one operator can judge. */
            subject holder : OperationsCentreAnalyst;
        }
        #Capability use case def DecisionRecordKeeping {
            doc /* Keep, for every report, the frames it came from, the classifier version, the reporting threshold in force and who acknowledged it. */
            subject holder : OperationsCentreAnalyst;
        }
        #Capability use case def GracefulDegradationUnderLoss {
            doc /* Keep flying and watching when a drone is lost, the mesh is jammed or the ground link or ground station drops, with the loss of coverage bounded. */
            subject holder : SwarmMember;
        }
        #Capability use case def AirspaceComplianceAndSafeRecovery {
            doc /* Stay inside cleared airspace, land when it is not cleared or wind exceeds moderate, and return to a recovery point when contact with the swarm is lost. */
            subject holder : SwarmMember;
        }
        #Capability use case def ClassifierVersionConsistency {
            doc /* Keep one classifier version across the fleet and know which version each drone runs, so one object is not classified differently by different drones. */
            subject holder : SwarmMember;
        }

        // ---------- Operational modes and states ----------

        #Mode state def SwarmMemberModes {
            doc /* Operating conditions of one drone: nominal, without satellite positioning, sensors not trustworthy, cut off from the other drones, or failed admission. */
            initial start;
            transition start -> Nominal;
            state Nominal { doc /* The drone has positioning, trusted sensors, contact with the swarm and admission. */ }
            state NavigationDegraded { doc /* The drone has no satellite positioning and navigates by what its camera sees against stored maps. */ }
            state SensingDegraded { doc /* The drone's sensors cannot be trusted as they are, and what it reports from them is marked accordingly. */ }
            state Isolated { doc /* The drone is cut off from the other drones and coordinates with none of them. */ }
            state Quarantined { doc /* The drone has failed admission and takes no part in coordination until it has been readmitted. */ }
            transition losePositioning first Nominal accept positioningLostNotice : Common::ConditionNotice do action navigateByCamera then NavigationDegraded;
            transition regainPositioning first NavigationDegraded accept positioningBackNotice : Common::ConditionNotice do action resumeSatelliteNavigation then Nominal;
            transition degradeSensing first Nominal accept sensingDegradedNotice : Common::ConditionNotice do action markReportsUnreliable then SensingDegraded;
            transition restoreSensing first SensingDegraded accept sensingRestoredNotice : Common::ConditionNotice do action clearReportMarking then Nominal;
            transition loseContact first Nominal accept contactLostNotice : Common::ConditionNotice do action coordinateWithNone then Isolated;
            transition regainContact first Isolated accept contactBackNotice : Common::ConditionNotice do action rejoinCoordination then Nominal;
            transition failAdmission first Nominal accept admissionFailed : Common::AdmissionExchange do action withdrawFromCoordination then Quarantined;
            transition readmit first Quarantined accept readmission : Common::AdmissionExchange do action resumeCoordination then Nominal;
        }

        #State state def SwarmMemberStates {
            doc /* Where one drone is in its sortie: on the ground, flying out, watching, flying back, recalled, or returning to the recovery point on its own. */
            initial start;
            transition start -> Landed;
            state Landed { doc /* On the ground, battery being swapped or waiting for tasking. */ }
            state Transiting { doc /* Flying from the recharge point to its sector. */ }
            state Watching { doc /* Holding watch over its sector. */ }
            state Returning { doc /* Flying back to the recharge point to swap the battery. */ }
            state Recalled { doc /* Recalled by order and on its way down; it does not watch until landed. */ }
            state Recovering { doc /* Cut off from the swarm and returning to the recovery point on its own. */ }
            transition launch first Landed accept taskingReceived : Common::TaskingOrder do action beginTransit then Transiting;
            transition Transiting -> Watching;
            transition Watching -> Returning;
            transition Returning -> Landed;
            transition recallWhileTransiting first Transiting accept recallReceivedEarly : Common::RecallDirective do action abortTransit then Recalled;
            transition recallWhileWatching first Watching accept recallReceived : Common::RecallDirective do action abortWatch then Recalled;
            transition Recalled -> Landed;
            transition loseSwarmContact first Watching accept swarmContactLost : Common::ConditionNotice do action headForRecoveryPoint then Recovering;
            transition Recovering -> Landed;
        }

        #Mode state def FleetModes {
            doc /* Condition of the mesh between drones, taken over the whole population watchAsset. */
            initial start;
            transition start -> MeshIntact;
            state MeshIntact { doc /* The links between drones are all usable. */ }
            state MeshDegraded { doc /* A share of the links between drones is jammed and the swarm coordinates over what is left. */ }
            transition meshJammed first MeshIntact accept jammingNotice : Common::ConditionNotice do action coordinateOverRemainingLinks then MeshDegraded;
            transition meshRestored first MeshDegraded accept jammingClearedNotice : Common::ConditionNotice do action restoreFullCoordination then MeshIntact;
        }

        #State state def FleetStates {
            doc /* Where the whole population watchAsset is in the mission: on the ground, on watch, or recalled. */
            initial start;
            transition start -> Grounded;
            state Grounded { doc /* No drone is flying. */ }
            state OnWatch { doc /* The population holds the watch, rotating members through recharge. */ }
            state Recalled { doc /* The whole population has been recalled and lands. */ }
            transition fleetLaunch first Grounded accept fleetTasking : Common::TaskingOrder do action launchRotation then OnWatch;
            transition fleetRecall first OnWatch accept fleetRecallOrder : Common::RecallDirective do action landPopulation then Recalled;
            transition Recalled -> Grounded;
        }

        // ---------- Hazards this layer adds ----------

        package Hazards {
            doc /* Hazards of the operation as it is, without the system. */

            #Hazard requirement ManualCoordinationLagHazard {
                doc /* Sector assignment, handover, re-spread and deconfliction done by hand lag behind events, and a sector goes unwatched. */
                subject holder : DutyController;
            }
            #Hazard requirement UnrecoveredDroneHazard {
                doc /* A drone that has lost contact with the swarm keeps flying with nowhere to go and becomes a hazard. */
                subject holder : SwarmMember;
            }
            #Hazard requirement ReportLostInLinkGapHazard {
                doc /* A detection report is sent into a link gap and nobody knows it never arrived. */
                subject holder : OperationsCentreAnalyst;
            }
            #Hazard requirement WatchBeyondClearanceHazard {
                doc /* A drone keeps flying its watch after the airspace clearance has been withdrawn. */
                subject holder : SwarmMember;
            }
        }

        satisfy Hazards::ManualCoordinationLagHazard by alphaRedistributeCoverage;
        satisfy Hazards::UnrecoveredDroneHazard by alphaReturn;
        satisfy Hazards::ReportLostInLinkGapHazard by acknowledgeReports;
        satisfy Hazards::WatchBeyondClearanceHazard by alphaDirectives;
    }
    package SA {
        #prompt part saGuidance {
            doc /* SA: the system is one black-box part with ports. Every function is allocated to the system or to an actor, and traces to at least one operational activity. No design choices here. */
        }

        // the system, black box
        part def SurveillanceDroneSwarmSystem {
            doc /* The whole surveillance drone swarm seen as one black box: the twelve-drone population, its mesh, its on-board sensing and its tasking, reporting and status functions, with no internal structure. It takes tasking, supervisory command, recall, acknowledgements, airspace clearance, serviced drones and the moving objects in the area, and gives detection reports, triaged alerts, the track picture, the status picture, decision records and arriving drones. */
            in port taskingIn : Common::TaskingOrder;
            in port supervisoryIn : Common::PriorityDirective;
            in port recallIn : Common::RecallDirective;
            in port acknowledgementIn : Common::ReportReceipt;
            in port objectsIn : Common::MovingObjectsInArea;
            in port clearanceIn : Common::AirspaceClearance;
            in port servicedDroneIn : Common::DroneServiced;
            out port reportsOut : Common::DetectionReport;
            out port alertsOut : Common::TriagedAlerts;
            out port trackPictureOut : Common::Track;
            out port statusOut : Common::MemberStatus;
            out port decisionRecordsOut : Common::DecisionRecords;
            out port rechargeArrivalOut : Common::DroneArrival;
            out port recoveryArrivalOut : Common::DroneArrival;
        }
        part system : SurveillanceDroneSwarmSystem {
            doc /* The system under design: the twelve-drone swarm as one black box. */
        }
        trace system to SurveillanceDroneSwarm::OA::watchAsset;

        #prose part environmentConstraints {
            doc /* Constraining inputs carried as constraints on the system, not as ports, because no actor sends them: RadioInterference (degrades the mesh and the ground link), SatellitePositioningOutage (minutes at a time), WeatherLightingAndDeception (sensing degrades; the swarm lands above moderate wind), FixedCameraNetwork tracks that swarm tracks must be mergeable with, OperatorAttentionLimit (a bounded number of alerts per hour), and WatchAndReportOnlyScope (weapons, interception and anything done to what is detected are out of scope). The clearance from the airspace authority does arrive through a port, clearanceIn. */
        }

        // the population: 12 identical members (CV-16)
        #Member part def SwarmMember {
            doc /* One member of the twelve-drone population: a small drone that flies about 40 minutes at about 18 m/s and keeps about 3.0 km2 under watch. At SA the system is still one black box: this definition is carried, not instantiated, and holds the two state machines every member follows. */
            out port meshOut : Common::MeshPort;
            in port meshIn : ~Common::MeshPort;

            #Mode state def SwarmMemberModes {
                doc /* Operating condition of one drone: nominal, without satellite positioning, sensors not trustworthy, cut off from the other drones, or failed admission and readmitted. Carries the rule QuarantinedStaysOut. */
                @SysproseVerification::PropertyPattern {
                    doc /* QuarantinedStaysOut: once a drone is quarantined, it takes no part in coordination until it has been readmitted. */
                    attribute pattern = "absence";
                    attribute scope = "between";
                    attribute q = "state Quarantined";
                    attribute r = "state Readmitted";
                    attribute p = "state Nominal";
                }
                initial start;
                transition start -> Nominal;
                state Nominal {
                    doc /* The drone has positioning, trusted sensors, contact with the swarm and admission, and takes part in coordination. */
                }
                state NavigationDegraded {
                    doc /* The drone has no satellite positioning and navigates by what its camera sees against stored maps. */
                }
                state SensingDegraded {
                    doc /* The drone's sensors cannot be trusted as they are, and what it reports from them is marked accordingly. */
                }
                state Isolated {
                    doc /* The drone is cut off from the other drones and coordinates with none of them. */
                }
                state Quarantined {
                    doc /* The drone has failed admission and takes no part in coordination until it has been readmitted. */
                }
                state Readmitted {
                    doc /* The drone has passed the readmission check and is about to take part in coordination again. */
                }
                transition losePositioning first Nominal accept positioningLost : Common::PositioningStatus do action navigateByCamera then NavigationDegraded;
                transition regainPositioning first NavigationDegraded accept positioningRegained : Common::PositioningStatus do action resumeSatelliteNavigation then Nominal;
                transition degradeSensing first Nominal accept sensorHealthLost : Common::SensorHealthStatus do action markReportsUnreliable then SensingDegraded;
                transition restoreSensing first SensingDegraded accept sensorHealthRestored : Common::SensorHealthStatus do action clearReportMarking then Nominal;
                transition loseContact first Nominal accept meshContactLost : Common::MeshLinkStatus do action coordinateWithNone then Isolated;
                transition regainContact first Isolated accept meshContactRegained : Common::MeshLinkStatus do action resumeCoordination then Nominal;
                transition failAdmission first Nominal accept admissionFailed : Common::AdmissionExchange do action stopCoordinating then Quarantined;
                transition readmit first Quarantined accept readmissionPassed : Common::AdmissionExchange do action rejoinAfterCheck then Readmitted;
                transition Readmitted -> Nominal;
            }

            #State state def SwarmMemberStates {
                doc /* Where one drone is in its sortie: on the ground, flying out, watching, flying back, recalled, outside its cleared airspace, or returning to the recovery point on its own. Carries the rules RecallWins, GeofenceBreachEndsWatch and ReturnsWhenIsolated. */
                @SysproseVerification::PropertyPattern {
                    doc /* RecallWins: once a drone is recalled, it does not watch again until it has landed. */
                    attribute pattern = "absence";
                    attribute scope = "between";
                    attribute q = "state Recalled";
                    attribute r = "state Landed";
                    attribute p = "state Watching";
                }
                @SysproseVerification::PropertyPattern {
                    doc /* GeofenceBreachEndsWatch: once a drone is outside its cleared airspace, it does not watch until it has landed. */
                    attribute pattern = "absence";
                    attribute scope = "between";
                    attribute q = "state OutsideClearance";
                    attribute r = "state Landed";
                    attribute p = "state Watching";
                }
                @SysproseVerification::PropertyPattern {
                    doc /* ReturnsWhenIsolated: from any situation a drone can be in, it can always get back to landed; an isolated drone included. */
                    attribute pattern = "recovery";
                    attribute scope = "globally";
                    attribute p = "state Landed";
                }
                initial start;
                transition start -> Landed;
                state Landed {
                    doc /* On the ground, battery being swapped or waiting for tasking. */
                }
                state Transiting {
                    doc /* Flying from the recharge point to its sector. */
                }
                state Watching {
                    doc /* Holding watch over its sector. */
                }
                state Returning {
                    doc /* Flying back to the recharge point to swap the battery, or to land when the wind is above moderate. */
                }
                state Recalled {
                    doc /* Recalled by order and on its way down; it does not watch until landed. */
                }
                state Recovering {
                    doc /* Cut off from the swarm and returning to the recovery point on its own. */
                }
                state OutsideClearance {
                    doc /* Outside the cleared airspace or the clearance withdrawn: on its way down, and it does not watch until landed. */
                }
                transition launch first Landed accept assignment : Common::TaskingOrder do action startSortie then Transiting;
                transition Transiting -> Watching;
                transition endWatch first Watching accept rotationSlot : Common::RechargeRotationSlot do action handSectorAndReturn then Returning;
                transition Returning -> Landed;
                transition recallWhileTransiting first Transiting accept recallDirective : Common::RecallDirective do action abortTransitAndLand then Recalled;
                transition recallWhileWatching first Watching accept recallDirective : Common::RecallDirective do action abortWatchAndLand then Recalled;
                transition Recalled -> Landed;
                transition loseSwarmContact first Watching accept contactLost : Common::MeshLinkStatus do action headForRecoveryPoint then Recovering;
                transition loseContactInTransit first Transiting accept contactLostEnRoute : Common::MeshLinkStatus do action headForRecoveryPointFromTransit then Recovering;
                transition Recovering -> Landed;
                transition leaveClearanceWhileWatching first Watching accept clearanceUpdate : Common::AirspaceClearance do action stopWatchOutsideClearance then OutsideClearance;
                transition leaveClearanceInTransit first Transiting accept clearanceUpdateEnRoute : Common::AirspaceClearance do action stopTransitOutsideClearance then OutsideClearance;
                transition OutsideClearance -> Landed;
                transition windLimit first Watching accept weatherNow : Common::WeatherCondition do action landInWind then Returning;
            }
        }
        #prose part fleetFact {
            doc /* Population: 12 members of SwarmMember, carried by fleet, exchanging through Common::MeshInterface. Carried from the brief; instantiated from LA down. */
        }

        // fleet-level configuration: the condition of the mesh over the whole population
        #Configuration state def FleetConfiguration {
            doc /* Condition of the mesh between drones, taken over the whole twelve-drone population. */
            initial start;
            transition start -> MeshIntact;
            state MeshIntact {
                doc /* The links between drones are all usable. */
            }
            state MeshDegraded {
                doc /* A share of the links between drones is jammed and the swarm coordinates over what is left. */
            }
            transition meshJammed first MeshIntact accept jamming : Common::MeshLinkStatus do action coordinateOverRemainingLinks then MeshDegraded;
            transition meshRestored first MeshDegraded accept linksRestored : Common::MeshLinkStatus do action resumeFullCoordination then MeshIntact;
        }

        // actors: every operational entity the system is not
        #Actor part def DutyController {
            doc /* Operations-centre operator who tasks the swarm, issues supervisory command and recall. Exchanges through three outgoing ports. */
            out port taskingOut : Common::TaskingOrder;
            out port priorityOut : Common::PriorityDirective;
            out port recallOut : Common::RecallDirective;
        }
        part dutyController : DutyController {
            doc /* The one operator who supervises the whole swarm. */
        }
        trace dutyController to SurveillanceDroneSwarm::OA::dutyController;
        #Actor part def OperationsCentreAnalyst {
            doc /* Judges the alerts, acknowledges each detection report and merges swarm tracks with the fixed camera network's tracks. Receives reports, alerts, the swarm track picture, decision records and the camera tracks; returns the acknowledgement. */
            in port reportsIn : Common::DetectionReport;
            in port alertsIn : Common::TriagedAlerts;
            in port trackPictureIn : Common::Track;
            in port recordsIn : Common::DecisionRecords;
            in port cameraTrackIn : Common::Track;
            out port receiptOut : Common::ReportReceipt;
        }
        part operationsCentreAnalyst : OperationsCentreAnalyst {
            doc /* The analyst at the operations centre. */
        }
        trace operationsCentreAnalyst to SurveillanceDroneSwarm::OA::operationsCentreAnalyst;
        #Actor part def AirspaceAuthority {
            doc /* Grants and withdraws the clearance that says when and where anything may fly. Exchanges through one outgoing port. */
            out port clearanceOut : Common::AirspaceClearance;
        }
        part airspaceAuthority : AirspaceAuthority {
            doc /* The authority whose clearance bounds every flight. */
        }
        trace airspaceAuthority to SurveillanceDroneSwarm::OA::airspaceAuthority;
        #Actor part def GroundCrew {
            doc /* Services drones between sorties and recovers drones that return on their own; hands serviced drones back to the swarm. */
            out port servicedDroneOut : Common::DroneServiced;
        }
        part groundCrew : GroundCrew {
            doc /* The crew at the recharge point and the recovery point. */
        }
        trace groundCrew to SurveillanceDroneSwarm::OA::groundCrew;
        #Actor part def FixedCameraNetworkOperator {
            doc /* Keeps the existing fixed camera network and its own tracks in service. It has no exchange with the system at SA; its tracks reach the analyst through the camera network. */
        }
        part fixedCameraNetworkOperator : FixedCameraNetworkOperator {
            doc /* The operator of the fixed camera network. */
        }
        trace fixedCameraNetworkOperator to SurveillanceDroneSwarm::OA::fixedCameraNetworkOperator;
        #Actor part def GroundStationNode {
            doc /* The station that tasks and watches the swarm and shows its status picture. At SA it receives the status picture; whether it also coordinates the swarm is the command-and-control architecture decision taken later. */
            in port statusIn : Common::MemberStatus;
        }
        part groundStation : GroundStationNode {
            doc /* The ground station used today. */
        }
        trace groundStation to SurveillanceDroneSwarm::OA::groundStation;
        #Actor part def MeshRadio {
            doc /* The radio mesh carrying coordination traffic between drones; it does not depend on the link to the operations centre. It is a medium inside the swarm, so it has no port on the system at SA; PA types the member-to-member links by it. */
        }
        part meshRadioBetweenDrones : MeshRadio {
            doc /* The mesh radio that carries the traffic between drones. */
        }
        trace meshRadioBetweenDrones to SurveillanceDroneSwarm::OA::meshRadioBetweenDrones;
        #Actor part def GroundLinkRadio {
            doc /* The intermittently available radio link carrying tasking, command, reports, status and acknowledgements to and from the operations centre. It is the medium under the ports to the operations-centre actors; its intermittency is carried as a constraint and allocated at PA. */
        }
        part groundLinkToOperationsCentre : GroundLinkRadio {
            doc /* The intermittent link to the operations centre. */
        }
        trace groundLinkToOperationsCentre to SurveillanceDroneSwarm::OA::groundLinkToOperationsCentre;
        #Actor part def RechargePoint {
            doc /* Where batteries are swapped, not charged in place; about 20 minutes of turnaround. Receives drones that come down to be serviced. */
            in port arrivalIn : Common::DroneArrival;
        }
        part batterySwapAtRechargePoint : RechargePoint {
            doc /* The recharge point where ground crew swap batteries. */
        }
        trace batterySwapAtRechargePoint to SurveillanceDroneSwarm::OA::batterySwapAtRechargePoint;
        #Actor part def RecoveryPoint {
            doc /* The point a drone that has lost contact with the swarm returns to on its own rather than becoming a hazard. Receives such drones. */
            in port arrivalIn : Common::DroneArrival;
        }
        part recoveryPoint : RecoveryPoint {
            doc /* The recovery point for drones that return on their own. */
        }
        trace recoveryPoint to SurveillanceDroneSwarm::OA::recoveryPoint;
        #Actor part def FixedCameraNetwork {
            doc /* The existing camera network; it stays and keeps its own tracks, which swarm reports must be mergeable with. */
            out port cameraTrackOut : Common::Track;
        }
        part fixedCameraNetwork : FixedCameraNetwork {
            doc /* The existing fixed camera network. */
        }
        trace fixedCameraNetwork to SurveillanceDroneSwarm::OA::fixedCameraNetwork;
        #Actor part def MovingObjectsSource {
            doc /* The moving objects in the tasked area that the swarm must detect, classify and place in time and space. An environment source, not an operational entity of OA, so it carries no trace. */
            out port objectsOut : Common::MovingObjectsInArea;
        }
        part movingObjectsInArea : MovingObjectsSource {
            doc /* Whatever moves through the tasked area. */
        }

        // the system ports wired to the actors
        connection taskingLink connect dutyController.taskingOut to system.taskingIn;
        connection supervisoryLink connect dutyController.priorityOut to system.supervisoryIn;
        connection recallLink connect dutyController.recallOut to system.recallIn;
        connection acknowledgementLink connect operationsCentreAnalyst.receiptOut to system.acknowledgementIn;
        connection objectsLink connect movingObjectsInArea.objectsOut to system.objectsIn;
        connection clearanceLink connect airspaceAuthority.clearanceOut to system.clearanceIn;
        connection servicedDroneLink connect groundCrew.servicedDroneOut to system.servicedDroneIn;
        connection reportsLink connect system.reportsOut to operationsCentreAnalyst.reportsIn;
        connection alertsLink connect system.alertsOut to operationsCentreAnalyst.alertsIn;
        connection trackPictureLink connect system.trackPictureOut to operationsCentreAnalyst.trackPictureIn;
        connection statusLink connect system.statusOut to groundStation.statusIn;
        connection decisionRecordsLink connect system.decisionRecordsOut to operationsCentreAnalyst.recordsIn;
        connection rechargeArrivalLink connect system.rechargeArrivalOut to batterySwapAtRechargePoint.arrivalIn;
        connection recoveryArrivalLink connect system.recoveryArrivalOut to recoveryPoint.arrivalIn;
        connection cameraTracksLink connect fixedCameraNetwork.cameraTrackOut to operationsCentreAnalyst.cameraTrackIn;

        // capabilities, carried over with the system as subject
        #Capability use case def WatchTheTaskedArea {
            doc /* Hold continuous watch over a tasked area of up to 25 km2 and turn what happens there into acknowledged, triaged detection reports at the operations centre. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace WatchTheTaskedArea to SurveillanceDroneSwarm::OA::WatchTheTaskedArea;
        #Capability use case def ContinuousSectorWatch {
            doc /* At any moment at least one drone watches each sector, as members leave to recharge and rejoin. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace ContinuousSectorWatch to SurveillanceDroneSwarm::OA::ContinuousSectorWatch;
        #Capability use case def MovingObjectDetectionAndClassification {
            doc /* Detect moving objects, classify them well enough to say whether they matter, and say Unknown rather than force a class below the reporting threshold. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace MovingObjectDetectionAndClassification to SurveillanceDroneSwarm::OA::MovingObjectDetectionAndClassification;
        #Capability use case def ReportDeliveryAndReconciliation {
            doc /* Deliver each report with position and time, keep detecting and holding reports while cut off, and reconcile with none lost once the link is back. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace ReportDeliveryAndReconciliation to SurveillanceDroneSwarm::OA::ReportDeliveryAndReconciliation;
        #Capability use case def SwarmSelfCoordination {
            doc /* Settle sector handover, recharge rotation, coverage redistribution, deconfliction, link relay, track correlation, track handover and member admission between the drones over the mesh. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace SwarmSelfCoordination to SurveillanceDroneSwarm::OA::SwarmSelfCoordination;
        #Capability use case def OperatorSupervisionOfTheSwarm {
            doc /* Let one operator task, command, recall and watch the whole swarm rather than fly each drone, and acknowledge each report. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace OperatorSupervisionOfTheSwarm to SurveillanceDroneSwarm::OA::OperatorSupervisionOfTheSwarm;
        #Capability use case def AlertTriage {
            doc /* Triage reports before they reach the operator, most likely to matter first and duplicates merged, so the alert rate stays inside what one operator can judge. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace AlertTriage to SurveillanceDroneSwarm::OA::AlertTriage;
        #Capability use case def DecisionRecordKeeping {
            doc /* Keep, for every report, the frames it came from, the classifier version, the reporting threshold in force and who acknowledged it. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace DecisionRecordKeeping to SurveillanceDroneSwarm::OA::DecisionRecordKeeping;
        #Capability use case def GracefulDegradationUnderLoss {
            doc /* Keep flying and watching when a drone is lost, the mesh is jammed or the ground link or ground station drops, with the loss of coverage bounded. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace GracefulDegradationUnderLoss to SurveillanceDroneSwarm::OA::GracefulDegradationUnderLoss;
        #Capability use case def AirspaceComplianceAndSafeRecovery {
            doc /* Stay inside cleared airspace, land when it is not cleared or wind exceeds moderate, and return to a recovery point when contact with the swarm is lost. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace AirspaceComplianceAndSafeRecovery to SurveillanceDroneSwarm::OA::AirspaceComplianceAndSafeRecovery;
        #Capability use case def ClassifierVersionConsistency {
            doc /* Keep one classifier version across the fleet and know which version each drone runs, so one object is not classified differently by different drones. */
            subject s : SurveillanceDroneSwarmSystem;
        }
        trace ClassifierVersionConsistency to SurveillanceDroneSwarm::OA::ClassifierVersionConsistency;

        // function definitions
        action def TaskSurveillanceArea {
            doc /* The duty controller tasks the swarm with the area of interest, its sectors and the mission window. */
            out taskingOut;
        }
        action def CommandSupervisoryPriorities {
            doc /* The duty controller gives priorities, a sector to look at more closely and the reporting threshold. */
            out priorityOut;
        }
        action def RecallAndLand {
            doc /* An order to recall and land the whole swarm or one drone, issuable at any time. */
            out recallOut;
        }
        action def PresentStatusPicture {
            doc /* Shows where every drone is, what it is doing, how much of the area is under watch and what is degraded. */
            in statusIn;
        }
        action def AcknowledgeDetectionReport {
            doc /* The operations centre confirms each detection report so nothing is lost in a link gap, judging the triaged alerts it is given. */
            in reportIn;
            in alertsIn;
            out receiptOut;
        }
        action def MergeSwarmTracks {
            doc /* The analyst merges swarm tracks with the camera network's tracks, one track per object. */
            in swarmTrackIn;
            in cameraTrackIn;
        }
        action def ProvideCameraTracks {
            doc /* The fixed camera network provides its own tracks. */
            out cameraTrackOut;
        }
        action def SwapBattery {
            doc /* Ground crew swap a landed drone's battery at the recharge point, about 20 minutes. */
        }
        action def RecoverReturnedDrone {
            doc /* Ground crew recover a drone that returned to the recovery point on its own. */
        }
        action def GrantAirspaceClearance {
            doc /* The airspace authority grants or withdraws the clearance that bounds when and where anything may fly. */
        }
        action def HandOverSector {
            doc /* A drone hands its sector to a neighbour when it leaves to recharge, so the sector stays watched. */
            out handoverOut;
            in handoverIn;
        }
        action def RotateRecharge {
            doc /* Members agree who leaves to recharge and who takes the place, so the rotation never empties a sector. */
            out rotationOut;
            in rotationIn;
        }
        action def RedistributeCoverage {
            doc /* Members re-spread over the area when one is lost or leaves, so the share of area under watch stays high. */
            out coverageOut;
            in coverageIn;
        }
        action def DeconflictFlight {
            doc /* Members announce flight intent to each other so that two drones do not occupy the same airspace. */
            out intentOut;
            in intentIn;
        }
        action def RelayReportsThroughNeighbour {
            doc /* A member that cannot reach the operations centre sends its reports through a neighbour that can. */
            out relayOut;
            in relayIn;
        }
        action def CorrelateTracks {
            doc /* Members agree that tracks seen by different drones are the same object, giving one track per object. */
            out correlationOut;
            in correlationIn;
        }
        action def HandOverTrack {
            doc /* A track is handed to the drone that watches the sector the object moves into. */
            out trackHandoverOut;
            in trackHandoverIn;
        }
        action def AdmitMember {
            doc /* A drone is checked before it takes part in coordination, including the classifier version it runs; one that fails takes no part until readmitted. */
            out admissionOut;
            in admissionIn;
        }
        action def DetectAndClassifyObject {
            doc /* A drone detects a moving object in its sector and classifies it, saying Unknown when confidence is short of the reporting threshold. */
            out detectionOut;
        }
        action def DeliverDetectionReport {
            doc /* A drone delivers a report with position and time to the operations centre, holds it while cut off, and clears it on acknowledgement. */
            in detectionIn;
            out reportOut;
            in receiptIn;
        }
        action def ApplySupervisoryDirectives {
            doc /* A drone takes up the tasking, priorities and recall given by the duty controller, and lands on recall. */
            in taskingIn;
            in priorityIn;
            in recallIn;
        }
        action def ReportMemberStatus {
            doc /* A drone reports its position, activity and degradations, sensing degradation included, for the status picture. */
            out statusOut;
        }
        action def ReportTrackPicture {
            doc /* A drone reports the tracks it holds, marking a track stale once nothing has seen the object, so the analyst can merge them with the camera network's tracks. */
            out trackPictureOut;
        }
        action def ReturnToRecoveryPoint {
            doc /* A drone that has lost contact with the swarm returns to the recovery point on its own. */
        }
        action def TriageAlerts {
            doc /* Ranks the reports so that what is most likely to matter reaches the operator first, with duplicates merged, keeping the alert rate inside what one operator can judge. */
            in reportsIn;
            out alertsOut;
        }
        action def KeepDecisionRecords {
            doc /* Keeps, for every report, the frames it came from, the classifier version, the reporting threshold in force and who acknowledged it. */
            in reportIn;
            in receiptIn;
        }

        // functions: command and control
        #C2 action taskSurveillanceArea : TaskSurveillanceArea {
            doc /* Command and control: the duty controller tasks the swarm with the area, sectors and mission window. */
        }
        allocate taskSurveillanceArea to dutyController;
        trace taskSurveillanceArea to SurveillanceDroneSwarm::OA::issueTasking;
        #C2 action commandSupervisoryPriorities : CommandSupervisoryPriorities {
            doc /* Command and control: the duty controller gives priorities, a sector to look at more closely and the reporting threshold. */
        }
        allocate commandSupervisoryPriorities to dutyController;
        trace commandSupervisoryPriorities to SurveillanceDroneSwarm::OA::issuePriorities;
        #C2 action recallAndLand : RecallAndLand {
            doc /* Command and control: the duty controller recalls and lands the whole swarm or one drone at any time. */
        }
        allocate recallAndLand to dutyController;
        trace recallAndLand to SurveillanceDroneSwarm::OA::issueRecall;
        #C2 action presentStatusPicture : PresentStatusPicture {
            doc /* Command and control: the ground station shows the status picture of the swarm. */
        }
        allocate presentStatusPicture to groundStation;
        trace presentStatusPicture to SurveillanceDroneSwarm::OA::presentStatus;
        #C2 action acknowledgeDetectionReport : AcknowledgeDetectionReport {
            doc /* Command and control: the analyst acknowledges each detection report and judges the triaged alerts. */
        }
        allocate acknowledgeDetectionReport to operationsCentreAnalyst;
        trace acknowledgeDetectionReport to SurveillanceDroneSwarm::OA::acknowledgeReports;

        // functions performed by actors
        action mergeTracks : MergeSwarmTracks {
            doc /* The analyst merges swarm tracks with the fixed camera network's tracks. */
        }
        allocate mergeTracks to operationsCentreAnalyst;
        trace mergeTracks to SurveillanceDroneSwarm::OA::mergeTracks;
        action provideCameraTracks : ProvideCameraTracks {
            doc /* The fixed camera network keeps and provides its own tracks. */
        }
        allocate provideCameraTracks to fixedCameraNetwork;
        trace provideCameraTracks to SurveillanceDroneSwarm::OA::provideCameraTracks;
        action swapBatteryAct : SwapBattery {
            doc /* Ground crew swap a landed drone's battery. */
        }
        allocate swapBatteryAct to groundCrew;
        trace swapBatteryAct to SurveillanceDroneSwarm::OA::swapBatteryAct;
        action recoverDroneAct : RecoverReturnedDrone {
            doc /* Ground crew recover a drone that returned on its own. */
        }
        allocate recoverDroneAct to groundCrew;
        trace recoverDroneAct to SurveillanceDroneSwarm::OA::recoverDroneAct;
        action grantClearanceAct : GrantAirspaceClearance {
            doc /* The airspace authority grants or withdraws the clearance. */
        }
        allocate grantClearanceAct to airspaceAuthority;
        trace grantClearanceAct to SurveillanceDroneSwarm::OA::grantClearanceAct;

        // functions: coordination between members, one function for the members performing one activity
        #Coordination action handOverSector : HandOverSector {
            doc /* Members hand a sector to a neighbour when one leaves to recharge. */
        }
        allocate handOverSector to system;
        trace handOverSector to SurveillanceDroneSwarm::OA::alphaHandOverSector;
        trace handOverSector to SurveillanceDroneSwarm::OA::bravoHandOverSector;
        #Coordination action rotateRecharge : RotateRecharge {
            doc /* Members agree the recharge rotation so no sector is emptied. */
        }
        allocate rotateRecharge to system;
        trace rotateRecharge to SurveillanceDroneSwarm::OA::alphaRotateRecharge;
        trace rotateRecharge to SurveillanceDroneSwarm::OA::bravoRotateRecharge;
        #Coordination action redistributeCoverage : RedistributeCoverage {
            doc /* Members re-spread over the area when one is lost or leaves. */
        }
        allocate redistributeCoverage to system;
        trace redistributeCoverage to SurveillanceDroneSwarm::OA::alphaRedistributeCoverage;
        trace redistributeCoverage to SurveillanceDroneSwarm::OA::bravoRedistributeCoverage;
        #Coordination action deconflictFlight : DeconflictFlight {
            doc /* Members announce flight intent so two drones do not share airspace. */
        }
        allocate deconflictFlight to system;
        trace deconflictFlight to SurveillanceDroneSwarm::OA::alphaDeconflictFlight;
        trace deconflictFlight to SurveillanceDroneSwarm::OA::bravoDeconflictFlight;
        #Coordination action relayReportsThroughNeighbour : RelayReportsThroughNeighbour {
            doc /* A member without a link to the operations centre relays reports through a neighbour. */
        }
        allocate relayReportsThroughNeighbour to system;
        trace relayReportsThroughNeighbour to SurveillanceDroneSwarm::OA::alphaRelayReports;
        trace relayReportsThroughNeighbour to SurveillanceDroneSwarm::OA::bravoRelayReports;
        #Coordination action correlateTracks : CorrelateTracks {
            doc /* Members agree tracks seen by different drones are one object. */
        }
        allocate correlateTracks to system;
        trace correlateTracks to SurveillanceDroneSwarm::OA::alphaCorrelateTracks;
        trace correlateTracks to SurveillanceDroneSwarm::OA::bravoCorrelateTracks;
        #Coordination action handOverTrack : HandOverTrack {
            doc /* A track is handed to the drone watching the sector the object moves into. */
        }
        allocate handOverTrack to system;
        trace handOverTrack to SurveillanceDroneSwarm::OA::alphaHandOverTrack;
        trace handOverTrack to SurveillanceDroneSwarm::OA::bravoHandOverTrack;
        #Coordination action admitMember : AdmitMember {
            doc /* A drone is checked, its classifier version included, before it takes part in coordination. */
        }
        allocate admitMember to system;
        trace admitMember to SurveillanceDroneSwarm::OA::alphaAdmitMember;
        trace admitMember to SurveillanceDroneSwarm::OA::bravoAdmitMember;

        // functions the members perform for the mission
        action detectAndClassifyObject : DetectAndClassifyObject {
            doc /* Detects moving objects in the sector and classifies them, or says Unknown. */
        }
        allocate detectAndClassifyObject to system;
        trace detectAndClassifyObject to SurveillanceDroneSwarm::OA::alphaDetect;
        trace detectAndClassifyObject to SurveillanceDroneSwarm::OA::bravoDetect;
        action deliverDetectionReport : DeliverDetectionReport {
            doc /* Delivers, holds while cut off, and clears on acknowledgement, each detection report. */
        }
        allocate deliverDetectionReport to system;
        trace deliverDetectionReport to SurveillanceDroneSwarm::OA::alphaDeliver;
        trace deliverDetectionReport to SurveillanceDroneSwarm::OA::bravoDeliver;
        action applySupervisoryDirectives : ApplySupervisoryDirectives {
            doc /* Takes up tasking, priorities and recall, and lands on recall. */
        }
        allocate applySupervisoryDirectives to system;
        trace applySupervisoryDirectives to SurveillanceDroneSwarm::OA::alphaDirectives;
        trace applySupervisoryDirectives to SurveillanceDroneSwarm::OA::bravoDirectives;
        action reportMemberStatus : ReportMemberStatus {
            doc /* Reports position, activity and degradations for the status picture. */
        }
        allocate reportMemberStatus to system;
        trace reportMemberStatus to SurveillanceDroneSwarm::OA::alphaStatus;
        trace reportMemberStatus to SurveillanceDroneSwarm::OA::bravoStatus;
        action reportTrackPicture : ReportTrackPicture {
            doc /* Reports the tracks held, one per object, stale ones marked. */
        }
        allocate reportTrackPicture to system;
        trace reportTrackPicture to SurveillanceDroneSwarm::OA::alphaTrackPicture;
        trace reportTrackPicture to SurveillanceDroneSwarm::OA::bravoTrackPicture;
        action returnToRecoveryPoint : ReturnToRecoveryPoint {
            doc /* Returns a cut-off drone to the recovery point on its own. */
        }
        allocate returnToRecoveryPoint to system;
        trace returnToRecoveryPoint to SurveillanceDroneSwarm::OA::alphaReturn;
        trace returnToRecoveryPoint to SurveillanceDroneSwarm::OA::bravoReturn;

        // functions the capabilities AlertTriage and DecisionRecordKeeping introduce; OA has no activity for them, so they trace to the capability and to the acknowledgement they serve
        action triageAlerts : TriageAlerts {
            doc /* Ranks reports most-likely-to-matter first and merges duplicates before they reach the operator. */
        }
        allocate triageAlerts to system;
        trace triageAlerts to SurveillanceDroneSwarm::OA::AlertTriage;
        trace triageAlerts to SurveillanceDroneSwarm::OA::acknowledgeReports;
        action keepDecisionRecords : KeepDecisionRecords {
            doc /* Keeps the decision record of every report: frames, classifier version, threshold in force and who acknowledged it. */
        }
        allocate keepDecisionRecords to system;
        trace keepDecisionRecords to SurveillanceDroneSwarm::OA::DecisionRecordKeeping;
        trace keepDecisionRecords to SurveillanceDroneSwarm::OA::acknowledgeReports;

        // interactions, carried over as functional exchanges
        flow handOverSectorAtoB of Common::SectorHandoverProposal from handOverSector.handoverOut to handOverSector.handoverIn;
        flow rotateRechargeAtoB of Common::RechargeRotationSlot from rotateRecharge.rotationOut to rotateRecharge.rotationIn;
        flow redistributeCoverageAtoB of Common::CoverageAssignment from redistributeCoverage.coverageOut to redistributeCoverage.coverageIn;
        flow deconflictFlightAtoB of Common::FlightIntent from deconflictFlight.intentOut to deconflictFlight.intentIn;
        flow relayReportsAtoB of Common::DetectionReport from relayReportsThroughNeighbour.relayOut to relayReportsThroughNeighbour.relayIn;
        flow correlateTracksAtoB of Common::Track from correlateTracks.correlationOut to correlateTracks.correlationIn;
        flow handOverTrackAtoB of Common::Track from handOverTrack.trackHandoverOut to handOverTrack.trackHandoverIn;
        flow admitMemberAtoB of Common::AdmissionExchange from admitMember.admissionOut to admitMember.admissionIn;
        flow detectionAlpha of Common::DetectionReport from detectAndClassifyObject.detectionOut to deliverDetectionReport.detectionIn;
        flow reportFromAlpha of Common::DetectionReport from deliverDetectionReport.reportOut to acknowledgeDetectionReport.reportIn;
        flow receiptToAlpha of Common::ReportReceipt from acknowledgeDetectionReport.receiptOut to deliverDetectionReport.receiptIn;
        flow statusFromAlpha of Common::MemberStatus from reportMemberStatus.statusOut to presentStatusPicture.statusIn;
        flow trackPictureFromAlpha of Common::Track from reportTrackPicture.trackPictureOut to mergeTracks.swarmTrackIn;
        flow cameraTracksToMerge of Common::Track from provideCameraTracks.cameraTrackOut to mergeTracks.cameraTrackIn;
        flow taskingToAlpha of Common::TaskingOrder from taskSurveillanceArea.taskingOut to applySupervisoryDirectives.taskingIn;
        flow prioritiesToAlpha of Common::PriorityDirective from commandSupervisoryPriorities.priorityOut to applySupervisoryDirectives.priorityIn;
        flow recallToAlpha of Common::RecallDirective from recallAndLand.recallOut to applySupervisoryDirectives.recallIn;
        flow reportsToTriage of Common::DetectionReport from deliverDetectionReport.reportOut to triageAlerts.reportsIn;
        flow alertsToJudgement of Common::TriagedAlerts from triageAlerts.alertsOut to acknowledgeDetectionReport.alertsIn;
        flow reportsToRecords of Common::DetectionReport from deliverDetectionReport.reportOut to keepDecisionRecords.reportIn;
        flow receiptsToRecords of Common::ReportReceipt from acknowledgeDetectionReport.receiptOut to keepDecisionRecords.receiptIn;

        // rules the system never breaks (CV-18), stated once and satisfied by the member whose machines carry them
        #Rule requirement RecallWins {
            doc /* Once a drone is recalled, it does not watch again until it has landed. */
            subject m : SwarmMember;
        }
        satisfy RecallWins by SwarmMember;
        #Rule requirement ReturnsWhenIsolated {
            doc /* From any situation a drone can be in, it can always get back to landed; an isolated drone included. */
            subject m : SwarmMember;
        }
        satisfy ReturnsWhenIsolated by SwarmMember;
        #Rule requirement GeofenceBreachEndsWatch {
            doc /* Once a drone is outside its cleared airspace, it does not watch until it has landed. */
            subject m : SwarmMember;
        }
        satisfy GeofenceBreachEndsWatch by SwarmMember;
        #Rule requirement QuarantinedStaysOut {
            doc /* Once a drone is quarantined, it takes no part in coordination until it has been readmitted. */
            subject m : SwarmMember;
        }
        satisfy QuarantinedStaysOut by SwarmMember;

        // hazards at the system boundary
        package Hazards {
            doc /* Hazards the system as a whole adds at its boundary, each stated once here and satisfied below by the function or component that mitigates it. */
            #Hazard requirement PositionDriftHazard {
                doc /* Without satellite positioning, a drone's position estimate drifts and its reports place objects in the wrong place. */
                subject m : SwarmMember;
            }
            #Hazard requirement MeshJammingHazard {
                doc /* Interference cuts the links between drones, and coordination stalls. */
                subject s : SurveillanceDroneSwarmSystem;
            }
            #Hazard requirement MisclassificationHazard {
                doc /* A detection is reported as the wrong class, or a forced class where Unknown was the truth. */
                subject s : SurveillanceDroneSwarmSystem;
            }
            #Hazard requirement SensingDegradedUnnoticedHazard {
                doc /* A sensor degrades and nobody knows the reports from it are unreliable. */
                subject m : SwarmMember;
            }
            #Hazard requirement StaleTrackHazard {
                doc /* A track is shown as current after nothing has seen the object for a while. */
                subject s : SurveillanceDroneSwarmSystem;
            }
            #Hazard requirement SpoofedMemberHazard {
                doc /* Something that is not one of the drones joins the mesh and takes part in coordination. */
                subject s : SurveillanceDroneSwarmSystem;
            }
            #Hazard requirement MixedClassifierVersionsHazard {
                doc /* Drones run different classifier versions and classify the same object differently. */
                subject s : SurveillanceDroneSwarmSystem;
            }
            #Hazard requirement OperatorOverloadHazard {
                doc /* More alerts reach the operator than they can judge, and they accept what is in front of them. */
                subject s : SurveillanceDroneSwarmSystem;
            }
        }
        satisfy SurveillanceDroneSwarm::SA::Hazards::PositionDriftHazard by SwarmMember;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MeshJammingHazard by redistributeCoverage;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MisclassificationHazard by detectAndClassifyObject;
        satisfy SurveillanceDroneSwarm::SA::Hazards::SensingDegradedUnnoticedHazard by reportMemberStatus;
        satisfy SurveillanceDroneSwarm::SA::Hazards::StaleTrackHazard by reportTrackPicture;
        satisfy SurveillanceDroneSwarm::SA::Hazards::SpoofedMemberHazard by admitMember;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MixedClassifierVersionsHazard by admitMember;
        satisfy SurveillanceDroneSwarm::SA::Hazards::OperatorOverloadHazard by triageAlerts;

        // hazards stated at OA, satisfied here by path
        satisfy SurveillanceDroneSwarm::OA::Hazards::ManualCoordinationLagHazard by handOverSector;
        satisfy SurveillanceDroneSwarm::OA::Hazards::UnrecoveredDroneHazard by returnToRecoveryPoint;
        satisfy SurveillanceDroneSwarm::OA::Hazards::ReportLostInLinkGapHazard by deliverDetectionReport;
        satisfy SurveillanceDroneSwarm::OA::Hazards::WatchBeyondClearanceHazard by SwarmMember;
    }
    package LA {
        doc /* Logical architecture of the SurveillanceDroneSwarm. The system is decomposed into logical functions, the member definition of the twelve-drone population and the state machines every member and the fleet follow. Every logical function realises an SA function and is allocated to one of three logical components: the fleet of twelve identical members, which performs every sensing, reporting and coordination function (memberA and memberB stand for two of them, joined by the peer link); a thin ground station, which holds tasking, supervisory priorities, recall, acknowledgement and the status picture; and an alert triage unit, which ranks alerts and keeps the decision records. Nothing physical is chosen: the next step decides the nodes that carry them. */

        // ---------------------------------------------------------------
        // Placeholder component
        // ---------------------------------------------------------------

        part def SurveillanceDroneSwarmLogical {
            doc /* Placeholder logical component that holds every logical function until the next step decomposes it into logical components in more than one way and compares the ways. It is not a design choice. */
        }


        // ---------------------------------------------------------------
        // Coordination functions between members (realise SA functions)
        // ---------------------------------------------------------------

        #Coordination action def HandOverSector :> SurveillanceDroneSwarm::SA::HandOverSector {
            doc /* Logical function: a member that leaves to recharge hands its sector to a neighbour and stays until the neighbour confirms, so the sector stays watched. Realises SA::HandOverSector. */
        }

        #Coordination action def RotateRecharge :> SurveillanceDroneSwarm::SA::RotateRecharge {
            doc /* Logical function: members agree who leaves to recharge and who takes the place, so the rotation never empties a sector. Realises SA::RotateRecharge. */
        }

        #Coordination action def RedistributeCoverage :> SurveillanceDroneSwarm::SA::RedistributeCoverage {
            doc /* Logical function: members re-spread over the area when one is lost or leaves. It works from the last agreed assignment when links are jammed and can be performed by any member, so no single holder is needed. Realises SA::RedistributeCoverage. */
        }

        #Coordination action def DeconflictFlight :> SurveillanceDroneSwarm::SA::DeconflictFlight {
            doc /* Logical function: members announce flight intent so that two drones do not occupy the same airspace. Realises SA::DeconflictFlight. */
        }

        #Coordination action def RelayReportsThroughNeighbour :> SurveillanceDroneSwarm::SA::RelayReportsThroughNeighbour {
            doc /* Logical function: a member that cannot reach the operations centre sends its reports through a neighbour that can, and keeps each report until it is handed over. Realises SA::RelayReportsThroughNeighbour. */
        }

        #Coordination action def CorrelateTracks :> SurveillanceDroneSwarm::SA::CorrelateTracks {
            doc /* Logical function: members agree that tracks seen by different drones are the same object, giving one track per object. Realises SA::CorrelateTracks. */
        }

        #Coordination action def HandOverTrack :> SurveillanceDroneSwarm::SA::HandOverTrack {
            doc /* Logical function: a track is handed to the drone that watches the sector the object moves into. Realises SA::HandOverTrack. */
        }

        #Coordination action def AdmitMember :> SurveillanceDroneSwarm::SA::AdmitMember {
            doc /* Logical function: a drone is checked before it takes part in coordination, including the classifier version it runs; one that fails is quarantined until readmitted. Realises SA::AdmitMember. */
        }

        // ---------------------------------------------------------------
        // Command and control functions (realise SA functions)
        // ---------------------------------------------------------------

        #C2 action def TaskSurveillanceArea :> SurveillanceDroneSwarm::SA::TaskSurveillanceArea {
            doc /* Logical function: the swarm is tasked with the area of interest, its sectors and the mission window. Realises SA::TaskSurveillanceArea. */
        }

        #C2 action def CommandSupervisoryPriorities :> SurveillanceDroneSwarm::SA::CommandSupervisoryPriorities {
            doc /* Logical function: priorities, a sector to look at more closely and the reporting threshold are given to the swarm. Realises SA::CommandSupervisoryPriorities. */
        }

        #C2 action def RecallAndLand :> SurveillanceDroneSwarm::SA::RecallAndLand {
            doc /* Logical function: an order to recall and land the whole swarm or one drone, issuable at any time. Realises SA::RecallAndLand. */
        }

        #C2 action def PresentStatusPicture :> SurveillanceDroneSwarm::SA::PresentStatusPicture {
            doc /* Logical function: shows where every drone is, what it is doing, how much of the area is under watch and what is degraded. Realises SA::PresentStatusPicture. */
        }

        #C2 action def AcknowledgeDetectionReport :> SurveillanceDroneSwarm::SA::AcknowledgeDetectionReport {
            doc /* Logical function: each detection report is confirmed at the operations centre so nothing is lost in a link gap. Realises SA::AcknowledgeDetectionReport. */
        }

        // ---------------------------------------------------------------
        // Sensing, reporting and record functions (realise SA functions)
        // ---------------------------------------------------------------

        action def DetectAndClassifyObject :> SurveillanceDroneSwarm::SA::DetectAndClassifyObject {
            doc /* Logical function: detects a moving object in the member's sector and classifies it, saying Unknown when confidence is short of the reporting threshold. Realises SA::DetectAndClassifyObject. */
        }

        action def DeliverDetectionReport :> SurveillanceDroneSwarm::SA::DeliverDetectionReport {
            doc /* Logical function: delivers a report with position and time to the operations centre, holds it while cut off and clears it only on acknowledgement. Realises SA::DeliverDetectionReport. */
        }

        action def ApplySupervisoryDirectives :> SurveillanceDroneSwarm::SA::ApplySupervisoryDirectives {
            doc /* Logical function: a drone takes up the tasking, priorities and recall given by the duty controller and lands on recall. Realises SA::ApplySupervisoryDirectives. */
        }

        action def ReportMemberStatus :> SurveillanceDroneSwarm::SA::ReportMemberStatus {
            doc /* Logical function: a drone reports its position, activity and degradations, sensing degradation included, for the status picture. Realises SA::ReportMemberStatus. */
        }

        action def ReportTrackPicture :> SurveillanceDroneSwarm::SA::ReportTrackPicture {
            doc /* Logical function: reports the tracks held, one per object, marking a track stale once nothing has seen the object for 120 seconds. Realises SA::ReportTrackPicture. */
        }

        action def ReturnToRecoveryPoint :> SurveillanceDroneSwarm::SA::ReturnToRecoveryPoint {
            doc /* Logical function: a drone that has lost contact with the swarm returns to the recovery point on its own. Realises SA::ReturnToRecoveryPoint. */
        }

        action def TriageAlerts :> SurveillanceDroneSwarm::SA::TriageAlerts {
            doc /* Logical function: ranks reports so that what is most likely to matter reaches the operator first, merges duplicates and keeps the alert rate inside what one operator can judge. Realises SA::TriageAlerts. */
        }

        action def KeepDecisionRecords :> SurveillanceDroneSwarm::SA::KeepDecisionRecords {
            doc /* Logical function: keeps for every report the frames it came from, the classifier version, the reporting threshold in force and who acknowledged it. Realises SA::KeepDecisionRecords. */
        }

        // ---------------------------------------------------------------
        // Function usages, each allocated to its logical component (see the allocations below)
        // ---------------------------------------------------------------

        action handOverSector : HandOverSector {
            doc /* Usage of the sector hand-over function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action rotateRecharge : RotateRecharge {
            doc /* Usage of the recharge rotation function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action redistributeCoverage : RedistributeCoverage {
            doc /* Usage of the coverage redistribution function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action deconflictFlight : DeconflictFlight {
            doc /* Usage of the flight deconfliction function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action relayReportsThroughNeighbour : RelayReportsThroughNeighbour {
            doc /* Usage of the report relay function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action correlateTracks : CorrelateTracks {
            doc /* Usage of the track correlation function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action handOverTrack : HandOverTrack {
            doc /* Usage of the track hand-over function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action admitMember : AdmitMember {
            doc /* Usage of the member admission function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action taskSurveillanceArea : TaskSurveillanceArea {
            doc /* Usage of the tasking function; allocated to the ground station. */
        }
        action commandSupervisoryPriorities : CommandSupervisoryPriorities {
            doc /* Usage of the supervisory command function; allocated to the ground station. */
        }
        action recallAndLand : RecallAndLand {
            doc /* Usage of the recall function; allocated to the ground station. */
        }
        action presentStatusPicture : PresentStatusPicture {
            doc /* Usage of the status presentation function; allocated to the ground station. */
        }
        action acknowledgeDetectionReport : AcknowledgeDetectionReport {
            doc /* Usage of the report acknowledgement function; allocated to the ground station. */
        }
        action detectAndClassifyObject : DetectAndClassifyObject {
            doc /* Usage of the detection and classification function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action deliverDetectionReport : DeliverDetectionReport {
            doc /* Usage of the report delivery function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action applySupervisoryDirectives : ApplySupervisoryDirectives {
            doc /* Usage of the directive uptake function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action reportMemberStatus : ReportMemberStatus {
            doc /* Usage of the status reporting function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action reportTrackPicture : ReportTrackPicture {
            doc /* Usage of the track reporting function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action returnToRecoveryPoint : ReturnToRecoveryPoint {
            doc /* Usage of the return-to-recovery function; allocated to fleet: every one of the twelve drones performs it. */
        }
        action triageAlerts : TriageAlerts {
            doc /* Usage of the alert triage function; allocated to the alert triage unit. */
        }
        action keepDecisionRecords : KeepDecisionRecords {
            doc /* Usage of the decision record function; allocated to the alert triage unit. */
        }

        // ---------------------------------------------------------------
        // Member definition: the replicable element of the population
        // ---------------------------------------------------------------


        #Configuration state def FleetConfiguration {
            doc /* Condition of the mesh between drones, taken over the whole twelve-drone population. */

            initial start;
            transition start -> MeshIntact;

            state MeshIntact {
                doc /* The links between drones are all usable. */
            }
            state MeshDegraded {
                doc /* A share of the links between drones is jammed and the swarm coordinates over what is left. */
            }

            transition MeshIntact -> MeshDegraded;
            transition MeshDegraded -> MeshIntact;
        }

        // ---------------------------------------------------------------
        // Worst-case estimates of the measures of effectiveness (CV-17)
        // The two LA alternatives (ground-centred and member-centred
        // coordination) were scored on these; the taken one keeps them,
        // derived from this layer's own values where the arithmetic allows.
        // ---------------------------------------------------------------

        #Estimate attribute areaUnderWatchFraction :> Common::areaUnderWatchFraction {
            doc /* Worst case, derived rather than stated (CV-17): the assert constraint below fixes it from this layer's own values, 12 x (40 - 7.41) / 60 x 0.12 = 0.782. Basis: twelve drones, 40 min endurance and a 20 min battery swap, so each drone is airborne 40 of every 60 minutes; the round trip to a sector up to 4 km away at 18 m/s takes 7.41 of those 40; one drone keeps 3.0 km2 of the 25 km2 area, 0.12, under watch. Target 0.9 is not met by this arithmetic: it would need the round trip under 2.5 min, that is recharge points much closer to the sectors. */
        }

        #Estimate attribute coverageLossAfterMemberLossFraction :> Common::coverageLossAfterMemberLossFraction {
            doc /* Worst case, derived by the assert constraint below (CV-17): one watching drone holds 0.12 of the area out of the 0.782 under watch, 0.12 / 0.782 = 0.153 of the coverage lost before any re-spread; the same for either allocation because the loss precedes the redistribution. */
        }

        #Estimate attribute coverageUnderMeshJammingFraction :> Common::coverageUnderMeshJammingFraction {
            doc /* Worst case, derived rather than stated (CV-17): the assert constraint below fixes it from this layer's own values, 0.782 x (1 - 0.5 x 0.307) = 0.662. Basis: the 0.782 under watch, less the gaps of lost hand-overs. A member leaving to recharge hands its sector to a neighbour and stays until the neighbour confirms; a jammer covering a neighbourhood jams every confirmation path there together, so in the worst case the share of hand-overs lost equals the share of links jammed, the brief's 0.5. Each lost hand-over leaves its sector empty for about half a swap turnaround, 10 min out of the 32.59 min a member watches between hand-overs, 0.307, derived from the same time model as the 0.782. The member-centred allocation is the worse case. Placeholder target 0.75 is not met. */
        }

        #Estimate attribute reportAgeAtOperationsCentreSeconds :> Common::reportAgeAtOperationsCentreSeconds = 40 {
            doc /* Worst case 40 s with the link up. Basis: about 5 s to classify, up to three relay hops of about 2 s each through neighbours, about 5 s on the ground link and about 20 s for triage queuing. Relay hop count is the driver; units are seconds. */
        }

        #Estimate attribute positionErrorWithoutSatelliteMetres :> Common::positionErrorWithoutSatelliteMetres = 80 {
            doc /* Worst case 80 m after ten minutes without satellite positioning. Basis: about 10.8 km flown in ten minutes at 18 m/s; camera matching against stored maps bounds the drift, but over featureless ground the bound is loose. Placeholder target 50 m is not met. Units are metres. */
        }

        #Estimate attribute reportHoldWhileCutOffMinutes :> Common::reportHoldWhileCutOffMinutes = 40 {
            doc /* Worst case 40 min. Basis: the hold is bounded by one 40 min sortie, after which the drone lands and its held reports survive the battery swap on board. Units are minutes. */
        }

        #Estimate attribute missedDetectionFraction :> Common::missedDetectionFraction = 0.12 {
            doc /* Worst case 0.12. Basis: poor lighting, weather and deliberately misleading paint or shapes reduce what the sensors can tell apart. Placeholder target 0.10 is not met. */
        }

        #Estimate attribute falseAlarmsPerHour :> Common::falseAlarmsPerHour = 3 {
            doc /* Worst case 3 per hour reaching the operator. Basis: the reporting threshold is held at the level that gives the missed-detection figure above; a higher threshold trades false alarms for missed detections. Units are 1/h. */
        }

        #Estimate attribute alertsReachingOperatorPerHour :> Common::alertsReachingOperatorPerHour = 24 {
            doc /* Worst case 24 per hour after triage. Basis: duplicates from several drones are merged, but with all twelve drones flying and busy sectors the remaining alerts still exceed 20. At 30 s per alert the operator could judge up to 120 per hour. Units are 1/h. */
        }

        #Estimate attribute acknowledgedReportsThatMatterFraction :> Common::acknowledgedReportsThatMatterFraction = 0.7 {
            doc /* Worst case 0.7. Basis: triage ranks by classification confidence only at this layer, without operator feedback on what mattered. */
        }

        #Estimate attribute onboardClassificationCostUsdPerMember :> Common::onboardClassificationCostUsdPerMember = 350 {
            doc /* Worst case 350 USD per member. Basis: the case in which the whole classification runs on the drone, as in the member-centred allocation. Placeholder target 300 USD is not met. Units are USD. */
        }

        #Estimate attribute unattendedWatchDurationHours :> Common::unattendedWatchDurationHours {
            doc /* Worst case, derived by the assert constraint below (CV-17): 40 / 60 = 0.667 h. Basis: batteries are swapped by ground crew, so without people the watch ends when the first 40 min sortie is spent. The brief states no number for this measure, so it has no target: the estimate is reported until the customer's figure comes. Units are hours. */
        }

        // ---------------------------------------------------------------
        // Hazards this layer adds (a split of responsibilities)
        // ---------------------------------------------------------------

        package Hazards {
            doc /* Hazards the logical split of responsibilities adds, each stated once here and satisfied below by the function that mitigates it. */

            #Hazard requirement CoordinationConcentrationHazard {
                subject s : SurveillanceDroneSwarmLogical;
                doc /* About the coordination and command-and-control functions of the logical system: if they end up on one component, a ground station or a single member, the loss of that component stalls sector hand-over, rotation and redistribution for the whole swarm. */
            }

            #Hazard requirement SectorHandOffLostHazard {
                subject m : SwarmMember;
                doc /* About handOverSector between members: a member leaves to recharge before the neighbour has taken the sector, because the hand-over message was jammed or the neighbour was lost, and the sector is unwatched. */
            }

            #Hazard requirement RelayedReportDroppedHazard {
                subject m : SwarmMember;
                doc /* About relayReportsThroughNeighbour: a report handed to a neighbour for relay is dropped on the way, and the originating member believes it has been delivered. */
            }

            #Hazard requirement TrackHandOverGapHazard {
                subject m : SwarmMember;
                doc /* About handOverTrack and correlateTracks: a track is handed to a drone that does not take it up, or two drones both keep it, so the object is lost or shown twice. */
            }
        doc /* Hazards the member-centred split adds at LA: what moving coordination onto the members, and concentrating command and triage in single ground components, introduces. */

        #Hazard requirement SplitCoordinationHazard {
            subject m : SwarmMember;
            doc /* When jamming partitions the mesh, sub-swarms coordinate separately: two of them take the same sector while another sector is left empty, or two members leave to recharge from the same sector. */
        }
        #Hazard requirement LostHandoffHazard {
            subject m : SwarmMember;
            doc /* A sector or a track handed from one member to a neighbour is dropped in the hand-off: the leaving member has gone and the receiving member never took it, so the sector goes unwatched or the track goes stale unnoticed. */
        }
        #Hazard requirement GroundStationSinglePointHazard {
            subject g : GroundStation;
            doc /* All command and control sits in the one ground station: if it or its link is lost, tasking, supervisory priorities, recall and the status picture are unavailable and the operator cannot see or stop the swarm. */
        }
        #Hazard requirement TriageUnitSinglePointHazard {
            subject t : AlertTriageUnit;
            doc /* All reports pass through the one triage unit: if it fails, detection reports and decision records stop reaching the operator, or reach them unranked and unmerged. */
        }
        }
        satisfy SurveillanceDroneSwarm::SA::Hazards::MeshJammingHazard by relayReportsThroughNeighbour;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MisclassificationHazard by detectAndClassifyObject;
        satisfy SurveillanceDroneSwarm::SA::Hazards::SensingDegradedUnnoticedHazard by reportMemberStatus;
        satisfy SurveillanceDroneSwarm::SA::Hazards::StaleTrackHazard by reportTrackPicture;
        satisfy SurveillanceDroneSwarm::SA::Hazards::SpoofedMemberHazard by admitMember;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MixedClassifierVersionsHazard by admitMember;
        satisfy SurveillanceDroneSwarm::SA::Hazards::OperatorOverloadHazard by triageAlerts;

        satisfy Hazards::CoordinationConcentrationHazard by redistributeCoverage;
        satisfy Hazards::SectorHandOffLostHazard by rotateRecharge;
        satisfy Hazards::RelayedReportDroppedHazard by deliverDetectionReport;
        satisfy Hazards::TrackHandOverGapHazard by correlateTracks;
            // carried from the layer above; restored by the orchestrator
            trace taskSurveillanceArea to SurveillanceDroneSwarm::SA::taskSurveillanceArea;
            trace commandSupervisoryPriorities to SurveillanceDroneSwarm::SA::commandSupervisoryPriorities;
            trace recallAndLand to SurveillanceDroneSwarm::SA::recallAndLand;
            allocate presentStatusPicture to groundStation;
            trace presentStatusPicture to SurveillanceDroneSwarm::SA::presentStatusPicture;
            trace acknowledgeDetectionReport to SurveillanceDroneSwarm::SA::acknowledgeDetectionReport;
            trace handOverSector to SurveillanceDroneSwarm::SA::handOverSector;
            trace rotateRecharge to SurveillanceDroneSwarm::SA::rotateRecharge;
            trace redistributeCoverage to SurveillanceDroneSwarm::SA::redistributeCoverage;
            trace deconflictFlight to SurveillanceDroneSwarm::SA::deconflictFlight;
            trace relayReportsThroughNeighbour to SurveillanceDroneSwarm::SA::relayReportsThroughNeighbour;
            trace correlateTracks to SurveillanceDroneSwarm::SA::correlateTracks;
            trace handOverTrack to SurveillanceDroneSwarm::SA::handOverTrack;
            trace admitMember to SurveillanceDroneSwarm::SA::admitMember;
            trace detectAndClassifyObject to SurveillanceDroneSwarm::SA::detectAndClassifyObject;
            trace deliverDetectionReport to SurveillanceDroneSwarm::SA::deliverDetectionReport;
            trace applySupervisoryDirectives to SurveillanceDroneSwarm::SA::applySupervisoryDirectives;
            trace reportMemberStatus to SurveillanceDroneSwarm::SA::reportMemberStatus;
            trace reportTrackPicture to SurveillanceDroneSwarm::SA::reportTrackPicture;
            trace returnToRecoveryPoint to SurveillanceDroneSwarm::SA::returnToRecoveryPoint;
            trace triageAlerts to SurveillanceDroneSwarm::SA::triageAlerts;
            trace keepDecisionRecords to SurveillanceDroneSwarm::SA::keepDecisionRecords;

        // ── architecture, alternative 2 ──
        #Member part def SwarmMember {
            doc /* One of the twelve identical drones, member-centred: besides sensing, classifying and reporting, every member itself performs the whole of swarm coordination (sector handover, recharge rotation, coverage redistribution, deconfliction, link relay, track correlation, track handover, member admission) over the mesh, so the watch does not depend on the ground station or the ground link. */
            out port meshOut : Common::MeshPort;
            in port meshIn : ~Common::MeshPort;
            out port reportsOut : Common::DetectionReport;
            out port trackPictureOut : Common::Track;
            out port statusOut : Common::MemberStatus;
            in port taskingIn : Common::TaskingOrder;
            in port priorityIn : Common::PriorityDirective;
            in port recallIn : Common::RecallDirective;
            in port receiptIn : Common::ReportReceipt;

            #Mode state def SwarmMemberModes {
                doc /* Operating condition of one member: nominal, without satellite positioning, sensors not trustworthy, cut off from the other members, or failed admission and readmitted. Carries the rule QuarantinedStaysOut. */
                @SysproseVerification::PropertyPattern {
                    doc /* QuarantinedStaysOut: once a drone is quarantined, it takes no part in coordination until it has been readmitted. */
                    attribute pattern = "absence";
                    attribute scope = "between";
                    attribute q = "state Quarantined";
                    attribute r = "state Readmitted";
                    attribute p = "state Nominal";
                }
                initial start;
                transition start -> Nominal;
                state Nominal {
                    doc /* The member has positioning, trusted sensors, contact with the mesh and admission, and takes part in coordination. */
                }
                state NavigationDegraded {
                    doc /* The member has no satellite positioning and navigates by what its camera sees against stored maps. */
                }
                state SensingDegraded {
                    doc /* The member's sensors cannot be trusted as they are, and what it reports from them is marked accordingly. */
                }
                state Isolated {
                    doc /* The member is cut off from the other members and coordinates with none of them; it keeps watching its own sector on its own until it must recover. */
                }
                state Quarantined {
                    doc /* The member has failed admission (identity or classifier version) and takes no part in coordination until it has been readmitted. */
                }
                state Readmitted {
                    doc /* The member has passed the readmission check and is about to take part in coordination again. */
                }
                transition Nominal -> NavigationDegraded;
                transition NavigationDegraded -> Nominal;
                transition Nominal -> SensingDegraded;
                transition SensingDegraded -> Nominal;
                transition Nominal -> Isolated;
                transition Isolated -> Nominal;
                transition Nominal -> Quarantined;
                transition Quarantined -> Readmitted;
                transition Readmitted -> Nominal;
            }

            #State state def SwarmMemberStates {
                doc /* Where one member is in its sortie: on the ground, flying out, watching, flying back, recalled, outside its cleared airspace, or returning to the recovery point on its own. Carries the rules RecallWins, GeofenceBreachEndsWatch and ReturnsWhenIsolated. */
                @SysproseVerification::PropertyPattern {
                    doc /* RecallWins: once a drone is recalled, it does not watch again until it has landed. */
                    attribute pattern = "absence";
                    attribute scope = "between";
                    attribute q = "state Recalled";
                    attribute r = "state Landed";
                    attribute p = "state Watching";
                }
                @SysproseVerification::PropertyPattern {
                    doc /* GeofenceBreachEndsWatch: once a drone is outside its cleared airspace, it does not watch until it has landed. */
                    attribute pattern = "absence";
                    attribute scope = "between";
                    attribute q = "state OutsideClearance";
                    attribute r = "state Landed";
                    attribute p = "state Watching";
                }
                @SysproseVerification::PropertyPattern {
                    doc /* ReturnsWhenIsolated: from any situation a drone can be in, it can always get back to landed; an isolated drone included. */
                    attribute pattern = "recovery";
                    attribute scope = "globally";
                    attribute p = "state Landed";
                }
                initial start;
                transition start -> Landed;
                state Landed {
                    doc /* On the ground, battery being swapped or waiting for tasking. */
                }
                state Transiting {
                    doc /* Flying from the recharge point to its sector, or to the sector it has just taken over from a neighbour. */
                }
                state Watching {
                    doc /* Holding watch over its sector. */
                }
                state Returning {
                    doc /* Flying back to the recharge point to swap the battery once relieved, or to land when the wind is above moderate. */
                }
                state Recalled {
                    doc /* Recalled by order and on its way down; it does not watch until landed. */
                }
                state Recovering {
                    doc /* Cut off and returning to the recovery point on its own. */
                }
                state OutsideClearance {
                    doc /* Outside the cleared airspace or the clearance withdrawn: on its way down, and it does not watch until landed. */
                }
                transition Landed -> Transiting;
                transition Transiting -> Watching;
                transition Watching -> Returning;
                transition Returning -> Landed;
                transition Transiting -> Recalled;
                transition Watching -> Recalled;
                transition Recalled -> Landed;
                transition Transiting -> Recovering;
                transition Watching -> Recovering;
                transition Recovering -> Landed;
                transition Transiting -> OutsideClearance;
                transition Watching -> OutsideClearance;
                transition OutsideClearance -> Landed;
            }
        }
        part def GroundStation {
            doc /* The thin ground component of the member-centred split: it only carries command and control (tasking, supervisory priorities, recall, status picture, acknowledgement). It does not coordinate the swarm; if it is lost the members keep the watch. */
            in port statusIn : Common::MemberStatus;
            in port trackPictureIn : Common::Track;
            in port alertsIn : Common::TriagedAlerts;
            in port recordsIn : Common::DecisionRecords;
            out port taskingOut : Common::TaskingOrder;
            out port priorityOut : Common::PriorityDirective;
            out port recallOut : Common::RecallDirective;
            out port receiptOut : Common::ReportReceipt;
            out port recordReceiptOut : Common::ReportReceipt;

            #Mode state def GroundStationModes {
                doc /* Whether the ground station can reach the swarm and the operations centre: with the link up it supervises, with the link down it can neither task nor recall and the members carry on alone. */
                initial start;
                transition start -> LinkUp;
                state LinkUp {
                    doc /* The link to the operations centre is available: tasking, command, reports, status and acknowledgements pass. */
                }
                state LinkDown {
                    doc /* The link is unavailable: the station holds what it has and the swarm coordinates and holds reports on its own. */
                }
                transition LinkUp -> LinkDown;
                transition LinkDown -> LinkUp;
            }

            #State state def GroundStationStates {
                doc /* What the ground station is doing for the operator: waiting for tasking, supervising the swarm, or issuing a recall. */
                initial start;
                transition start -> Standby;
                state Standby {
                    doc /* No mission window is tasked; nothing is being supervised. */
                }
                state Supervising {
                    doc /* Tasking and priorities are out, the status picture is presented and reports are acknowledged. */
                }
                state Recalling {
                    doc /* A recall order is being issued to the whole swarm or one drone. */
                }
                transition Standby -> Supervising;
                transition Supervising -> Recalling;
                transition Recalling -> Supervising;
                transition Supervising -> Standby;
            }
        }
        part def AlertTriageUnit {
            doc /* Ranks the reports of all members so that what most likely matters reaches the operator first, merges duplicates, and keeps the decision record of every report. Kept apart from the ground station so that command and control stays thin. */
            in port reportsIn : Common::DetectionReport;
            in port receiptIn : Common::ReportReceipt;
            out port alertsOut : Common::TriagedAlerts;
            out port decisionRecordsOut : Common::DecisionRecords;
        }
        part fleet : SwarmMember [12] {
            doc /* The twelve identical drones; every function a member performs, and all eight coordination functions, sit here. */
        }
        part memberA : SwarmMember {
            doc /* First representative member, one end of the peer link. */
        }
        part memberB : SwarmMember {
            doc /* Second representative member, the other end of the peer link. */
        }
        interface peerLink : Common::MeshInterface connect memberA.meshOut to memberB.meshIn;
        part groundStation : GroundStation {
            doc /* The ground station: command and control only. */
        }
        part triageUnit : AlertTriageUnit {
            doc /* The alert triage and decision-record component between the members and the operator. */
        }
        connection reportsFeed connect fleet.reportsOut to triageUnit.reportsIn;
        connection trackPictureFeed connect fleet.trackPictureOut to groundStation.trackPictureIn;
        connection statusFeed connect fleet.statusOut to groundStation.statusIn;
        connection taskingFeed connect groundStation.taskingOut to fleet.taskingIn;
        connection priorityFeed connect groundStation.priorityOut to fleet.priorityIn;
        connection recallFeed connect groundStation.recallOut to fleet.recallIn;
        connection receiptFeed connect groundStation.receiptOut to fleet.receiptIn;
        connection recordReceiptFeed connect groundStation.recordReceiptOut to triageUnit.receiptIn;
        connection alertsFeed connect triageUnit.alertsOut to groundStation.alertsIn;
        connection recordsFeed connect triageUnit.decisionRecordsOut to groundStation.recordsIn;
        allocate handOverSector to fleet;
        allocate rotateRecharge to fleet;
        allocate redistributeCoverage to fleet;
        allocate deconflictFlight to fleet;
        allocate relayReportsThroughNeighbour to fleet;
        allocate correlateTracks to fleet;
        allocate handOverTrack to fleet;
        allocate admitMember to fleet;
        allocate detectAndClassifyObject to fleet;
        allocate deliverDetectionReport to fleet;
        allocate applySupervisoryDirectives to fleet;
        allocate reportMemberStatus to fleet;
        allocate reportTrackPicture to fleet;
        allocate returnToRecoveryPoint to fleet;
        allocate taskSurveillanceArea to groundStation;
        allocate commandSupervisoryPriorities to groundStation;
        allocate recallAndLand to groundStation;
        allocate acknowledgeDetectionReport to groundStation;
        allocate triageAlerts to triageUnit;
        allocate keepDecisionRecords to triageUnit;
        satisfy SurveillanceDroneSwarm::SA::Hazards::PositionDriftHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MeshJammingHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MisclassificationHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::SensingDegradedUnnoticedHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::StaleTrackHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::SpoofedMemberHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MixedClassifierVersionsHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::OperatorOverloadHazard by triageUnit;
        satisfy LA::Hazards::CoordinationConcentrationHazard by fleet;
        satisfy LA::Hazards::SectorHandOffLostHazard by fleet;
        satisfy LA::Hazards::RelayedReportDroppedHazard by fleet;
        satisfy LA::Hazards::TrackHandOverGapHazard by fleet;
        satisfy Hazards::SplitCoordinationHazard by fleet;
        satisfy Hazards::LostHandoffHazard by fleet;
        satisfy Hazards::GroundStationSinglePointHazard by fleet;
        satisfy Hazards::TriageUnitSinglePointHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::RecallWins by fleet;
        satisfy SurveillanceDroneSwarm::SA::ReturnsWhenIsolated by fleet;
        satisfy SurveillanceDroneSwarm::SA::GeofenceBreachEndsWatch by fleet;
        satisfy SurveillanceDroneSwarm::SA::QuarantinedStaysOut by fleet;
        attribute fleetMemberCount = 12;
        attribute memberFlightMinutes = 40;
        attribute memberTurnaroundMinutes = 20;
        attribute sectorTransitMinutes = 7.41 { doc /* Round trip to the farthest sector and back at cruise speed, 2 x 4000 m / 18 m/s = 7.41 min, spent from the same 40 minutes of flight. Unit: minutes. */ }
        attribute memberCoverageFraction = 0.12;
        assert constraint { areaUnderWatchFraction == fleetMemberCount * ((memberFlightMinutes - sectorTransitMinutes) / (memberFlightMinutes + memberTurnaroundMinutes)) * memberCoverageFraction }
        assert constraint { coverageLossAfterMemberLossFraction == memberCoverageFraction / areaUnderWatchFraction }
        attribute jammedLinkFraction = 0.5 { doc /* Share of the links between drones jammed in the brief's jamming test condition, restated here because a constraint body cannot reach Common. */ }
        attribute sectorGapShareOfLostHandOver { doc /* Share of a sector's watch lost when its hand-over is lost, derived by the assert constraint below (CV-17): 10 / 32.59 = 0.307. The leaving member stays until the neighbour confirms, so a lost hand-over leaves the sector empty for about half a swap turnaround, 20 / 2 = 10 min, out of the watch a member keeps between hand-overs, its flight less the round trip, 40 - 7.41 = 32.59 min. */ }
        assert constraint { doc /* A lost hand-over empties the sector for half a swap turnaround, out of the watch between hand-overs. */ sectorGapShareOfLostHandOver == (memberTurnaroundMinutes / 2) / (memberFlightMinutes - sectorTransitMinutes) }
        assert constraint { doc /* Correlated worst case: a jammer covering a neighbourhood jams every confirmation path, so the share of hand-overs lost is the share of links jammed. */ coverageUnderMeshJammingFraction == areaUnderWatchFraction * (1 - jammedLinkFraction * sectorGapShareOfLostHandOver) }
        assert constraint { doc /* Without ground crew to swap batteries, the watch lasts one sortie; 60 minutes to the hour. */ unattendedWatchDurationHours == memberFlightMinutes / 60 }
        #prose part laTradeOff {
        doc /* Architecture trade-off for LA. Alternative 2 was taken.
                 alternative 1: total 0.52 (measures 0.29, review 0.44, structure 0.84, resilience 0.25)
                 alternative 2: total 0.65 (measures 0.29, review 0.56, structure 0.86, resilience 0.81)
                 The measures term scores the worst case of each alternative's own #Estimate: claims its architecture states with their basis, not measurements.
                 This comparison exists to place command and control, and the two alternatives differ exactly there: Alternative 1 puts sector handover, rotation, redistribution, deconfliction, track correlation and admission inside one GroundSwarmCoordinator; Alternative 2 puts all eight on SwarmMember and leaves a thin GroundStation holding only tasking, priorities, recall, acknowledgement and the status picture. I would take Alternative 2. The deciding evidence is the two components' own state machines. SwarmCoordinatorModes.FleetUnreachable says each drone 'acts on its last assignment' — coverage then decays as endurance runs out, and Alternative 1 discharges its own GroundCoordinatorSinglePointHazard and CoordinationConcentrationHazard onto fleet while allocating no coordination function to fleet, so that mitigation is unbacked. GroundStationModes.LinkDown says the members coordinate and hold reports on their own, and the allocations back it. Alternative 1 is also the weaker model on its own arithmetic: watchingMembers evaluates to 6.8, contradicting the stated 0.78 and 0.16, so three measures score vacuous against Alternative 2's one, and its coverageUnderMeshJammingFraction basis literally blames 'the member-centred allocation' for a worst case that belongs to a ground-centred decision path. Alternative 1 is not without merit and two of its choices should be carried across: recallToFleet, which keeps recall alive when the coordinator dies — Alternative 2 has no equivalent and its operator cannot stop the swarm with the station gone; and the split of GroundDecisionRecordStore from GroundAlertTriage, which Alternative 2 collapses into one AlertTriageUnit so that losing the ranker loses the provenance record. Alternative 1's triggered transitions are also the better basis for checking RecallWins and QuarantinedStaysOut than Alternative 2's untriggered ones. Before PA, Alternative 2 needs four fixes: a direct recall path to fleet, records split out of AlertTriageUnit, triggers and a return direction on the peer link (one unidirectional MeshPort cannot be the whole evidence for eight coordination functions, least of all distributed admitMember), and a rule monitor separate from the component that detects and classifies — neither alternative has one today. */
        }
    }
    package PA {
        #prompt part paGuidance {
            doc /* PA: the components that will be built. Behaviour parts are hosted in node parts by nesting, physical links are typed, item definitions carry units, and resource budgets are require constraints. */
        }

        // the system, to be decomposed into physical components
        part def SurveillanceDroneSwarmPhysical {
            out port reportsOut : LA::SwarmMember::reportsOut;
            out port trackPictureOut : LA::SwarmMember::trackPictureOut;
            out port statusOut : LA::SwarmMember::statusOut;
            in port taskingIn : LA::SwarmMember::taskingIn;
            in port priorityIn : LA::SwarmMember::priorityIn;
            in port recallIn : LA::SwarmMember::recallIn;
            in port receiptIn : LA::SwarmMember::receiptIn;
            doc /* The system as one physical whole, carried over from LA with its ports. It is built from the PA parts declared beside it — fleet, groundStation, groundRecallTransmitter, groundAlertTriage, groundDecisionRecordStore — which carry the functions (see the allocations); mainAssembly is its usage. */
        }

        // the population: 12 identical members (CV-16)
        #prose part fleetFact {
            doc /* Population: 12 members of SwarmMember, carried by fleet, exchanging through Common::MeshInterface. Carried from the brief; the architecture instantiates it. */
        }

        // functions, carried over from LA: every one of them has to be realised here
        action def HandOverSector {
            doc /* Realises LA::HandOverSector at PA: performed on board every drone of the fleet (allocate handOverSector to fleet). */
        }
        action def RotateRecharge {
            doc /* Realises LA::RotateRecharge at PA: performed on board every drone of the fleet (allocate rotateRecharge to fleet). */
        }
        action def RedistributeCoverage {
            doc /* Realises LA::RedistributeCoverage at PA: performed on board every drone of the fleet (allocate redistributeCoverage to fleet). */
        }
        action def DeconflictFlight {
            doc /* Realises LA::DeconflictFlight at PA: performed on board every drone of the fleet (allocate deconflictFlight to fleet). */
        }
        action def RelayReportsThroughNeighbour {
            doc /* Realises LA::RelayReportsThroughNeighbour at PA: performed on board every drone of the fleet (allocate relayReportsThroughNeighbour to fleet). */
        }
        action def CorrelateTracks {
            doc /* Realises LA::CorrelateTracks at PA: performed on board every drone of the fleet (allocate correlateTracks to fleet). */
        }
        action def HandOverTrack {
            doc /* Realises LA::HandOverTrack at PA: performed on board every drone of the fleet (allocate handOverTrack to fleet). */
        }
        action def AdmitMember {
            doc /* Realises LA::AdmitMember at PA: performed on board every drone of the fleet (allocate admitMember to fleet). */
        }
        action def TaskSurveillanceArea {
            doc /* Realises LA::TaskSurveillanceArea at PA: performed by the ground station (groundStation, command and control only) (allocate taskSurveillanceArea to groundStation). */
        }
        action def CommandSupervisoryPriorities {
            doc /* Realises LA::CommandSupervisoryPriorities at PA: performed by the ground station (groundStation, command and control only) (allocate commandSupervisoryPriorities to groundStation). */
        }
        action def RecallAndLand {
            doc /* Realises LA::RecallAndLand at PA: performed by the ground recall transmitter, the direct recall path from the ground to the fleet (allocate recallAndLand to groundRecallTransmitter). */
        }
        action def PresentStatusPicture {
            doc /* Realises LA::PresentStatusPicture at PA: performed by the ground station (groundStation, command and control only) (allocate presentStatusPicture to groundStation). */
        }
        action def AcknowledgeDetectionReport {
            doc /* Realises LA::AcknowledgeDetectionReport at PA: performed by the ground station (groundStation, command and control only) (allocate acknowledgeDetectionReport to groundStation). */
        }
        action def DetectAndClassifyObject {
            doc /* Realises LA::DetectAndClassifyObject at PA: performed on board every drone of the fleet (allocate detectAndClassifyObject to fleet). */
        }
        action def DeliverDetectionReport {
            doc /* Realises LA::DeliverDetectionReport at PA: performed on board every drone of the fleet (allocate deliverDetectionReport to fleet). */
        }
        action def ApplySupervisoryDirectives {
            doc /* Realises LA::ApplySupervisoryDirectives at PA: performed on board every drone of the fleet (allocate applySupervisoryDirectives to fleet). */
        }
        action def ReportMemberStatus {
            doc /* Realises LA::ReportMemberStatus at PA: performed on board every drone of the fleet (allocate reportMemberStatus to fleet). */
        }
        action def ReportTrackPicture {
            doc /* Realises LA::ReportTrackPicture at PA: performed on board every drone of the fleet (allocate reportTrackPicture to fleet). */
        }
        action def ReturnToRecoveryPoint {
            doc /* Realises LA::ReturnToRecoveryPoint at PA: performed on board every drone of the fleet (allocate returnToRecoveryPoint to fleet). */
        }
        action def TriageAlerts {
            doc /* Realises LA::TriageAlerts at PA: performed by the ground alert-triage node, before the operator (allocate triageAlerts to groundAlertTriage). */
        }
        action def KeepDecisionRecords {
            doc /* Realises LA::KeepDecisionRecords at PA: performed by the ground decision-record store (allocate keepDecisionRecords to groundDecisionRecordStore). */
        }
        #Coordination action handOverSector : HandOverSector;
        trace handOverSector to SurveillanceDroneSwarm::LA::handOverSector;
        #Coordination action rotateRecharge : RotateRecharge;
        trace rotateRecharge to SurveillanceDroneSwarm::LA::rotateRecharge;
        #Coordination action redistributeCoverage : RedistributeCoverage;
        trace redistributeCoverage to SurveillanceDroneSwarm::LA::redistributeCoverage;
        #Coordination action deconflictFlight : DeconflictFlight;
        trace deconflictFlight to SurveillanceDroneSwarm::LA::deconflictFlight;
        #Coordination action relayReportsThroughNeighbour : RelayReportsThroughNeighbour;
        trace relayReportsThroughNeighbour to SurveillanceDroneSwarm::LA::relayReportsThroughNeighbour;
        #Coordination action correlateTracks : CorrelateTracks;
        trace correlateTracks to SurveillanceDroneSwarm::LA::correlateTracks;
        #Coordination action handOverTrack : HandOverTrack;
        trace handOverTrack to SurveillanceDroneSwarm::LA::handOverTrack;
        #Coordination action admitMember : AdmitMember;
        trace admitMember to SurveillanceDroneSwarm::LA::admitMember;
        #C2 action taskSurveillanceArea : TaskSurveillanceArea;
        trace taskSurveillanceArea to SurveillanceDroneSwarm::LA::taskSurveillanceArea;
        #C2 action commandSupervisoryPriorities : CommandSupervisoryPriorities;
        trace commandSupervisoryPriorities to SurveillanceDroneSwarm::LA::commandSupervisoryPriorities;
        #C2 action recallAndLand : RecallAndLand;
        trace recallAndLand to SurveillanceDroneSwarm::LA::recallAndLand;
        #C2 action presentStatusPicture : PresentStatusPicture;
        trace presentStatusPicture to SurveillanceDroneSwarm::LA::presentStatusPicture;
        #C2 action acknowledgeDetectionReport : AcknowledgeDetectionReport;
        trace acknowledgeDetectionReport to SurveillanceDroneSwarm::LA::acknowledgeDetectionReport;
        action detectAndClassifyObject : DetectAndClassifyObject;
        trace detectAndClassifyObject to SurveillanceDroneSwarm::LA::detectAndClassifyObject;
        action deliverDetectionReport : DeliverDetectionReport;
        trace deliverDetectionReport to SurveillanceDroneSwarm::LA::deliverDetectionReport;
        action applySupervisoryDirectives : ApplySupervisoryDirectives;
        trace applySupervisoryDirectives to SurveillanceDroneSwarm::LA::applySupervisoryDirectives;
        action reportMemberStatus : ReportMemberStatus;
        trace reportMemberStatus to SurveillanceDroneSwarm::LA::reportMemberStatus;
        action reportTrackPicture : ReportTrackPicture;
        trace reportTrackPicture to SurveillanceDroneSwarm::LA::reportTrackPicture;
        action returnToRecoveryPoint : ReturnToRecoveryPoint;
        trace returnToRecoveryPoint to SurveillanceDroneSwarm::LA::returnToRecoveryPoint;
        action triageAlerts : TriageAlerts;
        trace triageAlerts to SurveillanceDroneSwarm::LA::triageAlerts;
        action keepDecisionRecords : KeepDecisionRecords;
        trace keepDecisionRecords to SurveillanceDroneSwarm::LA::keepDecisionRecords;

        // ── architecture, alternative 2 ──
        // ===== media (typed physical links) =====
        connection def MeshRadioMedium {
            doc /* The radio medium between two drones: a mesh radio that does not depend on the ground link and that interference can degrade. It carries hand-over, rotation, deconfliction, relay, track and admission traffic. */
        }
        connection def GroundLinkMedium {
            doc /* The intermittently available radio link between the drones and the ground station (tasking, priorities, reports, status, acknowledgements). It may be down for minutes; members hold reports meanwhile. */
        }
        connection def RecallRadioMedium {
            doc /* A dedicated recall broadcast radio from the ground recall transmitter straight to every drone. It is separate from the mesh and from the ground link, so an order to land does not depend on the ground station or on the coordination path. */
        }
        connection def GroundLanMedium {
            doc /* Wired local network between the ground components at the ground site (station, triage, record store, recall transmitter). */
        }
        // ===== behaviour parts (hosted by nesting inside node parts) =====
        part def PerceptionSoftware {
            doc /* Behaviour on the member: detects moving objects in the member's sector and classifies them, says Unknown below the reporting threshold, and marks frames from a degraded sensor. Realises detectAndClassifyObject. */
        }
        part def SwarmCoordinationSoftware {
            doc /* Behaviour on the member: the eight coordination functions - sector hand-over, recharge rotation, coverage redistribution, deconfliction, report relay, track correlation, track hand-over and member admission with the classifier-version check - run over the mesh with no coordinator. Coordination traffic has its own priority class on the radio. */
        }
        part def ReportHoldSoftware {
            doc /* Behaviour on the member: keeps each report in the non-volatile store until it is acknowledged, delivers reports over the ground link or a neighbour, and reports status and the track picture (a track is stale after 120 s). Realises deliverDetectionReport, reportMemberStatus, reportTrackPicture. */
        }
        part def DirectiveUptakeSoftware {
            doc /* Behaviour on the member: takes up tasking, priorities and the reporting threshold given by the duty controller. Realises applySupervisoryDirectives together with the safety monitor's recall handling. */
        }
        part def NavigationSoftware {
            doc /* Behaviour on the member: fuses satellite positioning, inertial data and camera matching against stored maps, so position stays bounded when satellite positioning is out. */
        }
        part def FlightRuleMonitor {
            doc /* Behaviour on the member, separate from perception and coordination: enforces recall, clearance and geofence and the return to the recovery point; it holds the member's state machine and lands the drone when contact or clearance is lost. Realises returnToRecoveryPoint and the landing on recall. */
        }
        part def CommandAndControlSoftware {
            doc /* Behaviour on the ground station: tasking, supervisory priorities, the swarm status picture and forwarding of the operations centre's acknowledgements. It does not coordinate the swarm. */
        }
        part def RecallIssuerSoftware {
            doc /* Behaviour on the recall transmitter: repeats a recall order to the whole swarm or one drone until each member has reported landing or recall accepted. */
        }
        part def AlertRankingSoftware {
            doc /* Behaviour on the triage node: ranks reports by confidence, class and sector priority, merges duplicates from several drones and releases at most the hourly alert cap to the operator; held alerts stay in a ranked backlog whose size is shown. */
        }
        part def DecisionRecordSoftware {
            doc /* Behaviour on the record store: keeps for each report its frames, classifier version, reporting threshold in force and who acknowledged it. */
        }
        // ===== node parts on the drone =====
        #Node part def MeshRadioNode {
            doc /* The mesh radio of one drone; the physical carrier of the peer link. */
            out port rfOut : Common::MeshPort;
            in port rfIn : ~Common::MeshPort;
        }
        #Node part def GroundLinkRadioNode {
            doc /* The drone's radio to the ground station; carries reports, status, tracks, tasking, priorities and receipts when the link is up. */
        }
        #Node part def MissionComputerNode {
            doc /* The drone's mission computer with the classification accelerator and the non-volatile report store; hosts perception, swarm coordination, report hold and directive uptake. */
            part perception : PerceptionSoftware;
            part swarmCoordination : SwarmCoordinationSoftware;
            part reportHold : ReportHoldSoftware;
            part directiveUptake : DirectiveUptakeSoftware;
        }
        #Node part def NavigationNode {
            doc /* The drone's navigation unit: satellite receiver, inertial unit and the camera path used for map matching. */
            part navigator : NavigationSoftware;
        }
        #Node part def SafetyMonitorNode {
            doc /* An independent microcontroller with its own supply and watchdog and the dedicated recall receiver; kept apart from the mission computer so a fault in detecting and classifying cannot disable recall, geofence or the return to the recovery point. */
            part ruleMonitor : FlightRuleMonitor;
        }
        // ===== the population member =====
        #Member part def SwarmMember {
            doc /* One of the twelve identical drones. It performs all eight coordination functions itself over the mesh, so the watch does not depend on the ground station or the ground link. It is built from a mesh radio, a ground-link radio, a mission computer, a navigation unit and an independent safety monitor. */
            out port meshOut : Common::MeshPort;
            in port meshIn : ~Common::MeshPort;
            out port reportsOut : Common::DetectionReport;
            out port trackPictureOut : Common::Track;
            out port statusOut : Common::MemberStatus;
            in port taskingIn : Common::TaskingOrder;
            in port priorityIn : Common::PriorityDirective;
            in port recallIn : Common::RecallDirective;
            in port receiptIn : Common::ReportReceipt;

            #Node part meshRadio : MeshRadioNode;
            #Node part groundRadio : GroundLinkRadioNode;
            #Node part missionComputer : MissionComputerNode;
            #Node part navigation : NavigationNode;
            #Node part safetyMonitor : SafetyMonitorNode;

            #Mode state def SwarmMemberModes {
                doc /* Operating condition of one member: nominal, without satellite positioning, sensors not trustworthy, cut off from the other members, or failed admission and readmitted. Carries the rule QuarantinedStaysOut. */
                @SysproseVerification::PropertyPattern {
                    doc /* QuarantinedStaysOut: Once a drone is quarantined, it takes no part in coordination until it has been readmitted. */
                    attribute pattern = "absence";
                    attribute scope = "between";
                    attribute q = "state Quarantined";
                    attribute r = "state Readmitted";
                    attribute p = "state Nominal";
                }
                initial start;
                state Nominal { doc /* Positioning, trusted sensors, contact with the mesh and admission: takes part in coordination. */ }
                state NavigationDegraded { doc /* No satellite positioning; navigates by what its camera sees against stored maps. */ }
                state SensingDegraded { doc /* Sensors cannot be trusted as they are; what it reports from them is marked accordingly. */ }
                state Isolated { doc /* Cut off from the other drones and coordinating with none of them. */ }
                state Quarantined { doc /* Failed admission (identity or classifier version); takes no part in coordination until readmitted. */ }
                state Readmitted { doc /* Passed the readmission check and about to take part in coordination again. */ }
                transition start -> Nominal;
                transition Nominal -> NavigationDegraded;
                transition NavigationDegraded -> Nominal;
                transition Nominal -> SensingDegraded;
                transition SensingDegraded -> Nominal;
                transition Nominal -> Isolated;
                transition NavigationDegraded -> Isolated;
                transition SensingDegraded -> Isolated;
                transition admissionFails first Nominal accept peerVerdict : Common::MemberStatus do action quarantineSelf then Quarantined;
                transition readmissionPasses first Quarantined accept readmitVerdict : Common::MemberStatus do action resumeCoordination then Readmitted;
                transition Isolated -> Readmitted;
                transition Isolated -> Quarantined;
                transition Readmitted -> Nominal;
            }

            #State state def SwarmMemberStates {
                doc /* Where one member is in its sortie: on the ground, flying out, watching, flying back, recalled, outside its cleared airspace, or returning to the recovery point on its own. Executed by the independent safety monitor. Carries the rules RecallWins, GeofenceBreachEndsWatch and ReturnsWhenIsolated. */
                @SysproseVerification::PropertyPattern {
                    doc /* RecallWins: Once a drone is recalled, it does not watch again until it has landed. */
                    attribute pattern = "absence";
                    attribute scope = "between";
                    attribute q = "state Recalled";
                    attribute r = "state Landed";
                    attribute p = "state Watching";
                }
                @SysproseVerification::PropertyPattern {
                    doc /* GeofenceBreachEndsWatch: Once a drone is outside its cleared airspace, it does not watch until it has landed. */
                    attribute pattern = "absence";
                    attribute scope = "between";
                    attribute q = "state OutsideClearance";
                    attribute r = "state Landed";
                    attribute p = "state Watching";
                }
                @SysproseVerification::PropertyPattern {
                    doc /* ReturnsWhenIsolated: From any situation a drone can be in, it can always get back to landed; an isolated drone included. */
                    attribute pattern = "recovery";
                    attribute scope = "globally";
                    attribute p = "state Landed";
                }
                initial start;
                state Landed { doc /* On the ground, battery being swapped or waiting for tasking. */ }
                state Transiting { doc /* Flying from the recharge point to its sector, or to a sector just taken over. */ }
                state Watching { doc /* Holding watch over its sector. */ }
                state Returning { doc /* Flying back to the recharge point once relieved, or to land when the wind is above moderate. */ }
                state Recalled { doc /* Recalled by order and on its way down; does not watch until landed. */ }
                state Recovering { doc /* Cut off and returning to the recovery point on its own. */ }
                state OutsideClearance { doc /* Outside the cleared airspace or clearance withdrawn: on its way down, does not watch until landed. */ }
                transition start -> Landed;
                transition Landed -> Transiting;
                transition Transiting -> Watching;
                transition Watching -> Returning;
                transition Returning -> Landed;
                transition recallWhileWatching first Watching accept recallW : Common::RecallDirective do action descendOnRecallW then Recalled;
                transition recallWhileTransiting first Transiting accept recallT : Common::RecallDirective do action descendOnRecallT then Recalled;
                transition recallWhileReturning first Returning accept recallR : Common::RecallDirective do action descendOnRecallR then Recalled;
                transition Recalled -> Landed;
                transition clearanceLostWhileWatching first Watching accept clearanceW : Common::TaskingOrder do action descendOnClearanceW then OutsideClearance;
                transition clearanceLostWhileTransiting first Transiting accept clearanceT : Common::TaskingOrder do action descendOnClearanceT then OutsideClearance;
                transition OutsideClearance -> Landed;
                transition Watching -> Recovering;
                transition Transiting -> Recovering;
                transition Recovering -> Landed;
            }
        }
        // ===== node parts on the ground =====
        #Node part def GroundStationNode {
            doc /* The ground station, thin by design: command and control only (tasking, supervisory priorities, status picture, acknowledgements). It does not coordinate the swarm; if it or its link is lost the members keep the watch. Hosts the base radio of the ground link. */
            in port statusIn : Common::MemberStatus;
            in port trackPictureIn : Common::Track;
            in port alertsIn : Common::TriagedAlerts;
            in port recordsIn : Common::DecisionRecords;
            out port taskingOut : Common::TaskingOrder;
            out port priorityOut : Common::PriorityDirective;
            out port recallOut : Common::RecallDirective;
            out port receiptOut : Common::ReportReceipt;
            out port recordReceiptOut : Common::ReportReceipt;
            part commandSoftware : CommandAndControlSoftware;

            #Mode state def GroundStationModes {
                doc /* Whether the ground station can reach the swarm and the operations centre: with the link down it can neither task nor recall through it and the members carry on alone. */
                initial start;
                state LinkUp { doc /* The link is available: tasking, command, reports, status and acknowledgements pass. */ }
                state LinkDown { doc /* The link is unavailable: the station holds what it has; the swarm coordinates and holds reports on its own. */ }
                transition start -> LinkUp;
                transition LinkUp -> LinkDown;
                transition LinkDown -> LinkUp;
            }
            #State state def GroundStationStates {
                doc /* What the ground station is doing for the operator: waiting for tasking, supervising, or issuing a recall. */
                initial start;
                state Standby { doc /* No mission window tasked; nothing supervised. */ }
                state Supervising { doc /* Tasking and priorities out, status picture shown, reports acknowledged. */ }
                state Recalling { doc /* A recall order is being issued to the whole swarm or one drone. */ }
                transition start -> Standby;
                transition Standby -> Supervising;
                transition Supervising -> Recalling;
                transition Recalling -> Supervising;
                transition Supervising -> Standby;
                transition Recalling -> Standby;
            }
        }
        #Node part def GroundRecallTransmitterNode {
            doc /* A ground recall transmitter with its own radio and its own operator panel, so an order to land reaches the drones directly and does not depend on the ground station or the ground link. It also takes the order from the station when that is up. */
            in port recallIn : Common::RecallDirective;
            out port recallOut : Common::RecallDirective;
            part recallIssuer : RecallIssuerSoftware;
        }
        #Node part def GroundAlertTriageNode {
            doc /* A server that ranks the reports of all drones, merges duplicates and releases alerts to the operator inside the hourly cap. Kept apart from the record store so that losing the ranker does not lose the provenance record. */
            in port reportsIn : Common::DetectionReport;
            out port alertsOut : Common::TriagedAlerts;
            part alertRanker : AlertRankingSoftware;
        }
        #Node part def GroundDecisionRecordStoreNode {
            doc /* A server with durable storage for the decision records. It receives every report itself and the acknowledgements, independently of triage. */
            in port reportsIn : Common::DetectionReport;
            in port receiptIn : Common::ReportReceipt;
            out port recordsOut : Common::DecisionRecords;
            part recordKeeper : DecisionRecordSoftware;
        }
        part mainAssembly : SurveillanceDroneSwarmPhysical;
        part fleet : SwarmMember [12] {
            doc /* The twelve identical drones. Every function a member performs, and all eight coordination functions, sit here. */
        }
        part memberA : SwarmMember {
            doc /* First representative member, one end of the peer link. */
        }
        part memberB : SwarmMember {
            doc /* Second representative member, the other end of the peer link. */
        }
        #Node part groundStation : GroundStationNode {
            doc /* The ground station: command and control only. */
        }
        #Node part groundRecallTransmitter : GroundRecallTransmitterNode {
            doc /* The direct recall path from the ground to the fleet. */
        }
        #Node part groundAlertTriage : GroundAlertTriageNode {
            doc /* Alert ranking and merging before the operator. */
        }
        #Node part groundDecisionRecordStore : GroundDecisionRecordStoreNode {
            doc /* Durable decision records of every report. */
        }
        // ===== peer link: exchange and physical carrier, both directions =====
        interface peerLink : Common::MeshInterface connect memberA.meshOut to memberB.meshIn {
            doc /* Coordination traffic from representative A to representative B over the mesh. */
        }
        interface peerLinkReturn : Common::MeshInterface connect memberB.meshOut to memberA.meshIn {
            doc /* The return direction: B answers A, so a hand-over can be confirmed and an admission answered. */
        }
        connection meshRadioLinkAB : MeshRadioMedium connect memberA.meshRadio.rfOut to memberB.meshRadio.rfIn {
            doc /* The radio path that carries the peer link from A to B; a jammed link is this connection degraded. */
        }
        connection meshRadioLinkBA : MeshRadioMedium connect memberB.meshRadio.rfOut to memberA.meshRadio.rfIn {
            doc /* The radio path that carries the return direction from B to A. */
        }
        // ===== ground links =====
        connection reportsFeed : GroundLinkMedium connect fleet.reportsOut to groundAlertTriage.reportsIn {
            doc /* Detection reports from the drones to the triage server. */
        }
        connection reportsRecordFeed : GroundLinkMedium connect fleet.reportsOut to groundDecisionRecordStore.reportsIn {
            doc /* The same reports also go straight to the record store, so the record survives the loss of the triage server. */
        }
        connection trackPictureFeed : GroundLinkMedium connect fleet.trackPictureOut to groundStation.trackPictureIn {
            doc /* Tracks held by the drones to the ground station. */
        }
        connection statusFeed : GroundLinkMedium connect fleet.statusOut to groundStation.statusIn {
            doc /* Member status, degradations included, for the status picture. */
        }
        connection taskingFeed : GroundLinkMedium connect groundStation.taskingOut to fleet.taskingIn {
            doc /* Tasking from the station to the drones. */
        }
        connection priorityFeed : GroundLinkMedium connect groundStation.priorityOut to fleet.priorityIn {
            doc /* Supervisory priorities and reporting threshold to the drones. */
        }
        connection receiptFeed : GroundLinkMedium connect groundStation.receiptOut to fleet.receiptIn {
            doc /* Acknowledgements back to the drones so they can clear held reports. */
        }
        connection recallRequestFeed : GroundLanMedium connect groundStation.recallOut to groundRecallTransmitter.recallIn {
            doc /* A recall order from the station to the recall transmitter. */
        }
        connection recallBroadcastFeed : RecallRadioMedium connect groundRecallTransmitter.recallOut to fleet.recallIn {
            doc /* The direct recall broadcast from the transmitter to the drones. */
        }
        connection recordReceiptFeed : GroundLanMedium connect groundStation.recordReceiptOut to groundDecisionRecordStore.receiptIn {
            doc /* Who acknowledged each report, to the record store. */
        }
        connection alertsFeed : GroundLanMedium connect groundAlertTriage.alertsOut to groundStation.alertsIn {
            doc /* Ranked alerts from triage to the station for the operator. */
        }
        connection recordsFeed : GroundLanMedium connect groundDecisionRecordStore.recordsOut to groundStation.recordsIn {
            doc /* Decision records from the store to the station. */
        }
        // ===== fleet-level condition =====
        #Configuration state def FleetConfiguration {
            doc /* Condition of the mesh between drones, taken over the whole twelve-drone fleet. */
            initial start;
            state MeshIntact { doc /* The links between drones are all usable. */ }
            state MeshDegraded { doc /* A share of the links between drones is jammed and the swarm coordinates over what is left. */ }
            transition start -> MeshIntact;
            transition MeshIntact -> MeshDegraded;
            transition MeshDegraded -> MeshIntact;
        }
        // ===== allocation: one per function =====
        allocate handOverSector to fleet;
        allocate rotateRecharge to fleet;
        allocate redistributeCoverage to fleet;
        allocate deconflictFlight to fleet;
        allocate relayReportsThroughNeighbour to fleet;
        allocate correlateTracks to fleet;
        allocate handOverTrack to fleet;
        allocate admitMember to fleet;
        allocate taskSurveillanceArea to groundStation;
        allocate commandSupervisoryPriorities to groundStation;
        allocate recallAndLand to groundRecallTransmitter;
        allocate presentStatusPicture to groundStation;
        allocate acknowledgeDetectionReport to groundStation;
        allocate detectAndClassifyObject to fleet;
        allocate deliverDetectionReport to fleet;
        allocate applySupervisoryDirectives to fleet;
        allocate reportMemberStatus to fleet;
        allocate reportTrackPicture to fleet;
        allocate returnToRecoveryPoint to fleet;
        allocate triageAlerts to groundAlertTriage;
        allocate keepDecisionRecords to groundDecisionRecordStore;
        trace fleet to SurveillanceDroneSwarm::LA::fleet;
        trace memberA to SurveillanceDroneSwarm::LA::memberA;
        trace memberB to SurveillanceDroneSwarm::LA::memberB;
        trace peerLink to SurveillanceDroneSwarm::LA::peerLink;
        trace groundStation to SurveillanceDroneSwarm::LA::groundStation;
        trace groundRecallTransmitter to SurveillanceDroneSwarm::LA::groundStation;
        trace groundAlertTriage to SurveillanceDroneSwarm::LA::triageUnit;
        trace groundDecisionRecordStore to SurveillanceDroneSwarm::LA::triageUnit;
        // ===== budgets the brief fixes, restated as valued attributes and held by require constraints =====
        attribute fleetMemberCount = 12 { doc /* Twelve drones, fixed by the brief. */ }
        attribute memberFlightMinutes = 40 { doc /* One sortie, about 40 minutes, transit included. Unit: minutes. */ }
        attribute memberTurnaroundMinutes = 20 { doc /* Battery swap on the ground, about 20 minutes. Unit: minutes. */ }
        attribute memberCruiseMetresPerSecond = 18 { doc /* Cruise speed between recharge point and sector. Unit: metres per second. */ }
        attribute sectorReachMetres = 4000 { doc /* Worst-case distance from the recharge point to a sector, one way. Unit: metres. Carried from the logical basis. */ }
        attribute memberTransitMinutes = 7.41 { doc /* Round trip out and back at cruise speed, 2 x 4000 m / 18 m/s = 7.41 min, spent from the same 40 minutes. Unit: minutes. */ }
        attribute memberFootprintSquareKilometres = 3.0 { doc /* Area under watch at once from one drone. Unit: square kilometres. */ }
        attribute areaOfInterestSquareKilometres = 25 { doc /* The tasked area, up to 25 square kilometres. */ }
        attribute memberCoverageFraction = 0.12 { doc /* Share of the tasked area one watching drone covers: 3.0 / 25. It is more than 1/12 because only the airborne drones watch; the area estimate follows from it, worked in the estimate's doc. */ }
        assert constraint { areaUnderWatchFraction == fleetMemberCount * ((memberFlightMinutes - memberTransitMinutes) / (memberFlightMinutes + memberTurnaroundMinutes)) * memberCoverageFraction }
        assert constraint { coverageLossAfterMemberLossFraction == memberCoverageFraction / areaUnderWatchFraction }
        attribute jammedLinkFraction = 0.5 { doc /* Share of the links between drones jammed in the brief's jamming test condition, restated here because a constraint body cannot reach Common. */ }
        attribute sectorGapShareOfLostHandOver { doc /* Share of a sector's watch lost when its hand-over is lost, derived by the assert constraint below (CV-17): 10 / 32.59 = 0.307. The leaving member stays until the neighbour confirms, so a lost hand-over leaves the sector empty for about half a swap turnaround, 20 / 2 = 10 min, out of the watch a member keeps between hand-overs, its flight less the round trip, 40 - 7.41 = 32.59 min. The same as LA: the physical architecture changes none of these times. */ }
        assert constraint { doc /* A lost hand-over empties the sector for half a swap turnaround, out of the watch between hand-overs. */ sectorGapShareOfLostHandOver == (memberTurnaroundMinutes / 2) / (memberFlightMinutes - memberTransitMinutes) }
        assert constraint { doc /* Correlated worst case: a jammer covering a neighbourhood jams every confirmation path, so the share of hand-overs lost is the share of links jammed. */ coverageUnderMeshJammingFraction == areaUnderWatchFraction * (1 - jammedLinkFraction * sectorGapShareOfLostHandOver) }
        attribute operatorSecondsPerAlert = 30 { doc /* The least time the operator needs per alert. Unit: seconds. */ }
        attribute alertCapPerHour = 20 { doc /* Alerts the triage node releases to the operator per hour; alerts above it wait in the ranked backlog. Unit: 1/h. */ }
        attribute trackStaleAfterSeconds = 120 { doc /* A track is marked stale once nothing has seen the object for this long. Unit: seconds. */ }
        attribute reportStoreCapacityReports = 2000 { doc /* Reports the on-board non-volatile store can hold. Sizing assumption, a placeholder until the customer states the report rate. */ }
        attribute peakReportsPerMemberPerMinute = 6 { doc /* Peak report rate of one drone. Sizing assumption, a placeholder. Unit: 1/min. */ }
        attribute acceleratorModuleCostUsd = 230 { doc /* Classification accelerator module per drone. Unit: USD. */ }
        attribute modelMemoryCostUsd = 60 { doc /* Memory for the classifier model and frame buffer per drone. Unit: USD. */ }
        attribute reportStoreFlashCostUsd = 30 { doc /* Non-volatile report store per drone. Unit: USD. */ }
        attribute identityElementCostUsd = 30 { doc /* Secure identity element used for admission per drone. Unit: USD. */ }
        require constraint { doc /* The fleet is not larger than the twelve the brief fixes. */ fleetMemberCount <= 12 }
        require constraint { doc /* A sortie lasts at least the 40 minutes the brief fixes. */ memberFlightMinutes >= 40 }
        require constraint { doc /* The swap turnaround is no longer than 20 minutes. */ memberTurnaroundMinutes <= 20 }
        require constraint { doc /* Cruise speed is at least 18 m/s. */ memberCruiseMetresPerSecond >= 18 }
        require constraint { doc /* One drone keeps at least 3.0 square kilometres under watch. */ memberFootprintSquareKilometres >= 3 }
        require constraint { doc /* The area to cover is no more than 25 square kilometres. */ areaOfInterestSquareKilometres <= 25 }
        require constraint { doc /* The per-member coverage fraction is the footprint over the area. */ memberCoverageFraction * areaOfInterestSquareKilometres == memberFootprintSquareKilometres }
        require constraint { doc /* The transit time covers the round trip to the farthest sector at cruise speed. */ memberTransitMinutes * memberCruiseMetresPerSecond * 60 >= 2 * sectorReachMetres }
        require constraint { doc /* Transit fits inside the endurance, so a drone reaches its sector and returns on one battery. */ memberTransitMinutes < memberFlightMinutes }
        require constraint { doc /* The alerts released per hour fit in the operator's hour at the time each needs. */ alertCapPerHour * operatorSecondsPerAlert <= 3600 }
        require constraint { doc /* The operator has at least 30 seconds per alert. */ operatorSecondsPerAlert >= 30 }
        require constraint { doc /* A track goes stale within 120 seconds. */ trackStaleAfterSeconds <= 120 }
        require constraint { doc /* The on-board store holds the reports of one whole sortie at the peak rate. */ reportStoreCapacityReports >= memberFlightMinutes * peakReportsPerMemberPerMinute }
        // ===== worst-case estimates, directly in this package =====
        #Estimate attribute areaUnderWatchFraction :> Common::areaUnderWatchFraction {
            doc /* Worst case, derived from this layer's own values by the assert constraint below (CV-17): 12 x (40 - 7.41) / 60 x 0.12 = 0.782. Twelve drones, a 40 min sortie and a 20 min swap keep each drone airborne 40 of every 60 minutes; the round trip to a sector up to 4 km away at 18 m/s takes 7.41 of those 40; one watching drone covers 0.12 of the area (3.0 of 25 km2). The same arithmetic LA states, over PA's own attributes: the physical architecture changes none of the numbers it rests on. Target 0.9 is not met; it would need the round trip under 2.5 min. */
        }
        #Estimate attribute coverageLossAfterMemberLossFraction :> Common::coverageLossAfterMemberLossFraction {
            doc /* Worst case, derived by the assert constraint below (CV-17): one watching drone holds 0.12 of the area out of the 0.782 under watch, 0.12 / 0.782 = 0.153 of the coverage lost before any re-spread. It is the same wherever redistribution runs, because the loss precedes it; the member-centred redistribution then re-spreads from the last agreed assignment without waiting for the ground. */
        }
        #Estimate attribute coverageUnderMeshJammingFraction :> Common::coverageUnderMeshJammingFraction {
            doc /* Worst case, derived from this layer's own values by the assert constraint above (CV-17): 0.782 x (1 - 0.5 x 0.307) = 0.662. The baseline under watch less the gaps of lost hand-overs: a jammer covering a neighbourhood jams every confirmation path there together, so in the worst case the share of hand-overs lost equals the share of links jammed, the brief's 0.5; each lost hand-over leaves its sector empty for about half a swap turnaround, 10 min out of the 32.59 min a member watches between hand-overs, 0.307, derived from the same time model as the 0.782. The same arithmetic LA states: the physical architecture adds no modelled confirmation path and changes none of the inputs, so the value equals LA's. Placeholder target 0.75 is not met. */
        }
        #Estimate attribute reportAgeAtOperationsCentreSeconds :> Common::reportAgeAtOperationsCentreSeconds = 40 {
            doc /* Worst case 40 s with the link up. About 5 s to classify, up to three relay hops of about 2 s each through neighbours, about 5 s on the ground link, about 20 s queuing at the triage server, and about 4 s to write the record. Relay hop count is the driver. Units are seconds. */
        }
        #Estimate attribute positionErrorWithoutSatelliteMetres :> Common::positionErrorWithoutSatelliteMetres = 80 {
            doc /* Worst case 80 m after ten minutes without satellite positioning. About 10.8 km flown in ten minutes at 18 m/s; the inertial unit bridges between camera matches against stored maps, but over featureless ground the bound is loose and the inertial drift alone is not better than that. Placeholder target 50 m is not met. Units are metres. */
        }
        #Estimate attribute reportHoldWhileCutOffMinutes :> Common::reportHoldWhileCutOffMinutes = 40 {
            doc /* Worst case 40 minutes: a cut-off drone holds every report in its non-volatile store for at least the whole 40 min sortie (the memberFlightMinutes budget), and the store (2000 reports against 40 x 6 = 240 needed) is not the limit; held reports survive the battery swap on board and are cleared only on acknowledgement. Units are minutes. */
        }
        #Estimate attribute missedDetectionFraction :> Common::missedDetectionFraction = 0.12 {
            doc /* Worst case 0.12. Poor lighting, weather and deliberately misleading paint or shapes reduce what the sensors can tell apart; the classifier runs on the drone at full frame rate. Placeholder target 0.10 is not met. */
        }
        #Estimate attribute falseAlarmsPerHour :> Common::falseAlarmsPerHour = 3 {
            doc /* Worst case 3 per hour reaching the operator, with the reporting threshold held at the level that gives the missed-detection figure above; a higher threshold trades false alarms for misses. Units are 1/h. */
        }
        #Estimate attribute alertsReachingOperatorPerHour :> Common::alertsReachingOperatorPerHour {
            doc /* Worst case, derived: the triage node releases at most the hourly cap of 20 alerts to the operator, best first; the rest wait in a ranked backlog that is shown, not dropped. 20 alerts at 30 s each is 600 s of the operator's hour. Units are 1/h. */
        }
        assert constraint { doc /* Alerts reaching the operator per hour equal the cap the triage node enforces. */ alertsReachingOperatorPerHour == alertCapPerHour }
        #Estimate attribute acknowledgedReportsThatMatterFraction :> Common::acknowledgedReportsThatMatterFraction = 0.75 {
            doc /* Worst case 0.75. Triage ranks by confidence, class and the sector priority the operator gave, which the logical split lacked (0.7 on confidence alone); there is still no feedback from the operator on what mattered. Placeholder target 0.8 is not met. */
        }
        #Estimate attribute onboardClassificationCostUsdPerMember :> Common::onboardClassificationCostUsdPerMember {
            doc /* Worst case, derived: the whole classification runs on the drone. Accelerator module 230 + model and frame memory 60 + non-volatile report store 30 + secure identity element 30 = 350 USD per member. Placeholder target 300 USD is not met. Units are USD. */
        }
        assert constraint { doc /* The per-member cost is the sum of the on-board parts. */ onboardClassificationCostUsdPerMember == acceleratorModuleCostUsd + modelMemoryCostUsd + reportStoreFlashCostUsd + identityElementCostUsd }
        #Estimate attribute unattendedWatchDurationHours :> Common::unattendedWatchDurationHours {
            doc /* Worst case, derived by the assert constraint below (CV-17): batteries are swapped by ground crew, so without people the watch ends when the first 40 min sortie is spent, 40 / 60 = 0.667 h. The same as LA: the physical architecture changes neither number. The brief states no number for this measure, so it has no target: the estimate is reported until the customer's figure comes. Units are hours. */
        }
        assert constraint { doc /* Without ground crew to swap batteries, the watch lasts one sortie; 60 minutes to the hour. */ unattendedWatchDurationHours == memberFlightMinutes / 60 }
        // ===== hazards this physical split adds =====
        package Hazards {
            doc /* Hazards the chosen technology adds at the physical layer: a store that loses data, a monitor that shares a fault, a radio that drops silently, a cap that hides an alert, a record store that fails, a radio that saturates. */
            #Hazard requirement HeldReportStoreCorruptionHazard {
                subject s : MissionComputerNode;
                doc /* About the non-volatile report store in the member's mission computer: a battery swap or a power dip during a write corrupts or erases reports that were never acknowledged, and the drone believes they are still held. */
            }
            #Hazard requirement MonitorCommonCauseHazard {
                subject s : SafetyMonitorNode;
                doc /* About the safety monitor: if it shares supply or clock with the mission computer, one brownout or software crash disables recall, geofence and the return to the recovery point at once. */
            }
            #Hazard requirement RecallRadioSilentHazard {
                subject s : GroundRecallTransmitterNode;
                doc /* About the recall transmitter: its radio fails or is jammed without notice, and the operator believes the order to land was sent and taken. */
            }
            #Hazard requirement AlertCapHidesAlertHazard {
                subject s : GroundAlertTriageNode;
                doc /* About the hourly alert cap in the triage node: an alert that matters is held in the backlog behind lesser ones and reaches the operator late. */
            }
            #Hazard requirement DecisionRecordStoreLossHazard {
                subject s : GroundDecisionRecordStoreNode;
                doc /* About the record store: it fails or fills, and the frames, classifier version, threshold and acknowledgement of reports already acted on are lost. */
            }
            #Hazard requirement MeshRadioSaturationHazard {
                subject s : MeshRadioNode;
                doc /* About the mesh radio: relay, status and admission traffic share the one radio with hand-over messages, so a burst of relayed reports delays a hand-over and a sector goes unwatched. */
            }
        }
        satisfy Hazards::HeldReportStoreCorruptionHazard by fleet;
        satisfy Hazards::MonitorCommonCauseHazard by fleet;
        satisfy Hazards::RecallRadioSilentHazard by groundRecallTransmitter;
        satisfy Hazards::RecallRadioSilentHazard by groundStation;
        satisfy Hazards::AlertCapHidesAlertHazard by groundAlertTriage;
        satisfy Hazards::DecisionRecordStoreLossHazard by groundDecisionRecordStore;
        satisfy Hazards::MeshRadioSaturationHazard by fleet;
        // ===== hazards stated above, satisfied here by the components =====
        satisfy SurveillanceDroneSwarm::SA::Hazards::PositionDriftHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MeshJammingHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MisclassificationHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::SensingDegradedUnnoticedHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::SensingDegradedUnnoticedHazard by groundStation;
        satisfy SurveillanceDroneSwarm::SA::Hazards::StaleTrackHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::SpoofedMemberHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::MixedClassifierVersionsHazard by fleet;
        satisfy SurveillanceDroneSwarm::SA::Hazards::OperatorOverloadHazard by groundAlertTriage;
        satisfy SurveillanceDroneSwarm::LA::Hazards::CoordinationConcentrationHazard by fleet;
        satisfy SurveillanceDroneSwarm::LA::Hazards::SectorHandOffLostHazard by fleet;
        satisfy SurveillanceDroneSwarm::LA::Hazards::RelayedReportDroppedHazard by fleet;
        satisfy SurveillanceDroneSwarm::LA::Hazards::TrackHandOverGapHazard by fleet;
        satisfy SurveillanceDroneSwarm::LA::Hazards::SplitCoordinationHazard by fleet;
        satisfy SurveillanceDroneSwarm::LA::Hazards::LostHandoffHazard by fleet;
        satisfy SurveillanceDroneSwarm::LA::Hazards::GroundStationSinglePointHazard by groundRecallTransmitter;
        satisfy SurveillanceDroneSwarm::LA::Hazards::GroundStationSinglePointHazard by fleet;
        satisfy SurveillanceDroneSwarm::LA::Hazards::TriageUnitSinglePointHazard by groundDecisionRecordStore;
        #prose part paTradeOff {
        doc /* Architecture trade-off for PA. Alternative 2 was taken.
                 alternative 1: total 0.53 (measures 0.25, review 0.47, structure 0.93, resilience 0.25)
                 alternative 2: total 0.76 (measures 0.33, review 0.75, structure 0.86, resilience 1.00)
                 The measures term scores the worst case of each alternative's own #Estimate: claims its architecture states with their basis, not measurements.
                 The decision is where the deciding authority sits, and the two alternatives answer it cleanly enough to be compared on consequences rather than style.

        Alternative 1 concentrates hand-over, rotation, redistribution, deconfliction, admission and track correlation in `GroundSwarmCoordinator` and `GroundTrackFusion`, both nested in one `groundCoordinator : GroundCoordinationNode`. Its behaviour decomposition on the member is actually the finer of the two — `DetectorClassifier`, `HeldReportStore`, `NeighbourRelayAgent`, `TrackHandoverAgent`, `MemberHealthReporter`, `DirectiveHandler`, `FlightSafetyMonitor`, `BatteryEnduranceMonitor` are each one job — and separating `groundTriage` from `groundRecordStore`, with `reportsToRecords` taking reports straight off the fleet, is the right call for provenance in both alternatives. The problem is what the boundary then has to carry. Every coordination decision crosses `GroundLinkMedium` twice (`coordinationUplink` up, `assignmentDownlink` down) on a link the model itself types as intermittent, and the ports that carry it (`SwarmMember::coordOut/coordIn`) are typed `Common::MeshPort` — mesh semantics pushed over the ground radio. `GroundCoordinatorModes.FleetUnreachable` states the consequence in the model's own words: the drones act on their last assignment and coverage decays as endurance runs out. Rotation stops, so a drone due to recharge either abandons a sector or overstays; `correlateTracks` stops, so the operator loses the fused picture at `groundStation.trackPictureIn` even though the ground segment is intact. `reportHoldWhileCutOffMinutes` = 40 min is met, but it only says the data survives — the coordination does not.

        The estimate that should be discounted is Alternative 1's `coverageLossAfterMemberLossFraction` = 0.153, with the basis "the loss precedes the ground coordinator's redistribution, so it is the same as for a member-centred split". True for the instant, but the measure exists to separate ground-coordinated from member-coordinated restoration, and the basis measures only the moment before restoration. `Hazards::CoordinatorHostFailureHazard` says redistribution stops entirely when `GroundCoordinationNode` fails, so in that state the 0.153 is never re-spread at all. Worse, it is discharged by `satisfy Hazards::CoordinatorHostFailureHazard by fleet` — and `SwarmMember`'s own doc says the deciding coordination "is done for it by the ground coordinator". The fleet hosts no coordination behaviour part; the mitigation is nominal, and the same applies to `satisfy LA::Hazards::GroundStationSinglePointHazard by fleet`. `satisfy Hazards::AssignmentLatencyHazard by groundCoordinator` has the coordinator mitigating its own round-trip latency, and `groundLinkTransceiver`, whose `LinkGatewayManager` is supposed to manage that link and is the hazard's subject, appears in no connection at all — the fleet ports wire straight to the ground nodes. `handOverLossShareUnderJamming` = 0.15 is flagged by its own author as an assumption whose premise (jamming hits the mesh but not the ground link) the same doc then contradicts; for an architecture that routes all coordination over the ground link, that is the assumption that matters most.

        Alternative 2 keeps the ground boundary thin: `taskingFeed`, `priorityFeed`, `statusFeed`, `reportsFeed`, `receiptFeed` and nothing that decides. Losing `groundStation : GroundStationNode` costs tasking, priorities, status picture and acknowledgements — not the watch, not deconfliction, not redistribution, and not recall, because `recallAndLand` is allocated to a separate `groundRecallTransmitter : GroundRecallTransmitterNode` with its own operator panel on its own `RecallRadioMedium`. Alternative 1's `DirectRecallIssuer` bypasses the coordinator but is a behaviour part inside `groundStation` riding `recallDownlink : GroundLinkMedium`, so it dies with either the station or the link. On the rules: Alternative 2's `SafetyMonitorNode` is an independent microcontroller with its own supply, watchdog and dedicated recall receiver, holds the member state machine, and its transitions are triggered (`recallWhileWatching ... accept recallW : Common::RecallDirective`), so `RecallWins` and `GeofenceBreachEndsWatch` are enforced by a component that neither classifies nor decides. Alternative 1's `FlightSafetyMonitor` is correctly kept off the mission computer, but recall reaches it through `DirectiveHandler`, which is hosted on `MissionComputerNode` alongside `DetectorClassifier` — the rule-enforcement chain runs through the classifier's host — and its state machines carry the same property patterns over untriggered transitions, which makes them harder to hold a supplier to.

        Alternative 2 is not free of criticism. `SwarmCoordinationSoftware` is one part doing all eight coordination functions on the hardest host to update, and `ReportHoldSoftware` bundles delivery, status and track picture. `MeshRadioSaturationHazard` is real and honestly declared: the "dedicated coordination priority class" is a claim in a doc, not a modelled separation. Its `alertsReachingOperatorPerHour` = 20 meets the target by construction — `alertCapPerHour` is the cap — and `AlertCapHidesAlertHazard` admits the risk simply moves into latency; Alternative 1's 21/h rests on a more genuine mechanism (one fused track per object before ranking) that does not pay off enough. Its 350 USD overcounts `onboardClassificationCostUsdPerMember` by including the report-store flash and identity element, which are not classification; Alternative 1's 320 USD is un-itemised, so neither figure is trustworthy and both fail. Alternative 1's real advantage is procurement and change: a coordination server is one item on commodity hardware, testable on the ground, and changing the coordination algorithm touches one box rather than twelve airframes under a classifier-version admission check.

        That advantage does not survive the two resilience questions this comparison exists to answer. I would take Alternative 2. */
        }
    }
    package EPBS {
      doc /* End-product breakdown: one configuration item per thing procured, built or delivered for the SurveillanceDroneSwarm. Each item realises a physical part of the layer above, carries its contract as a requirement definition and is verified by a verification definition. Counts are multiplicities on the usages, never on the definitions. */

      // ---------------------------------------------------------------
      // Hardware and commercial-off-the-shelf configuration items
      // ---------------------------------------------------------------

      #CI_HWCI part def DroneAirframe {
        doc /* The drone itself: airframe, propulsion and flight controller. One item type, twelve fielded. Endurance and cruise speed are the brief's fixed numbers; transit to and from the recharge point is spent out of the same endurance. */
        attribute enduranceMinutes : Real = 40;
        attribute cruiseSpeedMetresPerSecond : Real = 18;
        attribute startStateOfChargeFraction : Real = 1.0;
      }

      #CI_COTS part def SensorPayload {
        doc /* The camera payload on each drone, bought as a commercial item. It sets the instantaneous footprint under watch and is the part most exposed to going out of production. */
        attribute footprintSquareKilometres : Real = 3.0;
        attribute qualifiedSourceCount : Real = 2;
        attribute interfaceStandardised : Boolean = true;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      #CI_COTS part def OnboardComputeModule {
        doc /* The commercial computing module on each drone that runs classification, navigation against stored maps and the report store. Its unit cost decides how much classification sits on the drone rather than on the ground. */
        attribute unitCostUsd : Real;
        attribute reportStorageHoldMinutes : Real = 30;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      #CI_COTS part def BatteryPack {
        doc /* The swappable battery pack. Packs are swapped at the recharge point, not charged in the drone, in about twenty minutes of turnaround, so the pack supply is what keeps sectors filled while drones rotate. */
        attribute packEnduranceMinutes : Real = 40;
        attribute swapTurnaroundMinutes : Real = 20;
        attribute qualifiedSourceCount : Real = 2;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      #CI_COTS part def MeshRadioModule {
        doc /* The radio on each drone that carries coordination traffic between drones over the mesh, independent of the link to the operations centre, and that holds the per-drone credential used at admission. */
        attribute authenticatesPeers : Boolean = true;
        attribute independentOfGroundLink : Boolean = true;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      #CI_HWCI part def GroundStationEquipment {
        doc /* The ground station hardware from which the swarm is tasked and watched and, in the ground-centred architecture, coordinated. One is fielded. */
        attribute supervisedMembers : Real = 12;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      #CI_COTS part def GroundLinkRadio {
        doc /* The commercial radio that forms the intermittent link between the ground station and the operations centre, carrying tasking, command, reports, status and acknowledgements. */
        attribute carriesAcknowledgements : Boolean = true;
        attribute toleratesGaps : Boolean = true;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      // ---------------------------------------------------------------
      // Software configuration items
      // ---------------------------------------------------------------

      #CI_CSCI part def DroneFlightSoftware {
        doc /* Flight and navigation software on each drone: stays inside the cleared airspace, lands on recall, on breach of clearance or above moderate wind, returns to the recovery point when isolated, and navigates by camera against stored maps when satellite positioning is out. */
        attribute satelliteOutageMinutes : Real = 10;
        attribute positionErrorMetres : Real;
        attribute landsWhenRecalledOrOutsideClearance : Boolean = true;
        attribute returnsToRecoveryPointWhenIsolated : Boolean = true;
        attribute signedBaseline : Boolean = true;
      }

      #CI_CSCI part def DetectionClassifierSoftware {
        doc /* The on-board detection and classification software. It says Unknown rather than forcing a class below the reporting threshold and stamps every report with its own classifier version. */
        attribute missedDetectionFraction : Real;
        attribute falseAlarmsPerHour : Real;
        attribute reportsUnknownBelowThreshold : Boolean = true;
        attribute stampsClassifierVersion : Boolean = true;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      #CI_CSCI part def ReportStoreForwardSoftware {
        doc /* On-board software that holds each detection report while the drone is cut off, forwards it when a path exists and keeps it until the operations centre acknowledges it, so none is lost in a link gap. */
        attribute holdWhileCutOffMinutes : Real = 30;
        attribute reportsLost : Real = 0;
        attribute retainsUntilAcknowledged : Boolean = true;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      #CI_CSCI #Variant part def MemberCoordinationSoftware {
        doc /* Variant for the member-centred architecture: the coordination software each drone runs to settle sector handover, recharge rotation, coverage redistribution, deconfliction, link relay, track correlation, track handover and member admission over the mesh. */
        attribute areaUnderWatchFraction : Real;
        attribute coverageLossAfterMemberLossFraction : Real;
        attribute coverageUnderMeshJammingFraction : Real;
        attribute meshLinksJammedFraction : Real = 0.5;
        attribute admitsOnlyAuthenticated : Boolean = true;
      }

      #CI_CSCI #Variant part def GroundCoordinationSoftware {
        doc /* Variant for the ground-centred architecture: the coordination software that runs on the ground station and settles the same coordination functions for the drones. It is the alternative to member coordination, not an addition to it. */
        attribute areaUnderWatchFraction : Real;
        attribute coverageLossAfterMemberLossFraction : Real;
        attribute coverageUnderMeshJammingFraction : Real;
        attribute meshLinksJammedFraction : Real = 0.5;
        attribute admitsOnlyAuthenticated : Boolean = true;
      }

      #CI_CSCI part def AlertTriageSoftware {
        doc /* Ground software that ranks reports so that what is most likely to matter reaches the operator first and merges duplicates, keeping the alert rate inside what one operator can judge. */
        attribute alertsReachingOperatorPerHour : Real;
        attribute operatorSecondsPerAlert : Real = 30;
        attribute mergesDuplicates : Boolean = true;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      #CI_CSCI part def DecisionRecordSoftware {
        doc /* Ground software that keeps, for every report, the frames it came from, the classifier version, the reporting threshold in force and who acknowledged it. */
        attribute recordsFrames : Boolean = true;
        attribute recordsClassifierVersion : Boolean = true;
        attribute recordsThreshold : Boolean = true;
        attribute recordsAcknowledger : Boolean = true;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      #CI_CSCI part def OperatorConsoleSoftware {
        doc /* Ground software through which one operator tasks, commands, recalls and watches the swarm and acknowledges each report. It presents the swarm tracks in a form that can be merged with the fixed camera network's tracks and marks a track stale after the stated time. */
        attribute trackStaleAfterSeconds : Real = 120;
        attribute offersTaskCommandRecall : Boolean = true;
        attribute presentsStatusPicture : Boolean = true;
        attribute acknowledgesEachReport : Boolean = true;
        attribute tracksMergeableWithFixedNetwork : Boolean = true;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      #CI_CSCI part def FleetLoaderSoftware {
        doc /* Ground software that loads one signed software baseline, classifier included, onto every drone and verifies what each drone runs before it flies, so no version drifts across the fleet. */
        attribute distinctBaselinesInFleet : Real = 1;
        attribute verifiesBeforeFlight : Boolean = true;
        attribute withinOperatingEnvelope : Boolean = true;
      }

      // ---------------------------------------------------------------
      // Fielded usages: the cardinality is the multiplicity
      // ---------------------------------------------------------------

      part droneAirframes : DroneAirframe [12] {
        doc /* The twelve fielded drone airframes; the fleet size is fixed by the brief. */
      }
      part sensorPayloads : SensorPayload [12] {
        doc /* One camera payload per drone. */
      }
      part computeModules : OnboardComputeModule [12] {
        doc /* One on-board computing module per drone. */
      }
      part batteryPacks : BatteryPack [24] {
        doc /* Battery packs in circulation: one set in the drones and one set at the recharge point, so a swap never waits for a pack. The count is a sizing assumption held for the acquirer to confirm. */
      }
      part meshRadios : MeshRadioModule [12] {
        doc /* One mesh radio per drone. */
      }
      part groundStationEquipment : GroundStationEquipment [1] {
        doc /* The single ground station. */
      }
      part groundLinkRadio : GroundLinkRadio [1] {
        doc /* The single radio to the operations centre. */
      }
      part flightSoftware : DroneFlightSoftware [12] {
        doc /* Flight software installed on each drone. */
      }
      part classifierSoftware : DetectionClassifierSoftware [12] {
        doc /* The same classifier baseline installed on each drone. */
      }
      part storeForwardSoftware : ReportStoreForwardSoftware [12] {
        doc /* Report store-and-forward installed on each drone. */
      }
      #Variant part memberCoordination : MemberCoordinationSoftware [12] {
        doc /* Member-centred variant: coordination software installed on each drone. */
      }
      #Variant part groundCoordination : GroundCoordinationSoftware [1] {
        doc /* Ground-centred variant: coordination software installed on the ground station. */
      }
      part alertTriage : AlertTriageSoftware [1] {
        doc /* Alert triage on the ground station. */
      }
      part decisionRecords : DecisionRecordSoftware [1] {
        doc /* Decision record keeping on the ground station. */
      }
      part operatorConsole : OperatorConsoleSoftware [1] {
        doc /* The operator console software on the ground station. */
      }
      part fleetLoader : FleetLoaderSoftware [1] {
        doc /* The fleet baseline loader on the ground station. */
      }

      // ---------------------------------------------------------------
      // Realisation: each configuration item traces to the part it realises
      // ---------------------------------------------------------------

      trace DroneAirframe to SurveillanceDroneSwarm::PA::SwarmMember;
      trace SensorPayload to SurveillanceDroneSwarm::PA::SwarmMember;
      trace OnboardComputeModule to SurveillanceDroneSwarm::PA::SwarmMember;
      trace BatteryPack to SurveillanceDroneSwarm::PA::SwarmMember;
      trace MeshRadioModule to SurveillanceDroneSwarm::PA::SwarmMember;
      trace DroneFlightSoftware to SurveillanceDroneSwarm::PA::SwarmMember;
      trace DetectionClassifierSoftware to SurveillanceDroneSwarm::PA::SwarmMember;
      trace ReportStoreForwardSoftware to SurveillanceDroneSwarm::PA::SwarmMember;
      trace MemberCoordinationSoftware to SurveillanceDroneSwarm::PA::SwarmMember;
      trace GroundStationEquipment to SurveillanceDroneSwarm::PA::GroundStationNode;
      trace GroundLinkRadio to SurveillanceDroneSwarm::PA::GroundStationNode;
      trace GroundCoordinationSoftware to SurveillanceDroneSwarm::PA::GroundStationNode;
      trace AlertTriageSoftware to SurveillanceDroneSwarm::PA::GroundStationNode;
      trace DecisionRecordSoftware to SurveillanceDroneSwarm::PA::GroundStationNode;
      trace OperatorConsoleSoftware to SurveillanceDroneSwarm::PA::GroundStationNode;
      trace FleetLoaderSoftware to SurveillanceDroneSwarm::PA::GroundStationNode;

      // Realisation of the PA usages: the fleet and its two representatives are
      // built from the drone airframe and the mesh radio; the ground-side usages
      // are realised by the ground station hardware and the software that runs on it.
      trace DroneAirframe to SurveillanceDroneSwarm::PA::fleet;
      trace DroneAirframe to SurveillanceDroneSwarm::PA::memberA;
      trace DroneAirframe to SurveillanceDroneSwarm::PA::memberB;
      trace MeshRadioModule to SurveillanceDroneSwarm::PA::memberA;
      trace MeshRadioModule to SurveillanceDroneSwarm::PA::memberB;
      trace GroundStationEquipment to SurveillanceDroneSwarm::PA::groundRecallTransmitter;
      trace OperatorConsoleSoftware to SurveillanceDroneSwarm::PA::groundRecallTransmitter;
      trace AlertTriageSoftware to SurveillanceDroneSwarm::PA::groundAlertTriage;
      trace DecisionRecordSoftware to SurveillanceDroneSwarm::PA::groundDecisionRecordStore;
      trace DroneAirframe to SurveillanceDroneSwarm::PA::mainAssembly;
      trace GroundStationEquipment to SurveillanceDroneSwarm::PA::mainAssembly;

      // ---------------------------------------------------------------
      // Contracts: one requirement definition per configuration item
      // ---------------------------------------------------------------

      requirement def DroneAirframeContract {
        subject airframe : DroneAirframe;
        attribute id = "EPBS-CI-01";
        doc /* Starting from a freshly swapped pack, the airframe flies about 40 minutes at about 18 m/s cruise; transit to and from the recharge point is spent from that endurance. */
        assume constraint { airframe.startStateOfChargeFraction >= 1.0 }
        require constraint { airframe.enduranceMinutes >= 40 and airframe.cruiseSpeedMetresPerSecond >= 18 }
      }

      requirement def SensorPayloadContract {
        subject payload : SensorPayload;
        attribute id = "EPBS-CI-02";
        doc /* The payload keeps about 3.0 km2 under watch at once, has a standardised interface and has at least two qualified sources, so a discontinued model can be replaced without redesign. */
        assume constraint { payload.withinOperatingEnvelope == true }
        require constraint { payload.footprintSquareKilometres >= 3.0 and payload.qualifiedSourceCount >= 2 and payload.interfaceStandardised == true }
      }

      requirement def OnboardComputeModuleContract {
        subject compute : OnboardComputeModule;
        attribute id = "EPBS-CI-03";
        doc /* On-board classification computing costs no more than 300 USD per drone (a placeholder awaiting the customer's number) and its storage holds reports for at least 30 minutes while cut off. */
        assume constraint { compute.withinOperatingEnvelope == true }
        require constraint { compute.unitCostUsd <= 300 and compute.reportStorageHoldMinutes >= 30 }
      }

      requirement def BatteryPackContract {
        subject pack : BatteryPack;
        attribute id = "EPBS-CI-04";
        doc /* A pack gives at least 40 minutes of flight, is swapped in no more than 20 minutes, and is available from at least two qualified sources so that one supplier stopping does not stop the rotation. */
        assume constraint { pack.withinOperatingEnvelope == true }
        require constraint { pack.packEnduranceMinutes >= 40 and pack.swapTurnaroundMinutes <= 20 and pack.qualifiedSourceCount >= 2 }
      }

      requirement def MeshRadioModuleContract {
        subject radio : MeshRadioModule;
        attribute id = "EPBS-CI-05";
        doc /* The mesh radio works without the link to the operations centre and admits only peers that present a valid credential. */
        assume constraint { radio.withinOperatingEnvelope == true }
        require constraint { radio.independentOfGroundLink == true and radio.authenticatesPeers == true }
      }

      requirement def GroundStationEquipmentContract {
        subject station : GroundStationEquipment;
        attribute id = "EPBS-CI-06";
        doc /* The ground station supervises all twelve drones at once. */
        assume constraint { station.withinOperatingEnvelope == true }
        require constraint { station.supervisedMembers >= 12 }
      }

      requirement def GroundLinkRadioContract {
        subject linkRadio : GroundLinkRadio;
        attribute id = "EPBS-CI-07";
        doc /* The ground link carries acknowledgements and tolerates gaps in availability without losing what it carries. */
        assume constraint { linkRadio.withinOperatingEnvelope == true }
        require constraint { linkRadio.carriesAcknowledgements == true and linkRadio.toleratesGaps == true }
      }

      requirement def DroneFlightSoftwareContract {
        subject software : DroneFlightSoftware;
        attribute id = "EPBS-CI-08";
        doc /* After ten minutes without satellite positioning the position error is at most 50 m (a placeholder awaiting the customer's number); the drone lands on recall or outside clearance and returns to the recovery point when isolated; it runs a signed baseline. */
        assume constraint { software.satelliteOutageMinutes <= 10 }
        require constraint { software.positionErrorMetres <= 50 and software.landsWhenRecalledOrOutsideClearance == true and software.returnsToRecoveryPointWhenIsolated == true and software.signedBaseline == true }
      }

      requirement def DetectionClassifierSoftwareContract {
        subject detector : DetectionClassifierSoftware;
        attribute id = "EPBS-CI-09";
        doc /* Missed detections stay at or below 0.10 of real objects and false alarms at or below 2 per hour (placeholders awaiting the customer's numbers); below the reporting threshold the class is Unknown; every report carries the classifier version. */
        assume constraint { detector.withinOperatingEnvelope == true }
        require constraint { detector.missedDetectionFraction <= 0.1 and detector.falseAlarmsPerHour <= 2 and detector.reportsUnknownBelowThreshold == true and detector.stampsClassifierVersion == true }
      }

      requirement def ReportStoreForwardSoftwareContract {
        subject store : ReportStoreForwardSoftware;
        attribute id = "EPBS-CI-10";
        doc /* A drone that is cut off holds its reports for at least 30 minutes (a placeholder awaiting the customer's number) without losing any, and keeps each until it is acknowledged. */
        assume constraint { store.withinOperatingEnvelope == true }
        require constraint { store.holdWhileCutOffMinutes >= 30 and store.reportsLost <= 0 and store.retainsUntilAcknowledged == true }
      }

      requirement def MemberCoordinationSoftwareContract {
        subject coordination : MemberCoordinationSoftware;
        attribute id = "EPBS-CI-11";
        doc /* With drones coordinating among themselves, at least 0.9 of the area stays under watch, one lost drone costs at most 0.25 of coverage before re-spreading, and with half the links jammed at least 0.75 stays under watch (a placeholder). Only authenticated drones are admitted. */
        assume constraint { coordination.meshLinksJammedFraction <= 0.5 }
        require constraint { coordination.areaUnderWatchFraction >= 0.9 and coordination.coverageLossAfterMemberLossFraction <= 0.25 and coordination.coverageUnderMeshJammingFraction >= 0.75 and coordination.admitsOnlyAuthenticated == true }
      }

      requirement def GroundCoordinationSoftwareContract {
        subject coordination : GroundCoordinationSoftware;
        attribute id = "EPBS-CI-12";
        doc /* With the ground station coordinating, the same coverage figures hold: at least 0.9 of the area under watch, at most 0.25 lost with one drone, at least 0.75 kept with half the links jammed (a placeholder). Only authenticated drones are admitted. */
        assume constraint { coordination.meshLinksJammedFraction <= 0.5 }
        require constraint { coordination.areaUnderWatchFraction >= 0.9 and coordination.coverageLossAfterMemberLossFraction <= 0.25 and coordination.coverageUnderMeshJammingFraction >= 0.75 and coordination.admitsOnlyAuthenticated == true }
      }

      requirement def AlertTriageSoftwareContract {
        subject triage : AlertTriageSoftware;
        attribute id = "EPBS-CI-13";
        doc /* No more than 20 alerts an hour reach the operator (a placeholder awaiting the customer's number), which at 30 seconds an alert stays inside what one operator can judge; duplicates are merged. */
        assume constraint { triage.withinOperatingEnvelope == true }
        require constraint { triage.alertsReachingOperatorPerHour <= 20 and triage.alertsReachingOperatorPerHour * triage.operatorSecondsPerAlert <= 3600 and triage.mergesDuplicates == true }
      }

      requirement def DecisionRecordSoftwareContract {
        subject records : DecisionRecordSoftware;
        attribute id = "EPBS-CI-14";
        doc /* For every report the record holds the frames it came from, the classifier version, the reporting threshold in force and who acknowledged it. */
        assume constraint { records.withinOperatingEnvelope == true }
        require constraint { records.recordsFrames == true and records.recordsClassifierVersion == true and records.recordsThreshold == true and records.recordsAcknowledger == true }
      }

      requirement def OperatorConsoleSoftwareContract {
        subject console : OperatorConsoleSoftware;
        attribute id = "EPBS-CI-15";
        doc /* One operator can task, command, recall and watch the whole swarm and acknowledge each report; tracks go stale after 120 seconds unseen (a placeholder) and are mergeable with the fixed camera network's tracks. */
        assume constraint { console.withinOperatingEnvelope == true }
        require constraint { console.trackStaleAfterSeconds <= 120 and console.offersTaskCommandRecall == true and console.presentsStatusPicture == true and console.acknowledgesEachReport == true and console.tracksMergeableWithFixedNetwork == true }
      }

      requirement def FleetLoaderSoftwareContract {
        subject loader : FleetLoaderSoftware;
        attribute id = "EPBS-CI-16";
        doc /* The whole fleet runs one baseline, and each drone's baseline is verified before it flies. */
        assume constraint { loader.withinOperatingEnvelope == true }
        require constraint { loader.distinctBaselinesInFleet <= 1 and loader.verifiesBeforeFlight == true }
      }

      // ---------------------------------------------------------------
      // Verification: one case per contract
      // ---------------------------------------------------------------

      verification def VerifyDroneAirframe {
        doc /* Flight test of endurance and cruise speed from a freshly swapped pack. */
        subject airframe : DroneAirframe;
        objective { verify DroneAirframeContract; }
      }
      verification def VerifySensorPayload {
        doc /* Measurement of footprint under watch and audit of the interface specification and sources. */
        subject payload : SensorPayload;
        objective { verify SensorPayloadContract; }
      }
      verification def VerifyOnboardComputeModule {
        doc /* Cost check and a storage hold test at the report rate. */
        subject compute : OnboardComputeModule;
        objective { verify OnboardComputeModuleContract; }
      }
      verification def VerifyBatteryPack {
        doc /* Discharge test for endurance, timed swap at the recharge point and audit of sources. */
        subject pack : BatteryPack;
        objective { verify BatteryPackContract; }
      }
      verification def VerifyMeshRadioModule {
        doc /* Mesh test with the ground link off and admission test with a valid and an invalid credential. */
        subject radio : MeshRadioModule;
        objective { verify MeshRadioModuleContract; }
      }
      verification def VerifyGroundStationEquipment {
        doc /* Demonstration of supervising twelve drones at once. */
        subject station : GroundStationEquipment;
        objective { verify GroundStationEquipmentContract; }
      }
      verification def VerifyGroundLinkRadio {
        doc /* Link test with gaps: acknowledgements survive and nothing carried is lost. */
        subject linkRadio : GroundLinkRadio;
        objective { verify GroundLinkRadioContract; }
      }
      verification def VerifyDroneFlightSoftware {
        doc /* Flight test with satellite positioning withheld for ten minutes, recall, clearance breach and isolation. */
        subject software : DroneFlightSoftware;
        objective { verify DroneFlightSoftwareContract; }
      }
      verification def VerifyDetectionClassifierSoftware {
        doc /* Scored run on recorded and live scenes, including misleading paint and shapes, for missed detections, false alarms and Unknown below threshold. */
        subject detector : DetectionClassifierSoftware;
        objective { verify DetectionClassifierSoftwareContract; }
      }
      verification def VerifyReportStoreForwardSoftware {
        doc /* Cut-off test of 30 minutes then reconciliation against the operations centre's acknowledgements. */
        subject store : ReportStoreForwardSoftware;
        objective { verify ReportStoreForwardSoftwareContract; }
      }
      verification def VerifyMemberCoordinationSoftware {
        doc /* Swarm simulation and field trial: member rotation, one member lost, half the mesh links jammed. */
        subject coordination : MemberCoordinationSoftware;
        objective { verify MemberCoordinationSoftwareContract; }
      }
      verification def VerifyGroundCoordinationSoftware {
        doc /* The same swarm simulation and field trial with coordination on the ground station. */
        subject coordination : GroundCoordinationSoftware;
        objective { verify GroundCoordinationSoftwareContract; }
      }
      verification def VerifyAlertTriageSoftware {
        doc /* Replay of a recorded alert stream measuring alerts reaching the operator per hour and duplicate merging. */
        subject triage : AlertTriageSoftware;
        objective { verify AlertTriageSoftwareContract; }
      }
      verification def VerifyDecisionRecordSoftware {
        doc /* Inspection of the record of a sample of reports for all four items. */
        subject records : DecisionRecordSoftware;
        objective { verify DecisionRecordSoftwareContract; }
      }
      verification def VerifyOperatorConsoleSoftware {
        doc /* Operator demonstration of task, command, recall, acknowledgement and stale marking, and a merge with fixed-network tracks. */
        subject console : OperatorConsoleSoftware;
        objective { verify OperatorConsoleSoftwareContract; }
      }
      verification def VerifyFleetLoaderSoftware {
        doc /* Load to all twelve drones and check that the baseline each reports is the same. */
        subject loader : FleetLoaderSoftware;
        objective { verify FleetLoaderSoftwareContract; }
      }

      // ---------------------------------------------------------------
      // Satisfaction of the contracts by the fielded items
      // ---------------------------------------------------------------

      satisfy DroneAirframeContract by droneAirframes;
      satisfy SensorPayloadContract by sensorPayloads;
      satisfy OnboardComputeModuleContract by computeModules;
      satisfy BatteryPackContract by batteryPacks;
      satisfy MeshRadioModuleContract by meshRadios;
      satisfy GroundStationEquipmentContract by groundStationEquipment;
      satisfy GroundLinkRadioContract by groundLinkRadio;
      satisfy DroneFlightSoftwareContract by flightSoftware;
      satisfy DetectionClassifierSoftwareContract by classifierSoftware;
      satisfy ReportStoreForwardSoftwareContract by storeForwardSoftware;
      satisfy MemberCoordinationSoftwareContract by memberCoordination;
      satisfy GroundCoordinationSoftwareContract by groundCoordination;
      satisfy AlertTriageSoftwareContract by alertTriage;
      satisfy DecisionRecordSoftwareContract by decisionRecords;
      satisfy OperatorConsoleSoftwareContract by operatorConsole;
      satisfy FleetLoaderSoftwareContract by fleetLoader;

      // ---------------------------------------------------------------
      // Hazards this layer adds, and their mitigation
      // ---------------------------------------------------------------

      package Hazards {
        doc /* Hazards introduced by what is procured: a supplier that stops shipping, a software version that drifts across the fleet, a part that goes out of production. */

        #Hazard requirement BatterySupplierStopsShippingHazard {
          subject pack : BatteryPack;
          doc /* The only source of battery packs stops shipping, swaps at the recharge point stop being possible, drones cannot rotate and the area under watch falls below what is required. */
        }

        #Hazard requirement FleetFlightSoftwareVersionDriftHazard {
          subject software : DroneFlightSoftware;
          doc /* Field updates reach some drones and not others, so the fleet runs different flight and coordination builds that disagree on handover, admission or clearance handling. */
        }

        #Hazard requirement SensorPayloadObsolescenceHazard {
          subject payload : SensorPayload;
          doc /* The camera model goes out of production; a substitute with different optics is fitted to some drones, the footprint shrinks and the classifier meets images it was not validated on. */
        }
      }

      satisfy Hazards::BatterySupplierStopsShippingHazard by batteryPacks;
      satisfy Hazards::FleetFlightSoftwareVersionDriftHazard by fleetLoader;
      satisfy Hazards::SensorPayloadObsolescenceHazard by sensorPayloads;

      // Hazards stated above that a configuration item here also mitigates.
      satisfy SurveillanceDroneSwarm::SA::Hazards::MixedClassifierVersionsHazard by fleetLoader;
      satisfy SurveillanceDroneSwarm::SA::Hazards::SpoofedMemberHazard by meshRadios;
      satisfy SurveillanceDroneSwarm::SA::Hazards::PositionDriftHazard by flightSoftware;
    }
}

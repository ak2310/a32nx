import { Geometry } from '@fmgc/guidance/Geometry';
import { Fmgc } from '@fmgc/guidance/GuidanceController';
import { AltitudeConstraintType, SpeedConstraintType } from '@fmgc/guidance/lnav/legs';
import { FlightPlanManager } from '@fmgc/flightplanning/FlightPlanManager';
import { SegmentType } from '@fmgc/wtsdk';
import { EngineModel } from '../EngineModel';
import { FlapConf } from '../common';
import { VerticalCheckpoint, VerticalCheckpointReason } from './ClimbProfileBuilderResult';
import { Predictions, StepResults } from '../Predictions';
import { Feet, Knots, NauticalMiles } from '../../../../../../typings/types';
import { GeometryProfile } from '../GeometryProfile';
import { AtmosphericConditions } from '../AtmosphericConditions';

export class ClimbPathBuilder {
    private static TONS_TO_POUNDS = 2240;

    private atmosphericConditions: AtmosphericConditions = new AtmosphericConditions();

    private airfieldElevation: Feet;

    private accelerationAltitude: Feet;

    private thrustReductionAltitude: Feet;

    private cruiseAltitude: Feet;

    private climbSpeedLimit: Knots;

    private climbSpeedLimitAltitude: Feet;

    private perfFactor: number;

    constructor(private fmgc: Fmgc, private flightPlanManager: FlightPlanManager) {
        SimVar.SetSimVarValue('L:A32NX_STATUS_PERF_FACTOR', 'Percent', 0);
    }

    update() {
        this.airfieldElevation = SimVar.GetSimVarValue('L:A32NX_DEPARTURE_ELEVATION', 'feet');
        this.accelerationAltitude = SimVar.GetSimVarValue('L:AIRLINER_ACC_ALT', 'number');
        this.thrustReductionAltitude = SimVar.GetSimVarValue('L:AIRLINER_THR_RED_ALT', 'number');
        this.cruiseAltitude = SimVar.GetSimVarValue('L:AIRLINER_CRUISE_ALTITUDE', 'number');
        this.climbSpeedLimit = 250; // TODO: Make dynamic
        this.climbSpeedLimitAltitude = 10000; // TODO: Make dynamic
        this.perfFactor = SimVar.GetSimVarValue('L:A32NX_STATUS_PERF_FACTOR', 'Percent');

        this.atmosphericConditions.update();
    }

    computeClimbPath(geometry: Geometry): GeometryProfile {
        const isOnGround = SimVar.GetSimVarValue('SIM ON GROUND', 'Bool');

        const constraints = this.findMaxAltitudeConstraints(geometry);
        console.log(constraints);

        if (!isOnGround) {
            return this.computeLivePrediction(geometry);
        }

        return this.computePreflightPrediction(geometry);
    }

    computePreflightPrediction(geometry: Geometry): GeometryProfile {
        const checkpoints: VerticalCheckpoint[] = [];

        this.addTakeoffRollCheckpoint(checkpoints, this.fmgc.getFOB() * ClimbPathBuilder.TONS_TO_POUNDS);
        this.addTakeoffStepCheckpoint(checkpoints, this.airfieldElevation, this.thrustReductionAltitude);
        this.addAccelerationAltitudeStep(checkpoints, this.thrustReductionAltitude, this.accelerationAltitude, this.fmgc.getV2Speed() + 10);

        this.addClimbSteps(geometry, checkpoints, this.accelerationAltitude, this.cruiseAltitude);

        return new GeometryProfile(geometry, checkpoints);
    }

    /**
     * Compute climb profile assuming climb thrust until top of climb. This does not care if we're below acceleration/thrust reduction altitude.
     * @param geometry
     * @returns
     */
    computeLivePrediction(geometry: Geometry): GeometryProfile {
        const checkpoints: VerticalCheckpoint[] = [];

        const currentAltitude = SimVar.GetSimVarValue('INDICATED ALTITUDE', 'feet');

        this.addPresentPositionCheckpoint(geometry, checkpoints, currentAltitude);
        this.addClimbSteps(geometry, checkpoints, currentAltitude, this.cruiseAltitude);

        return new GeometryProfile(geometry, checkpoints);
    }

    private addPresentPositionCheckpoint(geometry: Geometry, checkpoints: VerticalCheckpoint[], altitude: Feet) {
        checkpoints.push({
            reason: VerticalCheckpointReason.PresentPosition,
            distanceFromStart: this.computeDistanceFromOriginToPresentPosition(geometry),
            altitude,
            remainingFuelOnBoard: this.fmgc.getFOB() * ClimbPathBuilder.TONS_TO_POUNDS,
            speed: SimVar.GetSimVarValue('AIRSPEED INDICATED', 'knots'),
        });
    }

    private addTakeoffStepCheckpoint(checkpoints: VerticalCheckpoint[], groundAltitude: Feet, thrustReductionAltitude: Feet) {
        const midwayAltitudeSrs = (thrustReductionAltitude + groundAltitude) / 2;
        const predictedN1 = SimVar.GetSimVarValue('L:A32NX_AUTOTHRUST_THRUST_LIMIT_TOGA', 'Percent');
        const flapsSetting: FlapConf = SimVar.GetSimVarValue('L:A32NX_TO_CONFIG_FLAPS', 'Enum');
        const speed = this.fmgc.getV2Speed() + 10;
        const machSrs = this.atmosphericConditions.computeMachFromCas(midwayAltitudeSrs, speed);
        const remainingFuelOnBoard = checkpoints[checkpoints.length - 1].remainingFuelOnBoard;

        const { fuelBurned, distanceTraveled } = Predictions.altitudeStep(
            groundAltitude,
            thrustReductionAltitude - groundAltitude,
            speed,
            machSrs,
            predictedN1,
            this.fmgc.getZeroFuelWeight() * ClimbPathBuilder.TONS_TO_POUNDS,
            remainingFuelOnBoard,
            0,
            this.atmosphericConditions.isaDeviation,
            this.fmgc.getTropoPause(),
            false,
            flapsSetting,
            this.perfFactor,
        );

        checkpoints.push({
            reason: VerticalCheckpointReason.ThrustReductionAltitude,
            distanceFromStart: checkpoints[checkpoints.length - 1].distanceFromStart + distanceTraveled,
            altitude: this.thrustReductionAltitude,
            remainingFuelOnBoard: remainingFuelOnBoard - fuelBurned,
            speed,
        });
    }

    private addAccelerationAltitudeStep(checkpoints: VerticalCheckpoint[], startingAltitude: Feet, targetAltitude: Feet, speed: Knots) {
        const remainingFuelOnBoard = checkpoints[checkpoints.length - 1].remainingFuelOnBoard;
        const { fuelBurned, distanceTraveled } = this.computeClimbSegmentPrediction(startingAltitude, targetAltitude, speed, remainingFuelOnBoard);

        checkpoints.push({
            reason: VerticalCheckpointReason.AccelerationAltitude,
            distanceFromStart: checkpoints[checkpoints.length - 1].distanceFromStart + distanceTraveled,
            altitude: this.accelerationAltitude,
            remainingFuelOnBoard: remainingFuelOnBoard - fuelBurned,
            speed,
        });
    }

    private addClimbSteps(geometry: Geometry, checkpoints: VerticalCheckpoint[], startingAltitude: Feet, finalAltitude: Feet) {
        const constraints = this.findMaxAltitudeConstraints(geometry);

        for (const constraint of constraints) {
            const { maxAltitude: constraintAltitude, distanceFromStart: constraintDistanceFromStart } = constraint;

            this.buildIteratedClimbSegment(geometry, checkpoints, checkpoints[checkpoints.length - 1].altitude, constraintAltitude);

            if (checkpoints[checkpoints.length - 1].distanceFromStart < constraintDistanceFromStart) {
                checkpoints[checkpoints.length - 1].reason = VerticalCheckpointReason.LevelOffForConstraint;

                const altitude = checkpoints[checkpoints.length - 1].altitude;
                const climbSpeed = Math.min(
                    altitude > this.climbSpeedLimitAltitude ? this.fmgc.getManagedClimbSpeed() : this.climbSpeedLimit,
                    this.findMaxSpeedAtDistanceAlongTrack(geometry, constraintDistanceFromStart),
                );

                const { fuelBurned } = this.computeLevelFlightSegmentPrediction(
                    geometry,
                    constraintDistanceFromStart - checkpoints[checkpoints.length - 1].distanceFromStart,
                    altitude,
                    climbSpeed,
                    checkpoints[checkpoints.length - 1].remainingFuelOnBoard,
                );

                checkpoints.push({
                    reason: VerticalCheckpointReason.ContinueClimb,
                    distanceFromStart: constraintDistanceFromStart,
                    altitude: checkpoints[checkpoints.length - 1].altitude,
                    remainingFuelOnBoard: checkpoints[checkpoints.length - 1].remainingFuelOnBoard - fuelBurned,
                    speed: climbSpeed,
                });
            }
        }

        this.buildIteratedClimbSegment(geometry, checkpoints, checkpoints[checkpoints.length - 1].altitude, finalAltitude);
        checkpoints[checkpoints.length - 1].reason = VerticalCheckpointReason.TopOfClimb;
    }

    private buildIteratedClimbSegment(geometry: Geometry, checkpoints: VerticalCheckpoint[], startingAltitude: Feet, targetAltitude: Feet): void {
        for (let altitude = startingAltitude; altitude < targetAltitude; altitude = Math.min(altitude + 1500, targetAltitude)) {
            const distanceAtStartOfStep = checkpoints[checkpoints.length - 1].distanceFromStart;
            const climbSpeed = Math.min(
                altitude > this.climbSpeedLimitAltitude ? this.fmgc.getManagedClimbSpeed() : this.climbSpeedLimit,
                this.findMaxSpeedAtDistanceAlongTrack(geometry, distanceAtStartOfStep),
            );

            const targetAltitudeForSegment = Math.min(altitude + 1500, targetAltitude);
            const remainingFuelOnBoard = checkpoints[checkpoints.length - 1].remainingFuelOnBoard;

            const { distanceTraveled, fuelBurned } = this.computeClimbSegmentPrediction(altitude, targetAltitudeForSegment, climbSpeed, remainingFuelOnBoard);

            checkpoints.push({
                reason: VerticalCheckpointReason.AtmosphericConditions,
                distanceFromStart: distanceAtStartOfStep + distanceTraveled,
                altitude: targetAltitudeForSegment,
                remainingFuelOnBoard: remainingFuelOnBoard - fuelBurned,
                speed: climbSpeed,
            });
        }
    }

    /**
     * Computes predictions for a single segment using the atmospheric conditions in the middle. Use `buildIteratedClimbSegment` for longer climb segments.
     * @param startingAltitude Altitude at the start of climb
     * @param targetAltitude Altitude to terminate the climb
     * @param climbSpeed
     * @param remainingFuelOnBoard Remainging fuel on board at the start of the climb
     * @returns
     */
    private computeClimbSegmentPrediction(startingAltitude: Feet, targetAltitude: Feet, climbSpeed: Knots, remainingFuelOnBoard: number): StepResults & { predictedN1: number } {
        const midwayAltitudeClimb = (startingAltitude + targetAltitude) / 2;
        const machClimb = this.atmosphericConditions.computeMachFromCas(midwayAltitudeClimb, climbSpeed);

        const selectedVs = SimVar.GetSimVarValue('L:A32NX_AUTOPILOT_VS_SELECTED', 'feet per minute');
        if (!SimVar.GetSimVarValue('L:A32NX_FCU_VS_MANAGED', 'Bool') && selectedVs > 0) {
            console.log(`[FMS/VNAV] Predictions running with V/S ${selectedVs} fpm`);

            return Predictions.verticalSpeedStep(
                startingAltitude,
                targetAltitude,
                selectedVs,
                climbSpeed,
                machClimb,
                this.fmgc.getZeroFuelWeight() * ClimbPathBuilder.TONS_TO_POUNDS,
                remainingFuelOnBoard,
                this.atmosphericConditions.isaDeviation,
                this.perfFactor,
            );
        }

        console.log('[FMS/VNAV] Predictions running in managed mode');

        const estimatedTat = this.atmosphericConditions.totalAirTemperatureFromMach(midwayAltitudeClimb, machClimb);
        const predictedN1 = this.getClimbThrustN1Limit(estimatedTat, midwayAltitudeClimb);

        return {
            predictedN1,
            ...Predictions.altitudeStep(startingAltitude,
                targetAltitude - startingAltitude,
                climbSpeed,
                machClimb,
                predictedN1,
                this.fmgc.getZeroFuelWeight() * ClimbPathBuilder.TONS_TO_POUNDS,
                remainingFuelOnBoard,
                0,
                this.atmosphericConditions.isaDeviation,
                this.fmgc.getTropoPause(),
                false,
                FlapConf.CLEAN,
                this.perfFactor),
        };
    }

    private computeLevelFlightSegmentPrediction(geometry: Geometry, stepSize: Feet, altitude: Feet, speed: Knots, fuelWeight: number): StepResults {
        const machClimb = this.atmosphericConditions.computeMachFromCas(altitude, speed);

        return Predictions.levelFlightStep(
            altitude,
            stepSize,
            speed,
            machClimb,
            this.fmgc.getZeroFuelWeight() * ClimbPathBuilder.TONS_TO_POUNDS,
            fuelWeight,
            0,
            this.atmosphericConditions.isaDeviation,
        );
    }

    private computeTotalFlightPlanDistance(geometry: Geometry): NauticalMiles {
        let totalDistance = 0;

        for (const [i, leg] of geometry.legs.entries()) {
            totalDistance += leg.distance;
        }

        return totalDistance;
    }

    private computeTotalFlightPlanDistanceFromPresentPosition(geometry: Geometry): NauticalMiles {
        let totalDistance = this.flightPlanManager.getDistanceToActiveWaypoint();
        let numberOfLegsToGo = geometry.legs.size;

        for (const [i, leg] of geometry.legs.entries()) {
            // Because of how sequencing works, the first leg (last one in geometry.legs) is behind the aircraft and the second one is the one we're on.
            // The distance of the one we're on is included through the getDistanceToActiveWaypoint() at the beginning.
            if (numberOfLegsToGo-- > 2) {
                totalDistance += leg.distance;
            }
        }

        return totalDistance;
    }

    // I know this is bad performance wise, since we are iterating over the map twice
    private computeDistanceFromOriginToPresentPosition(geometry: Geometry): NauticalMiles {
        return this.computeTotalFlightPlanDistance(geometry) - this.computeTotalFlightPlanDistanceFromPresentPosition(geometry);
    }

    private getClimbThrustN1Limit(tat: number, pressureAltitude: Feet) {
        return EngineModel.tableInterpolation(EngineModel.maxClimbThrustTableLeap, tat, pressureAltitude);
    }

    private addTakeoffRollCheckpoint(checkpoints: VerticalCheckpoint[], remainingFuelOnBoard: number) {
        checkpoints.push({
            reason: VerticalCheckpointReason.Liftoff,
            distanceFromStart: 0.6,
            altitude: this.airfieldElevation,
            remainingFuelOnBoard,
            speed: this.fmgc.getV2Speed() + 10, // I know this is not perfectly accurate
        });
    }

    private findMaxSpeedAtDistanceAlongTrack(geometry: Geometry, distanceAlongTrack: NauticalMiles): Knots {
        let mostRestrictiveSpeedLimit: Knots = Infinity;
        let distanceAlongTrackForStartOfLegWaypoint = this.computeTotalFlightPlanDistance(geometry);

        for (const [i, leg] of geometry.legs.entries()) {
            distanceAlongTrackForStartOfLegWaypoint -= leg.distance;

            if (distanceAlongTrackForStartOfLegWaypoint + leg.distance < distanceAlongTrack) {
                break;
            }

            if (leg.segment !== SegmentType.Origin && leg.segment !== SegmentType.Departure) {
                continue;
            }

            if (leg.speedConstraint?.speed > 100 && (leg.speedConstraint.type === SpeedConstraintType.atOrBelow || leg.speedConstraint.type === SpeedConstraintType.at)) {
                mostRestrictiveSpeedLimit = Math.min(mostRestrictiveSpeedLimit, leg.speedConstraint.speed);
            }
        }

        return mostRestrictiveSpeedLimit;
    }

    private findMaxAltitudeConstraints(geometry: Geometry): MaxAltitudeConstraint[] {
        const result: MaxAltitudeConstraint[] = [];
        let distanceAlongTrackForStartOfLegWaypoint = this.computeTotalFlightPlanDistance(geometry);
        let currentMaxAltitudeConstraint = Infinity;

        for (const [i, leg] of geometry.legs.entries()) {
            distanceAlongTrackForStartOfLegWaypoint -= leg.distance;

            if (leg.segment !== SegmentType.Origin && leg.segment !== SegmentType.Departure) {
                continue;
            }

            if (leg.altitudeConstraint && leg.altitudeConstraint.type !== AltitudeConstraintType.atOrAbove) {
                const constraintMaxAltitude = leg.altitudeConstraint.altitude1;

                // TODO: We shouldn't actually ignore this constraint. Since it is closer to the origin, it should have priority.
                if (constraintMaxAltitude < currentMaxAltitudeConstraint) {
                    result.push({
                        distanceFromStart: distanceAlongTrackForStartOfLegWaypoint + leg.distance,
                        maxAltitude: constraintMaxAltitude,
                    });
                }

                currentMaxAltitudeConstraint = constraintMaxAltitude;
            }
        }

        return result;
    }
}

interface MaxAltitudeConstraint {
    distanceFromStart: NauticalMiles,
    maxAltitude: Feet,
}

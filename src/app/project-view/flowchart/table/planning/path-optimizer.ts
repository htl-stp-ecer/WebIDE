import { MissionStep } from '../../../../entities/MissionStep';
import { Waypoint } from './models';
import { Pose2D, applyLocalDelta, forwardMove, normalizeAngle } from '../models';
import { LineSegmentCm } from '../services';
import { SensorConfig } from '../models';
import {
  closestLineNormalAngle,
  findClosestLineSegment,
  linePerpendicularScore,
  lineupPerpThreshold,
  lineupProximityCm,
} from './line-utils';
import {
  LineupSimulationContext,
  simulateDriveUntilColor,
  simulateForwardLineupOnBlack,
} from '../simulation-path';

// --- Interfaces ---

export interface OptimizationContext {
  lineSegments: LineSegmentCm[];
  sensorConfig: SensorConfig;
  isOnBlackLine: (x: number, y: number) => boolean;
  rotationCenterForwardCm?: number;
  rotationCenterStrafeCm?: number;
  maxLineupDistanceCm?: number;
}

export interface OptimizationOptions {
  /** Lineup angle threshold: 0=permissive, 1=strict (default: 0.5) */
  lineupThreshold?: number;
  /** Use tank turn functions (default: false) */
  useTankTurn?: boolean;
  /** Minimum rotation in degrees to generate turn step (default: 1) */
  minRotateDeg?: number;
}

// --- Main Optimizer Function ---

/**
 * Convert waypoints to optimized mission steps.
 */
export function optimizeWaypointsToSteps(
  waypoints: Waypoint[],
  startPose: Pose2D,
  context: OptimizationContext,
  options?: OptimizationOptions
): MissionStep[] {
  if (waypoints.length < 2) return [];

  const useTankTurn = options?.useTankTurn ?? false;
  const minRotateDeg = options?.minRotateDeg ?? 1;
  const lineupThreshold = options?.lineupThreshold ?? 0.5;
  const lineSegments = context.lineSegments ?? [];
  const lineProximity = lineupProximityCm(lineupThreshold);
  const perpThreshold = lineupPerpThreshold(lineupThreshold);
  const sensorCount = context.sensorConfig?.lineSensors?.length ?? 0;
  const canDriveUntil = sensorCount >= 1;
  const canLineup = sensorCount >= 2;
  const lineupContext = buildLineupContext(context);

  const steps: MissionStep[] = [];
  let currentPose: Pose2D = { ...startPose };

  for (let i = 0; i < waypoints.length - 1; i++) {
    const to = waypoints[i + 1];
    let guard = 0;
    while (guard < 6) {
      guard += 1;
      const dx = to.x - currentPose.x;
      const dy = to.y - currentPose.y;
      const totalDistance = Math.sqrt(dx * dx + dy * dy);

      if (totalDistance < 0.1) break;

      // Calculate required heading
      const targetHeading = Math.atan2(dy, dx);
      const angleDiff = normalizeAngle(targetHeading - currentPose.theta);
      const angleDeg = angleDiff * (180 / Math.PI);

      // Generate turn step if needed
      const roundedAngle = Math.round(angleDeg);
      if (Math.abs(roundedAngle) >= minRotateDeg) {
        steps.push(createTurnStep(roundedAngle, useTankTurn));
        currentPose = {
          ...currentPose,
          theta: normalizeAngle(currentPose.theta + roundedAngle * Math.PI / 180),
        };
      }

      let handledLine = false;
      if (totalDistance > 1 && canDriveUntil && lineupContext) {
        const startOnBlack = isAnySensorOnBlack(currentPose, lineupContext);
        if (!startOnBlack) {
          const segmentContext = buildLineupContext(context, totalDistance);
          if (segmentContext) {
            const drivePoses = simulateDriveUntilColor(currentPose, segmentContext, 'black');
            if (drivePoses.length) {
              const hitPose = drivePoses[drivePoses.length - 1];
              const endOnBlack = isAnySensorOnBlack(hitPose, segmentContext);
              if (endOnBlack) {
                const traveled = Math.hypot(hitPose.x - currentPose.x, hitPose.y - currentPose.y);
                if (traveled + 0.25 < totalDistance) {
                  const lineInfo = findClosestLineSegment(lineSegments, hitPose.x, hitPose.y);
                  const linePerpScore = lineInfo ? linePerpendicularScore(currentPose.theta, lineInfo.angle) : 0;
                  const canAlignToLine = !lineInfo || linePerpScore >= perpThreshold;

                  steps.push(createDriveUntilStep('black'));
                  currentPose = hitPose;
                  handledLine = true;

                  if (canLineup && canAlignToLine) {
                    steps.push(createLineupStep('forward', 'black'));
                    const lineupPoses = simulateForwardLineupOnBlack(currentPose, segmentContext);
                    if (lineupPoses.length) {
                      currentPose = lineupPoses[lineupPoses.length - 1];
                    } else if (lineInfo) {
                      currentPose = { ...currentPose, theta: closestLineNormalAngle(currentPose.theta, lineInfo.angle) };
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (handledLine) {
        continue;
      }

      if (totalDistance > 1) {
        const roundedDistance = Math.round(totalDistance);
        if (roundedDistance > 0) {
          steps.push(createDriveStep(roundedDistance));
          currentPose = forwardMove(currentPose, roundedDistance);
        }
      }

      if (canLineup && lineupContext && isAnySensorOnBlack(currentPose, lineupContext)) {
        const lineInfo = findClosestLineSegment(lineSegments, currentPose.x, currentPose.y);
        const linePerpScore = lineInfo ? linePerpendicularScore(currentPose.theta, lineInfo.angle) : 0;
        if (!lineInfo || linePerpScore >= perpThreshold) {
          steps.push(createLineupStep('forward', 'black'));
          const lineupPoses = simulateForwardLineupOnBlack(currentPose, lineupContext);
          if (lineupPoses.length) {
            currentPose = lineupPoses[lineupPoses.length - 1];
          } else if (lineInfo) {
            currentPose = { ...currentPose, theta: closestLineNormalAngle(currentPose.theta, lineInfo.angle) };
          }
        }
      }

      break;
    }
  }

  return steps;
}

// --- Helper Functions ---

// --- Step Creation Functions ---

function createTurnStep(angleDeg: number, useTank: boolean): MissionStep {
  const isClockwise = angleDeg < 0;
  const functionName = useTank
    ? (isClockwise ? 'tank_turn_cw' : 'tank_turn_ccw')
    : (isClockwise ? 'turn_cw' : 'turn_ccw');

  return {
    step_type: '',
    function_name: functionName,
    arguments: [{ name: 'deg', value: Math.abs(angleDeg), type: 'float' }],
    position: { x: 0, y: 0 },
    children: [],
  };
}

function createDriveStep(distanceCm: number): MissionStep {
  return {
    step_type: '',
    function_name: 'drive_forward',
    arguments: [{ name: 'cm', value: distanceCm, type: 'float' }],
    position: { x: 0, y: 0 },
    children: [],
  };
}

function createDriveUntilStep(color: 'black' | 'white'): MissionStep {
  return {
    step_type: '',
    function_name: color === 'black' ? 'drive_until_black' : 'drive_until_white',
    arguments: [],
    position: { x: 0, y: 0 },
    children: [],
  };
}

function createLineupStep(direction: 'forward' | 'backward', color: 'black' | 'white'): MissionStep {
  let functionName = 'forward_lineup_on_black';
  if (direction === 'forward' && color === 'black') functionName = 'forward_lineup_on_black';
  if (direction === 'forward' && color === 'white') functionName = 'forward_lineup_on_white';
  if (direction === 'backward' && color === 'black') functionName = 'backward_lineup_on_black';
  if (direction === 'backward' && color === 'white') functionName = 'backward_lineup_on_white';

  return {
    step_type: '',
    function_name: functionName,
    arguments: [],
    position: { x: 0, y: 0 },
    children: [],
  };
}

function buildLineupContext(context: OptimizationContext, maxDistanceCm?: number): LineupSimulationContext | null {
  const sensors = context.sensorConfig?.lineSensors ?? [];
  if (sensors.length === 0) return null;

  return {
    isOnBlackLine: context.isOnBlackLine,
    lineSensors: sensors,
    rotationCenterForwardCm: context.rotationCenterForwardCm ?? 0,
    rotationCenterStrafeCm: context.rotationCenterStrafeCm ?? 0,
    maxDistanceCm: maxDistanceCm ?? context.maxLineupDistanceCm,
  };
}

function isAnySensorOnBlack(pose: Pose2D, context: LineupSimulationContext): boolean {
  for (const sensor of context.lineSensors) {
    const forwardFromRc = sensor.forwardCm - context.rotationCenterForwardCm;
    const strafeFromRc = sensor.strafeCm - context.rotationCenterStrafeCm;
    const sensorPose = applyLocalDelta(pose, forwardFromRc, strafeFromRc, 0);
    if (context.isOnBlackLine(sensorPose.x, sensorPose.y)) {
      return true;
    }
  }
  return false;
}
